// Montagem da plataforma macOS (platform/darwin/index.js) com o helper falso, stubs de mídia/telemetria,
// paths.dataDir() e keysReady no Linux. Uso: node darwin-platform.test.js [caminho de server/src]
const fs = require('fs');
const os = require('os');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');
const fakeHelper = require('../fake-helper');
const fakeExec = require('../fake-host-exec');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-platform-'));
const sock = path.join(tmp, 'h.sock');
process.env.MATDECK_TRAY = '0';

(async () => {
    const fake = await fakeHelper.start({ socketPath: sock, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'arm64' }, permissions: { accessibility: true } } });
    fake.setHandler('permissions.status', () => ({ accessibility: true }));
    fake.setHandler('window.subscribe', () => ({ subscribed: true }));
    fake.setHandler('audio.master.get', () => ({ volume: 30, muted: false }));
    fake.setHandler('audio.master.subscribe', () => ({ subscribed: true }));
    fake.setHandler('apps.list', () => ({ apps: [{ id: 'com.apple.Safari', name: 'Safari', path: '/Applications/Safari.app' }] }));
    fake.setHandler('tray.set', () => ({}));

    // --- darwin com helper
    process.env.MATDECK_PLATFORM = 'darwin';
    process.env.MATDECK_HELPER_SOCKET = sock;
    delete process.env.MATDECK_DATA_DIR;
    fakeExec.resetSrcModules();
    const { createPlatform } = require(path.join(SRC, 'platform'));
    const { dataDir } = require(path.join(SRC, 'paths'));
    const p = createPlatform();
    await waitFor(() => p.helper && p.helper.connected);
    check('createPlatform devolve darwin com helper conectado', p.name === 'darwin' && p.helper.connected === true, p.name);
    check('áreas presentes', ['keys', 'windows', 'apps', 'audio', 'media', 'hardware', 'tray', 'session'].every((k) => p[k]), Object.keys(p));
    check('stubs de mídia e hardware respondem', p.media.spotify.snapshot().available === false && p.media.players.snapshot().available === false && p.hardware.currentStats.gpu.available === false && p.media.spotify.artOf('x') === null && (await p.media.spotify.resolve('x')) === null, p.media.spotify.snapshot());
    check('stubs têm start/stop/setActive/on', ['spotify', 'players'].every((k) => ['start', 'stop', 'setActive', 'on'].every((m) => typeof p.media[k][m] === 'function')) && ['start', 'stop', 'setActive', 'currentInterval', 'on'].every((m) => typeof p.hardware[m] === 'function'));
    const statsEvents = [];
    p.hardware.on('stats', (s) => statsEvents.push(s));
    p.hardware.start(); p.hardware.setActive(true);
    await waitFor(() => statsEvents.length > 0, 2500);
    check('hardware stub emite stats zerado no intervalo', statsEvents.length > 0 && statsEvents[0].cpu.usage === 0 && typeof statsEvents[0].timestamp === 'number', statsEvents[0]);
    p.hardware.stop();
    const caps = p.keys.capabilities();
    await waitFor(() => (p.keys.capabilitiesCached() || {}).accessibility === true);
    check('capabilities do darwin tem helper e keysReady', caps.platform === 'darwin' && caps.helper === true && typeof caps.keysReady === 'boolean', caps);
    const d = p.describe();
    check('describe menciona helper e Acessibilidade', /^Sessão: macOS 15\.8\.1 \| helper: conectado \| Acessibilidade: ok$/.test(d), d);
    check('dataDir no darwin é Application Support', process.platform === 'darwin' ? /Library\/Application Support\/MatDeck$/.test(dataDir()) : /server\/data$/.test(dataDir()), dataDir());
    process.env.MATDECK_DATA_DIR = '/tmp/x-matdeck';
    check('dataDir respeita MATDECK_DATA_DIR', dataDir() === '/tmp/x-matdeck', dataDir());
    delete process.env.MATDECK_DATA_DIR;
    check('session.lock e audio.masterStep existem', typeof p.session.lock === 'function' && typeof p.audio.masterStep === 'function' && typeof p.apps.launcher.list === 'function' && typeof p.windows.focus === 'function');
    p.tray.start({ port: 8899, lanIp: '192.168.0.2', enabled: true });
    await waitFor(() => fake.requests.some((r) => r.op === 'tray.set'));
    check('tray.start fala com o helper', fake.requests.some((r) => r.op === 'tray.set' && /8899/.test(r.args.tooltip)));
    await p.tray.stop();
    check('com Acessibilidade concedida não pede permissão', !fake.requests.some((r) => r.op === 'permissions.request'));
    p.media.spotify.stop(); p.media.players.stop(); p.audio.mixer.stop(); p.windows.detector.stop();
    await p.helper.stop();
    await fake.close();

    // --- darwin com helper SEM Acessibilidade: pede ao sistema uma vez (diálogo) e describe diz NEGADA
    const sockB = path.join(tmp, 'hb.sock');
    const fakeB = await fakeHelper.start({ socketPath: sockB, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'arm64' }, permissions: { accessibility: false } } });
    fakeB.setHandler('permissions.status', () => ({ accessibility: false }));
    fakeB.setHandler('permissions.request', () => ({ granted: false }));
    fakeB.setHandler('window.subscribe', () => ({ subscribed: true }));
    fakeB.setHandler('audio.master.get', () => ({ volume: 30, muted: false }));
    fakeB.setHandler('audio.master.subscribe', () => ({ subscribed: true }));
    process.env.MATDECK_HELPER_SOCKET = sockB;
    fakeExec.resetSrcModules();
    const { createPlatform: createPlatformB } = require(path.join(SRC, 'platform'));
    const pB = createPlatformB();
    await waitFor(() => fakeB.requests.some((r) => r.op === 'permissions.request'));
    const reqB = fakeB.requests.filter((r) => r.op === 'permissions.request');
    check('sem Acessibilidade pede permissions.request accessibility uma vez', reqB.length === 1 && reqB[0].args.kind === 'accessibility', reqB);
    await sleep(400);
    check('describe diz Acessibilidade NEGADA com helper conectado', /helper: conectado \| Acessibilidade: NEGADA/.test(pB.describe()), pB.describe());
    pB.media.spotify.stop(); pB.media.players.stop(); pB.audio.mixer.stop(); pB.windows.detector.stop();
    await pB.helper.stop();
    await fakeB.close();

    // --- darwin sem helper: sobe mesmo assim, describe avisa
    process.env.MATDECK_HELPER_SOCKET = path.join(tmp, 'nao-existe.sock');
    delete process.env.MATDECK_HELPER_APP;
    fakeExec.resetSrcModules();
    const { createPlatform: createPlatform2 } = require(path.join(SRC, 'platform'));
    const p2 = createPlatform2();
    await sleep(300);
    check('sem helper: plataforma sobe e describe avisa', p2.name === 'darwin' && /helper: ausente/.test(p2.describe()) && /Acessibilidade: NEGADA/.test(p2.describe()), p2.describe());
    check('sem helper: shortcut devolve false sem lançar', (await p2.keys.shortcut('cmd+c')) === false);
    await p2.helper.stop();
    p2.media.spotify.stop(); p2.media.players.stop(); p2.audio.mixer.stop(); p2.windows.detector.stop(); p2.hardware.stop();

    // --- linux: keysReady acompanha ydotool/xdotool
    process.env.MATDECK_PLATFORM = 'linux';
    fakeExec.install({ which: { ydotool: '/usr/bin/ydotool', xdotool: '/usr/bin/xdotool', kdotool: null, pactl: null, playerctl: null, busctl: null } });
    fakeExec.resetSrcModules();
    const { createPlatform: createPlatform3 } = require(path.join(SRC, 'platform'));
    const p3 = createPlatform3();
    const linuxCaps = p3.keys.capabilities(true);
    check('linux: keysReady acompanha ydotool/xdotool', linuxCaps.keysReady === !!(linuxCaps.ydotool || linuxCaps.xdotool) && linuxCaps.keysReady === true, linuxCaps);
    p3.media.spotify.stop(); p3.media.players.stop(); p3.hardware.stop(); p3.audio.mixer.stop();
    fakeExec.uninstall();

    console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('ERRO', e); process.exitCode = 1; });
