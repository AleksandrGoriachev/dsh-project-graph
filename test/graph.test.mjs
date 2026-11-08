/**
 * The structure model is the contract of the panel, so every rule the panel
 * claims to enforce is asserted here on plain values: no filesystem, no DSH.
 */
import assert from 'node:assert/strict';
import { buildGraph, layoutGraph, summarizeGraph, findDelegateCycle, EDGE_KINDS, GRAPH_VERSION } from '../lib/graph.js';

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

const file = (name, value) => ({ name, text: typeof value === 'string' ? value : JSON.stringify(value) });
const codes = (list) => list.map((item) => item.code);
const near = (actual, expected, epsilon = 1e-6) => Math.abs(actual - expected) <= epsilon;

test('константы схемы', () => {
  assert.equal(GRAPH_VERSION, 1);
  assert.deepEqual(EDGE_KINDS, ['delegate', 'review', 'peer', 'report']);
});

test('папка обмена — отдельный список folders, а не узел', () => {
  /*
   * Решение заказчика 2026-11-02: папка — не узел графа. Узлы — только агенты,
   * папка объявляется списком folders и несёт box, участников и оркестратора.
   */
  const result = buildGraph([file('graph.json', {
    version: 1,
    models: { work: { provider: 'p', model: 'q' } },
    nodes: [{ id: 'coordinator', role: 'координатор', model: 'work' }],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'shared' },
      participants: ['structure', 'workflow'],
      orchestrator: 'coordinator',
      exchange: { threads: ['critic-report'], contract: 'contract.md' },
    }],
  })]);
  assert.deepEqual(result.errors, [], 'папка валидна без роли и модели');
  assert.equal(result.graph.folders.length, 1, 'buildGraph возвращает graph.folders');
  const folder = result.graph.folders[0];
  assert.equal(folder.id, 'folder-1');
  assert.equal(folder.orchestrator, 'coordinator', 'оркестратор сохранён полем');
  assert.deepEqual(folder.box, { path: 'coordination', root: 'shared' });
  assert.deepEqual(folder.participants, ['structure', 'workflow']);
  assert.deepEqual(folder.exchange, { threads: ['critic-report'], contract: 'contract.md' });
  assert.deepEqual(result.graph.nodes.map((node) => node.id), ['coordinator'],
    'папка не стала узлом');
  assert.ok(!result.warnings.some((item) => item.message.includes('folder-1')),
    'папка не получает диагнозов узла');
});

test('папка без orchestrator, с чужим orchestrator и папка-узел отвергаются с кодами', () => {
  const base = {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [{ id: 'coordinator', role: 'координатор', model: 'm' }],
  };
  const folder = (extra) => ({
    id: 'f1', box: { path: 'coordination' }, participants: ['structure'], orchestrator: 'coordinator', ...extra,
  });

  const withoutOrchestrator = buildGraph([file('graph.json', {
    ...base,
    folders: [{ id: 'f1', box: { path: 'coordination' }, participants: ['structure'] }],
  })]);
  const missing = withoutOrchestrator.errors.find((item) => item.code === 'folder-orchestrator');
  assert.ok(missing, 'папка без orchestrator — ошибка folder-orchestrator');
  assert.match(missing.fix, /orchestrator/u, 'рецепт называет поле');

  const stranger = buildGraph([file('graph.json', { ...base, folders: [folder({ orchestrator: 'ghost' })] })]);
  assert.ok(codes(stranger.errors).includes('folder-orchestrator-unknown'),
    'orchestrator на необъявленный узел — ошибка folder-orchestrator-unknown');

  const folderNode = buildGraph([file('graph.json', {
    ...base,
    nodes: [...base.nodes, { id: 'folder-1', kind: 'folder', box: { path: 'coordination' } }],
  })]);
  const refused = folderNode.errors.find((item) => item.code === 'folder-as-node');
  assert.ok(refused, 'узел kind: folder отвергается');
  assert.match(refused.message, /перенесите её в отдельный список folders/u, 'рецепт: перенесите в folders');
  assert.equal(folderNode.graph.nodes.some((node) => node.id === 'folder-1'), false,
    'папка-узел не попадает в узлы');

  const agentWithBox = buildGraph([file('graph.json', {
    ...base,
    nodes: [...base.nodes, { id: 'exchange-1', role: 'обмен', box: { path: 'coordination' } }],
  })]);
  assert.ok(codes(agentWithBox.errors).includes('folder-as-node'),
    'поля папки на агенте — тот же отказ folder-as-node');
});

test('у папки обязательны box и хотя бы один участник', () => {
  const base = {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [{ id: 'coordinator', role: 'координатор', model: 'm' }],
  };
  const withoutBox = buildGraph([file('graph.json', {
    ...base,
    folders: [{ id: 'f1', participants: ['structure'], orchestrator: 'coordinator' }],
  })]);
  assert.ok(codes(withoutBox.errors).includes('folder-box'), 'папка без box — ошибка');

  const noParticipants = buildGraph([file('graph.json', {
    ...base,
    folders: [{ id: 'f1', box: { path: 'coordination' }, participants: [], orchestrator: 'coordinator' }],
  })]);
  assert.ok(codes(noParticipants.errors).includes('folder-participants'),
    'пустой список участников — ошибка');

  const badParticipants = buildGraph([file('graph.json', {
    ...base,
    folders: [{ id: 'f1', box: { path: 'coordination' }, participants: ['  '], orchestrator: 'coordinator' }],
  })]);
  assert.ok(codes(badParticipants.errors).includes('folder-participants'),
    'пустая метка участника — ошибка');
});

test('неизвестный kind — ошибка с рецептом', () => {
  const result = buildGraph([file('graph.json', {
    version: 1,
    nodes: [{ id: 'x', kind: 'robot' }],
    edges: [],
  })]);
  assert.ok(codes(result.errors).includes('invalid-kind'));
});

test('минимальная структура: два узла и одна связь delegate', () => {
  const result = buildGraph([file('graph.json', {
    version: 1,
    models: { fast: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [
      { id: 'coordinator', role: 'coordinator', model: 'fast', prompt: 'Роль: ведущий. Definition of Done: план записан и роздан.' },
      { id: 'worker', role: 'programmer', model: 'fast', prompt: 'Роль: исполнитель. Definition of Done: результат собран и проверен.' },
    ],
    edges: [{ from: 'coordinator', to: 'worker' }],
  })]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.graph.nodes.length, 2);
  assert.deepEqual(result.graph.folders, [], 'список папок есть даже без папок');
  assert.equal(result.graph.edges[0].kind, 'delegate');
  const layout = layoutGraph(result.graph);
  assert.equal(layout.layers, 2);
  assert.equal(layout.nodes[0].y, 0);
  assert.ok(layout.nodes[1].y > layout.nodes[0].y);
  assert.equal(layout.width, 176);
});

test('одноранговая структура без корня: только peer, цикл разрешён', () => {
  const result = buildGraph([file('peers.json', {
    version: 1,
    nodes: [{ id: 'a', role: 'analyst' }, { id: 'b', role: 'analyst' }, { id: 'c', role: 'analyst' }],
    edges: [
      { from: 'a', to: 'b', kind: 'peer' },
      { from: 'b', to: 'c', kind: 'peer' },
      { from: 'c', to: 'a', kind: 'peer' },
    ],
  })]);
  assert.deepEqual(result.errors, []);
  // Только peer — это законная одноранговая структура, а не неполная.
  assert.ok(!codes(result.warnings).includes('no-delegate-edges'));
  assert.ok(codes(result.warnings).includes('no-model'));
  assert.equal(layoutGraph(result.graph).layers, 1);
});

test('agentPreset узла: строка читается, не строка — ошибка', () => {
  const good = buildGraph([file('g.json', {
    version: 1,
    nodes: [{ id: 'lead', role: 'lead', agentPreset: 'standard' }],
  })]);
  assert.deepEqual(good.errors, []);
  assert.equal(good.graph.nodes[0].agentPreset, 'standard');

  const bad = buildGraph([file('g.json', {
    version: 1,
    nodes: [{ id: 'lead', role: 'lead', agentPreset: 42 }],
  })]);
  assert.ok(codes(bad.errors).includes('invalid-agent-preset'));
});

test('fallbackModel узла: непустая строка сохраняется, иначе ошибка invalid-fallback-model', () => {
  /*
   * 0110 научил планировщик второй попытке окна, но нормализация графа собирает
   * узел из известных полей: без явного чтения fallbackModel до планировщика не
   * доходил, и вторая попытка всегда шла на запасной константе. Значение — имя
   * модели провайдера, а не алиас models{}: алиас разворачивается только в model.
   */
  const model = { provider: 'opencode-go', model: 'qwen3.8-flash' };
  const build = (node) => buildGraph([file('g.json', { version: 1, models: { m: model }, nodes: [node] })]);
  const critic = (extra) => ({ id: 'critic', role: 'критик', model: 'm', ...extra });

  const good = build(critic({ fallbackModel: '  deepseek-v4.1-flash  ' }));
  assert.deepEqual(good.errors, [], 'запасная модель — не ошибка: ' + JSON.stringify(codes(good.errors)));
  assert.equal(good.graph.nodes[0].fallbackModel, 'deepseek-v4.1-flash', 'значение сохранено и обрезано');

  for (const broken of [42, '', '   ', null, ['deepseek-v4.1-flash'], { model: 'x' }]) {
    const result = build(critic({ fallbackModel: broken }));
    const error = result.errors.find((item) => item.code === 'invalid-fallback-model');
    assert.ok(error, 'нет invalid-fallback-model для ' + JSON.stringify(broken));
    assert.match(error.message, /имя модели провайдера, не алиас/iu,
      'сообщение называет, что нужно имя модели провайдера, а не алиас models{}');
    assert.match(error.fix, /имя модели провайдера, не алиас/iu, 'рецепт повторяет то же словами');
    assert.deepEqual(result.graph.nodes.map((node) => node.id), ['critic', 'coordinator'],
      'узел строится без поля, а не теряется; координатор добавлен чтением (0175)');
    assert.equal(result.graph.nodes[0].fallbackModel, undefined, 'битое значение не попадает в граф');
    assert.equal(result.graph.nodes[0].model, 'qwen3.8-flash', 'маршрут узла остался рабочим');
  }

  /*
   * Нормализация не ослаблена: поле читается явно, поэтому незнакомое поле по-
   * прежнему отбрасывается и без объявления fallbackModel у узла нет.
   */
  const unknown = build(critic({ unknownField: 'x' }));
  assert.equal('unknownField' in unknown.graph.nodes[0], false, 'незнакомое поле отброшено');
  assert.equal('fallbackModel' in unknown.graph.nodes[0], false, 'без объявления поля в узле нет');
  assert.deepEqual(unknown.errors, []);
});

test('schedule узла: at строго HH:MM, timeZone из Intl, иначе ошибка с кодом', () => {
  const base = (schedule) => [file('g.json', {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [{ id: 'critic', role: 'критик', model: 'm', schedule }],
  })];
  const good = buildGraph(base({ at: '09:00', timeZone: 'Europe/Moscow' }));
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.graph.nodes[0].schedule, { at: '09:00', timeZone: 'Europe/Moscow' });

  const badAt = buildGraph(base({ at: '9:00', timeZone: 'Europe/Moscow' }));
  assert.ok(codes(badAt.errors).includes('invalid-schedule-at'));
  const badZone = buildGraph(base({ at: '09:00', timeZone: 'Mars/Olympus' }));
  assert.ok(codes(badZone.errors).includes('invalid-schedule-timezone'));
  const noZone = buildGraph(base({ at: '09:00' }));
  assert.ok(codes(noZone.errors).includes('invalid-schedule-timezone'));
  const notObject = buildGraph(base('09:00'));
  assert.ok(codes(notObject.errors).includes('invalid-schedule'));
});

test('несколько корней: два delegate в одного ребёнка', () => {
  const result = buildGraph([file('graph.json', {
    version: 1,
    nodes: [{ id: 'lead-code' }, { id: 'lead-design' }, { id: 'shared' }],
    edges: [
      { from: 'lead-code', to: 'shared', kind: 'delegate' },
      { from: 'lead-design', to: 'shared', kind: 'delegate' },
    ],
  })]);
  assert.deepEqual(result.errors, []);
  const layout = layoutGraph(result.graph);
  assert.equal(layout.layers, 2);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get('shared').layer, 1);
  assert.equal(byId.get('lead-code').layer, 0);
});

test('цикл по delegate — ошибка, но раскладка не падает', () => {
  const result = buildGraph([file('cycle.json', {
    version: 1,
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [
      { from: 'a', to: 'b', kind: 'delegate' },
      { from: 'b', to: 'c', kind: 'delegate' },
      { from: 'c', to: 'a', kind: 'delegate' },
    ],
  })]);
  assert.ok(codes(result.errors).includes('delegate-cycle'));
  const cycleError = result.errors.find((item) => item.code === 'delegate-cycle');
  assert.deepEqual(cycleError.nodes.slice(0, 1), ['a']);
  assert.equal(cycleError.nodes.at(-1), 'a');
  const layout = layoutGraph(result.graph);
  assert.ok(layout.cyclic.length >= 1);
});

test('findDelegateCycle игнорирует review и peer', () => {
  const nodeIndex = new Map(['a', 'b'].map((id) => [id, { id }]));
  assert.equal(findDelegateCycle([
    { from: 'a', to: 'b', kind: 'peer' },
    { from: 'b', to: 'a', kind: 'review' },
  ], nodeIndex), null);
});

test('слияние фрагментов: models в одном файле, узлы в другом', () => {
  const result = buildGraph([
    file('models.json', { version: 1, models: { critic: { provider: 'opencode', model: 'glm-5.3-flash' } } }),
    file('people.json', { version: 1, nodes: [{ id: 'judge', role: 'acceptor', model: 'critic' }] }),
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.graph.models.critic.model, 'glm-5.3-flash');
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[1].nodes, 1);
});

test('дубликат узла между фрагментами — ошибка с обоими файлами', () => {
  const result = buildGraph([
    file('a.json', { version: 1, nodes: [{ id: 'same' }] }),
    file('b.json', { version: 1, nodes: [{ id: 'same' }] }),
  ]);
  const error = result.errors.find((item) => item.code === 'duplicate-node');
  assert.ok(error);
  assert.match(error.message, /a\.json и b\.json/);
});

test('конфликт алиаса модели между фрагментами — ошибка', () => {
  const result = buildGraph([
    file('a.json', { version: 1, models: { m: { provider: 'opencode', model: 'x' } } }),
    file('b.json', { version: 1, models: { m: { provider: 'opencode', model: 'y' } } }),
  ]);
  assert.ok(codes(result.errors).includes('model-conflict'));
});

test('неизвестная модель у узла — ошибка', () => {
  const result = buildGraph([file('g.json', { version: 1, nodes: [{ id: 'a', model: 'nope' }] })]);
  assert.ok(codes(result.errors).includes('unknown-model'));
});

test('mustDifferFrom: совпадение маршрута — предупреждение, а не ошибка', () => {
  /*
   * Решение заказчика --117: одинаковая модель допустима. mustDifferFrom —
   * рекомендация, поэтому граф собирается, а человек видит предупреждение.
   */
  const same = buildGraph([file('g.json', {
    version: 1,
    models: { one: { provider: 'opencode', model: 'deepseek-v4.1-flash' }, two: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'a', model: 'one' }, { id: 'b', model: 'two', mustDifferFrom: ['a'] }],
  })]);
  assert.deepEqual(codes(same.errors), [], 'совпадение моделей не блокирует структуру: ' + JSON.stringify(codes(same.errors)));
  const warning = same.warnings.find((item) => item.code === 'same-family');
  assert.ok(warning, 'совпадение должно быть в warnings: ' + JSON.stringify(codes(same.warnings)));
  assert.equal(warning.node, 'b', 'предупреждение называет узел');
  assert.match(warning.message, /допустимы|рекомендация/u, 'предупреждение объясняет, что это пожелание');
  const different = buildGraph([file('g.json', {
    version: 1,
    models: {
      ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' },
      glm: { provider: 'opencode', model: 'glm-5.3-flash', family: 'zhipu' },
    },
    nodes: [{ id: 'a', model: 'ds' }, { id: 'b', model: 'glm', mustDifferFrom: ['a'] }],
  })]);
  assert.deepEqual(different.errors, []);
  assert.ok(!codes(different.warnings).includes('same-family'), 'разные семейства — без предупреждения');
});

test('прямой маршрут узла: provider+model работают без models{}', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    nodes: [{
      id: 'judge',
      role: 'приёмщик',
      provider: 'p2',
      model: 'm2',
      family: 'f2',
      prompt: 'Роль: приёмщик. Definition of Done: вердикт с доказательствами.',
    }],
  })]);
  assert.deepEqual(result.errors, [], 'прямой маршрут не требует models: ' + JSON.stringify(codes(result.errors)));
  const node = result.graph.nodes[0];
  assert.equal(node.provider, 'p2');
  assert.equal(node.model, 'm2');
  assert.equal(node.family, 'f2');
  assert.equal(node.modelAlias, undefined, 'у прямого маршрута нет алиаса');
  assert.equal(result.families.m2, 'f2', 'семейство маршрута узла в families');
});

test('миграция чтения: старый алиас разворачивается в provider/model узла', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { 'рабочая': { provider: 'p1', model: 'm1', family: 'f1' } },
    nodes: [{
      id: 'work',
      role: 'исполнитель',
      model: 'рабочая',
      prompt: 'Роль: исполнитель. Definition of Done: результат собран и проверен.',
    }],
  })]);
  assert.deepEqual(result.errors, []);
  const node = result.graph.nodes[0];
  assert.equal(node.provider, 'p1', 'provider пришёл из алиаса');
  assert.equal(node.model, 'm1', 'model узла — настоящая модель, а не имя алиаса');
  assert.equal(node.family, 'f1');
  assert.equal(node.modelAlias, 'рабочая', 'имя алиаса сохранено для панели');
  assert.equal(result.graph.models['рабочая'].model, 'm1', 'models остаётся картой старых алиасов');
});

test('миграция: прямые поля узла приоритетнее алиаса', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { route: { provider: 'p1', model: 'm1', family: 'f1' } },
    nodes: [{ id: 'a', role: 'lead', provider: 'p9', model: 'm9', family: 'f9' }],
  })]);
  assert.deepEqual(result.errors, []);
  const node = result.graph.nodes[0];
  assert.equal(node.provider, 'p9', 'прямой provider не перетёрт алиасом');
  assert.equal(node.model, 'm9');
  assert.equal(node.family, 'f9');
  assert.equal(node.modelAlias, undefined);
});

test('families: семейство алиаса и семейство прямого маршрута', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [
      { id: 'a', model: 'work' },
      { id: 'b', provider: 'p2', model: 'm2', family: 'zhipu' },
    ],
  })]);
  assert.equal(result.families.work, 'opencode', 'старый алиас остаётся в карте');
  assert.equal(result.families['deepseek-v4.1-flash'], 'opencode', 'модель мигрированного узла тоже в карте');
  assert.equal(result.families.m2, 'zhipu', 'прямой маршрут даёт своё семейство');
});

test('модель без объявленного family считается по провайдеру', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { one: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'a', model: 'one' }],
  })]);
  assert.equal(result.families.one, 'opencode');
});

test('связь в неизвестный узел и петля — ошибки', () => {
  const unknown = buildGraph([file('g.json', {
    version: 1,
    nodes: [{ id: 'a' }],
    edges: [{ from: 'a', to: 'ghost', kind: 'delegate' }],
  })]);
  assert.ok(codes(unknown.errors).includes('unknown-edge-endpoint'));
  const loop = buildGraph([file('g.json', {
    version: 1,
    nodes: [{ id: 'a' }],
    edges: [{ from: 'a', to: 'a', kind: 'delegate' }],
  })]);
  assert.ok(codes(loop.errors).includes('self-loop'));
});

test('неизвестный вид связи — ошибка, а не молчаливый дефолт', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'b', kind: 'owns' }],
  })]);
  assert.ok(codes(result.errors).includes('unknown-edge-kind'));
});

test('дубликат связи — предупреждение, связь остаётся одна', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    nodes: [{ id: 'a', role: 'x', model: 'm' }, { id: 'b', role: 'y', model: 'm' }],
    models: { m: { provider: 'p', model: 'q' } },
    edges: [
      { from: 'a', to: 'b', kind: 'delegate' },
      { from: 'a', to: 'b', kind: 'delegate' },
    ],
  })]);
  assert.ok(codes(result.warnings).includes('duplicate-edge'));
  assert.equal(result.graph.edges.length, 1);
});

test('битый JSON — ошибка; структура без поля nodes — тоже ошибка', () => {
  assert.deepEqual(codes(buildGraph([file('bad.json', '{ not json')]).errors), ['invalid-json']);
  /*
   * 0171: отсутствие поля nodes — не «пустой проект», а «состав не сказан»:
   * пустоту объявляют явно (nodes: []), и только она даёт предупреждение.
   */
  const missing = buildGraph([file('g.json', { version: 1, edges: [] })]);
  assert.deepEqual(codes(missing.errors), ['empty-graph']);
  assert.ok(!codes(missing.warnings).includes('empty-graph'), 'ошибка не дублируется предупреждением');
});

test('structure/ без единого фрагмента — новый проект: предупреждение, а не ошибка (0173)', () => {
  /*
   * e-trace 0173: папка structure/ создана, файлов нет. Прежде buildGraph([])
   * давал ошибку no-fragments и панель требовала «исправить файл». Теперь
   * пустая папка — новый проект: ошибок нет, есть warning empty-graph с
   * объяснением и следующим шагом.
   */
  const built = buildGraph([]);
  assert.deepEqual(codes(built.errors), [], 'отсутствие файлов не поломка: ' + JSON.stringify(codes(built.errors)));
  assert.deepEqual(codes(built.warnings), ['empty-graph'], 'ровно одно предупреждение о новом проекте');
  assert.match(built.warnings[0].message, /новый проект/, 'предупреждение объясняет, что структура только создана');
  assert.match(built.warnings[0].message, /координатор/, 'и говорит, с чего начать');
  /*
   * 0175 не трогает пустую канву: координатор живёт в ней виртуальной карточкой
   * (0170), а узел графа появляется вместе с первым объявленным узлом.
   */
  assert.deepEqual(built.graph.nodes, [], 'узлов нет');
  assert.deepEqual(built.graph.edges, [], 'связей нет');
  assert.deepEqual(built.sources, [], 'фрагментов нет');
  assert.deepEqual(built.families, {}, 'алиасов моделей нет');

  /* Битый файл важнее пустоты: разбор не маскируется диагнозом «новый проект». */
  const broken = buildGraph([file('bad.json', '{ not json')]);
  assert.deepEqual(codes(broken.errors), ['invalid-json'], 'битый файл — по-прежнему ошибка');
  assert.ok(!codes(broken.warnings).includes('empty-graph'), 'второго диагноза нет');
});

test('явно пустой граф (nodes: []) — предупреждение, а не ошибка: новый проект (0171)', () => {
  const empty = buildGraph([file('structure/graph.json', {
    version: 1, nodes: [], edges: [], folders: [],
  })]);
  assert.deepEqual(codes(empty.errors), [], 'пустой граф не ошибка: ' + JSON.stringify(codes(empty.errors)));
  assert.deepEqual(codes(empty.warnings), ['empty-graph'], 'ровно одно предупреждение о пустоте');
  /* 0175: пустой объявленный список остаётся пустым графом; карточка — виртуальная (0170). */
  assert.deepEqual(empty.graph.nodes, []);
  const warning = empty.warnings[0];
  assert.match(warning.message, /новый проект/, 'предупреждение объясняет, что это начало работы');
  assert.match(warning.message, /координатор/, 'и говорит, с чего начать');

  /* Пустота, объявленная в одном фрагменте, остаётся пустотой: фрагмент без nodes её не отменяет. */
  const split = buildGraph([
    file('a.json', { version: 1, nodes: [] }),
    file('b.json', { version: 1, folders: [] }),
  ]);
  assert.deepEqual(codes(split.errors), []);
  assert.ok(codes(split.warnings).includes('empty-graph'));

  /* Непустой граф предупреждения о пустоте не получает. */
  const filled = buildGraph([
    file('a.json', { version: 1, nodes: [{ id: 'coordinator', role: 'координатор' }] }),
    file('b.json', { version: 1, nodes: [] }),
  ]);
  assert.deepEqual(codes(filled.errors), []);
  assert.ok(!codes(filled.warnings).includes('empty-graph'));

  /* Ошибка разбора важнее: битый файл не маскируется диагнозом «узлов нет». */
  const broken = buildGraph([
    file('good.json', { version: 1, nodes: [] }),
    file('bad.json', '{ not json'),
  ]);
  assert.deepEqual(codes(broken.errors), ['invalid-json'], 'виноват разбор, а не пустота');
  assert.ok(!codes(broken.warnings).includes('empty-graph'), 'второго диагноза нет');
});

test('неподдерживаемая версия схемы — ошибка', () => {
  const result = buildGraph([file('g.json', { version: 2, nodes: [{ id: 'a' }] })]);
  assert.ok(codes(result.errors).includes('unsupported-version'));
});

test('изолированный узел — предупреждение', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [{ id: 'a', role: 'x', model: 'm' }, { id: 'lonely', role: 'y', model: 'm' }],
    edges: [{ from: 'a', to: 'a', kind: 'peer' }],
  })]);
  assert.ok(codes(result.warnings).includes('isolated-node'));
});

test('сводка считает роли и виды связей', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [{ id: 'a', role: 'lead', model: 'm' }, { id: 'b', role: 'lead', model: 'm' }, { id: 'c', role: 'judge', model: 'm' }],
    edges: [{ from: 'a', to: 'b', kind: 'peer' }, { from: 'a', to: 'c', kind: 'review' }, { from: 'b', to: 'a', kind: 'report' }],
  })]);
  const summary = summarizeGraph(result.graph, layoutGraph(result.graph));
  /* 0175: карточка координатора видна — сводка считает и её. */
  assert.equal(summary.nodes, 4);
  assert.equal(summary.edges, 3);
  assert.deepEqual(summary.byKind, { delegate: 0, review: 1, peer: 1, report: 1 });
  assert.deepEqual(summary.roles, { lead: 2, judge: 1, 'координатор': 1 });
});

test('связь report принимается и не меняет слои: это возврат, а не поручение', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [{ id: 'root', model: 'm' }, { id: 'child', model: 'm' }],
    edges: [
      { from: 'root', to: 'child', kind: 'delegate' },
      { from: 'child', to: 'root', kind: 'report' },
    ],
  })]);
  assert.equal(result.errors.length, 0, JSON.stringify(codes(result.errors)));
  const layout = layoutGraph(result.graph);
  const layerOf = (id) => layout.nodes.find((node) => node.id === id).layer;
  assert.equal(layerOf('root'), 0);
  assert.equal(layerOf('child'), 1, 'возврат не поднимает узел в слой корня');
});

test('пара связей между двумя узлами не рисуется одной линией', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [{ id: 'root', model: 'm' }, { id: 'child', model: 'm' }],
    edges: [
      { from: 'root', to: 'child', kind: 'delegate' },
      { from: 'child', to: 'root', kind: 'report' },
    ],
  })]);
  const layout = layoutGraph(result.graph);
  assert.equal(layout.edges.length, 2);
  const [first, second] = layout.edges;
  assert.notEqual(first.x1, second.x1, 'у пары рёбер разные линии');
  assert.ok(Math.abs(first.x1 - second.x1) >= 8, 'зазор виден глазом');
});

test('обратная связь delegate остаётся циклом, и report его не маскирует', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [{ id: 'root', model: 'm' }, { id: 'child', model: 'm' }],
    edges: [
      { from: 'root', to: 'child', kind: 'delegate' },
      { from: 'child', to: 'root', kind: 'delegate' },
    ],
  })]);
  assert.ok(codes(result.errors).includes('delegate-cycle'));
});

test('раскладка детерминирована и помещает широкий слой по центру', () => {
  const graph = {
    version: 1,
    models: {},
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'tail' }],
    edges: [
      { from: 'a', to: 'tail', kind: 'delegate' },
      { from: 'b', to: 'tail', kind: 'delegate' },
      { from: 'c', to: 'tail', kind: 'delegate' },
    ],
  };
  const first = layoutGraph(graph);
  const second = layoutGraph(graph);
  assert.deepEqual(first, second);
  assert.equal(first.width, 3 * 176 + 2 * 64);
  const tail = first.nodes.find((node) => node.id === 'tail');
  assert.equal(tail.x, Math.round((first.width - 176) / 2));
});

test('позиция узла: x и y вместе, целые ≥ 0 — иначе invalid-position с рецептом', () => {
  const positioned = buildGraph([file('g.json', {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [
      { id: 'a', role: 'lead', model: 'm', x: 240, y: 40 },
      { id: 'b', role: 'dev', model: 'm', x: 0, y: 0 },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'delegate' }],
  })]);
  assert.deepEqual(positioned.errors, []);
  const byId = new Map(positioned.graph.nodes.map((node) => [node.id, node]));
  assert.deepEqual(byId.get('a').position, { x: 240, y: 40 });
  assert.deepEqual(byId.get('b').position, { x: 0, y: 0 }, 'нулевая позиция — тоже позиция');

  const bad = [
    { x: -1, y: 0 },
    { x: 0, y: -20 },
    { x: 1.5, y: 0 },
    { x: 0, y: 2.25 },
    { x: '10', y: 20 },
    { x: 10 },
    { y: 10 },
  ];
  for (const position of bad) {
    const result = buildGraph([file('g.json', {
      version: 1,
      models: { m: { provider: 'p', model: 'q' } },
      nodes: [{ id: 'a', role: 'lead', model: 'm', ...position }],
    })]);
    const error = result.errors.find((item) => item.code === 'invalid-position');
    assert.ok(error, 'нет invalid-position для ' + JSON.stringify(position));
    assert.equal(result.graph.nodes[0].position, undefined, 'битая позиция не попадает в граф');
  }
});

test('раскладка: позиция побеждает слой, узел без позиции остаётся на расчётном месте', () => {
  const graph = (withPositions) => ({
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [
      { id: 'root', role: 'lead', model: 'm', ...(withPositions ? { position: { x: 400, y: 320 } } : {}) },
      { id: 'child', role: 'dev', model: 'm' },
    ],
    edges: [{ from: 'root', to: 'child', kind: 'delegate' }],
  });
  const plain = layoutGraph(graph(false));
  const moved = layoutGraph(graph(true));
  const plainChild = plain.nodes.find((node) => node.id === 'child');
  const child = moved.nodes.find((node) => node.id === 'child');
  const root = moved.nodes.find((node) => node.id === 'root');

  assert.equal(root.x, 400);
  assert.equal(root.y, 320);
  assert.equal(root.layer, 0, 'позиция не меняет слой: слои остаются расчётными');
  assert.deepEqual({ x: child.x, y: child.y }, { x: plainChild.x, y: plainChild.y },
    'узел без позиции должен стоять там же, где стоял');

  assert.ok(moved.width >= 400 + root.w, 'канва вмещает правый край: ' + moved.width);
  assert.ok(moved.height >= 320 + root.h, 'канва вмещает нижний край: ' + moved.height);
  assert.equal(plain.width, 176, 'без позиций канва не растягивается');

  /*
   * Карточки смещены по обеим осям, поэтому луч «центр → центр» выходит не
   * через середину стороны, а через её пересечение с лучом: верх у root и низ
   * у ребёнка, но точки сдвинуты от центра.
   */
  const edge = moved.edges[0];
  assert.equal(edge.y1, 320, 'линия начинается с верхней стороны карточки: карточка ниже ребёнка');
  assert.ok(near(edge.x1, 411.4567901234568), 'точка — пересечение луча центр→центр с верхней стороной: ' + edge.x1);
  assert.equal(edge.y2, child.y + child.h, 'и входит в нижнюю сторону ребёнка');
  assert.ok(near(edge.x2, 164.54320987654322), 'вторая точка тоже на луче, а не в центре стороны: ' + edge.x2);
});

test('ребро выходит из ближайшей стороны карточки: справа, слева и снизу', () => {
  const segment = (a, b) => layoutGraph({
    version: 1,
    models: {},
    nodes: [{ id: 'a', position: a }, { id: 'b', position: b }],
    edges: [{ from: 'a', to: 'b', kind: 'delegate' }],
  }).edges[0];

  const right = segment({ x: 0, y: 0 }, { x: 300, y: 20 });
  assert.equal(right.x1, 176, 'справа: ребро выходит из правой стороны');
  assert.ok(right.y1 > 0 && right.y1 < 62, 'справа: точка на стороне, а не в углу');
  assert.equal(right.x2, 300, 'справа: ребро входит в левую сторону второй карточки');
  assert.ok(right.y2 > 20 && right.y2 < 82, 'справа: точка на стороне, а не в углу');

  const left = segment({ x: 300, y: 0 }, { x: 0, y: 20 });
  assert.equal(left.x1, 300, 'слева: ребро выходит из левой стороны');
  assert.ok(left.y1 > 0 && left.y1 < 62);
  assert.equal(left.x2, 176, 'слева: ребро входит в правую сторону второй карточки');
  assert.ok(left.y2 > 20 && left.y2 < 82);

  const below = segment({ x: 0, y: 0 }, { x: 20, y: 300 });
  assert.equal(below.y1, 62, 'снизу: ребро выходит из нижней стороны');
  assert.ok(below.x1 > 0 && below.x1 < 176);
  assert.equal(below.y2, 300, 'снизу: ребро входит в верхнюю сторону второй карточки');
  assert.ok(below.x2 > 20 && below.x2 < 196);
});

test('совпавшие центры карточек: точка — центр карточки', () => {
  const layout = layoutGraph({
    version: 1,
    models: {},
    nodes: [{ id: 'a', position: { x: 0, y: 0 } }, { id: 'b', position: { x: 0, y: 0 } }],
    edges: [{ from: 'a', to: 'b', kind: 'delegate' }],
  });
  const edge = layout.edges[0];
  assert.deepEqual([edge.x1, edge.y1, edge.x2, edge.y2], [88, 31, 88, 31]);
});

test('позиция не ломает детерминированность раскладки', () => {
  const graph = {
    version: 1,
    models: {},
    nodes: [
      { id: 'a', position: { x: 30, y: 50 } },
      { id: 'b' },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'delegate' }],
  };
  assert.deepEqual(layoutGraph(graph), layoutGraph(graph));
});

test('prompt узла: роль и Definition of Done словами попадают в граф', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [
      { id: 'a', role: 'lead', model: 'm', prompt: 'Роль: ведущий. Definition of Done: план записан и проверен.' },
      { id: 'b', role: 'dev', model: 'm', prompt: 'Роль: исполнитель. Definition of Done: тесты пройдены.' },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'delegate' }],
  })]);
  assert.deepEqual(result.errors, []);
  const byId = new Map(result.graph.nodes.map((node) => [node.id, node]));
  assert.match(byId.get('a').prompt, /Definition of Done/);
  assert.match(byId.get('b').prompt, /исполнитель/);
  assert.ok(!codes(result.warnings).includes('no-prompt'), 'у узлов с prompt предупреждения нет');
});

test('узел без prompt: предупреждение с id узла и рецептом, структура остаётся действительной', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [
      { id: 'lead', role: 'lead', model: 'm', prompt: 'Роль: ведущий. Definition of Done: план записан и проверен.' },
      { id: 'silent', role: 'dev', model: 'm' },
    ],
    edges: [{ from: 'lead', to: 'silent', kind: 'delegate' }],
  })]);
  assert.deepEqual(result.errors, [], 'отсутствие prompt — не ошибка структуры');
  const warning = result.warnings.find((item) => item.code === 'no-prompt');
  assert.ok(warning, 'предупреждение no-prompt есть');
  assert.equal(warning.node, 'silent', 'предупреждение называет узел без prompt');
  assert.match(warning.message, /silent/);
  assert.match(warning.message, /на запуск не влияет/iu,
    'предупреждение честно говорит, что запуск не затронут');
  assert.match(warning.message, /role|роль/iu, 'без brief назван role — где роль уже задана');
  assert.ok(warning.fix, 'у предупреждения есть поле fix');
  assert.match(warning.fix, /prompt/);
  assert.ok(!result.warnings.some((item) => item.code === 'no-prompt' && item.node === 'lead'),
    'узел с prompt не получает предупреждения');
  assert.equal(result.graph.nodes.find((node) => node.id === 'silent').prompt, undefined);
});

test('узел без prompt, но с brief: предупреждение называет brief и его длину', () => {
  /*
   * Роль часто уже описана кратко в brief, и node.prompt при запуске не
   * читается: предупреждение обязано это сказать, а не требовать prompt.
   */
  const brief = 'делает основную работу по заданию координатора';
  const result = buildGraph([file('g.json', {
    version: 1,
    models: { m: { provider: 'p', model: 'q' } },
    nodes: [{ id: 'briefed', role: 'dev', model: 'm', brief }],
  })]);
  assert.deepEqual(result.errors, [], 'отсутствие prompt при brief — не ошибка структуры');
  const warning = result.warnings.find((item) => item.code === 'no-prompt');
  assert.ok(warning, 'предупреждение no-prompt есть');
  assert.equal(warning.node, 'briefed');
  assert.match(warning.message, /на запуск не влияет/iu);
  assert.match(warning.message, /brief/iu, 'назван brief как краткое описание роли');
  assert.match(warning.message, new RegExp(String(brief.length) + ' симв'), 'названа длина brief в символах');
  assert.match(warning.message, /Definition of Done/, 'пример prompt остаётся необязательным советом');
  assert.equal(result.graph.nodes[0].prompt, undefined);
});

test('concurrency узла: refuse/queue/parallel принимаются и нормализуются (0136)', () => {
  const build = (concurrency) => buildGraph([file('g.json', {
    version: 1,
    nodes: [{ id: 'worker', role: 'исполнитель', provider: 'p', model: 'm', concurrency }],
  })]);
  const refuse = build({ mode: 'refuse' });
  assert.deepEqual(refuse.errors, []);
  assert.deepEqual(refuse.graph.nodes[0].concurrency, { mode: 'refuse' });

  const queue = build({ mode: 'queue' });
  assert.deepEqual(queue.errors, []);
  assert.deepEqual(queue.graph.nodes[0].concurrency, { mode: 'queue' }, 'очередь без лимита');

  const parallel = build({ mode: 'parallel', max: 2 });
  assert.deepEqual(parallel.errors, []);
  assert.deepEqual(parallel.graph.nodes[0].concurrency, { mode: 'parallel', max: 2 });

  /* Поле необязательно: без него запуск считает узел refuse по умолчанию. */
  const plain = build(undefined);
  assert.deepEqual(plain.errors, []);
  assert.equal(plain.graph.nodes[0].concurrency, undefined);
});

test('concurrency узла: неизвестный режим и max вне 1..4 — invalid-concurrency с рецептом (0136)', () => {
  const build = (concurrency) => buildGraph([file('g.json', {
    version: 1,
    nodes: [{ id: 'worker', role: 'исполнитель', provider: 'p', model: 'm', concurrency }],
  })]);
  const bad = [
    { mode: 'chaos' },
    {},
    { mode: '' },
    { mode: 'parallel' },
    { mode: 'parallel', max: 0 },
    { mode: 'parallel', max: 5 },
    { mode: 'parallel', max: 1.5 },
    { mode: 'parallel', max: '2' },
    { mode: 'queue', max: 9 },
    'queue',
    ['queue'],
    42,
    null,
  ];
  for (const value of bad) {
    const result = build(value);
    const error = result.errors.find((item) => item.code === 'invalid-concurrency');
    assert.ok(error, 'нет invalid-concurrency для ' + JSON.stringify(value));
    assert.match(error.message, /concurrency/iu, 'сообщение называет поле');
    assert.ok(error.fix, 'у ошибки есть рецепт');
    assert.match(error.fix, /queue/u, 'рецепт показывает очередь');
    assert.match(error.fix, /parallel/u, 'рецепт показывает параллель');
    assert.equal(result.graph.nodes[0].concurrency, undefined, 'битое поле не попадает в граф');
    assert.deepEqual(result.graph.nodes.map((node) => node.id), ['worker', 'coordinator'],
      'узел строится без поля, а не теряется; координатор добавлен чтением (0175)');
  }
});

/* ------------------------------------------------------------------------- *
 * Задание 0175: координатор есть всегда — чтение
 * ------------------------------------------------------------------------- */

test('buildGraph добавляет координатора последним, не трогая порядок и рёбра (0175)', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    nodes: [{ id: 'worker-1', role: 'исполнитель', provider: 'p', model: 'm' }],
    edges: [],
  })]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.graph.nodes.map((node) => node.id), ['worker-1', 'coordinator'],
    'координатор добавлен последним: объявленный порядок не сдвинут');
  const coordinator = result.graph.nodes[1];
  assert.equal(coordinator.role, 'координатор');
  assert.equal(coordinator.brief, 'ведёт план и раздаёт работу');
  assert.equal(coordinator.implicit, true, 'узел пришёл из чтения, а не из файла');
  assert.ok(!result.warnings.some((item) => item.code === 'no-model' && item.node === 'coordinator'),
    'о неявном координаторе диагностика молчит');
  assert.ok(!result.warnings.some((item) => item.code === 'isolated-node' && item.node === 'coordinator'),
    'отсутствие связей у координатора — норма');
});

test('buildGraph не дублирует объявленного координатора, включая координатора по роли (0175)', () => {
  const byId = buildGraph([file('g.json', {
    version: 1, nodes: [{ id: 'coordinator', role: 'координатор', provider: 'p', model: 'm' }], edges: [],
  })]);
  assert.deepEqual(byId.graph.nodes.map((node) => node.id), ['coordinator']);
  assert.equal(byId.graph.nodes[0].implicit, undefined, 'объявленный узел не помечается неявным');

  const byRole = buildGraph([file('g.json', {
    version: 1, nodes: [{ id: 'lead', role: 'координатор структуры' }], edges: [],
  })]);
  assert.deepEqual(byRole.graph.nodes.map((node) => node.id), ['lead'], 'роль со словом «координатор» считается объявлением');
});

test('связь с неявным координатором действительна: он есть в графе до проверки рёбер (0175)', () => {
  const result = buildGraph([file('g.json', {
    version: 1,
    nodes: [{ id: 'worker-1', role: 'исполнитель', provider: 'p', model: 'm' }],
    edges: [{ from: 'coordinator', to: 'worker-1', kind: 'delegate' }],
  })]);
  assert.deepEqual(result.errors, [], 'координатор — не пустой конец ребра');
  assert.deepEqual(result.graph.edges.map((edge) => edge.from + '->' + edge.to), ['coordinator->worker-1'],
    'ребро сохранено как объявлено');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('GRAPH TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);