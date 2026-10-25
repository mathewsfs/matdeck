# macOS fase 2: helper nativo e básico do macOS — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O servidor MatDeck sobe num macOS 14+ com um helper nativo em Swift e o deck funciona: teclas,
foco e janela ativa (Auto-Perfil), abrir aplicativos, volume master, bloquear tela e ícone na barra de menus.
Discord (IPC), OBS e TeamSpeak seguem iguais. Telemetria, Spotify e mídia ficam para a fase 3 (stubs aqui).

**Architecture:** `macos/MatDeckHelper` é um pacote SwiftPM com uma biblioteca `MatDeckHelperCore`
(protocolo e mapa de teclas, testável com `swift test`) e um executável empacotado como
`MatDeck Helper.app` (sem Dock, assinado ad hoc). Ele escuta num socket Unix e fala JSON por linha.
`server/src/platform/darwin/` implementa as mesmas áreas da fase 1 sobre um `HelperClient` (conecta,
relança o helper por `open -a` se precisar, reconecta com recuo). Testes no Linux usam
`server/test/fake-helper.js`, um servidor de socket que fala o protocolo. Validação real na VM
(`ssh mac`, macOS 15 Intel) por túnel SSH, e no Mac físico pelo dono.

**Tech Stack:** Swift 6.1 (Command Line Tools, sem Xcode), SwiftPM, AppKit, ApplicationServices
(Acessibilidade/CGEvent), CoreAudio, Carbon (`UCKeyTranslate`); Node.js 18+ CommonJS, `net` (socket Unix).

**Spec:** `docs/superpowers/specs/2026-10-24-macos-design.md` (§2 Helper, §5 Teclas e foco, §7 Instalação,
§8 Testes, fase 2).

## Global Constraints

- Sem dependências npm e sem pacotes Swift de terceiros. Node CommonJS; Swift 5.9+ (`swift-tools-version: 5.9`).
- Nenhum framework privado no caminho central (teclas, foco, apps, áudio, bandeja). SMC/HID só na fase 3.
- Permissões: Acessibilidade (obrigatória) e, na fase 3, Automação. Nunca Gravação de Tela.
- Helper assinado ad hoc com identificador `br.com.matdeck.helper`; `.app` com `LSUIElement = true`.
- Socket padrão: `<MATDECK_DATA_DIR>/helper.sock`; `MATDECK_HELPER_SOCKET` e `MATDECK_HELPER_APP` só para
  desenvolvimento e testes. Dados no Mac em `~/Library/Application Support/MatDeck`.
- Protocolo: uma mensagem JSON por linha (`\n`), UTF-8. Pedido `{id, op, args}`, resposta
  `{id, ok, result}` ou `{id, ok:false, error, message}`, evento `{event, data}`. Códigos de erro:
  `accessibility_denied`, `automation_denied`, `not_supported`, `not_running`, `bad_request`, `helper_timeout`.
- `npm test` continua passando no Linux sem helper real, e também na VM (`MATDECK_PLATFORM` explícito nos
  testes que dependem da plataforma).
- Linux não muda de comportamento (fase 1 intacta). Branch `feat/macos-helper`.
- Mensagens de log, commits e comentários em português; nomes de código em inglês.

## Review Focus

1. Helper caiu no meio de um PTT: `keys.keyUp` sem conexão devolve `false` e o cliente reconecta; nada fica
   preso. Teste em Task 2 (timeout/desconexão) e Task 3.
2. Permissão de Acessibilidade negada: toda operação de tecla/foco devolve `accessibility_denied` e o chip
   "Teclas" do gerenciador fica cinza com a dica certa. Testes em Task 3 e Task 8.
3. `windows.focus` com `requireTitle` e aba errada no navegador (Safari/Chrome): tenta a troca de aba por
   AppleScript; no Firefox devolve `false` sem enviar tecla. Teste em Task 4 (fake) e VM.
4. Linha de socket maior que 1 MiB ou JSON inválido vindo do helper: o cliente descarta a linha, loga uma
   vez e não derruba o servidor. Teste em Task 2.
5. Dois servidores apontando para o mesmo socket (um antigo que não saiu): o helper só aceita um cliente por
   vez e o segundo recebe `busy`; o cliente loga e tenta de novo. Teste em Task 1 (swift) e Task 2.

---

### Task 0: Ambiente na VM e suíte neutra de plataforma

**Files:**
- Create: `scripts/dev-mac-sync.sh`
- Modify: `server/test/unit/platform-select.test.js:20`, `server/test/unit/profiles-platform.test.js:11`,
  `server/test/unit/platform-keys.test.js`, `platform-apps-system.test.js`, `platform-windows.test.js`
  (fixar `process.env.MATDECK_PLATFORM = 'linux'` no topo: esses testes exercitam o adaptador Linux)

**Interfaces:**
- Produces: `scripts/dev-mac-sync.sh [host]` (padrão `mac`): instala Node LTS em `~/node` na VM se faltar
  (tarball oficial `node-v22.x-darwin-x64`, sem sudo), faz `rsync` do repositório para `~/matdeck`
  (excluindo `node_modules`, `.git`, `build`, `dist`, `.superpowers`), roda `npm ci --omit=dev` em
  `~/matdeck/server` e imprime a versão do Node e do Swift.

- [ ] **Step 1: Criar a branch**

```bash
git checkout -b feat/macos-helper
```

- [ ] **Step 2: Ajustar os testes da fase 1 para declararem a plataforma**

`platform-select.test.js` linha 20 passa a: `check('platformName segue process.platform', platformName() === (process.platform === 'darwin' ? 'darwin' : 'linux'))`
e o bloco "darwin provisório" continua. Nos outros quatro testes, `process.env.MATDECK_PLATFORM = 'linux';` logo após os `require` iniciais.

- [ ] **Step 3: Rodar a suíte no Linux**

Run: `cd server && npm test`
Expected: `Todos os 10 arquivos de teste passaram`.

- [ ] **Step 4: Escrever `scripts/dev-mac-sync.sh` e rodar**

Run: `./scripts/dev-mac-sync.sh`
Expected: imprime `node v22.x.x` e `Apple Swift version 6.1.2`; `ssh mac 'ls ~/matdeck/server/src/platform'` mostra `darwin`? (ainda não) e `linux`.

- [ ] **Step 5: Rodar a suíte na VM**

Run: `ssh mac 'cd ~/matdeck/server && PATH=$HOME/node/bin:$PATH npm test 2>&1 | tail -3'`
Expected: `Todos os 10 arquivos de teste passaram` (os testes do adaptador Linux rodam com o hostExec falso; `demand.test.js` pula o nvidia-smi).

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-mac-sync.sh server/test/unit/*.test.js
git commit -m "test: suíte declara a plataforma; script de sincronização com a VM do macOS"
```

---

### Task 1: Pacote Swift, protocolo e `hello`

**Files:**
- Create: `macos/MatDeckHelper/Package.swift`
- Create: `macos/MatDeckHelper/Sources/MatDeckHelperCore/Protocol.swift`
- Create: `macos/MatDeckHelper/Sources/MatDeckHelperCore/LineFramer.swift`
- Create: `macos/MatDeckHelper/Sources/MatDeckHelper/main.swift`
- Create: `macos/MatDeckHelper/Sources/MatDeckHelper/SocketServer.swift`
- Create: `macos/MatDeckHelper/Sources/MatDeckHelper/Dispatcher.swift`
- Create: `macos/MatDeckHelper/Resources/Info.plist`
- Create: `macos/MatDeckHelper/Tests/MatDeckHelperCoreTests/ProtocolTests.swift`
- Create: `scripts/build-macos-helper.sh`
- Create: `macos/README.md`

**Interfaces:**
- Produces (Core): `struct Request: Codable { id: Int; op: String; args: [String: JSONValue] }`,
  `enum Outgoing { case response(id:Int, ok:Bool, result:JSONValue?, error:String?, message:String?); case event(name:String, data:JSONValue) }`
  com `func encodeLine() -> String` (JSON + `\n`), `enum JSONValue: Codable` (null/bool/number/string/array/object),
  `struct LineFramer { mutating func feed(_ data: Data) -> [String] }` (corta por `\n`, descarta linha > 1 MiB
  com `droppedOversized += 1`), `enum HelperError: String { accessibility_denied, automation_denied, not_supported, not_running, bad_request, busy }`.
- Produces (executável): `matdeck-helper --socket <path>`; aceita **um** cliente por vez (segundo recebe
  `{"event":"busy","data":{}}` e é fechado); `hello` → `{version:"<CFBundleShortVersionString ou 0.0.0-dev>", pid, platform:{version, arch}, permissions:{accessibility:Bool}}`;
  `permissions.request {kind:"accessibility"}` → chama `AXIsProcessTrustedWithOptions` com prompt e devolve `{granted:Bool}`;
  op desconhecida → `bad_request`.
- `scripts/build-macos-helper.sh [--debug]`: `swift build -c release` em `macos/MatDeckHelper`, monta
  `macos/MatDeckHelper/dist/MatDeck Helper.app/Contents/{MacOS/matdeck-helper, Info.plist, Resources/}` e roda
  `codesign --force --sign - --identifier br.com.matdeck.helper`. Imprime o caminho do `.app`.
- `Info.plist`: `CFBundleIdentifier br.com.matdeck.helper`, `CFBundleName MatDeck Helper`, `LSUIElement true`,
  `CFBundleShortVersionString 1.5.0`, `NSAppleEventsUsageDescription` (texto para a fase 3), `LSMinimumSystemVersion 14.0`.

- [ ] **Step 1: Escrever `ProtocolTests.swift`**

```swift
func testDecodesRequestWithArgs() throws {
    let r = try Request.decode(line: #"{"id":7,"op":"key.shortcut","args":{"keys":["cmd","shift","m"]}}"#)
    XCTAssertEqual(r.id, 7); XCTAssertEqual(r.op, "key.shortcut")
    XCTAssertEqual(r.args["keys"]?.arrayValue?.compactMap { $0.stringValue }, ["cmd", "shift", "m"])
}
func testEncodesOkResponseOnOneLine() {
    let s = Outgoing.response(id: 1, ok: true, result: .object(["pid": .number(42)]), error: nil, message: nil).encodeLine()
    XCTAssertTrue(s.hasSuffix("\n")); XCTAssertEqual(s.filter { $0 == "\n" }.count, 1)
    XCTAssertTrue(s.contains(#""ok":true"#)); XCTAssertTrue(s.contains(#""pid":42"#))
}
func testEncodesErrorResponse() {
    let s = Outgoing.response(id: 2, ok: false, result: nil, error: "accessibility_denied", message: "Conceda em Ajustes", message: nil).encodeLine()
    XCTAssertTrue(s.contains(#""error":"accessibility_denied""#))
}
func testFramerSplitsAndKeepsRemainder() {
    var f = LineFramer()
    XCTAssertEqual(f.feed(Data("{\"a\":1}\n{\"b\"".utf8)), ["{\"a\":1}"])
    XCTAssertEqual(f.feed(Data(":2}\n".utf8)), ["{\"b\":2}"])
}
func testFramerDropsOversizedLine() {
    var f = LineFramer(); _ = f.feed(Data(repeating: 0x61, count: 1_048_577)); _ = f.feed(Data("\n{\"ok\":1}\n".utf8))
    XCTAssertEqual(f.droppedOversized, 1)
}
```

(Corrija a assinatura duplicada de `message:` no terceiro teste ao escrever: `error: "accessibility_denied", message: "Conceda em Ajustes"`.)

- [ ] **Step 2: Rodar na VM e ver falhar**

Run: `./scripts/dev-mac-sync.sh && ssh mac 'cd ~/matdeck/macos/MatDeckHelper && swift test 2>&1 | tail -5'`
Expected: erro de compilação por tipos inexistentes (`Request`, `Outgoing`, `LineFramer`).

- [ ] **Step 3: Implementar Core (`Protocol.swift`, `LineFramer.swift`), `SocketServer.swift` (socket Unix com
  `Darwin.socket/bind/listen/accept` + `DispatchSource.makeReadSource`, remove o arquivo de socket antigo ao
  subir, `chmod 600`), `Dispatcher.swift` (tabela `op -> handler`, `hello`, `permissions.request`), `main.swift`
  (`NSApplication.shared`, `setActivationPolicy(.accessory)`, parse de `--socket`, SIGTERM encerra limpo e apaga o socket).**

- [ ] **Step 4: Rodar `swift test` na VM**

Run: `./scripts/dev-mac-sync.sh && ssh mac 'cd ~/matdeck/macos/MatDeckHelper && swift test 2>&1 | tail -3'`
Expected: `Executed 5 tests, with 0 failures`.

- [ ] **Step 5: Construir o `.app` e falar com ele por `nc`**

Run: `ssh mac 'cd ~/matdeck && ./scripts/build-macos-helper.sh && (open -a "$PWD/macos/MatDeckHelper/dist/MatDeck Helper.app" --args --socket /tmp/mdh.sock; sleep 2; printf "{\"id\":1,\"op\":\"hello\",\"args\":{}}\n" | nc -U /tmp/mdh.sock -w 2; pkill -x matdeck-helper)'`
Expected: uma linha `{"id":1,"ok":true,"result":{"version":"1.5.0","pid":…,"platform":{"version":"15.8.1","arch":"x86_64"},"permissions":{"accessibility":false}}}`.

- [ ] **Step 6: Segundo cliente recebe `busy`**

Run: mesmo arranjo, abrindo dois `nc -U` em sequência sem fechar o primeiro (`sleep 3 | nc -U … &`).
Expected: o segundo imprime `{"event":"busy","data":{}}` e é desconectado.

- [ ] **Step 7: Commit**

```bash
git add macos scripts/build-macos-helper.sh
git commit -m "feat(macos): helper nativo com protocolo JSON por socket Unix, hello e permissões"
```

---

### Task 2: `HelperClient` em Node e helper falso

**Files:**
- Create: `server/src/platform/darwin/helperClient.js`
- Create: `server/test/fake-helper.js`
- Test: `server/test/unit/darwin-helper-client.test.js`

**Interfaces:**
- Produces: `class HelperClient extends EventEmitter` com `constructor({ socketPath, appPath, launch, requestTimeoutMs = 5000, backoffMs = [2000, 5000, 15000] })`,
  `start()`, `stop(): Promise`, `request(op, args = {}): Promise<result>` (rejeita com `Error` cujo `.code` é o
  código do helper ou `helper_timeout`/`not_connected`), `connected: boolean`, `hello: object|null`,
  eventos `connected`, `disconnected`, `event` (`{ event, data }`) e um evento por nome (`window.active`…).
  `launch` é uma função injetável `(appPath, socketPath) => void`; padrão: `spawn('open', ['-a', appPath, '--args', '--socket', socketPath])`.
  Reconexão: ao falhar `connect` (ENOENT/ECONNREFUSED) chama `launch` uma vez e tenta de novo com o recuo;
  ao receber `busy`, loga e tenta de novo no próximo recuo. Linha > 1 MiB ou JSON inválido: descarta, loga uma vez.
- `fake-helper.js`: `start({ socketPath, hello = {...}, handlers = {} }) -> { requests: [], emit(event, data), close(), disconnectClient(), setHandler(op, fn) }`;
  `handlers[op](args)` devolve `result` ou lança `{ code, message }`; por padrão responde `hello` e `bad_request`.

- [ ] **Step 1: Escrever o teste**

```js
check('conecta e faz hello', client.connected === true && client.hello.version === '9.9.9');
check('request devolve result', (await client.request('echo', { a: 1 })).a === 1);
check('erro do helper vira Error com code', err.code === 'accessibility_denied');
check('timeout vira helper_timeout', errT.code === 'helper_timeout');              // handler que nunca responde; requestTimeoutMs: 200
check('evento chega pelo nome', got.event === 'window.active' && got.data.app === 'Safari');
check('sem helper no socket chama launch e reconecta', launched === 1 && client.connected === true); // launch injetado sobe o fake
check('desconexão: request rejeita com not_connected e reconecta depois', errD.code === 'not_connected' && reconnected);
check('linha inválida não derruba', client.connected === true);                   // fake envia "lixo\n" e um objeto de 2 MiB
check('busy: loga e tenta de novo', ...);                                          // fake com segundo cliente simulado
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && node test/unit/darwin-helper-client.test.js`
Expected: FAIL por módulo inexistente.

- [ ] **Step 3: Implementar `helperClient.js` e `fake-helper.js`**

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && node test/unit/darwin-helper-client.test.js`
Expected: todas `OK`.

- [ ] **Step 5: Commit**

```bash
git add server/src/platform/darwin/helperClient.js server/test/fake-helper.js server/test/unit/darwin-helper-client.test.js
git commit -m "feat(platform): cliente do helper do macOS com reconexão e helper falso para testes"
```

---

### Task 3: Teclas (CGEvent) — helper e `darwin/keys.js`

**Files:**
- Create: `macos/MatDeckHelper/Sources/MatDeckHelperCore/KeyCombo.swift`
- Create: `macos/MatDeckHelper/Sources/MatDeckHelper/Services/KeyService.swift`
- Create: `macos/MatDeckHelper/Tests/MatDeckHelperCoreTests/KeyComboTests.swift`
- Create: `server/src/platform/darwin/keys.js`
- Test: `server/test/unit/darwin-keys.test.js`

**Interfaces:**
- Core: `struct KeyCombo { modifiers: Set<Modifier>; key: String? }`, `enum Modifier { cmd, ctrl, alt, shift }`,
  `static func parse(_ names: [String]) -> KeyCombo?` (aceita `cmd/super/meta/win/command`, `ctrl/control`,
  `alt/option`, `shift`; o resto é tecla; nomes especiais: `escape/esc, return/enter, tab, space, backspace,
  delete, up, down, left, right, home, end, pageup, pagedown, f1…f12, slash, comma, period, minus, equal,
  semicolon, apostrophe, bracketleft, bracketright, backslash, grave`), `static func specialKeyCode(_ name: String) -> CGKeyCode?`
  (tabela `kVK_*`: escape 53, return 36, tab 48, space 49, delete/backspace 51, forwarddelete 117, up 126, down 125, left 123, right 124, home 115, end 119, pageup 116, pagedown 121, f1 122, f2 120, f3 99, f4 118, f5 96, f6 97, f7 98, f8 100, f9 101, f10 109, f11 103, f12 111).
- Helper: `KeyService` com `keyCode(forCharacter:)` via `TISCopyCurrentKeyboardLayoutInputSource` + `UCKeyTranslate`
  (varre keycodes 0…127 uma vez por layout e guarda `Character -> CGKeyCode`), ops:
  `key.shortcut {keys:[String]}` (down dos modificadores + tecla, up em ordem inversa, `CGEvent.post(tap: .cghidEventTap)`),
  `key.down {keys}`, `key.up {keys}`, `key.media {name: "play_pause"|"next"|"prev"|"vol_up"|"vol_down"|"mute"}`
  (`NSEvent.otherEvent(with: .systemDefined, subtype: 8, data1: (NX_KEYTYPE_* << 16) | (down ? 0xA << 8 : 0xB << 8))`).
  Sem Acessibilidade: `accessibility_denied` antes de postar. Tecla desconhecida: `bad_request`.
- Node: `createKeys(client) -> { shortcut(combo), keyDown(combo), keyUp(combo), mediaKey(name), capabilities(force?), capabilitiesStale(), capabilitiesCached(), hostVisibleTmpDir() }`.
  `combo` string `ctrl+shift+m` → `keys: ['ctrl','shift','m']`. Devolve `false` em qualquer erro (loga uma vez por código).
  `capabilities()` → `{ platform:'darwin', helper: client.connected, accessibility, automation:false, keysReady: helper && accessibility, wayland:false, ydotool:false, xdotool:false, kdotool:false, desktop:'macOS' }`.

- [ ] **Step 1: Escrever `KeyComboTests.swift`**

```swift
func testParsesModifiersAndKey() { let c = KeyCombo.parse(["cmd","shift","m"])!; XCTAssertEqual(c.modifiers, [.cmd,.shift]); XCTAssertEqual(c.key, "m") }
func testAcceptsLinuxAliases() { XCTAssertEqual(KeyCombo.parse(["super","alt","x"])!.modifiers, [.cmd,.alt]) }
func testSpecialKeys() { XCTAssertEqual(KeyCombo.specialKeyCode("escape"), 53); XCTAssertEqual(KeyCombo.specialKeyCode("f11"), 103); XCTAssertNil(KeyCombo.specialKeyCode("ç")) }
func testModifierOnlyCombo() { let c = KeyCombo.parse(["ctrl"])!; XCTAssertNil(c.key) }
```

- [ ] **Step 2: Escrever `darwin-keys.test.js`** (fake-helper com `hello.permissions.accessibility = true`)

```js
check('shortcut manda key.shortcut com lista', req.op === 'key.shortcut' && JSON.stringify(req.args.keys) === '["ctrl","shift","m"]');
check('keyDown/keyUp', reqs.map(r => r.op).join(',') === 'key.down,key.up');
check('mediaKey play_pause', req.op === 'key.media' && req.args.name === 'play_pause');
check('accessibility_denied devolve false', (await keys.shortcut('cmd+d')) === false);   // handler lança { code: 'accessibility_denied' }
check('helper desconectado: keyUp devolve false sem lançar', (await keys.keyUp('cmd+shift+p')) === false);
check('capabilities expõe helper/accessibility/keysReady', caps.platform === 'darwin' && caps.keysReady === true);
```

- [ ] **Step 3: Rodar os dois e ver falhar** (`swift test` na VM; `node test/unit/darwin-keys.test.js`)

- [ ] **Step 4: Implementar Core, `KeyService.swift` (registrar as ops no `Dispatcher`) e `darwin/keys.js`**

- [ ] **Step 5: Rodar e ver passar**: `swift test` → `0 failures`; `node test/unit/darwin-keys.test.js` → todas `OK`.

- [ ] **Step 6: Ponta a ponta na VM (precisa da permissão de Acessibilidade concedida pelo dono via VNC na primeira vez)**

Run: na VM, abrir o TextEdit (`open -a TextEdit`), subir o helper, e por `nc -U` mandar
`{"id":1,"op":"key.shortcut","args":{"keys":["cmd","n"]}}` e depois `{"id":2,"op":"key.shortcut","args":{"keys":["a"]}}`;
ler o texto com `osascript -e 'tell application "TextEdit" to get text of document 1'`.
Expected: `a`. Sem a permissão: resposta `accessibility_denied` e o helper mostra o diálogo do sistema.

- [ ] **Step 7: Commit**

```bash
git add macos server/src/platform/darwin/keys.js server/test/unit/darwin-keys.test.js
git commit -m "feat(macos): teclas por CGEvent com layout do sistema; adaptador de teclas do macOS"
```

---

### Task 4: Janelas — janela ativa, título por Acessibilidade e foco (com abas)

**Files:**
- Create: `macos/MatDeckHelper/Sources/MatDeckHelper/Services/WindowService.swift`
- Create: `macos/MatDeckHelper/Sources/MatDeckHelper/Services/BrowserTabs.swift`
- Create: `server/src/platform/darwin/windows.js`
- Create: `server/src/platform/darwin/bundleIds.js`
- Test: `server/test/unit/darwin-windows.test.js`

**Interfaces:**
- Helper ops: `window.active` → `{app, bundleId, pid, title}`; `window.subscribe {on:Bool}` liga
  `NSWorkspace.didActivateApplicationNotification` + `AXObserver` (`kAXFocusedWindowChangedNotification`,
  `kAXTitleChangedNotification`) no app da frente → eventos `window.active {app,bundleId,pid,title}`;
  `window.focus {bundleIds:[String], names:[String], titleHints:[String], requireTitle:Bool}` → `{focused:Bool, how:"window"|"tab"|"app"}`:
  para cada app em execução que case (`bundleId` na lista ou `localizedName` em `names`, sem diferenciar
  maiúsculas): lê os títulos das janelas (`kAXWindowsAttribute` → `kAXTitleAttribute`); janela cujo título
  contém um hint → `AXRaise` + `activate` (`how:"window"`); se nenhuma e o app é Safari/Chrome/Brave/Edge →
  `BrowserTabs.activateTab(bundleId, containing:)` por `NSAppleScript` (`how:"tab"`); se `requireTitle` e nada casou → `focused:false`;
  sem `requireTitle` e sem hint casando → ativa o app (`how:"app"`). Sem Acessibilidade → `accessibility_denied`.
- `bundleIds.js`: `CLASS_TO_BUNDLE = { discord:'com.hnc.Discord', 'com.discordapp.discord':'com.hnc.Discord', 'brave-browser':'com.brave.Browser', 'google-chrome':'com.google.Chrome', chromium:'org.chromium.Chromium', firefox:'org.mozilla.firefox', 'org.mozilla.firefox':'org.mozilla.firefox', 'microsoft-edge':'com.microsoft.edgemac', vivaldi:'com.vivaldi.Vivaldi', obs:'com.obsproject.obs-studio', 'com.obsproject.studio':'com.obsproject.obs-studio', spotify:'com.spotify.client', 'com.spotify.client':'com.spotify.client', teamspeak:'com.teamspeak.TeamSpeak', 'com.teamspeak.teamspeak':'com.teamspeak.TeamSpeak', 'com.nextcloud.talk':'com.nextcloud.talk.mac' }`
  e `BUNDLE_TO_PROFILE = { 'com.hnc.Discord':'discord', 'com.obsproject.obs-studio':'obs', 'com.spotify.client':'spotify', 'com.teamspeak.TeamSpeak':'teamspeak', 'com.nextcloud.talk.mac':'nextcloud' }`
  (ids de TeamSpeak e Nextcloud Talk **a confirmar no Mac físico**; comentar isso no arquivo).
- Node: `createWindows(client) -> { detector, focus(target), focusAndSend(target, combo, delayMs), matchProfile(title, app), DETECTABLE_APPS }`.
  `detector` é um `EventEmitter` com `start()`, `stop()`, `setEnabled(flag)`, `lastDetected`, `describe()`
  (`'helper (NSWorkspace + Acessibilidade)'` ou `'INDISPONÍVEL'`), `enabled`; ao ligar manda `window.subscribe {on:true}` e
  traduz cada `window.active` em `evaluateWindow(title, bundleId)` → `emit('windowChanged', { title, app: bundleId, profile })`.
  `matchProfile(title, app)`: `BUNDLE_TO_PROFILE[app]` primeiro, depois as `TITLE_RULES` do Linux
  (reutilizar `WindowDetector.matchProfile(title, '')` para o título). `focus(target)` traduz `classHints` por
  `CLASS_TO_BUNDLE` (o que não tiver tradução vai em `names`).

- [ ] **Step 1: Escrever `darwin-windows.test.js`**

```js
check('subscribe ao ligar', reqs.some(r => r.op === 'window.subscribe' && r.args.on === true));
fake.emit('window.active', { app: 'Discord', bundleId: 'com.hnc.Discord', pid: 1, title: 'Geral - Discord' });
check('evento vira windowChanged com perfil discord', changed.profile === 'discord' && changed.app === 'com.hnc.Discord');
fake.emit('window.active', { app: 'Brave Browser', bundleId: 'com.brave.Browser', pid: 2, title: 'Reunião - Meet - Brave' });
check('título do Meet casa por regra de título', changed.profile === 'meet');
check('focus traduz classHints para bundleIds', req.op === 'window.focus' && req.args.bundleIds.includes('com.brave.Browser') && req.args.titleHints[0] === 'Meet' && req.args.requireTitle === true);
check('focus devolve false quando helper diz focused:false', ok === false);
check('focusAndSend não envia tecla se não focou', !reqs.some(r => r.op === 'key.shortcut'));
check('focusAndSend envia depois de focar', reqs.map(r => r.op).slice(-2).join(',') === 'window.focus,key.shortcut');
check('setEnabled(false) manda subscribe off', reqs.some(r => r.op === 'window.subscribe' && r.args.on === false));
```

- [ ] **Step 2: Rodar e ver falhar** → **Step 3: Implementar `WindowService.swift`, `BrowserTabs.swift`, `bundleIds.js`, `darwin/windows.js`** → **Step 4: Rodar e ver passar** (`node test/unit/darwin-windows.test.js`; `swift build` na VM sem erros).

- [ ] **Step 5: Ponta a ponta na VM**

Run: helper no ar com `window.subscribe {on:true}` por `nc -U` mantido aberto; `open -a Safari` e depois `open -a TextEdit`.
Expected: dois eventos `window.active` com `bundleId` `com.apple.Safari` e `com.apple.TextEdit` e `title` preenchido. Depois,
`window.focus {"bundleIds":["com.apple.Safari"],"titleHints":["Apple"],"requireTitle":true}` com a página apple.com aberta no Safari → `{"focused":true,"how":"window"|"tab"}`; com `titleHints:["xyz-inexistente"]` → `focused:false`.

- [ ] **Step 6: Commit**

```bash
git add macos server/src/platform/darwin/windows.js server/src/platform/darwin/bundleIds.js server/test/unit/darwin-windows.test.js
git commit -m "feat(macos): janela ativa e foco por Acessibilidade, abas por AppleScript; adaptador de janelas"
```

---

### Task 5: Aplicativos — lista, ícones e abertura

**Files:**
- Create: `macos/MatDeckHelper/Sources/MatDeckHelper/Services/AppsService.swift`
- Create: `server/src/platform/darwin/apps.js`
- Test: `server/test/unit/darwin-apps.test.js`

**Interfaces:**
- Helper ops: `apps.list` → `{apps:[{id: bundleId|path, name, path}]}` varrendo `/Applications`, `~/Applications`,
  `/System/Applications` e `/System/Applications/Utilities` (profundidade 1, `.app`), nome por
  `CFBundleDisplayName`/`CFBundleName`/nome do arquivo; `apps.icon {id}` → `{png: base64}` 64×64 por
  `NSWorkspace.shared.icon(forFile:)` + `NSBitmapImageRep`; `apps.launch {id}` → `NSWorkspace.shared.openApplication(at:)`
  → `{launched:Bool}`; `apps.open {target}` → `NSWorkspace.shared.open(URL)` (URL http/https/esquema ou caminho) → `{opened:Bool}`.
- Node `createApps(client) -> { launcher, open(target), launchFile(bin, args), launchFirst(candidates, label), flatpakInstalled(id), commandExists(bin) }`.
  `launcher` tem a forma do `AppLauncher`: `list(force)` (cache 10 min), `summaries()`, `iconOf(id)` → `{ mime:'image/png', buffer }` (ícones pedidos ao helper sob demanda e guardados),
  `iconDataUrl(id)`, `launch(id)`, `reload()`. `open(target)` → `apps.open`. `launchFile(bin, args)`: `xdg-open` → `open(args[0])`;
  `flatpak` → `false`; outro nome → `apps.launch` pelo nome (procura em `list()` por nome sem diferenciar maiúsculas) ou `false`.
  `launchFirst(candidates, label)`: `label` `calculadora` → `apps.launch com.apple.calculator`, `terminal` → `com.apple.Terminal`, outros → `false` com log.
  `flatpakInstalled` → `false`; `commandExists` → `false`.

- [ ] **Step 1: Escrever `darwin-apps.test.js`** (fake com handler `apps.list` devolvendo Safari e Calculadora; `apps.icon` devolvendo um PNG 1×1 em base64)

```js
check('list devolve resumos ordenados com iconUrl', apps[0].name === 'Calculadora' && apps[0].iconUrl === '/api/apps/com.apple.calculator/icon');
check('iconOf pede ao helper uma vez e guarda', icon.mime === 'image/png' && icon.buffer.length > 0 && reqs.filter(r => r.op === 'apps.icon').length === 1);
check('launch manda apps.launch', req.op === 'apps.launch' && req.args.id === 'com.apple.Safari');
check('open manda apps.open', req.op === 'apps.open' && req.args.target === 'https://google.com');
check('launchFile xdg-open vira open', req.op === 'apps.open' && req.args.target === 'discord://');
check('launchFirst calculadora vira Calculator', req.op === 'apps.launch' && req.args.id === 'com.apple.calculator');
check('flatpakInstalled/commandExists são false', (await apps.flatpakInstalled('x')) === false && apps.commandExists('discord') === false);
```

- [ ] **Step 2: Rodar e ver falhar** → **Step 3: Implementar** → **Step 4: Rodar e ver passar**.

- [ ] **Step 5: VM**: `apps.list` por `nc` lista `com.apple.Safari` e `com.apple.TextEdit`; `apps.icon {"id":"com.apple.Safari"}` devolve base64 que, decodificado, começa com `89504E47` (PNG).

- [ ] **Step 6: Commit** — `git commit -m "feat(macos): lista de aplicativos, ícones e abertura; adaptador de apps do macOS"`

---

### Task 6: Volume master (CoreAudio), sessão e mixer com faders indisponíveis

**Files:**
- Create: `macos/MatDeckHelper/Sources/MatDeckHelper/Services/AudioService.swift`
- Create: `server/src/platform/darwin/audio.js`
- Create: `server/src/platform/darwin/session.js`
- Modify: `server/src/index.js` (`statUpdateFor`/fader: tecla `vol_slider:<app>` com `available === false` ganha `badge: 'n/d'` e ignora `setVolume`/`toggleMute`), `server/web/app.js` (toque em fader `n/d` não muda o valor; regenerar `app.legacy.js`)
- Test: `server/test/unit/darwin-audio.test.js`

**Interfaces:**
- Helper ops: `audio.master.get` → `{volume: 0-100, muted: Bool}` (dispositivo de saída padrão:
  `kAudioHardwarePropertyDefaultOutputDevice`; volume por `kAudioDevicePropertyVolumeScalar` no elemento
  principal ou média dos canais 1 e 2; mudo por `kAudioDevicePropertyMute`), `audio.master.set {volume}`,
  `audio.master.mute {muted}`; `audio.master.subscribe {on}` instala `AudioObjectAddPropertyListenerBlock` e emite
  `audio.master {volume, muted}` a cada mudança. Dispositivo sem controle de volume → `not_supported`.
- Node `createAudio(client) -> { mixer, masterStep(delta), masterMuteToggle() }`; `mixer` é um `EventEmitter`
  com a forma do `AudioMixer`: `appStates` com `master` (`available:true`) e `discord, teamspeak, obs, browser, spotify, game`
  (`available:false`, volume 0, muted false), `getAll()`, `appState(id)`, `setVolume(id, v)`, `adjustVolume(id, d)`,
  `toggleMute(id)`, `stop()`, evento `volumeChange`. Só `master` fala com o helper; os outros devolvem sem fazer nada.
  Ao conectar, faz `audio.master.get` + `subscribe {on:true}`.
- `createSession(keys) -> { lock() }`: `keys.shortcut('ctrl+cmd+q')` (bloqueio de tela do macOS, sem SPI).
- `index.js`: no `volumeChange` e no `updateKey` dos faders, se `state.available === false` → `badge: 'n/d'`,
  `sliderValue: 0`, `badgeColor: '#6B7280'`; o manipulador `setVolume`/`toggleMute` do WebSocket ignora apps com `available === false`.

- [ ] **Step 1: Escrever `darwin-audio.test.js`**

```js
check('ao conectar lê master e assina', reqs.map(r => r.op).includes('audio.master.get') && reqs.some(r => r.op === 'audio.master.subscribe'));
check('estado inicial do master vem do helper', mixer.getAll().master.volume === 37 && mixer.getAll().master.muted === false);
check('setVolume master manda audio.master.set', req.op === 'audio.master.set' && req.args.volume === 55);
check('toggleMute master manda audio.master.mute', req.op === 'audio.master.mute' && req.args.muted === true);
check('evento audio.master vira volumeChange', ev.appId === 'master' && ev.volume === 20);
check('discord é indisponível e setVolume não chama o helper', mixer.getAll().discord.available === false && !reqs.some(r => r.op === 'audio.master.set' && r.args.volume === 10));
check('masterStep(+5) soma ao valor atual', req.args.volume === 25);
check('lock manda ctrl+cmd+q', req.op === 'key.shortcut' && req.args.keys.join('+') === 'ctrl+cmd+q');
```

E no Linux (`platform-apps-system.test.js` ou novo check em `profiles-platform.test.js`): nenhuma mudança de comportamento dos faders.

- [ ] **Step 2: Rodar e ver falhar** → **Step 3: Implementar** (`AudioService.swift`, `darwin/audio.js`, `darwin/session.js`, mudança mínima em `index.js`/`app.js` com `cd scripts/legacy-build && npm run build`) → **Step 4: Rodar e ver passar** + `npm test` inteiro.

- [ ] **Step 5: VM**: `audio.master.set {"volume":50}` depois `audio.master.get` → `volume:50`; `osascript -e 'output volume of (get volume settings)'` → `50`.

- [ ] **Step 6: Commit** — `git commit -m "feat(macos): volume master por CoreAudio, bloqueio de tela e faders indisponíveis marcados n/d"`

---

### Task 7: Barra de menus

**Files:**
- Create: `macos/MatDeckHelper/Sources/MatDeckHelper/Services/TrayService.swift`
- Create: `macos/MatDeckHelper/Resources/menubar-icon.png` (template 18×18 e @2x, preto com alpha; gerar a partir de `flatpak/` ou `server/web/` ícone existente com `magick`)
- Create: `server/src/platform/darwin/tray.js`
- Test: `server/test/unit/darwin-tray.test.js`

**Interfaces:**
- Helper ops: `tray.set {visible:Bool, tooltip:String, state:"green"|"amber"|"gray", items:[{id,label}]}` cria/atualiza
  um `NSStatusItem` (ícone template + ponto colorido desenhado por cima; `isTemplate` só no ícone), menu com os
  `items` e um separador; clique num item → evento `tray.menu {id}`; clique no ícone (sem menu) → `tray.click`.
- Node `createTray(client, { openUrl }) -> { start({ port, lanIp, enabled }), update({ clients, tsConnected }), stop() }`:
  `start` manda `tray.set` com `tooltip: 'MatDeck · http://<lanIp>:<port>'`, `state: 'amber'`, itens
  `manage` "Abrir gerenciador", `deck` "Abrir deck", `stop` "Parar servidor", `hide` "Ocultar ícone";
  `tray.menu manage` → `openUrl('http://localhost:<port>/manage')`, `deck` → `openUrl('http://localhost:<port>/')`,
  `stop` → `http.request POST http://127.0.0.1:<port>/api/shutdown`, `hide` → `tray.set {visible:false}`.
  `update({clients})` → `state` `green` se `clients > 0` senão `amber`. `stop()` → `tray.set {visible:false}`.
  `index.js` passa a chamar `this.platform.tray.update({ clients: this.clients.size })` quando um cliente entra/sai
  (no Linux a função existe e não faz nada: o PySide6 já sonda `/api/status`).

- [ ] **Step 1: Escrever `darwin-tray.test.js`**

```js
check('start manda tray.set visível com 4 itens', req.op === 'tray.set' && req.args.visible === true && req.args.items.length === 4 && /8899/.test(req.args.tooltip));
check('update com cliente fica verde', req.args.state === 'green');
check('menu manage abre o gerenciador', opened[0] === 'http://localhost:8899/manage');
check('menu stop chama POST /api/shutdown', shutdownCalls === 1);     // servidor http de teste em 8899
check('stop esconde o ícone', req.args.visible === false);
```

- [ ] **Step 2: Rodar e ver falhar** → **Step 3: Implementar** → **Step 4: Rodar e ver passar**.

- [ ] **Step 5: VM**: `tray.set` por `nc` → o dono confirma pelo VNC que o ícone aparece com o menu; clicar em "Abrir deck" gera `{"event":"tray.menu","data":{"id":"deck"}}` no `nc`.

- [ ] **Step 6: Commit** — `git commit -m "feat(macos): ícone na barra de menus com estado e menu; adaptador da bandeja"`

---

### Task 8: Montagem `platform/darwin/index.js`, stubs da fase 3, chips e servidor na VM

**Files:**
- Create: `server/src/platform/darwin/index.js`
- Create: `server/src/platform/darwin/stubs.js`
- Modify: `server/src/platform/index.js` (`darwin` real; remover a camada provisória), `server/src/platform/README.md`,
  `server/src/platform/linux/keys.js` (`capabilities()` ganha `keysReady`), `server/web/manage.js` (chip "Teclas" usa
  `caps.keysReady` quando definido; dica: `'Conceda Acessibilidade ao MatDeck Helper em Ajustes do Sistema'` no Mac),
  `server/src/index.js` (`tray.update` ao entrar/sair cliente; `MATDECK_DATA_DIR` padrão `~/Library/Application Support/MatDeck` quando `process.platform === 'darwin'` e a variável não está definida; o mesmo em `config.js` e `presetManager.js` via um `dataDir()` em `server/src/paths.js`)
- Create: `server/src/paths.js`
- Test: `server/test/unit/darwin-platform.test.js`, `server/test/integration/darwin-vm.js` (roda só com `MATDECK_VM_HOST`)

**Interfaces:**
- `createDarwin(options) -> Platform` com `name:'darwin'`, `keys`, `windows`, `apps`, `audio`, `media` (stubs:
  `spotify` e `players` são `EventEmitter` com `start/stop/setActive` sem efeito, `snapshot()` → `{ available:false }`,
  `artOf()` → `null`, `resolve()` → `null`), `hardware` (stub com `currentStats` zerado e `available:false` na GPU,
  `start/stop/setActive/currentInterval` e evento `stats` a cada intervalo com os zeros), `tray`, `session`,
  `helper` (o `HelperClient`), `describe()` → `'Sessão: macOS <versão> | helper: conectado|ausente | Acessibilidade: ok|NEGADA'`.
  `createPlatform()` em `platform/index.js` chama `createDarwin` quando `platformName() === 'darwin'`.
- `paths.js`: `dataDir()` → `MATDECK_DATA_DIR` ou, no darwin, `~/Library/Application Support/MatDeck`, senão `server/data`.
- `darwin-vm.js`: com `MATDECK_VM_HOST=mac`, sincroniza, sobe o servidor na VM (`PORT=8899 MATDECK_TRAY=0` por `ssh -f`), abre túnel
  `ssh -L 18899:127.0.0.1:8899`, conecta um WebSocket em `ws://127.0.0.1:18899/deck` (loopback na VM = confiável), confere
  `profileList`, pede `GET /api/status` (`platform === 'darwin'`, `capabilities.helper === true`), lista `/api/apps` (contém `com.apple.Safari`),
  manda `keyDown`/`keyUp` numa tecla `launch:app:com.apple.TextEdit` e confere por `ssh mac 'pgrep -x TextEdit'`; encerra por `POST /api/shutdown`.

- [ ] **Step 1: Escrever `darwin-platform.test.js`** (`MATDECK_PLATFORM=darwin`, `MATDECK_HELPER_SOCKET` apontando para o fake)

```js
check('createPlatform devolve darwin com helper conectado', p.name === 'darwin' && p.helper.connected === true);
check('áreas presentes', ['keys','windows','apps','audio','media','hardware','tray','session'].every(k => p[k]));
check('stubs de mídia e hardware respondem', p.media.spotify.snapshot().available === false && p.hardware.currentStats.gpu.available === false);
check('describe menciona helper e Acessibilidade', /helper: conectado/.test(p.describe()) && /Acessibilidade: ok/.test(p.describe()));
check('dataDir no darwin é Application Support', /Library\/Application Support\/MatDeck$/.test(dataDir()));
check('linux: keysReady acompanha ydotool', linuxCaps.keysReady === true);
```

- [ ] **Step 2: Rodar e ver falhar** → **Step 3: Implementar** → **Step 4: `npm test` inteiro passa no Linux e na VM**.

- [ ] **Step 5: Servidor na VM de ponta a ponta**

Run: `cd server && MATDECK_VM_HOST=mac node test/integration/darwin-vm.js`
Expected: todos `OK`, e o log do servidor na VM mostra `Sessão: macOS 15.8.1 | helper: conectado | Acessibilidade: ok`.

- [ ] **Step 6: Commit**

```bash
git add server/src/platform server/src/paths.js server/src/index.js server/src/config.js server/src/presetManager.js server/web/manage.js server/test
git commit -m "feat(platform): macOS completo na camada (helper, teclas, janelas, apps, áudio, bandeja) com stubs de mídia e telemetria"
```

---

### Task 9: Documentação, roteiro e pull request

**Files:**
- Modify: `README.md` (seção "macOS (beta)": requisitos, `scripts/build-macos-helper.sh`, permissões, o que ainda falta),
  `CHANGELOG.md` ("Não lançado → Adicionado"), `ROADMAP.md` (1.5 = macOS; a lista antiga passa para 1.6; fase 2 marcada),
  `docs/superpowers/plans/2026-10-24-macos-fase1-roteiro-kde.md` (linha "Resultado": aprovado pelo dono em 24/10/2026, 11/11)
- Create: `docs/superpowers/plans/2026-10-24-macos-fase2-roteiro-mac.md` (roteiro para o Mac físico: permissão, teclas no Discord, Meet no Safari e no Chrome, abrir apps, volume, bloquear, barra de menus, Auto-Perfil)

- [ ] **Step 1: Escrever os documentos** → **Step 2: `npm test`** → **Step 3: Commit** (`docs: macOS beta no README, ROADMAP 1.5/1.6, roteiros`) → **Step 4: `git push -u origin feat/macos-helper` e PR para `main`** com o resultado da VM; merge só depois do roteiro no Mac físico.
