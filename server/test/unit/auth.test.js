// Teste unitário de server/src/auth.js: Host permitido, loopback, cookies, registro de dispositivos e emparelhamento por PIN.
// Uso: node auth.test.js [caminho de server/src]
const path = require('path');
const fs = require('fs');
const os = require('os');
const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'src');
const auth = require(path.join(SRC, 'auth'));

let fails = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); if (!ok) fails++; };

// --- helpers puros ---
check('loopback IPv4', auth.isLoopbackAddress('127.0.0.1'));
check('loopback IPv4 outro octeto', auth.isLoopbackAddress('127.5.6.7'));
check('loopback IPv6', auth.isLoopbackAddress('::1'));
check('loopback IPv4 mapeado em IPv6', auth.isLoopbackAddress('::ffff:127.0.0.1'));
check('LAN não é loopback', !auth.isLoopbackAddress('192.168.0.10'));
check('vazio não é loopback', !auth.isLoopbackAddress(''));
check('normalizeIp tira ::ffff:', auth.normalizeIp('::ffff:192.168.0.10') === '192.168.0.10');
check('hostnameOf host:porta', auth.hostnameOf('localhost:8888') === 'localhost');
check('hostnameOf IPv6 com colchetes', auth.hostnameOf('[::1]:8888') === '::1');
check('hostnameOf maiúsculas', auth.hostnameOf('MeuPC.local') === 'meupc.local');
check('parseCookies', JSON.stringify(auth.parseCookies('a=1; matdeck_device=abc%3D; b=x=y')) === JSON.stringify({ a: '1', matdeck_device: 'abc=', b: 'x=y' }));
check('parseCookies vazio', Object.keys(auth.parseCookies(undefined)).length === 0);
check('describeClient iPad', /iPad/.test(auth.describeClient('Mozilla/5.0 (iPad; CPU OS 9_3_5 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13G36 Safari/601.1')), auth.describeClient('Mozilla/5.0 (iPad; CPU OS 9_3_5 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13G36 Safari/601.1'));
check('describeClient Android', /Android/.test(auth.describeClient('Mozilla/5.0 (Linux; Android 4.4.4; SM-T230 Build/KTU84P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/33.0.0.0 Safari/537.36')), auth.describeClient('Mozilla/5.0 (Linux; Android 4.4.4; SM-T230 Build/KTU84P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/33.0.0.0 Safari/537.36'));
check('describeClient sem UA', typeof auth.describeClient('') === 'string' && auth.describeClient('').length > 0, auth.describeClient(''));

// --- HostAllowlist ---
const fakeIfaces = () => ({ eth0: [{ address: '192.168.0.42', family: 'IPv4', internal: false }, { address: 'fe80::1%eth0', family: 'IPv6', internal: false }] });
const hosts = new auth.HostAllowlist({ interfaces: fakeIfaces, hostname: () => 'MeuPC', extra: () => ['deck.lan'] });
check('Host localhost', hosts.isAllowed('localhost:8888'));
check('Host 127.0.0.1', hosts.isAllowed('127.0.0.1:8888'));
check('Host [::1]', hosts.isAllowed('[::1]:8888'));
check('Host IP da interface', hosts.isAllowed('192.168.0.42:8888'));
check('Host IPv6 da interface sem zona', hosts.isAllowed('[fe80::1]:8888'));
check('Host nome da máquina', hosts.isAllowed('meupc:8888'));
check('Host nome.local', hosts.isAllowed('MeuPC.local:8888'));
check('Host extra da config', hosts.isAllowed('deck.lan'));
check('Host de fora (rebinding) bloqueado', !hosts.isAllowed('evil.example.com:8888'));
check('Host de IP alheio bloqueado', !hosts.isAllowed('192.168.0.99:8888'));
check('Host vazio bloqueado', !hosts.isAllowed(''));

// --- DeviceRegistry ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matdeck-auth-'));
const regPath = path.join(dir, 'devices.json');
const reg = new auth.DeviceRegistry(regPath);
check('registro nasce vazio', reg.list().length === 0);
const created = reg.create({ name: 'Tablet', ip: '192.168.0.10' });
check('create devolve token longo', typeof created.token === 'string' && created.token.length >= 32);
check('create devolve dispositivo com id e nome', created.device && created.device.id && created.device.name === 'Tablet');
check('findByToken acha', reg.findByToken(created.token) && reg.findByToken(created.token).id === created.device.id);
check('findByToken rejeita token errado', reg.findByToken('x'.repeat(created.token.length)) === null);
check('findByToken rejeita vazio', reg.findByToken('') === null && reg.findByToken(undefined) === null);
check('list não expõe hash nem token', !JSON.stringify(reg.list()).match(/tokenHash|token"/));
check('devices.json gravado com 0600', (fs.statSync(regPath).mode & 0o777) === 0o600, (fs.statSync(regPath).mode & 0o777).toString(8));
check('arquivo não contém o token em claro', !fs.readFileSync(regPath, 'utf8').includes(created.token));
const reg2 = new auth.DeviceRegistry(regPath);
check('recarrega do disco', reg2.findByToken(created.token) && reg2.list().length === 1);
reg.touch(created.device.id, '192.168.0.11');
check('touch atualiza lastSeenAt e ip', reg.list()[0].ip === '192.168.0.11' && reg.list()[0].lastSeenAt > 0);
check('remove', reg.remove(created.device.id) === true && reg.list().length === 0 && reg.findByToken(created.token) === null);
check('remove inexistente', reg.remove('nao-existe') === false);

// --- PairingManager (relógio e sorteio injetados) ---
let now = 1_000_000;
let nextPin = 1234;
const pm = new auth.PairingManager(reg, { now: () => now, randomPin: () => String(nextPin).padStart(4, '0') });
let changes = 0; pm.on('change', () => changes++);

let r = pm.start({ ip: '10.0.0.5', name: 'Tablet A' });
check('start ok', r.ok === true && r.session && /^[a-f0-9]{16,}$/.test(r.session.id), r);
check('start não devolve o PIN', !('pin' in r.session));
check('pending traz o PIN de 4 dígitos', pm.pending().length === 1 && pm.pending()[0].pin === '1234');
check('start emite change', changes === 1);
const firstId = r.session.id;
r = pm.start({ ip: '10.0.0.5', name: 'Tablet A' });
check('segundo start do mesmo IP substitui a sessão', pm.pending().length === 1 && pm.pending()[0].id !== firstId);
const sid = r.session.id;

let v = pm.verify({ id: 'nao-existe', pin: '1234', ip: '10.0.0.5' });
check('verify sessão inexistente -> 410 (mesmo tratamento de expirada)', v.ok === false && v.status === 410, v);
v = pm.verify({ id: sid, pin: '1234', ip: '10.0.0.6' });
check('verify de outro IP é recusado', v.ok === false && v.status === 403, v);
for (let i = 1; i <= 4; i++) {
    v = pm.verify({ id: sid, pin: '0000', ip: '10.0.0.5' });
    check(`PIN errado ${i}: 401 com ${5 - i} restantes`, v.ok === false && v.status === 401 && v.attemptsLeft === 5 - i, v);
}
v = pm.verify({ id: sid, pin: '0000', ip: '10.0.0.5' });
check('5º erro: 429, sessão cancelada e cooldown', v.ok === false && v.status === 429 && v.retryAfterMs > 0 && pm.pending().length === 0, v);
r = pm.start({ ip: '10.0.0.5', name: 'Tablet A' });
check('start durante cooldown -> 429', r.ok === false && r.status === 429 && r.retryAfterMs > 0, r);
r = pm.start({ ip: '10.0.0.7', name: 'Outro' });
check('outro IP não é afetado pelo cooldown', r.ok === true);
pm.cancel(r.session.id, { punish: false });
check('cancel sem punição limpa a pendência', pm.pending().length === 0 && pm.start({ ip: '10.0.0.7', name: 'Outro' }).ok === true);
pm.cancel(pm.pending()[0].id, { punish: true });
check('recusar pelo gerenciador bloqueia o IP', pm.start({ ip: '10.0.0.7', name: 'Outro' }).status === 429);

now += 31_000; // cooldown base de 30 s vence
r = pm.start({ ip: '10.0.0.5', name: 'Tablet A' });
check('cooldown venceu após 30 s', r.ok === true, r);
now += 2 * 60 * 1000 + 1; // sessão expira em 2 min
v = pm.verify({ id: r.session.id, pin: '1234', ip: '10.0.0.5' });
check('sessão expirada -> 410', v.ok === false && v.status === 410, v);
check('expirada sai da lista', pm.pending().length === 0);

nextPin = 42;
r = pm.start({ ip: '10.0.0.5', name: 'Tablet A' });
check('PIN com zeros à esquerda', pm.pending()[0].pin === '0042');
v = pm.verify({ id: r.session.id, pin: '0042', ip: '10.0.0.5' });
check('PIN certo -> token e dispositivo', v.ok === true && typeof v.token === 'string' && v.device && v.device.name === 'Tablet A' && v.device.ip === '10.0.0.5', v.ok ? Object.keys(v) : v);
check('dispositivo fica no registro', reg.findByToken(v.token) && reg.list().length === 1);
check('sessão consumida', pm.pending().length === 0);
check('verify com pin não numérico -> 400', pm.verify({ id: 'x', pin: 'ab', ip: '10.0.0.5' }).status === 400);

// limite de pendências simultâneas
for (let i = 0; i < 10; i++) pm.start({ ip: `10.0.1.${i}`, name: 'Spam' });
check('no máximo 6 pendências ao mesmo tempo', pm.pending().length <= 6, pm.pending().length);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS CHECKS OK');
process.exit(fails ? 1 : 0);
