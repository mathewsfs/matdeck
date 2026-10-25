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
Spotify/Music, Automação. Como a assinatura é ad hoc, o TCC guarda o hash daquele build: depois de recompilar, o
interruptor em Ajustes do Sistema continua ligado mas a permissão não vale (`permissions.status` → false). Rode
`tccutil reset Accessibility br.com.matdeck.helper`, peça de novo (o servidor faz isso ao iniciar) e ligue outra vez.
