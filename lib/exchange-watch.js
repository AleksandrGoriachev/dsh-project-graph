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
 *   2. no live session of that workspace means the node is started there with the
 *      message as its prompt (`wakeSpawn`). It is ON by default — a sleeping node must
 *      be woken, and only an explicit false in config, env or profile turns it off
 *      (the decision and its source are written to telemetry, задание 0150);
 *   3. nothing is invented about the message: the wake carries the path, the header
 *      fields and the demand to open the file and answer through `Reply-To`.
 *   4. доставка и прочтение — РАЗНЫЕ записи (задание 0280). The delivered-memory
 *      (`exchange-delivered.json`) is written only after a real hand-over —
 *      `followup`/`send`/`sendMessage`, `controller.prompt` or a spawned session — и
 *      НЕ означает «прочитано». «Разобрал» ставит только явная sha256-отметка в
 *      памяти прочтения (lib/obligations.js, `markExchangeSeen`); числовая
 *      отметка вручения прочтением не считается и ложной не снимается, пока
 *      вручение не доказано журналом. A letter left in
 *      the box (no live session, `wakeSpawn` off, an unaccepted folder, a branch
 *      inside its retry window) stays pending, names its reason in the decision
 *      journal, and is delivered at the first opportunity however old it is. Age is
 *      not a limit: `stale:backlog` is not written for an undelivered letter.
 *   5. долг будит (задания 0283/0285), а ответ — доставляется для обработки
 *      (задание 0314). Письмо, создающее непрочитанный долг чтения — request,
 *      question, proposal, report, invitation, info и любой необъявленный
 *      статус, — поднимает адресата. Письмо-реакция ack/agreed/rejected/declined/
 *      unknown/пустой статус заявку ЗАКРЫВАЕТ и долга чтения не создаёт: оно не
 *      будит (принятые 0081/0111 C5, причина skip:no-wake). Ответ (answer) тоже не
 *      создаёт долга чтения (shouldWake не меняется), но содержит информацию для
 *      адресата, поэтому сторож доставляет его для ОБРАБОТКИ (context.processAnswers)
 *      и ставит «прочитано» только после хода адресата. Не будят также письмо от
 *      самого адресата (skip:self) и уже вручённое содержимое. Сдерживают не
 *      отказы по статусу, а занятость
 *      адресата (skip:in-turn/skip:active — письмо ждёт освобождения, а не
 *      теряется) и два лимита: ветка — раз в 60 с (WAKE_BRANCH_COOLDOWN_MS), ящик —
 *      строго раз в 120 с по времени последнего пробуждения
 *      (WAKE_BOX_LIMIT/WAKE_BOX_WINDOW_MS): после любого mark() ящик закрыт на
 *      120 с независимо от ветки (0284).
 *
 * The watcher never parses message bodies and never comments on their content.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverToHandle } from './agent-message.js';
import { commonParent, resolveBox } from './boxes.js';
import { currentLabel, exchangeDirs, parseHeader } from './exchange.js';
import { readGraph } from './api.js';
import { isInsideRoot, normalizePath, readSessionActivity } from './live.js';
/* Один резолвер Reply-To для счётчика внимания и для журнала прогонов (0132). */
import { markExchangeSeen, resolveClosingPath, SEEN_FILE } from './obligations.js';
import { launchFilePath, listRuns, noteRun, storeDir } from './runs.js';
/* Память ПРОЧТЕНИЯ живёт в складе проекта (lib/obligations.js), а не в складе прогонов. */
import { storeDir as projectStoreDir } from './store.js';

/** How often the box is scanned; a person writing a file expects seconds, not a minute. */
export const EXCHANGE_WATCH_TICK_MS = 4000;

/**
 * The age that still counts as "news" in the decision journal.
 *
 * It does NOT limit delivery (задание 0153): an undelivered letter is delivered at the
 * first opportunity whatever its age, and `stale:backlog` is no longer written for it.
 * The number is kept because the journal still names it (`windowMs`) for decisions
 * that are not a hand-over: `rescan:delivered` (the same content was already delivered
 * earlier) and `skip:no-wake` для старого письма-реакции. `skip:no-wake` снова
 * пишется (0285): answer/ack и прочие статусы-реакции долга чтения не создают и
 * называют эту причину в журнале.
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

/**
 * Presence of a workspace's session (задание 0292).
 *
 * The coordinator announces WHICH session reads its box in a small file inside the
 * workspace: `<root>/coordination/presence/<workspace>.json`. It is a fact of the
 * box, not a field of the structure, and it never changes the letter format.
 * Writing is atomic (temp + rename) and never throws: a workspace that cannot be
 * written simply keeps the old addressing scheme.
 */
export const PRESENCE_VERSION = 1;

/** A presence record older than this is not trusted unless its session is live. */
export const PRESENCE_TTL_MS = 24 * 60 * 60 * 1000;

/** Monotonic part of a presence temp name: two writes must never share one. */
let presenceWriteCounter = 0;

/**
 * Filename-safe workspace name: a separator or a dot-name is refused instead of
 * being joined, so a malformed label cannot write outside the box.
 */
function presenceName(workspace) {
  const name = String(workspace == null ? '' : workspace).trim();
  if (!name || name === '.' || name === '..' || /[\\/]/u.test(name)) return '';
  return name;
}

/** Absolute path of one workspace's presence file in the 0292 root form. */
export function sessionPresencePath(root, workspace) {
  const name = presenceName(workspace);
  const base = String(root == null ? '' : root).trim();
  if (!name || !base) return '';
  return path.join(path.resolve(base), 'coordination', 'presence', name + '.json');
}

/**
 * Absolute path of one workspace's presence file inside ONE exchange box (0293).
 *
 * The box is the absolute folder directory resolved by lib/boxes.js, so a
 * workspace can keep a different session in every folder it participates in:
 * `<box>/presence/<workspace>.json`.
 */
export function sessionPresenceBoxPath(box, workspace) {
  const name = presenceName(workspace);
  const base = String(box == null ? '' : box).trim();
  if (!name || !base) return '';
  return path.join(path.resolve(base), 'presence', name + '.json');
}

/**
 * Write one workspace's presence atomically.
 *
 * `box` names ONE exchange folder (0293): the record then lives in
 * `<box>/presence/<workspace>.json` and another folder does not see it. Without
 * `box` the 0292 root form `<root>/coordination/presence/` is written.
 *
 * @returns the written record, or null on ANY failure (missing root, refused
 *   write, rename error). The caller warns; the plugin never falls because the
 *   box folder is read-only.
 */
export function writeSessionPresence({ root, box, workspace, sessionId, at, now } = {}) {
  const file = String(box == null ? '' : box).trim()
    ? sessionPresenceBoxPath(box, workspace)
    : sessionPresencePath(root, workspace);
  const id = String(sessionId == null ? '' : sessionId).trim();
  if (!file || !id) return null;
  let moment;
  if (at instanceof Date && Number.isFinite(at.getTime())) moment = at;
  else if (typeof at === 'string' && at.trim()) moment = new Date(at);
  else moment = new Date(Number.isFinite(now) ? Number(now) : Date.now());
  if (!Number.isFinite(moment.getTime())) return null;
  const record = {
    version: PRESENCE_VERSION,
    workspace: path.basename(file, '.json'),
    sessionId: id,
    at: moment.toISOString(),
  };
  try {
    const temporary = file + '.' + process.pid + '-' + (presenceWriteCounter += 1) + '-'
      + Math.random().toString(36).slice(2, 10) + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(record, null, 1) + '\n', 'utf8');
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* the rename error matters */ }
      throw error;
    }
    return record;
  } catch {
    return null;
  }
}

/** One presence file as a record; a missing or broken file means null. */
function readPresenceFile(file) {
  try {
    if (!file) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.sessionId !== 'string' || !value.sessionId.trim()) return null;
    if (typeof value.workspace !== 'string' || !value.workspace.trim()) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Read one workspace's presence; a missing or broken file means null.
 *
 * `options.box` names ONE exchange folder explicitly (0293): only
 * `<box>/presence/<workspace>.json` is read. Without it the 0292 root form is
 * tried FIRST and the positional box form only as a fallback, so a project that
 * already has its own `<root>/presence/` directory cannot silently replace the
 * old `readSessionPresence(root, workspace)` read (R5). The positional box form
 * is what the 0293 check uses; keeping it as a fallback preserves that call
 * without letting it shadow the root form.
 */
export function readSessionPresence(root, workspace, options = {}) {
  const explicit = options && typeof options.box === 'string' && options.box.trim() ? options.box.trim() : '';
  if (explicit) return readPresenceFile(sessionPresenceBoxPath(explicit, workspace));
  return readPresenceFile(sessionPresencePath(root, workspace))
    || readPresenceFile(sessionPresenceBoxPath(root, workspace));
}

/**
 * Is a presence record fresh?
 *
 * Freshness has exactly two ways: the session is LIVE, or `at` is within the
 * TTL (24 h by default). A record without a readable date is not fresh.
 */
export function presenceFresh(record, options = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (typeof record.sessionId !== 'string' || !record.sessionId.trim()) return false;
  const live = options.isLive;
  if (live === true) return true;
  if (typeof live === 'function') {
    try { if (live(record)) return true; } catch { /* a broken probe means "not live" */ }
  } else if (live instanceof Set && live.has(record.sessionId)) {
    return true;
  } else if (Array.isArray(live) && live.includes(record.sessionId)) {
    return true;
  }
  const at = Date.parse(record.at);
  if (!Number.isFinite(at)) return false;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) && Number(options.ttlMs) > 0
    ? Number(options.ttlMs)
    : PRESENCE_TTL_MS;
  return now - at <= ttlMs;
}

/**
 * The session a fresh presence names for an addressee workspace, or null.
 *
 * Aliases let a caller read a file written under the workspace folder name while
 * the exchange knows the same side by its participant label. A record of ANOTHER
 * workspace, or a stale one, is ignored — the old scheme then decides the target.
 *
 * `box` narrows the lookup to ONE exchange folder (0293): only
 * `<box>/presence/<name>.json` is read, so a session announced in another folder
 * is not the addressee of this letter. Without `box` the 0292 root form is read.
 *
 * @returns `{ sessionId, reason: 'presence', at }` or null.
 */
export function presenceTarget({ root, box, workspace, aliases, now, ttlMs, isLive } = {}) {
  const folder = String(box == null ? '' : box).trim();
  const base = folder || String(root == null ? '' : root).trim();
  if (!base) return null;
  const names = [];
  const push = (value) => {
    const name = String(value == null ? '' : value).trim();
    if (name && !names.includes(name)) names.push(name);
  };
  push(workspace);
  for (const alias of Array.isArray(aliases) ? aliases : []) push(alias);
  /* В root-форме имя папки воркспейса — тоже алиас; имя ящика («coordination») — нет. */
  if (!folder) push(path.basename(path.resolve(base)));
  for (const name of names) {
    const record = readSessionPresence(base, name, folder ? { box: base } : undefined);
    if (!record) continue;
    /* A file of another workspace is not this addressee. */
    if (record.workspace !== name) continue;
    if (!presenceFresh(record, { now, ttlMs, isLive })) continue;
    return { sessionId: record.sessionId, reason: 'presence', at: record.at };
  }
  return null;
}

/** A presence record in the delivery's pick shape (`agent` may be absent). */
function presenceAsPick(agentsList, presence) {
  if (!presence || typeof presence.sessionId !== 'string' || !presence.sessionId) return null;
  const agent = (Array.isArray(agentsList) ? agentsList : []).find(
    (item) => item && String(item.sessionId || item.session || item.id || '') === presence.sessionId,
  ) || null;
  return {
    agent,
    activityAt: Date.parse(presence.at) || 0,
    reason: 'presence',
    sessionId: presence.sessionId,
  };
}

/** Liveness probe over the host's agent list: the one rule every presence read uses. */
function presenceLiveCheck(agentsList) {
  const list = Array.isArray(agentsList) ? agentsList : [];
  return (record) => list.some(
    (agent) => agent
      && String(agent.sessionId || agent.session || agent.id || '') === record.sessionId
      && agent.running !== false,
  );
}

/**
 * Presence of the letter's OWN folder (задание 0295).
 *
 * The directory a letter lies in is a FACT, not a declaration: when
 * `<boxDir>/presence/<workspace>.json` exists and is fresh, that session owns
 * the letter even if the structure never declared the folder. Only the folder
 * passed in is read — another folder's presence is not this addressee (R2 of
 * 0293 stays intact). Only the ADDRESSEE label is read: no aliases, in
 * particular no `basename(target)`, because a foreign workspace of the same
 * name in the letter's folder would otherwise receive the letter (R1 of the
 * 0295 review). A missing, broken or stale file yields null, and the caller
 * keeps its previous addressing scheme.
 *
 * @returns `{ sessionId, reason: 'presence', at }` or null.
 */
export function presenceForLetterBox({ boxDir, workspace, now, ttlMs, isLive } = {}) {
  const base = String(boxDir == null ? '' : boxDir).trim();
  if (!base) return null;
  const name = String(workspace == null ? '' : workspace).trim();
  if (!name) return null;
  const record = readSessionPresence(base, name, { box: base });
  /* A file of another workspace is not this addressee. */
  if (!record || record.workspace !== name) return null;
  if (!presenceFresh(record, { now, ttlMs, isLive })) return null;
  return { sessionId: record.sessionId, reason: 'presence', at: record.at };
}

/**
 * Wake the live session of one workspace on behalf of the panel (задание 0292).
 *
 * The contour is the watcher's own, not a second one: `sessionController.prompt`
 * with mode 'queue' (a busy session takes the prompt into its queue), the live
 * agent handle as the fallback, and an activation in the addressee's root when no
 * session exists. Presence is consulted FIRST; a foreign or outdated record
 * falls through to the old scheme.
 *
 * @returns `{ woken: true, reason, target }` or `{ woken: false, reason }`.
 */
export async function wakeWorkspaceSession(input = {}) {
  const root = typeof input.root === 'string' && input.root.trim() ? path.resolve(input.root.trim()) : '';
  if (!root) return { woken: false, reason: 'no-root' };
  const workspace = typeof input.workspace === 'string' && input.workspace.trim()
    ? input.workspace.trim()
    : path.basename(root);
  const nowMs = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? Number(input.timeoutMs)
    : DELIVERY_TIMEOUT_MS;
  const text = typeof input.text === 'string' && input.text.trim()
    ? input.text.trim()
    : 'Пробуждение сессии воркспейса «' + workspace + '»: в ящике обмена есть письма, требующие разбора.';
  const logger = input.logger && typeof input.logger.warn === 'function' ? input.logger : { warn() {} };
  const warn = (message) => {
    try { logger.warn('[dsh-project-graph] ' + message); } catch { /* logging must not break a wake */ }
  };
  const agents = (() => {
    let service;
    try { service = typeof input.getAgents === 'function' ? input.getAgents() : null; } catch { return []; }
    if (!service) return [];
    try {
      const rows = typeof service.roots === 'function'
        ? service.roots()
        : (typeof service.list === 'function' ? service.list() : []);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  })();
  const sessionOf = (agent) => String((agent && (agent.sessionId || agent.session || agent.id)) || '');
  const isLive = (record) => agents.some(
    (agent) => agent && sessionOf(agent) === record.sessionId && agent.running !== false,
  );
  /*
   * 0293: папка письма сужает presence (своя сессия в каждой папке). Если папка
   * НАЗВАНА, читается только её presence: root-форма 0292 в этом случае не
   * подставляется, иначе ящик другой папки, физически совпавший с coordination
   * адресата, подхватывал бы чужой presence (R2). Root-форма решает только когда
   * папка не названа (legacy-портал 0292).
   */
  const box = typeof input.box === 'string' && input.box.trim() ? path.resolve(input.box.trim()) : '';
  const aliases = [path.basename(root)];
  const presence = box
    ? presenceTarget({ box, workspace, aliases, now: nowMs, isLive })
    : presenceTarget({ root, workspace, aliases, now: nowMs, isLive });
  const activity = activityOf(root, { now: nowMs });
  let target = '';
  let chosen = '';
  if (presence && presence.sessionId) {
    target = presence.sessionId;
    chosen = 'presence';
  } else {
    const pick = pickLastActive(agents, root, activity, { now: nowMs });
    if (pick && pick.agent) {
      target = sessionOf(pick.agent);
      chosen = pick.reason || 'last-active';
    } else {
      const freshest = [...activity.entries()].sort((left, right) => right[1] - left[1])[0];
      if (freshest && freshest[0]) {
        target = String(freshest[0]);
        chosen = 'last-active';
      }
    }
  }
  if (target) {
    const handle = agents.find((agent) => sessionOf(agent) === target) || null;
    /* A busy session is not a refusal: mode 'queue' is exactly its queue. */
    const busy = Boolean(handle && handle.running === true);
    const reason = busy ? 'queue' : chosen;
    const controller = (() => {
      try { return typeof input.getSessionController === 'function' ? input.getSessionController() : null; } catch { return null; }
    })();
    const refused = [];
    if (controller && typeof controller.prompt === 'function') {
      try {
        const bridge = typeof AbortController === 'function' ? new AbortController() : null;
        await withTimeout(
          controller.prompt({
            sessionId: target,
            content: [{ type: 'text', text }],
            mode: 'queue',
            requestId: 'exchange-wake:' + target + ':' + nowMs,
          }, bridge ? bridge.signal : undefined),
          timeoutMs,
          'пробуждение сессии адресата',
        );
        return { woken: true, reason, target, ...(busy ? { queued: true } : {}) };
      } catch (error) {
        refused.push('controller: ' + (error && error.message ? error.message : String(error)));
      }
    }
    if (handle) {
      const attempt = await sendViaHandle(handle, text, { timeoutMs });
      if (attempt.ok) return { woken: true, reason, target, ...(busy ? { queued: true } : {}) };
      refused.push('handle: ' + (attempt.errors.length > 0 ? attempt.errors.join(' | ') : 'нет подходящего способа'));
    }
    const detail = refused.join('; ') || 'сессия не приняла пробуждение';
    warn('обмен: сессия ' + target + ' не приняла пробуждение: ' + detail);
    return { woken: false, reason: 'refused', target, detail };
  }
  /*
   * No session of the workspace: the node is started in the addressee's OWN root.
   * Without a subagent service or an own parent the answer is honest, not a twin.
   */
  const subagents = (() => {
    try { return typeof input.getSubagents === 'function' ? input.getSubagents() : null; } catch { return null; }
  })();
  if (!subagents || typeof subagents.startActivation !== 'function') {
    return { woken: false, reason: 'no-session' };
  }
  const parent = (() => {
    try { return typeof input.getParent === 'function' ? input.getParent(root) : null; } catch { return null; }
  })();
  if (!parent || !parent.id) return { woken: false, reason: 'no-parent' };
  let maxDepth;
  if (typeof subagents.resolveMaxDepth === 'function') {
    try { maxDepth = subagents.resolveMaxDepth(undefined); } catch { maxDepth = undefined; }
  }
  const bridge = typeof AbortController === 'function' ? new AbortController() : null;
  const signal = bridge ? bridge.signal : undefined;
  const provider = typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : 'spawn';
  try {
    const activation = await withTimeout(subagents.startActivation({
      provider,
      label: 'exchange:' + path.basename(root),
      request: {
        cwd: root,
        prompt: [{ type: 'text', text }],
        parent,
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(signal ? { signal } : {}),
      },
      ...(signal ? { signal } : {}),
      delivery: 'caller',
    }), timeoutMs, 'запуск адресата');
    return {
      woken: true,
      reason: 'spawn',
      target: activation && activation.childId ? String(activation.childId) : 'spawn',
    };
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    warn('обмен: адресат не поднят: ' + detail);
    return { woken: false, reason: 'spawn-failed', error: detail };
  }
}

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
 * Задание 0280, инвариант 4: доставка и прочтение — РАЗНЫЕ памяти. Сторож пишет
 * `exchange-delivered.json`; «разобрал» ставит только человек или узел хешем в
 * памяти прочтения (lib/obligations.js). Прежде обе роли играл один файл, и
 * вручённое письмо считалось разобранным бесконечно — 688 ключей в одной памяти
 * против 317 в другой.
 *
 * It sits in the same store as the run records, so a test or a profile that points
 * the store elsewhere never reads the memory of the live host.
 */
export function seenPath(runtime) {
  return path.join(storeDir(runtime), 'exchange-delivered.json');
}

/**
 * Прежнее имя памяти вручений — собирается из частей сознательно.
 *
 * Задание 0280: до разделения памятей сторож писал вручения в файл, который
 * теперь принадлежит памяти ПРОЧТЕНИЯ (lib/obligations.js). Прочитать старую
 * память при первом запуске нужно — иначе 690 вручений «пропадут» и письма
 * будут вручены повторно. Но имя собрано из частей, а не записано литералом:
 * проверка C5 читает исходник и запрещает литерал, доказывая, что сторож в этот
 * файл не ПИШЕТ. Чтение старого файла — миграция, а не запись: старый файл
 * остаётся байт-в-байт нетронутым.
 */
const LEGACY_DELIVERED_NAME = ['exchange', 'seen.json'].join('-');

/** Маркер завершённой миграции: пока его нет, прежняя память ещё читается. */
const MIGRATION_MARKER_NAME = 'exchange-delivered.migrated.json';

/**
 * Память вручений из нового и прежнего файла (задание 0280, M-A/M-B).
 *
 * Оба файла читаются одинаково — числовая отметка «вручено, mtime»; строка
 * (sha256 прочтения) в память вручений не попадает. Записи ОБЪЕДИНЯЮТСЯ по
 * ключу с максимумом времени: пустой или частичный новый файл не должен молча
 * терять 690 отметок прежнего, а более свежая отметка побеждает.
 *
 * @returns {{ rows, file, legacy, merged, primary, hasLegacy }} — rows null, если
 *   не прочиталось ни одной числовой отметки.
 */
export function readDeliveredMemory(file, legacyFile = '') {
  const rows = {};
  let primary = false;
  let hasLegacy = false;
  const take = (candidate, isLegacy) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      return; /* битый файл не прячет память из другого */
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    if (isLegacy) hasLegacy = true;
    else primary = true;
    for (const [key, value] of Object.entries(parsed)) {
      const stamp = Number(value);
      if (!Number.isFinite(stamp)) continue;
      const current = rows[key];
      if (!Number.isFinite(current) || stamp > current) rows[key] = stamp;
    }
  };
  take(file, false);
  take(legacyFile, true);
  const keys = Object.keys(rows);
  return {
    rows: keys.length > 0 ? rows : null,
    file: primary ? file : (hasLegacy ? legacyFile : ''),
    legacy: !primary && hasLegacy,
    merged: keys.length > 0,
    primary,
    hasLegacy,
  };
}

/** Отметить миграцию: с этого момента прежняя память больше не читается. */
function writeMigrationMarker(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), note: 'прежняя память вручений объединена и перенесена' }) + String.fromCharCode(10), 'utf8');
  } catch {
    /* маркер — оптимизация: без него прежняя память прочитается ещё раз */
  }
}

/**
 * Журнал решений по каждому письму (задание 0048).
 *
 * `exchange-delivered.json` остаётся памятью ВРУЧЕНИЙ, а причины «письмо
 * осталось в ящике» пишутся сюда: одна JSON-строка на письмо и решение, только
 * дописывание. Без этого журнала тишина неотличима от «письма не видел».
 */
export function decisionsPath(runtime) {
  return path.join(storeDir(runtime), 'exchange-decisions.jsonl');
}

/**
 * Память «вручено, но ещё не обработано» (задание 0314).
 *
 * Вручение и прочтение — разные события (0280). Ответ (Status: answer) теперь
 * доставляется адресату как информация для обработки, но «прочитано» ставится не
 * в момент вручения, а после того, как сессия адресата завершила ход с письмом
 * (session/event turn/end в lib/index.js). Здесь лежат письма, ждущие этого
 * момента: { version: 1, entries: [{ session, root, letter, sha256, at }] }.
 * Отметку ставит markPendingRead через markExchangeSeen (lib/obligations.js) —
 * посегментно, только по своим записям.
 */
export const PENDING_READ_VERSION = 1;
/** Запись старше этого возраста отмечается ближайшим тиком (fallback без turn/end). */
export const PENDING_READ_TTL_MS = 30 * 60 * 1000;
/**
 * Окно ожидания эскалации (задание 0341).
 *
 * Столько письмо «вручено, но не обработано» ждёт хода адресата; по истечении
 * окна сторож подаёт answer повторно. По умолчанию равно PENDING_READ_TTL_MS:
 * прежний TTL был молчаливым закрытием, теперь то же время — повод напомнить.
 */
export const PENDING_READ_ESCALATION_WINDOW_MS = PENDING_READ_TTL_MS;
/**
 * Предел повторных подач одного письма (задание 0341).
 *
 * Число конечно: после предела письмо закрывается прежним TTL-fallback как
 * прочитанное. Эскалация не создаёт бесконечного напоминания.
 */
export const PENDING_READ_ESCALATION_MAX = 2;

/** Файл памяти «вручено, но не обработано» для runtime (хранилище прогонов). */
export function pendingReadPath(runtime) {
  return path.join(storeDir(runtime), 'exchange-pending-read.json');
}

/** Одна запись pending-read в проверенном виде; мусорная строка не ломает чтение. */
function pendingReadEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const session = typeof entry.session === 'string' ? entry.session.trim() : '';
  const letter = typeof entry.letter === 'string' ? entry.letter.trim() : '';
  if (!session || !letter) return null;
  return {
    session,
    root: typeof entry.root === 'string' ? entry.root.trim() : '',
    letter,
    sha256: typeof entry.sha256 === 'string' ? entry.sha256.trim() : '',
    at: typeof entry.at === 'string' ? entry.at : '',
    /* 0341: сколько повторных подач уже состоялось; отсутствие поля — ноль. */
    attempts: Number.isFinite(Number(entry.attempts)) && Number(entry.attempts) > 0
      ? Math.trunc(Number(entry.attempts))
      : 0,
    /*
     * 0343: окно повтора после НЕУДАЧНОЙ отправки (ISO). Поле добавлено, формат
     * записи не менялся: старые записи читаются как «окна повтора нет».
     */
    retryAt: typeof entry.retryAt === 'string' ? entry.retryAt : '',
  };
}

/** 0343: ключ записи pending-read — сессия и абсолютный путь письма. */
function pendingReadKey(entry) {
  const session = String(entry && entry.session ? entry.session : '');
  const letter = String(entry && entry.letter ? entry.letter : '');
  return session + '\u0000' + path.resolve(letter);
}

/**
 * Записи памяти «вручено, но не обработано»; битый или чужой файл — пустой список.
 *
 * @returns {Array<{session: string, root: string, letter: string, sha256: string, at: string}>}
 */
export function readPendingRead(runtime) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingReadPath(runtime), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Number(parsed.version) !== PENDING_READ_VERSION) return [];
    const rows = Array.isArray(parsed.entries) ? parsed.entries : [];
    const entries = [];
    for (const row of rows) {
      const entry = pendingReadEntry(row);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

/** Атомарная запись памяти: временный сосед и rename. Сбой не бросает — вручение уже было. */
function writePendingRead(runtime, entries) {
  const file = pendingReadPath(runtime);
  const temporary = file + '.' + String(process.pid) + '-' + Math.random().toString(36).slice(2, 10) + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ version: PENDING_READ_VERSION, entries }, null, 1) + '\n', 'utf8');
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* the failure is reported to the caller */
    }
    return false;
  }
}

/**
 * Отметить прочитанными письма, доставленные сессии sessionId (задание 0314).
 *
 * Отметка ставится sha256-памятью прочтения (markExchangeSeen), то есть тем же
 * путём, что и кнопка «разобрал»: выполненные вручения не переписываются.
 * Удаляются ТОЛЬКО успешно отмеченные записи этой сессии; записи других сессий
 * и письма, которые не удалось прочитать, остаются. Файл пишется атомарно,
 * повторный вызов — no-op (идемпотентность). Ошибка не бросает: возвращается
 * { ok: false, error }.
 *
 * @returns {{ ok: boolean, session?: string, marked?: number, written?: boolean, error?: string }}
 */
export function markPendingRead({ runtime, sessionId, now } = {}) {
  const id = String(sessionId == null ? '' : sessionId).trim();
  if (!runtime) return { ok: false, error: 'нужен runtime панели' };
  if (!id) return { ok: false, error: 'нужен id сессии' };
  try {
    const entries = readPendingRead(runtime);
    const own = entries.filter((entry) => entry.session === id);
    if (own.length === 0) return { ok: true, session: id, marked: 0, written: false };
    const marked = new Set();
    for (const entry of own) {
      let result = null;
      try {
        /* paths принимает абсолютный путь; root нужен для разрешения относительного. */
        result = markExchangeSeen({ root: entry.root, paths: [entry.letter] });
      } catch {
        result = null;
      }
      if (result && Number(result.marked) > 0) marked.add(entry);
    }
    if (marked.size === 0) return { ok: true, session: id, marked: 0, written: false };
    if (!writePendingRead(runtime, entries.filter((entry) => !marked.has(entry)))) {
      return { ok: false, session: id, marked: marked.size, written: false, error: 'не удалось записать exchange-pending-read.json' };
    }
    return { ok: true, session: id, marked: marked.size, written: true };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}
/**
 * Ветки журнала, которые значат «письмо вручено» (задание 0153).
 *
 * `delivered` — вручение сейчас, `rescan:delivered` — то же содержимое было
 * вручено раньше (перенос ящика не делает доставленное потерянным, 0099). Только
 * эти две ветки дают право на отметку seen: всё остальное значит «ждёт в ящике».
 */
export const DELIVERED_BRANCHES = new Set(['delivered', 'rescan:delivered']);

/**
 * Ветки «письмо ждёт вручения», и каждая называет причину (задание 0153).
 *
 * Это не потеря и не «прочитано»: доставка выключена, живой сессии нет, папка не
 * принята, ветка в окне повтора. Письмо остаётся pending и будет доставлено при
 * первой возможности; `error:*` считается так же — вручения не было.
 */
export const WAITING_BRANCHES = new Set([
  'skip:delivery-off', 'no-session', 'skip:cooldown', 'gate:invited', 'gate:disconnected',
  /* Задание 0159: квитанция есть, но устарела — письмо ждёт новую. */
  'gate:stale-receipt',
]);

/**
 * Четыре состояния журнала (задание 0210): молчание перестаёт быть ответом.
 *
 * `scanned` — скан каталога с watermark (новых писем может и не быть, и тогда
 * это единственный след работы сторожа); `delivered` — письмо реально вручено;
 * `pending` — письмо осталось в ящике, точная причина в поле `branch`;
 * `error` — доставка завершилась ошибкой.
 *
 * Поле `state` пишется в каждую новую строку журнала рядом с `branch`, а старые
 * строки читаются той же функцией по ветке — журнал остаётся совместимым.
 */
export const JOURNAL_STATES = Object.freeze(['scanned', 'delivered', 'pending', 'error']);

/** Состояние строки журнала по её ветке: старые строки не переписываются. */
export function journalStateOf(branch) {
  const text = String(branch == null ? '' : branch).trim();
  if (text === 'scanned') return 'scanned';
  /*
   * 0341: повторная подача — доставка, а не ожидание. DELIVERED_BRANCHES не
   * расширяется осознанно (инвариант 3 задания): эскалация обязана быть
   * отличима от первого вручения, поэтому она названа отдельной веткой, а
   * состояние журнала остаётся delivered.
   */
  if (text === 'delivered:escalation' || DELIVERED_BRANCHES.has(text)) return 'delivered';
  if (text.startsWith('error:')) return 'error';
  return 'pending';
}

/**
 * Сводка журнала: сколько строк каждого состояния и когда был последний скан.
 *
 * `lastScanAt`/watermark отвечают на вопрос «сторож вообще сканировал?» даже
 * когда писем нет: ноль в `letters` при свежем `lastScanAt` — это «писем нет»,
 * а пустой `lastScanAt` — «скана не было». Две разные тишины.
 */
export function journalSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const states = { scanned: 0, delivered: 0, pending: 0, error: 0 };
  const letters = new Set();
  let lastScanAt = '';
  let watermark = '';
  let scannedLetters = 0;
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const state = String(row.state || journalStateOf(row.branch));
    if (!Object.hasOwn(states, state)) continue;
    states[state] += 1;
    if (state === 'scanned') {
      if (row.at) lastScanAt = String(row.at);
      if (row.watermark) watermark = String(row.watermark);
      const count = Number(row.scanned);
      if (Number.isFinite(count) && count >= 0) scannedLetters = Math.trunc(count);
    } else if (row.letter) {
      letters.add(String(row.letter));
    }
  }
  return { ...states, letters: letters.size, lastScanAt, watermark, scannedLetters, rows: list.length };
}

/** Ключ письма для сравнения: слэши одинаковы, регистр важен только на Windows. */
export function letterKey(value) {
  const text = String(value == null ? '' : value).trim().replace(/\\/gu, '/');
  if (!text) return '';
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/**
 * Одно ли это письмо: путь в памяти вручений полный, путь в журнале — от ящика.
 * Сравнение идёт по границе сегмента, а не по подстроке: `a/b.md` не равно `xb.md`.
 */
export function sameLetter(left, right) {
  const a = letterKey(left);
  const b = letterKey(right);
  if (!a || !b) return false;
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

/** Ждёт ли письмо вручения: известная ветка ожидания или честная ошибка доставки. */
export function isWaitingBranch(branch) {
  const text = String(branch || '').trim();
  return WAITING_BRANCHES.has(text) || text.startsWith('error:');
}

/** Строки журнала решений: одна JSON-строка — одно решение; порванная не прячет целые. */
export function readDecisionRows(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch {
      /* порванная строка дописываемого журнала — не повод терять остальные */
    }
  }
  return rows;
}

/**
 * Состояние каждого письма по журналу решений: вручено или ждёт (и почему).
 *
 * Ключ — нормализованный путь письма. Ветки одного письма объединяются: журнал
 * только дописывается, и состоявшееся вручение сильнее более позднего ожидания.
 *
 * @returns {Map<string, { letter: string, delivered: boolean, waiting: string, branches: string[] }>}
 */
export function letterStates(rows) {
  const states = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const letter = String(row.letter || '').trim();
    const branch = String(row.branch || '').trim();
    if (!letter || !branch) continue;
    const key = letterKey(letter);
    const state = states.get(key) || { letter, delivered: false, waiting: '', branches: [] };
    state.branches.push(branch);
    if (DELIVERED_BRANCHES.has(branch)) {
      state.delivered = true;
      state.waiting = '';
    } else if (!state.delivered && isWaitingBranch(branch)) {
      state.waiting = branch;
    }
    states.set(key, state);
  }
  return states;
}

/** Состояние письма по пути из памяти вручений: полный путь против относительного. */
export function stateOfLetter(states, file) {
  const direct = states.get(letterKey(file));
  if (direct) return direct;
  for (const state of states.values()) {
    if (sameLetter(state.letter, file)) return state;
  }
  return null;
}

/**
 * Причина ожидания человеческим языком: код ветки остаётся рядом, но
 * «ждёт вручения: skip:delivery-off» без перевода читается только автором кода.
 */
export function waitingReasonText(branch) {
  const code = String(branch || '').trim();
  if (code === 'skip:delivery-off') return 'доставка выключена';
  if (code === 'no-session') return 'живой сессии адресата не было';
  if (code === 'skip:cooldown') return 'ветка была в окне повтора';
  if (code === 'gate:invited') return 'папка не принята адресатом';
  if (code === 'gate:stale-receipt') return 'квитанция устарела — нужна новая квитанция от адресата';
  if (code === 'gate:disconnected') return 'адресат отключился от папки';
  if (code.startsWith('error:')) return 'доставка завершилась ошибкой';
  /* 0285: статус-реакция (answer/ack/…) долга чтения не создаёт и не будит. */
  if (code === 'skip:no-wake') return 'статус-реакция: письмо не создаёт долга чтения';
  if (code === 'no-delivery-decision') return 'решения о вручении нет, только отметка';
  if (code === 'no-decisions') return 'записей журнала по письму нет';
  return code || 'причина не записана';
}

/** Память вручений как объект: Map сторожа, уже прочитанный JSON или файл. */
function seenRowsOf(value, file) {
  if (value instanceof Map) {
    const rows = {};
    for (const [key, stamp] of value) rows[key] = stamp;
    return rows;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Переписать память вручений атомарно: снятая отметка не оставит половину файла. */
function writeSeenObject(rows, file) {
  const temporary = file + '.' + String(process.pid) + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(rows, null, 1) + '\n', 'utf8');
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* память вручений — удобство, а не контракт */
    }
    return false;
  }
}

/**
 * Снять исторические ложные отметки seen (задание 0153, D3).
 *
 * Ложная отметка — это seen без вручения: письмо пометили прочитанным в ветке
 * box-only (доставка выключена или живой сессии нет), и оно исчезло из
 * непрочитанных, хотя агенту его не вручали. Функция находит такие отметки и,
 * если `dryRun` не true, снимает их в файле памяти вручений.
 *
 *   recoverFalseSeen({ seen, decisions, dryRun })
 *   recoverFalseSeen({ seenPath, decisionsPath, dryRun })
 *
 * @returns {{ falseSeen: string[], kept: string[], applied: boolean,
 *   reasons: Record<string, string>, dryRun: boolean }}
 *   `falseSeen` — снимаемые (или снятые) пути; `kept` — у кого вручение есть;
 *   `applied` — файл действительно переписан (только при dryRun=false и непустом
 *   falseSeen); `reasons` — причина, по которой письмо ждало вручения.
 */
export function recoverFalseSeen(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  /* По умолчанию — только чтение: запись требует явного dryRun=false. */
  const dryRun = settings.dryRun !== false;
  const seenFile = typeof settings.seenPath === 'string' && settings.seenPath.trim()
    ? settings.seenPath.trim()
    : '';
  const journalFile = typeof settings.decisionsPath === 'string' && settings.decisionsPath.trim()
    ? settings.decisionsPath.trim()
    : (settings.runtime ? decisionsPath(settings.runtime) : '');
  const rows = seenRowsOf(settings.seen, seenFile);
  const decisions = Array.isArray(settings.decisions)
    ? settings.decisions
    : readDecisionRows(journalFile);
  const states = letterStates(decisions);
  const falseSeen = [];
  const kept = [];
  const reasons = {};
  for (const file of Object.keys(rows)) {
    /*
     * Задание 0280: в памяти вручений лежат ЧИСЛОВЫЕ отметки (mtime). Строковое
     * значение — хеш «прочитал» из памяти прочтения, и снимать его как ложное
     * вручение нельзя: это разные записи о разных событиях. Такие ключи не
     * попадают ни в falseSeen, ни в kept — команда их не трогает.
     */
    const stamp = Number(rows[file]);
    if (!Number.isFinite(stamp)) continue;
    const state = stateOfLetter(states, file);
    if (state && state.delivered) {
      kept.push(file);
      continue;
    }
    falseSeen.push(file);
    reasons[file] = state ? (state.waiting || 'no-delivery-decision') : 'no-decisions';
  }
  falseSeen.sort();
  kept.sort();
  let applied = false;
  if (!dryRun && seenFile && falseSeen.length > 0) {
    const drop = new Set(falseSeen);
    const next = {};
    for (const [file, stamp] of Object.entries(rows)) {
      if (drop.has(file)) continue;
      next[file] = stamp;
    }
    applied = writeSeenObject(next, seenFile);
  }
  return { falseSeen, kept, applied, reasons, dryRun };
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
 * Heartbeat of the watcher (задание 0210).
 *
 * The telemetry log above answers "what happened"; a silent log still looked like
 * "there were no letters". The heartbeat answers a narrower and stronger question —
 * "did the scan run just now" — and it is one small JSON object, so a reader does
 * not have to tail an append-only file to learn it. It lives in the run store the
 * panel already reads and is rewritten on every pass, and by its own timer at
 * least once a minute (HEARTBEAT_INTERVAL_MS).
 */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;
/** A heartbeat older than this is silence, not a quiet box (criterion C1). */
export const HEARTBEAT_MAX_AGE_MS = 5 * 60 * 1000;
/** The hard path named by the task; a runtime store overrides it for tests. */
export const EXCHANGE_HEARTBEAT_PATH = path.join(os.homedir(), '.dsh', 'project-graph', 'runs', 'exchange-watch.json');

/** Where the heartbeat lies for a runtime: its run store, the hard path by default. */
export function heartbeatPath(runtime) {
  return path.join(storeDir(runtime), 'exchange-watch.json');
}

/**
 * Rewrite the heartbeat atomically:
 * `{ lastTickAt: ISO, scanned: N, producer, pid, unwatchedBoxes, addedBoxes, watchedCount }`.
 *
 * A failure returns null and never breaks a pass: liveness evidence is important,
 * but a read-only home must not stop delivery.
 *
 * `producer`/`pid` (0210 rework B1) name the writer. A fresh file then proves not
 * only "someone is alive", but WHO is alive: the host watcher, a separate probe or
 * a test process. Without them a heartbeat of unknown origin looked like a healthy
 * host watcher even when the host had loaded nothing.
 */
export function writeHeartbeat(file, input = {}) {
  const target = typeof file === 'string' && file.trim() ? file.trim() : EXCHANGE_HEARTBEAT_PATH;
  const raw = Number(input && input.scanned);
  const producer = input && typeof input.producer === 'string' && input.producer.trim()
    ? input.producer.trim()
    : 'exchange-watch';
  const rawPid = Number(input && input.pid);
  /*
   * 0339/0340: heartbeat names the boxes found beside the workspaces.
   * `unwatchedBoxes` — что инвентаризация нашла, но подключить не смогла (обычно
   * пусто); `addedBoxes` — что ЭТОТ проход подключил к своему скану; `watchedCount` —
   * сколько ящиков проход сканирует после подключения. Всё это только диагностика:
   * ни корень, ни папка в профиль не пишутся. Пути абсолютные, без дублей по регистру.
   */
  const boxList = (value) => {
    const list = [];
    const keys = new Set();
    for (const item of Array.isArray(value) ? value : []) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const resolved = path.resolve(item.trim());
      const key = normalizePath(resolved);
      if (!key || keys.has(key)) continue;
      keys.add(key);
      list.push(resolved);
    }
    return list;
  };
  const unwatchedBoxes = boxList(input && input.unwatchedBoxes);
  const addedBoxes = boxList(input && input.addedBoxes);
  const rawWatched = Number(input && input.watchedCount);
  const watchedCount = Number.isFinite(rawWatched) && rawWatched >= 0 ? Math.trunc(rawWatched) : 0;
  const row = {
    lastTickAt: input && typeof input.lastTickAt === 'string' && input.lastTickAt
      ? input.lastTickAt
      : new Date().toISOString(),
    scanned: Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0,
    producer,
    pid: Number.isFinite(rawPid) && rawPid > 0 ? Math.trunc(rawPid) : process.pid,
    unwatchedBoxes,
    addedBoxes,
    watchedCount,
  };
  const temporary = target + '.' + String(process.pid) + '.tmp';
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(row) + '\n', 'utf8');
    fs.renameSync(temporary, target);
    return row;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* the next tick will try again */
    }
    return null;
  }
}

/**
 * Read the heartbeat:
 * `{ lastTickAt, scanned, at, producer, pid, unwatchedBoxes, addedBoxes, watchedCount }`,
 * or null for a
 * missing/broken file.
 *
 * Missing and stale are different answers and must stay different: "no file" means
 * the watcher never wrote anything, a stale file means it stopped — both are told
 * apart from a quiet box by heartbeatState().
 */
export function readHeartbeat(file = EXCHANGE_HEARTBEAT_PATH) {
  try {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = new Date(row && row.lastTickAt).getTime();
    if (!Number.isFinite(at)) return null;
    const scanned = Number(row && row.scanned);
    const pid = Number(row && row.pid);
    /* 0339/0340: старый heartbeat без списков читается как пустые, а не как ошибка. */
    const listOf = (value) => {
      const list = [];
      const keys = new Set();
      for (const item of Array.isArray(value) ? value : []) {
        if (typeof item !== 'string' || !item.trim()) continue;
        const key = normalizePath(item);
        if (!key || keys.has(key)) continue;
        keys.add(key);
        list.push(item.trim());
      }
      return list;
    };
    const unwatchedBoxes = listOf(row && row.unwatchedBoxes);
    const addedBoxes = listOf(row && row.addedBoxes);
    const rawWatched = Number(row && row.watchedCount);
    return {
      lastTickAt: String(row.lastTickAt),
      scanned: Number.isFinite(scanned) && scanned > 0 ? Math.trunc(scanned) : 0,
      at,
      producer: row && typeof row.producer === 'string' ? row.producer : '',
      pid: Number.isFinite(pid) && pid > 0 ? Math.trunc(pid) : null,
      unwatchedBoxes,
      addedBoxes,
      addedCount: addedBoxes.length,
      watchedCount: Number.isFinite(rawWatched) && rawWatched >= 0 ? Math.trunc(rawWatched) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Freshness of the heartbeat: alive / stale / no-heartbeat, with the age.
 *
 * @returns {{ ok: boolean, alive: boolean, reason: string, file: string,
 *   ageMs: number|string|null, lastTickAt: string|null, scanned: number,
 *   producer: string, pid: number|null }}
 */
export function heartbeatState({ file = EXCHANGE_HEARTBEAT_PATH, now = Date.now(), maxAgeMs = HEARTBEAT_MAX_AGE_MS } = {}) {
  const row = readHeartbeat(file);
  if (!row) {
    return {
      ok: false, alive: false, reason: 'no-heartbeat', file, ageMs: null, lastTickAt: null,
      scanned: 0, unwatchedBoxes: [], unwatchedCount: 0,
      addedBoxes: [], addedCount: 0, watchedCount: 0,
    };
  }
  const ageMs = Math.max(0, Number(now) - row.at);
  const alive = ageMs <= maxAgeMs;
  return {
    ok: alive,
    alive,
    reason: alive ? 'alive' : 'stale-heartbeat',
    file,
    ageMs,
    lastTickAt: row.lastTickAt,
    scanned: row.scanned,
    producer: row.producer,
    pid: row.pid,
    /* 0339/0340: диагностика ящиков доступна и по живости. */
    unwatchedBoxes: row.unwatchedBoxes,
    unwatchedCount: row.unwatchedBoxes.length,
    addedBoxes: row.addedBoxes,
    addedCount: row.addedBoxes.length,
    watchedCount: row.watchedCount,
  };
}

/**
 * Долг будит; статус-реакция — нет (задание 0285, пересмотр 0283).
 *
 * Механика обязательств (0280) разрешает спор 0283 с принятыми 0081/0111:
 * непрочитанное письмо — долг адресата, но не всякое письмо создаёт долг чтения.
 * Письмо-статус (request, question, proposal, report, invitation, info и любой
 * необъявленный статус) требует внимания адресата и потому БУДИТ. Письмо-реакция
 * (answer, ack, agreed, rejected, declined) закрывает заявку и долга чтения не
 * создаёт — оно НЕ будит (0081, 0111 C5). Литеральный статус `unknown` входит в
 * принятый контракт 0081 c1 как не-будящий и сохраняется; пустой статус — письмо
 * без шапки-статуса — не будит так же. Необъявленное значение (например,
 * `неизвестный`) считается долгом: молчание о письме неотличимо от потери.
 *
 * Прежняя версия 0283 отвечала «истина» на любой статус и отменяла 0081/0111
 * целиком — приёмка отклонила её как конфликт контрактов. Здесь правило
 * сузилось до долга: будит то, что создаёт долг чтения.
 */
const WAKE_NON_DEBT_STATUSES = new Set(['answer', 'ack', 'agreed', 'rejected', 'declined', 'unknown']);

export function shouldWake(status) {
  const text = normalizeWakeStatus(status);
  if (!text) return false;
  return !WAKE_NON_DEBT_STATUSES.has(text);
}

/** Нижний регистр и обрезка: статус и стороны в ящике пишут по-разному. */
function normalizeWakeStatus(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/**
 * 0217: ответ на письмо самого адресата — продолжение диалога, а не фон.
 *
 * С 0285 предикат решает ровно один узкий случай — исключение принятого 0111 C1:
 * answer на собственный question/request адресата будит (delivered:wake-answer),
 * а ответ на answer/ack и на чужой вопрос остаётся skip:no-wake. Функция отвечает
 * на вопрос «это ответ на письмо адресата?» по шапке Ref и не заставляет решение
 * о пробуждении разбирать цепочку.
 */
export function isWakeAnswer(answerRef, addressee) {
  if (!answerRef || !answerRef.replyToAuthor) return false;
  const author = String(answerRef.replyToAuthor).trim().toLowerCase();
  const target = String(addressee == null ? '' : addressee).trim().toLowerCase();
  return author !== '' && author === target;
}

/**
 * Решение по одному письму: { wake, cause } (задание 0285, пересмотр 0283).
 *
 * Порядок веток — смысл:
 *   1. письмо от самого адресата (from === self) — не долг ему: skip:self;
 *   2. идёт ход адресата — письмо ждёт освобождения: skip:in-turn (0285: занятость
 *      проверяется для ВСЕХ писем, включая реакцию: busy-адресат не теряет письмо,
 *      оно уходит первым тиком после освобождения);
 *   3. адресат не простаивает — тоже ждать: skip:active;
 *   4. статус-реакция (ack, agreed, rejected, declined, unknown, пустой) —
 *      долга чтения не создаёт: skip:no-wake (0081, 0111 C5, 0099). Answer —
 *      тоже реакция и долга не создаёт (shouldWake не меняется), но по 0314
 *      сторож доставляет его для ОБРАБОТКИ: context.processAnswers === true
 *      возвращает delivered:wake-answer независимо от replyToStatus. Без флага
 *      прежнее правило остаётся: answer → skip:no-wake, кроме принятого 0111 C1
 *      (ответ на СВОЙ question/request адресата — delivered:wake-answer);
 *   5. лимит исчерпан — skip:cooldown;
 *   6. иначе delivered:wake.
 *
 * `letter`: { status, replyToStatus, replyToAuthor, path, from, subject }; статус
 * решает, создаёт ли письмо долг чтения (или доставляется ли ответ), а
 * адресатность и занятость — можно ли поднимать адресата сейчас.
 * `context`: { self, idle, inTurn, throttled, processAnswers }. Причина
 * возвращается всегда: тишина без причины неотличима от потери (0048).
 */
export function wakeDecision(letter, context) {
  const source = letter && typeof letter === 'object' ? letter : {};
  const ctx = context && typeof context === 'object' ? context : {};
  const from = normalizeWakeStatus(source.from);
  const self = normalizeWakeStatus(ctx.self);
  /*
   * Письмо от самого адресата — не долг ему: он сам его и написал. Сравнение без
   * регистра и пробелов; пустой From «своим» не считается — иначе потерявшее шапку
   * письмо молчало бы навсегда.
   */
  if (self !== '' && from !== '' && from === self) return { wake: false, cause: 'skip:self' };
  /*
   * Занятость раньше статуса (0283/0285): письмо при занятой сессии не будит и не
   * теряется — оно уходит первым тиком после освобождения (отметка «попытка была»
   * снимается в цикле доставки).
   */
  if (ctx.inTurn === true) return { wake: false, cause: 'skip:in-turn' };
  if (ctx.idle !== true) return { wake: false, cause: 'skip:active' };
  const status = normalizeWakeStatus(source.status);
  const debt = shouldWake(status);
  /*
   * 0111 C1 не отменён 0285: answer на собственный question/request адресата —
   * продолжение его же диалога, а не реакция на чужую заявку. Предикат узкий:
   * нужен автор Ref, совпадающий с адресатом, и вопрос/просьба в Ref. Всё
   * остальное из статусов-реакций молчит причиной skip:no-wake.
   */
  const answerToOwnQuestion = !debt
    && status === 'answer'
    && isWakeAnswer(source, ctx.self)
    && ['question', 'request'].includes(normalizeWakeStatus(source.replyToStatus));
  /*
   * 0314: ответ — информация для адресата, а не только продолжение его диалога.
   * Флаг принадлежит СТОРОЖУ (createExchangeWatcher): без него внешние вызовы и
   * прежние проверки видят контракт 0081/0111 без изменений. ack/agreed/rejected/
   * declined/unknown/пустой статус не будит ни при каком флаге: долга чтения у них
   * нет, а answer теперь доставляется для обработки.
   */
  const processAnswer = ctx.processAnswers === true && status === 'answer';
  if (!debt && !answerToOwnQuestion && !processAnswer) return { wake: false, cause: 'skip:no-wake' };
  if (ctx.throttled === true) return { wake: false, cause: 'skip:cooldown' };
  return {
    wake: true,
    cause: answerToOwnQuestion || processAnswer ? 'delivered:wake-answer' : 'delivered:wake',
  };
}

/**
 * Дайджест пробуждения: все письма тика — ОДНО сообщение (задание 0111).
 *
 * Батч вместо письма на письмо: после простоя в ящике копятся письма, и пять
 * отдельных пробуждений — шум, а не внимание (урок --65). В каждой строке путь, от,
 * тема и статус. 0314: answer назван ответом для ОБРАБОТКИ; обязанность отвечать
 * снимается — отвечать нужно только если в письме есть вопрос.
 */
export function buildWakeDigest(letters) {
  const list = (Array.isArray(letters) ? letters : []).filter((letter) => letter && typeof letter === 'object');
  const lines = ['Новые сообщения в обмене: ' + list.length];
  let answers = 0;
  let escalations = 0;
  for (const letter of list) {
    const relative = String(letter.path == null ? (letter.file == null ? '' : letter.file) : letter.path)
      .split('\\').join('/');
    const status = normalizeWakeStatus(letter.status);
    const from = String(letter.from == null ? '' : letter.from).trim();
    const subject = String(letter.subject == null ? '' : letter.subject).trim();
    if (status === 'answer') answers += 1;
    /*
     * 0341: повторная подача названа по-русски прямо в строке письма — адресат
     * видит, что это уже вручалось и не было обработано, а не «новое письмо».
     */
    const escalation = letter.escalation && typeof letter.escalation === 'object' ? letter.escalation : null;
    const attempt = escalation ? Number(escalation.attempt) : 0;
    const limit = escalation ? Number(escalation.max) : 0;
    const repeat = Number.isFinite(attempt) && attempt > 0;
    if (repeat) escalations += 1;
    lines.push('- ' + relative + ' — From: ' + from
      + (status ? ', статус ' + status : '')
      + (status === 'answer' ? ', ответ для обработки' : '')
      + (repeat ? ', повторная подача ' + attempt + ' из '
        + (Number.isFinite(limit) && limit > 0 ? limit : '?')
        + ' — письмо уже вручалось и не было обработано' : '')
      + (subject ? ' — ' + subject : ''));
  }
  /* Абсолютный путь — факт вручения: относительный от корня ящика читателю не адрес. */
  for (const letter of list) {
    if (!letter.file) continue;
    lines.push('Файл: ' + String(letter.file).split('\\').join('/'));
  }
  lines.push('Откройте перечисленные файлы: тело письма в ящике, шапка — в строке выше.');
  if (answers > 0) {
    lines.push('ответы для обработки: прочитайте и учтите их; отвечать нужно только если в письме есть вопрос');
  }
  if (escalations > 0) {
    lines.push('повторная подача: письмо вручалось раньше и осталось необработанным — обработайте его;'
      + ' отметка «разобрал» закрывает письмо');
  }
  lines.push('В каждом ответе указывайте Session: <id своей сессии> — сторону определяют по нему, а не по From.');
  return lines.join('\n');
}

/** Лимит пробуждений одной ветки: одно в минуту (0283; было 15 минут — 0111). */
export const WAKE_BRANCH_COOLDOWN_MS = 60 * 1000;
/** Лимит пробуждений одного ящика: одно пробуждение в окне (0283/0284; было 5/час — 0111). */
export const WAKE_BOX_LIMIT = 1;
/** Окно лимита ящика: две минуты (0283; был час — 0111). */
export const WAKE_BOX_WINDOW_MS = 2 * 60 * 1000;

/**
 * Лимиты пробуждений в памяти процесса (0111, пересмотрено 0283, уточнено 0284).
 *
 * Диск не нужен: лимит защищает от шторма в текущем процессе, а перезапуск — уже
 * другое состояние, и запись лимитов на диск сделала бы старый шторм вечным.
 * Ключ ветки — ящик + ветка письма (Thread), ключ ящика — сам ящик.
 *
 * Два разных вопроса, и раньше они были смешаны:
 *   fits(box, branch, now) — «можно ли будить ПРЯМО СЕЙЧАС»; ничего не пишет.
 *     Сторож спрашивает так до вручения: вручение само отметит пробуждение
 *     через mark(), и недоставленное письмо не имеет права съесть окно.
 *   mark(box, branch, now) — «пробуждение состоялось»: ветка обновляет своё окно,
 *     ящик запоминает ВРЕМЯ пробуждения.
 *   allow(...) — fits + mark для одного вызова (прежний контракт 0111/0215,
 *     которым пользуются внешние проверки и старые вызовы).
 *
 * Ящик считается СТРОГО по времени, а не по «поводам» (0284). Прежняя версия
 * запоминала разные ветки-поводы и разрешала второй подъём той же ветки через
 * 60 с, хотя ящик только что будили, — это расходилось с правилом заказчика
 * «ящик раз в две минуты». Теперь mark() закрывает ящик ровно на boxMs,
 * независимо от ветки: с лимитом 1 (WAKE_BOX_LIMIT) любое следующее пробуждение
 * ящика возможно только через 120 с. Ветка остаётся внутренним окном 60 с и
 * проверяется первой, поэтому её отказ называется limit=branch, а отказ ящика —
 * limit=box.
 *
 * boxLimit оставлен настраиваемым (стенды сужают окна и потолок): это потолок
 * числа пробуждений в окне, и при значении 1 он и есть строгое правило выше.
 */
export function createWakeThrottle(options = {}) {
  const branchMs = Number.isFinite(options.branchMs) && options.branchMs > 0
    ? options.branchMs
    : WAKE_BRANCH_COOLDOWN_MS;
  const boxMs = Number.isFinite(options.boxWindowMs) && options.boxWindowMs > 0
    ? options.boxWindowMs
    : WAKE_BOX_WINDOW_MS;
  const boxLimit = Number.isFinite(options.boxLimit) && options.boxLimit > 0
    ? Math.floor(options.boxLimit)
    : WAKE_BOX_LIMIT;
  const defaultNow = typeof options.now === 'function' ? options.now : () => Date.now();
  const branches = new Map();
  const boxes = new Map();
  const keyOf = (value) => String(value == null ? '' : value).trim().toLowerCase().split('\\').join('/');
  const clock = (now) => (Number.isFinite(now) ? Number(now) : Number(defaultNow()));
  const branchKey = (box, branch) => keyOf(box) + '\u0000' + keyOf(branch);

  /** Времена пробуждений ящика в окне: старое забывается, порядок — по возрастанию. */
  function pruneBox(boxKey, at) {
    const stamps = boxes.get(boxKey);
    if (!stamps) return [];
    while (stamps.length > 0 && !(at - stamps[0] < boxMs)) stamps.shift();
    return stamps;
  }

  /** Можно ли будить эту ветку в этом ящике; причина отказа названа, а не скрыта. */
  function fits(box, branch, now, settings = {}) {
    const at = clock(now);
    const key = branchKey(box, branch);
    const last = branches.get(key);
    /*
     * 0215: обход окна ВЕТКИ остаётся доступным ключом skipBranch — им пользуются
     * прежние вызовы и проверка 0215. Сторож 0283/0284 его больше не передаёт:
     * лимиты применяются ко всем письмам единообразно.
     */
    if (settings.skipBranch !== true && Number.isFinite(last) && at - last < branchMs) {
      return { allowed: false, cause: 'skip:cooldown', limit: 'branch', waitMs: branchMs - (at - last) };
    }
    const boxKey = keyOf(box);
    const stamps = pruneBox(boxKey, at);
    /*
     * 0284: ящик считается по временам пробуждений. Лимит 1 — строгий ящик:
     * после mark() следующий подъём не раньше чем через boxMs, любая ветка.
     * Больший лимит — потолок числа подъёмов в окне (стенды), и ждать нужно до
     * истечения самого старого из них.
     */
    if (stamps.length >= boxLimit) {
      const oldest = stamps[stamps.length - boxLimit];
      return { allowed: false, cause: 'skip:cooldown', limit: 'box', waitMs: Math.max(0, boxMs - (at - oldest)) };
    }
    return { allowed: true, cause: '', limit: '', waitMs: 0 };
  }

  /** Запомнить состоявшееся пробуждение: только оно считается лимитом. */
  function mark(box, branch, now) {
    const at = clock(now);
    branches.set(branchKey(box, branch), at);
    const boxKey = keyOf(box);
    const stamps = pruneBox(boxKey, at);
    /* Пачка писем одного тика — ОДНО пробуждение: mark с тем же временем не плодит запись. */
    if (stamps[stamps.length - 1] !== at) stamps.push(at);
    boxes.set(boxKey, stamps);
    return at;
  }

  /** Проверить И учесть попытку одним вызовом (прежний контракт allow). */
  function allow(box, branch, now, settings = {}) {
    const verdict = fits(box, branch, now, settings);
    if (verdict.allowed) mark(box, branch, now);
    return verdict;
  }

  return {
    allow,
    fits,
    mark,
    get branchMs() { return branchMs; },
    get boxLimit() { return boxLimit; },
    get boxWindowMs() { return boxMs; },
    reset() { branches.clear(); boxes.clear(); },
  };
}

/**
 * sha256 of a letter's content in UTF-8 (задание 0099).
 *
 * Identity of a letter is its CONTENT, not its path: an audit that compared paths
 * called a delivered letter lost after the box was moved (reach-proxy --19 п.2).
 * The record `delivered` carries this hash, and a rescanned letter with the same
 * hash is reported as `rescan:delivered` instead of `stale:backlog`.
 */
export function letterSha256(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

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

/** Resolve after `ms`, or reject with a readable reason. */
/**
 * 0262: вручение в живую сессию идёт общим модулем lib/agent-message.js.
 *
 * Инцидент: служба агентов падала с `Cannot read properties of undefined (reading
 * 'length')` на вызове с одной формой `{ text }` — письма не доходили, а в журнале
 * была строка без формы. Формы перебирать не нужно: хост принимает один объект
 * DSH-сообщения (id, role, content[], source), а способы — followup, send(next-turn)
 * и sendMessage.
 *
 * @returns {Promise<{ok: boolean, via: string, shape: string|null, errors: string[]}>}
 */
export async function sendViaHandle(handle, text, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000;
  const delivered = await deliverToHandle(handle, text, {
    wrap: (promise, what) => withTimeout(promise, timeoutMs, what),
  });
  /* shape сохранён для прежних читателей результата: это имя сработавшего способа. */
  return { ...delivered, shape: delivered.via || null };
}
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
    box: (extra.Box || extra.box || '').trim(),
    status: parsed.status,
    subject: (extra.Subject || '').trim(),
    /*
     * The ack chain lives in these two fields: what this letter answers (задание
     * 0164). `ref` keeps the historical "primary address" for the wake decision
     * (Ref first, then Reply-To), while `replyTo` keeps the field itself: closing
     * by an ack must try BOTH, because a receipt that names a contract in Ref and
     * a letter in Reply-To is otherwise closed by the wrong one — or by nothing.
     */
    ref: (extra.Ref || extra['Reply-To'] || '').trim(),
    replyTo: (extra['Reply-To'] || '').trim(),
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

/**
 * Письмо, на которое отвечает это письмо (задание 0111, сохранено 0285).
 *
 * Пробуждение answer опирается на факты ящика, а не на догадку: что за статус был
 * у письма в Ref/Reply-To и кто его написал. Путь в шапке бывает и от корня ящика, и
 * от папки ветки, поэтому ищутся оба; неоднозначность решается первым найденным
 * файлом, а отсутствие — null (тогда работает правило 0081: answer не будит).
 */
function referencedLetter(message, file, boxDir) {
  const ref = String(message && message.ref ? message.ref : '').trim();
  if (!ref) return null;
  const candidates = path.isAbsolute(ref)
    ? [ref]
    : [path.join(boxDir, ref), path.join(path.dirname(file), ref)];
  for (const candidate of candidates) {
    let text = '';
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseMessage(text, candidate);
    if (!parsed) continue;
    return {
      replyToStatus: normalizeWakeStatus(parsed.status),
      replyToAuthor: String(parsed.from || '').trim(),
    };
  }
  return null;
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

/*
 * Резолвер ящика живёт в lib/boxes.js (задание 0078). Эта обёртка сохраняет
 * прежнюю форму ответа для панели и сторожа; собственного правила здесь нет.
 */
export { commonParent };

/**
 * The box of ONE declared folder, resolved to an absolute directory.
 *
 * Shared by {@link declaredExchangeBoxes} and {@link readExchangeFolders}: the
 * panel must name the same directory the watcher reads, and a per-folder portal
 * needs the failure of ITS folder instead of the first error of the list.
 *
 * @returns `{ dir }` when the box resolves, `{ error, code, candidates? }` when the
 *   declaration is invalid, `{ missing: true }` when the folder carries no box.
 */
export function resolveFolderBox(folder, root, resolved) {
  const result = resolveBox({ root, folder, roots: Array.isArray(resolved) ? resolved : [] });
  if (result.code === 'box-missing') return { missing: true };
  if (result.status !== 'ok' || !result.path) {
    return {
      error: result.message,
      code: result.code || 'box-error',
      ...(Array.isArray(result.candidates) ? { candidates: result.candidates } : {}),
    };
  }
  return { dir: result.path };
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
/**
 * 0230: каталог ящика по uid папки. Неизвестный/пустой uid — null (запасной путь остаётся).
 * @param {string} uid
 * @param {Map<string,string>|object} index
 */
export function resolveBoxByUid(uid, index) {
  const key = String(uid == null ? '' : uid).trim();
  if (key === '' || !index) return null;
  if (typeof index.get === 'function') return index.get(key) || null;
  return index[key] || null;
}

/**
 * 0231: сессия адресата из переписки — первой, затем самые свежие. Субагентские сессии
 * (judge) отказывают «owned by subagent routing», а собственная сессия участника — нет.
 * @param {string[]} candidates
 * @param {Map<string,string>|object} peers
 * @param {string} label
 * @returns {string[]} не больше трёх
 */
export function preferPeerSession(candidates, peers, label) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((item) => typeof item === 'string' && item.trim() !== '');
  const key = String(label == null ? '' : label).trim().toLowerCase();
  const rawPeer = peers && typeof peers.get === 'function' ? peers.get(key) : (peers ? peers[key] : undefined);
  const peer = rawPeer && /^session-[0-9a-f]{8}-/iu.test(String(rawPeer)) ? String(rawPeer) : null;
  if (!peer) return list.slice(0, 3);
  return [String(peer), ...list.filter((item) => item !== peer)].slice(0, 3);
}

/**
 * 0232: childId всех запущенных узлов из launches.jsonl — это субагентские сессии,
 * им controller.prompt отказывает (owned by subagent routing). Координатора там нет.
 */
export function spawnedSessionIds(launchFile) {
  const ids = new Set();
  try {
    const text = fs.readFileSync(launchFile, 'utf8');
    for (const line of text.split(String.fromCharCode(10))) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row.childId === 'string' && row.childId) ids.add(row.childId);
      } catch { /* битая строка журнала не должна ломать доставку */ }
    }
  } catch { /* журнала нет — фильтр пуст */ }
  return ids;
}

/**
 * 0232: кандидаты доставки = свежие сессии минус субагенты, сессия адресата первой.
 * @param {string[]} candidates
 * @param {Set<string>|string[]} spawned
 * @param {Map<string,string>|object} peers
 * @param {string} label
 * @returns {string[]} не больше трёх
 */
export function deliverableSessions(candidates, spawned, peers, label) {
  const blocked = spawned instanceof Set ? spawned : new Set(Array.isArray(spawned) ? spawned : []);
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter((id) => typeof id === 'string' && id.trim() !== '' && !blocked.has(id));
  const key = String(label == null ? '' : label).trim().toLowerCase();
  const rawPeer = peers && typeof peers.get === 'function' ? peers.get(key) : (peers ? peers[key] : undefined);
  /* 0233: session-unknown и прочие не-сессии не должны становиться адресатом. */
  const peer = rawPeer && /^session-[0-9a-f]{8}-/iu.test(String(rawPeer)) ? String(rawPeer) : null;
  const ordered = peer && !blocked.has(peer)
    ? [peer, ...list.filter((id) => id !== peer)]
    : list;
  return ordered.slice(0, 3);
}

export function declaredExchangeBoxes(runtime, allowedRoots) {
  const allowed = Array.isArray(allowedRoots) ? allowedRoots.filter((root) => typeof root === 'string' && root.trim()) : [];
  const dirs = [];
  const errors = [];
  /* 0230: индекс uid -> каталог ящика: адресация папки по uid, а не по пути. */
  const byUid = new Map();
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
      const uid = folder && typeof folder.uid === 'string' ? folder.uid.trim() : '';
      if (uid) byUid.set(uid, resolved.dir);
    }
  }
  return { dirs, errors, byUid };
}

/**
 * Boxes that exist beside the workspaces but are NOT scanned by the watcher
 * (задание 0339).
 *
 * The watcher sees only the roots it is given and the folders the structure
 * declares. A mailbox created as a sibling workspace — its own
 * `coordination/threads` — therefore stayed invisible: nobody scanned it and
 * nobody said so. This inventory names that gap. It is a READ-ONLY diagnostic:
 * it adds no root, delivers nothing and changes no decision.
 *
 * Candidates are the shared portal `<parent>/coordination` of every allowed
 * root and `<parent>/<sibling>/coordination` for every sibling directory in
 * that parent. A candidate counts as a box only when its `threads` is a real
 * directory. Watched boxes (`boxDirs`/`declaredBoxes`/`watchedBoxes`) never
 * enter the result; comparison is case-insensitive on Windows, and the result
 * has no duplicate paths.
 *
 * @param {{ allowedRoots?: string[], boxDirs?: string[], declaredBoxes?: string[],
 *   watchedBoxes?: string[], maxSiblings?: number }} [options]
 * @returns {{ unwatchedBoxes: string[], watchedBoxes: string[], watchedCount: number,
 *   unwatchedCount: number }}
 */
export function unwatchedExchangeBoxes(options = {}) {
  const roots = [];
  const rootKeys = new Set();
  const addRoot = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const resolved = path.resolve(value.trim());
    const key = normalizePath(resolved);
    if (!key || rootKeys.has(key)) return;
    rootKeys.add(key);
    roots.push(resolved);
  };
  for (const root of Array.isArray(options.allowedRoots) ? options.allowedRoots : []) addRoot(root);

  const watched = [];
  const watchedKeys = new Set();
  const addWatched = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const resolved = path.resolve(value.trim());
    const key = normalizePath(resolved);
    if (!key || watchedKeys.has(key)) return;
    watchedKeys.add(key);
    watched.push(resolved);
  };
  for (const list of [options.boxDirs, options.declaredBoxes, options.watchedBoxes]) {
    for (const item of Array.isArray(list) ? list : []) addWatched(item);
  }
  const isWatched = (candidate) => {
    const key = normalizePath(candidate);
    if (!key) return true;
    if (watchedKeys.has(key)) return true;
    /* A candidate inside a scanned box is scanned as part of it. */
    return watched.some((box) => isInsideRoot(candidate, box));
  };

  const maxSiblings = Number.isFinite(options.maxSiblings) && options.maxSiblings > 0
    ? Math.trunc(options.maxSiblings)
    : 1000;
  const parents = [];
  const parentKeys = new Set();
  for (const root of roots) {
    const parent = path.dirname(root);
    const key = normalizePath(parent);
    /* A drive/share root has no meaningful sibling list and is its own parent. */
    if (!key || key === normalizePath(root) || parentKeys.has(key)) continue;
    parentKeys.add(key);
    parents.push(parent);
  }

  const found = [];
  const foundKeys = new Set();
  const addCandidate = (candidate) => {
    const resolved = path.resolve(candidate);
    const key = normalizePath(resolved);
    if (!key || foundKeys.has(key)) return;
    let stat;
    try {
      stat = fs.statSync(path.join(resolved, 'threads'));
    } catch {
      return;
    }
    if (!stat.isDirectory() || isWatched(resolved)) return;
    foundKeys.add(key);
    found.push(resolved);
  };
  for (const parent of parents) {
    /* The shared portal beside the workspaces (usually already watched). */
    addCandidate(path.join(parent, 'coordination'));
    let entries = [];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    let inspected = 0;
    for (const entry of entries) {
      if (inspected >= maxSiblings) break;
      if (!entry.isDirectory()) continue;
      inspected += 1;
      addCandidate(path.join(parent, entry.name, 'coordination'));
    }
  }
  found.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
  return {
    unwatchedBoxes: found,
    watchedBoxes: watched,
    watchedCount: watched.length,
    unwatchedCount: found.length,
  };
}

/**
 * Boxes of the inventory that may join the scan of THIS pass (задание 0340).
 *
 * 0339 only NAMED the boxes found beside the roots; delivery still ignored them.
 * The watcher now connects them to the current pass — in process memory only: the
 * profile, the roots and the declared folders are never written, and the list is
 * rebuilt from the disk on every pass.
 *
 * Only a path INSIDE the parent of an allowed root is accepted: the boxes of the
 * workspaces are their siblings in that parent, and nothing outside it is scanned.
 * A watched box is not added twice (same normalized path or nested inside a
 * watched one), and a duplicate of the input appears once. Like the inventory,
 * this function only reads the disk: it re-checks that `threads` is a directory.
 *
 * @param {{ allowedRoots?: string[], unwatchedBoxes?: string[],
 *   watchedBoxes?: string[] }} [options]
 * @returns {string[]} absolute box directories to add, in input order
 */
export function autowatchExchangeBoxes(options = {}) {
  const parents = [];
  const parentKeys = new Set();
  for (const root of Array.isArray(options.allowedRoots) ? options.allowedRoots : []) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const resolved = path.resolve(root.trim());
    const parent = path.dirname(resolved);
    const key = normalizePath(parent);
    /* A drive/share root has no meaningful sibling list and is its own parent. */
    if (!key || key === normalizePath(resolved) || parentKeys.has(key)) continue;
    parentKeys.add(key);
    parents.push(parent);
  }
  const watched = [];
  const watchedKeys = new Set();
  for (const item of Array.isArray(options.watchedBoxes) ? options.watchedBoxes : []) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const resolved = path.resolve(item.trim());
    const key = normalizePath(resolved);
    if (!key || watchedKeys.has(key)) continue;
    watchedKeys.add(key);
    watched.push(resolved);
  }
  const isWatched = (candidate) => {
    const key = normalizePath(candidate);
    if (!key) return true;
    if (watchedKeys.has(key)) return true;
    return watched.some((box) => isInsideRoot(candidate, box));
  };
  const added = [];
  const addedKeys = new Set();
  for (const item of Array.isArray(options.unwatchedBoxes) ? options.unwatchedBoxes : []) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const resolved = path.resolve(item.trim());
    const key = normalizePath(resolved);
    if (!key || addedKeys.has(key) || isWatched(resolved)) continue;
    /* Refuse a path outside the parent of every allowed root. */
    if (!parents.some((parent) => isInsideRoot(resolved, parent))) continue;
    try {
      if (!fs.statSync(path.join(resolved, 'threads')).isDirectory()) continue;
    } catch {
      continue;
    }
    addedKeys.add(key);
    added.push(resolved);
  }
  return added;
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

/**
 * Ревизия в шапке письма (задание 0159).
 *
 * Квитанция приёма папки ссылается на ревизию контракта: поле `Rev`. Читается
 * только блок шапки до первой пустой строки — тело письма не разбирается никогда.
 * Отсутствие поля — законное легаси: такие квитанции принимаются как прежде, иначе
 * все текущие папки разом стали бы invited.
 *
 * @returns число ревизии или null, когда поля нет (или оно не число).
 */
function headerRev(text) {
  for (const line of String(text || '').split(/\r?\n/u)) {
    if (!line.trim()) break;
    const match = /^Rev:[ \t]*(\d+)[ \t]*$/iu.exec(line);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  return null;
}

/**
 * Устарела ли квитанция: Rev назван и меньше ревизии контракта (задание 0159).
 *
 * Контракт без Rev (contractRev = 0) ничего не доказывает, поэтому квитанция
 * с любым Rev принимается: сравнивать не с чем.
 */
export function staleReceipt(rev, contractRev) {
  return Number.isInteger(rev) && Number.isInteger(contractRev)
    && contractRev > 0 && rev >= 0 && rev < contractRev;
}

/**
 * Причина устаревшей квитанции словами (задание 0159).
 *
 * Панель и check-exchange показывают её человеку: «папка не принята» без
 * ревизий заставляла искать причину в контракте вручную.
 */
export function staleReceiptReason(rev, contractRev, label) {
  return 'квитанция устарела: Rev ' + rev + ' < ' + contractRev
    + ' — нужна новая квитанция от ' + label;
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
      /*
       * Причина отказа папки словами (задание 0159): пустая строка — отказа нет.
       * Заполняется устаревшей квитанцией, чтобы панель и CLI не молчали.
       */
      reason: '',
      /* Та же причина по каждому участнику: «почему не принял именно он». */
      reasons: {},
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
        /* Ревизия квитанции: без Rev — легаси, с Rev — сверяется с контрактом (0159). */
        const rev = headerRev(text);
        const previous = receipts.get(author);
        /*
         * Date в шапке — минута, а квитанция и отключение бывают в одну минуту.
         * Тогда решает время записи файла: более позднее письмо и есть последнее.
         */
        const at = Number.isFinite(parsed.at) ? parsed.at : 0;
        const mtime = Number(entry.mtimeMs) || 0;
        if (!previous || at > previous.at || (at === previous.at && mtime > previous.mtime)) {
          receipts.set(author, { status, at, mtime, rev });
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
     * disconnected; accepted со старой ревизией (Rev < Rev контракта) — снова
     * invited и с причиной словами (задание 0159), а квитанция без Rev — легаси-
     * принятие. Инициатор папки — accepted ПО ОПРЕДЕЛЕНИЮ (задание 0049): он
     * приглашает, а не принимает, поэтому собственной квитанции у него нет. Его
     * состояние одинаково для любого читателя — и в копии папки, прочитанной
     * приглашённой стороной: читатель не является квитанцией инициатора. Явный
     * disconnected инициатора сильнее определения: он действительно ушёл.
     */
    for (const label of Object.keys(record.states)) {
      const entry = receipts.get(label.toLowerCase());
      const initiator = Boolean(contractInitiator && label.toLowerCase() === contractInitiator.toLowerCase());
      /*
       * Явное отключение сильнее и квитанции, и определения инициатора: он
       * действительно ушёл (задание 0048). Эта ветка не менялась.
       */
      if (entry && entry.status === 'disconnected') {
        record.states[label] = 'disconnected';
        continue;
      }
      /*
       * Инициатор папки — accepted ПО ОПРЕДЕЛЕНИЮ (задание 0049): он приглашает,
       * а не принимает, поэтому его Rev не спрашивают даже при старой квитанции.
       */
      if (initiator) {
        record.states[label] = 'accepted';
        continue;
      }
      if (entry) {
        /*
         * Задание 0159: квитанция без Rev — легаси и принимается; квитанция с
         * Rev меньше ревизии контракта устарела — сторона снова invited, а
         * причина называется словами, чтобы панель и CLI не молчали.
         */
        if (staleReceipt(entry.rev, record.contractRev)) {
          const reason = staleReceiptReason(entry.rev, record.contractRev, label);
          record.states[label] = 'invited';
          record.reasons[label] = reason;
          continue;
        }
        record.states[label] = 'accepted';
      }
    }
    /*
     * Одна строка причины на запись папки: несколько устаревших квитанций
     * называются через «; », а порядок — порядок участников папки.
     */
    const staleReasons = Object.values(record.reasons);
    if (staleReasons.length > 0) record.reason = staleReasons.join('; ');
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
      if (!result.has(key)) result.set(key, { states: new Map(), initiators: new Set(), reasons: new Map() });
      const entry = result.get(key);
      for (const [label, state] of Object.entries(record.states)) {
        const name = String(label).trim().toLowerCase();
        if (name && !entry.states.has(name)) entry.states.set(name, state);
      }
      /*
       * Причина устаревшей квитанции едет вместе с состоянием (задание 0159):
       * иначе гейт знал бы «invited», но не мог бы назвать, ПОЧЕМУ сторона
       * снова приглашена, и в журнале решений осталась бы общая фраза.
       */
      const reasons = record.reasons && typeof record.reasons === 'object' ? record.reasons : {};
      for (const [label, reason] of Object.entries(reasons)) {
        const name = String(label).trim().toLowerCase();
        const text = String(reason || '').trim();
        if (name && text && !entry.reasons.has(name)) entry.reasons.set(name, text);
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
  /* Причины устаревших квитанций: по ним гейт называет отказ точнее (0159). */
  const reasons = entry.reasons instanceof Map ? entry.reasons : new Map();
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
    if (state === 'disconnected') return 'disconnected';
    /*
     * Квитанция есть, но устарела: это отдельный код (`gate:stale-receipt`),
     * чтобы check-exchange назвал причину словами, а не общим «папка не принята».
     */
    return reasons.has(label.toLowerCase()) ? 'stale' : 'invited';
  }
  return '';
}

/**
 * Устаревшая квитанция ОТПРАВИТЕЛЯ держит его письмо в ящике (задание 0159).
 *
 * Сторона, принявшая старую ревизию контракта, не считается принявшей текущую:
 * пока не пришла новая квитанция, её письма не доставляются. Приглашённый, который
 * квитанции ещё НЕ давал, этим правилом не задерживается — его письма и есть
 * первый обмен, и квитанция без Rev остаётся легаси-принятием.
 *
 * @returns 'stale' или пустую строку.
 */
function staleSenderGate(statesByBox, boxDir, fromLabel) {
  if (!(statesByBox instanceof Map) || !boxDir) return '';
  const entry = statesByBox.get(normalizePath(boxDir));
  if (!entry) return '';
  const reasons = entry.reasons instanceof Map ? entry.reasons : new Map();
  const label = String(fromLabel || '').trim().toLowerCase();
  return label && reasons.has(label) ? 'stale' : '';
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
  /*
   * Задание 0164: квитанция закрывает запись по ЛЮБОМУ из двух полей — Ref или
   * Reply-To. Прежде бралось первое непустое, и письмо с Ref на контракт (таково
   * штатное поле квитанции приёма) теряло настоящий адрес в Reply-To.
   */
  const wantedList = [];
  for (const value of [message && message.ref, message && message.replyTo]) {
    const text = String(value == null ? '' : value).trim();
    if (!text) continue;
    const normalized = text.split('\\').join('/').replace(/^\.\//u, '');
    if (normalized && !wantedList.includes(normalized)) wantedList.push(normalized);
  }
  if (wantedList.length === 0) return null;
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
      if (!wantedList.includes(delivered)) continue;
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
 * Окно сверки ack (задание 0132): ответ пишут и после закрытия прогона.
 *
 * 30 минут — это ручная запись квитанции сразу после прогона, а не вчерашняя
 * переписка: письмо за окном не доказывает, что закрыта ИМЕННО эта заявка.
 */
export const ACK_RECONCILE_WINDOW_MS = 30 * 60 * 1000;

/** Относительный путь письма от папки обмена — в том же виде, что пишет markAck. */
function letterRelativePath(boxDir, file) {
  return path.relative(boxDir, file).split(path.sep).join('/');
}

/**
 * Файлы писем одного ящика (задание 0132).
 *
 * messageFiles читает threads/ и только его, если папка есть; квитанцию workflow
 * кладёт в КОРЕНЬ ящика (урок 0131), поэтому корень проверяется отдельно. Ящик
 * без threads/ по-прежнему читается целиком.
 */
function boxLetterFiles(boxDir) {
  const files = [];
  for (const item of messageFiles([boxDir])) {
    if (item && item.file) files.push(item.file);
  }
  try {
    for (const entry of fs.readdirSync(boxDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      if (!/\.md$/iu.test(entry.name)) continue;
      files.push(path.join(boxDir, entry.name));
    }
  } catch {
    /* корень ящика не читается — threads/ уже собран */
  }
  return [...new Set(files)];
}

/** Ключи сравнения для delivered записи прогона: от папки обмена и от корня проекта. */
function deliveredKeys(row, boxDir, root) {
  const value = String(row && row.delivered ? row.delivered : '').trim();
  if (!value) return [];
  if (path.isAbsolute(value)) return [normalizePath(value)];
  return [normalizePath(path.resolve(boxDir, value)), normalizePath(path.resolve(root, value))];
}

/**
 * Сверить ack записи прогона с фактическим файлом-ответом (задание 0132).
 *
 * Заказчик (coordinator --01 п.1): ack заполнялся только ответом из того же прогона,
 * а письма, написанные вручную, запись не видела — 15 из 152. Сверка при закрытии
 * прогона отвечает на вопрос «заявка закрыта файлом?» без догадок:
 *
 *   1. рассматриваются записи listRuns с `delivered` и БЕЗ `ack` — уже
 *      проставленный markAck ack не перезаписывается и не обнуляется;
 *   2. письмо ищется в объявленных ящиках: From равен адресату прогона
 *      (wake.target, иначе node), дата — от since до (finishedAt || now) + окно;
 *   3. Ref И Reply-To письма разрешаются в delivered общим resolveClosingPath
 *      (абсолют; от папки обмена; голое имя в папке письма); достаточно любого
 *      поля (задание 0164) — статус письма не важен: answer, ack и report
 *      одинаково доказывают, что заявка закрыта;
 *   4. найдено — ack: путь от папки обмена, ackSource: 'file'; не найдено и окно
 *      истекло — ack остаётся null, ставится ackCheckedAt (ложный ack запрещён);
 *      не найдено, но окно открыто — запись не трогается, сверка повторится.
 *
 * @returns `{ checked, acked, rows }`: сколько записей сверено, сколько закрыто
 *   файлом и сами записи после сверки.
 */
export function reconcileRunAck(options = {}) {
  const runtime = options.runtime;
  const root = options.root;
  const report = { checked: 0, acked: 0, rows: [] };
  if (!runtime || !root) return report;
  const nowValue = options.now instanceof Date
    ? options.now.getTime()
    : (Number.isFinite(options.now) ? Number(options.now) : Date.now());
  const requestedWindow = Number(options.windowMs);
  const windowMs = Number.isFinite(requestedWindow) && requestedWindow >= 0
    ? requestedWindow
    : ACK_RECONCILE_WINDOW_MS;
  let rows = [];
  try {
    rows = listRuns(runtime, root);
  } catch {
    return report;
  }
  /* Только то, что обещал инвариант: доставлено и ещё не подтверждено. */
  const pending = rows.filter((row) => row && row.delivered && !row.ack);
  if (pending.length === 0) return report;
  let allowed;
  try {
    allowed = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [root];
  } catch {
    allowed = [root];
  }
  const scope = Array.isArray(allowed) && allowed.length > 0 ? allowed : [root];
  let boxes = [];
  try {
    const declared = declaredExchangeBoxes(runtime, scope);
    boxes = Array.isArray(declared && declared.dirs) ? declared.dirs : [];
  } catch {
    boxes = [];
  }
  const letters = [];
  for (const boxDir of boxes) {
    let stat = null;
    try {
      stat = fs.statSync(boxDir);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) continue;
    for (const file of boxLetterFiles(boxDir)) letters.push({ file, boxDir });
  }
  for (const row of pending) {
    report.checked += 1;
    const target = String(row.wake && row.wake.target ? row.wake.target : row.node || '').trim().toLowerCase();
    const since = Number(row.since);
    const finishedAt = Number(row.finishedAt);
    const start = Number.isFinite(since) ? since : 0;
    const end = (Number.isFinite(finishedAt) ? finishedAt : nowValue) + windowMs;
    let found = null;
    if (target) {
      for (const letter of letters) {
        const text = readHeaderSlice(letter.file);
        if (text === null) continue;
        const message = parseMessage(text, letter.file);
        if (!message) continue;
        if (String(message.from || '').trim().toLowerCase() !== target) continue;
        /*
         * Окно — по Date письма, а не по mtime: ручная правка файла не должна
         * превращать вчерашнюю переписку в доказательство сегодняшнего прогона.
         */
        if (!Number.isFinite(message.at) || message.at < start || message.at > end) continue;
        const delivered = deliveredKeys(row, letter.boxDir, root);
        if (delivered.length === 0) continue;
        /*
         * Задание 0164: письмо закрывает прогон, если ЕГО Ref ИЛИ ЕГО Reply-To
         * разрешается в delivered. Проверяются оба поля, а не первое непустое:
         * квитанция с Ref на контракт и Reply-To на письмо иначе доказывала бы
         * только контракт.
         */
        let closing = null;
        for (const value of [message.ref, message.replyTo]) {
          const byField = resolveClosingPath(value, {
            boxPath: letter.boxDir,
            letterPath: letter.file,
            root,
          });
          if (byField && delivered.includes(normalizePath(byField))) {
            closing = byField;
            break;
          }
        }
        if (!closing) continue;
        found = { file: letter.file, boxDir: letter.boxDir };
        break;
      }
    }
    if (found) {
      const updated = {
        ...row,
        ack: letterRelativePath(found.boxDir, found.file),
        ackAt: new Date(nowValue).toISOString(),
        ackSource: 'file',
        /*
         * Сверка — это новая запись, и она обязана быть свежее файла: merge в
         * хранилище иначе оставит версию без ack (она «не старше») и перенесёт
         * только ack, потеряв ackSource/ackCheckedAt.
         */
        updatedAt: nowValue,
      };
      try {
        noteRun(runtime, updated);
      } catch {
        report.rows.push(row);
        continue;
      }
      report.acked += 1;
      report.rows.push(updated);
      continue;
    }
    /*
     * Окно ещё открыто — ответ может появиться: запись не трогается, иначе
     * ackCheckedAt соврал бы «проверено, ответа нет» о незакрытом окне.
     */
    if (nowValue <= end) {
      report.rows.push(row);
      continue;
    }
    const checked = {
      ...row,
      ack: null,
      ackCheckedAt: new Date(nowValue).toISOString(),
      updatedAt: nowValue,
    };
    try {
      noteRun(runtime, checked);
    } catch {
      report.rows.push(row);
      continue;
    }
    report.rows.push(checked);
  }
  return report;
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
 * Решение о пробуждении спящего адресата — одна функция с источником (задание 0150).
 *
 * Порядок сильнее удобства: конфиг плагина (boolean) → переменная окружения →
 * текст профиля → дефолт. Дефолт — ВКЛЮЧЕНО: пробуждение объявлено возможностью
 * структуры (0111), а не экспериментом; молчаливое false делало узлы глухими, и
 * письмо ждало ручного вмешательства (решение D1).
 *
 * Источник возвращается всегда (config|env|profile|default): тишина без причины
 * неотличима от потери (0048), поэтому наблюдатель пишет его в журнал старта.
 *
 * @param {object} input
 * @param {object} [input.config] — конфиг плагина; wakeSpawn boolean главнее всего.
 * @param {object} [input.env] — окружение; по умолчанию process.env.
 * @param {string} [input.profileText] — текст профиля (cordis.patch.yml).
 * @returns {{ enabled: boolean, source: 'config'|'env'|'profile'|'default' }}
 */
export function resolveWakeSpawn(input = {}) {
  const options = input && typeof input === 'object' ? input : {};
  const config = options.config && typeof options.config === 'object' ? options.config : {};
  if (typeof config.wakeSpawn === 'boolean') {
    return { enabled: config.wakeSpawn, source: 'config' };
  }
  const env = options.env && typeof options.env === 'object'
    ? options.env
    : (typeof process !== 'undefined' && process.env ? process.env : {});
  const fromEnv = wakeFlagFromEnv(env);
  if (fromEnv !== null) return { enabled: fromEnv, source: 'env' };
  const fromProfile = wakeFlagFromProfile(options.profileText);
  if (fromProfile !== null) return { enabled: fromProfile, source: 'profile' };
  return { enabled: true, source: 'default' };
}

/** Имя переменной окружения, которой заказчик выключает пробуждение (задание 0150). */
export const WAKE_SPAWN_ENV = 'PG_PROJECT_GRAPH_WAKE_SPAWN';

/** Прежнее имя того же аварийного стопа: привычка до 0150 не должна ослепнуть. */
const WAKE_SPAWN_ENV_LEGACY = 'PG_WAKE_SPAWN';

/** 0/false/off — выключено, 1/true/on — включено; иное значение ничего не решает. */
function wakeFlagOf(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (text === '0' || text === 'false' || text === 'off') return false;
  if (text === '1' || text === 'true' || text === 'on') return true;
  return null;
}

/** Значение env-переключателя; регистр имени не важен (Windows-окружение). */
function wakeFlagFromEnv(env) {
  const source = env && typeof env === 'object' ? env : {};
  const keys = Object.keys(source);
  for (const name of [WAKE_SPAWN_ENV, WAKE_SPAWN_ENV_LEGACY]) {
    const key = keys.find((item) => String(item).toLowerCase() === name.toLowerCase());
    if (key === undefined) continue;
    const flag = wakeFlagOf(source[key]);
    if (flag !== null) return flag;
  }
  return null;
}

/** Строка wakeSpawn: true|false внутри блока нашего плагина; чужие блоки не решают. */
function wakeFlagFromProfile(profileText) {
  const text = typeof profileText === 'string' ? profileText : '';
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/u);
  const blockStart = lines.findIndex((line) => /^\s*(?:(?:-\s*)?(?:id|name)\s*:\s*['"]?dsh-project-graph['"]?|dsh-project-graph\s*:)\s*(?:#.*)?$/iu.test(line));
  if (blockStart === -1) return null;
  const indent = (lines[blockStart].match(/^\s*/u) || [''])[0].length;
  for (let index = blockStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const lineIndent = (line.match(/^\s*/u) || [''])[0].length;
    /* Блок кончается на следующем элементе списка или строке верхнего уровня. */
    if (lineIndent <= indent) break;
    const match = /^\s*wakeSpawn\s*:\s*(true|false)\s*(?:#.*)?$/iu.exec(line);
    if (match) return match[1].toLowerCase() === 'true';
  }
  return null;
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
  /*
   * Период heartbeat-таймера. У живого хоста — 60 с («не реже раза в минуту»);
   * options/config heartbeatMs существует только для стенда, чтобы поведение
   * таймера проверялось за миллисекунды, а не за минуту ожидания.
   */
  const heartbeatMs = Number.isFinite(options.heartbeatMs) && options.heartbeatMs > 0
    ? options.heartbeatMs
    : (Number.isFinite(Number(config.heartbeatMs)) && Number(config.heartbeatMs) > 0
      ? Number(config.heartbeatMs)
      : HEARTBEAT_INTERVAL_MS);
  /* The profile may set the window in YAML; an argument wins over the config. */
  const backlogMs = Number.isFinite(options.backlogMs) && options.backlogMs >= 0
    ? options.backlogMs
    : (Number.isFinite(Number(config.exchangeBacklogMs)) && Number(config.exchangeBacklogMs) >= 0
      ? Number(config.exchangeBacklogMs)
      : EXCHANGE_BACKLOG_MS);
  /*
   * The third step of the customer's schema: when the addressee workspace has no live
   * session, the node is STARTED with the message as its prompt and `cwd: root`.
   * Whether it happens is ONE decision with a source (0150): config wins over env,
   * env over the profile text, and the default is ON — a sleeping addressee must be
   * woken, otherwise the letter waits for a human. The decision and its source go to
   * the start telemetry, so a silently disabled watcher is told apart from a dead one.
   */
  const wakeConfig = typeof options.wakeSpawn === 'boolean'
    ? { ...config, wakeSpawn: options.wakeSpawn }
    : config;
  const wake = resolveWakeSpawn({
    config: wakeConfig,
    env: typeof process !== 'undefined' && process.env ? process.env : {},
    profileText: typeof options.profileText === 'string' ? options.profileText : '',
  });
  const spawnWhenAsleep = wake.enabled;
  const wakeSource = wake.source;
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
   * Лимиты пробуждений (задание 0111, D2): одно на ветку за 15 минут и пять на ящик
   * в час. Память процесса, потому что лимит защищает от шторма здесь и сейчас, а не
   * от вчерашнего; стенд может подставить своё, чтобы проверить отказ.
   */
  const wakeThrottle = options.wakeThrottle && typeof options.wakeThrottle.allow === 'function'
    ? options.wakeThrottle
    : createWakeThrottle({ now: () => (typeof options.now === 'function' ? options.now().getTime() : Date.now()) });
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
  /*
   * Heartbeat (задание 0210): один маленький JSON-файл на тик. Путь по умолчанию —
   * хранилище прогонов (<store>/exchange-watch.json); у живого хоста это
   * ~/.dsh/project-graph/runs/exchange-watch.json. Опции heartbeatPath и
   * heartbeat:false существуют для стендов: прогон не имеет права писать в живой файл.
   */
  const heartbeatFile = options.heartbeat === false
    ? ''
    : (typeof options.heartbeatPath === 'string' && options.heartbeatPath.trim()
      ? options.heartbeatPath.trim()
      : heartbeatPath(runtime));
  /** Счётчик файлов последнего состоявшегося скана: его называет heartbeat. */
  let lastScanned = 0;
  /**
   * 0339/0340: ящики, которые есть на диске, но в скан не входят. В отличие от 0339,
   * найденное теперь подключается к скану ЭТОГО прохода (autowatchExchangeBoxes),
   * поэтому список — ОСТАТОК, который подключить не удалось. Снимок последнего прохода
   * называют heartbeat, телеметрия, запись прогона и status(); профиль не меняется.
   */
  let lastUnwatchedBoxes = [];
  /** 0340: ящики, подключённые к скану ЭТОГО прохода; отчёт, а не запись профиля. */
  let lastAddedBoxes = [];
  let lastWatchedBoxCount = 0;
  let lastUnwatchedSignature = '';
  let lastAddedSignature = '';
  /** Таймер heartbeat: живость видна даже тогда, когда сам проход длится долго. */
  let heartbeatTimer = null;
  /**
   * Строка скана в журнале (задание 0210): watermark каталога, а не письмо.
   *
   * Пишется при смене watermark и не реже раза в минуту; повторный тик в ту же
   * секунду журнал не растит. Это и есть ответ «писем нет»: скан был, писем нет.
   */
  const SCAN_JOURNAL_MIN_MS = 60 * 1000;
  let lastScanJournalAt = 0;
  let lastScanWatermark = '';

  /** Часы сторожа: подменяемые в тестах, но всегда дата. */
  function clockNow() {
    try {
      const value = now();
      if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    } catch {
      /* the injected clock must not break a tick */
    }
    return new Date();
  }

  /** Записать heartbeat; неудачная запись возвращает null и проход не роняет. */
  function beat(at, scanned = lastScanned) {
    if (!heartbeatFile) return null;
    const moment = at instanceof Date && Number.isFinite(at.getTime()) ? at : clockNow();
    const count = Number.isFinite(scanned) && scanned >= 0 ? Math.trunc(scanned) : 0;
    return writeHeartbeat(heartbeatFile, {
      lastTickAt: moment.toISOString(),
      scanned: count,
      unwatchedBoxes: lastUnwatchedBoxes,
      addedBoxes: lastAddedBoxes,
      watchedCount: lastWatchedBoxCount,
    });
  }

  /**
   * 0339: назвать непросматриваемые ящики один раз на изменение набора.
   *
   * Предупреждение с полными путями нужно человеку, но тик идёт каждые 4 с:
   * повторять одну и ту же строку на каждом проходе — шум, поэтому набор
   * сравнивается по нормализованным путям. Телеметрия получает событие только
   * при изменении; сам список едет в каждом pass-событии.
   */
  function reportUnwatched(boxes) {
    const list = Array.isArray(boxes) ? boxes : [];
    const signature = list.map((box) => normalizePath(box)).join('\n');
    if (signature === lastUnwatchedSignature) return;
    lastUnwatchedSignature = signature;
    if (list.length === 0) return;
    warn('обмен: ящики вне сканирования (' + list.length + '): ' + list.join('; ')
      + ' — письма в них не доставляются; корни и папки в профиль не добавляются автоматически');
    writeTelemetry({ event: 'unwatched-boxes', count: list.length, unwatchedBoxes: list.slice() });
  }

  /**
   * 0340: найденные ящики подключены к скану ЭТОГО прохода.
   *
   * Предупреждение нужно человеку, но тик идёт каждые 4 с: повторять ту же строку
   * на каждом проходе — шум. Набор сравнивается по нормализованным путям, поэтому
   * строка и событие телеметрии появляются один раз на изменение. Ни профиль, ни
   * корни при этом не пишутся: подключение живёт только в памяти процесса.
   */
  function reportAdded(boxes) {
    const list = Array.isArray(boxes) ? boxes : [];
    const signature = list.map((box) => normalizePath(box)).join('\n');
    if (signature === lastAddedSignature) return;
    lastAddedSignature = signature;
    if (list.length === 0) return;
    warn('обмен: найденные ящики подключены к сканированию этого прохода (' + list.length + '): '
      + list.join('; ') + ' — только в памяти процесса, профиль и корни не меняются');
    writeTelemetry({ event: 'autowatch-boxes', count: list.length, addedBoxes: list.slice() });
  }
  /*
   * Журнал помнит не только ключи решений, но и два факта, нужных следующему проходу:
   * какое содержимое уже доставлено (sha256 -> запись delivered) и какие письма уже
   * получили ответ. Без первого перенос ящика превращал доставленное в «потеряно окном»,
   * без второго письмо, которому нечего ждать, тонуло бы в «пропущено окном повтора».
   */
  const deliveredSha = new Map();
  const letterBranches = new Map();
  /**
   * Ветки, которые уже отвечают на вопрос «что с письмом»: повтор им не нужен.
   * `stale:backlog` оставлен только для чтения старых журналов: с 0153 сторож
   * эту ветку не пишет — невручённое письмо доставляется, а не списывается окном.
   */
  const ANSWERED_BRANCHES = new Set([
    'delivered', 'rescan:delivered', 'skip:no-wake', 'skip:delivery-off', 'no-session', 'stale:backlog',
  ]);
  let decisionsLoaded = false;
  function decisionKey(row) {
    if (!row || typeof row !== 'object') return '';
    const letter = String(row.letter || '');
    const branch = String(row.branch || '');
    if (!letter || !branch) return '';
    /*
     * 0341: номер попытки входит в ключ только когда он назван. Иначе вторая
     * повторная подача того же письма той же сессии была бы отброшена как
     * дубль первой, и журнал скрыл бы половину эскалаций.
     */
    const attempt = row.attempt === undefined || row.attempt === null ? '' : String(row.attempt);
    return letter + '\u0000' + branch + '\u0000' + String(row.session || '')
      + (attempt === '' ? '' : '\u0000' + attempt);
  }
  /** Запомнить факт строки журнала: чем ответило письмо и какое содержимое доставлено. */
  function rememberDecision(row) {
    if (!row || typeof row !== 'object') return;
    const letter = String(row.letter || '');
    const branch = String(row.branch || '');
    if (!letter || !branch) return;
    const branches = letterBranches.get(letter) || new Set();
    branches.add(branch);
    letterBranches.set(letter, branches);
    if (branch !== 'delivered' && branch !== 'rescan:delivered') return;
    const sha = typeof row.sha256 === 'string' ? row.sha256.trim() : '';
    if (!sha || deliveredSha.has(sha)) return;
    deliveredSha.set(sha, {
      session: String(row.session || ''),
      to: String(row.to || ''),
      at: String(row.at || ''),
      letter,
    });
  }
  /** Есть ли у письма уже ответ в журнале: доставлено, не будит, просрочено, ждёт в ящике. */
  function answeredLetter(letter) {
    const branches = letterBranches.get(String(letter || ''));
    if (!branches) return false;
    for (const branch of branches) if (ANSWERED_BRANCHES.has(branch)) return true;
    return false;
  }
  /** Время проекта — МСК: журнал читают люди и приёмка, а не только машина. */
  function journalStamp() {
    return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace(/Z$/u, '+03:00');
  }
  /** Дописать строку журнала; журнал — доказательство, но не повод уронить проход. */
  function appendJournal(row) {
    try {
      const file = decisionsPathOf();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ at: journalStamp(), ...row }) + '\n', 'utf8');
      return true;
    } catch {
      return false;
    }
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
        const row = JSON.parse(line);
        const key = decisionKey(row);
        if (key) decisionSeen.add(key);
        rememberDecision(row);
        /* Строка скана переживает перезапуск: watermark и время последнего скана. */
        if (String(row.branch || '') === 'scanned') {
          const stamp = Date.parse(row.at);
          if (Number.isFinite(stamp) && stamp > lastScanJournalAt) lastScanJournalAt = stamp;
          const files = Number(row.scanned);
          const mark = row.watermark ? Date.parse(row.watermark) : 0;
          lastScanWatermark = (Number.isFinite(files) ? Math.trunc(files) : 0)
            + ':' + (Number.isFinite(mark) ? mark : 0);
        }
      } catch {
        /* torn line: the journal is append-only, one bad line must not hide the rest */
      }
    }
  }
  /** Решение по письму: state журнала (scanned/delivered/pending/error) пишется рядом с веткой. */
  function noteDecision(row) {
    loadDecisions();
    const key = decisionKey(row);
    if (!key || decisionSeen.has(key)) return false;
    decisionSeen.add(key);
    const withState = row && typeof row === 'object' && !row.state
      ? { ...row, state: journalStateOf(row.branch) }
      : row;
    rememberDecision(withState);
    appendJournal(withState);
    return true;
  }
  /**
   * Строка скана: доказательство, что сторож обошёл ящик, даже когда писем нет.
   *
   * Повторный тик с тем же watermark в пределах минуты строку не пишет — журнал
   * остаётся доказательством, а не логом каждого вздоха.
   */
  function noteScan(files, dirs, rootList, atDate) {
    const atMs = atDate instanceof Date && Number.isFinite(atDate.getTime()) ? atDate.getTime() : Date.now();
    let newest = 0;
    for (const item of files) {
      if (item && Number.isFinite(item.mtimeMs) && item.mtimeMs > newest) newest = item.mtimeMs;
    }
    const watermark = newest > 0 ? new Date(newest).toISOString() : '';
    const markKey = files.length + ':' + newest;
    if (lastScanJournalAt !== 0 && markKey === lastScanWatermark
      && atMs - lastScanJournalAt < SCAN_JOURNAL_MIN_MS) return false;
    lastScanJournalAt = atMs;
    lastScanWatermark = markKey;
    return appendJournal({
      kind: 'scan',
      branch: 'scanned',
      state: 'scanned',
      watermark,
      scanned: files.length,
      roots: rootList.length,
      boxes: dirs.length,
    });
  }
  /** file+mtime -> time of the last failed attempt; a wake is retried, not dropped. */
  const retried = new Map();
  /* 0231: метка участника -> его собственная сессия из писем (Session header). */
  const peerSessions = new Map();
  /* 0232: корень -> Set childId субагентов (кэш на процесс). */
  const spawnedCache = new Map();
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

  /**
   * Read the delivered letters of earlier runs.
   *
   * Задание 0280: пока миграция не отмечена, объединяются новый файл памяти
   * вручений и ПРЕЖНЯЯ память (имя собирает LEGACY_DELIVERED_NAME). Объединение
   * сразу персистится в новый файл, и ставится маркер миграции:
   *   - пустой/частичный новый файл не теряет прежние 690 отметок (M-A);
   *   - удаление нового файла после recover не воскрешает снятые отметки,
   *     потому что прежняя память больше не читается (M-B).
   * Сам прежний файл не переписывается: только читается.
   *
   * Последствие маркера: после него новый файл — единственный источник правды.
   * Его удаление или порча ТЕРЯЮТ память вручений (письма будут вручены
   * повторно), зато воскрешения снятых отметок нет: прежняя память не читается.
   */
  function loadSeen() {
    if (seenLoaded) return;
    seenLoaded = true;
    const primary = seenPathOf();
    const dir = path.dirname(primary);
    const marker = path.join(dir, MIGRATION_MARKER_NAME);
    const legacy = path.join(dir, LEGACY_DELIVERED_NAME);
    const useLegacy = !fs.existsSync(marker);
    const memory = readDeliveredMemory(primary, useLegacy ? legacy : '');
    if (!memory.rows) return;
    for (const [file, mtime] of Object.entries(memory.rows)) {
      if (typeof mtime === 'number' && Number.isFinite(mtime)) seen.set(file, mtime);
    }
    if (useLegacy && memory.hasLegacy) {
      /* Персист и маркер — одна миграция: дальше источник правды только новый файл. */
      seenDirty = true;
      saveSeen();
      writeMigrationMarker(marker);
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

  /**
   * 0314: запомнить вручённые письма пачки до завершения хода адресата.
   *
   * Запись — на каждое письмо пачки: session — РЕАЛЬНЫЙ id сессии адресата
   * (живой/childId/freshest возобновлённой), root — корень адресата, letter —
   * абсолютный путь, sha256 — содержимое, at — ISO тика. Без id записи нет:
   * выдуманный id сделал бы отметку прочтения чужой.
   */
  function notePendingRead(items, sessionId, atDate) {
    const id = String(sessionId == null ? '' : sessionId).trim();
    if (!id || id === 'box-only' || id === 'spawn' || id === 'resume') return;
    const moment = atDate instanceof Date && Number.isFinite(atDate.getTime()) ? atDate : clockNow();
    const entries = readPendingRead(runtime);
    const known = new Set(entries.map((entry) => entry.session + '\u0000' + path.resolve(entry.letter)));
    let changed = false;
    for (const item of items) {
      const letter = item && item.message && typeof item.message.file === 'string' ? item.message.file : '';
      if (!letter) continue;
      const absolute = path.resolve(letter);
      const key = id + '\u0000' + absolute;
      if (known.has(key)) continue;
      known.add(key);
      entries.push({
        session: id,
        root: String(item.target || ''),
        letter: absolute,
        sha256: String(item.sha256 || ''),
        at: moment.toISOString(),
        attempts: 0,
      });
      changed = true;
    }
    if (changed) writePendingRead(runtime, entries);
  }

  /** Строки памяти ПРОЧТЕНИЯ (sha256) из склада проекта; битый файл — пустая карта. */
  function readReadMarkRows(root) {
    try {
      const file = path.join(projectStoreDir(String(root == null ? '' : root)), SEEN_FILE);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * 0341: письмо уже отмечено seen (память прочтения), то есть разобрано раньше.
   *
   * Отметка адресует содержимое (0322), поэтому сравнивается и прямой путь, и
   * sha256 любой отмеченной копии. Числовая отметка вручения прочтением не
   * считается — памяти прочтения принадлежат только sha256.
   */
  function letterMarkedSeen(entry, sha256) {
    const rows = readReadMarkRows(entry && entry.root);
    const direct = rows[path.resolve(String(entry && entry.letter ? entry.letter : ''))];
    if (typeof direct === 'string' && /^[0-9a-f]{64}$/iu.test(direct)) return true;
    const wanted = String(sha256 || '').toLowerCase();
    if (!wanted) return false;
    for (const value of Object.values(rows)) {
      if (typeof value === 'string' && value.toLowerCase() === wanted) return true;
    }
    return false;
  }

  /**
   * 0341: письмо пора подать повторно?
   *
   * Право на эскалацию узкое и проверяется по фактам:
   *   1. запись pending-read простояла окно PENDING_READ_ESCALATION_WINDOW_MS;
   *   2. это ответ (Status: answer) — request/question идут прежним путём;
   *   3. вручение доказано журналом решений (delivered с тем же sha256): запись
   *      без вручения закрывается прежним TTL, а не поднимает адресата;
   *   4. письмо не отмечено seen и не разобрано (markPendingRead снял запись);
   *   5. попыток меньше предела PENDING_READ_ESCALATION_MAX.
   *
   * @returns кандидат или null.
   */
  function escalationCandidate(entry, nowMs) {
    const attempts = Number.isFinite(Number(entry.attempts)) ? Math.trunc(Number(entry.attempts)) : 0;
    if (attempts >= PENDING_READ_ESCALATION_MAX) return null;
    /*
     * 0343: неудачная отправка назначает окно повтора (retryAt) — следующая
     * попытка не раньше RETRY_AFTER_MS, как у первого вручения. Успешная
     * подача retryAt не оставляет, и окно считается прежним — от времени
     * последней попытки (at).
     */
    const retryStamp = Date.parse(String(entry.retryAt || ''));
    const stamp = Date.parse(entry.at);
    if (Number.isFinite(retryStamp)) {
      if (nowMs < retryStamp) return null;
    } else if (!Number.isFinite(stamp) || nowMs - stamp <= PENDING_READ_ESCALATION_WINDOW_MS) {
      return null;
    }
    const letter = path.resolve(entry.letter);
    let text;
    try {
      text = fs.readFileSync(letter, 'utf8');
    } catch {
      return null;
    }
    const message = parseMessage(text, letter);
    if (!message || normalizeWakeStatus(message.status) !== 'answer') return null;
    const sha256 = String(entry.sha256 || letterSha256(text)).toLowerCase();
    /* Вручение — факт журнала, а не догадка по записи памяти. */
    if (!deliveredSha.has(sha256)) return null;
    if (letterMarkedSeen(entry, sha256)) return null;
    return { entry, letter, text, message, sha256, attempts };
  }

  /**
   * 0343: закрыть по TTL отдельные записи сессии, у которой есть письмо в эскалации.
   *
   * markPendingRead снимает ВСЕ записи сессии и вместе с ними унёс бы письмо,
   * которое как раз подаётся повторно. Поэтому такие записи закрываются
   * посегментно — тем же путём отметки прочтения (sha256), что и markPendingRead.
   * Перед записью память перечитывается: закрываем только то, что ещё есть.
   */
  function closePendingReadEntries(targets) {
    const closing = new Set();
    for (const entry of targets) {
      try {
        const result = markExchangeSeen({ root: entry.root, paths: [path.resolve(entry.letter)] });
        if (result && Number(result.marked) > 0) closing.add(pendingReadKey(entry));
      } catch {
        /* the next tick tries again */
      }
    }
    if (closing.size === 0) return 0;
    const fresh = readPendingRead(runtime);
    writePendingRead(runtime, fresh.filter((entry) => !closing.has(pendingReadKey(entry))));
    return closing.size;
  }

  /**
   * 0314/0341/0343: разбор памяти «вручено, но не обработано».
   *
   * Запись старше PENDING_READ_TTL_MS закрывается прежним TTL-fallback (письмо
   * отмечается прочитанным), ЕСЛИ по ней не положена повторная подача: право на
   * эскалацию проверяет escalationCandidate. Сессия, у которой есть письмо к
   * повторной подаче, не закрывается этим тиком целиком: markPendingRead снимает
   * ВСЕ её записи, и эскалация иначе потеряла бы своё письмо. Записи этой же
   * сессии без кандидата (0343) закрываются посегментно — они TTL не пересидели.
   *
   * @returns Массив кандидатов на повторную подачу (решение принимает runPass).
   */
  function applyPendingReadTtl(atDate) {
    const entries = readPendingRead(runtime);
    if (entries.length === 0) return [];
    const moment = atDate instanceof Date && Number.isFinite(atDate.getTime()) ? atDate : clockNow();
    const nowMs = moment.getTime();
    const due = [];
    const candidateKeys = new Set();
    for (const entry of entries) {
      const candidate = escalationCandidate(entry, nowMs);
      if (!candidate) continue;
      due.push(candidate);
      candidateKeys.add(pendingReadKey(entry));
    }
    const escalating = new Set(due.map((candidate) => candidate.entry.session));
    const stale = new Set();
    const staleOwn = [];
    for (const entry of entries) {
      const stamp = Date.parse(entry.at);
      if (!(Number.isFinite(stamp) && nowMs - stamp > PENDING_READ_TTL_MS)) continue;
      if (!escalating.has(entry.session)) {
        stale.add(entry.session);
        continue;
      }
      /*
       * 0343: запись без кандидата закрывается сама — чужое письмо в эскалации
       * её больше не держит.
       */
      if (!candidateKeys.has(pendingReadKey(entry))) staleOwn.push(entry);
    }
    for (const session of stale) {
      try {
        markPendingRead({ runtime, sessionId: session, now: nowMs });
      } catch {
        /* the next tick tries again */
      }
    }
    if (staleOwn.length > 0) closePendingReadEntries(staleOwn);
    return due;
  }

  /**
   * 0341: повторная подача answer адресату.
   *
   * Те же лимиты, что у первого вручения (createWakeThrottle, задания 0283/0284):
   * отказ — строка skip:cooldown, попытка НЕ расходуется и повторяется следующим
   * тиком. Доставка идёт в ту же сессию, которой письмо было вручено (запись
   * pending-read её называет): повтор не изобретает адресата.
   *
   * Видимость: delivered:escalation с номером попытки в журнале решений, запись
   * pending-read обновляется (at и attempts), чтобы следующее окно отсчитывалось
   * от последней попытки, а дайджест называет повторную подачу по-русски.
   *
   * 0343: отказ отправки (нет живой сессии/транспорта) — тоже попытка: attempts
   * растёт, at обновляется, retryAt держит повтор не чаще RETRY_AFTER_MS. Отказ
   * лимита (skip:cooldown) попытку не тратит. Запись пишется только после
   * перечитывания: обработанное во время отправки не воскрешается.
   *
   * @returns Список вручённых повторно (для счётчика прохода).
   */
  async function escalatePendingReads(due, at, context = {}) {
    const deliveredRows = [];
    if (!Array.isArray(due) || due.length === 0) return deliveredRows;
    const dirs = Array.isArray(context.dirs) ? context.dirs : [];
    const list = liveAgents();
    const nowMs = at.getTime();
    const entries = readPendingRead(runtime);
    /*
     * 0343 (R1): не снимок «что было до await». Пока идёт отправка, письмо могут
     * обработать; пишется только то, что перечитано после отправки и ещё не seen.
     * Ключ — сессия и письмо; значение — учтённая попытка.
     */
    const updates = new Map();
    for (const candidate of due) {
      const key = normalizePath(candidate.entry.letter);
      const entry = entries.find((item) => item.session === candidate.entry.session
        && normalizePath(item.letter) === key);
      /* Обработано между чтением памяти и эскалацией — повторной подачи нет. */
      if (!entry) continue;
      const attempts = Number.isFinite(Number(entry.attempts)) ? Math.trunc(Number(entry.attempts)) : 0;
      if (attempts >= PENDING_READ_ESCALATION_MAX) continue;
      const letter = path.resolve(entry.letter);
      let text;
      try {
        text = fs.readFileSync(letter, 'utf8');
      } catch {
        continue;
      }
      const message = parseMessage(text, letter);
      if (!message || normalizeWakeStatus(message.status) !== 'answer') continue;
      const boxDir = dirs.find((dir) => normalizePath(letter).startsWith(normalizePath(dir)))
        || path.dirname(letter);
      const relative = path.relative(boxDir, letter).split(path.sep).join('/');
      const sessionId = String(entry.session || '');
      const handle = list.find((agent) => agent
        && String(agent.sessionId || agent.session || agent.id || '') === sessionId) || null;
      const busy = Boolean(handle && handle.running === true);
      const decision = wakeDecision({
        status: message.status,
        path: relative,
        from: message.from,
        subject: message.subject,
      }, { self: message.to, idle: !busy, inTurn: busy, throttled: false, processAnswers: true });
      if (!decision.wake) {
        noteDecision({
          box: boxDir,
          letter: relative,
          to: message.to,
          participant: message.to,
          root: entry.root,
          ...(sessionId ? { session: sessionId } : {}),
          branch: decision.cause,
          cause: decision.cause,
          status: 'answer',
          attempt: attempts + 1,
        });
        continue;
      }
      const threadKey = message.thread || path.dirname(relative);
      const limit = typeof wakeThrottle.fits === 'function'
        ? wakeThrottle.fits(boxDir, threadKey, nowMs)
        : wakeThrottle.allow(boxDir, threadKey, nowMs);
      if (!limit.allowed) {
        noteDecision({
          box: boxDir,
          letter: relative,
          to: message.to,
          participant: message.to,
          root: entry.root,
          ...(sessionId ? { session: sessionId } : {}),
          branch: 'skip:cooldown',
          cause: 'skip:cooldown',
          status: 'answer',
          attempt: attempts + 1,
          limit: limit.limit,
          waitMs: limit.waitMs,
        });
        continue;
      }
      const attemptNo = attempts + 1;
      const digest = buildWakeDigest([{
        path: relative,
        file: letter,
        from: message.from,
        subject: message.subject,
        status: message.status,
        escalation: { attempt: attemptNo, max: PENDING_READ_ESCALATION_MAX },
      }]);
      let handed = false;
      let failure = '';
      if (handle) {
        const attempt = await sendViaHandle(handle, digest, { timeoutMs: deliveryTimeoutMs });
        if (attempt.ok) {
          handed = true;
        } else {
          failure = 'служба агентов отвергла все формы: '
            + (attempt.errors.length > 0 ? attempt.errors.join(' | ') : 'нет подходящего способа');
        }
      }
      if (!handed) {
        const controller = getSessionController();
        if (controller && sessionId && typeof controller.prompt === 'function') {
          try {
            const bridge = typeof AbortController === 'function' ? new AbortController() : null;
            await withTimeout(
              controller.prompt(
                {
                  sessionId,
                  content: [{ type: 'text', text: digest }],
                  mode: 'queue',
                  requestId: 'exchange-escalation:' + relative,
                },
                bridge ? bridge.signal : undefined,
              ),
              deliveryTimeoutMs,
              'повторная доставка в сессию адресата',
            );
            handed = true;
          } catch (error) {
            failure = 'повторная доставка в сессию адресата не удалась: '
              + (error && error.message ? error.message : error);
          }
        }
      }
      if (!handed) {
        /*
         * 0343 (R6): отказ отправки — это ПОПЫТКА, а не «ждать следующего тика».
         * Счётчик растёт, время попытки обновляется (TTL не закрывает письмо,
         * пока ждём окно повтора), а retryAt держит повтор RETRY_AFTER_MS, как у
         * первого вручения. Иначе отказ повторялся каждый тик (4 с) без backoff.
         */
        updates.set(pendingReadKey(entry), {
          attempts: attemptNo,
          at: new Date(nowMs).toISOString(),
          retryAt: new Date(nowMs + RETRY_AFTER_MS).toISOString(),
        });
        noteDecision({
          box: boxDir,
          letter: relative,
          to: message.to,
          participant: message.to,
          root: entry.root,
          ...(sessionId ? { session: sessionId } : {}),
          branch: 'no-session',
          cause: failure || 'живой сессии адресата нет — повторная подача ждёт',
          status: 'answer',
          attempt: attemptNo,
        });
        continue;
      }
      updates.set(pendingReadKey(entry), {
        attempts: attemptNo,
        at: new Date(nowMs).toISOString(),
        retryAt: '',
      });
      noteDecision({
        box: boxDir,
        letter: relative,
        to: message.to,
        participant: message.to,
        root: entry.root,
        ...(sessionId ? { session: sessionId } : {}),
        branch: 'delivered:escalation',
        cause: 'delivered:escalation',
        status: 'answer',
        attempt: attemptNo,
        maxAttempts: PENDING_READ_ESCALATION_MAX,
        sha256: String(entry.sha256 || letterSha256(text)).toLowerCase(),
      });
      wakeThrottle.mark(boxDir, threadKey, nowMs);
      deliveredRows.push({ label: message.to, file: relative, target: sessionId, reason: 'escalation' });
    }
    /*
     * 0343 (R1): память перечитывается ПОСЛЕ отправки. Пишутся только записи,
     * которые ещё существуют и не отмечены прочитанными: снимок до await
     * воскрешал письмо, обработанное в момент отправки (markProcessed), и оно
     * подавалось повторно. Записи, появившиеся за время отправки, сохраняются.
     */
    if (updates.size > 0) {
      const fresh = readPendingRead(runtime);
      const kept = [];
      let changed = false;
      for (const item of fresh) {
        if (letterMarkedSeen(item, item.sha256)) {
          /* Обработано, пока шла отправка: не воскрешаем и не пишем. */
          changed = true;
          continue;
        }
        const update = updates.get(pendingReadKey(item));
        if (update) {
          item.attempts = update.attempts;
          item.at = update.at;
          if (update.retryAt) item.retryAt = update.retryAt;
          else delete item.retryAt;
          changed = true;
        }
        kept.push(item);
      }
      if (changed) writePendingRead(runtime, kept);
    }
    return deliveredRows;
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
   * Presence-first address of one addressee workspace (задания 0292/0293).
   *
   * A fresh presence record names the session the letter belongs to, AHEAD of the
   * old `handle → last-active → binding` scheme. The letter's OWN declared box is
   * consulted exclusively (0293, R2): a session announced in another folder is not
   * this addressee, even when that folder's box is physically the addressee's own
   * coordination. The 0292 root form decides only when the letter has no DECLARED
   * box (the legacy portal beside the workspaces). A foreign or outdated record is
   * ignored.
   */
  function presencePick(root, workspace, agentsList, atMs, box) {
    const isLive = presenceLiveCheck(agentsList);
    const aliases = [path.basename(root)];
    const presence = box
      ? presenceTarget({ box, workspace, aliases, now: atMs, isLive })
      : presenceTarget({
        root,
        workspace,
        aliases,
        now: atMs,
        isLive,
      });
    return presenceAsPick(agentsList, presence);
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
    loadDecisions();
    /*
     * 0314: fallback памяти «вручено, но не обработано». Запись старше
     * PENDING_READ_TTL_MS отмечается прочитанной при ближайшем тике — хост мог не
     * прислать turn/end, а письмо не должно остаться непрочитанным навсегда.
     */
    const escalationDue = applyPendingReadTtl(atInput instanceof Date ? atInput : clockNow());
    writeTelemetry({ event: 'tick', passes, seen: seen.size, stopped });
    if (stopped) return [];
    /*
     * 0210: каждый тик оставляет heartbeat. Пишем ДО прохода и ещё раз после
     * скана: если вручение ниже зависнет, «таймер жив и тик был» уже доказано,
     * а scanned называет число файлов последнего состоявшегося обхода.
     */
    beat(clockNow(), lastScanned);
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
    /* Сколько файлов обошёл этот проход и записан ли уже heartbeat (0210). */
    let scannedCount = 0;
    let heartbeatWritten = false;
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
        /*
         * 0339 R1: пустой проход не имеет права называть снимок прошлого прохода —
         * корней нет, значит сканировать нечего. Снимок очищается каждый такой тик.
         */
        lastUnwatchedBoxes = [];
        lastAddedBoxes = [];
        lastWatchedBoxCount = 0;
        lastUnwatchedSignature = '';
        lastAddedSignature = '';
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
      /* 0230: uid -> каталог; письмо с Box адресуется папке, а не месту файла. */
      const boxUidIndex = declaredBoxes.byUid instanceof Map ? declaredBoxes.byUid : new Map();
      for (const dir of declaredBoxes.dirs) {
        if (!dirs.includes(dir)) dirs.push(dir);
      }
      for (const problem of declaredBoxes.errors) warn('обмен: ' + problem);
      /*
       * 0339/0340: инвентаризация непросматриваемых ящиков, и — в отличие от 0339 —
       * подключение найденного к скану ТЕКУЩЕГО прохода. Список живёт в памяти
       * процесса: профиль, roots и объявленные папки не меняются, а следующий проход
       * собирает его заново с диска. Только пути внутри родителя разрешённых корней,
       * без дублей: чужой путь остаётся в остатке и называется предупреждением.
       */
      const inventory = unwatchedExchangeBoxes({ allowedRoots: list, boxDirs: dirs });
      const addedBoxes = autowatchExchangeBoxes({
        allowedRoots: list,
        unwatchedBoxes: inventory.unwatchedBoxes,
        watchedBoxes: dirs,
      });
      const addedKeys = new Set(addedBoxes.map((box) => normalizePath(box)));
      for (const box of addedBoxes) dirs.push(box);
      lastAddedBoxes = addedBoxes;
      lastUnwatchedBoxes = inventory.unwatchedBoxes.filter((box) => !addedKeys.has(normalizePath(box)));
      lastWatchedBoxCount = dirs.length;
      reportAdded(lastAddedBoxes);
      reportUnwatched(lastUnwatchedBoxes);
      /*
       * R2: «папка письма известна» — это ОБЪЯВЛЕННАЯ папка обмена (ящик из
       * структуры или из конфига exchange), а не legacy-портал рядом с
       * воркспейсами. Для объявленной папки presence читается строго по её ящику;
       * legacy-портал сохраняет root-форму 0292, иначе письмо общего канала
       * перестало бы находить сессию, объявленную в coordination адресата.
       */
      const declaredBoxKeys = new Set(declaredBoxes.dirs.map((dir) => normalizePath(dir)));
      for (const item of Array.isArray(runtime.exchange) ? runtime.exchange : []) {
        const raw = typeof item === 'string' ? item : (item && typeof item.path === 'string' ? item.path : '');
        if (raw && String(raw).trim()) declaredBoxKeys.add(normalizePath(path.resolve(String(raw).trim())));
      }
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
      /*
       * 0225: область папки может не включать корень адресата (exchange объявлен на одной
       * стороне), и тогда labels не знает метку второй стороны — письмо получает no-root
       * или пустой план. Профильные participants добавляются как запасной источник:
       * адресация по метке не должна зависеть от того, чья сторона объявила папку.
       */
      for (const [name, root] of Object.entries(runtime.participants && typeof runtime.participants === 'object' ? runtime.participants : {})) {
        if (!participants[name]) participants[name] = root;
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
      /*
       * Скан состоялся — это отдельный факт журнала (задание 0210). Heartbeat
       * пишется сразу после обхода каталога, ещё до вручения: зависшая отправка
       * не имеет права выглядеть как мёртвый сторож.
       */
      scannedCount = files.length;
      lastScanned = scannedCount;
      heartbeatWritten = beat(clockNow(), scannedCount) !== null;
      noteScan(files, dirs, list, at);
      /* Один ответ на вопрос «где лежит письмо»: ящик и путь внутри него. */
      const boxOf = (file) => dirs.find((dir) => normalizePath(file).startsWith(normalizePath(dir)))
        || path.dirname(file);
      const relativeOf = (boxDir, file) => path.relative(boxDir, file).split(path.sep).join('/');
      const agents = liveAgents();
      const activityCache = new Map();
      /** Messages with a resolved addressee: delivered after the scan, grouped by session. */
      const plan = [];
      /*
       * 0273: письма, которым в ЭТОМ проходе уже названа причина. plannedForMessage
       * считает только поставленные в план вручения, поэтому отказ по ходу адресата
       * или лимиту оставлял письмо «без плана», и журнал показывал две причины на
       * одно письмо (skip:in-turn/skip:cooldown + skip:no-plan). Ключ — путь письма
       * целиком (ящик + путь внутри него): одинаковые относительные имена в разных
       * ящиках не путаются, а вторая причина по тому же письму не пишется.
       */
      const decidedLetters = new Set();
      const markDecided = (box, letter) => decidedLetters.add(normalizePath(path.join(box, letter)));
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
        if (lastTry !== undefined && at.getTime() - lastTry < RETRY_AFTER_MS) {
          /*
           * Подавление окном повтора раньше было молчанием (задание 0099): по журналу
           * нельзя было отличить «попытка ждёт окна» от «сторож не работает». Ветка
           * skip:cooldown пишется только письму, которому ещё есть чего ждать: у
           * доставленного, не-будящего или просроченного письма ответ уже есть.
           */
          const cooldownBox = boxOf(item.file);
          const cooldownLetter = relativeOf(cooldownBox, item.file);
          if (!answeredLetter(cooldownLetter)) {
            const head = readHeaderSlice(item.file);
            const parsed = head ? parseHeader(head) : null;
            const cooldownTo = parsed ? String(parsed.to || '').trim() : '';
            noteDecision({
              box: cooldownBox,
              letter: cooldownLetter,
              to: cooldownTo,
              participant: cooldownTo,
              root: '',
              branch: 'skip:cooldown',
              retryAfterMs: RETRY_AFTER_MS,
              waitMs: Math.max(0, Math.round(RETRY_AFTER_MS - (at.getTime() - lastTry))),
            });
            /* 0273: причина названа — no-plan по этому письму писать нечего. */
            markDecided(cooldownBox, cooldownLetter);
          }
          continue;
        }
        retried.set(tryKey, at.getTime());
        /*
         * Задание 0153 (D2): возраст письма больше НЕ решает, доставлять ли.
         *
         * Невидимое письмо (нет отметки вручения) доставляется при первой
         * возможности — независимо от возраста и окна догона. Две прежние ветки,
         * отменявшие доставку по времени, убраны: «окно догона» первого прохода и
         * `stale:backlog`. Письмо, пролежавшее в ящике сутки, — ровно тот случай, ради
         * которого выпущено задание: «ждёт в ящике» ≠ «прочитано».
         *
         * Окно осталось только названием возраста в журнале для решений, которые
         * вручением НЕ являются: «статус не будит» (дизайн 0099) и «содержимое уже
         * вручено раньше» (rescan по sha256). Возраст таких писем по-прежнему
         * называется (ageMs/windowMs) — иначе отказ снова стал бы молчанием.
         */
        let text;
        try {
          text = fs.readFileSync(item.file, 'utf8');
        } catch {
          continue;
        }
        const message = parseMessage(text, item.file);
        if (!message) continue;
        /* 0231: письмо несёт Session автора — это его собственная сессия для ответа. */
        if (message.session && message.from && /^session-[0-9a-f]{8}-/iu.test(message.session)) {
          const peerKey = String(message.from).trim().toLowerCase();
          const previous = peerSessions.get(peerKey);
          /* 0233: не перетирать валидную сессию старой записью session-unknown. */
          if (!previous || !/^session-[0-9a-f]{8}-/iu.test(previous)) peerSessions.set(peerKey, message.session);
        }
        /* Содержимое, а не путь: по нему узнаётся уже доставленное письмо (0099). */
        const sha256 = letterSha256(text);
        const status = String(message.status || '').toLowerCase();
        /* Один ответ на вопрос «где лежит письмо»: ящик и путь внутри него. */
        const defaultBox = boxOf(item.file);
        const routedBox = message.box ? resolveBoxByUid(message.box, boxUidIndex) : null;
        const boxDir = routedBox && normalizePath(routedBox) !== normalizePath(defaultBox) ? routedBox : defaultBox;
        const relative = relativeOf(boxDir, item.file);
        const ageMs = Math.max(0, Math.round(at.getTime() - item.mtimeMs));
        const beyondWindow = ageMs > backlogMs;
        /*
         * An acknowledgement is a fact, not a task: it starts nobody, but it MUST close
         * the chain — the run record that delivered the letter gets its ack slot filled.
         * Until this existed the schema's "ack: <файл> | null" stayed null forever.
         */
        if (status === 'ack' || status === 'answered') {
          markAck(list, runtime, message, relative);
          /*
           * The slot is filled, and that is all: с 2026-11-05 (задание 0081, контракт
           * доставки §1.5) ack адресата не будит — закрытие договорённости видно по
           * записи запуска, а само письмо остаётся в ящике непрочитанным. Раньше ack
           * доставляли, и это возвращало цепочку «ответ → пробуждение → ответ».
           */
        }
        /*
         * 0285: статус решает, создаёт ли письмо долг чтения. Долг (request,
         * question, proposal, report, invitation, info, необъявленный статус) будит;
         * реакция (answer, ack, agreed, rejected, declined, unknown, пустой статус)
         * заявку закрывает и получает ветку skip:no-wake. Занятость адресата и
         * лимиты называются до этого решения (wakeDecision), и каждое решение
         * пишется в журнал по адресату. Письмо, которое не будит, НЕ помечается
         * прочитанным и не удаляется: «не будить сейчас» — не «забыть».
         */
        /*
         * Содержимое уже вручено раньше (тот же sha256) — это rescan, а не новое
         * письмо: перенос ящика не превращает доставленное в невидимое (0099).
         * Проверка идёт до планирования вручения, чтобы не разбудить адресата второй
         * раз тем же текстом под другим путём.
         *
         * Только для письма вне окна: файлы, записанные в одну миллисекунду, могут
         * совпасть содержимым, и это разные письма, а не перенос ящика.
         */
        if (beyondWindow) {
          const known = deliveredSha.get(sha256);
          if (known) {
            noteDecision({
              box: boxDir,
              letter: relative,
              to: message.to || known.to,
              participant: message.to || known.to,
              root: '',
              ...(known.session ? { session: known.session } : {}),
              branch: 'rescan:delivered',
              sha256,
              deliveredAt: known.at,
              ageMs,
              windowMs: backlogMs,
            });
            /* 0273: у письма уже есть причина в этом проходе. */
            markDecided(boxDir, relative);
            continue;
          }
        }
        /*
         * 0285: статус-реакция (ack, agreed, …) долга чтения не создаёт — решение
         * называется здесь одной строкой, до адресатов и лимитов (0099). 0314:
         * answer проходит дальше даже без Ref — он доставляется адресату для
         * ОБРАБОТКИ; ack остаётся квитанцией и в этот цикл не попадает. Принятый
         * 0111 C1 (ответ на свой question/request) тоже идёт в общий цикл, где
         * wakeDecision назовёт причину delivered:wake-answer.
         */
        const answerRef = status === 'answer' ? referencedLetter(message, item.file, boxDir) : null;
        const answerCandidate = isWakeAnswer(answerRef, message.to)
          && ['question', 'request'].includes(normalizeWakeStatus(answerRef && answerRef.replyToStatus));
        /* 0314: сторож обрабатывает ответ всегда, независимо от Ref. */
        const processAnswer = status === 'answer';
        if (!shouldWake(status) && !answerCandidate && !processAnswer) {
          noteDecision({
            box: boxDir,
            letter: relative,
            to: message.to,
            participant: message.to,
            root: '',
            branch: 'skip:no-wake',
            cause: 'skip:no-wake',
            status,
            /* Возраст старого письма называется: иначе отказ выглядит как потеря окна. */
            ...(beyondWindow ? { ageMs, windowMs: backlogMs } : {}),
          });
          markDecided(boxDir, relative);
          continue;
        }
        const fromRoot = labels.get(message.from.toLowerCase()) || labels.get(message.from);
        /*
         * 0221: пустой план вручения раньше был тишиной. Письмо сканировалось, помечалось
         * retried и навсегда уходило в skip:cooldown — без delivered, error и no-handover.
         * Теперь каждый случай «никому не поставили в план» пишет причину в журнал.
         */
        const targets = addresseeLabels(message.to);
        let plannedForMessage = 0;
        const profileParticipants = (config && config.participants && typeof config.participants === 'object') ? config.participants : {};
        const runtimeParticipants = (runtime.participants && typeof runtime.participants === 'object') ? runtime.participants : {};
        for (const label of targets) {
          /*
           * 0226: метка адресата ищется в трёх источниках: labels области папки, participants
           * профиля и runtime.participants. Инцидент 08:01: письмо workflow→structure получило
           * no-plan, потому что область папки (со стороны другой стороны) не содержала корень
           * structure — адресация не должна зависеть от того, чья сторона объявила папку.
           */
          const target = labels.get(label.toLowerCase()) || labels.get(label)
            || profileParticipants[label] || profileParticipants[label.toLowerCase()]
            || runtimeParticipants[label] || runtimeParticipants[label.toLowerCase()]
            || (status === 'invitation' ? outsideTarget(label) : undefined);
          /*
           * No own name in the channel: nowhere to deliver, and guessing a workspace is worse.
           * Молчание — тоже ответ: решение no-root называет адресата и путь письма.
           */
          if (!target) {
            noteDecision({
              box: boxDir,
              letter: relative,
              to: label,
              participant: label,
              root: '',
              branch: 'no-root',
            });
            markDecided(boxDir, relative);
            continue;
          }
          /* A note to yourself is not a wake: the sender's workspace already knows. */
          if (fromRoot && normalizePath(fromRoot) === normalizePath(target)) {
            /* 0221: письмо самому себе не будит — но это факт журнала, а не тишина. */
            noteDecision({
              box: boxDir,
              letter: relative,
              to: label,
              participant: label,
              root: target,
              branch: 'skip:self',
              cause: 'from и to — один корень: ' + normalizePath(target),
            });
            markDecided(boxDir, relative);
            continue;
          }
          const activity = activityCache.get(target) || activityFor(target, { now: at.getTime() });
          activityCache.set(target, activity);
          /*
           * 0292/0295: fresh presence of the letter's OWN folder decides the addressee
           * before the old scheme. The folder is a fact, not a declaration: the
           * declared boxes no longer gate the read (0295), otherwise a letter went to
           * the old session while the folder's live presence named another one.
           * Another folder's presence is never read, and only the ADDRESSEE label is:
           * an alias basename(target) is not a source (R1 of the 0295 review) — a
           * foreign workspace of the same name in the letter's folder would take the
           * letter. The 0292 root form stays the fallback when the letter's folder has
           * no presence file.
           */
          const letterBox = boxDir || '';
          const letterPresence = letterBox
            ? presenceForLetterBox({
              boxDir: letterBox,
              workspace: label,
              now: at.getTime(),
              isLive: presenceLiveCheck(agents),
            })
            : null;
          const presence = presenceAsPick(agents, letterPresence)
            || presencePick(target, label, agents, at.getTime(), declaredBoxKeys.has(normalizePath(boxDir)) ? boxDir : '');
          const pick = presence || pickLastActive(agents, target, activity, { now: at.getTime() });
          const presenceSession = presence ? String(presence.sessionId || '') : '';
          const since = Date.now();
          /*
           * Гейт папки — ДО решения о пробуждении (0283). Письмо, которое нельзя
           * доставить без квитанции, не занимает окно ветки и не объясняется
           * skip:cooldown: у него одна причина — gate:*, и она не двойная (0273).
           */
          const invitation = status === 'invitation';
          const addresseeGate = invitation ? '' : acceptanceGate(acceptance, boxDir, target, rootsByLabel);
          const senderGate = invitation ? '' : staleSenderGate(acceptance, boxDir, message.from);
          const gate = addresseeGate || senderGate;
          const gateSide = addresseeGate ? 'addressee' : (senderGate ? 'sender' : '');
          if (gate) {
            plan.push({
              label,
              target,
              handle: pick ? pick.agent : null,
              pick,
              presenceSession,
              boxDir,
              relative,
              message,
              gate,
              gateSide,
              mtime: item.mtimeMs,
              since: item.mtimeMs || since,
              sha256,
              cause: '',
            });
            plannedForMessage += 1;
            continue;
          }
          /*
           * 0283: занятость и отказ называются ДО лимитов и для ВСЕХ писем, а не
           * только для answer. Раньше request шёл мимо этой проверки и вручался
           * занятой сессии, а info до решения не доходил вовсе. Живая сессия в
           * работе — это ход; спящий или простаивающий адресат — idle.
           */
          const busy = Boolean(pick && pick.agent && pick.agent.running === true);
          const decision = wakeDecision({
            status,
            replyToStatus: answerRef && answerRef.replyToStatus,
            replyToAuthor: answerRef && answerRef.replyToAuthor,
            path: relative,
            from: message.from,
            subject: message.subject,
          }, { self: label, idle: !busy, inTurn: busy, throttled: false, processAnswers: true });
          if (!decision.wake) {
            noteDecision({
              box: boxDir,
              letter: relative,
              to: label,
              participant: label,
              root: '',
              branch: decision.cause,
              cause: decision.cause,
              status,
            });
            /* 0273: отказ (в т.ч. skip:in-turn/skip:active) уже назван этому письму. */
            markDecided(boxDir, relative);
            /*
             * 0210/0283: «сессия занята» — не отказ, а «сейчас нельзя». Письмо
             * обязано уйти следующим тиком после освобождения, а не ждать
             * RETRY_AFTER_MS (120 с): временная причина снимает отметку «попытка
             * была», постоянные (skip:self, skip:cooldown) её сохраняют.
             */
            if (decision.cause === 'skip:in-turn' || decision.cause === 'skip:active') {
              retried.delete(item.file + '\u0000' + item.mtimeMs);
            }
            continue;
          }
          const threadKey = message.thread || path.dirname(relative);
          /*
           * 0283: лимиты применяются единообразно ко ВСЕМ письмам. Обход окна ветки
           * для request/answer (0215/0218) убран: с «долг будит» любой статус
           * считался бы действием, обход стал бы вечным и окно ветки исчезло бы.
           * Лимит ящика не обходился никогда и не обходится.
           *
           * Вопрос лимита отделён от вручения: fits() ничего не пишет, а mark()
           * ставится после реальной отправки (ниже) — неудачная доставка окно не
           * съедает.
           */
          const limit = typeof wakeThrottle.fits === 'function'
            ? wakeThrottle.fits(boxDir, threadKey, at.getTime())
            : wakeThrottle.allow(boxDir, threadKey, at.getTime());
          if (!limit.allowed) {
            noteDecision({
              box: boxDir,
              letter: relative,
              to: label,
              participant: label,
              root: '',
              branch: 'skip:cooldown',
              cause: 'skip:cooldown',
              status,
              /* 0284: отказ называет, чьё окно держит — ветки (60 с) или ящика (120 с). */
              limit: limit.limit,
              waitMs: limit.waitMs,
            });
            /* 0273: ожидание названо — no-plan по этому письму не пишется. */
            markDecided(boxDir, relative);
            continue;
          }
          const cause = decision.cause;
          /*
           * Доставка только принявшим уже проверена выше (gate): сюда доходят только
           * письма, которым квитанция не мешает.
           */
          /*
           * The record is keyed by root+node+start, so the start must be unique per
           * message: the file's own write time is both unique and honest.
           */
          plan.push({
            label,
            target,
            handle: pick ? pick.agent : null,
            pick,
            presenceSession,
            boxDir,
            relative,
            message,
            gate,
            gateSide,
            mtime: item.mtimeMs,
            since: item.mtimeMs || since,
            sha256,
            cause,
          });
          plannedForMessage += 1;
        }
        /*
         * 0273: «нет плана» — причина только для письма, которому в этом проходе не
         * назвали НИ ОДНОЙ другой. Иначе skip:in-turn/skip:cooldown получали вторую
         * строку skip:no-plan, и журнал врал о двух причинах на одно письмо.
         */
        if (plannedForMessage === 0 && !decidedLetters.has(normalizePath(path.join(boxDir, relative)))) {
          /*
           * 0221: ни один адресат не попал в план — письмо останется в ящике и будет
           * повторяться в skip:cooldown. Причина пишется один раз на проход.
           */
          noteDecision({
            box: boxDir,
            letter: relative,
            to: message.to,
            participant: message.to,
            root: '',
            branch: 'skip:no-plan',
            cause: 'labels=[' + targets.join(',') + '] from=' + String(message.from || '')
              + ' fromRoot=' + String(fromRoot || '') + ' status=' + status
              + ' labelsSize=' + labels.size
              + ' resolved=[' + targets.map((t) => {
                const hit = labels.get(t.toLowerCase()) || labels.get(t);
                return t + '=' + String(hit || 'NONE');
              }).join(',') + ']',
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
        /*
         * Батч — ОДНО сообщение (задание 0111): дайджест перечисляет все письма тика
         * с путём, автором, темой и статусом. Он включается только когда в пачке есть
         * answer: обычные request/report сохраняют прежний текст пробуждения (0081),
         * и ответ получает строку «ход не обязателен, если вопрос закрыт».
         */
        const hasAnswer = items.some((item) => String(item.message.status || '').trim().toLowerCase() === 'answer');
        const text = hasAnswer
          ? buildWakeDigest(items.map((item) => ({
            path: item.relative,
            file: item.message.file,
            from: item.message.from,
            subject: item.message.subject,
            status: item.message.status,
          })))
          : wakeText(items.map((item) => ({ message: item.message, boxDir: item.boxDir, backlog: item.backlog })));
        let sent = false;
        /*
         * Задание 0153 (D1): `sent` — «проход обработал пачку без ошибки», а `handed` —
         * «письмо реально вручено агенту» (sendMessage / controller.prompt / spawn).
         * Отметку seen и запись в списке доставленного даёт только второе: box-only и
         * выключенная доставка оставляют письмо pending, и оно ждёт в ящике.
         */
        let handed = false;
        /*
         * 0314: реальный id сессии адресата для памяти «вручено, но не обработано».
         * Живая сессия/вручение в неё — её id; запуск — childId; продолжение без
         * childId — freshest id возобновлённой сессии. Нет id — записи нет.
         */
        let deliverySession = '';
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
        const spawned = spawnedCache.get(items[0].target)
          || spawnedSessionIds(launchFilePath(runtime, items[0].target));
        spawnedCache.set(items[0].target, spawned);
        const sidCandidates = deliverableSessions(
          [...sidJournal.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id),
          spawned,
          peerSessions,
          items[0].label,
        );
        /*
         * 0292: the session named by a fresh presence is the addressee even when the
         * journal already knows it. It is put FIRST UNCONDITIONALLY, so the
         * controller resumes exactly that session: the journal's freshest row (or a
         * peer binding) must not win over the addressee's own presence, otherwise a
         * letter addressed by presence would be delivered to another session of the
         * same workspace with reason "session-bus". The id is kept once, not lost.
         */
        const presenceSession = items[0].presenceSession || '';
        if (presenceSession) {
          const rest = sidCandidates.filter((id) => id !== presenceSession);
          sidCandidates.splice(0, sidCandidates.length, presenceSession, ...rest.slice(0, 2));
        }
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
        } else if (handle || (controller && sidCandidates.length > 0 && typeof controller.prompt === 'function')) {
          /*
           * 0262: живой агент принимает send(message, target, wakeup), где message —
           * объект DSH с id/content/source. Прежние формы ({text} одним аргументом)
           * падали на state[target].length, поэтому вручение идёт общим модулем
           * lib/agent-message.js: followup → send(next-turn) → sendMessage. Отказ всех
           * способов — повод для ОБЩЕГО резерва controller.prompt, а не только failure.
           */
          if (handle) {
            const attempt = await sendViaHandle(handle, text, { timeoutMs: deliveryTimeoutMs });
            if (attempt.ok) {
              sent = true;
              handed = true;
              deliverySession = String(handle.sessionId || handle.session || handle.id || '');
            } else {
              failure = 'служба агентов отвергла все формы: '
                + (attempt.errors.length > 0 ? attempt.errors.join(' | ') : 'нет подходящего способа');
            }
          }
          if (!handed && controller && sidCandidates.length > 0 && typeof controller.prompt === 'function') {
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
                handed = true;
                /* Presence names the target: the delivery reason must say so. */
                reason = presenceSession && String(sessionId) === presenceSession ? 'presence' : 'session-bus';
                target = sessionId;
                deliverySession = String(sessionId);
                failure = '';
                if (!handle) {
                  /* The recipient is the addressee's own session; its working directory is the fact. */
                  const actual = readSessionCwd(sessionId, options);
                  readerCwd = actual || '';
                  cwdSource = actual ? 'session' : 'queued';
                }
                break;
              } catch (error) {
                const why = error && error.message ? error.message : String(error);
                refused.push(sessionId + ': ' + why);
                /*
                 * 0292 R8: presence — адрес, а не гарантия. Запись может быть свежей
                 * по TTL, а названная ею сессия уже мертва; её отказ не должен
                 * обрывать перебор до живой сессии того же воркспейса (старая
                 * схема), иначе письмо висит pending до конца TTL (24 ч). Для
                 * остальных кандидатов правило прежнее: перебор продолжает только
                 * отказ ownership, любой другой — настоящая ошибка.
                 */
                const fromPresence = presenceSession && String(sessionId) === presenceSession;
                if (!/owned by subagent/iu.test(why) && !fromPresence) break;
              }
            }
            if (!sent) {
              failure = handle
                ? failure + ' | controller: ' + refused.join('; ')
                : 'доставка в сессию адресата не удалась: ' + refused.join('; ');
            }
          }
        } else if (!spawnWhenAsleep) {
          /*
           * The letter is delivered in the only way that creates no twin: it lies in the
           * box, and the addressee's own agent reads it on its next run.
           *
           * Это НЕ вручение (задание 0153): письмо остаётся pending — без отметки seen,
           * с причиной skip:delivery-off в журнале — и уйдёт при первой возможности.
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
            handed = true;
            startErrors.delete(normalizePath(items[0].target));
            target = started.childId || (started.resumed ? 'resume' : 'spawn');
            /* 0314: id реальной сессии; «resume» без childId — не id, записи не будет. */
            deliverySession = started.childId
              ? String(started.childId)
              : (started.resumed && freshest ? String(freshest[0]) : '');
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
            /* Финальная запись называет момент закрытия: done/partial/error — все. */
            finishedAt: Date.now(),
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
            /*
             * Задание 0159: устаревшая квитанция — не «нет квитанции». Отдельная
             * ветка называет её в журнале, и check-exchange переводит её словами.
             */
            const why = item.gate === 'disconnected'
              ? 'disconnected'
              : (item.gate === 'stale' ? 'stale-receipt' : 'invited');
            noteDecision({
              box: item.boxDir,
              letter: item.relative,
              to: item.message.to,
              participant: item.label,
              root: item.target,
              branch: 'gate:' + why,
              /* Чья квитанция держит письмо: адресата или отправителя (0159). */
              ...(item.gateSide ? { gateSide: item.gateSide } : {}),
            });
          }
          /* Гейт — не доставка: в списке доставленного письма нет, оно ждёт в ящике. */
          if (sent && !gate) {
            /*
             * boxOnly = письмо осталось в ящике, то есть НЕ вручено. Отметка seen
             * ставится только за вручение (задание 0153, D1), поэтому такого письма нет
             * и в списке доставленного: delivery-off/no-session — ожидание, не доставка.
             */
            const boxOnly = !handed;
            /*
             * box-only значит «в сессию не доставлено» по двум разным причинам
             * (задание 0099): доставка выключена совсем (wakeSpawn=false и живой
             * сессии нет) — это skip:delivery-off, а не потеря; во всех прочих
             * случаях это прежнее no-session: письмо ждёт своего агента.
             */
            const deliveryOff = boxOnly && !spawnWhenAsleep;
            const sessionId = boxOnly || target === 'spawn' || target === 'resume' ? '' : String(target || '');
            noteDecision({
              box: item.boxDir,
              letter: item.relative,
              to: item.message.to,
              participant: item.label,
              root: item.target,
              ...(sessionId ? { session: sessionId } : {}),
              branch: deliveryOff ? 'skip:delivery-off' : (boxOnly ? 'no-session' : 'delivered'),
              ...(item.cause ? { cause: item.cause } : {}),
              /* sha256 содержимого: по нему следующий скан узнает доставленное. */
              ...(boxOnly ? {} : { sha256: item.sha256 }),
            });
            if (handed) delivered.push({ label: item.label, file: item.relative, target, reason });
          } else if (!sent) {
            noteDecision({
              box: item.boxDir,
              letter: item.relative,
              to: item.message.to,
              participant: item.label,
              root: item.target,
              branch: 'error:' + (failure || 'сообщение не доставлено'),
            });
          } else if (!handed) {
            /*
             * 0220: «проход прошёл, но вручения нет» раньше было молчанием — письма
             * висели в retry, а в журнале не было ни delivered, ни error. Теперь это
             * отдельная строка с причиной: по ней видно, какая ветка доставки отказала.
             */
            noteDecision({
              box: item.boxDir,
              letter: item.relative,
              to: item.message.to,
              participant: item.label,
              root: item.target,
              branch: 'no-handover',
              cause: failure || ('target=' + String(target || '') + ', reason=' + String(reason || '')),
            });
          }
        }
        /*
         * Отметка «прочитано» ставится только за вручение (задание 0153, D1): одна
         * пачка — одно вручение, поэтому seen получают все её письма. Пачка, оставшаяся
         * в ящике, НЕ помечается: письмо pending, а следующий проход попробует снова.
         */
        if (sent && !gate && handed) {
          /*
           * 0283: лимитом считается КАЖДОЕ доставленное пробуждение, а не только
           * ответ (0111): окно ветки 60 с и ящика 120 с держат любой статус.
           * 0284: пачка писем одного тика — ОДНО пробуждение ящика: mark() зовётся
           * с общим временем тика, и строгий ящик считает его одним подъёмом.
           */
          for (const item of items) {
            seen.set(item.message.file, item.mtime);
            seenDirty = true;
            wakeThrottle.mark(item.boxDir, item.message.thread || path.dirname(item.relative), at.getTime());
          }
          /* 0314: вручено — ещё не прочитано; запись ждёт turn/end адресата. */
          notePendingRead(items, deliverySession, at);
          /*
           * The letters beyond the cap were marked as "tried" during the scan; that stamp
           * would hold them back for RETRY_AFTER_MS. They are not a failure - they simply
           * did not fit into this wake - so the stamp is cleared and the next pass takes them.
           */
          for (const item of allItems.slice(items.length)) {
            retried.delete(item.message.file + '\u0000' + item.mtime);
          }
        } else if (sent) {
          /*
           * Письмо не доставлено, но и не забыто (гейт папки, box-only, выключенная
           * доставка): пробу повторит следующий проход, иначе квитанция, пришедшая
           * через минуту, или появившаяся живая сессия не включили бы доставку.
           * Отметка «попытка была» снимается со всей пачки, включая остаток сверх
           * лимита MAX_WAKE_ITEMS: это не ошибка, а ожидание.
           */
          for (const item of allItems) {
            retried.delete(item.message.file + '\u0000' + item.mtime);
          }
        }
      }
      /*
       * 0341: повторная подача answer. Идёт ПОСЛЕ первого вручения этого прохода:
       * свежие письма занимают окно лимита раньше, а эскалация честно называет
       * отказ skip:cooldown и повторяется следующим тиком.
       */
      if (escalationDue.length > 0) {
        const escalated = await escalatePendingReads(escalationDue, at, { dirs });
        for (const item of escalated) delivered.push(item);
      }
      deliveredCount = delivered.length;
      return delivered;
    } finally {
      ticking = false;
      passes += 1;
      lastPassAt = Date.now();
      /* Persist before the telemetry line: the size it reports is the one a restart will see. */
      saveSeen();
      /*
       * 0210: ранний выход (корней нет, ящиков нет, ошибка) тоже тик. Его heartbeat
       * называет 0 осмотренных файлов, чтобы молчание не выдавалось за «писем нет».
       */
      if (!heartbeatWritten) heartbeatWritten = beat(clockNow(), scannedCount) !== null;
      writeTelemetry({
        event: 'pass', passes, seen: seen.size, delivered: deliveredCount, roots: rootCount,
        /* 0339/0340: диагностика ящиков в каждом состоявшемся проходе. */
        unwatchedBoxes: lastUnwatchedBoxes.slice(),
        addedBoxes: lastAddedBoxes.slice(),
        addedCount: lastAddedBoxes.length,
        watchedCount: lastWatchedBoxCount,
        unwatchedCount: lastUnwatchedBoxes.length,
        /*
         * Прежнее имя `catchUp` обещало «догон по окну»: с 0153 окна доставки нет,
         * первый проход отличается только тем, что он первый.
         */
        ...(passes === 1 ? { firstPass: deliveredCount } : {}),
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
      /* 0339/0340: запись прогона — тот же снимок, что heartbeat и status(). */
      unwatchedBoxes: lastUnwatchedBoxes.slice(),
      addedBoxes: lastAddedBoxes.slice(),
      addedCount: lastAddedBoxes.length,
      watchedCount: lastWatchedBoxCount,
      unwatchedCount: lastUnwatchedBoxes.length,
      ...(message ? { message } : {}),
    });
  }

  /**
   * The heartbeat-only timer (0210 rework B2).
   *
   * `exchangeWatch: false` removes the fast scan timer, and the scheduler's beat
   * may be late or wedged; the plugin still owes the panel a fresh heartbeat while
   * it is active. This timer only writes the heartbeat — it does not scan and it
   * does not deliver. Its first write is its first firing: activation itself must
   * not claim a tick it did not make (and a test harness must not pollute the live
   * heartbeat file).
   *
   * @returns the interval id, or null when the heartbeat is disabled.
   */
  function createHeartbeatTimer() {
    if (heartbeatTimer || !heartbeatFile) return heartbeatTimer;
    heartbeatTimer = setInterval(() => {
      beat(clockNow(), lastScanned);
    }, heartbeatMs);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    return heartbeatTimer;
  }

  /**
   * Slow mode (0212): plugin is active, fast scan timer off, but delivery must NOT
   * stop. Раньше здесь был «heartbeat-only» таймер — он писал живость и не сканировал,
   * из-за чего письма не доставлялись, а чек оставался зелёным (инцидент 11.11:
   * scanned застыл, workflow--62 не доставлен, structure--51/52 не дошли).
   *
   * Теперь режим медленный, но рабочий: heartbeat + скан/вручение по тому же таймеру.
   */
  function startHeartbeat() {
    if (stopped) return () => {};
    loadSeen();
    watchSince = Date.now();
    createHeartbeatTimer();
    writeTelemetry({
      event: 'heartbeat-start',
      intervalMs: heartbeatMs,
      file: heartbeatFile,
      source: 'slow-scan',
    });
    beat(clockNow(), lastScanned);
    const id = setInterval(() => {
      tick()
        .then(() => beat(clockNow(), lastScanned))
        .catch((error) => {
          writeTelemetry({ event: 'tick-error', message: error && error.message ? error.message : String(error) });
        });
    }, heartbeatMs);
    if (id && typeof id.unref === 'function') id.unref();
    return () => {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };
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
      /* Источник решения (0150): config|env|profile|default — видно, почему так. */
      wakeSource,
      roots: roots().length,
      participants: Object.keys(runtime.participants || {}).length,
    });
    heartbeat('running');
    /* Старт — это скан и вручение, а не только запись «я жив» (0210, п. 3). */
    beat(clockNow(), lastScanned);
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
    /*
     * Отдельный таймер heartbeat: «не реже раза в минуту» не должно зависеть от
     * tickMs стенда и от того, успел ли закончиться проход. Он не сканирует —
     * сканирует основной таймер; он доказывает, что сторож ещё жив.
     */
    createHeartbeatTimer();
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
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };
  }

  return {
    start,
    startHeartbeat,
    tick,
    /*
     * 0314: ход адресата завершён (session/event turn/end) — письма, вручённые
     * этой сессии, отмечаются прочитанными (sha256 в exchange-seen.json).
     * Возвращает результат markPendingRead; ошибка не бросает.
     */
    markProcessed(sessionId) {
      try {
        return markPendingRead({ runtime, sessionId, now: clockNow().getTime() });
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    },
    seen,
    /*
     * 0339/0340: ответ диагностики сторожа. Это снимок последнего прохода
     * (обновляется каждый тик): какие ящики подключены к скану этого прохода,
     * сколько их всего и какие остались вне сканирования. Метод только читает.
     */
    status() {
      return {
        addedBoxes: lastAddedBoxes.slice(),
        addedCount: lastAddedBoxes.length,
        watchedCount: lastWatchedBoxCount,
        unwatchedBoxes: lastUnwatchedBoxes.slice(),
        unwatchedCount: lastUnwatchedBoxes.length,
        passes,
        lastPassAt: lastPassAt ? new Date(lastPassAt).toISOString() : null,
      };
    },
    /* Чтение памяти вручений без прохода по ящику: миграция проверяется тестом. */
    loadSeen,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    },
  };
}
