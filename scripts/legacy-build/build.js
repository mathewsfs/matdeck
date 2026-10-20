#!/usr/bin/env node
// Gera server/web/app.legacy.js: prelúdio (polyfills + shim de toque) + regenerator-runtime +
// app.js transpilado para ES5 (Safari 9 / iOS 9, o máximo do iPad 2). O index.html escolhe entre
// app.js e app.legacy.js com um teste de sintaxe; navegadores atuais nunca carregam este arquivo.
'use strict';
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const root = path.resolve(__dirname, '..', '..');
const webDir = path.join(root, 'server', 'web');
const src = path.join(webDir, 'app.js');
const out = path.join(webDir, 'app.legacy.js');

const source = fs.readFileSync(src, 'utf8');
const { code } = babel.transformSync(source, {
    filename: 'app.js',
    babelrc: false,
    configFile: false,
    compact: false,
    comments: false,
    sourceType: 'script',
    presets: [['@babel/preset-env', { targets: { safari: '9', ios: '9', ie: '11' }, modules: false, useBuiltIns: false }]]
});

const prelude = fs.readFileSync(path.join(__dirname, 'prelude.js'), 'utf8');
const regenerator = fs.readFileSync(require.resolve('regenerator-runtime/runtime.js'), 'utf8');
const header = `/* GERADO por scripts/legacy-build/build.js a partir de app.js — não edite à mão.\n * ES5 para Safari 9 / iOS 9 (iPad 2). Regenerar: cd scripts/legacy-build && npm run build */\n`;
const bundle = `${header}${prelude}\n${regenerator}\n${code}\n`;

// Sanidade: a AST não pode ter nada além de ES5 (ver es5check.js) e o arquivo precisa compilar
const problems = require('./es5check').check(bundle);
if (problems.length) throw new Error('app.legacy.js ainda tem sintaxe que o Safari 9 rejeita:\n  ' + problems.join('\n  '));
new Function(bundle); // eslint-disable-line no-new-func
fs.writeFileSync(out, bundle);
console.log(`[legacy-build] ${path.relative(root, out)} gerado (${(bundle.length / 1024).toFixed(0)} KB, app.js ${(source.length / 1024).toFixed(0)} KB)`);
