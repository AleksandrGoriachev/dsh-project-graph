/**
 * The HTTP half is exercised with mock request/response objects: the routes are
 * wiring over pure readers, so a DSH host is not needed to prove them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  createGraphRuntime, createWebHandler, readGraph, readEngine, registerGraphWeb, selectRoot, API_PREFIX,
  DEFAULT_WORKFLOW_INSTALL_SPEC, checkWorkflow, addNode, updateNode, writeFileAtomic, closeExchangeRequest, exchangeUnread,
  checkStructureRelease, readStructureInstallMode, updateLinkRelease, PLUGIN_VERSION,
  describePnpmFailure,
} from '../lib/api.js';
import { exchangeAttention } from '../lib/obligations.js';
import { noteRun } from '../lib/runs.js';
import { resolveStructure } from '../lib/store.js';

/*
 * Структура живёт вне репозитория по умолчанию. Набор не должен писать в
 * реальный ~/.dsh: каждый тест, который создаёт структуру в чистом проекте,
 * получает своё временное хранилище. Переменная задаёт каталог хранилища
 * целиком, поэтому общий на прогон каталог склеил бы разные проекты в один.
 */
async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-store-'));
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

const GRAPH = {
  version: 1,
  models: {
    ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' },
    glm: { provider: 'opencode', model: 'glm-5.3-flash', family: 'zhipu' },
  },
  nodes: [
    { id: 'analyst-a', role: 'analyst', model: 'ds', brief: 'требования', prompt: 'Роль: аналитик. Definition of Done: требования собраны и подтверждены.' },
    { id: 'analyst-b', role: 'analyst', model: 'ds', prompt: 'Роль: аналитик. Definition of Done: факты проверены по источникам.' },
    { id: 'critic', role: 'acceptor', model: 'glm', mustDifferFrom: ['analyst-a'], prompt: 'Роль: приёмщик. Definition of Done: вердикт вынесен и подкреплён.' },
  ],
  edges: [
    { from: 'analyst-a', to: 'critic', kind: 'review' },
    { from: 'analyst-b', to: 'critic', kind: 'review' },
    { from: 'analyst-a', to: 'analyst-b', kind: 'peer' },
  ],
};

function makeProject(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-'));
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

function makeRuntime(roots, config = {}, deps = {}) {
  return createGraphRuntime({ roots, ...config }, deps);
}

/* Каталог связанной установки: package.json, из которого читается версия после pull. */
function checkoutDir(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-checkout-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-project-graph', version }, null, 2));
  return dir;
}

/*
 * Подставной git: ключ — полная командная строка (argv через пробел), запасной
 * ключ — последний аргумент, как в проверке 0107. Вызовы записываются, чтобы
 * тест мог доказать отсутствие pull на грязном дереве и отсутствие force.
 */
function gitRunner(map = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const key = args.join(' ');
    const value = map[key] !== undefined ? map[key] : map[args[args.length - 1]];
    return typeof value === 'function' ? value(args) : (value || { code: 0, stdout: '', stderr: '' });
  };
  return { run, calls };
}

/* Общий блок движка workflow — тот, из которого читается режим (задание 0092). */
function makeWorkflowProject(policy, graph = GRAPH) {
  const dir = makeProject({ 'graph.json': graph });
  fs.mkdirSync(path.join(dir, 'docs', 'subagent-workflow'), { recursive: true });
  const config = { version: 1 };
  if (policy !== undefined) config.enforcement = { structurePolicy: policy };
  fs.writeFileSync(
    path.join(dir, 'docs', 'subagent-workflow', 'workflow.config.json'),
    JSON.stringify(config, null, 2),
  );
  return dir;
}

function checkDeps() {
  return {
    providerName: 'spawn',
    getLlm: () => ({
      listProviders: () => [{ id: 'opencode', name: 'OpenCode' }],
      listModels: () => [{ id: 'deepseek-v4.1-flash' }, { id: 'glm-5.3-flash' }],
    }),
    getSubagents: () => ({
      getProvider: (name) => (name === 'spawn' ? { name, capabilities: { agentOptions: true, agentPreset: true } } : undefined),
    }),
    getPresets: () => ({
      resolve: async (id) => ({ id }),
      list: async () => [{ id: 'standard', description: 'Базовый состав' }],
      readDocument: async () => ({ content: "plugins:\n  - name: '@deepseek-ai/dsh-tools'\n" }),
    }),
  };
}

const DRAFT = {
  version: 1,
  models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
  nodes: [
    { id: 'a', role: 'lead', model: 'work' },
    { id: 'b', role: 'dev', model: 'work' },
  ],
  edges: [{ from: 'a', to: 'b', kind: 'delegate' }],
};

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
    socket: { remoteAddress: options.remote || '127.0.0.1' },
    on(event, fn) {
      if (event === 'data' && options.body !== undefined) fn(Buffer.from(String(options.body)));
      if (event === 'end') fn();
    },
  };
  return Promise.resolve(handler(req, res)).then(() => res);
}

/*
 * Лента порталов: структура объявляет папки обмена, а панель должна получить по
 * записи на каждую. Ящик здесь локальный (box.root: workspace), потому что предмет
 * этих тестов — не разрешение общего пути, а состояние, контракт и счётчики.
 */
function portalProject(folders) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-portal-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'coordinator', role: 'координатор', model: 'work' }],
    edges: [],
    folders,
  }, null, 2));
  return root;
}

/** One message header: the feed counts headers only and never reads bodies. */
const portalHead = (from, to, date) => 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date
  + '\nThread: critic-report\nStatus: request\n';

/** A folder declaration with a workspace-local box, two participants and a contract. */
function portalFolder(id, boxPath, extra = {}) {
  return {
    id,
    box: { path: boxPath, root: 'workspace' },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    ...extra,
  };
}

async function readFeed(root) {
  const handler = createWebHandler(makeRuntime([root], { me: 'structure' }));
  return call(handler, API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
}

const project = makeProject({ 'graph.json': GRAPH });
const emptyProject = makeProject(null);

await test('лента порталов: папка с контрактом — портал, ящик и счётчики', async () => {
  const root = portalProject([
    portalFolder('folder-1', 'coordination', { exchange: { threads: ['critic-report'] } }),
  ]);
  const box = path.join(root, 'coordination');
  const threads = path.join(box, 'threads');
  fs.mkdirSync(threads, { recursive: true });
  /* Имя не задано в exchange.contract — действует умолчание contract.md. */
  fs.writeFileSync(path.join(box, 'contract.md'), 'Format: dsh-exchange/1-contract\nRev: 1\n');
  fs.writeFileSync(path.join(threads, 'out.md'), portalHead('structure', 'workflow', '2026-11-02T10:00+03:00'));
  fs.writeFileSync(path.join(threads, 'in.md'), portalHead('workflow', 'structure', '2026-11-02T11:00+03:00'));

  const res = await readFeed(root);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.folders.length, 1, 'по записи на каждую папку структуры');
  const [folder] = res.body.folders;
  assert.equal(folder.id, 'folder-1');
  assert.equal(folder.contract, true, 'контракт найден в ящике');
  assert.equal(folder.state, 'portal', 'с контрактом и двумя участниками — портал');
  assert.equal(folder.box, path.resolve(box));
  assert.equal(folder.outgoing, 1);
  assert.equal(folder.incoming, 1);
  assert.deepEqual(folder.participants, ['structure', 'workflow']);
});

await test('лента порталов: папка с контрактом — portal, без контракта — draft', async () => {
  const root = portalProject([
    portalFolder('with-contract', 'box-contract'),
    portalFolder('without-contract', 'box-draft'),
  ]);
  /* У первой папки exchange вообще не задан: контракт всё равно contract.md. */
  fs.mkdirSync(path.join(root, 'box-contract'), { recursive: true });
  fs.writeFileSync(path.join(root, 'box-contract', 'contract.md'), 'Format: dsh-exchange/1-contract\nRev: 1\n');
  fs.mkdirSync(path.join(root, 'box-draft'), { recursive: true });

  const res = await readFeed(root);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byId = new Map(res.body.folders.map((folder) => [folder.id, folder]));
  assert.equal(byId.get('with-contract').contract, true);
  assert.equal(byId.get('with-contract').state, 'portal');
  assert.equal(byId.get('without-contract').contract, false);
  assert.equal(byId.get('without-contract').state, 'draft', 'приглашение без контракта порталом не является');
});

await test('лента порталов: две папки, недоступный ящик не роняет ответ', async () => {
  const root = portalProject([
    portalFolder('healthy', 'coordination', { exchange: { contract: 'portal-contract.md' } }),
    portalFolder('broken', 'absent-box'),
  ]);
  const box = path.join(root, 'coordination');
  fs.mkdirSync(path.join(box, 'threads'), { recursive: true });
  /* Имя контракта берётся из exchange.contract, а не только по умолчанию. */
  fs.writeFileSync(path.join(box, 'portal-contract.md'), 'Format: dsh-exchange/1-contract\nRev: 2\n');
  fs.writeFileSync(path.join(box, 'threads', 'letter.md'), portalHead('structure', 'workflow', '2026-11-02T12:00+03:00'));

  const res = await readFeed(root);
  assert.equal(res.status, 200, 'одна сломанная папка не скрывает здоровую');
  assert.equal(res.body.folders.length, 2);
  const byId = new Map(res.body.folders.map((folder) => [folder.id, folder]));
  assert.equal(byId.get('healthy').state, 'portal');
  assert.equal(byId.get('healthy').contract, true);
  assert.equal(byId.get('broken').state, 'draft');
  assert.equal(byId.get('broken').contract, false);
  assert.match(byId.get('broken').error, /недоступна/u);
});

await test('лента порталов: структура без папок отдаёт пустой folders', async () => {
  const root = portalProject([]);
  const res = await readFeed(root);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.folders, [], 'без объявленных папок лента пуста, а не выдумана');
});

await test('status отдаёт корни, папку структуры и версию', async () => {
  const handler = createWebHandler(makeRuntime([project, emptyProject]));
  const res = await call(handler, API_PREFIX + '/api/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.plugin.name, 'dsh-project-graph');
  assert.equal(res.body.structureDir, 'structure');
  assert.equal(res.body.roots.length, 2);
  assert.equal(res.body.defaultRoot, path.resolve(project));
  assert.deepEqual(res.body.edgeKinds, ['delegate', 'review', 'peer', 'report']);
});

await test('projects перечисляет оба проекта с их счётчиками', async () => {
  const handler = createWebHandler(makeRuntime([project, emptyProject]));
  const res = await call(handler, API_PREFIX + '/api/projects');
  assert.equal(res.status, 200);
  const [first, second] = res.body.projects;
  /* 0175: три объявленных узла + координатор, добавленный чтением. */
  assert.equal(first.nodes, 4);
  assert.equal(first.edges, 3);
  assert.equal(first.errors, 0);
  assert.equal(first.exists, true);
  assert.equal(second.exists, true);
  assert.equal(second.hasStructure, false);
  /*
   * 0176: пустой проект — это новый проект, а не поломка: неявный координатор,
   * ни одной ошибки и одно предупреждение empty-graph.
   */
  assert.equal(second.nodes, 1, 'координатор есть неявно');
  assert.equal(second.errors, 0, 'пустота — не ошибка');
  assert.equal(second.warnings, 1);
});

await test('graph отдаёт узлы, раскладку и сводку', async () => {
  const handler = createWebHandler(makeRuntime([project]));
  const res = await call(handler, API_PREFIX + '/api/graph');
  assert.equal(res.status, 200);
  /* 0175: координатор есть всегда — карточка видна, сводка и раскладка считают её. */
  assert.equal(res.body.summary.nodes, 4);
  assert.deepEqual(res.body.summary.byKind, { delegate: 0, review: 2, peer: 1, report: 0 });
  assert.equal(res.body.layout.nodes.length, 4);
  assert.equal(res.body.sources.length, 1);
  assert.equal(res.body.sources[0].file, 'structure/graph.json');
  assert.ok(res.body.layout.width > 0);
});

await test('graph отдаёт prompt каждого узла', async () => {
  const withPrompts = makeProject({
    'graph.json': {
      version: 1,
      models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [
        { id: 'coordinator', role: 'координатор', model: 'work', prompt: 'Роль: координатор. Definition of Done: план записан и роздан.' },
        { id: 'worker', role: 'исполнитель', model: 'work', prompt: 'Роль: исполнитель. Definition of Done: результат собран и проверен.' },
      ],
      edges: [{ from: 'coordinator', to: 'worker', kind: 'delegate' }],
    },
  });
  const handler = createWebHandler(makeRuntime([withPrompts]));
  const res = await call(handler, API_PREFIX + '/api/graph?root=' + encodeURIComponent(withPrompts));
  assert.equal(res.status, 200);
  const byId = new Map(res.body.graph.nodes.map((node) => [node.id, node]));
  assert.match(byId.get('coordinator').prompt, /Definition of Done/);
  assert.match(byId.get('worker').prompt, /исполнитель/);
  assert.equal(res.body.warnings.filter((item) => item.code === 'no-prompt').length, 0,
    'у узлов с prompt предупреждения нет');
});

await test('graph предупреждает об узле без prompt и отдаёт рецепт с id узла', async () => {
  const silent = makeProject({
    'graph.json': {
      version: 1,
      models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [{ id: 'silent', role: 'исполнитель', model: 'work' }],
    },
  });
  const handler = createWebHandler(makeRuntime([silent]));
  const res = await call(handler, API_PREFIX + '/api/graph?root=' + encodeURIComponent(silent));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.errors, [], 'без prompt структура остаётся действительной');
  const warning = res.body.warnings.find((item) => item.code === 'no-prompt');
  assert.ok(warning, 'предупреждение no-prompt есть');
  assert.equal(warning.node, 'silent');
  assert.match(warning.message, /silent/);
  assert.match(warning.fix, /prompt/, 'API отдаёт рецепт, а не только код');
});

await test('graph отдаёт расписание узла и вычисленный nextRun', async () => {
  const scheduled = makeProject({
    'graph.json': {
      version: 1,
      models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [
        { id: 'coordinator', role: 'координатор', model: 'work' },
        {
          id: 'critic',
          role: 'критик',
          model: 'work',
          schedule: { at: '09:00', timeZone: 'Europe/Moscow' },
        },
      ],
      edges: [{ from: 'critic', to: 'coordinator', kind: 'report' }],
    },
  });
  const runtime = makeRuntime([scheduled]);
  const payload = readGraph(runtime, scheduled);
  assert.deepEqual(payload.errors, []);
  assert.equal(payload.schedule.critic.at, '09:00');
  assert.equal(payload.schedule.critic.timeZone, 'Europe/Moscow');
  assert.equal(payload.schedule.critic.daily, 'ежедневно 09:00');
  assert.ok(Date.parse(payload.schedule.critic.nextRun) > Date.now(), 'nextRun — будущее время');
  assert.equal(payload.schedule.coordinator, undefined, 'узел без schedule в карту не попадает');

  const handler = createWebHandler(runtime);
  const res = await call(handler, API_PREFIX + '/api/graph');
  assert.equal(res.status, 200);
  assert.equal(res.body.schedule.critic.at, '09:00');
  assert.ok(res.body.schedule.critic.nextRun);
});

await test('graph по указанному корню и отказ для чужого пути', async () => {
  const handler = createWebHandler(makeRuntime([project]));
  const ok = await call(handler, API_PREFIX + '/api/graph?root=' + encodeURIComponent(project));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.root, path.resolve(project));
  const denied = await call(handler, API_PREFIX + '/api/graph?root=' + encodeURIComponent(path.resolve(project, '..')));
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /вне разрешённого списка/);
});

await test('проект без папки structure — новый проект с координатором, а не ошибка (0176)', async () => {
  const handler = createWebHandler(makeRuntime([emptyProject]));
  const res = await call(handler, API_PREFIX + '/api/graph');
  assert.equal(res.status, 200);
  assert.equal(res.body.exists, false, 'папки действительно нет');
  assert.equal(res.body.structureKind, 'new', 'единый предикат: новый проект');
  assert.deepEqual(res.body.errors, [], 'пустота — не ошибка: ' + JSON.stringify(res.body.errors));
  const warning = res.body.warnings.find((item) => item.code === 'empty-graph');
  assert.ok(warning, 'warning нового проекта: ' + JSON.stringify(res.body.warnings.map((item) => item.code)));
  assert.match(warning.message, /координатор/u, 'предупреждение говорит, что координатор уже есть');
  assert.deepEqual(res.body.graph.nodes.map((node) => node.id), ['coordinator'], 'координатор есть неявно');
  assert.equal(res.body.graph.nodes[0].implicit, true);
  assert.equal(res.body.summary.nodes, 1, 'сводка считает координатора');
});

await test('POST /api/init создаёт стартовую структуру одним нажатием', async () => {
  await withStore(async (store) => {
    const fresh = makeProject(null);
    const handler = createWebHandler(makeRuntime([fresh]));
    const res = await call(handler, API_PREFIX + '/api/init', { method: 'POST' });
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.ok(String(res.body.created).startsWith(store), 'created указывает в хранилище: ' + res.body.created);
    assert.equal(fs.existsSync(path.join(fresh, 'structure')), false, 'structure/ в репозитории не создана');
    assert.equal(res.body.exists, true);
    assert.equal(res.body.errors.length, 0);
    assert.equal(res.body.summary.nodes, 3);
    const parsed = JSON.parse(fs.readFileSync(res.body.created, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.nodes.length, 3);
    assert.ok(parsed.edges.some((edge) => edge.kind === 'delegate'));
    assert.ok(parsed.edges.some((edge) => edge.kind === 'review'));
  });
});

await test('POST /api/init?template=peer создаёт одноранговую структуру', async () => {
  await withStore(async (store) => {
    const fresh = makeProject(null);
    const handler = createWebHandler(makeRuntime([fresh]));
    const res = await call(handler, API_PREFIX + '/api/init?template=peer', { method: 'POST' });
    assert.equal(res.status, 201);
    assert.equal(res.body.template, 'peer');
    assert.equal(res.body.errors.length, 0);
    /* Три равных участника шаблона + координатор, добавленный чтением (0175). */
    assert.equal(res.body.summary.nodes, 4);
    assert.equal(res.body.summary.byKind.peer, 3);
    assert.equal(res.body.warnings.length, 0);
    assert.ok(String(res.body.created).startsWith(store), 'created указывает в хранилище');
    assert.equal(fs.existsSync(path.join(fresh, 'structure')), false, 'structure/ в репозитории не создана');
    const parsed = JSON.parse(fs.readFileSync(res.body.created, 'utf8'));
    assert.equal(parsed.edges.length, 3);
    assert.ok(parsed.edges.every((edge) => edge.kind === 'peer'));
    assert.ok(parsed.nodes.every((node) => !node.mustDifferFrom));
  });
});

await test('POST /api/init?template=mixed совмещает иерархию и равных', async () => {
  await withStore(async (store) => {
    const fresh = makeProject(null);
    const handler = createWebHandler(makeRuntime([fresh]));
    const res = await call(handler, API_PREFIX + '/api/init?template=mixed', { method: 'POST' });
    assert.equal(res.status, 201);
    assert.equal(res.body.template, 'mixed');
    assert.equal(res.body.errors.length, 0);
    assert.equal(res.body.warnings.length, 0);
    assert.equal(res.body.summary.nodes, 4);
    assert.deepEqual(res.body.summary.byKind, { delegate: 2, review: 2, peer: 1, report: 0 });
    assert.ok(String(res.body.created).startsWith(store), 'created указывает в хранилище');
    assert.equal(fs.existsSync(path.join(fresh, 'structure')), false, 'structure/ в репозитории не создана');
    const parsed = JSON.parse(fs.readFileSync(res.body.created, 'utf8'));
    assert.equal(parsed.edges.length, 5);
    assert.ok(parsed.edges.some((edge) => edge.kind === 'peer'));
    assert.ok(parsed.edges.some((edge) => edge.kind === 'delegate'));
  });
});

await test('POST /api/init?template=team создаёт иерархию без оценщика', async () => {
  await withStore(async (store) => {
    const fresh = makeProject(null);
    const handler = createWebHandler(makeRuntime([fresh]));
    const res = await call(handler, API_PREFIX + '/api/init?template=team', { method: 'POST' });
    assert.equal(res.status, 201);
    assert.equal(res.body.template, 'team');
    assert.equal(res.body.errors.length, 0);
    assert.equal(res.body.warnings.length, 0);
    assert.equal(res.body.summary.nodes, 5);
    assert.deepEqual(res.body.summary.byKind, { delegate: 4, review: 0, peer: 0, report: 0 });
    assert.equal(res.body.summary.layers, 3);
    assert.ok(String(res.body.created).startsWith(store), 'created указывает в хранилище');
    assert.equal(fs.existsSync(path.join(fresh, 'structure')), false, 'structure/ в репозитории не создана');
    const parsed = JSON.parse(fs.readFileSync(res.body.created, 'utf8'));
    assert.ok(parsed.edges.every((edge) => edge.kind === 'delegate'));
  });
});

await test('блочный пример из examples/blocks собирается без ошибок', () => {
  const root = path.resolve('examples/blocks');
  const payload = readGraph(makeRuntime([root]), root);
  assert.deepEqual(payload.errors, []);
  /*
   * Узлы примера prompt не несут — это законно: валидатор предупреждает и даёт
   * рецепт каждому узлу, но других предупреждений у собранного примера нет.
   */
  assert.equal(payload.warnings.filter((item) => item.code === 'no-prompt').length, payload.summary.nodes);
  assert.deepEqual(payload.warnings.filter((item) => item.code !== 'no-prompt'), []);
  assert.equal(payload.summary.nodes, 5);
  assert.equal(payload.summary.edges, 5);
  assert.deepEqual(payload.summary.byKind, { delegate: 4, review: 0, peer: 1, report: 0 });
});

await test('POST /api/link добавляет и удаляет связь в том же файле', async () => {
  const fresh = makeProject({
    'graph.json': {
      version: 1,
      models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [{ id: 'a', role: 'lead', model: 'ds' }, { id: 'b', role: 'dev', model: 'ds' }],
      edges: [],
    },
  });
  const handler = createWebHandler(makeRuntime([fresh]));
  const add = await call(handler, API_PREFIX + '/api/link?root=' + encodeURIComponent(fresh) + '&action=add&from=a&to=b&kind=peer', { method: 'POST' });
  assert.equal(add.status, 200);
  assert.equal(add.body.file, 'structure/graph.json');
  let payload = readGraph(makeRuntime([fresh]), fresh);
  assert.equal(payload.summary.byKind.peer, 1);
  const remove = await call(handler, API_PREFIX + '/api/link?root=' + encodeURIComponent(fresh) + '&action=remove&from=a&to=b&kind=peer', { method: 'POST' });
  assert.equal(remove.status, 200);
  payload = readGraph(makeRuntime([fresh]), fresh);
  assert.equal(payload.summary.edges, 0);
});

await test('POST /api/link между блоками пишет structure/links.json', async () => {
  const fresh = makeProject({
    'models.json': { version: 1, models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } } },
    'teams/a.json': { version: 1, nodes: [{ id: 'a.lead', role: 'lead', model: 'ds' }] },
    'teams/b.json': { version: 1, nodes: [{ id: 'b.lead', role: 'lead', model: 'ds' }] },
  });
  const handler = createWebHandler(makeRuntime([fresh]));
  const url = API_PREFIX + '/api/link?root=' + encodeURIComponent(fresh) + '&action=add&from=a.lead&to=b.lead&kind=peer';
  const res = await call(handler, url, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.body.file, 'structure/links.json');
  const links = JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'links.json'), 'utf8'));
  assert.equal(links.edges.length, 1);
  const again = await call(handler, url, { method: 'POST' });
  assert.equal(again.status, 409);
  const remove = await call(handler, API_PREFIX + '/api/link?root=' + encodeURIComponent(fresh) + '&action=remove&from=a.lead&to=b.lead&kind=peer', { method: 'POST' });
  assert.equal(remove.status, 200);
  const after = JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'links.json'), 'utf8'));
  assert.equal(after.edges.length, 0);
});

await test('POST /api/link откатывает delegate-цикл и не ломает файл', async () => {
  const fresh = makeProject({
    'graph.json': {
      version: 1,
      models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [{ id: 'a', role: 'lead', model: 'ds' }, { id: 'b', role: 'dev', model: 'ds' }],
      edges: [{ from: 'a', to: 'b', kind: 'delegate' }],
    },
  });
  const before = fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8');
  const handler = createWebHandler(makeRuntime([fresh]));
  const res = await call(handler, API_PREFIX + '/api/link?root=' + encodeURIComponent(fresh) + '&action=add&from=b&to=a&kind=delegate', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /цикл/);
  assert.equal(fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8'), before);
});

await test('POST /api/link: неизвестный узел, вид связи и чужой корень', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh]));
  const unknown = await call(handler, API_PREFIX + '/api/link?root=' + encodeURIComponent(fresh) + '&action=add&from=ghost&to=critic&kind=peer', { method: 'POST' });
  assert.equal(unknown.status, 404);
  const kind = await call(handler, API_PREFIX + '/api/link?root=' + encodeURIComponent(fresh) + '&action=add&from=analyst-a&to=critic&kind=veto', { method: 'POST' });
  assert.equal(kind.status, 400);
  const foreign = await call(handler, API_PREFIX + '/api/link?root=' + encodeURIComponent(os.tmpdir()) + '&action=add&from=a&to=b&kind=peer', { method: 'POST' });
  assert.equal(foreign.status, 400);
});

await test('GET /api/models не падает на неактивной службе llm', async () => {
  const handler = createWebHandler(makeRuntime([], {}, {
    getLlm: () => { throw new Error('cannot get required service "llm" in inactive context'); },
  }));
  const res = await call(handler, API_PREFIX + '/api/models');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.providers.length, 0);
  assert.match(res.body.error, /недоступен/);
});

await test('GET /api/activity отдаёт последние запуски проекта', async () => {
  const runtime = makeRuntime([project]);
  noteRun(runtime, { root: project, node: 'critic', state: 'done', since: Date.now() - 1000, finishedAt: Date.now() });
  const handler = createWebHandler(runtime);
  const res = await call(handler, API_PREFIX + '/api/activity?root=' + encodeURIComponent(project));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.runs[0].node, 'critic');
  assert.equal(res.body.runs[0].state, 'done');
});

await test('GET /api/presets отдаёт пресеты и переживает неактивную службу', async () => {
  const handler = createWebHandler(makeRuntime([], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/presets');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.presets[0].id, 'standard');
  assert.equal(res.body.presets[0].description, 'Базовый состав');
  assert.ok(res.body.presets[0].plugins.includes('@deepseek-ai/dsh-tools'));

  const broken = createWebHandler(makeRuntime([], {}, {
    getPresets: () => { throw new Error('cannot get required service "agentPresets" in inactive context'); },
  }));
  const failed = await call(broken, API_PREFIX + '/api/presets');
  assert.equal(failed.status, 200);
  assert.equal(failed.body.ok, false);
  assert.deepEqual(failed.body.presets, []);
  assert.match(failed.body.error, /недоступен/);
});

await test('GET /api/models отдаёт провайдеров и доступные модели', async () => {
  const handler = createWebHandler(makeRuntime([], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/models');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.providers.length, 1);
  assert.equal(res.body.providers[0].id, 'opencode');
  assert.ok(res.body.providers[0].models.some((model) => model.id === 'deepseek-v4.1-flash'));
});

await test('POST /api/check проверяет граф, модели и провайдера', async () => {
  const fresh = makeProject(null);
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/check?root=' + encodeURIComponent(fresh), { method: 'POST', body: JSON.stringify(DRAFT) });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.errors, []);
  /* 0175: два узла черновика + координатор, добавленный чтением. */
  assert.equal(res.body.summary.nodes, 3);
  assert.equal(res.body.summary.byKind.delegate, 1);

  const bad = { ...DRAFT, models: { work: { provider: 'opencode', model: 'missing-model' } } };
  const failed = await call(handler, API_PREFIX + '/api/check?root=' + encodeURIComponent(fresh), { method: 'POST', body: JSON.stringify(bad) });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.ok, false);
  assert.ok(failed.body.errors.some((item) => item.code === 'model-missing'));
});

await test('POST /api/build создаёт граф и не перезаписывает без флага', async () => {
  await withStore(async () => {
    const fresh = makeProject(null);
    const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
    const first = await call(handler, API_PREFIX + '/api/build?root=' + encodeURIComponent(fresh), { method: 'POST', body: JSON.stringify(DRAFT) });
    assert.equal(first.status, 200);
    assert.equal(first.body.file, 'structure/graph.json', 'логическое имя фрагмента не зависит от места');
    assert.equal(resolveStructure(fresh).mode, 'store', 'чистый проект пишет в хранилище');
    assert.ok(fs.existsSync(resolveStructure(fresh).graphFile), 'граф лёг в хранилище');
    assert.equal(fs.existsSync(path.join(fresh, 'structure')), false, 'structure/ в репозитории не создана');
    const payload = readGraph(makeRuntime([fresh]), fresh);
    /* 0175: два узла постройки + неявный координатор. */
    assert.equal(payload.summary.nodes, 3);
    assert.equal(payload.summary.edges, 1);

    const again = await call(handler, API_PREFIX + '/api/build?root=' + encodeURIComponent(fresh), { method: 'POST', body: JSON.stringify(DRAFT) });
    assert.equal(again.status, 409);
    const overwrite = await call(handler, API_PREFIX + '/api/build?root=' + encodeURIComponent(fresh) + '&overwrite=true', { method: 'POST', body: JSON.stringify(DRAFT) });
    assert.equal(overwrite.status, 200);
  });
});

await test('POST /api/build не создаёт невалидный или частичный граф', async () => {
  await withStore(async () => {
    const fresh = makeProject(null);
    const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
    const bad = await call(handler, API_PREFIX + '/api/build?root=' + encodeURIComponent(fresh), {
      method: 'POST',
      body: JSON.stringify({ ...DRAFT, edges: [{ from: 'a', to: 'ghost', kind: 'delegate' }] }),
    });
    assert.equal(bad.status, 409);
    assert.equal(fs.existsSync(path.join(fresh, 'structure', 'graph.json')), false);
    assert.equal(fs.existsSync(resolveStructure(fresh).graphFile), false, 'в хранилище тоже ничего не создано');
  });

  /* Фрагменты в репозитории — легаси-режим: сборщик обязан отказать, а не писать рядом. */
  const fragments = makeProject({
    'models.json': { version: 1, models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } } },
    'teams/a.json': { version: 1, nodes: [{ id: 'a', role: 'lead', model: 'work' }] },
  });
  const split = createWebHandler(makeRuntime([fragments], {}, checkDeps()));
  const refused = await call(split, API_PREFIX + '/api/build?root=' + encodeURIComponent(fragments) + '&overwrite=true', { method: 'POST', body: JSON.stringify(DRAFT) });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /фрагмент/);
});

/* 0061 C1: сборка разворачивает алиас в прямые поля и не пишет models{}. */
await test('POST /api/build: алиас черновика развёрнут, models{} в файле нет', async () => {
  await withStore(async () => {
    const fresh = makeProject(null);
    const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
    const res = await call(handler, API_PREFIX + '/api/build?root=' + encodeURIComponent(fresh), {
      method: 'POST', body: JSON.stringify(DRAFT),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.models, 2, 'summary.models считает узлы с моделью');
    const raw = JSON.parse(fs.readFileSync(resolveStructure(fresh).graphFile, 'utf8'));
    assert.equal(raw.models, undefined, 'models{} в файл не пишется');
    assert.ok(raw.nodes.every((node) => node.provider === 'opencode' && node.model === 'deepseek-v4.1-flash'),
      'у узлов прямые provider/model: ' + JSON.stringify(raw.nodes));
    assert.ok(raw.nodes.every((node) => !node.modelAlias), 'modelAlias в файл не пишется');
  });
});

/* 0061 C2: прямые поля узла принимаются как есть, без models{}. */
await test('POST /api/build: прямые provider/model узла принимаются', async () => {
  await withStore(async () => {
    const fresh = makeProject(null);
    const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
    const draft = {
      nodes: [{ id: 'judge', role: 'acceptor', provider: 'opencode', model: 'glm-5.3-flash', family: 'zhipu' }],
      edges: [],
    };
    const res = await call(handler, API_PREFIX + '/api/build?root=' + encodeURIComponent(fresh), {
      method: 'POST', body: JSON.stringify(draft),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.models, 1);
    const raw = JSON.parse(fs.readFileSync(resolveStructure(fresh).graphFile, 'utf8'));
    assert.equal(raw.models, undefined, 'models{} в файл не пишется');
    assert.deepEqual(raw.nodes[0],
      { id: 'judge', role: 'acceptor', provider: 'opencode', model: 'glm-5.3-flash', family: 'zhipu' },
      'узел записан прямыми полями');
  });

  /* model без provider по-прежнему ошибка: прямые поля не догадываются. */
  await withStore(async () => {
    const bare = makeProject(null);
    const bareHandler = createWebHandler(makeRuntime([bare], {}, checkDeps()));
    const refused = await call(bareHandler, API_PREFIX + '/api/build?root=' + encodeURIComponent(bare), {
      method: 'POST', body: JSON.stringify({ nodes: [{ id: 'idea', role: 'dev', model: 'deepseek-v4.1-flash' }], edges: [] }),
    });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /provider/);
    assert.equal(fs.existsSync(path.join(bare, 'structure', 'graph.json')), false);
    assert.equal(fs.existsSync(resolveStructure(bare).graphFile), false, 'и в хранилище файла нет');
  });
});

/* 0061 C3: неизвестная модель отклоняется до записи — файла нет вовсе. */
await test('POST /api/build: неизвестная модель — 409, файл не создан', async () => {
  await withStore(async () => {
    const fresh = makeProject(null);
    const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
    const res = await call(handler, API_PREFIX + '/api/build?root=' + encodeURIComponent(fresh), {
      method: 'POST',
      body: JSON.stringify({ nodes: [{ id: 'critic', role: 'acceptor', provider: 'opencode', model: 'нет-такой' }], edges: [] }),
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /нет-такой/, 'отказ называет модель');
    assert.ok(res.body.fix, 'отказ несёт рецепт');
    assert.ok(res.body.details.errors.some((item) => item.code === 'model-missing'), 'код model-missing');
    assert.equal(fs.existsSync(path.join(fresh, 'structure', 'graph.json')), false, 'файл не создан');
    assert.equal(fs.existsSync(resolveStructure(fresh).graphFile), false, 'в хранилище файла тоже нет');
  });
});

await test('POST /api/node добавляет узел в существующий фрагмент', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ id: 'writer', role: 'author', model: 'ds', brief: 'пишет текст' }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.file, 'structure/graph.json');
  /* Старый алиас ds развёрнут при записи: ответ несёт прямую пару, как в файле. */
  assert.equal(res.body.node.provider, 'opencode');
  assert.equal(res.body.node.model, 'deepseek-v4.1-flash', 'ответ POST — прямая модель');
  const raw = JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8'));
  assert.equal(raw.models, undefined, 'models{} удалён при сохранении');
  /*
   * 0175: запись узла сохранила координатора в файл; маршрута у него нет, пока
   * его не задали (алиас work в этом графе не объявлен). Прямые provider/model
   * проверяются у объявленных рабочих узлов.
   */
  assert.ok(raw.nodes.filter((node) => node.id !== 'coordinator').every((node) => node.provider && node.model),
    'у всех рабочих узлов прямые provider/model');
  assert.ok(raw.nodes.every((node) => !node.modelAlias), 'modelAlias в файл не пишется');
  const payload = readGraph(makeRuntime([fresh]), fresh);
  /* 0175: три узла GRAPH + writer + координатор, сохранённый этой же записью. */
  assert.equal(payload.summary.nodes, 5);
  const added = payload.graph.nodes.find((node) => node.id === 'writer');
  assert.equal(added.role, 'author');
  assert.equal(added.provider, 'opencode');
  assert.equal(added.model, 'deepseek-v4.1-flash', 'в ленте — та же прямая модель');
  assert.equal(added.brief, 'пишет текст');
  assert.equal(payload.errors.length, 0);
});

await test('POST /api/node: узел без модели допустим, но объясняет последствие', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh]));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ id: 'idea' }),
  });
  assert.equal(res.status, 201);
  const payload = readGraph(makeRuntime([fresh]), fresh);
  const added = payload.graph.nodes.find((node) => node.id === 'idea');
  assert.equal(added.model, undefined);
});

await test('POST /api/node: дубль, плохой id и чужой алиас модели — с рецептом', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const url = API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh);
  const duplicate = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'critic' }) });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.fix, /другой id|отредактируйте/);

  const badId = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'Плохой id' }) });
  assert.equal(badId.status, 400);
  assert.match(badId.body.fix, /Латинские/);

  const unknownModel = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'worker-2', model: 'ghost' }) });
  assert.equal(unknownModel.status, 400);
  assert.equal(unknownModel.body.code, 'provider-missing', 'у модели без провайдера отказ называет провайдера');
  assert.match(unknownModel.body.error, /ghost/);
  assert.match(unknownModel.body.fix, /opencode/);

  const payload = readGraph(makeRuntime([fresh]), fresh);
  assert.equal(payload.summary.nodes, 4, 'отказы не должны оставлять узлов (3 объявленных + координатор)');
});

await test('POST /api/node: при нескольких фрагментах новый узел идёт в graph.json', async () => {
  const fragments = makeProject({
    'models.json': { version: 1, models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } } },
    'teams/one.json': { version: 1, nodes: [{ id: 'lead', role: 'lead', model: 'ds' }] },
  });
  const handler = createWebHandler(makeRuntime([fragments], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fragments), {
    method: 'POST',
    body: JSON.stringify({ id: 'dev', role: 'dev', model: 'ds' }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.file, 'structure/graph.json');
  assert.equal(res.body.node.provider, 'opencode');
  assert.equal(res.body.node.model, 'deepseek-v4.1-flash', 'алиас развёрнут в прямой маршрут');
  assert.equal(fs.existsSync(path.join(fragments, 'structure', 'graph.json')), true);
  const payload = readGraph(makeRuntime([fragments]), fragments);
  /* 0175: lead + dev + координатор, сохранённый записью узла. */
  assert.equal(payload.summary.nodes, 3);
  assert.equal(payload.errors.length, 0);
});

/* ------------------------------------------------------------------------- *
 * Задание 0175: координатор есть всегда — запись сохраняет его в файл
 * ------------------------------------------------------------------------- */

await test('запись узла сохраняет координатора в файл, если его не было (0175)', async () => {
  const fresh = makeProject({ 'graph.json': {
    version: 1,
    nodes: [{ id: 'worker-1', role: 'исполнитель' }],
    edges: [],
  } });
  const runtime = makeRuntime([fresh]);
  const before = readGraph(runtime, fresh);
  assert.equal(before.graph.nodes.find((node) => node.id === 'coordinator').implicit, true,
    'до записи координатор есть только в чтении');
  const handler = createWebHandler(runtime);
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ id: 'worker-2', role: 'исполнитель' }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const raw = JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8'));
  const coordinator = raw.nodes.find((node) => node.id === 'coordinator');
  assert.ok(coordinator, 'координатор записан в файл структурой');
  assert.equal(coordinator.role, 'координатор');
  assert.equal(coordinator.brief, 'ведёт план и раздаёт работу');
  assert.equal(coordinator.implicit, undefined, 'пометка чтения в файл не пишется');
  const after = readGraph(runtime, fresh);
  assert.equal(after.graph.nodes.filter((node) => node.id === 'coordinator').length, 1, 'двойника нет');
});

await test('updateNode сохраняет координатора, но не дублирует объявленного в другом фрагменте (0175)', async () => {
  const fresh = makeProject({ 'graph.json': {
    version: 1,
    nodes: [{ id: 'worker-1', role: 'исполнитель' }],
    edges: [],
  } });
  const runtime = makeRuntime([fresh]);
  const saved = updateNode(runtime, fresh, { id: 'worker-1', brief: 'правит код' });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  const raw = JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8'));
  assert.ok(raw.nodes.some((node) => node.id === 'coordinator'), 'координатор сохранён и при правке узла');

  const split = makeProject({
    'graph.json': { version: 1, nodes: [{ id: 'worker-1', role: 'исполнитель' }], edges: [] },
    'teams/code.json': { version: 1, nodes: [{ id: 'coordinator', role: 'координатор', provider: 'p', model: 'm' }], edges: [] },
  });
  const splitRuntime = makeRuntime([split]);
  const edited = updateNode(splitRuntime, split, { id: 'worker-1', brief: 'правит код' });
  assert.equal(edited.status, 200, JSON.stringify(edited));
  const splitRaw = JSON.parse(fs.readFileSync(path.join(split, 'structure', 'graph.json'), 'utf8'));
  assert.ok(!splitRaw.nodes.some((node) => node.id === 'coordinator'),
    'второй координатор в соседний фрагмент не пишется');
  const after = readGraph(splitRuntime, split);
  assert.deepEqual(after.errors, []);
  assert.equal(after.graph.nodes.filter((node) => node.id === 'coordinator').length, 1, 'координатор один');
});

await test('POST /api/node с type без id нумерует узлы с 1', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh]));
  const url = API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh);
  const first = await call(handler, url, { method: 'POST', body: JSON.stringify({ type: 'critic', role: 'критик' }) });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.node.id, 'critic-1');
  assert.deepEqual(first.body.node.schedule, { at: '09:00', timeZone: 'Europe/Moscow' },
    'критик сразу получает время запуска по умолчанию');

  const second = await call(handler, url, { method: 'POST', body: JSON.stringify({ type: 'critic', role: 'критик' }) });
  assert.equal(second.status, 201);
  assert.equal(second.body.node.id, 'critic-2', 'второй критик получает следующий номер');

  const worker = await call(handler, url, { method: 'POST', body: JSON.stringify({ type: 'worker', role: 'исполнитель' }) });
  assert.equal(worker.status, 201);
  assert.equal(worker.body.node.id, 'worker-1', 'у каждого типа своя нумерация');

  const payload = readGraph(makeRuntime([fresh]), fresh);
  assert.deepEqual(payload.graph.nodes.filter((node) => /^critic-/u.test(node.id)).map((node) => node.id).sort(),
    ['critic-1', 'critic-2']);
  assert.equal(payload.errors.length, 0);
});

await test('нумерация type берёт первый свободный номер, а не следующий за максимумом', async () => {
  const fresh = makeProject({
    'graph.json': {
      version: 1,
      models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [
        { id: 'coordinator', role: 'координатор', model: 'ds' },
        { id: 'critic-1', role: 'критик', model: 'ds', schedule: { at: '09:00', timeZone: 'Europe/Moscow' } },
        { id: 'critic-3', role: 'критик', model: 'ds', schedule: { at: '10:00', timeZone: 'Europe/Moscow' } },
      ],
      edges: [
        { from: 'critic-1', to: 'coordinator', kind: 'report' },
        { from: 'critic-3', to: 'coordinator', kind: 'report' },
      ],
    },
  });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ type: 'critic', role: 'критик', model: 'ds' }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.node.id, 'critic-2', 'занятый номер пропускается: critic-2 свободен');
});

await test('POST /api/node без id и без type объясняет оба пути', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh]));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ role: 'критик' }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /ни id, ни type/);
  assert.match(res.body.fix, /critic-1/, 'рецепт называет готовый id');
});

await test('POST /api/node с негодным type отказывает и подсказывает формат', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh]));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ type: 'критик', role: 'критик' }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.fix, /critic, worker, exchange/);
});

await test('узел папки обмена создаётся без модели, без связей и без предупреждений агента', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh]));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ type: 'exchange', role: 'обмен', brief: 'место, где лежат сообщения' }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.node.id, 'exchange-1');
  assert.equal(res.body.node.model, undefined, 'у папки обмена нет модели');
  const payload = readGraph(makeRuntime([fresh]), fresh);
  const connected = payload.graph.edges.filter((edge) => edge.from === 'exchange-1' || edge.to === 'exchange-1');
  assert.equal(connected.length, 0, 'папка обмена не соединяется с агентами');
  /* 0175: предупреждения координатора к папке обмена не относятся — адресуем по узлу. */
  assert.ok(!payload.warnings.some((warning) => warning.code === 'no-model' && warning.node === 'exchange-1'),
    'отсутствие модели у папки обмена — норма, а не предупреждение');
  assert.ok(!payload.warnings.some((warning) => warning.code === 'isolated-node' && warning.node === 'exchange-1'),
    'изоляция папки обмена — норма: её связь — сообщения');
});

await test('POST /api/node?action=update меняет роль, назначение и модель', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh) + '&action=update', {
    method: 'POST',
    body: JSON.stringify({ id: 'critic', role: 'reviewer', brief: 'проверяет отдельно' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.file, 'structure/graph.json');
  assert.equal(res.body.node.role, 'reviewer');
  /* Маршрут не менялся, но запись уже прямая: старый алиас glm развёрнут. */
  assert.equal(res.body.node.provider, 'opencode');
  assert.equal(res.body.node.model, 'glm-5.3-flash', 'модель не менялась, но записана прямо');
  const payload = readGraph(makeRuntime([fresh]), fresh);
  const critic = payload.graph.nodes.find((node) => node.id === 'critic');
  assert.equal(critic.role, 'reviewer');
  assert.equal(critic.brief, 'проверяет отдельно');
  assert.equal(critic.provider, 'opencode');
  assert.equal(critic.model, 'glm-5.3-flash');
  assert.equal(critic.modelAlias, undefined, 'алиас в файл не пишется');
  assert.equal(payload.errors.length, 0);

  /* Модель меняется прямой парой provider+model — алиасов в файле уже нет. */
  const rerouted = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh) + '&action=update', {
    method: 'POST',
    body: JSON.stringify({ id: 'analyst-b', provider: 'opencode', model: 'deepseek-v4.1-flash' }),
  });
  assert.equal(rerouted.status, 200);
  assert.equal(rerouted.body.node.provider, 'opencode');
  assert.equal(rerouted.body.node.model, 'deepseek-v4.1-flash', 'ответ — записанная пара');
  const after = readGraph(makeRuntime([fresh]), fresh);
  const reroutedNode = after.graph.nodes.find((node) => node.id === 'analyst-b');
  assert.equal(reroutedNode.provider, 'opencode');
  assert.equal(reroutedNode.model, 'deepseek-v4.1-flash', 'в ленте — та же прямая модель');
  assert.equal(reroutedNode.modelAlias, undefined);
});

await test('POST /api/node?action=update: пустое поле снимает значение', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh) + '&action=update', {
    method: 'POST',
    body: JSON.stringify({ id: 'analyst-a', role: '' }),
  });
  assert.equal(res.status, 200);
  const payload = readGraph(makeRuntime([fresh]), fresh);
  assert.equal(payload.graph.nodes.find((node) => node.id === 'analyst-a').role, undefined);
});

/* 0120 C1/C3: спека узла (prompt) сохраняется в файл; без неё поля нет. */
await test('POST /api/node сохраняет спеку узла (prompt)', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const url = API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh);
  const spec = 'Роль: автор.\nDefinition of Done: текст сдан заказчику.';
  const created = await call(handler, url, {
    method: 'POST',
    body: JSON.stringify({ id: 'writer', role: 'author', prompt: '  ' + spec + '  \n' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.node.prompt, spec, 'ответ несёт спеку как записана: trim по краям');
  const raw = JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8'));
  const writer = raw.nodes.find((node) => node.id === 'writer');
  assert.equal(writer.prompt, spec, 'спека записана в файл структуры');
  const reread = readGraph(makeRuntime([fresh]), fresh);
  assert.equal(reread.graph.nodes.find((node) => node.id === 'writer').prompt, spec, 'лента читает ту же спеку');
  for (const node of raw.nodes.filter((item) => item.id !== 'writer')) {
    const declared = GRAPH.nodes.find((item) => item.id === node.id);
    if (!declared) continue; /* 0175: координатор, сохранённый записью, объявлен не в GRAPH. */
    assert.equal(node.prompt, declared.prompt, 'чужие спеки не тронуты');
  }

  const plain = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'plain', role: 'исполнитель' }) });
  assert.equal(plain.status, 201);
  assert.ok(!Object.hasOwn(plain.body.node, 'prompt'), 'без prompt поля нет в ответе');

  const blank = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'blank', role: 'исполнитель', prompt: '   ' }) });
  assert.equal(blank.status, 201);
  const after = JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8'));
  for (const id of ['plain', 'blank']) {
    assert.ok(!Object.hasOwn(after.nodes.find((node) => node.id === id), 'prompt'), 'пустой prompt не пишется полем: ' + id);
  }
});

/* 0120 C2/C4: update меняет prompt; пустая строка и null убирают, без ключа — не трогают. */
await test('POST /api/node?action=update: prompt меняется, убирается строкой и null', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const url = API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh) + '&action=update';
  const nodeOf = (id) => JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8'))
    .nodes.find((node) => node.id === id);

  const changed = await call(handler, url, {
    method: 'POST',
    body: JSON.stringify({ id: 'analyst-b', prompt: '  Роль: аналитик.\nDefinition of Done: новая спека.  ' }),
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const spec = 'Роль: аналитик.\nDefinition of Done: новая спека.';
  assert.equal(changed.body.node.prompt, spec, 'ответ — сохранённая спека');
  assert.equal(nodeOf('analyst-b').prompt, spec, 'prompt обновлён в файле');
  assert.equal(nodeOf('analyst-b').role, 'analyst', 'прежние поля сохранены');
  for (const id of ['analyst-a', 'critic']) {
    assert.equal(nodeOf(id).prompt, GRAPH.nodes.find((node) => node.id === id).prompt, 'соседние спеки не тронуты: ' + id);
  }

  const cleared = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'analyst-b', prompt: '   ' }) });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.ok(!Object.hasOwn(nodeOf('analyst-b'), 'prompt'), 'пробельная строка удаляет поле');
  assert.equal(cleared.body.node.prompt, undefined, 'ответ не подставляет пустую спеку');

  const restored = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'analyst-b', prompt: 'снова есть' }) });
  assert.equal(restored.status, 200);
  assert.equal(nodeOf('analyst-b').prompt, 'снова есть');

  const wiped = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'analyst-b', prompt: null }) });
  assert.equal(wiped.status, 200, JSON.stringify(wiped.body));
  assert.ok(!Object.hasOwn(nodeOf('analyst-b'), 'prompt'), 'null удаляет поле');

  const kept = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'analyst-b', prompt: 'стойкая спека' }) });
  assert.equal(kept.status, 200);
  const roleOnly = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'analyst-b', role: 'analyst-2' }) });
  assert.equal(roleOnly.status, 200, JSON.stringify(roleOnly.body));
  assert.equal(nodeOf('analyst-b').prompt, 'стойкая спека', 'без ключа prompt поле не меняется');
  assert.equal(nodeOf('analyst-b').role, 'analyst-2');

  const garbage = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'analyst-b', role: 'analyst-3', prompt: 42 }) });
  assert.equal(garbage.status, 200, JSON.stringify(garbage.body));
  assert.equal(nodeOf('analyst-b').prompt, 'стойкая спека', 'не текст не стирает и не подменяет спеку');
});

await test('POST /api/node?action=update отказывает: нет узла, смена id, чужой алиас', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const url = API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh) + '&action=update';
  const missing = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'ghost', role: 'x' }) });
  assert.equal(missing.status, 404);
  assert.match(missing.body.fix, /Обновите панель/);

  const rename = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'critic', newId: 'critic-2' }) });
  assert.equal(rename.status, 400);
  assert.match(rename.body.error, /нечего менять|id/);

  const alias = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'critic', model: 'ghost' }) });
  assert.equal(alias.status, 400);
  assert.equal(alias.body.code, 'model-missing', 'неизвестная модель у известного провайдера — model-missing');
  assert.match(alias.body.error, /ghost/);
  assert.match(alias.body.fix, /deepseek-v4.1-flash/);

  const empty = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'critic' }) });
  assert.equal(empty.status, 400);
  assert.match(empty.body.fix, /role, brief, model, agentPreset/);
});

/* 0050 C1: сохранение пишет прямые поля у всех узлов и убирает models{}. */
await test('запись узла разворачивает все алиасы и убирает models{}', async () => {
  const fresh = makeProject({ 'graph.json': {
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash', family: 'deepseek' } },
    nodes: [{ id: 'worker', role: 'исполнитель', model: 'work' }],
    edges: [],
  } });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ id: 'judge', role: 'приёмщик', provider: 'opencode', model: 'glm-5.3-flash' }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.file, 'structure/graph.json');
  assert.equal(res.body.node.provider, 'opencode', 'ответ — узел как записан');
  assert.equal(res.body.node.model, 'glm-5.3-flash');

  const raw = JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8'));
  assert.equal(raw.models, undefined, 'models{} удалён из файла');
  const worker = raw.nodes.find((node) => node.id === 'worker');
  assert.equal(worker.provider, 'opencode', 'старый алиас развёрнут в provider');
  assert.equal(worker.model, 'deepseek-v4.1-flash', 'старый алиас развёрнут в model');
  assert.equal(worker.family, 'deepseek', 'семейство алиаса сохранено');
  for (const node of raw.nodes) {
    assert.ok(node.provider && node.model, 'у узла «' + node.id + '» прямые provider/model');
    assert.equal(node.modelAlias, undefined, 'modelAlias в файл не пишется');
  }
});

/* 0050 C2: провайдер проверяется по живому каталогу до записи. */
await test('запись узла: неизвестный провайдер — 400 provider-missing с каталогом', async () => {
  const fresh = makeProject({ 'graph.json': {
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'worker', role: 'исполнитель', model: 'work' }],
    edges: [],
  } });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ id: 'critic', role: 'критик', provider: 'opencodex', model: 'glm-5.3-flash' }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'provider-missing');
  assert.ok(res.body.ok === false, 'отказ помечен ok: false');
  assert.match(res.body.error, /opencodex/u, 'отказ называет выбранного провайдера');
  assert.match(res.body.fix, /opencode/u, 'отказ перечисляет каталог');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8')).nodes.length, 1,
    'отказ до записи не оставляет узла');
});

/* 0050 C3: известный провайдер, неизвестная модель — 400 model-missing. */
await test('запись узла: неизвестная модель — 400 model-missing с именем', async () => {
  const fresh = makeProject({ 'graph.json': {
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'worker', role: 'исполнитель', model: 'work' }],
    edges: [],
  } });
  const handler = createWebHandler(makeRuntime([fresh], {}, checkDeps()));
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ id: 'critic', role: 'критик', provider: 'opencode', model: 'нет-такой' }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'model-missing');
  assert.match(res.body.error, /нет-такой/u, 'отказ называет модель');
  assert.match(res.body.error, /opencode/u, 'отказ называет провайдера');
  assert.match(res.body.fix, /deepseek-v4\.1-flash/u, 'отказ перечисляет доступные модели');
});

/* 0050 D2: без живого каталога не «сохраним как есть», а отказ. */
await test('запись узла: каталог недоступен — 400 catalog-unavailable, файл не тронут', async () => {
  const fresh = makeProject({ 'graph.json': {
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'worker', role: 'исполнитель', model: 'work' }],
    edges: [],
  } });
  const handler = createWebHandler(makeRuntime([fresh]));
  const before = fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8');
  const res = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh), {
    method: 'POST',
    body: JSON.stringify({ id: 'critic', role: 'критик', provider: 'opencode', model: 'deepseek-v4.1-flash' }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'catalog-unavailable');
  assert.match(res.body.error, /каталог моделей недоступен/u);
  assert.equal(fs.readFileSync(path.join(fresh, 'structure', 'graph.json'), 'utf8'), before,
    'отказ не мигрирует и не пишет файл');
});

/* 0050 C2: узел удаляется вместе со связями, координатор защищён. */
await test('POST /api/node?action=remove удаляет узел и все связи, где он участник', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh]));
  const url = API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh) + '&action=remove';
  const res = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'critic' }) });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.removed, 'critic');
  assert.equal(res.body.file, 'structure/graph.json');

  const payload = readGraph(makeRuntime([fresh]), fresh);
  assert.equal(payload.errors.length, 0, 'структура осталась действительной');
  assert.ok(!payload.graph.nodes.some((node) => node.id === 'critic'), 'узла «критик» больше нет');
  assert.ok(!payload.graph.edges.some((edge) => edge.from === 'critic' || edge.to === 'critic'),
    'связи с удалённым узлом убраны');
  assert.ok(payload.graph.edges.some((edge) => edge.from === 'analyst-a' && edge.to === 'analyst-b'),
    'связи между оставшимися узлами целы');

  /* Идемпотентности нет: повторное удаление объясняет, что узла уже нет. */
  const again = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'critic' }) });
  assert.equal(again.status, 404);
  assert.match(again.body.fix, /Обновите панель/);
});

await test('POST /api/node?action=remove: без id — 400 с рецептом, неизвестный — 404', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const handler = createWebHandler(makeRuntime([fresh]));
  const url = API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh) + '&action=remove';
  const noId = await call(handler, url, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(noId.status, 400);
  assert.match(noId.body.fix, /id узла/);
  const ghost = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'ghost' }) });
  assert.equal(ghost.status, 404);
  assert.match(ghost.body.fix, /Обновите панель/);
});

await test('POST /api/node?action=remove: координатор защищён по id и по роли', async () => {
  const fresh = makeProject({
    'nodes.json': {
      version: 1,
      models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [
        { id: 'coordinator', role: 'координатор', model: 'ds' },
        { id: 'lead', role: 'координатор', model: 'ds' },
        { id: 'worker', role: 'исполнитель', model: 'ds' },
      ],
    },
    'edges.json': {
      version: 1,
      edges: [
        { from: 'coordinator', to: 'worker', kind: 'delegate' },
        { from: 'lead', to: 'worker', kind: 'delegate' },
      ],
    },
  });
  const handler = createWebHandler(makeRuntime([fresh]));
  const url = API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh) + '&action=remove';
  for (const id of ['coordinator', 'lead']) {
    const refused = await call(handler, url, { method: 'POST', body: JSON.stringify({ id }) });
    assert.equal(refused.status, 400, 'координатор «' + id + '» не удаляется');
    assert.match(refused.body.error, /координатор не удаляется/);
    assert.match(refused.body.fix, /координатор не удаляется/);
  }
  const payload = readGraph(makeRuntime([fresh]), fresh);
  assert.ok(payload.graph.nodes.some((node) => node.id === 'coordinator'), 'координатор остался');
  assert.ok(payload.graph.nodes.some((node) => node.id === 'lead'), 'координатор по роли остался');
});

await test('POST /api/node?action=remove чистит узел и связи из разных фрагментов', async () => {
  const fresh = makeProject({
    'nodes.json': {
      version: 1,
      models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [
        { id: 'coordinator', role: 'координатор', model: 'ds' },
        { id: 'worker', role: 'исполнитель', model: 'ds' },
      ],
    },
    'edges.json': {
      version: 1,
      edges: [
        { from: 'coordinator', to: 'worker', kind: 'delegate' },
      ],
    },
  });
  const handler = createWebHandler(makeRuntime([fresh]));
  const url = API_PREFIX + '/api/node?root=' + encodeURIComponent(fresh) + '&action=remove';
  const res = await call(handler, url, { method: 'POST', body: JSON.stringify({ id: 'worker' }) });
  assert.equal(res.status, 200);
  assert.equal(res.body.edges, 1, 'удалено одно ребро');
  const nodesFile = JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'nodes.json'), 'utf8'));
  assert.ok(!nodesFile.nodes.some((node) => node.id === 'worker'), 'узел убран из своего фрагмента');
  const edgesFile = JSON.parse(fs.readFileSync(path.join(fresh, 'structure', 'edges.json'), 'utf8'));
  assert.deepEqual(edgesFile.edges, [], 'ребро убрано из своего фрагмента');
  const payload = readGraph(makeRuntime([fresh]), fresh);
  assert.equal(payload.errors.length, 0);
});

await test('POST /api/node: только локально и только POST', async () => {
  const handler = createWebHandler(makeRuntime([project]));
  const remote = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(project), {
    method: 'POST', remote: '10.0.0.5', body: JSON.stringify({ id: 'x' }),
  });
  assert.equal(remote.status, 403);
  const get = await call(handler, API_PREFIX + '/api/node?root=' + encodeURIComponent(project));
  assert.equal(get.status, 404);
});

await test('POST /api/workflow-install без спеки объясняет, что задать', async () => {
  const handler = createWebHandler(makeRuntime([project], { workflowInstallSpec: '' }));
  const res = await call(handler, API_PREFIX + '/api/workflow-install', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'no-spec');
  assert.match(res.body.fix, /workflowInstallSpec/);
});

await test('POST /api/workflow-install работает без выбранного проекта', async () => {
  const runtime = createGraphRuntime({ roots: [], workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.getPluginManager = () => ({ async installBundle() { return { application: 'applied', version: '0.6.0' }; } });
  const handler = createWebHandler(runtime);
  const res = await call(handler, API_PREFIX + '/api/workflow-install', { method: 'POST' });
  assert.equal(res.status, 200, 'установка профиля не должна требовать корень проекта');
  assert.equal(res.body.application, 'applied');
});

await test('POST /api/workflow-check сравнивает сборку с релизом', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.profileDir = path.join(fresh, '.profile');
  const pkgDir = path.join(runtime.profileDir, 'node_modules', 'dsh-workflow-console');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-workflow-console', version: '0.7.0' }));
  runtime.fetchRelease = async () => ({ plugin: '0.7.1', engine: '2.6.3' });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/workflow-check?root=' + encodeURIComponent(fresh), { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.body.current.plugin, '0.7.0');
  assert.equal(res.body.latest.plugin, '0.7.1');
  assert.equal(res.body.details.plugin, true);
  assert.equal(res.body.outdated, true);
});

await test('POST /api/workflow-check: актуальная сборка не предлагает обновление', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.profileDir = path.join(fresh, '.profile');
  const pkgDir = path.join(runtime.profileDir, 'node_modules', 'dsh-workflow-console');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-workflow-console', version: '0.7.1' }));
  runtime.fetchRelease = async () => ({ plugin: '0.7.1', engine: '2.6.3' });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/workflow-check?root=' + encodeURIComponent(fresh), { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.body.outdated, false);
});

await test('update поднимает оба слоя: плагин и движок', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.getPluginManager = () => ({
    async installBundle() { return { application: 'applied', version: '0.7.1' }; },
  });
  runtime.runEngineInit = () => ({ updated: true, version: '2.6.3' });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/workflow-install?action=update&root=' + encodeURIComponent(fresh), { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.engine, { updated: true, version: '2.6.3' },
    'обновление плагина обязано обновить и движок в воркспейсе');
  assert.equal(res.body.action, 'update');
});

await test('checkStructureRelease читает версию и ассет последнего релиза', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        tag_name: 'v1.0.10',
        published_at: '2026-11-06T10:00:00Z',
        assets: [
          { name: 'notes.txt', browser_download_url: 'https://example.test/notes.txt' },
          { name: 'dsh-project-graph-1.0.10.tgz', browser_download_url: 'https://example.test/dsh-project-graph-1.0.10.tgz' },
        ],
      }),
    };
  };
  const status = await checkStructureRelease({ current: '1.0.9', mode: 'package', fetcher });
  assert.equal(status.latest, '1.0.10', 'префикс v у тега отброшен');
  assert.equal(status.outdated, true);
  assert.equal(status.canUpdate, true);
  assert.equal(status.assetUrl, 'https://example.test/dsh-project-graph-1.0.10.tgz', 'берётся .tgz, а не первый ассет');
  assert.equal(status.publishedAt, '2026-11-06T10:00:00Z');
  assert.match(calls[0], /releases\/latest/u, 'по умолчанию проверяется последний релиз');
});

await test('checkStructureRelease: сбой не бросает, а возвращает outdated null и error', async () => {
  const refused = await checkStructureRelease({ current: '1.0.9', mode: 'package', fetcher: async () => ({ ok: false, status: 500 }) });
  assert.equal(refused.outdated, null);
  assert.match(refused.error, /HTTP 500/u);
  const broken = await checkStructureRelease({ current: '1.0.9', mode: 'package', fetcher: async () => { throw new Error('нет сети'); } });
  assert.equal(broken.outdated, null);
  assert.match(broken.error, /нет сети/u);
  const noTag = await checkStructureRelease({ current: '1.0.9', mode: 'package', fetcher: async () => ({ ok: true, json: async () => ({ assets: [] }) }) });
  assert.equal(noTag.outdated, null);
  assert.match(noTag.error, /tag_name/u);
});

await test('checkStructureRelease: link отдаёт причину и не предлагает кнопку', async () => {
  const status = await checkStructureRelease({
    current: '1.0.9',
    mode: 'link',
    fetcher: async () => ({ ok: true, json: async () => ({ tag_name: '1.0.10', assets: [] }) }),
  });
  assert.equal(status.outdated, true);
  assert.equal(status.canUpdate, false);
  assert.match(status.reason, /репозитор/u);
});

await test('checkStructureRelease отдаёт режим установки: кнопка выбирает действие (задание 0107)', async () => {
  const ready = (tag) => async () => ({ ok: true, json: async () => ({ tag_name: tag, assets: [] }) });
  const link = await checkStructureRelease({ current: '1.0.9', mode: 'link', fetcher: ready('1.0.10') });
  assert.equal(link.mode, 'link', 'режим ссылки едет вместе со статусом');
  const pkg = await checkStructureRelease({ current: '1.0.9', mode: 'package', fetcher: ready('1.0.10') });
  assert.equal(pkg.mode, 'package');
  const failed = await checkStructureRelease({ current: '1.0.9', mode: 'link', fetcher: async () => ({ ok: false, status: 500 }) });
  assert.equal(failed.mode, 'link', 'сбой сети не теряет режим установки');
});

await test('GET /api/release отдаёт статус версии структуры', async () => {
  const runtime = makeRuntime([project]);
  runtime.fetchStructureRelease = async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v9.9.9', assets: [{ name: 'dsh-project-graph-9.9.9.tgz', browser_download_url: 'https://example.test/dsh-project-graph-9.9.9.tgz' }] }),
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/release');
  assert.equal(res.status, 200);
  assert.equal(res.body.current, PLUGIN_VERSION);
  assert.equal(res.body.latest, '9.9.9');
  assert.equal(res.body.assetUrl, 'https://example.test/dsh-project-graph-9.9.9.tgz');
});

await test('POST /api/release/update: package ставит ассет последнего релиза', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh]);
  /* Пустой профиль: пакетная установка, а не ссылка на каталог из окружения. */
  runtime.profileDir = path.join(fresh, '.profile');
  const installed = [];
  runtime.getPluginManager = () => ({
    async installBundle(spec) { installed.push(spec); return { application: 'applied', version: '9.9.9' }; },
  });
  runtime.fetchStructureRelease = async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v9.9.9', assets: [{ name: 'dsh-project-graph-9.9.9.tgz', browser_download_url: 'https://example.test/dsh-project-graph-9.9.9.tgz' }] }),
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/release/update', { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.updated, true);
  assert.equal(res.body.version, '9.9.9');
  assert.deepEqual(installed, ['https://example.test/dsh-project-graph-9.9.9.tgz'], 'ставится ассет, а не страница релиза');
});

await test('updateLinkRelease: грязный каталог — отказ, pull не вызывается (задание 0107)', async () => {
  const dir = checkoutDir('1.0.11');
  const { run, calls } = gitRunner({
    ['-C ' + dir + ' status --porcelain']: { code: 0, stdout: ' M lib/x.js\n', stderr: '' },
  });
  const result = await updateLinkRelease({ linkPath: dir, run });
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(result.updated, false);
  assert.match(result.reason, /правк/u, 'причина называет локальные правки');
  assert.match(result.reason, /lib\/x\.js/u, 'причина показывает, что именно изменено');
  assert.equal(calls.length, 1, 'на грязном дереве дальше status не идём');
  assert.ok(!calls.some((args) => args.includes('pull')), 'pull не вызывается на грязном дереве');
});

await test('updateLinkRelease: чистый каталог — pull --ff-only и версия из package.json (задание 0107)', async () => {
  const dir = checkoutDir('1.0.11');
  const { run, calls } = gitRunner({
    ['-C ' + dir + ' status --porcelain']: { code: 0, stdout: '', stderr: '' },
    ['-C ' + dir + ' rev-parse --abbrev-ref HEAD']: { code: 0, stdout: 'main\n', stderr: '' },
    ['-C ' + dir + ' pull --ff-only']: { code: 0, stdout: 'Fast-forward\n', stderr: '' },
  });
  const result = await updateLinkRelease({ linkPath: dir, run });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.updated, true);
  assert.equal(result.version, '1.0.11', 'версия читается после pull');
  assert.match(result.reason, /перезапустите DSH/u, 'успех просит перезапуск');
  const pull = calls.find((args) => args.includes('pull'));
  assert.deepEqual(pull, ['-C', dir, 'pull', '--ff-only'], 'только fast-forward, без force');
  const flat = calls.map((args) => args.join(' ')).join('\n');
  assert.ok(!/--force|--no-verify|\breset\b|\bstash\b/u.test(flat), 'force, reset, stash и --no-verify не используются');
});

await test('updateLinkRelease: упавший pull — отказ с хвостом вывода (задание 0107)', async () => {
  const dir = checkoutDir('1.0.10');
  const { run } = gitRunner({
    ['-C ' + dir + ' status --porcelain']: { code: 0, stdout: '', stderr: '' },
    ['-C ' + dir + ' rev-parse --abbrev-ref HEAD']: { code: 0, stdout: 'main\n', stderr: '' },
    ['-C ' + dir + ' pull --ff-only']: { code: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in lib/x.js' },
  });
  const result = await updateLinkRelease({ linkPath: dir, run });
  assert.equal(result.status, 409);
  assert.equal(result.updated, false);
  assert.match(result.reason, /CONFLICT/u, 'причина берётся из вывода pull');
  assert.match(result.reason, /main/u, 'ветка названа в причине');
});

await test('updateLinkRelease: не git-каталог — отказ, pull не вызывается (задание 0107)', async () => {
  const dir = checkoutDir('1.0.10');
  const { run, calls } = gitRunner({
    ['-C ' + dir + ' status --porcelain']: { code: 128, stdout: '', stderr: 'fatal: not a git repository' },
  });
  const result = await updateLinkRelease({ linkPath: dir, run });
  assert.equal(result.status, 409);
  assert.equal(result.updated, false);
  assert.match(result.reason, /git/u);
  assert.ok(!calls.some((args) => args.includes('pull')), 'pull не вызывается вне репозитория');
});

await test('updateLinkRelease: пустой путь — отказ без обращения к git (задание 0107)', async () => {
  const calls = [];
  const result = await updateLinkRelease({ linkPath: '', run: (args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal(result.status, 409);
  assert.equal(result.updated, false);
  assert.equal(calls.length, 0, 'git не запускается без каталога');
  assert.match(result.reason, /каталог/u);
});

await test('POST /api/release/update: link обновляется pull --ff-only и просит перезапуск (задание 0107)', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh]);
  runtime.profileDir = path.join(fresh, '.profile');
  const checkout = checkoutDir('1.0.11');
  const link = path.join(runtime.profileDir, 'node_modules', 'dsh-project-graph');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(checkout, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(readStructureInstallMode(runtime), 'link');
  const calls = [];
  runtime.runGit = (args) => {
    calls.push(args);
    const key = args.join(' ');
    if (key.endsWith('status --porcelain')) return { code: 0, stdout: '', stderr: '' };
    if (key.endsWith('rev-parse --abbrev-ref HEAD')) return { code: 0, stdout: 'main\n', stderr: '' };
    if (key.endsWith('pull --ff-only')) return { code: 0, stdout: 'Fast-forward\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'неожиданный git-вызов: ' + key };
  };
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/release/update', { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.updated, true);
  assert.equal(res.body.version, '1.0.11');
  assert.match(res.body.reason, /перезапустите DSH/u);
  assert.ok(calls.some((args) => args.join(' ').endsWith('pull --ff-only')), 'fast-forward pull вызван');
  assert.ok(!calls.some((args) => /(?:^|\s)(?:--force|-f|reset|stash)(?:\s|$)/u.test(args.join(' '))), 'force/reset/stash не вызываются');
});

await test('POST /api/release/update: link с локальными правками — 409, pull не вызывается (задание 0107)', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh]);
  runtime.profileDir = path.join(fresh, '.profile');
  const checkout = checkoutDir('1.0.10');
  const link = path.join(runtime.profileDir, 'node_modules', 'dsh-project-graph');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(checkout, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(readStructureInstallMode(runtime), 'link');
  const calls = [];
  runtime.runGit = (args) => {
    calls.push(args);
    return { code: 0, stdout: ' M lib/x.js\n', stderr: '' };
  };
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/release/update', { method: 'POST' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.updated, false);
  assert.match(res.body.reason, /правк/u, 'причина называет локальные правки');
  assert.equal(calls.length, 1, 'на грязном дереве pull не вызывается');
  assert.ok(!calls.some((args) => args.includes('pull')));
});

await test('POST /api/release/update: актуальная сборка не переустанавливается', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh]);
  runtime.profileDir = path.join(fresh, '.profile');
  let installed = 0;
  runtime.getPluginManager = () => ({ async installBundle() { installed += 1; return { application: 'applied' }; } });
  runtime.fetchStructureRelease = async () => ({
    ok: true,
    json: async () => ({ tag_name: PLUGIN_VERSION, assets: [{ name: 'x.tgz', browser_download_url: 'https://example.test/x.tgz' }] }),
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/release/update', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, false);
  assert.match(res.body.reason, /последн/u);
  assert.equal(installed, 0, 'актуальную сборку не трогаем');
});

await test('POST /api/release/update: без pluginManager — отказ, а не молчание', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh]);
  runtime.profileDir = path.join(fresh, '.profile');
  runtime.fetchStructureRelease = async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v9.9.9', assets: [{ name: 'x.tgz', browser_download_url: 'https://example.test/x.tgz' }] }),
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/release/update', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal(res.body.updated, false);
  assert.match(res.body.reason, /pluginManager/u);
});

await test('GET /api/exchange отдаёт факты обмена и тип связи из объявленной папки', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-exchange-'));
  const root = path.join(parent, 'project');
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  /* Обмен читается только из ящика, объявленного в structure/graph.json. */
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    ...GRAPH,
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      participants: ['structure', 'workflow'],
      orchestrator: 'analyst-a',
    }],
  }));
  const dir = path.join(root, 'coordination', 'threads');
  fs.mkdirSync(dir, { recursive: true });
  const head = (from, to, date) => 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nThread: t\nStatus: info\n';
  fs.writeFileSync(path.join(dir, 'a.md'), head('structure', 'workflow', '2026-10-28T17:26+03:00'));
  fs.writeFileSync(path.join(dir, 'b.md'), head('workflow', 'structure', '2026-10-28T19:05+03:00'));
  const runtime = createGraphRuntime({
    roots: [root],
    participants: { structure: root, workflow: 'C:/elsewhere' },
    exchange: [],
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
  assert.equal(res.status, 200);
  assert.equal(res.body.label, 'structure');
  assert.equal(res.body.links.length, 1);
  assert.equal(res.body.links[0].kind, 'two-way');
  assert.equal(res.body.links[0].outgoing, 1);
  assert.equal(res.body.links[0].incoming, 1);
  assert.equal(res.body.folders.length, 1, 'портал объявленной папки');
});

await test('предупреждение обмена: участник вне participants назван причиной, а не «0 писем»', async () => {
  const root = portalProject([portalFolder('folder-1', 'coordination')]);
  const box = path.join(root, 'coordination');
  fs.mkdirSync(path.join(box, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(box, 'contract.md'), 'Format: dsh-exchange/1-contract\nRev: 1\n');
  /* Письмо лежит на диске: «0 писем» здесь был бы неправдой. */
  fs.writeFileSync(path.join(box, 'threads', 'one.md'), portalHead('workflow', 'structure', '2026-11-03T23:16+03:00'));
  const handler = createWebHandler(makeRuntime([root], {
    participants: { structure: root },
    me: 'structure',
  }));
  const res = await call(handler, API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.warnings.length, 1, 'одна запись на неразрешённую метку');
  const [warning] = res.body.warnings;
  assert.equal(warning.code, 'participant-unresolved');
  assert.equal(warning.label, 'workflow');
  assert.match(warning.message, /workflow/);
  assert.match(warning.message, /roots\/participants/);
  assert.match(warning.message, /ящик не читается/);
  assert.match(warning.fix, /workflow/);
  assert.match(warning.fix, /cordis\.patch\.yml/);
  /* Состояние (задание 0028) остаётся, письма не выдумываются. */
  assert.equal(res.body.folders[0].states.workflow, 'unresolved');
  assert.equal(res.body.folders[0].members.find((member) => member.label === 'workflow').path, null);
  assert.equal(res.body.total, 1, 'письма на диске по-прежнему читаются');
});

await test('карта предупреждений не подменяет идентичность стороны', () => {
  /* Второй аргумент createGraphRuntime — зависимости, а не профиль (урок 0047 c2). */
  const runtime = createGraphRuntime({ roots: [project] }, { participants: { structure: project } });
  assert.deepEqual(runtime.participants, {}, 'participants остаются из профиля');
  assert.equal(runtime.warningParticipants.structure, project, 'карта предупреждений живёт отдельно');
});

await test('предупреждений обмена нет, когда каждый участник разрешается', async () => {
  const root = portalProject([portalFolder('folder-1', 'coordination')]);
  const peer = path.join(path.dirname(root), path.basename(root) + '-workflow-peer');
  fs.mkdirSync(path.join(peer, 'structure'), { recursive: true });
  fs.mkdirSync(path.join(root, 'coordination', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'coordination', 'contract.md'), 'Format: dsh-exchange/1-contract\nRev: 1\n');
  fs.writeFileSync(path.join(root, 'coordination', 'threads', 'one.md'), portalHead('workflow', 'structure', '2026-11-03T23:16+03:00'));
  const handler = createWebHandler(makeRuntime([root, peer], {
    participants: { structure: root, workflow: peer },
    me: 'structure',
  }));
  const res = await call(handler, API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.warnings, [], 'разрешённые участники не дают предупреждения');
  assert.equal(res.body.folders.length, 1, 'лента порталов не менялась');
});

await test('GET /api/exchange без объявленной папки не подхватывает соседний coordination', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-exchange-foreign-'));
  const root = path.join(parent, 'project');
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(GRAPH));
  /* Чужой обмен лежит рядом с воркспейсом и легко нашёлся бы автообнаружением. */
  const dir = path.join(parent, 'coordination', 'threads');
  fs.mkdirSync(dir, { recursive: true });
  const head = (from, to, date) => 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nThread: t\nStatus: info\n';
  fs.writeFileSync(path.join(dir, 'a.md'), head('structure', 'workflow', '2026-10-28T17:26+03:00'));
  const runtime = createGraphRuntime({
    roots: [root],
    participants: { structure: root, workflow: 'C:/elsewhere' },
    exchange: [],
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.facts, [], 'без объявленной папки фактов нет');
  assert.deepEqual(res.body.links, [], 'без объявленной папки связей нет');
  assert.deepEqual(res.body.folders, [], 'без объявленной папки порталов нет');
  assert.equal(res.body.total, 0);
  assert.equal(res.body.label, 'project', 'легаси-портал называет только текущий воркспейс');
  assert.deepEqual(res.body.participants, ['project'], 'у легаси-портала ровно один участник');
  assert.ok(!JSON.stringify(res.body).includes('workflow'), 'чужих меток участников в ответе нет');
});

await test('graph сообщает, какой узел представляет текущую сессию', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const withSelf = createGraphRuntime({ roots: [fresh], self: 'coordinator' });
  assert.equal(readGraph(withSelf, fresh).selfNode, 'coordinator');
  const without = createGraphRuntime({ roots: [fresh] });
  assert.equal(readGraph(without, fresh).selfNode, null, 'без объявления активность не выдумывается');
});

await test('создание узла критика кладёт базовую спеку, не перезаписывая существующую', async () => {
  const withoutCritic = {
    ...GRAPH,
    nodes: GRAPH.nodes.filter((node) => node.id !== 'critic'),
    edges: GRAPH.edges.filter((edge) => edge.from !== 'critic' && edge.to !== 'critic'),
  };
  const dir = makeProject({ 'graph.json': withoutCritic });
  const runtime = makeRuntime([dir], {}, checkDeps());
  const created = addNode(runtime, dir, {
    id: 'critic', role: 'критик', provider: 'opencode', model: 'deepseek-v4.1-flash',
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(created.node.provider, 'opencode', 'ответ несёт прямую пару');
  assert.ok(created.spec && created.spec.created === true, 'спека создаётся вместе с узлом');
  const specFile = path.join(dir, 'docs', 'critic', 'spec.md');
  assert.ok(fs.existsSync(specFile), 'файл базовой спеки на месте');
  const first = fs.readFileSync(specFile, 'utf8');
  fs.writeFileSync(specFile, first + '\nПРАВКА ЧЕЛОВЕКА\n', 'utf8');
  const second = addNode(runtime, dir, {
    id: 'critic2', role: 'критик', provider: 'opencode', model: 'deepseek-v4.1-flash',
  });
  assert.equal(second.status, 200);
  assert.ok(second.spec && second.spec.created === false, 'существующая спека не перезаписывается');
  assert.ok(fs.readFileSync(specFile, 'utf8').includes('ПРАВКА ЧЕЛОВЕКА'));
});

await test('критик без расписания: узел получает 09:00, время сохраняется и создаёт расписание', async () => {
  const dir = makeProject({ 'graph.json': {
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'coordinator', role: 'координатор', model: 'work' }],
    edges: [],
  } });
  const runtime = makeRuntime([dir], {}, checkDeps());
  const created = addNode(runtime, dir, { id: 'Critic', role: 'critic', model: 'work' });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(created.node.provider, 'opencode');
  assert.equal(created.node.model, 'deepseek-v4.1-flash', 'алиас work развёрнут при записи');
  assert.deepEqual(created.node.schedule, { at: '09:00', timeZone: 'Europe/Moscow' },
    'критик с ролью critic и заглавной буквой тоже получает расписание');
  const saved = await call(createWebHandler(runtime), API_PREFIX + '/api/schedule', {
    method: 'POST',
    body: JSON.stringify({ root: dir, node: 'Critic', at: '23:30' }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'structure', 'graph.json'), 'utf8'));
  assert.equal(file.nodes[1].schedule.at, '23:30');
});

await test('участники папки обмена: список в узле и спека с императивом каждому', async () => {
  const first = makeProject({ 'graph.json': {
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'exchange-1', role: 'обмен', brief: 'общая папка' }],
    edges: [],
  } });
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-second-'));
  fs.mkdirSync(path.join(second, 'structure'), { recursive: true });
  const runtime = makeRuntime([first, second]);
  const handler = createWebHandler(runtime);
  const saved = await call(handler, API_PREFIX + '/api/exchange-participants', {
    method: 'POST',
    body: JSON.stringify({ root: first, node: 'exchange-1', participants: [first, second] }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const structure = JSON.parse(fs.readFileSync(path.join(first, 'structure', 'graph.json'), 'utf8'));
  assert.deepEqual(structure.nodes[0].participants, [first, second], 'участники записаны в структуру');
  const spec = fs.readFileSync(path.join(first, 'docs', 'exchange.md'), 'utf8');
  assert.match(spec, /Папка обмена/u);
  assert.match(spec, /проверяй папку обмена на новые сообщения/u, 'императив проверки записан');
  assert.ok(fs.existsSync(path.join(second, 'docs', 'exchange.md')), 'второй воркспейс получил свою спеку');
  assert.equal(saved.body.written.length, 2, 'спека записана каждому участнику');
});

await test('POST /api/session привязывает узел к сессии и отвязывает', async () => {
  const dir = makeProject({ 'graph.json': {
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'coordinator', role: 'координатор', model: 'work' }],
    edges: [],
  } });
  const runtime = makeRuntime([dir]);
  const handler = createWebHandler(runtime);
  const saved = await call(handler, API_PREFIX + '/api/session', {
    method: 'POST',
    body: JSON.stringify({ root: dir, node: 'coordinator', session: 'session-abc' }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'structure', 'graph.json'), 'utf8'));
  assert.equal(file.nodes[0].session, 'session-abc', 'привязка записана в структуру');
  const cleared = await call(handler, API_PREFIX + '/api/session', {
    method: 'POST',
    body: JSON.stringify({ root: dir, node: 'coordinator', session: null }),
  });
  assert.equal(cleared.status, 200);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'structure', 'graph.json'), 'utf8'));
  assert.equal(after.nodes[0].session, undefined, 'отвязка убирает поле');
});

await test('POST /api/schedule меняет время запуска и отвергает мусор', async () => {
  const dir = makeProject({ 'graph.json': {
    version: 1,
    nodes: [{ id: 'critic', role: 'критик', model: 'work', schedule: { at: '09:00', timeZone: 'Europe/Moscow' } }],
    edges: [],
  } });
  const runtime = makeRuntime([dir]);
  const handler = createWebHandler(runtime);
  const saved = await call(handler, API_PREFIX + '/api/schedule', {
    method: 'POST',
    body: JSON.stringify({ root: dir, node: 'critic', at: '21:30' }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'structure', 'graph.json'), 'utf8'));
  assert.equal(file.nodes[0].schedule.at, '21:30', 'время записано в файл структуры');
  const bad = await call(handler, API_PREFIX + '/api/schedule', {
    method: 'POST',
    body: JSON.stringify({ root: dir, node: 'critic', at: '9:00' }),
  });
  assert.equal(bad.status, 400, 'формат HH:MM обязателен');
  const noSchedule = await call(handler, API_PREFIX + '/api/schedule', {
    method: 'POST',
    body: JSON.stringify({ root: dir, node: 'unknown', at: '09:00' }),
  });
  assert.equal(noSchedule.status, 404);
});

await test('live: пустая служба агентов, но свежая сессия видна как активность без роли', async () => {
  const dir = makeProject({ 'graph.json': GRAPH });
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sessions-api-'));
  const marker = '--' + path.resolve(dir).toLowerCase().replace(/:/gu, '').replace(/\\/gu, '-').replace(/\//gu, '-') + '--';
  const sessionDir = path.join(sessions, marker, 'session-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'x');
  const runtime = createGraphRuntime({ roots: [dir] }, { getAgents: () => [] });
  runtime.sessionsDir = sessions;
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 0, 'служба пуста — так и сказано');
  assert.ok(res.body.sessions && res.body.sessions.running >= 1, 'свежая сессия считается активностью');
});

await test('связанный плагин: обновление через панель не предлагается, а рекомендация называет интерфейс workflow', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-profile-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-plugin-'));
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'dsh-workflow-console', version: '0.7.0' }));
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  fs.symlinkSync(source, path.join(profile, 'node_modules', 'dsh-workflow-console'), 'junction');
  const dir = makeProject({ 'graph.json': GRAPH });
  const runtime = createGraphRuntime({ roots: [dir], workflowInstallSpec: 'https://example.invalid/dsh-workflow-console.tgz' }, {});
  runtime.profileDir = profile;
  runtime.fetchRelease = async () => ({ plugin: '0.7.1', engine: '2.6.3' });
  const checked = await checkWorkflow(runtime, dir);
  assert.equal(checked.safe, false, 'при link кнопка обновления опасна');
  assert.match(checked.recommendation.text, /интерфейс самого workflow/);
  assert.equal(checked.current.link, true);
});

/*
 * Задание 0043: проверка сборки отвечает, ГДЕ движок обновляется. Для внешнего
 * движка это его репозиторий, а не каталог docs/subagent-workflow внутри него и
 * не этот воркспейс: панель не должна обещать обновление здесь.
 */
await test('checkWorkflow: engineScope для local, mapped и absent', async () => {
  await withEngineMap({}, async () => {
    /* The release is a stub on the runtime: the check must not touch the network in a test. */
    const release = async () => ({ plugin: '0.9.5', engine: '2.6.16' });
    const local = makeProject({ 'graph.json': GRAPH });
    const localEngine = engineRepo(local, '2.6.2');
    const localRuntime = makeRuntime([local], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
    localRuntime.fetchRelease = release;
    const localCheck = await checkWorkflow(localRuntime, local);
    assert.equal(localCheck.status, 200, JSON.stringify(localCheck).slice(0, 300));
    assert.deepEqual(localCheck.engineScope, {
      mode: 'local', where: 'workspace', path: path.resolve(localEngine),
    }, 'локальный движок обновляется в воркспейсе');

    const ws = makeProject({ 'graph.json': GRAPH });
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-repo-'));
    engineRepo(repository, '2.6.15');
    const mappedRuntime = makeRuntime([ws], {
      workflowInstallSpec: 'https://example.invalid/p.tgz',
      engines: { roots: { [ws]: repository } },
    });
    mappedRuntime.fetchRelease = release;
    const mappedCheck = await checkWorkflow(mappedRuntime, ws);
    assert.equal(mappedCheck.status, 200, JSON.stringify(mappedCheck).slice(0, 300));
    assert.deepEqual(mappedCheck.engineScope, {
      mode: 'mapped', where: 'engine-repo', path: path.resolve(repository),
    }, 'внешний движок обновляется в репозитории движка, а не в каталоге движка');
    assert.match(mappedCheck.recommendation.text, /репозитории движка/iu,
      'рекомендация называет репозиторий движка');
    assert.ok(mappedCheck.recommendation.text.includes(path.resolve(repository)),
      'рекомендация называет путь репозитория: ' + mappedCheck.recommendation.text);

    const bare = makeProject({ 'graph.json': GRAPH });
    const bareRuntime = makeRuntime([bare], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
    bareRuntime.fetchRelease = release;
    const absentCheck = await checkWorkflow(bareRuntime, bare);
    assert.equal(absentCheck.status, 200, JSON.stringify(absentCheck).slice(0, 300));
    assert.deepEqual(absentCheck.engineScope, { mode: 'absent', where: 'none', path: null },
      'движка нет — обновлять негде');
  });
});

await test('раскладка сохраняется, даже когда roots пуст, а корень пришёл в теле', async () => {
  const dir = makeProject({ 'graph.json': GRAPH });
  /*
   * The live profile keeps roots: [] and the workspace registry arrives only after
   * the runtime is built, so defaultRoot stays null while the allowed list is full.
   */
  let registryReady = false;
  const runtime = createGraphRuntime({ roots: [] }, {
    getWorkspaceRegistry: () => (registryReady ? { list: () => [{ path: dir }] } : { list: () => [] }),
  });
  registryReady = true;
  const handler = createWebHandler(runtime);
  const body = JSON.stringify({ root: dir, positions: { 'analyst-a': { x: 40, y: 120 } } });
  const res = await call(handler, API_PREFIX + '/api/layout', { method: 'POST', body });
  assert.equal(res.status, 200, 'раскладка не должна упираться в пустой roots');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'structure', 'graph.json'), 'utf8'));
  const node = saved.nodes.find((item) => item.id === 'analyst-a');
  assert.equal(node.x, 40);
  assert.equal(node.y, 120);
});

await test('graph сообщает, развёрнут ли движок workflow в проекте', async () => {
  const withEngine = makeProject({ 'graph.json': GRAPH });
  fs.mkdirSync(path.join(withEngine, 'docs', 'subagent-workflow'), { recursive: true });
  fs.writeFileSync(path.join(withEngine, 'docs', 'subagent-workflow', 'VERSION'), '2.6.2\n');
  fs.writeFileSync(path.join(withEngine, 'docs', 'subagent-workflow', 'workflow.config.json'), '{}');
  const deployed = readGraph(makeRuntime([withEngine]), withEngine);
  assert.equal(deployed.engine.deployed, true);
  assert.equal(deployed.engine.version, '2.6.2');
  const bare = makeProject({ 'graph.json': GRAPH });
  const empty = readGraph(makeRuntime([bare]), bare);
  assert.equal(empty.engine.deployed, false, 'плагин в профиле и движок в проекте — разные вещи');
  assert.equal(empty.engine.version, null);
});

await test('POST /api/workflow-install?action=update удаляет прежнюю версию и ставит заново', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const calls = [];
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.getPluginManager = () => ({
    async removeBundle(name) { calls.push(['remove', name]); },
    async installBundle(spec) { calls.push(['install', spec]); return { application: 'applied', version: '0.6.0' }; },
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/workflow-install?action=update', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, true);
  assert.equal(res.body.action, 'update');
  assert.deepEqual(calls, [['remove', 'dsh-workflow-console'], ['install', 'https://example.invalid/p.tgz']]);
});

await test('update: если прежней версии нет, установка всё равно делается', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const failure = new Error('nothing to remove');
  failure.code = 'not-removable';
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.getPluginManager = () => ({
    async removeBundle() { throw failure; },
    async installBundle() { return { application: 'applied', version: '0.6.0' }; },
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/workflow-install?action=update', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, false);
});

await test('update: сбой установки возвращает прежнюю версию, а не оставляет профиль пустым', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const calls = [];
  const failure = new Error('сеть недоступна');
  failure.code = 'network';
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.getPluginManager = () => ({
    async listBundles() {
      return [{ name: 'dsh-workflow-console', removable: true, source: 'link:C:/Users/Goryachev/Documents/deepseek-harness/subagent-workflow-v2/plugin' }];
    },
    async removeBundle(name) { calls.push(['remove', name]); },
    async installBundle(spec) {
      calls.push(['install', spec]);
      if (calls.length === 2) throw failure;
      return { application: 'applied', version: '0.6.0' };
    },
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/workflow-install?action=update', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.restored, true);
  assert.match(res.body.error, /прежняя установка восстановлена/);
  assert.deepEqual(calls, [
    ['remove', 'dsh-workflow-console'],
    ['install', 'https://example.invalid/p.tgz'],
    ['install', 'link:C:/Users/Goryachev/Documents/deepseek-harness/subagent-workflow-v2/plugin'],
  ]);
});

await test('update: если восстановить не удалось, человеку дан ручной путь', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.getPluginManager = () => ({
    async listBundles() { return [{ name: 'dsh-workflow-console', removable: true, source: 'link:C:/local/plugin' }]; },
    async removeBundle() {},
    async installBundle() { throw new Error('нет сети'); },
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/workflow-install?action=update', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.restored, false);
  assert.match(res.body.fix, /Поставьте плагин вручную: link:C:\/local\/plugin/);
});

await test('update: сбой удаления объясняется и не притворяется установкой', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const failure = new Error('файл занят');
  failure.code = 'EBUSY';
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.getPluginManager = () => ({
    async removeBundle() { throw failure; },
    async installBundle() { throw new Error('не должны были дойти'); },
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/workflow-install?action=update', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'EBUSY');
  assert.match(res.body.fix, /Настройки → Плагины/);
});

await test('POST /api/workflow-install без службы pluginManager не падает', async () => {
  const handler = createWebHandler(makeRuntime([project], { workflowInstallSpec: 'https://example.invalid/p.tgz' }));
  const res = await call(handler, API_PREFIX + '/api/workflow-install', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'no-manager');
  assert.match(res.body.fix, /pluginManager/);
});

await test('POST /api/workflow-install: applied и restart-required различаются', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  let calls = 0;
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/dsh-workflow-console.tgz' });
  runtime.getPluginManager = () => ({
    async installBundle(spec) {
      calls += 1;
      assert.equal(spec, 'https://example.invalid/dsh-workflow-console.tgz');
      return calls === 1
        ? { application: 'applied', bundle: 'dsh-workflow-console', version: '0.6.0' }
        : { application: 'restart-required', restartReason: 'нет hmr' };
    },
  });
  const handler = createWebHandler(runtime);
  const applied = await call(handler, API_PREFIX + '/api/workflow-install', { method: 'POST' });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.application, 'applied');
  assert.equal(applied.body.version, '0.6.0');
  const restart = await call(handler, API_PREFIX + '/api/workflow-install', { method: 'POST' });
  assert.equal(restart.status, 200);
  assert.equal(restart.body.application, 'restart-required');
  assert.equal(restart.body.restartReason, 'нет hmr');
});

await test('POST /api/workflow-install: отказы менеджера приходят с кодом и рецептом', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'dsh-workflow-console@^0.6.0' });
  const failure = new Error('already there');
  failure.code = 'already-installed';
  runtime.getPluginManager = () => ({ async installBundle() { throw failure; } });
  const handler = createWebHandler(runtime);
  const res = await call(handler, API_PREFIX + '/api/workflow-install', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'already-installed');
  /* v2 schema: already-installed is an hmr-host answer; elsewhere the repeat installs. */
  assert.match(res.body.fix, /hmr/);
  assert.match(res.body.fix, /plugin\.version/);
  assert.match(res.body.fix, /удалите плагин/);
});

await test('POST /api/workflow-install: сбой pnpm отдаёт хвост вывода', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.getPluginManager = () => ({
    async installBundle() {
      return { application: 'applied', packageResult: { exitCode: 1, output: 'ERR_PNPM_FETCH_404 не найдено' } };
    },
  });
  const handler = createWebHandler(runtime);
  const res = await call(handler, API_PREFIX + '/api/workflow-install', { method: 'POST' });
  assert.equal(res.status, 502);
  assert.match(res.body.output, /ERR_PNPM_FETCH_404/);
  assert.match(res.body.fix, /проверьте|сети/i);
});

await test('описание сбоя pnpm: несовпадение store названо, а не выдано за сеть (задание 0172)', () => {
  const output = '[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location\n'
    + 'The dependencies are linked from store v10\npnpm now wants v11';
  const failure = describePnpmFailure({ exitCode: 1, output });
  assert.equal(failure.code, 'store-mismatch', 'сбой store — свой код, а не network');
  assert.match(failure.message, /store/u);
  assert.match(failure.message, /v10/u);
  assert.match(failure.message, /v11/u);
  assert.match(failure.message, /pnpm install/u, 'рецепт называет команду');
  assert.match(failure.message, /профил/u, 'рецепт называет место — профиль');
  assert.doesNotMatch(failure.message, /Проверьте сеть/u, 'сеть не виновата');
});

await test('описание сбоя pnpm: обычная ошибка остаётся сетью с хвостом вывода (задание 0172)', () => {
  const output = 'строка 1\nстрока 2\nстрока 3\nстрока 4\nстрока 5\nстрока 6\nERR_PNPM_FETCH_404 GET https://x: Not found';
  const failure = describePnpmFailure({ exitCode: 1, output });
  assert.equal(failure.code, 'network');
  assert.match(failure.message, /ERR_PNPM_FETCH_404/u, 'причина берётся из вывода pnpm');
  assert.match(failure.message, /Not found/u);
  assert.match(failure.message, /код 1/u, 'код выхода назван');
  assert.doesNotMatch(failure.message, /строка 1/u, 'в сообщение идёт хвост, а не весь вывод');
  const empty = describePnpmFailure({ exitCode: 1, output: '' });
  assert.equal(empty.code, 'network');
  assert.match(empty.message, /вывод пуст/u, 'пустой вывод объясняется, а не тонет в скобках');
});

await test('POST /api/workflow-install: store-mismatch приходит со своим кодом и рецептом (задание 0172)', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([fresh], { workflowInstallSpec: 'https://example.invalid/p.tgz' });
  runtime.getPluginManager = () => ({
    async installBundle() {
      return {
        application: 'applied',
        packageResult: { exitCode: 1, output: '[ERR_PNPM_UNEXPECTED_STORE] linked from store v10; pnpm wants v11' },
      };
    },
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/workflow-install', { method: 'POST' });
  assert.equal(res.status, 409, 'store лечится в профиле, а не повтором установки');
  assert.equal(res.body.code, 'store-mismatch');
  assert.match(res.body.error, /store/u);
  assert.match(res.body.fix, /pnpm install/u);
  assert.match(res.body.fix, /профил/u);
  assert.match(res.body.output, /UNEXPECTED_STORE/u, 'вывод pnpm остаётся в ответе');
});

await test('readStructureInstallMode: папка и неизвестный профиль различаются (задание 0172)', () => {
  const previous = process.env.DSH_PROFILE_DIR;
  delete process.env.DSH_PROFILE_DIR;
  try {
    const profile = makeProject(null);
    const slot = path.join(profile, 'node_modules', 'dsh-project-graph');
    fs.mkdirSync(slot, { recursive: true });
    const pkgRuntime = makeRuntime([profile]);
    pkgRuntime.profileDir = profile;
    assert.equal(readStructureInstallMode(pkgRuntime), 'package',
      'настоящая папка — пакетная установка');
    const noProfile = makeRuntime([profile]);
    noProfile.profileDir = '';
    assert.equal(readStructureInstallMode(noProfile), 'unknown',
      'без профиля режим неизвестен, а не «пакет»');
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = previous;
  }
});

await test('POST /api/release/update: неизвестный профиль — 409 с рецептом, pnpm не трогается (задание 0172)', async () => {
  const previous = process.env.DSH_PROFILE_DIR;
  delete process.env.DSH_PROFILE_DIR;
  try {
    const fresh = makeProject({ 'graph.json': GRAPH });
    const runtime = makeRuntime([fresh]);
    runtime.profileDir = '';
    let installed = 0;
    runtime.getPluginManager = () => ({ async installBundle() { installed += 1; return { application: 'applied' }; } });
    runtime.fetchStructureRelease = async () => { throw new Error('релиз не должен запрашиваться без профиля'); };
    const res = await call(createWebHandler(runtime), API_PREFIX + '/api/release/update', { method: 'POST' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.updated, false);
    assert.match(res.body.reason, /не удалось определить способ установки/u);
    assert.match(res.body.fix, /перезапустите DSH/iu, 'рецепт называет перезапуск');
    assert.match(res.body.fix, /вручную/u, 'рецепт оставляет ручное обновление');
    assert.equal(installed, 0, 'в pnpm наугад не идём');
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = previous;
  }
});

await test('status сообщает спеку установки для карточки', async () => {
  const withSpec = createWebHandler(makeRuntime([project], { workflowInstallSpec: 'dsh-workflow-console@^0.6.0' }));
  const first = await call(withSpec, API_PREFIX + '/api/status');
  assert.equal(first.body.workflow.installSpec, 'dsh-workflow-console@^0.6.0');
  const fallback = createWebHandler(makeRuntime([project]));
  const second = await call(fallback, API_PREFIX + '/api/status');
  assert.equal(second.body.workflow.installSpec, DEFAULT_WORKFLOW_INSTALL_SPEC,
    'без ключа в конфиге панель берёт стабильную ссылку, а не теряет кнопку');
  const disabled = createWebHandler(makeRuntime([project], { workflowInstallSpec: '' }));
  const third = await call(disabled, API_PREFIX + '/api/status');
  assert.equal(third.body.workflow.installSpec, null, 'явно пустая строка отключает установку');
});

await test('POST /api/init отклоняет неизвестный шаблон', async () => {
  const fresh = makeProject(null);
  const handler = createWebHandler(makeRuntime([fresh]));
  const res = await call(handler, API_PREFIX + '/api/init?template=tree', { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match(res.body.fix, /hierarchy/);
  assert.equal(fs.existsSync(path.join(fresh, 'structure', 'graph.json')), false);
});

await test('POST /api/init не перезаписывает существующую структуру', async () => {
  await withStore(async (store) => {
    const fresh = makeProject(null);
    const handler = createWebHandler(makeRuntime([fresh]));
    const first = await call(handler, API_PREFIX + '/api/init', { method: 'POST' });
    assert.equal(first.status, 201);
    assert.ok(String(first.body.created).startsWith(store), 'created указывает в хранилище');
    const file = first.body.created;
    const before = fs.readFileSync(file, 'utf8');
    const second = await call(handler, API_PREFIX + '/api/init', { method: 'POST' });
    assert.equal(second.status, 409);
    assert.match(second.body.fix, /не перезаписывает/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(fresh, 'structure')), false, 'хранилище не переехало в репозиторий');
  });
});

await test('легаси-проект: повторный init отвечает «уже существует», хранилище не тронуто', async () => {
  await withStore(async (store) => {
    const legacy = makeProject({ 'graph.json': GRAPH });
    const before = fs.readdirSync(store).length;
    const handler = createWebHandler(makeRuntime([legacy]));
    const res = await call(handler, API_PREFIX + '/api/init', { method: 'POST' });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /уже есть структура/);
    assert.equal(resolveStructure(legacy).mode, 'repo', 'легаси-проект остаётся на месте');
    const file = JSON.parse(fs.readFileSync(path.join(legacy, 'structure', 'graph.json'), 'utf8'));
    assert.equal(file.nodes.length, GRAPH.nodes.length, 'структура в репозитории цела');
    assert.equal(fs.readdirSync(store).length, before, 'для легаси-проекта хранилище не создаётся');
  });
});

await test('POST /api/init отказывает, если структура уже объявлена', async () => {
  const handler = createWebHandler(makeRuntime([project]));
  const res = await call(handler, API_PREFIX + '/api/init', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /уже есть структура/);
});

await test('POST /api/init: только свой корень, только локально, только POST', async () => {
  const handler = createWebHandler(makeRuntime([project]));
  const foreign = await call(handler, API_PREFIX + '/api/init?root=' + encodeURIComponent(path.resolve(project, '..')), { method: 'POST' });
  assert.equal(foreign.status, 400);
  const remote = await call(handler, API_PREFIX + '/api/init', { method: 'POST', remote: '10.0.0.5' });
  assert.equal(remote.status, 403);
  const get = await call(handler, API_PREFIX + '/api/init');
  assert.equal(get.status, 404);
});

await test('маршрут панели переживает сбой ctx.effect и возвращается сам', async () => {
  const routes = new Map();
  const registered = [];
  const ctx = {
    effect(fn) {
      const disposer = fn();
      // Эффект, привязанный к временной области активации, может исчезнуть сразу.
      if (typeof disposer === 'function') disposer();
      return disposer;
    },
    webServer: {
      prefixes: routes,
      register(route) {
        if (routes.has(route.path)) throw new Error('webserver: duplicate prefix route "' + route.path + '"');
        routes.set(route.path, route);
        registered.push(route.path);
        return () => routes.delete(route.path);
      },
    },
    logger: { warn() {} },
  };
  registerGraphWeb(ctx, makeRuntime([project]));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(routes.has(API_PREFIX), true);
  assert.ok(registered.includes(API_PREFIX));
});

await test('повторная регистрация маршрута идемпотентна', () => {
  const routes = new Map();
  let registers = 0;
  const ctx = {
    effect(fn) { return fn(); },
    webServer: {
      prefixes: routes,
      register(route) {
        if (routes.has(route.path)) throw new Error('duplicate');
        registers += 1;
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    logger: { warn() {} },
  };
  const runtime = makeRuntime([project]);
  registerGraphWeb(ctx, runtime);
  registerGraphWeb(ctx, runtime);
  assert.equal(registers, 1);
  assert.equal(routes.has(API_PREFIX), true);
});

await test('маршрут занимается сразу, даже если в таблице висит прежний владелец', () => {
  const routes = new Map();
  routes.set(API_PREFIX, { oldOwner: true });
  let registers = 0;
  const ctx = {
    webServer: {
      prefixes: routes,
      register(route) {
        if (routes.has(route.path)) throw new Error('webserver: duplicate prefix route');
        routes.set(route.path, route);
        registers += 1;
        return () => routes.delete(route.path);
      },
    },
    logger: { warn() {} },
  };
  const runtime = makeRuntime([project]);
  registerGraphWeb(ctx, runtime);
  assert.equal(registers, 1);
  assert.equal(routes.get(API_PREFIX).oldOwner, undefined);
});

await test('сторож возвращает маршрут, если прежний владелец снял его после активации', async () => {
  const routes = new Map();
  routes.set(API_PREFIX, { oldOwner: true });
  const ctx = {
    webServer: {
      prefixes: routes,
      register(route) {
        if (routes.has(route.path)) throw new Error('webserver: duplicate prefix route');
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    logger: { warn() {} },
  };
  const runtime = makeRuntime([project]);
  const route = registerGraphWeb(ctx, runtime, { watchdogMs: 40 });
  // Прежний владелец снимает маршрут уже после нашей активации.
  setTimeout(() => routes.delete(API_PREFIX), 20);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(routes.has(API_PREFIX), true);
  assert.equal(routes.get(API_PREFIX).handler, route.handler);
});

await test('маршрут переживает позднее снятие: сторож держит его всё время жизни', async () => {
  const routes = new Map();
  const ctx = {
    webServer: {
      prefixes: routes,
      register(route) {
        if (routes.has(route.path)) throw new Error('webserver: duplicate prefix route');
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    logger: { warn() {} },
  };
  const runtime = makeRuntime([project]);
  const route = registerGraphWeb(ctx, runtime, { watchdogMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(routes.has(API_PREFIX), true);
  // Снятие спустя много тиков: два прежних one-shot таймера такое уже не ловили.
  routes.delete(API_PREFIX);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(routes.has(API_PREFIX), true);
  assert.equal(routes.get(API_PREFIX).handler, route.handler);
});

await test('только чтение и только локально', async () => {
  const handler = createWebHandler(makeRuntime([project]));
  const post = await call(handler, API_PREFIX + '/api/status', { method: 'POST' });
  assert.equal(post.status, 405);
  const remote = await call(handler, API_PREFIX + '/api/status', { remote: '10.0.0.5' });
  assert.equal(remote.status, 403);
});

await test('неизвестный маршрут — 404, без корня — 400', async () => {
  const handler = createWebHandler(makeRuntime([project]));
  const missing = await call(handler, API_PREFIX + '/api/nope');
  assert.equal(missing.status, 404);
  const noRoots = createWebHandler(createGraphRuntime({}, {}));
  const refused = await call(noRoots, API_PREFIX + '/api/graph');
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /roots/);
  assert.match(refused.body.fix, /roots/);
});

await test('каждая ошибка и предупреждение несут рецепт «что сделать»', async () => {
  const messy = makeProject({
    'a.json': { version: 1, nodes: [{ id: 'a', model: 'ghost' }, { id: 'b' }] },
  });
  const payload = readGraph(makeRuntime([messy]), messy);
  assert.ok(payload.errors.length >= 1);
  assert.ok(payload.warnings.length >= 1);
  for (const item of payload.errors.concat(payload.warnings)) {
    assert.equal(typeof item.fix, 'string', item.code + ' без fix');
    assert.ok(item.fix.length > 10, item.code + ' fix слишком короткий');
  }
});

await test('ошибки валидатора доходят до панели как коды', async () => {
  const broken = makeProject({
    'a.json': { version: 1, nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', kind: 'delegate' }, { from: 'b', to: 'a', kind: 'delegate' }] },
  });
  const handler = createWebHandler(makeRuntime([broken]));
  const res = await call(handler, API_PREFIX + '/api/graph');
  assert.equal(res.status, 200);
  assert.ok(res.body.errors.some((item) => item.code === 'delegate-cycle'));
  assert.ok(res.body.layout.cyclic.length >= 1);
});

await test('readGraph и selectRoot согласованы между собой', async () => {
  const runtime = makeRuntime([project]);
  const selection = selectRoot(runtime, null);
  assert.equal(selection.error, null);
  const payload = readGraph(runtime, selection.root);
  assert.equal(payload.summary.nodes, 4, '3 объявленных + координатор чтения (0175)');
  assert.deepEqual(payload.errors, []);
  // Только review и peer: это законная одноранговая структура, без предупреждений.
  assert.deepEqual(payload.warnings.map((item) => item.code), []);
  assert.equal(payload.exists, true);
});

await test('два фрагмента в папке складываются в одну структуру', async () => {
  const split = makeProject({
    '10-models.json': { version: 1, models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } } },
    '20-people.json': { version: 1, nodes: [{ id: 'a', role: 'analyst', model: 'ds' }, { id: 'b', role: 'critic', model: 'ds' }], edges: [{ from: 'a', to: 'b', kind: 'review' }] },
  });
  const payload = readGraph(makeRuntime([split]), split);
  assert.deepEqual(payload.errors, []);
  assert.equal(payload.sources.length, 2);
  assert.equal(payload.summary.nodes, 3, 'два объявленных + координатор чтения (0175)');
});

await test('POST /api/layout пишет x/y и сохраняет остальные поля узла', async () => {
  const dir = makeProject({ 'graph.json': JSON.parse(JSON.stringify(GRAPH)) });
  const runtime = makeRuntime([dir]);
  const handler = createWebHandler(runtime);
  const res = await call(handler, API_PREFIX + '/api/layout', {
    method: 'POST',
    body: JSON.stringify({ root: dir, positions: { critic: { x: 88, y: 132 }, 'analyst-a': { x: 0, y: 0 } } }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.reset, false);
  assert.equal(res.body.positions, 2);
  assert.deepEqual(res.body.files, ['structure/graph.json']);

  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'structure', 'graph.json'), 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.edges.length, 3, 'связи не трогаются');
  const critic = parsed.nodes.find((node) => node.id === 'critic');
  assert.equal(critic.x, 88);
  assert.equal(critic.y, 132);
  assert.equal(critic.role, 'acceptor', 'роль остаётся');
  assert.equal(critic.model, 'glm', 'модель остаётся');
  assert.deepEqual(critic.mustDifferFrom, ['analyst-a'], 'остальные поля остаются');
  const analyst = parsed.nodes.find((node) => node.id === 'analyst-a');
  assert.equal(analyst.x, 0, 'нулевая координата записывается');
  assert.equal(analyst.y, 0);
  assert.equal(parsed.nodes.find((node) => node.id === 'analyst-b').x, undefined, 'нетронутый узел без координат');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'structure')), ['graph.json'], 'временных файлов не осталось');

  const payload = readGraph(runtime, dir);
  assert.deepEqual(payload.graph.nodes.find((node) => node.id === 'critic').position, { x: 88, y: 132 });
  const graphRoute = await call(handler, API_PREFIX + '/api/graph?root=' + encodeURIComponent(dir));
  assert.deepEqual(graphRoute.body.graph.nodes.find((node) => node.id === 'critic').position, { x: 88, y: 132 });
  assert.equal(graphRoute.body.layout.nodes.find((node) => node.id === 'critic').x, 88, 'раскладка рисует по позиции');
});

await test('POST /api/layout reset убирает x/y и не трогает объявление', async () => {
  const dir = makeProject({ 'graph.json': JSON.parse(JSON.stringify(GRAPH)) });
  const runtime = makeRuntime([dir]);
  const handler = createWebHandler(runtime);
  await call(handler, API_PREFIX + '/api/layout', {
    method: 'POST',
    body: JSON.stringify({ root: dir, positions: { critic: { x: 88, y: 132 } } }),
  });
  const res = await call(handler, API_PREFIX + '/api/layout', {
    method: 'POST',
    body: JSON.stringify({ root: dir, reset: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.reset, true);
  assert.equal(res.body.cleared, 1, 'сброс считает очищенные узлы');
  assert.deepEqual(res.body.files, ['structure/graph.json']);

  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'structure', 'graph.json'), 'utf8'));
  for (const node of parsed.nodes) {
    assert.equal(node.x, undefined, 'x должен исчезнуть у ' + node.id);
    assert.equal(node.y, undefined, 'y должен исчезнуть у ' + node.id);
  }
  assert.equal(parsed.nodes.find((node) => node.id === 'critic').role, 'acceptor', 'объявление не тронуто');
  assert.equal(parsed.edges.length, 3);
  assert.equal(readGraph(runtime, dir).graph.nodes.find((node) => node.id === 'critic').position, undefined);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'structure')), ['graph.json'], 'временных файлов не осталось');
});

await test('POST /api/layout отказывает: чужой узел, дробь, отрицательное, пустой запрос', async () => {
  const dir = makeProject({ 'graph.json': JSON.parse(JSON.stringify(GRAPH)) });
  const runtime = makeRuntime([dir]);
  const handler = createWebHandler(runtime);
  const file = path.join(dir, 'structure', 'graph.json');
  const before = fs.readFileSync(file, 'utf8');
  const cases = [
    { body: { root: dir, positions: { ghost: { x: 1, y: 1 } } }, status: 404, fix: /существующих/ },
    { body: { root: dir, positions: { critic: { x: 1.5, y: 2 } } }, status: 400, fix: /Пиксели/ },
    { body: { root: dir, positions: { critic: { x: -2, y: 2 } } }, status: 400, fix: /Пиксели/ },
    { body: { root: dir, positions: { critic: { x: '3', y: 4 } } }, status: 400, fix: /Пиксели/ },
    { body: { root: dir, positions: { critic: null } }, status: 400, fix: /240/ },
    { body: { root: dir, positions: [] }, status: 400, fix: /positions/ },
    { body: { root: dir, positions: {} }, status: 400, fix: /positions/ },
    { body: { root: dir }, status: 400, fix: /positions/ },
    { body: { root: dir, reset: 'yes' }, status: 400, fix: /true/ },
    { body: { root: dir, positions: { critic: { x: 1, y: 1 } }, reset: true }, status: 400, fix: /либо/ },
    { body: { root: path.join(dir, '..'), positions: { critic: { x: 1, y: 1 } } }, status: 400, fix: /только в свой проект/ },
  ];
  for (const item of cases) {
    const res = await call(handler, API_PREFIX + '/api/layout', { method: 'POST', body: JSON.stringify(item.body) });
    assert.equal(res.status, item.status, JSON.stringify(item.body) + ' -> ' + JSON.stringify(res.body));
    assert.equal(typeof res.body.fix, 'string', 'отказ без рецепта: ' + JSON.stringify(item.body));
    if (item.fix) assert.match(res.body.fix, item.fix);
  }
  const broken = await call(handler, API_PREFIX + '/api/layout', { method: 'POST', body: '{ not json' });
  assert.equal(broken.status, 400);
  assert.match(broken.body.fix, /кавычки/);
  const remote = await call(handler, API_PREFIX + '/api/layout', {
    method: 'POST',
    remote: '10.0.0.5',
    body: JSON.stringify({ root: dir, positions: { critic: { x: 1, y: 1 } } }),
  });
  assert.equal(remote.status, 403, 'раскладка пишется только локально');
  const wrongMethod = await call(handler, API_PREFIX + '/api/layout');
  assert.equal(wrongMethod.status, 404, 'GET раскладку не отдаёт');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'ни один отказ не пишет файл');
});

await test('POST /api/layout пишет x/y туда, где объявлен узел, и сбрасывает во всех фрагментах', async () => {
  const split = makeProject({
    '10-models.json': { version: 1, models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } } },
    '20-teams.json': {
      version: 1,
      nodes: [{ id: 'a', role: 'analyst', model: 'ds' }, { id: 'b', role: 'critic', model: 'ds' }],
      edges: [{ from: 'a', to: 'b', kind: 'review' }],
    },
  });
  const runtime = makeRuntime([split]);
  const handler = createWebHandler(runtime);
  const modelsFile = path.join(split, 'structure', '10-models.json');
  const teamsFile = path.join(split, 'structure', '20-teams.json');
  const modelsBefore = fs.readFileSync(modelsFile, 'utf8');

  const saved = await call(handler, API_PREFIX + '/api/layout', {
    method: 'POST',
    body: JSON.stringify({ root: split, positions: { a: { x: 240, y: 40 } } }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.files, ['structure/20-teams.json'], 'координата идёт к объявлению узла');
  assert.equal(fs.readFileSync(modelsFile, 'utf8'), modelsBefore, 'чужой фрагмент не тронут');
  const teams = JSON.parse(fs.readFileSync(teamsFile, 'utf8'));
  assert.equal(teams.nodes.find((node) => node.id === 'a').x, 240);
  assert.equal(teams.nodes.find((node) => node.id === 'a').y, 40);
  assert.equal(teams.nodes.find((node) => node.id === 'b').x, undefined);

  const reset = await call(handler, API_PREFIX + '/api/layout', {
    method: 'POST',
    body: JSON.stringify({ root: split, reset: true }),
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body.files, ['structure/20-teams.json']);
  assert.equal(reset.body.cleared, 1);
  const cleared = JSON.parse(fs.readFileSync(teamsFile, 'utf8'));
  assert.equal(cleared.nodes.find((node) => node.id === 'a').x, undefined);
  assert.equal(cleared.nodes.find((node) => node.id === 'a').role, 'analyst');
});

await test('битая позиция в файле — ошибка invalid-position с рецептом', async () => {
  const broken = makeProject({
    'graph.json': {
      version: 1,
      models: { m: { provider: 'p', model: 'q' } },
      nodes: [{ id: 'a', role: 'lead', model: 'm', x: 12 }],
      edges: [],
    },
  });
  const payload = readGraph(makeRuntime([broken]), broken);
  const error = payload.errors.find((item) => item.code === 'invalid-position');
  assert.ok(error, 'нет ошибки invalid-position');
  assert.match(error.message, /x и y/);
  assert.equal(typeof error.fix, 'string');
  assert.ok(error.fix.length > 10);
});

await test('GET /api/live отдаёт живых агентов только этого корня', async () => {
  const foreign = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([project], {}, {
    getAgents: () => [
      { id: 'live-1', cwd: project, label: 'acceptor:critic', state: 'running' },
      { id: 'live-foreign', cwd: foreign, label: 'critic', state: 'running' },
      { id: 'live-anon', cwd: project, title: 'безымянный агент', state: 'running' },
    ],
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(project));
  assert.equal(res.status, 200);
  assert.equal(res.body.root, project);
  assert.equal(res.body.label, path.basename(project));
  assert.deepEqual(res.body.active, ['critic'], 'живой агент узла critic');
  assert.deepEqual(res.body.unknown, ['live-anon'], 'агент без роли честно в unknown');
  assert.deepEqual(res.body.agents.map((agent) => agent.id), ['live-1', 'live-anon'],
    'агент чужого корня не попадает в ответ');
  assert.equal(res.body.agents[0].node, 'critic');
  assert.equal(res.body.agents[1].node, null);
  assert.equal(res.body.activityByNode.critic, 'agent', 'источник активности — живой агент');
});

await test('GET /api/live понимает службу агентов с list()', async () => {
  const runtime = makeRuntime([project], {}, {
    getAgents: async () => ({
      list: async () => [{ id: 'svc-1', cwd: path.join(project, 'work'), title: 'analyst-a', state: 'running' }],
    }),
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(project));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.active, ['analyst-a']);
  assert.equal(res.body.agents[0].id, 'svc-1');
});

await test('GET /api/live без службы отвечает 200 с рецептом, а не 500', async () => {
  const res = await call(createWebHandler(makeRuntime([project])), API_PREFIX + '/api/live?root=' + encodeURIComponent(project));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.agents, []);
  assert.deepEqual(res.body.active, []);
  assert.deepEqual(res.body.unknown, []);
  assert.match(res.body.reason, /ctx\.agents/, 'причина называет отсутствующую службу');
  assert.match(res.body.reason, /сессиям/i, 'причина говорит, что активность видна по сессиям');
  assert.equal(typeof res.body.total, 'number', 'диагностика: сколько строк пришло');
  assert.ok(res.body.sessions && typeof res.body.sessions.running === 'number');
  assert.equal(typeof res.body.fix, 'string');
  assert.ok(res.body.fix.length > 10);
});

await test('GET /api/live переживает исключение службы агентов', async () => {
  const runtime = makeRuntime([project], {}, {
    getAgents: () => { throw new Error('служба упала'); },
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(project));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.agents, []);
  assert.match(res.body.reason, /недоступна/);
});

await test('GET /api/live отказывает корню вне списка', async () => {
  const handler = createWebHandler(makeRuntime([project]));
  const res = await call(handler, API_PREFIX + '/api/live?root=' + encodeURIComponent(path.resolve(project, '..')));
  assert.equal(res.status, 400);
  assert.match(res.body.fix, /root/);
});

await test('GET /api/live без единого корня объясняет, что делать', async () => {
  const handler = createWebHandler(createGraphRuntime({}, {}));
  const res = await call(handler, API_PREFIX + '/api/live');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /корн/i);
});

/*
 * Задание 0044: привязка сессии к узлу — проекция, а не запись в структуру.
 * Маршрут читает сессии с диска и пины из файла профиля; битый файл пинов —
 * пустой список с причиной, а не исключение. Фикстура сессий лежит во временном
 * каталоге, structure проекта не трогается.
 */
function bindingProject() {
  return makeProject({
    'graph.json': {
      version: 1,
      models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [
        { id: 'coordinator', role: 'координатор', model: 'work' },
        { id: 'worker', role: 'исполнитель', model: 'work' },
      ],
      edges: [],
      folders: [{ id: 'folder-1', orchestrator: 'coordinator' }],
    },
  });
}

/** Journals of this workspace with exact ages, filed under the parent key the host uses. */
function sessionAges(dir, rows) {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sessions-0056-'));
  const marker = '--' + path.resolve(dir).toLowerCase().replace(/:/gu, '').replace(/[\\/]/gu, '-') + '--';
  const now = Date.now();
  for (const [id, age] of rows) {
    const folder = path.join(sessions, marker, id);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, 'not-a-journal');
    fs.utimesSync(file, new Date(now - age), new Date(now - age));
  }
  return sessions;
}

/** Two journals of this workspace, filed under the parent key the host uses. */
function sessionFixture(dir) {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sessions-bind-'));
  const marker = '--' + path.resolve(dir).toLowerCase().replace(/:/gu, '').replace(/\\/gu, '-').replace(/\//gu, '-') + '--';
  const now = Date.now();
  for (const [id, age] of [['session-fresh', 60000], ['session-old', 3600000]]) {
    const folder = path.join(sessions, marker, id);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, new Date(now - age), new Date(now - age));
  }
  return sessions;
}

await test('GET /api/live: binding — свежая сессия на оркестраторе, пины читаются', async () => {
  const dir = bindingProject();
  const sessions = sessionFixture(dir);
  const pinsFile = path.join(sessions, 'session-pins.json');
  fs.writeFileSync(pinsFile, JSON.stringify({ [dir]: { node: 'worker', session: 'session-old' } }));
  const runtime = createGraphRuntime({ roots: [dir] }, { getAgents: () => [] });
  runtime.sessionsDir = sessions;
  runtime.pinsFile = pinsFile;
  const handler = createWebHandler(runtime);
  const pinned = await call(handler, API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(pinned.status, 200);
  assert.ok(pinned.body.binding, 'привязка есть даже при пустой службе агентов');
  assert.equal(pinned.body.binding.source, 'pin');
  assert.equal(pinned.body.binding.node, 'worker');
  assert.equal(pinned.body.binding.session, 'session-old');
  assert.deepEqual(pinned.body.pins, { file: pinsFile, count: 1 });
  assert.ok(pinned.body.sessions.items.length >= 2, 'прежнее поле sessions не тронуто');

  /* Без файла пинов действует авто: свежайшая сессия на оркестраторе. */
  runtime.pinsFile = path.join(sessions, 'no-pins-here.json');
  const automatic = await call(handler, API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(automatic.body.binding.source, 'auto');
  assert.equal(automatic.body.binding.node, 'coordinator');
  assert.equal(automatic.body.binding.session, 'session-fresh');
  assert.deepEqual(automatic.body.pins, { file: runtime.pinsFile, count: 0 },
    'отсутствующий файл — пустые пины без ошибки');
});

await test('GET /api/live: битый файл пинов — пусто и причина, привязка всё равно считается', async () => {
  const dir = bindingProject();
  const sessions = sessionFixture(dir);
  const pinsFile = path.join(sessions, 'broken-pins.json');
  fs.writeFileSync(pinsFile, '{ это не JSON');
  const runtime = createGraphRuntime({ roots: [dir] }, { getAgents: () => [] });
  runtime.sessionsDir = sessions;
  runtime.pinsFile = pinsFile;
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200, 'битый файл пинов не ломает маршрут');
  assert.equal(res.body.pins.count, 0, 'пины пусты');
  assert.match(res.body.pins.error, /пинов/);
  assert.equal(res.body.binding.source, 'auto');
});

await test('GET /api/live без службы агентов: binding считается по сессиям, причина службы остаётся', async () => {
  const dir = bindingProject();
  const sessions = sessionFixture(dir);
  const runtime = createGraphRuntime({ roots: [dir] }, {});
  runtime.sessionsDir = sessions;
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200);
  assert.match(res.body.reason, /ctx\.agents/, 'причина отсутствия службы сохранена');
  assert.equal(res.body.binding.source, 'auto');
  assert.equal(res.body.binding.session, 'session-fresh');
  assert.deepEqual(res.body.active, ['coordinator'], 'без службы агентов активность видна по журналу сессии');
  assert.deepEqual(res.body.activityByNode, { coordinator: 'session' }, 'источник назван честно');
  assert.deepEqual(res.body.unknown, [], 'журнал не притворяется агентом без роли');
  assert.ok(res.body.pins && res.body.sessions, 'прежние поля ответа на месте');
});

await test('GET /api/live: свежая сессия подсвечивает узел, источник — session (задание 0056)', async () => {
  const dir = bindingProject();
  const sessions = sessionAges(dir, [['session-fresh', 20 * 1000]]);
  const runtime = createGraphRuntime({ roots: [dir] }, { getAgents: () => ({ list: () => [] }) });
  runtime.sessionsDir = sessions;
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200);
  assert.equal(res.body.binding.source, 'auto');
  assert.equal(res.body.binding.node, 'coordinator');
  assert.equal(res.body.binding.session, 'session-fresh');
  assert.deepEqual(res.body.active, ['coordinator'], 'узел привязки активен по журналу');
  assert.deepEqual(res.body.activityByNode, { coordinator: 'session' });
  assert.equal(res.body.reason, undefined, 'служба агентов доступна — причины отказа нет');
});

await test('GET /api/live: старый журнал узел не подсвечивает (порог свежести, задание 0056)', async () => {
  const dir = bindingProject();
  const sessions = sessionAges(dir, [['session-stale', 30 * 60 * 1000]]);
  const runtime = createGraphRuntime({ roots: [dir] }, { getAgents: () => ({ list: () => [] }) });
  runtime.sessionsDir = sessions;
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200);
  assert.equal(res.body.binding.session, 'session-stale', 'привязка может остаться');
  assert.deepEqual(res.body.active, [], 'старая сессия узла не подсвечивает');
  assert.deepEqual(res.body.activityByNode, {});
});

/*
 * Задание 0089. Маршрут отдаёт привязку КАЖДОЙ работающей сессии и список
 * непривязанных; привязка узла через POST /api/session (node.session) меняет
 * источник на pin и убирает сессию из «вне структуры». Раньше панель считала
 * все sessions.running агентами без роли — на живом хосте это дало «2».
 */
await test('GET /api/live: сессия получает узел и источник, непривязанная — в unattributed (задание 0089)', async () => {
  const dir = bindingProject();
  const sessions = sessionAges(dir, [['session-bound', 20 * 1000], ['session-other', 10 * 1000]]);
  const runtime = createGraphRuntime({ roots: [dir] }, { getAgents: () => [] });
  runtime.sessionsDir = sessions;
  runtime.pinsFile = path.join(sessions, 'no-pins.json');
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200);
  const items = res.body.sessions.items;
  assert.equal(items.length, 2, 'обе работающие сессии в списке');
  for (const row of items) {
    assert.ok(Object.hasOwn(row, 'source'), 'у каждой сессии назван источник привязки: ' + JSON.stringify(row));
  }
  const bound = items.find((row) => row && row.id === 'session-other');
  assert.equal(bound.node, 'coordinator', 'свежайшая сессия — узел привязки');
  assert.equal(bound.source, 'binding', 'источник — проекция привязки');
  const other = items.find((row) => row.id === 'session-bound');
  assert.equal(other.node, null, 'без источника узла нет');
  assert.equal(other.source, null);
  assert.deepEqual(res.body.unattributed.map((row) => row.id), ['session-bound'],
    'вне структуры — только сессия без узла');
  assert.equal(res.body.unattributed[0].label, '', 'метки нет — пустая строка, а не выдуманная роль');
  /* Прежние поля ответа на месте. */
  assert.ok(res.body.sessions.running >= 1, 'sessions.running сохранён');
  assert.ok(Array.isArray(res.body.unknown) && Array.isArray(res.body.active), 'active и unknown сохранены');
  assert.ok(res.body.binding && res.body.activityByNode, 'binding и activityByNode сохранены');
});

await test('POST /api/session: node.session делает привязку источником pin и убирает сессию из unattributed', async () => {
  const dir = bindingProject();
  const sessions = sessionAges(dir, [['session-bound', 20 * 1000], ['session-other', 10 * 1000]]);
  const runtime = createGraphRuntime({ roots: [dir] }, { getAgents: () => [] });
  runtime.sessionsDir = sessions;
  runtime.pinsFile = path.join(sessions, 'no-pins.json');
  const handler = createWebHandler(runtime);
  const before = await call(handler, API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.deepEqual(before.body.unattributed.map((row) => row.id), ['session-bound']);

  const post = await call(handler, API_PREFIX + '/api/session', {
    method: 'POST',
    body: JSON.stringify({ root: dir, node: 'worker', session: 'session-bound' }),
  });
  assert.equal(post.status, 200, JSON.stringify(post.body));

  const after = await call(handler, API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(after.body.binding.source, 'pin', 'node.session — пин, а не авто');
  assert.equal(after.body.binding.node, 'worker');
  assert.equal(after.body.binding.session, 'session-bound');
  const pinned = after.body.sessions.items.find((row) => row && row.id === 'session-bound');
  assert.equal(pinned.node, 'worker', 'сессия привязана к узлу в живой проекции');
  assert.equal(pinned.source, 'binding');
  /* Пин перевесил авто: прежняя автоматическая сессия теперь без узла. */
  assert.deepEqual(after.body.unattributed.map((row) => row.id), ['session-other'],
    'привязанная сессия больше не вне структуры, а прежняя авто-сессия — да');
});

await test('GET /api/live без службы агентов тоже отдаёт unattributed (задание 0089)', async () => {
  const dir = bindingProject();
  const sessions = sessionAges(dir, [['session-bound', 20 * 1000], ['session-other', 10 * 1000]]);
  const runtime = createGraphRuntime({ roots: [dir] }, {});
  runtime.sessionsDir = sessions;
  runtime.pinsFile = path.join(sessions, 'no-pins.json');
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200);
  assert.match(res.body.reason, /ctx\.agents/, 'причина отсутствия службы сохранена');
  assert.ok(Array.isArray(res.body.unattributed), 'обе ветки ответа содержат unattributed');
  assert.deepEqual(res.body.unattributed.map((row) => row.id), ['session-bound']);
});

/*
 * Задание 0059: работающий узел берётся из журнала запусков. Записи пишутся
 * штатным noteRun во временный runtime.runsDir, поэтому реальный
 * ~/.dsh/project-graph/runs тесты не читают и не меняют.
 */
function runActivityRuntime(dir, records, deps = {}) {
  const runtime = createGraphRuntime({ roots: [dir] }, deps);
  runtime.sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sessions-0059-'));
  runtime.runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-runs-0059-'));
  for (const record of records) noteRun(runtime, { root: dir, ...record });
  return runtime;
}

await test('GET /api/live: запись запуска running подсвечивает работающий узел, источник — run (задание 0059)', async () => {
  const dir = bindingProject();
  const runtime = runActivityRuntime(dir, [
    { node: 'worker', state: 'running', since: Date.now() - 60 * 1000 },
  ], { getAgents: () => ({ list: () => [] }) });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200);
  assert.ok(res.body.active.includes('worker'), 'работающий узел подсвечен: ' + JSON.stringify(res.body.active));
  assert.equal(res.body.activityByNode.worker, 'run', 'источник активности — журнал запусков');
  assert.equal(res.body.reason, undefined, 'служба агентов доступна — причины отказа нет');
});

await test('GET /api/live: завершённый запуск и узел вне графа активность не создают (задание 0059)', async () => {
  const dir = bindingProject();
  const runtime = runActivityRuntime(dir, [
    { node: 'worker', state: 'done', since: Date.now() - 120 * 1000, finishedAt: Date.now() - 60 * 1000 },
    { node: 'ghost', state: 'running', since: Date.now() - 60 * 1000 },
  ], { getAgents: () => ({ list: () => [] }) });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.active, [], 'ни завершённый запуск, ни узел вне графа не подсвечены');
  assert.deepEqual(res.body.activityByNode, {});
});

await test('GET /api/live без службы агентов: запуск всё равно даёт active и activityByNode.run (задание 0059)', async () => {
  const dir = bindingProject();
  const runtime = runActivityRuntime(dir, [
    { node: 'worker', state: 'running', since: Date.now() - 60 * 1000 },
  ]);
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200);
  assert.match(res.body.reason, /запуск/i, 'причина службы называет журнал запусков');
  assert.ok(res.body.active.includes('worker'), 'без службы агентов узел подсвечен по запуску');
  assert.equal(res.body.activityByNode.worker, 'run');
});

await test('GET /api/live: живой агент сильнее записи запуска (задание 0059)', async () => {
  const dir = bindingProject();
  const runtime = runActivityRuntime(dir, [
    { node: 'coordinator', state: 'running', since: Date.now() - 60 * 1000 },
  ], {
    getAgents: () => [{ id: 'live-worker', cwd: dir, label: 'worker', state: 'running' }],
  });
  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/live?root=' + encodeURIComponent(dir));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.active, ['worker', 'coordinator'], 'оба источника названы, агент первым');
  assert.deepEqual(res.body.activityByNode, { worker: 'agent', coordinator: 'run' },
    'приоритет источников: agent > run');
});

/*
 * Папка обмена — механизм панели, а не запись руками: POST /api/folder создаёт
 * запись в folders и контракт Rev 1 в ящике, правит её, удаляет и поднимает
 * ревизию контракта. Узлы при этом не меняются.
 */
function folderProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-folder-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [
      { id: 'coordinator', role: 'координатор', model: 'work' },
      { id: 'worker', role: 'исполнитель', model: 'work' },
    ],
    edges: [{ from: 'coordinator', to: 'worker', kind: 'delegate' }],
    folders: [],
  }, null, 2));
  return root;
}

/*
 * Задание 0024: участник папки — метка реестра воркспейсов. В тестах реестр —
 * карта participants профиля: structure (свой корень), workflow и school.
 * Сервер сверяет метку с этим реестром и пишет пути рядом с метками.
 */
function folderRuntime(root) {
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-ws-'));
  return createGraphRuntime({
    roots: [root],
    participants: { structure: root, workflow: sibling, school: path.join(sibling, 'school') },
    me: 'structure',
  });
}

function folderDeclaration(over = {}) {
  /* Задание 0018: новая папка threads не объявляет — поля «Ветки» нет в редакторе. */
  return {
    id: 'folder-1',
    box: { path: 'coordination', root: 'workspace' },
    exchange: { contract: 'contract.md' },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    ...over,
  };
}

async function folderCall(handler, action, body) {
  return call(handler, API_PREFIX + '/api/folder?action=' + action, { method: 'POST', body: JSON.stringify(body) });
}

function folderGraph(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
}

await test('папка создаётся: запись в folders, контракт Rev 1, узлы не тронуты', async () => {
  const root = folderProject();
  const before = folderGraph(root);
  const handler = createWebHandler(folderRuntime(root));
  const res = await folderCall(handler, 'add', { root, folder: folderDeclaration() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.contract.rev, 1);
  assert.equal(res.body.folder.id, 'folder-1');
  assert.deepEqual(res.body.folder.box, { path: 'coordination', root: 'workspace' });
  assert.deepEqual(res.body.folder.participants, ['structure', 'workflow']);
  assert.equal(res.body.folder.orchestrator, 'coordinator');
  assert.deepEqual(res.body.folder.exchange, { contract: 'contract.md' },
    'папка создаётся без threads: поле убрано из редактора');

  const after = folderGraph(root);
  assert.deepEqual(after.nodes, before.nodes, 'узлы не меняются: папка — не узел');
  assert.deepEqual(after.edges, before.edges, 'связи не меняются');
  assert.deepEqual(after.folders.map((folder) => folder.id), ['folder-1']);
  assert.equal(after.folders[0].exchange.threads, undefined, 'в graph.json у новой папки нет threads');

  const file = path.join(root, 'coordination', 'contract.md');
  assert.equal(res.body.contract.file, file);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^Format: dsh-exchange\/1-contract$/m);
  assert.match(text, /^Rev: 1$/m);
  assert.match(text, /^Initiator: structure$/m, 'инициатор — метка своего воркспейса');
  assert.match(text, /^Invited: workflow$/m, 'в приглашённых — все, кроме инициатора');
  assert.match(text, /^Created: \d{4}-\d{2}-\d{2}T/m);
  assert.match(text, /^Portal: .+coordination$/m);
});

await test('папка без участников — 400 с рецептом', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  const res = await folderCall(handler, 'add', { root, folder: folderDeclaration({ participants: [] }) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /участник/);
  assert.match(res.body.fix, /participants/);
  assert.deepEqual(folderGraph(root).folders, [], 'отказ ничего не записал');
  assert.ok(!fs.existsSync(path.join(root, 'coordination')), 'ящик не создан');
});

await test('чужой оркестратор — 400 с рецептом и списком узлов', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  const res = await folderCall(handler, 'add', { root, folder: folderDeclaration({ orchestrator: 'nobody' }) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /nobody/);
  assert.match(res.body.fix, /coordinator/);
  assert.deepEqual(folderGraph(root).folders, []);
});

await test('box.path с «..» или абсолютный — 400 с рецептом', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  for (const boxPath of ['../outside', 'C:/windows', '/etc']) {
    const res = await folderCall(handler, 'add', { root, folder: folderDeclaration({ box: { path: boxPath, root: 'workspace' } }) });
    assert.equal(res.status, 400, boxPath);
    assert.match(res.body.fix, /относительн/);
  }
  assert.deepEqual(folderGraph(root).folders, []);
});

await test('update заменяет запись папки и не переписывает контракт', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  const created = await folderCall(handler, 'add', { root, folder: folderDeclaration() });
  assert.equal(created.status, 200);
  const file = path.join(root, 'coordination', 'contract.md');
  const before = fs.readFileSync(file, 'utf8');

  const res = await folderCall(handler, 'update', {
    root,
    folder: folderDeclaration({ participants: ['structure', 'workflow', 'school'], exchange: { threads: ['daily', 'critic-report'] } }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const folder = folderGraph(root).folders[0];
  assert.deepEqual(folder.participants, ['structure', 'workflow', 'school']);
  assert.deepEqual(folder.exchange.threads, ['daily', 'critic-report'], 'threads берутся из тела');
  assert.equal(folder.exchange.contract, 'contract.md', 'поле exchange, которого нет в теле, наследуется');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'контракт не переписан: ревизия поднимается отдельным действием');
});

/*
 * R1 задания 0018: «Сохранить» старой папки телом без threads не стирает
 * объявленные ветки — квитанция по-прежнему идёт в них, а не в critic-report.
 */
await test('update папки телом без threads сохраняет объявленные ветки старых папок', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  const created = await folderCall(handler, 'add', {
    root,
    folder: folderDeclaration({ exchange: { threads: ['audit'], contract: 'contract.md' } }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  /* Панель после задания 0018 шлёт exchange { contract } — без threads. */
  const res = await folderCall(handler, 'update', { root, folder: folderDeclaration() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const kept = folderGraph(root).folders[0].exchange;
  assert.deepEqual(kept.threads, ['audit'], '«Сохранить» не стёрло объявленные ветки');
  assert.equal(kept.contract, 'contract.md', 'contract тоже уцелел');

  const accepted = await folderCall(handler, 'accept', {
    root,
    id: 'folder-1',
    session: 'session-33333333-4444-5555-6666-777777777777',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.match(accepted.body.receipt, /^threads\/audit\/.+\.md$/u,
    'после «Сохранить» квитанция идёт в объявленную ветку');
});

/*
 * Задание 0191: дедлок папок. Структура с папкой без orchestrator невалидна, и
 * прежний saveFolder отклонял ЛЮБОЕ действие — включая правку этой самой папки,
 * которая ошибку и устраняет. Теперь действие применяется к копии структуры и
 * проверяется РЕЗУЛЬТАТ: правка проходит, а результат, оставшийся невалидным,
 * по-прежнему отклоняется 409 (fail-closed сохранён).
 */
function folderGraphWith(folders) {
  const root = folderProject();
  const document = folderGraph(root);
  document.folders = folders;
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(document, null, 2) + '\n');
  return root;
}

/* Папка, которую проверка структуры считает невалидной: orchestrator не задан. */
function brokenFolder(id = 'folder-1', over = {}) {
  return {
    id,
    box: { path: 'coordination', root: 'workspace' },
    exchange: { contract: 'contract.md' },
    participants: ['structure', 'workflow'],
    ...over,
  };
}

await test('0191: update чинит невалидную папку — orchestrator записан, структура валидна', async () => {
  const root = folderGraphWith([brokenFolder()]);
  const handler = createWebHandler(folderRuntime(root));
  const res = await folderCall(handler, 'update', { root, folder: folderDeclaration() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.folder.orchestrator, 'coordinator', 'ответ несёт записанное поле');
  assert.equal(folderGraph(root).folders[0].orchestrator, 'coordinator',
    'поле записано в structure/graph.json, а не только в ответе');

  const graph = await call(handler, API_PREFIX + '/api/graph?root=' + encodeURIComponent(root));
  assert.equal(graph.status, 200, JSON.stringify(graph.body));
  assert.deepEqual(graph.body.errors, [], 'после правки структура проходит проверку');
});

await test('0191: add при остающейся невалидной папке — 409, файл и ящик не тронуты', async () => {
  const root = folderGraphWith([brokenFolder()]);
  const file = path.join(root, 'structure', 'graph.json');
  const before = fs.readFileSync(file, 'utf8');
  const handler = createWebHandler(folderRuntime(root));
  const res = await folderCall(handler, 'add', {
    root,
    folder: folderDeclaration({ id: 'folder-2', exchange: { contract: 'contract-folder-2.md' } }),
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /недействительна/u);
  assert.match(res.body.error, /folder-1/u, 'отказ называет виноватую папку');
  assert.ok(res.body.fix && res.body.fix.length > 10, 'отказ несёт рецепт');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'отказ ничего не записал');
  assert.ok(!fs.existsSync(path.join(root, 'coordination')), 'ящик не создан');
});

await test('0191: update, после которого структура остаётся невалидной, — 409 без записи', async () => {
  const root = folderGraphWith([
    brokenFolder('folder-1', { orchestrator: 'coordinator' }),
    brokenFolder('folder-2'),
  ]);
  const file = path.join(root, 'structure', 'graph.json');
  const before = fs.readFileSync(file, 'utf8');
  const handler = createWebHandler(folderRuntime(root));
  const res = await folderCall(handler, 'update', {
    root,
    folder: folderDeclaration({ id: 'folder-1', participants: ['structure', 'school'] }),
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /folder-2/u, 'отказ называет папку, которую правка не починила');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'отказ ничего не записал');
});

await test('0191: add при битом JSON файла папки — 409, а не 500, файл не тронут', async () => {
  const root = folderProject();
  const file = path.join(root, 'structure', 'graph.json');
  fs.writeFileSync(file, '{ not json\n');
  const handler = createWebHandler(folderRuntime(root));
  const res = await folderCall(handler, 'add', { root, folder: folderDeclaration({ id: 'folder-2' }) });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /не разбирается как JSON/u);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json\n', 'отказ ничего не записал');
});

await test('contract поднимает Rev до 2, инициатор сохранён, Invited из participants', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  await folderCall(handler, 'add', { root, folder: folderDeclaration() });
  await folderCall(handler, 'update', {
    root,
    folder: folderDeclaration({ participants: ['structure', 'workflow', 'school'] }),
  });

  const res = await folderCall(handler, 'contract', { root, id: 'folder-1' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.contract.rev, 2);
  const text = fs.readFileSync(path.join(root, 'coordination', 'contract.md'), 'utf8');
  assert.match(text, /^Rev: 2$/m);
  assert.match(text, /^Initiator: structure$/m);
  assert.match(text, /^Invited: workflow, school$/m);
});

await test('remove удаляет запись; неизвестный id — 404 с рецептом', async () => {
  const root = folderProject();
  const before = folderGraph(root);
  const handler = createWebHandler(folderRuntime(root));
  await folderCall(handler, 'add', { root, folder: folderDeclaration() });

  const removed = await folderCall(handler, 'remove', { root, id: 'folder-1' });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const after = folderGraph(root);
  assert.deepEqual(after.folders, []);
  assert.deepEqual(after.nodes, before.nodes);

  const missing = await folderCall(handler, 'remove', { root, id: 'folder-1' });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /folder-1/);
  assert.ok(missing.body.fix && missing.body.fix.length > 10);
});

await test('POST /api/folder отвечает на неизвестное действие и битый JSON', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  const unknown = await folderCall(handler, 'rename', { root, id: 'folder-1' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.fix, /action=/);
  const broken = await call(handler, API_PREFIX + '/api/folder?action=add', { method: 'POST', body: '{' });
  assert.equal(broken.status, 400);
  assert.match(broken.body.fix, /JSON/);
});


/*
 * Протокол папки (задание 0015): связь включается квитанцией. accept пишет одно
 * письмо Status: accepted с Ref на контракт и Session автора; панель показывает
 * состояние каждого участника. disconnect без квитанции — конфликт с рецептом.
 */
await test('accept пишет одну квитанцию с Ref и Session, состояние accepted, второй invited', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  const created = await folderCall(handler, 'add', { root, folder: folderDeclaration() });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const box = path.join(root, 'coordination');
  const thread = path.join(box, 'threads', 'critic-report');

  const res = await folderCall(handler, 'accept', {
    root,
    id: 'folder-1',
    session: 'bb94c101-522a-4b0a-b926-3604d9a4449e',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.match(res.body.receipt, /^threads\/critic-report\/.+\.md$/u, 'путь письма относительно ящика');
  assert.equal(fs.readdirSync(thread).length, 1, 'квитанция — ровно одно письмо');

  const text = fs.readFileSync(path.join(box, res.body.receipt.split('/').join(path.sep)), 'utf8');
  assert.match(text, /^Format: dsh-exchange\/1$/m);
  assert.match(text, /^From: structure$/m, 'From — метка нашего воркспейса');
  assert.match(text, /^To: structure$/m, 'To — инициатор контракта');
  assert.match(text, /^Date: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/m);
  assert.match(text, /^Thread: critic-report$/m, 'ветки не объявлены — умолчание critic-report');
  assert.match(text, /^Status: accepted$/m);
  assert.match(text, /^Session: session-bb94c101-522a-4b0a-b926-3604d9a4449e$/m, 'голый uuid нормализован');
  assert.match(text, /^Ref: contract\.md$/m, 'Ref — путь контракта относительно ящика');
  assert.match(text, /^Subject: .+$/m);

  const feed = await readFeed(root);
  assert.equal(feed.status, 200, JSON.stringify(feed.body));
  const [folder] = feed.body.folders;
  assert.deepEqual(folder.states, { structure: 'accepted', workflow: 'invited' },
    'принявший accepted, второй участник invited');
  assert.equal(folder.contractRev, 1, 'ревизия контракта видна в ответе');
});

/*
 * Задание 0047 D2: повторный accept идемпотентен — одна квитанция на пару
 * папка-сторона. Второе письмо не пишется, ответ несёт alreadyAccepted: true и
 * путь существующей квитанции (docs/exchange-format.md §8).
 */
await test('повторный accept не пишет вторую квитанцию и отдаёт alreadyAccepted', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  await folderCall(handler, 'add', { root, folder: folderDeclaration() });
  const thread = path.join(root, 'coordination', 'threads', 'critic-report');
  const letters = () => fs.readdirSync(thread).filter((name) => /\.md$/u.test(name));

  const first = await folderCall(handler, 'accept', {
    root,
    id: 'folder-1',
    session: 'session-aaaaaaaa-1111-2222-3333-444444444444',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.alreadyAccepted, false, 'первый accept — новая квитанция');
  assert.equal(letters().length, 1, 'первое письмо в ящике');

  const second = await folderCall(handler, 'accept', {
    root,
    id: 'folder-1',
    session: 'session-bbbbbbbb-1111-2222-3333-444444444444',
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.ok, true);
  assert.equal(second.body.alreadyAccepted, true, 'повторный accept говорит alreadyAccepted');
  assert.equal(second.body.receipt, first.body.receipt, 'возвращается существующая квитанция');
  assert.equal(second.body.ref, first.body.ref, 'Ref прежней квитанции сохранён');
  assert.equal(letters().length, 1, 'второго письма нет: одна квитанция на пару папка-сторона');

  const text = fs.readFileSync(
    path.join(root, 'coordination', first.body.receipt.split('/').join(path.sep)), 'utf8');
  assert.match(text, /^Status: accepted$/m);
  assert.match(text, /^Session: session-aaaaaaaa-1111-2222-3333-444444444444$/m,
    'в записи остаётся первая сессия, нажавшая кнопку');
});

/*
 * §8: отключение сильнее квитанции — «старые приёмы истекли». После
 * disconnected повторный accept пишет НОВОЕ письмо, а не отдаёт отменённую
 * квитанцию как alreadyAccepted: иначе включиться снова было бы нечем.
 */
await test('после отключения accept пишет новую квитанцию, а не возвращает отменённую', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  await folderCall(handler, 'add', { root, folder: folderDeclaration() });
  const thread = path.join(root, 'coordination', 'threads', 'critic-report');
  const letters = () => fs.readdirSync(thread).filter((name) => /\.md$/u.test(name));

  const accepted = await folderCall(handler, 'accept', {
    root,
    id: 'folder-1',
    session: 'session-11111111-2222-3333-4444-555555555555',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const off = await folderCall(handler, 'disconnect', {
    root,
    id: 'folder-1',
    session: 'session-11111111-2222-3333-4444-555555555555',
  });
  assert.equal(off.status, 200, JSON.stringify(off.body));

  const again = await folderCall(handler, 'accept', {
    root,
    id: 'folder-1',
    session: 'session-99999999-2222-3333-4444-555555555555',
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.alreadyAccepted, false, 'включение снова — новая квитанция');
  assert.notEqual(again.body.receipt, accepted.body.receipt, 'отменённая квитанция не выдаётся за действующую');
  assert.equal(letters().length, 3, 'в ящике: квитанция, отключение, новая квитанция');
  const text = fs.readFileSync(
    path.join(root, 'coordination', again.body.receipt.split('/').join(path.sep)), 'utf8');
  assert.match(text, /^Status: accepted$/m);
});

/*
 * C3: старая папка объявляет ветку — квитанция идёт в неё. Данные не
 * переписываются: threads остаются в graph.json как есть, даже если поля
 * «Ветки» в редакторе больше нет.
 */
await test('старая папка с ветками: квитанция идёт в объявленную ветку', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  const created = await folderCall(handler, 'add', {
    root,
    folder: folderDeclaration({ exchange: { threads: ['audit'], contract: 'contract.md' } }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(folderGraph(root).folders[0].exchange.threads, ['audit'],
    'объявленная ветка записана как есть');

  const res = await folderCall(handler, 'accept', {
    root,
    id: 'folder-1',
    session: 'session-22222222-3333-4444-5555-666666666666',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.receipt, /^threads\/audit\/.+\.md$/u, 'квитанция — в объявленную ветку');
  const text = fs.readFileSync(
    path.join(root, 'coordination', res.body.receipt.split('/').join(path.sep)), 'utf8');
  assert.match(text, /^Thread: audit$/m, 'Thread — объявленная ветка, а не умолчание');
});

await test('disconnect без квитанции — 409 с рецептом; после квитанции — disconnected с Ref', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  await folderCall(handler, 'add', { root, folder: folderDeclaration() });

  const early = await folderCall(handler, 'disconnect', { root, id: 'folder-1' });
  assert.equal(early.status, 409, 'отключаться не от чего');
  assert.match(early.body.fix, /сначала примите приглашение \(accept\)/u);

  const accepted = await folderCall(handler, 'accept', {
    root,
    id: 'folder-1',
    session: 'session-11111111-2222-3333-4444-555555555555',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  const res = await folderCall(handler, 'disconnect', {
    root,
    id: 'folder-1',
    session: 'session-11111111-2222-3333-4444-555555555555',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  const text = fs.readFileSync(path.join(root, 'coordination', res.body.receipt.split('/').join(path.sep)), 'utf8');
  assert.match(text, /^Status: disconnected$/m);
  assert.ok(text.includes('Ref: ' + accepted.body.receipt + '\n'), 'Ref — своя квитанция');

  const feed = await readFeed(root);
  assert.deepEqual(feed.body.folders[0].states, { structure: 'disconnected', workflow: 'invited' },
    'отключение после квитанции — disconnected');
});

/*
 * Задание 0063: в одном ящике несколько папок. Квитанция папки — письмо
 * Status: accepted, Ref которого адресует контракт этой папки; disconnect
 * обязан ссылаться на неё, а не на самую позднюю квитанцию ящика. Дата
 * квитанций задаётся нарочно в обратном порядке: прежний код брал бы чужую.
 */
function multiFolderProject(specs) {
  const root = folderProject();
  const box = path.join(root, 'coordination');
  const thread = 'critic-report';
  fs.mkdirSync(path.join(box, 'threads', thread), { recursive: true });
  const document = folderGraph(root);
  document.folders = specs.map((spec) => {
    const contract = 'contract-' + spec.id + '.md';
    fs.writeFileSync(path.join(box, contract),
      'Rev: 1\nInitiator: workflow\nInvited: structure\nCreated: 2026-11-04\n');
    if (spec.receipt) {
      const name = '2026-11-04T0' + spec.hour + '-00+03-00--structure--0' + spec.id.slice(-1) + '.md';
      writeFolderLetter(box, thread, name, {
        from: 'structure',
        to: 'workflow',
        date: '2026-11-04T0' + spec.hour + ':00+03:00',
        status: 'accepted',
        session: 'session-' + spec.id,
        ref: contract,
      });
    }
    return {
      id: spec.id,
      box: { path: 'coordination', root: 'workspace' },
      exchange: { threads: [thread], contract },
      participants: ['workflow', 'structure'],
      orchestrator: 'coordinator',
    };
  });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(document, null, 2));
  return { root, box, thread: path.join(box, 'threads', thread) };
}

function writeFolderLetter(box, thread, name, fields) {
  const text = [
    'Format: dsh-exchange/1',
    'From: ' + fields.from,
    'To: ' + fields.to,
    'Date: ' + fields.date,
    'Thread: ' + thread,
    'Status: ' + fields.status,
    'Session: ' + (fields.session || 'session-x'),
    'Ref: ' + fields.ref,
    'Subject: письмо',
    '',
    'текст',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(box, 'threads', thread, name), text, 'utf8');
}

function disconnectedLetters(dir) {
  return fs.readdirSync(dir)
    .filter((name) => /\.md$/u.test(name))
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }))
    .filter((item) => /^Status:\s*disconnected$/mu.test(item.text));
}

await test('две папки в одном ящике: disconnect ссылается на квитанцию своей папки', async () => {
  const { root, thread } = multiFolderProject([
    { id: 'folder-1', receipt: true, hour: 5 },
    { id: 'folder-2', receipt: true, hour: 4 },
  ]);
  const handler = createWebHandler(folderRuntime(root));
  const session = 'session-66666666-7777-4888-9999-aaaaaaaaaaaa';
  const res = await folderCall(handler, 'disconnect', { root, id: 'folder-2', session });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ref, 'threads/critic-report/2026-11-04T04-00+03-00--structure--02.md',
    'ответ называет квитанцию своей папки');
  const sent = disconnectedLetters(thread);
  assert.equal(sent.length, 1, 'одно письмо disconnected');
  const ref = /^Ref:\s*(.+)$/mu.exec(sent[0].text)[1].trim();
  assert.equal(ref, 'threads/critic-report/2026-11-04T04-00+03-00--structure--02.md',
    'Ref отключения ведёт на квитанцию folder-2, а не на позднюю квитанцию folder-1');
  assert.match(sent[0].text, /^Session: session-66666666-7777-4888-9999-aaaaaaaaaaaa$/m,
    'Session — из запроса');
  const target = fs.readFileSync(path.join(root, 'coordination', ref.split('/').join(path.sep)), 'utf8');
  assert.match(target, /^Ref: contract-folder-2\.md$/m, 'цель Ref — контракт своей папки');
});

await test('папка без квитанции в ящике с соседней: disconnect — 409 и письма нет', async () => {
  const { root, thread } = multiFolderProject([
    { id: 'folder-1', receipt: true, hour: 5 },
    { id: 'folder-2', receipt: false, hour: 4 },
  ]);
  const handler = createWebHandler(folderRuntime(root));
  const before = fs.readdirSync(thread).filter((name) => /\.md$/u.test(name));
  const res = await folderCall(handler, 'disconnect', { root, id: 'folder-2', session: 'session-d' });
  assert.equal(res.status, 409, 'соседняя квитанция не годится');
  assert.match(res.body.error, /нет квитанции: отключаться не от чего/u);
  assert.match(res.body.fix, /сначала примите приглашение \(accept\)/u);
  assert.equal(disconnectedLetters(thread).length, 0, 'письмо disconnected не пишется');
  assert.deepEqual(fs.readdirSync(thread).filter((name) => /\.md$/u.test(name)), before,
    'ящик не изменился');
});

await test('одна папка в ящике: disconnect работает (контроль)', async () => {
  const { root, thread } = multiFolderProject([{ id: 'folder-1', receipt: true, hour: 5 }]);
  const handler = createWebHandler(folderRuntime(root));
  const res = await folderCall(handler, 'disconnect', { root, id: 'folder-1', session: 'session-control' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sent = disconnectedLetters(thread);
  assert.equal(sent.length, 1, 'одно письмо disconnected');
  const ref = /^Ref:\s*(.+)$/mu.exec(sent[0].text)[1].trim();
  assert.equal(ref, 'threads/critic-report/2026-11-04T05-00+03-00--structure--01.md',
    'Ref — единственная квитанция папки');
});

/*
 * Задание 0065: отключение идемпотентно. Повторное нажатие при действующем
 * отключении этой стороны по этой папке не пишет второе письмо: ответ 200
 * отдаёт путь существующего письма и alreadyDisconnected: true
 * (docs/exchange-format.md §8).
 */
await test('первое disconnect пишет одно письмо и отдаёт alreadyDisconnected:false', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  await folderCall(handler, 'add', { root, folder: folderDeclaration() });
  const box = path.join(root, 'coordination');
  const thread = path.join(box, 'threads', 'critic-report');
  const accepted = await folderCall(handler, 'accept', {
    root,
    id: 'folder-1',
    session: 'session-11111111-2222-3333-4444-555555555555',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  const res = await folderCall(handler, 'disconnect', {
    root,
    id: 'folder-1',
    session: 'session-66666666-7777-4888-9999-aaaaaaaaaaaa',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.alreadyDisconnected, false, 'первое отключение — новое письмо');
  assert.equal(disconnectedLetters(thread).length, 1, 'письмо disconnected ровно одно');
  const text = fs.readFileSync(path.join(box, res.body.receipt.split('/').join(path.sep)), 'utf8');
  assert.match(text, /^Status: disconnected$/m);
  assert.match(text, /^Ref: threads\/critic-report\/.+\.md$/m, 'Ref — своя квитанция');
  assert.match(text, /^Session: session-66666666-7777-4888-9999-aaaaaaaaaaaa$/m, 'Session из запроса');
});

await test('повторный disconnect не пишет второе письмо и отдаёт alreadyDisconnected', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  await folderCall(handler, 'add', { root, folder: folderDeclaration() });
  const box = path.join(root, 'coordination');
  const thread = path.join(box, 'threads', 'critic-report');
  const letters = () => fs.readdirSync(thread).filter((name) => /\.md$/u.test(name));
  await folderCall(handler, 'accept', { root, id: 'folder-1', session: 'session-a' });

  const first = await folderCall(handler, 'disconnect', { root, id: 'folder-1', session: 'session-d1' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.alreadyDisconnected, false);
  const before = letters();
  const firstMtime = fs.statSync(path.join(box, first.body.receipt.split('/').join(path.sep))).mtimeMs;

  const second = await folderCall(handler, 'disconnect', { root, id: 'folder-1', session: 'session-d2' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.ok, true);
  assert.equal(second.body.alreadyDisconnected, true, 'повторное отключение помечено');
  assert.equal(second.body.receipt, first.body.receipt, 'ответ называет существующее письмо отключения');
  assert.equal(second.body.folder, 'folder-1');
  assert.equal(second.body.session, 'session-d2', 'session — из запроса, как у alreadyAccepted');
  assert.equal(disconnectedLetters(thread).length, 1, 'второго письма disconnected нет');
  assert.deepEqual(letters(), before, 'ящик не изменился');
  assert.equal(fs.statSync(path.join(box, first.body.receipt.split('/').join(path.sep))).mtimeMs,
    firstMtime, 'существующее письмо не переписано');
});

await test('после нового accept отключение снова пишет письмо', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  await folderCall(handler, 'add', { root, folder: folderDeclaration() });
  const thread = path.join(root, 'coordination', 'threads', 'critic-report');
  const refsOf = () => disconnectedLetters(thread)
    .map((item) => /^Ref:\s*(.+)$/mu.exec(item.text)[1].trim())
    .sort();

  const first = await folderCall(handler, 'accept', { root, id: 'folder-1', session: 'session-a1' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const off1 = await folderCall(handler, 'disconnect', { root, id: 'folder-1', session: 'session-d1' });
  assert.equal(off1.status, 200, JSON.stringify(off1.body));
  assert.equal(off1.body.alreadyDisconnected, false);

  const again = await folderCall(handler, 'accept', { root, id: 'folder-1', session: 'session-a2' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.alreadyAccepted, false, 'после отключения accept пишет новую квитанцию');

  const off2 = await folderCall(handler, 'disconnect', { root, id: 'folder-1', session: 'session-d2' });
  assert.equal(off2.status, 200, JSON.stringify(off2.body));
  assert.equal(off2.body.alreadyDisconnected, false, 'новый приём снял прежнее отключение');
  assert.equal(disconnectedLetters(thread).length, 2, 'после нового приёма — новое письмо');
  assert.deepEqual(refsOf(), [first.body.receipt, again.body.receipt].sort(),
    'каждое отключение ссылается на свою квитанцию');
});

/*
 * Задание 0024: реестр воркспейсов — источник меток участника папки.
 * /api/status отдаёт его панели ({ label, path }), а POST /api/folder сверяет
 * с ним каждую метку: свободного ввода в панели больше нет.
 */
await test('status отдаёт реестр воркспейсов, а папка сохраняется по его меткам', async () => {
  const root = folderProject();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-reg-'));
  const runtime = createGraphRuntime({ roots: [] }, {
    getWorkspaceRegistry: () => ({ list: () => [{ path: root, name: 'structure' }, { path: other }] }),
  });
  const handler = createWebHandler(runtime);
  const status = await call(handler, API_PREFIX + '/api/status');
  assert.equal(status.status, 200, JSON.stringify(status.body));
  const labels = status.body.workspaces.map((row) => row.label);
  assert.ok(labels.includes('structure'), 'метка воркспейса из реестра: ' + labels.join(', '));
  assert.ok(labels.includes(path.basename(other)), 'воркспейс без имени — по имени каталога');
  assert.equal(status.body.workspaces.find((row) => row.label === 'structure').path, path.resolve(root));
  /* Задание 0029: name — имя каталога, панель показывает «метка (имя каталога)». */
  assert.equal(status.body.workspaces.find((row) => row.label === 'structure').name, path.basename(root),
    'name — имя каталога воркспейса');
  assert.equal(status.body.workspaces.find((row) => row.label === path.basename(other)).name, path.basename(other),
    'name у воркспейса без объявленного имени — тоже имя каталога');

  const saved = await folderCall(handler, 'add', {
    root,
    folder: folderDeclaration({ participants: ['structure', path.basename(other)], exchange: undefined }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(folderGraph(root).folders[0].paths.structure, path.resolve(root),
    'путь метки берётся из реестра, а не из тела');
});

await test('неизвестная метка участника — 400 с similar и fix, запись не происходит', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  const res = await folderCall(handler, 'add', { root, folder: folderDeclaration({ participants: ['struktura'] }) });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /struktura/, 'причина называет метку');
  assert.ok(Array.isArray(res.body.similar) && res.body.similar.includes('structure'),
    'similar — похожие метки реестра: ' + JSON.stringify(res.body.similar));
  assert.match(res.body.fix, /реестр/i);
  assert.deepEqual(folderGraph(root).folders, [], 'отказ ничего не записал');
  assert.ok(!fs.existsSync(path.join(root, 'coordination')), 'ящик не создан');
});

await test('рядом с метками папки пишется карта paths с абсолютными путями', async () => {
  const root = folderProject();
  const runtime = folderRuntime(root);
  const handler = createWebHandler(runtime);
  const res = await folderCall(handler, 'add', { root, folder: folderDeclaration({ exchange: undefined }) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const record = folderGraph(root).folders[0];
  assert.deepEqual(record.paths, { structure: path.resolve(root), workflow: runtime.participants.workflow },
    'пути из реестра, а не из тела запроса');
  assert.deepEqual(record.participants, ['structure', 'workflow'], 'метки остаются массивом строк');
  assert.equal(record.exchange.contract, 'contract-folder-1.md', 'по умолчанию имя уникально на папку');
  assert.ok(fs.existsSync(path.join(root, 'coordination', 'contract-folder-1.md')));
});

await test('contract с неразрешённой меткой — 409, контракт и письма не пишутся', async () => {
  const root = folderProject();
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      participants: ['structure', 'ghost'],
      orchestrator: 'coordinator',
    }],
  }, null, 2));
  const box = path.join(root, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  const contractFile = path.join(box, 'contract-folder-1.md');
  const before = 'Format: dsh-exchange/1-contract\nRev: 7\nInitiator: structure\nInvited: ghost\nCreated: 2026-11-02T10:00+03:00\n';
  fs.writeFileSync(contractFile, before, 'utf8');

  const handler = createWebHandler(folderRuntime(root));
  const res = await folderCall(handler, 'contract', { root, id: 'folder-1' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /ghost/, 'отказ называет метку');
  assert.match(res.body.fix, /реестр/i);
  assert.equal(fs.readFileSync(contractFile, 'utf8'), before, 'контракт не переписан');
  /* Отказ готовит пустую ветку в уже существующем ящике, но писем не пишет. */
  assert.deepEqual(fs.readdirSync(path.join(box, 'threads')), [], 'письма не записаны');
});

/*
 * Задание 0028, D2: Rev поднимает только инициатор контракта. Чужой Initiator —
 * 409 с его названием и рецептом; Rev не растёт, письма не пишутся.
 */
await test('contract чужого инициатора — 409 с именем и рецептом, Rev и письма не тронуты', async () => {
  const root = folderProject();
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      exchange: { contract: 'contract.md', threads: ['critic-report'] },
      participants: ['structure', 'workflow'],
      orchestrator: 'coordinator',
    }],
  }, null, 2));
  const box = path.join(root, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  const contractFile = path.join(box, 'contract.md');
  const before = 'Format: dsh-exchange/1-contract\nRev: 4\nInitiator: structure\nInvited: workflow\nCreated: 2026-11-02T10:00+03:00\n';
  fs.writeFileSync(contractFile, before, 'utf8');

  const runtime = createGraphRuntime({
    roots: [root],
    participants: { structure: fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-foreign-')), workflow: root },
    me: 'workflow',
  });
  const handler = createWebHandler(runtime);
  const res = await folderCall(handler, 'contract', { root, id: 'folder-1' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.initiator, 'structure', 'отказ называет чужого инициатора');
  assert.match(res.body.error, /structure/, 'имя инициатора есть в ошибке');
  assert.match(res.body.fix, /action=contract/, 'рецепт говорит, кто поднимает Rev');
  assert.equal(fs.readFileSync(contractFile, 'utf8'), before, 'Rev не поднят');
  assert.ok(!fs.existsSync(path.join(box, 'threads')), 'письма не записаны');
});

/*
 * Задание 0028, D3: лента отдаёт участника парой «метка + каталог»; метка,
 * которой нет ни в реестре, ни в записанных путях, — path: null и unresolved.
 */
await test('GET /api/exchange отдаёт members {label,path,name} и unresolved', async () => {
  const root = folderProject();
  const runtime = folderRuntime(root);
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      participants: ['structure', 'workflow', 'ghost'],
      orchestrator: 'coordinator',
    }],
  }, null, 2));
  fs.mkdirSync(path.join(root, 'coordination', 'threads'), { recursive: true });

  const handler = createWebHandler(runtime);
  const res = await call(handler, API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const folder = res.body.folders.find((item) => item.id === 'folder-1');
  assert.ok(folder, 'запись папки есть в ленте');
  assert.deepEqual(folder.members, [
    { label: 'structure', path: path.resolve(root), name: path.basename(root) },
    { label: 'workflow', path: runtime.participants.workflow, name: path.basename(runtime.participants.workflow) },
    { label: 'ghost', path: null, name: null },
  ], 'members — метка, абсолютный путь из реестра и имя каталога');
  assert.equal(folder.states.structure, 'invited');
  assert.equal(folder.states.workflow, 'invited');
  assert.equal(folder.states.ghost, 'unresolved', 'неизвестная метка честно помечена');
});

/*
 * Задание 0030, D2: лента называет сторону этого воркспейса парой {label, path}.
 * Метка, которую папка не связывает с нашим корнем, даёт self: null — панель
 * тогда не применяет 409 и показывает, что сторона не опознана.
 */
await test('GET /api/exchange отдаёт self {label,path} и null для неопознанной стороны', async () => {
  const root = folderProject();
  const runtime = folderRuntime(root);
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [
      {
        id: 'folder-1',
        box: { path: 'coordination', root: 'workspace' },
        participants: ['structure', 'workflow'],
        orchestrator: 'coordinator',
      },
      {
        id: 'folder-2',
        box: { path: 'coordination', root: 'workspace' },
        participants: ['workflow', 'ghost'],
        orchestrator: 'coordinator',
      },
    ],
  }, null, 2));

  const res = await call(createWebHandler(runtime), API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const known = res.body.folders.find((item) => item.id === 'folder-1');
  assert.deepEqual(known.self, { label: 'structure', path: path.resolve(root) },
    'self — метка нашего воркспейса и его абсолютный путь');
  const unknown = res.body.folders.find((item) => item.id === 'folder-2');
  assert.equal(unknown.self, null, 'папка без нашей метки не выдумывает сторону');
});

await test('имя контракта уникально на папку: совпадение — 409 со свободным именем', async () => {
  const root = folderProject();
  const handler = createWebHandler(folderRuntime(root));
  const first = await folderCall(handler, 'add', { root, folder: folderDeclaration() });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const clash = await folderCall(handler, 'add', { root, folder: folderDeclaration({ id: 'folder-2' }) });
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.match(clash.body.error, /contract\.md/, 'отказ называет занятое имя');
  assert.match(clash.body.fix, /contract-folder-2\.md/, 'рецепт называет свободное имя');
  assert.deepEqual(folderGraph(root).folders.map((item) => item.id), ['folder-1'], 'вторая папка не записана');

  const free = await folderCall(handler, 'add', {
    root,
    folder: folderDeclaration({ id: 'folder-2', exchange: { contract: 'contract-folder-2.md' } }),
  });
  assert.equal(free.status, 200, JSON.stringify(free.body));
  assert.ok(fs.existsSync(path.join(root, 'coordination', 'contract-folder-2.md')), 'своё имя проходит');
});

/*
 * Задание 0051: в ящике несколько веток threads/*. join приглашённого берёт
 * ветку письма-приглашения (To = его метка, Ref на контракт папки), а не первую
 * по порядку каталога; объявленная ветка прежней записи сильнее приглашения.
 */
function joinProject(threads, invitedThread, existing = null) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-join-'));
  const reach = path.join(parent, 'reach-proxy');
  const split = path.join(parent, 'split-optimizer');
  fs.mkdirSync(path.join(reach, 'structure'), { recursive: true });
  fs.mkdirSync(path.join(split, 'structure'), { recursive: true });
  const box = path.join(parent, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  fs.writeFileSync(path.join(box, 'README.md'), [
    '# Канал', '',
    '| Сторона | Пространство | Что делает |',
    '| --- | --- | --- |',
    '| `reach` | `' + reach.split(path.sep).join('/') + '` | инициатор |',
    '| `split` | `' + split.split(path.sep).join('/') + '` | приглашённый |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(box, 'contract-folder-1.md'),
    'Rev: 1\nInitiator: reach\nInvited: split\nCreated: 2026-11-04\n');
  for (const thread of threads) {
    const dir = path.join(box, 'threads', thread);
    fs.mkdirSync(dir, { recursive: true });
    const status = thread === invitedThread ? 'invitation' : 'report';
    const to = thread === invitedThread ? 'split' : 'other';
    const at = thread === invitedThread ? '2026-11-04T03:00+03:00' : '2026-11-04T02:00+03:00';
    fs.writeFileSync(path.join(dir, '2026-11-04T03-00+03-00--reach--01.md'), [
      'Format: dsh-exchange/1', 'From: reach', 'To: ' + to, 'Date: ' + at,
      'Thread: ' + thread, 'Status: ' + status,
      'Ref: threads/' + thread + '/2026-11-04T03-00+03-00--reach--01.md',
      'Box: ' + box.split(path.sep).join('/'), 'Subject: письмо', '', 'текст', '',
    ].join('\n'));
  }
  const nodes = [{ id: 'coordinator', role: 'координатор', provider: 'p1', model: 'm1' }];
  fs.writeFileSync(path.join(split, 'structure', 'graph.json'), JSON.stringify({
    version: 1, nodes, edges: [], folders: existing ? [existing] : [],
  }, null, 2));
  fs.writeFileSync(path.join(reach, 'structure', 'graph.json'), JSON.stringify({
    version: 1, nodes, edges: [], folders: [],
  }, null, 2));
  const runtime = createGraphRuntime({ roots: [reach, split], participants: { reach, split } });
  return { parent, reach, split, box, runtime };
}

function joinedThreads(hosted) {
  const folder = folderGraph(hosted.split).folders.find((item) => item && item.id === 'folder-1');
  return folder && Array.isArray(folder.exchange.threads) ? folder.exchange.threads : [];
}

async function joinHosted(hosted) {
  return folderCall(createWebHandler(hosted.runtime), 'join', {
    root: hosted.split,
    id: 'folder-1',
    box: hosted.box.split(path.sep).join('/'),
    participants: ['reach', 'split'],
    orchestrator: 'coordinator',
  });
}

await test('join берёт ветку письма-приглашения, а не первую по порядку каталога', async () => {
  const hosted = joinProject(['aaa-first', 'critic-report'], 'critic-report');
  const res = await joinHosted(hosted);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(joinedThreads(hosted), ['critic-report'], 'ветка приглашения, а не aaa-first');
});

await test('join в ящике с одной веткой берёт её', async () => {
  const hosted = joinProject(['critic-report'], 'critic-report');
  const res = await joinHosted(hosted);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(joinedThreads(hosted), ['critic-report'], 'единственная ветка — выбранная');
});

await test('join сохраняет объявленную ветку существующей папки', async () => {
  const hosted = joinProject(['aaa-first', 'critic-report'], 'critic-report', {
    id: 'folder-1',
    box: { path: 'coordination', root: 'shared' },
    exchange: { threads: ['declared-thread'], contract: 'contract-folder-1.md' },
    participants: ['reach', 'split'],
    orchestrator: 'coordinator',
  });
  const res = await joinHosted(hosted);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(joinedThreads(hosted), ['declared-thread'], 'приглашение не затирает объявленную ветку');
});

/*
 * Задание 0064: в одном ящике две папки со своими приглашениями, чужое письмо
 * может быть позже. join сверяет Ref приглашения с контрактом своей папки, а не
 * берёт последнее приглашение стороны; письмо без Ref (старый формат) — засчитывается.
 */
function joinInvitationProject(letters) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-join-ref-'));
  const reach = path.join(parent, 'reach-proxy');
  const split = path.join(parent, 'split-optimizer');
  fs.mkdirSync(path.join(reach, 'structure'), { recursive: true });
  fs.mkdirSync(path.join(split, 'structure'), { recursive: true });
  const box = path.join(parent, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  fs.writeFileSync(path.join(box, 'README.md'), [
    '# Канал', '',
    '| Сторона | Пространство | Что делает |',
    '| --- | --- | --- |',
    '| `reach` | `' + reach.split(path.sep).join('/') + '` | инициатор |',
    '| `split` | `' + split.split(path.sep).join('/') + '` | приглашённый |', '',
  ].join('\n'));
  for (const id of ['folder-1', 'folder-2']) {
    fs.writeFileSync(path.join(box, 'contract-' + id + '.md'),
      'Rev: 1\nInitiator: reach\nInvited: split\nCreated: 2026-11-04\n');
  }
  for (const letter of letters) {
    const dir = path.join(box, 'threads', letter.thread);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      'Format: dsh-exchange/1', 'From: reach', 'To: split', 'Date: ' + letter.date,
      'Thread: ' + letter.thread, 'Status: invitation',
    ];
    if (letter.ref) lines.push('Ref: ' + letter.ref);
    lines.push('Box: ' + box.split(path.sep).join('/'),
      'Subject: приглашение в папку ' + letter.folder, '', 'текст', '');
    fs.writeFileSync(path.join(dir, letter.date.replace(/:/gu, '-') + '--reach--01.md'), lines.join('\n'));
  }
  const nodes = [{ id: 'coordinator', role: 'координатор', provider: 'p1', model: 'm1' }];
  for (const root of [reach, split]) {
    fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
      version: 1, nodes, edges: [], folders: [],
    }, null, 2));
  }
  const runtime = createGraphRuntime({ roots: [reach, split], participants: { reach, split } });
  return { parent, reach, split, box, runtime };
}

function invitedThreads(hosted, id) {
  const folder = folderGraph(hosted.split).folders.find((item) => item && item.id === id);
  return folder && Array.isArray(folder.exchange.threads) ? folder.exchange.threads : [];
}

async function joinInvitedFolder(hosted, id) {
  return folderCall(createWebHandler(hosted.runtime), 'join', {
    root: hosted.split,
    id,
    box: hosted.box.split(path.sep).join('/'),
    participants: ['reach', 'split'],
    orchestrator: 'coordinator',
  });
}

const twoFolderInvitations = () => ([
  { thread: 'folder-1-thread', folder: 'folder-1', date: '2026-11-04T04:00+03:00', ref: 'contract-folder-1.md' },
  { thread: 'folder-2-thread', folder: 'folder-2', date: '2026-11-04T05:00+03:00', ref: 'contract-folder-2.md' },
]);

await test('join: позднее приглашение чужой папки не подменяет ветку своей по Ref', async () => {
  const hosted = joinInvitationProject(twoFolderInvitations());
  const res = await joinInvitedFolder(hosted, 'folder-1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(invitedThreads(hosted, 'folder-1'), ['folder-1-thread'],
    'ветка приглашения своей папки, а не folder-2-thread');
});

await test('join: приглашение без Ref (старый формат) засчитывается', async () => {
  const hosted = joinInvitationProject([
    { thread: 'folder-1-thread', folder: 'folder-1', date: '2026-11-04T04:00+03:00' },
  ]);
  const res = await joinInvitedFolder(hosted, 'folder-1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(invitedThreads(hosted, 'folder-1'), ['folder-1-thread'], 'письмо без Ref — совместимость');
});

await test('join: вторая папка берёт ветку своего приглашения', async () => {
  const hosted = joinInvitationProject(twoFolderInvitations());
  const res = await joinInvitedFolder(hosted, 'folder-2');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(invitedThreads(hosted, 'folder-2'), ['folder-2-thread'], 'folder-2 — своя ветка');
});

await test('writeFileAtomic: 40 параллельных записей без EEXIST и временных файлов', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-atomic-'));
  const target = path.join(dir, 'graph.json');
  const moduleUrl = new URL('../lib/api.js', import.meta.url).href;
  const workerFile = path.join(dir, 'writer.mjs');
  fs.writeFileSync(workerFile, [
    "import { parentPort, workerData } from 'node:worker_threads';",
    "const module = await import(workerData.moduleUrl);",
    "try {",
    "  module.writeFileAtomic(workerData.target, workerData.text);",
    "  parentPort.postMessage({ ok: true });",
    "} catch (error) {",
    "  parentPort.postMessage({ ok: false, code: error && error.code, message: error && error.message });",
    "}",
  ].join('\n'));

  /* Сорок писателей в один файл: прежний общий temp-файл давал EEXIST/EPERM. */
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => new Promise((resolve) => {
    const worker = new Worker(workerFile, {
      workerData: { moduleUrl, target, text: JSON.stringify({ index, writer: 'worker-' + index }) },
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      worker.terminate().then(() => resolve(value), () => resolve(value));
    };
    worker.once('message', finish);
    worker.once('error', (error) => finish({ ok: false, code: error && error.code, message: error && error.message }));
    worker.once('exit', (code) => { if (code !== 0) finish({ ok: false, code: 'exit-' + code }); });
  })));

  const failed = results.filter((item) => !item || item.ok !== true);
  assert.deepEqual(failed, [], 'ни одна запись не должна упасть на EEXIST/EPERM');
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(typeof parsed.index, 'number', 'файл — целый JSON одного из писателей, а не половина');
  assert.ok(parsed.index >= 0 && parsed.index < 40);
  const leftovers = fs.readdirSync(dir).filter((name) => /\.tmp-/u.test(name));
  assert.deepEqual(leftovers, [], 'временных файлов после записи не осталось');

  const direct = path.join(dir, 'nested', 'direct.json');
  assert.equal(writeFileAtomic(direct, '{"ok":true}'), direct, 'возвращает абсолютный путь');
  assert.deepEqual(JSON.parse(fs.readFileSync(direct, 'utf8')), { ok: true });
  /* На Windows удаление каталога может наткнуться на ещё не закрытый дескриптор
     воркера или проверку антивируса: ENOTEMPTY — не дефект записи, повторим. */
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
});

await test('POST /api/report-check: валидный отчёт 200, отказ 422 с code/missing/fix', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-report-route-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'worker', role: 'исполнитель', model: 'work' }],
    folders: [{ id: 'exchange', box: { path: 'coordination', root: 'workspace' } }],
    edges: [],
  }, null, 2));
  const taskDir = path.join(root, 'docs', 'tasks', '0100');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), '# Задание\n\n<!-- TASK-META\n'
    + JSON.stringify({ id: '0100', allowedPaths: ['lib/**', 'docs/tasks/0100/**'] }, null, 2) + '\n-->\n');
  fs.writeFileSync(path.join(taskDir, 'criteria.lock'), JSON.stringify({ version: 3, task: '0100' }));
  const reportPath = path.join(taskDir, 'report.worker.json');
  const report = {
    version: 1,
    task: '0100',
    node: 'worker',
    role: 'исполнитель',
    startedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    completedAt: new Date(Date.now() - 30 * 1000).toISOString(),
    verdict: 'done',
    /* P-12: время команды лежит внутри шага, а не «сейчас» после его конца. */
    commands: [{ cmd: 'node --check lib/api.js', exit: 0, tail: '', at: new Date(Date.now() - 45 * 1000).toISOString() }],
    files: ['lib/api.js'],
    openItems: [],
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const handler = createWebHandler(makeRuntime([root]));
  const url = API_PREFIX + '/api/report-check?root=' + encodeURIComponent(root);
  const ok = await call(handler, url, { method: 'POST', body: JSON.stringify({ file: 'docs/tasks/0100/report.worker.json' }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { ok: true });

  fs.writeFileSync(reportPath, JSON.stringify({ ...report, files: ['lib/api.js', 'src/secret.js'] }, null, 2));
  const refused = await call(handler, url, { method: 'POST', body: JSON.stringify({ file: 'docs/tasks/0100/report.worker.json' }) });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.code, 'outside-allowed-paths');
  assert.ok(refused.body.missing.includes('src/secret.js'), JSON.stringify(refused.body.missing));
  assert.equal(typeof refused.body.message, 'string');
  assert.equal(typeof refused.body.fix, 'string');

  const missing = await call(handler, url, { method: 'POST', body: JSON.stringify({ file: 'docs/tasks/0100/report.ghost.json' }) });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.code, 'report-missing');

  /* Тело не двигает часы: now из тела не принимается (P-10). */
  fs.writeFileSync(reportPath, JSON.stringify({
    ...report,
    completedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, null, 2));
  const futureNow = await call(handler, url, {
    method: 'POST',
    body: JSON.stringify({
      file: 'docs/tasks/0100/report.worker.json',
      now: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    }),
  });
  assert.equal(futureNow.status, 422, 'будущий completedAt принят подменённым now: ' + JSON.stringify(futureNow.body));
  assert.equal(futureNow.body.code, 'time-invalid');

  /* И прошлое в теле не делает честный отчёт будущим: часы берутся у рантайма. */
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const pastNow = await call(handler, url, {
    method: 'POST',
    body: JSON.stringify({ file: 'docs/tasks/0100/report.worker.json', now: '2000-01-01T00:00:00+03:00' }),
  });
  assert.equal(pastNow.status, 200, 'now из тела всё ещё влияет: ' + JSON.stringify(pastNow.body));

  /* Тело не выбирает ящик: P-5 смотрит на ящик проекта, а не на подставленный. */
  const projectBox = path.join(root, 'coordination');
  const letter = path.join(projectBox, 'threads', 'critic-report', '2026-11-02T22-00+03-00--workflow--1.md');
  fs.mkdirSync(path.dirname(letter), { recursive: true });
  fs.writeFileSync(letter, '# письмо\n');
  /* Письмо пришло после checkedAt, но до конца шага: это и есть stale-случай P-5. */
  const letterTime = (Date.now() - 35 * 1000) / 1000;
  fs.utimesSync(letter, letterTime, letterTime);
  const emptyBox = path.join(root, 'empty-box');
  fs.mkdirSync(emptyBox, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    ...report,
    inbox: {
      checkedAt: new Date(Date.now() - 40 * 1000).toISOString(),
      box: projectBox,
      new: [],
    },
  }, null, 2));
  const decoyBox = await call(handler, url, {
    method: 'POST',
    body: JSON.stringify({ file: 'docs/tasks/0100/report.worker.json', box: emptyBox }),
  });
  assert.equal(decoyBox.status, 422, 'подменённый box обошёл P-5: ' + JSON.stringify(decoyBox.body));
  assert.equal(decoyBox.body.code, 'inbox-stale');
  assert.ok(decoyBox.body.missing.some((row) => row.includes('workflow--1.md')), JSON.stringify(decoyBox.body.missing));

  /* §3 проверяется и на маршруте: обязательное поле и известный verdict. */
  const withoutFiles = { ...report };
  delete withoutFiles.files;
  fs.writeFileSync(reportPath, JSON.stringify(withoutFiles, null, 2));
  const noFiles = await call(handler, url, { method: 'POST', body: JSON.stringify({ file: 'docs/tasks/0100/report.worker.json' }) });
  assert.equal(noFiles.status, 422, JSON.stringify(noFiles.body));
  assert.equal(noFiles.body.code, 'report-invalid');
  assert.ok(noFiles.body.missing.some((row) => row.includes('files')), JSON.stringify(noFiles.body.missing));

  fs.writeFileSync(reportPath, JSON.stringify({ ...report, verdict: 'failed' }, null, 2));
  const unknownVerdict = await call(handler, url, { method: 'POST', body: JSON.stringify({ file: 'docs/tasks/0100/report.worker.json' }) });
  assert.equal(unknownVerdict.status, 422, JSON.stringify(unknownVerdict.body));
  assert.equal(unknownVerdict.body.code, 'report-invalid');

  fs.rmSync(root, { recursive: true, force: true });
});

/*
 * Задание 0034: движок читается из карты, и «нет движка» — не ошибка, а состояние.
 * Каждый тест держит карту во временном файле и возвращает env на место, чтобы
 * соседние проверки не зависели от порядка.
 */
function engineRepo(parent, version = '2.6.9') {
  const dir = path.join(parent, 'docs', 'subagent-workflow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'VERSION'), version + '\n');
  fs.writeFileSync(path.join(dir, 'workflow.config.json'), '{}');
  return dir;
}

function engineMapFile(document) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-map-'));
  const file = path.join(dir, 'engine-roots.json');
  fs.writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document, null, 2));
  return file;
}

async function withEngineMap(document, body) {
  const previous = process.env.WF_ENGINE_ROOTS;
  process.env.WF_ENGINE_ROOTS = engineMapFile(document);
  try {
    return await body(process.env.WF_ENGINE_ROOTS);
  } finally {
    if (previous === undefined) delete process.env.WF_ENGINE_ROOTS;
    else process.env.WF_ENGINE_ROOTS = previous;
  }
}

await test('readEngine: движок в воркспейсе — mode local, путь и версия из VERSION', async () => {
  await withEngineMap({}, async () => {
    const ws = makeProject({ 'graph.json': GRAPH });
    const engine = engineRepo(ws, '2.6.9');
    const result = readEngine(ws);
    assert.equal(result.mode, 'local', 'локальный движок — mode local');
    assert.equal(path.resolve(result.path), path.resolve(engine), 'path — каталог docs/subagent-workflow');
    assert.equal(result.version, '2.6.9');
    assert.equal(result.deployed, true, 'прежнее поле deployed сохраняется для панели и тестов');
    assert.equal(result.dir, 'docs/subagent-workflow', 'прежний относительный dir сохраняется');
  });
});

await test('readEngine: карта находит внешний движок и нормализует хвостовой слэш', async () => {
  const ws = makeProject({ 'graph.json': GRAPH });
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-repo-'));
  const engine = engineRepo(repository, '2.6.9');
  await withEngineMap({}, async (mapFile) => {
    fs.writeFileSync(mapFile, JSON.stringify({ [ws + path.sep]: repository }, null, 2));
    const result = readEngine(ws);
    assert.equal(result.mode, 'mapped', 'запись карты — mode mapped');
    assert.equal(path.resolve(result.path), path.resolve(engine), 'path — движок из карты, а не воркспейс');
    assert.equal(result.version, '2.6.9', 'версия внешнего движка читается из его VERSION');
    assert.equal(result.deployed, true);
  });
});

await test('readEngine: регистр ключа нормализуется на Windows, а на POSIX решает ФС', async () => {
  const ws = makeProject({ 'graph.json': GRAPH });
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-repo-'));
  engineRepo(repository, '2.6.9');
  await withEngineMap({}, async (mapFile) => {
    fs.writeFileSync(mapFile, JSON.stringify({ [ws.toUpperCase() + path.sep]: repository }, null, 2));
    const result = readEngine(ws);
    if (process.platform === 'win32') {
      assert.equal(result.mode, 'mapped', 'ключ карты в другом регистре сопоставлен');
    } else {
      assert.equal(result.mode, 'absent', 'на POSIX регистр значим: ключ не совпал');
    }
  });
});

await test('readEngine: пустая карта — mode absent, путь и версия null, без исключения', async () => {
  const ws = makeProject({ 'graph.json': GRAPH });
  await withEngineMap({}, async () => {
    const result = readEngine(ws);
    assert.equal(result.mode, 'absent', 'ни локально, ни в карте — absent');
    assert.equal(result.path, null, 'у absent нет пути');
    assert.equal(result.version, null, 'у absent нет версии');
    assert.equal(result.deployed, false);
  });
});

await test('readEngine: битая карта и запись без движка дают absent, а не падение', async () => {
  const ws = makeProject({ 'graph.json': GRAPH });
  await withEngineMap('{ это не json ', async () => {
    const broken = readEngine(ws);
    assert.equal(broken.mode, 'absent', 'битая карта — это «нет записи»');
  });
  const missingRepository = path.join(os.tmpdir(), 'dsh-engine-missing-' + Date.now());
  await withEngineMap({ [ws]: missingRepository }, async () => {
    const stale = readEngine(ws);
    assert.equal(stale.mode, 'absent', 'запись карты без движка — тоже «нет записи»');
    assert.equal(stale.path, null);
  });
  const versionOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-partial-'));
  const partial = path.join(versionOnly, 'docs', 'subagent-workflow');
  fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(path.join(partial, 'VERSION'), '2.6.9\n');
  await withEngineMap({ [ws]: versionOnly }, async () => {
    assert.equal(readEngine(ws).mode, 'absent', 'VERSION без workflow.config.json — не движок');
  });
});

await test('readEngine: readGraph отдаёт трёхрежимный engine и прежние поля', async () => {
  const ws = makeProject({ 'graph.json': GRAPH });
  engineRepo(ws, '2.6.2');
  await withEngineMap({}, async () => {
    const payload = readGraph(makeRuntime([ws]), ws);
    assert.equal(payload.engine.mode, 'local');
    assert.equal(payload.engine.version, '2.6.2');
    assert.equal(payload.engine.deployed, true, 'старые поля не сломаны');
  });
  const bare = makeProject({ 'graph.json': GRAPH });
  await withEngineMap({}, async () => {
    const payload = readGraph(makeRuntime([bare]), bare);
    assert.equal(payload.engine.mode, 'absent');
    assert.equal(payload.engine.path, null);
    assert.equal(payload.engine.source, 'none', 'отсутствие связи называет источник none');
  });
});

/*
 * Задание 0092: режим императива приходит в той же ленте графа, из того же
 * блока workflow.config.json, что читает отказ pre-execute. Без конфига —
 * warn: чтение не падает и не выдумывает отказ.
 */
await test('readGraph: enforcement fail/warn/off, без конфига — warn', async () => {
  for (const mode of ['fail', 'warn', 'off']) {
    const ws = makeWorkflowProject(mode);
    const payload = readGraph(makeRuntime([ws]), ws);
    assert.equal(payload.enforcement.mode, mode, mode + ': режим из конфига');
    assert.equal(payload.enforcement.source, 'config', mode + ': источник config');
    assert.equal(payload.enforcement.error, undefined, mode + ': штатное чтение без причины');
  }
  const bare = makeProject({ 'graph.json': GRAPH });
  const barePayload = readGraph(makeRuntime([bare]), bare);
  assert.equal(barePayload.enforcement.mode, 'warn', 'без конфига — пилот, а не отказ');
  assert.equal(barePayload.enforcement.source, 'default');
  assert.match(String(barePayload.enforcement.error || ''), /workflow\.config\.json/u, 'причина умолчания названа');

  const broken = makeWorkflowProject(undefined);
  fs.writeFileSync(path.join(broken, 'docs', 'subagent-workflow', 'workflow.config.json'), '{ битый');
  const brokenPayload = readGraph(makeRuntime([broken]), broken);
  assert.equal(brokenPayload.enforcement.mode, 'warn', 'битый конфиг — warn');
  assert.equal(brokenPayload.enforcement.source, 'default');
});

/*
 * Задание 0035: конфиг профиля — первый источник после локального движка, и
 * ответ резолвера называет источник. Карта не читается выше конфига: связь,
 * объявленная декларативно, кнопкой не подменяется.
 */
await test('readEngine: конфиг профиля сильнее карты, источник config', async () => {
  const ws = makeProject({ 'graph.json': GRAPH });
  const configRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-config-'));
  const configEngine = engineRepo(configRepo, '2.6.14');
  const mapRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-map-repo-'));
  const mapEngine = engineRepo(mapRepo, '2.6.11');
  await withEngineMap({ [ws]: mapRepo }, async () => {
    const runtime = makeRuntime([ws], { engines: { roots: { [ws]: configRepo } } });
    for (const [label, result] of [
      ['readEngine', readEngine(ws, runtime)],
      ['readGraph', readGraph(runtime, ws).engine],
    ]) {
      assert.equal(result.mode, 'mapped', label + ': связь из конфига — mapped');
      assert.equal(result.source, 'config', label + ': источник назван config');
      assert.equal(result.installed, true, label + ': installed — булев для совместимости');
      assert.equal(path.resolve(result.path), path.resolve(configEngine), label + ': путь из конфига');
      assert.equal(path.resolve(result.root), path.resolve(configEngine), label + ': root — каталог движка');
      assert.equal(result.version, '2.6.14', label + ': версия из конфига');
      assert.notEqual(path.resolve(result.path), path.resolve(mapEngine), label + ': карта не подменяет конфиг');
    }
    const raw = readEngine(ws, { engines: { roots: { [ws]: configRepo } } });
    assert.equal(raw.source, 'config', 'объект конфига тоже принимается вторым аргументом');
  });
});

await test('readEngine: источник назван во всех состояниях', async () => {
  const localWs = makeProject({ 'graph.json': GRAPH });
  engineRepo(localWs, '2.6.9');
  const local = readEngine(localWs);
  assert.equal(local.mode, 'local');
  assert.equal(local.source, 'workspace', 'локальный движок — источник workspace');
  assert.equal(local.installed, true);

  const mapWs = makeProject({ 'graph.json': GRAPH });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-repo-'));
  engineRepo(repo, '2.6.8');
  await withEngineMap({ [mapWs]: repo }, async () => {
    assert.equal(readEngine(mapWs).source, 'mapping', 'без рантайма карта остаётся источником (T8)');
    assert.equal(readEngine(mapWs, makeRuntime([mapWs])).source, 'mapping', 'пустой конфиг не отменяет карту');
  });

  const bare = makeProject({ 'graph.json': GRAPH });
  await withEngineMap({}, async () => {
    const absent = readEngine(bare, makeRuntime([bare]));
    assert.equal(absent.mode, 'absent');
    assert.equal(absent.source, 'none', 'отсутствие связи — источник none');
    assert.equal(absent.installed, false);
    assert.equal(absent.root, null);
  });
});

await test('readEngine: битый конфиг и относительный путь не уступают карте', async () => {
  const ws = makeProject({ 'graph.json': GRAPH });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-repo-'));
  engineRepo(repo, '2.6.9');
  await withEngineMap({ [ws]: repo }, async () => {
    for (const engines of ['не-объект', 42, { roots: 'не-объект' }, { roots: [] }]) {
      const result = readEngine(ws, { engines });
      assert.equal(result.mode, 'absent', 'сломанный блок engines — нет связи: ' + JSON.stringify(engines));
      assert.equal(result.source, 'none', 'сломанный конфиг называет источник none');
    }
    const relative = readEngine(ws, { engines: { roots: { [ws]: 'docs/subagent-workflow' } } });
    assert.equal(relative.mode, 'absent', 'относительный путь в конфиге — не связь');
    const empty = readEngine(ws, { engines: { roots: { [ws]: '   ' } } });
    assert.equal(empty.mode, 'absent', 'пустая строка в конфиге — не связь');
    const stale = readEngine(ws, { engines: { roots: { [ws]: path.join(os.tmpdir(), 'dsh-engine-none-' + Date.now()) } } });
    assert.equal(stale.mode, 'absent', 'запись конфига без движка — absent');
    const other = readEngine(ws, { engines: { roots: { [ws + '-other']: repo } } });
    assert.equal(other.mode, 'mapped', 'конфиг молчит про этот воркспейс — работает карта');
    assert.equal(other.source, 'mapping');
  });
});

/*
 * Приёмка 0035: относительный путь в КАРТЕ — тоже «нет связи», а не путь от
 * cwd процесса. До правки карта разрешала значение через path.resolve и
 * отдавала ложный mapped с движком, которого никто не объявлял.
 */
await test('readEngine: относительный путь или ключ карты — absent, не связь', async () => {
  const ws = makeProject({ 'graph.json': GRAPH });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-repo-'));
  engineRepo(repo, '2.6.9');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-cwd-'));
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    /* Движок по относительному пути существует — и всё равно связью не считается. */
    engineRepo(path.join(cwd, 'engine-relative'), '2.6.9');
    await withEngineMap({ [ws]: 'engine-relative' }, async () => {
      const result = readEngine(ws);
      assert.equal(result.mode, 'absent', 'относительное значение карты — не связь');
      assert.equal(result.source, 'none', 'у такой записи нет источника');
      assert.equal(result.path, null);
    });
  } finally {
    process.chdir(previous);
  }
  try {
    /* Относительный ключ разрешился бы в сам воркспейс от cwd — и это тоже не связь. */
    process.chdir(path.dirname(ws));
    await withEngineMap({ [path.basename(ws)]: repo }, async () => {
      const result = readEngine(ws);
      assert.equal(result.mode, 'absent', 'относительный ключ карты — не связь');
    });
  } finally {
    process.chdir(previous);
  }
});

/*
 * Приёмка 0035, второй дефект: относительный КЛЮЧ в конфиге профиля — тоже не
 * объявление. До правки ключ разрешался через path.resolve от cwd и давал
 * ложный mapped/config; результат зависел от того, откуда запущена панель.
 */
await test('readEngine: относительный ключ конфига не зависит от cwd и не перекрывает карту', async () => {
  const ws = makeProject({ 'graph.json': GRAPH });
  const configRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-config-'));
  engineRepo(configRepo, '9.9.7');
  const mapRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-map-'));
  engineRepo(mapRepo, '9.9.8');
  const relativeKey = { engines: { roots: { [path.basename(ws)]: configRepo } } };
  const dotKey = { engines: { roots: { '.': configRepo } } };
  const previous = process.cwd();
  const inDir = async (dir, body) => {
    process.chdir(dir);
    try {
      return await body();
    } finally {
      process.chdir(previous);
    }
  };

  /* Карта абсолютна: относительный ключ конфига её не перекрывает. */
  await withEngineMap({ [ws]: mapRepo }, async () => {
    const parent = await inDir(path.dirname(ws), () => readEngine(ws, relativeKey));
    assert.equal(parent.mode, 'mapped', 'ключ «basename(ws)» от родителя — не связь');
    assert.equal(parent.source, 'mapping', 'карта остаётся источником, если она абсолютна');
    assert.equal(parent.version, '9.9.8', 'версия из карты, а не из подставленного конфига');
    const rootCwd = await inDir(os.tmpdir(), () => readEngine(ws, relativeKey));
    assert.equal(rootCwd.source, 'mapping', 'другой cwd не меняет ответ');
  });

  /* Карты нет: относительный ключ конфига не даёт связи вообще. */
  await withEngineMap({}, async () => {
    const parent = await inDir(path.dirname(ws), () => readEngine(ws, relativeKey));
    assert.equal(parent.mode, 'absent', 'относительный ключ конфига — не связь, карты нет');
    assert.equal(parent.source, 'none');
    const rootCwd = await inDir(os.tmpdir(), () => readEngine(ws, relativeKey));
    assert.equal(rootCwd.mode, 'absent', 'ответ не зависит от cwd');
  });

  /* Ключ "." при cwd = сам воркспейс — самый опасный случай. */
  await withEngineMap({}, async () => {
    const dot = await inDir(ws, () => readEngine(ws, dotKey));
    assert.equal(dot.mode, 'absent', 'ключ «.» при cwd воркспейса — не связь');
    assert.equal(dot.source, 'none');
  });
  await withEngineMap({ [ws]: mapRepo }, async () => {
    const dot = await inDir(ws, () => readEngine(ws, dotKey));
    assert.equal(dot.mode, 'mapped', 'карта абсолютна — отвечает она');
    assert.equal(dot.source, 'mapping', 'ключ «.» конфиг не объявляет');
    assert.equal(dot.version, '9.9.8');
  });

  /* Контроль: абсолютный ключ конфига работает и от cwd не зависит. */
  const absoluteKey = { engines: { roots: { [ws]: configRepo } } };
  await withEngineMap({ [ws]: mapRepo }, async () => {
    for (const dir of [ws, path.dirname(ws), os.tmpdir()]) {
      const absolute = await inDir(dir, () => readEngine(ws, absoluteKey));
      assert.equal(absolute.source, 'config', 'абсолютный ключ конфига — источник config при любом cwd');
      assert.equal(absolute.version, '9.9.7');
    }
  });
});

/*
 * Задание 0042. Свойства узла показывают настоящую модель: маршрут разрешается
 * из graph.models[alias] и сверяется с каталогом службы llm на момент чтения.
 * Отсутствующая модель — статус missing, недоступный каталог — unknown; дефолт
 * не подставляется, а сбой службы не роняет чтение структуры.
 */
function savedText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function catalogRuntime(root, catalog, providers = [{ id: 'opencode', name: 'OpenCode' }]) {
  return makeRuntime([root], {}, {
    providerName: 'spawn',
    getLlm: () => ({
      listProviders: () => providers,
      listModels: async (id) => (id === 'opencode' ? catalog : []),
    }),
  });
}

await test('readGraph: modelRoute разрешён из каталога службы llm', async () => {
  const root = makeProject({
    'graph.json': {
      version: 1,
      models: {
        work: { provider: 'opencode', model: 'deepseek-v4.1-flash', family: 'deepseek' },
        gone: { provider: 'opencode', model: 'model-x' },
      },
      nodes: [
        { id: 'a', role: 'lead', model: 'work' },
        { id: 'b', role: 'dev', model: 'gone' },
        { id: 'c', role: 'dev', model: 'alias-without-declaration' },
        { id: 'd', role: 'dev' },
      ],
      edges: [],
    },
  });
  const runtime = catalogRuntime(root, [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek', family: 'deepseek' },
  ]);
  const payload = await readGraph(runtime, root);
  const nodes = new Map(payload.graph.nodes.map((node) => [node.id, node]));

  assert.deepEqual(nodes.get('a').modelRoute, {
    alias: 'work',
    provider: 'opencode',
    model: 'deepseek-v4.1-flash',
    family: 'deepseek',
    status: 'available',
  }, 'available: алиас разрешён в provider/model с семейством');
  assert.equal(nodes.get('a').role, 'lead', 'прежние поля узла не меняются');

  assert.equal(nodes.get('b').modelRoute.status, 'missing', 'модели нет в каталоге — missing');
  assert.match(nodes.get('b').modelRoute.reason, /model-x/u, 'причина называет пропавшую модель');

  assert.equal(nodes.get('c').modelRoute.status, 'unknown', 'алиас без объявления — unknown');
  assert.match(nodes.get('c').modelRoute.reason, /не объявлен/u);

  assert.equal(nodes.get('d').modelRoute, null, 'узел без модели — modelRoute: null');
});

await test('readGraph: без ответа службы llm маршрут unknown, чтение не падает', async () => {
  const root = makeProject({ 'graph.json': GRAPH });
  const runtime = makeRuntime([root], {}, {
    getLlm: () => ({ listProviders: () => { throw new Error('llm unavailable'); }, listModels: async () => [] }),
  });
  const payload = readGraph(runtime, root);
  assert.deepEqual(payload.errors, [], 'сбой службы llm — не ошибка структуры');
  const critic = payload.graph.nodes.find((node) => node.id === 'critic');
  assert.equal(critic.modelRoute.status, 'unknown');
  assert.match(critic.modelRoute.reason, /llm unavailable/u, 'причина отказа службы видна человеку');
  assert.equal(critic.modelRoute.provider, 'opencode', 'объявленный маршрут не теряется');
});

await test('readGraph: без ожидания статус не выдумывает available', async () => {
  const root = makeProject({ 'graph.json': GRAPH });
  const runtime = catalogRuntime(root, [{ id: 'deepseek-v4.1-flash' }, { id: 'glm-5.3-flash' }]);
  const immediate = readGraph(runtime, root);
  const syncRoute = immediate.graph.nodes.find((node) => node.id === 'analyst-a').modelRoute;
  assert.equal(syncRoute.status, 'unknown', 'синхронное чтение не выдаёт непроверенное за available');
  assert.match(syncRoute.reason, /асинхронно/u);

  const waited = await readGraph(runtime, root);
  assert.equal(waited.graph.nodes.find((node) => node.id === 'analyst-a').modelRoute.status, 'available',
    'ожидание уточняет статус по тому же каталогу');
});

await test('/api/models: каталог читается при каждом вызове, at и source на месте', async () => {
  const root = makeProject({ 'graph.json': GRAPH });
  let catalog = [{ id: 'deepseek-v4.1-flash' }];
  const runtime = makeRuntime([root], {}, {
    getLlm: () => ({
      listProviders: () => [{ id: 'opencode', name: 'OpenCode' }],
      listModels: async () => catalog,
    }),
  });
  const handler = createWebHandler(runtime);
  const first = await call(handler, API_PREFIX + '/api/models');
  catalog = [{ id: 'deepseek-v4.1-flash' }, { id: 'glm-5.3-flash', family: 'zhipu' }];
  const second = await call(handler, API_PREFIX + '/api/models');
  const ids = (body) => ((body.providers || [])[0] || {}).models || [];

  assert.equal(first.body.ok, true);
  assert.deepEqual(ids(first.body).map((item) => item.id), ['deepseek-v4.1-flash']);
  assert.deepEqual(ids(second.body).map((item) => item.id), ['deepseek-v4.1-flash', 'glm-5.3-flash'],
    'второй вызов видит изменение каталога: кэша между вызовами нет');
  assert.equal(ids(second.body)[1].family, 'zhipu', 'семейство модели отдаётся каталогом');
  assert.equal(second.body.source, 'llm');
  assert.match(String(second.body.at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/u,
    'at — ISO 8601 со смещением');
  assert.ok(Math.abs(Date.now() - Date.parse(second.body.at)) < 60 * 1000, 'at — момент чтения');
});

await test('/api/models: недоступная служба — отказ с рецептом, а не пустой список', async () => {
  const root = makeProject({ 'graph.json': GRAPH });
  const broken = makeRuntime([root], {}, {
    getLlm: () => ({ listProviders: () => { throw new Error('llm unavailable'); }, listModels: async () => [] }),
  });
  const refused = await call(createWebHandler(broken), API_PREFIX + '/api/models');
  assert.equal(refused.body.ok, false);
  assert.deepEqual(refused.body.providers, []);
  assert.match(refused.body.error, /llm unavailable/u, 'ошибка называет отказ службы');
  assert.ok(savedText(refused.body.fix), 'отказ без рецепта');
  assert.match(String(refused.body.at), /^\d{4}-\d{2}-\d{2}T/u, 'отказ тоже датирован');

  const bare = makeRuntime([root], {});
  const absent = await call(createWebHandler(bare), API_PREFIX + '/api/models');
  assert.equal(absent.body.ok, false);
  assert.match(absent.body.error, /не подключена/u);
  assert.ok(savedText(absent.body.fix), 'без службы тоже нужен рецепт');
});


/*
 * Задание 0085: метка стороны в квитанциях. Резолвер один: runtime.me, затем
 * карта participants по нормализованному пути (регистр и слэши не важны), затем
 * имя каталога. Карта объявлена, а нашего корня в ней нет — ответ несёт
 * identity-not-declared и имя каталога: подписывать чужим именем молча нельзя.
 */
function identityProject() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-0085-'));
  const root = path.join(parent, 'structure-ws');
  const peer = path.join(parent, 'reach-proxy');
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.mkdirSync(peer, { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'coordinator', role: 'координатор', model: 'work' }],
    edges: [],
    folders: [],
  }, null, 2));
  const box = path.join(parent, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  return { parent, root, peer, box };
}

function identityContract(box, invited) {
  fs.writeFileSync(path.join(box, 'contract-folder-1.md'), [
    'Format: dsh-exchange/1-contract',
    'Portal: ' + box.split(path.sep).join('/'),
    'Rev: 1',
    'Initiator: reach-proxy',
    'Invited: ' + invited.join(', '),
    'Created: 2026-11-05T10:00+03:00',
    '',
  ].join('\n'));
}

function identityReceipts(box) {
  const dir = path.join(box, 'threads');
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) files.push({ name: entry.name, text: fs.readFileSync(full, 'utf8') });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files;
}

function identityFrom(text) {
  const match = /^From:\s*(.+)$/mu.exec(text);
  return match ? match[1].trim() : '';
}

await test('0085: join подписан меткой карты, путь сравнивается нормализованно', async () => {
  const p = identityProject();
  identityContract(p.box, ['structure']);
  const runtime = makeRuntime([p.root], {
    participants: { structure: p.root.split(path.sep).join('/'), reach: p.peer },
  });
  const res = await folderCall(createWebHandler(runtime), 'join', {
    root: p.root,
    folder: { id: 'folder-1', box: p.box, participants: ['structure', 'reach-proxy'], orchestrator: 'coordinator' },
    contract: 'contract-folder-1.md',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const accepted = identityReceipts(p.box).find((item) => /^Status:\s*accepted$/mu.test(item.text));
  assert.ok(accepted, 'квитанция accepted написана');
  assert.equal(identityFrom(accepted.text), 'structure', 'From — метка карты, а не имя каталога');
  assert.match(accepted.name, /--structure--\d{2}\.md$/u, 'имя квитанции несёт ту же метку');
});

await test('0085: runtime.me важнее карты участников', async () => {
  const p = identityProject();
  identityContract(p.box, ['structure']);
  const runtime = makeRuntime([p.root], {
    participants: { structure: p.root, reach: p.peer },
    me: 'analyst',
  });
  const res = await folderCall(createWebHandler(runtime), 'join', {
    root: p.root,
    folder: { id: 'folder-1', box: p.box, participants: ['structure', 'reach-proxy'], orchestrator: 'coordinator' },
    contract: 'contract-folder-1.md',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const accepted = identityReceipts(p.box).find((item) => /^Status:\s*accepted$/mu.test(item.text));
  assert.ok(accepted, 'квитанция accepted написана');
  assert.equal(identityFrom(accepted.text), 'analyst', 'me сильнее карты');
});

await test('0085: карта без нашего корня — имя каталога и identity-not-declared', async () => {
  const p = identityProject();
  identityContract(p.box, ['structure']);
  const runtime = makeRuntime([p.root], { participants: { reach: p.peer } });
  const res = await folderCall(createWebHandler(runtime), 'join', {
    root: p.root,
    folder: { id: 'folder-1', box: p.box, participants: ['structure', 'reach-proxy'], orchestrator: 'coordinator' },
    contract: 'contract-folder-1.md',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const accepted = identityReceipts(p.box).find((item) => /^Status:\s*accepted$/mu.test(item.text));
  assert.ok(accepted, 'квитанция accepted написана');
  assert.equal(identityFrom(accepted.text), path.basename(p.root), 'без своей метки — имя каталога');
  const warning = (res.body.warnings || []).find((item) => item && item.code === 'identity-not-declared');
  assert.ok(warning, 'предупреждение identity-not-declared в ответе: ' + JSON.stringify(res.body.warnings || null));
  assert.match(warning.message, new RegExp(path.basename(p.root)), 'message называет использованную метку');
  assert.ok(savedText(warning.fix), 'у предупреждения есть рецепт');
});

await test('0085: пустой карты нет — имя каталога без предупреждения (контроль 0047)', async () => {
  const p = identityProject();
  identityContract(p.box, ['structure']);
  const res = await folderCall(createWebHandler(makeRuntime([p.root])), 'join', {
    root: p.root,
    folder: { id: 'folder-1', box: p.box, participants: ['structure', 'reach-proxy'], orchestrator: 'coordinator' },
    contract: 'contract-folder-1.md',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const accepted = identityReceipts(p.box).find((item) => /^Status:\s*accepted$/mu.test(item.text));
  assert.ok(accepted, 'квитанция accepted написана');
  assert.equal(identityFrom(accepted.text), path.basename(p.root), 'без карты — имя каталога');
  assert.equal(res.body.warnings, undefined, 'карты нет — предупреждения нет');
});

await test('0085: decline подписан меткой карты, имя файла совпадает с From', async () => {
  const p = identityProject();
  identityContract(p.box, ['structure']);
  const runtime = makeRuntime([p.root], { participants: { structure: p.root, reach: p.peer } });
  const res = await folderCall(createWebHandler(runtime), 'decline', {
    root: p.root,
    folder: { id: 'folder-1', box: p.box, participants: ['structure', 'reach-proxy'] },
    contract: 'contract-folder-1.md',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const declined = identityReceipts(p.box).find((item) => /^Status:\s*declined$/mu.test(item.text));
  assert.ok(declined, 'квитанция declined написана');
  assert.equal(identityFrom(declined.text), 'structure', 'отказ подписан меткой карты');
  assert.match(declined.name, /--structure--\d{2}\.md$/u, 'имя файла несёт ту же метку');
});

await test('0085: decline без карты и с одной invited — метка контракта', async () => {
  const p = identityProject();
  identityContract(p.box, ['structure']);
  const res = await folderCall(createWebHandler(makeRuntime([p.root])), 'decline', {
    root: p.root,
    folder: { id: 'folder-1', box: p.box, participants: ['structure', 'reach-proxy'] },
    contract: 'contract-folder-1.md',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const declined = identityReceipts(p.box).find((item) => /^Status:\s*declined$/mu.test(item.text));
  assert.ok(declined, 'квитанция declined написана');
  assert.equal(identityFrom(declined.text), 'structure', 'отказ адресован приглашённой метке');
  assert.match(declined.name, /--structure--\d{2}\.md$/u);
});

await test('0085: decline без карты и с двумя invited — имя каталога, без угадывания', async () => {
  const p = identityProject();
  identityContract(p.box, ['structure', 'school']);
  const res = await folderCall(createWebHandler(makeRuntime([p.root])), 'decline', {
    root: p.root,
    folder: { id: 'folder-1', box: p.box, participants: ['structure', 'reach-proxy'] },
    contract: 'contract-folder-1.md',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const declined = identityReceipts(p.box).find((item) => /^Status:\s*declined$/mu.test(item.text));
  assert.ok(declined, 'квитанция declined написана');
  assert.equal(identityFrom(declined.text), path.basename(p.root), 'две приглашённые метки — имя каталога');
});

/*
 * Задание 0082: письма, ждущие разбора, видны без открывания ящика. Счётчик
 * один — exchangeUnread поверх scanExchange из lib/obligations.js; GET
 * /api/exchange отдаёт его полем unread рядом с прежними полями ответа.
 */
function unreadProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-unread-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.mkdirSync(path.join(root, 'coordination', 'threads', 'critic-report'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [
      { id: 'coordinator', role: 'координатор' },
      { id: 'worker', role: 'исполнитель' },
    ],
    edges: [{ from: 'coordinator', to: 'worker', kind: 'delegate' }],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      participants: ['structure', 'peer'],
      paths: { structure: root },
      orchestrator: 'coordinator',
    }],
  }, null, 2));
  const letter = (to) => 'Format: dsh-exchange/1\nFrom: peer\nTo: ' + to
    + '\nDate: 2026-11-05T10:00+03:00\nThread: critic-report\nStatus: request\nSubject: x\n\nтекст\n';
  fs.writeFileSync(path.join(root, 'coordination', 'threads', 'critic-report', 'a.md'), letter('structure'));
  fs.writeFileSync(path.join(root, 'coordination', 'threads', 'critic-report', 'b.md'), letter('peer'));
  return root;
}

await test('0082: exchangeUnread считает письма этому воркспейсу, GET /api/exchange отдаёт unread', async () => {
  await withStore(async () => {
    const root = unreadProject();
    const unread = exchangeUnread({ root });
    assert.equal(unread.total, 1, 'письмо To: structure — одно непрочитанное');
    assert.deepEqual(unread.folders, [{ id: 'folder-1', unread: 1 }], 'число видно по папке');
    assert.equal(unread.error, undefined, 'сканер не отказал');

    const byRuntime = exchangeUnread({ runtime: makeRuntime([root]) });
    assert.equal(byRuntime.total, 1, 'без root корень берётся у runtime');

    const res = await call(createWebHandler(makeRuntime([root])), API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.unread, { total: 1, folders: [{ id: 'folder-1', unread: 1 }], stale: 0 },
      'ответ несёт unread той же формы, что exchangeUnread');
    assert.deepEqual(res.body.folders.map((item) => item.id), ['folder-1'], 'прежние folders на месте');
    assert.ok(Array.isArray(res.body.links), 'прежние links на месте');
    assert.equal(typeof res.body.total, 'number', 'прежнее поле total не подменено счётчиком');
  });
});

await test('0082: битая структура — exchangeUnread не бросает и называет причину', async () => {
  const root = makeProject(null);
  const unread = exchangeUnread({ root });
  assert.equal(unread.total, 0);
  assert.deepEqual(unread.folders, []);
  assert.match(unread.error, /structure|обязанности/u, 'причина — отсутствие объявленной структуры');
});

/*
 * Задание 0113: поле unread отвечает на вопрос «что ждёт хода». Форма ответа
 * прежняя — { total, folders: [{ id, unread }] }, — но счёт теперь берётся из
 * exchangeAttention: request/question без нашего ответа, а не вся адресованная
 * корреспонденция (report/answer/ack/invitation давали 192 вместо ~25).
 */
function attentionProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-attention-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const dir = path.join(root, 'coordination', 'threads', 'critic-report');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      participants: ['structure', 'peer'],
      paths: { structure: root },
      orchestrator: 'coordinator',
    }],
  }, null, 2));
  const letter = (status, replyTo) => 'Format: dsh-exchange/1\nFrom: peer\nTo: structure\n'
    + 'Date: 2026-11-06T10:00+03:00\nThread: critic-report\nStatus: ' + status + '\n'
    + (replyTo ? 'Reply-To: ' + replyTo + '\n' : '') + 'Subject: x\n\nтекст\n';
  fs.writeFileSync(path.join(dir, 'open-request.md'), letter('request'));
  fs.writeFileSync(path.join(dir, 'open-question.md'), letter('question'));
  const answered = path.join(dir, 'answered-request.md');
  fs.writeFileSync(answered, letter('request'));
  for (const status of ['report', 'answer', 'ack', 'invitation']) {
    fs.writeFileSync(path.join(dir, status + '.md'), letter(status));
  }
  /* Наш ответ: письмо от structure с Reply-To на путь заявки. */
  fs.writeFileSync(path.join(dir, 'reply.md'), 'Format: dsh-exchange/1\nFrom: structure\nTo: peer\n'
    + 'Date: 2026-11-06T10:05+03:00\nThread: critic-report\nStatus: answer\n'
    + 'Reply-To: ' + answered + '\nSubject: re\n\nответ\n');
  return root;
}

await test('0113: exchangeUnread считает требующие хода, а не всю корреспонденцию', async () => {
  await withStore(async () => {
    const root = attentionProject();
    const unread = exchangeUnread({ root });
    assert.equal(unread.total, 2, 'только request и question без ответа');
    assert.deepEqual(unread.folders, [{ id: 'folder-1', unread: 2 }], 'форма папки прежняя: id и unread');
    assert.equal(unread.error, undefined, 'сканер не отказал');

    const byRuntime = exchangeUnread({ runtime: makeRuntime([root]) });
    assert.equal(byRuntime.total, 2, 'без root корень берётся у runtime');

    const res = await call(createWebHandler(makeRuntime([root])), API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.unread, { total: 2, folders: [{ id: 'folder-1', unread: 2 }], stale: 0 },
      'GET /api/exchange отдаёт внимание в прежнем поле unread');
    assert.equal(typeof res.body.total, 'number', 'прежнее поле total не подменено счётчиком');
  });
});

/*
 * Задание 0128: окно 14 суток. Даты писем считаются от текущего момента, потому
 * что exchangeUnread зовёт exchangeAttention без параметра now: фиксированная
 * дата сделала бы тест просроченным через две недели.
 */
function stampDaysAgo(days) {
  const date = new Date(Date.now() - days * 86400000);
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    + sign + pad(Math.trunc(offset / 60)) + ':' + pad(offset % 60);
}

function windowProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-window-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const dir = path.join(root, 'coordination', 'threads', 'critic-report');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      participants: ['structure', 'peer'],
      paths: { structure: root },
      orchestrator: 'coordinator',
    }],
  }, null, 2));
  const letter = (status, date, subject) => 'Format: dsh-exchange/1\nFrom: peer\nTo: structure\n'
    + 'Date: ' + date + '\nThread: critic-report\nStatus: ' + status + '\nSubject: ' + subject + '\n\nтекст\n';
  fs.writeFileSync(path.join(dir, 'old.md'), letter('request', stampDaysAgo(20), 'старая заявка'));
  fs.writeFileSync(path.join(dir, 'fresh.md'), letter('question', stampDaysAgo(1), 'свежий вопрос'));
  return root;
}

await test('0128: exchangeUnread отдаёт stale рядом с total (окно 14 суток)', async () => {
  await withStore(async () => {
    const root = windowProject();
    const unread = exchangeUnread({ root });
    assert.equal(unread.total, 1, 'свежая заявка — в счёте');
    assert.equal(unread.stale, 1, 'старая — в просроченных');
    assert.deepEqual(unread.folders, [{ id: 'folder-1', unread: 1 }], 'форма папки 0082 не менялась');
    assert.deepEqual(Object.keys(unread).sort(), ['folders', 'stale', 'total'], 'stale добавлено аддитивно');
  });
});

await test('0128: GET /api/exchange размечает заявки и отдаёт stale', async () => {
  await withStore(async () => {
    const root = windowProject();
    const handler = createWebHandler(makeRuntime([root], { me: 'structure' }));
    const res = await call(handler, API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.unread.total, 1);
    assert.equal(res.body.unread.stale, 1);
    const fresh = res.body.facts.find((fact) => /fresh\.md$/u.test(fact.file));
    const old = res.body.facts.find((fact) => /old\.md$/u.test(fact.file));
    assert.ok(fresh && old, 'оба письма — факты');
    assert.equal(fresh.attention, true, 'свежая заявка размечена для кнопки «Закрыть»');
    assert.equal(fresh.stale, undefined, 'свежая не просрочена');
    assert.equal(fresh.subject, 'свежий вопрос', 'тема заявки доходит до подписи ack');
    assert.equal(old.attention, true, 'просроченная тоже закрывается, а не только считается');
    assert.equal(old.stale, true, 'просроченная помечена отдельно');
    /* Разметка аддитивна: прежние поля факта на месте. */
    assert.equal(typeof fresh.from, 'string');
    assert.equal(typeof fresh.to, 'string');
    assert.equal(typeof fresh.status, 'string');
  });
});

await test('0128: closeExchangeRequest пишет ack с Reply-To полным путём, повтор идемпотентен', async () => {
  await withStore(async () => {
    const root = windowProject();
    const letter = path.join(root, 'coordination', 'threads', 'critic-report', 'fresh.md');
    const closed = closeExchangeRequest({ root, path: letter });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal(closed.reason, 'closed');
    assert.equal(closed.replyTo, 'threads/critic-report/fresh.md', 'Reply-To — полный путь от папки обмена');
    const text = fs.readFileSync(closed.path, 'utf8');
    assert.match(text, /^Format: dsh-exchange\/1$/mu);
    assert.match(text, /^From: structure$/mu, 'From — метка своего ящика');
    assert.match(text, /^To: peer$/mu, 'To — автор заявки');
    assert.match(text, /^Thread: critic-report$/mu);
    assert.match(text, /^Status: ack$/mu);
    assert.match(text, /^Reply-To: threads\/critic-report\/fresh\.md$/mu);
    assert.match(text, /^Subject: Закрыто: свежий вопрос$/mu);
    assert.equal(exchangeAttention({ root }).total, 0, 'ack снял заявку тем же правилом, что ответ');
    assert.equal(exchangeAttention({ root }).stale, 1, 'просроченная осталась видимой');
    /* Повтор: тот же файл, второй ack не пишется. */
    const again = closeExchangeRequest({ root, path: letter });
    assert.equal(again.ok, true);
    assert.equal(again.reason, 'already-closed');
    assert.equal(again.path, closed.path, 'возвращается уже написанный ack');
    const acks = fs.readdirSync(path.dirname(closed.path)).filter((name) => /--close(-\d+)?\.md$/u.test(name));
    assert.equal(acks.length, 1, 'второго ack-письма нет');
  });
});

await test('0128: POST /api/exchange/close закрывает заявку и снимает счётчик', async () => {
  await withStore(async () => {
    const root = windowProject();
    const handler = createWebHandler(makeRuntime([root], { me: 'structure' }));
    const before = await call(handler, API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
    assert.equal(before.body.unread.total, 1);
    const res = await call(handler, API_PREFIX + '/api/exchange/close', {
      method: 'POST',
      body: JSON.stringify({ root, path: 'coordination/threads/critic-report/fresh.md' }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.match(res.body.replyTo, /threads\/critic-report\/fresh\.md/u);
    const after = await call(handler, API_PREFIX + '/api/exchange?root=' + encodeURIComponent(root));
    assert.equal(after.body.unread.total, 0, 'счётчик снят');
    assert.equal(after.body.unread.stale, 1, 'просроченная осталась видимой');
  });
});

await test('0128: POST /api/exchange/close без письма — отказ с рецептом', async () => {
  await withStore(async () => {
    const root = windowProject();
    const handler = createWebHandler(makeRuntime([root], { me: 'structure' }));
    const res = await call(handler, API_PREFIX + '/api/exchange/close', {
      method: 'POST',
      body: JSON.stringify({ root, path: 'coordination/threads/critic-report/none.md' }),
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'letter-not-found');
    assert.match(res.body.fix, /path/u);
  });
});

await test('0113: ошибка ящика — unread 0 у папки, общий счёт не падает', async () => {
  await withStore(async () => {
    const root = portalProject([
      portalFolder('folder-bad', 'no-such-box'),
      portalFolder('folder-good', 'coordination'),
    ]);
    fs.mkdirSync(path.join(root, 'coordination', 'threads'), { recursive: true });
    fs.writeFileSync(path.join(root, 'coordination', 'threads', 'open.md'),
      portalHead('workflow', 'structure', '2026-11-06T10:00+03:00'));
    let unread;
    assert.doesNotThrow(() => { unread = exchangeUnread({ root }); });
    assert.equal(unread.total, 1, 'счёт читаемой папки сохранён');
    assert.deepEqual(unread.folders, [{ id: 'folder-bad', unread: 0 }, { id: 'folder-good', unread: 1 }],
      'ошибка папки — ноль, а не исключение');
    for (const folder of unread.folders) assert.deepEqual(Object.keys(folder).sort(), ['id', 'unread'], 'форма папки не расширена');
  });
});

/*
 * Задание 0082: шаблон публичной структуры объявляет обязанность exchange-read
 * и при этом остаётся валидной структурой (version/nodes/edges).
 */
await test('0082: шаблон public-structure.json объявляет exchange-read и остаётся структурой', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'public-structure.json');
  const template = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(template.version, 1);
  assert.ok(Array.isArray(template.nodes) && template.nodes.length >= 3, 'в шаблоне есть узлы');
  assert.ok(Array.isArray(template.edges), 'в шаблоне есть связи');
  const duty = (template.obligations || []).find((item) => item && item.id === 'exchange-read');
  assert.ok(duty, 'обязанность exchange-read объявлена');
  assert.equal(duty.check.kind, 'exchange');
  assert.equal(duty.check.max, 0, 'порог — ноль непрочитанных');
  assert.equal(duty.enforce, 'warn', 'нарушение предупреждает, а не блокирует');
  assert.ok(String(duty.title || '').trim(), 'у обязанности есть человеческое название');
});


/* ------------------------------------------------------------------------- *
 * 0167: отчёт валидатора и настройки моделей через GET /api/validation
 * ------------------------------------------------------------------------- */

/** Исправная структура с прямыми маршрутами: модели есть в каталоге checkDeps. */
function validationProject() {
  return makeProject({ 'graph.json': validationGraph('deepseek-v4.1-flash') });
}

function validationGraph(workerModel) {
  return {
    version: 1,
    nodes: [
      { id: 'coordinator', role: 'координатор', provider: 'opencode', model: 'deepseek-v4.1-flash' },
      { id: 'worker', role: 'исполнитель', provider: 'opencode', model: workerModel },
      { id: 'judge', role: 'приёмщик', provider: 'opencode', model: 'deepseek-v4.1-flash' },
    ],
    edges: [
      { from: 'coordinator', to: 'worker', kind: 'delegate' },
      { from: 'worker', to: 'judge', kind: 'review' },
      { from: 'judge', to: 'coordinator', kind: 'report' },
    ],
  };
}

function writeValidatorSettings(root, settings) {
  fs.writeFileSync(path.join(root, 'structure', 'validator.json'), JSON.stringify(settings, null, 2));
}

await test('0167: GET /api/validation отдаёт отчёт и дефолт forceModelCheck true', async () => {
  const root = validationProject();
  const handler = createWebHandler(makeRuntime([root], {}, checkDeps()));
  const response = await call(handler, API_PREFIX + '/api/validation?root=' + encodeURIComponent(root));
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true, JSON.stringify(response.body.findings));
  assert.deepEqual(response.body.findings, []);
  assert.equal(response.body.forceModelCheck, true, 'без файла проверка включена');
  assert.match(response.body.settingsPath, /structure[\\/]validator\.json$/u);
  assert.equal(response.body.catalog.ok, true);
  assert.equal(response.body.structure.nodes, 3);
});

await test('0167: GET /api/validation читает structure/validator.json', async () => {
  const root = validationProject();
  writeValidatorSettings(root, { forceModelCheck: false, updatedBy: 'заказчик' });
  const handler = createWebHandler(makeRuntime([root], {}, checkDeps()));
  const response = await call(handler, API_PREFIX + '/api/validation?root=' + encodeURIComponent(root));
  assert.equal(response.status, 200);
  assert.equal(response.body.forceModelCheck, false, 'файл главнее дефолта');
  assert.equal(response.body.settings.updatedBy, 'заказчик');
  assert.equal(response.body.ok, true);
});

await test('0167: GET /api/validation называет модель вне каталога', async () => {
  const root = makeProject({ 'graph.json': validationGraph('нет-такой') });
  const handler = createWebHandler(makeRuntime([root], {}, checkDeps()));
  const response = await call(handler, API_PREFIX + '/api/validation?root=' + encodeURIComponent(root));
  assert.equal(response.status, 200, 'находки — это данные, а не отказ маршрута');
  assert.equal(response.body.ok, false);
  const item = response.body.findings.find((finding) => finding.code === 'model-missing' && finding.node === 'worker');
  assert.ok(item, JSON.stringify(response.body.findings));
  assert.equal(item.severity, 'error');
  assert.match(item.message, /deepseek-v4\.1-flash/u);
});

await test('0167: allowUnknownModel делает находку warning, отчёт остаётся ok', async () => {
  const root = makeProject({ 'graph.json': validationGraph('нет-такой') });
  writeValidatorSettings(root, { allowUnknownModel: ['worker'], updatedBy: 'заказчик' });
  const handler = createWebHandler(makeRuntime([root], {}, checkDeps()));
  const response = await call(handler, API_PREFIX + '/api/validation?root=' + encodeURIComponent(root));
  assert.equal(response.status, 200);
  const item = response.body.findings.find((finding) => finding.code === 'model-missing' && finding.node === 'worker');
  assert.ok(item, 'находка остаётся');
  assert.equal(item.severity, 'warning');
  assert.equal(response.body.ok, true);
});

await test('0167: без каталога llm отчёт считает инварианты и не выдумывает модели', async () => {
  const root = validationProject();
  const handler = createWebHandler(makeRuntime([root], {}));
  const response = await call(handler, API_PREFIX + '/api/validation?root=' + encodeURIComponent(root));
  assert.equal(response.status, 200);
  assert.equal(response.body.catalog.ok, false);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.findings.some((finding) => finding.code === 'model-missing'), false);
  const warning = response.body.findings.find((finding) => finding.code === 'catalog-unavailable');
  assert.ok(warning, 'недоступный каталог назван предупреждением');
  assert.equal(warning.severity, 'warning');
});

await test('0167: GET /api/validation отказывает чужому корню', async () => {
  const root = validationProject();
  const handler = createWebHandler(makeRuntime([root], {}, checkDeps()));
  const response = await call(handler, API_PREFIX + '/api/validation?root=' + encodeURIComponent(path.join(root, '..', 'чужой')));
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'no-root');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  /* The whole message, not its first line: "Expected values to be strictly equal" alone
     says nothing about which pair of values differed. */
  const detail = failure.error && failure.error.message ? failure.error.message : String(failure.error);
  console.error('  ' + detail.split('\n').join('\n  '));
}
console.log('API TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);