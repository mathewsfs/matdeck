// Catálogo de ações: grupo "Claude Code" gerado pelo número de vagas (claudeSlots; ausente = 4).
// Uso: node claude-catalog.test.js
const { buildActionCatalog } = require('../../src/actionCatalog');

let fails = 0;
const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

const group = (ctx) => buildActionCatalog(ctx).groups.find((x) => x.id === 'claude');
const g = group({ claudeSlots: 3 });
check('grupo claude existe', !!g && g.label === 'Claude Code' && g.icon === 'claude', g && { id: g.id, label: g.label, icon: g.icon });
check('3 vagas + resumo', !!g && g.actions.filter((a) => a.id.startsWith('claude:slot:')).length === 3 && g.actions.some((a) => a.id === 'claude:summary'), g && g.actions.map((a) => a.id));
check('sem claudeSlots: 4 vagas + resumo', (group({}) || { actions: [] }).actions.length === 5);
const slot1 = g && g.actions.find((a) => a.id === 'claude:slot:1');
check('vaga: rótulo, ícone, indicador e dica', !!slot1 && slot1.label === 'Claude: terminal 1' && slot1.icon === 'claude' && slot1.kind === 'indicator' && /vaga 1/.test(slot1.hint) && /foca a janela/.test(slot1.hint), slot1);
const sum = g && g.actions.find((a) => a.id === 'claude:summary');
check('resumo é 2x1 e indicador', !!sum && sum.defaultSpan.cols === 2 && sum.defaultSpan.rows === 1 && sum.kind === 'indicator' && sum.label === 'Claude: resumo', sum);
check('vagas em ordem, resumo por último', !!g && g.actions.map((a) => a.id).join() === 'claude:slot:1,claude:slot:2,claude:slot:3,claude:summary');
check('claudeSlots absurdo não quebra', (group({ claudeSlots: 'x' }) || { actions: [] }).actions.length === 5);

console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
process.exitCode = fails ? 1 : 0;
