// Adaptador de teclas do Linux (platform/linux/keys.js): os comandos gerados têm de ser exatamente os de hoje.
// Uso: node platform-keys.test.js [caminho de server/src]
const path = require('path');
const fake = require('../fake-host-exec');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');
process.env.MATDECK_PLATFORM = 'linux';   // este teste exercita o adaptador Linux
if (process.platform !== 'linux') { console.log('(pulado: o adaptador Linux usa ydotool/kdotool e só roda em Linux)'); process.exit(0); }

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

process.env.WAYLAND_DISPLAY = 'wayland-0';
process.env.XDG_SESSION_TYPE = 'wayland';
process.env.XDG_CURRENT_DESKTOP = 'KDE';
process.env.YDOTOOL_SOCKET = '/tmp/.ydotool_socket';

(async () => {
    // --- cenário 1: ydotool disponível, sem playerctl ---
    let rec = fake.install({
        which: { ydotool: '/usr/bin/ydotool', playerctl: null },
        sockets: ['/tmp/.ydotool_socket'],
        outputs: { '/usr/bin/ydotool key 25:0 42:0 29:0': { code: 1, stderr: 'falha simulada' } }
    });
    fake.resetSrcModules();
    const { createKeys } = require(path.join(SRC, 'platform', 'linux', 'keys'));
    const keys = createKeys();

    check('capabilities vê ydotool com socket', keys.capabilities(true).ydotool === true, keys.capabilities());

    let ok = await keys.shortcut('ctrl+shift+m');
    let last = rec.last('execFile');
    check('shortcut ctrl+shift+m via ydotool', ok === true && last.file === '/usr/bin/ydotool' && eq(last.args, ['key', '29:1', '42:1', '50:1', '50:0', '42:0', '29:0']), last);

    await keys.keyDown('ctrl+shift+p');
    last = rec.last('execFile');
    check('keyDown ctrl+shift+p', eq(last.args, ['key', '29:1', '42:1', '25:1']), last);

    ok = await keys.keyUp('ctrl+shift+p');
    last = rec.last('execFile');
    check('keyUp ctrl+shift+p', eq(last.args, ['key', '25:0', '42:0', '29:0']), last);
    check('keyUp com ydotool falhando devolve false', ok === false, ok);

    await keys.mediaKey('play_pause');
    last = rec.last('execFile');
    check('mediaKey play_pause sem playerctl vira XF86AudioPlay', eq(last.args, ['key', '164:1', '164:0']), last);

    const before = rec.calls.length;
    ok = await keys.shortcut('ctrl+ç');
    check('combo desconhecido devolve false sem lançar', ok === false, ok);
    check('combo desconhecido não chama ydotool', !rec.calls.slice(before).some((c) => c.file === '/usr/bin/ydotool'));

    check('hostVisibleTmpDir devolve pasta', typeof keys.hostVisibleTmpDir() === 'string' && keys.hostVisibleTmpDir().length > 0);
    check('capabilitiesCached/Stale existem', typeof keys.capabilitiesCached().ydotool === 'boolean' && typeof keys.capabilitiesStale() === 'boolean');

    // --- cenário 2: playerctl presente ---
    fake.uninstall();
    rec = fake.install({ which: { ydotool: '/usr/bin/ydotool', playerctl: '/usr/bin/playerctl' }, sockets: ['/tmp/.ydotool_socket'] });
    fake.resetSrcModules();
    const keys2 = require(path.join(SRC, 'platform', 'linux', 'keys')).createKeys();
    await keys2.mediaKey('next');
    last = rec.last('exec');
    check('mediaKey next com playerctl', last && last.cmd === 'playerctl next', last);
    await keys2.mediaKey('prev');
    check('mediaKey prev com playerctl', rec.last('exec').cmd === 'playerctl previous', rec.last('exec'));
    await keys2.mediaKey('play_pause');
    check('mediaKey play_pause com playerctl', rec.last('exec').cmd === 'playerctl play-pause', rec.last('exec'));

    fake.uninstall();
    console.log(fails ? `\n${fails} FALHA(S)` : '\nTodos os checks passaram');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(2); });
