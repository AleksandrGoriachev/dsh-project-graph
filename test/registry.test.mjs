import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/*
 * Задание 0183: номер задачи выдаёт реестр, а не память агента.
 *
 * Набор держит три вещи вместе: backfill docs/tasks/REGISTRY.json (каждый
 * каталог внесён, subject совпадает с TASK-META.title, accepted — по
 * acceptance.json), выдачу свободного номера tools/task-next-id.mjs и ворота
 * lint: незарегистрированный номер и чужой subject отвергаются.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = path.join(ROOT, 'docs', 'tasks');
const REGISTRY = path.join(TASKS, 'REGISTRY.json');
const NEXT_ID = path.join(ROOT, 'tools', 'task-next-id.mjs');
const REGISTER = path.join(ROOT, 'tools', 'task-register.mjs');
const LINT = path.join(ROOT, 'docs', 'subagent-workflow', 'scripts', 'task-lint.mjs');

const created = [];
function tempRepo(prefix = 'dsh-registry-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
process.on('exit', cleanup);

function runNode(args, { cwd = ROOT } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: (result.stdout || '') + (result.stderr || ''),
  };
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function taskDirs() {
  const out = [];
  const scan = (dir, archived) => {
    for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9]{4}$/u.test(name)) continue;
      const full = path.join(dir, name);
      if (!fs.statSync(full).isDirectory()) continue;
      out.push({ id: name, dir: full, archived });
    }
  };
  scan(TASKS, false);
  const archive = path.join(TASKS, 'archive');
  if (fs.existsSync(archive)) scan(archive, true);
  return out;
}
function parseMeta(taskFile) {
  const text = fs.readFileSync(taskFile, 'utf8');
  const match = text.match(/<!--\s*TASK-META\s*([\s\S]*?)-->/u);
  assert.ok(match, 'нет блока TASK-META в ' + taskFile);
  return JSON.parse(match[1]);
}
function registryIds(doc) { return doc.tasks.map((entry) => String(entry.id)); }

const tests = [];
function test(name, body) { tests.push({ name, body }); }

test('реестр: файл есть, version 1, tasks — массив', () => {
  assert.ok(fs.existsSync(REGISTRY), 'нет docs/tasks/REGISTRY.json — реестр номеров обязателен');
  const doc = readJson(REGISTRY);
  assert.equal(doc.version, 1, 'version реестра');
  assert.ok(Array.isArray(doc.tasks), 'tasks должен быть массивом');
  assert.ok(doc.tasks.length > 0, 'реестр пуст');
});

test('реестр: не меньше 170 записей, номера четырёхзначные и уникальные, subject не пуст', () => {
  const doc = readJson(REGISTRY);
  assert.ok(doc.tasks.length >= 170, 'записей меньше 170: ' + doc.tasks.length + ' — backfill неполон');
  const seen = new Set();
  for (const entry of doc.tasks) {
    const id = String(entry.id);
    assert.match(id, /^[0-9]{4}$/u, 'id не четырёхзначный: ' + JSON.stringify(entry.id));
    assert.ok(!seen.has(id), 'номер повторяется в реестре: ' + id);
    seen.add(id);
    assert.equal(typeof entry.subject, 'string', 'subject не строка у ' + id);
    assert.ok(entry.subject.trim() !== '', 'пустой subject у ' + id);
    assert.ok(['accepted', 'open', 'cancelled'].includes(entry.status), 'неизвестный status у ' + id + ': ' + JSON.stringify(entry.status));
  }
});

test('реестр: 0178 и 0191 внесены с предметом', () => {
  const doc = readJson(REGISTRY);
  const byId = new Map(doc.tasks.map((entry) => [String(entry.id), entry]));
  for (const id of ['0178', '0191']) {
    const entry = byId.get(id);
    assert.ok(entry, 'нет записи ' + id + ' в реестре');
    assert.ok(String(entry.subject || '').trim() !== '', 'пустой subject у ' + id);
  }
});

test('реестр: каждый каталог docs/tasks внесён, subject совпадает с TASK-META.title', () => {
  const doc = readJson(REGISTRY);
  const records = new Map(doc.tasks.map((entry) => [String(entry.id), entry]));
  /*
   * Один номер — одна запись. У 0133 есть архивный дубль того же контракта:
   * за номером стоит живой каталог верхнего уровня, архивный только оттеняет его.
   */
  const preferred = new Map();
  for (const item of taskDirs()) {
    const previous = preferred.get(item.id);
    if (!previous || (previous.archived && !item.archived)) preferred.set(item.id, item);
  }
  assert.ok(preferred.size >= 170, 'каталогов задач меньше 170: ' + preferred.size);
  for (const item of preferred.values()) {
    const where = 'docs/tasks/' + (item.archived ? 'archive/' : '') + item.id;
    const entry = records.get(item.id);
    assert.ok(entry, 'каталог ' + where + ' не внесён в реестр — node tools/task-register.mjs --id ' + item.id + ' --subject "<предмет>"');
    const taskFile = path.join(item.dir, 'task.md');
    if (!fs.existsSync(taskFile)) {
      assert.ok(entry.subject.trim() !== '', 'пустой subject у ' + item.id);
      continue;
    }
    const meta = parseMeta(taskFile);
    assert.equal(entry.subject, String(meta.title === undefined ? '' : meta.title).trim(), 'subject расходится с TASK-META.title у ' + item.id);
    const accepted = fs.existsSync(path.join(item.dir, 'acceptance.json'));
    const expected = accepted ? 'accepted' : (item.archived ? 'cancelled' : 'open');
    assert.equal(entry.status, expected, 'status у ' + item.id + ' должен быть ' + expected);
  }
});

test('task-next-id: номер свободен, четырёхзначен и больше максимального занятого', () => {
  const result = runNode([NEXT_ID]);
  assert.equal(result.status, 0, 'task-next-id: ' + result.output);
  assert.match(result.stdout, /^[0-9]{4}\n$/u, 'не номер: ' + JSON.stringify(result.stdout));
  const id = result.stdout.trim();
  const doc = readJson(REGISTRY);
  const occupied = new Set([...taskDirs().map((item) => item.id), ...registryIds(doc)]);
  assert.ok(!occupied.has(id), 'номер уже занят: ' + id);
  assert.ok(Number(id) > Math.max(...[...occupied].map(Number)), 'номер не больше максимального занятого: ' + id);
});

test('task-next-id: учитывает реестр без каталога', () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, 'docs', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'REGISTRY.json'),
    JSON.stringify({ version: 1, tasks: [{ id: '0100', subject: 'предмет', status: 'open' }] }, null, 2) + '\n');
  const result = runNode([NEXT_ID, '--repo', repo]);
  assert.equal(result.status, 0, 'task-next-id: ' + result.output);
  assert.equal(result.stdout.trim(), '0101', 'реестр не учтён при выдаче номера');
});

test('task-next-id: пустое дерево отдаёт 0001', () => {
  const repo = tempRepo();
  const result = runNode([NEXT_ID, '--repo', repo]);
  assert.equal(result.status, 0, 'task-next-id: ' + result.output);
  assert.equal(result.stdout.trim(), '0001');
});

test('task-register: создаёт запись с --at и status open', () => {
  const repo = tempRepo();
  const at = '2026-11-09T12:00:00+03:00';
  const result = runNode([REGISTER, '--repo', repo, '--id', '0200', '--subject', 'Предмет задачи 0200', '--at', at]);
  assert.equal(result.status, 0, 'task-register: ' + result.output);
  assert.match(result.stdout, /registered 0200/u);
  const doc = readJson(path.join(repo, 'docs', 'tasks', 'REGISTRY.json'));
  assert.equal(doc.version, 1);
  assert.equal(doc.tasks.length, 1);
  assert.deepEqual(doc.tasks[0], { id: '0200', subject: 'Предмет задачи 0200', status: 'open', at });
});

test('task-register: обновляет запись, не дублирует номер и сохраняет at', () => {
  const repo = tempRepo();
  const at = '2026-11-09T12:00:00+03:00';
  runNode([REGISTER, '--repo', repo, '--id', '0200', '--subject', 'Старый предмет', '--at', at]);
  const update = runNode([REGISTER, '--repo', repo, '--id', '0200', '--subject', 'Новый предмет']);
  assert.equal(update.status, 0, 'task-register: ' + update.output);
  assert.match(update.stdout, /updated 0200/u);
  const doc = readJson(path.join(repo, 'docs', 'tasks', 'REGISTRY.json'));
  assert.equal(doc.tasks.length, 1, 'при обновлении появился дубль');
  assert.equal(doc.tasks[0].subject, 'Новый предмет');
  assert.equal(doc.tasks[0].at, at, 'at не должен теряться при обновлении');
});

test('task-register: --at меняет дату, записи идут по номеру, next-id видит реестр', () => {
  const repo = tempRepo();
  runNode([REGISTER, '--repo', repo, '--id', '0102', '--subject', 'Второй']);
  runNode([REGISTER, '--repo', repo, '--id', '0005', '--subject', 'Пятый']);
  const moved = runNode([REGISTER, '--repo', repo, '--id', '0102', '--subject', 'Второй', '--at', '2026-11-09T18:00:00+03:00']);
  assert.equal(moved.status, 0, 'task-register: ' + moved.output);
  const doc = readJson(path.join(repo, 'docs', 'tasks', 'REGISTRY.json'));
  assert.deepEqual(doc.tasks.map((entry) => entry.id), ['0005', '0102'], 'записи должны идти по номеру');
  const entry = doc.tasks.find((item) => item.id === '0102');
  assert.equal(entry.at, '2026-11-09T18:00:00+03:00', '--at не применился');
  const next = runNode([NEXT_ID, '--repo', repo]);
  assert.equal(next.stdout.trim(), '0103', 'task-next-id не увидел запись реестра');
});

test('task-register: неверные аргументы отвергнуты, реестр не создан', () => {
  const cases = [
    ['--id', '200', '--subject', 'предмет'],
    ['--id', 'abcd', '--subject', 'предмет'],
    ['--id', '0200', '--subject', '   '],
    ['--id', '0200', '--subject', 'предмет', '--at', 'вчера'],
  ];
  for (const args of cases) {
    const repo = tempRepo();
    const result = runNode([REGISTER, '--repo', repo, ...args]);
    assert.equal(result.status, 2, 'ожидался отказ аргументов для ' + args.join(' ') + ': ' + result.output);
    assert.ok(!fs.existsSync(path.join(repo, 'docs', 'tasks', 'REGISTRY.json')), 'реестр не должен создаваться при ошибке аргументов');
  }
});

function syntheticTask(registryTasks) {
  const repo = tempRepo();
  const id = '9899';
  const dir = path.join(repo, 'docs', 'tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['task.md', 'criteria.json']) {
    const text = fs.readFileSync(path.join(TASKS, '0191', name), 'utf8').split('0191').join(id);
    fs.writeFileSync(path.join(dir, name), text);
  }
  const meta = parseMeta(path.join(dir, 'task.md'));
  const tasks = typeof registryTasks === 'function' ? registryTasks(meta) : registryTasks;
  fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'REGISTRY.json'),
    JSON.stringify({ version: 1, tasks }, null, 2) + '\n');
  return { repo, dir, meta };
}

test('task-lint: незарегистрированный номер отвергнут', () => {
  const { repo, dir } = syntheticTask([{ id: '0191', subject: 'чужой предмет ', status: 'accepted' }]);
  const result = runNode([LINT, '--task', dir, '--repo', repo]);
  assert.notEqual(result.status, 0, 'незарегистрированный номер прошёл lint');
  assert.match(result.output, /не зарегистрирован/u, 'нет причины про реестр: ' + result.output.slice(-300));
  assert.match(result.output, /REGISTRY/u);
});

test('task-lint: чужой subject отвергнут', () => {
  const { repo, dir } = syntheticTask([{ id: '9899', subject: 'Совсем другой предмет', status: 'open' }]);
  const result = runNode([LINT, '--task', dir, '--repo', repo]);
  assert.notEqual(result.status, 0, 'чужой subject прошёл lint');
  assert.match(result.output, /subject/u);
  assert.match(result.output, /TASK-META\.title/u);
});

test('task-lint: зарегистрированный номер со своим subject проходит', () => {
  const { repo, dir } = syntheticTask((meta) => [{ id: '9899', subject: meta.title, status: 'open' }]);
  const result = runNode([LINT, '--task', dir, '--repo', repo]);
  assert.equal(result.status, 0, 'зарегистрированная задача не прошла lint: ' + result.output.slice(-300));
  assert.ok(!/реестр/u.test(result.output), 'реестр не должен ругаться: ' + result.output.slice(-300));
});

let passed = 0;
const failures = [];
for (const item of tests) {
  try {
    item.body();
    passed += 1;
  } catch (error) {
    failures.push({ name: item.name, error });
  }
}
cleanup();
const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? String(failure.error.message).split('\n')[0] : String(failure.error)));
}
console.log('REGISTRY TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
