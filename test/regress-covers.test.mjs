import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'subagent-workflow', 'scripts');

async function loadPlan() {
  const mod = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'regress-scope.mjs')).href);
  assert.equal(typeof mod.planCriteria, 'function', 'regress-scope.mjs не экспортирует planCriteria');
  return mod.planCriteria;
}

function ids(list) {
  return (Array.isArray(list) ? list : []).map((item) => String(item && item.id !== undefined ? item.id : item));
}

test('0275: критерий исполняется, когда covers пересекает дифф', async () => {
  const planCriteria = await loadPlan();
  const criteria = [
    { id: 'A', covers: ['lib/a.js'] },
    { id: 'B', covers: ['lib/b.js'] },
  ];
  const plan = planCriteria(criteria, ['lib/a.js']);
  assert.equal(plan.mode, 'changed');
  assert.deepEqual(ids(plan.run), ['A']);
  assert.deepEqual(ids(plan.skipped), ['B']);
});

test('0275: критерий без covers исполняется всегда', async () => {
  const planCriteria = await loadPlan();
  const criteria = [
    { id: 'NOFIELD', command: 'node x.mjs' },
    { id: 'EMPTY', covers: [] },
    { id: 'FAR', covers: ['docs/other.md'] },
  ];
  const plan = planCriteria(criteria, ['lib/a.js']);
  assert.deepEqual(ids(plan.run), ['NOFIELD', 'EMPTY']);
  assert.deepEqual(ids(plan.skipped), ['FAR']);
});

test('0275: manual-критерий исполняется вне своего covers', async () => {
  const planCriteria = await loadPlan();
  const criteria = [
    { id: 'FLAG', manual: true, covers: ['docs/manual.md'] },
    { id: 'TAG', tags: ['fast', 'manual'], covers: ['docs/manual.md'] },
    { id: 'PLAIN', tags: ['fast'], covers: ['docs/manual.md'] },
  ];
  const plan = planCriteria(criteria, ['lib/a.js']);
  assert.deepEqual(ids(plan.run), ['FLAG', 'TAG']);
  assert.deepEqual(ids(plan.skipped), ['PLAIN']);
});

test('0275: dir/** ловит вложенный путь, lib/*.js — только верхний уровень', async () => {
  const planCriteria = await loadPlan();
  const criteria = [
    { id: 'DEEP', covers: ['lib/**'] },
    { id: 'SHALLOW', covers: ['lib/*.js'] },
  ];
  const top = planCriteria(criteria, ['lib/a.js']);
  assert.deepEqual(ids(top.run), ['DEEP', 'SHALLOW']);

  const nested = planCriteria(criteria, ['lib/deep/x/a.js']);
  assert.deepEqual(ids(nested.run), ['DEEP']);
  assert.deepEqual(ids(nested.skipped), ['SHALLOW']);
});

test('0275: пустой дифф — режим all, все критерии, пропусков нет', async () => {
  const planCriteria = await loadPlan();
  const criteria = [
    { id: 'A', covers: ['lib/a.js'] },
    { id: 'B' },
  ];
  for (const changed of [[], undefined, null, 'lib/a.js']) {
    const plan = planCriteria(criteria, changed);
    assert.equal(plan.mode, 'all', 'режим для ' + JSON.stringify(changed));
    assert.deepEqual(ids(plan.run), ['A', 'B']);
    assert.deepEqual(ids(plan.skipped), []);
  }
});

test('0275: у пропущенного критерия названа непустая причина', async () => {
  const planCriteria = await loadPlan();
  const plan = planCriteria([{ id: 'X', covers: ['docs/readme.md'] }], ['lib/a.js']);
  assert.equal(plan.skipped.length, 1);
  assert.equal(String(plan.skipped[0].id), 'X');
  assert.equal(typeof plan.skipped[0].reason, 'string');
  assert.ok(plan.skipped[0].reason.trim() !== '', 'причина пропуска пустая');
  assert.match(plan.skipped[0].reason, /covers/u);
  assert.deepEqual(ids(plan.run), []);
});
