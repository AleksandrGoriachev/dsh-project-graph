/**
 * dsh-project-graph host half.
 *
 * Two surfaces and one exception. The `/project-graph` prefix route reads the
 * structure and edits edges: it shows the structure a project declares in
 * `structure/`. The `project_graph_spawn`/`project_graph_run` tools start one
 * agent for one node, on the model the declaration assigns. The exception is the
 * scheduler: a node that declares `schedule` is started by the host at its
 * declared time, through the same subagent service and the same run store. No
 * route is ever invented: the node declaration decides provider and model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime, readGraph, registerGraphWeb } from './api.js';
import { resolveBox } from './boxes.js';
import { identityOf } from './identity.js';
import { registerSpawnTool, registerRunTool } from './spawn.js';
import { loadValidatorSettings, validateStructure, validatorSettingsPath, watchStructure } from './structure-validator.js';
import { registerBranchTool } from './branch.js';
import { createScheduler } from './scheduler.js';
import {
  createExchangeWatcher, readSessionCwd, resolveWakeSpawn, writeSessionPresence, writeTelemetry,
} from './exchange-watch.js';
import { deliverExchangeDigest, sendDigestToSession } from './digest.js';
import { pickParent } from './parent.js';
import { recordPolicyHealth, registerStructurePolicy } from './structure-policy.js';
import { registerObligationGate } from './obligations-gate.js';
import { createSessionWatcher } from './session-watch.js';

export const name = 'dsh-project-graph';

/** Resolve `ctx.workspaceRegistry` without requiring it to be injected. */
function resolveWorkspaceRegistry(ctx) {
  const candidates = [
    () => ctx.workspaceRegistry,
    () => (ctx.get ? ctx.get('workspaceRegistry') : undefined),
    () => (ctx.reflect && ctx.reflect.get ? ctx.reflect.get('workspaceRegistry', false) : undefined),
  ];
  for (const read of candidates) {
    try {
      const registry = read();
      if (registry && typeof registry.list === 'function') return registry;
    } catch {
      /* try the next resolution path */
    }
  }
  return null;
}

function resolveService(ctx, name) {
  try {
    return ctx.get ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the session journals live.
 *
 * A live agent does not always carry its folder: the cwd lives in the session and
 * in its journal under this folder (0083). The runtime or the profile may point at
 * it explicitly; otherwise DSH's own default is used. Read on every pick, because
 * a host build or a test may set runtime.sessionsDir after the plugin loaded.
 */
function sessionsDirOf(config, runtime) {
  const fromRuntime = runtime && typeof runtime.sessionsDir === 'string' ? runtime.sessionsDir.trim() : '';
  if (fromRuntime) return fromRuntime;
  const fromConfig = config && typeof config.sessionsDir === 'string' ? config.sessionsDir.trim() : '';
  if (fromConfig) return fromConfig;
  return path.join(os.homedir(), '.dsh', 'sessions');
}

/** Path comparison key: case and separators do not decide a workspace. */
function pathKeyOf(value) {
  try {
    return path.resolve(String(value || '')).replace(/\\/gu, '/').toLowerCase();
  } catch {
    return String(value || '').replace(/\\/gu, '/').toLowerCase();
  }
}

/** Is `candidate` inside `root`? Equal paths count as inside. */
function isInsideRootPath(root, candidate) {
  try {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

/** Live agent rows of the service, or an empty list; never throws. */
function agentRows(service) {
  if (!service) return [];
  try {
    const rows = typeof service.roots === 'function'
      ? service.roots()
      : (typeof service.list === 'function' ? service.list() : []);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Session id of one agent row; a row without an id is not a session. */
function agentSessionId(agent) {
  return String((agent && (agent.sessionId || agent.session || agent.id)) || '').trim();
}

/**
 * The presence session of this process (задание 0292).
 *
 * The id comes from DSH_SESSION_ID, otherwise from the live agent of THIS
 * workspace. An unresolvable id is empty — an invented one would address letters
 * to a session that does not exist. The folder comes from the agent or from the
 * host's session cache, never from a guess.
 */
function resolvePresenceSession({ agents, cwd, env } = {}) {
  const rows = agentRows(agents).filter((agent) => agentSessionId(agent));
  const fromEnv = env && typeof env.DSH_SESSION_ID === 'string' ? env.DSH_SESSION_ID.trim() : '';
  if (fromEnv) {
    const own = rows.find((agent) => agentSessionId(agent) === fromEnv);
    return {
      sessionId: fromEnv,
      cwd: own && typeof own.cwd === 'string' && own.cwd.trim() ? own.cwd.trim() : '',
    };
  }
  const exact = cwd
    ? rows.filter((agent) => typeof agent.cwd === 'string' && agent.cwd.trim() && pathKeyOf(agent.cwd) === pathKeyOf(cwd))
    : [];
  const inside = cwd
    ? rows.filter((agent) => typeof agent.cwd === 'string' && agent.cwd.trim() && isInsideRootPath(cwd, agent.cwd))
    : [];
  const pool = exact.length > 0 ? exact : inside;
  const live = pool.filter((agent) => agent.running !== false);
  const pick = live.length === 1 ? live[0] : (pool.length === 1 ? pool[0] : null);
  return pick
    ? { sessionId: agentSessionId(pick), cwd: String(pick.cwd || '') }
    : { sessionId: '', cwd: '' };
}

/**
 * The workspace whose presence this process may write.
 *
 * The session's own folder wins when it is a declared root (or is inside one).
 * With no declared roots at all the folder itself is the workspace. A folder
 * outside every declared root is NOT claimed: presence must not name a
 * workspace the plugin does not know.
 */
function ownWorkspaceRoot(roots, sessionCwd) {
  const list = (Array.isArray(roots) ? roots : []).filter((root) => typeof root === 'string' && root.trim());
  const cwd = String(sessionCwd || '').trim();
  if (!cwd) return list.length === 1 ? list[0] : '';
  const exact = list.find((root) => pathKeyOf(root) === pathKeyOf(cwd));
  if (exact) return exact;
  const inside = list.filter((root) => isInsideRootPath(root, cwd)).sort((left, right) => right.length - left.length);
  if (inside.length > 0) return inside[0];
  return list.length === 0 ? cwd : '';
}

/**
 * Is this workspace one of the folder's declared participants?
 *
 * Строки participants сравниваются без учёта регистра — прежнее правило. С 0374
 * папка называет участника ещё и ОБЪЯВЛЕННЫМИ ПУТЯМИ: воркспейс разрешается тем же
 * lib/identity.js, что и область обмена (карта профиля сильнее пути папки), и
 * сравнивается корень с корнем. Папку без путей это не меняет: для неё остаётся
 * только строковое сопоставление.
 */
function folderHasParticipant(folder, workspace, participants) {
  const name = String(workspace == null ? '' : workspace).trim();
  if (!name) return false;
  const list = folder && Array.isArray(folder.participants) ? folder.participants : [];
  if (list.some((item) => typeof item === 'string' && item.trim().toLowerCase() === name.toLowerCase())) {
    return true;
  }
  const own = folderPathsOf(folder);
  const ownLabels = Object.keys(own).filter((label) => typeof label === 'string' && label.trim());
  if (ownLabels.length === 0) return false;
  const context = {
    participants: participants && typeof participants === 'object' && !Array.isArray(participants)
      ? participants
      : {},
    folders: [folder],
  };
  const identity = identityOf(name, context);
  if (identity.kind !== 'label' && identity.kind !== 'path') return false;
  if (!identity.root) return false;
  const declared = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) declared.push(identityOf(item, context));
  }
  for (const label of ownLabels) declared.push(identityOf(label, context));
  for (const value of Object.values(own)) {
    if (typeof value === 'string' && value.trim()) declared.push(identityOf(value, context));
  }
  return declared.some((item) => (item.kind === 'label' || item.kind === 'path')
    && item.root && pathKeyOf(item.root) === pathKeyOf(identity.root));
}

/** Paths the folder itself declares: label -> absolute path. */
function folderPathsOf(folder) {
  return folder && folder.paths && typeof folder.paths === 'object' && !Array.isArray(folder.paths)
    ? folder.paths
    : {};
}

/** A map lookup that tolerates the case a label happens to be written in. */
function mapValueOf(map, label) {
  const key = String(label == null ? '' : label).trim();
  if (!key) return '';
  if (typeof map[key] === 'string' && map[key].trim()) return map[key];
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(map)) {
    if (String(name).toLowerCase() === lower && typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/**
 * Roots of THIS folder's participants (задание 0293, R1).
 *
 * A shared box is the common parent of the workspaces that take part in the
 * folder, so the resolver must receive THEIR roots and nothing else. Sources, in
 * the order the panel and folderSelfLabel use: the folder's own paths, the
 * profile map (runtime.participants), an absolute label, then a caller root whose
 * directory name is the label. A participant nobody can place stays unknown: the
 * folder then has fewer than two roots and resolveBox refuses instead of
 * inventing a box out of a foreign workspace.
 */
function presenceParticipantRoots(folder, base, roots, participants) {
  const own = folderPathsOf(folder);
  const map = participants && typeof participants === 'object' ? participants : {};
  const pool = [];
  const addPool = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const resolved = path.resolve(value.trim());
    if (!pool.some((item) => pathKeyOf(item) === pathKeyOf(resolved))) pool.push(resolved);
  };
  for (const item of Array.isArray(roots) ? roots : []) addPool(item);
  addPool(base);
  const list = [];
  for (const item of Array.isArray(folder && folder.participants) ? folder.participants : []) {
    const label = String(item == null ? '' : item).trim();
    if (!label) continue;
    let value = '';
    if (path.isAbsolute(label)) value = label;
    else if (typeof own[label] === 'string' && own[label].trim()) value = own[label];
    else value = mapValueOf(map, label);
    if (!value) {
      const byName = pool.find((candidate) => path.basename(candidate).toLowerCase() === label.toLowerCase());
      if (byName) value = byName;
    }
    if (!value) continue;
    const resolved = path.resolve(value.trim());
    if (!list.some((entry) => pathKeyOf(entry) === pathKeyOf(resolved))) list.push(resolved);
  }
  return list;
}

/**
 * Participant paths declared anywhere in the structure (folder.paths of ANY
 * folder, as lib/boxes.js reads them).
 *
 * They are NOT handed to resolveBox as roots (that was R1): they only say how
 * many of THIS folder's participants have a declared path, so a shared box can
 * still be resolved from declarations the way rule 1 of resolveBox does.
 */
function presenceDeclaredParticipantPaths(folder, folders) {
  const registry = new Map();
  for (const item of Array.isArray(folders) ? folders : []) {
    for (const [label, value] of Object.entries(folderPathsOf(item))) {
      if (typeof label !== 'string' || !label.trim()) continue;
      if (typeof value !== 'string' || !value.trim()) continue;
      if (!registry.has(label.trim())) registry.set(label.trim(), path.resolve(value.trim()));
    }
  }
  const own = folderPathsOf(folder);
  const paths = [];
  const add = (value) => {
    const resolved = path.resolve(value);
    if (!paths.some((item) => pathKeyOf(item) === pathKeyOf(resolved))) paths.push(resolved);
  };
  for (const item of Array.isArray(folder && folder.participants) ? folder.participants : []) {
    const label = String(item == null ? '' : item).trim();
    if (!label) continue;
    const hit = own[label] || registry.get(label);
    const absolute = hit || (path.isAbsolute(label) ? label : '');
    if (absolute) add(absolute);
  }
  return paths;
}

/**
 * The folder box in the shape lib/boxes.js resolves.
 *
 * resolveBox understands the two declared modes (shared/workspace). An
 * unrecognized value is read as the default `shared`: presence is announced
 * best-effort at init and must not lose a participant folder over a hint the
 * resolver does not know. resolveBox itself stays strict for its own callers.
 */
function presenceFolderBox(folder) {
  const box = folder && folder.box && typeof folder.box === 'object' && !Array.isArray(folder.box)
    ? folder.box
    : null;
  if (!box) return null;
  return { ...box, root: box.root === 'workspace' ? 'workspace' : 'shared' };
}

/**
 * Resolve the box of ONE folder for presence through lib/boxes.js.
 *
 * The declared rule decides first (same call as the watcher/panel). When the
 * declaration carries a hint resolveBox does not know (anything but
 * shared/workspace), the folder is not dropped silently: presence is what tells a
 * folder which session reads it, so the same resolver is asked again with the box
 * read from the parent of the workspace root, where a shared box declared beside
 * the project actually lies. A declared shared box is never guessed: with no
 * participants' roots the resolver refuses honestly and the folder keeps the old
 * addressing. A workspace-mode box also stays inside its own workspace.
 *
 * @returns absolute box directory or ''.
 */
function resolvePresenceBox(box, folder, base, participantRoots, declaredPaths, folders, allowFallback, strictShared) {
  const ask = (rootDir, mode) => {
    try {
      const result = resolveBox({
        root: rootDir,
        folder: { ...folder, box: { ...box, root: mode } },
        roots: participantRoots,
        folders,
      });
      return result && result.status === 'ok' && typeof result.path === 'string' && result.path
        ? result.path
        : '';
    } catch {
      return '';
    }
  };
  /*
   * R1: declared shared box without a single participant root is NOT resolved
   * through the "known workspaces" fallback of resolveBox — that would build a
   * box out of another folder's paths and create a directory outside the
   * project. A refusal is named by the caller and the folder is skipped.
   */
  if (strictShared && participantRoots.length === 0 && declaredPaths < 2) return '';
  const declared = ask(base, box.root);
  if (declared) return declared;
  if (!allowFallback || box.root === 'workspace') return '';
  const parent = path.dirname(path.resolve(base));
  return ask(parent, 'workspace');
}

/**
 * Which folders of the structure this workspace announces presence in, and which
 * participant folders were refused (задание 0293).
 *
 * One entry per folder where the workspace is a participant: folders carrying
 * duplicate boxes are kept as separate entries so the refusal of one declaration
 * never hides another. A folder whose box does not resolve lands in `skipped`.
 *
 * @returns `{ boxes: [{folder, box}], skipped: [{folder, box, reason}] }`.
 */
function presenceBoxPlan({ graph, root, roots, workspace, participants } = {}) {
  const name = String(workspace == null ? '' : workspace).trim();
  const base = String(root == null ? '' : root).trim();
  const plan = { boxes: [], skipped: [] };
  if (!name || !base) return plan;
  const folders = graph && Array.isArray(graph.folders) ? graph.folders.filter(Boolean) : [];
  if (folders.length === 0) return plan;
  for (const folder of folders) {
    if (!folderHasParticipant(folder, name, participants)) continue;
    const id = String(folder.id == null ? '' : folder.id);
    const rawMode = folder.box && typeof folder.box.root === 'string' ? folder.box.root.trim() : 'shared';
    const box = presenceFolderBox(folder);
    if (!box) {
      plan.skipped.push({ folder: id, box: '', reason: 'box-missing' });
      continue;
    }
    /*
     * Запасное правило — только для подсказки, которой резолвер не знает: явный
     * shared без данных честно не разрешается (папка не притворяется), а
     * незнакомое значение не должно лишать папку presence на инициализации.
     */
    const allowFallback = rawMode !== 'shared' && rawMode !== 'workspace';
    const participantRoots = presenceParticipantRoots(folder, base, roots, participants);
    const declaredPaths = presenceDeclaredParticipantPaths(folder, folders).length;
    const boxPath = resolvePresenceBox(
      box,
      folder,
      base,
      participantRoots,
      declaredPaths,
      folders,
      allowFallback,
      rawMode === 'shared',
    );
    if (!boxPath) {
      plan.skipped.push({ folder: id, box: '', reason: 'box-unresolved' });
      continue;
    }
    plan.boxes.push({ folder: id, box: boxPath });
  }
  return plan;
}

/**
 * Exchange folders where `workspace` is a participant, with the box resolved by
 * lib/boxes.js (задание 0293).
 *
 * The list is the SAME rule the watcher and the panel use: folders come from
 * graph.folders, the box comes from resolveBox asked with the roots of THAT
 * folder's participants (the profile map says which label is which workspace).
 * A folder whose box does not resolve is omitted with no throw — one broken
 * declaration never hides the valid ones, and its directory is never created.
 *
 * @returns `[{ folder, box }]` — folder id and the absolute box directory.
 */
export function presenceBoxes({ graph, root, roots, workspace, participants } = {}) {
  const plan = presenceBoxPlan({ graph, root, roots, workspace, participants });
  const boxes = [];
  const seen = new Set();
  for (const item of plan.boxes) {
    const key = pathKeyOf(item.box);
    if (seen.has(key)) continue;
    seen.add(key);
    boxes.push(item);
  }
  return boxes;
}

/**
 * Announce this workspace's session presence in EVERY exchange folder where the
 * workspace is a participant (задание 0293).
 *
 * Each folder gets its own `<box>/presence/<workspace>.json`. A failing folder
 * (unresolvable box, read-only directory) is named in `skipped` and does not
 * stop the others: the function never throws, because presence is an addition to
 * the old addressing scheme, not a condition of the plugin. A participant folder
 * whose box the resolver refused is named in `skipped` too — nothing is invented
 * and no directory outside the declared box is created.
 *
 * @returns `{ written: [{ folder, box, file }], skipped: [{ folder, box, reason }] }`.
 */
export function announcePresence({ graph, root, roots, workspace, sessionId, participants } = {}) {
  const name = String(workspace == null ? '' : workspace).trim();
  const id = String(sessionId == null ? '' : sessionId).trim();
  const written = [];
  const skipped = [];
  let plan;
  try {
    plan = presenceBoxPlan({ graph, root, roots, workspace: name, participants });
  } catch (error) {
    skipped.push({ folder: '', box: '', reason: error && error.message ? String(error.message) : 'boxes-failed' });
    return { written, skipped };
  }
  skipped.push(...plan.skipped);
  if (!id) {
    for (const item of plan.boxes) skipped.push({ folder: item.folder, box: item.box, reason: 'no-session' });
    return { written, skipped };
  }
  for (const item of plan.boxes) {
    let record = null;
    try {
      record = writeSessionPresence({ box: item.box, workspace: name, sessionId: id });
    } catch {
      record = null;
    }
    if (record) {
      written.push({ folder: item.folder, box: item.box, file: path.join(item.box, 'presence', name + '.json') });
    } else {
      skipped.push({ folder: item.folder, box: item.box, reason: 'write-failed' });
    }
  }
  return { written, skipped };
}

/**
 * Labels the structure uses for this workspace (задание 0293, R4).
 *
 * The presence file is named after the workspace; the exchange addresses the
 * side by its PARTICIPANT label (structure/workflow/...), while 0292 wrote the
 * folder name. The profile map (runtime.participants) says which label belongs to
 * this root — the same source folderSelfLabel uses for self; a mapped workspace
 * that CONTAINS this root also names it, because a registered nested workspace
 * still speaks as its declared side. Declared folder paths and the folder name
 * are kept as before. Whichever name addressing uses finds the same session.
 */
export function presenceWorkspaceLabels(graph, ownRoot, fallback, participants, me) {
  const labels = [];
  const add = (value) => {
    const label = String(value == null ? '' : value).trim();
    if (label && !labels.includes(label)) labels.push(label);
  };
  const here = String(ownRoot == null ? '' : ownRoot).trim();
  add(me);
  const map = participants && typeof participants === 'object' ? participants : {};
  const mapped = [];
  if (here) {
    for (const [label, target] of Object.entries(map)) {
      if (typeof target !== 'string' || !target.trim()) continue;
      const resolved = path.resolve(target.trim());
      if (pathKeyOf(resolved) === pathKeyOf(here)) {
        mapped.push({ label, depth: resolved.length });
      } else if (isInsideRootPath(resolved, here)) {
        /* Живой корень может быть вложен в объявленный воркспейс — метка та же. */
        mapped.push({ label, depth: resolved.length });
      }
    }
  }
  mapped.sort((left, right) => right.depth - left.depth);
  for (const item of mapped) add(item.label);
  const folders = graph && Array.isArray(graph.folders) ? graph.folders : [];
  for (const folder of folders) {
    for (const [label, value] of Object.entries(folderPathsOf(folder))) {
      if (typeof value === 'string' && value.trim() && pathKeyOf(value) === pathKeyOf(here)) add(label);
    }
  }
  add(fallback);
  return labels;
}

/**
 * Session events that announce a session which ALREADY exists (задание 0294).
 *
 * On a live host start there are no agents yet and the plugin process carries no
 * DSH_SESSION_ID, so the apply-path presence is skipped; the session appears
 * later and nobody announces it. The start of its first turn (or its creation)
 * carries the id and the folder — enough to write presence in every exchange
 * folder of the workspace.
 */
const PRESENCE_START_EVENTS = new Set(['turn/start', 'session/created', 'session/start']);

/**
 * The facts a session start event gives about the session (задание 0294).
 *
 * The id comes from the event; the folder comes from the event, otherwise from
 * the host's session cache. Both stay empty when the host has not named them —
 * presence must not be invented for a folder nobody declared.
 */
function presenceSessionFacts(session, sessionCacheDir) {
  const id = String(session && session.id != null ? session.id : '').trim();
  let cwd = session && typeof session.cwd === 'string' ? session.cwd.trim() : '';
  if (!cwd && id) {
    try {
      cwd = readSessionCwd(id, sessionCacheDir ? { sessionCacheDir } : {}) || '';
    } catch {
      cwd = '';
    }
  }
  return { id, cwd };
}

/**
 * The graph a session-start presence is written from (задание 0294).
 *
 * The start event names the workspace itself, so a box whose declared root is
 * neither `shared` nor `workspace` is read as lying INSIDE that workspace: the
 * declaration is relative to the project the session just started. The init path
 * keeps its own 0293 reading of an unknown hint (shared with the parent-dir
 * fallback); the live structure declares only the two known modes, so this never
 * changes an existing box.
 */
function presenceSessionGraph(graph) {
  const shape = graph && typeof graph === 'object' && !Array.isArray(graph) ? graph : {};
  const folders = Array.isArray(shape.folders) ? shape.folders : [];
  return {
    ...shape,
    folders: folders.filter((folder) => folder && typeof folder === 'object').map((folder) => {
      const box = folder.box && typeof folder.box === 'object' && !Array.isArray(folder.box) ? folder.box : null;
      const mode = box && typeof box.root === 'string' ? box.root.trim() : '';
      if (!box || mode === 'shared' || mode === 'workspace') return folder;
      return { ...folder, box: { ...box, root: 'workspace' } };
    }),
  };
}

/**
 * Announce presence when a session starts its turn (задание 0294).
 *
 * The session exists from this moment, so its id and folder are facts. Presence
 * is written in EVERY exchange folder of the workspace with the same
 * announcePresence/presenceWorkspaceLabels rule 0293 uses; the apply-path stays
 * as the fallback. An unknown id, an unresolvable folder or a folder outside the
 * declared roots writes nothing and returns null — presence is never invented,
 * and the function never throws. A repeated turn/start rewrites the same file
 * with a fresh `at`, it does not add records.
 *
 * @returns `{ written: [{ folder, box, file }], skipped: [...] }` or null.
 */
export function presenceOnSessionEvent({ type, session, sessionCacheDir, root, roots, graph, participants, me } = {}) {
  const kind = String(type == null ? '' : type).trim();
  if (!PRESENCE_START_EVENTS.has(kind)) return null;
  const facts = presenceSessionFacts(session, sessionCacheDir);
  if (!facts.id || !facts.cwd) return null;
  const list = (Array.isArray(roots) ? roots : []).filter((item) => typeof item === 'string' && item.trim());
  if (list.length === 0 && typeof root === 'string' && root.trim()) list.push(root);
  const ownRoot = ownWorkspaceRoot(list, facts.cwd);
  if (!ownRoot) return null;
  const workspace = path.basename(ownRoot);
  const shape = presenceSessionGraph(graph);
  let written = [];
  let skipped = [];
  const labels = presenceWorkspaceLabels(shape, ownRoot, workspace, participants, me);
  for (const label of labels) {
    const result = announcePresence({
      graph: shape,
      root: ownRoot,
      roots: list,
      workspace: label,
      sessionId: facts.id,
      participants,
    });
    written = written.concat(result.written);
    skipped = skipped.concat(result.skipped);
  }
  return { written, skipped };
}

/** Live agents service: the scheduler needs a parent for a host-started run. */
function resolveAgents(ctx) {
  try {
    if (ctx && ctx.agents) return ctx.agents;
  } catch {
    /* a scoped context may refuse the read; fall through */
  }
  return resolveService(ctx, 'agents') || null;
}

/**
 * Текст профиля — последний источник решения о пробуждении (задание 0150).
 *
 * Конфиг плагина не всегда несёт wakeSpawn: хост показывал выключенное
 * пробуждение, когда cordis.patch.yml говорил true. Профиль читается
 * best-effort: нет файла, нет прав, кривой путь — это «профиль молчит», а не
 * сбой старта. Активный профиль берётся из DSH_PROFILE_DIR/DSH_PROFILE, иначе
 * первый найденный ~/.dsh/profiles/<имя>/cordis.patch.yml (порядок стабилен).
 */
function wakeProfileText() {
  try {
    const env = typeof process !== 'undefined' && process.env ? process.env : {};
    const dir = typeof env.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : '';
    const name = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : '';
    const candidates = [];
    if (dir) candidates.push(path.join(dir, 'cordis.patch.yml'));
    if (name) candidates.push(path.join(os.homedir(), '.dsh', 'profiles', name, 'cordis.patch.yml'));
    if (!dir && !name) {
      const base = path.join(os.homedir(), '.dsh', 'profiles');
      const entries = fs.readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) candidates.push(path.join(base, entry.name, 'cordis.patch.yml'));
    }
    for (const file of candidates) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        if (text.trim()) return text;
      } catch {
        /* следующий кандидат: профиль — подсказка, а не условие */
      }
    }
  } catch {
    /* профиль недоступен: решение останется за конфигом, env или дефолтом */
  }
  return '';
}

export function apply(ctx, config = {}) {
  const runtime = createGraphRuntime(config, {
    getWorkspaceRegistry: () => resolveWorkspaceRegistry(ctx),
    getLlm: () => resolveService(ctx, 'llm'),
    getSubagents: () => resolveService(ctx, 'subagents'),
    getPresets: () => resolveService(ctx, 'agentPresets'),
    /* Live agents of the host: the panel maps them onto its nodes, not only its own children. */
    getAgents: () => resolveAgents(ctx),
    providerName: typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : 'spawn',
    /*
     * 0292: службы хоста для присутствия и пробуждения — те же, что у сторожа
     * обмена. Без них маршрут честно ответит «нет сессии», а не выдумает цель.
     */
    getSessionController: () => resolveService(ctx, 'sessionController') || null,
    getParent: (root) => chooseParent(root).parent,
  });
  /*
   * 0139: провайдеры рантайма — запасное доказательство для плана, когда каталог
   * llm недоступен. Тогда узел с provider, которого нет у хоста, отказывает до
   * запуска (provider-missing со списком и подсказкой), а не рождается и падает
   * NO_ADAPTER в сессии. Служба отвечает списком или промисом; нет службы/ошибка —
   * undefined, и план работает как раньше (доказательства нет).
   */
  const knownProvidersOf = async () => {
    let llm;
    try {
      llm = typeof runtime.getLlm === 'function' ? runtime.getLlm() : null;
    } catch {
      return undefined;
    }
    if (!llm || typeof llm.listProviders !== 'function') return undefined;
    let providers;
    try {
      providers = await llm.listProviders();
    } catch {
      return undefined;
    }
    if (!Array.isArray(providers)) return undefined;
    const ids = [];
    for (const row of providers) {
      if (!row) continue;
      const id = typeof row === 'string'
        ? row.trim()
        : (typeof row.id === 'string' && row.id.trim() ? row.id.trim()
          : (typeof row.name === 'string' ? row.name.trim() : ''));
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids.length > 0 ? ids : undefined;
  };
  /*
   * 0138: проба фактического cwd ребёнка — кэш сессий хоста, где DSH держит
   * рабочий каталог сессии. Живой случай ws-school-app --05: spawn вернул
   * childId, а сессия легла в воркспейс родителя; проба говорит, где она на
   * самом деле, и запуск не выглядит успешным.
   *
   * Это НЕ sessionsDir журналов (~/.dsh/sessions): журналы — не кэш, и подстановка
   * их сюда сделала бы пробу всегда пустой, то есть отключила бы проверку ровно
   * там, где она нужна. Каталог кэша берётся из runtime/config, если хост его
   * назвал; иначе действует умолчание readSessionCwd
   * (~/.dsh/storages/session_projcache/sessions).
   */
  const sessionCacheDirOf = () => {
    const fromRuntime = runtime && typeof runtime.sessionCacheDir === 'string' ? runtime.sessionCacheDir.trim() : '';
    if (fromRuntime) return fromRuntime;
    const fromConfig = config && typeof config.sessionCacheDir === 'string' ? config.sessionCacheDir.trim() : '';
    return fromConfig;
  };
  const probeCwdOf = () => {
    const dir = sessionCacheDirOf();
    return (sessionId) => readSessionCwd(sessionId, dir ? { sessionCacheDir: dir } : {});
  };
  /*
   * 0342: гейт записи резолвит относительный путь от каталога вызывающей
   * сессии. Каталог кэша сессий хоста публикуется на рантайме: гейт читает его
   * тем же резолвером (readSessionCwd), а не угадывает путь к кэшу. Пустое
   * значение — резолвер применит своё умолчание, то есть прежнее поведение.
   */
  try {
    runtime.sessionCacheDir = sessionCacheDirOf();
  } catch {
    /* рантайм может быть заморожен: гейт возьмёт умолчание резолвера */
  }
  /*
   * Declared before the scheduler: its tick may run synchronously on start and calls
   * this on every beat, so the binding must already exist (a TDZ error would swallow
   * the first exchange pass silently).
   */
  let exchangeTick = null;
  /*
   * The feasibility check needs the LLM route table, the subagent provider and
   * the preset registry. They are optional services: inject lazily and keep the
   * runtime getters pointed at the scoped instances when they arrive.
   */
  try {
    /*
     * Capture the service instance, not the injection scope: a scope can become
     * inactive (hot reload, effect cleanup), and reading scope.llm afterwards
     * throws "cannot get required service ... in inactive context".
     */
    ctx.inject(['llm'], (scope) => { const service = scope.llm; runtime.getLlm = () => service; });
    ctx.inject(['agentPresets'], (scope) => { const service = scope.agentPresets; runtime.getPresets = () => service; });
    ctx.inject(['subagents'], (scope) => { const service = scope.subagents; runtime.getSubagents = () => service; });
    /* 0288: политика выбора моделей сессии — часть услуги DSH, а не наше решение. */
    ctx.inject(['sessionProjections'], (scope) => { const service = scope.sessionProjections; runtime.getSessionProjections = () => service; });
    /*
     * Installing the workflow plugin is the host's job: the panel only hands the
     * configured spec to pluginManager. The service is optional, so a host
     * without it keeps refusing with a recipe instead of failing to load.
     */
    ctx.inject(['pluginManager'], (scope) => { const service = scope.pluginManager; runtime.getPluginManager = () => service; });
  } catch {
    /* the panel still reads the structure without those services */
  }
  /*
   * The scheduler is the one place where the panel acts instead of reading: a
   * node with `schedule` is started by the host at its declared time. The run
   * goes through ctx.subagents exactly like project_graph_run, with the first
   * live root agent as parent; without one the tick writes an error run and
   * waits for the next window (a missed window is never caught up).
   */
  /*
   * The parent of a host-started run: a live agent of the node's OWN workspace, never
   * a stranger. A session of another workspace carries that workspace's folder, so a
   * borrowed parent makes the child read the wrong folder and the activation die with
   * "the agent finished without a report". No own agent = no run, with the reason.
   * Both the scheduler and the exchange wake use it.
   *
   * The cwd is not always on the agent (0083): pickParent receives the sessions
   * folder, so an agent whose folder lives only in its session or journal is still
   * proven to be "own". Without that the nightly critic stopped at "no live agent"
   * while its session was alive. An agent without a session is not an error.
   */
  const chooseParent = (root) => {
    const sessionsDir = sessionsDirOf(config, runtime);
    const agents = resolveAgents(ctx);
    if (!agents) return pickParent({ agents: [], root, sessionsDir });
    try {
      const roots = typeof agents.roots === 'function' ? agents.roots() : [];
      const list = Array.isArray(roots) && roots.length > 0
        ? roots
        : (typeof agents.list === 'function' ? agents.list() : []);
      return pickParent({ agents: Array.isArray(list) ? list : [], root, sessionsDir });
    } catch {
      return pickParent({ agents: [], root, sessionsDir });
    }
  };
  /* Agent handle or null: the exchange watcher expects the handle itself. */
  const resolveParent = (root) => chooseParent(root).parent;
  /** Журнал плагина: сообщение хост-логу, и никогда — исключение. */
  const warn = (message) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[dsh-project-graph] ' + message);
      else console.warn('[dsh-project-graph] ' + message);
    } catch {
      /* журнал не имеет права ломать хост */
    }
  };
  /*
   * Presence сессии (задания 0292/0293): процесс, инициализировавший плагин,
   * объявляет свою сессию в КАЖДОЙ обменной папке, где его воркспейс — участник
   * (своя запись в каждой; одна папка не видит presence другой). Источник id —
   * DSH_SESSION_ID, иначе живой агент ЭТОЙ ЖЕ папки; неразрешённый id не
   * выдумывается. Сбой записи — предупреждение: старая схема адресации
   * продолжает работать.
   */
  try {
    const env = typeof process !== 'undefined' && process.env ? process.env : {};
    const cwd = (() => {
      try { return process.cwd(); } catch { return ''; }
    })();
    const resolved = resolvePresenceSession({ agents: resolveAgents(ctx), cwd, env });
    let sessionCwd = resolved.cwd;
    if (!sessionCwd && resolved.sessionId) {
      try {
        const cacheDir = sessionCacheDirOf();
        sessionCwd = readSessionCwd(resolved.sessionId, cacheDir ? { sessionCacheDir: cacheDir } : {}) || '';
      } catch {
        sessionCwd = '';
      }
    }
    const roots = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
    const ownRoot = ownWorkspaceRoot(roots, sessionCwd || cwd);
    const workspace = ownRoot ? path.basename(ownRoot) : '';
    if (!ownRoot || !workspace || !resolved.sessionId) {
      writeTelemetry({
        event: 'presence-skip',
        root: ownRoot || '',
        workspace,
        resolved: Boolean(resolved.sessionId),
      });
    } else {
      /*
       * 0293: presence — в КАЖДУЮ папку, где воркспейс участник, а не только в
       * свой coordination. Имя файла — метка участника (structure/workflow/...),
       * затем имя папки 0292: адресация находит сессию по любому из них. Сбой
       * одной папки назван в skipped и не мешает остальным.
       */
      const graph = (() => {
        try {
          const payload = readGraph(runtime, ownRoot);
          return payload && payload.graph ? payload.graph : { folders: [] };
        } catch {
          return { folders: [] };
        }
      })();
      let announced = { written: [], skipped: [] };
      /*
       * R4: метки берутся не только из folder.paths, но и из карты профиля
       * (runtime.participants): сторона workflow объявлена меткой, а её корень в
       * folder.paths не назван. Метка, объявленная профилем, — тот же источник,
       * которым folderSelfLabel называет себя в папке.
       */
      const labels = presenceWorkspaceLabels(graph, ownRoot, workspace, runtime.participants, runtime.me);
      for (const label of labels) {
        const result = announcePresence({
          graph,
          root: ownRoot,
          roots,
          workspace: label,
          sessionId: resolved.sessionId,
          participants: runtime.participants,
        });
        announced = {
          written: announced.written.concat(result.written),
          skipped: announced.skipped.concat(result.skipped),
        };
      }
      /*
       * Root-форма 0292 остаётся запасной: структура без объявленных папок или
       * отказ папки не оставляют воркспейс без presence вовсе.
       */
      const record = writeSessionPresence({ root: ownRoot, workspace, sessionId: resolved.sessionId });
      writeTelemetry({
        event: 'presence',
        root: ownRoot,
        workspace,
        written: Boolean(record) || announced.written.length > 0,
        sessionId: resolved.sessionId,
        boxes: announced.written.map((item) => ({ folder: item.folder, box: item.box, file: item.file })),
        skipped: announced.skipped,
      });
      if (!record && announced.written.length === 0) {
        warn('presence сессии не записан: '
          + path.join(ownRoot, 'coordination', 'presence', workspace + '.json'));
      }
    }
  } catch (error) {
    warn('presence сессии не записан: ' + (error && error.message ? error.message : String(error)));
  }
  /*
   * 0167: настройки валидатора читаются из проекта, а не только из конфига
   * плагина. Приоритет решения — файл structure/validator.json → конфиг
   * плагина → дефолт forceModelCheck: true (решение D1). Функция не бросает:
   * битый файл валидатор уже читает как дефолт, а недоступный корень не имеет
   * права сломать apply.
   */
  const validatorSettingsFor = (root) => {
    try {
      return loadValidatorSettings(root, runtime.structureDir);
    } catch {
      return { forceModelCheck: true, allowUnknownModel: [] };
    }
  };
  const forceModelCheckFor = (root) => {
    const settings = validatorSettingsFor(root);
    let hasFile = false;
    try {
      hasFile = fs.existsSync(validatorSettingsPath(root, runtime.structureDir));
    } catch {
      hasFile = false;
    }
    if (hasFile) return { forceModelCheck: settings.forceModelCheck, allowUnknownModel: settings.allowUnknownModel };
    const fromConfig = typeof config.forceModelCheck === 'boolean' ? config.forceModelCheck : settings.forceModelCheck;
    return { forceModelCheck: fromConfig, allowUnknownModel: settings.allowUnknownModel };
  };
  /*
   * Листенер структуры (0167, решение D3): изменение structure/*.json
   * пересчитывает отчёт без участия координатора, а панель получает тот же
   * ответ по запросу. Ошибки слежения логируются и не валят плагин; при
   * dispose все листенеры останавливаются. Настройки читаются здесь, при
   * apply: недопустимый файл даёт дефолт true, а не молчание.
   */
  const validationStops = [];
  try {
    const watchRoots = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
    const settingsRows = [];
    for (const root of watchRoots) {
      const settings = forceModelCheckFor(root);
      settingsRows.push({
        root,
        forceModelCheck: settings.forceModelCheck,
        allowUnknownModel: settings.allowUnknownModel.length,
      });
      try {
        validationStops.push(watchStructure(root, {
          structureDir: runtime.structureDir,
          onChange: (report) => {
            const findings = report && Array.isArray(report.findings) ? report.findings : [];
            const errors = findings.filter((item) => item && item.severity === 'error');
            if (errors.length === 0) return;
            const codes = [...new Set(errors.map((item) => item.code))];
            warn('структура изменилась: ' + errors.length + ' error-находок (' + codes.join(', ') + ')');
          },
        }));
      } catch (error) {
        warn('листенер структуры не поднят для ' + root + ': ' + (error && error.message ? error.message : String(error)));
      }
    }
    writeTelemetry({
      event: 'validator-watch',
      roots: settingsRows.length,
      watched: validationStops.length,
      settings: settingsRows,
    });
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        for (const stop of validationStops) {
          try { stop(); } catch { /* dispose не бросает */ }
        }
      });
    }
  } catch (error) {
    warn('листенер структуры не поднят: ' + (error && error.message ? error.message : String(error)));
  }
  /*
   * Headless session (0084). A schedule must run even when nobody holds the workspace
   * open (03:00, the human session closed). ctx.agents.create raises a session in that
   * folder; the scheduler uses it as the run's parent and closes it afterwards. The
   * hook is offered only when the host has it: without create the scheduler keeps its
   * honest "no live agent" message instead of inventing a run.
   */
  const headlessAvailable = (() => {
    try {
      const agents = resolveAgents(ctx);
      return Boolean(agents && typeof agents.create === 'function');
    } catch {
      return false;
    }
  })();
  const createHeadlessAgent = async (options) => {
    const agents = resolveAgents(ctx);
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('служба ctx.agents не умеет create');
    }
    const cwd = options && typeof options.cwd === 'string' && options.cwd ? options.cwd : undefined;
    return agents.create(cwd ? { cwd } : {});
  };
  /*
   * 0142: служебная сессия в корне узла, когда сессия вызывающего работает в
   * другом воркспейсе. Хост-контракт тот же, что у headless-сессии 0084:
   * ctx.agents.create({ cwd }) — доказано, что cwd созданной сессии принимается;
   * label и reason остаются контрактом инструмента и хосту не передаются.
   * Отсутствие службы или её сбой не бросаются в запуск молча: createSpawnTool
   * превращает их в честный отказ root-mismatch с причиной.
   */
  const createSpawnAgent = async (options) => {
    const agents = resolveAgents(ctx);
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('служба ctx.agents не умеет create');
    }
    const cwd = options && typeof options.cwd === 'string' && options.cwd ? options.cwd : undefined;
    return agents.create(cwd ? { cwd } : {});
  };
  /*
   * Дайджест входящих (0104). Тик планировщика — единственный таймер, который
   * доказанно работает в хосте, поэтому строка «требуют хода N» едет его битом.
   * Доставка — в СУЩЕСТВУЮЩУЮ сессию корня: контроллер сессий (mode 'queue'),
   * запасной путь — handle.sendMessage живой сессии. Спавна нет: дайджест не
   * повод поднимать двойника, а «некому» — не ошибка, новость останется до
   * следующего бита.
   *
   * Ошибка доставки — строка в журнале, а не остановка цикла и не повтор с
   * частотой тика: одна и та же причина пишется не чаще раза в 5 минут.
   */
  let digestBusy = false;
  const digestWarnAt = new Map();
  const digestTick = async () => {
    if (digestBusy) return;
    digestBusy = true;
    try {
      const roots = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
      for (const root of roots) {
        try {
          const result = await deliverExchangeDigest({
            runtime,
            root,
            send: (text) => sendDigestToSession({
              root,
              text,
              sessionsDir: sessionsDirOf(config, runtime),
              getSessionController: () => resolveService(ctx, 'sessionController') || null,
              getAgents: () => resolveAgents(ctx),
            }),
          });
          if (result && result.error) digestWarn(root, String(result.error));
          /* Отказ доставки — журнал; «некому» (no-session) — штатная тишина. */
          else if (result && result.reason === 'refused') {
            digestWarn(root, 'доставка не удалась: '
              + (Array.isArray(result.reasons) && result.reasons.length > 0
                ? result.reasons.join('; ')
                : 'причина не сообщена'));
          }
        } catch (error) {
          digestWarn(root, error && error.message ? error.message : String(error));
        }
      }
    } finally {
      digestBusy = false;
    }
  };
  /*
   * Повестка бита: проход обмена, затем дайджест по каждому корню. Один упавший
   * проход не отменяет другой — иначе вечер с тяжёлым ящиком молчал бы о заявках.
   */
  const beat = async () => {
    if (typeof exchangeTick === 'function') {
      try {
        await exchangeTick();
      } catch (error) {
        warn('обмен: проход в тике не удался: ' + (error && error.message ? error.message : String(error)));
      }
    }
    await digestTick();
  };
  try {
    const scheduler = createScheduler({
      runtime,
      config,
      getSubagents: () => (typeof runtime.getSubagents === 'function' ? runtime.getSubagents() : null),
      getPresets: () => (typeof runtime.getPresets === 'function' ? runtime.getPresets() : null),
      /* Live agents let the scheduler wake the addressee of a report. */
      getAgents: () => resolveAgents(ctx),
      /*
       * A scheduled node must be born in a session of its own workspace: the session
       * carries the folder the agent reads. An agent of another root is never borrowed;
       * the scheduler writes the reason (it names the workspace) into the run journal.
       */
      getParent: resolveParent,
      getParentReason: (root) => chooseParent(root).reason,
      ...(headlessAvailable ? { createAgent: createHeadlessAgent } : {}),
      /*
       * The exchange pass rides the scheduler's beat: this timer is proven to run in the
       * host, while a separate interval for the watcher may not survive activation.
       */
      onTick: () => beat(),
      logger: {
        warn(message) {
          try {
            if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message);
            else console.warn(message);
          } catch {
            /* a logger must not break the host */
          }
        },
      },
    });
    const disposeSchedule = config.schedule === false ? () => {} : scheduler.start();
    if (typeof ctx.effect === 'function') ctx.effect(() => disposeSchedule);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('scheduler was not started: ' + message);
      else console.warn('[dsh-project-graph] scheduler was not started: ' + message);
    } catch {
      /* keep loading the panel even if the scheduler cannot start */
    }
  }
  /*
   * The exchange box is listened to, not only read: a message written into
   * `coordination/threads` must wake the addressee's last active session, otherwise
   * an answer stays a file nobody opens. Off with `exchangeWatch: false`.
   */
  writeTelemetry({ event: 'apply', exchangeWatch: config.exchangeWatch, roots: runtime.allowedRoots().length });
  try {
    /*
     * 0150: профиль — третий источник решения о пробуждении. Читается один раз и
     * передаётся наблюдателю; то же решение пишется в constructed-журнал, потому что
     * при exchangeWatch: false свой start() не вызывается, а видимость нужна и там.
     */
    const profileText = wakeProfileText();
    const wakeDecision = resolveWakeSpawn({
      config,
      env: typeof process !== 'undefined' && process.env ? process.env : {},
      profileText,
    });
    const watcher = createExchangeWatcher({
      runtime,
      config,
      profileText,
      getAgents: () => resolveAgents(ctx),
      getSubagents: () => (typeof runtime.getSubagents === 'function' ? runtime.getSubagents() : null),
      /*
       * DSH's first-party session bridge: resolve a session (resuming it when cold) and
       * admit a prompt into it. Same API the GUI uses; no third-party plugin.
       */
      getSessionController: () => resolveService(ctx, 'sessionController') || null,
      getParent: resolveParent,
      logger: {
        warn(message) {
          try {
            if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message);
            else console.warn(message);
          } catch {
            /* a logger must not break the host */
          }
        },
      },
    });
    /*
     * What the profile brake means now.
     *
     * `exchangeWatch: false` was written into ~/.dsh/profiles/desktop/cordis.patch.yml as
     * an emergency stop while the wake loop was broken (every delivered letter started an
     * answer, the answer started the next wake). That loop is closed in code: delivered
     * memory survives restarts, acks never wake, one reader per workspace, a 90 s cooldown,
     * and a wake resumes the addressee's own session instead of creating a twin. So the
     * old flag now means only "no fast 4 s timer"; delivery rides the scheduler's beat,
     * which is the mechanism proven to run in this host.
     *
     * A hard stop is explicit and cannot be confused with the stale flag:
     * set PG_EXCHANGE_WATCH=0 in the environment.
     */
    const hardStop = typeof process !== 'undefined' && process.env
      && String(process.env.PG_EXCHANGE_WATCH || '').trim() === '0';
    const watchEnabled = !hardStop;
    exchangeTick = watchEnabled ? () => watcher.tick() : null;
    /*
     * 0210 п.3: старт сессии — повод обойти ящик и вручить письма, а не только
     * тик таймера. DSH сообщает о событиях сессии через `session/event`; первый
     * ход (`turn/start`) и есть старт. Подписка необязательна: хост без неё
     * работает как раньше, а повторные события одного старта гасятся окном
     * SESSION_SCAN_MIN_MS, чтобы работа агента не устраивала шторм сканов.
     * Сам watcher.start() тоже делает проход сразу — активация плагина
     * сканирует и доставляет, не дожидаясь первого тика.
     */
    const SESSION_SCAN_EVENTS = new Set(['turn/start', 'session/created', 'session/start']);
    const SESSION_SCAN_MIN_MS = 2000;
    let lastSessionScanAt = 0;
    const onSessionEvent = (session, event) => {
      try {
        const type = event && typeof event === 'object' ? String(event.type || '') : '';
        /*
         * 0314: ответ доставлен — «прочитано» ставится после хода адресата.
         * turn/end НЕ запускает скан обмена: он только закрывает письма,
         * вручённые этой сессии (sha256 в exchange-seen.json). Ошибка отметки не
         * ломает событие и не мешает другим обработчикам — она уходит в telemetry.
         */
        if (type === 'turn/end') {
          try {
            const rawId = session && typeof session === 'object'
              ? session.id
              : (typeof session === 'string' ? session : (event && typeof event === 'object' ? event.sessionId : ''));
            const sessionId = String(rawId == null ? '' : rawId).trim();
            if (sessionId && typeof watcher.markProcessed === 'function') {
              const marked = watcher.markProcessed(sessionId);
              writeTelemetry({
                event: 'exchange-read',
                session: sessionId,
                marked: Number(marked && marked.marked) || 0,
                written: Boolean(marked && marked.written),
              });
            }
          } catch (error) {
            writeTelemetry({
              event: 'exchange-read-error',
              message: error && error.message ? String(error.message) : String(error),
            });
          }
          return;
        }
        if (!SESSION_SCAN_EVENTS.has(type)) return;
        /*
         * 0294: старт хода — момент, когда сессия реально существует. Presence
         * объявляется здесь, а не только в apply: на старте DSH агентов ещё нет
         * и env пуст. Сбой записи не имеет права помешать скану обмена.
         */
        try {
          const roots = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
          const sessionCacheDir = sessionCacheDirOf();
          const facts = presenceSessionFacts(session, sessionCacheDir);
          const ownRoot = ownWorkspaceRoot(roots, facts.cwd);
          let graph = { folders: [] };
          if (ownRoot) {
            try {
              const payload = readGraph(runtime, ownRoot);
              graph = payload && payload.graph ? payload.graph : { folders: [] };
            } catch {
              graph = { folders: [] };
            }
          }
          const announced = presenceOnSessionEvent({
            type,
            session,
            sessionCacheDir,
            root: ownRoot,
            roots,
            graph,
            participants: runtime.participants,
            me: runtime.me,
          });
          if (announced) {
            writeTelemetry({
              event: 'presence',
              source: 'session-event',
              type,
              root: ownRoot,
              sessionId: facts.id,
              written: announced.written.length,
              boxes: announced.written,
              skipped: announced.skipped,
            });
          }
        } catch (error) {
          writeTelemetry({
            event: 'presence-skip',
            source: 'session-event',
            type,
            message: error && error.message ? String(error.message) : String(error),
          });
        }
        if (!exchangeTick) return;
        const stamp = Date.now();
        if (stamp - lastSessionScanAt < SESSION_SCAN_MIN_MS) return;
        lastSessionScanAt = stamp;
        writeTelemetry({ event: 'session-start', type });
        Promise.resolve(exchangeTick()).catch((error) => {
          const message = error && error.message ? error.message : String(error);
          writeTelemetry({ event: 'session-scan-error', type, message });
          try {
            if (ctx.logger && typeof ctx.logger.warn === 'function') {
              ctx.logger.warn('обмен: скан по старту сессии не удался: ' + message);
            }
          } catch {
            /* a logger must not break the host */
          }
        });
      } catch {
        /* the start hook must never break session start */
      }
    };
    try {
      if (typeof ctx.on === 'function') ctx.on('session/event', onSessionEvent);
    } catch (error) {
      writeTelemetry({
        event: 'session-hook-error',
        message: error && error.message ? error.message : String(error),
      });
    }
    const fastTimer = config.exchangeWatch !== false;
    writeTelemetry({
      event: 'constructed',
      wakeSpawn: wakeDecision.enabled,
      wakeSource: wakeDecision.source,
      ownTimer: watchEnabled && fastTimer,
      beat: watchEnabled,
      profileBrake: config.exchangeWatch === false,
    });
    /*
     * 0210 rework B2: heartbeat обязан жить, пока плагин активен, даже когда
     * exchangeWatch:false снял быстрый таймер. В этом режиме запускается
     * heartbeat-only таймер 60 с (без скана и доставки): такт планировщика может
     * опоздать или зависнуть, а панель не должна видеть мёртвый сторож.
     * PG_EXCHANGE_WATCH=0 остаётся полным стопом и heartbeat не пишет.
     */
    let disposeWatch = () => {};
    if (watchEnabled) {
      disposeWatch = fastTimer ? watcher.start() : watcher.startHeartbeat();
    }
    writeTelemetry({
      event: 'started',
      disposer: typeof disposeWatch,
      beat: watchEnabled,
      ownTimer: watchEnabled && fastTimer,
      heartbeatOnly: watchEnabled && !fastTimer,
    });
    if (typeof ctx.effect === 'function') ctx.effect(() => disposeWatch);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    writeTelemetry({ event: 'apply-error', message, stack: String(error && error.stack || '').split('\n').slice(0, 4) });
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('exchange watcher was not started: ' + message);
      else console.warn('[dsh-project-graph] exchange watcher was not started: ' + message);
    } catch {
      /* the panel still works without the watcher */
    }
  }
  /*
   * Сторож сессий (0309): наблюдение, а не запрет.
   *
   * Структура должна в итоге видеть КАЖДУЮ новую сессию. Прежде чем вводить
   * жёсткий контроль, нужен честный журнал: какие сессии появились, какие
   * привязаны к узлу, какие работают без узла («тени») и когда завершились.
   * Журнал лежит в хранилище профиля и ничего не меняет в проекте.
   *
   * Сбой создания или старта — предупреждение и telemetry, а не падение плагина:
   * панель и обмен обязаны работать и без сторожа. Сам сторож ничего не бросает
   * наружу — его ошибки живут в результате тика.
   */
  try {
    const sessionWatchHardStop = typeof process !== 'undefined' && process.env
      && String(process.env.PG_SESSION_WATCH || '').trim() === '0';
    const sessionWatchEnabled = config.sessionWatch !== false && !sessionWatchHardStop;
    const sessionWatcher = createSessionWatcher({
      runtime,
      config,
      getAgents: () => resolveAgents(ctx),
    });
    const sessionWatchRoots = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
    writeTelemetry({
      event: 'session-watch',
      enabled: sessionWatchEnabled,
      intervalMs: sessionWatcher.intervalMs,
      roots: Array.isArray(sessionWatchRoots) ? sessionWatchRoots.length : 0,
    });
    const disposeSessionWatch = sessionWatchEnabled ? sessionWatcher.start() : () => {};
    if (typeof ctx.effect === 'function') ctx.effect(() => disposeSessionWatch);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    writeTelemetry({ event: 'session-watch-error', message });
    warn('сторож сессий не поднят: ' + message);
  }
  ctx.inject(['webServer'], (webCtx) => registerGraphWeb(webCtx, runtime));
  /*
   * Политика альтернативного пути: нативный `subagent`/`subagent_fork` в проекте
   * с объявленной структурой не блокируется, но модель получает предупреждение с
   * перечнем узлов и рецептом `project_graph_spawn`, а событие уходит в журнал
   * хранилища. Хост без `tools/post-execute` подписку не получает и работает как
   * раньше; любой сбой политики логируется и не мешает загрузке плагина.
   */
  try {
    registerStructurePolicy(ctx, runtime);
    /*
     * 0101: health.json в сторе — доказательство того, что структура включена:
     * режим enforcement.structurePolicy и состоявшаяся подписка на
     * tools/pre-execute (без неё fail не удерживается). Пишется при apply;
     * смена режима дописывается из pre-execute. Ошибка записи не роняет плагин.
     */
    const healthRoots = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
    for (const root of healthRoots) {
      recordPolicyHealth({ root, runtime, force: true });
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('structure policy was not registered: ' + message);
      else console.warn('[dsh-project-graph] structure policy was not registered: ' + message);
    } catch {
      /* панель работает и без политики */
    }
  }
  /*
   * Гейт обязанностей (0076): перед запуском узла и перед git commit/push через
   * pwsh считаются нарушенные обязанности структуры. По выбору заказчика режим
   * warn: вызов проходит, а модель получает контекст с обязанностью и числом
   * непрочитанных; deny — только для обязанности с enforce = fail. События
   * пишутся в хранилище (gate.jsonl), в репозиторий ничего не попадает. Хост без
   * tools/pre-execute подписку не получает и работает как раньше.
   */
  try {
    registerObligationGate(ctx, runtime);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('obligations gate was not registered: ' + message);
      else console.warn('[dsh-project-graph] obligations gate was not registered: ' + message);
    } catch {
      /* панель работает и без гейта */
    }
  }
  ctx.inject(['tools', 'subagents'], (toolCtx) => {
    const subagents = toolCtx.subagents;
    runtime.getSubagents = () => subagents;
    try {
      registerSpawnTool(toolCtx, runtime, config, {
        getKnownProviders: knownProvidersOf,
        /* 0138: проба фактического cwd ребёнка — кэш сессий хоста. */
        probeCwd: probeCwdOf(),
        /* 0142: создание служебной сессии в корне узла — ctx.agents.create. */
        createAgent: createSpawnAgent,
        /*
         * 0161: валидатор структуры — предусловие запуска. Error-находки
         * блокируют запуск (structure-invalid с кодами), warning не блокируют.
         * Принудительная проверка моделей — настройка forceModelCheck (решение
         * D2), по умолчанию выключена; список провайдеров — тот же, что у
         * плана (0139). Служба llm недоступна — knownProviders неизвестен, и
         * проверка моделей не выдумывается.
         */
        validateStructure: async (graph) => {
          /*
           * 0167: сила проверки — из проекта (файл → конфиг → дефолт true).
           * Хук spawn получает только граф (контракт 0163), поэтому корень
           * берётся defaultRoot: при одном корне это и есть проект вызова.
           */
          const settings = runtime.defaultRoot
            ? forceModelCheckFor(runtime.defaultRoot)
            : {
              forceModelCheck: typeof config.forceModelCheck === 'boolean' ? config.forceModelCheck : true,
              allowUnknownModel: [],
            };
          return validateStructure(graph, {
            forceModelCheck: settings.forceModelCheck,
            allowUnknownModel: settings.allowUnknownModel,
            knownProviders: await knownProvidersOf(),
          });
        },
      });
      registerRunTool(toolCtx, runtime, config);
      registerBranchTool(toolCtx, runtime, config);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (toolCtx.logger && typeof toolCtx.logger.warn === 'function') {
        toolCtx.logger.warn('project_graph_spawn was not registered: ' + message);
      } else {
        console.warn('[dsh-project-graph] project_graph_spawn was not registered: ' + message);
      }
    }
  });
}