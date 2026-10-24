// Testes de integração: cada um sobe uma instância isolada na porta 8899 (pasta de dados temporária),
// então rodam em sequência. Precisam de um IP de rede local (para simular um dispositivo) e, para o mixer,
// de PipeWire/PulseAudio; sem isso alguns checks são pulados ou falham. Uso: npm run test:integration
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = path.join(__dirname, 'integration');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
let failed = 0;
for (const f of files) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-test-'));
    console.log(`\n=== ${f} ===`);
    const r = spawnSync(process.execPath, [path.join(dir, f), data], { stdio: 'inherit', timeout: 120000 });
    fs.rmSync(data, { recursive: true, force: true });
    if (r.status !== 0) { failed++; console.error(`--- ${f}: FALHOU (código ${r.status})`); }
}
console.log(failed ? `\n${failed} de ${files.length} teste(s) de integração falharam` : `\nTodos os ${files.length} testes de integração passaram`);
process.exit(failed ? 1 : 0);
