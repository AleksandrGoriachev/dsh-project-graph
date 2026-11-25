/**
 * Задание 0329: write-гейт включён по умолчанию и не пускает неизвестную сессию.
 *
 * Набор держит четыре обещания задания:
 *   1) нет `enforcement.writePolicy` (и нет файла конфига) — режим `fail`, а не `off`;
 *   2) неизвестная сессия (нет записи прогона `runs`) не пишет продуктовый путь при
 *      `fail`: deny, причина начинается токеном `unknown-session` и несёт рецепт;
 *      документы и `checks/**` живут по прежним правилам;
 *   3) явный `writePolicy=off` сохраняет allow, `warn` превращает deny в allow;
 *   4) известный worker (запись прогона + узел структуры) пишет код, известный
 *      judge — нет: ветки класса 0312 не тронуты.
 *
 * Журнал решений и прогоны живут во временных каталогах: в ~/.dsh ничего не
 * пишется. Корень каждого теста — свой временный проект с TASK-META.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_WRITE_POLICY, handlePreExecute, readAlternatives, readWritePolicy,
  resetStructurePolicyState, unknownSessionDenyReason, writeDecision,
} from '../lib/structure-policy.js';
import { createGraphRuntime } from '../lib/api.js';
import { noteRun } from '../lib/runs.js';

const TASK_ID = '9001';

const GRAPH = {
  version: 1,
  nodes: [
    { id: 'coordinator', role: 'координатор' },
    { id: 'worker', role: 'исполнитель' },
    { id: 'judge', role: 'приёмщик' },
  ],
  edges: [],
};

let passed = 0;
const failures = [];

async function test(name, body) {
  try {
    await body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

const created = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ }
  }
});

/** Свой каталог хранилища на тест: журнал решений не идёт в ~/.dsh. */
async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = tempDir('pg-0329-store-');
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

/**
 * Временный проект: структура с ролями, задание 9001 и общий блок workflow.
 * `writePolicy: undefined` — ключа нет (enforcement пустой); `config: false` —
 * файла конфига нет вовсе; иначе режим объявлен явно.
 */
function project({ writePolicy, config = true, allowedPaths = ['lib/**', 'test/**'] } = {}) {
  const root = tempDir('pg-0329-root-');
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'),
    JSON.stringify(GRAPH, null, 2) + '\n');
  if (config) {
    fs.mkdirSync(path.join(root, 'docs', 'subagent-workflow'), { recursive: true });
    const enforcement = writePolicy === undefined ? {} : { writePolicy };
    fs.writeFileSync(path.join(root, 'docs', 'subagent-workflow', 'workflow.config.json'),
      JSON.stringify({ version: 1, enforcement }, null, 2) + '\n');
  }
  fs.mkdirSync(path.join(root, 'docs', 'tasks', TASK_ID), { recursive: true });
  const meta = {
    id: TASK_ID, version: 1, title: 'fixture 0329',
    executor: 'subagent:worker', acceptor: 'subagent:judge',
    allowedPaths,
  };
  fs.writeFileSync(path.join(root, 'docs', 'tasks', TASK_ID, 'task.md'),
    ['# fixture', '', '<!-- TASK-META', JSON.stringify(meta, null, 2), '-->', ''].join('\n'));
  return root;
}

/** Рантайм с прогонами в своём сторе (структура — каталог проекта). */
function runtimeFor(root, store) {
  return createGraphRuntime({ roots: [root], structureDir: 'structure', runsDir: path.join(store, 'runs') });
}

/** Связать сессию с узлом так же, как это делает project_graph_spawn. */
function bindSession(runtime, root, node, sessionId) {
  noteRun(runtime, { root, node, state: 'done', since: Date.now() - 60000, childId: sessionId });
}

function assertDeny(decision, label) {
  assert.equal(decision.allow, false, label + ': неизвестной сессии разрешён продуктовый путь');
  assert.equal(decision.mode, 'fail', label + ': режим не fail');
  assert.equal(decision.task, TASK_ID, label + ': решение не назвало задание');
  assert.ok(String(decision.reason).startsWith('unknown-session:'),
    label + ': причина не начинается unknown-session: ' + decision.reason);
  assert.match(decision.reason, /worker/u, label + ': рецепт не называет worker');
  assert.match(decision.reason, /runs/u, label + ': рецепт не называет журнал прогонов');
  assert.match(decision.reason, /checks/u, label + ': рецепт не называет checks');
  assert.match(decision.reason, /structure/u, label + ': рецепт не называет structure');
  assert.equal(String(decision.reason).includes('\n'), false, label + ': причина — не одна строка');
}

/* ------------------------------------------------------------------ */
/* 1. Default: нет writePolicy — fail, а не off                        */
/* ------------------------------------------------------------------ */

await test('0329: нет enforcement.writePolicy — режим fail (default)', async () => {
  assert.equal(DEFAULT_WRITE_POLICY, 'fail', 'DEFAULT_WRITE_POLICY не fail');
  const state = readWritePolicy(project());
  assert.equal(state.mode, 'fail', 'нет ключа writePolicy — не fail');
  assert.equal(state.source, 'default', 'режим не взят по умолчанию');
  const noConfig = readWritePolicy(project({ config: false }));
  assert.equal(noConfig.mode, 'fail', 'нет файла workflow.config.json — не fail');
  assert.equal(noConfig.source, 'default');
  assert.ok(noConfig.error, 'причина чтения конфига потеряна');
});

/* ------------------------------------------------------------------ */
/* 2. Unknown session: продуктовый путь deny, документы allow          */
/* ------------------------------------------------------------------ */

await test('0329: unknown session + lib при fail — deny с рецептом; docs/checks allow', async () => {
  await withStore(async (store) => {
    const root = project();
    const runtime = runtimeFor(root, store);
    assertDeny(writeDecision({ root, runtime, sessionId: 'session-unknown', path: 'lib/x.js' }), 'unknown');
    assertDeny(writeDecision({ root, runtime, path: 'lib/x.js' }), 'без сессии');
    assertDeny(writeDecision({
      root, runtime, sessionId: 'session-unknown', path: path.join(root, 'lib', 'deep', 'api.js'),
    }), 'абсолютный путь');
    const docs = writeDecision({ root, runtime, sessionId: 'session-unknown', path: 'docs/note.md' });
    assert.equal(docs.allow, true, 'документ отклонён неизвестной сессией');
    assert.match(docs.reason, /вне гейта записи/u);
    const report = writeDecision({
      root, runtime, sessionId: 'session-unknown', path: 'docs/tasks/' + TASK_ID + '/report.md',
    });
    assert.equal(report.allow, true, 'отчёт задания отклонён неизвестной сессией');
    const checks = writeDecision({ root, runtime, sessionId: 'session-unknown', path: 'checks/c.mjs' });
    assert.equal(checks.allow, true, 'проверка отклонена неизвестной сессией');
    assert.match(checks.reason, /вне гейта записи/u);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Явный off — allow; warn — allow с причиной отказа                */
/* ------------------------------------------------------------------ */

await test('0329: явный writePolicy=off — allow; warn — allow с причиной deny', async () => {
  await withStore(async (store) => {
    const off = project({ writePolicy: 'off' });
    const offRuntime = runtimeFor(off, store);
    const decision = writeDecision({ root: off, runtime: offRuntime, sessionId: 'session-unknown', path: 'lib/x.js' });
    assert.equal(decision.allow, true, 'явный off не разрешил запись');
    assert.equal(decision.mode, 'off', 'решение не назвало режим off');
    assert.match(decision.reason, /writePolicy=off/u);

    const warnRoot = project({ writePolicy: 'warn' });
    const warnRuntime = runtimeFor(warnRoot, store);
    const warn = writeDecision({ root: warnRoot, runtime: warnRuntime, sessionId: 'session-unknown', path: 'lib/x.js' });
    assert.equal(warn.allow, true, 'warn не пропустил unknown-session');
    assert.equal(warn.mode, 'warn');
    assert.ok(String(warn.reason).startsWith('writePolicy=warn: unknown-session:'),
      'warn потерял причину unknown-session: ' + warn.reason);
    assert.equal(warn.task, TASK_ID, 'warn потерял задание');
  });
});

/* ------------------------------------------------------------------ */
/* 4. Известные ветки: worker allow, judge deny (0312 не тронут)       */
/* ------------------------------------------------------------------ */

await test('0329: известный worker пишет lib, известный judge — нет', async () => {
  await withStore(async (store) => {
    const root = project();
    const runtime = runtimeFor(root, store);
    bindSession(runtime, root, 'worker', 'session-worker');
    bindSession(runtime, root, 'judge', 'session-judge');
    const worker = writeDecision({ root, runtime, sessionId: 'session-worker', path: 'lib/x.js' });
    assert.equal(worker.allow, true, 'worker не пишет в allowedPaths: ' + worker.reason);
    assert.equal(worker.task, TASK_ID);
    assert.equal(String(worker.reason).includes('unknown-session'), false, 'worker принят за неизвестную сессию');
    const judge = writeDecision({ root, runtime, sessionId: 'session-judge', path: 'lib/x.js' });
    assert.equal(judge.allow, false, 'judge написал продуктовый код');
    assert.equal(judge.role, 'приёмщик');
    assert.equal(judge.classId, 'judge');
    assert.equal(judge.unknownSession, undefined, 'judge спутан с unknown-session');
  });
});

/* ------------------------------------------------------------------ */
/* 5. Хук: deny до исполнения, журнал, документы, off, warn            */
/* ------------------------------------------------------------------ */

await test('0329: handlePreExecute — unknown deny до next, журнал denied; docs и off — allow', async () => {
  await withStore(async (store) => {
    resetStructurePolicyState();
    const root = project();
    const runtime = runtimeFor(root, store);
    let called = 0;
    const denied = await handlePreExecute({
      exec: { name: 'write', arguments: { file_path: 'lib/x.js' }, agent: { id: 'session-unknown' } },
      next: async () => { called += 1; return { kind: 'allow' }; },
      runtime,
      root,
    });
    assert.equal(called, 0, 'unknown-session дошла до downstream');
    assert.equal(denied.kind, 'deny', 'unknown-session не отклонена');
    assert.match(denied.reason, /lib.x.js/u, 'отказ не назвал путь');
    assert.match(denied.reason, /worker/u, 'отказ не назвал рецепт');
    assert.match(denied.reason, /runs/u, 'отказ не назвал журнал прогонов');
    assert.equal(denied.reason.includes('\n'), false, 'отказ — не одна строка');
    const events = readAlternatives({ root });
    assert.equal(events.length, 1, 'решение не записано один раз');
    assert.equal(events[0].tool, 'write');
    assert.equal(events[0].mode, 'fail');
    assert.equal(events[0].denied, true);
    assert.ok(String(events[0].detail).startsWith('unknown-session:'), 'журнал потерял причину');

    const report = await handlePreExecute({
      exec: { name: 'write', arguments: { file_path: 'docs/tasks/' + TASK_ID + '/report.md' } },
      next: async () => ({ kind: 'allow' }),
      runtime,
      root,
      sessionId: 'session-unknown',
    });
    assert.equal(report.kind, 'allow', 'документ неизвестной сессии отклонён');
    assert.equal(readAlternatives({ root }).length, 1, 'allow дописал журнал');

    resetStructurePolicyState();
    const offRoot = project({ writePolicy: 'off' });
    const offRuntime = runtimeFor(offRoot, store);
    let offCalled = 0;
    const off = await handlePreExecute({
      exec: { name: 'write', arguments: { file_path: 'lib/x.js' } },
      next: async () => { offCalled += 1; return { kind: 'allow' }; },
      runtime: offRuntime,
      root: offRoot,
      sessionId: 'session-unknown',
    });
    assert.equal(offCalled, 1, 'явный off не пропустил unknown-session');
    assert.equal(off.kind, 'allow');

    resetStructurePolicyState();
    const warnRoot = project({ writePolicy: 'warn' });
    const warnRuntime = runtimeFor(warnRoot, store);
    /* Журнал один на хранилище: считаем прирост, а не абсолют. */
    const beforeWarn = readAlternatives({ root: warnRoot }).length;
    let warnCalled = 0;
    const warn = await handlePreExecute({
      exec: { name: 'write', arguments: { file_path: 'lib/x.js' } },
      next: async () => { warnCalled += 1; return { kind: 'allow' }; },
      runtime: warnRuntime,
      root: warnRoot,
      sessionId: 'session-unknown',
    });
    assert.equal(warnCalled, 1, 'warn не пропустил unknown-session');
    assert.equal(warn.kind, 'allow');
    const warnEvents = readAlternatives({ root: warnRoot });
    assert.equal(warnEvents.length, beforeWarn + 1, 'warn не записал решение ровно одно');
    assert.equal(warnEvents[0].mode, 'warn');
    assert.equal(warnEvents[0].denied, false);
    assert.ok(String(warnEvents[0].detail).startsWith('unknown-session:'), 'warn потерял причину');
  });
});

/* ------------------------------------------------------------------ */
/* 6. Текст отказа — путь, сессия, рецепт, одна строка                 */
/* ------------------------------------------------------------------ */

await test('0329: unknownSessionDenyReason — путь, сессия и рецепт одной строкой', async () => {
  const text = unknownSessionDenyReason('edit', { path: 'lib/x.js', task: TASK_ID, session: 'session-unknown' });
  assert.match(text, /lib\/x\.js/u);
  assert.match(text, /session-unknown/u);
  assert.match(text, /worker/u);
  assert.match(text, /runs/u);
  assert.equal(text.includes('\n'), false);
});

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  for (const failure of failures) {
    const detail = failure.error && failure.error.stack ? failure.error.stack : String(failure.error);
    console.error('FAIL: ' + failure.name + '\n' + detail);
  }
  console.error('STRUCTURE POLICY WRITE TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('STRUCTURE POLICY WRITE TEST OK: ' + passed + '/' + passed);
