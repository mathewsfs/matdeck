/**
 * Spotify via MPRIS (D-Bus de sessão), lido pelo host com busctl.
 *
 * O cliente desktop (nativo ou flatpak com.spotify.Client) expõe org.mpris.MediaPlayer2.spotify com
 * faixa atual (título, artista, álbum, capa, duração), posição, estado, shuffle e repetição, e aceita
 * Play/Pause/Next/Previous/Seek, Shuffle, LoopStatus e OpenUri (playlists, álbuns, faixas). Não há
 * fila de reprodução no MPRIS (HasTrackList=false): "próximas músicas" exigiria a Web API do Spotify.
 *
 * A capa é baixada aqui e servida ao tablet por /api/spotify/art/<id> (o tablet não precisa de internet).
 */
const EventEmitter = require('events');
const https = require('https');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('./hostExec');

const BUS = 'org.mpris.MediaPlayer2.spotify';
const OBJ = '/org/mpris/MediaPlayer2';
const IFACE_PLAYER = 'org.mpris.MediaPlayer2.Player';
const IFACE_ROOT = 'org.mpris.MediaPlayer2';

const POLL_RUNNING_MS = 1000;
const POLL_IDLE_MS = 3000;          // sem o monitor D-Bus
const POLL_IDLE_WATCHED_MS = 60000; // com o monitor: só uma conferência de segurança por minuto
const ART_CACHE_MAX = 24;
const EXEC_OPTS = { env: { ...process.env, LC_ALL: 'C' }, timeout: 2500 };

const EMPTY_STATE = Object.freeze({
    running: false,
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
    shuffle: false,
    loop: 'None',            // None | Playlist | Track
    volume: 0
});

/** Desembrulha o JSON do `busctl -j` ({type, data}) em valores simples. */
function unwrap(node) {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map(unwrap);
    if (typeof node === 'object') {
        if ('type' in node && 'data' in node) {
            const t = node.type;
            if (t === 'a{sv}' && Array.isArray(node.data)) return unwrap(node.data[0] || {});
            return unwrap(node.data);
        }
        const out = {};
        for (const k of Object.keys(node)) out[k] = unwrap(node[k]);
        return out;
    }
    return node;
}

/** Normaliza link/URI do Spotify para `spotify:<tipo>:<id>`; null se não reconhecer. */
function normalizeUri(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    let m = /^spotify:(playlist|album|artist|track|show|episode|user:[^:]+:playlist):([A-Za-z0-9]+)$/.exec(s);
    if (m) return `spotify:${m[1]}:${m[2]}`;
    m = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:user\/[^/]+\/)?(playlist|album|artist|track|show|episode)\/([A-Za-z0-9]+)/i.exec(s);
    if (m) return `spotify:${m[1].toLowerCase()}:${m[2]}`;
    return null;
}

function uriToUrl(uri) {
    const m = /^spotify:([a-z]+):([A-Za-z0-9]+)$/.exec(uri || '');
    return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : null;
}

function httpsGet(url, { maxBytes = 3 * 1024 * 1024, timeout = 8000, redirects = 3 } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout, headers: { 'User-Agent': 'MatDeck/1.0' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
                res.resume();
                return resolve(httpsGet(new URL(res.headers.location, url).toString(), { maxBytes, timeout, redirects: redirects - 1 }));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            const chunks = []; let size = 0;
            res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error('resposta grande demais')); return; } chunks.push(c); });
            res.on('end', () => resolve({ buffer: Buffer.concat(chunks), mime: (res.headers['content-type'] || '').split(';')[0] || 'application/octet-stream' }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

class SpotifyMonitor extends EventEmitter {
    constructor() {
        super();
        this.state = { ...EMPTY_STATE };
        this.timer = null;
        this.polling = false;
        this.artCache = new Map();     // artId -> { url, buffer, mime }
        this.artPending = new Set();
        this.lastSampleAt = 0;
        this.watcher = null;      // busctl monitor: avisa quando o Spotify entra/sai do barramento
        this.stopped = false;
    }

    start() {
        if (this.timer) return;
        this.stopped = false;
        this.startWatcher();
        this.schedule(0);
        console.log(`[Spotify] Monitor MPRIS iniciado${this.watcher ? ' (presença por evento D-Bus; poll só com o Spotify aberto)' : ''}`);
    }

    stop() {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.watcher) {
            const child = this.watcher;
            this.watcher = null;
            try { child.kill(); } catch (e) { /* já saiu */ }
        }
    }

    /**
     * Com o Spotify fechado não há o que sondar: um `busctl monitor` persistente recebe o
     * NameOwnerChanged do nome MPRIS e acorda o poll quando o app abre (ou some).
     */
    startWatcher() {
        if (this.watcher) return;
        let child;
        try {
            child = spawn('busctl', ['--user', 'monitor', '--json=short', '--match',
                `type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${BUS}'`], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            console.warn('[Spotify] busctl monitor não iniciou; sondando a cada 3 s:', e.message);
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
                if (!line.startsWith('{')) continue;
                try {
                    const msg = JSON.parse(line);
                    const data = msg.payload && msg.payload.data;
                    if (msg.member === 'NameOwnerChanged' && Array.isArray(data)) this.pollSoon(data[2] ? 800 : 0);
                } catch (e) { /* linha parcial */ }
            }
        });
        child.stderr.on('data', () => {});
        const gone = (why) => {
            if (this.watcher !== child) return;
            this.watcher = null;
            if (!this.stopped) {
                console.warn(`[Spotify] Monitor D-Bus ${why}; voltando a sondar a cada ${POLL_IDLE_MS / 1000} s`);
                this.pollSoon(0);
            }
        };
        child.on('error', (e) => gone(`falhou (${e.message})`));
        child.on('exit', (code, signal) => gone(`terminou (code=${code}, signal=${signal})`));
    }

    schedule(ms) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.poll(), ms);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    poll() {
        if (this.polling) return;
        this.polling = true;
        execFile('busctl', ['--user', '-j', 'call', BUS, OBJ, 'org.freedesktop.DBus.Properties', 'GetAll', 's', IFACE_PLAYER], { ...EXEC_OPTS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
            this.polling = false;
            let next;
            if (err || !stdout) {
                next = { ...EMPTY_STATE };
            } else {
                try {
                    next = this.parse(unwrap(JSON.parse(stdout)));
                } catch (e) {
                    next = { ...EMPTY_STATE };
                }
            }
            this.apply(next);
            if (this.stopped) return;
            this.schedule(this.state.running ? POLL_RUNNING_MS : (this.watcher ? POLL_IDLE_WATCHED_MS : POLL_IDLE_MS));
        });
    }

    parse(p) {
        const md = p.Metadata || {};
        const artUrl = String(md['mpris:artUrl'] || '').replace(/^https:\/\/open\.spotify\.com\/image\//, 'https://i.scdn.co/image/');
        const artists = Array.isArray(md['xesam:artist']) ? md['xesam:artist'] : (md['xesam:artist'] ? [md['xesam:artist']] : []);
        return {
            running: true,
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
            shuffle: !!p.Shuffle,
            loop: String(p.LoopStatus || 'None'),
            volume: Number(p.Volume || 0)
        };
    }

    apply(next) {
        const prev = this.state;
        this.state = next;
        this.lastSampleAt = Date.now();
        if (next.artUrl && !this.artCache.has(next.artId)) this.fetchArt(next.artUrl, next.artId);
        const changed = ['running', 'status', 'title', 'artist', 'album', 'artId', 'trackId', 'lengthMs', 'shuffle', 'loop']
            .some(k => prev[k] !== next[k]) || Math.abs((prev.positionMs || 0) - (next.positionMs || 0)) >= 500;
        if (changed) this.emit('change', this.snapshot());
    }

    /** Estado com a posição extrapolada desde a última amostra (quando tocando). */
    snapshot() {
        const s = { ...this.state };
        if (s.running && s.status === 'Playing' && this.lastSampleAt) {
            s.positionMs = Math.min(s.lengthMs || Infinity, s.positionMs + (Date.now() - this.lastSampleAt));
        }
        return s;
    }

    fetchArt(url, id) {
        if (this.artPending.has(id)) return;
        this.artPending.add(id);
        httpsGet(url).then(({ buffer, mime }) => {
            this.artCache.set(id, { url, buffer, mime: /^image\//.test(mime) ? mime : 'image/jpeg' });
            while (this.artCache.size > ART_CACHE_MAX) this.artCache.delete(this.artCache.keys().next().value);
            if (this.state.artId === id) this.emit('change', this.snapshot());
        }).catch((e) => {
            console.warn('[Spotify] Falha ao baixar capa:', e.message);
        }).finally(() => this.artPending.delete(id));
    }

    artOf(id) {
        return this.artCache.get(id) || null;
    }

    // ------------------------------------------------------------------
    // Comandos
    // ------------------------------------------------------------------

    call(method, sig, ...args) {
        return new Promise((resolve) => {
            const a = ['--user', 'call', BUS, OBJ, IFACE_PLAYER, method];
            if (sig) a.push(sig, ...args.map(String));
            execFile('busctl', a, EXEC_OPTS, (err, stdout, stderr) => {
                if (err) {
                    console.warn(`[Spotify] ${method} falhou:`, (stderr || err.message || '').trim().split('\n')[0]);
                    return resolve(false);
                }
                resolve(true);
            });
        });
    }

    setProp(prop, sig, value) {
        return new Promise((resolve) => {
            execFile('busctl', ['--user', 'set-property', BUS, OBJ, IFACE_PLAYER, prop, sig, String(value)], EXEC_OPTS, (err, stdout, stderr) => {
                if (err) {
                    console.warn(`[Spotify] set ${prop} falhou:`, (stderr || err.message || '').trim().split('\n')[0]);
                    return resolve(false);
                }
                resolve(true);
            });
        });
    }

    async playPause() { const ok = await this.call('PlayPause'); this.pollSoon(); return ok; }
    async next() { const ok = await this.call('Next'); this.pollSoon(); return ok; }
    async previous() { const ok = await this.call('Previous'); this.pollSoon(); return ok; }

    /** Avança/retrocede em segundos (negativo volta). */
    async seek(deltaSec) {
        const ok = await this.call('Seek', 'x', Math.round(deltaSec * 1e6));
        this.pollSoon();
        return ok;
    }

    async setShuffle(on) { const ok = await this.setProp('Shuffle', 'b', on ? 'true' : 'false'); this.pollSoon(); return ok; }
    async setLoop(status) { const ok = await this.setProp('LoopStatus', 's', status); this.pollSoon(); return ok; }

    /** Alterna repetição: None -> Playlist -> Track -> None */
    async cycleLoop() {
        const order = ['None', 'Playlist', 'Track'];
        const i = order.indexOf(this.state.loop);
        return this.setLoop(order[(i + 1) % order.length]);
    }

    /** Toca uma playlist/álbum/faixa pelo URI (abre o Spotify se preciso). */
    async openUri(input) {
        const uri = normalizeUri(input);
        if (!uri) { console.warn('[Spotify] URI inválido:', input); return false; }
        if (!this.state.running) {
            // Spotify fechado: `xdg-open spotify:...` abre o cliente já na playlist
            exec(`xdg-open ${JSON.stringify(uri)} >/dev/null 2>&1 &`, EXEC_OPTS, () => {});
            this.pollSoon(2500);
            return true;
        }
        const ok = await this.call('OpenUri', 's', uri);
        this.pollSoon();
        return ok;
    }

    /** Traz a janela do Spotify para frente (ou abre o app). */
    raise() {
        return new Promise((resolve) => {
            if (!this.state.running) {
                exec('(gtk-launch spotify || gtk-launch com.spotify.Client || flatpak run com.spotify.Client || spotify) >/dev/null 2>&1 &', EXEC_OPTS, () => resolve(true));
                this.pollSoon(3000);
                return;
            }
            execFile('busctl', ['--user', 'call', BUS, OBJ, IFACE_ROOT, 'Raise'], EXEC_OPTS, (err) => resolve(!err));
        });
    }

    pollSoon(ms = 250) {
        this.schedule(ms);
    }

    // ------------------------------------------------------------------
    // Resolver links (oEmbed público, sem credenciais): título + capa
    // ------------------------------------------------------------------

    async resolve(input) {
        const uri = normalizeUri(input);
        if (!uri) return null;
        const url = uriToUrl(uri);
        const out = { uri, url, type: uri.split(':')[1], title: '', thumbnail: null };
        try {
            const { buffer } = await httpsGet(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { maxBytes: 256 * 1024 });
            const info = JSON.parse(buffer.toString('utf8'));
            out.title = String(info.title || '');
            if (info.thumbnail_url) {
                const img = await httpsGet(info.thumbnail_url);
                out.thumbnail = `data:${/^image\//.test(img.mime) ? img.mime : 'image/jpeg'};base64,${img.buffer.toString('base64')}`;
            }
        } catch (e) {
            console.warn('[Spotify] oEmbed falhou:', e.message);
        }
        return out;
    }
}

SpotifyMonitor.normalizeUri = normalizeUri;

module.exports = SpotifyMonitor;
