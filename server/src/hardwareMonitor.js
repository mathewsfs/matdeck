const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn, which } = require('./hostExec');
const EventEmitter = require('events');

const EXEC_TIMEOUT_MS = 800;
const IDLE_INTERVAL_MS = 10000;       // sem nenhum cliente conectado ninguém vê os números: coleta a cada 10 s
const GPU_STREAM_RETRIES = 3;         // quedas seguidas do nvidia-smi contínuo antes de voltar às chamadas avulsas
const GPU_STREAM_RETRY_MS = 15000;
const HISTORY_LEN = 60;               // 60 amostras = 1 min a 1 Hz (gráficos das teclas)
const VIRTUAL_IFACE = /^(lo|docker|podman|cni|br-|veth|virbr|tun|tap|wg|vmnet|zt|tailscale|flannel)/i;
const PHYSICAL_DISK = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+|hd[a-z]+)$/;

const TOOL_MAX_FAILURES = 5;
// Raiz alternativa do sysfs, só para testes com uma árvore /sys falsa (ex.: máquina AMD/Intel simulada)
const SYS_ROOT = process.env.MATDECK_SYSFS_ROOT || '';
const sysPath = (p) => `${SYS_ROOT}${p}`;
const CPU_HWMON = /k10temp|zenpower|coretemp|cpu_thermal|soc_thermal/i;   // drivers de sensor da CPU (AMD, AMD alternativo, Intel, ARM)
const PCI_VENDOR = { '0x1002': 'amd', '0x8086': 'intel', '0x10de': 'nvidia' };
const VENDOR_LABEL = { amd: 'AMD', intel: 'Intel', nvidia: 'NVIDIA' };

function readText(filePath) {
    try { return fs.readFileSync(filePath, 'utf8').trim(); } catch (e) { return null; }
}

function run(cmd, args) {
    return new Promise((resolve) => {
        execFile(cmd, args, { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
            resolve(err ? { error: String((stderr || err.message || '')).trim().split('\n')[0] || 'falhou' } : { out: stdout });
        });
    });
}

function readNumber(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        const val = parseInt(raw, 10);
        return isNaN(val) ? null : val;
    } catch (e) {
        return null;
    }
}

function listDir(dir) {
    try {
        return fs.readdirSync(dir);
    } catch (e) {
        return [];
    }
}

class HardwareMonitor extends EventEmitter {
    constructor(intervalMs = 1000) {
        super();
        this.intervalMs = intervalMs;
        this.timer = null;
        this.collecting = false;
        this.active = false;          // true com algum cliente conectado (1 Hz); false = modo econômico
        this.gpuStream = null;        // nvidia-smi em modo contínuo (um processo em vez de um por segundo)
        this.gpuLatest = null;        // última linha do stream: { parts, at }
        this.gpuStreamFailures = 0;
        this.gpuStreamRetry = null;
        this.lastCpuSample = this.sampleCpu();
        this.lastCoreSamples = this.sampleCores();
        this.lastNet = this.sampleNet();
        this.lastDisk = this.sampleDisk();
        this.history = {};
        for (const k of ['cpuUsage', 'cpuTemp', 'gpuUsage', 'gpuTemp', 'netDown', 'netUp', 'diskRead', 'diskWrite']) this.history[k] = [];

        // Descobertos uma vez para não varrer o sysfs a cada segundo
        const cpuTemp = this.findCpuTemp();
        this.cpuTempPath = cpuTemp ? cpuTemp.path : null;
        this.cpuTempSource = cpuTemp ? cpuTemp.source : null;
        this.sysGpus = this.findSysfsGpus();
        this.sysGpu = HardwareMonitor.pickGpu(this.sysGpus);   // AMD (amdgpu), Intel (i915/xe) ou NVIDIA sem nvidia-smi (nouveau)
        this.hasNvidiaSmi = !!which('nvidia-smi');
        this.hasSensors = !!which('sensors');
        this.toolFailures = { sensors: 0, 'nvidia-smi': 0 };   // rodam 1x/s: falhando sempre, são desligados com aviso

        this.currentStats = {
            cpu: { usage: 0, temp: null },
            gpu: { usage: 0, temp: null, vramUsedGB: '0.0', vramTotalGB: '0.0', vramPercent: 0, available: false },
            ram: { usedGB: '0.0', totalGB: '0.0', percent: 0 },
            net: { downBps: 0, upBps: 0 },
            disk: { readBps: 0, writeBps: 0 },
            history: this.history,
            timestamp: Date.now()
        };
    }

    pushHistory(key, value) {
        const arr = this.history[key];
        arr.push(typeof value === 'number' && Number.isFinite(value) ? value : 0);
        if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
    }

    currentInterval() {
        return this.active ? this.intervalMs : IDLE_INTERVAL_MS;
    }

    start() {
        if (this.timer) return;
        this.collect();
        this.timer = setInterval(() => this.collect(), this.currentInterval());
        console.log(`[HardwareMonitor] Coleta de estatísticas de CPU, GPU e RAM iniciada (${this.active ? '1 Hz' : 'modo econômico, a cada ' + IDLE_INTERVAL_MS / 1000 + ' s sem clientes'})`);
        console.log(`[HardwareMonitor] ${this.describe()}`);
    }

    /** Resumo do hardware detectado, para o log e o diagnóstico: CPU, fonte da temperatura e GPU escolhida. */
    describe() {
        const cpuModel = ((os.cpus()[0] || {}).model || 'CPU').replace(/\s+/g, ' ').trim();
        const cpuTemp = this.cpuTempSource ? `temperatura via ${this.cpuTempSource}` : (this.hasSensors ? 'temperatura via sensors' : 'sem sensor de temperatura');
        let gpu;
        if (this.hasNvidiaSmi) gpu = 'NVIDIA via nvidia-smi';
        else if (this.sysGpu) {
            const g = this.sysGpu;
            const parts = [g.busyPath ? 'uso' : null, g.tempPath ? 'temperatura' : null, g.vramTotalPath ? (g.vramUsedPath ? 'VRAM' : 'VRAM total') : null].filter(Boolean);
            gpu = `${VENDOR_LABEL[g.vendor] || g.vendor} ${g.card} (${g.driver || 'driver ?'}${g.discrete ? ', dedicada' : ', integrada'}): ${parts.join(', ') || 'nada legível'}`;
            if (this.sysGpus.length > 1) gpu += ` [outras: ${this.sysGpus.filter(x => x !== g).map(x => `${VENDOR_LABEL[x.vendor] || x.vendor} ${x.card}`).join(', ')}]`;
        } else gpu = 'nenhuma GPU legível';
        return `CPU ${cpuModel} (${cpuTemp}) | GPU: ${gpu}`;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.stopGpuStream();
    }

    /** Com cliente conectado: 1 Hz e nvidia-smi contínuo. Sem ninguém: a cada 10 s, chamadas avulsas. */
    setActive(active) {
        active = !!active;
        if (active === this.active) return;
        this.active = active;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = setInterval(() => this.collect(), this.currentInterval());
        }
        if (active) {
            if (this.hasNvidiaSmi) this.startGpuStream();
            if (this.timer) this.collect(); // números frescos para quem acabou de conectar
        } else {
            this.stopGpuStream();
        }
    }

    // --- nvidia-smi contínuo ------------------------------------------------

    startGpuStream() {
        if (this.gpuStream || !this.hasNvidiaSmi || !this.active) return;
        if (this.gpuStreamRetry) { clearTimeout(this.gpuStreamRetry); this.gpuStreamRetry = null; }
        let child;
        try {
            child = spawn('nvidia-smi', [
                '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
                '--format=csv,noheader,nounits',
                '-lms', String(this.intervalMs)
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            console.warn('[HardwareMonitor] nvidia-smi contínuo não iniciou; seguindo com chamadas avulsas:', e.message);
            return;
        }
        this.gpuStream = child;
        let buf = '';
        child.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                const parts = HardwareMonitor.parseNvidiaCsv(line);
                if (parts) { this.gpuLatest = { parts, at: Date.now() }; this.gpuStreamFailures = 0; }
            }
        });
        child.stderr.on('data', () => {});
        const gone = (why) => {
            if (this.gpuStream !== child) return;
            this.gpuStream = null;
            this.gpuLatest = null;
            if (!this.active || !this.hasNvidiaSmi) return;
            if (++this.gpuStreamFailures >= GPU_STREAM_RETRIES) {
                console.warn(`[HardwareMonitor] nvidia-smi contínuo ${why} ${GPU_STREAM_RETRIES} vezes; seguindo com uma chamada por segundo`);
                return;
            }
            this.gpuStreamRetry = setTimeout(() => { this.gpuStreamRetry = null; this.startGpuStream(); }, GPU_STREAM_RETRY_MS);
            if (typeof this.gpuStreamRetry.unref === 'function') this.gpuStreamRetry.unref();
        };
        child.on('error', (e) => gone(`falhou (${e.message})`));
        child.on('exit', (code, signal) => gone(`terminou (code=${code}, signal=${signal})`));
    }

    stopGpuStream() {
        if (this.gpuStreamRetry) { clearTimeout(this.gpuStreamRetry); this.gpuStreamRetry = null; }
        const child = this.gpuStream;
        this.gpuStream = null;
        this.gpuLatest = null;
        if (!child) return;
        // nvidia-smi em loop só sai com Ctrl+C (SIGINT; SIGTERM é ignorado); flatpak-spawn repassa o sinal ao host
        try { child.kill('SIGINT'); } catch (e) { /* já saiu */ }
        const hammer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch (e) {} } }, 1500);
        if (typeof hammer.unref === 'function') hammer.unref();
    }

    /** "3, 42, 1367, 8188" -> [3, 42, 1367, 8188]; null se a linha não for uma amostra. */
    static parseNvidiaCsv(line) {
        const parts = String(line || '').trim().split(',').map(s => parseFloat(s.trim()));
        return parts.length >= 4 && !parts.some(isNaN) ? parts : null;
    }

    static nvidiaStats(parts) {
        const [usage, temp, usedMB, totalMB] = parts;
        return {
            usage: Math.round(usage),
            temp: Math.round(temp),
            vramUsedGB: (usedMB / 1024).toFixed(1),
            vramTotalGB: (totalMB / 1024).toFixed(1),
            vramPercent: totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0,
            available: true
        };
    }

    sampleCpu() {
        let idle = 0, total = 0;
        for (const c of os.cpus()) {
            for (const t in c.times) total += c.times[t];
            idle += c.times.idle;
        }
        return { idle, total };
    }

    /** Uso por núcleo (0-100) a partir de duas amostras de os.cpus(). */
    sampleCores() {
        return os.cpus().map((c) => {
            let total = 0;
            for (const t in c.times) total += c.times[t];
            return { idle: c.times.idle, total };
        });
    }

    coreUsages(current) {
        const prev = this.lastCoreSamples;
        const out = current.map((cur, i) => {
            const p = prev[i];
            if (!p) return 0;
            const totalDiff = cur.total - p.total;
            const idleDiff = cur.idle - p.idle;
            return totalDiff > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - idleDiff / totalDiff)))) : 0;
        });
        this.lastCoreSamples = current;
        return out;
    }

    /** Bytes recebidos/enviados somados nas interfaces físicas (/proc/net/dev). */
    sampleNet() {
        let rx = 0, tx = 0;
        try {
            const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
            for (const line of lines) {
                const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
                if (!m || VIRTUAL_IFACE.test(m[1].trim())) continue;
                const f = m[2].trim().split(/\s+/).map(Number);
                rx += f[0] || 0;
                tx += f[8] || 0;
            }
        } catch (e) { /* sem /proc */ }
        return { rx, tx, at: Date.now() };
    }

    /** Setores lidos/escritos nos discos físicos (/proc/diskstats, setor = 512 B). */
    sampleDisk() {
        let read = 0, write = 0;
        try {
            for (const line of fs.readFileSync('/proc/diskstats', 'utf8').split('\n')) {
                const f = line.trim().split(/\s+/);
                if (f.length < 14 || !PHYSICAL_DISK.test(f[2])) continue;
                read += (Number(f[5]) || 0) * 512;
                write += (Number(f[9]) || 0) * 512;
            }
        } catch (e) { /* sem /proc */ }
        return { read, write, at: Date.now() };
    }

    rate(prev, cur, a, b) {
        const dt = (cur.at - prev.at) / 1000;
        if (dt <= 0) return 0;
        return Math.max(0, Math.round((cur[a] - prev[a]) / dt)) || 0;
    }

    async collect() {
        if (this.collecting) return; // coleta anterior ainda em andamento
        this.collecting = true;
        try {
            const currentCpu = this.sampleCpu();
            const idleDiff = currentCpu.idle - this.lastCpuSample.idle;
            const totalDiff = currentCpu.total - this.lastCpuSample.total;
            this.lastCpuSample = currentCpu;
            let cpuUsage = totalDiff > 0 ? Math.round(100 * (1 - idleDiff / totalDiff)) : 0;
            cpuUsage = Math.max(0, Math.min(100, cpuUsage));
            const cores = this.coreUsages(this.sampleCores());

            const net = this.sampleNet();
            const disk = this.sampleDisk();
            const netStats = { downBps: this.rate(this.lastNet, net, 'rx'), upBps: this.rate(this.lastNet, net, 'tx') };
            const diskStats = { readBps: this.rate(this.lastDisk, disk, 'read'), writeBps: this.rate(this.lastDisk, disk, 'write') };
            this.lastNet = net;
            this.lastDisk = disk;

            const [cpuTemp, gpu] = await Promise.all([this.getCpuTemp(), this.getGpuStats()]);
            const ram = this.getRamStats();

            this.pushHistory('cpuUsage', cpuUsage);
            this.pushHistory('cpuTemp', cpuTemp);
            this.pushHistory('gpuUsage', gpu.available ? gpu.usage : 0);
            this.pushHistory('gpuTemp', gpu.available ? gpu.temp : 0);
            this.pushHistory('netDown', netStats.downBps);
            this.pushHistory('netUp', netStats.upBps);
            this.pushHistory('diskRead', diskStats.readBps);
            this.pushHistory('diskWrite', diskStats.writeBps);

            this.currentStats = {
                cpu: { usage: cpuUsage, temp: cpuTemp, cores },
                gpu,
                ram,
                net: netStats,
                disk: diskStats,
                history: this.history,
                timestamp: Date.now()
            };
            this.emit('stats', this.currentStats);
        } catch (e) {
            console.error('[HardwareMonitor] Erro na coleta:', e.message);
        } finally {
            this.collecting = false;
        }
    }

    // --- CPU temperature -------------------------------------------------

    /**
     * Sensor de temperatura da CPU. Primeiro o hwmon do driver da CPU (k10temp/zenpower na AMD, coretemp na
     * Intel), preferindo o sensor do pacote (Tctl/Tdie, "Package id 0") aos de núcleo (Tccd1, "Core 0");
     * sem rótulos (k10temp antigo), o temp1. Depois as thermal_zone (x86_pkg_temp, cpu, soc).
     */
    findCpuTemp() {
        for (const hw of listDir(sysPath('/sys/class/hwmon'))) {
            const base = sysPath(`/sys/class/hwmon/${hw}`);
            const name = readText(`${base}/name`) || '';
            if (!CPU_HWMON.test(name)) continue;
            let best = null;
            for (const f of listDir(base)) {
                const m = /^temp(\d+)_input$/.exec(f);
                if (!m) continue;
                const index = Number(m[1]);
                const label = readText(`${base}/temp${index}_label`) || '';
                let score = 1;                                               // núcleo rotulado (Core 3, Tccd1)
                if (!label) score = 2;                                       // sem rótulo: temp1 costuma ser o pacote
                if (/^(CPU|Core 0)\b/i.test(label)) score = 3;
                if (/^(Tctl|Tdie|Package id \d+|Physical id \d+)$/i.test(label)) score = 4;
                if (!best || score > best.score || (score === best.score && index < best.index)) best = { path: `${base}/${f}`, label: label || `temp${index}`, score, index };
            }
            if (best) return { path: best.path, source: `${name}/${best.label}` };
        }
        for (const zone of listDir(sysPath('/sys/class/thermal'))) {
            if (!zone.startsWith('thermal_zone')) continue;
            const base = sysPath(`/sys/class/thermal/${zone}`);
            const type = readText(`${base}/type`) || '';
            if (/x86_pkg_temp|cpu|soc/i.test(type) && fs.existsSync(`${base}/temp`)) return { path: `${base}/temp`, source: `${zone}/${type}` };
        }
        return null;
    }

    async getCpuTemp() {
        if (this.cpuTempPath) {
            const val = readNumber(this.cpuTempPath);
            if (val !== null && val > 0) return Math.round(val > 1000 ? val / 1000 : val);
        }
        if (this.hasSensors) {
            const out = await this.tool('sensors', []);
            const match = out && out.match(/(?:Tctl|Tdie|Package id 0|CPUTIN|Core 0):\s*\+?([\d.]+)°C/);
            if (match) return Math.round(parseFloat(match[1]));
        }
        return null; // desconhecido: melhor que inventar um número
    }

    // --- GPU ---------------------------------------------------------------

    /**
     * GPUs visíveis no sysfs (/sys/class/drm/cardN/device). Fabricante pelo vendor PCI, driver pelo uevent.
     * - AMD (amdgpu): uso (gpu_busy_percent), temperatura (hwmon "edge") e VRAM usada/total.
     * - Intel (xe/i915): o kernel não expõe uso; Arc tem temperatura (hwmon) e VRAM total (tile0).
     * - NVIDIA sem nvidia-smi (nouveau): só temperatura, quando o hwmon existe.
     */
    findSysfsGpus() {
        const gpus = [];
        for (const card of listDir(sysPath('/sys/class/drm'))) {
            if (!/^card\d+$/.test(card)) continue;
            const dev = sysPath(`/sys/class/drm/${card}/device`);
            if (!fs.existsSync(dev)) continue;
            const uevent = readText(`${dev}/uevent`) || '';
            const driver = (/^DRIVER=(.+)$/m.exec(uevent) || [])[1] || (() => { try { return path.basename(fs.readlinkSync(`${dev}/driver`)); } catch (e) { return null; } })();
            const vendorId = (readText(`${dev}/vendor`) || '').toLowerCase();
            const vendor = PCI_VENDOR[vendorId] || (driver === 'amdgpu' || driver === 'radeon' ? 'amd' : /^(i915|xe)$/.test(driver || '') ? 'intel' : /^(nvidia|nouveau)$/.test(driver || '') ? 'nvidia' : null);
            if (!vendor) continue;
            let pciAddress = null;
            try { pciAddress = path.basename(fs.realpathSync(dev)); } catch (e) { /* sem PCI */ }
            // iGPU fica no barramento PCI 00 (0000:00:xx.x); dedicada em outro barramento
            const discrete = /^[0-9a-f]{4}:([0-9a-f]{2}):/i.test(pciAddress || '') ? !/^[0-9a-f]{4}:00:/i.test(pciAddress) : null;
            let tempPath = null;
            let tempLabel = null;
            for (const hw of listDir(`${dev}/hwmon`)) {
                const hb = `${dev}/hwmon/${hw}`;
                for (const f of listDir(hb)) {
                    const m = /^temp(\d+)_input$/.exec(f);
                    if (!m) continue;
                    const label = readText(`${hb}/temp${m[1]}_label`) || '';
                    // amdgpu: edge (temp1), junction, mem; Intel xe: pkg/vram. Prefere edge/pkg, senão o primeiro
                    if (!tempPath || /^(edge|pkg)$/i.test(label)) { tempPath = `${hb}/${f}`; tempLabel = label || `temp${m[1]}`; }
                }
                if (tempPath) break;
            }
            const firstExisting = (...cands) => cands.find(p => fs.existsSync(p)) || null;
            const vramTotalPath = firstExisting(`${dev}/mem_info_vram_total`, `${dev}/tile0/physical_vram_size_bytes`);
            const vramUsedPath = firstExisting(`${dev}/mem_info_vram_used`);
            const busyPath = firstExisting(`${dev}/gpu_busy_percent`);
            gpus.push({ card, vendor, driver, pciAddress, discrete, busyPath, tempPath, tempLabel, vramUsedPath, vramTotalPath, vramTotalBytes: vramTotalPath ? readNumber(vramTotalPath) : null });
        }
        return gpus;
    }

    /** Com iGPU + dedicada, fica com a dedicada; em empate, a com mais VRAM, depois a que expõe uso e temperatura. */
    static pickGpu(gpus) {
        const usable = (gpus || []).filter(g => g.busyPath || g.tempPath || g.vramTotalPath);
        if (!usable.length) return null;
        const score = (g) => (g.discrete ? 1000 : 0) + ((g.vramTotalBytes || 0) / 1024 ** 3) + (g.busyPath ? 10 : 0) + (g.tempPath ? 1 : 0);
        return usable.slice().sort((a, b) => score(b) - score(a) || a.card.localeCompare(b.card))[0];
    }

    /** Leitura da GPU escolhida no sysfs. Campos que o driver não expõe vêm como null ("--" nas teclas). */
    readSysfsGpu(g) {
        const usage = g.busyPath ? readNumber(g.busyPath) : null;
        const tempRaw = g.tempPath ? readNumber(g.tempPath) : null;
        const used = g.vramUsedPath ? readNumber(g.vramUsedPath) : null;
        const total = g.vramTotalPath ? readNumber(g.vramTotalPath) : null;
        return {
            usage: usage === null ? null : Math.max(0, Math.min(100, usage)),
            temp: tempRaw !== null ? Math.round(tempRaw > 1000 ? tempRaw / 1000 : tempRaw) : null,
            vramUsedGB: used !== null ? (used / 1024 ** 3).toFixed(1) : (total !== null ? '--' : '0.0'),
            vramTotalGB: total !== null ? (total / 1024 ** 3).toFixed(1) : '0.0',
            vramPercent: used !== null && total ? Math.round((used / total) * 100) : (total !== null ? null : 0),
            vendor: g.vendor,
            available: true
        };
    }

    emptyGpu() {
        return { usage: 0, temp: null, vramUsedGB: '0.0', vramTotalGB: '0.0', vramPercent: 0, available: false };
    }

    /** Ferramenta externa com contagem de falhas: depois de 5 seguidas, desliga e avisa uma vez. */
    async tool(cmd, args) {
        const res = await run(cmd, args);
        if (res.out !== undefined) { this.toolFailures[cmd] = 0; return res.out; }
        if (++this.toolFailures[cmd] >= TOOL_MAX_FAILURES) {
            if (cmd === 'sensors') this.hasSensors = false; else this.hasNvidiaSmi = false;
            console.warn(`[HardwareMonitor] ${cmd} falhou ${TOOL_MAX_FAILURES} vezes seguidas (${res.error}); desativado até reiniciar o servidor`);
        }
        return null;
    }

    async getGpuStats() {
        if (this.hasNvidiaSmi) {
            // Stream contínuo (com cliente conectado): amostra recente sem criar processo nenhum
            if (this.gpuStream && this.gpuLatest && Date.now() - this.gpuLatest.at < this.intervalMs * 3) {
                return HardwareMonitor.nvidiaStats(this.gpuLatest.parts);
            }
            const out = await this.tool('nvidia-smi', [
                '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
                '--format=csv,noheader,nounits'
            ]);
            if (out) {
                const parts = HardwareMonitor.parseNvidiaCsv(out.trim().split('\n')[0]);
                if (parts) return HardwareMonitor.nvidiaStats(parts);
            }
        }

        if (this.sysGpu) return this.readSysfsGpu(this.sysGpu);

        return this.emptyGpu();
    }

    // --- RAM ---------------------------------------------------------------

    getRamStats() {
        let total = os.totalmem();
        let free = os.freemem();
        try {
            const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
            const totalM = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
            const availM = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
            if (totalM && availM) {
                total = parseInt(totalM[1], 10) * 1024;
                free = parseInt(availM[1], 10) * 1024;
            }
        } catch (e) {}
        const used = total - free;
        return {
            totalGB: (total / 1024 ** 3).toFixed(1),
            usedGB: (used / 1024 ** 3).toFixed(1),
            freeGB: (free / 1024 ** 3).toFixed(1),
            percent: total > 0 ? Math.round((used / total) * 100) : 0
        };
    }
}

module.exports = HardwareMonitor;
