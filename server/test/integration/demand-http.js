// Integração do modo econômico: sem cliente WS o hardware é coletado a cada 10 s e não há nvidia-smi;
// com um cliente conectado volta a 1 Hz com nvidia-smi contínuo; ao desconectar, o stream morre.
// Uso: node demand-http.js [MATDECK_DATA_DIR] [caminho de server/src]
process.env.PORT = '8899';
process.env.MATDECK_DATA_DIR = process.argv[2] || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'matdeck-test-'));
process.env.MATDECK_ELGATO = '0';
process.env.MATDECK_TRAY = '0';
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const SRC = process.argv[3] || path.join(__dirname, '..', '..', 'src');
const WindowDetector = require(path.join(SRC, 'windowDetector'));
WindowDetector.prototype.startBackend = function () {};
WindowDetector.prototype.stopBackend = function () {};
require(path.join(SRC, 'index'));
const WebSocket = require(path.join(SRC, '..', 'node_modules', 'ws'));

const PORT = 8899;
const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } }); }).on('error', reject);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const myStreams = () => { try { return execFileSync('pgrep', ['-f', '^nvidia-smi .*-lms', '-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch (e) { return []; } };
const hasNvidia = (() => { try { execFileSync('sh', ['-c', 'command -v nvidia-smi'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

setTimeout(async () => {
    let ws = null;
    try {
        // modo econômico desde o boot
        const t1 = (await get('/api/status')).hardware.timestamp;
        await sleep(2500);
        const t2 = (await get('/api/status')).hardware.timestamp;
        check('sem clientes: hardware não recoletado em 2,5 s (cadência de 10 s)', t1 === t2, { t1, t2 });
        check('sem clientes: nenhum nvidia-smi contínuo', myStreams().length === 0, myStreams());

        // cliente conecta: tempo real
        ws = new WebSocket(`ws://127.0.0.1:${PORT}/deck`);
        await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
        await sleep(400);
        const t3 = (await get('/api/status')).hardware.timestamp;
        check('cliente conectado: coleta imediata (timestamp novo)', t3 > t2, { t2, t3 });
        await sleep(1500);
        const t4 = (await get('/api/status')).hardware.timestamp;
        check('cliente conectado: recoleta em 1,5 s (1 Hz)', t4 > t3, { t3, t4 });
        if (hasNvidia) {
            check('cliente conectado: um nvidia-smi contínuo em execução', myStreams().length === 1, myStreams());
            await sleep(1200);
            const gpu = (await get('/api/status')).hardware.gpu;
            check('GPU disponível com temperatura numérica vinda do stream', gpu && gpu.available === true && typeof gpu.temp === 'number' && gpu.temp > 0, gpu);
        } else {
            console.log('(sem nvidia-smi: checagens do stream puladas)');
        }
        // hardwareStats chegando pelo WebSocket a 1 Hz
        let n = 0; const onMsg = (m) => { try { if (JSON.parse(m.toString()).event === 'hardwareStats') n++; } catch (e) {} };
        ws.on('message', onMsg);
        await sleep(2300);
        ws.off('message', onMsg);
        check('cliente recebe hardwareStats ~1/s (2 em 2,3 s)', n >= 2 && n <= 3, n);

        // cliente sai: volta ao econômico
        ws.close(); ws = null;
        await sleep(2500);
        check('sem clientes de novo: nvidia-smi contínuo encerrado', myStreams().length === 0, myStreams());
        const t5 = (await get('/api/status')).hardware.timestamp;
        await sleep(2500);
        const t6 = (await get('/api/status')).hardware.timestamp;
        check('sem clientes de novo: cadência lenta', t5 === t6, { t5, t6 });
        const st = await get('/api/status');
        check('/api/status continua inteiro (fans, integrações)', st && st.integrations && typeof st.clientsConnected === 'number');
    } catch (e) {
        console.error('ERRO NO TESTE:', e); fails++;
    } finally {
        if (ws) { try { ws.terminate(); } catch (e) {} }
        console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS CHECKS OK');
        setTimeout(() => { process.exitCode = fails ? 1 : 0; process.kill(process.pid, 'SIGTERM'); }, 200);
    }
}, 1500);
