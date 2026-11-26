/**
 * Перенос структуры из репозитория в store (задание 0345).
 *
 * Тесты идут на временных каталогах: настоящий ~/.dsh не трогается, store
 * подменяется переменной DSH_PROJECT_GRAPH_STORE — тем же именем, что читает
 * lib/store.js. Успешный перенос проверяется с настоящим git: удаление обязано
 * пройти через git rm, иначе файл остался бы в индексе и режим не переключился.
 *
 * Резервная копия обязана лежать вне разбора фрагментов: lib/load.js рекурсивно
 * читает любой *.json под store, поэтому копия с расширением .json сделала бы
 * граф недействительным. Тест перечитывает store глазами панели после --apply.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STORE_ENV, resolveStructure } from '../lib/store.js';
import { readStructure } from '../lib/load.js';
import { buildGraph } from '../lib/graph.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'migrate-structure.mjs');

const LINKS = { version: 1, edges: [{ from: 'worker', to: 'coordinator', kind: 'report' }] };

const GRAPH = {
  version: 1,
  nodes: [
    {
      id: 'coordinator',
      role: 'координатор',
      x: 10,
      y: 10,
      anchors: { consumes: ['A1', 'A2'], source: 'coordinator' },
    },
    { id: 'worker', role: 'исполнитель', anchors: { consumes: ['A2'] } },
  ],
  edges: [{ from: 'coordinator', to: 'worker', kind: 'delegate' }],
  folders: [{
    id: 'folder-1', box: { path: 'coordination' }, participants: ['structure', 'workflow'], orchestrator: 'coordinator',
  }],
};

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Проект с папкой structure и переданным graph.json. */
function project(graph, graphText) {
  const root = tempDir('pg-migrate-root-');
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const text = graphText === undefined ? JSON.stringify(graph, null, 2) : graphText;
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), text, 'utf8');
  return root;
}

/** Store-каталог: mkdtemp, но путь живёт только через env-подмену. */
function storeDir() {
  return tempDir('pg-migrate-store-');
}

/** Запустить инструмент с подменённым store; cwd — корень репозитория. */
function runTool(repo, args, store) {
  const result = spawnSync(process.execPath, [TOOL, '--repo', repo, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, [STORE_ENV]: store },
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    out: String(result.stdout || '') + String(result.stderr || ''),
  };
}

/** Git-репозиторий с уже добавленной структурой — как в живом проекте. */
function initGit(repo) {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ': ' + String(result.stderr || ''));
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'migrate-test@example.invalid']);
  git(['config', 'user.name', 'migrate test']);
  git(['add', '--', 'structure']);
  git(['commit', '-q', '-m', 'fixture structure']);
}

/** Разрешение структуры с подменённым store. */
function resolvedWithStore(repo, store) {
  const previous = process.env[STORE_ENV];
  process.env[STORE_ENV] = store;
  try {
    return resolveStructure(repo);
  } finally {
    if (previous === undefined) delete process.env[STORE_ENV];
    else process.env[STORE_ENV] = previous;
  }
}

/** Прочитать структуру глазами панели: подменённый store и buildGraph. */
function readAsStore(repo, store) {
  const previous = process.env[STORE_ENV];
  process.env[STORE_ENV] = store;
  try {
    const read = readStructure(repo, 'structure');
    const built = buildGraph(read.files, { dirName: 'structure' });
    return { read, built };
  } finally {
    if (previous === undefined) delete process.env[STORE_ENV];
    else process.env[STORE_ENV] = previous;
  }
}

/** Все *.json рекурсивно под каталогом: любой лишний обязан валить тест. */
function allJson(directory) {
  const found = [];
  const walk = (current, base) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = base ? base + '/' + entry.name : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.name.toLowerCase().endsWith('.json')) found.push(rel);
    }
  };
  walk(directory, '');
  return found.sort();
}

function backups(store) {
  const dir = path.join(store, 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

test('успешный перенос: store получает граф, источник удалён, режим store', () => {
  const root = project(GRAPH);
  fs.writeFileSync(path.join(root, 'structure', 'links.json'), JSON.stringify(LINKS), 'utf8');
  const store = storeDir();
  initGit(root);

  const result = runTool(root, ['--apply'], store);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /удалено из репозитория: structure\/graph\.json, structure\/links\.json/u);
  assert.match(result.stdout, /узлов 2, рёбер 2, папок 1, якорей 3/u);
  assert.match(result.stdout, /backups[\\/]graph\.backup-.+\.json\.bak/u,
    'резервная копия названа .json.bak и лежит в backups/');
  assert.match(result.stdout, /readStructure — режим store/u);

  const stored = JSON.parse(fs.readFileSync(path.join(store, 'graph.json'), 'utf8'));
  assert.deepEqual(stored, GRAPH, 'store получил граф без потерь');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, 'links.json'), 'utf8')), LINKS,
    'store получил links.json без потерь');
  assert.equal(fs.existsSync(path.join(root, 'structure', 'graph.json')), false,
    'источник удалён из рабочего дерева');
  assert.equal(fs.existsSync(path.join(root, 'structure', 'links.json')), false,
    'links.json удалён из рабочего дерева');

  assert.deepEqual(allJson(store), ['graph.json', 'links.json'],
    'в store только канонические фрагменты: лишний *.json сделал бы граф недействительным');
  const backupNames = backups(store).filter((name) => /^graph\.backup-.+\.json\.bak$/u.test(name));
  assert.equal(backupNames.length, 1, 'рядом в backups/ ровно одна резервная копия');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, 'backups', backupNames[0]), 'utf8')), GRAPH,
    'резервная копия совпадает с источником');

  const { read, built } = readAsStore(root, store);
  assert.equal(read.mode, 'store', 'панель читает store');
  assert.deepEqual(read.files.map((file) => file.name), ['structure/graph.json', 'structure/links.json'],
    'фрагменты только канонические');
  assert.deepEqual(read.problems, [], 'чтение без проблем');
  assert.deepEqual(built.errors, [], 'buildGraph без ошибок: нет дубля coordinator');
  assert.equal(built.graph.nodes.length, 2);
  assert.equal(built.graph.edges.length, 2);
  assert.equal(built.graph.folders.length, 1);

  const resolved = resolvedWithStore(root, store);
  assert.equal(resolved.mode, 'store', 'после переноса проект читается из store');
  assert.equal(resolved.dir, path.resolve(store));
  assert.deepEqual(JSON.parse(fs.readFileSync(resolved.graphFile, 'utf8')), GRAPH,
    'resolveStructure отдаёт те же узлы');

  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  assert.match(status.stdout, /^D  structure\/graph\.json$/mu, 'удаление графа видно в индексе');
  assert.match(status.stdout, /^D  structure\/links\.json$/mu, 'удаление связей видно в индексе');
});

test('без --apply: напечатан план, ни store, ни репозиторий не изменены', () => {
  const root = project(GRAPH);
  const store = storeDir();
  const before = fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8');

  const result = runTool(root, [], store);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /План/u, 'план напечатан');
  assert.match(result.stdout, /backups[\\/]graph\.backup-<ISO>\.json\.bak/u,
    'план называет копию вне .json');
  assert.match(result.stdout, /без --apply ни store, ни репозиторий не изменены/u);
  assert.equal(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'), before,
    'источник не тронут');
  assert.equal(fs.existsSync(path.join(store, 'graph.json')), false, 'store не получил граф');
  assert.equal(fs.readdirSync(store).length, 0, 'store остался пустым');
});

test('битый graph.json — отказ, источник на месте, store не тронут, код 1', () => {
  const root = project(null, '{ "version": 1, "nodes": [ ');
  const store = storeDir();
  const sentinel = JSON.stringify({ version: 1, nodes: [], marker: 'store-not-touched' }, null, 2);
  fs.writeFileSync(path.join(store, 'graph.json'), sentinel, 'utf8');

  const result = runTool(root, ['--apply'], store);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stderr, /не разбирается как JSON/u);
  assert.equal(fs.existsSync(path.join(root, 'structure', 'graph.json')), true,
    'битый источник остаётся на месте');
  assert.equal(fs.readFileSync(path.join(store, 'graph.json'), 'utf8'), sentinel,
    'store не перезаписан');
  assert.deepEqual(backups(store), [], 'резервная копия не создавалась');
});

test('граф без координатора — отказ, код 1, источник и store не тронуты', () => {
  const root = project({ version: 1, nodes: [{ id: 'worker', role: 'исполнитель' }], edges: [] });
  const store = storeDir();

  const result = runTool(root, ['--apply'], store);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stderr, /координатор/u);
  assert.equal(fs.existsSync(path.join(root, 'structure', 'graph.json')), true,
    'источник не удалён');
  assert.equal(fs.existsSync(path.join(store, 'graph.json')), false, 'store не получил граф');
  assert.equal(fs.readdirSync(store).length, 0, 'store не тронут');
});

test('--check различает режимы repo и store и ничего не пишет', () => {
  const repoProject = project(GRAPH);
  const repoStore = storeDir();
  const repoResult = runTool(repoProject, ['--check'], repoStore);
  assert.equal(repoResult.status, 0, repoResult.out);
  assert.match(repoResult.stdout, /режим: repo/u);
  assert.match(repoResult.stdout, /store-граф: нет/u);
  assert.equal(fs.existsSync(path.join(repoProject, 'structure', 'graph.json')), true);
  assert.equal(fs.readdirSync(repoStore).length, 0, '--check ничего не пишет');

  const storeProject = tempDir('pg-migrate-root-');
  const store = storeDir();
  fs.writeFileSync(path.join(store, 'graph.json'), JSON.stringify(GRAPH), 'utf8');
  const storeResult = runTool(storeProject, ['--check'], store);
  assert.equal(storeResult.status, 0, storeResult.out);
  assert.match(storeResult.stdout, /режим: store/u);
  assert.match(storeResult.stdout, /store-граф: есть/u);
  assert.equal(fs.existsSync(path.join(storeProject, 'structure')), false,
    '--check не создаёт structure/ в проекте');
});

test('аргументы: --check и --apply вместе — код 2', () => {
  const root = project(GRAPH);
  const result = runTool(root, ['--check', '--apply'], storeDir());
  assert.equal(result.status, 2, result.out);
  assert.match(result.stderr, /взаимоисключающие/u);
});

test('R5: проект без git — отказ до записи, store не тронут', () => {
  const root = project(GRAPH);
  const store = storeDir();

  const result = runTool(root, ['--apply'], store);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stderr, /не git-репозиторий/u);
  assert.equal(fs.existsSync(path.join(root, 'structure', 'graph.json')), true, 'источник не удалён');
  assert.equal(fs.existsSync(path.join(store, 'graph.json')), false, 'store не получил граф');
  assert.deepEqual(backups(store), [], 'резервных копий нет: записи не было');
});

test('R6: повторный --apply — идемпотентный выход 0 «уже в store»', () => {
  const root = project(GRAPH);
  const store = storeDir();
  initGit(root);
  assert.equal(runTool(root, ['--apply'], store).status, 0);
  const before = fs.readFileSync(path.join(store, 'graph.json'), 'utf8');
  const backupsBefore = backups(store);

  const second = runTool(root, ['--apply'], store);
  assert.equal(second.status, 0, second.out);
  assert.match(second.stdout, /уже в store/u);
  assert.equal(fs.readFileSync(path.join(store, 'graph.json'), 'utf8'), before, 'store-граф не переписан');
  assert.deepEqual(backups(store), backupsBefore, 'повторный прогон не плодит копии');
  assert.deepEqual(allJson(store), ['graph.json'], 'в store по-прежнему только канонический граф');
});

test('R4: существующий store сохранён перед перезаписью и links убран по источнику', () => {
  const root = project(GRAPH);
  initGit(root);
  const store = storeDir();
  const oldGraph = {
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }, { id: 'old', role: 'исполнитель' }],
    edges: [],
  };
  fs.writeFileSync(path.join(store, 'graph.json'), JSON.stringify(oldGraph), 'utf8');
  fs.writeFileSync(path.join(store, 'links.json'), JSON.stringify(LINKS), 'utf8');

  const result = runTool(root, ['--apply'], store);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /существующий store-граф сохранён/u);
  assert.match(result.stdout, /отличается от источника — перезапись по --apply/u);
  assert.match(result.stdout, /существующий store-links сохранён/u);
  assert.match(result.stdout, /источник links.json не содержит/u);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, 'graph.json'), 'utf8')), GRAPH,
    'store приведён к источнику');
  assert.equal(fs.existsSync(path.join(store, 'links.json')), false,
    'links.json источника нет — лишний store-links убран');
  const previousGraph = backups(store).filter((name) => /^graph\.previous-.+\.json\.bak$/u.test(name));
  const previousLinks = backups(store).filter((name) => /^links\.previous-.+\.json\.bak$/u.test(name));
  assert.equal(previousGraph.length, 1, 'старый store-граф сохранён');
  assert.equal(previousLinks.length, 1, 'старые store-links сохранены');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, 'backups', previousGraph[0]), 'utf8')), oldGraph);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, 'backups', previousLinks[0]), 'utf8')), LINKS);
  assert.deepEqual(allJson(store), ['graph.json'], 'после сверки лишних *.json в store нет');

  const { read, built } = readAsStore(root, store);
  assert.equal(read.mode, 'store');
  assert.deepEqual(read.files.map((file) => file.name), ['structure/graph.json']);
  assert.deepEqual(built.errors, []);
});

test('R1/R2: лишний graph.backup-*.json в store валит перенос, источник остаётся', () => {
  const root = project(GRAPH);
  initGit(root);
  const store = storeDir();
  /* Ровно дефект ревью: копия в корне store читается как второй фрагмент графа. */
  fs.writeFileSync(path.join(store, 'graph.backup-2026-01-01T00-00-00-000Z.json'),
    JSON.stringify(GRAPH), 'utf8');

  const result = runTool(root, ['--apply'], store);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stderr, /store-проверка: buildGraph вернул ошибки/u);
  assert.match(result.stderr, /coordinator/u);
  assert.equal(fs.existsSync(path.join(root, 'structure', 'graph.json')), true,
    'источник не удалён при провале сверки store');
  assert.equal(fs.existsSync(path.join(store, 'graph.backup-2026-01-01T00-00-00-000Z.json')), true,
    'лишний файл не проглочен молча');
});
