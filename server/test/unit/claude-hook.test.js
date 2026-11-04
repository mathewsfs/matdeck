// Hook do Claude Code (scripts/claude-code-hook.py): grava um arquivo JSON por sessão (estado, ferramenta, janela)
// e avisa o MatDeck com POST /api/claude/refresh. Roda o script de verdade contra um servidor HTTP de verdade.
// Uso: node claude-hook.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

const ROOT = path.join(__dirname, '..', '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'claude-code-hook.py');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-claude-hook-'));
const dir = path.join(tmp, 'sessions');
const SID = 'sess-1_abc';
const file = path.join(dir, SID + '.json');

let refreshCalls = 0;
const lastRequest = { method: null, url: null, body: null };

// spawn assíncrono (não spawnSync): o servidor de teste vive neste processo e precisa responder enquanto o hook roda.
function exec(args, input, env) {
    return new Promise((resolve) => {
        const e = { ...process.env, MATDECK_CLAUDE_STATE_DIR: dir, ...env };
        for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
        const child = spawn('python3', ['-I', HOOK, ...args], { env: e, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}
const readRecord = (sid = SID) => { try { return JSON.parse(fs.readFileSync(path.join(dir, sid + '.json'), 'utf8')); } catch (_) { return null; } };

(async () => {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            if (req.method === 'POST' && req.url === '/api/claude/refresh') refreshCalls++;
            lastRequest.method = req.method; lastRequest.url = req.url; lastRequest.body = body;
            res.end('{"success":true}');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const runHook = async (event, payload, env) => {
        const r = await exec(event ? [event] : [], JSON.stringify({ session_id: SID, cwd: '/tmp/proj', transcript_path: '/tmp/t.jsonl', ...payload }), { MATDECK_PORT: String(port), ...env });
        return { ...r, rec: readRecord() };
    };

    // --- SessionStart: idle + cadeia de processos + ambiente
    let r = await runHook('SessionStart', {});
    let rec = r.rec;
    check('SessionStart sai com 0 e grava idle', r.status === 0 && rec && rec.state === 'idle' && rec.event === 'SessionStart', { status: r.status, rec, err: r.stderr });
    check('SessionStart grava os campos do contrato', rec && ['session_id', 'state', 'event', 'ts', 'cwd', 'transcript_path', 'tool', 'detail', 'prompt', 'turn_started', 'notification_type', 'window'].every((k) => k in rec) && rec.session_id === SID && rec.cwd === '/tmp/proj' && rec.transcript_path === '/tmp/t.jsonl', rec);
    check('SessionStart grava idle com window.pids contendo o pai do hook', rec && rec.state === 'idle' && Array.isArray(rec.window.pids) && rec.window.pids.includes(process.pid), rec && rec.window);
    check('window.pids tem no máximo 8 entradas, todas inteiras', rec.window.pids.length <= 8 && rec.window.pids.every(Number.isInteger), rec.window.pids);
    check('o pai do hook é o primeiro da cadeia', rec.window.pids[0] === process.pid, rec.window.pids);
    r = await runHook('SessionStart', {}, { TERM_PROGRAM: 'Maestri', MAESTRI_TERMINAL_ID: 't-1', MAESTRI_WORKSPACE_ID: 'w-9' });
    check('window.term_program vem do ambiente', r.rec.window.term_program === 'Maestri' && r.rec.window.maestri_terminal_id === 't-1' && r.rec.window.maestri_workspace_id === 'w-9', r.rec.window);
    r = await runHook('SessionStart', {}, { TERM_PROGRAM: undefined, MAESTRI_TERMINAL_ID: undefined, MAESTRI_WORKSPACE_ID: undefined });
    check('sem as variáveis de ambiente os campos da janela são null', r.rec.window.term_program === null && r.rec.window.maestri_terminal_id === null && r.rec.window.maestri_workspace_id === null, r.rec.window);

    // --- UserPromptSubmit
    const longPrompt = 'Faça isso\ne depois\n\n  aquilo   ' + 'x'.repeat(200);
    r = await runHook('UserPromptSubmit', { prompt: longPrompt }, { TERM_PROGRAM: 'Maestri', MAESTRI_TERMINAL_ID: 't-2' });
    rec = r.rec;
    check('UserPromptSubmit: working, prompt em uma linha de até 80 chars, turn_started numérico',
        rec.state === 'working' && typeof rec.prompt === 'string' && !/\s{2}|\n/.test(rec.prompt) && rec.prompt.length === 80 && rec.prompt.startsWith('Faça isso e depois aquilo ') && typeof rec.turn_started === 'number', rec);
    check('UserPromptSubmit recalcula a janela', rec.window.maestri_terminal_id === 't-2' && rec.window.pids.includes(process.pid), rec.window);

    // --- PreToolUse
    r = await runHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test -- --watch', description: 'Roda os testes' } });
    rec = r.rec;
    check('PreToolUse Bash: tool e detail = description', rec.state === 'working' && rec.tool === 'Bash' && rec.detail === 'Roda os testes', rec);
    check('PreToolUse mantém window do registro anterior', rec.window.pids.length > 0 && rec.window.maestri_terminal_id === 't-2', rec.window);
    check('PreToolUse mantém o prompt e o turn_started do turno', rec.prompt && rec.prompt.startsWith('Faça isso') && typeof rec.turn_started === 'number', rec);
    r = await runHook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/home/x/src/components/Hero.tsx' } });
    check('PreToolUse Edit: detail = basename do file_path', r.rec.tool === 'Edit' && r.rec.detail === 'Hero.tsx', r.rec);
    r = await runHook('PostToolUse', { tool_name: 'Grep', tool_input: { pattern: 'foo.*bar' } });
    check('PostToolUse Grep: detail = pattern', r.rec.state === 'working' && r.rec.tool === 'Grep' && r.rec.detail === 'foo.*bar', r.rec);

    // --- Notification
    r = await runHook('Notification', { notification_type: 'permission_prompt' });
    check('Notification permission_prompt: waiting', r.rec.state === 'waiting' && r.rec.notification_type === 'permission_prompt', r.rec);
    check('Notification mantém a janela', r.rec.window.pids.length > 0, r.rec.window);
    r = await runHook('Notification', { notification_type: 'idle_prompt' });
    check('Notification idle_prompt: done', r.rec.state === 'done' && r.rec.tool === null && r.rec.notification_type === 'idle_prompt', r.rec);

    // --- Stop
    await runHook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a/b.txt' } });
    r = await runHook('Stop', {});
    check('Stop: done sem tool', r.rec.state === 'done' && r.rec.tool === null && r.rec.detail === null && r.rec.turn_started === null, r.rec);
    check('Stop mantém a janela', r.rec.window.pids.includes(process.pid), r.rec.window);
    check('não deixa .tmp para trás', fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), fs.readdirSync(dir));

    // --- evento sem registro anterior que não é SessionStart: window null
    r = await runHook('PreToolUse', { session_id: 'other-1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const other = readRecord('other-1');
    check('evento sem registro anterior: window null', other && other.window === null && other.detail === 'ls', other);
    fs.rmSync(path.join(dir, 'other-1.json'), { force: true });

    // --- SessionEnd
    r = await runHook('SessionEnd', {});
    check('SessionEnd apaga o arquivo', r.status === 0 && !fs.existsSync(file), r.status);

    // --- entradas inválidas
    r = await runHook('SessionStart', { session_id: '../etc/passwd' });
    check('session_id inválido não grava', r.status === 0 && fs.readdirSync(dir).length === 0, fs.readdirSync(dir));
    r = await exec(['SessionStart'], 'isto não é json', { MATDECK_PORT: String(port) });
    check('stdin inválido sai com 0 e não grava', r.status === 0 && fs.readdirSync(dir).length === 0, { status: r.status, files: fs.readdirSync(dir) });
    r = await exec([], '', { MATDECK_PORT: String(port) });
    check('sem argumento e sem stdin sai com 0', r.status === 0 && fs.readdirSync(dir).length === 0, r.status);
    r = await exec(['EventoQueNaoExiste'], JSON.stringify({ session_id: SID }), { MATDECK_PORT: String(port) });
    check('evento desconhecido sai com 0 e não grava', r.status === 0 && !fs.existsSync(file), r.status);

    // --- sem argumento usa hook_event_name do payload
    r = await runHook(null, { hook_event_name: 'UserPromptSubmit', prompt: 'oi' });
    check('sem argumento usa hook_event_name do payload', r.status === 0 && r.rec && r.rec.event === 'UserPromptSubmit' && r.rec.state === 'working' && r.rec.prompt === 'oi', r.rec);
    await runHook('SessionEnd', {});

    // --- aviso ao servidor
    refreshCalls = 0;
    r = await runHook('SessionStart', {});
    check('avisa o MatDeck por POST /api/claude/refresh', refreshCalls === 1 && lastRequest.method === 'POST' && lastRequest.url === '/api/claude/refresh' && lastRequest.body === '', { refreshCalls, lastRequest });
    const before = refreshCalls;
    await runHook('Stop', {});
    await runHook('SessionEnd', {});
    check('avisa também em Stop e SessionEnd', refreshCalls === before + 2, { before, refreshCalls });

    // --- proxy no ambiente (herdado do Claude Code) não pode desviar o POST para 127.0.0.1
    refreshCalls = 0;
    const deadProxy = 'http://127.0.0.1:' + (port === 9 ? 10 : 9);
    r = await runHook('SessionStart', {}, { http_proxy: deadProxy, HTTP_PROXY: deadProxy, https_proxy: deadProxy, HTTPS_PROXY: deadProxy, no_proxy: undefined, NO_PROXY: undefined });
    check('ignora http_proxy/HTTP_PROXY do ambiente ao avisar o servidor local', r.status === 0 && refreshCalls === 1, { status: r.status, refreshCalls });
    await runHook('SessionEnd', {});

    // --- porta fechada: não atrapalha
    const closed = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const t0 = Date.now();
    r = await runHook('SessionStart', {}, { MATDECK_PORT: String(closed) });
    check('porta fechada: ainda sai com 0 e grava', r.status === 0 && r.rec && r.rec.state === 'idle', { status: r.status, rec: r.rec, err: r.stderr });
    check('porta fechada: não trava (menos de 3 s)', Date.now() - t0 < 3000, Date.now() - t0);
    check('porta fechada: saída limpa (sem traceback)', r.stderr === '' && r.stdout === '', { out: r.stdout, err: r.stderr });
    await runHook('SessionEnd', {}, { MATDECK_PORT: String(closed) });

    // --- porta pelo arquivo
    const portFile = path.join(tmp, 'port');
    fs.writeFileSync(portFile, String(port) + '\n');
    refreshCalls = 0;
    r = await runHook('SessionStart', {}, { MATDECK_PORT: undefined, MATDECK_PORT_FILE: portFile });
    check('sem MATDECK_PORT lê a porta do arquivo MATDECK_PORT_FILE', r.status === 0 && refreshCalls === 1, { status: r.status, refreshCalls });
    await runHook('SessionEnd', {}, { MATDECK_PORT: undefined, MATDECK_PORT_FILE: portFile });

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
