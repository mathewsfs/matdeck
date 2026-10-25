// Janelas no Linux: foco (kdotool → script KWin → xdotool) e detecção da janela ativa (WindowDetector).
// Adaptador fino: os comandos continuam os de SystemActions e WindowDetector.
const SystemActions = require('../../actions/systemActions');
const WindowDetector = require('../../windowDetector');

function createWindows() {
    return {
        detector: new WindowDetector(),
        focus(target) { return SystemActions.focusWindow(target); },
        focusAndSend(target, combo, delayMs = 150) { return SystemActions.focusAndSend(target, combo, delayMs); },
        matchProfile(title, app) { return WindowDetector.matchProfile(title, app); },
        DETECTABLE_APPS: WindowDetector.DETECTABLE_APPS
    };
}

module.exports = { createWindows };
