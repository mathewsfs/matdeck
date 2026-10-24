// Harness interno: sobe o servidor isolado (porta 8899, pasta de dados temporária) e verifica o controle de acesso:
// gerenciador só por loopback, dispositivos da rede precisam emparelhar por PIN, Host/Origin de fora bloqueados.
// Conexões "da rede" são feitas ao IP da LAN desta máquina (remoteAddress ≠ loopback).
// Uso: node auth-http.js [MATDECK_DATA_DIR] [caminho de server/src]
process.env.PORT = '8899';
process.env.MATDECK_DATA_DIR = process.argv[2] || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'matdeck-test-'));
process.env.MATDECK_ELGATO = '0';
process.env.MATDECK_TRAY = '0';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const SRC = process.argv[3] || path.join(__dirname, '..', '..', 'src');
const WindowDetector = require(path.join(SRC, 'windowDetector'));
WindowDetector.prototype.startBackend = function () { console.log('[teste] backend de janela anulado'); };
WindowDetector.prototype.stopBackend = function () {};
require(path.join(SRC, 'index'));
const WebSocket = require(path.join(SRC, '..', 'node_modules', 'ws'));

const PORT = 8899;
const lanIp = (() => {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        if (/^(docker|podman|cni|br-|veth|virbr|tun|tap|wg|vmnet|lo|zt|tailscale)/i.test(name)) continue;
        for (const i of list) if (i.family === 'IPv4' && !i.internal) return i.address;
    }
    return null;
})();
if (!lanIp) { console.error('Sem IP de LAN nesta máquina; o teste precisa de um endereço não-loopback.'); process.exit(2); }

const req = (host, method, p, { body, headers = {}, raw = false } = {}) => new Promise((resolve, reject) => {
    const data = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = { ...headers };
    if (data) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host, port: PORT, path: p, method, headers: h }, (res) => {
        let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
            let parsed = buf; if (!raw) { try { parsed = JSON.parse(buf); } catch (e) { /* texto */ } }
            resolve({ status: res.statusCode, headers: res.headers, data: parsed, text: buf });
        });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
});
// Guarda toda mensagem desde a abertura: o ws entrega as primeiras no mesmo tick do 'open'
const wsTry = (host, headers = {}) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}:${PORT}/deck`, { headers });
    ws._msgs = [];
    ws.on('message', (m) => { try { ws._msgs.push(JSON.parse(m.toString())); } catch (e) { ws._msgs.push(m.toString()); } });
    const done = (r) => { resolve({ ...r, ws }); };
    ws.once('open', () => done({ open: true }));
    ws.once('unexpected-response', (_q, res) => { done({ open: false, status: res.statusCode }); ws.terminate(); });
    ws.once('error', (e) => done({ open: false, error: e.message }));
});
// Espera (ou acha no buffer) uma mensagem com event === name; fromNow ignora as já recebidas
const waitEvent = (ws, name, ms = 1500, { fromNow = false } = {}) => new Promise((resolve) => {
    const start = fromNow ? ws._msgs.length : 0;
    const find = () => ws._msgs.slice(start).find(m => m && m.event === name) || null;
    const hit = find(); if (hit) return resolve(hit);
    const t = setTimeout(() => { ws.off('message', onMsg); resolve(find()); }, ms);
    const onMsg = () => { const h = find(); if (h) { clearTimeout(t); ws.off('message', onMsg); resolve(h); } };
    ws.on('message', onMsg);
});
const closed = (ws, ms = 2000) => new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    ws.once('close', () => { clearTimeout(t); resolve(true); });
});

let fails = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); if (!ok) fails++; };
const LO = '127.0.0.1';

setTimeout(async () => {
    const openSockets = [];
    try {
        console.log(`[teste] loopback=${LO} lan=${lanIp}`);
        // --- gerenciador só pelo PC ---
        let r = await req(LO, 'GET', '/manage', { raw: true });
        check('loopback GET /manage -> 200 html', r.status === 200 && /manage\.js/.test(r.text), r.status);
        r = await req(lanIp, 'GET', '/manage', { raw: true });
        check('rede GET /manage -> 403', r.status === 403, r.status);
        check('rede /manage mostra aviso em HTML', /text\/html/.test(r.headers['content-type'] || '') && /computador/i.test(r.text), r.headers['content-type']);
        r = await req(lanIp, 'GET', '/manage.js', { raw: true });
        check('rede GET /manage.js -> 403', r.status === 403, r.status);
        r = await req(lanIp, 'GET', '/manage.css', { raw: true });
        check('rede GET /manage.css -> 403', r.status === 403, r.status);

        // --- deck sem emparelhar: só a página, os assets e o emparelhamento ---
        r = await req(lanIp, 'GET', '/', { raw: true });
        check('rede GET / -> 200', r.status === 200 && /deck-grid/.test(r.text), r.status);
        r = await req(lanIp, 'GET', '/app.js', { raw: true });
        check('rede GET /app.js -> 200', r.status === 200, r.status);
        r = await req(lanIp, 'GET', '/style.css', { raw: true });
        check('rede GET /style.css -> 200', r.status === 200, r.status);
        r = await req(lanIp, 'GET', '/api/session');
        check('rede GET /api/session -> guest', r.status === 200 && r.data.role === 'guest' && r.data.device === null, r.data);
        r = await req(LO, 'GET', '/api/session');
        check('loopback GET /api/session -> trusted', r.status === 200 && r.data.role === 'trusted', r.data);
        r = await req(lanIp, 'GET', '/api/config');
        check('rede GET /api/config -> 401', r.status === 401, r.status);
        r = await req(lanIp, 'GET', '/api/status');
        check('rede GET /api/status -> 401', r.status === 401, r.status);
        r = await req(lanIp, 'POST', '/api/profile/switch', { body: { profile: 'default' } });
        check('rede POST /api/profile/switch -> 401', r.status === 401, r.status);
        r = await req(lanIp, 'GET', '/media/qualquer.png', { raw: true });
        check('rede GET /media/* -> 401', r.status === 401, r.status);
        r = await req(lanIp, 'POST', '/api/shutdown');
        check('rede POST /api/shutdown -> 401', r.status === 401, r.status);
        let w = await wsTry(lanIp);
        check('rede WS sem token -> recusado 401', w.open === false && w.status === 401, { open: w.open, status: w.status, error: w.error });

        // --- emparelhamento ---
        r = await req(LO, 'POST', '/api/pair/start', { body: {} });
        check('loopback POST /api/pair/start -> 400 (já confiável)', r.status === 400, r.status);
        r = await req(lanIp, 'POST', '/api/pair/start', { body: {}, headers: { 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 9_3_5 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13G36 Safari/601.1' } });
        check('rede POST /api/pair/start -> 200 com id e expiresAt', r.status === 200 && r.data.success && typeof r.data.id === 'string' && r.data.expiresAt > Date.now(), r.data);
        check('resposta do start não traz o PIN', !('pin' in (r.data || {})));
        const sessionId = r.data.id;
        r = await req(lanIp, 'GET', '/api/pair/pending');
        check('rede GET /api/pair/pending -> 401', r.status === 401, r.status);
        r = await req(LO, 'GET', '/api/pair/pending');
        const pend = (r.data && r.data.pending) || [];
        check('loopback GET /api/pair/pending lista a sessão com PIN de 4 dígitos', pend.length === 1 && pend[0].id === sessionId && /^\d{4}$/.test(pend[0].pin), pend);
        check('pendência traz ip e nome do dispositivo', pend[0] && pend[0].ip === lanIp && /iPad/.test(pend[0].name), pend[0] && { ip: pend[0].ip, name: pend[0].name });
        const pin = pend[0].pin;
        const wrong = pin === '0000' ? '1111' : '0000';
        r = await req(lanIp, 'POST', '/api/pair/verify', { body: { id: sessionId, pin: wrong } });
        check('PIN errado -> 401 com tentativas restantes', r.status === 401 && r.data.attemptsLeft === 4, r.data);
        r = await req(lanIp, 'POST', '/api/pair/verify', { body: { id: sessionId, pin } });
        check('PIN certo -> 200 com token', r.status === 200 && r.data.success && typeof r.data.token === 'string' && r.data.device && r.data.device.id, r.data && { success: r.data.success, device: r.data.device });
        const setCookie = (r.headers['set-cookie'] || [])[0] || '';
        check('PIN certo grava cookie HttpOnly', /^matdeck_device=[A-Za-z0-9_-]+;.*HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Max-Age=\d+/.test(setCookie), setCookie.replace(/=[A-Za-z0-9_-]{20,}/, '=<token>'));
        const token = r.data.token;
        const deviceId = r.data.device.id;
        const cookie = { cookie: `matdeck_device=${token}` };
        r = await req(LO, 'GET', '/api/pair/pending');
        check('sessão consumida sai das pendências', r.data.pending.length === 0);

        // --- dispositivo emparelhado ---
        r = await req(lanIp, 'GET', '/api/session', { headers: cookie });
        check('cookie: /api/session -> device com id', r.data.role === 'device' && r.data.device && r.data.device.id === deviceId, r.data);
        r = await req(lanIp, 'GET', '/api/status', { headers: cookie });
        check('cookie: GET /api/status -> 200', r.status === 200 && r.data.version, r.status);
        r = await req(lanIp, 'GET', '/api/hardware', { headers: cookie });
        check('cookie: GET /api/hardware -> 200', r.status === 200, r.status);
        r = await req(lanIp, 'GET', '/media/nao-existe.png', { headers: cookie, raw: true });
        check('cookie: GET /media/* passa pelo filtro (404 do static)', r.status === 404, r.status);
        r = await req(lanIp, 'GET', '/api/config', { headers: cookie });
        check('cookie: GET /api/config -> 403 (só no PC)', r.status === 403, r.status);
        r = await req(lanIp, 'GET', '/manage', { headers: cookie, raw: true });
        check('cookie: GET /manage -> 403', r.status === 403, r.status);
        r = await req(lanIp, 'POST', '/api/profile/switch', { headers: cookie, body: { profile: 'default' } });
        check('cookie: POST /api/profile/switch -> 403', r.status === 403, r.status);
        r = await req(lanIp, 'GET', '/api/devices', { headers: cookie });
        check('cookie: GET /api/devices -> 403', r.status === 403, r.status);
        r = await req(lanIp, 'GET', '/api/session', { headers: { 'x-matdeck-token': token } });
        check('cabeçalho X-MatDeck-Token também autentica', r.data.role === 'device', r.data);
        r = await req(lanIp, 'GET', '/api/session', { headers: { cookie: 'matdeck_device=tokenInvalido' } });
        check('cookie inválido -> guest', r.data.role === 'guest', r.data);

        w = await wsTry(lanIp, cookie);
        check('cookie: WS conecta', w.open === true, { open: w.open, status: w.status, error: w.error });
        const wsDevice = w.ws; openSockets.push(wsDevice);
        const first = await waitEvent(wsDevice, 'profileList');
        check('WS do dispositivo recebe profileList', !!first, wsDevice._msgs.map(m => m && m.event));
        w = await wsTry(lanIp, { 'x-matdeck-token': token });
        check('cabeçalho: WS conecta (cliente Android nativo)', w.open === true, { open: w.open, status: w.status });
        if (w.ws) openSockets.push(w.ws);
        const wsLo = await wsTry(LO);
        check('loopback: WS conecta sem token', wsLo.open === true);
        if (wsLo.ws) openSockets.push(wsLo.ws);
        await waitEvent(wsLo.ws, 'profileList');

        r = await req(LO, 'GET', '/api/devices');
        const devs = (r.data && r.data.devices) || [];
        check('loopback GET /api/devices lista o dispositivo online', devs.length === 1 && devs[0].id === deviceId && devs[0].online === true && devs[0].ip === lanIp, devs);
        check('lista de dispositivos não expõe token/hash', !JSON.stringify(devs).match(/token/i));
        check('devices.json com modo 0600', (fs.statSync(path.join(process.env.MATDECK_DATA_DIR, 'devices.json')).mode & 0o777) === 0o600);

        // --- evento pairing chega só ao cliente confiável ---
        const evP = waitEvent(wsLo.ws, 'pairing', 2500, { fromNow: true });
        const evD = waitEvent(wsDevice, 'pairing', 1200, { fromNow: true });
        r = await req(lanIp, 'POST', '/api/pair/start', { body: { name: 'Celular' } });
        const sid2 = r.data.id;
        const [gotLo, gotDev] = await Promise.all([evP, evD]);
        check('loopback WS recebe evento pairing com PIN', gotLo && gotLo.event === 'pairing' && gotLo.pending.length === 1 && /^\d{4}$/.test(gotLo.pending[0].pin) && gotLo.pending[0].name === 'Celular', gotLo);
        check('dispositivo não recebe o evento pairing', gotDev === null, gotDev);
        r = await req(lanIp, 'DELETE', `/api/pair/${sid2}`);
        check('rede DELETE /api/pair/:id -> 401', r.status === 401, r.status);
        r = await req(LO, 'DELETE', `/api/pair/${sid2}`);
        check('loopback recusa a sessão', r.status === 200 && r.data.success, r.data);
        r = await req(lanIp, 'POST', '/api/pair/start', { body: {} });
        check('IP recusado fica em cooldown -> 429 com retryAfterMs', r.status === 429 && r.data.retryAfterMs > 0, r.data);

        // --- revogar derruba o socket e volta a exigir PIN ---
        const closedP = closed(wsDevice);
        r = await req(LO, 'DELETE', `/api/devices/${deviceId}`);
        check('loopback DELETE /api/devices/:id -> success', r.status === 200 && r.data.success, r.data);
        check('WS do dispositivo revogado é fechado', await closedP);
        r = await req(lanIp, 'GET', '/api/session', { headers: cookie });
        check('token revogado -> guest', r.data.role === 'guest', r.data);
        r = await req(LO, 'DELETE', `/api/devices/${deviceId}`);
        check('revogar de novo -> 404', r.status === 404, r.status);

        // --- Host e Origin ---
        r = await req(LO, 'GET', '/', { raw: true, headers: { host: 'evil.example.com:8899' } });
        check('Host de fora (rebinding) -> 421', r.status === 421, r.status);
        r = await req(LO, 'GET', '/api/session', { headers: { host: `localhost:${PORT}` } });
        check('Host localhost ok', r.status === 200, r.status);
        r = await req(LO, 'GET', '/api/session', { headers: { host: `${lanIp}:${PORT}` } });
        check('Host com IP da LAN ok', r.status === 200, r.status);
        r = await req(LO, 'GET', '/api/session', { headers: { host: `${os.hostname()}:${PORT}` } });
        check('Host com nome da máquina ok', r.status === 200, r.status);
        w = await wsTry(LO, { host: 'evil.example.com:8899' });
        check('WS com Host de fora recusado', w.open === false, { open: w.open, status: w.status });
        r = await req(LO, 'POST', '/api/autodetect', { body: { enabled: false }, headers: { origin: 'http://evil.example.com' } });
        check('Origin de fora em POST -> 403 (continua)', r.status === 403, r.status);
        r = await req(LO, 'POST', '/api/autodetect', { body: { enabled: false }, headers: { origin: `http://127.0.0.1:${PORT}` } });
        check('Origin própria em POST ok', r.status === 200, r.status);
        w = await wsTry(LO, { origin: 'http://evil.example.com' });
        check('WS com Origin de fora recusado', w.open === false, { open: w.open, status: w.status });
    } catch (e) {
        console.error('ERRO NO TESTE:', e);
        fails++;
    } finally {
        for (const s of openSockets) { try { s.terminate(); } catch (e) {} }
        console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS CHECKS OK');
        setTimeout(() => { process.exitCode = fails ? 1 : 0; process.kill(process.pid, 'SIGTERM'); }, 200);
    }
}, 1500);
