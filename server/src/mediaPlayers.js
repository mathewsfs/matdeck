/**
 * Players de mídia do sistema via MPRIS (D-Bus de sessão), lidos pelo host com busctl.
 *
 * Qualquer app que publique org.mpris.MediaPlayer2.* entra aqui: navegadores (Brave, Chrome, Firefox
 * com um vídeo do YouTube), VLC, mpv, Spotify... É o mesmo que o popup de mídia do navegador mostra.
 * O "player ativo" é o que está tocando (o mais recente, se houver mais de um) ou o último que tocou.
 *
 * Presença e mudanças chegam por evento (NameOwnerChanged, PropertiesChanged, Seeked) por um único
 * `busctl monitor`; só a posição é sondada, e só enquanto algo toca. Capas em file:// são lidas no
 * host (o /tmp do Flatpak é outro), https são baixadas, e o tablet recebe tudo por /api/media/art/<id>.
 */
const EventEmitter = require('events');
const crypto = require('crypto');
const { execFile, spawn } = require('./hostExec');
const SpotifyMonitor = require('./spotify');

const PREFIX = 'org.mpris.MediaPlayer2.';
const OBJ = '/org/mpris/MediaPlayer2';
const IFACE_PLAYER = 'org.mpris.MediaPlayer2.Player';
const IFACE_ROOT = 'org.mpris.MediaPlayer2';

const POLL_PLAYING_MS = 2000;        // posição enquanto toca (extrapolada entre amostras)
const POLL_FALLBACK_MS = 5000;       // sem o monitor D-Bus
const EVENT_DEBOUNCE_MS = 150;
const ART_CACHE_MAX = 24;
const ART_MAX_BYTES = 5 * 1024 * 1024;
const EXEC_OPTS = { env: { ...process.env, LC_ALL: 'C' }, timeout: 2500 };

const EMPTY_PLAYER = Object.freeze({
    status: 'Stopped',       // Playing | Paused | Stopped
    title: '',
    artist: '',
    album: '',
    artUrl: '',
    artId: null,
    trackId: '',
    url: '',
    lengthMs: 0,
    positionMs: 0,
    canGoNext: false,
    canGoPrevious: false,
    canSeek: false,
    canControl: true
});

/** Desembrulha o JSON do `busctl -j` ({type, data}) em valores simples. */
function unwrap(node) {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map(unwrap);
    if (typeof node === 'object') {
        if ('type' in node && 'data' in node) {
            if (node.type === 'a{sv}' && Array.isArray(node.data)) return unwrap(node.data[0] || {});
            return unwrap(node.data);
        }
        const out = {};
        for (const k of Object.keys(node)) out[k] = unwrap(node[k]);
        return out;
    }
    return node;
}

function mimeOf(buffer) {
    if (!buffer || buffer.length < 4) return 'application/octet-stream';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer.slice(0, 4).toString() === 'RIFF') return 'image/webp';
    if (buffer.slice(0, 4).toString() === 'GIF8') return 'image/gif';
    return 'application/octet-stream';
}

class MediaPlayers extends EventEmitter {
    constructor() {
        super();
        this.players = new Map();     // nome D-Bus -> { name, unique, identity, lastPlayingAt, ...EMPTY_PLAYER }
        this.activeName = null;
        this.watcher = null;
        this.stopped = false;
        this.timer = null;
        this.debounceTimer = null;
        this.pending = new Set();     // players a sondar no próximo ciclo (vazio = todos)
        this.polling = false;
        this.artCache = new Map();    // artId -> { buffer, mime }
        this.artPending = new Set();
        this.artFailed = new Map();   // artId -> quando falhou (não tenta de novo por 1 min)
        this.pinnedName = null;       // escolhido por player:switch; vale até outro player começar a tocar
        this.lastSampleAt = 0;
    }

    start() {
        if (this.watcher) return;
        this.stopped = false;
        this.startWatcher();
        this.discover();
        const again = setTimeout(() => { if (!this.stopped) this.discover(); }, 2000);
        if (typeof again.unref === 'function') again.unref();
        console.log(`[Media] Monitor de players MPRIS iniciado${this.watcher ? ' (eventos D-Bus; posição sondada só enquanto toca)' : ''}`);
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer); this.timer = null;
        clearTimeout(this.debounceTimer); this.debounceTimer = null;
        if (this.watcher) {
            const child = this.watcher;
            this.watcher = null;
            try { child.kill(); } catch (e) { /* já saiu */ }
        }
    }

    // ------------------------------------------------------------------
    // Descoberta e eventos
    // ------------------------------------------------------------------

    /** Lista os players já abertos (o monitor só vê quem entra depois). */
    discover() {
        execFile('busctl', ['--user', '--json=short', 'list', '--acquired'], { ...EXEC_OPTS, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                this.logError(`busctl list falhou: ${err.message}`);
                this.scheduleNext();
                return;
            }
            try {
                for (const row of JSON.parse(stdout)) {
                    if (typeof row.name === 'string' && row.name.startsWith(PREFIX)) this.addPlayer(row.name, row.connection || '');
                }
            } catch (e) {
                this.logError(`busctl list ilegível: ${e.message}`);
            }
            this.pollSoon(0);
        });
    }

    startWatcher() {
        if (this.watcher) return;
        let child;
        try {
            child = spawn('busctl', ['--user', 'monitor', '--json=short',
                '--match', `type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.mpris.MediaPlayer2'`,
                '--match', `type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='${OBJ}'`,
                '--match', `type='signal',interface='${IFACE_PLAYER}',member='Seeked'`
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            console.warn(`[Media] busctl monitor não iniciou; sondando a cada ${POLL_FALLBACK_MS / 1000} s:`, e.message);
            return;
        }
        this.watcher = child;
        let buf = '';
        child.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (line.startsWith('{')) this.onSignal(line);
            }
        });
        child.stderr.on('data', () => {});
        const gone = (why) => {
            if (this.watcher !== child) return;
            this.watcher = null;
            if (!this.stopped) {
                console.warn(`[Media] Monitor D-Bus ${why}; voltando a sondar a cada ${POLL_FALLBACK_MS / 1000} s`);
                this.pollSoon(0);
            }
        };
        child.on('error', (e) => gone(`falhou (${e.message})`));
        child.on('exit', (code, signal) => gone(`terminou (code=${code}, signal=${signal})`));
    }

    onSignal(line) {
        let msg;
        try { msg = JSON.parse(line); } catch (e) { return; }
        const data = msg.payload && msg.payload.data;
        if (msg.member === 'NameOwnerChanged' && Array.isArray(data)) {
            const [name, , newOwner] = data;
            if (typeof name !== 'string' || !name.startsWith(PREFIX)) return;
            if (newOwner) {
                this.addPlayer(name, newOwner);
                this.pending.add(name);
                this.pollSoon(400);     // o player acabou de subir: dá tempo de publicar os metadados
            } else {
                this.removePlayer(name);
            }
            return;
        }
        // PropertiesChanged / Seeked: só interessa se o remetente é um player conhecido
        const player = this.playerByUnique(msg.sender);
        if (!player) return;
        this.pending.add(player.name);
        this.pollSoon(EVENT_DEBOUNCE_MS);
    }

    playerByUnique(unique) {
        if (!unique) return null;
        for (const p of this.players.values()) if (p.unique === unique) return p;
        return null;
    }

    addPlayer(name, unique) {
        const existing = this.players.get(name);
        if (existing) { existing.unique = unique || existing.unique; return existing; }
        const player = { ...EMPTY_PLAYER, name, unique, identity: name.slice(PREFIX.length).replace(/\.instance\d+$/, ''), lastPlayingAt: 0 };
        this.players.set(name, player);
        this.fetchIdentity(player);
        return player;
    }

    removePlayer(name) {
        if (!this.players.delete(name)) return;
        if (this.activeName === name) this.activeName = null;
        if (this.pinnedName === name) this.pinnedName = null;
        this.chooseActive();
        this.emit('change', this.snapshot());
        this.scheduleNext();
    }

    fetchIdentity(player) {
        execFile('busctl', ['--user', '-j', 'get-property', player.name, OBJ, IFACE_ROOT, 'Identity'], EXEC_OPTS, (err, stdout) => {
            if (err || !this.players.has(player.name)) return;
            try {
                const id = unwrap(JSON.parse(stdout));
                if (typeof id === 'string' && id.trim()) { player.identity = id.trim(); this.emit('change', this.snapshot()); }
            } catch (e) { /* fica o nome do barramento */ }
        });
    }

    // ------------------------------------------------------------------
    // Sondagem
    // ------------------------------------------------------------------

    pollSoon(ms) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.poll(), ms);
        if (typeof this.debounceTimer.unref === 'function') this.debounceTimer.unref();
    }

    /** A posição só é sondada enquanto toca E há cliente conectado; metadados continuam por evento. */
    setActive(active) {
        active = !!active;
        if (active === this.liveViewers) return; // 'active' já é o getter do player em foco
        this.liveViewers = active;
        if (active && !this.stopped) this.pollSoon(0);
        else if (!active) this.scheduleNext();
    }

    scheduleNext() {
        clearTimeout(this.timer);
        this.timer = null;
        if (this.stopped) return;
        const playing = [...this.players.values()].some(p => p.status === 'Playing');
        let ms = null;
        if (playing && this.liveViewers) ms = POLL_PLAYING_MS;
        else if (!this.watcher) ms = POLL_FALLBACK_MS;
        if (ms === null) return;    // parado e com monitor: só eventos
        this.timer = setTimeout(() => { this.pending.clear(); this.poll(); }, ms);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    /** Sonda os players pendentes (ou todos) e emite 'change' se algo mudou. */
    poll() {
        if (this.polling || this.stopped) return;
        if (!this.watcher && !this.pending.size) {
            // Sem monitor, a lista de players também pode ter mudado
            this.polling = true;
            execFile('busctl', ['--user', '--json=short', 'list', '--acquired'], { ...EXEC_OPTS, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
                this.polling = false;
                if (!err) {
                    try {
                        const names = new Set(JSON.parse(stdout).filter(r => typeof r.name === 'string' && r.name.startsWith(PREFIX)).map(r => r.name));
                        for (const row of JSON.parse(stdout)) if (names.has(row.name)) this.addPlayer(row.name, row.connection || '');
                        for (const name of [...this.players.keys()]) if (!names.has(name)) this.removePlayer(name);
                    } catch (e) { /* mantém a lista atual */ }
                }
                this.pollPlayers([...this.players.keys()]);
            });
            return;
        }
        const names = this.pending.size ? [...this.pending] : [...this.players.keys()];
        this.pending.clear();
        this.pollPlayers(names);
    }

    pollPlayers(names) {
        if (!names.length) { this.scheduleNext(); return; }
        this.polling = true;
        let remaining = names.length;
        let changed = false;
        const done = () => {
            if (--remaining) return;
            this.polling = false;
            this.lastSampleAt = Date.now();
            const prevActive = this.activeName;
            this.chooseActive();
            if (changed || prevActive !== this.activeName) this.emit('change', this.snapshot());
            // Evento que chegou enquanto esta sondagem rodava: sonda de novo já, senão o estado fica velho
            if (this.pending.size && !this.stopped) { this.pollSoon(0); return; }
            this.scheduleNext();
        };
        for (const name of names) {
            const player = this.players.get(name);
            if (!player) { done(); continue; }
            execFile('busctl', ['--user', '-j', 'call', name, OBJ, 'org.freedesktop.DBus.Properties', 'GetAll', 's', IFACE_PLAYER], { ...EXEC_OPTS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
                if (err || !stdout) {
                    // Nome ainda registrado mas sem responder: trata como parado (some de vez no NameOwnerChanged)
                    if (player.status !== 'Stopped') { Object.assign(player, { status: 'Stopped' }); changed = true; }
                } else {
                    try {
                        if (this.applyProps(player, unwrap(JSON.parse(stdout)))) changed = true;
                    } catch (e) { /* resposta ilegível: mantém o estado anterior */ }
                }
                done();
            });
        }
    }

    /** Atualiza um player com as propriedades do MPRIS; devolve true se algo visível mudou. */
    applyProps(player, p) {
        const md = p.Metadata || {};
        const artists = Array.isArray(md['xesam:artist']) ? md['xesam:artist'] : (md['xesam:artist'] ? [md['xesam:artist']] : []);
        const artUrl = String(md['mpris:artUrl'] || '');
        const next = {
            status: String(p.PlaybackStatus || 'Stopped'),
            title: String(md['xesam:title'] || ''),
            artist: artists.filter(Boolean).join(', '),
            album: String(md['xesam:album'] || ''),
            artUrl,
            artId: artUrl ? crypto.createHash('md5').update(artUrl).digest('hex').slice(0, 16) : null,
            trackId: String(md['mpris:trackid'] || ''),
            url: String(md['xesam:url'] || ''),
            lengthMs: Math.round(Number(md['mpris:length'] || 0) / 1000),
            positionMs: Math.round(Number(p.Position || 0) / 1000),
            canGoNext: !!p.CanGoNext,
            canGoPrevious: !!p.CanGoPrevious,
            canSeek: !!p.CanSeek,
            canControl: p.CanControl !== false
        };
        if (next.status === 'Playing' && player.status !== 'Playing') {
            player.lastPlayingAt = Date.now();
            if (this.pinnedName && this.pinnedName !== player.name) this.pinnedName = null;
        }
        const changed = ['status', 'title', 'artist', 'album', 'artId', 'trackId', 'lengthMs', 'canGoNext', 'canGoPrevious', 'canSeek']
            .some(k => player[k] !== next[k]) || Math.abs((player.positionMs || 0) - next.positionMs) >= 1000;
        Object.assign(player, next);
        if (next.artUrl && !this.artCache.has(next.artId) && !((this.artFailed.get(next.artId) || 0) > Date.now() - 60000)) {
            this.fetchArt(next.artUrl, next.artId);
        }
        return changed;
    }

    /** Ativo = tocando mais recente; senão o que já era ativo; senão o último que tocou ou tem faixa. */
    chooseActive() {
        if (this.pinnedName && this.players.has(this.pinnedName)) { this.activeName = this.pinnedName; return; }
        const all = [...this.players.values()];
        const playing = all.filter(p => p.status === 'Playing').sort((a, b) => b.lastPlayingAt - a.lastPlayingAt);
        if (playing.length) { this.activeName = playing[0].name; return; }
        if (this.activeName && this.players.has(this.activeName)) return;
        const rest = all.filter(p => p.title).sort((a, b) => b.lastPlayingAt - a.lastPlayingAt);
        this.activeName = rest.length ? rest[0].name : (all[0] ? all[0].name : null);
    }

    get active() {
        return this.activeName ? this.players.get(this.activeName) || null : null;
    }

    /** Estado para as teclas, com a posição extrapolada desde a última amostra. */
    snapshot() {
        const a = this.active;
        const active = a ? { ...a } : null;
        if (active && active.status === 'Playing' && this.lastSampleAt) {
            active.positionMs = Math.min(active.lengthMs || Infinity, active.positionMs + (Date.now() - this.lastSampleAt));
        }
        return {
            count: this.players.size,
            players: [...this.players.values()].map(p => ({ name: p.name, identity: p.identity, status: p.status, title: p.title })),
            active
        };
    }

    // ------------------------------------------------------------------
    // Capas
    // ------------------------------------------------------------------

    fetchArt(url, id) {
        if (this.artPending.has(id)) return;
        this.artPending.add(id);
        const store = (buffer, mime) => {
            if (!buffer || !buffer.length) return;
            this.artCache.set(id, { buffer, mime: /^image\//.test(mime || '') ? mime : mimeOf(buffer) });
            while (this.artCache.size > ART_CACHE_MAX) this.artCache.delete(this.artCache.keys().next().value);
            if (this.active && this.active.artId === id) this.emit('change', this.snapshot());
        };
        const finish = () => { this.artPending.delete(id); if (!this.artCache.has(id)) this.artFailed.set(id, Date.now()); };
        if (url.startsWith('file://')) {
            // Caminho do host (ex.: /tmp/.org.chromium.Chromium.XXXX do navegador): o Flatpak tem outro /tmp
            let filePath;
            try { filePath = decodeURIComponent(new URL(url).pathname); } catch (e) { finish(); return; }
            execFile('cat', [filePath], { timeout: 4000, maxBuffer: ART_MAX_BYTES, encoding: 'buffer' }, (err, stdout) => {
                if (err) console.warn('[Media] Falha ao ler capa do host:', (err.message || '').split('\n')[0]);
                else store(stdout, null);
                finish();
            });
        } else if (url.startsWith('data:')) {
            const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
            if (m) store(m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8'), m[1] || null);
            finish();
        } else if (/^https?:\/\//.test(url)) {
            SpotifyMonitor.httpsGet(url, { maxBytes: ART_MAX_BYTES }).then(({ buffer, mime }) => store(buffer, mime))
                .catch((e) => console.warn('[Media] Falha ao baixar capa:', e.message))
                .finally(finish);
        } else {
            finish();
        }
    }

    artOf(id) {
        return this.artCache.get(id) || null;
    }

    // ------------------------------------------------------------------
    // Comandos (sempre no player ativo)
    // ------------------------------------------------------------------

    call(method, sig, ...args) {
        const player = this.active;
        if (!player) return Promise.resolve(false);
        return new Promise((resolve) => {
            // `--`: um argumento negativo (Seek para trás) não pode ser lido pelo busctl como opção
            const a = ['--user', 'call', '--', player.name, OBJ, IFACE_PLAYER, method];
            if (sig) a.push(sig, ...args.map(String));
            execFile('busctl', a, EXEC_OPTS, (err, stdout, stderr) => {
                if (err) {
                    console.warn(`[Media] ${method} em ${player.identity} falhou:`, (stderr || err.message || '').trim().split('\n')[0]);
                    return resolve(false);
                }
                this.pending.add(player.name);
                this.pollSoon(250);
                resolve(true);
            });
        });
    }

    playPause() { return this.call('PlayPause'); }
    next() { return this.call('Next'); }
    previous() { return this.call('Previous'); }
    /** Avança/retrocede em segundos (negativo volta). */
    seek(deltaSec) { return this.call('Seek', 'x', Math.round(deltaSec * 1e6)); }

    /** Traz a janela do player ativo para frente (o navegador foca a aba do vídeo). */
    raise() {
        const player = this.active;
        if (!player) return Promise.resolve(false);
        return new Promise((resolve) => {
            execFile('busctl', ['--user', 'call', player.name, OBJ, IFACE_ROOT, 'Raise'], EXEC_OPTS, (err) => resolve(!err));
        });
    }

    /** Passa o controle para o próximo player da lista (quando há mais de um). */
    switchActive() {
        const names = [...this.players.keys()];
        if (names.length < 2) return false;
        const i = names.indexOf(this.activeName);
        this.activeName = names[(i + 1) % names.length];
        this.pinnedName = this.activeName;   // chooseActive() respeita até outro player começar a tocar
        this.emit('change', this.snapshot());
        return true;
    }

    logError(msg) {
        if (this.lastError === msg) return;
        this.lastError = msg;
        console.warn('[Media]', msg);
    }
}

module.exports = MediaPlayers;
