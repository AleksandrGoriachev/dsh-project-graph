/**
 * Задание 0342: гейт записи резолвит ОТНОСИТЕЛЬНЫЙ путь от cwd сессии.
 *
 * Прежний дефект: writeGateRoot -> rootForPath резолвил относительный target от
 * корня рантайма (currentRoot/defaultRoot), а не от каталога вызывающей сессии.
 * У субагентской сессии чужой проект давал на относительный путь «нет активного
 * задания», хотя абсолютный путь к тому же файлу проходил.
 *
 * Набор держит три обещания критерия C1 (поведение, не реализация):
 *   1) относительный путь с известным cwd сессии находит задание ТОГО проекта и
 *      разрешён;
 *   2) без cwd сессии действует прежнее поведение (корень рантайма);
 *   3) абсолютный путь даёт то же решение и то же обоснование, что относительный
 *      при том же cwd.
 *
 * Ничего не ослаблено: structure/** по-прежнему отказ, неизвестная сессия при
 * fail по-прежнему unknown-session, роль приёмщика по-прежнему не пишет код.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  handlePreExecute, readAlternatives, resetStructurePolicyState,
} from '../lib/structure-policy.js';
import { createGraphRuntime } from '../lib/api.js';
import { noteRun } from '../lib/runs.js';

/** Два проекта: чужой корень рантайма и проект вызывающей сессии. */
const FOREIGN_TASK = '9401';
const SESSION_TASK = '9402';
const WORKER_SESSION = 'session-0342-worker';
const JUDGE_SESSION = 'session-0342-judge';

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
  const store = tempDir('pg-0342-store-');
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

/** Временный проект: структура с ролями, своё задание и writePolicy=fail. */
function project({ taskId, allowedPaths } = {}) {
  const root = tempDir('pg-0342-root-');
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(GRAPH, null, 2) + '\n');
  fs.mkdirSync(path.join(root, 'docs', 'subagent-workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'subagent-workflow', 'workflow.config.json'),
    JSON.stringify({ version: 1, enforcement: { writePolicy: 'fail' } }, null, 2) + '\n',
  );
  fs.mkdirSync(path.join(root, 'docs', 'tasks', taskId), { recursive: true });
  const meta = {
    id: taskId, version: 1, title: 'fixture 0342',
    executor: 'subagent:worker', acceptor: 'subagent:judge', allowedPaths,
  };
  fs.writeFileSync(
    path.join(root, 'docs', 'tasks', taskId, 'task.md'),
    ['# fixture', '', '<!-- TASK-META', JSON.stringify(meta, null, 2), '-->', ''].join('\n'),
  );
  return root;
}

/**
 * Кэш сессий хоста: одна запись cwd на сессию, в форме, которую читает
 * readSessionCwd (record.rows.workingDirectory.val.path). Каталог пустой —
 * cwd сессии неизвестен, гейт обязан вести себя как раньше.
 */
function sessionCache(entries) {
  const dir = tempDir('pg-0342-cache-');
  for (const [sessionId, cwd] of Object.entries(entries)) {
    fs.writeFileSync(
      path.join(dir, sessionId + '.json'),
      JSON.stringify({ record: { rows: { workingDirectory: { val: { path: cwd } } } } }, null, 2) + '\n',
    );
  }
  return dir;
}

/** Рантайм хоста: два объявленных корня, журнал прогонов в своём сторе. */
function runtimeFor(roots, store, cacheDir) {
  const runtime = createGraphRuntime({ roots, structureDir: 'structure', runsDir: path.join(store, 'runs') });
  runtime.sessionCacheDir = cacheDir;
  return runtime;
}

/** Связать сессию с узлом так же, как это делает project_graph_spawn. */
function bindSession(runtime, root, node, sessionId) {
  noteRun(runtime, { root, node, state: 'done', since: Date.now() - 60000, childId: sessionId });
}

/** Вызов write через хук: root — currentRoot хоста (чужой проект). */
async function gate({ runtime, root, sessionId, args }) {
  let called = 0;
  const decision = await handlePreExecute({
    exec: { name: 'write', arguments: args, agent: { id: sessionId } },
    next: async () => { called += 1; return { kind: 'allow' }; },
    runtime,
    root,
  });
  return { decision, called };
}

/* ------------------------------------------------------------------ */
/* 1. Относительный путь с cwd сессии находит задание ТОГО проекта     */
/* ------------------------------------------------------------------ */

await test('0342: относительный путь с cwd сессии разрешён заданием её проекта', async () => {
  await withStore(async (store) => {
    resetStructurePolicyState();
    const foreign = project({ taskId: FOREIGN_TASK, allowedPaths: ['lib/only-a.js'] });
    const own = project({ taskId: SESSION_TASK, allowedPaths: ['lib/x.js'] });
    const cache = sessionCache({ [WORKER_SESSION]: own });
    const runtime = runtimeFor([foreign, own], store, cache);
    bindSession(runtime, own, 'worker', WORKER_SESSION);

    /* Хост передаёт currentRoot чужого проекта — как в живом случае 0341. */
    const { decision, called } = await gate({
      runtime, root: foreign, sessionId: WORKER_SESSION, args: { file_path: 'lib/x.js' },
    });
    assert.equal(called, 1, 'запись относительным путём отклонена: cwd сессии не участвует в выборе корня');
    assert.equal(decision.kind, 'allow', 'решение не allow: ' + decision.reason);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Без cwd сессии — прежнее поведение: корень рантайма              */
/* ------------------------------------------------------------------ */

await test('0342: без cwd сессии относительный путь резолвится как раньше — от корня рантайма', async () => {
  await withStore(async (store) => {
    resetStructurePolicyState();
    const foreign = project({ taskId: FOREIGN_TASK, allowedPaths: ['lib/only-a.js'] });
    const own = project({ taskId: SESSION_TASK, allowedPaths: ['lib/x.js'] });
    /* Кэш сессий пуст: cwd неизвестен. */
    const runtime = runtimeFor([foreign, own], store, sessionCache({}));
    bindSession(runtime, own, 'worker', WORKER_SESSION);

    const { decision, called } = await gate({
      runtime, root: foreign, sessionId: WORKER_SESSION, args: { file_path: 'lib/x.js' },
    });
    assert.equal(called, 0, 'без cwd запись прошла: прежнее поведение не сохранено');
    assert.equal(decision.kind, 'deny', 'без cwd относительный путь не отклонён');
    assert.ok(String(decision.reason).includes(FOREIGN_TASK),
      'отказ не назвал задание корня рантайма: ' + decision.reason);
    assert.equal(String(decision.reason).includes(SESSION_TASK), false,
      'без cwd решение взяло задание проекта сессии: ' + decision.reason);
    assert.equal(readAlternatives({ root: foreign }).length, 1, 'решение записано не в журнал корня рантайма');
  });
});

/* ------------------------------------------------------------------ */
/* 3. Абсолютный путь — то же решение и то же обоснование              */
/* ------------------------------------------------------------------ */

await test('0342: абсолютный и относительный путь к одному файлу дают одно решение', async () => {
  await withStore(async (store) => {
    resetStructurePolicyState();
    const foreign = project({ taskId: FOREIGN_TASK, allowedPaths: ['lib/only-a.js'] });
    const own = project({ taskId: SESSION_TASK, allowedPaths: ['lib/x.js'] });
    const cache = sessionCache({ [WORKER_SESSION]: own, [JUDGE_SESSION]: own });
    const runtime = runtimeFor([foreign, own], store, cache);
    bindSession(runtime, own, 'worker', WORKER_SESSION);
    bindSession(runtime, own, 'judge', JUDGE_SESSION);

    /* Allow-ветка: оба написания проходят. */
    const relativeAllow = await gate({
      runtime, root: foreign, sessionId: WORKER_SESSION, args: { file_path: 'lib/x.js' },
    });
    const absoluteAllow = await gate({
      runtime, root: foreign, sessionId: WORKER_SESSION,
      args: { file_path: path.join(own, 'lib', 'x.js') },
    });
    assert.equal(relativeAllow.decision.kind, 'allow', 'относительный allow не прошёл');
    assert.equal(absoluteAllow.decision.kind, 'allow', 'абсолютный allow не прошёл');
    assert.equal(relativeAllow.called + absoluteAllow.called, 2, 'allow не дошёл до downstream');

    /* Deny-ветка: путь вне allowedPaths — одинаковое решение и текст. */
    resetStructurePolicyState();
    const relativeDeny = await gate({
      runtime, root: foreign, sessionId: WORKER_SESSION, args: { file_path: 'lib/other.js' },
    });
    resetStructurePolicyState();
    const absoluteDeny = await gate({
      runtime, root: foreign, sessionId: WORKER_SESSION,
      args: { file_path: path.join(own, 'lib', 'other.js') },
    });
    assert.equal(relativeDeny.decision.kind, 'deny', 'относительный путь вне allowedPaths не отклонён');
    assert.equal(absoluteDeny.decision.kind, 'deny', 'абсолютный путь вне allowedPaths не отклонён');
    assert.equal(relativeDeny.called + absoluteDeny.called, 0, 'отказ дошёл до downstream');
    assert.equal(relativeDeny.decision.reason, absoluteDeny.decision.reason,
      'обоснование зависит от записи пути: ' + relativeDeny.decision.reason + ' <> ' + absoluteDeny.decision.reason);
    assert.ok(String(relativeDeny.decision.reason).includes('lib/other.js'),
      'отказ не назвал путь: ' + relativeDeny.decision.reason);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Гейт не ослаблен: structure/**, неизвестная сессия, роль          */
/* ------------------------------------------------------------------ */

await test('0342: cwd сессии не ослабляет structure/**, unknown-session и роль', async () => {
  await withStore(async (store) => {
    resetStructurePolicyState();
    const foreign = project({ taskId: FOREIGN_TASK, allowedPaths: ['lib/only-a.js'] });
    const own = project({ taskId: SESSION_TASK, allowedPaths: ['lib/x.js', 'structure/graph.json'] });
    /*
     * cwd известен и у «неизвестной» сессии: каталог — не идентичность, роль
     * по-прежнему берётся из журнала прогонов, поэтому unknown-session остаётся.
     */
    const cache = sessionCache({
      [WORKER_SESSION]: own, [JUDGE_SESSION]: own, 'session-0342-unknown': own,
    });
    const runtime = runtimeFor([foreign, own], store, cache);
    bindSession(runtime, own, 'worker', WORKER_SESSION);
    bindSession(runtime, own, 'judge', JUDGE_SESSION);

    const structure = await gate({
      runtime, root: foreign, sessionId: WORKER_SESSION, args: { file_path: 'structure/graph.json' },
    });
    assert.equal(structure.decision.kind, 'deny', 'structure/** перестал быть отказом');
    assert.match(structure.decision.reason, /structure-owner-only/u, 'structure-отказ потерял принадлежность');

    const unknown = await gate({
      runtime, root: foreign, sessionId: 'session-0342-unknown', args: { file_path: 'lib/x.js' },
    });
    assert.equal(unknown.decision.kind, 'deny', 'неизвестная сессия пишет код через cwd');
    assert.match(unknown.decision.reason, /неизвестная сессия/u,
      'unknown-session потерял рецепт: ' + unknown.decision.reason);
    assert.ok(
      readAlternatives({ root: own }).some((event) => String(event.detail).startsWith('unknown-session:')),
      'журнал не записал токен unknown-session',
    );

    const judge = await gate({
      runtime, root: foreign, sessionId: JUDGE_SESSION, args: { file_path: 'lib/x.js' },
    });
    assert.equal(judge.decision.kind, 'deny', 'приёмщик пишет продуктовый код через cwd');
    assert.match(judge.decision.reason, /приёмщик/u, 'роль-отказ потерял роль: ' + judge.decision.reason);
  });
});

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  for (const failure of failures) {
    const detail = failure.error && failure.error.stack ? failure.error.stack : String(failure.error);
    console.error('FAIL: ' + failure.name + '\n' + detail);
  }
  console.error('STRUCTURE POLICY RELATIVE TEST FAILED (structure-policy-relative): '
    + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('STRUCTURE POLICY RELATIVE TEST OK: ' + passed + '/' + passed);
