// Janelas no macOS: janela ativa por eventos do helper (NSWorkspace + Acessibilidade) e foco com
// exigência de título, traduzindo os classHints dos perfis para bundle ids.
const EventEmitter = require('events');
const WindowDetector = require('../../windowDetector');
const { CLASS_TO_BUNDLE, BUNDLE_TO_PROFILE } = require('./bundleIds');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function matchProfile(title, app) {
    const bundle = (app || '').trim();
    if (bundle && BUNDLE_TO_PROFILE[bundle]) return BUNDLE_TO_PROFILE[bundle];
    return WindowDetector.matchProfile(title || '', '');   // só as regras de título (Meet, Talk no navegador…)
}

class HelperWindowDetector extends EventEmitter {
    constructor(client) {
        super();
        this.client = client;
        this.enabled = true;
        this.running = false;
        this.subscribed = false;
        this.lastDetected = { title: '', app: '', profile: null };
        client.on('window.active', (data) => this.onActive(data));
        client.on('connected', () => { if (this.running && this.enabled) this.subscribe(true); });
    }

    describe() {
        if (!this.enabled) return 'desligada';
        return this.client.connected ? 'helper (NSWorkspace + Acessibilidade)' : 'INDISPONÍVEL (helper ausente)';
    }

    start() {
        if (this.running) return;
        this.running = true;
        if (!this.enabled) { console.log('[WindowDetector] Auto-detecção desligada: nenhum backend em execução'); return; }
        this.subscribe(true);
    }

    stop() {
        this.running = false;
        this.subscribe(false);
    }

    setEnabled(flag) {
        const on = !!flag;
        if (on === this.enabled) return;
        this.enabled = on;
        console.log(`[WindowDetector] Auto-Detecção ${on ? 'Ativada' : 'Desativada'}`);
        if (this.running) this.subscribe(on);
    }

    subscribe(on) {
        this.subscribed = on;
        if (!this.client.connected) return;
        this.client.request('window.subscribe', { on }).then(() => {
            if (on) console.log('[WindowDetector] Monitorando a janela ativa via helper (eventos do macOS)');
        }).catch((e) => console.log(`[WindowDetector] window.subscribe falhou: ${e.message}`));
    }

    onActive(data) {
        if (!this.running || !this.enabled || !data) return;
        this.evaluateWindow(data.title || '', data.bundleId || data.app || '');
    }

    evaluateWindow(title, app) {
        const profile = matchProfile(title, app);
        if (title !== this.lastDetected.title || app !== this.lastDetected.app || profile !== this.lastDetected.profile) {
            this.lastDetected = { title, app, profile };
            this.emit('windowChanged', { title, app, profile });
        }
    }
}

function createWindows(client, keys) {
    const warned = new Set();
    const warnOnce = (k, msg) => { if (!warned.has(k)) { warned.add(k); console.log(msg); } };

    async function focus(target = {}) {
        const classHints = (target.classHints || []).map((h) => String(h).toLowerCase()).filter(Boolean);
        const titleHints = (target.titleHints || []).map((h) => String(h)).filter(Boolean);
        const requireTitle = !!target.requireTitle && titleHints.length > 0;
        if (!classHints.length && !titleHints.length) return false;
        const bundleIds = [];
        const names = [];
        for (const h of classHints) {
            const b = CLASS_TO_BUNDLE[h];
            if (b) { if (!bundleIds.includes(b)) bundleIds.push(b); } else names.push(h);
        }
        try {
            const res = await client.request('window.focus', { bundleIds, names, titleHints, requireTitle });
            if (res && res.focused) { console.log(`[Windows] Janela focada via helper (${res.how})`); return true; }
            console.log(`[Windows] Nenhuma janela encontrada para bundles=[${bundleIds}] names=[${names}] title=[${titleHints}]${requireTitle ? ' (título obrigatório)' : ''}`);
            return false;
        } catch (e) {
            const code = (e && e.code) || 'erro';
            if (code === 'accessibility_denied') warnOnce(code, '[Windows] Foco de janela: sem permissão de Acessibilidade (conceda ao MatDeck Helper em Ajustes do Sistema)');
            else warnOnce(`${code}`, `[Windows] Foco de janela falhou: ${e.message || code}`);
            return false;
        }
    }

    async function focusAndSend(target, combo, delayMs = 150) {
        const focused = await focus(target);
        if (!focused) { console.log(`[Windows] Janela alvo não encontrada; atalho ${combo} não enviado`); return false; }
        await sleep(delayMs);
        return keys.shortcut(combo);
    }

    return {
        detector: new HelperWindowDetector(client),
        focus,
        focusAndSend,
        matchProfile,
        DETECTABLE_APPS: WindowDetector.DETECTABLE_APPS
    };
}

module.exports = { createWindows, matchProfile };
