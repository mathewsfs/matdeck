// hostExec falso para os testes da camada de plataforma: registra os comandos que o servidor geraria
// (exec, execFile, spawn, spawnDetached, which, firstWritableSocket) e devolve saídas configuradas,
// sem tocar no sistema. Instale ANTES de carregar qualquer módulo de src/ (eles capturam o hostExec no require).
//
// Uso:
//   const fake = require('../fake-host-exec');
//   const rec = fake.install({ which: { ydotool: '/usr/bin/ydotool' }, sockets: ['/tmp/.ydotool_socket'],
//                              outputs: { '/usr/bin/ydotool key 29:1': { stdout: '', code: 1 } } });
//   ... rec.calls, rec.last('execFile') ...
//   fake.uninstall();
const path = require('path');
const EventEmitter = require('events');

const HOST_EXEC_PATH = require.resolve(path.join(__dirname, '..', 'src', 'hostExec'));

function makeChild() {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {}, write() {} };
    child.kill = () => true;
    child.unref = () => {};
    return child;
}

function install(options = {}) {
    const which = options.which || {};
    const sockets = new Set(options.sockets || []);
    const outputs = options.outputs || {};
    const recorder = {
        calls: [],
        last(fn) { for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i].fn === fn) return this.calls[i]; return null; },
        reset() { this.calls.length = 0; }
    };

    function outputFor(key) {
        const o = outputs[key] || {};
        const code = o.code || 0;
        const err = code ? Object.assign(new Error(`Command failed: ${key}`), { code }) : null;
        return { err, stdout: o.stdout || '', stderr: o.stderr || '' };
    }

    function normalize(opts, cb) {
        if (typeof opts === 'function') return [{}, opts];
        return [opts || {}, cb];
    }

    const fake = {
        isFlatpak: false,
        HOST_ARGS: [],
        exec(command, opts, cb) {
            const [o, callback] = normalize(opts, cb);
            recorder.calls.push({ fn: 'exec', cmd: command, opts: o });
            const r = outputFor(command);
            if (callback) process.nextTick(() => callback(r.err, r.stdout, r.stderr));
            return makeChild();
        },
        execFile(file, args, opts, cb) {
            if (!Array.isArray(args)) { cb = opts; opts = args; args = []; }
            const [o, callback] = normalize(opts, cb);
            recorder.calls.push({ fn: 'execFile', file, args: args.slice(), opts: o });
            const r = outputFor(`${file} ${args.join(' ')}`.trim());
            if (callback) process.nextTick(() => callback(r.err, r.stdout, r.stderr));
            return makeChild();
        },
        execSync(command, opts = {}) {
            recorder.calls.push({ fn: 'execSync', cmd: command, opts });
            const r = outputFor(command);
            if (r.err) throw r.err;
            return Buffer.from(r.stdout);
        },
        spawn(file, args = [], opts = {}) {
            recorder.calls.push({ fn: 'spawn', file, args: args.slice(), opts });
            return makeChild();
        },
        spawnDetached(file, args = [], opts = {}) {
            recorder.calls.push({ fn: 'spawnDetached', file, args: args.slice(), opts });
            return makeChild();
        },
        which(bin) {
            recorder.calls.push({ fn: 'which', file: bin });
            return Object.prototype.hasOwnProperty.call(which, bin) ? which[bin] : null;
        },
        firstWritableSocket(candidates) {
            return (candidates || []).filter(Boolean).find((c) => sockets.has(c)) || null;
        }
    };

    delete require.cache[HOST_EXEC_PATH];
    require.cache[HOST_EXEC_PATH] = { id: HOST_EXEC_PATH, filename: HOST_EXEC_PATH, loaded: true, exports: fake };
    return recorder;
}

function uninstall() {
    delete require.cache[HOST_EXEC_PATH];
}

/** Descarrega módulos de src/ já carregados, para que um novo require capture o hostExec atual. */
function resetSrcModules() {
    const srcDir = path.join(__dirname, '..', 'src') + path.sep;
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(srcDir) && key !== HOST_EXEC_PATH) delete require.cache[key];
    }
}

module.exports = { install, uninstall, resetSrcModules, HOST_EXEC_PATH };
