// Recarga periódica do deck (ui.deckReloadMinutes): o servidor manda {event:'reload', force:true} só para clientes que se
// apresentaram como deck (clientHello); 0 desliga; o deck recarrega com `force` e tem um vigia da tela "achatada" (iPad 2).
// Sobe o servidor em processo (plataforma darwin com helper falso) em pastas temporárias. Uso: node deck-reload.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const WebSocket = require('ws');
const fakeHelper = require('../fake-helper');

let fails = 0;
const out = console.log;
const logged = [];
const check = (n, ok, extra) => { out((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(25); } return true; };
const root = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-reload-'));
const sock = path.join(tmp, 'h.sock');
const port = 21000 + Math.floor(Math.random() * 1000);

(async () => {
    // --- deck: trata `force` e tem o vigia (texto do app.js e do legado)
    const appSrc = read('server/web/app.js');
    const grab = (name) => { const i = appSrc.indexOf(`function ${name}(`); if (i < 0) throw new Error(`function ${name} não encontrada`); let depth = 0, j = appSrc.indexOf('{', i); for (let k = j; k < appSrc.length; k++) { if (appSrc[k] === '{') depth++; else if (appSrc[k] === '}') { depth--; if (!depth) return appSrc.slice(i, k + 1); } } };
    const broken = vm.runInNewContext(grab('layoutLooksBroken') + '; layoutLooksBroken', { Number, isFinite });
    check('vigia: tecla com 8 px numa janela de 672 px = quebrado', broken({ offsetHeight: 8 }, { innerHeight: 672 }) === true);
    check('vigia: tecla com 120 px = normal', broken({ offsetHeight: 120 }, { innerHeight: 672 }) === false);
    check('vigia: janela pequena (teclado/split) não conta', broken({ offsetHeight: 8 }, { innerHeight: 200 }) === false);
    check('vigia: tecla ainda não desenhada (0 px) não conta', broken({ offsetHeight: 0 }, { innerHeight: 672 }) === false && broken(null, { innerHeight: 672 }) === false);
    check('deck recarrega com msg.force e roda o vigia periodicamente', /msg\.force/.test(appSrc) && /setInterval\(checkLayoutHealth/.test(appSrc));
    check('app.legacy.js regenerado com o vigia', /layoutLooksBroken/.test(read('server/web/app.legacy.js')));
    check('Ajustes → Dispositivos tem o campo ui.deckReloadMinutes', /data-path="ui\.deckReloadMinutes"/.test(read('server/web/manage.html')));

    // --- servidor
    const fake = await fakeHelper.start({ socketPath: sock, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'arm64' }, permissions: { accessibility: true } } });
    for (const op of ['permissions.status', 'window.subscribe', 'audio.master.subscribe']) fake.setHandler(op, () => ({ accessibility: true, subscribed: true }));
    fake.setHandler('window.active', () => ({ app: 'Finder', bundleId: 'com.apple.finder', pid: 1, title: '' }));
    fake.setHandler('audio.master.get', () => ({ volume: 30, muted: false }));
    fake.setHandler('apps.list', () => ({ apps: [] }));
    Object.assign(process.env, { MATDECK_PLATFORM: 'darwin', MATDECK_HELPER_SOCKET: sock, MATDECK_DATA_DIR: path.join(tmp, 'data'), PORT: String(port), MATDECK_TRAY: '0', MATDECK_ELGATO: '0', MATDECK_CLAUDE_STATE_DIR: path.join(tmp, 'sessions'), MATDECK_CLAUDE_HOOK_DIR: path.join(tmp, 'hook') });
    delete process.env.MATDECK_HELPER_APP;
    console.log = (...x) => logged.push(x.join(' '));
    console.warn = console.log;
    const MatDeckServer = require('../../src/index.js');
    const server = new MatDeckServer();
    check('servidor sobe', await waitFor(() => logged.some((l) => /Sessão: macOS/.test(l)), 15000), logged.slice(-5));
    check('padrão: recarga desligada (sem timer)', !server.deckReloadTimer);

    const open = async () => { const ws = new WebSocket(`ws://127.0.0.1:${port}/deck`); const msgs = []; ws.on('message', (m) => { try { msgs.push(JSON.parse(m)); } catch (e) { /* ignora */ } }); await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }); return { ws, msgs }; };
    const deck = await open();
    deck.ws.send(JSON.stringify({ event: 'clientHello', device: 'Web Client', version: '1.3.1', width: 1024, height: 768 }));
    const other = await open();   // cliente sem clientHello (como o gerenciador)
    await sleep(200);
    const reloads = (c) => c.msgs.filter((m) => m.event === 'reload' && m.force === true).length;

    server.config.set('ui', { deckReloadMinutes: 0.01 });   // 600 ms
    check('ao configurar, o timer é armado', !!server.deckReloadTimer);
    check('deck recebe reload force dentro do intervalo', await waitFor(() => reloads(deck) >= 1, 3000), deck.msgs.slice(-3));
    check('e recebe de novo no intervalo seguinte', await waitFor(() => reloads(deck) >= 2, 3000));
    check('cliente sem clientHello (gerenciador) não recebe', reloads(other) === 0, other.msgs.filter((m) => m.event === 'reload'));

    server.config.set('ui', { deckReloadMinutes: 0 });
    const n = reloads(deck);
    await sleep(1500);
    check('0 desliga: nenhuma recarga nova', !server.deckReloadTimer && reloads(deck) === n);

    deck.ws.close(); other.ws.close();
    await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exitCode = fails ? 1 : 0;
    out(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.kill(process.pid, 'SIGTERM');
})().catch((e) => { out('ERRO', e); process.exitCode = 1; process.kill(process.pid, 'SIGTERM'); });
