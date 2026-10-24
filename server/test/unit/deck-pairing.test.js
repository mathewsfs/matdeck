// Harness do fluxo de PIN do deck (server/web/app.js): extrai o bloco "SESSÃO E EMPARELHAMENTO" e roda com
// DOM, fetch e timers falsos. Uso: node deck-pairing.test.js [caminho de app.js]
const fs = require('fs'); const vm = require('vm');
const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
const begin = src.indexOf('// SESSÃO E EMPARELHAMENTO POR PIN');
const end = src.indexOf('// BOOT', begin);
if (begin < 0 || end < 0) throw new Error('bloco de emparelhamento não encontrado no app.js');
let block = src.slice(src.lastIndexOf('\n', begin), end);
block = block.replace(/^\/\/ -+$/gm, '');
const grab = (name) => { const i = src.indexOf(`function ${name}(`); let depth = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); } } };

// DOM mínimo
const mkEl = () => { const ls = {}, attrs = {}; return { value: '', disabled: false, textContent: '', className: '', attrs, addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); }, setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; }, focus() {}, fire(t, e) { return Promise.all((ls[t] || []).map(f => f(e))); }, get hidden() { return 'hidden' in attrs; } }; };
const els = { deckOverlay: mkEl(), deckOverlayMain: mkEl(), pairCard: mkEl(), pairForm: mkEl(), pairPin: mkEl(), pairSubmit: mkEl(), pairStatus: mkEl(), gridEl: mkEl() };

// timers controláveis
let timers = []; let nextId = 1;
const fakeSetTimeout = (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; };
const fakeClearTimeout = (id) => { timers = timers.filter(t => t.id !== id); };
const runTimers = async () => { const due = timers; timers = []; for (const t of due) await t.fn(); };
let intervals = [];
const fakeSetInterval = (fn, ms) => { const id = nextId++; intervals.push({ id, fn, ms }); return id; };
const fakeClearInterval = (id) => { intervals = intervals.filter(t => t.id !== id); };

// fetch falso: fila de respostas por URL
const calls = []; const responses = {};
const apiFetch = async (url, options) => { calls.push({ url, method: (options && options.method) || 'GET', body: options && options.body }); const r = responses[url]; return typeof r === 'function' ? r(options) : (r || { ok: false, status: 0, data: null }); };
const spies = { initWebSocket: 0, pollStatus: 0, reload: 0, bodyClasses: new Set() };

const ctx = {
    console, Date, Math, String, JSON, Promise,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
    apiFetch, ...els,
    document: { body: { classList: { add: (c) => spies.bodyClasses.add(c), remove: (c) => spies.bodyClasses.delete(c) } } },
    location: { reload: () => { spies.reload++; } },
    initWebSocket: () => { spies.initWebSocket++; }, pollStatus: () => { spies.pollStatus++; },
    wsReconnectTimer: null
};
vm.createContext(ctx);
vm.runInContext(grab('setHidden') + '\n' + block, ctx);

let fails = 0; const check = (n, ok, extra) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (ok || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!ok) fails++; };
const lastCall = () => calls[calls.length - 1];
// showPairing() dispara pairStart() sem esperar (como no navegador): o harness precisa drenar as promessas pendentes
const flush = () => new Promise(r => setImmediate(r));
const reset = () => { calls.length = 0; timers = []; intervals = []; spies.initWebSocket = 0; spies.pollStatus = 0; spies.reload = 0; for (const e of Object.values(els)) { e.value = ''; e.disabled = false; e.textContent = ''; } };

(async () => {
    // 1) PC confiável: entra direto
    reset(); responses['/api/session'] = { ok: true, status: 200, data: { role: 'trusted' } };
    await ctx.startSession(); await flush();
    check('trusted: abre o WebSocket e o poll de status', spies.initWebSocket === 1 && spies.pollStatus === 1 && intervals.length === 1);
    check('trusted: cartão de PIN escondido, cartão principal visível', els.pairCard.hidden && !els.deckOverlayMain.hidden);

    // 2) servidor fora do ar: segue para o WebSocket (que reconecta sozinho)
    reset(); responses['/api/session'] = { ok: false, status: 0, data: null };
    await ctx.startSession(); await flush();
    check('servidor fora: tenta o WebSocket mesmo assim', spies.initWebSocket === 1);
    check('servidor fora: não duplica o intervalo de status', intervals.length === 0);

    // 3) convidado: tela de PIN e pedido de PIN
    reset(); intervals = [];
    responses['/api/session'] = { ok: true, status: 200, data: { role: 'guest', device: null } };
    responses['/api/pair/start'] = { ok: true, status: 200, data: { success: true, id: 'sess1', ttlMs: 120000, expiresAt: Date.now() + 120000 } };
    await ctx.startSession(); await flush();
    check('guest: não abre WebSocket', spies.initWebSocket === 0);
    check('guest: cartão de PIN visível, principal escondido, overlay visível', !els.pairCard.hidden && els.deckOverlayMain.hidden && !els.deckOverlay.hidden);
    check('guest: POST /api/pair/start', lastCall().url === '/api/pair/start' && lastCall().method === 'POST');
    check('guest: status cita o gerenciador e habilita Conectar', /gerenciador/.test(els.pairStatus.textContent) && !els.pairSubmit.disabled, els.pairStatus.textContent);
    check('guest: renovação agendada para o fim do PIN', timers.length === 1 && timers[0].ms > 120000, timers.map(t => t.ms));
    check('guest: body marcado como offline', spies.bodyClasses.has('is-offline'));

    // 4) PIN curto não chama a API
    calls.length = 0; els.pairPin.value = '12';
    await ctx.pairVerify({ preventDefault() {} });
    check('PIN curto: erro local, sem requisição', calls.length === 0 && /4 dígitos/.test(els.pairStatus.textContent) && els.pairStatus.className.includes('is-error'));

    // 5) PIN errado
    calls.length = 0; els.pairPin.value = '9999';
    responses['/api/pair/verify'] = (o) => ({ ok: false, status: 401, data: { success: false, error: 'PIN incorreto.', attemptsLeft: 3 } });
    await ctx.pairVerify({ preventDefault() {} });
    check('PIN errado: POST verify com id e pin', lastCall().url === '/api/pair/verify' && JSON.parse(lastCall().body).id === 'sess1' && JSON.parse(lastCall().body).pin === '9999');
    check('PIN errado: mostra tentativas restantes, limpa o campo, reabilita', /incorreto/.test(els.pairStatus.textContent) && /3 tentativa/.test(els.pairStatus.textContent) && els.pairPin.value === '' && !els.pairSubmit.disabled, els.pairStatus.textContent);

    // 6) digitar 4 dígitos confere sozinho
    calls.length = 0; els.pairPin.value = '1234';
    await els.pairPin.fire('input');
    check('input com 4 dígitos dispara a conferência', calls.length === 1 && calls[0].url === '/api/pair/verify');

    // 7) PIN vencido: pede outro
    calls.length = 0; els.pairPin.value = '1234';
    responses['/api/pair/verify'] = { ok: false, status: 410, data: { success: false, error: 'Este PIN expirou. Peça um novo.' } };
    responses['/api/pair/start'] = { ok: true, status: 200, data: { success: true, id: 'sess2', ttlMs: 120000 } };
    await ctx.pairVerify({ preventDefault() {} });
    check('PIN vencido: avisa e agenda novo pedido', /venceu/.test(els.pairStatus.textContent) && timers.some(t => t.ms <= 1000), els.pairStatus.textContent);
    await runTimers();
    check('PIN vencido: novo start com nova sessão', calls.some(c => c.url === '/api/pair/start') && !els.pairSubmit.disabled);
    calls.length = 0; els.pairPin.value = '0000';
    responses['/api/pair/verify'] = { ok: false, status: 401, data: { attemptsLeft: 4 } };
    await ctx.pairVerify({ preventDefault() {} });
    check('após renovar, usa o id novo', JSON.parse(lastCall().body).id === 'sess2');

    // 8) bloqueio por tentativas: espera o retryAfterMs
    calls.length = 0; timers = []; els.pairPin.value = '0000';
    responses['/api/pair/verify'] = { ok: false, status: 429, data: { error: 'PIN errado vezes demais.', retryAfterMs: 30000 } };
    await ctx.pairVerify({ preventDefault() {} });
    check('429: avisa a espera em segundos e agenda novo pedido depois dela', /30 s/.test(els.pairStatus.textContent) && timers.length === 1 && timers[0].ms >= 30000 && els.pairSubmit.disabled, { status: els.pairStatus.textContent, timers: timers.map(t => t.ms) });

    // 9) start em cooldown
    calls.length = 0; timers = [];
    responses['/api/pair/start'] = { ok: false, status: 429, data: { error: 'Muitas tentativas.', retryAfterMs: 12000 } };
    await ctx.pairStart();
    check('start 429: mensagem com segundos e nova tentativa agendada', /12 s/.test(els.pairStatus.textContent) && timers.length === 1 && timers[0].ms >= 12000, els.pairStatus.textContent);

    // 10) start falhou (sem resposta): tenta de novo em 3 s
    calls.length = 0; timers = [];
    responses['/api/pair/start'] = { ok: false, status: 0, data: null };
    await ctx.pairStart();
    check('start sem resposta: avisa e tenta em 3 s', /Sem resposta/.test(els.pairStatus.textContent) && timers.length === 1 && timers[0].ms === 3000, els.pairStatus.textContent);

    // 11) start 400 (já tem acesso): revalida a sessão e entra
    calls.length = 0; timers = []; intervals = []; spies.initWebSocket = 0;
    responses['/api/pair/start'] = { ok: false, status: 400, data: { error: 'Este dispositivo já está emparelhado.' } };
    responses['/api/session'] = { ok: true, status: 200, data: { role: 'device', device: { id: 'd1', name: 'Tablet' } } };
    await ctx.pairStart(); await flush();
    check('start 400: volta pela sessão e abre o WebSocket', calls.some(c => c.url === '/api/session') && spies.initWebSocket === 1 && els.pairCard.hidden && !els.deckOverlayMain.hidden);

    // 12) sucesso: recarrega a página
    reset(); intervals = [];
    responses['/api/session'] = { ok: true, status: 200, data: { role: 'guest' } };
    responses['/api/pair/start'] = { ok: true, status: 200, data: { success: true, id: 'sess3', ttlMs: 120000 } };
    await ctx.startSession(); await flush();
    els.pairPin.value = '4321';
    responses['/api/pair/verify'] = { ok: true, status: 200, data: { success: true, token: 'tok', device: { id: 'd2', name: 'Tablet' } } };
    await ctx.pairVerify({ preventDefault() {} });
    check('sucesso: status ok e renovação cancelada', els.pairStatus.className.includes('is-ok') && !timers.some(t => t.ms > 100000), { cls: els.pairStatus.className, timers: timers.map(t => t.ms) });
    await runTimers();
    check('sucesso: location.reload()', spies.reload === 1);

    console.log(fails ? `\n${fails} falha(s)` : '\nTudo OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERRO NO HARNESS:', e); process.exit(1); });
