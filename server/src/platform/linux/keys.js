// Teclas no Linux: adaptador fino sobre SystemActions (ydotool no Wayland, xdotool no X11).
// Mantém os comandos exatamente como eram; só muda quem chama.
const SystemActions = require('../../actions/systemActions');
const { exec, which } = require('../../hostExec');

const CMD_TIMEOUT_MS = 4000;

// playerctl (MPRIS) é mais confiável que teclas de mídia emuladas; usa só um dos dois
const MEDIA_KEYS = {
    play_pause: { playerctl: 'play-pause', key: 'XF86AudioPlay' },
    next: { playerctl: 'next', key: 'XF86AudioNext' },
    prev: { playerctl: 'previous', key: 'XF86AudioPrev' }
};

function createKeys() {
    const hasPlayerctl = !!which('playerctl');
    return {
        shortcut(combo) { return SystemActions.sendKey(combo); },
        keyDown(combo) { return SystemActions.keyHold(combo); },
        keyUp(combo) { return SystemActions.keyRelease(combo); },
        mediaKey(name) {
            const m = MEDIA_KEYS[name];
            if (!m) return Promise.resolve(false);
            if (!hasPlayerctl) return SystemActions.sendKey(m.key);
            return new Promise((resolve) => {
                exec(`playerctl ${m.playerctl}`, { timeout: CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
                    if (err) console.log(`[Keys] playerctl ${m.playerctl} falhou: ${String(stderr || err.message).trim().split('\n')[0]}`);
                    resolve(!err);
                });
            });
        },
        capabilities(force = false) {
            const caps = SystemActions.capabilities(force);
            return caps ? { ...caps, keysReady: !!(caps.ydotool || caps.xdotool) } : caps;
        },
        capabilitiesStale() { return SystemActions.capabilitiesStale(); },
        capabilitiesCached() {
            const caps = SystemActions.capabilitiesCached();
            return caps ? { ...caps, keysReady: !!(caps.ydotool || caps.xdotool) } : caps;
        },
        hostVisibleTmpDir() { return SystemActions.hostVisibleTmpDir(); }
    };
}

module.exports = { createKeys };
