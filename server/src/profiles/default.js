const icons = require('../icons.json');

// Volume, mídia, programas e bloqueio passam pela camada de plataforma (ctx.platform): no Linux são os
// mesmos comandos de sempre (wpctl/pactl, playerctl ou teclas XF86, xdg-open, loginctl).
class DefaultProfile {
    constructor(serverContext) {
        this.ctx = serverContext;
    }

    getDefinition() {
        return {
            id: 'default',
            name: 'Principal',
            rows: 3,
            cols: 5,
            keys: [
                // Linha 1: TeamSpeak (estado real espelhado do perfil teamspeak)
                { index: 0, title: 'Mic TS', icon: icons.mic_on, actionId: 'ts:mute_mic' },
                { index: 1, title: 'Som TS', icon: icons.headphone, actionId: 'ts:mute_sound' },
                { index: 2, title: 'AFK', icon: icons.afk, actionId: 'ts:toggle_away' },
                { index: 3, title: 'Push to Talk', icon: icons.ptt, actionId: 'ts:ptt' },
                { index: 4, title: 'Transmissão', icon: icons.share, actionId: 'ts:stream' },

                // Linha 2: Discord e Meet
                { index: 5, title: 'Mic Discord', icon: icons.mic_on, actionId: 'discord:toggle_mute', borderColor: '#5865F2' },
                { index: 6, title: 'Surdo Discord', icon: icons.headphone, actionId: 'discord:toggle_deafen', borderColor: '#5865F2' },
                { index: 7, title: 'Mic Meet', icon: icons.mic_on, actionId: 'meet:mute_mic', borderColor: '#00AC47' },
                { index: 8, title: 'Câmera Meet', icon: icons.cam_on, actionId: 'meet:camera', borderColor: '#00AC47' },
                { index: 9, title: 'Mão Meet', icon: icons.hand, actionId: 'meet:hand', borderColor: '#00AC47' },

                // Linha 3: volume, quem fala, canal e navegação
                { index: 10, title: 'Volume PC', icon: icons.volume, actionId: 'vol_slider:master', isSlider: true, sliderValue: 100, sliderApp: 'master' },
                { index: 11, title: 'Mudo PC', icon: icons.volume_mute, actionId: 'media:mute' },
                { index: 12, title: 'Quem fala', icon: icons.user, actionId: 'ts:talking' },
                { index: 13, title: 'TeamSpeak', icon: icons.teamspeak, actionId: 'switch:teamspeak', borderColor: '#2580C3' },
                { index: 14, title: 'Mais', icon: icons.grid, actionId: 'switch:more', borderColor: '#4F8CFF' }
            ]
        };
    }

    handleAction(actionId, eventType) {
        if (eventType !== 'keyDown') return;

        if (actionId.startsWith('switch:')) {
            this.ctx.switchProfile(actionId.split(':')[1]);
        } else if (actionId === 'toggle:auto') {
            this.ctx.setAutoDetect(!this.ctx.autoDetectEnabled);
            const auto = this.ctx.autoDetectEnabled;
            // A tecla Auto-Perfil mora na tela "Mais" (índice 4 de `more`)
            this.ctx.updateKey('more', 4, {
                title: auto ? 'Auto-Perfil ON' : 'Auto-Perfil OFF',
                badgeColor: auto ? '#3B82F6' : '#6B7280',
                active: auto
            });
        } else if (actionId === 'media:vol_up') {
            this.ctx.platform.audio.masterStep(5);
        } else if (actionId === 'media:vol_down') {
            this.ctx.platform.audio.masterStep(-5);
        } else if (actionId === 'media:mute') {
            this.ctx.platform.audio.masterMuteToggle();
        } else if (actionId === 'media:play_pause') {
            this.ctx.platform.keys.mediaKey('play_pause');
        } else if (actionId === 'media:next') {
            this.ctx.platform.keys.mediaKey('next');
        } else if (actionId === 'media:prev') {
            this.ctx.platform.keys.mediaKey('prev');
        } else if (actionId.startsWith('launch:app:')) {
            this.ctx.platform.apps.launcher.launch(actionId.slice('launch:app:'.length));
        } else if (actionId === 'launch:browser') {
            this.ctx.platform.apps.open('https://google.com');
        } else if (actionId === 'launch:calc') {
            this.ctx.platform.apps.launchFirst([['kcalc'], ['gnome-calculator'], ['qalculate-gtk'], ['galculator']], 'calculadora');
        } else if (actionId === 'launch:term') {
            this.ctx.platform.apps.launchFirst([['konsole'], ['x-terminal-emulator'], ['gnome-terminal'], ['xfce4-terminal'], ['alacritty'], ['kitty']], 'terminal');
        } else if (actionId === 'system:lock') {
            this.ctx.platform.session.lock();
        }
    }
}

module.exports = DefaultProfile;
