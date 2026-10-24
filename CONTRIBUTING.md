# Contribuindo com o MatDeck

Obrigado por querer ajudar. Este guia explica como rodar o projeto a partir do código, como testar e
como enviar mudanças. Issues, PRs e discussões são em português; código em inglês.

## Rodando a partir do código

```bash
git clone https://github.com/mathewsfs/matdeck.git
cd matdeck
./start-server.sh            # instala as dependências do servidor na primeira vez e sobe em http://localhost:8888
```

Requisitos e ajustes do sistema (ydotool, kdotool, PipeWire, PySide6) estão no [README](README.md#requisitos-no-pc-fedora--kde-wayland-testado).
O deck abre em `http://<ip-do-pc>:8888` e o gerenciador em `http://localhost:8888/manage`.

Deck para navegadores antigos (Safari 9 do iPad 2): `server/web/app.legacy.js` é gerado a partir de
`app.js`. Depois de mexer no `app.js`, regenere e versione o arquivo gerado:

```bash
cd scripts/legacy-build && npm ci && npm run build
```

Flatpak local: `./scripts/build-flatpak.sh`. APK: `./scripts/build-apk.sh` (podman ou docker).

## Testes

```bash
cd server
npm test                 # unitários: acesso/PIN, fluxo de PIN do deck, detecção de CPU/GPU, modo econômico
npm run test:integration # sobe uma instância isolada na porta 8899; precisa de IP de rede local e PipeWire
```

Os testes não abrem navegador: o deck é exercitado com DOM falso e o servidor por HTTP e WebSocket.
A CI roda `npm test` e confere se o `app.legacy.js` versionado corresponde ao `app.js`.

Ao mudar um coletor (hardware, Spotify, ventoinhas, mídia) ou o controle de acesso, acrescente ou
ajuste o teste correspondente em `server/test/`.

## Branches e versões

- `main` é a linha de desenvolvimento. Toda mudança entra por pull request.
- Versões seguem [SemVer](https://semver.org/lang/pt-BR/). Tags `vX.Y.Z-beta.N` publicam uma
  **beta** (pré-release no GitHub); tags `vX.Y.Z` publicam a **estável**. Veja o [ROADMAP](ROADMAP.md).
- Cada versão tem uma seção no [CHANGELOG](CHANGELOG.md). Adicione sua mudança em "Não lançado".

## Commits

[Conventional Commits](https://www.conventionalcommits.org/pt-br/) com mensagem em português:

```
feat: emparelhamento por PIN para dispositivos da rede
fix: PTT do Discord soltava a tecla no mesmo toque
docs: seção de acesso no README
chore: adm-zip 0.6.1 e body-parser 1.20.9
```

Tipos usados: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`.

## Pull requests

1. Crie um branch a partir de `main` (`feat/<descricao>` ou `fix/<descricao>`).
2. Rode `npm test` em `server/` e, se mexeu no deck, regenere o `app.legacy.js`.
3. Descreva o que muda e como testou. Mudanças que afetam o tablet Android 4.4 ou o iPad 2 (Safari 9)
   precisam dizer como foram verificadas nesses aparelhos ou no DOM falso dos testes.
4. Não inclua `config.json`, `presets.json`, `devices.json`, chaves ou tokens.

## Estilo

- Node.js em CommonJS, sem transpilação no servidor; o deck precisa continuar rodando em ES5 após o
  build legado (evite APIs sem polyfill no `scripts/legacy-build/prelude.js`).
- Nomes de variáveis, funções e arquivos em inglês; textos para o usuário e comentários em português.
- Comentários só quando o código não se explica sozinho.
- Nada de dependências novas sem conversar antes na issue ou no PR.
