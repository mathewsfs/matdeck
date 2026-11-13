// "Iniciar com o PC" (Ajustes → Iniciar com o PC): no Linux é um .desktop em ~/.config/autostart gravado pelo host
// (hostExec, pois o sandbox do Flatpak não vê ~/.config). A fonte da verdade é o arquivo, não uma flag no config.
// Rotas GET/POST /api/autostart (POST só do próprio PC). No macOS não é suportado (o instalador cria o LaunchAgent).
// Uso: node autostart.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const fakeHelper = require('../fake-helper');

let fails = 0;
const out = console.log;
const logged = [];
const check = (n, ok, extra) => { out((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(25); } return true; };
const root = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-autostart-'));
const request = (port, method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
        let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* texto */ } resolve({ status: res.statusCode, json, text: buf }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
});

(async () => {
    // --- módulo Linux (sh e fs reais, pasta temporária, fora do Flatpak)
    const { createAutostart } = require('../../src/platform/linux/autostart');
    const dir = path.join(tmp, 'autostart');
    const native = createAutostart({ dir, flatpakId: '', root });
    const file = path.join(dir, 'br.com.matdeck.MatDeck.desktop');
    check('arquivo em <dir>/br.com.matdeck.MatDeck.desktop', native.file === file, native.file);
    let st = await native.status();
    check('sem arquivo: suportado e desligado', st.supported === true && st.enabled === false && st.file === file, st);

    await native.enable();
    check('enable cria o .desktop (pasta criada junto)', fs.existsSync(file));
    let content = fs.readFileSync(file, 'utf8');
    check('é um Desktop Entry de aplicativo', /^\[Desktop Entry\]\n/.test(content) && /^Type=Application$/m.test(content) && /^Name=MatDeck$/m.test(content));
    check('nativo: Exec é o start-server.sh do repositório, com aspas (caminho pode ter espaços)', new RegExp(`^Exec="${path.join(root, 'start-server.sh').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm').test(content), content);
    check('não abre o gerenciador no login (sem xdg-open / matdeck-launcher)', !/launcher|xdg-open|\/manage/.test(content));
    st = await native.status();
    check('status: ligado', st.enabled === true, st);

    fs.writeFileSync(file, content + 'Hidden=true\n');
    st = await native.status();
    check('Hidden=true (desligado pelo KDE) conta como desligado', st.enabled === false, st);

    await native.disable();
    check('disable apaga o arquivo', !fs.existsSync(file));
    await native.disable();
    check('disable sem arquivo não falha', !fs.existsSync(file));

    const flat = createAutostart({ dir, flatpakId: 'br.com.matdeck.MatDeck', root });
    await flat.enable();
    content = fs.readFileSync(file, 'utf8');
    check('Flatpak: Exec = flatpak run --command=matdeck br.com.matdeck.MatDeck autostart', /^Exec=flatpak run --command=matdeck br\.com\.matdeck\.MatDeck autostart$/m.test(content), content);
    check('Flatpak: ícone do app', /^Icon=br\.com\.matdeck\.MatDeck$/m.test(content));
    await flat.disable();

    check('matdeck.sh tem o modo autostart (só sobe o servidor, sem navegador, e sai se já estiver no ar)', /autostart\)/.test(read('flatpak/matdeck.sh')));
    check('Ajustes tem a caixa "Iniciar com o PC" fora dos campos data-path', /id="cfg-autostart"(?![^>]*data-path)/.test(read('server/web/manage.html')));
    check('gerenciador carrega e aplica pela rota /api/autostart', /\/api\/autostart/.test(read('server/web/manage.js')));

    // --- servidor (darwin com helper falso): rotas existem; no macOS a resposta é "não suportado"
    const sock = path.join(tmp, 'h.sock');
    const port = 22000 + Math.floor(Math.random() * 1000);
    const fake = await fakeHelper.start({ socketPath: sock, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'arm64' }, permissions: { accessibility: true } } });
    for (const op of ['permissions.status', 'window.subscribe', 'audio.master.subscribe']) fake.setHandler(op, () => ({ accessibility: true, subscribed: true }));
    fake.setHandler('window.active', () => ({ app: 'Finder', bundleId: 'com.apple.finder', pid: 1, title: '' }));
    fake.setHandler('audio.master.get', () => ({ volume: 30, muted: false }));
    fake.setHandler('apps.list', () => ({ apps: [] }));
    Object.assign(process.env, { MATDECK_PLATFORM: 'darwin', MATDECK_HELPER_SOCKET: sock, MATDECK_DATA_DIR: path.join(tmp, 'data'), PORT: String(port), MATDECK_TRAY: '0', MATDECK_ELGATO: '0', MATDECK_CLAUDE_STATE_DIR: path.join(tmp, 'sessions'), MATDECK_CLAUDE_HOOK_DIR: path.join(tmp, 'hook'), MATDECK_AUTOSTART_DIR: dir });
    delete process.env.MATDECK_HELPER_APP;
    console.log = (...x) => logged.push(x.join(' '));
    console.warn = console.log;
    const MatDeckServer = require('../../src/index.js');
    const server = new MatDeckServer();
    check('servidor sobe', await waitFor(() => logged.some((l) => /Sessão: macOS/.test(l)), 15000), logged.slice(-5));
    let r = await request(port, 'GET', '/api/autostart');
    check('GET /api/autostart no macOS: supported=false, enabled=false', r.status === 200 && r.json && r.json.supported === false && r.json.enabled === false, r.json);
    r = await request(port, 'POST', '/api/autostart', { enabled: true });
    check('POST no macOS responde erro claro sem gravar nada', r.status === 400 && r.json && r.json.success === false && /macOS/.test(r.json.error || '') && !fs.existsSync(file), r.json);
    check('servidor nunca grava o .desktop sozinho na subida', !fs.existsSync(file));

    await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exitCode = fails ? 1 : 0;
    out(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.kill(process.pid, 'SIGTERM');
})().catch((e) => { out('ERRO', e); process.exitCode = 1; fs.rmSync(tmp, { recursive: true, force: true }); process.kill(process.pid, 'SIGTERM'); });
