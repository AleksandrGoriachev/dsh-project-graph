#!/usr/bin/env node
/**
 * 0294 — presence при старте хода сессии.
 *
 * Набор доказывает обещания контракта:
 *   - turn/start (а также session/created и session/start) объявляет сессию,
 *     которая уже существует: presence пишется в КАЖДУЮ обменную папку
 *     воркспейса, и в файле назван именно её sessionId;
 *   - чужой тип события presence не пишет;
 *   - без id сессии или с cwd вне разрешённых корней записи нет и исключения
 *     нет: presence не выдумывается;
 *   - cwd разрешается через session.cwd, а если хост его ещё не назвал — через
 *     кэш сессий (readSessionCwd, параметр sessionCacheDir);
 *   - повторный turn/start обновляет at и оставляет один файл на папку.
 *
 *   node test/presence-session-start.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Дом подменяется до импорта модуля: телеметрия/профиль не имеют права попадать
 * в живой ~/.dsh (правило П-4 docs/structure-rules.md).
 */
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0294-home-'));
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;
process.env.DSH_PROFILE_DIR = path.join(isolatedHome, 'profile');
delete process.env.DSH_PROFILE;

const { presenceOnSessionEvent } = await import('../lib/index.js');

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Воркспейс с тремя папками: две его (в одной он участник под меткой ws, во
 * второй — ещё и под именем папки), третья чужая. Раскладка та же, что у
 * приёмочной проверки: корень проекта и coordination рядом с ним.
 */
function fixture(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(base, 'project');
  fs.mkdirSync(root, { recursive: true });
  const graph = {
    folders: [
      { id: 'f1', box: { path: 'coordination', root: 'project' }, participants: ['ws'] },
      { id: 'f2', box: { path: 'second/coordination', root: 'workspace' }, participants: ['ws', 'project'] },
      { id: 'f3', box: { path: 'foreign/coordination', root: 'workspace' }, participants: ['someone-else'] },
    ],
  };
  return { base, root, graph, participants: { ws: root } };
}

/** session/event-подобный вызов: то, что хук передаёт presenceOnSessionEvent. */
function announce(f, overrides = {}) {
  return presenceOnSessionEvent({
    type: 'turn/start',
    session: { id: 'session-0294', cwd: f.root },
    sessionCacheDir: '',
    root: f.root,
    roots: [f.root],
    graph: f.graph,
    participants: f.participants,
    me: 'ws',
    ...overrides,
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* ------------------------------------------------------------------ */
/* c1: turn/start пишет presence в каждую папку участника              */
/* ------------------------------------------------------------------ */
await atest('0294 c1: turn/start пишет presence в папки участника', async () => {
  const f = fixture('pg-0294-c1-');
  const res = announce(f);
  assert.ok(res, 'turn/start вернул результат');
  assert.equal(res.written.length, 3, 'записаны все три папки/метки участника: ' + JSON.stringify(res.written));

  const own = path.join(f.root, 'coordination', 'presence', 'ws.json');
  const secondWs = path.join(f.root, 'second', 'coordination', 'presence', 'ws.json');
  const secondFolder = path.join(f.root, 'second', 'coordination', 'presence', 'project.json');
  for (const file of [own, secondWs, secondFolder]) {
    assert.ok(fs.existsSync(file), 'presence есть: ' + file);
    assert.equal(readJson(file).sessionId, 'session-0294', 'в presence названа стартовавшая сессия: ' + file);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'foreign', 'coordination', 'presence')), false,
    'чужая папка не тронута');
});

await atest('0294 c1: объявленный shared-ящик двух воркспейсов — presence в общем каталоге', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0294-shared-'));
  const ws = path.join(parent, 'ws');
  const peer = path.join(parent, 'peer');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(peer, { recursive: true });
  const graph = { folders: [
    { id: 'shared', box: { path: 'coordination', root: 'shared' }, participants: ['ws', 'peer'] },
  ] };
  const res = presenceOnSessionEvent({
    type: 'turn/start',
    session: { id: 'session-shared', cwd: ws },
    root: ws,
    roots: [ws, peer],
    graph,
    participants: { ws, peer },
    me: 'ws',
  });
  assert.ok(res && res.written.length === 1, 'presence записан в общий ящик: ' + JSON.stringify(res));
  const file = path.join(parent, 'coordination', 'presence', 'ws.json');
  assert.ok(fs.existsSync(file), 'presence в общем каталоге участников: ' + file);
  assert.equal(readJson(file).sessionId, 'session-shared');
});

await atest('0294 c1: session/created и session/start тоже объявляют сессию', async () => {
  for (const type of ['session/created', 'session/start']) {
    const f = fixture('pg-0294-type-');
    const res = announce(f, { type });
    assert.ok(res && res.written.length > 0, type + ' записал presence: ' + JSON.stringify(res));
    assert.ok(fs.existsSync(path.join(f.root, 'coordination', 'presence', 'ws.json')),
      type + ': файл presence на месте');
  }
});

await atest('0294 c1: чужой тип события presence не пишет', async () => {
  const f = fixture('pg-0294-other-');
  const res = announce(f, { type: 'turn/end' });
  assert.equal(res, null, 'turn/end — не старт, результата нет');
  assert.equal(fs.existsSync(path.join(f.root, 'coordination')), false,
    'чужой тип не создал ни одной папки presence');
});

/* ------------------------------------------------------------------ */
/* c2: без id и вне корней — нет записи и нет исключения               */
/* ------------------------------------------------------------------ */
await atest('0294 c2: без id сессии нет записи и нет исключения', async () => {
  const f = fixture('pg-0294-noid-');
  let res = 'threw';
  assert.doesNotThrow(() => {
    res = announce(f, { session: { cwd: f.root } });
  }, 'без id presenceOnSessionEvent не бросает');
  assert.equal(res, null, 'без id результата нет');
  assert.equal(fs.existsSync(path.join(f.root, 'coordination')), false, 'presence не создан');
});

await atest('0294 c2: cwd вне разрешённых корней — нет записи и нет исключения', async () => {
  const f = fixture('pg-0294-outside-');
  const outside = path.join(f.base, 'somewhere-else');
  let res = 'threw';
  assert.doesNotThrow(() => {
    res = announce(f, { session: { id: 'session-outside', cwd: outside } });
  }, 'cwd вне корней не бросает');
  assert.equal(res, null, 'cwd вне корней не даёт результата');
  assert.equal(fs.existsSync(path.join(f.root, 'coordination')), false, 'presence внутри корня не создан');
  assert.equal(fs.existsSync(path.join(outside, 'coordination')), false, 'presence вне корня не создан');
});

await atest('0294 c2: id без cwd и без кэша — presence не выдумывается', async () => {
  const f = fixture('pg-0294-nocwd-');
  const res = announce(f, { session: { id: 'session-no-cwd' }, sessionCacheDir: path.join(f.base, 'empty-cache') });
  assert.equal(res, null, 'без cwd результата нет');
  assert.equal(fs.existsSync(path.join(f.root, 'coordination')), false, 'presence не создан');
});

await atest('0294 c2: cwd берётся из кэша сессий, когда событие его не назвало', async () => {
  const f = fixture('pg-0294-cache-');
  const cacheDir = path.join(f.base, 'session-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'session-cache-0294.json'), JSON.stringify({
    record: { rows: { workingDirectory: { val: { path: f.root } } } },
  }), 'utf8');
  const res = announce(f, { session: { id: 'session-cache-0294' }, sessionCacheDir: cacheDir });
  assert.ok(res && res.written.length > 0, 'presence записан по cwd из кэша: ' + JSON.stringify(res));
  const record = readJson(path.join(f.root, 'coordination', 'presence', 'ws.json'));
  assert.equal(record.sessionId, 'session-cache-0294');
});

/* ------------------------------------------------------------------ */
/* c3: повторный turn/start обновляет at, файл один                    */
/* ------------------------------------------------------------------ */
await atest('0294 c3: повторный turn/start обновляет at и не копит записи', async () => {
  const f = fixture('pg-0294-repeat-');
  const first = announce(f);
  assert.equal(first.written.length, 3, 'первый turn/start записал три файла');
  const dir = path.join(f.root, 'coordination', 'presence');
  const file = path.join(dir, 'ws.json');
  const at1 = readJson(file).at;
  const filesAfterFirst = fs.readdirSync(dir).sort();

  await sleep(25);
  const second = announce(f);
  assert.equal(second.written.length, 3, 'второй turn/start перезаписал те же три файла');
  const at2 = readJson(file).at;
  assert.ok(Date.parse(at2) > Date.parse(at1), 'at обновился: ' + at1 + ' → ' + at2);
  assert.deepEqual(fs.readdirSync(dir).sort(), filesAfterFirst, 'файл один на папку — новых записей нет');
  assert.deepEqual(filesAfterFirst.filter((name) => name.endsWith('.tmp')), [], 'временных файлов не осталось');
  assert.equal(readJson(file).sessionId, 'session-0294', 'сессия в файле прежняя');
});

console.log(failures.length === 0
  ? 'PRESENCE SESSION START OK: ' + passed + ' проверок — старт хода объявляет сессию, чужие/вне корней не пишут, повтор обновляет at'
  : 'PRESENCE SESSION START FAILED: ' + failures.length + ' из ' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
