/**
 * Задание 0099 — тесты tools/check-delivery.mjs.
 *
 * Команда отвечает на вопрос «дошло ли письмо N» одной строкой и кодом выхода.
 * Проверка идёт на временных журналах: настоящий журнал (~/.dsh) не читается и не
 * пишется, в репозиторий ничего не попадает.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOOL = path.join(REPO, 'tools', 'check-delivery.mjs');

let passed = 0;
const failures = [];

function test(name, body) {
  try {
    body();
    passed += 1;
    console.log('ok ' + passed + ' — ' + name);
  } catch (error) {
    failures.push({ name, error });
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Журнал из строк: объект пишется как JSON, строка — как есть (для порванных строк). */
function journalOf(rows) {
  const file = path.join(tempDir('pg-cli-journal-'), 'exchange-decisions.jsonl');
  fs.writeFileSync(file, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n');
  return file;
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return { code: result.status === null ? 1 : result.status, stdout, stderr, out: stdout + stderr };
}

const DELIVERED = {
  at: '2026-11-05T10:48:50+03:00',
  box: 'C:/b',
  letter: 'threads/critic-report/a.md',
  to: 'workflow',
  branch: 'delivered',
  sha256: 'a'.repeat(64),
  session: 's-42',
};
const SILENT = {
  at: '2026-11-05T11:00:00+03:00',
  box: 'C:/b',
  letter: 'threads/critic-report/b.md',
  to: 'structure',
  branch: 'skip:no-wake',
  status: 'answer',
};

test('доставленное письмо: «доставлено», адресат, сессия и код 0', () => {
  const journal = journalOf([DELIVERED, SILENT]);
  const result = run(['--journal', journal, '--letter', 'a.md']);
  assert.equal(result.code, 0, 'найденная запись — код 0: ' + result.out);
  assert.match(result.stdout, /доставлено 2026-11-05T10:48:50\+03:00/u, 'время вручения в ответе');
  assert.match(result.stdout, /адресат workflow/u, 'адресат в ответе');
  assert.match(result.stdout, /сессия s-42/u, 'сессия вручения в ответе');
  assert.doesNotMatch(result.stderr, /check-delivery:/u, 'ошибок нет');
});

test('rescan:delivered тоже считается доставкой', () => {
  const rescan = { ...DELIVERED, branch: 'rescan:delivered', session: 's-old', deliveredAt: '2026-11-04T09:00:00+03:00' };
  const result = run(['--journal', journalOf([DELIVERED, rescan]), '--letter', 'a.md']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.stdout, /доставлено/u);
  assert.match(result.stdout, /сессия s-old/u);
});

test('не доставленное письмо: ветка-причина и адресат', () => {
  const result = run(['--journal', journalOf([DELIVERED, SILENT]), '--letter', 'b.md']);
  assert.equal(result.code, 0, result.out);
  assert.equal(result.stdout.trim(), 'не доставлено: skip:no-wake · structure', result.stdout);
});

test('письма нет в журнале: «нет записей» и код 1', () => {
  const result = run(['--journal', journalOf([DELIVERED]), '--letter', 'нет-такого-письма.md']);
  assert.equal(result.code, 1, result.out);
  assert.equal(result.stdout.trim(), 'нет записей по «нет-такого-письма.md»', result.stdout);
});

test('последняя запись побеждает: доставлено, потом stale — ответ «не доставлено»', () => {
  const stale = { ...DELIVERED, branch: 'stale:backlog' };
  delete stale.sha256;
  delete stale.session;
  const result = run(['--journal', journalOf([DELIVERED, stale]), '--letter', 'a.md']);
  assert.equal(result.code, 0, result.out);
  assert.equal(result.stdout.trim(), 'не доставлено: stale:backlog · workflow', result.stdout);
});

test('порванная строка журнала не прячет целые записи', () => {
  const result = run(['--journal', journalOf([DELIVERED, '{"at": "2026-11-05T1']), '--letter', 'a.md']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.stdout, /доставлено/u);
  const broken = run(['--journal', journalOf(['не json вовсе']), '--letter', 'a.md']);
  assert.equal(broken.code, 1, 'из порванных строк записей не выдумывается: ' + broken.out);
});

test('фильтр --letter — подстрока без учёта регистра', () => {
  const result = run(['--journal', journalOf([DELIVERED]), '--letter', 'A.MD']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.stdout, /доставлено/u);
});

test('--help печатает справку и выходит 0', () => {
  const result = run(['--help']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.stdout, /--root/u);
  assert.match(result.stdout, /--journal/u);
  assert.match(result.stdout, /--letter/u);
  assert.match(result.stdout, /Коды выхода/u);
});

test('ошибки аргументов — код 2', () => {
  for (const args of [[], ['--letter', 'a.md'], ['--unknown'], ['--journal'], ['--journal', ''], ['--letter', 'a.md', '--journal']]) {
    const result = run(args);
    assert.equal(result.code, 2, 'args ' + JSON.stringify(args) + ': ' + result.out);
    assert.match(result.stderr, /check-delivery:/u, 'причина отказа названа');
  }
});

test('--root несуществующего проекта — код 2', () => {
  const result = run(['--root', path.join(tempDir('pg-cli-root-'), 'нет-такого')]);
  assert.equal(result.code, 2, result.out);
  assert.match(result.stderr, /корень не найден/u);
});

test('--root берёт журнал из хранилища проекта ($PG_RUNS_DIR)', () => {
  const project = tempDir('pg-cli-project-');
  const runsDir = tempDir('pg-cli-runs-');
  fs.writeFileSync(path.join(runsDir, 'exchange-decisions.jsonl'), JSON.stringify(DELIVERED) + '\n');
  const result = run(['--root', project, '--letter', 'a.md'], { PG_RUNS_DIR: runsDir });
  assert.equal(result.code, 0, result.out);
  assert.match(result.stdout, /доставлено/u);
});

test('--root без журнала: записей нет, код 1', () => {
  const project = tempDir('pg-cli-project-empty-');
  const runsDir = tempDir('pg-cli-runs-empty-');
  const result = run(['--root', project, '--letter', 'a.md'], { PG_RUNS_DIR: runsDir });
  assert.equal(result.code, 1, result.out);
  assert.equal(result.stdout.trim(), 'нет записей по «a.md»', result.stdout);
});

test('несуществующий --journal — записей нет, код 1', () => {
  const result = run(['--journal', path.join(tempDir('pg-cli-missing-'), 'decisions.jsonl'), '--letter', 'a.md']);
  assert.equal(result.code, 1, result.out);
  assert.equal(result.stdout.trim(), 'нет записей по «a.md»', result.stdout);
});

test('форма --journal=<файл> работает как отдельный аргумент', () => {
  const journal = journalOf([DELIVERED]);
  const result = run(['--journal=' + journal, '--letter=a.md']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.stdout, /сессия s-42/u);
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(String(failure.error && failure.error.stack ? failure.error.stack : failure.error));
  }
  console.error('CHECK-DELIVERY TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('CHECK-DELIVERY TEST OK: ' + passed + '/' + passed);
