# macOS: onde paramos (25/10/2026) e como retomar

Leia isto antes de continuar o trabalho do macOS. Resume o estado, o que falta e os comandos.

## Estado

| Fase | O que é | Branch / PR | Situação |
|---|---|---|---|
| 1 | Camada de plataforma (`server/src/platform/`, Linux intacto) | `feat/macos-plataforma` → PR #1 | Mesclada em 24/10/2026; roteiro KDE 11/11 aprovado |
| 2 | MatDeck Helper (Swift) + camada `darwin` completa: teclas, janela/foco/abas, apps, volume master, bloqueio, barra de menus, stubs de mídia e telemetria | `feat/macos-helper` → PR #2 | Mesclada em 25/10/2026 (merge `99f20ba`) |
| 3 | Telemetria (Mach, IOKit, SMC), Spotify e Music por AppleScript, teclas de mídia nos players | — | Não começada; precisa de plano (`superpowers:writing-plans` a partir da spec) |
| 4 | Tema do gerenciador com cara de macOS | — | Não começada |
| 5 | Instalação (app de barra de menus com Node embutido), CI macOS, release; assinatura quando houver conta | — | Não começada |

Spec (autoridade): `docs/superpowers/specs/2026-10-24-macos-design.md`. Planos executados:
`2026-10-24-macos-fase1-camada-plataforma.md`, `2026-10-24-macos-fase2-helper-basico.md`.

## Como a fase 2 foi validada

- Suíte do servidor 18/18 no Linux e na VM; `swift test` 19/19; `test/integration/darwin-vm.js` 12/12.
- Na VM (macOS 15.8.1, Intel, sem áudio/GPU) pelo VNC: diálogo de Acessibilidade, digitação no TextEdit,
  foco do Safari por título, ícone e menu da barra de menus, deck e gerenciador no Safari.
- Roteiro do Mac físico (`2026-10-24-macos-fase2-roteiro-mac.md`): o dono começou pela VM em 25/10;
  até o momento "o resto funciona", só a telemetria não lê (esperado: é a fase 3). **Os 20 itens ainda não
  foram marcados no Mac físico** (áudio real, Discord, Meet, Auto-Perfil, PTT com queda do servidor,
  bundle ids de TeamSpeak 6 e Nextcloud Talk).

## Pendências conhecidas (vindas da revisão final da fase 2)

Nenhuma bloqueia; entram quando a área for tocada de novo:

- `HelperClient`: flag `dropping` não zera ao reconectar (hello descartado após queda no meio de linha
  gigante, ~7 s); `warnOnce('hello')` nunca é limpo.
- `platform/darwin/index.js`: `permissions.request` repete a cada reconexão enquanto a permissão está negada.
- `AppsService.swift`: `resolve()` varre as 4 pastas a cada `apps.icon`/`apps.launch` no thread principal
  (cache curto); `apps.launch` responde `launched:true` antes do completion handler.
- `SocketServer.swift`: `chmod 0600` depois do `bind` (usar `umask` ao redor).
- `index.js`: o shutdown não chama `platform.helper.stop()` (o socket fecha só no `process.exit`).
- Nits: `HelperWindowDetector.subscribed` nunca lido; `modifierFlags: down ? [] : []`; `activate(options:)`
  deprecated no macOS 14; ramo Firefox de `windows.focus` sem teste.
- Assinatura ad hoc: cada recompilação do helper exige `tccutil reset Accessibility br.com.matdeck.helper`
  e conceder de novo. A fase 5 precisa avisar/automatizar.

## Como retomar

1. `git checkout main && git pull`. Nova branch por fase: `feat/macos-telemetria` (fase 3).
2. Plano da fase 3 com `superpowers:writing-plans` a partir da spec; execução em modo native
   (`superpowers:executing-plans`), como nas fases 1 e 2.
3. VM: `ssh mac` (porta 2222, chave `~/.ssh/macos-vm`), VNC em `localhost:5900` para permissões.
   `./scripts/dev-mac-sync.sh` sincroniza o repo para `~/matdeck` na VM e instala o Node em `~/node`.
   Helper: `./scripts/build-macos-helper.sh` (na VM) gera `macos/MatDeckHelper/dist/MatDeck Helper.app`.
   Servidor na VM: `cd ~/matdeck/server && PATH=$HOME/node/bin:$PATH PORT=8888 MATDECK_HELPER_APP="$HOME/matdeck/macos/MatDeckHelper/dist/MatDeck Helper.app" node src/index.js`.
   Integração: `cd server && MATDECK_VM_HOST=mac node test/integration/darwin-vm.js`.
4. Helper na mão: `open -a "<app>" --args --socket /tmp/x.sock` e `printf '{"id":1,"op":"hello","args":{}}\n' | nc -U /tmp/x.sock -w 5`.
5. Testes locais sem Mac: `cd server && npm test` (os `darwin-*.test.js` usam `test/fake-helper.js`).

## O que a fase 3 precisa decidir no plano

- Telemetria no helper: CPU por `host_processor_info` (Mach), RAM por `host_statistics64`, rede/disco por
  `getifaddrs`/IOKit, GPU por IOKit (`IOAccelerator`, só uso; VRAM compartilhada no Apple Silicon),
  temperaturas por SMC (`AppleSMC` via IOKit, chaves variam por modelo; na VM não há sensores) — manter a
  forma de `currentStats` e o modo econômico (`setActive`).
- Spotify e Music por AppleScript (permissão de Automação): `player state`, `current track`, `player position`;
  arte do álbum (Spotify dá `artwork url`; Music dá `artworks` em bytes). Mesma forma de `SpotifyMonitor`
  e `MediaPlayers` (`snapshot/artOf/playPause/next/previous/seek`).
- O que o roteiro no Mac físico apontar.
