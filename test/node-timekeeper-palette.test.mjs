/**
 * 0347: таймкипер в палитре и в реестре видов узлов.
 *
 * Класс timekeeper появился в 0344 (lib/node-classes.js), но в палитре не было
 * карточки, а в реестре видов — вида. Этот тест держит связку целиком: карточка
 * NODE_LIBRARY, вид NODE_KINDS/SPECS и класс NODE_CLASSES называют одно и то же
 * (id, подпись, роли), поэтому узел, вынесенный человеком на канву, проходит
 * проверку вида, а не остаётся карточкой без вида.
 *
 * Модуль проверяется без DOM: бандл загружается в поддельный window, чистые
 * функции палитры (__libraryItem, __libraryEdge, __libraryNodeDraft) — те же,
 * которыми пользуется панель.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_KINDS, SPECS, nodeKindOf, validateNodeCard } from '../lib/node-spec.js';
import { NODE_CLASSES, nodeClassOf } from '../lib/node-classes.js';

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

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

/* Тот же способ загрузки, что у test/client.test.mjs: React нужен только заглушкой. */
function loadBundle() {
  let registered = null;
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry; } } };
  const sandboxRequire = (id) => {
    if (id === 'react') {
      return {
        createElement: () => null,
        Component: class Component { constructor(props) { this.props = props; this.state = {}; } setState() {} },
      };
    }
    throw new Error('unexpected require: ' + id);
  };
  const run = new Function('window', source);
  run(window);
  assert.ok(registered, 'bundle did not call window.__ModuleLoader__.load');
  return { entry: registered, module: registered.factory(sandboxRequire) };
}

const TYPE = 'timekeeper';
const LABEL = 'Тайм-менеджер';
const ROLE = 'тайм-менеджер';
const ROLES = ['тайм-менеджер', 'тайм менеджер', 'таймкипер', 'timekeeper'];
const BRIEF = 'предупреждает координатора о периодах останова';

test('C1.1 карточка таймкипера есть в палитре и названа по классу', () => {
  const { module } = loadBundle();
  const card = module.__libraryItem(TYPE);
  assert.ok(card, 'в NODE_LIBRARY нет карточки ' + TYPE);
  assert.equal(card.type, TYPE);
  assert.equal(card.label, LABEL, 'подпись карточки — «Тайм-менеджер»');
  assert.equal(card.role, ROLE, 'роль карточки — «тайм-менеджер»');
  assert.equal(card.brief, BRIEF, 'brief называет назначение');
  assert.ok(String(card.icon || '').trim(), 'у карточки нет иконки');
  assert.equal(card.icon, '⏱', 'иконка карточки — часы');
  assert.equal('model' in card, false, 'карточка не рекомендует модель: её выбирает человек');
  const items = module.__libraryItems();
  assert.equal(items.filter((item) => item.type === TYPE).length, 1,
    'карточка таймкипера ровно одна: ' + items.map((item) => item.type).join(','));
  assert.ok(items.some((item) => item.type === TYPE), 'карточка таймкипера не попадает в палитру');
});

test('C1.2 type карточки есть в видах узлов', () => {
  const { module } = loadBundle();
  const card = module.__libraryItem(TYPE);
  assert.ok(NODE_KINDS.includes(card.type), 'вида ' + card.type + ' нет в NODE_KINDS: ' + NODE_KINDS.join(','));
  assert.ok(SPECS[card.type], 'в SPECS нет записи ' + card.type);
  assert.equal(SPECS[card.type].kind, card.type, 'поле kind вида называет сам вид');
});

test('C1.3 роль карточки выводит вид timekeeper', () => {
  const { module } = loadBundle();
  const card = module.__libraryItem(TYPE);
  assert.equal(nodeKindOf({ id: 'timekeeper-1', role: card.role }), TYPE,
    'роль «тайм-менеджер» обязана называть вид timekeeper');
  for (const role of ROLES) {
    assert.equal(nodeKindOf({ id: 'keeper-x', role }), TYPE, 'роль «' + role + '» не выводит timekeeper');
  }
  assert.equal(nodeKindOf({ id: TYPE, role: '' }), TYPE, 'id timekeeper тоже называет вид');
});

test('C1.4 узел из карточки проходит проверку вида без находок', () => {
  const { module } = loadBundle();
  const card = module.__libraryItem(TYPE);
  const draft = module.__libraryNodeDraft(card);
  assert.ok(draft, 'из карточки не собирается объявление узла');
  assert.equal(draft.type, TYPE, 'тип карточки переносится в узел');
  assert.equal(draft.role, ROLE, 'роль карточки переносится в узел');
  assert.equal(nodeKindOf(draft), TYPE, 'узел из карточки выводит вид timekeeper');
  const byRole = validateNodeCard(draft);
  assert.equal(byRole.ok, true, 'карточка проверена, а не пропущена');
  assert.equal(byRole.valid, true, 'находки: ' + JSON.stringify(byRole.problems));
  assert.deepEqual(byRole.problems, []);
  const byKind = validateNodeCard({ ...draft, kind: draft.type });
  assert.equal(byKind.valid, true, 'узел с kind timekeeper принят');
  assert.deepEqual(byKind.problems, []);
});

test('C1.5 класс timekeeper и вид timekeeper согласованы полным набором', () => {
  const { module } = loadBundle();
  const card = module.__libraryItem(TYPE);
  const klass = NODE_CLASSES[TYPE];
  const spec = SPECS[TYPE];
  assert.ok(klass, 'в NODE_CLASSES нет класса ' + TYPE);
  assert.ok(spec, 'в SPECS нет вида ' + TYPE);
  assert.equal(klass.id, TYPE, 'id класса');
  assert.equal(klass.kind, TYPE, 'kind класса равен id');
  assert.equal(spec.kind, TYPE, 'kind вида');
  assert.equal(card.type, klass.id, 'карточка, класс и вид называют один id');
  assert.equal(klass.title, LABEL, 'подпись класса — «Тайм-менеджер»');
  assert.equal(card.label, klass.title, 'подпись карточки совпадает с подписью класса');
  /* Полный набор ролей, а не «содержит хотя бы одну»: расхождение недопустимо. */
  assert.deepEqual([...spec.roles].sort(), [...ROLES].sort(), 'набор ролей вида не совпадает с классом');
  for (const role of ROLES) {
    assert.equal(nodeClassOf({ role }).classId, klass.id, 'класс по роли «' + role + '»');
    assert.equal(nodeKindOf({ id: 'keeper-y', role }), spec.kind, 'вид по роли «' + role + '»');
  }
});

test('C1.6 связь report в сторону координатора, модель не рекомендована', () => {
  const { module } = loadBundle();
  assert.deepEqual(module.__libraryEdge(TYPE, 'keeper-1', true),
    { from: 'keeper-1', to: 'coordinator', kind: 'report' },
    'таймкипер возвращает отчёт координатору');
  assert.equal(module.__libraryEdge(TYPE, 'keeper-1', false), null,
    'без координатора связь не выдумывается');
  const card = module.__libraryItem(TYPE);
  assert.equal(card.link.kind, 'report');
  assert.equal(card.link.from, 'node');
  assert.equal(card.link.to, 'coordinator');
  assert.equal('model' in module.__libraryNode(card, 'keeper-2'), false,
    'модель не переносится в узел');
  assert.equal('agentPreset' in card, false, 'пресет по умолчанию не выставляется');
});

test('C1.7 спека в prompt содержательна: периоды, leadMinutes, предупреждение, молчание', () => {
  const { module } = loadBundle();
  const card = module.__libraryItem(TYPE);
  const prompt = String(card.prompt || '');
  assert.ok(prompt.trim(), 'спека таймкипера пуста');
  assert.ok(prompt.length >= 120, 'спека слишком коротка для смысла 0344: ' + prompt.length + ' символов');
  for (const [pattern, what] of [
    [/период/iu, 'периоды высокой стоимости'],
    [/предупрежд/iu, 'предупреждение до начала'],
    [/leadMinutes/u, 'за leadMinutes до начала'],
    [/молч/iu, 'молчание'],
    [/координатор/iu, 'координатор — адресат'],
  ]) {
    assert.match(prompt, pattern, 'в спеке нет сути: ' + what);
  }
  assert.match(prompt, /Definition of Done/u, 'у спеки нет Definition of Done');
  const lastLine = prompt.split(/\r?\n/u).filter((line) => line.trim()).pop();
  assert.match(lastLine, /^Definition of Done:/u, 'Definition of Done не последняя строка');
  assert.ok(source.includes('type: "timekeeper"'), 'карточка timekeeper не объявлена в NODE_LIBRARY');
  assert.ok(source.includes('icon: "⏱"'), 'иконка карточки не объявлена в NODE_LIBRARY');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)));
}
console.log('NODE-TIMEKEEPER-PALETTE TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
