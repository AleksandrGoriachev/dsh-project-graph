/*
 * Задание 0376: отмена задания убирает свои артефакты.
 *
 * Временный репозиторий: docs/tasks/REGISTRY.json и каталоги трёх заданий —
 * отменяемого (0376, open), соседнего открытого (0378) и принятого (0377).
 * Проверяется, что отмена убирает только артефакты ворот своего задания,
 * оставляет task.md/criteria.json и незнакомые файлы, не задевает соседа,
 * --dry-run ничего не меняет, принятое не отменяется, несуществующее — код 2,
 * отсутствие реестра — код 1 с путём.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../tools/task-cancel.mjs', import.meta.url));

/* Полный набор артефактов ворот задания. */
const ARTIFACTS = [
  'criteria.lock',
  'gates.jsonl',
  'gates.jsonl.tip',
  'red.json',
  'red.log',
  'verify.json',
  'verify.executor.json',
  'verify.log',
  'review.json',
  'review.receipt.json',
  'acceptance.json',
  'audit-evidence.json',
  'report.md',
  'report.json',
];

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* Каталог задания: контракт, незнакомый файл и весь набор артефактов. */
function seedTask(repo, id) {
  const dir = path.join(repo, 'docs', 'tasks', id);
  write(path.join(dir, 'task.md'), '# Задание ' + id + '\n');
  write(path.join(dir, 'criteria.json'), JSON.stringify({ task: id, criteria: [] }, null, 2) + '\n');
  write(path.join(dir, 'notes.md'), 'заметки, которые отмена не трогает\n');
  for (const rel of ARTIFACTS) write(path.join(dir, rel), 'artifact ' + rel + '\n');
  return dir;
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cancel-test-'));
  write(path.join(repo, 'docs', 'tasks', 'REGISTRY.json'), JSON.stringify({
    version: 1,
    tasks: [
      { id: '0376', subject: 'отменяемое', status: 'open', at: '2026-11-27' },
      { id: '0377', subject: 'принятое', status: 'accepted', at: '2026-11-27' },
      { id: '0378', subject: 'соседнее', status: 'open', at: '2026-11-27' },
    ],
  }, null, 2) + '\n');
  for (const id of ['0376', '0377', '0378']) seedTask(repo, id);
  return repo;
}

function run(repo, args) {
  const result = spawnSync(process.execPath, [TOOL, ...args, '--repo', repo], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60000,
  });
  return {
    code: result.status,
    out: String(result.stdout || ''),
    err: String(result.stderr || ''),
    said: String(result.stdout || '') + String(result.stderr || ''),
  };
}

function statusOf(repo, id) {
  const doc = readJson(path.join(repo, 'docs', 'tasks', 'REGISTRY.json'));
  return (doc.tasks.find((entry) => String(entry.id) === id) || {}).status;
}

function assertArtifactsGone(dir) {
  for (const rel of ARTIFACTS) {
    assert.equal(fs.existsSync(path.join(dir, rel)), false, 'артефакт остался: ' + rel);
  }
}

function assertContractKept(dir) {
  assert.ok(fs.existsSync(path.join(dir, 'task.md')), 'task.md удалён');
  assert.ok(fs.existsSync(path.join(dir, 'criteria.json')), 'criteria.json удалён');
  assert.ok(fs.existsSync(path.join(dir, 'notes.md')), 'незнакомый файл удалён');
}

function withRepo(body) {
  const repo = makeRepo();
  try { body(repo); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

/* --- 1. --dry-run: план есть, изменений нет ------------------------------ */
test('dry-run печатает план и ничего не меняет', () => withRepo((repo) => {
  const dir = path.join(repo, 'docs', 'tasks', '0376');
  const before = fs.readFileSync(path.join(repo, 'docs', 'tasks', 'REGISTRY.json'), 'utf8');
  const result = run(repo, ['--id', '0376', '--dry-run']);
  assert.equal(result.code, 0, 'dry-run: exit ' + String(result.code) + ' — ' + result.said);
  assert.match(result.out, /dry-run/u, 'в выводе нет пометки dry-run');
  assert.match(result.out, /0376/u, 'в таблице нет номера задания');
  assert.match(result.out, /criteria\.lock/u, 'в плане нет criteria.lock');
  assert.match(result.out, /cancelled/u, 'в плане нет статуса cancelled');
  for (const rel of ARTIFACTS) {
    assert.ok(fs.existsSync(path.join(dir, rel)), 'dry-run удалил: ' + rel);
  }
  assert.equal(statusOf(repo, '0376'), 'open', 'dry-run изменил реестр');
  assert.equal(fs.readFileSync(path.join(repo, 'docs', 'tasks', 'REGISTRY.json'), 'utf8'), before,
    'dry-run переписал файл реестра');
}));

/* --- 2. Отмена: артефакты уходят, контракт остаётся --------------------- */
test('отмена удаляет артефакты своего задания и оставляет контракт', () => withRepo((repo) => {
  const dir = path.join(repo, 'docs', 'tasks', '0376');
  const result = run(repo, ['--id', '0376']);
  assert.equal(result.code, 0, 'отмена: exit ' + String(result.code) + ' — ' + result.said);
  assertArtifactsGone(dir);
  assertContractKept(dir);
  assert.match(result.out, /0376/u, 'в итоге нет номера задания');
  assert.match(result.out, /cancelled/u, 'в итоге нет статуса cancelled');
  assert.match(result.out, /criteria\.lock/u, 'в итоге нет перечня удалённых файлов');
}));

/* --- 3. Реестр помечен cancelled ---------------------------------------- */
test('отмена ставит в реестре статус cancelled', () => withRepo((repo) => {
  const result = run(repo, ['--id', '0376']);
  assert.equal(result.code, 0, 'отмена: exit ' + String(result.code) + ' — ' + result.said);
  assert.equal(statusOf(repo, '0376'), 'cancelled');
}));

/* --- 4. Соседнее задание не тронуто ------------------------------------- */
test('отмена не трогает артефакты и статус соседнего задания', () => withRepo((repo) => {
  const result = run(repo, ['--id', '0376']);
  assert.equal(result.code, 0, 'отмена: exit ' + String(result.code) + ' — ' + result.said);
  const neighbour = path.join(repo, 'docs', 'tasks', '0378');
  for (const rel of ARTIFACTS) {
    assert.ok(fs.existsSync(path.join(neighbour, rel)), 'сосед потерял: ' + rel);
  }
  assert.ok(fs.existsSync(path.join(neighbour, 'task.md')), 'сосед потерял task.md');
  assert.ok(fs.existsSync(path.join(neighbour, 'criteria.json')), 'сосед потерял criteria.json');
  assert.equal(statusOf(repo, '0378'), 'open', 'статус соседа изменился');
}));

/* --- 5. Принятое не отменяется ------------------------------------------ */
test('принятое задание — код 1 и «принятое не отменяется», файлы целы', () => withRepo((repo) => {
  const dir = path.join(repo, 'docs', 'tasks', '0377');
  const result = run(repo, ['--id', '0377']);
  assert.equal(result.code, 1, 'принятое: exit ' + String(result.code) + ' — ' + result.said);
  assert.match(result.said, /принятое не отменяется/u, 'нет причины отказа: ' + result.said);
  for (const rel of ARTIFACTS) {
    assert.ok(fs.existsSync(path.join(dir, rel)), 'принятое потеряло: ' + rel);
  }
  assert.equal(statusOf(repo, '0377'), 'accepted', 'статус принятого изменился');
}));

/* --- 6. Несуществующее задание — код 2 ---------------------------------- */
test('несуществующее задание — код 2', () => withRepo((repo) => {
  const result = run(repo, ['--id', '0999']);
  assert.equal(result.code, 2, 'несуществующее: exit ' + String(result.code) + ' — ' + result.said);
  assert.match(result.said, /0999/u, 'в отказе нет номера: ' + result.said);
}));

/* --- 7. Нет реестра — код 1 с путём ------------------------------------- */
test('нет реестра — код 1 с путём REGISTRY.json', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cancel-noreg-'));
  try {
    seedTask(repo, '0376');
    const result = run(repo, ['--id', '0376']);
    assert.equal(result.code, 1, 'без реестра: exit ' + String(result.code) + ' — ' + result.said);
    assert.match(result.said, /REGISTRY\.json/u, 'в отказе нет пути реестра: ' + result.said);
    assert.ok(fs.existsSync(path.join(repo, 'docs', 'tasks', '0376', 'criteria.lock')),
      'без реестра артефакт всё равно удалён');
    assert.equal(fs.existsSync(path.join(repo, 'docs', 'tasks', 'REGISTRY.json')), false,
      'реестр создан при отказе');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

/* --- 8. Повторная отмена безопасна -------------------------------------- */
test('повторная отмена — код 0, контракт и статус на месте', () => withRepo((repo) => {
  const first = run(repo, ['--id', '0376']);
  assert.equal(first.code, 0, 'первая отмена: exit ' + String(first.code) + ' — ' + first.said);
  const second = run(repo, ['--id', '0376']);
  assert.equal(second.code, 0, 'повтор: exit ' + String(second.code) + ' — ' + second.said);
  assertContractKept(path.join(repo, 'docs', 'tasks', '0376'));
  assert.equal(statusOf(repo, '0376'), 'cancelled');
}));

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('TASK-CANCEL TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
