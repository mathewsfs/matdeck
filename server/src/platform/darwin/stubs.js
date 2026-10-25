// Áreas que a fase 3 implementa (Spotify/Music por AppleScript, telemetria por Mach/IOKit): por enquanto
// respondem "indisponível" com a mesma forma dos módulos Linux, para o servidor e o deck seguirem iguais.
const EventEmitter = require('events');

class StubSpotify extends EventEmitter {
    constructor() { super(); this.state = { running: false, available: false, status: 'Stopped', title: '', artist: '', album: '', artUrl: '', positionMs: 0, lengthMs: 0, shuffle: false, loop: 'None' }; }
    start() {}
    stop() {}
    setActive() {}
    snapshot() { return { ...this.state }; }
    artOf() { return null; }
    async resolve() { return null; }
    async playPause() { return false; }
    async next() { return false; }
    async previous() { return false; }
    async seek() { return false; }
    async setShuffle() { return false; }
    async setLoop() { return false; }
    async cycleLoop() { return false; }
    async openUri() { return false; }
    raise() { return false; }
}

class StubMediaPlayers extends EventEmitter {
    constructor() { super(); this.players = []; }
    start() {}
    stop() {}
    setActive() {}
    get active() { return null; }
    snapshot() { return { available: false, active: null, players: [] }; }
    artOf() { return null; }
    playPause() { return Promise.resolve(false); }
    next() { return Promise.resolve(false); }
    previous() { return Promise.resolve(false); }
    seek() { return Promise.resolve(false); }
    raise() { return Promise.resolve(false); }
    switchActive() { return Promise.resolve(false); }
}

const HISTORY_KEYS = ['cpuUsage', 'cpuTemp', 'gpuUsage', 'gpuTemp', 'netDown', 'netUp', 'diskRead', 'diskWrite'];

class StubHardwareMonitor extends EventEmitter {
    constructor(intervalMs = 1000) {
        super();
        this.intervalMs = intervalMs;
        this.timer = null;
        this.active = false;
        this.history = {};
        for (const k of HISTORY_KEYS) this.history[k] = [];
        this.currentStats = {
            cpu: { usage: 0, temp: null },
            gpu: { usage: 0, temp: null, vramUsedGB: '0.0', vramTotalGB: '0.0', vramPercent: 0, available: false },
            ram: { usedGB: '0.0', totalGB: '0.0', percent: 0 },
            net: { downBps: 0, upBps: 0 },
            disk: { readBps: 0, writeBps: 0 },
            history: this.history,
            timestamp: Date.now()
        };
    }
    currentInterval() { return this.active ? this.intervalMs : 10000; }
    describe() { return 'telemetria: indisponível no macOS (fase 3)'; }
    start() {
        if (this.timer) return;
        const tick = () => {
            this.currentStats.timestamp = Date.now();
            this.emit('stats', this.currentStats);
            this.timer = setTimeout(tick, this.currentInterval());
            this.timer.unref();
        };
        this.timer = setTimeout(tick, this.currentInterval());
        this.timer.unref();
    }
    stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
    setActive(active) {
        const next = !!active;
        if (next === this.active) return;
        this.active = next;
        if (this.timer) { this.stop(); this.start(); }
    }
}

module.exports = { StubSpotify, StubMediaPlayers, StubHardwareMonitor };
