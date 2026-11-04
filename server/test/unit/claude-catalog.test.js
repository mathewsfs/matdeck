// Catálogo de ações: grupo "Claude Code" tem só o resumo (a lista dos terminais).
// Uso: node claude-catalog.test.js
const { buildActionCatalog } = require('../../src/actionCatalog');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

const group = (ctx) => buildActionCatalog(ctx).groups.find((x) => x.id === 'claude');
const g = group({});
check('grupo claude existe', !!g && g.label === 'Claude Code' && g.icon === 'claude', g && { id: g.id, label: g.label, icon: g.icon });
check('só o resumo (sem teclas por terminal)', !!g && g.actions.map((a) => a.id).join() === 'claude:summary', g && g.actions.map((a) => a.id));
const sum = g && g.actions.find((a) => a.id === 'claude:summary');
check('resumo é 2x2, indicador e a dica fala em esticar', !!sum && sum.defaultSpan.cols === 2 && sum.defaultSpan.rows === 2 && sum.kind === 'indicator' && sum.label === 'Claude: resumo' && /Tamanho da tecla/.test(sum.hint), sum);
check('claudeSlots no contexto não muda nada', group({ claudeSlots: 3 }).actions.length === 1 && group({ claudeSlots: 'x' }).actions.length === 1);

console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
process.exitCode = fails ? 1 : 0;
