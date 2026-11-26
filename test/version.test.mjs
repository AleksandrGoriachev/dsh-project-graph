import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PLUGIN_VERSION } from '../lib/api.js';

/*
 * Одна правда о версии пакета (задание 0095): панель показывала 0.2.0, потому
 * что lib/api.js объявлял константу, а package.json уже был 1.0.2. Теперь версия
 * читается из package.json при загрузке модуля; этот набор держит их вместе,
 * чтобы релиз не оставлял панель позади.
 */
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

test('PLUGIN_VERSION совпадает с package.json.version', () => {
  assert.equal(PLUGIN_VERSION, pkg.version);
});

test('PLUGIN_VERSION — строка вида X.Y.Z', () => {
  assert.equal(typeof PLUGIN_VERSION, 'string');
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/u);
});

test('PLUGIN_VERSION без префикса v и собственных суффиксов', () => {
  assert.ok(!PLUGIN_VERSION.startsWith('v'), 'версия не должна начинаться с v');
  assert.equal(PLUGIN_VERSION, String(pkg.version).trim(), 'значение — ровно то, что в package.json');
});

test('версия не откатилась к запасной', () => {
  assert.notEqual(PLUGIN_VERSION, '0.0.0', 'package.json читается — запасная версия означала бы сбой чтения');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('VERSION TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
