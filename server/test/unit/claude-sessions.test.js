// Coletor das sessões do Claude Code: agregação (porta do status.py do smart-clock), leitura pelo hostExec
// sobre uma pasta temporária real, teclas claude:*, foco por PID e instalação do hook.
// Uso: node claude-sessions.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const ClaudeSessions = require('../../src/claudeSessions');
const ConfigStore = require('../../src/config');
const { aggregate, effectiveState, sessionLabel, activityText, parseScan, DEFAULT_TTL } = ClaudeSessions;

let fails = 0;
const out = console.log;
const logged = [];
console.log = (...x) => logged.push(x.join(' '));   // logs do coletor ficam fora da saída; os checks usam `out`
const check = (n, ok, extra) => { out((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

const T = 1_000_000;
const cfg = DEFAULT_TTL;
const rec = (o) => ({ session_id: 's', state: 'working', ts: T, ...o });

(async () => {
    // --- agregação (casos do test_status.py) ----------------------------------------------------
    check('sem sessões: idle', aggregate([], T, cfg).state === 'idle');
    const mixed = aggregate([rec({ state: 'working' }), rec({ session_id: 'b', state: 'waiting' })], T, cfg);
    check('waiting ganha de working', mixed.state === 'waiting' && mixed.working === 1 && mixed.waiting === 1, mixed);
    check('working ganha de done', aggregate([rec({ state: 'done' }), rec({ session_id: 'b', state: 'working' })], T, cfg).state === 'working');
    check('done expira para idle depois de doneMinutes', effectiveState(rec({ state: 'done', ts: T - 11 * 60 }), T, cfg) === 'idle'
        && aggregate([rec({ state: 'done', ts: T - 9 * 60 })], T, cfg).state === 'done'
        && aggregate([rec({ state: 'done', ts: T - 11 * 60 })], T, cfg).state === 'idle');
    check('working morto (15 min sem sinal) é ignorado', aggregate([rec({ ts: T - 16 * 60 })], T, cfg).working === 0);
    check('atividade no transcript mantém working vivo', effectiveState(rec({ ts: T - 16 * 60, activity: T - 10 }), T, cfg) === 'working');
    const doneKeep = aggregate([rec({ state: 'working' }), rec({ session_id: 'b', state: 'done', ts: T - 11 * 60 }), rec({ session_id: 'c', state: 'done', ts: T - 5 })], T, cfg);
    check('done continua contando enquanto outro trabalha', doneKeep.state === 'working' && doneKeep.counts.done === 2 && doneKeep.counts.working === 1, doneKeep.counts);
    const stale = aggregate([rec({}), rec({ session_id: 'b', state: 'done', ts: T - 7 * 3600 })], T, cfg);
    check('sessão sem sinal há mais de staleMinutes some', stale.total === 1 && stale.counts.done === 0
        && aggregate([rec({ ts: T - 7 * 3600 })], T, cfg).total === 0);
    const list = aggregate([
        rec({ session_id: '1', state: 'done', ts: T - 11 * 60, cwd: '/x/wa-ha-mat' }),
        rec({ session_id: '2', cwd: '/x/crivo/app/.maestri/roles/abc', tool: 'mcp__bitrix24__call' }),
        rec({ session_id: '3', state: 'waiting', cwd: '/x/painel' })
    ], T, cfg).sessions;
    check('lista ordenada por prioridade e nome; label = projeto acima de .maestri',
        list.map((s) => s.state).join() === 'waiting,working,done' && list[1].name === 'app' && list[1].tool === 'bitrix24' && list[2].tool === null
        && sessionLabel('/x/organizador/.maestri/roles/abc') === 'organizador' && sessionLabel('/x/apk-matdeck') === 'apk-matdeck'
        && sessionLabel('') === 'terminal' && sessionLabel('/.maestri/x') === 'maestri', list);
    const a = aggregate([rec({ tool: 'Bash' })], T, cfg);
    const b = aggregate([rec({ tool: 'Edit' })], T, cfg);
    check('tool_key separado de key', a.key === b.key && a.tool_key !== b.tool_key);
    check('key muda com a contagem', aggregate([rec({})], T, cfg).key !== aggregate([rec({}), rec({ session_id: 'b' })], T, cfg).key);
    check('activityText', activityText({ state: 'waiting', notification_type: 'permission_prompt' }) === 'Pediu permissão'
        && activityText({ state: 'waiting' }) === 'Esperando você'
        && activityText({ state: 'working', tool_full: 'Edit', detail: 'Hero.tsx' }) === 'Editando Hero.tsx'
        && activityText({ state: 'working', tool: 'Bash', detail: 'npm test' }) === 'Bash · npm test'
        && activityText({ state: 'working', tool_full: 'mcp__n8n__search' }) === 'n8n · search'
        && activityText({ state: 'working', tool_full: 'mcp__bitrix24__call' }) === 'bitrix24 · call'
        && activityText({ state: 'working' }) === 'Pensando'
        && activityText({ state: 'done' }) === 'Pronto' && activityText({ state: 'idle' }) === 'Livre');
    const since = aggregate([rec({ ts: T - 5, turn_started: T - 300, cwd: '/p' })], T, cfg).sessions[0];
    check('since usa turn_started em working', since.since === 300, since);
    check('since usa ts fora de working', aggregate([rec({ state: 'done', ts: T - 40, turn_started: T - 300 })], T, cfg).sessions[0].since === 40);

    // --- parseScan ----------------------------------------------------------------------------
    check('parseScan ignora arquivo inválido e lê os outros',
        parseScan('dir ok\n== a.json\n{bad\n== b.json\n{"session_id":"b","state":"idle","ts":1}\n').records.length === 1);
    check('parseScan: pasta inexistente', parseScan('dir missing\n').dirExists === false && parseScan('dir missing\n').records.length === 0);
    check('parseScan: pasta vazia', parseScan('dir ok\n').dirExists === true && parseScan('dir ok\n').records.length === 0);

    // --- coletor sobre pasta temporária real ----------------------------------------------------
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-claude-'));
    const dir = path.join(tmp, 'sessions');
    const hookDir = path.join(tmp, 'hook');
    const HOOK_SRC = path.join(tmp, 'fake-hook.py');
    fs.writeFileSync(HOOK_SRC, '#!/usr/bin/env python3\nprint("hook de teste")\n');
    const transcript = path.join(tmp, 'transcript.jsonl');
    const config = new ConfigStore(path.join(tmp, 'config.json'));
    config.set('claude', { sessionsDir: dir });

    const focused = [];
    const focus = async (target) => { focused.push(target); return !target.pids; };   // a chamada por PID "falha": cai para a classe
    let clock = T;
    let weekly = 10;
    const cs = new ClaudeSessions(config, { focus, now: () => clock, hookSource: HOOK_SRC, hookDir, port: 8899, weeklyPercent: () => weekly });
    const changes = [];
    cs.on('change', (s) => changes.push(s));

    await cs.refreshNow();
    check('pasta inexistente: dirExists false e sem erro', cs.snapshot().dirExists === false && cs.snapshot().total === 0 && cs.snapshot().state === 'idle');

    fs.mkdirSync(dir);
    const write = (name, o) => fs.writeFileSync(path.join(dir, name), JSON.stringify(o));
    write('w.json', { session_id: 'w', state: 'waiting', ts: T - 3, cwd: '/x/painel', notification_type: 'permission_prompt', window: { pids: [4242, 1000], term_program: 'Maestri', maestri_terminal_id: 'tid', maestri_workspace_id: 'wid' } });
    write('k.json', { session_id: 'k', state: 'working', ts: T - 60, cwd: '/x/apk-matdeck', tool: 'Edit', detail: 'a.js', turn_started: T - 120, transcript_path: transcript });
    fs.writeFileSync(path.join(dir, 'ruim.json'), '{quebrado');
    fs.writeFileSync(path.join(dir, 'ignorar.txt'), 'x');
    await cs.refreshNow();
    let snap = cs.snapshot();
    check('snapshot com 2 sessões, waiting primeiro', snap.dirExists === true && snap.total === 2 && snap.sessions[0].id === 'w' && snap.sessions[1].id === 'k' && snap.state === 'waiting', snap);
    check('snapshot: contagens, dir, vagas e lastRead', snap.counts.waiting === 1 && snap.counts.working === 1 && snap.dir === dir && snap.slots === 4 && snap.lastRead === T, snap.counts);
    check('snapshot: sessão traz window e activity', snap.sessions[0].window.pids[0] === 4242 && snap.sessions[0].activity === 'Pediu permissão' && snap.sessions[1].activity === 'Editando a.js');
    check('mudança do primeiro scan emitiu change', changes.length === 1, changes.length);

    const st = cs.stateFor('claude:summary');
    check('stateFor(claude:summary) lista a waiting primeiro, com pulse', st && st.pulse === true && st.bgColor === '#B91C1C' && st.statRows[0].k === 'painel' && st.statRows[1].k === 'apk-matdeck', st);
    check('stateFor desconhecida é null (inclusive as antigas claude:slot:N)', cs.stateFor('claude:nada') === null && cs.stateFor('data:talk') === null && cs.stateFor('claude:slot:1') === null);

    check('keyUp não foca', await cs.handleAction('claude:summary', 'keyUp') === false && focused.length === 0);
    check('handleAction summary devolve true (foca a waiting)', await cs.handleAction('claude:summary', 'keyDown') === true);
    check('foco 1: só pids, sem classHints', focused.length === 2 && focused[0].pids.join() === '4242,1000' && focused[0].classHints === undefined, focused[0]);
    check('foco 2 (PID falhou): classHints maestri', focused[1].classHints.join() === 'maestri' && focused[1].pids === undefined, focused[1]);
    logged.length = 0;
    check('handleAction de ação desconhecida não chama focus', await cs.handleAction('claude:slot:1', 'keyDown') === false && focused.length === 2);
    check('summary foca a primeira waiting de novo', await cs.handleAction('claude:summary', 'keyDown') === true && focused.length === 4 && focused[2].pids[0] === 4242);

    // summary sem waiting foca a primeira working
    write('w.json', { session_id: 'w', state: 'done', ts: T - 3, cwd: '/x/painel', window: { pids: [4242], term_program: 'Maestri' } });
    write('k.json', { session_id: 'k', state: 'working', ts: T - 60, cwd: '/x/apk-matdeck', tool: 'Edit', detail: 'a.js', turn_started: T - 120, window: { pids: [777], term_program: 'vscode' } });
    await cs.refreshNow();
    check('evento change ao mudar o estado de um arquivo', changes.length === 2 && cs.snapshot().state === 'working', changes.length);
    focused.length = 0;
    await cs.handleAction('claude:summary', 'keyDown');
    check('summary sem waiting foca a primeira working (vscode → code)', focused[0].pids[0] === 777 && focused[1].classHints[0] === 'code', focused);

    // mesmo arquivo reescrito sem mudança: sem change
    await cs.refreshNow();
    check('varredura sem mudança não emite change', changes.length === 2, changes.length);
    // só o minuto do since muda
    clock = T + 61;
    await cs.refreshNow();
    check('mudança do minuto do since emite change', changes.length === 3, changes.length);
    // tick recalcula sem ler o disco
    clock = T + 125;
    cs.tick();
    check('tick recalcula since e emite change ao virar o minuto', changes.length === 4 && cs.snapshot().sessions[0].since >= 180, changes.length);
    cs.tick();
    check('tick sem virar o minuto não emite', changes.length === 4);
    clock = T;

    // título da tecla longo não quebra linha nem espreme o valor grande
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'style.css'), 'utf8');
    const rule = (selector) => { const m = css.match(new RegExp('(?:^|\\n)' + selector.replace(/[.]/g, '\\.') + '\\s*\\{([^}]*)\\}')); return m ? m[1] : ''; };
    const labelRule = rule('.key-stat-label');
    check('CSS: .key-stat-label trunca com reticências (nowrap, overflow, text-overflow, min-width:0)', /text-overflow:\s*ellipsis/.test(labelRule) && /white-space:\s*nowrap/.test(labelRule) && /overflow:\s*hidden/.test(labelRule) && /min-width:\s*0/.test(labelRule), labelRule);
    check('CSS: .key-stat-headval não encolhe', /flex-shrink:\s*0/.test(rule('.key-stat-headval')), rule('.key-stat-headval'));

    // "há quanto tempo" como no relógio: '<1m' no primeiro minuto (sem change a cada segundo), depois muda por minuto
    const dir2 = path.join(tmp, 'sessions-since');
    fs.mkdirSync(dir2);
    const config2 = new ConfigStore(path.join(tmp, 'config-since.json'));
    config2.set('claude', { sessionsDir: dir2 });
    let clock2 = T;
    const cs2 = new ClaudeSessions(config2, { focus, now: () => clock2, hookSource: HOOK_SRC, hookDir: path.join(tmp, 'hook2'), port: 8899 });
    const changes2 = [];
    cs2.on('change', () => changes2.push(clock2));
    fs.writeFileSync(path.join(dir2, 's.json'), JSON.stringify({ session_id: 's', state: 'working', ts: T, turn_started: T, cwd: '/x/since', tool: 'Edit', detail: 'a.js' }));
    await cs2.refreshNow();
    changes2.length = 0;
    const emittedAt = (seconds) => { const before = changes2.length; clock2 = T + seconds; cs2.tick(); return changes2.length > before; };
    check('since < 60 s: sem change a cada segundo (mostra <1m)', [1, 2, 30, 59].every((sec) => !emittedAt(sec)) && cs2.stateFor('claude:summary').statRows[0].v === '<1m', changes2);
    check('since aos 60 s: change (vira 1m)', emittedAt(60) && cs2.stateFor('claude:summary').statRows[0].v === '1m');
    check('since entre 61 s e 119 s: sem change', [61, 62, 90, 119].every((sec) => !emittedAt(sec)), changes2);
    check('since aos 120 s: change (vira 2m)', emittedAt(120));
    cs2.stop();

    // transcript: nome da sessão (custom-title/ai-title) e interrupção (Esc / permissão negada), lidos de forma incremental
    const tlog = path.join(tmp, 'titled.jsonl');
    const iso = (sec) => new Date(sec * 1000).toISOString();
    fs.writeFileSync(tlog, [
        JSON.stringify({ type: 'ai-title', aiTitle: 'Título automático', sessionId: 't' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'oi' }, timestamp: iso(T - 100) })
    ].join('\n') + '\n');
    write('t.json', { session_id: 't', state: 'waiting', ts: T - 10, cwd: '/x/projeto-t', notification_type: 'permission_prompt', transcript_path: tlog });
    clock = T;
    await cs.refreshNow();
    let tsess = cs.snapshot().sessions.find((x) => x.id === 't');
    check('nome da sessão vem do ai-title do transcript', tsess && tsess.name === 'Título automático' && tsess.state === 'waiting', tsess);
    fs.appendFileSync(tlog, JSON.stringify({ type: 'custom-title', customTitle: 'MATdeck', sessionId: 't' }) + '\n');
    await cs.refreshNow();
    tsess = cs.snapshot().sessions.find((x) => x.id === 't');
    check('custom-title (/rename) vence o ai-title e é lido no trecho novo', tsess && tsess.name === 'MATdeck', tsess && tsess.name);
    fs.appendFileSync(tlog, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, timestamp: iso(T - 5) }) + '\n');
    await cs.refreshNow();
    tsess = cs.snapshot().sessions.find((x) => x.id === 't');
    check('interrupção depois do último evento do hook: deixa de ser waiting (vira livre)', tsess && tsess.state === 'idle' && tsess.activity === 'Livre', tsess);
    write('t.json', { session_id: 't', state: 'working', ts: T + 1, cwd: '/x/projeto-t', transcript_path: tlog });
    await cs.refreshNow();
    tsess = cs.snapshot().sessions.find((x) => x.id === 't');
    check('evento novo do hook depois da interrupção volta a valer', tsess && tsess.state === 'working' && tsess.name === 'MATdeck', tsess);
    check('interrupção numa sidechain é ignorada', (() => { fs.appendFileSync(tlog, JSON.stringify({ type: 'user', isSidechain: true, message: { content: '[Request interrupted by user' }, timestamp: iso(T + 5) }) + '\n'); return true; })());
    await cs.refreshNow();
    check('(sidechain) sessão continua working', cs.snapshot().sessions.find((x) => x.id === 't').state === 'working');
    fs.unlinkSync(path.join(dir, 't.json'));

    // mascote: GIFs por estado numa pasta do host (fora do repositório); escolhido pelo estado geral, 'limit' pelo consumo semanal
    const mascotDir = path.join(tmp, 'clawd');
    fs.mkdirSync(mascotDir);
    const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary');
    for (const st of ['working', 'waiting', 'idle', 'limit']) fs.writeFileSync(path.join(mascotDir, `${st}.gif`), Buffer.concat([GIF, Buffer.from(st)]));
    check('sem pasta configurada: sem mascote', cs.stateFor('claude:summary').statMascot === null && cs.snapshot().mascots.length === 0);
    config.set('claude', { mascotDir });
    cs.reconnect();
    await cs.scanMascots();
    check('scanMascots lista os GIFs da pasta (sem done.gif)', cs.snapshot().mascots.sort().join() === 'idle,limit,waiting,working', cs.snapshot().mascots);
    await cs.refreshNow();
    check('mascotUrl segue o estado geral, com versão pelo mtime', new RegExp(`^/api/claude/mascot/${cs.snapshot().state}\\.gif\\?v=\\d+$`).test(cs.mascotUrl(cs.snapshot().state)), [cs.snapshot().state, cs.mascotUrl(cs.snapshot().state)]);
    check('estado sem GIF (done) cai em idle.gif', cs.mascotUrl('done') === cs.mascotUrl('idle') && /idle\.gif/.test(cs.mascotUrl('done')));
    weekly = 95;
    check('semana ≥ 90% e sessão livre/pronta → limit.gif; trabalhando/esperando não', /limit\.gif/.test(cs.mascotUrl('idle')) && /limit\.gif/.test(cs.mascotUrl('done')) && /working\.gif/.test(cs.mascotUrl('working')));
    weekly = 10;
    const bytes = await cs.readMascot('working');
    check('readMascot devolve os bytes do GIF pelo host', Buffer.isBuffer(bytes) && bytes.toString('binary').endsWith('working') && bytes.slice(0, 6).toString() === 'GIF89a');
    check('readMascot de estado inexistente é null', await cs.readMascot('nada') === null && await cs.readMascot('../x') === null);
    check('mascote entra na chave de change (recompute guarda a URL atual)', (() => { cs.recompute(); return cs.lastKeys[3] === cs.mascotUrl(cs.snapshot().state) && typeof cs.lastKeys[3] === 'string'; })(), cs.lastKeys[3]);
    // modo do mascote: 'rows' (padrão) = um por linha e o do canto só com a lista vazia; 'corner' = só no canto; 'both'
    const rowsOf = () => cs.stateFor('claude:summary').statRows;
    check('padrão (rows): cada linha traz img com o GIF do estado da sessão e o canto fica vazio', rowsOf().every((r) => /\/api\/claude\/mascot\/(working|waiting|done|idle|limit)\.gif\?v=\d+$/.test(r.img)) && cs.stateFor('claude:summary').statMascot === null, rowsOf());
    const stateOfColor = { '#F87171': 'waiting', '#3B82F6': 'working', '#16A34A': 'done', '#6B7280': 'idle' };
    const expectedGif = (st) => (cs.snapshot().mascots.includes(st) ? st : 'idle') + '.gif';   // sem o GIF do estado cai em idle
    check('rows: cada linha usa o GIF do próprio estado (ou idle quando não há)', rowsOf().length > 1 && rowsOf().every((r) => r.img.includes('/' + expectedGif(stateOfColor[r.color]))), rowsOf().map((r) => [r.color, r.img]));
    check('rows com lista vazia: canto mostra o mascote (idle) e a linha "nenhum terminal" não tem img', (() => { const k = ClaudeSessions.keyStateFor('claude:summary', ClaudeSessions.aggregate([], T, cfg), 4, cs.mascotUrl('idle'), (st) => cs.mascotUrl(st), 'rows'); return /idle\.gif/.test(k.statMascot) && !k.statRows[0].img; })());
    config.set('claude', { mascotMode: 'corner' });
    cs.reconnect();
    check('corner: só o canto, linhas sem img', cs.stateFor('claude:summary').statMascot !== null && rowsOf().every((r) => !r.img), rowsOf());
    config.set('claude', { mascotMode: 'both' });
    cs.reconnect();
    check('both: canto e linhas', cs.stateFor('claude:summary').statMascot !== null && rowsOf().every((r) => !!r.img));
    check('snapshot traz mascotMode', cs.snapshot().mascotMode === 'both');
    config.set('claude', { mascotDir: '', mascotMode: 'rows' });
    cs.reconnect();

    // mtime do transcript vira activity (e mantém working vivo)
    write('k.json', { session_id: 'k', state: 'working', ts: T - 3600, cwd: '/x/apk-matdeck', transcript_path: transcript });
    write('w.json', { session_id: 'w', state: 'done', ts: T - 3, cwd: '/x/painel' });
    fs.writeFileSync(transcript, 'x');
    const nowSec = Math.floor(Date.now() / 1000);
    fs.utimesSync(transcript, nowSec - 5, nowSec - 5);
    clock = nowSec;
    await cs.refreshNow();
    snap = cs.snapshot();
    check('mtime do transcript mantém working vivo (activity)', snap.counts.working === 1 && snap.sessions.find((s) => s.id === 'k').state === 'working', snap.counts);
    fs.unlinkSync(transcript);
    await cs.refreshNow();
    check('transcript sumiu: working antigo morre', cs.snapshot().counts.working === 0);
    clock = T;
    write('w.json', { session_id: 'w', state: 'waiting', ts: T - 3, cwd: '/x/painel', window: { pids: [4242], term_program: 'Maestri' } });
    write('k.json', { session_id: 'k', state: 'working', ts: T - 60, cwd: '/x/apk-matdeck' });
    await cs.refreshNow();

    // varreduras não se sobrepõem; refreshNow durante uma varredura enfileira mais uma
    let runs = 0;
    const slow = new ClaudeSessions(config, {
        now: () => T,
        execFile: (file, args, o, cb) => { runs++; setTimeout(() => cb(null, 'dir missing\n'), 40); return { stdin: { end() {} } }; }
    });
    const p1 = slow.refreshNow(); const p2 = slow.refreshNow(); const p3 = slow.refreshNow();
    await Promise.all([p1, p2, p3]);
    check('varreduras concorrentes viram no máximo uma a mais', runs === 2, runs);

    // vagas e config
    config.set('claude', { slots: 1 });
    cs.reconnect();
    await cs.refreshNow();
    check('slots da config limitam as linhas do resumo (slots: 1 → 1 linha e +N no cabeçalho)', cs.snapshot().slots === 1 && cs.stateFor('claude:summary').statRows.length === 1 && /\+\d+$/.test(cs.stateFor('claude:summary').statHead), cs.stateFor('claude:summary').statHead);
    config.set('claude', { slots: 99 });
    check('slots limitado a 12', cs.settings().slots === 12);
    config.set('claude', { slots: 0 });
    check('slots mínimo 1', cs.settings().slots === 1);
    config.set('claude', { slots: 4, workingMinutes: 1 });
    check('minutos da config viram segundos', cs.settings().ttl.workingTtl === 60 && cs.settings().ttl.staleTtl === 360 * 60);
    config.set('claude', { workingMinutes: 15 });
    process.env.MATDECK_CLAUDE_STATE_DIR = path.join(tmp, 'outra');
    check('MATDECK_CLAUDE_STATE_DIR tem precedência', cs.settings().dir === path.join(tmp, 'outra'));
    delete process.env.MATDECK_CLAUDE_STATE_DIR;
    config.set('claude', { sessionsDir: '~/pasta-x' });
    check('~ é expandido', cs.settings().dir === path.join(os.homedir(), 'pasta-x'));
    config.set('claude', { sessionsDir: dir });
    check('padrão da config', new ConfigStore(path.join(tmp, 'c2.json')).get('claude').staleMinutes === 360 && ClaudeSessions.DEFAULT_DIR === '~/.local/state/matdeck/claude-sessions');

    // cadência
    check('setActive(true) usa scanActiveMs', (cs.setActive(true), cs.scanMs() === 2000));
    check('setActive(false) alonga a cadência (scanIdleMs)', (cs.setActive(false), cs.scanMs() === 15000));

    // instalação do hook em hookDir temporário
    const { hookPath, port } = await cs.installHook();
    check('installHook copia o script e grava a porta', hookPath === path.join(hookDir, 'claude-code-hook.py') && fs.readFileSync(hookPath, 'utf8') === fs.readFileSync(HOOK_SRC, 'utf8')
        && fs.readFileSync(path.join(hookDir, 'port'), 'utf8').trim() === String(port) && port === 8899);
    const m1 = fs.statSync(hookPath).mtimeMs;
    const p1m = fs.statSync(path.join(hookDir, 'port')).mtimeMs;
    await new Promise((r) => setTimeout(r, 25));
    await cs.installHook();
    check('installHook não regrava quando o conteúdo é igual', fs.statSync(hookPath).mtimeMs === m1 && fs.statSync(path.join(hookDir, 'port')).mtimeMs === p1m);
    fs.writeFileSync(HOOK_SRC, '#!/usr/bin/env python3\nprint("hook v2")\n');
    await cs.installHook();
    check('installHook atualiza quando o script do repo muda', fs.readFileSync(hookPath, 'utf8').includes('v2'));
    check('snapshot traz hookPath e port', cs.snapshot().hookPath === hookPath && cs.snapshot().port === port);

    // start/stop sem vazar timers: o processo precisa terminar sozinho
    let scans = 0;
    const realExec = require('../../src/hostExec').execFile;
    const countingExec = (file, args, o, cb) => { if (String(args[1] || '').includes('dir ok')) scans++; return realExec(file, args, o, cb); };
    const life = new ClaudeSessions(config, { now: () => T, execFile: countingExec, hookSource: path.join(tmp, 'nao-existe.py'), hookDir, scanActiveMs: 20, scanIdleMs: 20, tickMs: 10 });
    const origWarn = console.warn; const warns = [];
    console.warn = (...x) => warns.push(x.join(' '));
    life.start();
    life.start();
    await new Promise((r) => setTimeout(r, 150));
    life.stop();
    console.warn = origWarn;
    check('start instala o hook sem lançar: erro de origem registrado uma vez', warns.length === 1, warns);
    check('start varre em ciclo e stop encerra', life.scanTimer === null && life.tickTimer === null && scans >= 2, scans);

    // --- aparência das teclas (keyStateFor) e reconhecimento no deck ---------------------------------
    const { keyStateFor, sinceText } = ClaudeSessions;
    const visual = (o) => aggregate([
        rec({ session_id: 'a', state: 'waiting', cwd: '/x/painel', ts: T - 125 }),
        rec({ session_id: 'b', state: 'working', cwd: '/x/apk-matdeck', tool: 'Edit', ts: T - 12 }),
        rec({ session_id: 'c', state: 'working', cwd: '/x/outro', ts: T - 60 }),
        ...(o || [])
    ], T, cfg);
    const vs = visual();
    const longAct = aggregate([rec({ cwd: '/x/longo', tool: 'Bash', detail: 'x'.repeat(200) })], T, cfg);
    check('o fundo de waiting não é o #DC2626 (mutado no deck)', String(keyStateFor('claude:summary', vs, 4).bgColor).toUpperCase() !== '#DC2626');
    check('ação desconhecida é null (inclusive claude:slot:N, removida)', keyStateFor('data:talk', vs, 4) === null && keyStateFor('claude:nada', vs, 4) === null && keyStateFor('claude:slot:1', vs, 4) === null);
    // resumo = lista dos terminais (uma linha por sessão, na ordem de prioridade), limitada às vagas
    const sm = keyStateFor('claude:summary', vs, 2);
    check('resumo lista os terminais por prioridade (waiting primeiro) e corta nas vagas (slots 2, 3 sessões)', sm.statRows.length === 2
        && sm.statRows[0].color === '#F87171' && sm.statRows[1].color === '#3B82F6', sm.statRows);
    check('linha como no relógio: k = nome, v = tempo, sub = atividade, cor = estado', sm.statRows[0].k === vs.sessions[0].name && sm.statRows[0].v === sinceText(vs.sessions[0].since)
        && sm.statRows[0].sub === vs.sessions[0].activity && sm.statRows[1].sub === vs.sessions[1].activity, sm.statRows[0]);
    check('cabeçalho = contagens por estado e +N quando não cabe', sm.statHead === '1 precisa · 2 trab. · +1', sm.statHead);
    check('resumo com waiting pulsa e vem vermelho', sm.statMode === 'meters' && sm.pulse === true && sm.bgColor === '#B91C1C'
        && sm.borderColor === '#F87171' && sm.active === true && sm.badge === null && sm.statColor === '#F87171', sm);
    const sm4 = keyStateFor('claude:summary', vs, 4);
    check('resumo com vagas sobrando lista todas sem +N', sm4.statRows.length === 3 && sm4.statHead === '1 precisa · 2 trab.', sm4.statHead);
    check('barra da linha: cheia para waiting e working', sm4.statRows[0].pct === 100 && sm4.statRows[1].pct === 100, sm4.statRows.map((r) => r.pct));
    const sw = keyStateFor('claude:summary', aggregate([rec({})], T, cfg), 4);
    check('resumo só trabalhando: "1 trab.", sem pulse, ativo', sw.statHead === '1 trab.' && sw.pulse === false && sw.bgColor === undefined && sw.active === true && sw.statColor === '#3B82F6', sw);
    const si = keyStateFor('claude:summary', aggregate([], T, cfg), 4);
    check('resumo vazio: "livre", uma linha cinza "nenhum terminal", inativo', si.statHead === 'livre' && si.statColor === '#6B7280' && si.active === false
        && si.statRows.length === 1 && si.statRows[0].k === 'nenhum terminal' && si.statRows[0].pct === 0 && si.statRows[0].color === '#6B7280', si);
    const sd = keyStateFor('claude:summary', aggregate([rec({ state: 'done', ts: T - 5 })], T, cfg), 4);
    check('resumo pronto: "1 pronto", linha verde com barra parcial e atividade "Pronto"', sd.statHead === '1 pronto' && sd.statRows[0].sub === 'Pronto' && sd.statRows[0].color === '#16A34A' && sd.statRows[0].pct === 60, sd.statRows);
    const sub = keyStateFor('claude:summary', longAct, 4).statRows[0].sub;
    check('sub da linha cortado em 72 (tecla larga mostra mais; o CSS corta o resto)', sub.length <= 72 && sub.length > 40 && sub.endsWith('…'), sub);
    check('sinceText (como o relógio)', sinceText(12) === '<1m' && sinceText(125) === '2m' && sinceText(3900) === '1h05' && sinceText(0) === '<1m' && sinceText(59.9) === '<1m' && sinceText(7200) === '2h00', [sinceText(12), sinceText(125), sinceText(3900)]);
    // deck: o isStatKey de verdade, extraído do app.js
    const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
    const grab = (name) => { const i = appSrc.indexOf(`function ${name}(`); if (i < 0) throw new Error(`function ${name} não encontrada no app.js`); let depth = 0, j = appSrc.indexOf('{', i); for (let k = j; k < appSrc.length; k++) { if (appSrc[k] === '{') depth++; else if (appSrc[k] === '}') { depth--; if (!depth) return appSrc.slice(i, k + 1); } } };
    const isStatKey = vm.runInNewContext(grab('isStatKey') + '; isStatKey', {});
    check('deck trata claude:summary como tecla de telemetria', isStatKey({ actionId: 'claude:summary' }) === true);
    check('deck desenha o mascote (statMascot) numa <img class="key-stat-mascot">', /statMascot/.test(appSrc) && /key-stat-mascot/.test(appSrc) && /key-stat-mascot/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.legacy.js'), 'utf8')));
    check('CSS do mascote: canto da tecla, pixel art nítida, linhas abrem espaço', /\.key-stat-mascot\s*\{[^}]*image-rendering:\s*pixelated/.test(css) && /has-mascot[^{]*\.key-stat-meters\s*\{[^}]*padding-right/.test(css));
    check('CSS: nome da linha corta com reticências e o tempo não encolhe (iPad: "24m" por cima do nome)', /\.key-stat-meter-k\s*\{[^}]*text-overflow:\s*ellipsis/.test(css) && /\.key-stat-meter-v\s*\{[^}]*flex:\s*0 0 auto/.test(css) && /\.key-stat-meter-img\s*\{[^}]*height:\s*9vmin/.test(css));
    check('deck desenha o mascote de cada linha (r.img → img.key-stat-meter-img) e o CSS existe', /-meter-img/.test(appSrc) && /r\.img/.test(appSrc) && /\.key-stat-meter-img\s*\{[^}]*image-rendering:\s*pixelated/.test(css) && /-meter-img/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.legacy.js'), 'utf8')));
    check('deck não passa a tratar qualquer ação como telemetria', isStatKey({ actionId: 'data:talk' }) === false && isStatKey({ actionId: 'stats:cpu' }) === true);
    check('app.legacy.js também reconhece claude:', /startsWith\(["']claude:["']\)/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'app.legacy.js'), 'utf8')));

    fs.rmSync(tmp, { recursive: true, force: true });
    out(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exit(fails ? 1 : 0);
})();
