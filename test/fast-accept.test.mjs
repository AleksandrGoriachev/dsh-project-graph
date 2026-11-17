import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'subagent-workflow', 'scripts');

test('0256: fast-accept классифицирует таймауты как deferred', async () => {
  const { classifyFastRegress } = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'fast-accept.mjs')).href);
  const timeoutOnly = { tasks: [{ task: '0030', status: 'regressed', failedIds: ['C2'], timedOutIds: ['C2'] }] };
  assert.equal(classifyFastRegress(timeoutOnly).ok, true);
  assert.equal(classifyFastRegress(timeoutOnly).deferred[0].task, '0030');

  const real = { tasks: [{ task: '0014', status: 'regressed', failedIds: ['C2'], timedOutIds: [] }] };
  assert.equal(classifyFastRegress(real).ok, false);
  assert.equal(classifyFastRegress(real).hard[0].task, '0014');

  const mixed = { tasks: [{ task: 'x', status: 'regressed', failedIds: ['C1', 'C2'], timedOutIds: ['C2'] }] };
  assert.equal(classifyFastRegress(mixed).ok, false);
  assert.deepEqual(classifyFastRegress(mixed).hard[0].criteria, ['C1']);

  const untrusted = { tasks: [{ task: 'x', status: 'untrusted', failedIds: [] }] };
  assert.equal(classifyFastRegress(untrusted).ok, false);

  const green = { tasks: [{ task: 'a', status: 'ok', failedIds: [] }, { task: 'b', status: 'allowed', failedIds: ['C2'] }] };
  assert.equal(classifyFastRegress(green).ok, true);
  assert.equal(classifyFastRegress(green).deferred.length, 0);
});

test('0271: fast: задетый файл не откладывается', async () => {
  const { classifyFastRegress } = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'fast-accept.mjs')).href);
  const report = { tasks: [{ task: '9001', status: 'regressed', failedIds: ['C1'], timedOutIds: ['C1'] }] };
  const coversOf = (taskId, criterionId) => (String(taskId) === '9001' && String(criterionId) === 'C1' ? ['lib/api.js'] : null);

  /* cover пересекается с диффом — таймаут не маскирует регресс, это hard. */
  const hit = classifyFastRegress(report, { changedPaths: ['lib/api.js'], coversOf });
  assert.equal(hit.ok, false);
  assert.equal(hit.hard.length, 1);
  assert.equal(hit.hard[0].task, '9001');
  assert.match(hit.hard[0].reason || '', /задет/u);
  assert.match(JSON.stringify(hit.hard), /задет/u);
  assert.equal(hit.deferred.length, 0);

  /* чужие файлы в диффе — прежнее откладывание сохраняется. */
  const miss = classifyFastRegress(report, { changedPaths: ['docs/readme.md'], coversOf });
  assert.equal(miss.ok, true);
  assert.equal(miss.deferred.length, 1);
  assert.equal(miss.deferred[0].task, '9001');

  /* без options — поведение 0256: любой таймаут отложен. */
  const legacy = classifyFastRegress(report);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.deferred[0].task, '9001');

  /* cover-префикс: 'lib/*' задевает lib/api.js, '**' отбрасывается. */
  const prefixHit = classifyFastRegress(report, { changedPaths: ['lib/api.js'], coversOf: () => ['lib/*'] });
  assert.equal(prefixHit.ok, false);
  const star = classifyFastRegress(report, { changedPaths: ['lib/api.js'], coversOf: () => ['**'] });
  assert.equal(star.ok, true);
});
