/**
 * The parent of a host-started run is chosen by workspace, not by "anyone alive".
 *
 * A borrowed parent gives the child a session of a foreign workspace: the run record
 * says one root, the child reads another folder, and the activation dies without a
 * report (the nightly critic in ws-school-app). These tests pin the rule: own cwd
 * inside the root (nested folder, case, trailing slash), a foreign agent never
 * becomes the parent even when it is the only one, and the reason names the
 * workspace so the run journal is actionable.
 *
 * The cwd of a live agent may live only in its session or session journal (0083), so
 * the cascade and one integration pick are pinned here too. Every journal is written
 * to a temporary folder: nothing here touches the real ~/.dsh.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createGraphRuntime } from '../lib/api.js';
import { createScheduler } from '../lib/scheduler.js';
import { listRuns } from '../lib/runs.js';
import { pickParent, isInsideRoot, resolveAgentCwd } from '../lib/parent.js';

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

const ROOT = 'C:\\Work\\Project';
const OTHER = 'C:\\Work\\Elsewhere';

/** A sessions folder that does not exist: any read of it is "no journal". */
function noSessions() {
  return path.join(os.tmpdir(), 'dsh-parent-no-sessions-' + process.pid + '-' + Math.random().toString(36).slice(2));
}

/**
 * Write one session journal the way DSH does: a zstd frame with the header first
 * and the working-directory switch a few bytes later. Only temporary folders.
 */
function writeSessionJournal(sessionsDir, sessionId, headerCwd, switchCwd) {
  const key = '--' + String(headerCwd).replace(/[:\\/]/gu, '-') + '--';
  const dir = path.join(sessionsDir, key, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'session', version: 4, id: sessionId, cwd: headerCwd })];
  if (switchCwd) lines.push(JSON.stringify({ type: 'working-directory/change', data: { cwd: switchCwd } }));
  const journal = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(journal, 'utf8')));
}

test('свой корень: агент своего корня выбран родителем', () => {
  const mine = { id: 'mine', cwd: ROOT };
  const result = pickParent({ agents: [{ id: 'foreign', cwd: OTHER }, mine], root: ROOT });
  assert.equal(result.parent, mine);
  assert.match(result.reason, /агент/u);
});

test('чужой агент не подставляется, причина называет воркспейс', () => {
  const result = pickParent({ agents: [{ id: 'foreign', cwd: OTHER }], root: ROOT });
  assert.equal(result.parent, null);
  assert.ok(result.reason.includes(ROOT), 'причина должна называть целевой воркспейс: ' + result.reason);
  assert.match(result.reason, /пропуск не догоняется/u);
});

test('агентов нет — родителя нет, причина говорит об отсутствии агентов', () => {
  const result = pickParent({ agents: [], root: ROOT });
  assert.equal(result.parent, null);
  assert.match(result.reason, /агент/iu);
  assert.doesNotMatch(result.reason, /Cannot|undefined/u);
});

test('подкаталог корня считается своим', () => {
  const nested = { id: 'nested', cwd: ROOT + '\\sub\\deep' };
  assert.equal(pickParent({ agents: [nested], root: ROOT }).parent, nested);
  assert.equal(pickParent({ agents: [nested], root: ROOT + '\\' }).parent, nested);
});

test('регистр пути не важен, хвостовой слэш нормализуется', () => {
  const nested = { id: 'nested', cwd: ROOT.toLowerCase() + '/sub/' };
  assert.equal(pickParent({ agents: [nested], root: ROOT.toUpperCase() + '\\' }).parent, nested);
  assert.equal(pickParent({ agents: [nested], root: ROOT }).parent, nested);
});

test('сосед с общим префиксом не считается своим', () => {
  const sibling = { id: 'sibling', cwd: ROOT + 'Other' };
  const result = pickParent({ agents: [sibling], root: ROOT });
  assert.equal(result.parent, null);
});

test('агент без cwd не свой, причина говорит про неизвестный cwd', () => {
  const result = pickParent({ agents: [{ id: 'nowhere' }, { id: 'null-cwd', cwd: null }], root: ROOT });
  assert.equal(result.parent, null);
  assert.match(result.reason, /воркспейсе/u);
  assert.match(result.reason, /cwd/u, 'причина называет неизвестный cwd: ' + result.reason);
});

test('resolveAgentCwd: прямой cwd агента — первый источник', () => {
  const sessions = noSessions();
  assert.equal(resolveAgentCwd({ id: 'direct', cwd: ROOT, session: { meta: { cwd: OTHER } } }, { sessionsDir: sessions }), ROOT);
  assert.equal(resolveAgentCwd({ id: 'nested', cwd: ROOT + '\\sub\\deep' }, { sessionsDir: sessions }), ROOT + '\\sub\\deep');
  assert.equal(resolveAgentCwd({ id: 'blank', cwd: '   ', session: { meta: { cwd: OTHER } } }, { sessionsDir: sessions }), OTHER);
});

test('resolveAgentCwd: cwd из session.meta, когда на агенте его нет', () => {
  const sessions = noSessions();
  assert.equal(resolveAgentCwd({ id: 'meta', session: { meta: { cwd: ROOT } } }, { sessionsDir: sessions }), ROOT);
  assert.equal(resolveAgentCwd({ id: 'meta-nested', session: { meta: { cwd: ROOT + '\\sub' } } }, { sessionsDir: sessions }), ROOT + '\\sub');
});

test('resolveAgentCwd: cwd из session.cwd после session.meta', () => {
  assert.equal(resolveAgentCwd({ id: 'session', session: { cwd: ROOT } }, { sessionsDir: noSessions() }), ROOT);
  assert.equal(resolveAgentCwd({ id: 'prefer-meta', session: { meta: { cwd: ROOT }, cwd: OTHER } }, { sessionsDir: noSessions() }), ROOT);
});

test('resolveAgentCwd: агент без cwd и без сессии — null, без исключения', () => {
  const sessions = noSessions();
  assert.equal(resolveAgentCwd({ id: 'nowhere' }, { sessionsDir: sessions }), null);
  assert.equal(resolveAgentCwd({ id: 'null-cwd', cwd: null, session: {} }, { sessionsDir: sessions }), null);
  assert.equal(resolveAgentCwd({ id: 'unknown-session', session: { id: 'session-unknown' } }, { sessionsDir: sessions }), null);
  assert.equal(resolveAgentCwd(null, { sessionsDir: sessions }), null);
});

test('resolveAgentCwd: cwd из журнала сессии по id (zstd, временный каталог)', () => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-journal-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-target-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-other-'));
  /* The journal decides: the first working-directory/change is the real folder. */
  writeSessionJournal(sessions, 'session-journal', other, target);
  assert.equal(resolveAgentCwd({ id: 'journal', session: { id: 'session-journal' } }, { sessionsDir: sessions }), path.resolve(target));
  /* The session header is the fallback when no switch was written. */
  writeSessionJournal(sessions, 'session-header', other);
  assert.equal(resolveAgentCwd({ id: 'header', session: { id: 'session-header' } }, { sessionsDir: sessions }), path.resolve(other));
});

test('resolveAgentCwd: журнал не перебивает cwd агента и сессии', () => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-precedence-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-target-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-other-'));
  writeSessionJournal(sessions, 'session-precedence', other);
  assert.equal(resolveAgentCwd({ id: 'direct', cwd: target, session: { id: 'session-precedence' } }, { sessionsDir: sessions }), path.resolve(target));
  assert.equal(resolveAgentCwd({ id: 'meta', session: { id: 'session-precedence', meta: { cwd: target } } }, { sessionsDir: sessions }), path.resolve(target));
});

test('pickParent: агент своего корня найден, когда cwd есть только в сессии', () => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-pick-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-root-'));
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-foreign-'));
  writeSessionJournal(sessions, 'session-own', foreign, root);
  const own = { id: 'own', session: { id: 'session-own' } };
  const picked = pickParent({ agents: [{ id: 'foreign', cwd: foreign }, own], root, sessionsDir: sessions });
  assert.equal(picked.parent, own);
  assert.ok(picked.reason.includes(root), 'причина называет корень: ' + picked.reason);
  assert.equal(own.cwd, path.resolve(root), 'найденный агент назван воркспейсом своей сессии');
});

test('приоритет — первый свой агент из списка', () => {
  const first = { id: 'first', cwd: ROOT };
  const second = { id: 'second', cwd: ROOT + '\\two' };
  const result = pickParent({ agents: [{ id: 'foreign', cwd: OTHER }, first, second], root: ROOT });
  assert.equal(result.parent, first);
});

test('пустой корень не выбирает агента и объясняет причину', () => {
  const result = pickParent({ agents: [{ id: 'mine', cwd: ROOT }], root: '  ' });
  assert.equal(result.parent, null);
  assert.match(result.reason, /воркспейс/u);
});

test('isInsideRoot экспортируется из lib/parent.js и совпадает с правилом live', () => {
  assert.equal(isInsideRoot(ROOT + '\\sub', ROOT), true);
  assert.equal(isInsideRoot(ROOT.toUpperCase(), ROOT), true);
  assert.equal(isInsideRoot(ROOT + 'Other', ROOT), false);
  assert.equal(isInsideRoot(null, ROOT), false);
  assert.equal(isInsideRoot(ROOT, ''), false);
});

/**
 * The scheduler must write the pickParent reason (which names the workspace), not the
 * old general "no parent agent" line. A foreign agent is not even supplied here: the
 * production host passes chooseParent().parent, which is null when the workspace has
 * no live agent.
 */
await test('планировщик пишет причину pickParent в журнал запуска', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-schedule-'));
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parent-runs-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [
      { id: 'coordinator', role: 'координатор', model: 'work' },
      { id: 'critic', role: 'критик', model: 'work', schedule: { at: '09:00', timeZone: 'Europe/Moscow' } },
    ],
    edges: [{ from: 'critic', to: 'coordinator', kind: 'report' }],
  }, null, 2));
  const runtime = createGraphRuntime({ roots: [dir], runsDir });
  /* A live agent exists, but in another workspace: that is the nightly-critic case. */
  const foreign = { id: 'foreign', cwd: path.dirname(dir) };
  const pick = pickParent({ agents: [foreign], root: dir });
  assert.equal(pick.parent, null);
  assert.ok(pick.reason.includes(dir), 'причина называет воркспейс: ' + pick.reason);
  const calls = [];
  const subagents = {
    getProvider: (name) => ({ name, capabilities: { agentOptions: true } }),
    resolveMaxDepth: (value) => (value === undefined ? 1 : value),
    async startActivation(spec) { calls.push(spec); throw new Error('запуск без родителя недопустим'); },
  };
  const scheduler = createScheduler({
    runtime,
    getSubagents: () => subagents,
    getParent: () => pick.parent,
    getParentReason: () => pick.reason,
  });
  await scheduler.tick(new Date('2026-10-29T08:00:00+03:00'));
  await scheduler.tick(new Date('2026-10-29T09:00:10+03:00'));
  assert.equal(calls.length, 0, 'без родителя запуск не делается');
  const run = listRuns(runtime, dir)[0];
  assert.equal(run.state, 'error');
  assert.ok(run.message.includes(pick.reason), 'журнал должен нести причину pickParent: ' + run.message);
  assert.ok(run.message.includes(dir), 'причина называет воркспейс');
});

for (const failure of failures) {
  console.error('FAIL ' + failure.name + ': ' + (failure.error && failure.error.message));
}
if (failures.length > 0) {
  console.error('PARENT TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('PARENT TEST OK: ' + passed + '/' + passed);
