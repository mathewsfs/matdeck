// Servidor inteiro em modo darwin (MATDECK_PLATFORM=darwin) contra o helper falso: /api/status, perfil
// decorado (master com volume do helper, fader de app sem mixer marcado n/d), setVolume ignorado em app
// indisponível, tecla launch:app → apps.launch. Uso: node darwin-server.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const fakeHelper = require('../fake-helper');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(25); } return true; };
const get = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (d) => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } }); }).on('error', reject));
const post = (port, p) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST' }, (res) => { res.resume(); res.on('end', resolve); }); r.on('error', reject); r.end(); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-srv-'));
const sock = path.join(tmp, 'h.sock');
const port = 18000 + Math.floor(Math.random() * 1000);

(async () => {
    const fake = await fakeHelper.start({ socketPath: sock, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'arm64' }, permissions: { accessibility: true } } });
    fake.setHandler('permissions.status', () => ({ accessibility: true }));
    fake.setHandler('window.subscribe', () => ({ subscribed: true }));
    fake.setHandler('window.active', () => ({ app: 'Finder', bundleId: 'com.apple.finder', pid: 1, title: '' }));
    fake.setHandler('audio.master.get', () => ({ volume: 30, muted: false }));
    fake.setHandler('audio.master.set', (a) => ({ volume: a.volume, muted: false }));
    fake.setHandler('audio.master.subscribe', () => ({ subscribed: true }));
    fake.setHandler('apps.list', () => ({ apps: [{ id: 'com.apple.Safari', name: 'Safari', path: '/Applications/Safari.app' }, { id: 'com.apple.TextEdit', name: 'TextEdit', path: '/System/Applications/TextEdit.app' }] }));
    fake.setHandler('apps.launch', () => ({ launched: true }));
    fake.setHandler('apps.icon', () => ({ png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }));
    fake.setHandler('key.shortcut', () => ({}));

    const env = { ...process.env, MATDECK_PLATFORM: 'darwin', MATDECK_HELPER_SOCKET: sock, MATDECK_DATA_DIR: path.join(tmp, 'data'), PORT: String(port), MATDECK_TRAY: '0', MATDECK_ELGATO: '0' };
    delete env.MATDECK_HELPER_APP;
    const srv = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    srv.stdout.on('data', (d) => { log += d; });
    srv.stderr.on('data', (d) => { log += d; });
    const up = await waitFor(() => /Sessão: macOS/.test(log), 15000);
    check('servidor sobe em modo darwin', up, log.slice(-400));
    await waitFor(() => /helper: conectado/.test(log), 3000);
    check('log diz helper conectado e Acessibilidade ok', /Sessão: macOS 15\.8\.1 \| helper: conectado \| Acessibilidade: ok/.test(log), (log.match(/Sessão:.*/) || [])[0]);

    const status = await get(port, '/api/status');
    check('/api/status platform darwin com helper', status.platform === 'darwin' && status.capabilities && status.capabilities.helper === true && status.capabilities.accessibility === true && status.capabilities.keysReady === true, status.capabilities);
    const apps = await get(port, '/api/apps');
    check('/api/apps vem do helper', Array.isArray(apps.apps) && apps.apps.some((a) => a.id === 'com.apple.Safari'), apps);
    const icon = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/apps/com.apple.Safari/icon' }, (res) => { const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) })); }).on('error', reject));
    check('/api/apps/:id/icon devolve o PNG do helper', icon.status === 200 && icon.type === 'image/png' && icon.body.slice(0, 4).toString('hex') === '89504e47', { status: icon.status, type: icon.type, len: icon.body.length });
    const iconJson = await get(port, '/api/apps/com.apple.Safari/icon.json');
    check('/api/apps/:id/icon.json devolve data URL', typeof iconJson.icon === 'string' && iconJson.icon.startsWith('data:image/png;base64,'), iconJson);
    const icon404 = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/apps/nao.existe/icon' }, (res) => { res.resume(); resolve(res.statusCode); }));
    check('ícone de app desconhecido é 404', icon404 === 404, icon404);

    const msgs = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/deck`);
    ws.on('message', (m) => { try { msgs.push(JSON.parse(m)); } catch (e) {} });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    await waitFor(() => msgs.some((m) => m.event === 'loadProfile'));
    const profileKeys = (id) => { const m = [...msgs].reverse().find((x) => x.event === 'loadProfile' && x.id === id); return m ? m.keys : null; };
    await waitFor(() => profileKeys('default'));
    const master = (profileKeys('default') || []).find((k) => k.actionId === 'vol_slider:master');
    check('fader master mostra o volume do helper', master && master.sliderValue === 30 && master.badge === '30%', master);

    ws.send(JSON.stringify({ event: 'switchProfile', profile: 'spotify' }));
    await waitFor(() => profileKeys('spotify'));
    const spot = (profileKeys('spotify') || []).find((k) => k.actionId === 'vol_slider:spotify');
    check('fader de app sem mixer vem como n/d', spot && spot.badge === 'n/d' && spot.sliderValue === 0 && spot.active === false, spot);

    const before = fake.requests.length;
    ws.send(JSON.stringify({ event: 'setVolume', app: 'spotify', value: 40 }));
    ws.send(JSON.stringify({ event: 'toggleMute', app: 'spotify' }));
    await sleep(300);
    check('setVolume/toggleMute em app indisponível não chegam ao helper', !fake.requests.slice(before).some((r) => r.op.startsWith('audio.')));
    ws.send(JSON.stringify({ event: 'setVolume', app: 'master', value: 45 }));
    await waitFor(() => fake.requests.some((r) => r.op === 'audio.master.set' && r.args.volume === 45));
    check('setVolume master chega ao helper', fake.requests.some((r) => r.op === 'audio.master.set' && r.args.volume === 45));

    // tecla "abrir aplicativo" num preset → keyDown pelo deck → apps.launch
    const preset = await new Promise((resolve) => {
        const body = JSON.stringify({ name: 'Mac teste', rows: 2, cols: 4, keys: [{ index: 0, title: 'TextEdit', actionId: 'launch:app:com.apple.TextEdit' }] });
        const r = http.request({ host: '127.0.0.1', port, path: '/api/presets/mac-teste', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (rs) => { let b = ''; rs.on('data', (d) => b += d); rs.on('end', () => resolve({ status: rs.statusCode, body: b })); });
        r.on('error', (e) => resolve({ status: 0, body: e.message })); r.end(body);
    });
    check('preset de teste criado pela API', preset.status === 200, preset);
    ws.send(JSON.stringify({ event: 'keyDown', profile: 'mac-teste', keyIndex: 0 }));
    ws.send(JSON.stringify({ event: 'keyUp', profile: 'mac-teste', keyIndex: 0 }));
    const launched = await waitFor(() => fake.requests.some((r) => r.op === 'apps.launch' && r.args.id === 'com.apple.TextEdit'), 3000);
    check('tecla launch:app chega ao helper como apps.launch', launched, fake.requests.slice(-3).map((r) => r.op));

    ws.close();
    await post(port, '/api/shutdown');
    const exited = await new Promise((r) => { const t = setTimeout(() => r(false), 8000); srv.on('exit', () => { clearTimeout(t); r(true); }); });
    check('POST /api/shutdown encerra o servidor', exited);
    if (!exited) srv.kill('SIGKILL');
    await fake.close();
    console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('ERRO', e); process.exitCode = 1; });
