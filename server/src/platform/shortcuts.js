// Atalhos dos aplicativos por plataforma. Cada perfil declara `SHORTCUTS = { linux: {...}, darwin: {...} }`
// e resolve com forPlatform(SHORTCUTS); sem tabela para a plataforma atual, vale a do Linux.
const { platformName } = require('./index');

function forPlatform(table, name = platformName()) {
    if (!table || typeof table !== 'object') return {};
    return table[name] || table.linux || {};
}

module.exports = { forPlatform };
