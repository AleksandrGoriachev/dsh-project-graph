/**
 * Session watch (task 0309).
 *
 * The structure must eventually see EVERY new session and must not let work slip
 * past the nodes. Before any hard control can be argued for, the plugin needs an
 * honest observation log: which sessions appeared, which of them belong to a node,
 * which run without one ("shadows"), and when they end.
 *
 * This module is that observation, and nothing else — it forbids no run, edits no
 * structure file and touches no live file of the project. The journal lives in the
 * profile store (the same folder as alternatives.jsonl, see lib/store.js), one
 * file per workspace root.
 *
 * Four layers, each useful on its own:
 *
 *   1. sessionWatchRows(input) — a pure projection: every session with its node,
 *      the source that named it (binding -> agent -> run, exactly as /api/live
 *      does through attributeSessions), the shadow flag and its reason. No disk.
 *   2. sessionWatchFile(root) / readSessionWatch(root) — where the journal is and
 *      how to read the newest events back; a broken line is skipped, never thrown.
 *   3. createSessionWatchRecorder — append-only JSONL of transitions. It keeps the
 *      state in memory, restores it from the file, writes at most one line per
 *      session per observation, rotates at maxBytes and reports a write failure as
 *      a field instead of an exception.
 *   4. createSessionWatcher — the periodic pass over every root the runtime serves:
 *      graph, sessions, runs and live agents are read, the binding and the rows are
 *      computed, the recorder writes the transitions. The first pass of a root is
 *      its baseline: running sessions are "seen", idle history stays silent.
 *
 * Boundaries that matter:
 *   - a session without a node is a shadow only while it runs; idle sessions are
 *     the normal state of a workspace that waits, not a violation;
 *   - the label is the live agent's label, trimmed, or an empty string — the
 *     journal invents no role;
 *   - the observer never fails the host: a broken root is an entry in errors, a
 *     broken journal is a field of the result.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readGraph } from './api.js';
import { attributeSessions, bindSessions, mapLiveAgents, readSessionActivity } from './live.js';
import { listRuns } from './runs.js';
import { storeDir } from './store.js';

/** Shape of one journal record; bump only with a breaking change. */
export const SESSION_WATCH_VERSION = 1;

/** Default rollover size of one journal (8 MiB), as the contract says. */
export const SESSION_WATCH_MAX_BYTES = 8 * 1024 * 1024;

/** Default interval of the observer, and the range a configured value lives in. */
export const SESSION_WATCH_DEFAULT_INTERVAL_MS = 5000;
export const SESSION_WATCH_MIN_INTERVAL_MS = 1000;
export const SESSION_WATCH_MAX_INTERVAL_MS = 60000;

/** Event names of the journal, in the priority order of one observation. */
export const SESSION_WATCH_EVENTS = ['seen', 'started', 'ended', 'attributed', 'unattributed'];

/** ISO text of a clock value; a malformed value stays null instead of a guess. */
function isoOf(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      return new Date(value).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

/** Trimmed non-empty string or null. */
function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

/** How many nodes the structure actually declares. */
function declaredNodeCount(nodes) {
  let count = 0;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = typeof node === 'string'
      ? node.trim()
      : (node && typeof node === 'object' && typeof node.id === 'string' ? node.id.trim() : '');
    if (id) count += 1;
  }
  return count;
}

/** Labels of the live agents by session id: the host's label, trimmed, or ''. */
function labelMap(agents) {
  const labels = new Map();
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue;
    const id = typeof agent.id === 'string' ? agent.id.trim() : '';
    if (!id || labels.has(id)) continue;
    labels.set(id, typeof agent.label === 'string' ? agent.label.trim() : '');
  }
  return labels;
}

/**
 * One row per session of one workspace, newest sessions first.
 *
 * Attribution is the same projection the live route uses: bindSessions chose a
 * node (source 'binding'), else the agent of this root named one (source 'agent'),
 * else a running record of this root's run journal named one (source 'run').
 * attributeSessions does that work; this function only reshapes it and adds the
 * three fields the journal needs: shadow, reason and label.
 *
 * Rules:
 *   - shadow = the session runs and no source named a node;
 *   - reason = '' when the node exists or the session is idle, 'no-node' when the
 *     structure declares no nodes at all, 'unattributed' otherwise;
 *   - label = the live agent's label (already trimmed) or '' — never invented;
 *   - order = newest sessions first, as sessionRows sorts them;
 *   - the input is not mutated and nothing is read from disk.
 *
 * @param {object} input - root, sessions, nodes, folders, binding, agents, runs, now, windowMs.
 * @returns {Array<{ session: string, sessionAt: string|null, running: boolean,
 *   node: string|null, source: string|null, shadow: boolean, reason: string, label: string }>}
 */
export function sessionWatchRows(input = {}) {
  const options = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sessions = Array.isArray(options.sessions) ? options.sessions : [];
  const nodes = Array.isArray(options.nodes) ? options.nodes : [];
  const agents = Array.isArray(options.agents) ? options.agents : [];
  const runs = Array.isArray(options.runs) ? options.runs : [];
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  const windowMs = typeof options.windowMs === 'number' && Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : undefined;
  const attributed = attributeSessions({
    root: options.root,
    sessions,
    nodes,
    binding: options.binding,
    agents,
    runs,
    now,
    ...(windowMs ? { windowMs } : {}),
  });
  const declared = declaredNodeCount(nodes);
  const labels = labelMap(agents);
  const rows = [];
  for (const item of Array.isArray(attributed.items) ? attributed.items : []) {
    const running = item.running === true;
    const node = textOrNull(item.node);
    const source = textOrNull(item.source);
    rows.push({
      session: item.id,
      sessionAt: isoOf(item.at),
      running,
      node,
      source,
      shadow: running && node === null,
      reason: node ? '' : (running ? (declared === 0 ? 'no-node' : 'unattributed') : ''),
      label: labels.get(item.id) || '',
    });
  }
  return rows;
}

/**
 * Journal path of one workspace root inside the store.
 *
 * The name carries the first 12 hex of sha256 of the ABSOLUTE root, because the
 * readable project name is not unique and two workspaces must never share a
 * journal. The folder is the same store lib/store.js gives the graph and the
 * alternatives log; DSH_PROJECT_GRAPH_STORE is honoured there.
 */
export function sessionWatchFile(root) {
  const absolute = path.resolve(String(root || process.cwd()));
  const digest = crypto.createHash('sha256').update(absolute).digest('hex').slice(0, 12);
  return path.join(storeDir(root), 'session-watch-' + digest + '.jsonl');
}

/**
 * The newest journal events of one root, newest first.
 *
 * A missing file, an unreadable store and a broken line are all "no evidence":
 * the reader skips them instead of throwing, because a journal is an observation
 * and must not take a caller down. The limit option bounds the answer; without it
 * every valid event is returned.
 */
export function readSessionWatch(root, options = {}) {
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  let text;
  try {
    text = fs.readFileSync(sessionWatchFile(root), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.session !== 'string' || !entry.session.trim()) continue;
    events.push(entry);
  }
  events.reverse();
  const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit >= 0
    ? Math.floor(opts.limit)
    : -1;
  return limit >= 0 ? events.slice(0, limit) : events;
}

/**
 * Append-only recorder of session transitions of one root.
 *
 * State is one record per session ({ running, node, source }) and is restored
 * lazily from the journal on the first observe: the last line with a session id
 * wins, a broken line is skipped. This is what makes a restart continue instead
 * of re-announcing the whole history.
 *
 * The transition rules of one observe (at most ONE line per session):
 *   - unknown and running -> 'seen'; unknown and idle -> remembered silently;
 *   - known true -> false -> 'ended'; known false -> true -> 'started';
 *   - otherwise a changed node/source with a node -> 'attributed';
 *   - otherwise a node lost by a running session -> 'unattributed';
 *   - no change -> no line.
 * State is updated from the row in every case; when the write fails, the state of
 * the sessions whose event was not written is kept, so the next observation still
 * sees the transition. The caller gets { ok, written } or { ok:false, written:[],
 * error } — an exception never leaves this function.
 *
 * Rotation: before an append, a journal larger than maxBytes is renamed to
 * file + '.1' (the old .1 is replaced) and the journal starts empty. The state is
 * NOT reset — rotation is a file concern, not a fact about the sessions.
 *
 * @param {object} options - file (absolute journal path), now (clock), maxBytes,
 *   root (the workspace the journal belongs to, written into every line).
 */
export function createSessionWatchRecorder(options = {}) {
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const file = typeof opts.file === 'string' && opts.file.trim() ? path.resolve(opts.file.trim()) : '';
  const clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const maxBytes = typeof opts.maxBytes === 'number' && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
    ? opts.maxBytes
    : SESSION_WATCH_MAX_BYTES;
  const defaultRoot = typeof opts.root === 'string' ? opts.root : '';
  const state = new Map();
  let restored = false;

  /** Restore one session record per line; the last line with an id wins. */
  function restore() {
    if (restored) return state;
    restored = true;
    if (!file) return state;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return state;
    }
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const session = typeof entry.session === 'string' ? entry.session.trim() : '';
      if (!session) continue;
      state.set(session, {
        running: entry.running === true,
        node: textOrNull(entry.node),
        source: textOrNull(entry.source),
      });
    }
    return state;
  }

  /** Rename the journal to .1 when it outgrew maxBytes; append if renaming fails. */
  function rotateIfNeeded() {
    if (!file) return;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    if (!stat || stat.size <= maxBytes) return;
    const backup = file + '.1';
    try {
      fs.renameSync(file, backup);
    } catch {
      try {
        fs.unlinkSync(backup);
      } catch {
        /* no old backup to replace */
      }
      try {
        fs.renameSync(file, backup);
      } catch {
        /* rotation failed: keep appending rather than lose the observation */
      }
    }
  }

  /** Clock in ISO; a broken clock falls back to the real one instead of throwing. */
  function atIso() {
    let value;
    try {
      value = clock();
    } catch {
      value = Date.now();
    }
    const iso = isoOf(value);
    return iso || new Date().toISOString();
  }

  /** One journal record in the contract's field order. */
  function buildEvent({ event, row, session, running, node, source }) {
    const rowRoot = typeof row.root === 'string' && row.root.trim() ? row.root.trim() : '';
    return {
      version: SESSION_WATCH_VERSION,
      at: atIso(),
      event,
      root: rowRoot || defaultRoot,
      session,
      running,
      sessionAt: isoOf(row.sessionAt),
      node,
      source,
      shadow: running === true && node === null,
      reason: typeof row.reason === 'string'
        ? row.reason.trim()
        : (node ? '' : (running ? 'unattributed' : '')),
      label: typeof row.label === 'string' ? row.label.trim() : '',
    };
  }

  /**
   * Observe one batch of rows; write the transitions, remember the state.
   *
   * @param rows - sessionWatchRows output (or the same shape).
   * @param observeOptions.baseline - marks the first pass; the transition rules
   *   are the same, the flag documents the difference between "history" and
   *   "change" for a reader of this code.
   * @returns {{ ok: boolean, written: Array<object>, error?: string }}.
   */
  function observe(rows, observeOptions = {}) {
    const list = Array.isArray(rows) ? rows : [];
    void observeOptions;
    restore();
    const events = [];
    const pending = [];
    const seen = new Set();
    for (const row of list) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const session = typeof row.session === 'string' ? row.session.trim() : '';
      if (!session || seen.has(session)) continue;
      seen.add(session);
      const running = row.running === true;
      const node = textOrNull(row.node);
      const source = textOrNull(row.source);
      const previous = state.get(session);
      let event = '';
      if (!previous) {
        /* A running stranger is news at any pass; an idle one is just history. */
        if (running) event = 'seen';
      } else if (previous.running === true && running === false) {
        event = 'ended';
      } else if (previous.running === false && running === true) {
        event = 'started';
      } else if (node && (previous.node !== node || previous.source !== source)) {
        event = 'attributed';
      } else if (!node && previous.node !== null && running === true) {
        event = 'unattributed';
      }
      const update = { running, node, source };
      if (event) {
        events.push(buildEvent({ event, row, session, running, node, source }));
        pending.push({ session, update });
      } else {
        state.set(session, update);
      }
    }
    if (events.length === 0) return { ok: true, written: [] };
    if (!file) {
      return { ok: false, written: [], error: 'не задан файл журнала сессий' };
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
    } catch (error) {
      /* The event was not written: keep the old state so the next pass retries it. */
      return {
        ok: false,
        written: [],
        error: error && error.message ? String(error.message) : String(error),
      };
    }
    for (const item of pending) state.set(item.session, item.update);
    return { ok: true, written: events };
  }

  return { file, observe, restore };
}

/** Absolute roots the runtime serves, deduplicated; a broken runtime is empty. */
function runtimeRoots(runtime) {
  const value = runtime && typeof runtime.allowedRoots === 'function'
    ? runtime.allowedRoots()
    : (runtime && Array.isArray(runtime.roots) ? runtime.roots : []);
  const roots = [];
  for (const candidate of Array.isArray(value) ? value : []) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    let absolute;
    try {
      absolute = path.resolve(candidate.trim());
    } catch {
      continue;
    }
    if (!roots.includes(absolute)) roots.push(absolute);
  }
  return roots;
}

/** Live agents as a plain list, whichever shape the host service answers with. */
function liveAgentRows(getAgents) {
  if (typeof getAgents !== 'function') return [];
  let value;
  try {
    value = getAgents();
  } catch {
    return [];
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    try {
      const rows = typeof value.roots === 'function'
        ? value.roots()
        : (typeof value.list === 'function' ? value.list() : []);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** The configured interval, clamped into the contract's range, or the default. */
function intervalOf(config) {
  const raw = config && typeof config === 'object' ? config.sessionWatchIntervalMs : undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return SESSION_WATCH_DEFAULT_INTERVAL_MS;
  return Math.min(Math.max(Math.round(value), SESSION_WATCH_MIN_INTERVAL_MS), SESSION_WATCH_MAX_INTERVAL_MS);
}

/** Human text of a failure; never throws. */
function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

/**
 * The periodic observer of every workspace the plugin serves.
 *
 * One tick per root: read the graph, the sessions, the run journal and the live
 * agents, compute the binding (bindSessions), the rows (sessionWatchRows) and let
 * the root's own recorder write the transitions. The first tick of a root is its
 * baseline; later ticks are ordinary observations. A broken root is an entry of
 * errors and does not stop the other roots; a failed write is a field of the
 * result. tick() and start() never throw.
 *
 * The timer interval comes from config.sessionWatchIntervalMs (default 5000,
 * clamped to 1000..60000), so a production profile cannot turn the observer into
 * a busy loop. start() makes one pass immediately and then on every interval; its
 * dispose() is idempotent. config.sessionWatch === false or PG_SESSION_WATCH='0'
 * turns the observer off: start() returns a no-op dispose and writes nothing.
 *
 * @param {object} options - runtime, config, getAgents, readSessions, readRuns, now.
 * @returns {{ tick: Function, start: Function, intervalMs: number }}.
 */
export function createSessionWatcher(options = {}) {
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const runtime = opts.runtime || null;
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const intervalMs = intervalOf(config);
  const injectedSessions = typeof opts.readSessions === 'function' ? opts.readSessions : null;
  const injectedRuns = typeof opts.readRuns === 'function' ? opts.readRuns : null;
  const injectedAgents = typeof opts.getAgents === 'function' ? opts.getAgents : null;
  const sessionsDir = runtime && typeof runtime.sessionsDir === 'string' && runtime.sessionsDir.trim()
    ? runtime.sessionsDir.trim()
    : (typeof config.sessionsDir === 'string' && config.sessionsDir.trim() ? config.sessionsDir.trim() : '');
  const recorders = new Map();
  const baselines = new Set();
  let timer = null;
  let dispose = null;

  /** Sessions of one root; the disk journal is the default source. */
  function readSessions(root) {
    if (injectedSessions) return injectedSessions(root);
    let now;
    try {
      now = clock();
    } catch {
      now = Date.now();
    }
    return readSessionActivity(root, {
      ...(sessionsDir ? { sessionsDir } : {}),
      now: typeof now === 'number' && Number.isFinite(now) ? now : Date.now(),
    });
  }

  /** Runs of one root; the run store is the default source. */
  function readRuns(root) {
    if (injectedRuns) return injectedRuns(root);
    return listRuns(runtime, root);
  }

  /** One root: graph -> sessions -> agents -> binding -> rows -> journal. */
  function tickRoot(root, now) {
    const payload = readGraph(runtime, root);
    const graph = payload && payload.graph && typeof payload.graph === 'object' && !Array.isArray(payload.graph)
      ? payload.graph
      : {};
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const folders = Array.isArray(graph.folders) ? graph.folders : [];
    const payloadSessions = readSessions(root);
    const sessions = Array.isArray(payloadSessions)
      ? payloadSessions
      : (payloadSessions && Array.isArray(payloadSessions.items) ? payloadSessions.items : []);
    const runs = readRuns(root);
    const mapped = mapLiveAgents(liveAgentRows(injectedAgents), root, nodes);
    const bound = bindSessions({
      root,
      sessions,
      nodes,
      folders,
      agents: mapped.agents,
      /* Auto-binding must skip the child sessions the run journal claims. */
      runs: Array.isArray(runs) ? runs : [],
      now,
    });
    const rows = sessionWatchRows({
      root,
      sessions,
      nodes,
      folders,
      binding: bound && bound.binding ? bound.binding : null,
      agents: mapped.agents,
      runs: Array.isArray(runs) ? runs : [],
      now,
    });
    let recorder = recorders.get(root);
    if (!recorder) {
      recorder = createSessionWatchRecorder({ file: sessionWatchFile(root), root, now: clock });
      recorders.set(root, recorder);
    }
    const baseline = !baselines.has(root);
    const observed = recorder.observe(rows, { baseline });
    baselines.add(root);
    return {
      rows: rows.length,
      written: Array.isArray(observed.written) ? observed.written : [],
      ok: observed.ok !== false,
      error: observed.error ? String(observed.error) : '',
    };
  }

  /**
   * One pass over all roots.
   *
   * @returns {{ ok: boolean, roots: number, rows: number, written: Array<object>,
   *   errors: Array<{ root: string|null, error: string }> }}.
   */
  function tick() {
    const result = { ok: true, roots: 0, rows: 0, written: [], errors: [] };
    let roots = [];
    try {
      roots = runtimeRoots(runtime);
    } catch (error) {
      result.ok = false;
      result.errors.push({ root: null, error: errorText(error) });
      return result;
    }
    result.roots = roots.length;
    let now;
    try {
      now = clock();
    } catch {
      now = Date.now();
    }
    if (typeof now !== 'number' || !Number.isFinite(now)) now = Date.now();
    for (const root of roots) {
      try {
        const one = tickRoot(root, now);
        result.rows += one.rows;
        result.written.push(...one.written);
        if (!one.ok) {
          result.ok = false;
          result.errors.push({ root, error: one.error || 'запись журнала сессий не удалась' });
        }
      } catch (error) {
        /* One broken root is not a broken observer. */
        result.errors.push({ root, error: errorText(error) });
      }
    }
    return result;
  }

  /** The observer is off by config or by an explicit environment stop. */
  function isOff() {
    if (config.sessionWatch === false) return true;
    const env = typeof process !== 'undefined' && process.env ? String(process.env.PG_SESSION_WATCH || '').trim() : '';
    return env === '0';
  }

  /** Make one pass now, then on every interval; returns an idempotent dispose. */
  function start() {
    if (isOff()) return () => {};
    if (dispose) return dispose;
    try {
      tick();
    } catch {
      /* observation must never break plugin activation */
    }
    const id = setInterval(() => {
      try {
        tick();
      } catch {
        /* a failed pass is not an exception of the host */
      }
    }, intervalMs);
    if (id && typeof id.unref === 'function') id.unref();
    timer = id;
    let stopped = false;
    dispose = () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    return dispose;
  }

  return { tick, start, intervalMs };
}
