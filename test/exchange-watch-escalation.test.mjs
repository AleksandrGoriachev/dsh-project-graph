/**
 * 0341: эскалация непрочитанного answer.
 *
 * Поведение, а не реализация: письмо Status: answer, вручённое адресату и
 * оставшееся в памяти pending-read, через окно ожидания подаётся повторно;
 * число повторных подач ограничено; каждая видна в журнале решений веткой
 * delivered:escalation с номером попытки и названа в дайджесте по-русски.
 * Обработанное (markProcessed) и уже отмеченное seen письмо не эскалируется;
 * request идёт прежним путём.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWakeDigest, createExchangeWatcher, decisionsPath, readPendingRead,
} from '../lib/exchange-watch.js';
import { markExchangeSeen } from '../lib/obligations.js';

let passed = 0;
const failures = [];
async function atest(name, body) {
  try { await body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

const HEAD = (from, to, date, extra = '') => 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date
  + '\nThread: critic-report\nStatus: request\n' + extra + '\n';

/** Обмен на стенде: два воркспейса и общий ящик над ними. */
function host() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-escalation-'));
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
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-escalation-runs-'));
  return { allowedRoots: () => roots, exchange: [], participants: {}, me: null, runs: new Map(), runsDir };
}

/** Живая сессия адресата: запоминает, что ей вручили. */
function agent(id, cwd, label) {
  const inbox = [];
  return {
    id, sessionId: id, cwd, label,
    sendMessage: async (input) => { inbox.push(input.content?.[0]?.text); },
    inbox,
  };
}

function withTempStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-escalation-store-'));
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

function escalationRows(runtime) {
  return decisionsOf(runtime).filter((row) => String(row.branch || '') === 'delivered:escalation');
}

/** Стенд: answer в ящике, живая сессия адресата, сторож на временном складе. */
function stand() {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-escalation-seen-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  return { box, target, runtime, watcher };
}

const at = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60 * 1000);

/* ------------------------------------------------------------------------ */

await atest('0341 C1: необработанный answer подан повторно, предел 2, журнал несёт попытку', async () => {
  await withTempStore(async () => {
    const { box, target, runtime, watcher } = stand();
    const answer = path.join(box.thread, 'answer.md');
    fs.writeFileSync(answer, HEAD('structure', 'workflow', new Date().toISOString(), 'Status: answer\nSubject: ответ\n\nтекст\n'));
    await watcher.tick();
    assert.equal(target.inbox.length, 1, 'первое вручение состоялось');
    const pending = readPendingRead(runtime).find((item) => item.session === 's-workflow');
    assert.ok(pending, 'вручённый answer ждёт обработки (pending-read)');
    assert.doesNotMatch(target.inbox[0], /повторн/iu, 'первое вручение не выдаёт себя за повторное');

    /* Окно ожидания истекло, письмо не обработано — повторная подача №1. */
    await watcher.tick(at(31));
    assert.equal(target.inbox.length, 2, 'необработанный answer подан повторно после окна');
    assert.match(target.inbox[1], /повторн/iu, 'дайджест называет повторную подачу по-русски');
    assert.match(target.inbox[1], /1 из 2/u, 'дайджест называет номер попытки и предел');
    const rowsAfterFirst = escalationRows(runtime);
    assert.equal(rowsAfterFirst.length, 1, 'попытка №1 записана в журнал решений');
    assert.equal(rowsAfterFirst[0].attempt, 1, 'журнал несёт номер попытки');
    assert.equal(rowsAfterFirst[0].letter, 'threads/critic-report/answer.md', 'журнал называет письмо');
    assert.equal(rowsAfterFirst[0].state, 'delivered', 'эскалация — доставка, а не ожидание');
    const afterFirst = readPendingRead(runtime).find((item) => item.session === 's-workflow');
    assert.equal(afterFirst.attempts, 1, 'память pending-read помнит состоявшуюся попытку');
    assert.ok(Date.parse(afterFirst.at) > Date.parse(pending.at), 'следующее окно отсчитывается от последней попытки');

    /* Непосредственно после попытки окно ещё не истекло: повтора нет. */
    await watcher.tick(at(32));
    assert.equal(target.inbox.length, 2, 'в пределах нового окна повторной подачи нет');

    /* Второе окно истекло — повторная подача №2 (предел). */
    await watcher.tick(at(62));
    assert.equal(target.inbox.length, 3, 'вторая повторная подача состоялась');
    const rowsAfterSecond = escalationRows(runtime);
    assert.equal(rowsAfterSecond.length, 2, 'каждая повторная подача записана отдельно');
    assert.equal(rowsAfterSecond[1].attempt, 2, 'вторая попытка названа номером 2');

    /* Третьего окна быть не может: предел — прежний TTL-fallback, письмо закрыто. */
    await watcher.tick(at(93));
    assert.equal(target.inbox.length, 3, 'сверх предела повторной подачи нет');
    assert.equal(escalationRows(runtime).length, 2, 'число эскалаций конечно и равно пределу');
    assert.equal(readPendingRead(runtime).length, 0, 'после предела запись снята прежним TTL-fallback');
    const readMarks = JSON.parse(fs.readFileSync(path.join(process.env.DSH_PROJECT_GRAPH_STORE, 'exchange-seen.json'), 'utf8'));
    assert.ok(readMarks[path.resolve(answer)], 'после предела письмо закрыто как прочитанное');
  });
});

await atest('0341 C1: обработанное письмо (markProcessed) не эскалируется ни разу', async () => {
  await withTempStore(async () => {
    const { box, target, runtime, watcher } = stand();
    const answer = path.join(box.thread, 'processed-answer.md');
    fs.writeFileSync(answer, HEAD('structure', 'workflow', new Date().toISOString(), 'Status: answer\n\n'));
    await watcher.tick();
    assert.equal(target.inbox.length, 1, 'answer вручён');
    const marked = watcher.markProcessed('s-workflow');
    assert.ok(marked && marked.ok !== false, 'markProcessed: ' + JSON.stringify(marked));
    assert.equal(readPendingRead(runtime).length, 0, 'обработанное снято из памяти pending-read');
    await watcher.tick(at(31));
    assert.equal(target.inbox.length, 1, 'обработанное письмо не подаётся повторно');
    assert.equal(escalationRows(runtime).length, 0, 'эскалации обработанного нет');
  });
});

await atest('0341 C1: уже отмеченное seen письмо не эскалируется', async () => {
  await withTempStore(async () => {
    const { box, target, runtime, watcher } = stand();
    const answer = path.join(box.thread, 'seen-answer.md');
    fs.writeFileSync(answer, HEAD('structure', 'workflow', new Date().toISOString(), 'Status: answer\n\n'));
    await watcher.tick();
    assert.equal(target.inbox.length, 1, 'answer вручён');
    /* «Разобрал» поставлен независимо от pending-read: письмо отмечено seen. */
    markExchangeSeen({ root: box.workflow, path: answer });
    await watcher.tick(at(31));
    assert.equal(target.inbox.length, 1, 'seen-письмо не эскалируется');
    assert.equal(escalationRows(runtime).length, 0, 'эскалации seen-письма нет');
    assert.equal(readPendingRead(runtime).length, 0, 'запись снята прежним TTL-fallback');
  });
});

await atest('0341 C1: отказ лимита — skip:cooldown, попытка не расходуется и повторяется', async () => {
  await withTempStore(async () => {
    const box = host();
    const target = agent('s-workflow', box.workflow, 'workflow');
    const runtime = runtimeOf([box.structure, box.workflow]);
    const throttle = {
      mode: 'ok',
      allow: () => true,
      mark: () => {},
      fits() {
        return this.mode === 'deny'
          ? { allowed: false, cause: 'skip:cooldown', limit: 'box', waitMs: 120000 }
          : { allowed: true, cause: '', limit: '', waitMs: 0 };
      },
    };
    const watcher = createExchangeWatcher({
      runtime,
      seenPath: path.join(os.tmpdir(), 'pg-escalation-cooldown-' + Date.now() + '.json'),
      getAgents: () => ({ list: () => [target] }),
      activityOf: () => new Map([['s-workflow', Date.now()]]),
      wakeThrottle: throttle,
    });
    const answer = path.join(box.thread, 'answer.md');
    fs.writeFileSync(answer, HEAD('structure', 'workflow', new Date().toISOString(), 'Status: answer\n\n'));
    await watcher.tick();
    assert.equal(target.inbox.length, 1, 'первое вручение состоялось');
    throttle.mode = 'deny';
    await watcher.tick(at(31));
    assert.equal(target.inbox.length, 1, 'при отказе лимита повторной подачи нет');
    const cooldown = decisionsOf(runtime).filter((row) => String(row.branch || '') === 'skip:cooldown'
      && String(row.letter || '').endsWith('answer.md'));
    assert.equal(cooldown.length, 1, 'причина отказа названа: skip:cooldown');
    assert.equal(readPendingRead(runtime)[0].attempts || 0, 0, 'отказ лимита не израсходовал попытку');
    throttle.mode = 'ok';
    await watcher.tick(at(32));
    assert.equal(target.inbox.length, 2, 'следующий тик повторяет поданное');
    assert.equal(escalationRows(runtime)[0].attempt, 1, 'попытка всё ещё первая');
  });
});

await atest('0341 C1: request идёт прежним путём, без эскалации', async () => {
  await withTempStore(async () => {
    const { box, target, runtime, watcher } = stand();
    const request = path.join(box.thread, 'request.md');
    fs.writeFileSync(request, HEAD('structure', 'workflow', new Date().toISOString()));
    await watcher.tick();
    assert.equal(target.inbox.length, 1, 'request вручён');
    await watcher.tick(at(31));
    assert.equal(target.inbox.length, 1, 'request повторно не подаётся');
    assert.equal(escalationRows(runtime).length, 0, 'эскалация только для answer');
    assert.equal(readPendingRead(runtime).length, 0, 'запись request закрыта прежним TTL-fallback');
  });
});

await atest('0341 C1: дайджест называет повторную подачу и говорит, что письмо уже вручалось', () => {
  const text = buildWakeDigest([{
    path: 'threads/critic-report/answer.md',
    file: '/box/threads/critic-report/answer.md',
    from: 'structure',
    subject: 'ответ',
    status: 'answer',
    escalation: { attempt: 1, max: 2 },
  }]);
  assert.match(text, /повторн/iu, 'повторная подача названа по-русски');
  assert.match(text, /1 из 2/u, 'номер попытки и предел в дайджесте');
  assert.match(text, /уже вручал/iu, 'адресат видит, что письмо вручалось раньше');
  assert.match(text, /не было обработано|осталось необработанным/iu, 'и что оно не обработано');
  const normal = buildWakeDigest([{ path: 'a.md', from: 'structure', status: 'answer' }]);
  assert.doesNotMatch(normal, /повторн/iu, 'обычный дайджест про повтор не говорит');
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(String(failure.error && failure.error.stack ? failure.error.stack : failure.error));
  }
  console.error('EXCHANGE-WATCH ESCALATION TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('EXCHANGE-WATCH ESCALATION TEST OK: ' + passed + '/' + passed);
