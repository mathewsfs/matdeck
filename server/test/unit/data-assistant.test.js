// Data (assistente de voz): aparência das teclas `data:*` por estado, toque/segurar de "Data: falar",
// escuta livre, e o coletor contra um servidor falso (WebSocket + HTTP): online, eventos, queda, reconexão.
// Uso: node data-assistant.test.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const DataAssistant = require('../../src/dataAssistant');
const { keyStateFor, applyPayload, EMPTY_STATE } = DataAssistant;

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(10); } return true; };
const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Servidor falso da Data: GET /api/state, POST /api/listen|stop|wake e WebSocket /ws com hello. */
function fakeData({ withWs = true } = {}) {
    const snap = { version: '0.1-teste', status: 'idle', wake: { enabled: false, word: 'data' }, brain: { ok: true, label: 'Claude Code' }, stt: { loaded: true, model: 'large-v3-turbo' } };
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const json = body ? JSON.parse(body) : {};
            calls.push({ method: req.method, url: req.url, body: json });
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'GET' && req.url === '/api/state') return res.end(JSON.stringify(snap));
            if (req.url === '/api/listen') return res.end(JSON.stringify({ ok: true, status: snap.status }));
            if (req.url === '/api/stop') return res.end(JSON.stringify({ ok: true }));
            if (req.url === '/api/wake') { snap.wake.enabled = 'enabled' in json ? !!json.enabled : !snap.wake.enabled; return res.end(JSON.stringify({ ok: true, ...snap })); }
            res.statusCode = 404; res.end('{}');
        });
    });
    const sockets = new Set();
    let wss = null;
    if (withWs) {
        wss = new WebSocketServer({ noServer: true });
        server.on('upgrade', (req, socket, head) => {
            if (req.url !== '/ws') { socket.destroy(); return; }
            wss.handleUpgrade(req, socket, head, (ws) => { sockets.add(ws); ws.on('close', () => sockets.delete(ws)); ws.send(JSON.stringify({ type: 'hello', ...snap })); });
        });
    }
    const emit = (ev) => { for (const ws of sockets) ws.send(JSON.stringify(ev)); };
    return {
        snap, calls, emit, sockets,
        listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)),
        close: () => new Promise((r) => { for (const ws of sockets) ws.terminate(); server.close(() => r()); })
    };
}

(async () => {
    // --- aparência por estado ---------------------------------------------------------------
    const off = keyStateFor('data:talk', EMPTY_STATE);
    check('offline: falar mostra OFF cinza, sem pulso', off.badge === 'OFF' && off.badgeColor === '#6B7280' && off.active === false && off.pulse === false, off);
    check('offline: escuta livre mostra n/d e parar mostra OFF', keyStateFor('data:wake', EMPTY_STATE).badge === 'n/d' && keyStateFor('data:stop', EMPTY_STATE).badge === 'OFF');
    check('offline: status avisa servidor fora do ar', /fora do ar/.test(keyStateFor('data:status', EMPTY_STATE).statRows[0].sub));

    const idle = keyStateFor('data:talk', applyPayload(EMPTY_STATE, { status: 'idle' }));
    check('idle: PRONTA, neutro (sem fundo, sem borda forçada)', idle.badge === 'PRONTA' && idle.bgColor === undefined && idle.borderColor === undefined && idle.active === false, idle);
    const lis = keyStateFor('data:talk', applyPayload(EMPTY_STATE, { status: 'listening' }));
    check('listening: OUVINDO vermelho, ativa e pulsando', lis.badge === 'OUVINDO' && lis.active === true && lis.pulse === true && /^#/.test(lis.bgColor), lis);
    check('listening: fundo não é o vermelho que o deck trata como "mutado"', lis.bgColor !== '#DC2626', lis.bgColor);
    const tr = keyStateFor('data:talk', applyPayload(EMPTY_STATE, { status: 'transcribing' }));
    const th = keyStateFor('data:talk', applyPayload(EMPTY_STATE, { status: 'thinking' }));
    check('transcribing e thinking: âmbar', tr.badge === 'TRANSCREVENDO' && th.badge === 'PENSANDO' && tr.badgeColor === '#F59E0B' && th.badgeColor === '#F59E0B', [tr, th]);
    const sp = keyStateFor('data:talk', applyPayload(EMPTY_STATE, { status: 'speaking' }));
    check('speaking: FALANDO verde', sp.badge === 'FALANDO' && sp.badgeColor === '#16A34A', sp);
    check('parar: ativa enquanto fala/pensa/transcreve, neutra em idle', keyStateFor('data:stop', applyPayload(EMPTY_STATE, { status: 'speaking' })).active === true && keyStateFor('data:stop', applyPayload(EMPTY_STATE, { status: 'transcribing' })).active === true && keyStateFor('data:stop', applyPayload(EMPTY_STATE, { status: 'idle' })).badge === null);
    const wakeOn = keyStateFor('data:wake', applyPayload(EMPTY_STATE, { status: 'idle', wake: { enabled: true, word: 'data' } }));
    check('escuta livre: ON azul e ativa; OFF cinza', wakeOn.badge === 'ON' && wakeOn.active === true && keyStateFor('data:wake', applyPayload(EMPTY_STATE, { status: 'idle', wake: { enabled: false } })).badge === 'OFF', wakeOn);
    const st = keyStateFor('data:status', applyPayload(EMPTY_STATE, { status: 'listening', wake: { enabled: false, word: 'data' }, brain: { ok: true, label: 'Claude Code' }, stt: { loaded: true, model: 'large-v3-turbo' } }));
    check('status: cabeçalho OUVINDO e linhas cérebro/escuta/STT', st.statHead === 'OUVINDO' && st.statRows.map(r => r.k).join() === 'Cérebro,Escuta livre,STT' && st.statRows[0].v === 'OK' && st.statRows[2].sub === 'large-v3-turbo', st);
    check('ação desconhecida: null', keyStateFor('data:xyz', EMPTY_STATE) === null);
    check('applyPayload ignora campos estranhos e mantém a palavra de ativação', applyPayload(applyPayload(EMPTY_STATE, { wake: { enabled: true, word: 'data' } }), { wake: { enabled: false }, foo: 1 }).wake.word === 'data');

    // --- toque e segurar, sem rede -----------------------------------------------------------
    {
        const calls = [];
        const fetch = async (url, init) => { calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, status: 'idle', wake: { enabled: true, word: 'data' } }) }; };
        const da = new DataAssistant(null, { fetch, holdMs: 60 });
        await da.handleAction('data:talk', 'keyDown');
        await da.handleAction('data:talk', 'keyUp');
        check('toque curto em "falar": POST /api/listen {action:toggle}', calls.length === 1 && calls[0].url === 'http://127.0.0.1:8765/api/listen' && calls[0].body.action === 'toggle', calls);
        check('toque não assume o status da resposta (vem pelo WebSocket)', da.state.online === false);
        await da.handleAction('data:talk', 'keyDown');
        await sleep(120);
        await da.handleAction('data:talk', 'keyUp');
        check('segurar "falar": POST /api/stop ao passar o limiar e nada ao soltar', calls.length === 2 && calls[1].url.endsWith('/api/stop') && calls[1].method === 'POST', calls.slice(1));
        await da.handleAction('data:stop', 'keyDown');
        await da.handleAction('data:stop', 'keyUp');
        check('"parar": POST /api/stop só no keyDown', calls.length === 3 && calls[2].url.endsWith('/api/stop'));
        await da.handleAction('data:wake', 'keyDown');
        check('"escuta livre": POST /api/wake sem campo enabled (alterna) e aplica o snapshot da resposta', calls.length === 4 && calls[3].url.endsWith('/api/wake') && !('enabled' in calls[3].body) && da.state.wake.enabled === true, calls[3]);
        check('sem config: URL padrão', da.baseUrl() === DataAssistant.DEFAULT_URL && da.wsUrl() === 'ws://127.0.0.1:8765/ws');
        const cfg = { get: () => ({ url: 'http://10.0.0.5:9000/' }) };
        const da2 = new DataAssistant(cfg, { fetch });
        check('config data.url: barra final removida e ws:// derivado', da2.baseUrl() === 'http://10.0.0.5:9000' && da2.wsUrl() === 'ws://10.0.0.5:9000/ws', da2.wsUrl());
        da.stop();
    }

    // --- coletor contra o servidor falso ----------------------------------------------------
    {
        const port = 18700 + Math.floor(Math.random() * 1000);
        const warns = []; const logs = [];
        const origWarn = console.warn; const origLog = console.log;
        console.warn = (...a) => { warns.push(a.join(' ')); };
        console.log = (...a) => { if (/^\[Data\]/.test(String(a[0]))) logs.push(a.join(' ')); else origLog(...a); };
        const cfg = { get: () => ({ url: `http://127.0.0.1:${port}` }) };
        const da = new DataAssistant(cfg, { pollMs: 80, syncMs: 200, reconnectMinMs: 50 });
        const changes = []; da.on('change', (s) => changes.push(s.status));

        da.start();
        await sleep(400);
        check('sem servidor: fica offline e avisa uma vez só', da.state.online === false && warns.filter(w => /fora do ar/.test(w)).length === 1, warns);

        const srv = fakeData();
        await srv.listen(port);
        check('servidor sobe: reconecta sozinho e fica online', await waitFor(() => da.state.online && da.wsOpen, 4000), { online: da.state.online, ws: da.wsOpen });
        check('hello do WebSocket traz versão e escuta livre', da.state.version === '0.1-teste' && da.state.wake.word === 'data' && da.state.brain.label === 'Claude Code', da.snapshot());
        check('log de "no ar" uma vez', logs.filter(l => /no ar/.test(l)).length === 1, logs);

        srv.emit({ type: 'state', status: 'listening', detail: '' });
        check('evento state → OUVINDO na tecla', await waitFor(() => da.state.status === 'listening'), da.state.status);
        check('tecla "falar" vem do estado vivo', da.stateFor('data:talk').badge === 'OUVINDO');
        srv.emit({ type: 'state', status: 'transcribing', detail: '1.2s' });
        srv.emit({ type: 'state', status: 'thinking', detail: '' });
        srv.emit({ type: 'state', status: 'speaking', detail: '' });
        srv.snap.status = 'speaking';   // o servidor falso passa a responder /api/state coerente com os eventos
        check('sequência transcribing → thinking → speaking', await waitFor(() => da.state.status === 'speaking') && changes.includes('transcribing') && changes.includes('thinking'), changes);
        srv.snap.wake.enabled = true;
        srv.emit({ type: 'status', ...srv.snap });
        check('evento status atualiza a escuta livre', await waitFor(() => da.state.wake.enabled === true), da.state.wake);
        srv.snap.wake.enabled = false;
        srv.emit({ type: 'config', config: {} });
        check('evento config força conferência em /api/state', await waitFor(() => da.state.wake.enabled === false, 2000), da.state.wake);
        srv.emit({ type: 'telemetry', cpu: 10 });
        srv.emit('lixo');
        await sleep(50);
        check('eventos sem estado e mensagens inválidas são ignorados', da.state.status === 'speaking');

        await da.handleAction('data:talk', 'keyDown'); await da.handleAction('data:talk', 'keyUp');
        check('toque em "falar" chega ao servidor como toggle', srv.calls.some(c => c.url === '/api/listen' && c.body.action === 'toggle'), srv.calls);

        const warnsBefore = warns.length;
        await srv.close();
        check('servidor cai: offline em pouco tempo', await waitFor(() => da.state.online === false, 3000), da.state.online);
        await sleep(400);
        check('queda: um aviso só, mesmo com várias tentativas', warns.length - warnsBefore === 1, warns.slice(warnsBefore));
        check('backoff da reconexão cresce', da.reconnectMs > 50, da.reconnectMs);

        const srv2 = fakeData();
        await srv2.listen(port);
        check('servidor volta: online de novo pelo backoff', await waitFor(() => da.state.online && da.wsOpen, 5000), { online: da.state.online, ws: da.wsOpen });

        // só HTTP (sem /ws): sondagem mantém o estado
        await srv2.close();
        await waitFor(() => !da.state.online, 3000);
        const srv3 = fakeData({ withWs: false });
        await srv3.listen(port);
        check('sem WebSocket: a sondagem HTTP deixa online', await waitFor(() => da.state.online, 4000) && !da.wsOpen, { online: da.state.online, ws: da.wsOpen });
        srv3.snap.status = 'thinking';
        check('sondagem acompanha mudança de estado', await waitFor(() => da.state.status === 'thinking', 2000), da.state.status);

        // mudança de endereço nos Ajustes → reconecta no novo
        const port2 = port + 1;
        const srv4 = fakeData();
        await srv4.listen(port2);
        cfg.get = () => ({ url: `http://127.0.0.1:${port2}` });
        da.reconnect();
        check('reconnect() após mudar data.url conecta no novo endereço', await waitFor(() => da.wsOpen && da.state.online, 4000) && srv4.sockets.size === 1, { ws: da.wsOpen, sockets: srv4.sockets.size });

        da.stop();
        await sleep(100);
        check('stop() fecha o WebSocket', srv4.sockets.size === 0, srv4.sockets.size);
        await srv3.close(); await srv4.close();
        console.warn = origWarn; console.log = origLog;
    }

    // --- integração com o resto do projeto --------------------------------------------------
    const catalog = read('server/src/actionCatalog.js');
    check('catálogo: grupo data com falar/parar/escuta livre/status', /id: 'data'/.test(catalog) && ['data:talk', 'data:stop', 'data:wake', 'data:status'].every(id => catalog.includes(`'${id}'`)));
    const icons = JSON.parse(read('server/src/icons.json'));
    check('ícone "data" no icons.json e na licença', /^data:image\/png;base64,/.test(icons.data || '') && /`data` ← `circle-dot-dashed`/.test(read('server/src/ICONS-LICENSE.md')) && /data: \{ lucide: 'circle-dot-dashed' \}/.test(read('server/scripts/build-icons.js')));
    const ConfigStore = require('../../src/config');
    check('config: padrão data.url', new ConfigStore(path.join(require('os').tmpdir(), `matdeck-data-cfg-${Date.now()}.json`)).get('data').url === 'http://127.0.0.1:8765');
    check('gerenciador: Ajustes → Data (data.url)', /data-path="data\.url"/.test(read('server/web/manage.html')) && /data\.url/.test(read('server/web/manage.js')));
    check('deck: "falar" é tecla de segurar (keyDown/keyUp separados) nos dois decks', /ts:whisper\|data:talk/.test(read('server/web/app.js')) && /ts:whisper\|data:talk/.test(read('server/web/app.legacy.js')));
    check('deck: classe key-pulse nos dois decks e no CSS', /cfg\.pulse \? ' key-pulse'/.test(read('server/web/app.js')) && /cfg\.pulse \? ' key-pulse'/.test(read('server/web/app.legacy.js')) && /\.deck-key\.key-pulse/.test(read('server/web/style.css')));
    const index = read('server/src/index.js');
    check('servidor: rota /api/data, telemetria e ação data:*', /\/api\/data'/.test(index) && /setupDataTelemetry\(\)/.test(index) && /prefix === 'data'/.test(index));
    check('README e CHANGELOG documentam o grupo', /### Data \(assistente de voz\)/.test(read('README.md')) && /Data \(assistente de voz\)/.test(read('CHANGELOG.md')));

    console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('ERRO', e); process.exitCode = 1; });
