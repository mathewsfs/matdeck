// Adaptadores de aplicativos (platform/linux/apps.js) e sessão (platform/linux/system.js) do Linux:
// os comandos gerados têm de ser exatamente os que profiles/default.js gerava.
// Uso: node platform-apps-system.test.js [caminho de server/src]
const path = require('path');
const fake = require('../fake-host-exec');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

(async () => {
    const rec = fake.install({ which: { kcalc: null, 'gnome-calculator': '/usr/bin/gnome-calculator', konsole: null, kitty: null } });
    fake.resetSrcModules();
    const { createApps } = require(path.join(SRC, 'platform', 'linux', 'apps'));
    const { createSystem } = require(path.join(SRC, 'platform', 'linux', 'system'));
    const apps = createApps();
    const system = createSystem();

    let ok = await apps.open('https://google.com');
    let last = rec.last('spawnDetached');
    check('open usa xdg-open desanexado', ok === true && last.file === 'xdg-open' && last.args[0] === 'https://google.com', last);

    ok = await apps.launchFirst([['kcalc'], ['gnome-calculator'], ['qalculate-gtk']], 'calculadora');
    last = rec.last('spawnDetached');
    check('launchFirst pula o que não existe', ok === true && last.file === 'gnome-calculator' && last.args.length === 0, last);

    const before = rec.calls.length;
    ok = await apps.launchFirst([['konsole'], ['kitty']], 'terminal');
    check('launchFirst sem candidatos devolve false', ok === false && !rec.calls.slice(before).some((c) => c.fn === 'spawnDetached'), ok);

    ok = await apps.launchFile('flatpak', ['run', 'com.discordapp.Discord']);
    last = rec.last('spawnDetached');
    check('launchFile repassa binário e argumentos', ok === true && last.file === 'flatpak' && last.args.join(' ') === 'run com.discordapp.Discord', last);

    check('commandExists consulta which', apps.commandExists('gnome-calculator') === true && apps.commandExists('kcalc') === false);
    check('flatpakInstalled sem flatpak devolve false', (await apps.flatpakInstalled('com.discordapp.Discord')) === false);
    check('launcher é um AppLauncher', apps.launcher && typeof apps.launcher.list === 'function' && typeof apps.launcher.launch === 'function');

    system.lock();
    last = rec.last('exec');
    check('lock começa por loginctl', last.cmd === '(loginctl lock-session) || (qdbus org.freedesktop.ScreenSaver /ScreenSaver Lock) || (xdg-screensaver lock)', last);
    check('lock usa timeout de 4 s', last.opts && last.opts.timeout === 4000, last.opts);

    system.masterStep(5);
    check('masterStep(+5)', rec.last('exec').cmd === '(wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ 5%+) || (pactl set-sink-volume @DEFAULT_SINK@ +5%) || (amixer -D pulse sset Master 5%+)', rec.last('exec'));
    system.masterStep(-5);
    check('masterStep(-5)', rec.last('exec').cmd === '(wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-) || (pactl set-sink-volume @DEFAULT_SINK@ -5%) || (amixer -D pulse sset Master 5%-)', rec.last('exec'));
    system.masterMuteToggle();
    check('masterMuteToggle', rec.last('exec').cmd === '(wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle) || (pactl set-sink-mute @DEFAULT_SINK@ toggle)', rec.last('exec'));

    fake.uninstall();
    console.log(fails ? `\n${fails} FALHA(S)` : '\nTodos os checks passaram');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(2); });
