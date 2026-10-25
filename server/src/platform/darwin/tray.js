// Ícone na barra de menus do macOS, desenhado pelo helper (NSStatusItem). O servidor manda o estado
// (`tray.set`) e reage aos cliques (`tray.menu {id}` / `tray.click`). Forma igual à bandeja do Linux:
// start({port, lanIp, enabled}), update({clients}), stop(): Promise.
const http = require('http');

const ITEMS = [
    { id: 'manage', label: 'Abrir gerenciador' },
    { id: 'deck', label: 'Abrir deck' },
    { id: 'stop', label: 'Parar servidor' },
    { id: 'hide', label: 'Ocultar ícone' }
];

function createTray(client, { openUrl } = {}) {
    let port = 0;
    let lanIp = '';
    let enabled = false;
    let visible = false;
    let state = 'amber';
    let lastSent = null;
    let warned = false;

    const payload = () => ({ visible, tooltip: `MatDeck · http://${lanIp}:${port}`, state, items: ITEMS });

    function push(force = false) {
        if (!enabled || !client.connected) return;
        const p = payload();
        const key = JSON.stringify(p);
        if (!force && key === lastSent) return;
        lastSent = key;
        client.request('tray.set', p).catch((e) => {
            lastSent = null;
            if (!warned) { warned = true; console.log(`[Tray] Barra de menus indisponível: ${e.message || e.code}`); }
        });
    }

    function shutdown() {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 3000 }, (res) => res.resume());
        req.on('error', (e) => console.log(`[Tray] Falha ao pedir o encerramento: ${e.message}`));
        req.end();
    }

    function onMenu(data) {
        if (!enabled) return;
        const id = data && data.id;
        if (id === 'manage') { if (openUrl) openUrl(`http://localhost:${port}/manage`); }
        else if (id === 'deck') { if (openUrl) openUrl(`http://localhost:${port}/`); }
        else if (id === 'stop') shutdown();
        else if (id === 'hide') { visible = false; push(); }
    }

    client.on('tray.menu', onMenu);
    client.on('tray.click', () => { if (enabled && openUrl) openUrl(`http://localhost:${port}/manage`); });
    client.on('connected', () => { lastSent = null; if (enabled) push(true); });

    return {
        start(opts = {}) {
            port = opts.port;
            lanIp = opts.lanIp || 'localhost';
            enabled = opts.enabled !== false;
            if (!enabled) return;
            visible = true;
            state = 'amber';
            push(true);
        },
        update({ clients = 0 } = {}) {
            const next = clients > 0 ? 'green' : 'amber';
            if (next === state) return;
            state = next;
            push();
        },
        stop() {
            if (!enabled) return Promise.resolve();
            enabled = false;
            if (!client.connected) return Promise.resolve();
            return client.request('tray.set', { ...payload(), visible: false }).then(() => {}, () => {});
        }
    };
}

module.exports = { createTray, ITEMS };
