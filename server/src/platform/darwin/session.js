// Sessão no macOS: bloquear a tela é o atalho padrão do sistema (ctrl+cmd+q), sem SPI.
function createSession(keys) {
    return {
        lock() { return keys.shortcut('ctrl+cmd+q'); }
    };
}

module.exports = { createSession };
