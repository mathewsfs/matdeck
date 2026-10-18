const icons = require('../icons.json');
const SystemActions = require('../actions/systemActions');

const DISCORD_FLATPAK = 'com.discordapp.Discord';
const DISCORD_WINDOW = { classHints: ['discord', 'com.discordapp.discord'], titleHints: ['Discord'] };

const DEFAULT_CONFIG = {
    pttKey: 'ctrl+shift+p',      // o usuário precisa configurar o MESMO atalho em Discord > Voz e Vídeo > Push to Talk
    muteKey: 'ctrl+shift+m',     // atalho padrão do Discord (Toggle Mute)
    deafenKey: 'ctrl+shift+d',   // atalho padrão do Discord (Toggle Deafen)
    focusDelayMs: 150
};

class DiscordProfile {
    constructor(serverContext) {
        this.ctx = serverContext;
        this.isMuted = false;
        this.isDeafened = false;
        this.pttHeld = false;
    }

    getConfig() {
        let cfg = {};
        try {
            if (this.ctx && this.ctx.config && typeof this.ctx.config.get === 'function') {
                cfg = this.ctx.config.get('discord') || {};
            }
        } catch (e) { /* usa defaults */ }
        return Object.assign({}, DEFAULT_CONFIG, cfg);
    }

    getDefinition() {
        return {
            id: 'discord',
            name: 'Discord',
            rows: 3,
            cols: 5,
            keys: [
                // Linha 1 — voz (atalhos padrão do Discord; precisam da janela focada, o perfil foca antes de enviar)
                { index: 0, ...this.micKey() },
                { index: 1, ...this.deafenKey() },
                { index: 2, title: 'Push to Talk', icon: icons.ptt, actionId: 'discord:ptt', badge: 'PTT', badgeColor: '#5865F2' },
                { index: 3, title: 'Focar Discord', icon: icons.focus, actionId: 'discord:focus' },
                { index: 4, title: 'Abrir Discord', icon: icons.discord, actionId: 'discord:open', borderColor: '#5865F2' },

                // Linha 2 — navegação (atalhos padrão do Discord)
                { index: 5, title: 'Busca Rápida', icon: icons.grid, actionId: 'discord:quick_switcher', badge: 'Ctrl+K', badgeColor: '#4B5563' },
                { index: 6, title: 'Caixa de Entrada', icon: icons.bell, actionId: 'discord:inbox', badge: 'Ctrl+I', badgeColor: '#4B5563' },
                { index: 7, title: 'Canal Anterior', icon: icons.prev, actionId: 'discord:prev_channel' },
                { index: 8, title: 'Próximo Canal', icon: icons.next, actionId: 'discord:next_channel' },
                { index: 9, title: 'Marcar Lido', icon: icons.chat, actionId: 'discord:mark_read', badge: 'Esc', badgeColor: '#4B5563' },

                // Linha 3 — áudio do PC + voltar
                { index: 10, title: 'Vol +', icon: icons.vol_up, actionId: 'media:vol_up' },
                { index: 11, title: 'Vol -', icon: icons.vol_down, actionId: 'media:vol_down' },
                { index: 12, title: 'Mudo PC', icon: icons.volume_mute, actionId: 'media:mute' },
                { index: 13, title: 'Play / Pause', icon: icons.play, actionId: 'media:play_pause' },
                { index: 14, title: 'Principal', icon: icons.home, actionId: 'switch:default', borderColor: '#3B82F6' }
            ]
        };
    }

    micKey() {
        return {
            title: this.isMuted ? 'Mic MUTADO' : 'Microfone',
            icon: this.isMuted ? icons.mic_muted : icons.mic_on,
            actionId: 'discord:toggle_mute',
            titleColor: '#FFFFFF',
            bgColor: this.isMuted ? '#DC2626' : '#1C1D25',
            borderColor: this.isMuted ? '#F87171' : '#2D303E',
            badge: this.isMuted ? 'MUDO' : null,
            badgeColor: '#7F1D1D',
            active: this.isMuted
        };
    }

    deafenKey() {
        return {
            title: this.isDeafened ? 'Som MUTADO' : 'Áudio',
            icon: this.isDeafened ? icons.headphone_off : icons.headphone,
            actionId: 'discord:toggle_deafen',
            titleColor: '#FFFFFF',
            bgColor: this.isDeafened ? '#DC2626' : '#1C1D25',
            borderColor: this.isDeafened ? '#F87171' : '#2D303E',
            badge: this.isDeafened ? 'SURDO' : null,
            badgeColor: '#7F1D1D',
            active: this.isDeafened
        };
    }

    refreshKeys() {
        this.ctx.updateKey('discord', 0, this.micKey());
        this.ctx.updateKey('discord', 1, this.deafenKey());
    }

    async sendShortcut(combo) {
        const cfg = this.getConfig();
        return SystemActions.focusAndSend(DISCORD_WINDOW, combo, cfg.focusDelayMs)
            .catch((e) => { console.log(`[Discord] Falha ao enviar ${combo}: ${e.message}`); return false; });
    }

    async openDiscord() {
        if (await SystemActions.flatpakInstalled(DISCORD_FLATPAK)) {
            return SystemActions.launchFile('flatpak', ['run', DISCORD_FLATPAK]);
        }
        if (SystemActions.commandExists('discord')) {
            return SystemActions.launchFile('discord', []);
        }
        return SystemActions.launchFile('xdg-open', ['discord://']);
    }

    handleAction(actionId, eventType) {
        const cfg = this.getConfig();

        // PTT precisa de keyDown e keyUp
        if (actionId === 'discord:ptt') {
            if (eventType === 'keyDown' && !this.pttHeld) {
                this.pttHeld = true;
                this.ctx.updateKey('discord', 2, { bgColor: '#16A34A', borderColor: '#4ADE80', badge: 'FALANDO', badgeColor: '#14532D', active: true });
                SystemActions.keyHold(cfg.pttKey);
            } else if (eventType === 'keyUp' && this.pttHeld) {
                this.pttHeld = false;
                this.ctx.updateKey('discord', 2, { bgColor: '#1C1D25', borderColor: '#2D303E', badge: 'PTT', badgeColor: '#5865F2', active: false });
                SystemActions.keyRelease(cfg.pttKey);
            }
            return;
        }

        if (eventType !== 'keyDown') return;

        // Ações genéricas tratadas pelo perfil principal
        if (actionId.startsWith('media:') || actionId.startsWith('launch:') || actionId.startsWith('switch:')) {
            const def = this.ctx.profiles && this.ctx.profiles.get('default');
            if (def) def.handleAction(actionId, eventType);
            return;
        }

        switch (actionId) {
            case 'discord:toggle_mute':
                // Estado otimista: só alterna se o atalho realmente foi enviado com a janela focada
                this.sendShortcut(cfg.muteKey).then((sent) => {
                    if (sent) {
                        this.isMuted = !this.isMuted;
                        if (!this.isMuted && this.isDeafened) this.isDeafened = false; // desmutar no Discord também remove o "surdo"
                        this.refreshKeys();
                    }
                });
                break;

            case 'discord:toggle_deafen':
                this.sendShortcut(cfg.deafenKey).then((sent) => {
                    if (sent) {
                        this.isDeafened = !this.isDeafened;
                        if (this.isDeafened) this.isMuted = true; // ensurdecer no Discord também muta o mic
                        this.refreshKeys();
                    }
                });
                break;

            case 'discord:focus':
                SystemActions.focusWindow(DISCORD_WINDOW);
                break;

            case 'discord:open':
                this.openDiscord();
                break;

            case 'discord:quick_switcher':
                this.sendShortcut('ctrl+k');
                break;

            case 'discord:inbox':
                this.sendShortcut('ctrl+i');
                break;

            case 'discord:prev_channel':
                this.sendShortcut('alt+up');
                break;

            case 'discord:next_channel':
                this.sendShortcut('alt+down');
                break;

            case 'discord:mark_read':
                this.sendShortcut('escape');
                break;

            default:
                console.log(`[Discord] Ação desconhecida: ${actionId}`);
        }
    }
}

module.exports = DiscordProfile;
