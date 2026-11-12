// Parses JavaScript and TypeScript files for the code knowledge graph, without running them.
// Input on stdin: {"root": "/abs/repo", "frontend": "/abs/frontend", "files": ["src/a.ts", ...]}.
// Output on stdout: {"path": {symbols, imports, calls} or {error}} for every file.
// The parser is oxc, through rolldown's parseAst, which the frontend already installs for Vite.
'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const { parseAst } = createRequire(path.join(input.frontend, 'package.json'))('rolldown/parseAst');

const LANG = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js' };

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The name a call is made to: foo() -> foo, a.b.foo() -> foo, with the receiver for this.foo(). */
function calleeOf(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return { name: node.name, receiver: null };
  if (node.type === 'MemberExpression' && !node.computed && node.property && node.property.type === 'Identifier') {
    const obj = node.object;
    const receiver = obj && obj.type === 'ThisExpression' ? 'this' : obj && obj.type === 'Identifier' ? obj.name : null;
    return { name: node.property.name, receiver };
  }
  if (node.type === 'ChainExpression') return calleeOf(node.expression);
  return null;
}

function jsxName(node) {
  if (!node) return null;
  if (node.type === 'JSXIdentifier') return /^[A-Z]/.test(node.name) ? node.name : null;
  if (node.type === 'JSXMemberExpression') return node.property && node.property.name;
  return null;
}

function heritage(expr) {
  if (!expr) return null;
  if (expr.type === 'Identifier') return expr.name;
  if (expr.type === 'MemberExpression' && expr.property) return expr.property.name;
  if (expr.type === 'TSExpressionWithTypeArguments' || expr.type === 'TSInterfaceHeritage') return heritage(expr.expression);
  return null;
}

function analyse(file, text) {
  const ext = path.extname(file).toLowerCase();
  const ast = parseAst(text, { lang: LANG[ext] || 'js' });
  const starts = lineStarts(text);
  const symbols = [];
  const imports = [];
  const calls = [];

  const addImport = (source, names, line) => {
    if (typeof source === 'string') imports.push({ source, names, line });
  };

  // owner: the qualified name of the function or method the code sits in; null at the top of the file.
  function walk(node, owner, className) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, owner, className);
      return;
    }
    switch (node.type) {
      case 'ImportDeclaration':
        addImport(
          node.source && node.source.value,
          (node.specifiers || []).map((s) => (s.imported && s.imported.name) || (s.local && s.local.name)).filter(Boolean),
          lineOf(starts, node.start),
        );
        return;
      case 'ExportAllDeclaration':
        addImport(node.source && node.source.value, ['*'], lineOf(starts, node.start));
        return;
      case 'ExportNamedDeclaration':
        if (node.source) addImport(node.source.value, (node.specifiers || []).map((s) => s.local && s.local.name), lineOf(starts, node.start));
        break;
      case 'ImportExpression':
        if (node.source && node.source.type === 'Literal') addImport(node.source.value, ['*'], lineOf(starts, node.start));
        break;
      case 'CallExpression':
      case 'NewExpression': {
        if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const arg = node.arguments && node.arguments[0];
          if (arg && arg.type === 'Literal') addImport(arg.value, ['*'], lineOf(starts, node.start));
        }
        const c = calleeOf(node.callee);
        if (c) calls.push({ caller: owner, name: c.name, receiver: c.receiver, cls: className, line: lineOf(starts, node.start) });
        break;
      }
      case 'JSXOpeningElement': {
        const n = jsxName(node.name);
        if (n) calls.push({ caller: owner, name: n, receiver: null, cls: className, line: lineOf(starts, node.start) });
        break;
      }
      case 'FunctionDeclaration':
        if (node.id && !owner) {
          const q = node.id.name;
          symbols.push({ kind: 'function', name: q, qual: q, start: lineOf(starts, node.start), end: lineOf(starts, node.end) });
          walk(node.body, q, className);
          return;
        }
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id && !owner) {
          const cls = node.id.name;
          const bases = [heritage(node.superClass), ...(node.implements || []).map(heritage)].filter(Boolean);
          symbols.push({ kind: 'class', name: cls, qual: cls, bases, start: lineOf(starts, node.start), end: lineOf(starts, node.end) });
          for (const member of (node.body && node.body.body) || []) {
            const key = member.key && (member.key.name || member.key.value);
            const isMethod =
              member.type === 'MethodDefinition' ||
              (member.type === 'PropertyDefinition' && member.value && /Function/.test(member.value.type));
            if (key && isMethod) {
              const q = `${cls}.${key}`;
              symbols.push({ kind: 'method', name: String(key), qual: q, parent: cls, start: lineOf(starts, member.start), end: lineOf(starts, member.end) });
              walk(member.value, q, cls);
            } else walk(member, cls, cls);
          }
          return;
        }
        break;
      case 'TSInterfaceDeclaration':
        if (node.id) {
          const bases = (node.extends || []).map(heritage).filter(Boolean);
          symbols.push({ kind: 'interface', name: node.id.name, qual: node.id.name, bases, start: lineOf(starts, node.start), end: lineOf(starts, node.end) });
        }
        return;
      case 'VariableDeclarator':
        if (!owner && node.id && node.id.type === 'Identifier' && node.init) {
          let init = node.init;
          // const Page = lazy(...) or forwardRef(function ...) : the wrapped function is still the symbol's body.
          if (init.type === 'CallExpression' && init.arguments && init.arguments.some((a) => /Function/.test(a.type))) {
            const q = node.id.name;
            symbols.push({ kind: 'function', name: q, qual: q, start: lineOf(starts, node.start), end: lineOf(starts, node.end) });
            walk(init, q, className);
            return;
          }
          if (/Function/.test(init.type)) {
            const q = node.id.name;
            symbols.push({ kind: 'function', name: q, qual: q, start: lineOf(starts, node.start), end: lineOf(starts, node.end) });
            walk(init.body, q, className);
            return;
          }
        }
        break;
      default:
        break;
    }
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue;
      const v = node[key];
      if (v && typeof v === 'object') walk(v, owner, className);
    }
  }

  walk(ast.body, null, null);
  return { symbols, imports, calls, lines: starts.length };
}

const out = {};
for (const file of input.files) {
  try {
    const text = fs.readFileSync(path.join(input.root, file), 'utf8');
    out[file] = analyse(file, text);
  } catch (err) {
    out[file] = { error: String((err && err.message) || err).slice(0, 300) };
  }
}
process.stdout.write(JSON.stringify(out));
