// Cliente do MatDeck Helper (macOS): socket Unix, JSON por linha, pedidos com id e timeout, eventos,
// relançamento do helper por `open -a` quando o socket não responde e reconexão com recuo.
const EventEmitter = require('events');
const net = require('net');
const { spawn } = require('child_process');

const MAX_LINE = 1024 * 1024;

function defaultLaunch(appPath, socketPath) {
    const child = spawn('open', ['-a', appPath, '--args', '--socket', socketPath], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.warn(`[Helper] Falha ao abrir ${appPath}: ${e.message}`));
    child.unref();
}

class HelperClient extends EventEmitter {
    constructor({ socketPath, appPath, launch, requestTimeoutMs = 5000, backoffMs = [2000, 5000, 15000] } = {}) {
        super();
        if (!socketPath) throw new Error('socketPath obrigatório');
        this.socketPath = socketPath;
        this.appPath = appPath || null;
        this.launch = launch || defaultLaunch;
        this.requestTimeoutMs = requestTimeoutMs;
        this.backoffMs = backoffMs;
        this.socket = null;
        this.connected = false;
        this.hello = null;
        this.stopped = true;
        this.pending = new Map();
        this.nextId = 1;
        this.buffer = '';
        this.attempt = 0;
        this.launchedThisOutage = false;
        this.reconnectTimer = null;
        this.warned = new Set();
    }

    start() {
        this.stopped = false;
        this.connect();
    }

    stop() {
        this.stopped = true;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        const sock = this.socket;
        this.teardown();
        return new Promise((resolve) => {
            if (!sock || sock.destroyed) return resolve();
            sock.once('close', () => resolve());
            sock.end();
            setTimeout(() => { try { sock.destroy(); } catch (e) {} resolve(); }, 300).unref();
        });
    }

    warnOnce(key, msg) {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        console.warn(msg);
    }

    connect() {
        if (this.stopped || this.socket) return;
        const sock = net.connect(this.socketPath);
        this.socket = sock;
        this.buffer = '';
        sock.setEncoding('utf8');
        sock.on('connect', () => {
            // A conexão só vale depois do hello (o helper pode responder busy)
            this.sendRaw({ id: this.nextId++, op: 'hello', args: {} }, (res) => {
                if (sock !== this.socket) return;
                if (!res || !res.ok) { this.warnOnce('hello', `[Helper] hello falhou: ${res && res.message}`); sock.destroy(); return; }
                this.hello = res.result || {};
                this.connected = true;
                this.attempt = 0;
                this.launchedThisOutage = false;
                this.warned.delete('busy');
                this.emit('connected', this.hello);
            });
        });
        sock.on('data', (chunk) => this.onData(chunk));
        sock.on('error', (err) => this.onConnectError(err));
        sock.on('close', () => { if (sock === this.socket) this.onDisconnect(); });
    }

    onConnectError(err) {
        const code = err && err.code;
        if (!this.connected && (code === 'ENOENT' || code === 'ECONNREFUSED') && !this.launchedThisOutage) {
            this.launchedThisOutage = true;
            if (this.appPath) {
                console.log(`[Helper] Helper não está no ar (${code}); abrindo ${this.appPath}`);
                try { Promise.resolve(this.launch(this.appPath, this.socketPath)).catch((e) => console.warn(`[Helper] launch falhou: ${e.message}`)); } catch (e) { console.warn(`[Helper] launch falhou: ${e.message}`); }
            } else {
                this.warnOnce('no-app', '[Helper] Helper não está no ar e MATDECK_HELPER_APP não aponta para o MatDeck Helper.app');
            }
        } else if (code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'ECONNRESET' && code !== 'EPIPE') {
            this.warnOnce(`err:${code}`, `[Helper] Erro no socket: ${err.message}`);
        }
        // o evento close vem em seguida e agenda a reconexão
    }

    onDisconnect() {
        const wasConnected = this.connected;
        this.teardown();
        if (wasConnected) {
            console.log('[Helper] Conexão com o helper perdida; reconectando');
            this.emit('disconnected');
        }
        this.scheduleReconnect();
    }

    teardown() {
        this.socket = null;
        this.connected = false;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(this.error('not_connected', 'helper desconectado')); }
        this.pending.clear();
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
        this.attempt++;
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
        if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
    }

    onData(chunk) {
        this.buffer += chunk;
        if (this.buffer.length > MAX_LINE && this.buffer.indexOf('\n') < 0) {
            this.warnOnce('oversize', '[Helper] Linha maior que 1 MiB descartada');
            this.buffer = '';
            this.dropping = true;
            return;
        }
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl);
            this.buffer = this.buffer.slice(nl + 1);
            if (this.dropping) { this.dropping = false; continue; }
            if (!line.trim()) continue;
            if (line.length > MAX_LINE) { this.warnOnce('oversize', '[Helper] Linha maior que 1 MiB descartada'); continue; }
            let msg;
            try { msg = JSON.parse(line); } catch (e) { this.warnOnce('badjson', '[Helper] Linha inválida do helper descartada'); continue; }
            this.onMessage(msg);
        }
    }

    onMessage(msg) {
        if (msg && msg.event) {
            if (msg.event === 'busy') {
                this.warnOnce('busy', '[Helper] Outro servidor MatDeck já está usando o helper; tentando de novo');
                if (this.socket) this.socket.destroy();
                return;
            }
            this.emit('event', { event: msg.event, data: msg.data });
            this.emit(msg.event, msg.data);
            return;
        }
        if (msg && typeof msg.id === 'number') {
            const p = this.pending.get(msg.id);
            if (!p) return;
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            p.resolve(msg);
        }
    }

    error(code, message) {
        const e = new Error(message || code);
        e.code = code;
        return e;
    }

    /** Escreve um pedido e espera a resposta crua (usado pelo hello, antes de `connected`). */
    sendRaw(req, cb) {
        const sock = this.socket;
        if (!sock) return cb(null);
        const timer = setTimeout(() => { this.pending.delete(req.id); cb({ ok: false, error: 'helper_timeout', message: 'sem resposta do helper' }); }, this.requestTimeoutMs);
        this.pending.set(req.id, { resolve: (res) => cb(res), reject: () => cb(null), timer });
        try { sock.write(JSON.stringify(req) + '\n'); } catch (e) { clearTimeout(timer); this.pending.delete(req.id); cb(null); }
    }

    request(op, args = {}) {
        if (!this.connected || !this.socket) return Promise.reject(this.error('not_connected', 'helper não conectado'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(this.error('helper_timeout', `sem resposta do helper para ${op}`));
            }, this.requestTimeoutMs);
            this.pending.set(id, {
                resolve: (res) => { if (res.ok) resolve(res.result); else reject(this.error(res.error || 'internal_error', res.message || res.error)); },
                reject,
                timer
            });
            try { this.socket.write(JSON.stringify({ id, op, args }) + '\n'); } catch (e) {
                clearTimeout(timer); this.pending.delete(id); reject(this.error('not_connected', e.message));
            }
        });
    }
}

module.exports = { HelperClient };
