/**
 * 0363: уведомление таймкипера доставляется гарантированно.
 *
 * Живой сессии координатора может не быть: тогда письмо ложится в ящик обмена
 * воркспейса (ветка timekeeper, To — координатор, Status request), а факт и
 * канал остаются в журнале прогонов полем deliveredVia. Если отказали оба
 * канала, запись всё равно есть — с причиной и каналом journal. Дедупликация
 * прежняя: одна активация — одно письмо и одна запись.
 *
 * Ящик и журнал подменяются временными каталогами: корень проекта — подкаталог
 * временного каталога, поэтому соседний coordination тоже временный, а
 * PG_RUNS_DIR уводит файл прогонов из ~/.dsh. DSH, сеть и LLM не нужны.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime } from '../lib/api.js';
import { parseHeader } from '../lib/exchange.js';
import { monitorStateAt } from '../lib/schedule.js';
import { createScheduler } from '../lib/scheduler.js';
import { listRuns, runFilePath } from '../lib/runs.js';

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

const SESSION = 'session-coordinator-0363';
const COORDINATOR = Object.freeze({
  id: 'coordinator',
  role: 'координатор',
  provider: 'opencode',
  model: 'deepseek-v4.1-flash',
  session: SESSION,
});

const PERIOD = Object.freeze({ start: '09:00', end: '13:00', leadMinutes: 30 });

/* 0365: адресат письма — ярлык своего воркспейса, а не роль 'coordinator'. */
const WS_LABEL = 'guaranteed-workspace';
const MONITOR = Object.freeze([{ provider: 'opencode', model: 'deepseek-v4.1-flash', periods: [PERIOD] }]);

const WARN_TEXT = 'останов с 09:00 до 13:00, осталось 30 минут';
const START_TEXT = 'останов включён с 09:00 до 13:00';

/** Локальное «сегодня»: пояс машины, как у периодов монитора. */
const localAt = (hour, minute, day = 6) => new Date(2026, 10, day, hour, minute);

function keeper(monitor, extra = {}) {
  return { id: 'keeper', role: 'тайм-менеджер', ...(monitor === undefined ? {} : { monitor }), ...extra };
}

/** Корень проекта — подкаталог песочницы: соседний coordination тоже её часть. */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-timekeeper-0363-'));
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, 'structure'), { recursive: true });
  return { dir, project };
}

function writeGraph(project, graph) {
  fs.writeFileSync(path.join(project, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
}

/** Журнал прогонов — временный каталог на время одного теста (PG_RUNS_DIR). */
async function withRunsDir(body) {
  const previous = process.env.PG_RUNS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-timekeeper-0363-runs-'));
  process.env.PG_RUNS_DIR = dir;
  try {
    return await body(dir);
  } finally {
    if (previous === undefined) delete process.env.PG_RUNS_DIR;
    else process.env.PG_RUNS_DIR = previous;
  }
}

/** Живая сессия координатора: письмо остаётся в журнале handle, не в хосте. */
function coordinatorAgent(cwd) {
  return {
    sessionId: SESSION,
    label: 'координатор: главный',
    cwd,
    messages: [],
    followup(message) {
      this.messages.push(message);
    },
  };
}

function makeScheduler(project, agents, runtimeConfig = {}) {
  const runtime = createGraphRuntime({
    roots: [project],
    participants: { [WS_LABEL]: project },
    ...runtimeConfig,
  });
  const warnings = [];
  const subagentCalls = [];
  const scheduler = createScheduler({
    runtime,
    getAgents: () => ({ roots: () => (Array.isArray(agents) ? agents : []) }),
    getSubagents: () => ({
      calls: subagentCalls,
      getProvider: (name) => ({ name, capabilities: { agentOptions: true } }),
      async startActivation() {
        throw new Error('таймкипер не должен тратить прогон на LLM');
      },
    }),
    getParent: () => ({ id: 'parent-1' }),
    logger: { warn: (message) => warnings.push(String(message)) },
    now: () => localAt(8, 0),
  });
  return { runtime, scheduler, warnings, subagentCalls };
}

/** Записи журнала этого корня: память процесса и файл обязаны совпадать. */
function records(runtime, project) {
  return listRuns(runtime, project).filter((row) => row && row.root === project);
}

function fileRecords(runsDir, project) {
  const file = runFilePath({ runsDir }, project);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  return rows.filter((row) => row && row.root === project);
}

/** Письма в ящике обмена песочницы: ящик — coordination рядом с проектом. */
function boxMessages(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.md$/iu.test(entry.name)) {
        found.push({ file: full, text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(path.join(dir, 'coordination'));
  return found;
}

/* ------------------------------------------------------------------------- *
 * 1. Живой сессии нет: письмо ложится в ящик, запись несёт deliveredVia letter
 * ------------------------------------------------------------------------- */

await test('C1 без живой сессии: письмо в ящике и запись deliveredVia letter', async () => {
  await withRunsDir(async (runsDir) => {
    const { dir, project } = makeSandbox();
    writeGraph(project, { version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    const { runtime, scheduler } = makeScheduler(project, []);

    const launched = await scheduler.tick(localAt(8, 30));
    assert.deepEqual(launched, [], 'в живую сессию письма не было — session-активацией это не считается');

    const letters = boxMessages(dir);
    assert.equal(letters.length, 1, 'одно письмо на активацию');
    const header = parseHeader(letters[0].text);
    assert.ok(header, 'письмо в ящике — факт: шапка From/To/Date на месте');
    assert.equal(header.to, WS_LABEL, 'To — ярлык своего воркспейса, а не роль coordinator');
    assert.notEqual(header.to, 'coordinator', 'id узла не выдаётся за получателя');
    assert.equal(header.workspace, WS_LABEL, 'Workspace — тот же ярлык');
    assert.equal(header.status, 'request', 'Status — request');
    assert.equal(header.thread, 'timekeeper', 'ветка — timekeeper');
    assert.ok(letters[0].text.includes(WARN_TEXT), 'тело письма — текст уведомления');

    const rows = records(runtime, project);
    assert.equal(rows.length, 1, 'одна запись на активацию');
    assert.equal(rows[0].kind, 'timekeeper');
    assert.equal(rows[0].state, 'done', 'письмо доставлено, пусть и в ящик');
    assert.equal(rows[0].deliveredVia, 'letter', 'канал назван в записи');
    assert.equal(rows[0].text, WARN_TEXT, 'текст уведомления сохранён');
    assert.equal(rows[0].since, localAt(8, 30).getTime(), 'запись привязана к моменту активации');

    const persisted = fileRecords(runsDir, project);
    assert.equal(persisted.length, 1, 'запись переживает перезапуск');
    assert.equal(persisted[0].deliveredVia, 'letter', 'канал виден и в файле прогонов');
  });
});

/* ------------------------------------------------------------------------- *
 * 2. Живая сессия есть: канал session, письма в ящике нет
 * ------------------------------------------------------------------------- */

await test('C1 живая сессия есть: канал session, письма в ящике нет', async () => {
  await withRunsDir(async () => {
    const { dir, project } = makeSandbox();
    writeGraph(project, { version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    const agent = coordinatorAgent(project);
    const { runtime, scheduler } = makeScheduler(project, [agent]);

    const launched = await scheduler.tick(localAt(8, 30));
    assert.equal(launched.length, 1, 'активация в живую сессию названа в ответе тика');
    assert.equal(launched[0].deliveredVia, 'session');
    assert.equal(agent.messages.length, 1, 'одно письмо координатору');
    assert.equal(agent.messages[0].content[0].text, WARN_TEXT);
    assert.equal(boxMessages(dir).length, 0, 'живой сессии достаточно — письмо в ящик не дублируется');

    const rows = records(runtime, project);
    assert.equal(rows.length, 1, 'одна запись на активацию');
    assert.equal(rows[0].state, 'done');
    assert.equal(rows[0].deliveredVia, 'session');
  });
});

/* ------------------------------------------------------------------------- *
 * 3. Оба канала отказали: запись с deliveredVia journal и причиной
 * ------------------------------------------------------------------------- */

await test('C1 оба канала отказали: deliveredVia journal с причиной', async () => {
  await withRunsDir(async (runsDir) => {
    const { dir, project } = makeSandbox();
    writeGraph(project, { version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    /*
     * Ящик объявлен, но запись в него невозможна: на месте ветки threads лежит
     * файл. Отказ детерминирован и не зависит от прав файловой системы.
     */
    const box = path.join(dir, 'coordination');
    fs.mkdirSync(box, { recursive: true });
    fs.writeFileSync(path.join(box, 'threads'), 'не каталог', 'utf8');

    const { runtime, scheduler } = makeScheduler(project, [], { exchange: [box] });
    const launched = await scheduler.tick(localAt(8, 30));
    assert.deepEqual(launched, [], 'доставлять некуда — session-активации нет');

    const rows = records(runtime, project);
    assert.equal(rows.length, 1, 'журнал пишется всегда, даже когда оба канала отказали');
    assert.equal(rows[0].kind, 'timekeeper');
    assert.equal(rows[0].state, 'error');
    assert.equal(rows[0].deliveredVia, 'journal', 'канал назван: письма нет ни в сессии, ни в ящике');
    assert.match(rows[0].message, /нет живой сессии координатора/u, 'причина отказа сессии в message');
    assert.match(rows[0].message, /письмо в ящик обмена не записано/u, 'и причина отказа ящика тоже');
    assert.equal(rows[0].text, WARN_TEXT, 'текст уведомления не потерян и при полном отказе');

    assert.equal(boxMessages(dir).length, 0, 'письма в ящике нет');

    await scheduler.tick(localAt(8, 31));
    assert.equal(records(runtime, project).length, 1, 'повтор того же момента не плодит записи');
    assert.equal(fileRecords(runsDir, project).length, 1, 'в файле тоже одна запись');
  });
});

/* ------------------------------------------------------------------------- *
 * 4. Дедупликация: одна активация — одно письмо в ящике и одна запись
 * ------------------------------------------------------------------------- */

await test('C1 дедупликация: одна активация — одно письмо и одна запись', async () => {
  await withRunsDir(async (runsDir) => {
    const { dir, project } = makeSandbox();
    writeGraph(project, { version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    const { runtime, scheduler } = makeScheduler(project, []);

    await scheduler.tick(localAt(8, 30));
    await scheduler.tick(localAt(8, 30));
    await scheduler.tick(localAt(8, 45));
    assert.equal(boxMessages(dir).length, 1, 'повтор того же момента письмо не дублирует');
    assert.equal(records(runtime, project).length, 1, 'и вторую запись не плодит');

    /* Следующая фаза — другая активация: у неё свой момент, письмо и запись. */
    await scheduler.tick(localAt(9, 0));
    await scheduler.tick(localAt(9, 0));
    const letters = boxMessages(dir);
    assert.equal(letters.length, 2, 'начало останова — второе письмо');
    const rows = records(runtime, project);
    assert.equal(rows.length, 2, 'у каждой активации своя запись');
    const start = rows.find((row) => row && row.phase === 'start');
    assert.ok(start, 'запись фазы start есть');
    assert.equal(start.deliveredVia, 'letter');
    assert.equal(start.text, START_TEXT);
    assert.equal(start.since, localAt(9, 0).getTime(), 'ключ — момент активации, а не тик');
    assert.equal(fileRecords(runsDir, project).length, 2, 'файл прогонов тоже без дублей');
    assert.ok(letters.every((letter) => letter.text.includes('останов')), 'оба письма — уведомления таймкипера');
    const addressees = letters.map((letter) => (parseHeader(letter.text) || {}).to);
    assert.deepEqual(addressees, [WS_LABEL, WS_LABEL], 'оба письма адресованы ярлыку своего воркспейса');
  });
});

/* ------------------------------------------------------------------------- *
 * 5. Остаток минут предупреждения округляется вверх (0363, п. 5)
 * ------------------------------------------------------------------------- */

await test('C1 предупреждение за минуту: остаток округлён вверх, а не до нуля', () => {
  const record = { provider: 'opencode', model: 'deepseek-v4.1-flash', periods: [PERIOD] };
  const justBefore = monitorStateAt(record, new Date(2026, 10, 6, 8, 59, 40));
  assert.equal(justBefore.state, 'warn');
  assert.equal(justBefore.minutesLeft, 1, '20 секунд до останова — «1 минута», а не «0 минут»');
  assert.equal(monitorStateAt(record, localAt(8, 30)).minutesLeft, 30, 'ровно 30 минут остаются 30');
  assert.equal(monitorStateAt(record, localAt(8, 45)).minutesLeft, 15);
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)));
}
console.log('TIMEKEEPER-GUARANTEED TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
