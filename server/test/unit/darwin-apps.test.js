// Adaptador de aplicativos do macOS (platform/darwin/apps.js) contra o helper falso.
// Uso: node darwin-apps.test.js [caminho de server/src]
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
const { createApps } = require(path.join(SRC, 'platform', 'darwin', 'apps'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-apps-'));
const sock = path.join(tmp, 'h.sock');
// PNG 1×1 transparente
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
    const fake = await fakeHelper.start({ socketPath: sock, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'x86_64' }, permissions: { accessibility: true } } });
    fake.setHandler('apps.list', () => ({ apps: [
        { id: 'com.apple.Safari', name: 'Safari', path: '/Applications/Safari.app' },
        { id: 'com.apple.calculator', name: 'Calculadora', path: '/System/Applications/Calculator.app' }
    ] }));
    fake.setHandler('apps.icon', () => ({ png: PNG_1x1 }));
    fake.setHandler('apps.launch', () => ({ launched: true }));
    fake.setHandler('apps.open', () => ({ opened: true }));
    const client = new HelperClient({ socketPath: sock, launch: () => {}, requestTimeoutMs: 500, backoffMs: [50, 100] });
    client.start();
    await waitFor(() => client.connected);
    const apps = createApps(client);
    const last = () => fake.requests[fake.requests.length - 1];

    const list = await apps.launcher.list();
    check('list devolve resumos ordenados com iconUrl', list.length === 2 && list[0].name === 'Calculadora' && list[0].iconUrl === '/api/apps/com.apple.calculator/icon', list);
    check('list usa o cache na segunda chamada', (await apps.launcher.list(), fake.requests.filter((r) => r.op === 'apps.list').length === 1));
    check('summaries sem helper devolve o cache', apps.launcher.summaries().length === 2);

    const icon = await apps.launcher.iconOf('com.apple.calculator');
    await apps.launcher.iconOf('com.apple.calculator');
    check('iconOf pede ao helper uma vez e guarda', !!icon && icon.mime === 'image/png' && icon.buffer.length > 0 && fake.requests.filter((r) => r.op === 'apps.icon').length === 1, icon);
    check('iconOf de id desconhecido é null', (await apps.launcher.iconOf('nao.existe')) === null);
    const dataUrl = await apps.launcher.iconDataUrl('com.apple.calculator');
    check('iconDataUrl devolve data URL PNG', typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,'), dataUrl);

    let ok = await apps.launcher.launch('com.apple.Safari');
    check('launch manda apps.launch', ok === true && last().op === 'apps.launch' && last().args.id === 'com.apple.Safari', last());
    ok = await apps.launcher.launch('nao.existe');
    check('launch de id desconhecido é false sem pedir ao helper', ok === false && last().op === 'apps.launch' && last().args.id === 'com.apple.Safari');

    ok = await apps.open('https://google.com');
    check('open manda apps.open', ok === true && last().op === 'apps.open' && last().args.target === 'https://google.com', last());
    ok = await apps.launchFile('xdg-open', ['discord://']);
    check('launchFile xdg-open vira open', ok === true && last().op === 'apps.open' && last().args.target === 'discord://', last());
    ok = await apps.launchFile('flatpak', ['run', 'x']);
    check('launchFile flatpak é false', ok === false);
    ok = await apps.launchFile('safari', []);
    check('launchFile por nome acha o app na lista', ok === true && last().op === 'apps.launch' && last().args.id === 'com.apple.Safari', last());
    ok = await apps.launchFile('programa-inexistente', []);
    check('launchFile de nome desconhecido é false', ok === false);
    ok = await apps.launchFirst([['kcalc'], ['gnome-calculator']], 'calculadora');
    check('launchFirst calculadora vira Calculator', ok === true && last().op === 'apps.launch' && last().args.id === 'com.apple.calculator', last());
    ok = await apps.launchFirst([['konsole']], 'terminal');
    check('launchFirst terminal vira Terminal', ok === true && last().args.id === 'com.apple.Terminal', last());
    ok = await apps.launchFirst([['x']], 'outro');
    check('launchFirst de rótulo desconhecido é false', ok === false);
    check('flatpakInstalled/commandExists são false', (await apps.flatpakInstalled('x')) === false && apps.commandExists('discord') === false);

    // helper caído: list devolve o cache, launch devolve false
    await client.stop();
    await fake.close();
    ok = await apps.launcher.launch('com.apple.Safari');
    check('launch com helper desconectado é false', ok === false);
    check('reload sem helper mantém a lista anterior', (await apps.launcher.reload().catch(() => 'erro')) !== 'erro' && apps.launcher.summaries().length === 2);

    console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('ERRO', e); process.exitCode = 1; });
