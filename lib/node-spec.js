/**
 * Спека узла — неизменяемая часть (задание 0282).
 *
 * Вид узла задаёт обязанности и машинные инварианты независимо от свободного
 * prompt: проверяющий обязан иметь вход (якоря или gates), folder — ящик и двух
 * участников, независимые виды не сливаются в одного. Спека — форма, поэтому
 * живёт в lib/ плагина и общая для всех воркспейсов; состав узлов, имена и
 * модели остаются в structure/ проекта.
 *
 * Вид выводится строго по порядку kind → id → роль:
 *   - node.kind — вид, если он есть в реестре. Значение "agent" — метка схемы
 *     графа, а не вид: она не мешает выводу, но и видом не считается. Любое
 *     другое неизвестное значение — ошибка kind-unknown, а не догадка;
 *   - node.id — точное совпадение с видом или его синонимом (designer, judge).
 *     Суффикс не отбрасывается: worker-1 — не worker, иначе роль «Советник»
 *     никогда не назвала бы вид adviser;
 *   - node.role — имя роли вида (ru/en), точное или в составе фразы
 *     («координатор структуры»).
 *
 * Правила карточки:
 *   - роль обязана принадлежать виду, иначе kind-role-mismatch;
 *   - проверяющие виды (reviewer, acceptor, auditor) обязаны иметь непустой
 *     anchors.consumes или gates, иначе gates-required;
 *   - mustDifferFrom не может ссылаться на себя или на несуществующий узел,
 *     иначе must-differ-from;
 *   - folder требует box.path и минимум двух участников, иначе folder-invalid.
 *
 * Результат валидатора: { ok, valid, problems }. ok — карточка (граф) разобрана
 * и проверена; valid — находок нет; problems — сами находки [{ code, node?,
 * message }]. ok отдельно от valid потому, что неизвестный вид обязан быть
 * назван находкой, а не проглочен: «проверено» и «годно» — разные ответы.
 *
 * Модуль чистый: ни файлов, ни DSH, только значения на входе и находки на
 * выходе. Нормализация роли — та же, что у политики роли (lib/role-policy.js):
 * «Советник», «советник» и «СОВЕТНИК» — одно слово.
 */
import { normalizeRole } from './role-policy.js';

/** Все виды узла: 11 ролей агента и folder. */
export const NODE_KINDS = Object.freeze([
  'coordinator',
  'worker',
  'designer',
  'reviewer',
  'acceptor',
  'critic',
  'tester',
  'release',
  'auditor',
  'adviser',
  'interlocutor',
  'folder',
]);

/** Коды находок валидатора карточки (контракт 0282, расширять только заданием). */
export const PROBLEM_CODES = Object.freeze([
  'kind-unknown',
  'kind-role-mismatch',
  'gates-required',
  'must-differ-from',
  'folder-invalid',
]);

/**
 * Один вид: role-слова в ru/en, синонимы для id, обязательность входа и
 * независимость. roles и synonyms нормализованы один раз, при загрузке модуля:
 * сравнение идёт с normalizeRole(role), а не с сырым текстом.
 */
const spec = (kind, roles, options = {}) => Object.freeze({
  kind,
  roles: Object.freeze(roles.map((role) => normalizeRole(role))),
  synonyms: Object.freeze((options.synonyms || []).map((name) => normalizeRole(name))),
  gates: options.gates === 'required' ? 'required' : 'optional',
  independence: options.independence === true,
});

/**
 * Реестр видов. Порядок объявления — приоритет вывода роли: общий вид раньше
 * специализации, поэтому роль «исполнитель» называет worker, а designer
 * принимает её как допустимую (в живом графе designer объявлен исполнителем).
 */
export const SPECS = Object.freeze({
  coordinator: spec('coordinator', ['координатор', 'coordinator'], { synonyms: ['координатор'] }),
  worker: spec('worker', ['исполнитель', 'worker', 'разработчик', 'developer'], {
    synonyms: ['исполнитель'],
    independence: true,
  }),
  designer: spec('designer', ['дизайнер', 'designer', 'исполнитель'], { synonyms: ['дизайнер'] }),
  reviewer: spec('reviewer', ['ревьюер', 'reviewer'], {
    synonyms: ['ревьюер'],
    gates: 'required',
    independence: true,
  }),
  acceptor: spec('acceptor', ['приёмщик', 'acceptor', 'судья', 'judge'], {
    synonyms: ['приемщик', 'судья', 'judge'],
    gates: 'required',
    independence: true,
  }),
  critic: spec('critic', ['критик', 'critic'], { synonyms: ['критик'] }),
  tester: spec('tester', ['тестировщик', 'tester'], { synonyms: ['тестировщик'] }),
  release: spec('release', ['релиз', 'release', 'выпускающий', 'релиз-менеджер', 'release-manager'], {
    synonyms: ['релиз', 'выпускающий'],
  }),
  auditor: spec('auditor', ['аудитор', 'auditor'], { synonyms: ['аудитор'], gates: 'required' }),
  adviser: spec('adviser', ['советник', 'adviser', 'advisor', 'консультант'], {
    synonyms: ['advisor', 'советник'],
  }),
  interlocutor: spec('interlocutor', ['собеседник', 'interlocutor'], { synonyms: ['собеседник'] }),
  folder: spec('folder', ['папка', 'folder'], { synonyms: ['папка'] }),
});

/** Ключи id → вид: сам вид сильнее синонима, объявленный раньше — сильнее. */
const ID_INDEX = new Map();
/** Ключи роль → вид: первое совпадение по приоритету реестра. */
const ROLE_INDEX = new Map();
for (const kind of NODE_KINDS) {
  const entry = SPECS[kind];
  for (const word of [kind, ...entry.synonyms]) {
    const key = normalizeRole(word);
    if (key && !ID_INDEX.has(key)) ID_INDEX.set(key, kind);
  }
  for (const role of entry.roles) {
    if (role && !ROLE_INDEX.has(role)) ROLE_INDEX.set(role, kind);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Регулярка из слова: экранируем всё, что метасимвол. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Слово роли встречается в тексте роли. Латиница сравнивается по границам
 * слова (previewer — не reviewer), кириллица — вхождением: «координатор
 * структуры» и «старший координатор» называют вид coordinator.
 */
function roleWordMatches(roleText, word) {
  if (!roleText || !word) return false;
  if (roleText === word) return true;
  if (/^[a-z0-9._ -]+$/u.test(word)) {
    const pattern = new RegExp('(?:^|[^a-z0-9])' + escapeRegExp(word) + '(?:[^a-z0-9]|$)', 'u');
    return pattern.test(roleText);
  }
  return roleText.includes(word);
}

/** Вид по одному имени роли: точное совпадение, иначе самое длинное вхождение. */
function roleKindOf(roleText) {
  if (!roleText) return null;
  const exact = ROLE_INDEX.get(roleText);
  if (exact) return exact;
  let best = null;
  for (const [word, kind] of ROLE_INDEX) {
    if (!roleWordMatches(roleText, word)) continue;
    if (!best || word.length > best.word.length) best = { word, kind };
  }
  return best ? best.kind : null;
}

/**
 * Вид узла: kind → id → роль.
 *
 * @param node - карточка узла или графа (plain object).
 * @returns id вида из SPECS или null, если вид не выводится — это kind-unknown,
 *   а не молчаливый worker.
 */
export function nodeKindOf(node) {
  if (!isPlainObject(node)) return null;
  const declared = normalizeRole(node.kind);
  if (declared && declared !== 'agent') {
    return Object.hasOwn(SPECS, declared) ? declared : null;
  }
  const byId = ID_INDEX.get(normalizeRole(node.id));
  if (byId) return byId;
  return roleKindOf(normalizeRole(node.role));
}

/** Роль допустима для вида: точное имя из списка или роль, ведущая в тот же вид. */
function roleAllowed(kind, roleText) {
  if (SPECS[kind].roles.includes(roleText)) return true;
  return roleKindOf(roleText) === kind;
}

/** id якорей из consumes/produces: строки и объекты { id }. Пустые не считаются. */
function anchorIds(value) {
  const list = Array.isArray(value) ? value : [];
  const ids = [];
  for (const item of list) {
    const id = typeof item === 'string' ? text(item) : text(isPlainObject(item) ? item.id : '');
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Вход проверяющего объявлен якорями (anchors.consumes) или gates. Имя consumers
 * читается как переходное: buildGraph нормализует его в consumes, но карточка из
 * задания может прийти в старой форме.
 */
function hasConsumes(node) {
  const anchors = isPlainObject(node.anchors) ? node.anchors : {};
  const declared = anchors.consumes !== undefined ? anchors.consumes : anchors.consumers;
  return anchorIds(declared).length > 0;
}

/** gates — непустой список/объект/строка: что именно проверяет узел. */
function hasGates(node) {
  const gates = node.gates;
  if (Array.isArray(gates)) {
    return gates.some((item) => (typeof item === 'string' ? text(item) !== '' : isPlainObject(item) && Object.keys(item).length > 0));
  }
  if (isPlainObject(gates)) return Object.keys(gates).length > 0;
  return text(gates) !== '';
}

function folderCardProblems(folder) {
  const id = isPlainObject(folder) ? text(folder.id) : '';
  const problems = [];
  const push = (message) => {
    problems.push(id ? { code: 'folder-invalid', node: id, message } : { code: 'folder-invalid', message });
  };
  if (!isPlainObject(folder)) {
    push('папка обмена должна быть объектом { id, box, participants }');
    return problems;
  }
  const box = typeof folder.box === 'string' ? { path: folder.box } : folder.box;
  const boxPath = isPlainObject(box) ? text(box.path) : '';
  if (!boxPath) {
    push('у папки «' + id + '» нет box.path: укажите путь к ящику обмена, например "coordination"');
  }
  const participants = Array.isArray(folder.participants)
    ? folder.participants.filter((item) => text(item) !== '')
    : [];
  if (participants.length < 2) {
    push('у папки «' + id + '» ' + (participants.length === 1 ? 'один участник' : 'нет участников')
      + ': нужен минимум два (participants) — папка без второго воркспейса не канал обмена');
  }
  return problems;
}

/**
 * Валидатор карточки узла: вид, роль, вход проверяющего, mustDifferFrom и
 * (для folder) ящик с участниками.
 *
 * @param node - карточка узла.
 * @param options - { ids?: Set<string> }: известные id графа. Без него проверка
 *   существования в mustDifferFrom не выполняется — карточка проверяется сама
 *   по себе; validateGraphCards передаёт id всех узлов.
 * @returns { ok, valid, problems: [{ code, node?, message }] }: ok — карточка
 *   разобрана и проверена, valid — находок нет. Оба поля нужны: валидатор
 *   обязан назвать находку, а не промолчать о неизвестном виде.
 */
export function validateNodeCard(node, options = {}) {
  const problems = [];
  const id = isPlainObject(node) ? text(node.id) : '';
  const push = (code, message) => {
    problems.push(id ? { code, node: id, message } : { code, message });
  };
  if (!isPlainObject(node)) {
    push('kind-unknown', 'карточка узла должна быть объектом { id, kind?, role?, anchors?, mustDifferFrom? }');
    return { ok: false, valid: false, problems };
  }
  const kind = nodeKindOf(node);
  if (!kind) {
    push('kind-unknown',
      'у узла «' + id + '» не выведен вид: ни kind, ни id, ни роль не называют вид ('
        + NODE_KINDS.join(', ') + ')');
    return { ok: true, valid: false, problems };
  }
  const roleText = normalizeRole(node.role);
  if (roleText && !roleAllowed(kind, roleText)) {
    push('kind-role-mismatch',
      'у узла «' + id + '» вид ' + kind + ', а роль «' + text(node.role)
        + '» принадлежит другому виду: допустимые роли ' + kind + ' — '
        + SPECS[kind].roles.join(', '));
  }
  if (SPECS[kind].gates === 'required' && !hasConsumes(node) && !hasGates(node)) {
    push('gates-required',
      'у узла «' + id + '» проверяющий вид ' + kind + ': нужен непустой anchors.consumes (что узел читает) '
        + 'или gates (что он проверяет) — иначе не видно, что именно узел проверяет');
  }
  if (node.mustDifferFrom !== undefined) {
    if (!Array.isArray(node.mustDifferFrom)) {
      push('must-differ-from',
        'у узла «' + id + '» mustDifferFrom должен быть массивом id узлов, от которых он обязан отличаться');
    } else {
      for (const item of node.mustDifferFrom) {
        const other = text(item);
        if (!other) {
          push('must-differ-from', 'у узла «' + id + '» пустой id в mustDifferFrom: назовите конкретный узел');
          continue;
        }
        if (other === id) {
          push('must-differ-from',
            'узел «' + id + '» не может отличаться сам от себя: уберите «' + other + '» из mustDifferFrom');
          continue;
        }
        if (options.ids && !options.ids.has(other)) {
          push('must-differ-from',
            'узел «' + id + '» должен отличаться от «' + other + '», но такого узла в графе нет');
        }
      }
    }
  }
  if (kind === 'folder') problems.push(...folderCardProblems(node));
  /*
   * ok — карточка разобрана и проверена (вход в валидатор), valid — находок нет.
   * Два поля, а не одно: приёмочная проверка 0282 c1 требует, чтобы карточка с
   * найденным kind-unknown была проверена (ok), а не молча пропущена; годность
   * карточки читают по valid, buildGraph — по problems.
   */
  return { ok: true, valid: problems.length === 0, problems };
}

/** Валидатор карточки папки: box.path и минимум два участника. */
export function validateFolderCard(folder) {
  const problems = folderCardProblems(folder);
  return { ok: isPlainObject(folder), valid: problems.length === 0, problems };
}

/**
 * Валидатор карточек всего графа: все узлы (mustDifferFrom сверяется с id графа)
 * и все папки. Это то, что buildGraph добавляет в errors при specs: true.
 *
 * @param graph - { nodes?, folders? }: собранный граф или его фрагмент.
 * @returns { ok, valid, problems: [{ code, node?, message }] } — как у
 *   validateNodeCard: ok значит «граф проверен», valid — «находок нет».
 */
export function validateGraphCards(graph) {
  const source = isPlainObject(graph) ? graph : {};
  const nodes = Array.isArray(source.nodes) ? source.nodes : [];
  const folders = Array.isArray(source.folders) ? source.folders : [];
  const ids = new Set();
  for (const node of nodes) {
    const id = isPlainObject(node) ? text(node.id) : '';
    if (id) ids.add(id);
  }
  const problems = [];
  for (const node of nodes) problems.push(...validateNodeCard(node, { ids }).problems);
  for (const folder of folders) problems.push(...folderCardProblems(folder));
  return { ok: isPlainObject(graph), valid: problems.length === 0, problems };
}
