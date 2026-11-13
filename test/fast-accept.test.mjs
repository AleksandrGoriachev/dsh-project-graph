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