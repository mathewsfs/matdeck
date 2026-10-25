# Camada de plataforma

Tudo que fala com o sistema operacional passa por aqui. `index.js` escolhe a implementação pela
`process.platform` (`linux/` hoje; `darwin/` na fase 2 do macOS) e devolve um objeto com as áreas abaixo.

Regra: **perfis, `index.js` e a ponte Elgato só usam `ctx.platform`**. Nenhum deles importa
`actions/systemActions` ou `hostExec`; nenhum chama `ydotool`, `pactl`, `osascript` ou afins direto.
A variável `MATDECK_PLATFORM` força a escolha e existe só para os testes.

| Área | Métodos / eventos | Linux | macOS (fase 2) |
|---|---|---|---|
| `keys` | `shortcut(combo)`, `keyDown(combo)`, `keyUp(combo)`, `mediaKey('play_pause'\|'next'\|'prev')`, `capabilities(force?)`, `capabilitiesStale()`, `capabilitiesCached()`, `hostVisibleTmpDir()` | ydotool/xdotool, playerctl ou teclas XF86 | helper (CGEvent; teclas de mídia `NX_KEYTYPE_*`) |
| `windows` | `detector` (`start/stop/setEnabled/on('windowChanged')/lastDetected/describe`), `focus({ classHints, titleHints, requireTitle })`, `focusAndSend(target, combo, delayMs)`, `matchProfile(title, app)`, `DETECTABLE_APPS` | KWin/kdotool/Hyprland/Sway/xdotool | helper (NSWorkspace + Acessibilidade; abas por AppleScript) |
| `apps` | `launcher` (`list/launch/iconOf/iconDataUrl`), `open(urlOrPath)`, `launchFile(bin, args)`, `launchFirst(candidates, label)`, `flatpakInstalled(id)`, `commandExists(bin)` | `.desktop` + gio, xdg-open | helper (varredura de /Applications, `open`) |
| `audio` | `mixer` (`AudioMixer`: `getAll/setVolume/adjustVolume/toggleMute/on('volumeChange')/stop`), `masterStep(±n)`, `masterMuteToggle()` | pactl/wpctl | CoreAudio para master; `spotify` via `media`; demais `available:false` |
| `media` | `spotify` (`SpotifyMonitor`), `players` (`MediaPlayers`) | MPRIS via busctl | AppleScript (Spotify, Music); outros só transporte |
| `hardware` | `HardwareMonitor` (`start/stop/setActive/currentStats/on('stats')`) | `/sys`, nvidia-smi, sensors | helper (Mach, IOKit, SMC/HID) |
| `tray` | `start({ port, lanIp, enabled })`, `stop(): Promise` | PySide6 | item na barra de menus no helper |
| `session` | `lock()` | loginctl / qdbus / xdg-screensaver | helper |
| `describe()` | linha de sessão para o log de início | | |

Convenções:

- Combos de tecla são strings `mod+mod+tecla` com nomes neutros (`ctrl`, `shift`, `alt`, `super`/`cmd`,
  letras, `f11`, `escape`, `XF86Audio*`). Cada plataforma traduz.
- Os perfis declaram atalhos numa tabela por plataforma e resolvem com `platform/shortcuts.js`
  (`forPlatform(table)`).
- Métodos que disparam ações devolvem `Promise<boolean>` (`true` = enviado) e nunca lançam por falta de
  ferramenta: logam uma vez e devolvem `false`.
- Testes: `test/fake-host-exec.js` substitui o `hostExec` e registra os comandos; os testes
  `test/unit/platform-*.test.js` assertam os comandos exatos.
