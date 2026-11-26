/**
 * 0360: уведомление таймкипера доставляется и не теряется.
 *
 * Смысл проверки — не форма письма, а факт: вручение — лестница каналов (0363).
 * Живая сессия координатора идёт первой; если её нет или она отказала, письмо
 * ложится в ящик обмена воркспейса. Запись в журнале прогонов (kind:'timekeeper')
 * несёт канал полем deliveredVia: 'session' | 'letter' | 'journal'. Письмо в
 * сессию или ящик — state 'done' с текстом уведомления; отказ всех каналов —
 * state 'error' с причиной в message. Повторный тик того же момента (тот же
 * момент активации) не дублирует ни письмо, ни запись. Сбой журнала не роняет
 * тик: предупреждение и продолжение.
 *
 * Журнал подменяется переменной PG_RUNS_DIR (lib/runs.js читает её, когда у
 * runtime нет своего runsDir), как в test/runs-stale.test.mjs: настоящий
 * каталог ~/.dsh тест не трогает. DSH, сеть и LLM не нужны: живая сессия
 * координатора — подставной handle, служба субагентов — счётчик, который обязан
 * остаться пустым (таймкипер не тратит прогон).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime } from '../lib/api.js';
import { parseHeader } from '../lib/exchange.js';
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

/*
 * Привязка сессии задана явно: подставной handle — это и есть сессия
 * координатора. Побочный плюс — тик не сканирует журнал сессий, и проверка не
 * длится минутами.
 */
const SESSION = 'session-coordinator-0360';
const COORDINATOR = Object.freeze({
  id: 'coordinator',
  role: 'координатор',
  provider: 'opencode',
  model: 'deepseek-v4.1-flash',
  session: SESSION,
});

const PERIOD = Object.freeze({ start: '09:00', end: '13:00', leadMinutes: 30 });

/*
 * 0365: письмо адресуется ярлыку СВОЕГО воркспейса, а не роли 'coordinator'.
 * Ярлык задаётся картой участников, как в живом профиле: адрес получателя —
 * имя воркспейса, и два воркспейса в общем hub перестают выглядеть одним
 * адресатом.
 */
const WS_LABEL = 'delivery-workspace';
const MONITOR = Object.freeze([{ provider: 'opencode', model: 'deepseek-v4.1-flash', periods: [PERIOD] }]);

const WARN_TEXT = 'останов с 09:00 до 13:00, осталось 30 минут';
const START_TEXT = 'останов включён с 09:00 до 13:00';

/** Локальное «сегодня»: пояс машины, как у периодов монитора. */
const localAt = (hour, minute, day = 6) => new Date(2026, 10, day, hour, minute);

function keeper(monitor, extra = {}) {
  return { id: 'keeper', role: 'тайм-менеджер', ...(monitor === undefined ? {} : { monitor }), ...extra };
}

function makeProject(graph) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-timekeeper-0360-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  return dir;
}

/**
 * Журнал прогонов — временный каталог на время одного теста.
 *
 * Каждый тест получает свой каталог: чужие записи не должны ни мешать, ни
 * скрывать дубликаты. Настоящий ~/.dsh не трогается.
 */
async function withRunsDir(body) {
  const previous = process.env.PG_RUNS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-timekeeper-0360-runs-'));
  process.env.PG_RUNS_DIR = dir;
  try {
    return await body(dir);
  } finally {
    if (previous === undefined) delete process.env.PG_RUNS_DIR;
    else process.env.PG_RUNS_DIR = previous;
  }
}

/**
 * Живая сессия координатора: все три способа вручения на месте, но письмо
 * падает в журнал handle, а не в хост. Порядок способов проверяется по via:
 * deliverToHandle идёт followup → send(next-turn) → sendMessage.
 */
function coordinatorAgent(cwd, label = 'координатор: главный') {
  return {
    sessionId: SESSION,
    label,
    cwd,
    messages: [],
    via: [],
    followup(message) {
      this.via.push('followup');
      this.messages.push(message);
    },
    send(message) {
      this.via.push('send');
      this.messages.push(message);
    },
    sendMessage(message) {
      this.via.push('sendMessage');
      this.messages.push(message);
    },
  };
}

/** Сессия есть, но каждый способ вручения бросает: хост отвечает отказом. */
function brokenAgent(cwd, label = 'координатор: сломанный') {
  return {
    sessionId: SESSION,
    label,
    cwd,
    attempts: 0,
    followup() {
      this.attempts += 1;
      throw new Error('хост отказал: сессия закрыта');
    },
    send() {
      this.attempts += 1;
      throw new Error('send не принял письмо');
    },
    sendMessage() {
      this.attempts += 1;
      throw new Error('sendMessage не принял письмо');
    },
  };
}

function makeScheduler(dir, agents, runtimeConfig = {}) {
  const runtime = createGraphRuntime({
    roots: [dir],
    participants: { [WS_LABEL]: dir },
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
function records(runtime, dir) {
  return listRuns(runtime, dir).filter((row) => row && row.root === dir);
}

/** Файл прогонов — источник для панели после перезапуска, а не только память. */
function fileRecords(runsDir, dir) {
  const file = runFilePath({ runsDir }, dir);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  return rows.filter((row) => row && row.root === dir);
}

/**
 * Ящик обмена теста: папка coordination внутри его временного каталога.
 *
 * До 0363 тесту ящик не требовался. Теперь письмо при отсутствии сессии — факт,
 * и проверять его нужно файлом, а не только записью журнала. Каталог объявляется
 * явно: иначе writeExchangeMessage положил бы письмо в coordination рядом с
 * os.tmpdir(), то есть вне временного каталога теста.
 */
function makeBox(dir) {
  const box = path.join(dir, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  return box;
}

/** Письма в ящике теста: файл и текст, чтобы проверять факт доставки. */
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
 * 1. Живая сессия: письмо уходит, в журнале запись done
 * ------------------------------------------------------------------------- */

await test('C1 успех: письмо доставлено, запись kind timekeeper state done с текстом', async () => {
  await withRunsDir(async (runsDir) => {
    const dir = makeProject({ version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    const agent = coordinatorAgent(dir);
    const { runtime, scheduler, subagentCalls } = makeScheduler(dir, [agent]);

    const launched = await scheduler.tick(localAt(8, 30));
    assert.equal(agent.messages.length, 1, 'одно письмо координатору');
    assert.equal(agent.messages[0].content[0].text, WARN_TEXT);
    assert.deepEqual(agent.via, ['followup'], 'первое письмо идёт первым способом, без повторов');
    assert.equal(launched.length, 1, 'активация названа в ответе тика');
    assert.equal(launched[0].kind, 'timekeeper');
    assert.equal(launched[0].deliveredVia, 'session', 'канал доставки — живая сессия');

    const rows = records(runtime, dir);
    assert.equal(rows.length, 1, 'одна запись на активацию');
    const record = rows[0];
    assert.equal(record.kind, 'timekeeper', 'вид записи — timekeeper');
    assert.equal(record.node, 'keeper');
    assert.equal(record.state, 'done', 'доставка — done');
    assert.equal(record.deliveredVia, 'session', 'запись называет канал: живая сессия');
    assert.equal(record.message, WARN_TEXT, 'в сообщении записи — текст уведомления');
    assert.equal(record.text, WARN_TEXT, 'текст уведомления сохранён полем text');
    assert.equal(record.phase, 'warn');
    assert.equal(record.since, localAt(8, 30).getTime(), 'запись привязана к моменту активации');
    assert.equal(record.activationAt, localAt(8, 30).toISOString());

    const persisted = fileRecords(runsDir, dir);
    assert.equal(persisted.length, 1, 'запись переживает перезапуск: она в файле прогонов');
    assert.equal(persisted[0].kind, 'timekeeper');
    assert.equal(persisted[0].state, 'done');
    assert.equal(persisted[0].deliveredVia, 'session');
    assert.equal(persisted[0].text, WARN_TEXT);
    assert.equal(subagentCalls.length, 0, 'таймкипер не тратит прогон на LLM');
  });
});

/* ------------------------------------------------------------------------- *
 * 2. Дедупликация: тот же момент — одно письмо и одна запись
 * ------------------------------------------------------------------------- */

await test('C1 дедупликация: повторный тик того же момента не дублирует ни письмо, ни запись', async () => {
  await withRunsDir(async (runsDir) => {
    const dir = makeProject({ version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    const agent = coordinatorAgent(dir);
    const { runtime, scheduler } = makeScheduler(dir, [agent]);

    await scheduler.tick(localAt(8, 30));
    await scheduler.tick(localAt(8, 30));
    await scheduler.tick(localAt(8, 45));
    assert.equal(agent.messages.length, 1, 'повтор того же момента письмо не дублирует');
    assert.equal(records(runtime, dir).length, 1, 'и вторую запись не плодит');

    /* Следующая фаза — другая активация: у неё свой момент, письмо и запись. */
    await scheduler.tick(localAt(9, 0));
    await scheduler.tick(localAt(9, 0));
    assert.equal(agent.messages.length, 2, 'начало останова — второе письмо');
    assert.equal(agent.messages[1].content[0].text, START_TEXT);
    const rows = records(runtime, dir);
    assert.equal(rows.length, 2, 'у каждой активации своя запись');
    const start = rows.find((row) => row.phase === 'start');
    assert.ok(start, 'запись фазы start есть');
    assert.equal(start.state, 'done');
    assert.equal(start.text, START_TEXT);
    assert.equal(start.since, localAt(9, 0).getTime(), 'ключ — момент активации, а не тик');

    assert.equal(fileRecords(runsDir, dir).length, 2, 'файл прогонов тоже без дублей');
  });
});

/* ------------------------------------------------------------------------- *
 * 3. Живой сессии нет: письмо ложится в ящик, запись done с deliveredVia letter
 * ------------------------------------------------------------------------- */

await test('C1 нет живой сессии: письмо в ящике, запись state done с deliveredVia letter', async () => {
  await withRunsDir(async (runsDir) => {
    const dir = makeProject({ version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    const box = makeBox(dir);
    const { runtime, scheduler, warnings } = makeScheduler(dir, [], { exchange: [box] });

    const launched = await scheduler.tick(localAt(8, 30));
    assert.deepEqual(launched, [], 'в живую сессию письма не было — session-активацией это не считается');

    /* Письмо — факт файла в ящике, а не только поле записи. */
    const letters = boxMessages(dir);
    assert.equal(letters.length, 1, 'одно письмо в ящике на активацию');
    const header = parseHeader(letters[0].text);
    assert.ok(header, 'письмо в ящике — факт: шапка From/To/Date на месте');
    assert.equal(header.to, WS_LABEL, 'To — ярлык своего воркспейса, а не роль coordinator');
    assert.notEqual(header.to, 'coordinator', 'id узла не выдаётся за получателя');
    assert.equal(header.workspace, WS_LABEL, 'Workspace — тот же ярлык');
    assert.equal(header.thread, 'timekeeper', 'ветка — timekeeper');
    assert.equal(header.status, 'request', 'Status — request');
    assert.ok(letters[0].text.includes(WARN_TEXT), 'тело письма — текст уведомления');

    let rows = records(runtime, dir);
    assert.equal(rows.length, 1, 'факт активации всё равно записан');
    assert.equal(rows[0].kind, 'timekeeper');
    assert.equal(rows[0].state, 'done', 'письмо в ящике — доставка done');
    assert.equal(rows[0].deliveredVia, 'letter', 'канал назван в записи');
    assert.equal(rows[0].message, WARN_TEXT, 'в message — текст уведомления');
    assert.equal(rows[0].text, WARN_TEXT, 'текст уведомления не потерян и без живой сессии');
    assert.equal(rows[0].since, localAt(8, 30).getTime());
    assert.ok(
      warnings.some((line) => /живой сессии координатора нет/u.test(line)),
      'причина отказа живой сессии названа предупреждением: ' + warnings.join(' | '),
    );

    /* Повторный тик пишет ту же запись (тот же момент), а не вторую. */
    await scheduler.tick(localAt(8, 31));
    rows = records(runtime, dir);
    assert.equal(rows.length, 1, 'повтор того же момента не дублирует запись');
    assert.equal(rows[0].deliveredVia, 'letter');
    assert.equal(boxMessages(dir).length, 1, 'и письмо не дублируется');
    assert.equal(fileRecords(runsDir, dir).length, 1, 'в файле тоже одна запись');
    assert.equal(fileRecords(runsDir, dir)[0].deliveredVia, 'letter', 'канал виден и в файле прогонов');
  });
});

/* ------------------------------------------------------------------------- *
 * 4. Сессия есть, но вручение бросает: письмо уходит в ящик, отказы названы
 * ------------------------------------------------------------------------- */

await test('C1 отказ всех способов: письмо в ящике, запись state done с deliveredVia letter', async () => {
  await withRunsDir(async (runsDir) => {
    const dir = makeProject({ version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    const box = makeBox(dir);
    const agent = brokenAgent(dir);
    const { runtime, scheduler, warnings } = makeScheduler(dir, [agent], { exchange: [box] });

    const launched = await scheduler.tick(localAt(8, 30));
    assert.deepEqual(launched, [], 'недоставленное в сессию письмо активацией не считается');
    assert.equal(agent.attempts, 3, 'живая сессия пробовала все три способа вручения');

    /* Отказы способов не теряются: каждый назван предупреждением. */
    const log = warnings.join(' | ');
    assert.match(log, /followup: хост отказал: сессия закрыта/u, 'назван отказ followup: ' + log);
    assert.match(log, /send: send не принял письмо/u, 'назван отказ send: ' + log);
    assert.match(log, /sendMessage: sendMessage не принял письмо/u, 'назван отказ sendMessage: ' + log);

    /* Второй канал сработал: письмо в ящике, а не только запись об отказе. */
    const letters = boxMessages(dir);
    assert.equal(letters.length, 1, 'после отказа сессии письмо легло в ящик');
    const header = parseHeader(letters[0].text);
    assert.ok(header, 'письмо в ящике — факт: шапка From/To/Date на месте');
    assert.equal(header.to, WS_LABEL, 'To — ярлык своего воркспейса, а не роль coordinator');
    assert.notEqual(header.to, 'coordinator', 'id узла не выдаётся за получателя');
    assert.equal(header.workspace, WS_LABEL, 'Workspace — тот же ярлык');
    assert.equal(header.thread, 'timekeeper', 'ветка — timekeeper');
    assert.ok(letters[0].text.includes(WARN_TEXT), 'тело письма — текст уведомления');

    const rows = records(runtime, dir);
    assert.equal(rows.length, 1, 'доставка видна в журнале, а не только в логе процесса');
    assert.equal(rows[0].kind, 'timekeeper');
    assert.equal(rows[0].state, 'done', 'письмо в ящике — доставка done');
    assert.equal(rows[0].deliveredVia, 'letter', 'канал назван: живая сессия отказала');
    assert.equal(rows[0].text, WARN_TEXT);

    /* Отказ не превращается в поток записей: тот же момент — та же запись. */
    await scheduler.tick(localAt(8, 31));
    assert.equal(records(runtime, dir).length, 1, 'повторный тик не плодит записи');
    assert.equal(boxMessages(dir).length, 1, 'и письмо в ящике не дублируется');
    assert.equal(fileRecords(runsDir, dir).length, 1);
    assert.ok(agent.attempts >= 1, 'попытка вручения действительно была');
  });
});

/* ------------------------------------------------------------------------- *
 * 5. Оба канала отказали: запись state error с deliveredVia journal и причиной
 * ------------------------------------------------------------------------- */

await test('C1 оба канала отказали: запись state error с deliveredVia journal и причиной', async () => {
  await withRunsDir(async (runsDir) => {
    const dir = makeProject({ version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    const box = makeBox(dir);
    /*
     * Ящик объявлен, но запись в него невозможна: на месте ветки threads лежит
     * файл. Отказ детерминирован и не зависит от прав файловой системы.
     */
    fs.writeFileSync(path.join(box, 'threads'), 'не каталог', 'utf8');
    const { runtime, scheduler } = makeScheduler(dir, [], { exchange: [box] });

    const launched = await scheduler.tick(localAt(8, 30));
    assert.deepEqual(launched, [], 'доставлять некуда — session-активации нет');

    const rows = records(runtime, dir);
    assert.equal(rows.length, 1, 'журнал пишется всегда, даже когда оба канала отказали');
    assert.equal(rows[0].kind, 'timekeeper');
    assert.equal(rows[0].state, 'error');
    assert.equal(rows[0].deliveredVia, 'journal', 'канал назван: письма нет ни в сессии, ни в ящике');
    assert.match(rows[0].message, /нет живой сессии координатора/u, 'причина отказа сессии в message');
    assert.match(rows[0].message, /письмо в ящик обмена не записано/u, 'и причина отказа ящика тоже');
    assert.equal(rows[0].text, WARN_TEXT, 'текст уведомления не потерян и при полном отказе');

    assert.equal(boxMessages(dir).length, 0, 'письма в ящике нет');

    await scheduler.tick(localAt(8, 31));
    assert.equal(records(runtime, dir).length, 1, 'повтор того же момента не плодит записи');
    assert.equal(fileRecords(runsDir, dir).length, 1, 'в файле тоже одна запись');
    assert.equal(fileRecords(runsDir, dir)[0].deliveredVia, 'journal', 'канал виден и в файле прогонов');
  });
});

/* ------------------------------------------------------------------------- *
 * 6. Сбой журнала не роняет тик: предупреждение и продолжение
 * ------------------------------------------------------------------------- */

await test('C1 сбой журнала: предупреждение, письмо всё равно уходит, тик не падает', async () => {
  await withRunsDir(async () => {
    const dir = makeProject({ version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    const agent = coordinatorAgent(dir);

    /*
     * Стор ломается на чтении пути: noteRun обязан не уронить тик. Геттер стоит
     * на runtime, а не на файловой системе: отказ детерминирован на любой машине.
     */
    const runtime = createGraphRuntime({ roots: [dir] });
    Object.defineProperty(runtime, 'runsDir', {
      configurable: true,
      get() {
        throw new Error('стор прогонов недоступен');
      },
    });
    const broken = createScheduler({
      runtime,
      getAgents: () => ({ roots: () => [agent] }),
      getParent: () => ({ id: 'parent-1' }),
      logger: { warn() {} },
      now: () => localAt(8, 0),
    });

    /* Стор истории предупреждает через console.warn — это и есть «предупреждение». */
    const events = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { events.push(args.map((item) => String(item)).join(' ')); };
    let launched;
    try {
      launched = await broken.tick(localAt(8, 30));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(agent.messages.length, 1, 'письмо доставлено, несмотря на сбой журнала');
    assert.equal(launched.length, 1, 'активация засчитана: журнал — история, а не гейт');
    assert.ok(
      events.some((line) => /store of runs is unavailable/u.test(line)),
      'сбой стора назван предупреждением: ' + events.join(' | '),
    );
  });
});

await test('C1 запись бросает: предупреждение от таймкипера, письмо всё равно уходит', async () => {
  await withRunsDir(async () => {
    const dir = makeProject({ version: 1, nodes: [COORDINATOR, keeper(MONITOR)] });
    const agent = coordinatorAgent(dir);
    const { runtime, scheduler, warnings } = makeScheduler(dir, [agent]);

    /*
     * Карта прогонов недоступна — noteRun бросает уже из mapOf. Прикрытие
     * recordTimekeeper обязано превратить это в предупреждение, а тик — выжить.
     */
    Object.defineProperty(runtime, 'runs', {
      configurable: true,
      get() {
        throw new Error('карта прогонов недоступна');
      },
    });

    const launched = await scheduler.tick(localAt(8, 30));
    assert.equal(agent.messages.length, 1, 'письмо доставлено, несмотря на сбой записи');
    assert.equal(launched.length, 1, 'активация засчитана');
    assert.ok(
      warnings.some((line) => /запись в журнал прогонов не удалась/u.test(line)),
      'сбой записи назван предупреждением: ' + warnings.join(' | '),
    );
    assert.ok(
      warnings.some((line) => /карта прогонов недоступна/u.test(line)),
      'причина сбоя названа: ' + warnings.join(' | '),
    );
  });
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)));
}
console.log('TIMEKEEPER-DELIVERY TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
