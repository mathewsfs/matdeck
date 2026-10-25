/* ==========================================================================
   MatDeck - Gerenciar (/manage)
   Painel estilo Elgato: dropdown de perfil, aparelho com grade, painel de
   ações (arrastar e soltar) e inspetor da tecla com salvamento automático.
   Sem dependências externas.
   ========================================================================== */
'use strict';

const $ = (id) => document.getElementById(id);

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const AUTOSAVE_MS = 600;
const PROFILE_ICON_BY_ID = { obs: 'obs', discord: 'discord', teamspeak: 'teamspeak', meet: 'meet', nextcloud: 'nextcloud', spotify: 'spotify', default: 'home', more: 'grid' };
const LIVE_FIELDS = ['active', 'badge', 'badgeColor', 'bgColor', 'borderColor', 'title', 'titleColor', 'sliderValue', 'icon', 'statLabel', 'statValue', 'statSub', 'statPercent', 'statColor', 'statHead', 'statBig', 'statMode', 'statHistory', 'statHistory2', 'statHistoryMax', 'statBars', 'statRows', 'statColor2', 'statHistoryMin', 'statImage', 'statTime', 'statTotal'];

const state = {
    profiles: {},          // id -> definição completa (GET /api/profiles)
    list: [],              // [{id,name,builtin}]
    removed: [],           // abas embutidas excluídas pelo usuário [{id,name}]
    current: null,         // perfil ativo no tablet
    editingId: null,       // perfil em edição no painel
    selected: null,        // índice da tecla selecionada
    catalog: { groups: [] },
    actionById: new Map(),
    icons: {},             // nome -> dataURL
    liveKeys: {},          // overlay de estado vivo (apenas do perfil ativo): index -> key parcial
    armed: null,           // ação "armada" para atribuição por toque
    collapsed: new Set(),  // grupos recolhidos
    seenGroups: new Set(), // grupos já vistos: um grupo novo nasce recolhido
    dirty: false,
    saving: false,
    saveTimer: null,
    saveState: 'idle',
    ws: null,
    wsTimer: null,
    autoDetect: false,
    pending: [],           // pedidos de conexão aguardando PIN [{id,name,ip,pin,expiresAt}]
    devices: []            // dispositivos emparelhados [{id,name,ip,lastSeenAt,online}]
};

// --------------------------------------------------------------------------
// Utilidades
// --------------------------------------------------------------------------
function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'dataset') Object.assign(el.dataset, v);
            else if (k === 'style') el.style.cssText = v;
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else if (k === 'text') el.textContent = v;
            else el.setAttribute(k, v === true ? '' : v);
        }
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
}

function svgIcon(name, cls = 'ico') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${name}`);
    svg.appendChild(use);
    return svg;
}

function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
}

function slugify(text) {
    return String(text || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/^[^a-z0-9]+/, '')
        .slice(0, 41);
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

async function apiFetch(url, options) {
    try {
        const res = await fetch(url, options);
        const text = await res.text();
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        return { ok: res.ok, status: res.status, data };
    } catch (error) {
        return { ok: false, status: 0, data: null, error };
    }
}

function apiJson(url, method, body) {
    return apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

function wsSend(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

// --------------------------------------------------------------------------
// Toasts (mesma linguagem do deck)
// --------------------------------------------------------------------------
const toastContainer = $('toast-container');
const notifyDismissers = new Map();

function toast(message, opts = {}) {
    const { type = 'info', title = null, duration = 3200 } = opts;
    const el = h('div', { class: `toast toast-${type}`, role: 'status' });
    const body = h('div', { class: 'toast-body' });
    if (title) body.appendChild(h('span', { class: 'toast-title', text: title }));
    if (message) body.appendChild(h('span', { class: 'toast-text', text: message }));
    el.appendChild(body);
    let timer = null;
    const dismiss = () => {
        if (timer) clearTimeout(timer);
        if (!el.isConnected) return;
        el.classList.add('toast-leaving');
        setTimeout(() => el.remove(), 200);
    };
    el.appendChild(h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Fechar', onclick: dismiss }, svgIcon('i-close')));
    toastContainer.appendChild(el);
    if (duration > 0) timer = setTimeout(dismiss, duration);
    while (toastContainer.children.length > 4) toastContainer.firstElementChild.remove();
    return dismiss;
}

function showServerNotification(msg) {
    const id = msg.id || null;
    // Mesmo payload do deck: level info|success|warn|poke e ttlMs
    const type = { success: 'success', warn: 'warning', poke: 'info' }[msg.level] || 'info';
    const ttl = Number(msg.ttlMs);
    if (id && notifyDismissers.has(id)) notifyDismissers.get(id)();
    const dismiss = toast(msg.text || '', { title: msg.title || null, type, duration: Number.isFinite(ttl) && ttl > 0 ? ttl : 5000 });
    if (id) notifyDismissers.set(id, dismiss);
}

// --------------------------------------------------------------------------
// Popovers (dropdown de perfil, menu, ícones): um aberto por vez
// --------------------------------------------------------------------------
let openPopover = null; // { pop, btn }

function closePopover() {
    if (!openPopover) return;
    const { pop, btn } = openPopover;
    setHidden(pop, true);
    if (btn) btn.setAttribute('aria-expanded', 'false');
    openPopover = null;
}

function togglePopover(pop, btn) {
    if (openPopover && openPopover.pop === pop) { closePopover(); return false; }
    closePopover();
    setHidden(pop, false);
    btn.setAttribute('aria-expanded', 'true');
    openPopover = { pop, btn };
    return true;
}

document.addEventListener('pointerdown', (e) => {
    if (!openPopover) return;
    const { pop, btn } = openPopover;
    if (pop.contains(e.target) || (btn && btn.contains(e.target))) return;
    closePopover();
});

// --------------------------------------------------------------------------
// Perfis: carregamento, dropdown e menu
// --------------------------------------------------------------------------
const profileBtn = $('profile-btn');
const profilePop = $('profile-pop');
const profileListEl = $('profile-list');
const profileMenuBtn = $('profile-menu-btn');
const profileMenu = $('profile-menu');
const menuItems = $('menu-items');
const menuForm = $('menu-form');
const menuFormTitle = $('menu-form-title');
const menuFormName = $('menu-form-name');
const menuFormId = $('menu-form-id');
const menuFormIdField = $('menu-form-id-field');
const menuFormError = $('menu-form-error');
const menuFormOk = $('menu-form-ok');
const menuConfirm = $('menu-confirm');
const menuConfirmText = $('menu-confirm-text');
const saveStateEl = $('save-state');
const selRows = $('sel-rows');
const selCols = $('sel-cols');
const chkHud = $('chk-hud');

function profileOf(id) { return state.profiles[id] || null; }
function editingProfile() { return profileOf(state.editingId); }
function isEditable(p) { return !!p && (!p.builtin || !!p.editable); }
function profileIconUrl(p) {
    if (!p) return '';
    const name = PROFILE_ICON_BY_ID[p.id];
    if (name && state.icons[name]) return state.icons[name];
    const firstWithIcon = (p.keys || []).find(k => k && k.icon);
    return firstWithIcon ? firstWithIcon.icon : (state.icons.grid || '');
}

async function loadProfiles() {
    const [profRes, listRes, removedRes] = await Promise.all([apiFetch('/api/profiles'), apiFetch('/api/profiles/list?all=1'), apiFetch('/api/profiles/removed')]);
    if (!profRes.ok || !profRes.data) return false;
    state.removed = (removedRes.ok && removedRes.data && Array.isArray(removedRes.data.profiles)) ? removedRes.data.profiles : [];
    const incoming = profRes.data;
    // Preserva o perfil em edição se houver alterações pendentes (evita sobrescrever o que o usuário digita)
    if (state.editingId && (state.dirty || state.saving) && state.profiles[state.editingId] && incoming[state.editingId]) {
        incoming[state.editingId] = state.profiles[state.editingId];
    }
    state.profiles = incoming;
    if (listRes.ok && listRes.data && Array.isArray(listRes.data.profiles)) {
        state.list = listRes.data.profiles.filter(p => p && p.id);
        if (listRes.data.current) state.current = listRes.data.current;
    } else {
        state.list = Object.values(incoming).map(p => ({ id: p.id, name: p.name, builtin: !!p.builtin, editable: !!p.editable, overridden: !!p.overridden, hidden: !!p.hidden }));
    }
    return true;
}

function renderPickerButton() {
    const p = editingProfile();
    const iconEl = $('profile-btn-icon');
    iconEl.textContent = '';
    if (!p) {
        $('profile-btn-name').textContent = 'Nenhum perfil';
        $('profile-btn-meta').textContent = '';
        return;
    }
    const url = profileIconUrl(p);
    if (url) iconEl.appendChild(h('img', { src: url, alt: '' }));
    $('profile-btn-name').textContent = p.name || p.id;
    const parts = [`${p.rows}×${p.cols}`];
    parts.push(p.builtin ? 'embutido' : 'meu perfil');
    if (state.current === p.id) parts.push('ativo no tablet');
    $('profile-btn-meta').textContent = parts.join(' · ');
}

function renderPickerList() {
    profileListEl.textContent = '';
    const builtin = state.list.filter(p => p.builtin);
    const mine = state.list.filter(p => !p.builtin);
    const addGroup = (label, items) => {
        if (!items.length) return;
        profileListEl.appendChild(h('li', { class: 'picker-group', role: 'presentation', text: label }));
        for (const item of items) {
            const p = profileOf(item.id) || item;
            const isEditing = item.id === state.editingId;
            const isActive = item.id === state.current;
            const btn = h('button', {
                type: 'button', class: 'picker-item', role: 'option', dataset: { id: item.id },
                'aria-selected': isEditing ? 'true' : 'false',
                onclick: () => { closePopover(); selectProfile(item.id, { switchTablet: true }); }
            },
                h('span', { class: 'picker-icon' }, profileIconUrl(p) ? h('img', { src: profileIconUrl(p), alt: '' }) : null),
                h('span', { class: 'picker-item-name', text: item.name || item.id }),
                item.hidden ? h('span', { class: 'picker-item-tag tag-hidden', text: 'oculto', title: 'Fora das abas e do ciclo do tablet' }) : null,
                item.builtin ? h('span', { class: 'picker-item-tag', text: 'embutido' }) : null,
                isActive ? h('span', { class: 'picker-item-active', title: 'Ativo no tablet', 'aria-label': 'ativo no tablet' }, svgIcon('i-check')) : null
            );
            profileListEl.appendChild(h('li', { role: 'presentation' }, btn));
        }
    };
    addGroup('Meus perfis', mine);
    addGroup('Embutidos', builtin);
}

profileBtn.addEventListener('click', () => {
    renderPickerList();
    if (togglePopover(profilePop, profileBtn)) {
        const sel = profileListEl.querySelector('[aria-selected="true"]') || profileListEl.querySelector('.picker-item');
        if (sel) sel.focus();
    }
});

profileListEl.addEventListener('keydown', (e) => {
    const items = [...profileListEl.querySelectorAll('.picker-item')];
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (items[idx + 1] || items[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); }
    else if (e.key === 'Escape') { closePopover(); profileBtn.focus(); }
});

// Menu de perfil -----------------------------------------------------------
let menuMode = null; // 'new' | 'duplicate' | 'rename'
let confirmKind = null; // 'delete-preset' | 'delete-builtin' | 'restore-layout'

function canDelete(p) { return !!p && p.id !== 'default'; }

function resetMenu() {
    setHidden(menuItems, false);
    setHidden(menuForm, true);
    setHidden(menuConfirm, true);
    setHidden(menuFormError, true);
    menuFormName.removeAttribute('aria-invalid');
    menuFormId.removeAttribute('aria-invalid');
    menuMode = null;
    const p = editingProfile();
    $('menu-rename').disabled = !isEditable(p);
    $('menu-delete').disabled = !canDelete(p);
    setHidden($('menu-delete-hint'), !(p && p.builtin && canDelete(p)));
    setHidden($('menu-restore-layout'), !(p && p.builtin && p.overridden));
    const restoreTabs = $('menu-restore-tabs');
    setHidden(restoreTabs, !state.removed.length);
    restoreTabs.querySelector('span').textContent = state.removed.length ? `Restaurar abas excluídas (${state.removed.map(r => r.name).join(', ')})` : 'Restaurar abas excluídas';
    const entry = p && state.list.find(x => x.id === p.id);
    const hiddenNow = !!(entry && entry.hidden);
    const vis = $('menu-visibility');
    vis.querySelector('span').textContent = hiddenNow ? 'Mostrar no tablet' : 'Ocultar no tablet';
    vis.querySelector('use').setAttribute('href', hiddenNow ? '#i-eye' : '#i-eye-off');
    vis.disabled = !p || (p.id === 'default' && !hiddenNow);
    vis.title = (p && p.id === 'default') ? 'O perfil Principal não pode ser ocultado' : '';
    $('menu-rename').title = isEditable(p) ? '' : 'Perfis embutidos não podem ser renomeados';
    $('menu-delete').title = canDelete(p) ? '' : 'O perfil Principal não pode ser excluído';
}

profileMenuBtn.addEventListener('click', () => {
    resetMenu();
    if (togglePopover(profileMenu, profileMenuBtn)) {
        const first = menuItems.querySelector('.menu-item:not(:disabled)');
        if (first) first.focus();
    }
});

function uniqueId(base) {
    let id = slugify(base) || 'perfil';
    if (!ID_PATTERN.test(id)) id = 'perfil';
    let candidate = id;
    let n = 2;
    while (state.profiles[candidate]) candidate = `${id}-${n++}`.slice(0, 41);
    return candidate;
}

function openMenuForm(mode) {
    const p = editingProfile();
    menuMode = mode;
    setHidden(menuItems, true);
    setHidden(menuConfirm, true);
    setHidden(menuForm, false);
    setHidden(menuFormError, true);
    setHidden(menuFormIdField, mode === 'rename');
    if (mode === 'new') {
        menuFormTitle.textContent = 'Novo perfil';
        menuFormName.value = 'Novo perfil';
        menuFormOk.textContent = 'Criar';
    } else if (mode === 'duplicate') {
        menuFormTitle.textContent = 'Duplicar perfil';
        menuFormName.value = `${(p && p.name) || 'Perfil'} (cópia)`;
        menuFormOk.textContent = 'Duplicar';
    } else {
        menuFormTitle.textContent = 'Renomear perfil';
        menuFormName.value = (p && p.name) || '';
        menuFormOk.textContent = 'Renomear';
    }
    menuFormId.value = mode === 'rename' ? (p ? p.id : '') : uniqueId(menuFormName.value);
    menuFormId.dataset.auto = '1';
    menuFormName.focus();
    menuFormName.select();
}

menuFormName.addEventListener('input', () => {
    if (menuMode !== 'rename' && menuFormId.dataset.auto === '1') menuFormId.value = uniqueId(menuFormName.value);
});
menuFormId.addEventListener('input', () => { menuFormId.dataset.auto = '0'; });

menuItems.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'new' || act === 'duplicate' || act === 'rename') openMenuForm(act);
    else if (act === 'visibility') toggleVisibility();
    else if (act === 'restore-tabs') restoreRemovedTabs();
    else if (act === 'delete' || act === 'restore-layout') {
        const p = editingProfile();
        if (!p) return;
        setHidden(menuItems, true);
        setHidden(menuConfirm, false);
        menuConfirmText.textContent = '';
        const name = h('strong', { text: `“${p.name || p.id}”` });
        if (act === 'restore-layout') {
            confirmKind = 'restore-layout';
            menuConfirmText.append('Restaurar o layout padrão de ', name, '? Suas alterações nesse perfil serão descartadas.');
        } else if (p.builtin) {
            confirmKind = 'delete-builtin';
            menuConfirmText.append('Excluir a aba ', name, ' do tablet e do gerenciador?', p.overridden ? ' O layout que você personalizou nela será descartado.' : '', ' Dá para trazê-la de volta em “Restaurar abas excluídas”.');
        } else {
            confirmKind = 'delete-preset';
            menuConfirmText.append('Excluir o perfil ', name, '? As teclas dele serão perdidas. Esta ação não pode ser desfeita.');
        }
        $('menu-confirm-ok').focus();
    }
});

async function restoreRemovedTabs() {
    closePopover();
    const res = await apiJson('/api/profiles/restore-all', 'POST', {});
    if (!res.ok) { toast((res.data && res.data.error) || 'Não foi possível restaurar as abas.', { type: 'error' }); return; }
    const names = state.removed.map(r => r.name).join(', ');
    await loadProfiles();
    renderAll();
    toast(`Abas restauradas: ${names}.`, { type: 'success' });
    profileMenuBtn.focus();
}

async function toggleVisibility() {
    const p = editingProfile();
    if (!p) return;
    const entry = state.list.find(x => x.id === p.id);
    const hidden = !(entry && entry.hidden);
    closePopover();
    const res = await apiJson(`/api/profiles/${encodeURIComponent(p.id)}/visibility`, 'POST', { hidden });
    if (!res.ok) { toast((res.data && res.data.error) || 'Não foi possível alterar a visibilidade.', { type: 'error' }); return; }
    if (entry) entry.hidden = hidden;
    await loadProfiles();
    renderAll();
    toast(hidden ? `“${p.name}” oculto no tablet (continua acessível por switch: e por aqui).` : `“${p.name}” visível no tablet.`, { type: 'success' });
    profileMenuBtn.focus();
}

$('menu-form-cancel').addEventListener('click', () => { resetMenu(); profileMenuBtn.focus(); });
$('menu-confirm-cancel').addEventListener('click', () => { resetMenu(); profileMenuBtn.focus(); });

function showMenuError(msg, field) {
    menuFormError.textContent = msg;
    setHidden(menuFormError, false);
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
}

menuForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = menuFormName.value.trim();
    if (!name) return showMenuError('Informe um nome.', menuFormName);
    menuFormName.removeAttribute('aria-invalid');
    menuFormId.removeAttribute('aria-invalid');

    const src = editingProfile();
    let id;
    let body;
    if (menuMode === 'rename') {
        if (!isEditable(src)) return;
        id = src.id;
        body = { ...stripProfile(src), name };
    } else {
        id = menuFormId.value.trim();
        if (!ID_PATTERN.test(id)) return showMenuError('Identificador inválido: use letras minúsculas, números, "-" ou "_" (até 41 caracteres).', menuFormId);
        if (state.profiles[id]) return showMenuError(`Já existe um perfil com o identificador “${id}”.`, menuFormId);
        if (menuMode === 'duplicate' && src) {
            body = { ...stripProfile(JSON.parse(JSON.stringify(src))), id, name };
            body.keys = (body.keys || []).map(k => stripLive(k));
        } else {
            body = { id, name, rows: 3, cols: 5, showHardwareHud: true, keys: [] };
        }
    }

    menuFormOk.disabled = true;
    menuFormOk.classList.add('is-loading');
    const res = await apiJson(`/api/presets/${encodeURIComponent(id)}`, 'POST', body);
    menuFormOk.disabled = false;
    menuFormOk.classList.remove('is-loading');
    if (!res.ok) return showMenuError((res.data && res.data.error) || `Falha ao salvar (${res.status || 'sem conexão'}).`);

    closePopover();
    await loadProfiles();
    if (menuMode === 'rename') {
        renderAll();
        toast(`Perfil renomeado para “${name}”.`, { type: 'success' });
    } else {
        await selectProfile(id, { switchTablet: true });
        toast(menuMode === 'duplicate' ? `Perfil “${name}” duplicado e ativado no tablet.` : `Perfil “${name}” criado e ativado no tablet.`, { type: 'success' });
    }
    profileBtn.focus();
});

$('menu-confirm-ok').addEventListener('click', async () => {
    const p = editingProfile();
    const kind = confirmKind;
    if (!p || !kind) return;
    if (kind === 'delete-builtin' ? !canDelete(p) : !isEditable(p)) return;
    const okBtn = $('menu-confirm-ok');
    okBtn.disabled = true;
    const url = kind === 'delete-builtin' ? `/api/profiles/${encodeURIComponent(p.id)}` : `/api/presets/${encodeURIComponent(p.id)}`;
    const res = await apiFetch(url, { method: 'DELETE' });
    okBtn.disabled = false;
    if (!res.ok) {
        toast((res.data && res.data.error) || 'Não foi possível excluir o perfil.', { type: 'error' });
        return;
    }
    closePopover();
    cancelAutosave();
    confirmKind = null;
    const removedName = p.name;
    const restored = kind === 'restore-layout' && !!(res.data && res.data.restored);
    await loadProfiles();
    const next = restored ? p.id : (state.profiles[state.current] ? state.current : (state.profiles.default ? 'default' : Object.keys(state.profiles)[0]));
    await selectProfile(next, { switchTablet: false });
    if (restored) toast(`Layout padrão de “${removedName}” restaurado.`, { type: 'success' });
    else if (kind === 'delete-builtin') toast(`Aba “${removedName}” excluída. Para trazê-la de volta: ⋯ → Restaurar abas excluídas.`, { type: 'success' });
    else toast(`Perfil “${removedName}” excluído.`, { type: 'success' });
    profileBtn.focus();
});

// Duplicar para editar (banner de somente leitura)
$('btn-dup-to-edit').addEventListener('click', () => {
    resetMenu();
    togglePopover(profileMenu, profileMenuBtn);
    openMenuForm('duplicate');
});

// Seleção de perfil --------------------------------------------------------
async function selectProfile(id, { switchTablet = false } = {}) {
    if (!state.profiles[id]) return;
    if (state.editingId !== id) {
        await flushAutosave();
        state.editingId = id;
        state.selected = null;
        disarm();
    }
    if (switchTablet && state.current !== id) {
        const res = await apiJson('/api/profile/switch', 'POST', { profile: id });
        if (!res.ok) toast('Não foi possível ativar o perfil no tablet.', { type: 'error' });
        else state.current = id;
    }
    renderAll();
}

// Grade e HUD ---------------------------------------------------------------
function fillSelect(sel, from, to) {
    sel.textContent = '';
    for (let i = from; i <= to; i++) sel.appendChild(h('option', { value: String(i), text: String(i) }));
}
fillSelect(selRows, 1, 5);
fillSelect(selCols, 1, 8);

function normalizeKeys(p) {
    const total = p.rows * p.cols;
    const out = [];
    for (let i = 0; i < total; i++) {
        const existing = (p.keys || []).find(k => k && k.index === i);
        out.push(existing ? { ...existing, index: i } : { index: i, title: '' });
    }
    p.keys = out;
}

function onGridChange() {
    const p = editingProfile();
    if (!isEditable(p)) return;
    const rows = clamp(parseInt(selRows.value, 10) || 3, 1, 5);
    const cols = clamp(parseInt(selCols.value, 10) || 5, 1, 8);
    const lost = (p.keys || []).filter(k => k && k.index >= rows * cols && (k.title || k.actionId || k.icon)).length;
    p.rows = rows;
    p.cols = cols;
    normalizeKeys(p);
    if (state.selected !== null && state.selected >= rows * cols) state.selected = null;
    if (lost) toast(`${lost} tecla(s) fora da nova grade foram removidas.`, { type: 'warning' });
    markDirty();
    renderAll();
}
selRows.addEventListener('change', onGridChange);
selCols.addEventListener('change', onGridChange);
chkHud.addEventListener('change', () => {
    const p = editingProfile();
    if (!isEditable(p)) { chkHud.checked = p ? p.showHardwareHud !== false : true; return; }
    p.showHardwareHud = chkHud.checked;
    markDirty();
});

// --------------------------------------------------------------------------
// Salvamento automático
// --------------------------------------------------------------------------
function stripLive(key) {
    const k = { ...key };
    delete k.active;
    return k;
}

function stripProfile(p) {
    const out = { ...p };
    delete out.builtin;
    return out;
}

function setSaveState(s) {
    state.saveState = s;
    saveStateEl.dataset.state = s;
    saveStateEl.textContent = { idle: '', dirty: 'Alterações pendentes', saving: 'Salvando…', saved: 'Salvo', error: 'Erro ao salvar — tentar de novo', readonly: 'Somente leitura' }[s] || '';
}

function markDirty() {
    const p = editingProfile();
    if (!isEditable(p)) return;
    state.dirty = true;
    setSaveState('dirty');
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => { state.saveTimer = null; saveNow(); }, AUTOSAVE_MS);
}

function cancelAutosave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = null;
    state.dirty = false;
}

async function saveNow() {
    const p = editingProfile();
    if (!isEditable(p) || !state.dirty) return;
    if (state.saving) { markDirty(); return; }
    state.saving = true;
    state.dirty = false;
    setSaveState('saving');
    const body = stripProfile(p);
    body.keys = (body.keys || []).map(stripLive);
    const res = await apiJson(`/api/presets/${encodeURIComponent(p.id)}`, 'POST', body);
    state.saving = false;
    if (!res.ok) {
        state.dirty = true;
        setSaveState('error');
        toast((res.data && res.data.error) || `Falha ao salvar “${p.name}” (${res.status || 'sem conexão'}).`, { type: 'error' });
        return;
    }
    if (state.dirty) { markDirty(); return; } // alterações feitas durante o POST
    setSaveState('saved');
}

async function flushAutosave() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    if (state.dirty) await saveNow();
}

saveStateEl.addEventListener('click', () => { if (state.saveState === 'error') saveNow(); });
window.addEventListener('beforeunload', (e) => {
    if (state.dirty || state.saving) {
        // Último esforço: envia o perfil com keepalive
        const p = editingProfile();
        if (isEditable(p)) {
            try {
                fetch(`/api/presets/${encodeURIComponent(p.id)}`, {
                    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...stripProfile(p), keys: (p.keys || []).map(stripLive) })
                });
            } catch (err) { /* ignore */ }
        }
        e.preventDefault();
        e.returnValue = '';
    }
});

// --------------------------------------------------------------------------
// Catálogo de ações
// --------------------------------------------------------------------------
function buildActionIndex() {
    state.actionById.clear();
    for (const g of state.catalog.groups || []) {
        for (const a of g.actions || []) state.actionById.set(a.id, { ...a, groupId: g.id, groupLabel: g.label, groupIcon: g.icon });
    }
}

function volumeApps() {
    const apps = new Map();
    const g = (state.catalog.groups || []).find(x => x.id === 'volume');
    for (const a of (g && g.actions) || []) {
        const m = /^vol_slider:([^:]+)$/.exec(a.id);
        if (m) apps.set(m[1], a.label.replace(/^Fader\s+/i, ''));
    }
    if (!apps.size) apps.set('master', 'Master PC');
    if (!apps.has('fans')) apps.set('fans', 'Ventoinhas (CoolerControl)');
    return apps;
}

/** Ícone de uma ação do catálogo: do conjunto embutido ou URL própria (apps instalados, plugins). */
function actionIconUrl(a) {
    if (!a) return null;
    if (a.iconData) return a.iconData;
    if (a.iconUrl) return a.iconUrl;
    return state.icons[a.icon] || null;
}

/** Descreve uma ação mesmo quando parametrizada e ausente do catálogo. */
function describeAction(actionId) {
    if (!actionId) return null;
    const known = state.actionById.get(actionId);
    if (known) return known;
    let m;
    if ((m = /^launch:app:(.+)$/.exec(actionId))) {
        return { id: actionId, label: m[1], icon: 'open', kind: 'action', groupId: 'apps', groupLabel: 'Abrir aplicativo', hint: 'Aplicativo não encontrado neste PC' };
    }
    if ((m = /^switch:(.+)$/.exec(actionId))) {
        const p = profileOf(m[1]);
        return { id: actionId, label: p ? p.name : m[1], icon: PROFILE_ICON_BY_ID[m[1]] || 'grid', kind: 'action', groupId: 'navigation', groupLabel: 'Trocar de tela' };
    }
    if ((m = /^vol_slider:(.+)$/.exec(actionId))) {
        return { id: actionId, label: `Fader ${volumeApps().get(m[1]) || m[1]}`, icon: 'volume', kind: 'slider', groupId: 'volume', groupLabel: 'Volume por app' };
    }
    if ((m = /^spotify:play:(.*)$/.exec(actionId))) {
        const uri = m[1];
        const t = /^spotify:([a-z]+):/.exec(uri);
        const kind = { playlist: 'Playlist', album: 'Álbum', artist: 'Artista', track: 'Faixa', show: 'Podcast', episode: 'Episódio' }[t ? t[1] : ''] || 'Playlist';
        return { id: actionId, label: uri ? `Tocar ${kind.toLowerCase()}` : 'Tocar playlist / álbum', icon: 'playlist', kind: 'action', groupId: 'spotify', groupLabel: 'Spotify', hint: uri ? uri : 'Cole o link do Spotify no campo abaixo' };
    }
    if ((m = /^vol_step:([^:]+):([+-]\d+)$/.exec(actionId))) {
        const sign = m[2].startsWith('-') ? '−' : '+';
        return { id: actionId, label: `${volumeApps().get(m[1]) || m[1]} ${sign}${m[2].slice(1)}%`, icon: m[2].startsWith('-') ? 'vol_down' : 'vol_up', kind: 'action', groupId: 'volume', groupLabel: 'Volume por app' };
    }
    return { id: actionId, label: actionId, icon: 'grid', kind: 'action', groupId: 'other', groupLabel: 'Ação' };
}

const actionGroupsEl = $('action-groups');
const actionSearch = $('action-search');

function renderActions() {
    const q = actionSearch.value.trim().toLowerCase();
    actionGroupsEl.textContent = '';
    let shown = 0;
    const groups = state.catalog.groups || [];
    for (const g of groups) {
        // Painel abre com tudo recolhido; só expande o que o usuário abrir (a busca expande temporariamente)
        if (!state.seenGroups.has(g.id)) { state.seenGroups.add(g.id); state.collapsed.add(g.id); }
    }
    $('btn-collapse-all').textContent = groups.length && groups.every(g => state.collapsed.has(g.id)) ? 'Expandir tudo' : 'Recolher tudo';
    for (const g of groups) {
        const actions = (g.actions || []).filter(a => !q || `${a.label} ${a.id} ${a.hint || ''} ${g.label}`.toLowerCase().includes(q));
        if (!actions.length) continue;
        shown += actions.length;
        const expanded = q ? true : !state.collapsed.has(g.id);
        const head = h('button', {
            type: 'button', class: 'agroup-head', 'aria-expanded': expanded ? 'true' : 'false', 'aria-controls': `agroup-${g.id}`,
            onclick: () => {
                if (state.collapsed.has(g.id)) state.collapsed.delete(g.id); else state.collapsed.add(g.id);
                renderActions();
            }
        },
            (g.iconData || state.icons[g.icon]) ? h('img', { class: 'agroup-icon', src: g.iconData || state.icons[g.icon], alt: '' }) : svgIcon('i-grid'),
            h('span', { text: g.label }),
            h('span', { class: 'agroup-count', text: String(actions.length) }),
            svgIcon('i-chevron', 'ico agroup-chev')
        );
        const body = h('div', { class: 'agroup-body', id: `agroup-${g.id}` });
        for (const a of actions) body.appendChild(renderActionItem(a, g));
        actionGroupsEl.appendChild(h('div', { class: 'agroup' }, head, body));
    }
    if (!shown) actionGroupsEl.appendChild(h('div', { class: 'actions-empty', text: q ? `Nenhuma ação para “${actionSearch.value.trim()}”.` : 'Nenhuma ação disponível.' }));
}

function renderActionItem(a, g) {
    const iconUrl = actionIconUrl(a);
    const item = h('div', {
        class: 'aitem' + (state.armed && state.armed.id === a.id ? ' is-armed' : ''),
        role: 'button', tabindex: '0', dataset: { actionId: a.id },
        'aria-label': `${a.label} (${g.label})${a.hint ? '. ' + a.hint : ''}`,
        'aria-pressed': state.armed && state.armed.id === a.id ? 'true' : 'false'
    },
        h('span', { class: 'aitem-icon' }, iconUrl ? h('img', { src: iconUrl, alt: '' }) : svgIcon('i-bolt')),
        h('span', { class: 'aitem-label', text: a.label }),
        a.kind === 'indicator' ? h('span', { class: 'aitem-kind kind-indicator', text: 'info', title: 'Indicador: só mostra estado' }) : null,
        a.kind === 'slider' ? h('span', { class: 'aitem-kind kind-slider', text: 'fader' }) : null,
        a.hint ? h('span', { class: 'aitem-hint', tabindex: '0', 'data-tip': a.hint, 'aria-label': `Dica: ${a.hint}` }, svgIcon('i-info')) : null
    );

    item.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.aitem-hint')) return;
        beginPointerDrag(e, item, { type: 'action', action: a, label: a.label, iconUrl: actionIconUrl(a) });
    });
    item.addEventListener('click', (e) => {
        if (e.target.closest('.aitem-hint')) return;
        if (pointerDragJustEnded()) return;
        if (state.armed && state.armed.id === a.id) disarm();
        else arm(a);
    });
    item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (state.selected !== null && isEditable(editingProfile())) { assignAction(state.selected, a); toast(`“${a.label}” atribuída à tecla ${state.selected + 1}.`, { type: 'success', duration: 1800 }); }
            else if (state.armed && state.armed.id === a.id) disarm();
            else arm(a);
        }
    });
    return item;
}

actionSearch.addEventListener('input', renderActions);
$('btn-collapse-all').addEventListener('click', () => {
    const all = (state.catalog.groups || []).map(g => g.id);
    const allCollapsed = all.every(id => state.collapsed.has(id));
    state.collapsed = allCollapsed ? new Set() : new Set(all);
    renderActions();
});

// Atribuição por toque: tocar na ação, depois na tecla
const armedBar = $('armed-bar');
const armedText = $('armed-text');

function arm(action) {
    if (!isEditable(editingProfile())) { toast('Perfil embutido: duplique para editar.', { type: 'warning' }); return; }
    state.armed = action;
    document.body.classList.add('is-armed');
    armedText.textContent = '';
    armedText.append('Toque numa tecla para colocar ', h('strong', { text: `“${action.label}”` }));
    if (state.selected !== null) {
        armedText.append(' ', h('button', { type: 'button', class: 'link-btn', onclick: () => { assignAction(state.selected, action); disarm(); } }, `ou use a tecla ${state.selected + 1}`));
    }
    setHidden(armedBar, false);
    renderActions();
}

function disarm() {
    if (!state.armed) return;
    state.armed = null;
    document.body.classList.remove('is-armed');
    setHidden(armedBar, true);
    renderActions();
}
$('armed-cancel').addEventListener('click', disarm);

// --------------------------------------------------------------------------
// Arrastar por ponteiro (ação -> tecla, tecla -> tecla)
// O drag and drop nativo do navegador falha em Wayland e no toque; isto usa Pointer Events:
// mouse arrasta ao mover 6px; toque/caneta arrasta depois de segurar 250 ms (para não roubar a rolagem).
// --------------------------------------------------------------------------
const PDRAG_THRESHOLD_PX = 6;
const PDRAG_HOLD_MS = 250;
let pdrag = null;           // { payload, source, startX, startY, active, pointerId, ghost, over, holdTimer }
let pdragEndedAt = 0;

function pointerDragJustEnded() {
    return Date.now() - pdragEndedAt < 400;
}

function beginPointerDrag(e, source, payload) {
    if (pdrag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!isEditable(editingProfile())) return; // o clique ainda avisa "duplique para editar"
    pdrag = { payload, source, startX: e.clientX, startY: e.clientY, active: false, pointerId: e.pointerId, ghost: null, over: null, holdTimer: null, touch: e.pointerType !== 'mouse' };
    if (pdrag.touch) {
        // segurar para arrastar; mover antes disso é rolagem
        pdrag.holdTimer = setTimeout(() => { if (pdrag && !pdrag.active) activatePointerDrag(e.clientX, e.clientY); }, PDRAG_HOLD_MS);
    }
    window.addEventListener('pointermove', onPointerDragMove, { passive: false });
    window.addEventListener('pointerup', onPointerDragEnd);
    window.addEventListener('pointercancel', onPointerDragCancel);
    window.addEventListener('keydown', onPointerDragKey);
}

function activatePointerDrag(x, y) {
    if (!pdrag || pdrag.active) return;
    pdrag.active = true;
    disarm();
    try { pdrag.source.setPointerCapture(pdrag.pointerId); } catch (err) { /* ignore */ }
    pdrag.source.classList.add('is-dragging');
    document.body.classList.add('is-pdrag');
    const ghost = h('div', { class: 'pdrag-ghost', 'aria-hidden': 'true' },
        pdrag.payload.iconUrl ? h('img', { src: pdrag.payload.iconUrl, alt: '' }) : svgIcon('i-bolt'),
        h('span', { text: pdrag.payload.label || '' })
    );
    document.body.appendChild(ghost);
    pdrag.ghost = ghost;
    movePointerGhost(x, y);
}

function movePointerGhost(x, y) {
    if (!pdrag || !pdrag.ghost) return;
    pdrag.ghost.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 10)}px)`;
    const el = document.elementFromPoint(x, y);
    const key = el ? el.closest('.mkey') : null;
    const target = key && deviceGrid.contains(key) ? key : null;
    if (pdrag.over !== target) {
        if (pdrag.over) pdrag.over.classList.remove('is-drop');
        if (target && !(pdrag.payload.type === 'key' && Number(target.dataset.index) === pdrag.payload.from)) target.classList.add('is-drop');
        pdrag.over = target;
    }
}

function onPointerDragMove(e) {
    if (!pdrag || e.pointerId !== pdrag.pointerId) return;
    const dx = Math.abs(e.clientX - pdrag.startX);
    const dy = Math.abs(e.clientY - pdrag.startY);
    if (!pdrag.active) {
        if (Math.max(dx, dy) < PDRAG_THRESHOLD_PX) return;
        if (pdrag.touch) { cleanupPointerDrag(); return; } // toque: mover antes de segurar é rolagem
        activatePointerDrag(e.clientX, e.clientY);
    }
    e.preventDefault();
    movePointerGhost(e.clientX, e.clientY);
}

function onPointerDragEnd(e) {
    if (!pdrag || e.pointerId !== pdrag.pointerId) return;
    const wasActive = pdrag.active;
    const payload = pdrag.payload;
    const target = pdrag.over;
    cleanupPointerDrag();
    if (!wasActive) return;
    pdragEndedAt = Date.now();
    if (!target) return;
    const index = Number(target.dataset.index);
    if (Number.isNaN(index)) return;
    if (payload.type === 'action') {
        assignAction(index, payload.action);
        selectKey(index);
        toast(`“${payload.action.label}” atribuída à tecla ${index + 1}.`, { type: 'success', duration: 1800 });
    } else if (payload.type === 'key' && payload.from !== index) {
        swapKeys(payload.from, index);
        selectKey(index);
    }
}

function onPointerDragCancel(e) {
    if (!pdrag || e.pointerId !== pdrag.pointerId) return;
    if (pdrag.active) pdragEndedAt = Date.now();
    cleanupPointerDrag();
}

function onPointerDragKey(e) {
    if (e.key === 'Escape' && pdrag) { if (pdrag.active) pdragEndedAt = Date.now(); cleanupPointerDrag(); }
}

function cleanupPointerDrag() {
    if (!pdrag) return;
    if (pdrag.holdTimer) clearTimeout(pdrag.holdTimer);
    if (pdrag.over) pdrag.over.classList.remove('is-drop');
    if (pdrag.ghost) pdrag.ghost.remove();
    pdrag.source.classList.remove('is-dragging');
    try { pdrag.source.releasePointerCapture(pdrag.pointerId); } catch (err) { /* ignore */ }
    document.body.classList.remove('is-pdrag');
    window.removeEventListener('pointermove', onPointerDragMove);
    window.removeEventListener('pointerup', onPointerDragEnd);
    window.removeEventListener('pointercancel', onPointerDragCancel);
    window.removeEventListener('keydown', onPointerDragKey);
    pdrag = null;
}

// --------------------------------------------------------------------------
// Aparelho: grade de teclas
// --------------------------------------------------------------------------
const deviceWrap = $('device-wrap');
const deviceGrid = $('device-grid');
const KEY_GAP = 14;
const SHELL_PAD = 22 * 2 + 10 * 2 + 4; // moldura + bisel + bordas

function fitKeys() {
    const p = editingProfile();
    if (!p) return;
    const w = deviceWrap.clientWidth - SHELL_PAD - 8;
    const hgt = deviceWrap.clientHeight - SHELL_PAD - 16;
    const size = Math.floor(Math.min((w - KEY_GAP * (p.cols - 1)) / p.cols, (hgt - KEY_GAP * (p.rows - 1)) / p.rows));
    deviceGrid.style.setProperty('--key-size', `${clamp(size, 52, 168)}px`);
    deviceGrid.style.setProperty('--cols', String(p.cols));
}
new ResizeObserver(() => fitKeys()).observe(deviceWrap);

function isMutedKey(k) {
    return k.bgColor === '#DC2626' || k.badge === 'MUDO' || k.badge === 'MUTADO' || !!(k.title && k.title.toUpperCase().includes('MUTADO'));
}
/** Escala de fonte do bloco de telemetria: número (0.5 a 2.5); 's'/'l' são o formato antigo. */
function statFontScale(k) {
    const v = k && k.statFont;
    if (v === 's') return 0.8;
    if (v === 'l') return 1.25;
    const n = Number(v);
    return n > 0 ? Math.min(2.5, Math.max(0.5, n)) : 1;
}
function isSliderKey(k) { return !!(k.isSlider || (k.actionId && (k.actionId.startsWith('vol_slider:') || k.actionId === 'spotify:mixer'))); }
function isWideKey(k) { return !!k && isSliderKey(k) && (k.sliderDir === 'h' || k.actionId === 'spotify:mixer'); }
/** Tamanho da tecla em células {cols, rows}, limitado à grade. `tall` (legado) = fader de 1x2. */
function spanOf(k, p = editingProfile()) {
    if (!k || !p) return { cols: 1, rows: 1 };
    let c = Math.max(1, parseInt(k.colSpan, 10) || 1);
    let r = Math.max(1, parseInt(k.rowSpan, 10) || (k.tall && isSliderKey(k) ? 2 : 1));
    const col = k.index % p.cols, row = Math.floor(k.index / p.cols);
    return { cols: Math.min(c, p.cols - col), rows: Math.min(r, p.rows - row) };
}
/** Fader alto e estreito: 1 coluna por 2+ linhas. */
function isTallKey(k, p = editingProfile()) {
    if (!k || !isSliderKey(k) || isWideKey(k)) return false;
    const sp = spanOf(k, p);
    return sp.rows > 1 && sp.cols === 1;
}
/** Células que uma tecla em `index` com tamanho cols x rows cobriria (sem a própria). */
function cellsCovered(index, cols, rows, p) {
    const out = [];
    const col = index % p.cols, row = Math.floor(index / p.cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (!r && !c) continue;
        out.push((row + r) * p.cols + col + c);
    }
    return out;
}
/** A tecla cabe com esse tamanho? (dentro da grade e só sobre células vazias) */
function canSpan(k, cols, rows, p = editingProfile(), index = k && k.index) {
    if (!k || !p) return false;
    const col = index % p.cols, row = Math.floor(index / p.cols);
    if (col + cols > p.cols || row + rows > p.rows) return false;
    const covered = cellsCovered(index, cols, rows, p);
    return covered.every((i) => { const bk = p.keys && p.keys.find(x => x && x.index === i); return !bk || isEmptyKey(bk); });
}
/** Maior tamanho possível a partir da célula (para montar as opções do inspetor). */
function maxSpanAt(index, p = editingProfile()) {
    if (!p) return { cols: 1, rows: 1 };
    return { cols: p.cols - (index % p.cols), rows: p.rows - Math.floor(index / p.cols) };
}
/** Índices escondidos por teclas maiores. */
function coveredIndexes(p = editingProfile()) {
    const covered = new Set();
    if (!p || !p.keys) return covered;
    for (const k of p.keys) {
        const sp = spanOf(k, p);
        if (sp.cols === 1 && sp.rows === 1) continue;
        for (const i of cellsCovered(k.index, sp.cols, sp.rows, p)) covered.add(i);
    }
    return covered;
}
function isEmptyKey(k) { return !(k.title || k.actionId || k.icon || k.badge); }
function isStatKey(k) { return !!(k && ((k.actionId && (k.actionId.startsWith('stats:') || k.actionId.startsWith('ai:'))) || k.statValue !== undefined || k.statBig !== undefined || k.statMode === 'media' || k.statMode === 'meters' || k.actionId === 'spotify:now_playing' || k.actionId === 'player:now_playing' || k.actionId === 'player:panel' || k.actionId === 'discord:voice_room')); }
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
    const kind = cfg.statChart === 'line' || cfg.statChart === 'bars' ? cfg.statChart : 'area';
    if (kind === 'bars') {
        const bars = (hist, color, opacity) => {
            const n = hist.length;
            if (!n) return '';
            const step = W / N;
            const bw = Math.max(0.6, step * 0.7);
            return hist.map((v, i) => {
                const bh = Math.min(H, Math.max(0, (v - min) / span) * H);
                return `<rect x="${(W - (n - i) * step + (step - bw) / 2).toFixed(2)}" y="${(H - bh).toFixed(2)}" width="${bw.toFixed(2)}" height="${Math.max(0.5, bh).toFixed(2)}" fill="${color}" fill-opacity="${opacity}"/>`;
            }).join('');
        };
        return out + bars(h1, c1, h2.length ? 0.9 : 1) + bars(h2, c2, 0.75) + '</svg>';
    }
    const l1 = line(h1);
    if (l1) out += (kind === 'area' ? `<polygon points="${l1.xStart},${H} ${l1.pts} ${W},${H}" fill="${c1}" fill-opacity="0.28"/>` : '') + `<polyline points="${l1.pts}" fill="none" stroke="${c1}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
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
    if (cfg.statSwap && cfg.statBig !== undefined && cfg.statBig !== null && cfg.statHead) cfg = { ...cfg, statBig: cfg.statHead, statHead: cfg.statBig };
    if (mode === 'media') {
        const pct = Math.max(0, Math.min(100, Number(cfg.statPercent) || 0));
        return `<div class="${prefix}-cover">${cfg.statImage ? `<img src="${escHtml(cfg.statImage)}" alt="">` : ''}</div><div class="${prefix}-media-shade"></div>` +
            `<div class="${prefix}-head"><span class="${prefix}-label">${escHtml(cfg.statLabel || 'Spotify')}</span><span class="${prefix}-headval">${escHtml(cfg.statHead || '')}</span></div>` +
            `<div class="${prefix}-media-spacer"></div><div class="${prefix}-media-title">${escHtml(cfg.statBig || '')}</div><div class="${prefix}-media-artist">${escHtml(cfg.statSub || '')}</div>` +
            `<div class="${prefix}-bar"><i style="width:${pct}%;background:${escHtml(color || '#1DB954')}"></i></div>` +
            (cfg.panel || cfg.actionId === 'player:panel'
                ? `<div class="${prefix}-panel">` + ['seek_back', cfg.panelPlaying ? 'pause' : 'play', 'seek_fwd', cfg.panelMuted ? 'volume_mute' : 'volume'].map(n => `<span class="${prefix}-panel-btn${n === 'play' || n === 'pause' ? ' is-main' : ''}">${state.icons && state.icons[n] ? `<img src="${escHtml(state.icons[n])}" alt="">` : ''}</span>`).join('') + '</div>'
                : '');
    }
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
    if ((mode === 'graph' || mode === 'dual') && cfg.statChart !== 'none') html += `<div class="${prefix}-chart">${statChartSvg(cfg, prefix)}</div>`;
    else if (mode === 'cores') html += `<div class="${prefix}-chart ${prefix}-chart-tall">${statBarsSvg(cfg, prefix)}</div>`;
    else if (cfg.statPercent !== undefined && cfg.statPercent !== null) html += `<div class="${prefix}-bar"><i style="width:${Math.max(0, Math.min(100, Number(cfg.statPercent) || 0))}%;background:${escHtml(color)}"></i></div>`;
    return html;
}


/** Tecla como exibida: definição + estado vivo (só quando o perfil em edição é o ativo). */
function displayKey(index) {
    const p = editingProfile();
    const def = (p && p.keys && p.keys.find(k => k && k.index === index)) || { index, title: '' };
    if (p && p.id === state.current && state.liveKeys[index]) return { ...def, ...state.liveKeys[index] };
    return def;
}

function buildKeyNode(k, { preview = false } = {}) {
    const muted = isMutedKey(k);
    const empty = isEmptyKey(k);
    const tall = !preview && isTallKey(k);
    const el = h('div', {
        class: 'mkey' + (empty ? ' is-empty' : '') + (k.active && !preview ? ' is-live-active' : '') + (muted ? ' is-muted' : '') + (tall ? ' is-tall' : '') + (isWideKey(k) ? ' is-wide' : '') + (k.actionId === 'spotify:mixer' ? ' is-mixer' : '') + (k.imageFill && k.icon ? ' is-image-fill' : ''),
        role: preview ? 'img' : 'gridcell',
        'aria-label': preview ? 'Pré-visualização da tecla' : `Tecla ${k.index + 1}${k.title ? ': ' + k.title : ' (vazia)'}`
    });
    if (!muted) {
        if (k.bgColor) el.style.backgroundColor = k.bgColor;
        if (k.borderColor) el.style.borderColor = k.borderColor;
    }
    if (Number(k.iconScale) && Number(k.iconScale) !== 1) el.style.setProperty('--icon-scale', String(Number(k.iconScale)));
    if (isSliderKey(k)) {
        const val = k.sliderValue !== undefined ? k.sliderValue : 80;
        const wide = isWideKey(k);
        const fill = h('div', { class: 'mkey-fill', style: wide ? `width:${clamp(val, 0, 100)}%` : `height:${clamp(val, 0, 100)}%` });
        el.appendChild(wide ? h('div', { class: 'mkey-track is-h' }, fill) : (tall ? h('div', { class: 'mkey-track' }, fill) : fill));
        if ((k.sliderApp || (k.actionId || '').replace('vol_slider:', '')) === 'fans') el.appendChild(h('span', { class: 'mkey-auto-pill' + (k.autoMode ? ' is-on' : ''), text: 'AUTO' }));
    }
    if (isStatKey(k)) {
        el.classList.add('is-stat');
        const media = k.statMode === 'media' || k.actionId === 'spotify:now_playing' || k.actionId === 'player:now_playing';
        const ai = !k.statMode && k.actionId && k.actionId.startsWith('ai:');
        if (!k.statMode && k.actionId === 'discord:voice_room' && k.statRows === undefined) {
            k = { ...k, statMode: 'meters', statLabel: 'Sala de voz', statHead: '3 na sala', statRows: [{ k: 'Você', sub: 'falando', v: '', pct: 100, color: '#22C55E' }, { k: 'Fulano', sub: '', v: '', pct: 0, color: '#374151' }, { k: 'Beltrano', sub: 'mudo', v: '', pct: 0, color: '#374151' }] };
        }
        if (ai && k.statBig === undefined && k.statRows === undefined) {
            const lbl = k.actionId.startsWith('ai:codex') ? 'Codex' : 'Claude';
            k = /_/.test(k.actionId) ? { ...k, statMode: 'bar', statLabel: lbl, statHead: '', statBig: '--', statSub: 'ao vivo no tablet', statPercent: 30 } : { ...k, statMode: 'meters', statLabel: lbl, statHead: '', statRows: [{ k: '5 h', v: '--', sub: 'ao vivo no tablet', pct: 30 }, { k: 'semana', v: '--', sub: '', pct: 50 }] };
        }
        const box = h('div', { class: `mkey-stat mode-${k.statMode || (media ? 'media' : 'bar')}${k.statImage ? ' has-cover' : ''}` });
        if (statFontScale(k) !== 1) box.style.setProperty('--stat-font', String(statFontScale(k)));
        const cfg = k.statBig === undefined && k.statValue === undefined
            ? (media ? { ...k, statMode: 'media', statHead: '', statBig: 'Tocando agora', statSub: 'ao vivo no tablet', statPercent: 35 } : { ...k, statHead: '', statBig: '--', statSub: 'ao vivo no tablet' })
            : k;
        box.innerHTML = statInnerHtml(cfg, 'mkey-stat');
        if (k.titleColor && !muted) { box.style.color = k.titleColor; box.classList.add('has-text-color'); }
        el.appendChild(box);
        el.appendChild(h('span', { class: 'mkey-num', text: String(k.index + 1) }));
        return el;
    }
    el.appendChild(h('span', { class: 'mkey-num', text: String(k.index + 1) }));
    if (k.actionId === 'spotify:transport' || k.actionId === 'player:transport' || k.actionId === 'spotify:mixer') {
        el.classList.add('is-transport');
        const bar = h('div', { class: 'mkey-transport' });
        for (const name of ['prev', k.transportPlaying ? 'pause' : 'play', 'next']) {
            const b = h('span', { class: 'mkey-transport-btn' + (name === 'play' || name === 'pause' ? ' is-main' : '') });
            if (state.icons[name]) b.appendChild(h('img', { src: state.icons[name], alt: '' }));
            bar.appendChild(b);
        }
        el.appendChild(bar);
    }
    if (k.badge) {
        const b = h('span', { class: 'mkey-badge' + (k.badgeColor && !muted ? ' has-color' : ''), text: k.badge });
        if (k.badgeColor && !muted) b.style.backgroundColor = k.badgeColor;
        el.appendChild(b);
    }
    if (k.icon) el.appendChild(h('img', { class: 'mkey-icon', src: k.icon, alt: '', draggable: 'false' }));
    const title = h('span', { class: 'mkey-title', text: k.title || '' });
    if (k.titleColor && !muted) title.style.color = k.titleColor;
    el.appendChild(title);
    return el;
}

function renderGrid() {
    const p = editingProfile();
    deviceGrid.textContent = '';
    if (!p) return;
    const editable = isEditable(p);
    deviceGrid.setAttribute('aria-rowcount', String(p.rows));
    deviceGrid.setAttribute('aria-colcount', String(p.cols));
    const covered = coveredIndexes(p);
    for (let i = 0; i < p.rows * p.cols; i++) {
        if (covered.has(i)) continue; // célula de baixo de um fader alto
        const k = displayKey(i);
        const el = buildKeyNode(k);
        el.dataset.index = String(i);
        const sp = spanOf(k, p);
        el.style.gridColumn = `${(i % p.cols) + 1} / span ${sp.cols}`;
        el.style.gridRow = `${Math.floor(i / p.cols) + 1} / span ${sp.rows}`;
        if (sp.cols > 1 || sp.rows > 1) {
            el.classList.add('is-span');
            if (!isTallKey(k, p)) el.style.width = `calc(var(--key-size) * ${sp.cols} + var(--key-gap) * ${sp.cols - 1})`;
            el.style.height = `calc(var(--key-size) * ${sp.rows} + var(--key-gap) * ${sp.rows - 1})`;
        }
        el.tabIndex = (state.selected === i || (state.selected === null && i === 0)) ? 0 : -1;
        if (state.selected === i) el.classList.add('is-selected');
        if (editable && !isEmptyKey(k)) {
            el.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.mkey-clear')) return;
                beginPointerDrag(e, el, { type: 'key', from: i, label: k.title || `Tecla ${i + 1}`, iconUrl: k.icon || null });
            });
        }

        if (editable && !isEmptyKey(k)) {
            el.appendChild(h('button', {
                type: 'button', class: 'mkey-clear', 'aria-label': `Limpar tecla ${i + 1}`, tabindex: '-1',
                onclick: (e) => { e.stopPropagation(); clearKey(i); }
            }, svgIcon('i-close')));
        }

        el.addEventListener('click', () => {
            if (pointerDragJustEnded()) return;
            if (state.armed) {
                if (!editable) { toast('Perfil embutido: duplique para editar.', { type: 'warning' }); return; }
                assignAction(i, state.armed);
                toast(`“${state.armed.label}” atribuída à tecla ${i + 1}.`, { type: 'success', duration: 1800 });
                disarm();
            }
            selectKey(i);
        });
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!editable) return;
            if (!isEmptyKey(k)) clearKey(i);
            selectKey(i);
        });

        deviceGrid.appendChild(el);
    }
    fitKeys();
}


function selectKey(index) {
    state.selected = index;
    inspectorCollapsed = false;
    renderGrid();
    renderInspector();
    const el = deviceGrid.querySelector(`.mkey[data-index="${index}"]`);
    if (el && document.activeElement !== el && !document.activeElement.closest('.inspector')) el.focus({ preventScroll: true });
}

function keyRef(index) {
    const p = editingProfile();
    if (!p) return null;
    normalizeKeys(p);
    return p.keys[index];
}

function touchKey(index) {
    delete state.liveKeys[index];
    markDirty();
}

function assignAction(index, action) {
    const k = keyRef(index);
    if (!k || !action) return;
    if (k.actionId !== action.id) delete k.settings; // settings de plugin pertencem à ação anterior
    k.actionId = action.id;
    if (action.id.startsWith('plugin:')) {
        // Tecla de plugin: imagem do estado 0 ocupando a tecla inteira; o plugin pode redesenhar depois
        k.icon = action.keyIcon || action.iconData || k.icon;
        k.imageFill = true;
        if (k.title === undefined) k.title = '';
    } else {
        delete k.imageFill;
        if (!k.title) k.title = action.label;
    }
    if (!k.icon && action.iconData) k.icon = action.iconData;
    else if (!k.icon && action.iconUrl) {
        // Ícone servido por URL (apps instalados): grava como data URL para a tecla ficar autossuficiente
        const target = index;
        apiFetch(`${action.iconUrl}.json`).then((r) => {
            if (!r.ok || !r.data || !r.data.icon) return;
            const kk = keyRef(target);
            if (kk && kk.actionId === action.id && !kk.icon) { kk.icon = r.data.icon; touchKey(target); renderGrid(); renderInspector(); }
        });
    }
    else if (!k.icon && action.icon && state.icons[action.icon]) k.icon = state.icons[action.icon];
    // Tamanho padrão sugerido pela ação (ex.: controles do Spotify em 2 colunas), se couber
    if (action.defaultSpan && !k.colSpan && !k.rowSpan) {
        const { cols = 1, rows = 1 } = action.defaultSpan;
        if ((cols > 1 || rows > 1) && canSpan(k, cols, rows, editingProfile(), index)) { if (cols > 1) k.colSpan = cols; if (rows > 1) k.rowSpan = rows; }
    }
    if (action.kind === 'slider' || action.id.startsWith('vol_slider:')) {
        k.isSlider = true;
        k.sliderApp = action.id.replace('vol_slider:', '');
        if (k.sliderValue === undefined) k.sliderValue = 80;
    } else {
        delete k.isSlider; delete k.sliderApp; delete k.sliderValue; delete k.tall;
    }
    touchKey(index);
    renderGrid();
    renderInspector();
}

function clearKey(index) {
    const p = editingProfile();
    if (!isEditable(p)) return;
    normalizeKeys(p);
    p.keys[index] = { index, title: '' };
    touchKey(index);
    renderGrid();
    renderInspector();
}

function swapKeys(a, b) {
    const p = editingProfile();
    if (!isEditable(p)) return;
    normalizeKeys(p);
    const ka = { ...p.keys[a], index: b };
    const kb = { ...p.keys[b], index: a };
    p.keys[b] = ka;
    p.keys[a] = kb;
    // Tamanho maior só continua se couber na nova posição sobre células vazias
    for (const k of [ka, kb]) {
        const c = Math.max(1, parseInt(k.colSpan, 10) || 1), r = Math.max(1, parseInt(k.rowSpan, 10) || (k.tall ? 2 : 1));
        if ((c > 1 || r > 1) && !canSpan(k, c, r, p)) { delete k.colSpan; delete k.rowSpan; delete k.tall; }
    }
    delete state.liveKeys[a]; delete state.liveKeys[b];
    markDirty();
    renderGrid();
}

// Teclado na grade: setas movem a seleção, Delete limpa, Enter edita, Esc desmarca
deviceGrid.addEventListener('keydown', (e) => {
    const p = editingProfile();
    if (!p) return;
    const cur = state.selected !== null ? state.selected : 0;
    const total = p.rows * p.cols;
    let next = null;
    switch (e.key) {
        case 'ArrowRight': next = (cur + 1) % total; break;
        case 'ArrowLeft': next = (cur - 1 + total) % total; break;
        case 'ArrowDown': next = cur + p.cols < total ? cur + p.cols : cur % p.cols; break;
        case 'ArrowUp': next = cur - p.cols >= 0 ? cur - p.cols : Math.min(total - 1, cur + p.cols * (p.rows - 1)); break;
        case 'Home': next = 0; break;
        case 'End': next = total - 1; break;
        case 'Delete': case 'Backspace':
            if (state.selected !== null) { e.preventDefault(); clearKey(state.selected); }
            return;
        case 'Enter':
            if (state.selected !== null) { e.preventDefault(); if (state.armed) { assignAction(state.selected, state.armed); disarm(); } else $('f-title').focus(); }
            return;
        case 'Escape':
            e.preventDefault();
            if (state.armed) disarm(); else { state.selected = null; renderGrid(); renderInspector(); deviceGrid.querySelector('.mkey') && deviceGrid.querySelector('.mkey').focus(); }
            return;
        default: return;
    }
    e.preventDefault();
    selectKey(next);
});

// --------------------------------------------------------------------------
// Inspetor
// --------------------------------------------------------------------------
const inspectorEmpty = $('inspector-empty');
const inspectorForm = $('inspector-form');
const readonlyBanner = $('readonly-banner');
const fTitle = $('f-title');
const fBadge = $('f-badge');
const fBg = $('f-bg');
const fBorder = $('f-border');
const fBadgeColor = $('f-badge-color');
const fTitleColor = $('f-title-color');
const fSwitchTarget = $('f-switch-target');
const fSpotifyUri = $('f-spotify-uri');
const fVolApp = $('f-vol-app');
const fVolStep = $('f-vol-step');
let inspectorSyncing = false;

function setColorInput(input, value, fallback) {
    input.value = value || fallback;
    input.classList.toggle('is-unset', !value);
}

let inspectorCollapsed = false;

function renderInspector() {
    const p = editingProfile();
    const editable = isEditable(p);
    setHidden(readonlyBanner, !p || editable);
    // Painel recolhido pelo X: some até a próxima tecla ser selecionada
    setHidden($('inspector'), inspectorCollapsed && state.selected === null);
    setHidden($('btn-close-inspector'), state.selected === null);
    if (!p || state.selected === null) {
        setHidden(inspectorEmpty, false);
        setHidden(inspectorForm, true);
        if (openPopover && openPopover.pop === iconPop) closePopover();
        return;
    }
    setHidden(inspectorEmpty, true);
    setHidden(inspectorForm, false);
    inspectorForm.classList.toggle('is-readonly', !editable);
    for (const el of inspectorForm.querySelectorAll('input, select, button')) {
        if (el.id === 'btn-test-key') continue;
        el.disabled = !editable;
    }

    const k = displayKey(state.selected);
    const def = keyRef(state.selected) || k;
    inspectorSyncing = true;
    $('insp-index').textContent = `Tecla ${state.selected + 1} · linha ${Math.floor(state.selected / p.cols) + 1}, coluna ${(state.selected % p.cols) + 1}`;
    const preview = $('insp-preview');
    preview.textContent = '';
    preview.appendChild(buildKeyNode(k, { preview: true }));

    if (document.activeElement !== fTitle) fTitle.value = def.title || '';
    if (document.activeElement !== fBadge) fBadge.value = def.badge || '';
    setColorInput(fBg, def.bgColor, '#15171E');
    setColorInput(fBorder, def.borderColor, '#262A36');
    setColorInput(fBadgeColor, def.badgeColor, '#4F8CFF');
    setColorInput(fTitleColor, def.titleColor, '#E6E8EF');

    // Ícone
    const thumb = $('f-icon-thumb');
    thumb.textContent = '';
    if (def.icon) {
        thumb.appendChild(h('img', { src: def.icon, alt: '' }));
        const name = Object.keys(state.icons).find(n => state.icons[n] === def.icon);
        $('f-icon-name').textContent = name || (/^\/media\//.test(def.icon) ? `Imagem própria (${def.icon.split('.').pop().toUpperCase()})` : 'Ícone personalizado');
    } else {
        thumb.appendChild(svgIcon('i-image'));
        $('f-icon-name').textContent = 'Sem ícone';
    }
    // Tamanho do ícone (não vale para imagem cheia de plugin nem para telemetria)
    const scaleRow = $('icon-scale-row');
    const showScale = !!def.icon && !def.imageFill && !isStatKey(def);
    setHidden(scaleRow, !showScale);
    // Imagem ocupando a tecla inteira (teclas de plugin já vêm assim; o usuário decide para as demais)
    const showFill = !!def.icon && !isStatKey(def) && !(def.actionId || '').startsWith('plugin:');
    setHidden($('icon-fill-row'), !showFill);
    if (showFill) $('f-icon-fill').checked = !!def.imageFill;
    if (showScale) {
        const pct = Math.round((Number(def.iconScale) || 1) * 100);
        $('f-icon-scale').value = String(Math.min(200, Math.max(50, pct)));
        $('f-icon-scale-out').textContent = `${pct}%`;
    }

    // Ação
    const a = describeAction(def.actionId);
    const box = $('action-box');
    const boxIcon = $('action-box-icon');
    boxIcon.textContent = '';
    box.classList.toggle('has-action', !!a);
    if (a) {
        boxIcon.appendChild(actionIconUrl(a) ? h('img', { src: actionIconUrl(a), alt: '' }) : svgIcon('i-bolt'));
        $('action-box-name').textContent = a.label;
        $('action-box-group').textContent = a.groupLabel + (a.kind === 'indicator' ? ' · indicador' : a.kind === 'slider' ? ' · fader' : '') + (a.hint ? ` · ${a.hint}` : '');
        setHidden($('btn-remove-action'), false);
    } else {
        boxIcon.appendChild(svgIcon('i-bolt'));
        $('action-box-name').textContent = 'Nenhuma ação';
        $('action-box-group').textContent = 'Arraste uma ação do painel, ou toque numa ação e depois nesta tecla.';
        setHidden($('btn-remove-action'), true);
    }

    // Parâmetros
    const isSwitch = !!(def.actionId && def.actionId.startsWith('switch:'));
    const isSlider = !!(def.actionId && def.actionId.startsWith('vol_slider:'));
    const stepMatch = def.actionId ? /^vol_step:([^:]+):([+-]\d+)$/.exec(def.actionId) : null;
    const isSpotifyUri = !!(def.actionId && def.actionId.startsWith('spotify:play:'));
    setHidden($('param-switch'), !isSwitch);
    setHidden($('param-spotify'), !isSpotifyUri);
    if (isSpotifyUri) {
        const uri = def.actionId.slice('spotify:play:'.length);
        const t = /^spotify:([a-z]+):([A-Za-z0-9]+)$/.exec(uri);
        fSpotifyUri.value = t ? `https://open.spotify.com/${t[1]}/${t[2]}` : uri;
        $('spotify-uri-hint').textContent = uri ? '' : 'Cole o link (botão Compartilhar → Copiar link, no Spotify).';
    }
    setHidden($('param-app'), !(isSlider || stepMatch));
    setHidden($('param-step'), !stepMatch);
    // Orientação do fader (o bloco Spotify "controles + volume" é sempre deitado)
    setHidden($('param-slider-dir'), !isSlider);
    if (isSlider) $('f-slider-dir').value = def.sliderDir === 'h' ? 'h' : 'v';
    // Telemetria: fonte, gráfico e destaque
    const statId = def.actionId || '';
    const hasChart = /^stats:(cpu|cpu_temp|gpu|gpu_temp|net|disk)$/.test(statId);
    const hasSwap = /^stats:(cpu|cpu_temp|gpu|gpu_temp|vram|ram|ram_free)$/.test(statId);
    const showStat = isStatKey(def) && def.statMode !== 'media' && !/^(spotify|player):/.test(statId);
    setHidden($('param-stat'), !showStat);
    if (showStat) {
        const fontPct = Math.round((statFontScale(def) - 1) * 100);
        $('f-stat-font').value = String(fontPct);
        $('f-stat-font-out').textContent = `${fontPct > 0 ? '+' : ''}${fontPct}%`;
        setHidden($('f-stat-chart'), !hasChart);
        $('f-stat-chart').value = ['line', 'bars', 'none'].includes(def.statChart) ? def.statChart : 'area';
        setHidden($('stat-swap-row'), !hasSwap);
        $('f-stat-swap').checked = !!def.statSwap;
    }
    // Tamanho da tecla (colunas x linhas)
    const spanNow = spanOf(def);
    const maxSp = maxSpanAt(def.index);
    setHidden($('param-span'), isEmptyKey(def));
    if (!isEmptyKey(def)) {
        const fill = (sel, current, max, other, isCols) => {
            sel.textContent = '';
            for (let n = 1; n <= max; n++) {
                const ok = n === current || canSpan(def, isCols ? n : other, isCols ? other : n);
                sel.appendChild(h('option', { value: String(n), text: String(n), disabled: ok ? null : true, title: ok ? '' : 'Precisa de teclas vazias para crescer' }));
            }
            sel.value = String(current);
        };
        fill($('f-col-span'), spanNow.cols, maxSp.cols, spanNow.rows, true);
        fill($('f-row-span'), spanNow.rows, maxSp.rows, spanNow.cols, false);
        $('span-hint').textContent = (spanNow.cols > 1 || spanNow.rows > 1) ? `Ocupa ${spanNow.cols * spanNow.rows} blocos` : '';
    }
    if (isSwitch) {
        fSwitchTarget.textContent = '';
        for (const item of state.list) fSwitchTarget.appendChild(h('option', { value: item.id, text: item.name || item.id }));
        const target = def.actionId.slice('switch:'.length);
        if (![...fSwitchTarget.options].some(o => o.value === target)) fSwitchTarget.appendChild(h('option', { value: target, text: `${target} (não encontrado)` }));
        fSwitchTarget.value = target;
    }
    if (isSlider || stepMatch) {
        fVolApp.textContent = '';
        for (const [app, label] of volumeApps()) fVolApp.appendChild(h('option', { value: app, text: label }));
        const app = isSlider ? def.actionId.slice('vol_slider:'.length) : stepMatch[1];
        if (![...fVolApp.options].some(o => o.value === app)) fVolApp.appendChild(h('option', { value: app, text: app }));
        fVolApp.value = app;
        if (stepMatch) {
            if (![...fVolStep.options].some(o => o.value === stepMatch[2])) fVolStep.appendChild(h('option', { value: stepMatch[2], text: `${stepMatch[2]}%` }));
            fVolStep.value = stepMatch[2];
        }
    }
    $('btn-test-key').disabled = isEmptyKey(def);
    inspectorSyncing = false;

    // Property Inspector do plugin
    const isPlugin = !!(def.actionId && def.actionId.startsWith('plugin:'));
    setHidden($('param-plugin'), !isPlugin);
    if (isPlugin) schedulePropertyInspector(p.id, def.index, def.actionId);
    else unloadPropertyInspector();
}

// --------------------------------------------------------------------------
// Property Inspector (página HTML do plugin, protocolo Elgato via WebSocket local)
// --------------------------------------------------------------------------
let piLoadedKey = null;
let piTimer = null;

function unloadPropertyInspector() {
    piLoadedKey = null;
    $('pi-frame-wrap').textContent = '';
    setHidden($('pi-note'), true);
}

function schedulePropertyInspector(profileId, index, actionId, force = false) {
    const key = `${profileId}|${index}|${actionId}`;
    if (!force && piLoadedKey === key) return;
    piLoadedKey = key;
    if (piTimer) clearTimeout(piTimer);
    piTimer = setTimeout(() => loadPropertyInspector(profileId, index, key), 150);
}

async function loadPropertyInspector(profileId, index, key) {
    const wrap = $('pi-frame-wrap');
    const note = $('pi-note');
    wrap.textContent = '';
    setHidden(note, true);
    $('pi-plugin-name').textContent = '';
    await flushAutosave(); // a instância só existe depois que a tecla está salva
    if (piLoadedKey !== key) return;
    const res = await apiFetch(`/api/plugins/pi?profile=${encodeURIComponent(profileId)}&index=${index}`);
    if (piLoadedKey !== key) return;
    const d = res.data || {};
    if (!res.ok || d.error) {
        note.textContent = d.none ? 'Esta ação não tem configurações.' : (d.error || 'Não foi possível abrir a configuração do plugin.');
        setHidden(note, false);
        return;
    }
    $('pi-plugin-name').textContent = d.pluginName || '';
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    if (!isLocal) {
        note.textContent = 'A configuração do plugin só funciona com o gerenciador aberto no próprio PC (ela conecta em 127.0.0.1).';
        setHidden(note, false);
    }
    if (!d.running) {
        note.textContent = 'O plugin não está rodando: a página abre, mas as alterações só chegam quando ele voltar.';
        setHidden(note, false);
    }
    const iframe = h('iframe', { src: d.url, title: `Configuração do plugin ${d.pluginName || ''}`, sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups' });
    iframe.addEventListener('load', () => {
        // O host chama connectElgatoStreamDeckSocket(port, uuid, registerEvent, info, actionInfo) na página
        let tries = 0;
        const attempt = () => {
            if (piLoadedKey !== key) return;
            let fn = null;
            try { fn = iframe.contentWindow && iframe.contentWindow.connectElgatoStreamDeckSocket; } catch (e) { fn = null; }
            if (typeof fn === 'function') {
                try { fn(String(d.port), d.uuid, d.registerEvent, JSON.stringify(d.info), JSON.stringify(d.actionInfo)); }
                catch (e) { note.textContent = `Erro ao iniciar a configuração: ${e.message}`; setHidden(note, false); }
                return;
            }
            if (++tries < 40) setTimeout(attempt, 100);
            else { note.textContent = 'A página do plugin não expôs connectElgatoStreamDeckSocket.'; setHidden(note, false); }
        };
        attempt();
    });
    wrap.appendChild(iframe);
}

$('pi-reload').addEventListener('click', () => {
    const p = editingProfile();
    const def = state.selected !== null ? displayKey(state.selected) : null;
    if (p && def && def.actionId && def.actionId.startsWith('plugin:')) schedulePropertyInspector(p.id, def.index, def.actionId, true);
});

// --------------------------------------------------------------------------
// Plugins do Stream Deck (modal)
// --------------------------------------------------------------------------
const pluginsModal = $('plugins-modal');
let pluginsFocusReturn = null;
let pluginRemoveArmed = null;
let pluginLogFor = null;

async function reloadCatalog() {
    const res = await apiFetch('/api/actions');
    if (res.ok && res.data) { state.catalog = res.data; buildActionIndex(); renderActions(); }
}

function openPlugins() {
    pluginsFocusReturn = document.activeElement;
    pluginsModal.classList.add('active');
    pluginsModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    $('plugins-status').textContent = '';
    renderPlugins();
    $('plugin-url').focus();
}

function closePlugins() {
    pluginsModal.classList.remove('active');
    pluginsModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    pluginRemoveArmed = null;
    if (pluginsFocusReturn && pluginsFocusReturn.focus) pluginsFocusReturn.focus();
}

const PLUGIN_STATUS_LABEL = { running: 'rodando', starting: 'iniciando', restarting: 'reiniciando', stopped: 'parado', failed: 'falhou', unsupported: 'incompatível' };

async function renderPlugins() {
    const list = $('plugin-list');
    const res = await apiFetch('/api/plugins');
    list.textContent = '';
    if (!res.ok || !res.data) { list.appendChild(h('div', { class: 'plugins-empty', text: 'Não foi possível listar os plugins.' })); return; }
    const plugins = res.data.plugins || [];
    $('plugins-status').textContent = `${plugins.length} instalado(s) · pasta ${res.data.dir || ''} · Node ${res.data.node || ''}`;
    if (!plugins.length) {
        list.appendChild(h('div', { class: 'plugins-empty', text: 'Nenhum plugin instalado. Envie um arquivo .streamDeckPlugin acima.' }));
        setHidden($('plugin-log'), true);
        return;
    }
    for (const p of plugins) {
        const status = h('span', { class: 'plugin-status', 'data-s': p.status, text: PLUGIN_STATUS_LABEL[p.status] || p.status, title: p.reason || '' });
        const row = h('div', { class: 'plugin-row', dataset: { uuid: p.uuid } },
            h('span', { class: 'plugin-icon' }, p.icon ? h('img', { src: p.icon, alt: '' }) : svgIcon('i-puzzle')),
            h('div', {},
                h('div', { class: 'plugin-name' }, h('span', { text: p.name }), status),
                h('div', { class: 'plugin-meta', text: `v${p.version} · ${p.author}${p.category ? ' · ' + p.category : ''} · ${p.actions.length} ação(ões)${p.reason ? ' · ' + p.reason : ''}` })
            ),
            h('div', { class: 'plugin-actions' },
                h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Log', onclick: () => showPluginLog(p.uuid, p.name) }),
                p.supported ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Reiniciar', onclick: async () => { await apiJson(`/api/plugins/${encodeURIComponent(p.uuid)}/restart`, 'POST', {}); toast(`Reiniciando ${p.name}…`, { type: 'info' }); setTimeout(renderPlugins, 1200); } }) : null,
                h('button', { type: 'button', class: 'btn btn-danger btn-sm', text: pluginRemoveArmed === p.uuid ? 'Confirmar remoção' : 'Remover', onclick: async () => {
                    if (pluginRemoveArmed !== p.uuid) { pluginRemoveArmed = p.uuid; renderPlugins(); return; }
                    pluginRemoveArmed = null;
                    const r = await apiFetch(`/api/plugins/${encodeURIComponent(p.uuid)}`, { method: 'DELETE' });
                    if (!r.ok) { toast((r.data && r.data.error) || 'Não foi possível remover.', { type: 'error' }); return; }
                    toast(`Plugin ${p.name} removido. Teclas que o usavam ficam sem ação.`, { type: 'success' });
                    if (pluginLogFor === p.uuid) { pluginLogFor = null; setHidden($('plugin-log'), true); }
                    renderPlugins(); reloadCatalog();
                } })
            )
        );
        list.appendChild(row);
    }
    if (pluginLogFor) showPluginLog(pluginLogFor, null, true);
}

async function showPluginLog(uuid, name, silent = false) {
    const res = await apiFetch(`/api/plugins/${encodeURIComponent(uuid)}/log`);
    const pre = $('plugin-log');
    if (!res.ok || !res.data) { if (!silent) toast('Log indisponível.', { type: 'error' }); return; }
    pluginLogFor = uuid;
    pre.textContent = (name ? `# ${name}\n` : '') + ((res.data.log || []).join('\n') || '(vazio)');
    setHidden(pre, false);
    pre.scrollTop = pre.scrollHeight;
}

async function installPluginFile(file) {
    if (!file) return;
    $('plugins-status').textContent = `Enviando ${file.name}…`;
    const res = await apiFetch('/api/plugins/install', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
    afterPluginInstall(res);
}

async function installPluginUrl(url) {
    if (!url) return;
    $('plugins-status').textContent = 'Baixando…';
    const res = await apiJson('/api/plugins/install-url', 'POST', { url });
    afterPluginInstall(res);
}

function afterPluginInstall(res) {
    const d = res.data || {};
    if (!res.ok || !d.success) {
        $('plugins-status').textContent = '';
        toast(d.error || 'Falha ao instalar o plugin.', { type: 'error', duration: 6000 });
        return;
    }
    const p = d.plugin || {};
    toast(p.supported ? `Plugin ${p.name} v${p.version} instalado.` : `Plugin ${p.name} instalado, mas ${p.reason || 'não é compatível'}.`, { type: p.supported ? 'success' : 'warning', duration: 6000 });
    $('plugin-url').value = '';
    renderPlugins();
    reloadCatalog();
}

$('btn-plugins').addEventListener('click', openPlugins);
$('btn-close-plugins').addEventListener('click', closePlugins);
$('btn-plugins-done').addEventListener('click', closePlugins);
$('btn-plugins-reload').addEventListener('click', async () => { await apiJson('/api/plugins/reload', 'POST', {}); renderPlugins(); reloadCatalog(); });
$('btn-plugin-url').addEventListener('click', () => installPluginUrl($('plugin-url').value.trim()));
$('plugin-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); installPluginUrl($('plugin-url').value.trim()); } });
$('plugin-file').addEventListener('change', (e) => { installPluginFile(e.target.files && e.target.files[0]); e.target.value = ''; });
pluginsModal.addEventListener('click', (e) => { if (e.target === pluginsModal) closePlugins(); });
const pluginDrop = $('plugin-drop');
pluginDrop.addEventListener('dragover', (e) => { e.preventDefault(); pluginDrop.classList.add('is-drop'); });
pluginDrop.addEventListener('dragleave', () => pluginDrop.classList.remove('is-drop'));
pluginDrop.addEventListener('drop', (e) => { e.preventDefault(); pluginDrop.classList.remove('is-drop'); installPluginFile(e.dataTransfer.files && e.dataTransfer.files[0]); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pluginsModal.classList.contains('active')) closePlugins(); });

let pluginsChangedTimer = null;

$('f-icon-scale').addEventListener('input', () => {
    const pct = parseInt($('f-icon-scale').value, 10) || 100;
    $('f-icon-scale-out').textContent = `${pct}%`;
    editSelected((k) => { if (pct === 100) delete k.iconScale; else k.iconScale = pct / 100; });
});
$('btn-close-inspector').addEventListener('click', () => {
    inspectorCollapsed = true;
    state.selected = null;
    if (openPopover && openPopover.pop === iconPop) closePopover();
    renderGrid();
    renderInspector();
    const first = deviceGrid.querySelector('.mkey');
    if (first) first.focus({ preventScroll: true });
});

function editSelected(mutator) {
    if (inspectorSyncing) return;
    const p = editingProfile();
    if (!isEditable(p) || state.selected === null) return;
    const k = keyRef(state.selected);
    mutator(k);
    touchKey(state.selected);
    renderGrid();
    renderInspector();
}

fTitle.addEventListener('input', () => editSelected(k => { k.title = fTitle.value; }));
fBadge.addEventListener('input', () => editSelected(k => { if (fBadge.value) k.badge = fBadge.value; else delete k.badge; }));
fBg.addEventListener('input', () => editSelected(k => { k.bgColor = fBg.value; }));
fBorder.addEventListener('input', () => editSelected(k => { k.borderColor = fBorder.value; }));
fBadgeColor.addEventListener('input', () => editSelected(k => { k.badgeColor = fBadgeColor.value; }));
fTitleColor.addEventListener('input', () => editSelected(k => { k.titleColor = fTitleColor.value; }));
$('f-bg-clear').addEventListener('click', () => editSelected(k => { delete k.bgColor; }));
$('f-border-clear').addEventListener('click', () => editSelected(k => { delete k.borderColor; }));
$('f-badge-color-clear').addEventListener('click', () => editSelected(k => { delete k.badgeColor; }));
$('f-title-color-clear').addEventListener('click', () => editSelected(k => { delete k.titleColor; }));
$('btn-remove-action').addEventListener('click', () => editSelected(k => { delete k.actionId; delete k.isSlider; delete k.sliderApp; delete k.sliderValue; delete k.imageFill; delete k.settings; }));
function applySpanFromInspector() {
    const k = state.selected !== null ? keyRef(state.selected) : null;
    if (!k) return;
    const cols = parseInt($('f-col-span').value, 10) || 1;
    const rows = parseInt($('f-row-span').value, 10) || 1;
    if (!canSpan(k, cols, rows)) {
        toast('Para crescer, as teclas que seriam cobertas precisam estar vazias.', { type: 'warning' });
        renderInspector();
        return;
    }
    editSelected((key) => {
        delete key.tall;
        if (cols > 1) key.colSpan = cols; else delete key.colSpan;
        if (rows > 1) key.rowSpan = rows; else delete key.rowSpan;
    });
}
$('f-slider-dir').addEventListener('change', () => {
    const horizontal = $('f-slider-dir').value === 'h';
    editSelected(k => { if (horizontal) { k.sliderDir = 'h'; delete k.tall; } else delete k.sliderDir; });
});
$('f-stat-font').addEventListener('input', () => {
    const pct = parseInt($('f-stat-font').value, 10) || 0;
    $('f-stat-font-out').textContent = `${pct > 0 ? '+' : ''}${pct}%`;
    editSelected(k => { if (pct === 0) delete k.statFont; else k.statFont = Math.round((1 + pct / 100) * 100) / 100; });
});
$('f-stat-chart').addEventListener('change', () => { const v = $('f-stat-chart').value; editSelected(k => { if (v === 'line' || v === 'bars' || v === 'none') k.statChart = v; else delete k.statChart; }); });
$('f-stat-swap').addEventListener('change', () => { const on = $('f-stat-swap').checked; editSelected(k => { if (on) k.statSwap = true; else delete k.statSwap; }); });
$('f-col-span').addEventListener('change', applySpanFromInspector);
$('f-row-span').addEventListener('change', applySpanFromInspector);
$('btn-clear-key').addEventListener('click', () => { if (state.selected !== null) clearKey(state.selected); });

fSwitchTarget.addEventListener('change', () => editSelected(k => { k.actionId = `switch:${fSwitchTarget.value}`; }));
fSpotifyUri.addEventListener('change', async () => {
    const raw = fSpotifyUri.value.trim();
    const hint = $('spotify-uri-hint');
    if (!raw) { editSelected(k => { k.actionId = 'spotify:play:'; }); return; }
    hint.textContent = 'Consultando o Spotify…';
    const r = await apiFetch(`/api/spotify/resolve?url=${encodeURIComponent(raw)}`);
    if (!r.ok || !r.data || !r.data.uri) {
        hint.textContent = (r.data && r.data.error) || 'Link não reconhecido.';
        return;
    }
    const info = r.data;
    const prevAuto = state.selected !== null ? (keyRef(state.selected) || {}).spotifyAutoTitle : null;
    editSelected(k => {
        k.actionId = `spotify:play:${info.uri}`;
        if (info.title && (!k.title || k.title === 'Tocar playlist / álbum' || k.title === prevAuto)) { k.title = info.title; k.spotifyAutoTitle = info.title; }
        if (info.thumbnail) { k.icon = info.thumbnail; k.imageFill = true; }
    });
    hint.textContent = info.title ? `${info.type}: ${info.title}` : '';
});
fVolApp.addEventListener('change', () => editSelected(k => {
    if (k.actionId && k.actionId.startsWith('vol_slider:')) { k.actionId = `vol_slider:${fVolApp.value}`; k.sliderApp = fVolApp.value; k.isSlider = true; }
    else { const m = /^vol_step:[^:]+:([+-]\d+)$/.exec(k.actionId || ''); k.actionId = `vol_step:${fVolApp.value}:${m ? m[1] : '+5'}`; }
}));
fVolStep.addEventListener('change', () => editSelected(k => {
    const m = /^vol_step:([^:]+):/.exec(k.actionId || '');
    k.actionId = `vol_step:${m ? m[1] : fVolApp.value || 'master'}:${fVolStep.value}`;
}));

// Testar tecla (keyDown/keyUp no perfil em edição)
$('btn-test-key').addEventListener('click', () => {
    const p = editingProfile();
    if (!p || state.selected === null) return;
    const idx = state.selected;
    if (!wsSend({ event: 'keyDown', keyIndex: idx, profile: p.id })) { toast('Sem conexão com o servidor.', { type: 'error' }); return; }
    const el = deviceGrid.querySelector(`.mkey[data-index="${idx}"]`);
    if (el) el.classList.add('is-testing');
    setTimeout(() => {
        wsSend({ event: 'keyUp', keyIndex: idx, profile: p.id });
        if (el) el.classList.remove('is-testing');
    }, 140);
    toast(`Tecla ${idx + 1} acionada.`, { type: 'info', duration: 1500 });
});

// Popover de ícones ---------------------------------------------------------
const iconPop = $('icon-pop');
const iconBtn = $('f-icon-btn');
const iconGrid = $('icon-grid');
const iconSearch = $('icon-search');

function renderIconGrid() {
    const q = iconSearch.value.trim().toLowerCase();
    const def = state.selected !== null ? keyRef(state.selected) : null;
    iconGrid.textContent = '';
    for (const [name, url] of Object.entries(state.icons)) {
        if (q && !name.toLowerCase().includes(q)) continue;
        iconGrid.appendChild(h('button', {
            type: 'button', class: 'icon-cell', role: 'option', title: name, 'aria-label': name,
            'aria-selected': def && def.icon === url ? 'true' : 'false',
            onclick: () => { editSelected(k => { k.icon = url; }); closePopover(); iconBtn.focus(); }
        }, h('img', { src: url, alt: '' })));
    }
}

iconBtn.addEventListener('click', () => {
    if (togglePopover(iconPop, iconBtn)) {
        iconSearch.value = '';
        renderIconGrid();
        // Alinha o popover ao botão, sem sair da tela
        const insp = $('inspector').getBoundingClientRect();
        const b = iconBtn.getBoundingClientRect();
        const width = Math.min(420, window.innerWidth - 32);
        const left = clamp(b.left - insp.left, 8, Math.max(8, insp.width - width - 8));
        iconPop.style.left = `${left}px`;
        iconSearch.focus();
    }
});
iconSearch.addEventListener('input', renderIconGrid);
$('icon-none').addEventListener('click', () => { editSelected(k => { delete k.icon; }); closePopover(); iconBtn.focus(); });
$('icon-upload').addEventListener('click', () => $('icon-file').click());
$('icon-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const target = state.selected;
    toast(`Enviando ${file.name}…`);
    const res = await apiFetch('/api/media', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!res.ok || !res.data || !res.data.url) { toast((res.data && res.data.error) || 'Não foi possível enviar a imagem', { type: 'error' }); return; }
    if (state.selected !== target) return;   // a seleção mudou durante o envio
    // Imagem própria entra ocupando a tecla inteira (GIF animado, foto); dá para desligar no interruptor
    editSelected(k => { k.icon = res.data.url; k.imageFill = true; delete k.iconScale; if (k.title === undefined) k.title = ''; });
    closePopover(); iconBtn.focus();
});
$('f-icon-fill').addEventListener('change', () => {
    const on = $('f-icon-fill').checked;
    editSelected(k => { if (on) { k.imageFill = true; delete k.iconScale; } else delete k.imageFill; });
});
iconPop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePopover(); iconBtn.focus(); } });

// --------------------------------------------------------------------------
// Renderização geral
// --------------------------------------------------------------------------
function renderAll() {
    const p = editingProfile();
    renderPickerButton();
    $('stage-title').textContent = p ? (p.name || p.id) : '—';
    setHidden($('stage-active-pill'), !p || p.id !== state.current);
    setHidden($('stage-readonly'), !p || isEditable(p));
    if (p) {
        selRows.value = String(p.rows);
        selCols.value = String(p.cols);
        chkHud.checked = p.showHardwareHud !== false;
    }
    const editable = isEditable(p);
    selRows.disabled = !editable;
    selCols.disabled = !editable;
    chkHud.disabled = !editable;
    if (!editable) setSaveState('readonly');
    else if (state.saveState === 'readonly') setSaveState('idle');
    $('stage-hint').textContent = editable
        ? 'Arraste uma ação do painel à direita para uma tecla. Clique numa tecla para editá-la; clique com o botão direito ou pressione Delete para limpar.'
        : 'Perfil embutido: você pode ver e testar as teclas, mas para alterar use “Duplicar para editar”.';
    renderGrid();
    renderInspector();
    if (openPopover && openPopover.pop === profilePop) renderPickerList();
}

// --------------------------------------------------------------------------
// Status (chips, AUTO) e WebSocket
// --------------------------------------------------------------------------
function setChip(id, stateName, tip) {
    const chip = $(id);
    chip.dataset.state = stateName;
    if (tip) chip.title = tip;
}

async function pollStatus() {
    const res = await apiFetch('/api/status');
    if (!res.ok || !res.data) return;
    const s = res.data;
    const integ = s.integrations || {};
    const caps = s.capabilities || {};
    setChip('chip-obs', integ.obs && integ.obs.connected ? 'on' : 'off', integ.obs && integ.obs.connected ? `OBS conectado (${integ.obs.scenes || 0} cenas)` : 'OBS desconectado');
    const ts = integ.teamspeak || {};
    setChip('chip-ts', ts.connected ? (ts.needsAuthorization ? 'warn' : 'on') : 'off',
        ts.connected ? (ts.needsAuthorization ? 'TeamSpeak: autorize o MatDeck em Remote Apps' : `TeamSpeak conectado${ts.nickname ? ' como ' + ts.nickname : ''}`) : 'TeamSpeak desconectado');
    const dc = integ.discord || {};
    const dcText = describeDiscord(dc);
    setChip('chip-discord', dc.authenticated ? 'on' : (dc.authorizing || (!dc.needsSetup && !dc.connected) || caps.ydotool || caps.xdotool ? 'warn' : 'off'), dcText);
    const dcStatus = $('discord-rpc-status');
    if (dcStatus) dcStatus.textContent = dcText;
    const mac = caps.platform === 'darwin';
    const keysOk = typeof caps.keysReady === 'boolean' ? caps.keysReady : !!(caps.ydotool || caps.kdotool || caps.xdotool);
    const keysTip = mac
        ? (keysOk ? 'Envio de teclas: MatDeck Helper (Acessibilidade concedida)' : (caps.helper ? 'Conceda Acessibilidade ao MatDeck Helper em Ajustes do Sistema › Privacidade e Segurança' : 'MatDeck Helper não está no ar'))
        : (keysOk ? `Envio de teclas: ${caps.ydotool ? 'ydotool' : caps.kdotool ? 'kdotool' : 'xdotool'}` : 'Nenhuma ferramenta de teclado disponível (ydotool/xdotool)');
    setChip('chip-keys', keysOk ? 'on' : 'off', keysTip);
    setAutoUI(!!s.autoDetect);
    if (s.profile && s.profile !== state.current) { state.current = s.profile; renderAll(); }
}

function describeDiscord(dc) {
    if (dc.authenticated) return `Discord conectado pela API${dc.user ? ' como ' + dc.user.username : ''}${dc.voice ? (dc.voice.mute ? ' · mic mudo' : ' · mic aberto') : ''}`;
    if (dc.needsSetup) return 'Discord: sem Client ID, controle por atalhos de teclado (foca a janela e envia o atalho)';
    if (dc.authorizing) return 'Discord: aceite a janela de autorização que abriu no Discord';
    if (dc.declined) return 'Discord: autorização recusada; clique em Autorizar para tentar de novo';
    if (!dc.connected) return `Discord: ${dc.error || 'aplicativo fechado'} (enquanto isso, atalhos de teclado)`;
    return `Discord: ${dc.error || 'autenticando…'}`;
}

$('btn-discord-authorize').addEventListener('click', async () => {
    const btn = $('btn-discord-authorize');
    btn.disabled = true;
    const res = await apiJson('/api/discord/authorize', 'POST');
    btn.disabled = false;
    if (!res.ok) { toast((res.data && res.data.error) || 'Não foi possível pedir a autorização', { type: 'error' }); return; }
    toast('Aceite a janela de autorização no Discord.');
    pollStatus();
});

function setAutoUI(active) {
    state.autoDetect = active;
    const btn = $('btn-auto');
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    $('btn-auto-state').textContent = active ? 'ON' : 'OFF';
}

$('btn-auto').addEventListener('click', async () => {
    const res = await apiJson('/api/autodetect', 'POST', { enabled: !state.autoDetect });
    if (res.ok && res.data) setAutoUI(!!res.data.enabled);
    else toast('Não foi possível alterar o modo AUTO.', { type: 'error' });
});

function setConn(stateName) {
    const el = $('conn-state');
    el.dataset.state = stateName;
    $('conn-text').textContent = { connected: 'Conectado', connecting: 'Conectando…', offline: 'Sem conexão' }[stateName];
}

function initWebSocket() {
    if (state.wsTimer) { clearTimeout(state.wsTimer); state.wsTimer = null; }
    const loc = window.location;
    const url = (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/deck';
    setConn('connecting');
    let ws;
    try { ws = new WebSocket(url); } catch (e) { setConn('offline'); state.wsTimer = setTimeout(initWebSocket, 2500); return; }
    state.ws = ws;
    ws.onopen = () => {
        setConn('connected');
        wsSend({ event: 'clientHello', device: 'Manage', version: '1.3.1', width: window.innerWidth, height: window.innerHeight });
        loadPending();
    };
    ws.onmessage = (ev) => {
        try { handleServerMessage(JSON.parse(ev.data)); } catch (e) { console.error('Erro ao ler WebSocket:', e); }
    };
    ws.onclose = () => { setConn('offline'); if (!state.wsTimer) state.wsTimer = setTimeout(initWebSocket, 2500); };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
}

let profilesReloadTimer = null;

async function handleServerMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.event) {
        case 'loadProfile': {
            // O tablet trocou de perfil (toque, auto-detect ou este painel): o dropdown acompanha
            const id = msg.id;
            if (!id) break;
            state.current = id;
            state.liveKeys = {};
            if (Array.isArray(msg.keys)) {
                const def = profileOf(id);
                for (const k of msg.keys) {
                    if (!k || typeof k.index !== 'number') continue;
                    const base = def && def.keys ? def.keys.find(d => d && d.index === k.index) : null;
                    const overlay = {};
                    for (const f of LIVE_FIELDS) {
                        if (k[f] !== undefined && (!base || base[f] !== k[f])) overlay[f] = k[f];
                    }
                    if (Object.keys(overlay).length) state.liveKeys[k.index] = overlay;
                }
            }
            if (state.profiles[id] && state.editingId !== id) await selectProfile(id, { switchTablet: false });
            else renderAll();
            break;
        }
        case 'updateKey': {
            const prof = msg.profile || state.current;
            if (prof !== state.current || typeof msg.keyIndex !== 'number' || !msg.key) break;
            state.liveKeys[msg.keyIndex] = { ...(state.liveKeys[msg.keyIndex] || {}), ...msg.key };
            if (state.editingId === state.current) { renderGrid(); if (state.selected === msg.keyIndex) renderInspector(); }
            break;
        }
        case 'profileList': {
            if (!Array.isArray(msg.profiles)) break;
            // O evento vem filtrado (só visíveis): mantemos a lista completa via GET ?all=1
            const before = state.list.filter(p => !p.hidden).map(p => p.id).join(',');
            if (msg.current) state.current = msg.current;
            const after = msg.profiles.filter(p => p && p.id).map(p => p.id).join(',');
            // Presets alterados em outro cliente: recarrega (com debounce) sem perder o que está sendo editado
            if (profilesReloadTimer) clearTimeout(profilesReloadTimer);
            profilesReloadTimer = setTimeout(async () => {
                profilesReloadTimer = null;
                await loadProfiles();
                if (!state.profiles[state.editingId]) await selectProfile(state.profiles[state.current] ? state.current : 'default', { switchTablet: false });
                else renderAll();
            }, before === after ? 400 : 0);
            renderAll();
            break;
        }
        case 'autoDetectStatus': setAutoUI(!!msg.active); break;
        case 'pluginsChanged':
            if (pluginsChangedTimer) clearTimeout(pluginsChangedTimer);
            pluginsChangedTimer = setTimeout(() => { pluginsChangedTimer = null; reloadCatalog(); if (pluginsModal.classList.contains('active')) renderPlugins(); }, 500);
            break;
        case 'notify': showServerNotification(msg); break;
        case 'pairing': state.pending = Array.isArray(msg.pending) ? msg.pending : []; renderPairingCards(); break;
        case 'devices': state.devices = Array.isArray(msg.devices) ? msg.devices : []; renderDevices(); break;
        default: break;
    }
}

// --------------------------------------------------------------------------
// Dispositivos: pedidos de conexão (PIN) e aparelhos emparelhados
// Só este PC recebe esses eventos (o servidor filtra por conexão loopback)
// --------------------------------------------------------------------------
const pairingCards = $('pairing-cards');
let pairingTick = null;

function fmtAgo(ts) {
    const s = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
    if (!ts) return 'nunca';
    if (s < 60) return 'agora mesmo';
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${Math.round(s / 3600)} h`;
    return `há ${Math.round(s / 86400)} d`;
}

function fmtCountdown(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderPairingCards() {
    pairingCards.textContent = '';
    for (const p of state.pending) {
        const digits = String(p.pin || '').split('');
        pairingCards.appendChild(h('div', { class: 'pairing-card', role: 'dialog', 'aria-label': `Pedido de conexão de ${p.name}` },
            h('div', { class: 'pairing-head' },
                h('span', { class: 'pairing-title', text: 'Um aparelho quer conectar' }),
                h('span', { class: 'pairing-meta', text: `${p.name} · ${p.ip}` })),
            h('div', { class: 'pairing-pin', 'aria-label': `PIN ${digits.join(' ')}` }, digits.map(d => h('span', { text: d }))),
            h('div', { class: 'pairing-foot' },
                h('span', { class: 'pairing-expires', dataset: { expires: String(p.expiresAt || 0) } }),
                h('button', { type: 'button', class: 'btn btn-danger btn-sm', text: 'Recusar', onclick: () => refusePairing(p) }))));
    }
    tickPairing();
    if (state.pending.length && !pairingTick) pairingTick = setInterval(tickPairing, 1000);
    if (!state.pending.length && pairingTick) { clearInterval(pairingTick); pairingTick = null; }
}

function tickPairing() {
    for (const el of pairingCards.querySelectorAll('.pairing-expires')) {
        const left = Number(el.dataset.expires) - Date.now();
        el.textContent = left > 0 ? `Digite no aparelho · vence em ${fmtCountdown(left)}` : 'PIN vencido';
    }
}

async function refusePairing(p) {
    const res = await apiFetch(`/api/pair/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    if (res.ok) toast(`Pedido de ${p.name} recusado. O aparelho fica bloqueado por 10 minutos.`, { type: 'info' });
    else toast('Não foi possível recusar o pedido.', { type: 'error' });
}

async function loadPending() {
    const res = await apiFetch('/api/pair/pending');
    if (res.ok && res.data) { state.pending = res.data.pending || []; renderPairingCards(); }
}

function renderDevices() {
    const box = $('devices-list');
    if (!box) return;
    box.textContent = '';
    if (!state.devices.length) { box.appendChild(h('p', { class: 'settings-note', text: 'Nenhum aparelho emparelhado ainda. Abra o deck pela rede num tablet ou celular e digite o PIN que aparecer aqui.' })); return; }
    for (const d of state.devices) {
        box.appendChild(h('div', { class: 'device-row' },
            h('span', { class: `device-dot${d.online ? ' is-online' : ''}`, 'aria-hidden': 'true' }),
            h('div', { class: 'device-info' },
                h('span', { class: 'device-name', text: d.name || 'Dispositivo' }),
                h('span', { class: 'device-meta', text: `${d.ip || '?'} · ${d.online ? 'conectado agora' : 'visto ' + fmtAgo(d.lastSeenAt)}` })),
            h('button', { type: 'button', class: 'btn btn-danger btn-sm', text: 'Remover', onclick: () => removeDevice(d) })));
    }
}

async function removeDevice(d) {
    const res = await apiFetch(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
    if (res.ok) toast(`${d.name || 'Aparelho'} removido. Ele vai pedir PIN na próxima conexão.`, { type: 'success' });
    else toast('Não foi possível remover o aparelho.', { type: 'error' });
}

async function loadDevices() {
    const res = await apiFetch('/api/devices');
    if (res.ok && res.data) { state.devices = res.data.devices || []; renderDevices(); }
}

// --------------------------------------------------------------------------
// Ajustes (modal portado do deck)
// --------------------------------------------------------------------------
const settingsModal = $('settings-modal');
const settingsForm = $('settings-form');
const settingsLoading = $('settings-loading');
const settingsSections = $('settings-sections');
const settingsError = $('settings-error');
const settingsStatus = $('settings-status');
const btnSaveSettings = $('btn-save-settings');
let loadedConfig = null;
let settingsCloseArmed = false;
let settingsFocusReturn = null;

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj); }
function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = value;
}
function configFields() { return [...settingsForm.querySelectorAll('[data-path]')]; }
function readFieldValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.dataset.type === 'number') { const n = parseInt(el.value, 10); return Number.isNaN(n) ? null : n; }
    return el.value;
}
function writeFieldValue(el, value) {
    if (el.type === 'checkbox') { el.checked = !!value; return; }
    if (el.tagName === 'SELECT' && value !== undefined && value !== null && ![...el.options].some(o => o.value === String(value))) {
        el.appendChild(h('option', { value: String(value), text: `${value} (valor atual)` }));
    }
    el.value = value === undefined || value === null ? '' : String(value);
}
function computeConfigDiff() {
    const diff = {};
    let changed = false;
    for (const el of configFields()) {
        const path = el.dataset.path;
        const current = readFieldValue(el);
        const original = getPath(loadedConfig, path);
        const no = (original === undefined || original === null) ? (el.type === 'checkbox' ? false : '') : original;
        const nc = current === null ? '' : current;
        if (String(nc) !== String(no)) { setPath(diff, path, current); changed = true; }
    }
    return changed ? diff : null;
}
function validateConfigFields() {
    let firstInvalid = null;
    for (const el of configFields()) {
        let error = null;
        if (el.dataset.type === 'number' && el.value !== '') {
            const n = parseInt(el.value, 10);
            if (Number.isNaN(n) || n < 1 || n > 65535) error = 'Informe um número entre 1 e 65535.';
        }
        if (el.dataset.path === 'obs.url' && el.value && !/^wss?:\/\/.+/i.test(el.value.trim())) error = 'O endereço deve começar com ws:// ou wss://.';
        const group = el.closest('.control-group');
        let errEl = group && group.querySelector('.field-error');
        if (error) {
            if (!errEl) { errEl = h('p', { class: 'field-error', role: 'alert' }); group.appendChild(errEl); }
            errEl.textContent = error;
            el.setAttribute('aria-invalid', 'true');
            if (!firstInvalid) firstInvalid = el;
        } else {
            if (errEl) errEl.remove();
            el.removeAttribute('aria-invalid');
        }
    }
    return firstInvalid;
}
function refreshSettingsDirty() {
    if (!loadedConfig) return;
    const diff = computeConfigDiff();
    btnSaveSettings.disabled = !diff;
    settingsCloseArmed = false;
    settingsStatus.textContent = diff ? 'Alterações pendentes' : '';
    settingsStatus.className = 'settings-status' + (diff ? ' is-dirty' : '');
}

/** Ajustes > Auto-Perfil: um seletor por app detectável (valor '' = perfil de mesmo nome, 'none' = não trocar, senão o id do perfil). */
function renderAutoProfileFields(apps) {
    const box = $('auto-profiles-rows');
    box.textContent = '';
    for (const a of apps || []) {
        const sel = h('select', { class: 'form-select', id: `cfg-auto-${a.id}`, dataset: { path: `ui.autoProfiles.${a.id}` } });
        const own = state.list.find(p => p.id === a.id);
        sel.appendChild(h('option', { value: '', text: a.defaultAvailable ? `Padrão (${own ? own.name || own.id : a.id})` : 'Padrão (perfil removido: não troca)' }));
        sel.appendChild(h('option', { value: 'none', text: 'Não trocar' }));
        for (const p of state.list) {
            if (p.hidden) continue;
            sel.appendChild(h('option', { value: p.id, text: p.name || p.id }));
        }
        box.appendChild(h('div', { class: 'control-group' }, h('label', { for: sel.id, text: a.label }), sel));
    }
    setHidden(box.closest('.settings-section'), !box.children.length);
}

async function openSettings() {
    loadedConfig = null;
    settingsFocusReturn = document.activeElement;
    setHidden(settingsLoading, false);
    setHidden(settingsSections, true);
    setHidden(settingsError, true);
    settingsStatus.textContent = '';
    btnSaveSettings.disabled = true;
    settingsModal.classList.add('active');
    settingsModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    const [res, autoRes] = await Promise.all([apiFetch('/api/config'), apiFetch('/api/autodetect'), loadDevices()]);
    setHidden(settingsLoading, true);
    if (!res.ok || !res.data || typeof res.data !== 'object') {
        settingsError.textContent = 'Não foi possível carregar as configurações. Verifique se o servidor está em execução.';
        setHidden(settingsError, false);
        return;
    }
    loadedConfig = res.data;
    renderAutoProfileFields(autoRes.ok && autoRes.data ? autoRes.data.apps : []);
    for (const el of configFields()) writeFieldValue(el, getPath(loadedConfig, el.dataset.path));
    setHidden(settingsSections, false);
    refreshSettingsDirty();
    const first = settingsSections.querySelector('input, select');
    if (first) first.focus();
}

function closeSettings() {
    settingsModal.classList.remove('active');
    settingsModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    if (settingsFocusReturn && settingsFocusReturn.focus) settingsFocusReturn.focus();
}

function requestCloseSettings() {
    if (!settingsModal.classList.contains('active')) return;
    if (loadedConfig && computeConfigDiff() && !settingsCloseArmed) {
        // Confirmação inline (sem confirm()): segundo clique descarta
        settingsCloseArmed = true;
        settingsStatus.textContent = 'Alterações não salvas. Clique de novo para descartar.';
        settingsStatus.className = 'settings-status is-dirty';
        return;
    }
    closeSettings();
}

async function saveSettings() {
    if (!loadedConfig) return;
    const invalid = validateConfigFields();
    if (invalid) { invalid.focus(); return; }
    const diff = computeConfigDiff();
    if (!diff) return;
    btnSaveSettings.disabled = true;
    btnSaveSettings.classList.add('is-loading');
    settingsStatus.textContent = 'Salvando…';
    settingsStatus.className = 'settings-status';
    const res = await apiJson('/api/config', 'POST', diff);
    btnSaveSettings.classList.remove('is-loading');
    if (!res.ok) {
        settingsError.textContent = (res.data && res.data.error) || `Falha ao salvar (${res.status || 'sem conexão'}).`;
        setHidden(settingsError, false);
        settingsStatus.textContent = '';
        btnSaveSettings.disabled = false;
        toast('Configurações não foram salvas.', { type: 'error' });
        return;
    }
    setHidden(settingsError, true);
    loadedConfig = (res.data && res.data.config) || mergeDeep(loadedConfig, diff);
    for (const el of configFields()) writeFieldValue(el, getPath(loadedConfig, el.dataset.path));
    refreshSettingsDirty();
    settingsStatus.textContent = 'Salvo';
    settingsStatus.className = 'settings-status is-saved';
    toast('Configurações salvas.', { type: 'success' });
    pollStatus();
}

function mergeDeep(target, source) {
    const out = JSON.parse(JSON.stringify(target || {}));
    for (const [k, v] of Object.entries(source || {})) out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? mergeDeep(out[k], v) : v;
    return out;
}

$('btn-settings').addEventListener('click', openSettings);
$('btn-close-settings').addEventListener('click', requestCloseSettings);
$('btn-cancel-settings').addEventListener('click', requestCloseSettings);
btnSaveSettings.addEventListener('click', saveSettings);
settingsForm.addEventListener('input', refreshSettingsDirty);
settingsForm.addEventListener('change', refreshSettingsDirty);
settingsForm.addEventListener('submit', (e) => { e.preventDefault(); saveSettings(); });
settingsModal.addEventListener('mousedown', (e) => { if (e.target === settingsModal) requestCloseSettings(); });
settingsForm.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-reveal');
    if (!btn) return;
    const input = $(btn.dataset.reveal);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    btn.setAttribute('aria-label', show ? 'Ocultar' : 'Mostrar');
});

// Esc global: fecha modal/popover; laço de foco no modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (settingsModal.classList.contains('active')) { requestCloseSettings(); return; }
        if (openPopover) { const btn = openPopover.btn; closePopover(); if (btn) btn.focus(); return; }
        if (state.armed) disarm();
    }
    if (e.key === 'Tab' && settingsModal.classList.contains('active')) {
        const focusables = [...settingsModal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')].filter(el => el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
});

// --------------------------------------------------------------------------
// Inicialização
// --------------------------------------------------------------------------
async function boot() {
    const [actionsRes, iconsRes] = await Promise.all([apiFetch('/api/actions'), apiFetch('/api/icons')]);
    if (actionsRes.ok && actionsRes.data) state.catalog = actionsRes.data;
    if (iconsRes.ok && iconsRes.data) state.icons = iconsRes.data;
    buildActionIndex();
    renderActions();

    const ok = await loadProfiles();
    if (!ok) {
        toast('Não foi possível carregar os perfis. Verifique se o servidor está em execução.', { type: 'error', duration: 0 });
    } else {
        state.editingId = state.profiles[state.current] ? state.current : (state.profiles.default ? 'default' : Object.keys(state.profiles)[0] || null);
    }
    renderAll();
    initWebSocket();
    pollStatus();
    setInterval(pollStatus, 5000);
}

boot();
