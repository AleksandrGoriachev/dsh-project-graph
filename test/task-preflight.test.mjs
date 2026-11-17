import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'docs', 'subagent-workflow', 'scripts');
const preflight = await import(pathToFileURL(path.join(SCRIPTS, 'task-preflight.mjs')).href);
const guard = await import(pathToFileURL(path.join(SCRIPTS, 'task-guard.mjs')).href);

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  fs.mkdirSync(path.join(root, 'docs', 'tasks', '9001'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'tasks', '9001', 'task.md'), '<!-- TASK-META\n{"id":"9001","allowedPaths":["lib/api.js"]}\n-->\n# 9001\n');
  fs.writeFileSync(path.join(root, 'docs', 'tasks', '9001', 'criteria.json'), JSON.stringify({ task: '9001', redExpect: { mustFail: ['C1'], mustPass: [], reasons: { C1: 'нет модуля' } }, criteria: [{ id: 'C1' }] }));
  return root;
}

test('0266: хеш контракта не зависит от порядка файлов', () => {
  const left = preflight.contractHash([{ rel: 'task.md', text: 'a' }, { rel: 'criteria.json', text: 'b' }]);
  const right = preflight.contractHash([{ rel: 'criteria.json', text: 'b' }, { rel: 'task.md', text: 'a' }]);
  assert.equal(left, right);
  assert.notEqual(left, preflight.contractHash([{ rel: 'task.md', text: 'a' }, { rel: 'criteria.json', text: 'c' }]));
});

test('0266: mustFail требует объявленную причину', () => {
  const criteria = [{ id: 'C1' }, { id: 'C2' }];
  const redExpect = { mustFail: ['C1', 'C2'], mustPass: [], reasons: { C1: 'нет модуля', C2: 'нет ключа' } };
  const good = { C1: { exitCode: 1, output: 'FAIL c1: нет модуля' }, C2: { exitCode: 1, output: 'FAIL c2: нет ключа' } };
  assert.deepEqual(preflight.checkResults(criteria, good, redExpect), []);
  const wrongReason = { C1: { exitCode: 1, output: 'иное' }, C2: { exitCode: 1, output: 'нет ключа' } };
  assert.equal(preflight.checkResults(criteria, wrongReason, redExpect).length, 1);
  const passed = { C1: { exitCode: 0, output: '' }, C2: { exitCode: 1, output: 'нет ключа' } };
  assert.match(preflight.checkResults(criteria, passed, redExpect)[0], /должен падать/u);
  const missing = { C1: { exitCode: 1, output: 'нет модуля' } };
  assert.match(preflight.checkResults(criteria, missing, redExpect)[0], /не запускался/u);
});

test('0266: mustPass не должен падать', () => {
  const problems = preflight.checkResults([{ id: 'C3' }], { C3: { exitCode: 1, output: 'boom' } }, { mustFail: [], mustPass: ['C3'] });
  assert.match(problems[0], /должен проходить/u);
});

test('0266: сторож требует свежий preflight для контракта', () => {
  const root = tempRepo();
  const contract = ['docs/tasks/9001/task.md', 'docs/tasks/9001/criteria.json'];
  assert.equal(guard.preflightViolation(root, contract).length, 1);
  const record = { version: 1, task: '9001', contractSha: preflight.contractHashOf(root, '9001'), ok: true, problems: [] };
  fs.writeFileSync(path.join(root, 'docs', 'tasks', '9001', 'preflight.json'), JSON.stringify(record));
  assert.deepEqual(guard.preflightViolation(root, contract), []);
  fs.writeFileSync(path.join(root, 'docs', 'tasks', '9001', 'task.md'), '<!-- TASK-META\n{"id":"9001","allowedPaths":["lib/other.js"]}\n-->\n');
  assert.match(guard.preflightViolation(root, contract)[0], /устарел/u);
});

test('0266: метка обхода не прикрывает контракт, но прикрывает реестр', () => {
  const risky = guard.contractBypassPaths(['docs/tasks/9001/task.md', 'docs/tasks/9001/criteria.json', 'lib/api.js', 'docs/tasks/REGISTRY.json']);
  assert.deepEqual(risky, ['docs/tasks/9001/task.md', 'docs/tasks/9001/criteria.json']);
  assert.deepEqual(guard.contractBypassPaths(['docs/tasks/REGISTRY.json', 'package.json']), []);
});