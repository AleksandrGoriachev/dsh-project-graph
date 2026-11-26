#!/usr/bin/env node
/**
 * 0295 — presence папки письма: каталог письма — факт, а не объявление.
 *
 * Набор доказывает обещания контракта:
 *   - presenceForLetterBox читает ТОЛЬКО свой каталог письма:
 *     <boxDir>/presence/<workspace>.json;
 *   - свежая запись называет сессию и причину presence;
 *   - устаревшая запись, отсутствующий файл или чужой каталог — null;
 *   - доставка читает presence папки письма ДАЖЕ когда папка не объявлена в
 *     структуре (живой случай письма --189: presence называл сессию, а письмо
 *     ушло старой сессии, потому что чтение гейтилось declaredBoxKeys);
 *   - без файла в папке письма поведение прежнее: last-active;
 *   - R1 ревью: чужой presence с именем basename(target) не адресат — alias не
 *     читается, своего файла нет, цель остаётся прежней (last-active).
 *
 *   node test/presence-letter-box.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Дом подменяется до импорта модулей: телеметрия сторожа не имеет права попадать
 * в живой ~/.dsh (правило П-4 docs/structure-rules.md).
 */
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0295-home-'));
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;
process.env.DSH_PROFILE_DIR = path.join(isolatedHome, 'profile');
delete process.env.DSH_PROFILE;

const {
  createExchangeWatcher, presenceForLetterBox, writeSessionPresence,
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
  'Subject: письмо --189',
  '',
  'тело письма',
  '',
].join('\n');

/* ------------------------------------------------------------------ */
/* C1: presenceForLetterBox — свежий, устаревший, нет файла, чужая     */
/* ------------------------------------------------------------------ */
await atest('0295 c1: свежий файл папки письма называет сессию и причину presence', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0295-fresh-'));
  const box = path.join(base, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  const record = writeSessionPresence({ box, workspace: 'ws', sessionId: 'session-letter' });
  assert.ok(record, 'presence записан в папку письма');
  assert.ok(fs.existsSync(path.join(box, 'presence', 'ws.json')), 'файл лежит в <box>/presence/ws.json');

  const hit = presenceForLetterBox({ boxDir: box, workspace: 'ws' });
  assert.ok(hit, 'свежий presence найден');
  assert.equal(hit.sessionId, 'session-letter');
  assert.equal(hit.reason, 'presence', 'причина — presence, как в 0292');
});

await atest('0295 c1: устаревшая запись папки письма не адресат', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0295-stale-'));
  const box = path.join(base, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  writeSessionPresence({
    box,
    workspace: 'ws',
    sessionId: 'session-old',
    at: new Date(Date.now() - 48 * 60 * 60 * 1000),
  });
  assert.equal(
    presenceForLetterBox({ boxDir: box, workspace: 'ws', now: Date.now(), ttlMs: 60 * 60 * 1000 }),
    null,
    'устаревшая запись — null',
  );
  assert.equal(presenceForLetterBox({ boxDir: box, workspace: 'ws' }), null,
    'запись старше суток не свежа и по умолчанию');
});

await atest('0295 c1: нет файла в папке письма — null', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0295-missing-'));
  const empty = path.join(base, 'empty-box');
  fs.mkdirSync(empty, { recursive: true });
  assert.equal(presenceForLetterBox({ boxDir: empty, workspace: 'ws' }), null,
    'каталог без presence — null');
  assert.equal(presenceForLetterBox({ boxDir: path.join(base, 'no-such'), workspace: 'ws' }), null,
    'несуществующий каталог — null');
  /* Файл есть, но он про ДРУГОЙ воркспейс — не этот адресат. */
  writeSessionPresence({ box: empty, workspace: 'other', sessionId: 'session-other' });
  assert.equal(presenceForLetterBox({ boxDir: empty, workspace: 'ws' }), null,
    'файл другого воркспейса — null');
  assert.equal(presenceForLetterBox({ boxDir: '', workspace: 'ws' }), null, 'пустой каталог — null');
});

await atest('0295 c1: presence другой папки не виден', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0295-foreign-'));
  const boxA = path.join(base, 'box-a');
  const boxB = path.join(base, 'box-b');
  fs.mkdirSync(boxA, { recursive: true });
  fs.mkdirSync(boxB, { recursive: true });
  writeSessionPresence({ box: boxA, workspace: 'ws', sessionId: 'session-a' });
  assert.equal(presenceForLetterBox({ boxDir: boxB, workspace: 'ws' }), null,
    'чужая папка не подхватила presence');
  assert.equal(presenceForLetterBox({ boxDir: path.join(boxA, 'threads'), workspace: 'ws' }), null,
    'вложенный каталог письма не читает presence родительской папки');
  writeSessionPresence({ box: boxB, workspace: 'ws', sessionId: 'session-b' });
  assert.equal(presenceForLetterBox({ boxDir: boxA, workspace: 'ws' }).sessionId, 'session-a');
  assert.equal(presenceForLetterBox({ boxDir: boxB, workspace: 'ws' }).sessionId, 'session-b',
    'каждая папка называет свою сессию');
});

/* ------------------------------------------------------------------ */
/* C2: доставка читает presence папки письма без опоры на объявление   */
/* ------------------------------------------------------------------ */
function hostWithUndeclaredLetterBox() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0295-deliver-'));
  const structure = path.join(parent, 'dsh-project-graph');
  const workflow = path.join(parent, 'default-workspace');
  fs.mkdirSync(structure, { recursive: true });
  fs.mkdirSync(workflow, { recursive: true });
  /* Папка письма рядом с воркспейсами: discovered, но НЕ объявлена структурой. */
  const box = path.join(parent, 'coordination');
  const thread = path.join(box, 'threads', 'critic-report');
  fs.mkdirSync(thread, { recursive: true });
  const readme = '# Канал\n\n'
    + '| Сторона | Пространство | Что делает |\n'
    + '| --- | --- | --- |\n'
    + '| `workflow` | `' + workflow.replace(/\\/gu, '/') + '` | спека |\n'
    + '| `structure` | `' + structure.replace(/\\/gu, '/') + '` | панель |\n';
  fs.writeFileSync(path.join(box, 'README.md'), readme, 'utf8');
  return { parent, structure, workflow, box, thread };
}

function storeOf(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    seen: path.join(dir, 'exchange-seen.json'),
    decisions: path.join(dir, 'exchange-decisions.jsonl'),
    heartbeat: path.join(dir, 'runs', 'exchange-watch.json'),
  };
}

function runtimeOf(roots) {
  return {
    allowedRoots: () => roots.slice(),
    /* Объявленных папок нет: гейт declaredBoxKeys сюда не достаёт. */
    exchange: [],
    participants: {},
    me: null,
    runs: new Map(),
    runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0295-runs-')),
  };
}

function agent(sessionId, cwd) {
  return { id: sessionId, sessionId, cwd, label: 'workflow', running: false, inbox: [], async sendMessage() {} };
}

await atest('0295 c2: доставка читает presence необъявленной папки письма', async () => {
  const host = hostWithUndeclaredLetterBox();
  const store = storeOf('pg-0295-deliver-store-');
  const oldAgent = agent('session-old', host.workflow);
  const prompted = [];
  writeSessionPresence({ box: host.box, workspace: 'workflow', sessionId: 'session-letter-189' });
  const watcher = createExchangeWatcher({
    runtime: runtimeOf([host.structure, host.workflow]),
    seenPath: store.seen,
    decisionsPath: store.decisions,
    heartbeatPath: store.heartbeat,
    getAgents: () => ({ list: () => [oldAgent] }),
    activityOf: (root) => (path.resolve(root).toLowerCase() === path.resolve(host.workflow).toLowerCase()
      ? new Map([['session-old', Date.now()]])
      : new Map()),
    getSessionController: () => ({ async prompt(request) { prompted.push(request.sessionId); return { ok: true }; } }),
    wakeSpawn: false,
    tickMs: 30,
  });
  try {
    const letter = path.join(host.thread, 'letter-189.md');
    fs.writeFileSync(letter, HEAD('structure', 'workflow'), 'utf8');
    const delivered = await watcher.tick();
    assert.equal(delivered.length, 1, 'письмо вручено');
    assert.equal(delivered[0].target, 'session-letter-189',
      'адресат — сессия presence ПАПКИ ПИСЬМА, а не старой сессии');
    assert.equal(delivered[0].reason, 'presence', 'причина — presence папки письма');
    assert.deepEqual(prompted, ['session-letter-189']);
    assert.ok(watcher.seen.has(letter), 'письмо отмечено доставленным');
  } finally {
    watcher.stop();
  }
});

await atest('0295 c2: без presence папки письма доставка идёт прежней схемой', async () => {
  const host = hostWithUndeclaredLetterBox();
  const store = storeOf('pg-0295-deliver-store2-');
  const oldAgent = agent('session-old', host.workflow);
  const prompted = [];
  const watcher = createExchangeWatcher({
    runtime: runtimeOf([host.structure, host.workflow]),
    seenPath: store.seen,
    decisionsPath: store.decisions,
    heartbeatPath: store.heartbeat,
    getAgents: () => ({ list: () => [oldAgent] }),
    activityOf: (root) => (path.resolve(root).toLowerCase() === path.resolve(host.workflow).toLowerCase()
      ? new Map([['session-old', Date.now()]])
      : new Map()),
    getSessionController: () => ({ async prompt(request) { prompted.push(request.sessionId); return { ok: true }; } }),
    wakeSpawn: false,
    tickMs: 30,
  });
  try {
    fs.writeFileSync(path.join(host.thread, 'letter-nobody.md'), HEAD('structure', 'workflow'), 'utf8');
    const delivered = await watcher.tick();
    assert.equal(delivered.length, 1, 'письмо вручено прежней схемой');
    assert.equal(delivered[0].target, 'session-old', 'цель — last-active своего воркспейса');
    assert.equal(delivered[0].reason, 'last-active', 'причина прежней схемы');
  } finally {
    watcher.stop();
  }
});

await atest('0295 c2/R1: чужой presence с именем basename(target) не адресат', async () => {
  const host = hostWithUndeclaredLetterBox();
  const store = storeOf('pg-0295-deliver-store3-');
  const oldAgent = agent('session-old', host.workflow);
  const prompted = [];
  /*
   * В папке письма есть ТОЛЬКО presence чужого воркспейса, чьё имя совпадает с
   * basename корня адресата. Своего файла (workflow.json) нет. Раньше доставка
   * передавала aliases: [basename(target)] — и письмо уходило session-foreign.
   */
  const foreign = path.basename(host.workflow);
  writeSessionPresence({ box: host.box, workspace: foreign, sessionId: 'session-foreign' });
  assert.equal(
    presenceForLetterBox({ boxDir: host.box, workspace: 'workflow', aliases: [foreign] }),
    null,
    'alias basename(target) не читает чужой presence',
  );
  const watcher = createExchangeWatcher({
    runtime: runtimeOf([host.structure, host.workflow]),
    seenPath: store.seen,
    decisionsPath: store.decisions,
    heartbeatPath: store.heartbeat,
    getAgents: () => ({ list: () => [oldAgent] }),
    activityOf: (root) => (path.resolve(root).toLowerCase() === path.resolve(host.workflow).toLowerCase()
      ? new Map([['session-old', Date.now()]])
      : new Map()),
    getSessionController: () => ({ async prompt(request) { prompted.push(request.sessionId); return { ok: true }; } }),
    wakeSpawn: false,
    tickMs: 30,
  });
  try {
    fs.writeFileSync(path.join(host.thread, 'letter-alias.md'), HEAD('structure', 'workflow'), 'utf8');
    const delivered = await watcher.tick();
    assert.equal(delivered.length, 1, 'письмо вручено');
    assert.equal(delivered[0].target, 'session-old',
      'цель — старая схема (last-active), а не чужая сессия');
    assert.equal(delivered[0].reason, 'last-active', 'причина — last-active, не presence');
    assert.ok(!delivered.some((item) => item.target === 'session-foreign'),
      'чужой сессии письма не вручали');
  } finally {
    watcher.stop();
  }
});

/* ------------------------------------------------------------------ */
if (failures.length > 0) {
  console.error('\n0295: провалено ' + failures.length + ', пройдено ' + passed);
  process.exitCode = 1;
} else {
  console.log('0295 OK: presence папки письма (пройдено ' + passed + ')');
}
