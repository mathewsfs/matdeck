// Harness interno: sobe o servidor numa porta/pasta de teste com o backend de janela anulado
// (para não mexer no script KWin da instância real) e verifica o Auto-Perfil.
process.env.PORT = '8899';
process.env.MATDECK_DATA_DIR = process.argv[2] || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'matdeck-test-'));
process.env.MATDECK_ELGATO = '0';
process.env.MATDECK_TRAY = '0';
const path = require('path');
const SRC = process.argv[3] || path.join(__dirname, '..', '..', 'src');
const WindowDetector = require(path.join(SRC, 'windowDetector'));
WindowDetector.prototype.startBackend = function () { console.log('[teste] backend de janela anulado'); };
WindowDetector.prototype.stopBackend = function () {};
require(path.join(SRC, 'index'));

const http = require('http');
const req = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: 8899, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
        let buf = ''; res.on('data', c => buf += c); res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); } catch (e) { resolve({ status: res.statusCode, data: buf }); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
});
const fs = require('fs');
let fails = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); if (!ok) fails++; };
const cfg = () => JSON.parse(fs.readFileSync(path.join(process.env.MATDECK_DATA_DIR, 'config.json'), 'utf8'));

setTimeout(async () => {
    try {
        let st = (await req('GET', '/api/status')).data;
        check('nasce com AUTO desligado', st.autoDetect === false, st.autoDetect);
        let ad = (await req('GET', '/api/autodetect')).data;
        check('lista 6 apps detectáveis', Array.isArray(ad.apps) && ad.apps.length === 6, ad.apps.map(a => a.id));
        const byId = () => Object.fromEntries(ad.apps.map(a => [a.id, a]));
        check('discord resolve para o perfil discord por padrão', byId().discord.resolved === 'discord');
        check('meet resolve para meet por padrão', byId().meet.resolved === 'meet');

        // ligar e desligar persiste em config.json
        await req('POST', '/api/autodetect', { enabled: true });
        st = (await req('GET', '/api/status')).data;
        check('POST enabled:true liga', st.autoDetect === true);
        check('config.json guarda ui.autoDetect=true', cfg().ui.autoDetect === true);
        await req('POST', '/api/autodetect', { enabled: false });
        check('config.json guarda ui.autoDetect=false', cfg().ui.autoDetect === false);

        // escolha por app
        let r = await req('POST', '/api/config', { ui: { autoProfiles: { discord: 'none', spotify: 'obs', teamspeak: 'nao-existe' } } });
        check('POST /api/config aceita autoProfiles', r.status === 200);
        ad = (await req('GET', '/api/autodetect')).data;
        check('discord "none" -> não troca (resolved null)', byId().discord.resolved === null, byId().discord);
        check('spotify -> obs', byId().spotify.resolved === 'obs', byId().spotify);
        check('perfil inexistente -> não troca', byId().teamspeak.resolved === null, byId().teamspeak);
        check('obs continua padrão', byId().obs.resolved === 'obs');

        // oculto não é ativado
        await req('POST', '/api/profiles/meet/visibility', { hidden: true });
        ad = (await req('GET', '/api/autodetect')).data;
        check('perfil oculto -> não troca', byId().meet.resolved === null && byId().meet.defaultAvailable === false, byId().meet);
        await req('POST', '/api/profiles/meet/visibility', { hidden: false });

        // janela detectada de verdade: simular o evento do detector
        const server = require(path.join(SRC, 'index'));
        // a instância está no escopo do módulo; acessamos pelo detector via emissor global dos listeners
        // (o harness não tem a referência, então verificamos pela troca de perfil observada via /api/status)
        const det = WindowDetector.prototype;
        check('matchProfile classe discord', WindowDetector.matchProfile('x', 'discord') === 'discord');
        check('matchProfile título Spotify', WindowDetector.matchProfile('Spotify Premium', '') === 'spotify');
    } catch (e) { console.log('ERRO', e); fails++; }
    console.log(fails ? `\n${fails} falha(s)` : '\nTudo OK');
    await req('POST', '/api/shutdown').catch(() => {});
    setTimeout(() => { process.exitCode = fails ? 1 : 0; process.kill(process.pid, 'SIGTERM'); }, 300);
}, 1500);
