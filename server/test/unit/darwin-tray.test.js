// Barra de menus do macOS (platform/darwin/tray.js) contra o helper falso e um servidor HTTP de teste.
// Uso: node darwin-tray.test.js [caminho de server/src]
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');
const fakeHelper = require('../fake-helper');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };

const { HelperClient } = require(path.join(SRC, 'platform', 'darwin', 'helperClient'));
const { createTray } = require(path.join(SRC, 'platform', 'darwin', 'tray'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-tray-'));
const sock = path.join(tmp, 'h.sock');

(async () => {
    // servidor HTTP de teste que recebe o POST /api/shutdown
    let shutdownCalls = 0;
    const srv = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/shutdown') { shutdownCalls++; res.end('{"success":true}'); return; }
        res.statusCode = 404; res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const fake = await fakeHelper.start({ socketPath: sock, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'x86_64' }, permissions: { accessibility: true } } });
    fake.setHandler('tray.set', () => ({}));
    const client = new HelperClient({ socketPath: sock, launch: () => {}, requestTimeoutMs: 500, backoffMs: [50, 100] });
    const opened = [];
    const tray = createTray(client, { openUrl: (u) => { opened.push(u); return Promise.resolve(true); } });
    const reqs = fake.requests;
    const last = () => reqs[reqs.length - 1];
    const sets = () => reqs.filter((r) => r.op === 'tray.set');

    client.start();
    await waitFor(() => client.connected);

    tray.start({ port, lanIp: '192.168.0.10', enabled: true });
    await waitFor(() => sets().length === 1);
    let req = last();
    check('start manda tray.set visível com 4 itens', req.op === 'tray.set' && req.args.visible === true && req.args.items.length === 4 && new RegExp(String(port)).test(req.args.tooltip) && /192\.168\.0\.10/.test(req.args.tooltip), req.args);
    check('itens manage/deck/stop/hide com rótulos', JSON.stringify(req.args.items.map((i) => i.id)) === '["manage","deck","stop","hide"]' && req.args.items.every((i) => i.label), req.args.items);
    check('estado inicial amber', req.args.state === 'amber');

    tray.update({ clients: 2 });
    await waitFor(() => sets().length === 2);
    check('update com cliente fica verde', last().args.state === 'green', last().args);
    tray.update({ clients: 2 });
    await sleep(100);
    check('update sem mudança não repete tray.set', sets().length === 2);
    tray.update({ clients: 0 });
    await waitFor(() => sets().length === 3);
    check('update sem clientes volta a amber', last().args.state === 'amber');

    fake.emit('tray.menu', { id: 'manage' });
    await waitFor(() => opened.length === 1);
    check('menu manage abre o gerenciador', opened[0] === `http://localhost:${port}/manage`, opened);
    fake.emit('tray.menu', { id: 'deck' });
    await waitFor(() => opened.length === 2);
    check('menu deck abre o deck', opened[1] === `http://localhost:${port}/`, opened);
    fake.emit('tray.click', {});
    await waitFor(() => opened.length === 3);
    check('clique no ícone abre o gerenciador', opened[2] === `http://localhost:${port}/manage`, opened);
    fake.emit('tray.menu', { id: 'stop' });
    await waitFor(() => shutdownCalls === 1);
    check('menu stop chama POST /api/shutdown', shutdownCalls === 1);
    fake.emit('tray.menu', { id: 'hide' });
    await waitFor(() => sets().length === 4);
    check('menu hide esconde o ícone', last().args.visible === false, last().args);
    fake.emit('tray.menu', { id: 'desconhecido' });
    await sleep(100);
    check('item desconhecido não faz nada', opened.length === 3 && shutdownCalls === 1 && sets().length === 4);

    // reconexão: reenvia o estado atual
    tray.update({ clients: 1 });
    await waitFor(() => sets().length === 5);
    const n = sets().length;
    fake.disconnectClient();
    await waitFor(() => !client.connected);
    await waitFor(() => client.connected, 3000);
    await waitFor(() => sets().length > n);
    check('reconectar reenvia tray.set com o estado atual', sets().length === n + 1 && last().args.state === 'green', last().args);

    const stopped = tray.stop();
    check('stop devolve Promise', stopped && typeof stopped.then === 'function');
    await stopped;
    check('stop esconde o ícone', last().args.visible === false, last().args);

    // start com enabled:false não manda nada
    const before = reqs.length;
    const tray2 = createTray(client, { openUrl: () => {} });
    tray2.start({ port, lanIp: '10.0.0.1', enabled: false });
    await sleep(100);
    check('start desligado não fala com o helper', reqs.length === before);
    await tray2.stop();

    await client.stop();
    await fake.close();
    srv.close();
    console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('ERRO', e); process.exitCode = 1; });
