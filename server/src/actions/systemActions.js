const { exec, execFile, spawn, which, firstWritableSocket } = require('../hostExec');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXEC_TIMEOUT = 4000;
const CAPS_TTL_MS = 30000;

// Linux input-event-codes.h (KEY_*)
const LINUX_KEYCODES = {
    // Modificadores
    ctrl: 29, control: 29, lctrl: 29, leftctrl: 29, rctrl: 97, rightctrl: 97,
    shift: 42, lshift: 42, leftshift: 42, rshift: 54, rightshift: 54,
    alt: 56, lalt: 56, leftalt: 56, ralt: 100, rightalt: 100, altgr: 100,
    super: 125, meta: 125, win: 125, cmd: 125, leftmeta: 125, rightmeta: 126,

    // Letras
    a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36, k: 37, l: 38, m: 50,
    n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20, u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,

    // Dígitos
    '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,

    // Funções
    f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,

    // Controle / navegação
    esc: 1, escape: 1, enter: 28, return: 28, space: 57, tab: 15, backspace: 14,
    delete: 111, del: 111, insert: 110, home: 102, end: 107, pageup: 104, prior: 104, pagedown: 109, next: 109,
    up: 103, down: 108, left: 105, right: 106,
    capslock: 58, numlock: 69, scrolllock: 70, print: 99, sysrq: 99, pause: 119, menu: 127,

    // Pontuação (layout US)
    minus: 12, equal: 13, leftbrace: 26, bracketleft: 26, rightbrace: 27, bracketright: 27,
    semicolon: 39, apostrophe: 40, grave: 41, backslash: 43, comma: 51, dot: 52, period: 52, slash: 53,
    '-': 12, '=': 13, '[': 26, ']': 27, ';': 39, "'": 40, '`': 41, '\\': 43, ',': 51, '.': 52, '/': 53,

    // Multimídia (nomes XF86 do xdotool, aceitos aqui para manter os perfis iguais nos dois backends)
    xf86audioplay: 164, playpause: 164, xf86audiopause: 164, xf86audiostop: 166,
    xf86audionext: 163, xf86audioprev: 165,
    xf86audiomute: 113, xf86audiolowervolume: 114, xf86audioraisevolume: 115, xf86audiomicmute: 248,
    xf86homepage: 172, xf86calculator: 140, xf86mail: 155
};

const MODIFIER_NAMES = new Set([
    'ctrl', 'control', 'lctrl', 'leftctrl', 'rctrl', 'rightctrl',
    'shift', 'lshift', 'leftshift', 'rshift', 'rightshift',
    'alt', 'lalt', 'leftalt', 'ralt', 'rightalt', 'altgr',
    'super', 'meta', 'win', 'cmd', 'leftmeta', 'rightmeta'
]);

let capsCache = null;
let capsCacheAt = 0;
let kdotoolCache = { value: false, at: 0 };
let ydotoolRecheckAt = 0;
let warnedXdotoolWayland = false;

function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const timeout = opts.timeout || EXEC_TIMEOUT;
        const env = Object.assign({}, process.env, opts.env || {});
        execFile(cmd, args, { timeout, env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, code: err ? err.code : 0, signal: err ? (err.signal || null) : null, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
        });
    });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// Dentro do Flatpak os binários estão no host, por isso a busca passa pelo hostExec
function findInPath(bin) {
    return which(bin);
}

function isSocket(p) {
    try {
        return !!p && fs.statSync(p).isSocket();
    } catch (e) {
        return false;
    }
}

function findYdotoolSocket() {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const candidates = [
        process.env.YDOTOOL_SOCKET,
        process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, '.ydotool_socket') : null,
        `/run/user/${uid}/.ydotool_socket`,
        '/run/.ydotool_socket',
        '/tmp/.ydotool_socket'
    ];
    // o socket precisa ser gravável pelo nosso usuário (o serviço padrão cria como root 0600)
    const writable = firstWritableSocket(candidates);
    if (writable) return writable;
    if (!findYdotoolSocket.warned && candidates.some(isSocket)) {
        findYdotoolSocket.warned = true;
        console.warn('[SystemActions] Socket do ydotool existe mas sem permissão de uso. Ajuste o serviço com --socket-perm=0666 (veja README).');
    }
    return null;
}

/**
 * Pasta temporária que o KWin (no host) também enxerga. No Flatpak o /tmp do sandbox
 * é privado, mas $XDG_RUNTIME_DIR/app/<id> é compartilhado com o host no mesmo caminho.
 */
function hostVisibleTmpDir() {
    if (process.env.FLATPAK_ID && process.env.XDG_RUNTIME_DIR) {
        const dir = path.join(process.env.XDG_RUNTIME_DIR, 'app', process.env.FLATPAK_ID);
        try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch (e) { /* cai no tmpdir */ }
    }
    return os.tmpdir();
}

// xdotool no Wayland: só enxerga janelas XWayland e aborta (SIGABRT, core dump) quando a janela ativa é
// nativa. Depois do primeiro abort ele não é mais chamado até reiniciar o servidor.
let xdotoolBroken = false;
function xdotoolCrashed(what, res) {
    if (!res.signal || !/^SIG(ABRT|SEGV|BUS)$/.test(res.signal)) return false;
    if (!xdotoolBroken) {
        xdotoolBroken = true;
        console.log(`[SystemActions] xdotool abortou (${res.signal}) em "${what}". No Wayland ele só enxerga janelas XWayland; desativado até reiniciar o servidor.`);
    }
    return true;
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class SystemActions {
    // ---------------------------------------------------------------------
    // Capacidades do ambiente
    // ---------------------------------------------------------------------

    static capabilities(force = false) {
        const now = Date.now();
        if (!force && capsCache && (now - capsCacheAt) < CAPS_TTL_MS) return capsCache;

        const platform = os.platform();
        const wayland = platform === 'linux' && (
            (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || !!process.env.WAYLAND_DISPLAY
        );
        const ydotoolBin = platform === 'linux' ? findInPath('ydotool') : null;
        const ydotoolSocket = ydotoolBin ? findYdotoolSocket() : null;
        const qdbus = platform === 'linux' ? (findInPath('qdbus') || findInPath('qdbus-qt6') || findInPath('qdbus6')) : null;

        capsCache = {
            platform,
            wayland,
            desktop: process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '',
            ydotool: !!(ydotoolBin && ydotoolSocket),
            ydotoolBin,
            ydotoolSocket,
            kdotool: platform === 'linux' ? !!findInPath('kdotool') : false,
            xdotool: platform === 'linux' ? !!findInPath('xdotool') : false,
            busctl: platform === 'linux' ? !!findInPath('busctl') : false,
            qdbus: qdbus ? path.basename(qdbus) : null,
            hyprland: !!process.env.HYPRLAND_INSTANCE_SIGNATURE,
            sway: !!process.env.SWAYSOCK
        };
        capsCacheAt = now;
        kdotoolCache = { value: capsCache.kdotool, at: now };
        return capsCache;
    }

    /** Pasta onde o host (KWin) consegue ler arquivos escritos pelo servidor, mesmo dentro do Flatpak. */
    static hostVisibleTmpDir() {
        return hostVisibleTmpDir();
    }

    /** xdotool presente e ainda não abortou nesta sessão. */
    static xdotoolUsable() {
        return !xdotoolBroken && this.capabilities().xdotool;
    }

    static hasKdotool() {
        const now = Date.now();
        if ((now - kdotoolCache.at) > CAPS_TTL_MS) {
            kdotoolCache = { value: !!findInPath('kdotool'), at: now };
        }
        return kdotoolCache.value;
    }

    static commandExists(bin) {
        return !!findInPath(bin);
    }

    static async flatpakInstalled(appId) {
        if (!findInPath('flatpak')) return false;
        const res = await run('flatpak', ['info', appId], { timeout: 3000 });
        return res.ok;
    }

    // ---------------------------------------------------------------------
    // Teclado
    // ---------------------------------------------------------------------

    static parseCombo(combo) {
        const parts = String(combo || '').split('+').map((p) => p.trim()).filter(Boolean);
        const modifiers = [];
        let key = null;
        for (const p of parts) {
            const lower = p.toLowerCase();
            if (MODIFIER_NAMES.has(lower)) modifiers.push(lower);
            else key = p;
        }
        return { modifiers, key };
    }

    static toLinuxKeycodes(combo) {
        const { modifiers, key } = this.parseCombo(combo);
        const codes = [];
        for (const m of modifiers) {
            const code = LINUX_KEYCODES[m];
            if (code === undefined) return null;
            codes.push(code);
        }
        if (key) {
            const code = LINUX_KEYCODES[key.toLowerCase()];
            if (code === undefined) return null;
            codes.push(code);
        }
        return codes.length ? codes : null;
    }

    static async ydotoolKey(sequence) {
        const caps = this.capabilities();
        if (!caps.ydotool) return false;
        const res = await run(caps.ydotoolBin, ['key', ...sequence], {
            env: { YDOTOOL_SOCKET: caps.ydotoolSocket },
            timeout: 3000
        });
        if (!res.ok) {
            console.log(`[SystemActions] ydotool falhou: ${res.stderr.trim() || res.code}`);
            // Revalida o socket só quando o erro é de conexão e no máximo a cada 10 s (a sondagem é síncrona
            // e, no Flatpak, cada `which` é um flatpak-spawn)
            if (/socket|connect|ENOENT|EACCES|permission|refused/i.test(res.stderr) && Date.now() - ydotoolRecheckAt > 10000) {
                ydotoolRecheckAt = Date.now();
                capsCacheAt = 0;
            }
        }
        return res.ok;
    }

    static async xdotoolKey(subcommand, combo) {
        if (!this.xdotoolUsable()) return false;
        if (this.capabilities().wayland) {
            // XTEST só alcança janelas XWayland: o xdotool sairia com código 0 sem entregar nada e a tecla
            // trocaria de estado (MUDO, câmera…) sem nada ter acontecido.
            if (!warnedXdotoolWayland) {
                warnedXdotoolWayland = true;
                console.log('[SystemActions] Sem ydotool não há como enviar teclas no Wayland (xdotool não alcança janelas nativas). Ative: sudo systemctl enable --now ydotool');
            }
            return false;
        }
        const res = await run('xdotool', [subcommand, '--clearmodifiers', combo], { timeout: 3000 });
        if (!res.ok && !xdotoolCrashed(`xdotool ${subcommand} ${combo}`, res)) {
            console.log(`[SystemActions] xdotool ${subcommand} falhou (${combo}): ${res.stderr.trim() || res.code}`);
        }
        return res.ok;
    }

    /**
     * Envia um atalho completo (press + release). Ex.: 'ctrl+shift+m', 'c', 'XF86AudioPlay'.
     */
    static async sendKey(combo) {
        const platform = os.platform();
        console.log(`[SystemActions] Enviando tecla: ${combo} (${platform})`);

        try {
            if (platform === 'linux') {
                const codes = this.toLinuxKeycodes(combo);
                if (this.capabilities().ydotool && codes) {
                    const seq = [
                        ...codes.map((c) => `${c}:1`),
                        ...codes.slice().reverse().map((c) => `${c}:0`)
                    ];
                    if (await this.ydotoolKey(seq)) return true;
                } else if (!codes) {
                    console.log(`[SystemActions] Combo "${combo}" sem keycode conhecido para ydotool; tentando xdotool`);
                }
                return await this.xdotoolKey('key', combo);
            }

            if (platform === 'win32') {
                const keys = this.mapWindowsKey(combo);
                const ps = `powershell -NoProfile -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('${keys.replace(/'/g, "''")}')"`;
                return await new Promise((resolve) => exec(ps, { timeout: EXEC_TIMEOUT }, (err) => resolve(!err)));
            }

            if (platform === 'darwin') {
                const { modifiers, key } = this.parseCombo(combo);
                const macMods = modifiers.map((m) => {
                    if (m.includes('ctrl') || m === 'control') return 'control down';
                    if (m.includes('shift')) return 'shift down';
                    if (m.includes('alt')) return 'option down';
                    return 'command down';
                });
                const using = macMods.length ? ` using {${macMods.join(', ')}}` : '';
                const script = `tell application "System Events" to keystroke "${(key || '').replace(/"/g, '\\"')}"${using}`;
                return await new Promise((resolve) => execFile('osascript', ['-e', script], { timeout: EXEC_TIMEOUT }, (err) => resolve(!err)));
            }
        } catch (e) {
            console.log(`[SystemActions] Erro ao enviar tecla ${combo}: ${e.message}`);
        }
        return false;
    }

    /**
     * Pressiona (sem soltar) uma combinação — para push-to-talk.
     */
    static async keyHold(combo) {
        if (os.platform() !== 'linux') return this.sendKey(combo);
        const codes = this.toLinuxKeycodes(combo);
        if (this.capabilities().ydotool && codes) {
            return this.ydotoolKey(codes.map((c) => `${c}:1`));
        }
        return this.xdotoolKey('keydown', combo);
    }

    /**
     * Solta uma combinação pressionada com keyHold.
     */
    static async keyRelease(combo) {
        if (os.platform() !== 'linux') return true;
        const codes = this.toLinuxKeycodes(combo);
        if (this.capabilities().ydotool && codes) {
            return this.ydotoolKey(codes.slice().reverse().map((c) => `${c}:0`));
        }
        return this.xdotoolKey('keyup', combo);
    }

    static mapWindowsKey(comb) {
        // SendKeys format: ^ for Ctrl, + for Shift, % for Alt
        let result = '';
        const parts = comb.toLowerCase().split('+');
        for (let i = 0; i < parts.length - 1; i++) {
            if (parts[i] === 'ctrl') result += '^';
            else if (parts[i] === 'shift') result += '+';
            else if (parts[i] === 'alt') result += '%';
        }
        result += parts[parts.length - 1];
        return result;
    }

    // ---------------------------------------------------------------------
    // Janelas
    // ---------------------------------------------------------------------

    /**
     * Foca uma janela cuja classe contenha um dos classHints ou cujo título contenha um dos titleHints.
     * Ordem: kdotool -> script KWin via D-Bus -> xdotool. Resolve true se algo foi ativado.
     */
    static async focusWindow(target = {}) {
        const classHints = (target.classHints || []).map((h) => String(h).toLowerCase()).filter(Boolean);
        const titleHints = (target.titleHints || []).map((h) => String(h).toLowerCase()).filter(Boolean);
        // requireTitle: o título precisa casar (classHints só desempatam); evita focar outra aba/janela do navegador
        const requireTitle = !!target.requireTitle && titleHints.length > 0;
        if (!classHints.length && !titleHints.length) return false;

        if (os.platform() !== 'linux') {
            console.log('[SystemActions] focusWindow só está implementado no Linux');
            return false;
        }

        if (this.hasKdotool()) {
            if (await this.focusWithKdotool(classHints, titleHints, requireTitle)) return true;
        }

        const caps = this.capabilities();
        if (caps.qdbus && /kde|plasma/i.test(caps.desktop)) {
            if (await this.focusWithKwinScript(classHints, titleHints, requireTitle)) return true;
        }

        if (this.xdotoolUsable()) {
            if (await this.focusWithXdotool(classHints, titleHints, requireTitle)) return true;
        }

        console.log(`[SystemActions] Nenhuma janela encontrada para class=[${classHints}] title=[${titleHints}]${requireTitle ? ' (título obrigatório)' : ''}`);
        return false;
    }

    static async focusWithKdotool(classHints, titleHints, requireTitle) {
        const searches = [
            ...titleHints.map((h) => ['--name', h]),
            ...(requireTitle ? [] : classHints.map((h) => ['--class', h]))
        ];
        for (const [flag, hint] of searches) {
            const res = await run('kdotool', ['search', flag, escapeRegex(hint)], { timeout: 3000 });
            if (!res.ok) continue;
            const ids = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
            if (!ids.length) continue;
            const act = await run('kdotool', ['windowactivate', ids[0]], { timeout: 3000 });
            if (act.ok) {
                console.log(`[SystemActions] Janela focada via kdotool (${flag} ${hint})`);
                return true;
            }
        }
        return false;
    }

    /**
     * Script KWin que ativa a janela. Scripts KWin não devolvem valor, então ao achar a janela ele
     * registra um "marcador" (loadScript com pluginName único, apontando para este mesmo arquivo) e
     * o Node confere com isScriptLoaded(marcador).
     */
    static buildKwinFocusScript(classHints, titleHints, scriptPath, markerName, requireTitle) {
        return `(function () {
    var classHints = ${JSON.stringify(classHints)};
    var titleHints = ${JSON.stringify(titleHints)};
    var requireTitle = ${requireTitle ? 'true' : 'false'};
    var scriptPath = ${JSON.stringify(scriptPath)};
    var markerName = ${JSON.stringify(markerName)};
    var list = (typeof workspace.windowList === 'function') ? workspace.windowList() : workspace.clientList();
    function lc(v) { return (v === undefined || v === null) ? '' : String(v).toLowerCase(); }
    function hasAny(str, hints) {
        for (var i = 0; i < hints.length; i++) { if (str.indexOf(hints[i]) >= 0) return true; }
        return false;
    }
    function matchClass(w) { return classHints.length > 0 && hasAny(lc(w.resourceClass) + ' ' + lc(w.resourceName), classHints); }
    function matchTitle(w) { return titleHints.length > 0 && hasAny(lc(w.caption), titleHints); }
    // strict: só janelas normais/diálogos; loose: qualquer janela viva (apps Electron/AppImage às vezes não marcam normalWindow)
    function usable(w, strict) {
        if (!w || w.deleted) return false;
        if (strict && typeof w.normalWindow === 'boolean' && !w.normalWindow && !w.dialog) return false;
        if (!strict && (w.desktopWindow || w.dock || w.popupWindow || w.tooltip || w.notification)) return false;
        return true;
    }
    function activate(w) {
        if (w.minimized) w.minimized = false;
        if ('activeWindow' in workspace) workspace.activeWindow = w; else workspace.activeClient = w;
        callDBus('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', 'loadScript', scriptPath, markerName);
    }
    var tiers = [
        function (w) { return matchTitle(w) && (classHints.length === 0 || matchClass(w)); },
        function (w) { return matchTitle(w); }
    ];
    if (!requireTitle) tiers.push(function (w) { return matchClass(w); });
    var passes = [true, false];
    for (var p = 0; p < passes.length; p++) {
        for (var t = 0; t < tiers.length; t++) {
            for (var i = 0; i < list.length; i++) {
                var w = list[i];
                if (usable(w, passes[p]) && tiers[t](w)) { activate(w); return; }
            }
        }
    }
})();
`;
    }

    static async focusWithKwinScript(classHints, titleHints, requireTitle) {
        const caps = this.capabilities();
        const qdbus = caps.qdbus;
        if (!qdbus) return false;

        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const pluginName = `matdeck-focus-${stamp}`;
        const markerName = `matdeck-found-${stamp}`;
        const scriptPath = path.join(hostVisibleTmpDir(), `${pluginName}.js`);

        try {
            fs.writeFileSync(scriptPath, this.buildKwinFocusScript(classHints, titleHints, scriptPath, markerName, requireTitle), { mode: 0o600 });
        } catch (e) {
            console.log(`[SystemActions] Não foi possível escrever script KWin: ${e.message}`);
            return false;
        }

        let loaded = false;
        let found = false;
        try {
            const load = await run(qdbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.loadScript', scriptPath, pluginName], { timeout: 3000 });
            const id = parseInt(load.stdout.trim(), 10);
            if (!load.ok || Number.isNaN(id) || id < 0) {
                console.log(`[SystemActions] KWin loadScript falhou: ${load.stderr.trim() || load.stdout.trim()}`);
                return false;
            }
            loaded = true;

            // Plasma 6: /Scripting/Script<N>; Plasma 5: /<N>
            let ran = await run(qdbus, ['org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script.run'], { timeout: 3000 });
            let objPath = `/Scripting/Script${id}`;
            if (!ran.ok) {
                objPath = `/${id}`;
                ran = await run(qdbus, ['org.kde.KWin', objPath, 'org.kde.kwin.Script.run'], { timeout: 3000 });
            }
            if (!ran.ok) {
                console.log(`[SystemActions] KWin Script.run falhou: ${ran.stderr.trim()}`);
                return false;
            }

            // O marcador chega de forma assíncrona (callDBus do KWin para ele mesmo); tenta algumas vezes
            for (let attempt = 0; attempt < 4 && !found; attempt++) {
                await sleep(60);
                const chk = await run(qdbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.isScriptLoaded', markerName], { timeout: 2000 });
                found = chk.ok && chk.stdout.trim() === 'true';
            }

            await run(qdbus, ['org.kde.KWin', objPath, 'org.kde.kwin.Script.stop'], { timeout: 2000 });
            if (found) console.log(`[SystemActions] Janela focada via script KWin (class=[${classHints}] title=[${titleHints}])`);
            return found;
        } finally {
            if (loaded) {
                await run(qdbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', pluginName], { timeout: 2000 });
            }
            // O marcador pode ter sido registrado depois da última checagem: descarrega sempre
            await run(qdbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', markerName], { timeout: 2000 });
            fs.unlink(scriptPath, () => {});
        }
    }

    static async focusWithXdotool(classHints, titleHints, requireTitle) {
        const searches = [
            ...titleHints.map((h) => ['--name', h]),
            ...(requireTitle ? [] : classHints.map((h) => ['--class', h]))
        ];
        for (const [flag, hint] of searches) {
            const res = await run('xdotool', ['search', flag, escapeRegex(hint)], { timeout: 3000 });
            if (xdotoolCrashed(`xdotool search ${flag} ${hint}`, res)) return false;
            if (!res.ok) continue;
            const ids = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
            if (!ids.length) continue;
            const act = await run('xdotool', ['windowactivate', '--sync', ids[0]], { timeout: 3000 });
            if (xdotoolCrashed('xdotool windowactivate', act)) return false;
            if (act.ok) {
                console.log(`[SystemActions] Janela focada via xdotool (${flag} ${hint})`);
                return true;
            }
        }
        return false;
    }

    /**
     * Foca a janela alvo, aguarda e envia o atalho. Resolve true se o atalho foi enviado.
     */
    static async focusAndSend(target, combo, delayMs = 150) {
        const focused = await this.focusWindow(target);
        if (!focused) {
            console.log(`[SystemActions] Janela alvo não encontrada; atalho ${combo} não enviado`);
            return false;
        }
        await sleep(delayMs);
        return this.sendKey(combo);
    }

    // ---------------------------------------------------------------------
    // Processos
    // ---------------------------------------------------------------------

    /**
     * Abre um programa e esquece dele: processo desanexado, sem pipes. Com exec/execFile o Node
     * acumularia o stdout do app num buffer de 1 MiB e, ao estourar, mataria o programa (Discord e
     * TeamSpeak escrevem log sem parar e "fechavam sozinhos").
     */
    static detach(file, args, label) {
        try {
            const child = spawn(file, args, { detached: true, stdio: 'ignore' });
            child.on('error', (e) => console.log(`[SystemActions] Falha ao abrir ${label}: ${e.message}`));
            child.unref();
            console.log(`[SystemActions] Lançado: ${label}`);
            return true;
        } catch (e) {
            console.log(`[SystemActions] Falha ao abrir ${label}: ${e.message}`);
            return false;
        }
    }

    /**
     * Executa um comando (string shell fixa, nunca com entrada externa) sem bloquear.
     */
    static launch(cmd) {
        return Promise.resolve(this.detach('sh', ['-c', cmd], cmd));
    }

    /**
     * Executa um binário com argumentos (sem shell) sem bloquear.
     */
    static launchFile(bin, args = []) {
        return Promise.resolve(this.detach(bin, args, `${bin} ${args.join(' ')}`.trim()));
    }

}

module.exports = SystemActions;
