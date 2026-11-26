/**
 * Задание 0349: запись прогона, оставшаяся в running от умершего процесса, не
 * держит узел занятым после перезапуска хоста.
 *
 * Живой дефект: прогон judge прерывался перезапуском, запись оставалась
 * state: running, и project_graph_spawn отвечал node-busy, пока не помогал
 * новый перезапуск. Файл прогонов читается один раз за runtime (ensureLoaded),
 * поэтому распознавать зависшую запись нужно именно в момент первой загрузки.
 *
 * Стор подменяется через PG_RUNS_DIR, как и в живом профиле; свои файлы тест
 * пишет в scratch-каталог и профиль не трогает.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg-runs-stale-'));
}

function projectIn(dir, name = 'project') {
  const project = path.join(dir, name);
  fs.mkdirSync(project, { recursive: true });
  return project;
}

/** Профиль или тест указал склад прогонов: storeDir читает env в момент вызова. */
function withStore(dir, body) {
  const saved = process.env.PG_RUNS_DIR;
  process.env.PG_RUNS_DIR = dir;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env.PG_RUNS_DIR;
    else process.env.PG_RUNS_DIR = saved;
  }
}

/** Запись прогона, как её оставил бы прежний процесс. */
function row(root, node, state, since, extra = {}) {
  return { root, node, state, since, ...extra };
}

/** Положить файл прогонов корня, минуя стор: так выглядит переживший процесс файл. */
function writeStore(runtime, root, rows) {
  const file = runFilePath(runtime, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n', 'utf8');
  return file;
}

function bytes(file) {
  return fs.readFileSync(file, 'utf8');
}

test('0349: зависшая запись running при загрузке становится error с причиной, файл переписан', () => {
  const dir = scratch();
  const project = projectIn(dir);
  withStore(dir, () => {
    const writer = createGraphRuntime({ roots: [project] });
    const done = row(project, 'worker', 'done', 200, { finishedAt: 300 });
    const failed = row(project, 'reviewer-1', 'error', 400, { finishedAt: 500, message: 'исходная ошибка' });
    const queued = row(project, 'coordinator', 'queued', 600);
    const file = writeStore(writer, project, [
      row(project, 'judge', 'running', 100, { childId: 'child-1' }),
      done,
      failed,
      queued,
    ]);

    /* Перезапуск: новый runtime — новый процесс, память пуста. */
    const restarted = createGraphRuntime({ roots: [project] });
    const runs = listRuns(restarted, project);

    const judge = runs.find((run) => run.node === 'judge');
    assert.equal(judge.state, 'error', 'running от умершего процесса не живой прогон');
    assert.match(judge.message, /перезапуск/iu, 'причина названа перезапуском');
    assert.match(judge.message, /завис/iu, 'причина называет зависание');
    assert.equal(typeof judge.finishedAt, 'number', 'finishedAt проставлен');
    assert.equal(typeof judge.updatedAt, 'number', 'updatedAt проставлен');
    assert.equal(judge.since, 100, 'срок запуска не съехал');
    assert.equal(judge.childId, 'child-1', 'прочие поля записи сохранены');

    /* activeRuns-эквивалент: список больше не показывает running — узел свободен. */
    assert.equal(runs.filter((run) => String(run.state || 'running').toLowerCase() === 'running').length, 0,
      'listRuns не должен показывать running');

    /* done/error/queued не тронуты, порядок и состав прочих записей прежний. */
    assert.deepEqual(runs.find((run) => run.node === 'worker'), done);
    assert.deepEqual(runs.find((run) => run.node === 'reviewer-1'), failed);
    assert.deepEqual(runs.find((run) => run.node === 'coordinator'), queued);

    const disk = JSON.parse(bytes(file));
    assert.deepEqual(disk.map((item) => item.node), ['judge', 'worker', 'reviewer-1', 'coordinator'],
      'порядок записей в файле не меняется');
    assert.equal(disk[0].state, 'error', 'исправленное состояние записано в файл');
    assert.match(disk[0].message, /перезапуск/iu);
    assert.equal(typeof disk[0].finishedAt, 'number');
    assert.equal(typeof disk[0].updatedAt, 'number');
    assert.deepEqual(disk.slice(1), [done, failed, queued], 'прочие записи в файле байт-в-байт прежние');
    assert.equal(fs.existsSync(file + '.lock'), false, 'замок снят после починки');

    /* Живой прогон после починки не перебивается repair-записью. */
    noteRun(restarted, { root: project, node: 'judge', state: 'done', since: 100, finishedAt: 1200 });
    assert.equal(listRuns(restarted, project).find((run) => run.node === 'judge').state, 'done',
      'новое состояние живого прогона не проигрывает починке');
    assert.equal(JSON.parse(bytes(file)).find((item) => item.node === 'judge').state, 'done',
      'и в файле тоже done');

    /* Повторная загрузка уже починенного файла: зависших нет — переписывать нечего. */
    const repairedBytes = bytes(file);
    const repairedMtime = fs.statSync(file).mtimeMs;
    const reloaded = createGraphRuntime({ roots: [project] });
    assert.equal(listRuns(reloaded, project).find((run) => run.node === 'judge').state, 'done');
    assert.equal(bytes(file), repairedBytes, 'повторная загрузка файл не переписывает');
    assert.equal(fs.statSync(file).mtimeMs, repairedMtime, 'повторная загрузка не трогает время файла');
  });
});

test('0349: повторная загрузка без зависших записей файл не переписывает', () => {
  const dir = scratch();
  const project = projectIn(dir);
  withStore(dir, () => {
    const writer = createGraphRuntime({ roots: [project] });
    const rows = [
      row(project, 'worker', 'done', 100, { finishedAt: 200 }),
      row(project, 'reviewer-1', 'error', 300, { finishedAt: 400, message: 'сломалось' }),
      row(project, 'coordinator', 'queued', 500),
    ];
    const file = writeStore(writer, project, rows);
    const before = bytes(file);
    const beforeStat = fs.statSync(file);

    const bySince = (left, right) => (left.since || 0) - (right.since || 0);
    const restarted = createGraphRuntime({ roots: [project] });
    const first = listRuns(restarted, project);
    assert.deepEqual([...first].sort(bySince), rows, 'записи прочитаны как есть, без причин и finishedAt');
    assert.equal(bytes(file), before, 'без зависших файл не переписан');
    assert.equal(fs.statSync(file).mtimeMs, beforeStat.mtimeMs, 'файл не тронут по времени');
    assert.equal(fs.existsSync(file + '.lock'), false, 'замок не создавался');

    /* Третья загрузка того же файла новым runtime тоже ничего не пишет. */
    const beforeAgain = fs.statSync(file).mtimeMs;
    const third = createGraphRuntime({ roots: [project] });
    assert.deepEqual([...listRuns(third, project)].sort(bySince), rows);
    assert.equal(bytes(file), before, 'повторная загрузка не переписала файл');
    assert.equal(fs.statSync(file).mtimeMs, beforeAgain, 'повторная загрузка не тронула время файла');
  });
});

test('0349: чужие корни целы и не превращают свои running в error', () => {
  const dir = scratch();
  const own = projectIn(dir, 'own');
  const foreign = projectIn(dir, 'foreign');
  withStore(dir, () => {
    const writer = createGraphRuntime({ roots: [own, foreign] });
    const foreignRow = row(foreign, 'judge', 'running', 700, { childId: 'foreign-child' });
    const ownFile = writeStore(writer, own, [
      row(own, 'worker', 'running', 100),
      foreignRow,
      row(own, 'worker', 'done', 200, { finishedAt: 300 }),
    ]);
    const foreignFile = writeStore(writer, foreign, [foreignRow]);
    const foreignBytes = bytes(foreignFile);

    /* Загружается только свой корень. */
    const ownRuntime = createGraphRuntime({ roots: [own] });
    const ownRuns = listRuns(ownRuntime, own);
    const mine = ownRuns.filter((run) => run.root === own);
    assert.equal(mine.filter((run) => run.node === 'worker' && run.since === 100)[0].state, 'error',
      'свой running завис и закрыт');
    assert.equal(mine.filter((run) => run.node === 'worker' && run.since === 200)[0].state, 'done',
      'свой done не тронут');
    assert.equal(ownRuns.filter((run) => run.root === foreign).length, 0,
      'чужой корень не попадает в список своего');

    const ownDisk = JSON.parse(bytes(ownFile));
    assert.deepEqual(ownDisk[1], foreignRow, 'чужая запись в файле не изменена');
    assert.equal(ownDisk[1].state, 'running', 'чужой running не превращён в error');
    assert.deepEqual(ownDisk.map((item) => item.since), [100, 700, 200], 'порядок файла сохранён');
    assert.equal(bytes(foreignFile), foreignBytes, 'файл чужого корня не тронут');

    /* Свой корень загружен отдельно: его запись починится только тогда. */
    const ownBytes = bytes(ownFile);
    const foreignRuntime = createGraphRuntime({ roots: [foreign] });
    assert.equal(listRuns(foreignRuntime, foreign)[0].state, 'error', 'свой running чинится при своей загрузке');
    assert.equal(bytes(ownFile), ownBytes, 'файл уже загруженного корня не меняется чужой загрузкой');
  });
});

test('0349: живой прогон текущего процесса repair не задевает', () => {
  const dir = scratch();
  const project = projectIn(dir);
  withStore(dir, () => {
    const runtime = createGraphRuntime({ roots: [project] });
    noteRun(runtime, { root: project, node: 'judge', state: 'running', since: 42, childId: 'live-1' });
    const live = listRuns(runtime, project).find((run) => run.node === 'judge');
    assert.equal(live.state, 'running', 'свой прогон остаётся живым');
    assert.equal(live.childId, 'live-1');
    assert.equal(live.message, undefined, 'живому прогону причина не выдумана');
  });
});

test('0349: запись без state и в верхнем регистре тоже считается running, как в activeRuns', () => {
  const dir = scratch();
  const project = projectIn(dir);
  withStore(dir, () => {
    const writer = createGraphRuntime({ roots: [project] });
    writeStore(writer, project, [
      { root: project, node: 'legacy', since: 1 },
      row(project, 'upper', 'RUNNING', 2),
    ]);
    const restarted = createGraphRuntime({ roots: [project] });
    const runs = listRuns(restarted, project);
    for (const node of ['legacy', 'upper']) {
      const record = runs.find((run) => run.node === node);
      assert.equal(record.state, 'error', node + ': состояние по умолчанию — running, запись зависла');
      assert.match(record.message, /перезапуск/iu, node + ': причина названа');
    }
  });
});

test('0349: сбой записи не роняет плагин: зависшая запись видна как error, файл прежний', () => {
  const dir = scratch();
  const project = projectIn(dir);
  withStore(dir, () => {
    const writer = createGraphRuntime({ roots: [project] });
    const file = writeStore(writer, project, [row(project, 'judge', 'running', 100)]);
    const before = bytes(file);
    /* На месте замка каталог: снять его нельзя, а запись починки обязана сдаться. */
    const lock = file + '.lock';
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 6000);
    fs.utimesSync(lock, old, old);

    const warnings = [];
    const savedWarn = console.warn;
    let failure = null;
    try {
      console.warn = (message) => warnings.push(String(message));
      try {
        const restarted = createGraphRuntime({ roots: [project] });
        const record = listRuns(restarted, project).find((run) => run.node === 'judge');
        assert.equal(record.state, 'error', 'память всё равно освобождает узел');
        assert.match(record.message, /перезапуск/iu);
      } catch (error) {
        failure = error;
      }
    } finally {
      console.warn = savedWarn;
    }
    assert.equal(failure, null, 'загрузка не бросает: ' + (failure && failure.message));
    assert.ok(warnings.some((message) => /stale runs were not written/u.test(message)),
      'сбой починки — предупреждение: ' + JSON.stringify(warnings));
    assert.equal(bytes(file), before, 'непочиненный файл остался прежним');
    assert.ok(fs.statSync(lock).isDirectory(), 'каталог-замок не снят');
  });
});

if (failures.length > 0) {
  console.log('RUNS-STALE TEST FAILED: ' + (passed + failures.length - failures.length) + '/' + (passed + failures.length));
  for (const failure of failures) {
    console.log('FAIL ' + failure.name);
    console.log('  ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)));
  }
  process.exit(1);
}
console.log('RUNS-STALE TEST OK: ' + passed + '/' + passed);
