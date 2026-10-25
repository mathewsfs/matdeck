// Camada de plataforma: tudo que fala com o sistema operacional (teclas, janelas, apps, áudio, mídia,
// hardware, bandeja, sessão) vive aqui, com uma implementação por sistema. Perfis e index.js só usam
// `ctx.platform`; nunca chamam ydotool, pactl, osascript etc. direto. Contrato em README.md.

/** 'linux' ou 'darwin'. MATDECK_PLATFORM só existe para os testes forçarem a escolha. */
function platformName() {
    const forced = process.env.MATDECK_PLATFORM;
    if (forced) return forced;
    return process.platform === 'darwin' ? 'darwin' : 'linux';
}

function createPlatform(options = {}) {
    const name = platformName();
    const platform = require('./linux').create(options);
    if (name === 'darwin') {
        // Até a fase 2 (helper nativo), o macOS usa a camada provisória: os adaptadores Linux delegam a
        // SystemActions/WindowDetector, que já tinham ramos osascript. Funções limitadas, mas o servidor sobe.
        console.warn('[Platform] macOS: camada nativa chega na fase 2; usando a camada provisória (teclas e janela ativa por osascript, sem mixer, bandeja nem telemetria).');
        platform.name = 'darwin';
        platform.describe = () => 'Sessão: macOS | camada provisória (fase 2 traz o helper nativo)';
    }
    return platform;
}

module.exports = { createPlatform, platformName };
