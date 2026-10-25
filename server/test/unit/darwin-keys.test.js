// Adaptador de teclas do macOS (platform/darwin/keys.js) contra o helper falso.
// Uso: node darwin-keys.test.js [caminho de server/src]
const fs = require('fs');
const os = require('os');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');
const fakeHelper = require('../fake-helper');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };

const { HelperClient } = require(path.join(SRC, 'platform', 'darwin', 'helperClient'));
const { createKeys } = require(path.join(SRC, 'platform', 'darwin', 'keys'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-keys-'));
const sock = path.join(tmp, 'h.sock');

(async () => {
    const fake = await fakeHelper.start({ socketPath: sock, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'x86_64' }, permissions: { accessibility: true } } });
    const okAll = () => ({});
    fake.setHandler('key.shortcut', okAll); fake.setHandler('key.down', okAll); fake.setHandler('key.up', okAll); fake.setHandler('key.media', okAll);
    fake.setHandler('permissions.status', () => ({ accessibility: true }));
    const client = new HelperClient({ socketPath: sock, launch: () => {}, requestTimeoutMs: 500, backoffMs: [50, 100] });
    client.start();
    await waitFor(() => client.connected);
    const keys = createKeys(client);
    const last = () => fake.requests[fake.requests.length - 1];

    let ok = await keys.shortcut('ctrl+shift+m');
    check('shortcut manda key.shortcut com lista', ok === true && last().op === 'key.shortcut' && JSON.stringify(last().args.keys) === '["ctrl","shift","m"]', last());
    const n0 = fake.requests.length;
    await keys.keyDown('cmd+shift+p'); await keys.keyUp('cmd+shift+p');
    check('keyDown/keyUp', fake.requests.slice(n0).map((r) => r.op).join(',') === 'key.down,key.up' && JSON.stringify(last().args.keys) === '["cmd","shift","p"]', fake.requests.slice(n0));
    ok = await keys.mediaKey('play_pause');
    check('mediaKey play_pause', ok === true && last().op === 'key.media' && last().args.name === 'play_pause', last());
    check('mediaKey desconhecida devolve false sem pedir', (await keys.mediaKey('xyz')) === false && last().op === 'key.media' && last().args.name === 'play_pause');

    fake.setHandler('key.shortcut', () => { throw { code: 'accessibility_denied', message: 'negada' }; });
    check('accessibility_denied devolve false', (await keys.shortcut('cmd+d')) === false);
    check('segundo erro igual não lança', (await keys.shortcut('cmd+d')) === false);

    let caps = keys.capabilities(true);
    check('capabilities expõe helper/accessibility/keysReady', caps.platform === 'darwin' && caps.helper === true && caps.accessibility === true && caps.keysReady === true && caps.desktop === 'macOS' && caps.wayland === false, caps);
    check('capabilitiesCached/Stale existem', typeof keys.capabilitiesCached().keysReady === 'boolean' && typeof keys.capabilitiesStale() === 'boolean');
    check('hostVisibleTmpDir devolve pasta', typeof keys.hostVisibleTmpDir() === 'string' && keys.hostVisibleTmpDir().length > 0);

    // helper caiu no meio: keyUp devolve false, não lança, e caps refletem
    fake.disconnectClient();
    await waitFor(() => !client.connected);
    check('helper desconectado: keyUp devolve false sem lançar', (await keys.keyUp('cmd+shift+p')) === false);
    caps = keys.capabilities(true);
    check('helper desconectado: keysReady false', caps.helper === false && caps.keysReady === false, caps);

    await client.stop();
    await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(fails ? `\n${fails} FALHA(S)` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('ERRO', e); process.exit(2); });
