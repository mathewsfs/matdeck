// Coletor das sessões do Claude Code: agregação (porta do status.py do smart-clock), leitura pelo hostExec
// sobre uma pasta temporária real, teclas claude:*, foco por PID e instalação do hook.
// Uso: node claude-sessions.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
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
    const cs = new ClaudeSessions(config, { focus, now: () => clock, hookSource: HOOK_SRC, hookDir, port: 8899 });
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

    const st = cs.stateFor('claude:slot:1');
    check('stateFor(claude:slot:1) é a waiting com pulse', st && st.pulse === true && st.bgColor === '#B91C1C' && st.title === 'painel', st);
    const st2 = cs.stateFor('claude:slot:2');
    check('stateFor(claude:slot:2) é a working sem pulse', st2 && st2.pulse === false && st2.bgColor === undefined && st2.title === 'apk-matdeck', st2);
    check('stateFor desconhecida é null', cs.stateFor('claude:nada') === null && cs.stateFor('data:talk') === null);

    check('keyUp não foca', await cs.handleAction('claude:slot:1', 'keyUp') === false && focused.length === 0);
    check('handleAction slot 1 devolve true', await cs.handleAction('claude:slot:1', 'keyDown') === true);
    check('foco 1: só pids, sem classHints', focused.length === 2 && focused[0].pids.join() === '4242,1000' && focused[0].classHints === undefined, focused[0]);
    check('foco 2 (PID falhou): classHints maestri', focused[1].classHints.join() === 'maestri' && focused[1].pids === undefined, focused[1]);
    logged.length = 0;
    check('handleAction sem window não chama focus (e registra no log)', await cs.handleAction('claude:slot:2', 'keyDown') === false && focused.length === 2 && /sem janela/.test(logged[0] || ''), logged);
    check('handleAction vaga vazia / fora da faixa', await cs.handleAction('claude:slot:3', 'keyDown') === false && await cs.handleAction('claude:slot:9', 'keyDown') === false && focused.length === 2);
    check('summary foca a primeira waiting', await cs.handleAction('claude:summary', 'keyDown') === true && focused.length === 4 && focused[2].pids[0] === 4242);

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
    check('slots da config limitam as vagas (slots: 1 → slot 2 vazio)', cs.snapshot().slots === 1 && cs.stateFor('claude:slot:2').title === '' && await cs.handleAction('claude:slot:2', 'keyDown') === false);
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

    fs.rmSync(tmp, { recursive: true, force: true });
    out(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exit(fails ? 1 : 0);
})();
