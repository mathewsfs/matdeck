# Grupo "Claude Code" no deck — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teclas "Claude: terminal N" e "Claude: resumo" que mostram, em tempo real, o estado de cada terminal do Claude Code (nome do projeto, atividade, tempo, selo) e, ao toque, focam a janela daquele terminal.

**Architecture:** Um hook Python (`scripts/claude-code-hook.py`) grava um JSON por sessão em `~/.local/state/matdeck/claude-sessions/` e avisa o servidor por `POST /api/claude/refresh`. O coletor `server/src/claudeSessions.js` (padrão de `dataAssistant.js`) lê a pasta pelo `hostExec`, agrega como o `status.py` do relógio, e empurra o estado das teclas `claude:*` pelo WebSocket. O foco usa `platform.windows.focus({ pids, classHints })`, com busca por PID nova no script KWin e no `xdotool`.

**Tech Stack:** Node.js CommonJS (sem dependência nova), Python 3 padrão (`python3 -I`), script KWin (Plasma 6, `window.pid`), testes com o runner caseiro (`cd server && npm test`, um processo por arquivo, `check(nome, ok)`).

**Spec:** `docs/superpowers/specs/2026-11-04-claude-code-sessions-design.md`

## Global Constraints

- Servidor Node.js CommonJS; deck ES5 após `cd scripts/legacy-build && npm run build` (regenerar `app.legacy.js` sempre que `app.js` mudar).
- No Flatpak o servidor não vê o home: leitura dos arquivos de sessão **só** por `hostExec` (`execFile('sh', ['-c', ...])` como em `aiUsage.js:85`), nunca por `fs` direto.
- Hook em Python 3 padrão, sem pacotes, executado com `python3 -I`; sai sempre com código 0.
- Sem dependência npm nova. Testes sem navegador.
- Cores: vermelho de fundo `#B91C1C` e borda `#F87171` (nunca `#DC2626`, que o deck trata como "mutado"), azul `#3B82F6`, verde `#16A34A`, cinza `#6B7280`.
- Prazos padrão (minutos): working 15, done 10, waiting 120, stale 360. Vagas: padrão 4, de 1 a 12.
- Conventional Commits em português, com as linhas de atribuição da sessão. Branch `feat/claude-code-sessions` (já criada a partir de `feat/acao-data`).
- Nomes das funções de agregação iguais aos do `status.py`: `effectiveState`, `sessionLabel`, `activityText`, `aggregate`.

## Review Focus

1. Arquivo de sessão sem o campo `window` (gravado pelo hook antigo do relógio ou por sessão anterior à instalação): a tecla mostra o estado normalmente e o toque só registra no log, sem lançar exceção. (Task 3: `handleAction sem window não chama focus`.)
2. Arquivo JSON truncado no meio da gravação (lido entre o `.tmp` e o `os.replace`): a varredura ignora esse arquivo e mantém os outros. (Task 3: `arquivo inválido é ignorado`.)
3. Pasta de sessões inexistente (hook ainda não instalado): coletor não loga a cada varredura, `snapshot().dirExists === false`, todas as vagas vazias. (Task 3: `pasta inexistente`.)
4. Nome de projeto longo (`cwd` tipo `bitrix24-app-sync-ac`) e atividade longa: `title` e `statSub` são cortados pelo CSS do deck (`text-overflow`), não pelo coletor; o coletor limita `statSub` a 40 caracteres com reticências para o iPad 2. (Task 4: `statSub cortado em 40`.)
5. Mais sessões do que vagas: as excedentes somem das teclas mas continuam contando no resumo. (Task 4: `resumo conta além das vagas`.)

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `scripts/claude-code-hook.py` (novo) | Hook do Claude Code: grava um JSON por sessão + cadeia de PIDs + aviso HTTP. |
| `server/src/claudeSessions.js` (novo) | Coletor: leitura pelo host, agregação (porta do `status.py`), vagas, estado das teclas, foco. |
| `server/src/config.js` | Seção `claude` nos `DEFAULTS`. |
| `server/src/actionCatalog.js` | Grupo `claude` gerado por `ctx.claudeSlots`. |
| `server/src/actions/systemActions.js` | `focusWindow` aceita `pids`; script KWin e `xdotool` buscam por PID. |
| `server/src/index.js` | Instancia o coletor, rotas, dispatch `claude:`, telemetria das teclas, `TITLE_IS_CONTENT`, `updateDemand`, `stop`, `claudeSlots` no catálogo. |
| `server/web/app.js` + `app.legacy.js` | `isStatKey` reconhece `claude:`. |
| `server/web/manage.html`, `manage.js` | Seção "Claude Code" em Ajustes (campos, trecho do hook, estado). |
| `README.md`, `CHANGELOG.md` | Documentação. |
| `server/test/unit/claude-hook.test.js`, `claude-sessions.test.js`, `focus-pid.test.js`, `claude-catalog.test.js` (novos); `deck-viewport.test.js` não muda. | Testes. |

---

### Task 1: Hook `scripts/claude-code-hook.py`

**Files:**
- Create: `scripts/claude-code-hook.py`
- Test: `server/test/unit/claude-hook.test.js`

**Interfaces:**
- Produces: arquivo `<dir>/<session_id>.json` com os campos `session_id, state, event, ts, cwd, transcript_path, tool, detail, prompt, turn_started, notification_type, window` onde `window = { pids: number[], term_program: string|null, maestri_terminal_id: string|null, maestri_workspace_id: string|null }` (igual ao exemplo da spec §1). `dir` = `MATDECK_CLAUDE_STATE_DIR` ou `~/.local/state/matdeck/claude-sessions`. Depois de gravar: `POST http://127.0.0.1:<porta>/api/claude/refresh` com timeout 0,3 s, erros ignorados; `<porta>` = `MATDECK_PORT` se definida, senão o conteúdo de `~/.local/state/matdeck/port` (`MATDECK_PORT_FILE` nos testes), senão 8888.
- Uso: `python3 -I scripts/claude-code-hook.py <Evento>` com o JSON do hook em stdin; sem argumento usa `hook_event_name` do payload.

- [ ] **Step 1: Escrever o teste que falha**

`server/test/unit/claude-hook.test.js`, no estilo de `data-assistant.test.js` (`check`, `fails`, `process.exitCode`). Helper `runHook(event, payload, env)` = `spawnSync('python3', ['-I', HOOK, event], { input: JSON.stringify(payload), env: { ...process.env, MATDECK_CLAUDE_STATE_DIR: dir, MATDECK_PORT: String(port), ...env } })`, com `dir` = `fs.mkdtempSync` e `port` = porta de um `http.createServer` do teste que registra `POST /api/claude/refresh`. Checks:

```js
check('SessionStart grava idle com window.pids contendo o pai do hook', rec.state === 'idle' && rec.window.pids.includes(process.pid));
check('window.term_program vem do ambiente', runHook('SessionStart', p, { TERM_PROGRAM: 'Maestri', MAESTRI_TERMINAL_ID: 't-1' }).window.term_program === 'Maestri' && rec.window.maestri_terminal_id === 't-1');
check('UserPromptSubmit: working, prompt em uma linha de até 80 chars, turn_started numérico', ...);
check('PreToolUse Bash: tool e detail = description', rec.tool === 'Bash' && rec.detail === 'Roda os testes');
check('PreToolUse Edit: detail = basename do file_path', rec.detail === 'Hero.tsx');
check('PreToolUse mantém window do registro anterior', rec.window.pids.length > 0);
check('Notification permission_prompt: waiting', rec.state === 'waiting' && rec.notification_type === 'permission_prompt');
check('Notification idle_prompt: done', rec.state === 'done');
check('Stop: done sem tool', rec.state === 'done' && rec.tool === null);
check('SessionEnd apaga o arquivo', !fs.existsSync(file));
check('session_id inválido não grava', fs.readdirSync(dir).length === 0);
check('stdin inválido sai com 0 e não grava', r.status === 0);
check('avisa o MatDeck por POST /api/claude/refresh', refreshCalls === N);
check('porta fechada: ainda sai com 0 e grava', ...);
check('sem MATDECK_PORT lê a porta do arquivo MATDECK_PORT_FILE', refreshCallsAfterFileOnly === 1);
check('sem argumento usa hook_event_name do payload', ...);
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/claude-hook.test.js`
Expected: FAIL (python3 não acha o script: `No such file`), código de saída 1.

- [ ] **Step 3: Escrever `scripts/claude-code-hook.py`**

Porta de `smart-clock/hook_state.py` (mesmas `EVENT_STATE`, `CARRY_FIELDS`, `tool_detail`, `one_line`, `valid_session_id`, gravação `.tmp` + `os.replace`), com:
- `window_info()`: `pids` = cadeia a partir de `os.getppid()` subindo por `/proc/<pid>/stat` (campo 4; no macOS `ps -o ppid= -p`) até PID 1 ou 8 níveis; mais `TERM_PROGRAM`, `MAESTRI_TERMINAL_ID`, `MAESTRI_WORKSPACE_ID`. Calculada só em `SessionStart` e `UserPromptSubmit`; nos outros eventos carrega `window` do registro anterior.
- `server_port()`: `MATDECK_PORT`, senão o inteiro em `MATDECK_PORT_FILE` ou `~/.local/state/matdeck/port`, senão 8888.
- `notify_matdeck()`: `urllib.request.urlopen(Request(url, method='POST', data=b''), timeout=0.3)` dentro de `try/except Exception: pass`.
- `main` sempre retorna 0.

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && node test/unit/claude-hook.test.js`
Expected: todos os checks `OK`, "Todos os checks passaram".

- [ ] **Step 5: Commit**

```bash
git add scripts/claude-code-hook.py server/test/unit/claude-hook.test.js
git commit -m "feat(claude): hook do Claude Code grava uma sessão por arquivo com a cadeia de processos e avisa o servidor"
```

---

### Task 2: Foco por PID em `systemActions.js`

**Files:**
- Modify: `server/src/actions/systemActions.js:365-400` (`focusWindow`), `:415-460` (`buildKwinFocusScript`), `focusWithXdotool`, `focusWithKwinScript`
- Modify: `server/src/platform/linux/windows.js:9` (passa `target` inteiro; nada a mudar se já repassa)
- Test: `server/test/unit/focus-pid.test.js`

**Interfaces:**
- Produces: `SystemActions.focusWindow({ pids?: number[], classHints?, titleHints?, requireTitle? })` → `Promise<boolean>`. `buildKwinFocusScript(classHints, titleHints, scriptPath, markerName, requireTitle, pids = [])` → string. `focusWithKwinScript(classHints, titleHints, requireTitle, pids = [])`, `focusWithXdotool(classHints, titleHints, requireTitle, pids = [])`.
- Semântica: com `pids`, o script KWin ativa a primeira janela (ordem de `pids`, depois ordem da lista) cujo `w.pid` esteja em `pids`; só se nenhuma casar cai nos níveis por título/classe já existentes. `xdotool`: `search --pid <pid>` para cada pid, antes das buscas por nome/classe. `focusWindow` com `pids` e sem hints não devolve `false` cedo.

- [ ] **Step 1: Escrever o teste que falha**

`server/test/unit/focus-pid.test.js`:

```js
const SystemActions = require('../../src/actions/systemActions');
const script = SystemActions.buildKwinFocusScript([], [], '/tmp/x.js', 'm', false, [4242, 17]);
check('script KWin compara window.pid com a lista', /pids\s*=\s*\[4242,17\]/.test(script.replace(/\s/g, '').replace('var pids=', 'pids=')) && /w\.pid/.test(script));
check('pids vêm antes dos níveis por título/classe', script.indexOf('w.pid') < script.indexOf('matchTitle(w) &&'));
check('script sem pids ainda tem os níveis por classe', /matchClass\(w\)/.test(SystemActions.buildKwinFocusScript(['konsole'], [], '/tmp/x.js', 'm', false)));
// focusWindow só com pids não sai cedo: espiona focusWithKwinScript/focusWithXdotool/focusWithKdotool
const calls = []; SystemActions.focusWithKdotool = async () => { calls.push('kdotool'); return false; };
SystemActions.focusWithKwinScript = async (c, t, r, pids) => { calls.push(['kwin', pids]); return true; };
check('focusWindow({pids}) chama o KWin com os pids', await SystemActions.focusWindow({ pids: [4242] }) === true && JSON.stringify(calls).includes('[4242]'));
// xdotool: run falso
```

Para o `xdotool`, injetar um `run` falso: expor `SystemActions._run` (atribuível em teste) e fazer `focusWithXdotool` usar `this._run || run`? Não: mais simples, o teste cria `PATH` com um `xdotool` falso em shell que grava os argumentos num arquivo e devolve `123` para `search --pid 4242`. Check: `xdotool search --pid 4242` aparece no log e `windowactivate --sync 123` em seguida. Forçar `SystemActions.xdotoolUsable = () => true`, `hasKdotool = () => false`, `capabilities = () => ({ qdbus: null, desktop: '' })`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/focus-pid.test.js`
Expected: FAIL nos checks de `w.pid` e do `--pid`.

- [ ] **Step 3: Implementar**

- `buildKwinFocusScript(..., pids = [])`: injeta `var pids = ${JSON.stringify(pids)};` e um nível inicial, antes de `tiers`: para cada `pid` de `pids` em ordem, percorre `list` e ativa `w` com `usable(w, false) && Number(w.pid) === pid`; se ativou, `return`.
- `focusWithKwinScript(classHints, titleHints, requireTitle, pids = [])` repassa `pids` ao builder.
- `focusWithXdotool(..., pids = [])`: `searches` começa com `pids.map((p) => ['--pid', String(p)])` (sem `escapeRegex`).
- `focusWindow`: lê `pids = (target.pids || []).map(Number).filter(Number.isInteger)`; o retorno antecipado passa a ser `if (!classHints.length && !titleHints.length && !pids.length) return false`; o `kdotool` só roda quando há hints; passa `pids` aos outros dois.

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && node test/unit/focus-pid.test.js && node test/unit/platform-windows.test.js`
Expected: ambos "Todos os checks passaram".

- [ ] **Step 5: Commit**

```bash
git add server/src/actions/systemActions.js server/test/unit/focus-pid.test.js
git commit -m "feat(windows): foco de janela por PID (script KWin e xdotool search --pid)"
```

---

### Task 3: Coletor `server/src/claudeSessions.js` (leitura, agregação, foco)

**Files:**
- Create: `server/src/claudeSessions.js`
- Modify: `server/src/config.js:45-47` (seção `claude` logo após `data`)
- Test: `server/test/unit/claude-sessions.test.js`

**Interfaces:**
- Consumes: `hostExec.execFile`; `platform.windows.focus(target)` (Task 2) via `opts.focus`.
- Config `claude`: `{ sessionsDir: '', slots: 4, workingMinutes: 15, doneMinutes: 10, waitingMinutes: 120, staleMinutes: 360 }`.
- Instalação do hook: `installHook()` → `Promise<{ hookPath, port }>`: grava (pelo `hostExec`, `sh -c 'mkdir -p … && cat > …'` como `aiUsage.js:92`) a cópia de `scripts/claude-code-hook.py` em `~/.local/state/matdeck/claude-code-hook.py` **só se o conteúdo difere** (compara com `cat` antes) e a porta em `~/.local/state/matdeck/port`. Chamada por `start()` e `reconnect()`. `opts.hookSource` (caminho do script no repo; padrão `path.resolve(__dirname, '../../scripts/claude-code-hook.py')`), `opts.hookDir` (padrão `~/.local/state/matdeck`), `opts.port` (número; o servidor passa `this.port`).
- Produces (`module.exports = ClaudeSessions`, com estáticos `effectiveState`, `sessionLabel`, `activityText`, `aggregate`, `parseScan`, `keyStateFor`, `DEFAULT_DIR`):
  - `new ClaudeSessions(config, { focus, execFile, now, scanActiveMs = 2000, scanIdleMs = 15000, tickMs = 1000 })`
  - `start()`, `stop()`, `refreshNow()` → `Promise<void>` (uma varredura), `setActive(viewers: boolean)`, `reconnect()` (relê config e varre).
  - `snapshot()` → `{ dir, dirExists, lastRead, slots, hookPath, port, state, counts: {working, waiting, done}, total, sessions: [{ id, name, state, tool, detail, prompt, notification_type, since, activity, window }] }`.
  - `stateFor(actionId)` → objeto de `updateKey` ou `null` (detalhes na Task 4).
  - `handleAction(actionId, eventType)` → `Promise<boolean>`: em `keyDown`, `claude:slot:N` foca a sessão da vaga N; `claude:summary` foca a primeira `waiting`, senão a primeira `working`. Alvo: `{ pids: window.pids, classHints: [classHintFor(window.term_program)] }` com `classHintFor`: `Maestri → 'maestri'`, `vscode → 'code'`, outros → o nome em minúsculas, vazio → `[]`. Sem `window` ou sem sessão: `console.log` e `false`.
  - Evento `change` quando `aggregate(...).key` (estado/nome por vaga) ou `tool_key` ou o minuto do `since` muda.
  - Leitura: `execFile('sh', ['-c', SCAN_SH, 'sh', dir], { timeout: 4000, maxBuffer: 4 MiB })` onde `SCAN_SH` imprime, por arquivo `*.json` da pasta, três linhas: `== <nome>`, `mtime <epoch do transcript_path, ou 0>` e o conteúdo em uma linha (`tr -d '\n'`); e uma primeira linha `dir <ok|missing>`. `parseScan(stdout)` → `{ dirExists, records: [...] }`, ignorando JSON inválido. O `mtime` do transcript vem de `stat -c %Y` (Linux) ou `stat -f %m` (macOS), tentado nessa ordem.
  - Agregação: porta literal do `status.py` (`PRIORITY`, `ORDER`, prazos em segundos a partir dos minutos da config, `effective_state`, `session_label`, `short_tool`, `ACTIVITY_VERB`, `activity_text`, `aggregate` com `since`). `record.activity` = `mtime` do transcript.

- [ ] **Step 1: Escrever o teste que falha**

`server/test/unit/claude-sessions.test.js`, com pasta temporária real (`MATDECK_CLAUDE_STATE_DIR` via `config.set('claude', { sessionsDir: dir })` num `ConfigStore` em arquivo temporário) e `now` injetado. Porta dos testes do relógio:

```js
const { aggregate, effectiveState, sessionLabel, activityText, parseScan } = ClaudeSessions;
const T = 1_000_000; const rec = (o) => ({ session_id: 's', state: 'working', ts: T, ...o });
check('sem sessões: idle', aggregate([], T, cfg).state === 'idle');
check('waiting ganha de working', aggregate([rec({ state: 'working' }), rec({ session_id: 'b', state: 'waiting' })], T, cfg).state === 'waiting');
check('working ganha de done', ...);
check('done expira para idle depois de doneMinutes', effectiveState(rec({ state: 'done', ts: T - 11 * 60 }), T, cfg) === 'idle');
check('working morto (15 min sem sinal) é ignorado', aggregate([rec({ ts: T - 16 * 60 })], T, cfg).working === 0);
check('atividade no transcript mantém working vivo', effectiveState(rec({ ts: T - 16 * 60, activity: T - 10 }), T, cfg) === 'working');
check('done continua contando enquanto outro trabalha', ...);
check('sessão sem sinal há mais de staleMinutes some', aggregate([rec({ ts: T - 7 * 3600 })], T, cfg).total === 0);
check('lista ordenada por prioridade e nome; label = projeto acima de .maestri', s[0].state === 'waiting' && sessionLabel('/x/organizador/.maestri/roles/abc') === 'organizador' && sessionLabel('/x/apk-matdeck') === 'apk-matdeck');
check('activityText', activityText({ state: 'waiting', notification_type: 'permission_prompt' }) === 'Pediu permissão' && activityText({ state: 'working', tool_full: 'Edit', detail: 'Hero.tsx' }) === 'Editando Hero.tsx' && activityText({ state: 'working', tool_full: 'mcp__n8n__search' }) === 'n8n · search' && activityText({ state: 'working' }) === 'Pensando');
check('since usa turn_started em working', ...);
check('parseScan ignora arquivo inválido e lê os outros', parseScan('dir ok\n== a.json\nmtime 0\n{bad\n== b.json\nmtime 5\n{"session_id":"b","state":"idle","ts":1}\n').records.length === 1);
check('parseScan: pasta inexistente', parseScan('dir missing\n').dirExists === false);
// coletor de verdade sobre a pasta temporária
const cs = new ClaudeSessions(config, { focus, now: () => T });
await cs.refreshNow();
check('pasta inexistente: dirExists false e sem erro', cs.snapshot().dirExists === false);
fs.mkdirSync(dir); escreve 2 arquivos (um waiting com window.pids [4242] e term_program Maestri; um working sem window);
await cs.refreshNow();
check('snapshot com 2 sessões, waiting primeiro', ...);
check('stateFor(claude:slot:1) é a waiting com pulse', st.pulse === true && st.bgColor === '#B91C1C');
check('handleAction slot 1 chama focus com pids e classHints maestri', focused[0].pids[0] === 4242 && focused[0].classHints[0] === 'maestri');
check('handleAction sem window não chama focus', await cs.handleAction('claude:slot:2', 'keyDown') === false && focused.length === 1);
check('summary foca a primeira waiting', ...);
check('slots da config limitam as vagas (slots: 1 → slot 2 vazio)', ...);
check('evento change ao mudar o estado de um arquivo', ...);
check('setActive(false) alonga a cadência (scanIdleMs)', cs.scanMs() === 15000);
// instalação do hook em hookDir temporário
const { hookPath, port } = await cs.installHook();
check('installHook copia o script e grava a porta', fs.readFileSync(hookPath, 'utf8') === fs.readFileSync(HOOK_SRC, 'utf8') && fs.readFileSync(path.join(hookDir, 'port'), 'utf8').trim() === String(port));
const m1 = fs.statSync(hookPath).mtimeMs; await cs.installHook();
check('installHook não regrava quando o conteúdo é igual', fs.statSync(hookPath).mtimeMs === m1);
check('snapshot traz hookPath e port', cs.snapshot().hookPath === hookPath && cs.snapshot().port === port);
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/claude-sessions.test.js`
Expected: FAIL com `Cannot find module '../../src/claudeSessions'`.

- [ ] **Step 3: Implementar `config.js` e `claudeSessions.js`**

`config.js`: seção `claude` conforme a interface. `claudeSessions.js`: conforme a interface; `settings()` como em `dataAssistant.js:133` (config + `MATDECK_CLAUDE_STATE_DIR` com precedência sobre `sessionsDir`; `~` expandido com `os.homedir()`); `slots` limitado a 1..12. `start()` agenda `scan` (cadência `scanMs()` = `scanActiveMs` se `viewers` senão `scanIdleMs`) e `tick` (`tickMs`, só recalcula `since` e emite `change` quando o texto do tempo muda). `stop()` limpa timers. Varredura em andamento não dispara outra (flag `scanning`; `refreshNow` enfileira uma a mais).

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && node test/unit/claude-sessions.test.js`
Expected: "Todos os checks passaram".

- [ ] **Step 5: Commit**

```bash
git add server/src/claudeSessions.js server/src/config.js server/test/unit/claude-sessions.test.js
git commit -m "feat(claude): coletor das sessões do Claude Code (leitura pelo host, agregação e foco por PID)"
```

---

### Task 4: Estado visual das teclas (`keyStateFor`) e `isStatKey` no deck

**Files:**
- Modify: `server/src/claudeSessions.js` (função `keyStateFor(actionId, summary, slots)`)
- Modify: `server/web/app.js:640` (`isStatKey`), regenerar `server/web/app.legacy.js`
- Test: `server/test/unit/claude-sessions.test.js` (mais checks), `server/test/unit/deck-viewport.test.js` não muda; novo bloco em `claude-sessions.test.js` que extrai `isStatKey` do `app.js` com o `grab()` de `deck-viewport.test.js`.

**Interfaces:**
- Produces: `keyStateFor(actionId, summary, slots)`:
  - `claude:slot:N` (1 ≤ N ≤ slots): com sessão → `{ title: name, statMode: 'bar', statHead: sinceText, statBig: LABEL[state], statSub: activity (≤ 40 chars, reticências), statColor: COLOR[state], badge: null, bgColor: waiting ? '#B91C1C' : undefined, borderColor: waiting ? '#F87171' : undefined, pulse: waiting, active: state === 'working' || state === 'waiting', statPercent: null }`; sem sessão → `{ title: '—', statMode: 'bar', statHead: '', statBig: 'VAZIA', statSub: '', statColor: '#6B7280', badge: null, bgColor: undefined, borderColor: undefined, pulse: false, active: false, statPercent: null }`.
  - `LABEL`: `waiting: 'PRECISA'`, `working: 'TRAB.'`, `done: 'PRONTO'`, `idle: 'LIVRE'`. `COLOR`: `waiting: '#F87171'`, `working: '#3B82F6'`, `done: '#16A34A'`, `idle: '#6B7280'`.
  - `sinceText(seconds)`: `'12s'`, `'2m'`, `'1h05'`.
  - `claude:summary` → `{ statMode: 'meters', statHead: HEAD[state geral] ('PRECISA DE VOCÊ' | 'TRABALHANDO' | 'PRONTO' | 'LIVRE'), statColor, statRows: [ {k:'Trabalhando', v:String(working), pct: total ? 100*working/total : 0, color:'#3B82F6'}, {k:'Precisando', v:..., color:'#F87171'}, {k:'Prontos', v:..., color:'#16A34A'} ], pulse: waiting > 0, bgColor: waiting > 0 ? '#B91C1C' : undefined, borderColor: waiting > 0 ? '#F87171' : undefined, active: working + waiting > 0, badge: null }`.
  - outra ação → `null`.
- `app.js` `isStatKey`: inclui `cfg.actionId.startsWith('claude:')`.

- [ ] **Step 1: Escrever os checks que falham**

```js
check('slot com working: statBig TRAB., statSub atividade, sem pulse', ...);
check('statSub cortado em 40 com reticências', st.statSub.length <= 40 && st.statSub.endsWith('…'));
check('slot vazio: VAZIA cinza', st.statBig === 'VAZIA' && st.statColor === '#6B7280');
check('resumo conta além das vagas (slots 1, 3 sessões → v "2" trabalhando)', ...);
check('resumo com waiting pulsa e vem vermelho', ...);
check('sinceText', sinceText(12) === '12s' && sinceText(125) === '2m' && sinceText(3900) === '1h05');
// deck
const isStatKey = vm.runInContext(grab('isStatKey') + '; isStatKey', ctx);
check('deck trata claude:slot:1 como tecla de telemetria', isStatKey({ actionId: 'claude:slot:1' }) === true);
check('app.legacy.js também', /claude:/.test(fs.readFileSync('web/app.legacy.js', 'utf8')));
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/claude-sessions.test.js`
Expected: FAIL nos checks novos.

- [ ] **Step 3: Implementar `keyStateFor` e `isStatKey`; regenerar o legado**

Run depois de editar `app.js`: `cd scripts/legacy-build && npm run build`

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && node test/unit/claude-sessions.test.js && node test/unit/deck-viewport.test.js`
Expected: ambos verdes.

- [ ] **Step 5: Commit**

```bash
git add server/src/claudeSessions.js server/web/app.js server/web/app.legacy.js server/test/unit/claude-sessions.test.js
git commit -m "feat(claude): aparência das teclas Claude: terminal N e Claude: resumo; deck reconhece claude:* como telemetria"
```

---

### Task 5: Catálogo, servidor (rotas, dispatch, telemetria) e `TITLE_IS_CONTENT`

**Files:**
- Modify: `server/src/actionCatalog.js:195-241` (grupo `claude` após o grupo `volume`)
- Modify: `server/src/index.js:112` (instancia), `:448-453` (`claudeSlots` no ctx), `:488` (rotas), `:1073-1079` (dispatch `prefix === 'claude'`), `:1161-1163` (`TITLE_IS_CONTENT`), `:1225-1230` (estado inicial das teclas `claude:` ao abrir a tela), `:905-910` (`updateDemand` inclui `this.claudeSessions`), `:1575-1593` (`setupClaudeTelemetry` + `pushClaudeKeys`, chamado em `:159`), `:1759` (`stop`)
- Test: `server/test/unit/claude-catalog.test.js`; estender `server/test/unit/restart.test.js`? Não: novo `claude-server.test.js` no padrão de `darwin-server.test.js` (sobe `MatDeckServer` em porta livre com `MATDECK_DATA_DIR` temporário e `MATDECK_CLAUDE_STATE_DIR` temporário).

**Interfaces:**
- Consumes: `ClaudeSessions` (Task 3/4): `snapshot()`, `stateFor()`, `handleAction()`, `refreshNow()`, `setActive()`, `reconnect()`, `on('change')`.
- Produces: grupo `{ id: 'claude', label: 'Claude Code', icon: 'claude', actions: [ { id: 'claude:slot:1', label: 'Claude: terminal 1', icon: 'claude', kind: 'indicator', hint: 'Terminal do Claude Code na vaga 1 (por prioridade: precisa de você, trabalhando, pronto). Toque foca a janela dele' }, …, { id: 'claude:summary', label: 'Claude: resumo', icon: 'claude', kind: 'indicator', defaultSpan: { cols: 2, rows: 1 }, hint: 'Quantos terminais estão trabalhando, precisando de você e prontos; toque foca quem precisa de você' } ] }` gerado por `ctx.claudeSlots` (número; ausente → 4).
- Rotas: `GET /api/claude` → `snapshot()`; `POST /api/claude/refresh` → só loopback (mesma checagem de `/api/restart`), `{ success: true }`, chama `refreshNow()` sem esperar.
- `TITLE_IS_CONTENT` ganha `claude:summary` e, por prefixo, toda `claude:slot:` (mudar o `has(...)` nos três usos para uma função estática `titleIsContent(actionId)` que cobre o `Set` e o prefixo `claude:slot:`).
- `updateDemand` (`index.js:909`) inclui `this.claudeSessions` na lista de coletores com `setActive`.
- Construtor: `new ClaudeSessions(this.config, { focus: (t) => this.platform.windows.focus(t), port: this.port })` (conferir o nome do campo da porta em `index.js:36`).

- [ ] **Step 1: Escrever os testes que falham**

`claude-catalog.test.js`:
```js
const { buildActionCatalog } = require('../../src/actionCatalog');
const g = buildActionCatalog({ claudeSlots: 3 }).groups.find((x) => x.id === 'claude');
check('3 vagas + resumo', g.actions.filter((a) => a.id.startsWith('claude:slot:')).length === 3 && g.actions.some((a) => a.id === 'claude:summary'));
check('sem claudeSlots: 4', buildActionCatalog({}).groups.find((x) => x.id === 'claude').actions.length === 5);
check('resumo é 2x1', g.actions.find((a) => a.id === 'claude:summary').defaultSpan.cols === 2);
```
`claude-server.test.js` (servidor real):
```js
check('GET /api/claude responde com dirExists e slots', body.slots === 4 && typeof body.dirExists === 'boolean');
check('POST /api/claude/refresh do loopback: success', ...);
check('POST /api/claude/refresh com X-Forwarded-For não muda nada (checa o socket)', ...);  // só confere que loopback real passa
check('preset com claude:slot:1 chega ao deck com statBig VAZIA', keyDef.statBig === 'VAZIA');
// grava um arquivo waiting na pasta e POST refresh
check('updateKey chega com PRECISA e pulse', msg.key.statBig === 'PRECISA' && msg.key.pulse === true);
check('título do usuário não sobrescreve o nome do projeto (TITLE_IS_CONTENT)', msg.key.title === 'apk-matdeck');
check('keyDown na vaga chama o foco com os pids (windows.focus espiado)', ...);
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/claude-catalog.test.js; node test/unit/claude-server.test.js`
Expected: FAIL (grupo inexistente / rota 404).

- [ ] **Step 3: Implementar**

Seguir os pontos de `index.js` listados em Files, copiando o padrão de `setupDataTelemetry`/`pushDataKeys` (cache `claudeLastSent`), `config.on('change', { section: 'claude' })` → `this.claudeSessions.reconnect()`. No dispatch: `else if (prefix === 'claude') { const r = this.claudeSessions.handleAction(actionId, eventType); if (r && r.catch) r.catch((e) => console.warn(`[Claude] Falha em ${actionId}: ${e.message}`)); }`. `handleAction` recebe `focus` = `(t) => this.platform.windows.focus(t)` no construtor do coletor.

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && npm test`
Expected: todos os arquivos passam (contar: 21 anteriores + 5 novos).

- [ ] **Step 5: Commit**

```bash
git add server/src/actionCatalog.js server/src/index.js server/test/unit/claude-catalog.test.js server/test/unit/claude-server.test.js
git commit -m "feat(claude): grupo Claude Code no catálogo, rotas /api/claude e teclas vivas no deck"
```

---

### Task 6: Ajustes no gerenciador e documentação

**Files:**
- Modify: `server/web/manage.html:573` (nova `<section class="settings-section">` "Claude Code" após a seção Data), `server/web/manage.js` (validação de `claude.slots` 1..12 e dos minutos ≥ 1 em `validateConfigFields`; estado via `GET /api/claude` ao abrir Ajustes; botão "Copiar" do trecho do hook)
- Modify: `README.md:213` (nova subseção "### Claude Code (terminais no deck)" antes de "### Data"), `README.md:284` (limitação: Maestri foca a janela, não o terminal), `CHANGELOG.md:8` ("Adicionado")
- Test: `server/test/unit/claude-server.test.js` (checks de arquivo: campos `data-path="claude.*"` no HTML; README e CHANGELOG citam `claude-code-hook.py`)

**Interfaces:**
- Campos: `claude.sessionsDir` (text, placeholder `~/.local/state/matdeck/claude-sessions`), `claude.slots` (number 1–12), `claude.workingMinutes`, `claude.doneMinutes`, `claude.waitingMinutes`, `claude.staleMinutes` (number, min 1). Trecho do hook em `<pre id="claude-hook-snippet">` preenchido pelo `manage.js` com `GET /api/claude` → `hookPath` (a cópia instalada pelo coletor em `~/.local/state/matdeck/claude-code-hook.py`, que o host enxerga mesmo com o servidor no Flatpak). Linha de estado `#claude-status`: "N sessões · última leitura há Xs" ou "pasta não existe: instale o hook".
- Snippet (JSON do `settings.json`): seis eventos (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `SessionEnd`), cada um `{"hooks":[{"type":"command","command":"python3 -I '<hookPath>' <Evento>"}]}`.

- [ ] **Step 1: Escrever os checks que falham** (em `claude-server.test.js`)

```js
check('manage.html tem os campos claude.*', ['claude.sessionsDir','claude.slots','claude.workingMinutes','claude.doneMinutes','claude.waitingMinutes','claude.staleMinutes'].every((p) => html.includes(`data-path="${p}"`)));
check('snapshot traz hookPath absoluto da cópia instalada', path.isAbsolute(body.hookPath) && body.hookPath.endsWith('claude-code-hook.py') && fs.existsSync(body.hookPath));
check('README documenta o hook', read('README.md').includes('claude-code-hook.py'));
check('CHANGELOG cita o grupo', read('CHANGELOG.md').includes('Claude Code'));
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/claude-server.test.js`
Expected: FAIL nos checks novos.

- [ ] **Step 3: Implementar HTML, JS, README e CHANGELOG**

README: o que as teclas mostram, o toque, como instalar o hook (trecho), Ajustes, Flatpak, limitação do Maestri, módulo `src/claudeSessions.js`. CHANGELOG em "Adicionado", no estilo da entrada da Data.

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && npm test`
Expected: todos os arquivos passam.

- [ ] **Step 5: Commit**

```bash
git add server/web/manage.html server/web/manage.js README.md CHANGELOG.md server/test/unit/claude-server.test.js
git commit -m "feat(claude): Ajustes → Claude Code (vagas, pasta, prazos, trecho do hook) e documentação"
```
