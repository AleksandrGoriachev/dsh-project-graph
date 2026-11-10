import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { declaredReviewer, bareName, parseTaskMeta, expectedAcceptor, validateContract, taskFiles } from '../lib/contract.js';

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

/*
 * Задание 0168: ревьюер в TASK-META обязывает к review.json. parseTaskMeta
 * обязан вернуть оба поля, а declaredReviewer — свести их к одному id узла:
 * reviewerNode главнее, префикс subagent: снимается.
 */
test('0168: TASK-META читает reviewer и reviewerNode, поля нормализованы', () => {
  const text = '<!-- TASK-META\n' + JSON.stringify({
    executor: 'subagent:worker',
    acceptor: 'subagent:judge',
    reviewer: ' subagent:reviewer-1 ',
    reviewerNode: ' reviewer-1 ',
  }) + '\n-->\n';
  const parsed = parseTaskMeta(text);
  assert.equal(parsed.reviewer, 'subagent:reviewer-1');
  assert.equal(parsed.reviewerNode, 'reviewer-1');
  assert.deepEqual(declaredReviewer(parsed), { reviewer: 'subagent:reviewer-1', node: 'reviewer-1' });
});

test('0168: declaredReviewer берёт id узла: reviewerNode главнее, subagent: снимается', () => {
  assert.deepEqual(declaredReviewer({ reviewer: 'subagent:reviewer-1' }),
    { reviewer: 'subagent:reviewer-1', node: 'reviewer-1' });
  assert.deepEqual(declaredReviewer({ reviewer: 'subagent:reviewer-1', reviewerNode: 'reviewer-2' }),
    { reviewer: 'subagent:reviewer-1', node: 'reviewer-2' });
});

test('0168: без reviewer в контракте ревью-гейта нет', () => {
  assert.equal(declaredReviewer(parseTaskMeta('<!-- TASK-META\n{"executor":"subagent:worker"}\n-->\n')), null);
  assert.equal(declaredReviewer(null), null);
  assert.equal(declaredReviewer({ reviewer: '   ' }), null);
});

test('задание на диске проверяется целиком', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-contract-'));
  fs.mkdirSync(path.join(root, 'docs', 'tasks', '0001'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'tasks', '0001', 'task.md'),
    '<!-- TASK-META\n' + JSON.stringify(meta('subagent:designer', 'subagent:judge')) + '\n-->\n');
  assert.equal(taskFiles(root).length, 1);
  assert.equal(validateContract(GRAPH, parseTaskMeta(fs.readFileSync(taskFiles(root)[0], 'utf8'))).length, 1);
});

/*
 * Задание 0147: заказчик поставил между воркером и приёмщиком ревьюера
 * (worker → reviewer-1 → judge). Ревьюер — промежуточная проверка без ключа,
 * подписывает judge; не-ревьюер по-прежнему останавливает цепочку.
 */
const CHAIN = {
  nodes: [
    { id: 'worker', role: 'исполнитель' },
    { id: 'reviewer-1', role: 'ревьюер' },
    { id: 'judge', role: 'приёмщик' },
  ],
  edges: [
    { from: 'worker', to: 'reviewer-1', kind: 'report' },
    { from: 'reviewer-1', to: 'judge', kind: 'report' },
  ],
};

test('ревьюер не подписывает: приёмщик работы воркера — judge за ревьюером', () => {
  assert.deepEqual(expectedAcceptor(CHAIN, 'worker'), { ok: true, acceptor: 'judge', kind: 'report' });
});

test('ревьюер без своей цели остаётся приёмщиком: прежнее поведение', () => {
  const lonely = {
    nodes: [{ id: 'worker', role: 'исполнитель' }, { id: 'reviewer-1', role: 'ревьюер' }],
    edges: [{ from: 'worker', to: 'reviewer-1', kind: 'report' }],
  };
  assert.deepEqual(expectedAcceptor(lonely, 'worker'), { ok: true, acceptor: 'reviewer-1', kind: 'report' });
});

test('не-ревьюер не пропускается: master остаётся приёмщиком', () => {
  const chain = {
    nodes: [
      { id: 'worker', role: 'исполнитель' },
      { id: 'master', role: 'исполнитель' },
      { id: 'judge', role: 'приёмщик' },
    ],
    edges: [
      { from: 'worker', to: 'master', kind: 'report' },
      { from: 'master', to: 'judge', kind: 'report' },
    ],
  };
  assert.deepEqual(expectedAcceptor(chain, 'worker'), { ok: true, acceptor: 'master', kind: 'report' });
});

test('ревьюер опознаётся по роли (нормализованно) и по id reviewer*', () => {
  const roleOnly = {
    nodes: [{ id: 'worker' }, { id: 'check', role: ' Reviewer ' }, { id: 'judge', role: 'приёмщик' }],
    edges: [{ from: 'worker', to: 'check', kind: 'report' }, { from: 'check', to: 'judge', kind: 'report' }],
  };
  assert.equal(expectedAcceptor(roleOnly, 'worker').acceptor, 'judge');
  const reviewRole = {
    nodes: [{ id: 'worker' }, { id: 'check', role: 'review' }, { id: 'judge' }],
    edges: [{ from: 'worker', to: 'check', kind: 'review' }, { from: 'check', to: 'judge', kind: 'report' }],
  };
  assert.deepEqual(expectedAcceptor(reviewRole, 'worker'), { ok: true, acceptor: 'judge', kind: 'review' });
  const idOnly = {
    nodes: [{ id: 'worker' }, { id: 'reviewer-2' }, { id: 'judge' }],
    edges: [{ from: 'worker', to: 'reviewer-2', kind: 'report' }, { from: 'reviewer-2', to: 'judge', kind: 'report' }],
  };
  assert.equal(expectedAcceptor(idOnly, 'worker').acceptor, 'judge');
});

test('контракт с judge проходит на цепочке с ревьюером, чужой приёмщик отвергнут', () => {
  assert.deepEqual(validateContract(CHAIN, meta('subagent:worker', 'subagent:judge')), []);
  const problems = validateContract(CHAIN, meta('subagent:worker', 'subagent:coordinator'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /acceptor=coordinator, структура — judge/u);
});

test('кольцо ревьюеров не зацикливает проверку', () => {
  const ring = {
    nodes: [{ id: 'worker' }, { id: 'reviewer-1', role: 'ревьюер' }, { id: 'reviewer-2', role: 'ревьюер' }],
    edges: [
      { from: 'worker', to: 'reviewer-1', kind: 'report' },
      { from: 'reviewer-1', to: 'reviewer-2', kind: 'report' },
      { from: 'reviewer-2', to: 'reviewer-1', kind: 'report' },
    ],
  };
  const result = expectedAcceptor(ring, 'worker');
  assert.equal(result.ok, true);
  assert.match(result.acceptor, /^reviewer-/u);
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('CONTRACT TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
