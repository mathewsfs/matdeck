// Implementação Linux da camada de plataforma: monta as áreas a partir dos módulos existentes
// (ydotool/xdotool, KWin/kdotool, pactl, busctl/MPRIS, /sys + nvidia-smi, bandeja em PySide6).
const { createKeys } = require('./keys');
const { createWindows } = require('./windows');
const { createApps } = require('./apps');
const { createSystem } = require('./system');
const AudioMixer = require('../../audioMixer');
const SpotifyMonitor = require('../../spotify');
const MediaPlayers = require('../../mediaPlayers');
const HardwareMonitor = require('../../hardwareMonitor');
const TrayIndicator = require('../../tray');

function create(options = {}) {
    const keys = createKeys();
    const windows = createWindows();
    const system = createSystem();
    let tray = null;

    const platform = {
        name: 'linux',
        keys,
        windows,
        apps: createApps(),
        audio: {
            mixer: new AudioMixer(),
            masterStep: (delta) => system.masterStep(delta),
            masterMuteToggle: () => system.masterMuteToggle()
        },
        media: {
            spotify: new SpotifyMonitor(),
            players: new MediaPlayers()
        },
        hardware: new HardwareMonitor(options.hardwareIntervalMs || 1000),
        tray: {
            /** Ícone na bandeja (scripts/matdeck-tray.py). Desative com ui.tray=false ou MATDECK_TRAY=0. */
            start({ port, lanIp, enabled = true }) {
                tray = new TrayIndicator({ port, lanIp, enabled });
                tray.start();
            },
            stop() { return tray ? tray.stop() : Promise.resolve(); }
        },
        session: { lock: () => system.lock() },

        /** Linha de sessão do log de início: compositor, desktop, teclas, foco e detecção de janela. */
        describe() {
            const caps = keys.capabilitiesCached() || {};
            const teclas = caps.ydotool ? 'ydotool' : (caps.xdotool ? 'xdotool' : 'INDISPONÍVEL');
            const foco = caps.kdotool ? 'kdotool' : (caps.qdbus ? 'KWin script' : (caps.xdotool ? 'xdotool' : 'INDISPONÍVEL'));
            return `Sessão: ${caps.wayland ? 'Wayland' : 'X11'} ${caps.desktop || ''} | teclas: ${teclas} | foco de janela: ${foco} | detecção de janela: ${windows.detector.describe()}`;
        }
    };
    return platform;
}

module.exports = { create };
