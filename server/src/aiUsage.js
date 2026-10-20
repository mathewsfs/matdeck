/**
 * Consumo de IA (limites de uso) do Claude Code e do Codex CLI, para teclas nativas de telemetria.
 *
 * Mesmas fontes do plugin "Claude & Codex Usage" da Elgato, sem o plugin:
 *  - Claude: ~/.claude/.credentials.json (OAuth do Claude Code) -> GET https://api.anthropic.com/api/oauth/usage
 *            (janela de 5 h, semana e limites por modelo, ex.: Fable). Se o token venceu, renova com o
 *            refresh token e grava de volta no arquivo (preservando os demais campos), como o Claude Code faz.
 *  - Codex:  ~/.codex/auth.json (tokens do Codex CLI) -> GET https://chatgpt.com/backend-api/codex/usage
 *            (janelas "primary"/"secondary"; a duração vem na resposta).
 *
 * Os arquivos são lidos pelo host (hostExec), então funciona igual dentro do Flatpak.
 */
const EventEmitter = require('events');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile, spawn } = require('./hostExec');

const CACHE_FILE = path.join(process.env.MATDECK_DATA_DIR || path.resolve(__dirname, '../data'), 'ai-usage.json');

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';  // client público do Claude Code (OAuth)
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage';

const DEFAULTS = {
    pollSeconds: 60,            // mesmo TTL do plugin
    claudeCredentialsPath: '',  // vazio = ~/.claude/.credentials.json
    codexAuthPath: '',          // vazio = ~/.codex/auth.json
    refreshClaudeToken: true,   // renovar o token OAuth vencido e gravar no arquivo
    warnPercent: 70,
    criticalPercent: 90
};

const REQ_TIMEOUT_MS = 8000;
const RATE_LIMIT_BACKOFF_MS = 2 * 60 * 1000;      // 1º 429: 2 min; dobra a cada repetição até 30 min
const RATE_LIMIT_BACKOFF_MAX_MS = 30 * 60 * 1000;

/** Erro de limite de consultas (HTTP 429) com o Retry-After, quando informado. */
class RateLimited extends Error {
    constructor(retryAfterHeader) {
        super('limite de consultas · aguardando');
        const s = Number(String(retryAfterHeader || '').trim());
        this.retryAfterMs = Number.isFinite(s) && s > 0 ? s * 1000 : 0;
    }
}

function fmtAgo(ts, now = Date.now()) {
    const m = Math.max(0, Math.round((now - ts) / 60000));
    if (m < 1) return 'agora';
    if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60);
    return h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} d`;
}

function httpJson(method, url, headers, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = body === undefined ? null : JSON.stringify(body);
        const req = https.request({
            host: u.hostname, port: 443, path: u.pathname + u.search, method,
            timeout: REQ_TIMEOUT_MS,
            headers: { Accept: 'application/json', ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (e) { /* não é JSON */ }
                resolve({ status: res.statusCode, json, text, headers: res.headers });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

/** O caminho vai como argumento posicional: nada dele passa pelo shell (vem da configuração, editável pela rede). */
function readHostFile(path) {
    return new Promise((resolve) => {
        execFile('sh', ['-c', 'cat "$1" 2>/dev/null', 'sh', path], { timeout: 4000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
    });
}

/** Grava com umask 077 e rename atômico (arquivo de credenciais). */
function writeHostFile(path, content) {
    return new Promise((resolve) => {
        const child = spawn('sh', ['-c', 'umask 077; cat > "$1.tmp" && mv -f "$1.tmp" "$1"', 'sh', path], { stdio: ['pipe', 'ignore', 'pipe'] });
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
        child.stdin.end(content);
    });
}

/** `~` e `$HOME` resolvidos aqui (o shell não expande dentro de "$1"); no Flatpak HOME é o mesmo do host. */
function expandHome(p, fallback) {
    const s = String(p || '').trim() || fallback;
    const home = process.env.HOME || os.homedir();
    return s.replace(/^(~|\$HOME)(?=\/|$)/, home);
}

function clampPct(v) {
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
}

function windowLabel(seconds) {
    if (!seconds) return 'janela';
    const h = seconds / 3600;
    if (h <= 6) return `${Math.round(h)} h`;
    const d = seconds / 86400;
    if (d < 1.5) return `${Math.round(h)} h`;
    if (d <= 8) return d >= 6.5 && d <= 7.5 ? 'Semana' : `${Math.round(d)} d`;
    return d >= 28 && d <= 31 ? 'Mês' : `${Math.round(d)} d`;
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function pad2(n) { return n < 10 ? `0${n}` : String(n); }

/** "até 18:00" (hoje), "até sáb 10:00" (outro dia) ou "agora". */
function fmtReset(iso, now = new Date()) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diff = d.getTime() - now.getTime();
    if (diff <= 0) return 'reinicia agora';
    const sameDay = d.toDateString() === now.toDateString();
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (sameDay) return `até ${hm}`;
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return `até amanhã ${hm}`;
    return `até ${WEEKDAYS[d.getDay()]} ${hm}`;
}

/** "em 2h 10m" / "em 3d 4h" (texto curto para a linha secundária). */
function fmtIn(iso, now = new Date()) {
    if (!iso) return '';
    const diff = new Date(iso).getTime() - now.getTime();
    if (!Number.isFinite(diff)) return '';
    if (diff <= 0) return 'reinicia agora';
    const m = Math.floor(diff / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return `em ${d}d ${h % 24}h`;
    if (h >= 1) return `em ${h}h ${pad2(m % 60)}m`;
    return `em ${m} min`;
}

class AiUsage extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.timer = null;
        this.polling = false;
        this.lastForcedAt = 0;
        this.claude = { ok: false, error: 'aguardando', windows: [], plan: '', updatedAt: 0, backoffUntil: 0, rateLimitHits: 0 };
        this.codex = { ok: false, error: 'aguardando', windows: [], plan: '', updatedAt: 0, backoffUntil: 0, rateLimitHits: 0 };
        this.loadCache();
    }

    /** Último consumo conhecido (sobrevive a reinícios; mostrado como "há X min" até a API responder). */
    loadCache() {
        try {
            const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            for (const p of ['claude', 'codex']) {
                if (c[p] && Array.isArray(c[p].windows) && c[p].updatedAt) Object.assign(this[p], { windows: c[p].windows, plan: c[p].plan || '', updatedAt: c[p].updatedAt, error: 'aguardando' });
            }
        } catch (e) { /* sem cache */ }
    }

    saveCache() {
        try {
            fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
            const pick = (s) => ({ windows: s.windows, plan: s.plan, updatedAt: s.updatedAt });
            fs.writeFileSync(CACHE_FILE, JSON.stringify({ claude: pick(this.claude), codex: pick(this.codex) }));
        } catch (e) { /* cache é opcional */ }
    }

    /** Recuo após 429: Retry-After do servidor ou 2 min dobrando a cada repetição (máx. 30 min). */
    applyRateLimit(st, err) {
        st.rateLimitHits = (st.rateLimitHits || 0) + 1;
        const grow = Math.min(RATE_LIMIT_BACKOFF_MAX_MS, RATE_LIMIT_BACKOFF_MS * Math.pow(2, st.rateLimitHits - 1));
        st.backoffUntil = Date.now() + Math.max(grow, err.retryAfterMs || 0);
        // Depois do recuo, continua nesse ritmo por 30 min: zerar no 1º sucesso fazia OK -> 429 -> OK sem parar
        st.calmIntervalMs = Math.max(grow, err.retryAfterMs || 0);
        st.calmUntil = Date.now() + 30 * 60 * 1000;
    }

    /** Intervalo entre sondagens: o configurado, ou o do recuo enquanto um serviço estiver em "calmaria". */
    pollIntervalMs() {
        let ms = Math.max(15, Number(this.settings().pollSeconds) || 60) * 1000;
        for (const st of [this.claude, this.codex]) {
            if (st.calmUntil && Date.now() < st.calmUntil) ms = Math.max(ms, st.calmIntervalMs || 0);
        }
        return ms;
    }

    settings() {
        let cfg = {};
        try { cfg = (this.config && this.config.get('ai')) || {}; } catch (e) { /* defaults */ }
        return { ...DEFAULTS, ...cfg };
    }

    start() {
        if (this.timer) return;
        this.schedule(1500);
        console.log('[IA] Monitor de consumo Claude/Codex iniciado');
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

    /** Toque numa tecla: atualiza já (no máximo 1x a cada 10 s). */
    refreshNow() {
        if (Date.now() - this.lastForcedAt < 10 * 1000) return;
        this.lastForcedAt = Date.now();
        this.schedule(0);
    }

    async poll() {
        if (this.polling) return;
        this.polling = true;
        try {
            await Promise.all([this.pollClaude(), this.pollCodex()]);
        } finally {
            this.polling = false;
            this.emit('change', this.state());
            this.schedule(this.pollIntervalMs());
        }
    }

    // ------------------------------------------------------------------
    // Claude
    // ------------------------------------------------------------------

    async pollClaude() {
        const st = this.claude;
        if (Date.now() < st.backoffUntil) return;
        const path = expandHome(this.settings().claudeCredentialsPath, '$HOME/.claude/.credentials.json');
        try {
            const raw = await readHostFile(path);
            if (!raw) throw new Error('faça login no Claude Code');
            let file;
            try { file = JSON.parse(raw); } catch (e) { throw new Error('credenciais do Claude inválidas'); }
            const oauth = file && file.claudeAiOauth;
            let token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : '';
            if (!token) throw new Error('faça login no Claude Code');

            const expired = typeof oauth.expiresAt === 'number' && oauth.expiresAt - Date.now() < 60 * 1000;
            if (expired && this.settings().refreshClaudeToken && oauth.refreshToken) {
                token = await this.refreshClaude(file, path) || token;
            }

            let r = await this.fetchClaude(token);
            if (r.status === 401 && this.settings().refreshClaudeToken && oauth.refreshToken) {
                const fresh = await this.refreshClaude(file, path);
                if (fresh) r = await this.fetchClaude(fresh);
            }
            if (r.status === 401 || r.status === 403) throw new Error('sessão expirada · abra o Claude Code');
            if (r.status === 429) throw new RateLimited(r.headers['retry-after']);
            if (r.status !== 200 || !r.json) throw new Error(`API respondeu HTTP ${r.status}`);

            const u = r.json;
            const windows = [];
            if (u.five_hour) windows.push({ id: 'session', label: '5 h', percent: clampPct(u.five_hour.utilization), resetsAt: u.five_hour.resets_at || null });
            if (u.seven_day) windows.push({ id: 'weekly', label: 'Semana', percent: clampPct(u.seven_day.utilization), resetsAt: u.seven_day.resets_at || null });
            for (const lim of Array.isArray(u.limits) ? u.limits : []) {
                if (lim && lim.kind === 'weekly_scoped' && lim.scope && lim.scope.model) {
                    const name = String(lim.scope.model.display_name || lim.scope.model.id || 'modelo');
                    windows.push({ id: `model:${name.toLowerCase()}`, label: name, percent: clampPct(lim.percent), resetsAt: lim.resets_at || null });
                }
            }
            if (u.extra_usage && u.extra_usage.is_enabled && typeof u.extra_usage.utilization === 'number') {
                windows.push({ id: 'extra', label: 'Extra', percent: clampPct(u.extra_usage.utilization), resetsAt: null });
            }
            const tier = String(oauth.rateLimitTier || '');
            const mult = /_(\d+)x$/.exec(tier);
            st.plan = oauth.subscriptionType ? `${String(oauth.subscriptionType).replace(/^\w/, c => c.toUpperCase())}${mult ? ' ' + mult[1] + 'x' : ''}` : '';
            st.windows = windows;
            st.ok = true;
            st.error = '';
            st.rateLimitHits = 0;
            st.updatedAt = Date.now();
            this.saveCache();
        } catch (e) {
            const msg = e.message || String(e);
            if (e instanceof RateLimited) this.applyRateLimit(st, e);
            if (st.ok || st.error !== msg) console.warn('[IA] Claude:', msg, e instanceof RateLimited ? `(próxima tentativa em ${Math.round((st.backoffUntil - Date.now()) / 60000)} min)` : '');
            st.ok = false;
            st.error = msg;
        }
    }

    fetchClaude(token) {
        return httpJson('GET', CLAUDE_USAGE_URL, { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' });
    }

    /** Renova o token OAuth e grava no .credentials.json (mantendo o resto do arquivo). */
    async refreshClaude(file, path) {
        try {
            const r = await httpJson('POST', CLAUDE_TOKEN_URL, {}, { grant_type: 'refresh_token', refresh_token: file.claudeAiOauth.refreshToken, client_id: CLAUDE_CLIENT_ID });
            if (r.status !== 200 || !r.json || typeof r.json.access_token !== 'string') {
                console.warn(`[IA] Claude: renovação do token falhou (HTTP ${r.status})`);
                return null;
            }
            const next = { ...file, claudeAiOauth: { ...file.claudeAiOauth, accessToken: r.json.access_token } };
            if (typeof r.json.refresh_token === 'string' && r.json.refresh_token) next.claudeAiOauth.refreshToken = r.json.refresh_token;
            if (typeof r.json.expires_in === 'number') next.claudeAiOauth.expiresAt = Date.now() + r.json.expires_in * 1000;
            const ok = await writeHostFile(path, JSON.stringify(next));
            console.log(`[IA] Claude: token OAuth renovado${ok ? ' e gravado' : ' (não foi possível gravar no arquivo)'}`);
            file.claudeAiOauth = next.claudeAiOauth;
            return r.json.access_token;
        } catch (e) {
            console.warn('[IA] Claude: erro ao renovar token:', e.message);
            return null;
        }
    }

    // ------------------------------------------------------------------
    // Codex
    // ------------------------------------------------------------------

    async pollCodex() {
        const st = this.codex;
        if (Date.now() < st.backoffUntil) return;
        const path = expandHome(this.settings().codexAuthPath, '$HOME/.codex/auth.json');
        try {
            const raw = await readHostFile(path);
            if (!raw) throw new Error('faça login no Codex CLI');
            let file;
            try { file = JSON.parse(raw); } catch (e) { throw new Error('auth.json do Codex inválido'); }
            const tokens = file && file.tokens;
            const token = tokens && typeof tokens.access_token === 'string' ? tokens.access_token : '';
            if (!token) throw new Error('faça login no Codex CLI');
            const headers = { authorization: `Bearer ${token}`, 'user-agent': 'codex_cli_rs', accept: 'application/json' };
            if (tokens.account_id) headers['chatgpt-account-id'] = tokens.account_id;
            const r = await httpJson('GET', CODEX_USAGE_URL, headers);
            if (r.status === 401 || r.status === 403) throw new Error('sessão expirada · rode codex login');
            if (r.status === 429) throw new RateLimited(r.headers['retry-after']);
            if (r.status !== 200 || !r.json) throw new Error(`API respondeu HTTP ${r.status}`);

            const rl = r.json.rate_limit || {};
            const windows = [];
            const push = (id, w) => {
                if (!w) return;
                windows.push({ id, label: windowLabel(w.limit_window_seconds), percent: clampPct(w.used_percent), resetsAt: typeof w.reset_at === 'number' ? new Date(w.reset_at * 1000).toISOString() : null });
            };
            push('primary', rl.primary_window);
            push('secondary', rl.secondary_window);
            st.plan = r.json.plan_type ? String(r.json.plan_type).replace(/^\w/, c => c.toUpperCase()) : '';
            st.windows = windows;
            st.ok = true;
            st.error = '';
            st.rateLimitHits = 0;
            st.updatedAt = Date.now();
            this.saveCache();
        } catch (e) {
            const msg = e.message || String(e);
            if (e instanceof RateLimited) this.applyRateLimit(st, e);
            if (st.ok || st.error !== msg) console.warn('[IA] Codex:', msg);
            st.ok = false;
            st.error = msg;
        }
    }

    // ------------------------------------------------------------------
    // Estado para as teclas
    // ------------------------------------------------------------------

    state() {
        const strip = (s) => ({ ok: s.ok, error: s.error, plan: s.plan, windows: s.windows, updatedAt: s.updatedAt });
        return { claude: strip(this.claude), codex: strip(this.codex) };
    }

    colorFor(percent) {
        const { warnPercent, criticalPercent } = this.settings();
        if (percent === null || percent === undefined) return '#6B7280';
        if (percent >= criticalPercent) return '#EF4444';
        if (percent >= warnPercent) return '#F59E0B';
        return '#10B981';
    }

    /**
     * Campos stat* para uma ação `ai:*`:
     *   ai:claude | ai:codex                      -> todas as janelas (modo "meters")
     *   ai:claude_5h | ai:claude_7d | ai:claude_model -> uma janela (modo "bar")
     *   ai:codex_primary | ai:codex_secondary     -> uma janela (modo "bar")
     */
    stateFor(actionId) {
        if (!actionId || !actionId.startsWith('ai:')) return null;
        const [, rest] = actionId.split(':');
        const [provider, which] = rest.split('_');
        const src = provider === 'codex' ? this.codex : (provider === 'claude' ? this.claude : null);
        if (!src) return null;
        const label = provider === 'codex' ? 'Codex' : 'Claude';
        const color = provider === 'codex' ? '#10A37F' : '#D97757';
        const base = { statHistory: null, statHistory2: null, statBars: null, statRows: null, statSub: null, statPercent: null, badge: null, statImage: null, statTime: null, statTotal: null };
        const now = new Date();

        const stale = !src.ok && src.windows.length > 0 && src.updatedAt > 0;
        if (!src.ok && !stale) {
            const err = src.error || 'indisponível';
            return which
                ? { ...base, statMode: 'bar', statLabel: label, statHead: '', statBig: 'n/d', statSub: err, statPercent: 0, statColor: '#6B7280', title: `${label} n/d`, active: false }
                : { ...base, statMode: 'meters', statLabel: label, statHead: 'n/d', statRows: [{ k: 'sem dados', v: '', sub: err, pct: 0, color: '#6B7280' }], statColor: '#6B7280', title: `${label} n/d`, active: false };
        }

        if (!which) {
            const rows = src.windows.map(w => ({ k: w.label, v: w.percent === null ? '--' : `${w.percent}%`, sub: fmtReset(w.resetsAt, now).replace(/^até /, ''), pct: w.percent || 0, color: this.colorFor(w.percent) }));
            const worst = src.windows.reduce((m, w) => Math.max(m, w.percent || 0), 0);
            return { ...base, statMode: 'meters', statLabel: label, statHead: stale ? fmtAgo(src.updatedAt) : (src.plan || ''), statRows: rows.length ? rows : [{ k: 'sem janelas', v: '', sub: '', pct: 0, color }], statColor: this.colorFor(worst), title: `${label} ${worst}%`, badge: `${worst}%`, active: worst >= this.settings().criticalPercent };
        }

        let w = null;
        if (provider === 'claude') {
            if (which === '5h') w = src.windows.find(x => x.id === 'session');
            else if (which === '7d') w = src.windows.find(x => x.id === 'weekly');
            else if (which === 'model') w = src.windows.find(x => x.id.startsWith('model:'));
        } else {
            w = src.windows.find(x => x.id === which);
        }
        if (!w) return { ...base, statMode: 'bar', statLabel: label, statHead: '', statBig: '--', statSub: 'janela não disponível', statPercent: 0, statColor: '#6B7280', title: `${label} --` };
        return {
            ...base,
            statMode: 'bar',
            statLabel: `${label} · ${w.label}`,
            statHead: stale ? fmtAgo(src.updatedAt) : fmtReset(w.resetsAt, now).replace(/^até /, ''),
            statBig: w.percent === null ? '--' : `${w.percent}%`,
            statSub: stale ? 'sem resposta da API' : (fmtIn(w.resetsAt, now) ? `reinicia ${fmtIn(w.resetsAt, now)}` : (src.plan || '')),
            statPercent: w.percent || 0,
            statColor: this.colorFor(w.percent),
            title: `${label} ${w.label} ${w.percent === null ? '--' : w.percent + '%'}`,
            badge: null,
            active: (w.percent || 0) >= this.settings().criticalPercent
        };
    }
}

module.exports = AiUsage;
