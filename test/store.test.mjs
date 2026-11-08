/**
 * Where the structure lives: the external store by default, the repository for
 * legacy projects.
 *
 * The suite is deliberately independent of the panel's look: it pins the
 * resolver's rules, proves that a fresh project's init and the critic's base spec
 * stay out of the repository, and proves that a legacy project keeps working in
 * place. Every test that creates files sets DSH_PROJECT_GRAPH_STORE to a
 * temporary folder — a test must never write into the real ~/.dsh.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime, createWebHandler, readGraph, API_PREFIX } from '../lib/api.js';
import { ensureCriticSpec } from '../lib/critic-spec.js';
import { readStructure } from '../lib/load.js';
import {
  STORE_ENV, STORE_FILES, criticSpecFile, graphFile, linksFile, mode, normalizeStructureDir,
  resolveStructure, storeDir, storeName,
} from '../lib/store.js';

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

/** Absolute temporary project root (realpath: Windows temp is a short name). */
function projectRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-store-root-')));
}

/** Temporary store folder. */
function storeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg-store-dir-'));
}

/** Run body with DSH_PROJECT_GRAPH_STORE set (or unset when store is null). */
async function withEnv(store, body) {
  const previous = process.env[STORE_ENV];
  if (store === null) delete process.env[STORE_ENV];
  else process.env[STORE_ENV] = store;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[STORE_ENV];
    else process.env[STORE_ENV] = previous;
  }
}

function sha1Hex(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

/** A project that already declares its structure in the repository. */
function legacyProject(files = { 'graph.json': JSON.stringify({ version: 1, nodes: [], edges: [] }) }) {
  const root = projectRoot();
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, 'structure', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

async function call(handler, url, options = {}) {
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
  await handler(req, res);
  return res;
}

/* ---------- resolver ---------- */

await test('по умолчанию структура живёт в ~/.dsh/project-graph/<имя>-<sha1(root)[0..8]>', async () => {
  await withEnv(null, async () => {
    const root = projectRoot();
    const target = resolveStructure(root);
    const expected = path.join(os.homedir(), '.dsh', 'project-graph',
      path.basename(root) + '-' + sha1Hex(path.resolve(root)).slice(0, 8));
    assert.equal(target.mode, 'store', 'чистый проект не пишет в репозиторий');
    assert.equal(target.dir, expected);
    assert.equal(target.graphFile, path.join(expected, 'graph.json'));
    assert.equal(target.linksFile, path.join(expected, 'links.json'));
    assert.equal(target.criticSpecFile, path.join(expected, 'critic', 'spec.md'));
    assert.equal(fs.existsSync(expected), false, 'резолвер только решает, но ничего не создаёт');
    assert.equal(mode(root), 'store');
    assert.equal(storeDir(root), expected);
  });
});

await test('DSH_PROJECT_GRAPH_STORE задаёт каталог хранилища целиком', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    const target = resolveStructure(root);
    assert.equal(target.mode, 'store');
    assert.equal(target.dir, path.resolve(store));
    assert.equal(graphFile(root), path.join(store, STORE_FILES.graph));
    assert.equal(linksFile(root), path.join(store, STORE_FILES.links));
    assert.equal(criticSpecFile(root), path.join(store, STORE_FILES.criticSpec));
  });
  assert.equal(fs.existsSync(store), true, 'сам каталог хранилища не удаляется');
});

await test('имя хранилища стабильно от корня и различает одноимённые проекты', async () => {
  await withEnv(null, async () => {
    const root = projectRoot();
    const first = storeName(root);
    assert.equal(storeName(root), first, 'повторный вызов даёт то же имя');
    assert.equal(storeName(root + path.sep), first, 'хвостовой разделитель не меняет имя');
    assert.equal(storeName(path.join(root, '.')), first, 'точка в пути не меняет имя');
    assert.equal(storeName(path.join(root, 'structure', '..')), first, 'путь с .. нормализуется');

    const otherParent = projectRoot();
    const twin = path.join(otherParent, path.basename(root));
    fs.mkdirSync(twin, { recursive: true });
    assert.notEqual(storeName(twin), first, 'одинаковое имя в другом каталоге — другое хранилище');
  });
});

await test('легаси-проект с structure/graph.json остаётся на месте даже при заданном хранилище', async () => {
  const store = storeRoot();
  const root = legacyProject();
  await withEnv(store, async () => {
    const target = resolveStructure(root);
    assert.equal(target.mode, 'repo');
    assert.equal(target.dir, path.join(root, 'structure'));
    assert.equal(target.graphFile, path.join(root, 'structure', 'graph.json'));
    assert.equal(target.linksFile, path.join(root, 'structure', 'links.json'));
    assert.equal(target.criticSpecFile, path.join(root, 'docs', 'critic', 'spec.md'));
    assert.equal(fs.readdirSync(store).length, 0, 'для легаси-проекта хранилище не создаётся');
  });
});

await test('легаси: разбитая структура без graph.json тоже остаётся в репозитории', async () => {
  const store = storeRoot();
  const root = legacyProject({
    'nodes.json': JSON.stringify({ version: 1, nodes: [{ id: 'coordinator', role: 'координатор' }] }),
    'links.json': JSON.stringify({ version: 1, edges: [] }),
  });
  await withEnv(store, async () => {
    const target = resolveStructure(root);
    assert.equal(target.mode, 'repo', 'фрагменты — это уже объявленная структура проекта');
    assert.equal(target.dir, path.join(root, 'structure'));
    assert.equal(fs.readdirSync(store).length, 0);
  });
});

await test('пустая папка structure/ не делает проект легаси: объявления в ней нет', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
    assert.equal(resolveStructure(root).mode, 'store', 'пустая папка — ещё не структура');
    assert.equal(fs.readdirSync(store).length, 0);
  });
});

await test('логическое имя папки нормализуется, режим не зависит от написания', async () => {
  await withEnv(null, async () => {
    const root = projectRoot();
    assert.equal(normalizeStructureDir('structure'), 'structure');
    assert.equal(normalizeStructureDir('/structure/'), 'structure');
    assert.equal(normalizeStructureDir('structure\\'), 'structure');
    assert.equal(normalizeStructureDir(''), 'structure');
    assert.equal(normalizeStructureDir(' blocks '), 'blocks');
    assert.equal(resolveStructure(root, '/structure/').structureDir, 'structure');
  });
});

/* ---------- init writes outside the repository ---------- */

await test('init в режиме хранилища не создаёт structure/ в репозитории', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    const handler = createWebHandler(createGraphRuntime({ roots: [root] }));
    const res = await call(handler, API_PREFIX + '/api/init', { method: 'POST' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(String(res.body.created).startsWith(store), 'created указывает в хранилище: ' + res.body.created);
    assert.equal(fs.existsSync(path.join(root, 'structure')), false, 'structure/ в репозитории не создана');
    assert.equal(fs.existsSync(path.join(root, 'docs', 'critic')), false, 'docs/critic/ в репозитории не создана');
    assert.deepEqual(fs.readdirSync(store).sort(), ['graph.json'], 'в хранилище ровно объявление');
    const payload = readGraph(createGraphRuntime({ roots: [root] }), root);
    assert.equal(payload.exists, true);
    assert.equal(payload.summary.nodes, 3);
    assert.deepEqual(payload.errors, []);
  });
});

await test('init в режиме хранилища: повторное нажатие ничего не перезаписывает', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    const handler = createWebHandler(createGraphRuntime({ roots: [root] }));
    const first = await call(handler, API_PREFIX + '/api/init', { method: 'POST' });
    assert.equal(first.status, 201);
    const before = fs.readFileSync(first.body.created, 'utf8');
    const second = await call(handler, API_PREFIX + '/api/init', { method: 'POST' });
    assert.equal(second.status, 409);
    assert.match(second.body.fix, /не перезаписывает/);
    assert.equal(fs.readFileSync(first.body.created, 'utf8'), before);
  });
});

await test('чтение из хранилища сохраняет логические имена фрагментов', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    fs.writeFileSync(path.join(store, 'graph.json'), JSON.stringify({
      version: 1,
      models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [{ id: 'coordinator', role: 'координатор', model: 'work' }],
      edges: [],
    }));
    const read = readStructure(root);
    assert.equal(read.mode, 'store');
    assert.equal(read.dir, path.resolve(store));
    assert.deepEqual(read.files.map((file) => file.name), ['structure/graph.json']);
    const payload = readGraph(createGraphRuntime({ roots: [root] }), root);
    assert.deepEqual(payload.sources.map((source) => source.file), ['structure/graph.json'],
      'панель видит прежнее логическое имя');
    assert.equal(payload.summary.nodes, 1);
  });
});

await test('связи в режиме хранилища пишутся в файл хранилища, репозиторий чист', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    const handler = createWebHandler(createGraphRuntime({ roots: [root] }));
    assert.equal((await call(handler, API_PREFIX + '/api/init', { method: 'POST' })).status, 201);
    const url = API_PREFIX + '/api/link?root=' + encodeURIComponent(root) + '&action=add&from=coordinator&to=judge&kind=peer';
    const added = await call(handler, url, { method: 'POST' });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.file, 'structure/graph.json', 'логическое имя фрагмента прежнее');
    const document = JSON.parse(fs.readFileSync(path.join(store, 'graph.json'), 'utf8'));
    assert.ok(document.edges.some((edge) => edge.from === 'coordinator' && edge.to === 'judge' && edge.kind === 'peer'),
      'связь записана в файл хранилища');
    assert.equal(fs.existsSync(path.join(root, 'structure')), false, 'structure/ в репозитории не появилась');

    const removed = await call(handler, API_PREFIX + '/api/link?root=' + encodeURIComponent(root) + '&action=remove&from=coordinator&to=judge&kind=peer', { method: 'POST' });
    assert.equal(removed.status, 200);
    const after = JSON.parse(fs.readFileSync(path.join(store, 'graph.json'), 'utf8'));
    assert.equal(after.edges.filter((edge) => edge.kind === 'peer').length, 0, 'связь удалена оттуда же');
  });
});

await test('раскладка в режиме хранилища пишется в файл хранилища', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    const handler = createWebHandler(createGraphRuntime({ roots: [root] }));
    assert.equal((await call(handler, API_PREFIX + '/api/init', { method: 'POST' })).status, 201);
    const res = await call(handler, API_PREFIX + '/api/layout', {
      method: 'POST',
      body: JSON.stringify({ root, positions: { coordinator: { x: 10, y: 20 } } }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.files, ['structure/graph.json']);
    const document = JSON.parse(fs.readFileSync(path.join(store, 'graph.json'), 'utf8'));
    const node = document.nodes.find((item) => item.id === 'coordinator');
    assert.deepEqual({ x: node.x, y: node.y }, { x: 10, y: 20 }, 'координаты сохранены в хранилище');
    assert.equal(fs.existsSync(path.join(root, 'structure')), false, 'structure/ в репозитории не появилась');
  });
});

/* ---------- critic spec ---------- */

await test('ensureCriticSpec в режиме хранилища пишет <store>/critic/spec.md', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    const answer = ensureCriticSpec(root);
    const expected = path.join(store, 'critic', 'spec.md');
    assert.equal(answer.created, true, 'спека создана');
    assert.equal(String(answer), expected, 'String(answer) — реальный абсолютный путь');
    assert.equal(answer.absolute, expected);
    assert.equal(answer.mode, 'store');
    assert.ok(fs.existsSync(expected), 'файл лежит в хранилище');
    assert.match(fs.readFileSync(expected, 'utf8'), /Базовая спека критика/u);
    assert.equal(fs.existsSync(path.join(root, 'docs', 'critic')), false, 'docs/critic/ в репозитории не появилась');

    fs.writeFileSync(expected, 'ПРАВКА ЧЕЛОВЕКА\n', 'utf8');
    const second = ensureCriticSpec(root);
    assert.equal(second.created, false, 'существующая спека не перезаписывается');
    assert.equal(fs.readFileSync(expected, 'utf8'), 'ПРАВКА ЧЕЛОВЕКА\n');
  });
});

await test('ensureCriticSpec в легаси-проекте пишет docs/critic/spec.md', async () => {
  const store = storeRoot();
  const root = legacyProject();
  await withEnv(store, async () => {
    const answer = ensureCriticSpec(root);
    const expected = path.join(root, 'docs', 'critic', 'spec.md');
    assert.equal(answer.created, true);
    assert.equal(answer.mode, 'repo');
    assert.equal(answer.path, path.join('docs', 'critic', 'spec.md'), 'логическое имя прежнее');
    assert.equal(String(answer), expected);
    assert.ok(fs.existsSync(expected));
    assert.equal(fs.existsSync(path.join(store, 'critic')), false, 'в хранилище спеки нет');
  });
});

/* ---------- 0174: служебные файлы стора ---------- */

/*
 * Стор — папка состояния, а не только объявление структуры. health.json,
 * digest.json и exchange-seen.json лежат рядом с graph.json и фрагментами не
 * являются: иначе e-trace получал nodes:0 и error empty-graph вместо нового
 * проекта. В repo-режиме (workspace) фильтр не применяется.
 */

await test('0174: служебные *.json стора не читаются как фрагменты', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    fs.writeFileSync(path.join(store, 'health.json'), JSON.stringify({ ok: true }));
    fs.writeFileSync(path.join(store, 'digest.json'), JSON.stringify({ total: 0, at: '2026-11-09' }));
    fs.writeFileSync(path.join(store, 'exchange-seen.json'), JSON.stringify({}));
    const read = readStructure(root);
    assert.equal(read.mode, 'store');
    assert.deepEqual(read.files, [], 'служебные файлы не фрагменты');
    assert.equal(read.count, 0, 'счётчик не считает служебные');
    assert.deepEqual(read.problems, [], 'пропуск служебного — не проблема чтения');
  });
});

await test('0174: служебные не прячут настоящий фрагмент стора', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    fs.writeFileSync(path.join(store, 'health.json'), '{}');
    fs.writeFileSync(path.join(store, 'digest.json'), '{}');
    fs.writeFileSync(path.join(store, 'graph.json'), JSON.stringify({
      version: 1,
      nodes: [{ id: 'coordinator', role: 'координатор' }],
      edges: [],
    }));
    const read = readStructure(root);
    assert.deepEqual(read.files.map((file) => file.name), ['structure/graph.json'], 'читается только объявление');
    assert.equal(read.count, 1, 'счётчик считает только фрагменты');
    const payload = readGraph(createGraphRuntime({ roots: [root] }), root);
    assert.equal(payload.summary.nodes, 1);
    assert.deepEqual(payload.errors, []);
  });
});

await test('0174: e-trace с одним health.json в сторе — новый проект, а не ошибка', async () => {
  const store = storeRoot();
  await withEnv(store, async () => {
    const root = projectRoot();
    fs.writeFileSync(path.join(store, 'health.json'), JSON.stringify({ enabled: true }));
    const payload = readGraph(createGraphRuntime({ roots: [root] }), root);
    assert.equal(payload.exists, true, 'папка стора существует');
    assert.equal(payload.fileCount, 0, 'фрагментов нет');
    assert.equal(payload.summary.nodes, 0);
    const codes = payload.errors.map((item) => item.code);
    assert.equal(codes.includes('empty-graph'), false, 'нет error empty-graph: ' + JSON.stringify(codes));
    const warning = payload.warnings.find((item) => item.code === 'empty-graph');
    assert.ok(warning, 'есть warning нового проекта: ' + JSON.stringify(payload.warnings.map((item) => item.code)));
  });
});

await test('0174: в repo-режиме health.json остаётся настоящим фрагментом', async () => {
  const store = storeRoot();
  const root = legacyProject({
    'graph.json': JSON.stringify({ version: 1, nodes: [{ id: 'coordinator', role: 'координатор' }], edges: [] }),
    'health.json': JSON.stringify({ version: 1, nodes: [], edges: [] }),
    'digest.json': JSON.stringify({ version: 1, nodes: [], edges: [] }),
  });
  await withEnv(store, async () => {
    const read = readStructure(root);
    assert.equal(read.mode, 'repo', 'легаси-проект читается на месте');
    assert.deepEqual(read.files.map((file) => file.name).sort(), [
      'structure/digest.json', 'structure/graph.json', 'structure/health.json',
    ], 'в workspace-режиме фильтр не применяется');
    assert.equal(read.count, 3);
  });
});

console.log('STORE TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + (passed + failures.length));
for (const failure of failures) {
  console.log('FAIL ' + failure.name);
  console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error));
}
process.exit(failures.length === 0 ? 0 : 1);
