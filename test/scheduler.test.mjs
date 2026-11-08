/**
 * 0110: одно окно расписания делает две попытки, вторая — на запасной модели.
 *
 * Проверяются два слоя: чистые решения (scheduleAttemptModel / shouldRetrySchedule) и
 * проводка ретрая в createScheduler. Служба субагентов и часы подставные, поэтому тест
 * не зависит от DSH, таймера и живого провайдера: окно отрабатывает в фиксированном
 * времени, а «мёртвая» модель — это фейк, который отвечает пустым текстом.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime } from '../lib/api.js';
import { listRuns } from '../lib/runs.js';
import {
  DEFAULT_FALLBACK_MODEL,
  SCHEDULE_MAX_ATTEMPTS,
  createScheduler,
  scheduleAttemptModel,
  shouldRetrySchedule,
} from '../lib/scheduler.js';

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

const at = (value) => new Date(value);
const FIRST = '2026-11-06T08:00:00+03:00';
const WINDOW = '2026-11-06T09:00:10+03:00';
const REPORT_BODY = [
  '## Итог дня',
  'узлы работали, критик собрал спеку дня',
  '',
  '## Риски',
  '- нет',
  '',
  '## Что делать дальше',
  '- держать расписание',
  '',
  '## Чего не хватило',
  '- нет',
].join('\n');

function makeProject(graph) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scheduler-0110-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  return dir;
}

function makeRuntime(dir) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scheduler-0110-runs-'));
  return createGraphRuntime({ roots: [dir], runsDir });
}

function activation(childId, text) {
  return {
    childId,
    result: Promise.resolve({
      output: text ? [{ type: 'text', text }] : [],
      stopReason: 'stop',
    }),
    dispose: async () => {},
  };
}

function rejectedActivation(childId, message) {
  return {
    childId,
    result: Promise.resolve().then(() => {
      throw new Error(message);
    }),
    dispose: async () => {},
  };
}

function makeSubagents(options = {}) {
  const calls = [];
  return {
    calls,
    getProvider(name) {
      if (options.provider === null) return undefined;
      return options.provider || { name, capabilities: { agentOptions: true } };
    },
    resolveMaxDepth(configured) {
      return configured === undefined ? 1 : configured;
    },
    async startActivation(spec) {
      calls.push(spec);
      if (options.onStart) return options.onStart(spec, calls);
      return activation('sched-' + calls.length, REPORT_BODY);
    },
  };
}

function scheduledGraph(overrides = {}) {
  return {
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [
      { id: 'coordinator', role: 'координатор', model: 'work' },
      {
        id: 'critic',
        role: 'критик',
        model: 'work',
        brief: 'разбирает итоги дня',
        schedule: { at: '09:00', timeZone: 'Europe/Moscow' },
        ...overrides,
      },
    ],
    edges: [{ from: 'critic', to: 'coordinator', kind: 'report' }],
  };
}

function makeScheduler(runtime, subagents, extra = {}) {
  return createScheduler({
    runtime,
    getSubagents: () => subagents,
    getParent: () => ({ id: 'parent-1' }),
    now: () => at(FIRST),
    ...extra,
  });
}

function scheduleRuns(runtime, dir) {
  return listRuns(runtime, dir).filter((run) => run && run.node === 'critic' && run.kind === 'schedule');
}

function criticCalls(subagents) {
  return subagents.calls.filter((call) => String((call && call.label) || '').startsWith('критик:'));
}

async function waitFor(check, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('условие не наступило за ' + timeoutMs + ' мс');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ---------- чистые решения ---------- */

await test('константы: потолок 2 попытки, запасная модель glm-5.3-flash', () => {
  assert.equal(SCHEDULE_MAX_ATTEMPTS, 2);
  assert.equal(DEFAULT_FALLBACK_MODEL, 'glm-5.3-flash');
});

await test('scheduleAttemptModel: 1-я попытка — модель узла, 2-я — запасная и никогда та же', () => {
  const qwen = { id: 'critic', model: 'qwen3.8-flash' };
  assert.equal(scheduleAttemptModel(qwen, 1), 'qwen3.8-flash', 'первая попытка — объявленная модель');
  assert.equal(scheduleAttemptModel(qwen, 2), DEFAULT_FALLBACK_MODEL, 'вторая — запасная константа');
  assert.notEqual(scheduleAttemptModel(qwen, 2), qwen.model, 'повтор не на той же мёртвой модели');
  /* Явная запасная модель узла важнее константы. */
  assert.equal(
    scheduleAttemptModel({ model: 'qwen3.8-flash', fallbackModel: 'deepseek-v4.1-flash' }, 2),
    'deepseek-v4.1-flash',
    'fallbackModel узла прочитан',
  );
  /* Запасная совпала с моделью узла — берём третью: повтор той же бессмыслен. */
  assert.equal(scheduleAttemptModel({ model: 'glm-5.3-flash' }, 2), 'deepseek-v4.1-flash');
  /* И наоборот: модель узла уже deepseek — запасной становится константа. */
  assert.equal(scheduleAttemptModel({ model: 'deepseek-v4.1-flash' }, 2), DEFAULT_FALLBACK_MODEL);
  /* Потолок не меняет выбор модели: третьей попытки не будет, но ответ предсказуем. */
  assert.equal(scheduleAttemptModel(qwen, 3), DEFAULT_FALLBACK_MODEL);
  /* Пустое объявление не бросает: функция чистая. */
  assert.equal(scheduleAttemptModel(null, 1), '');
  assert.equal(scheduleAttemptModel({}, 2), DEFAULT_FALLBACK_MODEL);
  assert.equal(scheduleAttemptModel({ model: '  qwen3.8-flash  ' }, 1), 'qwen3.8-flash', 'пробелы срезаны');
});

await test('shouldRetrySchedule: попытка 1 — да, попытка 2 — нет', () => {
  assert.equal(shouldRetrySchedule(1), true, 'после первого падения окно повторяется');
  assert.equal(shouldRetrySchedule(2), false, 'после второго — потолок');
  assert.equal(shouldRetrySchedule(3), false, 'третьей попытки нет даже в запросе');
});

/* ---------- проводка ретрая в планировщик ---------- */

await test('планировщик: успешная первая попытка не повторяется', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = makeScheduler(runtime, subagents);

  await scheduler.tick(at(FIRST));
  const launched = await scheduler.tick(at(WINDOW));
  assert.equal(launched.length, 1, 'окно запущено один раз');
  assert.equal(launched[0].attempt, 1);
  assert.equal(launched[0].model, 'deepseek-v4.1-flash');

  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.some((run) => run.state === 'done') ? list : null;
  });
  assert.equal(criticCalls(subagents).length, 1, 'второй попытки не было');
  const done = runs.find((run) => run.state === 'done');
  assert.equal(done.attempt, 1);
  assert.equal(done.model, 'deepseek-v4.1-flash');
  assert.equal(runs.filter((run) => run.state === 'error').length, 0, 'ошибок нет');
});

await test('планировщик: пустой ответ первой модели — повтор на запасной в том же окне', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  let scheduled = 0;
  const subagents = makeSubagents({
    onStart(spec) {
      if (!String((spec && spec.label) || '').startsWith('критик:')) return activation('delivery-1', '');
      scheduled += 1;
      /* Живой случай 06.11: модель умирает за 577 мс, текста нет. */
      if (scheduled === 1) return activation('attempt-1', '');
      return activation('attempt-2', REPORT_BODY);
    },
  });
  const log = [];
  const scheduler = makeScheduler(runtime, subagents, { logger: { warn: (line) => log.push(line) } });

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));

  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.some((run) => run.state === 'done') ? list : null;
  });
  const calls = criticCalls(subagents);
  assert.equal(calls.length, 2, 'окно сделало ровно две попытки');
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'opencode', model: 'deepseek-v4.1-flash' });
  assert.deepEqual(calls[1].request.agentOptions, { provider: 'opencode', model: 'glm-5.3-flash' },
    'вторая попытка — на запасной модели, не на той же');
  assert.equal(calls[1].request.cwd, path.resolve(dir), 'повтор идёт в том же воркспейсе');
  assert.equal(calls[1].delivery, 'caller', 'повтор — такой же запуск узла');
  assert.match(calls[1].request.prompt[0].text, /без отчёта/u,
    'запасная модель видит причину падения первой');

  const failed = runs.find((run) => run.state === 'error');
  const done = runs.find((run) => run.state === 'done');
  assert.ok(failed && done, 'в журнале и падение, и успех: ' + JSON.stringify(runs.map((run) => ({ state: run.state, attempt: run.attempt }))));
  assert.equal(failed.attempt, 1);
  assert.equal(failed.model, 'deepseek-v4.1-flash', 'первое падение записано с моделью');
  assert.match(failed.message, /без отчёта/u);
  assert.equal(done.attempt, 2);
  assert.equal(done.model, 'glm-5.3-flash', 'успех записан с моделью повторной попытки');
  assert.equal(done.report, 'docs/critic/2026-11-06.md');
  assert.deepEqual(done.awake, ['coordinator'], 'отчёт доставлен адресату');
  assert.ok(failed.since < done.since, 'у каждой попытки своя запись: падение не затёрто');
  assert.ok(fs.existsSync(path.join(dir, 'docs', 'critic', '2026-11-06.md')), 'отчёт записан на диск');
  assert.ok(log.some((line) => /повтор на модели glm-5\.3-flash/u.test(line)),
    'повтор назван в журнале хоста: ' + log.join(' | '));

  /* Окно уже отработало: следующий тик в ту же минуту ничего не запускает. */
  assert.deepEqual(await scheduler.tick(at('2026-11-06T09:01:00+03:00')), []);
  assert.equal(criticCalls(subagents).length, 2, 'третьего запуска нет');
});

await test('планировщик: второе падение — error как раньше, третьей попытки нет', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents({
    onStart(spec) {
      if (!String((spec && spec.label) || '').startsWith('критик:')) return activation('delivery-1', '');
      return activation('attempt-' + (criticCalls(subagents).length), '');
    },
  });
  const scheduler = makeScheduler(runtime, subagents);

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));

  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.length >= 2 && list.every((run) => run.state === 'error') ? list : null;
  });
  assert.equal(runs.length, 2, 'в журнале две попытки, не больше');
  assert.equal(criticCalls(subagents).length, 2, 'потолок попыток соблюдён');
  const attempts = runs.map((run) => run.attempt).sort();
  assert.deepEqual(attempts, [1, 2], 'обе попытки названы номером');
  for (const run of runs) assert.match(run.message, /без отчёта/u, 'второе падение — прежняя честная ошибка');
  const second = runs.find((run) => run.attempt === 2);
  assert.equal(second.model, 'glm-5.3-flash');

  assert.deepEqual(await scheduler.tick(at('2026-11-06T09:02:00+03:00')), []);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(criticCalls(subagents).length, 2, 'догона и третьей попытки нет');
});

await test('планировщик: если модель узла — сама запасная, повтор идёт на deepseek-v4.1-flash', async () => {
  const dir = makeProject({
    version: 1,
    models: {},
    nodes: [{
      id: 'critic',
      role: 'критик',
      provider: 'opencode',
      model: 'glm-5.3-flash',
      schedule: { at: '09:00', timeZone: 'Europe/Moscow' },
    }],
  });
  const runtime = makeRuntime(dir);
  let scheduled = 0;
  const subagents = makeSubagents({
    onStart(spec) {
      if (!String((spec && spec.label) || '').startsWith('критик:')) return activation('delivery-1', '');
      scheduled += 1;
      return scheduled === 1 ? activation('attempt-1', '') : activation('attempt-2', REPORT_BODY);
    },
  });
  const scheduler = makeScheduler(runtime, subagents);

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));
  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.some((run) => run.state === 'done') ? list : null;
  });
  const calls = criticCalls(subagents);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.agentOptions.model, 'glm-5.3-flash');
  assert.equal(calls[1].request.agentOptions.model, 'deepseek-v4.1-flash',
    'запасная совпала с моделью узла — выбрана третья');
  assert.equal(runs.find((run) => run.state === 'done').model, 'deepseek-v4.1-flash');
});

await test('планировщик: упавший прогон (отказ активации) тоже повторяется на запасной', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  let scheduled = 0;
  const subagents = makeSubagents({
    onStart(spec) {
      if (!String((spec && spec.label) || '').startsWith('критик:')) return activation('delivery-1', '');
      scheduled += 1;
      return scheduled === 1
        ? rejectedActivation('attempt-1', 'модель не ответила')
        : activation('attempt-2', REPORT_BODY);
    },
  });
  const scheduler = makeScheduler(runtime, subagents);

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));
  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.some((run) => run.state === 'done') ? list : null;
  });
  const calls = criticCalls(subagents);
  assert.equal(calls.length, 2, 'отказ активации — тоже повод для второй попытки');
  assert.equal(calls[1].request.agentOptions.model, 'glm-5.3-flash');
  const failed = runs.find((run) => run.state === 'error');
  assert.equal(failed.attempt, 1);
  assert.match(failed.message, /модель не ответила/u);
  assert.equal(runs.find((run) => run.state === 'done').attempt, 2);
});

await test('планировщик: отчёт записан, но не доставлен — повтор модель не зовёт', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents({
    onStart(spec) {
      if (String((spec && spec.label) || '').startsWith('доставка:')) {
        throw new Error('адресат недоступен');
      }
      return activation('attempt-1', REPORT_BODY);
    },
  });
  const scheduler = makeScheduler(runtime, subagents);

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));
  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.some((run) => run.state === 'error' && run.report) ? list : null;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(criticCalls(subagents).length, 1,
    'модель уже ответила и отчёт записан: второй прогон не нужен');
  const run = runs.find((item) => item.state === 'error' && item.report);
  assert.equal(run.attempt, 1);
  assert.equal(run.model, 'deepseek-v4.1-flash');
  assert.match(run.message, /адресат не поднят/u, 'причина названа доставкой, а не моделью');
});

/*
 * Задание 0132: закрытие прогона — повод сверить ack с ящиком.
 *
 * Сверка вызывается для корня закрытого прогона; её падение не имеет права
 * сделать удачный прогон ошибочным. Сверка подменена шпионом: фактическая
 * семантика ack проверена в test/exchange-watch.test.mjs, здесь — проводка.
 */
await test('0132: после закрытия прогона планировщик сверяет ack, падение сверки не валит запуск', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const calls = [];
  const log = [];
  const scheduler = makeScheduler(runtime, subagents, {
    logger: { warn: (line) => log.push(line) },
    reconcile({ runtime: passedRuntime, root: passedRoot }) {
      calls.push({ runtime: passedRuntime, root: passedRoot });
      throw new Error('сверка умерла');
    },
  });

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));
  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.some((run) => run.state === 'done') ? list : null;
  });
  const done = runs.find((run) => run.state === 'done');
  assert.equal(done.state, 'done', 'падение сверки не превратило удачный прогон в ошибку');
  assert.ok(!done.message, 'причина ошибки не выдумана');
  assert.ok(calls.length > 0, 'сверка вызвана при закрытии прогона');
  const own = calls.find((call) => call.root === dir);
  assert.ok(own, 'сверка назвала корень закрытого прогона: ' + JSON.stringify(calls));
  assert.equal(own.runtime, runtime, 'сверка получила runtime панели');
  assert.ok(log.some((line) => /сверка ack/u.test(line)), 'падение сверки названо в журнале: ' + log.join(' | '));
});

await test('0132: прогон, закрытый ошибкой, тоже сверяет ack', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents({
    onStart(spec) {
      if (!String((spec && spec.label) || '').startsWith('критик:')) return activation('delivery-1', '');
      return activation('attempt-' + (criticCalls(subagents).length), '');
    },
  });
  const roots = [];
  const scheduler = makeScheduler(runtime, subagents, {
    reconcile({ root: passedRoot }) { roots.push(passedRoot); },
  });

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));
  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.length >= 2 && list.every((run) => run.state === 'error') ? list : null;
  });
  assert.equal(runs.length, 2);
  assert.ok(roots.filter((root) => root === dir).length >= 2, 'каждое закрытие прогона сверило свой корень');
});

for (const failure of failures) {
  console.error('FAIL ' + failure.name + ': ' + (failure.error && failure.error.message));
}
if (failures.length > 0) {
  console.error('SCHEDULER TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('SCHEDULER TEST OK: ' + passed + '/' + passed);
