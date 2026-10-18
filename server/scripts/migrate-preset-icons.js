#!/usr/bin/env node
/**
 * Troca, em data/presets.json, os data URLs de ícones de uma versão antiga do icons.json
 * pelos equivalentes da versão atual (mesma chave). Teclas com ícone desconhecido ficam como estão.
 *
 * Uso: node scripts/migrate-preset-icons.js <icons.json antigo> [presets.json] [--dry-run]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
const oldIconsPath = args[0];
const presetsPath = args[1] || path.resolve(__dirname, '../data/presets.json');

if (!oldIconsPath) {
    console.error('Uso: node scripts/migrate-preset-icons.js <icons.json antigo> [presets.json] [--dry-run]');
    process.exit(1);
}

const oldIcons = JSON.parse(fs.readFileSync(oldIconsPath, 'utf8'));
const newIcons = require('../src/icons.json');
const presets = JSON.parse(fs.readFileSync(presetsPath, 'utf8'));

const keyByOldUrl = new Map(Object.entries(oldIcons).map(([k, v]) => [v, k]));
let changed = 0;
let unknown = 0;

for (const [presetId, preset] of Object.entries(presets)) {
    for (const key of preset.keys || []) {
        if (!key || !key.icon) continue;
        const name = keyByOldUrl.get(key.icon);
        if (!name) {
            if (!Object.values(newIcons).includes(key.icon)) unknown++;
            continue;
        }
        if (!newIcons[name]) {
            console.warn(`[${presetId}#${key.index}] chave "${name}" não existe mais no icons.json atual; mantida`);
            unknown++;
            continue;
        }
        key.icon = newIcons[name];
        changed++;
        console.log(`[${presetId}#${key.index}] ${key.title || '(sem título)'} -> ${name}`);
    }
}

console.log(`\n${changed} tecla(s) migrada(s), ${unknown} com ícone desconhecido (mantidas).`);
if (dryRun) {
    console.log('--dry-run: nada foi gravado.');
} else if (changed) {
    const backup = `${presetsPath}.bak-${Date.now()}`;
    fs.copyFileSync(presetsPath, backup);
    fs.writeFileSync(presetsPath, JSON.stringify(presets, null, 2), 'utf8');
    console.log(`Gravado em ${presetsPath} (backup em ${backup}).`);
}
