// Perfis só falam com o sistema por ctx.platform; atalhos vêm de tabelas por plataforma (platform/shortcuts.js).
// Uso: node profiles-platform.test.js [caminho de server/src]
const fs = require('fs');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.MATDECK_PLATFORM = 'linux';   // os perfis são exercitados com as tabelas do Linux
const { forPlatform } = require(path.join(SRC, 'platform', 'shortcuts'));

check('forPlatform cai para linux', forPlatform({ linux: { a: 1 } }, 'darwin').a === 1);
check('forPlatform escolhe darwin', forPlatform({ linux: { a: 1 }, darwin: { a: 2 } }, 'darwin').a === 2);
check('forPlatform sem nome usa a plataforma atual (linux fixado)', forPlatform({ linux: { a: 1 }, darwin: { a: 2 } }).a === 1);

// Plataforma falsa: registra chamadas como 'area.metodo:arg'
const calls = [];
const rec = (name) => (...args) => { calls.push(args.length ? `${name}:${typeof args[0] === 'object' ? JSON.stringify(args[0]) : args[0]}` : name); return Promise.resolve(true); };
const fakePlatform = {
    name: 'linux',
    keys: { shortcut: rec('keys.shortcut'), keyDown: rec('keys.keyDown'), keyUp: rec('keys.keyUp'), mediaKey: rec('keys.mediaKey') },
    windows: {
        // focus resolve false: simula Discord sem janela, para 'discord:open' cair em openDiscord()
        focus: (target) => { calls.push(`windows.focus:${JSON.stringify(target)}`); return Promise.resolve(false); },
        focusAndSend: (target, combo) => { calls.push(`windows.focusAndSend:${combo}`); return Promise.resolve(true); }
    },
    apps: {
        open: rec('apps.open'),
        launchFile: (bin, args) => { calls.push(`apps.launchFile:${bin} ${(args || []).join(' ')}`.trim()); return Promise.resolve(true); },
        launchFirst: (cands, label) => { calls.push(`apps.launchFirst:${cands.map((c) => c[0]).join(',')}:${label}`); return Promise.resolve(true); },
        flatpakInstalled: () => Promise.resolve(false),
        commandExists: () => false,
        launcher: { launch: rec('apps.launcher.launch') }
    },
    audio: { masterStep: (d) => calls.push(`audio.masterStep:${d}`), masterMuteToggle: () => calls.push('audio.masterMuteToggle') },
    session: { lock: () => calls.push('session.lock') }
};
const ctx = {
    platform: fakePlatform,
    config: { get: () => ({}) },
    updateKey() {},
    notify() {},
    switchProfile() {},
    setAutoDetect() {},
    autoDetectEnabled: false,
    profiles: new Map()
};

const DefaultProfile = require(path.join(SRC, 'profiles', 'default'));
const MeetProfile = require(path.join(SRC, 'profiles', 'meet'));
const DiscordProfile = require(path.join(SRC, 'profiles', 'discord'));
const NextcloudProfile = require(path.join(SRC, 'profiles', 'nextcloud'));

(async () => {
    const def = new DefaultProfile(ctx);
    ctx.profiles.set('default', def);
    def.handleAction('media:vol_up', 'keyDown');
    def.handleAction('media:vol_down', 'keyDown');
    def.handleAction('media:mute', 'keyDown');
    def.handleAction('media:play_pause', 'keyDown');
    def.handleAction('media:next', 'keyDown');
    def.handleAction('launch:browser', 'keyDown');
    def.handleAction('launch:calc', 'keyDown');
    def.handleAction('launch:term', 'keyDown');
    def.handleAction('launch:app:org.kde.konsole', 'keyDown');
    def.handleAction('system:lock', 'keyDown');
    check('default media:vol_up -> audio.masterStep(5)', calls.includes('audio.masterStep:5'));
    check('default media:vol_down -> audio.masterStep(-5)', calls.includes('audio.masterStep:-5'));
    check('default media:mute -> audio.masterMuteToggle', calls.includes('audio.masterMuteToggle'));
    check('default media:play_pause -> keys.mediaKey(play_pause)', calls.includes('keys.mediaKey:play_pause'));
    check('default media:next -> keys.mediaKey(next)', calls.includes('keys.mediaKey:next'));
    check('default launch:browser -> apps.open(https://google.com)', calls.includes('apps.open:https://google.com'));
    check('default launch:calc -> apps.launchFirst', calls.some((c) => c.startsWith('apps.launchFirst:kcalc,gnome-calculator')));
    check('default launch:term -> apps.launchFirst', calls.some((c) => c.startsWith('apps.launchFirst:konsole,')));
    check('default launch:app -> apps.launcher.launch', calls.includes('apps.launcher.launch:org.kde.konsole'));
    check('default system:lock -> session.lock', calls.includes('session.lock'));

    const meet = new MeetProfile(ctx);
    meet.handleAction('meet:mute_mic', 'keyDown');
    meet.handleAction('meet:hand', 'keyDown');
    meet.handleAction('meet:shortcuts', 'keyDown');
    meet.handleAction('meet:open', 'keyDown');
    await sleep(10);
    check('meet mic -> windows.focusAndSend(ctrl+d) no linux', calls.includes('windows.focusAndSend:ctrl+d'));
    check('meet hand -> focusAndSend(ctrl+alt+h)', calls.includes('windows.focusAndSend:ctrl+alt+h'));
    check('meet shortcuts -> focusAndSend(ctrl+slash)', calls.includes('windows.focusAndSend:ctrl+slash'));
    check('meet open -> apps.open', calls.includes('apps.open:https://meet.google.com/'));
    check('meet mic alterna estado otimista', meet.micMuted === true);

    const discord = new DiscordProfile(ctx);      // sem rpc: cai no teclado
    discord.handleAction('discord:ptt', 'keyDown');
    discord.handleAction('discord:ptt', 'keyUp');
    discord.handleAction('discord:toggle_mute', 'keyDown');
    discord.handleAction('discord:quick_switcher', 'keyDown');
    discord.handleAction('discord:open', 'keyDown');
    await sleep(10);
    check('discord ptt keyDown -> keys.keyDown(ctrl+shift+p)', calls.includes('keys.keyDown:ctrl+shift+p'));
    check('discord ptt keyUp -> keys.keyUp(ctrl+shift+p)', calls.includes('keys.keyUp:ctrl+shift+p'));
    check('discord mute sem API -> focusAndSend(ctrl+shift+m)', calls.includes('windows.focusAndSend:ctrl+shift+m'));
    check('discord quick switcher -> focusAndSend(ctrl+k)', calls.includes('windows.focusAndSend:ctrl+k'));
    check('discord open -> windows.focus e depois apps.open(discord://)', calls.some((c) => c.startsWith('windows.focus:')) && calls.includes('apps.launchFile:xdg-open discord://'));

    const nc = new NextcloudProfile(ctx);
    nc.handleAction('nc:search', 'keyDown');
    nc.handleAction('nc:mute_mic', 'keyDown');
    await sleep(10);
    check('nextcloud search -> focusAndSend(ctrl+f)', calls.includes('windows.focusAndSend:ctrl+f'));
    check('nextcloud mic -> focusAndSend(m)', calls.includes('windows.focusAndSend:m'));

    // Tabelas darwin existem com os valores da spec
    const meetTable = require(path.join(SRC, 'profiles', 'meet')).SHORTCUTS;
    const discordTable = require(path.join(SRC, 'profiles', 'discord')).SHORTCUTS;
    const ncTable = require(path.join(SRC, 'profiles', 'nextcloud')).SHORTCUTS;
    check('meet darwin: mic cmd+d, hand ctrl+cmd+h, fullscreen ctrl+cmd+f', meetTable.darwin.mic === 'cmd+d' && meetTable.darwin.hand === 'ctrl+cmd+h' && meetTable.darwin.fullscreen === 'ctrl+cmd+f', meetTable.darwin);
    check('discord darwin: ptt cmd+shift+p, mute cmd+shift+m, prevChannel alt+up', discordTable.darwin.ptt === 'cmd+shift+p' && discordTable.darwin.mute === 'cmd+shift+m' && discordTable.darwin.prevChannel === 'alt+up', discordTable.darwin);
    check('nextcloud darwin: search cmd+f, mic m', ncTable.darwin.search === 'cmd+f' && ncTable.darwin.mic === 'm', ncTable.darwin);
    check('discord linux: padrões de config iguais aos de hoje', discordTable.linux.ptt === 'ctrl+shift+p' && discordTable.linux.mute === 'ctrl+shift+m' && discordTable.linux.deafen === 'ctrl+shift+d');

    const profilesDir = path.join(SRC, 'profiles');
    const srcOfAllProfiles = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(profilesDir, f), 'utf8')).join('\n');
    check('nenhum perfil importa systemActions/hostExec', !/require\(['"]\.\.\/(actions\/systemActions|hostExec)['"]\)/.test(srcOfAllProfiles));

    console.log(fails ? `\n${fails} FALHA(S)` : '\nTodos os checks passaram');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(2); });
