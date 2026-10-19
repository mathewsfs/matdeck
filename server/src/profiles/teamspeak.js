const net = require('net');
const WebSocket = require('ws');
const icons = require('../icons.json');
const SystemActions = require('../actions/systemActions');

/**
 * Perfil TeamSpeak.
 *
 * Modo "remote" (TS5/TS6): Remote Apps API, WebSocket em ws://127.0.0.1:5899.
 *   - handshake: { type:'auth', payload:{ identifier, version, name, description, content:{ apiKey } } }
 *   - o cliente TS só responde depois que o usuário aceita o prompt (Configurações > Remote Apps);
 *     a resposta traz payload.apiKey (persistido para não pedir de novo) e payload.connections[].
 *   - estado real via eventos clientSelfPropertyUpdated / talkStatusChanged / connectStatusChanged / clientMoved / channels.
 *   - ações via { type:'buttonPress', payload:{ button:'<identifier>.<nome>', state:bool } }. O nome do botão é livre:
 *     o usuário vincula cada botão em Configurações > Atalhos de teclado (Key Bindings) do TS clicando no atalho
 *     e, em seguida, tocando a tecla correspondente no MatDeck.
 *
 * Modo "clientquery" (TS3): telnet em 127.0.0.1:25639 com `auth apikey=...`.
 */

const TS_FLATPAK = 'com.teamspeak.TeamSpeak';
const TS_WINDOW = { classHints: ['teamspeak', 'ts3client'], titleHints: ['TeamSpeak'] };

const DEFAULT_CONFIG = {
    mode: 'auto',              // 'auto' | 'remote' | 'clientquery'
    host: '127.0.0.1',
    remotePort: 5899,
    clientQueryPort: 25639,
    apiKey: '',                // Remote Apps (gerada pelo TS ao aceitar o prompt)
    clientQueryApiKey: '',     // TS3 ClientQuery (Tools > Options > Addons > ClientQuery)
    // Host[:porta] do servidor TS. Usado só em "Abrir TS" quando desconectado (ts3server://host?port= conecta);
    // com o cliente já conectado o TS6 ignora links de canal, e a Remote Apps API não tem comando de canal.
    // A API não expõe o hostname (properties.address vem vazio; properties.port vem preenchido e tem prioridade).
    serverAddress: 'infocrivo.com:9987',
    identifier: 'br.com.matdeck',
    appName: 'MatDeck',
    appVersion: require('../../package.json').version,
    appDescription: 'Controle do TeamSpeak pelo MatDeck (tablet)',
    invertButtonState: false,  // betas antigas do TS5 invertiam o state do buttonPress
    buttons: {                 // nomes dos botões virtuais (sufixo após o identifier)
        mute: 'mute',
        soundMute: 'soundmute',
        afk: 'afk',
        ptt: 'ptt',
        whisper: 'whisper',
        disconnect: 'disconnect'
    }
};

const REMOTE_CONNECT_TIMEOUT = 3000;
const BACKOFF_STEPS = [3000, 5000, 10000, 20000, 30000];
const BIND_TIMEOUT_MS = 1200;
const DEBUG_TS = !!process.env.MATDECK_DEBUG_TS;

// botão virtual -> { flag esperada em clientSelfPropertyUpdated, índice da tecla, nome da ação nas Key Bindings do TS }
const TOGGLE_BUTTONS = {
    mute: { flag: 'inputMuted', keyIndex: 0, tsAction: 'Toggle Microphone / Mute Microphone' },
    soundMute: { flag: 'outputMuted', keyIndex: 1, tsAction: 'Toggle Speakers / Mute Speakers' },
    afk: { flag: 'away', keyIndex: 2, tsAction: 'Toggle Away' }
};

// Layout 2x4 do perfil principal. Whisper/status/vol+ saíram da grade (handlers mantidos para presets).
const KEY = { MIC: 0, SOUND: 1, AFK: 2, PTT: 3, ROOM: 4, TALKING: 5, STREAM: 6, FADER: 7 };

// Sub-tela "Salas" (getExtraProfile): 3x4, 10 salas por página + navegação/status + voltar
const ROOMS_PROFILE_ID = 'ts-channels';
const ROOMS_PER_PAGE = 10;
const ROOMS_KEY_NAV = 10;
const ROOMS_KEY_BACK = 11;
const EXTRA_REFRESH_THROTTLE_MS = 300;

// Eventos conhecidos que não precisam de tratamento (não logar como desconhecidos).
// screenshareSessionEvent: estatísticas WebRTC/estado de sessão de screenshare (muito verboso); tratado só parcialmente.
const IGNORED_EVENTS = new Set(['buttonPress', 'streamInfoReplace', 'channelsSubscribed', 'groupInfo', 'permissionList', 'neededPermissions', 'clientChannelGroupChanged', 'log', 'screenshareSessionEvent']);

// Nomes de evento de fim de transmissão (ASSUMIDOS: só streamStarted/streamClientJoined/streamClientLeft foram vistos no log)
const STREAM_STOP_EVENTS = new Set(['streamStopped', 'streamEnded', 'streamUnpublished', 'streamClosed', 'streamFinished']);

class TeamSpeakProfile {
    constructor(serverContext) {
        this.ctx = serverContext;

        // Estado exposto nas teclas
        this.connected = false;          // conectado à API (remote ou clientquery)
        this.authenticated = false;
        this.needsAuthorization = false; // aguardando o usuário aceitar o prompt no TS
        this.activeMode = null;          // 'remote' | 'clientquery' | null
        this.serverConnected = false;    // conectado a um servidor TS
        this.serverName = '';
        this.channelName = '';
        this.micMuted = false;
        this.soundMuted = false;
        this.away = false;
        this.talking = false;
        this.pttHeld = false;
        this.whisperHeld = false;
        this.nickname = '';
        this.talkers = new Map();        // clientId -> nick (quem está falando agora)
        this.lastTalker = '';            // último nick que falou

        // Vínculo guiado dos botões virtuais nas Key Bindings do TS
        this.pendingBindings = {};       // botão -> timer (aguardando o evento de estado)
        this.bindWarnings = {};          // botão -> true quando o TS não respondeu (badge 'VINCULE NO TS')
        this.boundButtons = {};          // botão -> true quando já comprovado que está vinculado
        this.bindHintLogged = {};
        this.unknownEventsLogged = {};
        this.channelList = [];           // [{ id, name, parentId, depth }] na ordem do TS (conexão atual)
        this.channelId = '';
        this.lastChannelWarnAt = 0;
        this.extraRefreshTimer = null;
        this.extraRefreshLastAt = 0;

        // Transmissão de tela (própria)
        this.streaming = false;
        this.streamSessionId = '';       // serverSessionId/publicSessionId da própria transmissão
        this.streamName = '';
        this.streamViewers = new Set();  // clientIds assistindo a própria transmissão

        // Remote Apps
        this.ws = null;
        this.connections = new Map();    // connectionId -> { id, status, clientId, serverName, port, channelId, channels: Map, channelList: [], clients: Map }
        this.currentConnectionId = null;

        // ClientQuery
        this.cq = null;
        this.cqBuffer = '';
        this.cqClid = null;

        // Reconexão: uma única cadeia
        this.retryTimer = null;
        this.retryIndex = 0;
        this.connectTimer = null;
        this.stopped = false;

        this.connect();
    }

    // ------------------------------------------------------------------
    // Config
    // ------------------------------------------------------------------

    getConfig() {
        let cfg = {};
        try {
            if (this.ctx && this.ctx.config && typeof this.ctx.config.get === 'function') {
                cfg = this.ctx.config.get('teamspeak') || {};
            }
        } catch (e) { /* usa defaults */ }
        const merged = Object.assign({}, DEFAULT_CONFIG, this.memConfig || {}, cfg);
        // Identidade do app não é configurável: config.json antigo guardava appVersion/identifier de versões passadas
        merged.identifier = DEFAULT_CONFIG.identifier;
        merged.appName = DEFAULT_CONFIG.appName;
        merged.appVersion = DEFAULT_CONFIG.appVersion;
        merged.buttons = Object.assign({}, DEFAULT_CONFIG.buttons, (this.memConfig && this.memConfig.buttons) || {}, cfg.buttons || {});
        if (merged.boundButtons && typeof merged.boundButtons === 'object') {
            this.boundButtons = Object.assign({}, merged.boundButtons, this.boundButtons);
        }
        return merged;
    }

    saveConfig(partial) {
        const next = Object.assign({}, this.getConfig(), partial);
        try {
            if (this.ctx && this.ctx.config && typeof this.ctx.config.set === 'function') {
                // Só o que mudou: gravar o merge inteiro levava identifier/appName/buttons para o config.json
                this.ctx.config.set('teamspeak', partial);
                return;
            }
        } catch (e) {
            console.log(`[TeamSpeak] Falha ao persistir config: ${e.message}`);
        }
        // Sem ctx.config: guarda só em memória (o prompt do TS vai aparecer de novo no próximo start)
        this.memConfig = next;
        console.log('[TeamSpeak] ctx.config indisponível; apiKey guardada apenas em memória');
    }

    getStatus() {
        return {
            connected: this.connected && (this.activeMode !== 'remote' || this.authenticated),
            mode: this.activeMode,
            needsAuthorization: this.needsAuthorization,
            serverConnected: this.serverConnected,
            serverName: this.serverName,
            channelName: this.channelName,
            nickname: this.nickname,
            channelId: this.channelId,
            channels: this.channelList.map((c) => ({ id: c.id, name: c.name, depth: c.depth })),
            micMuted: this.micMuted,
            soundMuted: this.soundMuted,
            away: this.away,
            talking: this.talking,
            talkers: Array.from(this.talkers.values()),
            lastTalker: this.lastTalker,
            streaming: this.streaming,
            streamName: this.streamName,
            streamViewers: this.streamViewers.size,
            pendingBindings: Object.keys(this.bindWarnings).filter((b) => this.bindWarnings[b]),
            boundButtons: Object.keys(this.boundButtons).filter((b) => this.boundButtons[b])
        };
    }

    // ------------------------------------------------------------------
    // Conexão / reconexão
    // ------------------------------------------------------------------

    connect() {
        if (this.stopped) return;
        this.clearTimers();
        const cfg = this.getConfig();

        if (cfg.mode === 'clientquery') {
            this.connectClientQuery(cfg);
        } else {
            this.connectRemote(cfg, cfg.mode === 'auto');
        }
    }

    clearTimers() {
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    }

    scheduleRetry(reason) {
        if (this.stopped) return;
        this.clearTimers();
        const delay = BACKOFF_STEPS[Math.min(this.retryIndex, BACKOFF_STEPS.length - 1)];
        this.retryIndex++;
        if (this.retryIndex <= 2 || this.retryIndex % 5 === 0) {
            console.log(`[TeamSpeak] ${reason}. Nova tentativa em ${delay / 1000}s`);
        }
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connect();
        }, delay);
    }

    resetState() {
        this.connected = false;
        this.authenticated = false;
        this.needsAuthorization = false;
        this.activeMode = null;
        this.serverConnected = false;
        this.serverName = '';
        this.channelName = '';
        this.channelId = '';
        this.channelList = [];
        this.talking = false;
        this.talkers.clear();
        this.streaming = false;
        this.streamSessionId = '';
        this.streamName = '';
        this.streamViewers.clear();
        this.connections.clear();
        this.currentConnectionId = null;
        this.cqClid = null;
        for (const b of Object.keys(this.pendingBindings)) clearTimeout(this.pendingBindings[b]);
        this.pendingBindings = {};
        this.refreshStatusKeys();
    }

    closeSockets() {
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            try {
                ws.removeAllListeners();
                ws.on('error', () => {}); // terminate() em socket ainda conectando emite 'error'
                ws.terminate();
            } catch (e) { /* ignora */ }
        }
        if (this.cq) {
            const cq = this.cq;
            this.cq = null;
            try {
                cq.removeAllListeners();
                cq.on('error', () => {});
                cq.destroy();
            } catch (e) { /* ignora */ }
        }
    }

    /** Força nova conexão (tecla "Reconectar"); se a apiKey foi recusada, limpa para pedir autorização de novo. */
    reconnect() {
        console.log('[TeamSpeak] Reconexão manual solicitada');
        this.closeSockets();
        this.resetState();
        this.retryIndex = 0;
        this.connect();
    }

    // ------------------------------------------------------------------
    // Remote Apps (TS5 / TS6)
    // ------------------------------------------------------------------

    connectRemote(cfg, fallbackToClientQuery) {
        this.closeSockets();
        const url = `ws://${cfg.host}:${cfg.remotePort}`;
        let opened = false;
        let ws;

        try {
            ws = new WebSocket(url, { handshakeTimeout: REMOTE_CONNECT_TIMEOUT });
        } catch (e) {
            this.scheduleRetry(`Remote Apps: erro ao criar WebSocket (${e.message})`);
            return;
        }
        this.ws = ws;

        this.connectTimer = setTimeout(() => {
            if (opened || this.ws !== ws) return;
            try { ws.terminate(); } catch (e) { /* ignora */ }
            if (fallbackToClientQuery) {
                console.log('[TeamSpeak] Remote Apps (5899) não respondeu em 3s; tentando ClientQuery (TS3)');
                this.connectClientQuery(cfg, true);
            } else {
                this.scheduleRetry('Remote Apps (5899) não respondeu');
            }
        }, REMOTE_CONNECT_TIMEOUT);

        ws.on('open', () => {
            opened = true;
            if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
            this.connected = true;
            this.activeMode = 'remote';
            this.authenticated = false;
            this.needsAuthorization = true; // até a resposta do auth chegar
            console.log(`[TeamSpeak] WebSocket aberto em ${url}; enviando auth${cfg.apiKey ? ' (apiKey salva)' : ' (sem apiKey: o TS vai pedir autorização)'}`);
            this.wsSend({
                type: 'auth',
                payload: {
                    identifier: cfg.identifier,
                    version: cfg.appVersion,
                    name: cfg.appName,
                    description: cfg.appDescription,
                    content: { apiKey: cfg.apiKey || '' }
                }
            });
            this.refreshStatusKeys();
        });

        ws.on('message', (data) => {
            let msg;
            try { msg = JSON.parse(data.toString()); } catch (e) { return; }
            this.handleRemoteMessage(msg);
        });

        ws.on('error', (err) => {
            if (this.ws !== ws) return;
            if (!opened) {
                if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
                if (fallbackToClientQuery && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(err.message)) {
                    this.connectClientQuery(cfg, true);
                } else {
                    this.scheduleRetry(`Remote Apps indisponível (${err.message})`);
                }
            } else {
                console.log(`[TeamSpeak] Erro no WebSocket: ${err.message}`);
            }
        });

        ws.on('close', (code) => {
            if (this.ws !== ws) return;
            const wasAuthenticated = this.authenticated;
            const wasWaiting = this.needsAuthorization && !wasAuthenticated;
            this.ws = null;
            if (opened) {
                if (wasWaiting) {
                    console.log('[TeamSpeak] Conexão fechada sem autorização: o pedido foi recusado no TS ou a apiKey salva é inválida');
                    if (cfg.apiKey) {
                        console.log('[TeamSpeak] Descartando apiKey salva; o TS vai pedir autorização de novo');
                        this.saveConfig({ apiKey: '' });
                    }
                } else {
                    console.log(`[TeamSpeak] Conexão Remote Apps fechada (code ${code})`);
                }
                this.resetState();
                this.scheduleRetry('Remote Apps desconectado');
            }
        });
    }

    wsSend(obj) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try {
            this.ws.send(JSON.stringify(obj));
            return true;
        } catch (e) {
            console.log(`[TeamSpeak] Falha ao enviar: ${e.message}`);
            return false;
        }
    }

    handleRemoteMessage(msg) {
        const type = msg.type;
        const p = msg.payload || {};

        if (DEBUG_TS) {
            const keys = Object.keys(p).join(',');
            let json = '';
            try { json = JSON.stringify(msg); } catch (e) { json = String(msg); }
            console.log(`[TeamSpeak][debug] evt=${type} payloadKeys=[${keys}] ${json.length > 600 ? json.slice(0, 600) + '…' : json}`);
        }

        switch (type) {
            case 'auth':
                this.handleAuthResponse(msg);
                break;

            case 'connectStatusChanged': {
                const conn = this.getOrCreateConnection(p.connectionId);
                const before = conn.status;
                conn.status = Number(p.status) || 0;
                if (p.info) {
                    if (p.info.serverName) conn.serverName = p.info.serverName;
                    if (p.info.clientId !== undefined) conn.clientId = Number(p.info.clientId);
                    if (p.info.serverPort || p.info.port) conn.port = Number(p.info.serverPort || p.info.port);
                    if (p.info.serverAddress || p.info.address || p.info.hostname) conn.address = String(p.info.serverAddress || p.info.address || p.info.hostname);
                }
                if (conn.status === 4) this.currentConnectionId = conn.id;
                if (conn.status === 4 && before !== 4) {
                    this.notify({ level: 'success', title: 'TeamSpeak', text: `Conectado a ${conn.serverName || 'servidor'}` });
                }
                if (conn.status === 0 && this.currentConnectionId === conn.id) {
                    if (before !== 0) this.notify({ level: 'warn', title: 'TeamSpeak', text: `Desconectado de ${conn.serverName || 'servidor'}` });
                    this.connections.delete(conn.id);
                    this.currentConnectionId = this.pickConnectionId();
                }
                this.syncFromConnections();
                break;
            }

            case 'clientSelfPropertyUpdated': {
                if (!this.isCurrent(p.connectionId)) break;
                this.applySelfProperty(p.flag, p.newValue);
                break;
            }

            case 'clientPropertiesUpdated': {
                const conn = this.connections.get(Number(p.connectionId));
                if (!conn || !p.properties) break;
                if (p.properties.nickname) conn.clients.set(Number(p.clientId), p.properties.nickname);
                if (p.properties.isStreaming !== undefined && this.isCurrent(p.connectionId)) {
                    this.handleClientStreamingFlag(conn, Number(p.clientId), !!p.properties.isStreaming);
                }
                const chId = p.channelId !== undefined ? p.channelId : p.properties.channelId;
                if (chId !== undefined && chId !== null) {
                    conn.clientChannels.set(Number(p.clientId), String(chId));
                    if (this.isCurrent(p.connectionId)) this.refreshChannelKeys();
                }
                if (Number(p.clientId) === conn.clientId && this.isCurrent(p.connectionId)) this.applySelfProperties(p.properties);
                break;
            }

            case 'talkStatusChanged': {
                const conn = this.connections.get(Number(p.connectionId));
                if (!conn || !this.isCurrent(p.connectionId)) break;
                const clientId = Number(p.clientId);
                const talking = Number(p.status) === 1;
                const isSelf = clientId === conn.clientId;
                if (isSelf) {
                    this.setTalking(talking); // usa a chave 'self' em talkers
                    break;
                }
                const nick = conn.clients.get(clientId) || `Cliente ${clientId}`;
                if (talking) {
                    this.talkers.set(clientId, nick);
                    this.lastTalker = nick;
                } else {
                    this.talkers.delete(clientId);
                }
                this.ctx.updateKey('teamspeak', KEY.TALKING, this.talkingKey());
                break;
            }

            case 'clientMoved': {
                const conn = this.connections.get(Number(p.connectionId));
                if (!conn) break;
                const clientId = Number(p.clientId);
                const newCh = String(p.newChannelId || '');
                if (p.properties && p.properties.nickname) conn.clients.set(clientId, p.properties.nickname);
                if (newCh === '' || newCh === '0') {
                    conn.clientChannels.delete(clientId);
                    if (clientId !== conn.clientId) { conn.clients.delete(clientId); this.talkers.delete(clientId); }
                } else {
                    conn.clientChannels.set(clientId, newCh);
                }
                if (clientId === conn.clientId) {
                    const oldCh = conn.channelId;
                    conn.channelId = newCh;
                    if (this.isCurrent(p.connectionId)) {
                        this.syncFromConnections();
                        if (newCh && newCh !== oldCh) this.notify({ level: 'info', title: 'Canal', text: `Você entrou em ${this.channelName || `canal ${newCh}`}` });
                    }
                } else if (this.isCurrent(p.connectionId)) {
                    this.refreshChannelKeys();
                }
                break;
            }

            case 'channels': {
                const conn = this.getOrCreateConnection(p.connectionId);
                if (p.info) this.buildChannelMap(conn, p.info);
                if (this.isCurrent(p.connectionId)) this.syncFromConnections();
                break;
            }

            case 'channelPropertiesUpdated': {
                const conn = this.connections.get(Number(p.connectionId));
                if (!conn || !p.properties || !p.properties.name) break;
                conn.channels.set(String(p.channelId), p.properties.name);
                if (this.isCurrent(p.connectionId)) this.syncFromConnections();
                break;
            }

            case 'serverPropertiesUpdated': {
                const conn = this.connections.get(Number(p.connectionId));
                if (!conn || !p.properties || !p.properties.name) break;
                conn.serverName = p.properties.name;
                if (this.isCurrent(p.connectionId)) this.syncFromConnections();
                break;
            }

            case 'streamStarted':
            case 'streamPublished': {
                // CONFIRMADO (streamStarted): payload { connectionId, name, mode, type, publicSessionId, streamIdentifier:{ clientId, scHandlerId, serverSessionId } }
                const conn = this.connections.get(Number(p.connectionId));
                const sid = p.streamIdentifier || {};
                if (!conn || !this.isCurrent(p.connectionId)) break;
                const streamer = Number(sid.clientId);
                if (streamer === conn.clientId) {
                    this.setStreaming(true, sid.serverSessionId || p.publicSessionId || '', p.name || '');
                } else if (!Number.isNaN(streamer)) {
                    this.handleClientStreamingFlag(conn, streamer, true);
                }
                break;
            }

            case 'streamClientJoined':
            case 'streamClientLeft': {
                // CONFIRMADO: payload { connectionId, streamIdentifier:{ clientId (espectador), scHandlerId, serverSessionId }, reason? }
                if (!this.streaming || !this.isCurrent(p.connectionId)) break;
                const sid = p.streamIdentifier || {};
                if (this.streamSessionId && sid.serverSessionId && sid.serverSessionId !== this.streamSessionId) break;
                const viewer = Number(sid.clientId);
                if (Number.isNaN(viewer)) break;
                if (type === 'streamClientJoined') this.streamViewers.add(viewer); else this.streamViewers.delete(viewer);
                this.ctx.updateKey('teamspeak', KEY.STREAM, this.streamKey());
                break;
            }

            default:
                if (STREAM_STOP_EVENTS.has(type)) {
                    const conn = this.connections.get(Number(p.connectionId));
                    const sid = p.streamIdentifier || {};
                    if (conn && this.isCurrent(p.connectionId)) {
                        const streamer = Number(sid.clientId);
                        const isMine = streamer === conn.clientId || (this.streamSessionId && (sid.serverSessionId === this.streamSessionId || p.publicSessionId === this.streamSessionId));
                        if (isMine) this.setStreaming(false);
                        else if (!Number.isNaN(streamer)) this.handleClientStreamingFlag(conn, streamer, false);
                    }
                    break;
                }
                this.handleOtherEvent(type, p, msg);
                break;
        }
    }

    // ------------------------------------------------------------------
    // Transmissão de tela
    // ------------------------------------------------------------------

    setStreaming(flag, sessionId = '', name = '') {
        const changed = this.streaming !== flag;
        this.streaming = flag;
        if (flag) {
            if (sessionId) this.streamSessionId = sessionId;
            if (name) this.streamName = name;
            if (changed) this.streamViewers.clear();
        } else {
            this.streamSessionId = '';
            this.streamName = '';
            this.streamViewers.clear();
        }
        if (changed) {
            console.log(`[TeamSpeak] Transmissão de tela ${flag ? 'INICIADA' : 'encerrada'}${this.streamName ? ` (${this.streamName})` : ''}`);
            this.notify({ level: flag ? 'success' : 'info', title: 'TeamSpeak', text: flag ? 'Você está transmitindo a tela' : 'Transmissão de tela encerrada' });
        }
        this.ctx.updateKey('teamspeak', KEY.STREAM, this.streamKey());
    }

    /** isStreaming de um cliente (próprio ou de terceiro). Terceiros: notifica uma vez ao começar. */
    handleClientStreamingFlag(conn, clientId, flag) {
        if (clientId === conn.clientId) {
            this.setStreaming(flag);
            return;
        }
        if (!conn.streamingClients) conn.streamingClients = new Set();
        const was = conn.streamingClients.has(clientId);
        if (flag && !was) {
            conn.streamingClients.add(clientId);
            const nick = conn.clients.get(clientId) || `Cliente ${clientId}`;
            console.log(`[TeamSpeak] ${nick} começou a transmitir`);
            this.notify({ level: 'info', title: 'TeamSpeak', text: `${nick} começou a transmitir` });
        } else if (!flag && was) {
            conn.streamingClients.delete(clientId);
        }
    }

    streamKey() {
        if (!this.streaming) {
            return { title: 'Transmissão', icon: icons.share, actionId: 'ts:stream', badge: 'OFF', badgeColor: '#4B5563', bgColor: '#1C1D25', borderColor: '#2D303E', titleColor: '#9CA3AF', active: false };
        }
        const n = this.streamViewers.size;
        return {
            title: 'TRANSMITINDO',
            actionId: 'ts:stream',
            icon: icons.share,
            badge: n > 0 ? `AO VIVO · ${n}` : 'AO VIVO',
            badgeColor: '#EF4444',
            bgColor: '#7F1D1D',
            borderColor: '#F87171',
            titleColor: '#FFFFFF',
            active: true
        };
    }

    /** Pokes, mensagens de texto e tipos ainda desconhecidos (logados uma vez cada para descobrirmos o formato). */
    handleOtherEvent(type, p, msg) {
        if (/poke/i.test(type)) {
            const nick = this.resolveEventNick(p);
            const text = this.resolveEventText(p);
            console.log(`[TeamSpeak] Cutucada de ${nick}: ${text}`);
            this.notify({ level: 'poke', title: `Cutucada de ${nick}`, text, ttlMs: 8000 });
            return;
        }
        if (/^(textMessage|chatMessage|textMessageReceived|message)$/i.test(type)) {
            const conn = this.currentConnectionId !== null ? this.connections.get(this.currentConnectionId) : null;
            const fromId = Number(p.invokerId !== undefined ? p.invokerId : (p.fromId !== undefined ? p.fromId : p.clientId));
            if (conn && !Number.isNaN(fromId) && fromId === conn.clientId) return; // mensagem nossa
            const mode = p.targetMode !== undefined ? String(p.targetMode).toLowerCase() : '';
            const isPrivate = mode === '' || mode === '1' || mode === 'client' || mode === 'private';
            if (!isPrivate) return;
            const nick = this.resolveEventNick(p);
            const text = this.resolveEventText(p);
            console.log(`[TeamSpeak] Mensagem de ${nick}: ${text}`);
            this.notify({ level: 'info', title: `Mensagem de ${nick}`, text, ttlMs: 8000 });
            return;
        }
        if (IGNORED_EVENTS.has(type)) return;
        if (!this.unknownEventsLogged[type]) {
            this.unknownEventsLogged[type] = true;
            let json = '';
            try { json = JSON.stringify(msg); } catch (e) { json = String(msg); }
            console.log(`[TeamSpeak] Evento não tratado "${type}" (payloadKeys=[${Object.keys(p).join(',')}]): ${json.slice(0, 400)}`);
        }
    }

    resolveEventNick(p) {
        for (const k of ['invokerName', 'fromName', 'senderName', 'nickname', 'name']) {
            if (typeof p[k] === 'string' && p[k]) return p[k];
        }
        const conn = this.currentConnectionId !== null ? this.connections.get(this.currentConnectionId) : null;
        for (const k of ['invokerId', 'fromId', 'senderId', 'clientId']) {
            if (p[k] !== undefined && conn && conn.clients.has(Number(p[k]))) return conn.clients.get(Number(p[k]));
        }
        return 'alguém';
    }

    resolveEventText(p) {
        for (const k of ['message', 'msg', 'text', 'content']) {
            if (typeof p[k] === 'string') return p[k];
        }
        return '';
    }

    notify(payload) {
        try {
            if (this.ctx && typeof this.ctx.notify === 'function') this.ctx.notify(Object.assign({ ttlMs: 5000 }, payload));
        } catch (e) {
            console.log(`[TeamSpeak] notify falhou: ${e.message}`);
        }
    }

    handleAuthResponse(msg) {
        const status = msg.status || {};
        const p = msg.payload || {};
        if (status.code !== undefined && Number(status.code) !== 0) {
            console.log(`[TeamSpeak] Auth recusado pelo TS: ${status.code} ${status.message || ''}`);
            this.needsAuthorization = false;
            if (this.getConfig().apiKey) this.saveConfig({ apiKey: '' });
            return; // o TS normalmente fecha o socket em seguida -> retry
        }

        this.authenticated = true;
        this.needsAuthorization = false;
        this.retryIndex = 0;
        console.log('[TeamSpeak] Autenticado na Remote Apps API');

        if (p.apiKey && p.apiKey !== this.getConfig().apiKey) {
            this.saveConfig({ apiKey: p.apiKey });
            console.log('[TeamSpeak] Nova apiKey recebida e salva');
        }

        this.connections.clear();
        for (const c of (p.connections || [])) {
            const conn = this.getOrCreateConnection(c.id);
            conn.status = Number(c.status) || 0;
            conn.clientId = Number(c.clientId);
            if (c.properties) {
                if (c.properties.name) conn.serverName = c.properties.name;
                if (c.properties.port) conn.port = Number(c.properties.port);
                if (c.properties.address) conn.address = String(c.properties.address);
            }
            if (c.channelInfos) this.buildChannelMap(conn, c.channelInfos);
            for (const ci of (c.clientInfos || [])) {
                if (!ci) continue;
                if (ci.properties && ci.properties.nickname) conn.clients.set(Number(ci.id), ci.properties.nickname);
                if (ci.channelId !== undefined && ci.channelId !== null) conn.clientChannels.set(Number(ci.id), String(ci.channelId));
            }
            const me = (c.clientInfos || []).find((ci) => Number(ci.id) === conn.clientId);
            if (me) {
                conn.channelId = String(me.channelId || '');
                conn.selfProps = me.properties || {};
            }
            if (DEBUG_TS) {
                console.log(`[TeamSpeak][debug] auth conn id=${conn.id} status=${conn.status} clientId=${conn.clientId} server="${conn.serverName}" ` +
                    `channelId=${conn.channelId} channels=${conn.channels.size} clients=${conn.clients.size} selfProps=${JSON.stringify(conn.selfProps || {}).slice(0, 300)}`);
            }
        }
        this.currentConnectionId = (p.currentConnectionId !== undefined && this.connections.has(Number(p.currentConnectionId)))
            ? Number(p.currentConnectionId)
            : this.pickConnectionId();

        this.syncFromConnections();
        const cur = this.connections.get(this.currentConnectionId);
        if (cur && cur.selfProps) this.applySelfProperties(cur.selfProps);
    }

    getOrCreateConnection(id) {
        const key = Number(id);
        if (!this.connections.has(key)) {
            this.connections.set(key, { id: key, status: 0, clientId: null, serverName: '', port: null, address: '', channelId: '', channels: new Map(), channelList: [], clients: new Map(), clientChannels: new Map(), selfProps: null });
        }
        return this.connections.get(key);
    }

    pickConnectionId() {
        let best = null;
        for (const conn of this.connections.values()) {
            if (conn.status === 4) return conn.id;
            if (best === null && conn.status > 0) best = conn.id;
        }
        return best;
    }

    isCurrent(connectionId) {
        return this.currentConnectionId !== null && Number(connectionId) === this.currentConnectionId;
    }

    buildChannelMap(conn, channelInfos) {
        const list = [];
        const walk = (channels, depth) => {
            for (const ch of (channels || [])) {
                if (!ch || ch.id === undefined) continue;
                const name = (ch.properties && ch.properties.name) || `Canal ${ch.id}`;
                conn.channels.set(String(ch.id), name);
                list.push({ id: String(ch.id), name, parentId: String(ch.parentId || '0'), depth });
                if (ch.subChannels) walk(ch.subChannels, depth + 1);
            }
        };
        walk(channelInfos.rootChannels, 0); // TS já manda na ordem de exibição
        conn.channelList = list;
    }

    applySelfProperties(props) {
        for (const [flag, value] of Object.entries(props)) this.applySelfProperty(flag, value, true);
        this.refreshVoiceKeys();
    }

    applySelfProperty(flag, value, silent = false) {
        const bool = value === true || value === 1 || value === '1' || value === 'true';
        switch (flag) {
            case 'inputMuted': this.micMuted = bool; break;
            case 'inputDeactivated': if (bool) this.micMuted = true; break;
            case 'outputMuted': this.soundMuted = bool; break;
            case 'away':
                if (!silent && this.away !== bool) this.notify({ level: 'info', title: 'TeamSpeak', text: bool ? 'Você está ausente (AFK)' : 'Você voltou (disponível)' });
                this.away = bool;
                break;
            case 'flagTalking': this.setTalking(bool); break;
            case 'nickname': if (typeof value === 'string') this.nickname = value; break;
            case 'isStreaming': this.setStreaming(bool); break; // flag ASSUMIDA em clientSelfPropertyUpdated (vista só em clientPropertiesUpdated)
            default: return;
        }
        // silent = propriedades iniciais do auth: não provam que o botão está vinculado
        if (!silent) {
            this.resolveBinding(flag);
            this.refreshVoiceKeys();
        }
    }

    syncFromConnections() {
        const conn = this.currentConnectionId !== null ? this.connections.get(this.currentConnectionId) : null;
        this.serverConnected = !!conn && conn.status >= 2;
        this.serverName = conn ? (conn.serverName || '') : '';
        this.channelId = conn ? (conn.channelId || '') : '';
        this.channelName = conn && conn.channelId ? (conn.channels.get(conn.channelId) || '') : '';
        this.channelList = conn ? conn.channelList : [];
        if (conn && conn.clientId !== null && !this.nickname) this.nickname = conn.clients.get(conn.clientId) || '';
        if (!this.serverConnected) { this.talking = false; this.talkers.clear(); }
        this.refreshStatusKeys();
        this.refreshChannelKeys();
    }

    /** Quantos clientes estão no canal (conexão atual), a partir de clientInfos/clientMoved. */
    channelClientCount(channelId) {
        const conn = this.currentConnectionId !== null ? this.connections.get(this.currentConnectionId) : null;
        if (!conn) return 0;
        let n = 0;
        for (const ch of conn.clientChannels.values()) if (ch === String(channelId)) n++;
        return n;
    }

    /** Link ts3server://host?port= para CONECTAR ao servidor (só faz sentido desconectado). */
    buildConnectUrl() {
        const cfg = this.getConfig();
        const conn = this.currentConnectionId !== null ? this.connections.get(this.currentConnectionId) : null;
        const [cfgHost, cfgPort] = String(cfg.serverAddress || '').split(':');
        const host = (conn && conn.address) || cfgHost;
        const port = (conn && conn.port) || Number(cfgPort) || 9987;
        return host ? `ts3server://${host}?port=${port}` : null;
    }

    warnChannelSwitchUnsupported() {
        console.log('[TeamSpeak] Troca de canal não suportada pelo TS6 (sem comando na Remote Apps API; links ts3server são ignorados quando conectado)');
        const now = Date.now();
        if (now - this.lastChannelWarnAt < 10000) return;
        this.lastChannelWarnAt = now;
        this.notify({ level: 'warn', title: 'TeamSpeak', text: 'O TS6 não permite trocar de canal pela API' });
    }

    setTalking(flag) {
        if (this.talking === flag) return;
        this.talking = flag;
        const me = this.nickname || 'Você';
        if (flag) { this.talkers.set('self', me); this.lastTalker = me; } else { this.talkers.delete('self'); }
        this.ctx.updateKey('teamspeak', KEY.TALKING, this.talkingKey());
    }

    /** Envia um botão virtual. toggle=true faz press+release. */
    pressButton(name, state, toggle = false) {
        if (this.activeMode !== 'remote' || !this.authenticated) {
            console.log(`[TeamSpeak] Botão "${name}" ignorado: Remote Apps não autenticado`);
            return false;
        }
        const cfg = this.getConfig();
        const button = `${cfg.identifier}.${name}`;
        const s = cfg.invertButtonState ? !state : state;
        const ok = this.wsSend({ type: 'buttonPress', payload: { button, state: s } });
        if (ok && toggle) {
            setTimeout(() => this.wsSend({ type: 'buttonPress', payload: { button, state: !s } }), 60);
        }
        return ok;
    }

    // ------------------------------------------------------------------
    // Vínculo guiado (Key Bindings do TS)
    // ------------------------------------------------------------------

    /** Dispara um botão de toggle e espera o evento de estado; sem resposta em 1,2 s marca 'VINCULE NO TS'. */
    pressToggleButton(buttonKey) {
        const spec = TOGGLE_BUTTONS[buttonKey];
        const cfg = this.getConfig();
        const name = cfg.buttons[buttonKey];
        if (!this.pressButton(name, true, true) || !spec) return;

        // Vínculo já confirmado antes: o TS pode ignorar toques muito seguidos ou já estar no estado-alvo;
        // não rebaixar para "sem vínculo" por um toque sem resposta.
        if (this.boundButtons[buttonKey] === true) return;

        if (this.pendingBindings[buttonKey]) clearTimeout(this.pendingBindings[buttonKey]);
        this.pendingBindings[buttonKey] = setTimeout(() => {
            delete this.pendingBindings[buttonKey];
            this.bindWarnings[buttonKey] = true;
            this.boundButtons[buttonKey] = false;
            this.ctx.updateKey('teamspeak', spec.keyIndex, this.keyForIndex(spec.keyIndex));
            if (!this.bindHintLogged[buttonKey]) {
                this.bindHintLogged[buttonKey] = true;
                console.log(`[TeamSpeak] Botão "${cfg.identifier}.${name}" não alterou o estado em ${BIND_TIMEOUT_MS} ms: falta vincular no TeamSpeak. ` +
                    `Settings → Key Bindings → "${spec.tsAction}" → Choose → toque esta tecla no MatDeck (o TS captura o botão virtual).`);
            }
        }, BIND_TIMEOUT_MS);
    }

    /** Chegou o evento de estado correspondente a um botão: confirma o vínculo e limpa o aviso. */
    resolveBinding(flag) {
        for (const [buttonKey, spec] of Object.entries(TOGGLE_BUTTONS)) {
            if (spec.flag !== flag) continue;
            if (this.pendingBindings[buttonKey]) {
                clearTimeout(this.pendingBindings[buttonKey]);
                delete this.pendingBindings[buttonKey];
            }
            const changed = this.bindWarnings[buttonKey] || !this.boundButtons[buttonKey];
            this.bindWarnings[buttonKey] = false;
            this.boundButtons[buttonKey] = true;
            if (changed) {
                console.log(`[TeamSpeak] Botão "${buttonKey}" vinculado no TS (evento ${flag} recebido)`);
                this.saveConfig({ boundButtons: Object.assign({}, this.boundButtons) });
            }
        }
    }

    keyForIndex(idx) {
        switch (idx) {
            case KEY.MIC: return this.micKey();
            case KEY.SOUND: return this.soundKey();
            case KEY.AFK: return this.awayKey();
            case KEY.PTT: return this.pttKey();
            case KEY.ROOM: return this.roomKey();
            case KEY.TALKING: return this.talkingKey();
            case KEY.STREAM: return this.streamKey();
            case KEY.FADER: return this.faderKey();
            default: return {};
        }
    }

    bindBadge(buttonKey, normalBadge, normalColor) {
        if (this.bindWarnings[buttonKey]) return { badge: 'VINCULE NO TS', badgeColor: '#F59E0B' };
        return { badge: normalBadge, badgeColor: normalColor };
    }

    // ------------------------------------------------------------------
    // ClientQuery (TS3)
    // ------------------------------------------------------------------

    connectClientQuery(cfg, fromAutoFallback = false) {
        this.closeSockets();
        const sock = net.createConnection({ host: cfg.host, port: cfg.clientQueryPort });
        this.cq = sock;
        this.cqBuffer = '';
        let opened = false;

        sock.setTimeout(REMOTE_CONNECT_TIMEOUT);
        sock.on('timeout', () => {
            if (!opened) {
                sock.destroy();
                this.scheduleRetry(fromAutoFallback ? 'TeamSpeak não encontrado (nem Remote Apps 5899, nem ClientQuery 25639)' : 'ClientQuery (25639) não respondeu');
            }
        });

        sock.on('connect', () => {
            opened = true;
            sock.setTimeout(0);
            this.connected = true;
            this.activeMode = 'clientquery';
            this.authenticated = false;
            console.log(`[TeamSpeak] Conectado ao ClientQuery em ${cfg.host}:${cfg.clientQueryPort}`);
            if (cfg.clientQueryApiKey) this.cqSend(`auth apikey=${cfg.clientQueryApiKey}`);
            else console.log('[TeamSpeak] ClientQuery sem clientQueryApiKey na config: comandos vão falhar até configurar');
            this.cqSend('use');
            this.cqSend('clientnotifyregister schandlerid=0 event=any');
            this.cqSend('whoami');
            this.refreshStatusKeys();
        });

        sock.on('data', (chunk) => {
            this.cqBuffer += chunk.toString('utf8');
            let idx;
            while ((idx = this.cqBuffer.indexOf('\n')) >= 0) {
                const line = this.cqBuffer.slice(0, idx).replace(/\r$/, '');
                this.cqBuffer = this.cqBuffer.slice(idx + 1);
                if (line.trim()) this.handleClientQueryLine(line.trim());
            }
        });

        sock.on('error', (err) => {
            if (this.cq !== sock) return;
            if (!opened) {
                this.scheduleRetry(fromAutoFallback ? `TeamSpeak não encontrado (Remote Apps e ClientQuery indisponíveis)` : `ClientQuery indisponível (${err.message})`);
            } else {
                console.log(`[TeamSpeak] Erro no ClientQuery: ${err.message}`);
            }
        });

        sock.on('close', () => {
            if (this.cq !== sock) return;
            this.cq = null;
            if (opened) {
                console.log('[TeamSpeak] ClientQuery desconectado');
                this.resetState();
                this.scheduleRetry('ClientQuery desconectado');
            }
        });
    }

    cqSend(cmd) {
        if (!this.cq || this.cq.destroyed) return false;
        this.cq.write(cmd + '\n');
        return true;
    }

    static parseCqLine(line) {
        const out = {};
        for (const token of line.split(/\s+/)) {
            const eq = token.indexOf('=');
            if (eq < 0) { out[token] = true; continue; }
            out[token.slice(0, eq)] = token.slice(eq + 1).replace(/\\s/g, ' ').replace(/\\p/g, '|').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
        }
        return out;
    }

    handleClientQueryLine(line) {
        if (line.startsWith('error ')) {
            const e = TeamSpeakProfile.parseCqLine(line.slice(6));
            if (e.id === '0') {
                if (!this.authenticated) { this.authenticated = true; this.retryIndex = 0; this.refreshStatusKeys(); }
            } else if (e.id === '1796' || e.id === '1794') {
                this.serverConnected = false;
                this.refreshStatusKeys();
            } else {
                console.log(`[TeamSpeak] ClientQuery erro ${e.id}: ${e.msg || ''}`);
            }
            return;
        }

        if (line.startsWith('notify')) {
            const sp = line.indexOf(' ');
            const evt = sp > 0 ? line.slice(0, sp) : line;
            const data = TeamSpeakProfile.parseCqLine(sp > 0 ? line.slice(sp + 1) : '');
            if (evt === 'notifyconnectstatuschange') {
                this.serverConnected = data.status === 'connection_established';
                if (!this.serverConnected) this.talking = false;
                this.refreshStatusKeys();
                if (this.serverConnected) this.cqSend('whoami');
            } else if (evt === 'notifyclientupdated' && this.cqClid && data.clid === this.cqClid) {
                this.applyCqClientProps(data);
            } else if (evt === 'notifytalkstatuschange' && this.cqClid && data.clid === this.cqClid) {
                this.setTalking(data.status === '1');
            } else if (evt === 'notifyclientmoved' && this.cqClid && data.clid === this.cqClid) {
                this.cqSend(`channelconnectinfo`);
            }
            return;
        }

        const data = TeamSpeakProfile.parseCqLine(line);
        if (data.clid && data.cid && !data.client_input_muted) {
            // resposta do whoami
            this.cqClid = data.clid;
            this.serverConnected = true;
            this.refreshStatusKeys();
            this.cqSend(`clientvariable clid=${data.clid} client_input_muted client_output_muted client_away`);
        } else if (data.clid === this.cqClid && (data.client_input_muted !== undefined || data.client_away !== undefined)) {
            this.applyCqClientProps(data);
        } else if (data.path !== undefined && data.password === undefined) {
            this.channelName = (data.path || '').split('/').filter(Boolean).pop() || '';
            this.refreshStatusKeys();
        }
    }

    applyCqClientProps(data) {
        if (data.client_input_muted !== undefined) this.micMuted = data.client_input_muted === '1';
        if (data.client_output_muted !== undefined) this.soundMuted = data.client_output_muted === '1';
        if (data.client_away !== undefined) this.away = data.client_away === '1';
        this.refreshVoiceKeys();
    }

    // ------------------------------------------------------------------
    // Teclas
    // ------------------------------------------------------------------

    micKey() {
        return {
            title: this.micMuted ? 'Mic MUTADO' : 'Microfone',
            icon: this.micMuted ? icons.mic_muted : icons.mic_on,
            actionId: 'ts:mute_mic',
            titleColor: '#FFFFFF',
            bgColor: this.micMuted ? '#DC2626' : '#1C1D25',
            borderColor: this.micMuted ? '#F87171' : '#2D303E',
            ...this.bindBadge('mute', this.micMuted ? 'MUDO' : null, '#7F1D1D'),
            active: this.micMuted
        };
    }

    soundKey() {
        return {
            title: this.soundMuted ? 'Som MUTADO' : 'Fones',
            icon: this.soundMuted ? icons.headphone_off : icons.headphone,
            actionId: 'ts:mute_sound',
            titleColor: '#FFFFFF',
            bgColor: this.soundMuted ? '#DC2626' : '#1C1D25',
            borderColor: this.soundMuted ? '#F87171' : '#2D303E',
            ...this.bindBadge('soundMute', this.soundMuted ? 'MUDO' : null, '#7F1D1D'),
            active: this.soundMuted
        };
    }

    awayKey() {
        return {
            title: this.away ? 'AFK ligado' : 'AFK',
            icon: icons.afk,
            actionId: 'ts:toggle_away',
            titleColor: '#FFFFFF',
            bgColor: this.away ? '#D97706' : '#1C1D25',
            borderColor: this.away ? '#FBBF24' : '#2D303E',
            ...this.bindBadge('afk', this.away ? 'ON' : 'OFF', this.away ? '#78350F' : '#4B5563'),
            active: this.away
        };
    }

    pttKey() {
        return {
            title: 'Push to Talk',
            icon: icons.ptt,
            actionId: 'ts:ptt',
            bgColor: this.pttHeld ? '#16A34A' : '#1C1D25',
            borderColor: this.pttHeld ? '#4ADE80' : '#2D303E',
            badge: this.pttHeld ? 'FALANDO' : null,
            badgeColor: this.pttHeld ? '#14532D' : '#174C7E',
            active: this.pttHeld
        };
    }

    statusKey() {
        const apiUp = this.connected && (this.activeMode !== 'remote' || this.authenticated);
        let title;
        let badge;
        let badgeColor;
        if (this.needsAuthorization) {
            title = 'Aceite no TS';
            badge = 'AGUARDANDO';
            badgeColor = '#D97706';
        } else if (!apiUp) {
            title = 'TS Offline';
            badge = 'OFF';
            badgeColor = '#6B7280';
        } else if (this.serverConnected) {
            // nick em cima, servidor como badge
            title = this.nickname || 'Conectado';
            badge = (this.serverName || 'ON').slice(0, 18);
            badgeColor = '#10B981';
        } else {
            title = 'Sem servidor';
            badge = this.activeMode === 'remote' ? 'API OK' : 'CQ OK';
            badgeColor = '#3B82F6';
        }
        return {
            title,
            icon: icons.teamspeak,
            actionId: 'ts:status',
            badge,
            badgeColor,
            titleColor: this.serverConnected ? '#10B981' : '#FFFFFF',
            active: this.serverConnected
        };
    }

    /** Tecla de sala da sub-tela (índice absoluto na channelList). Tocar só dá o aviso "TS6 não permite". */
    channelKey(n, first = false) {
        const ch = this.channelList[n];
        if (!ch || !this.serverConnected) {
            const showEmpty = first && !this.serverConnected;
            return { title: showEmpty ? 'Sem canais' : '', icon: showEmpty ? icons.channel : null, actionId: '', badge: null, bgColor: '#1C1D25', borderColor: '#2D303E', titleColor: '#4B5563', active: false };
        }
        const current = ch.id === this.channelId;
        const count = this.channelClientCount(ch.id);
        return {
            title: (ch.depth > 0 ? '· ' : '') + ch.name,
            icon: ch.depth > 0 ? icons.channel_sub : icons.channel,
            actionId: `ts:channel:${ch.id}`,
            badge: count > 0 ? String(count) : null,
            badgeColor: current ? '#1D4ED8' : '#4B5563',
            bgColor: current ? '#174C7E' : '#1C1D25',
            borderColor: current ? '#60A5FA' : '#2D303E',
            titleColor: current ? '#FFFFFF' : '#9CA3AF',
            active: current
        };
    }

    /** Canal atual/contagens mudaram: atualiza a tecla "Sala" e, se a sub-tela de salas estiver ativa, reenvia-a. */
    refreshChannelKeys() {
        if (!this.ctx || typeof this.ctx.updateKey !== 'function') return;
        this.ctx.updateKey('teamspeak', KEY.ROOM, this.roomKey());
        this.refreshExtraScreen();
    }

    refreshExtraScreen() {
        const current = this.ctx && this.ctx.currentProfileId;
        if (typeof current !== 'string' || !current.startsWith(ROOMS_PROFILE_ID) || typeof this.ctx.switchProfile !== 'function') return;
        if (this.extraRefreshTimer) return; // já agendado
        const wait = Math.max(0, EXTRA_REFRESH_THROTTLE_MS - (Date.now() - this.extraRefreshLastAt));
        this.extraRefreshTimer = setTimeout(() => {
            this.extraRefreshTimer = null;
            this.extraRefreshLastAt = Date.now();
            const id = this.ctx.currentProfileId;
            if (typeof id === 'string' && id.startsWith(ROOMS_PROFILE_ID)) this.ctx.switchProfile(id);
        }, wait);
    }

    /** Tecla "Sala" do perfil principal: canal atual + nº de pessoas; abre a sub-tela de salas. Desconectado vira status/reconectar. */
    roomKey() {
        const apiUp = this.connected && (this.activeMode !== 'remote' || this.authenticated);
        const base = { icon: icons.channel, borderColor: '#4F8CFF', bgColor: '#1C1D25', titleColor: '#FFFFFF', active: false };
        if (this.needsAuthorization) {
            return { ...base, title: 'Aceite no TS', badge: 'AGUARDANDO', badgeColor: '#D97706', actionId: 'ts:status' };
        }
        if (!apiUp) {
            return { ...base, title: 'TS Offline', badge: 'OFF', badgeColor: '#6B7280', borderColor: '#2D303E', titleColor: '#9CA3AF', actionId: 'ts:status' };
        }
        if (!this.serverConnected) {
            return { ...base, title: 'Sem servidor', badge: this.activeMode === 'remote' ? 'API OK' : 'CQ OK', badgeColor: '#3B82F6', actionId: 'ts:status' };
        }
        const count = this.channelId ? this.channelClientCount(this.channelId) : 0;
        return {
            ...base,
            title: this.channelName || 'Sala',
            badge: count > 0 ? String(count) : null,
            badgeColor: '#1D4ED8',
            actionId: `switch:${ROOMS_PROFILE_ID}`
        };
    }

    faderKey() {
        return { title: 'Volume TS', icon: icons.volume, actionId: 'vol_slider:teamspeak', isSlider: true, sliderApp: 'teamspeak' };
    }

    /**
     * Sub-tela de salas (hook getExtraProfile do index.js): 'ts-channels' (página 1) ou 'ts-channels:<n>'.
     * Informativa: entrar na sala não é possível no TS6; tocar numa sala só dá o aviso.
     */
    getExtraProfile(profileId) {
        if (typeof profileId !== 'string' || !profileId.startsWith(ROOMS_PROFILE_ID)) return null;
        const list = this.serverConnected ? this.channelList : [];
        const pages = Math.max(1, Math.ceil(list.length / ROOMS_PER_PAGE));
        let page = 1;
        const suffix = profileId.slice(ROOMS_PROFILE_ID.length);
        if (suffix.startsWith(':')) page = parseInt(suffix.slice(1), 10) || 1;
        page = Math.min(Math.max(1, page), pages);
        const start = (page - 1) * ROOMS_PER_PAGE;

        const keys = [];
        for (let n = 0; n < ROOMS_PER_PAGE; n++) {
            keys.push({ index: n, ...this.channelKey(start + n, n === 0) });
        }

        if (pages > 1) {
            const next = page < pages;
            const target = next ? page + 1 : 1;
            keys.push({
                index: ROOMS_KEY_NAV,
                title: next ? `Próxima (${page}/${pages})` : `Início (${page}/${pages})`,
                icon: icons.grid,
                actionId: `switch:${ROOMS_PROFILE_ID}:${target}`,
                badge: next ? '›' : '«',
                badgeColor: '#4B5563',
                borderColor: '#4F8CFF'
            });
        } else {
            keys.push({ index: ROOMS_KEY_NAV, ...this.statusKey() });
        }
        keys.push({ index: ROOMS_KEY_BACK, title: 'Voltar', icon: icons.teamspeak, actionId: 'switch:teamspeak', borderColor: '#4F8CFF' });

        return { id: page > 1 ? `${ROOMS_PROFILE_ID}:${page}` : ROOMS_PROFILE_ID, name: 'Salas do TeamSpeak', rows: 3, cols: 4, keys, hidden: true, showHardwareHud: false };
    }

    talkingKey() {
        const someoneTalking = this.talkers.size > 0;
        const names = Array.from(this.talkers.values());
        let title;
        if (someoneTalking) title = names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
        else title = this.lastTalker ? `Último: ${this.lastTalker}` : 'Quem fala';
        return {
            title,
            icon: someoneTalking ? icons.talking : icons.user,
            actionId: 'ts:talking',
            bgColor: someoneTalking ? '#16A34A' : '#1C1D25',
            borderColor: someoneTalking ? '#4ADE80' : '#2D303E',
            titleColor: someoneTalking ? '#FFFFFF' : '#9CA3AF',
            badge: someoneTalking ? 'FALANDO' : null,
            badgeColor: '#14532D',
            active: someoneTalking
        };
    }

    refreshVoiceKeys() {
        this.ctx.updateKey('teamspeak', KEY.MIC, this.micKey());
        this.ctx.updateKey('teamspeak', KEY.SOUND, this.soundKey());
        this.ctx.updateKey('teamspeak', KEY.AFK, this.awayKey());
        this.ctx.updateKey('teamspeak', KEY.TALKING, this.talkingKey());
    }

    refreshStatusKeys() {
        if (!this.ctx || typeof this.ctx.updateKey !== 'function') return;
        this.ctx.updateKey('teamspeak', KEY.ROOM, this.roomKey());
        this.ctx.updateKey('teamspeak', KEY.TALKING, this.talkingKey());
        this.refreshExtraScreen();
    }

    getDefinition() {
        const keys = [
            // Linha 1 — voz (Remote Apps: botões virtuais que o usuário vincula nas Key Bindings do TS)
            { index: KEY.MIC, ...this.micKey() },
            { index: KEY.SOUND, ...this.soundKey() },
            { index: KEY.AFK, ...this.awayKey() },
            { index: KEY.PTT, ...this.pttKey() },
            // Linha 2 — sala atual (abre a lista de salas), quem fala, transmissão, volume só do TS
            { index: KEY.ROOM, ...this.roomKey() },
            { index: KEY.TALKING, ...this.talkingKey() },
            { index: KEY.STREAM, ...this.streamKey() },
            { index: KEY.FADER, ...this.faderKey() }
        ];
        return { id: 'teamspeak', name: 'TeamSpeak', rows: 2, cols: 4, keys };
    }

    // ------------------------------------------------------------------
    // Ações
    // ------------------------------------------------------------------

    handleAction(actionId, eventType) {
        if (actionId === 'ts:stream' || actionId === 'ts:talking') return; // teclas informativas
        const cfg = this.getConfig();
        const b = cfg.buttons;

        // PTT e Whisper: por padrão um toque liga e outro desliga (config.teamspeak.pttMode = 'toggle');
        // em 'hold' é segurar para falar (keyDown liga, keyUp desliga).
        if (actionId === 'ts:ptt' || actionId === 'ts:whisper') {
            const isPtt = actionId === 'ts:ptt';
            const held = isPtt ? this.pttHeld : this.whisperHeld;
            const toggleMode = (this.getConfig().pttMode || 'toggle') !== 'hold';
            let next;
            if (toggleMode) {
                if (eventType !== 'keyDown') return;
                next = !held;
            } else {
                if (eventType === 'keyDown' && !held) next = true;
                else if (eventType === 'keyUp' && held) next = false;
                else return;
            }
            if (isPtt) this.pttHeld = next; else this.whisperHeld = next;
            this.sendHold(isPtt ? b.ptt : b.whisper, next);
            if (isPtt) this.ctx.updateKey('teamspeak', KEY.PTT, this.pttKey()); // whisper não está mais na grade
            return;
        }

        if (eventType !== 'keyDown') return;

        if (actionId.startsWith('media:') || actionId.startsWith('launch:') || actionId.startsWith('switch:')) {
            const def = this.ctx.profiles && this.ctx.profiles.get('default');
            if (def) def.handleAction(actionId, eventType);
            return;
        }

        if (actionId.startsWith('ts:channel:')) {
            // presets antigos: o TS6 não permite trocar de canal (nem pela API, nem por link quando conectado)
            this.warnChannelSwitchUnsupported();
            return;
        }

        switch (actionId) {
            case 'ts:mute_mic':
                this.toggle('mic');
                break;
            case 'ts:mute_sound':
                this.toggle('sound');
                break;
            case 'ts:toggle_away':
                this.toggle('away');
                break;
            case 'ts:disconnect':
                if (this.activeMode === 'clientquery') this.cqSend('disconnect');
                else this.pressButton(b.disconnect, true, true);
                break;
            case 'ts:status':
                // Toque no status: reconecta (útil depois de aceitar o prompt ou reabrir o TS)
                this.reconnect();
                break;
            case 'ts:focus':
                SystemActions.focusWindow(TS_WINDOW);
                break;
            case 'ts:open':
                this.openTeamSpeak();
                break;
            default:
                console.log(`[TeamSpeak] Ação desconhecida: ${actionId}`);
        }
    }

    toggle(what) {
        const b = this.getConfig().buttons;
        if (this.activeMode === 'clientquery' && this.authenticated) {
            // ClientQuery: comando direto; o estado real volta por notifyclientupdated
            if (what === 'mic') this.cqSend(`clientupdate client_input_muted=${this.micMuted ? 0 : 1}`);
            else if (what === 'sound') this.cqSend(`clientupdate client_output_muted=${this.soundMuted ? 0 : 1}`);
            else if (what === 'away') this.cqSend(`clientupdate client_away=${this.away ? 0 : 1}`);
            return;
        }
        if (this.activeMode === 'remote' && this.authenticated) {
            // Remote Apps: botão virtual (precisa estar vinculado nas Key Bindings do TS); o estado real volta por clientSelfPropertyUpdated
            this.pressToggleButton(what === 'mic' ? 'mute' : (what === 'sound' ? 'soundMute' : 'afk'));
            return;
        }
        console.log(`[TeamSpeak] "${what}" ignorado: não conectado ao TeamSpeak${this.needsAuthorization ? ' (aguardando autorização no TS)' : ''}`);
        this.refreshStatusKeys();
    }

    sendHold(buttonName, state) {
        if (this.activeMode === 'remote' && this.authenticated) {
            this.pressButton(buttonName, state);
        } else if (this.activeMode === 'clientquery' && this.authenticated && buttonName === this.getConfig().buttons.ptt) {
            // ClientQuery não tem PTT nativo: simula desmutando enquanto segura
            this.cqSend(`clientupdate client_input_muted=${state ? 0 : 1}`);
        }
    }

    /** Abre o TS. Desconectado do servidor, passa ts3server://host?port= para já conectar. Nunca usa teamspeak:// (sem handler no KDE). */
    async openTeamSpeak() {
        const args = [];
        if (!this.serverConnected) {
            const url = this.buildConnectUrl();
            if (url) args.push(url);
        }
        if (await SystemActions.flatpakInstalled(TS_FLATPAK)) {
            return SystemActions.launchFile('flatpak', ['run', TS_FLATPAK, ...args]);
        }
        for (const bin of ['teamspeak', 'TeamSpeak', 'ts3client_linux_amd64']) {
            if (SystemActions.commandExists(bin)) return SystemActions.launchFile(bin, args);
        }
        console.log('[TeamSpeak] Cliente TeamSpeak não encontrado (flatpak com.teamspeak.TeamSpeak, teamspeak, TeamSpeak, ts3client_linux_amd64)');
        this.notify({ level: 'warn', title: 'TeamSpeak', text: 'Cliente TeamSpeak não encontrado neste PC' });
        return false;
    }

    stop() {
        this.stopped = true;
        this.clearTimers();
        for (const b of Object.keys(this.pendingBindings)) clearTimeout(this.pendingBindings[b]);
        this.pendingBindings = {};
        this.closeSockets();
    }
}

module.exports = TeamSpeakProfile;
