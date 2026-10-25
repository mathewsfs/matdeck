// Sessão e volume master no Linux por comandos curtos (bloquear tela, volume ±, mudo).
// O primeiro comando que existir vence; erro vai para o log em vez de sumir.
const { exec } = require('../../hostExec');

const CMD_TIMEOUT_MS = 4000;

function execFirstAvailable(commands) {
    const chain = commands.map((c) => `(${c})`).join(' || ');
    exec(chain, { timeout: CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) console.log(`[System] Comando falhou (${commands[0]} …): ${String(stderr || err.message).trim().split('\n')[0]}`);
    });
}

function createSystem() {
    return {
        lock() {
            execFirstAvailable([
                'loginctl lock-session',
                'qdbus org.freedesktop.ScreenSaver /ScreenSaver Lock',
                'xdg-screensaver lock'
            ]);
        },
        masterStep(deltaPercent) {
            const n = Math.abs(parseInt(deltaPercent, 10) || 0);
            if (!n) return;
            if (deltaPercent > 0) {
                execFirstAvailable([
                    `wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ ${n}%+`,
                    `pactl set-sink-volume @DEFAULT_SINK@ +${n}%`,
                    `amixer -D pulse sset Master ${n}%+`
                ]);
            } else {
                execFirstAvailable([
                    `wpctl set-volume @DEFAULT_AUDIO_SINK@ ${n}%-`,
                    `pactl set-sink-volume @DEFAULT_SINK@ -${n}%`,
                    `amixer -D pulse sset Master ${n}%-`
                ]);
            }
        },
        masterMuteToggle() {
            execFirstAvailable([
                'wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle',
                'pactl set-sink-mute @DEFAULT_SINK@ toggle'
            ]);
        }
    };
}

module.exports = { createSystem };
