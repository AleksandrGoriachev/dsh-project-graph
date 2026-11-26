#!/usr/bin/env node
/**
 * 0293 — presence по каждой обменной папке.
 *
 * Набор доказывает обещания контракта:
 *   - presence пишется и читается по box: <box>/presence/<workspace>.json;
 *     две папки не видят presence друг друга, root-форма 0292 цела;
 *   - presenceBoxes выбирает только папки, где workspace — участник;
 *     announcePresence (то, что зовёт init) пишет в КАЖДУЮ из них, а сбой одной
 *     папки не мешает остальным и не бросает;
 *   - доставка письма адресуется presence ТОЙ папки, через которую письмо
 *     доставлено: presence чужой папки не становится адресатом;
 *   - /api/exchange/wake берёт папку из запроса/письма и читает её presence;
 *   - R1: общий ящик не выводится из путей чужих воркспейсов — отказ назван,
 *     каталог вне корня не создаётся;
 *   - R2: при известной папке письма root-форма другой папки не подхватывается,
 *     даже если её файл физически совпал с coordination адресата;
 *   - R3: /api/exchange/wake берёт самый глубокий объявленный ящик и отвергает
 *     ящик, которого нет в структуре;
 *   - R4: метка из карты профиля (runtime.participants) резолвит папки стороны,
 *     даже когда folder.paths пусты и корень вложен в объявленный воркспейс.
 *
 *   node test/presence-boxes.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Дом подменяется до импорта модулей: телеметрия сторожа не имеет права попадать
 * в живой ~/.dsh (правило П-4 docs/structure-rules.md).
 */
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-boxes-home-'));
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;
process.env.DSH_PROFILE_DIR = path.join(isolatedHome, 'profile');
delete process.env.DSH_PROFILE;

const {
  createExchangeWatcher, presenceTarget, readSessionPresence, writeSessionPresence,
} = await import('../lib/exchange-watch.js');
const { announcePresence, presenceBoxes, presenceWorkspaceLabels } = await import('../lib/index.js');
const { API_PREFIX, createGraphRuntime, createWebHandler } = await import('../lib/api.js');

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
  'Subject: письмо папки',
  '',
  'тело письма',
  '',
].join('\n');

/* ------------------------------------------------------------------ */
/* c1: запись/чтение по box, независимость папок, root-форма 0292      */
/* ------------------------------------------------------------------ */
await atest('0293 c1: presence по box пишется, читается и не виден другой папке', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-box-'));
  const boxA = path.join(base, 'box-a');
  const boxB = path.join(base, 'box-b');
  fs.mkdirSync(boxA, { recursive: true });
  fs.mkdirSync(boxB, { recursive: true });

  const record = writeSessionPresence({ box: boxA, workspace: 'ws', sessionId: 'session-box-a' });
  assert.ok(record, 'writeSessionPresence по box вернул запись');
  assert.equal(record.sessionId, 'session-box-a');
  const file = path.join(boxA, 'presence', 'ws.json');
  assert.ok(fs.existsSync(file), 'presence лежит в <box>/presence/ws.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record, 'на диске ровно записанное');

  const back = readSessionPresence(boxA, 'ws');
  assert.ok(back && back.sessionId === 'session-box-a', 'readSessionPresence читает box-форму');

  assert.equal(presenceTarget({ box: boxB, workspace: 'ws' }), null,
    'presence одной папки не виден в другой');
  const hit = presenceTarget({ box: boxA, workspace: 'ws' });
  assert.ok(hit && hit.sessionId === 'session-box-a', 'presenceTarget по своей папке сработал');
  assert.equal(hit.reason, 'presence');

  /* root-форма 0292 не сломана и не подменяет box-форму. */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-root-'));
  writeSessionPresence({ root, workspace: 'ws', sessionId: 'session-root' });
  assert.ok(fs.existsSync(path.join(root, 'coordination', 'presence', 'ws.json')),
    'root-форма presence цела');
  assert.equal(presenceTarget({ box: boxB, workspace: 'ws' }), null,
    'root-форма вне box не становится presence чужой папки');
  const rootHit = presenceTarget({ root, workspace: 'ws' });
  assert.ok(rootHit && rootHit.sessionId === 'session-root', 'presenceTarget без box читает root-форму');
});

/* ------------------------------------------------------------------ */
/* c2: presenceBoxes и announcePresence — каждая папка участника       */
/* ------------------------------------------------------------------ */
await atest('0293 c2: presenceBoxes выбирает папки участника, init пишет в каждую', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-init-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const graph = {
    folders: [
      { id: 'f1', box: { path: 'coordination', root: 'workspace' }, participants: ['ws'] },
      { id: 'f2', box: { path: 'second/coordination', root: 'workspace' }, participants: ['ws', 'peer'] },
      { id: 'f3', box: { path: 'foreign/coordination', root: 'workspace' }, participants: ['someone-else'] },
    ],
  };
  const boxes = presenceBoxes({ graph, root, roots: [root], workspace: 'ws' });
  assert.equal(boxes.length, 2, 'выбраны ровно две папки участника');
  assert.deepEqual(boxes.map((item) => item.folder).sort(), ['f1', 'f2']);
  assert.equal(boxes.filter((item) => item.folder === 'f3').length, 0, 'чужая папка не выбрана');

  const announced = announcePresence({ graph, root, roots: [root], workspace: 'ws', sessionId: 'session-init' });
  assert.equal(announced.written.length, 2, 'presence записан в обе папки участника');
  for (const folder of ['coordination', 'second/coordination']) {
    const file = path.join(root, folder, 'presence', 'ws.json');
    assert.ok(fs.existsSync(file), 'presence init в ' + file);
  }
  assert.equal(fs.existsSync(path.join(root, 'foreign', 'coordination', 'presence', 'ws.json')), false,
    'чужая папка не тронута');
});

await atest('0293 c2: сбой одной папки не мешает остальным и не бросает', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-broken-'));
  /* Вторая папка объявлена под обычным ФАЙЛОМ: создать presence там нельзя. */
  fs.writeFileSync(path.join(root, 'second'), 'не каталог', 'utf8');
  const graph = {
    folders: [
      { id: 'ok', box: { path: 'coordination', root: 'workspace' }, participants: ['ws'] },
      { id: 'broken', box: { path: 'second/coordination', root: 'workspace' }, participants: ['ws'] },
    ],
  };
  let announced;
  assert.doesNotThrow(() => {
    announced = announcePresence({ graph, root, roots: [root], workspace: 'ws', sessionId: 'session-one' });
  }, 'сбой папки не бросает');
  assert.equal(announced.written.length, 1, 'рабочая папка записана');
  assert.equal(announced.written[0].folder, 'ok');
  assert.equal(announced.skipped.length, 1, 'сбойная папка названа пропущенной');
  assert.equal(announced.skipped[0].folder, 'broken');
  assert.ok(fs.existsSync(path.join(root, 'coordination', 'presence', 'ws.json')),
    'presence рабочей папки на месте');
});

/* ------------------------------------------------------------------ */
/* c3: доставка читает папку письма, чужая папка не адресат             */
/* ------------------------------------------------------------------ */
function hostWithTwoBoxes() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-deliver-'));
  const structure = path.join(parent, 'dsh-project-graph');
  const workflow = path.join(parent, 'default-workspace');
  fs.mkdirSync(structure, { recursive: true });
  fs.mkdirSync(workflow, { recursive: true });
  /* boxA — legacy-папка рядом с проектами, boxB — вторая объявленная папка. */
  const boxA = path.join(parent, 'coordination');
  const boxB = path.join(parent, 'second', 'coordination');
  const threadA = path.join(boxA, 'threads', 'critic-report');
  const threadB = path.join(boxB, 'threads', 'critic-report');
  fs.mkdirSync(threadA, { recursive: true });
  fs.mkdirSync(threadB, { recursive: true });
  /* «Кто есть кто»: по этой таблице метки обмена разрешаются в корни. */
  const readme = (title) => '# ' + title + '\n\n'
    + '| Сторона | Пространство | Что делает |\n'
    + '| --- | --- | --- |\n'
    + '| `workflow` | `' + workflow.replace(/\\/gu, '/') + '` | спека |\n'
    + '| `structure` | `' + structure.replace(/\\/gu, '/') + '` | панель |\n';
  fs.writeFileSync(path.join(boxA, 'README.md'), readme('Канал A'), 'utf8');
  fs.writeFileSync(path.join(boxB, 'README.md'), readme('Канал B'), 'utf8');
  return { parent, structure, workflow, boxA, boxB, threadA, threadB };
}

function storeOf(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    seen: path.join(dir, 'exchange-seen.json'),
    decisions: path.join(dir, 'exchange-decisions.jsonl'),
    heartbeat: path.join(dir, 'runs', 'exchange-watch.json'),
  };
}

function runtimeOf(roots, exchange) {
  return {
    allowedRoots: () => roots.slice(),
    exchange: exchange ? [exchange] : [],
    participants: {},
    me: null,
    runs: new Map(),
    runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-runs-')),
  };
}

function agent(sessionId, cwd) {
  return { id: sessionId, sessionId, cwd, label: 'workflow', running: false, inbox: [], async sendMessage() {} };
}

await atest('0293 c3: письмо адресуется presence своей папки, presence другой игнорируется', async () => {
  const box = hostWithTwoBoxes();
  const store = storeOf('pg-0293-deliver-store-');
  const oldAgent = agent('session-old', box.workflow);
  const prompted = [];
  /* Чужая папка объявляет свою сессию — она НЕ адресат письма из boxB. */
  writeSessionPresence({ box: box.boxA, workspace: 'workflow', sessionId: 'session-box-a' });
  writeSessionPresence({ box: box.boxB, workspace: 'workflow', sessionId: 'session-box-b' });
  const watcher = createExchangeWatcher({
    runtime: runtimeOf([box.structure, box.workflow], box.boxB),
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
    const letter = path.join(box.threadB, 'box-b-letter.md');
    fs.writeFileSync(letter, HEAD('structure', 'workflow'), 'utf8');
    const delivered = await watcher.tick();
    assert.equal(delivered.length, 1, 'письмо вручено');
    assert.equal(prompted[0], 'session-box-b', 'адресат — сессия ТОЙ папки, через которую доставлено письмо');
    assert.equal(delivered[0].target, 'session-box-b');
    assert.equal(delivered[0].reason, 'presence', 'причина — presence папки письма');
    assert.ok(watcher.seen.has(letter), 'письмо отмечено доставленным');
  } finally {
    watcher.stop();
  }
});

await atest('0293 c3: presence только чужой папки не становится адресатом письма', async () => {
  const box = hostWithTwoBoxes();
  const store = storeOf('pg-0293-deliver-store2-');
  const oldAgent = agent('session-old', box.workflow);
  const prompted = [];
  writeSessionPresence({ box: box.boxA, workspace: 'workflow', sessionId: 'session-box-a' });
  const watcher = createExchangeWatcher({
    runtime: runtimeOf([box.structure, box.workflow], box.boxB),
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
    fs.writeFileSync(path.join(box.threadB, 'box-b-no-presence.md'), HEAD('structure', 'workflow'), 'utf8');
    const delivered = await watcher.tick();
    assert.equal(delivered.length, 1, 'письмо вручено прежней схемой');
    assert.notEqual(delivered[0].target, 'session-box-a', 'presence чужой папки не адресат');
    assert.equal(delivered[0].target, 'session-old', 'цель — last-active своего воркспейса');
    assert.equal(delivered[0].reason, 'last-active', 'причина прежней схемы');
  } finally {
    watcher.stop();
  }
});

/* ------------------------------------------------------------------ */
/* c3: wake — папка из письма/запроса сужает presence                  */
/* ------------------------------------------------------------------ */
function projectWithTwoFolders() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-wake-root-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const graph = {
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [
      { id: 'folder-1', box: { path: 'coordination', root: 'workspace' }, participants: ['structure', 'workflow'], orchestrator: 'coordinator' },
      { id: 'folder-2', box: { path: 'second/coordination', root: 'workspace' }, participants: ['structure', 'workflow'], orchestrator: 'coordinator' },
    ],
  };
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
  const boxA = path.join(root, 'coordination');
  const boxB = path.join(root, 'second', 'coordination');
  fs.mkdirSync(path.join(boxA, 'threads', 'critic-report'), { recursive: true });
  fs.mkdirSync(path.join(boxB, 'threads', 'critic-report'), { recursive: true });
  return { root, boxA, boxB };
}

function call(handler, url, options = {}) {
  const res = {
    status: 0,
    body: null,
    writableEnded: false,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(String(body)); this.writableEnded = true; },
  };
  const req = {
    method: options.method || 'GET',
    url,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) {
      if (event === 'data' && options.body !== undefined) fn(Buffer.from(String(options.body)));
      if (event === 'end') fn();
    },
  };
  return Promise.resolve(handler(req, res)).then(() => res);
}

await atest('0293 c3: /api/exchange/wake читает presence папки из letter', async () => {
  const project = projectWithTwoFolders();
  const workspace = path.basename(project.root);
  writeSessionPresence({ box: project.boxA, workspace, sessionId: 'session-box-a' });
  writeSessionPresence({ box: project.boxB, workspace, sessionId: 'session-box-b' });
  const letter = path.join(project.boxB, 'threads', 'critic-report', 'letter.md');
  fs.writeFileSync(letter, HEAD('structure', 'workflow'), 'utf8');
  const prompted = [];
  const runtime = createGraphRuntime({ roots: [project.root] }, {
    getAgents: () => ({ list: () => [] }),
    getSessionController: () => ({
      async prompt(request) { prompted.push(request.sessionId); return { ok: true }; },
    }),
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/exchange/wake', {
    method: 'POST',
    body: JSON.stringify({ root: project.root, letter }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.woken, true, 'сессия разбужена');
  assert.equal(res.body.target, 'session-box-b', 'папка письма сузила presence');
  assert.deepEqual(prompted, ['session-box-b']);
});

await atest('0293 c3: /api/exchange/wake читает presence папки из box запроса', async () => {
  const project = projectWithTwoFolders();
  const workspace = path.basename(project.root);
  writeSessionPresence({ box: project.boxA, workspace, sessionId: 'session-box-a' });
  writeSessionPresence({ box: project.boxB, workspace, sessionId: 'session-box-b' });
  const prompted = [];
  const runtime = createGraphRuntime({ roots: [project.root] }, {
    getAgents: () => ({ list: () => [] }),
    getSessionController: () => ({
      async prompt(request) { prompted.push(request.sessionId); return { ok: true }; },
    }),
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/exchange/wake', {
    method: 'POST',
    body: JSON.stringify({ root: project.root, box: project.boxB, workspace }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.woken, true);
  assert.equal(res.body.target, 'session-box-b', 'box запроса назвал папку');
  assert.deepEqual(prompted, ['session-box-b']);
});

/* ------------------------------------------------------------------ */
/* R1: ящик общий — только из корней участников этой папки             */
/* ------------------------------------------------------------------ */
await atest('0293 R1: общий ящик не выводится из folder.paths чужих папок', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-r1-'));
  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });
  const graph = {
    folders: [
      /* У участника peer пути нет: общий ящик f1 разрешить нечем. */
      { id: 'f1', box: { path: 'coordination', root: 'shared' }, participants: ['ws', 'peer'] },
      /* Соседняя папка объявляет путь ЧУЖОГО воркспейса — раньше он подмешивался в roots. */
      {
        id: 'f2',
        box: { path: 'own-box', root: 'workspace' },
        participants: ['ws'],
        paths: { other: path.join(base, 'other-work') },
      },
    ],
  };
  const participants = { ws: project };
  const boxes = presenceBoxes({ graph, root: project, roots: [project], workspace: 'ws', participants });
  assert.deepEqual(boxes.map((item) => item.folder), ['f2'], 'общий ящик f1 не выдуман из чужого пути');
  const announced = announcePresence({
    graph, root: project, roots: [project], workspace: 'ws', sessionId: 'session-r1', participants,
  });
  assert.equal(announced.written.length, 1, 'записан только ящик самой папки');
  assert.equal(announced.written[0].folder, 'f2');
  assert.ok(announced.skipped.some((item) => item.folder === 'f1'),
    'отказ f1 назван в skipped, а не скрыт');
  assert.equal(fs.existsSync(path.join(base, 'coordination')), false,
    'каталог вне корня проекта не создан');
});

/* ------------------------------------------------------------------ */
/* R2: известная папка письма — только её presence, без root-отката    */
/* ------------------------------------------------------------------ */
await atest('0293 R2: root-форма папки-4 не становится адресатом письма папки-2', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-r2-'));
  const structure = path.join(parent, 'structure-ws');
  const split = path.join(parent, 'split-optimizer');
  fs.mkdirSync(structure, { recursive: true });
  fs.mkdirSync(split, { recursive: true });
  /* folder-2 — ящик письма; ящик folder-4 физически совпадает с coordination адресата. */
  const box2 = path.join(parent, 'box-2');
  const folder4 = path.join(split, 'coordination');
  fs.mkdirSync(path.join(box2, 'threads', 'critic-report'), { recursive: true });
  fs.mkdirSync(path.join(folder4, 'threads', 'critic-report'), { recursive: true });
  const graph = {
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [
      {
        id: 'folder-2',
        box: { path: 'box-2', root: 'shared' },
        participants: ['structure', 'split-optimizer'],
        orchestrator: 'coordinator',
      },
      {
        id: 'folder-4',
        box: { path: 'split-optimizer/coordination', root: 'shared' },
        participants: ['structure', 'split-optimizer'],
        orchestrator: 'coordinator',
      },
    ],
  };
  fs.mkdirSync(path.join(structure, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(structure, 'structure', 'graph.json'), JSON.stringify(graph, null, 2) + '\n', 'utf8');
  /* Сессия объявлена ТОЛЬКО в folder-4; файл тот же, что пишет root-форма 0292. */
  writeSessionPresence({ box: folder4, workspace: 'split-optimizer', sessionId: 'session-folder4' });
  assert.ok(fs.existsSync(path.join(split, 'coordination', 'presence', 'split-optimizer.json')),
    'файл folder-4 совпадает с root-формой адресата');
  const store = storeOf('pg-0293-r2-store-');
  const live = agent('session-last', split);
  const prompted = [];
  const runtime = {
    allowedRoots: () => [structure, split],
    exchange: [],
    participants: { structure, 'split-optimizer': split },
    me: null,
    runs: new Map(),
    runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-r2-runs-')),
    structureDir: 'structure',
  };
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: store.seen,
    decisionsPath: store.decisions,
    heartbeatPath: store.heartbeat,
    getAgents: () => ({ list: () => [live] }),
    activityOf: (root) => (path.resolve(root).toLowerCase() === path.resolve(split).toLowerCase()
      ? new Map([['session-last', Date.now()]])
      : new Map()),
    getSessionController: () => ({ async prompt(request) { prompted.push(request.sessionId); return { ok: true }; } }),
    wakeSpawn: false,
    tickMs: 30,
  });
  try {
    fs.writeFileSync(
      path.join(box2, 'threads', 'critic-report', 'other-folder.md'),
      HEAD('structure', 'split-optimizer', 'invitation'),
      'utf8',
    );
    const delivered = await watcher.tick();
    assert.equal(delivered.length, 1, 'письмо вручено');
    assert.notEqual(delivered[0].target, 'session-folder4',
      'presence folder-4 не подхвачен письмом folder-2 через root-форму');
    assert.equal(delivered[0].target.split('|')[0], 'session-last', 'сработала прежняя схема своего воркспейса');
    assert.equal(delivered[0].reason, 'last-active', 'причина — last-active, а не presence');
    assert.ok(!prompted.includes('session-folder4'), 'сессия folder-4 не пробуждена письмом folder-2');
  } finally {
    watcher.stop();
  }
});

/* ------------------------------------------------------------------ */
/* R3: wake — самый глубокий объявленный ящик; чужой box отвергнут     */
/* ------------------------------------------------------------------ */
function projectWithNestedFolders() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-r3-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const graph = {
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [
      { id: 'outer', box: { path: 'c', root: 'workspace' }, participants: ['structure'], orchestrator: 'coordinator' },
      { id: 'inner', box: { path: 'c/sub', root: 'workspace' }, participants: ['structure'], orchestrator: 'coordinator' },
    ],
  };
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(graph, null, 2) + '\n', 'utf8');
  const outer = path.join(root, 'c');
  const inner = path.join(root, 'c', 'sub');
  fs.mkdirSync(path.join(inner, 'threads', 'critic-report'), { recursive: true });
  return { root, outer, inner };
}

await atest('0293 R3: /api/exchange/wake берёт самый глубокий (вложенный) объявленный ящик', async () => {
  const project = projectWithNestedFolders();
  const workspace = path.basename(project.root);
  writeSessionPresence({ box: project.outer, workspace, sessionId: 'session-outer' });
  writeSessionPresence({ box: project.inner, workspace, sessionId: 'session-inner' });
  const letter = path.join(project.inner, 'threads', 'critic-report', 'nested.md');
  fs.writeFileSync(letter, HEAD('structure', 'workflow'), 'utf8');
  const prompted = [];
  const runtime = createGraphRuntime({ roots: [project.root] }, {
    getAgents: () => ({ list: () => [] }),
    getSessionController: () => ({
      async prompt(request) { prompted.push(request.sessionId); return { ok: true }; },
    }),
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/exchange/wake', {
    method: 'POST',
    body: JSON.stringify({ root: project.root, letter }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.woken, true);
  assert.equal(res.body.target, 'session-inner', 'глубокий ящик победил внешний');
  assert.deepEqual(prompted, ['session-inner']);
});

await atest('0293 R3: /api/exchange/wake отвергает не объявленный box', async () => {
  const project = projectWithNestedFolders();
  const runtime = createGraphRuntime({ roots: [project.root] });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/exchange/wake', {
    method: 'POST',
    body: JSON.stringify({ root: project.root, box: path.join(os.tmpdir(), 'pg-0293-not-declared') }),
  });
  assert.equal(res.status, 400, 'произвольный каталог не становится папкой presence');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'box-not-declared');
});

/* ------------------------------------------------------------------ */
/* R5: позиционное чтение не подменяет root-форму                      */
/* ------------------------------------------------------------------ */
await atest('0293 R5: позиционное чтение отдаёт root-форму, box-форма — по options.box', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-r5-'));
  writeSessionPresence({ root, workspace: 'ws', sessionId: 'session-root' });
  /* Каталог <root>/presence/ раньше молча перекрывал root-форму позиционного чтения. */
  fs.mkdirSync(path.join(root, 'presence'), { recursive: true });
  fs.writeFileSync(path.join(root, 'presence', 'ws.json'), JSON.stringify({
    version: 1,
    workspace: 'ws',
    sessionId: 'session-box',
    at: new Date().toISOString(),
  }, null, 1) + '\n', 'utf8');
  const positional = readSessionPresence(root, 'ws');
  assert.ok(positional && positional.sessionId === 'session-root',
    'позиционный вызов читает root-форму 0292, а не <root>/presence/');
  const explicit = readSessionPresence(root, 'ws', { box: root });
  assert.ok(explicit && explicit.sessionId === 'session-box',
    'box-форма читается только по явному options.box');
});

/* ------------------------------------------------------------------ */
/* R4: метка участника из карты профиля = папки стороны                */
/* ------------------------------------------------------------------ */
await atest('0293 R4: метка профиля резолвит папки воркспейса без folder.paths', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0293-r4-'));
  const structureRoot = path.join(parent, 'dsh-project-graph');
  const declaredWorkflow = path.join(parent, 'default-workspace');
  const workflowRoot = path.join(declaredWorkflow, 'subagent-workflow-v2');
  fs.mkdirSync(structureRoot, { recursive: true });
  fs.mkdirSync(workflowRoot, { recursive: true });
  const graph = {
    folders: [
      { id: 'folder-1', box: { path: 'coordination', root: 'shared' }, participants: ['structure', 'workflow'] },
    ],
  };
  const participants = { structure: structureRoot, workflow: declaredWorkflow };
  const labels = presenceWorkspaceLabels(graph, workflowRoot, path.basename(workflowRoot), participants);
  assert.ok(labels.includes('workflow'), 'метка профиля найдена для вложенного корня');
  assert.ok(labels.includes('subagent-workflow-v2'), 'имя папки 0292 остаётся меткой');
  const roots = [structureRoot, workflowRoot];
  const boxes = presenceBoxes({ graph, root: workflowRoot, roots, workspace: 'workflow', participants });
  assert.deepEqual(boxes.map((item) => item.folder), ['folder-1'], 'папка стороны workflow разрешена');
  const announced = announcePresence({
    graph, root: workflowRoot, roots, workspace: 'workflow', sessionId: 'session-workflow', participants,
  });
  assert.equal(announced.written.length, 1, 'presence записан в папку стороны workflow');
  assert.ok(fs.existsSync(path.join(parent, 'coordination', 'presence', 'workflow.json')),
    'presence лежит в общем ящике');
});

console.log(failures.length === 0
  ? 'PRESENCE BOXES OK: ' + passed + ' проверок — box-форма, init в каждую папку, адресация по папке письма, R1/R2/R3/R4/R5'
  : 'PRESENCE BOXES FAILED: ' + failures.length + ' из ' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
