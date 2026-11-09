/**
 * Якоря задания (0186): утверждение файла якорей и привязка к узлам структуры.
 *
 * Заказчик: аудитор формально есть, а с чем он сверяет — не задано. Якоря
 * (claim/check/status/approval) — механизм воркспейса; здесь только две вещи,
 * которые движок обязан доказать до запуска:
 *
 *   validateApproval — docs/anchors.json утверждён, а не перечислен: algo
 *   sha256, hash совпадает с содержимым файла, signature.covers === 'hash+by+at';
 *   scope обязан быть назван — 'project' или 'both', и только эти два значения
 *   допустимы: отсутствующее/неизвестное scope не «project по умолчанию», а
 *   отказ. scope 'both' (проект и пользователь) требует ключ человека (human-*),
 *   иначе утверждение могло бы быть выдано от имени того, кого оно касается.
 *
 *   validateBinding — структура ссылается на якоря, которые существуют: каждый
 *   id в anchors.consumes/produces объявлен в файле якорей; узел-аудитор и
 *   узел-ревьюер обязаны иметь непустой consumes (аудитор без якорей — не
 *   проверка, а подпись).
 *
 * Модуль чистый: ни файлов, ни DSH, ни структуры — только JSON-значения и
 * sha256. Гейт запуска (lib/spawn.js) и проверки говорят одно и то же, потому
 * что зовут эти же функции.
 */
import crypto from 'node:crypto';

/** Алгоритм утверждения: только sha256 (инвариант 1 задания 0186). */
export const APPROVAL_ALGO = 'sha256';

/** Что покрывает подпись: хеш, кто и когда, а не «файл в целом». */
export const APPROVAL_COVERS = 'hash+by+at';

/** Роли, которым якоря нужны как вход: аудитор и ревьюер. */
const AUDITOR_ROLE = /аудитор|auditor/iu;
const REVIEWER_ROLE = /ревьюер|reviewer|review/iu;
const REVIEWER_ID = /^reviewer/iu;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** sha256 текста: тот же ответ, что у проверок и у воркспейса. */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * Список якорей из docs/anchors.json: корень {version, anchors:[…]} или сам
 * массив. Всё остальное — не список якорей (null).
 */
export function anchorList(anchors) {
  if (Array.isArray(anchors)) return anchors;
  if (isPlainObject(anchors) && Array.isArray(anchors.anchors)) return anchors.anchors;
  return null;
}

/** Id якорей из списка или корня файла: только строки, без пустых. */
export function anchorIds(anchors) {
  const list = anchorList(anchors);
  if (!list) return [];
  const ids = [];
  for (const item of list) {
    const id = text(isPlainObject(item) ? item.id : '');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Ссылки узла на якоря (consumes/produces): объекты {id, scope, stage} или
 * строки-id. Пустое/битое поле — пустой список, причина названа при проверке.
 */
export function nodeAnchorRefs(node, kind) {
  const anchors = isPlainObject(node) && isPlainObject(node.anchors) ? node.anchors : null;
  const list = anchors && Array.isArray(anchors[kind]) ? anchors[kind] : [];
  const ids = [];
  for (const item of list) {
    const id = typeof item === 'string' ? text(item) : text(isPlainObject(item) ? item.id : '');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Якоря, которые узел объявил входом: с них и спрашивается его вердикт. */
export function consumesOf(node) {
  return nodeAnchorRefs(node, 'consumes');
}

/**
 * Якоря узлов из фрагментов structure/*.json (0186).
 *
 * Собранный граф (lib/graph.js) хранит только объявленные поля узла: anchors в
 * нём не живут, поэтому привязка читается из тех же фрагментов, что читает
 * структура. Возвращаются узлы с id, ролью и объявленными якорями; битый JSON
 * пропускается — о нём скажет сборщик графа, а не гейт якорей.
 *
 * @param files - фрагменты структуры: [{ name, text }] из readStructure.
 * @returns {Array<{ id: string, role: unknown, anchors: unknown }>}
 */
export function structureAnchorBindings(files) {
  const nodes = [];
  for (const file of Array.isArray(files) ? files : []) {
    let document;
    try {
      document = JSON.parse(file && file.text);
    } catch {
      continue;
    }
    const list = Array.isArray(document && document.nodes) ? document.nodes : [];
    for (const node of list) {
      if (!isPlainObject(node) || !text(node.id)) continue;
      nodes.push({ id: node.id, role: node.role, anchors: node.anchors });
    }
  }
  return nodes;
}

/** Структура объявила якоря? Тогда утверждение и привязка — предусловие. */
export function anchorsDeclared(graph) {
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes.some((node) => nodeAnchorRefs(node, 'consumes').length > 0
    || nodeAnchorRefs(node, 'produces').length > 0);
}

/** Узел по роли/id обязан быть аудитором (0177) или ревьюером (0168/0187). */
function anchorBoundRole(node) {
  const role = String(node && node.role !== undefined && node.role !== null ? node.role : '');
  const id = text(node && node.id);
  if (AUDITOR_ROLE.test(role) || id.toLowerCase() === 'auditor') return 'аудитор';
  if (REVIEWER_ROLE.test(role) || REVIEWER_ID.test(id)) return 'ревьюер';
  return '';
}

/**
 * Проверить утверждение якорей (docs/anchors.approval.json) против текста
 * docs/anchors.json.
 *
 * Утверждение — это не «файл принят на веру»: hash обязан быть sha256 ровно
 * этого текста, algo — sha256, а подпись покрывать hash+by+at. Область
 * утверждения (scope) обязана быть названа и быть 'project' или 'both':
 * неизвестное или отсутствующее scope — отказ, а не молчаливое «project».
 * Проверка содержания (claim/check/status) — дело воркспейса, а не движка.
 *
 * @param approval - разобранный JSON утверждения (любое значение).
 * @param anchorsText - дословный текст docs/anchors.json.
 * @returns {{ ok: boolean, errors: string[] }} ok — якоря утверждены.
 */
export function validateApproval(approval, anchorsText) {
  if (!isPlainObject(approval)) {
    return { ok: false, errors: ['approval: корень — не JSON-объект'] };
  }
  if (typeof anchorsText !== 'string') {
    return { ok: false, errors: ['anchors: текст файла якорей не передан, утверждение не из чего проверить'] };
  }
  const errors = [];
  const algo = text(approval.algo).toLowerCase();
  if (algo !== APPROVAL_ALGO) {
    errors.push('algo «' + text(approval.algo) + '» не поддерживается: утверждение считается только по sha256');
  }
  const hash = text(approval.hash).toLowerCase();
  const expected = sha256Hex(anchorsText);
  if (!hash) {
    errors.push('нет hash: утверждение обязано назвать sha256 файла якорей');
  } else if (!/^[0-9a-f]{64}$/u.test(hash)) {
    errors.push('hash «' + text(approval.hash) + '» — не sha256: нужно 64 шестнадцатеричных знака');
  } else if (hash !== expected) {
    errors.push('hash не совпадает с docs/anchors.json: утверждён другой текст (ожидался ' + expected + ')');
  }
  const signature = isPlainObject(approval.signature) ? approval.signature : null;
  if (!signature) {
    errors.push('нет signature: утверждение подписывается, а не пересказывается');
  } else {
    const covers = text(signature.covers);
    if (covers !== APPROVAL_COVERS) {
      errors.push('signature.covers «' + covers + '» не покрывает hash+by+at: подпись без автора и времени не утверждение');
    }
  }
  /*
   * Область утверждения — не украшение: раньше отсутствующее/неизвестное scope
   * проходило как project, и не-человеческий ключ утверждал проект, просто не
   * назвав область (замечание ревьюера 0186). Здесь допустимы ровно два
   * значения; всё прочее — отказ с названным перечнем.
   */
  const scope = text(approval.scope).toLowerCase();
  if (!scope) {
    errors.push('нет scope: утверждение обязано назвать область — project или both');
  } else if (scope !== 'project' && scope !== 'both') {
    errors.push('scope «' + text(approval.scope) + '» неизвестен: допустимы project и both');
  } else if (scope === 'both') {
    const keyId = text(signature && signature.keyId);
    if (!/^human-/u.test(keyId)) {
      errors.push('scope both требует ключ человека: signature.keyId «' + keyId + '» не human-*');
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Проверить привязку якорей к узлам структуры.
 *
 * Каждый id, названный узлом в anchors.consumes/produces, обязан существовать в
 * файле якорей: ссылка на несуществующий якорь — это не проверка. Узел-аудитор
 * и узел-ревьюер обязаны объявить непустой consumes: иначе их вердикт не за что
 * зацепить (инвариант 2 задания 0186).
 *
 * @param graph - собранный граф структуры (nodes с anchors).
 * @param anchors - разобранный docs/anchors.json (корень или список).
 * @returns {{ ok: boolean, errors: string[] }} ok — привязка состоялась.
 */
export function validateBinding(graph, anchors) {
  const list = anchorList(anchors);
  if (!list) {
    return { ok: false, errors: ['anchors: нет списка якорей — привязывать не к чему'] };
  }
  const errors = [];
  for (const [index, item] of list.entries()) {
    if (!isPlainObject(item) || !text(item.id)) {
      errors.push('anchors[' + index + ']: якорь без id — на такой нельзя сослаться');
    }
  }
  const known = anchorIds(list);
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  for (const node of nodes) {
    if (!isPlainObject(node)) continue;
    const id = text(node.id) || '(без id)';
    for (const kind of ['consumes', 'produces']) {
      const anchorsField = isPlainObject(node.anchors) ? node.anchors[kind] : undefined;
      if (anchorsField !== undefined && !Array.isArray(anchorsField)) {
        errors.push('узел «' + id + '»: anchors.' + kind + ' — не список якорей');
      }
      for (const ref of nodeAnchorRefs(node, kind)) {
        if (!known.includes(ref)) {
          errors.push('узел «' + id + '»: якорь «' + ref + '» в anchors.' + kind + ' не объявлен в docs/anchors.json');
        }
      }
    }
    const bound = anchorBoundRole(node);
    if (bound && consumesOf(node).length === 0) {
      errors.push('узел «' + id + '» (' + bound + ') обязан объявить непустой anchors.consumes: '
        + bound + ' без якорей — не проверка, а подпись');
    }
  }
  return { ok: errors.length === 0, errors };
}
