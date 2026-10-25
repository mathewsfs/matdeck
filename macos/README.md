# MatDeck no macOS: helper nativo

`MatDeckHelper/` é um pacote SwiftPM (sem projeto Xcode) com:

- `Sources/MatDeckHelperCore`: protocolo JSON por linha, cortador de linhas e mapa de teclas. Testado com
  `swift test` (Swift Testing, que vem nas Command Line Tools).
- `Sources/MatDeckHelper`: o executável `matdeck-helper`, um app sem Dock que escuta num socket Unix e
  executa o que o servidor Node pede: teclas (CGEvent), janela ativa e foco (Acessibilidade), aplicativos,
  volume master (CoreAudio), ícone na barra de menus.

Construir: `./scripts/build-macos-helper.sh` gera `MatDeckHelper/dist/MatDeck Helper.app` (assinado ad hoc com
o identificador `br.com.matdeck.helper`). O servidor o inicia sozinho com `open -a` quando roda no Mac; para
desenvolvimento, `MATDECK_HELPER_APP=<caminho do .app>` e `MATDECK_HELPER_SOCKET=<caminho>`.

Falar com ele na mão: `printf '{"id":1,"op":"hello","args":{}}\n' | nc -U ~/Library/Application\ Support/MatDeck/helper.sock`.

Permissões: Acessibilidade (obrigatória; o helper mostra o diálogo do sistema na primeira vez) e, para
Spotify/Music, Automação. Como a assinatura é ad hoc, cada atualização do helper pede a Acessibilidade de novo.
