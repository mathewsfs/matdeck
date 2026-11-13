// Manifesto Flatpak: a pasta do socket IPC do Discord flatpak precisa ser montada com `:create`, senão o Flatpak
// só a monta se ela já existir quando o MatDeck sobe. Como /run/user é limpo a cada boot, MatDeck aberto antes do
// Discord nunca enxergava o socket (a API ficava "fechada" com o Discord aberto). Uso: node flatpak-manifest.test.js
const fs = require('fs');
const path = require('path');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const manifest = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'flatpak', 'br.com.matdeck.MatDeck.yml'), 'utf8');
const finishArgs = manifest.split('\n').filter((l) => /^\s*-\s*--/.test(l)).map((l) => l.trim().replace(/^-\s*/, '').replace(/\s+#.*$/, ''));

check('pasta do socket do Discord flatpak montada com :create', finishArgs.includes('--filesystem=xdg-run/app/com.discordapp.Discord:create'), finishArgs.filter((a) => /discord/i.test(a)));
check('socket do Discord nativo continua liberado', finishArgs.includes('--filesystem=xdg-run/discord-ipc-0'));

console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
process.exit(fails ? 1 : 0);
