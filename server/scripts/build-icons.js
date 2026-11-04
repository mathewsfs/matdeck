#!/usr/bin/env node
/**
 * Gera src/icons.json a partir de ícones SVG públicos (Lucide + Simple Icons),
 * rasterizados em PNG 96x96 com fundo transparente via ImageMagick (`magick`).
 *
 * Uso: node scripts/build-icons.js
 *
 * O app Android (API 19) decodifica com BitmapFactory, portanto o JSON só pode
 * conter PNG em data URL. Sem dependências npm: usa https + child_process.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const LUCIDE_VERSION = '0.468.0';
const SIMPLE_ICONS_VERSION = '13.0.0';
const SIZE = 96;
const STROKE_COLOR = '#E6E8EF';
const STROKE_WIDTH = '2.25';
const ALPHA_LEVELS = 32;

const OUT_JSON = path.resolve(__dirname, '../src/icons.json');
const OUT_LICENSE = path.resolve(__dirname, '../src/ICONS-LICENSE.md');
const WORK_DIR = path.join(os.tmpdir(), 'matdeck-build-icons');

// chave do JSON -> { lucide: nome } | { simple: slug, fill: cor }
// As chaves antigas (scene, stream, rec...) continuam existindo para não quebrar presets salvos.
const ICONS = {
    // --- chaves legadas ---
    scene: { lucide: 'clapperboard' },
    stream: { lucide: 'radio-tower' },
    rec: { lucide: 'circle-dot' },
    replay: { lucide: 'rewind' },
    hangup: { lucide: 'phone-off' },
    headphone: { lucide: 'headphones' },
    cam_on: { lucide: 'video' },
    cam_muted: { lucide: 'video-off' },
    mic_on: { lucide: 'mic' },
    mic_muted: { lucide: 'mic-off' },
    hand: { lucide: 'hand' },
    discord: { simple: 'discord', fill: '#5865F2' },
    nextcloud: { simple: 'nextcloud', fill: '#0082C9' },
    teamspeak: { simple: 'teamspeak', fill: '#2580C3' },
    cpu: { lucide: 'cpu' },
    gpu: { lucide: 'circuit-board' },
    ram: { lucide: 'memory-stick' },
    temp: { lucide: 'thermometer' },

    // --- voz / chat ---
    afk: { lucide: 'moon' },
    ptt: { lucide: 'radio' },
    whisper: { lucide: 'ear' },
    channel: { lucide: 'hash' },
    channel_sub: { lucide: 'corner-down-right' },
    server: { lucide: 'server' },
    user: { lucide: 'user' },
    talking: { lucide: 'audio-lines' },
    headphone_off: { lucide: 'headphone-off' },
    disconnect: { lucide: 'unplug' },
    chat: { lucide: 'message-square' },
    people: { lucide: 'users' },
    captions: { lucide: 'captions' },
    share: { lucide: 'monitor-up' },
    bell: { lucide: 'bell' },

    // --- áudio / mídia ---
    volume: { lucide: 'volume-2' },
    volume_mute: { lucide: 'volume-x' },
    vol_up: { lucide: 'plus' },
    vol_down: { lucide: 'minus' },
    play: { lucide: 'play' },
    pause: { lucide: 'pause' },
    next: { lucide: 'skip-forward' },
    prev: { lucide: 'skip-back' },
    shuffle: { lucide: 'shuffle' },
    repeat: { lucide: 'repeat' },
    repeat_one: { lucide: 'repeat-1' },
    music: { lucide: 'music' },
    seek_fwd: { lucide: 'fast-forward' },
    seek_back: { lucide: 'rewind' },
    playlist: { lucide: 'list-music' },
    fan: { lucide: 'fan' },
    claude: { simple: 'anthropic', fill: '#D97757' },
    openai: { simple: 'openai', fill: '#E6E8EF' },
    data: { lucide: 'circle-dot-dashed' },

    // --- OBS ---
    studio: { lucide: 'layout-panel-left' },
    screenshot: { lucide: 'camera' },

    // --- sistema / navegação ---
    home: { lucide: 'house' },
    grid: { lucide: 'layout-grid' },
    lock: { lucide: 'lock' },
    calc: { lucide: 'calculator' },
    terminal: { lucide: 'terminal' },
    browser: { lucide: 'globe' },
    game: { lucide: 'gamepad-2' },
    focus: { lucide: 'app-window' },
    open: { lucide: 'external-link' },
    auto: { lucide: 'refresh-cw' },
    settings: { lucide: 'settings' },
    stats: { lucide: 'activity' },

    // --- marcas ---
    obs: { simple: 'obsstudio', fill: '#E6E8EF' },
    meet: { simple: 'googlemeet', fill: '#00AC47' },
    spotify: { simple: 'spotify', fill: '#1DB954' },
    brave: { simple: 'brave', fill: '#FB542B' },
    chrome: { simple: 'googlechrome', fill: '#4285F4' },
    firefox: { simple: 'firefox', fill: '#FF7139' }
};

function fetch(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                return resolve(fetch(next, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} em ${url}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`${cmd} ${args.join(' ')}\n${stderr || err.message}`));
            resolve(stdout);
        });
    });
}

function prepareSvg(key, spec, svg) {
    if (spec.lucide) {
        return svg
            .replace(/stroke="currentColor"/g, `stroke="${STROKE_COLOR}"`)
            .replace(/stroke-width="2"/g, `stroke-width="${STROKE_WIDTH}"`);
    }
    // Simple Icons: path único preenchido, ocupa os 24x24 inteiros.
    // Injeta a cor da marca e um respiro na viewBox para alinhar visualmente com os Lucide.
    return svg
        .replace(/<svg\b/, `<svg fill="${spec.fill}"`)
        .replace(/viewBox="0 0 24 24"/, 'viewBox="-2 -2 28 28"');
}

function sourceUrl(spec) {
    return spec.lucide
        ? `https://unpkg.com/lucide-static@${LUCIDE_VERSION}/icons/${spec.lucide}.svg`
        : `https://unpkg.com/simple-icons@${SIMPLE_ICONS_VERSION}/icons/${spec.simple}.svg`;
}

async function buildIcon(key, spec) {
    const url = sourceUrl(spec);
    const raw = await fetch(url);
    const svg = prepareSvg(key, spec, raw);
    const svgPath = path.join(WORK_DIR, `${key}.svg`);
    const pngPath = path.join(WORK_DIR, `${key}.png`);
    fs.writeFileSync(svgPath, svg, 'utf8');

    // Cada ícone é monocromático: fixa o RGB na cor do ícone (só o alpha varia),
    // reduz o alpha a 32 níveis (~1-3 KB) e zera o resíduo < 3% para o fundo ficar 100% transparente.
    const color = spec.lucide ? STROKE_COLOR : spec.fill;
    await run('magick', [
        '-background', 'none',
        '-density', String(SIZE * 4),
        svgPath,
        '-resize', `${SIZE}x${SIZE}`,
        '-gravity', 'center',
        '-extent', `${SIZE}x${SIZE}`,
        '-channel', 'RGB', '-fill', color, '-colorize', '100', '+channel',
        '-colors', String(ALPHA_LEVELS),
        '(', '+clone', '-alpha', 'extract', '-black-threshold', '3%', ')',
        '-compose', 'CopyOpacity', '-composite',
        '-depth', '8',
        '-strip',
        '-define', 'png:compression-level=9',
        '-define', 'png:exclude-chunk=all',
        `PNG:${pngPath}`
    ]);

    const png = fs.readFileSync(pngPath);
    if (png.length < 100 || png.readUInt32BE(0) !== 0x89504e47) {
        throw new Error(`PNG inválido para "${key}"`);
    }
    return { key, size: png.length, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
}

function writeLicense() {
    const lucide = Object.entries(ICONS).filter(([, s]) => s.lucide).map(([k, s]) => `- \`${k}\` ← \`${s.lucide}\``);
    const simple = Object.entries(ICONS).filter(([, s]) => s.simple).map(([k, s]) => `- \`${k}\` ← \`${s.simple}\` (${s.fill})`);
    const md = `# Licenças dos ícones (src/icons.json)

Arquivo gerado por \`scripts/build-icons.js\`. Os PNGs em \`icons.json\` são rasterizações
(${SIZE}x${SIZE}, fundo transparente) dos SVGs abaixo.

## Lucide — licença ISC

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee
is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE
INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE
FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING
OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Fonte: https://lucide.dev — pacote \`lucide-static@${LUCIDE_VERSION}\`. Traço recolorido para ${STROKE_COLOR}, espessura ${STROKE_WIDTH}.

${lucide.join('\n')}

## Simple Icons — CC0 1.0 Universal

Os glifos de marca vêm do projeto Simple Icons (https://simpleicons.org, pacote \`simple-icons@${SIMPLE_ICONS_VERSION}\`),
publicados sob CC0 1.0. As marcas e logotipos pertencem aos seus respectivos donos; o uso aqui é apenas
para identificar o aplicativo controlado pela tecla.

${simple.join('\n')}
`;
    fs.writeFileSync(OUT_LICENSE, md, 'utf8');
}

async function main() {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const keys = Object.keys(ICONS);
    const out = {};
    const failures = [];

    // em paralelo, com limite para não estourar o unpkg
    const CONCURRENCY = 6;
    let cursor = 0;
    async function worker() {
        while (cursor < keys.length) {
            const key = keys[cursor++];
            try {
                const r = await buildIcon(key, ICONS[key]);
                out[key] = r.dataUrl;
                console.log(`ok   ${key.padEnd(14)} ${String(r.size).padStart(5)} B`);
            } catch (e) {
                failures.push(key);
                console.error(`FAIL ${key}: ${e.message}`);
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (failures.length) {
        console.error(`\n${failures.length} ícone(s) falharam: ${failures.join(', ')}. icons.json NÃO foi gravado.`);
        process.exit(1);
    }

    // mantém a ordem declarada em ICONS
    const ordered = {};
    for (const k of keys) ordered[k] = out[k];
    fs.writeFileSync(OUT_JSON, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
    writeLicense();

    const total = fs.statSync(OUT_JSON).size;
    console.log(`\n${keys.length} ícones gravados em ${path.relative(process.cwd(), OUT_JSON)} (${(total / 1024).toFixed(1)} KB)`);
    console.log(`Atribuição em ${path.relative(process.cwd(), OUT_LICENSE)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
