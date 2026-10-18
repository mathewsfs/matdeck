const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { execFileSync } = require('child_process');

/**
 * Plugins do Stream Deck (.streamDeckPlugin = zip com uma pasta <uuid>.sdPlugin/manifest.json).
 *
 * Só plugins Node.js rodam aqui (CodePath .js/.mjs/.cjs, campo Nodejs no manifesto): o Linux não
 * roda os binários Windows/macOS e os plugins HTML antigos precisariam de um navegador.
 * Pasta: <dados>/plugins/unpacked/<uuid>.sdPlugin
 */
class PluginLoader {
    constructor(pluginsDir) {
        this.pluginsDir = pluginsDir || path.resolve(__dirname, '../../../plugins');
        this.unpackedDir = path.join(this.pluginsDir, 'unpacked');

        // No Flatpak o /app é somente leitura; sem pasta de plugins o recurso só fica inativo
        try {
            fs.mkdirSync(this.pluginsDir, { recursive: true });
            fs.mkdirSync(this.unpackedDir, { recursive: true });
        } catch (e) {
            console.warn(`[Plugins] Pasta de plugins indisponível (${this.pluginsDir}): ${e.message}`);
        }
    }

    // ------------------------------------------------------------------
    // Instalação
    // ------------------------------------------------------------------

    /** Instala a partir do conteúdo de um .streamDeckPlugin (Buffer). Retorna o meta do plugin. */
    installFromBuffer(buffer, label = 'upload') {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-plugin-'));
        try {
            this.extractZip(buffer, tmpDir);
            const manifestPath = this.findManifest(tmpDir);
            if (!manifestPath) throw new Error('manifest.json não encontrado dentro do pacote');
            let manifest;
            const manifestRaw = fs.readFileSync(manifestPath);
            if (manifestRaw.subarray(0, 6).toString('latin1') === 'ELGATO') {
                // Pacotes baixados do Marketplace vêm com o manifest.json criptografado (contêiner "ELGATO"):
                // só o app Stream Deck tem a chave. Os outros arquivos vêm em claro, mas sem o manifesto não há como instalar.
                throw new Error('Este pacote veio do Marketplace da Elgato e tem o manifest.json criptografado (só o app Stream Deck consegue abrir). Procure o mesmo plugin nas releases do GitHub do autor (arquivo .streamDeckPlugin sem criptografia) e instale por URL ou arquivo.');
            }
            try {
                manifest = JSON.parse(manifestRaw.toString('utf8'));
            } catch (e) {
                throw new Error(`manifest.json inválido: ${e.message}`);
            }
            const extractedRoot = path.dirname(manifestPath);
            const uuid = String(manifest.UUID || path.basename(extractedRoot).replace(/\.sdPlugin$/, '')).trim();
            if (!/^[a-z0-9][a-z0-9.\-_]*$/i.test(uuid)) throw new Error(`UUID inválido no manifesto: "${uuid}"`);

            const target = path.join(this.unpackedDir, `${uuid}.sdPlugin`);
            fs.rmSync(target, { recursive: true, force: true });
            fs.cpSync(extractedRoot, target, { recursive: true });
            console.log(`[Plugins] Instalado ${uuid} (${label})`);
            return this.describe(target);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    /** Extrai o zip: adm-zip e, se ele não entender o formato (data descriptors), python3 zipfile ou unzip. */
    extractZip(buffer, dir) {
        try {
            new AdmZip(buffer).extractAllTo(dir, true);
            return;
        } catch (e) {
            const zipPath = path.join(dir, '.package.zip');
            fs.writeFileSync(zipPath, buffer);
            const attempts = [
                ['python3', ['-m', 'zipfile', '-e', zipPath, dir]],
                ['unzip', ['-o', '-q', zipPath, '-d', dir]]
            ];
            let lastError = e;
            for (const [cmd, args] of attempts) {
                try {
                    // Síncrono porque a instalação toda é síncrona; só chega aqui quando o adm-zip não lê o zip
                    execFileSync(cmd, args, { stdio: 'ignore', timeout: 30000 });
                    fs.rmSync(zipPath, { force: true });
                    return;
                } catch (err) { lastError = err; }
            }
            throw new Error(`Arquivo inválido: não é um .streamDeckPlugin (zip) legível (${lastError.message})`);
        }
    }

    /** manifest.json mais raso dentro da pasta extraída (ignora __MACOSX). */
    findManifest(dir, depth = 0) {
        if (depth > 3) return null;
        const direct = path.join(dir, 'manifest.json');
        if (fs.existsSync(direct)) return direct;
        const subdirs = this.safeReaddir(dir).filter(n => !n.startsWith('.') && n !== '__MACOSX').map(n => path.join(dir, n)).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } });
        // preferir pastas *.sdPlugin
        subdirs.sort((a, b) => (b.endsWith('.sdPlugin') ? 1 : 0) - (a.endsWith('.sdPlugin') ? 1 : 0));
        for (const sub of subdirs) {
            const found = this.findManifest(sub, depth + 1);
            if (found) return found;
        }
        return null;
    }

    /** Baixa um .streamDeckPlugin (ou zip) de uma URL e instala. */
    async installFromUrl(url) {
        if (!/^https?:\/\//i.test(String(url))) throw new Error('URL inválida');
        const MAX_BYTES = 300 * 1024 * 1024;
        const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'MatDeck' }, signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`Download falhou: HTTP ${res.status}`);
        const declared = Number(res.headers.get('content-length') || 0);
        if (declared > MAX_BYTES) throw new Error('Pacote grande demais (limite 300 MB)');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) throw new Error('Pacote grande demais (limite 300 MB)');
        return this.installFromBuffer(buf, url);
    }

    remove(uuid) {
        const dir = this.dirOf(uuid);
        if (!dir) return false;
        fs.rmSync(dir, { recursive: true, force: true });
        // também apaga um .streamDeckPlugin solto com o mesmo nome, para não reextrair
        for (const f of this.safeReaddir(this.pluginsDir)) {
            if (f.endsWith('.streamDeckPlugin') && path.basename(f, '.streamDeckPlugin') === uuid) {
                fs.rmSync(path.join(this.pluginsDir, f), { force: true });
            }
        }
        console.log(`[Plugins] Removido ${uuid}`);
        return true;
    }

    dirOf(uuid) {
        const safe = String(uuid || '');
        if (!safe || safe.includes('/') || safe.includes('..')) return null;
        for (const cand of [path.join(this.unpackedDir, `${safe}.sdPlugin`), path.join(this.unpackedDir, safe)]) {
            if (fs.existsSync(path.join(cand, 'manifest.json'))) return cand;
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Leitura
    // ------------------------------------------------------------------

    scanPlugins() {
        const plugins = [];
        if (!fs.existsSync(this.pluginsDir)) return plugins;

        // .streamDeckPlugin soltos na pasta: extrai uma vez (e renomeia para não repetir)
        for (const file of this.safeReaddir(this.pluginsDir)) {
            if (!file.endsWith('.streamDeckPlugin')) continue;
            const fullPath = path.join(this.pluginsDir, file);
            try {
                this.installFromBuffer(fs.readFileSync(fullPath), file);
                fs.renameSync(fullPath, `${fullPath}.installed`);
            } catch (e) {
                console.error(`[Plugins] Erro ao instalar ${file}:`, e.message);
            }
        }

        for (const folder of this.safeReaddir(this.unpackedDir)) {
            const pluginPath = path.join(this.unpackedDir, folder);
            try {
                if (!fs.statSync(pluginPath).isDirectory()) continue;
            } catch (e) { continue; }
            const meta = this.describe(pluginPath);
            if (meta) plugins.push(meta);
        }

        console.log(`[Plugins] ${plugins.length} plugin(s) Elgato instalados, ${plugins.filter(p => p.supported).length} compatíveis.`);
        return plugins;
    }

    describe(pluginPath) {
        const manifest = this.loadManifest(pluginPath);
        if (!manifest) return null;
        const codePath = manifest.CodePath || '';
        const ext = path.extname(codePath).toLowerCase();
        let runtime = 'binary';
        if (['.js', '.mjs', '.cjs'].includes(ext)) runtime = 'node';
        else if (['.html', '.htm'].includes(ext)) runtime = 'html';

        let reason = null;
        if (runtime === 'binary') reason = 'plugin nativo (Windows/macOS): não roda no Linux';
        else if (runtime === 'html') reason = 'plugin HTML/JavaScript antigo: precisa de navegador, ainda não suportado';
        else if (!fs.existsSync(path.join(pluginPath, codePath))) reason = `arquivo ${codePath} não existe no pacote`;

        const uuid = manifest.UUID || path.basename(pluginPath).replace(/\.sdPlugin$/, '');
        return {
            id: uuid,
            uuid,
            name: manifest.Name || uuid,
            version: manifest.Version || '1.0',
            author: manifest.Author || 'Desconhecido',
            category: manifest.Category || '',
            description: manifest.Description || '',
            icon: manifest.Icon ? this.resolveIcon(pluginPath, manifest.Icon) : null,
            categoryIcon: manifest.CategoryIcon ? this.resolveIcon(pluginPath, manifest.CategoryIcon) : null,
            codePath,
            runtime,
            nodejs: manifest.Nodejs || null,
            sdkVersion: manifest.SDKVersion || 2,
            os: Array.isArray(manifest.OS) ? manifest.OS.map(o => o.Platform).filter(Boolean) : [],
            supported: !reason,
            reason,
            path: pluginPath,
            propertyInspectorPath: manifest.PropertyInspectorPath || null,
            actions: this.parseActions(manifest, pluginPath)
        };
    }

    loadManifest(pluginPath) {
        const manifestPath = path.join(pluginPath, 'manifest.json');
        if (!fs.existsSync(manifestPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e) {
            console.error(`[Plugins] Erro ao ler manifest em ${pluginPath}:`, e.message);
            return null;
        }
    }

    parseActions(manifest, pluginPath) {
        if (!Array.isArray(manifest.Actions)) return [];
        return manifest.Actions.filter(a => a && a.UUID).map((action) => {
            const states = (action.States || []).map(st => ({
                title: st.Title || '',
                image: st.Image ? this.resolveIcon(pluginPath, st.Image) : null,
                showTitle: st.ShowTitle !== false,
                titleAlignment: st.TitleAlignment || 'bottom',
                fontSize: st.FontSize ? Number(st.FontSize) : 10,
                titleColor: st.TitleColor || '#ffffff'
            }));
            return {
                uuid: action.UUID,
                name: action.Name || action.UUID,
                tooltip: action.Tooltip || '',
                icon: action.Icon ? this.resolveIcon(pluginPath, action.Icon) : null,
                propertyInspectorPath: action.PropertyInspectorPath || manifest.PropertyInspectorPath || null,
                disableAutomaticStates: !!action.DisableAutomaticStates,
                userTitleEnabled: action.UserTitleEnabled !== false,
                visibleInActionsList: action.VisibleInActionsList !== false,
                controllers: Array.isArray(action.Controllers) && action.Controllers.length ? action.Controllers : ['Keypad'],
                supportedInMultiActions: action.SupportedInMultiActions !== false,
                states
            };
        });
    }

    /** Imagem do plugin como data URL. Aceita caminho sem extensão (PNG, @2x, SVG, GIF). */
    resolveIcon(pluginPath, iconRelativePath) {
        const rel = String(iconRelativePath).replace(/^\/+/, '');
        const candidates = [rel, `${rel}@2x.png`, `${rel}.png`, `${rel}.svg`, `${rel}.gif`, `${rel}.jpg`];
        for (const c of candidates) {
            const candidate = path.resolve(pluginPath, c);
            if (!candidate.startsWith(path.resolve(pluginPath))) continue;
            try {
                if (!fs.statSync(candidate).isFile()) continue;
                const buffer = fs.readFileSync(candidate);
                const ext = path.extname(candidate).toLowerCase();
                const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.gif' ? 'image/gif' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
                return `data:${mime};base64,${buffer.toString('base64')}`;
            } catch (e) { /* tenta o próximo */ }
        }
        return null;
    }

    safeReaddir(dir) {
        try { return fs.readdirSync(dir); } catch (e) { return []; }
    }
}

module.exports = PluginLoader;
