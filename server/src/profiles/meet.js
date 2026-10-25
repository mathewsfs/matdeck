const icons = require('../icons.json');
const { forPlatform } = require('../platform/shortcuts');

// Atalhos do próprio Meet por plataforma (no Mac o Meet usa Cmd no lugar de Ctrl, e Ctrl+Cmd para painéis)
const SHORTCUTS = {
    linux: { mic: 'ctrl+d', camera: 'ctrl+e', hand: 'ctrl+alt+h', captions: 'c', chat: 'ctrl+alt+c', people: 'ctrl+alt+p', shortcuts: 'ctrl+slash', fullscreen: 'f11', leave: 'ctrl+w' },
    darwin: { mic: 'cmd+d', camera: 'cmd+e', hand: 'ctrl+cmd+h', captions: 'c', chat: 'ctrl+cmd+c', people: 'ctrl+cmd+p', shortcuts: 'cmd+slash', fullscreen: 'ctrl+cmd+f', leave: 'cmd+w' }
};
const KEYS = forPlatform(SHORTCUTS);

// O título precisa conter "Meet" (requireTitle): sem isso o fallback por classe focaria qualquer janela do
// navegador e Ctrl+D viraria "adicionar favorito". classHints só desempatam entre janelas com "Meet" no título.
const MEET_WINDOW = {
    titleHints: ['Meet'],
    classHints: ['brave-browser', 'google-chrome', 'chromium', 'firefox', 'org.mozilla.firefox', 'microsoft-edge', 'vivaldi'],
    requireTitle: true
};

const DEFAULT_CONFIG = {
    allowCloseTab: false, // se true, a tecla "Sair" envia Ctrl+W na aba do Meet
    focusDelayMs: 150
};

class MeetProfile {
    constructor(serverContext) {
        this.ctx = serverContext;
        this.micMuted = false;
        this.camOff = false;
        this.handRaised = false;
    }

    getConfig() {
        let cfg = {};
        try {
            if (this.ctx && this.ctx.config && typeof this.ctx.config.get === 'function') {
                cfg = this.ctx.config.get('meet') || {};
            }
        } catch (e) { /* usa defaults */ }
        return Object.assign({}, DEFAULT_CONFIG, cfg);
    }

    getDefinition() {
        const cfg = this.getConfig();
        const leaveKey = cfg.allowCloseTab
            ? { index: 4, title: 'Fechar Aba', icon: icons.hangup, actionId: 'meet:leave', badge: 'SAIR', badgeColor: '#EF4444' }
            : { index: 4, title: 'Focar Meet', icon: icons.focus, actionId: 'meet:focus', borderColor: '#10B981' };

        return {
            id: 'meet',
            name: 'Google Meet',
            rows: 3,
            cols: 5,
            keys: [
                // Linha 1 — controles da chamada (atalhos do Meet; a aba é focada antes de enviar)
                { index: 0, ...this.micKey() },
                { index: 1, ...this.camKey() },
                { index: 2, ...this.handKey() },
                { index: 3, title: 'Legendas', icon: icons.captions, actionId: 'meet:captions', badge: 'C', badgeColor: '#4B5563' },
                leaveKey,

                // Linha 2 — painéis
                { index: 5, title: 'Chat', icon: icons.chat, actionId: 'meet:chat' },
                { index: 6, title: 'Participantes', icon: icons.people, actionId: 'meet:people' },
                { index: 7, title: 'Atalhos', icon: icons.settings, actionId: 'meet:shortcuts', badge: 'Ctrl+/', badgeColor: '#4B5563' },
                { index: 8, title: 'Tela Cheia', icon: icons.open, actionId: 'meet:fullscreen', badge: 'F11', badgeColor: '#4B5563' },
                { index: 9, title: 'Abrir Meet', icon: icons.meet, actionId: 'meet:open', borderColor: '#10B981' },

                // Linha 3 — áudio do PC + voltar
                { index: 10, title: 'Vol +', icon: icons.vol_up, actionId: 'media:vol_up' },
                { index: 11, title: 'Vol -', icon: icons.vol_down, actionId: 'media:vol_down' },
                { index: 12, title: 'Mudo PC', icon: icons.volume_mute, actionId: 'media:mute' },
                { index: 13, title: 'Focar Meet', icon: icons.focus, actionId: 'meet:focus' },
                { index: 14, title: 'Principal', icon: icons.home, actionId: 'switch:default', borderColor: '#3B82F6' }
            ]
        };
    }

    micKey() {
        return {
            title: this.micMuted ? 'Mic MUTADO' : 'Microfone',
            icon: this.micMuted ? icons.mic_muted : icons.mic_on,
            actionId: 'meet:mute_mic',
            titleColor: '#FFFFFF',
            bgColor: this.micMuted ? '#DC2626' : '#1C1D25',
            borderColor: this.micMuted ? '#F87171' : '#2D303E',
            badge: this.micMuted ? 'MUDO' : null,
            badgeColor: '#7F1D1D',
            active: this.micMuted
        };
    }

    camKey() {
        return {
            title: this.camOff ? 'Câmera DESL' : 'Câmera',
            icon: this.camOff ? icons.cam_muted : icons.cam_on,
            actionId: 'meet:camera',
            titleColor: '#FFFFFF',
            bgColor: this.camOff ? '#DC2626' : '#1C1D25',
            borderColor: this.camOff ? '#F87171' : '#2D303E',
            badge: this.camOff ? 'OFF' : null,
            badgeColor: '#7F1D1D',
            active: this.camOff
        };
    }

    handKey() {
        return {
            title: this.handRaised ? 'MÃO LEVANTADA' : 'Levantar Mão',
            icon: icons.hand,
            actionId: 'meet:hand',
            titleColor: '#FFFFFF',
            bgColor: this.handRaised ? '#D97706' : '#1C1D25',
            borderColor: this.handRaised ? '#FBBF24' : '#2D303E',
            badge: this.handRaised ? 'MÃO' : null,
            badgeColor: '#78350F',
            active: this.handRaised
        };
    }

    async sendShortcut(combo) {
        return this.ctx.platform.windows.focusAndSend(MEET_WINDOW, combo, this.getConfig().focusDelayMs)
            .catch((e) => { console.log(`[Meet] Falha ao enviar ${combo}: ${e.message}`); return false; });
    }

    handleAction(actionId, eventType) {
        if (eventType !== 'keyDown') return;

        if (actionId.startsWith('media:') || actionId.startsWith('launch:') || actionId.startsWith('switch:')) {
            const def = this.ctx.profiles && this.ctx.profiles.get('default');
            if (def) def.handleAction(actionId, eventType);
            return;
        }

        switch (actionId) {
            case 'meet:mute_mic':
                // Estado otimista: só alterna se o atalho foi enviado com a aba do Meet focada
                this.sendShortcut(KEYS.mic).then((sent) => {
                    if (!sent) return;
                    this.micMuted = !this.micMuted;
                    this.ctx.updateKey('meet', 0, this.micKey());
                });
                break;

            case 'meet:camera':
                this.sendShortcut(KEYS.camera).then((sent) => {
                    if (!sent) return;
                    this.camOff = !this.camOff;
                    this.ctx.updateKey('meet', 1, this.camKey());
                });
                break;

            case 'meet:hand':
                this.sendShortcut(KEYS.hand).then((sent) => {
                    if (!sent) return;
                    this.handRaised = !this.handRaised;
                    this.ctx.updateKey('meet', 2, this.handKey());
                });
                break;

            case 'meet:captions':
                this.sendShortcut(KEYS.captions);
                break;

            case 'meet:chat':
                this.sendShortcut(KEYS.chat);
                break;

            case 'meet:people':
                this.sendShortcut(KEYS.people);
                break;

            case 'meet:shortcuts':
                this.sendShortcut(KEYS.shortcuts);
                break;

            case 'meet:fullscreen':
                this.sendShortcut(KEYS.fullscreen);
                break;

            case 'meet:leave':
                if (this.getConfig().allowCloseTab) {
                    this.sendShortcut(KEYS.leave).then((sent) => {
                        if (sent) {
                            this.micMuted = false;
                            this.camOff = false;
                            this.handRaised = false;
                        }
                    });
                } else {
                    console.log('[Meet] "Sair" desabilitado: defina meet.allowCloseTab=true na config para fechar a aba com Ctrl+W');
                    this.ctx.platform.windows.focus(MEET_WINDOW);
                }
                break;

            case 'meet:focus':
                this.ctx.platform.windows.focus(MEET_WINDOW);
                break;

            case 'meet:open':
                this.ctx.platform.apps.open('https://meet.google.com/');
                break;

            default:
                console.log(`[Meet] Ação desconhecida: ${actionId}`);
        }
    }
}

module.exports = MeetProfile;
module.exports.SHORTCUTS = SHORTCUTS;
