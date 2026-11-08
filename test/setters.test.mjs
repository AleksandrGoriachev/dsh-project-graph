import fs from 'node:fs';
const src = fs.readFileSync('lib/client.js', 'utf8');
const declared = new Set();
for (const m of src.matchAll(/const\s*\[\s*\w+\s*,\s*(set\w+)\s*\]/g)) declared.add(m[1]);
for (const m of src.matchAll(/function\s+(set\w+)\s*\(/g)) declared.add(m[1]);
const used = new Set();
/* this.setState — метод React, а не сеттер панели: его не считаем. */
for (const m of src.matchAll(/(?<![.\w])(set[A-Z]\w*)\s*\(/g)) used.add(m[1]);
const builtins = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const missing = [...used].filter((n) => !declared.has(n) && !builtins.has(n));
if (missing.length) { console.error('НЕ ОБЪЯВЛЕНЫ: ' + missing.join(', ')); process.exit(1); }
console.log('сеттеры: объявлены все (' + used.size + ')');
