import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

test('0215: лимит ветки сдерживает, но ответ на вопрос проходит', async () => {
  const { createWakeThrottle } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  const throttle = createWakeThrottle({ branchMs: 15 * 60 * 1000, boxWindowMs: 60 * 60 * 1000, boxLimit: 5, now: () => 1000 });
  const box = 'C:/box';
  const first = throttle.allow(box, 'threads/exchange', 1000);
  assert.equal(first.allowed, true, 'первое пробуждение разрешено');
  throttle.mark(box, 'threads/exchange', 1000);
  const blocked = throttle.allow(box, 'threads/exchange', 2000);
  assert.equal(blocked.allowed, false, 'второе — в лимите ветки');
  assert.equal(blocked.limit, 'branch');
  const answer = throttle.allow(box, 'threads/exchange', 2000, { skipBranch: true });
  assert.equal(answer.allowed, true, 'ответ на вопрос не ждёт лимита ветки');
});