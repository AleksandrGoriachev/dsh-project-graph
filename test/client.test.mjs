/**
 * The client bundle is a classic browser module: it must load through the DSH
 * module loader, export apply/inject and register exactly one view.
 * Rendering needs the host React runtime, so this suite proves the wiring.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const near = (actual, expected, epsilon = 1e-6) => Math.abs(actual - expected) <= epsilon;

function loadBundle() {
  let registered = null;
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry; } } };
  const sandboxRequire = (id) => {
    /*
     * Панель объявляет границу ошибок классом (RenderGuard extends Component),
     * поэтому заглушке React нужен Component: иначе модуль падает до проверок.
     */
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

test('бандл регистрируется в загрузчике модулей', () => {
  const { entry } = loadBundle();
  assert.equal(entry.id, 'dsh-project-graph');
});

test('экспортирует apply и inject = ["slots"]', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.apply, 'function');
  assert.deepEqual(module.inject, ['slots']);
});

test('apply регистрирует вид в conversation.view', () => {
  const { module } = loadBundle();
  const calls = [];
  const ctx = {
    slots: {
      inject: (name, run) => { calls.push(['inject', name]); run(); },
      register: (descriptor, View) => { calls.push(['register', descriptor, View]); return () => {}; },
    },
  };
  module.apply(ctx);
  assert.deepEqual(calls[0], ['inject', 'conversation.view']);
  const register = calls.find((call) => call[0] === 'register');
  assert.ok(register);
  assert.equal(register[1].name, 'conversation.view');
  assert.equal(register[1].id, 'project-graph');
  assert.equal(typeof register[1].label(), 'string');
  assert.equal(typeof register[2], 'function');
});

test('apply подключает необязательную службу воркспейса', () => {
  const { module } = loadBundle();
  const injects = [];
  const ctx = {
    inject: (names, run) => { injects.push(names); run({ uiWorkspace: null }); },
    slots: {
      inject: (name, run) => { run(); },
      register: () => () => {},
    },
  };
  module.apply(ctx);
  assert.deepEqual(injects[0], ['uiWorkspace']);
});

test('пустой проект объясняет человеку, с чего начать', () => {
  for (const marker of [
    'В этом проекте ещё нет структуры',
    'Создайте папку',
    'Скопировать пример',
    'nodes — кто в проекте',
  ]) {
    assert.ok(source.includes(marker), 'нет текста: ' + marker);
  }
});

test('панель обмена объясняет неразрешённого участника, а не «0 писем»', () => {
  for (const marker of [
    'roots/participants',
    'ящик не читается',
    'data-exchange-warning',
    'renderExchangeWarnings',
    'folderUnresolvedWarnings',
    'data.warnings',
  ]) {
    assert.ok(source.includes(marker), 'нет текста: ' + marker);
  }
  assert.ok(/участник «/u.test(source), 'предупреждение называет метку участника');
  assert.ok(source.includes('cordis.patch.yml'), 'предупреждение несёт рецепт');
});

test('ошибки сопровождаются рецептом', () => {
  assert.ok(source.includes('Что сделать:'));
  assert.ok(source.includes('item.fix'));
  assert.ok(source.includes('EDGE_HELP'));
});

test('пустой проект предлагает иерархию и одноранговую структуру', () => {
  assert.ok(source.includes('Создать иерархическую'));
  assert.ok(source.includes('Создать одноранговую'));
  assert.ok(source.includes('Создать смешанную'));
  assert.ok(source.includes('Создать без оценщика'));
  assert.ok(source.includes('template=" + encodeURIComponent(template)'));
});

test('карточка узла добавляет связи, а удаляет их в «Настройках» (0122)', () => {
  const { module } = loadBundle();
  assert.ok(source.includes('/api/link'));
  assert.deepEqual(module.__bottomBarItems(), ['Связь', 'Запустить'], 'низ панели: связь и запуск');
  assert.ok(source.includes('window.confirm'));
  assert.ok(source.includes('submitLink'));
  assert.ok(source.includes('removeEditorLink'), 'связь удаляется из «Настроек» узла');
  assert.ok(source.includes('clipPath'), 'полоса роли должна обрезаться карточкой');
  assert.ok(source.includes('strokeWidth: active ? 3'), 'активная граница должна быть толще');
});

test('из сборки всегда есть выход назад к схеме', () => {
  assert.ok(source.includes('← К схеме'), 'нужна кнопка возврата к схеме');
  assert.ok(source.includes('function closeBuilder'), 'возврат должен быть одной функцией');
  assert.ok(source.includes('event.key === "Escape"'), 'Esc тоже должен возвращать к схеме');
  assert.ok(source.includes('несохранённые правки сборки при этом теряются'), 'человек должен знать цену возврата');
});

test('меню узла: окно с вкладками, внизу — связь и запуск (0122)', () => {
  const { module } = loadBundle();
  assert.ok(source.includes('data-bottom-bar'), 'у узла должна быть видимая нижняя панель');
  assert.deepEqual(module.__bottomBarItems(), ['Связь', 'Запустить'], 'внизу только два действия');
  assert.deepEqual(module.__nodeMenuLabels(), [], '0143: пунктов меню правой кнопки нет');
  assert.ok(source.includes('/api/node?root=" + encodeURIComponent(root) + "&action=update'), 'правка идёт своим действием');
  assert.ok(source.includes('project_graph_branch') && source.includes('project_graph_run'), 'вызовы названы по инструментам');
  assert.ok(source.includes('Узлы с расписанием хост'), 'человеку сказано, кто запускает по времени');
  assert.ok(source.includes('Ручной запуск панель не выполняет'), 'ручной запуск остаётся за моделью');
  assert.ok(source.includes('"aria-label": "глубина ветки"') && source.includes('"aria-label": "параллельность ветки"'));
});

test('узел добавляется прямо на схеме, без сборки', () => {
  assert.ok(source.includes('/api/node'), 'добавление узла идёт своим маршрутом');
  assert.ok(source.includes('Добавить узел'));
  assert.ok(source.includes('Новый узел'));
  assert.ok(source.includes('"aria-label": "id узла"'));
  assert.ok(source.includes('"aria-label": "модель узла"'));
  assert.ok(source.includes('без модели'), 'узел без модели допустим, но назван честно');
  assert.ok(source.includes('openAddNode') && source.includes('submitAddNode'));
});

test('сборщик: модели, узлы, связи, проверка и создание', () => {
  assert.ok(source.includes('Сборка структуры'));
  assert.ok(source.includes('Добавить модель'));
  assert.ok(source.includes('Добавить узел'));
  assert.ok(source.includes('Добавить связь'));
  assert.ok(source.includes('Проверка пройдена'));
  assert.ok(source.includes('runBuilderCheck'));
  assert.ok(source.includes('submitBuilder'));
  assert.ok(source.includes('ids.includes(edgeForm.from)'), 'видимый from должен попадать в связь');
  assert.ok(source.includes('"aria-label": "from"'));
  assert.ok(source.includes('/api/models'));
  assert.ok(source.includes('/api/presets'));
  assert.ok(source.includes('Пресет — это состав агента'));
  assert.ok(source.includes('\"aria-label\": \"пресет\"'));
  assert.ok(source.includes('editBuilderNode'));
  assert.ok(source.includes('editBuilderModel'));
  assert.ok(source.includes('Сохранить узел'));
  assert.ok(source.includes('Сохранить модель'));
  assert.ok(source.includes('data-model'));
  assert.ok(source.includes('"aria-label": "provider"'));
  assert.ok(source.includes('Загружаю модели'));
});

test('сборка отправляет прямые поля узлов, а не алиас (0061)', () => {
  const { module } = loadBundle();
  const draft = module.__builderDraft({
    version: 1,
    models: {
      work: { provider: 'p1', model: 'm1', family: 'f1' },
      critic: { provider: 'p1', model: 'm2' },
    },
    nodes: [
      { id: 'a', role: 'lead', model: 'work', brief: 'план' },
      { id: 'b', role: 'dev', model: '', brief: '' },
      { id: 'c', role: 'acceptor', model: 'ghost' },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'delegate' }],
  });
  assert.equal(draft.models, undefined, 'models{} в черновик не попадает');
  assert.deepEqual(draft.nodes[0],
    { id: 'a', role: 'lead', provider: 'p1', model: 'm1', family: 'f1', brief: 'план' },
    'алиас развёрнут в прямые provider/model/family');
  assert.deepEqual(draft.nodes[1], { id: 'b', role: 'dev' },
    'узел без модели остаётся без модели: первая модель не подставляется');
  assert.deepEqual(draft.nodes[2], { id: 'c', role: 'acceptor', model: 'ghost' },
    'неизвестный алиас не подменяется первой моделью');
  assert.deepEqual(draft.edges, [{ from: 'a', to: 'b', kind: 'delegate' }]);
  assert.ok(source.includes('JSON.stringify(builderDraft(builder))'),
    'проверка и сборка отправляют прямые поля');
});

test('состояние узла: работает, завершил, ошибка', () => {
  const { module } = loadBundle();
  const running = module.__nodeState({ active: true, run: null, activityKnown: true });
  assert.equal(running.word, 'работает');
  assert.equal(running.key, 'running');

  /* Запуск записан, но каталог ещё не подтвердил ребёнка — узел всё равно занят. */
  const queued = module.__nodeState({ active: false, run: { state: 'running' }, activityKnown: true });
  assert.equal(queued.key, 'running');

  const done = module.__nodeState({ active: false, run: { state: 'done', finishedAt: Date.now() }, activityKnown: true });
  assert.equal(done.word, 'завершил');

  const failed = module.__nodeState({ active: false, run: { state: 'error', message: 'провайдер отказал' }, activityKnown: true });
  assert.equal(failed.word, 'ошибка');
  assert.match(failed.hint, /провайдер отказал/);
});

test('состояние узла: «нет данных» вместо «свободен», пока активность не получена', () => {
  const { module } = loadBundle();
  const unknown = module.__nodeState({ active: false, run: null, activityKnown: false });
  assert.equal(unknown.word, 'нет данных');
  assert.notEqual(unknown.key, 'idle');
  const idle = module.__nodeState({ active: false, run: null, activityKnown: true });
  assert.equal(idle.word, 'свободен');
});

test('подробности узла называют состояние словами и что делать', () => {
  const { module } = loadBundle();
  const idle = module.__stateSentence(module.__nodeState({ active: false, run: null, activityKnown: true }), null, '');
  assert.match(idle, /никто не работает/);
  assert.match(idle, /project_graph_run|project_graph_spawn/, 'у состояния должно быть действие');
  const done = module.__stateSentence(module.__nodeState({ active: false, run: { state: 'done' }, activityKnown: true }), { state: 'done' }, '16:55');
  assert.match(done, /16:55/);
});

test('слово состояния стоит на карточке, а не только в подсказке', () => {
  assert.ok(source.includes('fill: state.color, fontSize: 10'), 'состояние должно быть текстом на карточке');
  assert.ok(source.includes('"aria-label": node.id + ", " + state.word'), 'состояние должно быть в aria-label');
  assert.ok(source.includes('exports.__nodeState = nodeState'));
});

test('вид связи «возврат» объяснён и доступен в панели', () => {
  assert.ok(source.includes('report: "возврат: цель принимает результат источника без оценки"'),
    'легенда объясняет возврат человеческим языком');
  assert.ok(source.includes('"report — возврат"'), 'в выборе связи есть возврат');
  assert.ok(source.includes('returned.has(id)'), 'полнота иерархии учитывает возврат корню');
  assert.ok(source.includes('ни оценки, ни возврата корню'), 'предупреждение называет оба пути');
  assert.ok(source.includes('pg-arrow-report'), 'у возврата своя стрелка, а не delegate');
  assert.ok(source.includes('report: "возврат"') || source.includes('h("option", { value: "report" }, "report")'),
    'сборщик тоже умеет возврат');
});

test('полоса Workflow не предлагает установку и обновление из панели', () => {
  assert.ok(!source.includes('"Обновить оба слоя"'), 'нерабочей кнопки обновления нет');
  assert.ok(!source.includes('"Установить Workflow"'), 'нерабочей кнопки установки нет');
  assert.ok(source.includes('Обновление из панели недоступно'), 'вместо кнопки — прямая рекомендация');
  assert.ok(source.includes('через интерфейс самого workflow'), 'назван рабочий путь обновления');
  assert.ok(source.includes('плагин не установлен'), 'отсутствие плагина объясняется, а не кнопкой');
  assert.ok(source.includes('renderWorkflowStrip'), 'состояние Workflow стоит отдельной полосой');
  assert.ok(source.includes('"уже установлено — версия из проверки Workflow"'), 'человеку сказано, что уже стоит');
});
test('проверка актуальности предлагает обновление только когда сборка устарела', () => {
  assert.ok(source.includes('"Проверить актуальность"'), 'есть проверка сборки');
  assert.ok(source.includes('/api/workflow-check'), 'проверка идёт на свой маршрут');
  assert.ok(!source.includes('"Обновить оба слоя"'), 'нерабочего обновления из панели нет');
  assert.ok(source.includes('Обновление из панели недоступно'), 'вместо него — рекомендация обновиться через workflow');
  assert.ok(source.includes('сборка устарела'), 'человеку видно, что именно отстало');
  assert.ok(source.includes('сборка актуальна'), 'когда всё свежее — просто информация');
  assert.ok(source.includes('Обновить Workflow — оба слоя?'), 'перед обновлением человек видит, что будет');
});

test('работающая сессия видна на графе как объявленный узел', () => {
  assert.ok(source.includes('selfRunning'), 'панель знает, работает ли сессия');
  assert.ok(source.includes('payload.selfNode'), 'узел сессии объявлен конфигом, а не угадан');
  assert.ok(source.includes('эта сессия сейчас выполняет работу'), 'человеку сказано, кто именно работает');
});

test('внешняя связь показывается фактами, без текстов сообщений', () => {
  assert.ok(source.includes('Внешняя связь'), 'у обмена есть свой блок');
  assert.ok(source.includes('исходящая односторонняя'), 'направление названо словами');
  assert.ok(source.includes('двусторонняя'), 'двусторонность названа');
  assert.ok(source.includes('/api/exchange'), 'факты берутся с сервера');
  assert.ok(source.includes('тексты не читаются'), 'пользователю сказано, что текстов нет');
  assert.ok(source.includes('Сообщения ('), 'по клику открывается список фактов');
});

test('полоса Workflow различает обновление плагина и развёртывание движка', () => {
  assert.ok(source.includes('"Развернуть"'), 'есть действие «Развернуть»');
  assert.ok(source.includes('/workflow/api/deploy'), 'зовёт маршрут развёртывания движка');
  assert.ok(source.includes('движок не развёрнут'), 'видно, что движка в проекте нет');
  assert.ok(source.includes('payload.engine'), 'состояние движка приходит с сервера, а не угадывается');
  assert.ok(source.includes('Обновление из панели недоступно'), 'обновление не предлагается, а объясняется');
  assert.ok(source.includes('Развернуть движок Workflow в этом воркспейсе?'), 'перед записью человек видит вопрос');
});

test('карточка узла показывает шаги ветки и хранит историю', () => {
  assert.ok(source.includes('Ветка'), 'у ветки должна быть своя строка');
  assert.ok(source.includes('branchSteps'), 'шаги собираются по branchId');
  assert.ok(source.includes('runList'), 'панель держит всю историю, а не только последний запуск');
  assert.ok(source.includes('шаги одного запуска project_graph_branch'), 'человеку объяснено, что такое ветка');
});

test('карточка workflow предлагает установку и объясняет её исходы', () => {
  assert.ok(source.includes('/api/workflow-install'), 'кнопка идёт своим маршрутом');
  assert.ok(source.includes('installSpec'), 'спека приходит из /api/status, а не выдумывается');
  assert.ok(source.includes('"Установить"'));
  assert.ok(source.includes('Устанавливаю…'));
  assert.ok(source.includes('Плагин установлен, но нужен перезапуск DSH'));
  assert.ok(source.includes('Установка не удалась'));
  assert.ok(source.includes('?root=" + encodeURIComponent(root)'), 'статус спрашивают по корню проекта');
  assert.ok(source.includes('!body || !body.plugin || !body.plugin.name'), 'установленность — по plugin.name, не по коду 200');
});

test('workflowFit: полная иерархия и непокрытый исполнитель', () => {
  const { module } = loadBundle();
  const classic = module.__workflowFit({
    nodes: [{ id: 'arch' }, { id: 'exec' }, { id: 'judge' }],
    edges: [{ from: 'arch', to: 'exec', kind: 'delegate' }, { from: 'exec', to: 'judge', kind: 'review' }],
  });
  assert.equal(classic.applicable, true);
  assert.deepEqual(classic.issues, []);
  assert.equal(classic.root, 'arch');

  const partial = module.__workflowFit({
    nodes: [{ id: 'coordinator' }, { id: 'worker' }, { id: 'designer' }, { id: 'judge' }],
    edges: [
      { from: 'coordinator', to: 'worker', kind: 'delegate' },
      { from: 'coordinator', to: 'designer', kind: 'delegate' },
      { from: 'worker', to: 'judge', kind: 'review' },
    ],
  });
  assert.equal(partial.applicable, true);
  assert.deepEqual(partial.uncovered, ['designer']);
  assert.match(partial.issues.join(' '), /designer/);
});

test('иерархия предлагает workflow-плагин, если его нет', () => {
  assert.ok(source.includes('/workflow/api/status'));
  assert.ok(source.includes('https://github.com/AleksandrGoriachev/subagent-workflow'));
  assert.ok(source.includes('Создать без плагина'));
  assert.ok(source.includes('startHierarchy'));
  assert.ok(source.includes('workflowFit'));
});

test('активный узел: рамка 3px и состояние «работает»', () => {
  assert.ok(source.includes('activeNodeIds'));
  assert.ok(source.includes('subagentCatalog'));
  assert.ok(source.includes('strokeWidth: active ? 3'));
  assert.ok(source.includes('агент этого узла выполняет работу сейчас'));
});

test('карточка узла с расписанием показывает следующий запуск рядом с состоянием', () => {
  assert.ok(source.includes('следующий запуск'), 'время следующего запуска — на карточке, а не только в подсказке');
  assert.ok(source.includes('◷ следующий запуск '), 'вид повторяет утверждённый макет');
  assert.ok(source.includes('расписание: выкл'), 'узел без расписания честно говорит, что не запускается сам');
  assert.ok(source.includes('scheduleMoment'), 'время форматируется в объявленном поясе');
  assert.ok(source.includes('scheduleInfo.daily') || source.includes('entry.daily'), 'каденция берётся из схемы');
  assert.ok(source.includes('payload.schedule'), 'расписание приходит из ответа графа');
  assert.ok(source.includes('y: 61, fill: T.tertiary, fontSize: 9'), 'строка расписания стоит под состоянием');
});

test('ручной выбор проекта не перебивается автосинхронизацией', () => {
  assert.ok(source.includes('userPickedRef'), 'есть признак ручного выбора');
  assert.ok(source.includes('if (userPickedRef.current) return;'), 'sync уважает ручной выбор');
});

test('панель догоняет воркспейс, пришедший после монтирования', () => {
  assert.ok(source.includes('selection.getSnapshot'), 'есть резерв по сохранённой сессии');
  assert.ok(source.includes('rootRef'), 'панель сравнивает текущий корень');
  assert.ok(source.includes('samePath(rootRef.current, workspace.path)'), 'переключение на воркспейс сессии');
});

test('клиент пишет только стартовую структуру и связи, через POST', () => {
  assert.ok(!source.includes('"PUT"'), 'клиент не должен использовать PUT');
  assert.ok(!source.includes('"DELETE"'), 'клиент не должен использовать DELETE');
  const posts = source.split('method: "POST"').length - 1;
  assert.equal(posts, 27, 'POST — структура, связи, узел из палитры, правка и удаление узла, расписание (в форме «Настроек»), связи редактора, workflow, обновление релиза структуры, раскладка, привязка сессии, участники обмена, проверка, сборка, сохранение и сброс раскладки, папка обмена: add, update, contract, remove и квитанция accept, а также закрытие заявки ack-письмом');
  assert.ok(source.includes('/api/exchange/close'), 'заявка закрывается своим маршрутом');
  assert.ok(source.includes('/api/init?root='), 'POST должен идти на /api/init');
  assert.ok(source.includes('/api/link?root='), 'POST должен идти на /api/link');
  assert.ok(source.includes('/api/node?root='), 'POST должен идти на /api/node');
  assert.ok(source.includes('/api/check?root='), 'POST должен идти на /api/check');
  assert.ok(source.includes('/api/build?root='), 'POST должен идти на /api/build');
  assert.ok(source.includes('/api/layout'), 'раскладка сохраняется своим маршрутом');
  assert.ok(source.includes('/api/schedule'), 'время запуска сохраняется своим маршрутом');
  assert.ok(source.includes('/api/session'), 'привязка к сессии сохраняется своим маршрутом');
  assert.ok(source.includes('/api/exchange-participants'), 'участники обмена сохраняются своим маршрутом');
  assert.ok(source.includes('/api/release/update'), 'обновление релиза структуры идёт своим маршрутом');
  assert.ok(source.includes('Создать структуру'));
});

test('клавиатура двигает узел: 8 px, Shift — 1 px, из нуля не уходит', () => {
  const { module } = loadBundle();
  assert.deepEqual(module.__keyboardMove({ x: 100, y: 100 }, 'ArrowRight', false), { x: 108, y: 100 });
  assert.deepEqual(module.__keyboardMove({ x: 100, y: 100 }, 'ArrowLeft', false), { x: 92, y: 100 });
  assert.deepEqual(module.__keyboardMove({ x: 100, y: 100 }, 'ArrowDown', false), { x: 100, y: 108 });
  assert.deepEqual(module.__keyboardMove({ x: 100, y: 100 }, 'ArrowUp', false), { x: 100, y: 92 });
  assert.deepEqual(module.__keyboardMove({ x: 100, y: 100 }, 'ArrowRight', true), { x: 101, y: 100 },
    'Shift двигает на 1 px');
  assert.deepEqual(module.__keyboardMove({ x: 0, y: 0 }, 'ArrowLeft', false), { x: 0, y: 0 },
    'отрицательных координат в схеме нет');
  assert.equal(module.__keyboardMove({ x: 5, y: 5 }, 'Enter', false), null, 'остальные клавиши не двигают');
});

test('движение и сохранение раскладки живут в клиенте, а не в браузере', () => {
  for (const needle of [
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'aria-live', 'tabIndex: 0', '/api/layout', '}, 400);',
    'Сбросить схему', 'onPointerDown', 'scheduleLayoutSave', 'flushLayoutSave',
    'canvasNodes', 'data-edge', 'saveLayoutPositions',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  assert.ok(source.includes('handleNodeBlur'), 'уход фокуса сохраняет позицию');
  /*
   * Задание 0097: браузер хранит только место на экране — свёрнута ли палитра
   * и какой просвет у барьера, — и только под одним ключом
   * dsh.project-graph.ui.v1, внутри uiStore, где и чтение, и запись обёрнуты
   * try/catch (макет §6, вариант A). Раскладка (x/y) по-прежнему живёт в
   * structure/*.json: запись раскладки в браузер запрещена, как и второе
   * хранилище панели.
   */
  assert.equal(source.split('"dsh.project-graph.ui.v1"').length - 1, 1,
    'ключ состояния панели объявлен ровно один раз');
  const uiStart = source.indexOf('const uiStore = {');
  const uiEnd = uiStart === -1 ? -1 : source.indexOf('\n    };', uiStart);
  assert.ok(uiStart > 0 && uiEnd > uiStart, 'состояние панели живёт в одном uiStore');
  const uiBlock = source.slice(uiStart, uiEnd);
  for (const match of source.matchAll(/localStorage/gu)) {
    assert.ok(match.index > uiStart && match.index < uiEnd,
      'хранилище панели вне uiStore: ' + source.slice(Math.max(0, match.index - 70), match.index + 70));
  }
  assert.ok(uiBlock.includes('catch ('), 'недоступное хранилище ловится, а не роняет панель');
  assert.ok(!uiBlock.includes('/api/layout'), 'раскладка не идёт через хранилище панели');
  const layoutSaveStart = source.indexOf('function saveLayoutPositions');
  const layoutSaveEnd = source.indexOf('\n        function ', layoutSaveStart + 10);
  const layoutSaveBody = source.slice(layoutSaveStart, layoutSaveEnd === -1 ? source.length : layoutSaveEnd);
  assert.ok(layoutSaveStart > 0 && layoutSaveBody.includes('/api/layout'), 'раскладка пишется своим маршрутом');
  assert.ok(!layoutSaveBody.includes('localStorage'), 'раскладка не пишется в браузер');
});

test('связь тянется за узлом: обе точки считаются от сторон карточек', () => {
  const { module } = loadBundle();
  const edges = [{ from: 'a', to: 'b', kind: 'delegate' }];
  const boxes = new Map([
    ['a', { id: 'a', x: 0, y: 0, w: 176, h: 62 }],
    ['b', { id: 'b', x: 0, y: 158, w: 176, h: 62 }],
  ]);
  const before = module.__edgeSegments(boxes, edges)[0];
  assert.equal(before.x1, 88, 'центр нижней стороны верхней карточки');
  assert.equal(before.y1, 62);
  assert.equal(before.x2, 88, 'центр верхней стороны нижней карточки');
  assert.equal(before.y2, 158);

  const moved = new Map(boxes);
  moved.set('a', { ...boxes.get('a'), x: 240, y: 300 });
  const after = module.__edgeSegments(moved, edges)[0];
  assert.equal(after.y1, 300, 'линия начинается у верхней стороны перемещённой карточки, а не у старой точки');
  assert.ok(near(after.x1, 275.6056338028169), 'точка на стороне по лучу центр→центр: ' + after.x1);
  assert.equal(after.y2, 158 + 62, 'нижняя карточка стала выше: линия идёт к её нижней стороне');
  assert.ok(near(after.x2, 140.3943661971831), 'вторая точка тоже на луче, а не в середине стороны: ' + after.x2);

  const pair = module.__edgeSegments(boxes, [
    { from: 'a', to: 'b', kind: 'delegate' },
    { from: 'b', to: 'a', kind: 'report' },
  ]);
  assert.equal(pair.length, 2);
  assert.ok(Math.abs(pair[0].x1 - pair[1].x1) >= 8, 'парные связи не ложатся друг на друга');
});

test('edgeSegments выбирает боковую сторону, а сдвиг пары двигает обе точки', () => {
  const { module } = loadBundle();
  const sideways = new Map([
    ['a', { id: 'a', x: 0, y: 0, w: 176, h: 62 }],
    ['b', { id: 'b', x: 300, y: 0, w: 176, h: 62 }],
  ]);
  assert.deepEqual(module.__nearestAnchor(sideways.get('a'), sideways.get('b')), { x: 176, y: 31 },
    'точка на ближайшей к соседу стороне');

  const [line] = module.__edgeSegments(sideways, [{ from: 'a', to: 'b', kind: 'delegate' }]);
  assert.deepEqual([line.x1, line.y1, line.x2, line.y2], [176, 31, 300, 31],
    'боковые карточки соединяются правой и левой сторонами');

  const reversed = module.__edgeSegments(sideways, [{ from: 'b', to: 'a', kind: 'delegate' }])[0];
  assert.deepEqual([reversed.x1, reversed.y1, reversed.x2, reversed.y2], [300, 31, 176, 31],
    'направление ребра не меняет стороны: их выбирают карточки');

  const pair = module.__edgeSegments(sideways, [
    { from: 'a', to: 'b', kind: 'delegate' },
    { from: 'b', to: 'a', kind: 'report' },
  ]);
  assert.deepEqual(pair.map((item) => item.y1), [31 - 4.5, 31 + 4.5], 'сдвиг пары перпендикулярен оси');
  assert.deepEqual(pair.map((item) => item.y2), [31 - 4.5, 31 + 4.5], 'обе точки сдвинуты одним нормалем');
  assert.deepEqual(pair.map((item) => item.x1), [176, 300], 'каждая точка осталась на своей боковой стороне');
});

test('живой маршрут: узлы и неизвестная роль разбираются без догадок', () => {
  const { module } = loadBundle();
  assert.deepEqual(module.__liveView({ active: ['judge', 'worker'], unknown: ['a1'] }),
    { active: ['judge', 'worker'], unknown: 1, bySession: 0, unattributed: [] });
  assert.deepEqual(module.__liveView({ active: ['judge', 'judge'], unknown: ['a1', 'a2'] }),
    { active: ['judge'], unknown: 2, bySession: 0, unattributed: [] }, 'узел не дублируется, агенты считаются все');
  assert.deepEqual(module.__liveView(null), { active: [], unknown: 0, bySession: 0, unattributed: [] });
  assert.deepEqual(module.__liveView({ active: 'judge', unknown: 'a1' }),
    { active: [], unknown: 0, bySession: 0, unattributed: [] }, 'битый ответ не превращается в активность');
  assert.deepEqual(module.__liveView({ reason: 'служба недоступна', agents: [] }),
    { active: [], unknown: 0, bySession: 0, unattributed: [] });
  assert.deepEqual(module.__liveView({ active: [], unknown: [], sessions: { running: 2 } }),
    { active: [], unknown: 2, bySession: 2, unattributed: [] }, 'старый ответ: активность по сессиям считается без роли');
});

test('«вне структуры»: привязанные сессии не считаются, непривязанные — с меткой (задание 0089)', () => {
  const { module } = loadBundle();
  /*
   * На живом хосте 05.11 (13:22) две работающие сессии были привязаны к узлам
   * (binding auto → coordinator, childId запуска → worker), а панель складывала
   * ВСЕ sessions.running в «роль не объявлена: 2». Теперь маршрут называет
   * непривязанные отдельно, и sessions.running больше не прибавляется.
   */
  const boundOnly = module.__liveView({
    active: ['coordinator', 'worker'],
    unknown: [],
    sessions: { running: 2, items: [] },
    unattributed: [],
  });
  assert.equal(boundOnly.unknown, 0, 'привязанные сессии — не «вне структуры»');
  assert.deepEqual(boundOnly.active, ['coordinator', 'worker']);

  const mixed = module.__liveView({
    active: [],
    unknown: ['agent-x'],
    sessions: { running: 3, items: [] },
    unattributed: [{ id: 'session-y', at: 1, label: 'исполнитель' }],
  });
  assert.equal(mixed.unknown, 2, 'вне структуры = агент без роли + непривязанная сессия');
  assert.deepEqual(mixed.unattributed, [{ id: 'session-y', at: 1, label: 'исполнитель' }],
    'непривязанная сессия отдаётся панели с меткой');

  const legacy = module.__liveView({ active: [], unknown: [], sessions: { running: 2, items: [] } });
  assert.equal(legacy.unknown, 2, 'старый ответ хоста без unattributed считается как раньше');
  assert.deepEqual(legacy.unattributed, [], 'старому ответу непривязанных сессий не выдумывают');

  const broken = module.__liveView({
    active: [],
    unknown: [],
    sessions: { running: 1 },
    unattributed: [null, 42, {}, { id: '' }, { id: 'session-z', label: 7 }],
  });
  assert.deepEqual(broken.unattributed, [{ id: 'session-z', at: null, label: '' }],
    'битые строки непривязанных пропускаются, метка не выдумывается');
  assert.equal(broken.unknown, 1);
});

test('источник активности: маршрут называет, панель не догадывается', () => {
  const { module } = loadBundle();
  assert.deepEqual(module.__activitySources({ active: ['a'], activityByNode: { a: 'session', b: 'agent' } }),
    { a: 'session', b: 'agent' }, 'источник берётся из ответа маршрута');
  assert.deepEqual(module.__activitySources({ active: ['a'] }), { a: 'agent' },
    'старый ответ без источника означает живого агента');
  assert.deepEqual(module.__activitySources({ activityByNode: { a: 'session' } }), { a: 'session' });
  assert.deepEqual(module.__activitySources({ active: ['a'], activityByNode: { a: 'bogus' } }), { a: 'agent' },
    'неизвестный источник не выдумывает сессию');
  assert.deepEqual(module.__activitySources(null), {});
});

test('узел называет источник активности: живой агент или журнал сессии', () => {
  const { module } = loadBundle();
  const journal = module.__nodeState({ active: true, source: 'session', activityKnown: true });
  assert.equal(journal.key, 'running');
  assert.match(journal.word, /по журналу/, 'на карточке написано «по журналу»');
  assert.equal(journal.sourceWord, 'по журналу сессии');
  assert.doesNotMatch(journal.hint, /агент этого узла/, 'сессия не выдаётся за агента');
  assert.doesNotMatch(module.__stateSentence(journal, null, ''), /живой агент|агент этого узла/,
    'подробности не называют сессию агентом');

  const agent = module.__nodeState({ active: true, source: 'agent', activityKnown: true });
  assert.equal(agent.word, 'работает', 'поведение живого агента не изменилось');
  assert.equal(agent.sourceWord, 'живой агент');
  assert.match(agent.hint, /агент этого узла/);

  const plain = module.__nodeState({ active: true, activityKnown: true });
  assert.equal(plain.word, 'работает');
  assert.equal(plain.source, undefined, 'без источника панель не выдумывает его');
  assert.ok(source.includes('по журналу') && source.includes('живой агент'), 'оба источника названы в бандле');
});

test('узел с активным запуском говорит «выполняется» отдельно от агента и сессии (задание 0059)', () => {
  const { module } = loadBundle();
  const since = Date.parse('2026-11-04T01:10:00+03:00');
  const running = module.__nodeState({
    active: true, source: 'run', run: { state: 'running', since }, activityKnown: true,
  });
  assert.equal(running.key, 'running');
  assert.equal(running.word, 'выполняется', 'работающий узел назван словом «выполняется»');
  assert.equal(running.sourceWord, 'журнал запусков — узел запущен');
  assert.match(running.hint, /запуск/);

  const sentence = module.__stateSentence(running, { state: 'running', since }, '');
  assert.match(sentence, /выполняется/);
  assert.match(sentence, /\d{2}:\d{2}/, 'время старта запуска названо');
  assert.doesNotMatch(sentence, /агент этого узла/, 'запуск не выдаётся за живого агента');

  /* Без записи о запуске слово остаётся, время не выдумывается. */
  const bare = module.__nodeState({ active: true, source: 'run', run: null, activityKnown: true });
  assert.equal(bare.word, 'выполняется');
  assert.doesNotMatch(bare.hint, /\d{2}:\d{2}/, 'времени старта нет — и оно не выдумано');

  assert.deepEqual(module.__activitySources({ active: ['w'], activityByNode: { w: 'run' } }), { w: 'run' },
    'источник run берётся из ответа маршрута');
  assert.ok(source.includes('Источник активности'), 'в карточке есть строка «Источник активности»');
  assert.ok(source.includes('журнал запусков'), 'источник назван словами «журнал запусков»');
});

test('обмен читается автоматически: опрос папки на таймере', () => {
  assert.ok(source.includes('/api/exchange?root='), 'маршрут фактов обмена');
  assert.ok(source.includes('setInterval(tick, 10000)'), 'опрос обмена раз в 10 секунд');
  assert.ok(source.includes('в папке обмена новое сообщение'), 'новое письмо называется словами');
});

test('участники папки обмена редактируются из редактора', () => {
  assert.ok(source.includes('/api/exchange-participants'), 'есть маршрут участников');
  assert.ok(source.includes('Сохранить участников'), 'кнопка называет действие');
  assert.ok(source.includes('toggleParticipant'), 'выбор участника меняет черновик');
});

test('критик без расписания всё равно получает поле времени', () => {
  assert.ok(source.includes('looksCritic'), 'карточка распознаёт критика без расписания');
  assert.ok(source.includes('не задано — узел не запускается сам'), 'подпись объясняет, что расписания нет');
});

test('0195: тестировщик показывает расписание в настройках, по умолчанию 04:00', () => {
  assert.ok(source.includes('looksTester'), 'редактор распознаёт тестировщика без расписания');
  assert.ok(source.includes('looksTester ? "04:00" : "09:00"'), 'умолчание тестировщика — 04:00, критика — прежнее');
  const { module } = loadBundle();
  const draft = module.__nodeScheduleDraft({ id: 'tester-1', role: 'тестировщик' });
  assert.equal(draft.withSchedule, true, 'расписание показывается тестировщику');
  assert.equal(draft.at, '04:00', 'без объявленного времени подставлено 04:00');
  assert.equal(draft.timeZone, 'Europe/Moscow');
  const declared = module.__nodeScheduleDraft({
    id: 'tester-1', role: 'тестировщик', schedule: { at: '05:15', timeZone: 'Asia/Tokyo' },
  });
  assert.equal(declared.at, '05:15', 'время человека важнее умолчания');
  assert.equal(declared.timeZone, 'Asia/Tokyo', 'пояс человека сохранён');
  const worker = module.__nodeScheduleDraft({ id: 'worker-1', role: 'исполнитель' });
  assert.equal(worker.withSchedule, false, 'воркеру расписание не навязывается');
  assert.equal(worker.at, '09:00', 'умолчание прочих узлов не изменилось');
  const critic = module.__nodeScheduleDraft({ id: 'critic', role: 'критик' });
  assert.equal(critic.withSchedule, true, 'критик по-прежнему с расписанием');
  assert.equal(critic.at, '09:00', 'умолчание критика не изменилось');
  assert.ok(source.includes('/api/schedule'), 'сохранение времени по-прежнему через /api/schedule');
});

test('время запуска узла с расписанием правится на вкладке «Настройки» (0122)', () => {
  assert.ok(source.includes('/api/schedule'), 'есть маршрут сохранения времени');
  assert.ok(source.includes('"время запуска в редакторе"'), 'поле времени подписано для проверки');
  assert.ok(source.includes('type: "time"'), 'поле — именно время, а не свободный текст');
  const start = source.indexOf('function renderNodeEditModal()');
  const end = source.indexOf('\n        function ', start + 10);
  const body = source.slice(start, end === -1 ? source.length : end);
  assert.ok(body.includes('withSchedule') && body.includes('nodeEditor.at'), 'расписание живёт в форме настроек');
});

test('клиент опрашивает /api/live раз в 5 секунд и честен про роль', () => {
  assert.ok(source.includes('/api/live?root='), 'живой маршрут спрашивают по корню проекта');
  assert.ok(source.includes('setInterval(tick, 5000)'), 'опрос идёт раз в 5 секунд');
  assert.ok(source.includes('clearInterval(timer)'), 'таймер снимается при смене корня');
  assert.ok(source.includes('const view = liveView(body)'), 'ответ разбирается одной чистой функцией');
  assert.ok(source.includes('setLiveNodes(new Set(view.active))'), 'живые узлы попадают в состояние');
  assert.ok(source.includes('setLiveUnknown(view.unknown)'), 'счётчик неизвестной роли попадает в состояние');
  assert.ok(source.includes('for (const id of liveNodes) next.add(id)'), 'живые узлы складываются с остальной активностью');
  assert.ok(source.includes('"вне структуры: " + liveUnknown'),
    'строка «вне структуры» стоит в панели и называет счётчик');
  assert.ok(source.includes('data-unattributed-bind'),
    'у непривязанной сессии есть действие «привязать к узлу»');
  assert.ok(source.includes('data-live-outside'),
    'блок «вне структуры» отмечен для проверки рендером');
  assert.ok(source.includes('функция liveView') || source.includes('function liveView'), 'разбор ответа вынесен в функцию');
});

test('сломанный живой маршрут молчит и не рисует активность', () => {
  const start = source.indexOf('fetchJson("/api/live?root="');
  assert.ok(start >= 0, 'клиент не спрашивает /api/live');
  const tail = source.slice(start, start + 1200);
  assert.match(tail, /\.catch\(\(\) => \{/, 'ошибка маршрута перехватывается');
  assert.ok(tail.includes('setLiveNodes(new Set())'), 'ошибка очищает живые узлы');
  assert.ok(tail.includes('setLiveUnknown(0)'), 'ошибка очищает счётчик неизвестной роли');
  assert.ok(!/setError\(/.test(tail), 'ошибка живого маршрута не поднимается в общую ошибку панели');
});

test('портал «Выход вне» стоит за границей и называет адресатов', () => {
  for (const needle of [
    'function renderPortal',
    'function renderPortalConnector',
    'function renderWorkspaceBorder',
    'PORTAL_W = 236',
    'PORTAL_GAP = 48',
    '"data-portal": "exit"',
    '"data-portal-line"',
    '"data-portal-from"',
    '"data-workspace-border"',
    'Выход вне',
    'двусторонняя',
    '↗ ',
    '↙ ',
    'вх. ',
    'исх. ',
    'источник: coordination',
    'не разобрано: ',
    'ещё ',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
});

test('портал доступен с клавиатуры и открывает существующий список', () => {
  for (const needle of [
    'tabIndex: 0',
    'role: "button"',
    'portalAria',
    '"aria-label": portalAria(rows)',
    '"aria-expanded"',
    '"aria-controls": "pg-exchange-card"',
    'handlePortalKey',
    'event.key === "Enter"',
    'event.key === " "',
    'openExchangeFromPortal',
    'id: "pg-exchange-card"',
    'tabIndex: -1',
    'exchangeCardRef',
    'setPortalFocus(true)',
    'portalHot || portalFocus',
    'scrollIntoView',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  /* Esc закрывает список и возвращает фокус порталу — одной веткой. */
  const esc = source.slice(source.indexOf('список фактов обмена закрыт, фокус вернулся порталу'));
  assert.ok(esc.length > 0, 'Esc не объявляет возврат фокуса');
  const start = source.indexOf('if (!event || event.key !== "Escape") return;');
  assert.ok(start >= 0, 'Esc не перехватывается');
  const tail = source.slice(start, start + 420);
  assert.ok(tail.includes('setExchangeOpen(null)'), 'Esc закрывает список');
  assert.ok(tail.includes('portal.focus()'), 'Esc возвращает фокус порталу');
});

test('пустой портал остаётся на месте с причиной и рецептом exchange', () => {
  for (const needle of [
    'portalEmptyLines',
    'обмена нет',
    'Задайте exchange в cordis.patch.yml.',
    'exchange.me или participants',
    'папка coordination рядом с воркспейсом не найдена',
  ]) {
    assert.ok(source.includes(needle), 'в пустом состоянии нет: ' + needle);
  }
});

test('portalLatest: наконечник по последнему факту, при равенстве — входящее', () => {
  const { module } = loadBundle();
  const links = [
    { counterpart: 'workflow', kind: 'two-way', lastIncoming: 100, lastOutgoing: 90 },
    { counterpart: 'kb-core', kind: 'outgoing', lastIncoming: null, lastOutgoing: 120 },
  ];
  const latest = module.__portalLatest(links);
  assert.equal(latest.direction, 'outgoing', 'последний по времени факт — исходящий');
  assert.equal(latest.counterpart, 'kb-core');
  assert.equal(latest.at, 120);

  const tie = module.__portalLatest([{ counterpart: 'workflow', kind: 'two-way', lastIncoming: 120, lastOutgoing: 120 }]);
  assert.equal(tie.direction, 'incoming', 'при равном времени честнее входящее');

  const onlyIncoming = module.__portalLatest([{ counterpart: 'workflow', kind: 'incoming', lastIncoming: 42 }]);
  assert.equal(onlyIncoming.direction, 'incoming');
  assert.equal(module.__portalLatest([{ counterpart: 'workflow', kind: 'incoming' }]), null, 'без времени факта нет');
  assert.equal(module.__portalLatest(null), null);
});

test('portalRows: три адресата на канве, остальные — «ещё N»', () => {
  const { module } = loadBundle();
  const links = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ counterpart: name, kind: 'two-way', outgoing: 1, incoming: 2 }));
  const view = module.__portalRows(links);
  assert.deepEqual(view.rows.map((row) => row.counterpart), ['a', 'b', 'c'], 'на канве не больше трёх строк');
  assert.equal(view.more, 2, 'остальные считаются для «ещё N»');
  assert.equal(view.total, 5);
  assert.equal(module.__portalRows([]).more, 0);
  assert.equal(module.__portalRows(null).total, 0);
});

test('portalStart: линия от узла self, без self — от границы', () => {
  const { module } = loadBundle();
  const box = { id: 'coordinator', x: 120, y: 0, w: 176, h: 62 };
  const start = module.__portalStart(box, 400, 120);
  assert.equal(start.x, 296, 'линия выходит из правой стороны карточки');
  assert.equal(start.y, 31, 'и с середины её высоты');
  assert.equal(start.from, 'coordinator', 'начало линии подписано узлом self');
  assert.equal(start.box.id, 'coordinator');
  const fromBorder = module.__portalStart(null, 400, 120);
  assert.equal(fromBorder.x, 400, 'без self линия начинается у границы');
  assert.equal(fromBorder.from, null, 'начало у границы честно помечено');
  assert.equal(fromBorder.box, null, 'без self карточки нет');
});

test('portalLine: связь с порталом — один прямой отрезок, без коридоров', () => {
  const { module } = loadBundle();
  /* C1: начало — правый край узла, конец — край портала; путь ровно один отрезок. */
  const d = module.__portalLineD({ x: 10, y: 20, w: 120, h: 60 }, 300, 45);
  assert.equal(d, 'M 130 50 L 300 45', 'путь — ровно M…L от правого края узла к краю портала');
  assert.equal((d.match(/ L /g) || []).length, 1, 'в пути один отрезок L');
  assert.deepEqual(d.match(/-?\d+(?:\.\d+)?/g).map(Number), [130, 50, 300, 45], 'концы пути — край узла и край портала');
  assert.doesNotMatch(d, /[HVQACZ]/u, 'без ломаных сегментов H/V/Q/A/C/Z');
  /* C4: узел без объявленного self соединяется с порталом от границы воркспейса. */
  assert.equal(module.__portalLineD({ x: 400, y: 28 }, 484, 60), 'M 400 28 L 484 60');
  /* C3: связь строится прямой линией, коридорная трассировка не вызывается. */
  assert.ok(source.includes('__portalLineD(start, portal.x, entryY)'),
    'renderPortalConnector строит d через __portalLineD');
  assert.ok(!/portalRoute\s*\(/u.test(source), 'portalRoute больше не вызывается');
});

test('portalCount и wrapWords: слово в счётчике и перенос причины', () => {
  const { module } = loadBundle();
  assert.equal(module.__portalCount(1, 'исходящее', 'исходящих'), '1 исходящее');
  assert.equal(module.__portalCount(3, 'исходящее', 'исходящих'), '3 исходящих');
  assert.equal(module.__portalCount(0, 'входящее', 'входящих'), '0 входящих');
  const lines = module.__wrapWords('одно два три четыре пять шесть семь', 10, 3);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.length <= 10), 'строка не длиннее 10: ' + lines.join('|'));
  assert.deepEqual(module.__wrapWords('', 10), ['']);
});

test('палитра узлов: три карточки, связь по умолчанию словами', () => {
  const { module } = loadBundle();
  assert.deepEqual(module.__libraryEdge('critic', 'critic-1', true),
    { from: 'critic-1', to: 'coordinator', kind: 'report' }, 'критик возвращает результат координатору');
  assert.deepEqual(module.__libraryEdge('worker', 'worker-1', true),
    { from: 'coordinator', to: 'worker-1', kind: 'delegate' }, 'воркер получает поручение от координатора');
  assert.equal(module.__libraryEdge('folder', 'folder-1', true), null, 'у папки связей с агентами нет по умолчанию');
  assert.equal(module.__libraryEdge('critic', 'critic-1', false), null,
    'без узла coordinator связь по умолчанию не выдумывается');
  assert.equal(module.__libraryItem('critic').link.words, 'возврат report координатору', 'связь названа словами');
  assert.equal(module.__libraryItem('critic').schedule.at, '09:00');
  assert.match(module.__libraryItem('folder').words, /папка/u);
  /* Обмен — свойство папки, а не роль: папку узнаём по kind, а старую роль «обмен» принимаем. */
  assert.equal(module.__isFolderNode({ kind: 'folder' }), true);
  assert.equal(module.__isFolderNode({ role: 'обмен' }), true, 'старая структура не ломается');
  assert.equal(module.__isFolderNode({ role: 'исполнитель' }), false);
  assert.equal(module.__isExchangeRole('обмен'), true, 'прежняя точка входа жива');
});

test('карточка из библиотеки встаёт под последним рядом карточек', () => {
  const { module } = loadBundle();
  assert.deepEqual(module.__libraryStartPoint({ nodes: [] }), { x: 16, y: 16 });
  assert.deepEqual(module.__libraryStartPoint({
    nodes: [{ x: 0, y: 0, h: 62 }, { x: 240, y: 158, h: 62 }],
  }), { x: 16, y: 244 }, 'новая карточка не ложится на нижнюю');
  assert.deepEqual(module.__libraryStartPoint(null), { x: 16, y: 16 });
});

/*
 * Задание 0119: три роли, закрывающие провалы дня. Спека роли живёт в prompt
 * узла (D1), пресет DSH необязателен и по умолчанию не выставляется (D2).
 * Формулировки ниже — дословно из контракта: тест держит спеку, а не пересказ.
 */
const REVIEWER_SPEC = 'Роль: ревьюер — читает диф и контракт до приёмки, ничего не меняет.\nПроверь: критерии не ослаблены и не подогнаны под проверку; ошибки и пустые пути; секреты и внешние вызовы; тесты проверяют поведение, а не реализацию.\nКаждое замечание: файл:строка, серьёзность, почему, что чинить. Отдельно — список «не судил» с причиной.\nDefinition of Done: вердикт ok|issues, замечания с адресами, список «не судил»; дерево не изменено.';
const TESTER_SPEC = 'Роль: тестировщик — независимый прогон, код не правит.\nПрогони полный набор: node tools/test.mjs; затем точечные тесты задания. Если spawn-тесты падают EPERM, повтори тот же прогон с NODE_OPTIONS=--require docs/tasks/0194/pipe-capture.cjs.\nФиксируй: команда, exit, время, первая упавшая проверка; флак — только с доказательством повтора.\nDefinition of Done: команды и exit в отчёте, вердикт pass|fail, первое падение названо.';
const RELEASE_SPEC = 'Роль: выпускающий — версия и релиз после приёмки.\nШаги: bump по классу изменений, package.json и README, publish-public --build --push, pnpm pack, релиз и ассет по API, проверка HTTP 200 и размера.\nСекреты не печатать; токен только через git credential fill.\nDefinition of Done: версия, тег, URL и размер ассета, HTTP-код, изменённые файлы; при сбое — шаг и текст ошибки.';

test('палитра: ревьюер, тестировщик, выпускающий и аудитор со спеками', () => {
  const { module } = loadBundle();
  const items = module.__libraryItems();
  assert.equal(items.length, 7, 'в палитре семь карточек: три прежние, три роли и аудитор');
  assert.deepEqual(items.map((item) => item.type),
    ['critic', 'worker', 'folder', 'reviewer', 'tester', 'release', 'auditor'],
    'аудитор идёт после релиза, прежние карточки не сдвинуты');
  const byType = (type) => items.find((item) => item.type === type);
  const reviewer = byType('reviewer');
  assert.equal(reviewer.role, 'ревьюер');
  assert.equal(reviewer.brief, 'читает диф и контракт до приёмки');
  assert.equal(reviewer.prompt, REVIEWER_SPEC, 'спека ревьюера — дословно из контракта');
  const tester = byType('tester');
  assert.equal(tester.role, 'тестировщик');
  assert.equal(tester.brief, 'независимый полный прогон');
  assert.equal(tester.prompt, TESTER_SPEC, 'спека тестировщика — дословно из контракта');
  /* 0195: карточка несёт расписание для подписи; время правит человек в настройках. */
  assert.deepEqual(module.__libraryItem('tester').schedule, { at: '04:00', timeZone: 'Europe/Moscow' },
    'у карточки тестировщика расписание 04:00');
  const release = byType('release');
  assert.equal(release.role, 'выпускающий');
  assert.equal(release.brief, 'версия и релиз после приёмки');
  assert.equal(release.prompt, RELEASE_SPEC, 'спека выпускающего — дословно из контракта');
  for (const item of [reviewer, tester, release]) {
    const lines = item.prompt.split(/\r?\n/u).filter((line) => line.trim()).length;
    assert.ok(lines <= 12, 'спека ' + item.type + ' не раздута: ' + lines + ' строк');
    assert.match(item.prompt, /Definition of Done/u, 'у спеки есть Definition of Done: ' + item.type);
    assert.equal(item.agentPreset, undefined, 'пресет по умолчанию не выставляется: ' + item.type);
  }
  assert.deepEqual(module.__libraryEdge('reviewer', 'rev-1', true),
    { from: 'worker', to: 'rev-1', kind: 'review' }, 'ревьюер получает диф от воркера');
  assert.deepEqual(module.__libraryEdge('tester', 'test-1', true),
    { from: 'coordinator', to: 'test-1', kind: 'delegate' }, 'прогон поручает координатор');
  assert.deepEqual(module.__libraryEdge('release', 'rel-1', true),
    { from: 'rel-1', to: 'coordinator', kind: 'report' }, 'выпускающий возвращает релиз координатору');
  for (const icon of ['icon: "🧐"', 'icon: "🧪"', 'icon: "🚀"', 'icon: "🔎"']) {
    assert.ok(source.includes(icon), 'у карточки есть иконка: ' + icon);
  }
  /*
   * 0188: седьмая карточка — аудитор задач. Он проверяет задачу по якорям до
   * приёмки; спека несёт Definition of Done, вердикт conform|rework и
   * отдельный список «не судил». Модель карточкой не рекомендуется.
   */
  const auditor = byType('auditor');
  assert.equal(auditor.role, 'Аудитор задач');
  assert.equal(auditor.brief, 'проверяет задачу по якорям до приёмки');
  assert.match(auditor.prompt, /Definition of Done/u, 'у спеки аудитора есть Definition of Done');
  assert.match(auditor.prompt, /conform\|rework/u, 'вердикт назван: conform|rework');
  assert.match(auditor.prompt, /якор/iu, 'аудит идёт по якорям');
  assert.match(auditor.prompt, /не судил/iu, 'есть список «не судил»');
  assert.equal(auditor.model, undefined, 'модель аудитора выбирает человек');
  const auditorLines = auditor.prompt.split(/\r?\n/u).filter((line) => line.trim()).length;
  assert.ok(auditorLines <= 12, 'спека аудитора не раздута: ' + auditorLines + ' строк');
});

test('узел из карточки получает спеку (prompt)', () => {
  const { module } = loadBundle();
  const reviewer = module.__libraryItems().find((item) => item.type === 'reviewer');
  const node = module.__libraryNode(reviewer, 'rev-1');
  assert.equal(node.id, 'rev-1');
  assert.equal(node.role, 'ревьюер');
  assert.equal(node.brief, 'читает диф и контракт до приёмки');
  assert.equal(node.prompt, reviewer.prompt, 'prompt переносится в узел один-в-один');
  assert.equal('type' in node, false, 'тип — деталь постановки, а не поле узла');
  assert.equal('agentPreset' in node, false, 'пресет не появляется сам');
  const presetNode = module.__libraryNode({ ...reviewer, agentPreset: 'minimal' }, 'rev-2');
  assert.equal(presetNode.agentPreset, 'minimal', 'объявленный пресет доходит до узла');
  assert.equal(module.__libraryNode(null, 'x'), null);
  const draft = module.__libraryNodeDraft(reviewer);
  assert.equal(draft.type, 'reviewer');
  assert.equal(draft.prompt, reviewer.prompt, 'тело постановки несёт спеку');
  assert.deepEqual(module.__libraryNodeDraft(null), null);
  /* Проводка: placeLibraryNode отправляет тело карточки, а не собирает поля заново. */
  const place = source.indexOf('function placeLibraryNode(item, x, y)');
  assert.ok(place > -1, 'placeLibraryNode на месте');
  const body = source.indexOf('const body = libraryNodeDraft(item);', place);
  assert.ok(body > place, 'постановка узла берёт тело из карточки');
  assert.ok(source.indexOf('JSON.stringify(body)', body) > body, 'тело уходит на /api/node как есть');
});

/*
 * 0188: шаблон узла по виду карточки. __libraryItemByType отдаёт type/role/prompt
 * из того же объявления, что и перетаскивание; неизвестный вид — null.
 */
test('__libraryItemByType: аудитор — шаблон узла с ролью и промптом (0188)', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.__libraryItemByType, 'function', 'нет __libraryItemByType');
  const template = module.__libraryItemByType('auditor');
  assert.ok(template, 'шаблон auditor не найден');
  assert.equal(template.type, 'auditor');
  assert.equal(template.role, 'Аудитор задач');
  assert.match(String(template.prompt || ''), /Definition of Done/u);
  assert.equal(module.__libraryItemByType('нет-такого'), null, 'неизвестный вид — null');
  const card = module.__libraryItems().find((item) => item.type === 'auditor');
  assert.deepEqual(template, module.__libraryNodeDraft(card),
    'шаблон и карточка — одно объявление, второго описания роли нет');
  const node = module.__libraryNode(card, 'auditor-1');
  assert.equal(node.role, 'Аудитор задач', 'перетаскивание ставит узел с ролью аудитора');
  assert.equal(node.prompt, card.prompt, 'спека переносится в узел один-в-один');
  assert.equal('model' in node, false, 'модель карточка не навязывает');
});

/*
 * Задание 0126: карточка палитры — подпись над плиткой и полное описание
 * по наведению; узел — спека в «Настройках» и «Сведениях»; рекомендованные
 * модели в карточках ролей. Ниже — поведение, а не текст: проверка зовёт те же
 * чистые функции, которыми пользуется панель.
 */
test('0126: подпись карточки над плиткой, подсказка — роль, назначение, связь, спека', () => {
  const { module } = loadBundle();
  const cards = module.__libraryItems();
  const reviewer = cards.find((item) => item.type === 'reviewer');
  const parts = module.__libraryCardParts(reviewer);
  const label = parts.indexOf('label');
  const tile = parts.indexOf('tile');
  assert.ok(label >= 0 && tile >= 0, 'в карточке есть и подпись, и плитка');
  assert.ok(label < tile, 'подпись стоит над плиткой: ' + JSON.stringify(parts));
  const text = module.__libraryHoverText(reviewer);
  for (const part of [
    'Роль: ревьюер',
    'Назначение: читает диф и контракт до приёмки',
    'Связь: воркер отдаёт диф на ревью',
    'Роль: ревьюер — читает диф и контракт до приёмки',
  ]) {
    assert.ok(text.includes(part), 'в подсказке нет «' + part + '»: ' + text);
  }
  assert.ok(!text.includes('Definition of Done'), 'спека целиком не вываливается в подсказку');
  const folder = module.__libraryHoverText(module.__libraryItems().find((item) => item.type === 'folder'));
  assert.match(folder, /папка — не агент/u, 'у папки тоже есть честная подсказка');
  assert.equal(module.__libraryHoverText(null), '');
});

test('0126: спека — textarea в «Настройках» и строка в паспорте', () => {
  const { module } = loadBundle();
  const fields = module.__nodeFormFields();
  const prompt = fields.find((field) => field.key === 'prompt');
  assert.ok(prompt, 'в форме есть поле спеки');
  assert.match(prompt.label, /Спека/u);
  assert.equal(prompt.kind, 'textarea');
  assert.equal(fields.find((field) => field.key === 'id').kind, 'readonly', 'id не редактируется');
  const rows = module.__nodePassportRows({ id: 'rev-1', role: 'ревьюер', prompt: 'Роль: ревьюер' }, []);
  const row = rows.find((entry) => entry.key === 'prompt');
  assert.equal(row.label, 'Спека');
  assert.equal(row.value, 'Роль: ревьюер');
  const empty = module.__nodePassportRows({ id: 'x' }, []).find((entry) => entry.key === 'prompt');
  assert.match(empty.value, /не задана/u, 'пустая спека названа честно, а не выдумана');
  const start = source.indexOf('function renderNodeEditModal()');
  const end = source.indexOf('\n        function ', start + 10);
  const body = source.slice(start, end === -1 ? source.length : end);
  assert.ok(body.includes('formField("prompt")'), 'форма рисует спеку тем же полем');
  assert.ok(body.includes('nodeFormFields()'), 'поля формы берутся из одного списка');
  assert.ok(body.includes('textarea'), 'спека правится в textarea');
  assert.ok(source.includes('prompt: typeof node.prompt === "string" ? node.prompt : ""'),
    'значение спеки приходит из узла');
  assert.ok(source.includes('...(exchange ? {} : { prompt: String(draft.prompt || "").trim() })'),
    'спека сохраняется прежним POST /api/node');
});

test('0126: рекомендованные модели несут только reviewer/tester/release', () => {
  const { module } = loadBundle();
  const cards = module.__libraryItems();
  const byType = (type) => cards.find((item) => item.type === type);
  assert.equal(module.__libraryNode(byType('reviewer'), 'rev-1').model, 'glm-5.3-flash');
  assert.equal(module.__libraryNode(byType('tester'), 'test-1').model, 'deepseek-v4.1-flash');
  assert.equal(module.__libraryNode(byType('release'), 'rel-1').model, 'deepseek-v4.1-flash');
  for (const type of ['critic', 'worker', 'folder']) {
    assert.equal('model' in module.__libraryNode(byType(type), type + '-1'), false,
      'у ' + type + ' модель не появляется: её выбирает человек');
  }
  const draft = module.__libraryNodeDraft(byType('reviewer'));
  assert.equal(draft.prompt, byType('reviewer').prompt, 'тело постановки несёт спеку роли');
  assert.equal('model' in draft, false,
    'модель без провайдера в тело POST не уходит: сервер требует полный маршрут');
  /* Рекомендация становится маршрутом только при единственном провайдере в каталоге. */
  const catalog = [{ id: 'opencode-go', models: [{ id: 'glm-5.3-flash' }, { id: 'deepseek-v4.1-flash' }] }];
  assert.deepEqual(module.__libraryModelRoute(byType('reviewer'), catalog),
    { provider: 'opencode-go', model: 'glm-5.3-flash' }, 'модель карточки получает провайдера из каталога');
  assert.equal(module.__libraryModelRoute(byType('critic'), catalog), null, 'у critic рекомендации нет');
  assert.equal(module.__libraryModelRoute(byType('reviewer'), null), null, 'без каталога маршрут не выдумывается');
  assert.equal(module.__libraryModelRoute(byType('reviewer'), [
    { id: 'p1', models: [{ id: 'glm-5.3-flash' }] },
    { id: 'p2', models: [{ id: 'glm-5.3-flash' }] },
  ]), null, 'два провайдера — выбор остаётся человеку');
  const place = source.indexOf('function placeLibraryNode(item, x, y)');
  const placeEnd = source.indexOf('\n        function ', place + 10);
  const placeBody = source.slice(place, placeEnd === -1 ? source.length : placeEnd);
  assert.ok(placeBody.includes('libraryModelRoute(item, availableModels)'),
    'постановка из палитры добавляет рекомендацию полным маршрутом');
});

test('счётчик палитры считается по числу элементов', () => {
  const { module } = loadBundle();
  const cases = [
    [0, '0 элементов'],
    [1, '1 элемент'],
    [2, '2 элемента'],
    [3, '3 элемента'],
    [4, '4 элемента'],
    [5, '5 элементов'],
    [6, '6 элементов'],
    [11, '11 элементов'],
    [14, '14 элементов'],
    [21, '21 элемент'],
    [22, '22 элемента'],
    [25, '25 элементов'],
  ];
  for (const [count, want] of cases) {
    assert.equal(module.__libraryCountLabel(count), want, '__libraryCountLabel(' + count + ')');
  }
  assert.equal(module.__libraryItems().length, 7, 'подпись считается по числу карточек');
  assert.equal(module.__libraryCountLabel(module.__libraryItems().length), '7 элементов');
  assert.ok(source.includes('libraryCountLabel(NODE_LIBRARY.length)'), 'панель считает подпись той же функцией');
  assert.ok(!source.includes('"3 элемента"'), 'жёсткого «3 элемента» в панели нет');
});

test('палитра сворачивается, выносится мышью и ставится с клавиатуры', () => {
  for (const needle of [
    'data-library', 'NODE_LIBRARY', 'Свернуть', 'Развернуть', 'aria-expanded',
    '"aria-controls": "pg-library-items"', 'libraryOpen',
    'data-library-ghost', 'data-library-target',
    'beginPointerCarry', 'beginKeyboardCarry', 'onPointerDown', 'pointercancel',
    'Enter — взять', 'стрелки — двигать', 'Esc — отмена',
    'libraryEdge', 'libraryStartPoint', 'папка, не агент',
  ]) {
    assert.ok(source.includes(needle), 'в палитре нет: ' + needle);
  }
  assert.ok(source.includes('icon: "⚖"') && source.includes('icon: "⚙"') && source.includes('icon: "📁"'),
    'у карточек есть иконки для свёрнутой полосы');
  assert.ok(source.includes('библиотека узлов свёрнута'), 'сворачивание названо словами');
});

test('папка на схеме: это папка, обмен — её свойство, а не роль', () => {
  for (const needle of [
    'exchangeText', 'isFolderNode',
    'папка обмена: ', 'участники: ',
    'связь: рёбра exchange от узлов, которые пишут в ящик',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  assert.ok(!source.includes('const exchange = isExchangeRole(detail && detail.role)'),
    'карточка больше не узнаёт папку по роли');
});

/* C4: «Настройки» узла — вкладка окна: поля, «Сохранить» и крестик вместо «Отмена». */
test('настройки узла: вкладка с полями, «Сохранить» и крестиком', () => {
  for (const needle of [
    'renderNodeEditModal', 'data-node-editor', 'data-node-settings', 'nodeEditor', 'openNodeEditor', 'submitNodeEditor',
    'addEditorLink', 'removeEditorLink', 'data-modal-close', 'data-editor-close', 'role: "dialog"', '"aria-modal": "true"',
    'id узла в редакторе', 'роль узла в редакторе', 'модель узла в редакторе',
    'назначение узла в редакторе', 'время запуска в редакторе',
    'вид связи в редакторе', 'узел связи в редакторе', 'Добавить связь',
    'readOnly: true', 'data-editor-save', 'requestCloseNodeEditor',
    '"Почему: "', '"Что сделать: "', 'nodeEditorError.what',
    'изменено · не сохранено', 'renderNodeEditModal()',
  ]) {
    assert.ok(source.includes(needle), 'в настройках узла нет: ' + needle);
  }
  const editorStart = source.indexOf('function renderNodeEditModal()');
  const editorEnd = source.indexOf('\n        function ', editorStart + 10);
  const editorBody = source.slice(editorStart, editorEnd === -1 ? source.length : editorEnd);
  assert.ok(!editorBody.includes('data-editor-cancel'), '«Отмены» в настройках нет');
  assert.ok(!editorBody.includes('"Отмена"'), 'кнопка «Отмена» заменена крестиком');
  assert.ok(editorBody.includes('Сохранить'), '«Сохранить» остаётся основной кнопкой');
  assert.ok(!editorBody.includes('anchor.left'), 'настройки больше не поповер у карточки');
  assert.ok(!editorBody.includes('S.modalBackdrop'), 'вкладка не открывает второе модальное окно');
  /*
   * 0160: действия записи больше не в прокручиваемом теле вкладки. «Сохранить»
   * и «Удалить узел» держит закреплённая линейка окна (renderNodeSettingsFooter):
   * иначе кнопки снова окажутся в конце длинной прокрутки и будут «скрыты».
   */
  assert.ok(!editorBody.includes('S.modalFooter'), 'в теле вкладки нет собственной нижней строки');
  assert.ok(!editorBody.includes('data-editor-save'), '«Сохранить» не живёт в прокрутке');
  assert.ok(!editorBody.includes('data-editor-remove'), '«Удалить узел» не живёт в прокрутке');
});

/*
 * 0143 (вариант C заказчика): шестерёнка в строке роли видна всегда и открывает
 * окно узла, а правого меню нет. Функции — одна точка правды для панели и
 * проверки; сам рендер проверяется исполнением в test/panel-render.test.mjs.
 */
test('0143: шестерёнка узла видна всегда и открывает окно, меню правой кнопки пусто', () => {
  const { module } = loadBundle();
  assert.deepEqual(module.__nodeGear(), { visible: 'always', opens: 'window' },
    'шестерёнка узла: видна всегда, открывает окно');
  assert.deepEqual(module.__nodeMenuLabels(), [], 'правый клик меню не открывает');
  for (const needle of [
    'data-node-gear', 'onOpenWindow', 'openNodeWindow(', 'data-folder-gear',
    'data-folder-participants', 'folderParticipantsBadge',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  /*
   * Меню как сущности больше нет: ни разметки, ни точки у курсора, ни
   * клавиатурного Shift+F10. Иначе «меню не открывает» держалось бы флагом.
   */
  for (const gone of [
    'data-node-menu', 'renderNodeMenu', 'openNodeContextMenu', 'openFolderContextMenu',
    'openInfoFromMenu', 'nodeMenuFromKeyboard', 'contextMenuAnchor', 'NODE_MENU_WIDTH',
  ]) {
    assert.ok(!source.includes(gone), 'остаток правого меню: ' + gone);
  }
});

test('0143: шестерёнка папки и бейдж участников — всегда, открывают окно папки', () => {
  const { module } = loadBundle();
  assert.deepEqual(module.__folderGear(), { visible: 'always', opens: 'window' },
    'шестерёнка папки: видна всегда, открывает окно');
  const folder = { id: 'folder-1', participants: ['structure', 'workflow'] };
  assert.equal(module.__folderParticipantsBadge(folder, { label: 'structure' }), 'structure + workflow',
    'бейдж называет участников папки через « + »');
  assert.equal(module.__folderParticipantsBadge({ id: 'f', participants: [] }, { label: 'structure' }), 'structure',
    'бейдж без записи участников не выдумывает метки');
  assert.equal(module.__folderParticipantsBadge({ id: 'f' }, {}), 'участники не заданы',
    'пустая папка говорит словами, а не пустой плашкой');
  /* Свойств папки в низу панели нет: окно — единственное место. */
  const start = source.indexOf('function renderDetails()');
  const end = source.indexOf('\n        function ', start + 10);
  const details = source.slice(start, end === -1 ? source.length : end);
  for (const gone of ['Участники', 'contract', 'box.path', 'folder.participants']) {
    assert.ok(!details.includes(gone), 'в низу панели остались свойства папки: ' + gone);
  }
});

test('0143: счётчик палитры только в развёрнутой палитре, одной строкой', () => {
  const { module } = loadBundle();
  assert.equal(module.__paletteCounterVisible(false), false, 'свёрнутый корешок без счётчика');
  assert.equal(module.__paletteCounterVisible(true), true, 'развёрнутая палитра показывает счётчик');
  assert.ok(source.includes('paletteCounterVisible(libraryOpen)'),
    'панель решает о счётчике той же функцией');
  assert.ok(source.includes('data-library-counter'), 'счётчик размечен для проверки');
  const start = source.indexOf('data-library-counter');
  const chip = source.slice(start - 200, start + 200);
  assert.ok(chip.includes('whiteSpace: "nowrap"'), 'счётчик не переносится на вторую строку');
});

/* C2: «Сведения» — паспорт узла, только чтение, с переходом в «Настройки» (0122). */
test('сведения об узле: паспорт только для чтения и «Изменить в «Настройках» →»', () => {
  for (const needle of [
    'renderNodeInfo', 'data-node-info', 'data-node-info-close', 'data-node-info-edit',
    'Сведения об узле', 'closeNodeInfo', 'editFromNodeInfo',
    'describeEdge', 'S.modalInfo', 'role: "dialog"', 'renderNodeTabs', 'nodeTabs()',
    'Изменить в «Настройках» →', 'renderNodePassportTab', 'renderNodeStateTab',
  ]) {
    assert.ok(source.includes(needle), 'в сведениях об узле нет: ' + needle);
  }
  const start = source.indexOf('function renderNodeInfo()');
  const end = source.indexOf('\n        function ', start + 10);
  const body = source.slice(start, end === -1 ? source.length : end);
  assert.ok(!body.includes('readOnly: false'), 'сведения только для чтения');
  assert.ok(body.includes('renderNodePassportTab') && body.includes('renderNodeStateTab'),
    'паспорт и состояние — разные вкладки');
});

/* 0122: окно узла — три вкладки, паспорт отдельно от состояния, низ из двух действий. */
test('0122: окно узла — ровно три вкладки', () => {
  const { module } = loadBundle();
  const tabs = module.__nodeTabs();
  assert.deepEqual(tabs.map((tab) => tab.label), ['Сведения', 'Состояние', 'Настройки']);
  assert.deepEqual(tabs.map((tab) => tab.id), ['info', 'state', 'settings']);
});

/* 0129: окно узла фиксированного размера, тело вкладки прокручивается. */
test('0129: окно узла — фиксированный размер и прокручиваемое тело вкладки', () => {
  const { module } = loadBundle();
  const size = module.__nodeModalSize();
  assert.ok(size && typeof size === 'object', '__nodeModalSize возвращает объект');
  assert.ok(Number.isFinite(size.width) && Number.isFinite(size.height), 'размер — числа: ' + JSON.stringify(size));
  assert.ok(size.width >= 420 && size.height >= 360, 'окно не меньше нижней границы: ' + JSON.stringify(size));
  const style = module.__nodeBodyStyle();
  assert.equal(style.overflowY, 'auto', 'тело вкладки прокручивается');
  assert.equal(style.minHeight, 0, 'minHeight: 0 — иначе flex-тело не сжимается');
  const start = source.indexOf('function renderNodeInfo()');
  const end = source.indexOf('\n        function ', start + 10);
  const body = source.slice(start, end === -1 ? source.length : end);
  assert.ok(body.includes('S.modalNode'), 'окно узла берёт фиксированный размер, а не авторазмер');
  assert.ok(body.includes('nodeBodyStyle()'), 'тело вкладки берёт стиль прокрутки из общей функции');
});

/*
 * 0160: вкладка «Настройки» — шапка и линейка закреплены, прокручивается
 * только тело. Проверяются числа раскладки, состав линейки и границы
 * затемнения: панель пользуется теми же функциями, что и проверка.
 */
test('0160: «Настройки» — шапка fixed, тело scroll, линейка fixed', () => {
  const { module } = loadBundle();
  const layout = module.__settingsLayout();
  assert.equal(layout.header, 'fixed', 'шапка закреплена');
  assert.equal(layout.body, 'scroll', 'тело прокручивается');
  assert.equal(layout.footer, 'fixed', 'линейка закреплена');
  assert.ok(Number.isFinite(layout.footerHeight) && layout.footerHeight > 0,
    'высота линейки положительна: ' + JSON.stringify(layout.footerHeight));
  const bodyStyle = module.__settingsBodyStyle();
  assert.equal(bodyStyle.overflowY, 'auto', 'тело настроек прокручивается');
  const padding = Number.parseInt(bodyStyle.paddingBottom, 10);
  assert.ok(padding >= layout.footerHeight,
    'нижний отступ тела не меньше линейки: ' + bodyStyle.paddingBottom);
  assert.equal(Number.parseInt(bodyStyle.scrollPaddingBottom, 10), layout.footerHeight,
    'scroll-padding равен линейке: фокус в поле не прячется под кнопками');
  const slot = module.__settingsBodySlotStyle();
  assert.equal(slot.position, 'relative', 'слот тела — точка отсчёта затемнения');
  assert.equal(slot.minHeight, 0, 'minHeight: 0 — иначе тело не сжимается и прокрутки нет');

  const actions = module.__settingsActions();
  assert.deepEqual(actions.map((action) => action.label), ['Сохранить', 'Удалить узел'],
    'в линейке ровно две кнопки: основная и опасная');
  for (const action of actions) {
    assert.equal(action.place, 'footer', 'кнопка живёт в линейке: ' + action.label);
    assert.equal(action.visible, 'always', 'кнопка видна всегда: ' + action.label);
  }

  const insets = module.__deleteConfirmInsets();
  assert.ok(insets.top > 0, 'затемнение начинается ниже шапки и вкладок: ' + insets.top);
  assert.equal(insets.bottom, layout.footerHeight, 'затемнение не перекрывает линейку');
  assert.equal(insets.scope, 'body', 'затемняется только тело настроек');

  for (const needle of [
    'data-settings-header', 'data-settings-tabs', 'data-settings-slot',
    'data-settings-body', 'data-settings-footer', 'settingsHeaderStyle()',
    'settingsTabsBandStyle()', 'settingsBodySlotStyle()', 'settingsFooterStyle()',
    'renderNodeSettingsFooter', 'data-delete-confirm-top', 'data-delete-confirm-bottom',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  /* Линейка — сосед тела, а не его содержимое: в прокрутку она не входит. */
  const footerStart = source.indexOf('function renderNodeSettingsFooter');
  const footerEnd = source.indexOf('\n        function ', footerStart + 10);
  const footerBody = source.slice(footerStart, footerEnd === -1 ? source.length : footerEnd);
  assert.ok(footerBody.includes('data-settings-footer'), 'линейка размечена для проверки');
  assert.ok(!footerBody.includes('data-settings-body'), 'линейка не внутри прокручиваемого тела');
});

/* 0160: три состояния «Сохранить» — без правок, с правками, с находками. */
test('0160: «Сохранить» недоступна без правок и показывает число находок', () => {
  const { module } = loadBundle();
  const idle = module.__settingsFooterState({ changed: 0, findings: 0 });
  assert.equal(idle.save.label, 'Сохранить');
  assert.equal(idle.save.disabled, true, 'без правок записывать нечего');
  assert.match(idle.note.text, /нет правок/u, 'линейка объясняет, почему кнопка выключена');
  assert.equal(idle.frame, null, 'без находок рамка обычная');

  const changed = module.__settingsFooterState({ changed: 2, findings: 0 });
  assert.equal(changed.save.disabled, false, 'с правками «Сохранить» доступна');
  assert.match(changed.note.text, /2 поля изменены/u, 'линейка называет число изменённых полей');
  assert.equal(changed.note.tone, 'warn');
  assert.match(module.__settingsFooterState({ changed: 1 }).note.text, /1 поле изменено/u,
    'одно поле — единственное число');
  assert.match(module.__settingsFooterState({ changed: 5 }).note.text, /5 полей изменено/u,
    'пять полей — родительный падеж');

  const found = module.__settingsFooterState({ changed: 0, findings: 3 });
  assert.equal(found.save.disabled, false, 'находки не запрещают запись: иначе правку не сохранить');
  assert.match(found.note.text, /3 находки/u, 'линейка называет число находок');
  assert.equal(found.frame, 'danger', 'при находках линейка выделена красным');
  assert.match(module.__settingsFooterState({ findings: 1 }).note.text, /1 находка/u);
  assert.match(module.__settingsFooterState({ findings: 12 }).note.text, /12 находок/u);

  const busy = module.__settingsFooterState({ changed: 1, busy: true });
  assert.equal(busy.save.disabled, true, 'пока запись идёт, кнопка не жмётся дважды');
  assert.equal(busy.save.label, 'Сохраняю…');

  assert.equal(module.__validatorFindingsCount({ validation: { findings: [{}, {}] } }), 2,
    'список находок считается по длине');
  assert.equal(module.__validatorFindingsCount({ validation: { findingsTotal: 4 } }), 4,
    'готовое число находок принимается');
  assert.equal(module.__validatorFindingsCount({}), 0, 'без валидатора находок нет');
  assert.equal(module.__validatorFindingsCount(null), 0, 'пустой ответ — не находка');
});

/* 0162: выступ валидатора — вкладка у координатора, сводка и блокировка запуска. */
test('0162: выступ валидатора справа от координатора, 14 → 180 при наведении', () => {
  const { module } = loadBundle();
  const tab = module.__validatorTab();
  assert.equal(tab.attachedTo, 'coordinator');
  assert.equal(tab.edge, 'right');
  assert.equal(tab.collapsedWidth, 14);
  assert.equal(tab.expandedWidth, 180);
  /* 0184: выезд — объект с числами макета, а не строка «expand». */
  assert.equal(tab.hover.expandedWidth, 180);
  assert.notEqual(module.__validatorTab(), tab, 'модель вкладки — копия, а не общий объект');
  assert.notEqual(module.__validatorTab().hover, tab.hover, 'вложенный hover тоже копия');
  assert.ok(source.includes('data-validator-tab'), 'выступ размечен для проверки');
  assert.ok(source.includes('"aria-label": validatorAria'), 'выступ подписан словами, а не только цветом');
  assert.ok(source.includes('"aria-expanded": open ? "true" : "false"'), 'состояние выступа объявлено');
  assert.ok(source.includes('onMouseEnter'), 'наведение разворачивает выступ');
  assert.ok(source.includes('tabIndex: 0'), 'до выступа можно дойти клавиатурой');
  assert.ok(source.includes('Enter — окно блока'), 'клавиатурный вход назван человеку');
});

/* 0184: вкладка-выступ — форма, выезд, слой и вход для скринридера. */
test('0184: вкладка-выступ — квадратный левый край, стык 1 px, выезд 140 мс', () => {
  const { module } = loadBundle();
  const tab = module.__validatorTab();
  assert.equal(tab.attachedTo, 'coordinator');
  assert.equal(tab.leftEdge, 'square', 'левый край квадратный: вкладка продолжает карточку');
  assert.equal(tab.overlapPx, 1, 'левый край заходит под карточку на 1 px — стыка не видно');
  assert.equal(tab.radiusRight, 7, 'скругление только справа');
  assert.equal(tab.height, 44, 'ручка, а не сплющенный блок');
  assert.equal(tab.collapsedWidth, 14, 'в покое всегда 14 px');
  assert.equal(tab.hover.expandedWidth, 180);
  assert.equal(tab.hover.transitionMs, 140, 'выезд 140 мс');
  assert.equal(tab.hover.opacityMs, 120, 'прозрачность 120 мс');
  assert.equal(tab.hover.delayMs, 160, 'задержка раскрытия 160 мс');
  assert.equal(tab.hover.closeDelayMs, 250, 'закрытие через 250 мс');
  assert.equal(tab.layer, 'below-nodes', 'слой — над рёбрами и под карточками');
  /* Два узла одной вкладки и состояние размечены для исполняемых проверок. */
  assert.ok(source.includes('"data-validator-handle": "1"'), 'ручка размечена');
  assert.ok(source.includes('"data-validator-card": "1"'), 'панель размечена');
  assert.ok(source.includes('"data-validator-state": state'), 'состояние вкладки размечено');
  /* Порядок слоёв: рёбра → вкладка → карточки. */
  const edgesAt = source.indexOf('edges.map((edge, index) =>');
  const tabAt = source.indexOf('renderValidatorTab(coordinatorBox');
  const cardsAt = source.indexOf('canvasNodes.map((node) =>');
  assert.ok(edgesAt > 0 && tabAt > edgesAt, 'вкладка рисуется после рёбер');
  assert.ok(cardsAt > tabAt, 'карточки рисуются после вкладки и перекрывают стык 1 px');
  assert.ok(source.includes('prefersReducedMotion'), 'prefers-reduced-motion отключает выезд');
});

/* 0184: четыре состояния вкладки; info — не находка, пустая структура — empty. */
test('0184: состояние вкладки — ok|warn|error|empty, info не находка', () => {
  const { module } = loadBundle();
  const coordinator = { nodes: [{ id: 'coordinator' }] };
  assert.equal(module.__validatorState({ graph: { nodes: [] }, findings: [{ code: 'empty-graph', severity: 'info' }] }),
    'empty', 'пустая структура — empty, а не янтарная находка');
  assert.equal(module.__validatorState({ graph: coordinator, findings: [{ code: 'x', severity: 'info' }] }),
    'ok', 'info не делает warn');
  assert.equal(module.__validatorState({ graph: coordinator, findings: [{ code: 'y', severity: 'error' }] }), 'error');
  assert.equal(module.__validatorState({ graph: coordinator, findings: [{ code: 'z', severity: 'warning' }] }), 'warn');
  assert.equal(module.__validatorState({ findings: [{ severity: 'warning' }, { severity: 'error' }] }), 'error',
    'error сильнее warning');
  assert.equal(module.__validatorState({ graph: coordinator }), 'ok');
  assert.equal(module.__validatorState({}), 'ok', 'без ответа — не тревога');
  assert.equal(module.__validatorState([]), 'ok');
  /* info не считается ни в сводке, ни в тексте состояния. */
  assert.equal(module.__validatorSummary([{ severity: 'info' }]), 'структура исправна');
  assert.equal(module.__validatorSummary([{ severity: 'info' }, { severity: 'warning' }]), '1 находка');
  assert.equal(module.__validatorStateText('empty', [{ severity: 'info' }]), 'структура пуста');
  assert.equal(module.__validatorStateText('error', [{ severity: 'error' }, { severity: 'error' }]), '2 находки');
  /* Чип шапки — одно состояние, одна фраза (макет §5). */
  assert.equal(module.__validatorChipText('ok', []), 'структура исправна');
  assert.equal(module.__validatorChipText('empty', []), 'структура пуста · начните с координатора');
  assert.equal(module.__validatorChipText('warn', [{ severity: 'warning' }]), '1 находка · запуск доступен');
  assert.equal(module.__validatorChipText('error', [{ severity: 'error' }, { severity: 'error' }]),
    '2 находки · запуск заблокирован');
});

/* 0184: рёбра координатора начинаются за вкладкой — x + w + 13. */
test('0184: рёбра координатора начинаются за вкладкой', () => {
  const { module } = loadBundle();
  assert.equal(module.__validatorEdgeOffset(), 13, 'сдвиг = 14 − 1 (видимая ручка за вычетом стыка)');
  const boxes = new Map([
    ['coordinator', { id: 'coordinator', x: 4, y: 0, w: 176, h: 62 }],
    ['worker', { id: 'worker', x: 300, y: 0, w: 176, h: 62 }],
  ]);
  const [sideways] = module.__edgeSegments(boxes, [{ from: 'coordinator', to: 'worker', kind: 'delegate' }]);
  assert.deepEqual([sideways.x1, sideways.y1, sideways.x2, sideways.y2], [193, 31, 300, 31],
    'правый выход координатора сдвинут за полосу на 13 px');
  /* Серверная раскладка получает тот же сдвиг: правило одно. */
  const layoutEdge = { from: 'coordinator', to: 'worker', kind: 'delegate', x1: 180, y1: 31, x2: 300, y2: 31 };
  assert.deepEqual(module.__validatorEdge(layoutEdge, boxes),
    { ...layoutEdge, x1: 193, y1: 31, x2: 300, y2: 31 }, 'ребро сервера сдвинуто тем же правилом');
  /* Нижний выход координатора вкладкой не занят — сдвига нет. */
  const vertical = new Map([
    ['coordinator', { id: 'coordinator', x: 4, y: 0, w: 176, h: 62 }],
    ['worker', { id: 'worker', x: 4, y: 200, w: 176, h: 62 }],
  ]);
  const [down] = module.__edgeSegments(vertical, [{ from: 'coordinator', to: 'worker', kind: 'delegate' }]);
  assert.equal(down.x1, 4 + 176 / 2, 'нижняя грань координатора остаётся на месте');
  assert.equal(down.y1, 62);
  /* Узел не координатор — точка не двигается. */
  const plain = new Map([
    ['a', { id: 'a', x: 0, y: 0, w: 176, h: 62 }],
    ['b', { id: 'b', x: 300, y: 0, w: 176, h: 62 }],
  ]);
  const [move] = module.__edgeSegments(plain, [{ from: 'a', to: 'b', kind: 'delegate' }]);
  assert.equal(move.x1, 176, 'у обычного узла ребро начинается на его ребре');
});

test('0162: сводка находок склоняется, пусто — «структура исправна»', () => {
  const { module } = loadBundle();
  assert.equal(module.__validatorSummary([]), 'структура исправна');
  assert.equal(module.__validatorSummary([{ severity: 'error' }]), '1 находка');
  assert.equal(module.__validatorSummary([{ severity: 'error' }, { severity: 'warning' }]), '2 находки');
  assert.equal(module.__validatorSummary(Array.from({ length: 5 }, () => ({ severity: 'error' }))), '5 находок');
  assert.equal(module.__validatorSummary(Array.from({ length: 11 }, () => ({ severity: 'warning' }))), '11 находок',
    'одиннадцать — родительный падеж');
  assert.equal(module.__validatorSummary(Array.from({ length: 21 }, () => ({ severity: 'warning' }))), '21 находка',
    'двадцать одна — единственное число');
  assert.equal(module.__validatorSummary(undefined), 'структура исправна', 'нет ответа — не находка');
  assert.equal(module.__validatorSummary({ validation: { findings: [{}, {}] } }), '2 находки',
    'ответ /api/graph принимается целиком');
});

test('0162: запуск блокируют только error-находки', () => {
  const { module } = loadBundle();
  assert.equal(module.__validatorBlocked([]), false);
  assert.equal(module.__validatorBlocked([{ severity: 'warning' }]), false, 'предупреждение не блокирует');
  assert.equal(module.__validatorBlocked([{ severity: 'warning' }, { severity: 'info' }]), false);
  assert.equal(module.__validatorBlocked([{ severity: 'error' }]), true);
  assert.equal(module.__validatorBlocked([{ severity: 'warning' }, { severity: 'ERROR' }]), true,
    'регистр severity не важен');
  assert.equal(module.__validatorBlocked(undefined), false, 'нет ответа — запуск не блокируется');
  assert.deepEqual(
    module.__validatorFindingLine({
      code: 'unknown-model', severity: 'error', file: 'structure/graph.json', line: 12,
      message: 'модель не подтверждена', fix: 'выберите модель',
    }),
    { code: 'unknown-model', severity: 'error', where: 'structure/graph.json:12',
      message: 'модель не подтверждена', fix: 'выберите модель' },
    'находка читается человеком: код, адрес, что не так и что сделать',
  );
  assert.ok(source.includes('disabled: !node.model || launchBlocked'),
    '«Запустить» внизу панели выключена при error-находках, а не только в окне валидатора');
  assert.ok(source.includes('data-bottom-blocked'), 'низ панели называет блокировку запуска');
  assert.ok(source.includes('"data-validator-chip": "1"'), 'блокировка видна и на канве');
});

test('0162: вкладки окна узла и низ панели не изменились', () => {
  const { module } = loadBundle();
  assert.deepEqual(module.__nodeTabs().map((tab) => tab.label), ['Сведения', 'Состояние', 'Настройки']);
  assert.deepEqual(module.__bottomBarItems(), ['Связь', 'Запустить']);
  assert.ok(!source.includes('data-validator-tab') || source.includes('renderValidatorTab'),
    'выступ не подменяет вкладки окна');
});

test('0122: паспорт — id, роль, модель с провайдером/семейством, назначение, пресет, файл, связи словами', () => {
  const { module } = loadBundle();
  const node = {
    id: 'coordinator', role: 'координатор', provider: 'opencode-go',
    model: 'deepseek-v4.1-flash', family: 'deepseek', brief: 'ведёт план',
    agentPreset: 'standard', file: 'structure/graph.json',
  };
  const links = [
    { kind: 'delegate', from: 'coordinator', to: 'worker' },
    { kind: 'review', from: 'coordinator', to: 'judge' },
    { kind: 'report', from: 'worker', to: 'coordinator' },
  ];
  const rows = module.__nodePassportRows(node, links);
  const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(map.id, 'coordinator');
  assert.equal(map.role, 'координатор');
  assert.match(map.model, /opencode-go · deepseek-v4\.1-flash/, 'модель названа с провайдером');
  assert.match(map.model, /семейство deepseek/, 'семейство названо словами');
  assert.equal(map.brief, 'ведёт план');
  assert.equal(map.agentPreset, 'standard');
  assert.match(map.file, /structure\/graph\.json/, 'файл объявления назван');
  assert.match(map.links, /исходящие worker — задание/, 'исходящая связь — словами');
  assert.match(map.links, /judge — приёмка/, 'вид связи назван словом');
  assert.match(map.links, /входящие worker — приём отчёта/, 'входящая связь — словами');
  const alone = module.__nodePassportRows({ id: 'alone' }, []);
  const aloneLinks = alone.find((row) => row.key === 'links').value;
  assert.equal(aloneLinks.split('\n').length, 2, 'обе стороны названы');
  assert.match(aloneLinks, /входящие нет — узел корневой/);
});

test('0122: состояние — слово с фразой, источник, отчёт, сессия, расписание, ветка; без паспорта', () => {
  const { module } = loadBundle();
  const rows = module.__nodeStateRows({
    word: 'работает', sentence: 'агент работает', source: 'живой агент',
    report: 'нет отчёта', session: '6f1a2c8e', schedule: 'ежедневно 09:00',
    next: '07.11 09:00', branch: 'шагов 3',
  });
  const keys = rows.map((row) => row.key);
  for (const key of ['state', 'source', 'report', 'session', 'schedule', 'branch']) {
    assert.ok(keys.includes(key), 'в состоянии нет строки ' + key);
  }
  const passport = ['id', 'role', 'model', 'brief', 'agentPreset', 'file', 'links'];
  assert.deepEqual(keys.filter((key) => passport.includes(key)), [], 'паспорт просочился в состояние');
  const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.match(map.state, /работает — агент работает/, 'слово состояния идёт с фразой');
  assert.match(map.session, /6f1a2c8e/);
  assert.match(map.schedule, /следующий запуск 07\.11 09:00/);
  assert.match(map.branch, /шагов 3/);
});

test('0122/0143: низ — «Связь»/«Запустить», правого меню нет', () => {
  const { module } = loadBundle();
  assert.deepEqual(module.__bottomBarItems(), ['Связь', 'Запустить']);
  assert.deepEqual(module.__nodeMenuLabels(), [], '0143: меню пусто — вход в окно у шестерёнки');
  assert.ok(!/Сведения об узле|Редактировать узел|Узел/u.test(module.__nodeMenuLabels().join('|')),
    'старые названия меню ушли');
  for (const needle of ['data-node-tab', 'renderNodeTabs', 'openNodeWindowTab',
    'renderNodePassportTab', 'renderNodeStateTab', 'renderNodeEditModal()']) {
    assert.ok(source.includes(needle), 'окно узла не собрано из вкладок: ' + needle);
  }
  const start = source.indexOf('function renderDetails()');
  const end = source.indexOf('\n        function ', start + 10);
  const details = source.slice(start, end === -1 ? source.length : end);
  for (const gone of ['Источник активности', 'Сессия-владелец', 'Расписание', 'Ветка', 'Пресет', 'Назначение']) {
    assert.ok(!details.includes('"' + gone + '"'), 'строка состояния осталась в низу: ' + gone);
  }
  assert.ok(details.includes('bottomBarItems()'), 'низ берёт подписи из той же функции');
});

/* 0022: сохранение папки — «Сохранить изменения», крестик предлагает сохранить (Да/Нет). */
test('0022: папка сохраняется кнопкой «Сохранить изменения», крестик спрашивает «Сохранить изменения?»', () => {
  const { module } = loadBundle();
  const folder = module.__closeConfirmView('folder');
  assert.equal(folder.title, 'Сохранить изменения?');
  assert.equal(folder.text, 'Сохранить изменения?');
  assert.equal(folder.save, 'Да', '«Да» — сохранить и закрыть');
  assert.equal(folder.discard, 'Нет', '«Нет» — закрыть без сохранения');
  assert.equal(folder.keep, '', 'третьей кнопки нет: выбор только из двух');
  const node = module.__closeConfirmView('node');
  assert.equal(node.save, '', 'у узла сохранения в диалоге крестика нет');
  assert.equal(node.keep, 'Продолжить редактирование');
  assert.equal(node.discard, 'Закрыть без сохранения');
  /* Подпись основной кнопки одна и та же: черновик и объявленная папка. */
  assert.ok(source.includes('}, folderEditorBusy ? "Сохраняю…" : "Сохранить изменения")'),
    'основная кнопка подписана «Сохранить изменения» и в черновике, и в объявленной папке');
  assert.ok(!source.includes('"Создать папку"'), 'прежнее имя «Создать папку» убрано');
  for (const needle of ['function closeConfirmView', 'saveFolderAndClose', '"data-close-save"', 'data-close-confirm']) {
    assert.ok(source.includes(needle), 'в правиле крестика папки нет: ' + needle);
  }
  /* «Да» идёт тем же путём, что основная кнопка: один submitFolderEditor, без второго запроса. */
  const start = source.indexOf('function saveFolderAndClose');
  const end = source.indexOf('\n        function ', start + 10);
  const body = source.slice(start, end === -1 ? source.length : end);
  assert.ok(body.includes('setCloseConfirm(null)'), 'подтверждение закрывается');
  assert.ok(body.includes('submitFolderEditor()'), 'запись — тот же путь, что у основной кнопки');
  assert.ok(!body.includes('fetch('), '«Да» не делает своего запроса');
});

/* C3: крестик без правок закрывает сразу, с правками — диалог подтверждения. */
test('крестик: без правок закрывает сразу, с правками спрашивает подтверждение', () => {
  for (const needle of [
    'requestCloseNodeEditor', 'requestCloseFolderEditor', 'renderCloseConfirm',
    'data-close-confirm', 'data-close-continue', 'data-close-discard',
    'Изменения не сохранятся. Закрыть без сохранения?',
    'Закрыть без сохранения', 'Продолжить редактирование',
    'changedEditorFields', 'editorDraftChanged', 'closeNodeEditor', 'closeFolderEditor',
    'closeConfirmView', 'data-close-confirm-mode',
  ]) {
    assert.ok(source.includes(needle), 'в правиле крестика нет: ' + needle);
  }
  const { module } = loadBundle();
  const base = {
    role: 'критик', model: 'critic', brief: 'проверяет', at: '09:00', withSchedule: false,
    boxPath: 'coordination', boxRoot: 'workspace', participants: ['structure'], contract: 'contract.md', orchestrator: 'coordinator',
  };
  assert.equal(module.__editorDraftChanged(base, { ...base }), false,
    'вернули прежнее значение — диалога не будет');
  assert.equal(module.__editorDraftChanged({ ...base, role: 'исполнитель' }, base), true);
  assert.equal(module.__editorDraftChanged(base, null), false, 'без baseline сравнивать нечего');
  assert.deepEqual(module.__changedEditorFields({ ...base, role: 'исполнитель', brief: 'делает' }, base),
    ['роль', 'назначение'], 'диалог называет несохранённые поля');
  for (const needle of [
    'event.key !== "Escape"', 'setCloseConfirm(null)',
    'if (nodeEditor) { requestCloseNodeEditor(); return; }',
    'if (folderEditor) { requestCloseFolderEditor(); }',
  ]) {
    assert.ok(source.includes(needle), 'Esc ведёт себя как крестик: ' + needle);
  }
});

/* C2: удаление узла из редактора — кнопка, подтверждение, маршрут; координатор защищён. */
test('редактор узла удаляет узел, а координатора не трогает', () => {
  const { module } = loadBundle();
  assert.equal(module.__isCoordinatorNode({ id: 'coordinator', role: 'lead' }), true,
    'id coordinator защищён');
  assert.equal(module.__isCoordinatorNode({ id: 'lead', role: 'координатор' }), true,
    'роль «координатор» защищена');
  assert.equal(module.__isCoordinatorNode({ id: 'critic', role: 'критик' }), false,
    'обычный узел удаляется');
  for (const needle of [
    'Удалить узел', 'data-editor-remove', 'function removeNodeFromEditor',
    '/api/node?root=" + encodeURIComponent(root) + "&action=remove',
    'координатор не удаляется',
    'function requestRemoveNode', 'function cancelRemoveNode',
    '"data-node-delete-ask"', '"data-node-delete-confirm"', '"data-node-delete-cancel"',
    'renderNodeDeleteConfirm()',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  /*
   * Удаление узла спрашивает окном панели, а не window.confirm: браузер
   * молча отвечает «нет», если человек однажды запретил дополнительные
   * диалоги, и кнопка выглядит нерабочей (тот же дефект, что у папки).
   */
  const start = source.indexOf('function requestRemoveNode');
  const end = source.indexOf('\n        function ', start + 10);
  const askBody = source.slice(start, end === -1 ? source.length : end);
  const writeStart = source.indexOf('function removeNodeFromEditor');
  const writeEnd = source.indexOf('\n        function ', writeStart + 10);
  const body = source.slice(writeStart, writeEnd === -1 ? source.length : writeEnd);
  assert.ok(!askBody.includes('window.confirm'), 'первый клик не зовёт системный диалог');
  assert.ok(askBody.includes('setNodeDeleteAsk(true)'), 'первый клик только открывает окно панели');
  assert.ok(!body.includes('window.confirm'), 'удаление узла не зависит от системного диалога');
  assert.ok(body.includes('&action=remove'), 'подтверждение стоит перед action=remove');
  assert.ok(body.includes('isCoordinatorNode'), 'координатор защищён и в клиенте');
  const confirmStart = source.indexOf('function renderNodeDeleteConfirm');
  const confirmEnd = source.indexOf('\n        function ', confirmStart + 10);
  const confirmBody = source.slice(confirmStart, confirmEnd === -1 ? source.length : confirmEnd);
  assert.ok(!confirmBody.includes('window.confirm'), 'в окне подтверждения нет системного диалога');
  assert.ok(confirmBody.includes('"data-node-delete-ask"'), 'окно подтверждения размечено для проверки');
  assert.ok(confirmBody.includes('"data-node-delete-confirm"'), 'в окне есть кнопка удаления');
  assert.ok(confirmBody.includes('"data-node-delete-cancel"'), 'в окне есть кнопка отказа');
});

/* 0170: координатор есть всегда — в пустой структуре карточка виртуальна. */
test('0170: карточка координатора виртуальна, пока узла нет в файле', () => {
  const { module } = loadBundle();
  const empty = { version: 1, nodes: [], folders: [], edges: [] };
  const virtual = module.__coordinatorCard(empty);
  assert.equal(virtual.virtual, true, 'в пустой структуре карточка виртуальна');
  assert.equal(virtual.node.id, 'coordinator');
  assert.equal(virtual.node.role, 'координатор');
  assert.match(virtual.hint, /структура только создана — добавьте узлы/u,
    'подсказка называет следующий шаг');

  const declared = { nodes: [{ id: 'coordinator', role: 'координатор', provider: 'p', model: 'm' }] };
  const real = module.__coordinatorCard(declared);
  assert.equal(real.virtual, false, 'объявленный узел не подменяется виртуальным');
  assert.equal(real.node, declared.nodes[0], 'возвращается сам узел, а не копия');

  const byRole = module.__coordinatorCard({ nodes: [{ id: 'lead', role: 'координатор структуры' }] });
  assert.equal(byRole.virtual, false, 'координатор узнаётся по роли, а не только по id');
  assert.equal(module.__coordinatorCard({}).virtual, true, 'пустой ответ — тоже виртуальная карточка');
  assert.equal(module.__coordinatorCard(undefined).virtual, true, 'без графа панель не падает');

  for (const needle of ['data-coordinator-card', 'renderEmptyCanvas', '"data-empty-structure": "1"']) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  /*
   * Находка info и объект-правка валидатора читаются человеком: severity не
   * выдаётся за warning, а fix не печатается как «[object Object]».
   */
  const infoLine = module.__validatorFindingLine({
    code: 'empty-graph', severity: 'info',
    fix: { kind: 'safe', code: 'add-coordinator', description: 'Добавьте координатора' },
  });
  assert.equal(infoLine.severity, 'info');
  assert.equal(infoLine.fix, 'Добавьте координатора');
});

test('workflowFit: папка обмена не требует ни оценки, ни делегата', () => {
  const { module } = loadBundle();
  const fit = module.__workflowFit({
    nodes: [
      { id: 'coordinator', role: 'координатор' }, { id: 'worker', role: 'исполнитель' },
      { id: 'judge', role: 'приёмщик' }, { id: 'exchange-1', role: 'обмен' },
    ],
    edges: [
      { from: 'coordinator', to: 'worker', kind: 'delegate' },
      { from: 'worker', to: 'judge', kind: 'review' },
    ],
  });
  assert.equal(fit.applicable, true);
  assert.equal(fit.root, 'coordinator', 'папка обмена не считается вторым корнем');
  assert.deepEqual(fit.issues, [], 'папка обмена не требует ни оценки, ни делегата');
  assert.deepEqual(fit.uncovered, []);
});

test('лента порталов: клиент читает folders и рисует по порталу на папку', () => {
  const { module } = loadBundle();
  const data = {
    label: 'structure',
    folders: [
      {
        id: 'folder-1', state: 'portal', contract: true, box: 'C:/coordination',
        participants: ['structure', 'workflow'], outgoing: 2, incoming: 1,
      },
      null,
      { id: 'folder-2', state: 'draft', contract: false, box: 'C:/box', participants: ['structure'], outgoing: -3, incoming: '1' },
    ],
  };
  const folders = module.__exchangeFolders(data);
  assert.equal(folders.length, 2, 'лента берёт только объекты папок');
  assert.equal(module.__exchangeFolders(null).length, 0);
  assert.equal(module.__exchangeFolders({ failed: true, folders: [{ id: 'x' }] }).length, 0,
    'сбойный ответ — не лента порталов');
  assert.equal(module.__folderStateWord(folders[0].state), 'портал');
  assert.equal(module.__folderStateWord('draft'), 'черновик');
  assert.equal(module.__folderStateWord('archive'), 'архив');
  assert.deepEqual(module.__folderSides(folders[0], data), ['workflow'], 'внешняя сторона — без нас');
  assert.deepEqual(module.__folderCounters(folders[1]), { outgoing: 0, incoming: 1 },
    'отрицательное и строковое не выдумывают счётчик');
  const lines = module.__folderPortalLines(folders[0], data);
  assert.ok(lines.some((line) => line.text === 'ящик обмена:'), 'подвал называет ящик');
  assert.ok(module.__folderPortalHeight(folders[0], data) > 100);
  const broken = module.__folderPortalLines({ error: 'папка обмена недоступна: C:/нет' }, data);
  assert.ok(broken.some((line) => /папка обмена недоступна/u.test(line.text)),
    'сломанная папка говорит причиной, а не пустым подвалом');
});

test('кнопка «Принять папку»: приглашённая сторона видит действие accept (задание 0047)', () => {
  const { module } = loadBundle();
  const data = { label: 'split' };
  const invited = {
    id: 'folder-1',
    participants: ['reach', 'split'],
    states: { reach: 'accepted', split: 'invited' },
    self: { label: 'split', path: 'C:/split' },
  };
  const action = module.__folderAcceptAction(invited, data);
  assert.ok(action, 'у приглашённой стороны есть действие');
  assert.equal(action.label, 'Принять папку');
  assert.equal(action.action, 'accept');
  assert.equal(action.id, 'folder-1');
  assert.equal(action.side, 'split', 'действие знает, чья сторона нажимает');
  assert.equal(module.__folderAcceptPath('/w/split', 'folder-1'),
    '/api/folder?action=accept&root=%2Fw%2Fsplit&id=folder-1', 'root и id папки — в запросе');
  assert.equal(module.__folderAcceptAction({ ...invited, states: { reach: 'accepted', split: 'accepted' } }, data), null,
    'у принятой папки кнопки нет');
  assert.equal(module.__folderAcceptAction({ ...invited, states: { reach: 'accepted', split: 'disconnected' } }, data), null,
    'отключённой стороне кнопка не показывается: нужно новое приглашение');
  assert.equal(module.__folderAcceptAction({ ...invited, participants: ['reach', 'other'] }, data), null,
    'чужая папка действия не получает');
  assert.equal(module.__folderAcceptAction({ ...invited, error: 'папка обмена недоступна' }, data), null,
    'сломанная папка действия не даёт');
  assert.equal(module.__folderAcceptAction({ ...invited, self: null }, { label: '' }), null,
    'без своей метки сторона не угадывается');
  assert.equal(module.__folderAcceptAction(invited, { label: '' }).side, 'split',
    'сторона из folder.self сильнее пустой метки ответа');
  assert.equal(module.__folderAcceptNote({ ...invited, states: { split: 'accepted' } }, data), 'папка принята');
  assert.equal(module.__folderAcceptNote(invited, data), '', 'у invited подпись заменяет кнопка');
  assert.match(module.__folderAcceptNote({ ...invited, states: { split: 'disconnected' } }, data), /отключена/u);
});

test('кнопка «Принять папку» в карточке папки: разметка, запрос и перечитывание фактов', () => {
  for (const needle of [
    'Принять папку',
    'action=accept',
    'data-folder-accept',
    'acceptFolder(folderRecord, exchange)',
    'folderRecord',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  const start = source.indexOf('function acceptFolder');
  const end = source.indexOf('function requestRemoveFolder');
  assert.ok(start > 0 && end > start, 'обработчик acceptFolder стоит перед удалением папки');
  const body = source.slice(start, end);
  assert.ok(/method: "POST"/u.test(body), 'действие — POST');
  assert.ok(body.includes('id: action.id'), 'id папки — в теле запроса');
  assert.ok(body.includes('session: sessionId'), 'кто нажал — сессия в теле запроса');
  assert.ok(body.includes('reloadExchange()'), 'после успеха состояние папки перечитывается');
  assert.ok(body.includes('alreadyAccepted'), 'повторное нажатие объясняется словами, а не молчанием');
});

test('лента порталов на канве: папки становятся portals.map', () => {
  for (const needle of [
    'exchangeFolders(exchange)',
    'folders.length > 0',
    'portals.push(',
    'portals.map((item) => renderPortal(item))',
    'portals.map((item) => renderPortalConnector(item))',
    'data-portal-state',
    'folderStateWord',
    'folderSides',
    'folderCounters',
    'folderPortalLines',
    'folderPortalHeight',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  assert.ok(source.includes('data.folders'), 'лента читает именно folders ответа');
});

test('редактор папки: модальное окно с ящиком, метками и контрактом', () => {
  for (const needle of [
    'renderFolderEditor', 'folderEditor', 'openFolderEditor', 'submitFolderEditor',
    'refreshFolderContract', 'removeFolder', 'closeFolderEditor',
    'data-folder-editor', 'data-folder-save', 'data-folder-contract', 'data-folder-remove',
    'data-folder-close', 'requestCloseFolderEditor', 'модальное окно',
    'Участники (метки)', 'путь ящика папки', 'корень ящика папки',
    'имя контракта папки', 'оркестратор папки',
    'Сохранить', 'Уведомить участников', 'Удалить папку',
    /* Задание 0024: участник выбирается из реестра воркспейсов с поиском. */
    'data-participant-registry', 'data-participant-search', 'data-participant-option',
    'реестр воркспейсов', 'поиск участника по реестру воркспейсов', 'свободного ввода нет',
    '/api/folder?root=', '&action=update', '&action=contract', '&action=remove',
    'window.confirm', 'Rev+1', 'письма-приглашения', 'совпадает с воркспейсом',
    'адресата нет', 'изменено · не сохранено',
  ]) {
    assert.ok(source.includes(needle), 'в редакторе папки нет: ' + needle);
  }
  assert.ok(source.includes('renderFolderEditor()'), 'редактор папки выводится на канву');
  /* Поля «Ветки» нет: оно не фильтровало ни чтение, ни доставку. */
  const editorStart = source.indexOf('function renderFolderEditor()');
  const editorEnd = source.indexOf('\n        function ', editorStart + 10);
  const editorBody = source.slice(editorStart, editorEnd === -1 ? source.length : editorEnd);
  assert.ok(!editorBody.includes('Обновить контракт'), 'кнопка не называется «Обновить контракт»');
  assert.ok(editorBody.includes('Уведомить участников'), 'кнопка уведомляет участников, а не «обновляет контракт»');
  assert.ok(!editorBody.includes('Ветки'), 'в редакторе папки нет поля «Ветки»');
  assert.ok(!editorBody.includes('threads'), 'редактор папки не правит threads');
  assert.ok(!editorBody.includes('data-folder-cancel'), '«Отмены» в окне папки нет');
  assert.ok(!editorBody.includes('"Отмена"'), 'крестик заменяет «Отмену» и в папке');
  assert.ok(editorBody.includes('S.modalBackdrop'), 'редактор папки — модальное окно');
  /* Задание 0024: свободного текстового поля метки нет — только реестр с поиском. */
  assert.ok(!editorBody.includes('data-folder-participant'), 'нет кнопки «Добавить метку»');
  assert.ok(!editorBody.includes('"метка участника папки"'), 'нет поля свободного ввода метки');
  assert.ok(!editorBody.includes('setFolderField("participant"'), 'метка не вводится текстом');
  assert.ok(!source.includes('setFolderField("threads"'), 'setFolderField("threads") удалён вместе с полем');
  const removeStart = source.indexOf('function removeFolder()');
  const removeEnd = source.indexOf('\n        function ', removeStart + 10);
  const removeBody = source.slice(removeStart, removeEnd === -1 ? source.length : removeEnd);
  /*
   * Удаление папки спрашивает окном панели, а не window.confirm: браузер
   * молча отвечает «нет», если человек однажды запретил дополнительные
   * диалоги, и кнопка выглядит нерабочей (2026-11-02).
   */
  assert.ok(!removeBody.includes('window.confirm'), 'удаление папки не зависит от системного диалога');
  assert.ok(removeBody.includes('&action=remove'), 'подтверждение стоит перед action=remove');
  assert.ok(source.includes('function requestRemoveFolder('), 'первый клик только спрашивает');
  assert.ok(source.includes('function cancelRemoveFolder('), 'от удаления можно отказаться');
  assert.ok(source.includes('"data-folder-delete-ask"'), 'окно подтверждения размечено для проверки');
  assert.ok(source.includes('"data-delete-confirm"'), 'в окне подтверждения есть кнопка удаления');
  assert.ok(source.includes('"data-delete-cancel"'), 'в окне подтверждения есть кнопка отказа');
});

test('folderEditorDraft и folderBody: черновик папки и тело для POST /api/folder', () => {
  const { module } = loadBundle();
  const draft = module.__folderEditorDraft({
    id: 'folder-1',
    box: { path: 'coordination', root: 'shared' },
    exchange: { threads: ['critic-report', 'daily'], contract: 'team.md' },
    participants: ['C:\\ws\\structure', 'workflow'],
    orchestrator: 'coordinator',
  });
  assert.equal(draft.id, 'folder-1');
  assert.equal(draft.boxPath, 'coordination');
  assert.equal(draft.boxRoot, 'shared');
  assert.deepEqual(draft.participants, ['structure', 'workflow'], 'абсолютный путь сводится к метке');
  assert.equal(draft.threads, undefined, 'черновик не собирает threads: поля нет');
  assert.equal(draft.contract, 'team.md');
  assert.equal(draft.orchestrator, 'coordinator');

  const body = module.__folderBody({
    id: 'folder-2',
    boxPath: ' coordination ',
    boxRoot: 'workspace',
    participants: ['structure', 'workflow'],
    contract: ' contract.md ',
    orchestrator: 'coordinator',
  });
  assert.deepEqual(body, {
    id: 'folder-2',
    box: { path: 'coordination', root: 'workspace' },
    exchange: { contract: 'contract.md' },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
  }, 'тело папки несёт ровно поля записи folders — без threads');
  /* Задание 0024: имя контракта по умолчанию уникально на папку. */
  assert.equal(module.__folderEditorDraft({ id: 'folder-7', participants: ['structure'] }).contract,
    'contract-folder-7.md', 'умолчание — contract-<id>.md');
  assert.equal(module.__folderBody({ id: 'folder-8', boxPath: 'box', participants: ['structure'], contract: '' })
    .exchange.contract, 'contract-folder-8.md', 'пустое имя — умолчание сервера');
  assert.deepEqual(module.__splitList('a, b ,, c'), ['a', 'b', 'c']);
  assert.deepEqual(module.__folderParticipantLabels(['/home/x/kb', 'workflow', 'C:\\ws\\structure']),
    ['kb', 'workflow', 'structure']);
});

test('реестр воркспейсов: список из /api/status и поиск по подстроке', () => {
  const { module } = loadBundle();
  const status = {
    workspaces: [
      { label: 'structure', path: 'C:/ws/structure' },
      { label: 'workflow', path: 'C:/ws/workflow' },
      { label: 'structure', path: 'C:/dup' },
      { label: 'broken' },
      { label: '', path: 'C:/no-label' },
    ],
  };
  const rows = module.__registryWorkspaces(status);
  assert.deepEqual(rows, [
    { label: 'structure', path: 'C:/ws/structure', name: 'structure' },
    { label: 'workflow', path: 'C:/ws/workflow', name: 'workflow' },
  ], 'метки без пути, повторы и без метки не попадают; name — имя каталога');
  assert.deepEqual(module.__filterWorkspaces(rows, 'WORK').map((row) => row.label), ['workflow'],
    'поиск по подстроке без учёта регистра');
  assert.deepEqual(module.__filterWorkspaces(rows, 'STRUCT').map((row) => row.label), ['structure'],
    'поиск по метке без учёта регистра');
  assert.deepEqual(module.__filterWorkspaces(rows, 'ws/'), [],
    'путь не ищется: подстрока в пути ловила бы чужие воркспейсы');
  assert.equal(module.__filterWorkspaces(rows, '').length, 2, 'пустой запрос — весь реестр');
  assert.deepEqual(module.__filterWorkspaces(rows, 'нет такого'), []);
  assert.deepEqual(module.__registryWorkspaces(null), [], 'без реестра список пуст, а не падение');
});

/* Задание 0029: подпись участника — «метка (имя каталога)», неразрешённая метка — «не найден». */
test('подпись участника: «метка (имя каталога)» и пометка неразрешённой', () => {
  const { module } = loadBundle();
  const registry = module.__registryWorkspaces({
    workspaces: [
      { label: 'kb', path: 'C:/ws/knowledge-base', name: 'knowledge-base' },
      { label: 'structure', path: 'C:/ws/structure' },
    ],
  });
  assert.equal(module.__participantLabel(registry[0]), 'kb (knowledge-base)', 'метка и имя каталога');
  assert.equal(module.__participantLabel({ label: 'structure', path: 'C:/ws/structure' }),
    'structure (structure)', 'имя каталога берётся из пути, если name не пришло');
  assert.equal(module.__participantRows(registry, [])[0].found, false, 'без участников строк нет');

  const rows = module.__participantRows(['structure', 'struktura'], registry);
  assert.deepEqual(rows[0], {
    label: 'structure', name: 'structure', path: 'C:/ws/structure', found: true, similar: [],
  }, 'найденная метка несёт абсолютный путь для title');
  assert.equal(rows[1].found, false, 'метка вне реестра помечена неразрешённой');
  assert.equal(rows[1].path, '', 'у неразрешённой нет пути — выдумывать нельзя');
  assert.ok(rows[1].similar.includes('structure'), 'похожие метки: ' + JSON.stringify(rows[1].similar));
});

test('вынос «Папки» из библиотеки создаёт папку запросом, а не узел', () => {
  const { module } = loadBundle();
  const draft = module.__libraryFolderDraft([{ id: 'folder-1' }, { id: 'folder-3' }], 'coordinator', 'structure');
  assert.equal(draft.id, 'folder-2', 'id — первый свободный folder-N');
  assert.equal(draft.boxPath, 'coordination');
  assert.equal(draft.boxRoot, 'workspace', 'ящик внутри воркспейса разрешается без второго участника');
  assert.deepEqual(draft.participants, ['structure']);
  assert.equal(draft.orchestrator, 'coordinator');
  assert.equal(draft.contract, 'contract-folder-2.md', 'умолчание — contract-<id>.md');

  assert.ok(source.includes('function placeFolderFromLibrary'), 'вынос папки — своей функцией');
  const start = source.indexOf('function placeFolderFromLibrary');
  const end = source.indexOf('\n        function ', start + 10);
  const body = source.slice(start, end === -1 ? source.length : end);
  assert.ok(body.includes('/api/folder?root='), 'папка создаётся своим маршрутом');
  assert.ok(body.includes('&action=add'), 'вынос зовёт action=add');
  assert.ok(!body.includes('/api/node'), 'папка не пишется узлом');
  assert.ok(source.includes('if (item.type === "folder")'), 'вынос папки отделён от узла');
});

test('клик по порталу открывает редактор папки', () => {
  for (const needle of [
    'function openPortal',
    'openFolderEditor(folder.id)',
    'onClick: () => openPortal(portal)',
    'openPortal(portal)',
    'редактор папки: ящик, участники, контракт',
  ]) {
    assert.ok(source.includes(needle), 'портал не ведёт в редактор: ' + needle);
  }
  /* Клик по порталу без папки открывает редактор с черновиком, а факты — кнопкой в нём. */
  assert.ok(source.includes('folderEditorDraft(null'), 'легаси-портал открывает черновик папки');
  assert.ok(source.includes('data-folder-facts'), 'список фактов остаётся доступен из редактора');
  assert.ok(source.includes('openExchangeFromPortal('), 'список фактов не удалён из панели');
});

/* C3: клик по легаси-порталу (folder нет) открывает редактор с черновиком папки. */
test('folderDraftFromPortal: черновик папки из портала в любом воркспейсе', () => {
  const { module } = loadBundle();
  /* Портала нет, контекста нет: заготовка всё равно пригодна для создания папки. */
  const empty = module.__folderDraftFromPortal(null);
  assert.equal(empty.id, 'folder-1', 'id черновика — folder-1');
  assert.equal(empty.boxPath, 'coordination', 'ящик по умолчанию — coordination');
  assert.equal(empty.boxRoot, 'workspace', 'ящик внутри воркспейса');
  assert.equal(empty.orchestrator, 'coordinator', 'оркестратор по умолчанию — coordinator');
  assert.equal(empty.contract, 'contract-folder-1.md', 'умолчание — contract-<id>.md');
  assert.deepEqual(empty.participants, [], 'без метки участников нет — её даёт контекст');

  /* Контекст воркспейса: текущая метка, занятые id и оркестратор. */
  const draft = module.__folderDraftFromPortal(null, {
    label: 'structure',
    folders: [{ id: 'folder-1' }, { id: 'folder-2' }],
    orchestrator: 'coordinator',
  });
  assert.equal(draft.id, 'folder-3', 'id — первый свободный folder-N');
  assert.deepEqual(draft.participants, ['structure'], 'участник — текущая метка воркспейса');
  assert.equal(draft.orchestrator, 'coordinator');

  /* Формы вызова, которые использует панель и проверки: (null, {...}), ({...}), (label). */
  assert.equal(module.__folderEditorDraft(null, { label: 'workflow' }).participants[0], 'workflow',
    'folderEditorDraft(null) собирает черновик из портала');
  assert.equal(module.__folderEditorDraft(null).id, 'folder-1');
  assert.equal(module.__folderDraftFromPortal({ label: 'C:\\ws\\workflow' }).participants[0], 'workflow',
    'абсолютный путь сводится к метке');
  assert.equal(module.__folderDraftFromPortal('workflow').participants[0], 'workflow');
  /* Объявленная папка идёт своим черновиком, а не заготовкой. */
  const declared = module.__folderDraftFromPortal({
    folder: { id: 'folder-9', box: { path: 'box', root: 'shared' }, participants: ['structure', 'workflow'] },
  });
  assert.equal(declared.id, 'folder-9');
  assert.equal(declared.boxPath, 'box');
  assert.equal(declared.boxRoot, 'shared');
});

/* Тест на повторное открытие: закрытие сбрасывает поповер, а не портал. */
test('toggleFolderEditor/reopenFolderEditor: повторное открытие редактора папки после closeFolderEditor', () => {
  const { module } = loadBundle();
  const folder = {
    id: 'folder-1',
    box: { path: 'coordination', root: 'shared' },
    exchange: { threads: ['critic-report'] },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
  };
  const opened = module.__folderEditorToggle(null, folder);
  assert.equal(opened.id, 'folder-1', 'закрытый редактор открывается');
  assert.deepEqual(opened.participants, ['structure', 'workflow']);
  assert.equal(module.__toggleFolderEditor(opened, folder), null, 'клик по тому же порталу закрывает');
  const reopened = module.__folderEditorOpen(null, folder);
  assert.equal(reopened.id, 'folder-1', 'после закрытия клик снова открывает меню');
  assert.equal(module.__folderEditorOpen(null, folder).id, 'folder-1');
  assert.equal(module.__folderEditorOpen(folder).id, 'folder-1', 'форма с одной папкой тоже работает');
  assert.equal(module.__folderEditorToggle(null, null), null);
  assert.equal(module.__toggleFolderEditor(opened, folder), null, 'старое имя остаётся живым');
  assert.ok(source.includes('toggleFolderEditor(folderEditor, folder)'), 'openPortal использует переключатель');
});

test('clampPopover удерживает поповер внутри видимого поля', () => {
  const { module } = loadBundle();
  const viewport = { width: 1000, height: 800 };
  assert.deepEqual(module.__clampPopover(100, 100, 360, 400, viewport), { left: 100, top: 100 },
    'помещающийся поповер не двигается');
  assert.deepEqual(module.__clampPopover(-40, -10, 360, 400, viewport), { left: 8, top: 56 },
    'минимум 8 px слева и безопасная зона под кнопками окна сверху');
  assert.deepEqual(module.__clampPopover(900, 700, 360, 400, viewport),
    { left: 1000 - 360 - 120, top: 800 - 400 - 8 }, 'правый край не заезжает под кнопки, нижний — в поле');
  assert.deepEqual(module.__clampPopover(0, 0, 2000, 2000, viewport), { left: 8, top: 56 },
    'поповер больше поля остаётся у верхнего левого угла, но ниже кнопок');
  assert.deepEqual(module.__clampPopover(10, 10, 100, 100, { innerWidth: 320, innerHeight: 240 }),
    { left: 10, top: 56 }, 'размер окна принимается и как innerWidth/innerHeight');
  /*
   * 0143: у правого меню больше нет точки позиционирования — clampPopover
   * остаётся чистым правилом для поповеров, а не частью меню узла.
   */
  assert.ok(!source.includes('contextMenuAnchor'), 'меню узла больше не позиционируется');
});

/* C1: безопасная зона под кнопками сворачивания/закрытия окна DSH (правый верхний угол). */
test('clampPopover не заходит в безопасную зону под кнопками окна', () => {
  const { module } = loadBundle();
  const viewport = { width: 1280, height: 720 };
  const width = 360;
  const height = 420;
  /* Левый верхний угол всегда ниже зоны кнопок — даже если карточка у самого верха. */
  for (const top of [-50, 0, 12, 40, 55]) {
    const anchor = module.__clampPopover(20, top, width, height, viewport);
    assert.ok(anchor.top >= module.__POPOVER_SAFE_TOP,
      'верх поповера не под кнопками окна: top ' + anchor.top + ' при исходном ' + top);
  }
  /* Правый край не заезжает под кнопки, когда поповер ещё можно сдвинуть. */
  for (const left of [700, 900, 1100, 2000]) {
    const anchor = module.__clampPopover(left, 120, width, height, viewport);
    assert.ok(anchor.left + width <= viewport.width - module.__POPOVER_SAFE_RIGHT,
      'правый край поповера не под кнопками: left ' + anchor.left);
    assert.ok(anchor.left >= 8, 'левый край остаётся в поле');
  }
  assert.equal(module.__POPOVER_SAFE_TOP, 56, 'зона кнопок по высоте — 56 px');
  assert.equal(module.__POPOVER_SAFE_RIGHT, 120, 'зона кнопок по ширине — 120 px');
  assert.ok(source.includes('POPOVER_SAFE_TOP = 56'), 'безопасная зона сверху объявлена константой');
  assert.ok(source.includes('POPOVER_SAFE_RIGHT = 120'), 'безопасная зона справа объявлена константой');
});

/* Задание 0034: три состояния движка в полосе, слово в слово. */
test('движок здесь: «движок: vX (здесь)»', () => {
  assert.ok(source.includes('payload.engine.mode === "local"'), 'локальное состояние выбирается по mode, а не по deployed');
  assert.ok(source.includes('" (здесь)"'), 'локальный движок помечен «(здесь)»');
  assert.ok(source.includes('"движок: v"'), 'текст локального движка начинается с «движок: v»');
});

/* Задание 0043: для внешнего движка панель называет его репозиторий, а не «здесь». */
test('движок внешний: панель читает engineScope и называет репозиторий движка', () => {
  assert.ok(source.includes('engineScope'), 'панель читает engineScope из ответа проверки');
  assert.ok(source.includes('обновляется в репозитории движка'), 'для внешнего движка назван его репозиторий');
  const at = source.indexOf('обновляется в репозитории движка');
  const window = source.slice(Math.max(0, at - 500), at + 320);
  assert.ok(window.includes('engineScope.path'), 'рядом назван абсолютный путь репозитория из engineScope');
});

test('движок здесь: строка свежести и «(здесь)» не потеряны', () => {
  assert.ok(source.includes('engineScope.mode === "local"'), 'локальный движок отличается по engineScope');
  assert.ok(source.includes('движок обновляется здесь'), 'для локального движка строка свежести говорит «здесь»');
  assert.ok(source.includes('" (здесь)"'), 'пометка «(здесь)» сохранена');
});

test('движок внешний: путь, версия и карта, кнопка развернуть неактивна', () => {
  assert.ok(source.includes('payload.engine.mode === "mapped"'), 'внешнее состояние выбирается по mode');
  assert.ok(source.includes('"движок внешний · v"'), 'человеку сказано, что движок внешний');
  assert.ok(source.includes('" · карта ~/.dsh/workflow/engine-roots.json"'), 'названа карта, по которой найден движок');
  assert.ok(source.includes('"разворачивается в репозитории движка, а не здесь"'), 'сказано, почему кнопка неактивна');
  const mapped = source.slice(source.indexOf('payload.engine && payload.engine.mode === "mapped"'),
    source.indexOf('payload.engine && payload.engine.mode === "absent"'));
  assert.ok(mapped.includes('disabled: true'), 'для mapped кнопка «Развернуть» отключена');
});

test('движка нет: два равноправных предложения, без слов тревоги', () => {
  for (const text of [
    'движок не найден',
    'Развернуть здесь',
    'или укажите карту ~/.dsh/workflow/engine-roots.json, если движок уже развёрнут в другом репозитории',
  ]) {
    assert.ok(source.includes(text), 'нет согласованного текста: «' + text + '»');
  }
  /* Та же проверка, что c3: в окне вокруг «движок не найден» нет признаков ошибки. */
  const at = source.indexOf('движок не найден');
  const window = source.slice(Math.max(0, at - 600), at + 1200).toLowerCase();
  for (const word of ['ошибка', 'ошибку', 'тревог', 'alert']) {
    assert.ok(!window.includes(word), 'в блоке отсутствующего движка есть признак ошибки: «' + word + '»');
  }
  assert.ok(!window.includes('t.danger'), 'отсутствие движка не рисуется красным');
  assert.ok(!window.includes('s.error'), 'отсутствие движка не рисуется плашкой ошибки');
});

test('прежнее поведение для старых ответов без mode сохранено', () => {
  assert.ok(source.includes('"движок не развёрнут"'), 'старый ответ без mode по-прежнему читается панелью');
  assert.ok(source.includes('payload.engine.deployed'), 'поле deployed остаётся запасным признаком');
});

/* Задание 0035: у связи есть источник, и человек читает его словами. */
test('движок из конфига и из панели различимы по источнику', () => {
  assert.ok(source.includes('payload.engine.source === "config"'), 'источник config читается с сервера');
  assert.ok(source.includes('"задано конфигом профиля"'), 'связь из конфига названа словами');
  assert.ok(source.includes('payload.engine.source === "mapping"'), 'источник mapping отличается от config');
  assert.ok(source.includes('"выбрано в панели"'), 'связь из карты названа словами');
  assert.ok(source.includes('" · карта ~/.dsh/workflow/engine-roots.json"'), 'карта названа только для mapping');
});

test('движка нет: «не подключён» и два действия, прежняя формулировка — подсказка', () => {
  assert.ok(source.includes('"движок не подключён"'), 'видимый текст — «движок не подключён»');
  assert.ok(source.includes('"движок не найден ни здесь'), 'прежняя формулировка осталась в title');
  const at = source.indexOf('движок не подключён');
  const window = source.slice(Math.max(0, at - 800), at + 1600).toLowerCase();
  for (const word of ['ошибка', 'ошибку', 'тревог', 'danger', '#ec1313']) {
    assert.ok(!window.includes(word), 'в блоке отсутствия есть признак тревоги: «' + word + '»');
  }
  const actions = source.slice(at, at + 2400).toLowerCase();
  for (const text of ['Развернуть здесь', 'Подключить существующий']) {
    assert.ok(actions.includes(text.toLowerCase()), 'рядом видно действие: «' + text + '»');
  }
  assert.ok(source.includes('"панель эти файлы не пишет."'), 'человеку сказано, кто пишет конфиг и карту');
  /*
   * D2: два РАВНЫХ действия. Одинаковый стиль кнопок и ключи React у элементов
   * списка: иначе человек читает одну кнопку главной, а вторую — второстепенной.
   */
  const absentBlock = source.slice(at, at + 2400);
  const primary = (absentBlock.match(/style: S\.buttonPrimary/g) || []).length;
  assert.ok(primary >= 2, 'оба действия absent одного веса: найдено ' + primary);
  for (const key of ['key: "deploy-here"', 'key: "connect-existing"']) {
    assert.ok(absentBlock.includes(key), 'у кнопки списка есть ключ React: ' + key);
  }
});

/*
 * Задание 0042. Свойства узла показывают не абстрактный алиас, а настоящую
 * модель: маршрут, разрешённый службой llm (modelRoute), и честный статус.
 * Пропавшая модель — ошибка с рецептом, а не молчаливая подстановка дефолта.
 */
test('свойства узла читают modelRoute: алиас, provider/model, семейство, статус', () => {
  assert.ok(source.includes('modelRoute'), 'панель читает разрешённый маршрут узла');
  assert.ok(source.includes('nodeModelView'), 'маршрут узла собирается для карточки и диалога');
  assert.ok(source.includes('модель не найдена в каталоге'), 'пропавшая модель названа прямо');
  assert.ok(source.includes('каталог моделей недоступен'), 'недоступный каталог назван прямо');
  const { module } = loadBundle();
  const available = module.__modelRouteView({
    alias: 'work', provider: 'opencode', model: 'deepseek-v4.1-flash', family: 'deepseek', status: 'available',
  });
  assert.equal(available.kind, 'available');
  assert.ok(available.text.includes('work') && available.text.includes('opencode/deepseek-v4.1-flash'));
  assert.ok(available.text.includes('семейство deepseek'), 'семейство видно при наличии');
  assert.equal(available.hint, '');

  const missing = module.__modelRouteView({
    alias: 'critic', provider: 'opencode', model: 'gone', family: null, status: 'missing',
    reason: 'модели «gone» нет у провайдера «opencode» в каталоге службы llm',
  });
  assert.equal(missing.kind, 'missing');
  assert.match(missing.text, /model|opencode\/gone/u);
  assert.match(missing.hint, /модель не найдена в каталоге/u);
  assert.match(missing.hint, /opencode\/gone/u, 'что именно пропало');
  assert.match(missing.hint, /выберите модель из списка/u, 'что делать');

  const unknown = module.__modelRouteView({
    alias: 'work', provider: 'opencode', model: 'm1', family: null, status: 'unknown',
    reason: 'служба llm не подключена',
  });
  assert.equal(unknown.kind, 'unknown');
  assert.match(unknown.hint, /каталог моделей недоступен/u);
  assert.match(unknown.text, /каталог моделей недоступен/u);
});

test('редактор модели не подставляет провайдера и модель за человека', () => {
  assert.ok(!/provider:\s*first\.id/u.test(source), 'первый провайдер больше не подставляется');
  assert.ok(!/\(availableModels \|\| \[\]\)\[0\]/u.test(source), 'первая доступная модель не берётся молча');
  assert.ok(!/providerInfo\.models\[0\]/u.test(source), 'первая модель провайдера не подставляется молча');
  const { module } = loadBundle();
  const catalog = [{ id: 'opencode', name: 'OpenCode', models: [{ id: 'deepseek-v4.1-flash', family: 'deepseek' }] }];

  const empty = module.__builderModelDraft({ provider: '', model: '', family: '' }, catalog);
  assert.ok(empty.error, 'пустой выбор — отказ');
  assert.match(empty.error.message, /выберите модель из списка/u);

  const onlyProvider = module.__builderModelDraft({ provider: 'opencode', model: '', family: '' }, catalog);
  assert.ok(onlyProvider.error, 'один провайдер без модели — тоже отказ, а не первая модель');
  assert.match(onlyProvider.error.message, /выберите модель из списка/u);

  const chosen = module.__builderModelDraft({ provider: 'opencode', model: 'deepseek-v4.1-flash', family: '' }, catalog);
  assert.deepEqual(chosen, { provider: 'opencode', model: 'deepseek-v4.1-flash', family: 'deepseek' });

  const gone = module.__builderModelDraft({ provider: 'opencode', model: 'gone', family: '' }, catalog);
  assert.ok(gone.error);
  assert.match(gone.error.message, /модель не найдена в каталоге/u);
});

/*
 * Задание 0050. Карточка узла выбирает провайдера и модель из ЖИВОГО каталога
 * (/api/models): поля «алиас» больше нет, пустой выбор — отказ «выберите модель
 * из списка», пропавшая модель названа прямо. Первая модель не подставляется.
 */
test('карточка узла: селекторы «Провайдер» и «Модель», поля алиаса нет', () => {
  const start = source.indexOf('function renderNodeEditModal()');
  const end = source.indexOf('\n        function ', start + 10);
  const body = source.slice(start, end === -1 ? source.length : end);
  for (const needle of [
    '"Провайдер"', '"Модель"',
    'провайдер узла в редакторе', 'модель узла в редакторе',
    'выберите провайдера', 'выберите модель из списка',
    'availableModels', 'модель не найдена в каталоге',
  ]) {
    assert.ok(body.includes(needle), 'в карточке узла нет: ' + needle);
  }
  assert.ok(!body.includes('graph.models'), 'карточка узла больше не читает models{}');
  assert.ok(!body.includes('modelAlias'), 'поле алиаса в карточке отсутствует');
  assert.ok(!body.includes('aliases.map'), 'список алиасов заменён каталогом');

  const openStart = source.indexOf('function openNodeEditor');
  const openEnd = source.indexOf('\n        function ', openStart + 10);
  const openBody = source.slice(openStart, openEnd === -1 ? source.length : openEnd);
  assert.ok(openBody.includes('refreshModelCatalog()'), 'каталог перечитывается при открытии карточки');

  const submitStart = source.indexOf('function submitNodeEditor');
  const submitEnd = source.indexOf('\n        function ', submitStart + 10);
  const submitBody = source.slice(submitStart, submitEnd === -1 ? source.length : submitEnd);
  assert.ok(submitBody.includes('nodeModelChoice'), 'сохранение проверяет пару по каталогу');
  assert.ok(submitBody.includes('provider:'), 'сохранение пишет provider в узел');
  assert.ok(submitBody.includes('family:'), 'сохранение пишет family в узел');
  assert.ok(!/model:\s*exchange\s*\?\s*""\s*:\s*String\(draft\.model/u.test(submitBody),
    'сохранение не отправляет старое поле model как алиас');
});

test('выбор модели узла: пустой выбор и пропавшая модель — отказ, первая не подставляется', () => {
  const { module } = loadBundle();
  const catalog = [{
    id: 'opencode', name: 'OpenCode',
    models: [{ id: 'deepseek-v4.1-flash', family: 'deepseek' }, { id: 'glm-5.3-flash' }],
  }];

  const empty = module.__nodeModelChoice(catalog, '', '');
  assert.ok(empty.error, 'пустой выбор — отказ');
  assert.match(empty.error.message, /выберите модель из списка/u);
  assert.ok(!empty.provider && !empty.model, 'пустой выбор не превращается в первую модель');

  const providerOnly = module.__nodeModelChoice(catalog, 'opencode', '');
  assert.ok(providerOnly.error, 'провайдер без модели — тоже отказ');
  assert.match(providerOnly.error.message, /выберите модель из списка/u);

  const gone = module.__nodeModelChoice(catalog, 'opencode', 'gone');
  assert.ok(gone.error);
  assert.match(gone.error.message, /модель не найдена в каталоге/u);
  assert.match(gone.error.message, /opencode\/gone/u);

  const chosen = module.__nodeModelChoice(catalog, 'opencode', 'deepseek-v4.1-flash', '');
  assert.deepEqual(chosen, { provider: 'opencode', model: 'deepseek-v4.1-flash', family: 'deepseek' },
    'выбранная пара пишется прямо, семейство берётся из каталога');
  assert.ok(!source.includes('aliases[0]'), 'первая модель не подставляется молча из models{}');
});

/*
 * Задание 0092: режим императива — отображение, а не блокировка. Панель
 * называет fail/warn словами режима, off — «императив ослаблен», а старый
 * ответ без enforcement не порождает строки и не роняет панель.
 */
test('enforcementView: fail, warn и off названы словами', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.__enforcementView, 'function', 'экспорт __enforcementView');
  const fail = module.__enforcementView({ enforcement: { mode: 'fail', source: 'config' } });
  assert.equal(fail.level, 'ok');
  assert.match(fail.text, /fail/u, 'режим fail назван');
  assert.match(fail.text, /нативный обход отклоняется/u, 'человеку сказано, что делает fail');

  const warn = module.__enforcementView({ enforcement: { mode: 'warn', source: 'config' } });
  assert.equal(warn.level, 'pilot');
  assert.match(warn.text, /warn/u, 'режим warn назван');
  assert.match(warn.text, /пилот/u, 'warn назван пилотом');

  const off = module.__enforcementView({ enforcement: { mode: 'off', source: 'config' } });
  assert.equal(off.level, 'weak');
  assert.match(off.text, /императив ослаблен/u, 'off помечен «императив ослаблен»');
  assert.match(off.text, /off/u, 'режим off назван');
});

test('enforcementView: старый ответ без enforcement строки не порождает', () => {
  const { module } = loadBundle();
  assert.equal(module.__enforcementView({ graph: { nodes: [] }, exists: true }), null);
  assert.equal(module.__enforcementView(null), null);
  assert.equal(module.__enforcementView({ enforcement: null }), null);
  assert.equal(module.__enforcementView({ enforcement: { mode: 'неизвестный' } }), null, 'неизвестный режим не выдумывается');
});

test('строка режима стоит рядом со схемой: off заметно, fail нейтрально', () => {
  const start = source.indexOf('function renderEnforcement()');
  assert.ok(start !== -1, 'нет renderEnforcement');
  const end = source.indexOf('\n        function ', start + 10);
  const body = source.slice(start, end === -1 ? source.length : end);
  assert.ok(body.includes('data-enforcement-mode'), 'строке режима есть чем себя опознать');
  assert.match(body, /view\.level === "weak" \? T\.danger/u, 'off помечен цветом danger');
  assert.match(body, /: T\.secondary/u, 'fail остаётся нейтральным');
  const call = source.indexOf('renderEnforcement(),');
  const canvas = source.indexOf('renderCanvas(),');
  assert.ok(call !== -1 && canvas !== -1 && call < canvas, 'строка режима выведена перед схемой');
});

/*
 * Задание 0097: корешок свёрнутой палитры и барьер «воркспейс | вне».
 * Числа и решения — из макета docs/design/palette-nodes-2026-11-05.md (§3–§6)
 * и выбора заказчика 2026-11-05 (надпись снизу вверх, три иконки, 20…360).
 * Панель пользуется этими же функциями: проверка не дублирует расчёт.
 */
test('корешок: три иконки при любом числе узлов и надпись снизу вверх', () => {
  const { module } = loadBundle();
  const palette = module.__palette;
  assert.ok(palette, 'экспорт __palette');
  assert.equal(palette.SPINE_WIDTH, 44, 'полоса корешка 44 px');
  assert.equal(palette.SPINE_LABEL, 'Набор узлов структуры');
  for (const count of [0, 3, 30]) {
    const nodes = Array.from({ length: count }, (_, index) => ({ id: 'n' + index, role: 'worker' }));
    const icons = palette.spineIcons(nodes);
    assert.equal(icons.length, 3, 'при ' + count + ' узлах иконок ровно три');
    assert.deepEqual(icons.map((icon) => icon.role), ['critic', 'worker', 'folder'],
      'порядок ролей: критик, воркер, папка');
    for (const icon of icons) {
      assert.equal(icon.size, 32, 'иконка 32×32: ' + icon.role);
      assert.equal(typeof icon.icon, 'string', 'у иконки есть глиф');
      assert.ok(icon.stripe, 'полоса роли у иконки: ' + icon.role);
    }
  }
  assert.equal(palette.spineIcons([]).length, 3, 'пустая структура не убирает иконки');
  assert.ok(source.includes('writingMode: "vertical-rl"') && source.includes('transform: "rotate(180deg)"'),
    'надпись корешка читается снизу вверх');
  assert.ok(source.includes('textOverflow: "ellipsis"') && source.includes('SPINE_LABEL'),
    'надпись обрезается многоточием и названа словами');
  assert.ok(!/transition:[^\n]*width/u.test(source), 'ширина палитры не анимируется');
  assert.ok(source.includes('spineIcons('), 'панель пользуется spineIcons, а не своим списком');
});

test('барьер: clampOutside 20…360, шаг 8 от минимума, Shift 1', () => {
  const { module } = loadBundle();
  const palette = module.__palette;
  assert.equal(palette.OUTSIDE_MIN, 20, 'минимум 20');
  assert.equal(palette.OUTSIDE_MAX, 360, 'максимум 360');
  assert.equal(palette.OUTSIDE_STEP, 8, 'шаг 8');
  const cases = [
    [undefined, undefined, 20],
    [null, undefined, 20],
    [0, undefined, 20],
    [20, undefined, 20],
    [24, undefined, 20],
    [25, undefined, 28],
    [37, undefined, 36],
    [120, undefined, 120],
    [360, undefined, 360],
    [400, undefined, 360],
    [119.4, 1, 119],
  ];
  for (const [value, step, want] of cases) {
    assert.equal(palette.clampOutside(value, step), want,
      'clampOutside(' + String(value) + ', ' + String(step) + ')');
  }
  assert.ok(source.includes('clampOutside('), 'панель зажимает просвет той же функцией');
  assert.ok(source.includes('role: "separator"') && source.includes('"aria-orientation": "vertical"'),
    'барьер — разделитель с aria');
  assert.ok(source.includes('"aria-valuetext"') && source.includes('aria-valuenow'),
    'значение озвучивается словами');
  assert.ok(source.includes('setPointerCapture') && source.includes('requestAnimationFrame'),
    'перенос идёт pointer-capture и rAF');
  assert.ok(source.includes('onDoubleClick: resetOutsideByDoubleClick'), 'двойной щелчок сбрасывает просвет');
  assert.ok(source.includes('"ArrowLeft"') && source.includes('"Home"') && source.includes('"End"'),
    'клавиатура барьера: стрелки, Home, End');
});

test('вторая колонка порталов: N ≥ 2 и 536/512 с гистерезисом', () => {
  const { module } = loadBundle();
  const palette = module.__palette;
  assert.equal(palette.TWO_COLUMNS_NEED, 536);
  assert.equal(palette.TWO_COLUMNS_HYSTERESIS, 24);
  assert.equal(palette.PORTAL_COLUMN_GUTTER, 16);
  const cases = [
    [0, 800, 1, 1],
    [1, 800, 1, 1],
    [2, 600, 1, 2],
    [3, 540, 1, 2],
    [2, 536, 1, 2],
    [2, 530, 1, 1],
    [2, 530, 2, 2],
    [2, 500, 2, 1],
    [2, 600, 2, 2],
  ];
  for (const [count, width, current, want] of cases) {
    assert.equal(palette.portalColumns(count, width, current), want,
      'portalColumns(' + count + ', ' + width + ', ' + current + ')');
  }
  assert.equal(palette.outsideZoneWidth(1), 284, 'зона «вне» в одну колонку: 48 + 236');
  assert.equal(palette.outsideZoneWidth(2), 536, 'зона «вне» в две колонки: 48 + 236 + 16 + 236');
  assert.ok(source.includes('portalColumns('), 'панель считает колонки той же функцией');
  assert.ok(source.includes('barrierColumns'), 'на время переноса колонки заморожены');
  assert.ok(source.includes('pg-outside-pane') && source.includes('pg-workspace-pane'),
    'aria-controls разделителя ведёт на две группы');
  assert.ok(source.includes('portalColumnLineD'), 'линия второй колонки входит в верхнюю грань');
});

test('мусор в хранилище: умолчания, зажим и счёт по корню', () => {
  const { module } = loadBundle();
  const palette = module.__palette;
  assert.equal(palette.UI_STORAGE_KEY, 'dsh.project-graph.ui.v1');
  const defaults = palette.parseUiState(null, 'C:/w');
  assert.equal(defaults.libraryOpen, true, 'первый вход — развёрнуто');
  assert.equal(defaults.outside, 20, 'первый вход — просвет 20');
  assert.equal(palette.parseUiState('{не json', 'C:/w').outside, 20, 'битый JSON → умолчания');
  assert.equal(palette.parseUiState('undefined', 'C:/w').libraryOpen, true, 'не JSON → умолчания');
  assert.equal(palette.parseUiState(JSON.stringify({ v: 2, libraryOpen: false }), 'C:/w').libraryOpen, true,
    'чужой v → умолчания');
  const restored = palette.parseUiState(JSON.stringify({ v: 1, libraryOpen: false, outside: { 'C:/w': 120 } }), 'C:/w');
  assert.equal(restored.libraryOpen, false, 'свёрнутое состояние восстановлено');
  assert.equal(restored.outside, 120, 'просвет восстановлен');
  assert.equal(palette.parseUiState(JSON.stringify({ v: 1, outside: { 'C:/w': 120 } }), 'D:/other').outside, 20,
    'просвет хранится на воркспейс, а не общий');
  assert.equal(palette.parseUiState(JSON.stringify({ v: 1, outside: { 'C:/w': 1000 } }), 'C:/w').outside, 360,
    'сохранённое значение зажимается');
  assert.equal(palette.parseUiState(JSON.stringify({ v: 1, outside: { 'C:/w': 'abc' } }), 'C:/w').outside, 20,
    'нечисло не превращается в 0');
  assert.ok(source.includes('uiStore.read('), 'панель читает состояние тем же разбором');
  assert.ok(source.includes('useState(() => uiStore.read(null).libraryOpen)'),
    'состояние читается синхронно в инициализаторе, без useEffect');
});

/* C3 задания 0082: подпись счётчика — «непрочитано N», честная и при нуле. */
test('счётчик непрочитанных: «непрочитано N» и «непрочитано 0» (задание 0082)', () => {
  const { module } = loadBundle();
  assert.equal(module.__unreadLabel(0), 'непрочитано 0', 'ноль — честная подпись');
  assert.equal(module.__unreadLabel(1), 'непрочитано 1');
  assert.equal(module.__unreadLabel(3), 'непрочитано 3');
  assert.equal(module.__unreadLabel(12), 'непрочитано 12');
  assert.equal(module.__unreadLabel(-2), 'непрочитано 0', 'отрицательное число не обещает лишнего');
  assert.equal(module.__unreadLabel('7'), 'непрочитано 7', 'число из JSON тоже читается');
  assert.equal(module.__unreadLabel(undefined), 'непрочитано 0');
  assert.equal(module.__unreadTotal({ unread: { total: 3, folders: [] } }), 3, 'счётчик читается из поля unread');
  assert.equal(module.__unreadTotal({ unread: { total: 0 } }), 0, 'ноль — число, а не «нет данных»');
  assert.equal(module.__unreadTotal({}), null, 'без поля unread панель не выдумывает ноль');
  assert.equal(module.__unreadTotal(null), null);
});

test('счётчик непрочитанных: карточка «Внешняя связь» и заголовок показывают подпись (задание 0082)', () => {
  for (const needle of [
    '__unreadLabel = unreadLabel',
    'unreadLabel(unread)',
    'unreadLabel(total)',
    'data-exchange-unread',
    'data-panel-unread',
    'renderUnreadChip()',
    '/api/exchange',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  /* Подпись стоит в карточке «Внешняя связь» и в заголовке панели. */
  const cardAt = source.indexOf('function renderExchange()');
  const cardEnd = source.indexOf('function renderLegend()', cardAt);
  assert.ok(cardAt > 0 && cardEnd > cardAt, 'карточка обмена — своя функция');
  const card = source.slice(cardAt, cardEnd);
  assert.ok(card.includes('"Внешняя связь"'), 'карточка обмена на месте');
  assert.ok(card.includes('unreadLabel(unread)'), 'карточка обмена показывает счётчик');
  assert.ok(card.includes('data-exchange-unread'), 'число карточки размечено для проверки');
  const barAt = source.indexOf('Структура проекта');
  const bar = source.slice(barAt, barAt + 700);
  assert.ok(bar.includes('renderUnreadChip()'), 'заголовок панели показывает счётчик');
  assert.ok(source.includes('function renderUnreadChip()'), 'счётчик заголовка — своей функцией');
});

/*
 * C4 заданий 0128 и 0130: окно 14 суток и подпись просроченных. Задание 0130
 * назвало единицу измерения: «просрочено 3» рядом с «непрочитано 3» читалось как
 * счётчик писем, а не дней.
 */
test('__staleLabel: «просрочено N дн.», ноль — пустая подпись (задания 0128, 0130)', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.__staleLabel, 'function');
  assert.equal(module.__staleLabel(0), '', 'ноль не занимает место у счётчика');
  assert.equal(module.__staleLabel(1), 'просрочено 1 дн.');
  assert.equal(module.__staleLabel(3), 'просрочено 3 дн.', 'дни названы: без «дн.» число путается со счётчиком писем');
  assert.equal(module.__staleLabel(-2), '');
  assert.equal(module.__staleLabel(undefined), '');
  assert.equal(module.__staleLabel('7'), 'просрочено 7 дн.', 'число из JSON тоже читается');
});

test('__closeAck: тело ack-письма с Reply-To полным путём (задание 0128)', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.__closeAck, 'function');
  const body = module.__closeAck({
    path: 'threads/x/letter.md', from: 'workflow', to: 'structure', subject: 'Вопрос', thread: 'x',
  });
  assert.match(body, /^Format: dsh-exchange\/1$/mu);
  assert.match(body, /^Status: ack$/mu);
  assert.match(body, /^Reply-To: threads\/x\/letter\.md$/mu, 'Reply-To — полный путь от папки обмена');
  assert.match(body, /^To: workflow$/mu, 'To — автор заявки');
  assert.match(body, /^From: structure$/mu, 'From — наша метка (адресат заявки)');
  assert.match(body, /^Thread: x$/mu);
  assert.match(body, /^Subject: Закрыто: Вопрос$/mu);
  assert.ok(body.includes('закрыто без ответа'), 'тело — одна строка причины');
});

test('карточка «Внешняя связь»: stale и кнопка «Закрыть» (задание 0128)', () => {
  for (const needle of [
    '__staleLabel = staleLabel',
    '__closeAck = closeAck',
    'data-exchange-stale',
    'staleLabel(stale)',
    'data-exchange-close',
    '/api/exchange/close',
    '"Закрыть"',
    'closeAck({',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  const cardAt = source.indexOf('function renderExchange()');
  const cardEnd = source.indexOf('function renderLegend()', cardAt);
  assert.ok(cardAt > 0 && cardEnd > cardAt, 'карточка обмена — своя функция');
  const card = source.slice(cardAt, cardEnd);
  assert.ok(card.includes('staleChip'), 'карточка показывает просроченные');
  assert.ok(card.includes('closeExchangeLetter(fact)'), 'кнопка закрывает заявку тем же маршрутом');
  assert.ok(card.includes('fact.attention'), 'кнопка стоит у заявки, а не у любой строки');
});

/* C3 задания 0105: подпись версии — две формы, ровно как ждёт проверка. */
test('__releaseLabel: «доступна Y» при отставании и «актуальна» иначе (задание 0105)', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.__releaseLabel, 'function');
  assert.equal(module.__releaseLabel({ current: '1.0.9', latest: '1.0.10', outdated: true }),
    'структура 1.0.9 · доступна 1.0.10');
  assert.equal(module.__releaseLabel({ current: '1.0.10', latest: '1.0.10', outdated: false }),
    'структура 1.0.10 · актуальна');
  assert.equal(module.__releaseLabel({ current: '1.0.9', outdated: true }),
    'структура 1.0.9 · актуальна', 'без latest подпись не выдумывает версию');
  assert.equal(module.__releaseLabel(null), 'структура неизвестно · актуальна');
});

/*
 * C3 задания 0105 (в редакции 0107, место — 0185): версия structure живёт в
 * полосе обновлений. Подпись — общая releaseLabel, действие — releaseAction;
 * повтор и обновление — те же checkRelease/updateRelease, сбой проверки и
 * отказ обновления показаны словами.
 */
test('полоса обновлений: подпись версии, повтор и обновление structure (0105/0107/0185)', () => {
  for (const needle of [
    'function renderUpdatesBar()',
    'function structureUpdateView()',
    '/api/release',
    '/api/release/update',
    'releaseUpdate.status === "refused"',
    'release.status === "error"',
    '__releaseLabel = releaseLabel',
    '__releaseAction = releaseAction',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  const viewAt = source.indexOf('function structureUpdateView()');
  const viewEnd = source.indexOf('function workflowUpdateView()', viewAt);
  assert.ok(viewAt > 0 && viewEnd > viewAt, 'блок structure — своя функция');
  const view = source.slice(viewAt, viewEnd);
  assert.ok(view.includes('check: checkRelease'), 'повтор проверки — та же функция');
  assert.ok(view.includes('apply: updateRelease'), 'обновление — своя функция');
  assert.ok(view.includes('releaseAction({'), 'подпись действия берётся у __releaseAction');
  assert.ok(view.includes('releaseLabel({'), 'подпись версии берётся у __releaseLabel');
  assert.ok(view.includes('release.status === "error"'), 'сбой проверки даёт причину, а не пустую строку');
  assert.ok(view.includes('releaseUpdate.status === "refused"'), 'отказ обновления — состояние ошибки');
  /* Проверка релиза не идёт при открытии панели: только по кнопке. */
  assert.ok(source.includes('function checkRelease()'));
  assert.ok(!/React\.useEffect\(\(\) => \{ checkRelease\(\); \}, \[\]\)/u.test(source),
    'проверка релиза не запускается сама при открытии');
});

/* C4 задания 0107: действие карточки — по режиму установки, не по догадке. */
test('__releaseAction: «Обновить из репозитория» для link, «Обновить» для пакета, актуально — нет действия (задание 0107)', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.__releaseAction, 'function');
  assert.deepEqual(module.__releaseAction({ mode: 'link', current: '1.0.10', latest: '1.0.11', outdated: true }),
    { enabled: true, label: 'Обновить из репозитория' });
  assert.deepEqual(module.__releaseAction({ mode: 'package', current: '1.0.10', latest: '1.0.11', outdated: true }),
    { enabled: true, label: 'Обновить' });
  assert.deepEqual(module.__releaseAction({ mode: 'link', current: '1.0.11', latest: '1.0.11', outdated: false }),
    { enabled: false });
  assert.deepEqual(module.__releaseAction({ current: '1.0.9', outdated: true }),
    { enabled: true, label: 'Обновить' }, 'без режима — пакетное действие, как раньше');
  assert.deepEqual(module.__releaseAction({}), { enabled: false });
  assert.deepEqual(module.__releaseAction(null), { enabled: false });
});

test('полоса обновлений: подпись «Обновить» для structure идёт через __releaseAction (0107/0185)', () => {
  for (const needle of ['__releaseAction = releaseAction', 'action.label', 'action.enabled', 'value.mode === "link"']) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  const viewAt = source.indexOf('function structureUpdateView()');
  const viewEnd = source.indexOf('function workflowUpdateView()', viewAt);
  const view = source.slice(viewAt, viewEnd);
  assert.ok(view.includes('releaseAction({'), 'полоса зовёт общую функцию действия');
  assert.ok(!view.includes('release.canUpdate'), 'действие не решается по canUpdate: у ссылки оно есть');
  assert.ok(view.includes('action.label'), 'подпись кнопки — из действия');
  assert.ok(source.includes('view.applyLabel'), 'кнопка берёт подпись из модели');
});

/*
 * C1 задания 0177: вид узла «Аудитор задач». Вид отвечает за роль и
 * назначение. С 0188 аудитор — седьмая карточка NODE_LIBRARY, и реестр видов
 * строится из тех же карточек: вид и плитка не расходятся.
 */
test('__nodeKinds: аудитор задач в палитре видов (задание 0177)', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.__nodeKinds, 'function', 'нет __nodeKinds');
  const kinds = module.__nodeKinds();
  assert.ok(Array.isArray(kinds), '__nodeKinds отдаёт массив');
  const auditor = kinds.find((kind) => kind && kind.id === 'auditor');
  assert.ok(auditor, 'аудитора нет среди видов: ' + JSON.stringify(kinds));
  assert.equal(auditor.role, 'Аудитор задач');
  assert.match(String(auditor.brief || ''), /якор/iu, 'назначение аудитора — проверка по якорям');
  for (const id of ['critic', 'worker', 'folder', 'reviewer', 'tester', 'release']) {
    assert.ok(kinds.some((kind) => kind && kind.id === id), 'вид пропал из реестра: ' + id);
  }
  assert.equal(kinds.filter((kind) => kind && kind.id === 'auditor').length, 1,
    'аудитор в реестре видов ровно один раз: вид и карточка — одно объявление');
  assert.equal(module.__libraryItems().length, 7, 'седьмая карточка — аудитор (0188)');
  assert.ok(source.includes('__nodeKinds = nodeKinds'), 'реестр видов экспортирован');
});

/*
 * 0185: полоса обновлений. Модель проверяется без DOM — та же, что рисует
 * панель: размещение 38 px под шапкой, фиксированный порядок блоков и
 * «Проверить всё»; пять состояний и причина у disabled-кнопки; три раскладки.
 */
test('0185: __updateStrip — полоса 38 px под шапкой, порядок structure→workflow, «Проверить всё»', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.__updateStrip, 'function', 'нет __updateStrip');
  const strip = module.__updateStrip();
  assert.equal(strip.placement, 'below-header');
  assert.equal(strip.height, 38);
  assert.deepEqual(strip.order, ['structure', 'workflow']);
  assert.equal(strip.action, 'check-all');
  /* Модель отдаётся копией: правка ответа не меняет следующий кадр панели. */
  strip.order.push('лишний');
  assert.deepEqual(module.__updateStrip().order, ['structure', 'workflow']);
});

test('0185: __updateBlockState — пять состояний, у disabled «Обновить» причина в title', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.__updateBlockState, 'function', 'нет __updateBlockState');
  for (const state of ['actual', 'available', 'checking', 'error', 'updated']) {
    const view = module.__updateBlockState({ state });
    assert.equal(view.state, state);
    assert.equal(typeof view.update, 'boolean', state + ': update не boolean');
    assert.equal(typeof view.updateTitle, 'string', state + ': updateTitle не строка');
    assert.ok(view.updateTitle.length > 0, state + ': у кнопки нет причины');
    assert.equal(typeof view.tone, 'string');
    assert.ok(view.tone.length > 0, state + ': нет тона');
  }
  const actual = module.__updateBlockState({ state: 'actual', versions: { current: '1.0.56', latest: '1.0.56' } });
  assert.equal(actual.update, false, 'актуально: обновлять нечего');
  assert.match(actual.updateTitle, /1\.0\.56/u);
  const available = module.__updateBlockState({ state: 'available', versions: { current: '1.0.58', latest: '1.0.59' } });
  assert.equal(available.update, true, 'доступна: кнопка активна');
  assert.match(available.updateTitle, /1\.0\.59/u);
  const checking = module.__updateBlockState({ state: 'checking' });
  assert.equal(checking.update, false, 'проверка: обновлять рано');
  assert.match(checking.updateTitle, /проверк/u);
  const failure = module.__updateBlockState({
    state: 'error',
    reason: { code: 'store-mismatch', message: 'store v10 ≠ v11', fix: 'выполните pnpm install' },
  });
  assert.equal(failure.update, false, 'ошибка: кнопка disabled');
  assert.match(failure.updateTitle, /store v10 ≠ v11 — выполните pnpm install/u);
  assert.doesNotMatch(module.__updateBlockState({ state: 'error' }).updateTitle, /^$/u, 'без причины title не пуст');
  const updated = module.__updateBlockState({ state: 'updated' });
  assert.equal(updated.update, false, 'обновлено: до перезапуска обновлять нечего');
  assert.match(updated.updateTitle, /перезапуст/u);
  assert.equal(module.__updateBlockState({}).state, 'actual', 'неизвестное состояние не бросает');
});

test('0185: __updateStripLayout — full ≥1100, compact 1000–1100, chip <1000', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.__updateStripLayout, 'function', 'нет __updateStripLayout');
  assert.equal(module.__updateStripLayout(1248).mode, 'full');
  assert.equal(module.__updateStripLayout(1100).mode, 'full');
  assert.equal(module.__updateStripLayout(1099).mode, 'compact');
  assert.equal(module.__updateStripLayout(1000).mode, 'compact');
  assert.equal(module.__updateStripLayout(999).mode, 'chip');
  assert.equal(module.__updateStripLayout(760).mode, 'chip');
});

test('0185: полоса нарисована под шапкой панели, вне канвы, и экспортирует модель', () => {
  for (const needle of [
    'function renderUpdatesBar()',
    'renderUpdatesBar()',
    'data-updates-bar',
    'data-update-block',
    'data-update-state',
    'data-updates-check-all',
    '__updateStrip = updateStrip',
    '__updateBlockState = updateBlockState',
    '__updateStripLayout = updateStripLayout',
  ]) {
    assert.ok(source.includes(needle), 'в клиенте нет: ' + needle);
  }
  const callAt = source.indexOf('renderUpdatesBar(),');
  const guardAt = source.indexOf('h(RenderGuard');
  assert.ok(callAt > 0 && callAt < guardAt, 'полоса рисуется выше тела панели (канвы)');
  const barAt = source.indexOf('function renderUpdatesBar()');
  const barEnd = source.indexOf('function renderWorkflowStrip()', barAt);
  const bar = source.slice(barAt, barEnd);
  assert.ok(bar.includes('updateStripLayout('), 'раскладка решается общей функцией');
  assert.ok(bar.includes('"data-updates-bar": "1"'), 'у полосы есть адрес');
  assert.ok(bar.includes('"data-updates-check-all": "1"'), '«Проверить всё» — действие полосы');
  const blockAt = source.indexOf('function renderUpdateBlock(');
  const blockEnd = source.indexOf('function renderUpdatesBar()', blockAt);
  const blockSource = source.slice(blockAt, blockEnd);
  assert.ok(blockSource.includes('"data-update-block": view.id'), 'у блока есть адрес проверки');
  assert.ok(blockSource.includes('"data-update-state": view.state'), 'состояние блока читается атрибутом');
  assert.ok(blockSource.includes('title: view.updateTitle'), 'у каждой disabled-кнопки — причина');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('CLIENT TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);