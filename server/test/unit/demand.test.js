// Modo econômico: cadências e nvidia-smi contínuo nos coletores, sem subir o servidor.
// Uso: node demand.test.js [caminho de server/src]
const path = require('path');
const { execFileSync } = require('child_process');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');
const HardwareMonitor = require(path.join(SRC, 'hardwareMonitor'));
const FanControl = require(path.join(SRC, 'fanControl'));
const SpotifyMonitor = require(path.join(SRC, 'spotify'));
const MediaPlayers = require(path.join(SRC, 'mediaPlayers'));

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hasNvidia = (() => { try { execFileSync('sh', ['-c', 'command -v nvidia-smi'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();

(async () => {
    // --- HardwareMonitor ---
    const hm = new HardwareMonitor(1000);
    check('hardware: nasce em modo econômico (10 s)', hm.active === false && hm.currentInterval() === 10000, hm.currentInterval());
    check('parseNvidiaCsv aceita amostra', JSON.stringify(HardwareMonitor.parseNvidiaCsv('3, 42, 1367, 8188')) === '[3,42,1367,8188]');
    check('parseNvidiaCsv rejeita lixo', HardwareMonitor.parseNvidiaCsv('N/A, 42') === null && HardwareMonitor.parseNvidiaCsv('') === null);
    const st = HardwareMonitor.nvidiaStats([3, 42, 1367, 8188]);
    check('nvidiaStats calcula VRAM', st.usage === 3 && st.temp === 42 && st.vramUsedGB === '1.3' && st.vramTotalGB === '8.0' && st.vramPercent === 17 && st.available === true, st);
    hm.start();
    check('start sem clientes usa 10 s', hm.timer && hm.timer._repeat === 10000, hm.timer && hm.timer._repeat);
    check('sem clientes não há stream de GPU', hm.gpuStream === null);
    hm.setActive(true);
    check('setActive(true) vai para 1 s', hm.active === true && hm.timer._repeat === 1000, hm.timer._repeat);
    if (hasNvidia && hm.hasNvidiaSmi) {
        check('com cliente e nvidia-smi: stream iniciado', !!hm.gpuStream && !!hm.gpuStream.pid);
        await sleep(1600);
        check('stream entrega amostra em < 2 s', !!hm.gpuLatest && Date.now() - hm.gpuLatest.at < 2000, hm.gpuLatest);
        const gpu = await hm.getGpuStats();
        check('getGpuStats usa a amostra do stream', gpu.available === true && typeof gpu.temp === 'number', gpu);
        const streamPid = hm.gpuStream.pid;
        hm.setActive(false);
        check('setActive(false) volta a 10 s e encerra o stream', hm.timer._repeat === 10000 && hm.gpuStream === null && hm.gpuLatest === null);
        await sleep(800);
        let alive = true; try { process.kill(streamPid, 0); } catch (e) { alive = false; }
        check('processo nvidia-smi contínuo morreu', !alive);
        // getGpuStats em modo econômico: chamada avulsa continua funcionando
        const gpuIdle = await hm.getGpuStats();
        check('modo econômico: chamada avulsa ao nvidia-smi funciona', gpuIdle.available === true, gpuIdle);
    } else {
        console.log('(sem nvidia-smi nesta máquina: testes do stream pulados)');
        hm.setActive(false);
    }
    hm.stop();
    check('stop limpa timer', hm.timer === null && hm.gpuStream === null);

    // --- FanControl ---
    const fc = new FanControl({ get: () => ({ enabled: true, host: '127.0.0.1', port: 1, token: 'x' }) });
    const sched = [];
    fc.schedule = (ms) => sched.push(ms);
    fc.resolveToken = async () => 'tok';
    fc.refreshDevices = async () => {};
    fc.refreshStatus = async () => {};
    fc.available = true;
    check('fans: nasce em modo econômico (30 s)', fc.pollIntervalMs() === 30000);
    await fc.poll();
    check('fans: poll sem clientes reagenda em 30 s', sched[sched.length - 1] === 30000, sched);
    fc.timer = {}; // simula monitor em execução
    fc.setActive(true);
    check('fans: ativar sonda já (0 ms)', sched[sched.length - 1] === 0 && fc.pollIntervalMs() === 2000, sched);
    await fc.poll();
    check('fans: poll com cliente reagenda em 2 s', sched[sched.length - 1] === 2000, sched);
    fc.available = false; fc.setActive(false);
    await fc.poll();
    check('fans: indisponível e sem clientes espera 30 s (não 10)', sched[sched.length - 1] === 30000, sched);

    // --- Spotify ---
    const sp = new SpotifyMonitor();
    check('spotify: sem clientes, Spotify aberto -> 10 s', sp.runningPollMs() === 10000);
    let soon = null; sp.pollSoon = (ms) => { soon = ms; };
    sp.setActive(true);
    check('spotify: ativar sonda já e passa a 1 s', soon === 0 && sp.runningPollMs() === 1000);
    sp.setActive(false);
    check('spotify: desativar volta a 10 s', sp.runningPollMs() === 10000);

    // --- MediaPlayers ---
    const mp = new MediaPlayers();
    mp.watcher = {}; // monitor D-Bus presente
    mp.players.set('org.mpris.MediaPlayer2.x', { status: 'Playing' });
    mp.scheduleNext();
    check('media: tocando, mas sem clientes -> sem sondagem de posição', mp.timer === null);
    soon = null; mp.pollSoon = (ms) => { soon = ms; };
    mp.setActive(true);
    check('media: ativar sonda já', soon === 0);
    mp.scheduleNext();
    check('media: tocando e com cliente -> sondagem de posição agendada (2 s)', !!mp.timer);
    clearTimeout(mp.timer);
    mp.setActive(false);
    check('media: desativar cancela a sondagem', mp.timer === null);
    mp.watcher = null; mp.scheduleNext();
    check('media: sem monitor D-Bus mantém a reserva de 5 s mesmo sem clientes', !!mp.timer);
    clearTimeout(mp.timer);

    console.log(fails ? `\n${fails} falha(s)` : '\nTudo OK');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERRO NO HARNESS:', e); process.exit(1); });
