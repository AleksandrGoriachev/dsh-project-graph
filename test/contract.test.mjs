import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bareName, parseTaskMeta, expectedAcceptor, validateContract, taskFiles } from '../lib/contract.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

const GRAPH = {
  nodes: [{ id: 'coordinator' }, { id: 'worker' }, { id: 'judge' }, { id: 'designer' }],
  edges: [
    { from: 'coordinator', to: 'worker', kind: 'delegate' },
    { from: 'worker', to: 'judge', kind: 'review' },
    { from: 'coordinator', to: 'designer', kind: 'delegate' },
    { from: 'designer', to: 'coordinator', kind: 'report' },
  ],
};

const meta = (executor, acceptor) => ({ 'executor': executor, 'acceptor': acceptor });

test('проверяющий выигрывает у владельца: у воркера приёмщик — judge', () => {
  assert.deepEqual(expectedAcceptor(GRAPH, 'worker'), { ok: true, acceptor: 'judge', kind: 'review' });
});

test('без проверяющего приёмщик — владелец, которому возвращается результат', () => {
  assert.deepEqual(expectedAcceptor(GRAPH, 'designer'), { ok: true, acceptor: 'coordinator', kind: 'report' });
});

test('узел без пути приёмки — ошибка структуры, а не свободный выбор', () => {
  const result = expectedAcceptor(GRAPH, 'coordinator');
  assert.equal(result.ok, false);
  assert.match(result.message, /нет ни проверяющего/);
});

test('контракт, противоречащий структуре, не проходит', () => {
  const problems = validateContract(GRAPH, meta('subagent:designer', 'subagent:judge'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /acceptor=judge, структура — coordinator/);
});

test('согласованный контракт проходит', () => {
  assert.deepEqual(validateContract(GRAPH, meta('subagent:designer', 'subagent:coordinator')), []);
  assert.deepEqual(validateContract(GRAPH, meta('subagent:worker', 'subagent:judge')), []);
});

test('TASK-META разбирается, префикс subagent снимается', () => {
  const text = 'x\n<!-- TASK-META\n' + JSON.stringify(meta('subagent:worker', 'subagent:judge')) + '\n-->\n';
  assert.equal(parseTaskMeta(text).executor, 'subagent:worker');
  assert.equal(bareName('subagent:judge'), 'judge');
});

test('задание на диске проверяется целиком', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-contract-'));
  fs.mkdirSync(path.join(root, 'docs', 'tasks', '0001'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'tasks', '0001', 'task.md'),
    '<!-- TASK-META\n' + JSON.stringify(meta('subagent:designer', 'subagent:judge')) + '\n-->\n');
  assert.equal(taskFiles(root).length, 1);
  assert.equal(validateContract(GRAPH, parseTaskMeta(fs.readFileSync(taskFiles(root)[0], 'utf8'))).length, 1);
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('CONTRACT TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
