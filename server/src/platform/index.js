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
    if (name === 'darwin') {
        throw new Error('Plataforma darwin ainda não implementada (fase 2)');
    }
    return require('./linux').create(options);
}

module.exports = { createPlatform, platformName };
