// Aplicativos no macOS: lista de .app, ícones sob demanda e abertura, tudo pelo helper (NSWorkspace).
// `launcher` tem a forma do AppLauncher do Linux (list/summaries/iconOf/iconDataUrl/launch/reload),
// com a diferença de que iconOf/iconDataUrl são assíncronos (o ícone é pedido ao helper na primeira vez).
const CACHE_TTL_MS = 10 * 60 * 1000;

// Rótulos de launchFirst (candidatos são binários Linux) → bundle id no macOS
const LABEL_TO_BUNDLE = { calculadora: 'com.apple.calculator', terminal: 'com.apple.Terminal' };

class HelperAppLauncher {
    constructor(client) {
        this.client = client;
        this.apps = new Map();      // id -> { id, name, path }
        this.icons = new Map();     // id -> base64 PNG (ou null quando o helper não tem ícone)
        this.loadedAt = 0;
        this.loading = null;
    }

    async list(force = false) {
        if (!force && this.apps.size && (Date.now() - this.loadedAt) < CACHE_TTL_MS) return this.summaries();
        if (!this.loading) this.loading = this.reload().finally(() => { this.loading = null; });
        await this.loading;
        return this.summaries();
    }

    summaries() {
        return Array.from(this.apps.values())
            .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }))
            .map((a) => ({ id: a.id, name: a.name, comment: a.path, flatpak: false, iconUrl: `/api/apps/${encodeURIComponent(a.id)}/icon` }));
    }

    async reload() {
        let res;
        try {
            res = await this.client.request('apps.list', {});
        } catch (e) {
            console.warn(`[Apps] Falha ao listar aplicativos pelo helper: ${e.message || e.code}`);
            return;   // mantém a lista anterior
        }
        const apps = new Map();
        for (const a of (res && res.apps) || []) {
            if (!a || !a.id) continue;
            apps.set(String(a.id), { id: String(a.id), name: String(a.name || a.id), path: String(a.path || '') });
        }
        this.apps = apps;
        this.loadedAt = Date.now();
        console.log(`[Apps] ${apps.size} aplicativos encontrados.`);
    }

    async iconBase64(id) {
        if (!this.apps.has(id)) return null;
        if (this.icons.has(id)) return this.icons.get(id);
        try {
            const res = await this.client.request('apps.icon', { id });
            const png = res && typeof res.png === 'string' && res.png ? res.png : null;
            this.icons.set(id, png);
            return png;
        } catch (e) {
            return null;   // sem cache: tenta de novo na próxima
        }
    }

    /** Ícone como { mime, buffer } ou null (assíncrono: pede ao helper na primeira vez). */
    async iconOf(id) {
        const b64 = await this.iconBase64(id);
        return b64 ? { mime: 'image/png', buffer: Buffer.from(b64, 'base64') } : null;
    }

    async iconDataUrl(id) {
        const b64 = await this.iconBase64(id);
        return b64 ? `data:image/png;base64,${b64}` : null;
    }

    async launch(id) {
        const app = this.apps.get(id);
        if (!app) { console.warn(`[Apps] Aplicativo desconhecido: ${id}`); return false; }
        console.log(`[Apps] Abrindo ${app.name} (${app.path})`);
        try {
            const res = await this.client.request('apps.launch', { id });
            return !!(res && res.launched);
        } catch (e) {
            console.warn(`[Apps] Falha ao abrir ${app.name}: ${e.message || e.code}`);
            return false;
        }
    }

    findByName(name) {
        const n = String(name || '').toLowerCase();
        for (const a of this.apps.values()) if (a.name.toLowerCase() === n) return a;
        return null;
    }
}

function createApps(client) {
    const launcher = new HelperAppLauncher(client);

    async function open(target) {
        try {
            const res = await client.request('apps.open', { target: String(target) });
            return !!(res && res.opened);
        } catch (e) {
            console.warn(`[Apps] Falha ao abrir ${target}: ${e.message || e.code}`);
            return false;
        }
    }

    async function launchBundle(id) {
        try {
            const res = await client.request('apps.launch', { id });
            return !!(res && res.launched);
        } catch (e) {
            console.warn(`[Apps] Falha ao abrir ${id}: ${e.message || e.code}`);
            return false;
        }
    }

    return {
        launcher,
        open,
        async launchFile(bin, args = []) {
            if (bin === 'xdg-open') return args[0] ? open(args[0]) : false;
            if (bin === 'flatpak') return false;
            if (!launcher.apps.size) await launcher.list().catch(() => {});
            const app = launcher.findByName(bin);
            if (!app) { console.log(`[Apps] Nenhum aplicativo chamado "${bin}" no Mac`); return false; }
            return launcher.launch(app.id);
        },
        async launchFirst(candidates, label) {
            const id = LABEL_TO_BUNDLE[String(label || '').toLowerCase()];
            if (!id) { console.log(`[Apps] Nenhum programa do Mac mapeado para "${label}"`); return false; }
            return launchBundle(id);
        },
        async flatpakInstalled() { return false; },
        commandExists() { return false; }
    };
}

module.exports = { createApps, HelperAppLauncher, LABEL_TO_BUNDLE };
