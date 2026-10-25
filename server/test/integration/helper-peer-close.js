// Roda NO MAC contra um helper vivo: um cliente que fecha a conexão antes de ler a resposta não pode
// derrubar o helper (SIGPIPE). Uso: node helper-peer-close.js [caminho do socket]
const net = require('net');
const path = require('path');
const os = require('os');

const socketPath = process.argv[2] || path.join(os.homedir(), 'Library/Application Support/MatDeck/helper.sock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
    return new Promise((resolve, reject) => {
        const s = net.createConnection(socketPath);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
    });
}

async function helloRoundTrip() {
    const s = await connect();
    s.write('{"id":1,"op":"hello","args":{}}\n');
    const line = await new Promise((resolve, reject) => {
        let buf = '';
        s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i)); });
        s.once('error', reject);
        setTimeout(() => reject(new Error('sem resposta em 5 s')), 5000);
    });
    s.destroy();
    return JSON.parse(line);
}

(async () => {
    let failed = 0;
    const check = (name, ok) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`); if (!ok) failed++; };

    const before = await helloRoundTrip();
    check('helper responde hello antes', before.ok === true && typeof before.result.pid === 'number');

    // cliente apressado: manda o pedido e fecha sem ler
    for (let i = 0; i < 3; i++) {
        const s = await connect();
        s.write('{"id":2,"op":"hello","args":{}}\n');
        s.destroy();
        await sleep(200);
    }
    await sleep(500);

    let after = null;
    try { after = await helloRoundTrip(); } catch (e) { console.log(`  (${e.message})`); }
    check('helper continua vivo depois de clientes que fecham sem ler', !!after && after.ok === true);
    check('mesmo processo (não foi relançado)', !!after && after.result.pid === before.result.pid);

    console.log(failed ? `\n${failed} falha(s)` : '\nTodos passaram');
    process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('ERRO', e.message); process.exitCode = 1; });
