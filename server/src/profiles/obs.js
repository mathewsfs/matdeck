const OBSWebSocket = require('obs-websocket-js').default;
const icons = require('../icons.json');

const RECONNECT_MS = 5000;
const SCENE_KEYS = 5; // linha 2 da grade: índices 5..9

class OBSProfile {
    constructor(serverContext) {
        this.ctx = serverContext;
        this.obs = new OBSWebSocket();
        this.connected = false;
        this.connecting = false;
        this.reconnectTimer = null;

        this.streaming = false;
        this.recording = false;
        this.recordPaused = false;
        this.micMuted = false;
        this.desktopMuted = false;
        this.activeScene = '';
        this.scenes = [];            // nomes das cenas, na ordem exibida no OBS
        this.micInputName = null;
        this.desktopInputName = null;
        this.camItem = null;         // { sceneName, sceneItemId, enabled }
        this.lastConnectError = '';  // motivo da última falha (logado só quando muda)
        this.loggedOnce = new Set();

        this.registerListeners();   // uma vez só: o emitter sobrevive às reconexões
        this.connect();
    }

    getUrl() {
        const cfg = (this.ctx.config && this.ctx.config.get('obs')) || {};
        return cfg.url || process.env.OBS_WS_URL || 'ws://127.0.0.1:4455';
    }

    getPassword() {
        const cfg = (this.ctx.config && this.ctx.config.get('obs')) || {};
        return cfg.password || process.env.OBS_WS_PASSWORD || undefined;
    }

    async connect() {
        if (this.connected || this.connecting) return;
        this.connecting = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        try {
            await this.obs.connect(this.getUrl(), this.getPassword(), { rpcVersion: 1 });
            this.connected = true;
            console.log('[OBS] Conectado ao OBS Studio WebSocket v5!');
            await this.refreshState();
            this.pushStatusKey();
        } catch (err) {
            // Senha/URL errada ou OBS sem WebSocket: avisa na primeira falha e quando o motivo muda,
            // em vez de tentar a cada 5 s em silêncio
            const msg = `${err && err.code ? err.code + ' ' : ''}${(err && err.message) || err}`.trim();
            if (msg !== this.lastConnectError) {
                this.lastConnectError = msg;
                console.log(`[OBS] Não conectou em ${this.getUrl()}: ${msg}. Tentando de novo a cada ${RECONNECT_MS / 1000} s.`);
            }
            this.connected = false;
            this.scheduleReconnect();
        } finally {
            this.connecting = false;
        }
    }

    /** Loga uma mensagem uma vez por chave (evita repetir a cada atualização). */
    logOnce(key, text) {
        if (this.loggedOnce.has(key)) return;
        this.loggedOnce.add(key);
        console.log(text);
    }

    stop() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.stopped = true;
        try { this.obs.disconnect(); } catch (e) { /* já fechado */ }
    }

    scheduleReconnect() {
        if (this.reconnectTimer || this.stopped) return; // já existe UMA cadeia de retry
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, RECONNECT_MS);
    }

    registerListeners() {
        this.obs.on('ConnectionClosed', () => {
            // Também dispara em cada tentativa de conexão que falha: só reage quando estava conectado
            if (this.connected) {
                console.log('[OBS] Conexão fechada. Tentando reconectar...');
                this.connected = false;
                this.lastConnectError = '';
                this.pushStatusKey();
            }
            this.scheduleReconnect();
        });
        this.obs.on('ConnectionError', () => {
            this.connected = false;
            this.scheduleReconnect();
        });

        this.obs.on('StreamStateChanged', (data) => {
            this.streaming = data.outputActive;
            this.ctx.updateKey('obs', 0, this.streamKeyState());
        });

        this.obs.on('RecordStateChanged', (data) => {
            this.recording = data.outputActive;
            if (!this.recording) this.recordPaused = false;
            this.ctx.updateKey('obs', 1, this.recordKeyState());
            this.ctx.updateKey('obs', 2, this.pauseKeyState());
        });

        this.obs.on('CurrentProgramSceneChanged', (data) => {
            this.activeScene = data.sceneName;
            this.updateSceneKeys();
            this.refreshCamItem();
        });

        this.obs.on('SceneListChanged', () => this.refreshScenes());
        this.obs.on('SceneNameChanged', () => this.refreshScenes());

        this.obs.on('InputMuteStateChanged', (data) => {
            if (data.inputName === this.micInputName) {
                this.micMuted = data.inputMuted;
                this.ctx.updateKey('obs', 10, this.micKeyState());
            } else if (data.inputName === this.desktopInputName) {
                this.desktopMuted = data.inputMuted;
                this.ctx.updateKey('obs', 11, this.desktopKeyState());
            }
        });

        this.obs.on('SceneItemEnableStateChanged', (data) => {
            if (this.camItem && data.sceneName === this.camItem.sceneName && data.sceneItemId === this.camItem.sceneItemId) {
                this.camItem.enabled = data.sceneItemEnabled;
                this.ctx.updateKey('obs', 12, this.camKeyState());
            }
        });
    }

    async refreshState() {
        if (!this.connected) return;
        try {
            const [stream, record, scene] = await Promise.all([
                this.obs.call('GetStreamStatus'),
                this.obs.call('GetRecordStatus'),
                this.obs.call('GetCurrentProgramScene')
            ]);
            this.streaming = stream.outputActive;
            this.recording = record.outputActive;
            this.recordPaused = !!record.outputPaused;
            this.activeScene = scene.currentProgramSceneName;

            await this.refreshScenes();
            await this.refreshAudioInputs();
            await this.refreshCamItem();

            this.ctx.updateKey('obs', 0, this.streamKeyState());
            this.ctx.updateKey('obs', 1, this.recordKeyState());
            this.ctx.updateKey('obs', 2, this.pauseKeyState());
            this.ctx.updateKey('obs', 10, this.micKeyState());
            this.ctx.updateKey('obs', 11, this.desktopKeyState());
            this.ctx.updateKey('obs', 12, this.camKeyState());
        } catch (e) {
            console.error('[OBS] Erro ao sincronizar estado:', e.message);
        }
    }

    async refreshScenes() {
        try {
            const list = await this.obs.call('GetSceneList');
            // sceneIndex 0 é a última da lista no OBS; invertemos para a ordem visual
            this.scenes = (list.scenes || [])
                .slice()
                .sort((a, b) => b.sceneIndex - a.sceneIndex)
                .map(s => s.sceneName);
            if (list.currentProgramSceneName) this.activeScene = list.currentProgramSceneName;
            this.updateSceneKeys();
        } catch (e) {
            this.logOnce('scenes', `[OBS] Não foi possível ler as cenas: ${e.message}`);
        }
    }

    async refreshAudioInputs() {
        try {
            const { inputs } = await this.obs.call('GetInputList');
            const byName = (re) => {
                const found = inputs.find(i => re.test(i.inputName));
                return found ? found.inputName : null;
            };
            const byKind = (re) => {
                const found = inputs.find(i => re.test(i.inputKind || ''));
                return found ? found.inputName : null;
            };
            this.micInputName = byName(/mic|microfone|microphone|aux/i) || byKind(/input_capture/i);
            this.desktopInputName = byName(/desktop|área de trabalho|saida|saída|output/i) || byKind(/output_capture/i);

            if (this.micInputName) {
                const m = await this.obs.call('GetInputMute', { inputName: this.micInputName });
                this.micMuted = m.inputMuted;
            }
            if (this.desktopInputName) {
                const d = await this.obs.call('GetInputMute', { inputName: this.desktopInputName });
                this.desktopMuted = d.inputMuted;
            }
        } catch (e) {
            this.logOnce('inputs', `[OBS] Não foi possível ler as fontes de áudio: ${e.message}`);
        }
    }

    async refreshCamItem() {
        this.camItem = null;
        if (!this.connected || !this.activeScene) return;
        try {
            const { sceneItems } = await this.obs.call('GetSceneItemList', { sceneName: this.activeScene });
            const cam = sceneItems.find(i => /v4l2_input|dshow_input|av_capture_input|pipewire-camera/i.test(i.inputKind || ''))
                || sceneItems.find(i => /cam|webcam|câmera|camera/i.test(i.sourceName || ''));
            if (cam) {
                this.camItem = { sceneName: this.activeScene, sceneItemId: cam.sceneItemId, enabled: cam.sceneItemEnabled };
            }
        } catch (e) {
            this.logOnce('cam', `[OBS] Não foi possível ler a câmera da cena: ${e.message}`);
        }
        this.ctx.updateKey('obs', 12, this.camKeyState());
    }

    // --- Estados visuais das teclas -------------------------------------

    streamKeyState() {
        return {
            badge: this.streaming ? 'LIVE' : null,
            badgeColor: '#10B981',
            active: this.streaming,
            titleColor: this.streaming ? '#10B981' : '#FFFFFF'
        };
    }

    recordKeyState() {
        return {
            badge: this.recording ? (this.recordPaused ? 'PAUSA' : 'REC') : null,
            badgeColor: this.recordPaused ? '#F59E0B' : '#EF4444',
            active: this.recording,
            titleColor: this.recording ? '#EF4444' : '#FFFFFF'
        };
    }

    pauseKeyState() {
        return {
            title: this.recordPaused ? 'Retomar' : 'Pausar',
            active: this.recordPaused,
            badge: this.recordPaused ? 'PAUSA' : null,
            badgeColor: '#F59E0B'
        };
    }

    micKeyState() {
        const muted = this.micMuted;
        return {
            title: muted ? 'Mic MUTADO' : (this.micInputName ? 'Mic Ativo' : 'Mic (sem input)'),
            icon: muted ? icons.mic_muted : icons.mic_on,
            titleColor: '#FFFFFF',
            bgColor: muted ? '#DC2626' : '#1C1D25',
            borderColor: muted ? '#F87171' : '#2D303E',
            badge: muted ? 'MUDO' : null,
            badgeColor: '#7F1D1D',
            active: muted
        };
    }

    desktopKeyState() {
        const muted = this.desktopMuted;
        return {
            title: muted ? 'Áudio PC MUDO' : 'Áudio PC',
            bgColor: muted ? '#DC2626' : '#1C1D25',
            borderColor: muted ? '#F87171' : '#2D303E',
            badge: muted ? 'MUDO' : null,
            badgeColor: '#7F1D1D',
            active: muted
        };
    }

    camKeyState() {
        if (!this.camItem) {
            return { title: 'Webcam', icon: icons.cam_on, badge: null, active: false, bgColor: '#1C1D25', borderColor: '#2D303E' };
        }
        const on = this.camItem.enabled;
        return {
            title: on ? 'Webcam ON' : 'Webcam OFF',
            icon: on ? icons.cam_on : icons.cam_muted,
            badge: on ? null : 'OFF',
            badgeColor: '#7F1D1D',
            bgColor: on ? '#1C1D25' : '#DC2626',
            borderColor: on ? '#2D303E' : '#F87171',
            active: !on
        };
    }

    statusKeyState() {
        return {
            badge: this.connected ? 'ON' : 'OFF',
            badgeColor: this.connected ? '#10B981' : '#6B7280',
            title: this.connected ? 'OBS Conectado' : 'OBS Offline'
        };
    }

    pushStatusKey() {
        this.ctx.updateKey('obs', 14, this.statusKeyState());
    }

    updateSceneKeys() {
        for (let i = 0; i < SCENE_KEYS; i++) {
            const sceneName = this.scenes[i];
            const isActive = !!sceneName && this.activeScene === sceneName;
            this.ctx.updateKey('obs', 5 + i, {
                title: sceneName || '',
                actionId: sceneName ? `obs:scene:${i}` : '',
                active: isActive,
                borderColor: isActive ? '#3B82F6' : '#2D303E',
                badge: isActive ? 'AO VIVO' : null,
                badgeColor: '#3B82F6'
            });
        }
    }

    getStatus() {
        return { connected: this.connected, url: this.getUrl(), scenes: this.scenes.length };
    }

    getDefinition() {
        const sceneKey = (i) => {
            const name = this.scenes[i];
            const isActive = !!name && this.activeScene === name;
            return {
                index: 5 + i,
                title: name || '',
                icon: icons.scene,
                actionId: name ? `obs:scene:${i}` : '',
                active: isActive,
                borderColor: isActive ? '#3B82F6' : '#2D303E',
                badge: isActive ? 'AO VIVO' : null,
                badgeColor: '#3B82F6'
            };
        };

        return {
            id: 'obs',
            name: 'OBS Studio',
            rows: 3,
            cols: 5,
            keys: [
                { index: 0, title: 'Stream', icon: icons.stream, actionId: 'obs:stream', ...this.streamKeyState() },
                { index: 1, title: 'Gravar', icon: icons.rec, actionId: 'obs:record', ...this.recordKeyState() },
                { index: 2, icon: icons.pause, actionId: 'obs:pause_rec', ...this.pauseKeyState() },
                { index: 3, title: 'Replay', icon: icons.replay, actionId: 'obs:replay' },
                { index: 4, title: 'Modo Estúdio', icon: icons.studio, actionId: 'obs:studio_mode' },

                sceneKey(0), sceneKey(1), sceneKey(2), sceneKey(3), sceneKey(4),

                { index: 10, actionId: 'obs:mute_mic', ...this.micKeyState() },
                { index: 11, icon: icons.volume, actionId: 'obs:mute_desktop', ...this.desktopKeyState() },
                { index: 12, actionId: 'obs:toggle_cam', ...this.camKeyState() },
                { index: 13, title: 'Screenshot', icon: icons.screenshot, actionId: 'obs:screenshot' },
                { index: 14, icon: icons.obs, actionId: 'obs:status', ...this.statusKeyState() }
            ]
        };
    }

    async handleAction(actionId, eventType) {
        if (eventType !== 'keyDown') return;

        if (!this.connected) {
            console.log(`[OBS] Ação ${actionId} ignorada: OBS não conectado (${this.getUrl()}).`);
            this.connect();
            return;
        }

        try {
            if (actionId === 'obs:stream') {
                await this.obs.call('ToggleStream');
            } else if (actionId === 'obs:record') {
                await this.obs.call('ToggleRecord');
            } else if (actionId === 'obs:pause_rec') {
                if (!this.recording) return;
                await this.obs.call('ToggleRecordPause');
                const st = await this.obs.call('GetRecordStatus');
                this.recordPaused = !!st.outputPaused;
                this.ctx.updateKey('obs', 1, this.recordKeyState());
                this.ctx.updateKey('obs', 2, this.pauseKeyState());
            } else if (actionId === 'obs:replay') {
                await this.obs.call('SaveReplayBuffer');
            } else if (actionId === 'obs:studio_mode') {
                const st = await this.obs.call('GetStudioModeEnabled');
                await this.obs.call('SetStudioModeEnabled', { studioModeEnabled: !st.studioModeEnabled });
                this.ctx.updateKey('obs', 4, { active: !st.studioModeEnabled });
            } else if (actionId.startsWith('obs:scene:')) {
                const idx = parseInt(actionId.split(':')[2], 10);
                if (this.scenes[idx]) {
                    await this.obs.call('SetCurrentProgramScene', { sceneName: this.scenes[idx] });
                }
            } else if (actionId === 'obs:mute_mic') {
                if (!this.micInputName) await this.refreshAudioInputs();
                if (this.micInputName) await this.obs.call('ToggleInputMute', { inputName: this.micInputName });
            } else if (actionId === 'obs:mute_desktop') {
                if (!this.desktopInputName) await this.refreshAudioInputs();
                if (this.desktopInputName) await this.obs.call('ToggleInputMute', { inputName: this.desktopInputName });
            } else if (actionId === 'obs:toggle_cam') {
                if (!this.camItem) await this.refreshCamItem();
                if (this.camItem) {
                    await this.obs.call('SetSceneItemEnabled', {
                        sceneName: this.camItem.sceneName,
                        sceneItemId: this.camItem.sceneItemId,
                        sceneItemEnabled: !this.camItem.enabled
                    });
                }
            } else if (actionId === 'obs:screenshot') {
                const dir = process.env.HOME || '.';
                await this.obs.call('SaveSourceScreenshot', {
                    sourceName: this.activeScene,
                    imageFormat: 'png',
                    imageFilePath: `${dir}/matdeck_screenshot_${Date.now()}.png`
                });
                this.ctx.updateKey('obs', 13, { badge: 'OK', badgeColor: '#10B981' });
                setTimeout(() => this.ctx.updateKey('obs', 13, { badge: null }), 1500);
            } else if (actionId === 'obs:status') {
                await this.refreshState();
                this.pushStatusKey();
            }
        } catch (e) {
            console.error(`[OBS] Erro ao executar ${actionId}:`, e.message);
        }
    }
}

module.exports = OBSProfile;
