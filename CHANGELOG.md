# Changelog

Todas as mudanças relevantes ficam aqui. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e as versões seguem [SemVer](https://semver.org/lang/pt-BR/). Betas são pré-releases (`-beta.N`).

## [Não lançado]

### Alterado
- O cliente Android (APK) saiu das releases e da CI; o deck é acessado pelo navegador do tablet ou
  celular. O código continua em `android-client/` como experimental (ver ROADMAP).
- README revisado: capturas de tela do deck, do gerenciador e do PIN; seções "Estrutura" e "Painel web"
  (página antiga) removidas; referências a "⚙ Configurações" viraram "Ajustes" do gerenciador.

## [1.4.0-beta.1] - 2026-10-24

Primeira versão publicada no GitHub.

### Adicionado
- Emparelhamento por PIN de 4 dígitos para tablets, celulares e o APK; o PIN aparece só no gerenciador,
  o aparelho fica lembrado por cookie HttpOnly (hash em `devices.json`) e pode ser removido em
  Ajustes → Dispositivos.
- Gerenciador, configuração, presets, plugins e desligamento só respondem ao próprio PC (loopback).
- Validação do cabeçalho Host contra DNS rebinding, com `server.allowedHosts` para nomes extras.
- Discord por RPC/IPC: mute, surdo, estado da sala de voz e PTT por segurar (keyDown ao tocar,
  keyUp ao soltar) no deck.
- Auto-Perfil nasce desligado, lembra o último estado e permite escolher o perfil que cada aplicativo
  ativa (ou "Não trocar").
- Grupos de ações do gerenciador nascem recolhidos.
- Telemetria: slider de tamanho da fonte, temperatura da GPU, e detecção de CPU e GPU por fabricante
  pelo kernel: AMD (`k10temp`/`zenpower`, `amdgpu`), Intel (`coretemp`, Arc via `xe`/`i915`) e NVIDIA.
  Em máquinas com gráfico integrado e placa dedicada, a dedicada é a escolhida.
- Modo econômico: sem cliente conectado os coletores desaceleram (hardware 10 s, CoolerControl 30 s,
  Spotify 10 s, sem posição de mídia); com GPU NVIDIA e cliente conectado, um único `nvidia-smi`
  contínuo substitui um processo por segundo.
- Spotify: mixer de volume, fader deitado e ação unificada focar/abrir.
- Imagens e GIFs nas teclas (upload pelo gerenciador para `media/`).
- Players de mídia do sistema (MPRIS) com painel de controles.
- Deck compatível com Safari 9 (iPad 2): bundle ES5 gerado por Babel, toque, layout sem grid e
  diagnóstico remoto de layout.
- Testes automatizados em `server/test` (`npm test`), CI no GitHub Actions e release automática
  (Flatpak e APK) a partir de tags.
- LICENSE (MIT), CONTRIBUTING, SECURITY, ROADMAP e templates de issue e PR.

### Alterado
- `presets.json` deixou de ser versionado; o endereço padrão do servidor TeamSpeak ficou vazio.
- `app.legacy.js` passa a ser conferido na CI contra o `app.js`.

### Corrigido
- Ícone da bandeja órfão ou duplicado no Plasma com Flatpak; a bandeja abre o gerenciador pelo bus do host.
- CoolerControl respeita o bloqueio por tentativas e não insiste com token recusado.
- Erros em JSON, validação de preset, favicon e recuo do monitor de IA após HTTP 429.
- Telemetria de áudio e ventoinhas; apps fechando junto com o servidor.
- Requisições de outras origens bloqueadas; injeção de comando pelo caminho de credenciais.

### Segurança
- adm-zip 0.6.1 (bomba de descompressão, symlinks, SUID, entradas duplicadas) e body-parser 1.20.9
  (DoS por bytes extras); `npm audit` sem vulnerabilidades.

## [1.3.1] - 2026-10-19

Servidor, deck web, cliente Android e Flatpak (`br.com.matdeck.MatDeck`), com perfis para TeamSpeak,
Discord, Google Meet, Nextcloud Talk, OBS e Spotify, mixer de volume, telemetria, plugins Elgato,
uso de IA (Claude Code e Codex CLI), ventoinhas (CoolerControl) e ícone na bandeja.

## [1.3.0] - 2026-10-16

## [1.2.0] - 2026-10-14

[Não lançado]: https://github.com/mathewsfs/matdeck/compare/v1.4.0-beta.1...HEAD
[1.4.0-beta.1]: https://github.com/mathewsfs/matdeck/compare/v1.3.1...v1.4.0-beta.1
[1.3.1]: https://github.com/mathewsfs/matdeck/releases/tag/v1.3.1
