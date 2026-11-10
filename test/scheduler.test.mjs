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
  buildSchedulePrompt,
  createScheduler,
  extractReportBody,
  scheduleAttemptModel,
  shouldRetrySchedule,
  validateCriticReport,
  writeTesterReport,
} from '../lib/scheduler.js';
import { isTesterNode } from '../lib/critic-spec.js';

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

/* ---------- 0178: формат отчёта критика по телу ---------- */

await test('0178 validateCriticReport: корректный отчёт — четыре раздела в порядке', () => {
  const r = validateCriticReport(REPORT_BODY);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.errors, [], 'причин отказа нет');
  assert.deepEqual(r.sections, ['Итог дня', 'Риски', 'Что делать дальше', 'Чего не хватило']);
});

await test('0178 validateCriticReport: дубль раздела — отказ с причиной', () => {
  const r = validateCriticReport(REPORT_BODY + '\n\n## Итог дня\nПовтор отчёта.');
  assert.equal(r.ok, false, 'отчёт, склеенный дважды, — не отчёт');
  assert.ok(r.errors.some((error) => /дубль/u.test(error)), 'причина названа дублем: ' + JSON.stringify(r.errors));
  assert.equal(r.sections.filter((name) => name === 'Итог дня').length, 2, 'дубль виден в sections');
});

await test('0178 validateCriticReport: пятый раздел после четвёртого — отказ', () => {
  const r = validateCriticReport(REPORT_BODY + '\n\n## Пятый раздел\nЛишнее.');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((error) => /лишний раздел после четвёртого/u.test(error)), JSON.stringify(r.errors));
});

await test('0178 validateCriticReport: пустое тело, пустой раздел и не тот первый — отказ', () => {
  const empty = validateCriticReport('   \n\n');
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.sections, []);

  const emptySection = validateCriticReport(REPORT_BODY.replace('## Риски\n- нет', '## Риски\n   '));
  assert.equal(emptySection.ok, false);
  assert.ok(emptySection.errors.some((error) => /пустое тело раздела «Риски»/u.test(error)),
    JSON.stringify(emptySection.errors));

  const wrongFirst = validateCriticReport(REPORT_BODY.replace('## Итог дня', '## Риски'));
  assert.equal(wrongFirst.ok, false);
  assert.ok(wrongFirst.errors.some((error) => /первый раздел/u.test(error)), JSON.stringify(wrongFirst.errors));
});

await test('0178 validateCriticReport: живой отчёт 2026-11-09 с двумя «Итог дня» отвергнут', () => {
  const live = new URL('../docs/critic/2026-11-09.md', import.meta.url);
  const text = fs.readFileSync(live, 'utf8');
  const r = validateCriticReport(text);
  assert.equal(r.ok, false, 'живой файл с повтором отчёта получает отказ');
  assert.ok(r.sections.filter((name) => name === 'Итог дня').length >= 2, 'в файле два «Итог дня»');
});

await test('0178 планировщик: отчёт с дублем раздела — error с причиной, не done', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const doubled = REPORT_BODY + '\n\n## Итог дня\nПовтор отчёта.';
  const subagents = makeSubagents({
    onStart(spec) {
      if (!String((spec && spec.label) || '').startsWith('критик:')) return activation('delivery-1', '');
      return activation('attempt-' + (criticCalls(subagents).length), doubled);
    },
  });
  const scheduler = makeScheduler(runtime, subagents);

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));
  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.length >= 2 && list.every((run) => run.state === 'error') ? list : null;
  });
  assert.ok(runs.every((run) => /дубль/u.test(String(run.message || ''))),
    'каждый отказ называет дубль: ' + JSON.stringify(runs.map((run) => run.message)));
  const refused = runs[0];
  assert.match(refused.message, /формат отчёта нарушен/u, 'причина — формат, а не доставка');
  assert.ok(!runs.some((run) => run.state === 'done'), 'ни один прогон не закрыт done');
  assert.ok(!runs.some((run) => run.report), 'отчёт не записан');
  assert.ok(!fs.existsSync(path.join(dir, 'docs', 'critic', '2026-11-06.md')), 'файл отчёта не появился');
  assert.equal(criticCalls(subagents).length, 2, 'окно сделало две попытки, обе отвергнуты');
  assert.deepEqual(await scheduler.tick(at('2026-11-06T09:02:00+03:00')), []);
});

/* ---------- 0196: строгое тело и проверка доставленного письма ---------- */

await test('0196 extractReportBody: тело начинается строго с «## Итог дня», шапка письма допустима', () => {
  assert.equal(extractReportBody(REPORT_BODY), REPORT_BODY, 'прямой отчёт — тело целиком');
  const header = [
    'From: critic',
    'To: coordinator',
    'Date: 2026-11-06T09:00:00+03:00',
    'Thread: critic-report',
    'Status: report',
    'Subject: отчёт critic за 2026-11-06',
    'Ref: threads/critic-report/a.md',
    'Session: s-critic',
    'Box: coordination',
    'Workspace: default-workspace',
    'Node: critic',
    'Participants: coordinator',
    '',
  ].join('\n');
  assert.equal(extractReportBody(header + REPORT_BODY), REPORT_BODY, 'шапка письма — не тело отчёта');
  assert.equal(extractReportBody('\n\n   ' + header + REPORT_BODY), REPORT_BODY, 'ведущие пустые строки пропущены');
  assert.equal(extractReportBody(header), '', 'одна шапка без отчёта — пустое тело');
  assert.equal(extractReportBody('  ## Итог дня\n' + REPORT_BODY.replace('## Итог дня\n', '')), REPORT_BODY,
    'пробелы по краям заголовка допустимы');
});

await test('0196 extractReportBody: рассуждение, нумерация, проза и «# Итог дня» — пустое тело', () => {
  const cases = [
    ['заголовок-рассуждение', '## План\nсначала проверю обмен\n\n'],
    ['нумерованный пункт', '1. Проверяю обмен\n\n'],
    ['проза', 'Сейчас напишу отчёт.\n\n'],
    ['одинарный #', '# Итог дня\n'],
  ];
  for (const [name, prefix] of cases) {
    assert.equal(extractReportBody(prefix + REPORT_BODY), '', name + ': это не отчёт');
  }
  /* Живая форма 10.11 01:32: рассуждение с номером и заголовками, отчёт в конце. */
  const liveShape = '1. Сначала проверяю обмен\n' + 'Рассуждение. '.repeat(300) + '\n\n' + REPORT_BODY;
  assert.equal(extractReportBody(liveShape), '', 'живой артефакт не принят за тело');
  assert.equal(extractReportBody(''), '');
  assert.equal(extractReportBody('   \n\n'), '');
});

await test('0196 планировщик: длинный отчёт не влезает в письмо — error с причиной, письма нет', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const longBody = [
    '## Итог дня', 'а'.repeat(1600), '',
    '## Риски', 'б'.repeat(1600), '',
    '## Что делать дальше', 'в'.repeat(1600), '',
    '## Чего не хватило', 'г'.repeat(400),
  ].join('\n');
  const subagents = makeSubagents({
    onStart(spec) {
      if (String((spec && spec.label) || '').startsWith('доставка:')) return activation('delivery-1', '');
      return activation('attempt-' + criticCalls(subagents).length, longBody);
    },
  });
  const scheduler = makeScheduler(runtime, subagents);

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));
  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.some((run) => run.state === 'error') ? list : null;
  });
  const failed = runs.find((run) => run.state === 'error');
  assert.match(String(failed.message), /раздел/u, 'причина называет разделы');
  assert.match(String(failed.message), /предел/u, 'причина называет предел письма');
  assert.equal(failed.report, 'docs/critic/2026-11-06.md', 'файл отчёта остаётся свидетельством');
  assert.ok(!failed.delivered, 'письмо не отправлено');
  assert.ok(!runs.some((run) => run.state === 'done'), 'прогон не закрыт done');
  assert.equal(criticCalls(subagents).length, 1, 'отчёт записан — повтор модель не зовёт');
});

await test('0196 планировщик: короткий отчёт — done, письмо несёт все четыре заголовка', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = makeScheduler(runtime, subagents);

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));
  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.some((run) => run.state === 'done') ? list : null;
  });
  const done = runs.find((run) => run.state === 'done');
  assert.equal(done.report, 'docs/critic/2026-11-06.md');
  assert.ok(done.delivered, 'письмо записано');
  const letter = fs.readFileSync(path.join(path.dirname(dir), 'coordination', done.delivered), 'utf8');
  for (const section of ['## Итог дня', '## Риски', '## Что делать дальше', '## Чего не хватило']) {
    assert.ok(letter.includes(section), 'письмо несёт раздел ' + section);
  }
  assert.ok(!/обрезано/u.test(letter), 'короткий отчёт не обрезан');
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


/* ---------- 0195: планировщик запускает не-критика по его спеке ---------- */

const TESTER_TEXT = [
  'Прогон полного набора',
  '- node tools/test.mjs: exit 0',
  '- первое падение: нет',
  'Вердикт: pass',
].join('\n');

const TESTER_SPEC = [
  'Роль: тестировщик — независимый прогон, код не правит.',
  'Прогони полный набор: node tools/test.mjs; при EPERM — NODE_OPTIONS=--require docs/tasks/0194/pipe-capture.cjs.',
  'Definition of Done: вердикт pass|fail, первое падение названо.',
].join('\n');

function testerGraph(overrides = {}) {
  return {
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [
      { id: 'coordinator', role: 'координатор', model: 'work' },
      {
        id: 'tester-1',
        role: 'тестировщик',
        model: 'work',
        brief: 'независимый полный прогон',
        prompt: TESTER_SPEC,
        schedule: { at: '09:00', timeZone: 'Europe/Moscow' },
        ...overrides,
      },
    ],
    edges: [{ from: 'tester-1', to: 'coordinator', kind: 'report' }],
  };
}

function testerRuns(runtime, dir) {
  return listRuns(runtime, dir).filter((run) => run && run.node === 'tester-1' && run.kind === 'schedule');
}

function testerCalls(subagents) {
  return subagents.calls.filter((call) => String((call && call.label) || '').startsWith('тестировщик:'));
}

await test('0195 isTesterNode: узнаёт тестировщика по id и роли, критика не трогает', () => {
  assert.equal(isTesterNode({ id: 'tester-1' }), true);
  assert.equal(isTesterNode({ id: 'Tester' }), true, 'регистр не важен');
  assert.equal(isTesterNode({ id: 't-1', role: 'тестировщик' }), true, 'роль по-русски');
  assert.equal(isTesterNode({ id: 't-2', role: 'Tester' }), true, 'роль по-английски');
  assert.equal(isTesterNode({ id: 'critic', role: 'критик' }), false, 'критик — не тестировщик');
  assert.equal(isTesterNode({ id: 'worker-1', role: 'исполнитель' }), false);
  assert.equal(isTesterNode(null), false);
  assert.equal(isTesterNode('tester-1'), false, 'не объект — не узел');
});

await test('0195: плановый прогон тестировщика — своя спека, docs/tester, report координатору, done', async () => {
  const dir = makeProject(testerGraph());
  const runtime = makeRuntime(dir);
  const wakeCalls = [];
  const subagents = makeSubagents({
    onStart(spec) {
      if (String((spec && spec.label) || '').startsWith('доставка:')) {
        wakeCalls.push(spec);
        return activation('delivery-1', '');
      }
      return activation('tester-attempt', TESTER_TEXT);
    },
  });
  const scheduler = makeScheduler(runtime, subagents);

  await scheduler.tick(at(FIRST));
  assert.deepEqual(await scheduler.tick(at('2026-11-06T08:59:59+03:00')), [], 'окно ещё не наступило');
  const launched = await scheduler.tick(at(WINDOW));
  assert.equal(launched.length, 1, 'окно тестировщика запущено');
  assert.equal(launched[0].attempt, 1);

  const runs = await waitFor(() => {
    const list = testerRuns(runtime, dir);
    return list.some((run) => run.state === 'done') ? list : null;
  });
  const done = runs.find((run) => run.state === 'done');
  assert.equal(done.report, 'docs/tester/2026-11-06.md', 'отчёт тестировщика — в docs/tester');
  assert.deepEqual(done.awake, ['coordinator'], 'отчёт доставлен координатору');
  assert.ok(done.delivered, 'письмо report записано');
  assert.ok(runs.every((run) => !run.message), 'ошибок нет');

  const calls = testerCalls(subagents);
  assert.equal(calls.length, 1, 'одна попытка');
  const prompt = String(calls[0].request.prompt[0].text);
  assert.match(prompt, /тестировщик/u, 'промпт называет роль');
  assert.match(prompt, /tester-1/u, 'промпт называет узел');
  assert.match(prompt, /09:00/u, 'промпт называет время запуска');
  assert.match(prompt, /node tools\/test\.mjs/u, 'промпт несёт собственную спеку узла');
  assert.ok(!/## Итог дня|Постоянная спека|Чего не хватило/u.test(prompt),
    'промпт не критиковский: без четырёх разделов и постоянной спеки критика');

  const file = path.join(dir, 'docs', 'tester', '2026-11-06.md');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /^From: tester-1$/mu);
  assert.match(body, /^To: coordinator$/mu);
  assert.match(body, /^Date: .+$/mu);
  assert.match(body, /^Thread: tester-report$/mu);
  assert.match(body, /^Status: report$/mu);
  assert.match(body, /^Subject: тестировщик за 2026-11-06$/mu);
  assert.ok(body.includes('Вердикт: pass'), 'текст тестировщика записан в файл');

  /* R1: пробуждение называет свой узел, а не критика (иначе тестировщик объявлен критиком). */
  assert.equal(wakeCalls.length, 1, 'координатору отправлено пробуждение');
  const wakeText = String(wakeCalls[0].request.prompt[0].text);
  assert.match(wakeText, /отчёт узла «tester-1»/iu, 'пробуждение называет узел отчёта');
  assert.match(wakeText, /тестировщик/u, 'пробуждение называет роль отчёта');
  assert.ok(wakeText.includes('docs/tester/2026-11-06.md'), 'пробуждение называет файл отчёта');
  assert.ok(!/критик/iu.test(wakeText), 'отчёт тестировщика не объявлен отчётом критика');
});

await test('0195: пустой ответ тестировщика — ошибка без файла отчёта', async () => {
  const dir = makeProject(testerGraph());
  const runtime = makeRuntime(dir);
  let scheduled = 0;
  const subagents = makeSubagents({
    onStart(spec) {
      if (String((spec && spec.label) || '').startsWith('доставка:')) return activation('delivery-1', '');
      scheduled += 1;
      return activation('tester-empty-' + scheduled, '');
    },
  });
  const scheduler = makeScheduler(runtime, subagents);

  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));
  const runs = await waitFor(() => {
    const list = testerRuns(runtime, dir);
    return list.length >= 2 && list.every((run) => run.state === 'error') ? list : null;
  });
  assert.ok(runs.every((run) => /без отчёта/u.test(String(run.message || ''))),
    'причина названа пустым ответом: ' + JSON.stringify(runs.map((run) => run.message)));
  assert.ok(runs.every((run) => !run.report), 'отчёт не записан');
  assert.ok(!fs.existsSync(path.join(dir, 'docs', 'tester', '2026-11-06.md')), 'файла отчёта нет');
});

await test('0195: повтор в тот же день перезаписывает docs/tester/<дата>.md', () => {
  const dir = makeProject(testerGraph());
  const node = testerGraph().nodes[1];
  const first = writeTesterReport(dir, node, at('2026-11-06T09:00:00+03:00'), 'первый прогон', ['coordinator']);
  const second = writeTesterReport(dir, node, at('2026-11-06T21:00:00+03:00'), 'второй прогон', ['coordinator']);
  assert.equal(first, 'docs/tester/2026-11-06.md');
  assert.equal(second, first, 'имя файла не зависит от часа');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'docs', 'tester')), ['2026-11-06.md'], 'один файл на день');
  const body = fs.readFileSync(path.join(dir, first), 'utf8');
  assert.match(body, /второй прогон/u, 'записан свежий текст');
  assert.ok(!body.includes('первый прогон'), 'старый текст не остался');
});

await test('0195: критик по-прежнему получает четыре раздела и пишет docs/critic', async () => {
  const graph = scheduledGraph();
  const prompt = buildSchedulePrompt({
    graph,
    node: graph.nodes[1],
    name: 'demo',
    now: at(FIRST),
    runs: [],
    exchange: null,
    baseSpec: 'ПРАВИЛА КРИТИКА',
  });
  for (const section of ['## Итог дня', '## Риски', '## Что делать дальше', '## Чего не хватило']) {
    assert.ok(prompt.includes(section), 'раздел критика на месте: ' + section);
  }
  assert.match(prompt, /Постоянная спека/u, 'постоянная спека критика на месте');

  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const wakeCalls = [];
  const subagents = makeSubagents({
    onStart(spec) {
      if (String((spec && spec.label) || '').startsWith('доставка:')) {
        wakeCalls.push(spec);
        return activation('delivery-1', '');
      }
      return activation('critic-attempt', REPORT_BODY);
    },
  });
  const scheduler = makeScheduler(runtime, subagents);
  await scheduler.tick(at(FIRST));
  await scheduler.tick(at(WINDOW));
  const runs = await waitFor(() => {
    const list = scheduleRuns(runtime, dir);
    return list.some((run) => run.state === 'done') ? list : null;
  });
  const done = runs.find((run) => run.state === 'done');
  assert.equal(done.report, 'docs/critic/2026-11-06.md', 'критик пишет в docs/critic');
  assert.ok(fs.existsSync(path.join(dir, 'docs', 'critic', '2026-11-06.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'docs', 'tester', '2026-11-06.md')), 'у критика нет docs/tester');
  /* R1: нейтральный текст пробуждения не сломал критика — узел и роль названы. */
  assert.equal(wakeCalls.length, 1, 'координатору отправлено пробуждение критика');
  const wakeText = String(wakeCalls[0].request.prompt[0].text);
  assert.match(wakeText, /отчёт узла «critic»/iu, 'пробуждение называет узел критика');
  assert.match(wakeText, /критик/u, 'пробуждение называет роль критика');
  assert.ok(wakeText.includes('docs/critic/2026-11-06.md'), 'пробуждение называет файл критика');
  assert.ok(!/tester/iu.test(wakeText), 'отчёт критика не объявлен отчётом тестировщика');
});

for (const failure of failures) {
  console.error('FAIL ' + failure.name + ': ' + (failure.error && failure.error.message));
}
if (failures.length > 0) {
  console.error('SCHEDULER TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('SCHEDULER TEST OK: ' + passed + '/' + passed);
