const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');
const EventEmitter = require('events');
const icons = require('./icons.json');

const LIMITS = { minRows: 1, maxRows: 5, minCols: 1, maxCols: 8 };
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/;

class PresetManager extends EventEmitter {
    constructor(dataPath, reservedIds = []) {
        super();
        this.dataPath = dataPath || path.join(dataDir(), 'presets.json');
        this.reservedIds = new Set(reservedIds); // ids dos perfis embutidos (obs, discord...)
        this.presets = new Map();
        this.init();
    }

    init() {
        fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });

        if (fs.existsSync(this.dataPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
                for (const key of Object.keys(data)) {
                    if (this.reservedIds.has(key)) continue; // lixo salvo por versões antigas
                    this.presets.set(key, this.normalize(key, data[key]));
                }
            } catch (e) {
                // Não regravar por cima: o arquivo ilegível fica guardado para recuperação manual
                const backup = `${this.dataPath}.corrompido-${Date.now()}`;
                try { fs.renameSync(this.dataPath, backup); } catch (e2) { /* segue sem backup */ }
                console.error(`[PresetManager] presets.json ilegível (${e.message}); guardado em ${backup}. Iniciando sem presets salvos.`);
                this.presets.clear();
                return;
            }
        }
        this.save();
    }

    isReserved(id) {
        return this.reservedIds.has(id);
    }

    static isValidId(id) {
        return typeof id === 'string' && ID_PATTERN.test(id);
    }

    normalize(id, data) {
        const preset = { ...(data || {}) };
        for (const f of ['builtin', 'editable', 'overridden', 'hidden']) delete preset[f]; // flags de leitura, não fazem parte do preset
        preset.id = id;
        preset.name = typeof preset.name === 'string' && preset.name.trim() ? preset.name.trim().slice(0, 60) : id;
        preset.rows = Math.min(LIMITS.maxRows, Math.max(LIMITS.minRows, parseInt(preset.rows, 10) || 3));
        preset.cols = Math.min(LIMITS.maxCols, Math.max(LIMITS.minCols, parseInt(preset.cols, 10) || 5));
        preset.showHardwareHud = preset.showHardwareHud !== false;
        if (!Array.isArray(preset.keys)) preset.keys = [];

        const totalKeys = preset.rows * preset.cols;
        const normalizedKeys = [];
        for (let i = 0; i < totalKeys; i++) {
            const existing = preset.keys.find(k => k && k.index === i);
            const key = existing ? { ...existing, index: i } : { index: i, title: '' };
            if (key.actionId != null && typeof key.actionId !== 'string') delete key.actionId;
            normalizedKeys.push(key);
        }
        preset.keys = normalizedKeys;
        return preset;
    }

    getAll() {
        const obj = {};
        for (const [id, preset] of this.presets.entries()) obj[id] = preset;
        return obj;
    }

    get(id) {
        return this.presets.get(id);
    }

    /** @returns {{ ok: boolean, error?: string, preset?: object }} */
    savePreset(id, presetData) {
        if (!PresetManager.isValidId(id)) {
            return { ok: false, error: 'ID inválido: use letras minúsculas, números, "-" ou "_"' };
        }
        if (this.isReserved(id)) {
            return { ok: false, error: `"${id}" é um perfil embutido. Duplique-o para editar.` };
        }
        const preset = this.normalize(id, presetData);
        this.presets.set(id, preset);
        this.save();
        this.emit('change', { type: 'save', id });
        return { ok: true, preset };
    }

    deletePreset(id) {
        if (this.isReserved(id)) {
            return { ok: false, error: `"${id}" é um perfil embutido e não pode ser excluído.` };
        }
        const deleted = this.presets.delete(id);
        if (deleted) {
            this.save();
            this.emit('change', { type: 'delete', id });
        }
        return { ok: deleted, error: deleted ? undefined : 'Preset não encontrado' };
    }

    save() {
        try {
            // Arquivo temporário + rename: queda no meio da gravação não deixa o presets.json pela metade
            const tmp = `${this.dataPath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.getAll(), null, 2), 'utf8');
            fs.renameSync(tmp, this.dataPath);
        } catch (e) {
            console.error('[PresetManager] Erro ao gravar presets.json:', e.message);
        }
    }
}

module.exports = PresetManager;
