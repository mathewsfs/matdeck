// Implementação macOS da camada de plataforma: tudo passa pelo MatDeck Helper (app nativo em Swift)
// por um socket Unix. Mídia e telemetria chegam na fase 3 (stubs aqui).
const os = require('os');
const path = require('path');
const fs = require('fs');
const { HelperClient } = require('./helperClient');
const { createKeys } = require('./keys');
const { createWindows } = require('./windows');
const { createApps } = require('./apps');
const { createAudio } = require('./audio');
const { createTray } = require('./tray');
const { createSession } = require('./session');
const { StubSpotify, StubMediaPlayers, StubHardwareMonitor } = require('./stubs');

const APP_NAME = 'MatDeck Helper.app';

function defaultSocketPath() {
    return process.env.MATDECK_HELPER_SOCKET || path.join(os.homedir(), 'Library', 'Application Support', 'MatDeck', 'helper.sock');
}

/** MATDECK_HELPER_APP, senão o .app em /Applications ou ~/Applications (instalação) ou ao lado do servidor (desenvolvimento). */
function defaultAppPath() {
    if (process.env.MATDECK_HELPER_APP) return process.env.MATDECK_HELPER_APP;
    const candidates = [
        path.join('/Applications', APP_NAME),
        path.join(os.homedir(), 'Applications', APP_NAME),
        path.resolve(__dirname, '../../../../macos/MatDeckHelper/dist', APP_NAME)
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
}

function create(options = {}) {
    const helper = new HelperClient({ socketPath: defaultSocketPath(), appPath: defaultAppPath() });
    const keys = createKeys(helper);
    const windows = createWindows(helper, keys);
    const apps = createApps(helper);
    const audio = createAudio(helper);
    const tray = createTray(helper, { openUrl: (url) => apps.open(url) });
    // A linha de sessão do início sai antes do helper responder; repete quando ele conecta (ou cai)
    helper.on('connected', () => {
        keys.capabilities(true);
        // Primeira vez num Mac: o sistema só mostra o diálogo de Acessibilidade se alguém pedir
        const perms = (helper.hello && helper.hello.permissions) || {};
        if (perms.accessibility === false) {
            helper.request('permissions.request', { kind: 'accessibility' })
                .then((r) => { if (!(r && r.granted)) console.log('[Platform] Acessibilidade ainda não concedida: ligue "MatDeck Helper" em Ajustes do Sistema › Privacidade e Segurança › Acessibilidade'); })
                .catch((e) => console.log(`[Platform] Pedido de Acessibilidade falhou: ${e.message || e.code}`));
        }
        setTimeout(() => console.log(`[Platform] ${platform.describe()}`), 300);
    });
    helper.on('disconnected', () => console.log('[Platform] Helper desconectado; teclas, foco e volume ficam indisponíveis até ele voltar'));
    helper.start();

    const platform = {
        name: 'darwin',
        helper,
        keys,
        windows,
        apps,
        audio,
        media: { spotify: new StubSpotify(), players: new StubMediaPlayers() },
        hardware: new StubHardwareMonitor(options.hardwareIntervalMs || 1000),
        tray,
        session: createSession(keys),

        describe() {
            const caps = keys.capabilitiesCached() || {};
            const version = (helper.hello && helper.hello.platform && helper.hello.platform.version) || caps.osVersion || '?';
            return `Sessão: macOS ${version} | helper: ${helper.connected ? 'conectado' : 'ausente'} | Acessibilidade: ${caps.accessibility ? 'ok' : 'NEGADA'}`;
        }
    };
    return platform;
}

module.exports = { create, defaultSocketPath, defaultAppPath };
