// Aplicativos no Linux: abrir programas/URLs (xdg-open, flatpak, binários no PATH) e a lista de apps
// instalados (.desktop) via AppLauncher. Mesmos comandos que SystemActions/DefaultProfile geravam.
const SystemActions = require('../../actions/systemActions');
const AppLauncher = require('../../appLauncher');
const { which } = require('../../hostExec');

function createApps() {
    // Programas (terminal, calculadora): acha o primeiro binário instalado e abre desanexado, sem a
    // cadeia `a || b`, que reabria o próximo da lista quando o app fechava com erro.
    const binCache = new Map();
    return {
        launcher: new AppLauncher(),
        open(target) { return SystemActions.launchFile('xdg-open', [target]); },
        launchFile(bin, args = []) { return SystemActions.launchFile(bin, args); },
        launchFirst(candidates, label) {
            for (const [bin, ...args] of candidates) {
                if (!binCache.has(bin)) binCache.set(bin, !!which(bin));
                if (binCache.get(bin)) return SystemActions.launchFile(bin, args);
            }
            console.log(`[Apps] Nenhum programa encontrado para "${label}" (${candidates.map((c) => c[0]).join(', ')})`);
            return Promise.resolve(false);
        },
        flatpakInstalled(appId) { return SystemActions.flatpakInstalled(appId); },
        commandExists(bin) { return SystemActions.commandExists(bin); }
    };
}

module.exports = { createApps };
