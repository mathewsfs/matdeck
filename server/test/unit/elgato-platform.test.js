// Ponte Elgato: o campo platform do registerInfo vem da camada de plataforma e openUrl não chama xdg-open direto.
// Uso: node elgato-platform.test.js [caminho de server/src]
const fs = require('fs');
const os = require('os');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

const ElgatoBridge = require(path.join(SRC, 'elgato', 'elgatoBridge'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-elgato-'));
const opened = [];
const deps = { pluginsDir: tmp, saveKeySettings() {}, getDeviceSize: () => ({ columns: 5, rows: 3 }) };

const b = new ElgatoBridge(0, { ...deps, platformName: 'mac', openUrl: (u) => opened.push(u) });
check('buildInfo usa platformName', b.buildInfo({}).application.platform === 'mac', b.buildInfo({}).application);
b.onPluginMessage('plugin-x', { event: 'openUrl', payload: { url: 'https://exemplo.com' } });
check('openUrl do plugin chama deps.openUrl', opened[0] === 'https://exemplo.com', opened);
b.onPluginMessage('plugin-x', { event: 'openUrl', payload: { url: 'file:///etc/passwd' } });
check('openUrl recusa esquema que não é http(s)', opened.length === 1, opened);
// O Property Inspector precisa estar registrado numa instância de tecla
b.piSessions.set('pi-x', { context: 'c1', ws: null });
b.instances.set('c1', { context: 'c1', pluginUuid: 'plugin-x', actionUuid: 'a', settings: {} });
b.onPiMessage('pi-x', { event: 'openUrl', payload: { url: 'https://exemplo.com/pi' } });
check('openUrl do Property Inspector chama deps.openUrl', opened[1] === 'https://exemplo.com/pi', opened);

const b2 = new ElgatoBridge(0, deps);
check('sem platformName o padrão é linux', b2.buildInfo({}).application.platform === 'linux');
let threw = false;
try { b2.onPluginMessage('plugin-x', { event: 'openUrl', payload: { url: 'https://exemplo.com' } }); } catch (e) { threw = true; }
check('sem openUrl não lança', !threw);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FALHA(S)` : '\nTodos os checks passaram');
process.exit(fails ? 1 : 0);
