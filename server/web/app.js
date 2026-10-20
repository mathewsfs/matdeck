'use strict';
const CLIENT_VERSION = '1.3.1'; // precisa bater com VERSION do servidor (src/index.js)
const CLIENT_BUILD = (document.querySelector('meta[name="matdeck-build"]') || {}).content || ''; // impressão digital dos assets, injetada pelo servidor

// Chrome 81 (tablet) ignora `gap` em flexbox: marca o <html> e o CSS usa margens no lugar (fim do style.css)
(function detectFlexGap() {
    try {
        const box = document.createElement('div');
        box.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
        box.appendChild(document.createElement('div'));
        box.appendChild(document.createElement('div'));
        document.documentElement.appendChild(box);
        const supported = box.scrollHeight === 1;
        document.documentElement.removeChild(box);
        if (!supported) document.documentElement.classList.add('no-flex-gap');
    } catch (e) { /* sem detecção, fica o gap */ }
})();

// ----------------------------------------------------
// ESTADO GLOBAL
// ----------------------------------------------------
let ws = null;
let wsReconnectTimer = null;
let currentProfile = 'default';
let currentProfileName = '';
let keysData = [];
let profileList = null;         // [{id,name}] visíveis no tablet (evento WS `profileList`)
let hasLoadedProfile = false;
let connectionState = 'connecting';
let serverAddress = '';

// Limpezas de arraste ativas (garante que nada fique em `window` após remover teclas)
const activeDragCleanups = new Set();

const VOLUME_THROTTLE_MS = 50;
const DRAG_THRESHOLD_PX = 6;
const SWIPE_MIN_X = 80;
const SWIPE_MAX_Y = 40;
const SWIPE_LABEL_MS = 900;

const THEME_KEY = 'matdeck.theme';
const FONT_KEY = 'matdeck.font';

// ----------------------------------------------------
// ELEMENTOS DO DOM
// ----------------------------------------------------
const $ = (id) => document.getElementById(id);

const gridWrap = $('deck-grid-wrap');
const gridEl = $('deck-grid');
const deckOverlay = $('deck-overlay');
const deckOverlayTitle = $('deck-overlay-title');
const deckOverlaySub = $('deck-overlay-sub');
const swipeLabel = $('swipe-label');
const hardwareHud = $('hardware-hud');

const connDot = $('conn-dot');
const sheetBackdrop = $('sheet');
const sheetClose = $('sheet-close');
const sheetTitle = $('sheet-title');
const sheetStatusDot = $('sheet-status-dot');
const sheetProfile = $('sheet-profile');
const sheetIp = $('sheet-ip');
const themeSeg = $('theme-seg');
const fontSeg = $('font-seg');
const btnFullscreen = $('btn-fullscreen');
const btnFullscreenLabel = $('btn-fullscreen-label');
const btnFullscreenCorner = $('btn-fullscreen-corner');

// HUD
const hudCpuVal = $('hud-cpu-val');
const hudCpuTemp = $('hud-cpu-temp');
const hudCpuBar = $('hud-cpu-bar');
const hudGpuVal = $('hud-gpu-val');
const hudGpuTemp = $('hud-gpu-temp');
const hudGpuBar = $('hud-gpu-bar');
const hudVramVal = $('hud-vram-val');
const hudVramPct = $('hud-vram-pct');
const hudVramBar = $('hud-vram-bar');
const hudRamVal = $('hud-ram-val');
const hudRamPct = $('hud-ram-pct');
const hudRamBar = $('hud-ram-bar');
const hudGpuCard = $('hud-gpu');
const hudVramCard = $('hud-vram');
const hudRamCard = $('hud-ram');

const toastContainer = $('toast-container');

// ----------------------------------------------------
// UTILITÁRIOS
// ----------------------------------------------------

/** fetch que nunca lança: devolve { ok, status, data } ou { ok:false, error }. */
async function apiFetch(url, options) {
    try {
        const res = await fetch(url, options);
        let data = null;
        const text = await res.text();
        if (text) {
            try { data = JSON.parse(text); } catch (e) { data = null; }
        }
        return { ok: res.ok, status: res.status, data };
    } catch (error) {
        return { ok: false, status: 0, data: null, error };
    }
}

function wsSend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
}

function fmtTemp(temp) {
    return (temp === null || temp === undefined || Number.isNaN(Number(temp))) ? '--°C' : `${Math.round(temp)}°C`;
}

function fmtPct(v) {
    return (v === null || v === undefined || Number.isNaN(Number(v))) ? '--%' : `${Math.round(v)}%`;
}

function fmtGb(v) {
    return (v === null || v === undefined || Number.isNaN(Number(v))) ? '-- GB' : `${Number(v).toFixed(1)} GB`;
}

function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}

function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

// ----------------------------------------------------
// TOASTS
// ----------------------------------------------------
/**
 * Toast/banner no topo. `type`: info | success | warning | error | poke.
 * `title` (opcional) vira a primeira linha; `onClose` é chamado uma única vez ao sumir.
 */
function toast(message, opts = {}) {
    const { type = 'info', duration = 4000, title = '', onClose = null } = opts;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', (type === 'error' || type === 'poke') ? 'alert' : 'status');

    const body = document.createElement('div');
    body.className = 'toast-body';
    if (title) {
        const titleEl = document.createElement('span');
        titleEl.className = 'toast-title';
        titleEl.textContent = title;
        body.appendChild(titleEl);
    }
    if (message) {
        const text = document.createElement('span');
        text.className = 'toast-text';
        text.textContent = message;
        body.appendChild(text);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Fechar aviso');
    close.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-close"/></svg>';

    el.appendChild(body);
    el.appendChild(close);
    toastContainer.appendChild(el);

    let timer = null;
    let closed = false;
    const dismiss = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        el.classList.add('toast-leaving');
        setTimeout(() => el.remove(), 180);
        if (typeof onClose === 'function') onClose();
    };
    close.addEventListener('click', dismiss);
    if (duration > 0) timer = setTimeout(dismiss, duration);

    // Mantém no máximo 4 toasts visíveis
    while (toastContainer.children.length > 4) toastContainer.firstElementChild.remove();
    return dismiss;
}

// ----------------------------------------------------
// NOTIFICAÇÕES DO SERVIDOR (evento WS `notify`)
// ----------------------------------------------------
const NOTIFY_TYPE_BY_LEVEL = { info: 'info', success: 'success', warn: 'warning', poke: 'poke' };
const NOTIFY_TTL_MIN = 1500;
const NOTIFY_TTL_MAX = 30000;
const notifyDismissers = new Map(); // id -> dismiss (um notify com o mesmo id substitui o anterior)

function showServerNotification(n) {
    const title = typeof n.title === 'string' ? n.title.trim() : '';
    const text = typeof n.text === 'string' ? n.text.trim() : '';
    if (!title && !text) return;

    const level = NOTIFY_TYPE_BY_LEVEL[n.level] ? n.level : 'info';
    const ttl = Number(n.ttlMs);
    const duration = clamp(Number.isFinite(ttl) && ttl > 0 ? ttl : 5000, NOTIFY_TTL_MIN, NOTIFY_TTL_MAX);
    const id = (typeof n.id === 'string' || typeof n.id === 'number') ? String(n.id) : null;

    if (id && notifyDismissers.has(id)) notifyDismissers.get(id)();

    const dismiss = toast(text || title, {
        type: NOTIFY_TYPE_BY_LEVEL[level],
        title: text ? title : '',
        duration,
        onClose: () => { if (id && notifyDismissers.get(id) === dismiss) notifyDismissers.delete(id); }
    });
    if (id) notifyDismissers.set(id, dismiss);

    if (level === 'poke') pokeAttention();
}

/** Vibração + beep curto; ambos opcionais e silenciosos se o navegador bloquear. */
function pokeAttention() {
    try {
        if (typeof navigator.vibrate === 'function') navigator.vibrate([120, 60, 120]);
    } catch (e) { /* ignore */ }
    playBeep();
}

let beepCtx = null;

function playBeep() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!beepCtx) beepCtx = new Ctx();
        if (beepCtx.state === 'suspended') {
            // Sem gesto do usuário o resume pode ficar pendente: nesse caso o beep simplesmente não toca.
            beepCtx.resume().catch(() => {});
        }
        const t = beepCtx.currentTime;
        const osc = beepCtx.createOscillator();
        const gain = beepCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.setValueAtTime(1175, t + 0.09);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        osc.connect(gain);
        gain.connect(beepCtx.destination);
        osc.start(t);
        osc.stop(t + 0.22);
    } catch (e) { /* ignore */ }
}

// ----------------------------------------------------
// WEBSOCKET
// ----------------------------------------------------
function setConnectionState(state) {
    // state: 'connecting' | 'connected' | 'offline'
    connectionState = state;
    document.body.classList.toggle('is-offline', state !== 'connected');
    renderConnectionUI();

    if (state === 'connected') {
        if (hasLoadedProfile) hideDeckOverlay();
        else showDeckOverlay('Carregando perfil...', 'Aguardando o servidor enviar as teclas.', true);
    } else if (state === 'connecting') {
        showDeckOverlay(hasLoadedProfile ? 'Reconectando...' : 'Conectando ao servidor...',
            hasLoadedProfile ? 'As teclas voltam a responder assim que a conexão for restabelecida.' : 'As teclas aparecem assim que o MatDeck responder.', true);
    } else {
        showDeckOverlay('Servidor indisponível', 'Verifique se o MatDeck está em execução neste PC. Tentando reconectar...', true);
    }
}

function showDeckOverlay(title, sub, busy) {
    deckOverlayTitle.textContent = title;
    deckOverlaySub.textContent = sub || '';
    setHidden(deckOverlay, false);
    gridEl.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function hideDeckOverlay() {
    setHidden(deckOverlay, true);
    gridEl.setAttribute('aria-busy', 'false');
}

function initWebSocket() {
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    const loc = window.location;
    const wsUrl = (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/deck';

    setConnectionState('connecting');

    try {
        ws = new WebSocket(wsUrl);
    } catch (e) {
        setConnectionState('offline');
        wsReconnectTimer = setTimeout(initWebSocket, 2500);
        return;
    }

    ws.onopen = () => {
        setConnectionState('connected');
        wsSend({
            event: 'clientHello',
            device: 'Web Client',
            version: CLIENT_VERSION,
            build: CLIENT_BUILD,
            width: window.innerWidth,
            height: window.innerHeight
        });
    };

    ws.onmessage = (event) => {
        try {
            handleServerMessage(JSON.parse(event.data));
        } catch (e) {
            console.error('Erro ao ler WebSocket:', e);
        }
    };

    ws.onclose = () => {
        setConnectionState('offline');
        cancelAllDrags();
        if (!wsReconnectTimer) wsReconnectTimer = setTimeout(initWebSocket, 2500);
    };

    ws.onerror = () => {
        try { ws.close(); } catch (e) { /* ignore */ }
    };
}

function handleServerMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.event) {
        case 'loadProfile': {
            currentProfile = msg.id;
            currentProfileName = msg.name || msg.id || '';
            keysData = Array.isArray(msg.keys) ? msg.keys : [];
            const rows = msg.rows || 3;
            const cols = msg.cols || 5;

            gridEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
            gridEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
            // HUD só quando o perfil pede explicitamente (embutidos não definem -> oculto)
            setHidden(hardwareHud, msg.showHardwareHud !== true);

            hasLoadedProfile = true;
            hideDeckOverlay();
            renderGrid(rows, cols);
            renderConnectionUI();
            break;
        }
        case 'updateKey': {
            // Sempre pelo campo index: perfis embutidos têm buracos (Spotify: 0, 2, 4, 7...), a posição no array não bate
            const idx = msg.keyIndex;
            if (msg.key && typeof idx === 'number') {
                const existing = keysData.find(k => k && k.index === idx);
                if (existing) { Object.assign(existing, msg.key); updateSingleKeyUI(idx); }
            }
            break;
        }
        case 'hardwareStats':
            updateHardwareHud(msg.stats);
            break;
        case 'reload':
            // Servidor atualizado: recarrega para pegar o app.js/style.css novos (uma vez por versão)
            if (msg.version && sessionStorage.getItem('matdeck-reloaded-for') !== msg.version) {
                try { sessionStorage.setItem('matdeck-reloaded-for', msg.version); } catch (e) { /* ignore */ }
                setTimeout(() => location.reload(), 300);
            }
            break;
        case 'notify':
            showServerNotification(msg);
            break;
        case 'profileList':
            if (Array.isArray(msg.profiles)) {
                profileList = msg.profiles.filter(p => p && p.id);
                if (msg.current) currentProfile = msg.current;
                const entry = profileList.find(p => p.id === currentProfile);
                if (entry && entry.name) currentProfileName = entry.name;
                renderConnectionUI();
            }
            break;
        default:
            break;
    }
}

// ----------------------------------------------------
// HUD DE HARDWARE
// ----------------------------------------------------
const TEMP_HOT = 75;

function setBar(bar, pct, isHot) {
    const v = (pct === null || pct === undefined || Number.isNaN(Number(pct))) ? 0 : clamp(Number(pct), 0, 100);
    bar.style.width = `${v}%`;
    bar.classList.toggle('is-hot', !!isHot);
}

function updateHardwareHud(stats) {
    if (!stats) return;

    if (stats.cpu) {
        const hot = typeof stats.cpu.temp === 'number' && stats.cpu.temp >= TEMP_HOT;
        hudCpuVal.textContent = fmtPct(stats.cpu.usage);
        hudCpuTemp.textContent = fmtTemp(stats.cpu.temp);
        hudCpuTemp.classList.toggle('is-hot', hot);
        hudCpuTemp.classList.toggle('is-unknown', stats.cpu.temp === null || stats.cpu.temp === undefined);
        setBar(hudCpuBar, stats.cpu.usage, hot);
    }

    if (stats.gpu) {
        const gpuAvailable = stats.gpu.available !== false;
        hudGpuCard.classList.toggle('is-unavailable', !gpuAvailable);
        hudVramCard.classList.toggle('is-unavailable', !gpuAvailable);
        hudGpuCard.title = gpuAvailable ? '' : 'Nenhuma GPU monitorada neste PC';
        hudVramCard.title = gpuAvailable ? '' : 'Nenhuma GPU monitorada neste PC';

        if (gpuAvailable) {
            const hot = typeof stats.gpu.temp === 'number' && stats.gpu.temp >= TEMP_HOT;
            hudGpuVal.textContent = fmtPct(stats.gpu.usage);
            hudGpuTemp.textContent = fmtTemp(stats.gpu.temp);
            hudGpuTemp.classList.toggle('is-hot', hot);
            hudGpuTemp.classList.toggle('is-unknown', stats.gpu.temp === null || stats.gpu.temp === undefined);
            setBar(hudGpuBar, stats.gpu.usage, hot);

            hudVramVal.textContent = fmtGb(stats.gpu.vramUsedGB);
            hudVramPct.textContent = fmtPct(stats.gpu.vramPercent);
            setBar(hudVramBar, stats.gpu.vramPercent);
        } else {
            hudGpuVal.textContent = '--%';
            hudGpuTemp.textContent = '--°C';
            hudGpuTemp.classList.remove('is-hot');
            setBar(hudGpuBar, 0);
            hudVramVal.textContent = '-- GB';
            hudVramPct.textContent = '--%';
            setBar(hudVramBar, 0);
        }
    }

    if (stats.ram) {
        hudRamVal.textContent = fmtGb(stats.ram.usedGB);
        hudRamPct.textContent = fmtPct(stats.ram.percent);
        setBar(hudRamBar, stats.ram.percent);
        if (typeof stats.ram.freeGB === 'number') {
            hudRamCard.title = `${stats.ram.freeGB.toFixed(1)} GB livres`;
        }
    }
}

// ----------------------------------------------------
// GRADE DE TECLAS
// ----------------------------------------------------
function cancelAllDrags() {
    for (const cleanup of [...activeDragCleanups]) cleanup();
    activeDragCleanups.clear();
}

let gridRows = 3;
let gridCols = 5;

/** Tamanho da tecla em células {cols, rows}, limitado à grade. `tall` (legado) = fader de 1x2. */
function spanOf(cfg, cols = gridCols, rows = gridRows) {
    if (!cfg) return { cols: 1, rows: 1 };
    let c = Math.max(1, parseInt(cfg.colSpan, 10) || 1);
    let r = Math.max(1, parseInt(cfg.rowSpan, 10) || (cfg.tall && isSliderKey(cfg) ? 2 : 1));
    const col = cfg.index % cols;
    const row = Math.floor(cfg.index / cols);
    c = Math.min(c, cols - col);
    r = Math.min(r, rows - row);
    return { cols: c, rows: r };
}

/** Fader alto e estreito: 1 coluna por 2+ linhas. */
function isTallKey(cfg) {
    if (!cfg || !isSliderKey(cfg)) return false;
    const sp = spanOf(cfg);
    return sp.rows > 1 && sp.cols === 1;
}

/** Células cobertas por teclas maiores (não são desenhadas). */
function coveredIndexes() {
    const covered = new Set();
    for (const k of keysData) {
        const sp = spanOf(k);
        if (sp.cols === 1 && sp.rows === 1) continue;
        const col = k.index % gridCols, row = Math.floor(k.index / gridCols);
        for (let r = 0; r < sp.rows; r++) for (let c = 0; c < sp.cols; c++) {
            if (r || c) covered.add((row + r) * gridCols + col + c);
        }
    }
    return covered;
}

function renderGrid(rows = 3, cols = 5) {
    cancelAllDrags();
    gridEl.innerHTML = '';
    gridRows = rows;
    gridCols = cols;
    const total = rows * cols;
    const covered = coveredIndexes();
    for (let i = 0; i < total; i++) {
        if (covered.has(i)) continue;
        const keyConfig = keysData.find(k => k.index === i) || { index: i, title: '' };
        const el = createKeyElement(keyConfig);
        // Posição explícita: teclas maiores ocupam várias células sem deslocar as demais
        const sp = spanOf(keyConfig);
        el.style.gridColumn = `${(i % cols) + 1} / span ${sp.cols}`;
        el.style.gridRow = `${Math.floor(i / cols) + 1} / span ${sp.rows}`;
        if (sp.cols > 1 || sp.rows > 1) el.classList.add('key-span');
        gridEl.appendChild(el);
    }
    requestAnimationFrame(fitAllIcons);
}

function renderSkeletonGrid(rows = 3, cols = 5) {
    gridEl.innerHTML = '';
    gridEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    gridEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    for (let i = 0; i < rows * cols; i++) {
        const el = document.createElement('div');
        el.className = 'deck-key deck-key-skeleton';
        el.setAttribute('aria-hidden', 'true');
        gridEl.appendChild(el);
    }
}

function isKeyMuted(cfg) {
    return cfg.bgColor === '#DC2626' ||
           cfg.badge === 'MUDO' ||
           cfg.badge === 'MUTADO' ||
           (cfg.title && cfg.title.toUpperCase().includes('MUTADO'));
}

function isSliderKey(cfg) {
    return !!(cfg.isSlider || (cfg.actionId && cfg.actionId.startsWith('vol_slider:')));
}

/** Cor escura (luminância < 0.5)? Usado para manter título/ícone legíveis sobre fundos personalizados no tema claro. */
function isDarkColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

function isStatKey(cfg) {
    return !!(cfg && ((cfg.actionId && (cfg.actionId.startsWith('stats:') || cfg.actionId.startsWith('ai:'))) || cfg.statValue !== undefined || cfg.statMode === 'media' || cfg.statMode === 'meters' || cfg.actionId === 'spotify:now_playing' || cfg.actionId === 'player:now_playing' || cfg.actionId === 'player:panel'));
}


/** Escapa texto para innerHTML. */
function escHtml(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Gráfico de área (histórico de 60 s) como SVG; `hist2` desenha uma segunda série. */
function statChartSvg(cfg, prefix) {
    const W = 100, H = 40, N = 60;
    const h1 = Array.isArray(cfg.statHistory) ? cfg.statHistory : [];
    const h2 = Array.isArray(cfg.statHistory2) ? cfg.statHistory2 : [];
    const max = cfg.statHistoryMax || Math.max(1, ...h1, ...h2);
    const min = cfg.statHistoryMin || 0;
    const span = Math.max(1, max - min);
    const line = (hist) => {
        const n = hist.length;
        if (!n) return null;
        const step = W / (N - 1);
        const x0 = W - (n - 1) * step;
        const pts = hist.map((v, i) => `${(x0 + i * step).toFixed(1)},${(H - Math.min(H, Math.max(0, (v - min) / span) * H)).toFixed(1)}`);
        return { pts: pts.join(' '), xStart: x0.toFixed(1) };
    };
    const c1 = cfg.statColor || '#3B82F6';
    const c2 = cfg.statColor2 || '#EC4899';
    let out = `<svg class="${prefix}-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
    const l1 = line(h1);
    if (l1) out += `<polygon points="${l1.xStart},${H} ${l1.pts} ${W},${H}" fill="${c1}" fill-opacity="0.28"/><polyline points="${l1.pts}" fill="none" stroke="${c1}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    const l2 = line(h2);
    if (l2) out += `<polyline points="${l2.pts}" fill="none" stroke="${c2}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    return out + '</svg>';
}

/** Barras por núcleo, coloridas pela carga. */
function statBarsSvg(cfg, prefix) {
    const bars = Array.isArray(cfg.statBars) ? cfg.statBars : [];
    const W = 100, H = 40;
    if (!bars.length) return '';
    const two = bars.length > 16;
    const rows = two ? 2 : 1;
    const perRow = Math.ceil(bars.length / rows);
    const rowH = H / rows;
    const slot = W / perRow;
    const bw = Math.max(0.8, slot * 0.68);
    let out = `<svg class="${prefix}-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
    bars.forEach((v, i) => {
        const r = Math.floor(i / perRow), c = i % perRow;
        const bh = Math.max(1, (Math.min(100, Math.max(0, v)) / 100) * (rowH - 3));
        const color = v >= 75 ? '#EF4444' : v >= 40 ? '#F59E0B' : (cfg.statColor || '#3B82F6');
        out += `<rect x="${(c * slot + (slot - bw) / 2).toFixed(2)}" y="${((r + 1) * rowH - 1 - bh).toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="0.6" fill="${color}"/>`;
        out += `<rect x="${(c * slot + (slot - bw) / 2).toFixed(2)}" y="${(r * rowH + 2).toFixed(2)}" width="${bw.toFixed(2)}" height="${(rowH - 3 - bh).toFixed(2)}" fill="currentColor" fill-opacity="0.12"/>`;
    });
    return out + '</svg>';
}

/** HTML do conteúdo de uma tecla de telemetria (estilo painel: cabeçalho, número grande, gráfico ou barra). */
function statInnerHtml(cfg, prefix) {
    const mode = cfg.statMode || (Array.isArray(cfg.statHistory) ? 'graph' : 'bar');
    const color = cfg.statColor || cfg.badgeColor || '';
    let html = `<div class="${prefix}-head"><span class="${prefix}-label">${escHtml(cfg.statLabel || cfg.title || '')}</span><span class="${prefix}-headval">${escHtml(cfg.statHead !== undefined ? cfg.statHead : (cfg.statSub || ''))}</span></div>`;
    if (mode === 'meters' && Array.isArray(cfg.statRows)) {
        html += `<div class="${prefix}-meters">` + cfg.statRows.map(r => `<div class="${prefix}-meter"><div class="${prefix}-meter-row"><span class="${prefix}-meter-k">${escHtml(r.k)}</span><span class="${prefix}-meter-sub">${escHtml(r.sub || '')}</span><span class="${prefix}-meter-v">${escHtml(r.v)}</span></div><div class="${prefix}-bar"><i style="width:${Math.max(0, Math.min(100, Number(r.pct) || 0))}%;background:${escHtml(r.color || color)}"></i></div></div>`).join('') + '</div>';
        return html;
    }
    if (mode === 'dual' && Array.isArray(cfg.statRows)) {
        html += `<div class="${prefix}-rows">` + cfg.statRows.map(r => `<div class="${prefix}-row"><span class="${prefix}-rowk" style="color:${escHtml(r.color || color)}">${escHtml(r.k)}</span><span class="${prefix}-rowv">${escHtml(r.v)}</span></div>`).join('') + '</div>';
    } else if (cfg.statBig !== undefined && cfg.statBig !== null) {
        html += `<div class="${prefix}-big">${escHtml(cfg.statBig)}</div>`;
    } else if (cfg.statValue !== undefined && mode !== 'cores') {
        html += `<div class="${prefix}-big">${escHtml(cfg.statValue)}</div>`;
    }
    if (cfg.statSub && mode !== 'dual') html += `<div class="${prefix}-sub" style="color:${escHtml(color)}">${escHtml(cfg.statSub)}</div>`;
    if (mode === 'graph' || mode === 'dual') html += `<div class="${prefix}-chart">${statChartSvg(cfg, prefix)}</div>`;
    else if (mode === 'cores') html += `<div class="${prefix}-chart ${prefix}-chart-tall">${statBarsSvg(cfg, prefix)}</div>`;
    else if (cfg.statPercent !== undefined && cfg.statPercent !== null) html += `<div class="${prefix}-bar"><i style="width:${Math.max(0, Math.min(100, Number(cfg.statPercent) || 0))}%;background:${escHtml(color)}"></i></div>`;
    return html;
}

function renderStatContent(el, cfg) {
    let box = el.querySelector('.key-stat');
    if (!box) {
        box = document.createElement('div');
        box.className = 'key-stat';
        el.appendChild(box);
    }
    const mode = cfg.statMode || 'bar';
    box.className = `key-stat mode-${mode}`;
    // Cor do texto escolhida no gerenciador (titleColor) vale para o bloco inteiro
    const customText = cfg.titleColor && !isKeyMuted(cfg);
    box.style.color = customText ? cfg.titleColor : '';
    if (customText) box.classList.add('has-text-color');
    if (mode === 'media') { renderMediaContent(box, cfg); return; }
    box.innerHTML = statInnerHtml(cfg, 'key-stat');
}

/**
 * Bloco "tocando agora" (Spotify): capa ao fundo, título/artista e barra de progresso.
 * Atualiza só o que mudou (chega 1x por segundo) para a capa não piscar.
 */
function renderMediaContent(box, cfg) {
    if (!box.querySelector('.key-stat-media-title')) {
        box.innerHTML = '<div class="key-stat-cover"></div><div class="key-stat-media-shade"></div>' +
            '<div class="key-stat-head"><span class="key-stat-label"></span><span class="key-stat-headval"></span></div>' +
            '<div class="key-stat-media-spacer"></div><div class="key-stat-media-title"></div><div class="key-stat-media-artist"></div>' +
            '<div class="key-stat-media-time"><span class="key-stat-media-pos"></span><span class="key-stat-media-len"></span></div>' +
            '<div class="key-stat-bar"><i></i></div>';
    }
    const setText = (sel, v) => { const n = box.querySelector(sel); const t = v === null || v === undefined ? '' : String(v); if (n && n.textContent !== t) n.textContent = t; };
    setText('.key-stat-label', cfg.statLabel || 'Spotify');
    setText('.key-stat-headval', cfg.statHead);
    setText('.key-stat-media-title', cfg.statBig);
    setText('.key-stat-media-artist', cfg.statSub);
    setText('.key-stat-media-pos', cfg.statTime);
    setText('.key-stat-media-len', cfg.statTotal);
    const cover = box.querySelector('.key-stat-cover');
    let img = cover.querySelector('img');
    if (cfg.statImage) {
        if (!img) { img = document.createElement('img'); img.alt = ''; img.draggable = false; cover.appendChild(img); }
        if (img.getAttribute('src') !== cfg.statImage) img.setAttribute('src', cfg.statImage);
        box.classList.add('has-cover');
    } else {
        if (img) img.remove();
        box.classList.remove('has-cover');
    }
    const bar = box.querySelector('.key-stat-bar i');
    bar.style.width = `${Math.max(0, Math.min(100, Number(cfg.statPercent) || 0))}%`;
    bar.style.background = cfg.statColor || '#1DB954';
    if (cfg.active) box.classList.add('is-playing'); else box.classList.remove('is-playing');
    syncMediaPanel(box, cfg);
}

/**
 * Botões do painel de mídia (player:panel) dentro do bloco: −10 s, play/pause, +10 s e mudo.
 * Cada botão envia a ação direto ao servidor (evento "action"); o toque na tecla em si não faz nada.
 */
function syncMediaPanel(box, cfg) {
    let bar = box.querySelector('.key-media-panel');
    if (!cfg.panel) { if (bar) bar.remove(); box.classList.remove('has-panel'); return; }
    box.classList.add('has-panel');
    const ic = cfg.panelIcons || box._panelIcons || {};
    if (cfg.panelIcons) box._panelIcons = cfg.panelIcons;
    const prefix = String(cfg.actionId || 'player:').split(':')[0];
    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'key-media-panel';
        const labels = { seek_back: 'Voltar 10 s', play_pause: 'Play / Pause', seek_fwd: 'Avançar 10 s', mute: 'Mudo' };
        for (const cmd of ['seek_back', 'play_pause', 'seek_fwd', 'mute']) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `key-media-btn key-media-${cmd}`;
            b.setAttribute('aria-label', labels[cmd]);
            const img = document.createElement('img');
            img.alt = '';
            img.draggable = false;
            b.appendChild(img);
            const stop = (e) => { e.stopPropagation(); };
            b.addEventListener('pointerdown', stop);
            b.addEventListener('pointerup', stop);
            b.addEventListener('touchstart', stop, { passive: true });
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                b.classList.add('is-pressed');
                setTimeout(() => b.classList.remove('is-pressed'), 180);
                wsSend({ event: 'action', actionId: `${prefix}:${cmd}` });
            });
            bar.appendChild(b);
        }
        box.appendChild(bar);
    }
    const setIcon = (cmd, src) => { const img = bar.querySelector(`.key-media-${cmd} img`); if (img && src && img.getAttribute('src') !== src) img.setAttribute('src', src); };
    setIcon('seek_back', ic.seek_back);
    setIcon('seek_fwd', ic.seek_fwd);
    setIcon('play_pause', cfg.panelPlaying ? ic.pause : ic.play);
    setIcon('mute', cfg.panelMuted ? ic.mute : ic.unmute);
    bar.classList.toggle('is-playing', !!cfg.panelPlaying);
    bar.classList.toggle('is-muted', !!cfg.panelMuted);
}

/**
 * Tamanho do ícone em px, calculado aqui (o navegador do tablet pode não suportar var()/cqmin no CSS).
 * Base: 36 px numa tecla comum; 22% do menor lado numa tecla grande; 40% da largura num fader estreito.
 */
function applyIconScale(el, cfg) {
    const scale = Number(cfg.iconScale) || 1;
    const img = el.querySelector('.key-icon');
    if (!img || cfg.imageFill || isStatKey(cfg)) return;
    const sp = spanOf(cfg);
    const tall = isTallKey(cfg);
    let base = 36;
    if (tall) {
        base = Math.min(40, el.clientWidth * 0.4 || 40);
    } else if (sp.cols > 1 || sp.rows > 1) {
        const m = Math.min(el.clientWidth, el.clientHeight);
        base = m ? Math.max(36, Math.min(160, m * 0.22)) : 36;
    }
    if (el.classList.contains('has-auto-btn')) base = tall ? 30 : 26;   // ícone dentro do botão AUTO
    const px = Math.round(base * scale);
    img.style.width = `${px}px`;
    img.style.height = `${px}px`;
    if (tall) img.style.maxWidth = `${px}px`;
}

/** Recalcula o tamanho dos ícones (depois do layout e ao redimensionar). */
function fitAllIcons() {
    for (const k of keysData) {
        const el = document.getElementById(`deck-key-${k.index}`);
        if (el) applyIconScale(el, k);
    }
}
window.addEventListener('resize', () => requestAnimationFrame(fitAllIcons));

function sliderAppOf(cfg) {
    return cfg.sliderApp || (cfg.actionId ? cfg.actionId.replace('vol_slider:', '') : 'master');
}

function createKeyElement(cfg) {
    const el = document.createElement('div');
    const muted = isKeyMuted(cfg);
    const isSlider = isSliderKey(cfg);
    const hasAction = !!(cfg.actionId || cfg.title || isSlider);

    el.className = 'deck-key' + (cfg.active ? ' active-toggle' : '') + (muted ? ' key-muted' : '') + (isSlider ? ' key-slider' : '') + (hasAction ? '' : ' key-empty') +
        (isTallKey(cfg) ? ' key-tall' : '') + (cfg.imageFill && cfg.icon ? ' key-image-fill' : '') + (isStatKey(cfg) ? ' key-stat-tile' : '') + (cfg.bgColor && !muted && isDarkColor(cfg.bgColor) ? ' has-dark-bg' : '');
    el.id = `deck-key-${cfg.index}`;
    el.setAttribute('role', isSlider ? 'slider' : 'button');
    el.tabIndex = 0;
    el.dataset.index = String(cfg.index);
    applyKeyAccessibleName(el, cfg);

    if (cfg.borderColor && !muted) el.style.borderColor = cfg.borderColor;
    if (cfg.bgColor && !muted) el.style.backgroundColor = cfg.bgColor;

    if (isSlider) {
        const fill = document.createElement('div');
        fill.className = 'key-slider-fill';
        const val = cfg.sliderValue !== undefined ? cfg.sliderValue : 80;
        fill.style.height = `${val}%`;
        if (isTallKey(cfg)) {
            // Fader alto: trilho estreito centralizado, com o preenchimento dentro dele
            const track = document.createElement('div');
            track.className = 'key-slider-track';
            track.appendChild(fill);
            el.appendChild(track);
        } else {
            el.appendChild(fill);
        }
        el.setAttribute('aria-valuemin', '0');
        el.setAttribute('aria-valuemax', '100');
        el.setAttribute('aria-valuenow', String(val));
        el.setAttribute('aria-orientation', 'vertical');
    }

    if (isStatKey(cfg)) {
        renderStatContent(el, cfg);
        attachKeyInteraction(el, cfg);
        return el;
    }

    if (cfg.badge) {
        const badge = document.createElement('span');
        badge.className = 'key-badge';
        badge.textContent = cfg.badge;
        if (cfg.badgeColor && !muted) badge.style.backgroundColor = cfg.badgeColor;
        el.appendChild(badge);
    }

    if (cfg.icon) {
        const img = document.createElement('img');
        img.className = 'key-icon';
        img.src = cfg.icon;
        img.alt = '';
        img.draggable = false;
        el.appendChild(img);
    }

    const title = document.createElement('span');
    title.className = 'key-title';
    title.textContent = cfg.title || '';
    if (cfg.titleColor && !muted) title.style.color = cfg.titleColor;
    el.appendChild(title);

    syncAutoButton(el, cfg);
    syncTransport(el, cfg);
    applyIconScale(el, cfg);
    attachKeyInteraction(el, cfg);
    return el;
}

/**
 * Bloco de controles do Spotify: três botões (anterior, play/pause, próxima) dentro de uma tecla.
 * Cada botão envia a ação direto ao servidor (evento "action"), sem passar pelo toque da tecla.
 */
function syncTransport(el, cfg) {
    const wants = !!cfg.transport || cfg.actionId === 'spotify:transport' || cfg.actionId === 'player:transport';
    let bar = el.querySelector('.key-transport-bar');
    // Prefixo da ação dos botões: spotify:* ou player:* (mídia do sistema)
    if (cfg.actionId) el.dataset.transportPrefix = String(cfg.actionId).split(':')[0];
    el.classList.toggle('key-transport', wants);
    if (!wants) { if (bar) bar.remove(); return; }
    const ic = cfg.transportIcons || el._transportIcons || {};
    if (cfg.transportIcons) el._transportIcons = cfg.transportIcons;
    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'key-transport-bar';
        for (const cmd of ['prev', 'play_pause', 'next']) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `key-transport-btn key-transport-${cmd}`;
            b.dataset.cmd = cmd;
            b.setAttribute('aria-label', { prev: 'Faixa anterior', play_pause: 'Play / Pause', next: 'Próxima faixa' }[cmd]);
            const img = document.createElement('img');
            img.alt = '';
            img.draggable = false;
            b.appendChild(img);
            const stop = (e) => { e.stopPropagation(); };
            b.addEventListener('pointerdown', stop);
            b.addEventListener('pointerup', stop);
            b.addEventListener('touchstart', stop, { passive: true });
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                b.classList.add('is-pressed');
                setTimeout(() => b.classList.remove('is-pressed'), 180);
                wsSend({ event: 'action', actionId: `${el.dataset.transportPrefix || 'spotify'}:${cmd}` });
            });
            bar.appendChild(b);
        }
        const title = el.querySelector('.key-title');
        el.insertBefore(bar, title || null);
    }
    const setIcon = (cmd, src) => { const img = bar.querySelector(`.key-transport-${cmd} img`); if (img && src && img.getAttribute('src') !== src) img.setAttribute('src', src); };
    setIcon('prev', ic.prev);
    setIcon('next', ic.next);
    setIcon('play_pause', cfg.transportPlaying ? ic.pause : ic.play);
    el.classList.toggle('is-playing', !!cfg.transportPlaying);
}

/**
 * Fader de ventoinhas: botão AUTO próprio (liga/desliga o controle automático do CoolerControl),
 * separado do arraste. O toque nele não vira keyDown nem arraste da tecla.
 */
function syncAutoButton(el, cfg) {
    const wants = isSliderKey(cfg) && sliderAppOf(cfg) === 'fans';
    let btn = el.querySelector('.key-auto-btn');
    el.classList.toggle('has-auto-btn', wants);
    if (!wants) { if (btn) btn.remove(); return; }
    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'key-auto-btn';
        btn.innerHTML = '<span class="key-auto-label"><i></i>AUTO</span>';
        const stop = (e) => { e.stopPropagation(); };
        btn.addEventListener('pointerdown', stop);
        btn.addEventListener('pointerup', stop);
        btn.addEventListener('touchstart', stop, { passive: true });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.classList.contains('is-unavailable')) return;
            btn.classList.add('is-busy');
            setTimeout(() => btn.classList.remove('is-busy'), 600);
            wsSend({ event: 'toggleMute', app: 'fans' });
        });
        el.appendChild(btn);
    }
    // O ícone da tecla (ventoinha) vive dentro do botão: tocar no símbolo alterna o automático
    const icon = el.querySelector('.key-icon');
    if (icon && icon.parentNode !== btn) btn.insertBefore(icon, btn.firstChild);
    const available = cfg.autoAvailable !== false;
    btn.classList.toggle('is-on', !!cfg.autoMode && available);
    btn.classList.toggle('is-unavailable', !available);
    btn.setAttribute('aria-pressed', cfg.autoMode ? 'true' : 'false');
    btn.setAttribute('aria-label', cfg.autoMode ? 'Controle automático ligado (toque para manual)' : 'Controle automático desligado (toque para ligar)');
    btn.title = available ? (cfg.autoMode ? 'Automático: curvas do CoolerControl' : 'Manual: velocidade fixa do fader') : 'CoolerControl indisponível';
}

function applyKeyAccessibleName(el, cfg) {
    const base = cfg.title || `Tecla ${cfg.index + 1}`;
    el.setAttribute('aria-label', isSliderKey(cfg) ? `${base} (volume)` : base);
}

/**
 * Interação da tecla via Pointer Events:
 *  - listeners em `window` só existem enquanto o ponteiro está pressionado;
 *  - toque simples -> keyDown/keyUp; arraste vertical em fader -> setVolume (throttle 50 ms, valor final garantido);
 *  - arraste horizontal (em qualquer tecla) só cancela o toque: o deslize de perfil é tratado pela grade;
 *  - teclado: Enter/Espaço aciona; setas ajustam volume em faders.
 */
function attachKeyInteraction(el, cfg) {
    const isSlider = isSliderKey(cfg);
    const appId = sliderAppOf(cfg);

    let pointerDown = false;
    let dragging = false;
    let dragAxis = null; // 'x' | 'y' (travado no primeiro movimento acima do limiar)
    let startX = 0;
    let startY = 0;
    let activePointerId = null;
    let lastSentAt = 0;
    let pendingValue = null;
    let throttleTimer = null;
    let lastShownValue = cfg.sliderValue !== undefined ? cfg.sliderValue : 80;

    const paintPercent = (percent) => {
        lastShownValue = percent;
        const fill = el.querySelector('.key-slider-fill');
        if (fill) fill.style.height = `${percent}%`;
        const badge = el.querySelector('.key-badge');
        if (badge) badge.textContent = `${percent}%`;
        el.setAttribute('aria-valuenow', String(percent));
    };

    const flushVolume = () => {
        throttleTimer = null;
        if (pendingValue === null) return;
        lastSentAt = Date.now();
        wsSend({ event: 'setVolume', app: appId, value: pendingValue });
        pendingValue = null;
    };

    const sendVolume = (percent, force) => {
        pendingValue = percent;
        const elapsed = Date.now() - lastSentAt;
        if (force || elapsed >= VOLUME_THROTTLE_MS) {
            if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
            flushVolume();
        } else if (!throttleTimer) {
            throttleTimer = setTimeout(flushVolume, VOLUME_THROTTLE_MS - elapsed);
        }
    };

    const percentFromY = (clientY) => {
        const rect = (el.querySelector('.key-slider-track') || el).getBoundingClientRect();
        if (!rect.height) return lastShownValue;
        return clamp(Math.round((1 - (clientY - rect.top) / rect.height) * 100), 0, 100);
    };

    const cleanup = () => {
        pointerDown = false;
        activePointerId = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('blur', onCancel);
        el.classList.remove('is-pressed', 'is-dragging');
        activeDragCleanups.delete(cleanup);
    };

    const isVolumeDrag = () => isSlider && dragAxis === 'y';

    const onMove = (e) => {
        if (!pointerDown || e.pointerId !== activePointerId) return;
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        if (!dragging) {
            if (Math.max(dx, dy) <= DRAG_THRESHOLD_PX) return;
            dragging = true;
            dragAxis = dx > dy ? 'x' : 'y';
        }
        if (!isVolumeDrag()) return; // tecla comum ou deslize horizontal: só cancela o toque
        el.classList.add('is-dragging');
        const percent = percentFromY(e.clientY);
        paintPercent(percent);
        sendVolume(percent, false);
        e.preventDefault();
    };

    const onUp = (e) => {
        if (!pointerDown || e.pointerId !== activePointerId) return;
        const wasDragging = dragging;
        const wasVolume = isVolumeDrag();
        cleanup();
        if (wasDragging) {
            if (wasVolume) sendVolume(lastShownValue, true); // garante o valor final
            return;
        }
        // Toque simples: só dispara se o down ocorreu nesta tecla e não houve arraste.
        if (!sendKeyEvent('keyDown', cfg.index)) {
            toast('Sem conexão com o servidor.', { type: 'error', duration: 2500 });
            return;
        }
        sendKeyEvent('keyUp', cfg.index);
    };

    const onCancel = () => {
        if (!pointerDown) return;
        const wasVolume = dragging && isVolumeDrag();
        cleanup();
        if (wasVolume) sendVolume(lastShownValue, true);
    };

    el.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (pointerDown) return;
        pointerDown = true;
        dragging = false;
        dragAxis = null;
        startX = e.clientX;
        startY = e.clientY;
        activePointerId = e.pointerId;
        el.classList.add('is-pressed');
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        window.addEventListener('blur', onCancel);
        activeDragCleanups.add(cleanup);
        e.preventDefault();
    });

    // Evita menu de contexto em toque longo no tablet
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (sendKeyEvent('keyDown', cfg.index)) sendKeyEvent('keyUp', cfg.index);
            else toast('Sem conexão com o servidor.', { type: 'error', duration: 2500 });
            return;
        }
        if (!isSlider) return;
        let delta = 0;
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') delta = 5;
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') delta = -5;
        else if (e.key === 'PageUp') delta = 20;
        else if (e.key === 'PageDown') delta = -20;
        else if (e.key === 'Home') delta = -100;
        else if (e.key === 'End') delta = 100;
        if (!delta) return;
        e.preventDefault();
        const next = clamp(lastShownValue + delta, 0, 100);
        paintPercent(next);
        sendVolume(next, true);
    });
}

function updateSingleKeyUI(index) {
    const el = document.getElementById(`deck-key-${index}`);
    const cfg = keysData.find(k => k.index === index);
    if (!el || !cfg) return;

    const muted = isKeyMuted(cfg);
    const isSlider = isSliderKey(cfg);
    const pressed = el.classList.contains('is-pressed');
    const draggingNow = el.classList.contains('is-dragging');
    el.className = 'deck-key' + (cfg.active ? ' active-toggle' : '') + (muted ? ' key-muted' : '') + (isSlider ? ' key-slider' : '') +
        (pressed ? ' is-pressed' : '') + (draggingNow ? ' is-dragging' : '') + (el.querySelector('.key-slider-track') ? ' key-tall' : '') +
        (cfg.imageFill && cfg.icon ? ' key-image-fill' : '') + (isStatKey(cfg) ? ' key-stat-tile' : '') + (cfg.bgColor && !muted && isDarkColor(cfg.bgColor) ? ' has-dark-bg' : '') +
        ((spanOf(cfg).cols > 1 || spanOf(cfg).rows > 1) ? ' key-span' : '');
    applyKeyAccessibleName(el, cfg);

    if (isStatKey(cfg)) {
        if (!muted) { el.style.borderColor = cfg.borderColor || ''; el.style.backgroundColor = cfg.bgColor || ''; }
        renderStatContent(el, cfg);
        return;
    }

    if (!muted) {
        el.style.borderColor = cfg.borderColor || '';
        el.style.backgroundColor = cfg.bgColor || '';
    } else {
        el.style.borderColor = '';
        el.style.backgroundColor = '';
    }

    let fill = el.querySelector('.key-slider-fill');
    if (isSlider) {
        if (!fill) {
            fill = document.createElement('div');
            fill.className = 'key-slider-fill';
            el.insertBefore(fill, el.firstChild);
        }
        // Durante o arraste local, a posição do dedo manda; fora dele, o servidor manda.
        if (!draggingNow) {
            const val = cfg.sliderValue !== undefined ? cfg.sliderValue : 80;
            fill.style.height = `${val}%`;
            el.setAttribute('aria-valuenow', String(val));
        }
    } else if (fill) {
        fill.remove();
    }

    let badge = el.querySelector('.key-badge');
    if (cfg.badge) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'key-badge';
            el.appendChild(badge);
        }
        badge.textContent = cfg.badge;
        badge.style.backgroundColor = (cfg.badgeColor && !muted) ? cfg.badgeColor : '';
    } else if (badge) {
        badge.remove();
    }

    let img = el.querySelector('.key-icon');
    if (cfg.icon) {
        if (!img) {
            img = document.createElement('img');
            img.className = 'key-icon';
            img.alt = '';
            img.draggable = false;
            const titleEl = el.querySelector('.key-title');
            el.insertBefore(img, titleEl || null);
        }
        if (img.src !== cfg.icon) img.src = cfg.icon;
    } else if (img) {
        img.remove();
    }

    const title = el.querySelector('.key-title');
    if (title) {
        title.textContent = cfg.title || '';
        title.style.color = (cfg.titleColor && !muted) ? cfg.titleColor : '';
    }
    syncAutoButton(el, cfg);
    syncTransport(el, cfg);
    applyIconScale(el, cfg);
}

function sendKeyEvent(type, index) {
    return wsSend({ event: type, keyIndex: index, profile: currentProfile });
}

// ----------------------------------------------------
// DESLIZE HORIZONTAL: perfil anterior / seguinte
// ----------------------------------------------------
let swipe = null;          // { id, x, y, axis } do gesto em andamento
let activePointers = 0;    // gestos com mais de um dedo não trocam de perfil
let swipeLabelTimer = null;

function showSwipeLabel(text) {
    swipeLabel.textContent = text;
    setHidden(swipeLabel, false);
    swipeLabel.classList.add('is-visible');
    if (swipeLabelTimer) clearTimeout(swipeLabelTimer);
    swipeLabelTimer = setTimeout(() => {
        swipeLabel.classList.remove('is-visible');
        setTimeout(() => setHidden(swipeLabel, true), 200);
    }, SWIPE_LABEL_MS);
}

function switchProfileBy(step) {
    const list = (profileList || []).filter(p => p && p.id);
    if (list.length < 2) return false;
    let idx = list.findIndex(p => p.id === currentProfile);
    if (idx < 0) idx = 0;
    const next = list[(idx + step + list.length) % list.length];
    if (!wsSend({ event: 'switchProfile', profile: next.id })) {
        toast('Sem conexão com o servidor para trocar o perfil.', { type: 'error', duration: 2500 });
        return false;
    }
    showSwipeLabel(next.name || next.id);
    return true;
}

gridWrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    activePointers++;
    if (activePointers > 1) { swipe = null; return; }
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null };
});

gridWrap.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    if (swipe.axis) return;
    const dx = Math.abs(e.clientX - swipe.x);
    const dy = Math.abs(e.clientY - swipe.y);
    if (Math.max(dx, dy) > DRAG_THRESHOLD_PX) swipe.axis = dx > dy ? 'x' : 'y';
});

function endSwipe(e, allowSwitch) {
    activePointers = Math.max(0, activePointers - 1);
    if (!swipe || e.pointerId !== swipe.id) return;
    const s = swipe;
    swipe = null;
    if (!allowSwitch || s.axis !== 'x') return;
    if (activePointers > 0) return;
    if (gridEl.querySelector('.deck-key.is-dragging')) return; // fader em arraste vertical
    const dx = e.clientX - s.x;
    const dy = Math.abs(e.clientY - s.y);
    if (Math.abs(dx) < SWIPE_MIN_X || dy >= SWIPE_MAX_Y) return;
    switchProfileBy(dx < 0 ? 1 : -1);
}

gridWrap.addEventListener('pointerup', (e) => endSwipe(e, true));
gridWrap.addEventListener('pointercancel', (e) => endSwipe(e, false));
window.addEventListener('blur', () => { swipe = null; activePointers = 0; });

// ----------------------------------------------------
// INDICADOR DE CONEXÃO + FOLHA DE OPÇÕES
// ----------------------------------------------------
function renderConnectionUI() {
    const label = connectionState === 'connected' ? 'Conectado' : connectionState === 'connecting' ? 'Conectando...' : 'Desconectado';
    const addr = serverAddress ? ` · ${serverAddress}` : '';
    connDot.dataset.state = connectionState;
    connDot.setAttribute('aria-label', `${label}${addr}. Toque para opções`);
    connDot.title = `${label}${addr}`;
    sheetStatusDot.dataset.state = connectionState;
    sheetTitle.textContent = label;
    sheetProfile.textContent = currentProfileName || currentProfile || '—';
    sheetIp.textContent = serverAddress || '—';
}

let sheetFocusReturn = null;

function openSheet() {
    renderConnectionUI();
    sheetFocusReturn = document.activeElement;
    setHidden(sheetBackdrop, false);
    connDot.setAttribute('aria-expanded', 'true');
    document.body.classList.add('sheet-open');
    setTimeout(() => sheetClose.focus(), 20);
}

function closeSheet() {
    if (sheetBackdrop.hasAttribute('hidden')) return;
    setHidden(sheetBackdrop, true);
    connDot.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('sheet-open');
    if (sheetFocusReturn && typeof sheetFocusReturn.focus === 'function') sheetFocusReturn.focus();
    sheetFocusReturn = null;
    if (document.fullscreenElement) showCorner(true); // volta a esconder o canto depois de fechar as opções
}

connDot.addEventListener('click', () => {
    if (sheetBackdrop.hasAttribute('hidden')) openSheet(); else closeSheet();
});
sheetClose.addEventListener('click', closeSheet);
sheetBackdrop.addEventListener('pointerdown', (e) => { if (e.target === sheetBackdrop) closeSheet(); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheetBackdrop.hasAttribute('hidden')) closeSheet();
    if (e.key === 'Tab' && !sheetBackdrop.hasAttribute('hidden')) {
        const focusables = [...sheetBackdrop.querySelectorAll('button:not([disabled]), a[href]')].filter(el => el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
});

// Tema (Escuro/Claro) e tamanho da fonte das teclas (P/M/G), ambos em localStorage
function applyTheme(theme) {
    const light = theme === 'light';
    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', light ? 'light dark' : 'dark light');
    for (const b of themeSeg.querySelectorAll('button')) {
        b.setAttribute('aria-pressed', b.dataset.themeValue === (light ? 'light' : 'dark') ? 'true' : 'false');
    }
}

function applyFontSize(size) {
    const s = (size === 's' || size === 'l') ? size : 'm';
    if (s === 'm') document.documentElement.removeAttribute('data-font');
    else document.documentElement.setAttribute('data-font', s);
    for (const b of fontSeg.querySelectorAll('button')) {
        b.setAttribute('aria-pressed', b.dataset.fontValue === s ? 'true' : 'false');
    }
}

themeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-value]');
    if (!btn) return;
    applyTheme(btn.dataset.themeValue);
    storageSet(THEME_KEY, btn.dataset.themeValue);
});

fontSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-font-value]');
    if (!btn) return;
    applyFontSize(btn.dataset.fontValue);
    storageSet(FONT_KEY, btn.dataset.fontValue);
});

// ----------------------------------------------------
// MANTER A TELA ACESA
// Wake Lock API quando existir (Chrome 84+); senão NoSleep.js (vídeo mudo em loop, invisível),
// que é o que funciona no Chrome 81 do tablet. O vídeo é silenciado de propósito: vídeo mudo
// pode tocar sem gesto do usuário, então a tela fica presa já ao abrir a página (e depois de
// um reload). Se o navegador recusar mesmo assim, o fim do próximo toque tenta de novo — no
// toque, só touchend/pointerup/click contam como ativação do usuário (touchstart não conta).
// ----------------------------------------------------
const AWAKE_KEY = 'matdeck-awake';
const AWAKE_WATCHDOG_MS = 20000;
let awakeWanted = storageGet(AWAKE_KEY) !== 'off';
let wakeLock = null;
let noSleep = null;
let awakeActive = false;

function noSleepVideoPlaying() {
    const v = noSleep && noSleep.noSleepVideo;
    return !!v && !v.paused && !v.ended && v.readyState > 0;
}

function awakeHeld() {
    return !!wakeLock || noSleepVideoPlaying();
}

function setAwakeActive(on) {
    awakeActive = !!on;
    if (!awakeStatus) return;
    if (!awakeWanted) awakeStatus.textContent = '';
    else awakeStatus.textContent = awakeActive ? 'Ativo: a tela não escurece.' : 'Aguardando um toque na tela para ativar…';
}

async function enableAwake() {
    if (!awakeWanted || document.visibilityState !== 'visible') return false;
    if ('wakeLock' in navigator && navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
        try {
            if (!wakeLock) {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => { wakeLock = null; setAwakeActive(awakeHeld()); });
            }
            setAwakeActive(true);
            return true;
        } catch (e) { /* cai no NoSleep */ }
    }
    if (typeof NoSleep !== 'function') { setAwakeActive(false); return false; }
    try {
        if (!noSleep) {
            noSleep = new NoSleep();
            const v = noSleep.noSleepVideo;
            if (v) {
                v.muted = true;
                v.setAttribute('muted', '');
                v.setAttribute('loop', '');
                v.addEventListener('pause', () => setAwakeActive(awakeHeld()));
                v.addEventListener('playing', () => setAwakeActive(true));
            }
        }
        if (!noSleepVideoPlaying()) await noSleep.enable();
        setAwakeActive(noSleep.noSleepVideo ? noSleepVideoPlaying() : !!noSleep.isEnabled);
    } catch (e) {
        // Normalmente NotAllowedError (sem gesto do usuário): o próximo toque tenta de novo
        setAwakeActive(false);
    }
    return awakeActive;
}

function disableAwake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
    if (noSleep) { try { noSleep.disable(); } catch (e) { /* ignore */ } }
    setAwakeActive(false);
}

function applyAwakeUI() {
    for (const b of awakeSeg.querySelectorAll('[data-awake-value]')) {
        b.setAttribute('aria-pressed', (b.dataset.awakeValue === 'on') === awakeWanted ? 'true' : 'false');
    }
    setAwakeActive(awakeActive);
}

// Se o navegador recusou tocar sem gesto, qualquer gesto que conte como ativação tenta de novo
function armAwakeOnGesture() {
    const retry = () => { if (awakeWanted && !awakeHeld()) enableAwake(); };
    for (const ev of ['pointerup', 'touchend', 'click', 'keydown']) {
        document.addEventListener(ev, retry, { passive: true });
    }
}

// Ao voltar para a aba, o Wake Lock é liberado pelo navegador (e o vídeo pode ter pausado): pede de novo
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && awakeWanted) enableAwake();
});

// Vigia: se o vídeo parou (fim da faixa, pausa pelo sistema, reload) tenta retomar sem precisar de toque
setInterval(() => {
    if (awakeWanted && document.visibilityState === 'visible' && !awakeHeld()) enableAwake();
}, AWAKE_WATCHDOG_MS);

const awakeSeg = $('awake-seg');
const awakeStatus = $('awake-status');
awakeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-awake-value]');
    if (!btn) return;
    awakeWanted = btn.dataset.awakeValue === 'on';
    storageSet(AWAKE_KEY, awakeWanted ? 'on' : 'off');
    applyAwakeUI();
    if (awakeWanted) enableAwake(); else disableAwake();
    toast(awakeWanted ? 'A tela vai ficar acesa enquanto o deck estiver aberto.' : 'O tablet volta a apagar a tela normalmente.', { type: 'info', duration: 2500 });
});
applyAwakeUI();
armAwakeOnGesture();
if (awakeWanted) enableAwake();

// Em tela cheia, o bloco do canto se esconde sozinho e volta com um toque no canto superior esquerdo
const CORNER_HIDE_MS = 3000;
let cornerHideTimer = null;

function showCorner(autoHide) {
    document.body.classList.remove('corner-hidden');
    if (cornerHideTimer) { clearTimeout(cornerHideTimer); cornerHideTimer = null; }
    if (autoHide) cornerHideTimer = setTimeout(() => { if (document.fullscreenElement && !sheetOpen()) document.body.classList.add('corner-hidden'); }, CORNER_HIDE_MS);
}

function sheetOpen() {
    return connDot.getAttribute('aria-expanded') === 'true';
}

$('corner-hotzone').addEventListener('pointerdown', (e) => { e.preventDefault(); showCorner(true); });

function refreshFullscreenLabel() {
    const on = !!document.fullscreenElement;
    btnFullscreenLabel.textContent = on ? 'Sair da tela cheia' : 'Tela cheia';
    btnFullscreenCorner.setAttribute('aria-pressed', on ? 'true' : 'false');
    btnFullscreenCorner.setAttribute('aria-label', on ? 'Sair da tela cheia' : 'Tela cheia');
    document.body.classList.toggle('is-fullscreen', on);
    showCorner(on);
}

// Em tela cheia o navegador deixa travar a orientação: o deck fica na horizontal mesmo com a
// rotação do tablet bloqueada na vertical (o Android respeita a orientação pedida pelo app).
function lockLandscape() {
    const so = screen.orientation;
    if (!so || typeof so.lock !== 'function') return Promise.resolve(false);
    return so.lock('landscape').then(() => true).catch(() => false);
}

function unlockOrientation() {
    const so = screen.orientation;
    if (so && typeof so.unlock === 'function') { try { so.unlock(); } catch (e) { /* ignore */ } }
}

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen()
            .then(lockLandscape)
            .catch(() => toast('Tela cheia não disponível neste navegador.', { type: 'warning' }));
    } else {
        unlockOrientation();
        document.exitFullscreen().catch(() => {});
    }
}

// Ao abrir já instalado na tela inicial (manifest standalone) a orientação vem do manifest;
// ainda assim tenta travar, caso o navegador permita fora da tela cheia.
if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) lockLandscape();

btnFullscreen.addEventListener('click', toggleFullscreen);
btnFullscreenCorner.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', refreshFullscreenLabel);

// ----------------------------------------------------
// POLL DE STATUS (endereço do servidor + HUD de reserva)
// ----------------------------------------------------
async function pollStatus() {
    const res = await apiFetch('/api/status');
    if (!res.ok || !res.data) return;
    const data = res.data;
    if (data.ip) {
        serverAddress = `${data.ip}:${data.port}`;
        renderConnectionUI();
    }
    if (data.profile && data.profile !== currentProfile) {
        currentProfile = data.profile;
        renderConnectionUI();
    }
    if (data.hardware && !hardwareHud.hasAttribute('hidden')) updateHardwareHud(data.hardware);
}

// ----------------------------------------------------
// BOOT
// ----------------------------------------------------
renderSkeletonGrid();
applyTheme(storageGet(THEME_KEY) === 'light' ? 'light' : 'dark');
applyFontSize(storageGet(FONT_KEY) || 'm');
refreshFullscreenLabel();

// Altura real da janela (navegadores móveis mudam innerHeight com a barra de endereço)
function syncViewportHeight() {
    try {
        document.documentElement.style.setProperty('--app-h', window.innerHeight + 'px');
    } catch (e) {}
}
syncViewportHeight();
window.addEventListener('resize', syncViewportHeight);
window.addEventListener('orientationchange', function () { setTimeout(syncViewportHeight, 300); });

initWebSocket();
pollStatus();
setInterval(pollStatus, 5000);
