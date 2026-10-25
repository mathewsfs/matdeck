// Seleção de plataforma (platform/index.js) e montagem das áreas no Linux (platform/linux/index.js).
// Uso: node platform-select.test.js [caminho de server/src]
const path = require('path');
const fake = require('../fake-host-exec');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

process.env.WAYLAND_DISPLAY = 'wayland-0';
process.env.XDG_SESSION_TYPE = 'wayland';
process.env.XDG_CURRENT_DESKTOP = 'KDE';
process.env.MATDECK_TRAY = '0';
delete process.env.MATDECK_PLATFORM;

fake.install({ which: { ydotool: null, kdotool: null, pactl: null, playerctl: null, busctl: null } });
fake.resetSrcModules();
const { createPlatform, platformName } = require(path.join(SRC, 'platform'));

check('platformName segue process.platform', platformName() === (process.platform === 'darwin' ? 'darwin' : 'linux'), platformName());
process.env.MATDECK_PLATFORM = 'darwin';
check('MATDECK_PLATFORM força darwin', platformName() === 'darwin', platformName());
// darwin: camada real (helper nativo); sem helper no ar a plataforma sobe e avisa em describe()
process.env.MATDECK_HELPER_SOCKET = require('path').join(require('os').tmpdir(), `matdeck-sem-helper-${process.pid}.sock`);
delete process.env.MATDECK_HELPER_APP;
let darwinPlatform = null; let threw = false;
try { darwinPlatform = createPlatform(); } catch (e) { threw = true; }
check('darwin não lança sem helper', !threw && darwinPlatform && darwinPlatform.name === 'darwin', darwinPlatform && darwinPlatform.name);
check('darwin tem as mesmas áreas e o helper', darwinPlatform && ['keys', 'windows', 'apps', 'audio', 'media', 'hardware', 'tray', 'session', 'helper'].every((k) => darwinPlatform[k]));
check('describe do darwin avisa helper ausente', darwinPlatform && /helper: ausente/.test(darwinPlatform.describe()), darwinPlatform && darwinPlatform.describe());
if (darwinPlatform) { darwinPlatform.helper.stop(); darwinPlatform.media.spotify.stop(); darwinPlatform.media.players.stop(); darwinPlatform.hardware.stop(); darwinPlatform.audio.mixer.stop(); }
process.env.MATDECK_PLATFORM = 'linux';   // daqui em diante, o adaptador Linux

const p = createPlatform();
check('name é linux', p.name === 'linux');
check('áreas presentes', ['keys', 'windows', 'apps', 'audio', 'media', 'hardware', 'tray', 'session'].every((k) => p[k]), Object.keys(p));
check('hardware é HardwareMonitor em modo econômico', typeof p.hardware.currentInterval === 'function' && p.hardware.currentInterval() === 10000);
check('audio tem mixer e master', typeof p.audio.mixer.getAll === 'function' && typeof p.audio.masterStep === 'function' && typeof p.audio.masterMuteToggle === 'function');
check('media tem spotify e players', typeof p.media.spotify.snapshot === 'function' && typeof p.media.players.snapshot === 'function');
check('windows tem detector e focus', typeof p.windows.focus === 'function' && p.windows.detector && typeof p.windows.detector.setEnabled === 'function');
check('apps tem launcher e open', typeof p.apps.open === 'function' && typeof p.apps.launcher.list === 'function');
check('session.lock e keys.shortcut existem', typeof p.session.lock === 'function' && typeof p.keys.shortcut === 'function');
check('tray.start/stop existem', typeof p.tray.start === 'function' && typeof p.tray.stop === 'function');
const d = p.describe();
check('describe menciona teclas e foco', /teclas:/.test(d) && /foco de janela:/.test(d) && /detecção de janela:/.test(d), d);
if (process.platform === 'linux') check('describe começa com a sessão (Wayland/X11)', /^Sessão: Wayland KDE/.test(d), d);

// tray desligada por MATDECK_TRAY=0: start não lança e stop resolve
p.tray.start({ port: 8899, lanIp: '192.168.0.2', enabled: true });
Promise.resolve(p.tray.stop()).then(() => {
    check('tray.stop resolve', true);
    p.media.spotify.stop(); p.media.players.stop(); p.hardware.stop(); p.audio.mixer.stop();
    fake.uninstall();
    console.log(fails ? `\n${fails} FALHA(S)` : '\nTodos os checks passaram');
    process.exit(fails ? 1 : 0);
});
