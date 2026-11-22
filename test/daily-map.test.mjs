/**
 * 0181: реестр ежедневных запусков — производная графов, а не ручной файл.
 *
 * Проверяется чистый слой (buildDailyRunsMap) и CLI на временной копии
 * репозитория: без флагов реестр пересобирается, --check сравнивает и падает
 * при расхождении. Живой реестр тоже проверяется — он обязан совпадать с
 * графами, иначе узлы снова начнут теряться.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDailyRunsMap } from '../lib/daily-map.js';
import {
  FORMAT,
  buildDocument,
  compareDocument,
  workspaceSources,
} from '../tools/rebuild-daily-runs-map.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MAP_FILE = path.join(REPO, 'docs', 'daily-runs-map.json');
const CLI = path.join(REPO, 'tools', 'rebuild-daily-runs-map.mjs');

let passed = 0;
const failures = [];
function test(name, body) {
  try {
    body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

const graph = (nodes) => ({ version: 1, nodes });

test('узлы берутся из графа с id и role, порядок объявления сохранён', () => {
  const map = buildDailyRunsMap({
    'ws-a': graph([
      { id: 'coordinator', role: 'координатор' },
      { id: 'reviewer-1', role: 'ревьюер' },
      { id: 'worker', role: 'исполнитель' },
    ]),
  });
  assert.deepEqual(map['ws-a'].nodes, [
    { id: 'coordinator', role: 'координатор' },
    { id: 'reviewer-1', role: 'ревьюер' },
    { id: 'worker', role: 'исполнитель' },
  ]);
});

test('reviewer-1 попадает автоматически — карта не отстаёт от пятиузлового графа', () => {
  const map = buildDailyRunsMap({
    'default-workspace': graph([
      { id: 'coordinator', role: 'координатор' },
      { id: 'worker', role: 'исполнитель' },
      { id: 'judge', role: 'приёмщик' },
      { id: 'Critic', role: 'critic', schedule: { at: '01:32' } },
      { id: 'reviewer-1', role: 'ревьюер' },
    ]),
  });
  assert.deepEqual(
    map['default-workspace'].nodes.map((node) => node.id),
    ['coordinator', 'worker', 'judge', 'Critic', 'reviewer-1'],
  );
});

test('время запуска читается из node.at и node.schedule.at, расписание — по времени и id', () => {
  const map = buildDailyRunsMap({
    ws: graph([
      { id: 'coordinator', role: 'координатор' },
      { id: 'reviewer-1', role: 'ревьюер', at: '03:30' },
      { id: 'critic', role: 'критик', schedule: { at: '03:00', timeZone: 'Europe/Moscow' } },
      { id: 'alpha', role: 'исполнитель', at: '03:00' },
    ]),
  });
  const entry = map.ws;
  assert.equal(entry.nodes[1].at, '03:30');
  assert.equal(entry.nodes[2].at, '03:00');
  assert.ok(!('at' in entry.nodes[0]), 'у узла без времени поля at нет');
  assert.deepEqual(entry.schedule, [
    { id: 'alpha', at: '03:00' },
    { id: 'critic', at: '03:00' },
    { id: 'reviewer-1', at: '03:30' },
  ]);
});

test('нет узлов с at — поля schedule нет', () => {
  const map = buildDailyRunsMap({ ws: graph([{ id: 'worker', role: 'исполнитель' }]) });
  assert.ok(!('schedule' in map.ws), 'пустое расписание не пишется');
});

test('порядок стабилен: повторный вызов даёт тот же результат', () => {
  const input = { ws: graph([{ id: 'b', role: 'x' }, { id: 'a', role: 'y', at: '03:00' }]) };
  assert.equal(JSON.stringify(buildDailyRunsMap(input)), JSON.stringify(buildDailyRunsMap(input)));
});

test('битые узлы пропускаются, а не бросают', () => {
  const map = buildDailyRunsMap({
    a: graph([null, 'строка', {}, { id: '   ' }, { id: ' ok ', role: 7, at: 5 }]),
    b: null,
    c: {},
    d: { nodes: 'нет' },
  });
  assert.deepEqual(map.a.nodes, [{ id: 'ok', role: '' }]);
  assert.ok(!('b' in map), 'граф-не-объект пропускается, а не превращается в пустой воркспейс');
  assert.deepEqual(map.c, { nodes: [] }, 'граф без nodes — пустой список');
  assert.deepEqual(map.d, { nodes: [] }, 'объект без массива nodes даёт пустой список');
});

test('вход не мутируется', () => {
  const input = { ws: graph([{ id: 'worker', role: 'исполнитель', schedule: { at: '03:00' } }]) };
  const before = JSON.stringify(input);
  buildDailyRunsMap(input);
  assert.equal(JSON.stringify(input), before);
});

test('пустой или не-объектный вход — пустая карта', () => {
  for (const value of [null, undefined, [], 'граф', 42]) {
    assert.deepEqual(buildDailyRunsMap(value), {});
  }
});

test('документ реестра: формат, правило, источники и карта', () => {
  const sources = workspaceSources();
  const document = buildDocument({ 'ws-a': graph([{ id: 'reviewer-1', role: 'ревьюер' }]) }, sources);
  assert.equal(document.format, FORMAT);
  assert.equal(typeof document.rule, 'string');
  assert.deepEqual(Object.keys(document.sources), ['dsh-project-graph', 'default-workspace']);
  assert.deepEqual(document.workspaces['ws-a'].nodes, [{ id: 'reviewer-1', role: 'ревьюер' }]);
});

test('compareDocument: совпадение — ok, расхождение — причина', () => {
  const expected = buildDocument({ ws: graph([{ id: 'reviewer-1', role: 'ревьюер' }]) }, workspaceSources());
  assert.deepEqual(compareDocument(expected, JSON.parse(JSON.stringify(expected))), { ok: true });
  const stale = JSON.parse(JSON.stringify(expected));
  stale.workspaces.ws.nodes.pop();
  const result = compareDocument(expected, stale);
  assert.equal(result.ok, false);
  assert.match(result.reason, /nodes/u);
  const extra = JSON.parse(JSON.stringify(expected));
  extra.workspaces.gone = { nodes: [] };
  assert.equal(compareDocument(expected, extra).ok, false);
});

test('живой реестр содержит reviewer-1 у default-workspace', () => {
  const document = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  const entry = document.workspaces['default-workspace'];
  assert.ok(entry, 'в реестре нет default-workspace');
  const ids = entry.nodes.map((node) => node.id);
  for (const id of ['coordinator', 'worker', 'judge', 'Critic', 'reviewer-1']) {
    assert.ok(ids.includes(id), 'в реестре default-workspace нет ' + id);
  }
});

test('живой --check зелёный: реестр совпадает с графами', () => {
  const result = spawnSync(process.execPath, [CLI, '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
  assert.match(result.stdout, /^OK check:/u);
});

test('неизвестный флаг — ошибка аргументов (exit 2)', () => {
  const result = spawnSync(process.execPath, [CLI, '--write'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node tools\/rebuild-daily-runs-map\.mjs \[--check\]/u);
});

test('CLI на временной копии: пересборка, зелёный --check, красный на расхождении', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-map-0181-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'lib', 'daily-map.js'), path.join(repo, 'lib', 'daily-map.js'));
  fs.copyFileSync(CLI, path.join(repo, 'tools', 'rebuild-daily-runs-map.mjs'));
  const write = (dir, value) => {
    fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(value, null, 2));
  };
  write(repo, graph([
    { id: 'coordinator', role: 'координатор' },
    { id: 'worker', role: 'исполнитель' },
    { id: 'reviewer-1', role: 'ревьюер' },
  ]));
  write(path.join(root, 'default-workspace'), graph([
    { id: 'coordinator', role: 'координатор' },
    { id: 'Critic', role: 'critic', schedule: { at: '01:32' } },
    { id: 'reviewer-1', role: 'ревьюер' },
  ]));

  const run = (args) => spawnSync(process.execPath, [path.join(repo, 'tools', 'rebuild-daily-runs-map.mjs'), ...args], {
    cwd: repo,
    encoding: 'utf8',
  });

  const rebuild = run([]);
  assert.equal(rebuild.status, 0, (rebuild.stdout || '') + (rebuild.stderr || ''));
  const built = JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'daily-runs-map.json'), 'utf8'));
  assert.ok(built.workspaces['dsh-project-graph'].nodes.some((node) => node.id === 'reviewer-1'));
  assert.ok(built.workspaces['default-workspace'].nodes.some((node) => node.id === 'reviewer-1'));

  assert.equal(run(['--check']).status, 0);

  built.workspaces['default-workspace'].nodes.pop();
  fs.writeFileSync(path.join(repo, 'docs', 'daily-runs-map.json'), JSON.stringify(built, null, 2));
  const stale = run(['--check']);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /^FAIL check:/u);
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('DAILY-MAP TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
