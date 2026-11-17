/**
 * 0206: политика роли — код, а не пересказ структуры.
 *
 * Заказчик: роль узла должна задавать требования к проверке сама, а не
 * держаться на памяти координатора. Поэтому здесь одна точка правды:
 *
 *   rolePolicy(role) -> { audit, consumesDefault, presetRequired }
 *
 *   audit          — роль проверяющая: аудитор, ревьюер, судья, приёмщик
 *                    (reviewer/аудитор/judge/приёмщик, а также review);
 *   consumesDefault — 'all-auto' у проверяющей роли (якоря входа не перечислять:
 *                    вход — все auto-якоря проекта) и 'none' у остальных;
 *   presetRequired — true у релизной роли (release/релиз/выпускающий): пресет
 *                    для неё обязателен, у остальных — нет.
 *
 * defaultConsumes(node, anchors) — runtime-значение, «как будто узел объявил
 * consumes», но без записи в structure:
 *
 *   проверяющий узел с пустым anchors.consumes -> все id якорей со статусом
 *   'auto' в том порядке, в котором они лежат в docs/anchors.json;
 *   всё остальное -> [] (явные consumes не расширяются и не заменяются).
 *
 * Legacy-safe: модуль ничего не читает с диска и не пишет в структуру. Явные
 * consumes, объявленные до 0206, остаются дословными — new default только
 * заполняет пустое место у проверяющей роли. Структуры без policyVersion
 * (этого поля здесь нет вовсе) работают по прежним правилам.
 *
 * Модуль чистый: ни файлов, ни структуры, ни DSH — только роль и разобранный
 * документ якорей. Поэтому его одинаково зовут validateBinding, гейт запуска и
 * проверки, и все видят одну политику.
 */

/** Значение consumesDefault: все auto-якоря проекта или ничего. */
export const CONSUMES_DEFAULTS = Object.freeze(['all-auto', 'none']);

/**
 * Роль для сравнения: регистр, «ё» и лишние пробелы не важны.
 * Не-строка — пустая роль: политика не угадывает.
 */
export function normalizeRole(role) {
  return String(role === undefined || role === null ? '' : role)
    .trim()
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ');
}

/**
 * Вид проверяющей роли: 'аудитор' | 'ревьюер' | 'приёмщик' | ''.
 *
 * Слово role, а не id: id — адрес узла, роль — его назначение. Английские
 * написания сравниваются по границам слова, чтобы 'preview' не стал review.
 */
export function auditRoleKind(role) {
  const value = normalizeRole(role);
  if (!value) return '';
  if (/аудитор|auditor/u.test(value)) return 'аудитор';
  if (/ревьюер|(?:^|[^a-z])review(?:er)?(?:[^a-z]|$)/u.test(value)) return 'ревьюер';
  if (/(?:^|[^a-z])judge(?:[^a-z]|$)|судь[яи]/u.test(value)) return 'приёмщик';
  if (/при[её]мщик|(?:^|[^a-z])acceptor(?:[^a-z]|$)/u.test(value)) return 'приёмщик';
  return '';
}

/**
 * Релизная роль: release/релиз и русское «выпускающий» (роль узла release-1
 * в рабочей структуре). Пресет для такой роли обязателен.
 */
export function isReleaseRole(role) {
  const value = normalizeRole(role);
  if (!value) return false;
  return /(?:^|[^a-z])release(?:[^a-z]|$)|релиз|выпускающ/u.test(value);
}

/**
 * Политика роли. Ровно три ответа — их читают validateBinding и гейт запуска:
 * проверяющая роль получает default all-auto, релизная — presetRequired.
 *
 * @param role - роль узла строкой (может быть пустой/не-строкой).
 * @returns {{ audit: boolean, consumesDefault: 'all-auto'|'none', presetRequired: boolean }}
 */
export function rolePolicy(role) {
  const audit = auditRoleKind(role) !== '';
  return {
    audit,
    consumesDefault: audit ? 'all-auto' : 'none',
    presetRequired: isReleaseRole(role),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Явные consumes узла: строки-id и объекты {id}; пустые не считаются. */
function explicitConsumes(node) {
  const anchors = isPlainObject(node) && isPlainObject(node.anchors) ? node.anchors : null;
  const list = anchors && Array.isArray(anchors.consumes) ? anchors.consumes : [];
  const ids = [];
  for (const item of list) {
    const id = typeof item === 'string' ? text(item) : text(isPlainObject(item) ? item.id : '');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Legacy-признак проверяющего узла по id: auditor и reviewer* (0186).
 * Роль сильнее id: она проверяется первой. Id — только совместимость с
 * структурами, где роль пустая или названа иначе, а узел всё равно проверяющий.
 */
function legacyAuditKind(node) {
  const id = text(node && node.id);
  if (!id) return '';
  if (id.toLowerCase() === 'auditor') return 'аудитор';
  if (/^reviewer/iu.test(id)) return 'ревьюер';
  return '';
}

/** Список якорей: массив или корень файла docs/anchors.json. */
function anchorItems(anchors) {
  if (Array.isArray(anchors)) return anchors;
  if (isPlainObject(anchors) && Array.isArray(anchors.anchors)) return anchors.anchors;
  return [];
}

/** Все id якорей со статусом 'auto' — вход проверяющей роли по умолчанию. */
function autoAnchorIds(anchors) {
  const ids = [];
  for (const item of anchorItems(anchors)) {
    if (!isPlainObject(item)) continue;
    const id = text(item.id);
    if (!id || ids.includes(id)) continue;
    if (text(item.status).toLowerCase() !== 'auto') continue;
    ids.push(id);
  }
  return ids;
}

/**
 * Якоря входа по политике роли: runtime-значение без записи в structure.
 *
 * Проверяющий узел (auditRoleKind или legacy id auditor/reviewer*) с пустым
 * anchors.consumes получает все auto-якоря документа. Явные consumes — не
 * меняются: они возвращаются структурой, а не политикой, поэтому здесь [].
 * Не проверяющая роль — [].
 *
 * @param node - узел структуры (id, role, anchors).
 * @param anchors - разобранный docs/anchors.json (корень или список).
 * @returns {string[]} id якорей входа; пустой список — default не применяется.
 */
export function defaultConsumes(node, anchors) {
  if (!isPlainObject(node)) return [];
  if (explicitConsumes(node).length > 0) return [];
  const kind = auditRoleKind(node.role) || legacyAuditKind(node);
  if (!kind) return [];
  return autoAnchorIds(anchors);
}
