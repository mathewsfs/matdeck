const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ConfigStore = require('./config');
const WindowDetector = require('./windowDetector');
const HardwareMonitor = require('./hardwareMonitor');
const PresetManager = require('./presetManager');
const AudioMixer = require('./audioMixer');
const SystemActions = require('./actions/systemActions');
const { buildActionCatalog } = require('./actionCatalog');

const OBSProfile = require('./profiles/obs');
const DiscordProfile = require('./profiles/discord');
const TeamSpeakProfile = require('./profiles/teamspeak');
const MeetProfile = require('./profiles/meet');
const NextcloudProfile = require('./profiles/nextcloud');
const SpotifyProfile = require('./profiles/spotify');
const SpotifyMonitor = require('./spotify');
const FanControl = require('./fanControl');
const AiUsage = require('./aiUsage');
const DefaultProfile = require('./profiles/default');
const MoreProfile = require('./profiles/more');

const PluginLoader = require('./elgato/pluginLoader');
const ElgatoBridge = require('./elgato/elgatoBridge');
const TrayIndicator = require('./tray');
const AppLauncher = require('./appLauncher');
const icons = require('./icons.json');

const VERSION = require('../package.json').version;
const HTTP_PORT = parseInt(process.env.PORT, 10) || 8888;
const UDP_BROADCAST_PORT = 8889;
const WS_HEARTBEAT_MS = 25000;
const VIRTUAL_IFACE = /^(docker|podman|cni|br-|veth|virbr|tun|tap|wg|vmnet|lo|zt|tailscale)/i;

const BUILTIN_PROFILE_IDS = ['obs', 'discord', 'teamspeak', 'meet', 'nextcloud', 'spotify', 'default', 'more'];
// Perfis embutidos sem estado próprio: podem ser sobrescritos por um preset salvo com o mesmo id
const OVERRIDABLE_PROFILE_IDS = ['default', 'more'];
const RESERVED_PROFILE_IDS = BUILTIN_PROFILE_IDS.filter(id => !OVERRIDABLE_PROFILE_IDS.includes(id));

class MatDeckServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocketServer({ server: this.server, path: '/deck' });

        this.currentProfileId = 'default';
        this.autoDetectEnabled = true;
        this.clients = new Set();
        this.startedAt = Date.now();

        this.config = new ConfigStore();
        this.hardwareMonitor = new HardwareMonitor(1000);
        this.presetManager = new PresetManager(undefined, RESERVED_PROFILE_IDS);
        this.audioMixer = new AudioMixer();
        this.spotify = new SpotifyMonitor();
        this.fanControl = new FanControl(this.config);
        this.aiUsage = new AiUsage(this.config);

        this.profiles = new Map();
        this.profiles.set('obs', new OBSProfile(this));
        this.profiles.set('discord', new DiscordProfile(this));
        this.profiles.set('teamspeak', new TeamSpeakProfile(this));
        this.profiles.set('meet', new MeetProfile(this));
        this.profiles.set('nextcloud', new NextcloudProfile(this));
        this.profiles.set('spotify', new SpotifyProfile(this));
        this.profiles.set('default', new DefaultProfile(this));
        this.profiles.set('more', new MoreProfile(this));

        const pluginsDir = process.env.MATDECK_DATA_DIR ? path.join(process.env.MATDECK_DATA_DIR, 'plugins') : path.resolve(__dirname, '../../plugins');
        this.pluginLoader = new PluginLoader(pluginsDir);
        this.elgatoBridge = new ElgatoBridge(parseInt(process.env.MATDECK_ELGATO_PORT, 10) || 9876, {
            pluginsDir,
            saveKeySettings: (profileId, keyIndex, settings) => this.savePluginKeySettings(profileId, keyIndex, settings),
            getDeviceSize: () => {
                const def = this.getProfileDefinition(this.currentProfileId);
                return { columns: (def && def.cols) || 5, rows: (def && def.rows) || 3 };
            }
        });
        this.installedPlugins = [];
        this.appLauncher = new AppLauncher();
        this.appLauncher.list().catch(() => {});

        this.windowDetector = new WindowDetector();

        this.init();
    }

    init() {
        this.setupExpress();
        this.setupWebSockets();
        this.setupElgato();
        this.setupWindowDetector();
        this.setupHardwareTelemetry();
        this.setupAudioTelemetry();
        this.setupSpotifyTelemetry();
        this.setupFanTelemetry();
        this.setupAiTelemetry();
        this.setupUdpDiscovery();
        this.setupShutdown();

        this.presetManager.on('change', () => this.broadcastProfileList());

        // Uma promessa rejeitada sem tratamento não pode derrubar o deck inteiro: fica no log
        process.on('unhandledRejection', (reason) => {
            console.error('[MatDeck] Promessa rejeitada sem tratamento:', (reason && reason.stack) || reason);
        });

        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`[MatDeck] Porta ${HTTP_PORT} já está em uso. Feche o outro processo ou use PORT=xxxx.`);
                process.exit(1);
            }
            console.error('[MatDeck] Erro no servidor HTTP:', err.message);
        });

        this.server.listen(HTTP_PORT, '0.0.0.0', () => {
            const ip = this.getLocalIp();
            const caps = this.getCapabilities();
            console.log('====================================================');
            console.log(`   MatDeck Server v${VERSION}`);
            console.log(`   Painel Web & Gerenciador: http://localhost:${HTTP_PORT}`);
            console.log(`   Endereço na Rede Local:   http://${ip}:${HTTP_PORT}`);
            console.log(`   WebSocket para Android:   ws://${ip}:${HTTP_PORT}/deck`);
            console.log(`   Sessão: ${caps.wayland ? 'Wayland' : 'X11'} ${caps.desktop || ''} | teclas: ${caps.ydotool ? 'ydotool' : (caps.xdotool ? 'xdotool' : 'INDISPONÍVEL')} | foco de janela: ${caps.kdotool ? 'kdotool' : (caps.qdbus ? 'KWin script' : (caps.xdotool ? 'xdotool' : 'INDISPONÍVEL'))} | detecção de janela: ${this.windowDetector.describe()}`);
            if (caps.wayland && !caps.ydotool) {
                console.log('   AVISO: ydotool inativo. Rode: sudo systemctl enable --now ydotool');
            }
            console.log('====================================================');
            if (process.env.FLATPAK_ID) console.log(`   Flatpak: ${process.env.FLATPAK_ID} | dados em ${process.env.MATDECK_DATA_DIR || 'server/data'}`);
            this.startTray(ip);
        });
    }

    /** Ícone na bandeja do sistema (scripts/matdeck-tray.py). Desative com ui.tray=false ou MATDECK_TRAY=0. */
    startTray(lanIp) {
        const ui = this.config.get('ui') || {};
        this.tray = new TrayIndicator({ port: HTTP_PORT, lanIp, enabled: ui.tray !== false });
        this.tray.start();
    }

    // ------------------------------------------------------------------
    // Rede
    // ------------------------------------------------------------------

    getLanInterfaces() {
        const result = [];
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            if (VIRTUAL_IFACE.test(name)) continue;
            for (const iface of interfaces[name]) {
                if (iface.family !== 'IPv4' || iface.internal) continue;
                result.push({ name, address: iface.address, netmask: iface.netmask });
            }
        }
        // Preferir faixas de LAN doméstica
        const score = (a) => (a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2);
        return result.sort((a, b) => score(a) - score(b));
    }

    getLocalIp() {
        const lan = this.getLanInterfaces();
        if (lan.length) return lan[0].address;
        for (const list of Object.values(os.networkInterfaces())) {
            for (const iface of list) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
        return '127.0.0.1';
    }

    static broadcastAddress(address, netmask) {
        const a = address.split('.').map(Number);
        const m = netmask.split('.').map(Number);
        return a.map((oct, i) => (oct | (~m[i] & 255))).join('.');
    }

    setupUdpDiscovery() {
        const socket = dgram.createSocket('udp4');
        socket.on('error', (err) => console.error('[Discovery] Erro UDP:', err.message));
        let lastSentAt = 0;
        let warnedSend = false;
        socket.bind(() => {
            socket.setBroadcast(true);
            this.udpTimer = setInterval(() => {
                // Com tablet conectado o anúncio pode ser mais espaçado (10 s); sem ninguém, 2 s
                const interval = this.clients.size ? 10000 : 2000;
                if (Date.now() - lastSentAt < interval - 100) return;
                lastSentAt = Date.now();
                const targets = new Set(['255.255.255.255']);
                for (const iface of this.getLanInterfaces()) {
                    targets.add(MatDeckServer.broadcastAddress(iface.address, iface.netmask));
                }
                const message = Buffer.from(JSON.stringify({
                    type: 'matdeck-server',
                    ip: this.getLocalIp(),
                    port: HTTP_PORT,
                    name: `MatDeck @ ${os.hostname()}`,
                    version: VERSION
                }));
                for (const target of targets) {
                    socket.send(message, 0, message.length, UDP_BROADCAST_PORT, target, (err) => {
                        if (err && !warnedSend) { warnedSend = true; console.warn(`[Discovery] Falha ao anunciar em ${target}: ${err.message} (aviso único)`); }
                    });
                }
            }, 2000);
        });
        this.udpSocket = socket;
    }

    // ------------------------------------------------------------------
    // Capacidades / status
    // ------------------------------------------------------------------

    getCapabilities() {
        try {
            return SystemActions.capabilities() || {};
        } catch (e) {
            console.warn('[MatDeck] Falha ao sondar capacidades do sistema:', e.message);
            return {};
        }
    }

    getIntegrationsStatus() {
        const status = {};
        for (const [id, prof] of this.profiles.entries()) {
            if (typeof prof.getStatus === 'function') {
                try { status[id] = prof.getStatus(); } catch (e) { status[id] = { error: e.message }; }
            }
        }
        return status;
    }

    getHiddenProfiles() {
        const ui = this.config.get('ui') || {};
        return new Set(Array.isArray(ui.hiddenProfiles) ? ui.hiddenProfiles : []);
    }

    isProfileHidden(id) {
        return this.getHiddenProfiles().has(id) || this.isProfileRemoved(id);
    }

    /** Abas embutidas excluídas pelo usuário: somem de tudo, mas a instância continua viva (estado espelhado no hub). */
    getRemovedProfiles() {
        const ui = this.config.get('ui') || {};
        return new Set(Array.isArray(ui.removedProfiles) ? ui.removedProfiles.filter(id => this.profiles.has(id) && id !== 'default') : []);
    }

    isProfileRemoved(id) {
        return this.getRemovedProfiles().has(id);
    }

    setProfileRemoved(id, removedFlag) {
        const set = this.getRemovedProfiles();
        if (removedFlag) set.add(id); else set.delete(id);
        this.config.set('ui', { removedProfiles: Array.from(set) });
        if (removedFlag && this.currentProfileId === id) this.switchProfile('default');
        this.broadcastProfileList();
    }

    listRemovedProfiles() {
        return Array.from(this.getRemovedProfiles()).map((id) => {
            const prof = this.profiles.get(id);
            let name = id;
            try { name = (prof.getDefinition() || {}).name || id; } catch (e) {}
            return { id, name };
        });
    }

    /** Lista de perfis. Por padrão só os visíveis no tablet; includeHidden=true traz todos com a flag `hidden`. */
    getProfileList(includeHidden = false) {
        const hidden = this.getHiddenProfiles();
        const removed = this.getRemovedProfiles();
        const list = [];
        for (const [id, prof] of this.profiles.entries()) {
            if (removed.has(id)) continue;
            const def = this.isOverridden(id) ? this.presetManager.get(id) : prof.getDefinition();
            list.push({ id, name: def.name || id, builtin: true, editable: OVERRIDABLE_PROFILE_IDS.includes(id), overridden: this.isOverridden(id), hidden: hidden.has(id) });
        }
        for (const [id, preset] of Object.entries(this.presetManager.getAll())) {
            if (this.profiles.has(id)) continue; // sobrescrita de embutido já listada acima
            list.push({ id, name: preset.name || id, builtin: false, editable: true, hidden: hidden.has(id) });
        }
        return includeHidden ? list : list.filter(p => !p.hidden);
    }

    setProfileHidden(id, hiddenFlag) {
        const set = this.getHiddenProfiles();
        if (hiddenFlag) set.add(id); else set.delete(id);
        this.config.set('ui', { hiddenProfiles: Array.from(set) });
        this.broadcastProfileList();
    }

    // ------------------------------------------------------------------
    // HTTP API
    // ------------------------------------------------------------------

    setupExpress() {
        this.app.use(express.json({ limit: '10mb' }));

        // Impressão digital dos arquivos do deck/gerenciador: entra na URL dos assets (?v=) e numa meta tag;
        // um deck conectado com outra impressão recebe "reload" (o tablet não precisa limpar cache à mão)
        this.assetBuild = MatDeckServer.computeAssetBuild();
        const webDir = path.join(__dirname, '../web');
        const servePage = (file) => (req, res) => {
            try {
                const html = fs.readFileSync(path.join(webDir, file), 'utf8')
                    .replace(/\?v=[\w.-]+/g, `?v=${this.assetBuild}`)
                    .replace('<meta charset="UTF-8">', `<meta charset="UTF-8">\n    <meta name="matdeck-build" content="${this.assetBuild}">`);
                res.set('Cache-Control', 'no-cache');
                res.type('html').send(html);
            } catch (e) {
                res.sendFile(path.join(webDir, file));
            }
        };
        this.app.get(['/', '/index.html'], servePage('index.html'));
        this.app.get(['/manage', '/manage.html'], servePage('manage.html'));

        // Sem cache "cego" no navegador do tablet: revalida a cada carga (ETag), para pegar app.js/style.css novos
        this.app.use(express.static(webDir, { index: false, etag: true, lastModified: true, maxAge: 0, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
        this.app.get('/api/actions', async (req, res) => {
            let apps = [];
            try { apps = await this.appLauncher.list(); } catch (e) { /* catálogo segue sem apps */ }
            res.json(buildActionCatalog({
                profileList: this.getProfileList(true),
                audioApps: this.audioMixer.getAll(),
                apps,
                plugins: this.installedPlugins
            }));
        });

        // Spotify (MPRIS): estado, capa da faixa e resolução de links de playlist (oEmbed)
        this.app.get('/api/spotify/status', (req, res) => res.json(this.spotify.snapshot()));
        this.app.get('/api/spotify/art/:id', (req, res) => {
            const art = this.spotify.artOf(String(req.params.id || ''));
            if (!art) return res.status(404).end();
            res.set('Content-Type', art.mime);
            res.set('Cache-Control', 'public, max-age=86400, immutable');
            res.send(art.buffer);
        });
        this.app.get('/api/spotify/resolve', async (req, res) => {
            const info = await this.spotify.resolve(req.query.url || req.query.uri || '');
            if (!info) return res.status(400).json({ success: false, error: 'Link do Spotify não reconhecido. Use um link de open.spotify.com ou um URI spotify:...' });
            res.json({ success: true, ...info });
        });

        // Consumo de IA (Claude Code / Codex CLI)
        this.app.get('/api/ai', (req, res) => res.json(this.aiUsage.state()));
        this.app.post('/api/ai/refresh', (req, res) => { this.aiUsage.refreshNow(); res.json({ success: true }); });

        // Ventoinhas (CoolerControl)
        this.app.get('/api/fans', (req, res) => res.json(this.fanControl.state()));
        this.app.post('/api/fans', (req, res) => {
            const { percent } = req.body || {};
            if (typeof percent !== 'number') return res.status(400).json({ success: false, error: 'percent numérico obrigatório' });
            this.fanControl.setAll(percent);
            res.json({ success: true, ...this.fanControl.state() });
        });
        this.app.post('/api/fans/auto', async (req, res) => {
            try {
                const ok = await this.fanControl.setAuto();
                res.json({ success: ok, ...this.fanControl.state() });
            } catch (e) {
                res.status(502).json({ success: false, error: e.message, ...this.fanControl.state() });
            }
        });

        // Aplicativos instalados (.desktop) para teclas "abrir aplicativo"
        this.app.get('/api/apps', async (req, res) => {
            try { res.json({ apps: await this.appLauncher.list(req.query.refresh === '1') }); } catch (e) { res.status(500).json({ error: e.message }); }
        });
        this.app.post('/api/apps/refresh', async (req, res) => {
            try { res.json({ success: true, apps: await this.appLauncher.list(true) }); } catch (e) { res.status(500).json({ error: e.message }); }
        });
        this.app.get('/api/apps/:id/icon', (req, res) => {
            const icon = this.appLauncher.iconOf(req.params.id);
            if (!icon) return res.status(404).end();
            res.set('Content-Type', icon.mime);
            res.set('Cache-Control', 'public, max-age=3600');
            res.send(icon.buffer);
        });
        this.app.get('/api/apps/:id/icon.json', (req, res) => {
            const dataUrl = this.appLauncher.iconDataUrl(req.params.id);
            if (!dataUrl) return res.status(404).json({ error: 'Sem ícone' });
            res.json({ icon: dataUrl });
        });

        this.app.get('/api/hardware', (req, res) => res.json(this.hardwareMonitor.currentStats));
        this.app.get('/api/audio', (req, res) => res.json(this.audioMixer.getAll()));
        this.app.get('/api/icons', (req, res) => res.json(icons));

        // Presets
        this.app.get('/api/presets', (req, res) => res.json(this.presetManager.getAll()));

        this.app.get('/api/presets/:id', (req, res) => {
            const preset = this.presetManager.get(req.params.id);
            if (preset) res.json(preset);
            else res.status(404).json({ error: 'Preset não encontrado' });
        });

        this.app.post('/api/presets/:id', (req, res) => {
            const result = this.presetManager.savePreset(req.params.id, req.body || {});
            if (!result.ok) return res.status(400).json({ success: false, error: result.error });
            if (this.currentProfileId === req.params.id) this.switchProfile(req.params.id);
            res.json({ success: true, preset: result.preset });
        });

        this.app.delete('/api/presets/:id', (req, res) => {
            const id = req.params.id;
            const result = this.presetManager.deletePreset(id);
            if (!result.ok) return res.status(400).json({ success: false, error: result.error });
            // Embutido sobrescrito: excluir = voltar ao layout padrão (o perfil continua existindo)
            const restored = this.profiles.has(id);
            if (this.currentProfileId === id) this.switchProfile(restored ? id : 'default');
            if (restored) this.broadcastProfileList();
            res.json({ success: true, restored });
        });

        this.app.post('/api/presets/:id/apply', (req, res) => {
            if (!this.switchProfile(req.params.id)) {
                return res.status(404).json({ success: false, error: 'Perfil não encontrado' });
            }
            res.json({ success: true, profile: this.currentProfileId });
        });

        // Perfis (embutidos + presets)
        this.app.get('/api/profiles', (req, res) => {
            const result = {};
            const hidden = this.getHiddenProfiles();
            const removed = this.getRemovedProfiles();
            for (const [id, prof] of this.profiles.entries()) {
                if (removed.has(id)) continue;
                const def = this.isOverridden(id) ? this.presetManager.get(id) : prof.getDefinition();
                result[id] = { ...def, builtin: true, editable: OVERRIDABLE_PROFILE_IDS.includes(id), overridden: this.isOverridden(id), hidden: hidden.has(id) };
            }
            for (const [id, preset] of Object.entries(this.presetManager.getAll())) {
                if (!result[id]) result[id] = { ...preset, builtin: false, editable: true, hidden: hidden.has(id) };
            }
            res.json(result);
        });

        // Abas embutidas excluídas (restauráveis)
        this.app.get('/api/profiles/removed', (req, res) => {
            res.json({ profiles: this.listRemovedProfiles() });
        });

        this.app.post('/api/profiles/restore-all', (req, res) => {
            this.config.set('ui', { removedProfiles: [] });
            this.broadcastProfileList();
            res.json({ success: true });
        });

        this.app.post('/api/profiles/:id/restore', (req, res) => {
            const id = req.params.id;
            if (!this.profiles.has(id)) return res.status(404).json({ success: false, error: 'Perfil embutido não encontrado' });
            this.setProfileRemoved(id, false);
            res.json({ success: true, id });
        });

        // Excluir aba embutida: some do tablet e do gerenciador; o layout personalizado (se houver) é descartado
        this.app.delete('/api/profiles/:id', (req, res) => {
            const id = req.params.id;
            if (!this.profiles.has(id)) return res.status(404).json({ success: false, error: 'Perfil embutido não encontrado (perfis seus usam /api/presets)' });
            if (id === 'default') return res.status(400).json({ success: false, error: 'O perfil Principal não pode ser excluído' });
            if (this.isOverridden(id)) this.presetManager.deletePreset(id);
            this.setProfileRemoved(id, true);
            res.json({ success: true, id });
        });

        this.app.get('/api/profiles/list', (req, res) => {
            const all = req.query.all === '1' || req.query.all === 'true';
            res.json({ profiles: this.getProfileList(all), current: this.currentProfileId });
        });

        // Visibilidade do perfil no tablet (abas, ciclo e auto-perfil)
        this.app.post('/api/profiles/:id/visibility', (req, res) => {
            const id = req.params.id;
            if (!this.getProfileDefinition(id)) return res.status(404).json({ success: false, error: 'Perfil não encontrado' });
            const hidden = !!(req.body && req.body.hidden);
            if (hidden && id === 'default') return res.status(400).json({ success: false, error: 'O perfil Principal não pode ser ocultado' });
            this.setProfileHidden(id, hidden);
            res.json({ success: true, id, hidden });
        });

        this.app.post('/api/profile/switch', (req, res) => {
            const { profile } = req.body || {};
            if (!this.switchProfile(profile)) {
                return res.status(404).json({ success: false, error: 'Perfil não encontrado' });
            }
            res.json({ success: true, profile: this.currentProfileId });
        });

        this.app.post('/api/autodetect', (req, res) => {
            const { enabled } = req.body || {};
            this.setAutoDetect(enabled !== undefined ? enabled : !this.autoDetectEnabled);
            res.json({ success: true, enabled: this.autoDetectEnabled });
        });

        // Notificação manual (teste do banner no tablet/painel)
        this.app.post('/api/notify', (req, res) => {
            const n = this.notify(req.body || {});
            if (!n) return res.status(400).json({ success: false, error: 'Informe title ou text' });
            res.json({ success: true, notification: n });
        });

        // Configurações
        this.app.get('/api/config', (req, res) => res.json(this.config.all()));

        this.app.post('/api/config', (req, res) => {
            if (!req.body || typeof req.body !== 'object') {
                return res.status(400).json({ success: false, error: 'Corpo inválido' });
            }
            const updated = this.config.update(req.body);
            res.json({ success: true, config: updated });
        });

        // Plugins do Stream Deck (Elgato)
        this.app.get('/api/plugins', (req, res) => res.json({ plugins: this.elgatoBridge.list(), dir: this.pluginLoader.pluginsDir, node: process.version }));
        this.app.post('/api/plugins/reload', (req, res) => {
            this.reloadPlugins();
            res.json({ success: true, count: this.installedPlugins.length });
        });
        this.app.post('/api/plugins/install', express.raw({ type: () => true, limit: '300mb' }), (req, res) => {
            try {
                if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ success: false, error: 'Envie o arquivo .streamDeckPlugin no corpo da requisição' });
                const meta = this.pluginLoader.installFromBuffer(req.body, decodeURIComponent(req.get('X-File-Name') || 'upload'));
                this.reloadPlugins();
                res.json({ success: true, plugin: { uuid: meta.uuid, name: meta.name, version: meta.version, supported: meta.supported, reason: meta.reason } });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message });
            }
        });
        this.app.post('/api/plugins/install-url', async (req, res) => {
            try {
                const meta = await this.pluginLoader.installFromUrl(req.body && req.body.url);
                this.reloadPlugins();
                res.json({ success: true, plugin: { uuid: meta.uuid, name: meta.name, version: meta.version, supported: meta.supported, reason: meta.reason } });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message });
            }
        });
        this.app.delete('/api/plugins/:uuid', (req, res) => {
            const ok = this.pluginLoader.remove(req.params.uuid);
            if (!ok) return res.status(404).json({ success: false, error: 'Plugin não encontrado' });
            this.reloadPlugins();
            res.json({ success: true });
        });
        this.app.post('/api/plugins/:uuid/restart', (req, res) => {
            if (!this.elgatoBridge.restart(req.params.uuid)) return res.status(404).json({ success: false, error: 'Plugin não encontrado' });
            res.json({ success: true });
        });
        this.app.get('/api/plugins/:uuid/log', (req, res) => {
            const log = this.elgatoBridge.logOf(req.params.uuid);
            if (!log) return res.status(404).json({ error: 'Plugin não encontrado' });
            res.json({ log });
        });
        // Property Inspector de uma tecla: dados para o gerenciador chamar connectElgatoStreamDeckSocket
        this.app.get('/api/plugins/pi', (req, res) => {
            const profileId = String(req.query.profile || '');
            const keyIndex = parseInt(req.query.index, 10);
            if (!profileId || Number.isNaN(keyIndex)) return res.status(400).json({ error: 'profile e index são obrigatórios' });
            this.syncPluginInstances();
            res.json(this.elgatoBridge.preparePropertyInspector(profileId, keyIndex));
        });
        // Arquivos do plugin (páginas do Property Inspector, imagens)
        this.app.get('/elgato/plugins/:uuid/*', (req, res) => {
            const dir = this.pluginLoader.dirOf(req.params.uuid);
            if (!dir) return res.status(404).end();
            const file = path.resolve(dir, req.params[0] || '');
            if (!file.startsWith(path.resolve(dir) + path.sep)) return res.status(403).end();
            res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
        });

        // Encerramento pedido pelo ícone da bandeja (só aceita chamadas da própria máquina)
        this.app.post('/api/shutdown', (req, res) => {
            const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
            if (!['127.0.0.1', '::1', 'localhost'].includes(ip)) return res.status(403).json({ error: 'Só a partir desta máquina' });
            res.json({ success: true });
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);
        });

        this.app.get('/api/status', (req, res) => {
            res.json({
                version: VERSION,
                startedAt: this.startedAt,
                ip: this.getLocalIp(),
                port: HTTP_PORT,
                profile: this.currentProfileId,
                autoDetect: this.autoDetectEnabled,
                clientsConnected: this.clients.size,
                lastDetectedWindow: this.windowDetector.lastDetected,
                hardware: this.hardwareMonitor.currentStats,
                capabilities: this.getCapabilities(),
                integrations: this.getIntegrationsStatus()
            });
        });
    }

    // ------------------------------------------------------------------
    // WebSocket (tablet + painel web)
    // ------------------------------------------------------------------

    setupWebSockets() {
        this.wss.on('connection', (ws, req) => {
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });

            this.clients.add(ws);
            const clientIp = req.socket.remoteAddress;
            console.log(`[WebSocket] Cliente conectado (${clientIp}). Total: ${this.clients.size} | ${(req.headers['user-agent'] || '?').slice(0, 160)}`);

            this.send(ws, { event: 'profileList', profiles: this.getProfileList(), current: this.currentProfileId });
            this.sendProfileToClient(ws, this.currentProfileId);
            this.send(ws, { event: 'hardwareStats', stats: this.hardwareMonitor.currentStats });
            this.send(ws, { event: 'autoDetectStatus', active: this.autoDetectEnabled });

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleClientMessage(ws, data);
                } catch (e) {
                    console.error('[WebSocket] Erro ao interpretar JSON do cliente:', e.message);
                }
            });

            ws.on('error', (err) => console.warn('[WebSocket] Erro no cliente:', err.message));

            ws.on('close', () => {
                this.clients.delete(ws);
                console.log(`[WebSocket] Cliente desconectado. Restantes: ${this.clients.size}`);
            });
        });

        // Heartbeat: detecta tablets que sumiram da rede sem fechar o socket
        this.heartbeatTimer = setInterval(() => {
            for (const ws of this.wss.clients) {
                if (ws.isAlive === false) {
                    console.log('[WebSocket] Cliente sem resposta ao ping. Encerrando conexão.');
                    ws.terminate();
                    continue;
                }
                ws.isAlive = false;
                try { ws.ping(); } catch (e) {}
            }
        }, WS_HEARTBEAT_MS);
    }

    send(ws, obj) {
        if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify(obj)); } catch (e) {}
        }
    }

    broadcast(obj) {
        const msg = JSON.stringify(obj);
        for (const client of this.clients) {
            if (client.readyState === 1) {
                try { client.send(msg); } catch (e) {}
            }
        }
    }

    broadcastProfileList() {
        this.broadcast({ event: 'profileList', profiles: this.getProfileList(), current: this.currentProfileId });
    }

    handleClientMessage(ws, data) {
        if (!data || typeof data !== 'object') return;
        const event = data.event;

        if (event === 'clientHello') {
            console.log(`[Deck] Dispositivo: ${data.device} (${data.version}) [${data.width}x${data.height}]`);
            // Deck web desatualizado (JS/CSS antigos em cache): pede para recarregar a página
            if (data.device === 'Web Client') {
                const stale = (data.version && data.version !== VERSION) || (data.build && data.build !== this.assetBuild);
                if (stale) {
                    console.log(`[Deck] Deck web desatualizado (v${data.version}, build ${data.build || '?'}; servidor v${VERSION}, build ${this.assetBuild}): pedindo recarga`);
                    this.send(ws, { event: 'reload', version: `${VERSION}+${this.assetBuild}` });
                }
            }
        } else if (event === 'switchProfile') {
            if (typeof data.profile === 'string') this.switchProfile(data.profile);
        } else if (event === 'setVolume') {
            if (data.app === 'fans') this.fanControl.setAll(Number(data.value));
            else if (typeof data.app === 'string') this.audioMixer.setVolume(data.app, Number(data.value));
        } else if (event === 'toggleMute') {
            if (data.app === 'fans') this.fanControl.toggleAuto().catch((e) => console.warn('[Fans] Falha ao alternar automático:', e.message));
            else if (typeof data.app === 'string') this.audioMixer.toggleMute(data.app);
        } else if (event === 'action') {
            // Botões internos de um bloco (ex.: controles do Spotify): ação direta, sem tecla
            if (typeof data.actionId === 'string' && /^(spotify|media):/.test(data.actionId)) this.runAction(data.actionId);
        } else if (event === 'keyDown' || event === 'keyUp') {
            const profileId = typeof data.profile === 'string' ? data.profile : this.currentProfileId;
            if (event === 'keyDown') {
                const ip = (ws._socket && ws._socket.remoteAddress) || '?';
                console.log(`[Deck] keyDown ${profileId}#${data.keyIndex} de ${ip}`);
            }
            this.dispatchAction(profileId, Number(data.keyIndex), event);
        }
    }

    // ------------------------------------------------------------------
    // Ações
    // ------------------------------------------------------------------

    /** Executa uma ação pelo id (keyDown + keyUp), independentemente de tecla. */
    runAction(actionId) {
        const prefix = String(actionId).split(':')[0];
        const route = { spotify: 'spotify', media: 'default' }[prefix];
        if (!route || !this.profiles.has(route)) return false;
        console.log(`[Deck] -> ${actionId}`);
        try {
            const prof = this.profiles.get(route);
            const r = prof.handleAction(actionId, 'keyDown');
            if (r && typeof r.catch === 'function') r.catch(e => console.error(`[Deck] Erro em ${actionId}:`, e.message));
            prof.handleAction(actionId, 'keyUp');
        } catch (e) {
            console.error(`[Deck] Erro ao executar ${actionId}:`, e.message);
        }
        return true;
    }

    dispatchAction(profileId, keyIndex, eventType) {
        const profileDef = this.getProfileDefinition(profileId);
        if (!profileDef) {
            console.warn(`[Deck] Perfil desconhecido na ação: ${profileId}`);
            return;
        }
        const key = profileDef.keys && profileDef.keys.find(k => k.index === keyIndex);
        if (!key || !key.actionId) return;

        const actionId = String(key.actionId);
        const prefix = actionId.split(':')[0];
        if (eventType === 'keyDown') console.log(`[Deck] -> ${actionId}`);

        const route = {
            obs: 'obs',
            discord: 'discord',
            ts: 'teamspeak',
            meet: 'meet',
            nc: 'nextcloud',
            spotify: 'spotify',
            media: 'default',
            launch: 'default',
            system: 'default',
            toggle: 'default'
        }[prefix];

        try {
            if (prefix === 'switch') {
                if (eventType === 'keyDown') this.switchProfile(actionId.slice('switch:'.length));
            } else if (prefix === 'vol_slider') {
                if (eventType === 'keyDown') {
                    const app = actionId.split(':')[1];
                    if (app !== 'fans') this.audioMixer.toggleMute(app);   // ventoinhas: o botão AUTO da tecla alterna (toggleMute via WS)
                }
            } else if (prefix === 'vol_step') {
                // vol_step:<app>:<delta>  ex.: vol_step:teamspeak:+5 | vol_step:fans:+10
                if (eventType === 'keyDown') {
                    const [, app, delta] = actionId.split(':');
                    if (app === 'fans') this.fanControl.adjust(delta); else this.audioMixer.adjustVolume(app, delta);
                }
            } else if (prefix === 'fans') {
                // fans:auto | fans:set:<percent>
                if (eventType === 'keyDown') {
                    if (actionId === 'fans:auto') this.fanControl.setAuto().catch((e) => console.warn('[Fans] Falha ao voltar ao automático:', e.message));
                    else if (actionId.startsWith('fans:set:')) this.fanControl.setAll(Number(actionId.slice('fans:set:'.length)));
                }
            } else if (prefix === 'ai') {
                // consumo de IA: toque força atualização
                if (eventType === 'keyDown') this.aiUsage.refreshNow();
            } else if (prefix === 'stats') {
                // teclas informativas: sem ação ao toque
            } else if (prefix === 'plugin') {
                const ok = this.elgatoBridge.sendKeyEvent(profileId, keyIndex, actionId.slice('plugin:'.length), eventType === 'keyDown');
                if (!ok && eventType === 'keyDown') {
                    console.warn(`[Elgato] Plugin da ação ${actionId} não está rodando`);
                    this.notify({ title: 'Plugin indisponível', text: 'O plugin dessa tecla não está rodando. Veja em Plugins no gerenciador.', level: 'warn' });
                }
            } else if (route && this.profiles.has(route)) {
                const result = this.profiles.get(route).handleAction(actionId, eventType);
                if (result && typeof result.catch === 'function') {
                    result.catch(e => console.error(`[Deck] Erro em ${actionId}:`, e.message));
                }
            } else {
                console.warn(`[Deck] Nenhum handler para a ação: ${actionId}`);
            }
        } catch (e) {
            console.error(`[Deck] Erro ao executar ${actionId}:`, e.message);
        }
    }

    // ------------------------------------------------------------------
    // Perfis
    // ------------------------------------------------------------------

    switchProfile(profileId) {
        const def = this.getProfileDefinition(profileId);
        if (!def) {
            console.warn(`[MatDeck] Perfil inexistente: ${profileId}`);
            return false;
        }
        const changed = this.currentProfileId !== profileId;
        if (changed && this.spotifyLastSent) this.spotifyLastSent.clear(); // o cache vale só para a tela atual
        this.currentProfileId = profileId;
        if (changed) console.log(`[MatDeck] Perfil alterado para: ${profileId}`);
        this.elgatoBridge.setVisibleProfile(profileId);
        this.broadcast({ event: 'loadProfile', ...def });
        return true;
    }

    isOverridden(profileId) {
        return OVERRIDABLE_PROFILE_IDS.includes(profileId) && !!this.presetManager.get(profileId);
    }

    getProfileDefinition(profileId) {
        let def = null;
        if (this.isProfileRemoved(profileId)) return null;   // aba excluída pelo usuário
        if (this.profiles.has(profileId)) {
            def = this.isOverridden(profileId)
                ? this.presetManager.get(profileId)              // layout personalizado pelo usuário
                : this.profiles.get(profileId).getDefinition();
        } else {
            def = this.presetManager.get(profileId) || this.getExtraProfile(profileId);
        }
        return def ? this.decorateDefinition(def) : null;
    }

    /**
     * Sub-telas geradas por um perfil embutido (ex.: lista de salas do TeamSpeak, id "ts-channels").
     * Não aparecem na lista de perfis; chega-se nelas por uma ação switch:<id>.
     */
    getExtraProfile(profileId) {
        if (typeof profileId !== 'string') return null;
        for (const prof of this.profiles.values()) {
            if (typeof prof.getExtraProfile !== 'function') continue;
            try {
                const def = prof.getExtraProfile(profileId);
                if (def) return def;
            } catch (e) {
                console.error(`[MatDeck] Erro ao montar sub-tela ${profileId}:`, e.message);
            }
        }
        return null;
    }

    /** Ações cujo título É o conteúdo (deve ser espelhado mesmo quando a tecla do hub tem título próprio). */
    static get TITLE_IS_CONTENT() {
        return new Set(['ts:talking', 'ts:status', 'spotify:now_playing']);
    }

    /** Campos que descrevem o ESTADO visual de uma ação (espelhados entre perfis que usam a mesma ação). */
    static get STATE_FIELDS() {
        return ['title', 'icon', 'badge', 'badgeColor', 'bgColor', 'borderColor', 'titleColor', 'active', 'sliderValue', 'autoMode', 'autoAvailable'];
    }

    /** Estado visual atual de uma ação, lido do perfil embutido dono dela (ex.: ts:mute_mic -> teamspeak). */
    getActionState(actionId) {
        const owner = { obs: 'obs', discord: 'discord', ts: 'teamspeak', meet: 'meet', nc: 'nextcloud', spotify: 'spotify' }[String(actionId).split(':')[0]];
        if (!owner || !this.profiles.has(owner)) return null;
        const def = this.profiles.get(owner).getDefinition();
        const key = def.keys && def.keys.find(k => k.actionId === actionId);
        if (!key) return null;
        const state = {};
        for (const f of MatDeckServer.STATE_FIELDS) if (key[f] !== undefined) state[f] = key[f];
        return state;
    }

    /** Sobrepõe estado vivo (faders e ações de outros perfis) na definição estática do perfil. */
    decorateDefinition(def) {
        if (!def.keys) return def;
        const states = { ...this.audioMixer.getAll(), fans: this.fanSliderState() };
        let touched = false;
        const keys = def.keys.map((key) => {
            if (!key.actionId) return key;
            if (key.actionId.startsWith('plugin:')) {
                const overlay = this.elgatoBridge.overlayFor(def.id, key);
                if (overlay) { touched = true; return { ...key, ...overlay }; }
                return key;
            }
            if (key.actionId.startsWith('ai:')) {
                const st = this.aiUsage.stateFor(key.actionId);
                if (st) { touched = true; return { ...key, ...st }; }
                return key;
            }
            if (key.actionId.startsWith('spotify:')) {
                const st = this.spotifyStateFor(key, def.id);
                if (st) { touched = true; return { ...key, ...st }; }
                return key;
            }
            if (key.actionId.startsWith('stats:')) {
                // Telemetria já com valores atuais (sem esperar o próximo tick)
                const upd = this.statUpdateFor(key.actionId, this.hardwareMonitor.currentStats);
                touched = true;
                return { ...key, ...(upd || { statLabel: key.title || 'CPU', statHead: '', statBig: '--', statMode: 'bar', statPercent: 0 }) };
            }
            if (!key.actionId.startsWith('vol_slider:')) {
                // Tecla que usa ação de outro perfil (hub): copia o estado real do dono
                if (this.profiles.has(def.id) || this.presetManager.get(def.id)) {
                    const ownerId = { obs: 'obs', discord: 'discord', ts: 'teamspeak', meet: 'meet', nc: 'nextcloud', spotify: 'spotify' }[key.actionId.split(':')[0]];
                    if (ownerId && ownerId !== def.id) {
                        const st = this.getActionState(key.actionId);
                        if (st) {
                            touched = true;
                            if (key.title && !MatDeckServer.TITLE_IS_CONTENT.has(key.actionId)) delete st.title;
                            return { ...key, ...st };
                        }
                    }
                }
                return key;
            }
            const app = states[key.actionId.split(':')[1]];
            if (!app) return key;
            touched = true;
            if (app.id === 'fans') {
                return { ...key, isSlider: true, sliderApp: 'fans', sliderValue: app.volume, badge: app.badge, badgeColor: app.badgeColor, autoMode: app.auto, autoAvailable: app.available, active: !app.auto && app.available, bgColor: key.bgColor, borderColor: !app.auto && app.available ? '#F59E0B' : key.borderColor };
            }
            return {
                ...key,
                isSlider: true,
                sliderApp: app.id,
                sliderValue: app.volume,
                badge: `${app.volume}%`,
                active: !!app.muted,
                bgColor: app.muted ? '#DC2626' : key.bgColor,
                borderColor: app.muted ? '#F87171' : key.borderColor
            };
        });
        return touched ? { ...def, keys } : def;
    }

    sendProfileToClient(ws, profileId) {
        const def = this.getProfileDefinition(profileId) || this.getProfileDefinition('default');
        if (def) this.send(ws, { event: 'loadProfile', ...def });
    }

    /**
     * Envia uma notificação para todos os clientes (banner no tablet, toast no painel).
     * @param {{title?:string,text?:string,level?:'info'|'success'|'warn'|'poke',ttlMs?:number}} n
     */
    notify(n) {
        const title = typeof n.title === 'string' ? n.title.slice(0, 80) : '';
        const text = typeof n.text === 'string' ? n.text.slice(0, 240) : '';
        if (!title && !text) return null;
        const levels = ['info', 'success', 'warn', 'poke'];
        const notification = {
            event: 'notify',
            id: `n_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            title,
            text,
            level: levels.includes(n.level) ? n.level : 'info',
            ttlMs: Math.min(30000, Math.max(1500, parseInt(n.ttlMs, 10) || 5000)),
            timestamp: Date.now()
        };
        console.log(`[Notify] (${notification.level}) ${title}${text ? ': ' + text : ''}`);
        this.broadcast(notification);
        return notification;
    }

    updateKey(profileId, keyIndex, updates) {
        if (this.currentProfileId === profileId) {
            this.broadcast({ event: 'updateKey', profile: profileId, keyIndex, key: updates });
            return;
        }
        // Perfil atual é outro (ex.: hub Principal): espelha nas teclas que usam a mesma ação
        if (!this.profiles.has(profileId)) return;
        if (this.currentProfileId.startsWith(profileId + '-') || this.currentProfileId.startsWith('ts-')) {
            // Sub-tela do mesmo dono (ex.: ts-channels): o dono reenvia a tela inteira quando algo muda
            return;
        }
        const ownerDef = this.profiles.get(profileId).getDefinition();
        const ownerKey = ownerDef.keys && ownerDef.keys.find(k => k.index === keyIndex);
        if (!ownerKey || !ownerKey.actionId || ownerKey.actionId.startsWith('plugin:')) return;
        const currentDef = this.getProfileDefinition(this.currentProfileId);
        if (!currentDef || !currentDef.keys) return;
        const mirrored = {};
        for (const f of MatDeckServer.STATE_FIELDS) if (updates[f] !== undefined) mirrored[f] = updates[f];
        if (!Object.keys(mirrored).length) return;
        for (const key of currentDef.keys) {
            if (key.actionId !== ownerKey.actionId) continue;
            const payload = { ...mirrored };
            if (key.title && !MatDeckServer.TITLE_IS_CONTENT.has(key.actionId)) delete payload.title;
            if (Object.keys(payload).length) {
                this.broadcast({ event: 'updateKey', profile: this.currentProfileId, keyIndex: key.index, key: payload });
            }
        }
    }

    // ------------------------------------------------------------------
    // Telemetria
    // ------------------------------------------------------------------

    /** Hash curto de tamanho+mtime dos arquivos em web/ (muda a cada edição dos assets). */
    static computeAssetBuild() {
        const dir = path.join(__dirname, '../web');
        const h = crypto.createHash('md5');
        try {
            for (const f of fs.readdirSync(dir).sort()) {
                const st = fs.statSync(path.join(dir, f));
                if (st.isFile()) h.update(`${f}:${st.size}:${Math.floor(st.mtimeMs)};`);
            }
        } catch (e) { h.update(String(Date.now())); }
        return h.digest('hex').slice(0, 8);
    }

    static fmtTemp(t) {
        return (t === null || t === undefined) ? '--' : `${t}°C`;
    }

    static isHot(t) {
        return typeof t === 'number' && t >= 75;
    }

    setupHardwareTelemetry() {
        this.hardwareMonitor.on('stats', (stats) => {
            this.broadcast({ event: 'hardwareStats', stats });

            const currentDef = this.getProfileDefinition(this.currentProfileId);
            if (!currentDef || !currentDef.keys) return;

            for (const key of currentDef.keys) {
                if (!key.actionId || !key.actionId.startsWith('stats:')) continue;
                const upd = this.statUpdateFor(key.actionId, stats);
                if (upd) this.updateKey(this.currentProfileId, key.index, upd);
            }
        });

        this.hardwareMonitor.start();
    }

    static fmtRate(bps) {
        if (!bps || bps < 1024) return `${Math.round(bps || 0)} B/s`;
        if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(bps < 10 * 1024 ? 1 : 0)} KB/s`;
        return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
    }

    /**
     * Conteúdo de uma tecla de telemetria: rótulo pequeno, valor grande, linha secundária e barra.
     * `title`/`badge` continuam preenchidos para clientes antigos (APK) e para o preview do gerenciador.
     */
    statUpdateFor(actionId, stats) {
        if (!stats || !stats.cpu) return null;
        const { cpu, gpu, ram, net = {}, disk = {}, history = {} } = stats;
        const fmtTemp = MatDeckServer.fmtTemp;
        const fmtRate = MatDeckServer.fmtRate;
        const isHot = MatDeckServer.isHot;
        const BLUE = '#3B82F6', GREEN = '#10B981', PURPLE = '#A855F7', RED = '#EF4444', PINK = '#EC4899', LIME = '#22C55E';
        const na = (label, mode = 'bar') => ({ statLabel: label, statHead: 'n/d', statBig: 'n/d', statSub: 'indisponível', statPercent: 0, statColor: '#6B7280', statMode: mode, statHistory: null, statHistory2: null, statBars: null, statRows: null, title: `${label} n/d`, badge: null, active: false });
        const base = { statHistory: null, statHistory2: null, statBars: null, statRows: null, statSub: null, statPercent: null, badge: null };
        switch (actionId) {
            case 'stats:cpu':
                return { ...base, statLabel: 'CPU', statHead: fmtTemp(cpu.temp), statBig: `${cpu.usage}%`, statMode: 'graph', statHistory: history.cpuUsage, statHistoryMax: 100, statColor: isHot(cpu.temp) ? RED : BLUE, title: `CPU ${cpu.usage}%`, active: cpu.usage > 80 };
            case 'stats:cpu_temp':
                return { ...base, statLabel: 'CPU', statHead: `${cpu.usage}%`, statBig: fmtTemp(cpu.temp), statSub: 'temperatura', statMode: 'graph', statHistory: history.cpuTemp, statHistoryMax: 100, statHistoryMin: 20, statColor: isHot(cpu.temp) ? RED : BLUE, title: 'CPU Temp', active: isHot(cpu.temp) };
            case 'stats:cores':
                return { ...base, statLabel: 'CPU', statHead: `${cpu.usage}%`, statBig: null, statMode: 'cores', statBars: cpu.cores || [], statColor: isHot(cpu.temp) ? RED : BLUE, title: `CPU ${cpu.usage}%` };
            case 'stats:gpu':
                return gpu.available
                    ? { ...base, statLabel: 'GPU', statHead: `${gpu.vramUsedGB} GB`, statBig: `${gpu.usage}%`, statMode: 'graph', statHistory: history.gpuUsage, statHistoryMax: 100, statColor: isHot(gpu.temp) ? RED : GREEN, title: `GPU ${gpu.usage}%`, active: gpu.usage > 80 }
                    : na('GPU', 'graph');
            case 'stats:gpu_temp':
                return gpu.available
                    ? { ...base, statLabel: 'GPU', statHead: `${gpu.usage}%`, statBig: fmtTemp(gpu.temp), statSub: 'temperatura', statMode: 'graph', statHistory: history.gpuTemp, statHistoryMax: 100, statHistoryMin: 20, statColor: isHot(gpu.temp) ? RED : GREEN, title: 'GPU Temp', active: isHot(gpu.temp) }
                    : na('GPU', 'graph');
            case 'stats:vram':
                return gpu.available
                    ? { ...base, statLabel: 'VRAM', statHead: `${gpu.vramPercent}%`, statBig: `${gpu.vramUsedGB} GB`, statSub: `de ${gpu.vramTotalGB} GB`, statPercent: gpu.vramPercent, statMode: 'bar', statColor: GREEN, title: `VRAM ${gpu.vramUsedGB}G` }
                    : na('VRAM');
            case 'stats:ram':
                return { ...base, statLabel: 'RAM', statHead: `${ram.percent}%`, statBig: `${ram.usedGB} GB`, statSub: `de ${ram.totalGB} GB`, statPercent: ram.percent, statMode: 'bar', statColor: ram.percent > 85 ? RED : PURPLE, title: `RAM ${ram.percent}%`, active: ram.percent > 85 };
            case 'stats:ram_free':
                return { ...base, statLabel: 'RAM', statHead: 'livre', statBig: `${ram.freeGB} GB`, statSub: `de ${ram.totalGB} GB`, statPercent: 100 - (ram.percent || 0), statMode: 'bar', statColor: PURPLE, title: 'RAM Livre' };
            case 'stats:net':
                return { ...base, statLabel: 'NET', statHead: '', statBig: null, statMode: 'dual', statRows: [{ k: '↓', v: fmtRate(net.downBps), color: LIME }, { k: '↑', v: fmtRate(net.upBps), color: PINK }], statHistory: history.netDown, statHistory2: history.netUp, statColor: LIME, statColor2: PINK, title: `↓ ${fmtRate(net.downBps)}` };
            case 'stats:disk':
                return { ...base, statLabel: 'DISK', statHead: '', statBig: null, statMode: 'dual', statRows: [{ k: 'R', v: fmtRate(disk.readBps), color: LIME }, { k: 'W', v: fmtRate(disk.writeBps), color: PINK }], statHistory: history.diskRead, statHistory2: history.diskWrite, statColor: LIME, statColor2: PINK, title: `R ${fmtRate(disk.readBps)}` };
            default:
                return null;
        }
    }

    /**
     * Estado visual de uma tecla `spotify:*` para o perfil `profileId`. Campos indefinidos voltam ao
     * valor próprio da tecla (ex.: borda verde só enquanto toca); o título do usuário é preservado fora
     * do perfil Spotify, exceto no bloco "tocando agora", cujo título é o conteúdo.
     */
    spotifyStateFor(key, profileId) {
        const prof = this.profiles.get('spotify');
        const st = prof && prof.stateFor(key.actionId);
        if (!st) return null;
        const out = {};
        for (const f of Object.keys(st)) out[f] = st[f] === undefined ? (key[f] !== undefined ? key[f] : null) : st[f];
        if (profileId !== 'spotify' && key.title && !MatDeckServer.TITLE_IS_CONTENT.has(key.actionId)) delete out.title;
        return out;
    }

    setupSpotifyTelemetry() {
        this.spotifyLastSent = new Map();
        this.spotify.on('change', () => {
            const currentDef = this.getProfileDefinition(this.currentProfileId);
            if (!currentDef || !currentDef.keys) return;
            for (const key of currentDef.keys) {
                if (!key.actionId || !key.actionId.startsWith('spotify:')) continue;
                const st = this.spotifyStateFor(key, currentDef.id);
                if (!st) continue;
                delete st.transportIcons;   // ícones já foram na definição; só o estado muda
                const sig = JSON.stringify(st);
                const cacheKey = `${this.currentProfileId}|${key.index}`;
                if (this.spotifyLastSent.get(cacheKey) === sig) continue;
                this.spotifyLastSent.set(cacheKey, sig);
                this.broadcast({ event: 'updateKey', profile: this.currentProfileId, keyIndex: key.index, key: st });
            }
        });
        this.spotify.start();
    }

    /** Estado do fader de ventoinhas no formato dos apps de volume (para decorateDefinition). */
    fanSliderState() {
        const st = this.fanControl.state();
        const auto = !st.manual;
        return {
            id: 'fans', name: 'Ventoinhas', volume: st.percent, muted: false, auto, available: st.available,
            badge: !st.available ? 'OFF' : `${st.percent}%`,
            badgeColor: !st.available ? '#6B7280' : (auto ? '#4B5563' : '#B45309')
        };
    }

    setupFanTelemetry() {
        this.fanControl.on('change', () => {
            const currentDef = this.getProfileDefinition(this.currentProfileId);
            if (!currentDef || !currentDef.keys) return;
            for (const key of currentDef.keys) {
                if (key.actionId === 'vol_slider:fans') {
                    this.updateKey(this.currentProfileId, key.index, {
                        badge: app.badge, badgeColor: app.badgeColor, sliderValue: app.volume,
                        autoMode: app.auto, autoAvailable: app.available,
                        active: !app.auto && app.available,
                        borderColor: !app.auto && app.available ? '#F59E0B' : (key.borderColor || '#2D303E')
                    });
                } else if (key.actionId === 'fans:auto') {
                    this.updateKey(this.currentProfileId, key.index, { active: app.auto && app.available, badge: app.available ? (app.auto ? 'ON' : 'OFF') : 'n/d', badgeColor: app.auto && app.available ? '#3B82F6' : '#6B7280' });
                }
            }
        });
        this.fanControl.start();
    }

    setupAiTelemetry() {
        this.aiUsage.on('change', () => {
            const currentDef = this.getProfileDefinition(this.currentProfileId);
            if (!currentDef || !currentDef.keys) return;
            for (const key of currentDef.keys) {
                if (!key.actionId || !key.actionId.startsWith('ai:')) continue;
                const st = this.aiUsage.stateFor(key.actionId);
                if (st) this.broadcast({ event: 'updateKey', profile: this.currentProfileId, keyIndex: key.index, key: st });
            }
        });
        this.aiUsage.start();
    }

    setupAudioTelemetry() {
        this.audioMixer.on('volumeChange', ({ appId }) => {
            const currentDef = this.getProfileDefinition(this.currentProfileId);
            if (!currentDef || !currentDef.keys) return;
            for (const key of currentDef.keys) {
                if (key.actionId === `vol_slider:${appId}`) {
                    this.updateKey(this.currentProfileId, key.index, {
                        badge: `${volume}%`,
                        sliderValue: volume,
                        bgColor: muted ? '#DC2626' : (key.bgColor || '#1C1D25'),
                        borderColor: muted ? '#F87171' : (key.borderColor || '#2D303E'),
                        badgeColor: muted ? '#7F1D1D' : '#3B82F6',
                        active: muted
                    });
                }
            }
        });
    }

    // ------------------------------------------------------------------
    // Auto-detecção de janela
    // ------------------------------------------------------------------

    setAutoDetect(enabled) {
        this.autoDetectEnabled = !!enabled;
        this.windowDetector.setEnabled(this.autoDetectEnabled);
        this.broadcast({ event: 'autoDetectStatus', active: this.autoDetectEnabled });
    }

    setupWindowDetector() {
        this.windowDetector.setEnabled(this.autoDetectEnabled);
        this.windowDetector.on('windowChanged', (info) => {
            if (this.autoDetectEnabled && info.profile && info.profile !== this.currentProfileId && !this.isProfileHidden(info.profile)) {
                console.log(`[Auto-Detect] Janela ativa: "${info.title}" -> Alternando para "${info.profile}"`);
                this.switchProfile(info.profile);
            }
        });
        this.windowDetector.start();
    }

    // ------------------------------------------------------------------
    // Elgato (experimental)
    // ------------------------------------------------------------------

    setupElgato() {
        if (process.env.MATDECK_ELGATO === '0') return;
        this.elgatoBridge.start();
        this.elgatoBridge.on('keyUpdate', ({ profileId, keyIndex, patch }) => {
            // O overlay fica guardado na ponte; só a tela ativa precisa do update ao vivo
            if (this.currentProfileId === profileId) this.broadcast({ event: 'updateKey', profile: profileId, keyIndex, key: patch });
        });
        this.elgatoBridge.on('pluginsChanged', () => this.broadcast({ event: 'pluginsChanged' }));
        this.presetManager.on('change', () => this.syncPluginInstances());
        this.reloadPlugins();
    }

    /** Relê a pasta de plugins, (re)lança os compatíveis e sincroniza as teclas. */
    reloadPlugins() {
        this.installedPlugins = this.pluginLoader.scanPlugins();
        this.elgatoBridge.setPlugins(this.installedPlugins);
        this.syncPluginInstances();
        this.elgatoBridge.setVisibleProfile(this.currentProfileId);
    }

    /** Definição "crua" (sem decoração) de qualquer perfil, inclusive presets. */
    getRawDefinition(profileId) {
        if (this.profiles.has(profileId)) {
            return this.isOverridden(profileId) ? this.presetManager.get(profileId) : this.profiles.get(profileId).getDefinition();
        }
        return this.presetManager.get(profileId) || null;
    }

    /** Todas as teclas com ação de plugin, em todos os perfis (menos abas excluídas). */
    collectPluginKeys() {
        const out = [];
        const ids = new Set([...this.profiles.keys(), ...Object.keys(this.presetManager.getAll())]);
        for (const id of ids) {
            if (this.isProfileRemoved(id)) continue;
            const def = this.getRawDefinition(id);
            if (!def || !Array.isArray(def.keys)) continue;
            for (const key of def.keys) {
                if (!key || typeof key.actionId !== 'string' || !key.actionId.startsWith('plugin:')) continue;
                out.push({ profileId: id, keyIndex: key.index, actionUuid: key.actionId.slice('plugin:'.length), settings: key.settings, cols: def.cols, title: key.title });
            }
        }
        return out;
    }

    syncPluginInstances() {
        try { this.elgatoBridge.syncInstances(this.collectPluginKeys()); } catch (e) { console.warn('[Elgato] Falha ao sincronizar teclas de plugin:', e.message); }
    }

    /** O plugin (ou seu Property Inspector) gravou settings da tecla: persiste no preset dono. */
    savePluginKeySettings(profileId, keyIndex, settings) {
        if (RESERVED_PROFILE_IDS.includes(profileId)) return;
        const def = this.getRawDefinition(profileId);
        if (!def || !Array.isArray(def.keys)) return;
        const current = def.keys.find(k => k && k.index === keyIndex);
        if (current && JSON.stringify(current.settings || {}) === JSON.stringify(settings || {})) return; // nada mudou: não grava nem reenvia
        const copy = { ...def, keys: def.keys.map(k => (k && k.index === keyIndex) ? { ...k, settings } : k) };
        this.presetManager.savePreset(profileId, copy);
    }

    // ------------------------------------------------------------------
    // Encerramento
    // ------------------------------------------------------------------

    setupShutdown() {
        const shutdown = async () => {
            if (this.shuttingDown) return;
            this.shuttingDown = true;
            console.log('\n[MatDeck] Encerrando...');
            const trayStopped = this.tray ? this.tray.stop() : Promise.resolve();
            clearInterval(this.heartbeatTimer);
            clearInterval(this.udpTimer);
            this.hardwareMonitor.stop();
            this.audioMixer.stop();
            this.spotify.stop();
            this.fanControl.stop();
            this.aiUsage.stop();
            this.windowDetector.stop();
            for (const p of this.profiles.values()) { if (typeof p.stop === 'function') { try { p.stop(); } catch (e) {} } }
            for (const ws of this.clients) { try { ws.close(); } catch (e) {} }
            try { this.udpSocket && this.udpSocket.close(); } catch (e) {}
            // Plugins Elgato: espera saírem (SIGKILL após 1 s) para não ficarem órfãos
            try { await Promise.all([this.elgatoBridge.stop(), trayStopped]); } catch (e) {}
            this.server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 1500).unref();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }
}

new MatDeckServer();
