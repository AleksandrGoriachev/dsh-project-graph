import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

test('0217: ответ на письмо адресата будит, ответ на чужое — нет', async () => {
  const { isWakeAnswer } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  assert.equal(isWakeAnswer({ replyToAuthor: 'structure', replyToStatus: 'answer' }, 'structure'), true, 'ответ на письмо адресата');
  assert.equal(isWakeAnswer({ replyToAuthor: 'Workflow', replyToStatus: 'answer' }, 'workflow'), true, 'регистр не важен');
  assert.equal(isWakeAnswer({ replyToAuthor: 'workflow', replyToStatus: 'answer' }, 'structure'), false, 'ответ на чужое не будит');
  assert.equal(isWakeAnswer(null, 'structure'), false, 'нет ссылки — нет пробуждения');
});