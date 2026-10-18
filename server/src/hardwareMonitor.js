const fs = require('fs');
const os = require('os');
const { execFile, which } = require('./hostExec');
const EventEmitter = require('events');

const EXEC_TIMEOUT_MS = 800;
const HISTORY_LEN = 60;               // 60 amostras = 1 min a 1 Hz (gráficos das teclas)
const VIRTUAL_IFACE = /^(lo|docker|podman|cni|br-|veth|virbr|tun|tap|wg|vmnet|zt|tailscale|flannel)/i;
const PHYSICAL_DISK = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+|hd[a-z]+)$/;

const TOOL_MAX_FAILURES = 5;

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
        this.lastCpuSample = this.sampleCpu();
        this.lastCoreSamples = this.sampleCores();
        this.lastNet = this.sampleNet();
        this.lastDisk = this.sampleDisk();
        this.history = {};
        for (const k of ['cpuUsage', 'cpuTemp', 'gpuUsage', 'gpuTemp', 'netDown', 'netUp', 'diskRead', 'diskWrite']) this.history[k] = [];

        // Descobertos uma vez para não varrer o sysfs a cada segundo
        this.cpuTempPath = this.findCpuTempPath();
        this.amdGpu = this.findAmdGpu();
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

    start() {
        if (this.timer) return;
        this.collect();
        this.timer = setInterval(() => this.collect(), this.intervalMs);
        console.log('[HardwareMonitor] Coleta de estatísticas de CPU, GPU e RAM iniciada');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
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

    findCpuTempPath() {
        // Prefere hwmon de CPU (k10temp AMD, coretemp Intel) e só depois thermal_zone
        for (const hw of listDir('/sys/class/hwmon')) {
            const base = `/sys/class/hwmon/${hw}`;
            let name = '';
            try { name = fs.readFileSync(`${base}/name`, 'utf8').trim(); } catch (e) {}
            if (/k10temp|coretemp|zenpower|cpu_thermal/i.test(name)) {
                for (const f of listDir(base)) {
                    if (/^temp\d+_input$/.test(f)) return `${base}/${f}`;
                }
            }
        }
        for (const zone of listDir('/sys/class/thermal')) {
            if (!zone.startsWith('thermal_zone')) continue;
            const base = `/sys/class/thermal/${zone}`;
            let type = '';
            try { type = fs.readFileSync(`${base}/type`, 'utf8').trim(); } catch (e) {}
            if (/x86_pkg_temp|cpu|soc/i.test(type) && fs.existsSync(`${base}/temp`)) return `${base}/temp`;
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

    findAmdGpu() {
        for (const card of listDir('/sys/class/drm')) {
            if (!/^card\d+$/.test(card)) continue;
            const dev = `/sys/class/drm/${card}/device`;
            if (!fs.existsSync(`${dev}/gpu_busy_percent`)) continue;
            let tempPath = null;
            for (const hw of listDir(`${dev}/hwmon`)) {
                if (fs.existsSync(`${dev}/hwmon/${hw}/temp1_input`)) {
                    tempPath = `${dev}/hwmon/${hw}/temp1_input`;
                    break;
                }
            }
            return {
                busyPath: `${dev}/gpu_busy_percent`,
                tempPath,
                vramUsedPath: fs.existsSync(`${dev}/mem_info_vram_used`) ? `${dev}/mem_info_vram_used` : null,
                vramTotalPath: fs.existsSync(`${dev}/mem_info_vram_total`) ? `${dev}/mem_info_vram_total` : null
            };
        }
        return null;
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
            const out = await this.tool('nvidia-smi', [
                '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
                '--format=csv,noheader,nounits'
            ]);
            if (out) {
                const parts = out.trim().split('\n')[0].split(',').map(s => parseFloat(s.trim()));
                if (parts.length >= 4 && !parts.some(isNaN)) {
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
            }
        }

        if (this.amdGpu) {
            const usage = readNumber(this.amdGpu.busyPath) || 0;
            const tempRaw = this.amdGpu.tempPath ? readNumber(this.amdGpu.tempPath) : null;
            const used = this.amdGpu.vramUsedPath ? readNumber(this.amdGpu.vramUsedPath) : null;
            const total = this.amdGpu.vramTotalPath ? readNumber(this.amdGpu.vramTotalPath) : null;
            return {
                usage,
                temp: tempRaw !== null ? Math.round(tempRaw / 1000) : null,
                vramUsedGB: used !== null ? (used / 1024 ** 3).toFixed(1) : '0.0',
                vramTotalGB: total !== null ? (total / 1024 ** 3).toFixed(1) : '0.0',
                vramPercent: used !== null && total ? Math.round((used / total) * 100) : 0,
                available: true
            };
        }

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
