import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Задание 0371: доктор релиза.
 *
 * Проверяется поведение tools/release-doctor.mjs на временных каталогах:
 * классы «допустимо / запрещено / предупреждение», коды 0/1/2, --json,
 * отказ при закреплённой версии в тесте и отсутствие ложных срабатываний
 * на соседние версии. Ни один тест не читает реальные файлы проекта, кроме
 * самого инструмента: временные каталоги создаются под os.tmpdir().
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = path.join(ROOT, 'tools', 'release-doctor.mjs');

/*
 * Соседние версии собираются из частей, чтобы этот файл сам не закреплял
 * текущую версию проекта литералом: 1.0.9 — префикс, текущая — префикс плюс
 * «0», ещё две — удлинение и лишняя цифра спереди.
 */
const V_PREV = '1.0.9';
const V_CURRENT = V_PREV + '0';
const V_EXTENDED = V_CURRENT + '0';
const V_PREFIXED = '1' + V_CURRENT;

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function project(options, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-doctor-'));
  const version = Object.prototype.hasOwnProperty.call(options, 'version') ? options.version : V_CURRENT;
  try {
    const pkg = { name: 'release-doctor-fixture', private: true };
    if (version !== null && version !== undefined) pkg.version = version;
    write(root, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
    if (options.docs !== false && typeof version === 'string') {
      write(root, 'README.md', '# Фикстура\n\nТекущий выпуск — ' + version + '.\n');
    }
    for (const [relative, content] of Object.entries(options.files || {})) {
      write(root, relative, content);
    }
    body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function doctor(args, options = {}) {
  const result = spawnSync(process.execPath, [DOCTOR, ...args], { cwd: options.cwd, encoding: 'utf8' });
  return { code: result.status, out: result.stdout || '', err: result.stderr || '' };
}

test('чистый проект без закрепления: --check → 0', () => {
  project({ files: { 'lib/index.js': 'export const ok = true;\n' } }, (root) => {
    const result = doctor(['--check'], { cwd: root });
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /ИТОГ: проверка пройдена/u);
    assert.ok(result.out.includes(V_CURRENT), 'отчёт называет текущую версию');
  });
});

test('манифест и документация — допустимо, код 0', () => {
  project({ files: { 'docs/RELEASES.md': '# Выпуски\n\n## ' + V_CURRENT + '\n\n- изменение\n' } }, (root) => {
    const result = doctor(['--json', '--check', '--root', root]);
    assert.equal(result.code, 0, result.out + result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.ok, true);
    assert.equal(report.version, V_CURRENT);
    assert.ok(report.findings.every((finding) => finding.class === 'allowed'), 'в чистом проекте только допустимые находки');
    assert.ok(report.findings.some((finding) => finding.file === 'package.json'), 'манифест назван');
    assert.ok(report.findings.some((finding) => finding.file === 'README.md'), 'README назван');
    assert.ok(report.findings.some((finding) => finding.file === 'docs/RELEASES.md'), 'RELEASES назван');
  });
});

test('закреплённая версия в тесте — запрещено, код 1', () => {
  project({ files: { 'test/pin.test.mjs': "const EXPECTED_VERSION = '" + V_CURRENT + "';\n" } }, (root) => {
    const result = doctor(['--check', '--root', root]);
    assert.equal(result.code, 1, result.out + result.err);
    assert.match(result.out, /ФАЙЛ \| СТРОКА \| КЛАСС \| ЧТО ДЕЛАТЬ/u);
    assert.match(result.out, /test\/pin\.test\.mjs/u);
    assert.match(result.out, /запрещено/u);
    assert.match(result.out, /ИТОГ: есть запрещённые места или расхождения/u);
  });
});

test('устаревшая закреплённая константа — расхождение, код 1', () => {
  project({ files: { 'test/pin.test.mjs': "const EXPECTED_VERSION = '" + V_PREV + "';\n" } }, (root) => {
    const result = doctor(['--json', '--check', '--root', root]);
    assert.equal(result.code, 1, result.out + result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.ok, false);
    assert.equal(report.summary.forbidden, 1);
    const finding = report.findings.find((item) => item.class === 'forbidden');
    assert.ok(finding, 'находка «запрещено» есть');
    assert.equal(finding.pinned, V_PREV);
    assert.match(finding.action, new RegExp(V_CURRENT.replace(/\./gu, '\\.'), 'u'), 'действие называет текущую версию');
  });
});

test('--json отдаёт классы, сводку и решение', () => {
  project({
    files: {
      'test/pin.test.mjs': "const EXPECTED_VERSION = '" + V_CURRENT + "';\n",
      'tools/script.mjs': "const RELEASE = '" + V_CURRENT + "';\n",
    },
  }, (root) => {
    const result = doctor(['--json', '--check', '--root', root]);
    assert.equal(result.code, 1, result.out + result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.version, V_CURRENT);
    assert.equal(report.ok, false);
    assert.equal(report.summary.forbidden, 1);
    assert.equal(report.summary.warning, 1);
    assert.ok(report.summary.allowed >= 2, 'манифест и README допустимы');
    const classes = new Set(report.findings.map((finding) => finding.class));
    assert.ok(classes.has('allowed') && classes.has('forbidden') && classes.has('warning'), 'все три класса');
    assert.ok(report.findings.some((finding) => finding.file === 'test/pin.test.mjs' && finding.class === 'forbidden'));
    assert.ok(report.findings.some((finding) => finding.file === 'tools/script.mjs' && finding.class === 'warning'));
  });
});

test('--json без --check только отчитывается: код 0', () => {
  project({ files: { 'test/pin.test.mjs': "const EXPECTED_VERSION = '" + V_CURRENT + "';\n" } }, (root) => {
    const result = doctor(['--json', '--root', root]);
    assert.equal(result.code, 0, result.out + result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.ok, false, 'решение в отчёте честное');
    assert.equal(report.summary.forbidden, 1);
  });
});

test('предупреждение не валит проверку', () => {
  project({ files: { 'tools/script.mjs': "const RELEASE = '" + V_CURRENT + "';\n" } }, (root) => {
    const result = doctor(['--check', '--root', root]);
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /предупреждение/u);
    assert.match(result.out, /ИТОГ: проверка пройдена/u);
  });
});

test('комментарий и фикстура в тесте не считаются закреплением', () => {
  project({
    files: {
      'test/fixture.test.mjs': "const fixture = { version: '" + V_CURRENT + "' };\n// текущая версия " + V_CURRENT + "\n",
    },
  }, (root) => {
    const result = doctor(['--json', '--check', '--root', root]);
    assert.equal(result.code, 0, result.out + result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.summary.forbidden, 0, 'фикстура и комментарий — не закрепление');
    assert.ok(report.findings.some((finding) => finding.file === 'test/fixture.test.mjs' && finding.class === 'warning'));
  });
});

test('неверные аргументы — код 2', () => {
  project({}, (root) => {
    assert.equal(doctor(['--bogus'], { cwd: root }).code, 2, 'неизвестный ключ');
    assert.equal(doctor(['--root'], { cwd: root }).code, 2, '--root без значения');
  });
  const missing = path.join(os.tmpdir(), 'release-doctor-missing-' + process.pid + '-' + Date.now());
  assert.equal(doctor(['--check', '--root', missing]).code, 2, 'нет каталога проекта');
});

test('соседние версии не считаются текущей (1.0.9, 11.0.90, 1.0.900)', () => {
  project({ files: { 'docs/NOTES.md': 'Соседи: ' + V_PREV + ', ' + V_PREFIXED + ', ' + V_EXTENDED + '.\n' } }, (root) => {
    const result = doctor(['--json', '--check', '--root', root]);
    assert.equal(result.code, 0, result.out + result.err);
    const report = JSON.parse(result.out);
    assert.ok(!report.findings.some((finding) => finding.file === 'docs/NOTES.md'), 'соседняя версия не засчитана текущей');
  });
});

test('короткая текущая версия не совпадает внутри длинной', () => {
  project({ version: V_PREV, files: { 'docs/NOTES.md': 'Будущая версия: ' + V_CURRENT + '.\n' } }, (root) => {
    const result = doctor(['--json', '--check', '--root', root]);
    assert.equal(result.code, 0, result.out + result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.version, V_PREV);
    assert.ok(!report.findings.some((finding) => finding.file === 'docs/NOTES.md'), 'длинная версия не засчитана текущей короткой');
  });
});

test('манифест без версии — код 1', () => {
  project({ version: null, docs: false }, (root) => {
    const result = doctor(['--check', '--root', root]);
    assert.equal(result.code, 1, result.out + result.err);
    assert.match(result.err, /верси/iu);
  });
});

test('документация не называет версию — расхождение, код 1', () => {
  project({ docs: false, files: { 'lib/index.js': 'export const ok = true;\n' } }, (root) => {
    const result = doctor(['--check', '--root', root]);
    assert.equal(result.code, 1, result.out + result.err);
    assert.match(result.out, /РАСХОЖДЕНИЕ/u);
    assert.match(result.out, /документация не называет/u);
  });
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('RELEASE-DOCTOR TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
