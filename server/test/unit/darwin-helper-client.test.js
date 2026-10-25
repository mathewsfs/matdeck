// HelperClient (platform/darwin/helperClient.js) contra o helper falso (test/fake-helper.js): conexão, hello,
// pedidos, erros, timeout, eventos, relançamento, reconexão, lixo na linha e busy.
// Uso: node darwin-helper-client.test.js [caminho de server/src]
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');
const fakeHelper = require('../fake-helper');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };

const { HelperClient } = require(path.join(SRC, 'platform', 'darwin', 'helperClient'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-helper-'));
const sock = path.join(tmp, 'h.sock');

(async () => {
    // --- helper já no ar ---
    let fake = await fakeHelper.start({ socketPath: sock, hello: { version: '9.9.9', pid: 1, permissions: { accessibility: true } } });
    fake.setHandler('echo', (args) => args);
    fake.setHandler('deny', () => { throw { code: 'accessibility_denied', message: 'negada' }; });
    fake.setHandler('never', () => new Promise(() => {}));

    let launched = 0;
    const client = new HelperClient({ socketPath: sock, appPath: '/x/MatDeck Helper.app', launch: () => { launched++; }, requestTimeoutMs: 200, backoffMs: [50, 100, 150] });
    client.start();
    check('conecta e faz hello', await waitFor(() => client.connected && client.hello), client.hello);
    check('hello traz a versão do helper', client.hello && client.hello.version === '9.9.9', client.hello);
    check('request devolve result', (await client.request('echo', { a: 1 })).a === 1);
    let err = null; try { await client.request('deny'); } catch (e) { err = e; }
    check('erro do helper vira Error com code', err && err.code === 'accessibility_denied' && /negada/.test(err.message), err && err.code);
    err = null; try { await client.request('never'); } catch (e) { err = e; }
    check('timeout vira helper_timeout', err && err.code === 'helper_timeout', err && err.code);
    let got = null; client.once('window.active', (data) => { got = data; });
    let gotGeneric = null; client.once('event', (ev) => { gotGeneric = ev; });
    fake.emit('window.active', { app: 'Safari' });
    check('evento chega pelo nome e pelo genérico', await waitFor(() => got && gotGeneric) && got.app === 'Safari' && gotGeneric.event === 'window.active', got);

    // --- lixo e linha gigante não derrubam ---
    fake.raw('isto não é json\n');
    fake.raw(JSON.stringify({ event: 'x', data: { big: 'a'.repeat(2 * 1024 * 1024) } }) + '\n');
    await sleep(100);
    check('linha inválida/gigante não derruba', client.connected === true && (await client.request('echo', { b: 2 })).b === 2);

    // --- desconexão e reconexão ---
    let disconnected = false; client.once('disconnected', () => { disconnected = true; });
    fake.disconnectClient();
    check('desconexão emite disconnected', await waitFor(() => disconnected));
    err = null; try { await client.request('echo', {}); } catch (e) { err = e; }
    check('request sem conexão rejeita com not_connected', err && err.code === 'not_connected', err && err.code);
    check('reconecta sozinho', await waitFor(() => client.connected, 3000));
    check('não relançou o helper (socket ainda existia)', launched === 0, launched);

    // --- helper morto: relança e reconecta ---
    await fake.close();
    check('helper fechado: desconecta', await waitFor(() => !client.connected));
    let relaunchFake = null;
    client.launch = async () => { launched++; relaunchFake = await fakeHelper.start({ socketPath: sock, hello: { version: '9.9.10', pid: 2, permissions: { accessibility: false } } }); };
    check('sem helper no socket chama launch e reconecta', await waitFor(() => client.connected && client.hello && client.hello.version === '9.9.10', 4000) && launched === 1, { launched, hello: client.hello });

    // --- busy: outro servidor já conectado ---
    relaunchFake.busyMode = true;
    relaunchFake.disconnectClient();
    await sleep(400);
    check('busy: fica desconectado e tenta de novo', client.connected === false && relaunchFake.busyCount >= 1, relaunchFake.busyCount);
    relaunchFake.busyMode = false;
    check('depois do busy reconecta', await waitFor(() => client.connected, 3000));

    await client.stop();
    check('stop desconecta e não reconecta mais', client.connected === false && await waitFor(() => !client.reconnectTimer));
    await relaunchFake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(fails ? `\n${fails} FALHA(S)` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;   // sem process.exit: ele cortaria o stdout no pipe
})().catch((e) => { console.error('ERRO', e); process.exit(2); });
