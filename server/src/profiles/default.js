const icons = require('../icons.json');
const SystemActions = require('../actions/systemActions');
const { exec, which } = require('../hostExec');

const CMD_TIMEOUT_MS = 4000;

// Comandos curtos (volume, bloquear tela): o primeiro que existir vence. Erro vai para o log em vez
// de sumir — era assim que Vol+/Vol-/Mudo podiam ficar mortos sem ninguém saber.
function execFirstAvailable(commands) {
    const chain = commands.map(c => `(${c})`).join(' || ');
    exec(chain, { timeout: CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) console.log(`[Default] Comando falhou (${commands[0]} …): ${String(stderr || err.message).trim().split('\n')[0]}`);
    });
}

// Programas (terminal, calculadora): acha o primeiro binário instalado e abre desanexado, sem a
// cadeia `a || b`, que reabria o próximo da lista quando o app fechava com erro.
const binCache = new Map();
function launchFirstAvailable(candidates, label) {
    for (const [bin, ...args] of candidates) {
        if (!binCache.has(bin)) binCache.set(bin, !!which(bin));
        if (binCache.get(bin)) return SystemActions.launchFile(bin, args);
    }
    console.log(`[Default] Nenhum programa encontrado para "${label}" (${candidates.map(c => c[0]).join(', ')})`);
    return Promise.resolve(false);
}

class DefaultProfile {
    constructor(serverContext) {
        this.ctx = serverContext;
        // playerctl (MPRIS) é mais confiável que teclas de mídia emuladas; usa só um dos dois
        this.hasPlayerctl = !!which('playerctl');
    }

    mediaCommand(playerctlArg, xf86Key) {
        if (this.hasPlayerctl) {
            exec(`playerctl ${playerctlArg}`, { timeout: CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
                if (err) console.log(`[Default] playerctl ${playerctlArg} falhou: ${String(stderr || err.message).trim().split('\n')[0]}`);
            });
        } else {
            SystemActions.sendKey(xf86Key);
        }
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
            execFirstAvailable([
                'wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ 5%+',
                'pactl set-sink-volume @DEFAULT_SINK@ +5%',
                'amixer -D pulse sset Master 5%+'
            ]);
        } else if (actionId === 'media:vol_down') {
            execFirstAvailable([
                'wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-',
                'pactl set-sink-volume @DEFAULT_SINK@ -5%',
                'amixer -D pulse sset Master 5%-'
            ]);
        } else if (actionId === 'media:mute') {
            execFirstAvailable([
                'wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle',
                'pactl set-sink-mute @DEFAULT_SINK@ toggle'
            ]);
        } else if (actionId === 'media:play_pause') {
            this.mediaCommand('play-pause', 'XF86AudioPlay');
        } else if (actionId === 'media:next') {
            this.mediaCommand('next', 'XF86AudioNext');
        } else if (actionId === 'media:prev') {
            this.mediaCommand('previous', 'XF86AudioPrev');
        } else if (actionId.startsWith('launch:app:')) {
            this.ctx.appLauncher.launch(actionId.slice('launch:app:'.length));
        } else if (actionId === 'launch:browser') {
            SystemActions.launchFile('xdg-open', ['https://google.com']);
        } else if (actionId === 'launch:calc') {
            launchFirstAvailable([['kcalc'], ['gnome-calculator'], ['qalculate-gtk'], ['galculator']], 'calculadora');
        } else if (actionId === 'launch:term') {
            launchFirstAvailable([['konsole'], ['x-terminal-emulator'], ['gnome-terminal'], ['xfce4-terminal'], ['alacritty'], ['kitty']], 'terminal');
        } else if (actionId === 'system:lock') {
            execFirstAvailable([
                'loginctl lock-session',
                'qdbus org.freedesktop.ScreenSaver /ScreenSaver Lock',
                'xdg-screensaver lock'
            ]);
        }
    }
}

module.exports = DefaultProfile;
