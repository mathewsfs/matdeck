# Fase 2 (helper básico): roteiro manual no Mac físico

Objetivo: confirmar no Mac de verdade (Apple Silicon, teclado US, macOS 14+) o que a VM não cobre: teclas
nos apps reais, áudio com dispositivo de saída, Auto-Perfil, barra de menus. Antes:

```bash
./scripts/build-macos-helper.sh
cd server && npm ci && PORT=8888 node src/index.js
```

Na primeira execução aceite o diálogo de Acessibilidade (ou ligue "MatDeck Helper" em Ajustes do Sistema →
Privacidade e Segurança → Acessibilidade). Abra o gerenciador em `http://localhost:8888/manage` e o deck no
tablet (`http://<ip-do-mac>:8888`, PIN no gerenciador). Marque cada item; desvio volta para a task do plano.

| # | O que fazer | O que esperar | Task |
|---|---|---|---|
| 1 | Veja o início do log do servidor e o chip **Teclas** do gerenciador. | `Sessão: macOS <versão> \| helper: conectado \| Acessibilidade: ok`; chip verde com a dica "MatDeck Helper (Acessibilidade concedida)". | 1, 3, 8 |
| 2 | Abra o TextEdit, deixe-o na frente e toque uma tecla de atalho simples (ex.: perfil Padrão → tecla com `cmd+n`, ou crie uma tecla "atalho" `cmd+n`). | Um documento novo abre no TextEdit. | 3 |
| 3 | No Discord (app nativo), sem Client ID em Ajustes, segure **Push to Talk** e solte. | Enquanto segura, o mic abre (atalho configurado no Discord como `ctrl+shift+p`), tecla verde "FALANDO"; ao soltar, fecha. Nada fica preso. | 3, 4 |
| 4 | Com o Discord minimizado, toque **Microfone** do perfil Discord (atalho `cmd+shift+m`). | O MatDeck traz o Discord para a frente (`how: app`) e envia o atalho; o Discord muta. | 4 |
| 5 | Abra uma reunião do Meet no **Safari** em uma aba que não está na frente; toque **Microfone** do Meet. | O helper troca para a aba do Meet (pede Automação para o Safari na primeira vez; aceite) e envia `cmd+d`; o mic alterna. | 4 |
| 6 | Repita o item 5 no **Chrome**. | Mesmo resultado (Automação para o Chrome na primeira vez). | 4 |
| 7 | Feche o Meet e, com outra aba na frente (sem "Meet" no título), toque **Microfone** do Meet. | Log "Nenhuma janela encontrada … (título obrigatório)"; nada é enviado; a tecla não alterna. | 4 |
| 8 | No gerenciador, adicione uma tecla "Abrir aplicativo" escolhendo **Calculadora** e outra com **Safari**; toque as duas no deck. | A lista mostra os apps com os ícones reais; os dois abrem. | 5 |
| 9 | Toque **Abrir Discord** (ação `discord:open`) com o Discord fechado. | O Discord abre (`apps.launch` pelo nome ou `discord://`). | 5 |
| 10 | Toque **Volume +** duas vezes, depois **Mudo PC**, e mova o fader **Volume PC**. | O volume do Mac sobe 10% (OSD do sistema), muta/desmuta, e o fader segue o valor real; mudar o volume pelo teclado do Mac atualiza o fader no deck. | 6 |
| 11 | Abra o perfil Spotify ou TeamSpeak e olhe o fader do app. | Fader esmaecido com `n/d`; tocar nele não muda nada. | 6 |
| 12 | Toque **Bloquear PC**. | A tela bloqueia (`ctrl+cmd+q`). | 6 |
| 13 | Olhe a barra de menus; conecte o tablet; desconecte. | Ícone do MatDeck com ponto laranja; fica verde com o deck conectado e volta a laranja sem ninguém. | 7 |
| 14 | No ícone: **Abrir gerenciador**, depois **Ocultar ícone**, depois **Parar servidor** (reinicie antes se ocultou). | O gerenciador abre no navegador padrão; o ícone some; o servidor encerra. | 7 |
| 15 | Ligue **AUTO** no deck; traga o Discord para a frente, depois o Safari com o Meet, depois o OBS (se instalado). | O deck troca para Discord, Meet e OBS conforme o app/título da frente (sem polling: eventos do sistema). | 4, 8 |
| 16 | Toque **Play/Pause** com o Music ou o Spotify tocando. | O player pausa/retoma (tecla de mídia do sistema). | 3 |
| 17 | Feche o helper na força (`pkill -x matdeck-helper`) com o servidor rodando. | Log "Helper desconectado…", chip Teclas vermelho; em poucos segundos o servidor relança o helper e tudo volta. | 2, 8 |
| 18 | Confira `~/Library/Application Support/MatDeck/` depois de salvar um preset e emparelhar o tablet. | `config.json`, `presets.json` e `devices.json` estão lá (não em `server/data`). | 8 |
| 19 | Segure **Push to Talk** do Discord no deck e, sem soltar, mate o servidor (`Ctrl+C` no terminal); depois solte. | O helper solta `ctrl+shift+p` sozinho ao perder a conexão (log do helper: "soltando 3 tecla(s)…"); nada fica preso: digitar no TextEdit funciona normalmente. | 3 |
| 20 | Abra o gerenciador e a lista "Abrir aplicativo". | Os ícones reais dos apps aparecem (rota `/api/apps/:id/icon`). | 5, 8 |

Bundle ids a confirmar (ver `server/src/platform/darwin/bundleIds.js`): TeamSpeak 6 e Nextcloud Talk; anote
o resultado de `osascript -e 'id of app "TeamSpeak"'`.

Resultado: ______ (data, quem testou, itens com desvio).
