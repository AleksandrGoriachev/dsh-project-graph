/**
 * 0186: якоря — утверждение файла и привязка к узлам структуры.
 *
 * Утверждение — не «файл принят на веру»: hash обязан быть sha256 ровно этих
 * байтов, algo — sha256, подпись покрывает hash+by+at и всегда человеческая
 * (human-*) на любом слое. Манифест 0.3 включается по НАЛИЧИЮ поля
 * layer/sides/enforcedBy: пустая строка, null и undefined — отказ с названием
 * поля, enforcedBy обязателен, scope — алиас sides (расхождение — отказ),
 * engine запрещён для project и для sides/scope='both', а новое утверждение
 * требует LF в конце файла. Старое scope-only утверждение читается по алиасу
 * без LF — совместимость 0186. Привязка — не «список есть»: каждый id обязан
 * существовать, а аудитор и ревьюер — назвать непустой consumes. Эти тесты
 * держат ту же семантику, что гейт запуска (lib/spawn.js), потому что зовут те
 * же функции.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  anchorsDeclared,
  consumesOf,
  structureAnchorBindings,
  validateApproval,
  validateBinding,
} from '../lib/anchors.js';

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

const ANCHORS = {
  version: 1,
  anchors: [
    { id: 'A1', claim: 'гейт якорей есть', scope: 'project', stage: 'pre-work', check: 'checks/0186 c1', status: 'active' },
    { id: 'A2', claim: 'notJudged обязателен', scope: 'project', stage: 'pre-work', check: 'checks/0186 c4', status: 'active' },
  ],
};
const TEXT = JSON.stringify(ANCHORS, null, 2);
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

const APPROVAL = (over = {}) => ({
  version: 1,
  anchors: 'docs/anchors.json',
  algo: 'sha256',
  hash: sha(TEXT),
  scope: 'project',
  by: ['заказчик'],
  at: '2026-11-09T19:00:00+03:00',
  signature: { keyId: 'human-1', algo: 'ed25519', covers: 'hash+by+at', value: 'sig' },
  ...over,
});

/** Все ошибки одной строкой: проверка видит причину отказа. */
function errorsOf(result) {
  assert.equal(typeof result.ok, 'boolean', 'ok — булево');
  assert.ok(Array.isArray(result.errors), 'errors — массив');
  return result.errors.join(' | ');
}

test('validateApproval: совпадающий sha256 и covers hash+by+at — ok', () => {
  assert.deepEqual(validateApproval(APPROVAL(), TEXT), { ok: true, errors: [] });
});

test('validateApproval: чужой хеш — отказ с ожидаемым sha256', () => {
  const result = validateApproval(APPROVAL({ hash: sha('другой текст') }), TEXT);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /hash не совпадает/u);
  assert.match(errorsOf(result), new RegExp(sha(TEXT), 'u'), 'отказ называет ожидаемый хеш');
});

test('validateApproval: хеш не sha256 — отказ', () => {
  const result = validateApproval(APPROVAL({ hash: 'deadbeef' }), TEXT);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /не sha256/u);
});

test('validateApproval: algo не sha256 — отказ', () => {
  const result = validateApproval(APPROVAL({ algo: 'md5' }), TEXT);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /algo/u);
});

test('validateApproval: covers=hash не покрывает by+at — отказ', () => {
  const result = validateApproval(APPROVAL({ signature: { keyId: 'human-1', covers: 'hash' } }), TEXT);
  assert.equal(result.ok, false);
  assert.ok(errorsOf(result).includes('hash+by+at'), 'отказ называет требуемое покрытие');
});

test('validateApproval: нет signature — отказ', () => {
  const approval = APPROVAL();
  delete approval.signature;
  const result = validateApproval(approval, TEXT);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /signature/u);
});

test('validateApproval: старое утверждение both тоже требует human-* (любой слой)', () => {
  const bot = validateApproval(APPROVAL({ scope: 'both', signature: { keyId: 'agent-1', covers: 'hash+by+at' } }), TEXT);
  assert.equal(bot.ok, false, 'агент не утверждает и обе стороны');
  assert.match(errorsOf(bot), /human-/u);
  assert.match(errorsOf(bot), /agent-1/u);
  const human = validateApproval(APPROVAL({ scope: 'both', signature: { keyId: 'human-7', covers: 'hash+by+at' } }), TEXT);
  assert.equal(human.ok, true, 'человеческий ключ утверждает обе стороны');
});

test('validateApproval: нет scope — отказ, а не project по умолчанию', () => {
  const approval = APPROVAL();
  delete approval.scope;
  const result = validateApproval(approval, TEXT);
  assert.equal(result.ok, false, 'отсутствующее scope не считается project');
  assert.match(errorsOf(result), /нет scope/u, 'отказ говорит, что scope обязателен');
  assert.match(errorsOf(result), /project/u);
  assert.match(errorsOf(result), /both/u);
});

test('validateApproval: неизвестный scope — отказ с перечнем допустимых', () => {
  for (const scope of ['global', 'user', 'PROJECT-WIDE', '', null, 42]) {
    const result = validateApproval(APPROVAL({ scope }), TEXT);
    assert.equal(result.ok, false, JSON.stringify(scope) + ' — не область утверждения');
    assert.match(errorsOf(result), /scope/u, 'отказ называет scope');
    assert.match(errorsOf(result), /project/u);
    assert.match(errorsOf(result), /both/u);
  }
});

test('validateApproval: scope project с ключом агента — отказ (подпись только human-*)', () => {
  const result = validateApproval(
    APPROVAL({ signature: { keyId: 'agent-judge', algo: 'ed25519', covers: 'hash+by+at', value: 'sig' } }),
    TEXT,
  );
  assert.equal(result.ok, false, 'агент не утверждает якоря ни на одном слое');
  assert.match(errorsOf(result), /human-/u);
  assert.match(errorsOf(result), /agent-judge/u);
});

test('validateApproval: корень не JSON-объект — отказ', () => {
  for (const value of [null, undefined, [], 'approved', 42]) {
    const result = validateApproval(value, TEXT);
    assert.equal(result.ok, false, JSON.stringify(value) + ' не утверждение');
    assert.match(errorsOf(result), /approval/u);
  }
});

/*
 * Манифест 0.3: слой, исполнитель и область. Новое утверждение утверждает
 * файл с LF в конце; хеш считается по дословным байтам.
 */
const TEXT03 = JSON.stringify(ANCHORS, null, 2) + '\n';

const APPROVAL03 = (over = {}) => ({
  version: 1,
  anchors: 'docs/anchors.json',
  algo: 'sha256',
  hash: sha(TEXT03),
  layer: 'project',
  enforcedBy: 'nodes',
  sides: 'project',
  by: ['заказчик'],
  at: '2026-11-09T22:00:00+03:00',
  signature: { keyId: 'human-7', algo: 'ed25519', covers: 'hash+by+at', value: 'sig' },
  ...over,
});

test('манифест 0.3: layer project, enforcedBy nodes, human-* — ok', () => {
  assert.deepEqual(validateApproval(APPROVAL03(), TEXT03), { ok: true, errors: [] });
});

test('манифест 0.3: enforcedBy engine для layer project — отказ', () => {
  const result = validateApproval(APPROVAL03({ enforcedBy: 'engine' }), TEXT03);
  assert.equal(result.ok, false, 'движок не утверждает проект');
  assert.match(errorsOf(result), /engine/u);
  assert.match(errorsOf(result), /project/u);
});

test('манифест 0.3: enforcedBy engine для layer contour — ok', () => {
  const result = validateApproval(APPROVAL03({ layer: 'contour', sides: 'contour', enforcedBy: 'engine' }), TEXT03);
  assert.deepEqual(result, { ok: true, errors: [] }, 'запрет engine касается только проекта');
});

test('манифест 0.3: неизвестный enforcedBy — отказ', () => {
  const result = validateApproval(APPROVAL03({ enforcedBy: 'oracle' }), TEXT03);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /enforcedBy/u);
});

test('манифест 0.3: enforcedBy обязателен', () => {
  const approval = APPROVAL03();
  delete approval.enforcedBy;
  const result = validateApproval(approval, TEXT03);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /enforcedBy/u);
});

test('манифест 0.3: layer выводится из sides/scope', () => {
  const approval = APPROVAL03({ sides: 'contour', enforcedBy: 'engine' });
  delete approval.layer;
  assert.deepEqual(validateApproval(approval, TEXT03), { ok: true, errors: [] }, 'sides=contour выводит layer=contour');
});

test('манифест 0.3: layer и sides расходятся — отказ', () => {
  for (const over of [
    { layer: 'project', sides: 'both' },
    { layer: 'contour', sides: 'project' },
  ]) {
    const result = validateApproval(APPROVAL03(over), TEXT03);
    assert.equal(result.ok, false, JSON.stringify(over) + ' — не одно утверждение');
    assert.match(errorsOf(result), /расходятся/u);
  }
});

test('манифест 0.3: scope — алиас sides; совпадают — ok, расходятся — отказ', () => {
  const alias = validateApproval(APPROVAL03({ scope: 'project' }), TEXT03);
  assert.deepEqual(alias, { ok: true, errors: [] }, 'scope=project и sides=project — одна область');
  const conflict = validateApproval(APPROVAL03({ sides: 'both', scope: 'project' }), TEXT03);
  assert.equal(conflict.ok, false);
  assert.match(errorsOf(conflict), /scope/u);
  assert.match(errorsOf(conflict), /алиас/u);
});

test('манифест 0.3: both с человеком — ok, both с агентом — отказ', () => {
  const human = APPROVAL03({ sides: 'both', scope: 'both' });
  delete human.layer;
  assert.deepEqual(validateApproval(human, TEXT03), { ok: true, errors: [] }, 'обе стороны утверждает человек');
  const bot = APPROVAL03({
    sides: 'both',
    scope: 'both',
    signature: { keyId: 'agent-judge', algo: 'ed25519', covers: 'hash+by+at', value: 'sig' },
  });
  delete bot.layer;
  const result = validateApproval(bot, TEXT03);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /human-/u);
});

test('манифест 0.3: подпись human-* обязательна на любом слое', () => {
  const cases = [
    { label: 'project', over: {} },
    { label: 'contour', over: { layer: 'contour', sides: 'contour', enforcedBy: 'engine' } },
    { label: 'both', over: { sides: 'both', scope: 'both', enforcedBy: 'nodes' }, dropLayer: true },
  ];
  for (const item of cases) {
    const base = APPROVAL03(item.over);
    if (item.dropLayer) delete base.layer;
    const bot = validateApproval(
      { ...base, signature: { keyId: 'agent-judge', algo: 'ed25519', covers: 'hash+by+at', value: 'sig' } },
      TEXT03,
    );
    assert.equal(bot.ok, false, item.label + ': агент якоря не утверждает');
    assert.match(errorsOf(bot), /human-/u, item.label + ': отказ называет human-');
    const human = validateApproval(
      { ...base, signature: { keyId: 'human-7', algo: 'ed25519', covers: 'hash+by+at', value: 'sig' } },
      TEXT03,
    );
    assert.deepEqual(human, { ok: true, errors: [] }, item.label + ': человек утверждает');
  }
});

test('манифест 0.3: пустые поля не выключают режим 0.3 (обход LF и enforcedBy)', () => {
  const noLf = JSON.stringify(ANCHORS, null, 2);
  const doc = APPROVAL03({ layer: '', sides: '', enforcedBy: '', scope: 'project', hash: sha(noLf) });
  const result = validateApproval(doc, noLf);
  assert.equal(result.ok, false, 'пустые поля не откатывают утверждение в 0.2');
  const errors = errorsOf(result);
  for (const name of ['layer', 'sides', 'enforcedBy']) {
    assert.match(errors, new RegExp(name + ' пуст', 'u'), name + ' назван пустым');
  }
  assert.match(errors, /нет LF в конце файла/u, 'пустые поля не отменяют обязательный LF');
});

test('манифест 0.3: поля со значением undefined — отказ, а не 0.2', () => {
  const doc = APPROVAL03({ layer: undefined, sides: undefined, enforcedBy: undefined });
  const result = validateApproval(doc, TEXT03);
  assert.equal(result.ok, false, 'наличие поля важнее значения');
  assert.match(errorsOf(result), /layer пуст/u);
  assert.match(errorsOf(result), /sides пуст/u);
  assert.match(errorsOf(result), /enforcedBy пуст/u);
  const missingEnforcer = APPROVAL03();
  delete missingEnforcer.enforcedBy;
  assert.match(errorsOf(validateApproval(missingEnforcer, TEXT03)), /нет enforcedBy/u, 'отсутствие — это «нет», а не «пуст»');
});

test('манифест 0.3: пустой scope — отказ с названием поля', () => {
  const result = validateApproval(APPROVAL03({ scope: '' }), TEXT03);
  assert.equal(result.ok, false, 'пустой алиас не подменяет область');
  assert.match(errorsOf(result), /scope пуст/u);
  assert.match(errorsOf(result), /project/u);
});

test('манифест 0.3: layer выводится из scope, но не из both', () => {
  const fromScope = APPROVAL03({ scope: 'contour', enforcedBy: 'engine' });
  delete fromScope.layer;
  delete fromScope.sides;
  assert.deepEqual(validateApproval(fromScope, TEXT03), { ok: true, errors: [] }, 'scope=contour выводит layer=contour');
  const both = APPROVAL03({ sides: 'both', scope: 'both' });
  delete both.layer;
  assert.deepEqual(validateApproval(both, TEXT03), { ok: true, errors: [] }, 'both слоя не выводит и не требует');
});

test('манифест 0.3: файл без LF в конце — отказ «нет LF в конце файла»', () => {
  const noLf = JSON.stringify(ANCHORS, null, 2);
  const result = validateApproval(APPROVAL03({ hash: sha(noLf) }), noLf);
  assert.equal(result.ok, false, 'утверждение 0.3 требует LF');
  assert.match(errorsOf(result), /нет LF в конце файла/u);
});

test('манифест 0.3: хеш — дословные байты, лишний символ меняет утверждение', () => {
  const result = validateApproval(APPROVAL03({ hash: sha(TEXT03 + ' ') }), TEXT03);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /hash не совпадает/u);
});

test('старое scope-only утверждение читается по алиасу без LF (совместимость 0186)', () => {
  const legacy = validateApproval(APPROVAL(), TEXT);
  assert.deepEqual(legacy, { ok: true, errors: [] }, 'TEXT без LF — прежнее утверждение 0186');
  const contour = validateApproval(APPROVAL({ scope: 'contour' }), TEXT);
  assert.deepEqual(contour, { ok: true, errors: [] }, 'scope contour выводит layer=contour');
});

test('манифест 0.3: неизвестный layer — отказ с перечнем', () => {
  const result = validateApproval(APPROVAL03({ layer: 'global', sides: 'global' }), TEXT03);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /layer/u);
  assert.match(errorsOf(result), /contour/u);
});

const BOUND_GRAPH = {
  nodes: [
    { id: 'coordinator', role: 'координатор' },
    {
      id: 'auditor',
      role: 'Аудитор задач',
      anchors: { consumes: [{ id: 'A1', scope: 'project', stage: 'pre-work' }], produces: [] },
    },
    {
      id: 'reviewer-1',
      role: 'ревьюер',
      anchors: { consumes: ['A2'], produces: [{ id: 'A1', scope: 'project', stage: 'post-work' }] },
    },
    { id: 'worker', role: 'исполнитель' },
  ],
};

test('validateBinding: известные якоря у аудитора и ревьюера — ok', () => {
  assert.deepEqual(validateBinding(BOUND_GRAPH, ANCHORS), { ok: true, errors: [] });
});

test('validateBinding: тот же список массивом и корнем файла — одинаково', () => {
  assert.equal(validateBinding(BOUND_GRAPH, ANCHORS.anchors).ok, true);
  assert.equal(validateBinding(BOUND_GRAPH, { version: 1, anchors: [] }).ok, false);
});

test('validateBinding: неизвестный id в consumes — ошибка с узлом и id', () => {
  const graph = {
    nodes: [{ id: 'auditor', role: 'Аудитор задач', anchors: { consumes: [{ id: 'ZZ' }], produces: [] } }],
  };
  const result = validateBinding(graph, ANCHORS);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /«ZZ»/u);
  assert.match(errorsOf(result), /auditor/u);
  assert.match(errorsOf(result), /consumes/u);
});

test('validateBinding: неизвестный id в produces — ошибка', () => {
  const graph = {
    nodes: [
      { id: 'auditor', role: 'Аудитор задач', anchors: { consumes: [{ id: 'A1' }], produces: [{ id: 'A9' }] } },
    ],
  };
  const result = validateBinding(graph, ANCHORS);
  assert.equal(result.ok, false);
  assert.match(errorsOf(result), /«A9»/u);
  assert.match(errorsOf(result), /produces/u);
});

test('validateBinding: аудитор без anchors — ошибка (роль по id и по слову)', () => {
  const byRole = validateBinding({ nodes: [{ id: 'audit', role: 'Аудитор задач' }] }, ANCHORS);
  assert.equal(byRole.ok, false);
  assert.match(errorsOf(byRole), /непустой anchors.consumes/u);
  const byId = validateBinding({ nodes: [{ id: 'auditor', role: 'проверяющий' }] }, ANCHORS);
  assert.equal(byId.ok, false);
  assert.match(errorsOf(byId), /аудитор/u);
});

test('validateBinding: ревьюер без consumes — ошибка', () => {
  for (const node of [
    { id: 'reviewer-1', role: 'проверяющий' },
    { id: 'rev', role: 'ревьюер' },
  ]) {
    const result = validateBinding({ nodes: [node] }, ANCHORS);
    assert.equal(result.ok, false, node.id + ' обязан объявить consumes');
    assert.match(errorsOf(result), /ревьюер/u);
  }
});

test('validateBinding: пустой consumes у ревьюера — тоже ошибка', () => {
  const graph = { nodes: [{ id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [], produces: [] } }] };
  assert.equal(validateBinding(graph, ANCHORS).ok, false);
});

test('validateBinding: якорь без id — ошибка', () => {
  const result = validateBinding({ nodes: [] }, { version: 1, anchors: [{ claim: 'без id' }] });
  assert.equal(result.ok, false);
  assert.ok(errorsOf(result).includes('anchors[0]: якорь без id'), 'отказ называет индекс якоря');
});

test('validateBinding: нет списка якорей — ошибка', () => {
  for (const value of [null, undefined, {}, { version: 1 }, 'anchors']) {
    assert.equal(validateBinding({ nodes: [] }, value).ok, false);
  }
});

test('structureAnchorBindings: anchors читаются из фрагментов структуры', () => {
  const files = [
    { name: 'structure/graph.json', text: JSON.stringify({ version: 1, nodes: [
      { id: 'auditor', role: 'Аудитор задач', anchors: { consumes: [{ id: 'A1' }], produces: [] } },
    ] }) },
    { name: 'structure/links.json', text: JSON.stringify({ version: 1, edges: [] }) },
    { name: 'structure/broken.json', text: '{' },
  ];
  const nodes = structureAnchorBindings(files);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'auditor');
  assert.deepEqual(consumesOf(nodes[0]), ['A1']);
  assert.equal(anchorsDeclared({ nodes }), true);
});

test('anchorsDeclared: структура без якорей — привязки нет', () => {
  assert.equal(anchorsDeclared({ nodes: [{ id: 'worker', role: 'исполнитель' }] }), false);
  assert.equal(anchorsDeclared({ nodes: [{ id: 'worker', anchors: { consumes: [], produces: [] } }] }), false);
  assert.equal(anchorsDeclared({ nodes: [{ id: 'worker', anchors: { consumes: ['A1'] } }] }), true);
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(failure.error && failure.error.stack ? failure.error.stack : failure.error);
  }
  console.error('ANCHORS TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('ANCHORS TEST OK: ' + passed + '/' + passed);
