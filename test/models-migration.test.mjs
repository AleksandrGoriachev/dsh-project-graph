#!/usr/bin/env node
/**
 * Задание 0067 — тесты мигратора tools/migrate-models.mjs.
 *
 *   MODELS MIGRATION TEST OK: N/N
 *
 * Проверки идут на временной копии structure/graph.json, настоящий файл не
 * трогается. Копия приводится к старому формату (алиасы + models{}), чтобы
 * тест работал и до миграции, и после неё.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const TOOL = path.join(repo, 'tools', 'migrate-models.mjs');
const REAL = path.join(repo, 'structure', 'graph.json');

let done = 0;
function check(name, fn) {
  fn();
  done += 1;
  console.log('ok ' + done + ' — ' + name);
}

function localDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function workspace(raw) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0067-migrate-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const file = path.join(root, 'structure', 'graph.json');
  fs.writeFileSync(file, raw, 'utf8');
  return { root, file };
}

function run(root, ...args) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: 'utf8' });
}

function output(result) {
  return String(result.stdout || '') + String(result.stderr || '');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The real graph, turned back into the legacy shape: models{} + node.model alias. */
function legacyFixture() {
  const real = readJson(REAL);
  const byId = new Map(real.nodes.map((node) => [node.id, node]));
  const routeOf = (id) => {
    const node = byId.get(id);
    assert.ok(node, 'узла ' + id + ' нет в structure/graph.json');
    if (node.provider && node.model) return { provider: node.provider, model: node.model };
    /* Файл ещё не мигрирован: маршрут узла лежит в models{} по алиасу. */
    const entry = real.models && typeof node.model === 'string' ? real.models[node.model] : null;
    assert.ok(entry && entry.provider && entry.model, 'у узла ' + id + ' нет маршрута для фикстуры');
    return { provider: entry.provider, model: entry.model };
  };
  const models = {
    work: { ...routeOf('coordinator'), family: 'flash' },
    critic: routeOf('judge'),
    designer: routeOf('designer'),
  };
  const alias = { coordinator: 'work', worker: 'work', judge: 'critic', designer: 'designer', critic: 'work' };
  const nodes = real.nodes.map((node) => {
    const copy = structuredClone(node);
    delete copy.provider;
    delete copy.family;
    copy.model = alias[copy.id];
    return copy;
  });
  /* legacy-поле modelAlias и своё family узла: обе ветки миграции должны отработать. */
  const coordinator = nodes.find((node) => node.id === 'coordinator');
  coordinator.modelAlias = 'work';
  const worker = nodes.find((node) => node.id === 'worker');
  worker.family = 'own-family';
  return { version: real.version, models, nodes, folders: real.folders, edges: real.edges };
}

const legacy = legacyFixture();
const legacyRaw = JSON.stringify(legacy, null, 2) + '\n';
const expected = {
  version: legacy.version,
  nodes: legacy.nodes.map((node) => ({
    id: node.id,
    role: node.role,
    brief: node.brief,
    prompt: node.prompt,
    x: node.x,
    y: node.y,
    schedule: node.schedule,
  })),
  edges: structuredClone(legacy.edges),
  folders: structuredClone(legacy.folders),
};

let ws = workspace(legacyRaw);

check('--dry-run: печатает изменения и не трогает файл', () => {
  const before = fs.readFileSync(ws.file, 'utf8');
  const beforeMtime = fs.statSync(ws.file).mtimeMs;
  const result = run(ws.root, '--dry-run');
  assert.equal(result.status, 0, output(result));
  const text = output(result);
  assert.match(text, /coordinator: work -> opencode-go\/deepseek-v4\.1-flash/);
  assert.match(text, /critic: work -> opencode-go\/deepseek-v4\.1-flash/);
  assert.match(text, /models\{\} удалён/);
  assert.equal(fs.readFileSync(ws.file, 'utf8'), before);
  assert.equal(fs.statSync(ws.file).mtimeMs, beforeMtime);
});

let backupPath = '';
check('--write: бэкап до записи, models{} нет, маршруты прямые', () => {
  const result = run(ws.root, '--write');
  assert.equal(result.status, 0, output(result));
  backupPath = ws.file + '.bak-models-' + localDate(new Date());
  assert.ok(fs.existsSync(backupPath), 'бэкап не создан');
  assert.equal(fs.readFileSync(backupPath, 'utf8'), legacyRaw, 'бэкап не равен исходному файлу');
  assert.match(output(result), /бэкап: structure\/graph\.json\.bak-models-/);
  const doc = readJson(ws.file);
  assert.ok(!Object.hasOwn(doc, 'models'), 'models{} остался');
  for (const node of doc.nodes) {
    assert.equal(typeof node.provider, 'string', 'нет provider у ' + node.id);
    assert.ok(node.provider.length > 0);
    assert.equal(typeof node.model, 'string', 'нет model у ' + node.id);
    assert.ok(node.model.length > 0);
    assert.ok(!Object.hasOwn(node, 'modelAlias'), 'modelAlias остался у ' + node.id);
  }
});

check('--write: все поля графа сохранены дословно', () => {
  const doc = readJson(ws.file);
  assert.equal(doc.version, expected.version);
  assert.deepEqual(doc.nodes.map((node) => node.id), legacy.nodes.map((node) => node.id), 'порядок узлов изменился');
  for (const [index, want] of expected.nodes.entries()) {
    const got = doc.nodes[index];
    for (const field of ['id', 'role', 'brief', 'prompt', 'x', 'y']) {
      assert.deepEqual(got[field], want[field], field + ' узла ' + got.id + ' изменился');
    }
    assert.deepEqual(got.schedule, want.schedule, 'schedule узла ' + got.id + ' изменился');
  }
  assert.deepEqual(doc.edges, expected.edges, 'связи изменились');
  assert.deepEqual(doc.folders, expected.folders, 'папки изменились');
  assert.equal(doc.nodes.find((node) => node.id === 'coordinator').family, 'flash', 'family из карты не перенесён');
  assert.equal(doc.nodes.find((node) => node.id === 'worker').family, 'own-family', 'своё family узла перетёрто картой');
});

check('--write повторно: идемпотентен, «изменений нет», файл байт-в-байт', () => {
  const before = fs.readFileSync(ws.file, 'utf8');
  const backupBefore = fs.readFileSync(backupPath, 'utf8');
  const result = run(ws.root, '--write');
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /изменений нет/);
  assert.equal(fs.readFileSync(ws.file, 'utf8'), before);
  assert.equal(fs.readFileSync(backupPath, 'utf8'), backupBefore, 'повторный прогон переписал бэкап');
});

check('--dry-run после миграции: «изменений нет» и файл не тронут', () => {
  const before = fs.readFileSync(ws.file, 'utf8');
  const beforeMtime = fs.statSync(ws.file).mtimeMs;
  const result = run(ws.root, '--dry-run');
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /изменений нет/);
  assert.equal(fs.readFileSync(ws.file, 'utf8'), before);
  assert.equal(fs.statSync(ws.file).mtimeMs, beforeMtime);
});

check('алиас без записи в models{}: отказ, файл и бэкап не тронуты', () => {
  const broken = structuredClone(legacy);
  broken.models = {};
  const raw = JSON.stringify(broken, null, 2) + '\n';
  const bad = workspace(raw);
  const result = run(bad.root, '--write');
  assert.equal(result.status, 1, 'ожидался отказ exit 1, получено: ' + output(result));
  const text = output(result);
  assert.match(text, /отказ/);
  assert.match(text, /work/);
  assert.match(text, /алиас/);
  assert.equal(fs.readFileSync(bad.file, 'utf8'), raw, 'файл переписан при отказе');
  assert.ok(!fs.existsSync(bad.file + '.bak-models-' + localDate(new Date())), 'бэкап создан при отказе');
});

check('битый models{}: отказ без записи', () => {
  const broken = structuredClone(legacy);
  broken.models = ['work'];
  const raw = JSON.stringify(broken, null, 2) + '\n';
  const bad = workspace(raw);
  const result = run(bad.root, '--write');
  assert.equal(result.status, 1, 'ожидался отказ exit 1, получено: ' + output(result));
  assert.match(output(result), /models/);
  assert.equal(fs.readFileSync(bad.file, 'utf8'), raw);
});

console.log('MODELS MIGRATION TEST OK: ' + done + '/' + done);
