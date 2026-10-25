# macOS fase 1: camada de plataforma no Linux — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolar em `server/src/platform/` tudo que fala com o sistema operacional, com a implementação Linux
produzindo exatamente os mesmos comandos de hoje, para que a fase 2 acrescente `darwin` sem tocar nos perfis
nem no `index.js`.

**Architecture:** `platform/index.js` escolhe `linux` ou `darwin` pela `process.platform` e devolve um objeto
com áreas (`keys`, `windows`, `apps`, `audio`, `media`, `hardware`, `tray`, `session`). No Linux as áreas são
adaptadores finos sobre os módulos que já existem (`SystemActions`, `WindowDetector`, `AudioMixer`,
`MediaPlayers`, `SpotifyMonitor`, `HardwareMonitor`, `TrayIndicator`, `AppLauncher`): nada de lógica nova,
só roteamento. Perfis e `index.js` deixam de importar `SystemActions` e `hostExec` e passam a usar
`this.ctx.platform`. Os atalhos literais dos perfis viram tabelas por plataforma. Testes unitários usam um
`hostExec` falso que registra os comandos gerados e asserta os valores atuais.

**Tech Stack:** Node.js 18+ CommonJS, testes no padrão de `server/test/unit/*.test.js` (sem framework,
`check(nome, ok)`), `npm test` em `server/`.

**Spec:** `docs/superpowers/specs/2026-10-24-macos-design.md` (§1 Camada de plataforma, §5 Teclas e
atalhos, §8 Testes, fase 1).

## Global Constraints

- Sem dependências npm novas; sem transpilação; CommonJS.
- Comportamento Linux idêntico: os comandos gerados (binário, argumentos, cadeias `a || b`) não mudam.
- Nenhum perfil nem `index.js` importa `actions/systemActions` ou `hostExec` ao fim da fase.
- `npm test` continua passando em Linux sem ferramentas externas (ydotool, pactl…) instaladas: os testes
  usam o `hostExec` falso.
- Mensagens de log, commits e comentários em português; nomes de código em inglês.
- Trabalho na branch `feat/macos-plataforma` (nunca direto na `main`).
- Nenhuma mudança de comportamento do deck, do protocolo WebSocket ou dos presets.

## Review Focus

1. Combo com tecla desconhecida (`ctrl+ç`) em `keys.shortcut`: devolve `false`, loga uma vez e não lança.
   Teste em Task 1.
2. PTT: `keys.keyUp` quando o ydotool falha devolve `false` (nunca `true` por omissão), para o perfil do
   Discord não acreditar que soltou. Teste em Task 1.
3. `windows.focus` com `requireTitle: true` e nenhum título casando **não** cai para `classHints` (senão
   `Ctrl+D` vira "adicionar favorito" em outra aba). Teste em Task 3.
4. `apps.launchFirst` sem nenhum candidato instalado devolve `false` e loga, sem lançar. Teste em Task 2.
5. `GET /api/status` passa a trazer `platform`; a escolha por `process.platform` precisa ser testável sem
   trocar de máquina (`MATDECK_PLATFORM` só em testes). Teste em Task 4.

---

### Task 0: Branch e esqueleto do teste falso

**Files:**
- Create: `server/test/fake-host-exec.js`

**Interfaces:**
- Produces: `install(options) -> recorder` e `uninstall()`.
  - `options.which`: `{ [bin]: '/caminho' | null }` (ausente = `null`).
  - `options.sockets`: lista de caminhos que `firstWritableSocket` considera graváveis.
  - `options.outputs`: `{ [chaveDoComando]: { stdout, stderr, code } }`, chave = `file + ' ' + args.join(' ')`
    para `execFile`/`spawn`, ou a string do comando para `exec`.
  - `recorder.calls`: array de `{ fn: 'exec'|'execFile'|'execSync'|'spawn'|'spawnDetached', cmd?, file?, args?, opts? }`.
  - `recorder.last(fn)` devolve a última chamada daquele tipo.
  - `install` grava o módulo falso em `require.cache` na chave `require.resolve('../src/hostExec')` **antes**
    de qualquer módulo de `src/` ser carregado; exporta as mesmas chaves do real
    (`isFlatpak=false`, `HOST_ARGS=[]`, `exec`, `execFile`, `execSync`, `spawn`, `spawnDetached`, `which`,
    `firstWritableSocket`). `exec`/`execFile` chamam o callback no próximo tick com `(err|null, stdout, stderr)`;
    `spawn`/`spawnDetached` devolvem um `EventEmitter` com `pid`, `kill()`, `unref()`, `stdout`/`stderr`
    emissores e `stdin.end()`.

- [ ] **Step 1: Criar a branch**

```bash
git checkout -b feat/macos-plataforma
```

- [ ] **Step 2: Escrever `server/test/fake-host-exec.js` conforme a interface acima**

- [ ] **Step 3: Verificar que instala e desinstala**

Run: `cd server && node -e "const f=require('./test/fake-host-exec');const r=f.install({which:{ydotool:'/usr/bin/ydotool'}});const h=require('./src/hostExec');console.log(h.which('ydotool'), h.isFlatpak);f.uninstall();console.log(require('./src/hostExec').isFlatpak)"`
Expected: `/usr/bin/ydotool false` e depois `false` (o real, fora do Flatpak).

- [ ] **Step 4: Commit**

```bash
git add server/test/fake-host-exec.js
git commit -m "test: hostExec falso que registra comandos para os testes da camada de plataforma"
```

---

### Task 1: `platform/linux/keys.js`

**Files:**
- Create: `server/src/platform/linux/keys.js`
- Test: `server/test/unit/platform-keys.test.js`

**Interfaces:**
- Consumes: `SystemActions` (`sendKey`, `keyHold`, `keyRelease`, `capabilities`, `capabilitiesStale`,
  `capabilitiesCached`, `hostVisibleTmpDir`), `hostExec.which`/`exec` (para `playerctl`).
- Produces: `createKeys() -> { shortcut(combo): Promise<boolean>, keyDown(combo): Promise<boolean>,
  keyUp(combo): Promise<boolean>, mediaKey(name): Promise<boolean>, capabilities(force?), capabilitiesStale(),
  capabilitiesCached(), hostVisibleTmpDir() }`. `mediaKey` aceita `'play_pause' | 'next' | 'prev'` e
  reproduz `DefaultProfile.mediaCommand`: `playerctl play-pause|next|previous` se `which('playerctl')`,
  senão `shortcut('XF86AudioPlay'|'XF86AudioNext'|'XF86AudioPrev')`. A sondagem do `playerctl` é feita uma
  vez, no `createKeys()`.

- [ ] **Step 1: Escrever o teste**

`server/test/unit/platform-keys.test.js`, ambiente: `process.env.WAYLAND_DISPLAY='wayland-0'`,
`XDG_CURRENT_DESKTOP='KDE'`, fake com `which: { ydotool: '/usr/bin/ydotool', playerctl: null }`,
`sockets: ['/tmp/.ydotool_socket']` (defina `YDOTOOL_SOCKET=/tmp/.ydotool_socket` no env para o caminho ser
candidato). Asserções:

```js
check('shortcut ctrl+shift+m via ydotool', last.file === '/usr/bin/ydotool' && JSON.stringify(last.args) === JSON.stringify(['key','29:1','42:1','50:1','50:0','42:0','29:0']));
check('keyDown ctrl+shift+p', JSON.stringify(last.args) === JSON.stringify(['key','29:1','42:1','25:1']));
check('keyUp ctrl+shift+p', JSON.stringify(last.args) === JSON.stringify(['key','25:0','42:0','29:0']));
check('mediaKey play_pause sem playerctl vira XF86AudioPlay', JSON.stringify(last.args) === JSON.stringify(['key','164:1','164:0']));
check('combo desconhecido devolve false sem lançar', (await keys.shortcut('ctrl+ç')) === false);
check('keyUp com ydotool falhando devolve false', (await keys.keyUp('ctrl+shift+p')) === false); // outputs: ydotool -> code 1
```

Segundo cenário (reinstalar o fake com `which: { playerctl: '/usr/bin/playerctl' }`):

```js
check('mediaKey next com playerctl', last.fn === 'exec' && last.cmd === 'playerctl next');
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/platform-keys.test.js`
Expected: FAIL com `Cannot find module '../../src/platform/linux/keys'`.

- [ ] **Step 3: Implementar `createKeys()` em `server/src/platform/linux/keys.js`**

Delegação direta aos estáticos de `SystemActions`; `mediaKey` com a lógica de `mediaCommand` (log em
português quando o `playerctl` falha, igual ao atual `[Default] playerctl … falhou`).

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && node test/unit/platform-keys.test.js`
Expected: todas as linhas `OK`, saída final sem `FAIL`.

- [ ] **Step 5: Commit**

```bash
git add server/src/platform/linux/keys.js server/test/unit/platform-keys.test.js
git commit -m "feat(platform): adaptador de teclas do Linux com testes de comandos gerados"
```

---

### Task 2: `platform/linux/apps.js` e `platform/linux/system.js`

**Files:**
- Create: `server/src/platform/linux/apps.js`
- Create: `server/src/platform/linux/system.js`
- Test: `server/test/unit/platform-apps-system.test.js`

**Interfaces:**
- Consumes: `SystemActions.launchFile`, `SystemActions.flatpakInstalled`, `SystemActions.commandExists`,
  `AppLauncher`, `hostExec.exec`/`which`.
- Produces:
  - `createApps() -> { launcher: AppLauncher, open(target): Promise<boolean>, launchFile(bin, args):
    Promise<boolean>, launchFirst(candidates, label): Promise<boolean>, flatpakInstalled(appId):
    Promise<boolean>, commandExists(bin): boolean }`. `open` = `launchFile('xdg-open', [target])`.
    `launchFirst` = `DefaultProfile.launchFirstAvailable` de hoje (cache de `which` por binário, log
    `[Apps] Nenhum programa encontrado para "<label>" (a, b, c)` e `false` quando nenhum existe).
  - `createSystem() -> { lock(): void, masterStep(deltaPercent): void, masterMuteToggle(): void }`,
    reproduzindo as cadeias `execFirstAvailable` de `profiles/default.js` (mesmas strings, mesma ordem,
    `timeout: 4000`, log `[System] Comando falhou (<primeiro> …): <linha>`); `masterStep(+5)` usa a cadeia
    de `media:vol_up`, `masterStep(-5)` a de `media:vol_down`.

- [ ] **Step 1: Escrever o teste**

Fake com `which: { kcalc: null, 'gnome-calculator': '/usr/bin/gnome-calculator', konsole: null }`.

```js
check('open usa xdg-open desanexado', last.fn === 'spawnDetached' && last.file === 'xdg-open' && last.args[0] === 'https://google.com');
check('launchFirst pula o que não existe', last.file === 'gnome-calculator' && last.args.length === 0);
check('launchFirst sem candidatos devolve false', (await apps.launchFirst([['konsole'], ['kitty']], 'terminal')) === false);
check('lock começa por loginctl', last.fn === 'exec' && last.cmd.startsWith('(loginctl lock-session) || (qdbus org.freedesktop.ScreenSaver /ScreenSaver Lock) || (xdg-screensaver lock)'));
check('masterStep(+5)', last.cmd === '(wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ 5%+) || (pactl set-sink-volume @DEFAULT_SINK@ +5%) || (amixer -D pulse sset Master 5%+)');
check('masterStep(-5)', last.cmd === '(wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-) || (pactl set-sink-volume @DEFAULT_SINK@ -5%) || (amixer -D pulse sset Master 5%-)');
check('masterMuteToggle', last.cmd === '(wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle) || (pactl set-sink-mute @DEFAULT_SINK@ toggle)');
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/platform-apps-system.test.js`
Expected: FAIL por módulo inexistente.

- [ ] **Step 3: Implementar os dois módulos**

Mover `execFirstAvailable` e `launchFirstAvailable` de `profiles/default.js` para cá (com `binCache` por
instância); `profiles/default.js` só perde essas funções na Task 5.

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && node test/unit/platform-apps-system.test.js`
Expected: todas `OK`.

- [ ] **Step 5: Commit**

```bash
git add server/src/platform/linux/apps.js server/src/platform/linux/system.js server/test/unit/platform-apps-system.test.js
git commit -m "feat(platform): adaptadores de aplicativos e sessão do Linux"
```

---

### Task 3: `platform/linux/windows.js`

**Files:**
- Create: `server/src/platform/linux/windows.js`
- Test: `server/test/unit/platform-windows.test.js`

**Interfaces:**
- Consumes: `SystemActions.focusWindow`, `SystemActions.focusAndSend`, `WindowDetector`.
- Produces: `createWindows() -> { detector: WindowDetector, focus(target): Promise<boolean>,
  focusAndSend(target, combo, delayMs=150): Promise<boolean>, matchProfile(title, app),
  DETECTABLE_APPS }`. `target` = `{ classHints, titleHints, requireTitle }` como hoje.

- [ ] **Step 1: Escrever o teste**

Fake com `which: { kdotool: '/usr/bin/kdotool', ydotool: '/usr/bin/ydotool' }`, outputs:
`'kdotool search --name Meet' -> { stdout: '{abc}\n' }`, `'kdotool windowactivate {abc}' -> { stdout: '' }`,
`'kdotool search --name Nada' -> { stdout: '' }`.

```js
check('focus por título usa kdotool search --name', calls.some(c => c.file === 'kdotool' && c.args.join(' ') === 'search --name Meet'));
check('focus ativa o id devolvido', calls.some(c => c.file === 'kdotool' && c.args.join(' ') === 'windowactivate {abc}'));
check('requireTitle sem título casando não cai para classe', ok === false && !calls.some(c => c.args && c.args.includes('--class')));
check('focusAndSend envia o combo depois de focar', last.file === '/usr/bin/ydotool' && last.args[1] === '29:1');
check('detector expõe lastDetected e matchProfile', windows.detector.lastDetected.profile === null && windows.matchProfile('x', 'com.discordapp.discord') === 'discord');
```

Para o terceiro check: `focus({ titleHints: ['Nada'], classHints: ['brave-browser'], requireTitle: true })`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/platform-windows.test.js`
Expected: FAIL por módulo inexistente.

- [ ] **Step 3: Implementar `createWindows()`**

`detector = new WindowDetector()` criado no `createWindows()`; `focus`/`focusAndSend` delegam a
`SystemActions`; `matchProfile` e `DETECTABLE_APPS` reexportam os estáticos de `WindowDetector`.

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && node test/unit/platform-windows.test.js`
Expected: todas `OK`.

- [ ] **Step 5: Commit**

```bash
git add server/src/platform/linux/windows.js server/test/unit/platform-windows.test.js
git commit -m "feat(platform): adaptador de janelas do Linux (foco e detecção)"
```

---

### Task 4: `platform/index.js`, `platform/linux/index.js` e o contrato

**Files:**
- Create: `server/src/platform/index.js`
- Create: `server/src/platform/linux/index.js`
- Create: `server/src/platform/README.md`
- Test: `server/test/unit/platform-select.test.js`

**Interfaces:**
- Consumes: Tasks 1–3, `AudioMixer`, `SpotifyMonitor`, `MediaPlayers`, `HardwareMonitor`, `TrayIndicator`.
- Produces:
  - `platform/index.js`: `createPlatform(options = {}) -> Platform` e `platformName()`.
    `platformName()` devolve `process.env.MATDECK_PLATFORM` se definido (só testes), senão
    `process.platform === 'darwin' ? 'darwin' : 'linux'`. Para `'darwin'` nesta fase lança
    `Error('Plataforma darwin ainda não implementada (fase 2)')`; o teste cobre a seleção, não a implementação.
  - `Platform` (Linux): `{ name: 'linux', keys, windows, apps, audio: { mixer: AudioMixer, masterStep,
    masterMuteToggle }, media: { spotify: SpotifyMonitor, players: MediaPlayers }, hardware: HardwareMonitor,
    tray: { start({ port, lanIp, enabled }), stop(): Promise }, session: { lock }, describe(): string }`.
    `describe()` devolve a frase de sessão que `index.js` imprime hoje no início (Wayland/X11, desktop,
    teclas, foco, detecção), movida para cá sem mudar o texto.
  - `README.md`: tabela de áreas e métodos (copiar a tabela de §1 da spec) e a regra "perfis e index.js só
    usam `ctx.platform`".

- [ ] **Step 1: Escrever o teste**

```js
check('platformName padrão é linux nesta máquina', platformName() === 'linux');
process.env.MATDECK_PLATFORM = 'darwin';
check('MATDECK_PLATFORM força darwin', platformName() === 'darwin');
let threw = false; try { createPlatform(); } catch (e) { threw = /fase 2/.test(e.message); }
check('darwin ainda não implementado lança erro claro', threw);
delete process.env.MATDECK_PLATFORM;
const p = createPlatform();
check('áreas presentes', ['keys','windows','apps','audio','media','hardware','tray','session'].every(k => p[k]));
check('hardware é HardwareMonitor em modo econômico', p.hardware.currentInterval() === 10000);
check('describe menciona teclas e foco', /teclas:/.test(p.describe()) && /foco de janela:/.test(p.describe()));
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/platform-select.test.js`
Expected: FAIL por módulo inexistente.

- [ ] **Step 3: Implementar `platform/index.js` e `platform/linux/index.js`; escrever o README**

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && node test/unit/platform-select.test.js`
Expected: todas `OK`.

- [ ] **Step 5: Commit**

```bash
git add server/src/platform/index.js server/src/platform/linux/index.js server/src/platform/README.md server/test/unit/platform-select.test.js
git commit -m "feat(platform): seleção por plataforma e montagem das áreas no Linux"
```

---

### Task 5: Perfis usam `ctx.platform` e tabelas de atalhos por plataforma

**Files:**
- Modify: `server/src/profiles/default.js` (remover `exec`, `which`, `SystemActions`, `execFirstAvailable`,
  `launchFirstAvailable`, `mediaCommand`)
- Modify: `server/src/profiles/discord.js:1-12`, `:160-173`, `:193-197`, `:252-268`
- Modify: `server/src/profiles/meet.js:1-15`, `:130-180`
- Modify: `server/src/profiles/nextcloud.js:1-25`, `:144-176`
- Modify: `server/src/profiles/teamspeak.js:1-6`, `:1422-1436`
- Create: `server/src/platform/shortcuts.js`
- Test: `server/test/unit/profiles-platform.test.js`

**Interfaces:**
- Consumes: `Platform` da Task 4 via `this.ctx.platform`.
- Produces: `platform/shortcuts.js`: `forPlatform(table, name = platformName()) -> object` que devolve
  `table[name]` ou `table.linux`. Cada perfil declara `const SHORTCUTS = { linux: {...}, darwin: {...} }`
  com estes nomes e valores (Linux = valores de hoje; darwin = valores da spec §5):

| Perfil | nome | linux | darwin |
|---|---|---|---|
| meet | `mic` | `ctrl+d` | `cmd+d` |
| meet | `camera` | `ctrl+e` | `cmd+e` |
| meet | `hand` | `ctrl+alt+h` | `ctrl+cmd+h` |
| meet | `captions` | `c` | `c` |
| meet | `chat` | `ctrl+alt+c` | `ctrl+cmd+c` |
| meet | `people` | `ctrl+alt+p` | `ctrl+cmd+p` |
| meet | `shortcuts` | `ctrl+slash` | `cmd+slash` |
| meet | `fullscreen` | `f11` | `ctrl+cmd+f` |
| meet | `leave` | `ctrl+w` | `cmd+w` |
| discord | `ptt` (padrão de config) | `ctrl+shift+p` | `cmd+shift+p` |
| discord | `mute` (padrão de config) | `ctrl+shift+m` | `cmd+shift+m` |
| discord | `deafen` (padrão de config) | `ctrl+shift+d` | `cmd+shift+d` |
| discord | `quickSwitcher` | `ctrl+k` | `cmd+k` |
| discord | `inbox` | `ctrl+i` | `cmd+i` |
| discord | `prevChannel` | `alt+up` | `alt+up` |
| discord | `nextChannel` | `alt+down` | `alt+down` |
| discord | `markRead` | `escape` | `escape` |
| nextcloud | `mic`,`camera`,`hand`,`fullscreen`,`chat`,`home` | `m`,`v`,`r`,`f`,`c`,`escape` | iguais |
| nextcloud | `search` | `ctrl+f` | `cmd+f` |

`DEFAULT_CONFIG.pttKey/muteKey/deafenKey` do Discord passam a vir de `SHORTCUTS` da plataforma atual
(valor salvo no `config.json` do usuário continua prevalecendo).

- [ ] **Step 1: Escrever o teste**

Com um `ctx` falso `{ platform: fakePlatform, config: { get: () => ({}) }, updateKey() {}, profiles: new Map() }`
onde `fakePlatform` registra chamadas (`keys.shortcut`, `keys.keyDown/keyUp`, `keys.mediaKey`,
`windows.focusAndSend`, `apps.open/launchFirst/launchFile/flatpakInstalled/commandExists`,
`audio.masterStep/masterMuteToggle`, `session.lock`, `apps.launcher.launch`):

```js
check('forPlatform cai para linux', forPlatform({ linux: { a: 1 } }, 'darwin').a === 1);
check('forPlatform escolhe darwin', forPlatform({ linux: { a: 1 }, darwin: { a: 2 } }, 'darwin').a === 2);
check('default media:vol_up -> audio.masterStep(5)', calls.includes('audio.masterStep:5'));
check('default media:mute -> audio.masterMuteToggle', calls.includes('audio.masterMuteToggle'));
check('default media:play_pause -> keys.mediaKey(play_pause)', calls.includes('keys.mediaKey:play_pause'));
check('default launch:browser -> apps.open(https://google.com)', calls.includes('apps.open:https://google.com'));
check('default launch:calc -> apps.launchFirst', calls.some(c => c.startsWith('apps.launchFirst:kcalc')));
check('default system:lock -> session.lock', calls.includes('session.lock'));
check('meet mic -> windows.focusAndSend(ctrl+d) no linux', calls.includes('windows.focusAndSend:ctrl+d'));
check('discord ptt keyDown -> keys.keyDown(ctrl+shift+p)', calls.includes('keys.keyDown:ctrl+shift+p'));
check('discord ptt keyUp -> keys.keyUp(ctrl+shift+p)', calls.includes('keys.keyUp:ctrl+shift+p'));
check('nextcloud search -> focusAndSend(ctrl+f)', calls.includes('windows.focusAndSend:ctrl+f'));
check('nenhum perfil importa systemActions/hostExec', !/require\(['"]\.\.\/(actions\/systemActions|hostExec)['"]\)/.test(srcOfAllProfiles));
```

Para o Discord no teste, deixe o RPC indisponível (`rpcReady()` falso) para a ação cair no teclado.

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/profiles-platform.test.js`
Expected: FAIL (módulo `shortcuts` inexistente e perfis ainda chamando `SystemActions`).

- [ ] **Step 3: Implementar `platform/shortcuts.js` e alterar os cinco perfis**

Substituições: `SystemActions.focusAndSend(X, combo, delay)` → `this.ctx.platform.windows.focusAndSend(X, combo, delay)`;
`SystemActions.keyHold/keyRelease` → `platform.keys.keyDown/keyUp`; `SystemActions.sendKey` →
`platform.keys.shortcut`; `launchFile/flatpakInstalled/commandExists` → `platform.apps.*`;
`launch:browser` → `platform.apps.open('https://google.com')`; `launch:app:<id>` →
`platform.apps.launcher.launch(id)` (hoje `this.ctx.appLauncher.launch`, que a Task 6 mantém como alias).

- [ ] **Step 4: Rodar todos os unitários**

Run: `cd server && npm test`
Expected: todos os arquivos passam, inclusive `deck-pairing`, `auth`, `demand`, `hardware-vendors`.

- [ ] **Step 5: Commit**

```bash
git add server/src/platform/shortcuts.js server/src/profiles/*.js server/test/unit/profiles-platform.test.js
git commit -m "refactor(profiles): perfis usam a camada de plataforma e tabelas de atalhos por sistema"
```

---

### Task 6: `index.js` e `elgatoBridge` passam pela camada; status expõe a plataforma

**Files:**
- Modify: `server/src/index.js:16` (remover `require('./actions/systemActions')`), `:105-141` (instâncias),
  `:198-203` (`startTray`), `:276-290` (`getCapabilities`), `:797-811` (`/api/status`), linha com
  `SystemActions.hostVisibleTmpDir`, `shutdown` (parar `platform.tray`)
- Modify: `server/src/elgato/elgatoBridge.js:241` (`platform`), `:330` e `:613` (`xdg-open` → `openUrl`)
- Modify: `CHANGELOG.md` (seção "Não lançado")
- Test: `server/test/unit/elgato-platform.test.js`; `server/test/integration/auth-http.js` (já cobre `/api/status`:
  acrescentar um check de `platform`)

**Interfaces:**
- Consumes: `createPlatform()` da Task 4.
- Produces: em `index.js`, `this.platform = createPlatform()` criado antes dos módulos, com aliases que
  mantêm o resto do arquivo intacto: `this.hardwareMonitor = this.platform.hardware`,
  `this.audioMixer = this.platform.audio.mixer`, `this.spotify = this.platform.media.spotify`,
  `this.mediaPlayers = this.platform.media.players`, `this.windowDetector = this.platform.windows.detector`,
  `this.appLauncher = this.platform.apps.launcher`. `getCapabilities()` usa `this.platform.keys.*`.
  `/api/status` ganha `platform: this.platform.name`. `startTray(lanIp)` vira
  `this.platform.tray.start({ port: HTTP_PORT, lanIp, enabled: ui.tray !== false })` e o shutdown chama
  `this.platform.tray.stop()`. O log de início usa `this.platform.describe()`.
  `ElgatoBridge` recebe `opts.platformName` (`'linux'|'mac'`) e `opts.openUrl(url)`; `index.js` passa
  `platformName: this.platform.name === 'darwin' ? 'mac' : 'linux'` e `openUrl: (u) => this.platform.apps.open(u)`.

- [ ] **Step 1: Escrever o teste do Elgato**

```js
const b = new ElgatoBridge(0, { pluginsDir: tmp, saveKeySettings() {}, getDeviceSize: () => ({ columns: 5, rows: 3 }), platformName: 'mac', openUrl: (u) => opened.push(u) });
check('registerInfo usa platformName', b.registrationInfo().application.platform === 'mac');
check('openUrl é chamado no lugar do xdg-open', opened[0] === 'https://exemplo.com');
```

(`registrationInfo()` é o nome do método que monta o objeto da linha 241; se hoje for inline, extraia-o com
esse nome. Dispare o `openUrl` chamando o mesmo manipulador interno que as linhas 330/613 usam, com
`payload = { url: 'https://exemplo.com' }`.) Sem `platformName`, o padrão é `'linux'`; sem `openUrl`, nada
é aberto e um aviso vai para o log.

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/elgato-platform.test.js`
Expected: FAIL (`platform` ainda fixo em `'linux'`, `openUrl` ignorado).

- [ ] **Step 3: Implementar as mudanças no `elgatoBridge.js` e no `index.js`; acrescentar no
  `auth-http.js` o check `status.platform === 'linux'`; registrar no CHANGELOG em "Não lançado → Alterado":
  "Camada de plataforma (`server/src/platform/`) isola teclas, janelas, apps, áudio, mídia, hardware e
  bandeja; `GET /api/status` informa `platform`. Preparação para o macOS; sem mudança de comportamento no Linux."**

- [ ] **Step 4: Rodar unitários e integração**

Run: `cd server && npm test && npm run test:integration`
Expected: ambos terminam com "Todos os … passaram". Depois, iniciar o servidor de verdade
(`PORT=8899 MATDECK_DATA_DIR=/tmp/matdeck-f1 MATDECK_TRAY=0 node src/index.js`) e conferir no log a linha
`Sessão: Wayland KDE | teclas: ydotool | foco de janela: …` idêntica à de antes do refactor, e
`curl -s localhost:8899/api/status | grep -o '"platform":"linux"'`.

- [ ] **Step 5: Conferir que ninguém mais importa direto**

Run: `cd server && grep -rn "require('.*\(actions/systemActions\|hostExec\)')" src/index.js src/profiles/ src/elgato/elgatoBridge.js`
Expected: nenhuma linha.

- [ ] **Step 6: Commit**

```bash
git add server/src/index.js server/src/elgato/elgatoBridge.js server/test/unit/elgato-platform.test.js server/test/integration/auth-http.js CHANGELOG.md
git commit -m "refactor(server): index.js e ponte Elgato passam pela camada de plataforma; status expõe platform"
```

---

### Task 7: Roteiro manual no KDE e fechamento da fase

**Files:**
- Create: `docs/superpowers/plans/2026-10-24-macos-fase1-roteiro-kde.md`

- [ ] **Step 1: Escrever o roteiro (10 itens, cada um com o que fazer e o que esperar)**

Itens: PTT do Discord por teclado (segurar/soltar com RPC desligado), mute do Discord por RPC, `Ctrl+D` no
Meet com a aba certa e com outra aba na frente (deve recusar), `M` no Nextcloud Talk, "Mudo PC" e
"Volume +" na tela Principal, "Bloquear PC", "Abrir Discord" e "Abrir TeamSpeak", Auto-Perfil trocando ao
focar o OBS, ícone na bandeja com "Parar servidor", plugin Elgato que abre URL.

- [ ] **Step 2: Instalar o Flatpak local a partir da branch e o dono executar o roteiro**

Run: `./scripts/build-flatpak.sh` e depois `flatpak run br.com.matdeck.MatDeck`.
Expected: dono confirma os 10 itens; qualquer desvio volta para a task correspondente.

- [ ] **Step 3: Abrir o pull request `feat/macos-plataforma` → `main`** com o resumo das tasks e o resultado
  do roteiro; sem merge até o dono aprovar.
