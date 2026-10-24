const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { exec, execFile, execSync, spawn } = require('./hostExec');
const SystemActions = require('./actions/systemActions');

// Classe do app (resourceClass / app_id / WM_CLASS) — casamento com borda, para "Obsidian" não virar "obs"
const CLASS_RULES = [
    { profile: 'obs', re: /^(com\.obsproject\.studio|obs|obs64|obs-studio|streamlabs(\s*obs)?)$/i },
    { profile: 'discord', re: /^(discord|com\.discordapp\.discord|discord-?canary|discord-?ptb|vesktop|webcord)$/i },
    { profile: 'teamspeak', re: /^(teamspeak|teamspeak3?|ts3client(_linux_amd64)?|com\.teamspeak\.teamspeak)$/i },
    { profile: 'nextcloud', re: /^(com\.nextcloud\.talk|nextcloud ?talk|nextcloud-talk)$/i },
    { profile: 'spotify', re: /^(spotify|com\.spotify\.client)$/i }
];

// Título da janela — só palavras inteiras
const TITLE_RULES = [
    { profile: 'obs', re: /\bOBS\b/ },
    { profile: 'discord', re: /\bDiscord\b/ },
    { profile: 'teamspeak', re: /\bTeamSpeak\b/ },
    { profile: 'meet', re: /Meet\b.*-|meet\.google\.com|\bGoogle Meet\b/i },
    { profile: 'nextcloud', re: /\bTalk\b.*\bNextcloud\b|\bNextcloud Talk\b/i },
    { profile: 'spotify', re: /^Spotify( Premium| Free)?$/ }
];

// Apps que o Auto-Perfil reconhece (id = perfil embutido de mesmo nome; o usuário pode redirecionar em Ajustes)
const DETECTABLE_APPS = [
    { id: 'obs', label: 'OBS Studio' },
    { id: 'discord', label: 'Discord' },
    { id: 'teamspeak', label: 'TeamSpeak' },
    { id: 'meet', label: 'Google Meet' },
    { id: 'nextcloud', label: 'Nextcloud Talk' },
    { id: 'spotify', label: 'Spotify' }
];

const BACKEND_LABEL = {
    kwin: 'script KWin (evento)',
    kdotool: 'kdotool',
    hyprland: 'Hyprland',
    sway: 'Sway',
    xdotool: 'xdotool',
    windows: 'PowerShell',
    mac: 'AppleScript'
};

// Backend KWin: o script roda dentro do KWin e, a cada troca de foco, chama um método D-Bus num nome
// que ninguém possui. O barramento devolve erro ao KWin (ignorado) mas repassa a chamada aos
// monitores — e o Node é um monitor (`busctl monitor`). Zero processos em repouso, sem lib nova.
const KWIN_DBUS_NAME = 'br.matdeck.WindowDetector';
const KWIN_DBUS_PATH = '/br/matdeck/WindowDetector';
const KWIN_PLUGIN = 'matdeck-window-detector';
const KWIN_HEALTH_MS = 10 * 60 * 1000;   // confere isScriptLoaded (1 processo a cada 10 min)
const KWIN_MONITOR_RETRY_MS = 5000;
const KWIN_MONITOR_MAX_RETRIES = 5;
const KWIN_RELOAD_DELAY_MS = 2000;       // depois de NameOwnerChanged o KWin ainda está subindo
const POLL_MAX_FAILURES = 10;            // leituras vazias seguidas até desistir de um backend de polling

function buildKwinWatchScript() {
    return `(function () {
    var NAME = ${JSON.stringify(KWIN_DBUS_NAME)};
    var PATH = ${JSON.stringify(KWIN_DBUS_PATH)};
    var current = null;
    function str(v) { return (v === undefined || v === null) ? '' : String(v); }
    function report(w) {
        callDBus(NAME, PATH, NAME, 'ActiveWindow', w ? str(w.caption) : '', w ? str(w.resourceClass) : '', w ? str(w.resourceName) : '');
    }
    function onCaption() { if (current) report(current); }
    // Também acompanha o título da janela ativa (aba do Meet, "Spotify Premium" etc.)
    function track(w) {
        if (current && current.captionChanged) { try { current.captionChanged.disconnect(onCaption); } catch (e) {} }
        current = w || null;
        if (current && current.captionChanged) current.captionChanged.connect(onCaption);
        report(current);
    }
    if (workspace.windowActivated) workspace.windowActivated.connect(track);   // Plasma 6
    else if (workspace.clientActivated) workspace.clientActivated.connect(track); // Plasma 5
    track(('activeWindow' in workspace) ? workspace.activeWindow : workspace.activeClient);
})();
`;
}

function runRes(cmd, args, timeout) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
        });
    });
}

function runFile(cmd, args, timeout) {
    return runRes(cmd, args, timeout).then((r) => (r.ok ? r.stdout : null));
}

function runShell(cmd, timeout) {
    return new Promise((resolve) => {
        exec(cmd, { timeout }, (err, stdout) => {
            resolve(err ? null : (stdout || '').toString());
        });
    });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

class WindowDetector extends EventEmitter {
    constructor() {
        super();
        this.platform = os.platform();
        this.pollInterval = 1500; // ms — só para backends de polling (kdotool carrega um script KWin por chamada)
        this.timer = null;
        this.lastDetected = { title: '', app: '', profile: null };
        this.enabled = true;
        this.running = false;
        this.busy = false;
        this.backend = null;
        this.disabledBackends = new Set();
        this.pollFailures = 0;
        this.warnedNoBackend = false;
        // xdotool: no Wayland só enxerga janelas XWayland e aborta (core dump) nas nativas
        this.xdotoolBroken = false;
        this.xdotoolFailures = 0;
        this.kwin = { monitor: null, scriptPath: null, loaded: false, stopping: false, buf: '', retries: 0, healthTimer: null, retryTimer: null, reloadTimer: null };
    }

    static describeBackend(backend) {
        return BACKEND_LABEL[backend] || 'INDISPONÍVEL';
    }

    /** Texto para o log de início: backend em uso ou motivo de não haver nenhum. */
    describe() {
        if (!this.enabled) return 'desligada';
        return WindowDetector.describeBackend(this.backend);
    }

    start() {
        if (this.running) return;
        this.running = true;
        if (!this.enabled) {
            console.log('[WindowDetector] Auto-detecção desligada: nenhum backend em execução');
            return;
        }
        this.startBackend();
    }

    stop() {
        this.running = false;
        this.stopBackend(true);
    }

    /** Desligar a auto-detecção para os backends de verdade: nada roda enquanto estiver off. */
    setEnabled(flag) {
        const on = !!flag;
        if (on === this.enabled) return;
        this.enabled = on;
        console.log(`[WindowDetector] Auto-Detecção ${on ? 'Ativada' : 'Desativada'}`);
        if (!this.running) return;
        if (on) this.startBackend();
        else this.stopBackend(false);
    }

    // ------------------------------------------------------------------
    // Escolha e ciclo de vida dos backends
    // ------------------------------------------------------------------

    chooseBackend() {
        if (this.platform === 'win32') return 'windows';
        if (this.platform === 'darwin') return 'mac';
        if (this.platform !== 'linux') return null;
        const caps = SystemActions.capabilities();
        const order = [];
        if (caps.qdbus && caps.busctl && /kde|plasma/i.test(caps.desktop)) order.push('kwin');
        if (caps.kdotool) order.push('kdotool');
        if (caps.hyprland) order.push('hyprland');
        if (caps.sway) order.push('sway');
        if (caps.xdotool && !caps.wayland && !this.xdotoolBroken) order.push('xdotool'); // nunca no Wayland
        return order.find((b) => !this.disabledBackends.has(b)) || null;
    }

    startBackend() {
        if (this.backend) return;
        const backend = this.chooseBackend();
        if (!backend) {
            this.warnNoBackend();
            return;
        }
        this.backend = backend;
        this.pollFailures = 0;
        if (backend === 'kwin') {
            this.startKwin();
            return;
        }
        this.timer = setInterval(() => this.poll(), this.pollInterval);
        console.log(`[WindowDetector] Monitorando a janela ativa via ${WindowDetector.describeBackend(backend)} a cada ${this.pollInterval} ms`);
    }

    stopBackend(sync) {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.backend === 'kwin') this.stopKwin(sync);
        this.backend = null;
        this.busy = false;
    }

    /** Um backend falhou de vez: avisa uma vez, com o motivo, e passa para o próximo. */
    backendFailed(backend, reason) {
        if (this.backend !== backend) return;
        this.disabledBackends.add(backend);
        this.stopBackend(false);
        const next = this.chooseBackend();
        console.log(`[WindowDetector] Backend ${WindowDetector.describeBackend(backend)} indisponível: ${reason}. ` +
            (next ? `Passando para ${WindowDetector.describeBackend(next)}.` : 'Nenhum outro backend disponível.'));
        if (this.running && this.enabled) this.startBackend();
    }

    warnNoBackend() {
        if (this.warnedNoBackend) return;
        this.warnedNoBackend = true;
        const caps = SystemActions.capabilities();
        console.log(`[WindowDetector] Nenhum backend consegue ler a janela ativa (wayland=${caps.wayland}, desktop="${caps.desktop}", qdbus=${caps.qdbus}, busctl=${caps.busctl}, kdotool=${caps.kdotool}, xdotool=${caps.xdotool}). ` +
            'No KDE a detecção usa um script KWin (precisa de qdbus e busctl); em outros compositores Wayland instale o kdotool (cargo install kdotool). A troca automática de perfil fica desativada.');
    }

    // ------------------------------------------------------------------
    // Backend KWin (orientado a evento)
    // ------------------------------------------------------------------

    async startKwin() {
        const k = this.kwin;
        k.stopping = false;
        k.retries = 0;
        k.scriptPath = path.join(SystemActions.hostVisibleTmpDir(), `${KWIN_PLUGIN}.js`);
        try {
            fs.writeFileSync(k.scriptPath, buildKwinWatchScript(), { mode: 0o600 });
        } catch (e) {
            return this.backendFailed('kwin', `não foi possível escrever o script em ${k.scriptPath} (${e.message})`);
        }
        if (!this.startKwinMonitor()) return;
        // O busctl precisa estar ouvindo antes do script reportar a janela atual
        await sleep(400);
        if (k.stopping || this.backend !== 'kwin') return;
        if (!(await this.loadKwinScript())) return;
        k.healthTimer = setInterval(() => this.checkKwinHealth(), KWIN_HEALTH_MS);
        console.log('[WindowDetector] Monitorando a janela ativa via script KWin (evento, sem polling)');
    }

    startKwinMonitor() {
        const k = this.kwin;
        const matches = [
            `type='method_call',interface='${KWIN_DBUS_NAME}'`,
            // KWin reiniciou (crash/relogin): o script morreu junto e precisa ser recarregado
            "type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.kde.KWin'"
        ];
        let child;
        try {
            child = spawn('busctl', ['--user', 'monitor', '--json=short', '--match', matches[0], '--match', matches[1]], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            this.backendFailed('kwin', `busctl não iniciou (${e.message})`);
            return false;
        }
        k.monitor = child;
        k.buf = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => this.onKwinMonitorData(chunk));
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1000); });
        child.on('error', (e) => { if (k.monitor === child) this.onKwinMonitorExit(`erro ao executar busctl: ${e.message}`); });
        child.on('exit', (code, signal) => {
            if (k.monitor === child) this.onKwinMonitorExit(`busctl monitor terminou (code=${code}, signal=${signal})${stderr.trim() ? ': ' + stderr.trim() : ''}`);
        });
        return true;
    }

    onKwinMonitorData(chunk) {
        const k = this.kwin;
        k.buf += chunk.toString();
        let nl;
        while ((nl = k.buf.indexOf('\n')) >= 0) {
            const line = k.buf.slice(0, nl).trim();
            k.buf = k.buf.slice(nl + 1);
            if (!line || line[0] !== '{') continue;
            let msg;
            try { msg = JSON.parse(line); } catch (e) { continue; }
            const data = (msg.payload && Array.isArray(msg.payload.data)) ? msg.payload.data : [];
            if (msg.member === 'ActiveWindow' && msg.interface === KWIN_DBUS_NAME) {
                k.retries = 0;
                this.evaluateWindow(String(data[0] || '').trim(), String(data[1] || data[2] || '').trim());
            } else if (msg.member === 'NameOwnerChanged' && data[0] === 'org.kde.KWin' && data[2]) {
                console.log('[WindowDetector] KWin voltou ao barramento; recarregando o script de detecção');
                this.scheduleKwinReload();
            }
        }
    }

    onKwinMonitorExit(reason) {
        const k = this.kwin;
        k.monitor = null;
        if (k.stopping || this.backend !== 'kwin') return;
        if (k.retries >= KWIN_MONITOR_MAX_RETRIES) {
            this.backendFailed('kwin', `${reason}; desisti após ${KWIN_MONITOR_MAX_RETRIES} tentativas`);
            return;
        }
        k.retries++;
        console.log(`[WindowDetector] ${reason}; reiniciando o monitor em ${KWIN_MONITOR_RETRY_MS / 1000} s (${k.retries}/${KWIN_MONITOR_MAX_RETRIES})`);
        k.retryTimer = setTimeout(() => {
            k.retryTimer = null;
            if (this.backend === 'kwin' && !k.stopping) this.startKwinMonitor();
        }, KWIN_MONITOR_RETRY_MS);
    }

    async loadKwinScript() {
        const k = this.kwin;
        const qdbus = SystemActions.capabilities().qdbus;
        if (!qdbus) {
            this.backendFailed('kwin', 'qdbus não encontrado');
            return false;
        }
        // Instância antiga (servidor anterior que caiu sem descarregar) sai antes de carregar a nova
        await runRes(qdbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', KWIN_PLUGIN], 3000);
        if (k.stopping) return false;
        const load = await runRes(qdbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.loadScript', k.scriptPath, KWIN_PLUGIN], 3000);
        const id = parseInt(load.stdout.trim(), 10);
        if (!load.ok || Number.isNaN(id) || id < 0) {
            this.backendFailed('kwin', `loadScript falhou: ${(load.stderr || load.stdout).trim() || 'sem resposta do KWin'}`);
            return false;
        }
        k.loaded = true;
        // Plasma 6: /Scripting/Script<N>; Plasma 5: /<N>
        let ran = await runRes(qdbus, ['org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script.run'], 3000);
        if (!ran.ok) ran = await runRes(qdbus, ['org.kde.KWin', `/${id}`, 'org.kde.kwin.Script.run'], 3000);
        if (!ran.ok) {
            this.backendFailed('kwin', `Script.run falhou: ${ran.stderr.trim() || 'sem resposta do KWin'}`);
            return false;
        }
        return true;
    }

    scheduleKwinReload() {
        const k = this.kwin;
        if (k.reloadTimer) clearTimeout(k.reloadTimer);
        k.reloadTimer = setTimeout(() => {
            k.reloadTimer = null;
            if (this.backend === 'kwin' && !k.stopping) this.loadKwinScript();
        }, KWIN_RELOAD_DELAY_MS);
    }

    async checkKwinHealth() {
        const k = this.kwin;
        if (this.backend !== 'kwin' || k.stopping) return;
        const qdbus = SystemActions.capabilities().qdbus;
        const res = await runRes(qdbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.isScriptLoaded', KWIN_PLUGIN], 3000);
        if (res.ok && res.stdout.trim() === 'false' && this.backend === 'kwin' && !k.stopping) {
            console.log('[WindowDetector] Script KWin não está mais carregado; recarregando');
            await this.loadKwinScript();
        }
    }

    stopKwin(sync) {
        const k = this.kwin;
        k.stopping = true;
        for (const t of ['healthTimer', 'retryTimer']) {
            if (k[t]) { clearInterval(k[t]); clearTimeout(k[t]); k[t] = null; }
        }
        if (k.reloadTimer) { clearTimeout(k.reloadTimer); k.reloadTimer = null; }
        if (k.monitor) {
            const child = k.monitor;
            k.monitor = null;
            try { child.kill(); } catch (e) { /* já saiu */ }
        }
        if (k.loaded) {
            k.loaded = false;
            const qdbus = SystemActions.capabilities().qdbus;
            if (qdbus) {
                const args = ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', KWIN_PLUGIN];
                if (sync) {
                    // No encerramento do servidor não dá tempo de esperar callback: descarrega de forma síncrona
                    try { execSync(`${qdbus} ${args.join(' ')}`, { timeout: 2000, stdio: 'ignore' }); } catch (e) { /* KWin fora */ }
                } else {
                    execFile(qdbus, args, { timeout: 3000 }, () => {});
                }
            }
        }
        if (k.scriptPath) {
            fs.unlink(k.scriptPath, () => {});
            k.scriptPath = null;
        }
    }

    // ------------------------------------------------------------------
    // Backends de polling
    // ------------------------------------------------------------------

    poll() {
        if (!this.enabled || this.busy || !this.backend) return;
        this.busy = true;
        let p;
        switch (this.backend) {
            case 'kdotool': p = this.pollKdotool(); break;
            case 'hyprland': p = this.pollHyprland(); break;
            case 'sway': p = this.pollSway(); break;
            case 'xdotool': p = this.pollXdotool(); break;
            case 'windows': p = this.detectWindows(); break;
            case 'mac': p = this.detectMac(); break;
            default: p = Promise.resolve();
        }
        p.catch(() => {}).then(() => { this.busy = false; });
    }

    /** Leitura vazia num backend de polling; depois de várias seguidas o backend é dado como quebrado. */
    notePollFailure(backend, reason) {
        if (++this.pollFailures >= POLL_MAX_FAILURES) {
            this.backendFailed(backend, `${POLL_MAX_FAILURES} leituras seguidas sem resposta (${reason})`);
        }
    }

    async pollKdotool() {
        // Uma chamada só por ciclo: o kdotool encadeia comandos como o xdotool e cada chamada carrega um script KWin
        const out = await runFile('kdotool', ['getactivewindow', 'getwindowname', 'getwindowclassname'], 1500);
        if (out === null) return this.notePollFailure('kdotool', 'kdotool getactivewindow falhou');
        const lines = out.replace(/\n+$/, '').split('\n').map((s) => s.trim());
        let title = lines[0] || '';
        let app = lines[1] || '';
        if (lines.length < 2) {
            // kdotool antigo sem encadeamento: segunda chamada só pela classe
            app = ((await runFile('kdotool', ['getactivewindow', 'getwindowclassname'], 1500)) || '').trim();
        }
        this.pollFailures = 0;
        this.evaluateWindow(title, app);
    }

    async pollHyprland() {
        const out = await runFile('hyprctl', ['activewindow', '-j'], 400);
        if (!out) return this.notePollFailure('hyprland', 'hyprctl sem resposta');
        try {
            const data = JSON.parse(out);
            this.pollFailures = 0;
            this.evaluateWindow(data.title || '', data.class || '');
        } catch (e) {
            this.notePollFailure('hyprland', 'JSON inválido');
        }
    }

    async pollSway() {
        const out = await runFile('swaymsg', ['-t', 'get_tree'], 400);
        if (!out) return this.notePollFailure('sway', 'swaymsg sem resposta');
        try {
            const findFocused = (node) => {
                if (node.focused) return node;
                for (const child of (node.nodes || []).concat(node.floating_nodes || [])) {
                    const res = findFocused(child);
                    if (res) return res;
                }
                return null;
            };
            const focused = findFocused(JSON.parse(out));
            this.pollFailures = 0;
            if (focused) this.evaluateWindow(focused.name || '', focused.app_id || '');
        } catch (e) {
            this.notePollFailure('sway', 'JSON inválido');
        }
    }

    async pollXdotool() {
        // Só X11 (chooseBackend nunca escolhe xdotool no Wayland). Um processo por ciclo.
        if (this.xdotoolBroken) return;
        const out = await runFile('xdotool', ['getactivewindow', 'getwindowname', 'getwindowclassname'], 400);
        if (out && out.trim()) {
            this.xdotoolFailures = 0;
            this.pollFailures = 0;
            const lines = out.trim().split('\n');
            this.evaluateWindow((lines[0] || '').trim(), (lines[1] || '').trim());
            return;
        }
        // No Wayland o xdotool só enxerga janelas XWayland e aborta (core dump) nas nativas
        if (SystemActions.capabilities().wayland && ++this.xdotoolFailures >= 5) {
            this.xdotoolBroken = true;
            return this.backendFailed('xdotool', 'falhou 5 vezes seguidas no Wayland; desativado até reiniciar o servidor');
        }
        this.notePollFailure('xdotool', 'xdotool getactivewindow sem resposta');
    }

    detectWindows() {
        const psCmd = `powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public class Win { [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\"user32.dll\\")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count); }'; \\$w = [Win]::GetForegroundWindow(); \\$b = New-Object System.Text.StringBuilder 256; [Win]::GetWindowText(\\$w, \\$b, 256) | Out-Null; \\$b.ToString()"`;
        return runShell(psCmd, 500).then((stdout) => {
            if (stdout) this.evaluateWindow(stdout.trim(), '');
        });
    }

    detectMac() {
        const cmd = `osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`;
        return runShell(cmd, 500).then((stdout) => {
            if (stdout) {
                const app = stdout.trim();
                this.evaluateWindow(app, app);
            }
        });
    }

    // ------------------------------------------------------------------
    // Casamento com perfis
    // ------------------------------------------------------------------

    static get DETECTABLE_APPS() { return DETECTABLE_APPS; }

    static matchProfile(title, app) {
        const cls = (app || '').trim();
        if (cls) {
            for (const rule of CLASS_RULES) {
                if (rule.re.test(cls)) return rule.profile;
            }
        }
        const t = title || '';
        if (t) {
            for (const rule of TITLE_RULES) {
                if (rule.re.test(t)) return rule.profile;
            }
        }
        return null;
    }

    evaluateWindow(title, app) {
        const targetProfile = WindowDetector.matchProfile(title, app);

        if (title !== this.lastDetected.title || app !== this.lastDetected.app || targetProfile !== this.lastDetected.profile) {
            this.lastDetected = { title, app, profile: targetProfile };
            this.emit('windowChanged', { title, app, profile: targetProfile });
        }
    }
}

module.exports = WindowDetector;
