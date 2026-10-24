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
                { index: 3, title: 'Discord', icon: icons.discord, actionId: 'discord:open', borderColor: '#5865F2' },
                { index: 4, title: '' },

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

    get rpc() {
        return this.ctx && this.ctx.discordRpc;
    }

    rpcReady() {
        return !!(this.rpc && this.rpc.ready);
    }

    /** Estado real vindo do Discord (IPC). */
    applyVoice(v) {
        if (!v) return;
        this.isMuted = !!v.mute;
        this.isDeafened = !!v.deaf;
        this.refreshKeys();
    }

    /** Bloco "Sala de voz": sala atual, meu estado e quem está nela (modo meters: barra cheia = falando). */
    roomKey(key) {
        const room = this.rpc ? this.rpc.roomSnapshot() : { available: false, members: [] };
        const base = { statMode: 'meters', statColor: '#5865F2', statHistory: null, statBars: null, statSub: null, statPercent: null, badge: null, active: false };
        if (!room.available) return { ...base, statLabel: 'Discord', statHead: 'sem API', statRows: [{ k: 'Configure em Ajustes', sub: '', v: '', pct: 0 }], title: 'Discord' };
        if (!room.inVoice) return { ...base, statLabel: 'Discord', statHead: 'fora de chamada', statRows: [], title: 'Discord' };
        const rowSpan = Math.max(1, parseInt(key && key.rowSpan, 10) || 1);
        const max = rowSpan * 3 + (rowSpan > 1 ? 1 : 0);      // 3 nomes numa tecla simples, 7 numa 2x2
        const me = room.members.find((m) => m.me);
        const rows = room.members.slice(0, max).map((m) => ({
            k: m.me ? 'Você' : m.name,
            sub: m.speaking ? 'falando' : (m.deaf ? 'surdo' : (m.mute ? 'mudo' : '')),
            v: '',
            pct: m.speaking ? 100 : 0,
            color: m.speaking ? '#22C55E' : '#374151'
        }));
        if (room.members.length > max) rows[max - 1] = { k: `+${room.members.length - max + 1} pessoas`, sub: '', v: '', pct: 0, color: '#374151' };
        const speaking = room.members.filter((m) => m.speaking && !m.me).length;
        return {
            ...base,
            statLabel: room.channelName,
            statHead: `${room.members.length} na sala`,
            statRows: rows,
            statColor: me && me.speaking ? '#22C55E' : '#5865F2',
            badge: me ? (me.deaf ? 'SURDO' : (me.mute ? 'MUDO' : null)) : null,
            badgeColor: '#7F1D1D',
            active: speaking > 0,
            title: room.channelName
        };
    }

    getStatus() {
        const st = this.rpc ? this.rpc.getStatus() : { connected: false, authenticated: false, needsSetup: true };
        return { ...st, muted: this.isMuted, deafened: this.isDeafened, mode: st.authenticated ? 'ipc' : 'keyboard' };
    }

    /** Mute/surdo pela API; devolve false quando a API não está disponível (cai para o atalho). */
    async rpcVoice(field, value) {
        if (!this.rpcReady()) return false;
        try {
            if (field === 'mute') await this.rpc.setMute(value); else await this.rpc.setDeaf(value);
            return true;
        } catch (e) {
            console.log(`[Discord] IPC falhou (${e.message}); usando atalho de teclado`);
            return false;
        }
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

    /** Solta o push-to-talk se o tablet sumiu com a tecla pressionada (mic não fica aberto). */
    releaseHeld() {
        if (this.pttHeld) this.handleAction('discord:ptt', 'keyUp');
    }

    handleAction(actionId, eventType) {
        const cfg = this.getConfig();

        // PTT precisa de keyDown e keyUp
        if (actionId === 'discord:ptt') {
            // Pela API (Discord em modo de voz por atividade): segurar = desmutar, soltar = mutar.
            // Em modo Push to Talk no Discord, ou sem API, segura a tecla de atalho configurada.
            if (eventType === 'keyDown' && !this.pttHeld) {
                this.pttHeld = true;
                // Decidido ao apertar e mantido até soltar, para não desmutar pela API e "soltar" pelo teclado
                this.pttViaRpc = !!(this.rpcReady() && this.rpc.voice && this.rpc.voice.mode !== 'PUSH_TO_TALK');
                this.ctx.updateKey('discord', 2, { bgColor: '#16A34A', borderColor: '#4ADE80', badge: 'FALANDO', badgeColor: '#14532D', active: true });
                if (this.pttViaRpc) this.rpcVoice('mute', false); else SystemActions.keyHold(cfg.pttKey);
            } else if (eventType === 'keyUp' && this.pttHeld) {
                this.pttHeld = false;
                this.ctx.updateKey('discord', 2, { bgColor: '#1C1D25', borderColor: '#2D303E', badge: 'PTT', badgeColor: '#5865F2', active: false });
                if (this.pttViaRpc) this.rpcVoice('mute', true); else SystemActions.keyRelease(cfg.pttKey);
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
                // API primeiro (funciona com o Discord na bandeja e devolve o estado real);
                // sem API, estado otimista: só alterna se o atalho foi enviado com a janela focada
                this.rpcVoice('mute', !this.isMuted).then((done) => {
                    if (done) return;
                    return this.sendShortcut(cfg.muteKey).then((sent) => {
                        if (sent) {
                            this.isMuted = !this.isMuted;
                            if (!this.isMuted && this.isDeafened) this.isDeafened = false; // desmutar no Discord também remove o "surdo"
                            this.refreshKeys();
                        }
                    });
                });
                break;

            case 'discord:toggle_deafen':
                this.rpcVoice('deaf', !this.isDeafened).then((done) => {
                    if (done) return;
                    return this.sendShortcut(cfg.deafenKey).then((sent) => {
                        if (sent) {
                            this.isDeafened = !this.isDeafened;
                            if (this.isDeafened) this.isMuted = true; // ensurdecer no Discord também muta o mic
                            this.refreshKeys();
                        }
                    });
                });
                break;

            case 'discord:voice_room':
                // Indicador: o toque só relê a sala
                if (this.rpcReady()) this.rpc.loadChannel().catch(() => {});
                break;

            case 'discord:focus':
            case 'discord:open':
                // Um toque só: traz a janela para a frente; se não há janela (fechado ou na bandeja), abre o Discord
                SystemActions.focusWindow(DISCORD_WINDOW).then((focused) => { if (!focused) this.openDiscord(); });
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
