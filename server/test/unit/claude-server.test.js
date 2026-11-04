// Servidor inteiro (em processo, plataforma darwin com helper falso) com as teclas claude:*: rota GET /api/claude,
// POST /api/claude/refresh (só loopback), tecla já com o estado ao abrir a tela, updateKey ao chegar uma sessão,
// título do projeto (TITLE_IS_CONTENT), foco por PID no keyDown e vagas que mudam com a configuração.
// Usa pastas temporárias (MATDECK_DATA_DIR, MATDECK_CLAUDE_STATE_DIR, MATDECK_CLAUDE_HOOK_DIR). Uso: node claude-server.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const WebSocket = require('ws');
const fakeHelper = require('../fake-helper');

let fails = 0;
const out = console.log;
const logged = [];
const check = (n, ok, extra) => { out((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(25); } return true; };
const request = (port, method, p, body) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
        let b = ''; res.on('data', (d) => b += d);
        res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) { /* corpo não é JSON */ } resolve({ status: res.statusCode, body: b, json }); });
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message, json: null }));
    if (data) r.write(data);
    r.end();
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-claude-srv-'));
const sock = path.join(tmp, 'h.sock');
const stateDir = path.join(tmp, 'claude-sessions');
const hookDir = path.join(tmp, 'hook');
const port = 20000 + Math.floor(Math.random() * 1000);
fs.mkdirSync(stateDir, { recursive: true });

(async () => {
    const fake = await fakeHelper.start({ socketPath: sock, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'arm64' }, permissions: { accessibility: true } } });
    for (const op of ['permissions.status', 'window.subscribe', 'audio.master.subscribe']) fake.setHandler(op, () => ({ accessibility: true, subscribed: true }));
    fake.setHandler('window.active', () => ({ app: 'Finder', bundleId: 'com.apple.finder', pid: 1, title: '' }));
    fake.setHandler('audio.master.get', () => ({ volume: 30, muted: false }));
    fake.setHandler('apps.list', () => ({ apps: [] }));
    Object.assign(process.env, { MATDECK_PLATFORM: 'darwin', MATDECK_HELPER_SOCKET: sock, MATDECK_DATA_DIR: path.join(tmp, 'data'), PORT: String(port), MATDECK_TRAY: '0', MATDECK_ELGATO: '0', MATDECK_CLAUDE_STATE_DIR: stateDir, MATDECK_CLAUDE_HOOK_DIR: hookDir });
    delete process.env.MATDECK_HELPER_APP;

    console.log = (...x) => logged.push(x.join(' '));   // logs do servidor ficam fora da saída; os checks usam `out`
    console.warn = console.log;
    const MatDeckServer = require('../../src/index.js');
    const server = new MatDeckServer();
    const up = await waitFor(() => logged.some((l) => /Sessão: macOS/.test(l)), 15000);
    check('servidor sobe', up, logged.slice(-5));

    // --- rotas
    const info = (await request(port, 'GET', '/api/claude')).json || {};
    check('GET /api/claude responde com dirExists e slots', info.slots === 4 && typeof info.dirExists === 'boolean' && info.port === port && info.dir === stateDir, info);
    check('hook instalado na pasta temporária (nunca na home)', await waitFor(() => fs.existsSync(path.join(hookDir, 'claude-code-hook.py')), 3000) && info.hookPath === path.join(hookDir, 'claude-code-hook.py'), info.hookPath);
    const refresh = await request(port, 'POST', '/api/claude/refresh');
    check('POST /api/claude/refresh do loopback: success', refresh.status === 200 && refresh.json && refresh.json.success === true, refresh);
    const actions = (await request(port, 'GET', '/api/actions')).json || { groups: [] };
    const cg = actions.groups.find((x) => x.id === 'claude');
    check('/api/actions traz o grupo claude só com o resumo', !!cg && cg.actions.length === 1 && cg.actions[0].id === 'claude:summary', cg && cg.actions.map((a) => a.id));

    // --- Ajustes e documentação
    const root = path.join(__dirname, '..', '..', '..');
    const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
    const html = read('server/web/manage.html');
    check('manage.html tem os campos claude.*', ['claude.sessionsDir', 'claude.slots', 'claude.workingMinutes', 'claude.doneMinutes', 'claude.waitingMinutes', 'claude.staleMinutes'].every((p) => html.includes(`data-path="${p}"`)));
    check('manage.html tem o trecho do hook e a linha de estado', html.includes('id="claude-hook-snippet"') && html.includes('id="claude-status"'));
    check('snapshot traz hookPath absoluto da cópia instalada', path.isAbsolute(info.hookPath) && info.hookPath.endsWith('claude-code-hook.py') && fs.existsSync(info.hookPath), info.hookPath);
    check('README documenta o hook', read('README.md').includes('claude-code-hook.py'));
    check('CHANGELOG cita o grupo e o hook', read('CHANGELOG.md').includes('claude-code-hook.py') && read('CHANGELOG.md').includes('Grupo **Claude Code**'));

    // --- trecho do hook em Ajustes (manage.js, extraído e executado com um DOM falso)
    check('snapshot traz defaultDir (pasta padrão, absoluta)', typeof info.defaultDir === 'string' && path.isAbsolute(info.defaultDir) && info.defaultDir.endsWith(path.join('.local', 'state', 'matdeck', 'claude-sessions')), info.defaultDir);
    const manageSrc = read('server/web/manage.js');
    const from = manageSrc.indexOf('const CLAUDE_HOOK_EVENTS');
    const to = manageSrc.indexOf("document.getElementById('btn-claude-copy').addEventListener");
    check('manage.js: bloco do trecho do hook localizado', from >= 0 && to > from);
    const makeCtx = (apiData) => {
        const els = { 'claude-hook-snippet': { textContent: 'Carregando…', disabled: false }, 'claude-status': { textContent: '' }, 'btn-claude-copy': { disabled: false } };
        const copied = [];
        const ctx = vm.createContext({
            document: { getElementById: (id) => els[id] || null },
            apiFetch: async () => apiData,
            navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } },
            toast: () => {}, Date, Math, JSON, String
        });
        vm.runInContext(manageSrc.slice(from, to), ctx);
        return { ctx, els, copied };
    };
    const def = '/home/u/.local/state/matdeck/claude-sessions';
    const hookP = "/home/u/.local/state/matdeck/claude-code-hook.py";
    const snip = (hp, dir, defaultDir) => { const c = makeCtx({ ok: true, data: {} }); return vm.runInContext('claudeHookSnippet', c.ctx)(hp, dir, defaultDir); };
    const cmds = (text) => Object.values(JSON.parse(text).hooks).map((h) => h[0].hooks[0].command);
    check('trecho sem pasta personalizada: sem prefixo MATDECK_CLAUDE_STATE_DIR', cmds(snip(hookP, def, def)).every((c) => c.startsWith("python3 -I ") && !c.includes('MATDECK_CLAUDE_STATE_DIR')), cmds(snip(hookP, def, def))[0]);
    check('trecho sem dir/defaultDir (servidor antigo): sem prefixo', cmds(snip(hookP, undefined, undefined)).every((c) => !c.includes('MATDECK_CLAUDE_STATE_DIR')));
    const custom = cmds(snip(hookP, "/data/o'brien/sessões", def));
    check('trecho com pasta personalizada: cada comando leva o prefixo com aspas simples escapadas', custom.length === 7 && custom.every((c) => c.startsWith("MATDECK_CLAUDE_STATE_DIR='/data/o'\\''brien/sessões' python3 -I ")), custom[0]);
    check('trecho: o evento continua no fim do comando', custom[0].endsWith(' SessionStart') && custom[6].endsWith(' SessionEnd'), custom);

    // botão Copiar: só habilita com um trecho de verdade e copia a variável, nunca o texto do <pre>
    let c1 = makeCtx({ ok: false, data: null });
    await vm.runInContext('loadClaudeInfo', c1.ctx)();
    check('servidor fora do ar: Copiar fica desabilitado', c1.els['btn-claude-copy'].disabled === true, c1.els['btn-claude-copy']);
    await vm.runInContext('copyClaudeSnippet', c1.ctx)();
    check('servidor fora do ar: nada é copiado (nem a mensagem de erro)', c1.copied.length === 0, c1.copied);
    let c2 = makeCtx({ ok: true, data: { dirExists: true, total: 1, hookPath: hookP, dir: def, defaultDir: def } });
    c2.els['btn-claude-copy'].disabled = true;
    await vm.runInContext('loadClaudeInfo', c2.ctx)();
    check('com o caminho do hook: Copiar habilita', c2.els['btn-claude-copy'].disabled === false);
    c2.els['claude-hook-snippet'].textContent = 'texto qualquer do pre';
    await vm.runInContext('copyClaudeSnippet', c2.ctx)();
    check('Copiar copia o trecho guardado, não o texto do <pre>', c2.copied.length === 1 && c2.copied[0] === snip(hookP, def, def), c2.copied);
    let c3 = makeCtx({ ok: true, data: { dirExists: false } });
    await vm.runInContext('loadClaudeInfo', c3.ctx)();
    check('sem hookPath: Copiar fica desabilitado', c3.els['btn-claude-copy'].disabled === true);
    check('manage.html: Copiar nasce desabilitado', /id="btn-claude-copy"[^>]*\bdisabled\b/.test(html));
    check('Ajustes e README mencionam MATDECK_CLAUDE_STATE_DIR', html.includes('MATDECK_CLAUDE_STATE_DIR') && read('README.md').includes('MATDECK_CLAUDE_STATE_DIR'));

    // --- tela com teclas claude:* e um deck conectado
    const preset = { name: 'Claude teste', rows: 3, cols: 5, keys: [
        { index: 0, actionId: 'claude:summary', title: 'Meu título', colSpan: 4, rowSpan: 2 }
    ] };
    check('preset salvo', (await request(port, 'POST', '/api/presets/claudetest', preset)).json.success === true);
    const msgs = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/deck`);
    ws.on('message', (m) => { try { msgs.push(JSON.parse(m)); } catch (e) { /* ignora */ } });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    await waitFor(() => msgs.some((m) => m.event === 'loadProfile'));
    check('com deck conectado o coletor entra em modo tempo real', await waitFor(() => server.claudeSessions.viewers === true, 3000));
    await request(port, 'POST', '/api/presets/claudetest/apply');
    check('tela claudetest chega ao deck', await waitFor(() => msgs.some((m) => m.event === 'loadProfile' && m.id === 'claudetest')));
    const loaded = [...msgs].reverse().find((m) => m.event === 'loadProfile' && m.id === 'claudetest');
    const keyDef = (loaded && loaded.keys || []).find((k) => k.index === 0) || {};
    check('resumo 4×2 chega ao deck com statMode meters, "nenhum terminal" e o tamanho pedido', keyDef.statMode === 'meters' && Array.isArray(keyDef.statRows) && keyDef.statRows[0].k === 'nenhum terminal' && keyDef.colSpan === 4 && keyDef.rowSpan === 2, keyDef);
    check('título do usuário no resumo é mantido pelo servidor (o deck mostra o rótulo)', keyDef.title === 'Meu título', keyDef.title);

    // --- uma sessão esperando você aparece na tecla
    const now = Date.now() / 1000;
    const session = (id, state, cwd, pids) => fs.writeFileSync(path.join(stateDir, `${id}.json`), JSON.stringify({ session_id: id, state, ts: now, cwd, window: { pids, term_program: 'Maestri' } }));
    session('a', 'waiting', '/x/apk-matdeck', [4242, 1000]);
    session('b', 'working', '/x/painel', [777]);
    const r2 = await request(port, 'POST', '/api/claude/refresh');
    check('refresh de novo responde success', r2.status === 200 && r2.json.success === true);
    const upd = (idx, pred) => msgs.find((m) => m.event === 'updateKey' && m.profile === 'claudetest' && m.keyIndex === idx && pred(m.key));
    check('updateKey do resumo chega com a waiting na primeira linha e pulse', await waitFor(() => upd(0, (k) => k.pulse === true && Array.isArray(k.statRows) && k.statRows[0].k === 'apk-matdeck' && k.statRows[0].color === '#F87171')), msgs.filter((m) => m.event === 'updateKey').slice(-3));
    const got = upd(0, (k) => k.pulse === true);
    check('segunda linha é a sessão em trabalho', !!got && got.key.statRows[1].k === 'painel' && got.key.statRows[1].color === '#3B82F6', got && got.key.statRows);

    // --- keyDown foca a janela pelos PIDs
    const focused = [];
    server.platform.windows.focus = async (t) => { focused.push(t); return true; };
    ws.send(JSON.stringify({ event: 'keyDown', profile: 'claudetest', keyIndex: 0 }));
    ws.send(JSON.stringify({ event: 'keyUp', profile: 'claudetest', keyIndex: 0 }));
    check('keyDown na vaga chama o foco com os pids (windows.focus espiado)', await waitFor(() => focused.length > 0) && focused[0].pids.join() === '4242,1000', focused);
    await sleep(100);
    check('keyUp não foca de novo', focused.length === 1, focused);

    // --- mudar as linhas na configuração atualiza o resumo (sem evento do coletor)
    msgs.length = 0;
    server.config.set('claude', { slots: 1 });
    check('slots=1: resumo passa a 1 linha e avisa +1 no cabeçalho', await waitFor(() => upd(0, (k) => Array.isArray(k.statRows) && k.statRows.length === 1 && /\+1$/.test(k.statHead))), msgs.filter((m) => m.event === 'updateKey').slice(-3));
    check('GET /api/claude reflete slots=1', ((await request(port, 'GET', '/api/claude')).json || {}).slots === 1);

    // --- encerra pelo caminho normal (SIGTERM → shutdown → stop dos coletores)
    ws.close();
    await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exitCode = fails ? 1 : 0;
    out(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.kill(process.pid, 'SIGTERM');
})().catch((e) => { out('ERRO', e); process.exitCode = 1; process.kill(process.pid, 'SIGTERM'); });
