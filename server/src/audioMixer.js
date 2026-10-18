const { exec, spawn, which } = require('./hostExec');
const os = require('os');
const EventEmitter = require('events');

// pactl é localizado ("Sink Input #" vira "Entrada de destino #"); forçamos locale C para o parser
const EXEC_OPTS = { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, timeout: 1500 };
const POLL_WITH_EVENTS_MS = 15000;   // reserva quando o `pactl subscribe` está vivo
const POLL_FALLBACK_MS = 3000;       // sem eventos (subscribe caiu)
const EVENT_DEBOUNCE_MS = 150;
const SUBSCRIBE_RETRY_MS = 10000;
const SUBSCRIBE_MAX_RETRIES = 5;

/**
 * Volume por app via PulseAudio/PipeWire (pactl).
 *
 * Em vez de sondar o pactl a cada 1,5 s (eram ~200 processos por minuto, mesmo sem ninguém olhando),
 * um `pactl subscribe` persistente avisa quando um sink ou sink-input muda e só então relemos o
 * estado; um poll lento fica de reserva. Erros vão para o log (uma vez por motivo) em vez de sumir.
 */
class AudioMixer extends EventEmitter {
    constructor() {
        super();
        this.platform = os.platform();
        this.timer = null;
        this.refreshTimer = null;
        this.subscriber = null;
        this.subscribeRetries = 0;
        this.subscribeTimer = null;
        this.stopped = false;
        this.lastError = '';

        // Known apps and their current state
        this.appStates = {
            master: { id: 'master', name: 'Master PC', volume: 100, muted: false, icon: 'headphone' },
            discord: { id: 'discord', name: 'Discord', volume: 80, muted: false, icon: 'discord' },
            teamspeak: { id: 'teamspeak', name: 'TeamSpeak', volume: 80, muted: false, icon: 'teamspeak' },
            obs: { id: 'obs', name: 'OBS Studio', volume: 100, muted: false, icon: 'stream' },
            browser: { id: 'browser', name: 'Navegador', volume: 70, muted: false, icon: 'scene' },
            spotify: { id: 'spotify', name: 'Spotify / Mídia', volume: 60, muted: false, icon: 'scene' },
            game: { id: 'game', name: 'Jogos', volume: 90, muted: false, icon: 'scene' }
        };

        this.init();
    }

    init() {
        if (this.platform !== 'linux') return;
        this.available = !!which('pactl');
        if (!this.available) {
            console.warn('[AudioMixer] pactl não encontrado: faders de volume desativados (instale pipewire-pulse ou pulseaudio-utils)');
            return;
        }
        this.refreshStates();
        this.startSubscribe();
        this.scheduleNext();
        console.log('[AudioMixer] Controle de volume por aplicativo iniciado (eventos do pactl + poll de reserva)');
    }

    stop() {
        this.stopped = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
        if (this.subscribeTimer) { clearTimeout(this.subscribeTimer); this.subscribeTimer = null; }
        if (this.subscriber) {
            const child = this.subscriber;
            this.subscriber = null;
            try { child.kill(); } catch (e) { /* já saiu */ }
        }
    }

    scheduleNext() {
        if (this.stopped) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this.refreshStates(); this.scheduleNext(); }, this.subscriber ? POLL_WITH_EVENTS_MS : POLL_FALLBACK_MS);
    }

    // ------------------------------------------------------------------
    // Eventos do PulseAudio/PipeWire
    // ------------------------------------------------------------------

    startSubscribe() {
        if (this.stopped || this.subscriber) return;
        let child;
        try {
            child = spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'pipe'], env: EXEC_OPTS.env });
        } catch (e) {
            this.onSubscribeExit(`não iniciou: ${e.message}`);
            return;
        }
        this.subscriber = child;
        let buf = '';
        child.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                // "Event 'change' on sink-input #123" / "Event 'new' on sink #45" / "Event 'change' on server"
                if (/Event '(new|change|remove)' on (sink|sink-input|server)\b/.test(line)) this.scheduleRefresh();
            }
        });
        child.stderr.on('data', () => {});
        child.on('error', (e) => { if (this.subscriber === child) this.onSubscribeExit(`erro: ${e.message}`); });
        child.on('exit', (code, signal) => { if (this.subscriber === child) this.onSubscribeExit(`terminou (code=${code}, signal=${signal})`); });
    }

    onSubscribeExit(reason) {
        this.subscriber = null;
        if (this.stopped) return;
        if (this.subscribeRetries < SUBSCRIBE_MAX_RETRIES) {
            this.subscribeRetries++;
            console.warn(`[AudioMixer] pactl subscribe ${reason}; nova tentativa em ${SUBSCRIBE_RETRY_MS / 1000} s (${this.subscribeRetries}/${SUBSCRIBE_MAX_RETRIES})`);
            this.subscribeTimer = setTimeout(() => { this.subscribeTimer = null; this.startSubscribe(); }, SUBSCRIBE_RETRY_MS);
        } else {
            console.warn(`[AudioMixer] pactl subscribe ${reason}; seguindo só com poll a cada ${POLL_FALLBACK_MS / 1000} s`);
        }
        this.scheduleNext();
    }

    scheduleRefresh() {
        if (this.refreshTimer) return;
        this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refreshStates(); }, EVENT_DEBOUNCE_MS);
    }

    // ------------------------------------------------------------------
    // Leitura
    // ------------------------------------------------------------------

    refreshStates() {
        if (this.platform === 'linux' && this.available) this.refreshLinux();
    }

    logError(msg) {
        if (msg === this.lastError) return;
        this.lastError = msg;
        console.warn(`[AudioMixer] ${msg}`);
    }

    refreshLinux() {
        // Uma chamada só: volume/mudo do sink padrão e a lista de sink-inputs, separados por um marcador
        const cmd = 'pactl get-sink-volume @DEFAULT_SINK@; pactl get-sink-mute @DEFAULT_SINK@; echo @@INPUTS; pactl list sink-inputs';
        exec(cmd, EXEC_OPTS, (err, stdout, stderr) => {
            const out = String(stdout || '');
            if (err && !out.trim()) {
                this.logError(`pactl falhou: ${String(stderr || err.message).trim().split('\n')[0]}`);
                return;
            }
            if (this.lastError) { this.lastError = ''; console.log('[AudioMixer] pactl voltou a responder'); }
            const [masterPart, inputsPart = ''] = out.split('@@INPUTS');

            const volMatch = masterPart.match(/(\d+)%/);
            if (volMatch) this.appStates.master.volume = parseInt(volMatch[1], 10);
            this.appStates.master.muted = /Mute:\s*(sim|yes)/i.test(masterPart);

            const seen = new Set();
            const blocks = inputsPart.split('Sink Input #');
            for (let i = 1; i < blocks.length; i++) {
                const b = blocks[i];
                const idMatch = b.match(/^(\d+)/);
                const sinkId = idMatch ? idMatch[1] : null;

                const nameMatch = b.match(/application.name = \"([^\"]+)\"/);
                const binaryMatch = b.match(/application.process.binary = \"([^\"]+)\"/);
                const rawName = ((nameMatch && nameMatch[1]) || (binaryMatch && binaryMatch[1]) || '').toLowerCase();

                const inVol = b.match(/Volume:[^/]+\/\s*(\d+)%/);
                const volume = inVol ? parseInt(inVol[1], 10) : 100;
                const muted = /Mute:\s*(sim|yes)/i.test(b);

                // Match with known app categories
                let targetKey = null;
                if (rawName.includes('discord')) targetKey = 'discord';
                else if (rawName.includes('teamspeak') || rawName.includes('ts3')) targetKey = 'teamspeak';
                else if (rawName.includes('obs')) targetKey = 'obs';
                else if (rawName.includes('spotify')) targetKey = 'spotify';
                else if (rawName.includes('brave') || rawName.includes('chrome') || rawName.includes('firefox')) targetKey = 'browser';

                if (targetKey && this.appStates[targetKey]) {
                    const app = this.appStates[targetKey];
                    if (!seen.has(targetKey)) {
                        app.sinkIds = [];
                        app.volume = volume;
                        app.muted = muted;
                    }
                    seen.add(targetKey);
                    if (sinkId) app.sinkIds.push(sinkId);
                    app.sinkId = app.sinkIds[0] || null;
                }
            }
            for (const key of Object.keys(this.appStates)) {
                if (key !== 'master' && !seen.has(key)) {
                    this.appStates[key].sinkId = null;
                    this.appStates[key].sinkIds = [];
                }
            }
        });
    }

    // ------------------------------------------------------------------
    // Escrita
    // ------------------------------------------------------------------

    pactl(args) {
        exec(`pactl ${args}`, EXEC_OPTS, (err, stdout, stderr) => {
            if (err) this.logError(`pactl ${args.split(' ')[0]} falhou: ${String(stderr || err.message).trim().split('\n')[0]}`);
        });
    }

    setVolume(appId, volumePercent) {
        const vol = Math.max(0, Math.min(100, Math.round(volumePercent)));
        const app = this.appStates[appId];
        if (!app) return;

        app.volume = vol;
        if (vol > 0 && app.muted) {
            app.muted = false;
        }

        console.log(`[AudioMixer] Definindo volume de ${app.name} para ${vol}%`);

        if (this.platform === 'linux' && this.available) {
            if (appId === 'master') {
                this.pactl(`set-sink-volume @DEFAULT_SINK@ ${vol}%`);
            } else if (app.sinkIds && app.sinkIds.length) {
                for (const id of app.sinkIds) {
                    if (/^\d+$/.test(String(id))) this.pactl(`set-sink-input-volume ${id} ${vol}%`);
                }
            } else {
                console.log(`[AudioMixer] ${app.name} não está reproduzindo áudio agora; volume será aplicado quando aparecer.`);
            }
        }

        this.emit('volumeChange', { appId, volume: vol, muted: app.muted });
    }

    adjustVolume(appId, delta) {
        const app = this.appStates[appId];
        if (!app) return;
        const step = parseInt(delta, 10);
        if (isNaN(step)) return;
        this.setVolume(appId, (app.volume || 0) + step);
    }

    toggleMute(appId) {
        const app = this.appStates[appId];
        if (!app) return;

        app.muted = !app.muted;
        console.log(`[AudioMixer] ${app.name} Mute alterado para: ${app.muted ? 'MUTADO' : 'ATIVO'}`);

        if (this.platform === 'linux' && this.available) {
            if (appId === 'master') {
                this.pactl(`set-sink-mute @DEFAULT_SINK@ ${app.muted ? '1' : '0'}`);
            } else if (app.sinkIds && app.sinkIds.length) {
                for (const id of app.sinkIds) {
                    if (/^\d+$/.test(String(id))) this.pactl(`set-sink-input-mute ${id} ${app.muted ? '1' : '0'}`);
                }
            }
        }

        this.emit('volumeChange', { appId, volume: app.volume, muted: app.muted });
    }

    getAll() {
        return this.appStates;
    }
}

module.exports = AudioMixer;
