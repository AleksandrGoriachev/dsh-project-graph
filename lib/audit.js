/**
 * Артефакт аудита задания (0177): вердикт узла «Аудитор задач».
 *
 * Аудитор читает задание по якорям (claim/check/status/approval) и оставляет
 * docs/tasks/<id>/audit.json. Если в структуре объявлен узел-аудитор, запуск с
 * заданием не начинается без этого файла: вердикт — предусловие, а не
 * пожелание, и «файла нет» значит «прохода нет» (fail-closed).
 *
 * Модуль чистый: ни файлов, ни структуры, ни DSH — только схема файла и её
 * проверка. Гейт запуска (lib/spawn.js) и проверки говорят об одном и том же,
 * потому что зовут одну функцию.
 *
 * Схема (version 1):
 *   version — версия схемы (1);
 *   task    — id задания, к которому относится вердикт;
 *   auditor — узел, оставивший вердикт (необязателен: гейт знает узел из схемы);
 *   verdict — 'conform' (задание состоятельно) | 'rework' (на доработку);
 *   anchors — якоря проверки: непустой список объектов у conform;
 *   reason  — почему вердикт такой: непустая строка у conform;
 *   at      — когда вердикт вынесен (ISO-время).
 *
 * requiredChecks и прочие поля схемы не обязательны: их содержание наполняет
 * воркспейс, а не движок; лишние поля не мешают.
 */

/** Версия схемы audit.json, которую понимает эта проверка. */
export const AUDIT_VERSION = 1;

/** Допустимые вердикты: conform пропускает запуск, rework его останавливает. */
export const AUDIT_VERDICTS = ['conform', 'rework'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Проверить audit.json как вердикт аудитора.
 *
 * Правила задания 0177: conform требует непустых anchors и reason; вердикт
 * rework — это отказ (ok:false), даже если файл заполнен полностью; отсутствие
 * version, task или at — ошибка. Неизвестный вердикт тоже ошибка: «может быть,
 * conform» не бывает, и гейт не должен угадывать.
 *
 * @param audit - разобранный JSON audit.json (любое значение).
 * @returns {{ ok: boolean, errors: string[] }} ok — можно запускать задание;
 *   errors — человеческие причины отказа, по одной на нарушение.
 */
export function validateAudit(audit) {
  if (!isPlainObject(audit)) {
    return { ok: false, errors: ['audit.json: корень — не JSON-объект'] };
  }
  const errors = [];
  if (audit.version === undefined || audit.version === null || String(audit.version).trim() === '') {
    errors.push('нет version: укажите версию схемы audit.json (' + AUDIT_VERSION + ')');
  }
  if (!text(audit.task)) {
    errors.push('нет task: укажите id задания, к которому относится вердикт');
  }
  if (!text(audit.at)) {
    errors.push('нет at: укажите, когда аудитор вынес вердикт (ISO-время)');
  }
  const verdict = text(audit.verdict).toLowerCase();
  if (!verdict) {
    errors.push('нет verdict: допустимы conform и rework');
  } else if (!AUDIT_VERDICTS.includes(verdict)) {
    errors.push('verdict «' + text(audit.verdict) + '» неизвестен: допустимы conform и rework');
  } else if (verdict === 'rework') {
    errors.push('вердикт rework: аудитор требует доработки, запуск с заданием не начинается');
  }
  if (verdict === 'conform') {
    if (!Array.isArray(audit.anchors) || audit.anchors.length === 0) {
      errors.push('conform без anchors: перечислите якоря проверки (claim/check/status/approval)');
    } else {
      audit.anchors.forEach((anchor, index) => {
        if (!isPlainObject(anchor)) {
          errors.push('anchors[' + index + ']: якорь — не JSON-объект');
        }
      });
    }
    if (!text(audit.reason)) {
      errors.push('conform без reason: объясните, почему задание состоятельно');
    }
  }
  return { ok: errors.length === 0, errors };
}
