const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');
const EventEmitter = require('events');

const DEFAULTS = {
    teamspeak: {
        mode: 'auto',            // 'auto' | 'remote' (TS5/TS6 Remote Apps) | 'clientquery' (TS3)
        host: '127.0.0.1',
        remotePort: 5899,
        clientQueryPort: 25639,
        apiKey: '',              // concedida pelo TS5/TS6 após o usuário autorizar
        clientQueryApiKey: '',   // Tools > Options > Addons > ClientQuery (TS3)
        serverAddress: '',       // host[:porta] do seu servidor TeamSpeak, para os links ts3server:// (a API não expõe o host)
        pttMode: 'toggle'        // 'toggle' = um toque liga, outro desliga | 'hold' = segurar para falar
    },
    discord: {
        pttKey: 'ctrl+shift+p',  // reserva por teclado: precisa ser o mesmo atalho configurado no Discord
        clientId: '',            // aplicativo criado em discord.com/developers (controle nativo por IPC)
        clientSecret: '',
        redirectUri: 'http://localhost',
        accessToken: '',         // preenchidos pelo MatDeck após a autorização
        refreshToken: '',
        tokenExpiresAt: 0
    },
    meet: {
        allowCloseTab: false
    },
    nextcloud: {
        url: '',                 // endereço do Talk para a tecla "Abrir Talk" (ex.: https://cloud.exemplo.com/apps/spreed)
        focusDelayMs: 150
    },
    obs: {
        url: 'ws://127.0.0.1:4455',
        password: ''
    },
    ai: {
        pollSeconds: 60,         // consulta de consumo Claude/Codex (mesmo intervalo do plugin da Elgato)
        claudeCredentialsPath: '', // vazio = ~/.claude/.credentials.json (Claude Code)
        codexAuthPath: '',       // vazio = ~/.codex/auth.json (Codex CLI)
        refreshClaudeToken: true, // renovar o token OAuth do Claude vencido e gravar no arquivo
        warnPercent: 70,
        criticalPercent: 90
    },
    data: {
        url: 'http://127.0.0.1:8765' // servidor da Data (assistente de voz); MATDECK_DATA_URL tem precedência
    },
    fans: {
        enabled: true,
        host: '127.0.0.1',
        port: 11987,             // API do coolercontrold
        token: '',               // access token do CoolerControl; vazio = usa o da GUI (~/.config/org.coolercontrol.CoolerControl)
        excludePattern: 'pump|bomba|aio', // canais com esse rótulo nunca são controlados pelo fader
        minPercent: 20,          // piso de segurança do fader
        restore: {}              // perfil/curva de cada canal antes do controle manual
    },
    server: {
        allowedHosts: []         // nomes/IPs extras aceitos no cabeçalho Host (localhost, IPs locais e o hostname já valem)
    },
    ui: {
        hiddenProfiles: [],      // ids de perfis que não aparecem no tablet (abas, ciclo ◀ ▶, auto-perfil)
        removedProfiles: [],     // abas embutidas excluídas pelo usuário (somem do tablet e do gerenciador; restauráveis)
        autoDetect: false,       // Auto-Perfil (troca pela janela em foco) ligado; nasce desligado e lembra o último estado
        autoProfiles: {},        // app detectado -> perfil a ativar ('' = o perfil de mesmo nome, 'none' = não trocar)
        tray: true               // ícone na bandeja do sistema enquanto o servidor roda (scripts/matdeck-tray.py)
    }
};

function deepMerge(target, source) {
    const out = { ...target };
    for (const key of Object.keys(source || {})) {
        const value = source[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            out[key] = deepMerge(target[key] || {}, value);
        } else if (value !== undefined) {
            out[key] = value;
        }
    }
    return out;
}

class ConfigStore extends EventEmitter {
    constructor(filePath) {
        super();
        this.filePath = filePath || path.join(dataDir(), 'config.json');
        this.data = deepMerge(DEFAULTS, {});
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                this.data = deepMerge(DEFAULTS, raw);
            }
        } catch (e) {
            const backup = `${this.filePath}.corrompido-${Date.now()}`;
            try { fs.renameSync(this.filePath, backup); } catch (e2) { /* segue sem backup */ }
            console.error(`[Config] config.json ilegível (${e.message}); guardado em ${backup}, usando padrões.`);
        }

        // Variáveis de ambiente têm precedência (útil para não gravar segredos em disco)
        if (process.env.TS_API_KEY) this.data.teamspeak.apiKey = process.env.TS_API_KEY;
        if (process.env.TS_CLIENTQUERY_API_KEY) this.data.teamspeak.clientQueryApiKey = process.env.TS_CLIENTQUERY_API_KEY;
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const tmp = `${this.filePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, this.filePath);
        } catch (e) {
            console.error('[Config] Erro ao gravar config.json:', e.message);
        }
    }

    all() {
        return JSON.parse(JSON.stringify(this.data));
    }

    get(section) {
        const value = this.data[section];
        return value ? JSON.parse(JSON.stringify(value)) : {};
    }

    set(section, partial) {
        this.data[section] = deepMerge(this.data[section] || {}, partial || {});
        this.save();
        this.emit('change', { section, value: this.get(section) });
        return this.get(section);
    }

    update(partialAll) {
        for (const section of Object.keys(partialAll || {})) {
            if (!DEFAULTS[section]) continue;
            this.set(section, partialAll[section]);
        }
        return this.all();
    }
}

module.exports = ConfigStore;
