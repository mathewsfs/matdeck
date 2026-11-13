// "Iniciar com o PC" no Linux: um .desktop em ~/.config/autostart (padrão XDG, lido por KDE, GNOME etc.).
// Tudo passa pelo host (hostExec): no Flatpak o sandbox não enxerga ~/.config. A fonte da verdade é o arquivo
// (o usuário pode desligar pelo próprio KDE, que grava Hidden=true), por isso não há flag no config.
const path = require('path');
const hostExec = require('../../hostExec');

const FILE_NAME = 'br.com.matdeck.MatDeck.desktop';
const CMD_TIMEOUT_MS = 5000;

function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Valor de Exec= com aspas e escapes do padrão Desktop Entry (caminhos com espaços e acentos). */
function execQuote(s) {
    return `"${String(s).replace(/["\\$`]/g, '\\$&')}"`;
}

function defaultDir() {
    if (process.env.MATDECK_AUTOSTART_DIR) return process.env.MATDECK_AUTOSTART_DIR;
    // No Flatpak XDG_CONFIG_HOME aponta para ~/.var/app/...: o host lê ~/.config
    const base = (!process.env.FLATPAK_ID && process.env.XDG_CONFIG_HOME) || path.join(process.env.HOME || require('os').homedir(), '.config');
    return path.join(base, 'autostart');
}

function run(command) {
    return new Promise((resolve, reject) => {
        hostExec.exec(command, { timeout: CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
            if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0] || 'comando falhou'));
            resolve(String(stdout));
        });
    });
}

/**
 * @param {object} [options]
 * @param {string} [options.dir] pasta de autostart (padrão ~/.config/autostart ou MATDECK_AUTOSTART_DIR)
 * @param {string} [options.flatpakId] id do Flatpak quando o servidor roda nele (padrão FLATPAK_ID)
 * @param {string} [options.root] raiz do repositório, para o start-server.sh na instalação nativa
 */
function createAutostart(options = {}) {
    const dir = options.dir || defaultDir();
    const flatpakId = options.flatpakId !== undefined ? options.flatpakId : (process.env.FLATPAK_ID || '');
    const root = options.root || path.join(__dirname, '..', '..', '..', '..');
    const file = path.join(dir, FILE_NAME);

    function desktopEntry() {
        const exec = flatpakId ? `flatpak run --command=matdeck ${flatpakId} autostart` : execQuote(path.join(root, 'start-server.sh'));
        return [
            '[Desktop Entry]',
            'Type=Application',
            'Name=MatDeck',
            'Comment=Servidor do MatDeck iniciado com a sessão (gravado por Ajustes → Iniciar com o PC)',
            `Exec=${exec}`,
            `Icon=${flatpakId || 'matdeck'}`,
            'Terminal=false',
            'X-GNOME-Autostart-enabled=true',
            ''
        ].join('\n');
    }

    return {
        supported: true,
        file,
        async status() {
            let content = null;
            try { content = await run(`cat ${shellQuote(file)}`); } catch (e) { content = null; }
            const enabled = content !== null && !/^Hidden=true$/mi.test(content);
            return { supported: true, enabled, file, exec: content ? (content.match(/^Exec=(.*)$/m) || [])[1] || null : null };
        },
        async enable() {
            await run(`mkdir -p ${shellQuote(dir)} && printf '%s' ${shellQuote(desktopEntry())} > ${shellQuote(file)}`);
        },
        async disable() {
            await run(`rm -f ${shellQuote(file)}`);
        }
    };
}

module.exports = { createAutostart, FILE_NAME };
