/**
 * Parent of a host-started run: only an agent of the target workspace.
 *
 * A host-started child (a scheduled node, an exchange wake) is born in its
 * parent's session, and a session carries the workspace folder. A parent from
 * ANOTHER workspace therefore gives birth to a child that reads the wrong folder:
 * the run record says one root, the child works in another, and the activation
 * itself fails with "the agent finished without a report" — the live failure of
 * the nightly critic in ws-school-app (2026-11-05).
 *
 * The rule is strict on purpose: no live agent in the target workspace means no
 * run. The reason names the workspace, so the run journal says what to open
 * instead of quietly borrowing a stranger.
 *
 * "Own" means the agent's cwd is inside the root, the root itself or a nested
 * folder. Windows compares case-insensitively and ignores a trailing slash; that
 * normalization lives in lib/live.js and is shared through isInsideRoot.
 *
 * The cwd is not always a field of the agent: the host keeps it in the session
 * (`agent.session.meta.cwd`, then `agent.session.cwd`) and in the session journal
 * (`readSessionCwd` from lib/live.js). 0079 stopped the borrowing of a foreign
 * agent but read only `agent.cwd`, so the nightly critic of 2026-11-05 stopped
 * with "no live agent in the workspace" while a live session WAS there — the
 * agent object simply carries no folder. resolveAgentCwd is the cascade that
 * makes such an agent provable as "own"; the journal is only ever read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInsideRoot, readSessionCwd } from './live.js';

export { isInsideRoot };

/** The journal DSH writes for one session; the only on-disk source of its cwd. */
const SESSION_JOURNAL_FILE = 'session.v4.jsonl.zstd';

/** Default sessions folder; same default as lib/live.js readSessionActivity. */
function defaultSessionsDir() {
  return path.join(os.homedir(), '.dsh', 'sessions');
}

/**
 * How many answers one process remembers. The live store of 2026-11-01 keeps ~400
 * journals and a handful of live agents, so this bound is never reached in normal
 * work; it only keeps a long-lived host from growing a map without an end.
 */
const CWD_CACHE_LIMIT = 512;

/** Session id -> journal file, so a repeated pick does not rescan every key. */
const sessionFiles = new Map();

/** Journal file -> { mtimeMs, size, cwd }, the same key lib/live.js uses. */
const journalCwds = new Map();

/** Remember one answer, dropping the oldest entry when the bound is reached. */
function remember(map, key, value) {
  if (map.size >= CWD_CACHE_LIMIT) map.delete(map.keys().next().value);
  map.set(key, value);
}

/**
 * A folder usable for comparison: absolute, no trailing slash.
 *
 * Empty, non-string and whitespace-only input is "unknown" (null), not the cwd.
 * A Windows path keeps its shape on any platform: the host and the structure files
 * use it as text, so a drive letter is absolute even when read on another OS.
 */
function normalizeCwd(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (/^[a-zA-Z]:[\\/]/u.test(text) || /^\\\\/u.test(text)) {
    const trimmed = text.replace(/[\\/]+$/u, '');
    return /^[a-zA-Z]:$/u.test(trimmed) ? text : (trimmed || text);
  }
  try {
    return path.resolve(text);
  } catch {
    return null;
  }
}

/** Session id of an agent, whether `session` is the object or the bare id. */
function sessionIdOf(agent) {
  const session = agent && agent.session;
  if (typeof session === 'string') return session.trim();
  if (!session || typeof session !== 'object') return '';
  return typeof session.id === 'string' ? session.id.trim() : '';
}

/**
 * The journal file of one session, or null when the folder is not there.
 *
 * DSH files every session under the key of its parent workspace, so the folder
 * name says nothing about the session id: the whole sessions folder is scanned,
 * and the found path is remembered. A remembered path is checked before use, so
 * a closed or moved session is found again instead of being served from a stale
 * answer.
 */
function findSessionFile(sessionId, sessionsDir) {
  const known = sessionFiles.get(sessionId);
  if (known) {
    try {
      if (fs.statSync(known).isFile()) return known;
    } catch {
      sessionFiles.delete(sessionId);
    }
  }
  let keys = [];
  try {
    keys = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const key of keys) {
    if (!key.isDirectory()) continue;
    const workspaceDir = path.join(sessionsDir, key.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory() || session.name !== sessionId) continue;
      const file = path.join(workspaceDir, session.name, SESSION_JOURNAL_FILE);
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      remember(sessionFiles, sessionId, file);
      return file;
    }
  }
  return null;
}

/**
 * Cwd of one session journal, memoized by the state of its file.
 *
 * The key is mtime/size, not the session id: a journal that wrote again is read
 * again, so the cache cannot serve an answer the file has outgrown. A null answer
 * is cached too — a journal that cannot be read costs nothing to refuse twice.
 */
function journalCwd(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = journalCwds.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.cwd;
  let cwd = null;
  try {
    const read = readSessionCwd(file);
    cwd = typeof read === 'string' ? read : null;
  } catch {
    /* a broken journal is no evidence, never an exception */
    cwd = null;
  }
  remember(journalCwds, file, { mtimeMs: stat.mtimeMs, size: stat.size, cwd });
  return cwd;
}

/**
 * The workspace folder of one agent, by the cascade the host actually fills.
 *
 * Order, first non-empty wins:
 *   1. `agent.cwd` — the direct field, the strongest and cheapest answer;
 *   2. `agent.session.meta.cwd` — where a live session keeps its folder;
 *   3. `agent.session.cwd` — the same fact in the shorter shape;
 *   4. the session journal of `agent.session.id`, read through lib/live.js
 *      `readSessionCwd` and memoized by mtime/size.
 *
 * An agent that has none of them is "unknown": null, never a throw. The read is
 * bounded by the caller's `sessionsDir` (default ~/.dsh/sessions) and never
 * writes anything, so a tick of the scheduler stays a read.
 *
 * @param agent - live agent as the host reports it; `session` may be absent.
 * @param options.sessionsDir - sessions folder, defaults to ~/.dsh/sessions.
 * @returns { string | null } absolute normalized path, or null when unknown.
 */
export function resolveAgentCwd(agent, options = {}) {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null;
  const direct = normalizeCwd(agent.cwd);
  if (direct) return direct;
  const session = agent.session;
  if (session && typeof session === 'object' && !Array.isArray(session)) {
    const meta = session.meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const fromMeta = normalizeCwd(meta.cwd);
      if (fromMeta) return fromMeta;
    }
    const fromSession = normalizeCwd(session.cwd);
    if (fromSession) return fromSession;
  }
  const sessionId = sessionIdOf(agent);
  if (!sessionId) return null;
  const sessionsDir = options && typeof options.sessionsDir === 'string' && options.sessionsDir.trim()
    ? options.sessionsDir.trim()
    : defaultSessionsDir();
  const file = findSessionFile(sessionId, sessionsDir);
  if (!file) return null;
  return normalizeCwd(journalCwd(file));
}

/** Short label of an agent for a human-readable reason; never throws. */
function agentLabel(agent) {
  const value = agent && (agent.label || agent.name || agent.id || agent.sessionId || agent.session);
  const text = typeof value === 'string' ? value.trim() : '';
  return text || 'без метки';
}

/** Why nobody of the list belongs to `base`; the old wording stays for foreign agents. */
function noParentReason(base, withoutCwd) {
  const note = withoutCwd > 0
    ? ' (cwd ' + (withoutCwd === 1 ? 'агента' : 'агентов')
      + ' неизвестен: ни сам агент, ни его сессия не назвали папку)'
    : '';
  return 'нет живого агента в воркспейсе ' + base + note
    + ' — откройте сессию в этом воркспейсе; пропуск не догоняется';
}

/**
 * Pick the parent of a run in `root`.
 *
 * The first agent whose cwd — direct or resolved from its session/journal — lies
 * inside the root wins; an agent whose cwd is unknown is not "own" (it cannot be
 * proven to belong to this workspace) and is skipped instead of throwing, while
 * the reason says that its cwd is unknown. When nobody belongs to the root the
 * answer is `{ parent: null, reason }`, where the reason names the workspace and
 * the action.
 *
 * A resolved cwd is written back onto a chosen agent that lacked one, so a caller
 * holding the parent handle sees the workspace it was proven to have; an agent
 * object that refuses the write keeps its own fields and the choice still stands.
 *
 * @param {{ agents?: unknown, root?: unknown, sessionsDir?: unknown }} input -
 *   live agents, target root and the sessions folder the cascade may read.
 * @returns {{ parent: object | null, reason: string }}
 */
export function pickParent({ agents, root, sessionsDir } = {}) {
  const base = root === undefined || root === null ? '' : String(root).trim();
  const list = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent && typeof agent === 'object');
  if (list.length === 0) {
    return { parent: null, reason: 'нет живых агентов в DSH — откройте сессию; пропуск не догоняется' };
  }
  if (!base) {
    return { parent: null, reason: 'не указан воркспейс запуска — откройте сессию в нужном воркспейсе; пропуск не догоняется' };
  }
  const options = typeof sessionsDir === 'string' && sessionsDir.trim() ? { sessionsDir: sessionsDir.trim() } : {};
  const rows = list.map((agent) => ({ agent, cwd: resolveAgentCwd(agent, options) }));
  const own = rows.find((row) => row.cwd && isInsideRoot(row.cwd, base));
  if (own) {
    if (typeof own.agent.cwd !== 'string' || own.agent.cwd.trim() === '') {
      try {
        own.agent.cwd = own.cwd;
      } catch {
        /* a frozen agent keeps its own fields; the proven cwd still decided the pick */
      }
    }
    return { parent: own.agent, reason: 'агент ' + agentLabel(own.agent) + ' воркспейса ' + base };
  }
  const withoutCwd = rows.filter((row) => !row.cwd).length;
  return { parent: null, reason: noParentReason(base, withoutCwd) };
}
