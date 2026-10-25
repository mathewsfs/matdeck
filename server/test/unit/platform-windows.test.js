// Adaptador de janelas do Linux (platform/linux/windows.js): foco com título obrigatório e detector.
// Uso: node platform-windows.test.js [caminho de server/src]
const path = require('path');
const fake = require('../fake-host-exec');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

process.env.WAYLAND_DISPLAY = 'wayland-0';
process.env.XDG_SESSION_TYPE = 'wayland';
process.env.XDG_CURRENT_DESKTOP = 'KDE';
process.env.YDOTOOL_SOCKET = '/tmp/.ydotool_socket';

(async () => {
    const rec = fake.install({
        which: { kdotool: '/usr/bin/kdotool', ydotool: '/usr/bin/ydotool' },
        sockets: ['/tmp/.ydotool_socket'],
        outputs: {
            // SystemActions passa os hints em minúsculas
            'kdotool search --name meet': { stdout: '{abc}\n' },
            'kdotool windowactivate {abc}': { stdout: '' },
            'kdotool search --name nada': { stdout: '' }
        }
    });
    fake.resetSrcModules();
    const { createWindows } = require(path.join(SRC, 'platform', 'linux', 'windows'));
    const windows = createWindows();

    const MEET = { titleHints: ['Meet'], classHints: ['brave-browser', 'google-chrome'], requireTitle: true };
    let ok = await windows.focus(MEET);
    let calls = rec.calls;
    check('focus por título usa kdotool search --name', ok === true && calls.some((c) => c.fn === 'execFile' && c.file === 'kdotool' && c.args.join(' ') === 'search --name meet'));
    check('focus ativa o id devolvido', calls.some((c) => c.fn === 'execFile' && c.file === 'kdotool' && c.args.join(' ') === 'windowactivate {abc}'));

    rec.reset();
    ok = await windows.focus({ titleHints: ['Nada'], classHints: ['brave-browser'], requireTitle: true });
    check('requireTitle sem título casando não cai para classe', ok === false && !rec.calls.some((c) => c.args && c.args.includes('--class')), rec.calls.filter((c) => c.fn === 'execFile' && c.file === 'kdotool').map((c) => c.args.join(' ')));

    rec.reset();
    ok = await windows.focusAndSend(MEET, 'ctrl+d', 1);
    const last = rec.last('execFile');
    check('focusAndSend envia o combo depois de focar', ok === true && last.file === '/usr/bin/ydotool' && last.args.join(' ') === 'key 29:1 32:1 32:0 29:0', last);

    check('detector expõe lastDetected', windows.detector && windows.detector.lastDetected && windows.detector.lastDetected.profile === null);
    check('matchProfile casa classe do Discord', windows.matchProfile('x', 'com.discordapp.discord') === 'discord');
    check('matchProfile casa título do Meet', windows.matchProfile('Reunião - Meet - Brave', '') === 'meet');
    check('DETECTABLE_APPS tem os seis apps', Array.isArray(windows.DETECTABLE_APPS) && windows.DETECTABLE_APPS.length === 6);

    fake.uninstall();
    console.log(fails ? `\n${fails} FALHA(S)` : '\nTodos os checks passaram');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(2); });
