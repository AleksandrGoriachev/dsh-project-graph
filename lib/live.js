/**
 * Live agents of the host, mapped onto the nodes of one structure.
 *
 * A node used to look busy only when the open session owned the child agent: the
 * client read its own subagent catalog and the run store. An agent started from
 * another session or another workspace (for example the judge in
 * `default-workspace`) was alive but invisible, so the schema called the node
 * free while it was working.
 *
 * This module is the pure half of the fix: the host hands over the live agents it
 * knows about, and this function decides which of them belong to this project
 * root and which node each one represents. It throws on no service failure and
 * invents no role: an agent whose label names no node is reported as unknown, and
 * an agent of another root is not attached at all.
 *
 * The one function that touches disk is readSessionActivity: the host does not
 * always expose live agents, so a recently written session journal is the second
 * source of truth. Read the comment above it before trusting a folder name.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Session files of one workspace, newest first, with a freshness flag.
 *
 * The host's agent service does not always expose live agents to a plugin, so the
 * panel keeps a second, honest source: DSH writes a session file while work goes on.
 * A recently touched file means "someone is working here"; it never names a role, so
 * such activity is reported without pretending to know which node it is.
 *
 * The folder of a session is NOT the workspace it works in: the host files every
 * session under the key of its parent. A session started for another workspace (the
 * panel's wake, for example) therefore sits under the parent's key and switches its
 * working directory in the journal 6-42 ms after creation. The journal decides for
 * EVERY session, idle or not; the folder decides only when the journal cannot be read
 * (no file, no zstd in this Node, not a journal at all).
 *
 * An idle session is not an edge case: a workspace that waits for a letter spends
 * almost all its time that way, and a fresh-only read left an idle session under the
 * key of its parent — exactly when the last-active rule had to work. A cached read is
 * what makes "every session" affordable: measured on the live store of 2026-11-01
 * (10 keys, 395 journals), one pass costs ~150 ms in directory and stat calls, and the
 * decompression is paid once per journal state, ~0.5 s on the first pass after start.
 *
 * Every workspace folder is scanned, because a session of this root can sit under any
 * key.
 *
 * @param root - workspace path.
 * @param options.sessionsDir - defaults to ~/.dsh/sessions.
 * @param options.now - injectable clock (tests).
 * @param options.thresholdMs - how recent a write counts as activity (default 2 min).
 * @returns { running, items: [{ id, at, running }] }.
 */
export function readSessionActivity(root, options = {}) {
  const dir = options.sessionsDir || path.join(os.homedir(), '.dsh', 'sessions');
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const thresholdMs = typeof options.thresholdMs === 'number' ? options.thresholdMs : 120000;
  const base = normalizePath(root);
  if (!base) return { running: 0, items: [] };
  /* Session folders encode the workspace as "--c-users-...-name--". */
  const needle = base.replace(/:/gu, '').replace(/\//gu, '-');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { running: 0, items: [] };
  }
  const items = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderNamesRoot = entry.name.toLowerCase().includes(needle);
    const workspaceDir = path.join(dir, entry.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const file = path.join(workspaceDir, session.name, 'session.v4.jsonl.zstd');
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const fresh = now - stat.mtimeMs <= thresholdMs;
      /* The journal owns the answer, idle or not; a folder name is the fallback. */
      const cwd = cachedSessionCwd(file, stat);
      const belongs = cwd ? isInsideRoot(cwd, root) : folderNamesRoot;
      if (!belongs || seen.has(session.name)) continue;
      seen.add(session.name);
      items.push({ id: session.name, at: stat.mtimeMs, running: fresh });
    }
  }
  items.sort((left, right) => right.at - left.at);
  return { running: items.filter((item) => item.running).length, items };
}

/**
 * How much of a journal is read to learn its workspace.
 *
 * The host writes the session header first and switches the working directory a few
 * milliseconds later, so both records sit in the first frames: measured on the live
 * journals of 2026-11-01, the switch is at byte 256-258 of the file. A prefix keeps
 * the call cheap, because one journal is up to 7 MB and thousands of frames.
 */
const JOURNAL_PREFIX_BYTES = 64 * 1024;

/**
 * How far into the prefix the switch of the working directory may lie.
 *
 * The host writes the switch as one of the first records, so there is no reason to
 * decompress the whole prefix: on the live journals of 2026-11-01 it sits at byte
 * 256-258, and 8 KB leaves a thirtyfold margin while keeping the scan cheap.
 */
const JOURNAL_SWITCH_WINDOW_BYTES = 8 * 1024;

/** zstd frame magic; a journal is a chain of frames, one per write. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** Start offsets of every zstd frame magic inside one buffer. */
function frameOffsets(buffer) {
  const offsets = [];
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] !== ZSTD_MAGIC[0] || buffer[index + 1] !== ZSTD_MAGIC[1]) continue;
    if (buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) offsets.push(index);
  }
  return offsets;
}

/** Read at most JOURNAL_PREFIX_BYTES of a file; null when it cannot be read. */
function readPrefix(file) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = Math.min(JOURNAL_PREFIX_BYTES, fs.fstatSync(handle).size || 0);
    if (!size) return null;
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(handle, buffer, 0, size, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        /* the buffer is already in hand; a failing close must not hide it */
      }
    }
  }
}

/** How many journals the cwd cache keeps; the live store of 2026-11-01 has ~400. */
const CWD_CACHE_LIMIT = 4096;

/**
 * Cwd of one session journal, memoized by the state of the file.
 *
 * One journal costs ~3 ms (a prefix read plus two zstd frames) and a pass asks for
 * every session of every key, so an uncached pass over the live store pays ~1.2 s.
 * The key is the file state, not the session id: a session that writes again changes
 * its mtime and is read again, so the cache cannot serve an answer the file has
 * already outgrown. A null answer is cached too — a journal that cannot be read today
 * costs nothing to refuse tomorrow.
 */
const cwdCache = new Map();

function cachedSessionCwd(file, stat) {
  const hit = cwdCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.cwd;
  const cwd = readSessionCwd(file);
  if (cwdCache.size >= CWD_CACHE_LIMIT) cwdCache.delete(cwdCache.keys().next().value);
  cwdCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, cwd });
  return cwd;
}

/**
 * The workspace a session file really belongs to, or null when the journal cannot
 * be read (no zstd in this Node, no file, not a journal at all).
 *
 * The first working-directory/change wins: it is the switch the host makes right
 * after creating the session, and it names the workspace the session was asked for.
 * The session header is the fallback, and it is honestly weaker: the header carries
 * the cwd of the PARENT.
 */
export function readSessionCwd(file) {
  if (typeof zlib.zstdDecompressSync !== 'function') return null;
  const buffer = readPrefix(file);
  if (!buffer) return null;
  const offsets = frameOffsets(buffer).filter((offset) => offset < JOURNAL_SWITCH_WINDOW_BYTES);
  let header = null;
  for (let index = 0; index < offsets.length; index += 1) {
    const next = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    /* The last frame of the prefix is cut by the prefix itself, so it gets a retry
       that runs to the end of what was read; every other frame ends at the next
       magic. Two attempts per frame keep the scan linear. */
    let text;
    for (const stop of next < buffer.length ? [next, buffer.length] : [buffer.length]) {
      try {
        text = zlib.zstdDecompressSync(buffer.subarray(offsets[index], stop)).toString('utf8');
        break;
      } catch {
        text = undefined;
      }
    }
    if (text === undefined) continue;
    for (const line of text.split('\n')) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record !== 'object') continue;
      if (record.type === 'working-directory/change' && record.data && typeof record.data.cwd === 'string') {
        return record.data.cwd;
      }
      if (!header && record.type === 'session' && typeof record.cwd === 'string') header = record.cwd;
    }
  }
  return header;
}

/** Terminal states of an agent that is no longer working; anything else is live. */
const FINISHED_STATES = new Set([
  'done', 'completed', 'complete', 'finished', 'stopped', 'stopping',
  'error', 'failed', 'cancelled', 'canceled', 'idle', 'inactive', 'disposed',
]);

/**
 * Normalize a path for comparison: one separator, no trailing slash, lower case.
 *
 * Windows is case-insensitive and the host may hand over either separator, so
 * `C:\\Work\\Project\\` and `c:/work/project` must compare equal. The function
 * only prepares a comparison key; the caller keeps the original string.
 */
export function normalizePath(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .replace(/\\/gu, '/')
    .replace(/\/{2,}/gu, '/')
    .replace(/\/+$/u, '')
    .toLowerCase();
}

/**
 * Is `cwd` the root itself or a folder inside it?
 *
 * A raw `startsWith` would attach `C:/Work/Application` to `C:/Work/App`; the
 * separator after the root is what makes it a child directory.
 */
export function isInsideRoot(cwd, root) {
  const target = normalizePath(cwd);
  const base = normalizePath(root);
  if (!target || !base) return false;
  /* The drive or share root has no meaningful trailing separator. */
  if (base === '/' || /^[a-z]:$/u.test(base)) return target.startsWith(base + '/') || target === base;
  return target === base || target.startsWith(base + '/');
}

/** Node ids from either node objects or bare ids, in declaration order. */
function nodeIds(nodes) {
  const result = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = typeof node === 'string' ? node : node && node.id;
    if (typeof id !== 'string' || !id.trim()) continue;
    const value = id.trim();
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Does the label contain the node id as a separate word?
 *
 * `judge`, `role:judge`, `acceptor:judge` and `judge — проверяет` all name the
 * node; `judgement` does not. Hyphen, underscore and digit are part of a word
 * (otherwise `judge-2` would match `judge`), while colon, space, slash and dot
 * are separators. A node id may itself contain a dot or a hyphen and is matched
 * literally between those boundaries.
 */
export function labelNamesNode(label, nodeId) {
  const text = String(label === undefined || label === null ? '' : label);
  const id = String(nodeId === undefined || nodeId === null ? '' : nodeId);
  if (!text.trim() || !id.trim()) return false;
  const pattern = new RegExp('(^|[^\\p{L}\\p{N}_-])' + escapeRegExp(id) + '($|[^\\p{L}\\p{N}_-])', 'iu');
  return pattern.test(text);
}

/** Fields a host may use for the human label of an agent, most specific first. */
const LABEL_FIELDS = ['label', 'title', 'role'];

/** The first non-empty label field, or an empty string. */
function labelOf(agent) {
  for (const field of LABEL_FIELDS) {
    const value = agent && agent[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** The node named by any label field of the agent, or null. */
function nodeOf(agent, ids) {
  for (const field of LABEL_FIELDS) {
    const value = agent && agent[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    for (const id of ids) {
      if (labelNamesNode(value, id)) return id;
    }
  }
  return null;
}

/** A stable identity for the agent, or an empty string. */
function idOf(agent) {
  for (const field of ['id', 'agentId', 'sessionId', 'childId']) {
    const value = agent && agent[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Whether the host still counts this agent as working. */
function isLive(agent) {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return false;
  if (agent.running === false || agent.alive === false) return false;
  const state = agent.state !== undefined ? agent.state : (agent.status !== undefined ? agent.status : '');
  const value = String(state || '').trim().toLowerCase();
  if (!value) return true;
  return !FINISHED_STATES.has(value);
}

/**
 * Map the live agents of the host onto the nodes of one project root.
 *
 * @param agents - live agents as the host reports them. Each one may carry
 *   `id` (or `agentId`/`sessionId`), `cwd`, and a `label`/`title`/`role`.
 *   Non-array input is treated as an empty list; a malformed agent is skipped.
 * @param root - project root. Only agents whose `cwd` is this folder or below it
 *   are attached; an agent of another root is not reported at all.
 * @param nodes - the structure's nodes (objects with `id`, or bare ids).
 * @returns `{ active, unknown, agents }`, where `active` is the list of node ids
 *   that have a live agent, `unknown` is the list of live agent ids whose label
 *   names no node, and `agents` carries the same agents in the shape
 *   `{ id, label, cwd, node }` for the route and the tests.
 */
export function mapLiveAgents(agents, root, nodes) {
  const result = { active: [], unknown: [], agents: [] };
  const base = normalizePath(root);
  if (!base) return result;
  const ids = nodeIds(nodes);
  const list = Array.isArray(agents) ? agents : [];
  for (const agent of list) {
    if (!isLive(agent)) continue;
    const cwd = agent && typeof agent.cwd === 'string' ? agent.cwd : '';
    /* A foreign root is not attached to any node and is not listed for this root. */
    if (!isInsideRoot(cwd, base)) continue;
    const id = idOf(agent);
    if (!id) continue;
    const label = labelOf(agent);
    const node = nodeOf(agent, ids);
    result.agents.push({ id, label, cwd, node });
    if (node) {
      if (!result.active.includes(node)) result.active.push(node);
    } else {
      result.unknown.push(id);
    }
  }
  return result;
}

/**
 * Two sessions this close in time are "equally fresh" for a person looking at the
 * panel: the journal is written on every step, so a minute is the scale at which
 * two open sessions cannot be told apart by mtime alone.
 */
const AMBIGUOUS_WINDOW_MS = 60 * 1000;

/** Sessions in one comparable shape, newest first, duplicates dropped by id. */
function sessionRows(sessions) {
  const rows = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) continue;
    const id = typeof session.id === 'string' ? session.id.trim() : '';
    if (!id) continue;
    const at = typeof session.at === 'number' && Number.isFinite(session.at) ? session.at : NaN;
    if (!Number.isFinite(at)) continue;
    rows.push({ id, at, running: session.running === true });
  }
  rows.sort((left, right) => right.at - left.at);
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/** Nodes in declaration order with their role, tolerant of bare ids. */
function nodeRows(nodes) {
  const rows = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = typeof node === 'string' ? node.trim() : (node && typeof node.id === 'string' ? node.id.trim() : '');
    if (!id) continue;
    const role = node && typeof node === 'object' && typeof node.role === 'string' ? node.role : '';
    rows.push({ id, role });
  }
  return rows;
}

/** The node an automatic binding lands on, or null when the structure has none. */
function autoNode(rows, folders) {
  const byId = new Map(rows.map((node) => [node.id, node]));
  for (const folder of Array.isArray(folders) ? folders : []) {
    if (!folder || typeof folder !== 'object' || Array.isArray(folder)) continue;
    const orchestrator = typeof folder.orchestrator === 'string' ? folder.orchestrator.trim() : '';
    /* A folder that names an unknown node is not evidence of anything: keep looking. */
    if (orchestrator && byId.has(orchestrator)) return orchestrator;
  }
  if (rows.length === 1) return rows[0].id;
  const coordinator = rows.find((node) => String(node.role || '').toLowerCase().includes('координатор'));
  if (coordinator) return coordinator.id;
  return rows.length > 0 ? rows[0].id : null;
}

/** The pin of this root: an exact key first, then the same path written differently. */
function pinOf(pins, root) {
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) return null;
  const key = typeof root === 'string' ? root : '';
  const exact = key && Object.hasOwn(pins, key) ? pins[key] : null;
  if (exact) return exact;
  const base = normalizePath(key);
  if (!base) return null;
  for (const [candidate, value] of Object.entries(pins)) {
    if (normalizePath(candidate) === base && value) return value;
  }
  return null;
}

/**
 * Bind one workspace session to one structure node, as a pure projection.
 *
 * The structure files stay untouched: who works here is a fact of the running host
 * and of the session journals, not a declaration a person has to maintain. Three
 * sources are tried in order and the chosen one is always named, because a silent
 * guess is indistinguishable from a declaration:
 *
 *   1. label — a live agent whose label names a node and whose id is a session of
 *      this workspace (the first such agent wins, in the order the host gave them);
 *   2. pin — `pins[root] = { node, session }`, honoured only while both the node
 *      and the session still exist;
 *   3. auto — the freshest session, placed on the folder's orchestrator, else on
 *      the only node, else on the node whose role says "координатор", else on the
 *      first declared node.
 *
 * Sessions within a minute of the freshest are listed in `ambiguous`: the binding
 * still points at the freshest, but the panel can show both instead of choosing
 * silently. No sessions means no-session, no nodes means no-node — both are honest
 * answers, not exceptions.
 *
 * @param input.root - workspace path, the key of the pin map.
 * @param input.sessions - [{ id, at, running }], any order.
 * @param input.nodes - structure nodes (objects with id/role, or bare ids).
 * @param input.folders - structure folders; the first orchestrator wins.
 * @param input.agents - live agents as mapLiveAgents returns them: [{ id, label, node }].
 * @param input.pins - the whole pin map, keyed by root.
 * @param input.now - injectable clock, unused by the projection itself (kept for
 *   callers that pass the same instant to the panel).
 * @returns `{ binding }` with `{ node, session, at, source, ambiguous }`, or
 *   `{ binding: null, reason: 'no-session'|'no-node' }`. Never reads or writes disk.
 */
export function bindSessions(input = {}) {
  const options = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  /* Accepted for one clock across the route and the panel; binding needs no "now". */
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  void now;
  const sessions = sessionRows(options.sessions);
  if (sessions.length === 0) return { binding: null, reason: 'no-session' };
  const nodes = nodeRows(options.nodes);
  if (nodes.length === 0) return { binding: null, reason: 'no-node' };

  const nodeSet = new Set(nodes.map((node) => node.id));
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const freshest = sessions[0];
  /* Newest first, including the freshest itself: "equally fresh" is a list. */
  const ambiguous = sessions
    .filter((session) => freshest.at - session.at <= AMBIGUOUS_WINDOW_MS)
    .map((session) => ({ id: session.id, at: session.at }));

  for (const agent of Array.isArray(options.agents) ? options.agents : []) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue;
    const id = typeof agent.id === 'string' ? agent.id.trim() : '';
    const node = typeof agent.node === 'string' ? agent.node.trim() : '';
    if (!id || !node || !nodeSet.has(node)) continue;
    const session = byId.get(id);
    if (!session) continue;
    return { binding: { node, session: id, at: session.at, source: 'label', ambiguous } };
  }

  const pin = pinOf(options.pins, options.root);
  if (pin && typeof pin === 'object' && !Array.isArray(pin)) {
    const node = typeof pin.node === 'string' ? pin.node.trim() : '';
    const sessionId = typeof pin.session === 'string' ? pin.session.trim() : '';
    const session = sessionId ? byId.get(sessionId) : null;
    /* A pin to a deleted node or a closed session is not a binding: fall back to auto. */
    if (node && nodeSet.has(node) && session) {
      return { binding: { node, session: sessionId, at: session.at, source: 'pin', ambiguous } };
    }
  }

  const node = autoNode(nodes, options.folders);
  if (!node) return { binding: null, reason: 'no-node' };
  return { binding: { node, session: freshest.id, at: freshest.at, source: 'auto', ambiguous } };
}

/**
 * Active nodes with the source of every activity, as a pure projection.
 *
 * The host's agent service only shows the children of the open session, so a
 * workspace whose work runs in another session used to look free: its nodes got
 * no live agent and the panel called them idle. The session journals are the
 * second source — bindSessions already put the freshest session on a node, and
 * readSessionActivity already knows whether that session is still writing. This
 * function connects the two facts without inventing a third.
 *
 * Rules, in order:
 *
 *   1. every node with a live agent is active, source 'agent';
 *   2. if the binding names a node and its session is running (the same 2 min
 *      threshold as readSessionActivity), that node is active too;
 *   3. when both sources name one node, the answer stays 'agent': an agent is a
 *      stronger fact than a freshly written file, and the panel must not
 *      downgrade it;
 *   4. a stale journal does not make a node active, and a binding without a
 *      matching session row proves nothing.
 *
 * The journal never names a node by itself: only the binding's node is promoted.
 * `unknown` is not part of this projection — a session is not an agent, so it
 * is not counted as an unnamed agent either.
 *
 * @param input.active - node ids that have a live agent (mapLiveAgents.active).
 * @param input.binding - the bindSessions projection, or null.
 * @param input.sessions - [{ id, at, running }], any order (sessions.items).
 * @returns `{ active, activityByNode }`: node ids, agents first, each node's
 *   source 'agent' or 'session'.
 */
export function mapNodeActivity(input = {}) {
  const options = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const active = [];
  const activityByNode = {};
  for (const item of Array.isArray(options.active) ? options.active : []) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (!id || activityByNode[id]) continue;
    active.push(id);
    activityByNode[id] = 'agent';
  }
  const binding = options.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return { active, activityByNode };
  const node = typeof binding.node === 'string' ? binding.node.trim() : '';
  const sessionId = typeof binding.session === 'string' ? binding.session.trim() : '';
  if (!node || !sessionId) return { active, activityByNode };
  const session = sessionRows(options.sessions).find((row) => row.id === sessionId);
  if (!session || session.running !== true) return { active, activityByNode };
  if (!active.includes(node)) active.push(node);
  /* An agent on the same node is the stronger fact; never downgrade it. */
  if (!activityByNode[node]) activityByNode[node] = 'session';
  return { active, activityByNode };
}

/**
 * How old a running record may be and still prove that a node is working.
 *
 * The run store keeps its history: a process killed in the middle of a run
 * leaves a record that says "running" forever. A day is longer than any honest
 * run of one node and short enough that yesterday's crash cannot light a node
 * up today; the panel must not call a free node busy because of an old file.
 */
export const RUN_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Active nodes with the source of every activity, taken from the run journal.
 *
 * The run store is the only source that names the node actually working: the
 * host's agent service sees only the children of the open session, and the
 * session binding points at the freshest session of the workspace, which is the
 * orchestrator — so during a run of the judge or the worker the binding lit the
 * coordinator and the working node stayed grey. A record `{ node, state: 'running',
 * root, since }` written by the tools themselves is the exact fact of the run.
 *
 * Rules, in order:
 *
 *   1. a live agent keeps its node active with source 'agent' — the stronger fact;
 *   2. a record counts only when it belongs to THIS root (compared after
 *      normalizePath), names a node declared by the structure, says 'running',
 *      and started no more than RUN_ACTIVITY_WINDOW_MS ago;
 *   3. such a node becomes active with source 'run'; an agent on the same node is
 *      never downgraded to 'run';
 *   4. a finished run ('done'/'error'), a foreign root, a stale record and an
 *      unknown node prove nothing and create no activity.
 *
 * The session source is not part of this projection: mapNodeActivity computes it
 * from the binding, and the route merges the two with the order agent > run >
 * session. `active` lists agents first, then runs, in the order they were given.
 *
 * @param input.active - node ids that have a live agent (mapLiveAgents.active).
 * @param input.runs - run records of this root (listRuns), any order.
 * @param input.nodes - structure nodes (objects with id, or bare ids).
 * @param input.root - workspace path the records must belong to.
 * @param input.now - injectable clock, defaults to Date.now().
 * @param input.windowMs - freshness window, defaults to RUN_ACTIVITY_WINDOW_MS.
 * @returns `{ active, activityByNode }`: node ids, agents first, each node's
 *   source 'agent' or 'run'. Never reads or writes disk.
 */
export function mapRunActivity(input = {}) {
  const options = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const active = [];
  const activityByNode = {};
  for (const item of Array.isArray(options.active) ? options.active : []) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (!id || activityByNode[id]) continue;
    active.push(id);
    activityByNode[id] = 'agent';
  }
  const base = normalizePath(options.root);
  if (!base) return { active, activityByNode };
  const declared = new Set(nodeIds(options.nodes));
  if (declared.size === 0) return { active, activityByNode };
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  const windowMs = typeof options.windowMs === 'number' && Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : RUN_ACTIVITY_WINDOW_MS;
  for (const record of Array.isArray(options.runs) ? options.runs : []) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const state = typeof record.state === 'string' ? record.state.trim().toLowerCase() : '';
    /* A finished run is history, not activity: only 'running' proves work. */
    if (state !== 'running') continue;
    const node = typeof record.node === 'string' ? record.node.trim() : '';
    /* The journal never invents a node: an id outside the structure is not activity. */
    if (!node || !declared.has(node)) continue;
    /* Records of another workspace are not evidence about this one. */
    if (normalizePath(record.root) !== base) continue;
    const since = typeof record.since === 'number' && Number.isFinite(record.since) ? record.since : null;
    /* Without a start there is no way to tell a live run from a leftover; refuse it. */
    if (since === null) continue;
    if (now - since > windowMs) continue;
    /* A live agent on the same node is the stronger fact; never downgrade it. */
    if (activityByNode[node]) continue;
    active.push(node);
    activityByNode[node] = 'run';
  }
  return { active, activityByNode };
}
