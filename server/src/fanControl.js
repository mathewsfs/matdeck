/**
 * Ventoinhas do PC via CoolerControl (daemon coolercontrold, API REST em 127.0.0.1:11987).
 *
 * O daemon roda como root e já conhece os chips de PWM (nct67xx etc.), então não precisamos
 * de sudo nem de escrever no sysfs. A API v5 exige um "access token" (criado na GUI do
 * CoolerControl); usamos o de Ajustes → Ventoinhas ou, se vazio, o que a GUI guarda em
 * ~/.config/org.coolercontrol.CoolerControl/CoolerControl.conf.
 *
 * O fader "fans" aplica a mesma velocidade fixa em todas as ventoinhas controláveis (bombas
 * de water cooler são excluídas por nome). Um toque devolve cada canal ao perfil/curva que
 * tinha antes do controle manual (guardado em config.fans.restore).
 */
const EventEmitter = require('events');
const https = require('https');
const http = require('http');
const { exec } = require('./hostExec');

const POLL_MS = 2000;
const DEVICES_TTL_MS = 60 * 1000;
const WRITE_THROTTLE_MS = 250;
const REQ_TIMEOUT_MS = 2500;

const DEFAULTS = {
    enabled: true,
    host: '127.0.0.1',
    port: 11987,
    token: '',                 // vazio = usa o token da GUI do CoolerControl
    excludePattern: 'pump|bomba|aio',  // canais cujo rótulo casa aqui nunca são tocados
    minPercent: 20,            // piso de segurança do fader
    restore: {}                // "<deviceUid>/<channel>" -> profile_uid anterior ao manual
};

class FanControl extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.timer = null;
        this.polling = false;
        this.token = null;
        this.tokenTriedAt = 0;
        this.scheme = 'https';
        this.devices = null;        // cache de GET /devices
        this.devicesAt = 0;
        this.channels = [];         // [{ deviceUid, deviceName, name, label, duty, rpm, manual, speedFixed, profileUid }]
        this.available = false;
        this.lastError = '';
        this.percent = 50;          // valor atual do fader (média das ventoinhas ou último definido)
        this.manual = false;
        this.pendingPercent = null;
        this.writeTimer = null;
    }

    settings() {
        let cfg = {};
        try { cfg = (this.config && this.config.get('fans')) || {}; } catch (e) { /* defaults */ }
        return { ...DEFAULTS, ...cfg };
    }

    start() {
        if (this.timer || !this.settings().enabled) return;
        this.schedule(500);
        console.log('[Fans] Integração com CoolerControl iniciada');
    }

    stop() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    schedule(ms) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.poll(), ms);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    // ------------------------------------------------------------------
    // Token e HTTP
    // ------------------------------------------------------------------

    async resolveToken() {
        const cfgTok = String(this.settings().token || '').trim();
        if (cfgTok) return cfgTok;
        if (this.token) return this.token;
        if (Date.now() - this.tokenTriedAt < 30 * 1000) return null;
        this.tokenTriedAt = Date.now();
        const text = await new Promise((resolve) => {
            exec('cat "$HOME/.config/org.coolercontrol.CoolerControl/CoolerControl.conf" 2>/dev/null', { timeout: 3000 }, (err, stdout) => resolve(String(stdout || '')));
        });
        const m = /daemonAccessTokens\][^[]*?=@ByteArray\(([^)]+)\)/.exec(text) || /=@ByteArray\((cc_[A-Za-z0-9]+)\)/.exec(text);
        if (m) { this.token = m[1].trim(); console.log('[Fans] Token do CoolerControl lido da configuração da GUI'); }
        return this.token;
    }

    request(method, path, body, scheme = this.scheme) {
        return new Promise((resolve, reject) => {
            const { host, port } = this.settings();
            const lib = scheme === 'https' ? https : http;
            const data = body === undefined ? null : JSON.stringify(body);
            const req = lib.request({
                host, port, path, method,
                rejectUnauthorized: false,        // certificado autoassinado do daemon
                timeout: REQ_TIMEOUT_MS,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    Accept: 'application/json',
                    ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
                }
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try { json = text ? JSON.parse(text) : null; } catch (e) { /* texto */ }
                    resolve({ status: res.statusCode, json, text });
                });
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
            if (data) req.write(data);
            req.end();
        });
    }

    /** Tenta https e, se a conexão TLS falhar, http (o daemon aceita os dois conforme a configuração). */
    async api(method, path, body) {
        try {
            return await this.request(method, path, body, this.scheme);
        } catch (e) {
            const other = this.scheme === 'https' ? 'http' : 'https';
            const r = await this.request(method, path, body, other);
            this.scheme = other;
            return r;
        }
    }

    // ------------------------------------------------------------------
    // Leitura
    // ------------------------------------------------------------------

    async poll() {
        if (this.polling) return;
        this.polling = true;
        try {
            this.token = await this.resolveToken();
            if (!this.token) throw new Error('sem token do CoolerControl (crie um na GUI ou informe em Ajustes)');
            await this.refreshDevices();
            await this.refreshStatus();
            if (!this.available) { this.available = true; this.lastError = ''; console.log(`[Fans] CoolerControl conectado: ${this.channels.map(c => c.label).join(', ') || 'nenhuma ventoinha controlável'}`); }
            this.emit('change', this.state());
        } catch (e) {
            const msg = e.message || String(e);
            if (this.available || this.lastError !== msg) console.warn('[Fans] CoolerControl indisponível:', msg);
            this.available = false;
            this.lastError = msg;
            this.emit('change', this.state());
        } finally {
            this.polling = false;
            this.schedule(this.available ? POLL_MS : POLL_MS * 5);
        }
    }

    async refreshDevices() {
        if (this.devices && Date.now() - this.devicesAt < DEVICES_TTL_MS) return;
        const r = await this.api('GET', '/devices');
        if (r.status === 401) throw new Error('token recusado pelo CoolerControl');
        if (r.status !== 200 || !r.json) throw new Error(`GET /devices -> HTTP ${r.status}`);
        const exclude = new RegExp(this.settings().excludePattern || '(?!)', 'i');
        const channels = [];
        for (const dev of r.json.devices || []) {
            const chans = (dev.info && dev.info.channels) || {};
            for (const [name, info] of Object.entries(chans)) {
                const so = info && info.speed_options;
                if (!so || so.fixed_enabled === false) continue;
                const label = (info.label || name).trim();
                if (exclude.test(label) || exclude.test(name)) continue;
                channels.push({ deviceUid: dev.uid, deviceName: dev.name, name, label, minDuty: so.min_duty || 0, maxDuty: so.max_duty || 100, duty: null, rpm: null, manual: false, speedFixed: null, profileUid: null });
            }
        }
        // Mantém leituras já conhecidas
        for (const c of channels) {
            const old = this.channels.find(o => o.deviceUid === c.deviceUid && o.name === c.name);
            if (old) Object.assign(c, { duty: old.duty, rpm: old.rpm, manual: old.manual, speedFixed: old.speedFixed, profileUid: old.profileUid });
        }
        this.channels = channels;
        this.devices = r.json.devices || [];
        this.devicesAt = Date.now();
    }

    async refreshStatus() {
        if (!this.channels.length) return;
        const r = await this.api('POST', '/status', { all: false });
        if (r.status !== 200 || !r.json) throw new Error(`POST /status -> HTTP ${r.status}`);
        for (const dev of r.json.devices || []) {
            const hist = dev.status_history || [];
            const last = hist[hist.length - 1];
            if (!last) continue;
            for (const ch of last.channels || []) {
                const c = this.channels.find(x => x.deviceUid === dev.uid && x.name === ch.name);
                if (c) { c.duty = typeof ch.duty === 'number' ? Math.round(ch.duty) : c.duty; c.rpm = typeof ch.rpm === 'number' ? ch.rpm : c.rpm; }
            }
        }
        // Modo de cada canal (manual x perfil), um GET por dispositivo com ventoinhas
        for (const uid of new Set(this.channels.map(c => c.deviceUid))) {
            const s = await this.api('GET', `/devices/${uid}/settings`);
            if (s.status !== 200 || !s.json) continue;
            for (const c of this.channels.filter(x => x.deviceUid === uid)) {
                const st = (s.json.settings || []).find(x => x.channel_name === c.name);
                c.manual = !!(st && typeof st.speed_fixed === 'number');
                c.speedFixed = c.manual ? st.speed_fixed : null;
                c.profileUid = st && st.profile_uid ? st.profile_uid : null;
            }
        }
        this.manual = this.channels.some(c => c.manual);
        if (this.pendingPercent === null) {
            const src = this.manual ? this.channels.filter(c => c.manual).map(c => c.speedFixed) : this.channels.map(c => c.duty).filter(v => typeof v === 'number');
            if (src.length) this.percent = Math.round(src.reduce((a, b) => a + b, 0) / src.length);
        }
    }

    state() {
        return {
            available: this.available,
            error: this.available ? '' : this.lastError,
            manual: this.manual,
            percent: this.percent,
            channels: this.channels.map(c => ({ label: c.label, name: c.name, duty: c.duty, rpm: c.rpm, manual: c.manual }))
        };
    }

    // ------------------------------------------------------------------
    // Escrita
    // ------------------------------------------------------------------

    /** Fader: todas as ventoinhas na mesma velocidade fixa (com piso de segurança). */
    setAll(percent) {
        const { minPercent } = this.settings();
        const p = Math.max(Math.max(0, Number(minPercent) || 0), Math.min(100, Math.round(Number(percent) || 0)));
        this.percent = p;
        this.manual = true;
        this.pendingPercent = p;
        this.emit('change', this.state());
        if (!this.writeTimer) {
            this.writeTimer = setTimeout(() => { this.writeTimer = null; this.flush(); }, WRITE_THROTTLE_MS);
        }
    }

    adjust(delta) {
        const d = parseInt(delta, 10);
        if (isNaN(d)) return;
        this.setAll(this.percent + d);
    }

    async flush() {
        const p = this.pendingPercent;
        if (p === null || !this.available || !this.token) { this.pendingPercent = null; return; }
        try {
            await this.rememberProfiles();
            for (const c of this.channels) {
                const duty = Math.max(c.minDuty, Math.min(c.maxDuty, p));
                const r = await this.api('PUT', `/devices/${c.deviceUid}/settings/${encodeURIComponent(c.name)}/manual`, { speed_fixed: duty });
                if (r.status !== 200) console.warn(`[Fans] ${c.label}: velocidade fixa ${duty}% recusada (HTTP ${r.status})`);
                else { c.manual = true; c.speedFixed = duty; }
            }
            console.log(`[Fans] Ventoinhas em ${p}% (${this.channels.length} canais)`);
        } catch (e) {
            console.warn('[Fans] Falha ao definir velocidade:', e.message);
        } finally {
            if (this.pendingPercent === p) this.pendingPercent = null;
            else if (this.pendingPercent !== null) this.flush();
            this.schedule(400);
        }
    }

    /** Antes do primeiro manual, guarda o perfil/curva de cada canal para "voltar ao automático". */
    async rememberProfiles() {
        const restore = { ...(this.settings().restore || {}) };
        let changed = false;
        for (const c of this.channels) {
            const key = `${c.deviceUid}/${c.name}`;
            if (!c.manual && c.profileUid && restore[key] !== c.profileUid) { restore[key] = c.profileUid; changed = true; }
            else if (!c.manual && !c.profileUid && !(key in restore)) { restore[key] = null; changed = true; }
        }
        if (changed && this.config && typeof this.config.set === 'function') this.config.set('fans', { restore });
    }

    /** Toque no fader: devolve cada ventoinha ao perfil que tinha (ou ao padrão do CoolerControl). */
    async setAuto() {
        if (!this.available || !this.token) return false;
        const restore = this.settings().restore || {};
        let ok = true;
        for (const c of this.channels) {
            const prof = restore[`${c.deviceUid}/${c.name}`];
            const r = prof
                ? await this.api('PUT', `/devices/${c.deviceUid}/settings/${encodeURIComponent(c.name)}/profile`, { profile_uid: prof })
                : await this.api('PUT', `/devices/${c.deviceUid}/settings/${encodeURIComponent(c.name)}/reset`);
            if (r.status !== 200) { ok = false; console.warn(`[Fans] ${c.label}: não voltou ao automático (HTTP ${r.status})`); }
            else { c.manual = false; c.speedFixed = null; c.profileUid = prof || null; }
        }
        this.manual = this.channels.some(c => c.manual);
        this.pendingPercent = null;
        console.log('[Fans] Ventoinhas de volta ao controle automático (curvas do CoolerControl)');
        this.emit('change', this.state());
        this.schedule(400);
        return ok;
    }

    /** Alterna manual <-> automático (toque no fader). */
    toggleAuto() {
        if (this.manual) return this.setAuto();
        this.setAll(this.percent);
        return Promise.resolve(true);
    }
}

module.exports = FanControl;
