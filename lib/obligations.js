/**
 * Obligations of a declared structure: what a workspace MUST do, checked by a
 * machine instead of promised in AGENTS.md.
 *
 * The structure declares `obligations[]`; each item names one duty, the check
 * that proves it and what to do when it fails. Two kinds are implemented:
 *
 *   - `exchange-unread` — letters addressed to this workspace's participant in
 *     a declared exchange box must be read (at most `check.max`, 0 by default);
 *   - `command` — `check.run` must exit 0 (bounded time, bounded output).
 *
 * Every evaluation writes evidence into the plugin's store
 * (`<store>/evidence/<id>.json`), never into the repository: the repository is
 * the declaration, the store is the observation. `exchange-seen.json` in the
 * same store remembers which letters were read (path -> sha256) and is written
 * idempotently.
 *
 * Nothing here imports the DSH host: the module is plain Node and can be run by
 * the panel, by a check and by a test alike.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveBoxes } from './boxes.js';
import { parseHeader } from './exchange.js';
import { readStructure } from './load.js';
import { storeDir } from './store.js';

/** Command checks may not run forever: 120 seconds unless the declaration says otherwise. */
export const COMMAND_TIMEOUT_MS = 120 * 1000;

/** How many characters of a command's output are kept (in evidence and in detail). */
export const MAX_OUTPUT_CHARS = 4000;

/** Memory of read letters, relative to the store folder. */
export const SEEN_FILE = 'exchange-seen.json';

/** Evidence folder, relative to the store folder. */
export const EVIDENCE_DIR = 'evidence';

/** Evidence is deterministic and comparable across runs; the layout is part of the contract. */
const EVIDENCE_KEYS = ['at', 'ok', 'detail', 'hash', 'counts'];

/** ISO 8601 with the machine's offset: a report reader must not guess the zone. */
function nowIso(date = new Date()) {
  const value = date instanceof Date ? date : new Date();
  const offset = -value.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const local = new Date(value.getTime() + offset * 60 * 1000).toISOString().slice(0, 19);
  return local + sign + hours + ':' + minutes;
}

/** sha256 as lowercase hex; used both for letter markers and evidence hashes. */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** A path comparison key: the running platform decides whether case matters. */
function pathKey(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Key for the declared participant paths (folder.paths): case and separators do
 * not matter (задание 0080). A card written by the panel may carry forward
 * slashes, a trailing slash or another case for the very same root; the label
 * must still be recognised as ours. Relative values stay as declared — a
 * declaration that names a relative path is not silently mapped to cwd.
 */
function declaredPathKey(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  let normalized = text;
  if (path.isAbsolute(text)) {
    try {
      normalized = path.resolve(text);
    } catch {
      normalized = text;
    }
  }
  return normalized.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/').replace(/\/+$/u, '').toLowerCase();
}

/** Is `candidate` inside `root` (the repository must stay untouched)? */
function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Absolute project root; an empty value resolves against cwd, as everywhere else. */
function rootOf(value) {
  return path.resolve(String(value || process.cwd()));
}

/** The name shown for a workspace: its folder name, or the full path at a drive root. */
function workspaceOf(root) {
  return path.basename(root) || root;
}

/** A structure-declaration refusal: the caller decides whether it becomes a row or an HTTP error. */
function declarationError(code, message, fix, extra = {}) {
  return { code, message: String(message || ''), fix: String(fix || ''), ...extra };
}

/** Normalize one declared duty; an item without an id is not a duty and is skipped. */
function normalizeObligation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id;
  const source = raw.check && typeof raw.check === 'object' && !Array.isArray(raw.check) ? raw.check : {};
  const kind = typeof source.kind === 'string' ? source.kind.trim() : '';
  const enforce = typeof raw.enforce === 'string' && raw.enforce.trim() ? raw.enforce.trim() : 'warn';
  return { id, title, check: { ...source, kind }, enforce };
}

/** Folder declarations only need what the scanner reads: id, box, participants and paths. */
function normalizeFolder(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const box = raw.box && typeof raw.box === 'object' && !Array.isArray(raw.box)
    ? {
      path: typeof raw.box.path === 'string' ? raw.box.path.trim() : '',
      root: typeof raw.box.root === 'string' ? raw.box.root.trim() : 'shared',
    }
    : null;
  const participants = Array.isArray(raw.participants)
    ? raw.participants.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
  /*
   * Which participant is THIS workspace? An explicit folder.me (or
   * exchange.me) wins; otherwise the scanner tries the workspace's folder name
   * and, as a last resort, the first declared side. The harness declares
   * ['structure', 'workflow'], and `structure` is the local side there.
   */
  const declaredMe = typeof raw.me === 'string' && raw.me.trim()
    ? raw.me.trim()
    : (raw.exchange && typeof raw.exchange === 'object' && typeof raw.exchange.me === 'string' && raw.exchange.me.trim()
      ? raw.exchange.me.trim()
      : '');
  /*
   * Явные пути участников (folder.paths) — часть объявления ящика с задания
   * 0078: по ним lib/boxes.js считает общий предок и не склеивает shared с
   * workspace. Остальные поля папки (exchange, orchestrator) сканеру не нужны.
   */
  const paths = {};
  if (raw.paths && typeof raw.paths === 'object' && !Array.isArray(raw.paths)) {
    for (const [label, value] of Object.entries(raw.paths)) {
      if (typeof label === 'string' && label.trim() && typeof value === 'string' && value.trim()) {
        paths[label.trim()] = value.trim();
      }
    }
  }
  return { id, box, participants, me: declaredMe, paths };
}

/**
 * Read the declared structure once: obligations, folders, or a refusal.
 *
 * `lib/store.js` decides WHERE the declaration lives (legacy repo folder or the
 * external store); `lib/load.js` reads every fragment of it. A broken fragment
 * is reported, not thrown at the caller: the panel must answer with a reason,
 * and the check must not crash.
 *
 * @param root - project root.
 * @returns `{ ok: true, root, obligations, folders }` or
 *   `{ ok: false, root, code, message, fix, file? }`.
 */
export function readDeclaredStructure({ root } = {}) {
  const resolvedRoot = rootOf(root);
  const read = readStructure(resolvedRoot, 'structure');
  if (!read.exists) {
    return {
      ok: false,
      root: resolvedRoot,
      ...declarationError(
        'no-structure',
        'в проекте нет папки structure/: обязанности не объявлены',
        'Создайте structure/graph.json и добавьте obligations[] — либо откройте панель и постройте структуру.',
      ),
    };
  }
  const problems = [];
  const obligations = [];
  const folders = [];
  for (const file of read.files) {
    let document;
    try {
      document = JSON.parse(file.text);
    } catch (error) {
      problems.push({
        file: file.name,
        message: 'файл структуры не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'),
      });
      continue;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      problems.push({ file: file.name, message: 'файл структуры — не JSON-объект' });
      continue;
    }
    if (document.obligations !== undefined) {
      if (!Array.isArray(document.obligations)) {
        problems.push({ file: file.name, message: 'obligations должен быть массивом обязанностей' });
      } else {
        for (const raw of document.obligations) {
          const duty = normalizeObligation(raw);
          if (duty) obligations.push(duty);
        }
      }
    }
    if (document.folders !== undefined) {
      if (!Array.isArray(document.folders)) {
        problems.push({ file: file.name, message: 'folders должен быть массивом папок обмена' });
      } else {
        for (const raw of document.folders) {
          const folder = normalizeFolder(raw);
          if (folder) folders.push(folder);
        }
      }
    }
  }
  /*
   * An unreadable or oversized fragment means the declaration was read only in
   * part. Silence would hide exactly the duty that moved to that file, so the
   * read is refused instead of reporting a shorter list.
   */
  if (problems.length === 0 && read.problems.length > 0) {
    return {
      ok: false,
      root: resolvedRoot,
      ...declarationError(
        'structure-unreadable',
        read.problems[0].message,
        'Проверьте права на папку структуры и её файлы.',
        { file: read.problems[0].file, problems: read.problems },
      ),
    };
  }
  if (problems.length > 0) {
    return {
      ok: false,
      root: resolvedRoot,
      ...declarationError(
        'invalid-structure',
        problems[0].message,
        'Исправьте файл структуры: панель и проверки читают те же JSON-фрагменты.',
        { file: problems[0].file, problems },
      ),
    };
  }
  return { ok: true, root: resolvedRoot, obligations, folders };
}

/**
 * Normalized list of the structure's duties: `{ id, title, check, enforce }`.
 *
 * A project without a readable declaration has no declared duties; this reader
 * therefore answers an empty list, while {@link evaluateObligations} reports the
 * read failure separately.
 */
export function readObligations({ root } = {}) {
  const declared = readDeclaredStructure({ root });
  return declared.ok ? declared.obligations : [];
}

/** Read the store's seen map; a missing or broken file means "nothing read yet". */
function readSeenMap(root) {
  const file = path.join(storeDir(root), SEEN_FILE);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { file, rows: {} };
    return { file, rows: value };
  } catch {
    return { file, rows: {} };
  }
}

/** Only a sha256 marker counts as "read"; numeric delivery marks of older files are left alone. */
function isReadMarker(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value);
}

/**
 * The label of THIS workspace inside one folder.
 *
 * Order (задание 0080): explicit `folder.me` -> the entry of `folder.paths`
 * whose path is this root -> a participant that is an absolute path of this
 * root -> a participant equal to `basename(root)` -> the first participant.
 * The order of participants alone never decides the side: the live folder-3
 * declared paths for both roots with `reach-proxy` first, and the old rule made
 * letters `To: structure` "skipped" and our own `To: reach-proxy` replies
 * "unread". `folder.paths` is the card the panel and join write (0078).
 */
function selfLabel(root, folder) {
  if (folder && folder.me) return folder.me;
  const base = path.basename(root);
  const participants = Array.isArray(folder && folder.participants) ? folder.participants : [];
  const rootPath = declaredPathKey(root);
  const declaredPaths = folder && folder.paths && typeof folder.paths === 'object' && !Array.isArray(folder.paths)
    ? folder.paths
    : {};
  for (const [label, value] of Object.entries(declaredPaths)) {
    if (rootPath && declaredPathKey(value) === rootPath) return label;
  }
  for (const item of participants) {
    if (path.isAbsolute(item)) {
      if (pathKey(item) === pathKey(root)) return path.basename(item) || base;
      continue;
    }
    if (String(item).toLowerCase() === base.toLowerCase()) return item;
  }
  return participants[0] || base;
}

/** Every *.md under `dir`, recursively; unreadable folders are skipped. */
function messageFiles(dir) {
  const found = [];
  const walk = (current, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
        continue;
      }
      if (entry.isFile() && /\.md$/iu.test(entry.name)) found.push(full);
    }
  };
  walk(dir, 0);
  return found.sort((left, right) => left.localeCompare(right));
}

/** One header value without touching the body; used for Subject, which parseHeader does not return. */
function headerField(text, name) {
  const pattern = new RegExp('^' + name + ':\\s*(.+?)\\s*$', 'imu');
  const match = pattern.exec(String(text || ''));
  return match ? match[1].trim() : '';
}

/**
 * Why a letter was not counted as incoming, in the order of the CLI breakdown.
 * `service` — the letter is from THIS workspace's own label: our reply in a
 * shared box is not an incoming letter, and asking to read it would mean
 * reading ourselves. `unreadable` — the file cannot be read at all.
 */
export const SKIP_REASONS = ['not-addressee', 'no-header', 'service', 'unreadable'];

/** Counters of the skip reasons: every reason is present, absent ones are zeros. */
export function skipReasonCounts(rows) {
  const counts = {};
  for (const reason of SKIP_REASONS) counts[reason] = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const reason = row && typeof row.reason === 'string' ? row.reason : '';
    if (Object.hasOwn(counts, reason)) counts[reason] += 1;
  }
  return counts;
}

/**
 * Scan the exchange boxes declared by the structure.
 *
 * A letter is unread when it is not from this workspace, its `To:` is THIS
 * workspace's participant and its path is absent from
 * `<store>/exchange-seen.json`. Everything else is named in `skipped` with a
 * reason (`not-addressee`, `no-header`, `service`, `unreadable`), so a silent
 * counter can never hide letters; `reasons` carries the same counts.
 *
 * @returns `{ unread, seen, skipped, reasons, boxes, error? }`. `unread` rows
 *   are `{ path, to, date, subject }` with an absolute path.
 */
export function scanExchange({ root } = {}) {
  const resolvedRoot = rootOf(root);
  const result = { unread: [], seen: 0, skipped: [], reasons: skipReasonCounts([]), boxes: [] };
  const declared = readDeclaredStructure({ root: resolvedRoot });
  if (!declared.ok) {
    result.error = { code: declared.code, error: declared.message, fix: declared.fix };
    return result;
  }
  const seen = readSeenMap(resolvedRoot);
  /*
   * Ящики разрешает ОДИН резолвер (задание 0078): та же функция, что читает
   * панель и CLI. Ошибка одной папки остаётся её строкой, остальные работают.
   */
  const resolvedBoxes = resolveBoxes({ root: resolvedRoot, folders: declared.folders });
  result.problems = resolvedBoxes.problems;
  const boxById = new Map(resolvedBoxes.boxes.map((row) => [row.folderId, row]));
  for (const folder of declared.folders) {
    const box = {
      id: folder.id,
      path: null,
      participants: folder.participants.slice(),
      me: selfLabel(resolvedRoot, folder),
      letters: 0,
      unread: 0,
      seen: 0,
      skipped: 0,
      reasons: skipReasonCounts([]),
    };
    const resolved = boxById.get(folder.id);
    if (!resolved || resolved.status !== 'ok' || !resolved.path) {
      box.error = resolved && resolved.message ? resolved.message
        : 'у папки «' + folder.id + '» ящик не разрешён';
      box.code = resolved && resolved.code ? resolved.code : 'box-error';
      if (resolved && Array.isArray(resolved.candidates)) box.candidates = resolved.candidates.slice();
      result.boxes.push(box);
      continue;
    }
    box.path = resolved.path;
    let stat = null;
    try {
      stat = fs.statSync(resolved.path);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) {
      box.error = 'папка обмена не найдена: ' + resolved.path;
      result.boxes.push(box);
      continue;
    }
    const threads = path.join(resolved.path, 'threads');
    let scanDir = threads;
    try {
      if (!fs.statSync(threads).isDirectory()) scanDir = resolved.path;
    } catch {
      scanDir = resolved.path;
    }
    /** One skipped letter: the box, the scan and both counter maps see the same reason. */
    const skip = (absolute, reason, extra = {}) => {
      box.skipped += 1;
      box.reasons[reason] += 1;
      result.reasons[reason] += 1;
      result.skipped.push({ path: absolute, reason, ...extra });
    };
    for (const file of messageFiles(scanDir)) {
      const absolute = path.resolve(file);
      let text;
      try {
        text = fs.readFileSync(absolute, 'utf8');
      } catch {
        skip(absolute, 'unreadable');
        continue;
      }
      const parsed = parseHeader(text);
      if (!parsed) {
        skip(absolute, 'no-header');
        continue;
      }
      const from = typeof parsed.from === 'string' ? parsed.from : '';
      /*
       * Причина service проверяется раньше адресата: письмо от нашей метки —
       * наша же служебная копия в общем ящике, и непрочитанным быть не может
       * (инвариант 2 задания 0080).
       */
      if (from && String(from).toLowerCase() === String(box.me).toLowerCase()) {
        skip(absolute, 'service', { from, to: parsed.to });
        continue;
      }
      if (String(parsed.to).toLowerCase() !== String(box.me).toLowerCase()) {
        skip(absolute, 'not-addressee', { to: parsed.to });
        continue;
      }
      box.letters += 1;
      if (isReadMarker(seen.rows[absolute])) {
        box.seen += 1;
        result.seen += 1;
        continue;
      }
      box.unread += 1;
      /*
       * Строки unread расширены АДДИТИВНО (задание 0113): счётчику внимания нужны
       * status, from и replyTo, а прежние поля и число unread не меняются.
       */
      result.unread.push({
        path: absolute,
        to: parsed.to,
        date: parsed.date,
        subject: headerField(text, 'Subject'),
        status: parsed.status,
        from,
        replyTo: parsed.replyTo,
      });
    }
    result.boxes.push(box);
  }
  result.unread.sort((left, right) => String(right.date).localeCompare(String(left.date))
    || left.path.localeCompare(right.path));
  return result;
}

/**
 * Статусы письма, которые требуют хода от нас (задание 0113, решение D1).
 *
 * Счётчик панели отвечает на вопрос «что ждёт меня», а не «что мне адресовано»:
 * отчёт, ответ, квитанция, приглашение и заметка хода не требуют.
 */
export const ATTENTION_STATUSES = ['request', 'question'];

/**
 * Окно актуальности заявки (задание 0128): заявка старше 14 суток не входит в
 * счётчик «требуют хода», а считается просроченной.
 *
 * Бейдж отвечает на вопрос «что ждёт меня сейчас». Хвост request/question,
 * который копился месяцами, иначе никогда не сходится; но и терять его молча
 * нельзя — число просроченных видно отдельно (stale), а карточка обмена
 * показывает их и позволяет закрыть ack-письмом.
 */
export const ATTENTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Сравнение статуса не зависит от регистра; письмо без Status хода не требует. */
function letterStatus(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

/**
 * Ключи файла, который может назвать Reply-To: абсолютный путь, путь от ящика
 * или от корня проекта. Ответ должен находиться, даже если в письме он записан
 * короче — так же прощает путь resolveLetter у отметки прочитанного.
 */
function replyPathKeys(value, boxPath, root) {
  const text = String(value || '').trim();
  if (!text) return [];
  if (path.isAbsolute(text)) return [pathKey(text)];
  const keys = [pathKey(path.resolve(root, text))];
  if (boxPath) keys.push(pathKey(path.resolve(boxPath, text)));
  return keys;
}

/**
 * Голое имя файла из Reply-To: значение без единого разделителя пути (0116).
 *
 * Старые ответы (31.10–01.11) писали `Reply-To: 2026-11-01T01-45+03-00--workflow--06.md`:
 * имя файла без папки. Само по себе имя — не адрес, поэтому оно сопоставимо
 * только с письмом в ТОЙ ЖЕ папке, где лежит ответ; значение с разделителем
 * пути (прямым или обратным слэшем) остаётся на попечении replyPathKeys (0113).
 */
function bareReplyName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (path.isAbsolute(text)) return '';
  if (text.includes('/') || text.includes('\\')) return '';
  return text;
}

/**
 * Метка этого воркспейса в объявленной папке (задание 0128).
 *
 * Маршрут закрытия заявки пишет ack от имени СВОЕЙ стороны, а не угадывает её:
 * выбор тот же, что у сканера и счётчика внимания (явный folder.me -> путь из
 * folder.paths -> участник-путь -> basename -> первый участник).
 */
export function exchangeSelfLabel({ root, folder } = {}) {
  return selfLabel(rootOf(root), folder && typeof folder === 'object' ? folder : {});
}

/**
 * Письма, которые требуют хода: request и question без нашего ответа.
 *
 * Бейдж панели показывал «непрочитано 192» там, где 108 писем были answer, а
 * 43 — report: это вся история переписки, а не ожидание. Требуют хода только
 * `request` и `question`, адресованные нашей метке, если в ящиках ещё нет
 * письма от неё же с `Reply-To` на путь этого письма (задание 0113, D1).
 * Голое имя файла в Reply-To считается ответом на письмо с тем же именем в том
 * же каталоге (задание 0116); имя из другой папки заявку не снимает.
 * Семантика {@link scanExchange} не меняется: это отдельный счёт, и `unread`
 * сканера по-прежнему значит «адресовано и не отмечено прочитанным».
 *
 * Пропуски повторяют scanExchange: письмо от нашей метки (service), чужому
 * адресату (not-addressee), без шапки (no-header) и нечитаемый файл (unreadable)
 * не считаются. Ошибка папки остаётся строкой `error` с attention 0 и не роняет
 * общий счёт остальных папок.
 *
 * Окно 14 суток (задание 0128): заявка старше окна не входит ни в `total`,
 * ни в `items`, а считается в `stale` — числе просроченных. Окно задаётся
 * `maxAgeMs` (тесты и настройка), точка отсчёта — `now` (Date или epoch-ms).
 * Письмо с нечитаемой датой не становится просроченным: оно не заявка, а
 * `no-header` у сканера. Повторный запрос с `Ref` на старое — обычное свежее
 * письмо, поэтому снова попадает в счёт.
 *
 * @returns `{ total, folders, items, stale, staleItems, error?, problems? }`:
 *   `folders` — строка на объявленную папку (`{ id, attention, error? }`),
 *   `items` — строки `{ path, status, to, date, subject }` с абсолютным путём,
 *   `stale` — число заявок старше окна (они видны, но не в счётчике), а
 *   `staleItems` — те же строки просроченных: карточка показывает их и умеет
 *   закрыть ack-письмом, поэтому хвост не только посчитан, но и разбирается.
 */
export function exchangeAttention({ root, now, maxAgeMs } = {}) {
  const resolvedRoot = rootOf(root);
  const result = { total: 0, folders: [], items: [], stale: 0, staleItems: [] };
  /* Точка отсчёта и окно: параметры для тестов, по умолчанию — сейчас и 14 суток. */
  const reference = now instanceof Date
    ? now.getTime()
    : (typeof now === 'number' && Number.isFinite(now) ? now : Date.now());
  const requestedAge = maxAgeMs === undefined || maxAgeMs === null ? ATTENTION_MAX_AGE_MS : Number(maxAgeMs);
  const maxAge = Number.isFinite(requestedAge) && requestedAge >= 0 ? requestedAge : ATTENTION_MAX_AGE_MS;
  const declared = readDeclaredStructure({ root: resolvedRoot });
  if (!declared.ok) {
    result.error = { code: declared.code, error: declared.message, fix: declared.fix };
    return result;
  }
  const resolvedBoxes = resolveBoxes({ root: resolvedRoot, folders: declared.folders });
  result.problems = resolvedBoxes.problems;
  const boxById = new Map(resolvedBoxes.boxes.map((row) => [row.folderId, row]));
  const scans = [];
  for (const folder of declared.folders) {
    const scan = { id: folder.id, me: selfLabel(resolvedRoot, folder), path: null, attention: 0, letters: [] };
    const resolved = boxById.get(folder.id);
    if (!resolved || resolved.status !== 'ok' || !resolved.path) {
      scan.error = resolved && resolved.message ? resolved.message
        : 'у папки «' + folder.id + '» ящик не разрешён';
      scan.code = resolved && resolved.code ? resolved.code : 'box-error';
      scans.push(scan);
      continue;
    }
    scan.path = resolved.path;
    let stat = null;
    try {
      stat = fs.statSync(resolved.path);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) {
      scan.error = 'папка обмена не найдена: ' + resolved.path;
      scans.push(scan);
      continue;
    }
    const threads = path.join(resolved.path, 'threads');
    let scanDir = threads;
    try {
      if (!fs.statSync(threads).isDirectory()) scanDir = resolved.path;
    } catch {
      scanDir = resolved.path;
    }
    for (const file of messageFiles(scanDir)) {
      const absolute = path.resolve(file);
      let text;
      try {
        text = fs.readFileSync(absolute, 'utf8');
      } catch {
        continue; /* unreadable — пропуск, как в scanExchange */
      }
      const parsed = parseHeader(text);
      if (!parsed) continue; /* no-header — пропуск, как в scanExchange */
      scan.letters.push({
        path: absolute,
        from: typeof parsed.from === 'string' ? parsed.from : '',
        to: typeof parsed.to === 'string' ? parsed.to : '',
        status: typeof parsed.status === 'string' ? parsed.status : '',
        replyTo: typeof parsed.replyTo === 'string' ? parsed.replyTo : '',
        date: parsed.date,
        /* Разобранное время письма: окно 14 суток считается по нему, не по строке. */
        at: Number.isFinite(parsed.at) ? parsed.at : null,
        subject: headerField(text, 'Subject'),
      });
    }
    scans.push(scan);
  }
  /*
   * Ответ ищется во ВСЕХ ящиках: переписка может лежать в общей папке, а
   * служебная копия — в своей. Наш ответ — письмо от метки этой папки с
   * Reply-To; путь письма сравнивается платформенно (регистр и разделители).
   */
  const answered = new Set();
  for (const scan of scans) {
    const me = String(scan.me || '').toLowerCase();
    if (!me) continue;
    for (const letter of scan.letters) {
      if (String(letter.from || '').toLowerCase() !== me) continue;
      for (const key of replyPathKeys(letter.replyTo, scan.path, resolvedRoot)) answered.add(key);
      /*
       * Задание 0116: голое имя файла — ответ на письмо с тем же именем в том же
       * каталоге. Ключ строится от каталога САМОГО ответа, поэтому ответ,
       * лежащий в другой папке, чужое имя не снимает.
       */
      const bare = bareReplyName(letter.replyTo);
      if (bare) answered.add(pathKey(path.join(path.dirname(letter.path), bare)));
    }
  }
  for (const scan of scans) {
    const me = String(scan.me || '').toLowerCase();
    for (const letter of scan.letters) {
      const status = letterStatus(letter.status);
      if (!ATTENTION_STATUSES.includes(status)) continue;
      if (!me) continue;
      if (String(letter.from || '').toLowerCase() === me) continue; /* service */
      if (String(letter.to || '').toLowerCase() !== me) continue; /* not-addressee */
      if (answered.has(pathKey(letter.path))) continue; /* уже ответили */
      /*
       * Окно 14 суток (задание 0128): просроченная заявка видна числом stale, но
       * в счётчик не входит. Нечитаемая дата просроченной не считается — она и
       * заявкой не стала (parseHeader её отбросил).
       */
      if (Number.isFinite(letter.at) && reference - letter.at > maxAge) {
        result.stale += 1;
        result.staleItems.push({
          path: letter.path,
          status,
          to: letter.to,
          date: letter.date,
          subject: letter.subject,
        });
        continue;
      }
      scan.attention += 1;
      result.items.push({
        path: letter.path,
        status,
        to: letter.to,
        date: letter.date,
        subject: letter.subject,
      });
    }
    result.total += scan.attention;
    const row = { id: scan.id, attention: scan.attention };
    if (scan.error) {
      row.error = scan.error;
      row.code = scan.code;
    }
    result.folders.push(row);
  }
  const newestFirst = (left, right) => String(right.date).localeCompare(String(left.date))
    || left.path.localeCompare(right.path);
  result.items.sort(newestFirst);
  result.staleItems.sort(newestFirst);
  return result;
}

/** Find the file behind a caller-supplied path: absolute first, then every declared box. */
function resolveLetter(root, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (path.isAbsolute(text)) return path.resolve(text);
  const candidates = [path.resolve(root, text)];
  const declared = readDeclaredStructure({ root });
  if (declared.ok) {
    const resolved = resolveBoxes({ root, folders: declared.folders });
    for (const box of resolved.boxes) {
      if (box.status === 'ok' && box.path) candidates.push(path.resolve(box.path, text));
    }
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/** Write text through a temporary sibling and a rename, so a reader never sees half a file. */
function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + String(process.pid) + '-' + Math.random().toString(36).slice(2, 10) + '.tmp';
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* the original error matters */ }
    throw error;
  }
}

/**
 * Mark letters as read in `<store>/exchange-seen.json` (absolute path -> sha256).
 *
 * Idempotent by construction: the map is merged, keys are sorted, and an
 * unchanged result is not rewritten. Existing entries of other tools (the
 * watcher's numeric delivery marks) are preserved.
 *
 * @returns `{ file, marked, written }`; a letter that cannot be read is not marked.
 */
export function markExchangeSeen({ root, paths } = {}) {
  const resolvedRoot = rootOf(root);
  const file = path.join(storeDir(resolvedRoot), SEEN_FILE);
  const previous = readSeenMap(resolvedRoot);
  const next = { ...previous.rows };
  let marked = 0;
  for (const value of Array.isArray(paths) ? paths : []) {
    const letter = resolveLetter(resolvedRoot, value);
    if (!letter) continue;
    let content;
    try {
      content = fs.readFileSync(letter);
    } catch {
      continue;
    }
    const key = path.resolve(letter);
    next[key] = sha256(content);
    marked += 1;
  }
  const sorted = {};
  for (const key of Object.keys(next).sort((left, right) => left.localeCompare(right))) sorted[key] = next[key];
  const text = JSON.stringify(sorted, null, 1) + '\n';
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = null;
  }
  if (current === text) return { file, marked, written: false };
  writeTextAtomic(file, text);
  return { file, marked, written: true };
}

/** Directory of the evidence files for one project (kept out of the repository). */
export function evidenceDir(root) {
  return path.join(storeDir(rootOf(root)), EVIDENCE_DIR);
}

/** Safe file name for an obligation id: the id is a label, not a path. */
function evidenceFile(root, id) {
  const safe = String(id).replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^\.+/u, '') || 'obligation';
  return path.join(evidenceDir(root), safe + '.json');
}

/**
 * Write one evidence file into the store.
 *
 * The repository is never touched: if a profile points the store INSIDE the
 * project, evidence is skipped rather than dirtying a tracked tree. The hash
 * binds the four observable fields, so an edited file stops matching its own
 * hash.
 */
function writeEvidence(root, obligation, outcome) {
  const store = storeDir(root);
  const file = evidenceFile(root, obligation.id);
  const at = nowIso();
  const payload = {
    id: obligation.id,
    at,
    ok: outcome.ok === true,
    detail: String(outcome.detail || ''),
    counts: outcome.counts && typeof outcome.counts === 'object' ? outcome.counts : {},
    ...(typeof outcome.output === 'string' && outcome.output ? { output: outcome.output } : {}),
  };
  payload.hash = sha256(JSON.stringify({ id: payload.id, at: payload.at, ok: payload.ok, detail: payload.detail, counts: payload.counts }));
  if (isInside(root, store)) return { at: null, hash: null, skipped: true, file };
  try {
    writeTextAtomic(file, JSON.stringify(payload, null, 2) + '\n');
  } catch {
    return { at: null, hash: null, skipped: true, file };
  }
  return { at, hash: payload.hash, skipped: false, file };
}

/** Command timeout from the declaration: milliseconds, seconds, then the 120 s default. */
function commandTimeout(check) {
  const direct = Number(check && check.timeoutMs);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const seconds = Number(check && check.timeout);
  if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1000);
  return COMMAND_TIMEOUT_MS;
}

/** Run one `kind: command` check: bounded time, bounded output, no exception. */
function runCommandCheck(obligation, root) {
  const run = typeof obligation.check.run === 'string' ? obligation.check.run.trim() : '';
  if (!run) return { ok: false, detail: 'в проверке command не задан check.run', counts: {} };
  const timeoutMs = commandTimeout(obligation.check);
  const started = Date.now();
  let result;
  try {
    result = spawnSync(run, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
  } catch (error) {
    return {
      ok: false,
      detail: 'команда не запустилась: ' + (error && error.message ? error.message : 'ошибка'),
      counts: { exitCode: null, timedOut: false, durationMs: Date.now() - started },
    };
  }
  const durationMs = Date.now() - started;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const raw = stdout + stderr;
  const output = raw.length > MAX_OUTPUT_CHARS ? raw.slice(0, MAX_OUTPUT_CHARS) : raw;
  const failure = result.error || null;
  const timedOut = Boolean(failure && (failure.code === 'ETIMEDOUT'
    || /ETIMEDOUT|timed?\s*out|таймаут/iu.test(String(failure.message || ''))));
  const counts = {
    exitCode: result.status === undefined ? null : result.status,
    signal: result.signal || null,
    timedOut,
    durationMs,
    timeoutMs,
    outputChars: raw.length,
    outputTruncated: raw.length > MAX_OUTPUT_CHARS,
  };
  if (timedOut) {
    return {
      ok: false,
      detail: 'команда не уложилась в ' + timeoutMs + ' мс (таймаут)' + (output ? ': ' + output.slice(0, 400) : ''),
      counts,
      output,
    };
  }
  if (failure) {
    return {
      ok: false,
      detail: 'команда не запустилась: ' + (failure.message || failure.code || 'ошибка'),
      counts,
      output,
    };
  }
  const ok = result.status === 0;
  const tail = output ? ': ' + output.slice(0, 400) : '';
  return {
    ok,
    detail: ok ? 'команда завершилась с кодом 0' + tail : 'команда завершилась с кодом ' + result.status + ' (ожидался 0)' + tail,
    counts,
    output,
  };
}

/** Evaluate one `kind: exchange-unread` duty over a shared scan. */
function exchangeCheck(obligation, scan) {
  if (scan.error) {
    return {
      ok: false,
      detail: 'обмен не прочитан: ' + scan.error.error,
      counts: { unread: 0, seen: 0, skipped: 0, boxes: 0, max: 0 },
    };
  }
  const declaredMax = Number(obligation.check.max);
  const max = Number.isFinite(declaredMax) && declaredMax >= 0 ? Math.floor(declaredMax) : 0;
  const count = scan.unread.length;
  const counts = {
    unread: count,
    seen: scan.seen,
    skipped: scan.skipped.length,
    boxes: scan.boxes.length,
    max,
  };
  if (count <= max) {
    return { ok: true, detail: 'непрочитано ' + count + ' (порог ' + max + ')', counts };
  }
  const first = scan.unread[0];
  const subject = first && first.subject ? ' «' + first.subject + '»' : '';
  return {
    ok: false,
    detail: 'непрочитано ' + count + ' (порог ' + max + '): ' + (first ? first.path + ' To: ' + first.to + subject : ''),
    counts,
  };
}

/**
 * Evaluate every duty of the structure.
 *
 * @returns `{ workspace, obligations: [{ id, title, ok, detail, evidenceAt }], error? }`.
 *   A broken declaration is reported as `error` (shape of an HTTP refusal), not
 *   thrown; a failed CHECK is a row with `ok: false`, never an exception.
 */
export function evaluateObligations({ root } = {}) {
  const resolvedRoot = rootOf(root);
  const workspace = workspaceOf(resolvedRoot);
  let declared;
  try {
    declared = readDeclaredStructure({ root: resolvedRoot });
  } catch (error) {
    return {
      workspace,
      obligations: [],
      error: {
        code: 'structure-unreadable',
        error: 'структура не прочитана: ' + (error && error.message ? error.message : 'ошибка'),
        fix: 'Проверьте папку структуры и права на её файлы.',
      },
    };
  }
  if (!declared.ok) {
    return {
      workspace,
      obligations: [],
      error: {
        code: declared.code,
        error: declared.message,
        fix: declared.fix,
        ...(declared.file ? { file: declared.file } : {}),
      },
    };
  }
  let scan = null;
  const rows = [];
  for (const obligation of declared.obligations) {
    let outcome;
    try {
      const kind = obligation.check && obligation.check.kind ? obligation.check.kind : '';
      if (kind === 'exchange-unread') {
        if (!scan) scan = scanExchange({ root: resolvedRoot });
        outcome = exchangeCheck(obligation, scan);
      } else if (kind === 'command') {
        outcome = runCommandCheck(obligation, resolvedRoot);
      } else {
        outcome = {
          ok: false,
          detail: 'неизвестный вид проверки «' + kind + '»: поддерживаются exchange-unread и command',
          counts: {},
        };
      }
    } catch (error) {
      outcome = {
        ok: false,
        detail: 'проверка упала: ' + (error && error.message ? error.message : 'ошибка'),
        counts: {},
      };
    }
    let evidence = { at: null };
    try {
      evidence = writeEvidence(resolvedRoot, obligation, outcome);
    } catch {
      /* evidence is the proof, not the condition of an answer: a broken store must not hide the row */
    }
    rows.push({
      id: obligation.id,
      title: obligation.title,
      ok: outcome.ok === true,
      detail: String(outcome.detail || ''),
      evidenceAt: evidence.at || null,
    });
  }
  return { workspace, obligations: rows };
}

/*
 * Kept as the documented shape of an evidence row; tests read the same keys.
 * (A const array is cheaper than restating the contract in every comment.)
 */
export const EVIDENCE_FIELDS = EVIDENCE_KEYS;
