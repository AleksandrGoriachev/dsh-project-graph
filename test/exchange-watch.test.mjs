import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addresseeLabels, createExchangeWatcher, declaredExchangeBoxes, declaredExchangeWorkspaces, decisionsPath,
  labelRoots, messageFiles, nextLetterNumber, normalizeSession, parseMessage, pickLastActive,
  readExchangeFolders, seenPath, shouldWake,
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

/** A live agent handle that records what it was told. */
function agent(id, cwd, label) {
  const inbox = [];
  return {
    id, sessionId: id, cwd, label,
    sendMessage: async (input) => { inbox.push(input.text); },
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

await atest('старая почта при старте не поднимает никого, свежая — поднимает', async () => {
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
  await watcher.tick();
  assert.equal(target.inbox.length, 1, 'поднят ровно один раз — по свежему письму');
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

await atest('письмо для спящей стороны ложится в ящик и не доставляется повторно', async () => {
  /*
   * Двойник не поднимается (--56): пока адресата нет среди живых, письмо лежит в ящике,
   * и его прочитает собственный агент стороны. Повторной доставки быть не должно.
   */
  const box = host();
  const target = agent('s-workflow', box.workflow, 'workflow');
  const runtime = runtimeOf([box.structure, box.workflow]);
  let agents = [];
  const watcher = createExchangeWatcher({
    runtime,
    getAgents: () => ({ list: () => agents }),
    activityOf: () => new Map([['s-workflow', 1793528000000]]),
    backlogMs: 60 * 60 * 1000,
  });
  fs.writeFileSync(path.join(box.thread, 'retry.md'), HEAD('structure', 'workflow', '2026-11-01T13:31+03:00'));
  const first = new Date();
  await watcher.tick(first);
  const run = [...runtime.runs.values()][0];
  assert.equal(run.state, 'done', 'письмо доставлено в ящик');
  assert.equal(run.wake.reason, 'box-only');
  assert.equal(target.inbox.length, 0, 'двойник не поднят');
  agents = [target];
  await watcher.tick(new Date(first.getTime() + 121000));
  assert.equal(target.inbox.length, 0, 'повторной доставки нет: письмо уже в ящике');
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

await atest('догон не вытаскивает историю: старое письмо остаётся в ящике', async () => {
  /*
   * 2026-11-02: первый проход после перезапуска доставил 49 писем, включая заметки
   * четырёхдневной давности. Догон — про пропущенное за время сна, а не про архив.
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
  await watcher.tick();
  assert.equal(target.inbox.length, 0, 'четырёхдневное письмо не будит: это история');
});

await atest('первый проход после перезапуска догоняет пропущенное, второй — уже нет', async () => {
  /*
   * Заказчик, 2026-11-02: после перезагрузки координатор должен увидеть входящие, пришедшие
   * пока хост спал. Окно догона на первом проходе не действует, но только если память
   * доставленного уже есть (иначе первый запуск залил бы ящик историей).
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

await atest('по умолчанию двойник не поднимается: письмо ждёт своего агента', async () => {
  /*
   * Живой факт 2026-11-01: настоящая сессия workflow писала --52/--54/--56 без шапки Session, а все
   * письма с Session = child id порождал наш спавн. Пока сторона работает, поднимать кого-то нельзя.
   */
  const box = host();
  const runtime = runtimeOf([box.structure, box.workflow]);
  const captured = [];
  const now = Date.now();
  const watcher = createExchangeWatcher({
    runtime,
    /* Конфиг по умолчанию: спавн выключен — двойников быть не должно. */
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

await atest('письмо вне окна догона: решение stale:backlog с возрастом и окном', async () => {
  const box = folderHost();
  const runtime = runtimeOf([box.structure, box.workflow], {
    participants: { structure: box.structure, workflow: box.workflow },
  });
  const windowMs = 30 * 60 * 1000;
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-stale-seen-' + Date.now() + '.json'),
    backlogMs: windowMs,
    getAgents: () => ({ list: () => [] }),
    getSessionController: () => ({ prompt: async () => ({ accepted: true }) }),
    activityOf: () => new Map(),
  });
  const file = path.join(box.thread, 'old.md');
  fs.writeFileSync(file, HEAD('workflow', 'structure', new Date().toISOString()));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  await watcher.tick();
  const stale = decisionsOf(runtime).filter((row) => row.branch === 'stale:backlog');
  assert.equal(stale.length, 1, 'вне окна — не тишина, а решение');
  assert.equal(stale[0].windowMs, windowMs, 'окно названо в решении');
  assert.ok(Number(stale[0].ageMs) > Number(stale[0].windowMs), 'возраст больше окна');
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
if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(String(failure.error && failure.error.stack ? failure.error.stack : failure.error));
  }
  console.error('EXCHANGE-WATCH TEST FAILED: ' + (passed + failures.length - passed) + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('EXCHANGE-WATCH TEST OK: ' + passed + '/' + passed);
