// Áudio e sessão do macOS (platform/darwin/audio.js, session.js) contra o helper falso.
// Uso: node darwin-audio.test.js [caminho de server/src]
const fs = require('fs');
const os = require('os');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');
const fakeHelper = require('../fake-helper');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };

const { HelperClient } = require(path.join(SRC, 'platform', 'darwin', 'helperClient'));
const { createAudio } = require(path.join(SRC, 'platform', 'darwin', 'audio'));
const { createSession } = require(path.join(SRC, 'platform', 'darwin', 'session'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-audio-'));
const sock = path.join(tmp, 'h.sock');

(async () => {
    const fake = await fakeHelper.start({ socketPath: sock, hello: { version: '1.5.0', pid: 1, platform: { version: '15.8.1', arch: 'x86_64' }, permissions: { accessibility: true } } });
    let master = { volume: 37, muted: false };
    fake.setHandler('audio.master.get', () => master);
    fake.setHandler('audio.master.set', (args) => { master = { ...master, volume: args.volume }; return master; });
    fake.setHandler('audio.master.mute', (args) => { master = { ...master, muted: args.muted }; return master; });
    fake.setHandler('audio.master.subscribe', () => ({ subscribed: true }));
    fake.setHandler('key.shortcut', () => ({}));
    const client = new HelperClient({ socketPath: sock, launch: () => {}, requestTimeoutMs: 500, backoffMs: [50, 100] });
    const audio = createAudio(client);
    const session = createSession({ shortcut: (combo) => client.request('key.shortcut', { keys: combo.split('+') }).then(() => true, () => false) });
    const { mixer } = audio;
    const events = [];
    mixer.on('volumeChange', (e) => events.push(e));
    const reqs = fake.requests;
    const last = () => reqs[reqs.length - 1];

    client.start();
    await waitFor(() => client.connected);
    await waitFor(() => reqs.some((r) => r.op === 'audio.master.subscribe'));
    check('ao conectar lê master e assina', reqs.map((r) => r.op).includes('audio.master.get') && reqs.some((r) => r.op === 'audio.master.subscribe' && r.args.on === true), reqs.map((r) => r.op));
    await waitFor(() => mixer.getAll().master.volume === 37);
    check('estado inicial do master vem do helper', mixer.getAll().master.volume === 37 && mixer.getAll().master.muted === false && mixer.getAll().master.available === true, mixer.getAll().master);
    check('appState devolve master e null para desconhecido', mixer.appState('master').id === 'master' && mixer.appState('xyz') === null);
    const all = mixer.getAll();
    check('discord/teamspeak/obs/browser/spotify/game existem como indisponíveis', ['discord', 'teamspeak', 'obs', 'browser', 'spotify', 'game'].every((id) => all[id] && all[id].available === false && all[id].volume === 0 && all[id].muted === false && all[id].name), all);

    events.length = 0;
    mixer.setVolume('master', 55);
    await waitFor(() => last().op === 'audio.master.set');
    check('setVolume master manda audio.master.set', last().op === 'audio.master.set' && last().args.volume === 55, last());
    await waitFor(() => mixer.getAll().master.volume === 55);
    check('setVolume atualiza o estado e emite volumeChange', mixer.getAll().master.volume === 55 && events.some((e) => e.appId === 'master' && e.volume === 55), events);

    mixer.toggleMute('master');
    await waitFor(() => last().op === 'audio.master.mute');
    check('toggleMute master manda audio.master.mute', last().op === 'audio.master.mute' && last().args.muted === true, last());
    await waitFor(() => mixer.getAll().master.muted === true);
    check('toggleMute atualiza muted', mixer.getAll().master.muted === true);

    events.length = 0;
    fake.emit('audio.master', { volume: 20, muted: false });
    await waitFor(() => events.length > 0);
    const ev = events[0] || {};
    check('evento audio.master vira volumeChange', ev.appId === 'master' && ev.volume === 20 && ev.muted === false && mixer.getAll().master.volume === 20, ev);
    events.length = 0;
    fake.emit('audio.master', { volume: 20, muted: false });
    await sleep(100);
    check('evento sem mudança não emite volumeChange', events.length === 0);

    const before = reqs.length;
    mixer.setVolume('discord', 10);
    mixer.toggleMute('discord');
    mixer.adjustVolume('discord', 5);
    await sleep(100);
    check('discord é indisponível e setVolume não chama o helper', mixer.getAll().discord.available === false && reqs.length === before && mixer.getAll().discord.volume === 0);

    mixer.adjustVolume('master', -5);
    await waitFor(() => last().op === 'audio.master.set' && last().args.volume === 15);
    check('adjustVolume master soma ao valor atual', last().args.volume === 15, last());
    await audio.masterStep(5);
    check('masterStep(+5) soma ao valor atual (15+5)', last().op === 'audio.master.set' && last().args.volume === 20, last());
    await audio.masterMuteToggle();
    check('masterMuteToggle inverte o mudo atual', last().op === 'audio.master.mute' && last().args.muted === false, last());
    mixer.setVolume('master', 250);
    await waitFor(() => last().op === 'audio.master.set' && last().args.volume === 100);
    check('setVolume limita a 0..100', last().args.volume === 100, last());

    await session.lock();
    check('lock manda ctrl+cmd+q', last().op === 'key.shortcut' && last().args.keys.join('+') === 'ctrl+cmd+q', last());

    // reconexão: assina de novo
    const subsBefore = reqs.filter((r) => r.op === 'audio.master.subscribe').length;
    fake.disconnectClient();
    await waitFor(() => !client.connected);
    await waitFor(() => client.connected, 3000);
    await waitFor(() => reqs.filter((r) => r.op === 'audio.master.subscribe').length > subsBefore);
    check('reconectar assina de novo', reqs.filter((r) => r.op === 'audio.master.subscribe').length === subsBefore + 1);

    mixer.stop();
    await client.stop();
    await fake.close();
    check('stop não derruba nada', true);

    // Mac sem dispositivo de saída (ou sem controle de volume): helper responde not_supported → master vira n/d
    const sock2 = path.join(tmp, 'h2.sock');
    const fake2 = await fakeHelper.start({ socketPath: sock2, hello: { version: '1.5.0', pid: 2, platform: { version: '15.8.1', arch: 'x86_64' }, permissions: { accessibility: true } } });
    const unsupported = () => { const e = new Error('sem dispositivo de saída padrão'); e.code = 'not_supported'; throw e; };
    fake2.setHandler('audio.master.get', unsupported);
    fake2.setHandler('audio.master.set', unsupported);
    fake2.setHandler('audio.master.subscribe', () => ({ subscribed: true }));
    const client2 = new HelperClient({ socketPath: sock2, launch: () => {}, requestTimeoutMs: 500, backoffMs: [50, 100] });
    const audio2 = createAudio(client2);
    const events2 = [];
    audio2.mixer.on('volumeChange', (e) => events2.push(e));
    client2.start();
    await waitFor(() => client2.connected);
    await waitFor(() => audio2.mixer.getAll().master.available === false);
    check('get not_supported marca master como indisponível', audio2.mixer.getAll().master.available === false && audio2.mixer.getAll().master.volume === 0, audio2.mixer.getAll().master);
    check('master indisponível emite volumeChange para o deck atualizar', events2.some((e) => e.appId === 'master'), events2);
    const n2 = fake2.requests.length;
    audio2.mixer.setVolume('master', 40);
    await sleep(100);
    check('setVolume master indisponível não chama o helper', fake2.requests.length === n2);
    // dispositivo voltou (fones ligados): evento audio.master reabilita
    fake2.emit('audio.master', { volume: 42, muted: false });
    await waitFor(() => audio2.mixer.getAll().master.available === true);
    check('evento audio.master reabilita o master', audio2.mixer.getAll().master.available === true && audio2.mixer.getAll().master.volume === 42, audio2.mixer.getAll().master);
    audio2.mixer.stop();
    await client2.stop();
    await fake2.close();

    console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
    process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error('ERRO', e); process.exitCode = 1; });
