/**
 * The exchange box is a relation, not a file dump: a message written into
 * `coordination/threads` must reach a reader.
 *
 * Until now the panel only *read* the box (the client refreshes it on a timer), and
 * the host woke an addressee only inside a scheduled critic run. So an answer written
 * by a person or an agent sat in the folder and nobody in the other workspace learned
 * about it — the customer saw exactly that: "твой ответ не разбудил агента в workflow".
 *
 * This watcher closes that gap. Rules, taken from the customer's schema
 * (`coordination/SCHEMA-wake-last-active-session.md`):
 *   1. the addressee is the LAST ACTIVE session of the addressee workspace, by the
 *      time of the last journal write, not by `createdAt` and not by list order;
 *   2. no live session of that workspace means no delivery: the message stays in the
 *      box and the record says so honestly (spawning a foreign workspace is off by
 *      default — `wakeSpawn: true` turns it on);
 *   3. nothing is invented about the message: the wake carries the path, the header
 *      fields and the demand to open the file and answer through `Reply-To`.
 *
 * The watcher never parses message bodies and never comments on their content.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentLabel, exchangeDirs, parseHeader } from './exchange.js';
import { readGraph } from './api.js';
import { isInsideRoot, normalizePath, readSessionActivity } from './live.js';
import { listRuns, noteRun, storeDir } from './runs.js';

/** How often the box is scanned; a person writing a file expects seconds, not a minute. */
export const EXCHANGE_WATCH_TICK_MS = 4000;

/**
 * How old a message may be and still be delivered at start-up.
 *
 * A restart must not lose the answer that was written a minute ago, and must not
 * wake anybody for yesterday's mail either.
 */
export const EXCHANGE_BACKLOG_MS = 30 * 60 * 1000;

/**
 * A failed wake is retried at most this often while its backlog window is open.
 *
 * It MUST exceed SPAWN_COOLDOWN_MS (90 s). The retry used to be 60 s, so after one
 * failed start every retry landed inside the 90 s window, said "поднимался меньше
 * 90 с назад", and the letter never left the box — the livelock of 2026-11-01 that
 * hid the real start error behind a cooldown message.
 */
const RETRY_AFTER_MS = 120 * 1000;

/** How many delivered letters the on-disk memory keeps; older ones are forgotten first. */
const SEEN_LIMIT = 1000;

/**
 * The watcher's own telemetry file.
 *
 * The run store was not enough: a watcher that never starts, or dies inside its first
 * pass, leaves nothing there and looks exactly like a healthy one. This file is written
 * on start, on every pass and on every error, so the question "is it alive" has an
 * answer even when the host log is silent.
 */
export const WATCH_TELEMETRY_PATH = path.join(os.homedir(), '.dsh', 'project-graph', 'exchange-watch.json');

/**
 * Memory of what was already delivered, kept on disk.
 *
 * In-process memory looked fine and was a lie across restarts: every host restart made
 * the whole 30-minute window "unseen" again and delivered the same letters once more —
 * three deliveries of one probe, three sessions per letter (reported by the addressee on
 * 2026-11-01). Delivery must survive a restart by itself, not by luck of timing.
 */
export const WATCH_SEEN_PATH = path.join(os.homedir(), '.dsh', 'project-graph', 'exchange-watch-seen.json');

/** Read the delivered-memory file; a broken file simply means "nothing delivered yet". */
export function readSeenMemory(file = WATCH_SEEN_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const map = new Map();
    for (const [key, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (Number.isFinite(Number(value))) map.set(key, Number(value));
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Persist the delivered-memory file; a failure must never stop the watcher. */
export function writeSeenMemory(map, file = WATCH_SEEN_PATH) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = {};
    for (const [key, value] of map) rows[key] = value;
    fs.writeFileSync(file, JSON.stringify(rows, null, 1) + '\n', 'utf8');
  } catch {
    /* memory of delivery is important, but never at the cost of a crash */
  }
}

/**
 * File where the watcher remembers the letters it has already delivered.
 *
 * It sits in the same store as the run records, so a test or a profile that points
 * the store elsewhere never reads the memory of the live host.
 */
export function seenPath(runtime) {
  return path.join(storeDir(runtime), 'exchange-seen.json');
}

/**
 * Журнал решений по каждому письму (задание 0048).
 *
 * `exchange-seen.json` остаётся памятью ВРУЧЕНИЙ, а причины «письмо осталось в
 * ящике» пишутся сюда: одна JSON-строка на письмо и решение, только дописывание.
 * Без этого журнала тишина неотличима от «письма не видел».
 */
export function decisionsPath(runtime) {
  return path.join(storeDir(runtime), 'exchange-decisions.jsonl');
}

/** Write one telemetry line (last state wins); a failure must never break the watcher. */
export function writeTelemetry(event) {
  try {
    fs.mkdirSync(path.dirname(WATCH_TELEMETRY_PATH), { recursive: true });
    /*
     * Append, do not overwrite: an overwritten file shows only the last event, which is
     * why a started-then-hung watcher looked like a watcher that never started. Each line
     * is one event with its time, and the file is capped so it cannot grow forever.
     */
    fs.appendFileSync(WATCH_TELEMETRY_PATH, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', 'utf8');
    try {
      const stat = fs.statSync(WATCH_TELEMETRY_PATH);
      if (stat.size > 200 * 1024) {
        const lines = fs.readFileSync(WATCH_TELEMETRY_PATH, 'utf8').trim().split('\n');
        fs.writeFileSync(WATCH_TELEMETRY_PATH, lines.slice(-400).join('\n') + '\n', 'utf8');
      }
    } catch {
      /* trimming is optional */
    }
  } catch {
    /* telemetry is a courtesy, not a contract */
  }
}

/**
 * Statuses that need a reader. An ack or a note needs none.
 *
 * Every wake that cannot reach a live session starts a real agent run, so waking a
 * workspace for "принято" burns a run and, worse, fills the parent's child limit:
 * eight such children made a scheduled critic run start with no model call at all.
 */
/*
 * An ack closes an agreement, so it must reach the addressee: a silent ack means the
 * person watching never learns the loop closed (workflow's --64 sat in the box unseen).
 * It never breeds a letter — the wake text says to read an ack and write nothing.
 */
const WAKE_STATUSES = new Set(['request', 'question', 'report', 'answer', 'ack', 'proposal', 'agreed', 'rejected', 'invitation', 'declined']);

/** One spawned wake per addressee in this window; a burst must not become a storm. */
const SPAWN_COOLDOWN_MS = 90 * 1000;

/**
 * How long one pass may take before the next pass is allowed to start anyway.
 *
 * A pass that awaits a stuck delivery (a send that never settles, a host call that
 * hangs) must not stop the box: the live host showed exactly that — the last delivery
 * record was 14:11:55 while letters kept arriving until 14:35.
 */
const STUCK_AFTER_MS = 60 * 1000;

/** A single delivery may not block the pass longer than this. */
const DELIVERY_TIMEOUT_MS = 20 * 1000;

/**
 * How many letters one wake may carry.
 *
 * workflow's --65: a catch-up after a long sleep delivered 52 letters in one message, a
 * wall of old probes instead of a signal. The rest waits for the next pass.
 */
const MAX_WAKE_ITEMS = 5;

/**
 * How far back the first pass after start looks for what the host missed.
 *
 * A restart catches up on the hours the host slept, it does not replay the history of the
 * channel: on 2026-11-02 an unbounded catch-up delivered 49 letters, some of them install
 * notes from four days earlier.
 */
const CATCH_UP_MS = 24 * 60 * 60 * 1000;

/** Resolve after `ms`, or reject with a readable reason. */
function withTimeout(promise, ms, what) {
  let timer = null;
  /*
   * The timer must NOT be unref'd: with only an unref'd timer left the process may end
   * instead of firing it, and the wait would never settle (found by the hang test).
   */
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(what + ': нет ответа за ' + Math.round(ms / 1000) + ' с')), ms);
  });
  return Promise.race([Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }), guard]);
}

/** Fields of a message this module needs; everything else stays in the file. */
function headerFields(text) {
  const header = {};
  for (const line of String(text || '').split(/\r?\n/u)) {
    if (!line.trim()) break;
    const match = /^([A-Za-z][A-Za-z-]*):\s*(.+?)\s*$/u.exec(line);
    if (match) header[match[1]] = match[2];
  }
  return header;
}

/**
 * One message of the box: header plus where it lies.
 *
 * @returns null when the file is not a message (README, schema, a torn write).
 */
export function parseMessage(text, file) {
  const parsed = parseHeader(text);
  if (!parsed) return null;
  const extra = headerFields(text);
  return {
    from: parsed.from,
    to: parsed.to,
    at: parsed.at,
    date: parsed.date,
    thread: parsed.thread,
    status: parsed.status,
    subject: (extra.Subject || '').trim(),
    /* The ack chain lives in these two fields: what this letter answers. */
    ref: (extra.Ref || extra['Reply-To'] || '').trim(),
    /*
     * Who wrote it, when the letter says so. The box has no other way to tell the
     * addressee from a stranger answering in its name (workflow, --46).
     */
    /*
     * One shape for the author identity (workflow --61 п.5): a bare uuid is the same
     * session as session-<uuid>, and both spellings appeared in the channel.
     */
    session: normalizeSession((extra.Session || '').trim()),
    file,
  };
}

/**
 * Normalize a Session header to `session-<uuid>`.
 *
 * @returns the normalized id, or an empty string when the letter carries none.
 */
export function normalizeSession(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (/^session-/iu.test(text)) return 'session-' + text.slice('session-'.length).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text)
    ? 'session-' + text
    : text;
}

/** Every message file under the exchange folders, newest write first. */
export function messageFiles(dirs) {
  const found = [];
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    for (const root of [path.join(dir, 'threads'), dir]) {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      if (!entries.length) continue;
      const walk = (current, depth) => {
        let list = [];
        try {
          list = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of list) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (depth < 3) walk(full, depth + 1);
            continue;
          }
          if (!entry.isFile() || !/\.md$/iu.test(entry.name)) continue;
          let stat;
          try {
            stat = fs.statSync(full);
          } catch {
            continue;
          }
          found.push({ file: full, mtimeMs: stat.mtimeMs, base: path.basename(dir) });
        }
      };
      walk(root, 0);
      /* The same file must not be listed twice when `threads` is the folder itself. */
      if (root !== dir) break;
    }
  }
  const unique = new Map();
  for (const item of found) unique.set(item.file, item);
  return [...unique.values()].sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/**
 * Labels of the channel mapped onto workspace roots.
 *
 * Order: explicit `participants` config, then `exchangeLabels`, then the
 * `- <label>: \`<path>\`` list the panel writes into `docs/exchange.md`, then the
 * "Кто есть кто" table of the channel README, then the folder name itself.
 */
/**
 * Workspaces declared by the structure itself: any FOLDER with `participants`.
 *
 * The customer's rule is that the exchange happens between the workspaces NAMED IN
 * THE GRAPH, not between whatever labels happen to sit in the profile. So the graph is
 * the source of truth: a folder carries the participant paths, and only those
 * workspaces take part. A path inside a workspace (a package folder) resolves to its
 * workspace. Folders are places of exchange, not nodes: reading them from `graph.folders`
 * is what keeps a folder out of the node list (task 0011).
 *
 * @returns allowed roots, in declaration order; empty when the structure declares none.
 */
export function declaredExchangeWorkspaces(runtime, allowedRoots) {
  const allowed = Array.isArray(allowedRoots) ? allowedRoots.filter((root) => typeof root === 'string' && root.trim()) : [];
  const declared = [];
  const labels = runtime && runtime.participants && typeof runtime.participants === 'object'
    ? runtime.participants
    : {};
  const push = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    /*
     * A participant may be named by LABEL (portable: the same node works in any
     * workspace) or by absolute path (legacy). The label resolves through the profile
     * map, so the graph does not have to carry machine-specific paths.
     */
    const named = labels[value.trim()];
    const resolved = typeof named === 'string' && named.trim() ? named.trim() : value;
    const match = allowed.find((root) => normalizePath(root) === normalizePath(resolved))
      || allowed
        .filter((root) => isInsideRoot(resolved, root))
        .sort((left, right) => normalizePath(right).length - normalizePath(left).length)[0];
    if (match && !declared.includes(match)) declared.push(match);
  };
  for (const root of allowed) {
    let payload;
    try {
      payload = readGraph(runtime, root);
    } catch {
      continue;
    }
    const folders = payload && payload.graph && Array.isArray(payload.graph.folders) ? payload.graph.folders : [];
    for (const folder of folders) {
      if (!folder || !Array.isArray(folder.participants)) continue;
      for (const item of folder.participants) push(item);
    }
  }
  return declared;
}

/** The deepest directory that contains every given root. */
export function commonParent(roots) {
  const list = Array.isArray(roots) ? roots.filter((root) => typeof root === 'string' && root.trim()) : [];
  if (!list.length) return '';
  let common = path.resolve(list[0]);
  for (const root of list.slice(1)) {
    const other = path.resolve(root);
    for (;;) {
      if (normalizePath(other) === normalizePath(common) || isInsideRoot(other, common)) break;
      const parent = path.dirname(common);
      if (parent === common) break;
      common = parent;
    }
  }
  return common;
}

/**
 * The box of ONE declared folder, resolved to an absolute directory.
 *
 * Shared by {@link declaredExchangeBoxes} and {@link readExchangeFolders}: the
 * panel must name the same directory the watcher reads, and a per-folder portal
 * needs the failure of ITS folder instead of the first error of the list.
 *
 * @returns `{ dir }` when the box resolves, `{ error }` when the declaration is
 *   invalid (the message names the folder and the recipe), `{ missing: true }`
 *   when the folder carries no box at all.
 */
export function resolveFolderBox(folder, root, resolved) {
  const box = folder && folder.box;
  if (!box || typeof box !== 'object' || typeof box.path !== 'string' || !box.path.trim()) return { missing: true };
  const relative = box.path.trim();
  /*
   * The box path is portable, so it is RELATIVE and stays inside its root
   * (workflow --61 п.2): an absolute path or ".." would let a shared box land
   * anywhere on the machine.
   */
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) {
    return { error: 'у папки «' + folder.id + '» box.path должен быть относительным и без «..»: ' + relative };
  }
  let base;
  if (box.root === 'workspace') {
    base = path.resolve(root);
  } else {
    /*
     * A shared box needs at least two exits. With one resolved workspace the common
     * parent is that workspace itself, so the "shared" folder would silently land
     * INSIDE one set - exactly the case the customer called absurd. Say it, do not
     * resolve it.
     */
    if (resolved.length < 2) {
      return { error: 'у папки «' + folder.id + '» box.root: shared требует минимум двух участников в roots, '
        + 'найден ' + resolved.length + ': иначе общий ящик окажется внутри одного воркспейса' };
    }
    const shared = commonParent(resolved);
    /*
     * Participants on different drives have no common ancestor: that is a
     * configuration error with both paths named, not a silent fallback to one
     * workspace (workflow --61 п.1).
     */
    const inside = resolved
      .every((item) => normalizePath(item) === normalizePath(shared) || isInsideRoot(item, shared));
    if (!shared || !inside) {
      return { error: 'у папки «' + folder.id + '» box.root: shared, но у участников нет общего каталога: '
        + resolved.join(', ') + ' — укажите box.root: workspace' };
    }
    base = shared;
  }
  return { dir: path.resolve(base, relative) };
}

/**
 * The exchange box as the STRUCTURE declares it, resolved to a real directory.
 *
 * The customer's requirement is that the box does not depend on one workspace: the
 * folder carries a relative path and a root mode, and every workspace that declares the
 * same folder resolves it to the same directory. Folders are read from `graph.folders`,
 * never from `graph.nodes`: a folder is a portal, not an agent (task 0011).
 *
 * - `root: "shared"` (default) — relative to the deepest common parent of the declared
 *   participants, so `coordination` means the folder beside both workspaces;
 * - `root: "workspace"` — relative to the declaring workspace, for a box that belongs to
 *   that workspace alone.
 *
 * @returns absolute box directories, in declaration order, without duplicates.
 */
export function declaredExchangeBoxes(runtime, allowedRoots) {
  const allowed = Array.isArray(allowedRoots) ? allowedRoots.filter((root) => typeof root === 'string' && root.trim()) : [];
  const dirs = [];
  const errors = [];
  /* The participant scope is the same for every folder of a pass: compute it once. */
  const scope = declaredExchangeWorkspaces(runtime, allowed);
  const resolvedScope = scope.length > 0 ? scope : allowed;
  for (const root of allowed) {
    let payload;
    try {
      payload = readGraph(runtime, root);
    } catch {
      continue;
    }
    const folders = payload && payload.graph && Array.isArray(payload.graph.folders) ? payload.graph.folders : [];
    for (const folder of folders) {
      const resolved = resolveFolderBox(folder, root, resolvedScope);
      /* A folder without a box is a graph error, reported there; this list only names real boxes. */
      if (resolved.missing) continue;
      if (resolved.error) {
        errors.push(resolved.error);
        continue;
      }
      if (!dirs.includes(resolved.dir)) dirs.push(resolved.dir);
    }
  }
  return { dirs, errors };
}

/** Bytes of a message file that may hold its header: the body is never read. */
const HEADER_BYTES = 8192;

/**
 * Read only the header block of a message file.
 *
 * Counters must not turn the panel into a reader of correspondence: a bounded
 * slice is enough for the `From/To/Date` fields, and the body never enters memory.
 *
 * @returns header text, or null when the file cannot be opened.
 */
function readHeaderSlice(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Labels of the participants a folder declares: labels stay, absolute paths become labels. */
function folderParticipantLabels(list, participants) {
  const source = Array.isArray(list) ? list : [];
  const labels = participants && typeof participants === 'object' ? Object.entries(participants) : [];
  const result = [];
  for (const item of source) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const value = item.trim();
    if (!path.isAbsolute(value)) {
      if (!result.includes(value)) result.push(value);
      continue;
    }
    const match = labels.find(([, target]) => typeof target === 'string' && normalizePath(target) === normalizePath(value));
    const label = match ? match[0] : path.basename(value);
    if (!result.includes(label)) result.push(label);
  }
  return result;
}

/**
 * The label of THIS workspace inside one folder: declared `me`, the profile map,
 * then the folder's own participant whose path (or name) is this workspace.
 * Without a label the direction of a letter stays unknown, and the counters say 0.
 */
function folderSelfLabel(root, folder, participants, runtime) {
  const declared = runtime && typeof runtime.me === 'string' && runtime.me.trim() ? runtime.me.trim() : null;
  if (declared) return declared;
  const mapped = currentLabel(root, participants);
  if (mapped) return mapped;
  const base = path.basename(root);
  for (const item of Array.isArray(folder && folder.participants) ? folder.participants : []) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const value = item.trim();
    if (path.isAbsolute(value)) {
      if (normalizePath(value) === normalizePath(root)) return folderParticipantLabels([value], participants)[0] || base;
      continue;
    }
    if (value.toLowerCase() === base.toLowerCase()) return value;
  }
  return null;
}

/**
 * One of the three folder states of docs/exchange-format.md §8, in words the JSON
 * contract uses: `draft` — обмена ещё не было; `portal` — у канала две стороны;
 * `archive` — стороны сведены к одной, а переписка осталась.
 */
function folderStateOf(folder, total, hasContract, participantCount) {
  if (folder && folder.exchange === false) return 'draft';
  /*
   * Портал — только при контракте в ящике (docs/exchange-format.md §8): папка с
   * двумя участниками, но без контракта остаётся черновиком. Без контракта не
   * бывает ни портала, ни архива: обмена ещё не было.
   */
  if (!hasContract) return 'draft';
  if (participantCount >= 2) return 'portal';
  /* Контракт был, участников свели к одному — архив: данные читаются, доставки нет. */
  return 'archive';
}

/**
 * Facts of every exchange folder the structure declares: one element per folder.
 *
 * The panel draws a portal per element, so a broken folder must never hide the
 * healthy ones: an unresolved box or an unreadable directory becomes an element
 * with `error` and state `draft` instead of an exception for the whole response.
 * Counters are taken from message headers only — letter bodies are never read.
 *
 * @returns `[{ id, box, participants, state, outgoing, incoming, lastIncoming?, lastOutgoing?, error? }]`
 *   in declaration order; an empty list when the structure declares no folders.
 */
export function readExchangeFolders(runtime, root) {
  const resolvedRoot = path.resolve(String(root));
  let payload;
  try {
    payload = readGraph(runtime, resolvedRoot);
  } catch {
    return [];
  }
  const folders = payload && payload.graph && Array.isArray(payload.graph.folders) ? payload.graph.folders : [];
  if (folders.length === 0) return [];
  const allowed = runtime && typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [resolvedRoot];
  const scope = declaredExchangeWorkspaces(runtime, allowed);
  const resolvedScope = scope.length > 0 ? scope : allowed;
  const participants = runtime && runtime.participants && typeof runtime.participants === 'object' ? runtime.participants : {};
  const result = [];
  for (const folder of folders) {
    const id = folder && typeof folder.id === 'string' ? folder.id : '';
    const record = {
      id,
      box: null,
      participants: folderParticipantLabels(folder && folder.participants, participants),
      state: 'draft',
      /* Признак контракта — в ответе всегда: панель не должна угадывать состояние. */
      contract: false,
      /* Ревизия контракта: квитанция ссылается на неё, поэтому она видна в ответе. */
      contractRev: 0,
      /* Метка инициатора контракта: accepted по определению (задание 0048). */
      initiator: '',
      /* Состояние каждого участника (docs/exchange-format.md §8): по шапкам писем. */
      states: {},
      outgoing: 0,
      incoming: 0,
    };
    for (const label of record.participants) record.states[label] = 'invited';
    const box = resolveFolderBox(folder, resolvedRoot, resolvedScope);
    if (box.missing) {
      record.error = 'у папки «' + id + '» не объявлен box: где лежит ящик обмена';
      result.push(record);
      continue;
    }
    if (box.error) {
      record.error = box.error;
      result.push(record);
      continue;
    }
    record.box = box.dir;
    let files;
    try {
      /* readdir is the accessibility probe: EACCES/ENOENT names THIS folder, not the response. */
      fs.readdirSync(box.dir);
      files = messageFiles([box.dir]);
    } catch {
      record.error = 'папка обмена недоступна: ' + box.dir;
      result.push(record);
      continue;
    }
    const me = folderSelfLabel(resolvedRoot, folder, participants, runtime);
    /*
     * Контракт — файл в корне ящика. Имя берётся из exchange.contract, по
     * умолчанию contract.md: структура без поля всё равно несёт контракт.
     * Второе штатное имя — exchange.contract (задание 0048): ящик, у которого
     * контракт назван иначе, не должен выглядеть черновиком.
     */
    const declaredContract = folder && folder.exchange && typeof folder.exchange === 'object'
      && typeof folder.exchange.contract === 'string'
      ? folder.exchange.contract.trim()
      : '';
    const contractNames = [];
    for (const name of [declaredContract, 'contract.md', 'exchange.contract']) {
      if (name && !contractNames.includes(name)) contractNames.push(name);
    }
    let hasContract = false;
    let contractText = '';
    for (const name of contractNames) {
      try {
        if (!fs.statSync(path.join(box.dir, name)).isFile()) continue;
        contractText = fs.readFileSync(path.join(box.dir, name), 'utf8');
        hasContract = true;
        break;
      } catch {
        /* следующий кандидат: контракт может называться иначе */
      }
    }
    record.contract = hasContract;
    /*
     * Метка инициатора: он приглашает, а не принимает, поэтому квитанции от него
     * не требуют — и gate не должен держать его собственные письма в ящике.
     */
    const contractInitiator = (() => {
      const match = /^Initiator:[ \t]*(.+?)[ \t]*$/im.exec(contractText);
      return match ? match[1].replace(/`/gu, '').trim() : '';
    })();
    record.initiator = contractInitiator || '';
    if (hasContract) {
      const revMatch = /^Rev:[ \t]*(\d+)[ \t]*$/im.exec(contractText);
      const rev = revMatch ? Number.parseInt(revMatch[1], 10) : 0;
      record.contractRev = Number.isInteger(rev) && rev > 0 ? rev : 0;
    }
    let total = 0;
    /* Последняя квитанция автора: accepted включает обмен, disconnected его гасит. */
    const receipts = new Map();
    for (const entry of files) {
      /* messageFiles returns { file, mtimeMs, base }: the path is its `file` field. */
      const text = readHeaderSlice(entry.file);
      if (text === null) continue;
      const parsed = parseHeader(text);
      if (!parsed) continue;
      total += 1;
      /*
       * Состояние участника читается по шапке, тело письма не читается никогда:
       * Status: accepted — квитанция, Status: disconnected — отключение. Автор
       * квитанции в поле From, поэтому чужое письмо состояние не меняет.
       */
      const status = String(parsed.status || '').trim().toLowerCase();
      if (status === 'accepted' || status === 'disconnected') {
        const author = String(parsed.from || '').trim().toLowerCase();
        const previous = receipts.get(author);
        /*
         * Date в шапке — минута, а квитанция и отключение бывают в одну минуту.
         * Тогда решает время записи файла: более позднее письмо и есть последнее.
         */
        const at = Number.isFinite(parsed.at) ? parsed.at : 0;
        const mtime = Number(entry.mtimeMs) || 0;
        if (!previous || at > previous.at || (at === previous.at && mtime > previous.mtime)) {
          receipts.set(author, { status, at, mtime });
        }
      }
      if (!me) continue;
      const self = me.toLowerCase();
      const from = String(parsed.from).toLowerCase();
      const to = String(parsed.to).toLowerCase();
      if (from === self) {
        if (to === self) continue;
        record.outgoing += 1;
        if (!record.lastOutgoing || parsed.at > record.lastOutgoing) record.lastOutgoing = parsed.at;
      } else if (to === self) {
        record.incoming += 1;
        if (!record.lastIncoming || parsed.at > record.lastIncoming) record.lastIncoming = parsed.at;
      }
    }
    /*
     * Нет квитанции — invited; есть accepted — accepted; disconnected после неё —
     * disconnected. Инициатор папки — accepted ПО ОПРЕДЕЛЕНИЮ (задание 0049): он
     * приглашает, а не принимает, поэтому собственной квитанции у него нет. Его
     * состояние одинаково для любого читателя — и в копии папки, прочитанной
     * приглашённой стороной: читатель не является квитанцией инициатора. Явный
     * disconnected инициатора сильнее определения: он действительно ушёл.
     */
    for (const label of Object.keys(record.states)) {
      const entry = receipts.get(label.toLowerCase());
      if (entry) {
        record.states[label] = entry.status === 'disconnected' ? 'disconnected' : 'accepted';
        continue;
      }
      if (contractInitiator && label.toLowerCase() === contractInitiator.toLowerCase()) {
        record.states[label] = 'accepted';
      }
    }
    record.state = folderStateOf(folder, total, hasContract, record.participants.length);
    result.push(record);
  }
  return result;
}

/**
 * Состояния участников по ящикам: путь ящика -> { метка: invited|accepted|disconnected }.
 *
 * Папку объявляет структура любого разрешённого корня, поэтому карта собирается из
 * всех: сторож доставляет письмо по тому же ящику, состояние которого видит панель.
 */
function acceptanceByBox(runtime, roots) {
  /* Ящик -> { состояния сторон, метки инициатора }: инициатор не ждёт квитанции. */
  const result = new Map();
  const list = Array.isArray(roots) ? roots : [];
  for (const root of list) {
    let records;
    try {
      records = readExchangeFolders(runtime, root);
    } catch {
      continue;
    }
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || !record.box || !record.states || typeof record.states !== 'object') continue;
      const key = normalizePath(record.box);
      if (!result.has(key)) result.set(key, { states: new Map(), initiators: new Set() });
      const entry = result.get(key);
      for (const [label, state] of Object.entries(record.states)) {
        const name = String(label).trim().toLowerCase();
        if (name && !entry.states.has(name)) entry.states.set(name, state);
      }
      const initiator = String(record.initiator || '').trim().toLowerCase();
      if (initiator) entry.initiators.add(initiator);
    }
  }
  return result;
}

/**
 * Препятствие доставке в сессию: пустая строка — адресат не участник этого ящика
 * или уже принял папку; иначе invited/disconnected — письмо остаётся в ящике.
 *
 * Сторону узнаём по объявленной метке (карта метка -> корень) и по имени каталога
 * воркспейса: без этого квитанция не включает доставку.
 */
function acceptanceGate(statesByBox, boxDir, target, rootsByLabel) {
  if (!(statesByBox instanceof Map) || !boxDir || !target) return '';
  const entry = statesByBox.get(normalizePath(boxDir));
  if (!entry) return '';
  /* Совместимость: раньше карта хранила только состояния сторон. */
  const states = entry.states instanceof Map ? entry.states : entry;
  const initiators = entry.initiators instanceof Set ? entry.initiators : new Set();
  const key = normalizePath(target);
  const base = path.basename(key).toLowerCase();
  /*
   * Инициатор папки — accepted по определению (задание 0048): он приглашает, а не
   * принимает. Его метка не может держать письмо в ящике, даже если контракт
   * прочитан из ящика приглашённой стороны.
   */
  for (const initiator of initiators) {
    const mapped = rootsByLabel instanceof Map ? rootsByLabel.get(initiator) : null;
    if ((mapped && normalizePath(mapped) === key) || initiator === base) return '';
  }
  for (const [label, state] of states) {
    const mapped = rootsByLabel instanceof Map ? rootsByLabel.get(label) : null;
    const belongs = Boolean((mapped && normalizePath(mapped) === key) || label === base);
    if (!belongs) continue;
    /* Принял — доставка разрешена; ищем дальше, вдруг эта же сторона объявлена ещё раз. */
    if (state === 'accepted') continue;
    /* Квитанции нет или сторона отключилась: письмо ждёт в ящике. */
    return state === 'disconnected' ? 'disconnected' : 'invited';
  }
  return '';
}

/**
 * The next free letter number of one author inside a thread (workflow --61 п.3).
 *
 * A duplicate number must be an error, never an overwrite: the box has repeated numbers
 * already, so the writer asks for max+1 instead of guessing.
 *
 * @returns two-digit number, at least "01".
 */
export function nextLetterNumber(threadDir, from) {
  const author = typeof from === 'string' ? from.trim() : '';
  let highest = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(threadDir);
  } catch {
    return '01';
  }
  for (const name of entries) {
    if (!/\.md$/iu.test(name)) continue;
    const match = name.match(/--([A-Za-z0-9_-]+)--(\d{2,})\.md$/u);
    if (!match || match[1] !== author) continue;
    highest = Math.max(highest, Number(match[2]));
  }
  return String(highest + 1).padStart(2, '0');
}

/**
 * Actual working directory of one session, as the host recorded it.
 *
 * The record must carry the FACT, not our request: workflow's --52 is right that a field
 * repeating the addressee lets acceptance pass without evidence. The host writes the real
 * value into its session cache, so the watcher reads it after the start.
 *
 * @returns the path, or null when the host has not written it yet.
 */
export function readSessionCwd(sessionId, options = {}) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return null;
  const dir = options.sessionCacheDir
    || path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
  const file = path.join(dir, id + '.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = doc && doc.record && doc.record.rows ? doc.record.rows : {};
    const working = rows.workingDirectory && rows.workingDirectory.val;
    const value = working && typeof working === 'object' ? working.path || working.cwd : working;
    if (typeof value === 'string' && value.trim()) return value.trim();
  } catch {
    /* not written yet, or an unexpected shape */
  }
  return null;
}

/** Label of one workspace: the exchange spec next to it, then the config, then its name. */
export function participantLabel(root, participants, exchange) {
  const dirs = exchangeDirs(root, exchange);
  for (const dir of dirs) {
    for (const candidate of [path.join(root, 'docs', 'exchange.md'), path.join(dir, 'participants.md')]) {
      let text = '';
      try {
        text = fs.readFileSync(candidate, 'utf8');
      } catch {
        continue;
      }
      for (const match of text.matchAll(/^-\s+([^:\n]+):\s+`([^`]+)`/gmu)) {
        if (normalizePath(match[2].trim()) === normalizePath(root)) return match[1].trim();
      }
    }
  }
  const configured = participants && typeof participants === 'object' ? Object.entries(participants) : [];
  for (const [label, value] of configured) {
    if (typeof value === 'string' && normalizePath(value) === normalizePath(root)) return label;
  }
  return path.basename(root);
}

export function labelRoots(roots, options = {}) {
  const result = new Map();
  const list = Array.isArray(roots) ? roots.filter((root) => typeof root === 'string' && root.trim()) : [];
  const add = (label, root) => {
    const name = typeof label === 'string' ? label.trim() : '';
    if (!name || !root) return;
    /*
     * A side is often declared by its package folder, not by the workspace root:
     * the channel README points `workflow` at `…/default-workspace/subagent-workflow-v2`.
     * The addressee is the workspace that CONTAINS that folder, otherwise the label
     * silently maps to nothing and nobody is woken.
     */
    const target = list.find((item) => normalizePath(item) === normalizePath(root))
      || list
        .filter((item) => isInsideRoot(root, item))
        .sort((left, right) => normalizePath(right).length - normalizePath(left).length)[0];
    if (!target) return;
    if (!result.has(name)) result.set(name, target);
    const lower = name.toLowerCase();
    if (!result.has(lower)) result.set(lower, target);
  };
  const participants = options.participants && typeof options.participants === 'object' ? options.participants : {};
  for (const [label, value] of Object.entries(participants)) add(label, value);
  const extra = options.exchangeLabels && typeof options.exchangeLabels === 'object' ? options.exchangeLabels : {};
  for (const [label, value] of Object.entries(extra)) {
    const match = list.find((item) => normalizePath(item) === normalizePath(value))
      || list.find((item) => path.basename(item).toLowerCase() === String(value).toLowerCase());
    if (match) add(label, match);
  }
  for (const root of list) {
    try {
      const text = fs.readFileSync(path.join(root, 'docs', 'exchange.md'), 'utf8');
      for (const match of text.matchAll(/^-\s+([^:\n]+):\s+`([^`]+)`/gmu)) add(match[1].trim(), match[2].trim());
    } catch {
      /* no spec in this workspace: the next source decides */
    }
  }
  for (const root of list) {
    const dirs = exchangeDirs(root, options.exchange);
    for (const dir of dirs) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
      } catch {
        continue;
      }
      for (const match of text.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gmu)) add(match[1].trim(), match[2].trim());
    }
  }
  for (const root of list) add(path.basename(root), root);
  return result;
}

/** Addressee labels of one message: `To: a`, `To: a, b` and `To: a; b` all work. */
export function addresseeLabels(to) {
  return String(to || '')
    .split(/[,;]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Fill the ack slot of the run that delivered the letter this ack refers to.
 *
 * The schema asks for "`ack`: the ack file or null"; without this the slot stayed null
 * even when the addressee had answered. A mismatch is not an error: an ack for a letter
 * delivered by another process is simply not ours to record.
 *
 * @returns the updated record, or null when nothing matched.
 */
export function markAck(roots, runtime, message, ackRelative) {
  const ref = String(message && message.ref ? message.ref : '').trim();
  if (!ref) return null;
  const wanted = ref.split('\\').join('/').replace(/^\.\//u, '');
  for (const root of Array.isArray(roots) ? roots : []) {
    let rows = [];
    try {
      rows = listRuns(runtime, root);
    } catch {
      continue;
    }
    for (const row of rows) {
      if (!row || !row.delivered) continue;
      const delivered = String(row.delivered).split('\\').join('/').replace(/^\.\//u, '');
      if (delivered !== wanted) continue;
      if (row.ack) return row;
      /*
       * Who answered, and whether that is the session the letter was woken for.
       * Until this existed the slot said "answered" for a file written by anyone
       * replying to the letter: the delivery of --24 was acked 63 seconds after the
       * spawn by a different wake session of the same side (workflow, --46). The box
       * names the author only when the letter carries a `Session:` header, so an absent
       * `ackBy` means "unknown", not "the addressee".
       */
      const bySession = typeof message.session === 'string' ? message.session.trim() : '';
      const addressee = row.wake && row.wake.target ? String(row.wake.target) : '';
      const updated = {
        ...row,
        ack: ackRelative,
        ackAt: new Date().toISOString(),
        ...(bySession ? { ackBy: bySession, ackByAddressee: bySession === addressee } : {}),
      };
      try {
        noteRun(runtime, updated);
      } catch {
        return null;
      }
      return updated;
    }
  }
  return null;
}

/**
 * The last active session among the live agents inside one root.
 *
 * Freshness is the journal mtime of the session (the customer's rule), so a session
 * created earlier but written to a second ago wins over a newer, idle one.
 *
 * @returns `{ agent, activityAt }` or null when no live agent is inside the root.
 */
export function pickLastActive(agents, root, activity, options = {}) {
  const list = Array.isArray(agents) ? agents : [];
  const byId = activity instanceof Map ? activity : new Map(Object.entries(activity || {}));
  const binding = typeof options.binding === 'string' && options.binding.trim() ? options.binding.trim() : '';
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 24 * 60 * 60 * 1000;
  const sessionOf = (agent) => String((agent && (agent.sessionId || agent.session || agent.id)) || '');
  /*
   * Two ways to belong to a workspace: the agent's cwd is inside it, or its session is
   * one of that workspace's sessions in the journal. The second one matters: the host
   * often reports a live agent without a cwd, and matching only by cwd made every such
   * agent invisible — the wake then spawned a second agent instead of reaching the one
   * that is already open.
   */
  const inside = list.filter((agent) => agent && (isInsideRoot(agent.cwd, root) || byId.has(sessionOf(agent))));
  if (inside.length === 0) return null;
  const atOf = (agent) => {
    const id = sessionOf(agent);
    const value = byId.get(id);
    return Number.isFinite(value) ? value : 0;
  };
  if (binding) {
    const bound = inside.find((agent) => sessionOf(agent) === binding);
    /* A stale binding must not swallow the message: the customer's rule says so. */
    if (bound && now - atOf(bound) <= ttlMs) return { agent: bound, activityAt: atOf(bound) || null, reason: 'binding' };
  }
  const sorted = [...inside].sort((left, right) => atOf(right) - atOf(left));
  const agent = sorted[0];
  return { agent, activityAt: atOf(agent) || null, reason: 'last-active' };
}

/** Journal freshness of every session of one root: session id -> mtime. */
export function activityOf(root, options = {}) {
  const result = new Map();
  let report;
  try {
    report = readSessionActivity(root, options);
  } catch {
    return result;
  }
  for (const item of Array.isArray(report && report.items) ? report.items : []) {
    if (item && item.id) result.set(String(item.id), item.at);
  }
  return result;
}

/**
 * The text a woken session receives: where the files are, whose they are, what to do.
 *
 * Several messages for the same addressee in one pass become ONE wake: five separate
 * wake-ups for five files is noise, not attention.
 */
export function wakeText(input, boxDir) {
  const items = Array.isArray(input) ? input : [{ message: input, boxDir }];
  if (items.length === 0) return '';
  if (items.length === 1) {
    const { message } = items[0];
    const relative = path.relative(items[0].boxDir, message.file).split(path.sep).join('/');
    const subject = message.subject ? '\nТема: ' + message.subject : '';
    /*
     * Приглашение — не письмо переписки, а приглашение подключиться (задание 0020).
     * Пока папка не принята, единственный правильный ответ — join или decline, и
     * сделать это можно только по Box из шапки: путь ящика не выводится из метки.
     */
    if (String(message.status || '').toLowerCase() === 'invitation') {
      return [
        'Приглашение в папку обмена: ' + relative,
        'From: ' + message.from + ' → To: ' + message.to + ', статус invitation',
        'Date: ' + message.date + subject,
        'Файл: ' + message.file.split(path.sep).join('/'),
        'Откройте файл и возьмите из шапки Box: абсолютный путь ящика. Принять папку — action=join',
        '(id папки, box — путь из письма, participants и orchestrator из структуры), отказаться — action=decline.',
        'Квитанция принятия ссылается на контракт (Ref) и несёт Session: <id своей сессии>.',
      ].join('\n');
    }
    return [
      'Новое сообщение в обмене: ' + relative,
      'From: ' + message.from + ' → To: ' + message.to + (message.status ? ', статус ' + message.status : ''),
      'Date: ' + message.date + subject,
      'Файл: ' + message.file.split(path.sep).join('/'),
      'Откройте файл. Если Status: request или question — ответьте ОДНИМ письмом Status: answer в ту же',
      'ветку по Reply-To. Если Status: answer или ack — прочитайте и ничего не пишите:',
      'ответ новых писем не порождает, а подтверждение только закрывает договорённость.',
      'В шапке ответа обязательно указывайте Session: <id своей сессии>; сторону определяют по Session,',
      'а не по подписи From. Не выдавайте себя за другую сторону: подписывайтесь тем воркспейсом,',
      'в чьей папке работаете.',
    ].join('\n');
  }
  const lines = ['Новые сообщения в обмене: ' + items.length];
  for (const item of items) {
    const relative = path.relative(item.boxDir, item.message.file).split(path.sep).join('/');
    lines.push('- ' + relative + ' — From: ' + item.message.from + ' → To: ' + item.message.to
      + (item.message.status ? ', статус ' + item.message.status : '') + ', ' + item.message.date
      + (item.backlog ? ', backlog' : '')
      + (item.message.subject ? ' — ' + item.message.subject : ''));
  }
  for (const item of items) lines.push('Файл: ' + item.message.file.split(path.sep).join('/'));
  lines.push('Откройте файлы. На request/question — по одному письму Status: answer в ту же ветку; '
    + 'на answer и ack — только прочитать, новых писем не писать.');
  lines.push('В каждом ответе указывайте Session: <id своей сессии> — сторону определяют по нему, а не по From.');
  return lines.join('\n');
}

/**
 * Build the watcher. Everything with a side effect is injectable, so the delivery
 * decision is tested without DSH: the clock, the agent service and the timers.
 */
export function createExchangeWatcher(options = {}) {
  const runtime = options.runtime;
  if (!runtime) throw new Error('createExchangeWatcher: нужен runtime панели');
  const getAgents = typeof options.getAgents === 'function' ? options.getAgents : () => null;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const config = options.config && typeof options.config === 'object' ? options.config : {};
  const tickMs = Number.isFinite(options.tickMs) && options.tickMs > 0 ? options.tickMs : EXCHANGE_WATCH_TICK_MS;
  /* The profile may set the window in YAML; an argument wins over the config. */
  const backlogMs = Number.isFinite(options.backlogMs) && options.backlogMs >= 0
    ? options.backlogMs
    : (Number.isFinite(Number(config.exchangeBacklogMs)) && Number(config.exchangeBacklogMs) >= 0
      ? Number(config.exchangeBacklogMs)
      : EXCHANGE_BACKLOG_MS);
  /*
   * The third step of the customer's schema: when the addressee workspace has no live
   * session, the node is STARTED with the message as its prompt and `cwd: root`. Off
   * by default (`wakeSpawn: true` turns it on) because it costs a real agent run.
   */
  /*
   * The profile config does not reach the plugin with every key: the host showed
   * wakeSpawn as disabled while cordis.patch.yml said true, and the box stayed silent
   * for hours. So the default is ON (a sleeping addressee must be woken — that is the
   * whole point), and an explicit false in config, env or the flag file turns it off.
   */
  const flagFromEnv = typeof process !== 'undefined' && process.env && process.env.PG_WAKE_SPAWN !== undefined
    ? String(process.env.PG_WAKE_SPAWN).trim().toLowerCase()
    : '';
  /*
   * A spawned reader signs itself as the side and becomes a twin: workflow's --56 shows
   * --50, --51, --53 and --55 written by children while its own session wrote --52, --54
   * and --56. Twins are off by default; delivery is the box, and the side's own agent
   * reads it. `wakeSpawn: true` brings the reader back for a deliberate experiment.
   */
  const spawnWhenAsleep = config.wakeSpawn === true && flagFromEnv !== '0' && flagFromEnv !== 'false';
  const stuckAfterMs = Number.isFinite(options.stuckAfterMs) && options.stuckAfterMs > 0 ? options.stuckAfterMs : STUCK_AFTER_MS;
  const deliveryTimeoutMs = Number.isFinite(options.deliveryTimeoutMs) && options.deliveryTimeoutMs > 0
    ? options.deliveryTimeoutMs
    : DELIVERY_TIMEOUT_MS;
  const getSubagents = typeof options.getSubagents === 'function' ? options.getSubagents : () => null;
  /* DSH's own sessionController: resolves a session (resuming it when cold) and admits a prompt. */
  const getSessionController = typeof options.getSessionController === 'function'
    ? options.getSessionController
    : () => null;
  const getParent = typeof options.getParent === 'function' ? options.getParent : () => null;
  const providerName = typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : 'spawn';
  const logger = options.logger || { warn() {} };
  /* Injected in tests so freshness is deterministic instead of depending on ~/.dsh. */
  const activityFor = typeof options.activityOf === 'function'
    ? options.activityOf
    : (root, opts) => activityOf(root, opts);

  const seen = new Map();
  /*
   * seen used to live only in this process, so every host restart forgot what had
   * already been delivered; the 30-minute backlog window then made the whole batch
   * fresh again. Live 2026-11-01: one letter was delivered three times (18:14,
   * 18:19, 18:24), each delivery a new session. The map is now backed by a file —
   * file path to its write time — and a restart resumes the same memory.
   */
  const seenFile = typeof options.seenPath === 'string' && options.seenPath.trim()
    ? options.seenPath.trim()
    : null;
  const seenPathOf = () => seenFile || seenPath(runtime);
  let seenLoaded = false;
  let seenDirty = false;
  /*
   * Журнал решений (задание 0048). Идемпотентность держится на ключе
   * (письмо, ветка, сессия): повторный проход не дописывает уже принятое решение,
   * иначе журнал рос бы на каждом тике и перестал быть доказательством.
   */
  const decisionsFile = typeof options.decisionsPath === 'string' && options.decisionsPath.trim()
    ? options.decisionsPath.trim()
    : null;
  const decisionsPathOf = () => decisionsFile || decisionsPath(runtime);
  const decisionSeen = new Set();
  let decisionsLoaded = false;
  function decisionKey(row) {
    if (!row || typeof row !== 'object') return '';
    const letter = String(row.letter || '');
    const branch = String(row.branch || '');
    if (!letter || !branch) return '';
    return letter + '\u0000' + branch + '\u0000' + String(row.session || '');
  }
  function loadDecisions() {
    if (decisionsLoaded) return;
    decisionsLoaded = true;
    let text = '';
    try {
      text = fs.readFileSync(decisionsPathOf(), 'utf8');
    } catch {
      return;
    }
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const key = decisionKey(JSON.parse(line));
        if (key) decisionSeen.add(key);
      } catch {
        /* torn line: the journal is append-only, one bad line must not hide the rest */
      }
    }
  }
  function noteDecision(row) {
    loadDecisions();
    const key = decisionKey(row);
    if (!key || decisionSeen.has(key)) return false;
    decisionSeen.add(key);
    /* Время проекта — МСК: журнал читают люди и приёмка, а не только машина. */
    const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace(/Z$/u, '+03:00');
    const line = JSON.stringify({ at: shifted, ...row }) + '\n';
    try {
      const file = decisionsPathOf();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      /* журнал — доказательство, но не повод уронить проход */
    }
    return true;
  }
  /** file+mtime -> time of the last failed attempt; a wake is retried, not dropped. */
  const retried = new Map();
  /*
   * The watcher's own record. A silent watcher was indistinguishable from a working one:
   * the live host showed no deliveries for half an hour and nothing was written anywhere.
   * One record per run of the watcher, in the same store the panel reads, is the answer.
   */
  let watchSince = 0;
  let passes = 0;
  let lastPassAt = 0;
  let lastError = '';
  /**
   * Zero roots is announced on the transition, not on every pass.
   *
   * `roots: []` in the profile does not always mean zero: allowedRoots() merges the
   * config with the workspace registry, and the count varied between loads (2026-11-01:
   * 7 at 15:44, 0 at 15:58 and 16:01, 7 at 16:05 UTC). At zero the box is not even
   * scanned, so every incoming letter waits in silence and the only trace was a missing
   * delivery. A warning every 30 s would be noise, a warning once per transition is news.
   */
  let zeroRootsWarned = false;
  /** addressee root -> time of the last spawned wake (cooldown). */
  const spawnedAt = new Map();
  /** addressee root -> the last real start error, kept so a cooldown pass cannot hide it. */
  const startErrors = new Map();
  let timer = null;
  let ticking = false;
  let tickStartedAt = 0;
  let stopped = false;

  const warn = (message) => {
    try {
      logger.warn('[dsh-project-graph] ' + message);
    } catch {
      /* logging must never break a tick */
    }
  };

  /** Read the delivered letters of earlier runs; a missing or broken file means empty. */
  function loadSeen() {
    if (seenLoaded) return;
    seenLoaded = true;
    let rows;
    try {
      rows = JSON.parse(fs.readFileSync(seenPathOf(), 'utf8'));
    } catch {
      return;
    }
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return;
    for (const [file, mtime] of Object.entries(rows)) {
      if (typeof mtime === 'number' && Number.isFinite(mtime)) seen.set(file, mtime);
    }
  }

  /** Keep the memory for the next process; a failure must never break a pass. */
  function saveSeen() {
    if (!seenDirty) return;
    seenDirty = false;
    const newest = [...seen.entries()].sort((left, right) => right[1] - left[1]).slice(0, SEEN_LIMIT);
    const file = seenPathOf();
    const temporary = file + '.' + String(process.pid) + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(newest)) + '\n', 'utf8');
      fs.renameSync(temporary, file);
    } catch {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* the memory is a convenience, not a contract */
      }
    }
  }

  const roots = () => {
    try {
      const list = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
      return Array.isArray(list) ? list.filter((root) => typeof root === 'string' && root.trim()) : [];
    } catch {
      return [];
    }
  };

  const boxDirs = (list) => {
    const dirs = [];
    for (const root of list) {
      for (const dir of exchangeDirs(root, runtime.exchange)) {
        if (!dirs.includes(dir)) dirs.push(dir);
      }
    }
    return dirs;
  };

  /** Live agents as the host reports them; a missing service is an empty list. */
  function liveAgents() {
    let service;
    try {
      service = getAgents();
    } catch {
      return [];
    }
    if (!service) return [];
    try {
      const list = typeof service.roots === 'function' ? service.roots() : (typeof service.list === 'function' ? service.list() : []);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /**
   * Start an agent of the addressee workspace with the message as its prompt.
   *
   * This is what "wake" means for a workspace whose session is asleep: a live agent is
   * not there to receive a message, so the message becomes a task and the node is run
   * in the addressee's own folder.
   *
   * @returns `{ childId }` on acceptance; throws with a readable reason otherwise.
   */
  async function spawnAddressee(target, text, sessionId) {
    const subagents = getSubagents();
    if (!subagents || typeof subagents.startActivation !== 'function') {
      throw new Error('служба subagents недоступна — поднять адресата нечем');
    }
    const parent = (() => {
      try {
        return getParent(target);
      } catch {
        return null;
      }
    })();
    if (!parent || !parent.id) {
      throw new Error('нет живого агента-родителя для запуска в этом воркспейсе');
    }
    let maxDepth;
    if (typeof subagents.resolveMaxDepth === 'function') maxDepth = subagents.resolveMaxDepth(undefined);
    /*
     * The host calls `signal.throwIfAborted()` on start-up: without a signal the run
     * dies with "Cannot read properties of undefined (reading 'throwIfAborted')" —
     * exactly what the first live attempt showed. The scheduler has always passed one;
     * the wake must too.
     */
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = controller ? controller.signal : undefined;
    /*
     * `childId` turns the activation into a CONTINUATION of that session (the host
     * resumes it instead of creating a new one). Without it we would give birth to a
     * stranger that merely sits in the addressee's folder and answers in its name —
     * exactly the fake exchange found on 2026-11-01: the "workflow" acks were written by
     * an agent of our own workspace, while their real session never got anything.
     */
    const base = {
      provider: providerName,
      label: 'exchange:' + path.basename(target),
      request: {
        cwd: target,
        prompt: [{ type: 'text', text }],
        parent,
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(signal ? { signal } : {}),
      },
      ...(signal ? { signal } : {}),
      delivery: 'caller',
    };
    let activation;
    let resumed = false;
    try {
      activation = await subagents.startActivation(sessionId ? { ...base, childId: sessionId } : base);
      resumed = Boolean(sessionId);
    } catch (error) {
      /*
       * A top-level session id is not a subagent id: the host answers
       * 'subagent "<id>" already exists' and the letter would loop on the same error
       * (live 2026-11-01, probe --35). Resuming by that id is not supported here, so
       * fall back to a fresh activation of the addressee workspace instead of dropping
       * the letter. The record then says 'spawn', not 'resume' — honestly.
       */
      const text = String((error && error.message) || error);
      if (!sessionId || !/already exists/iu.test(text)) throw error;
      activation = await subagents.startActivation(base);
      resumed = false;
    }
    return {
      childId: activation && activation.childId ? String(activation.childId) : '',
      resumed,
    };
  }

  /**
   * One pass over the box: deliver every message that is new since the last pass.
   *
   * Called both by the watcher's own timer and by the scheduler's beat; the completion
   * telemetry lives here so either caller leaves the same trace (the hook path used to
   * log only "tick", which made a working pass look like a hung one).
   */
  async function tick(atInput) {
    const result = await runPass(atInput);
    return result;
  }

  async function runPass(atInput) {
    loadSeen();
    writeTelemetry({ event: 'tick', passes, seen: seen.size, stopped });
    if (stopped) return [];
    if (ticking) {
      if (Date.now() - tickStartedAt < stuckAfterMs) return [];
      /* The previous pass is wedged: say so and carry on rather than dying quietly. */
      warn('обмен: предыдущий проход висит дольше ' + Math.round(stuckAfterMs / 1000)
        + ' с — начинаю новый, старый будет отброшен по завершении');
    }
    ticking = true;
    tickStartedAt = Date.now();
    const delivered = [];
    let deliveredCount = 0;
    /* Counted here, not in the finally block: `list` lives inside the try. */
    let rootCount = 0;
    try {
      const at = atInput instanceof Date ? atInput : now();
      const list = roots();
      rootCount = list.length;
      if (list.length === 0) {
        /*
         * Say what follows, not what it is called: the box is not scanned, so no letter
         * is delivered. Counting the effective list (after the registry merge) is what
         * makes this line true — `config.roots` alone said 7 while the pass scanned 0.
         */
        if (!zeroRootsWarned) {
          zeroRootsWarned = true;
          warn('корней 0: coordination/threads не сканируется, входящие письма не доставляются; '
            + 'roots задаётся в cordis.patch.yml профиля desktop');
        }
        return [];
      }
      /* Roots are back: the next fall to zero is a new transition and deserves its line. */
      zeroRootsWarned = false;
      const dirs = boxDirs(list);
      /* The structure may declare its own box (portable path), independent of the roots. */
      const declaredBoxes = declaredExchangeBoxes(runtime, list);
      for (const dir of declaredBoxes.dirs) {
        if (!dirs.includes(dir)) dirs.push(dir);
      }
      for (const problem of declaredBoxes.errors) warn('обмен: ' + problem);
      if (dirs.length === 0) return [];
      /*
       * The graph decides who takes part: a node with `participants` lists the
       * workspaces. Without such a node the whole allowed list is used (the old
       * behaviour), so an undeclared project keeps reading its box.
       */
      const declared = declaredExchangeWorkspaces(runtime, list);
      const scope = declared.length > 0 ? declared : list;
      const participants = {};
      for (const root of scope) {
        const label = participantLabel(root, runtime.participants, runtime.exchange);
        if (label) participants[label] = root;
      }
      const labels = labelRoots(scope, {
        participants,
        exchangeLabels: config.exchangeLabels,
        exchange: runtime.exchange,
      });
      /*
       * Приглашение адресуется воркспейсу, который ещё НЕ объявлен участником папки
       * (он же не принял её): в области папки его метки нет, но профиль её знает.
       * Для Status: invitation адресата ищем и по полному списку корней — иначе
       * приглашение молча не дойдёт и подключиться будет некому (задание 0020).
       */
      let outsideLabels = null;
      const outsideTarget = (name) => {
        if (!outsideLabels) {
          outsideLabels = labelRoots(list, {
            participants: runtime.participants && typeof runtime.participants === 'object' ? runtime.participants : {},
            exchangeLabels: config.exchangeLabels,
            exchange: runtime.exchange,
          });
        }
        return outsideLabels.get(String(name).toLowerCase()) || outsideLabels.get(name);
      };
      /* Метка -> корень: по ней состояние участника связывается с адресатом. */
      const rootsByLabel = new Map();
      for (const [name, value] of labels) {
        const lower = String(name).toLowerCase();
        if (!rootsByLabel.has(lower)) rootsByLabel.set(lower, value);
      }
      /* Доставка только принявшим: состояние папок читается по шапкам писем. */
      const acceptance = acceptanceByBox(runtime, list);
      const files = messageFiles(dirs);
      const agents = liveAgents();
      const activityCache = new Map();
      /** Messages with a resolved addressee: delivered after the scan, grouped by session. */
      const plan = [];
      for (const item of files) {
        /*
         * Delivered once is delivered forever (workflow --61 п.4): the key is the file, not
         * its mtime, so an `EDIT <time>:` appended to a delivered letter is a correction,
         * not a new letter, and never wakes anyone twice.
         */
        if (seen.has(item.file)) continue;
        /*
         * A message that found nobody to wake must not be forgotten: the addressee
         * session may appear a minute later. It is retried while its backlog window is
         * open, at most once a minute, and only then written off.
         */
        const tryKey = item.file + '\u0000' + item.mtimeMs;
        const lastTry = retried.get(tryKey);
        if (lastTry !== undefined && at.getTime() - lastTry < RETRY_AFTER_MS) continue;
        retried.set(tryKey, at.getTime());
        /*
         * The window applies to every pass, not only the first one: an old message is old
         * whether the watcher has ticked once or a thousand times. Without this the box
         * flooded on the second tick — every file from the last weeks became "fresh" again
         * and the addressee was woken for the same letter once a minute.
         */
        /*
         * The FIRST pass after start is a catch-up (customer, 2026-11-02): a host that was
         * down for hours must not lose what arrived while it slept. Every unseen letter is
         * delivered once, regardless of the backlog window; later passes keep the window,
         * so an old box is not replayed on every tick.
         */
        /*
         * Only when the memory is already there: an empty memory means a first install, and
         * replaying a box of months of letters would be a flood, not a catch-up.
         *
         * And only within the catch-up window: on 2026-11-02 the first pass after a restart
         * delivered 49 letters, including install notes from four days earlier. History is
         * readable in the box; the wake is for what the host actually missed.
         */
        const catchUpMs = Number.isFinite(options.catchUpMs) && options.catchUpMs > 0
          ? options.catchUpMs
          : CATCH_UP_MS;
        const catchUp = passes === 0 && seen.size > 0 && at.getTime() - item.mtimeMs <= catchUpMs;
        const fresh = catchUp || at.getTime() - item.mtimeMs <= backlogMs;
        if (!fresh) {
          /*
           * Письмо вне окна догона не доставляется, но и не молчит (задание 0048):
           * решение stale:backlog называет возраст письма и окно. Раньше эта ветка
           * просто отбрасывала письмо, и заказчик видел «сообщения перестали ходить».
           */
          const staleBox = dirs.find((dir) => normalizePath(item.file).startsWith(normalizePath(dir)))
            || path.dirname(item.file);
          const staleRelative = path.relative(staleBox, item.file).split(path.sep).join('/');
          const staleHead = readHeaderSlice(item.file);
          const staleMessage = staleHead ? parseHeader(staleHead) : null;
          noteDecision({
            box: staleBox,
            letter: staleRelative,
            to: staleMessage ? String(staleMessage.to || '').trim() : '',
            participant: staleMessage ? String(staleMessage.to || '').trim() : '',
            root: '',
            branch: 'stale:backlog',
            ageMs: Math.max(0, Math.round(at.getTime() - item.mtimeMs)),
            windowMs: backlogMs,
          });
          continue;
        }
        let text;
        try {
          text = fs.readFileSync(item.file, 'utf8');
        } catch {
          continue;
        }
        const message = parseMessage(text, item.file);
        if (!message) continue;
        /*
         * An acknowledgement is a fact, not a task: it starts nobody, but it MUST close
         * the chain — the run record that delivered the letter gets its ack slot filled.
         * Until this existed the schema's "ack: <файл> | null" stayed null forever.
         */
        const status = String(message.status || '').toLowerCase();
        if (status === 'ack' || status === 'answered') {
          const box = dirs.find((dir) => normalizePath(item.file).startsWith(normalizePath(dir)));
          const boxDir = box || path.dirname(item.file);
          markAck(list, runtime, message, path.relative(boxDir, item.file).split(path.sep).join('/'));
          /*
           * The slot is filled, but the acknowledgement ALSO goes to the addressee: a
           * closed agreement that nobody sees is invisible to the person watching
           * (workflow's --64 sat in the box while the loop looked unclosed). The wake
           * text says to read an ack and write nothing, so the chain still ends here.
           */
        }
        if (message.status && !WAKE_STATUSES.has(status)) continue;
        const box = dirs.find((dir) => normalizePath(item.file).startsWith(normalizePath(dir)));
        const boxDir = box || path.dirname(item.file);
        const fromRoot = labels.get(message.from.toLowerCase()) || labels.get(message.from);
        for (const label of addresseeLabels(message.to)) {
          const target = labels.get(label.toLowerCase()) || labels.get(label)
            || (status === 'invitation' ? outsideTarget(label) : undefined);
          /*
           * No own name in the channel: nowhere to deliver, and guessing a workspace is worse.
           * Молчание — тоже ответ: решение no-root называет адресата и путь письма.
           */
          if (!target) {
            noteDecision({
              box: boxDir,
              letter: path.relative(boxDir, item.file).split(path.sep).join('/'),
              to: label,
              participant: label,
              root: '',
              branch: 'no-root',
            });
            continue;
          }
          /* A note to yourself is not a wake: the sender's workspace already knows. */
          if (fromRoot && normalizePath(fromRoot) === normalizePath(target)) continue;
          const activity = activityCache.get(target) || activityFor(target, { now: at.getTime() });
          activityCache.set(target, activity);
          const pick = pickLastActive(agents, target, activity, { now: at.getTime() });
          const since = Date.now();
          const relative = path.relative(boxDir, item.file).split(path.sep).join('/');
          /*
           * Доставка только принявшим: пока квитанции нет, письмо остаётся в ящике.
           * Пусто — адресат не объявлен участником этого ящика или уже принял папку.
           *
           * Приглашение — единственное исключение из гейта 0015 (задание 0020):
           * invited участник ещё не принял папку, и обычное письмо до него не идёт,
           * но приглашение обязано дойти — иначе квитанцию нечем выдать и обмен
           * никогда не начнётся (дедлок гейта).
           */
          const invitation = status === 'invitation';
          const gate = invitation ? '' : acceptanceGate(acceptance, boxDir, target, rootsByLabel);
          /*
           * The record is keyed by root+node+start, so the start must be unique per
           * message: the file's own write time is both unique and honest.
           */
          plan.push({
            label,
            target,
            handle: pick ? pick.agent : null,
            pick,
            boxDir,
            relative,
            message,
            gate,
            mtime: item.mtimeMs,
            since: item.mtimeMs || since,
          });
        }
      }
      /*
       * One wake per session, not per file: the reader must see the whole batch at once.
       * The run record stays one per message, because each message is a separate fact.
       */
      const groups = new Map();
      for (const item of plan) {
        const session = item.handle
          ? String(item.handle.sessionId || item.handle.session || item.handle.id || '')
          : '';
        /*
         * Приглашение — своя группа: гейт квитанции не должен его задержать, а
         * ждущее в ящике обычное письмо того же адресата — не должно проехать
         * вместе с исключением. Иначе одна группа либо теряет приглашение, либо
         * доставляет то, чему ещё рано (задание 0020).
         */
        const invitationItem = String(item.message.status || '').toLowerCase() === 'invitation';
        const key = (session ? 'session:' + session : 'root:' + normalizePath(item.target))
          + (invitationItem ? '|invitation' : '');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      for (const [key, allItems] of groups) {
        /*
         * A pass carries at most MAX_WAKE_ITEMS letters per addressee; the rest stays unseen
         * and goes out on the next pass, so a long sleep cannot produce a wall of text.
         */
        const firstActivity = allItems[0].pick && allItems[0].pick.activityAt
          ? Number(allItems[0].pick.activityAt)
          : 0;
        const items = allItems.slice(0, MAX_WAKE_ITEMS).map((item) => ({
          ...item,
          /* Older than the addressee's last activity: it is backlog, not news. */
          backlog: firstActivity > 0 && Date.parse(item.message.at || '') < firstActivity,
        }));
        const handle = items[0].handle;
        const text = wakeText(items.map((item) => ({ message: item.message, boxDir: item.boxDir, backlog: item.backlog })));
        let sent = false;
        let target = key.replace(/^session:/u, '');
        let reason = items[0].pick ? items[0].pick.reason : 'spawn';
        let activityAt = items[0].pick && items[0].pick.activityAt
          ? new Date(items[0].pick.activityAt).toISOString()
          : null;
        let failure = null;
        /** Where the reader actually runs, and how we know it. */
        let readerCwd = handle && typeof handle.cwd === 'string' && handle.cwd.trim() ? handle.cwd.trim() : '';
        let cwdSource = readerCwd ? 'session' : '';
        /* Квитанции ещё нет: в сессию не доставляем — письмо остаётся в ящике. */
        const gate = items.map((item) => item.gate).find(Boolean) || '';
        /*
         * The addressee's own freshest session, by journal: the one sessionController will
         * resume and hand the letter to. This is delivery INTO the session, not beside it.
         */
        const controller = getSessionController();
        const sidJournal = activityFor(items[0].target, { now: at.getTime() });
        /*
         * Freshest first, but not only one: a session owned by subagent routing refuses a
         * direct prompt ("is owned by subagent routing", workflow --57), and the operator's
         * own session is usually right behind it.
         */
        const sidCandidates = [...sidJournal.entries()]
          .sort((left, right) => right[1] - left[1])
          .map(([id]) => id)
          .slice(0, 3);
        if (gate) {
          /*
           * Адресат объявлен участником папки, но не принял её (invited) или отключился:
           * письмо остаётся в ящике до квитанции. Это не ошибка доставки, поэтому запись
           * done с причиной box-only, а seen не трогаем — следующий проход доставит
           * письмо, как только квитанция появится.
           */
          sent = true;
          reason = 'box-only';
          target = 'box-only';
          cwdSource = 'queued';
        } else if (handle) {
          try {
            /*
             * A send that never settles used to freeze the whole pass, and with it the
             * box: every later letter waited for the same promise. A timeout turns that
             * hang into an honest failure that the retry can pick up.
             */
            const call = typeof handle.sendMessage === 'function'
              ? handle.sendMessage({ text })
              : (typeof handle.send === 'function' ? handle.send({ text }) : null);
            if (call) {
              await withTimeout(call, deliveryTimeoutMs, 'отправка сообщения в живую сессию');
              sent = true;
            }
          } catch (error) {
            failure = 'живая сессия найдена, но служба агентов не приняла сообщение: '
              + (error && error.message ? error.message : error);
          }
        } else if (controller && sidCandidates.length > 0 && typeof controller.prompt === 'function') {
          /*
           * First-party delivery: sessionController.prompt resumes the addressee's own
           * session (if cold) and admits the letter as a real user message. No twin, no
           * spawn — the letter lands in the session and wakes it.
           */
          const requestId = 'exchange:' + items[0].relative;
          const refused = [];
          for (const sessionId of sidCandidates) {
            try {
              /*
               * ctx.get('sessionController') is the Remote facade: prompt(request, signal)
               * takes a real AbortSignal as the second argument, builds the durable user-rpc
               * source itself (rpcId = requestId) and resumes the session when it is cold.
               */
              const bridge = typeof AbortController === 'function' ? new AbortController() : null;
              await withTimeout(
                controller.prompt(
                  { sessionId, content: [{ type: 'text', text }], mode: 'queue', requestId },
                  bridge ? bridge.signal : undefined,
                ),
                deliveryTimeoutMs,
                'доставка в сессию адресата',
              );
              sent = true;
              reason = 'session-bus';
              target = sessionId;
              /* The recipient is the addressee's own session; its working directory is the fact. */
              const actual = readSessionCwd(sessionId, options);
              readerCwd = actual || '';
              cwdSource = actual ? 'session' : 'queued';
              failure = '';
              break;
            } catch (error) {
              const why = error && error.message ? error.message : String(error);
              refused.push(sessionId + ': ' + why);
              /* Only an ownership refusal is worth another candidate; anything else is real. */
              if (!/owned by subagent/iu.test(why)) break;
            }
          }
          if (!sent) failure = 'доставка в сессию адресата не удалась: ' + refused.join('; ');
        } else if (!spawnWhenAsleep) {
          /*
           * The letter is delivered in the only way that creates no twin: it lies in the
           * box, and the addressee's own agent reads it on its next run.
           */
          sent = true;
          reason = 'box-only';
          target = 'box-only';
          cwdSource = 'queued';
        } else if ((agents || []).some((agent) => {
          const label = String((agent && (agent.label || agent.name)) || '');
          return agent && agent.running !== false
            && label.startsWith('exchange:')
            && label.slice('exchange:'.length) === path.basename(items[0].target);
        })) {
          /*
           * One reader per workspace: a second agent for the same addressee reads the
           * same letter twice, and fills the parent's child limit that a scheduled run
           * needs.
           */
          failure = 'адресат «' + items[0].label + '» уже поднимается запуском exchange: — сообщение ждёт его';
        } else if (at.getTime() - (spawnedAt.get(normalizePath(items[0].target)) || 0) < SPAWN_COOLDOWN_MS) {
          failure = 'адресат «' + items[0].label + '» поднимался меньше '
            + Math.round(SPAWN_COOLDOWN_MS / 1000) + ' с назад — сообщение ждёт следующего прохода';
        } else {
          spawnedAt.set(normalizePath(items[0].target), at.getTime());
          try {
            /*
             * The freshest session of the addressee workspace is the one to wake: it is
             * the operator's own conversation there, not a new one we would invent.
             */
            const journal = activityFor(items[0].target, { now: at.getTime() });
            const freshest = [...journal.entries()].sort((left, right) => right[1] - left[1])[0];
            const started = await withTimeout(
              spawnAddressee(items[0].target, text, freshest ? freshest[0] : undefined),
              deliveryTimeoutMs,
              'запуск адресата',
            );
            sent = true;
            startErrors.delete(normalizePath(items[0].target));
            target = started.childId || (started.resumed ? 'resume' : 'spawn');
            /* Say which of the two happened: a resumed session is not a new agent. */
            reason = started.resumed ? 'resume' : 'spawn';
            /*
             * The fact first: the host writes the session's real working directory into its
             * cache. Only when it is not there yet do we fall back to what we asked for —
             * and then the record says so instead of pretending.
             */
            /*
             * The host writes the session cache a moment after the start, so one immediate
             * read usually finds nothing and would make every spawn "partial" (reported by
             * a live run, 20:18). Wait briefly for the fact instead of giving up on it.
             */
            let actual = readSessionCwd(String(started.childId || ''), options);
            for (let attempt = 0; !actual && attempt < 8; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 150));
              actual = readSessionCwd(String(started.childId || ''), options);
            }
            readerCwd = actual || items[0].target;
            cwdSource = actual ? 'session' : 'requested';
          } catch (error) {
            /*
             * A failed start must not hold the cooldown: otherwise the next retry lands
             * inside the window and waits again, and the record shows only "cooldown"
             * while the real reason is lost. Clear the stamp, keep the reason.
             */
            spawnedAt.delete(normalizePath(items[0].target));
            failure = 'адресат «' + items[0].label + '» не поднят: '
              + (error && error.message ? error.message : error);
            startErrors.set(normalizePath(items[0].target), failure);
            warn('обмен: ' + failure);
          }
        }
        for (const item of items) {
          const wake = {
            target,
            reason,
            ...(activityAt ? { activityAt } : {}),
          };
          noteRun(runtime, {
            root: item.target,
            node: item.label,
            kind: 'exchange',
            since: item.since,
            /*
             * Two different facts, and they must not be confused (found by workflow, --46):
             * `addressee` is where the letter was MEANT to go; `cwd` is where the reader
             * actually worked, and only when the host told us — for a live session from its
             * handle, for a fresh start from the request we sent. A field that just repeats
             * the addressee proves nothing, so `cwdSource` says which case it is and
             * `cwdMismatch` is computed, not assumed.
             */
            addressee: item.target,
            state: sent
              ? (cwdSource === 'session' || cwdSource === 'queued' ? 'done' : 'partial')
              : 'error',
            delivered: item.relative,
            /* How the delivery happened, even when nothing was started (box-only). */
            ...(cwdSource ? { cwdSource } : {}),
            ...(readerCwd ? {
              /* `cwd` is what we asked for; `agentCwd` is where the agent really worked. */
              cwd: item.target,
              agentCwd: cwdSource === 'session' ? readerCwd : null,
              cwdSource,
              /*
               * A mismatch is computed from the fact. Without the fact the field stays null
               * and the run is partial, so acceptance cannot mistake an intention for proof.
               */
              cwdMismatch: cwdSource === 'session' ? normalizePath(readerCwd) !== normalizePath(item.target) : null,
            } : {}),
            wake,
            ...(sent ? {} : {
              message: failure
                ? (failure.includes('не поднят') || !startErrors.has(normalizePath(item.target))
                  ? failure
                  : failure + '; последняя ошибка запуска: ' + startErrors.get(normalizePath(item.target)))
                : 'сообщение не доставлено',
            }),
          });
          /*
           * Решение по КАЖДОМУ письму (задание 0048): тишины быть не должно.
           * Ветка gate называет метку стороны, delivered — сессию вручения;
           * box-only значит, что живой сессии нет, и письмо ждёт в ящике.
           */
          if (gate) {
            const why = item.gate === 'disconnected' ? 'disconnected' : 'invited';
            noteDecision({
              box: item.boxDir,
              letter: item.relative,
              to: item.message.to,
              participant: item.label,
              root: item.target,
              branch: 'gate:' + why,
            });
          }
          /* Гейт — не доставка: в списке доставленного письма нет, оно ждёт в ящике. */
          if (sent && !gate) {
            const boxOnly = reason === 'box-only';
            const sessionId = boxOnly || target === 'spawn' || target === 'resume' ? '' : String(target || '');
            noteDecision({
              box: item.boxDir,
              letter: item.relative,
              to: item.message.to,
              participant: item.label,
              root: item.target,
              ...(sessionId ? { session: sessionId } : {}),
              branch: boxOnly ? 'no-session' : 'delivered',
            });
            delivered.push({ label: item.label, file: item.relative, target, reason });
          } else if (!sent) {
            noteDecision({
              box: item.boxDir,
              letter: item.relative,
              to: item.message.to,
              participant: item.label,
              root: item.target,
              branch: 'error:' + (failure || 'сообщение не доставлено'),
            });
          }
        }
        /* Every message of the batch is delivered by this one wake, so every one is seen. */
        if (sent && !gate) {
          for (const item of items) {
            seen.set(item.message.file, item.mtime);
            seenDirty = true;
          }
          /*
           * The letters beyond the cap were marked as "tried" during the scan; that stamp
           * would hold them back for RETRY_AFTER_MS. They are not a failure - they simply
           * did not fit into this wake - so the stamp is cleared and the next pass takes them.
           */
          for (const item of allItems.slice(items.length)) {
            retried.delete(item.message.file + '\u0000' + item.mtime);
          }
        } else if (gate) {
          /*
           * Письмо не доставлено, но и не забыто: пробу повторит следующий проход, иначе
           * квитанция, пришедшая через минуту, не включила бы доставку.
           */
          for (const item of items) {
            retried.delete(item.message.file + '\u0000' + item.mtime);
          }
        }
      }
      deliveredCount = delivered.length;
      return delivered;
    } finally {
      ticking = false;
      passes += 1;
      lastPassAt = Date.now();
      /* Persist before the telemetry line: the size it reports is the one a restart will see. */
      saveSeen();
      writeTelemetry({
        event: 'pass', passes, seen: seen.size, delivered: deliveredCount, roots: rootCount,
        ...(passes === 1 ? { catchUp: deliveredCount } : {}),
      });
    }
  }

  /** Keep the watcher's own run record truthful: it is how a silent watcher is seen. */
  function heartbeat(state, message) {
    const list = roots();
    /* The registry may arrive after activation; the default root still names a place. */
    const root = list[0] || (typeof runtime.defaultRoot === 'string' ? runtime.defaultRoot : '');
    if (!root) return;
    noteRun(runtime, {
      root,
      node: 'exchange-watch',
      kind: 'watch',
      since: watchSince || Date.now(),
      state,
      passes,
      seen: seen.size,
      lastPassAt: lastPassAt ? new Date(lastPassAt).toISOString() : null,
      ...(message ? { message } : {}),
    });
  }

  /** Start the timer; returns the disposer the host calls on unload. */
  function start() {
    if (timer || stopped) return () => {};
    loadSeen();
    watchSince = Date.now();
    writeTelemetry({
      event: 'start',
      tickMs,
      backlogMs,
      wakeSpawn: spawnWhenAsleep,
      roots: roots().length,
      participants: Object.keys(runtime.participants || {}).length,
    });
    heartbeat('running');
    const id = setInterval(() => {
      tick()
        .then(() => {
          if (passes % 15 === 1) heartbeat('running');
        })
        .catch((error) => {
          lastError = error && error.message ? error.message : String(error);
          warn('обмен: проход не удался: ' + lastError);
          writeTelemetry({ event: 'error', passes, message: lastError, stack: String(error && error.stack || '').split('\n').slice(0, 3) });
          heartbeat('error', 'проход не удался: ' + lastError);
        });
    }, tickMs);
    if (typeof id.unref === 'function') id.unref();
    timer = id;
    tick()
      .then(() => {
        heartbeat('running');
      })
      .catch((error) => {
        lastError = error && error.message ? error.message : String(error);
        warn('обмен: первый проход не удался: ' + lastError);
        heartbeat('error', 'первый проход не удался: ' + lastError);
      });
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    };
  }

  return { start, tick, seen, stop: () => { stopped = true; if (timer) clearInterval(timer); timer = null; } };
}
