/**
 * Controle nativo do Discord pelo socket IPC local (mesma API que o Stream Deck usa).
 *
 * Fluxo: handshake no socket discord-ipc-N -> AUTHENTICATE com o token guardado
 * (ou AUTHORIZE, que abre a janela de consentimento no Discord, uma vez) ->
 * GET_VOICE_SETTINGS + assinatura de VOICE_SETTINGS_UPDATE. Mute/surdo via SET_VOICE_SETTINGS.
 *
 * Precisa de um aplicativo criado pelo usuário no portal de desenvolvedores do Discord
 * (Client ID + Client Secret, redirect http://localhost). Tokens ficam na seção `discord` do config.
 */
const net = require('net');
const path = require('path');
const EventEmitter = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write'];
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const RETRY_MIN_MS = 5 * 1000;
const RETRY_MAX_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;   // janela de consentimento aberta no Discord

class DiscordRpc extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.sock = null;
        this.buffer = Buffer.alloc(0);
        this.pending = new Map();        // nonce -> { resolve, reject, timer }
        this.nonce = 0;
        this.retryMs = RETRY_MIN_MS;
        this.retryTimer = null;
        this.stopped = true;
        this.connected = false;          // handshake aceito (READY)
        this.authenticated = false;
        this.authorizing = false;        // esperando o usuário aceitar no Discord
        this.authDeclined = false;       // usuário recusou: não insistir sozinho
        this.lastError = null;
        this.user = null;
        this.voice = null;               // { mute, deaf, mode }
        this.socketPath = null;
        this.channel = null;             // sala de voz atual { id, name, guildId, guildName }
        this.members = new Map();        // userId -> { id, name, mute, deaf, speaking, me }
    }

    // ------------------------------------------------------------------
    // Configuração
    // ------------------------------------------------------------------

    cfg() {
        return this.config.get('discord') || {};
    }

    hasCredentials() {
        const c = this.cfg();
        return !!(String(c.clientId || '').trim() && String(c.clientSecret || '').trim());
    }

    getStatus() {
        return {
            connected: this.connected,
            authenticated: this.authenticated,
            authorizing: this.authorizing,
            needsSetup: !this.hasCredentials(),
            declined: this.authDeclined,
            error: this.lastError,
            user: this.user ? { id: this.user.id, username: this.user.username } : null,
            voice: this.voice,
            channel: this.channel ? { name: this.channel.name, guild: this.channel.guildName, members: this.members.size } : null,
            socket: this.socketPath
        };
    }

    // ------------------------------------------------------------------
    // Ciclo de vida
    // ------------------------------------------------------------------

    start() {
        this.stopped = false;
        this.config.on('change', (ev) => {
            if (!ev || ev.section !== 'discord') return;
            const c = this.cfg();
            const changedApp = c.clientId !== this._clientId || c.clientSecret !== this._clientSecret;
            if (changedApp) {
                this.authDeclined = false;
                this.reconnect(0);
            }
        });
        this.connect();
    }

    stop() {
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.closeSocket();
    }

    /** Força a janela de autorização (botão em Ajustes). */
    async authorizeNow() {
        if (!this.hasCredentials()) throw new Error('Informe o Client ID e o Client Secret em Ajustes > Discord');
        this.authDeclined = false;
        this.config.set('discord', { accessToken: '', refreshToken: '', tokenExpiresAt: 0 });
        if (!this.connected) {
            this.reconnect(0);
            return { started: true };
        }
        this.authenticated = false;
        await this.login(true);
        return { started: true };
    }

    static candidateSockets() {
        const bases = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp'].filter(Boolean);
        const out = [];
        for (const base of bases) {
            for (let i = 0; i < 10; i++) {
                out.push(path.join(base, `discord-ipc-${i}`));
                out.push(path.join(base, 'app', 'com.discordapp.Discord', `discord-ipc-${i}`));
                out.push(path.join(base, 'snap.discord', `discord-ipc-${i}`));
            }
        }
        return out;
    }

    connect() {
        if (this.stopped || this.sock) return;
        if (!this.hasCredentials()) {
            this.lastError = null;
            this.scheduleRetry(RETRY_MAX_MS);     // espera o usuário preencher as chaves
            return;
        }
        const c = this.cfg();
        this._clientId = c.clientId;
        this._clientSecret = c.clientSecret;
        this.tryNext(DiscordRpc.candidateSockets(), 0);
    }

    tryNext(paths, i) {
        if (this.stopped) return;
        if (i >= paths.length) {
            this.lastError = 'Discord não está aberto (socket IPC não encontrado)';
            this.scheduleRetry();
            return;
        }
        const p = paths[i];
        const sock = net.createConnection(p);
        let settled = false;
        sock.once('connect', () => {
            settled = true;
            this.socketPath = p;
            this.attach(sock);
        });
        sock.once('error', () => {
            if (settled) return;
            settled = true;
            sock.destroy();
            this.tryNext(paths, i + 1);
        });
    }

    attach(sock) {
        this.sock = sock;
        this.buffer = Buffer.alloc(0);
        sock.on('data', (chunk) => this.onData(chunk));
        sock.on('error', (e) => { this.lastError = e.message; });
        sock.on('close', () => this.onClose());
        this.send(OP.HANDSHAKE, { v: 1, client_id: String(this._clientId).trim() });
    }

    closeSocket() {
        if (this.sock) {
            // Fechamento intencional: sem o 'close' do socket, senão onClose agenda outra reconexão por cima
            const s = this.sock;
            this.sock = null;
            s.removeAllListeners();
            s.on('error', () => {});
            try { s.destroy(); } catch (e) { /* já fechado */ }
        }
        this.connected = false;
        this.authenticated = false;
        this.authorizing = false;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('conexão com o Discord encerrada')); }
        this.pending.clear();
    }

    onClose() {
        const was = this.authenticated;
        this.closeSocket();
        this.voice = null;
        this.setChannel(null);
        if (was) console.log('[Discord] Conexão IPC encerrada');
        this.emit('change');
        this.scheduleRetry();
    }

    reconnect(delayMs) {
        this.closeSocket();
        this.voice = null;
        this.channel = null;
        this.members.clear();
        this.emit('change');
        this.emit('channel');
        this.scheduleRetry(delayMs);
    }

    scheduleRetry(ms) {
        if (this.stopped) return;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        const wait = ms !== undefined ? ms : this.retryMs;
        this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, wait);
    }

    // ------------------------------------------------------------------
    // Protocolo (cabeçalho de 8 bytes: opcode + tamanho, little-endian, depois JSON)
    // ------------------------------------------------------------------

    send(op, payload) {
        if (!this.sock) return;
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const head = Buffer.alloc(8);
        head.writeInt32LE(op, 0);
        head.writeInt32LE(body.length, 4);
        this.sock.write(Buffer.concat([head, body]));
    }

    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 8) {
            const op = this.buffer.readInt32LE(0);
            const len = this.buffer.readInt32LE(4);
            if (this.buffer.length < 8 + len) return;
            const raw = this.buffer.subarray(8, 8 + len).toString('utf8');
            this.buffer = this.buffer.subarray(8 + len);
            let msg = null;
            try { msg = JSON.parse(raw); } catch (e) { continue; }
            this.onFrame(op, msg);
        }
    }

    onFrame(op, msg) {
        if (op === OP.PING) { this.send(OP.PONG, msg); return; }
        if (op === OP.CLOSE) {
            this.lastError = (msg && msg.message) || 'fechado pelo Discord';
            console.log(`[Discord] IPC fechado: ${this.lastError}`);
            return;
        }
        if (op !== OP.FRAME || !msg) return;

        if (msg.nonce && this.pending.has(msg.nonce)) {
            const p = this.pending.get(msg.nonce);
            this.pending.delete(msg.nonce);
            clearTimeout(p.timer);
            if (msg.evt === 'ERROR') {
                const err = new Error(/redirect_uri/i.test((msg.data && msg.data.message) || '') ? `${msg.data.message}; cadastre o redirect ${this.redirectUri()} em OAuth2 > Redirects no portal do Discord` : ((msg.data && msg.data.message) || 'erro do Discord'));
                err.code = msg.data && msg.data.code;
                p.reject(err);
            } else {
                p.resolve(msg.data);
            }
            return;
        }

        if (msg.cmd === 'DISPATCH') {
            if (msg.evt === 'READY') {
                this.connected = true;
                this.retryMs = RETRY_MIN_MS;
                this.lastError = null;
                console.log(`[Discord] IPC conectado em ${this.socketPath}`);
                this.emit('change');
                this.login(false).catch((e) => {
                    this.lastError = e.message;
                    console.log(`[Discord] Autenticação falhou: ${e.message}`);
                    this.emit('change');
                });
            } else if (msg.evt === 'VOICE_SETTINGS_UPDATE') {
                this.applyVoice(msg.data);
            } else if (msg.evt === 'VOICE_CHANNEL_SELECT') {
                this.loadChannel().catch((e) => console.log(`[Discord] Sala de voz: ${e.message}`));
            } else if (msg.evt === 'VOICE_STATE_CREATE' || msg.evt === 'VOICE_STATE_UPDATE') {
                this.upsertMember(msg.data);
            } else if (msg.evt === 'VOICE_STATE_DELETE') {
                const id = msg.data && msg.data.user && msg.data.user.id;
                if (id && this.members.delete(id)) this.emit('channel');
            } else if (msg.evt === 'SPEAKING_START' || msg.evt === 'SPEAKING_STOP') {
                const m = msg.data && this.members.get(msg.data.user_id);
                const speaking = msg.evt === 'SPEAKING_START';
                if (m && m.speaking !== speaking) { m.speaking = speaking; this.emit('channel'); }
            }
        }
    }

    request(cmd, args, evt, timeoutMs = REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            if (!this.sock) return reject(new Error('Discord não conectado'));
            const nonce = `md-${Date.now()}-${++this.nonce}`;
            const timer = setTimeout(() => {
                this.pending.delete(nonce);
                reject(new Error(`sem resposta do Discord para ${cmd}`));
            }, timeoutMs);
            this.pending.set(nonce, { resolve, reject, timer });
            const payload = { cmd, args: args || {}, nonce };
            if (evt) payload.evt = evt;
            this.send(OP.FRAME, payload);
        });
    }

    // ------------------------------------------------------------------
    // OAuth
    // ------------------------------------------------------------------

    async login(forceAuthorize) {
        const c = this.cfg();
        let token = forceAuthorize ? '' : String(c.accessToken || '');
        if (token && c.tokenExpiresAt && Date.now() > Number(c.tokenExpiresAt) - 60 * 1000 && c.refreshToken) {
            token = await this.refreshToken(c.refreshToken).catch(() => '');
        }
        if (token) {
            try {
                await this.authenticate(token);
                return;
            } catch (e) {
                console.log(`[Discord] Token guardado recusado (${e.message}); tentando renovar`);
                if (c.refreshToken) token = await this.refreshToken(c.refreshToken).catch(() => '');
                if (token) { await this.authenticate(token); return; }
            }
        }
        if (this.authDeclined && !forceAuthorize) {
            this.lastError = 'autorização recusada no Discord: use "Autorizar" em Ajustes > Discord';
            this.emit('change');
            return;
        }
        await this.authorize();
    }

    async authorize() {
        this.authorizing = true;
        this.lastError = null;
        this.emit('change');
        console.log('[Discord] Pedindo autorização: aceite a janela que abriu no Discord');
        let code;
        try {
            // Sem redirect_uri aqui: o fluxo RPC usa o primeiro redirect cadastrado no aplicativo
            // (sem nenhum cadastrado o Discord responde "Missing redirect_uri"; passando um, recusa o parâmetro)
            const data = await this.request('AUTHORIZE', { client_id: String(this._clientId).trim(), scopes: SCOPES }, null, AUTHORIZE_TIMEOUT_MS);
            code = data && data.code;
        } catch (e) {
            this.authorizing = false;
            // Só "recusado" quando o usuário negou; erro de configuração fica visível e tenta de novo na reconexão
            this.authDeclined = /denied|cancel|recus/i.test(e.message) || /sem resposta/.test(e.message);
            throw new Error(`autorização não concedida (${e.message})`);
        }
        this.authorizing = false;
        if (!code) throw new Error('Discord não devolveu o código de autorização');
        const token = await this.exchange({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri() });
        await this.authenticate(token);
    }

    redirectUri() {
        return String(this.cfg().redirectUri || 'http://localhost').trim();
    }

    async exchange(params) {
        const c = this.cfg();
        const body = new URLSearchParams({ client_id: String(c.clientId).trim(), client_secret: String(c.clientSecret).trim(), ...params });
        const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        const json = await r.json().catch(() => ({}));
        if (!r.ok || !json.access_token) {
            throw new Error(`troca de token falhou (${r.status}): ${json.error_description || json.error || 'sem detalhe'}`);
        }
        this.config.set('discord', {
            accessToken: json.access_token,
            refreshToken: json.refresh_token || '',
            tokenExpiresAt: Date.now() + (Number(json.expires_in) || 0) * 1000
        });
        return json.access_token;
    }

    refreshToken(refreshToken) {
        return this.exchange({ grant_type: 'refresh_token', refresh_token: refreshToken });
    }

    async authenticate(token) {
        const data = await this.request('AUTHENTICATE', { access_token: token });
        this.user = data && data.user ? data.user : null;
        this.authenticated = true;
        this.authDeclined = false;
        this.lastError = null;
        console.log(`[Discord] Autenticado${this.user ? ' como ' + this.user.username : ''}`);
        this.emit('change');
        const voice = await this.request('GET_VOICE_SETTINGS', {});
        this.applyVoice(voice);
        await this.request('SUBSCRIBE', {}, 'VOICE_SETTINGS_UPDATE');
        await this.request('SUBSCRIBE', {}, 'VOICE_CHANNEL_SELECT');
        await this.loadChannel();
    }

    // ------------------------------------------------------------------
    // Sala de voz (quem está comigo, quem fala)
    // ------------------------------------------------------------------

    static CHANNEL_EVENTS = ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP'];

    /** Lê a sala de voz selecionada e (re)assina os eventos dela. */
    async loadChannel() {
        if (!this.ready) return;
        const ch = await this.request('GET_SELECTED_VOICE_CHANNEL', {});
        if (!ch || !ch.id) { await this.setChannel(null); return; }
        if (this.channel && this.channel.id === ch.id) {
            this.replaceMembers(ch.voice_states);
            return;
        }
        await this.setChannel({ id: ch.id, name: ch.name || 'Sala de voz', guildId: ch.guild_id || null, guildName: null });
        this.replaceMembers(ch.voice_states);
        for (const evt of DiscordRpc.CHANNEL_EVENTS) {
            await this.request('SUBSCRIBE', { channel_id: ch.id }, evt).catch((e) => console.log(`[Discord] Sem assinatura de ${evt}: ${e.message}`));
        }
        if (ch.guild_id) {
            this.request('GET_GUILD', { guild_id: ch.guild_id }).then((g) => {
                if (g && g.name && this.channel && this.channel.id === ch.id) { this.channel.guildName = g.name; this.emit('channel'); }
            }).catch(() => { /* nome do servidor é só enfeite */ });
        }
        console.log(`[Discord] Sala de voz: ${ch.name} (${this.members.size} na sala)`);
    }

    async setChannel(next) {
        const prev = this.channel;
        if (prev && this.sock && this.authenticated && (!next || next.id !== prev.id)) {
            for (const evt of DiscordRpc.CHANNEL_EVENTS) {
                await this.request('UNSUBSCRIBE', { channel_id: prev.id }, evt).catch(() => { /* Discord pode já ter descartado */ });
            }
        }
        this.channel = next;
        if (!next) this.members.clear();
        if (!next && prev) console.log('[Discord] Saiu da sala de voz');
        this.emit('channel');
    }

    memberFrom(vs) {
        if (!vs || !vs.user || !vs.user.id) return null;
        const st = vs.voice_state || {};
        const prev = this.members.get(vs.user.id);
        return {
            id: vs.user.id,
            name: vs.nick || vs.user.global_name || vs.user.username || '?',
            mute: !!(st.mute || st.self_mute || st.suppress),
            deaf: !!(st.deaf || st.self_deaf),
            speaking: prev ? prev.speaking : false,
            me: !!(this.user && this.user.id === vs.user.id)
        };
    }

    replaceMembers(list) {
        const next = new Map();
        for (const vs of Array.isArray(list) ? list : []) {
            const m = this.memberFrom(vs);
            if (m) next.set(m.id, m);
        }
        this.members = next;
        this.emit('channel');
    }

    upsertMember(vs) {
        const m = this.memberFrom(vs);
        if (!m || !this.channel) return;
        this.members.set(m.id, m);
        this.emit('channel');
    }

    /** Foto da sala para as teclas: eu primeiro, depois quem fala, depois por nome. */
    roomSnapshot() {
        if (!this.ready) return { available: false, inVoice: false, members: [] };
        if (!this.channel) return { available: true, inVoice: false, members: [] };
        const members = Array.from(this.members.values()).sort((a, b) => (b.me - a.me) || (b.speaking - a.speaking) || a.name.localeCompare(b.name));
        return { available: true, inVoice: true, channelName: this.channel.name, guildName: this.channel.guildName, members };
    }

    // ------------------------------------------------------------------
    // Voz
    // ------------------------------------------------------------------

    applyVoice(data) {
        if (!data || typeof data !== 'object') return;
        const next = {
            mute: !!data.mute,
            deaf: !!data.deaf,
            mode: data.mode && data.mode.type ? String(data.mode.type) : null
        };
        const changed = !this.voice || this.voice.mute !== next.mute || this.voice.deaf !== next.deaf || this.voice.mode !== next.mode;
        this.voice = next;
        if (changed) this.emit('voice', next);
    }

    get ready() {
        return this.connected && this.authenticated;
    }

    async setMute(mute) {
        const v = await this.request('SET_VOICE_SETTINGS', { mute: !!mute });
        this.applyVoice(v);
        return this.voice;
    }

    async setDeaf(deaf) {
        const v = await this.request('SET_VOICE_SETTINGS', { deaf: !!deaf });
        this.applyVoice(v);
        return this.voice;
    }
}

module.exports = DiscordRpc;
