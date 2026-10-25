// Teclas no macOS: tudo passa pelo helper (CGEvent). Combos no formato neutro 'ctrl+shift+m'.
const os = require('os');

const CAPS_TTL_MS = 30000;
const MEDIA_KEYS = new Set(['play_pause', 'next', 'prev', 'vol_up', 'vol_down', 'mute']);

function splitCombo(combo) {
    return String(combo || '').split('+').map((p) => p.trim()).filter(Boolean);
}

function createKeys(client) {
    let capsCache = null;
    let capsAt = 0;
    const warned = new Set();

    function warnOnce(key, msg) {
        if (warned.has(key)) return;
        warned.add(key);
        console.log(msg);
    }

    async function call(op, args, label) {
        try {
            await client.request(op, args);
            return true;
        } catch (e) {
            const code = (e && e.code) || 'erro';
            if (code === 'accessibility_denied') warnOnce(code, `[Keys] ${label}: sem permissão de Acessibilidade (conceda ao MatDeck Helper em Ajustes do Sistema)`);
            else if (code === 'not_connected') warnOnce(code, `[Keys] ${label}: helper não conectado`);
            else warnOnce(`${code}:${label}`, `[Keys] ${label} falhou: ${e.message || code}`);
            return false;
        }
    }

    function probe() {
        const hello = client.hello || {};
        const perms = hello.permissions || {};
        const connected = !!client.connected;
        const accessibility = connected && perms.accessibility === true;
        capsCache = {
            platform: 'darwin',
            desktop: 'macOS',
            osVersion: (hello.platform && hello.platform.version) || '',
            helper: connected,
            helperVersion: hello.version || null,
            accessibility,
            automation: false,
            keysReady: connected && accessibility,
            wayland: false, ydotool: false, xdotool: false, kdotool: false, busctl: false, qdbus: null, hyprland: false, sway: false
        };
        capsAt = Date.now();
        return capsCache;
    }

    // Permissão pode mudar sem reconexão: a cada sondagem pede o estado atual ao helper (sem bloquear)
    function refreshPermissions() {
        if (!client.connected) return;
        client.request('permissions.status', {}).then((p) => {
            if (client.hello) client.hello.permissions = p;
            probe();
        }).catch(() => {});
    }

    client.on('connected', () => probe());
    client.on('disconnected', () => probe());

    return {
        shortcut(combo) { return call('key.shortcut', { keys: splitCombo(combo) }, `atalho ${combo}`); },
        keyDown(combo) { return call('key.down', { keys: splitCombo(combo) }, `segurar ${combo}`); },
        keyUp(combo) { return call('key.up', { keys: splitCombo(combo) }, `soltar ${combo}`); },
        mediaKey(name) {
            if (!MEDIA_KEYS.has(name)) return Promise.resolve(false);
            return call('key.media', { name }, `tecla de mídia ${name}`);
        },
        capabilities(force = false) {
            if (force || !capsCache || (Date.now() - capsAt) >= CAPS_TTL_MS) { probe(); refreshPermissions(); }
            return capsCache;
        },
        capabilitiesStale() { return !capsCache || (Date.now() - capsAt) >= CAPS_TTL_MS; },
        capabilitiesCached() { return capsCache || probe(); },
        hostVisibleTmpDir() { return os.tmpdir(); }
    };
}

module.exports = { createKeys, splitCombo };
