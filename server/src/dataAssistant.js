/**
 * Data, a assistente de voz (servidor aiohttp local do projeto "sexta-feira"), para as teclas `data:*`.
 *
 * Estado em tempo real pelo WebSocket ws://<url>/ws (`hello` na conexão, `state` a cada mudança de status e
 * `status` quando o snapshot muda), com reconexão em backoff exponencial (1 s → 30 s). Enquanto o WS estiver
 * fora, sonda GET /api/state a cada 5 s; com ele no ar faz uma conferência a cada 30 s. Comandos por HTTP:
 * /api/listen (toggle da escuta), /api/stop (interromper) e /api/wake (escuta livre).
 *
 * "Data: falar": toque curto alterna a escuta (POST /api/listen {action:'toggle'}); segurar a tecla mais que
 * HOLD_MS interrompe a fala/resposta em andamento (POST /api/stop) e o soltar não dispara nada.
 */
const EventEmitter = require('events');

let WebSocket = null;
try { WebSocket = require('ws'); } catch (e) { /* sem o pacote: só a sondagem HTTP */ }

const DEFAULT_URL = 'http://127.0.0.1:8765';
const POLL_MS = 5000;             // sondagem enquanto o WebSocket está fora
const SYNC_MS = 30000;            // conferência com o WebSocket no ar
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const REQ_TIMEOUT_MS = 4000;
const HOLD_MS = 600;              // segurou mais que isso = interromper (POST /api/stop)

const GRAY = '#6B7280';           // offline
const NEUTRAL = '#64748B';        // idle: selo discreto, sem fundo nem borda
const BLUE = '#3B82F6';
const GREEN = '#16A34A';
const RED = '#DC2626';
const AMBER = '#F59E0B';
const LISTEN_BG = '#B91C1C';      // fundo da tecla ouvindo (não é o #DC2626 que o deck trata como "mutado")

const STATUS_LABEL = { idle: 'PRONTA', listening: 'OUVINDO', transcribing: 'TRANSCREVENDO', thinking: 'PENSANDO', speaking: 'FALANDO' };
const STATUS_COLOR = { idle: NEUTRAL, listening: RED, transcribing: AMBER, thinking: AMBER, speaking: GREEN };
const STATUS_BORDER = { idle: undefined, listening: '#F87171', transcribing: '#FBBF24', thinking: '#FBBF24', speaking: '#22C55E' };

const EMPTY_STATE = Object.freeze({
    online: false,
    status: 'offline',          // idle | listening | transcribing | thinking | speaking (o que a Data informar)
    detail: '',
    version: '',
    wake: Object.freeze({ enabled: false, word: '' }),
    brain: Object.freeze({ ok: false, provider: '', label: '', model: '', error: '' }),
    stt: Object.freeze({ loaded: false, loading: false, model: '', error: '' })
});

const str = (v, fallback = '') => (typeof v === 'string' ? v : (v === null || v === undefined ? fallback : String(v)));

/** Mescla um payload da Data (hello, state, status, GET /api/state, resposta do /api/wake) sobre o estado anterior. */
function applyPayload(prev, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const next = { ...prev, online: true };
    if (typeof p.status === 'string') next.status = p.status;
    if ('detail' in p) next.detail = str(p.detail);
    if (typeof p.version === 'string') next.version = p.version;
    if (p.wake && typeof p.wake === 'object') {
        next.wake = { enabled: !!p.wake.enabled, word: str(p.wake.word, prev.wake.word) };
    }
    if (p.brain && typeof p.brain === 'object') {
        next.brain = { ok: !!p.brain.ok, provider: str(p.brain.provider), label: str(p.brain.label), model: str(p.brain.model), error: str(p.brain.error) };
    }
    if (p.stt && typeof p.stt === 'object') {
        next.stt = { loaded: !!p.stt.loaded, loading: !!p.stt.loading, model: str(p.stt.model), error: str(p.stt.error) };
    }
    return next;
}

/** Aparência de uma tecla `data:*` para o estado dado (campos do updateKey; undefined = mantém o da tecla). */
function keyStateFor(actionId, s) {
    const state = s || EMPTY_STATE;
    const online = !!state.online;
    const status = online ? str(state.status, 'idle') : 'offline';
    const label = online ? (STATUS_LABEL[status] || status.toUpperCase()) : 'OFF';
    const color = online ? (STATUS_COLOR[status] || NEUTRAL) : GRAY;
    const border = online ? (status in STATUS_BORDER ? STATUS_BORDER[status] : undefined) : GRAY;
    const listening = online && status === 'listening';
    const busy = online && (status === 'speaking' || status === 'thinking' || status === 'transcribing');
    const wakeOn = online && !!state.wake.enabled;

    switch (actionId) {
        case 'data:talk':
            return { badge: label, badgeColor: color, active: listening, pulse: listening, bgColor: listening ? LISTEN_BG : undefined, borderColor: border };
        case 'data:stop':
            return { badge: busy ? label : (online ? null : 'OFF'), badgeColor: busy ? color : GRAY, active: busy, borderColor: busy ? border : (online ? undefined : GRAY) };
        case 'data:wake':
            return { badge: online ? (wakeOn ? 'ON' : 'OFF') : 'n/d', badgeColor: wakeOn ? BLUE : GRAY, active: wakeOn, borderColor: wakeOn ? BLUE : (online ? undefined : GRAY) };
        case 'data:status': {
            const base = { statMode: 'meters', statHead: label, statColor: color, statBig: null, statSub: null, statPercent: null, badge: null, active: listening, borderColor: border };
            if (!online) {
                return { ...base, statRows: [{ k: 'offline', v: '', sub: 'servidor da Data fora do ar', pct: 0, color: GRAY }] };
            }
            const { brain, wake, stt } = state;
            const sttText = stt.loaded ? 'OK' : (stt.loading ? 'CARREGANDO' : (stt.error ? 'ERRO' : 'OFF'));
            return {
                ...base,
                statRows: [
                    { k: 'Cérebro', v: brain.ok ? 'OK' : 'ERRO', sub: brain.ok ? (brain.label || brain.provider) : (brain.error || brain.label || 'sem resposta'), pct: brain.ok ? 100 : 0, color: brain.ok ? GREEN : RED },
                    { k: 'Escuta livre', v: wake.enabled ? 'ON' : 'OFF', sub: wake.word ? `"${wake.word}"` : '', pct: wake.enabled ? 100 : 0, color: wake.enabled ? BLUE : GRAY },
                    { k: 'STT', v: sttText, sub: stt.model || stt.error || '', pct: stt.loaded ? 100 : (stt.loading ? 50 : 0), color: stt.loaded ? GREEN : (stt.loading ? AMBER : (stt.error ? RED : GRAY)) }
                ]
            };
        }
        default:
            return null;
    }
}

class DataAssistant extends EventEmitter {
    /**
     * @param {object} config  ConfigStore (seção `data`: { url }); opcional
     * @param {object} opts    { fetch, holdMs, pollMs, reconnectMinMs } para testes sem rede/tempo real
     */
    constructor(config, opts = {}) {
        super();
        this.config = config;
        this.fetch = opts.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
        this.holdMs = opts.holdMs || HOLD_MS;
        this.pollMs = opts.pollMs || POLL_MS;
        this.syncMs = opts.syncMs || SYNC_MS;
        this.reconnectMinMs = opts.reconnectMinMs || RECONNECT_MIN_MS;
        this.state = { ...EMPTY_STATE };
        this.ws = null;
        this.wsOpen = false;
        this.timer = null;
        this.reconnectTimer = null;
        this.reconnectMs = this.reconnectMinMs;
        this.stopped = true;
        this.holdTimer = null;
        this.holdFired = false;
        this.loggedOffline = false;
    }

    settings() {
        let cfg = {};
        try { cfg = (this.config && this.config.get('data')) || {}; } catch (e) { /* padrões */ }
        return { url: str(cfg.url).trim() || DEFAULT_URL };
    }

    baseUrl() {
        return (process.env.MATDECK_DATA_URL || this.settings().url).replace(/\/+$/, '');
    }

    wsUrl() {
        const u = new URL('/ws', this.baseUrl() + '/');
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        return u.toString();
    }

    snapshot() {
        return JSON.parse(JSON.stringify(this.state));
    }

    /** Aparência atual de uma tecla `data:*` (null para ações desconhecidas). */
    stateFor(actionId) {
        return keyStateFor(actionId, this.state);
    }

    // ------------------------------------------------------------------
    // Ciclo de vida
    // ------------------------------------------------------------------

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        this.connect();
        this.refresh();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer); this.timer = null;
        clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
        this.clearHold();
        this.closeWs();
    }

    /** Endereço mudou (Ajustes): derruba o WS e conecta de novo no novo endereço. */
    reconnect() {
        if (this.stopped) return;
        this.closeWs();
        clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
        this.reconnectMs = this.reconnectMinMs;
        this.markOffline();
        this.connect();
        this.refresh();
    }

    closeWs() {
        const ws = this.ws;
        this.ws = null;
        this.wsOpen = false;
        if (ws) { try { ws.removeAllListeners(); if (ws.terminate) ws.terminate(); else ws.close(); } catch (e) { /* já fechado */ } }
    }

    connect() {
        if (this.stopped || !WebSocket || this.ws) return;
        let ws;
        try { ws = new WebSocket(this.wsUrl(), { handshakeTimeout: REQ_TIMEOUT_MS }); } catch (e) { this.scheduleReconnect(); return; }
        this.ws = ws;
        ws.on('open', () => {
            if (ws !== this.ws) return;
            this.wsOpen = true;
            this.reconnectMs = this.reconnectMinMs;
            this.schedulePoll();
        });
        ws.on('message', (raw) => {
            if (ws !== this.ws) return;
            let msg = null;
            try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'config') {
                // mudança de configuração (a escuta livre pode ter sido ligada/desligada): confere o snapshot
                this.refresh();
                return;
            }
            // hello / state / status (e qualquer outro evento com esses campos); o resto é ignorado
            if ('status' in msg || 'wake' in msg || 'brain' in msg || 'stt' in msg) this.setState(applyPayload(this.state, msg));
        });
        ws.on('error', () => { /* o close trata */ });
        ws.on('close', () => {
            if (ws !== this.ws) return;
            this.ws = null;
            this.wsOpen = false;
            this.scheduleReconnect();
            this.schedulePoll();
        });
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        const ms = this.reconnectMs;
        this.reconnectMs = Math.min(RECONNECT_MAX_MS, this.reconnectMs * 2);
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, ms);
        if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    }

    /** Sondagem HTTP: a cada 5 s sem o WS (a Data pode ter caído), a cada 30 s com ele (conferência). */
    schedulePoll() {
        if (this.stopped) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, this.wsOpen ? this.syncMs : this.pollMs);
        if (this.timer.unref) this.timer.unref();
    }

    async refresh() {
        if (this.stopped) return;
        try {
            const json = await this.request('GET', '/api/state');
            if (!this.stopped) this.setState(applyPayload(this.state, json));
        } catch (e) {
            this.markOffline();
            this.logOffline();   // também na primeira sondagem (já nasce offline): um aviso por queda, sem repetir
        }
        this.schedulePoll();
    }

    markOffline() {
        if (!this.state.online) return;
        this.setState({ ...EMPTY_STATE });
    }

    logOffline() {
        if (this.loggedOffline) return;
        this.loggedOffline = true;
        console.warn(`[Data] Assistente fora do ar (${this.baseUrl()}); tentando de novo em segundo plano`);
    }

    setState(next) {
        const before = JSON.stringify(this.state);
        if (JSON.stringify(next) === before) return;
        if (next.online !== this.state.online) {
            if (next.online) { console.log(`[Data] Assistente no ar em ${this.baseUrl()} (${next.version || 'versão ?'})`); this.loggedOffline = false; }
            else this.logOffline();
        }
        this.state = next;
        this.emit('change', this.snapshot());
    }

    // ------------------------------------------------------------------
    // Comandos
    // ------------------------------------------------------------------

    async request(method, path, body) {
        if (!this.fetch) throw new Error('fetch indisponível (Node 18+)');
        const init = { method, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) };
        if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
        const res = await this.fetch(this.baseUrl() + path, init);
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* não é JSON */ }
        if (!res.ok) throw new Error(`HTTP ${res.status}${json && json.error ? ` (${json.error})` : ''}`);
        return json;
    }

    /** POST /api/listen: 'toggle' alterna a escuta, 'start' começa, 'stop' encerra. O novo status chega pelo WS. */
    async listen(action = 'toggle') {
        return this.request('POST', '/api/listen', { action });
    }

    /** POST /api/stop: interrompe a fala/resposta atual. */
    async interrupt() {
        return this.request('POST', '/api/stop');
    }

    /** POST /api/wake: liga/desliga a escuta livre (sem argumento, alterna). A resposta traz o snapshot novo. */
    async toggleWake(enabled) {
        const r = await this.request('POST', '/api/wake', enabled === undefined ? {} : { enabled: !!enabled });
        if (r && typeof r === 'object' && r.wake && typeof r.wake === 'object') this.setState(applyPayload(this.state, r));
        else this.refresh();
        return r;
    }

    clearHold() {
        if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    }

    /** "Data: falar" pressionada: arma o "segurar para interromper". */
    talkDown() {
        this.clearHold();
        this.holdFired = false;
        this.holdTimer = setTimeout(() => {
            this.holdTimer = null;
            this.holdFired = true;
            this.interrupt().catch(e => console.warn(`[Data] Falha ao interromper: ${e.message}`));
        }, this.holdMs);
        return Promise.resolve(null);
    }

    /** "Data: falar" solta: toque curto alterna a escuta; se já interrompeu por segurar, não faz nada. */
    talkUp() {
        const fired = this.holdFired;
        this.clearHold();
        this.holdFired = false;
        return fired ? Promise.resolve(null) : this.listen('toggle');
    }

    /** Ação de tecla `data:*` (keyDown / keyUp); devolve uma Promise. */
    handleAction(actionId, eventType) {
        const down = eventType === 'keyDown';
        switch (actionId) {
            case 'data:talk': return down ? this.talkDown() : this.talkUp();
            case 'data:stop': return down ? this.interrupt() : Promise.resolve(null);
            case 'data:wake':
            case 'data:status': return down ? this.toggleWake() : Promise.resolve(null);
            default: return Promise.resolve(null);
        }
    }
}

DataAssistant.keyStateFor = keyStateFor;
DataAssistant.applyPayload = applyPayload;
DataAssistant.EMPTY_STATE = EMPTY_STATE;
DataAssistant.HOLD_MS = HOLD_MS;
DataAssistant.DEFAULT_URL = DEFAULT_URL;

module.exports = DataAssistant;
