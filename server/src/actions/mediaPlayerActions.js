const icons = require('../icons.json');

const ACCENT = '#60A5FA';
const ACCENT_DARK = '#1D4ED8';
const SEEK_STEP_SEC = 10;

function fmtTime(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const mm = h ? String(m % 60).padStart(2, '0') : String(m);
    return `${h ? h + ':' : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Ações `player:*`: controlam o player de mídia ativo do sistema (src/mediaPlayers.js), como o popup
 * de mídia do navegador. Não há perfil próprio; as teclas entram em qualquer layout pelo gerenciador.
 */
class MediaPlayerActions {
    constructor(serverContext) {
        this.ctx = serverContext;
    }

    get monitor() {
        return this.ctx.mediaPlayers;
    }

    /** App do mixer de áudio que corresponde ao player (mudo via sink-input); null se não há correspondência. */
    audioAppFor(player) {
        const id = String((player && player.identity) || '').toLowerCase();
        if (/brave|chrom|firefox|edge|vivaldi|opera|librewolf/.test(id)) return 'browser';
        if (/spotify/.test(id)) return 'spotify';
        if (/obs/.test(id)) return 'obs';
        return null;    // VLC, mpv...: mutar o master silenciaria o PC inteiro
    }

    audioStateFor(player) {
        const appId = this.audioAppFor(player);
        const mixer = this.ctx.audioMixer;
        const app = appId && mixer && typeof mixer.appState === 'function' ? mixer.appState(appId) : null;
        return app || { muted: false, available: !!app };
    }

    /** Campos do bloco "tocando agora" (também a base do painel completo). */
    nowPlayingState(snap) {
        const a = snap.active;
        const playing = !!a && a.status === 'Playing';
        const has = !!a && !!a.title;
        const who = a ? a.identity : '';
        // Arredondado: a posição é extrapolada, e um percentual "vivo" faria toda chamada parecer uma mudança
        const pct = has && a.lengthMs ? Math.round(Math.max(0, Math.min(100, (a.positionMs / a.lengthMs) * 100)) * 10) / 10 : 0;
        return {
            statMode: 'media',
            statLabel: who || 'Mídia',
            statHead: !a ? '' : (playing ? '' : (has ? 'pausado' : '')),
            statBig: has ? a.title : (a ? 'Nada tocando' : 'Nenhum player'),
            statSub: has ? (a.artist || who) : (a ? who : 'abra um vídeo ou música'),
            statImage: has && a.artId && this.monitor.artOf(a.artId) ? `/api/media/art/${a.artId}` : null,
            statPercent: pct,
            statTime: has ? fmtTime(a.positionMs) : '',
            statTotal: has && a.lengthMs ? fmtTime(a.lengthMs) : '',
            statColor: ACCENT,
            title: has ? `${a.title}${a.artist ? ' — ' + a.artist : ''}` : 'Mídia',
            active: playing
        };
    }

    /** Estado visual de uma ação `player:*` para o momento atual (mesclado sobre a tecla). */
    stateFor(actionId) {
        if (!actionId || !actionId.startsWith('player:')) return null;
        const snap = this.monitor ? this.monitor.snapshot() : { count: 0, players: [], active: null };
        const a = snap.active;
        const playing = !!a && a.status === 'Playing';
        const has = !!a && !!a.title;
        const who = a ? a.identity : '';
        switch (actionId) {
            case 'player:now_playing':
                return this.nowPlayingState(snap);
            case 'player:panel': {
                // Conteúdo + botões dentro do bloco: −10 s, play/pause, +10 s e mudo (como o popup do navegador)
                const muted = !!this.audioStateFor(a).muted;
                return {
                    ...this.nowPlayingState(snap),
                    panel: true,
                    panelPlaying: playing,
                    panelMuted: muted,
                    panelIcons: { seek_back: icons.seek_back, play: icons.play, pause: icons.pause, seek_fwd: icons.seek_fwd, mute: icons.volume_mute, unmute: icons.volume },
                    statHead: muted ? 'mudo' : (!a ? '' : (playing ? '' : (has ? 'pausado' : '')))
                };
            }
            case 'player:mute': {
                const audio = this.audioStateFor(a);
                const muted = !!audio.muted;
                return {
                    icon: muted ? icons.volume_mute : icons.volume,
                    badge: !a ? 'OFF' : (audio.available === false ? 'n/d' : (muted ? 'MUDO' : null)),
                    badgeColor: muted ? '#7F1D1D' : '#4B5563',
                    bgColor: muted ? '#DC2626' : undefined,
                    borderColor: muted ? '#F87171' : undefined,
                    active: muted
                };
            }
            case 'player:transport':
                return {
                    transport: true,
                    transportPlaying: playing,
                    transportIcons: { prev: icons.prev, play: icons.play, pause: icons.pause, next: icons.next },
                    active: playing,
                    borderColor: playing ? ACCENT : undefined
                };
            case 'player:play_pause':
                return {
                    title: playing ? 'Pausar' : 'Tocar',
                    icon: playing ? icons.pause : icons.play,
                    badge: a ? null : 'OFF',
                    badgeColor: '#4B5563',
                    active: playing,
                    borderColor: playing ? ACCENT : undefined
                };
            case 'player:next':
                return { badge: a && !a.canGoNext ? 'n/d' : null, badgeColor: '#4B5563' };
            case 'player:prev':
                return { badge: a && !a.canGoPrevious ? 'n/d' : null, badgeColor: '#4B5563' };
            case 'player:seek_fwd':
            case 'player:seek_back':
                return { badge: a && !a.canSeek ? 'n/d' : null, badgeColor: '#4B5563' };
            case 'player:switch':
                return {
                    title: who || 'Player',
                    badge: snap.count > 1 && a ? `${snap.players.findIndex(p => p.name === a.name) + 1}/${snap.count}` : (snap.count ? null : 'OFF'),
                    badgeColor: snap.count > 1 ? ACCENT_DARK : '#4B5563',
                    active: snap.count > 1
                };
            case 'player:raise':
                return { badge: a ? null : 'OFF', badgeColor: '#4B5563' };
            default:
                return null;
        }
    }

    handleAction(actionId, eventType) {
        if (eventType !== 'keyDown') return;
        const m = this.monitor;
        if (!m) return;
        if (!m.active && actionId !== 'player:switch') {
            this.ctx.notify({ title: 'Mídia', text: 'Nenhum player de mídia aberto. Dê play num vídeo ou música no PC.', level: 'warn' });
            return;
        }
        switch (actionId) {
            case 'player:transport':
            case 'player:panel':
                return; // os botões internos disparam player:prev/play_pause/next/seek_*/mute
            case 'player:now_playing':
            case 'player:play_pause':
                return m.playPause();
            case 'player:mute': {
                // Mudo do app no mixer (sink-input): o MPRIS do navegador não expõe mudo
                const appId = this.audioAppFor(m.active);
                if (!appId) { this.ctx.notify({ title: 'Mídia', text: `Mudo não disponível para ${m.active.identity}: use o fader "Master PC".`, level: 'warn' }); return; }
                if (this.ctx.audioMixer) this.ctx.audioMixer.toggleMute(appId);
                return;
            }
            case 'player:next':
                return m.next();
            case 'player:prev':
                return m.previous();
            case 'player:seek_fwd':
                return m.seek(SEEK_STEP_SEC);
            case 'player:seek_back':
                return m.seek(-SEEK_STEP_SEC);
            case 'player:switch':
                if (!m.switchActive()) this.ctx.notify({ title: 'Mídia', text: 'Só há um player aberto.', level: 'poke' });
                return;
            case 'player:raise':
                return m.raise();
            default:
                console.log(`[Media] Ação desconhecida: ${actionId}`);
        }
    }
}

module.exports = MediaPlayerActions;
