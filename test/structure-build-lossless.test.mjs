import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

test('buildGraphDocument сохраняет prompt/x/y/anchors/schedule и не тащит мусор', async () => {
  const { buildGraphDocument } = await import(pathToFileURL(path.join(LIB, 'api.js')).href);
  const draft = {
    nodes: [
      {
        id: 'coordinator',
        role: 'координатор',
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        brief: 'ведёт план',
        prompt: 'Роль: координатор. Definition of Done: план записан.',
        x: 210,
        y: 130,
        anchors: { consumes: ['A1'] },
        schedule: { at: '09:00', timeZone: 'Europe/Moscow' },
        garbage: 'этого поля в графе нет',
      },
    ],
    edges: [{ from: 'coordinator', to: 'worker', kind: 'delegate' }],
  };
  const doc = buildGraphDocument(draft);
  const node = doc.nodes[0];
  assert.equal(node.prompt, draft.nodes[0].prompt, 'prompt сохранён');
  assert.equal(node.x, 210, 'x сохранён');
  assert.equal(node.y, 130, 'y сохранён');
  assert.deepEqual(node.anchors, { consumes: ['A1'] }, 'anchors сохранены');
  assert.deepEqual(node.schedule, { at: '09:00', timeZone: 'Europe/Moscow' }, 'schedule сохранён');
  assert.equal(node.garbage, undefined, 'неизвестное поле не протащено');
  assert.equal(doc.edges.length, 1, 'ребро сохранено');
});