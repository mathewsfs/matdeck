// Altura da viewport do deck (server/web/app.js): o Safari 9 do iPad entrega innerHeight errado ao acordar
// e as teclas (posicionadas por % da altura em html.no-grid) viram barras. Uso: node deck-viewport.test.js [app.js]
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
const grab = (name) => { const i = src.indexOf(`function ${name}(`); if (i < 0) throw new Error(`function ${name} não encontrada no app.js`); let depth = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); } } };

let fails = 0; const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };

// --- pickViewportHeight(win, scr): escolhe a altura utilizável ou null quando o valor é absurdo
const ctx1 = { Math, Number, isFinite };
vm.createContext(ctx1);
vm.runInContext(grab('pickViewportHeight'), ctx1);
const pick = (innerHeight, clientHeight, scr) => ctx1.pickViewportHeight({ innerHeight, document: { documentElement: { clientHeight } } }, scr);
const ipad = { width: 768, height: 1024 };   // iPad 2 em pontos (screen não muda com a orientação no iOS 9)
check('normal (paisagem 768×1024): usa innerHeight', pick(672, 672, ipad) === 672);
check('innerHeight zerado ao acordar: cai para clientHeight', pick(0, 672, ipad) === 672);
check('innerHeight minúsculo (20 px): cai para clientHeight', pick(20, 672, ipad) === 672);
check('os dois absurdos: null (não aplica)', pick(20, 20, ipad) === null);
check('innerHeight undefined: usa clientHeight', pick(undefined, 1004, ipad) === 1004);
check('retrato 1004 px passa (piso é 40% do menor lado = 307)', pick(1004, 1004, ipad) === 1004);
check('sem screen: piso de 200 px', pick(150, 150, undefined) === null && pick(240, 240, undefined) === 240);
check('maior dos dois quando divergem pouco (barra de endereço)', pick(620, 672, ipad) === 672);

// --- syncViewportHeight(): aplica --app-h, ignora valor absurdo e tenta de novo depois
const props = {}; const timers = [];
const win = { innerHeight: 672, document: { documentElement: { clientHeight: 672, style: { setProperty: (k, v) => { props[k] = v; } } } } };
const ctx2 = { Math, Number, isFinite, window: win, document: win.document, screen: ipad, VIEWPORT_RETRY_MS: 500, viewportRetryTimer: null, viewportApplied: 0, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} };
vm.createContext(ctx2);
vm.runInContext(grab('pickViewportHeight') + '\n' + grab('syncViewportHeight'), ctx2);
ctx2.syncViewportHeight();
check('aplica --app-h com o valor bom', props['--app-h'] === '672px', props);
win.innerHeight = 20; win.document.documentElement.clientHeight = 20;
ctx2.syncViewportHeight();
check('valor absurdo não sobrescreve o bom', props['--app-h'] === '672px', props);
check('e agenda nova tentativa', timers.length > 0 && timers[0].ms >= 100, timers.map((t) => t.ms));
win.innerHeight = 672; win.document.documentElement.clientHeight = 672;
const n = timers.length; timers[0].fn();
check('a tentativa aplica quando a altura volta', props['--app-h'] === '672px' && timers.length === n, props);
win.innerHeight = 1004; win.document.documentElement.clientHeight = 1004;
ctx2.syncViewportHeight();
check('mudança real (retrato) é aplicada', props['--app-h'] === '1004px', props);

// --- gatilhos: além de resize/orientationchange, o app precisa reagir ao voltar do segundo plano
const tail = src.slice(src.indexOf('function syncViewportHeight('));
check('reaplica em pageshow', /addEventListener\('pageshow'/.test(tail));
check('reaplica em visibilitychange', /visibilitychange[\s\S]{0,200}syncViewportHeight/.test(tail));
check('tem vigia periódico', /setInterval\([\s\S]{0,120}syncViewportHeight/.test(tail));

console.log(fails ? `\n${fails} check(s) falharam` : '\nTodos os checks passaram');
process.exitCode = fails ? 1 : 0;
