// Áudio no macOS: só o volume master (CoreAudio pelo helper). Não há mixer por aplicativo sem driver
// virtual, então discord/teamspeak/obs/browser/spotify/game aparecem com `available:false` e o deck
// mostra "n/d" nos faders. Mesma forma do AudioMixer do Linux (getAll/appState/setVolume/adjustVolume/
// toggleMute/stop + evento volumeChange).
const EventEmitter = require('events');

const UNAVAILABLE = [
    ['discord', 'Discord', 'discord'], ['teamspeak', 'TeamSpeak', 'teamspeak'], ['obs', 'OBS Studio', 'stream'],
    ['browser', 'Navegador', 'scene'], ['spotify', 'Spotify / Mídia', 'scene'], ['game', 'Jogos', 'scene']
];

const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

class HelperAudioMixer extends EventEmitter {
    constructor(client) {
        super();
        this.client = client;
        this.stopped = false;
        this.warned = new Set();
        this.appStates = { master: { id: 'master', name: 'Master Mac', volume: 100, muted: false, icon: 'headphone', available: true } };
        for (const [id, name, icon] of UNAVAILABLE) this.appStates[id] = { id, name, volume: 0, muted: false, icon, available: false };
        client.on('audio.master', (data) => this.applyMaster(data));
        client.on('connected', () => this.sync());
        if (client.connected) this.sync();
    }

    warnOnce(key, msg) { if (!this.warned.has(key)) { this.warned.add(key); console.log(msg); } }

    /** Ao conectar: lê o estado atual e assina as mudanças. */
    sync() {
        if (this.stopped) return;
        this.client.request('audio.master.get', {}).then((st) => this.applyMaster(st)).catch((e) => this.masterFailed('get', e));
        this.client.request('audio.master.subscribe', { on: true }).catch((e) => this.warnOnce('sub', `[AudioMixer] Não foi possível assinar o volume master: ${e.message || e.code}`));
    }

    /** Sem dispositivo de saída ou sem controle de volume (not_supported): o master vira n/d até o helper avisar um estado. */
    masterFailed(what, e) {
        const code = (e && e.code) || 'erro';
        this.warnOnce(`${what}:${code}`, `[AudioMixer] Volume master indisponível (${what}): ${e.message || code}`);
        if (code !== 'not_supported') return;
        const m = this.appStates.master;
        if (!m.available) return;
        m.available = false; m.volume = 0; m.muted = false;
        this.emit('volumeChange', { appId: 'master', volume: 0, muted: false });
    }

    applyMaster(data) {
        if (!data || typeof data !== 'object') return;
        const m = this.appStates.master;
        const volume = typeof data.volume === 'number' ? clamp(data.volume) : m.volume;
        const muted = typeof data.muted === 'boolean' ? data.muted : m.muted;
        if (m.available && volume === m.volume && muted === m.muted) return;
        m.available = true; m.volume = volume; m.muted = muted;
        this.emit('volumeChange', { appId: 'master', volume, muted });
    }

    getAll() { return this.appStates; }

    appState(appId) {
        return Object.prototype.hasOwnProperty.call(this.appStates, appId) ? this.appStates[appId] : null;
    }

    setVolume(appId, volumePercent) {
        const app = this.appState(appId);
        if (!app || !app.available) return;
        const volume = clamp(volumePercent);
        this.client.request('audio.master.set', { volume }).then((st) => this.applyMaster(st || { volume })).catch((e) => this.masterFailed('set', e));
    }

    adjustVolume(appId, delta) {
        const app = this.appState(appId);
        if (!app || !app.available) return;
        this.setVolume(appId, app.volume + (parseInt(delta, 10) || 0));
    }

    toggleMute(appId) {
        const app = this.appState(appId);
        if (!app || !app.available) return;
        const muted = !app.muted;
        this.client.request('audio.master.mute', { muted }).then((st) => this.applyMaster(st || { muted })).catch((e) => this.masterFailed('mute', e));
    }

    stop() {
        this.stopped = true;
        if (this.client.connected) this.client.request('audio.master.subscribe', { on: false }).catch(() => {});
    }
}

function createAudio(client) {
    const mixer = new HelperAudioMixer(client);
    const settle = () => new Promise((r) => setImmediate(r));
    return {
        mixer,
        async masterStep(delta) {
            mixer.adjustVolume('master', delta);
            await settle();
            return true;
        },
        async masterMuteToggle() {
            mixer.toggleMute('master');
            await settle();
            return true;
        }
    };
}

module.exports = { createAudio, HelperAudioMixer };
