/**
 * The run store keeps the last state of every node in memory and on disk, so a
 * restart no longer erases what the panel shows. These tests use scratch
 * folders; nothing here touches the profile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime } from '../lib/api.js';
import { listRuns, noteRun, runFilePath } from '../lib/runs.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try {
    body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg-runs-test-'));
}

test('запуск переживает новый runtime: запись читается из файла', () => {
  const dir = scratch();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const first = createGraphRuntime({ roots: [project], runsDir: dir });
  noteRun(first, { root: project, node: 'worker', state: 'done', since: 1000, finishedAt: 2000, childId: 'c1' });

  const second = createGraphRuntime({ roots: [project], runsDir: dir });
  const runs = listRuns(second, project);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].node, 'worker');
  assert.equal(runs[0].state, 'done');
  assert.equal(runs[0].childId, 'c1');
  assert.equal(runs[0].since, 1000);
  assert.ok(fs.existsSync(runFilePath(second, project)));
});

test('два проекта не смешивают записи', () => {
  const dir = scratch();
  const left = path.join(dir, 'left');
  const right = path.join(dir, 'right');
  fs.mkdirSync(left, { recursive: true });
  fs.mkdirSync(right, { recursive: true });
  const runtime = createGraphRuntime({ roots: [left, right], runsDir: dir });
  noteRun(runtime, { root: left, node: 'worker', state: 'done', since: 1 });
  noteRun(runtime, { root: right, node: 'judge', state: 'error', since: 2, message: 'сломалось' });
  assert.equal(listRuns(runtime, left).length, 1);
  assert.equal(listRuns(runtime, right).length, 1);
  assert.equal(listRuns(runtime, right)[0].message, 'сломалось');
  assert.equal(runFilePath(runtime, left) === runFilePath(runtime, right), false);
});

test('новое состояние узла заменяет прежнее и не теряет соседей', () => {
  const dir = scratch();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const first = createGraphRuntime({ roots: [project], runsDir: dir });
  noteRun(first, { root: project, node: 'worker', state: 'running', since: 10 });
  noteRun(first, { root: project, node: 'judge', state: 'done', since: 20, finishedAt: 30 });

  const second = createGraphRuntime({ roots: [project], runsDir: dir });
  noteRun(second, { root: project, node: 'worker', state: 'done', since: 10, finishedAt: 40 });
  const runs = listRuns(second, project);
  assert.equal(runs.length, 2);
  const worker = runs.find((run) => run.node === 'worker');
  assert.equal(worker.state, 'done');
  assert.equal(worker.since, 10, 'срок запуска не должен съезжать');
  assert.equal(runs.find((run) => run.node === 'judge').state, 'done');
});

test('новый запуск узла добавляется, а не затирает прежний', () => {
  const dir = scratch();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const runtime = createGraphRuntime({ roots: [project], runsDir: dir });
  noteRun(runtime, { root: project, node: 'worker', state: 'done', since: 1000, finishedAt: 1500, branchId: 'br-1' });
  noteRun(runtime, { root: project, node: 'worker', state: 'done', since: 2000, finishedAt: 2500 });
  const runs = listRuns(runtime, project);
  assert.equal(runs.length, 2, 'история должна хранить оба запуска');
  assert.equal(runs[0].since, 2000, 'свежий запуск идёт первым');
  assert.equal(runs[1].branchId, 'br-1');
});

test('переход running → done переписывает запись того же запуска', () => {
  const dir = scratch();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const runtime = createGraphRuntime({ roots: [project], runsDir: dir });
  noteRun(runtime, { root: project, node: 'worker', state: 'running', since: 777 });
  noteRun(runtime, { root: project, node: 'worker', state: 'error', since: 777, finishedAt: 900, message: 'сломалось' });
  const runs = listRuns(runtime, project);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'error');
  assert.equal(runs[0].finishedAt, 900);
});

test('перезапись записи не стирает подтверждение обмена', () => {
  /*
   * Живой дефект 2026-11-01: повторная доставка того же письма имеет тот же since,
   * переписывала запись целиком и гасила ack на следующем проходе.
   */
  const dir = scratch();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const runtime = createGraphRuntime({ roots: [project], runsDir: dir });
  noteRun(runtime, {
    root: project, node: 'workflow', kind: 'exchange', since: 900, state: 'done',
    delivered: 'threads/critic-report/letter.md', ack: 'threads/critic-report/ack.md', ackAt: '2026-11-01T18:15:00+03:00',
  });
  noteRun(runtime, {
    root: project, node: 'workflow', kind: 'exchange', since: 900, state: 'done',
    delivered: 'threads/critic-report/letter.md',
  });
  const record = listRuns(runtime, project)[0];
  assert.equal(record.ack, 'threads/critic-report/ack.md', 'подтверждение — факт, а не состояние запуска');
  assert.equal(record.ackAt, '2026-11-01T18:15:00+03:00');

  const restarted = createGraphRuntime({ roots: [project], runsDir: dir });
  noteRun(restarted, {
    root: project, node: 'workflow', kind: 'exchange', since: 900, state: 'done',
    delivered: 'threads/critic-report/letter.md',
  });
  assert.equal(listRuns(restarted, project)[0].ack, 'threads/critic-report/ack.md', 'и после перезапуска тоже');
});

test('история ограничена по размеру', () => {
  const dir = scratch();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const runtime = createGraphRuntime({ roots: [project], runsDir: dir });
  for (let index = 0; index < 205; index += 1) {
    noteRun(runtime, { root: project, node: 'worker', state: 'done', since: 1000 + index });
  }
  const runs = listRuns(runtime, project);
  assert.equal(runs.length, 200, 'файл не должен расти бесконечно');
  assert.equal(runs[0].since, 1204, 'свежие записи остаются');
});

test('битый файл не ломает панель: история начинается заново', () => {
  const dir = scratch();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const probe = createGraphRuntime({ roots: [project], runsDir: dir });
  fs.mkdirSync(path.dirname(runFilePath(probe, project)), { recursive: true });
  fs.writeFileSync(runFilePath(probe, project), '{ это не json');
  const runtime = createGraphRuntime({ roots: [project], runsDir: dir });
  assert.deepEqual(listRuns(runtime, project), []);
  noteRun(runtime, { root: project, node: 'worker', state: 'running', since: 5 });
  assert.equal(listRuns(runtime, project).length, 1);
});

test('недоступный каталог не превращается в исключение инструмента', () => {
  const dir = scratch();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  /* File where the store expects a directory: mkdir must fail, noteRun must not throw. */
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  const runtime = createGraphRuntime({ roots: [project], runsDir: blocked });
  noteRun(runtime, { root: project, node: 'worker', state: 'running', since: 7 });
  assert.equal(listRuns(runtime, project)[0].state, 'running', 'память всё равно отвечает');
});

test('два процесса делят один файл: под замком записи сливаются, а не затираются', () => {
  /*
   * Живой дефект 2026-11-04 (критик): координатор, субагент и панель писали файл
   * одного корня целиком из памяти процесса и затирали записи друг друга.
   * Два runtime-объекта с общим runsDir — это два процесса: каждый noteRun обязан
   * перечитать файл под замком и увидеть записи соседа.
   */
  const dir = scratch();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const coordinator = createGraphRuntime({ roots: [project], runsDir: dir });
  const worker = createGraphRuntime({ roots: [project], runsDir: dir });

  noteRun(coordinator, { root: project, node: 'coordinator', state: 'running', since: 100 });
  noteRun(worker, { root: project, node: 'worker', state: 'done', since: 200, finishedAt: 250 });

  const afterWorker = listRuns(worker, project).map((run) => run.node).sort();
  assert.deepEqual(afterWorker, ['coordinator', 'worker'], 'второй процесс видит запись первого');

  noteRun(coordinator, { root: project, node: 'judge', state: 'done', since: 300, finishedAt: 350 });
  const rows = JSON.parse(fs.readFileSync(runFilePath(coordinator, project), 'utf8'));
  assert.deepEqual(rows.map((row) => row.node).sort(), ['coordinator', 'judge', 'worker'], 'файл хранит записи обоих');
  assert.deepEqual(listRuns(coordinator, project).map((run) => run.node).sort(), ['coordinator', 'judge', 'worker'], 'память процесса тоже сходится с файлом');
  assert.equal(fs.existsSync(runFilePath(coordinator, project) + '.lock'), false, 'замок снят после записи');
});

test('брошенный замок старше пяти секунд снимается и не блокирует историю', () => {
  const dir = scratch();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const runtime = createGraphRuntime({ roots: [project], runsDir: dir });
  const file = runFilePath(runtime, project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + '.lock';
  fs.writeFileSync(lock, '999999:0:abandoned', 'utf8');
  const old = new Date(Date.now() - 6000);
  fs.utimesSync(lock, old, old);

  noteRun(runtime, { root: project, node: 'worker', state: 'done', since: 5 });
  assert.equal(fs.existsSync(lock), false, 'замок мёртвого владельца снят');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].node, 'worker');
  assert.equal(rows[0].state, 'done');
});

if (failures.length > 0) {
  console.log('RUNS TEST FAILED: ' + (passed + failures.length - failures.length) + '/' + (passed + failures.length));
  for (const failure of failures) {
    console.log('FAIL ' + failure.name);
    console.log('  ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)));
  }
  process.exit(1);
}
console.log('RUNS TEST OK: ' + passed + '/' + passed);
