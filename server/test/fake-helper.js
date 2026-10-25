// Helper falso para os testes da camada macOS no Linux: um servidor de socket Unix que fala o protocolo
// JSON por linha do MatDeck Helper. Registra os pedidos, responde pelos handlers configurados e emite eventos.
//
//   const fake = await require('../fake-helper').start({ socketPath, hello: {...}, handlers: { 'key.shortcut': (args) => ({}) } });
//   fake.requests            -> [{ id, op, args }]
//   fake.setHandler(op, fn)  -> fn(args) devolve o result (ou Promise) ou lança { code, message }
//   fake.emit(event, data)   -> manda um evento ao cliente conectado
//   fake.raw(texto)          -> manda bytes crus (linhas inválidas, lixo)
//   fake.disconnectClient()  -> derruba o cliente atual
//   fake.busyMode = true     -> conexões novas recebem {"event":"busy"} e são fechadas (conta em busyCount)
//   await fake.close()
const fs = require('fs');
const net = require('net');

const MAX_LINE = 1024 * 1024;

async function start({ socketPath, hello, handlers = {} } = {}) {
    if (!socketPath) throw new Error('socketPath obrigatório');
    const helloResult = hello || { version: '0.0.0-fake', pid: process.pid, platform: { version: '15.0.0', arch: 'x86_64' }, permissions: { accessibility: true } };
    const fake = {
        requests: [],
        handlers: { ...handlers },
        client: null,
        busyMode: false,
        busyCount: 0,
        setHandler(op, fn) { this.handlers[op] = fn; },
        emit(event, data) { if (this.client) this.client.write(JSON.stringify({ event, data }) + '\n'); },
        raw(text) { if (this.client) this.client.write(text); },
        disconnectClient() { if (this.client) { this.client.destroy(); this.client = null; } },
        close() {
            return new Promise((resolve) => {
                this.disconnectClient();
                server.close(() => { try { fs.unlinkSync(socketPath); } catch (e) {} resolve(); });
            });
        }
    };

    const server = net.createServer((sock) => {
        if (fake.busyMode || fake.client) {
            fake.busyCount++;
            sock.write(JSON.stringify({ event: 'busy', data: {} }) + '\n');
            sock.end();
            return;
        }
        fake.client = sock;
        let buf = '';
        sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line || line.length > MAX_LINE) continue;
                let req;
                try { req = JSON.parse(line); } catch (e) { continue; }
                fake.requests.push(req);
                Promise.resolve().then(async () => {
                    try {
                        let result;
                        if (req.op === 'hello') result = helloResult;
                        else if (fake.handlers[req.op]) result = await fake.handlers[req.op](req.args || {});
                        else throw { code: 'bad_request', message: `operação desconhecida: ${req.op}` };
                        if (sock === fake.client) sock.write(JSON.stringify({ id: req.id, ok: true, result: result === undefined ? {} : result }) + '\n');
                    } catch (e) {
                        if (sock === fake.client) sock.write(JSON.stringify({ id: req.id, ok: false, error: (e && e.code) || 'internal_error', message: (e && e.message) || String(e) }) + '\n');
                    }
                });
            }
        });
        sock.on('close', () => { if (fake.client === sock) fake.client = null; });
        sock.on('error', () => {});
    });

    try { fs.unlinkSync(socketPath); } catch (e) {}
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    return fake;
}

module.exports = { start };
