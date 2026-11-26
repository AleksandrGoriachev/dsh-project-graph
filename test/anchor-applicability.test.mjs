/**
 * 0299: применимость якоря к узлу по роли — резолвер и причины.
 *
 * Тесты держат инварианты задания:
 *   C1 — роль совпала/не совпала/у узла нет роли; причина названа стабильным
 *        кодом (role-mismatch, no-node-role), сравнение без регистра и внешних
 *        пробелов;
 *   C2 — v2-якорь без appliesTo.roles → no-roles; битый документ якорей →
 *        ok:false и errors, без исключения.
 *
 * Файл работает и как обычный node-скрипт (node test/anchor-applicability.test.mjs),
 * и под node --test: провал выставляет exit-код 1.
 */
import assert from 'node:assert/strict';
import { ANCHOR_APPLICABILITY, nodeAnchorApplicability } from '../lib/anchors.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try {
    body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

const BASE = {
  claim: 'утверждение',
  check: 'node checks/x.mjs c1',
  status: 'auto',
  layer: 'project',
  sides: 'project',
  enforcedBy: 'nodes',
};

const v3anchor = (over = {}) => ({ ...BASE, id: 'A1', appliesTo: { roles: ['ревьюер'] }, ...over });
const v2anchor = (over = {}) => ({ ...BASE, id: 'A1', ...over });
const v3doc = (...anchors) => ({ version: 3, anchors });
const v2doc = (...anchors) => ({ version: 2, anchors });
const ids = (items) => (items || []).map((item) => item.id);
const reasonOf = (result, id) => (result.notApplicable || []).find((item) => item.id === id)?.reason;

test('коды причин стабильны и названы', () => {
  assert.equal(ANCHOR_APPLICABILITY.ROLE_MISMATCH, 'role-mismatch');
  assert.equal(ANCHOR_APPLICABILITY.NO_ROLES, 'no-roles');
  assert.equal(ANCHOR_APPLICABILITY.NO_NODE_ROLE, 'no-node-role');
});

test('роль совпала: регистр и внешние пробелы не важны', () => {
  const result = nodeAnchorApplicability(
    v3doc(v3anchor({ appliesTo: { roles: ['  Ревьюер  '] } })),
    { id: 'reviewer-1', role: ' ревьюер ' },
  );
  assert.deepEqual(result, {
    ok: true,
    applicable: [{ id: 'A1', roles: ['Ревьюер'] }],
    notApplicable: [],
  });
});

test('роль совпала среди нескольких ролей якоря', () => {
  const result = nodeAnchorApplicability(
    v3doc(v3anchor({ appliesTo: { roles: ['аудитор', 'ПРИЁМЩИК'] } })),
    { id: 'judge', role: 'приёмщик' },
  );
  assert.deepEqual(ids(result.applicable), ['A1']);
  assert.deepEqual(result.applicable[0].roles, ['аудитор', 'ПРИЁМЩИК']);
  assert.deepEqual(result.notApplicable, []);
});

test('role-mismatch: роли якоря названы, роли узла среди них нет', () => {
  const result = nodeAnchorApplicability(v3doc(v3anchor()), { id: 'auditor', role: 'аудитор' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.applicable, []);
  assert.deepEqual(result.notApplicable, [{ id: 'A1', reason: 'role-mismatch' }]);
  assert.equal(reasonOf(result, 'A1'), ANCHOR_APPLICABILITY.ROLE_MISMATCH);
});

test('несколько якорей: совпавшие — applicable, остальные — role-mismatch', () => {
  const result = nodeAnchorApplicability(
    v3doc(
      v3anchor({ id: 'A1', appliesTo: { roles: ['ревьюер'] } }),
      v3anchor({ id: 'A2', appliesTo: { roles: ['аудитор'] } }),
      v3anchor({ id: 'A3', appliesTo: { roles: ['приёмщик', 'ревьюер'] } }),
    ),
    { id: 'reviewer-1', role: 'Ревьюер' },
  );
  assert.deepEqual(ids(result.applicable), ['A1', 'A3']);
  assert.deepEqual(result.notApplicable, [{ id: 'A2', reason: 'role-mismatch' }]);
});

test('v2-якорь без appliesTo → no-roles, документ при этом ok', () => {
  const result = nodeAnchorApplicability(v2doc(v2anchor()), { id: 'reviewer-1', role: 'ревьюер' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.applicable, []);
  assert.deepEqual(result.notApplicable, [{ id: 'A1', reason: 'no-roles' }]);
});

test('v3-якорь без appliesTo или с пустыми roles → no-roles', () => {
  for (const anchor of [
    v3anchor({ appliesTo: undefined }),
    { ...BASE, id: 'A1' },
    v3anchor({ appliesTo: {} }),
    v3anchor({ appliesTo: { roles: [] } }),
    v3anchor({ appliesTo: { roles: ['  ', 42, null] } }),
  ]) {
    const result = nodeAnchorApplicability(v3doc(anchor), { id: 'reviewer-1', role: 'ревьюер' });
    assert.equal(result.ok, true, JSON.stringify(anchor));
    assert.deepEqual(result.notApplicable, [{ id: 'A1', reason: 'no-roles' }], JSON.stringify(anchor));
  }
});

test('узел без роли: ok:true, всё в notApplicable с no-node-role', () => {
  const doc = v3doc(
    v3anchor({ id: 'A1', appliesTo: { roles: ['ревьюер'] } }),
    v2anchor({ id: 'B1' }),
  );
  for (const node of [{ id: 'n1' }, { id: 'n1', role: '' }, { id: 'n1', role: '   ' }, null, undefined]) {
    const result = nodeAnchorApplicability(doc, node);
    assert.equal(result.ok, true, JSON.stringify(node));
    assert.deepEqual(result.applicable, []);
    assert.deepEqual(result.notApplicable, [
      { id: 'A1', reason: 'no-node-role' },
      { id: 'B1', reason: 'no-node-role' },
    ], JSON.stringify(node));
  }
  assert.equal(reasonOf(nodeAnchorApplicability(doc, {}), 'A1'), ANCHOR_APPLICABILITY.NO_NODE_ROLE);
});

test('пустой документ: ok:true и пустые списки', () => {
  assert.deepEqual(nodeAnchorApplicability(v3doc(), { id: 'n1', role: 'ревьюер' }), {
    ok: true,
    applicable: [],
    notApplicable: [],
  });
  assert.deepEqual(nodeAnchorApplicability(v2doc(), { id: 'n1' }), {
    ok: true,
    applicable: [],
    notApplicable: [],
  });
});

test('битый документ: ok:false, errors, без исключения', () => {
  const broken = [
    null,
    undefined,
    42,
    'anchors',
    {},
    { version: 3 },
    { version: 3, anchors: 'nope' },
    { version: 2, anchors: null },
    [1, 2],
  ];
  for (const doc of broken) {
    let result;
    assert.doesNotThrow(() => {
      result = nodeAnchorApplicability(doc, { id: 'n1', role: 'ревьюер' });
    }, JSON.stringify(doc) + ' — исключение');
    assert.equal(result.ok, false, JSON.stringify(doc));
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0, JSON.stringify(doc));
    assert.deepEqual(result.applicable, []);
    assert.deepEqual(result.notApplicable, []);
  }
});

test('битый документ: пустой id и повторяющийся id — ok:false с причиной', () => {
  const emptyId = nodeAnchorApplicability(v3doc(v3anchor({ id: '' })), { id: 'n1', role: 'ревьюер' });
  assert.equal(emptyId.ok, false);
  assert.match(emptyId.errors.join(' | '), /id/u);

  const duplicate = nodeAnchorApplicability(
    v3doc(v3anchor({ id: 'A1' }), v3anchor({ id: 'A1' })),
    { id: 'n1', role: 'ревьюер' },
  );
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join(' | '), /повторяется/u);

  /* id сравнивается без регистра: A1 и a1 — тот же адрес якоря. */
  const duplicateCase = nodeAnchorApplicability(
    v3doc(v3anchor({ id: 'A1' }), v3anchor({ id: 'a1' })),
    { id: 'n1', role: 'ревьюер' },
  );
  assert.equal(duplicateCase.ok, false);
  assert.match(duplicateCase.errors.join(' | '), /повторяется/u);
});

test('не-объект якоря в списке — битый документ, а не пропуск', () => {
  const result = nodeAnchorApplicability(v3doc('A1'), { id: 'n1', role: 'ревьюер' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('чистая функция: входной документ и роли не изменяются', () => {
  const anchor = v3anchor({ appliesTo: { roles: [' Ревьюер '] } });
  const doc = v3doc(anchor);
  const before = JSON.stringify(doc);
  const result = nodeAnchorApplicability(doc, { id: 'reviewer-1', role: 'ревьюер' });
  assert.equal(JSON.stringify(doc), before);
  result.applicable[0].roles.push('чужой');
  assert.notEqual(JSON.stringify(doc), JSON.stringify(result));
  assert.deepEqual(anchor.appliesTo.roles, [' Ревьюер ']);
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('ANCHOR APPLICABILITY TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exitCode = failures.length === 0 ? 0 : 1;
