# Segurança

## Como reportar uma vulnerabilidade

Use o relato privado do GitHub: aba **Security → Report a vulnerability** em
https://github.com/mathewsfs/matdeck/security/advisories/new. Não abra issue pública para falhas
de segurança. Descreva o cenário (rede local, site aberto no PC, plugin), os passos e o impacto;
se tiver, anexe um teste reproduzível.

Resposta inicial em até 7 dias. Correções saem primeiro na versão beta e depois na estável.

## Versões com suporte

| Canal | Versões | Recebe correções de segurança |
|---|---|---|
| Estável | última `vX.Y.Z` | sim |
| Beta | última `vX.Y.Z-beta.N` | sim |
| Anteriores | qualquer outra | não; atualize |

## Modelo de acesso

O servidor precisa escutar na rede local para o tablet alcançá-lo, então o acesso é dividido pela
origem da conexão (`server/src/auth.js`):

- **Este PC (loopback)**: acesso total. O gerenciador (`/manage`), a configuração, os presets, os
  plugins e o desligamento só respondem a `localhost`.
- **Dispositivos da rede**: precisam emparelhar uma vez com um PIN de 4 dígitos que aparece só no
  gerenciador. O token fica em cookie HttpOnly (ou no cabeçalho `X-MatDeck-Token`, para clientes nativos); em disco
  vai só o hash SHA-256, em `devices.json` com modo 600. Cinco erros bloqueiam o IP por tempo
  crescente; "Recusar" no gerenciador bloqueia por 10 minutos.
- **Host e Origin**: o cabeçalho `Host` precisa ser um nome ou IP desta máquina (fecha DNS rebinding)
  e requisições que alteram estado precisam vir da própria origem (fecha CSRF).
- **Sem HTTPS**: o tráfego na rede local vai em claro, inclusive o cookie do dispositivo. O MatDeck
  foi feito para a rede doméstica ou do escritório; não exponha a porta 8888 à internet.

## O que fica fora do repositório

`config.json` (segredos do Discord, OBS, TeamSpeak e CoolerControl), `presets.json`, `devices.json`
e a pasta `media/` nunca são versionados (`.gitignore`). Em Flatpak ficam em
`~/.var/app/br.com.matdeck.MatDeck/data/matdeck/`.

## Plugins Elgato

Instalar um plugin executa código Node no seu PC, com os mesmos acessos do servidor. Só é possível a
partir do próprio PC, mas instale apenas plugins de autores em que você confia.
