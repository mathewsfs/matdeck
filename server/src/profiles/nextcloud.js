const icons = require('../icons.json');
const { forPlatform } = require('../platform/shortcuts');

// Atalhos do Talk por plataforma (letras iguais; só a busca troca Ctrl por Cmd no Mac)
const SHORTCUTS = {
    linux: { mic: 'm', camera: 'v', hand: 'r', fullscreen: 'f', chat: 'c', search: 'ctrl+f', home: 'escape' },
    darwin: { mic: 'm', camera: 'v', hand: 'r', fullscreen: 'f', chat: 'c', search: 'cmd+f', home: 'escape' }
};
const KEYS = forPlatform(SHORTCUTS);

/**
 * Nextcloud Talk (web ou app desktop Electron "Nextcloud Talk", flatpak com.nextcloud.talk).
 *
 * O Talk não expõe API para mutar o próprio microfone (o mudo é local, no WebRTC do cliente),
 * então o MatDeck foca a janela e envia os atalhos oficiais do Talk, confirmados no código do
 * spreed: M (microfone), V (câmera), R (levantar a mão), F (tela cheia), C (foco no chat),
 * Ctrl+F (busca). Os atalhos são ignorados quando um campo de texto ou modal está em foco.
 * Não existe atalho para sair da chamada nem para compartilhar tela.
 */
const TALK_WINDOW = {
    // Título da aba/janela: "<sala> - Talk - Nextcloud" no navegador, "Nextcloud Talk" no app desktop
    titleHints: ['Talk'],
    classHints: ['com.nextcloud.talk', 'nextcloud talk', 'nextcloud-talk', 'brave-browser', 'google-chrome', 'chromium', 'firefox', 'org.mozilla.firefox', 'microsoft-edge', 'vivaldi'],
    requireTitle: true
};

const DEFAULT_CONFIG = {
    url: '',              // ex.: https://cloud.exemplo.com/apps/spreed  (tecla "Abrir Talk")
    focusDelayMs: 150
};

class NextcloudProfile {
    constructor(serverContext) {
        this.ctx = serverContext;
        this.micMuted = false;
        this.camOff = false;
        this.handRaised = false;
    }

    getConfig() {
        let cfg = {};
        try {
            if (this.ctx && this.ctx.config && typeof this.ctx.config.get === 'function') cfg = this.ctx.config.get('nextcloud') || {};
        } catch (e) { /* usa defaults */ }
        return Object.assign({}, DEFAULT_CONFIG, cfg);
    }

    getStatus() {
        return { configured: !!this.getConfig().url, micMuted: this.micMuted, camOff: this.camOff, handRaised: this.handRaised };
    }

    getDefinition() {
        return {
            id: 'nextcloud',
            name: 'Nextcloud Talk',
            rows: 3,
            cols: 5,
            keys: [
                // Linha 1 — chamada (atalhos do Talk; a janela é focada antes de enviar)
                { index: 0, ...this.micKey() },
                { index: 1, ...this.camKey() },
                { index: 2, ...this.handKey() },
                { index: 3, title: 'Tela Cheia', icon: icons.open, actionId: 'nc:fullscreen', badge: 'F', badgeColor: '#4B5563' },
                { index: 4, title: 'Focar Talk', icon: icons.nextcloud, actionId: 'nc:focus', borderColor: '#0082C9' },

                // Linha 2 — chat e navegação
                { index: 5, title: 'Chat', icon: icons.chat, actionId: 'nc:chat', badge: 'C', badgeColor: '#4B5563' },
                { index: 6, title: 'Buscar', icon: icons.grid, actionId: 'nc:search', badge: 'Ctrl+F', badgeColor: '#4B5563' },
                { index: 7, title: 'Início', icon: icons.home, actionId: 'nc:home', badge: 'Esc', badgeColor: '#4B5563' },
                { index: 8, title: 'Abrir Talk', icon: icons.nextcloud, actionId: 'nc:open', borderColor: '#0082C9' },
                { index: 9, title: 'Reiniciar estado', icon: icons.auto, actionId: 'nc:reset' },

                // Linha 3 — áudio do PC + voltar
                { index: 10, title: 'Vol +', icon: icons.vol_up, actionId: 'media:vol_up' },
                { index: 11, title: 'Vol -', icon: icons.vol_down, actionId: 'media:vol_down' },
                { index: 12, title: 'Mudo PC', icon: icons.volume_mute, actionId: 'media:mute' },
                { index: 13, title: 'Mic Meet', icon: icons.mic_on, actionId: 'meet:mute_mic', borderColor: '#00AC47' },
                { index: 14, title: 'Principal', icon: icons.home, actionId: 'switch:default', borderColor: '#3B82F6' }
            ]
        };
    }

    micKey() {
        return {
            title: this.micMuted ? 'Mic MUTADO' : 'Microfone',
            icon: this.micMuted ? icons.mic_muted : icons.mic_on,
            actionId: 'nc:mute_mic',
            titleColor: '#FFFFFF',
            bgColor: this.micMuted ? '#DC2626' : '#1C1D25',
            borderColor: this.micMuted ? '#F87171' : '#2D303E',
            badge: this.micMuted ? 'MUDO' : 'M',
            badgeColor: this.micMuted ? '#7F1D1D' : '#4B5563',
            active: this.micMuted
        };
    }

    camKey() {
        return {
            title: this.camOff ? 'Câmera DESL' : 'Câmera',
            icon: this.camOff ? icons.cam_muted : icons.cam_on,
            actionId: 'nc:camera',
            titleColor: '#FFFFFF',
            bgColor: this.camOff ? '#DC2626' : '#1C1D25',
            borderColor: this.camOff ? '#F87171' : '#2D303E',
            badge: this.camOff ? 'OFF' : 'V',
            badgeColor: this.camOff ? '#7F1D1D' : '#4B5563',
            active: this.camOff
        };
    }

    handKey() {
        return {
            title: this.handRaised ? 'MÃO LEVANTADA' : 'Levantar Mão',
            icon: icons.hand,
            actionId: 'nc:hand',
            titleColor: '#FFFFFF',
            bgColor: this.handRaised ? '#D97706' : '#1C1D25',
            borderColor: this.handRaised ? '#FBBF24' : '#2D303E',
            badge: this.handRaised ? 'MÃO' : 'R',
            badgeColor: this.handRaised ? '#78350F' : '#4B5563',
            active: this.handRaised
        };
    }

    async sendShortcut(combo) {
        return this.ctx.platform.windows.focusAndSend(TALK_WINDOW, combo, this.getConfig().focusDelayMs)
            .catch((e) => { console.log(`[Nextcloud] Falha ao enviar ${combo}: ${e.message}`); return false; });
    }

    refreshKeys() {
        this.ctx.updateKey('nextcloud', 0, this.micKey());
        this.ctx.updateKey('nextcloud', 1, this.camKey());
        this.ctx.updateKey('nextcloud', 2, this.handKey());
    }

    handleAction(actionId, eventType) {
        if (eventType !== 'keyDown') return;

        if (actionId.startsWith('media:') || actionId.startsWith('launch:') || actionId.startsWith('switch:')) {
            const def = this.ctx.profiles && this.ctx.profiles.get('default');
            if (def) def.handleAction(actionId, eventType);
            return;
        }
        if (actionId.startsWith('meet:')) {
            const meet = this.ctx.profiles && this.ctx.profiles.get('meet');
            if (meet) meet.handleAction(actionId, eventType);
            return;
        }

        switch (actionId) {
            case 'nc:mute_mic':
                // Estado otimista: só alterna se o atalho foi enviado com a janela do Talk focada
                this.sendShortcut(KEYS.mic).then((sent) => {
                    if (!sent) return;
                    this.micMuted = !this.micMuted;
                    this.ctx.updateKey('nextcloud', 0, this.micKey());
                });
                break;
            case 'nc:camera':
                this.sendShortcut(KEYS.camera).then((sent) => {
                    if (!sent) return;
                    this.camOff = !this.camOff;
                    this.ctx.updateKey('nextcloud', 1, this.camKey());
                });
                break;
            case 'nc:hand':
                this.sendShortcut(KEYS.hand).then((sent) => {
                    if (!sent) return;
                    this.handRaised = !this.handRaised;
                    this.ctx.updateKey('nextcloud', 2, this.handKey());
                });
                break;
            case 'nc:fullscreen':
                this.sendShortcut(KEYS.fullscreen);
                break;
            case 'nc:chat':
                this.sendShortcut(KEYS.chat);
                break;
            case 'nc:search':
                this.sendShortcut(KEYS.search);
                break;
            case 'nc:home':
                this.sendShortcut(KEYS.home);
                break;
            case 'nc:focus':
                this.ctx.platform.windows.focus(TALK_WINDOW);
                break;
            case 'nc:open': {
                const url = this.getConfig().url;
                if (url) this.ctx.platform.apps.open(url);
                else {
                    console.log('[Nextcloud] Defina nextcloud.url em Ajustes para a tecla "Abrir Talk"');
                    if (typeof this.ctx.notify === 'function') this.ctx.notify({ title: 'Nextcloud Talk', text: 'Informe o endereço do Talk em Ajustes → Nextcloud Talk.', level: 'warn' });
                }
                break;
            }
            case 'nc:reset':
                // O estado é otimista (não há API para ler mudo/câmera); isto realinha com a realidade
                this.micMuted = false;
                this.camOff = false;
                this.handRaised = false;
                this.refreshKeys();
                break;
            default:
                console.log(`[Nextcloud] Ação desconhecida: ${actionId}`);
        }
    }
}

module.exports = NextcloudProfile;
module.exports.SHORTCUTS = SHORTCUTS;
