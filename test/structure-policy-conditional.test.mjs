/**
 * Задание 0330: условные ворота worker/reviewer.
 *
 * Набор держит обещания задания:
 *   1) unknown-session не пишет продуктовый путь только тогда, когда в графе
 *      есть класс worker; без worker-класса ворота not-applicable и запись в
 *      allowedPaths активного задания разрешена;
 *   2) acceptanceDecision: класс reviewer в графе — обязательны объявленный
 *      reviewer/reviewerNode, accepted review.json и совпадение квитанции
 *      review.receipt.json (artifactSha256 = sha256(review.json)); без класса
 *      reviewer — allow/notApplicable;
 *   3) process gate приёмки: команда task-accept с --task проверяется до запуска,
 *      --help и команды без --task не ломаются;
 *   4) ошибка чтения графа/задания не блокирует (fail-open).
 *
 * Журнал решений живёт во временном хранилище: в ~/.dsh ничего не пишется.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acceptanceDecision, detectAcceptInvocation, handlePreExecute,
  hasNodeClass, readAlternatives, resetStructurePolicyState, writeDecision,
} from '../lib/structure-policy.js';

const TASK_ID = '0001';

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
  const store = tempDir('pg-0330-store-');
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

/** Граф с классами worker/reviewer по флагам; приёмщик есть всегда. */
function graphOf({ worker = true, reviewer = true } = {}) {
  const nodes = [{ id: 'coordinator', role: 'координатор' }];
  if (worker) nodes.push({ id: 'worker-1', role: 'исполнитель' });
  if (reviewer) nodes.push({ id: 'reviewer-1', role: 'ревьюер' });
  nodes.push({ id: 'judge-1', role: 'приёмщик' });
  return { version: 1, nodes, edges: [], folders: [] };
}

/**
 * Временный проект: структура, общий блок workflow (fail) и задание 0001.
 * reviewer в TASK-META добавляется только когда он есть в графе — как в 0330.
 */
function project({ worker = true, reviewer = true, graphText, config = true } = {}) {
  const root = tempDir('pg-0330-root-');
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'),
    graphText === undefined ? JSON.stringify(graphOf({ worker, reviewer }), null, 2) + '\n' : graphText);
  if (config) {
    fs.mkdirSync(path.join(root, 'docs', 'subagent-workflow'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'subagent-workflow', 'workflow.config.json'),
      JSON.stringify({ version: 1, enforcement: { structurePolicy: 'fail', writePolicy: 'fail', processPolicy: 'fail' } }, null, 2) + '\n');
  }
  const dir = path.join(root, 'docs', 'tasks', TASK_ID);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id: TASK_ID,
    version: 1,
    title: 'fixture 0330',
    executor: 'subagent:worker-1',
    acceptor: 'subagent:judge-1',
    allowedPaths: ['lib/**'],
  };
  if (reviewer) {
    meta.reviewer = 'subagent:reviewer-1';
    meta.reviewerNode = 'reviewer-1';
  }
  fs.writeFileSync(path.join(dir, 'task.md'),
    '# fixture\n\n<!-- TASK-META\n' + JSON.stringify(meta, null, 2) + '\n-->\n');
  fs.writeFileSync(path.join(dir, 'criteria.lock'), '{}');
  return { root, dir };
}

/** review.json + квитанция движка: правильные байты и sha256. */
function writeReview({ dir, decision = 'accepted', reviewer = 'reviewer-1', tamper = false } = {}) {
  const text = JSON.stringify({
    version: 1,
    task: TASK_ID,
    reviewer,
    decision,
    verdict: decision === 'accepted' ? 'ok' : 'issues',
    summary: 'fixture',
    remarks: [],
    notJudged: [],
    checks: [],
  }, null, 2) + '\n';
  fs.writeFileSync(path.join(dir, 'review.json'), text);
  fs.writeFileSync(path.join(dir, 'review.receipt.json'), JSON.stringify({
    artifactSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    reviewer,
    decision,
  }, null, 2) + '\n');
  if (tamper) fs.appendFileSync(path.join(dir, 'review.json'), ' ');
}

/** Команда приёмки в форме, в которой её запускает движок. */
function acceptCommand(task = 'docs/tasks/' + TASK_ID) {
  return 'node docs/subagent-workflow/scripts/task-accept.mjs --task ' + task;
}

/* ------------------------------------------------------------------ */
/* 1. hasNodeClass: класс по реестру, а не по строке роли              */
/* ------------------------------------------------------------------ */

await test('0330: hasNodeClass — worker/reviewer есть и нет; понятие класса из реестра 0311', async () => {
  const both = project({ worker: true, reviewer: true }).root;
  assert.equal(hasNodeClass(both, 'worker'), true, 'worker не найден при роли «исполнитель»');
  assert.equal(hasNodeClass(both, 'reviewer'), true, 'reviewer не найден при роли «ревьюер»');
  const noWorker = project({ worker: false, reviewer: true }).root;
  assert.equal(hasNodeClass(noWorker, 'worker'), false, 'worker найден там, где его нет');
  const noReviewer = project({ worker: true, reviewer: false }).root;
  assert.equal(hasNodeClass(noReviewer, 'reviewer'), false, 'reviewer найден там, где его нет');
  assert.equal(hasNodeClass(noReviewer, 'nonsense'), false, 'неизвестный класс не выводится');
});

/* ------------------------------------------------------------------ */
/* 2. Условный unknown-session: worker есть — deny, нет — allow         */
/* ------------------------------------------------------------------ */

await test('0330: unknown-session + lib — deny при классе worker, allow без него (not-applicable)', async () => {
  const withWorker = project({ worker: true, reviewer: false }).root;
  const denied = writeDecision({ root: withWorker, path: 'lib/x.js', sessionId: 'sess-unknown' });
  assert.equal(denied.allow, false, 'при worker-классе неизвестная сессия записала код');
  assert.equal(denied.unknownSession, true, 'решение не помечено unknownSession');
  assert.ok(String(denied.reason).startsWith('unknown-session:'), 'причина без токена unknown-session');
  assert.equal(denied.mode, 'fail');

  const noWorker = project({ worker: false, reviewer: false }).root;
  const allowed = writeDecision({ root: noWorker, path: 'lib/x.js', sessionId: 'sess-unknown' });
  assert.equal(allowed.allow, true, 'без worker-класса запись заблокирована: ' + allowed.reason);
  assert.equal(allowed.notApplicable, true, 'allow не помечен notApplicable');
  assert.equal(allowed.unknownSession, undefined, 'not-applicable спутан с нарушением');
  assert.equal(allowed.task, TASK_ID, 'разрешающее задание не названо');
  assert.match(allowed.reason, /not-applicable/u);
  assert.match(allowed.reason, /worker/u);
});

await test('0330: write-хук — unknown-session проходит без worker-класса и отклоняется с ним', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const noWorker = project({ worker: false, reviewer: false }).root;
    let allowedCalled = 0;
    const allowed = await handlePreExecute({
      exec: { name: 'write', arguments: { file_path: 'lib/x.js' }, agent: { id: 'sess-unknown' } },
      next: async () => { allowedCalled += 1; return { kind: 'allow' }; },
      root: noWorker,
    });
    assert.equal(allowedCalled, 1, 'без worker-класса downstream не вызван');
    assert.equal(allowed.kind, 'allow', 'без worker-класса отказ: ' + JSON.stringify(allowed));

    resetStructurePolicyState();
    const withWorker = project({ worker: true, reviewer: false }).root;
    let deniedCalled = 0;
    const denied = await handlePreExecute({
      exec: { name: 'write', arguments: { file_path: 'lib/x.js' }, agent: { id: 'sess-unknown' } },
      next: async () => { deniedCalled += 1; return { kind: 'allow' }; },
      root: withWorker,
    });
    assert.equal(deniedCalled, 0, 'при worker-классе unknown-session дошла до downstream');
    assert.equal(denied.kind, 'deny');
    assert.match(denied.reason, /worker/u);
    assert.equal(readAlternatives({ root: withWorker }).length, 1, 'отказ не записан в журнал');
  });
});

/* ------------------------------------------------------------------ */
/* 3. acceptanceDecision: reviewer есть                                 */
/* ------------------------------------------------------------------ */

await test('0330: reviewer есть, review.json нет — deny reviewer-required', async () => {
  const p = project({ worker: true, reviewer: true });
  const decision = acceptanceDecision({ root: p.root, task: TASK_ID });
  assert.equal(decision.allow, false, 'приёмка без review.json разрешена: ' + JSON.stringify(decision));
  assert.equal(decision.reviewerRequired, true);
  assert.match(String(decision.reason), /reviewer-required/u);
  assert.match(String(decision.reason), /review/iu);
});

await test('0330: reviewer есть, но task не объявил reviewer — deny reviewer-required', async () => {
  const p = project({ worker: true, reviewer: true });
  const file = path.join(p.dir, 'task.md');
  const meta = { id: TASK_ID, executor: 'subagent:worker-1', acceptor: 'subagent:judge-1', allowedPaths: ['lib/**'] };
  fs.writeFileSync(file, '# fixture\n\n<!-- TASK-META\n' + JSON.stringify(meta, null, 2) + '\n-->\n');
  const decision = acceptanceDecision({ root: p.root, task: TASK_ID });
  assert.equal(decision.allow, false, 'task без reviewer принят');
  assert.match(String(decision.reason), /reviewer-required/u);
  assert.match(String(decision.reason), /reviewer/iu);
});

await test('0330: reviewer есть — rejected review, mismatch receipt и чужой reviewer отклоняются', async () => {
  const rejected = project({ worker: true, reviewer: true });
  writeReview({ dir: rejected.dir, decision: 'rejected' });
  const rejectedDecision = acceptanceDecision({ root: rejected.root, task: TASK_ID });
  assert.equal(rejectedDecision.allow, false, 'rejected review принят');
  assert.match(String(rejectedDecision.reason), /accepted/u);

  const tampered = project({ worker: true, reviewer: true });
  writeReview({ dir: tampered.dir, tamper: true });
  const tamperedDecision = acceptanceDecision({ root: tampered.root, task: TASK_ID });
  assert.equal(tamperedDecision.allow, false, 'review.json после квитанции принят');
  assert.match(String(tamperedDecision.reason), /artifactSha256|sha256/iu);

  const foreign = project({ worker: true, reviewer: true });
  writeReview({ dir: foreign.dir, reviewer: 'reviewer-9' });
  const foreignDecision = acceptanceDecision({ root: foreign.root, task: TASK_ID });
  assert.equal(foreignDecision.allow, false, 'review.json чужого ревьюера принят');
  assert.match(String(foreignDecision.reason), /reviewer-9|reviewer/iu);
});

await test('0330: reviewer есть — valid review.json + квитанция дают allow', async () => {
  const p = project({ worker: true, reviewer: true });
  writeReview({ dir: p.dir });
  const decision = acceptanceDecision({ root: p.root, task: TASK_ID });
  assert.equal(decision.allow, true, 'valid review+receipt не принят: ' + JSON.stringify(decision));
  assert.equal(decision.reviewerRequired, true);
  assert.equal(decision.reviewer, 'reviewer-1');
  assert.match(String(decision.reason), /ревью подтверждено/u);
});

/* ------------------------------------------------------------------ */
/* 4. acceptanceDecision: reviewer нет — not-applicable                 */
/* ------------------------------------------------------------------ */

await test('0330: reviewer нет — allow/notApplicable даже без review.json', async () => {
  const p = project({ worker: true, reviewer: false });
  const decision = acceptanceDecision({ root: p.root, task: TASK_ID });
  assert.equal(decision.allow, true, 'без reviewer-класса приёмка заблокирована: ' + JSON.stringify(decision));
  assert.equal(decision.notApplicable, true, 'allow не помечен notApplicable');
  assert.equal(decision.reviewerRequired, false);
  assert.match(String(decision.reason), /not-applicable/u);
});

await test('0330: task как путь и как id; ошибка чтения графа и ненайденное задание — fail-open', async () => {
  const byId = project({ worker: true, reviewer: false });
  assert.equal(acceptanceDecision({ root: byId.root, task: TASK_ID }).allow, true, 'task-id не разрешился');
  const byPath = project({ worker: true, reviewer: true });
  writeReview({ dir: byPath.dir });
  assert.equal(acceptanceDecision({ root: byPath.root, task: 'docs/tasks/' + TASK_ID }).allow, true,
    'task-путь не разрешился');

  const broken = project({ worker: true, reviewer: true, graphText: '{ broken json' });
  const brokenDecision = acceptanceDecision({ root: broken.root, task: TASK_ID });
  assert.equal(brokenDecision.allow, true, 'битый граф заблокировал приёмку');
  assert.ok(brokenDecision.error, 'причина fail-open не названа');

  const missing = project({ worker: true, reviewer: true });
  const missingDecision = acceptanceDecision({ root: missing.root, task: '9999' });
  assert.equal(missingDecision.allow, true, 'ненайденное задание заблокировало приёмку');
  assert.ok(missingDecision.error, 'ненайденное задание не названо причиной');
});

/* ------------------------------------------------------------------ */
/* 5. Process gate: task-accept проверяется до запуска                  */
/* ------------------------------------------------------------------ */

await test('0330: process gate — task-accept без review отклоняется до downstream, журнал denied', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const p = project({ worker: true, reviewer: true });
    let called = 0;
    const denied = await handlePreExecute({
      exec: { name: 'pwsh', arguments: { command: acceptCommand() } },
      next: async () => { called += 1; return { kind: 'allow' }; },
      root: p.root,
    });
    assert.equal(called, 0, 'task-accept запущен без review');
    assert.equal(denied.kind, 'deny', 'ворота приёмки не сработали: ' + JSON.stringify(denied));
    assert.match(String(denied.reason), /reviewer|review/iu);
    assert.equal(readAlternatives({ root: p.root }).length, 1, 'отказ приёмки не записан в журнал');
    const events = readAlternatives({ root: p.root });
    assert.equal(events[0].denied, true);
    assert.match(String(events[0].detail), /task-accept/u);
  });
});

await test('0330: process gate — --help и команда без --task не ломаются; явная справка разрешена', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const p = project({ worker: true, reviewer: true });
    let helpCalled = 0;
    const help = await handlePreExecute({
      exec: { name: 'pwsh', arguments: { command: acceptCommand() + ' --help' } },
      next: async () => { helpCalled += 1; return { kind: 'allow' }; },
      root: p.root,
    });
    assert.equal(helpCalled, 1, '--help отклонён воротами приёмки');
    assert.equal(help.kind, 'allow');

    let bareCalled = 0;
    const bare = await handlePreExecute({
      exec: { name: 'pwsh', arguments: { command: 'node docs/subagent-workflow/scripts/task-accept.mjs' } },
      next: async () => { bareCalled += 1; return { kind: 'allow' }; },
      root: p.root,
    });
    assert.equal(bareCalled, 1, 'вызов без --task отклонён');
    assert.equal(bare.kind, 'allow');

    let otherCalled = 0;
    const other = await handlePreExecute({
      exec: { name: 'pwsh', arguments: { command: 'node test/contract.test.mjs' } },
      next: async () => { otherCalled += 1; return { kind: 'allow' }; },
      root: p.root,
    });
    assert.equal(otherCalled, 1, 'чужая команда отклонена воротами приёмки');
    assert.equal(other.kind, 'allow');
  });
});

await test('0330: process gate — reviewer нет или review валиден — приёмка запускается', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const noReviewer = project({ worker: true, reviewer: false });
    let allowedCalled = 0;
    const allowed = await handlePreExecute({
      exec: { name: 'pwsh', arguments: { command: acceptCommand() } },
      next: async () => { allowedCalled += 1; return { kind: 'allow' }; },
      root: noReviewer.root,
    });
    assert.equal(allowedCalled, 1, 'без reviewer-класса приёмка остановлена');
    assert.equal(allowed.kind, 'allow');

    resetStructurePolicyState();
    const valid = project({ worker: true, reviewer: true });
    writeReview({ dir: valid.dir });
    let validCalled = 0;
    const validDecision = await handlePreExecute({
      exec: { name: 'pwsh', arguments: { command: acceptCommand() } },
      next: async () => { validCalled += 1; return { kind: 'allow' }; },
      root: valid.root,
    });
    assert.equal(validCalled, 1, 'valid review не пустил приёмку');
    assert.equal(validDecision.kind, 'allow');
  });
});

await test('0330: process gate — quoted pwsh -Command и --task=<путь> распознаны; битый граф не блокирует', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const p = project({ worker: true, reviewer: true });
    const quoted = 'pwsh -Command "node docs/subagent-workflow/scripts/task-accept.mjs --task docs/tasks/' + TASK_ID + '"';
    let quotedCalled = 0;
    const quotedDecision = await handlePreExecute({
      exec: { name: 'shell', arguments: { command: quoted } },
      next: async () => { quotedCalled += 1; return { kind: 'allow' }; },
      root: p.root,
    });
    assert.equal(quotedCalled, 0, 'task-accept в pwsh -Command обошёл ворота');
    assert.equal(quotedDecision.kind, 'deny');

    resetStructurePolicyState();
    const equal = project({ worker: true, reviewer: true });
    let equalCalled = 0;
    const equalDecision = await handlePreExecute({
      exec: { name: 'bash', arguments: { command: 'node docs/subagent-workflow/scripts/task-accept.mjs --task=docs/tasks/' + TASK_ID } },
      next: async () => { equalCalled += 1; return { kind: 'allow' }; },
      root: equal.root,
    });
    assert.equal(equalCalled, 0, '--task=<путь> обошёл ворота');
    assert.equal(equalDecision.kind, 'deny');

    resetStructurePolicyState();
    const broken = project({ worker: true, reviewer: true, graphText: '{ broken json' });
    let brokenCalled = 0;
    const brokenDecision = await handlePreExecute({
      exec: { name: 'pwsh', arguments: { command: acceptCommand() } },
      next: async () => { brokenCalled += 1; return { kind: 'allow' }; },
      root: broken.root,
    });
    assert.equal(brokenCalled, 1, 'битый граф заблокировал приёмку (fail-open нарушен)');
    assert.equal(brokenDecision.kind, 'allow');
  });
});

await test('0330: detectAcceptInvocation — позиция программы, help и отсутствие --task', async () => {
  assert.deepEqual(detectAcceptInvocation(acceptCommand()), { help: false, task: 'docs/tasks/' + TASK_ID });
  assert.deepEqual(detectAcceptInvocation('node scripts/task-accept.mjs --task=0001'), { help: false, task: '0001' });
  assert.deepEqual(detectAcceptInvocation('node scripts/task-accept.mjs --help'), { help: true, task: '' });
  assert.equal(detectAcceptInvocation('node scripts/task-accept.mjs')?.task, '');
  assert.equal(detectAcceptInvocation('git commit -m "task-accept.mjs --task docs/tasks/0001"'), null,
    'упоминание в сообщении коммита принято за приёмку');
  assert.deepEqual(
    detectAcceptInvocation('node scripts/task-accept.mjs --task docs/tasks/0001; node scripts/task-accept.mjs --help'),
    { help: false, task: 'docs/tasks/0001' },
    '--help в цепочке спрятал приёмку от гейта');
  assert.equal(detectAcceptInvocation('node test/contract.test.mjs'), null);
  assert.equal(detectAcceptInvocation(''), null);
});

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  for (const failure of failures) {
    const detail = failure.error && failure.error.stack ? failure.error.stack : String(failure.error);
    console.error('FAIL: ' + failure.name + '\n' + detail);
  }
  console.error('STRUCTURE POLICY CONDITIONAL TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('STRUCTURE POLICY CONDITIONAL TEST OK: ' + passed + '/' + passed);
