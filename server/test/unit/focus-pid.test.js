// Foco de janela por PID (SystemActions.focusWindow({ pids })): script KWin e xdotool search --pid.
// Uso: node focus-pid.test.js [caminho de server/src]
const fs = require('fs');
const os = require('os');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');
if (process.platform !== 'linux') { console.log('(pulado: o foco por PID só roda em Linux)'); process.exit(0); }

// os logs internos do SystemActions poluem a saída do teste
const realLog = console.log.bind(console);
console.log = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('[SystemActions]'))) realLog(...args); };

let fails = 0;
const check = (n, ok, extra) => { realLog((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

const SystemActions = require(path.join(SRC, 'actions', 'systemActions'));

(async () => {
    // --- script KWin: só inspeciona o texto gerado (não há KWin aqui)
    const script = SystemActions.buildKwinFocusScript([], [], '/tmp/x.js', 'm', false, [4242, 17]);
    check('script KWin injeta a lista de pids', /var pids = \[4242,17\];/.test(script), script.slice(0, 200));
    check('script KWin compara w.pid com o pid', /Number\(w\.pid\) === /.test(script));
    check('nível por pid vem antes dos níveis por título/classe', script.indexOf('w.pid') > -1 && script.indexOf('w.pid') < script.indexOf('matchTitle(w) &&'));
    const noPids = SystemActions.buildKwinFocusScript(['konsole'], [], '/tmp/x.js', 'm', false);
    check('script sem pids ainda tem o nível por classe', /matchClass\(w\)/.test(noPids));
    check('script sem pids tem lista de pids vazia', /var pids = \[\];/.test(noPids));

    // --- xdotool: um binário falso no PATH grava os argumentos e responde 123 para "search --pid 4242"
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-focus-pid-'));
    const log = path.join(dir, 'xdotool.log');
    const bin = path.join(dir, 'xdotool');
    fs.writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "search" ] && [ "$2" = "--pid" ] && [ "$3" = "4242" ]; then echo 123; fi
exit 0
`, { mode: 0o755 });
    process.env.PATH = dir + path.delimiter + process.env.PATH;
    SystemActions.xdotoolUsable = () => true;
    SystemActions.hasKdotool = () => false;
    SystemActions.capabilities = () => ({ qdbus: null, desktop: '', wayland: false, xdotool: true });

    const ok = await SystemActions.focusWindow({ pids: [4242] });
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    check('focusWindow({pids}) sem hints devolve true via xdotool', ok === true, lines);
    check('xdotool recebe search --pid 4242', lines[0] === 'search --pid 4242', lines);
    check('xdotool ativa o id devolvido', lines[1] === 'windowactivate --sync 123', lines);

    fs.writeFileSync(log, '');
    const none = await SystemActions.focusWindow({ pids: [999] });
    check('pid sem janela devolve false', none === false);
    check('pids inválidos são descartados e sem hints devolve false', (await SystemActions.focusWindow({ pids: ['abc', null] })) === false);

    // --- KWin recebe os pids
    const calls = [];
    SystemActions.capabilities = () => ({ qdbus: 'qdbus', desktop: 'KDE', wayland: true, xdotool: true });
    SystemActions.focusWithKwinScript = async (c, t, r, pids) => { calls.push(['kwin', pids]); return true; };
    check('focusWindow({pids}) chama o KWin com os pids', (await SystemActions.focusWindow({ pids: [4242] })) === true && JSON.stringify(calls) === '[["kwin",[4242]]]', calls);

    fs.rmSync(dir, { recursive: true, force: true });
    if (fails) { console.log(`\n${fails} check(s) falharam`); process.exit(1); }
    console.log('\nTodos os checks passaram');
})();
