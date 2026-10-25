// Onde ficam os dados do usuário (config.json, presets.json, devices.json, media/, plugins/).
// MATDECK_DATA_DIR manda (Flatpak e testes); no macOS o padrão é ~/Library/Application Support/MatDeck;
// no resto, server/data no próprio repositório.
const os = require('os');
const path = require('path');

function dataDir() {
    if (process.env.MATDECK_DATA_DIR) return process.env.MATDECK_DATA_DIR;
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'MatDeck');
    return path.resolve(__dirname, '../data');
}

module.exports = { dataDir };
