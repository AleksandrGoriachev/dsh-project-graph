/**
 * The live map is pure: the host hands over its live agents, the structure hands
 * over its nodes, and the function decides who works where. These tests pin the
 * three rules the panel depends on: cwd decides the project, a label decides the
 * node, and a role that is not declared stays unknown instead of being invented.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  attributeSessions, bindSessions, isInsideRoot, labelNamesNode, mapLiveAgents, mapNodeActivity, mapRunActivity,
  normalizePath, readSessionActivity, readSessionCwd,
} from '../lib/live.js';

let passed = 0;
/* A skipped test is not a passing one: the run line says how many were skipped, so a
   green suite on a Node without zstd cannot be quoted as proof of the live path. */
let skipped = 0;
let skipFlag = false;
function skip() {
  skipFlag = true;
}
const failures = [];
function test(name, body) {
  skipFlag = false;
  try {
    body();
    if (skipFlag) skipped += 1;
    else passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

/** Both zstd directions are needed: one writes the fixture, the other reads the journal. */
const zstdReady = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';

const ROOT = 'C:\\Work\\Project';
const NODES = [{ id: 'judge', role: 'приёмщик' }, { id: 'worker', role: 'исполнитель' }, { id: 'lead-code' }];

test('агент этого корня сопоставляется по cwd и метке', () => {
  const mapped = mapLiveAgents([
    { id: 'a1', cwd: ROOT + '\\sub', label: 'judge', state: 'running' },
    { id: 'a2', cwd: ROOT, title: 'worker: делает работу', state: 'running' },
  ], ROOT, NODES);
  assert.deepEqual(mapped.active, ['judge', 'worker']);
  assert.deepEqual(mapped.unknown, []);
  assert.equal(mapped.agents.length, 2);
  assert.deepEqual(mapped.agents[0], { id: 'a1', label: 'judge', cwd: ROOT + '\\sub', node: 'judge' });
});

test('регистр и разделители пути не мешают', () => {
  const mapped = mapLiveAgents([
    { id: 'a1', cwd: 'c:/work/project/SUB', label: 'acceptor:judge', state: 'running' },
    { id: 'a2', cwd: 'C:\\WORK\\PROJECT\\', title: 'lead-code', state: 'running' },
  ], ROOT, NODES);
  assert.deepEqual(mapped.active, ['judge', 'lead-code']);
  assert.equal(normalizePath('C:\\Work\\Project\\'), 'c:/work/project');
  assert.equal(isInsideRoot('c:/work/project/sub', ROOT), true);
});

test('агент чужого корня не привязывается ни к одному узлу', () => {
  const mapped = mapLiveAgents([
    { id: 'foreign', cwd: 'C:/Elsewhere/project', label: 'judge', state: 'running' },
    /* Сосед по префиксу — не ребёнок: ProjectX не внутри Project. */
    { id: 'sibling', cwd: 'C:/Work/ProjectX', label: 'worker', state: 'running' },
  ], ROOT, NODES);
  assert.deepEqual(mapped.active, []);
  assert.deepEqual(mapped.unknown, []);
  assert.deepEqual(mapped.agents, []);
});

test('агент без роли честно попадает в unknown', () => {
  const mapped = mapLiveAgents([
    { id: 'a4', cwd: ROOT, title: 'безымянный агент', state: 'running' },
  ], ROOT, NODES);
  assert.deepEqual(mapped.active, []);
  assert.deepEqual(mapped.unknown, ['a4']);
  assert.equal(mapped.agents[0].node, null);
});

test('id узла ищется отдельным словом, а не подстрокой', () => {
  assert.equal(labelNamesNode('judge', 'judge'), true);
  assert.equal(labelNamesNode('role:judge', 'judge'), true);
  assert.equal(labelNamesNode('acceptor:judge — проверяет', 'judge'), true);
  assert.equal(labelNamesNode('judgement', 'judge'), false);
  assert.equal(labelNamesNode('judge-2', 'judge'), false);
  assert.equal(labelNamesNode('judge_2', 'judge'), false);
  assert.equal(labelNamesNode('предjudge', 'judge'), false);
  assert.equal(labelNamesNode('lead-code', 'lead-code'), true);
  assert.equal(labelNamesNode('lead code', 'lead-code'), false);
  assert.equal(labelNamesNode('', 'judge'), false);
});

test('роль агента тоже называет узел', () => {
  const mapped = mapLiveAgents([
    { id: 'a5', cwd: ROOT, role: 'judge', state: 'running' },
  ], ROOT, NODES);
  assert.deepEqual(mapped.active, ['judge']);
  assert.equal(mapped.agents[0].label, 'judge');
});

/*
 * Задание 0089. Роль в метке — второй способ назвать узел, и он честен только
 * пока роль объявляет РОВНО один узел: у worker и designer одна роль
 * «исполнитель», и выбор одного из них был бы догадкой. Id узла всегда сильнее.
 */
test('роль называет узел, только когда её объявляет ровно один узел', () => {
  const nodes = [
    { id: 'worker', role: 'исполнитель' },
    { id: 'designer', role: 'исполнитель' },
    { id: 'judge', role: 'приёмщик' },
  ];
  const mapped = mapLiveAgents([
    { id: 'a1', cwd: ROOT, label: 'приёмщик', state: 'running' },
    { id: 'a2', cwd: ROOT, label: 'исполнитель', state: 'running' },
    { id: 'a3', cwd: ROOT, label: 'исполнитель:designer', state: 'running' },
  ], ROOT, nodes);
  const byId = new Map(mapped.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.get('a1').node, 'judge', 'роль объявлена одним узлом — сопоставлена');
  assert.equal(byId.get('a2').node, null, 'роль двух узлов не угадывается');
  assert.ok(mapped.unknown.includes('a2'), 'неоднозначная роль остаётся вне структуры');
  assert.equal(byId.get('a3').node, 'designer', 'id в метке побеждает роль');
  assert.deepEqual(mapped.active, ['judge', 'designer']);
});

test('роль сравнивается словом и без учёта регистра', () => {
  const upper = mapLiveAgents([{ id: 'a1', cwd: ROOT, label: 'ПРИЁМЩИК', state: 'running' }], ROOT, NODES);
  assert.equal(upper.agents[0].node, 'judge');
  /* «приёмщики» — другое слово, а не роль: подстрока ролью не считается. */
  const plural = mapLiveAgents([{ id: 'a2', cwd: ROOT, label: 'приёмщики', state: 'running' }], ROOT, NODES);
  assert.equal(plural.agents[0].node, null);
  assert.deepEqual(plural.unknown, ['a2']);
});

test('завершённый агент не считается живым', () => {
  const mapped = mapLiveAgents([
    { id: 'done', cwd: ROOT, label: 'judge', state: 'done' },
    { id: 'failed', cwd: ROOT, label: 'worker', state: 'error' },
    { id: 'stopped', cwd: ROOT, label: 'judge', running: false },
  ], ROOT, NODES);
  assert.deepEqual(mapped.active, []);
  assert.deepEqual(mapped.unknown, []);
  assert.deepEqual(mapped.agents, []);
});

test('узел без метки не выдумывается, даже если cwd верный', () => {
  const mapped = mapLiveAgents([
    { id: 'anon', cwd: ROOT, state: 'running' },
  ], ROOT, NODES);
  assert.deepEqual(mapped.active, []);
  assert.deepEqual(mapped.unknown, ['anon']);
});

test('пустые и битые входные данные не ломают функцию', () => {
  assert.deepEqual(mapLiveAgents(null, ROOT, NODES), { active: [], unknown: [], agents: [] });
  assert.deepEqual(mapLiveAgents([], ROOT, NODES), { active: [], unknown: [], agents: [] });
  assert.deepEqual(mapLiveAgents([null, 42, {}], ROOT, NODES), { active: [], unknown: [], agents: [] });
  assert.deepEqual(mapLiveAgents([{ id: 'x', cwd: ROOT, label: 'judge', state: 'running' }], '', NODES),
    { active: [], unknown: [], agents: [] });
  assert.deepEqual(mapLiveAgents([{ id: 'x', cwd: ROOT, label: 'judge', state: 'running' }], ROOT, null).active,
    []);
});

test('один агент не дублирует узел, два агента одного узла — тоже', () => {
  const mapped = mapLiveAgents([
    { id: 'a1', cwd: ROOT, label: 'judge', state: 'running' },
    { id: 'a2', cwd: ROOT, label: 'acceptor:judge', state: 'running' },
  ], ROOT, NODES);
  assert.deepEqual(mapped.active, ['judge']);
  assert.equal(mapped.agents.length, 2);
  assert.deepEqual(mapped.agents.map((agent) => agent.node), ['judge', 'judge']);
});

/*
 * Задание 0044. Привязка сессии к узлу — чистая проекция: свежесть, метка и пин
 * решают, кто на узле, и ни один из них не пишет structure/*.json. Свежесть
 * сравнивается по at сессий, поэтому часы сюда не подмешиваются.
 */
const BIND_T = Date.parse('2026-11-03T17:28:00+03:00');
const BIND_NODES = [
  { id: 'coordinator', role: 'координатор' },
  { id: 'worker', role: 'исполнитель' },
  { id: 'judge', role: 'приёмщик' },
];
const BIND_FOLDERS = [{ id: 'folder-1', orchestrator: 'coordinator' }];

test('привязка: самая свежая сессия садится на оркестратора, source=auto', () => {
  const result = bindSessions({
    root: ROOT,
    sessions: [{ id: 'session-new', at: BIND_T, running: true }, { id: 'session-old', at: BIND_T - 60 * 60000, running: false }],
    nodes: BIND_NODES,
    folders: BIND_FOLDERS,
    agents: [],
    pins: {},
    now: BIND_T + 5 * 60000,
  });
  assert.deepEqual(result.binding, {
    node: 'coordinator',
    session: 'session-new',
    at: BIND_T,
    source: 'auto',
    ambiguous: [{ id: 'session-new', at: BIND_T }],
  });
  assert.equal(result.reason, undefined);
});

test('привязка: порядок sessions не важен, свежесть решает', () => {
  const result = bindSessions({
    root: ROOT,
    sessions: [{ id: 'session-a', at: BIND_T - 10 * 60000 }, { id: 'session-b', at: BIND_T - 20 * 60000 }],
    nodes: BIND_NODES,
    folders: BIND_FOLDERS,
    agents: [],
    pins: {},
  });
  assert.equal(result.binding.session, 'session-a');
  const moved = bindSessions({
    root: ROOT,
    sessions: [{ id: 'session-a', at: BIND_T - 10 * 60000 }, { id: 'session-c', at: BIND_T }],
    nodes: BIND_NODES,
    folders: BIND_FOLDERS,
    agents: [],
    pins: {},
  });
  assert.equal(moved.binding.session, 'session-c', 'привязка идёт за новой сессией');
});

test('привязка: метка перекрывает авто, пин перекрывает авто, снятие возвращает авто', () => {
  const sessions = [
    { id: 'session-new', at: BIND_T },
    { id: 'session-judge', at: BIND_T - 30 * 60000 },
    { id: 'session-pin', at: BIND_T - 40 * 60000 },
  ];
  const labelled = bindSessions({
    root: ROOT, sessions, nodes: BIND_NODES, folders: BIND_FOLDERS,
    agents: [{ id: 'session-judge', label: 'judge', node: 'judge' }], pins: {},
  });
  assert.equal(labelled.binding.source, 'label');
  assert.equal(labelled.binding.node, 'judge');
  assert.equal(labelled.binding.session, 'session-judge');
  assert.equal(labelled.binding.at, BIND_T - 30 * 60000);

  const pinned = bindSessions({
    root: ROOT, sessions, nodes: BIND_NODES, folders: BIND_FOLDERS, agents: [],
    pins: { [ROOT]: { node: 'worker', session: 'session-pin' } },
  });
  assert.equal(pinned.binding.source, 'pin');
  assert.equal(pinned.binding.node, 'worker');
  assert.equal(pinned.binding.session, 'session-pin');

  const released = bindSessions({ root: ROOT, sessions, nodes: BIND_NODES, folders: BIND_FOLDERS, agents: [], pins: {} });
  assert.equal(released.binding.source, 'auto', 'без метки и пина снова авто');
  assert.equal(released.binding.session, 'session-new');
});

test('привязка: мёртвый пин и чужая метка не выдумывают узел', () => {
  const sessions = [{ id: 'session-new', at: BIND_T }];
  const deadPin = bindSessions({
    root: ROOT, sessions, nodes: BIND_NODES, folders: BIND_FOLDERS, agents: [],
    pins: { [ROOT]: { node: 'worker', session: 'session-closed' } },
  });
  assert.equal(deadPin.binding.source, 'auto', 'пин на закрытую сессию не действует');
  const deadNode = bindSessions({
    root: ROOT, sessions, nodes: BIND_NODES, folders: BIND_FOLDERS, agents: [],
    pins: { [ROOT]: { node: 'deleted', session: 'session-new' } },
  });
  assert.equal(deadNode.binding.source, 'auto', 'пин на удалённый узел не действует');
  const foreignAgent = bindSessions({
    root: ROOT, sessions, nodes: BIND_NODES, folders: BIND_FOLDERS,
    agents: [{ id: 'agent-other', label: 'judge', node: 'judge' }], pins: {},
  });
  assert.equal(foreignAgent.binding.source, 'auto', 'метка агента без такой сессии не считается');
});

test('привязка: объявленный node.session — пин, пока сессия существует (задание 0089)', () => {
  const nodes = [
    { id: 'coordinator', role: 'координатор' },
    { id: 'worker', role: 'исполнитель', session: 'session-pin' },
  ];
  const pinned = bindSessions({
    root: ROOT,
    sessions: [{ id: 'session-new', at: BIND_T }, { id: 'session-pin', at: BIND_T - 60000 }],
    nodes, folders: BIND_FOLDERS, agents: [], pins: {},
  });
  assert.equal(pinned.binding.source, 'pin', 'node.session — тот же пин, что и файл');
  assert.equal(pinned.binding.node, 'worker');
  assert.equal(pinned.binding.session, 'session-pin');

  const closed = bindSessions({
    root: ROOT,
    sessions: [{ id: 'session-new', at: BIND_T }],
    nodes, folders: BIND_FOLDERS, agents: [], pins: {},
  });
  assert.equal(closed.binding.source, 'auto', 'сессии нет — node.session не привязывает');
  assert.equal(closed.binding.node, 'coordinator');

  /* Порядок источников не изменился: метка агента сильнее пина. */
  const labelled = bindSessions({
    root: ROOT,
    sessions: [{ id: 'session-new', at: BIND_T }, { id: 'session-pin', at: BIND_T - 60000 }],
    nodes, folders: BIND_FOLDERS,
    agents: [{ id: 'session-new', label: 'coordinator', node: 'coordinator' }], pins: {},
  });
  assert.equal(labelled.binding.source, 'label');
});

test('привязка: без папки — единственный узел, затем роль «координатор», затем первый', () => {
  const only = bindSessions({ root: ROOT, sessions: [{ id: 's', at: BIND_T }], nodes: [{ id: 'solo' }], folders: [] });
  assert.equal(only.binding.node, 'solo', 'единственный узел');
  const byRole = bindSessions({
    root: ROOT, sessions: [{ id: 's', at: BIND_T }],
    nodes: [{ id: 'first', role: 'исполнитель' }, { id: 'boss', role: 'Координатор проекта' }], folders: [],
  });
  assert.equal(byRole.binding.node, 'boss', 'роль «координатор» без учёта регистра');
  const first = bindSessions({
    root: ROOT, sessions: [{ id: 's', at: BIND_T }],
    nodes: [{ id: 'first', role: 'исполнитель' }, { id: 'second', role: 'приёмщик' }], folders: [],
  });
  assert.equal(first.binding.node, 'first', 'иначе первый по объявлению');
});

test('привязка: две сессии в пределах минуты — обе в ambiguous, привязана свежайшая', () => {
  const result = bindSessions({
    root: ROOT,
    sessions: [{ id: 'session-x', at: BIND_T }, { id: 'session-y', at: BIND_T - 30000 }],
    nodes: BIND_NODES, folders: BIND_FOLDERS, agents: [], pins: {},
  });
  assert.equal(result.binding.session, 'session-x');
  assert.deepEqual(result.binding.ambiguous, [{ id: 'session-x', at: BIND_T }, { id: 'session-y', at: BIND_T - 30000 }]);
  const far = bindSessions({
    root: ROOT,
    sessions: [{ id: 'session-x', at: BIND_T }, { id: 'session-y', at: BIND_T - 61000 }],
    nodes: BIND_NODES, folders: BIND_FOLDERS, agents: [], pins: {},
  });
  assert.deepEqual(far.binding.ambiguous, [{ id: 'session-x', at: BIND_T }], 'дальше минуты — не одинаково свежие');
});

test('привязка: нет сессий — no-session, нет узлов — no-node, кривые данные не бросают', () => {
  assert.deepEqual(bindSessions({ root: ROOT, sessions: [], nodes: BIND_NODES }), { binding: null, reason: 'no-session' });
  assert.deepEqual(bindSessions({ root: ROOT, sessions: [{ id: 's', at: BIND_T }], nodes: [] }), { binding: null, reason: 'no-node' });
  assert.deepEqual(bindSessions({}), { binding: null, reason: 'no-session' });
  assert.deepEqual(bindSessions(null), { binding: null, reason: 'no-session' });
  assert.deepEqual(bindSessions({ sessions: [null, 42, {}, { id: '', at: BIND_T }, { id: 's', at: 'now' }], nodes: BIND_NODES }),
    { binding: null, reason: 'no-session' }, 'битые строки сессий пропускаются');
  const junk = bindSessions({ root: ROOT, sessions: [{ id: 's', at: BIND_T }], nodes: BIND_NODES, agents: [null, 7], pins: 'nope', folders: 'nope' });
  assert.equal(junk.binding.source, 'auto');
});

test('привязка ничего не пишет на диск: structure/graph.json не меняется', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-bind-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const file = path.join(root, 'structure', 'graph.json');
  const text = JSON.stringify({ version: 1, nodes: BIND_NODES, edges: [], folders: BIND_FOLDERS }, null, 2);
  fs.writeFileSync(file, text);
  const before = { mtime: fs.statSync(file).mtimeMs, text: fs.readFileSync(file, 'utf8') };
  bindSessions({
    root, sessions: [{ id: 'session-new', at: BIND_T }], nodes: BIND_NODES, folders: BIND_FOLDERS, agents: [], pins: {},
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before.text, 'содержимое не изменилось');
  assert.equal(fs.statSync(file).mtimeMs, before.mtime, 'mtime не изменился');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

/*
 * Задание 0089. Панель показывала «в воркспейсе работает агент, роль не
 * объявлена: 2», хотя обе работающие сессии были привязаны к узлам: сессия
 * структуры — через binding, запуск узла worker — через childId записи запуска.
 * attributeSessions называет узел и источник для каждой сессии по отдельности.
 */
const ATTRIBUTE_SESSIONS = [
  { id: 'session-owner', at: BIND_T - 5000, running: true },
  { id: 'child-worker', at: BIND_T - 4000, running: true },
  { id: 'session-agent', at: BIND_T - 3500, running: true },
  { id: 'stranger', at: BIND_T - 3000, running: true },
  { id: 'idle', at: BIND_T - 3600000, running: false },
];
const ATTRIBUTE_RUNS = [
  { root: ROOT, node: 'worker', state: 'running', since: BIND_T - 4000, childId: 'child-worker' },
  /* Чужой корень: запись есть, но доказательством для этого проекта не является. */
  { root: 'C:/Other/Project', node: 'coordinator', state: 'running', since: BIND_T - 3000, childId: 'stranger' },
];

test('сессии: binding, childId запуска и метка агента привязывают, чужая — нет', () => {
  const view = attributeSessions({
    root: ROOT,
    now: BIND_T,
    sessions: ATTRIBUTE_SESSIONS,
    nodes: BIND_NODES,
    binding: { node: 'coordinator', session: 'session-owner', source: 'auto' },
    agents: [{ id: 'session-agent', label: 'judge', node: 'judge' }],
    runs: ATTRIBUTE_RUNS,
  });
  const byId = new Map(view.items.map((row) => [row.id, row]));
  assert.deepEqual(byId.get('session-owner'), {
    id: 'session-owner', at: BIND_T - 5000, running: true, node: 'coordinator', source: 'binding',
  });
  assert.equal(byId.get('child-worker').node, 'worker', 'childId запуска называет узел');
  assert.equal(byId.get('child-worker').source, 'run');
  assert.equal(byId.get('session-agent').node, 'judge', 'метка агента называет узел');
  assert.equal(byId.get('session-agent').source, 'agent');
  const stranger = byId.get('stranger');
  assert.equal(stranger.node, null, 'чужой запуск узел не приписывает');
  assert.equal(stranger.source, null);
  assert.equal(byId.get('idle').node, null, 'простаивающая сессия узла не получает');
  assert.deepEqual(view.unattributed.map((row) => row.id), ['stranger'],
    'вне структуры — только работающая сессия без узла');
});

test('сессии: метка непривязанной сессии берётся у агента, иначе пустая', () => {
  const view = attributeSessions({
    root: ROOT,
    now: BIND_T,
    sessions: [
      { id: 's1', at: BIND_T, running: true },
      { id: 's2', at: BIND_T - 1000, running: true },
      { id: 's3', at: BIND_T - 2000, running: false },
    ],
    nodes: BIND_NODES,
    binding: null,
    agents: [{ id: 's1', label: 'безымянный агент', node: null }],
    runs: [],
  });
  assert.deepEqual(view.unattributed, [
    { id: 's1', at: BIND_T, label: 'безымянный агент' },
    { id: 's2', at: BIND_T - 1000, label: '' },
  ], 'подпись есть только там, где её дал хост; простаивающая s3 не считается');
  const byId = new Map(view.items.map((row) => [row.id, row]));
  assert.equal(byId.get('s1').node, null, 'агент без узла ничего не приписывает');
  assert.equal(byId.get('s3').source, null, 'простаивающей сессии источник не выдуман');
});

test('сессии: завершённый, старый и безымянный запуск ничего не привязывают', () => {
  const cases = [
    [{ root: ROOT, node: 'worker', state: 'done', since: BIND_T, childId: 'child-worker' }, 'завершённый запуск'],
    [{ root: ROOT, node: 'worker', state: 'running', since: BIND_T - 25 * 60 * 60 * 1000, childId: 'child-worker' }, 'since старше окна'],
    [{ root: ROOT, node: 'worker', state: 'running', since: BIND_T }, 'запись без childId'],
    [{ root: ROOT, node: 'ghost', state: 'running', since: BIND_T, childId: 'child-worker' }, 'узел вне графа'],
  ];
  for (const [record, why] of cases) {
    const view = attributeSessions({
      root: ROOT, now: BIND_T,
      sessions: [{ id: 'child-worker', at: BIND_T, running: true }],
      nodes: BIND_NODES, binding: null, agents: [], runs: [record],
    });
    assert.equal(view.items[0].node, null, why + ': узла нет');
  }
  /* Живой агент сильнее записи запуска, binding — сильнее агента. */
  const strong = attributeSessions({
    root: ROOT, now: BIND_T,
    sessions: [{ id: 's', at: BIND_T, running: true }],
    nodes: BIND_NODES,
    binding: { node: 'coordinator', session: 's' },
    agents: [{ id: 's', label: 'worker', node: 'worker' }],
    runs: [{ root: ROOT, node: 'judge', state: 'running', since: BIND_T, childId: 's' }],
  });
  assert.equal(strong.items[0].node, 'coordinator', 'binding сильнее метки и запуска');
  assert.equal(strong.items[0].source, 'binding');
  /* Пустые и битые входы не бросают. */
  assert.deepEqual(attributeSessions({}), { items: [], unattributed: [] });
  assert.deepEqual(attributeSessions(null), { items: [], unattributed: [] });
  assert.deepEqual(attributeSessions({ sessions: [null, 42, {}], nodes: 'nope', runs: 'nope', agents: 'nope' }),
    { items: [], unattributed: [] });
});

test('активность узла: свежая привязанная сессия даёт session, старая — ничего', () => {
  const binding = { node: 'coordinator', session: 'session-fresh', at: BIND_T, source: 'auto', ambiguous: [] };
  const fresh = mapNodeActivity({
    active: [],
    binding,
    sessions: [{ id: 'session-fresh', at: BIND_T, running: true }],
  });
  assert.deepEqual(fresh.active, ['coordinator'], 'узел привязки активен по журналу');
  assert.deepEqual(fresh.activityByNode, { coordinator: 'session' }, 'источник назван честно');

  const stale = mapNodeActivity({
    active: [],
    binding,
    sessions: [{ id: 'session-fresh', at: BIND_T, running: false }],
  });
  assert.deepEqual(stale, { active: [], activityByNode: {} }, 'старый журнал не подсвечивает узел');
});

test('активность узла: живой агент сильнее журнала и не понижается', () => {
  const both = mapNodeActivity({
    active: ['coordinator'],
    binding: { node: 'coordinator', session: 'session-fresh', at: BIND_T },
    sessions: [{ id: 'session-fresh', at: BIND_T, running: true }],
  });
  assert.deepEqual(both.active, ['coordinator']);
  assert.deepEqual(both.activityByNode, { coordinator: 'agent' }, 'оба источника на узле — всё равно agent');
  const again = mapNodeActivity({ active: ['worker', 'worker'], binding: null });
  assert.deepEqual(again, { active: ['worker'], activityByNode: { worker: 'agent' } }, 'агенты не дублируются');
});

test('активность узла: журнал не выдумывает узел и не трогает чужие строки', () => {
  assert.deepEqual(mapNodeActivity({}), { active: [], activityByNode: {} });
  assert.deepEqual(mapNodeActivity(null), { active: [], activityByNode: {} });
  assert.deepEqual(mapNodeActivity({ active: 'coordinator', sessions: 'nope' }), { active: [], activityByNode: {} },
    'битый ответ не превращается в активность');
  assert.deepEqual(mapNodeActivity({
    binding: { node: 'coordinator', session: 'missing' }, sessions: [{ id: 'other', at: BIND_T, running: true }],
  }), { active: [], activityByNode: {} }, 'сессия вне списка ничего не доказывает');
  assert.deepEqual(mapNodeActivity({ binding: { node: 'worker' }, sessions: [{ id: 's', at: BIND_T, running: true }] }),
    { active: [], activityByNode: {} }, 'привязка без сессии не даёт активности');
});

/*
 * Задание 0059. Работающий узел берётся из журнала запусков: запись state=running
 * этого корня и объявленного узла — точный факт запуска, а не догадка по свежести
 * привязанной сессии (она указывает на оркестратора). Чужой корень, старый since,
 * завершённый запуск и узел вне графа активности не создают.
 */
test('активность из запуска: running этого корня подсвечивает объявленный узел', () => {
  const now = BIND_T;
  const running = mapRunActivity({
    active: [],
    runs: [{ node: 'worker', state: 'running', root: ROOT, since: now - 60 * 1000 }],
    nodes: BIND_NODES,
    root: ROOT,
    now,
  });
  assert.deepEqual(running.active, ['worker']);
  assert.deepEqual(running.activityByNode, { worker: 'run' }, 'источник — журнал запусков');

  /* Завершённый запуск — история, а не работа. */
  for (const state of ['done', 'error']) {
    assert.deepEqual(mapRunActivity({
      active: [],
      runs: [{ node: 'worker', state, root: ROOT, since: now - 60 * 1000 }],
      nodes: BIND_NODES, root: ROOT, now,
    }), { active: [], activityByNode: {} }, 'завершённый запуск (' + state + ') узел не подсвечивает');
  }
});

test('активность из запуска: чужой корень, старый since и узел вне графа не считаются', () => {
  const now = BIND_T;
  const cases = [
    [{ node: 'worker', state: 'running', root: 'C:\\Other\\Project', since: now - 60 * 1000 }, 'чужой корень'],
    [{ node: 'worker', state: 'running', root: ROOT, since: now - 25 * 60 * 60 * 1000 }, 'since старше 24 ч'],
    [{ node: 'ghost', state: 'running', root: ROOT, since: now - 60 * 1000 }, 'узел вне графа'],
    [{ node: 'worker', state: 'running', root: ROOT }, 'запись без since'],
  ];
  for (const [record, why] of cases) {
    assert.deepEqual(mapRunActivity({ active: [], runs: [record], nodes: BIND_NODES, root: ROOT, now }),
      { active: [], activityByNode: {} }, why + ': активности нет');
  }
  /* Путь сравнивается нормализованно: регистр и разделители не важны. */
  const sameRoot = mapRunActivity({
    active: [],
    runs: [{ node: 'worker', state: 'running', root: ROOT.toLowerCase(), since: now - 1000 }],
    nodes: BIND_NODES, root: ROOT, now,
  });
  assert.deepEqual(sameRoot.activityByNode, { worker: 'run' }, 'тот же корень в другом регистре — тот же корень');
});

test('активность из запуска: живой агент сильнее записи запуска и не понижается', () => {
  const now = BIND_T;
  const both = mapRunActivity({
    active: ['worker'],
    runs: [
      { node: 'worker', state: 'running', root: ROOT, since: now - 1000 },
      { node: 'judge', state: 'running', root: ROOT, since: now - 1000 },
    ],
    nodes: BIND_NODES, root: ROOT, now,
  });
  assert.deepEqual(both.active, ['worker', 'judge']);
  assert.deepEqual(both.activityByNode, { worker: 'agent', judge: 'run' }, 'agent не понижается до run');
  assert.deepEqual(mapRunActivity({
    active: [],
    runs: [{ node: 'worker', state: 'running', root: ROOT, since: now - 5000 }],
    nodes: BIND_NODES, root: ROOT, now, windowMs: 1000,
  }), { active: [], activityByNode: {} }, 'окно свежести параметризовано');
});

test('активность из запуска: битые данные не превращаются в активность', () => {
  const now = BIND_T;
  assert.deepEqual(mapRunActivity({}), { active: [], activityByNode: {} });
  assert.deepEqual(mapRunActivity(null), { active: [], activityByNode: {} });
  assert.deepEqual(mapRunActivity({ runs: 'nope', nodes: BIND_NODES, root: ROOT, now }),
    { active: [], activityByNode: {} }, 'runs не массив');
  assert.deepEqual(mapRunActivity({ runs: [null, 42, { node: '', state: 'running' }], nodes: BIND_NODES, root: ROOT, now }),
    { active: [], activityByNode: {} }, 'битые записи пропускаются');
  assert.deepEqual(mapRunActivity({
    runs: [{ node: 'worker', state: 'running', root: ROOT, since: now }], nodes: [], root: ROOT, now,
  }), { active: [], activityByNode: {} }, 'нет узлов — нет активности');
  assert.deepEqual(mapRunActivity({
    runs: [{ node: 'worker', state: 'running', root: ROOT, since: now }], nodes: BIND_NODES, root: '', now,
  }), { active: [], activityByNode: {} }, 'без корня записи некуда привязывать');
});

test('активность по сессиям: свежий файл — работает, старый — нет, чужой корень не считается', () => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sessions-'));
  const root = path.join(os.tmpdir(), 'pg-ws', 'proj');
  const marker = '--' + normalizePath(root).replace(/:/gu, '').replace(/\//gu, '-') + '--';
  const dir = path.join(sessions, marker, 'session-1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, 'x');
  const now = Date.now();
  const fresh = readSessionActivity(root, { sessionsDir: sessions, now });
  assert.equal(fresh.running, 1);
  const stale = readSessionActivity(root, { sessionsDir: sessions, now: now + 10 * 60 * 1000 });
  assert.equal(stale.running, 0);
  const foreign = readSessionActivity(path.join(os.tmpdir(), 'pg-ws', 'other'), { sessionsDir: sessions, now });
  assert.equal(foreign.running, 0);
});

/** Journal of a session: one frame per record, exactly as the host writes it. */
function writeJournal(file, records) {
  fs.writeFileSync(file, Buffer.concat(records.map((record) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n')))));
}

/** Folder of a workspace in ~/.dsh/sessions; the host names it after the parent. */
function workspaceKey(root) {
  return '--' + normalizePath(root).replace(/:/gu, '').replace(/\//gu, '-') + '--';
}

test('сессия, поднятая для этого корня, считается по cwd из журнала, а не по папке родителя', () => {
  if (!zstdReady) {
    skip();
    return;
  }
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-wake-'));
  const parent = path.join(os.tmpdir(), 'pg-ws2', 'parent');
  const target = path.join(os.tmpdir(), 'pg-ws2', 'target');
  /* Both sessions are filed under the key of the parent: the host does that. */
  const wake = path.join(sessions, workspaceKey(parent), 'wake-1');
  const home = path.join(sessions, workspaceKey(parent), 'parent-1');
  fs.mkdirSync(wake, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const now = Date.now();
  writeJournal(path.join(wake, 'session.v4.jsonl.zstd'), [
    { type: 'session', version: 4, id: 'wake-1', cwd: parent },
    { type: 'sandbox/mode', data: {} },
    { type: 'working-directory/change', seq: 4, data: { cwd: target } },
  ]);
  writeJournal(path.join(home, 'session.v4.jsonl.zstd'), [
    { type: 'session', version: 4, id: 'parent-1', cwd: parent },
  ]);
  const addressed = readSessionActivity(target, { sessionsDir: sessions, now });
  assert.deepEqual(addressed.items.map((item) => item.id), ['wake-1'], 'адресованная сессия видна своему корню');
  assert.equal(addressed.running, 1);
  const parentReport = readSessionActivity(parent, { sessionsDir: sessions, now });
  assert.deepEqual(parentReport.items.map((item) => item.id), ['parent-1'], 'чужая сессия не достаётся родителю');
  /*
   * Простаивающая сессия — это не край, а нормальное состояние ждущего воркспейса:
   * журнал решает и для неё. Раньше здесь стояло «старый журнал не читают, папка
   * остаётся ответом», и именно это возвращало простаивающую wake-сессию родителю.
   */
  const later = now + 10 * 60 * 1000;
  const addressedLater = readSessionActivity(target, { sessionsDir: sessions, now: later });
  assert.deepEqual(addressedLater.items.map((item) => item.id), ['wake-1'], 'простаивающая сессия остаётся сессией своего корня');
  assert.equal(addressedLater.running, 0, 'но свежести у неё уже нет');
  const parentLater = readSessionActivity(parent, { sessionsDir: sessions, now: later });
  assert.deepEqual(parentLater.items.map((item) => item.id), ['parent-1'], 'и родителю она не достаётся');
});

test('порог thresholdMs меняет свежесть, а не принадлежность', () => {
  if (!zstdReady) {
    skip();
    return;
  }
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ttl-'));
  const parent = path.join(os.tmpdir(), 'pg-ws3', 'parent');
  const target = path.join(os.tmpdir(), 'pg-ws3', 'target');
  const wake = path.join(sessions, workspaceKey(parent), 'wake-ttl');
  fs.mkdirSync(wake, { recursive: true });
  writeJournal(path.join(wake, 'session.v4.jsonl.zstd'), [
    { type: 'session', version: 4, id: 'wake-ttl', cwd: parent },
    { type: 'working-directory/change', seq: 4, data: { cwd: target } },
  ]);
  const now = Date.now();
  /*
   * Состарить журнал на 5 с: при thresholdMs: 0 свежесть считается как now-mtime <= 0, и когда
   * запись и Date.now() падают в одну миллисекунду, 0 <= 0 даёт «свежая» — плавающий сбой.
   * Фиксированный возраст делает «не свежая» и «свежая» детерминированными.
   */
  fs.utimesSync(path.join(wake, 'session.v4.jsonl.zstd'), new Date(now - 5000), new Date(now - 5000));
  for (const thresholdMs of [120000, 0]) {
    const report = readSessionActivity(target, { sessionsDir: sessions, now, thresholdMs });
    assert.deepEqual(report.items.map((item) => item.id), ['wake-ttl'], 'принадлежность от порога не зависит: ' + thresholdMs);
  }
  assert.equal(readSessionActivity(target, { sessionsDir: sessions, now, thresholdMs: 0 }).running, 0);
  assert.equal(readSessionActivity(target, { sessionsDir: sessions, now }).running, 1);
});

test('кэш cwd не залипает: переписанный журнал читается заново', () => {
  if (!zstdReady) {
    skip();
    return;
  }
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cache-'));
  const parent = path.join(os.tmpdir(), 'pg-ws4', 'parent');
  const first = path.join(os.tmpdir(), 'pg-ws4', 'first');
  const second = path.join(os.tmpdir(), 'pg-ws4', 'second');
  const file = path.join(sessions, workspaceKey(parent), 'moving', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = Date.now();
  writeJournal(file, [
    { type: 'session', version: 4, id: 'moving', cwd: parent },
    { type: 'working-directory/change', seq: 4, data: { cwd: first } },
  ]);
  assert.deepEqual(readSessionActivity(first, { sessionsDir: sessions, now }).items.map((item) => item.id), ['moving']);
  /* Тот же файл, другое место работы: новый ответ должен прийти из нового журнала. */
  const later = now + 60000;
  writeJournal(file, [
    { type: 'session', version: 4, id: 'moving', cwd: parent },
    { type: 'working-directory/change', seq: 4, data: { cwd: second } },
  ]);
  fs.utimesSync(file, new Date(later), new Date(later));
  assert.deepEqual(readSessionActivity(second, { sessionsDir: sessions, now: later }).items.map((item) => item.id), ['moving']);
  assert.deepEqual(readSessionActivity(first, { sessionsDir: sessions, now: later }).items, []);
});

test('журнал, который не читается, cwd не выдумывает, и папка остаётся ответом', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-junk-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, 'x');
  assert.equal(readSessionCwd(file), null);
  assert.equal(readSessionCwd(path.join(dir, 'missing.v4.jsonl.zstd')), null);
  /* Без читаемого журнала сессия возвращается к папке: молча пропасть она не может. */
  const marker = '--' + normalizePath(dir).replace(/:/gu, '').replace(/\//gu, '-') + '--';
  const sessionDir = path.join(dir, marker, 'junk-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'x');
  const report = readSessionActivity(dir, { sessionsDir: dir, now: Date.now() });
  assert.deepEqual(report.items.map((item) => item.id), ['junk-1']);
});

const total = passed + skipped + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('LIVE TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total
  + (skipped > 0 ? ' (' + skipped + ' пропущено: нет zstd — живой путь журнала НЕ проверен)' : ''));
process.exit(failures.length === 0 ? 0 : 1);
