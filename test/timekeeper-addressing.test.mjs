/**
 * 0365: письмо таймкипера адресовано своему воркспейсу, а не роли.
 *
 * Факт живого прогона 26.11: два таймкипера в разных воркспейсах дали по два
 * письма в общую ветку timekeeper, и в шапке обоих стояло To: coordinator —
 * id узла. По правилу обмена адресат определяется только полем To, поэтому
 * «coordinator» читалось как «своему координатору» в любом воркспейсе.
 *
 * Проверка держит три вещи. Первое: письмо каждого воркспейса несёт To своего
 * ярлыка, и в общем hub два письма различимы по адресату, хотя текст у них
 * один. Второе: собственный ящик воркспейса (объявленный путь внутри корня)
 * имеет приоритет — письмо остаётся в нём и в общий hub не попадает. Третье:
 * без объявленного ярлыка адресат — имя каталога корня, но не роль.
 *
 * Корни и hub — подкаталоги временного каталога теста; журнал прогонов уведён
 * переменной PG_RUNS_DIR, как в соседних проверках таймкипера. DSH, сеть и LLM
 * не нужны: живой сессии координатора нет, поэтому письмо — единственный канал.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime } from '../lib/api.js';
import { parseHeader } from '../lib/exchange.js';
import { createScheduler } from '../lib/scheduler.js';
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

const SESSION = 'session-coordinator-0365';
const COORDINATOR = Object.freeze({
  id: 'coordinator',
  role: 'координатор',
  provider: 'opencode',
  model: 'deepseek-v4.1-flash',
  session: SESSION,
});

const PERIOD = Object.freeze({ start: '09:00', end: '13:00', leadMinutes: 30 });
const MONITOR = Object.freeze([{ provider: 'opencode', model: 'deepseek-v4.1-flash', periods: [PERIOD] }]);

const WARN_TEXT = 'останов с 09:00 до 13:00, осталось 30 минут';

/** Локальное «сегодня»: пояс машины, как у периодов монитора. */
const localAt = (hour, minute, day = 6) => new Date(2026, 10, day, hour, minute);

function keeper(monitor, extra = {}) {
  return { id: 'keeper', role: 'тайм-менеджер', ...(monitor === undefined ? {} : { monitor }), ...extra };
}

/** Песочница теста: временный каталог и общий hub, которым владеют оба воркспейса. */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-timekeeper-0365-'));
  const hub = path.join(dir, 'hub');
  fs.mkdirSync(hub, { recursive: true });
  return { dir, hub };
}

/** Воркспейс с объявленной структурой: одного координатора и таймкипера хватает. */
function makeWorkspace(dir, name) {
  const root = path.join(dir, name);
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const graph = { version: 1, nodes: [COORDINATOR, keeper(MONITOR)] };
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  return root;
}

/** Журнал прогонов — временный каталог на время одного теста (PG_RUNS_DIR). */
async function withRunsDir(body) {
  const previous = process.env.PG_RUNS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-timekeeper-0365-runs-'));
  process.env.PG_RUNS_DIR = dir;
  try {
    return await body(dir);
  } finally {
    if (previous === undefined) delete process.env.PG_RUNS_DIR;
    else process.env.PG_RUNS_DIR = previous;
  }
}

/**
 * Планировщик одного воркспейса. Живых сессий нет вовсе: письмо сразу идёт
 * вторым каналом, поэтому адресация видна в файле, а не в журнале handle.
 */
function makeScheduler(root, config = {}) {
  const runtime = createGraphRuntime({ roots: [root], ...config });
  const warnings = [];
  const scheduler = createScheduler({
    runtime,
    getAgents: () => ({ roots: () => [] }),
    getParent: () => ({ id: 'parent-1' }),
    logger: { warn: (message) => warnings.push(String(message)) },
    now: () => localAt(8, 0),
  });
  return { runtime, scheduler, warnings };
}

/** Все письма под каталогом ящика: файл и текст, чтобы читать шапку. */
function messagesUnder(box) {
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
  walk(box);
  return found;
}

/** Записи журнала этого корня. */
function records(runtime, root) {
  return listRuns(runtime, root).filter((row) => row && row.root === root);
}

/* ------------------------------------------------------------------------- *
 * 1. Общий hub: у каждого письма свой адресат-ярлык, письма различимы
 * ------------------------------------------------------------------------- */

await test('два воркспейса с общим hub: To у каждого свой, письма различимы', async () => {
  await withRunsDir(async () => {
    const { dir, hub } = makeSandbox();
    const structure = makeWorkspace(dir, 'structure');
    const workflow = makeWorkspace(dir, 'workflow');
    /* Карта участников общая: оба воркспейса знают оба ярлыка. */
    const participants = { structure, workflow };
    const first = makeScheduler(structure, { exchange: [hub], participants });
    const second = makeScheduler(workflow, { exchange: [hub], participants });

    const firstTick = await first.scheduler.tick(localAt(8, 30));
    const secondTick = await second.scheduler.tick(localAt(8, 30));
    assert.deepEqual(firstTick, [], 'живой сессии нет — session-активацией это не считается');
    assert.deepEqual(secondTick, [], 'и у второго воркспейса тоже');

    const letters = messagesUnder(hub);
    assert.equal(letters.length, 2, 'оба письма лежат в общем hub');
    const heads = letters.map((letter) => parseHeader(letter.text));
    assert.ok(heads.every(Boolean), 'у обоих писем шапка From/To/Date на месте');

    const addressees = heads.map((head) => head.to).sort();
    assert.deepEqual(addressees, ['structure', 'workflow'], 'адресаты — ярлыки своих воркспейсов');
    assert.ok(heads.every((head) => head.to !== 'coordinator'), 'ни одно письмо не адресовано роли coordinator');

    const byTo = new Map(heads.map((head) => [head.to, head]));
    assert.equal(byTo.get('structure').from, 'structure', 'From называет тот воркспейс, который пишет');
    assert.equal(byTo.get('workflow').from, 'workflow', 'и второй тоже');
    assert.equal(byTo.get('structure').workspace, 'structure', 'Workspace — ярлык своего воркспейса');
    assert.equal(byTo.get('workflow').workspace, 'workflow', 'и у второго он свой');
    assert.ok(byTo.get('structure').thread === 'timekeeper', 'ветка — timekeeper');
    assert.ok(byTo.get('workflow').thread === 'timekeeper', 'ветка — timekeeper у обоих');

    /*
     * Текст у писем один и тот же — именно поэтому различать их можно только
     * адресатом; без 0365 в hub лежали две неотличимые шапки To: coordinator.
     */
    assert.ok(letters.every((letter) => letter.text.includes(WARN_TEXT)), 'текст уведомления одинаков');
    assert.equal(new Set(letters.map((letter) => letter.file)).size, 2, 'письма — разные файлы');

    for (const [root, carried] of [[structure, first], [workflow, second]]) {
      const rows = records(carried.runtime, root);
      assert.equal(rows.length, 1, 'одна запись на активацию');
      assert.equal(rows[0].kind, 'timekeeper');
      assert.equal(rows[0].state, 'done', 'письмо в hub — доставка done');
      assert.equal(rows[0].deliveredVia, 'letter', 'канал не изменился: письмо');
    }
  });
});

/* ------------------------------------------------------------------------- *
 * 2. Собственный ящик корня: письмо в нём, в общий hub не попадает
 * ------------------------------------------------------------------------- */

await test('собственный ящик воркспейса имеет приоритет: письмо в нём, hub пуст', async () => {
  await withRunsDir(async () => {
    const { dir, hub } = makeSandbox();
    const structure = makeWorkspace(dir, 'structure');
    const workflow = makeWorkspace(dir, 'workflow');
    /*
     * Ящик structure объявлен после hub — порядок не должен решать: путь внутри
     * корня принадлежит этому воркспейсу, поэтому он идёт первым.
     */
    const ownBox = path.join(structure, 'exchange');
    fs.mkdirSync(ownBox, { recursive: true });
    const participants = { structure, workflow };
    const first = makeScheduler(structure, { exchange: [hub, ownBox], participants });
    const second = makeScheduler(workflow, { exchange: [hub], participants });

    await first.scheduler.tick(localAt(8, 30));
    await second.scheduler.tick(localAt(8, 30));

    const own = messagesUnder(ownBox);
    assert.equal(own.length, 1, 'письмо воркспейса со своим ящиком лежит в нём');
    const ownHead = parseHeader(own[0].text);
    assert.ok(ownHead, 'у письма в своём ящике есть шапка');
    assert.equal(ownHead.to, 'structure', 'To — ярлык этого воркспейса');

    const shared = messagesUnder(hub);
    assert.equal(shared.length, 1, 'в общий hub попало только письмо второго воркспейса');
    const sharedHead = parseHeader(shared[0].text);
    assert.equal(sharedHead.to, 'workflow', 'To — ярлык второго воркспейса, а не первого');
    assert.ok(!shared.some((letter) => (parseHeader(letter.text) || {}).to === 'structure'),
      'письмо первого воркспейса в общий hub не просочилось');

    const rows = records(first.runtime, structure);
    assert.equal(rows.length, 1, 'активация первого воркспейса записана');
    assert.equal(rows[0].state, 'done');
    assert.equal(rows[0].deliveredVia, 'letter', 'канал — письмо, как и раньше');
  });
});

/* ------------------------------------------------------------------------- *
 * 3. Ярлыка нет: адресат — имя каталога корня, но не роль
 * ------------------------------------------------------------------------- */

await test('без ярлыка адресат — имя каталога корня, а не роль coordinator', async () => {
  await withRunsDir(async () => {
    const { dir, hub } = makeSandbox();
    const root = makeWorkspace(dir, 'no-label-workspace');
    const carried = makeScheduler(root, { exchange: [hub] });

    await carried.scheduler.tick(localAt(8, 30));
    const letters = messagesUnder(hub);
    assert.equal(letters.length, 1, 'письмо на месте');
    const head = parseHeader(letters[0].text);
    assert.ok(head, 'шапка письма прочитана');
    assert.equal(head.to, 'no-label-workspace', 'To — имя каталога своего корня');
    assert.notEqual(head.to, 'coordinator', 'id узла не подменяет адресата');
    assert.equal(head.workspace, 'no-label-workspace', 'Workspace совпадает с адресатом');

    const rows = records(carried.runtime, root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].deliveredVia, 'letter');
  });
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)));
}
console.log('TIMEKEEPER-ADDRESSING TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
