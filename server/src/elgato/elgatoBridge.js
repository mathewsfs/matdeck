const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const DEVICE_ID = 'matdeck-tablet';
const MAX_RESTARTS = 3;
const STABLE_MS = 60 * 1000;      // plugin vivo há mais que isso zera o contador de reinícios
const SAVE_DEBOUNCE_MS = 500;     // plugins gravam settings a cada tick; junta as escritas
const LOG_LINES = 200;

/**
 * Ponte com plugins do Stream Deck: implementa o lado "aplicativo Stream Deck" do protocolo
 * WebSocket da Elgato (SDK v2/v3) para plugins Node.js e seus Property Inspectors.
 *
 *  - Lança cada plugin compatível (`node bin/plugin.js -port -pluginUUID -registerEvent -info`).
 *  - Cada tecla com ação `plugin:<actionUUID>` vira uma "instância" com contexto estável
 *    (perfil + índice), que recebe willAppear/willDisappear conforme a tela ativa no tablet,
 *    keyDown/keyUp e didReceiveSettings; o que o plugin desenha (setTitle/setImage/setState)
 *    vira um "overlay" aplicado à tecla.
 *  - Settings por tecla são persistidos pelo dono (index.js) via deps.saveKeySettings.
 *  - Global settings por plugin ficam em <plugins>/global-settings.json.
 *
 * Eventos emitidos: 'keyUpdate' {profileId, keyIndex, patch}, 'pluginsChanged'.
 */
class ElgatoBridge extends EventEmitter {
    /**
     * @param {number} port
     * @param {object} deps { pluginsDir, saveKeySettings(profileId, keyIndex, settings), getDeviceSize() -> {columns, rows} }
     */
    constructor(port = 9876, deps = {}) {
        super();
        this.port = port;
        this.deps = deps;
        this.wss = null;
        this.plugins = new Map();     // pluginUuid -> { meta, ws, process, restarts, log: [], status }
        this.actionOwner = new Map(); // actionUuid -> pluginUuid
        this.actionMeta = new Map();  // actionUuid -> action (manifesto)
        this.instances = new Map();   // context -> instance
        this.piSessions = new Map();  // piUuid -> { context, ws }
        this.visibleProfile = null;
        this.listening = false;       // só lança plugins com o WebSocket aberto (porta livre)
        this.globalSaveTimer = null;
        this.globalSettings = this.loadGlobalSettings();
    }

    // ------------------------------------------------------------------
    // Servidor WebSocket
    // ------------------------------------------------------------------

    start() {
        if (this.wss) return;
        try {
            this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
        } catch (e) {
            console.error('[Elgato] Falha ao abrir WebSocket dos plugins:', e.message);
            return;
        }
        this.wss.on('error', (err) => {
            // EADDRINUSE chega aqui (não no try/catch): sem servidor, nenhum plugin é lançado
            console.error(`[Elgato] WebSocket dos plugins indisponível (${err.code || err.message}); plugins Elgato desativados até reiniciar. ` +
                (err.code === 'EADDRINUSE' ? `Outro processo usa a porta ${this.port} (um MatDeck antigo ainda aberto?).` : ''));
            this.listening = false;
            try { this.wss && this.wss.close(); } catch (e) { /* já fechado */ }
            this.wss = null;
            for (const [, p] of this.plugins) if (p.meta.supported && !p.process) p.status = 'stopped';
            this.emit('pluginsChanged');
        });
        this.wss.on('listening', () => {
            console.log(`[Elgato] Protocolo Stream Deck ouvindo em ws://127.0.0.1:${this.port}`);
            this.listening = true;
            for (const [, p] of this.plugins) if (p.meta.supported && !p.process && p.status !== 'failed') this.launch(p);
        });

        this.wss.on('connection', (ws) => {
            let role = null;   // 'plugin' | 'pi'
            let uuid = null;
            ws.on('message', (raw) => {
                let msg;
                try { msg = JSON.parse(raw); } catch (e) { return; }
                if (!msg || typeof msg !== 'object') return;
                if (!role) {
                    if (msg.event === 'registerPlugin' && this.plugins.has(msg.uuid)) {
                        role = 'plugin'; uuid = msg.uuid;
                        this.onPluginRegistered(uuid, ws);
                    } else if (msg.event === 'registerPropertyInspector' && this.piSessions.has(msg.uuid)) {
                        role = 'pi'; uuid = msg.uuid;
                        this.onPiRegistered(uuid, ws);
                    } else {
                        console.warn(`[Elgato] Registro desconhecido: ${msg.event} ${msg.uuid}`);
                        try { ws.close(); } catch (e) {}
                    }
                    return;
                }
                if (role === 'plugin') this.onPluginMessage(uuid, msg);
                else this.onPiMessage(uuid, msg);
            });
            ws.on('close', () => {
                if (role === 'plugin') this.onPluginClosed(uuid, ws);
                else if (role === 'pi') this.onPiClosed(uuid);
            });
            ws.on('error', () => {});
        });
    }

    /** Encerra plugins e servidor; resolve quando os processos saíram (ou após ~1,5 s). */
    stop() {
        const waits = [];
        for (const [, p] of this.plugins) waits.push(this.killProcess(p));
        if (this.globalSaveTimer) { clearTimeout(this.globalSaveTimer); this.globalSaveTimer = null; this.writeGlobalSettings(); }
        try { this.wss && this.wss.close(); } catch (e) {}
        this.wss = null;
        this.listening = false;
        return Promise.all(waits);
    }

    // ------------------------------------------------------------------
    // Plugins: ciclo de vida
    // ------------------------------------------------------------------

    /** Atualiza a lista de plugins instalados: lança os novos compatíveis e derruba os removidos. */
    setPlugins(metas) {
        const seen = new Set();
        this.actionOwner.clear();
        this.actionMeta.clear();
        for (const meta of metas) {
            seen.add(meta.uuid);
            for (const a of meta.actions) { this.actionOwner.set(a.uuid, meta.uuid); this.actionMeta.set(a.uuid, a); }
            const existing = this.plugins.get(meta.uuid);
            if (existing) {
                existing.meta = meta;
                if (meta.supported && !existing.process && existing.status !== 'failed') this.launch(existing);
                continue;
            }
            const entry = { meta, ws: null, process: null, restarts: 0, log: [], status: meta.supported ? 'stopped' : 'unsupported' };
            this.plugins.set(meta.uuid, entry);
            if (meta.supported) this.launch(entry);
        }
        for (const [uuid, p] of this.plugins) {
            if (seen.has(uuid)) continue;
            this.killProcess(p);
            this.plugins.delete(uuid);
        }
        this.emit('pluginsChanged');
    }

    restart(uuid) {
        const p = this.plugins.get(uuid);
        if (!p) return false;
        p.restarts = 0;
        this.killProcess(p);
        if (p.meta.supported) this.launch(p);
        return true;
    }

    launch(p) {
        const meta = p.meta;
        if (p.restartTimer) { clearTimeout(p.restartTimer); p.restartTimer = null; }
        p.stopping = false;
        if (!this.listening) {
            // Sem WebSocket (porta ocupada ou MATDECK_ELGATO=0) o plugin não teria a quem se conectar
            p.status = 'stopped';
            this.pushLog(p, '[matdeck] servidor de plugins indisponível; não lançado');
            return;
        }
        const codePath = path.resolve(meta.path, meta.codePath);
        const info = this.buildInfo(meta);
        const args = [
            '--enable-source-maps', '--no-global-search-paths',
            codePath,
            '-port', String(this.port),
            '-pluginUUID', meta.uuid,
            '-registerEvent', 'registerPlugin',
            '-info', JSON.stringify(info)
        ];
        try {
            const child = spawn(process.execPath, args, { cwd: meta.path, env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
            p.process = child;
            p.status = 'starting';
            p.startedAt = Date.now();
            this.pushLog(p, `[matdeck] iniciando ${meta.name} v${meta.version} (node ${process.version})`);
            const onData = (d) => { for (const line of String(d).split('\n')) if (line.trim()) this.pushLog(p, line); };
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);
            child.on('exit', (code, signal) => {
                if (p.process !== child) return;
                p.process = null;
                p.ws = null;
                const uptime = Date.now() - (p.startedAt || Date.now());
                this.pushLog(p, `[matdeck] processo encerrou (code=${code} signal=${signal || '-'})`);
                if (p.stopping) { p.status = 'stopped'; p.stopping = false; this.emit('pluginsChanged'); return; }
                // Reinício com limite: plugins que caem logo na partida não ficam em loop. O contador só
                // zera depois de um período estável (zerar no registro deixava um plugin que registra e
                // cai reiniciar para sempre).
                if (uptime > STABLE_MS) p.restarts = 0;
                if (p.restarts < MAX_RESTARTS) {
                    p.restarts += 1;
                    p.status = 'restarting';
                    const delay = uptime > 30000 ? 1000 : 2000 * p.restarts;
                    p.restartTimer = setTimeout(() => { p.restartTimer = null; if (this.plugins.get(meta.uuid) === p && !p.process) this.launch(p); }, delay);
                } else {
                    p.status = 'failed';
                    console.warn(`[Elgato] Plugin ${meta.name} falhou ${MAX_RESTARTS} vezes; desistindo. Veja o log no gerenciador.`);
                }
                this.emit('pluginsChanged');
            });
            child.on('error', (err) => { this.pushLog(p, `[matdeck] erro ao iniciar: ${err.message}`); p.status = 'failed'; p.process = null; this.emit('pluginsChanged'); });
            console.log(`[Elgato] Lançando plugin ${meta.name} (${meta.uuid})`);
        } catch (e) {
            p.status = 'failed';
            this.pushLog(p, `[matdeck] erro ao lançar: ${e.message}`);
        }
    }

    /** SIGTERM, SIGKILL após 1 s; resolve quando o processo sair (ou em ~1,5 s, para não travar o encerramento). */
    killProcess(p) {
        if (p.restartTimer) { clearTimeout(p.restartTimer); p.restartTimer = null; }
        if (!p.process) return Promise.resolve();
        p.stopping = true;
        const child = p.process;
        return new Promise((resolve) => {
            let killTimer = null;
            const done = () => { if (killTimer) clearTimeout(killTimer); resolve(); };
            child.once('exit', done);
            try { child.kill('SIGTERM'); } catch (e) { done(); return; }
            killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 1000);
            setTimeout(done, 1500).unref();
        });
    }

    pushLog(p, line) {
        p.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`.slice(0, 500));
        if (p.log.length > LOG_LINES) p.log.splice(0, p.log.length - LOG_LINES);
    }

    /** openUrl de plugin ou Property Inspector: só http(s), pela camada de plataforma (deps.openUrl). */
    openUrl(url) {
        if (!url || !/^https?:\/\//i.test(url)) return;
        if (typeof this.deps.openUrl !== 'function') {
            if (!this.warnedNoOpenUrl) { this.warnedNoOpenUrl = true; console.warn('[Elgato] openUrl ignorado: nenhuma função openUrl configurada'); }
            return;
        }
        try { this.deps.openUrl(url); } catch (e) { console.warn('[Elgato] openUrl falhou:', e.message); }
    }

    buildInfo(meta) {
        const size = (this.deps.getDeviceSize && this.deps.getDeviceSize()) || { columns: 5, rows: 3 };
        return {
            application: { font: 'Inter', language: 'pt', platform: this.deps.platformName || 'linux', platformVersion: process.release ? process.version : '', version: '6.9.0' },
            colors: {
                buttonMouseOverBackgroundColor: '#464646FF', buttonPressedBackgroundColor: '#303030FF',
                buttonPressedBorderColor: '#646464FF', buttonPressedTextColor: '#969696FF', highlightColor: '#0078FFFF'
            },
            devicePixelRatio: 2,
            devices: [{ id: DEVICE_ID, name: 'MatDeck', size, type: 0 }],
            plugin: { uuid: meta.uuid, version: meta.version }
        };
    }

    /** Lista para o gerenciador: meta + estado de execução. */
    list() {
        return Array.from(this.plugins.values()).map(p => ({
            uuid: p.meta.uuid, name: p.meta.name, version: p.meta.version, author: p.meta.author, category: p.meta.category,
            description: p.meta.description, icon: p.meta.icon, runtime: p.meta.runtime, supported: p.meta.supported, reason: p.meta.reason,
            status: p.ws ? 'running' : p.status, restarts: p.restarts, os: p.meta.os,
            actions: p.meta.actions.map(a => ({ uuid: a.uuid, name: a.name, tooltip: a.tooltip, icon: a.icon, states: a.states.length, hasPI: !!a.propertyInspectorPath }))
        }));
    }

    logOf(uuid) {
        const p = this.plugins.get(uuid);
        return p ? p.log.slice() : null;
    }

    // ------------------------------------------------------------------
    // Plugins: mensagens
    // ------------------------------------------------------------------

    onPluginRegistered(uuid, ws) {
        const p = this.plugins.get(uuid);
        p.ws = ws;
        p.status = 'running';
        console.log(`[Elgato] Plugin registrado: ${p.meta.name}`);
        this.send(ws, { event: 'deviceDidConnect', device: DEVICE_ID, deviceInfo: { name: 'MatDeck', size: this.buildInfo(p.meta).devices[0].size, type: 0 } });
        // Teclas desse plugin visíveis agora no tablet
        for (const inst of this.instances.values()) {
            if (inst.pluginUuid === uuid && inst.profileId === this.visibleProfile && !inst.visible) this.appear(inst);
        }
        this.emit('pluginsChanged');
    }

    onPluginClosed(uuid, ws) {
        const p = this.plugins.get(uuid);
        if (p && p.ws === ws) { p.ws = null; if (p.status === 'running') p.status = p.process ? 'starting' : 'stopped'; }
        for (const inst of this.instances.values()) if (inst.pluginUuid === uuid) inst.visible = false;
        this.emit('pluginsChanged');
    }

    onPluginMessage(uuid, msg) {
        const inst = msg.context ? this.instances.get(msg.context) : null;
        const payload = msg.payload || {};
        switch (msg.event) {
            case 'setTitle':
                if (!inst) return;
                this.setOverlay(inst, 'titles', payload.state, typeof payload.title === 'string' ? payload.title : null);
                break;
            case 'setImage':
                if (!inst) return;
                this.setOverlay(inst, 'images', payload.state, payload.image ? this.normalizeImage(payload.image) : null);
                break;
            case 'setState':
                if (!inst) return;
                inst.state = Number(payload.state) || 0;
                this.pushKeyUpdate(inst);
                break;
            case 'showOk':
            case 'showAlert':
                if (inst) this.flash(inst, msg.event === 'showOk');
                break;
            case 'setSettings':
                if (!inst) return;
                inst.settings = (payload && typeof payload === 'object') ? payload : {};
                this.persistSettings(inst);
                this.sendToPi(inst.context, this.settingsEvent(inst));
                break;
            case 'getSettings':
                if (inst) this.send(this.pluginWs(uuid), this.settingsEvent(inst));
                break;
            case 'setGlobalSettings':
                this.globalSettings[uuid] = (payload && typeof payload === 'object') ? payload : {};
                this.saveGlobalSettings();
                for (const [piUuid, s] of this.piSessions) if (s.ws && this.instances.get(s.context) && this.instances.get(s.context).pluginUuid === uuid) this.send(s.ws, { event: 'didReceiveGlobalSettings', payload: { settings: this.globalSettings[uuid] } });
                break;
            case 'getGlobalSettings':
                this.send(this.pluginWs(uuid), { event: 'didReceiveGlobalSettings', payload: { settings: this.globalSettings[uuid] || {} } });
                break;
            case 'openUrl':
                this.openUrl(payload.url);
                break;
            case 'logMessage': {
                const p = this.plugins.get(uuid);
                if (p) this.pushLog(p, `[log] ${payload.message}`);
                break;
            }
            case 'sendToPropertyInspector':
                if (inst) this.sendToPi(inst.context, { event: 'sendToPropertyInspector', action: inst.actionUuid, context: inst.context, payload: msg.payload });
                break;
            case 'switchToProfile':
                // Perfis do Stream Deck não existem aqui; ignorado de propósito
                break;
            case 'setFeedback': case 'setFeedbackLayout': case 'setTriggerDescription': case 'setResources': case 'getResources':
                // Encoders/Stream Deck+ : sem equivalente no tablet
                break;
            default:
                break;
        }
    }

    pluginWs(uuid) {
        const p = this.plugins.get(uuid);
        return p ? p.ws : null;
    }

    // ------------------------------------------------------------------
    // Instâncias (teclas com ação de plugin)
    // ------------------------------------------------------------------

    static contextFor(profileId, keyIndex) {
        return Buffer.from(`${profileId}|${keyIndex}`, 'utf8').toString('base64url');
    }

    /**
     * Sincroniza as instâncias com as teclas atuais.
     * @param {Array<{profileId, keyIndex, actionUuid, settings, cols, title}>} keys  todas as teclas `plugin:` de todos os perfis
     */
    syncInstances(keys) {
        const wanted = new Map();
        for (const k of keys) wanted.set(ElgatoBridge.contextFor(k.profileId, k.keyIndex), k);

        for (const [context, inst] of this.instances) {
            const k = wanted.get(context);
            if (!k || k.actionUuid !== inst.actionUuid) {
                if (inst.visible) this.disappear(inst);
                this.instances.delete(context);
            }
        }
        for (const [context, k] of wanted) {
            let inst = this.instances.get(context);
            if (!inst) {
                inst = {
                    context, profileId: k.profileId, keyIndex: k.keyIndex, actionUuid: k.actionUuid,
                    pluginUuid: this.actionOwner.get(k.actionUuid) || null,
                    settings: (k.settings && typeof k.settings === 'object') ? k.settings : {},
                    state: 0, titles: {}, images: {}, visible: false, cols: k.cols || 5, userTitle: k.title || ''
                };
                this.instances.set(context, inst);
            } else {
                inst.pluginUuid = this.actionOwner.get(k.actionUuid) || inst.pluginUuid;
                inst.cols = k.cols || inst.cols;
                inst.userTitle = k.title || '';
                if (k.settings && typeof k.settings === 'object' && !inst.visible) inst.settings = k.settings;
            }
            if (inst.profileId === this.visibleProfile && !inst.visible) this.appear(inst);
        }
    }

    /** Tela ativa mudou no tablet: willDisappear nas antigas, willAppear nas novas. */
    setVisibleProfile(profileId) {
        if (this.visibleProfile === profileId) return;
        for (const inst of this.instances.values()) if (inst.visible && inst.profileId !== profileId) this.disappear(inst);
        this.visibleProfile = profileId;
        for (const inst of this.instances.values()) if (inst.profileId === profileId && !inst.visible) this.appear(inst);
    }

    appear(inst) {
        const ws = this.pluginWs(inst.pluginUuid);
        if (!ws) return;
        inst.visible = true;
        this.send(ws, { event: 'willAppear', action: inst.actionUuid, context: inst.context, device: DEVICE_ID, payload: this.actionPayload(inst) });
        this.send(ws, {
            event: 'titleParametersDidChange', action: inst.actionUuid, context: inst.context, device: DEVICE_ID,
            payload: {
                ...this.actionPayload(inst), title: inst.userTitle || '',
                titleParameters: { fontFamily: '', fontSize: 10, fontStyle: '', fontUnderline: false, showTitle: true, titleAlignment: 'bottom', titleColor: '#ffffff' }
            }
        });
    }

    disappear(inst) {
        inst.visible = false;
        const ws = this.pluginWs(inst.pluginUuid);
        if (ws) this.send(ws, { event: 'willDisappear', action: inst.actionUuid, context: inst.context, device: DEVICE_ID, payload: this.actionPayload(inst) });
    }

    actionPayload(inst, extra = {}) {
        return {
            settings: inst.settings || {},
            coordinates: { column: inst.keyIndex % inst.cols, row: Math.floor(inst.keyIndex / inst.cols) },
            controller: 'Keypad',
            state: inst.state,
            isInMultiAction: false,
            ...extra
        };
    }

    settingsEvent(inst) {
        return { event: 'didReceiveSettings', action: inst.actionUuid, context: inst.context, device: DEVICE_ID, payload: this.actionPayload(inst) };
    }

    /** Toque na tecla do tablet. Retorna false se o plugin não está rodando. */
    sendKeyEvent(profileId, keyIndex, actionUuid, isDown) {
        const context = ElgatoBridge.contextFor(profileId, keyIndex);
        const inst = this.instances.get(context);
        if (!inst || inst.actionUuid !== actionUuid) return false;
        const ws = this.pluginWs(inst.pluginUuid);
        if (!ws) return false;
        if (!inst.visible) this.appear(inst);
        const action = this.actionMeta.get(actionUuid);
        const multiState = action && action.states.length > 1 && !action.disableAutomaticStates;
        this.send(ws, {
            event: isDown ? 'keyDown' : 'keyUp', action: actionUuid, context, device: DEVICE_ID,
            payload: this.actionPayload(inst, multiState ? { userDesiredState: isDown ? inst.state : (inst.state + 1) % action.states.length } : {})
        });
        // Como no Stream Deck: ações com vários estados alternam sozinhas ao soltar
        if (!isDown && multiState) {
            inst.state = (inst.state + 1) % action.states.length;
            this.pushKeyUpdate(inst);
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Overlay (o que o plugin desenha na tecla)
    // ------------------------------------------------------------------

    setOverlay(inst, field, state, value) {
        const targetStates = (state === undefined || state === null) ? Object.keys(inst[field]).concat(['*']) : [String(state)];
        if (state === undefined || state === null) {
            inst[field] = {};
            if (value !== null && value !== '') inst[field]['*'] = value;
        } else {
            for (const s of targetStates) {
                if (value === null || value === '') delete inst[field][s]; else inst[field][s] = value;
            }
        }
        this.pushKeyUpdate(inst);
    }

    normalizeImage(image) {
        const s = String(image);
        if (s.startsWith('data:')) return s;
        if (/^\s*<svg/i.test(s)) return `data:image/svg+xml;charset=utf8,${encodeURIComponent(s)}`;
        // base64 cru: assume PNG
        return `data:image/png;base64,${s}`;
    }

    /** Campos a aplicar sobre a definição da tecla (título/imagem do estado atual, com overrides do plugin). */
    overlayFor(profileId, key) {
        const context = ElgatoBridge.contextFor(profileId, key.index);
        const inst = this.instances.get(context);
        const action = this.actionMeta.get(String(key.actionId || '').slice('plugin:'.length));
        if (!action) return null;
        const state = inst ? inst.state : 0;
        const st = action.states[state] || action.states[0] || {};
        const patch = { imageFill: true };
        const img = inst && (inst.images[String(state)] || inst.images['*']);
        patch.icon = img || st.image || key.icon || null;
        const title = inst && (inst.titles[String(state)] !== undefined ? inst.titles[String(state)] : inst.titles['*']);
        if (title !== undefined && title !== null) patch.title = title;
        else if (key.title) patch.title = key.title;
        else patch.title = st.title || '';
        if (inst && inst.flashBadge) { patch.badge = inst.flashBadge.text; patch.badgeColor = inst.flashBadge.color; }
        return patch;
    }

    pushKeyUpdate(inst) {
        const action = this.actionMeta.get(inst.actionUuid);
        if (!action) return;
        const key = { index: inst.keyIndex, actionId: `plugin:${inst.actionUuid}`, title: inst.userTitle };
        const patch = this.overlayFor(inst.profileId, key);
        if (!patch) return;
        if (!inst.flashBadge) { patch.badge = ''; }
        this.emit('keyUpdate', { profileId: inst.profileId, keyIndex: inst.keyIndex, patch });
    }

    flash(inst, ok) {
        inst.flashBadge = ok ? { text: 'OK', color: '#16A34A' } : { text: '!', color: '#DC2626' };
        this.pushKeyUpdate(inst);
        clearTimeout(inst.flashTimer);
        inst.flashTimer = setTimeout(() => { inst.flashBadge = null; this.pushKeyUpdate(inst); }, 1500);
    }

    persistSettings(inst) {
        if (typeof this.deps.saveKeySettings !== 'function') return;
        if (inst.saveTimer) clearTimeout(inst.saveTimer);
        inst.saveTimer = setTimeout(() => {
            inst.saveTimer = null;
            try { this.deps.saveKeySettings(inst.profileId, inst.keyIndex, inst.settings); } catch (e) { console.warn('[Elgato] Falha ao gravar settings da tecla:', e.message); }
        }, SAVE_DEBOUNCE_MS);
    }

    // ------------------------------------------------------------------
    // Property Inspector
    // ------------------------------------------------------------------

    /** Prepara uma sessão de PI para a tecla; o gerenciador carrega a página e chama connectElgatoStreamDeckSocket. */
    preparePropertyInspector(profileId, keyIndex) {
        const context = ElgatoBridge.contextFor(profileId, keyIndex);
        const inst = this.instances.get(context);
        if (!inst) return { error: 'Tecla sem instância de plugin (salve o perfil primeiro)' };
        const action = this.actionMeta.get(inst.actionUuid);
        const p = this.plugins.get(inst.pluginUuid);
        if (!action || !p) return { error: 'Plugin da ação não está instalado' };
        if (!action.propertyInspectorPath) return { error: 'Esta ação não tem Property Inspector', none: true };
        const piUuid = `pi-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        // Fecha sessões antigas da mesma tecla
        for (const [id, s] of this.piSessions) if (s.context === context) { try { s.ws && s.ws.close(); } catch (e) {} this.piSessions.delete(id); }
        this.piSessions.set(piUuid, { context, ws: null, createdAt: Date.now() });
        const rel = String(action.propertyInspectorPath).replace(/^\/+/, '');
        return {
            port: this.port,
            uuid: piUuid,
            registerEvent: 'registerPropertyInspector',
            info: this.buildInfo(p.meta),
            actionInfo: { action: inst.actionUuid, context, device: DEVICE_ID, payload: this.actionPayload(inst) },
            url: `/elgato/plugins/${encodeURIComponent(p.meta.uuid)}/${rel}`,
            pluginName: p.meta.name,
            running: !!p.ws
        };
    }

    onPiRegistered(piUuid, ws) {
        const s = this.piSessions.get(piUuid);
        s.ws = ws;
        const inst = this.instances.get(s.context);
        if (inst) {
            const pws = this.pluginWs(inst.pluginUuid);
            if (pws) this.send(pws, { event: 'propertyInspectorDidAppear', action: inst.actionUuid, context: inst.context, device: DEVICE_ID });
        }
    }

    onPiClosed(piUuid) {
        const s = this.piSessions.get(piUuid);
        if (!s) return;
        this.piSessions.delete(piUuid);
        const inst = this.instances.get(s.context);
        if (inst) {
            const pws = this.pluginWs(inst.pluginUuid);
            if (pws) this.send(pws, { event: 'propertyInspectorDidDisappear', action: inst.actionUuid, context: inst.context, device: DEVICE_ID });
        }
    }

    onPiMessage(piUuid, msg) {
        const s = this.piSessions.get(piUuid);
        if (!s) return;
        const inst = this.instances.get(s.context);
        if (!inst) return;
        const payload = msg.payload || {};
        const pws = this.pluginWs(inst.pluginUuid);
        switch (msg.event) {
            case 'setSettings':
                inst.settings = (payload && typeof payload === 'object') ? payload : {};
                this.persistSettings(inst);
                if (pws) this.send(pws, this.settingsEvent(inst));
                break;
            case 'getSettings':
                this.send(s.ws, this.settingsEvent(inst));
                break;
            case 'setGlobalSettings':
                this.globalSettings[inst.pluginUuid] = (payload && typeof payload === 'object') ? payload : {};
                this.saveGlobalSettings();
                if (pws) this.send(pws, { event: 'didReceiveGlobalSettings', payload: { settings: this.globalSettings[inst.pluginUuid] } });
                break;
            case 'getGlobalSettings':
                this.send(s.ws, { event: 'didReceiveGlobalSettings', payload: { settings: this.globalSettings[inst.pluginUuid] || {} } });
                break;
            case 'sendToPlugin':
                if (pws) this.send(pws, { event: 'sendToPlugin', action: inst.actionUuid, context: inst.context, payload: msg.payload });
                break;
            case 'openUrl':
                this.openUrl(payload.url);
                break;
            case 'logMessage': {
                const p = this.plugins.get(inst.pluginUuid);
                if (p) this.pushLog(p, `[pi] ${payload.message}`);
                break;
            }
            default:
                break;
        }
    }

    sendToPi(context, obj) {
        for (const s of this.piSessions.values()) if (s.context === context && s.ws) this.send(s.ws, obj);
    }

    // ------------------------------------------------------------------
    // Global settings (por plugin)
    // ------------------------------------------------------------------

    globalSettingsPath() {
        return path.join(this.deps.pluginsDir || path.resolve(__dirname, '../../../plugins'), 'global-settings.json');
    }

    loadGlobalSettings() {
        const file = this.globalSettingsPath();
        if (!fs.existsSync(file)) return {};
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
        } catch (e) {
            console.warn(`[Elgato] global-settings.json ilegível (${e.message}); começando vazio — o arquivo será sobrescrito na próxima gravação`);
            return {};
        }
    }

    saveGlobalSettings() {
        if (this.globalSaveTimer) clearTimeout(this.globalSaveTimer);
        this.globalSaveTimer = setTimeout(() => { this.globalSaveTimer = null; this.writeGlobalSettings(); }, SAVE_DEBOUNCE_MS);
    }

    writeGlobalSettings() {
        try {
            fs.mkdirSync(path.dirname(this.globalSettingsPath()), { recursive: true });
            fs.writeFileSync(this.globalSettingsPath(), JSON.stringify(this.globalSettings, null, 2));
        } catch (e) { console.warn('[Elgato] Falha ao gravar global-settings.json:', e.message); }
    }

    send(ws, obj) {
        if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify(obj)); } catch (e) {}
        }
    }
}

module.exports = ElgatoBridge;
