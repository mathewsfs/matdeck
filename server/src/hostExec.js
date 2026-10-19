/**
 * Execução de comandos do sistema com suporte a Flatpak.
 *
 * Fora do Flatpak é um repasse direto para child_process. Dentro do sandbox
 * (FLATPAK_ID definido) tudo passa por `flatpak-spawn --host`, para que
 * ydotool, pactl, qdbus, kdotool, xdg-open etc. rodem na sessão do usuário,
 * onde estão instalados e têm acesso ao compositor e ao áudio.
 * Exige `--talk-name=org.freedesktop.Flatpak` no manifesto.
 */
const cp = require('child_process');

const isFlatpak = Boolean(process.env.FLATPAK_ID);

// O cwd do sandbox (/app/...) não existe no host; sem isso o flatpak-spawn falha ao entrar nele
// --watch-bus: se o flatpak-spawn morrer (timeout, SIGKILL no servidor), o comando no host morre junto
const HOST_ARGS = ['--host', '--watch-bus', `--directory=${process.env.HOME || '/'}`];

/** Só variáveis que o chamador alterou de propósito são repassadas ao host. */
function hostEnvArgs(env) {
    if (!env) return [];
    const args = [];
    for (const key of Object.keys(env)) {
        if (env[key] === undefined || env[key] === process.env[key]) continue;
        args.push(`--env=${key}=${env[key]}`);
    }
    return args;
}

function normalize(options, callback) {
    if (typeof options === 'function') return [{}, options];
    return [options || {}, callback];
}

function exec(command, options, callback) {
    const [opts, cb] = normalize(options, callback);
    if (!isFlatpak) return cp.exec(command, opts, cb);
    return cp.execFile('flatpak-spawn', [...HOST_ARGS, ...hostEnvArgs(opts.env), 'sh', '-c', command], withoutEnv(opts), cb);
}

function execFile(file, args, options, callback) {
    if (!Array.isArray(args)) { callback = options; options = args; args = []; }
    const [opts, cb] = normalize(options, callback);
    if (!isFlatpak) return cp.execFile(file, args, opts, cb);
    return cp.execFile('flatpak-spawn', [...HOST_ARGS, ...hostEnvArgs(opts.env), file, ...args], withoutEnv(opts), cb);
}

function execSync(command, options = {}) {
    if (!isFlatpak) return cp.execSync(command, options);
    return cp.execFileSync('flatpak-spawn', [...HOST_ARGS, ...hostEnvArgs(options.env), 'sh', '-c', command], withoutEnv(options));
}

function spawn(file, args = [], options = {}) {
    if (!isFlatpak) return cp.spawn(file, args, options);
    return cp.spawn('flatpak-spawn', [...HOST_ARGS, ...hostEnvArgs(options.env), file, ...args], withoutEnv(options));
}

/** O env é passado por --env ao host; o flatpak-spawn em si roda com o env do sandbox. */
function withoutEnv(opts) {
    if (!opts || !opts.env) return opts;
    const copy = { ...opts };
    delete copy.env;
    return copy;
}

/** Caminho de um executável no host (ou null). Síncrono; use com cache. */
function which(bin) {
    try {
        const out = isFlatpak
            ? cp.execFileSync('flatpak-spawn', [...HOST_ARGS, 'sh', '-c', `command -v ${shellQuote(bin)}`], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
            : cp.execFileSync('sh', ['-c', `command -v ${shellQuote(bin)}`], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
        const p = out.toString().trim();
        return p || null;
    } catch (e) {
        return null;
    }
}

/** Primeiro caminho da lista que é um socket Unix gravável, visto do host. */
function firstWritableSocket(candidates) {
    const list = candidates.filter(Boolean);
    if (!list.length) return null;
    const script = list.map((c) => `if [ -S ${shellQuote(c)} ] && [ -w ${shellQuote(c)} ]; then echo ${shellQuote(c)}; exit 0; fi`).join('; ') + '; exit 1';
    try {
        const out = isFlatpak
            ? cp.execFileSync('flatpak-spawn', [...HOST_ARGS, 'sh', '-c', script], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
            : cp.execFileSync('sh', ['-c', script], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
        return out.toString().trim() || null;
    } catch (e) {
        return null;
    }
}

function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { isFlatpak, HOST_ARGS, exec, execFile, execSync, spawn, which, firstWritableSocket };
