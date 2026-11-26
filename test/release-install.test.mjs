import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_VERSION } from '../lib/api.js';

/*
 * Задание 0358: релиз держит вместе версию пакета, инструкцию перевода
 * проекта на store и раздел README про таймкипера.
 *
 * Задание 0371: ожидаемая версия больше не закреплена литералом — она берётся
 * из package.json, единственного источника истины, поэтому выпуск не требует
 * правки теста. Проверка от этого не слабеет: панель (PLUGIN_VERSION читается
 * из package.json) обязана совпадать с манифестом, а документация — называть
 * текущую версию; инструкция содержит выполнимые шаги (--check, --apply, режим
 * store, git ls-files, git reset --hard, .gitignore, путь store) и не ссылается
 * на несуществующие файлы; README ссылается на инструкцию и говорит про
 * таймкипера.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/*
 * Упоминание ровно этой версии, а не её префикса: «1.0.9» внутри более
 * длинной версии и версия с лишней цифрой упоминанием не считаются.
 */
function mentionsVersion(text, version) {
  return new RegExp('(^|[^\\d.])' + escapeRe(version) + '(?![\\d])', 'u').test(text);
}

const pkg = JSON.parse(read('package.json'));
const install = read('docs/INSTALL-STORE.md');
const readme = read('README.md');

test('версия пакета вида X.Y.Z и не нулевая', () => {
  assert.match(String(pkg.version), /^\d+\.\d+\.\d+$/u);
  assert.notEqual(pkg.version, '0.0.0');
});

test('PLUGIN_VERSION совпадает с package.json.version', () => {
  assert.equal(PLUGIN_VERSION, pkg.version);
});

test('документация называет текущую версию package.json', () => {
  assert.ok(mentionsVersion(install, pkg.version), 'docs/INSTALL-STORE.md не называет версию ' + pkg.version);
  assert.ok(mentionsVersion(readme, pkg.version), 'README.md не называет версию ' + pkg.version);
});

test('docs/INSTALL-STORE.md существует и содержательна', () => {
  assert.ok(exists('docs/INSTALL-STORE.md'), 'нет docs/INSTALL-STORE.md');
  assert.ok(install.trim().length > 1500, 'инструкция слишком короткая: ' + install.trim().length + ' символов');
});

/* Обязательные шаги и проверки инструкции: шаг без команды — не инструкция. */
const REQUIRED = [
  ['проверка режима --check', /--check/u],
  ['перенос --apply', /--apply/u],
  ['режим store в выводе', /режим:\s*store/u],
  ['исходный режим repo', /режим:\s*repo/u],
  ['store-граф в выводе', /store-граф/u],
  ['проверка git ls-files structure', /git ls-files structure/u],
  ['проверка git reset --hard', /git reset --hard/u],
  ['правило .gitignore', /\.gitignore/u],
  ['правило /structure/', /\/structure\//u],
  ['путь store ~/.dsh/project-graph/', /~\/\.dsh\/project-graph\//u],
  ['файл графа graph.json', /graph\.json/u],
  ['резервные копии backups/', /backups\//u],
  ['удаление через git rm', /git rm/u],
  ['переменная DSH_PROJECT_GRAPH_STORE', /DSH_PROJECT_GRAPH_STORE/u],
  ['порядок «сначала перенос, потом удаление»', /сначала перенос, потом удаление/u],
];
for (const [label, pattern] of REQUIRED) {
  test('инструкция содержит «' + label + '»', () => {
    assert.match(install, pattern);
  });
}

test('инструкция называет инструмент переноса и модуль store', () => {
  assert.ok(install.includes('tools/migrate-structure.mjs'), 'нет ссылки на инструмент переноса');
  assert.ok(install.includes('lib/store.js'), 'нет ссылки на модуль store');
});

test('пути файлов репозитория из инструкции существуют', () => {
  const references = [...install.matchAll(/`((?:tools|lib|test|docs)\/[\w./-]+\.(?:mjs|js|md|json))`/gu)]
    .map((match) => match[1]);
  assert.ok(references.length >= 2, 'в инструкции нет ссылок на файлы репозитория: ' + references.length);
  for (const relative of new Set(references)) {
    assert.ok(exists(relative), 'инструкция ссылается на несуществующий файл: ' + relative);
  }
});

test('README ссылается на docs/INSTALL-STORE.md', () => {
  assert.ok(readme.includes('docs/INSTALL-STORE.md'), 'README не называет docs/INSTALL-STORE.md');
  assert.match(readme, /\]\(docs\/INSTALL-STORE\.md\)/u, 'ссылка на инструкцию не оформлена как ссылка');
});

test('README упоминает таймкипера, монитор и leadMinutes', () => {
  assert.match(readme, /таймкипер/iu);
  assert.match(readme, /Монитор/u);
  assert.match(readme, /leadMinutes/u);
});

test('README: без монитора таймкипер молчит', () => {
  assert.match(readme, /монитор[^.]{0,120}молчит|молчит[^.]{0,120}монитор/isu,
    'README не говорит, что без монитора таймкипер молчит');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('RELEASE-INSTALL TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
