const icons = require('../icons.json');

/**
 * Segunda tela do hub: perfis completos, mídia, apps e sistema.
 * As ações aqui são roteadas pelo index.js (switch:, media:, launch:, system:, toggle:).
 */
class MoreProfile {
    constructor(serverContext) {
        this.ctx = serverContext;
    }

    getDefinition() {
        const auto = this.ctx.autoDetectEnabled;
        return {
            id: 'more',
            name: 'Mais opções',
            rows: 3,
            cols: 5,
            keys: [
                // Linha 1: perfis completos de cada app
                { index: 0, title: 'OBS Studio', icon: icons.obs, actionId: 'switch:obs', borderColor: '#3B82F6' },
                { index: 1, title: 'Discord', icon: icons.discord, actionId: 'switch:discord', borderColor: '#5865F2' },
                { index: 2, title: 'TeamSpeak', icon: icons.teamspeak, actionId: 'switch:teamspeak', borderColor: '#2580C3' },
                { index: 3, title: 'Google Meet', icon: icons.meet, actionId: 'switch:meet', borderColor: '#00AC47' },
                { index: 4, title: auto ? 'Auto-Perfil ON' : 'Auto-Perfil OFF', icon: icons.auto, badge: 'AUTO', badgeColor: auto ? '#3B82F6' : '#6B7280', actionId: 'toggle:auto', active: auto },

                // Linha 2: mídia e mixer
                { index: 5, title: 'Vol +', icon: icons.vol_up, actionId: 'media:vol_up' },
                { index: 6, title: 'Vol -', icon: icons.vol_down, actionId: 'media:vol_down' },
                { index: 7, title: 'Spotify', icon: icons.spotify, actionId: 'switch:spotify', borderColor: '#1DB954' },
                { index: 8, title: 'Próxima Faixa', icon: icons.next, actionId: 'media:next' },
                { index: 9, title: 'Nextcloud Talk', icon: icons.nextcloud, actionId: 'switch:nextcloud', borderColor: '#0082C9' },

                // Linha 3: apps, sistema e voltar
                { index: 10, title: 'Navegador', icon: icons.browser, actionId: 'launch:browser' },
                { index: 11, title: 'Calculadora', icon: icons.calc, actionId: 'launch:calc' },
                { index: 12, title: 'Terminal', icon: icons.terminal, actionId: 'launch:term' },
                { index: 13, title: 'Bloquear PC', icon: icons.lock, actionId: 'system:lock', badgeColor: '#EF4444' },
                { index: 14, title: 'Voltar', icon: icons.home, actionId: 'switch:default', borderColor: '#4F8CFF' }
            ]
        };
    }

    handleAction() {
        // Todas as ações desta tela são tratadas pelo roteador central.
    }
}

module.exports = MoreProfile;
