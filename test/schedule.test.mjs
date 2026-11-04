/**
 * Daily schedules: the pure next-run math, the schema rule, and the host
 * scheduler's promise that a missed window is never caught up.
 *
 * The scheduler is exercised with a fixed clock and a mock subagent service, so
 * every decision is asserted without DSH and without a real timer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime, readGraph } from '../lib/api.js';
import { buildGraph } from '../lib/graph.js';
import {
  dailyLabel,
  isValidTimeZone,
  nextRunAt,
  parseTimeOfDay,
  scheduleForGraph,
} from '../lib/schedule.js';
import { createScheduler, buildSchedulePrompt } from '../lib/scheduler.js';
import { listRuns } from '../lib/runs.js';

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

const REPORT_BODY = ['## Итог дня', 'день', '', '## Риски', '- нет', '', '## Что делать дальше', '- ничего', '', '## Чего не хватило', '- нет'].join('\n');

const MOSCOW = { at: '09:00', timeZone: 'Europe/Moscow' };
const at = (value) => new Date(value);

function makeProject(graph) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-schedule-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  return dir;
}

function makeRuntime(dir) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-schedule-runs-'));
  return createGraphRuntime({ roots: [dir], runsDir });
}

function makeSubagents(overrides = {}) {
  const calls = [];
  const subagents = {
    calls,
    getProvider(name) {
      if (overrides.provider === null) return undefined;
      return overrides.provider || { name, capabilities: { agentOptions: true } };
    },
    resolveMaxDepth(configured) {
      return configured === undefined ? 1 : configured;
    },
    async startActivation(spec) {
      calls.push(spec);
      if (overrides.onStart) return overrides.onStart(spec);
      return {
        childId: 'sched-1',
        result: Promise.resolve({
          output: [{
            type: 'text',
            text: '## Итог дня\nаналитика дня: узлы работали\n\n## Риски\n- нет\n\n## Что делать дальше\n- ничего\n\n## Чего не хватило\n- нет',
          }],
          stopReason: 'stop',
        }),
        dispose: async () => {},
      };
    },
  };
  if (overrides.noStart) delete subagents.startActivation;
  return subagents;
}

function scheduledGraph() {
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
      },
    ],
    edges: [{ from: 'critic', to: 'coordinator', kind: 'report' }],
  };
}

/* ---------- nextRunAt: today, tomorrow, no catch-up ---------- */

await test('nextRunAt: до времени — сегодня, после и ровно в момент — завтра', () => {
  assert.equal(nextRunAt(MOSCOW, at('2026-10-29T08:00:00+03:00')).toISOString(), '2026-10-29T06:00:00.000Z');
  assert.equal(nextRunAt(MOSCOW, at('2026-10-29T10:00:00+03:00')).toISOString(), '2026-10-30T06:00:00.000Z');
  assert.equal(nextRunAt(MOSCOW, at('2026-10-29T09:00:00+03:00')).toISOString(), '2026-10-30T06:00:00.000Z',
    'наступившее время считается пропущенным: догонять нечего');
});

await test('nextRunAt: часовой пояс учитывается, а не берётся из процесса', () => {
  const tokyo = nextRunAt({ at: '09:00', timeZone: 'Asia/Tokyo' }, at('2026-10-28T23:00:00Z'));
  assert.equal(tokyo.toISOString(), '2026-10-29T00:00:00.000Z');
  const newYork = nextRunAt({ at: '09:00', timeZone: 'America/New_York' }, at('2026-10-29T12:00:00Z'));
  assert.equal(newYork.toISOString(), '2026-10-29T13:00:00.000Z');
});

await test('nextRunAt: переход через полночь и через сутки', () => {
  const late = nextRunAt({ at: '23:30', timeZone: 'Europe/Moscow' }, at('2026-10-29T23:31:00+03:00'));
  assert.equal(late.toISOString(), '2026-10-30T20:30:00.000Z');
  const early = nextRunAt({ at: '00:15', timeZone: 'Europe/Moscow' }, at('2026-10-30T00:16:00+03:00'));
  assert.equal(early.toISOString(), '2026-10-30T21:15:00.000Z');
});

await test('nextRunAt: время, пропущенное переводом часов, не откатывается назад', () => {
  /* Berlin skips 02:00–03:00 on 2026-03-29; a 02:30 schedule must not become 01:30. */
  const gap = nextRunAt({ at: '02:30', timeZone: 'Europe/Berlin' }, at('2026-03-28T12:00:00Z'));
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(gap);
  assert.ok(local >= '03:00', 'после перевода часов запуск идёт вперёд, а не назад: ' + local);
});

await test('nextRunAt: неверное время и пояс — понятная ошибка', () => {
  for (const bad of ['9:00', '24:00', '09:60', '09', '']) {
    assert.throws(() => nextRunAt({ at: bad, timeZone: 'Europe/Moscow' }), /HH:MM/u);
  }
  assert.throws(() => nextRunAt({ at: '09:00', timeZone: 'Mars/Olympus' }), /Intl/u);
  assert.equal(parseTimeOfDay('09:05').hour, 9);
  assert.equal(parseTimeOfDay('09:05').minute, 5);
  assert.equal(parseTimeOfDay('9:05'), null);
  assert.equal(isValidTimeZone('Europe/Moscow'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(dailyLabel(MOSCOW), 'ежедневно 09:00');
});

/* ---------- schema: schedule is a node field ---------- */

await test('схема: schedule с at HH:MM и поясом Intl принимается', () => {
  const result = buildGraph([{
    name: 'graph.json',
    text: JSON.stringify({
      version: 1,
      models: { work: { provider: 'p', model: 'm' } },
      nodes: [
        { id: 'coordinator', role: 'координатор', model: 'work' },
        { id: 'critic', role: 'критик', model: 'work', schedule: { at: '09:00', timeZone: 'Europe/Moscow' } },
      ],
      edges: [{ from: 'critic', to: 'coordinator', kind: 'report' }],
    }),
  }]);
  assert.deepEqual(result.errors, []);
  const critic = result.graph.nodes.find((node) => node.id === 'critic');
  assert.deepEqual(critic.schedule, { at: '09:00', timeZone: 'Europe/Moscow' });
});

await test('схема: битое расписание — ошибка с кодом, а не молчаливый пропуск', () => {
  const base = (schedule) => ({
    name: 'graph.json',
    text: JSON.stringify({
      version: 1,
      models: { m: { provider: 'p', model: 'q' } },
      nodes: [{ id: 'critic', role: 'критик', model: 'm', schedule }],
    }),
  });
  const codes = (schedule) => buildGraph([base(schedule)]).errors.map((item) => item.code);
  assert.ok(codes('09:00').includes('invalid-schedule'));
  assert.ok(codes({ at: '9:00', timeZone: 'Europe/Moscow' }).includes('invalid-schedule-at'));
  assert.ok(codes({ at: '09:00' }).includes('invalid-schedule-timezone'));
  assert.ok(codes({ at: '09:00', timeZone: 'Mars/Olympus' }).includes('invalid-schedule-timezone'));
});

/* ---------- graph payload ---------- */

await test('payload: scheduleForGraph отдаёт at, timeZone и вычисленный nextRun', () => {
  const graph = buildGraph([{ name: 'graph.json', text: JSON.stringify(scheduledGraph()) }]).graph;
  const schedule = scheduleForGraph(graph, at('2026-10-29T08:00:00+03:00'));
  assert.deepEqual(Object.keys(schedule), ['critic']);
  assert.equal(schedule.critic.at, '09:00');
  assert.equal(schedule.critic.timeZone, 'Europe/Moscow');
  assert.equal(schedule.critic.daily, 'ежедневно 09:00');
  assert.equal(schedule.critic.nextRun, '2026-10-29T06:00:00.000Z');
});

/* ---------- scheduler: due time, no catch-up ---------- */

await test('планировщик: кладёт базовую спеку критику, добавленному руками', async () => {
  const dir = makeProject(scheduledGraph());
  const specFile = path.join(dir, 'docs', 'critic', 'spec.md');
  assert.ok(!fs.existsSync(specFile), 'до тика спеки нет');
  const runtime = makeRuntime(dir);
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => makeSubagents(),
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  assert.ok(fs.existsSync(specFile), 'первый тик создал базовую спеку');
  const text = fs.readFileSync(specFile, 'utf8');
  assert.match(text, /Базовая спека критика/u);
  fs.writeFileSync(specFile, text + '\nПРАВКА\n', 'utf8');
  await scheduler.tick(at('2026-10-29T08:00:30+03:00'));
  assert.ok(fs.readFileSync(specFile, 'utf8').includes('ПРАВКА'), 'существующая спека не перезаписывается');
});

await test('планировщик: остановка не отменяет сигнал следующего прогона', async () => {
  /*
   * Живой дефект 2026-11-01: у планировщика был ОДИН AbortController на все прогоны,
   * и после остановки (перезагрузка плагина) каждый следующий запуск получал уже
   * отменённый сигнал. Ребёнок рождался, промпт писался, модель не вызывалась —
   * «агент завершился без отчёта» за 222 мс (llmMs 0).
   */
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  const stop = scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  stop();
  /* Повторный старт — то, что делает хост после перезагрузки плагина. */
  const stopAgain = scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  stopAgain();
  /* Второй вызов — доставка отчёта координатору, а не второй прогон. */
  const runs = subagents.calls.filter((spec) => String(spec.label || '').startsWith('критик:'));
  assert.equal(runs.length, 1, 'прогон состоялся после остановки планировщика');
  assert.ok(runs[0].signal, 'сигнал передан запуску');
  assert.equal(runs[0].signal.aborted, false, 'сигнал не отменён остановкой');
});

await test('планировщик: при полном пуле ждёт место, а не теряет отчёт', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  let attempts = 0;
  const subagents = makeSubagents({
    onStart(spec) {
      if (!String(spec.label || '').startsWith('критик:')) {
        return { childId: 'delivery', result: Promise.resolve({ output: [], stopReason: 'stop' }), dispose: async () => {} };
      }
      attempts += 1;
      if (attempts <= 2) throw new Error('subagent limit reached (active child limit: 8); wait for an existing child to finish');
      return {
        childId: 'sched-wait-' + attempts,
        result: Promise.resolve({
          output: [{ type: 'text', text: REPORT_BODY }],
          stopReason: 'stop',
        }),
        dispose: async () => {},
      };
    },
  });
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
    limitRetryMs: 1,
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(attempts, 3, 'две попытки упёрлись в лимит, третья прошла');
  const runs = listRuns(runtime, dir);
  assert.ok(runs.some((run) => run.node === 'critic' && run.state !== 'error'), 'прогон не потерян');
});

await test('планировщик: недоступный маршрут назван причиной, а не пустым ответом', async () => {
  /*
   * Живой дефект 2026-11-01: все алиасы структуры указывали на provider «opencode»,
   * которого в сборке уже нет. Запуск рождался, модель не вызывалась, а в журнале
   * было только «агент завершился без отчёта».
   */
  const dir = makeProject(scheduledGraph());
  const runtime = createGraphRuntime({
    roots: [dir],
    runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-route-')),
  });
  /* В хосте службу ставит ctx.inject, в тесте — руками. */
  runtime.getLlm = () => ({
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', name: 'Flash' }],
  });
  const subagents = makeSubagents();
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(subagents.calls.length, 0, 'запуск не состоялся: маршрута нет');
  const runs = listRuns(runtime, dir);
  const run = runs.find((item) => item.node === 'critic');
  assert.ok(run, 'о неудаче записано');
  assert.equal(run.state, 'error');
  assert.match(run.message, /провайдера «opencode» нет в DSH/u);
  assert.match(run.message, /deepseek-official/u, 'рецепт называет доступные маршруты');
});

await test('планировщик: каждый тик тянет дополнительный проход (ящик обмена на его такте)', async () => {
  /*
   * Таймер планировщика в хосте доказанно работает, а отдельный интервал сторожа —
   * нет. Поэтому проход обмена висит на такте планировщика: ящик не может замолчать,
   * пока живы расписания.
   */
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  let passes = 0;
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => makeSubagents(),
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
    onTick: async () => { passes += 1; },
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T08:30:00+03:00'));
  assert.equal(passes, 2, 'дополнительный проход вызван на каждом тике');
});

await test('планировщик: падение дополнительного прохода не ломает расписание', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => makeSubagents(),
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
    onTick: async () => { throw new Error('ящик недоступен'); },
  });
  const launched = await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  assert.deepEqual(launched, [], 'тик вернулся, а не упал');
});

await test('планировщик: ответ критика ложится файлом в свой воркспейс', async () => {
  const dir = makeProject(scheduledGraph());
  const other = makeProject(scheduledGraph());
  const runtime = createGraphRuntime({ roots: [dir, other], runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-runs-')) });
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => makeSubagents(),
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const file = path.join(dir, 'docs', 'critic', '2026-10-29.md');
  assert.ok(fs.existsSync(file), 'отчёт записан в docs/critic/');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /From: critic/u);
  assert.match(text, /To: coordinator/u);
  assert.match(text, /Status: report/u);
  assert.match(text, /аналитика дня/u);
  assert.ok(fs.existsSync(path.join(other, 'docs', 'critic', '2026-10-29.md')), 'второй воркспейс получил свой файл');
  const runs = listRuns(runtime, dir);
  assert.ok(runs.some((run) => run.report === 'docs/critic/2026-10-29.md'), 'запись запуска ссылается на отчёт');
  const delivered = runs.find((run) => run.delivered);
  assert.ok(delivered, 'сообщение в ящик записано');
  const boxDir = path.join(path.dirname(dir), 'coordination');
  assert.ok(fs.existsSync(boxDir), 'ящик обмена создан');
  const message = fs.readFileSync(path.join(boxDir, ...delivered.delivered.split('/')), 'utf8');
  assert.match(message, /From: /u, 'отправитель назван');
  assert.match(message, /Node: critic/u, 'узел назван отдельным полем');
  assert.match(message, /Status: report/u);
  assert.match(message, /File: docs\/critic\/2026-10-29\.md/u);
  assert.match(message, /Date: 2026-10-29T09:00:10\+03:00/u, 'дата с зоной узла');
  assert.match(message, /## Чего не хватило/u, 'в ящик уходит отчёт целиком, а не первые пять строк');
});

await test('сквозная цепь: отчёт, письмо, wake и активация спящего координатора', async () => {
  /*
   * Три требования заказчика в одном прогоне, без DSH:
   *   1. критик по расписанию пишет отчёт файлом;
   *   2. отчёт уходит письмом в общий ящик;
   *   3. спящий координатор поднимается этим отчётом (новая активация с cwd воркспейса).
   */
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const activations = [];
  const subagents = makeSubagents({
    onStart(spec) {
      activations.push(spec);
      const criticRun = String(spec.label || '').startsWith('критик:');
      return {
        childId: criticRun ? 'critic-child' : 'coordinator-child',
        result: Promise.resolve({
          output: criticRun ? [{ type: 'text', text: REPORT_BODY }] : [],
          stopReason: 'stop',
        }),
        dispose: async () => {},
      };
    },
  });
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    /* Живых сессий нет: координатор спит, его надо поднять. */
    getAgents: () => ({ roots: () => [] }),
    getParent: () => ({ id: 'parent-1', cwd: dir }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 120));

  /* 1. отчёт файлом */
  const reportPath = path.join(dir, 'docs', 'critic', '2026-10-29.md');
  assert.ok(fs.existsSync(reportPath), 'отчёт записан файлом');
  const report = fs.readFileSync(reportPath, 'utf8');
  for (const heading of ['## Итог дня', '## Риски', '## Что делать дальше', '## Чего не хватило']) {
    assert.ok(report.includes(heading), 'раздел на месте: ' + heading);
  }

  /* 2. письмо в ящик */
  const run = listRuns(runtime, dir).find((item) => item.node === 'critic' && item.report);
  assert.ok(run, 'запись запуска ссылается на отчёт');
  assert.equal(run.state, 'done');
  assert.equal(run.report, 'docs/critic/2026-10-29.md');
  assert.ok(run.delivered, 'сообщение записано');
  const boxDir = path.join(path.dirname(dir), 'coordination');
  const message = fs.readFileSync(path.join(boxDir, ...run.delivered.split('/')), 'utf8');
  assert.match(message, /From: critic/u);
  assert.match(message, /To: coordinator/u);
  assert.match(message, /Status: report/u);
  assert.match(message, /File: docs\/critic\/2026-10-29\.md/u);

  /* 3. спящий координатор поднят, и это записано в wake */
  assert.equal(activations.length, 2, 'два запуска: критик и координатор');
  const wakeRun = activations.find((spec) => String(spec.label || '').startsWith('доставка:'));
  assert.ok(wakeRun, 'координатор поднят запуском доставки');
  assert.equal(wakeRun.request.cwd, dir, 'агент рождается в воркспейсе отчёта');
  assert.match(wakeRun.request.prompt[0].text, /docs\/critic\/2026-10-29\.md/u, 'промпт называет файл отчёта');
  assert.ok(run.wake, 'запись запуска знает адресата');
  assert.equal(run.wake.reason, 'spawn');
  assert.equal(run.wake.target, 'coordinator-child');
  assert.equal(run.ack, null, 'слот ack открыт до подтверждения');
});

await test('планировщик: слишком длинный отчёт помечается «обрезано», а не обрывается молча', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const long = '## Итог дня\n' + 'строка итога\n'.repeat(400)
    + '\n## Риски\n- риск\n\n## Что делать дальше\n- шаг\n\n## Чего не хватило\n- данные';
  const subagents = makeSubagents({
    onStart: () => ({
      childId: 'sched-long',
      result: Promise.resolve({ output: [{ type: 'text', text: long }], stopReason: 'stop' }),
      dispose: async () => {},
    }),
  });
  const scheduler = createScheduler({
    runtime, getSubagents: () => subagents, getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const delivered = listRuns(runtime, dir).find((run) => run.delivered);
  const boxDir = path.join(path.dirname(dir), 'coordination');
  const message = fs.readFileSync(path.join(boxDir, ...delivered.delivered.split('/')), 'utf8');
  assert.match(message, /обрезано, см\. файл: docs\/critic\/2026-10-29\.md/u, 'обрыв назван и указывает на файл');
  assert.ok(message.length < 5000, 'сообщение ограничено, а не тащит весь файл');
});

await test('планировщик: пустой ответ — это ошибка, а не успех', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = createGraphRuntime({ roots: [dir], runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-runs-')) });
  const subagents = makeSubagents({ onStart: () => ({ childId: 'x', result: Promise.resolve({ output: [], stopReason: 'stop' }), dispose: async () => {} }) });
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const all = listRuns(runtime, dir);
  const run = all.find((item) => item.kind === 'schedule');
  assert.ok(run, 'запись запуска есть: ' + JSON.stringify(all.map((item) => ({ kind: item.kind, state: item.state }))));
  assert.equal(run.state, 'error', 'пустой ответ не считается успехом');
  assert.match(run.message, /без отчёта/u);
  assert.match(run.message, /stopReason: stop/u, 'причина отказа названа в записи, а не только «без отчёта»');
  assert.match(run.message, /вызова модели не было/u, 'отсутствие текста названо отдельно');
});

await test('планировщик: поднимает адресата отчёта живым сообщением', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = createGraphRuntime({ roots: [dir], runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-runs-')) });
  const sent = [];
  const agents = { roots: () => [{ cwd: dir, label: 'coordinator', sendMessage: async (message) => { sent.push(message); } }] };
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => makeSubagents(),
    getAgents: () => agents,
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(sent.length, 1, 'координатор получил сообщение');
  assert.match(sent[0].text, /docs\/critic\/2026-10-29\.md/u);
  const run = listRuns(runtime, dir).find((item) => item.kind === 'schedule');
  assert.deepEqual(run.awake, ['coordinator'], 'пробуждение записано в запуске');
});

await test('планировщик: без живого адресата запускает его с отчётом', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = createGraphRuntime({ roots: [dir], runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-runs-')) });
  const subagents = makeSubagents();
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    getAgent: () => null,
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const delivery = subagents.calls.find((call) => call.label === 'доставка:coordinator');
  assert.ok(delivery, 'адресат запущен с отчётом');
  assert.match(delivery.request.prompt[0].text, /docs\/critic\/2026-10-29\.md/u);
  const run = listRuns(runtime, dir).find((item) => item.kind === 'schedule');
  assert.deepEqual(run.awake, ['coordinator'], 'доставка записана');
});

await test('планировщик: смену времени в пределах допуска ловит, а не ждёт сутки', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    getParent: () => ({ id: 'p' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  /* Человек меняет 09:00 на 09:30 уже после 09:30 — окно прошло 20 секунд назад. */
  const graphFile = path.join(dir, 'structure', 'graph.json');
  const document = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  document.nodes.find((node) => node.id === 'critic').schedule.at = '09:30';
  fs.writeFileSync(graphFile, JSON.stringify(document, null, 2));
  const launched = await scheduler.tick(at('2026-10-29T09:30:20+03:00'));
  assert.equal(launched.length, 1, 'свежее время запускает этим же тиком');
  assert.equal(subagents.calls.filter((call) => call.label === 'критик:critic').length, 1);
});
await test('планировщик: рассуждения модели — не отчёт', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = createGraphRuntime({ roots: [dir], runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-runs-')) });
  const subagents = makeSubagents({ onStart: () => ({ childId: 'x', result: Promise.resolve({ output: [{ type: 'text', text: 'Wait — let me check. Hmm, the spec says…' }], stopReason: 'stop' }), dispose: async () => {} }) });
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const run = listRuns(runtime, dir).find((item) => item.kind === 'schedule');
  assert.equal(run.state, 'error', 'рассуждения не принимаются');
  assert.match(run.message, /рассуждения/u);
  assert.ok(!fs.existsSync(path.join(dir, 'docs', 'critic', '2026-10-29.md')), 'файл не создаётся из рассуждений');
});

await test('планировщик: рассуждения до отчёта отрезаются, разделы остаются', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = createGraphRuntime({ roots: [dir], runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-runs-')) });
  const subagents = makeSubagents({
    onStart: () => ({
      childId: 'x',
      result: Promise.resolve({
        output: [{
          type: 'text',
          text: 'Wait — let me check. Hmm, should I deliver a file?\n\n## Итог дня\nвсё сделано\n\n## Риски\n- нет\n\n## Что делать дальше\n- ничего\n\n## Чего не хватило\n- нет',
        }],
        stopReason: 'stop',
      }),
      dispose: async () => {},
    }),
  });
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const run = listRuns(runtime, dir).find((item) => item.kind === 'schedule');
  assert.equal(run.state, 'done', 'рассуждения до отчёта не валят запуск');
  const file = fs.readFileSync(path.join(dir, 'docs', 'critic', '2026-10-29.md'), 'utf8');
  assert.match(file, /## Итог дня/u);
  assert.ok(!file.includes('Wait'), 'рассуждения в отчёт не попадают');
});

await test('планировщик: запускает в назначенное время и только один раз', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    getParent: () => ({ id: 'parent-1' }),
    now: () => at('2026-10-29T08:00:00+03:00'),
  });

  assert.deepEqual(await scheduler.tick(at('2026-10-29T08:00:00+03:00')), [], 'до времени ничего не запускается');
  assert.equal(subagents.calls.length, 0);

  const launched = await scheduler.tick(at('2026-10-29T09:00:10+03:00'));
  assert.equal(launched.length, 1);
  assert.equal(subagents.calls.filter((call) => call.label === 'критик:critic').length, 1,
    'узел по расписанию запускается один раз');
  assert.equal(subagents.calls[0].label, 'критик:critic');
  assert.equal(subagents.calls[0].delivery, 'caller');
  assert.equal(subagents.calls[0].request.parent.id, 'parent-1');
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'opencode', model: 'deepseek-v4.1-flash' });
  assert.equal(subagents.calls[0].request.cwd, path.resolve(dir));
  assert.match(subagents.calls[0].request.prompt[0].text, /факты/iu);
  assert.match(subagents.calls[0].request.prompt[0].text, /обмен/iu);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const run = listRuns(runtime, dir)[0];
  assert.equal(run.kind, 'schedule');
  assert.equal(run.node, 'critic');
  assert.equal(run.state, 'done');

  const again = await scheduler.tick(at('2026-10-29T09:01:00+03:00'));
  assert.deepEqual(again, [], 'второй раз в то же окно не запускает');
  assert.equal(subagents.calls.filter((call) => call.label === 'критик:critic').length, 1,
    'второго запуска узла по расписанию нет');
});

await test('планировщик: пропущенное окно не догоняется', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = createScheduler({ runtime, getSubagents: () => subagents, getParent: () => ({ id: 'p' }) });

  /* The host was asleep from 08:00 to 12:00: the 09:00 window is gone. */
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  assert.deepEqual(await scheduler.tick(at('2026-10-29T12:00:00+03:00')), []);
  assert.equal(subagents.calls.length, 0, 'задним числом не запускаем');

  const nextDay = await scheduler.tick(at('2026-10-30T09:00:05+03:00'));
  assert.equal(nextDay.length, 1, 'следующий — по расписанию, назавтра');
});

await test('планировщик: старт после окна — сегодня уже не запускает', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = createScheduler({ runtime, getSubagents: () => subagents, getParent: () => ({ id: 'p' }) });

  assert.deepEqual(await scheduler.tick(at('2026-10-29T09:00:30+03:00')), []);
  assert.equal(subagents.calls.length, 0);
  assert.equal((await scheduler.tick(at('2026-10-30T09:00:05+03:00'))).length, 1);
});

await test('планировщик: узел без schedule не запускается сам', async () => {
  const dir = makeProject({
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'worker', role: 'исполнитель', model: 'work' }],
  });
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = createScheduler({ runtime, getSubagents: () => subagents, getParent: () => ({ id: 'p' }) });
  assert.deepEqual(await scheduler.tick(at('2026-10-29T09:00:10+03:00')), []);
  assert.equal(subagents.calls.length, 0, 'без schedule панель не запускает ничего');
});

await test('планировщик: недействительная структура не запускает узел', async () => {
  const dir = makeProject({
    version: 1,
    models: {},
    nodes: [{ id: 'critic', role: 'критик', model: 'missing', schedule: { at: '09:00', timeZone: 'Europe/Moscow' } }],
  });
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = createScheduler({ runtime, getSubagents: () => subagents, getParent: () => ({ id: 'p' }) });
  assert.deepEqual(await scheduler.tick(at('2026-10-29T09:00:10+03:00')), []);
  assert.equal(subagents.calls.length, 0);
});

await test('планировщик: нет родителя — запуск не делается, ошибка записана', async () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = createScheduler({ runtime, getSubagents: () => subagents, getParent: () => null });
  await scheduler.tick(at('2026-10-29T08:00:00+03:00'));
  assert.deepEqual(await scheduler.tick(at('2026-10-29T09:00:10+03:00')), []);
  assert.equal(subagents.calls.length, 0);
  const run = listRuns(runtime, dir)[0];
  assert.equal(run.kind, 'schedule');
  assert.equal(run.state, 'error');
  assert.match(run.message, /родител/u);
});

await test('планировщик: start() ставит таймер, stop() его снимает', () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const subagents = makeSubagents();
  const scheduler = createScheduler({ runtime, getSubagents: () => subagents, getParent: () => ({ id: 'p' }), intervalMs: 60_000 });
  const stop = scheduler.start();
  assert.equal(typeof stop, 'function');
  stop();
  const again = scheduler.start();
  again();
});

await test('buildSchedulePrompt: факты запусков и обмена, без текстов сообщений', () => {
  const prompt = buildSchedulePrompt({
    graph: scheduledGraph(),
    node: scheduledGraph().nodes[1],
    name: 'demo',
    now: at('2026-10-29T09:00:00+03:00'),
    runs: [{ node: 'worker', state: 'error', since: at('2026-10-29T08:00:00+03:00').getTime(), message: 'сломалось' }],
    exchange: { facts: [{ from: 'structure', to: 'workflow', date: '2026-10-29T08:10:00+03:00', status: 'sent', text: 'СЕКРЕТ' }] },
  });
  assert.match(prompt, /узел «worker»: error/u);
  assert.match(prompt, /сломалось/u);
  assert.match(prompt, /structure → workflow/u);
  assert.ok(!prompt.includes('СЕКРЕТ'), 'тело сообщения в спеку не попадает');
  assert.match(prompt, /coordinator/u);
  assert.match(prompt, /report/u);
  assert.match(prompt, /Постоянной спеки в проекте нет/u, 'без спеки промпт честно говорит, что её нет');
});

await test('buildSchedulePrompt: базовая спека попадает в промпт как постоянные правила', () => {
  const prompt = buildSchedulePrompt({
    graph: scheduledGraph(),
    node: scheduledGraph().nodes[1],
    name: 'demo',
    now: at('2026-10-29T09:00:00+03:00'),
    runs: [],
    exchange: null,
    baseSpec: 'ПРАВИЛО: не читать тексты сообщений.',
  });
  assert.match(prompt, /Постоянная спека/u);
  assert.match(prompt, /ПРАВИЛО: не читать тексты сообщений/u);
});

/* ---------- readGraph exposes the same map ---------- */

await test('readGraph: /api/graph получает schedule с nextRun', () => {
  const dir = makeProject(scheduledGraph());
  const runtime = makeRuntime(dir);
  const payload = readGraph(runtime, dir);
  assert.equal(payload.errors.length, 0);
  assert.equal(payload.schedule.critic.at, '09:00');
  assert.ok(Date.parse(payload.schedule.critic.nextRun) > Date.now(), 'nextRun — будущее время');
  assert.equal(payload.schedule.coordinator, undefined);
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.stack ? failure.error.stack : String(failure.error)));
}
console.log('SCHEDULE TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
