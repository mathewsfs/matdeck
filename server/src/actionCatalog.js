/**
 * Catálogo de ações disponíveis para o gerenciador (estilo Elgato: grupos, rótulos, ícones).
 * Cada item: { id, label, icon, hint?, kind: 'action' | 'indicator' | 'slider' }.
 * Ações dinâmicas (perfis, apps de volume) são montadas em runtime por buildActionCatalog().
 */

const STATIC_GROUPS = [
    {
        id: 'teamspeak', label: 'TeamSpeak', icon: 'teamspeak',
        actions: [
            { id: 'ts:mute_mic', label: 'Microfone', icon: 'mic_on', hint: 'Muta/desmuta o microfone (estado real)' },
            { id: 'ts:mute_sound', label: 'Fones', icon: 'headphone', hint: 'Muta/desmuta o som' },
            { id: 'ts:toggle_away', label: 'AFK', icon: 'afk', hint: 'Liga/desliga ausente' },
            { id: 'ts:ptt', label: 'Push to Talk', icon: 'ptt', hint: 'Toque liga, toque desliga (ou segurar, em Ajustes)' },
            { id: 'ts:whisper', label: 'Whisper', icon: 'whisper', hint: 'Precisa de lista de sussurro vinculada no TS' },
            { id: 'switch:ts-channels', label: 'Salas', icon: 'channel', hint: 'Abre a lista de salas (informativa no TS6)' },
            { id: 'ts:stream', label: 'Transmissão', icon: 'share', kind: 'indicator', hint: 'Mostra se você está transmitindo tela' },
            { id: 'ts:talking', label: 'Quem fala', icon: 'talking', kind: 'indicator' },
            { id: 'ts:status', label: 'Status / Reconectar', icon: 'server', hint: 'Nick e servidor; toque reconecta' },
            { id: 'ts:focus', label: 'Focar janela', icon: 'focus' },
            { id: 'ts:open', label: 'Abrir TeamSpeak', icon: 'open' },
            { id: 'ts:disconnect', label: 'Desconectar', icon: 'disconnect' }
        ]
    },
    {
        id: 'discord', label: 'Discord', icon: 'discord',
        actions: [
            { id: 'discord:toggle_mute', label: 'Microfone', icon: 'mic_on', hint: 'Foca o Discord e envia Ctrl+Shift+M' },
            { id: 'discord:toggle_deafen', label: 'Surdo', icon: 'headphone', hint: 'Ctrl+Shift+D' },
            { id: 'discord:ptt', label: 'Push to Talk', icon: 'ptt', hint: 'Atalho configurável em Ajustes' },
            { id: 'discord:quick_switcher', label: 'Busca rápida', icon: 'grid', hint: 'Ctrl+K' },
            { id: 'discord:inbox', label: 'Caixa de entrada', icon: 'bell', hint: 'Ctrl+I' },
            { id: 'discord:prev_channel', label: 'Canal anterior', icon: 'prev' },
            { id: 'discord:next_channel', label: 'Próximo canal', icon: 'next' },
            { id: 'discord:mark_read', label: 'Marcar como lido', icon: 'chat' },
            { id: 'discord:focus', label: 'Focar janela', icon: 'focus' },
            { id: 'discord:open', label: 'Abrir Discord', icon: 'open' }
        ]
    },
    {
        id: 'meet', label: 'Google Meet', icon: 'meet',
        actions: [
            { id: 'meet:mute_mic', label: 'Microfone', icon: 'mic_on', hint: 'Ctrl+D na aba do Meet' },
            { id: 'meet:camera', label: 'Câmera', icon: 'cam_on', hint: 'Ctrl+E' },
            { id: 'meet:hand', label: 'Levantar mão', icon: 'hand', hint: 'Ctrl+Alt+H' },
            { id: 'meet:captions', label: 'Legendas', icon: 'captions' },
            { id: 'meet:chat', label: 'Chat', icon: 'chat' },
            { id: 'meet:people', label: 'Participantes', icon: 'people' },
            { id: 'meet:shortcuts', label: 'Atalhos', icon: 'settings' },
            { id: 'meet:fullscreen', label: 'Tela cheia', icon: 'open' },
            { id: 'meet:leave', label: 'Sair da chamada', icon: 'hangup', hint: 'Só se "fechar aba" estiver habilitado em Ajustes' },
            { id: 'meet:focus', label: 'Focar aba', icon: 'focus' },
            { id: 'meet:open', label: 'Abrir Meet', icon: 'meet' }
        ]
    },
    {
        id: 'nextcloud', label: 'Nextcloud Talk', icon: 'nextcloud',
        actions: [
            { id: 'nc:mute_mic', label: 'Microfone', icon: 'mic_on', hint: 'Tecla M na janela do Talk (estado otimista)' },
            { id: 'nc:camera', label: 'Câmera', icon: 'cam_on', hint: 'Tecla V' },
            { id: 'nc:hand', label: 'Levantar mão', icon: 'hand', hint: 'Tecla R' },
            { id: 'nc:fullscreen', label: 'Tela cheia', icon: 'open', hint: 'Tecla F' },
            { id: 'nc:chat', label: 'Focar chat', icon: 'chat', hint: 'Tecla C' },
            { id: 'nc:search', label: 'Buscar', icon: 'grid', hint: 'Ctrl+F' },
            { id: 'nc:home', label: 'Início do Talk', icon: 'home', hint: 'Esc' },
            { id: 'nc:focus', label: 'Focar janela', icon: 'focus' },
            { id: 'nc:open', label: 'Abrir Talk', icon: 'browser', hint: 'Endereço em Ajustes → Nextcloud Talk' },
            { id: 'nc:reset', label: 'Reiniciar estado', icon: 'auto', hint: 'Zera mic/câmera/mão mostrados nas teclas' }
        ]
    },
    {
        id: 'spotify', label: 'Spotify', icon: 'spotify',
        actions: [
            { id: 'spotify:now_playing', label: 'Tocando agora', icon: 'music', kind: 'indicator', hint: 'Capa, faixa, artista e progresso; toque pausa/retoma', defaultSpan: { cols: 2, rows: 2 } },
            { id: 'spotify:transport', label: 'Controles (◀ ▶ ▶▶)', icon: 'play', hint: 'Anterior, play/pause e próxima num bloco só (padrão: 2 colunas)', defaultSpan: { cols: 2, rows: 1 } },
            { id: 'spotify:play_pause', label: 'Play / Pause', icon: 'play', hint: 'Estado real do Spotify' },
            { id: 'spotify:next', label: 'Próxima faixa', icon: 'next' },
            { id: 'spotify:prev', label: 'Faixa anterior', icon: 'prev' },
            { id: 'spotify:shuffle', label: 'Aleatório', icon: 'shuffle', hint: 'Liga/desliga o modo aleatório' },
            { id: 'spotify:repeat', label: 'Repetir', icon: 'repeat', hint: 'Desligado → lista → faixa' },
            { id: 'spotify:seek_fwd', label: 'Avançar 10 s', icon: 'seek_fwd' },
            { id: 'spotify:seek_back', label: 'Voltar 10 s', icon: 'seek_back' },
            { id: 'spotify:play:', label: 'Tocar playlist / álbum', icon: 'playlist', hint: 'Cole o link da playlist, álbum, artista ou faixa no campo da tecla' },
            { id: 'vol_slider:spotify', label: 'Fader Spotify', icon: 'spotify', kind: 'slider', hint: 'Arraste para ajustar, toque para mutar' },
            { id: 'vol_step:spotify:+5', label: 'Spotify +5%', icon: 'vol_up' },
            { id: 'vol_step:spotify:-5', label: 'Spotify −5%', icon: 'vol_down' },
            { id: 'spotify:open', label: 'Abrir / focar Spotify', icon: 'spotify' }
        ]
    },
    {
        id: 'obs', label: 'OBS Studio', icon: 'obs',
        actions: [
            { id: 'obs:stream', label: 'Transmitir', icon: 'stream' },
            { id: 'obs:record', label: 'Gravar', icon: 'rec' },
            { id: 'obs:pause_rec', label: 'Pausar gravação', icon: 'pause' },
            { id: 'obs:replay', label: 'Salvar replay', icon: 'replay' },
            { id: 'obs:studio_mode', label: 'Modo estúdio', icon: 'studio' },
            { id: 'obs:scene:0', label: 'Cena 1', icon: 'scene', hint: 'Cenas na ordem do OBS' },
            { id: 'obs:scene:1', label: 'Cena 2', icon: 'scene' },
            { id: 'obs:scene:2', label: 'Cena 3', icon: 'scene' },
            { id: 'obs:scene:3', label: 'Cena 4', icon: 'scene' },
            { id: 'obs:scene:4', label: 'Cena 5', icon: 'scene' },
            { id: 'obs:mute_mic', label: 'Mutar mic', icon: 'mic_on' },
            { id: 'obs:mute_desktop', label: 'Mutar áudio PC', icon: 'volume' },
            { id: 'obs:toggle_cam', label: 'Webcam', icon: 'cam_on' },
            { id: 'obs:screenshot', label: 'Screenshot', icon: 'screenshot' },
            { id: 'obs:status', label: 'Status OBS', icon: 'obs', kind: 'indicator' }
        ]
    },
    {
        id: 'system', label: 'Mídia e Sistema', icon: 'settings',
        actions: [
            { id: 'media:vol_up', label: 'Volume +', icon: 'vol_up' },
            { id: 'media:vol_down', label: 'Volume −', icon: 'vol_down' },
            { id: 'media:mute', label: 'Mudo PC', icon: 'volume_mute' },
            { id: 'media:play_pause', label: 'Play / Pause', icon: 'play' },
            { id: 'media:next', label: 'Próxima faixa', icon: 'next' },
            { id: 'media:prev', label: 'Faixa anterior', icon: 'prev' },
            { id: 'launch:browser', label: 'Navegador', icon: 'browser' },
            { id: 'launch:calc', label: 'Calculadora', icon: 'calc' },
            { id: 'launch:term', label: 'Terminal', icon: 'terminal' },
            { id: 'system:lock', label: 'Bloquear PC', icon: 'lock' },
            { id: 'toggle:auto', label: 'Auto-Perfil', icon: 'auto', hint: 'Liga/desliga a troca automática por janela' }
        ]
    },
    {
        id: 'ai', label: 'Uso de IA (Claude / Codex)', icon: 'claude',
        actions: [
            { id: 'ai:claude', label: 'Claude: todas as janelas', icon: 'claude', kind: 'indicator', hint: 'Sessão de 5 h, semana e limite por modelo (ex.: Fable), com horário de reinício. Toque atualiza', defaultSpan: { cols: 2, rows: 2 } },
            { id: 'ai:claude_5h', label: 'Claude · 5 h', icon: 'claude', kind: 'indicator', hint: 'Janela de 5 horas do Claude Code' },
            { id: 'ai:claude_7d', label: 'Claude · semana', icon: 'claude', kind: 'indicator', hint: 'Janela semanal (todos os modelos)' },
            { id: 'ai:claude_model', label: 'Claude · modelo', icon: 'claude', kind: 'indicator', hint: 'Limite semanal do modelo (ex.: Fable)' },
            { id: 'ai:codex', label: 'Codex: todas as janelas', icon: 'openai', kind: 'indicator', hint: 'Janelas de uso do Codex CLI (ChatGPT). Toque atualiza', defaultSpan: { cols: 2, rows: 2 } },
            { id: 'ai:codex_primary', label: 'Codex · janela principal', icon: 'openai', kind: 'indicator' },
            { id: 'ai:codex_secondary', label: 'Codex · janela secundária', icon: 'openai', kind: 'indicator', hint: 'Só existe em alguns planos' }
        ]
    },
    {
        id: 'fans', label: 'Ventoinhas (CoolerControl)', icon: 'fan',
        actions: [
            { id: 'vol_slider:fans', label: 'Fader ventoinhas', icon: 'fan', kind: 'slider', hint: 'Todas as ventoinhas na mesma velocidade; toque volta ao automático (curvas do CoolerControl)' },
            { id: 'vol_step:fans:+10', label: 'Ventoinhas +10%', icon: 'vol_up' },
            { id: 'vol_step:fans:-10', label: 'Ventoinhas −10%', icon: 'vol_down' },
            { id: 'fans:set:100', label: 'Ventoinhas 100%', icon: 'fan', hint: 'Velocidade máxima em todas' },
            { id: 'fans:set:50', label: 'Ventoinhas 50%', icon: 'fan' },
            { id: 'fans:auto', label: 'Ventoinhas automático', icon: 'auto', hint: 'Volta às curvas/perfis do CoolerControl' }
        ]
    },
    {
        id: 'stats', label: 'Telemetria', icon: 'stats',
        actions: [
            { id: 'stats:cpu', label: 'CPU uso + gráfico', icon: 'cpu', kind: 'indicator', hint: 'Uso em %, temperatura e histórico de 60 s' },
            { id: 'stats:cores', label: 'CPU por núcleo', icon: 'cpu', kind: 'indicator', hint: 'Uma barra por núcleo' },
            { id: 'stats:cpu_temp', label: 'CPU temperatura', icon: 'temp', kind: 'indicator' },
            { id: 'stats:gpu', label: 'GPU uso + temp', icon: 'gpu', kind: 'indicator' },
            { id: 'stats:gpu_temp', label: 'GPU temperatura', icon: 'temp', kind: 'indicator' },
            { id: 'stats:vram', label: 'VRAM', icon: 'gpu', kind: 'indicator' },
            { id: 'stats:ram', label: 'RAM', icon: 'ram', kind: 'indicator' },
            { id: 'stats:ram_free', label: 'RAM livre', icon: 'ram', kind: 'indicator' },
            { id: 'stats:net', label: 'Rede ↓ ↑', icon: 'stats', kind: 'indicator', hint: 'Download e upload com gráfico de 60 s' },
            { id: 'stats:disk', label: 'Disco R / W', icon: 'stats', kind: 'indicator', hint: 'Leitura e escrita com gráfico de 60 s' }
        ]
    }
];

/**
 * @param {object} ctx  { profileList: array, audioApps: object, apps: array }
 */
function buildActionCatalog(ctx) {
    const groups = STATIC_GROUPS.map(g => ({ ...g, actions: g.actions.map(a => ({ kind: 'action', ...a })) }));

    // Volume por aplicativo (faders e passos)
    const volume = { id: 'volume', label: 'Volume por app', icon: 'volume', actions: [] };
    for (const app of Object.values(ctx.audioApps || {})) {
        volume.actions.push({ id: `vol_slider:${app.id}`, label: `Fader ${app.name}`, icon: app.icon || 'volume', kind: 'slider', hint: 'Arraste para ajustar, toque para mutar' });
    }
    for (const app of Object.values(ctx.audioApps || {})) {
        volume.actions.push({ id: `vol_step:${app.id}:+5`, label: `${app.name} +5%`, icon: 'vol_up', kind: 'action' });
        volume.actions.push({ id: `vol_step:${app.id}:-5`, label: `${app.name} −5%`, icon: 'vol_down', kind: 'action' });
    }
    groups.push(volume);

    // Aplicativos instalados (.desktop do sistema e flatpaks)
    const apps = { id: 'apps', label: 'Abrir aplicativo', icon: 'open', actions: [] };
    for (const app of ctx.apps || []) {
        apps.actions.push({ id: `launch:app:${app.id}`, label: app.name, icon: 'open', iconUrl: app.iconUrl || null, kind: 'action', hint: app.comment || (app.flatpak ? 'Flatpak' : undefined) });
    }
    groups.push(apps);

    // Plugins do Stream Deck (um grupo por plugin compatível)
    for (const plugin of ctx.plugins || []) {
        if (!plugin.supported) continue;
        const group = { id: `plugin:${plugin.uuid}`, label: plugin.name, icon: 'grid', iconData: plugin.categoryIcon || plugin.icon || null, plugin: true, actions: [] };
        for (const a of plugin.actions) {
            if (!a.visibleInActionsList || !a.controllers.includes('Keypad')) continue;
            const stateImage = (a.states[0] && a.states[0].image) || null;
            group.actions.push({
                id: `plugin:${a.uuid}`, label: a.name, icon: 'grid', iconData: a.icon || stateImage, keyIcon: stateImage,
                kind: 'action', hint: a.tooltip || `Plugin ${plugin.name}`, plugin: plugin.uuid
            });
        }
        if (group.actions.length) groups.push(group);
    }

    // Navegação entre telas
    const nav = { id: 'navigation', label: 'Trocar de tela', icon: 'grid', actions: [] };
    for (const p of ctx.profileList || []) {
        nav.actions.push({ id: `switch:${p.id}`, label: p.name, icon: p.id === 'default' ? 'home' : (p.builtin ? ({ obs: 'obs', discord: 'discord', teamspeak: 'teamspeak', meet: 'meet', nextcloud: 'nextcloud', spotify: 'spotify', more: 'grid' }[p.id] || 'grid') : 'grid'), kind: 'action' });
    }
    groups.push(nav);

    return { groups };
}

module.exports = { buildActionCatalog };
