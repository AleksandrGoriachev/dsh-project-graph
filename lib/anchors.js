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
 * 0206: проверяющая роль без consumes получает default all-auto — вход из всех
 * auto-якорей, runtime, без записи в structure. Явные consumes не меняются,
 * non-audit consumes — warning, не отказ. Отказ 0186 (bound-роль без consumes)
 * остаётся только у аудитора и ревьюера: judge/приёмщик/судья не bound, и без
 * auto-якорей их пустой consumes отказом не становится. Структуры без
 * policyVersion живут по прежним правилам 0186.
 *
 * Гейт запуска (lib/spawn.js) и проверки говорят одно и то же, потому что зовут
 * эти же функции.
 *
 * 0204: подпись больше не пересказывается, а проверяется — всегда.
 * validateApproval сверяет Ed25519 по canonical({hash,by,at}): ключ —
 * options.publicKeyPem, иначе <keysDir>/<keyId>.pub.pem (keysDir —
 * options.keysDir, иначе <options.root>/.wf-keys, иначе ./.wf-keys). Нет ключа,
 * не-Ed25519 value, расхождение publicKeyFingerprint — отказ (fail-closed).
 * «Проверить нельзя» здесь значит «не утверждено»; backdoor для фикстур нет.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { auditRoleKind, defaultConsumes } from './role-policy.js';

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

/** Алгоритм подписи утверждения (0204): только Ed25519. */
export const APPROVAL_SIGNATURE_ALGO = 'ed25519';

/** Штатный каталог человеческих ключей: <root>/.wf-keys/<keyId>.pub.pem. */
export const APPROVAL_KEYS_DIR = '.wf-keys';

/**
 * Версия манифеста якорей v3 (0298): применимость якоря названа ролями узла.
 *
 * v3 отличается от v2 одним обязательным полем — appliesTo.roles; прежние
 * id/claim/check/status/layer/sides/enforcedBy читаются по тем же правилам.
 * Версия 2 остаётся для совместимости: у неё appliesTo нет и не требуется.
 */
export const ANCHORS_VERSION_V3 = 3;

/** keyId — имя файла ключа: без слэшей и «..». */
const KEY_ID_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Ed25519-подпись — ровно 64 байта. */
const ED25519_SIGNATURE_BYTES = 64;

/** Legacy-id ревьюера: узел reviewer-1 — ревьюер и без роли (0186/0206). */
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

/** Текст ошибки одной строкой: причина отказа не теряется в объекте. */
function errorText(error) {
  return String(error && error.message ? error.message : error);
}

/**
 * Каноническая строка подписи утверждения: canonical({hash, by, at}).
 *
 * Ровно её подписывает владелец: ключи по алфавиту, без пробелов, значения —
 * дословно как в утверждении (JSON.stringify без отступов). Так же считает
 * workflow-движок, и так же — подписывающий.
 *
 * @param approval - разобранное утверждение (любое значение).
 * @returns Строка canonical({hash, by, at}); у не-объекта поля пустые.
 */
export function approvalSigningText(approval) {
  const source = isPlainObject(approval) ? approval : {};
  const fields = { hash: source.hash, by: source.by, at: source.at };
  const keys = Object.keys(fields).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + JSON.stringify(fields[key])).join(',') + '}';
}

/** Отпечаток публичного ключа: первые 16 hex SHA-256 от DER SPKI (как в движке). */
function publicKeyFingerprintOf(key) {
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/**
 * Публичный ключ утверждения: options.publicKeyPem или файл ключа.
 *
 * Ключ не угадывается: если PEM не передан, keyId обязан быть именем файла, а
 * файл — лежать в <keysDir>/<keyId>.pub.pem. Нет файла или он не читается —
 * отказ; fail-closed здесь и есть отказ от «утверждения на веру».
 */
function approvalPublicKey(approval, options) {
  const signature = isPlainObject(approval.signature) ? approval.signature : {};
  const keyId = text(signature.keyId);
  if (typeof options.publicKeyPem === 'string' && options.publicKeyPem.trim()) {
    try {
      return { key: crypto.createPublicKey(options.publicKeyPem.trim()) };
    } catch {
      return { errors: ['options.publicKeyPem не читается: нужен PEM публичного ключа Ed25519 (fail-closed)'] };
    }
  }
  if (!KEY_ID_FILE.test(keyId)) {
    return {
      errors: ['signature.keyId «' + keyId + '» не имя ключа: ключ ищется как <keysDir>/<keyId>.pub.pem (fail-closed)'],
    };
  }
  const explicitDir = typeof options.keysDir === 'string' && options.keysDir.trim() ? options.keysDir.trim() : '';
  const root = typeof options.root === 'string' && options.root.trim() ? options.root.trim() : '';
  let keysDir;
  try {
    keysDir = explicitDir || path.join(root || process.cwd(), APPROVAL_KEYS_DIR);
  } catch {
    return { errors: ['каталог ключей не определён: options.root/keysDir не путь (fail-closed)'] };
  }
  const file = path.join(keysDir, keyId + '.pub.pem');
  let pem;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      errors: ['нет публичного ключа «' + keyId + '»: ' + file + ' не читается (' + errorText(error)
        + ') — fail-closed: подпись без ключа не принимается'],
    };
  }
  try {
    return { key: crypto.createPublicKey(pem) };
  } catch {
    return { errors: ['публичный ключ ' + file + ' не читается: нужен PEM Ed25519 (fail-closed)'] };
  }
}

/**
 * Проверить Ed25519-подпись утверждения по canonical({hash, by, at}) (0204).
 *
 * Подпись — не пересказ: value обязан быть base64 ровно 64 байт, algo —
 * ed25519, by/at — названы (они входят в подписанную строку). Ключ — из
 * options.publicKeyPem, иначе из файла <keysDir>/<keyId>.pub.pem; публикация
 * publicKeyFingerprint сверяется с ключом. Любая неясность — отказ.
 *
 * @param approval - разобранное утверждение (объект).
 * @param options - { publicKeyPem?, root?, keysDir? }.
 * @returns {{ ok: boolean, errors: string[] }} ok — подпись подтверждена ключом.
 */
export function verifyApprovalSignature(approval, options = {}) {
  if (!isPlainObject(approval)) {
    return { ok: false, errors: ['approval: корень — не JSON-объект, подпись не проверяется'] };
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { ok: false, errors: ['options: ожидается объект { publicKeyPem?, root?, keysDir? } — иначе подпись не проверить'] };
  }
  const signature = isPlainObject(approval.signature) ? approval.signature : null;
  if (!signature) return { ok: false, errors: ['нет signature: подпись Ed25519 нечего проверять'] };
  const errors = [];
  const sigAlgo = text(signature.algo).toLowerCase();
  if (sigAlgo !== APPROVAL_SIGNATURE_ALGO) {
    errors.push('signature.algo «' + text(signature.algo) + '» не проверяется: подпись утверждения — ed25519');
  }
  const by = Array.isArray(approval.by) ? approval.by : [];
  if (by.length === 0 || by.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push('by: кто утверждает — непустой список непустых строк; иначе canonical({hash,by,at}) не называет автора');
  }
  if (typeof approval.at !== 'string' || !approval.at.trim()) {
    errors.push('at: когда утверждено — непустая строка; иначе canonical({hash,by,at}) не называет время');
  }
  const value = text(signature.value);
  if (!value) {
    errors.push('signature.value пуст: подпись без значения не проверяется (fail-closed)');
  } else {
    let bytes = null;
    if (/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
      try {
        bytes = Buffer.from(value, 'base64');
      } catch {
        bytes = null;
      }
    }
    if (!bytes) {
      errors.push('signature.value — не base64: подпись Ed25519 хранится в base64 (fail-closed)');
    } else if (bytes.length !== ED25519_SIGNATURE_BYTES) {
      errors.push('signature.value — не Ed25519: ожидалось ' + ED25519_SIGNATURE_BYTES
        + ' байт, пришло ' + bytes.length + ' (fail-closed)');
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const resolved = approvalPublicKey(approval, options);
  if (resolved.errors) return { ok: false, errors: resolved.errors };
  const key = resolved.key;
  const pinned = text(approval.publicKeyFingerprint).toLowerCase();
  if (pinned) {
    if (!/^[0-9a-f]{16}$/u.test(pinned)) {
      return {
        ok: false,
        errors: ['publicKeyFingerprint «' + text(approval.publicKeyFingerprint)
          + '» — не 16 hex: отпечаток ключа не сверить (fail-closed)'],
      };
    }
    if (publicKeyFingerprintOf(key) !== pinned) {
      return {
        ok: false,
        errors: ['publicKeyFingerprint не совпадает с ключом: утверждение подписано другим ключом (keyId «'
          + text(signature.keyId) + '»)'],
      };
    }
  }
  let verified = false;
  try {
    verified = crypto.verify(null, Buffer.from(approvalSigningText(approval), 'utf8'), key, Buffer.from(value, 'base64'));
  } catch (error) {
    return { ok: false, errors: ['подпись не проверена: ' + errorText(error) + ' (fail-closed)'] };
  }
  if (!verified) {
    return {
      ok: false,
      errors: ['подпись Ed25519 не совпадает с canonical({hash,by,at}) ключа «' + text(signature.keyId)
        + '»: утверждение подделано или изменено'],
    };
  }
  return { ok: true, errors: [] };
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

/**
 * Bound-роль привязки: только аудитор и ревьюер (0186).
 *
 * 0206 не расширяет отказ 0186 на судью/приёмщика: judge/acceptor/судья без
 * consumes не bound. Default all-auto применяется к их входу, когда auto-якоря
 * есть, но при их отсутствии это не отказ. Legacy-id auditor/reviewer* и тут
 * сохраняют прежнюю силу: id — адрес, роль — назначение.
 */
function anchorBoundRole(node) {
  const kind = auditRoleKind(node && node.role);
  if (kind === 'аудитор' || kind === 'ревьюер') return kind;
  const id = text(node && node.id);
  if (id.toLowerCase() === 'auditor') return 'аудитор';
  if (REVIEWER_ID.test(id)) return 'ревьюер';
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
 * 0204: третьего аргумента «без проверки» нет — подпись обязательна. Options
 * называет, откуда взять публичный ключ (PEM или root/keysDir для
 * .wf-keys/<keyId>.pub.pem); без него ключ ищется в ./.wf-keys, и отсутствие
 * ключа — отказ, а не пропуск.
 *
 * @param approval - разобранный JSON утверждения (любое значение).
 * @param anchorsText - дословный текст docs/anchors.json.
 * @param options - { publicKeyPem?, root?, keysDir? }; нет — только структура.
 * @returns {{ ok: boolean, errors: string[] }} ok — якоря утверждены.
 */
export function validateApproval(approval, anchorsText, options) {
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
  /*
   * 0204: утверждение обязано быть подписано ключом, который можно проверить.
   * Отсутствие ключа, чужой ключ, подмена value, нечеловеческий keyId и
   * расхождение publicKeyFingerprint — ошибки, а не предупреждения: подпись,
   * которую нельзя проверить, не утверждение. Легаси-фикстуры с value:'x'
   * падают намеренно (известный долг 0186/0193/0194), backdoor для них нет.
   */
  const verification = verifyApprovalSignature(approval, options === undefined ? {} : options);
  if (!verification.ok) errors.push(...verification.errors);
  return { ok: errors.length === 0, errors };
}

/**
 * Проверить привязку якорей к узлам структуры.
 *
 * Каждый id, названный узлом в anchors.consumes/produces, обязан существовать в
 * файле якорей: ссылка на несуществующий якорь — это не проверка.
 *
 * 0206: проверяющая роль без consumes получает default all-auto — вход из всех
 * auto-якорей документа; это runtime-значение, structure не переписывается.
 * Явные consumes не меняются (default их не дополняет), а consumes у
 * non-audit-роли — warning, а не отказ: legacy-структуры не ломаются.
 * Отказ 0186 остаётся у bound-ролей — аудитора и ревьюера: без auto-якорей их
 * пустой consumes по-прежнему ошибка. Judge/приёмщик/судья не bound: при auto
 * default применяется, без auto отказа нет (live-совместимость legacy judge).
 *
 * @param graph - собранный граф структуры (nodes с anchors).
 * @param anchors - разобранный docs/anchors.json (корень или список).
 * @returns {{ ok: boolean, errors: string[], warnings?: string[] }} ok — привязка
 *   состоялась; warnings — замечания, не отменяющие запуск.
 */
export function validateBinding(graph, anchors) {
  const list = anchorList(anchors);
  if (!list) {
    return { ok: false, errors: ['anchors: нет списка якорей — привязывать не к чему'] };
  }
  const errors = [];
  const warnings = [];
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
    const policyAudit = auditRoleKind(node.role) !== '' || bound !== '';
    const explicit = consumesOf(node);
    /*
     * 0206: пустой consumes проверяющей роли — не дыра: вход задают auto-якоря.
     * Default считается для всех проверяющих (включая judge), но отказать без
     * него можно только bound-роли 0186 — аудитору и ревьюеру.
     */
    const defaults = policyAudit && explicit.length === 0 ? defaultConsumes(node, anchors) : [];
    if (bound && explicit.length === 0 && defaults.length === 0) {
      errors.push('узел «' + id + '» (' + bound + ') обязан объявить непустой anchors.consumes: '
        + bound + ' без якорей — не проверка, а подпись');
    }
    /*
     * Явный consumes у роли, которой он не положен, — повод сказать, но не
     * отказ: структура могла объявить вход до 0206, и запуск не должен падать.
     * Judge/приёмщик — проверяющая роль, поэтому warning не получает.
     */
    if (!policyAudit && explicit.length > 0) {
      const role = text(node.role) || 'роль не задана';
      warnings.push('узел «' + id + '» (' + role + ') объявил anchors.consumes ('
        + explicit.join(', ') + '), но роль не проверяющая: политика роли не требует consumes — warning, не отказ');
    }
  }
  const result = { ok: errors.length === 0, errors };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

/*
 * 0298: схема якорей v3 — appliesTo.roles, политика срока отдельно, миграция с
 * подтверждением. Здесь только чистые функции над разобранным JSON: файлы не
 * читаются и не пишутся, автовывода ролей нет.
 *
 * Версия 2 (манифест 0.3, 0192) читается по прежним правилам и без appliesTo:
 * id/claim/check/status непусты, id уникален, layer/sides/enforcedBy из прежних
 * наборов, plugin-якорь проекта не исполняет движок, appliesToKinds — если
 * задан. Версия 3 — то же плюс строгий appliesTo.roles: непустой список
 * непустых строк. Статус в v3 — из прежнего набора, новые значения не
 * вводятся.
 */

/** Версия манифеста 0.3 (0192): v2 читается по-прежнему, без appliesTo. */
const ANCHORS_VERSION_V2 = 2;

/**
 * Старейший манифест якорей (v1, 0324): плоская форма без sides. Мигрируется в
 * v3 только по подтверждённой карте ролей; в диагностике /api/anchors он —
 * ошибка с реальным числом якорей, а не «файла нет».
 */
const ANCHORS_VERSION_V1 = 1;

/** Слои, исполнители и области якоря — те же, что у манифеста 0.3. */
const ANCHOR_LAYERS = ['project', 'contour'];
const ANCHOR_ENFORCERS = ['engine', 'nodes', 'both'];
const ANCHOR_SIDES = ['both', 'contour', 'project'];
/*
 * Типы узлов для необязательного appliesToKinds (0261). Список повторяет
 * ANCHOR_KINDS редактора (lib/anchors-editor.js): импортировать его сюда
 * нельзя — редактор сам импортирует anchors.js, вышел бы цикл. Пока ветка v3
 * в редакторе отдельный шаг (0304), здесь та же проверка, чтобы значение
 * «bogus» не проходило в значок как допустимое.
 */
const ANCHOR_KINDS = [
  'coordinator', 'worker', 'designer', 'reviewer', 'judge', 'critic',
  'tester', 'release', 'auditor', 'adviser', 'security',
];

/**
 * Статусы якоря — прежний набор; в v3 новых значений нет.
 * auto/semi/inWork/retired — свежесть якорей (0107), active — статус якорей
 * 0186, который ещё остаётся в старых документах.
 */
export const ANCHOR_STATUSES = Object.freeze(['auto', 'semi', 'inWork', 'retired', 'active']);

/** Поля якоря, непустота которых была требованием и до v3. */
const ANCHOR_CORE_TEXT = ['id', 'claim', 'check', 'status'];

/**
 * Прежние поля якоря (манифест 0.3): общие для v2 и v3.
 *
 * Непустые id/claim/check/status, уникальный id, layer/sides/enforcedBy из
 * прежних наборов, а проектный якорь не исполняет движок (0194). Поле
 * appliesToKinds, если задано, проверяется как раньше (0261).
 */
function validateAnchorCore(anchor, at, errors, seen) {
  for (const field of ANCHOR_CORE_TEXT) {
    if (!text(anchor[field])) {
      errors.push(at + '.' + field + ' пуст: у якоря должны быть непустые id, claim, check и status');
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
  if (anchor.appliesToKinds !== undefined) {
    if (!Array.isArray(anchor.appliesToKinds) || anchor.appliesToKinds.length === 0) {
      errors.push(at + '.appliesToKinds пуст: список типов узлов задан, но пуст');
    } else {
      for (const item of anchor.appliesToKinds) {
        const kind = text(item);
        if (!kind) {
          errors.push(at + '.appliesToKinds: пустой тип узла');
          continue;
        }
        if (!ANCHOR_KINDS.includes(kind.toLowerCase())) {
          errors.push(at + '.appliesToKinds «' + kind + '» неизвестен: допустимы ' + ANCHOR_KINDS.join(', '));
        }
      }
    }
  }
  if (layer === 'project' && (enforcedBy === 'engine' || enforcedBy === 'both')) {
    errors.push(at + '.enforcedBy «' + text(anchor.enforcedBy) + '» для layer project запрещён: '
      + 'проектный якорь исполняют узлы (nodes), движок проект не утверждает');
  }
  if (anchor.confirmed !== undefined && typeof anchor.confirmed !== 'boolean') {
    errors.push(at + '.confirmed должен быть true или false, получено ' + JSON.stringify(anchor.confirmed));
  }
}

/**
 * Строгий v3: appliesTo.roles — непустой список непустых строк.
 *
 * Роли не сверяются с реестром ролей: набор ролей проекта — данные, а не новый
 * словарь в коде. Проверяется форма: якорь без ролей или с пустой ролью не
 * применяется ни к кому, и «привязка по роли» осталась бы обещанием.
 */
function validateAppliesToRoles(anchor, at, errors) {
  const appliesTo = isPlainObject(anchor.appliesTo) ? anchor.appliesTo : null;
  if (!appliesTo) {
    errors.push(at + '.appliesTo пуст: якорь v3 обязан назвать roles — непустой список ролей узлов');
    return;
  }
  const roles = appliesTo.roles;
  if (!Array.isArray(roles) || roles.length === 0) {
    errors.push(at + '.appliesTo.roles — непустой список ролей узлов: без роли якорь ни к кому не применяется');
    return;
  }
  roles.forEach((role, index) => {
    if (typeof role !== 'string' || !role.trim()) {
      errors.push(at + '.appliesTo.roles[' + index + ']: роль — непустая строка (id роли узла)');
    }
  });
}

/**
 * Проверить документ якорей: v2 — по-прежнему, v3 — строго с appliesTo.roles.
 *
 * @param doc - разобранный docs/anchors.json (любое значение).
 * @returns {{ ok: boolean, errors: string[] }} errors — по фразе на нарушение;
 *   каждая называет индекс якоря и поле.
 */
export function validateAnchorsDoc(doc) {
  if (!isPlainObject(doc)) {
    return { ok: false, errors: ['anchors: корень — не JSON-объект { version: 2|3, anchors: [...] }'] };
  }
  const version = Number(doc.version);
  if (version !== ANCHORS_VERSION_V2 && version !== ANCHORS_VERSION_V3) {
    return {
      ok: false,
      errors: ['version «' + String(doc.version) + '» не поддерживается: нужен 2 (манифест 0.3) или 3 (appliesTo.roles)'],
    };
  }
  const errors = [];
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
    validateAnchorCore(anchor, at, errors, seen);
    if (version !== ANCHORS_VERSION_V3) return;
    validateAppliesToRoles(anchor, at, errors);
    const status = text(anchor.status);
    /* inWork — верблюжий статус: сравниваем без регистра, набор тот же. */
    if (status && !ANCHOR_STATUSES.some((known) => known.toLowerCase() === status.toLowerCase())) {
      errors.push(at + '.status «' + status + '» не из прежнего набора: допустимы '
        + ANCHOR_STATUSES.join(', ') + ' (новые значения в v3 не вводятся)');
    }
  });
  return { ok: errors.length === 0, errors };
}

/** Подтверждённые роли одного якоря: только roleMapping[id], без автовывода. */
function confirmedRoles(roleMapping, id) {
  if (!isPlainObject(roleMapping) || !Object.prototype.hasOwnProperty.call(roleMapping, id)) return [];
  const value = roleMapping[id];
  if (!Array.isArray(value)) return [];
  const roles = [];
  for (const item of value) {
    const role = text(item);
    if (role && !roles.includes(role)) roles.push(role);
  }
  return roles;
}

/** Копия якоря для миграции: входной документ не меняется. */
function copyAnchor(anchor) {
  if (!isPlainObject(anchor)) return anchor;
  const copy = { ...anchor };
  if (isPlainObject(anchor.appliesTo)) copy.appliesTo = { ...anchor.appliesTo };
  return copy;
}

/**
 * Старый якорь (v1/v2) в форме, пригодной для строгой v3-проверки (0324).
 *
 * v1 не знал 0.3-поля sides, а v2-файл нового проекта пришёл без него же.
 * Роли не угадываются, а вот форма манифеста обязана быть полной, иначе старый
 * документ не мигрировать вообще: область выводится из уже названного слоя,
 * отсутствующий слой — project (якорь проекта), отсутствующий исполнитель —
 * nodes (движок проект не утверждает). Названные поля не переписываются,
 * незнакомые сохраняются.
 */
function migratedAnchorForm(anchor) {
  const copy = copyAnchor(anchor);
  if (!isPlainObject(copy)) return copy;
  const layer = text(copy.layer).toLowerCase();
  const sides = text(copy.sides).toLowerCase();
  if (!text(copy.layer)) copy.layer = sides === 'contour' ? 'contour' : 'project';
  if (!text(copy.sides)) copy.sides = layer === 'contour' ? 'contour' : 'project';
  if (!text(copy.enforcedBy)) copy.enforcedBy = 'nodes';
  return copy;
}

/**
 * Мигрировать документ якорей v1/v2 -> v3 по ПОДТВЕРЖДЁННОЙ карте ролей.
 *
 * Чистая функция: роли берутся только из roleMapping[id]; consumes узлов и
 * эвристики не читаются. Нет подтверждённых ролей хотя бы у одного якоря —
 * миграция отказывает и перечисляет такие id в missingRoles: молчаливое
 * угадывание роли сделало бы якорь шире или уже, чем решил человек.
 *
 * 0324: version 1 — старейший плоский манифест — принимается наравне с v2.
 * Недостающие 0.3-поля формы (layer/sides/enforcedBy) у старого якоря
 * дополняются умолчаниями проекта (migratedAnchorForm); роли по-прежнему
 * берутся только из roleMapping — автовывода нет.
 *
 * Уже v3-документ возвращается как есть (после строгой проверки): повторная
 * миграция не переписывает подтверждённые роли.
 *
 * @param doc - разобранный документ { version: 1|2, anchors: [...] }.
 * @param roleMapping - { '<id якоря>': ['роль', ...] } — подтверждение человека.
 * @returns {{ ok: boolean, doc: object|null, errors: string[], missingRoles: string[] }}
 */
export function migrateAnchorsV3(doc, roleMapping) {
  const errors = [];
  const missingRoles = [];
  const list = anchorList(doc);
  if (!list) {
    return {
      ok: false,
      doc: null,
      errors: ['anchors: нет списка якорей — мигрировать нечего (нужен { version: 1|2, anchors: [...] })'],
      missingRoles,
    };
  }
  const version = isPlainObject(doc) ? Number(doc.version) : NaN;
  if (version === ANCHORS_VERSION_V3) {
    const checked = validateAnchorsDoc(doc);
    if (!checked.ok) return { ok: false, doc: null, errors: checked.errors, missingRoles };
    return {
      ok: true,
      doc: { ...doc, anchors: list.map((anchor) => copyAnchor(anchor)) },
      errors,
      missingRoles,
    };
  }
  if (version !== ANCHORS_VERSION_V1 && version !== ANCHORS_VERSION_V2) {
    return {
      ok: false,
      doc: null,
      errors: ['migrateAnchorsV3: version «' + String(doc && doc.version)
        + '» не мигрируется — на входе документ v1 или v2, документ v3 возвращается как есть'],
      missingRoles,
    };
  }
  const migrated = list.map((anchor, index) => {
    const at = 'anchors[' + index + ']';
    if (!isPlainObject(anchor)) {
      errors.push(at + ': якорь — не JSON-объект');
      return anchor;
    }
    const copy = migratedAnchorForm(anchor);
    const id = text(anchor.id);
    if (!id) {
      errors.push(at + '.id пуст: подтверждённую роль не к чему привязать');
      return copy;
    }
    const roles = confirmedRoles(roleMapping, id);
    if (roles.length === 0) {
      missingRoles.push(id);
      errors.push('якорь «' + id + '»: роли не подтверждены — нужна запись roleMapping["'
        + id + '"] = [роли]; автовывод из consumes узлов запрещён');
    }
    const appliesTo = isPlainObject(copy.appliesTo) ? copy.appliesTo : {};
    copy.appliesTo = { ...appliesTo, roles };
    return copy;
  });
  if (missingRoles.length > 0) {
    return { ok: false, doc: null, errors, missingRoles };
  }
  if (errors.length > 0) {
    return { ok: false, doc: null, errors, missingRoles };
  }
  const candidate = { ...doc, version: ANCHORS_VERSION_V3, anchors: migrated };
  const checked = validateAnchorsDoc(candidate);
  if (!checked.ok) return { ok: false, doc: null, errors: checked.errors, missingRoles };
  return { ok: true, doc: candidate, errors, missingRoles };
}

/*
 * 0299: применимость якоря к узлу по роли. Один чистый резолвер для назначения
 * координатора (0300), вкладки «Якоря» (0302) и значка (0303): по паре
 * «якорь × узел» говорит, применим ли якорь и почему. Читаются только
 * переданные объекты — файлы, структура и consumes узлов не участвуют.
 *
 *   role-mismatch — роли у якоря названы, роли узла среди них нет;
 *   no-roles      — у якоря нет appliesTo.roles (v2 или неполный якорь);
 *   no-node-role  — у узла нет роли: якорь не применяется ни к кому.
 */

/** Стабильные коды причин неприменимости якоря (0299): их показывают UI и гейты. */
export const ANCHOR_APPLICABILITY = Object.freeze({
  ROLE_MISMATCH: 'role-mismatch',
  NO_ROLES: 'no-roles',
  NO_NODE_ROLE: 'no-node-role',
});

/**
 * Роли якоря как список для сравнения: строки без внешних пробелов, без
 * повторов (регистр при сравнении не важен, но в ответе роль — как объявлена).
 * Не строка/пустая — не роль: битой формы здесь не угадываем.
 */
function anchorRoleList(anchor) {
  const appliesTo = isPlainObject(anchor) ? anchor.appliesTo : null;
  const roles = appliesTo && Array.isArray(appliesTo.roles) ? appliesTo.roles : [];
  const list = [];
  for (const item of roles) {
    if (typeof item !== 'string') continue;
    const role = item.trim();
    if (!role) continue;
    if (!list.some((known) => known.toLowerCase() === role.toLowerCase())) list.push(role);
  }
  return list;
}

/**
 * Применим ли якорь к узлу — по роли узла (0299).
 *
 * Применимость называют сами якоря: anchor.appliesTo.roles (0298). Сравнение —
 * после trim и без регистра, поэтому «Ревьюер» и « ревьюер » — одна роль.
 * Узел без роли не получает ни одного якоря: ok остаётся true, а каждый якорь
 * попадает в notApplicable с no-node-role — это не ошибка конфигурации.
 *
 * Битый документ (не список якорей, якорь без id, повторяющийся id) — ok:false
 * и errors: резолвер не бросает исключение и не выдаёт частичный ответ, по
 * которому можно было бы назначить якорь не тому узлу.
 *
 * @param anchorsDoc - разобранный docs/anchors.json (корень {version, anchors}
 *   или сам список якорей).
 * @param node - узел структуры; читается только node.role.
 * @returns {{ ok: boolean, applicable: Array<{id: string, roles: string[]}>,
 *   notApplicable: Array<{id: string, reason: string}>, errors?: string[] }}
 *   errors — только при ok:false.
 */
export function nodeAnchorApplicability(anchorsDoc, node) {
  const list = anchorList(anchorsDoc);
  if (!list) {
    return {
      ok: false,
      applicable: [],
      notApplicable: [],
      errors: ['anchors: нет списка якорей — применимость по роли не определить (нужен { version: 2|3, anchors: [...] })'],
    };
  }
  const errors = [];
  const seen = new Set();
  list.forEach((anchor, index) => {
    const at = 'anchors[' + index + ']';
    if (!isPlainObject(anchor)) {
      errors.push(at + ': якорь — не JSON-объект, применимость по роли не определить');
      return;
    }
    const id = text(anchor.id);
    if (!id) {
      errors.push(at + '.id пуст: якорь без id не назвать в applicable/notApplicable');
      return;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      errors.push(at + '.id «' + id + '» повторяется: id якоря уникален — иначе применимость неоднозначна');
      return;
    }
    seen.add(key);
  });
  if (errors.length > 0) return { ok: false, applicable: [], notApplicable: [], errors };

  const nodeRole = text(isPlainObject(node) ? node.role : '');
  const nodeRoleKey = nodeRole.toLowerCase();
  const applicable = [];
  const notApplicable = [];
  for (const anchor of list) {
    const id = text(anchor.id);
    const roles = anchorRoleList(anchor);
    /*
     * Узел без роли — первый вопрос: в этом случае ни один якорь не применим,
     * даже если у якоря роли не названы вовсе (инвариант 3 задания 0299).
     */
    if (!nodeRoleKey) {
      notApplicable.push({ id, reason: ANCHOR_APPLICABILITY.NO_NODE_ROLE });
    } else if (roles.length === 0) {
      notApplicable.push({ id, reason: ANCHOR_APPLICABILITY.NO_ROLES });
    } else if (roles.some((role) => role.toLowerCase() === nodeRoleKey)) {
      applicable.push({ id, roles });
    } else {
      notApplicable.push({ id, reason: ANCHOR_APPLICABILITY.ROLE_MISMATCH });
    }
  }
  return { ok: true, applicable, notApplicable };
}

/*
 * 0302: строки вкладки «Якоря» окна узла.
 *
 * Вкладка показывает человеку документ якорей глазами одного узла: для каждого
 * якоря — claim, статус, применимость по роли и выбран ли он входом узла.
 * Применимость НЕ пересчитывается здесь: её называет резолвер 0299
 * (nodeAnchorApplicability), чтобы вкладка, назначение координатора (0300) и
 * пересинхронизация (0301) отвечали одинаково. selected читается из consumes
 * узла: это записанное решение, а не догадка по роли.
 *
 * Нет документа или список якорей пуст — rows: []; пустой список якорей —
 * законное состояние проекта, а не ошибка. Битый документ (якорь без id,
 * повтор id) — fail-closed: rows: [] и errors, потому что частичный ответ
 * позволил бы включить якорь не тому узлу.
 *
 * @param anchorsDoc - разобранный docs/anchors.json (корень или список якорей).
 * @param node - узел структуры; читается только role.
 * @param consumes - объявленный вход узла: id-строки или { id, stage, scope }.
 * @param source - источник привязки (координатор, пользователь, пусто).
 * @returns {{ rows: Array<{id: string, claim: string, status: string,
 *   applicable: boolean, reason: string, selected: boolean}>,
 *   source: string, errors?: string[] }} reason — код неприменимости (0299)
 *   или пустая строка; errors — только при битом документе.
 */
export function anchorTabRows(anchorsDoc, node, consumes, source) {
  const declaredSource = text(source);
  const selectedIds = [];
  for (const item of Array.isArray(consumes) ? consumes : []) {
    const id = typeof item === 'string' ? text(item) : text(isPlainObject(item) ? item.id : '');
    if (id && !selectedIds.includes(id.toLowerCase())) selectedIds.push(id.toLowerCase());
  }
  const list = anchorList(anchorsDoc);
  /* Документа нет или список якорей пуст: включать нечего, это не отказ. */
  if (!list) return { rows: [], source: declaredSource };
  const resolved = nodeAnchorApplicability(anchorsDoc, node);
  if (!resolved.ok) return { rows: [], source: declaredSource, errors: resolved.errors };
  const applicable = new Set(resolved.applicable.map((item) => item.id.toLowerCase()));
  const reasons = new Map(resolved.notApplicable.map((item) => [item.id.toLowerCase(), item.reason]));
  const rows = [];
  for (const anchor of list) {
    if (!isPlainObject(anchor)) continue;
    const id = text(anchor.id);
    if (!id) continue;
    const key = id.toLowerCase();
    const isApplicable = applicable.has(key);
    rows.push({
      id,
      claim: text(anchor.claim),
      status: text(anchor.status),
      applicable: isApplicable,
      reason: isApplicable ? '' : (reasons.get(key) || ''),
      selected: selectedIds.includes(key),
    });
  }
  return { rows, source: declaredSource };
}

/*
 * 0300: первичное назначение якорей узлу координатором.
 *
 * Назначение — не перезапись: ручной выбор пользователя липкий. Если у узла
 * anchors.source === 'user', координатор не трогает привязку (skipped: true) и
 * возвращает consumes/source ровно как у узла. Иначе вход узла — применимые по
 * роли якоря документа (0299): consumes — их id, source — 'coordinator'.
 *
 * Пустой или отсутствующий документ якорей дают пустой consumes и source
 * 'coordinator': запись узла не должна падать из-за того, что назначать пока
 * нечего (инвариант 4). Id в consumes берутся только из документа якорей —
 * пустых и выдуманных там нет.
 *
 * assignable отвечает на другой вопрос: даёт ли сам документ основу для
 * назначения. true — роли в документе объявлены (0298) или список якорей пуст
 * (инвариант 4: назначать нечего, пишем пусто). false — ручной выбор
 * пользователя не трогаем, документа нет, он не разобран или ролей в нём нет
 * вовсе. Отсутствие файла вызывающий отличает по читателю: инвариант 4 велит
 * писать пусто, а существующий, но неразобранный документ стереть привязку не
 * даёт (R2 ревью 0300: молчаливая потеря consumes хуже пропущенного
 * назначения; так же остаётся живым контракт 0192 с манифестом без
 * appliesTo.roles).
 *
 * @param anchorsDoc - разобранный docs/anchors.json (корень или список якорей).
 * @param node - узел структуры; читаются role и anchors.source, остальное не
 *   меняется.
 * @returns {{ applies: Array<{id: string}>, consumes: string[],
 *   source: 'coordinator'|'user', skipped: boolean, assignable: boolean }}
 *   skipped — привязка пользователя сохранена и назначение не применялось;
 *   assignable — назначение можно записать (false при skipped).
 */
export function assignAnchorsForNode(anchorsDoc, node) {
  const declared = isPlainObject(node) && isPlainObject(node.anchors) ? node.anchors : null;
  const source = text(declared && declared.source).toLowerCase();
  if (source === 'user') {
    return {
      applies: [],
      consumes: nodeAnchorRefs(node, 'consumes'),
      source: 'user',
      skipped: true,
      assignable: false,
    };
  }
  const resolved = nodeAnchorApplicability(anchorsDoc, node);
  const applicable = resolved.ok ? resolved.applicable : [];
  const applies = applicable.map((item) => ({ id: item.id }));
  /*
   * Роли документа: применимый якорь или неприменимость по причине, отличной
   * от no-roles (у узла нет роли / роль не совпала). Если все якоря документа
   * без ролей — это манифест 0192 до 0298: назначать по нему нечего.
   */
  const roleAware = resolved.ok && (applicable.length > 0
    || resolved.notApplicable.some((item) => item.reason !== ANCHOR_APPLICABILITY.NO_ROLES));
  const list = anchorList(anchorsDoc);
  return {
    applies,
    consumes: applies.map((item) => item.id),
    source: 'coordinator',
    skipped: false,
    assignable: resolved.ok && (roleAware || (Array.isArray(list) && list.length === 0)),
  };
}
/*
 * 0301: пересинхронизация якорей при добавлении/удалении якоря.
 *
 * Концепция, п. 7: когда человек добавил или удалил якорь, структура проходит
 * по всем агентским узлам, проверяет применимость по роли (0299) и приводит
 * ссылки к тому, что действительно применимо. Это НЕ назначение 0300 (оно
 * срабатывает при записи узла): пересинхронизация — проход по уже записанной
 * структуре после правки документа якорей.
 *
 * Границы, которые держит функция:
 *   - ручной выбор пользователя неприкосновенен: anchors.source === 'user'
 *     узел не меняется и попадает в skipped;
 *   - папки обмена — не агенты: узел с box/participants/orchestrator (или
 *     legacy-ролью «обмен») не трогается, изменения касаются только nodes;
 *   - меняется ровно consumes; produces и прочие поля привязки сохраняются;
 *   - изменения только при фактической разнице: первый проход на новом входе
 *     даёт changes, повторный на том же — changes: []; поэтому вызов можно
 *     делать после каждой записи якорей и структура не «дрожит»;
 *   - роль без применимых якорей даёт consumes: [] (ссылки снимаются), а не
 *     «оставить как было»: удалённый якорь обязан уйти из всех узлов;
 *   - битый или безролевой документ — fail-closed как в 0300: ok:false, ничего
 *     не меняется, граф возвращается байт в байт (молчаливая потеря consumes
 *     хуже пропущенной пересинхронизации).
 *
 * Чистая функция: входной граф не мутируется, новый граф возвращается полем
 * graph; запись файла структуры — забота вызывающего (lib/api.js пишет только
 * непустые changes, существующим атомарным путём).
 */

/** Причины пропуска узла при пересинхронизации (0301): стабильные коды. */
export const ANCHOR_RESYNC_SKIP = Object.freeze({
  USER: 'user',
  FOLDER: 'folder',
  NO_ID: 'no-id',
});

/**
 * Узел с полями папки обмена — не агент (0301): папка семантической нагрузки
 * не несёт, её якоря не назначаются и не снимаются.
 *
 * Тот же признак, каким buildGraph отличает папку от узла в legacy-структуре:
 * kind: "folder" или поля box/participants/exchange/orchestrator/threads, плюс
 * роль «обмен» у старых структур. Нормальный граф папки держит отдельным
 * списком folders, поэтому здесь это защита от смешанного входа.
 */
function isFolderLikeNode(node) {
  if (!isPlainObject(node)) return false;
  if (text(node.kind).toLowerCase() === 'folder') return true;
  if (['box', 'participants', 'exchange', 'orchestrator', 'threads'].some((field) => node[field] !== undefined)) {
    return true;
  }
  return /обмен/iu.test(text(node.role));
}

/**
 * Привязка узла после пересинхронизации: consumes — применимые якоря.
 *
 * Объявленные ссылки, которые остаются применимыми, сохраняются КАК ОБЪЯВЛЕНЫ
 * (строка или { id, stage, scope }): stage — смысл ссылки, а не украшение, и
 * снимать его при добавлении соседнего якоря было бы молчаливой потерей.
 * Новые якоря дописываются id-строкой, неприменимые — уходят. source
 * координатора пишется только если у узла источник ещё не назван; 'user' сюда
 * не доходит (такие узлы в skipped).
 */
function resyncedConsumes(declared, applicableIds) {
  const anchors = isPlainObject(declared) ? { ...declared } : {};
  const declaredList = Array.isArray(anchors.consumes) ? anchors.consumes : [];
  const consumes = [];
  const kept = [];
  for (const ref of declaredList) {
    const id = typeof ref === 'string' ? text(ref) : text(isPlainObject(ref) ? ref.id : '');
    if (!id || kept.includes(id) || !applicableIds.includes(id)) continue;
    consumes.push(ref);
    kept.push(id);
  }
  for (const id of applicableIds) {
    if (kept.includes(id)) continue;
    consumes.push(id);
    kept.push(id);
  }
  anchors.consumes = consumes;
  if (!text(anchors.source)) anchors.source = 'coordinator';
  return anchors;
}

/**
 * Пересинхронизировать ссылки узлов на якоря после правки документа (0301).
 *
 * Для каждого агентского узла графа, у которого anchors.source !== 'user',
 * consumes приводится к якорям, применимым к роли узла (nodeAnchorApplicability
 * 0299). Ручные узлы не меняются и названы в skipped. Папки и рёбра не
 * трогаются: folders/edges возвращаются как были.
 *
 * Изменение фиксируется только при фактической разнице added/removed, поэтому
 * повторный вызов на результате первого даёт changes: []. Broken- и
 * безролевой (v2 без appliesTo.roles) документ — ok:false и graph без
 * изменений: fail-closed, как назначение 0300.
 *
 * @param graph - граф структуры { nodes: [...], edges?, folders? }; читаются
 *   только nodes (id, role, anchors).
 * @param anchorsDoc - разобранный docs/anchors.json (корень или список якорей).
 * @returns {{ ok: boolean, changes: Array<{nodeId: string, added: string[],
 *   removed: string[]}>, skipped: Array<{nodeId: string, reason: string}>,
 *   graph: object, errors?: string[] }}
 *   graph — новый граф с приведёнными consumes; при ok:false — исходный.
 */
export function resyncAnchorRefs(graph, anchorsDoc) {
  const failed = (errors) => ({ ok: false, changes: [], skipped: [], graph, errors });
  const nodes = isPlainObject(graph) && Array.isArray(graph.nodes) ? graph.nodes : null;
  if (!nodes) {
    return failed(['graph: нужен объект { nodes: [...] } — пересинхронизировать нечего']);
  }
  const list = anchorList(anchorsDoc);
  if (!list) {
    return failed(['anchors: нет списка якорей — применимость по роли не определить (fail-closed)']);
  }
  /*
   * Документ проверяется целиком до первого узла: якорь без id или повтор id —
   * это не «пропустить и продолжить», а причина ничего не менять (0299/0300).
   */
  const checked = nodeAnchorApplicability(anchorsDoc, { id: 'resync', role: '' });
  if (!checked.ok) return failed(checked.errors);
  /*
   * Безролевой документ (v2 манифест 0192) ролей не объявляет — приводить
   * consumes не к чему; пустой список якорей ролей не требует: удалить все
   * ссылки — законный результат.
   */
  if (list.length > 0 && !list.some((anchor) => anchorRoleList(anchor).length > 0)) {
    return failed(['anchors: роли якорей (appliesTo.roles) не объявлены — '
      + 'пересинхронизация по роли не вычислима (fail-closed, как в 0300)']);
  }

  const changes = [];
  const skipped = [];
  const next = nodes.map((node) => {
    const id = isPlainObject(node) ? text(node.id) : '';
    if (!id) {
      skipped.push({ nodeId: '', reason: ANCHOR_RESYNC_SKIP.NO_ID });
      return node;
    }
    if (isFolderLikeNode(node)) {
      skipped.push({ nodeId: id, reason: ANCHOR_RESYNC_SKIP.FOLDER });
      return node;
    }
    const declared = isPlainObject(node.anchors) ? node.anchors : null;
    if (declared && text(declared.source).toLowerCase() === 'user') {
      skipped.push({ nodeId: id, reason: ANCHOR_RESYNC_SKIP.USER });
      return node;
    }
    const resolved = nodeAnchorApplicability(anchorsDoc, node);
    const applicable = resolved.ok ? resolved.applicable.map((item) => item.id) : [];
    const current = nodeAnchorRefs(node, 'consumes');
    const added = applicable.filter((ref) => !current.includes(ref));
    const removed = current.filter((ref) => !applicable.includes(ref));
    if (added.length === 0 && removed.length === 0) return node;
    changes.push({ nodeId: id, added, removed });
    return { ...node, anchors: resyncedConsumes(declared, applicable) };
  });
  return { ok: true, changes, skipped, graph: { ...graph, nodes: next } };
}

/*
 * 0303: значок якорей у координатора — чистая модель трёх состояний.
 *
 * Значок не пересказывает документ и не решает за координатора: он называет
 * факт (норма / требует внимания / ошибка) и причины, по которым цвет именно
 * такой. Красный важнее оранжевого: битая ссылка или неподписанный документ —
 * не «замечание», а состояние, в котором якоря не действуют.
 *
 * Вход целиком передан вызывающим (граф, разобранный документ, находки чтения,
 * признак подписи): файлы здесь не читаются. Логика применимости не
 * переписывается — её называет резолвер 0299, чтобы значок, вкладка «Якоря» и
 * пересинхронизация отвечали одинаково.
 */

/** Стабильные состояния значка (0303): их показывают панель и проверки. */
export const ANCHOR_BADGE = Object.freeze({
  OK: 'ok',
  ATTENTION: 'attention',
  ERROR: 'error',
});

/** Период ревизии по умолчанию — тот же, что у структуры без политики. */
export const ANCHOR_BADGE_DEFAULT_MAX_AGE_DAYS = 30;

/** Период ревизии из graph.anchorsPolicy: целое 1..3650, иначе 30. */
function anchorsMaxAgeDays(graph) {
  const policy = isPlainObject(graph) && isPlainObject(graph.anchorsPolicy) ? graph.anchorsPolicy : null;
  const value = policy ? policy.maxAgeDays : undefined;
  return Number.isInteger(value) && value >= 1 && value <= 3650 ? value : ANCHOR_BADGE_DEFAULT_MAX_AGE_DAYS;
}

/** Строки находок чтения, которым нельзя доверять: пустые строки не считаются. */
function badgeDocErrors(docErrors) {
  const list = [];
  for (const item of Array.isArray(docErrors) ? docErrors : []) {
    const message = typeof item === 'string'
      ? item.trim()
      : (isPlainObject(item) ? text(item.message) : '');
    if (message) list.push(message);
  }
  return list;
}

/**
 * Состояние значков якорей воркспейса (0303).
 *
 * @param input - { graph, anchorsDoc, docErrors = [], approved = true, freshness }:
 *   graph — собранный граф (узлы с anchors.consumes, папки, anchorsPolicy);
 *   anchorsDoc — разобранный docs/anchors.json или null;
 *   docErrors — строки «документу нельзя доверять» (валидация, JSON, чтение);
 *   approved — подпись владельца действительна для текущего текста;
 *   freshness — ответ anchorFreshness (0306): строки получают действующий статус
 *   и пометку просрочки, а просрочка становится причиной внимания. Не передан —
 *   ответ прежний (0303/0304), новых полей у строк нет.
 * @returns {{ state: string, maxAgeDays: number,
 *   counts: { anchors: number, assigned: number, unassigned: number,
 *     inapplicable: number, brokenRefs: number },
 *   errors: Array<{code: string, message: string}>,
 *   attention: Array<{code: string, message: string}>,
 *   anchors: Array<{id: string, claim: string, status: string, roles: string[],
 *     assignedTo: string[], unassigned: boolean, inapplicableAt: string[]}> }}
 *   state — ok | attention | error; errors/attention — причины цвета.
 */
export function anchorsBadge(input) {
  const source = isPlainObject(input) ? input : {};
  const graph = isPlainObject(source.graph) ? source.graph : {};
  /* approve по умолчанию true (инвариант 1): поле не задано — подпись не оспаривается. */
  const approved = source.approved === undefined ? true : source.approved === true;
  const maxAgeDays = anchorsMaxAgeDays(graph);
  const errors = [];
  const attention = [];
  const counts = { anchors: 0, assigned: 0, unassigned: 0, inapplicable: 0, brokenRefs: 0 };
  const empty = { state: ANCHOR_BADGE.OK, maxAgeDays, counts, errors, attention, anchors: [] };
  const docErrors = badgeDocErrors(source.docErrors);
  /*
   * Битый документ не даёт частичных выводов: применимость не вычисляется —
   * иначе значок показал бы «назначено» по тексту, которому нельзя верить.
   *
   * 0324: но и «якорей нет» — неправда, когда файл существует и якоря в нём
   * перечислены. Поэтому counts.anchors называет фактическое число объявленных
   * якорей (уникальные непустые id, как в строках значка) даже у документа,
   * которому нельзя доверять: состояние остаётся error, назначение — 0, потому
   * что применимость по недоверенному тексту не считается.
   */
  if (docErrors.length > 0) {
    const declaredKeys = new Set();
    for (const anchor of anchorList(source.anchorsDoc) || []) {
      if (!isPlainObject(anchor)) continue;
      const id = text(anchor.id);
      if (!id) continue;
      declaredKeys.add(id.toLowerCase());
    }
    return {
      ...empty,
      counts: { ...counts, anchors: declaredKeys.size },
      state: ANCHOR_BADGE.ERROR,
      errors: docErrors.map((message) => ({ code: 'doc', message })),
    };
  }
  /*
   * Пустой документ — норма, но НЕ повод пропустить узлы: узел, объявивший
   * consumes при отсутствии файла, — это битая ссылка (инвариант 0303), а не
   * пустое состояние. Поэтому пустой список только наполняет rows нулём, а
   * обход узлов выполняется всегда.
   */
  const list = anchorList(source.anchorsDoc) || [];

  const byKey = new Map();
  const rows = [];
  for (const anchor of list) {
    if (!isPlainObject(anchor)) continue;
    const id = text(anchor.id);
    if (!id) continue;
    const key = id.toLowerCase();
    /* Повтор id уже назван валидацией (docErrors); здесь второй строки не будет. */
    if (byKey.has(key)) continue;
    const row = {
      id,
      claim: text(anchor.claim),
      status: text(anchor.status),
      roles: anchorRoleList(anchor),
      assignedTo: [],
      unassigned: false,
      inapplicableAt: [],
    };
    byKey.set(key, row);
    rows.push(row);
  }
  /*
   * 0306: срок ревизии. Строка якоря получает ДЕЙСТВУЮЩИЙ статус, а просрочка
   * называется причиной внимания: «требует обновления» — не ошибка и запуск не
   * блокирует. counts не меняется: просрочка не новая категория назначения,
   * совместимость 0303/0304 держится. freshness не передан — ответ прежний,
   * новых полей у строк нет.
   */
  const freshness = isPlainObject(source.freshness) ? source.freshness : null;
  if (freshness) {
    const freshnessRows = new Map();
    for (const item of Array.isArray(freshness.anchors) ? freshness.anchors : []) {
      if (!isPlainObject(item)) continue;
      const id = text(item.id);
      if (!id) continue;
      freshnessRows.set(id.toLowerCase(), item);
    }
    const ageDays = Number.isFinite(freshness.ageDays) ? freshness.ageDays : null;
    const term = Number.isInteger(freshness.maxAgeDays) ? freshness.maxAgeDays : maxAgeDays;
    for (const row of rows) {
      const item = freshnessRows.get(row.id.toLowerCase());
      const effective = text(item && item.effectiveStatus);
      row.effectiveStatus = effective || row.status;
      row.overdue = Boolean(item && item.overdue === true);
      if (!row.overdue) continue;
      attention.push({
        code: 'overdue',
        message: 'якорь «' + row.id + '» просрочен: не обновлялся '
          + (ageDays === null ? 'дольше срока ревизии' : ageDays + ' дн.')
          + ' при сроке ревизии ' + term + ' дн., требует обновления (needsUpdate)',
      });
    }
  }
  /* Подпись требуется только документу, в котором есть хотя бы один якорь. */
  if (rows.length > 0 && !approved) {
    errors.push({
      code: 'not-approved',
      message: 'якоря не утверждены: подпись владельца отсутствует или недействительна для текущего текста docs/anchors.json',
    });
  }

  /*
   * Папки обмена — не агенты (0301): их consumes не назначает якорь, не даёт
   * неприменимости и не считается битой ссылкой. Нормальный граф держит папки
   * отдельным списком, поэтому здесь защита от смешанного входа.
   */
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter((node) => isPlainObject(node) && !isFolderLikeNode(node));
  for (const node of nodes) {
    const nodeId = text(node.id);
    if (!nodeId) continue;
    const declared = nodeAnchorRefs(node, 'consumes');
    if (declared.length === 0) continue;
    const resolved = nodeAnchorApplicability(source.anchorsDoc, node);
    const notApplicable = new Map();
    if (resolved.ok) {
      for (const item of resolved.notApplicable) notApplicable.set(item.id.toLowerCase(), item.reason);
    }
    for (const ref of declared) {
      const key = ref.toLowerCase();
      const row = byKey.get(key);
      if (!row) {
        counts.brokenRefs += 1;
        errors.push({
          code: 'broken-ref',
          message: 'узел «' + nodeId + '» объявил в consumes якорь «' + ref + '», которого нет в документе',
        });
        continue;
      }
      if (!row.assignedTo.includes(nodeId)) row.assignedTo.push(nodeId);
      if (!resolved.ok) continue;
      const reason = notApplicable.get(key);
      if (reason) {
        if (!row.inapplicableAt.includes(nodeId)) row.inapplicableAt.push(nodeId);
        attention.push({
          code: 'inapplicable',
          message: 'узел «' + nodeId + '» выбрал якорь «' + row.id + '», но якорь неприменим: ' + reason,
        });
      }
    }
  }

  /*
   * Назначение считается состоявшимся, только если якорь применим хотя бы к
   * одному выбравшему его узлу: выбранный, но неприменимый якорь не работает, и
   * counts.unassigned честно называет такую дыру (она же — причина inapplicable).
   */
  let applicableAssignments = 0;
  for (const row of rows) {
    const applicableTo = row.assignedTo.filter((nodeId) => !row.inapplicableAt.includes(nodeId));
    if (applicableTo.length > 0) applicableAssignments += 1;
    if (row.assignedTo.length === 0) {
      row.unassigned = true;
      attention.push({
        code: 'unassigned',
        message: 'якорь «' + row.id + '» не входит в consumes ни одного агентского узла',
      });
    }
    if (row.inapplicableAt.length > 0) counts.inapplicable += 1;
  }
  counts.anchors = rows.length;
  counts.assigned = applicableAssignments;
  counts.unassigned = rows.length - applicableAssignments;

  const state = errors.length > 0
    ? ANCHOR_BADGE.ERROR
    : (attention.length > 0 ? ANCHOR_BADGE.ATTENTION : ANCHOR_BADGE.OK);
  return { state, maxAgeDays, counts, errors, attention, anchors: rows };
}

/*
 * 0306: движок срока якорей — maxAgeDays, auto -> needsUpdate, аудит переходов.
 *
 * Единственная подписанная отметка ревизии — approval.at: подпись покрывает
 * hash+by+at, а docs/anchors.json утверждается дословными байтами. Поэтому срок
 * считается от approval.at до момента проверки, а подписанный манифест движок
 * НЕ переписывает: needsUpdate — действующий (runtime) статус, а не новое
 * значение поля status. Набор ANCHOR_STATUSES не расширяется: манифест
 * по-прежнему принимает только прежние значения.
 *
 * «Просрочен» — внимание, а не ошибка: гейт запуска им не блокируется.
 */

/** Действующий (runtime) статус просроченного якоря (0306): не значение манифеста. */
export const ANCHOR_NEEDS_UPDATE = 'needsUpdate';

/** Журнал переходов — новый файл рядом с манифестом, в подписи не участвует. */
export const ANCHORS_AUDIT_REL = 'docs/anchors.audit.jsonl';

/** Период ревизии: целое 1..3650, иначе 30 — то же правило, что у значка. */
function freshnessMaxAgeDays(value) {
  return Number.isInteger(value) && value >= 1 && value <= 3650
    ? value
    : ANCHOR_BADGE_DEFAULT_MAX_AGE_DAYS;
}

/** Момент проверки: Date, ISO-строка, иначе текущее время (битое не судим). */
function freshnessNow(now) {
  if (now instanceof Date) {
    const time = now.getTime();
    if (Number.isFinite(time)) return time;
  } else if (typeof now === 'string' && now.trim()) {
    const time = Date.parse(now);
    if (Number.isFinite(time)) return time;
  }
  return Date.now();
}

/**
 * Свежесть якорей: возраст утверждения и действующий статус каждой строки (0306).
 *
 * Чистая функция: вход не меняется, файлы не читаются и не пишутся. Срок
 * считается от approval.at — единственной подписанной отметки ревизии; возраст
 * — целые сутки (floor), будущая подпись даёт возраст 0.
 *
 * Просрочен только статус auto (без учёта регистра) и только при СТРОГОМ
 * превышении срока: ageDays === maxAgeDays — ещё не просрочен. Прочие статусы
 * (semi, inWork, retired, active) не просрочиваются: срок ревизии относится к
 * автопринятым якорям, остальные уже требуют человеческого решения.
 *
 * Пустой/отсутствующий список якорей — норма, подпись для неё не нужна. Непустой
 * список без действительной подписи или с неразбираемым approval.at — ok:false с
 * названной причиной: судить о сроке нельзя, и частичного ответа здесь нет.
 *
 * @param input - { anchorsDoc, approvedAt, approvalOk, maxAgeDays, now }:
 *   anchorsDoc — разобранный docs/anchors.json или null;
 *   approvedAt — строка approval.at; approvalOk — подпись и хеш действительны;
 *   maxAgeDays — из graph.anchorsPolicy (нет/некорректно — 30);
 *   now — Date или ISO-строка, по умолчанию текущее время.
 * @returns {{ ok: boolean, maxAgeDays: number, approvedAt: string,
 *   ageDays: number|null, anchors: Array<{id: string, status: string,
 *   effectiveStatus: string, overdue: boolean}>, overdue: string[],
 *   error?: string }} порядок anchors/overdue — порядок документа.
 */
export function anchorFreshness(input) {
  const source = isPlainObject(input) ? input : {};
  const maxAgeDays = freshnessMaxAgeDays(source.maxAgeDays);
  const approvedAt = typeof source.approvedAt === 'string' ? source.approvedAt.trim() : '';
  const anchors = [];
  for (const anchor of anchorList(source.anchorsDoc) || []) {
    if (!isPlainObject(anchor)) continue;
    const id = text(anchor.id);
    if (!id) continue;
    const status = text(anchor.status);
    anchors.push({ id, status, effectiveStatus: status, overdue: false });
  }
  const base = { ok: true, maxAgeDays, approvedAt, ageDays: null, anchors, overdue: [] };
  /* Пустой документ — законное состояние: подпись и дата для него не требуются. */
  if (anchors.length === 0) return base;
  if (source.approvalOk !== true) {
    return {
      ...base,
      ok: false,
      error: 'якоря не утверждены: подпись владельца (docs/anchors.approval.json) отсутствует '
        + 'или недействительна для текущего текста — срок ревизии не судится',
    };
  }
  const approvedTime = approvedAt ? Date.parse(approvedAt) : NaN;
  if (!Number.isFinite(approvedTime)) {
    return {
      ...base,
      ok: false,
      error: 'approval.at «' + approvedAt + '» не разбирается как дата: подпись не называет '
        + 'времени утверждения — срок ревизии не судится (at обязателен)',
    };
  }
  const ageDays = Math.max(0, Math.floor((freshnessNow(source.now) - approvedTime) / 86400000));
  const overdue = [];
  for (const row of anchors) {
    /* Строгая граница: ровно maxAgeDays — ещё не просрочен. */
    if (row.status.toLowerCase() !== 'auto' || !(ageDays > maxAgeDays)) continue;
    row.effectiveStatus = ANCHOR_NEEDS_UPDATE;
    row.overdue = true;
    overdue.push(row.id);
  }
  return { ok: true, maxAgeDays, approvedAt, ageDays, anchors, overdue };
}

/** Ключ перехода для дедупликации: anchor + from + to + approvalHash. */
function anchorTransitionKey(entry) {
  return [text(entry.anchor), text(entry.from), text(entry.to), text(entry.approvalHash)].join('\u0000');
}

/**
 * Записать переходы auto -> needsUpdate в docs/anchors.audit.jsonl (0306).
 *
 * Пишутся только просрочки действительного ответа freshness (freshness.ok &&
 * freshness.overdue); иначе файл не создаётся вовсе. Повторное чтение с тем же
 * approvalHash новых строк не добавляет: ключ — anchor + from + to +
 * approvalHash, поэтому новый hash (новая подпись) — новый переход, а тот же —
 * уже записанный. Существующие строки не переписываются: неразбираемая строка
 * остаётся на месте и не мешает дописыванию.
 *
 * Аудит — не подпись: docs/anchors.json и docs/anchors.approval.json не
 * меняются. Сбой записи (нет прав, docs — файл) не выходит исключением:
 * { ok:false, written:[], error }, потому что журнал не должен ломать чтение.
 *
 * @param input - { root, freshness, approvalHash, now }:
 *   root — корень проекта (журнал: <root>/docs/anchors.audit.jsonl);
 *   freshness — ответ anchorFreshness; approvalHash — sha256 docs/anchors.json;
 *   now — Date или ISO-строка, по умолчанию текущее время.
 * @returns {{ ok: boolean, file: string, written: string[], error?: string }}
 *   file — путь журнала относительно корня; written — id записанных переходов.
 */
export function recordAnchorTransitions(input) {
  const source = isPlainObject(input) ? input : {};
  const rel = ANCHORS_AUDIT_REL;
  const root = typeof source.root === 'string' ? source.root.trim() : '';
  if (!root) {
    return { ok: false, file: rel, written: [], error: 'root не назван: журнал переходов некуда писать' };
  }
  const freshness = isPlainObject(source.freshness) ? source.freshness : {};
  const quiet = { ok: true, file: rel, written: [] };
  if (freshness.ok !== true) return quiet;
  const overdue = [];
  for (const id of Array.isArray(freshness.overdue) ? freshness.overdue : []) {
    const value = text(id);
    if (value && !overdue.includes(value)) overdue.push(value);
  }
  if (overdue.length === 0) return quiet;
  const rows = new Map();
  for (const row of Array.isArray(freshness.anchors) ? freshness.anchors : []) {
    if (!isPlainObject(row)) continue;
    const id = text(row.id);
    if (id && !rows.has(id)) rows.set(id, row);
  }
  const approvalHash = text(source.approvalHash);
  const approvalAt = text(freshness.approvedAt);
  const ageDays = Number.isFinite(freshness.ageDays) ? freshness.ageDays : null;
  const maxAgeDays = Number.isInteger(freshness.maxAgeDays) ? freshness.maxAgeDays : null;
  const at = new Date(freshnessNow(source.now)).toISOString();
  const file = path.join(root, 'docs', 'anchors.audit.jsonl');
  /* Существующий журнал читается только для дедупликации: строки не меняются. */
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  const keys = new Set();
  for (const line of existing.split(/\r?\n/u)) {
    const value = line.trim();
    if (!value) continue;
    let entry;
    try {
      entry = JSON.parse(value);
    } catch {
      /* Неразбираемая строка не удаляется и дедупликации не мешает. */
      continue;
    }
    if (isPlainObject(entry)) keys.add(anchorTransitionKey(entry));
  }
  const lines = [];
  const written = [];
  for (const id of overdue) {
    const row = rows.get(id) || null;
    const entry = {
      version: 1,
      at,
      event: 'status',
      anchor: id,
      from: text(row && row.status),
      to: ANCHOR_NEEDS_UPDATE,
      approvalHash,
      approvalAt,
      ageDays,
      maxAgeDays,
    };
    const key = anchorTransitionKey(entry);
    if (keys.has(key)) continue;
    keys.add(key);
    lines.push(JSON.stringify(entry));
    written.push(id);
  }
  if (written.length === 0) return quiet;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, prefix + lines.join('\n') + '\n');
  } catch (error) {
    return {
      ok: false,
      file: rel,
      written: [],
      error: 'переходы не записаны в ' + rel + ': ' + errorText(error),
    };
  }
  return { ok: true, file: rel, written };
}

/*
 * 0305: спека якорей входа узла — claim/check по id для блока идентичности.
 *
 * Структура хранит только ссылки (anchors.consumes), а ребёнок обязан получить
 * текст якорей: ему нужно знать, что именно проверять. Источник — уже
 * разобранный docs/anchors.json; функция чистая: файлы не читаются и не
 * пишутся, ни документ, ни узел не меняются.
 *
 * Вход узла — явные consumes (строки или { id, ... }, 0299–0302); пустой
 * consumes у проверяющей роли (0206, defaultConsumes) — все auto-якоря
 * документа в порядке документа, и structure при этом не переписывается.
 *
 * Ответ — либо полный список в порядке входа, либо отказ: id, которого нет в
 * документе, не подменяется пустой строкой и частичный список не выдаётся.
 * Узел или знает свой вход целиком, или запуск не начинается (fail-closed).
 */

/**
 * Спека якорей входа узла: порядок входа, канонический id, trim текста.
 *
 * @param anchorsDoc - разобранный docs/anchors.json (корень { anchors: [...] }
 *   или сам массив; null/undefined — документа нет).
 * @param node - узел структуры; читаются role и anchors.consumes, узел не
 *   меняется.
 * @returns {{ ok: true, anchors: Array<{id: string, claim: string, check: string}> }
 *   | { ok: false, anchors: [], errors: string[] }} id — каноническое написание
 *   из документа (сравнение без учёта регистра), claim/check — trim строк
 *   документа (пустое остаётся пустой строкой). Отказ называет id, для которых
 *   взять claim/check неоткуда.
 */
export function nodeAnchorSpec(anchorsDoc, node) {
  const explicit = consumesOf(node);
  const list = anchorList(anchorsDoc);
  /* Вход узла: явные consumes, иначе default all-auto проверяющей роли (0206). */
  const entry = explicit.length > 0 ? explicit : (list ? defaultConsumes(node, anchorsDoc) : []);
  const ids = [];
  for (const id of entry) {
    if (!ids.some((known) => known.toLowerCase() === id.toLowerCase())) ids.push(id);
  }
  /* Входа нет вовсе — пустая спека законна, документ для неё не нужен. */
  if (ids.length === 0) return { ok: true, anchors: [] };
  const nodeId = text(node && node.id) || '(без id)';
  if (!list) {
    return {
      ok: false,
      anchors: [],
      errors: ['якоря входа узла «' + nodeId + '» (' + ids.join(', ') + ') не разрешены: '
        + 'docs/anchors.json отсутствует или не содержит списка anchors — claim/check взять неоткуда. '
        + 'Частичной спеки нет: узел получил бы вход без проверки (fail-closed)'],
    };
  }
  const byKey = new Map();
  for (const anchor of list) {
    if (!isPlainObject(anchor)) continue;
    const id = text(anchor.id);
    if (!id || byKey.has(id.toLowerCase())) continue;
    byKey.set(id.toLowerCase(), anchor);
  }
  const errors = [];
  const resolved = [];
  for (const id of ids) {
    const anchor = byKey.get(id.toLowerCase());
    if (!anchor) {
      errors.push('якорь «' + id + '» узла «' + nodeId + '» не объявлен в docs/anchors.json: '
        + 'claim/check взять неоткуда, ссылка не подменяется пустой строкой');
      continue;
    }
    resolved.push({ id: text(anchor.id), claim: text(anchor.claim), check: text(anchor.check) });
  }
  if (errors.length > 0) return { ok: false, anchors: [], errors };
  return { ok: true, anchors: resolved };
}
/*
 * 0307: ревизия якорей «обновление» — ожидание подписи, повторная подпись
 * владельца, аудит.
 *
 * Сценарий: человек правит семантику якорей существующим редактором, а
 * сохранение переводит проект в ЯВНОЕ состояние «изменено — нужна повторная
 * подпись владельца». Файл состояния (docs/anchors.revision.json) — ожидание, а
 * не подпись: движок пишет только его и существующий журнал 0306
 * (docs/anchors.audit.jsonl); docs/anchors.json и docs/anchors.approval.json
 * по-прежнему меняет лишь сохранение/подпись владельца. Приватного ключа у
 * движка нет: подпись ставится вне панели, здесь — только её проверка.
 *
 * Пока подписи нет, ревизия не состоялась: якоря не действуют (freshness
 * ok:false), значок показывает прежнее «не утверждено». Когда владелец подписал
 * новый текст (approvalOk и тот же hash), ожидание закрывается, в журнал
 * дописывается одна строка event:'revision', и срок 0306 начинается заново от
 * новой approval.at.
 */

/** Состояние ожидания повторной подписи: рядом с манифестом, в подписи не участвует. */
export const ANCHORS_REVISION_REL = 'docs/anchors.revision.json';

/** Статусы состояния ревизии: none — ожидания нет, awaiting — ждём, signed — подписана. */
const ANCHORS_REVISION_STATUSES = Object.freeze(['none', 'awaiting-signature', 'signed']);

/** Поля якоря, изменение которых — изменение семантики (инвариант 1 задания 0307). */
const ANCHOR_SEMANTIC_FIELDS = Object.freeze([
  'claim', 'check', 'status', 'layer', 'sides', 'enforcedBy', 'scope', 'appliesTo',
]);

/** Строка id/служебного поля для сравнения: внешние пробелы и регистр не различают значение. */
function semanticText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Текст claim/check для сравнения: только trim — регистр текста семантики значим. */
function semanticCaseText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Значение произвольной формы для сравнения: строки — trim, регистр сохраняется. */
function semanticValue(value) {
  if (Array.isArray(value)) return value.map((item) => semanticValue(item));
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[semanticText(key)] = semanticValue(value[key]);
    }
    return result;
  }
  if (typeof value === 'string') return semanticCaseText(value);
  return value === undefined ? null : value;
}

/**
 * appliesTo для сравнения: роли — множество (порядок и регистр не различают),
 * прочие поля — рекурсивно нормализованные.
 */
function semanticAppliesTo(value) {
  if (!isPlainObject(value)) return '';
  const roles = Array.isArray(value.roles)
    ? value.roles.map((role) => semanticText(role)).filter(Boolean).sort()
    : [];
  const rest = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'roles') continue;
    rest[semanticText(key)] = semanticValue(value[key]);
  }
  return JSON.stringify({ roles, rest });
}

/** Поля текста семантики: регистр значим, нормализуются только внешние пробелы. */
const ANCHOR_SEMANTIC_CASE_TEXT = Object.freeze(['claim', 'check']);

/** Семантика одного якоря строкой: поля инварианта 1, нормализованные. */
function anchorSemantics(anchor) {
  const source = isPlainObject(anchor) ? anchor : {};
  const fields = {};
  for (const field of ANCHOR_SEMANTIC_FIELDS) {
    if (field === 'appliesTo') {
      fields[field] = semanticAppliesTo(source[field]);
    } else if (ANCHOR_SEMANTIC_CASE_TEXT.includes(field)) {
      /* claim/check — текст проверки: «НЕЛЬЗЯ» и «нельзя» разный смысл. */
      fields[field] = semanticCaseText(source[field]);
    } else {
      fields[field] = semanticText(source[field]);
    }
  }
  return JSON.stringify(fields);
}

/** Список якорей документа, проиндексированный без учёта регистра id (первый дубль — главный). */
function semanticAnchorIndex(doc) {
  const index = new Map();
  for (const anchor of anchorList(doc) || []) {
    if (!isPlainObject(anchor)) continue;
    const id = text(anchor.id);
    if (!id) continue;
    const key = id.toLowerCase();
    if (!index.has(key)) index.set(key, { id, anchor });
  }
  return index;
}

/**
 * Id якорей, семантика которых изменилась между документами (0307, инвариант 1).
 *
 * Чистая функция: документы только читаются. Изменение семантики — добавление,
 * удаление или отличие любого из полей claim/check/status/layer/sides/
 * enforcedBy/scope/appliesTo. Сравнение: id, status/layer/sides/enforcedBy/
 * scope и роли appliesTo — без учёта регистра (роли — ещё и без порядка);
 * claim/check — после trim, но С учётом регистра: это текст проверки, где
 * «НЕЛЬЗЯ» и «нельзя» — разный смысл. Косметика (порядок якорей, регистр id)
 * разницей не считается: подпись всё равно требуется по хешу текста, а этот
 * список отвечает на вопрос «что именно изменилось по смыслу».
 *
 * Порядок: сначала id предыдущего документа в его порядке (правки и удаления),
 * затем добавленные в порядке нового документа. id правленого якоря — как в
 * предыдущем документе (он и определяет прежний, «канонический» порядок).
 *
 * @param previousDoc - разобранный документ: корень { anchors: [...] }, массив или null.
 * @param nextDoc - то же для нового документа.
 * @returns {string[]} id изменённых якорей; ничего не изменилось — [].
 */
export function anchorsChangedIds(previousDoc, nextDoc) {
  const previous = semanticAnchorIndex(previousDoc);
  const next = semanticAnchorIndex(nextDoc);
  const changed = [];
  const known = new Set();
  const push = (id) => {
    const key = id.toLowerCase();
    if (known.has(key)) return;
    known.add(key);
    changed.push(id);
  };
  for (const [key, entry] of previous) {
    const nextEntry = next.get(key);
    if (!nextEntry || anchorSemantics(entry.anchor) !== anchorSemantics(nextEntry.anchor)) {
      push(entry.id);
    }
  }
  for (const [key, entry] of next) {
    if (!previous.has(key)) push(entry.id);
  }
  return changed;
}

/** Путь состояния ожидания: <root>/docs/anchors.revision.json. */
function revisionFilePath(root) {
  return path.join(root, ...ANCHORS_REVISION_REL.split('/'));
}

/** Момент записи состояний: Date, ISO-строка, иначе текущее время — ISO-строка. */
function revisionNow(now) {
  return new Date(freshnessNow(now)).toISOString();
}

/**
 * Прочитать состояние ожидания повторной подписи (0307).
 *
 * Битый/нечитаемый файл — не исключение: revision:null и error, чтобы панель
 * могла назвать причину, а GET остался ответом. Нет файла — revision:null без
 * ошибки (ожидания нет — обычное состояние).
 *
 * @param root - корень проекта.
 * @returns {{ exists: boolean, file: string, revision: object|null, error?: string }}
 *   file — путь относительно корня; revision — разобранное состояние.
 */
export function readAnchorsRevision(root) {
  const rel = ANCHORS_REVISION_REL;
  const rootPath = text(root);
  if (!rootPath) {
    return { exists: false, file: rel, revision: null, error: 'root не назван: состояние ревизии не прочитать' };
  }
  const file = revisionFilePath(rootPath);
  let exists = false;
  try {
    exists = fs.existsSync(file);
  } catch {
    exists = false;
  }
  if (!exists) return { exists: false, file: rel, revision: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      exists: true,
      file: rel,
      revision: null,
      error: rel + ' не читается: ' + errorText(error),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      exists: true,
      file: rel,
      revision: null,
      error: rel + ' не разбирается как JSON: ' + errorText(error),
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      exists: true,
      file: rel,
      revision: null,
      error: rel + ': корень — не объект состояния { status, oldHash, newHash, changed }',
    };
  }
  const status = text(parsed.status).toLowerCase();
  if (!ANCHORS_REVISION_STATUSES.includes(status)) {
    return {
      exists: true,
      file: rel,
      revision: null,
      error: rel + ': status «' + text(parsed.status) + '» неизвестен — допустимы '
        + ANCHORS_REVISION_STATUSES.join(', '),
    };
  }
  return { exists: true, file: rel, revision: parsed };
}

/** Счётчик временных имён: две записи в одном процессе не должны совпасть. */
let revisionWriteCounter = 0;

/**
 * Записать состояние ожидания атомарно: временный сосед + rename, JSON + LF.
 *
 * Рядом с целью, а не во временной папке: rename в пределах одной папки —
 * атомарная подмена, и читатель видит либо прежнее состояние, либо новое.
 * Проигранная гонка rename на Windows (EPERM/EBUSY) повторяется; на любом
 * сбое временный файл убирается.
 */
function writeRevisionAtomic(rootPath, file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  revisionWriteCounter += 1;
  const temp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid + '-'
    + revisionWriteCounter + '-' + crypto.randomBytes(4).toString('hex'));
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the write error is what matters */ }
    throw error;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return file;
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

/** Список id без дублей (регистр id не различает), порядок сохраняется. */
function revisionChangedList(values) {
  const list = [];
  const known = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = text(value);
    if (!id) continue;
    const key = id.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    list.push(id);
  }
  return list;
}

/**
 * Начать/обновить ожидание повторной подписи после сохранения якорей (0307).
 *
 * Ревизия начинается только когда прежняя подпись была (previousApprovalPresent):
 * «изменено после подписи» имеет смысл лишь для утверждённого текста. Хеши
 * сравниваются с прочитанными ДО записи: так откат к утверждённому тексту
 * (nextHash === oldHash ожидания) снимает ожидание, а сохранение без изменений
 * (previousHash === nextHash) состояние не трогает.
 *
 * При обновлении oldHash — хеш утверждённого текста, с которого началось
 * ожидание, startedAt не переписывается, changed объединяется с прежним
 * списком и diff-ом семантики, updatedAt — момент записи.
 *
 * @param root - корень проекта.
 * @param options - { previousDoc, previousHash, nextDoc, nextHash,
 *   previousApprovalPresent, now }.
 * @returns {{ ok: boolean, status: 'none'|'awaiting-signature',
 *   pending: boolean, revision?: object, changed?: string[],
 *   reverted?: boolean, error?: string }} исключений нет: сбой записи — ok:false
 *   и error.
 */
export function startAnchorsRevision(root, options) {
  const rel = ANCHORS_REVISION_REL;
  const source = isPlainObject(options) ? options : {};
  const rootPath = text(root);
  if (!rootPath) {
    return { ok: false, status: 'none', pending: false, error: 'root не назван: состояние ожидания некуда писать' };
  }
  const at = revisionNow(source.now);
  const read = readAnchorsRevision(rootPath);
  const existing = read.revision && text(read.revision.status).toLowerCase() === 'awaiting-signature'
    ? read.revision
    : null;
  const previousHash = text(source.previousHash);
  const nextHash = text(source.nextHash);
  /* Без прежней подписи ревизия не начинается: файл ожидания не создаётся и не меняется. */
  if (source.previousApprovalPresent !== true) {
    return { ok: true, status: 'none', pending: false };
  }
  const file = revisionFilePath(rootPath);
  /*
   * Откат к утверждённому тексту: новый текст — это текст, который ждал
   * подписи (oldHash ожидания). Ожидание снимается, потому что подписывать
   * нечего: действует прежняя подпись, а якоря вернулись к ней.
   */
  if (existing && text(existing.oldHash) === nextHash && nextHash) {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      return {
        ok: false,
        status: 'awaiting-signature',
        pending: true,
        revision: existing,
        error: 'ожидание ревизии не снято: ' + rel + ' не удаляется: ' + errorText(error),
      };
    }
    return { ok: true, status: 'none', pending: false, reverted: true };
  }
  /* Текст не изменился — состояние не меняется. */
  if (previousHash && nextHash && previousHash === nextHash) {
    if (!existing) return { ok: true, status: 'none', pending: false };
    return {
      ok: true,
      status: 'awaiting-signature',
      pending: true,
      revision: existing,
      changed: revisionChangedList(existing.changed),
    };
  }
  if (!previousHash || !nextHash) {
    return {
      ok: false,
      status: existing ? 'awaiting-signature' : 'none',
      pending: Boolean(existing),
      ...(existing ? { revision: existing } : {}),
      error: 'не названы прежний и новый хеши якорей: ревизия без них не отличает изменение от сохранения',
    };
  }
  /*
   * Хеш утверждённого текста — из уже начатого ожидания: второй сохранение не
   * должно объявлять подписью текст, который подписью никогда не был.
   */
  const oldHash = existing && text(existing.oldHash) ? text(existing.oldHash) : previousHash;
  const changed = revisionChangedList([
    ...(existing ? revisionChangedList(existing.changed) : []),
    ...anchorsChangedIds(source.previousDoc, source.nextDoc),
  ]);
  const revision = {
    version: 1,
    status: 'awaiting-signature',
    oldHash,
    newHash: nextHash,
    changed,
    startedAt: existing && text(existing.startedAt) ? text(existing.startedAt) : at,
    updatedAt: at,
  };
  try {
    writeRevisionAtomic(rootPath, file, revision);
  } catch (error) {
    return {
      ok: false,
      status: existing ? 'awaiting-signature' : 'none',
      pending: Boolean(existing),
      ...(existing ? { revision: existing, changed: revisionChangedList(existing.changed) } : {}),
      error: 'ожидание ревизии не записано в ' + rel + ': ' + errorText(error),
    };
  }
  return { ok: true, status: 'awaiting-signature', pending: true, revision, changed };
}

/** Ключ строки аудита ревизии для дедупликации: event + fromHash + toHash. */
function revisionAuditKey(entry) {
  return [text(entry.event), text(entry.fromHash), text(entry.toHash)].join('\u0000');
}

/**
 * Дописать строку event:'revision' в существующий журнал 0306.
 *
 * Дедуп по event+fromHash+toHash: повторное чтение того же факта новых строк не
 * добавляет. Неразбираемые строки остаются на месте и дедупликации не мешают.
 * Сбой журнала не выходит исключением: { ok:false, written:0, error } — подпись
 * от этого не отменяется.
 */
function recordRevisionAudit(rootPath, input) {
  const rel = ANCHORS_AUDIT_REL;
  const file = path.join(rootPath, 'docs', 'anchors.audit.jsonl');
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  const keys = new Set();
  for (const line of existing.split(/\r?\n/u)) {
    const value = line.trim();
    if (!value) continue;
    let entry;
    try {
      entry = JSON.parse(value);
    } catch {
      continue;
    }
    if (isPlainObject(entry)) keys.add(revisionAuditKey(entry));
  }
  const entry = {
    version: 1,
    at: input.at,
    event: 'revision',
    fromHash: input.fromHash,
    toHash: input.toHash,
    changed: revisionChangedList(input.changed),
    approvalAt: input.approvalAt,
  };
  if (keys.has(revisionAuditKey(entry))) return { ok: true, written: 0 };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, prefix + JSON.stringify(entry) + '\n');
  } catch (error) {
    return {
      ok: false,
      written: 0,
      error: 'ревизия не записана в ' + rel + ': ' + errorText(error),
    };
  }
  return { ok: true, written: 1 };
}

/**
 * Решить судьбу ожидания повторной подписи (0307).
 *
 * Ожидания нет — { status:'none', pending:false }. Текст изменился после старта
 * (currentHash !== newHash) — ожидание устарело (stale:true), аудит не пишется:
 * подписывать этот текст уже нельзя. Подпись действительна и относится ровно к
 * новому тексту (approvalOk && approvalHash === newHash) — ревизия состоялась:
 * одна строка event:'revision' в журнале, состояние signed и signedAt. Сбой
 * записи журнала подпись не отменяет: status:'signed' и audit.ok:false.
 *
 * @param root - корень проекта.
 * @param options - { approvalOk, approvalHash, currentHash, approvalAt, now }.
 * @returns {{ status: 'none'|'awaiting-signature'|'signed', pending: boolean,
 *   revision?: object, changed?: string[],
 *   audit?: {ok: boolean, written: number, error?: string}, stale?: boolean,
 *   error?: string }}
 */
export function resolveAnchorsRevision(root, options) {
  const source = isPlainObject(options) ? options : {};
  const rootPath = text(root);
  if (!rootPath) {
    return { status: 'none', pending: false, error: 'root не назван: состояние ревизии не прочитать' };
  }
  const read = readAnchorsRevision(rootPath);
  const revision = read.revision;
  if (!revision) {
    return read.error
      ? { status: 'none', pending: false, error: read.error }
      : { status: 'none', pending: false };
  }
  const status = text(revision.status).toLowerCase();
  const changed = revisionChangedList(revision.changed);
  /* Ожидания нет или оно уже закрыто — состояние читается как есть, аудит не пишется. */
  if (status !== 'awaiting-signature') {
    return { status, pending: false, revision, changed };
  }
  const newHash = text(revision.newHash);
  const currentHash = text(source.currentHash);
  /*
   * Текст после старта изменился: подпись, которую ждали, относится уже не к
   * текущим байтам. Ожидание остаётся, но судить о нём нельзя — stale.
   */
  if (currentHash !== newHash) {
    return { status: 'awaiting-signature', pending: true, stale: true, revision, changed };
  }
  const approvalHash = text(source.approvalHash);
  if (source.approvalOk !== true || approvalHash !== newHash) {
    return { status: 'awaiting-signature', pending: true, revision, changed };
  }
  const at = revisionNow(source.now);
  const approvalAt = text(source.approvalAt);
  const audit = recordRevisionAudit(rootPath, {
    at,
    fromHash: text(revision.oldHash),
    toHash: newHash,
    changed,
    approvalAt,
  });
  const signed = { ...revision, status: 'signed', signedAt: at, updatedAt: at };
  let writeError = '';
  try {
    writeRevisionAtomic(rootPath, revisionFilePath(rootPath), signed);
  } catch (error) {
    writeError = 'состояние ревизии не переписано в ' + ANCHORS_REVISION_REL + ': ' + errorText(error);
  }
  return {
    status: 'signed',
    pending: false,
    revision: signed,
    changed,
    audit,
    ...(writeError ? { error: writeError } : {}),
  };
}

