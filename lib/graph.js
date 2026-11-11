/**
 * The structure model: pure functions over plain values.
 *
 * A project declares its structure in structure/*.json. Every file is one
 * fragment: models (alias -> provider/model), nodes (who is in the structure),
 * folders (where the shared exchange boxes are) and edges (how the nodes
 * relate). Fragments are merged, so the structure may outgrow one file without
 * changing the schema.
 *
 * A folder is not a node: nodes are agents only. A folder has a box, the
 * participants of the channel and an orchestrator — the declared node that
 * speaks for the folder. The link to the orchestrator is a field, not an edge:
 * it has no direction to draw.
 *
 * Nothing here touches the filesystem, DSH or the network: parse, merge,
 * validate and lay out. The HTTP half reads files; this module decides what
 * they mean.
 *
 * Vocabulary:
 *   delegate - directed, one node hands work to another; layout layers follow
 *              these edges and cycles are refused;
 *   review   - directed, the target judges the source's work;
 *   report   - directed, the target receives the source's result without judging
 *              it (a return to the owner of the work);
 *   peer     - undirected collaboration, legal in cycles.
 *
 * The structure may be flat: no root is required, and a graph may have several
 * roots, none, or only peer links.
 */
import { isValidTimeZone, parseTimeOfDay } from './schedule.js';

export const GRAPH_VERSION = 1;
export const EDGE_KINDS = ['delegate', 'review', 'peer', 'report'];
export const NODE_ID = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Координатор есть всегда (задание 0175, решение D1).
 *
 * Его нет в палитре, потому что он — отправная точка воркспейса, а не узел,
 * который можно забыть. Поэтому чтение не ждёт объявления: buildGraph добавляет
 * узел coordinator с пометкой implicit, как только структура объявила хотя бы
 * один узел (пустая канва рисует виртуальную карточку, 0170), а
 * ensureCoordinator сохраняет его в файл при записи узла. Поля сида объявлены
 * здесь один раз — копий быть не должно.
 */
export const COORDINATOR_SEED = Object.freeze({
  id: 'coordinator',
  role: 'координатор',
  brief: 'ведёт план и раздаёт работу',
});

/** Слова роли координатора: id coordinator и роль со словом «координатор». */
const COORDINATOR_WORDS = Object.freeze(['координатор', 'coordinator']);

/** Алиас маршрута по умолчанию: так объявлена стартовая структура панели. */
const DEFAULT_COORDINATOR_MODEL_ALIAS = 'work';

/** Роль для сравнения: регистр, «ё» и лишние пробелы не важны. */
function normalizeRoleName(value) {
  return text(value).toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
}

/** Узел — координатор: id coordinator или роль со словом «координатор». */
export function isCoordinatorNode(node) {
  if (!isPlainObject(node)) return false;
  const id = text(node.id).toLowerCase();
  if (id === 'coordinator' || id === 'координатор') return true;
  const role = normalizeRoleName(node.role);
  return COORDINATOR_WORDS.some((word) => role === word || role.includes(word));
}

/**
 * Координатор в копии графа: если его нет — узел добавляется последним.
 *
 * Возвращается копия: исходный объект вызывающий не получает права менять через
 * ответ. Объявленный координатор не трогается — какой есть, такой и остаётся.
 *
 * Маршрут нового узла — «по умолчанию»: provider/model из defaults (второй
 * аргумент), иначе алиас work из graph.models, иначе узел остаётся без маршрута.
 * Придумывать провайдера нельзя: чужой provider упадёт уже в сессии.
 *
 * @param graph - граф { nodes, models?, edges?, folders? } или что угодно.
 * @param defaults - { provider?, model?, implicit? }: маршрут seed-узла и
 *   пометка «добавлен чтением, а не объявлен файлом».
 * @returns копия графа: { ...graph, nodes: [...] }.
 */
export function ensureCoordinator(graph, defaults = {}) {
  const source = isPlainObject(graph) ? graph : {};
  const nodes = Array.isArray(source.nodes) ? source.nodes.slice() : [];
  if (nodes.some((node) => isPlainObject(node) && isCoordinatorNode(node))) {
    return { ...source, nodes };
  }
  const input = isPlainObject(defaults) ? defaults : {};
  const node = { ...COORDINATOR_SEED };
  if (input.implicit === true) node.implicit = true;
  const provider = text(input.provider);
  const model = text(input.model);
  if (provider && model) {
    node.provider = provider;
    node.model = model;
  } else {
    const models = isPlainObject(source.models) ? source.models : {};
    const alias = Object.hasOwn(models, DEFAULT_COORDINATOR_MODEL_ALIAS)
      ? models[DEFAULT_COORDINATOR_MODEL_ALIAS]
      : null;
    if (isPlainObject(alias) && text(alias.provider) && text(alias.model)) {
      node.model = DEFAULT_COORDINATOR_MODEL_ALIAS;
    }
  }
  nodes.push(node);
  return { ...source, nodes };
}

/** Пять состояний структуры — словарь единого предиката (0176, D1). */
export const STRUCTURE_KINDS = Object.freeze(['new', 'empty', 'partial', 'broken', 'full']);

/**
 * Класс состояния структуры — один предикат вместо локальных развилок (0176, D1).
 *
 * Повторявшийся симптом («структура пуста») чинили пятью задачами, потому что
 * каждая ветка называла пустоту по-своему: нет каталога, нет файлов, только
 * служебные, nodes: []. Теперь пустота — класс состояния, и все пути (чтение,
 * сборка, валидация) выбирают диагноз по одному предикату:
 *
 *   new     — фрагментов нет вовсе: проект только создан (каталога может не быть);
 *   empty   — фрагменты прочитаны, но ни одного узла не объявлено (nodes: []);
 *   partial — узлы объявлены, объявленного координатора нет: его добавило чтение;
 *   broken  — есть ошибки разбора или формы: это поломка, а не пустота;
 *   full    — координатор объявлен файлом, граф собран без ошибок.
 *
 * @param files - прочитанные фрагменты. Не массив — «наличие файлов неизвестно»
 *   (валидатор получает уже собранный граф): тогда пустой граф — empty, а не new.
 * @param built - результат buildGraph: { graph, errors }.
 * @returns Одно из STRUCTURE_KINDS.
 */
export function classifyStructure(files, built = {}) {
  const source = isPlainObject(built) ? built : {};
  const errors = Array.isArray(source.errors) ? source.errors : [];
  if (errors.length > 0) return 'broken';
  if (Array.isArray(files) && files.length === 0) return 'new';
  const graph = isPlainObject(source.graph) ? source.graph : {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const declared = nodes.filter((node) => isPlainObject(node) && !node.implicit);
  if (declared.length === 0) return 'empty';
  if (declared.some((node) => isCoordinatorNode(node))) return 'full';
  return 'partial';
}

/**
 * Recipes for the folder errors: a code names the problem, the fix says what to
 * change. Exported, so the HTTP half shows the same words as the model.
 */
export const FOLDER_REMEDIES = {
  'folder-as-node': 'Перенесите папку из nodes в отдельный список folders: '
    + '{ "id": "folder-1", "box": { "path": "coordination", "root": "shared" }, '
    + '"participants": ["structure", "workflow"], "orchestrator": "coordinator" }.',
  'invalid-folders': 'Сделайте folders массивом папок обмена: [ { "id": "folder-1", "box": … } ].',
  'invalid-folder': 'Опишите папку объектом с полями id, box, participants, orchestrator.',
  'invalid-folder-id': 'Используйте в id папки латиницу, цифры, точку, дефис или подчёркивание, без пробелов.',
  'duplicate-folder': 'Оставьте одну папку с таким id: объедините фрагменты или переименуйте.',
  'folder-box': 'Задайте папке box — относительный путь к ящику обмена: '
    + '{ "path": "coordination", "root": "shared" } или строкой "coordination".',
  'folder-box-root': 'Поставьте box.root: "shared" (общий корень участников) или "workspace" (внутри своего воркспейса).',
  'folder-participants': 'Перечислите в participants хотя бы один воркспейс — метку (structure) или абсолютный путь; '
    + 'это обязательное поле папки.',
  'folder-orchestrator': 'Добавьте папке orchestrator — id объявленного узла-оркестратора: '
    + 'связь папки с агентом задаётся полем, а не ребром.',
  'folder-orchestrator-unknown': 'Исправьте orchestrator: укажите id узла, объявленного в nodes этой структуры.',
};

/**
 * A node may carry its own prompt: the role and Definition of Done in words.
 * The validator does not refuse a node without it — the structure stays valid —
 * and it must not sound like a requirement: node.prompt is not read at run time
 * (the task travels through the spawn call), and the role is usually already
 * said by brief. So the recipe is offered as an option, not as a duty: the
 * owner writes the Definition of Done down only if he wants it fixed in words.
 */
export const PROMPT_REMEDY = 'prompt необязателен: на запуск он не влияет — задачу передаёт вызов запуска. '
  + 'Если хотите зафиксировать Definition of Done словами — допишите prompt (≥40 символов): '
  + '{ "id": "worker", "prompt": "Роль: … Definition of Done: …" }.';

/**
 * Recipe for a broken fallbackModel. The value is the identifier the provider
 * accepts, not an alias of models{}: an alias is expanded for model only, and
 * the scheduler asks the provider for the second attempt with this exact name.
 */
export const FALLBACK_MODEL_REMEDY = 'fallbackModel — имя модели провайдера, не алиас models{}: '
  + 'укажите идентификатор, который примет провайдер, например '
  + '{ "id": "critic", "fallbackModel": "deepseek-v4.1-flash" }.';

/**
 * Recipe for a broken reportThread (0200). A branch is one path segment, not a
 * path: the exchange writer joins it under threads/, so «/» and «..» would move
 * the letter outside its box. The default role branch is not named here as a
 * requirement — without the field the report keeps going where it went before.
 */
export const REPORT_THREAD_REMEDY = 'reportThread — имя ветки обмена одним сегментом: '
  + '{ "id": "tester-1", "reportThread": "exchange" }. Без «/», «..» и пробелов по краям; '
  + 'без поля отчёт уходит в ветку роли (tester-report).';

/**
 * Дисциплина узла: сколько его сессий живёт одновременно (задание 0136).
 *
 * refuse (по умолчанию) — вторая сессия занятого узла отвергается с советом;
 * queue — задача не стартует, а встаёт в очередь стора до освобождения узла;
 * parallel — до max (1..4) сессий одной роли. Режим проверяется в структуре,
 * а не угадывается при запуске: опечатка иначе молча отменила бы правило
 * «одна роль — одна дисциплина».
 */
export const CONCURRENCY_MODES = ['refuse', 'queue', 'parallel'];

/** Рецепт ошибки concurrency: что написать в structure/*.json. */
export const CONCURRENCY_REMEDY = 'Объявите режим занятости узла: '
  + '{ "concurrency": { "mode": "refuse" } } — вторая сессия занятого узла отвергается (по умолчанию), '
  + '{ "concurrency": { "mode": "queue" } } — задача ждёт в очереди, '
  + 'или { "concurrency": { "mode": "parallel", "max": 2 } } — до 4 одновременных сессий.';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** An error or a warning: a stable code for tests, a sentence for people. */
function note(code, message, extra = {}) {
  return { code, message, ...extra };
}

/**
 * Legacy tolerance: old structures declared the exchange folder as a node with
 * the role "обмен". Such a node is no longer a folder — a folder lives in
 * folders — but a person migrating a structure should not be drowned in "no
 * model" and "isolated" warnings about a leftover. The migration itself is
 * reported once, by the structure error, not by agent diagnostics.
 */
function isExchangeNode(node) {
  return Boolean(node) && /обмен/iu.test(text(node.role));
}

/** Family of a model route: its own family when declared, else its provider. */
function familyOfModel(entry) {
  if (!isPlainObject(entry)) return '';
  return text(entry.family) || text(entry.provider);
}

/**
 * Family of a node route: the same rule as an alias. The family is a wish for
 * the panel, not a schema field with its own lookup table.
 */
function familyOfNode(node) {
  if (!isPlainObject(node)) return '';
  return text(node.family) || text(node.provider);
}

/**
 * Якоря узла (0192): какие якоря узел читает (consumes) и какие объявляет
 * (produces). Ссылка — непустой id строкой или объект { id, stage?, scope? };
 * переходное имя consumers читается как consumes, в графе остаётся canonical
 * consumes. Ссылки сохраняются в том виде, в каком объявлены: строки остаются
 * строками, объекты — объектами, потому что файл структуры — источник правды,
 * а гейт привязки (lib/anchors.js) понимает обе формы.
 */
function normalizeNodeAnchors(raw) {
  const errors = [];
  const anchors = {};
  for (const kind of ['consumes', 'produces']) {
    const declared = kind === 'consumes' && raw.consumes === undefined && raw.consumers !== undefined
      ? raw.consumers
      : raw[kind];
    if (declared === undefined) continue;
    if (!Array.isArray(declared)) {
      errors.push(kind + ' — не список ссылок на якоря');
      continue;
    }
    const list = [];
    declared.forEach((ref, index) => {
      const at = kind + '[' + index + ']';
      if (typeof ref === 'string') {
        const id = ref.trim();
        if (!id) {
          errors.push(at + ': пустой id якоря — на такой нельзя сослаться');
          return;
        }
        list.push(id);
        return;
      }
      if (!isPlainObject(ref)) {
        errors.push(at + ': ссылка на якорь — непустой id строкой или объект { id, stage }');
        return;
      }
      const id = text(ref.id);
      if (!id) {
        errors.push(at + ': пустой id якоря — на такой нельзя сослаться');
        return;
      }
      const entry = { id };
      if (text(ref.stage)) entry.stage = text(ref.stage);
      if (text(ref.scope)) entry.scope = text(ref.scope);
      list.push(entry);
    });
    anchors[kind] = list;
  }
  return { ok: errors.length === 0, errors, anchors };
}

/**
 * Merge and validate the fragments of one structure.
 *
 * @param files - an array of { name, text }: name is the path shown in
 *   messages, text the raw JSON.
 * @param options - { version } overrides the accepted schema version;
 *   { dirName } names the folder in messages.
 * @returns The merged graph, every error, every warning, the fragment list and
 *   the family of every model alias.
 */
export function buildGraph(files, options = {}) {
  const version = options.version === undefined ? GRAPH_VERSION : options.version;
  const dirName = options.dirName || 'structure';
  const errors = [];
  const warnings = [];
  const sources = [];
  const models = {};
  const nodes = [];
  const folders = [];
  const edges = [];
  const nodeIndex = new Map();
  const folderIndex = new Map();
  /*
   * Признак «nodes объявлен массивом» — не то же самое, что «узлов нет»:
   * явно пустой список (nodes: []) — это новый проект, а отсутствие поля —
   * структура, которая не сказала состав (задание 0171).
   */
  let nodesDeclared = false;

  const list = Array.isArray(files) ? files : [];
  /*
   * 0176: пустота — класс состояния, а не отдельная ветка. Нет ни одного
   * фрагмента (каталога нет или он пуст, служебные файлы отбросил readStructure)
   * — это новый проект: предупреждение, чтобы панель показала координатора и
   * предложила стартовую структуру. Ошибкой остаётся только случай, когда файлы
   * есть, но не собираются (битый JSON): там виноват разбор, а не пустота.
   * Ветка не возвращает результат: координатор добавляется ниже, одним местом,
   * и на пустом графе тоже.
   */
  if (list.length === 0) {
    warnings.push(note('empty-graph', options.missingDir === true
      ? 'в проекте нет папки ' + dirName + '/: это новый проект — создайте ' + dirName
        + '/graph.json, координатор уже есть'
      : 'в ' + dirName + '/ нет ни одного *.json: структура только создана — это новый проект, добавьте координатора'));
  }

  for (const file of list) {
    const name = text(file && file.name) || '(без имени)';
    let parsed;
    try {
      parsed = JSON.parse(String((file && file.text) || ''));
    } catch (err) {
      errors.push(note('invalid-json', 'файл не разбирается как JSON: ' + (err && err.message ? err.message : 'ошибка'), { file: name }));
      continue;
    }
    if (!isPlainObject(parsed)) {
      errors.push(note('invalid-fragment', 'фрагмент должен быть JSON-объектом', { file: name }));
      continue;
    }
    if (parsed.version !== undefined && Number(parsed.version) !== Number(version)) {
      errors.push(note('unsupported-version',
        'версия схемы ' + String(parsed.version) + ', поддерживается ' + String(version), { file: name }));
    }

    const source = { file: name, models: 0, nodes: 0, folders: 0, edges: 0 };

    if (parsed.models !== undefined) {
      if (!isPlainObject(parsed.models)) {
        errors.push(note('invalid-models', 'models должен быть объектом «алиас -> маршрут»', { file: name }));
      } else {
        for (const [alias, entry] of Object.entries(parsed.models)) {
          const key = text(alias);
          if (!key) {
            errors.push(note('invalid-model-alias', 'пустой алиас модели', { file: name }));
            continue;
          }
          if (!isPlainObject(entry)) {
            errors.push(note('invalid-model', 'модель «' + key + '» должна быть объектом', { file: name }));
            continue;
          }
          const provider = text(entry.provider);
          const model = text(entry.model);
          if (!provider || !model) {
            errors.push(note('invalid-model',
              'у модели «' + key + '» нужны непустые provider и model', { file: name }));
            continue;
          }
          const next = { provider, model };
          if (text(entry.family)) next.family = text(entry.family);
          const previous = models[key];
          if (previous && (previous.provider !== next.provider || previous.model !== next.model
            || (previous.family || '') !== (next.family || ''))) {
            errors.push(note('model-conflict',
              'алиас «' + key + '» объявлен по-разному в разных фрагментах', { file: name, model: key }));
            continue;
          }
          models[key] = next;
          source.models += 1;
        }
      }
    }

    if (parsed.nodes !== undefined) {
      if (!Array.isArray(parsed.nodes)) {
        errors.push(note('invalid-nodes', 'nodes должен быть массивом', { file: name }));
      } else {
        nodesDeclared = true;
        for (const raw of parsed.nodes) {
          if (!isPlainObject(raw)) {
            errors.push(note('invalid-node', 'узел должен быть объектом', { file: name }));
            continue;
          }
          const id = text(raw.id);
          if (!id || !NODE_ID.test(id)) {
            errors.push(note('invalid-node-id',
              'идентификатор узла: латиница, цифры, точка, дефис, подчёркивание, без пробелов: «' + id + '»',
              { file: name }));
            continue;
          }
          /*
           * Папка обмена — не узел графа: структура объявляет папки отдельным
           * списком folders. Прежняя форма (kind: "folder" или поля папки на
           * узле) отвергается с рецептом, а не превращается молча в агента.
           */
          const folderMark = text(raw.kind) === 'folder';
          const folderFields = ['box', 'participants', 'exchange', 'orchestrator', 'threads']
            .filter((field) => raw[field] !== undefined);
          if (folderMark || folderFields.length > 0) {
            const why = [
              folderMark ? 'kind: "folder"' : '',
              folderFields.length > 0 ? 'поля ' + folderFields.join(', ') : '',
            ].filter(Boolean).join(', ');
            errors.push(note('folder-as-node',
              'узел «' + id + '» объявлен папкой (' + why + '): папка — не узел графа, '
                + 'перенесите её в отдельный список folders',
              { file: name, node: id, fix: FOLDER_REMEDIES['folder-as-node'] }));
            continue;
          }
          if (nodeIndex.has(id)) {
            errors.push(note('duplicate-node',
              'узел «' + id + '» объявлен дважды (' + nodeIndex.get(id).file + ' и ' + name + ')',
              { file: name, node: id }));
            continue;
          }
          const node = { id, file: name };
          /*
           * kind у узла — только "agent" (по умолчанию). Папку узлом объявить
           * нельзя: её место — список folders.
           */
          if (raw.kind !== undefined) {
            const kind = text(raw.kind);
            if (kind !== 'agent') {
              errors.push(note('invalid-kind',
                'у узла «' + id + '» kind может быть только "agent": папка объявляется в списке folders, а не узлом',
                { file: name, node: id }));
            } else {
              node.kind = kind;
            }
          }
          if (text(raw.role)) node.role = text(raw.role);
          /*
           * session — необязательная привязка узла к сессии-владельцу: по ней отчёт
           * доставляется точно, а без неё доставка идёт спавном от живой сессии.
           */
          if (raw.session !== undefined) {
            if (typeof raw.session !== 'string' || raw.session.trim() === '') {
              errors.push(note('invalid-session',
                'у узла «' + id + '» session должен быть непустой строкой с идентификатором сессии',
                { file: name, node: id }));
            } else {
              node.session = raw.session.trim();
            }
          }
          if (text(raw.brief)) node.brief = text(raw.brief);
          /*
           * prompt — роль и Definition of Done словами. Пустой prompt не ошибка
           * структуры: узел действителен, но диагностика ниже просит дописать
           * рецепт, иначе агент узнаёт роль только из памяти сессии.
           */
          if (text(raw.prompt)) node.prompt = text(raw.prompt);
          /*
           * Маршрут модели живёт в узле: provider + model (+ family). У старых
           * графов model хранил имя алиаса models{}: такой узел разворачивается
           * ниже, когда прочитаны все фрагменты, — файл не переписывается.
           */
          if (text(raw.provider)) node.provider = text(raw.provider);
          if (text(raw.model)) node.model = text(raw.model);
          if (text(raw.family)) node.family = text(raw.family);
          /*
           * fallbackModel — модель второй попытки окна (задание 0110). Читается
           * так же строго, как model: значение — имя модели провайдера, а не
           * алиас models{}, потому что планировщик передаёт его провайдеру как
           * есть. Битое значение — ошибка структуры с рецептом, а узел строится
           * без поля: маршрут остаётся рабочим, но человек видит, что править.
           */
          if (raw.fallbackModel !== undefined) {
            if (typeof raw.fallbackModel !== 'string' || raw.fallbackModel.trim() === '') {
              errors.push(note('invalid-fallback-model',
                'у узла «' + id + '» fallbackModel: нужно имя модели провайдера, не алиас models{} — '
                  + 'непустая строка',
                { file: name, node: id, fix: FALLBACK_MODEL_REMEDY }));
            } else {
              node.fallbackModel = raw.fallbackModel.trim();
            }
          }
          /*
           * 0200: reportThread — ветка report-письма планового отчёта. Поле
           * читается явно: нормализация собирает узел из известных полей, и без
           * этого объявление терялось бы между файлом структуры и планировщиком.
           * Ветка — один сегмент пути: «/» и «..» вывели бы письмо из ящика,
           * поэтому такое значение — ошибка с рецептом, а не тихая подмена.
           */
          if (raw.reportThread !== undefined) {
            const thread = typeof raw.reportThread === 'string' ? raw.reportThread.trim() : '';
            if (!thread) {
              errors.push(note('invalid-report-thread',
                'у узла «' + id + '» reportThread должен быть непустой строкой — именем ветки обмена, например "exchange"',
                { file: name, node: id, fix: REPORT_THREAD_REMEDY }));
            } else if (thread.includes('/') || thread.includes('..')) {
              errors.push(note('invalid-report-thread',
                'у узла «' + id + '» reportThread «' + thread + '» — не имя ветки: нужен один сегмент без «/» и «..»',
                { file: name, node: id, fix: REPORT_THREAD_REMEDY }));
            } else {
              node.reportThread = thread;
            }
          }
          if (raw.agentPreset !== undefined) {
            if (typeof raw.agentPreset !== 'string' || raw.agentPreset.trim() === '') {
              errors.push(note('invalid-agent-preset',
                'у узла «' + id + '» agentPreset должен быть непустой строкой', { file: name, node: id }));
            } else {
              node.agentPreset = raw.agentPreset.trim();
            }
          }
          if (raw.mustDifferFrom !== undefined) {
            if (!Array.isArray(raw.mustDifferFrom)) {
              errors.push(note('invalid-must-differ',
                'mustDifferFrom узла «' + id + '» должен быть массивом', { file: name, node: id }));
            } else {
              node.mustDifferFrom = raw.mustDifferFrom.map((value) => text(value)).filter(Boolean);
            }
          }
          /*
           * 0192: якоря узла — вход (consumes) и объявление (produces). Поле
           * сохраняется при чтении: без него validateBinding видел узел без
           * привязки, а сохранение графа теряло объявленные якоря. Битое поле —
           * ошибка с названием узла, а не тихое исчезновение: молча потерянная
           * привязка выглядела бы как «узлу якоря не нужны».
           */
          if (raw.anchors !== undefined) {
            if (!isPlainObject(raw.anchors)) {
              errors.push(note('invalid-anchors',
                'у узла «' + id + '» anchors должен быть объектом { consumes: [...], produces: [...] }',
                { file: name, node: id }));
            } else {
              const normalizedAnchors = normalizeNodeAnchors(raw.anchors);
              for (const message of normalizedAnchors.errors) {
                errors.push(note('invalid-anchors', 'у узла «' + id + '» anchors.' + message, { file: name, node: id }));
              }
              if (normalizedAnchors.errors.length === 0) node.anchors = normalizedAnchors.anchors;
            }
          }
          /*
           * x/y — раскладка, а не декларация: обе координаты задаются вместе,
           * целыми и неотрицательными. Половина пары или дробь — ошибка с
           * рецептом, а не молчаливая догадка: иначе карточка уедет неизвестно
           * куда и человек не поймёт, что править.
           */
          if (raw.x !== undefined || raw.y !== undefined) {
            if (raw.x === undefined || raw.y === undefined) {
              errors.push(note('invalid-position',
                'у узла «' + id + '» задана только одна координата: нужны обе, x и y',
                { file: name, node: id }));
            } else if (!Number.isInteger(raw.x) || !Number.isInteger(raw.y) || raw.x < 0 || raw.y < 0) {
              errors.push(note('invalid-position',
                'у узла «' + id + '» x и y — целые числа ≥ 0 (пиксели канвы), например x: 240, y: 40',
                { file: name, node: id }));
            } else {
              node.position = { x: raw.x, y: raw.y };
            }
          }
          /*
           * A schedule is part of the declaration, not a runtime preference: the
           * host runs exactly the nodes that carry it. at is strict HH:MM and the
           * zone must be one Intl knows, so a typo is a structure error the panel
           * can explain instead of a silent "never runs".
           */
          if (raw.schedule !== undefined) {
            if (!isPlainObject(raw.schedule)) {
              errors.push(note('invalid-schedule',
                'у узла «' + id + '» schedule должен быть объектом { at: "HH:MM", timeZone: "Europe/Moscow" }',
                { file: name, node: id }));
            } else {
              const at = text(raw.schedule.at);
              const timeZone = text(raw.schedule.timeZone);
              if (!parseTimeOfDay(at)) {
                errors.push(note('invalid-schedule-at',
                  'у узла «' + id + '» schedule.at должен быть временем строго HH:MM, например "09:00"',
                  { file: name, node: id }));
              } else if (!isValidTimeZone(timeZone)) {
                errors.push(note('invalid-schedule-timezone',
                  'у узла «' + id + '» schedule.timeZone должен быть часовым поясом Intl, например "Europe/Moscow"',
                  { file: name, node: id }));
              } else {
                node.schedule = { at, timeZone };
              }
            }
          }
          /*
           * concurrency — дисциплина узла: сколько его сессий живёт одновременно.
           * Поле проверяется здесь, а не при запуске: иначе опечатка в режиме
           * молча вернула бы к «запускай сколько хочешь» (задание 0136).
           */
          if (raw.concurrency !== undefined) {
            if (!isPlainObject(raw.concurrency)) {
              errors.push(note('invalid-concurrency',
                'у узла «' + id + '» concurrency должен быть объектом '
                  + '{ "mode": "refuse"|"queue"|"parallel", "max": 1..4 }',
                { file: name, node: id, fix: CONCURRENCY_REMEDY }));
            } else {
              const mode = text(raw.concurrency.mode);
              const rawMax = raw.concurrency.max;
              const maxOk = Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= 4;
              if (!CONCURRENCY_MODES.includes(mode)) {
                errors.push(note('invalid-concurrency',
                  'у узла «' + id + '» concurrency.mode «' + mode + '» неизвестен: допустимы '
                    + CONCURRENCY_MODES.join(', '),
                  { file: name, node: id, fix: CONCURRENCY_REMEDY }));
              } else if (rawMax !== undefined && !maxOk) {
                errors.push(note('invalid-concurrency',
                  'у узла «' + id + '» concurrency.max должен быть целым числом 1..4 '
                    + '(сколько сессий узла живут одновременно), получено ' + JSON.stringify(rawMax),
                  { file: name, node: id, fix: CONCURRENCY_REMEDY }));
              } else if (mode === 'parallel' && rawMax === undefined) {
                errors.push(note('invalid-concurrency',
                  'у узла «' + id + '» режим "parallel" требует concurrency.max 1..4: '
                    + 'сколько сессий узла живут одновременно',
                  { file: name, node: id, fix: CONCURRENCY_REMEDY }));
              } else {
                node.concurrency = mode === 'parallel' ? { mode, max: rawMax } : { mode };
              }
            }
          }
          nodes.push(node);
          nodeIndex.set(id, node);
          source.nodes += 1;
        }
      }
    }

    /*
     * folders — папки обмена. Папка не агент: у неё нет роли, модели и расписания,
     * зато есть ящик (box), участники канала (participants) и оркестратор —
     * объявленный узел, который говорит от её имени. Связь с оркестратором —
     * поле, а не ребро: направления у папки нет (решение заказчика 2026-11-02).
     */
    if (parsed.folders !== undefined) {
      if (!Array.isArray(parsed.folders)) {
        errors.push(note('invalid-folders', 'folders должен быть массивом папок обмена', { file: name }));
      } else {
        for (const raw of parsed.folders) {
          if (!isPlainObject(raw)) {
            errors.push(note('invalid-folder', 'папка обмена должна быть объектом', { file: name }));
            continue;
          }
          const id = text(raw.id);
          if (!id || !NODE_ID.test(id)) {
            errors.push(note('invalid-folder-id',
              'идентификатор папки: латиница, цифры, точка, дефис, подчёркивание, без пробелов: «' + id + '»',
              { file: name }));
            continue;
          }
          if (folderIndex.has(id)) {
            errors.push(note('duplicate-folder',
              'папка «' + id + '» объявлена дважды (' + folderIndex.get(id).file + ' и ' + name + ')',
              { file: name, folder: id }));
            continue;
          }
          const folder = { id, file: name };
          if (text(raw.brief)) folder.brief = text(raw.brief);
          /*
           * box — где лежит ящик обмена. Переносимая форма: путь ОТНОСИТЕЛЬНО общего
           * корня участников, чтобы одна и та же папка поднимала обмен в любом
           * воркспейсе. box: "coordination" или { path: "coordination", root: "shared" }.
           */
          const box = typeof raw.box === 'string' ? { path: raw.box } : raw.box;
          const boxPath = isPlainObject(box) ? text(box.path) : '';
          const boxRoot = isPlainObject(box) && box.root !== undefined ? text(box.root) : 'shared';
          if (!isPlainObject(box) || !boxPath) {
            errors.push(note('folder-box',
              'у папки «' + id + '» нужен box — где лежит ящик обмена: "coordination" '
                + 'или { path: "coordination", root: "shared" }',
              { file: name, folder: id, fix: FOLDER_REMEDIES['folder-box'] }));
          } else if (boxRoot !== 'shared' && boxRoot !== 'workspace') {
            errors.push(note('folder-box-root',
              'у папки «' + id + '» box.root должен быть "shared" (общий корень участников) '
                + 'или "workspace" (внутри своего воркспейса)',
              { file: name, folder: id, fix: FOLDER_REMEDIES['folder-box-root'] }));
          } else {
            folder.box = { path: boxPath, root: boxRoot };
          }
          /*
           * participants — воркспейсы канала, минимум один: без участников у папки
           * нет выхода во вне, и ящик некому поднимать.
           */
          if (raw.participants === undefined) {
            errors.push(note('folder-participants',
              'у папки «' + id + '» нет participants: перечислите хотя бы один воркспейс канала',
              { file: name, folder: id, fix: FOLDER_REMEDIES['folder-participants'] }));
          } else if (!Array.isArray(raw.participants) || raw.participants.length === 0
            || raw.participants.some((item) => typeof item !== 'string' || !item.trim())) {
            errors.push(note('folder-participants',
              'у папки «' + id + '» participants должен быть непустым массивом путей воркспейсов',
              { file: name, folder: id, fix: FOLDER_REMEDIES['folder-participants'] }));
          } else {
            folder.participants = raw.participants.map((item) => item.trim());
          }
          /*
           * orchestrator — id объявленного узла, который отвечает за папку и говорит
           * от её имени. Существование узла проверяется после чтения всех фрагментов:
           * узел может лежать в другом файле.
           */
          if (typeof raw.orchestrator !== 'string' || !raw.orchestrator.trim()) {
            errors.push(note('folder-orchestrator',
              'у папки «' + id + '» не задан orchestrator: укажите id объявленного узла-оркестратора',
              { file: name, folder: id, fix: FOLDER_REMEDIES['folder-orchestrator'] }));
          } else {
            folder.orchestrator = raw.orchestrator.trim();
          }
          /*
           * exchange — свойство папки: ветки и контракт обмена. false означает
           * «обмена нет» (черновик или архив), отсутствие поля — тоже «нет».
           */
          if (raw.exchange !== undefined) {
            if (raw.exchange === false) {
              folder.exchange = false;
            } else if (!isPlainObject(raw.exchange)) {
              errors.push(note('invalid-exchange',
                'у папки «' + id + '» exchange должен быть объектом { threads, contract } или false',
                { file: name, folder: id }));
            } else {
              folder.exchange = {};
              const threads = raw.exchange.threads;
              if (threads !== undefined) {
                if (!Array.isArray(threads) || threads.some((item) => typeof item !== 'string' || !item.trim())) {
                  errors.push(note('invalid-exchange-threads',
                    'у папки «' + id + '» exchange.threads должен быть массивом имён веток',
                    { file: name, folder: id }));
                } else {
                  folder.exchange.threads = threads.map((item) => item.trim());
                }
              }
              if (raw.exchange.contract !== undefined) {
                const contract = text(raw.exchange.contract);
                if (!contract) {
                  errors.push(note('invalid-exchange-contract',
                    'у папки «' + id + '» exchange.contract должен быть именем файла контракта',
                    { file: name, folder: id }));
                } else {
                  folder.exchange.contract = contract;
                }
              }
            }
          }
          folders.push(folder);
          folderIndex.set(id, folder);
          source.folders += 1;
        }
      }
    }

    if (parsed.edges !== undefined) {
      if (!Array.isArray(parsed.edges)) {
        errors.push(note('invalid-edges', 'edges должен быть массивом', { file: name }));
      } else {
        for (const raw of parsed.edges) {
          if (!isPlainObject(raw)) {
            errors.push(note('invalid-edge', 'связь должна быть объектом', { file: name }));
            continue;
          }
          const from = text(raw.from);
          const to = text(raw.to);
          const kind = text(raw.kind) || 'delegate';
          if (!from || !to) {
            errors.push(note('invalid-edge', 'у связи нужны from и to', { file: name }));
            continue;
          }
          if (!EDGE_KINDS.includes(kind)) {
            errors.push(note('unknown-edge-kind',
              'вид связи «' + kind + '» не поддерживается (' + EDGE_KINDS.join(', ') + ')', { file: name }));
            continue;
          }
          edges.push({ from, to, kind, file: name });
          source.edges += 1;
        }
      }
    }

    sources.push(source);
  }

  /*
   * 0175/0176: координатор есть всегда — и на пустом графе тоже (0175 добавлял
   * его только к непустому). Если его нет ни в одном фрагменте, buildGraph
   * добавляет узел coordinator последним и помечает его implicit: панель получает
   * карточку, рёбра, названные координатором, остаются действительными, а файлы
   * не переписываются — координатора сохранит запись узла (api.addNode/updateNode).
   * Узел зарегистрирован в nodeIndex до проверки рёбер: связь с координатором —
   * не связь в пустоту.
   */
  const declaredNodeCount = nodes.length;
  if (!nodes.some((node) => isCoordinatorNode(node))) {
    const added = { ...COORDINATOR_SEED, implicit: true };
    nodes.push(added);
    nodeIndex.set(added.id, added);
  }

  const seenEdge = new Map();
  for (const edge of edges) {
    if (!nodeIndex.has(edge.from)) {
      errors.push(note('unknown-edge-endpoint', 'связь ссылается на неизвестный узел «' + edge.from + '»', { file: edge.file }));
    }
    if (!nodeIndex.has(edge.to)) {
      errors.push(note('unknown-edge-endpoint', 'связь ссылается на неизвестный узел «' + edge.to + '»', { file: edge.file }));
    }
    if (edge.from === edge.to) {
      errors.push(note('self-loop', 'узел «' + edge.from + '» связан сам с собой', { file: edge.file, node: edge.from }));
    }
    const key = edge.from + '\u0000' + edge.to + '\u0000' + edge.kind;
    if (seenEdge.has(key)) {
      warnings.push(note('duplicate-edge',
        'связь «' + edge.from + '» -> «' + edge.to + '» (' + edge.kind + ') объявлена дважды', { file: edge.file }));
      continue;
    }
    seenEdge.set(key, edge);
  }

  /*
   * Миграция чтения. Старый граф объявлял маршрут алиасом models{}: узел нёс
   * model: '<алиас>'. Такой узел разворачивается в прямые provider/model/family,
   * а имя алиаса остаётся в modelAlias — панель показывает, откуда маршрут
   * пришёл. Файл не переписывается: миграция живёт только в памяти читателя.
   *
   * Приоритет у прямых полей: узел с provider объявляет маршрут сам, и алиас с
   * тем же именем его не перетирает.
   */
  for (const node of nodes) {
    const declaredProvider = text(node.provider);
    const declaredModel = text(node.model);
    if (declaredProvider) continue;
    const aliasEntry = declaredModel && Object.hasOwn(models, declaredModel) ? models[declaredModel] : null;
    if (!isPlainObject(aliasEntry)) continue;
    node.modelAlias = declaredModel;
    node.provider = aliasEntry.provider;
    node.model = aliasEntry.model;
    const routeFamily = text(node.family) || text(aliasEntry.family);
    if (routeFamily) node.family = routeFamily;
  }

  for (const node of nodes) {
    /* Неявный координатор — карточка чтения, а не объявленный узел: о нём молчим. */
    if (node.implicit) continue;
    /*
     * Прямой маршрут provider+model ошибок не даёт: models{} больше не список
     * допустимых моделей, а только карта старых алиасов. Ошибка остаётся там,
     * где маршрута нет вовсе: model без provider и без объявленного алиаса.
     */
    if (node.model && !text(node.provider) && !node.modelAlias) {
      errors.push(note('unknown-model',
        'у узла «' + node.id + '» model «' + node.model + '» задан без provider, и алиаса «'
          + node.model + '» нет в models: укажите provider и model прямо в узле',
        { file: node.file, node: node.id }));
    }
    if (!node.model && !isExchangeNode(node)) {
      warnings.push(note('no-model',
        'у узла «' + node.id + '» не задана модель: роль останется декларацией',
        { file: node.file, node: node.id }));
    }
    if (!node.role) {
      warnings.push(note('no-role', 'у узла «' + node.id + '» не задана роль', { file: node.file, node: node.id }));
    }
    if (!node.prompt) {
      /*
       * Честно и без требования (задание 0055): node.prompt при запуске не
       * читается — задачу ребёнку передаёт вызов запуска, — а роль обычно уже
       * кратко описана в brief. Поэтому предупреждение прямо говорит, что
       * запуск не затронут, и называет, где роль уже есть: brief с длиной,
       * иначе поле role. Пример prompt остаётся, но как необязательный.
       */
      const briefLength = text(node.brief).length;
      const whereRole = briefLength > 0
        ? 'роль кратко описана в brief, ' + briefLength + ' симв'
        : (node.role
          ? 'роль задана полем role («' + node.role + '»)'
          : 'роль задаётся полем role — оно тоже пустое');
      warnings.push(note('no-prompt',
        'у узла «' + node.id + '» не задан prompt: на запуск не влияет — задачу передаёт вызов запуска, '
          + whereRole + '. Если хотите зафиксировать Definition of Done словами — допишите prompt '
          + '(≥40 символов): { "id": "' + node.id + '", "prompt": "Роль: … Definition of Done: …" }',
        { file: node.file, node: node.id, fix: PROMPT_REMEDY }));
    }
    for (const other of node.mustDifferFrom || []) {
      if (!nodeIndex.has(other)) {
        errors.push(note('unknown-node',
          'узел «' + node.id + '» должен отличаться от неизвестного «' + other + '»',
          { file: node.file, node: node.id }));
        continue;
      }
      const peer = nodeIndex.get(other);
      const myModel = text(node.model);
      const theirModel = text(peer.model);
      if (!myModel || !theirModel) {
        warnings.push(note('uncomparable-difference',
          'узел «' + node.id + '» должен отличаться от «' + other + '», но у одного из них нет модели',
          { file: node.file, node: node.id }));
        continue;
      }
      /*
       * Совпадение маршрута — пожелание, а не запрет (решение заказчика --117):
       * одинаковая модель допустима, граф собирается, запуск не блокируется.
       * Пишем предупреждение с именами, чтобы человек мог выбрать другое семейство.
       */
      const sameModel = myModel === theirModel && text(node.provider) === text(peer.provider);
      const myFamily = familyOfNode(node);
      const theirFamily = familyOfNode(peer);
      if (sameModel || myFamily === theirFamily) {
        warnings.push(note('same-family',
          'узел «' + node.id + '» должен отличаться от «' + other + '», но маршрут совпадает: '
            + (sameModel ? 'модель «' + myModel + '»' : 'семейство «' + myFamily + '»')
            + '. Одинаковые модели допустимы — это рекомендация, а не ошибка.',
          { file: node.file, node: node.id, other }));
      }
    }
  }

  /*
   * Оркестратор папки обязан быть объявленным узлом. Проверка идёт после чтения
   * всех фрагментов: узел и папка могут лежать в разных файлах.
   */
  for (const folder of folders) {
    if (!folder.orchestrator || nodeIndex.has(folder.orchestrator)) continue;
    errors.push(note('folder-orchestrator-unknown',
      'у папки «' + folder.id + '» orchestrator ссылается на неизвестный узел «'
        + folder.orchestrator + '»: укажите id объявленного узла',
      { file: folder.file, folder: folder.id, fix: FOLDER_REMEDIES['folder-orchestrator-unknown'] }));
  }

  const cycle = findDelegateCycle(edgeList(seenEdge), nodeIndex);
  if (cycle) {
    errors.push(note('delegate-cycle', 'цикл по связям delegate: ' + cycle.join(' -> '), { nodes: cycle }));
  }

  const connected = new Set();
  for (const edge of edgeList(seenEdge)) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  for (const node of nodes) {
    /* Координатор без рёбер — норма: связи к нему добавляет человек. */
    if (node.implicit) continue;
    /* The exchange folder is isolated on purpose: its link is the messages. */
    if (!connected.has(node.id) && !isExchangeNode(node)) {
      warnings.push(note('isolated-node', 'узел «' + node.id + '» ни с кем не связан', { file: node.file, node: node.id }));
    }
  }
  const uniqueEdges = edgeList(seenEdge);
  /*
   * A peer-only graph is a legal flat structure, not an incomplete one: warn
   * only when there is neither delegation nor peer collaboration. Review links
   * alone still mean nobody is assigned work.
   */
  if (declaredNodeCount > 0
    && !uniqueEdges.some((edge) => edge.kind === 'delegate')
    && !uniqueEdges.some((edge) => edge.kind === 'peer')) {
    warnings.push(note('no-delegate-edges',
      'нет ни одной связи delegate: порядок работы не задан, структура читается как одноранговая'));
  }
  /*
   * Пустая структура — отдельный диагноз, но только когда фрагменты уже
   * прочитаны: если файл не разобрался, виноват разбор, и второй ошибкой
   * "узлов нет" мы бы спрятали настоящую причину.
   *
   * Решение заказчика (0171): явно объявленный пустой список (nodes: []) —
   * начало работы, а не поломка. Ошибок нет, есть предупреждение
   * empty-graph — панель покажет виртуального координатора и предложит
   * стартовую структуру. Отсутствие поля nodes (или nodes не массив) — другое
   * дело: структура не сказала состав, и это по-прежнему ошибка, а не тихий
   * «новый проект»: иначе опечатка в ключе выглядела бы как пустой граф.
   */
  if (declaredNodeCount === 0 && errors.length === 0 && list.length > 0) {
    if (nodesDeclared) {
      warnings.push(note('empty-graph',
        'в структуре нет ни одного узла: это новый проект — добавьте координатора'));
    } else {
      errors.push(note('empty-graph', 'в структуре нет ни одного узла'));
    }
  }

  /*
   * families — карта «имя -> семейство». Алиасы остаются для старых графов и
   * панели, но маршрут узла теперь называется идентификатором модели: без
   * записи по node.model панель не показала бы семейство прямого маршрута.
   */
  const families = {};
  for (const [alias, entry] of Object.entries(models)) families[alias] = familyOfModel(entry);
  for (const node of nodes) {
    const model = text(node.model);
    if (!model || !text(node.provider)) continue;
    families[model] = familyOfNode(node);
  }

  return {
    graph: { version, models, nodes, folders, edges: uniqueEdges },
    errors,
    warnings,
    sources,
    families,
  };
}

/** Unique edges in declaration order: the duplicate warnings are already emitted. */
function edgeList(seenEdge) {
  return [...seenEdge.values()];
}

/** Depth-first walk over delegate edges; returns the first cycle as a path. */
export function findDelegateCycle(edges, nodeIndex) {
  const out = new Map();
  for (const edge of edges) {
    if (edge.kind !== 'delegate') continue;
    if (!nodeIndex.has(edge.from) || !nodeIndex.has(edge.to)) continue;
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from).push(edge.to);
  }
  const state = new Map();
  const stack = [];
  function visit(id) {
    state.set(id, 'active');
    stack.push(id);
    for (const next of out.get(id) || []) {
      const current = state.get(next);
      if (current === 'active') {
        const start = stack.indexOf(next);
        return stack.slice(start === -1 ? 0 : start).concat(next);
      }
      if (current === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  }
  for (const id of nodeIndex.keys()) {
    if (state.get(id) === undefined) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The point where the line between the two centres leaves a card: the side of
 * the card nearest to the other one, not always top or bottom. The card is a
 * rectangle, so the ray from its centre is clipped by the first edge it meets.
 * Coincident centres have no direction, and the honest answer is the centre.
 */
export function nearestAnchor(box, toward) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = toward.x + toward.w / 2 - cx;
  const dy = toward.y + toward.h / 2 - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Infinity : (box.w / 2) / Math.abs(dx),
    dy === 0 ? Infinity : (box.h / 2) / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * Deterministic layered layout.
 *
 * Layers follow delegate edges (longest path). Nodes caught in a delegate cycle
 * cannot be ranked that way, so they are placed one layer below everything
 * ranked and marked cyclic: the panel still draws them, while the validator
 * reports the cycle as an error.
 */
export function layoutGraph(graph, options = {}) {
  const nodeW = options.nodeWidth || 176;
  const nodeH = options.nodeHeight || 62;
  const gapX = options.gapX || 64;
  const gapY = options.gapY || 96;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const ids = new Map(nodes.map((node) => [node.id, node]));

  const delegate = edges.filter((edge) => edge.kind === 'delegate' && ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const out = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of delegate) {
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    out.get(edge.from).push(edge.to);
  }
  const rank = new Map();
  const queue = nodes.filter((node) => (indegree.get(node.id) || 0) === 0).map((node) => node.id);
  for (const id of queue) rank.set(id, 0);
  while (queue.length > 0) {
    const id = queue.shift();
    for (const next of out.get(id)) {
      const candidate = (rank.get(id) || 0) + 1;
      if (candidate > (rank.get(next) || 0)) rank.set(next, candidate);
      indegree.set(next, (indegree.get(next) || 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  let maxRank = 0;
  for (const value of rank.values()) if (value > maxRank) maxRank = value;
  const cyclic = [];
  for (const node of nodes) {
    if (!rank.has(node.id)) {
      rank.set(node.id, maxRank + 1);
      cyclic.push(node.id);
    }
  }

  const layers = new Map();
  for (const node of nodes) {
    const layer = rank.get(node.id) || 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(node);
  }
  const ordered = [...layers.keys()].sort((left, right) => left - right);
  let widest = 0;
  for (const layer of ordered) widest = Math.max(widest, layers.get(layer).length);
  let width = Math.max(1, widest) * nodeW + Math.max(0, widest - 1) * gapX;

  const boxes = new Map();
  for (const layer of ordered) {
    const row = layers.get(layer);
    const rowWidth = row.length * nodeW + Math.max(0, row.length - 1) * gapX;
    const offset = Math.round((width - rowWidth) / 2);
    row.forEach((node, position) => {
      boxes.set(node.id, {
        id: node.id,
        x: offset + position * (nodeW + gapX),
        y: layer * (nodeH + gapY),
        w: nodeW,
        h: nodeH,
        layer,
        cyclic: cyclic.includes(node.id),
      });
    });
  }

  /*
   * A saved position wins over the computed place: the card is drawn where the
   * person left it, while a node without a position keeps its layer slot. The
   * canvas grows to the far right and bottom edges, so a card dragged away is
   * never clipped and the edges still start at its sides.
   */
  for (const node of nodes) {
    const box = node.position ? boxes.get(node.id) : null;
    if (!box) continue;
    box.x = node.position.x;
    box.y = node.position.y;
  }

  /*
   * Two nodes can be joined twice — a delegate and the report that returns the
   * result. Drawn on one line they would hide each other, so parallel edges are
   * shifted sideways by a few pixels, centred around the pair's own axis.
   */
  const pairOf = (edge) => [edge.from, edge.to].sort().join('\u0000');
  const pairTotal = new Map();
  for (const edge of edges) {
    const key = pairOf(edge);
    pairTotal.set(key, (pairTotal.get(key) || 0) + 1);
  }
  const pairSeen = new Map();

  const segments = edges.map((edge) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) return { from: edge.from, to: edge.to, kind: edge.kind, x1: 0, y1: 0, x2: 0, y2: 0, missing: true };
    /* The nearest side of each card, so sideways pairs join by their sides. */
    const start = nearestAnchor(from, to);
    const end = nearestAnchor(to, from);
    const x1 = start.x;
    const y1 = start.y;
    const x2 = end.x;
    const y2 = end.y;
    const key = pairOf(edge);
    const total = pairTotal.get(key) || 1;
    const index = pairSeen.get(key) || 0;
    pairSeen.set(key, index + 1);
    if (total === 1) return { from: edge.from, to: edge.to, kind: edge.kind, x1, y1, x2, y2 };
    /*
     * Perpendicular shift, so the second line of a pair stays visible. The normal
     * is built from the canonical (sorted) pair, not from this edge's direction:
     * otherwise both lines would be pushed the same way and stay on top of each other.
     * Both anchors are shifted by the same normal, so each keeps hanging on its side.
     */
    const shift = (index - (total - 1) / 2) * 9;
    const firstBox = boxes.get([edge.from, edge.to].sort()[0]);
    const secondBox = boxes.get([edge.from, edge.to].sort()[1]);
    const across = firstBox && secondBox
      ? { x: secondBox.x + secondBox.w / 2 - (firstBox.x + firstBox.w / 2), y: secondBox.y + secondBox.h / 2 - (firstBox.y + firstBox.h / 2) }
      : { x: x2 - x1, y: y2 - y1 };
    const length = Math.hypot(across.x, across.y) || 1;
    const nx = (-across.y / length) * shift;
    const ny = (across.x / length) * shift;
    return {
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      x1: x1 + nx,
      y1: y1 + ny,
      x2: x2 + nx,
      y2: y2 + ny,
    };
  });

  let height = ordered.length === 0 ? 0 : (ordered[ordered.length - 1] + 1) * (nodeH + gapY) - gapY;
  /* The canvas covers every card, computed or moved: nothing hangs outside. */
  for (const box of boxes.values()) {
    if (!box) continue;
    width = Math.max(width, box.x + box.w);
    height = Math.max(height, box.y + box.h);
  }
  return {
    nodes: nodes.map((node) => boxes.get(node.id)),
    edges: segments,
    width,
    height,
    layers: ordered.length,
    cyclic,
  };
}

/** Counts for the header line of the panel. */
export function summarizeGraph(graph, layout) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byKind = { delegate: 0, review: 0, peer: 0, report: 0 };
  for (const edge of edges) if (edge.kind in byKind) byKind[edge.kind] += 1;
  const roles = {};
  for (const node of nodes) {
    const role = node.role || '(без роли)';
    roles[role] = (roles[role] || 0) + 1;
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    byKind,
    roles,
    models: Object.keys(graph.models || {}).length,
    /* Папки — места обмена, а не узлы: считаются отдельно от nodes. */
    folders: Array.isArray(graph.folders) ? graph.folders.length : 0,
    layers: layout ? layout.layers : 0,
  };
}
