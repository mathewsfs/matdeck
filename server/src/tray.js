const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { isFlatpak } = require('./hostExec');

const TRAY_SCRIPT = path.resolve(__dirname, '../../scripts/matdeck-tray.py');

const EXIT_HINTS = {
    3: 'PySide6 não encontrado. Instale com: sudo dnf install python3-pyside6 (ou pip install PySide6)',
    4: 'a sessão não oferece bandeja do sistema (StatusNotifier)'
};

/**
 * Ícone na bandeja do sistema, implementado em Python/Qt (scripts/matdeck-tray.py).
 * O processo filho recebe stdin do servidor: quando o servidor morre, o stdin fecha
 * e o ícone some sozinho. "Parar servidor" no menu chama POST /api/shutdown.
 *
 * No Flatpak o script roda no host (python3 + PySide6 de lá) via flatpak-spawn; como o
 * host não enxerga /app, o código do script vai inteiro em `python3 -c`.
 */
class TrayIndicator {
    constructor({ port, lanIp, enabled = true }) {
        this.port = port;
        this.lanIp = lanIp;
        this.enabled = enabled;
        this.child = null;
    }

    static hasGraphicalSession() {
        return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    }

    start() {
        if (!this.enabled) return;
        if (process.env.MATDECK_TRAY === '0') return;
        if (!TrayIndicator.hasGraphicalSession()) return;
        if (!fs.existsSync(TRAY_SCRIPT)) {
            console.warn('[Tray] Script da bandeja não encontrado:', TRAY_SCRIPT);
            return;
        }

        const trayEnv = {
            MATDECK_PORT: String(this.port),
            // No Flatpak o PID do sandbox não vale no host; o script usa só o stdin e a API HTTP
            MATDECK_SERVER_PID: isFlatpak ? '0' : String(process.pid),
            MATDECK_LAN_IP: this.lanIp || ''
        };
        try {
            if (isFlatpak) {
                const code = fs.readFileSync(TRAY_SCRIPT, 'utf8');
                const envArgs = Object.entries(trayEnv).map(([k, v]) => `--env=${k}=${v}`);
                this.child = spawn('flatpak-spawn', ['--host', `--directory=${process.env.HOME || '/'}`, ...envArgs, 'python3', '-c', code], { stdio: ['pipe', 'ignore', 'pipe'] });
            } else {
                this.child = spawn('python3', [TRAY_SCRIPT], { env: { ...process.env, ...trayEnv }, stdio: ['pipe', 'ignore', 'pipe'] });
            }
        } catch (e) {
            console.warn('[Tray] Não foi possível iniciar o ícone da bandeja:', e.message);
            return;
        }

        let stderr = '';
        this.child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
        this.child.on('error', (err) => {
            console.warn('[Tray] python3 indisponível, ícone da bandeja desativado:', err.message);
            this.child = null;
        });
        this.child.on('exit', (code, signal) => {
            this.child = null;
            if (this.stopping) return;
            if (code === 0 || signal) {
                console.log('[Tray] Ícone da bandeja fechado pelo usuário (servidor continua rodando).');
            } else if (EXIT_HINTS[code]) {
                console.warn(`[Tray] Ícone da bandeja indisponível: ${EXIT_HINTS[code]}.`);
            } else {
                console.warn(`[Tray] Ícone da bandeja encerrou com código ${code}.`, stderr.trim().split('\n').slice(-3).join(' | '));
            }
        });
        console.log('[Tray] Ícone na bandeja do sistema iniciado.');
    }

    stop() {
        this.stopping = true;
        if (!this.child) return;
        try { this.child.stdin.end(); } catch (e) {}
        try { this.child.kill('SIGTERM'); } catch (e) {}
        this.child = null;
    }
}

module.exports = TrayIndicator;
