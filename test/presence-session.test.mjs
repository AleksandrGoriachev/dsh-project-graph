#!/usr/bin/env node
/**
 * 0292 — presence сессии воркспейса.
 *
 * Набор доказывает обещания контракта:
 *   - запись presence атомарна (tmp+rename), читается обратно и НЕ бросает при сбое;
 *   - свежесть решается двумя способами: живая сессия или at не старше TTL;
 *   - чужая и устаревшая запись не становятся адресатом;
 *   - доставка письма адресуется сессии из свежего presence (reason = presence),
 *     а без свежего presence работает прежняя схема выбора цели.
 *
 *   node test/presence-session.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Дом подменяется до импорта модуля: телеметрия сторожа не имеет права попадать
 * в живой ~/.dsh (правило П-4 docs/structure-rules.md).
 */
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-home-'));
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;
process.env.DSH_PROFILE_DIR = path.join(isolatedHome, 'profile');
delete process.env.DSH_PROFILE;

const {
  PRESENCE_TTL_MS, createExchangeWatcher, presenceFresh, presenceTarget,
  readSessionPresence, writeSessionPresence,
} = await import('../lib/exchange-watch.js');

let passed = 0;
const failures = [];
async function atest(name, body) {
  try {
    await body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : error));
  }
}

const HEAD = (from, to, status = 'request') => [
  'From: ' + from,
  'To: ' + to,
  'Date: ' + new Date().toISOString(),
  'Thread: critic-report',
  'Status: ' + status,
  'Subject: письмо presence',
  '',
  'тело письма',
  '',
].join('\n');

/** Два воркспейса и общий ящик рядом с ними — та же раскладка, что у живого хоста. */
function host() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-'));
  const structure = path.join(parent, 'dsh-project-graph');
  const workflow = path.join(parent, 'default-workspace');
  fs.mkdirSync(structure, { recursive: true });
  fs.mkdirSync(workflow, { recursive: true });
  const box = path.join(parent, 'coordination');
  const thread = path.join(box, 'threads', 'critic-report');
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

function storeOf() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-store-'));
  return {
    dir,
    seen: path.join(dir, 'exchange-seen.json'),
    decisions: path.join(dir, 'exchange-decisions.jsonl'),
    heartbeat: path.join(dir, 'runs', 'exchange-watch.json'),
  };
}

function runtimeOf(roots) {
  return {
    allowedRoots: () => roots.slice(),
    exchange: [],
    participants: {},
    me: null,
    runs: new Map(),
    runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-runs-')),
  };
}

/** Живой агент адресата: запоминает вручённое. */
function agent(sessionId, cwd) {
  const inbox = [];
  return {
    id: sessionId,
    sessionId,
    cwd,
    label: 'workflow',
    running: false,
    inbox,
    async sendMessage(input) {
      inbox.push(input && input.content && input.content[0] ? input.content[0].text : input);
    },
  };
}

function decisions(store) {
  if (!fs.existsSync(store.decisions)) return [];
  return fs.readFileSync(store.decisions, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function writeLetter(box, name) {
  const file = path.join(box.thread, name);
  fs.writeFileSync(file, HEAD('structure', 'workflow'), 'utf8');
  return file;
}

/* ------------------------------------------------------------------ */
/* c1: запись/чтение, атомарность и сбой без исключения                */
/* ------------------------------------------------------------------ */
await atest('0292 c1: presence записан атомарно, прочитан обратно, tmp не остаётся', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-presence-'));
  const record = writeSessionPresence({ root, workspace: 'ws-a', sessionId: 'session-abc' });
  assert.ok(record, 'writeSessionPresence вернул запись');
  assert.equal(record.version, 1);
  assert.equal(record.workspace, 'ws-a');
  assert.equal(record.sessionId, 'session-abc');
  assert.ok(Number.isFinite(Date.parse(record.at)), 'at — разбираемая дата');

  const file = path.join(root, 'coordination', 'presence', 'ws-a.json');
  assert.ok(fs.existsSync(file), 'файл coordination/presence/ws-a.json существует');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, record, 'на диске ровно та запись, что вернули');
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'временных файлов после rename не осталось');

  const back = readSessionPresence(root, 'ws-a');
  assert.ok(back && back.sessionId === 'session-abc', 'readSessionPresence читает запись');
  assert.equal(readSessionPresence(root, 'ws-нет'), null, 'чужой воркспейс — null');
  assert.equal(readSessionPresence(path.join(root, 'нет-корня'), 'ws-a'), null, 'нет файла — null');
});

await atest('0292 c1: сбой записи возвращает null и не бросает', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-broken-'));
  /* Корень — обычный файл: mkdir внутри него обязан упасть, а функция — не бросить. */
  const notADir = path.join(dir, 'file.txt');
  fs.writeFileSync(notADir, 'не каталог', 'utf8');
  let result;
  assert.doesNotThrow(() => {
    result = writeSessionPresence({ root: notADir, workspace: 'ws-b', sessionId: 'session-x' });
  }, 'сбой записи не бросает');
  assert.equal(result, null, 'сбой записи — null');
});

/* ------------------------------------------------------------------ */
/* c1: свежесть по TTL и по живости                                    */
/* ------------------------------------------------------------------ */
await atest('0292 c1: presenceFresh — TTL 24 ч и живая сессия', async () => {
  const now = 1000000;
  const fresh = { sessionId: 's', at: new Date(now - 1000).toISOString() };
  const old = { sessionId: 's', at: new Date(now - 120000).toISOString() };
  assert.equal(PRESENCE_TTL_MS, 24 * 60 * 60 * 1000, 'TTL по умолчанию — 24 ч');
  assert.equal(presenceFresh(fresh, { now, ttlMs: 60000 }), true, 'свежий признан свежим');
  assert.equal(presenceFresh(old, { now, ttlMs: 60000 }), false, 'старый признан старым');
  assert.equal(presenceFresh(old, { now, ttlMs: 60000, isLive: true }), true, 'живая сессия свежа независимо от TTL');
  assert.equal(presenceFresh({ sessionId: 's', at: 'не дата' }, { now }), false, 'без разбираемой даты — не свежий');
  assert.equal(presenceFresh(null, { now }), false, 'нет записи — не свежий');
});

/* ------------------------------------------------------------------ */
/* c2: адресация — свежая запись, чужая и устаревшая отсекаются        */
/* ------------------------------------------------------------------ */
await atest('0292 c2: presenceTarget берёт только свежую запись своего воркспейса', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-target-'));
  writeSessionPresence({ root, workspace: 'ws-a', sessionId: 'session-xyz' });
  const fresh = presenceTarget({ root, workspace: 'ws-a' });
  assert.ok(fresh, 'свежая запись найдена');
  assert.equal(fresh.sessionId, 'session-xyz');
  assert.equal(fresh.reason, 'presence');
  assert.equal(presenceTarget({ root, workspace: 'ws-b' }), null, 'чужая сессия не адресат');

  writeSessionPresence({ root, workspace: 'ws-c', sessionId: 'session-old', at: new Date(Date.now() - 48 * 60 * 60 * 1000) });
  assert.equal(presenceTarget({ root, workspace: 'ws-c', now: Date.now(), ttlMs: 60 * 60 * 1000 }), null,
    'устаревшая запись не адресат');
  const live = presenceTarget({ root, workspace: 'ws-c', now: Date.now(), ttlMs: 60 * 60 * 1000, isLive: () => true });
  assert.ok(live && live.sessionId === 'session-old', 'живая сессия делает запись свежей');

  /* alias: запись по имени папки находится по метке обмена */
  const aliased = presenceTarget({ root, workspace: 'workflow', aliases: ['ws-a'], now: Date.now() });
  assert.ok(aliased && aliased.sessionId === 'session-xyz', 'alias находит запись');
});

/* ------------------------------------------------------------------ */
/* c2: доставка — presence раньше старой схемы, reason = presence      */
/* ------------------------------------------------------------------ */
await atest('0292 c2: письмо адресуется сессии из presence, reason = presence', async () => {
  const box = host();
  const store = storeOf();
  const oldAgent = agent('session-old', box.workflow);
  const prompted = [];
  const controller = {
    async prompt(request) { prompted.push(request.sessionId); return { ok: true }; },
  };
  /* presence записан по имени папки; метка обмена знает другую сторону как workflow. */
  writeSessionPresence({
    root: box.workflow,
    workspace: path.basename(box.workflow),
    sessionId: 'session-presence-1',
  });
  const watcher = createExchangeWatcher({
    runtime: runtimeOf([box.structure, box.workflow]),
    seenPath: store.seen,
    decisionsPath: store.decisions,
    heartbeatPath: store.heartbeat,
    getAgents: () => ({ list: () => [oldAgent] }),
    activityOf: (root) => (path.resolve(root).toLowerCase() === path.resolve(box.workflow).toLowerCase()
      ? new Map([['session-old', Date.now()]])
      : new Map()),
    getSessionController: () => controller,
    wakeSpawn: false,
    tickMs: 30,
  });
  try {
    const letter = writeLetter(box, 'presence-addressed.md');
    const delivered = await watcher.tick();
    assert.equal(prompted.length, 1, 'пробуждена ровно одна сессия');
    assert.equal(prompted[0], 'session-presence-1', 'адресат — сессия из presence, не last-active');
    assert.equal(oldAgent.inbox.length, 0, 'прежняя сессия письмо не получила');
    assert.equal(delivered.length, 1, 'письмо вручено');
    assert.equal(delivered[0].reason, 'presence', 'причина вручения — presence');
    assert.equal(delivered[0].target, 'session-presence-1', 'цель вручения — сессия presence');
    const row = decisions(store).find((item) => String(item.letter || '').endsWith('presence-addressed.md')
      && item.state === 'delivered');
    assert.ok(row, 'журнал называет вручение');
    assert.equal(row.session, 'session-presence-1', 'в журнале — сессия presence');
    assert.ok(watcher.seen.has(letter), 'письмо отмечено доставленным');
  } finally {
    watcher.stop();
  }
});

await atest('0292 R1: presence-сессия первая в очереди, даже если журнал знает её и живую сессию свежее', async () => {
  const box = host();
  const store = storeOf();
  const live = agent('session-live', box.workflow);
  const prompted = [];
  const controller = {
    async prompt(request) { prompted.push(request.sessionId); return { ok: true }; },
  };
  writeSessionPresence({
    root: box.workflow,
    workspace: path.basename(box.workflow),
    sessionId: 'session-presence',
  });
  const watcher = createExchangeWatcher({
    runtime: runtimeOf([box.structure, box.workflow]),
    seenPath: store.seen,
    decisionsPath: store.decisions,
    heartbeatPath: store.heartbeat,
    getAgents: () => ({ list: () => [live] }),
    /*
     * Журнал знает ОБЕ сессии, и session-live свежее: до правки deliverableSessions
     * ставил её первой, а presence уже был в списке — unshift не срабатывал.
     */
    activityOf: (root) => (path.resolve(root).toLowerCase() === path.resolve(box.workflow).toLowerCase()
      ? new Map([['session-live', Date.now()], ['session-presence', Date.now() - 5000]])
      : new Map()),
    getSessionController: () => controller,
    wakeSpawn: false,
    tickMs: 30,
  });
  try {
    writeLetter(box, 'presence-first.md');
    const delivered = await watcher.tick();
    assert.equal(prompted.length, 1, 'пробуждена ровно одна сессия');
    assert.equal(prompted[0], 'session-presence',
      'presence-сессия первая в очереди, хотя журнал ставит session-live свежее');
    assert.equal(delivered.length, 1, 'письмо вручено');
    assert.equal(delivered[0].target, 'session-presence', 'цель вручения — сессия presence');
    assert.equal(delivered[0].reason, 'presence', 'причина вручения — presence, а не session-bus');
  } finally {
    watcher.stop();
  }
});

await atest('0292 R8: мёртвая presence-сессия не обрывает перебор — письмо уходит session-live', async () => {
  const box = host();
  const store = storeOf();
  const live = agent('session-live', box.workflow);
  const attempted = [];
  const controller = {
    async prompt(request) {
      attempted.push(request.sessionId);
      /* Сессия из presence свежа по TTL, но уже удалена: контроллер её не знает. */
      if (request.sessionId === 'session-dead') throw new Error('сессия не найдена');
      return { ok: true };
    },
  };
  writeSessionPresence({
    root: box.workflow,
    workspace: path.basename(box.workflow),
    sessionId: 'session-dead',
  });
  const watcher = createExchangeWatcher({
    runtime: runtimeOf([box.structure, box.workflow]),
    seenPath: store.seen,
    decisionsPath: store.decisions,
    heartbeatPath: store.heartbeat,
    getAgents: () => ({ list: () => [live] }),
    activityOf: (root) => (path.resolve(root).toLowerCase() === path.resolve(box.workflow).toLowerCase()
      ? new Map([['session-live', Date.now()], ['session-dead', Date.now() - 5000]])
      : new Map()),
    getSessionController: () => controller,
    wakeSpawn: false,
    tickMs: 30,
  });
  try {
    const letter = writeLetter(box, 'dead-presence.md');
    const delivered = await watcher.tick();
    assert.deepEqual(attempted, ['session-dead', 'session-live'],
      'после отказа мёртвой presence перебор продолжился, а не оборвался');
    assert.equal(delivered.length, 1, 'письмо вручено живой сессии того же воркспейса');
    assert.equal(delivered[0].target, 'session-live', 'цель — живая сессия старой схемы');
    assert.equal(delivered[0].reason, 'session-bus', 'доставила не presence, причина честная');
    assert.ok(watcher.seen.has(letter), 'письмо отмечено, а не висит до TTL 24 ч');
    const row = decisions(store).find((item) => String(item.letter || '').endsWith('dead-presence.md')
      && item.state === 'delivered');
    assert.ok(row, 'журнал называет вручение');
    assert.equal(row.session, 'session-live', 'в журнале — живая сессия');
  } finally {
    watcher.stop();
  }
});

await atest('0292 c2: без свежего presence работает прежняя схема (last-active)', async () => {
  const box = host();
  const store = storeOf();
  const oldAgent = agent('session-old', box.workflow);
  const prompted = [];
  writeSessionPresence({
    root: box.workflow,
    workspace: path.basename(box.workflow),
    sessionId: 'session-stale',
    at: new Date(Date.now() - 48 * 60 * 60 * 1000),
  });
  const watcher = createExchangeWatcher({
    runtime: runtimeOf([box.structure, box.workflow]),
    seenPath: store.seen,
    decisionsPath: store.decisions,
    heartbeatPath: store.heartbeat,
    getAgents: () => ({ list: () => [oldAgent] }),
    activityOf: (root) => (path.resolve(root).toLowerCase() === path.resolve(box.workflow).toLowerCase()
      ? new Map([['session-old', Date.now()]])
      : new Map()),
    getSessionController: () => ({ async prompt(request) { prompted.push(request.sessionId); return { ok: true }; } }),
    wakeSpawn: false,
    tickMs: 30,
  });
  try {
    writeLetter(box, 'stale-presence.md');
    const delivered = await watcher.tick();
    assert.equal(delivered.length, 1, 'письмо вручено прежней схемой');
    assert.notEqual(delivered[0].target, 'session-stale', 'устаревшая сессия не стала адресатом');
    assert.equal(delivered[0].target, 'session-old', 'цель — last-active живой агент');
    assert.equal(delivered[0].reason, 'last-active', 'причина прежней схемы сохранена');
  } finally {
    watcher.stop();
  }
});

console.log(failures.length === 0
  ? 'PRESENCE SESSION OK: ' + passed + ' проверок — запись/чтение, сбой, свежесть, адресация presence'
  : 'PRESENCE SESSION FAILED: ' + failures.length + ' из ' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
