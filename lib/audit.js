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

/**
 * Сверить якоря вердикта с якорями, которые узел-аудитор объявил входом (0186).
 *
 * Аудитор судит только то, что объявил входом (anchors.consumes узла): якорь
 * чужого id — не его работа, и такой вердикт ссылается на то, чего не читал.
 * Каждый объявленный consume обязан быть либо подтверждён в anchors, либо
 * назван в notJudged с причиной: молчаливый пропуск — это пропуск проверки, а
 * не «замечаний нет» (D1 задания 0186).
 *
 * Пустой список consumes — привязки нет: проверять нечего, поведение 0177
 * остаётся прежним (схема audit.json и verdict).
 *
 * @param audit - разобранный JSON audit.json (любое значение).
 * @param consumes - id якорей из anchors.consumes узла-аудитора.
 * @returns {{ ok: boolean, errors: string[] }} ok — вердикт покрывает вход аудитора.
 */
export function validateAnchorClaims(audit, consumes) {
  const declared = [];
  for (const item of Array.isArray(consumes) ? consumes : []) {
    const id = text(item);
    if (id && !declared.includes(id)) declared.push(id);
  }
  if (declared.length === 0) return { ok: true, errors: [] };
  const errors = [];
  const source = isPlainObject(audit) ? audit : {};
  const anchors = Array.isArray(source.anchors) ? source.anchors : [];
  const confirmed = [];
  anchors.forEach((anchor, index) => {
    const id = text(isPlainObject(anchor) ? anchor.id : '');
    if (!id) {
      errors.push('anchors[' + index + ']: якорь без id — сверять не с чем');
      return;
    }
    if (!declared.includes(id)) {
      errors.push('anchors[' + index + ']: якорь «' + id + '» не объявлен узлом-аудитором (consumes: '
        + declared.join(', ') + ')');
      return;
    }
    if (!confirmed.includes(id)) confirmed.push(id);
  });
  const judged = [];
  const notJudged = source.notJudged;
  if (notJudged !== undefined && notJudged !== null) {
    if (!Array.isArray(notJudged)) {
      errors.push('notJudged — не список: нужен [{ "id": ..., "why": ... }]');
    } else {
      notJudged.forEach((entry, index) => {
        const id = text(isPlainObject(entry) ? entry.id : '');
        const why = text(isPlainObject(entry) ? entry.why : '');
        if (!id) {
          errors.push('notJudged[' + index + ']: нет id — непонятно, какой якорь пропущен');
        } else if (!declared.includes(id)) {
          errors.push('notJudged[' + index + ']: якорь «' + id + '» не объявлен узлом-аудитором (consumes: '
            + declared.join(', ') + ')');
        }
        if (!why) {
          errors.push('notJudged[' + index + ']: нет why — пропуск без причины не пропуск');
        }
        if (id) judged.push(id);
      });
    }
  }
  const missing = declared.filter((id) => !confirmed.includes(id) && !judged.includes(id));
  if (missing.length > 0) {
    errors.push('не проверены якоря: ' + missing.join(', ')
      + ' — каждый consume либо подтверждён в anchors, либо назван в notJudged [{ "id": ..., "why": ... }]');
  }
  return { ok: errors.length === 0, errors };
}
