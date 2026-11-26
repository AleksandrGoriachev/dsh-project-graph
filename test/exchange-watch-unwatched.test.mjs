/**
 * 0339/0340 — детектор непросматриваемых ящиков и авто-подключение найденных.
 *
 * 0339 нашёл ящик, созданный рядом с воркспейсом (sibling/coordination/threads),
 * но только сообщал о нём: письма в нём не доставлялись. 0340 подключает найденный
 * ящик к скану ТЕКУЩЕГО прохода (только в памяти процесса, без записи профиля),
 * поэтому sibling-письмо теперь доставляется адресату.
 *
 *   c1  при одном разрешённом корне и одном sibling-ящике найден ровно один
 *       непросматриваемый путь; watched-ящик и пустой sibling не попадают;
 *   c2  пути не дублируются, даже если корни и watched-ящики повторены; объявленный
 *       ящик считается просматриваемым;
 *   c3  watcher подключает sibling-ящик к проходу: письмо доставляется, отчёт
 *       (addedBoxes/watchedCount/предупреждение) называет ящик, профиль не пишется.
 *
 * Дом подменяется до импорта модуля: телеметрия стенда не имеет права
 * попадать в живой ~/.dsh (правило П-4 docs/structure-rules.md).
 *
 *   node test/exchange-watch-unwatched.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0339-home-'));
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;
process.env.DSH_PROFILE_DIR = path.join(isolatedHome, 'profile');

const {
  createExchangeWatcher,
  readHeartbeat,
  unwatchedExchangeBoxes,
  WATCH_TELEMETRY_PATH,
} = await import('../lib/exchange-watch.js');

/* Телеметрия стенда обязана остаться в подменённом доме, а не в живом ~/.dsh. */
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
 * Раскладка живого хоста: два воркспейса и общий ящик уровнем выше.
 * Рядом лежит sibling-воркспейс со своим coordination/threads — он найден
 * инвентаризацией и подключается к проходу; пустой sibling без threads — приманка.
 */
function host() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0339-'));
  const root = path.join(parent, 'watched-ws');
  const sibling = path.join(parent, 'sibling-ws');
  const decoy = path.join(parent, 'decoy-ws');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(decoy, { recursive: true });
  const watchedBox = path.join(parent, 'coordination');
  const siblingBox = path.join(sibling, 'coordination');
  fs.mkdirSync(path.join(watchedBox, 'threads', 'critic-report'), { recursive: true });
  fs.mkdirSync(path.join(siblingBox, 'threads', 'critic-report'), { recursive: true });
  /* Приманка: coordination без threads — это не ящик. */
  fs.mkdirSync(path.join(decoy, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(siblingBox, 'threads', 'critic-report', 'letter.md'), [
    'From: sibling',
    'To: watched',
    'Date: ' + new Date().toISOString(),
    'Thread: critic-report',
    'Status: request',
    '',
    'тело письма',
    '',
  ].join('\n'), 'utf8');
  return { parent, root, sibling, decoy, watchedBox, siblingBox };
}

function storeOf() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0339-store-'));
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

/* ------------------------------------------------------------------ */
/* c1: sibling-ящик найден, watched не считается                       */
/* ------------------------------------------------------------------ */
await atest('0339 c1: найден ровно один sibling-ящик, watched не попадает', () => {
  const box = host();
  const inventory = unwatchedExchangeBoxes({
    allowedRoots: [box.root],
    boxDirs: [box.watchedBox],
  });
  assert.equal(inventory.unwatchedCount, 1, 'непросматриваемый ящик ровно один');
  assert.equal(inventory.unwatchedBoxes.length, 1, 'список путей называет его');
  assert.equal(key(inventory.unwatchedBoxes[0]), key(box.siblingBox), 'путь — coordination sibling-воркспейса');
  assert.ok(
    !inventory.unwatchedBoxes.some((item) => key(item) === key(box.watchedBox)),
    'watched-ящик не считается непросматриваемым',
  );
  assert.ok(
    !inventory.unwatchedBoxes.some((item) => key(item) === key(path.join(box.decoy, 'coordination'))),
    'coordination без threads — не ящик',
  );
  assert.equal(inventory.watchedCount, 1, 'watched count называет просканированный ящик');
});

/* ------------------------------------------------------------------ */
/* c2: без дублей; declared box — просматриваемый                      */
/* ------------------------------------------------------------------ */
await atest('0339 c2: путь без дублей, declared box не считается непросматриваемым', () => {
  const box = host();
  const inventory = unwatchedExchangeBoxes({
    allowedRoots: [box.root, box.root, box.root.toUpperCase()],
    boxDirs: [box.watchedBox, box.watchedBox, box.watchedBox.toUpperCase()],
  });
  assert.equal(inventory.unwatchedCount, 1, 'повторные корни не размножают путь');
  const keys = new Set(inventory.unwatchedBoxes.map(key));
  assert.equal(keys.size, inventory.unwatchedBoxes.length, 'в результате нет дублей');
  assert.equal(inventory.watchedCount, 1, 'watched-набор тоже без дублей');

  const declared = unwatchedExchangeBoxes({
    allowedRoots: [box.root],
    boxDirs: [box.watchedBox],
    declaredBoxes: [box.siblingBox],
  });
  assert.equal(declared.unwatchedCount, 0, 'объявленный ящик просматривается и в список не входит');
});

/* ------------------------------------------------------------------ */
/* c3: watcher подключает sibling-ящик, доставка и отчёт               */
/* ------------------------------------------------------------------ */
await atest('0340 c3: sibling-ящик подключён к проходу, письмо доставлено, отчёт назван', async () => {
  const box = host();
  const store = storeOf();
  const warnings = [];
  const target = agent('s-watched', box.root, 'watched');
  const runtime = {
    allowedRoots: () => [box.root],
    exchange: [],
    participants: { watched: box.root },
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
    assert.equal(delivered.length, 1, '0340: sibling-письмо доставлено, а не проигнорировано');
    assert.equal(target.inbox.length, 1, 'письмо приняла живая сессия адресата');
    assert.match(target.inbox[0], /letter\.md/u, 'пробуждение называет письмо sibling-ящика');
    const letter = path.join(box.siblingBox, 'threads', 'critic-report', 'letter.md');
    assert.ok(watcher.seen.has(letter), 'вручённое sibling-письмо отмечено');

    const beat = readHeartbeat(store.heartbeat);
    assert.ok(beat, 'heartbeat записан');
    assert.equal(beat.addedCount, 1, 'heartbeat называет подключённый ящик');
    assert.equal(key(beat.addedBoxes[0]), key(box.siblingBox), 'heartbeat называет путь подключённого ящика');
    assert.equal(beat.watchedCount, 2, 'watchedCount — общий и подключённый ящик вместе');
    assert.equal(beat.unwatchedBoxes.length, 0, 'подключённый ящик не числится непросмотренным');

    const status = watcher.status();
    assert.equal(status.addedCount, 1, 'status называет количество подключённых');
    assert.equal(key(status.addedBoxes[0]), key(box.siblingBox), 'status называет путь');
    assert.equal(status.watchedCount, 2, 'status: проход сканирует оба ящика');
    assert.equal(status.unwatchedCount, 0, 'status не называет подключённый ящик непросмотренным');

    assert.ok(
      warnings.some((line) => line.toLowerCase().includes(box.siblingBox.toLowerCase())),
      'предупреждение содержит полный путь подключённого ящика',
    );

    const lines = fs.readFileSync(WATCH_TELEMETRY_PATH, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const pass = lines.filter((row) => row.event === 'pass').at(-1);
    assert.ok(pass, 'pass-телеметрия записана');
    assert.equal(pass.addedCount, 1, 'телеметрия называет количество подключённых');
    assert.equal(key(pass.addedBoxes[0]), key(box.siblingBox), 'телеметрия называет путь');
    assert.equal(pass.watchedCount, 2, 'телеметрия называет просканированные ящики');
    assert.equal(pass.unwatchedCount, 0, 'остаток непросмотренных пуст');

    const rows = fs.readFileSync(store.decisions, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const delivery = rows.find((row) => row.branch === 'delivered' && String(row.letter || '').endsWith('letter.md'));
    assert.ok(delivery, 'журнал решений называет доставку sibling-письма');

    /* Профиль — не память процесса: авто-подключение не пишет конфиг. */
    assert.equal(fs.existsSync(path.join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml')), false,
      'профиль не изменён: ящик добавлен только в скан текущего прохода');

    /* Повторный проход не теряет доставленное и снова подключает ящик с диска. */
    const again = await watcher.tick(new Date(Date.now() + 121_000));
    assert.equal(again.length, 0, 'повторный проход не доставляет письмо второй раз');
    assert.equal(target.inbox.length, 1, 'второго пробуждения нет');
    assert.equal(watcher.status().addedCount, 1, 'каждый проход заново подключает найденный ящик');
  } finally {
    watcher.stop();
  }
});

/* ------------------------------------------------------------------ */
if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL ' + failure.name);
    console.error(failure.error && failure.error.stack ? failure.error.stack : String(failure.error));
  }
  console.error('EXCHANGE-WATCH-UNWATCHED TEST FAILED: ' + passed + '/' + (passed + failures.length));
  process.exit(1);
}
console.log('EXCHANGE-WATCH-UNWATCHED TEST OK: ' + passed + '/' + passed);
