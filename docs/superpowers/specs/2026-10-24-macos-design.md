# MatDeck no macOS 14+ — design

Data: 2026-10-24. Estado: **aprovado pelo dono** (revisado por um "builder check"; respostas incorporadas).
Decisões tomadas por mim na revisão estão marcadas *(decisão minha)*.

## Intenção

O MatDeck roda hoje só em Linux (Fedora/KDE Wayland, Flatpak). O usuário tem um Mac e quer o mesmo
cenário lá: o tablet controla TeamSpeak, Discord, Google Meet, Nextcloud Talk, OBS, Spotify, volume e
telemetria do PC. O deck no tablet, o emparelhamento por PIN, o protocolo WebSocket e os presets não
mudam: o que muda é a camada que fala com o sistema operacional, que hoje chama `ydotool`, `kdotool`,
`pactl`, `busctl`, scripts do KWin e lê `/sys` direto de dentro dos módulos.

Por que agora: o projeto acabou de ser publicado e o Linux está estável (1.4.0-beta.1). A versão macOS
tem como ser testada: o usuário tem um Mac físico com macOS 14+ e uma VM de macOS 15 em podman
(`dockurr/macos`) nesta máquina, acessível por VNC em `localhost:5900` e, com o Login Remoto ativo, por
SSH via `podman exec macos nc 127.0.0.1 22` (chave em `~/.ssh/matdeck-macvm`).

## Objetivos

- Servidor MatDeck rodando nativamente em macOS 14 (Sonoma) ou mais novo, Intel e Apple Silicon.
- Paridade funcional com o Linux onde o macOS permite: teclas/atalhos, foco de janela, abrir aplicativos,
  Auto-Perfil, volume master e mudo, telemetria (CPU, GPU, RAM, rede, disco, temperaturas quando houver
  sensor), Spotify, mídia do sistema, ícone na barra de menus, início automático, bloquear a tela.
- Integrações que já são multiplataforma continuam iguais: Discord (IPC), OBS (WebSocket), TeamSpeak
  (Remote Apps / ClientQuery), Nextcloud Talk e Google Meet (foco + atalhos).
- Gerenciador no navegador com **tema macOS** quando o servidor roda no Mac: tipografia do sistema
  (San Francisco via `-apple-system`), barra de ferramentas clara, controles no estilo do sistema,
  claro/escuro seguindo a preferência do Mac. Mesmo DOM, mesmas funções, só a pele muda.
- Instalação sem conta de desenvolvedor: script ou Homebrew, binário construído na máquina.
- O Linux não regride: comportamento idêntico, verificado por testes novos escritos antes do refactor.

## Não objetivos

- Volume por aplicativo em geral (o macOS não expõe sem driver de terceiros). No Mac o mixer tem só
  `master` e `spotify` (volume do próprio app, por AppleScript); os outros faders aparecem como
  indisponíveis.
- Ventoinhas (CoolerControl é Linux). Uso de IA não é meta, mas só lê arquivos e deve funcionar sem mudança.
- App notarizado, Mac App Store, janela nativa para o gerenciador, Electron, Windows.

## Anti-objetivos (o que tornaria isto um fracasso)

- Quebrar ou complicar o caminho Linux para acomodar o Mac.
- Depender de framework privado **sem fallback**. Esclarecimento *(decisão minha)*: ler sensores por
  SMC/HID (não documentados) é aceitável porque a falha vira `null` e a tecla mostra "--", como no Linux
  sem sensor. O que fica proibido é funcionalidade central (teclas, foco, mídia) em cima de SPI.
- Pedir permissões além do necessário. As permissões são três: **Acessibilidade** (teclas, foco, título
  da janela ativa), **Automação** (Apple Events para Spotify e Music) e, opcional, nenhuma outra.
  Gravação de Tela **não** é necessária: o título da janela vem pela API de Acessibilidade
  (`kAXFocusedWindow` → `kAXTitle`, com `AXObserver` para mudanças), não por `CGWindowList`.
- Adicionar dependências npm. O lado nativo é Swift puro, sem pacotes de terceiros.

## Restrições

- Servidor em Node.js CommonJS, sem transpilação; deck continua ES5 após o build legado.
- Testes sem navegador; a camada macOS precisa ser testável no Linux com um helper falso.
- Node 18+ no Mac (Homebrew). Helper em Swift 5.9+ compilado com as Xcode Command Line Tools (SwiftPM,
  sem projeto Xcode).
- Sem conta de desenvolvedor: assinatura **ad hoc** (em Apple Silicon o linker já assina assim) com
  identificador fixo `br.com.matdeck.helper`. Consequência aceita: a permissão de Acessibilidade está
  presa ao hash do binário, então **cada atualização do helper pede reautorização** em Ajustes do Sistema;
  o gerenciador avisa quando isso acontece. Binário baixado precisa de `xattr -d com.apple.quarantine`.
- Rede local apenas, como hoje.

## Decisões de arquitetura (tomadas)

### 1. Camada de plataforma

Nova pasta `server/src/platform/` com `index.js` que escolhe pela `process.platform`:

- `platform/linux/` — o comportamento atual, movido ou envolvido em adaptadores (sem mudar lógica).
- `platform/darwin/` — implementação macOS, falando com o helper nativo.

Contrato (interfaces em JS, documentadas em `platform/README.md`):

| Área | Métodos / eventos | Linux (hoje) | macOS |
|---|---|---|---|
| `keys` | `shortcut(keys)`, `keyDown/keyUp(key)`, `mediaKey(play|next|prev|volUp|volDown|mute)` | ydotool/xdotool, wpctl/playerctl | helper (CGEvent; teclas de mídia por `NX_KEYTYPE_*`) |
| `windows` | evento `active({app, bundleId, title})`, `focus({app, titleHints, classHints, requireTitle})`, `active()` | KWin/kdotool/Hyprland/Sway/xdotool | helper (NSWorkspace + Acessibilidade; abas de navegador por AppleScript, ver §5) |
| `apps` | `list()`, `launch(id)`, `icon(id)`, `open(urlOrPath)` | `.desktop`, gio, xdg-open | helper (varredura de `/Applications`, `~/Applications`, `/System/Applications`; ícones em PNG; `open`) |
| `audio` | `master.get/set/mute`, `apps.list/set/mute` (lista pode ser parcial; cada app tem `available`) | pactl/wpctl | helper CoreAudio para master; `spotify` via `media`; demais `available:false` |
| `media` | `players()`, `nowPlaying()`, `control(cmd)`, `seek`, `position`, `volume`, `shuffle`, `repeat`, `openUri`, `art` | MPRIS via busctl (`spotify.js` e `mediaPlayers.js`) | Spotify e Music por AppleScript (no helper); outros players: transporte por teclas de mídia, sem metadados |
| `hardware` | `sample()` | `/sys`, nvidia-smi, sensors | helper (Mach, IOKit, SMC/HID) |
| `tray` | `start/update/stop`, eventos `tray.click`, `tray.menu(item)` | PySide6 (polling de `/api/status`) | item na barra de menus no helper, modelo push + eventos |
| `session` | `lock()` | loginctl | helper (`CGSession -suspend` / Apple Event de bloqueio) |
| `autostart` | `enable/disable/status` | .desktop autostart | LaunchAgents |
| `exec` | `exec/which` | flatpak-spawn quando em Flatpak | passthrough |

Módulos que passam a chamar a camada *(lista fechada; decisão minha a partir do levantamento)*:
`actions/systemActions.js`, `windowDetector.js`, `audioMixer.js`, `mediaPlayers.js`, `spotify.js`,
`hardwareMonitor.js`, `tray.js`, `appLauncher.js`, `profiles/default.js` (volume, play/pause, abrir
navegador/calculadora/terminal, bloquear), `profiles/discord.js` e `profiles/teamspeak.js` (abrir o app),
`elgato/elgatoBridge.js` (campo `platform` passa a refletir o sistema: `mac` ou `linux`, como no SDK da
Elgato). No Linux o refactor é mecânico e sai antes de qualquer código macOS (fase 1).

**Como garantir que o Linux não regride** *(decisão minha)*: antes do refactor entram testes unitários
para os módulos que hoje não têm (teclas, foco, mixer, apps, bandeja, comandos do perfil padrão), usando
um `exec` falso que registra os comandos gerados; o refactor precisa produzir os mesmos comandos. Depois
do refactor o dono roda um roteiro manual curto no KDE (PTT, foco do Meet, mixer, Auto-Perfil, bandeja).

### 2. Helper nativo (`macos/MatDeckHelper`)

Pacote SwiftPM com um executável, empacotado pelo script de build como `MatDeck Helper.app`
(`Info.plist` com `LSUIElement`, sem ícone no Dock) e assinado ad hoc com identificador fixo. É um
processo de longa duração *(decisão minha, por causa do TCC)*: **não** é filho do Node. Ele é iniciado
por `open -a` (ou pelo seu próprio LaunchAgent com `KeepAlive`), para que o macOS trate o helper, e não o
Terminal ou o `node`, como o processo responsável pelos pedidos de permissão. Node e helper conversam por
um **socket Unix** em `~/Library/Application Support/MatDeck/helper.sock`; o helper reconecta sozinho se
o Node reiniciar e o Node o relança (via `open -a`) se ele cair, com recuo de 2 s, 5 s, 15 s e aviso no chip.

Protocolo: JSON por linha, em ambos os sentidos.

- Pedido: `{"id":1,"op":"key.shortcut","args":{"keys":["cmd","shift","m"]}}`
- Resposta: `{"id":1,"ok":true,"result":{}}` ou `{"id":1,"ok":false,"error":"accessibility_denied"}`
- Evento: `{"event":"window.active","data":{"app":"Discord","bundleId":"com.hnc.Discord","title":"…"}}`
- Erros têm código estável (`accessibility_denied`, `automation_denied`, `not_supported`, `not_running`)
  para o Node mostrar a dica certa no chip de estado.

Operações: `hello` (versão, permissões), `permissions.request(kind)`, `key.shortcut`, `key.down`, `key.up`,
`key.media`, `window.active`, `window.focus`, `window.subscribe`, `apps.list`, `apps.launch`, `apps.icon`,
`apps.open`, `audio.master.get/set/mute`, `media.spotify.*`, `media.music.*`, `hw.sample`, `tray.set`,
`session.lock`. Eventos: `window.active`, `window.title`, `tray.click`, `tray.menu`, `permissions.changed`.

Com `ui.tray=false` o helper continua vivo (teclas e foco dependem dele) e só não mostra o item.

### 3. Mídia e Spotify no macOS

- Spotify e Music: AppleScript executado **pelo helper** (`NSAppleScript`), que, por ser um app com
  interface, recebe o pedido de permissão de Automação de forma confiável. Sondagem só depois de confirmar
  `is running` pelo `NSRunningApplication`, porque `tell application "Spotify"` abre o app se ele estiver
  fechado. Cobre estado, faixa, capa, posição, seek, shuffle, repeat, `openUri` e volume do app.
- Mídia do sistema (navegador, VLC): o framework MediaRemote é privado e o macOS 15.4+ bloqueou seu uso
  por apps sem entitlement. Decisão: **não depender dele**. Teclas `player:play_pause/next/prev` mandam
  teclas de mídia do sistema; `player:seek_*`, `player:mute`, `player:switch` e `player:raise` ficam
  `available:false` no Mac (o deck mostra "n/d", toque não faz nada); "Tocando agora" mostra metadados só
  quando o player ativo é Spotify ou Music.

### 4. Telemetria no macOS

CPU (Mach `host_processor_info`), RAM (`vm_statistics64`), rede e disco (`getifaddrs` / IOKit
BlockStorage), GPU (IOKit `IOAccelerator` → `PerformanceStatistics["Device Utilization %"]`, VRAM quando
exposta), temperatura (Intel: SMC via `AppleSMC`; Apple Silicon: sensores HID). Na VM não há sensor nem
GPU real: tudo que faltar vira `null` e a tecla mostra "--". Mesma cadência e mesmo modo econômico.

### 5. Teclas, atalhos e foco por plataforma

- Os perfis deixam de ter atalhos literais no código: cada perfil declara uma tabela
  `shortcuts: { linux: {...}, darwin: {...} }` *(decisão minha: tabela por perfil, não regra genérica)*,
  porque os atalhos dos apps não seguem uma regra (Meet no Mac usa `Cmd+D`/`Cmd+E` mas
  `Ctrl+Cmd+H/C/P` para mão/chat/participantes; Discord `Cmd+Shift+M/D`).
- No helper, letras e pontuação viram keycodes pelo layout de teclado **ativo**
  (`TISCopyCurrentKeyboardLayoutInputSource` + `UCKeyTranslate`), então ABNT2 e US funcionam sem tabela
  fixa. `super` = Command, `alt` = Option, `ctrl` = Control.
- Foco de aba de navegador (Meet, Talk): o contrato mantém `titleHints`, `classHints` e `requireTitle`
  do Linux. No Mac, `focus` ativa o app e lê o título da janela da frente pela Acessibilidade; se não
  casar, tenta trocar de aba por AppleScript em Chrome, Brave, Edge e Safari (todos scriptáveis); no
  Firefox não há como, então falha sem enviar a tecla e o deck mostra a mesma notificação do Linux.
- Auto-Perfil casa por `bundleId` (tabela em `windowDetector`, confirmada no Mac durante a fase 2:
  Discord `com.hnc.Discord`, OBS `com.obsproject.obs-studio`, Spotify `com.spotify.client`, TeamSpeak e
  Nextcloud Talk a confirmar) e por título para Meet.

### 6. Tema macOS do gerenciador

O servidor já injeta dados no HTML; passa a injetar `data-platform="darwin"` no `<html>` (sem flash de
tema). `manage.html` carrega `manage-mac.css`, que redefine os tokens (cores, raio, sombras, fonte
`-apple-system, "SF Pro Text"`, altura de controles) e estiliza selects, toggles e botões no padrão do
sistema, com `prefers-color-scheme` para claro/escuro. Pré-requisito *(decisão minha)*: tokenizar as cores
fixas que hoje estão espalhadas em `manage.css` e `manage.js` para o `:root`, sem mudança visual no
Linux (verificável por captura antes/depois). O deck no tablet não muda.

### 7. Instalação, dados e início automático

- Dados em `~/Library/Application Support/MatDeck/` (config, presets, devices, media, plugins), via o mesmo
  `MATDECK_DATA_DIR`.
- `scripts/install-macos.sh`: verifica Node 18+ (sugere `brew install node`), compila e empacota o helper
  (`swift build -c release` + bundle + `codesign -s -`), instala servidor e helper em
  `~/Library/Application Support/MatDeck/app/`, cria os LaunchAgents `br.com.matdeck.server` e
  `br.com.matdeck.helper` (início no login, opcional), abre o gerenciador e guia as permissões.
  `scripts/uninstall-macos.sh` desfaz.
- Homebrew: fórmula num tap `mathewsfs/homebrew-matdeck` fica para depois do primeiro beta validado.
- Release: a CI ganha um job `macos-latest` que compila o helper (universal x86_64 + arm64), roda os testes
  e anexa `MatDeck-macos.tar.gz` (servidor + helper + scripts). O README explica a quarentena.

### 8. Testes

- Unitários no Linux: `platform/darwin` contra um **helper falso** em Node (`server/test/fake-helper.js`)
  que fala o protocolo pelo socket e registra chamadas; cobre atalhos, foco com abas, eventos de janela,
  erros de permissão, telemetria com campos faltando, reconexão.
- Helper: `swift test` para protocolo e tabela de modificadores (roda na CI macOS).
- Integração na VM (podman macOS 15, Intel sem GPU/sensores) por SSH; validação final no Mac físico pelo
  dono, com o tablet. A VM só cobre o lado Intel: Apple Silicon (sensores HID) é validado só no Mac físico
  se ele for Apple Silicon.

## Fases (ordem de entrega)

1. **Testes + camada de plataforma no Linux** (refactor sem mudança de comportamento).
2. **Helper + básico macOS**: socket, `hello`, permissões, teclas, foco/janela ativa, abrir apps, volume
   master, bloquear, barra de menus. Servidor sobe no Mac, deck funciona, Discord/OBS/TS iguais.
3. **Telemetria, Spotify, Music e mídia** no Mac.
4. **Tema macOS** do gerenciador (com a tokenização do CSS).
5. **Instalação, CI, release e documentação** (README com seção macOS, ROADMAP, CHANGELOG).

## Respostas do dono

- **Numeração**: macOS é a **1.5** (`1.5.0-beta.1`). A lista que o ROADMAP tinha em 1.5 (segurança,
  Flathub, testes na CI) passa para 1.6; o ROADMAP é atualizado na fase 5.
- **Mac físico**: Apple Silicon, teclado US. A VM (Intel, sem GPU nem sensores) cobre o caminho x86_64;
  sensores HID, GPU e o binário arm64 só são validados no Mac físico pelo dono.

## Deixado ao construtor

- Formato do bundle `.app` do helper e do script que o monta.
- Como obter ícones dos apps em PNG (NSWorkspace + NSBitmapImageRep) e cache em disco.
- Detalhes do tema (tokens, sombras, raios) desde que siga as Human Interface Guidelines e mantenha o
  contraste do tema atual.
- Estrutura interna do `platform/linux` (mover código ou adaptar) desde que os testes não mudem.
- Bundle ids de TeamSpeak 6 e Nextcloud Talk no Mac (confirmar na máquina).
