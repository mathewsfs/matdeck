# Grupo "Claude Code" no deck — design

Data: 2026-11-04. Estado: **aprovado pelo dono** (revisado por um "builder check"; respostas incorporadas). Decisões tomadas por mim estão marcadas
*(decisão minha)*; o que o dono pediu está sem marca.

## Intenção

O dono tem um relógio ESP8266 (projeto pessoal `smart-clock`, fora deste repositório) que mostra, em
tempo real, o estado de cada terminal do Claude Code: qual está trabalhando e no quê ("Editando
Hero.tsx", "Bash · npm test", "Pensando"), há quanto tempo, quem terminou e, com destaque, quem
**precisa dele** (pediu permissão ou está esperando resposta). A fonte é um hook do Claude Code que grava
um JSON por sessão; um serviço lê esses arquivos a cada segundo, agrega e desenha a tela.

Ele quer a mesma informação no tablet, como teclas do MatDeck, com uma diferença que o relógio não
tem: **tocar na tecla de um terminal leva o PC até a janela daquele terminal**. O caso que mais vale é
"um terminal pediu permissão, toco na tecla e já estou nele".

## Objetivos

- Um grupo **"Claude Code"** no catálogo de ações, com teclas que mostram, por terminal: nome do
  projeto, o que está fazendo, há quanto tempo, e um selo colorido de estado. Quem precisa do dono
  aparece primeiro e pulsa em vermelho.
- Toque na tecla de um terminal: foca a janela daquele terminal. Para terminais dentro do Maestri (uma
  janela Electron só), traz a janela do Maestri para a frente.
- Uma tecla de resumo (2 colunas) com a contagem: trabalhando, precisando, prontos.
- Tudo **configurável em Ajustes**: número de vagas de terminal, pasta dos arquivos de sessão e os
  prazos de validade dos estados.
- Funciona no Flatpak e fora dele; sem navegador nos testes; sem dependência npm nova.

## Não objetivos

- Reaproveitar o hook ou o serviço do smart-clock. O MatDeck é público; traz o seu próprio hook e
  convive com o do relógio (os dois rodam a cada evento, custo de milissegundos).
- Consumo 5 h / semana: já existe nas teclas "Claude · 5 h", "Claude · semana" e "Claude: todas as
  janelas" (grupo "Uso de IA"). Não repetir.
- Selecionar o terminal certo **dentro** do Maestri. A CLI do Maestri não tem comando para isso (só
  aparece um campo interno `focusedTerminalId`). O identificador do terminal fica gravado para o dia em
  que houver API.
- Mascote animado, modo cartão em tela cheia e outras coisas que só fazem sentido na tela do relógio.
- Responder à permissão pelo deck (aprovar/negar). Fica para depois, se o dono quiser.
- macOS: o foco por processo é Linux/KWin nesta entrega; no Mac as teclas mostram o estado e o toque
  usa o foco por nome do app (`platform.windows.focus`) quando o hook souber o app; senão não faz nada.

## Anti-objetivos (o que tornaria isto um fracasso)

- O hook atrapalhar o Claude Code: ele precisa ser rápido, nunca falhar (sai sempre com 0) e não depender
  do MatDeck estar no ar.
- Tecla "fantasma": terminal fechado continuando no deck por horas. Os prazos de validade e o evento
  `SessionEnd` cuidam disso, como no relógio.
- Focar a janela errada quando há dois terminais parecidos. O foco é por **processo** (PID), não por
  título.
- Gastar CPU à toa: ler a pasta a cada segundo mesmo sem ninguém olhando o deck.

## Restrições

- Servidor Node.js CommonJS, deck ES5 após o build legado (`cd scripts/legacy-build && npm run build`).
- No Flatpak o servidor **não vê o home** (não há `--filesystem=home`). Leitura dos arquivos de sessão
  pelo `hostExec` (como `aiUsage.js` faz com `~/.claude/.credentials.json`), nunca por `fs` direto.
- Hook em Python 3 padrão (sem pacotes), executado com `python3 -I`, como o do relógio.
- Foco de janela por PID: script KWin (`window.pid`, Plasma 6) e `xdotool search --pid` como reserva no
  X11. Sem kdotool para isso (ele não busca por PID).
- Conventional Commits em português; branch `feat/claude-code-sessions`, ramificada de
  `feat/acao-data` *(decisão minha)* porque reaproveita o padrão do coletor da Data (PR #6, ainda
  aberto) e a correção do pulso na renderização inicial. O PR #6 entra antes deste.

## Decisões de arquitetura (tomadas)

### 1. O hook: `scripts/claude-code-hook.py`

Mesmo contrato do hook do relógio (um JSON por sessão, gravação atômica por `.tmp` + `os.replace`,
nunca falha), com campos a mais para o foco. Pasta padrão `~/.local/state/matdeck/claude-sessions/`
(variável `MATDECK_CLAUDE_STATE_DIR` tem precedência). Eventos: `SessionStart` (idle),
`UserPromptSubmit` (working), `PreToolUse`/`PostToolUse` (working, com ferramenta e resumo), `Stop`
(done), `Notification` (waiting; `idle_prompt` vira done), `SessionEnd` (apaga o arquivo).

Registro por sessão:

```json
{
  "session_id": "…", "state": "working", "event": "PreToolUse", "ts": 1793791779.9,
  "cwd": "/…/apk-matdeck", "transcript_path": "/…/x.jsonl",
  "tool": "Bash", "detail": "Lê o hook do smart-clock", "prompt": "isso, tocar e focar…",
  "turn_started": 1793791773.1, "notification_type": null,
  "window": {
    "pids": [23683, 23314, 17554],
    "term_program": "Maestri",
    "maestri_terminal_id": "164e315b-…",
    "maestri_workspace_id": "7b243302-…"
  }
}
```

- `window.pids`: cadeia de processos pais a partir do pai do hook (o processo `claude`), subindo por
  `/proc/<pid>/stat` até o PID 1 ou 8 níveis, o que vier primeiro. Gravada só no `SessionStart` e no
  `UserPromptSubmit` *(decisão minha: a árvore não muda no meio de um turno; evita ler `/proc` a cada
  ferramenta)*. No macOS, `ps -o ppid=` no lugar de `/proc`.
- `term_program`, `maestri_*`: das variáveis de ambiente `TERM_PROGRAM`, `MAESTRI_TERMINAL_ID`,
  `MAESTRI_WORKSPACE_ID`, se existirem.
- Resumo da ferramenta (`detail`): mesma regra do relógio (descrição ou comando do Bash, nome do
  arquivo, padrão de busca, URL, skill…), 80 caracteres.
- Depois de gravar, **avisa o MatDeck** com `POST http://127.0.0.1:<porta>/api/claude/refresh`
  (timeout 0,3 s; erro ignorado) *(decisão minha)*. A porta vem de `MATDECK_PORT` (testes) ou do arquivo
  `~/.local/state/matdeck/port`, que o servidor grava ao iniciar (o servidor lê `PORT`, não existe
  variável exportada para o Claude Code); sem nenhum dos dois, 8888. Assim a tecla muda no mesmo
  instante do evento e o servidor não precisa ler a pasta a cada segundo.

Instalação *(decisão minha, após o builder check)*: o host não enxerga `/app` do Flatpak, então o
servidor **instala uma cópia** do script em `~/.local/state/matdeck/claude-code-hook.py` (pelo
`hostExec`, ao iniciar o coletor; regrava quando o conteúdo difere, então uma atualização do MatDeck
atualiza o hook no próximo start) e grava a porta em `~/.local/state/matdeck/port`. O gerenciador, em
Ajustes → Claude Code, mostra o trecho pronto para colar no `~/.claude/settings.json` (um comando por
evento, apontando para a cópia) e um botão "Copiar". Não edita `settings.json` automaticamente; é
arquivo do usuário. O README ganha a seção "Claude Code (terminais no deck)" com o mesmo trecho.

Sessões sem terminal (`claude -p`, rotinas, a Data editando o repositório) **ocupam vaga** como
qualquer outra, igual ao relógio; o toque não acha janela e não faz nada *(decisão minha: filtrar
exigiria detectar TTY no hook e esconderia trabalho real)*.

### 2. O coletor: `server/src/claudeSessions.js`

`EventEmitter` no padrão de `dataAssistant.js`: `start()`, `stop()`, `refreshNow()`, `snapshot()`,
`stateFor(actionId)`, `handleAction(actionId, eventType)`, `setActive(viewers)`, evento `change`.

- **Leitura**: uma chamada `hostExec` por varredura, `sh -c` que lista `*.json` da pasta e imprime cada
  arquivo precedido do nome (formato linha-nome + linha-JSON), para funcionar igual dentro e fora do
  Flatpak. Também pega o `mtime` do `transcript_path` de cada sessão (`stat -c %Y`), que o relógio usa
  como "última atividade" para não dar a sessão por morta enquanto o Claude pensa sem chamar ferramenta.
- **Cadência** *(decisão minha)*: varredura a cada 2 s enquanto há algum deck conectado (o
  `setActive(viewers)` do modo econômico, que só distingue "há cliente / não há"; o coletor entra na
  lista do `updateDemand`); 15 s sem ninguém; e imediata quando chega `POST /api/claude/refresh`. Um `tick` de 1 s só recalcula "há quanto tempo" e prazos,
  sem ler disco.
- **Agregação**: porta do `status.py` para JS, com os mesmos nomes: `effectiveState(record, now)`,
  `sessionLabel(cwd)` (projeto acima de `.maestri`, senão a pasta), `activityText(session)`
  ("Pediu permissão" / "Esperando você" / "Pronto" / "Livre" / "Pensando" / "Editando X" / "Bash · y" /
  "servidor · ferramenta" para MCP), ordenação `waiting` → `working` → `done` → `idle`, depois nome.
  Prazos vêm de Ajustes (padrões do relógio: working 15 min, done 10 min, waiting 120 min, some depois
  de 360 min sem sinal).
- **Vagas**: `slots` (Ajustes, padrão 4, de 1 a 12). A sessão de índice `i` da lista ordenada vai para a
  tecla `claude:slot:<i+1>`. Vaga sem sessão fica cinza com "—".

### 3. As teclas (catálogo e estado visual)

Grupo `claude` ("Claude Code", ícone `claude`), gerado em `buildActionCatalog` a partir de
`ctx.claudeSlots` (como o grupo de volume por app):

| Ação | Tipo | Conteúdo |
|---|---|---|
| `claude:slot:N` ("Claude: terminal N") | indicator, 1×1, **painel** (o deck não desenha selo e painel juntos; `isStatKey` passa a reconhecer `claude:`) | `title` = nome do projeto; `statHead` = tempo no estado ("2m", "1h05"); `statBig` = estado em texto (`PRECISA`, `TRAB.`, `PRONTO`, `LIVRE`, `VAZIA`); `statSub` = atividade (até 40 caracteres); `statColor`: vermelho `#F87171` precisa, azul `#3B82F6` trabalhando, verde `#16A34A` pronto, cinza `#6B7280` livre/vazia. Quando precisa do dono: `pulse`, `bgColor` `#B91C1C` e `borderColor` `#F87171` (nunca `#DC2626`, que o deck trata como "mutado"). Sem `badge`. |
| `claude:summary` ("Claude: resumo") | indicator, 2×1 (`defaultSpan`) | `statMode: 'meters'`, `statHead` = estado geral (`PRECISA DE VOCÊ` / `TRABALHANDO` / `PRONTO` / `LIVRE`), linhas: trabalhando, precisando, prontos (contagem e cor). |

`claude:slot:N` e `claude:summary` contam como "título é conteúdo" (hoje `TITLE_IS_CONTENT` é um `Set`
de ids fixos; vira checagem por prefixo para `claude:slot:`). Única mudança no deck: `isStatKey` em
`app.js` reconhece o prefixo `claude:` (e o `app.legacy.js` é regenerado).

Toque:

- `claude:slot:N` → `focusSession(session)`.
- `claude:summary` → foca a primeira sessão `waiting`; se não houver, a primeira `working`; senão nada.

### 4. Foco por processo

`platform.windows.focus(target)` ganha `target.pids` (lista de inteiros). Ordem no Linux:

1. Script KWin: ativa a primeira janela cujo `pid` esteja em `pids` (ordem da lista: o processo mais
   próximo do `claude` primeiro, assim um `konsole` com várias abas foca pelo menos a janela certa).
   Mesmo mecanismo de marcador que o `buildKwinFocusScript` usa hoje.
2. `xdotool search --pid <pid>` + `windowactivate`, por pid, quando houver X11 utilizável.
3. Se `pids` não achou janela e `term_program === 'Maestri'`: `classHints: ['maestri']` (janela
   Electron do AppImage tem classe `maestri-app`).

`focusSession` monta o alvo a partir de `window`: `pids`, e `classHints` de reserva por `term_program`
(`Maestri` → `maestri`; `konsole`/`kitty`/`alacritty`/`ghostty`/`WezTerm` → o próprio nome em minúsculas;
`vscode` → `code`). Sem `window` (sessão iniciada antes de instalar o hook novo, ou hook do relógio):
log e nada.

Fora do Linux: `pids` é ignorado e só `classHints` é usado (macOS: foco por nome do app, já existente).

### 5. Ajustes e configuração

`config.js`, seção `claude`:

```js
claude: {
    sessionsDir: '',      // vazio = ~/.local/state/matdeck/claude-sessions (MATDECK_CLAUDE_STATE_DIR tem precedência)
    slots: 4,             // 1–12 teclas "Claude: terminal N"
    workingMinutes: 15,   // working sem sinal vira livre
    doneMinutes: 10,      // pronto vira livre
    waitingMinutes: 120,  // esperando vira livre
    staleMinutes: 360     // sem sinal nenhum: some do deck
}
```

Gerenciador, seção "Claude Code" em Ajustes: pasta, vagas (número), os quatro prazos (minutos), o trecho
do hook para copiar e uma linha de estado ("3 sessões, última leitura há 2 s" / "pasta não existe:
instale o hook"). Mudar `slots` refaz o catálogo (`/api/actions` já é dinâmico); mudar a pasta ou os
prazos reinicia o coletor (`config.on('change', {section:'claude'})`, como a Data).

### 6. Rotas

- `GET /api/claude` → `snapshot()` (sessões agregadas, contagens, `lastRead`, `dir`, `dirExists`,
  `hookPath` da cópia instalada, `port`). Só para o gerenciador (mesma política das outras rotas de status).
- `POST /api/claude/refresh` → só loopback (mesma checagem de `/api/restart`), responde `{success:true}`
  e dispara uma varredura. Sem corpo.

## O que o builder decide

- Nome exato das funções internas do coletor e do teste, desde que os nomes do `status.py` apareçam onde
  a lógica é a mesma (facilita comparar com o relógio).
- Forma do trecho de hook mostrado no gerenciador (JSON pronto para colar, com os seis eventos).
- Abreviações do selo se não couberem na tecla 1×1 do iPad 2 (testar no `app.legacy.js`).
- Como medir "há quanto tempo" (turno em `working`, `ts` nos outros), copiando o relógio.

## Testes (sem navegador)

- `server/test/unit/claude-hook.test.js`: roda o script com `python3 -I` em pasta temporária
  (`MATDECK_CLAUDE_STATE_DIR`), um JSON por evento em stdin, e confere o arquivo: estados, `detail`,
  `window.pids` (contém o PID do processo pai do teste), `SessionEnd` apaga, JSON inválido não quebra,
  `session_id` inválido não grava, aviso HTTP ignorado quando a porta está fechada.
- `server/test/unit/claude-sessions.test.js`: coletor com `hostExec` real sobre pasta temporária
  (fora do Flatpak é o mesmo `sh`): agregação e prazos (porta dos 26 testes do relógio que fazem sentido),
  vagas, `stateFor` de cada tecla, `handleAction` chamando um `windows.focus` falso com os `pids`
  certos e o `classHints` de reserva do Maestri, cadência com `setActive`.
- `server/test/unit/focus-pid.test.js`: `buildKwinFocusScript` com `pids` gera um script que compara
  `window.pid`; `xdotool` recebe `search --pid`.
- Teste do catálogo: `claudeSlots: 3` gera três `claude:slot:*` e um `claude:summary`.
- `deck-viewport`-style: renderização da tecla `claude:slot:1` no `app.js` em `vm` com `badge`,
  `statBig`, `statSub` e `pulse` (garante que o deck mostra tudo sem mudança).
- Suíte inteira `cd server && npm test` verde.

## Roteiro manual do dono (depois)

1. Colar o trecho do hook em `~/.claude/settings.json`, abrir dois terminais do Claude Code (um no
   Maestri, um no Konsole).
2. No deck: ver as duas teclas com nome e atividade mudando enquanto trabalham.
3. Pedir ao Claude do Konsole algo que peça permissão: a tecla fica vermelha pulsando; tocar foca o
   Konsole.
4. Tocar na tecla do Maestri: a janela do Maestri vem para a frente.
5. Fechar um terminal: a tecla some em até 2 s. Deixar o outro parado 10 min: vira "LIVRE".
