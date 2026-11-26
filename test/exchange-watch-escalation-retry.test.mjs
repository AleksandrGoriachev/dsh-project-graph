/**
 * 0343: backoff неудачной эскалации и гонка с обработкой письма.
 *
 * Поведение, а не реализация. Фейковые часы сторожа: время двигает тест, sleep нет.
 *   C1-R6: отказ отправки эскалации — это попытка: счётчик растёт, повтор не
 *          раньше окна повтора (120 с, как у первого вручения), а не каждый тик.
 *   C1-R6: отказ лимита (skip:cooldown) попытку НЕ тратит и повторяется сразу.
 *   C1-R6: TTL закрывает записи без кандидата, даже если у сессии есть письмо
 *          в эскалации.
 *   C1-R1: письмо, обработанное (markProcessed/markExchangeSeen) во время
 *          отправки, не воскрешается в памяти и повторно не подаётся.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createExchangeWatcher, decisionsPath, readPendingRead,
} from '../lib/exchange-watch.js';
import { markExchangeSeen } from '../lib/obligations.js';

let passed = 0;
const failures = [];
async function atest(name, body) {
  try { await body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

const TTL_MS = 30 * 60 * 1000;
/* Окно повтора отказа — то же, что у первого вручения (RETRY_AFTER_MS). */
const RETRY_MS = 120 * 1000;

const HEAD = (from, to, status, extra = '') => 'From: ' + from + '\nTo: ' + to
  + '\nDate: ' + new Date().toISOString() + '\nThread: critic-report\nStatus: ' + status
  + '\nSubject: критик-отчёт\n' + extra + '\nтекст\n';

/* ------------------------------------------------------------------------ */
/* Фейковые часы: время двигает только тест, ни одного sleep.               */
let clockMs = Date.now();
const clockValue = () => new Date(clockMs);
const atTime = (ms) => { clockMs = ms; return new Date(clockMs); };
const resetClock = () => { clockMs = Date.now(); };

/** Обмен на стенде: два воркспейса и общий ящик над ними. */
function host() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-escalation-retry-'));
  const structure = path.join(parent, 'dsh-project-graph');
  const workflow = path.join(parent, 'default-workspace');
  fs.mkdirSync(structure, { recursive: true });
  fs.mkdirSync(workflow, { recursive: true });
  const box = path.join(parent, 'coordination');
  const thread = path.join(box, 'threads', 'critic-report');
  fs.mkdirSync(thread, { recursive: true });
  fs.writeFileSync(path.join(box, 'README.md'), [
    '# Канал',
    '',
    '| Сторона | Пространство | Что делает |',
    '| --- | --- | --- |',
    '| `workflow` | `' + workflow.replace(/\\/gu, '/') + '` | спека |',
    '| `structure` | `' + structure.replace(/\\/gu, '/') + '` | панель |',
    '',
  ].join('\n'));
  return { parent, structure, workflow, box, thread };
}

function runtimeOf(roots) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-escalation-retry-runs-'));
  return { allowedRoots: () => roots, exchange: [], participants: {}, me: null, runs: new Map(), runsDir };
}

/**
 * Живая сессия адресата. fail — отказ транспорта; onSend — то, что адресат
 * делает в момент получения письма (тест ставит там обработку).
 */
function agent(id, cwd, label) {
  const inbox = [];
  const handle = {
    id, sessionId: id, cwd, label, fail: false, onSend: null, inbox,
    async sendMessage(message) {
      if (handle.fail) throw new Error('канал адресата недоступен');
      if (handle.onSend) await handle.onSend();
      inbox.push(message && message.content && message.content[0] ? message.content[0].text : '');
      return { ok: true };
    },
  };
  return handle;
}

function withTempStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-escalation-retry-store-'));
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  return Promise.resolve(body(store)).finally(() => {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  });
}

function decisionsOf(runtime) {
  const file = decisionsPath(runtime);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function branchRows(runtime, branch) {
  return decisionsOf(runtime).filter((row) => String(row.branch || '') === branch);
}

function escalationRows(runtime) {
  return branchRows(runtime, 'delivered:escalation');
}

function pendingOf(runtime, session) {
  return readPendingRead(runtime).filter((entry) => entry.session === session);
}

function readMarks() {
  const file = path.join(process.env.DSH_PROJECT_GRAPH_STORE, 'exchange-seen.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

/** Стенд: сторож на тех же фейковых часах, что двигает тест. */
function stand(options = {}) {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-escalation-retry-seen-' + Date.now() + '-'
      + Math.random().toString(36).slice(2) + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', clockMs]]),
    now: () => new Date(clockMs),
    ...(options.wakeThrottle ? { wakeThrottle: options.wakeThrottle } : {}),
  });
  return { box, target, runtime, watcher };
}

/* ------------------------------------------------------------------------ */

await atest('0343 C1: неудачная эскалация учтена и повторяется не раньше окна повтора, TTL закрывает после предела', async () => {
  await withTempStore(async () => {
    resetClock();
    const { box, target, runtime, watcher } = stand();
    const answer = path.join(box.thread, 'answer.md');
    fs.writeFileSync(answer, HEAD('structure', 'workflow', 'answer'));
    await watcher.tick(clockValue());
    assert.equal(target.inbox.length, 1, 'первое вручение состоялось');
    const base = clockMs;
    const deliveredAt = pendingOf(runtime, 's-workflow')[0].at;
    assert.ok(deliveredAt, 'вручённый answer ждёт обработки');

    /* Адресат недоступен: окно ожидания истекло, первая попытка эскалации. */
    target.fail = true;
    await watcher.tick(atTime(base + TTL_MS + 60 * 1000));
    assert.equal(target.inbox.length, 1, 'при отказе отправки письма не было');
    const afterFail = pendingOf(runtime, 's-workflow')[0];
    assert.ok(afterFail, 'запись осталась ждать повтора');
    assert.equal(afterFail.attempts, 1, 'неудачная отправка учтена как попытка');
    assert.ok(Date.parse(afterFail.at) > Date.parse(deliveredAt),
      'время попытки обновлено — окно не отсчитывается от вручения');
    const fails1 = branchRows(runtime, 'no-session');
    assert.equal(fails1.length, 1, 'отказ отправки назван в журнале');
    assert.equal(fails1[0].attempt, 1, 'журнал называет номер попытки');

    /* Чуть меньше окна повтора: тик (4 с в жизни) не повторяет отказ. */
    await watcher.tick(atTime(base + TTL_MS + 60 * 1000 + RETRY_MS - 1000));
    assert.equal(branchRows(runtime, 'no-session').length, 1, 'в пределах окна повтора попытки нет');
    assert.equal(pendingOf(runtime, 's-workflow')[0].attempts, 1, 'счётчик попыток не вырос');

    /* Ровно окно повтора: вторая (предельная) попытка. */
    const secondAt = base + TTL_MS + 60 * 1000 + RETRY_MS;
    await watcher.tick(atTime(secondAt));
    assert.equal(branchRows(runtime, 'no-session').length, 2, 'после окна повтора попытка состоялась');
    assert.equal(branchRows(runtime, 'no-session')[1].attempt, 2, 'вторая попытка названа номером 2');
    assert.equal(pendingOf(runtime, 's-workflow')[0].attempts, 2, 'предел попыток достигнут');
    assert.equal(target.inbox.length, 1, 'ни одна попытка не стала вручением');

    /* Предел исчерпан: каждый тик больше не пытается. */
    await watcher.tick(atTime(secondAt + 4000));
    assert.equal(branchRows(runtime, 'no-session').length, 2, 'сверх предела попыток нет');

    /* TTL-fallback закрывает запись после исчерпания попыток. */
    await watcher.tick(atTime(secondAt + TTL_MS + 60 * 1000));
    assert.equal(readPendingRead(runtime).length, 0, 'после предела запись снята прежним TTL-fallback');
    assert.ok(readMarks()[path.resolve(answer)], 'письмо закрыто как прочитанное');
  });
});

await atest('0343 C1: отказ лимита (skip:cooldown) попытку не тратит и повторяется следующим тиком', async () => {
  await withTempStore(async () => {
    resetClock();
    const throttle = {
      mode: 'ok',
      allow: () => true,
      mark: () => {},
      fits() {
        return this.mode === 'deny'
          ? { allowed: false, cause: 'skip:cooldown', limit: 'box', waitMs: RETRY_MS }
          : { allowed: true, cause: '', limit: '', waitMs: 0 };
      },
    };
    const { box, target, runtime, watcher } = stand({ wakeThrottle: throttle });
    const answer = path.join(box.thread, 'answer.md');
    fs.writeFileSync(answer, HEAD('structure', 'workflow', 'answer'));
    await watcher.tick(clockValue());
    assert.equal(target.inbox.length, 1, 'первое вручение состоялось');
    const base = clockMs;

    throttle.mode = 'deny';
    await watcher.tick(atTime(base + TTL_MS + 60 * 1000));
    assert.equal(target.inbox.length, 1, 'при отказе лимита повторной подачи нет');
    assert.equal(branchRows(runtime, 'skip:cooldown').length, 1, 'причина отказа названа: skip:cooldown');
    const denied = pendingOf(runtime, 's-workflow')[0];
    assert.equal(denied.attempts || 0, 0, 'отказ лимита не израсходовал попытку');
    assert.ok(!denied.retryAt, 'отказ лимита не назначает окно повтора');

    throttle.mode = 'ok';
    await watcher.tick(atTime(base + TTL_MS + 60 * 1000 + 4000));
    assert.equal(target.inbox.length, 2, 'следующий тик повторяет поданное');
    assert.equal(escalationRows(runtime)[0].attempt, 1, 'попытка всё ещё первая');
    assert.equal(pendingOf(runtime, 's-workflow')[0].attempts, 1, 'успешная подача учтена');
  });
});

await atest('0343 C1: TTL закрывает записи без кандидата, даже если у сессии есть письмо в эскалации', async () => {
  await withTempStore(async () => {
    resetClock();
    const { box, target, runtime, watcher } = stand();
    const answer = path.join(box.thread, 'answer.md');
    const request = path.join(box.thread, 'request.md');
    fs.writeFileSync(answer, HEAD('structure', 'workflow', 'answer'));
    fs.writeFileSync(request, HEAD('structure', 'workflow', 'request'));
    await watcher.tick(clockValue());
    assert.equal(target.inbox.length, 1, 'оба письма вручены одной пачкой');
    const base = clockMs;
    const before = pendingOf(runtime, 's-workflow');
    assert.ok(before.some((entry) => entry.letter === path.resolve(answer)), 'answer ждёт обработки');
    assert.ok(before.some((entry) => entry.letter === path.resolve(request)), 'request ждёт обработки');

    await watcher.tick(atTime(base + TTL_MS + 60 * 1000));
    assert.equal(target.inbox.length, 2, 'answer подан повторно после окна');
    assert.equal(escalationRows(runtime).length, 1, 'эскалация answer записана');
    const after = pendingOf(runtime, 's-workflow');
    assert.equal(after.length, 1, 'запись без кандидата закрыта TTL, запись в эскалации осталась');
    assert.equal(after[0].letter, path.resolve(answer), 'осталась именно запись-letter в эскалации');
    assert.equal(after[0].attempts, 1, 'попытка эскалации учтена');
    assert.ok(readMarks()[path.resolve(request)], 'request закрыт как прочитанный');
    assert.ok(!readMarks()[path.resolve(answer)], 'answer не отмечен прочитанным — он в эскалации');
  });
});

await atest('0343 C1: письмо, обработанное (markProcessed) во время отправки, не воскрешается', async () => {
  await withTempStore(async () => {
    resetClock();
    const { box, target, runtime, watcher } = stand();
    const answer = path.join(box.thread, 'answer.md');
    fs.writeFileSync(answer, HEAD('structure', 'workflow', 'answer'));
    await watcher.tick(clockValue());
    assert.equal(target.inbox.length, 1, 'первое вручение состоялось');
    const base = clockMs;

    /* Адресат завершает ход ровно в момент повторной отправки: запись снимается. */
    target.onSend = async () => {
      const marked = watcher.markProcessed('s-workflow');
      assert.ok(marked && marked.ok !== false, 'markProcessed: ' + JSON.stringify(marked));
    };
    await watcher.tick(atTime(base + TTL_MS + 60 * 1000));
    assert.equal(target.inbox.length, 2, 'повторная подача состоялась');
    assert.equal(readPendingRead(runtime).length, 0, 'обработанное письмо не воскрешено в памяти');
    assert.ok(readMarks()[path.resolve(answer)], 'письмо отмечено прочитанным');

    /* Следующий тик не подаёт письмо второй раз. */
    await watcher.tick(atTime(base + TTL_MS + 60 * 1000 + 4000));
    assert.equal(target.inbox.length, 2, 'обработанное письмо повторно не подаётся');
    assert.equal(escalationRows(runtime).length, 1, 'вторая эскалация не состоялась');
  });
});

await atest('0343 C1: письмо, отмеченное seen во время отправки, не пишется обратно', async () => {
  await withTempStore(async () => {
    resetClock();
    const { box, target, runtime, watcher } = stand();
    const answer = path.join(box.thread, 'answer.md');
    fs.writeFileSync(answer, HEAD('structure', 'workflow', 'answer'));
    await watcher.tick(clockValue());
    assert.equal(target.inbox.length, 1, 'первое вручение состоялось');
    const base = clockMs;

    /* Отметка прочтения поставлена, но запись pending-read снята не была. */
    target.onSend = async () => {
      markExchangeSeen({ root: box.workflow, path: answer });
    };
    await watcher.tick(atTime(base + TTL_MS + 60 * 1000));
    assert.equal(target.inbox.length, 2, 'повторная подача состоялась');
    assert.equal(readPendingRead(runtime).length, 0, 'seen-запись не пишется обратно в память');

    await watcher.tick(atTime(base + TTL_MS + 60 * 1000 + 4000));
    assert.equal(target.inbox.length, 2, 'seen-письмо повторно не подаётся');
  });
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(String(failure.error && failure.error.stack ? failure.error.stack : failure.error));
  }
  console.error('EXCHANGE-WATCH ESCALATION RETRY TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('EXCHANGE-WATCH ESCALATION RETRY TEST OK: ' + passed + '/' + passed);
