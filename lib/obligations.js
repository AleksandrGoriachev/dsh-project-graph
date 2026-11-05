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

/** The label of THIS workspace inside one folder: declared me, folder-name match, then the first side. */
function selfLabel(root, folder) {
  if (folder && folder.me) return folder.me;
  const base = path.basename(root);
  for (const item of Array.isArray(folder && folder.participants) ? folder.participants : []) {
    if (path.isAbsolute(item)) {
      if (pathKey(item) === pathKey(root)) return path.basename(item) || base;
      continue;
    }
    if (String(item).toLowerCase() === base.toLowerCase()) return item;
  }
  return (folder && folder.participants[0]) || base;
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
 * Scan the exchange boxes declared by the structure.
 *
 * A letter is unread when its `To:` is THIS workspace's participant and its
 * path is absent from `<store>/exchange-seen.json`. Letters to other
 * participants and letters without a usable header are not counted — they are
 * named in `skipped`, so a silent counter can never hide them.
 *
 * @returns `{ unread, seen, skipped, boxes, error? }`. `unread` rows are
 *   `{ path, to, date, subject }` with an absolute path.
 */
export function scanExchange({ root } = {}) {
  const resolvedRoot = rootOf(root);
  const result = { unread: [], seen: 0, skipped: [], boxes: [] };
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
    for (const file of messageFiles(scanDir)) {
      const absolute = path.resolve(file);
      let text;
      try {
        text = fs.readFileSync(absolute, 'utf8');
      } catch {
        box.skipped += 1;
        result.skipped.push({ path: absolute, reason: 'unreadable' });
        continue;
      }
      const parsed = parseHeader(text);
      if (!parsed) {
        box.skipped += 1;
        result.skipped.push({ path: absolute, reason: 'no-header' });
        continue;
      }
      if (String(parsed.to).toLowerCase() !== String(box.me).toLowerCase()) {
        box.skipped += 1;
        result.skipped.push({ path: absolute, reason: 'not-addressee', to: parsed.to });
        continue;
      }
      box.letters += 1;
      if (isReadMarker(seen.rows[absolute])) {
        box.seen += 1;
        result.seen += 1;
        continue;
      }
      box.unread += 1;
      result.unread.push({
        path: absolute,
        to: parsed.to,
        date: parsed.date,
        subject: headerField(text, 'Subject'),
      });
    }
    result.boxes.push(box);
  }
  result.unread.sort((left, right) => String(right.date).localeCompare(String(left.date))
    || left.path.localeCompare(right.path));
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
