/**
 * 0210 — доставка писем обмена: письмо, положенное при занятой сессии, не теряется.
 *
 * Стенд проверяет поведение, а не реализацию:
 *   c1  сессия занята (agent.running), письмо положено после старта — тик доставил,
 *       seen/журнал/heartbeat говорят об этом, повторные тики не дублируют;
 *   c2  answer на собственный вопрос занятой сессии остаётся pending (skip:active),
 *       а после освобождения доставляется тем же тиком — не теряется;
 *   c3  письмо, положенное во время длинного прохода (сессия занята вручением),
 *       уходит следующим тиком, оба письма вручены ровно по разу;
 *   c4  пустой ящик: heartbeat свежий и журнал различает scanned от «писем нет»;
 *       старый heartbeat и отсутствие файла — разные ответы (stale/no-heartbeat);
 *   c5  состояния журнала: scanned/delivered/pending/error различаются по ветке;
 *   c6  перезапуск сторожа не теряет письмо, положенное при занятой сессии;
 *   c7  поведение lib/index.js: session/event turn/start запускает скан и доставку,
 *       а при exchangeWatch:false до события работает heartbeat-only (B2/B4).
 *
 * Дом подменяется до импорта модуля: телеметрия и heartbeat стенда не имеют права
 * попадать в живой ~/.dsh (правило П-4 docs/structure-rules.md).
 *
 * EXCHANGE_INDEX_PATH (C6) — путь к копии lib/index.js без session/event-хука:
 * сценарий c7 обязан упасть, если хук снят. Без переменной берётся штатный
 * ../lib/index.js.
 *
 *   node test/exchange-delivery.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0210-home-'));
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;
process.env.DSH_PROFILE_DIR = path.join(isolatedHome, 'profile');
delete process.env.DSH_PROFILE;

/* C6: путь к проверяемой копии lib/index.js; по умолчанию — штатный модуль. */
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = process.env.EXCHANGE_INDEX_PATH && process.env.EXCHANGE_INDEX_PATH.trim()
  ? path.resolve(process.env.EXCHANGE_INDEX_PATH.trim())
  : path.join(TEST_DIR, '..', 'lib', 'index.js');

const {
  HEARTBEAT_INTERVAL_MS, createExchangeWatcher, readDecisionRows, readHeartbeat,
  heartbeatState, journalStateOf, journalSummary, writeHeartbeat,
} = await import('../lib/exchange-watch.js');

let passed = 0;
const failures = [];
async function atest(name, body) {
  try {
    await body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(20);
  }
  return check();
}

const THREAD = 'threads/critic-report';
const HEAD = (from, to, status, ref = '') => [
  'From: ' + from,
  'To: ' + to,
  'Date: ' + new Date().toISOString(),
  'Thread: critic-report',
  'Status: ' + status,
  ...(ref ? ['Ref: ' + ref] : []),
  'Subject: проверка доставки',
  '',
  'тело письма',
  '',
].join('\n');

/** Два воркспейса и общий ящик рядом с ними — та же раскладка, что у живого хоста. */
function host() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0210-'));
  const structure = path.join(parent, 'dsh-project-graph');
  const workflow = path.join(parent, 'default-workspace');
  fs.mkdirSync(structure, { recursive: true });
  fs.mkdirSync(workflow, { recursive: true });
  const box = path.join(parent, 'coordination');
  const thread = path.join(box, THREAD);
  fs.mkdirSync(thread, { recursive: true });
  fs.writeFileSync(path.join(box, 'README.md'), [
    '# Канал', '',
    '| Сторона | Пространство | Что делает |',
    '| --- | --- | --- |',
    '| `workflow` | `' + workflow.replace(/\\/gu, '/') + '` | спека |',
    '| `structure` | `' + structure.replace(/\\/gu, '/') + '` | панель |', '',
  ].join('\n'));
  return { parent, structure, workflow, box, thread };
}

/** Хранилище стенда: seen, решения и heartbeat — в отдельных temp-файлах. */
function storeOf(box) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0210-store-'));
  return {
    dir,
    seen: path.join(dir, 'exchange-seen.json'),
    decisions: path.join(dir, 'exchange-decisions.jsonl'),
    heartbeat: path.join(dir, 'runs', 'exchange-watch.json'),
  };
}

function runtimeOf(boxes) {
  return {
    allowedRoots: () => boxes.slice(),
    exchange: [],
    participants: {},
    me: null,
    runs: new Map(),
    runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0210-runs-')),
  };
}

/** Живой агент адресата: запоминает вручённое; running=true — сессия занята. */
function agent(box, { running = false, delayMs = 0 } = {}) {
  const inbox = [];
  return {
    id: 's-workflow',
    sessionId: 's-workflow',
    cwd: box.workflow,
    label: 'workflow',
    running,
    inbox,
    async sendMessage({ text }) {
      inbox.push(text);
      if (delayMs > 0) await sleep(delayMs);
    },
  };
}

function watcherFor(box, { agents = [], store = storeOf(box), tickMs = 30, heartbeatMs = 0, wakeSpawn = false } = {}) {
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: store.seen,
    decisionsPath: store.decisions,
    heartbeatPath: store.heartbeat,
    ...(heartbeatMs > 0 ? { heartbeatMs } : {}),
    getAgents: () => ({ list: () => agents.slice() }),
    /* Журнал сессий относится к своему воркспейсу: иначе чужой агент считается своим. */
    activityOf: (root) => (path.resolve(root).toLowerCase() === path.resolve(box.workflow).toLowerCase()
      ? new Map([['s-workflow', Date.now()]])
      : new Map()),
    wakeSpawn,
    tickMs,
  });
  return { watcher, runtime, store };
}

function writeLetter(box, name, { from = 'structure', to = 'workflow', status = 'request', ref = '' } = {}) {
  const file = path.join(box.thread, name);
  fs.writeFileSync(file, HEAD(from, to, status, ref), 'utf8');
  return file;
}

function decisions(store) {
  return readDecisionRows(store.decisions);
}

function rowsFor(store, name) {
  return decisions(store).filter((row) => String(row.letter || '').endsWith(name));
}

/* ------------------------------------------------------------------ */
/* c1: письмо при занятой сессии доставляется после тика и не теряется */
/* ------------------------------------------------------------------ */
await atest('0210 c1: письмо, положенное при занятой сессии, доставляется после тика и не теряется', async () => {
  const box = host();
  const target = agent(box, { running: true });
  const { watcher, store } = watcherFor(box, { agents: [target] });
  const dispose = watcher.start();
  try {
    assert.ok(await waitFor(() => fs.existsSync(store.heartbeat)), 'heartbeat появился при старте');
    const started = readHeartbeat(store.heartbeat);
    assert.ok(started && started.scanned === 0, 'на старте осмотрено 0 файлов');

    const letter = writeLetter(box, 'busy-request.md');
    const placedAt = Date.now();
    assert.ok(await waitFor(() => target.inbox.length === 1), 'письмо доставлено после тика таймера');
    assert.ok(Date.now() - placedAt < 3000, 'доставка не ждала конца сессии');

    assert.ok(watcher.seen.has(letter), 'письмо отмечено вручённым (seen)');
    const delivered = rowsFor(store, 'busy-request.md').filter((row) => row.state === 'delivered');
    assert.equal(delivered.length, 1, 'журнал: ровно одна запись состояния delivered');
    assert.equal(delivered[0].branch, 'delivered', 'ветка вручения сохранена');

    const beat = readHeartbeat(store.heartbeat);
    assert.ok(beat && beat.scanned >= 1, 'heartbeat называет осмотренные файлы');
    assert.ok(Date.now() - beat.at < 5000, 'heartbeat свежий');
    assert.equal(beat.producer, 'exchange-watch', 'heartbeat называет производителя');
    assert.ok(Number.isInteger(beat.pid) && beat.pid > 0, 'heartbeat называет pid');
    assert.equal(heartbeatState({ file: store.heartbeat }).alive, true, 'heartbeatState: alive');
    assert.equal(HEARTBEAT_INTERVAL_MS, 60 * 1000, 'период heartbeat у хоста — 60 с');

    await sleep(150);
    assert.equal(target.inbox.length, 1, 'повторные тики не доставляют письмо второй раз');
  } finally {
    dispose();
  }
});

/* ------------------------------------------------------------------ */
/* c2: answer занятой сессии — pending, после освобождения доставляется */
/* ------------------------------------------------------------------ */
await atest('0210 c2: answer занятой сессии ждёт (pending) и доставляется после освобождения', async () => {
  const box = host();
  const target = agent(box, { running: true });
  const { watcher, store } = watcherFor(box, { agents: [target] });
  try {
    const request = writeLetter(box, 'own-question.md', { from: 'workflow', to: 'structure', status: 'request' });
    await watcher.tick();
    assert.equal(target.inbox.length, 0, 'request адресован structure, не workflow');

    const answer = writeLetter(box, 'answer-while-busy.md', {
      from: 'structure',
      to: 'workflow',
      status: 'answer',
      ref: THREAD + '/' + path.basename(request),
    });
    await watcher.tick();
    assert.equal(target.inbox.length, 0, 'answer занятой сессии не доставлен немедленно');
    const pending = rowsFor(store, 'answer-while-busy.md');
    assert.ok(pending.length >= 1, 'ожидание answer записано в журнал');
    assert.equal(pending[pending.length - 1].state, 'pending', 'журнал: answer ждёт');
    assert.equal(pending[pending.length - 1].branch, 'skip:in-turn', 'причина ожидания — занятая сессия');
    assert.equal(watcher.seen.has(answer), false, 'недоставленное письмо не помечено прочитанным');

    target.running = false;
    await watcher.tick();
    assert.equal(target.inbox.length, 1, 'после освобождения answer доставлен');
    assert.ok(watcher.seen.has(answer), 'доставленное письмо отмечено');
    const delivered = rowsFor(store, 'answer-while-busy.md').filter((row) => row.state === 'delivered');
    assert.equal(delivered.length, 1, 'журнал: answer доставлен ровно один раз');
  } finally {
    watcher.stop();
  }
});

/* ------------------------------------------------------------------ */
/* c3: письмо, положенное во время длинного прохода, уходит следующим тиком */
/* ------------------------------------------------------------------ */
await atest('0210 c3: письмо, положенное во время занятого прохода, доставляется следующим тиком', async () => {
  const box = host();
  const target = agent(box, { running: true, delayMs: 180 });
  const { watcher, store } = watcherFor(box, { agents: [target], tickMs: 25 });
  const dispose = watcher.start();
  try {
    const first = writeLetter(box, 'during-pass-1.md');
    assert.ok(await waitFor(() => target.inbox.length === 1), 'первое письмо вручается');
    /* Сессия занята вручением: кладём второе письмо, пока первый проход ещё идёт. */
    const second = writeLetter(box, 'during-pass-2.md');
    assert.ok(await waitFor(() => target.inbox.length === 2, 6000), 'второе письмо доставлено следующим тиком');
    assert.ok(await waitFor(() => watcher.seen.has(first) && watcher.seen.has(second)),
      'оба письма отмечены вручёнными, ни одно не потеряно');
    const states = decisions(store).filter((row) => row.state === 'delivered'
      && /during-pass-[12]\.md$/u.test(String(row.letter || '')));
    assert.equal(states.length, 2, 'журнал: оба письма delivered по разу');
    await sleep(200);
    assert.equal(target.inbox.length, 2, 'третьей доставки нет');
  } finally {
    dispose();
  }
});

/* ------------------------------------------------------------------ */
/* c4: тишина отличима от «писем нет» — heartbeat и scanned-строка     */
/* ------------------------------------------------------------------ */
await atest('0210 c4: пустой ящик даёт scanned в журнале и свежий heartbeat; stale/нет файла различаются', async () => {
  const box = host();
  const { watcher, store } = watcherFor(box);
  await watcher.tick();
  await watcher.tick();

  const beat = readHeartbeat(store.heartbeat);
  assert.ok(beat, 'heartbeat записан на тике');
  assert.equal(beat.scanned, 0, 'в пустом ящике осмотрено 0 файлов');
  assert.equal(heartbeatState({ file: store.heartbeat }).alive, true, 'heartbeat живой');

  const rows = decisions(store);
  const summary = journalSummary(rows);
  assert.ok(summary.scanned >= 1, 'журнал различает scanned: строка скана есть');
  assert.ok(summary.lastScanAt, 'в строке скана названо время');
  assert.equal(summary.letters, 0, 'писем нет — это ноль писем, а не тишина');
  const scan = rows.find((row) => row.branch === 'scanned');
  assert.ok(scan && scan.state === 'scanned', 'строка скана имеет состояние scanned');
  assert.equal(Number(scan.scanned), 0, 'watermark: осмотрено 0 файлов');
  assert.ok(/\+03:00$/u.test(String(scan.at)), 'время журнала в МСК с явным смещением');

  const before = rows.length;
  await watcher.tick();
  assert.equal(decisions(store).length, before, 'повторный тик с тем же watermark не растит журнал');

  writeHeartbeat(store.heartbeat, { lastTickAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), scanned: 0 });
  const stale = heartbeatState({ file: store.heartbeat });
  assert.equal(stale.alive, false, 'старый heartbeat — не «жив»');
  assert.equal(stale.reason, 'stale-heartbeat', 'старость названа отдельно');
  const missing = heartbeatState({ file: path.join(store.dir, 'runs', 'absent.json') });
  assert.equal(missing.reason, 'no-heartbeat', 'отсутствие файла названо отдельно');
});

/* ------------------------------------------------------------------ */
/* c5: четыре состояния журнала                                        */
/* ------------------------------------------------------------------ */
await atest('0210 c5: состояния журнала scanned/delivered/pending/error различаются', async () => {
  assert.equal(journalStateOf('scanned'), 'scanned');
  assert.equal(journalStateOf('delivered'), 'delivered');
  assert.equal(journalStateOf('rescan:delivered'), 'delivered');
  assert.equal(journalStateOf('no-session'), 'pending');
  assert.equal(journalStateOf('skip:delivery-off'), 'pending');
  assert.equal(journalStateOf('gate:invited'), 'pending');
  assert.equal(journalStateOf('error:служба не приняла'), 'error');
  assert.equal(journalStateOf(''), 'pending');
});

/* ------------------------------------------------------------------ */
/* c6: перезапуск не теряет письмо, положенное при занятой сессии      */
/* ------------------------------------------------------------------ */
await atest('0210 c6: перезапуск сторожа не теряет письмо, положенное при занятой сессии', async () => {
  const box = host();
  const store = storeOf(box);
  const target = agent(box, { running: true });
  const first = watcherFor(box, { agents: [target], store });
  await first.watcher.tick();
  const letter = writeLetter(box, 'survives-restart.md');
  /* Сторож остановлен до того, как успел вручить: письмо остаётся в ящике. */
  first.watcher.stop();
  const second = watcherFor(box, { agents: [target], store });
  try {
    await second.watcher.tick();
    assert.equal(target.inbox.length, 1, 'после перезапуска письмо доставлено');
    assert.ok(second.watcher.seen.has(letter), 'письмо отмечено вручённым');
    await sleep(120);
    assert.equal(target.inbox.length, 1, 'второй доставки нет');
  } finally {
    second.watcher.stop();
  }
});

/* ------------------------------------------------------------------ */
/* c7: поведение lib/index.js — session/event turn/start и heartbeat-only */
/* ------------------------------------------------------------------ */
await atest('0212 c7: turn/start запускает скан и доставку; slow-режим доставляет при exchangeWatch:false', async () => {
  const box = host();
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0210-apply-runs-'));
  const target = agent(box, { running: false });
  const listeners = [];
  const disposers = [];
  const ctx = {
    agents: { roots: () => [target], list: () => [target] },
    on(event, handler) {
      listeners.push({ event, handler });
      return () => {};
    },
    effect(fn) {
      disposers.push(fn);
      return fn;
    },
    inject() {
      /* Сервисы хоста стенду не нужны: доставка идёт в живого агента ctx.agents. */
    },
    logger: { warn() {} },
  };
  assert.ok(fs.existsSync(INDEX_PATH), 'проверяемый lib/index.js существует: ' + INDEX_PATH);
  const { apply } = await import(pathToFileURL(INDEX_PATH).href);
  try {
    /* heartbeatMs ускоряет только таймер стенда: боевой период остаётся 60 с. */
    apply(ctx, {
      roots: [box.structure, box.workflow],
      runsDir,
      schedule: false,
      exchangeWatch: false,
      wakeSpawn: false,
      heartbeatMs: 80,
    });
    const letter = writeLetter(box, 'start-hook.md');
    const heartbeatFile = path.join(runsDir, 'exchange-watch.json');
    const journal = path.join(runsDir, 'exchange-decisions.jsonl');
    assert.ok(await waitFor(() => fs.existsSync(heartbeatFile), 3000),
      'при exchangeWatch:false apply запускает heartbeat-only таймер');
    const beat = readHeartbeat(heartbeatFile);
    assert.equal(beat.producer, 'exchange-watch', 'heartbeat называет производителя');
    assert.ok(Number.isInteger(beat.pid) && beat.pid > 0, 'heartbeat называет pid');
    /*
     * 0212: медленный режим обязан доставлять, а не только писать живость.
     * Инцидент 11.11: heartbeat был свежим, scanned замер, письма не доходили.
     */
    assert.ok(await waitFor(() => target.inbox.length === 1, 3000),
      'exchangeWatch:false — медленный скан доставляет письмо');
    assert.ok(await waitFor(() => fs.existsSync(journal)
      && readDecisionRows(journal).some((row) => row.state === 'delivered'
        && String(row.letter || '').endsWith('start-hook.md'))), 'журнал: письмо доставлено медленным сканом');

    const hook = listeners.find((item) => item.event === 'session/event');
    assert.ok(hook, 'lib/index.js подписан на session/event');
    hook.handler({ id: 'session-new' }, { type: 'turn/start' });
    assert.ok(await waitFor(() => target.inbox.length === 1), 'turn/start запустил скан и доставку');
    /* Журнал появляется строкой скана раньше строки вручения: ждём именно delivered. */
    assert.ok(await waitFor(() => fs.existsSync(journal)
      && readDecisionRows(journal).some((row) => row.state === 'delivered'
        && String(row.letter || '').endsWith('start-hook.md'))), 'журнал: письмо доставлено по хуку старта сессии');
    const delivered = readDecisionRows(journal).filter((row) => row.state === 'delivered'
      && String(row.letter || '').endsWith('start-hook.md'));
    assert.equal(delivered.length, 1, 'журнал: ровно одна запись delivered по письму');
    assert.ok(watcherHeartbeatScanned(heartbeatFile) >= 1, 'скан хука обновил heartbeat');
    hook.handler({ id: 'session-new' }, { type: 'turn/start' });
    await sleep(160);
    assert.equal(target.inbox.length, 1, 'окно 2 с гасит повторный turn/start');
    assert.ok(letter.endsWith('start-hook.md'), 'письмо стенда на месте');
    /* Маркер для checks/0210 c5: сценарий действительно исполнился, а не пропущен. */
    console.log('0210 c7 OK: session/event turn/start доставил письмо');
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* выгрузка плагина не имеет права уронить тест */
      }
    }
  }
});

/** Счётчик осмотренных файлов из живого heartbeat; 0, если файла ещё нет. */
function watcherHeartbeatScanned(file) {
  const row = readHeartbeat(file);
  return row ? row.scanned : 0;
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(String(failure.error && failure.error.stack ? failure.error.stack : failure.error));
  }
  console.error('EXCHANGE DELIVERY TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('EXCHANGE DELIVERY TEST OK: ' + passed + '/' + passed);
