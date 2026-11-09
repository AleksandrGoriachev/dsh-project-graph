/**
 * Якоря задания (0186): утверждение файла якорей и привязка к узлам структуры.
 *
 * Заказчик: аудитор формально есть, а с чем он сверяет — не задано. Якоря
 * (claim/check/status/approval) — механизм воркспейса; здесь только две вещи,
 * которые движок обязан доказать до запуска:
 *
 *   validateApproval — docs/anchors.json утверждён, а не перечислен: algo
 *   sha256, hash совпадает с дословными байтами файла, signature.covers ===
 *   'hash+by+at'. Манифест 0.3 включается по НАЛИЧИЮ поля layer/sides/enforcedBy
 *   (пустое значение — отказ с названием поля): layer — 'project'|'contour'
 *   (или выводится из sides/scope, но не из 'both'), sides — область, scope —
 *   её переходный алиас, enforcedBy — 'engine'|'nodes'|'both', причём engine
 *   запрещён для проекта и для 'both'. Подпись только человеческая (human-*) на
 *   любом слое: агент якоря не утверждает. Новое утверждение 0.3 обязано
 *   утверждать файл с LF в конце; старое scope-only читается по алиасу с
 *   прежней терпимостью (совместимость 0186).
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

/** Слои утверждения (манифест 0.3): проект или контур. */
export const APPROVAL_LAYERS = ['project', 'contour'];

/** Кто исполняет утверждение: движок, узлы или обе стороны. */
export const APPROVAL_ENFORCERS = ['engine', 'nodes', 'both'];

/** Область утверждения (sides): один слой или обе стороны. */
export const APPROVAL_SIDES = ['project', 'contour', 'both'];

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
 * этих байтов, algo — sha256, а подпись покрывать hash+by+at. Манифест 0.3
 * добавляет слой и исполнителя: layer — 'project'|'contour' (обязателен, но
 * выводится из sides/scope для старых утверждений), sides — область, scope —
 * переходный алиас sides (расхождение — отказ), enforcedBy — 'engine'|'nodes'|
 * 'both', причём engine для layer=project запрещён: движок проект не утверждает.
 * Подпись — только human-* на любом слое, 'both' — тем более. Новое утверждение
 * 0.3 (с layer/sides/enforcedBy) утверждает файл с LF в конце; старое scope-only
 * читается по алиасу и без LF — совместимость 0186. Каноникализация хеша —
 * отдельная задача: здесь дословные байты.
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
  const signature = isPlainObject(approval.signature) ? approval.signature : null;
  const keyId = text(signature && signature.keyId);
  const humanKey = /^human-/u.test(keyId);
  /*
   * Манифест 0.3 включается по НАЛИЧИЮ собственного поля layer/sides/enforcedBy,
   * а не по непустому значению (0194, инвариант 1): иначе пустые layer/sides/
   * enforcedBy выключали обязательный LF и обязательного исполнителя — это и
   * был обход 0193. Пустое заданное поле — отдельный отказ с названием поля, а
   * не способ остаться в схеме 0.2. Старое утверждение с одним scope (0186)
   * читается по алиасу и сохраняет прежнюю терпимость к отсутствию LF: оно
   * утверждало файл без перевода строки, и checks/0186 c1..c5 обязаны остаться
   * зелёными (инвариант 6 задания 0194).
   */
  const hasOwn = (name) => Object.prototype.hasOwnProperty.call(approval, name);
  const given = {
    layer: hasOwn('layer'),
    sides: hasOwn('sides'),
    scope: hasOwn('scope'),
    enforcedBy: hasOwn('enforcedBy'),
  };
  const manifest03 = given.layer || given.sides || given.enforcedBy;
  const field = (name) => (given[name] ? text(approval[name]).toLowerCase() : '');
  const layerField = field('layer');
  const sidesField = field('sides');
  const scopeField = field('scope');
  const enforcedField = field('enforcedBy');

  /* Заданное, но пустое поле называется прямо: «layer пуст», а не «нет layer». */
  const emptyHints = {
    layer: 'слой: project или contour',
    sides: 'область: project, contour или both',
    scope: 'область: project, contour или both',
    enforcedBy: 'исполнитель: engine, nodes или both',
  };
  for (const name of ['layer', 'sides', 'scope', 'enforcedBy']) {
    if (given[name] && field(name) === '') {
      errors.push(name + ' пуст: поле задано, но значение пустое — назовите ' + emptyHints[name]);
    }
  }

  const algo = text(approval.algo).toLowerCase();
  if (algo !== APPROVAL_ALGO) {
    errors.push('algo «' + text(approval.algo) + '» не поддерживается: утверждение считается только по sha256');
  }

  /* LF — часть утверждаемых байтов: файл без перевода строки не утверждён. */
  if (manifest03 && !anchorsText.endsWith('\n')) {
    errors.push('нет LF в конце файла: утверждение 0.3 требует перевода строки в конце docs/anchors.json (хеш — дословные байты)');
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
  if (!signature) {
    errors.push('нет signature: утверждение подписывается, а не пересказывается');
  } else {
    const covers = text(signature.covers);
    if (covers !== APPROVAL_COVERS) {
      errors.push('signature.covers «' + covers + '» не покрывает hash+by+at: подпись без автора и времени не утверждение');
    }
    /*
     * Подпись человеческая на любом слое: утверждение проекта агентом — такое же
     * самоутверждение, как и обеих сторон. Агентский ключ не проходит никогда.
     */
    if (!humanKey) {
      errors.push('подпись только human-*: signature.keyId «' + keyId + '» не человеческий ключ — агент якоря не утверждает');
    }
  }
  if (layerField && !APPROVAL_LAYERS.includes(layerField)) {
    errors.push('layer «' + text(approval.layer) + '» неизвестен: допустимы project и contour');
  }
  if (sidesField && !APPROVAL_SIDES.includes(sidesField)) {
    errors.push('sides «' + text(approval.sides) + '» неизвестна: допустимы project, contour и both');
  }
  if (scopeField && !APPROVAL_SIDES.includes(scopeField)) {
    errors.push('scope «' + text(approval.scope) + '» неизвестен: допустимы project, contour и both');
  }
  if (sidesField && scopeField && sidesField !== scopeField) {
    errors.push('sides «' + sidesField + '» и scope «' + scopeField + '» расходятся: scope — алиас sides, одно утверждение не называет две области');
  }
  /*
   * layer выводится из области, только когда область называет одну сторону:
   * 'both' — это обе стороны, слой из него не следует (инвариант 3).
   */
  const areaRaw = sidesField || scopeField;
  const area = APPROVAL_SIDES.includes(areaRaw) ? areaRaw : '';
  const layer = layerField || (area !== '' && area !== 'both' ? area : '');
  if (layerField && area && layerField !== area) {
    errors.push('layer «' + layerField + '» и ' + (sidesField ? 'sides' : 'scope') + ' «' + area + '» расходятся: слой и область утверждения — одно');
  }
  if (!layer && !area && !given.layer && !given.sides && !given.scope) {
    errors.push('нет layer и нет scope/sides: утверждение обязано назвать слой — project или contour (область: project, contour или both)');
  }
  if (enforcedField && !APPROVAL_ENFORCERS.includes(enforcedField)) {
    errors.push('enforcedBy «' + text(approval.enforcedBy) + '» неизвестен: допустимы engine, nodes и both');
  } else if (manifest03 && !given.enforcedBy) {
    errors.push('нет enforcedBy: утверждение 0.3 обязано назвать исполнителя — engine, nodes или both');
  }
  /*
   * Проект внутри 'both' — значит engine запрещён и для обеих сторон: проект
   * исполняют узлы, движок не утверждающая сторона (инвариант 4).
   */
  if (enforcedField === 'engine' && (layer === 'project' || area === 'both')) {
    errors.push('enforcedBy engine для ' + (layer === 'project' && area !== 'both'
      ? 'layer project'
      : 'обеих сторон (project внутри)')
      + ' запрещён: проект исполняют узлы (nodes или both), движок не утверждающая сторона');
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
