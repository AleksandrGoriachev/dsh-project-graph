/**
 * 0340 — авто-подключение найденного ящика к скану текущего прохода.
 *
 * 0339 находил ящик, созданный рядом с воркспейсом (sibling/coordination/threads),
 * но только сообщал о нём: письма в нём не доставлялись. Здесь проверяется
 * поведение, а не реализация:
 *
 *   c1  sibling-ящик с письмом адресату подключён к проходу: письмо доставлено
 *       живой сессии, отмечено вручённым и названо в журнале решений;
 *   c2  следующий проход не доставляет его второй раз (память вручений), но снова
 *       подключает ящик — подключение живёт в памяти прохода, а не в профиле;
 *   c3  отчёт heartbeat/status/телеметрия называет addedBoxes и watchedCount,
 *       предупреждение называет путь, профиль не пишется;
 *   c4  фильтр подключения: только пути внутри родителя разрешённых корней, без
 *       дублей; watched-ящик не добавляется.
 *
 * Дом подменяется до импорта модуля: телеметрия стенда не имеет права
 * попадать в живой ~/.dsh (правило П-4 docs/structure-rules.md).
 *
 *   node test/exchange-watch-autowatch.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0340-home-'));
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;
process.env.DSH_PROFILE_DIR = path.join(isolatedHome, 'profile');

const {
  autowatchExchangeBoxes,
  createExchangeWatcher,
  readHeartbeat,
  WATCH_TELEMETRY_PATH,
} = await import('../lib/exchange-watch.js');

assert.ok(
  WATCH_TELEMETRY_PATH.toLowerCase().startsWith(isolatedHome.toLowerCase()),
  'телеметрия стенда пишется в подменённый дом',
);

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

const key = (value) => String(value).replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase();

/**
 * Воркспейс watched и сосед sibling со своим ящиком; письмо в sibling-ящике
 * адресовано watched. Общий ящик рядом с воркспейсами уже сканируется.
 */
function host() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0340-'));
  const root = path.join(parent, 'watched');
  const sibling = path.join(parent, 'sibling');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  const watchedBox = path.join(parent, 'coordination');
  const siblingBox = path.join(sibling, 'coordination');
  fs.mkdirSync(path.join(watchedBox, 'threads', 'critic-report'), { recursive: true });
  fs.mkdirSync(path.join(siblingBox, 'threads', 'critic-report'), { recursive: true });
  const letter = path.join(siblingBox, 'threads', 'critic-report', 'letter.md');
  fs.writeFileSync(letter, [
    'From: sibling',
    'To: watched',
    'Date: ' + new Date().toISOString(),
    'Thread: critic-report',
    'Status: request',
    'Subject: письмо из sibling-ящика',
    '',
    'тело письма',
    '',
  ].join('\n'), 'utf8');
  return { parent, root, sibling, watchedBox, siblingBox, letter };
}

function storeOf() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0340-store-'));
  return {
    dir,
    seen: path.join(dir, 'exchange-seen.json'),
    decisions: path.join(dir, 'exchange-decisions.jsonl'),
    heartbeat: path.join(dir, 'runs', 'exchange-watch.json'),
  };
}

/** Живой агент адресата: письмо доставлено, когда сессия его приняла. */
function agent(id, cwd, label) {
  const inbox = [];
  return {
    id,
    sessionId: id,
    cwd,
    label,
    sendMessage: async (input) => { inbox.push(input.content?.[0]?.text); },
    inbox,
  };
}

function decisions(store) {
  if (!fs.existsSync(store.decisions)) return [];
  return fs.readFileSync(store.decisions, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/* ------------------------------------------------------------------ */
/* c1/c2/c3: sibling-письмо доставлено, отчёт назван, повтор не дублирует */
/* ------------------------------------------------------------------ */
await atest('0340 c1: sibling-ящик с письмом адресату доставляется в том же проходе', async () => {
  const box = host();
  const store = storeOf();
  const warnings = [];
  const target = agent('s-watched', box.root, 'watched');
  const runtime = {
    allowedRoots: () => [box.root],
    exchange: [],
    participants: {},
    me: null,
    runs: new Map(),
    runsDir: store.dir,
  };
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: store.seen,
    decisionsPath: store.decisions,
    heartbeatPath: store.heartbeat,
    wakeSpawn: false,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-watched', Date.now()]]),
    logger: { warn: (message) => warnings.push(String(message)) },
  });
  try {
    const delivered = await watcher.tick();
    assert.equal(delivered.length, 1, 'письмо sibling-ящика доставлено в первом проходе');
    assert.equal(target.inbox.length, 1, 'живая сессия адресата приняла письмо');
    assert.match(target.inbox[0], /letter\.md/u, 'пробуждение называет письмо');
    assert.ok(watcher.seen.has(box.letter), 'письмо отмечено вручённым');

    const row = decisions(store).find((item) => item.branch === 'delivered'
      && String(item.letter || '').endsWith('letter.md'));
    assert.ok(row, 'журнал решений называет доставку');
    assert.equal(key(row.box), key(box.siblingBox), 'ящик письма — sibling, а не общий портал');

    const beat = readHeartbeat(store.heartbeat);
    assert.ok(beat, 'heartbeat записан');
    assert.equal(beat.addedCount, 1, 'heartbeat называет подключённый ящик');
    assert.equal(key(beat.addedBoxes[0]), key(box.siblingBox), 'heartbeat называет его путь');
    assert.equal(beat.watchedCount, 2, 'watchedCount: общий ящик и sibling вместе');
    assert.equal(beat.unwatchedBoxes.length, 0, 'подключённый ящик не числится непросмотренным');

    const status = watcher.status();
    assert.equal(status.addedCount, 1, 'status называет количество подключённых');
    assert.equal(key(status.addedBoxes[0]), key(box.siblingBox), 'status называет путь');
    assert.equal(status.watchedCount, 2, 'status: скан идёт по двум ящикам');
    assert.equal(status.unwatchedCount, 0, 'status: остаток пуст');

    assert.ok(
      warnings.some((line) => line.toLowerCase().includes(box.siblingBox.toLowerCase())),
      'предупреждение называет полный путь подключённого ящика',
    );

    const lines = fs.readFileSync(WATCH_TELEMETRY_PATH, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const pass = lines.filter((item) => item.event === 'pass').at(-1);
    assert.ok(pass, 'pass-телеметрия записана');
    assert.equal(pass.addedCount, 1, 'телеметрия называет количество подключённых');
    assert.equal(key(pass.addedBoxes[0]), key(box.siblingBox), 'телеметрия называет путь');
    assert.equal(pass.watchedCount, 2, 'телеметрия называет просканированные ящики');

    /* Профиль — не память процесса: авто-подключение не пишет конфиг. */
    assert.equal(fs.existsSync(path.join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml')), false,
      'профиль не изменён');

    /* c2: повторный проход не доставляет письмо второй раз. */
    const again = await watcher.tick(new Date(Date.now() + 121_000));
    assert.equal(again.length, 0, 'повторный проход не доставляет письмо второй раз');
    assert.equal(target.inbox.length, 1, 'второго пробуждения нет');
    assert.equal(watcher.status().addedCount, 1, 'ящик снова подключён: список собирается с диска');
    assert.equal(watcher.seen.has(box.letter), true, 'память вручений сохранена');
  } finally {
    watcher.stop();
  }
});

/* ------------------------------------------------------------------ */
/* c4: фильтр подключения — родитель корней, без дублей, watched не трогаем */
/* ------------------------------------------------------------------ */
await atest('0340 c4: подключаются только ящики внутри родителя корней, без дублей', async () => {
  const box = host();
  const outsideParent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0340-outside-'));
  const outsideBox = path.join(outsideParent, 'coordination');
  fs.mkdirSync(path.join(outsideBox, 'threads'), { recursive: true });
  const added = autowatchExchangeBoxes({
    allowedRoots: [box.root],
    unwatchedBoxes: [box.siblingBox, box.siblingBox, box.watchedBox, outsideBox],
    watchedBoxes: [box.watchedBox],
  });
  assert.deepEqual(added.map(key), [key(box.siblingBox)],
    'только sibling внутри родителя; дубль и watched не добавляются, чужой путь отклонён');
});

/* ------------------------------------------------------------------ */
if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL ' + failure.name);
    console.error(failure.error && failure.error.stack ? failure.error.stack : String(failure.error));
  }
  console.error('EXCHANGE-WATCH-AUTOWATCH TEST FAILED: ' + passed + '/' + (passed + failures.length));
  process.exit(1);
}
console.log('EXCHANGE-WATCH-AUTOWATCH TEST OK: ' + passed + '/' + passed);
