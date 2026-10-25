// Adaptador de janelas do macOS (platform/darwin/windows.js) contra o helper falso: detector por eventos,
// casamento de perfil por bundle id e título, foco com tradução de classHints para bundle ids.
// Uso: node darwin-windows.test.js [caminho de server/src]
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
const { createWindows } = require(path.join(SRC, 'platform', 'darwin', 'windows'));
const { CLASS_TO_BUNDLE, BUNDLE_TO_PROFILE } = require(path.join(SRC, 'platform', 'darwin', 'bundleIds'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-win-'));
const sock = path.join(tmp, 'h.sock');

(async () => {
    const fake = await fakeHelper.start({ socketPath: sock });
    let focusResult = { focused: true, how: 'window' };
    fake.setHandler('window.subscribe', () => ({}));
    fake.setHandler('window.focus', () => focusResult);
    fake.setHandler('window.active', () => ({ app: 'Finder', bundleId: 'com.apple.finder', pid: 1, title: '' }));
    fake.setHandler('key.shortcut', () => ({}));
    const client = new HelperClient({ socketPath: sock, launch: () => {}, requestTimeoutMs: 500, backoffMs: [50, 100] });
    client.start();
    await waitFor(() => client.connected);
    const keys = createKeys(client);
    const windows = createWindows(client, keys);
    const reqs = fake.requests;
    const last = () => reqs[reqs.length - 1];

    check('tabelas de bundle ids existem', CLASS_TO_BUNDLE['brave-browser'] === 'com.brave.Browser' && BUNDLE_TO_PROFILE['com.hnc.Discord'] === 'discord');

    const changes = [];
    windows.detector.on('windowChanged', (info) => changes.push(info));
    windows.detector.setEnabled(true);
    windows.detector.start();
    check('subscribe ao ligar', await waitFor(() => reqs.some((r) => r.op === 'window.subscribe' && r.args.on === true)));
    check('describe menciona o helper', /helper/i.test(windows.detector.describe()), windows.detector.describe());

    fake.emit('window.active', { app: 'Discord', bundleId: 'com.hnc.Discord', pid: 1, title: 'Geral - Discord' });
    check('evento vira windowChanged com perfil discord', await waitFor(() => changes.length === 1) && changes[0].profile === 'discord' && changes[0].app === 'com.hnc.Discord' && changes[0].title === 'Geral - Discord', changes[0]);
    check('lastDetected acompanha', windows.detector.lastDetected.profile === 'discord');
    fake.emit('window.active', { app: 'Brave Browser', bundleId: 'com.brave.Browser', pid: 2, title: 'Reunião - Meet - Brave' });
    check('título do Meet casa por regra de título', await waitFor(() => changes.length === 2) && changes[1].profile === 'meet', changes[1]);
    fake.emit('window.active', { app: 'Brave Browser', bundleId: 'com.brave.Browser', pid: 2, title: 'Reunião - Meet - Brave' });
    await sleep(50);
    check('evento repetido não emite de novo', changes.length === 2);
    fake.emit('window.active', { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 3, title: 'Sem título' });
    check('app sem perfil emite com profile null', await waitFor(() => changes.length === 3) && changes[2].profile === null);

    check('matchProfile por bundle id', windows.matchProfile('x', 'com.obsproject.obs-studio') === 'obs' && windows.matchProfile('Spotify Premium', 'com.spotify.client') === 'spotify');
    check('DETECTABLE_APPS tem os seis apps', windows.DETECTABLE_APPS.length === 6);

    const MEET = { titleHints: ['Meet'], classHints: ['brave-browser', 'google-chrome', 'firefox', 'org.mozilla.firefox', 'vivaldi'], requireTitle: true };
    let ok = await windows.focus(MEET);
    const f = reqs.filter((r) => r.op === 'window.focus').pop();
    check('focus traduz classHints para bundleIds', ok === true && f.args.bundleIds.includes('com.brave.Browser') && f.args.bundleIds.includes('com.google.Chrome') && f.args.bundleIds.includes('org.mozilla.firefox') && f.args.titleHints[0] === 'Meet' && f.args.requireTitle === true, f && f.args);
    check('classHints sem tradução vão em names', f.args.names.includes('vivaldi'), f.args.names);
    check('bundleIds sem repetição', new Set(f.args.bundleIds).size === f.args.bundleIds.length);

    focusResult = { focused: false, how: null };
    const n0 = reqs.length;
    ok = await windows.focusAndSend(MEET, 'cmd+d', 1);
    check('focus devolve false quando helper diz focused:false', ok === false);
    check('focusAndSend não envia tecla se não focou', !reqs.slice(n0).some((r) => r.op === 'key.shortcut'));

    focusResult = { focused: true, how: 'tab' };
    ok = await windows.focusAndSend(MEET, 'cmd+d', 1);
    check('focusAndSend envia depois de focar', ok === true && reqs.slice(-2).map((r) => r.op).join(',') === 'window.focus,key.shortcut' && last().args.keys.join('+') === 'cmd+d');

    fake.setHandler('window.focus', () => { throw { code: 'accessibility_denied', message: 'negada' }; });
    check('accessibility_denied no foco devolve false', (await windows.focus(MEET)) === false);

    windows.detector.setEnabled(false);
    check('setEnabled(false) manda subscribe off', await waitFor(() => reqs.some((r) => r.op === 'window.subscribe' && r.args.on === false)));
    fake.emit('window.active', { app: 'OBS', bundleId: 'com.obsproject.obs-studio', pid: 4, title: 'OBS' });
    await sleep(50);
    check('desligado ignora eventos', changes.length === 3);

    windows.detector.stop();
    await client.stop();
    await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(fails ? `\n${fails} FALHA(S)` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('ERRO', e); process.exit(2); });
