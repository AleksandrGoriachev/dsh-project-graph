import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACK_RECONCILE_WINDOW_MS,
  addresseeLabels, buildWakeDigest, createExchangeWatcher, createWakeThrottle, declaredExchangeBoxes,
  declaredExchangeWorkspaces, decisionsPath, labelRoots, letterSha256, markAck, messageFiles, nextLetterNumber,
  normalizeSession, parseMessage, pickLastActive, readExchangeFolders, reconcileRunAck, recoverFalseSeen, resolveWakeSpawn, seenPath, shouldWake, staleReceipt, staleReceiptReason, waitingReasonText, wakeDecision,
  WAKE_BOX_LIMIT, WAKE_BOX_WINDOW_MS, WAKE_BRANCH_COOLDOWN_MS,
} from '../lib/exchange-watch.js';
import { listRuns, noteRun } from '../lib/runs.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}
async function atest(name, body) {
  try { await body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

/*
 * The default status of a waking letter is `request`: an `answer` no longer wakes anyone,
 * because an answer that wakes a workspace produces a new answer and the chain never ends
 * (43 of 63 exchange errors on 2026-11-01 were "active child limit: 8").
 */
const HEAD = (from, to, date, extra = '') => 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date
  + '\nThread: critic-report\nStatus: request\n' + extra + '\n';

/** Письмо с заданным статусом (задание 0099): статус — параметр, а не константа. */
const STATUS_HEAD = (status, date = new Date().toISOString(), from = 'structure', to = 'workflow') =>
  'From: ' + from + '\nTo: ' + to + '\nDate: ' + date
  + '\nThread: critic-report\nStatus: ' + status + '\nSubject: x\n\nтекст\n';

/**
 * Квитанция приёма папки (задание 0159): поле Rev необязательно.
 * rev = null — легаси-квитанция без ревизии; число — ссылка на Rev контракта.
 */
const RECEIPT_HEAD = (from, to, rev, date = new Date().toISOString()) =>
  'Format: dsh-exchange/1\nFrom: ' + from + '\nTo: ' + to + '\nDate: ' + date
  + '\nThread: critic-report\nStatus: accepted\n'
  + (rev === null ? '' : 'Rev: ' + rev + '\n') + 'Ref: contract.md\n';

/** Two workspaces and one shared box one level above them, as on the host. */
function host() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-watch-'));
  const structure = path.join(parent, 'dsh-project-graph');
  const workflow = path.join(parent, 'default-workspace');
  fs.mkdirSync(structure, { recursive: true });
  fs.mkdirSync(workflow, { recursive: true });
  const box = path.join(parent, 'coordination');
  const thread = path.join(box, 'threads', 'critic-report');
  fs.mkdirSync(thread, { recursive: true });
  /* The channel README is where the labels are declared: who is who. */
  fs.writeFileSync(path.join(box, 'README.md'), [
    '# Канал',
    '',
    '| Сторона | Пространство | Что делает |',
    '| --- | --- | --- |',
    '| `workflow` | `' + workflow.replace(/\\/gu, '/') + '` | спека |',
    '| `structure` | `' + structure.replace(/\\/gu, '/') + '` | панель |',
    '',
  ].join('\n'));
  return { parent, structure, workflow, box, thread };
}

function runtimeOf(roots, extra = {}) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-watch-runs-'));
  return {
    allowedRoots: () => roots,
    exchange: [],
    participants: {},
    me: null,
    runs: new Map(),
    runsDir,
    ...extra,
  };
}
/** Папка обмена с контрактом: инициатор structure, приглашённый workflow. */
function folderHost() {
  const box = host();
  fs.mkdirSync(path.join(box.structure, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(box.structure, 'structure', 'graph.json'), JSON.stringify({
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'shared' },
      exchange: { threads: ['critic-report'], contract: 'contract.md' },
      participants: ['structure', 'workflow'],
      orchestrator: 'coordinator',
    }],
    edges: [],
  }, null, 2));
  fs.writeFileSync(path.join(box.box, 'contract.md'), [
    'Format: dsh-exchange/1-contract',
    'Rev: 4',
    'Initiator: structure',
    'Invited: workflow',
    '',
  ].join('\n'));
  return box;
}

/** Решения сторожа: одна JSON-строка журнала — одно решение. */
function decisionsOf(runtime) {
  const file = decisionsPath(runtime);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Память вручений для стенда (задание 0153): файл -> mtime, как её пишет сторож.
 * Нужна там, где письмо уже вручено раньше и в тик попадать не должно: с 0153
 * письмо без отметки доставляется независимо от возраста.
 */
function markSeenFile(file, paths) {
  const rows = {};
  for (const item of paths) rows[item] = fs.statSync(item).mtimeMs;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows, null, 1) + '\n', 'utf8');
}

/** A live agent handle that records what it was told. */
function agent(id, cwd, label) {
  const inbox = [];
  return {
    id, sessionId: id, cwd, label,
    /* 0263: живой агент получает объект DSH-сообщения, а не { text }. */
    sendMessage: async (input) => { inbox.push(input.content?.[0]?.text); },
    inbox,
  };
}

test('shouldWake: будят только статусы, требующие действия (0081)', () => {
  /*
   * Контракт доставки §1.5: будить — request, question, proposal, report, invitation.
   * answer и ack не будят: ответ на ответ поднимал новый агент, и цепочка не
   * заканчивалась (43 из 63 ошибок обмена 2026-11-01 — «active child limit: 8»).
   */
  for (const status of ['request', 'question', 'proposal', 'report', 'invitation']) {
    assert.equal(shouldWake(status), true, status + ' требует действия и будит');
  }
  for (const status of ['answer', 'ack', 'agreed', 'rejected', 'declined', '', 'unknown']) {
    assert.equal(shouldWake(status), false, JSON.stringify(status) + ' не будит');
  }
  assert.equal(shouldWake('  REQUEST '), true, 'регистр и пробелы нормализуются');
  assert.equal(shouldWake(' Answer '), false, 'и у не-будящих тоже');
  assert.equal(shouldWake(undefined), false, 'пустой статус не будит');
  assert.equal(shouldWake(null), false, 'пустой статус не будит');
});


/*
 * Задание 0150: одно решение с источником. Порядок — config → env → profile → default;
 * дефолт включён (D1): молчаливое false делало узлы глухими, и письмо ждало человека.
 */
test('0150: resolveWakeSpawn — config главнее env, env главнее профиля, дефолт включён', () => {
  const profileOn = 'plugins:\n  - id: dsh-project-graph\n    config:\n      wakeSpawn: true\n';
  const profileOff = 'plugins:\n  - id: dsh-project-graph\n    config:\n      wakeSpawn: false\n';
  assert.deepEqual(
    resolveWakeSpawn({ config: { wakeSpawn: false }, env: { PG_PROJECT_GRAPH_WAKE_SPAWN: '1' }, profileText: profileOn }),
    { enabled: false, source: 'config' }, 'config=false сильнее env и профиля');
  assert.deepEqual(
    resolveWakeSpawn({ config: { wakeSpawn: true }, env: { PG_PROJECT_GRAPH_WAKE_SPAWN: '0' }, profileText: profileOff }),
    { enabled: true, source: 'config' }, 'config=true сильнее env и профиля');
  for (const value of ['0', 'false', 'off', ' OFF ']) {
    assert.deepEqual(
      resolveWakeSpawn({ config: {}, env: { PG_PROJECT_GRAPH_WAKE_SPAWN: value }, profileText: profileOn }),
      { enabled: false, source: 'env' }, 'env=' + JSON.stringify(value) + ' выключает');
  }
  for (const value of ['1', 'true', 'on', ' ON ']) {
    assert.deepEqual(
      resolveWakeSpawn({ config: {}, env: { PG_PROJECT_GRAPH_WAKE_SPAWN: value }, profileText: profileOff }),
      { enabled: true, source: 'env' }, 'env=' + JSON.stringify(value) + ' включает');
  }
  assert.deepEqual(resolveWakeSpawn({ config: {}, env: {}, profileText: profileOn }),
    { enabled: true, source: 'profile' }, 'профиль: wakeSpawn true');
  assert.deepEqual(resolveWakeSpawn({ config: {}, env: {}, profileText: profileOff }),
    { enabled: false, source: 'profile' }, 'профиль: wakeSpawn false');
  assert.deepEqual(resolveWakeSpawn({ config: {}, env: {} }),
    { enabled: true, source: 'default' }, 'ничего не задано — включено (D1)');
  assert.deepEqual(
    resolveWakeSpawn({ config: {}, env: { PG_PROJECT_GRAPH_WAKE_SPAWN: 'maybe' }, profileText: profileOn }),
    { enabled: true, source: 'profile' }, 'непонятное значение env не решает');
});

test('0150: профиль читается только в блоке нашего плагина', () => {
  const foreign = 'plugins:\n  - id: other-plugin\n    config:\n      wakeSpawn: false\n';
  assert.deepEqual(resolveWakeSpawn({ config: {}, env: {}, profileText: foreign }),
    { enabled: true, source: 'default' }, 'чужой блок не выключает наш');
  const firstForeign = 'plugins:\n  - id: other-plugin\n    config:\n      wakeSpawn: true\n'
    + '  - id: dsh-project-graph\n    config:\n      roots: []\n';
  assert.deepEqual(resolveWakeSpawn({ config: {}, env: {}, profileText: firstForeign }),
    { enabled: true, source: 'default' }, 'чужой wakeSpawn не подменяет наш блок');
  const ownFalse = 'plugins:\n  - id: dsh-project-graph\n    config:\n      wakeSpawn: false\n'
    + '  - id: other-plugin\n    config:\n      wakeSpawn: true\n';
  assert.deepEqual(resolveWakeSpawn({ config: {}, env: {}, profileText: ownFalse }),
    { enabled: false, source: 'profile' }, 'блок кончается на следующем плагине: наш false виден');
});

test('общий ящик без второго участника в roots — ошибка, а не папка внутри воркспейса', () => {
  /*
   * Живая проверка 2026-11-02: при одном разрешённом корне box.root: shared молча давал
   * <воркспейс>/coordination — то есть общую папку ВНУТРИ одного множества. Это должно
   * быть отказом с рецептом, а не тихим выбором.
   */
  const box = host();
  fs.mkdirSync(path.join(box.structure, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(box.structure, 'structure', 'graph.json'), JSON.stringify({
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    folders: [{ id: 'folder-1', box: { path: 'coordination', root: 'shared' },
      participants: ['structure', 'workflow'], orchestrator: 'coordinator' }],
    edges: [],
  }));
  const runtime = runtimeOf([box.structure, box.workflow], {
    structureDir: 'structure',
    participants: { structure: box.structure, workflow: box.workflow },
  });
  const onlyOne = declaredExchangeBoxes(runtime, [box.structure]);
  assert.deepEqual(onlyOne.dirs, [], 'ящик не поднят внутри одного воркспейса');
  assert.match(onlyOne.errors[0] || '', /минимум двух участников/u);
  const both = declaredExchangeBoxes(runtime, [box.structure, box.workflow]);
  assert.deepEqual(both.dirs, [box.box], 'с двумя корнями — общий каталог');
});

test('папка обмена объявляет ящик переносимо: box от общего корня и метки участников', () => {
  /*
   * Требование заказчика: формат не зависит от воркспейса. Папка несёт относительный путь
   * и метки, поэтому тот же graph.json поднимает обмен в любой паре воркспейсов.
   */
  const box = host();
  fs.mkdirSync(path.join(box.structure, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(box.structure, 'structure', 'graph.json'), JSON.stringify({
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'shared' },
      exchange: { threads: ['critic-report'], contract: 'contract.md' },
      participants: ['structure', 'workflow'],
      orchestrator: 'coordinator',
    }],
    edges: [],
  }));
  const runtime = runtimeOf([box.structure, box.workflow], {
    structureDir: 'structure',
    participants: { structure: box.structure, workflow: box.workflow },
  });
  assert.deepEqual(declaredExchangeBoxes(runtime, [box.structure, box.workflow]).dirs, [box.box],
    'box.root: shared — общий корень участников, а не папка одного воркспейса');
  assert.deepEqual(declaredExchangeWorkspaces(runtime, [box.structure, box.workflow]),
    [box.structure, box.workflow], 'метки участников разрешились в воркспейсы');
});

test('box.root: workspace держит ящик внутри своего воркспейса', () => {
  const box = host();
  fs.mkdirSync(path.join(box.structure, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(box.structure, 'structure', 'graph.json'), JSON.stringify({
    nodes: [{ id: 'structure', role: 'координатор' }],
    folders: [{ id: 'folder-1', box: { path: 'coordination', root: 'workspace' },
      participants: ['structure'], orchestrator: 'structure' }],
    edges: [],
  }));
  const runtime = runtimeOf([box.structure, box.workflow], { structureDir: 'structure' });
  assert.deepEqual(declaredExchangeBoxes(runtime, [box.structure, box.workflow]).dirs,
    [path.join(box.structure, 'coordination')], 'workspace — внутри объявившего воркспейса');
});

test('box.path не выходит за корень: «..» и абсолютный путь — ошибка с рецептом', () => {
  const box = host();
  fs.mkdirSync(path.join(box.structure, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(box.structure, 'structure', 'graph.json'), JSON.stringify({
    nodes: [{ id: 'structure', role: 'координатор' }],
    folders: [
      { id: 'up', box: { path: '../outside', root: 'workspace' },
        participants: ['structure'], orchestrator: 'structure' },
      { id: 'abs', box: { path: 'C:/Windows/Temp', root: 'workspace' },
        participants: ['structure'], orchestrator: 'structure' },
    ],
    edges: [],
  }));
  const runtime = runtimeOf([box.structure, box.workflow], { structureDir: 'structure' });
  const result = declaredExchangeBoxes(runtime, [box.structure, box.workflow]);
  assert.deepEqual(result.dirs, [], 'ни один путь не принят');
  assert.equal(result.errors.length, 2, 'каждый отказ назван');
  assert.match(result.errors[0], /относительным и без «\.\.»/u);
});

test('участники на разных дисках: box.root shared даёт ошибку, а не тихий fallback', () => {
  const box = host();
  fs.mkdirSync(path.join(box.structure, 'structure'), { recursive: true });
  const otherDrive = 'D:\\nowhere\\other-workspace';
  fs.writeFileSync(path.join(box.structure, 'structure', 'graph.json'), JSON.stringify({
    nodes: [{ id: 'structure', role: 'координатор' }],
    folders: [{ id: 'folder-1', box: { path: 'coordination', root: 'shared' },
      participants: [box.structure, otherDrive], orchestrator: 'structure' }],
    edges: [],
  }));
  const runtime = runtimeOf([box.structure, box.workflow], { structureDir: 'structure' });
  const result = declaredExchangeBoxes(runtime, [box.structure, box.workflow, otherDrive]);
  assert.deepEqual(result.dirs, [], 'общего каталога нет — ящик не поднят');
  assert.match(result.errors[0] || '', /нет общего каталога/u);
});

test('номер письма в ветке: max+1, а не перезапись', () => {
  const box = host();
  fs.writeFileSync(path.join(box.thread, '2026-11-01T20-00+03-00--structure--07.md'), HEAD('structure', 'workflow', '2026-11-01T20:00+03:00'));
  fs.writeFileSync(path.join(box.thread, '2026-11-01T20-01+03-00--workflow--41.md'), HEAD('workflow', 'structure', '2026-11-01T20:01+03:00'));
  assert.equal(nextLetterNumber(box.thread, 'structure'), '08', 'считаются только письма автора');
  assert.equal(nextLetterNumber(box.thread, 'workflow'), '42');
  assert.equal(nextLetterNumber(path.join(box.thread, 'нет-такой'), 'structure'), '01', 'пустая ветка начинается с 01');
});

test('Session нормализуется к session-<uuid>, пустой остаётся пустым', () => {
  assert.equal(normalizeSession('b8721a2a-456c-48a2-94cd-8030d895a8e8'),
    'session-b8721a2a-456c-48a2-94cd-8030d895a8e8');
  assert.equal(normalizeSession('session-b8721a2a-456c-48a2-94cd-8030d895a8e8'),
    'session-b8721a2a-456c-48a2-94cd-8030d895a8e8');
  assert.equal(normalizeSession(''), '');
});

test('сообщение разбирается, файл без шапки — нет', () => {
  const parsed = parseMessage(HEAD('structure', 'workflow', '2026-11-01T13:31+03:00', 'Subject: ответ\n'), 'x.md');
  assert.equal(parsed.from, 'structure');
  assert.equal(parsed.to, 'workflow');
  assert.equal(parsed.subject, 'ответ');
  assert.equal(parseMessage('просто текст', 'y.md'), null);
});

test('адресатов в To может быть несколько', () => {
  assert.deepEqual(addresseeLabels('workflow, structure'), ['workflow', 'structure']);
  assert.deepEqual(addresseeLabels('workflow; coordinator'), ['workflow', 'coordinator']);
  assert.deepEqual(addresseeLabels(''), []);
});

test('метки канала берутся из README и из участников, папка — последний резерв', () => {
  const box = host();
  const labels = labelRoots([box.structure, box.workflow], { participants: {}, exchange: [] });
  assert.equal(labels.get('workflow'), box.workflow);
  assert.equal(labels.get('structure'), box.structure);
  const named = labelRoots([box.structure], { participants: { structure: box.structure }, exchange: [] });
  assert.equal(named.get('structure'), box.structure);
});

test('метка, объявленная подпапкой воркспейса, всё равно ведёт в воркспейс', () => {
  const box = host();
  const inner = path.join(box.workflow, 'subagent-workflow-v2');
  fs.mkdirSync(inner, { recursive: true });
  const labels = labelRoots([box.structure, box.workflow], {
    participants: {},
    exchange: [],
    exchangeLabels: { workflow: inner.replace(/\\/gu, '/') },
  });
  assert.equal(labels.get('workflow'), box.workflow, 'адресат — воркспейс, содержащий папку стороны');
});

test('адресат — самая свежая сессия по журналу, а не по порядку списка', () => {
  const old = agent('s-old', 'C:/w', 'a');
  const fresh = agent('s-fresh', 'C:/w', 'b');
  const activity = new Map([['s-old', 1000], ['s-fresh', 5000]]);
  const pick = pickLastActive([old, fresh], 'C:/w', activity, { now: 6000 });
  assert.equal(pick.agent, fresh);
  assert.equal(pick.activityAt, 5000);
});

test('живой агент без cwd опознаётся по сессии из журнала воркспейса', () => {
  /*
   * The host reports a top-level session as `{ id }` only: no cwd, no label. Matching by
   * cwd alone made every such session invisible, and the wake spawned a second agent
   * instead of reaching the one already open.
   */
  const bare = { id: 's-bare', sendMessage: async () => {} };
  const activity = new Map([['s-bare', 5000]]);
  const pick = pickLastActive([bare], 'C:/w', activity, { now: 6000 });
  assert.equal(pick.agent, bare, 'сессия журнала этого корня — свой адресат, даже без cwd');
  assert.equal(pick.activityAt, 5000);
  assert.equal(pickLastActive([bare], 'C:/w', new Map(), { now: 6000 }), null, 'без cwd и без следа в журнале — не адресат');
});

test('живых сессий нет — адресата нет, выдумывать нечего', () => {
  const pick = pickLastActive([agent('s', 'C:/other', 'x')], 'C:/w', new Map(), { now: 1 });
  assert.equal(pick, null);
});

test('устаревшая привязка не уводит сообщение в мёртвую сессию', () => {
  const bound = agent('s-bound', 'C:/w', 'a');
  const fresh = agent('s-fresh', 'C:/w', 'b');
  const activity = new Map([['s-bound', 1000], ['s-fresh', 99000000]]);
  const day = 24 * 60 * 60 * 1000;
  const pick = pickLastActive([bound, fresh], 'C:/w', activity, { now: 100000000, binding: 's-bound', ttlMs: day });
  assert.equal(pick.agent, fresh, 'привязка старше sessionTtl игнорируется');
  const live = pickLastActive([bound, fresh], 'C:/w', activity, { now: 2000, binding: 's-bound', ttlMs: day });
  assert.equal(live.agent, bound, 'свежая привязка сильнее порядка');
});

await atest('ответ structure будит живую сессию workflow: сообщение, запись запуска, поля wake', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ roots: () => [target] }),
    activityOf: () => new Map([['s-workflow', 1793528000000]]),
    backlogMs: 60 * 60 * 1000,
  });
  const file = path.join(box.thread, '2026-11-01T13-31+03-00--structure--04.md');
  fs.writeFileSync(file, HEAD('structure', 'workflow', '2026-11-01T13:31+03:00', 'Subject: answer\n'));
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 1);
  assert.equal(target.inbox.length, 1);
  assert.match(target.inbox[0], /2026-11-01T13-31\+03-00--structure--04\.md/);
  assert.match(target.inbox[0], /Откройте файл/, 'wake требует открыть файл, а не только узнать путь');
  const runs = [...runtime.runs.values()];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].root, box.workflow);
  assert.equal(runs[0].kind, 'exchange');
  assert.equal(runs[0].state, 'done');
  assert.equal(runs[0].delivered, 'threads/critic-report/2026-11-01T13-31+03-00--structure--04.md');
  assert.equal(runs[0].wake.reason, 'last-active');
  assert.equal(runs[0].wake.target, 's-workflow');
});

/*
 * 0196: финальная запись exchange называет момент закрытия.
 *
 * Прежние поля — since, state, delivered, addressee, wake — остаются как были:
 * finishedAt только добавляется к факту, а не заменяет его.
 */
await atest('0196: финальная запись exchange несёт finishedAt, прежние поля сохранены', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ roots: () => [target] }),
    activityOf: () => new Map([['s-workflow', 1793528000000]]),
  });
  fs.writeFileSync(path.join(box.thread, 'finished-at.md'), HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  const before = Date.now();
  await watcher.tick();
  const after = Date.now();
  const runs = listRuns(runtime, box.workflow);
  assert.equal(runs.length, 1, 'одна запись exchange');
  const run = runs[0];
  assert.equal(run.kind, 'exchange');
  assert.equal(run.state, 'done');
  assert.equal(run.delivered, 'threads/critic-report/finished-at.md');
  assert.equal(run.addressee, box.workflow);
  assert.equal(run.wake.target, 's-workflow');
  assert.equal(run.wake.reason, 'last-active');
  assert.ok(Number.isFinite(run.finishedAt), 'finishedAt — число эпохи, мс');
  assert.ok(run.finishedAt >= before && run.finishedAt <= after, 'finishedAt — момент закрытия прогона');
  assert.ok(run.since <= run.finishedAt, 'since остался началом прогона');
});

await atest('0196: error-запись exchange тоже несёт finishedAt', async () => {
  const box = host();
  const stuck = {
    id: 's-stuck', sessionId: 's-stuck', cwd: box.workflow, label: 'workflow',
    sendMessage: () => new Promise(() => {}),
  };
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => [stuck] }),
    activityOf: () => new Map([['s-stuck', 1793528000000]]),
    deliveryTimeoutMs: 25,
    stuckAfterMs: 10,
  });
  fs.writeFileSync(path.join(box.thread, 'hang-finished.md'), HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  await watcher.tick();
  const run = [...runtime.runs.values()][0];
  assert.equal(run.state, 'error', 'зависание — ошибка');
  assert.ok(Number.isFinite(run.finishedAt), 'error-запись тоже закрыта моментом');
  assert.ok(run.finishedAt > 0);
  assert.match(run.message, /нет ответа/u, 'причина сохранена');
});

await atest('письмо Status: answer не будит, Status: request — будит (0081)', async () => {
  /*
   * Контракт доставки §1.5: answer — не действие. Он не создаёт записи запуска
   * kind: 'exchange', не пишет в сессию адресата и остаётся в ящике непрочитанным;
   * request в том же ящике по-прежнему будит — контроль, что фильтр не глушит всё.
   */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-answer-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const answer = path.join(box.thread, 'answer.md');
  fs.writeFileSync(answer, HEAD('structure', 'workflow', new Date().toISOString(), 'Status: answer\n'));
  const silent = await watcher.tick();
  assert.equal(silent.length, 0, 'answer не доставляется как действие');
  assert.equal(target.inbox.length, 0, 'answer не разбудил сессию адресата');
  assert.equal(listRuns(runtime, box.workflow).length, 0, 'записи запуска exchange нет');
  assert.equal(watcher.seen.has(answer), false, 'answer не помечен прочитанным');
  assert.ok(fs.existsSync(answer), 'answer остаётся в ящике: «не будить» — не «забыть»');
  /* request рядом — по-прежнему будит живую сессию тем же текстом. */
  const request = path.join(box.thread, 'request.md');
  fs.writeFileSync(request, HEAD('structure', 'workflow', new Date().toISOString()));
  const woken = await watcher.tick();
  assert.equal(woken.length, 1, 'request доставлен');
  assert.equal(target.inbox.length, 1, 'request разбудил живую сессию');
  assert.match(target.inbox[0], /Откройте файл/u, 'текст пробуждения прежний');
});

await atest('живой сессии нет — никто не разбужен, запись честно об этом', async () => {
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    /* Явный запрет: по умолчанию спящего адресата теперь поднимают. */
    config: { wakeSpawn: false },
    getAgents: () => ({ roots: () => [] }),
    activityOf: () => new Map(),
  });
  fs.writeFileSync(path.join(box.thread, 'a.md'), HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  await watcher.tick();
  const runs = [...runtime.runs.values()];
  assert.equal(runs.length, 1);
  /* Письмо доставлено в ящик; двойник не поднимается, значит это не ошибка. */
  assert.equal(runs[0].state, 'done');
  assert.equal(runs[0].wake.reason, 'box-only');
  assert.equal(runs[0].cwdSource, 'queued');
});

await atest('входящее workflow->structure будит свою сессию, а своё себе — нет', async () => {
  const box = host();
  const mine = agent('s-structure', box.structure, 'structure');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ roots: () => [mine] }),
    activityOf: () => new Map([['s-structure', 1793528000000]]),
  });
  fs.writeFileSync(path.join(box.thread, 'in.md'), HEAD('workflow', 'structure', '2026-11-01T13:20+03:00'));
  fs.writeFileSync(path.join(box.thread, 'self.md'), HEAD('structure', 'structure', '2026-11-01T13:21+03:00'));
  await watcher.tick();
  assert.equal(mine.inbox.length, 1, 'письмо workflow доставлено, письмо себе — нет');
});

await atest('0153: старая почта при старте доставляется, а не считается историей', async () => {
  /*
   * Задание 0153, D2: возраст не предел вручения. Прежнее правило «старая почта
   * не будит» отменено: письмо без отметки вручения доставляется при первой
   * возможности — старым считается только уже доставленное.
   */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const oldFile = path.join(box.thread, 'old.md');
  fs.writeFileSync(oldFile, HEAD('structure', 'workflow', '2026-10-31T10:00+03:00'));
  const past = new Date(Date.now() - 5 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, past, past);
  fs.writeFileSync(path.join(box.thread, 'new.md'), HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ roots: () => [target] }),
    activityOf: () => new Map([['s-workflow', 1793528000000]]),
    backlogMs: 30 * 60 * 1000,
  });
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 2, 'оба письма вручены: возраст не предел');
  assert.equal(target.inbox.length, 1, 'одно пробуждение на пачку');
  assert.match(target.inbox[0], /old\.md/u, 'старое письмо в пачке');
  assert.match(target.inbox[0], /new\.md/u, 'свежее письмо в пачке');
  assert.equal(watcher.seen.has(oldFile), true, 'старое вручено — отмечено');
});

await atest('повторный проход не дублирует доставку', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ roots: () => [target] }),
    activityOf: () => new Map([['s-workflow', 1793528000000]]),
  });
  fs.writeFileSync(path.join(box.thread, 'a.md'), HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  await watcher.tick();
  await watcher.tick();
  assert.equal(target.inbox.length, 1);
});

await atest('пять писем одному адресату — одно пробуждение, но пять записей запуска', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ roots: () => [target] }),
    activityOf: () => new Map([['s-workflow', 1793528000000]]),
  });
  for (let index = 1; index <= 5; index += 1) {
    const file = path.join(box.thread, 'msg-' + index + '.md');
    fs.writeFileSync(file, HEAD('structure', 'workflow', '2026-11-01T13:3' + index + '+03:00'));
    /*
     * Run identity includes the file's write time. Five writes in the same
     * millisecond (coarse Windows timestamps) collapse into one run key, so the
     * test gives each letter a distinct, still-recent mtime.
     */
    const stamp = new Date(Date.now() - 5000 + index * 10);
    fs.utimesSync(file, stamp, stamp);
  }
  await watcher.tick();
  assert.equal(target.inbox.length, 1, 'одно пробуждение на пачку');
  for (let index = 1; index <= 5; index += 1) assert.match(target.inbox[0], new RegExp('msg-' + index + '\\.md'));
  assert.equal([...runtime.runs.values()].length, 5, 'каждое сообщение — отдельный факт');
});

await atest('спящий адресат поднимается запуском с cwd его воркспейса (wakeSpawn)', async () => {
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const captured = [];
  /* Хост пишет фактический рабочий каталог сессии в свой кэш — берём оттуда. */
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cache-'));
  fs.writeFileSync(path.join(cache, 'child-9.json'), JSON.stringify({
    record: { rows: { workingDirectory: { val: { path: box.workflow } } } },
  }));
  const watcher = createExchangeWatcher({
    runtime,
    config: { wakeSpawn: true },
    sessionCacheDir: cache,
    getAgents: () => ({ list: () => [] }),
    getParent: () => ({ id: 'parent-1', cwd: box.structure }),
    getSubagents: () => ({
      resolveMaxDepth: () => 1,
      startActivation: async (request) => { captured.push(request); return { childId: 'child-9' }; },
    }),
    activityOf: () => new Map(),
  });
  fs.writeFileSync(path.join(box.thread, 'to-workflow.md'), HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  await watcher.tick();
  assert.equal(captured.length, 1, 'адресат поднят один раз');
  /* Регрессия 2026-11-01: без signal хост падал на throwIfAborted на старте. */
  assert.ok(captured[0].signal, 'запуску передаётся AbortSignal');
  assert.equal(captured[0].request.signal, captured[0].signal, 'и внутри request — тот же сигнал');
  assert.equal(captured[0].request.cwd, box.workflow, 'агент рождается в воркспейсе адресата');
  assert.match(captured[0].label, /^exchange:/);
  assert.match(captured[0].request.prompt[0].text, /to-workflow\.md/);
  const runs = [...runtime.runs.values()];
  assert.equal(runs[0].state, 'done');
  assert.equal(runs[0].agentCwd, box.workflow, 'в записи факт, а не намерение');
  assert.equal(runs[0].cwdMismatch, false, 'расхождение посчитано от факта');
  assert.equal(runs[0].wake.reason, 'spawn');
  assert.equal(runs[0].wake.target, 'child-9');
});

await atest('0153: письмо, оставленное в ящике (box-only), ждёт и доставляется живому агенту', async () => {
  /*
   * Задание 0153, D1: box-only — это «ждёт в ящике», а не «прочитано». Письмо
   * остаётся pending без отметки seen; как только появляется живая сессия
   * адресата, оно доставляется при первой возможности, без окна повтора.
   */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const file = path.join(box.thread, 'retry.md');
  let agents = [];
  const watcher = createExchangeWatcher({
    runtime,
    config: { wakeSpawn: false },
    getAgents: () => ({ list: () => agents }),
    activityOf: () => new Map([['s-workflow', 1793528000000]]),
    backlogMs: 60 * 60 * 1000,
  });
  fs.writeFileSync(file, HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  const first = new Date();
  await watcher.tick(first);
  const run = [...runtime.runs.values()][0];
  assert.equal(run.state, 'done', 'письмо обработано без ошибки');
  assert.equal(run.wake.reason, 'box-only');
  assert.equal(target.inbox.length, 0, 'двойник не поднят');
  assert.equal(watcher.seen.has(file), false, 'вручения не было — отметки seen нет');
  const waiting = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('retry.md'));
  assert.equal(waiting[waiting.length - 1].branch, 'skip:delivery-off',
    'причина ожидания названа в журнале, а не молчание');
  agents = [target];
  await watcher.tick(new Date(first.getTime() + 5000));
  assert.equal(target.inbox.length, 1, 'живая сессия появилась — письмо доставлено');
  assert.equal(watcher.seen.has(file), true, 'вручение отмечено');
});

await atest('окно догона берётся из конфига, если аргумент не задан', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const oldFile = path.join(box.thread, 'old-config.md');
  fs.writeFileSync(oldFile, HEAD('structure', 'workflow', '2026-10-31T10:00+03:00'));
  const past = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(oldFile, past, past);
  const watcher = createExchangeWatcher({
    runtime,
    config: { exchangeBacklogMs: 30 * 60 * 1000 },
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', 1793528000000]]),
  });
  await watcher.tick();
  assert.equal(target.inbox.length, 1, 'письмо в окне конфига доставлено');
});

await atest('зависшая отправка не блокирует ящик: таймаут и следующий проход', async () => {
  const box = host();
  const stuck = {
    id: 's-stuck', sessionId: 's-stuck', cwd: box.workflow, label: 'workflow',
    sendMessage: () => new Promise(() => {}),
  };
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => [stuck] }),
    activityOf: () => new Map([['s-stuck', 1793528000000]]),
    deliveryTimeoutMs: 25,
    stuckAfterMs: 10,
  });
  fs.writeFileSync(path.join(box.thread, 'hang.md'), HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  await watcher.tick();
  const run = [...runtime.runs.values()][0];
  assert.equal(run.state, 'error', 'зависание оформлено как ошибка, а не как тишина');
  assert.match(run.message, /нет ответа/u);
  /* Второй проход обязан пройти, хотя первый висел. */
  fs.writeFileSync(path.join(box.thread, 'next.md'), HEAD('structure', 'workflow', '2026-11-01T13:32+03:00'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 0, 'второй файл тоже не ушёл: сессия висит');
  const second = [...runtime.runs.values()].find((item) => String(item.delivered).includes('next.md'));
  assert.ok(second, 'второй файл всё равно обработан — очередь жива');
});

await atest('ack закрывает слот в записи того запуска, который доставил письмо', async () => {
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const since = Date.now() - 60000;
  noteRun(runtime, {
    root: box.workflow, node: 'workflow', kind: 'exchange', since, state: 'done',
    delivered: 'threads/critic-report/report.md', ack: null,
  });
  const target = agent('s-workflow', box.workflow, 'workflow');
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map(),
  });
  fs.writeFileSync(path.join(box.thread, 'ack.md'), [
    'From: workflow',
    'To: structure',
    'Date: 2026-11-01T14:45+03:00',
    'Thread: critic-report',
    'Status: ack',
    'Ref: threads/critic-report/report.md',
    '',
    'принято',
    '',
  ].join('\n'));
  await watcher.tick();
  const record = listRuns(runtime, box.workflow).find((row) => row.delivered === 'threads/critic-report/report.md');
  assert.equal(record.ack, 'threads/critic-report/ack.md', 'слот ack заполнен файлом подтверждения');
  assert.equal(target.inbox.length, 0, 'ack сам никого не будит');
  assert.equal(record.ackBy, undefined, 'шапка без Session не выдумывает автора ответа');
});

await atest('ack помнит автора: сессия из шапки и совпадение с адресатом', async () => {
  /*
   * Доставку --24 подтвердил через 63 с после спавна другой wake-сессией той же
   * стороны, а запись выглядела как «адресат ответил» (workflow, --46). Ящик знает
   * автора только по шапке Session:, поэтому запись хранит это имя и говорит,
   * совпало ли оно с сессией, ради которой письмо будили.
   */
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const since = Date.now() - 60000;
  noteRun(runtime, {
    root: box.workflow, node: 'workflow', kind: 'exchange', since, state: 'done',
    delivered: 'threads/critic-report/letter.md', wake: { target: 's-addressee', reason: 'spawn' }, ack: null,
  });
  noteRun(runtime, {
    root: box.workflow, node: 'workflow', kind: 'exchange', since: since + 1, state: 'done',
    delivered: 'threads/critic-report/letter2.md', wake: { target: 's-addressee', reason: 'spawn' }, ack: null,
  });
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => [] }),
    activityOf: () => new Map(),
  });
  const ack = (name, ref, session) => fs.writeFileSync(path.join(box.thread, name), [
    'From: workflow',
    'To: structure',
    'Date: 2026-11-01T19:45+03:00',
    'Thread: critic-report',
    'Status: ack',
    'Ref: ' + ref,
    'Session: ' + session,
    '',
    'принято',
    '',
  ].join('\n'));
  ack('ack-other.md', 'threads/critic-report/letter.md', 's-someone-else');
  ack('ack-own.md', 'threads/critic-report/letter2.md', 's-addressee');
  await watcher.tick();
  const rows = listRuns(runtime, box.workflow);
  const foreign = rows.find((row) => row.delivered === 'threads/critic-report/letter.md');
  const own = rows.find((row) => row.delivered === 'threads/critic-report/letter2.md');
  assert.equal(foreign.ack, 'threads/critic-report/ack-other.md', 'слот закрывается по Ref, как и раньше');
  assert.equal(foreign.ackBy, 's-someone-else', 'запись помнит, кто ответил');
  assert.equal(foreign.ackByAddressee, false, 'ответила не та сессия, ради которой будили');
  assert.equal(own.ackByAddressee, true, 'ответ адресата отличим от ответа чужого');
});

await atest('перезапуск не доставляет уже доставленное письмо: память живёт на диске', async () => {
  /*
   * Живая проба 2026-11-01: одно письмо доставлено трижды (18:14, 18:19, 18:24) —
   * каждый перезапуск хоста забывал seen, и окно догона делало пачку свежей заново.
   */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const file = path.join(box.thread, 'once.md');
  fs.writeFileSync(file, HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  const open = (options) => createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', 1793528000000]]),
    ...options,
  });
  await open({}).tick();
  assert.equal(target.inbox.length, 1, 'первый процесс доставил письмо');
  await open({}).tick();
  assert.equal(target.inbox.length, 1, 'второй процесс помнит доставку и молчит');
  assert.ok(fs.existsSync(seenPath(runtime)), 'память доставленного лежит рядом с записями запусков');
});

await atest('подтверждение переживает повторную доставку письма в том же проходе', async () => {
  /*
   * Порядок прохода 18:24: свежее письмо-ack обрабатывается раньше самого письма
   * (messageFiles сортирует свежие первыми), поэтому markAck заполняет слот, а
   * следующая за ним повторная доставка переписывала запись уже без ack.
   */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  fs.writeFileSync(path.join(box.thread, 'probe.md'), HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  const open = (options) => createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', 1793528000000]]),
    ...options,
  });
  await open({}).tick();
  assert.equal(target.inbox.length, 1);
  fs.writeFileSync(path.join(box.thread, 'ack-now.md'), [
    'From: workflow',
    'To: structure',
    'Date: 2026-11-01T14:45+03:00',
    'Thread: critic-report',
    'Status: ack',
    'Ref: threads/critic-report/probe.md',
    '',
    'принято',
    '',
  ].join('\n'));
  /* Пустая память доставленного = перезапуск хоста: письмо доставят снова. */
  const restarted = open({ seenPath: path.join(runtime.runsDir, 'empty-seen.json') });
  const delivered = await restarted.tick();
  /*
   * Одна доставка: письмо повторно (память пуста после перезапуска). Само подтверждение
   * с 2026-11-05 (задание 0081, контракт доставки §1.5) адресата не будит: слот ack
   * закрыт, но письма-пробуждения нет — иначе цепочка ответов не заканчивалась.
   */
  assert.equal(delivered.length, 1, 'письмо повторно, подтверждение не будит');
  const record = listRuns(runtime, box.workflow).find((row) => row.delivered === 'threads/critic-report/probe.md');
  assert.equal(record.ack, 'threads/critic-report/ack-now.md', 'повторная доставка не стирает подтверждение');
  assert.ok(record.ackAt, 'время подтверждения сохранено');
});

await atest('ack на чужое письмо ничего не ломает', async () => {
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const target = agent('s-workflow', box.workflow, 'workflow');
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map(),
  });
  fs.writeFileSync(path.join(box.thread, 'ack-foreign.md'), [
    'From: workflow',
    'To: structure',
    'Date: 2026-11-01T14:46+03:00',
    'Thread: critic-report',
    'Status: ack',
    'Ref: threads/critic-report/unknown.md',
    '',
    'не наше',
    '',
  ].join('\n'));
  await watcher.tick();
  assert.equal(listRuns(runtime, box.workflow).length, 0, 'чужая ссылка не создаёт записей');
});

await atest('без факта о рабочем каталоге запись честно partial, а не done', async () => {
  /*
   * Требование workflow --52 п. 3: если фактический cwd сессии получить нельзя, запись не
   * должна выглядеть как доказанная доставка — agentCwd: null, cwdMismatch: null, state: partial.
   */
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    config: { wakeSpawn: true },
    /* Кэша сессий нет: хост ещё не записал рабочий каталог. */
    sessionCacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pg-empty-cache-')),
    getAgents: () => ({ list: () => [] }),
    getParent: () => ({ id: 'parent-1', cwd: box.structure }),
    getSubagents: () => ({
      resolveMaxDepth: () => 1,
      startActivation: async () => ({ childId: 'no-cache-child' }),
    }),
    activityOf: () => new Map(),
  });
  fs.writeFileSync(path.join(box.thread, 'no-fact.md'), HEAD('structure', 'workflow', '2026-11-01T20:12+03:00'));
  await watcher.tick();
  const run = [...runtime.runs.values()][0];
  assert.equal(run.state, 'partial', 'намерение не выдаётся за факт');
  assert.equal(run.agentCwd, null);
  assert.equal(run.cwdMismatch, null);
  assert.equal(run.cwdSource, 'requested');
});

await atest('в одно пробуждение попадает не больше пяти писем, остаток — следующим', async () => {
  /* workflow --65 п.4: догон после сна выдал 52 письма одной стеной; теперь пачка ограничена. */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-cap-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  for (let i = 0; i < 7; i += 1) {
    fs.writeFileSync(path.join(box.thread, 'm' + i + '.md'), HEAD('structure', 'workflow', new Date().toISOString()));
  }
  await watcher.tick();
  assert.equal(target.inbox.length, 1, 'одно пробуждение на пачку');
  assert.match(target.inbox[0], /Новые сообщения в обмене: 5/u, 'не больше пяти в пачке');
  await watcher.tick(new Date(Date.now() + 5000));
  assert.equal(target.inbox.length, 2, 'остаток уходит следующим проходом');
});

await atest('0153: возраст не предел — письмо четырёхдневной давности доставляется', async () => {
  /*
   * Задание 0153, D2: прежнее правило «догон не вытаскивает историю» отменено.
   * Невидимое письмо доставляется хотя бы один раз независимо от возраста —
   * именно так ws-school-app не увидел два своих письма.
   */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const seenFile = path.join(os.tmpdir(), 'pg-seen-old-' + Date.now() + '.json');
  fs.writeFileSync(seenFile, JSON.stringify({ 'C:/старое/письмо.md': Date.now() - 86400000 }));
  const watcher = createExchangeWatcher({
    runtime,
    backlogMs: 60 * 1000,
    catchUpMs: 60 * 60 * 1000,
    seenPath: seenFile,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const file = path.join(box.thread, 'history.md');
  fs.writeFileSync(file, HEAD('structure', 'workflow', new Date().toISOString()));
  const ancient = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  fs.utimesSync(file, ancient, ancient);
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 1, 'старое письмо доставлено, а не сочтено историей');
  assert.equal(target.inbox.length, 1, 'вручено в сессию адресата');
  assert.equal(watcher.seen.has(file), true, 'вручение отмечено');
});

await atest('письмо, пропущенное пока хост спал, доставляется на первом проходе и не повторяется', async () => {
  /*
   * Заказчик, 2026-11-02: после перезагрузки координатор должен увидеть входящие, пришедшие
   * пока хост спал. С 0153 возраст вообще не предел (D2): важно лишь то, что второй проход
   * не повторяет вручённое — память вручений живёт на диске.
   */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const seenFile = path.join(os.tmpdir(), 'pg-seen-catch-' + Date.now() + '.json');
  /* Память доставленного — плоская карта «файл → mtime», как её пишет сам watcher. */
  fs.writeFileSync(seenFile, JSON.stringify({ 'C:/старое/письмо.md': Date.now() - 86400000 }));
  const watcher = createExchangeWatcher({
    runtime,
    backlogMs: 60 * 1000,
    seenPath: seenFile,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const file = path.join(box.thread, 'missed.md');
  fs.writeFileSync(file, HEAD('structure', 'workflow', new Date().toISOString()));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  await watcher.tick();
  assert.equal(target.inbox.length, 1, 'письмо трёхчасовой давности доставлено на первом проходе');
  await watcher.tick(new Date(Date.now() + 5000));
  assert.equal(target.inbox.length, 1, 'второй проход не повторяет');
});

await atest('ack закрывает слот, но не будит и не доставляется (0081)', async () => {
  /*
   * Контракт доставки §1.5 (2026-11-05): ack — не действие, адресата он не будит.
   * Правило 2026-11-02 «ack тоже доходит до адресата» отменено: закрытие договорённости
   * видно по слоту ack в записи запуска, а письмо остаётся в ящике непрочитанным —
   * будить на «принято» значит поднимать агента, которому нечего делать.
   */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-ack-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const ackFile = path.join(box.thread, 'ack.md');
  fs.writeFileSync(ackFile, HEAD('structure', 'workflow', new Date().toISOString(), 'Status: ack\n'));
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 0, 'ack не доставляется как действие');
  assert.equal(target.inbox.length, 0, 'ack не будит сессию адресата');
  assert.equal(watcher.seen.has(ackFile), false, 'ack не помечен прочитанным');
  assert.ok(fs.existsSync(ackFile), 'ack остаётся в ящике: «не будить» — не «забыть»');
});

await atest('EDIT дописанного письма не доставляет его повторно', async () => {
  /* workflow --61 п.4: правка — не новое письмо; повторный проход не должен будить никого. */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-edit-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const file = path.join(box.thread, 'edit.md');
  fs.writeFileSync(file, HEAD('structure', 'workflow', new Date().toISOString()));
  await watcher.tick();
  assert.equal(target.inbox.length, 1, 'первая доставка');
  fs.appendFileSync(file, '\nEDIT 21:10: уточнение\n');
  await watcher.tick(new Date(Date.now() + 5000));
  assert.equal(target.inbox.length, 1, 'правка не доставлена повторно');
});

await atest('письмо уходит в собственную сессию адресата через sessionController, без двойника', async () => {
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const prompts = [];
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => [] }),
    getSessionController: () => ({
      prompt: async (request, signal) => { prompts.push({ request, signal }); return { accepted: true }; },
    }),
    activityOf: (root) => (root === box.workflow ? new Map([['session-theirs', Date.now() - 60000]]) : new Map()),
    sessionCacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pg-bus-cache-')),
  });
  fs.writeFileSync(path.join(box.thread, 'to-session.md'), HEAD('structure', 'workflow', '2026-11-01T20:40+03:00'));
  await watcher.tick();
  assert.equal(prompts.length, 1, 'ровно одна доставка');
  assert.equal(prompts[0].request.sessionId, 'session-theirs', 'доставлено в сессию адресата');
  assert.equal(prompts[0].request.mode, 'queue');
  assert.ok(prompts[0].request.requestId.startsWith('exchange:'));
  assert.ok(prompts[0].signal && typeof prompts[0].signal.throwIfAborted === 'function', 'вторым аргументом — AbortSignal');
  const run = [...runtime.runs.values()][0];
  assert.equal(run.state, 'done');
  assert.equal(run.wake.reason, 'session-bus');
  assert.equal(run.wake.target, 'session-theirs');
});

await atest('сессия, занятая маршрутом субагентов, пропускается: письмо уходит следующей', async () => {
  /*
   * Живой случай (workflow --57): самой свежей была сессия d778518f, но хост ответил
   * «is owned by subagent routing». Такая сессия не адресат — берём следующую по свежести.
   */
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const tried = [];
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => [] }),
    getSessionController: () => ({
      prompt: async (request) => {
        tried.push(request.sessionId);
        if (request.sessionId === 'session-owned') throw new Error('session "session-owned" is owned by subagent routing');
        return { accepted: true };
      },
    }),
    activityOf: (root) => (root === box.workflow
      ? new Map([['session-owned', Date.now() - 1000], ['session-operator', Date.now() - 60000]])
      : new Map()),
    sessionCacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pg-owned-cache-')),
  });
  fs.writeFileSync(path.join(box.thread, 'owned.md'), HEAD('structure', 'workflow', '2026-11-01T21:05+03:00'));
  await watcher.tick();
  assert.deepEqual(tried, ['session-owned', 'session-operator'], 'сначала свежая, потом операторская');
  const run = [...runtime.runs.values()][0];
  assert.equal(run.state, 'done');
  assert.equal(run.wake.target, 'session-operator', 'доставлено в сессию, которая приняла');
});

await atest('явный wakeSpawn:false — двойник не поднимается: письмо ждёт своего агента', async () => {
  /*
   * Живой факт 2026-11-01: настоящая сессия workflow писала --52/--54/--56 без шапки Session, а все
   * письма с Session = child id порождал наш спавн. Выключатель обязан оставаться сильнее
   * нового дефолта (0150): пока сторона работает, поднимать кого-то нельзя.
   */
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const captured = [];
  const now = Date.now();
  const watcher = createExchangeWatcher({
    runtime,
    /* Явный выключатель: новый дефолт включил бы спавн. */
    config: { wakeSpawn: false },
    getAgents: () => ({ list: () => [] }),
    getParent: () => ({ id: 'parent-1', cwd: box.structure }),
    getSubagents: () => ({
      resolveMaxDepth: () => 1,
      startActivation: async (spec) => { captured.push(spec); return { childId: 'twin' }; },
    }),
    activityOf: (root) => (root === box.workflow ? new Map([['live-side', now - 60 * 1000]]) : new Map()),
  });
  fs.writeFileSync(path.join(box.thread, 'to-live-side.md'), HEAD('structure', 'workflow', '2026-11-01T20:35+03:00'));
  await watcher.tick(new Date(now));
  assert.equal(captured.length, 0, 'двойник не поднят');
  const run = [...runtime.runs.values()][0];
  assert.equal(run.state, 'done');
  assert.equal(run.wake.reason, 'box-only');
  assert.equal(run.cwdSource, 'queued', 'письмо лежит в ящике, а не у агента-двойника');
});

await atest('спящий адресат продолжает СВОЮ сессию, а не получает чужого агента', async () => {
  /*
   * Живой дефект 2026-11-01: wake создавал нового агента в нашем воркспейсе, тот писал
   * «From: workflow» — обмен выглядел рабочим, хотя настоящая сессия адресата не получала
   * ничего. Теперь активация получает childId последней активной сессии воркспейса и
   * продолжает её.
   */
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const captured = [];
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cache2-'));
  fs.writeFileSync(path.join(cache, 'session-theirs.json'), JSON.stringify({
    record: { rows: { workingDirectory: { val: { path: box.workflow } } } },
  }));
  const watcher = createExchangeWatcher({
    runtime,
    config: { wakeSpawn: true },
    sessionCacheDir: cache,
    getAgents: () => ({ list: () => [] }),
    getParent: () => ({ id: 'parent-1', cwd: box.structure }),
    getSubagents: () => ({
      resolveMaxDepth: () => 1,
      startActivation: async (spec) => { captured.push(spec); return { childId: spec.childId || 'fresh-child' }; },
    }),
    activityOf: (root) => (root === box.workflow
      ? new Map([['session-theirs', 1793528000000]])
      : new Map()),
  });
  fs.writeFileSync(path.join(box.thread, 'to-their-session.md'), HEAD('structure', 'workflow', '2026-11-01T18:29+03:00'));
  await watcher.tick();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].childId, 'session-theirs', 'активация продолжает сессию адресата');
  assert.equal(captured[0].request.cwd, box.workflow);
  const run = [...runtime.runs.values()][0];
  assert.equal(run.state, 'done');
  assert.equal(run.wake.reason, 'resume');
  assert.equal(run.wake.target, 'session-theirs');
  /* The record now names the workspace the wake was asked to run in, not only "done". */
  assert.equal(run.cwd, box.workflow, 'в записи запуска виден cwd адресата');
});

test('файлы обмена собираются из threads, README не считается сообщением', () => {
  const box = host();
  const files = messageFiles([box.box]);
  assert.equal(files.length, 0, 'README лежит в корне, а не в threads');
  fs.writeFileSync(path.join(box.thread, 'm.md'), HEAD('a', 'b', '2026-11-01T10:00+03:00'));
  assert.equal(messageFiles([box.box]).length, 1);
});

/*
 * Живой дефект 2026-11-01: при пустом runtime сторож сканировал 0 корней и молча ничего не
 * доставлял — единственным следом было отсутствие доставок. Предупреждение нужно на переходе
 * в ноль, а не на каждом 30-секундном проходе, иначе оно само станет шумом.
 */
await atest('ноль корней: одно предупреждение на переход в ноль, проход продолжается', async () => {
  const box = host();
  let list = [];
  const runtime = runtimeOf([]);
  runtime.allowedRoots = () => list;
  const warned = [];
  const watcher = createExchangeWatcher({
    runtime,
    config: { wakeSpawn: true },
    getAgents: () => ({ list: () => [] }),
    logger: { warn: (message) => warned.push(String(message)) },
  });
  await watcher.tick();
  assert.equal(warned.length, 1, 'первый проход с 0 корней говорит один раз');
  assert.match(warned[0], /координац|coordination/iu);
  assert.match(warned[0], /не доставляются/iu);
  await watcher.tick();
  await watcher.tick();
  assert.equal(warned.length, 1, 'пока держится ноль — молчим');
  list = [box.structure, box.workflow];
  await watcher.tick();
  assert.equal(warned.length, 1, 'корни вернулись — новых строк нет');
  list = [];
  await watcher.tick();
  assert.equal(warned.length, 2, 'новый переход в ноль — новое предупреждение');
});

/*
 * Протокол папки (задание 0015): адресат, объявленный участником папки, получает
 * письмо в сессию только после квитанции Status: accepted. До неё письмо остаётся
 * в ящике (reason box-only) и не помечается доставленным — иначе квитанция,
 * пришедшая минутой позже, уже ничего бы не включила.
 */
await atest('доставка только принявшим: до квитанции письмо ждёт в ящике, после — доставляется', async () => {
  const box = host();
  fs.mkdirSync(path.join(box.structure, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(box.structure, 'structure', 'graph.json'), JSON.stringify({
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'shared' },
      exchange: { threads: ['critic-report'], contract: 'contract.md' },
      participants: ['structure', 'workflow'],
      orchestrator: 'coordinator',
    }],
    edges: [],
  }, null, 2));
  fs.writeFileSync(path.join(box.box, 'contract.md'), [
    'Format: dsh-exchange/1-contract',
    'Rev: 1',
    'Initiator: structure',
    'Invited: workflow',
    '',
  ].join('\n'));
  const runtime = runtimeOf([box.structure, box.workflow], {
    structureDir: 'structure',
    participants: { structure: box.structure, workflow: box.workflow },
    me: 'structure',
  });
  const target = agent('s-workflow', box.workflow, 'workflow');
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-accept-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  fs.writeFileSync(path.join(box.thread, 'to-invited.md'), HEAD('structure', 'workflow', '2026-11-02T16:00+03:00'));

  const before = await watcher.tick();
  assert.equal(target.inbox.length, 0, 'не принявшему в сессию не доставляем');
  assert.equal(before.length, 0, 'в списке доставленного письма нет');
  const waiting = [...runtime.runs.values()].find((row) => row.node === 'workflow');
  assert.equal(waiting.wake.reason, 'box-only', 'письмо остаётся в ящике');
  assert.equal(waiting.state, 'done', 'это не ошибка доставки');

  fs.writeFileSync(path.join(box.thread, 'receipt.md'), [
    'Format: dsh-exchange/1',
    'From: workflow',
    'To: structure',
    'Date: 2026-11-02T16:01+03:00',
    'Thread: critic-report',
    'Status: accepted',
    'Session: session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'Ref: contract.md',
    'Subject: приглашение принято',
    '',
    'принято',
    '',
  ].join('\n'));

  await watcher.tick(new Date(Date.now() + 1000));
  assert.equal(target.inbox.length, 1, 'после квитанции письмо доставлено в сессию');
});

/*
 * Задание 0048: инициатор папки — accepted по определению, а решение по каждому
 * письму пишется в exchange-decisions.jsonl, чтобы отказ не был тишиной.
 */
await atest('инициатор папки accepted по определению: письмо идёт в его сессию, решение delivered', async () => {
  const box = folderHost();
  const runtime = runtimeOf([box.structure, box.workflow], {
    participants: { structure: box.structure, workflow: box.workflow },
  });
  const prompts = [];
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => [] }),
    getSessionController: () => ({
      prompt: async (request) => { prompts.push(request); return { accepted: true }; },
    }),
    activityOf: (root) => (root === box.structure ? new Map([['session-own', Date.now()]]) : new Map()),
    sessionCacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pg-initiator-cache-')),
    backlogMs: 60 * 60 * 1000,
  });
  fs.writeFileSync(path.join(box.thread, 'to-initiator.md'),
    HEAD('workflow', 'structure', new Date().toISOString()));
  await watcher.tick();
  assert.equal(prompts.length, 1, 'инициатору доставлено, а не оставлено в ящике');
  assert.equal(prompts[0].sessionId, 'session-own', 'доставлено в его собственную сессию');
  const delivered = decisionsOf(runtime).filter((row) => row.branch === 'delivered');
  assert.equal(delivered.length, 1, 'решение delivered записано');
  assert.equal(delivered[0].session, 'session-own', 'в решении названа сессия вручения');
  assert.match(delivered[0].letter, /to-initiator\.md$/u);
  const seen = JSON.parse(fs.readFileSync(seenPath(runtime), 'utf8'));
  assert.ok(Object.keys(seen).some((key) => key.endsWith('to-initiator.md')), 'вручение попало в exchange-seen');
});

await atest('приглашённый без квитанции ждёт, решение gate:invited называет письмо и участника', async () => {
  const box = folderHost();
  const runtime = runtimeOf([box.structure, box.workflow], {
    participants: { structure: box.structure, workflow: box.workflow },
  });
  const prompts = [];
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-gate-invited-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [] }),
    getSessionController: () => ({
      prompt: async (request) => { prompts.push(request); return { accepted: true }; },
    }),
    activityOf: (root) => (root === box.workflow ? new Map([['session-theirs', Date.now()]]) : new Map()),
    backlogMs: 60 * 60 * 1000,
  });
  fs.writeFileSync(path.join(box.thread, 'to-invited.md'),
    HEAD('structure', 'workflow', new Date().toISOString()));
  await watcher.tick();
  assert.equal(prompts.length, 0, 'без квитанции в сессию не доставляем');
  const gated = decisionsOf(runtime).filter((row) => row.branch === 'gate:invited');
  assert.equal(gated.length, 1, 'решение gate:invited записано');
  assert.equal(gated[0].participant, 'workflow', 'в решении назван участник');
  assert.match(gated[0].letter, /to-invited\.md$/u, 'в решении назван путь письма');
  assert.ok(!fs.existsSync(seenPath(runtime)), 'отказ не попадает в память вручений');
});

/*
 * Задание 0049: инициатор папки — accepted с точки зрения ЛЮБОГО читателя.
 * Та же папка читается из копии приглашённой стороны (её structure/graph.json тот
 * же) и состояние инициатора не понижается: читатель не является его квитанцией.
 * Приглашённый без квитанции остаётся invited в обеих копиях (контроль).
 */
await atest('states папки: инициатор accepted в копии приглашённой стороны, приглашённый остаётся invited', async () => {
  const box = folderHost();
  fs.mkdirSync(path.join(box.workflow, 'structure'), { recursive: true });
  fs.copyFileSync(path.join(box.structure, 'structure', 'graph.json'),
    path.join(box.workflow, 'structure', 'graph.json'));
  const runtime = runtimeOf([box.structure, box.workflow], {
    participants: { structure: box.structure, workflow: box.workflow },
  });
  const ofInitiator = readExchangeFolders(runtime, box.structure);
  const ofInvited = readExchangeFolders(runtime, box.workflow);
  assert.equal(ofInitiator.length, 1, 'инициатор видит папку');
  assert.equal(ofInvited.length, 1, 'приглашённый видит ту же папку');
  assert.equal(ofInitiator[0].initiator, 'structure', 'инициатор назван контрактом');
  assert.equal(ofInvited[0].initiator, 'structure', 'инициатор — из контракта, а не из читателя');
  assert.equal(ofInitiator[0].states.structure, 'accepted', 'в своей копии инициатор accepted');
  assert.equal(ofInvited[0].states.structure, 'accepted',
    'в копии приглашённой стороны инициатор тоже accepted (задание 0049)');
  assert.equal(ofInitiator[0].states.workflow, 'invited', 'приглашённый без квитанции invited');
  assert.equal(ofInvited[0].states.workflow, 'invited', 'приглашённый остаётся invited и в своей копии');
});

/*
 * Задание 0159: ревизия квитанции. Без Rev — легаси-принятие (иначе все текущие
 * папки разом стали бы invited); Rev >= ревизии контракта — тоже принятие.
 * Только Rev меньше контракта значит «квитанция устарела».
 */
await atest('0159: квитанция без Rev и квитанция Rev >= контракта принимают папку', async () => {
  const legacy = folderHost();
  fs.writeFileSync(path.join(legacy.thread, 'receipt-legacy.md'), RECEIPT_HEAD('workflow', 'structure', null));
  const legacyRuntime = runtimeOf([legacy.structure, legacy.workflow], {
    participants: { structure: legacy.structure, workflow: legacy.workflow },
  });
  const ofLegacy = readExchangeFolders(legacyRuntime, legacy.structure).find((item) => item.id === 'folder-1');
  assert.equal(ofLegacy.contractRev, 4, 'ревизия контракта видна в записи папки');
  assert.equal(ofLegacy.states.workflow, 'accepted', 'квитанция без Rev — легаси-принятие');
  assert.equal(ofLegacy.reason, '', 'у принятой папки причины отказа нет');

  const fresh = folderHost();
  fs.writeFileSync(path.join(fresh.thread, 'receipt-fresh.md'), RECEIPT_HEAD('workflow', 'structure', 4));
  const freshRuntime = runtimeOf([fresh.structure, fresh.workflow], {
    participants: { structure: fresh.structure, workflow: fresh.workflow },
  });
  const ofFresh = readExchangeFolders(freshRuntime, fresh.structure).find((item) => item.id === 'folder-1');
  assert.equal(ofFresh.states.workflow, 'accepted', 'Rev не меньше контракта — принятие');
  assert.equal(ofFresh.reason, '', 'причины отказа нет');
  assert.ok(staleReceipt(2, 4), 'Rev 2 < 4 устарела');
  assert.ok(!staleReceipt(4, 4), 'Rev 4 = 4 не устарела');
  assert.ok(!staleReceipt(null, 4), 'без Rev сравнивать не с чем');
  assert.equal(staleReceiptReason(2, 4, 'workflow'),
    'квитанция устарела: Rev 2 < 4 — нужна новая квитанция от workflow');
});

/*
 * Задание 0159: устаревшая квитанция снимает принятие стороны и называется
 * словами. Письма в обе стороны ждут в ящике: адресат не принял папку, а письмо
 * отправителя написано под старой ревизией контракта.
 */
await atest('0159: квитанция Rev 2 < 4 — invited, причина словами, письма обеих сторон ждут', async () => {
  const box = folderHost();
  fs.writeFileSync(path.join(box.thread, 'receipt-old.md'), RECEIPT_HEAD('workflow', 'structure', 2));
  const runtime = runtimeOf([box.structure, box.workflow], {
    participants: { structure: box.structure, workflow: box.workflow },
  });
  const folder = readExchangeFolders(runtime, box.structure).find((item) => item.id === 'folder-1');
  assert.equal(folder.states.structure, 'accepted', 'инициатор accepted по определению');
  assert.equal(folder.states.workflow, 'invited', 'устаревшая квитанция не выдаёт себя за принятие');
  assert.match(String(folder.reason), /квитанция устарела: Rev 2 < 4/u, 'причина называет обе ревизии');
  assert.match(String(folder.reason), /workflow/u, 'причина называет участника');

  const target = agent('s-workflow', box.workflow, 'workflow');
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-0159-stale-seen-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: (root) => (root === box.workflow ? new Map([['s-workflow', Date.now()]]) : new Map()),
    wakeSpawn: true,
    backlogMs: 60 * 60 * 1000,
  });
  fs.writeFileSync(path.join(box.thread, 'to-stale.md'), HEAD('structure', 'workflow', new Date().toISOString()));
  fs.writeFileSync(path.join(box.thread, 'from-stale.md'), HEAD('workflow', 'structure', new Date().toISOString()));
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 0, 'устаревшая квитанция не доставляет писем');
  assert.equal(target.inbox.length, 0, 'в сессию ничего не вручено');
  const gateRows = decisionsOf(runtime).filter((row) => row.branch === 'gate:stale-receipt');
  assert.equal(gateRows.length, 2, 'решение записано по каждому письму: ' + JSON.stringify(gateRows));
  assert.deepEqual([...new Set(gateRows.map((row) => row.gateSide))].sort(), ['addressee', 'sender'],
    'названо, чья квитанция устарела');
  assert.match(waitingReasonText('gate:stale-receipt'), /квитанция устарела/u, 'причина ждёт слов, а не кода');
});

/*
 * Задание 0159, инвариант 4: check-exchange называет причину словами. Ящик
 * синтетический, но путь тот же: сторож пишет решение, CLI читает журнал.
 */
await atest('0159: check-exchange называет устаревшую квитанцию словами', async () => {
  const box = folderHost();
  /* Инициатор — workflow: structure в этой папке приглашённая сторона. */
  fs.writeFileSync(path.join(box.box, 'contract.md'), [
    'Format: dsh-exchange/1-contract',
    'Rev: 4',
    'Initiator: workflow',
    'Invited: structure',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(box.thread, 'receipt-old.md'), RECEIPT_HEAD('structure', 'workflow', 2));
  const runtime = runtimeOf([box.structure, box.workflow], {
    participants: { structure: box.structure, workflow: box.workflow },
  });
  const target = agent('s-structure', box.structure, 'structure');
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-0159-cli-seen-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: (root) => (root === box.structure ? new Map([['s-structure', Date.now()]]) : new Map()),
    wakeSpawn: true,
    backlogMs: 60 * 60 * 1000,
  });
  fs.writeFileSync(path.join(box.thread, 'from-workflow.md'), HEAD('workflow', 'structure', new Date().toISOString()));
  await watcher.tick();
  assert.equal(target.inbox.length, 0, 'устаревшая квитанция держит письмо в ящике');
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0159-cli-store-'));
  const tool = path.join(process.cwd(), 'tools', 'check-exchange.mjs');
  const run = spawnSync(process.execPath, [tool, '--root', box.structure, '--journal', decisionsPath(runtime)], {
    encoding: 'utf8',
    env: { ...process.env, DSH_PROJECT_GRAPH_STORE: store },
  });
  const out = String(run.stdout || '') + String(run.stderr || '');
  assert.equal(run.status, 1, 'письмо осталось непрочитанным: ' + out.slice(0, 400));
  assert.match(out, /ждёт вручения: gate:stale-receipt/u, 'ветка ожидания названа');
  assert.match(out, /квитанция устарела/u, 'причина названа словами');
});

await atest('0153: письмо вне окна догона доставляется, stale:backlog не пишется', async () => {
  /*
   * Задание 0153, D2: `stale:backlog` к невручённому не применяется. Окно
   * осталось только названием возраста в решениях, которые вручением не являются.
   */
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const target = agent('s-workflow', box.workflow, 'workflow');
  const windowMs = 30 * 60 * 1000;
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-stale-seen-' + Date.now() + '.json'),
    backlogMs: windowMs,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const file = path.join(box.thread, 'old.md');
  fs.writeFileSync(file, HEAD('structure', 'workflow', new Date().toISOString()));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 1, 'письмо старше окна всё равно доставлено');
  assert.equal(target.inbox.length, 1, 'вручено в сессию адресата');
  assert.equal(decisionsOf(runtime).filter((row) => row.branch === 'stale:backlog').length, 0,
    'невручённое письмо не записывается как потерянное окном');
  const row = decisionsOf(runtime).find((item) => item.branch === 'delivered'
    && String(item.letter || '').endsWith('old.md'));
  assert.ok(row, 'вручение записано в журнал');
});

await atest('повторный проход не дублирует решения: delivered и gate пишутся один раз', async () => {
  const box = folderHost();
  const runtime = runtimeOf([box.structure, box.workflow], {
    participants: { structure: box.structure, workflow: box.workflow },
  });
  const prompts = [];
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-idempotent-seen-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [] }),
    getSessionController: () => ({
      prompt: async (request) => { prompts.push(request); return { accepted: true }; },
    }),
    activityOf: (root) => (root === box.structure ? new Map([['session-own', Date.now()]]) : new Map()),
    backlogMs: 60 * 60 * 1000,
  });
  fs.writeFileSync(path.join(box.thread, 'initiator.md'),
    HEAD('workflow', 'structure', new Date().toISOString()));
  fs.writeFileSync(path.join(box.thread, 'invited.md'),
    HEAD('structure', 'workflow', new Date().toISOString()));
  await watcher.tick();
  const first = decisionsOf(runtime);
  await watcher.tick(new Date(Date.now() + 5000));
  const second = decisionsOf(runtime);
  assert.equal(prompts.length, 1, 'доставка не повторилась');
  assert.equal(second.length, first.length, 'журнал не вырос на повторном проходе');
  assert.equal(second.filter((row) => row.branch === 'delivered').length, 1, 'одна запись delivered');
  assert.equal(second.filter((row) => row.branch === 'gate:invited').length, 1, 'одна запись gate:invited');
});
/*
 * Задание 0099: журнал доставки говорит о себе. «Не доставлено, потому что статус не
 * будит» (skip:no-wake), «доставлено раньше — перенос ящика не потеря» (rescan:delivered),
 * «доставка выключена» (skip:delivery-off) и «попытка ждёт окна» (skip:cooldown) —
 * разные ветки, а не одно молчание и не один stale:backlog на всё.
 */
await atest('не-будящий статус: решение skip:no-wake, письмо не прочитано, повтор не плодит строк', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-nowake-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
    backlogMs: 60 * 60 * 1000,
  });
  const file = path.join(box.thread, 'answer-9.md');
  fs.writeFileSync(file, STATUS_HEAD('answer'));
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 0, 'answer не доставляется как действие');
  assert.equal(target.inbox.length, 0, 'answer не будит живую сессию');
  assert.equal(watcher.seen.has(file), false, 'не-будящее письмо не помечается прочитанным');
  let rows = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('answer-9.md'));
  assert.equal(rows.length, 1, 'решение по не-будящему письму записано один раз');
  assert.equal(rows[0].branch, 'skip:no-wake', 'ветка называет дизайн, а не потерю');
  assert.equal(rows[0].to, 'workflow', 'в решении назван адресат');
  await watcher.tick(new Date(Date.now() + 5000));
  rows = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('answer-9.md'));
  assert.equal(rows.length, 1, 'повторный проход не добавил решение');
  /* Новый процесс (пустая память доставленного) читает журнал и тоже не плодит. */
  const restarted = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-nowake2-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
    backlogMs: 60 * 60 * 1000,
  });
  await restarted.tick(new Date(Date.now() + 6000));
  rows = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('answer-9.md'));
  assert.equal(rows.length, 1, 'дедупликация журнала переживает перезапуск');
});

await atest('вручение пишет sha256 содержимого и сессию адресата', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-digest-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const text = STATUS_HEAD('request');
  fs.writeFileSync(path.join(box.thread, 'digest.md'), text);
  await watcher.tick();
  const row = decisionsOf(runtime).find((item) => item.branch === 'delivered'
    && String(item.letter || '').endsWith('digest.md'));
  assert.ok(row, 'решение delivered записано');
  assert.equal(row.sha256, letterSha256(text), 'sha256 содержимого письма в записи вручения');
  assert.equal(row.session, 's-workflow', 'сессия адресата в записи вручения');
});

await atest('повторный скан доставленного после переноса ящика: rescan:delivered по sha256', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const text = STATUS_HEAD('request');
  const digest = letterSha256(text);
  const journal = decisionsPath(runtime);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  /* Вручение было сделано в ДРУГОМ ящике: путь тогда был другим, содержимое — то же. */
  fs.writeFileSync(journal, JSON.stringify({
    at: '2026-11-05T10:48:50+03:00', box: 'C:/old-box', letter: 'threads/critic-report/moved.md',
    to: 'workflow', branch: 'delivered', sha256: digest, session: 's-old',
  }) + '\n');
  const file = path.join(box.thread, 'moved.md');
  fs.writeFileSync(file, text);
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-rescan-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
    backlogMs: 60 * 60 * 1000,
  });
  await watcher.tick();
  const rows = decisionsOf(runtime);
  const rescan = rows.filter((row) => row.branch === 'rescan:delivered');
  assert.equal(rescan.length, 1, 'повторный скан назван rescan:delivered');
  assert.equal(rescan[0].sha256, digest, 'опознание по содержимому, а не по пути');
  assert.equal(rescan[0].session, 's-old', 'rescan называет сессию прежнего вручения');
  assert.equal(rows.filter((row) => row.branch === 'stale:backlog').length, 0,
    'доставленное не превращается в потерянное окном');
  assert.equal(rows.filter((row) => row.branch === 'delivered').length, 1,
    'прежняя запись вручения не переписана');
});

await atest('старое письмо со статусом answer — skip:no-wake, а не stale:backlog', async () => {
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-old-nowake-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [] }),
    activityOf: () => new Map(),
    backlogMs: 30 * 60 * 1000,
  });
  const file = path.join(box.thread, 'old-answer.md');
  fs.writeFileSync(file, STATUS_HEAD('answer'));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  await watcher.tick();
  const rows = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('old-answer.md'));
  assert.equal(rows.length, 1, 'решение по письму записано');
  assert.equal(rows[0].branch, 'skip:no-wake', 'дизайн не превращается в «потеряно окном»');
  assert.ok(Number(rows[0].ageMs) > Number(rows[0].windowMs), 'возраст письма всё равно назван');
});

await atest('доставка выключена и живой сессии нет: skip:delivery-off, а не no-session', async () => {
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    /* Явный тормоз доставки: спящего адресата не поднимаем и в сессию не отдаём. */
    wakeSpawn: false,
    seenPath: path.join(os.tmpdir(), 'pg-seen-off-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [] }),
    activityOf: () => new Map(),
  });
  fs.writeFileSync(path.join(box.thread, 'off.md'), STATUS_HEAD('request'));
  await watcher.tick();
  const rows = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('off.md'));
  assert.equal(rows.length, 1, 'решение о выключенной доставке записано');
  assert.equal(rows[0].branch, 'skip:delivery-off', 'причина названа отдельной веткой');
  assert.equal(decisionsOf(runtime).filter((row) => row.branch === 'no-session').length, 0,
    'прежняя ветка no-session больше не прячет выключенную доставку');
});

await atest('подавление окном повтора — skip:cooldown, а не молчание', async () => {
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const broken = {
    id: 's-broken', sessionId: 's-broken', cwd: box.workflow, label: 'workflow',
    sendMessage: async () => { throw new Error('служба не приняла сообщение'); },
  };
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-cooldown-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [broken] }),
    activityOf: () => new Map([['s-broken', Date.now()]]),
  });
  fs.writeFileSync(path.join(box.thread, 'retry-9.md'), STATUS_HEAD('request'));
  const first = new Date();
  await watcher.tick(first);
  assert.equal(decisionsOf(runtime).filter((row) => String(row.branch || '').startsWith('error:')).length, 1,
    'первая попытка названа ошибкой');
  await watcher.tick(new Date(first.getTime() + 5000));
  const cooldown = decisionsOf(runtime).filter((row) => row.branch === 'skip:cooldown'
    && String(row.letter || '').endsWith('retry-9.md'));
  assert.equal(cooldown.length, 1, 'подавление названо, а не молчание');
  assert.ok(Number(cooldown[0].waitMs) > 0, 'в решении сказано, сколько ждать');
  await watcher.tick(new Date(first.getTime() + 6000));
  assert.equal(decisionsOf(runtime).filter((row) => row.branch === 'skip:cooldown').length, 1,
    'повторный проход не плодит строку');
});

await atest('доставленному письму skip:cooldown не пишется: ответ уже есть', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-seen-nocooldown-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  fs.writeFileSync(path.join(box.thread, 'done-9.md'), STATUS_HEAD('request'));
  const first = new Date();
  await watcher.tick(first);
  const before = decisionsOf(runtime).length;
  await watcher.tick(new Date(first.getTime() + 5000));
  const rows = decisionsOf(runtime);
  assert.equal(rows.length, before, 'журнал не вырос: доставленному нечего ждать');
  assert.equal(rows.filter((row) => row.branch === 'skip:cooldown').length, 0);
});
/*
 * Задание 0111: ответ спящему адресату будит — но только если это ответ на ЕГО вопрос.
 *
 * 06.11 два answer пролежали ~18 минут: письмо доставлено, разбор не запущен, будильником
 * был заказчик. Правило 0081 (answer не будит) спасло от пинг-понга, но создало тихую
 * потерю. Здесь проверяется узкий предикат wakeDecision, батч-дайджест и лимиты.
 */

/** Шапка письма с Ref: на что отвечаем (задание 0111). */
function letterHead({ status, from, to, subject = 'x', ref = '', thread = 'critic-report', date = new Date().toISOString() }) {
  return 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nThread: ' + thread
    + '\nStatus: ' + status + '\nSubject: ' + subject + '\n' + (ref ? 'Ref: ' + ref + '\n' : '') + '\nтекст\n';
}

/** Старое письмо: вопрос, на который отвечают, не должен сам попасть в тик. */
function writeOld(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
}

test('wakeDecision: ack не будит, требующие действия буkдят (0081 не сломан)', () => {
  const context = { self: 'structure', idle: true, inTurn: false, throttled: false };
  const base = { status: 'request', path: 'threads/t/1.md', from: 'workflow', subject: 'тема' };
  assert.equal(wakeDecision({ ...base, status: 'ack' }, context).wake, false, 'ack не будит');
  assert.equal(wakeDecision({ ...base, status: 'ack' }, context).cause, 'skip:ack');
  for (const status of ['request', 'question', 'proposal', 'report', 'invitation']) {
    const decision = wakeDecision({ ...base, status }, context);
    assert.equal(decision.wake, true, status + ' требует действия');
    assert.equal(decision.cause, 'delivered:wake', status + ': причина вручения');
  }
  assert.equal(wakeDecision({ ...base, status: '  REQUEST ' }, context).wake, true, 'регистр и пробелы');
});

test('wakeDecision: answer будит только как ответ на собственный вопрос адресата', () => {
  const context = { self: 'structure', idle: true, inTurn: false, throttled: false };
  const answer = { status: 'answer', replyToStatus: 'question', replyToAuthor: 'structure', path: 'threads/t/1.md', from: 'workflow', subject: 'ответ' };
  const own = wakeDecision(answer, context);
  assert.equal(own.wake, true, 'ответ на свой question будит');
  assert.equal(own.cause, 'delivered:wake-answer', 'причина — ответ на вопрос');
  assert.equal(wakeDecision({ ...answer, replyToStatus: 'request' }, context).cause, 'delivered:wake-answer',
    'request — такой же вопрос');
  for (const [letter, why] of [
    [{ ...answer, replyToStatus: 'answer' }, 'ответ на answer'],
    [{ ...answer, replyToStatus: 'ack' }, 'ответ на ack'],
    [{ ...answer, replyToAuthor: 'workflow' }, 'ответ на чужой вопрос'],
    [{ ...answer, replyToAuthor: '' }, 'автор ответа неизвестен'],
    [{ ...answer, status: 'agreed' }, 'agreed не действие'],
  ]) {
    const decision = wakeDecision(letter, context);
    assert.equal(decision.wake, false, why + ' не будит');
    assert.equal(decision.cause, 'skip:no-wake', why + ': skip:no-wake');
  }
  assert.equal(wakeDecision({ ...answer, replyToAuthor: ' STRUCTURE ' }, { ...context, self: 'structure' }).wake, true,
    'автор сравнивается без учёта регистра и пробелов');
});

test('wakeDecision: активный, идущий ход и лимит названы причиной (0111, C4)', () => {
  const answer = { status: 'answer', replyToStatus: 'question', replyToAuthor: 'structure' };
  const context = { self: 'structure', idle: true, inTurn: false, throttled: false };
  assert.equal(wakeDecision(answer, { ...context, inTurn: true }).cause, 'skip:in-turn', 'идёт ход');
  assert.equal(wakeDecision(answer, { ...context, idle: false }).cause, 'skip:active', 'адресат активен');
  assert.equal(wakeDecision(answer, { ...context, throttled: true }).cause, 'skip:cooldown', 'лимит');
  for (const situation of [{ ...context, inTurn: true }, { ...context, idle: false }, { ...context, throttled: true }]) {
    assert.equal(wakeDecision(answer, situation).wake, false, 'ни одна из причин не будит');
  }
  /* Порядок веток — смысл: ход важнее активности, активность важнее лимита. */
  assert.equal(wakeDecision(answer, { ...context, inTurn: true, idle: false, throttled: true }).cause, 'skip:in-turn');
  assert.equal(wakeDecision(answer, { ...context, idle: false, throttled: true }).cause, 'skip:active');
});

test('buildWakeDigest: одно сообщение со всеми письмами и оговоркой про answer', () => {
  const text = buildWakeDigest([
    { path: 'threads/imperative/1.md', from: 'workflow', subject: 'первый ответ', status: 'answer' },
    { path: 'threads/imperative/2.md', from: 'workflow', subject: 'второй ответ', status: 'answer' },
    { path: 'threads/exchange/3.md', from: 'reach-proxy', subject: 'третий ответ', status: 'answer' },
  ]);
  assert.equal(typeof text, 'string', 'дайджест — строка');
  for (const part of ['1.md', '2.md', '3.md', 'workflow', 'reach-proxy', 'первый ответ', 'второй ответ', 'третий ответ', 'answer']) {
    assert.ok(text.includes(part), 'в дайджесте есть ' + part);
  }
  assert.ok(text.includes('ответ на ваш вопрос; ход не обязателен, если вопрос закрыт'),
    'оговорка снимает обязанность отвечать: вопрос мог быть закрыт');
  assert.ok(text.split('\n').length > 3, 'это сообщение, а не путь');
  assert.ok(buildWakeDigest([]).includes('0'), 'пустая пачка не падает');
});

test('createWakeThrottle: 1/ветку/15 мин и 5/ящик/час, память процесса', () => {
  assert.equal(WAKE_BRANCH_COOLDOWN_MS, 15 * 60 * 1000, 'окно ветки — 15 минут');
  assert.equal(WAKE_BOX_LIMIT, 5, 'потолок ящика — пять в час');
  const throttle = createWakeThrottle();
  const t0 = 1_000_000;
  assert.equal(throttle.allow('/box', 'thread-a', t0).allowed, true, 'первое пробуждение ветки');
  throttle.mark('/box', 'thread-a', t0);
  const second = throttle.allow('/box', 'thread-a', t0 + 60_000);
  assert.equal(second.allowed, false, 'второе в ту же ветку — отказ');
  assert.equal(second.cause, 'skip:cooldown', 'причина названа');
  assert.equal(second.limit, 'branch', 'ограничение ветки');
  assert.ok(second.waitMs > 0, 'сказано, сколько ждать');
  assert.equal(throttle.allow('/box', 'thread-b', t0 + 60_000).allowed, true, 'другая ветка свободна');
  assert.equal(throttle.allow('/box', 'thread-a', t0 + WAKE_BRANCH_COOLDOWN_MS).allowed, true,
    'через 15 минут ветка снова свободна');

  const boxed = createWakeThrottle();
  for (let index = 0; index < WAKE_BOX_LIMIT; index += 1) {
    assert.equal(boxed.allow('/box', 'branch-' + index, t0 + index * 1000).allowed, true, 'письмо ' + index + ' в лимите');
    boxed.mark('/box', 'branch-' + index, t0 + index * 1000);
  }
  const overflow = boxed.allow('/box', 'branch-new', t0 + 10_000);
  assert.equal(overflow.allowed, false, 'шестое в тот же час — отказ');
  assert.equal(overflow.limit, 'box', 'ограничение ящика');
  assert.equal(boxed.allow('/other-box', 'branch-new', t0 + 10_000).allowed, true, 'другой ящик не задет');
  assert.equal(boxed.allow('/box', 'branch-new', t0 + WAKE_BOX_WINDOW_MS + 1000).allowed, true,
    'через час окно ящика очищается');
});

await atest('0111: answer на свой вопрос будит одним дайджестом вместе с остальными письмами тика', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const seenFile = path.join(os.tmpdir(), 'pg-seen-0111-' + Date.now() + '.json');
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: seenFile,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  /*
   * Вопросы адресата старые и уже вручены раньше: с 0153 письмо без отметки
   * доставляется независимо от возраста, поэтому старые вопросы помечены seen —
   * здесь проверяется разрешение Ref, а не судьба самих вопросов.
   */
  const q1 = path.join(box.thread, 'q-1.md');
  const q2 = path.join(box.thread, 'q-2.md');
  writeOld(q1, letterHead({ status: 'question', from: 'workflow', to: 'structure', subject: 'вопрос 1' }));
  writeOld(q2, letterHead({ status: 'question', from: 'workflow', to: 'structure', subject: 'вопрос 2' }));
  markSeenFile(seenFile, [q1, q2]);
  fs.writeFileSync(path.join(box.thread, 'r-1.md'), letterHead({ status: 'request', from: 'structure', to: 'workflow', subject: 'просьба' }));
  fs.writeFileSync(path.join(box.thread, 'a-1.md'), letterHead({
    status: 'answer', from: 'structure', to: 'workflow', subject: 'ответ 1',
    ref: 'threads/critic-report/q-1.md',
  }));
  fs.writeFileSync(path.join(box.thread, 'a-2.md'), letterHead({
    status: 'answer', from: 'structure', to: 'workflow', subject: 'ответ 2',
    ref: 'threads/critic-report/q-2.md',
  }));
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 3, 'три письма доставлены');
  assert.equal(target.inbox.length, 1, 'одно сообщение на весь тик, а не три');
  const text = target.inbox[0];
  for (const part of ['r-1.md', 'a-1.md', 'a-2.md', 'ответ 1', 'ответ 2']) {
    assert.ok(text.includes(part), 'дайджест называет ' + part);
  }
  assert.ok(text.includes('ответ на ваш вопрос; ход не обязателен, если вопрос закрыт'),
    'ответ несёт оговорку: вопрос мог быть уже закрыт');
  const answerRows = decisionsOf(runtime).filter((row) => ['a-1.md', 'a-2.md'].some((name) => String(row.letter || '').endsWith(name)));
  assert.equal(answerRows.length, 2, 'решение по каждому ответу');
  for (const row of answerRows) {
    assert.equal(row.branch, 'delivered', 'ответ доставлен');
    assert.equal(row.cause, 'delivered:wake-answer', 'причина — ответ на свой вопрос');
  }
  const requestRow = decisionsOf(runtime).find((row) => String(row.letter || '').endsWith('r-1.md'));
  assert.equal(requestRow.cause, 'delivered:wake', 'обычное письмо будит по 0081');
});

await atest('0111: ответ на ответ и ответ на чужой вопрос не будят', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const seenFile = path.join(os.tmpdir(), 'pg-seen-0111-no-' + Date.now() + '.json');
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: seenFile,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const qOld = path.join(box.thread, 'q-old.md');
  const qForeign = path.join(box.thread, 'q-foreign.md');
  writeOld(qOld, letterHead({ status: 'question', from: 'workflow', to: 'structure' }));
  writeOld(path.join(box.thread, 'a-old.md'), letterHead({ status: 'answer', from: 'workflow', to: 'structure' }));
  writeOld(qForeign, letterHead({ status: 'question', from: 'reach-proxy', to: 'structure' }));
  /* Старые вопросы уже вручены раньше (0153); ответ a-old остаётся контролем. */
  markSeenFile(seenFile, [qOld, qForeign]);
  fs.writeFileSync(path.join(box.thread, 'a-answer.md'), letterHead({
    status: 'answer', from: 'structure', to: 'workflow', subject: 'ответ на ответ',
    ref: 'threads/critic-report/a-old.md',
  }));
  fs.writeFileSync(path.join(box.thread, 'a-foreign.md'), letterHead({
    status: 'answer', from: 'structure', to: 'workflow', subject: 'ответ на чужой вопрос',
    ref: 'threads/critic-report/q-foreign.md',
  }));
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 0, 'ответы не доставляются как действие');
  assert.equal(target.inbox.length, 0, 'адресат не разбужен');
  for (const name of ['a-answer.md', 'a-foreign.md']) {
    const rows = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith(name));
    assert.equal(rows.length, 1, name + ': решение записано');
    assert.equal(rows[0].branch, 'skip:no-wake', name + ': причина — нечего будить');
    assert.equal(rows[0].cause, 'skip:no-wake', name + ': предикат назван в журнале');
    assert.equal(rows[0].to, 'workflow', name + ': адресат назван');
  }
  assert.equal(watcher.seen.has(path.join(box.thread, 'a-answer.md')), false, 'не прочитано: «не будить» — не «забыть»');
});

await atest('0111: идёт ход адресата — ответ ждёт, причина skip:in-turn', async () => {
  const box = host();
  const busy = { ...agent('s-workflow', box.workflow, 'workflow'), running: true };
  const runtime = runtimeOf([box.structure, box.workflow]);
  const seenFile = path.join(os.tmpdir(), 'pg-seen-0111-turn-' + Date.now() + '.json');
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: seenFile,
    getAgents: () => ({ list: () => [busy] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const qTurn = path.join(box.thread, 'q-turn.md');
  writeOld(qTurn, letterHead({ status: 'question', from: 'workflow', to: 'structure' }));
  markSeenFile(seenFile, [qTurn]);
  fs.writeFileSync(path.join(box.thread, 'a-turn.md'), letterHead({
    status: 'answer', from: 'structure', to: 'workflow', ref: 'threads/critic-report/q-turn.md',
  }));
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 0, 'во время хода не будим');
  assert.equal(busy.inbox.length, 0, 'в сессию ничего не отправлено');
  const rows = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('a-turn.md'));
  assert.equal(rows.length, 1, 'решение записано');
  assert.equal(rows[0].branch, 'skip:in-turn', 'причина — идёт ход');
  assert.equal(rows[0].cause, 'skip:in-turn');
});

await atest('0111: лимит ветки — второй ответ за 15 минут ждёт', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const seenFile = path.join(os.tmpdir(), 'pg-seen-0111-branch-' + Date.now() + '.json');
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: seenFile,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const start = new Date();
  const qb1 = path.join(box.thread, 'q-b1.md');
  const qb2 = path.join(box.thread, 'q-b2.md');
  writeOld(qb1, letterHead({ status: 'question', from: 'workflow', to: 'structure' }));
  writeOld(qb2, letterHead({ status: 'question', from: 'workflow', to: 'structure' }));
  markSeenFile(seenFile, [qb1, qb2]);
  fs.writeFileSync(path.join(box.thread, 'a-b1.md'), letterHead({
    status: 'answer', from: 'structure', to: 'workflow', ref: 'threads/critic-report/q-b1.md',
  }));
  const first = await watcher.tick(start);
  assert.equal(first.length, 1, 'первый ответ доставлен');
  assert.equal(target.inbox.length, 1);
  fs.writeFileSync(path.join(box.thread, 'a-b2.md'), letterHead({
    status: 'answer', from: 'structure', to: 'workflow', ref: 'threads/critic-report/q-b2.md',
  }));
  const second = await watcher.tick(new Date(start.getTime() + 60_000));
  assert.equal(second.length, 0, 'второй ответ в ту же ветку за 15 минут не будит');
  assert.equal(target.inbox.length, 1, 'нового сообщения нет');
  const rows = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('a-b2.md'));
  assert.equal(rows.length, 1, 'отказ назван решением');
  assert.equal(rows[0].branch, 'skip:cooldown', 'ветка отказа');
  assert.equal(rows[0].cause, 'skip:cooldown', 'причина в журнале');
  assert.ok(Number(rows[0].waitMs) > 0, 'сказано, сколько ждать');
  assert.equal(watcher.seen.has(path.join(box.thread, 'a-b2.md')), false, 'письмо осталось в ящике до окна');
});

await atest('0111: лимит ящика — пятое пробуждение в час, шестое ждёт', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  /* Две ветки-письма на ящик: branch-лимит не должен маскировать лимит ящика. */
  const throttle = createWakeThrottle({ boxLimit: 2 });
  const seenFile = path.join(os.tmpdir(), 'pg-seen-0111-box-' + Date.now() + '.json');
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: seenFile,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
    wakeThrottle: throttle,
  });
  const start = new Date();
  const names = [];
  const questions = [];
  for (let index = 1; index <= 3; index += 1) {
    const thread = 'thread-' + index;
    const dir = path.join(box.box, 'threads', thread);
    fs.mkdirSync(dir, { recursive: true });
    const question = path.join(dir, 'q.md');
    writeOld(question, letterHead({ status: 'question', from: 'workflow', to: 'structure', thread }));
    questions.push(question);
  }
  /* Вопросы старые и уже вручены раньше (0153): иначе они сами стали бы доставкой. */
  markSeenFile(seenFile, questions);
  for (let index = 1; index <= 3; index += 1) {
    const thread = 'thread-' + index;
    const dir = path.join(box.box, 'threads', thread);
    const answer = path.join(dir, 'a.md');
    fs.writeFileSync(answer, letterHead({
      status: 'answer', from: 'structure', to: 'workflow', thread,
      ref: 'threads/' + thread + '/q.md',
    }));
    names.push(answer);
    await watcher.tick(new Date(start.getTime() + index * 1000));
  }
  assert.equal(target.inbox.length, 2, 'два пробуждения в лимите ящика');
  const rows = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('thread-3/a.md'));
  assert.equal(rows.length, 1, 'третий ответ назван решением');
  assert.equal(rows[0].branch, 'skip:cooldown', 'шестое (здесь третье при потолке 2) — отказ');
  assert.equal(rows[0].cause, 'skip:cooldown');
  assert.ok(Number(rows[0].waitMs) > 0, 'сказано, сколько ждать');
});

/*
 * Задание 0132: ack записи прогона по факту файла-ответа.
 *
 * Заказчик (coordinator --01 п.1): за 6 дней 152 обменных прогона, ack заполнен
 * у 15 — письма-ответы писались вручную, а запись прогона их не видела. Сверка
 * при закрытии прогона ищет в объявленном ящике письмо от адресата (wake.target,
 * иначе node) с Reply-To на delivered в окне от since до finishedAt + 30 минут.
 * Нашла — ack: путь от папки обмена и ackSource: 'file'; не нашла и окно истекло —
 * ack: null и ackCheckedAt, потому что ложный ack запрещён.
 */
function ackHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-watch-0132-'));
  const box = path.join(root, 'coordination');
  const thread = path.join(box, 'threads', 'critic-report');
  fs.mkdirSync(thread, { recursive: true });
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      participants: ['structure', 'workflow'],
      orchestrator: 'coordinator',
    }],
    edges: [],
  }, null, 2));
  return { root, box, thread };
}

/** Письмо обмена с Reply-To на закрываемое; статус — параметр, а не константа. */
function ackLetter(from, to, replyTo, at = new Date(), status = 'answer') {
  return ['Format: dsh-exchange/1', 'From: ' + from, 'To: ' + to, 'Date: ' + at.toISOString(),
    'Thread: critic-report', 'Status: ' + status, ...(replyTo ? ['Reply-To: ' + replyTo] : []),
    'Subject: x', '', 'текст', ''].join('\n');
}

/** Прогон, доставивший delivered и ещё не подтверждённый. */
function ackRun(runtime, dir, options = {}) {
  const finishedAt = options.finishedAt === undefined ? Date.now() - 60_000 : options.finishedAt;
  noteRun(runtime, {
    root: dir,
    node: options.node || 'coordinator',
    state: 'done',
    since: options.since === undefined ? finishedAt - 60_000 : options.since,
    finishedAt,
    delivered: options.delivered || 'threads/critic-report/delivered.md',
    ...(options.wake === undefined ? { wake: { target: 'workflow' } } : { wake: options.wake }),
  });
  return listRuns(runtime, dir)[0];
}

test('0132: ack записи прогона заполняется письмом-ответом адресата', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  fs.writeFileSync(path.join(host.thread, 'delivered.md'),
    ackLetter('structure', 'workflow', null, new Date(Date.now() - 90_000), 'report'));
  fs.writeFileSync(path.join(host.thread, 'reply.md'),
    ackLetter('workflow', 'structure', 'threads/critic-report/delivered.md', new Date(Date.now() - 30_000)));
  ackRun(runtime, host.root);
  const report = reconcileRunAck({ runtime, root: host.root });
  assert.deepEqual([report.checked, report.acked], [1, 1], 'одна запись сверена и одна закрыта');
  const row = listRuns(runtime, host.root)[0];
  assert.equal(row.ack, 'threads/critic-report/reply.md', 'ack — путь ответа от папки обмена');
  assert.equal(row.ackSource, 'file', 'источник ack назван: файл, а не markAck');
  assert.ok(row.ackAt, 'время сверки записано');
  assert.equal(ACK_RECONCILE_WINDOW_MS, 30 * 60 * 1000, 'окно — 30 минут после прогона');
});

test('0132: ответа нет — ack: null и ackCheckedAt, когда окно истекло', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  fs.writeFileSync(path.join(host.thread, 'delivered.md'),
    ackLetter('structure', 'workflow', null, new Date(Date.now() - 90_000), 'report'));
  ackRun(runtime, host.root);
  const later = Date.now() + 40 * 60_000;
  const report = reconcileRunAck({ runtime, root: host.root, now: later });
  assert.deepEqual([report.checked, report.acked], [1, 0], 'сверено, но не найдено');
  const row = listRuns(runtime, host.root)[0];
  assert.equal(row.ack, null, 'ложный ack запрещён');
  assert.equal(row.ackCheckedAt, new Date(later).toISOString(), 'отметка сверки поставлена');
});

test('0132: окно ещё открыто — запись не трогается, сверка повторится', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  fs.writeFileSync(path.join(host.thread, 'delivered.md'),
    ackLetter('structure', 'workflow', null, new Date(Date.now() - 90_000), 'report'));
  ackRun(runtime, host.root);
  const report = reconcileRunAck({ runtime, root: host.root, now: Date.now() + 60_000 });
  assert.equal(report.acked, 0);
  const row = listRuns(runtime, host.root)[0];
  assert.ok(!row.ack, 'ack не выдуман');
  assert.ok(!row.ackCheckedAt, 'пока окно открыто, «проверено» — неправда');
});

test('0132: Reply-To на другое письмо заявку не закрывает', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  fs.writeFileSync(path.join(host.thread, 'delivered.md'),
    ackLetter('structure', 'workflow', null, new Date(Date.now() - 90_000), 'report'));
  fs.writeFileSync(path.join(host.thread, 'other.md'),
    ackLetter('structure', 'workflow', null, new Date(Date.now() - 90_000), 'report'));
  fs.writeFileSync(path.join(host.thread, 'reply.md'),
    ackLetter('workflow', 'structure', 'threads/critic-report/other.md', new Date(Date.now() - 30_000)));
  ackRun(runtime, host.root);
  reconcileRunAck({ runtime, root: host.root });
  const row = listRuns(runtime, host.root)[0];
  assert.ok(!row.ack, 'чужой Reply-To не закрыл прогон');
});

test('0132: чужой From не закрывает: адресат прогона — это wake.target', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  fs.writeFileSync(path.join(host.thread, 'delivered.md'),
    ackLetter('structure', 'workflow', null, new Date(Date.now() - 90_000), 'report'));
  fs.writeFileSync(path.join(host.thread, 'reply.md'),
    ackLetter('reach-proxy', 'structure', 'threads/critic-report/delivered.md', new Date(Date.now() - 30_000)));
  ackRun(runtime, host.root);
  reconcileRunAck({ runtime, root: host.root });
  assert.ok(!listRuns(runtime, host.root)[0].ack, 'письмо не от адресата — не доказательство');
});

test('0132: голое имя Reply-To разрешается в папке письма', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  fs.writeFileSync(path.join(host.thread, 'delivered.md'),
    ackLetter('structure', 'workflow', null, new Date(Date.now() - 90_000), 'report'));
  fs.writeFileSync(path.join(host.thread, 'reply.md'),
    ackLetter('workflow', 'structure', 'delivered.md', new Date(Date.now() - 30_000)));
  ackRun(runtime, host.root);
  reconcileRunAck({ runtime, root: host.root });
  assert.equal(listRuns(runtime, host.root)[0].ack, 'threads/critic-report/reply.md', 'имя без папки читается рядом с письмом');
});

test('0132: ответ, записанный до прогона, окном не принимается', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  fs.writeFileSync(path.join(host.thread, 'delivered.md'),
    ackLetter('structure', 'workflow', null, new Date(Date.now() - 90_000), 'report'));
  /* Письмо старше since: это вчерашняя переписка, а не ответ на этот прогон. */
  fs.writeFileSync(path.join(host.thread, 'reply.md'),
    ackLetter('workflow', 'structure', 'threads/critic-report/delivered.md', new Date(Date.now() - 3_600_000)));
  ackRun(runtime, host.root);
  reconcileRunAck({ runtime, root: host.root });
  assert.ok(!listRuns(runtime, host.root)[0].ack, 'письмо вне окна не закрывает');
});

test('0132: markAck не перезаписывается и не обнуляется сверкой', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  fs.writeFileSync(path.join(host.thread, 'delivered.md'),
    ackLetter('structure', 'workflow', null, new Date(Date.now() - 90_000), 'report'));
  fs.writeFileSync(path.join(host.thread, 'reply.md'),
    ackLetter('workflow', 'structure', 'threads/critic-report/delivered.md', new Date(Date.now() - 30_000)));
  ackRun(runtime, host.root);
  const manual = markAck([host.root], runtime, { ref: 'threads/critic-report/delivered.md', session: 'session-x' },
    'threads/critic-report/ack-manual.md');
  assert.equal(manual.ack, 'threads/critic-report/ack-manual.md', 'наблюдатель закрыл запись');
  const report = reconcileRunAck({ runtime, root: host.root });
  assert.equal(report.checked, 0, 'запись уже подтверждена — сверять нечего');
  const row = listRuns(runtime, host.root)[0];
  assert.equal(row.ack, 'threads/critic-report/ack-manual.md', 'markAck остаётся в силе');
  assert.equal(row.ackBy, 'session-x', 'кто ответил — факт письма, не сверки');
  assert.notEqual(row.ackSource, 'file', 'сверка не выдала себя за источник');
});

test('0132: повторная сверка идемпотентна', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  fs.writeFileSync(path.join(host.thread, 'delivered.md'),
    ackLetter('structure', 'workflow', null, new Date(Date.now() - 90_000), 'report'));
  fs.writeFileSync(path.join(host.thread, 'reply.md'),
    ackLetter('workflow', 'structure', 'threads/critic-report/delivered.md', new Date(Date.now() - 30_000)));
  ackRun(runtime, host.root);
  reconcileRunAck({ runtime, root: host.root });
  const second = reconcileRunAck({ runtime, root: host.root });
  assert.equal(second.checked, 0, 'закрытая запись повторно не сверяется');
  assert.equal(listRuns(runtime, host.root)[0].ack, 'threads/critic-report/reply.md');
});

/*
 * Задание 0164: Ref — второй адрес закрытия, наравне с Reply-To.
 *
 * ws-school-app: письма отвечены через Ref, а счётчик «требует хода» держал их.
 * Один резолвер закрытия (resolveClosingPath) теперь спрашивают об ОБОИХ полях:
 * сверка ack записи прогона и markAck (наблюдатель) считают закрытием письмо,
 * чей Ref ИЛИ Reply-To разрешается в delivered. Прежде бралось первое непустое
 * поле, и квитанция с Ref на контракт теряла настоящий адрес в Reply-To.
 */
function refLetter(from, to, options = {}) {
  const status = options.status || 'answer';
  const at = options.at instanceof Date ? options.at : new Date();
  return ['Format: dsh-exchange/1', 'From: ' + from, 'To: ' + to, 'Date: ' + at.toISOString(),
    'Thread: critic-report', 'Status: ' + status,
    ...(options.ref ? ['Ref: ' + options.ref] : []),
    ...(options.replyTo ? ['Reply-To: ' + options.replyTo] : []),
    'Subject: x', '', 'текст', ''].join('\n');
}

test('0164: reconcileRunAck закрывает прогон по Ref, когда Reply-To нет', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  fs.writeFileSync(path.join(host.thread, 'delivered.md'),
    refLetter('structure', 'workflow', { status: 'report', at: new Date(Date.now() - 90_000) }));
  fs.writeFileSync(path.join(host.thread, 'reply-ref.md'),
    refLetter('workflow', 'structure', { ref: 'threads/critic-report/delivered.md', at: new Date(Date.now() - 30_000) }));
  ackRun(runtime, host.root);
  const report = reconcileRunAck({ runtime, root: host.root });
  assert.deepEqual([report.checked, report.acked], [1, 1], 'Ref закрыл прогон');
  const row = listRuns(runtime, host.root)[0];
  assert.equal(row.ack, 'threads/critic-report/reply-ref.md', 'ack — путь письма с Ref');
  assert.equal(row.ackSource, 'file', 'источник — файл, а не markAck');
});

test('0164: reconcileRunAck — Ref и Reply-To равноправны, закрывает любой из них', () => {
  /* Квитанция называет контракт в Ref и письмо в Reply-To: закрывает Reply-To. */
  const byReply = ackHost();
  const runtime = runtimeOf([byReply.root]);
  fs.writeFileSync(path.join(byReply.thread, 'contract.md'), 'Format: dsh-exchange/1-contract\nRev: 2\n');
  fs.writeFileSync(path.join(byReply.thread, 'delivered.md'),
    refLetter('structure', 'workflow', { status: 'report', at: new Date(Date.now() - 90_000) }));
  fs.writeFileSync(path.join(byReply.thread, 'receipt.md'),
    refLetter('workflow', 'structure', {
      status: 'ack',
      ref: 'contract.md',
      replyTo: 'threads/critic-report/delivered.md',
      at: new Date(Date.now() - 30_000),
    }));
  ackRun(runtime, byReply.root);
  reconcileRunAck({ runtime, root: byReply.root });
  assert.equal(listRuns(runtime, byReply.root)[0].ack, 'threads/critic-report/receipt.md',
    'Ref на контракт не отменяет закрытие по Reply-To');

  /* Обратный случай: Ref называет письмо, Reply-To — контракт. */
  const byRef = ackHost();
  const runtimeRef = runtimeOf([byRef.root]);
  fs.writeFileSync(path.join(byRef.thread, 'contract.md'), 'Format: dsh-exchange/1-contract\nRev: 2\n');
  fs.writeFileSync(path.join(byRef.thread, 'delivered.md'),
    refLetter('structure', 'workflow', { status: 'report', at: new Date(Date.now() - 90_000) }));
  fs.writeFileSync(path.join(byRef.thread, 'receipt-ref.md'),
    refLetter('workflow', 'structure', {
      status: 'ack',
      ref: 'threads/critic-report/delivered.md',
      replyTo: 'contract.md',
      at: new Date(Date.now() - 30_000),
    }));
  ackRun(runtimeRef, byRef.root);
  reconcileRunAck({ runtime: runtimeRef, root: byRef.root });
  assert.equal(listRuns(runtimeRef, byRef.root)[0].ack, 'threads/critic-report/receipt-ref.md',
    'Ref на письмо закрывает прогон, даже когда Reply-To называет контракт');
});

test('0164: markAck ищет delivered в обоих полях квитанции', () => {
  const host = ackHost();
  const runtime = runtimeOf([host.root]);
  ackRun(runtime, host.root);
  const manual = markAck([host.root], runtime, {
    ref: 'contract.md',
    replyTo: 'threads/critic-report/delivered.md',
    session: 'session-ref',
  }, 'threads/critic-report/ack-ref.md');
  assert.ok(manual, 'наблюдатель нашёл запись по Reply-To, хотя Ref другой');
  assert.equal(manual.ack, 'threads/critic-report/ack-ref.md', 'слот закрыт');
  assert.equal(manual.ackBy, 'session-ref', 'автор квитанции сохранён');
  assert.equal(markAck([host.root], runtime, { ref: 'contract.md', replyTo: 'other.md' }, 'x.md'), null,
    'ни одно поле не совпало с delivered — закрывать нечего');
});

test('0164: parseMessage хранит Ref и Reply-To раздельно, закрытие видит оба', () => {
  const message = parseMessage(refLetter('workflow', 'structure', {
    status: 'ack',
    ref: 'contract.md',
    replyTo: 'threads/critic-report/letter.md',
  }), 'ack.md');
  assert.equal(message.ref, 'contract.md', 'исторический «первый адрес» не изменился');
  assert.equal(message.replyTo, 'threads/critic-report/letter.md', 'Reply-To читается отдельным полем');
});

await atest('0164: check-exchange печатает ошибку формата Ref и сходится по «требуют хода»', async () => {
  const host = ackHost();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0164-cli-store-'));
  fs.writeFileSync(path.join(host.thread, 'request.md'),
    refLetter('workflow', 'structure', { status: 'request', at: new Date(Date.now() - 120_000) }));
  fs.writeFileSync(path.join(host.thread, 'answer.md'),
    refLetter('structure', 'workflow', {
      status: 'answer',
      ref: 'threads/critic-report/нет-такого.md',
      at: new Date(Date.now() - 60_000),
    }));
  const tool = path.join(process.cwd(), 'tools', 'check-exchange.mjs');
  const run = spawnSync(process.execPath, [tool, '--root', host.root], {
    encoding: 'utf8',
    env: { ...process.env, DSH_PROJECT_GRAPH_STORE: store },
  });
  const out = String(run.stdout || '') + String(run.stderr || '');
  assert.equal(run.status, 1, 'заявка осталась непрочитанной — код 1: ' + out.slice(0, 300));
  assert.match(out, /ошибка формата: 1/u, 'ошибка формата посчитана: ' + out.slice(0, 500));
  assert.match(out, /поле Ref «threads\/critic-report\/нет-такого\.md»/u, 'поле и значение названы словами');
  assert.match(out, /заявка не закрыта/u, 'сказано следствие: заявка не закрыта');
  assert.match(out, /требуют хода: 1/u, 'заявка остаётся в счёте «требуют хода»');
  assert.match(out, /\[непрочитано\]/u, 'видно, что она ещё и в непрочитанных');
  assert.match(out, /итог: непрочитано 1[^\n]*требуют хода 1[^\n]*ошибок формата 1/u,
    'итог называет оба счёта и число ошибок');
});

await atest('0164: check-exchange снимает заявку, закрытую по Ref', async () => {
  const host = ackHost();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0164-cli-ref-'));
  fs.writeFileSync(path.join(host.thread, 'request.md'),
    refLetter('workflow', 'structure', { status: 'request', at: new Date(Date.now() - 120_000) }));
  fs.writeFileSync(path.join(host.thread, 'answer.md'),
    refLetter('structure', 'workflow', {
      status: 'answer',
      ref: 'threads/critic-report/request.md',
      at: new Date(Date.now() - 60_000),
    }));
  const tool = path.join(process.cwd(), 'tools', 'check-exchange.mjs');
  const run = spawnSync(process.execPath, [tool, '--root', host.root], {
    encoding: 'utf8',
    env: { ...process.env, DSH_PROJECT_GRAPH_STORE: store },
  });
  const out = String(run.stdout || '') + String(run.stderr || '');
  assert.match(out, /требуют хода: 0/u, 'отвеченная по Ref заявка не держится: ' + out.slice(0, 500));
  assert.match(out, /ошибка формата: 0/u, 'разрешённый Ref — не ошибка формата');
  assert.doesNotMatch(out, /требуют хода: [1-9]/u, 'счётчик не двоится');
});

/*
 * Задание 0153 (п.5): pending-письмо показывается непрочитанным С ПРИЧИНОЙ, а не
 * «непрочитано 0». Проверяется CLI tools/check-exchange.mjs на синтетическом ящике:
 * журнал решений говорит «ждёт вручения», и сканер обязан это назвать.
 */
await atest('0153: check-exchange показывает pending-письмо с причиной, а не 0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0153-scan-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0153-scan-store-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'shared' },
      exchange: { threads: ['critic-report'] },
      participants: ['structure', 'workflow'],
      orchestrator: 'coordinator',
    }],
  }, null, 2));
  const letterDir = path.join(root, 'coordination', 'threads', 'critic-report');
  fs.mkdirSync(letterDir, { recursive: true });
  const letter = path.join(letterDir, 'request.md');
  fs.writeFileSync(letter, HEAD('workflow', 'structure', new Date().toISOString()));
  /* Числовая отметка «доставлено» в том же хранилище, что читает сканер (0153). */
  fs.writeFileSync(path.join(store, 'exchange-seen.json'), JSON.stringify({ [letter]: 123 }), 'utf8');
  const journal = path.join(store, 'exchange-decisions.jsonl');
  fs.writeFileSync(journal, JSON.stringify({
    letter: 'threads/critic-report/request.md',
    branch: 'skip:delivery-off',
  }) + '\n', 'utf8');
  const tool = path.join(process.cwd(), 'tools', 'check-exchange.mjs');
  const run = spawnSync(process.execPath, [tool, '--root', root, '--journal', journal], {
    encoding: 'utf8',
    env: { ...process.env, DSH_PROJECT_GRAPH_STORE: store },
  });
  const out = String(run.stdout || '') + String(run.stderr || '');
  assert.equal(run.status, 1, 'есть непрочитанное — код 1: ' + out.slice(0, 300));
  assert.match(out, /непрочитано: 1/u, 'pending-письмо посчитано непрочитанным, а не 0');
  assert.match(out, /ждёт вручения: skip:delivery-off/u, 'причина названа в строке письма');
  assert.match(out, /ожидают вручения: 1/u, 'итог по ожиданию назван');
});

/*
 * Задание 0153 (D3): исторические ложные отметки seen снимаются отдельной функцией,
 * а dryRun ничего не пишет. Ложная отметка — seen без вручения: так два письма
 * ws-school-app исчезли из непрочитанных.
 */
await atest('0153: recoverFalseSeen снимает seen без вручения, dryRun файл не трогает', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0153-recover-'));
  const seenFile = path.join(dir, 'exchange-seen.json');
  const falseLetter = 'threads/critic-report/never-handed.md';
  const trueLetter = 'threads/critic-report/handed.md';
  const rows = { [falseLetter]: 1000, [trueLetter]: 2000 };
  fs.writeFileSync(seenFile, JSON.stringify(rows), 'utf8');
  const decisions = [
    { letter: falseLetter, branch: 'skip:delivery-off' },
    { letter: trueLetter, branch: 'delivered', session: 's-1', sha256: 'abc' },
  ];
  const dry = recoverFalseSeen({ seenPath: seenFile, decisions, dryRun: true });
  assert.deepEqual(dry.falseSeen, [falseLetter], 'ложная отметка найдена');
  assert.deepEqual(dry.kept, [trueLetter], 'вручённое оставлено');
  assert.equal(dry.applied, false, 'dry-run ничего не применяет');
  assert.equal(dry.reasons[falseLetter], 'skip:delivery-off', 'причина ожидания названа');
  assert.deepEqual(JSON.parse(fs.readFileSync(seenFile, 'utf8')), rows, 'dry-run не пишет файл');
  const applied = recoverFalseSeen({ seenPath: seenFile, decisions, dryRun: false });
  assert.equal(applied.applied, true, 'apply переписал файл');
  const after = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  assert.deepEqual(Object.keys(after), [trueLetter], 'осталась только отметка вручения');
  /* Полный путь в памяти и относительный путь в журнале — одно и то же письмо. */
  const full = path.join(dir, 'box', falseLetter);
  const bySuffix = recoverFalseSeen({
    seen: { [full]: 1 },
    decisions: [{ letter: falseLetter, branch: 'delivered' }],
    dryRun: true,
  });
  assert.deepEqual(bySuffix.falseSeen, [], 'полный путь опознан по относительному в журнале');
  assert.deepEqual(bySuffix.kept, [full], 'вручение найдено по суффиксу');
});

/*
 * Ложная отметка не только видна, но и безопасна: после снятия письмо снова
 * pending и доставляется при первой возможности (0153, D1+D3).
 */
await atest('0153: письмо, помеченное seen без вручения, снова pending и доставляется', async () => {
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  const seenFile = path.join(os.tmpdir(), 'pg-seen-false-' + Date.now() + '.json');
  const file = path.join(box.thread, 'false-seen.md');
  fs.writeFileSync(file, HEAD('structure', 'workflow', new Date().toISOString()));
  fs.writeFileSync(seenFile, JSON.stringify({ [file]: fs.statSync(file).mtimeMs }), 'utf8');
  const journalFile = decisionsPath(runtime);
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  fs.writeFileSync(journalFile, JSON.stringify({
    at: new Date().toISOString(),
    letter: 'threads/critic-report/false-seen.md',
    to: 'workflow',
    branch: 'skip:delivery-off',
  }) + '\n', 'utf8');
  const recovered = recoverFalseSeen({ seenPath: seenFile, decisionsPath: journalFile, dryRun: false });
  assert.deepEqual(recovered.falseSeen, [file], 'ложная отметка снята');
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: seenFile,
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const delivered = await watcher.tick();
  assert.equal(delivered.length, 1, 'после снятия отметки письмо доставлено');
  assert.equal(target.inbox.length, 1, 'вручено в сессию адресата');
});

/*
 * Лимит пачки (0153, D2): не больше пяти писем за тик, остаток остаётся pending
 * и уходит следующим проходом. Пока вручения нет, отметок seen нет ни у кого.
 */
await atest('0153: остаток сверх лимита пачки ждёт следующего прохода, а не теряется', async () => {
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const target = agent('s-workflow', box.workflow, 'workflow');
  const seenFile = path.join(os.tmpdir(), 'pg-seen-limit-' + Date.now() + '.json');
  let agents = [];
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: seenFile,
    config: { wakeSpawn: false },
    getAgents: () => ({ list: () => agents }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  const files = [];
  for (let index = 0; index < 7; index += 1) {
    const file = path.join(box.thread, 'pending-' + index + '.md');
    fs.writeFileSync(file, HEAD('structure', 'workflow', new Date().toISOString()));
    const stamp = new Date(Date.now() - 10000 + index * 10);
    fs.utimesSync(file, stamp, stamp);
    files.push(file);
  }
  await watcher.tick();
  for (const file of files) assert.equal(watcher.seen.has(file), false, 'без вручения отметки нет');
  agents = [target];
  const first = await watcher.tick(new Date(Date.now() + 5000));
  assert.equal(first.length, 5, 'за тик не больше пяти писем');
  assert.equal(target.inbox.length, 1, 'одно пробуждение на пачку');
  const second = await watcher.tick(new Date(Date.now() + 10000));
  assert.equal(second.length, 2, 'остаток уходит следующим проходом');
  assert.equal(target.inbox.length, 2, 'остаток доставлен отдельным пробуждением');
  for (const file of files) assert.equal(watcher.seen.has(file), true, 'все семь вручены и отмечены');
});

/*
 * Аудит (0153, D3): отдельная команда показывает ложные отметки, применяет снятие
 * и пишет журнал; письмо с ответом помечается закрытым, а не переотправляется.
 */
await atest('0153: CLI exchange-recover — dry-run показывает, apply снимает, ответ закрыт', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0153-cli-'));
  const seenFile = path.join(dir, 'exchange-seen.json');
  const journalFile = path.join(dir, 'exchange-decisions.jsonl');
  const letterDir = path.join(dir, 'box', 'threads', 'critic-report');
  fs.mkdirSync(letterDir, { recursive: true });
  const request = path.join(letterDir, 'request.md');
  const answer = path.join(letterDir, 'answer.md');
  fs.writeFileSync(request, HEAD('structure', 'workflow', new Date().toISOString()));
  fs.writeFileSync(answer, STATUS_HEAD('answer'));
  fs.writeFileSync(seenFile, JSON.stringify({ [request]: 1, [answer]: 2 }), 'utf8');
  fs.writeFileSync(journalFile, [
    JSON.stringify({ letter: 'threads/critic-report/request.md', branch: 'skip:delivery-off' }),
    JSON.stringify({ letter: 'threads/critic-report/answer.md', branch: 'skip:no-wake' }),
  ].join('\n') + '\n', 'utf8');
  const tool = path.join(process.cwd(), 'tools', 'exchange-recover.mjs');
  const dry = spawnSync(process.execPath, [tool, '--store', dir, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, 'dry-run вышел 0: ' + String(dry.stdout) + String(dry.stderr));
  assert.match(String(dry.stdout), /ложн/iu, 'печатает найденное');
  assert.match(String(dry.stdout), /request\.md/u, 'называет письмо');
  assert.match(String(dry.stdout), /закрыт/iu, 'ответ показан закрытым, а не к переотправке');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(seenFile, 'utf8'))).sort(),
    [answer, request].sort(), 'dry-run файл не изменил');
  assert.ok(!fs.existsSync(path.join(dir, 'exchange-recover.jsonl')), 'dry-run не пишет журнал аудита');
  const apply = spawnSync(process.execPath, [tool, '--store', dir, '--apply'], { encoding: 'utf8' });
  assert.equal(apply.status, 0, 'apply вышел 0: ' + String(apply.stdout) + String(apply.stderr));
  assert.ok(fs.existsSync(path.join(dir, 'exchange-recover.jsonl')), 'apply пишет журнал аудита');
  const after = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  assert.deepEqual(Object.keys(after).sort(), [], 'обе ложные отметки сняты');
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(String(failure.error && failure.error.stack ? failure.error.stack : failure.error));
  }
  console.error('EXCHANGE-WATCH TEST FAILED: ' + (passed + failures.length - passed) + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('EXCHANGE-WATCH TEST OK: ' + passed + '/' + passed);
