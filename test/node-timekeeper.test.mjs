/**
 * 0344: таймкипер — класс узла, монитор периодов останова, состояние по времени
 * и активации планировщика.
 *
 * Время в тесте — фейковые часы: каждый шаг получает Date, собранный из локальных
 * компонентов, поэтому проверка не зависит от часового пояса машины и не спит.
 * Сеть, DSH и LLM не нужны: живая сессия координатора — фейк с followup, служба
 * субагентов — счётчик, который обязан остаться пустым (таймкипер не тратит прогон).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime } from '../lib/api.js';
import { buildGraph } from '../lib/graph.js';
import { validateStructure } from '../lib/structure-validator.js';
import { NODE_CAPABILITIES, NODE_CLASSES, nodeClassOf } from '../lib/node-classes.js';
import { monitorEntryForModel, monitorStateAt } from '../lib/schedule.js';
import { timekeeperNotice } from '../lib/agent-message.js';
import { createScheduler } from '../lib/scheduler.js';

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

const COORDINATOR = Object.freeze({
  id: 'coordinator',
  role: 'координатор',
  provider: 'opencode',
  model: 'deepseek-v4.1-flash',
});

function keeper(monitor, extra = {}) {
  return { id: 'keeper', role: 'тайм-менеджер', ...(monitor === undefined ? {} : { monitor }), ...extra };
}

function build(graph) {
  return buildGraph([{ name: 'graph.json', text: JSON.stringify(graph) }], { dirName: 'structure' });
}

function errorsOf(graph) {
  return build(graph).errors;
}

function makeProject(graph) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-timekeeper-0344-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  return dir;
}

function makeRuntime(dir) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-timekeeper-0344-runs-'));
  return createGraphRuntime({ roots: [dir], runsDir });
}

/** Фейковая живая сессия координатора: письмо попадает в журнал, не в хост. */
function coordinatorAgent(label, cwd) {
  return {
    label,
    cwd,
    messages: [],
    followup(message) {
      this.messages.push(message);
    },
  };
}

function makeScheduler(dir, agent) {
  const subagentCalls = [];
  const scheduler = createScheduler({
    runtime: makeRuntime(dir),
    getAgents: () => ({ roots: () => (agent ? [agent] : []) }),
    getSubagents: () => ({
      calls: subagentCalls,
      getProvider: (name) => ({ name, capabilities: { agentOptions: true } }),
      async startActivation(spec) {
        subagentCalls.push(spec);
        return { childId: 'unexpected-' + subagentCalls.length, result: Promise.resolve({ output: [] }) };
      },
    }),
    getParent: () => ({ id: 'parent-1' }),
    now: () => new Date(2026, 10, 6, 8, 0),
  });
  return { scheduler, subagentCalls };
}

/** Локальное «сегодня» в заданный момент: пояс машины, как у ручных периодов. */
const localAt = (hour, minute, day = 6) => new Date(2026, 10, day, hour, minute);

const PERIOD = Object.freeze({ start: '09:00', end: '13:00', leadMinutes: 30 });
const MONITOR = Object.freeze([{ provider: 'opencode', model: 'deepseek-v4.1-flash', periods: [PERIOD] }]);

/* ---------- 1. класс узла ---------- */

await test('C1.1 класс timekeeper: подпись «Тайм-менеджер», без кода/ревью/приёмки', () => {
  const klass = NODE_CLASSES.timekeeper;
  assert.ok(klass, 'класс timekeeper есть в реестре');
  assert.equal(klass.id, 'timekeeper');
  assert.equal(klass.title, 'Тайм-менеджер');
  assert.equal(klass.kind, 'timekeeper');
  for (const capability of NODE_CAPABILITIES) {
    assert.equal(klass.capabilities[capability], false, 'возможность ' + capability + ' у таймкипера false');
  }
  assert.equal(klass.capabilities.writeProductCode, false);
  assert.equal(klass.capabilities.review, false);
  assert.equal(klass.capabilities.accept, false);
});

await test('C1.2 класс выводится по роли; класс вне реестра остаётся ошибкой', () => {
  assert.equal(nodeClassOf({ role: 'тайм-менеджер' }).classId, 'timekeeper');
  assert.equal(nodeClassOf({ role: 'таймкипер' }).classId, 'timekeeper');
  assert.equal(nodeClassOf({ role: 'Тайм-менеджер' }).classId, 'timekeeper');
  assert.equal(nodeClassOf({ role: 'timekeeper' }).classId, 'timekeeper');
  const unknown = nodeClassOf({ role: 'погромист' });
  assert.equal(unknown.ok, false, 'роль вне реестра — по-прежнему отказ');
  assert.equal(unknown.reason, 'unknown-role');
});

/* ---------- 2. monitor: валидация и структура ---------- */

await test('C1.3 узел с class timekeeper и monitor валиден; узел без monitor валиден', () => {
  const built = build({ version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
  assert.deepEqual(built.errors, [], 'сборка без ошибок: ' + built.errors.map((item) => item.code + ': ' + item.message).join(' | '));
  const checked = validateStructure(built.graph);
  assert.equal(checked.ok, true, 'структура ok: ' + checked.findings.map((item) => item.code + ': ' + item.message).join(' | '));
  assert.equal(checked.findings.some((item) => item.code === 'no-acceptor'), false, 'таймкиперу приёмщик не нужен');

  const plan = build({ version: 1, nodes: [COORDINATOR, keeper(undefined)] });
  assert.deepEqual(plan.errors, [], 'узел без monitor валиден');
  assert.equal(validateStructure(plan.graph).ok, true);
  assert.equal(validateStructure(build({ version: 1, nodes: [COORDINATOR, keeper([])] }).graph).ok, true, 'пустой monitor валиден');
});

function monitorError(monitor) {
  const errors = errorsOf({ version: 1, nodes: [COORDINATOR, keeper(monitor)] });
  return errors.map((item) => item.code + ': ' + item.message).join('\n');
}

await test('C1.4 ошибки монитора названы словами: start/end HH:MM, end позже start', () => {
  assert.match(monitorError([{ provider: 'opencode', model: 'm', periods: [{ start: '9:00', end: '13:00', leadMinutes: 30 }] }]),
    /start.*HH:MM/u);
  assert.match(monitorError([{ provider: 'opencode', model: 'm', periods: [{ start: '09:00', end: '13:0', leadMinutes: 30 }] }]),
    /end.*HH:MM/u);
  assert.match(monitorError([{ provider: 'opencode', model: 'm', periods: [{ start: '13:00', end: '09:00', leadMinutes: 30 }] }]),
    /end.*позже.*start/u);
});

await test('C1.5 ошибки монитора: leadMinutes 0..720, provider/model непустые', () => {
  assert.match(monitorError([{ provider: 'opencode', model: 'm', periods: [{ start: '09:00', end: '13:00', leadMinutes: 721 }] }]),
    /leadMinutes.*0\.\.720/u);
  assert.match(monitorError([{ provider: 'opencode', model: 'm', periods: [{ start: '09:00', end: '13:00', leadMinutes: 1.5 }] }]),
    /leadMinutes.*0\.\.720/u);
  assert.match(monitorError([{ provider: '', model: 'm', periods: [] }]), /provider/u);
  assert.match(monitorError([{ provider: 'opencode', model: '   ', periods: [] }]), /model/u);
});

await test('C1.6 ошибки монитора: дубликат provider+model и пересечение периодов', () => {
  assert.match(monitorError([
    { provider: 'opencode', model: 'm', periods: [] },
    { provider: 'opencode', model: 'm', periods: [] },
  ]), /provider.*model.*дважды|дважды.*provider/u);
  assert.match(monitorError([{
    provider: 'opencode',
    model: 'm',
    periods: [
      { start: '09:00', end: '13:00', leadMinutes: 30 },
      { start: '12:00', end: '14:00', leadMinutes: 10 },
    ],
  }]), /пересек/iu);
});

/* ---------- 3. чистая функция состояния ---------- */

await test('C1.7 warn за leadMinutes, start ровно в момент начала, inside, idle', () => {
  const record = { provider: 'opencode', model: 'deepseek-v4.1-flash', periods: [PERIOD] };
  const before = monitorStateAt(record, localAt(7, 0));
  assert.equal(before.state, 'idle', 'до окна предупреждения — idle');
  assert.equal(before.minutesLeft, null);
  assert.equal(before.nextActivation.getTime(), localAt(8, 30).getTime(), 'ближайшая активация — 08:30');

  const warn = monitorStateAt(record, localAt(8, 30));
  assert.equal(warn.state, 'warn');
  assert.equal(warn.minutesLeft, 30, 'осталось 30 минут');
  assert.deepEqual(warn.period, PERIOD);
  assert.equal(warn.activationAt.getTime(), localAt(8, 30).getTime());
  assert.equal(warn.nextActivation.getTime(), localAt(9, 0).getTime(), 'после предупреждения — начало');

  const later = monitorStateAt(record, localAt(8, 45));
  assert.equal(later.state, 'warn');
  assert.equal(later.minutesLeft, 15);

  const start = monitorStateAt(record, localAt(9, 0));
  assert.equal(start.state, 'start', 'ровно в start — начало останова');
  assert.equal(start.activationAt.getTime(), localAt(9, 0).getTime());
  assert.equal(start.nextActivation.getTime() > start.activationAt.getTime(), true, 'следующая активация — позже');

  const inside = monitorStateAt(record, localAt(9, 2));
  assert.equal(inside.state, 'inside');
  assert.equal(inside.minutesLeft, null);

  const after = monitorStateAt(record, localAt(14, 0));
  assert.equal(after.state, 'idle');
  assert.equal(after.nextActivation.getTime(), localAt(8, 30, 7).getTime(), 'следующее окно — завтра 08:30');
});

await test('C1.8 leadMinutes=0: единственная активация — start; период без предупреждения', () => {
  const record = { provider: 'p', model: 'm', periods: [{ start: '09:00', end: '10:00', leadMinutes: 0 }] };
  assert.equal(monitorStateAt(record, localAt(8, 59)).state, 'idle');
  assert.equal(monitorStateAt(record, localAt(9, 0)).state, 'start');
  assert.equal(monitorStateAt(record, localAt(9, 30)).state, 'inside');
  const idle = monitorStateAt(record, localAt(8, 0));
  assert.equal(idle.nextActivation.getTime(), localAt(9, 0).getTime(), 'ближайшая активация — сам start');
});

await test('C1.9 выбор записи монитора по модели координатора', () => {
  const monitor = [
    { provider: 'opencode', model: 'deepseek-v4.1-flash', periods: [PERIOD] },
    { provider: 'opencode', model: 'glm-5.3-flash', periods: [{ start: '18:00', end: '19:00', leadMinutes: 5 }] },
  ];
  assert.deepEqual(monitorEntryForModel(monitor, 'opencode', 'glm-5.3-flash'), monitor[1]);
  assert.equal(monitorEntryForModel(monitor, 'opencode', 'нет-такой'), null, 'чужой модели — молчание');
  assert.equal(monitorEntryForModel(monitor, 'other', 'deepseek-v4.1-flash'), null, 'провайдер тоже часть пары');
});

/* ---------- 4. сообщение и активации планировщика ---------- */

await test('C1.10 текст сообщения: warn и start', () => {
  const record = { provider: 'p', model: 'm', periods: [PERIOD] };
  const warn = monitorStateAt(record, localAt(8, 30));
  assert.equal(timekeeperNotice(warn), 'останов с 09:00 до 13:00, осталось 30 минут');
  const start = monitorStateAt(record, localAt(9, 0));
  assert.equal(timekeeperNotice(start), 'останов включён с 09:00 до 13:00');
  assert.equal(timekeeperNotice(monitorStateAt(record, localAt(7, 0))), '', 'вне окон — пустой текст');
  assert.equal(timekeeperNotice(monitorStateAt(record, localAt(9, 2))), '', 'внутри останова повторного письма нет');
});

await test('C1.11 совпадение модели: ровно одно сообщение на warn, одно на start, дублей нет', async () => {
  const dir = makeProject({ version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
  const agent = coordinatorAgent('координатор: главный', dir);
  const { scheduler, subagentCalls } = makeScheduler(dir, agent);

  await scheduler.tick(localAt(7, 0));
  assert.equal(agent.messages.length, 0, 'вне окна — узел не активируется');

  const warn = await scheduler.tick(localAt(8, 30));
  assert.equal(agent.messages.length, 1, 'предупреждение отправлено один раз');
  assert.equal(agent.messages[0].content[0].text, 'останов с 09:00 до 13:00, осталось 30 минут');
  assert.equal(warn.length, 1, 'активация названа в ответе тика');

  await scheduler.tick(localAt(8, 31));
  await scheduler.tick(localAt(8, 45));
  assert.equal(agent.messages.length, 1, 'повтор той же активации не дублируется');

  await scheduler.tick(localAt(9, 0));
  assert.equal(agent.messages.length, 2, 'начало останова — второе сообщение');
  assert.equal(agent.messages[1].content[0].text, 'останов включён с 09:00 до 13:00');

  await scheduler.tick(localAt(9, 0));
  await scheduler.tick(localAt(9, 2));
  assert.equal(agent.messages.length, 2, 'start и inside повторно не уведомляются');

  await scheduler.tick(localAt(8, 30, 7));
  assert.equal(agent.messages.length, 3, 'следующий день — новая активация, не дубль');

  assert.equal(subagentCalls.length, 0, 'таймкипер не тратит прогон на LLM');
});

await test('C1.12 модель координатора не в мониторе: ни одного сообщения', async () => {
  const dir = makeProject({
    version: 1,
    nodes: [
      { ...COORDINATOR, model: 'glm-5.3-flash' },
      keeper(MONITOR),
    ],
  });
  const agent = coordinatorAgent('координатор: главный', dir);
  const { scheduler } = makeScheduler(dir, agent);
  await scheduler.tick(localAt(8, 30));
  await scheduler.tick(localAt(9, 0));
  assert.equal(agent.messages.length, 0, 'модели нет в мониторе — узел молчит');
});

await test('C1.13 нет живой сессии координатора: сообщение не выдумывается', async () => {
  const dir = makeProject({ version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
  const { scheduler } = makeScheduler(dir, null);
  const launched = await scheduler.tick(localAt(8, 30));
  assert.deepEqual(launched, [], 'доставлять некуда — активация не засчитана');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)));
}
console.log('NODE-TIMEKEEPER TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
