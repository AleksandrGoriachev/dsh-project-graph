/**
 * Редактор проектных семантических якорей (0192).
 *
 * Заказчик правит якоря не JSON-руками, а в панели structure. Здесь — всё,
 * что должно быть доказано до записи, и ни одной сетевой вещи:
 *
 *   validateAnchorsDoc — манифест 0.3 (version 2): anchors[]; id уникален и
 *   непуст; claim/check/status непусты; layer project|contour, enforcedBy
 *   engine|nodes|both, sides both|contour|project. Проектный слой не утверждает
 *   движок: у layer project enforcedBy не engine и не both (инвариант 0194) —
 *   иначе файл описывал бы проверку, которой движок не выполняет.
 *
 *   readAnchorsDoc — что лежит в docs/anchors.json сейчас: doc (даже невалидный,
 *   чтобы человек видел, что правит), exists, hash дословных байтов и findings.
 *   Чтение не бросает: нет файла, битый JSON, невалидный манифест — это находки,
 *   а не сломанная панель.
 *
 *   saveAnchorsDoc — только после validate; атомарная запись (временный сосед +
 *   rename), hash считается по дословным байтам записанного текста, после записи
 *   файл перечитывается и сверяется. Отказ возвращает errors, а не бросает.
 *
 *   anchorsApprovalState — подпись владельца (docs/anchors.approval.json) против
 *   текущего текста: present / ok / hashMatches; «изменено после подписи» —
 *   отдельное состояние (hash есть, но не совпал). Подпись панель не ставит и
 *   ключ владельца не читает: только статус.
 *
 *   validateConsumes — привязка узла к якорям: каждый id объявлен в файле, у
 *   узла-ревьюера и узла-аудитора непустой consumes. Проверка — тот же
 *   validateBinding из lib/anchors.js, чтобы панель, гейт запуска и валидатор
 *   структуры говорили одно и то же.
 *
 * Хеш — sha256 дословных байтов файла, LF в конце: ровно это утверждает
 * validateApproval (манифест 0.3 требует перевод строки).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { anchorIds, sha256Hex, validateApproval, validateBinding } from './anchors.js';

/** Логический путь файла якорей от корня проекта. */
export const ANCHORS_REL = 'docs/anchors.json';
/** Логический путь утверждения якорей: подписывает владелец, не панель. */
export const APPROVAL_REL = 'docs/anchors.approval.json';
/** Версия манифеста, которую понимает редактор: 0.3 — version 2. */
export const ANCHORS_VERSION = 2;
/** Слои утверждения: проектные якоря и контурные якоря workflow. */
export const ANCHOR_LAYERS = ['project', 'contour'];
/** Кто исполняет якорь. */
export const ANCHOR_ENFORCERS = ['engine', 'nodes', 'both'];
/** Область утверждения: сторона проекта, контур или обе. */
export const ANCHOR_SIDES = ['both', 'contour', 'project'];
/** Поля якоря, которые обязаны быть непустыми. */
export const ANCHOR_REQUIRED_TEXT = ['id', 'claim', 'check', 'status'];
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function projectRoot(root) {
  return path.resolve(String(root === undefined || root === null || root === '' ? process.cwd() : root));
}

/** Абсолютный путь якорей проекта: docs/anchors.json. */
export function anchorsFilePath(root) {
  return path.join(projectRoot(root), 'docs', 'anchors.json');
}

/** Абсолютный путь утверждения: docs/anchors.approval.json. */
export function approvalFilePath(root) {
  return path.join(projectRoot(root), 'docs', 'anchors.approval.json');
}

/** Находка чтения — не исключение: код, фраза, рецепт. */
function finding(code, message, fix) {
  return { code, message, ...(fix ? { fix } : {}) };
}

/**
 * Проверить документ якорей по инвариантам манифеста 0.3.
 *
 * @param doc - разобранный docs/anchors.json (любое значение).
 * @returns {{ ok: boolean, errors: string[] }} errors — по фразе на нарушение,
 *   каждая называет индекс якоря или поле.
 */
export function validateAnchorsDoc(doc) {
  if (!isPlainObject(doc)) {
    return { ok: false, errors: ['anchors: корень — не JSON-объект { version: 2, anchors: [...] }'] };
  }
  const errors = [];
  if (Number(doc.version) !== ANCHORS_VERSION) {
    errors.push('version «' + String(doc.version) + '» не манифест 0.3: нужен version: 2');
  }
  if (!Array.isArray(doc.anchors)) {
    errors.push('anchors: нет массива якорей — объявите anchors: [] или список якорей');
    return { ok: false, errors };
  }
  const seen = new Set();
  doc.anchors.forEach((anchor, index) => {
    const at = 'anchors[' + index + ']';
    if (!isPlainObject(anchor)) {
      errors.push(at + ': якорь — не JSON-объект');
      return;
    }
    for (const field of ANCHOR_REQUIRED_TEXT) {
      if (!text(anchor[field])) {
        errors.push(at + '.' + field + ' пуст: у якоря должны быть id, claim, check и status');
      }
    }
    const id = text(anchor.id);
    if (id) {
      const key = id.toLowerCase();
      if (seen.has(key)) {
        errors.push(at + '.id «' + id + '» повторяется: id якоря уникален — по нему ссылаются узлы');
      } else {
        seen.add(key);
      }
    }
    const layer = text(anchor.layer).toLowerCase();
    const enforcedBy = text(anchor.enforcedBy).toLowerCase();
    const sides = text(anchor.sides).toLowerCase();
    if (!layer) {
      errors.push(at + '.layer пуст: слой якоря — project или contour');
    } else if (!ANCHOR_LAYERS.includes(layer)) {
      errors.push(at + '.layer «' + text(anchor.layer) + '» неизвестен: допустимы project и contour');
    }
    if (!enforcedBy) {
      errors.push(at + '.enforcedBy пуст: исполнитель якоря — engine, nodes или both');
    } else if (!ANCHOR_ENFORCERS.includes(enforcedBy)) {
      errors.push(at + '.enforcedBy «' + text(anchor.enforcedBy) + '» неизвестен: допустимы engine, nodes и both');
    }
    if (!sides) {
      errors.push(at + '.sides пуст: область якоря — both, contour или project');
    } else if (!ANCHOR_SIDES.includes(sides)) {
      errors.push(at + '.sides «' + text(anchor.sides) + '» неизвестна: допустимы both, contour и project');
    }
    /*
     * Проектный слой не утверждает движок (инвариант 0194): project + engine —
     * якорь, который движок якобы исполняет, а project + both — то же самое,
     * спрятанное за «обе стороны». Проект исполняют узлы: nodes.
     */
    if (layer === 'project' && (enforcedBy === 'engine' || enforcedBy === 'both')) {
      errors.push(at + '.enforcedBy «' + text(anchor.enforcedBy) + '» для layer project запрещён: '
        + 'проектный якорь исполняют узлы (nodes), движок проект не утверждает');
    }
    if (anchor.confirmed !== undefined && typeof anchor.confirmed !== 'boolean') {
      errors.push(at + '.confirmed должен быть true или false, получено ' + JSON.stringify(anchor.confirmed));
    }
  });
  return { ok: errors.length === 0, errors };
}
/**
 * Прочитать docs/anchors.json и назвать всё, что с ним не так.
 *
 * @param root - корень проекта.
 * @returns { path, rel, exists, doc, findings, hash }: doc — разобранный
 *   документ даже при нарушении инвариантов (человеку есть что править);
 *   findings — находки чтения и валидации, а не исключения.
 */
export function readAnchorsDoc(root) {
  const file = anchorsFilePath(root);
  const rel = ANCHORS_REL;
  const exists = fs.existsSync(file);
  if (!exists) {
    return {
      path: file,
      rel,
      exists: false,
      doc: null,
      findings: [finding('anchors-missing',
        'файла ' + rel + ' нет: у проекта ещё нет проектных якорей',
        'Добавьте якоря в разделе «Якоря» и нажмите «Сохранить» — файл появится в ' + rel + '.')],
      hash: '',
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      path: file,
      rel,
      exists: true,
      doc: null,
      findings: [finding('anchors-unreadable',
        rel + ' не читается: ' + (error && error.message ? error.message : 'ошибка'),
        'Проверьте права на ' + rel + ' и повторите чтение.')],
      hash: '',
    };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    return {
      path: file,
      rel,
      exists: true,
      doc: null,
      findings: [finding('anchors-json',
        rel + ' не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'),
        'Исправьте JSON в ' + rel + ': манифест 0.3 — { version: 2, anchors: [...] }.')],
      hash: sha256Hex(raw),
    };
  }
  const checked = validateAnchorsDoc(doc);
  const findings = checked.errors.map((message) => finding('anchors-invalid', message,
    'Исправьте якорь в разделе «Якоря» — файл ' + rel + ' не сохраняется, пока манифест невалиден.'));
  /*
   * ids — объявленные якоря одним списком (anchorIds из lib/anchors.js): по ним
   * панель и проверка отвечают «есть ли такой вход», не перечитывая документ.
   */
  return { path: file, rel, exists: true, doc, findings, hash: sha256Hex(raw), ids: anchorIds(doc) };
}
/** Счётчик временных имён: две записи в одном процессе не должны совпасть. */
let atomicCounter = 0;

/**
 * Записать файл через временного соседа и rename.
 *
 * Рядом с целью, а не во временной папке: rename в пределах одной папки —
 * атомарная подмена, и читатель видит либо старый файл, либо новый, но не
 * половину. Проигранная гонка rename на Windows (EPERM/EBUSY) повторяется; на
 * любом сбое временный файл убирается, чтобы отказ не оставлял мусора.
 */
function writeAtomic(target, data) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  atomicCounter += 1;
  const temp = path.join(dir, '.' + path.basename(target) + '.tmp-' + process.pid + '-'
    + atomicCounter + '-' + crypto.randomBytes(4).toString('hex'));
  try {
    fs.writeFileSync(temp, data, 'utf8');
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the write error is what matters */ }
    throw error;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, target);
      return target;
    } catch (error) {
      const retryable = ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error && error.code);
      if (!retryable || attempt >= 20) {
        try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
        throw error;
      }
      const end = Date.now() + 5;
      while (Date.now() < end) { /* короткая пауза: файл держит антивирус или соседняя запись */ }
    }
  }
}

/**
 * Сохранить документ якорей — только валидный.
 *
 * @param root - корень проекта.
 * @param doc - документ манифеста 0.3.
 * @returns { ok, errors, hash, previousHash, path, rel }: ok true — файл
 *   записан и перечитан с тем же хешем; иначе errors перечисляют причины.
 *   Хеш — sha256 дословных байтов записанного текста (JSON + LF в конце).
 */
export function saveAnchorsDoc(root, doc) {
  const checked = validateAnchorsDoc(doc);
  if (!checked.ok) {
    return { ok: false, code: 'anchors-invalid', errors: checked.errors, hash: '', previousHash: '' };
  }
  const file = anchorsFilePath(root);
  const rel = ANCHORS_REL;
  const data = JSON.stringify(doc, null, 2) + '\n';
  const hash = sha256Hex(data);
  let previousHash = '';
  try {
    if (fs.existsSync(file)) previousHash = sha256Hex(fs.readFileSync(file, 'utf8'));
  } catch {
    previousHash = '';
  }
  try {
    writeAtomic(file, data);
  } catch (error) {
    return {
      ok: false,
      code: 'anchors-write',
      errors: ['не удалось записать ' + rel + ': ' + (error && error.message ? error.message : 'ошибка')],
      hash: '',
      previousHash,
      path: file,
      rel,
    };
  }
  let written = '';
  try {
    written = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      ok: false,
      code: 'anchors-verify',
      errors: ['запись прошла, но ' + rel + ' не перечитывается: ' + (error && error.message ? error.message : 'ошибка')],
      hash,
      previousHash,
      path: file,
      rel,
    };
  }
  if (sha256Hex(written) !== hash) {
    return {
      ok: false,
      code: 'anchors-verify',
      errors: ['после записи текст ' + rel + ' не совпал с сохранённым: файл изменён другой записью, повторите сохранение'],
      hash,
      previousHash,
      path: file,
      rel,
    };
  }
  return { ok: true, errors: [], hash, previousHash, path: file, rel };
}
/**
 * Состояние подписи якорей: docs/anchors.approval.json против текущего текста.
 *
 * @param root - корень проекта.
 * @returns { present, ok, errors, hashMatches, approvedHash, changedAfterSign,
 *   path, rel, approval, by, at, keyId }:
 *   present — файл утверждения есть; ok — утверждение валидно и хеш совпал;
 *   changedAfterSign — хеш в утверждении есть, но текст якорей изменился после
 *   подписи (якоря не действуют до переподписи владельцем).
 */
export function anchorsApprovalState(root) {
  const file = approvalFilePath(root);
  const rel = APPROVAL_REL;
  const present = fs.existsSync(file);
  const base = {
    present,
    ok: false,
    errors: [],
    hashMatches: false,
    approvedHash: '',
    changedAfterSign: false,
    path: file,
    rel,
    approval: null,
    by: '',
    at: '',
    keyId: '',
  };
  const readDoc = readAnchorsDoc(root);
  const anchorsText = readDoc.exists && readDoc.doc !== null ? readTextOrEmpty(readDoc.path) : '';
  if (!present) {
    return {
      ...base,
      errors: ['файла ' + rel + ' нет: якоря не утверждены. Подпись ставит владелец вне панели, ключ здесь не читается.'],
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      ...base,
      errors: [rel + ' не читается: ' + (error && error.message ? error.message : 'ошибка')],
    };
  }
  let approval;
  try {
    approval = JSON.parse(raw);
  } catch (error) {
    return {
      ...base,
      errors: [rel + ' не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка')],
    };
  }
  if (!readDoc.exists || readDoc.doc === null) {
    return {
      ...base,
      approval: isPlainObject(approval) ? approval : null,
      approvedHash: text(isPlainObject(approval) ? approval.hash : '').toLowerCase(),
      errors: ['docs/anchors.json не прочитан — подписывать нечего: '
        + (readDoc.findings[0] ? readDoc.findings[0].message : 'файла нет')],
    };
  }
  const checked = validateApproval(approval, anchorsText, { root });
  const approvedHash = text(isPlainObject(approval) ? approval.hash : '').toLowerCase();
  const actual = sha256Hex(anchorsText);
  /*
   * R3 (ревью 0192): «изменено после подписи» — только для well-formed sha256,
   * который не совпал. Опечатка или обрезанный hash — не изменение файла, а
   * недействительная подпись: формат называет validateApproval, и отдельной
   * фразы «якоря изменены» быть не должно (иначе панель показывала бы changed).
   */
  const hashWellFormed = /^[0-9a-f]{64}$/u.test(approvedHash);
  const hashMatches = hashWellFormed && approvedHash === actual;
  const errors = [...checked.errors];
  if (hashWellFormed && !hashMatches) {
    errors.push('hash утверждения не совпадает с ' + ANCHORS_REL + ': якоря изменены после подписи (ожидался '
      + actual + ', утверждён ' + approvedHash + ')');
  }
  const signature = isPlainObject(approval) && isPlainObject(approval.signature) ? approval.signature : {};
  return {
    ...base,
    ok: checked.ok && hashMatches,
    errors,
    hashMatches,
    approvedHash,
    changedAfterSign: hashWellFormed && !hashMatches,
    approval: isPlainObject(approval) ? approval : null,
    by: text(approval && approval.by),
    at: text(approval && approval.at),
    keyId: text(signature && signature.keyId),
  };
}

/** Дословный текст файла; ошибка чтения — пустая строка (её назвал readAnchorsDoc). */
function readTextOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Проверить привязку одного узла к якорям.
 *
 * Узел может объявить вход как anchors.consumes или как переходный
 * anchors.consumers (0192): оба имени читаются одним списком, в графе и
 * ответе остаётся canonical consumes. Каждый id обязан существовать в файле
 * якорей, а узел-ревьюер и узел-аудитор — объявить непустой consumes.
 *
 * @param node - узел структуры (любое значение).
 * @param anchorsDoc - разобранный docs/anchors.json (корень или список).
 * @returns {{ ok: boolean, errors: string[] }}.
 */
export function validateConsumes(node, anchorsDoc) {
  if (!isPlainObject(node)) {
    return { ok: false, errors: ['узел: не JSON-объект — привязывать нечего'] };
  }
  const source = node.anchors;
  let anchors;
  if (isPlainObject(source)) {
    anchors = {};
    if (source.consumes !== undefined) anchors.consumes = source.consumes;
    else if (source.consumers !== undefined) anchors.consumes = source.consumers;
    if (source.produces !== undefined) anchors.produces = source.produces;
  }
  const normalized = { ...node, ...(anchors !== undefined ? { anchors } : {}) };
  /* Список якорей проверяется validateBinding: один источник правды с гейтом. */
  return validateBinding({ nodes: [normalized] }, anchorsDoc);
}
