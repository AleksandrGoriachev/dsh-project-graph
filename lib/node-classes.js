/**
 * Классы узлов (задание 0311): реестр фиксированных возможностей.
 *
 * Узел перестаёт быть произвольным набором ролей-строк: у класса есть
 * жёстко зафиксированные в коде возможности, а не свободный текст. Класс
 * выводится из роли по одной карте; legacy-id (координатор, reviewer-*, аудитор)
 * работает только тогда, когда роль пуста или не назвала класс.
 *
 * Здесь один источник правды для панели и API: `NODE_CAPABILITIES` называет
 * полный набор возможностей, `NODE_CLASSES` — что каждый класс вправе делать.
 * Ни панель, ни API не задают своих списков возможностей, иначе «судья не
 * пишет код» держалось бы на двух разных картах.
 *
 * Модуль чистый: ни файлов, ни структуры, ни DSH — только узел на входе и
 * класс/строка на выходе. Нормализация роли — та же, что у политики роли
 * (lib/role-policy.js): регистр, «ё» и лишние пробелы не важны.
 */
import { normalizeRole } from './role-policy.js';

/**
 * Все возможности узла: 13 имён. Значение — boolean у каждого класса.
 * Список заморожен: расширение возможно только заданием, а не случайной
 * правкой панели.
 */
export const NODE_CAPABILITIES = Object.freeze([
  'writeProductCode',
  'writeTests',
  'design',
  'review',
  'accept',
  'audit',
  'critique',
  'test',
  'release',
  'advise',
  'issueTasks',
  'spawn',
  'editStructure',
]);

/**
 * Возможности класса: все 13 полей, каждое boolean; посторонних ключей нет.
 * Объект замораживается — иначе класс «похудел» бы во время работы панели.
 */
function capabilitiesOf(allowed) {
  const granted = new Set(allowed);
  const value = {};
  for (const capability of NODE_CAPABILITIES) value[capability] = granted.has(capability);
  return Object.freeze(value);
}

/**
 * Один класс: id, человеческая подпись, kind (совместим с ANCHOR_KINDS) и
 * замороженные возможности. kind равен id: класс узла и вид якорей называют
 * одно и то же множество.
 */
function nodeClass(id, title, allowed) {
  return Object.freeze({
    id,
    title,
    kind: id,
    capabilities: capabilitiesOf(allowed),
  });
}

/**
 * Реестр классов: 11 записей. Матрица зафиксирована заданием 0311: судья не
 * пишет продуктовый код, ревьюер не проектирует, координатор не пишет код, а
 * выдаёт задачи, запускает узлы и правит структуру.
 */
export const NODE_CLASSES = Object.freeze({
  coordinator: nodeClass('coordinator', 'Координатор', ['issueTasks', 'spawn', 'editStructure']),
  worker: nodeClass('worker', 'Исполнитель', ['writeProductCode', 'writeTests']),
  designer: nodeClass('designer', 'Проектировщик', ['design']),
  reviewer: nodeClass('reviewer', 'Ревьюер', ['review']),
  judge: nodeClass('judge', 'Приёмщик', ['accept']),
  critic: nodeClass('critic', 'Критик', ['critique']),
  tester: nodeClass('tester', 'Тестировщик', ['test', 'writeTests']),
  release: nodeClass('release', 'Выпускающий', ['release']),
  auditor: nodeClass('auditor', 'Аудитор', ['audit']),
  adviser: nodeClass('adviser', 'Советник', ['advise']),
  security: nodeClass('security', 'Безопасность', ['audit']),
});

/**
 * Алиасы ролей ru/en. Ключи нормализованы один раз, при загрузке модуля:
 * сравнение идёт с normalizeRole(role), а не с сырым текстом.
 * «Приёмщик» после нормализации — «приемщик»: «ё» не различает роли.
 */
const ROLE_ALIASES = [
  ['координатор', 'coordinator'], ['coordinator', 'coordinator'],
  ['исполнитель', 'worker'], ['worker', 'worker'],
  ['проектировщик', 'designer'], ['designer', 'designer'],
  ['ревьюер', 'reviewer'], ['reviewer', 'reviewer'],
  ['приёмщик', 'judge'], ['приемщик', 'judge'], ['судья', 'judge'],
  ['judge', 'judge'], ['acceptor', 'judge'],
  ['критик', 'critic'], ['critic', 'critic'],
  ['тестировщик', 'tester'], ['tester', 'tester'],
  ['выпускающий', 'release'], ['release', 'release'],
  ['аудитор', 'auditor'], ['auditor', 'auditor'],
  ['советник', 'adviser'], ['собеседник', 'adviser'], ['adviser', 'adviser'],
  ['безопасность', 'security'], ['security', 'security'],
];

const ROLE_INDEX = new Map();
for (const [alias, classId] of ROLE_ALIASES) {
  const key = normalizeRole(alias);
  if (!ROLE_INDEX.has(key)) ROLE_INDEX.set(key, classId);
}

/**
 * Legacy-id: совместимость с структурами, где роль пустая или названа иначе,
 * а узел всё равно узнаётся по адресу. Ровно три формы задания: coordinator,
 * reviewer* и auditor. Роль сильнее: сюда попадают только после неё.
 */
function legacyClassId(id) {
  const value = String(id === undefined || id === null ? '' : id).trim().toLowerCase();
  if (!value) return null;
  if (value === 'coordinator') return 'coordinator';
  if (value === 'auditor') return 'auditor';
  if (/^reviewer/u.test(value)) return 'reviewer';
  return null;
}

/** Найденный класс: форма ответа nodeClassOf для успеха. */
function found(classId, source) {
  return { ok: true, classId, klass: NODE_CLASSES[classId], source };
}

/** Отказ: класса нет, причина названа — unknown-role или no-role. */
function missing(reason) {
  return { ok: false, reason };
}

/**
 * Класс узла по роли, затем по legacy-id.
 *
 * @param node - карточка узла (plain object).
 * @returns { ok: true, classId, klass, source: 'role'|'id' } или
 *   { ok: false, reason: 'unknown-role'|'no-role' }. Неизвестная роль не
 *   угадывается: «погромист» — это unknown-role, а не молчаливый worker.
 */
export function nodeClassOf(node) {
  const entry = node && typeof node === 'object' && !Array.isArray(node) ? node : {};
  const role = normalizeRole(entry.role);
  if (role) {
    const byRole = ROLE_INDEX.get(role);
    if (byRole) return found(byRole, 'role');
    const byId = legacyClassId(entry.id);
    if (byId) return found(byId, 'id');
    return missing('unknown-role');
  }
  const byId = legacyClassId(entry.id);
  if (byId) return found(byId, 'id');
  return missing('no-role');
}

/**
 * Строки панели: по одной на узел, в порядке узлов. Вход не мутируется —
 * панель и API получают копии ссылок на замороженные возможности, а не
 * собственный изменяемый список.
 *
 * @param nodes - массив узлов графа.
 * @returns [{ id, classId: string|null, title: string|null,
 *   capabilities: object|null, source: 'role'|'id'|'none', reason: string|null }].
 */
export function nodeClassRows(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  return list.map((node) => {
    const entry = node && typeof node === 'object' && !Array.isArray(node) ? node : {};
    const id = entry.id === undefined || entry.id === null ? '' : String(entry.id);
    const result = nodeClassOf(entry);
    if (!result.ok) {
      return { id, classId: null, title: null, capabilities: null, source: 'none', reason: result.reason };
    }
    const klass = result.klass;
    return {
      id,
      classId: klass.id,
      title: klass.title,
      capabilities: klass.capabilities,
      source: result.source,
      reason: null,
    };
  });
}
