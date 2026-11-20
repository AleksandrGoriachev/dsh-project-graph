/**
 * 0291: доступность LLM при выборе модели узла.
 *
 * Каталог отвечает «модель объявлена», а не «DSH её обслужит». Поэтому запись
 * узла спрашивает службу llm (resolveCallConfig) до файла, а панель — отдельным
 * действием action=check, которое не пишет ничего. Тесты держат оба решения и
 * оба отказа: служба не даёт маршрут и службы нет вовсе.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  API_PREFIX, checkModelAvailability, createGraphRuntime, createWebHandler,
} from '../lib/api.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Каталог живёт в службе llm: p1/m1 и p1/m2 объявлены. */
const CATALOG = [{ id: 'p1', name: 'Provider One' }];
const MODELS = [{ id: 'm1' }, { id: 'm2' }];

function llmWith(impl) {
  return {
    listProviders: () => CATALOG,
    listModels: () => MODELS,
    resolveCallConfig: impl,
  };
}

const accepts = () => llmWith(async (config) => ({ provider: config.provider, model: config.model }));

/* Отказ DSH: тот же текст, что увидел бы запуск узла. */
function refuses(message) {
  return llmWith(async () => { throw new Error(message); });
}

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-0291-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'worker', role: 'исполнитель', provider: 'p1', model: 'm1' }],
    edges: [],
  }, null, 2));
  return root;
}

function makeRuntime(root, deps = {}) {
  return createGraphRuntime({ roots: [root] }, deps);
}

/* Запрос и ответ панели: маршруты — обвязка над чистыми чтениями. */
function call(handler, url, body, method = 'POST') {
  const res = {
    status: 0,
    body: null,
    writableEnded: false,
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(String(text)); this.writableEnded = true; },
  };
  const req = {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) {
      if (event === 'data' && body !== undefined) fn(Buffer.from(String(body)));
      if (event === 'end') fn();
    },
  };
  return Promise.resolve(handler(req, res)).then(() => res);
}

function structureOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
}

/*
 * Структура по умолчанию живёт вне репозитория; набор не должен писать в
 * реальный профиль, поэтому у прогона своё хранилище.
 */
async function withStore(body) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-0291-store-'));
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

test('0291: годный маршрут проходит проверку доступности', async () => {
  const asked = [];
  const llm = llmWith(async (config) => { asked.push(config); return { ...config }; });
  const verdict = await checkModelAvailability({ getLlm: () => llm }, 'p1', 'm1');
  assert.deepEqual(verdict, { ok: true });
  assert.deepEqual(asked, [{ provider: 'p1', model: 'm1' }], 'спрошена именно выбранная пара');
});

test('0291: отказ DSH — model-unavailable с его текстом', async () => {
  const llm = refuses('provider "p1" is not available for this Session');
  const verdict = await checkModelAvailability({ getLlm: () => llm }, 'p1', 'm1');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'model-unavailable');
  assert.match(verdict.error, /not available/u, 'отказ службы не переписан панелью');
  assert.match(verdict.error, /p1\/m1/u, 'отказ называет выбранную пару');
  assert.ok(verdict.fix, 'отказ несёт рецепт');
});

test('0291: без службы llm проверка не выдумывает ответ', async () => {
  const missing = await checkModelAvailability({ getLlm: () => null }, 'p1', 'm1');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'llm-unavailable');
  assert.ok(missing.fix);
  const broken = await checkModelAvailability({ getLlm: () => { throw new Error('inactive context'); } }, 'p1', 'm1');
  assert.equal(broken.code, 'llm-unavailable', 'падение геттера — та же «службы нет»');
});

test('0291: неполная пара — отказ до службы llm', async () => {
  let asked = 0;
  const llm = llmWith(async () => { asked += 1; return {}; });
  for (const [provider, model] of [['', 'm1'], ['p1', ''], ['', '']]) {
    const verdict = await checkModelAvailability({ getLlm: () => llm }, provider, model);
    assert.equal(verdict.ok, false, 'пара ' + provider + '/' + model + ' не проходит');
    assert.equal(verdict.code, 'model-unavailable');
  }
  assert.equal(asked, 0, 'неполный маршрут в службу не уходит');
});

test('0291: add проверяет доступность до записи, отказ — 400 без файла', async () => {
  await withStore(async () => {
    const root = project();
    const before = structureOf(root).nodes.length;
    const handler = createWebHandler(makeRuntime(root, { getLlm: () => refuses('model "m2" is not available') }));
    const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(root),
      JSON.stringify({ id: 'critic-1', role: 'критик', provider: 'p1', model: 'm2' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'model-unavailable');
    assert.match(res.body.error, /not available/u, 'отказ DSH виден человеку');
    assert.ok(res.body.fix, 'отказ несёт рецепт');
    assert.equal(structureOf(root).nodes.length, before, 'запись не выполнена');
  });
});

test('0291: update проверяет доступность до записи, отказ не меняет модель', async () => {
  await withStore(async () => {
    const root = project();
    const handler = createWebHandler(makeRuntime(root, { getLlm: () => refuses('seat is closed') }));
    const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(root) + '&action=update',
      JSON.stringify({ id: 'worker', role: 'исполнитель', provider: 'p1', model: 'm2' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'model-unavailable');
    const worker = structureOf(root).nodes.find((node) => node.id === 'worker');
    assert.equal(worker.model, 'm1', 'старая модель осталась: запись не выполнена');
    assert.equal(worker.role, 'исполнитель', 'роль тоже не записана');
  });
});

test('0291: годный маршрут пишется, служба спрошена один раз', async () => {
  await withStore(async () => {
    const root = project();
    const asked = [];
    const llm = llmWith(async (config) => { asked.push(config); return { ...config }; });
    const handler = createWebHandler(makeRuntime(root, { getLlm: () => llm }));
    const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(root),
      JSON.stringify({ id: 'critic-1', role: 'критик', provider: 'p1', model: 'm2' }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.node.model, 'm2');
    assert.deepEqual(asked, [{ provider: 'p1', model: 'm2' }], 'проверена пара, которая записана');
  });
});

test('0291: action=check отвечает результатом и ничего не пишет', async () => {
  await withStore(async () => {
    const root = project();
    const original = fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8');
    const good = createWebHandler(makeRuntime(root, { getLlm: () => accepts() }));
    const ok = await call(good, API_PREFIX + '/api/node?root=' + encodeURIComponent(root) + '&action=check'
      + '&provider=p1&model=m2', undefined, 'GET');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.provider, 'p1');
    assert.equal(ok.body.model, 'm2');

    const bad = createWebHandler(makeRuntime(root, { getLlm: () => refuses('no access to m2') }));
    const refused = await call(bad, API_PREFIX + '/api/node?root=' + encodeURIComponent(root) + '&action=check'
      + '&provider=p1&model=m2', undefined, 'GET');
    assert.equal(refused.status, 400);
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.code, 'model-unavailable');
    /* Та же проверка телом запроса: панель берёт GET, клиенты могут POST. */
    const posted = await call(good, API_PREFIX + '/api/node?root=' + encodeURIComponent(root) + '&action=check',
      JSON.stringify({ provider: 'p1', model: 'm2' }));
    assert.equal(posted.status, 200);
    assert.equal(posted.body.ok, true);
    const postRefused = await call(bad, API_PREFIX + '/api/node?root=' + encodeURIComponent(root) + '&action=check',
      JSON.stringify({ provider: 'p1', model: 'm2' }));
    assert.equal(postRefused.status, 400);
    assert.equal(postRefused.body.code, 'model-unavailable');
    assert.equal(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'), original,
      'проверка не меняет файл структуры');
  });
});

test('0291: панель зовёт проверку при выборе модели и перед записью', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.match(source, /action=check/u, 'панель знает действие check');
  assert.match(source, /verifySelectedModel\(/u, 'выбор модели запускает проверку');
  assert.match(source, /const availability = /u, 'сохранение ждёт результат проверки');
  assert.match(source, /setNodeEditorError\(/u, 'отказ показывается редактором узла');
});
