/**
 * Утверждение структуры (0204).
 *
 * Структура — не данные задания, а настройка владельца: граф узлов и связей
 * меняет только он. Чтобы это было проверяемым фактом, а не обещанием, структура
 * получает подписываемый хеш:
 *
 *   structureHash(root) — sha256 по ОТСОРТИРОВАННЫМ файлам structure/**.
 *   Каждый файл входит как путь ВНУТРИ structure/ (прямые слэши, например
 *   graph.json) + NUL + дословные байты. structure/approval.json — сам акт
 *   утверждения, поэтому в хеш не входит: иначе подпись не могла бы существовать.
 *
 *   verifyStructureApproval(root, opts) — читает structure/approval.json
 *   ({version:1, algo:'sha256', hash, by, at, signature:{keyId, algo, covers,
 *   value}}), сверяет hash с текущими байтами структуры, LF в конце файла,
 *   человеческий keyId (human-*), Ed25519 по canonical({hash,by,at}) и
 *   возвращает {ok, hash, reason}. Любая неясность — отказ; подпись ставит
 *   владелец вне панели, панель её только читает.
 *
 * Модуль не бросает на битой структуре: verify возвращает reason, потому что
 * гейт запуска обязан объяснить отказ, а не упасть.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyApprovalSignature } from './anchors.js';

/** Каталог структуры относительно корня проекта. */
export const STRUCTURE_DIR = 'structure';

/** Имя файла утверждения внутри каталога структуры. */
export const STRUCTURE_APPROVAL_FILE = 'approval.json';

/** Путь утверждения относительно корня проекта (прямые слэши). */
export const STRUCTURE_APPROVAL_RELATIVE = STRUCTURE_DIR + '/' + STRUCTURE_APPROVAL_FILE;

/** Версия формата утверждения структуры. */
export const STRUCTURE_APPROVAL_VERSION = 1;

/** Алгоритм хеша структуры. */
export const STRUCTURE_APPROVAL_ALGO = 'sha256';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function messageOf(error) {
  return String(error && error.message ? error.message : error);
}

/** Корень проекта: пустой/битый — текущий каталог (как у остальных модулей). */
function projectRootOf(root) {
  try {
    return path.resolve(String(root || process.cwd()));
  } catch {
    return path.resolve(process.cwd());
  }
}

/**
 * Файлы структуры для хеша: относительные пути (прямые слэши), отсортированы.
 *
 * Рекурсивно, только обычные файлы; structure/approval.json исключён как акт
 * утверждения. Папки и ссылки не входят: структура — это файлы, которые читает
 * сборщик графа. Нет каталога — пустой список (пустая структура).
 *
 * @param root - корень проекта.
 * @returns {string[]} Отсортированные пути внутри structure/ (прямые слэши).
 */
export function structureFiles(root) {
  const base = projectRootOf(root);
  const dir = path.join(base, STRUCTURE_DIR);
  const out = [];
  const walk = (absolute, relative) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(childAbsolute, childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (childRelative === STRUCTURE_APPROVAL_FILE) continue;
      out.push(childRelative);
    }
  };
  try {
    walk(dir, '');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    return [];
  }
  return out.sort();
}

/**
 * sha256 структуры: отсортированные файлы structure/**, путь + NUL + байты.
 *
 * Хеш дословный: изменение любого байта графа (включая пробел и перевод строки)
 * меняет hash и делает утверждение недействительным. structure/approval.json в
 * хеш не входит — это подпись под ним, а не часть графа.
 *
 * @param root - корень проекта.
 * @returns {string} 64 hex sha256.
 */
export function structureHash(root) {
  const base = projectRootOf(root);
  const hash = crypto.createHash(STRUCTURE_APPROVAL_ALGO);
  for (const relative of structureFiles(base)) {
    hash.update(relative, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(path.join(base, STRUCTURE_DIR, ...relative.split('/'))));
  }
  return hash.digest('hex');
}

/**
 * Проверить утверждение структуры (0204).
 *
 * Порядок проверок: (1) structure/** не изменилась с подписи — hash совпадает;
 * (2) structure/approval.json — дословный текст с LF в конце; (3) формат
 * version/algo/by/at; (4) подпись человеческая (human-*), covers hash+by+at;
 * (5) Ed25519 по canonical({hash,by,at}) ключом options.publicKeyPem или
 * <root>/.wf-keys/<keyId>.pub.pem. Нет ключа или файла утверждения — отказ.
 *
 * @param root - корень проекта.
 * @param options - { publicKeyPem?, keysDir? }; иначе ключ из <root>/.wf-keys.
 * @returns {{ ok: boolean, hash: string, reason: string }} hash — текущий хеш.
 */
export function verifyStructureApproval(root, options = {}) {
  const base = projectRootOf(root);
  const input = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  let hash = '';
  try {
    hash = structureHash(base);
  } catch (error) {
    return { ok: false, hash, reason: 'structure/** не прочитана: ' + messageOf(error) };
  }
  const approvalPath = path.join(base, STRUCTURE_DIR, STRUCTURE_APPROVAL_FILE);
  let textFile;
  try {
    textFile = fs.readFileSync(approvalPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, hash, reason: 'structure/approval.json нет: структура не утверждена владельцем' };
    }
    return { ok: false, hash, reason: 'structure/approval.json не прочитан: ' + messageOf(error) };
  }
  if (!textFile.endsWith('\n')) {
    return { ok: false, hash, reason: 'нет LF в конце structure/approval.json: утверждение — дословный текст' };
  }
  let approval;
  try {
    approval = JSON.parse(textFile);
  } catch (error) {
    return { ok: false, hash, reason: 'structure/approval.json: не JSON — ' + messageOf(error) };
  }
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
    return { ok: false, hash, reason: 'structure/approval.json: корень — не JSON-объект' };
  }
  if (approval.version !== STRUCTURE_APPROVAL_VERSION) {
    return {
      ok: false, hash,
      reason: 'version «' + JSON.stringify(approval.version) + '» не поддерживается: утверждение структуры — version 1',
    };
  }
  if (text(approval.algo).toLowerCase() !== STRUCTURE_APPROVAL_ALGO) {
    return {
      ok: false, hash,
      reason: 'algo «' + text(approval.algo) + '» не поддерживается: хеш структуры — только sha256',
    };
  }
  const claimed = text(approval.hash).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(claimed)) {
    return { ok: false, hash, reason: 'hash «' + text(approval.hash) + '» — не sha256: нужно 64 шестнадцатеричных знака' };
  }
  if (claimed !== hash) {
    return {
      ok: false, hash,
      reason: 'hash не совпадает со структурой: structure/** изменилась после утверждения (сейчас ' + hash + ')',
    };
  }
  const by = Array.isArray(approval.by) ? approval.by : [];
  if (by.length === 0 || by.some((item) => typeof item !== 'string' || !item.trim())) {
    return { ok: false, hash, reason: 'by: утверждение обязано назвать, кто утверждает — непустой список строк' };
  }
  if (typeof approval.at !== 'string' || !approval.at.trim()) {
    return { ok: false, hash, reason: 'at: утверждение обязано назвать время — непустая строка' };
  }
  const signature = approval.signature;
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) {
    return { ok: false, hash, reason: 'нет signature: структура утверждается подписью, а не пересказом' };
  }
  const keyId = text(signature.keyId);
  if (!/^human-/u.test(keyId)) {
    return {
      ok: false, hash,
      reason: 'signature.keyId «' + keyId + '» не human-*: структуру утверждает только владелец, агент — нет',
    };
  }
  if (text(signature.covers) !== 'hash+by+at') {
    return {
      ok: false, hash,
      reason: 'signature.covers «' + text(signature.covers) + '» не покрывает hash+by+at: подпись без автора и времени не утверждение',
    };
  }
  const verification = verifyApprovalSignature(approval, {
    publicKeyPem: input.publicKeyPem,
    keysDir: input.keysDir,
    root: base,
  });
  if (!verification.ok) {
    return { ok: false, hash, reason: 'подпись структуры не подтверждена: ' + verification.errors.join('; ') };
  }
  return { ok: true, hash, reason: '' };
}
