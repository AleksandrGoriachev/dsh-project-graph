import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'anchors-editor.js');

const doc = { version: 2, anchors: [
  { id: 'A1', claim: 'c1', check: 'x', status: 'auto', layer: 'project', sides: 'project', enforcedBy: 'nodes', appliesToKinds: ['reviewer', 'judge'] },
  { id: 'A2', claim: 'c2', check: 'x', status: 'auto', layer: 'project', sides: 'project', enforcedBy: 'nodes' },
] };

test('0261: тип узла выводится из kind, id или роли', async () => {
  const { kindOfNode } = await import(pathToFileURL(LIB).href);
  assert.equal(kindOfNode({ id: 'x', kind: 'reviewer' }), 'reviewer');
  assert.equal(kindOfNode({ id: 'judge' }), 'judge');
  assert.equal(kindOfNode({ id: 'reviewer-1', role: 'ревьюер' }), 'reviewer');
  assert.equal(kindOfNode({ id: 'worker-2', role: 'советник' }), 'adviser');
  assert.equal(kindOfNode({ id: 'nx', role: 'непонятно' }), '');
  assert.equal(kindOfNode(null), '');
});

test('0261: узел наследует якоря своего типа', async () => {
  const { effectiveConsumes } = await import(pathToFileURL(LIB).href);
  assert.deepEqual(effectiveConsumes({ id: 'reviewer-1', role: 'ревьюер' }, doc), ['A1']);
  assert.deepEqual(effectiveConsumes({ id: 'judge', role: 'приёмщик' }, doc), ['A1']);
  assert.deepEqual(effectiveConsumes({ id: 'worker-1', role: 'исполнитель' }, doc), []);
  assert.deepEqual(
    effectiveConsumes({ id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: ['A2', 'A1'] } }, doc),
    ['A2', 'A1'],
  );
  assert.deepEqual(effectiveConsumes({ id: 'critic', role: 'критик' }, { version: 2, anchors: [] }), []);
});

test('0261: appliesToKinds проверяется схемой', async () => {
  const { validateAnchorsDoc } = await import(pathToFileURL(LIB).href);
  assert.equal(validateAnchorsDoc(doc).ok, true);
  const empty = JSON.parse(JSON.stringify(doc));
  empty.anchors[0].appliesToKinds = [];
  assert.equal(validateAnchorsDoc(empty).ok, false);
  const unknown = JSON.parse(JSON.stringify(doc));
  unknown.anchors[0].appliesToKinds = ['оркестратор'];
  const verdict = validateAnchorsDoc(unknown);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.includes('appliesToKinds')));
});