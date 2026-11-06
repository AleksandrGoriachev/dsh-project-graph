/**
 * Обязанности структуры (задание 0075).
 *
 * Набор доказывает пять обещаний контракта: объявление читается и
 * нормализуется, сканер обмена считает только письма СВОЕМУ участнику (чужие и
 * без шапки попадают в skipped), отметка прочитанного идемпотентна и снимает
 * обязанность, command-проверка различает exit 0/3 и таймаут, evidence лежит в
 * хранилище и никогда в репозитории, а битая структура не роняет оценку.
 *
 * Каждый тест получает свой DSH_PROJECT_GRAPH_STORE: следы одного набора не
 * должны влиять на другой и на живой ~/.dsh.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ATTENTION_MAX_AGE_MS, ATTENTION_STATUSES, CLOSING_STATUSES, COMMAND_TIMEOUT_MS, EVIDENCE_FIELDS,
  MAX_OUTPUT_CHARS, SKIP_REASONS,
  evaluateObligations, exchangeAttention, markExchangeSeen, readObligations, scanExchange,
} from '../lib/obligations.js';
import { createGraphRuntime, createWebHandler, API_PREFIX } from '../lib/api.js';
import { storeDir } from '../lib/store.js';

async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  /* Каталог хранилища НЕ создаётся заранее: проект без структуры должен
   * отличаться от проекта с пустым внешним хранилищем. */
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-obligations-store-')), 'store');
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

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

/** Временный проект; `contents === null` — структуры нет. */
function project(contents = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-obligations-root-'));
  if (contents !== null) {
    fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
    for (const [name, value] of Object.entries(contents)) {
      const file = path.join(dir, 'structure', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }
  }
  return dir;
}

/** Минимальная структура: узлы не нужны, чтобы читать обязанности и папки. */
function graph(extra = {}) {
  return {
    version: 1,
    nodes: [{ id: 'worker', role: 'исполнитель', provider: 'opencode', model: 'deepseek-v4.1-flash' }],
    edges: [],
    ...extra,
  };
}

/** Папка обмена с тем же резолвером, что в объявлении проекта. */
function folder(extra = {}) {
  return {
    id: 'folder-1',
    box: { path: 'coordination', root: 'workspace' },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    ...extra,
  };
}

const LETTER = (to, subject = 'тема', from = 'workflow', date = '2026-11-05T01:00:00+03:00') => 'Format: dsh-exchange/1\n'
  + 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nThread: critic-report\nStatus: report\n'
  + 'Subject: ' + subject + '\n\nтело письма, которое сканер не читает\n';

/** Положить письмо в ящик папки; `rel` — путь относительно ящика. */
function writeLetter(root, rel, text) {
  const file = path.join(root, 'coordination', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** Все файлы проекта — доказательство того, что репозиторий не тронут. */
function repoFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/** Вызов HTTP-маршрута теми же моками, что test/api.test.mjs. */
function call(handler, url) {
  const res = {
    status: 0,
    body: null,
    writableEnded: false,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(String(body)); this.writableEnded = true; },
  };
  const req = {
    method: 'GET',
    url,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) { if (event === 'end') fn(); },
  };
  return Promise.resolve(handler(req, res)).then(() => res);
}

await test('readObligations: нормализует id, title, check и enforce', async () => {
  const root = project({ 'graph.json': graph({ obligations: [
    { id: 'exchange-read', title: 'разобрать входящие', check: { kind: 'exchange-unread', max: 2 }, enforce: 'block' },
    { id: 'smoke', check: { kind: 'command', run: 'node -e "process.exit(0)"' } },
  ] }) });
  const rows = readObligations({ root });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: 'exchange-read',
    title: 'разобрать входящие',
    check: { kind: 'exchange-unread', max: 2 },
    enforce: 'block',
  });
  assert.equal(rows[1].title, 'smoke', 'title по умолчанию — id');
  assert.equal(rows[1].enforce, 'warn', 'enforce по умолчанию — warn');
  assert.equal(rows[1].check.kind, 'command');
});

await test('readObligations: собирает обязанности из нескольких фрагментов', async () => {
  const root = project({
    'graph.json': graph(),
    'duties.json': { version: 1, obligations: [{ id: 'b', title: 'вторая', check: { kind: 'command', run: 'node -e "process.exit(0)"' } }] },
    'teams/code.json': { obligations: [{ id: 'a', title: 'первая', check: { kind: 'exchange-unread' } }] },
  });
  const ids = readObligations({ root }).map((row) => row.id);
  assert.deepEqual(ids.sort(), ['a', 'b']);
});

await test('readObligations: без структуры — пустой список, без исключения', async () => {
  const root = project(null);
  assert.deepEqual(readObligations({ root }), []);
});

await test('scanExchange: считает только письма своему участнику, чужие и без шапки — skipped', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const ours = writeLetter(root, 'threads/critic-report/01.md', LETTER('structure', 'наше письмо'));
  writeLetter(root, 'threads/critic-report/02.md', LETTER('workflow', 'чужое письмо'));
  writeLetter(root, 'threads/critic-report/03.md', 'просто текст без шапки\n');
  const scan = scanExchange({ root });
  assert.equal(scan.unread.length, 1);
  assert.equal(scan.unread[0].path, ours);
  assert.equal(scan.unread[0].to, 'structure');
  assert.equal(scan.unread[0].subject, 'наше письмо');
  assert.equal(scan.unread[0].date, '2026-11-05T01:00:00+03:00');
  assert.equal(scan.seen, 0);
  assert.equal(scan.skipped.length, 2);
  const reasons = scan.skipped.map((row) => row.reason).sort();
  assert.deepEqual(reasons, ['no-header', 'not-addressee']);
  assert.equal(scan.boxes.length, 1);
  assert.equal(scan.boxes[0].me, 'structure');
  assert.equal(scan.boxes[0].letters, 1);
  assert.equal(scan.boxes[0].skipped, 2);
});

/** Проект с произвольным объявлением папки; нужен, когда paths ссылаются на сам корень. */
function projectWithFolder(folderExtra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-obligations-paths-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  const declared = graph({ folders: [folder(typeof folderExtra === 'function' ? folderExtra(dir) : folderExtra)] });
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(declared, null, 2));
  return dir;
}

await test('scanExchange: своя метка из folder.paths, а не по порядку участников (0080)', async () => {
  const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-obligations-peer-'));
  const dir = projectWithFolder((root) => ({
    /* Живой folder-3: paths на оба корня, чужой участник первым. */
    participants: ['workflow', 'structure'],
    paths: { workflow: peer, structure: root },
  }));
  writeLetter(dir, 'threads/critic-report/01.md', LETTER('structure', 'нам'));
  writeLetter(dir, 'threads/critic-report/02.md', LETTER('workflow', 'наш ответ', 'structure'));
  const scan = scanExchange({ root: dir });
  assert.equal(scan.boxes[0].me, 'structure', 'метка из paths, а не первый участник');
  assert.equal(scan.unread.length, 1, 'письмо To: structure — входящее');
  assert.equal(scan.unread[0].to, 'structure');
  assert.equal(scan.skipped.length, 1);
  assert.equal(scan.skipped[0].reason, 'service', 'наш ответ не может быть непрочитанным нами');
});

await test('scanExchange: пути папки сравниваются без учёта регистра и разделителей (0080)', async () => {
  const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-obligations-peer-'));
  const dir = projectWithFolder((root) => ({
    participants: ['workflow', 'structure'],
    /* Карта могла быть записана прямыми слэшами, в другом регистре и с хвостовым слэшем. */
    paths: { workflow: peer, structure: root.replace(/\\/gu, '/').toUpperCase() + '/' },
  }));
  writeLetter(dir, 'threads/critic-report/01.md', LETTER('structure', 'нам'));
  const scan = scanExchange({ root: dir });
  assert.equal(scan.boxes[0].me, 'structure');
  assert.equal(scan.unread.length, 1);
  assert.equal(scan.skipped.length, 0);
});

await test('scanExchange: явный folder.me важнее paths (0080)', async () => {
  const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-obligations-peer-'));
  const dir = projectWithFolder((root) => ({
    me: 'workflow',
    participants: ['workflow', 'structure'],
    paths: { workflow: peer, structure: root },
  }));
  writeLetter(dir, 'threads/critic-report/01.md', LETTER('workflow', 'нам', 'structure'));
  const scan = scanExchange({ root: dir });
  assert.equal(scan.boxes[0].me, 'workflow', 'явное me не перебивается картой путей');
  assert.equal(scan.unread.length, 1);
  assert.equal(scan.unread[0].to, 'workflow');
});

await test('scanExchange: участник-абсолютный путь и первый участник — прежние ветки (0080)', async () => {
  const dir = projectWithFolder((root) => ({ participants: [root, 'workflow'] }));
  writeLetter(dir, 'threads/critic-report/01.md', LETTER(path.basename(dir), 'нам'));
  const byAbsolute = scanExchange({ root: dir });
  assert.equal(byAbsolute.boxes[0].me, path.basename(dir), 'абсолютный путь корня даёт basename');
  assert.equal(byAbsolute.unread.length, 1);
  const fallback = projectWithFolder({ participants: ['alpha', 'beta'] });
  assert.equal(scanExchange({ root: fallback }).boxes[0].me, 'alpha', 'иначе — первый участник');
});

await test('scanExchange: причины пропуска и их счётчики (0080)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  writeLetter(root, 'threads/critic-report/01.md', LETTER('structure', 'нам'));
  writeLetter(root, 'threads/critic-report/02.md', LETTER('workflow', 'наш ответ', 'structure'));
  writeLetter(root, 'threads/critic-report/03.md', LETTER('workflow', 'чужое'));
  writeLetter(root, 'threads/critic-report/04.md', LETTER('structure', 'своя копия', 'structure'));
  writeLetter(root, 'threads/critic-report/05.md', 'просто текст без шапки\n');
  const scan = scanExchange({ root });
  assert.deepEqual(SKIP_REASONS, ['not-addressee', 'no-header', 'service', 'unreadable']);
  assert.equal(scan.unread.length, 1, 'входящее только письмо To: structure от чужого');
  assert.equal(scan.skipped.length, 4);
  const reasons = scan.skipped.map((row) => row.reason).sort();
  assert.deepEqual(reasons, ['no-header', 'not-addressee', 'service', 'service']);
  const expected = { 'not-addressee': 1, 'no-header': 1, service: 2, unreadable: 0 };
  assert.deepEqual(scan.reasons, expected, 'счётчики скана');
  assert.deepEqual(scan.boxes[0].reasons, expected, 'счётчики папки');
  assert.equal(scan.boxes[0].letters, 1, 'письма считаются как раньше');
  assert.equal(scan.boxes[0].skipped, 4);
  const service = scan.skipped.filter((row) => row.reason === 'service');
  for (const row of service) assert.equal(row.from, 'structure', 'причина service называет отправителя');
});

await test('scanExchange: общая папка (shared) находится рядом с воркспейсом', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder({ box: { path: 'shared-box', root: 'shared' } })] }) });
  const outside = path.join(path.dirname(root), 'shared-box', 'threads', 'critic-report');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, '01.md'), LETTER('structure', 'общее письмо'));
  const scan = scanExchange({ root });
  assert.equal(scan.unread.length, 1);
  assert.equal(scan.unread[0].subject, 'общее письмо');
  assert.equal(scan.boxes[0].path, path.join(path.dirname(root), 'shared-box'));
});

await test('markExchangeSeen: идемпотентен, путь -> sha256, чужие записи не стираются', async () => {
  await withStore(async (store) => {
    const root = project({ 'graph.json': graph({ folders: [folder()] }) });
    writeLetter(root, 'threads/critic-report/01.md', LETTER('structure', 'первое'));
    writeLetter(root, 'threads/critic-report/02.md', LETTER('structure', 'второе'));
    const seenFile = path.join(store, 'exchange-seen.json');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify({ 'C:/foreign/letter.md': 1762290000000 }) + '\n');
    const scan = scanExchange({ root });
    assert.equal(scan.unread.length, 2);
    const first = markExchangeSeen({ root, paths: scan.unread.map((row) => row.path) });
    assert.equal(first.marked, 2);
    assert.equal(first.written, true);
    const text = fs.readFileSync(seenFile, 'utf8');
    const rows = JSON.parse(text);
    assert.equal(rows['C:/foreign/letter.md'], 1762290000000, 'числовая отметка другого инструмента сохранена');
    const own = Object.keys(rows).filter((key) => /^[A-Za-z]:[\\/]/u.test(key) && key !== 'C:/foreign/letter.md');
    assert.equal(own.length, 2);
    for (const key of own) assert.match(rows[key], /^[0-9a-f]{64}$/u);
    const second = markExchangeSeen({ root, paths: scan.unread.map((row) => row.path) });
    assert.equal(second.written, false, 'повторная отметка не переписывает файл');
    assert.equal(fs.readFileSync(seenFile, 'utf8'), text, 'содержимое не изменилось');
    const again = scanExchange({ root });
    assert.equal(again.unread.length, 0, 'отметка снимает непрочитанные');
    assert.equal(again.seen, 2);
  });
});

await test('markExchangeSeen: несуществующий путь не попадает в отметку', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({ folders: [folder()] }) });
    const result = markExchangeSeen({ root, paths: [path.join(root, 'coordination', 'threads', 'нет.md')] });
    assert.equal(result.marked, 0);
    assert.equal(scanExchange({ root }).unread.length, 0);
  });
});

await test('evaluateObligations: exchange-unread с непрочитанными — ok:false и evidence в хранилище', async () => {
  await withStore(async (store) => {
    const root = project({ 'graph.json': graph({
      folders: [folder()],
      obligations: [{ id: 'exchange-read', title: 'разобрать входящие', check: { kind: 'exchange-unread', max: 0 }, enforce: 'warn' }],
    }) });
    writeLetter(root, 'threads/critic-report/01.md', LETTER('structure', 'первое'));
    writeLetter(root, 'threads/critic-report/02.md', LETTER('structure', 'второе'));
    const status = evaluateObligations({ root });
    assert.equal(status.workspace, path.basename(root));
    assert.equal(status.obligations.length, 1);
    const row = status.obligations[0];
    assert.equal(row.id, 'exchange-read');
    assert.equal(row.ok, false);
    assert.match(row.detail, /2/u);
    assert.ok(row.evidenceAt, 'evidenceAt заполнен');
    const evidenceFile = path.join(store, 'evidence', 'exchange-read.json');
    assert.ok(fs.existsSync(evidenceFile), 'evidence лежит в хранилище');
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    for (const key of EVIDENCE_FIELDS) assert.ok(Object.hasOwn(evidence, key), 'в evidence есть ' + key);
    assert.equal(evidence.ok, false);
    assert.equal(evidence.counts.unread, 2);
    assert.match(evidence.hash, /^[0-9a-f]{64}$/u);
    assert.match(evidence.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u);
    const repo = repoFiles(root);
    assert.deepEqual(repo.filter((file) => /evidence|exchange-seen/iu.test(file)), [], 'в репозиторий ничего не записано');
  });
});

await test('evaluateObligations: порог check.max разрешает одно непрочитанное', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({
      folders: [folder()],
      obligations: [{ id: 'exchange-read', check: { kind: 'exchange-unread', max: 1 } }],
    }) });
    writeLetter(root, 'threads/critic-report/01.md', LETTER('structure', 'одно'));
    const one = evaluateObligations({ root }).obligations[0];
    assert.equal(one.ok, true);
    assert.match(one.detail, /1/u);
    writeLetter(root, 'threads/critic-report/02.md', LETTER('structure', 'второе'));
    const two = evaluateObligations({ root }).obligations[0];
    assert.equal(two.ok, false, '2 > max 1');
    assert.match(two.detail, /2/u);
  });
});

await test('evaluateObligations: command exit 0 выполнен, exit 3 — нет', async () => {
  await withStore(async (store) => {
    const passRoot = project({ 'graph.json': graph({
      obligations: [{ id: 'smoke', title: 'быстрая проверка', check: { kind: 'command', run: 'node -e "process.exit(0)"' } }],
    }) });
    const failRoot = project({ 'graph.json': graph({
      obligations: [{ id: 'smoke', title: 'быстрая проверка', check: { kind: 'command', run: 'node -e "process.exit(3)"' } }],
    }) });
    assert.equal(COMMAND_TIMEOUT_MS, 120000, 'предел команды по умолчанию — 120 с');
    const pass = evaluateObligations({ root: passRoot }).obligations[0];
    assert.equal(pass.ok, true);
    assert.match(pass.detail, /кодом 0/u);
    const fail = evaluateObligations({ root: failRoot }).obligations[0];
    assert.equal(fail.ok, false);
    assert.match(fail.detail, /3/u);
    assert.match(fail.detail, /ожидался 0/u);
    assert.ok(fs.existsSync(path.join(store, 'evidence', 'smoke.json')), 'evidence последней проверки записан');
  });
});

await test('evaluateObligations: таймаут команды — ok:false с причиной, не исключение', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({
      obligations: [{ id: 'slow', title: 'медленная', check: { kind: 'command', run: 'node -e "setTimeout(()=>{}, 10000)"', timeoutMs: 150 } }],
    }) });
    const row = evaluateObligations({ root }).obligations[0];
    assert.equal(row.ok, false);
    assert.match(row.detail, /таймаут/u);
    assert.match(row.detail, /150/u);
    const evidence = JSON.parse(fs.readFileSync(path.join(storeDir(root), 'evidence', 'slow.json'), 'utf8'));
    assert.equal(evidence.counts.timedOut, true);
    assert.equal(evidence.counts.timeoutMs, 150);
  });
});

await test('evaluateObligations: вывод команды обрезается до MAX_OUTPUT_CHARS', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({
      obligations: [{ id: 'noisy', check: { kind: 'command', run: 'node -e "process.stdout.write(\'x\'.repeat(5000))"' } }],
    }) });
    const row = evaluateObligations({ root }).obligations[0];
    assert.equal(row.ok, true);
    const evidence = JSON.parse(fs.readFileSync(path.join(storeDir(root), 'evidence', 'noisy.json'), 'utf8'));
    assert.equal(evidence.counts.outputChars, 5000);
    assert.equal(evidence.counts.outputTruncated, true);
    assert.equal(evidence.output.length, MAX_OUTPUT_CHARS);
  });
});

await test('evaluateObligations: неизвестный вид проверки — ok:false', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({ obligations: [{ id: 'strange', check: { kind: 'telepathy' } }] }) });
    const row = evaluateObligations({ root }).obligations[0];
    assert.equal(row.ok, false);
    assert.match(row.detail, /telepathy/u);
  });
});

await test('evaluateObligations: битая структура — error, не исключение', async () => {
  await withStore(async (store) => {
    const root = project({ 'graph.json': '{ это не JSON' });
    let status;
    assert.doesNotThrow(() => { status = evaluateObligations({ root }); });
    assert.deepEqual(status.obligations, []);
    assert.equal(status.error.code, 'invalid-structure');
    assert.ok(status.error.error.includes('JSON'));
    assert.ok(status.error.fix);
    assert.deepEqual(readObligations({ root }), []);
    assert.equal(fs.existsSync(path.join(store, 'evidence')), false, 'для битой структуры evidence не пишется');
  });
});

await test('evaluateObligations: без структуры — error no-structure', async () => {
  await withStore(async () => {
    const root = project(null);
    const status = evaluateObligations({ root });
    assert.equal(status.error.code, 'no-structure');
    assert.deepEqual(status.obligations, []);
  });
});

await test('evaluateObligations: хранилище внутри репозитория — evidence не пишется', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({ obligations: [{ id: 'smoke', check: { kind: 'command', run: 'node -e "process.exit(0)"' } }] }) });
    process.env.DSH_PROJECT_GRAPH_STORE = path.join(root, '.store');
    const row = evaluateObligations({ root }).obligations[0];
    assert.equal(row.ok, true);
    assert.equal(row.evidenceAt, null, 'evidence не подтверждён');
    assert.equal(fs.existsSync(path.join(root, '.store')), false, 'репозиторий не создаёт каталог хранилища');
  });
});

await test('GET /api/obligations: ok:true со статусом и ok:false при битой структуре', async () => {
  await withStore(async () => {
    const good = project({ 'graph.json': graph({
      folders: [folder()],
      obligations: [{ id: 'exchange-read', title: 'разобрать входящие', check: { kind: 'exchange-unread' } }],
    }) });
    writeLetter(good, 'threads/critic-report/01.md', LETTER('structure'));
    const goodHandler = createWebHandler(createGraphRuntime({ roots: [good] }));
    const goodRes = await call(goodHandler, API_PREFIX + '/api/obligations');
    assert.equal(goodRes.status, 200);
    assert.equal(goodRes.body.ok, true);
    assert.equal(goodRes.body.workspace, path.basename(good));
    assert.equal(goodRes.body.obligations[0].ok, false);

    const broken = project({ 'graph.json': '{ битый' });
    const brokenHandler = createWebHandler(createGraphRuntime({ roots: [broken] }));
    const brokenRes = await call(brokenHandler, API_PREFIX + '/api/obligations');
    assert.equal(brokenRes.status, 200);
    assert.equal(brokenRes.body.ok, false);
    assert.equal(brokenRes.body.code, 'invalid-structure');
    assert.ok(brokenRes.body.error);
    assert.ok(brokenRes.body.fix);
  });
});

/*
 * Задание 0113: бейдж панели отвечает на вопрос «что ждёт хода», а не «что мне
 * адресовано». Считаются request/question без письма-ответа с Reply-To на путь
 * письма; report/answer/ack/invitation/note/info сами по себе хода не требуют.
 * Задание 0130: письмом-ответом считается и answer, и ack — с любой стороны;
 * ack без Reply-To заявку не закрывает. Семантика scanExchange не меняется: его
 * unread по-прежнему значит «адресовано и не отмечено прочитанным».
 */
const STATUS_LETTER = (status, from = 'workflow', to = 'structure', replyTo = '',
  date = '2026-11-06T10:00+03:00', ref = '') => 'Format: dsh-exchange/1\n'
  + 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nThread: critic-report\n'
  + 'Status: ' + status + '\n' + (replyTo ? 'Reply-To: ' + replyTo + '\n' : '')
  + (ref ? 'Ref: ' + ref + '\n' : '')
  + 'Subject: ' + status + '\n\nтело\n';

await test('exchangeAttention: request и question без ответа считаются, остальные статусы — нет (0113)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  writeLetter(root, 'threads/critic-report/01.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/critic-report/02.md', STATUS_LETTER('question'));
  for (const status of ['report', 'answer', 'ack', 'invitation', 'note', 'info']) {
    writeLetter(root, 'threads/critic-report/' + status + '.md', STATUS_LETTER(status));
  }
  assert.deepEqual(ATTENTION_STATUSES, ['request', 'question'], 'ход требует только заявка и вопрос');
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 2, 'ходят только request и question');
  const items = attention.items.slice().sort((left, right) => path.basename(left.path).localeCompare(path.basename(right.path)));
  assert.deepEqual(items.map((item) => path.basename(item.path)), ['01.md', '02.md']);
  assert.deepEqual(items.map((item) => item.status), ['request', 'question']);
  assert.deepEqual(Object.keys(items[0]).sort(), ['date', 'path', 'status', 'subject', 'to'], 'строка письма — обещанные поля');
  assert.equal(items[0].to, 'structure');
  assert.equal(items[0].subject, 'request');
  assert.deepEqual(attention.folders, [{ id: 'folder-1', attention: 2 }], 'разбивка по папкам');
  /* Контроль задания: unread сканера считает всю адресованную корреспонденцию — это не счётчик внимания. */
  assert.equal(scanExchange({ root }).unread.length, 8, 'unread сканера по-прежнему считает всё адресованное');
});

await test('exchangeAttention: ответ с Reply-To снимает request, ответ может лежать в другом ящике (0113)', async () => {
  const root = project({ 'graph.json': graph({ folders: [
    folder(),
    folder({ id: 'folder-2', box: { path: 'archive', root: 'workspace' } }),
  ] }) });
  const answered = writeLetter(root, 'threads/critic-report/01.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/critic-report/02.md', STATUS_LETTER('Request'));
  writeLetter(root, 'threads/critic-report/03.md', STATUS_LETTER('question'));
  /* Наш ответ лежит в другом ящике и называет путь письма абсолютно. */
  const reply = path.join(root, 'archive', 'threads', 'reply.md');
  fs.mkdirSync(path.dirname(reply), { recursive: true });
  fs.writeFileSync(reply, STATUS_LETTER('answer', 'structure', 'workflow', answered));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 2, 'отвеченный request снят, Request и question остались');
  const names = attention.items.map((item) => path.basename(item.path)).sort();
  assert.deepEqual(names, ['02.md', '03.md']);
  assert.deepEqual(attention.folders.map((row) => [row.id, row.attention]), [['folder-1', 2], ['folder-2', 0]],
    'папка с ответом сама хода не требует');
});

await test('exchangeAttention: ошибка ящика — attention 0 и строка error, общий счёт цел (0113)', async () => {
  const root = project({ 'graph.json': graph({ folders: [
    folder({ id: 'missing-box', box: { path: 'нет-такого-ящика', root: 'workspace' } }),
    folder(),
  ] }) });
  writeLetter(root, 'threads/critic-report/01.md', STATUS_LETTER('request'));
  let attention;
  assert.doesNotThrow(() => { attention = exchangeAttention({ root }); });
  assert.equal(attention.total, 1, 'счёт соседней папки не падает');
  const missing = attention.folders.find((row) => row.id === 'missing-box');
  assert.equal(missing.attention, 0);
  assert.equal(typeof missing.error, 'string', 'ошибка папки — строка, а не исключение');
  assert.match(missing.error, /не найдена/u);
  assert.equal(attention.folders.reduce((sum, row) => sum + row.attention, 0), attention.total, 'сумма папок сходится');
});

await test('exchangeAttention: без структуры — error и пустой счёт, не исключение (0113)', async () => {
  const root = project(null);
  let attention;
  assert.doesNotThrow(() => { attention = exchangeAttention({ root }); });
  assert.equal(attention.total, 0);
  assert.deepEqual(attention.folders, []);
  assert.deepEqual(attention.items, []);
  assert.equal(attention.error.code, 'no-structure');
  assert.ok(attention.error.error, 'причина названа');
});

await test('scanExchange: строки unread несут status/from/replyTo, число unread не изменилось (0113)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const file = writeLetter(root, 'threads/critic-report/01.md',
    STATUS_LETTER('request', 'workflow', 'structure', 'C:/письма/исходное.md'));
  const scan = scanExchange({ root });
  assert.equal(scan.unread.length, 1, 'число unread прежнее');
  const [row] = scan.unread;
  assert.deepEqual(Object.keys(row).sort(), ['date', 'from', 'path', 'replyTo', 'status', 'subject', 'to'],
    'прежние поля на месте, три новых добавлены');
  assert.equal(row.path, file);
  assert.equal(row.status, 'request');
  assert.equal(row.from, 'workflow');
  assert.equal(row.replyTo, 'C:/письма/исходное.md');
  assert.equal(row.to, 'structure');
  assert.equal(row.subject, 'request');
  assert.equal(scan.boxes[0].unread, 1, 'счётчик папки прежний');
});

/*
 * Задание 0116: старые ответы писали Reply-To ГОЛЫМ именем файла
 * (2026-11-01T01-45+03-00--workflow--06.md), а счётчик 0113 сравнивал только
 * путь, поэтому 10 из 14 «требуют хода» были ложными. Голое имя — ответ на
 * письмо с тем же именем в ТОМ ЖЕ каталоге; ответ из другой папки тем же
 * именем заявку не снимает. Полный путь (0113) работает как раньше.
 */
await test('exchangeAttention: Reply-To голым именем снимает заявку в той же папке (0116)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  writeLetter(root, 'threads/critic-report/01.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/critic-report/02.md', STATUS_LETTER('answer', 'structure', 'workflow', '01.md'));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 0, 'голое имя в той же папке снимает заявку');
  assert.deepEqual(attention.items, []);
  assert.deepEqual(attention.folders, [{ id: 'folder-1', attention: 0 }], 'разбивка сходится с total');
  assert.equal(scanExchange({ root }).unread.length, 1, 'контроль: unread сканера не изменился');
});

await test('exchangeAttention: голое имя из другой папки заявку не снимает (0116)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const question = writeLetter(root, 'threads/critic-report/01.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/other/01.md', STATUS_LETTER('answer', 'structure', 'workflow', '01.md'));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 1, 'ответ из другой папки — не ответ');
  assert.deepEqual(attention.items.map((item) => path.basename(item.path)), ['01.md']);
  assert.equal(attention.items[0].path, question, 'учтено письмо-вопрос, а не ответ');
  assert.deepEqual(attention.folders, [{ id: 'folder-1', attention: 1 }], 'разбивка сходится с total');
});

await test('exchangeAttention: полный путь Reply-To по-прежнему снимает заявку (0116)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const answered = writeLetter(root, 'threads/critic-report/10.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/critic-report/11.md', STATUS_LETTER('question'));
  writeLetter(root, 'threads/critic-report/12.md', STATUS_LETTER('answer', 'structure', 'workflow', answered));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 1, 'абсолютный путь снял request, question остался');
  assert.deepEqual(attention.items.map((item) => path.basename(item.path)), ['11.md']);
});

await test('exchangeAttention: без ответа заявка по-прежнему считается (0116)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  writeLetter(root, 'threads/critic-report/20.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/critic-report/21.md', STATUS_LETTER('question'));
  /* Ответ есть, но голое имя называет ДРУГОЙ файл — заявки не снимаются. */
  writeLetter(root, 'threads/critic-report/22.md', STATUS_LETTER('answer', 'structure', 'workflow', 'another.md'));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 2, 'неотвеченные request и question считаются');
  assert.deepEqual(attention.items.map((item) => path.basename(item.path)).sort(), ['20.md', '21.md']);
});

/*
 * Задание 0128: окно 14 суток. Заявка старше окна не входит в total, а
 * считается в stale; свежая — в total. Просроченные остаются видимыми
 * (staleItems), чтобы хвост можно было разобрать, а не только посчитать.
 */
await test('exchangeAttention: окно 14 суток — старое в stale, свежее в total (0128)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const now = Date.parse('2026-11-20T12:00:00+03:00');
  writeLetter(root, 'threads/critic-report/old.md', STATUS_LETTER('request', 'workflow', 'structure', '', '2026-10-31T10:00+03:00'));
  const fresh = writeLetter(root, 'threads/critic-report/fresh.md', STATUS_LETTER('request', 'workflow', 'structure', '', '2026-11-19T10:00+03:00'));
  const attention = exchangeAttention({ root, now });
  assert.equal(attention.total, 1, 'свежая заявка — в счёте');
  assert.equal(attention.stale, 1, 'двадцатидневная — в просроченных, не в счёте');
  assert.deepEqual(attention.items.map((item) => path.basename(item.path)), ['fresh.md']);
  assert.equal(attention.items[0].path, fresh);
  assert.deepEqual(attention.staleItems.map((item) => path.basename(item.path)), ['old.md'],
    'просроченная названа, чтобы её можно было закрыть');
  assert.deepEqual(attention.folders, [{ id: 'folder-1', attention: 1 }], 'разбивка сходится с total');
  assert.equal(scanExchange({ root }).unread.length, 2, 'контроль: unread сканера не изменился');
});

await test('exchangeAttention: maxAgeMs задаёт окно, граница «не старше» — в total (0128)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const now = Date.parse('2026-11-20T12:00:00+03:00');
  /* Ровно 14 суток — ещё «не старше»; на минуту больше — просрочено. */
  writeLetter(root, 'threads/critic-report/exact.md', STATUS_LETTER('request', 'workflow', 'structure', '', '2026-11-06T12:00:00+03:00'));
  writeLetter(root, 'threads/critic-report/late.md', STATUS_LETTER('question', 'workflow', 'structure', '', '2026-11-06T11:59:00+03:00'));
  const byDefault = exchangeAttention({ root, now });
  assert.equal(ATTENTION_MAX_AGE_MS, 14 * 24 * 60 * 60 * 1000, 'окно по умолчанию — 14 суток');
  assert.equal(byDefault.total, 1, 'ровно 14 суток — в счёте');
  assert.equal(byDefault.stale, 1, '14 суток и минута — просрочено');
  /* Своё окно: час — обе заявки просрочены. */
  const byHour = exchangeAttention({ root, now, maxAgeMs: 60 * 60 * 1000 });
  assert.equal(byHour.total, 0);
  assert.equal(byHour.stale, 2);
  /* Ноль — окна нет: просрочено всё, что старше мгновения. */
  const byZero = exchangeAttention({ root, now, maxAgeMs: 0 });
  assert.equal(byZero.total, 0);
  assert.equal(byZero.stale, 2);
  assert.deepEqual(byZero.items, []);
});

await test('exchangeAttention: ответ снимает заявку до окна, повтор с Ref — свежая (0128)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const now = Date.parse('2026-11-20T12:00:00+03:00');
  const old = writeLetter(root, 'threads/critic-report/old.md', STATUS_LETTER('request', 'workflow', 'structure', '', '2026-10-31T10:00+03:00'));
  writeLetter(root, 'threads/critic-report/old-reply.md', STATUS_LETTER('answer', 'structure', 'workflow', old, '2026-11-01T10:00+03:00'));
  writeLetter(root, 'threads/critic-report/repeat.md', STATUS_LETTER('request', 'workflow', 'structure', '', '2026-11-19T10:00+03:00', 'threads/critic-report/old.md'));
  const attention = exchangeAttention({ root, now });
  assert.equal(attention.total, 1, 'отвеченная старая не в счёте, повтор — в счёте');
  assert.equal(attention.stale, 0, 'отвеченную не ждут — она и не просрочена');
  assert.deepEqual(attention.items.map((item) => path.basename(item.path)), ['repeat.md']);
});

await test('exchangeAttention: письмо с нечитаемой датой — не заявка и не просрочено (0128)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const now = Date.parse('2026-11-20T12:00:00+03:00');
  writeLetter(root, 'threads/critic-report/broken.md', 'Format: dsh-exchange/1\nFrom: workflow\nTo: structure\n'
    + 'Date: не дата\nThread: critic-report\nStatus: request\n\nтело\n');
  const attention = exchangeAttention({ root, now });
  assert.equal(attention.total, 0);
  assert.equal(attention.stale, 0, 'нечитаемая дата не считается просроченной');
  assert.deepEqual(attention.staleItems, []);
  assert.equal(scanExchange({ root }).skipped.filter((row) => row.reason === 'no-header').length, 1,
    'сканер называет причину: письмо без шапки');
});

/*
 * Задание 0130: ack закрывает заявку наравне с answer.
 *
 * Живой случай: workflow закрыл пять наших заявок пятью ack-письмами с Reply-To
 * полным путём, но счётчик остался 5 — закрытием считалось только письмо от
 * НАШЕЙ метки. Теперь закрывает письмо со Status answer ИЛИ ack с Reply-To на
 * заявку; квитанция без Reply-To не закрывает, потому что не называет, что
 * закрыто. Путь в Reply-To читается прежними правилами 0113/0116: полный, от
 * корня или ящика, и голое имя файла в той же папке.
 */
await test('exchangeAttention: ack с Reply-To полным путём закрывает заявку (0130)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const asked = writeLetter(root, 'threads/critic-report/30.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/critic-report/31.md', STATUS_LETTER('ack', 'workflow', 'structure', asked));
  assert.deepEqual(CLOSING_STATUSES, ['answer', 'ack'], 'закрывают ответ и квитанция');
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 0, 'ack с Reply-To снял заявку');
  assert.deepEqual(attention.items, []);
  assert.deepEqual(attention.folders, [{ id: 'folder-1', attention: 0 }], 'разбивка сходится с total');
  assert.equal(scanExchange({ root }).unread.length, 2, 'контроль: unread сканера не изменился');
});

await test('exchangeAttention: ack без Reply-To заявку не закрывает (0130)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const asked = writeLetter(root, 'threads/critic-report/32.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/critic-report/33.md', STATUS_LETTER('ack'));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 1, 'квитанция без адреса не закрывает: непонятно, что закрыто');
  assert.deepEqual(attention.items.map((item) => item.path), [asked]);
  assert.equal(attention.items[0].status, 'request');
});

await test('exchangeAttention: answer закрывает по-прежнему, ack и answer снимают обе заявки (0130)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const byAnswer = writeLetter(root, 'threads/critic-report/40.md', STATUS_LETTER('question'));
  const byAck = writeLetter(root, 'threads/critic-report/41.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/critic-report/42.md', STATUS_LETTER('answer', 'structure', 'workflow', byAnswer));
  writeLetter(root, 'threads/critic-report/43.md', STATUS_LETTER('ack', 'workflow', 'structure', byAck));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 0, 'answer и ack закрывают одинаково');
});

await test('exchangeAttention: ack голым именем закрывает в своей папке, из другой — нет (0130)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  writeLetter(root, 'threads/critic-report/50.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/critic-report/51.md', STATUS_LETTER('ack', 'workflow', 'structure', '50.md'));
  writeLetter(root, 'threads/critic-report/52.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/other/52.md', STATUS_LETTER('ack', 'workflow', 'structure', '52.md'));
  const attention = exchangeAttention({ root });
  assert.deepEqual(attention.items.map((item) => path.basename(item.path)), ['52.md'],
    'голое имя в своей папке закрыло заявку, чужое имя из другой папки — нет');
});

await test('exchangeAttention: ack с Reply-To на другое письмо заявку не закрывает (0130)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  writeLetter(root, 'threads/critic-report/60.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/critic-report/61.md', STATUS_LETTER('report'));
  writeLetter(root, 'threads/critic-report/62.md', STATUS_LETTER('ack', 'workflow', 'structure', '61.md'));
  const attention = exchangeAttention({ root });
  assert.deepEqual(attention.items.map((item) => path.basename(item.path)), ['60.md'],
    'ответ на другое письмо — не ответ на заявку');
});

await test('exchangeAttention: ack снимает и просроченную заявку — хвост не висит (0130)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const now = Date.parse('2026-11-20T12:00:00+03:00');
  const old = writeLetter(root, 'threads/critic-report/70.md',
    STATUS_LETTER('request', 'workflow', 'structure', '', '2026-10-31T10:00+03:00'));
  writeLetter(root, 'threads/critic-report/71.md',
    STATUS_LETTER('ack', 'workflow', 'structure', old, '2026-11-19T10:00+03:00'));
  const attention = exchangeAttention({ root, now });
  assert.equal(attention.total, 0);
  assert.equal(attention.stale, 0, 'закрытая заявка не просрочена');
  assert.deepEqual(attention.staleItems, []);
});

/*
 * Задание 0131: Reply-To ОТНОСИТЕЛЬНЫМ путём от папки обмена.
 *
 * Живой случай: workflow закрыл пять заявок квитанциями с Reply-To
 * «threads/critic-report/<файл>.md», а счётчик остался 5 — такой путь
 * разрешался от каталога письма и промахивался мимо заявки. Теперь путь с
 * разделителями читается от папки обмена, а если файла там нет — от каталога
 * самого письма; закрывает существующий файл. Абсолютный путь (0113) и голое
 * имя (0116) не меняются, иного смысла у правил нет.
 */
await test('exchangeAttention: относительный Reply-To от папки обмена закрывает заявку из корня ящика (0131)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const asked = writeLetter(root, 'threads/critic-report/01.md', STATUS_LETTER('request'));
  /* Квитанция — в КОРНЕ ящика, путь к заявке — от папки обмена (как пишет workflow). */
  writeLetter(root, 'ack.md', STATUS_LETTER('ack', 'workflow', 'structure', 'threads/critic-report/01.md'));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 0, 'относительный путь от папки обмена закрыл заявку: ' + JSON.stringify(attention.items));
  assert.deepEqual(attention.items, []);
  assert.equal(attention.stale, 0, 'закрытая заявка не уходит в просроченные');
  assert.deepEqual(attention.folders, [{ id: 'folder-1', attention: 0 }], 'разбивка сходится с total');
  assert.equal(scanExchange({ root }).unread.length, 1, 'контроль: счётчик сканера не изменился');
  assert.equal(asked, path.join(root, 'coordination', 'threads', 'critic-report', '01.md'));
});

await test('exchangeAttention: относительный Reply-To от папки обмена закрывает заявку из другой ветки (0131)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  writeLetter(root, 'threads/critic-report/02.md', STATUS_LETTER('question'));
  /*
   * Каталог квитанции — threads/other: путь от него указывал бы в
   * «threads/other/threads/critic-report/02.md». От папки обмена он верный.
   */
  writeLetter(root, 'threads/other/ack.md', STATUS_LETTER('ack', 'workflow', 'structure', 'threads/critic-report/02.md'));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 0, 'каталог письма не важнее папки обмена: ' + JSON.stringify(attention.items));
  assert.deepEqual(attention.items, []);
  assert.deepEqual(attention.folders, [{ id: 'folder-1', attention: 0 }], 'разбивка сходится с total');
});

await test('exchangeAttention: если от папки обмена файла нет — путь читается от каталога письма (0131)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  /* Заявка лежит во вложенной папке своей ветки; «sub/q.md» от ящика — в пустоту. */
  const asked = writeLetter(root, 'threads/other/sub/q.md', STATUS_LETTER('request'));
  writeLetter(root, 'threads/other/ack.md', STATUS_LETTER('ack', 'workflow', 'structure', 'sub/q.md'));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 0, 'путь от каталога письма закрыл заявку: ' + JSON.stringify(attention.items));
  assert.equal(attention.items.length, 0);
  assert.equal(asked, path.join(root, 'coordination', 'threads', 'other', 'sub', 'q.md'));
});

await test('exchangeAttention: относительный Reply-To в пустоту заявку не закрывает (0131)', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const asked = writeLetter(root, 'threads/critic-report/03.md', STATUS_LETTER('request'));
  writeLetter(root, 'ack.md', STATUS_LETTER('ack', 'workflow', 'structure', 'threads/critic-report/нет-такого.md'));
  const attention = exchangeAttention({ root });
  assert.equal(attention.total, 1, 'несуществующий адрес не закрывает ничего');
  assert.deepEqual(attention.items.map((item) => item.path), [asked]);
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error((failure.error && failure.error.stack) || failure.error);
}
console.log('OBLIGATIONS TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
