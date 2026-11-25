/**
 * Спека узла (0282): реестр видов, вывод вида kind → id → роль и правила
 * карточки. Тесты держат контракт валидатора, который читает buildGraph.
 *
 * Результат валидатора: ok — карточка/граф разобраны и проверены, valid —
 * находок нет, problems — сами находки. Два поля, а не одно: неизвестный вид
 * обязан быть назван находкой, а не проглочен молча.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NODE_KINDS, PROBLEM_CODES, SPECS,
  nodeKindOf, validateNodeCard, validateGraphCards,
} from '../lib/node-spec.js';
import { buildGraph } from '../lib/graph.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Задание 0345: данные вида узла берутся из снимка графа, а не из живого
// structure/graph.json — структура проекта канонично живёт в store.
const FIXTURE_FILE = path.join(ROOT, 'test', 'fixtures', 'structure-graph.json');
const codes = (result) => result.problems.map((problem) => problem.code);
const file = (name, value) => ({ name, text: typeof value === 'string' ? value : JSON.stringify(value) });

test('реестр: 12 видов узла + folder, у каждого роли, gates и независимость', () => {
  assert.deepEqual([...NODE_KINDS].sort(), [
    'acceptor', 'adviser', 'auditor', 'coordinator', 'critic', 'designer',
    'folder', 'interlocutor', 'release', 'reviewer', 'tester', 'timekeeper', 'worker',
  ]);
  for (const kind of NODE_KINDS) {
    const spec = SPECS[kind];
    assert.ok(spec, 'вид ' + kind + ' объявлен');
    assert.equal(spec.kind, kind, 'поле kind называет вид');
    assert.ok(spec.roles.length >= 2, 'у вида ' + kind + ' есть имена ролей ru/en');
    assert.ok(['required', 'optional'].includes(spec.gates), 'gates — required|optional');
    assert.equal(typeof spec.independence, 'boolean', 'independence — boolean');
  }
  assert.deepEqual(
    NODE_KINDS.filter((kind) => SPECS[kind].gates === 'required'),
    ['reviewer', 'acceptor', 'auditor'],
    'вход обязателен ровно у проверяющих видов',
  );
  assert.deepEqual(
    NODE_KINDS.filter((kind) => SPECS[kind].independence),
    ['worker', 'reviewer', 'acceptor'],
    'независимые виды — исполнитель, ревьюер, приёмщик',
  );
  /*
   * 0347: таймкипер — 12-й вид. Набор ролей и синонимов сверяется полным
   * списком, а не «содержит хотя бы один»: вид и класс timekeeper обязаны
   * называть одни и те же слова.
   */
  const timekeeper = SPECS.timekeeper;
  assert.ok(timekeeper, 'вид timekeeper объявлен');
  assert.deepEqual([...timekeeper.roles], ['тайм-менеджер', 'тайм менеджер', 'таймкипер', 'timekeeper']);
  assert.deepEqual([...timekeeper.synonyms], ['таймкипер', 'тайм-менеджер']);
  assert.equal(timekeeper.gates, 'optional', 'таймкиперу вход не обязателен: он наблюдатель времени');
  assert.equal(timekeeper.independence, false, 'независимость таймкиперу не требуется');
  assert.deepEqual([...PROBLEM_CODES], [
    'kind-unknown', 'kind-role-mismatch', 'gates-required', 'must-differ-from', 'folder-invalid',
  ]);
});

test('вид выводится по kind, иначе по id (вид и синоним), иначе по роли', () => {
  assert.equal(nodeKindOf({ id: 'x1', kind: 'reviewer', role: 'ревьюер' }), 'reviewer', 'kind сильнее id и роли');
  assert.equal(nodeKindOf({ id: 'designer', role: 'исполнитель' }), 'designer', 'id называет вид');
  assert.equal(nodeKindOf({ id: 'judge', role: 'приёмщик' }), 'acceptor', 'id-синоним judge');
  assert.equal(nodeKindOf({ id: 'zzz-1', role: 'Советник' }), 'adviser', 'роль называет вид adviser');
  assert.equal(nodeKindOf({ id: 'zzz-2', role: 'Собеседник' }), 'interlocutor', 'роль называет вид interlocutor');
  assert.equal(nodeKindOf({ id: 'coord-1', role: 'координатор структуры' }), 'coordinator',
    'роль во фразе тоже называет вид');
  assert.equal(nodeKindOf({ id: 'worker', kind: 'agent', role: 'исполнитель' }), 'worker',
    'kind "agent" — метка схемы, вид выводится дальше по id');
  assert.equal(nodeKindOf({ id: 'worker-1', role: 'Советник' }), 'adviser',
    'суффикс id не отбрасывается: worker-1 — не worker');
  assert.equal(nodeKindOf({ id: 'previewer', role: 'ревьюер' }), 'reviewer',
    'латиница сравнивается по границе слова');
  /* 0347: таймкипер выводится по роли (ru/en) и по id-синониму так же, как класс. */
  assert.equal(nodeKindOf({ id: 'keeper-1', role: 'тайм-менеджер' }), 'timekeeper',
    'роль «тайм-менеджер» называет вид timekeeper');
  assert.equal(nodeKindOf({ id: 'keeper-2', role: 'тайм менеджер' }), 'timekeeper',
    'роль «тайм менеджер» называет вид timekeeper');
  assert.equal(nodeKindOf({ id: 'keeper-3', role: 'таймкипер' }), 'timekeeper',
    'роль «таймкипер» называет вид timekeeper');
  assert.equal(nodeKindOf({ id: 'timekeeper', role: '' }), 'timekeeper',
    'id timekeeper называет вид без роли');
});

test('неизвестный вид — kind-unknown, а не молчаливый worker', () => {
  const unknown = validateNodeCard({ id: 'ghost', role: 'непонятно-кто' });
  assert.equal(unknown.ok, true, 'карточка проверена, а не пропущена');
  assert.equal(unknown.valid, false, 'карточка недействительна');
  assert.deepEqual(codes(unknown), ['kind-unknown']);
  const problem = unknown.problems[0];
  assert.equal(problem.node, 'ghost', 'находка называет узел');
  assert.match(problem.message, /не выведен вид/u);

  assert.equal(nodeKindOf({ id: 'worker', kind: 'ghost', role: 'исполнитель' }), null,
    'явно неизвестный kind не подменяется выводом по id');
  assert.equal(validateNodeCard({ id: 'worker', kind: 'ghost' }).problems[0].code, 'kind-unknown');
  assert.equal(nodeKindOf({}), null, 'пустая карточка вида не даёт');

  const notCard = validateNodeCard(null);
  assert.equal(notCard.ok, false, 'не объект — валидатору нечего проверять');
  assert.deepEqual(codes(notCard), ['kind-unknown']);
});

test('роль обязана принадлежать виду — kind-role-mismatch, кроме допущенных специализаций', () => {
  const mismatch = validateNodeCard({ id: 'r2', kind: 'reviewer', role: 'исполнитель' });
  assert.equal(mismatch.valid, false);
  assert.ok(codes(mismatch).includes('kind-role-mismatch'));
  assert.match(mismatch.problems[0].message, /допустимые роли reviewer/u, 'сообщение называет допустимые роли');

  const designer = validateNodeCard({ id: 'designer', role: 'исполнитель' });
  assert.equal(designer.valid, true, 'designer принимает роль исполнителя: так объявлен живой граф');
  assert.equal(validateNodeCard({
    id: 'acceptor-2', kind: 'acceptor', role: 'судья', anchors: { consumes: ['A1'] },
  }).valid, true, 'синоним роли приёмщика допущен');
});

test('проверяющий без входов — gates-required; consumes или gates снимают требование', () => {
  for (const kind of ['reviewer', 'acceptor', 'auditor']) {
    const bare = validateNodeCard({ id: kind + '-x', kind, role: SPECS[kind].roles[0] });
    assert.equal(bare.valid, false, 'вид ' + kind + ' без входа отвергнут');
    assert.ok(codes(bare).includes('gates-required'), 'вид ' + kind + ' без входа отвергнут');
  }
  assert.equal(validateNodeCard({
    id: 'rv-y', kind: 'reviewer', role: 'ревьюер', anchors: { consumes: ['A1'] },
  }).valid, true, 'непустой anchors.consumes — вход проверяющего');
  assert.equal(validateNodeCard({
    id: 'rv-z', kind: 'reviewer', role: 'ревьюер', gates: ['критерии задания'],
  }).valid, true, 'gates — альтернативный вход проверяющего');
  assert.equal(validateNodeCard({
    id: 'rv-empty', kind: 'reviewer', role: 'ревьюер', gates: [],
  }).valid, false, 'пустой gates не считается входом');
  assert.equal(validateNodeCard({ id: 'worker-1', kind: 'worker', role: 'исполнитель' }).valid, true,
    'исполнителю вход не обязателен');
});

test('mustDifferFrom не ссылается на себя и на несуществующий узел', () => {
  const self = validateNodeCard({
    id: 'acc', kind: 'acceptor', role: 'приёмщик', anchors: { consumes: ['A1'] }, mustDifferFrom: ['acc'],
  });
  assert.ok(codes(self).includes('must-differ-from'), 'узел не может отличаться сам от себя');

  const graph = validateGraphCards({
    nodes: [
      { id: 'worker', role: 'исполнитель', mustDifferFrom: ['ghost'] },
      { id: 'coordinator', role: 'координатор' },
    ],
  });
  assert.equal(graph.valid, false);
  assert.ok(codes(graph).includes('must-differ-from'), 'ссылка на несуществующий узел — находка');
  assert.match(graph.problems.find((problem) => problem.code === 'must-differ-from').message, /ghost/u);

  const ok = validateGraphCards({
    nodes: [
      { id: 'worker', role: 'исполнитель', mustDifferFrom: ['reviewer-1'] },
      { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: ['A1'] } },
      { id: 'coordinator', role: 'координатор' },
    ],
  });
  assert.deepEqual(ok.problems, [], 'ссылка на существующий узел допустима');
});

test('folder требует box.path и минимум двух участников — folder-invalid', () => {
  const valid = { id: 'folder-1', box: { path: 'coordination' }, participants: ['structure', 'workflow'] };
  assert.deepEqual(validateGraphCards({ nodes: [], folders: [valid] }).problems, []);
  assert.deepEqual(validateGraphCards({ nodes: [], folders: [{ ...valid, box: 'coordination' }] }).problems, [],
    'box строкой — тоже путь');

  const noBox = validateGraphCards({ nodes: [], folders: [{ id: 'f', box: {}, participants: ['a', 'b'] }] });
  assert.deepEqual(codes(noBox), ['folder-invalid']);
  assert.match(noBox.problems[0].message, /box\.path/u);

  const one = validateGraphCards({ nodes: [], folders: [{ id: 'f', box: { path: 'x' }, participants: ['one'] }] });
  assert.deepEqual(codes(one), ['folder-invalid'], 'один участник — не канал');
  assert.match(one.problems[0].message, /минимум два/u);

  const card = validateNodeCard({ id: 'f', kind: 'folder', box: {}, participants: ['one'] });
  assert.equal(card.problems.filter((problem) => problem.code === 'folder-invalid').length, 2,
    'карточка папки получает обе причины');
});

test('снимок structure/graph.json проходит валидацию без правок владельца', () => {
  const graph = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
  const result = validateGraphCards(graph);
  assert.equal(result.valid, true, 'находки: ' + JSON.stringify(result.problems));
  assert.deepEqual(result.problems, []);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.equal(nodeKindOf(byId.get('designer')), 'designer', 'designer выведен по id');
  assert.equal(nodeKindOf(byId.get('worker-1')), 'adviser', 'Советник выведен по роли');
  assert.equal(nodeKindOf(byId.get('worker-2')), 'interlocutor', 'Собеседник выведен по роли');
  assert.equal(nodeKindOf(byId.get('judge')), 'acceptor', 'judge выведен по id-синониму');
  for (const id of ['judge', 'reviewer-1']) {
    assert.equal(validateNodeCard(byId.get(id)).valid, true, 'проверяющий ' + id + ' имеет consumes');
  }
});

test('buildGraph(specs:true) добавляет находки валидатора; без specs поведение прежнее', () => {
  const bad = JSON.stringify({ version: 1, nodes: [{ id: 'ghost', role: 'непонятно-кто' }], edges: [] });
  const withSpecs = buildGraph([file('graph.json', bad)], { specs: true });
  assert.ok(withSpecs.errors.some((error) => error.code === 'kind-unknown'), 'kind-unknown в errors');
  assert.equal(buildGraph([file('graph.json', bad)], {}).errors.length, 0,
    'без specs новых ошибок нет');

  const text = fs.readFileSync(FIXTURE_FILE, 'utf8');
  const live = buildGraph([file('structure/graph.json', text)], { specs: true });
  assert.deepEqual(
    live.errors.filter((error) => /^(kind-|must-differ|gates-|folder-)/u.test(String(error.code))),
    [],
    'снимок графа проходит в specs-режиме',
  );
  assert.equal(buildGraph([file('structure/graph.json', text)], {}).errors.length, 0,
    'без specs снимок графа собирается как прежде');
});
