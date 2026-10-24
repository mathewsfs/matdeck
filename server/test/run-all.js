// Roda os testes unitários em sequência (cada arquivo é um processo; sai com erro se algum falhar).
// Uso: npm test (em server/)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'unit');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;
for (const f of files) {
    console.log(`\n=== ${f} ===`);
    const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
    if (r.status !== 0) { failed++; console.error(`--- ${f}: FALHOU (código ${r.status})`); }
}
console.log(failed ? `\n${failed} de ${files.length} arquivo(s) de teste falharam` : `\nTodos os ${files.length} arquivos de teste passaram`);
process.exit(failed ? 1 : 0);
