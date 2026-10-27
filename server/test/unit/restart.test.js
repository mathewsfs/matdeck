// Reiniciar o servidor pela bandeja: POST /api/restart (só loopback) encerra com código 75 e os lançadores
// (start-server.sh, flatpak/matdeck.sh) relançam o node quando veem esse código. A bandeja Linux tem o item.
// Uso: node restart.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const fakeHelper = require('../fake-helper');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(25); } return true; };
const post = (port, p) => new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST' }, (res) => { let b = ''; res.on('data', (d) => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); r.on('error', (e) => resolve({ status: 0, body: e.message })); r.end(); });

const ROOT = path.join(__dirname, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-restart-'));
const sock = path.join(tmp, 'h.sock');
const port = 19000 + Math.floor(Math.random() * 1000);

(async () => {
    // --- servidor (modo darwin com helper falso: sobe igual em qualquer máquina da CI)
    const fake = await fakeHelper.start({ socketPath: sock, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'arm64' }, permissions: { accessibility: true } } });
    for (const op of ['permissions.status', 'window.subscribe', 'audio.master.subscribe', 'apps.list']) fake.setHandler(op, () => ({ accessibility: true, subscribed: true, apps: [] }));
    fake.setHandler('audio.master.get', () => ({ volume: 30, muted: false }));
    const env = { ...process.env, MATDECK_PLATFORM: 'darwin', MATDECK_HELPER_SOCKET: sock, MATDECK_DATA_DIR: path.join(tmp, 'data'), PORT: String(port), MATDECK_TRAY: '0', MATDECK_ELGATO: '0' };
    delete env.MATDECK_HELPER_APP;
    const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
    let exit = null; srv.on('exit', (code) => { exit = code; });
    check('servidor sobe', await waitFor(() => /Sessão: macOS/.test(log), 15000), log.slice(-300));

    const res = await post(port, '/api/restart');
    check('POST /api/restart responde success', res.status === 200 && /"success":true/.test(res.body), res);
    await waitFor(() => exit !== null, 8000);
    check('servidor encerra com código 75 (reiniciar)', exit === 75, exit);
    check('log avisa que vai reiniciar', /[Rr]einiciando/.test(log), (log.match(/.*[Rr]einiciando.*/) || [])[0]);
    if (exit === null) srv.kill('SIGKILL');
    await fake.close();

    // --- lançadores: relançam o node quando o código é 75, saem com qualquer outro
    const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
    const counter = path.join(tmp, 'runs');
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho x >> "${counter}"\nn=$(wc -l < "${counter}")\n[ "$n" -eq 1 ] && exit 75\n[ "$n" -eq 2 ] && exit 75\nexit 3\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const run = spawnSync('sh', [path.join(ROOT, 'start-server.sh')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_SESSION_TYPE: 'x11' }, encoding: 'utf8', timeout: 20000 });
    const runs = fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').length : 0;
    check('start-server.sh relança duas vezes no código 75 e sai no 3', runs === 3 && run.status === 3, { runs, status: run.status, out: (run.stdout || '').slice(-200) });
    const flatpakSh = fs.readFileSync(path.join(ROOT, 'flatpak', 'matdeck.sh'), 'utf8');
    check('flatpak/matdeck.sh tem o mesmo laço de reinício (75)', /75/.test(flatpakSh) && !/exec node src\/index\.js/.test(flatpakSh));

    // --- bandeja Linux: item "Reiniciar servidor" chamando /api/restart
    const tray = fs.readFileSync(path.join(ROOT, 'scripts', 'matdeck-tray.py'), 'utf8');
    check('bandeja tem "Reiniciar servidor" → /api/restart', /Reiniciar servidor/.test(tray) && /\/api\/restart/.test(tray));

    console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('ERRO', e); process.exitCode = 1; });
