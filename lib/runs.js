/**
 * Run history per project, kept in memory and on disk.
 *
 * The tools write here; the panel reads it through /api/activity. Memory alone
 * was not enough: a DSH restart (or a plugin reload) erased the history, and the
 * panel then claimed nothing had ever run. The file is per project root, so two
 * projects never share records.
 *
 * One record is one run: a state transition (running → done/error) rewrites the
 * record of the same `since`, while a new run appends. Keeping the history
 * rather than only the last record is what lets a branch keep its steps visible
 * after the next run of the same node.
 *
 * The file lives under the plugin's own data directory, never inside the
 * project: the panel stays read-only towards the repositories it displays.
 *
 * Several processes (the coordinator, a subagent, the panel) write the same file
 * of one root. A whole-file rewrite from memory therefore lost whatever another
 * process had written in between (caught by the critic on task 0054). The write
 * is now a merge under a file lock: `<file>.lock` is created exclusively, the
 * file is re-read, records are combined by key and only then replaced atomically.
 * The lock is taken as an optimisation of history, never as a gate of the run:
 * waiting is bounded and every failure of the store only warns.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DIR = path.join(os.homedir(), '.dsh', 'project-graph', 'runs');
/** Roots already merged from disk, per runtime instance. */
const loadedRoots = new WeakMap();
let warned = false;

/** Pause between attempts to take a busy lock: short, so the tool stays prompt. */
const LOCK_RETRY_MIN_MS = 15;
const LOCK_RETRY_MAX_MS = 25;
/** A lock older than this has no living owner and may be taken over. */
const LOCK_STALE_MS = 5000;
/** History is worth this much of a tool call, but not a millisecond more. */
const LOCK_WAIT_MS = 2000;

function warnOnce(error) {
  if (warned) return;
  warned = true;
  const message = error && error.message ? error.message : String(error);
  console.warn('[dsh-project-graph] store of runs is unavailable: ' + message
    + ' — the panel will show runs of this process only.');
}

/** Directory holding the run files; a profile or a test may point it elsewhere. */
export function storeDir(runtime) {
  const configured = runtime && typeof runtime.runsDir === 'string' ? runtime.runsDir.trim() : '';
  if (configured) return configured;
  /* Tests and the preview harness point the store at a scratch folder. */
  const fromEnv = typeof process !== 'undefined' && process.env ? process.env.PG_RUNS_DIR : '';
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return DEFAULT_DIR;
}

/**
 * File for one project root. The path is hashed because a root can contain
 * characters a file name cannot, and two roots that differ only in case must
 * not share a file on a case-insensitive disk.
 */
export function runFilePath(runtime, root) {
  const resolved = path.resolve(String(root));
  const digest = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 20);
  return path.join(storeDir(runtime), digest + '.json');
}

function mapOf(runtime) {
  if (!(runtime.runs instanceof Map)) runtime.runs = new Map();
  return runtime.runs;
}

/** One run is identified by its node and its start; a later state rewrites it. */
function keyOf(root, node, since) {
  return root + '\u0000' + node + '\u0000' + String(since);
}

/* Enough history for a branch and a few earlier runs, small enough to read fast. */
const MAX_RECORDS_PER_ROOT = 200;

/* ------------------------------------------------------------------------- *
 * Lock: one writer at a time, with a deadline and a takeover of dead owners.
 * ------------------------------------------------------------------------- */

/** Waiting without a busy loop; a fallback keeps the module usable without SAB. */
const sleepCell = (() => {
  try {
    return new Int32Array(new SharedArrayBuffer(4));
  } catch {
    return null;
  }
})();

function sleepSync(ms) {
  const pause = Math.max(1, Math.floor(ms));
  if (sleepCell) {
    try {
      Atomics.wait(sleepCell, 0, 0, pause);
      return;
    } catch {
      /* fall through to the busy pause */
    }
  }
  const until = Date.now() + pause;
  while (Date.now() < until) { /* a short spin is still cheaper than a lost record */ }
}

/** Identity of one lock owner, so a stale takeover is never undone by the loser. */
function lockToken() {
  return String(process.pid) + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
}

/**
 * Take the lock of one run file. Returns { path, token } or null when the wait
 * is over: a busy lock means a living writer, and a run must not wait for it
 * longer than LOCK_WAIT_MS.
 */
function acquireLock(file) {
  const lockPath = file + '.lock';
  const deadline = Date.now() + LOCK_WAIT_MS;
  /*
   * The deadline is checked in every branch of the wait, not only where a living
   * owner is suspected. A lock that cannot be taken over — a directory on the
   * lock name, for instance — must not turn the retry into an endless loop: the
   * history is an optimisation, and a run is worth more than its record.
   */
  const expired = () => Date.now() >= deadline;
  const pause = () => LOCK_RETRY_MIN_MS
    + Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS + 1));
  for (;;) {
    const token = lockToken();
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, token, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { path: lockPath, token };
    } catch (error) {
      /*
       * Windows reports a lock being deleted by its owner as EPERM for a moment,
       * not only EEXIST. All three mean "another writer owns the name right now";
       * anything else (a real permission denial) is a store failure.
       */
      if (!error || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }
    /*
     * A crashed writer leaves its lock behind; age, not content, is the proof of
     * death. A living writer holds the lock for a few milliseconds only.
     */
    let abandoned = false;
    try {
      const stat = fs.statSync(lockPath);
      abandoned = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
    } catch (error) {
      /*
       * The name disappeared between the failed create and the stat: retry at
       * once, but only while the deadline allows — a name that keeps flickering
       * must not hold the caller forever either.
       */
      if (error && error.code === 'ENOENT') {
        if (expired()) return null;
        continue;
      }
      throw error;
    }
    if (abandoned) {
      let removed = false;
      try {
        fs.rmSync(lockPath, { force: true });
        removed = true;
      } catch {
        /* Another writer won that race, or the name is not a file at all: a
           directory stays in place even with force, and cannot be taken over. */
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      /* Freeing the name goes first; a name we cannot free costs a pause, not a
         burnt core — and still never outlives the deadline. */
      if (!removed) sleepSync(Math.min(pause(), left));
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    sleepSync(Math.min(pause(), left));
  }
}

/** Release only our own lock: a lock taken over as stale belongs to its taker. */
function releaseLock(lock) {
  if (!lock) return;
  try {
    if (fs.readFileSync(lock.path, 'utf8') !== lock.token) return;
  } catch {
    return;
  }
  try { fs.rmSync(lock.path, { force: true }); } catch { /* already gone */ }
}

/* ------------------------------------------------------------------------- *
 * Merge: the file and this process are two sources of the same history.
 * ------------------------------------------------------------------------- */

/** running is the earlier state; done and error are both final. */
function stateRank(record) {
  const state = String(record && record.state ? record.state : 'running').toLowerCase();
  return state === 'done' || state === 'error' ? 1 : 0;
}

/** The newest moment the record can prove: updatedAt, then finish, then start. */
function freshness(record) {
  for (const field of ['updatedAt', 'finishedAt', 'since']) {
    const value = record ? record[field] : undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/** A later state wins; on equal states the newer record wins. */
function preferNewer(left, right) {
  const leftRank = stateRank(left);
  const rightRank = stateRank(right);
  if (leftRank !== rightRank) return rightRank > leftRank ? right : left;
  return freshness(right) > freshness(left) ? right : left;
}

/**
 * Combine two records of one key. The winner keeps its body, but an ack is a
 * fact about the letter, not about the run: whoever writes last must not erase
 * a confirmation another process already recorded.
 */
function mergeRecords(left, right) {
  if (!left) return right;
  if (!right) return left;
  let chosen = preferNewer(left, right);
  const other = chosen === left ? right : left;
  if (other.ack && !chosen.ack) {
    chosen = {
      ...chosen,
      ack: other.ack,
      ...(other.ackAt && !chosen.ackAt ? { ackAt: other.ackAt } : {}),
      ...(other.ackBy && !chosen.ackBy ? { ackBy: other.ackBy, ackByAddressee: other.ackByAddressee } : {}),
    };
  }
  return chosen;
}

/** Rows of this root from the file; a broken or foreign file starts empty. */
function readFileRows(file, root) {
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code !== 'ENOENT' && error.code !== 'EACCES' && !(error instanceof SyntaxError)) {
      warnOnce(error);
    }
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && typeof row === 'object' && row.root === root && row.node);
}

/** Replace the file atomically; a locked target falls back to a direct write. */
function writeRows(file, rows) {
  const body = JSON.stringify(rows, null, 2) + '\n';
  const temporary = file + '.' + String(process.pid) + '.tmp';
  try {
    fs.writeFileSync(temporary, body, 'utf8');
    fs.renameSync(temporary, file);
    return;
  } catch {
    /*
     * Windows can refuse the replace while a virus scanner holds the target.
     * A direct write is not atomic, but the lock excludes every other writer of
     * this plugin, and a torn file only loses history.
     */
  }
  try {
    fs.writeFileSync(file, body, 'utf8');
    fs.rmSync(temporary, { force: true });
  } catch (error) {
    warnOnce(error);
  }
}

/** Make the memory of this runtime agree with what the merge decided. */
function syncMemory(runtime, root, rows) {
  const runs = mapOf(runtime);
  const prefix = root + '\u0000';
  for (const key of [...runs.keys()]) {
    if (key.startsWith(prefix) && !rows.has(key)) runs.delete(key);
  }
  for (const [key, row] of rows) runs.set(key, row);
}

/**
 * Write every record of this root under the lock.
 *
 * The file is re-read here, not trusted from memory: another process may have
 * appended a run since this runtime loaded it. Merge by key, prune, write, drop
 * the lock. A failure of any step is a warning — a run must not die of history.
 */
function persist(runtime, root) {
  let lock = null;
  try {
    const file = runFilePath(runtime, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lock = acquireLock(file);
    if (!lock) {
      warnOnce(new Error('lock of ' + file + '.lock is busy for ' + LOCK_WAIT_MS + ' ms'));
      return;
    }
    const rows = new Map();
    for (const row of readFileRows(file, root)) {
      rows.set(keyOf(root, row.node, row.since || 0), row);
    }
    for (const [key, row] of mapOf(runtime)) {
      if (!row || row.root !== root) continue;
      rows.set(key, mergeRecords(rows.get(key), row));
    }
    const own = [...rows.entries()];
    if (own.length > MAX_RECORDS_PER_ROOT) {
      own.sort((left, right) => (left[1].since || 0) - (right[1].since || 0));
      for (const [key] of own.slice(0, own.length - MAX_RECORDS_PER_ROOT)) rows.delete(key);
    }
    syncMemory(runtime, root, rows);
    writeRows(file, [...rows.values()]);
  } catch (error) {
    warnOnce(error);
  } finally {
    releaseLock(lock);
  }
}

/** Read the file of this root once per runtime; a broken file starts empty. */
function ensureLoaded(runtime, root) {
  if (!runtime || !root) return;
  let seen = loadedRoots.get(runtime);
  if (!seen) {
    seen = new Set();
    loadedRoots.set(runtime, seen);
  }
  if (seen.has(root)) return;
  seen.add(root);
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(runFilePath(runtime, root), 'utf8'));
  } catch (error) {
    /*
     * A missing file is the normal first run, and an unreadable one is repaired
     * by starting empty — neither is worth a warning in the host log. Only a
     * real I/O error (a locked file, no permission) is news.
     */
    if (error && error.code !== 'ENOENT' && error.code !== 'EACCES') {
      const parseFailure = error instanceof SyntaxError;
      if (!parseFailure) warnOnce(error);
    }
    return;
  }
  if (!Array.isArray(rows)) return;
  const runs = mapOf(runtime);
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.root !== root || !row.node) continue;
    const key = keyOf(root, row.node, row.since || 0);
    /* A live record of this process wins over the file: it is newer. */
    if (!runs.has(key)) runs.set(key, row);
  }
}

/** Keep one run's state: same node and start rewrites, a new run appends. */
export function noteRun(runtime, record) {
  if (!runtime || !record || !record.root || !record.node) return;
  ensureLoaded(runtime, record.root);
  const since = record.since || Date.now();
  const runs = mapOf(runtime);
  const key = keyOf(record.root, record.node, since);
  const previous = runs.get(key);
  /*
   * A confirmation is a fact about the letter, not about the state of the run. A
   * repeated delivery of the same letter keeps the same key (since is the file's
   * write time), so the second write used to replace the record and erase ack one
   * pass after it was filled (live 2026-11-01, 18:19 and 18:24). The slot is
   * carried over instead: whoever rewrites the record last must not un-ack it.
   */
  const confirmation = previous && previous.ack && !record.ack
    ? {
      ack: previous.ack,
      ...(previous.ackAt && !record.ackAt ? { ackAt: previous.ackAt } : {}),
      /* Who answered is a fact about the letter too: keep it with the slot. */
      ...(previous.ackBy && !record.ackBy ? { ackBy: previous.ackBy, ackByAddressee: previous.ackByAddressee } : {}),
    }
    : {};
  runs.set(key, {
    ...record,
    ...confirmation,
    state: record.state || 'running',
    since,
    updatedAt: record.updatedAt || Date.now(),
  });
  /* Prune oldest records of this root only; other roots are untouched. */
  const own = [...runs.entries()].filter(([ownKey]) => ownKey.startsWith(record.root + '\u0000'));
  if (own.length > MAX_RECORDS_PER_ROOT) {
    own.sort((left, right) => (left[1].since || 0) - (right[1].since || 0));
    for (const [ownKey] of own.slice(0, own.length - MAX_RECORDS_PER_ROOT)) runs.delete(ownKey);
  }
  persist(runtime, record.root);
}

/** Runs of one root, newest first. Loads the file on first use. */
export function listRuns(runtime, root) {
  if (!runtime) return [];
  if (root) ensureLoaded(runtime, root);
  const runs = [];
  for (const [key, record] of mapOf(runtime)) {
    if (!root || key.startsWith(root + '\u0000')) runs.push(record);
  }
  return runs.sort((left, right) => (right.since || 0) - (left.since || 0));
}
