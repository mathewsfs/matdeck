/**
 * Controle de acesso do MatDeck.
 *
 * - Quem chega por loopback (o próprio PC) é "trusted": gerenciador e API completa, sem PIN.
 * - Qualquer outro endereço é um dispositivo: precisa de um token emparelhado por PIN de 4 dígitos
 *   (o PIN aparece só no gerenciador, que só abre no PC). O token vai em cookie HttpOnly (deck web)
 *   ou no cabeçalho X-MatDeck-Token (cliente Android nativo); em disco fica só o hash SHA-256.
 * - O cabeçalho Host precisa ser um nome/IP desta máquina (fecha DNS rebinding: um site de fora
 *   apontando o próprio domínio para 127.0.0.1 não consegue falar com o servidor).
 */
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COOKIE_NAME = 'matdeck_device';
const HEADER_NAME = 'x-matdeck-token';
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

const PIN_TTL_MS = 2 * 60 * 1000;      // o PIN vale 2 minutos
const MAX_ATTEMPTS = 5;                // erros por sessão antes de cancelar e bloquear o IP
const MAX_PENDING = 6;                 // pedidos simultâneos (um por IP)
const COOLDOWN_BASE_MS = 30 * 1000;    // 30 s, dobra a cada bloqueio seguido
const COOLDOWN_MAX_MS = 10 * 60 * 1000;
const REFUSE_COOLDOWN_MS = 10 * 60 * 1000; // "Recusar" no gerenciador
const IFACE_CACHE_MS = 5000;

function normalizeIp(addr) {
    const s = String(addr || '').trim();
    return s.replace(/^::ffff:/i, '');
}

function isLoopbackAddress(addr) {
    const ip = normalizeIp(addr).toLowerCase();
    if (!ip) return false;
    if (ip === '::1' || ip === 'localhost') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/** 'localhost:8888' -> 'localhost'; '[::1]:8888' -> '::1'; minúsculas. */
function hostnameOf(hostHeader) {
    const raw = String(hostHeader || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw[0] === '[') {
        const end = raw.indexOf(']');
        return end > 0 ? raw.slice(1, end) : '';
    }
    const colon = raw.indexOf(':');
    // IPv6 sem colchetes (vários ':') fica inteiro; host:porta tem só um
    if (colon >= 0 && raw.indexOf(':', colon + 1) < 0) return raw.slice(0, colon);
    return raw;
}

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        if (!name) continue;
        let value = part.slice(eq + 1).trim();
        try { value = decodeURIComponent(value); } catch (e) { /* valor cru */ }
        out[name] = value;
    }
    return out;
}

/** Nome curto para o gerenciador a partir do User-Agent: "iPad · Safari 9", "Android 4.4 · Chrome 33". */
function describeClient(userAgent) {
    const ua = String(userAgent || '');
    if (!ua) return 'Dispositivo';
    let device = null;
    let m;
    if (/iPad/.test(ua)) device = 'iPad';
    else if (/iPhone/.test(ua)) device = 'iPhone';
    else if ((m = ua.match(/Android\s+(\d+(?:\.\d+)?)/))) device = `Android ${m[1]}`;
    else if (/Windows/.test(ua)) device = 'Windows';
    else if (/Macintosh/.test(ua)) device = 'Mac';
    else if (/Linux/.test(ua)) device = 'Linux';
    else if (/MatDeck/i.test(ua)) device = 'Cliente MatDeck';
    let browser = null;
    if ((m = ua.match(/(?:Edg|Edge)\/(\d+)/))) browser = `Edge ${m[1]}`;
    else if ((m = ua.match(/Firefox\/(\d+)/))) browser = `Firefox ${m[1]}`;
    else if ((m = ua.match(/(?:Chrome|CriOS)\/(\d+)/))) browser = `Chrome ${m[1]}`;
    else if (/Safari\//.test(ua) && (m = ua.match(/Version\/(\d+)/))) browser = `Safari ${m[1]}`;
    const parts = [device, browser].filter(Boolean);
    return parts.length ? parts.join(' · ') : ua.slice(0, 40);
}

function sha256(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function safeEqualHex(a, b) {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Nomes/IPs pelos quais este servidor pode ser chamado (cabeçalho Host). */
class HostAllowlist {
    constructor(opts = {}) {
        this.interfaces = opts.interfaces || os.networkInterfaces;
        this.hostname = opts.hostname || os.hostname;
        this.extra = opts.extra || (() => []);
        this.cache = null;
        this.cacheAt = 0;
        this.now = opts.now || Date.now;
    }

    names() {
        const t = this.now();
        if (this.cache && t - this.cacheAt < IFACE_CACHE_MS) return this.cache;
        const set = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
        let ifaces = {};
        try { ifaces = this.interfaces() || {}; } catch (e) { /* sem interfaces */ }
        for (const list of Object.values(ifaces)) {
            for (const iface of list || []) {
                if (!iface || !iface.address) continue;
                set.add(String(iface.address).toLowerCase().replace(/%.*$/, '')); // IPv6 sem o id de zona
            }
        }
        let host = '';
        try { host = String(this.hostname() || '').toLowerCase(); } catch (e) { /* sem hostname */ }
        if (host) { set.add(host); set.add(`${host}.local`); set.add(`${host}.lan`); }
        for (const name of this.extra() || []) {
            if (typeof name === 'string' && name.trim()) set.add(hostnameOf(name.trim()));
        }
        this.cache = set;
        this.cacheAt = t;
        return set;
    }

    isAllowed(hostHeader) {
        const name = hostnameOf(hostHeader);
        if (!name) return false;
        if (isLoopbackAddress(name) || name.endsWith('.localhost')) return true;
        return this.names().has(name);
    }
}

/** Dispositivos emparelhados (devices.json, modo 0600, só o hash do token). */
class DeviceRegistry extends EventEmitter {
    constructor(filePath) {
        super();
        this.filePath = filePath || path.join(process.env.MATDECK_DATA_DIR || path.resolve(__dirname, '../data'), 'devices.json');
        this.devices = [];
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) return;
            const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.devices) ? raw.devices : []);
            this.devices = list.filter(d => d && typeof d.id === 'string' && typeof d.tokenHash === 'string');
        } catch (e) {
            const backup = `${this.filePath}.corrompido-${Date.now()}`;
            try { fs.renameSync(this.filePath, backup); } catch (e2) { /* segue sem backup */ }
            console.error(`[Auth] devices.json ilegível (${e.message}); guardado em ${backup}.`);
            this.devices = [];
        }
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const tmp = `${this.filePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ devices: this.devices }, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, this.filePath);
        } catch (e) {
            console.error('[Auth] Erro ao gravar devices.json:', e.message);
        }
        this.emit('change');
    }

    static publicView(d) {
        return { id: d.id, name: d.name, ip: d.ip, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt };
    }

    list() {
        return this.devices.map(DeviceRegistry.publicView);
    }

    create({ name, ip }) {
        const token = crypto.randomBytes(32).toString('base64url');
        const now = Date.now();
        const device = {
            id: crypto.randomBytes(8).toString('hex'),
            name: String(name || 'Dispositivo').slice(0, 60),
            ip: normalizeIp(ip),
            createdAt: now,
            lastSeenAt: now,
            tokenHash: sha256(token)
        };
        this.devices.push(device);
        this.save();
        return { device: DeviceRegistry.publicView(device), token };
    }

    findByToken(token) {
        if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
        const hash = sha256(token);
        for (const d of this.devices) {
            if (safeEqualHex(d.tokenHash, hash)) return DeviceRegistry.publicView(d);
        }
        return null;
    }

    get(id) {
        const d = this.devices.find(x => x.id === id);
        return d ? DeviceRegistry.publicView(d) : null;
    }

    touch(id, ip) {
        const d = this.devices.find(x => x.id === id);
        if (!d) return;
        d.lastSeenAt = Date.now();
        if (ip) d.ip = normalizeIp(ip);
        this.save();
    }

    remove(id) {
        const before = this.devices.length;
        this.devices = this.devices.filter(d => d.id !== id);
        if (this.devices.length === before) return false;
        this.save();
        return true;
    }
}

/** Sessões de emparelhamento: PIN de 4 dígitos, 2 min, 5 tentativas, bloqueio progressivo por IP. */
class PairingManager extends EventEmitter {
    constructor(registry, opts = {}) {
        super();
        this.registry = registry;
        this.now = opts.now || Date.now;
        this.randomPin = opts.randomPin || (() => String(crypto.randomInt(0, 10000)).padStart(4, '0'));
        this.sessions = new Map();   // id -> sessão
        this.cooldowns = new Map();  // ip -> { until, strikes }
    }

    purge() {
        const t = this.now();
        let changed = false;
        for (const [id, s] of this.sessions) {
            if (s.expiresAt <= t) { this.sessions.delete(id); changed = true; }
        }
        for (const [ip, c] of this.cooldowns) {
            if (c.until <= t && t - c.until > COOLDOWN_MAX_MS) this.cooldowns.delete(ip); // esquece as faltas antigas
        }
        if (changed) this.emit('change');
        return changed;
    }

    cooldownLeft(ip) {
        const c = this.cooldowns.get(ip);
        if (!c) return 0;
        return Math.max(0, c.until - this.now());
    }

    punish(ip, fixedMs) {
        const c = this.cooldowns.get(ip) || { until: 0, strikes: 0 };
        c.strikes += 1;
        const ms = fixedMs || Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * Math.pow(2, c.strikes - 1));
        c.until = this.now() + ms;
        this.cooldowns.set(ip, c);
        return ms;
    }

    pending() {
        this.purge();
        return Array.from(this.sessions.values()).map(s => ({
            id: s.id, name: s.name, ip: s.ip, pin: s.pin, createdAt: s.createdAt, expiresAt: s.expiresAt, attempts: s.attempts
        }));
    }

    start({ ip, name }) {
        this.purge();
        ip = normalizeIp(ip);
        const left = this.cooldownLeft(ip);
        if (left > 0) return { ok: false, status: 429, error: 'Muitas tentativas. Aguarde antes de pedir um novo PIN.', retryAfterMs: left };
        // Um pedido por IP: o novo substitui o anterior (o deck recarregado não deixa cartões órfãos no gerenciador)
        for (const [id, s] of this.sessions) if (s.ip === ip) this.sessions.delete(id);
        if (this.sessions.size >= MAX_PENDING) {
            return { ok: false, status: 429, error: 'Há pedidos de conexão demais aguardando no gerenciador.', retryAfterMs: 15000 };
        }
        const t = this.now();
        const session = {
            id: crypto.randomBytes(12).toString('hex'),
            pin: this.randomPin(),
            ip,
            name: String(name || 'Dispositivo').slice(0, 60),
            createdAt: t,
            expiresAt: t + PIN_TTL_MS,
            attempts: 0
        };
        this.sessions.set(session.id, session);
        this.emit('change');
        return { ok: true, session: { id: session.id, expiresAt: session.expiresAt, ttlMs: PIN_TTL_MS } };
    }

    verify({ id, pin, ip }) {
        this.purge();
        ip = normalizeIp(ip);
        if (typeof id !== 'string' || !/^\d{4}$/.test(String(pin || ''))) {
            return { ok: false, status: 400, error: 'Informe o id da sessão e um PIN de 4 dígitos.' };
        }
        const left = this.cooldownLeft(ip);
        if (left > 0) return { ok: false, status: 429, error: 'Muitas tentativas. Aguarde.', retryAfterMs: left };
        const s = this.sessions.get(id);
        if (!s) {
            // Expirada ou nunca existiu: o deck pede um PIN novo
            return { ok: false, status: 410, error: 'Este PIN expirou. Peça um novo.' };
        }
        if (s.ip !== ip) return { ok: false, status: 403, error: 'Este pedido foi feito por outro dispositivo.' };
        if (s.expiresAt <= this.now()) {
            this.sessions.delete(id);
            this.emit('change');
            return { ok: false, status: 410, error: 'Este PIN expirou. Peça um novo.' };
        }
        if (String(pin) !== s.pin) {
            s.attempts += 1;
            if (s.attempts >= MAX_ATTEMPTS) {
                this.sessions.delete(id);
                const ms = this.punish(ip);
                this.emit('change');
                return { ok: false, status: 429, error: 'PIN errado vezes demais. Aguarde para tentar de novo.', retryAfterMs: ms };
            }
            this.emit('change');
            return { ok: false, status: 401, error: 'PIN incorreto.', attemptsLeft: MAX_ATTEMPTS - s.attempts };
        }
        this.sessions.delete(id);
        this.cooldowns.delete(ip);
        const { device, token } = this.registry.create({ name: s.name, ip });
        this.emit('change');
        return { ok: true, device, token };
    }

    cancel(id, { punish = false } = {}) {
        const s = this.sessions.get(id);
        if (!s) return false;
        this.sessions.delete(id);
        if (punish) this.punish(s.ip, REFUSE_COOLDOWN_MS);
        this.emit('change');
        return true;
    }
}

/** Papel da requisição: 'trusted' (loopback), 'device' (token válido) ou 'guest'. */
function classifyRequest(req, registry) {
    const ip = normalizeIp(req.socket && req.socket.remoteAddress);
    if (isLoopbackAddress(ip)) return { role: 'trusted', ip, device: null };
    const token = req.headers[HEADER_NAME] || parseCookies(req.headers.cookie)[COOKIE_NAME];
    const device = token ? registry.findByToken(String(token)) : null;
    if (device) return { role: 'device', ip, device };
    return { role: 'guest', ip, device: null };
}

function deviceCookie(token) {
    return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax`;
}

function clearDeviceCookie() {
    return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

module.exports = {
    COOKIE_NAME,
    HEADER_NAME,
    PIN_TTL_MS,
    MAX_ATTEMPTS,
    normalizeIp,
    isLoopbackAddress,
    hostnameOf,
    parseCookies,
    describeClient,
    HostAllowlist,
    DeviceRegistry,
    PairingManager,
    classifyRequest,
    deviceCookie,
    clearDeviceCookie
};
