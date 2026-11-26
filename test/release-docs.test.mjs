import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Задание 0367: выпуск не должен расходиться с документацией.
 *
 * Версия живёт в одном месте — package.json.version. Читатель ищет «что
 * ставить» в README.md и docs/INSTALL-STORE.md, а состав выпуска — в
 * docs/RELEASES.md. В 1.0.89 эти три места молчали: единственным носителем
 * версии был package.json, и о составе релиза заказчик узнавал из чата.
 *
 * Тест держит их вместе: поднял версию и не обновил документацию — прогон
 * красный. Сеть не используется, читаются только файлы с диска.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILES = {
  readme: 'README.md',
  install: 'docs/INSTALL-STORE.md',
  releases: 'docs/RELEASES.md',
};

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/*
 * Упоминание версии — именно эта версия, а не её префикс: «1.0.9» внутри
 * «1.0.90» и «11.0.90» внутри «1.0.90» упоминанием не считаются.
 */
function mentionPattern(version) {
  return new RegExp('(^|[^\\d.])' + escapeRe(version) + '(?![\\d])', 'u');
}

function mentions(text, version) {
  return mentionPattern(version).test(text);
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function sectionLines(text, heading) {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index])) break;
    body.push(lines[index]);
  }
  return body;
}

/* Раздел выпуска — заголовок «## X.Y.Z» (допустим хвост после номера). */
function releaseHeading(line) {
  const match = /^##\s+(\d+\.\d+\.\d+)(?=$|[\s—–-])/u.exec(line);
  return match ? match[1] : null;
}

/* Разделы docs/RELEASES.md по версиям, в порядке файла. */
function releaseSections(text) {
  const sections = new Map();
  const order = [];
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    if (/^#{1,2}\s+/u.test(line)) {
      const version = releaseHeading(line);
      current = version ? [] : null;
      if (version) {
        sections.set(version, current);
        order.push(version);
      }
      continue;
    }
    if (current) current.push(line);
  }
  return { sections, order };
}

function changeItems(lines) {
  return lines.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/u.test(line));
}

/*
 * Одна проверка на все три обещания выпуска: версия названа там, где читатель
 * ищет «что ставить», и у неё есть непустой перечень изменений.
 */
function problemsFor({ version, readme, install, releases }) {
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/u.test(String(version))) {
    problems.push('версия в package.json не вида X.Y.Z: ' + version);
  }
  const installSection = sectionLines(readme, /^##\s+Установка\s*$/u);
  if (installSection === null) {
    problems.push('в README.md нет раздела «## Установка», где читатель ищет что ставить');
  } else if (!mentions(installSection.join('\n'), version)) {
    problems.push('раздел «Установка» в README.md не называет версию ' + version);
  }
  if (!mentions(install, version)) {
    problems.push('docs/INSTALL-STORE.md не называет версию ' + version);
  }
  const { sections } = releaseSections(releases);
  const changes = sections.get(version);
  if (!changes) {
    problems.push('docs/RELEASES.md не содержит раздел «## ' + version + '»');
  } else if (changeItems(changes).length === 0) {
    problems.push('раздел «## ' + version + '» в docs/RELEASES.md пуст: нет ни одного пункта изменений');
  }
  return problems;
}

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

const pkg = JSON.parse(read('package.json'));
const readme = read(FILES.readme);
const install = read(FILES.install);
const releases = read(FILES.releases);
const version = String(pkg.version).trim();

test('версия из package.json читается и вида X.Y.Z', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.notEqual(version, '0.0.0');
});

test('README.md называет версию в разделе «Установка»', () => {
  const section = sectionLines(readme, /^##\s+Установка\s*$/u);
  assert.ok(section !== null, 'в README.md нет раздела «## Установка»');
  assert.ok(mentions(section.join('\n'), version), 'README.md не называет версию ' + version);
});

test('docs/INSTALL-STORE.md называет версию', () => {
  assert.ok(mentions(install, version), 'docs/INSTALL-STORE.md не называет версию ' + version);
});

test('docs/RELEASES.md: раздел версии с непустым перечнем изменений', () => {
  const { sections } = releaseSections(releases);
  const changes = sections.get(version);
  assert.ok(changes, 'docs/RELEASES.md не содержит раздел «## ' + version + '»');
  assert.ok(changeItems(changes).length > 0, 'раздел «## ' + version + '» пуст');
});

test('версия и документация сходятся', () => {
  assert.deepEqual(problemsFor({ version, readme, install, releases }), []);
});

test('разделы docs/RELEASES.md идут от новых к старым', () => {
  const { order } = releaseSections(releases);
  assert.ok(order.length > 0, 'в docs/RELEASES.md нет ни одного раздела версии');
  assert.equal(new Set(order).size, order.length, 'версия повторена: ' + order.join(', '));
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(compareVersions(order[index - 1], order[index]) > 0,
      'порядок нарушен: ' + order[index - 1] + ' стоит выше ' + order[index]);
  }
  assert.equal(order[0], version, 'самый новый раздел — не текущая версия');
});

/*
 * Отрицательные проверки: тест обязан падать, если версия поднята, а
 * документация осталась прежней, — иначе он держит только сегодняшний день.
 */
test('версия поднята, документация старая — проверка красная', () => {
  const problems = problemsFor({ version: '9.9.9', readme, install, releases });
  assert.equal(problems.length, 3, 'ожидались три расхождения, получено: ' + problems.join('; '));
  assert.match(problems.join('\n'), /README/u);
  assert.match(problems.join('\n'), /INSTALL-STORE/u);
  assert.match(problems.join('\n'), /RELEASES\.md/u);
});

test('раздел версии есть, перечень пуст — проверка красная', () => {
  const stale = '# Выпуски\n\n## ' + version + '\n\nТолько заголовок, изменений нет.\n';
  const problems = problemsFor({ version, readme, install, releases: stale });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /пуст/u);
});

test('упоминание соседней версии не засчитывается текущей', () => {
  assert.ok(!mentions('ставим ' + version + '0 и 1' + version, version));
  assert.ok(mentions('ставим ' + version + '.', version));
  assert.ok(mentions('версия: v' + version, version));
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('RELEASE-DOCS TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
