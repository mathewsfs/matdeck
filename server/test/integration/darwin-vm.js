// Ponta a ponta na VM macOS: sincroniza o repositório, sobe o servidor lá (helper real), abre um túnel SSH,
// conecta um deck por WebSocket e confere status, apps e uma tecla "abrir aplicativo".
// Uso: MATDECK_VM_HOST=mac node test/integration/darwin-vm.js   (host = alias do ~/.ssh/config)
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const HOST = process.env.MATDECK_VM_HOST;
if (!HOST) { console.log('MATDECK_VM_HOST não definido: teste de integração pulado'); process.exit(0); }
const REMOTE_PORT = 8899;
const LOCAL_PORT = 18899;
const REPO = path.resolve(__dirname, '..', '..', '..');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) return false; await sleep(100); } return true; };
const ssh = (cmd) => execFileSync('ssh', [HOST, cmd], { encoding: 'utf8', timeout: 120000 });
const getJson = (p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: LOCAL_PORT, path: p, headers: { Host: `127.0.0.1:${REMOTE_PORT}` } }, (res) => { let b = ''; res.on('data', (d) => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`${p}: ${b.slice(0, 120)}`)); } }); }).on('error', reject));
const postJson = (p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port: LOCAL_PORT, path: p, method: 'POST', headers: { Host: `127.0.0.1:${REMOTE_PORT}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { let b = ''; res.on('data', (d) => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.end(data);
});

(async () => {
    console.log('[vm] sincronizando repositório…');
    execFileSync(path.join(REPO, 'scripts', 'dev-mac-sync.sh'), { stdio: 'inherit' });
    console.log('[vm] encerrando servidor/helper antigos e subindo o servidor…');
    ssh(`pkill -f '^node .*matdeck/server/src/index.js' || true; pkill -x matdeck-helper || true; sleep 1; rm -f /tmp/matdeck-vm.log`);
    ssh(`cd ~/matdeck/server && PATH=$HOME/node/bin:$PATH PORT=${REMOTE_PORT} MATDECK_TRAY=0 MATDECK_ELGATO=0 MATDECK_HELPER_SOCKET=/tmp/mdh-vm.sock MATDECK_HELPER_APP="$HOME/matdeck/macos/MatDeckHelper/dist/MatDeck Helper.app" nohup node src/index.js > /tmp/matdeck-vm.log 2>&1 &
sleep 4; tail -5 /tmp/matdeck-vm.log`);
    const tunnel = spawn('ssh', ['-N', '-L', `${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}`, HOST], { stdio: 'ignore' });
    try {
        const up = await waitFor(() => getJson('/api/status').then(() => true, () => false), 20000);
        check('servidor responde pelo túnel', up);
        const status = await getJson('/api/status');
        check('platform darwin', status.platform === 'darwin', status.platform);
        const helperUp = await waitFor(() => getJson('/api/status').then((s) => s.capabilities && s.capabilities.helper === true), 15000);
        check('capabilities.helper true', helperUp, status.capabilities);
        const caps = (await getJson('/api/status')).capabilities;
        check('Acessibilidade concedida (keysReady)', caps.accessibility === true && caps.keysReady === true, caps);
        const apps = await getJson('/api/apps');
        check('/api/apps contém Safari', apps.apps.some((a) => a.id === 'com.apple.Safari'), apps.apps.length);

        const msgs = [];
        const ws = new WebSocket(`ws://127.0.0.1:${LOCAL_PORT}/deck`, { headers: { Host: `127.0.0.1:${REMOTE_PORT}` } });
        ws.on('message', (m) => { try { msgs.push(JSON.parse(m)); } catch (e) {} });
        await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
        check('deck conecta e recebe profileList', await waitFor(() => msgs.some((m) => m.event === 'profileList')), msgs.map((m) => m.event));

        ssh(`pkill -x TextEdit || true`);
        const preset = await postJson('/api/presets/vm-teste', { name: 'VM teste', rows: 2, cols: 4, keys: [{ index: 0, title: 'TextEdit', actionId: 'launch:app:com.apple.TextEdit' }] });
        check('preset de teste criado', preset.status === 200, preset);
        ws.send(JSON.stringify({ event: 'keyDown', profile: 'vm-teste', keyIndex: 0 }));
        ws.send(JSON.stringify({ event: 'keyUp', profile: 'vm-teste', keyIndex: 0 }));
        const opened = await waitFor(() => { try { return ssh('pgrep -x TextEdit').trim() !== ''; } catch (e) { return false; } }, 10000);
        check('tecla launch:app abriu o TextEdit na VM', opened);
        ws.close();

        const log = ssh('cat /tmp/matdeck-vm.log');
        check('log da VM tem a sessão com helper conectado e Acessibilidade ok', /Sessão: macOS [\d.]+ \| helper: conectado \| Acessibilidade: ok/.test(log), (log.match(/.*Sessão:.*/g) || []).join(' | '));
        const stop = await postJson('/api/shutdown');
        check('POST /api/shutdown aceito', stop.status === 200, stop);
        await sleep(1500);
        const dead = (() => { try { return ssh("pgrep -f '^node .*matdeck/server/src/index.js' || echo ''").trim() === ''; } catch (e) { return true; } })();
        check('servidor da VM encerrou', dead);
    } catch (e) {
        console.error('ERRO', e.message);
        fails++;
    } finally {
        tunnel.kill();
        try { ssh(`pkill -f '^node .*matdeck/server/src/index.js' || true`); } catch (e) {}
    }
    console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exit(fails ? 1 : 0);
})();
