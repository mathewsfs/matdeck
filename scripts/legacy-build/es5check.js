// Varre um JS e aponta nós da AST que o Safari 9 (iPad 2) rejeita: só ES5 passa, mais nada.
// Uso: require('./es5check').check(codigo) -> [] ou `node es5check.js arquivo.js`
'use strict';
const parser = require('@babel/parser');

function check(code) {
const ast = parser.parse(code, { sourceType: 'script', errorRecovery: false });
const BAD = new Set(['ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression', 'TemplateLiteral', 'TaggedTemplateExpression', 'ForOfStatement', 'SpreadElement', 'RestElement', 'ObjectPattern', 'ArrayPattern', 'AssignmentPattern', 'YieldExpression', 'AwaitExpression', 'MetaProperty', 'ImportDeclaration', 'ExportNamedDeclaration', 'OptionalMemberExpression', 'OptionalCallExpression']);
const hits = {};
function add(kind, node) { (hits[kind] = hits[kind] || []).push(node.loc.start.line); }
function walk(node, parent, inBlock) {
  if (!node || typeof node.type !== 'string') return;
  if (BAD.has(node.type)) add(node.type, node);
  if (node.type === 'VariableDeclaration' && node.kind !== 'var') add('let/const', node);
  if (node.type === 'FunctionDeclaration' && parent && parent.type !== 'Program' && parent.type !== 'BlockStatement') add('fn-decl-sem-bloco', node);
  if (node.type === 'FunctionDeclaration' && parent && parent.type === 'BlockStatement' && inBlock) add('fn-decl-em-bloco', node);
  if ((node.type === 'ObjectProperty' && (node.shorthand || node.computed)) || node.type === 'ObjectMethod') add('obj-' + (node.type === 'ObjectMethod' ? 'method' : node.computed ? 'computed' : 'shorthand'), node);
  if (node.type === 'RegExpLiteral' && /[uys]/.test(node.flags)) add('regex-flag-' + node.flags, node);
  if ((node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') && (node.generator || node.async)) add(node.async ? 'async-fn' : 'generator', node);
  if (node.type === 'LogicalExpression' && node.operator === '??') add('nullish', node);
  if (node.type === 'BinaryExpression' && node.operator === '**') add('exponent', node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    const v = node[k];
    const childInBlock = inBlock || (node.type === 'BlockStatement' && parent && !/Function|Program/.test(parent.type)) || node.type === 'SwitchCase';
    if (Array.isArray(v)) v.forEach(c => walk(c, node, childInBlock)); else if (v && typeof v.type === 'string') walk(v, node, childInBlock);
  }
}
walk(ast.program, null, false);
return Object.keys(hits).map(k => `${k}: ${hits[k].length}x, linhas ${hits[k].slice(0, 8).join(', ')}${hits[k].length > 8 ? '…' : ''}`);
}

module.exports = { check };

if (require.main === module) {
    const file = process.argv[2];
    const problems = check(require('fs').readFileSync(file, 'utf8'));
    if (!problems.length) { console.log('ES5 limpo:', file); process.exit(0); }
    problems.forEach(p => console.log(p));
    process.exit(1);
}
