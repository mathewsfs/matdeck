// Detecção de CPU/GPU por fabricante com árvores /sys falsas (MATDECK_SYSFS_ROOT).
// Uso: node hardware-vendors.test.js [caminho de server/src]
const fs = require('fs'); const os = require('os'); const path = require('path'); const vm = require('vm');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');
let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

function freshMonitor(rootDir) {
    process.env.MATDECK_SYSFS_ROOT = rootDir;
    for (const k of Object.keys(require.cache)) if (k.includes('hardwareMonitor') || k.includes('hostExec')) delete require.cache[k];
    const HardwareMonitor = require(path.join(SRC, 'hardwareMonitor'));
    const hm = new HardwareMonitor(1000);
    hm.hasNvidiaSmi = false; // esta máquina tem nvidia-smi; os cenários são de outras
    hm.hasSensors = false;
    return { hm, HardwareMonitor };
}
const w = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(v) + '\n'); };
function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-sysfs-')); }
/** Cria /sys/class/drm/<card>/device -> /sys/devices/<pci> com os arquivos dados. */
function gpu(root, card, pci, driver, vendorId, files) {
    const dev = path.join(root, 'sys/devices', pci);
    fs.mkdirSync(dev, { recursive: true });
    w(path.join(dev, 'uevent'), `DRIVER=${driver}\nPCI_SLOT_NAME=${pci}`);
    w(path.join(dev, 'vendor'), vendorId);
    for (const [f, v] of Object.entries(files)) w(path.join(dev, f), v);
    fs.mkdirSync(path.join(root, 'sys/class/drm', card), { recursive: true });
    fs.symlinkSync(dev, path.join(root, 'sys/class/drm', card, 'device'));
}
function hwmon(root, idx, name, temps) {
    const base = path.join(root, 'sys/class/hwmon', `hwmon${idx}`);
    w(path.join(base, 'name'), name);
    for (const [i, t] of Object.entries(temps)) { w(path.join(base, `temp${i}_input`), t.value); if (t.label) w(path.join(base, `temp${i}_label`), t.label); }
}

(async () => {
    // --- A) PC AMD: Ryzen (k10temp com rótulos) + APU integrada (00:08.0) + RX dedicada (03:00.0) ---
    let root = mkRoot();
    hwmon(root, 0, 'k10temp', { 1: { value: 45125, label: 'Tctl' }, 3: { value: 50000, label: 'Tccd1' } });
    hwmon(root, 1, 'nvme', { 1: { value: 38000, label: 'Composite' } });
    gpu(root, 'card0', '0000:00:08.0', 'amdgpu', '0x1002', { gpu_busy_percent: 7, mem_info_vram_total: 512 * 1024 ** 2, mem_info_vram_used: 100 * 1024 ** 2, 'hwmon/hwmon5/temp1_input': 40000, 'hwmon/hwmon5/temp1_label': 'edge' });
    gpu(root, 'card1', '0000:03:00.0', 'amdgpu', '0x1002', { gpu_busy_percent: 33, mem_info_vram_total: 16 * 1024 ** 3, mem_info_vram_used: 4 * 1024 ** 3, 'hwmon/hwmon6/temp1_input': 61000, 'hwmon/hwmon6/temp1_label': 'edge', 'hwmon/hwmon6/temp2_input': 70000, 'hwmon/hwmon6/temp2_label': 'junction' });
    let { hm } = freshMonitor(root);
    check('A: CPU AMD usa Tctl do k10temp (não Tccd1)', hm.cpuTempSource === 'k10temp/Tctl' && await hm.getCpuTemp() === 45, { src: hm.cpuTempSource, t: await hm.getCpuTemp() });
    check('A: duas GPUs AMD vistas', hm.sysGpus.length === 2 && hm.sysGpus.every(g => g.vendor === 'amd' && g.driver === 'amdgpu'), hm.sysGpus.map(g => [g.card, g.vendor, g.discrete]));
    check('A: escolhe a dedicada (card1, barramento 03)', hm.sysGpu && hm.sysGpu.card === 'card1' && hm.sysGpu.discrete === true, hm.sysGpu && hm.sysGpu.card);
    let g = await hm.getGpuStats();
    check('A: uso 33%, temp edge 61°C, VRAM 4.0 de 16.0 GB (25%)', g.available && g.usage === 33 && g.temp === 61 && g.vramUsedGB === '4.0' && g.vramTotalGB === '16.0' && g.vramPercent === 25 && g.vendor === 'amd', g);
    check('A: describe cita AMD dedicada e a outra GPU', /AMD card1 \(amdgpu, dedicada\): uso, temperatura, VRAM/.test(hm.describe()) && /outras: AMD card0/.test(hm.describe()), hm.describe());
    await hm.collect();
    check('A: collect preenche histórico de GPU com números', hm.history.gpuUsage.length === 1 && hm.history.gpuUsage[0] === 33 && hm.currentStats.gpu.vendor === 'amd');
    hm.stop();

    // --- B) PC Intel: coretemp (Package id 0 + núcleos) + iGPU i915 (00:02.0) + Arc xe (03:00.0) ---
    root = mkRoot();
    hwmon(root, 0, 'coretemp', { 1: { value: 52000, label: 'Package id 0' }, 2: { value: 48000, label: 'Core 0' }, 3: { value: 49000, label: 'Core 1' } });
    gpu(root, 'card0', '0000:00:02.0', 'i915', '0x8086', {});
    gpu(root, 'card1', '0000:03:00.0', 'xe', '0x8086', { 'tile0/physical_vram_size_bytes': 16 * 1024 ** 3, 'hwmon/hwmon3/temp1_input': 55000, 'hwmon/hwmon3/temp1_label': 'pkg', 'hwmon/hwmon3/temp2_input': 60000, 'hwmon/hwmon3/temp2_label': 'vram' });
    ({ hm } = freshMonitor(root));
    check('B: CPU Intel usa Package id 0 do coretemp', hm.cpuTempSource === 'coretemp/Package id 0' && await hm.getCpuTemp() === 52, { src: hm.cpuTempSource });
    check('B: iGPU sem nada legível é descartada; Arc escolhida', hm.sysGpu && hm.sysGpu.card === 'card1' && hm.sysGpu.vendor === 'intel' && hm.sysGpu.driver === 'xe', hm.sysGpu);
    g = await hm.getGpuStats();
    check('B: Arc: uso null (não exposto), temp pkg 55, VRAM total 16.0 e usada "--"', g.available && g.usage === null && g.temp === 55 && g.vramTotalGB === '16.0' && g.vramUsedGB === '--' && g.vramPercent === null && g.vendor === 'intel', g);
    check('B: describe cita Intel dedicada com temperatura e VRAM total', /Intel card1 \(xe, dedicada\): temperatura, VRAM total/.test(hm.describe()), hm.describe());
    await hm.collect();
    check('B: histórico de uso sem número vira 0 (sem NaN)', hm.history.gpuUsage[0] === 0 && hm.history.gpuTemp[0] === 55);
    hm.stop();

    // --- C) Intel só com coretemp sem rótulos e sem GPU ---
    root = mkRoot();
    hwmon(root, 0, 'coretemp', { 1: { value: 60000 }, 2: { value: 58000 } });
    ({ hm } = freshMonitor(root));
    check('C: sem rótulos usa temp1', hm.cpuTempSource === 'coretemp/temp1' && await hm.getCpuTemp() === 60, hm.cpuTempSource);
    g = await hm.getGpuStats();
    check('C: sem GPU -> available false', g.available === false && g.usage === 0, g);
    check('C: describe: nenhuma GPU legível', /nenhuma GPU legível/.test(hm.describe()), hm.describe());
    hm.stop();

    // --- D) sem hwmon de CPU: thermal_zone x86_pkg_temp ---
    root = mkRoot();
    w(path.join(root, 'sys/class/thermal/thermal_zone0/type'), 'acpitz'); w(path.join(root, 'sys/class/thermal/thermal_zone0/temp'), 27800);
    w(path.join(root, 'sys/class/thermal/thermal_zone1/type'), 'x86_pkg_temp'); w(path.join(root, 'sys/class/thermal/thermal_zone1/temp'), 47000);
    ({ hm } = freshMonitor(root));
    check('D: thermal_zone x86_pkg_temp (ignora acpitz)', hm.cpuTempSource === 'thermal_zone1/x86_pkg_temp' && await hm.getCpuTemp() === 47, hm.cpuTempSource);
    hm.stop();

    // --- E) notebook AMD só com APU (barramento 00) ---
    root = mkRoot();
    hwmon(root, 0, 'k10temp', { 1: { value: 55000 } });
    gpu(root, 'card0', '0000:00:08.0', 'amdgpu', '0x1002', { gpu_busy_percent: 12, mem_info_vram_total: 2 * 1024 ** 3, mem_info_vram_used: 1024 ** 3 });
    ({ hm } = freshMonitor(root));
    g = await hm.getGpuStats();
    check('E: APU única é usada mesmo integrada', hm.sysGpu.card === 'card0' && hm.sysGpu.discrete === false && g.usage === 12 && g.vramPercent === 50 && g.temp === null, g);
    check('E: k10temp sem rótulo -> temp1', hm.cpuTempSource === 'k10temp/temp1');
    check('E: describe diz integrada', /AMD card0 \(amdgpu, integrada\)/.test(hm.describe()), hm.describe());
    hm.stop();

    // --- F) nouveau (NVIDIA sem nvidia-smi): só temperatura ---
    root = mkRoot();
    gpu(root, 'card0', '0000:01:00.0', 'nouveau', '0x10de', { 'hwmon/hwmon2/temp1_input': 44000 });
    ({ hm } = freshMonitor(root));
    g = await hm.getGpuStats();
    check('F: nouveau: temperatura 44, uso null, VRAM 0.0', g.available && g.vendor === 'nvidia' && g.temp === 44 && g.usage === null && g.vramTotalGB === '0.0', g);
    hm.stop();

    // --- G) teclas: statUpdateFor com uso/VRAM indisponíveis mostra "--" ---
    const src = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
    const grabMethod = (sig) => { const i = src.indexOf(sig); let depth = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); } } };
    const cls = `class MatDeckServer {\n${grabMethod('static fmtTemp(')}\n${grabMethod('static fmtRate(')}\n${grabMethod('static isHot(')}\n${grabMethod('statUpdateFor(actionId, stats) {')}\n}\nMatDeckServer`;
    const Srv = vm.runInNewContext(cls, {});
    const srv = new Srv();
    const stats = { cpu: { usage: 10, temp: 40 }, gpu: { usage: null, temp: 55, vramUsedGB: '--', vramTotalGB: '16.0', vramPercent: null, available: true, vendor: 'intel' }, ram: { percent: 40, usedGB: '12.0', totalGB: '32.0', freeGB: '20.0' }, history: { gpuUsage: [0], gpuTemp: [55] } };
    let k = srv.statUpdateFor('stats:gpu', stats);
    check('G: tecla GPU mostra "--" e explica', k.statBig === '--' && /não exposto/.test(k.statSub) && k.title === 'GPU --' && k.active === false, k);
    k = srv.statUpdateFor('stats:gpu_temp', stats);
    check('G: tecla GPU temp: cabeçalho "--", valor 55°C', k.statHead === '--' && /55/.test(k.statBig), k);
    k = srv.statUpdateFor('stats:vram', stats);
    check('G: tecla VRAM: "--%" , "-- GB de 16.0 GB", barra 0', k.statHead === '--' && k.statBig === '-- GB' && k.statSub === 'de 16.0 GB' && k.statPercent === 0, k);
    k = srv.statUpdateFor('stats:gpu', { ...stats, gpu: { usage: 33, temp: 61, vramUsedGB: '4.0', vramTotalGB: '16.0', vramPercent: 25, available: true } });
    check('G: tecla GPU normal continua "33%"', k.statBig === '33%' && k.title === 'GPU 33%' && k.statSub === null, k);

    console.log(fails ? `\n${fails} falha(s)` : '\nTudo OK');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERRO NO HARNESS:', e); process.exit(1); });
