#!/usr/bin/env node
// Audit raw WebGL2 requirements in any self-contained webapp before selecting
// an ANGLE runtime backend. No network requests, no game-code modifications.
// Example: node tools/audit-webgl2-api.mjs E:/KuningriigidTest/.../game
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, extname, relative } from 'node:path';

const root = resolve(process.argv[2] || '.');
const sources = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (extname(entry.name).toLowerCase() === '.js' || extname(entry.name).toLowerCase() === '.mjs') {
      sources.push({ name: relative(root, file).replaceAll('\\', '/'), code: readFileSync(file, 'utf8') });
    }
  }
}
walk(root);

const methods = new Map(), enums = new Map(), shaders = [], contexts = [];
for (const { name, code } of sources) {
  const lines = code.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const m of line.matchAll(/\b(?:gl|GFX\.gl)\.([A-Za-z][A-Za-z0-9_]*)\s*\(/g)) {
      const entry = methods.get(m[1]) || { calls: 0, examples: [] };
      entry.calls++;
      if (entry.examples.length < 3) entry.examples.push(name + ':' + (index + 1));
      methods.set(m[1], entry);
    }
    for (const m of line.matchAll(/\b(?:gl|GFX\.gl)\.([A-Z][A-Z0-9_]{2,})\b/g)) {
      enums.set(m[1], (enums.get(m[1]) || 0) + 1);
    }
    if (line.includes('#version 300 es')) shaders.push(name + ':' + (index + 1));
    if (/getContext\s*\(\s*['"](?:webgl2|webgl)['"]/.test(line)) contexts.push(name + ':' + (index + 1));
  });
}
const sorted = (map) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
const report = {
  root, sourceFiles: sources.length,
  methodsFound: methods.size, callSites: [...methods.values()].reduce((n, x) => n + x.calls, 0),
  contexts, glslEs3Sources: shaders,
  methodReferences: sorted(methods), enumReferences: sorted(enums),
  caveat: 'Static scan only: property aliases, string-built names and false positives require manual verification',
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
