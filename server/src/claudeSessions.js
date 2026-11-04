/**
 * Sessões do Claude Code para as teclas `claude:*`.
 *
 * O hook (scripts/claude-code-hook.py) grava um JSON por sessão em ~/.local/state/matdeck/claude-sessions e avisa o
 * servidor. Aqui as sessões são lidas e agregadas do mesmo jeito que o relógio (smart-clock/status.py: effective_state,
 * session_label, short_tool, activity_text, aggregate). Dentro do Flatpak o servidor não enxerga a home, então TODO acesso
 * aos arquivos do host passa pelo hostExec (nunca fs): a varredura, os mtimes dos transcripts e a instalação do hook.
 *
 * Varredura = no máximo duas chamadas ao host: (1) SCAN_SH lista os `*.json` e imprime cada conteúdo em uma linha;
 * (2) STAT_SH, só se houver transcript_path, devolve o mtime de cada um (uma linha por caminho, 0 se não existir).
 * Formato do SCAN_SH: `dir ok|missing`, depois, por arquivo, `== <nome>` e o JSON em uma linha.
 * Cadência: scanActiveMs com viewers conectados, scanIdleMs sem eles; o tick (1 s) só recalcula o "há quanto tempo".
 *
 * Variáveis de ambiente: MATDECK_CLAUDE_STATE_DIR (pasta das sessões, vence a config) e MATDECK_CLAUDE_HOOK_DIR
 * (pasta onde o hook é instalado, em vez de ~/.local/state/matdeck; usada pelos testes).
 *
 * Foco (handleAction): primeiro só pelos PIDs da cadeia do terminal; se falhar, pela classe da janela (term_program).
 * Com o kdotool instalado as dicas de classe são buscadas antes dos PIDs e poderiam focar outro Konsole/Maestri.
 */
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile: hostExecFile } = require('./hostExec');

const DEFAULT_DIR = '~/.local/state/matdeck/claude-sessions';
const DEFAULT_HOOK_DIR = '~/.local/state/matdeck';
const HOOK_NAME = 'claude-code-hook.py';
const DEFAULT_PORT = 8888;
const SCAN_ACTIVE_MS = 2000;
const SCAN_IDLE_MS = 15000;
const TICK_MS = 1000;
const EXEC_TIMEOUT_MS = 4000;
const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_SLOTS = 12;

const WAITING_BG = '#B91C1C';     // fundo da tecla esperando você (não é o #DC2626 que o deck trata como "mutado")

// Prazos em segundos (os da config vêm em minutos)
const DEFAULT_TTL = Object.freeze({ workingTtl: 15 * 60, doneTtl: 10 * 60, waitingTtl: 2 * 60 * 60, staleTtl: 6 * 60 * 60 });

const PRIORITY = ['waiting', 'working', 'done', 'idle'];
const ORDER = Object.fromEntries(PRIORITY.map((state, index) => [state, index]));

const ACTIVITY_VERB = {
    Edit: 'Editando', Write: 'Editando', NotebookEdit: 'Editando', MultiEdit: 'Editando',
    Read: 'Lendo', Grep: 'Buscando', Glob: 'Buscando',
    WebFetch: 'Pesquisando', WebSearch: 'Pesquisando', Agent: 'Delegando', Task: 'Delegando'
};

// Os caminhos vão como argumento posicional: nada deles passa pelo shell (vêm da configuração, editável pela rede).
const SCAN_SH = [
    'if [ ! -d "$1" ]; then echo "dir missing"; exit 0; fi',
    'echo "dir ok"',
    'for f in "$1"/*.json; do',
    '  [ -f "$f" ] || continue',
    '  echo "== $(basename "$f")"',
    '  tr -d "\\n" < "$f" 2>/dev/null; echo',
    'done'
].join('\n');

// mtime de cada caminho (Linux: stat -c %Y; macOS/BSD: stat -f %m), 0 se não existir
const STAT_SH = 'for p in "$@"; do stat -c %Y -- "$p" 2>/dev/null || stat -f %m -- "$p" 2>/dev/null || echo 0; done';

const WRITE_SH = 'mkdir -p "$(dirname "$1")" && cat > "$1.tmp" && mv -f "$1.tmp" "$1"';

const str = (v, fallback = '') => (typeof v === 'string' ? v : (v === null || v === undefined ? fallback : String(v)));
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

function expandHome(p) {
    return String(p || '').trim().replace(/^~(?=\/|$)/, os.homedir());
}

// ----------------------------------------------------------------------
// Agregação (porta literal do status.py)
// ----------------------------------------------------------------------

/** Última atividade conhecida: o maior entre o último evento do hook e o mtime do transcript. */
function lastSignal(record) {
    return Math.max(Number(record.ts) || 0, Number(record.activity) || 0);
}

/** Estado de uma sessão depois de aplicar os prazos de validade. */
function effectiveState(record, now, ttl = DEFAULT_TTL) {
    const state = record.state || 'idle';
    const age = now - lastSignal(record);
    if (state === 'working' && age > ttl.workingTtl) return 'idle';
    if (state === 'done' && age > ttl.doneTtl) return 'idle';
    if (state === 'waiting' && age > ttl.waitingTtl) return 'idle';
    return state;
}

/** Nome curto do terminal a partir da pasta: projeto acima de .maestri, senão o nome da pasta. */
function sessionLabel(cwd) {
    if (!cwd) return 'terminal';
    const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
    const index = parts.indexOf('.maestri');
    if (index >= 0) return index > 0 ? parts[index - 1] : 'maestri';
    return parts.length ? parts[parts.length - 1] : 'terminal';
}

function shortTool(tool) {
    if (!tool) return null;
    if (tool.startsWith('mcp__')) {
        const bits = tool.split('__');
        return bits.length > 1 ? bits[1] : tool;
    }
    return tool;
}

/** Frase curta do que o terminal está fazendo, para a lista. */
function activityText(session) {
    const { state, detail } = session;
    const tool = session.tool_full || session.tool;
    if (state === 'waiting') return session.notification_type === 'permission_prompt' ? 'Pediu permissão' : 'Esperando você';
    if (state === 'done') return 'Pronto';
    if (state === 'idle') return 'Livre';
    if (!tool) return 'Pensando';
    if (tool.startsWith('mcp__')) {
        const bits = tool.split('__');
        const server = bits.length > 1 ? bits[1] : tool;
        return bits.length > 2 ? `${server} · ${bits[2]}` : server;
    }
    const verb = ACTIVITY_VERB[tool];
    if (verb) return detail ? `${verb} ${detail}` : verb;
    if (tool === 'Bash') return detail ? `Bash · ${detail}` : 'Bash';
    return detail ? `${tool} · ${detail}` : tool;
}

/** Estado geral usa os prazos (effectiveState); o placar conta cada sessão viva pelo último evento. */
function aggregate(records, now, ttl = DEFAULT_TTL) {
    const live = records.filter((r) => now - lastSignal(r) <= ttl.staleTtl);
    const states = live.map((r) => effectiveState(r, now, ttl));
    const summary = {
        state: 'idle',
        working: states.filter((s) => s === 'working').length,
        waiting: states.filter((s) => s === 'waiting').length,
        done: live.filter((r, i) => r.state === 'done' && states[i] !== 'working').length,
        total: live.length,
        sessions: []
    };
    live.forEach((record, i) => {
        const eff = states[i];
        const shown = eff === 'idle' && record.state === 'done' ? 'done' : eff;
        const active = shown === 'working' || shown === 'waiting';
        const started = shown === 'working' ? record.turn_started : null;
        const ts = record.ts === undefined || record.ts === null ? now : record.ts;
        summary.sessions.push({
            id: record.session_id,
            name: sessionLabel(record.cwd),
            state: shown,
            tool: active ? shortTool(record.tool) : null,
            tool_full: active ? (record.tool || null) : null,
            detail: active ? (record.detail || null) : null,
            prompt: record.prompt || null,
            notification_type: shown === 'waiting' ? (record.notification_type || null) : null,
            since: Math.max(0, now - (started || ts)),
            window: record.window && typeof record.window === 'object' ? record.window : null
        });
    });
    for (const session of summary.sessions) session.activity = activityText(session);
    const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    summary.sessions.sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || byName(a.name, b.name) || byName(String(a.id), String(b.id)));
    summary.state = PRIORITY.find((candidate) => states.includes(candidate)) || 'idle';
    summary.counts = { working: summary.working, waiting: summary.waiting, done: summary.done };
    // Muda quando o estado geral ou o estado/nome de alguma sessão muda
    summary.key = JSON.stringify([summary.state, summary.sessions.map((s) => [s.name, s.state])]);
    summary.tool_key = JSON.stringify(summary.sessions.map((s) => [s.tool, s.detail]));
    // Muda quando o texto do "há quanto tempo" de alguma sessão muda: a cada segundo no primeiro minuto ('12s'), depois a cada minuto
    summary.since_key = JSON.stringify(summary.sessions.map((s) => (s.since < 60 ? Math.floor(s.since) : 60 * Math.floor(s.since / 60))));
    return summary;
}

// ----------------------------------------------------------------------
// Leitura
// ----------------------------------------------------------------------

/** Interpreta a saída do SCAN_SH. Arquivo com JSON inválido (ou que não é objeto) é ignorado. */
function parseScan(stdout) {
    const lines = String(stdout || '').split('\n');
    const result = { dirExists: lines[0].trim() === 'dir ok', records: [] };
    if (!result.dirExists) return result;
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].startsWith('== ')) continue;
        try {
            const record = JSON.parse(lines[i + 1]);
            if (record && typeof record === 'object' && !Array.isArray(record)) result.records.push(record);
        } catch (e) { /* arquivo incompleto ou inválido */ }
        i++;
    }
    return result;
}

// ----------------------------------------------------------------------
// Foco
// ----------------------------------------------------------------------

/** Dica de classe da janela a partir do TERM_PROGRAM registrado pelo hook ('' = sem dica). */
function classHintFor(termProgram) {
    const name = str(termProgram).trim();
    if (!name) return '';
    if (name === 'Maestri') return 'maestri';
    if (name === 'vscode') return 'code';
    return name.toLowerCase();
}

// ----------------------------------------------------------------------
// Aparência das teclas
// ----------------------------------------------------------------------

const STATE_LABEL = { waiting: 'PRECISA', working: 'TRAB.', done: 'PRONTO', idle: 'LIVRE' };
const STATE_COLOR = { waiting: '#F87171', working: '#3B82F6', done: '#16A34A', idle: '#6B7280' };
const SUMMARY_HEAD = { waiting: 'PRECISA DE VOCÊ', working: 'TRABALHANDO', done: 'PRONTO', idle: 'LIVRE' };
const WAITING_BORDER = '#F87171';
const SUB_MAX = 40;

/** Tempo decorrido curto: '12s', '2m', '1h05'. */
function sinceText(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
}

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/** Aparência de uma tecla `claude:*` (campos do updateKey; null para ações desconhecidas). */
function keyStateFor(actionId, summary, slots = 4) {
    const id = String(actionId);
    if (id === 'claude:summary') {
        const { working = 0, waiting = 0, done = 0, total = 0 } = summary || {};
        const state = (summary && summary.state) || 'idle';
        const row = (k, v, color) => ({ k, v: String(v), pct: total ? 100 * v / total : 0, color });
        return {
            statMode: 'meters',
            statHead: SUMMARY_HEAD[state] || SUMMARY_HEAD.idle,
            statColor: STATE_COLOR[state] || STATE_COLOR.idle,
            statRows: [row('Trabalhando', working, STATE_COLOR.working), row('Precisando', waiting, STATE_COLOR.waiting), row('Prontos', done, STATE_COLOR.done)],
            pulse: waiting > 0,
            bgColor: waiting > 0 ? WAITING_BG : undefined,
            borderColor: waiting > 0 ? WAITING_BORDER : undefined,
            active: working + waiting > 0,
            badge: null
        };
    }
    const slot = /^claude:slot:(\d+)$/.exec(id);
    if (!slot) return null;
    const n = Number(slot[1]);
    const session = n >= 1 && n <= slots && summary ? summary.sessions[n - 1] : null;
    if (!session) {
        return { title: '—', statMode: 'bar', statHead: '', statBig: 'VAZIA', statSub: '', statColor: STATE_COLOR.idle, badge: null, bgColor: undefined, borderColor: undefined, pulse: false, active: false, statPercent: null };
    }
    const waiting = session.state === 'waiting';
    return {
        title: session.name,
        statMode: 'bar',
        statHead: sinceText(session.since),
        statBig: STATE_LABEL[session.state] || STATE_LABEL.idle,
        statSub: clip(str(session.activity), SUB_MAX),
        statColor: STATE_COLOR[session.state] || STATE_COLOR.idle,
        badge: null,
        bgColor: waiting ? WAITING_BG : undefined,
        borderColor: waiting ? WAITING_BORDER : undefined,
        pulse: waiting,
        active: session.state === 'working' || waiting,
        statPercent: null
    };
}

class ClaudeSessions extends EventEmitter {
    /**
     * @param {object} config  ConfigStore (seção `claude`); opcional
     * @param {object} opts    { focus, execFile, now, port, hookSource, hookDir, scanActiveMs, scanIdleMs, tickMs }
     *                         focus(target) = platform.windows.focus; now() em segundos
     */
    constructor(config, opts = {}) {
        super();
        this.config = config;
        this.focus = opts.focus || null;
        this.execFile = opts.execFile || hostExecFile;
        this.now = opts.now || (() => Date.now() / 1000);
        this.port = num(opts.port, DEFAULT_PORT);
        this.hookSource = opts.hookSource || path.resolve(__dirname, '../../scripts', HOOK_NAME);
        this.hookDir = expandHome(opts.hookDir || process.env.MATDECK_CLAUDE_HOOK_DIR || DEFAULT_HOOK_DIR);
        this.scanActiveMs = opts.scanActiveMs || SCAN_ACTIVE_MS;
        this.scanIdleMs = opts.scanIdleMs || SCAN_IDLE_MS;
        this.tickMs = opts.tickMs || TICK_MS;
        this.records = [];
        this.summary = aggregate([], this.now(), DEFAULT_TTL);
        this.dirExists = false;
        this.lastRead = 0;
        this.viewers = false;
        this.stopped = true;
        this.scanning = false;
        this.queued = false;
        this.scanPromise = null;
        this.scanTimer = null;
        this.tickTimer = null;
        this.lastKeys = [this.summary.key, this.summary.tool_key, this.summary.since_key];
        this.loggedScanError = false;
        this.loggedInstallError = false;
    }

    settings() {
        let cfg = {};
        try { cfg = (this.config && this.config.get('claude')) || {}; } catch (e) { /* padrões */ }
        const minutes = (v, def) => Math.round(num(v, def) * 60);
        return {
            dir: expandHome(process.env.MATDECK_CLAUDE_STATE_DIR || str(cfg.sessionsDir).trim() || DEFAULT_DIR),
            slots: Math.max(1, Math.min(MAX_SLOTS, Math.round(Number.isFinite(cfg.slots) ? cfg.slots : 4))),
            ttl: {
                workingTtl: minutes(cfg.workingMinutes, DEFAULT_TTL.workingTtl / 60),
                doneTtl: minutes(cfg.doneMinutes, DEFAULT_TTL.doneTtl / 60),
                waitingTtl: minutes(cfg.waitingMinutes, DEFAULT_TTL.waitingTtl / 60),
                staleTtl: minutes(cfg.staleMinutes, DEFAULT_TTL.staleTtl / 60)
            }
        };
    }

    hookPath() {
        return path.join(this.hookDir, HOOK_NAME);
    }

    snapshot() {
        const { dir, slots } = this.settings();
        const s = this.summary;
        return JSON.parse(JSON.stringify({
            dir,
            dirExists: this.dirExists,
            lastRead: this.lastRead,
            slots,
            hookPath: this.hookPath(),
            port: this.port,
            state: s.state,
            counts: s.counts,
            total: s.total,
            sessions: s.sessions
        }));
    }

    /** Aparência atual de uma tecla `claude:*` (null para ações desconhecidas). */
    stateFor(actionId) {
        return keyStateFor(actionId, this.summary, this.settings().slots);
    }

    /** Intervalo atual entre varreduras do disco. */
    scanMs() {
        return this.viewers ? this.scanActiveMs : this.scanIdleMs;
    }

    // ------------------------------------------------------------------
    // Ciclo de vida
    // ------------------------------------------------------------------

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        this.installHookQuietly();
        this.tickTimer = setInterval(() => this.tick(), this.tickMs);
        if (this.tickTimer.unref) this.tickTimer.unref();
        this.refreshNow().catch(() => {}).then(() => this.scheduleScan());
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.scanTimer); this.scanTimer = null;
        clearInterval(this.tickTimer); this.tickTimer = null;
    }

    /** Configuração mudou (Ajustes): reinstala o hook se preciso, varre de novo e reagenda. */
    reconnect() {
        this.installHookQuietly();
        return this.refreshNow().catch(() => {}).then(() => this.scheduleScan());
    }

    /** Há (ou não) alguém olhando o deck: varredura rápida só enquanto há. */
    setActive(viewers) {
        const next = !!viewers;
        if (next === this.viewers) return;
        this.viewers = next;
        if (this.stopped) return;
        if (next) this.refreshNow().catch(() => {});   // o que está na tela pode ter ficado velho durante a espera longa
        this.scheduleScan();
    }

    scheduleScan() {
        if (this.stopped) return;
        clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => {
            this.scanTimer = null;
            this.refreshNow().catch(() => {}).then(() => this.scheduleScan());
        }, this.scanMs());
        if (this.scanTimer.unref) this.scanTimer.unref();
    }

    /** Uma varredura do disco. Durante uma varredura, novos pedidos viram uma única varredura a mais. */
    refreshNow() {
        if (this.scanning) {
            this.queued = true;
            return this.scanPromise;
        }
        this.scanning = true;
        this.scanPromise = (async () => {
            try {
                do {
                    this.queued = false;
                    await this.scanOnce();
                } while (this.queued);
            } finally {
                this.scanning = false;
            }
        })();
        return this.scanPromise;
    }

    /** Recalcula o "há quanto tempo" sem ler o disco. */
    tick() {
        this.recompute();
    }

    run(script, args, options = {}) {
        return new Promise((resolve, reject) => {
            this.execFile('sh', ['-c', script, 'sh', ...args], { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, ...options }, (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
        });
    }

    async scanOnce() {
        const { dir } = this.settings();
        let scan;
        try {
            scan = parseScan(await this.run(SCAN_SH, [dir]));
            const paths = [...new Set(scan.records.map((r) => r.transcript_path).filter((p) => typeof p === 'string' && p))];
            if (paths.length) {
                const mtimes = (await this.run(STAT_SH, paths)).split('\n');
                const byPath = new Map(paths.map((p, i) => [p, Number(mtimes[i]) || 0]));
                for (const record of scan.records) {
                    const mtime = byPath.get(record.transcript_path);
                    if (mtime > 0) record.activity = mtime;
                }
            }
            this.loggedScanError = false;
        } catch (e) {
            if (!this.loggedScanError) { this.loggedScanError = true; console.warn(`[Claude] Falha ao ler as sessões: ${e.message}`); }
            return;   // mantém o último estado conhecido
        }
        this.dirExists = scan.dirExists;
        this.records = scan.records;
        this.lastRead = this.now();
        this.recompute();
    }

    recompute() {
        this.summary = aggregate(this.records, this.now(), this.settings().ttl);
        const keys = [this.summary.key, this.summary.tool_key, this.summary.since_key];
        if (keys.every((k, i) => k === this.lastKeys[i])) return;
        this.lastKeys = keys;
        this.emit('change', this.snapshot());
    }

    // ------------------------------------------------------------------
    // Instalação do hook (cópia em ~/.local/state/matdeck e porta do servidor)
    // ------------------------------------------------------------------

    readHostFile(file) {
        return this.run('cat "$1" 2>/dev/null', [file]).catch(() => null);
    }

    writeHostFile(file, content) {
        return new Promise((resolve, reject) => {
            const child = this.execFile('sh', ['-c', WRITE_SH, 'sh', file], { timeout: EXEC_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
            child.stdin.end(content);
        });
    }

    /** Grava o hook e a porta pelo host, só se o conteúdo difere do que já está lá. */
    async installHook() {
        const hookPath = this.hookPath();
        const portPath = path.join(this.hookDir, 'port');
        const script = fs.readFileSync(this.hookSource, 'utf8');
        if (await this.readHostFile(hookPath) !== script) await this.writeHostFile(hookPath, script);
        const existingPort = await this.readHostFile(portPath);
        if (existingPort === null || existingPort.trim() !== String(this.port)) await this.writeHostFile(portPath, `${this.port}\n`);
        return { hookPath, port: this.port };
    }

    installHookQuietly() {
        this.installHook().then(() => { this.loggedInstallError = false; }, (e) => {
            if (this.loggedInstallError) return;
            this.loggedInstallError = true;
            console.warn(`[Claude] Não foi possível instalar o hook: ${e.message}`);
        });
    }

    // ------------------------------------------------------------------
    // Ações
    // ------------------------------------------------------------------

    /** Sessão que a tecla representa: vaga N, ou (summary) a primeira waiting, senão a primeira working. */
    sessionFor(actionId) {
        const sessions = this.summary.sessions;
        const slot = /^claude:slot:(\d+)$/.exec(String(actionId));
        if (slot) {
            const n = Number(slot[1]);
            return n >= 1 && n <= this.settings().slots ? sessions[n - 1] || null : null;
        }
        if (actionId === 'claude:summary') return sessions.find((s) => s.state === 'waiting') || sessions.find((s) => s.state === 'working') || null;
        return null;
    }

    /** Ação de tecla `claude:*`: em keyDown foca a janela do terminal da sessão. Devolve se alguma janela foi focada. */
    async handleAction(actionId, eventType) {
        if (eventType !== 'keyDown') return false;
        const session = this.sessionFor(actionId);
        if (!session) { console.log(`[Claude] ${actionId}: nenhuma sessão para focar`); return false; }
        const win = session.window;
        if (!win) { console.log(`[Claude] ${session.name}: sessão sem janela registrada (o hook ainda não passou por ela)`); return false; }
        if (!this.focus) { console.log('[Claude] foco de janela indisponível'); return false; }
        const pids = Array.isArray(win.pids) ? win.pids.filter((p) => Number.isInteger(p) && p > 1) : [];
        const hint = classHintFor(win.term_program);
        try {
            if (pids.length && await this.focus({ pids })) return true;
            if (hint && await this.focus({ classHints: [hint] })) return true;
        } catch (e) {
            console.log(`[Claude] Falha ao focar ${session.name}: ${e.message}`);
            return false;
        }
        console.log(`[Claude] ${session.name}: janela não encontrada`);
        return false;
    }
}

ClaudeSessions.effectiveState = effectiveState;
ClaudeSessions.sessionLabel = sessionLabel;
ClaudeSessions.shortTool = shortTool;
ClaudeSessions.activityText = activityText;
ClaudeSessions.aggregate = aggregate;
ClaudeSessions.parseScan = parseScan;
ClaudeSessions.classHintFor = classHintFor;
ClaudeSessions.keyStateFor = keyStateFor;
ClaudeSessions.sinceText = sinceText;
ClaudeSessions.DEFAULT_DIR = DEFAULT_DIR;
ClaudeSessions.DEFAULT_TTL = DEFAULT_TTL;

module.exports = ClaudeSessions;
