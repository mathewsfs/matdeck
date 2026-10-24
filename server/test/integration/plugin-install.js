// Harness: instalação de plugin Elgato com o adm-zip novo (0.6.1) numa instância isolada.
// Zips são montados com python3 zipfile para poder criar entradas maliciosas (zip slip, symlink).
// Uso: node plugin-install.js [MATDECK_DATA_DIR] [caminho de server/src]
process.env.PORT = '8899';
process.env.MATDECK_DATA_DIR = process.argv[2] || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'matdeck-test-'));
process.env.MATDECK_ELGATO = '0';
process.env.MATDECK_TRAY = '0';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const SRC = process.argv[3] || path.join(__dirname, '..', '..', 'src');
const DATA = process.env.MATDECK_DATA_DIR;
const WindowDetector = require(path.join(SRC, 'windowDetector'));
WindowDetector.prototype.startBackend = function () {};
WindowDetector.prototype.stopBackend = function () {};
require(path.join(SRC, 'index'));

const PORT = 8899;
const req = (method, p, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body) h['content-length'] = body.length;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, (res) => {
        let buf = ''; res.on('data', c => buf += c); res.on('end', () => { let d = buf; try { d = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, data: d }); });
    });
    r.on('error', reject); if (body) r.write(body); r.end();
});
let fails = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra)}`); if (!ok) fails++; };

const outside = path.join(DATA, 'fora-do-plugin');
fs.mkdirSync(outside, { recursive: true });
const manifest = (uuid) => JSON.stringify({ UUID: uuid, Name: 'Teste zz', Version: '0.0.1', Author: 'teste', CodePath: 'plugin.js', Nodejs: { Version: '20' }, Actions: [] });

/** Monta um zip com python3 zipfile; entries: [{name, data, symlink?}] */
function buildZip(file, entries) {
    const script = `
import zipfile, sys, json
entries = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for e in entries:
        if e.get('symlink'):
            zi = zipfile.ZipInfo(e['name']); zi.create_system = 3; zi.external_attr = (0o120777 << 16)
            z.writestr(zi, e['data'])
        else:
            z.writestr(e['name'], e['data'])
`;
    execFileSync('python3', ['-I', '-c', script, file, JSON.stringify(entries)]);
    return fs.readFileSync(file);
}
const zipHeaders = (name) => ({ 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) });

setTimeout(async () => {
    try {
        // 1) plugin válido
        const good = buildZip(path.join(DATA, 'good.zip'), [
            { name: 'zz.teste.bom.sdPlugin/manifest.json', data: manifest('zz.teste.bom') },
            { name: 'zz.teste.bom.sdPlugin/plugin.js', data: 'console.log("oi")' }
        ]);
        let r = await req('POST', '/api/plugins/install', { body: good, headers: zipHeaders('bom.streamDeckPlugin') });
        check('plugin válido instala', r.status === 200 && r.data.success && r.data.plugin.uuid === 'zz.teste.bom', r.data);
        check('arquivos extraídos no lugar certo', fs.existsSync(path.join(DATA, 'plugins', 'unpacked', 'zz.teste.bom.sdPlugin', 'plugin.js')));
        r = await req('GET', '/api/plugins');
        check('GET /api/plugins lista o plugin', r.status === 200 && (r.data.plugins || []).some(p => p.uuid === 'zz.teste.bom'), (r.data.plugins || []).map(p => p.uuid));

        // 2) zip slip: entrada ../../ não pode sair da pasta
        const slip = buildZip(path.join(DATA, 'slip.zip'), [
            { name: 'zz.teste.slip.sdPlugin/manifest.json', data: manifest('zz.teste.slip') },
            { name: '../../zz-evil-slip.txt', data: 'fora' },
            { name: 'zz.teste.slip.sdPlugin/../../../zz-evil-slip2.txt', data: 'fora' }
        ]);
        r = await req('POST', '/api/plugins/install', { body: slip, headers: zipHeaders('slip.streamDeckPlugin') });
        const slipFiles = [path.join(DATA, 'zz-evil-slip.txt'), path.join(DATA, '..', 'zz-evil-slip.txt'), path.join(require('os').tmpdir(), 'zz-evil-slip.txt'), path.join(require('os').tmpdir(), 'zz-evil-slip2.txt'), path.join(DATA, 'zz-evil-slip2.txt')];
        check('zip slip: nada escrito fora da pasta temporária', !slipFiles.some(f => fs.existsSync(f)), slipFiles.filter(f => fs.existsSync(f)));
        check('zip slip: resposta é sucesso (entradas neutralizadas) ou erro limpo 400', r.status === 200 || r.status === 400, r.status);

        // 3) symlink para fora + arquivo através dele
        const sym = buildZip(path.join(DATA, 'sym.zip'), [
            { name: 'zz.teste.sym.sdPlugin/manifest.json', data: manifest('zz.teste.sym') },
            { name: 'zz.teste.sym.sdPlugin/link', data: outside, symlink: true },
            { name: 'zz.teste.sym.sdPlugin/link/zz-evil-sym.txt', data: 'fora' }
        ]);
        r = await req('POST', '/api/plugins/install', { body: sym, headers: zipHeaders('sym.streamDeckPlugin') });
        check('symlink: nada escrito na pasta de destino do link', !fs.existsSync(path.join(outside, 'zz-evil-sym.txt')), fs.readdirSync(outside));
        check('symlink: resposta 200 ou 400, sem travar', r.status === 200 || r.status === 400, r.status);
        const installedSym = path.join(DATA, 'plugins', 'unpacked', 'zz.teste.sym.sdPlugin', 'link');
        let symInfo = 'ausente';
        try { const st = fs.lstatSync(installedSym); symInfo = st.isSymbolicLink() ? 'symlink->' + fs.readlinkSync(installedSym) : (st.isDirectory() ? 'dir' : 'arquivo'); } catch (e) {}
        check('symlink: não virou link real apontando para fora', !symInfo.startsWith('symlink->' + outside), symInfo);

        // 4) zip inválido: erro limpo
        r = await req('POST', '/api/plugins/install', { body: Buffer.from('isto não é um zip'), headers: zipHeaders('lixo.streamDeckPlugin') });
        check('zip inválido -> 400 com mensagem', r.status === 400 && /inválido|manifest/i.test(r.data.error || ''), r.data);

        // 5) remover os plugins de teste
        for (const id of ['zz.teste.bom', 'zz.teste.slip', 'zz.teste.sym']) {
            r = await req('DELETE', `/api/plugins/${id}`);
            check(`remove ${id}`, r.status === 200 || r.status === 404, r.status);
        }
        r = await req('GET', '/api/plugins');
        check('nenhum plugin zz-teste sobrou', !(r.data.plugins || []).some(p => /^zz\./.test(p.uuid)));
    } catch (e) {
        console.error('ERRO NO TESTE:', e); fails++;
    } finally {
        console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS CHECKS OK');
        setTimeout(() => { process.exitCode = fails ? 1 : 0; process.kill(process.pid, 'SIGTERM'); }, 200);
    }
}, 1500);
