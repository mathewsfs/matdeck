const icons = require('../icons.json');
const SpotifyMonitor = require('../spotify');

const GREEN = '#1DB954';
const GREEN_DARK = '#14833B';
const SEEK_STEP_SEC = 10;

function fmtTime(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const mm = h ? String(m % 60).padStart(2, '0') : String(m);
    return `${h ? h + ':' : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Perfil Spotify: controla o cliente desktop via MPRIS (src/spotify.js).
 * As teclas refletem o estado real (faixa, play/pause, shuffle, repetição); o fader de volume
 * é o do mixer por app (vol_slider:spotify). Playlists: ação `spotify:play:<uri>`.
 */
class SpotifyProfile {
    constructor(serverContext) {
        this.ctx = serverContext;
    }

    get monitor() {
        return this.ctx.spotify;
    }

    get snapshot() {
        return this.monitor ? this.monitor.snapshot() : { running: false, status: 'Stopped' };
    }

    getDefinition() {
        const keys = [
            // Bloco 2x2 "tocando agora" (índices 0,1,5,6)
            { index: 0, title: 'Tocando agora', icon: icons.spotify, actionId: 'spotify:now_playing', colSpan: 2, rowSpan: 2 },
            // Controles num bloco só (2 colunas: índices 2 e 3)
            { index: 2, title: 'Spotify', icon: icons.play, actionId: 'spotify:transport', colSpan: 2 },
            { index: 4, title: 'Tocar', icon: icons.play, actionId: 'spotify:play_pause' },

            { index: 7, title: 'Aleatório', icon: icons.shuffle, actionId: 'spotify:shuffle' },
            { index: 8, title: 'Repetir', icon: icons.repeat, actionId: 'spotify:repeat' },
            { index: 9, title: 'Vol. Spotify', icon: icons.spotify, actionId: 'vol_slider:spotify', isSlider: true, sliderValue: 60, sliderApp: 'spotify' },

            { index: 10, title: `−${SEEK_STEP_SEC} s`, icon: icons.seek_back, actionId: 'spotify:seek_back' },
            { index: 11, title: `+${SEEK_STEP_SEC} s`, icon: icons.seek_fwd, actionId: 'spotify:seek_fwd' },
            { index: 12, title: 'Abrir Spotify', icon: icons.spotify, actionId: 'spotify:open', borderColor: GREEN },
            { index: 13, title: 'Mudo PC', icon: icons.volume_mute, actionId: 'media:mute' },
            { index: 14, title: 'Principal', icon: icons.home, actionId: 'switch:default', borderColor: '#3B82F6' }
        ].map(k => ({ ...k, ...(this.stateFor(k.actionId) || {}) }));
        return { id: 'spotify', name: 'Spotify', rows: 3, cols: 5, keys };
    }

    /** Estado visual de uma ação `spotify:*` para o momento atual (mesclado sobre a tecla). */
    stateFor(actionId) {
        if (!actionId || !actionId.startsWith('spotify:')) return null;
        const s = this.snapshot;
        const playing = s.running && s.status === 'Playing';
        switch (actionId) {
            case 'spotify:now_playing': {
                const has = s.running && !!s.title;
                const pct = has && s.lengthMs ? Math.max(0, Math.min(100, (s.positionMs / s.lengthMs) * 100)) : 0;
                return {
                    statMode: 'media',
                    statLabel: 'Spotify',
                    statHead: !s.running ? 'fechado' : (playing ? '' : (has ? 'pausado' : '')),
                    statBig: has ? s.title : (s.running ? 'Nada tocando' : 'Spotify fechado'),
                    statSub: has ? s.artist : (s.running ? 'escolha uma playlist' : 'toque para abrir'),
                    statImage: has && s.artId && this.monitor.artOf(s.artId) ? `/api/spotify/art/${s.artId}` : null,
                    statPercent: pct,
                    statTime: has ? fmtTime(s.positionMs) : '',
                    statTotal: has && s.lengthMs ? fmtTime(s.lengthMs) : '',
                    statColor: GREEN,
                    title: has ? `${s.title} — ${s.artist}` : 'Spotify',
                    active: playing
                };
            }
            case 'spotify:transport':
            case 'spotify:mixer':
                return {
                    transport: true,
                    transportPlaying: playing,
                    transportIcons: { prev: icons.prev, play: icons.play, pause: icons.pause, next: icons.next },
                    active: playing,
                    borderColor: playing ? GREEN : undefined
                };
            case 'spotify:play_pause':
                return {
                    title: playing ? 'Pausar' : 'Tocar',
                    icon: playing ? icons.pause : icons.play,
                    active: playing,
                    borderColor: playing ? GREEN : undefined
                };
            case 'spotify:shuffle':
                return {
                    badge: s.shuffle ? 'ON' : 'OFF',
                    badgeColor: s.shuffle ? GREEN_DARK : '#4B5563',
                    active: !!s.shuffle,
                    borderColor: s.shuffle ? GREEN : undefined
                };
            case 'spotify:repeat': {
                const label = { None: 'OFF', Playlist: 'LISTA', Track: 'FAIXA' }[s.loop] || 'OFF';
                return {
                    icon: s.loop === 'Track' ? icons.repeat_one : icons.repeat,
                    badge: label,
                    badgeColor: s.loop !== 'None' ? GREEN_DARK : '#4B5563',
                    active: s.loop !== 'None',
                    borderColor: s.loop !== 'None' ? GREEN : undefined
                };
            }
            case 'spotify:open':
                return { badge: s.running ? null : 'OFF', badgeColor: '#4B5563' };
            default:
                return null;
        }
    }

    handleAction(actionId, eventType) {
        if (eventType !== 'keyDown') return;
        if (actionId.startsWith('media:') || actionId.startsWith('launch:') || actionId.startsWith('switch:')) {
            const def = this.ctx.profiles && this.ctx.profiles.get('default');
            if (def) def.handleAction(actionId, eventType);
            return;
        }
        const m = this.monitor;
        if (!m) return;

        if (actionId.startsWith('spotify:play:')) {
            const uri = actionId.slice('spotify:play:'.length);
            if (!SpotifyMonitor.normalizeUri(uri)) {
                this.ctx.notify({ title: 'Spotify', text: 'Cole o link da playlist no campo da tecla, no gerenciador.', level: 'warn' });
                return;
            }
            return m.openUri(uri);
        }

        switch (actionId) {
            case 'spotify:transport':
                // O bloco inteiro não tem ação própria: os botões internos disparam spotify:prev/play_pause/next
                return;
            case 'spotify:mixer':
                // Toque fora dos botões: muda/desmuta o Spotify, como no fader comum
                return this.ctx.audioMixer && this.ctx.audioMixer.toggleMute('spotify');
            case 'spotify:now_playing':
                return m.state.running ? m.playPause() : m.raise();
            case 'spotify:play_pause':
                if (!m.state.running) { this.ctx.notify({ title: 'Spotify', text: 'O Spotify não está aberto. Toque em "Abrir Spotify".', level: 'warn' }); return m.raise(); }
                return m.playPause();
            case 'spotify:next':
                return m.next();
            case 'spotify:prev':
                return m.previous();
            case 'spotify:shuffle':
                return m.setShuffle(!m.state.shuffle);
            case 'spotify:repeat':
                return m.cycleLoop();
            case 'spotify:seek_fwd':
                return m.seek(SEEK_STEP_SEC);
            case 'spotify:seek_back':
                return m.seek(-SEEK_STEP_SEC);
            case 'spotify:open':
                return m.raise();
            default:
                console.log(`[Spotify] Ação desconhecida: ${actionId}`);
        }
    }
}

module.exports = SpotifyProfile;
