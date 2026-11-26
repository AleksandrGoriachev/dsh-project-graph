#!/usr/bin/env node
/**
 * Задание 0374 — единый резолвер идентичности.
 *
 * Проверяет lib/identity.js: разрешение по ярлыку, по абсолютному пути, по
 * объявленному пути папки, устаревший и неразрешимый адрес; карту ярлыков;
 * приоритет источников при конфликте (карта участников сильнее объявленных
 * путей папки) и запись сработавшего источника в результат.
 *
 * Только временные каталоги: резолвер не читает диск, каталоги нужны лишь чтобы
 * пути были настоящими и сравнение шло по абсолютным корням.
 *
 *   node test/identity-registry.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityOf, labelRootsMap } from '../lib/identity.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* временный каталог */ }
}

/** Стенд: проект с двумя воркспейсами и объявленной папкой. */
function host(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-identity-' + tag + '-'));
  const project = path.join(base, 'project');
  const structure = path.join(project, 'ws-structure');
  const workflow = path.join(project, 'ws-workflow');
  const copy = path.join(base, 'portal', 'ws-workflow');
  for (const dir of [structure, workflow, copy]) fs.mkdirSync(dir, { recursive: true });
  return { base, project, structure, workflow, copy };
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

const participants = (h) => ({ structure: h.structure, workflow: h.workflow });

/* ------------------------------------------------------------------------- *
 * 1. Ярлык из карты участников: label + source participants
 * ------------------------------------------------------------------------- */
test('1: ярлык участника разрешается картой, источник — participants', () => {
  const h = host('label');
  try {
    const identity = identityOf('structure', { participants: participants(h) });
    assert.deepEqual(identity, {
      kind: 'label',
      label: 'structure',
      root: h.structure,
      boxBase: h.structure,
      source: 'participants',
    }, 'ярлык и корень из карты, база ящика — корень');
    const upper = identityOf('StRuCtUrE', { participants: participants(h) });
    assert.equal(upper.kind, 'label', 'регистр ярлыка не важен');
    assert.equal(upper.label, 'structure', 'вернулось объявленное написание ярлыка');
    assert.ok(samePath(upper.root, h.structure));
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 2. Абсолютный путь корня участника: kind path
 * ------------------------------------------------------------------------- */
test('2: абсолютный путь корня участника — path с ярлыком', () => {
  const h = host('path');
  try {
    const identity = identityOf(h.workflow, { participants: participants(h) });
    assert.equal(identity.kind, 'path', 'путь корня — path, не label');
    assert.equal(identity.label, 'workflow', 'по пути найден ярлык участника');
    assert.equal(identity.source, 'participants', 'источник — карта участников');
    assert.ok(samePath(identity.root, h.workflow));
    const upper = identityOf(h.workflow.toUpperCase(), { participants: participants(h) });
    assert.equal(upper.kind, 'path', 'регистр пути не важен');
    assert.ok(samePath(upper.root, h.workflow));
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 3. Объявленный путь папки: label и path с source folders.paths
 * ------------------------------------------------------------------------- */
test('3: объявленный путь папки разрешает и ярлык, и путь', () => {
  const h = host('folder-paths');
  try {
    const context = { folders: [{ id: 'f', paths: { workflow: h.workflow } }] };
    const byLabel = identityOf('workflow', context);
    assert.equal(byLabel.kind, 'label', 'метка объявленных путей — ярлык');
    assert.equal(byLabel.source, 'folders.paths', 'источник — объявленные пути папки');
    assert.ok(samePath(byLabel.root, h.workflow));
    const byPath = identityOf(h.workflow, context);
    assert.equal(byPath.kind, 'path', 'объявленный путь — path');
    assert.equal(byPath.label, 'workflow', 'путь назван ярлыком объявления');
    assert.equal(byPath.source, 'folders.paths');
    assert.ok(samePath(byPath.boxBase, h.workflow), 'база ящика — корень объявленного пути');
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 4. Конфликт источников: карта участников сильнее пути папки
 * ------------------------------------------------------------------------- */
test('4: карта участников сильнее объявленного пути папки, источник записан', () => {
  const h = host('conflict');
  try {
    const context = {
      participants: { workflow: h.workflow },
      folders: [{ id: 'f', paths: { workflow: h.copy } }],
    };
    const byLabel = identityOf('workflow', context);
    assert.equal(byLabel.kind, 'label');
    assert.ok(samePath(byLabel.root, h.workflow), 'ярлык взят из карты, а не из пути папки');
    assert.equal(byLabel.source, 'participants', 'сработавший источник назван');
    const byCopy = identityOf(h.copy, context);
    assert.equal(byCopy.kind, 'path', 'объявленный путь всё ещё разрешается как путь');
    assert.equal(byCopy.source, 'folders.paths', 'у пути свой источник');
    assert.ok(samePath(byCopy.root, h.copy));
    const map = labelRootsMap(context);
    assert.ok(samePath(map.get('workflow'), h.workflow), 'карта ярлыков держит приоритет карты');
    assert.ok(samePath(map.get('WORKFLOW'.toLowerCase()), h.workflow), 'нижний регистр — тот же ключ карты');
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 5. Карта ярлыков: обе стороны и имена каталогов
 * ------------------------------------------------------------------------- */
test('5: labelRootsMap собирает ярлыки обеих сторон одним правилом', () => {
  const h = host('map');
  try {
    const map = labelRootsMap({
      participants: { structure: h.structure },
      folders: [{ id: 'f', paths: { workflow: h.workflow } }],
    });
    assert.ok(samePath(map.get('structure'), h.structure), 'ярлык карты участников');
    assert.ok(samePath(map.get('workflow'), h.workflow), 'ярлык объявленного пути');
    assert.ok(samePath(map.get('ws-workflow'), h.workflow), 'имя каталога корня — тоже метка');
    assert.equal(typeof map.get('нет-такого'), 'undefined', 'необъявленного ярлыка в карте нет');
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 6. Устаревший адрес: роль или id узла — legacy, запасная база ящика
 * ------------------------------------------------------------------------- */
test('6: устаревший адрес — legacy с запасной базой ящика, не ошибка', () => {
  const h = host('legacy');
  try {
    const context = { participants: participants(h), root: h.structure };
    for (const value of ['reviewer-1', 'subagent:worker', 'Critic']) {
      const identity = identityOf(value, context);
      assert.equal(identity.kind, 'legacy', value + ' — устаревший адрес');
      assert.equal(identity.source, 'legacy', 'источник — legacy');
      assert.equal(identity.label, value, 'метка остаётся как названа');
      assert.equal(identity.root, '', 'воркспейс не выдуман');
    }
    const legacy = identityOf('reviewer-1', context);
    assert.ok(samePath(legacy.boxBase, h.project), 'база ящика — общий каталог участников (прежняя лестница)');
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 7. Неразрешимый адрес: unresolved, source пуст
 * ------------------------------------------------------------------------- */
test('7: неразрешимый адрес — unresolved без корня и источника', () => {
  const h = host('unresolved');
  try {
    const context = { participants: participants(h) };
    const typo = identityOf('workspace-typo', context);
    assert.equal(typo.kind, 'unresolved', 'опечатка не разрешается');
    assert.equal(typo.root, '', 'корня нет');
    assert.equal(typo.boxBase, '', 'базы ящика нет');
    assert.equal(typo.source, '', 'источник пуст');
    assert.equal(typo.label, 'workspace-typo', 'назван как передан');
    const outside = identityOf(path.join(h.base, 'elsewhere'), context);
    assert.equal(outside.kind, 'unresolved', 'абсолютный путь вне объявлений — не адрес');
    assert.equal(identityOf('   ', context).kind, 'unresolved', 'пустое значение — не адрес');
  } finally { rmrf(h.base); }
});

if (failures.length > 0) {
  for (const item of failures) {
    console.log('FAIL ' + item.name + ': ' + (item.error && item.error.message ? item.error.message : item.error));
  }
  console.log('IDENTITY REGISTRY FAIL: ' + passed + '/' + (passed + failures.length));
  process.exit(1);
}
console.log('IDENTITY REGISTRY OK: ' + passed + '/' + passed);
console.log('label/path/declared folder path/legacy/unresolved; participant map wins over folder paths; source recorded');
