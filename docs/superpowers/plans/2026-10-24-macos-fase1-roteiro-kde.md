# Fase 1 (camada de plataforma): roteiro manual no KDE

Objetivo: confirmar que o Linux não mudou de comportamento depois do refactor. Rode com o Flatpak
construído a partir da branch `feat/macos-plataforma` (`./scripts/build-flatpak.sh` e depois
`flatpak run br.com.matdeck.MatDeck`), com o tablet (ou o deck no navegador do PC) aberto.
Marque cada item; qualquer desvio volta para a task correspondente do plano.

| # | O que fazer | O que esperar | Task |
|---|---|---|---|
| 1 | Em Ajustes → Discord, apague o Client ID (ou feche o Discord para a API). No deck, segure **Push to Talk** do Discord e solte. | Enquanto segura, a tecla fica verde "FALANDO" e o Discord mostra o mic aberto (atalho `Ctrl+Shift+P` configurado no Discord); ao soltar, volta a "PTT" e o mic fecha. Nada fica preso. | 1, 5 |
| 2 | Restaure o Client ID; toque **Microfone** do Discord. | Muta/desmuta pela API, com o Discord minimizado; a tecla reflete o estado real. | 5 |
| 3 | Com uma aba do Meet aberta e **na frente**, toque **Microfone** do Meet. | A aba recebe `Ctrl+D` e o mic do Meet alterna; a tecla alterna. | 3, 5 |
| 4 | Ponha **outra aba** do navegador na frente (sem "Meet" no título) e toque **Microfone** do Meet de novo. | O MatDeck recusa (log "Janela alvo não encontrada"), nada é enviado, a tecla não alterna. | 3 |
| 5 | Com o Nextcloud Talk em chamada e em foco, toque **Microfone** do Talk. | O Talk recebe `M` e muta; a tecla alterna. | 5 |
| 6 | Na tela Principal, toque **Mudo PC** e depois **Volume +** (tela "Mais" ou tecla `media:vol_up`). | O volume master do sistema muta/desmuta e sobe 5% (o OSD do KDE mostra). | 2, 5 |
| 7 | Toque **Bloquear PC**. | A tela bloqueia (loginctl). | 2, 5 |
| 8 | Com o Discord e o TeamSpeak fechados, toque **Abrir Discord** e **Abrir TeamSpeak**. | Os dois abrem (flatpak ou binário); se um não estiver instalado, o deck avisa. | 2, 5 |
| 9 | Ligue **AUTO** e foque a janela do OBS, depois a do Discord. | O deck troca para o perfil OBS e depois Discord. | 3, 6 |
| 10 | Ícone na bandeja: clique com o botão direito → **Parar servidor**. | O servidor encerra e o ícone some. Ao abrir de novo, o ícone volta. | 4, 6 |
| 11 | Com um plugin Elgato que abre URL instalado (ou pelo Property Inspector), dispare o `openUrl`. | O navegador abre a URL (xdg-open). | 6 |

Resultado: aprovado em 24/10/2026 pelo dono (Mathews), 11/11 itens sem desvio.
