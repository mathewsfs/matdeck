# Roadmap

## Canais

| Canal | Como identificar | Para quem |
|---|---|---|
| **Estável** | tag `vX.Y.Z`, release marcada como *Latest* | quem quer usar no dia a dia |
| **Beta** | tag `vX.Y.Z-beta.N`, release marcada como *Pre-release* | quem quer testar o que vem na próxima estável e reportar problemas |

As duas saem do branch `main`. Uma beta vira estável quando passa pelo menos uma semana em uso real
sem regressão, com o deck validado nos dois navegadores de referência (tablet Android 4.4 e iPad 2 com
Safari 9) e com o CHANGELOG fechado. Correções de segurança saem nos dois canais.

Versões seguem [SemVer](https://semver.org/lang/pt-BR/): `X` quebra compatibilidade (protocolo do
deck, formato de presets ou config), `Y` adiciona recurso, `Z` corrige.

## Em andamento: 1.4 (beta)

Primeira versão publicada no GitHub. Entra tudo o que foi construído desde a 1.3.1:

- [x] Emparelhamento por PIN para dispositivos da rede; gerenciador só no PC; lista de aparelhos
- [x] Validação do cabeçalho Host (DNS rebinding) e de Origin (CSRF)
- [x] Discord por RPC/IPC: mute, surdo, sala de voz e PTT por segurar
- [x] Auto-Perfil nasce desligado e é configurável por aplicativo
- [x] Telemetria: slider de fonte, temperatura de GPU, CPU e GPU AMD/Intel/NVIDIA pelo kernel
- [x] Modo econômico sem clientes e `nvidia-smi` contínuo com cliente
- [x] Spotify: mixer, fader deitado e ação unificada focar/abrir
- [x] Imagens e GIFs nas teclas; players de mídia do sistema (MPRIS)
- [x] Deck compatível com Safari 9 (iPad 2): bundle ES5 e layout sem grid
- [x] Dependências: adm-zip 0.6.1 e body-parser 1.20.9 (`npm audit` limpo)
- [x] Releases só com o Flatpak: o deck é acessado pelo navegador, sem instalar nada no aparelho
- [x] Capturas de tela do deck e do gerenciador no README
- [ ] Validar o PIN no navegador do tablet Android 4.4 (iPad já validado)

### Critérios para a 1.4.0 estável

- Uma semana de uso sem regressão no deck, no gerenciador e nas integrações
- Nenhum erro no log do servidor durante o período
- CHANGELOG e README revisados

## Próxima: 1.5 — macOS

Camada de sistema isolada (`server/src/platform/`, implementação `linux` e `darwin`) e o **MatDeck Helper**
em Swift falando JSON com o Node. Limitação conhecida: o macOS não tem volume por aplicativo sem software
de terceiros; esses faders ficam `n/d`.

- [x] Fase 1: camada de plataforma com atalhos por sistema; Linux sem mudança de comportamento (roteiro KDE aprovado)
- [x] Fase 2: helper básico (socket, permissões, teclas, janela ativa e foco, apps, volume master, bloqueio, barra de menus); servidor sobe no Mac
- [ ] Fase 3: telemetria (Mach, IOKit, SMC), Spotify e Music por AppleScript, teclas de mídia nos players
- [ ] Fase 4: tema do gerenciador com cara de macOS
- [ ] Fase 5: instalação (app de barra de menus com Node embutido), CI e release; assinatura/notarização quando houver conta de desenvolvedor

## 1.6

- **Segurança**: mascarar segredos em `GET /api/config`, aceitar segredos só por loopback, validar campo a
  campo o `POST /api/config`, `maxPayload` no WebSocket, cota na pasta `media/`
- **Flathub**: id `io.github.mathewsfs.matdeck`, build offline com `flatpak-node-generator`, capturas no
  metainfo e pedido de exceção para `--talk-name=org.freedesktop.Flatpak`
- **Repositório Flatpak próprio** no GitHub Pages (`.flatpakrepo`) para atualização automática
- **Testes de integração na CI** (hoje só locais, porque dependem de PipeWire e de IP de rede)
- **Protocolo**: `hardwareStats` menor para o tablet (histórico só no primeiro envio)
- **Gerenciador**: catálogo com entrada "Imagem/GIF"; unificar focar/abrir para TeamSpeak e Nextcloud
- **README em inglês**

## Depois

- **Windows**: envio de teclas e foco já existem em esboço (PowerShell); faltam áudio, telemetria e
  empacotamento
- **Cliente Android nativo (APK)**: o código em `android-client/` (Java puro, minSdk 19, WebSocket e
  descoberta UDP próprios, PIN) continua no repositório, mas fora das releases e da CI. A decisão é
  que o deck rode pelo navegador, porque assim independe do aparelho e do fabricante. O APK volta a
  ser publicado se aparecer um caso que o navegador não cubra. Para compilar hoje: `./scripts/build-apk.sh`
- **Bandeja mais leve** que o Python com Qt (hoje 44 MB)
- **Plugins Elgato**: confirmação e allowlist para instalação por URL

## Fora do escopo

- HTTPS na rede local (certificados em tablets antigos não compensam; use a rede doméstica)
- Suporte a Android abaixo da 4.4 ou iOS abaixo do 9
