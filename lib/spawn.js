/**
 * MVP-1: spawning one agent per structure node.
 *
 * The panel only edits structure files; this module is the only place where the
 * plugin acts. A model calls `project_graph_spawn`, and the node it names
 * decides the route: `nodes[].model` -> `models[alias]` -> provider/model.
 * The model never chooses a model itself, so the declaration reviewed in git is
 * the whole authority.
 *
 * Nothing here talks to DSH directly: the tool is a plain definition over
 * `ctx.tools.register`, and the subagent service is injected. That keeps the
 * resolver and the refusals testable without a harness.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readGraph, writeFileAtomic } from './api.js';
import { bareName, declaredReviewer, expectedAcceptor, parseTaskMeta, validateTaskFile } from './contract.js';
/* 0177/0186: схема audit.json, её проверка и сверка якорей вердикта с входом аудитора. */
import { validateAudit, validateAnchorClaims } from './audit.js';
/* 0186: якоря — утверждение (sha256/covers) и привязка к узлам структуры. */
import { anchorsDeclared, consumesOf, structureAnchorBindings, validateApproval, validateBinding } from './anchors.js';
/* 0186: anchors объявлены во фрагментах структуры, а собранный граф их не хранит. */
import { readStructure } from './load.js';
/* 0138: фактический cwd сессии — тот же источник факта, что у обмена (кэш сессий хоста). */
import { readSessionCwd } from './exchange-watch.js';
import { CONCURRENCY_MODES } from './graph.js';
import { appendLaunch, launchDir, listRuns, localIso, newRunId, noteRun, storeDir } from './runs.js';
/* 0197: гейт активации по незакрытому результату на report-ребре. */
import { validateActivation } from './edge-obligations.js';
/* 0198: квитанция ревьюера — гейт приёмки требует её, движок пишет её на завершении. */
import { validateReviewReceipt, writeReviewReceipt } from './review-receipts.js';

export const SPAWN_TOOL_NAME = 'project_graph_spawn';
export const DEFAULT_PROVIDER = 'spawn';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function samePath(left, right) {
  const a = path.resolve(String(left)).replace(/[\\/]+$/u, '');
  const b = path.resolve(String(right)).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Один и тот же каталог, даже если записан по-разному (0138).
 *
 * Каталог ребёнка приходит от хоста, а корень узла — из конфига: на Windows одна
 * и та же папка бывает длинной и короткой (8.3), на любой системе — через
 * ссылку. Сравнение строк объявило бы такой запуск чужим и отказало бы верному
 * запуску, поэтому расхождение строк проверяется ещё и по настоящим путям.
 */
function sameRealPath(left, right) {
  if (samePath(left, right)) return true;
  try {
    return samePath(fs.realpathSync(String(left)), fs.realpathSync(String(right)));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- *
 * 0179: запись запуска называет предмет — задачу, её название и отчёт.
 *
 * Факт координатора: judge 08.11 17:45:45 → 17:46:11 done, а в записи только
 * childId — по ней нельзя сказать, что принято и по какому отчёту. Поэтому
 * запись узла с заданием несёт task (id из TASK-META), object (название) и
 * report (путь отчёта), а у приёмщика ещё verdict ok|issues из acceptance.json.
 * Поля берутся из контракта и артефактов, а не из памяти агента.
 * ------------------------------------------------------------------------- */

/** Относительный путь с прямыми слэшами: записи читают и на Windows. */
function relativeRecordPath(root, absolute) {
  const rel = path.relative(path.resolve(String(root)), path.resolve(String(absolute)));
  return rel.split(path.sep).join('/');
}

/**
 * Каталог задания и файл task.md по аргументу task (файл, каталог или id).
 *
 * Путь может не существовать: факты — наблюдение, а не условие запуска, поэтому
 * ненайденный путь читается как файл, а каталог берётся его родителем.
 */
function taskLocation(root, taskRel) {
  const raw = text(taskRel);
  if (!raw) return null;
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(String(root), raw);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return { dir: resolved, file: path.join(resolved, 'task.md') };
    }
  } catch {
    /* файла нет — ниже он читается как файл, отказ уже состоялся бы раньше */
  }
  return { dir: path.dirname(resolved), file: resolved };
}

/** JSON-объект из файла; отсутствующий или битый файл — ничего. */
function readJsonObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Вердикт приёмки: accepted → ok, rejected/отклонено → issues, иначе нет. */
function acceptanceVerdict(acceptance) {
  const status = text(acceptance && acceptance.status).toLowerCase();
  if (!status) return undefined;
  if (status === 'accepted') return 'ok';
  if (status === 'rejected' || status === 'отклонено') return 'issues';
  return undefined;
}

/**
 * Факты задания для записи запуска (инвариант 1 задания 0179).
 *
 * task — id из TASK-META (каталог задания — запасной источник, если meta нет),
 * object — title оттуда же, report — путь отчёта. У приёмщика предмет записи —
 * сам акт приёмки: report указывает на acceptance.json, а verdict называет его
 * исход (ok|issues), когда файл уже есть. Путь отчёта исполнителя называется
 * всегда: запись обязана говорить, какой отчёт читать, даже если он ещё не
 * написан на момент старта.
 *
 * @param root - корень проекта.
 * @param taskRel - контракт задания: путь к task.md, каталог задания или id.
 * @param options - { acceptor: true } у узла-приёмщика этого задания.
 * @returns {{ task: string, object: string, report: string, verdict?: 'ok'|'issues' }}
 */
export function taskRecordFacts(root, taskRel, options = {}) {
  const rootPath = path.resolve(String(root));
  const located = taskLocation(rootPath, taskRel);
  if (!located) return { task: '', object: '', report: '' };
  let meta = null;
  try {
    meta = parseTaskMeta(fs.readFileSync(located.file, 'utf8'));
  } catch {
    meta = null;
  }
  const acceptanceFile = path.join(located.dir, 'acceptance.json');
  const acceptance = readJsonObject(acceptanceFile);
  const verdict = acceptanceVerdict(acceptance);
  const acceptor = Boolean(options && options.acceptor === true);
  const reportFile = acceptor ? acceptanceFile : path.join(located.dir, 'report.worker.json');
  return {
    task: text(meta && meta.id) || path.basename(located.dir),
    object: text(meta && meta.title) || text(meta && meta.object),
    report: relativeRecordPath(rootPath, reportFile),
    ...(verdict ? { verdict } : {}),
  };
}

/** Слова роли приёмщика: запасной признак, если структура не назвала приёмщика. */
const ACCEPTOR_ROLE = /приёмщик|приемщик|судья|judge|acceptor/iu;

/**
 * Узел — приёмщик этого задания?
 *
 * Структура решает первой: acceptorNode/acceptor из TASK-META, затем ожидаемый
 * приёмщик по связям графа (expectedAcceptor). Роль узла — только запасной
 * признак, когда структура не назначает приёмщика вовсе: иначе «судья» в схеме
 * выглядел бы приёмщиком чужой задачи.
 */
function taskAcceptorNode(graph, meta, node) {
  const id = text(node);
  if (!id) return false;
  if (text(meta && meta.acceptorNode) === id) return true;
  if (bareName(meta && meta.acceptor) === id) return true;
  const executor = bareName(meta && meta.executor);
  if (executor) {
    let expected = null;
    try {
      expected = expectedAcceptor(graph, executor);
    } catch {
      expected = null;
    }
    if (expected && expected.ok) return expected.acceptor === id;
    /* Структура не назначает приёмщика — роль узла её не подменяет. */
    if (expected && !expected.ok) return false;
  }
  const declared = (graph && Array.isArray(graph.nodes) ? graph.nodes : [])
    .find((item) => item && item.id === id);
  const role = declared && declared.role !== undefined && declared.role !== null ? String(declared.role) : '';
  return ACCEPTOR_ROLE.test(role);
}

/**
 * Поля записи запуска узла с заданием (0179): task/object/report, у приёмщика
 * ещё verdict. Пустые значения в запись не попадают. Без задания — пусто.
 */
function taskRunFields(root, graph, meta, taskFile, node) {
  if (!taskFile) return null;
  const acceptor = taskAcceptorNode(graph, meta, node);
  const facts = taskRecordFacts(root, taskFile, { acceptor });
  const fields = {};
  if (facts.task) fields.task = facts.task;
  if (facts.object) fields.object = facts.object;
  if (facts.report) fields.report = facts.report;
  if (facts.verdict) fields.verdict = facts.verdict;
  return fields;
}

/** Поля started-записи: task из фактов (id), иначе — прежнее значение-аргумент. */
function launchTaskFields(taskFields, taskArg) {
  return taskFields ? { ...taskFields } : { task: taskArg };
}

/**
 * Где ребёнок работает на самом деле (0138).
 *
 * Проба — внешний факт, а не наш запрос: хост кладёт рабочий каталог сессии в
 * свой кэш, и только он говорит, куда сессия легла. Живой случай ws-school-app
 * --05: project_graph_spawn({ root }) вернул childId, а сессия легла в
 * воркспейс родителя.
 *
 * Отсутствие значения, пустая строка или исключение пробы — это «неизвестно», а
 * не «чужой воркспейс»: отказ по догадке запрещён (решение D1 задания). Проба
 * спрашивается один раз: повторять её — дело того, кто передал probeCwd, если
 * его источник пишется с задержкой.
 *
 * @returns {Promise<{ known: boolean, cwd?: string }>}
 */
async function probeChildCwd(probe, childId) {
  if (typeof probe !== 'function') return { known: false };
  const id = childId === undefined || childId === null ? '' : String(childId).trim();
  if (!id) return { known: false };
  let value;
  try {
    value = await probe(id);
  } catch {
    return { known: false };
  }
  const cwd = typeof value === 'string' ? value.trim() : '';
  return cwd ? { known: true, cwd } : { known: false };
}

/**
 * Поля записи прогона о каталоге (0138): что попросили и где ребёнок на самом
 * деле. cwdMismatch вычисляется, а не предполагается; при неизвестном cwd его
 * нет — «не знаем» не равно «совпало».
 */
function cwdFacts(root, childCwd) {
  const asked = path.resolve(String(root));
  if (!childCwd || !childCwd.known) return { cwd: asked, cwdSource: 'unknown' };
  return {
    cwd: asked,
    agentCwd: childCwd.cwd,
    cwdSource: 'session',
    cwdMismatch: !sameRealPath(childCwd.cwd, asked),
  };
}

/**
 * Факт о служебной сессии, созданной нами в корне узла (0142).
 *
 * Здесь cwd не наблюдение, а наше решение: сессия создана с явным cwd, и ребёнок
 * наследует её воркспейс. cwdSource:'created' называет источник факта (создание
 * сессии), sessionSource:'created' отличает такой запуск от обычного, где
 * родителем осталась сессия вызывающего.
 */
function createdSessionFacts(root) {
  return { cwd: path.resolve(String(root)), cwdSource: 'created', sessionSource: 'created' };
}

/**
 * Ответ службы создания сессий бывает разной формы (0151).
 *
 * Хост возвращает запись сессии, а не агента: в живом случае ws-school-app id
 * лежал не в поле id, и запуск падал «agent id "undefined" does not match
 * session id "session-1"». Какое поле заполнил хост, плагин не выбирает, поэтому
 * id берётся из любого штатного: id → sessionId → session.id → agentId.
 * cwd — из ответа, иначе из запроса: cwd мы попросили явно (0142), это наше
 * решение, а не догадка о чужой сессии.
 *
 * Пустой ответ — не «успех с дырой»: id не выдумывается, и отказ называет
 * причину. Ответ без собственного id получает нормализованный id, остальные
 * поля (sessionId, dispose, …) остаются такими, какими их вернул хост.
 */
function normalizeCreatedSession(value, requestedCwd) {
  if (!isPlainObject(value)) return { id: '', cwd: '', agent: value };
  const session = isPlainObject(value.session) ? value.session : null;
  const id = text(value.id) || text(value.sessionId) || (session ? text(session.id) : '') || text(value.agentId);
  const cwd = text(value.cwd) || text(requestedCwd);
  let agent = value;
  if (id && text(value.id) !== id) {
    try {
      Object.defineProperty(value, 'id', { value: id, enumerable: true, configurable: true, writable: true });
    } catch {
      /* замороженный ответ хоста: родителю отдаём копию с id */
      agent = { ...value, id };
    }
  }
  return { id, cwd, agent };
}

/** A refusal with a stable code: the model sees the code, tests assert it. */
/**
 * Глубина по умолчанию: структуре «координатор → воркер» нужна 2, а если сама
 * сессия-владелец запущена доставкой/панелью — воркер уже на глубине 2. Хозяйский
 * потолок по умолчанию в другом DSH был 1 и отклонял такой запуск
 * («subagent depth 2 exceeds maxDepth 1»). Профиль может переопределить.
 */
export const DEFAULT_MAX_DEPTH = 3;

export function spawnError(code, message) {
  const error = new Error(SPAWN_TOOL_NAME + ': ' + code + ': ' + message);
  error.code = code;
  return error;
}

/**
 * Родитель активации (0142): сессия вызывающего или служебная сессия в корне.
 *
 * Хост создаёт ребёнка с cwd родителя (доказано 0138), поэтому чужой воркспейс
 * нельзя исправить одним лишь request.cwd: cwd приходит от сессии. Если cwd
 * родителя известен и не равен корню узла, в корне создаётся служебная сессия
 * (createAgent) и родителем становится она. Нет createAgent или создание упало —
 * отказ root-mismatch: молча запустить ребёнка в чужом воркспейсе нельзя.
 * Неизвестный cwd — прежнее поведение 0138: доказывать нечего, а отказ по
 * догадке запрещён (D1), поэтому родитель остаётся прежним.
 *
 * Созданная сессия узнаётся по ответу службы: id берётся из любого штатного
 * поля (0151), cwd сверяется с корнем; сессия в чужой папке родителем не станет
 * и будет остановлена.
 *
 * @returns {Promise<{ ok: true, parent, sessionSource: 'parent'|'created' }
 *   | { ok: false, error }>}
 */
async function resolveActivationParent({ probe, parent, root, createAgent, label, node }) {
  const rootPath = path.resolve(String(root));
  const parentCwd = await probeChildCwd(probe, parent && parent.id);
  if (!parentCwd.known || sameRealPath(parentCwd.cwd, rootPath)) {
    return { ok: true, parent, sessionSource: 'parent' };
  }
  const refusal = (tail) => spawnError('root-mismatch',
    'сессия родителя открыта в другом воркспейсе: ' + parentCwd.cwd
      + ', а узел «' + node + '» объявлен в ' + rootPath + '. ' + tail);
  if (typeof createAgent !== 'function') {
    return {
      ok: false,
      error: refusal('Служебную сессию в корне узла создать нечем (ctx.agents.create недоступен): '
        + 'запуск не принят, иначе ребёнок читал бы и писал файлы чужого проекта, а не узла'),
    };
  }
  let created;
  try {
    created = await createAgent({
      cwd: rootPath,
      label,
      reason: 'сессия родителя работает в ' + parentCwd.cwd + ', а узел «' + node + '» объявлен в ' + rootPath,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return {
      ok: false,
      error: refusal('Создать служебную сессию в корне узла не удалось: ' + message
        + '. Запуск не принят, иначе ребёнок читал бы и писал файлы чужого проекта, а не узла'),
    };
  }
  const createdSession = normalizeCreatedSession(created, rootPath);
  if (!createdSession.id) {
    return {
      ok: false,
      error: refusal('Служба создания сессий не вернула сессию: запуск не принят, '
        + 'иначе ребёнок читал бы и писал файлы чужого проекта, а не узла. '
        + 'Проверьте службу создания сессий (ctx.agents.create): она обязана вернуть сессию '
        + 'с id в поле id, sessionId, session.id или agentId'),
    };
  }
  if (!sameRealPath(createdSession.cwd, rootPath)) {
    try {
      const stopping = created && typeof created.dispose === 'function' ? created.dispose() : null;
      if (stopping && typeof stopping.catch === 'function') stopping.catch(() => {});
    } catch {
      /* сессия могла ещё не подняться — отказ уже состоялся */
    }
    return {
      ok: false,
      error: spawnError('root-mismatch',
        'служебная сессия создана в другом воркспейсе: ' + createdSession.cwd
          + ', а узел «' + node + '» объявлен в ' + rootPath
          + '. Запуск не принят: ребёнок читал бы и писал файлы чужого проекта, а не узла'),
    };
  }
  return { ok: true, parent: createdSession.agent, sessionSource: 'created' };
}

/**
 * Normalize a catalog into the shape the plan checks. A catalog that is not an
 * object with a providers list is not a catalog: the plan then works as before.
 */
function normalizeCatalog(catalog) {
  if (!isPlainObject(catalog) || !Array.isArray(catalog.providers)) return null;
  const providers = [];
  for (const row of catalog.providers) {
    if (!isPlainObject(row)) continue;
    const id = text(row.id) || text(row.name);
    if (!id) continue;
    const models = [];
    for (const item of Array.isArray(row.models) ? row.models : []) {
      const rawId = typeof item === 'string' ? text(item) : text(isPlainObject(item) ? item.id : '') || text(isPlainObject(item) ? item.name : '');
      if (!rawId) continue;
      const family = isPlainObject(item) ? text(item.family) : '';
      models.push({ id: rawId, name: isPlainObject(item) ? text(item.name) || rawId : rawId, ...(family ? { family } : {}) });
    }
    providers.push({ id, name: text(row.name) || id, models });
  }
  return { providers };
}

/** Ids of catalog rows for a refusal message; a dash when the list is empty. */
function catalogIds(rows) {
  const ids = rows.map((row) => row && row.id).filter(Boolean);
  return ids.length > 0 ? ids.join(', ') : '—';
}

/**
 * Known providers of the host runtime as a clean list of names (0139).
 *
 * The catalog proves a route, but it can be unreadable while the runtime still
 * knows which providers it can start. A node provider outside that list has no
 * adapter: the refusal must happen before the spawn, not as NO_ADAPTER inside
 * a live session. Anything that is not a non-empty array of names is "no list":
 * the plan then keeps the old behaviour instead of pretending to know the host.
 */
function normalizeKnownProviders(list) {
  if (!Array.isArray(list)) return null;
  const ids = [];
  for (const item of list) {
    const id = text(item);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

/** Levenshtein distance: the hint only needs "close by spelling", not a theory. */
function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * Nearest known provider by spelling, for the "did you mean" hint: opencode ->
 * opencode-go. '' when nothing is close enough — a wrong hint is worse than none.
 */
function nearestProvider(name, ids) {
  const lower = name.toLowerCase();
  let best = '';
  let bestDistance = Infinity;
  for (const id of ids) {
    const distance = editDistance(lower, id.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = id;
    }
  }
  if (!best) return '';
  const limit = Math.max(2, Math.ceil(Math.max(name.length, best.length) / 3));
  return bestDistance <= limit ? best : '';
}

/**
 * Resolve one node into a route without touching DSH.
 *
 * The route lives in the node: provider + model (+ family). A node of an old
 * graph keeps the alias in models{}: it is expanded only while the node has no
 * provider of its own, and the alias name is kept in modelAlias for the panel.
 *
 * @param graph - the merged, already validated structure.
 * @param nodeId - the node the model asked for.
 * @param options - { catalog, knownProviders } checks the route before a run.
 *   The catalog is checked first and stays the main proof: an unknown
 *   provider/model is a refusal with names, not a crash after the spawn. When
 *   the catalog cannot be read, a non-empty knownProviders list still lets the
 *   plan refuse a provider the runtime has no adapter for (0139), with the list
 *   and the nearest name as a hint. Neither source present keeps the old
 *   behaviour (provider+model in the declaration is enough).
 * @returns { ok, node, role, provider, model, family, modelAlias, preset }
 *   or { ok: false, code, message }.
 */
export function resolveNodePlan(graph, nodeId, options = {}) {
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const models = isPlainObject(graph && graph.models) ? graph.models : {};
  const id = typeof nodeId === 'string' ? nodeId.trim() : '';
  if (!id) return { ok: false, code: 'unknown-node', message: 'не указан узел структуры' };
  const node = nodes.find((item) => item && item.id === id);
  if (!node) {
    return {
      ok: false,
      code: 'unknown-node',
      message: 'узла «' + id + '» нет в структуре проекта: проверьте id или добавьте узел в structure/*.json',
    };
  }
  const declaredProvider = text(node.provider);
  const declaredModel = text(node.model);
  if (!declaredModel) {
    return {
      ok: false,
      code: 'node-without-model',
      message: 'у узла «' + id + '» не задана модель: укажите provider и model прямо в узле, иначе порождать агента не на чем',
    };
  }
  let provider = declaredProvider;
  let model = '';
  let family = text(node.family);
  let modelAlias = text(node.modelAlias) || null;
  /*
   * Прямой маршрут: provider+model узла. Алиас читается только тогда, когда
   * provider не задан, — иначе старый models{} перетёр бы прямое объявление.
   * modelAlias из миграции графа остаётся в ответе для совместимости панели.
   */
  if (declaredProvider) {
    model = declaredModel;
  } else {
    const aliasEntry = Object.hasOwn(models, declaredModel) ? models[declaredModel] : null;
    if (!isPlainObject(aliasEntry) || !text(aliasEntry.provider) || !text(aliasEntry.model)) {
      return {
        ok: false,
        code: 'node-without-model',
        message: 'у узла «' + id + '» model «' + declaredModel + '» задан без provider, и алиаса '
          + '«' + declaredModel + '» нет в models: укажите provider и model прямо в узле',
      };
    }
    modelAlias = modelAlias || declaredModel;
    provider = text(aliasEntry.provider);
    model = text(aliasEntry.model);
    if (!family) family = text(aliasEntry.family);
  }
  if (!provider || !model) {
    return {
      ok: false,
      code: 'node-without-model',
      message: 'у узла «' + id + '» маршрут неполон: нужны provider и model',
    };
  }
  /*
   * Каталог службы llm — проверка ДО запуска: провайдер и модель называются в
   * отказе вместе со списком доступного. Без каталога вопрос не доказан, и
   * план по-прежнему строится по объявлению.
   */
  const catalog = normalizeCatalog(options && options.catalog);
  if (catalog) {
    const providerRow = catalog.providers.find((row) => row.id === provider || row.name === provider);
    if (!providerRow) {
      return {
        ok: false,
        code: 'provider-missing',
        message: 'провайдера «' + provider + '» нет в каталоге моделей службы llm; доступны: '
          + catalogIds(catalog.providers),
      };
    }
    const modelRow = providerRow.models.find((row) => row.id === model || row.name === model);
    if (!modelRow) {
      return {
        ok: false,
        code: 'model-missing',
        message: 'у провайдера «' + providerRow.id + '» нет модели «' + model + '»; в каталоге: '
          + catalogIds(providerRow.models),
      };
    }
    if (!family && modelRow.family) family = modelRow.family;
  } else {
    /*
     * 0139: каталога нет — но список провайдеров рантайма есть. Провайдер вне
     * списка не имеет адаптера: отказ до запуска, иначе узел родится и упадёт
     * NO_ADAPTER уже в сессии. Каталог, когда он прочитан, главнее и сюда не
     * пускает: его проверка выше уже сказала своё слово.
     */
    const known = normalizeKnownProviders(options && options.knownProviders);
    if (known && !known.includes(provider)) {
      const hint = nearestProvider(provider, known);
      return {
        ok: false,
        code: 'provider-missing',
        message: 'провайдера «' + provider + '» нет среди известных провайдеров DSH; доступны: '
          + known.join(', ')
          + (hint ? '. Возможно, имелся в виду «' + hint + '»' : '')
          + '. Проверьте provider узла «' + id + '»: без адаптера узел упадёт уже в сессии',
      };
    }
  }
  return {
    ok: true,
    node: node.id,
    role: node.role || null,
    /*
     * 0137: назначение и спека узла едут в плане. Промпт ребёнка собирается из
     * них тем же построителем, что и у run-ветки: запуск не перечитывает
     * структуру, а узел узнаёт роль и Definition of Done из своего объявления.
     */
    brief: text(node.brief) || null,
    spec: text(node.prompt) || null,
    modelAlias,
    provider,
    model,
    family: family || null,
    preset: node.agentPreset || null,
    /* 0136: дисциплина узла едет в плане — запуск не перечитывает структуру. */
    concurrency: concurrencyOf(node),
  };
}

/**
 * Read the llm catalog in the form the plan checks.
 *
 * A missing service, an exception or an asynchronous refusal answers undefined:
 * the route is then taken from the declaration alone, as before. A catalog that
 * is down must not block every run — it only cannot prove the route.
 */
async function readSpawnCatalog(runtime) {
  if (!runtime || typeof runtime.getLlm !== 'function') return undefined;
  let llm;
  try {
    llm = runtime.getLlm();
  } catch {
    return undefined;
  }
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return undefined;
  let providers;
  try {
    providers = await llm.listProviders();
  } catch {
    return undefined;
  }
  if (!Array.isArray(providers)) return undefined;
  const rows = [];
  for (const provider of providers) {
    if (!isPlainObject(provider)) continue;
    const id = text(provider.id) || text(provider.name);
    if (!id) continue;
    let models;
    try {
      models = await llm.listModels(id);
    } catch {
      return undefined;
    }
    const list = [];
    for (const item of Array.isArray(models) ? models : []) {
      const modelId = typeof item === 'string' ? text(item) : text(isPlainObject(item) ? item.id : '') || text(isPlainObject(item) ? item.name : '');
      if (!modelId) continue;
      const family = isPlainObject(item) ? text(item.family) : '';
      list.push({ id: modelId, name: isPlainObject(item) ? text(item.name) || modelId : modelId, ...(family ? { family } : {}) });
    }
    rows.push({ id, name: text(provider.name) || id, models: list });
  }
  return { providers: rows };
}

/**
 * Known providers from the tool option (0139).
 *
 * The getter wraps the runtime's own list and may answer synchronously or with
 * a promise, like the llm service it reads. A missing getter, an exception or
 * a non-list answers undefined: the plan then proves nothing about the runtime,
 * exactly as before — a guard that cannot answer must not invent refusals.
 */
async function readKnownProviders(getKnownProviders) {
  if (typeof getKnownProviders !== 'function') return undefined;
  let list;
  try {
    list = await getKnownProviders();
  } catch {
    return undefined;
  }
  return normalizeKnownProviders(list) || undefined;
}

/** Pick the project root: explicit, or the only allowed one. */
export function resolveRoot(runtime, requested) {
  const allowed = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
  if (allowed.length === 0) {
    return { ok: false, code: 'no-roots', message: 'не задан ни один корень проекта (roots в cordis.patch.yml)' };
  }
  const value = typeof requested === 'string' ? requested.trim() : '';
  if (!value) {
    if (allowed.length === 1) return { ok: true, root: allowed[0] };
    return {
      ok: false,
      code: 'root-required',
      message: 'корней несколько (' + allowed.length + '): укажите root явно',
    };
  }
  if (!path.isAbsolute(value)) {
    return { ok: false, code: 'root-not-allowed', message: 'корень должен быть абсолютным путём: ' + value };
  }
  const resolved = path.resolve(value);
  const match = allowed.find((root) => samePath(root, resolved));
  if (!match) return { ok: false, code: 'root-not-allowed', message: 'корень вне разрешённого списка: ' + resolved };
  return { ok: true, root: match };
}

/* ------------------------------------------------------------------------- *
 * 0136: дисциплина узла — refuse (по умолчанию), parallel: N, очередь стора.
 *
 * Считаются живые прогоны узла: записи стора в состоянии running. queued
 * занятости не создаёт — задача ещё не сессия. Проверка стоит перед стартом,
 * поэтому отказ и очередь не доходят до startActivation.
 * ------------------------------------------------------------------------- */

/** Режим занятости из объявления узла; битое/отсутствующее поле — refuse. */
function concurrencyOf(node) {
  const declared = isPlainObject(node && node.concurrency) ? node.concurrency : null;
  if (!declared) return { mode: 'refuse' };
  const mode = text(declared.mode);
  if (!CONCURRENCY_MODES.includes(mode)) return { mode: 'refuse' };
  if (mode === 'parallel') {
    const max = Number(declared.max);
    return { mode, max: Number.isInteger(max) && max >= 1 && max <= 4 ? max : 1 };
  }
  return { mode };
}

/**
 * Момент запуска — у каждого прогона свой.
 *
 * noteRun опознаёт прогон по паре узел+since и перезаписывает запись с тем же
 * ключом. Два запуска в одну миллисекунду слились бы в один, и лимит parallel
 * посчитал бы их одним прогоном. Поэтому since строго возрастает в процессе.
 */
let lastSince = 0;
function nextSince() {
  const now = Date.now();
  lastSince = now > lastSince ? now : lastSince + 1;
  return lastSince;
}

/**
 * 0198: доступен ли стор прогонов.
 *
 * listRuns молча отдаёт память, когда файл истории не читается: для панели это
 * приемлемо, для гейта — нет. Пустая история на недоступном сторе выглядит как
 * «прогонов не было», и незакрытый результат проходил бы. Поэтому недоступность
 * каталога проверяется отдельно и называется, а не толкуется в пользу запуска.
 *
 * @returns {Error|null} причина недоступности; null — стор читается или его ещё нет.
 */
function runsStoreProblem(runtime) {
  try {
    const dir = storeDir(runtime);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch (error) {
      /* Каталога ещё нет — это пустая история, а не отказ. */
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isDirectory()) return new Error('каталог прогонов занят не каталогом: ' + dir);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * 0197/0198: гейт активации узла.
 *
 * Незакрытый report-результат предыдущего планового прогона запрещает новый
 * запуск: узел обязан сначала доставить результат. Отказ называется
 * edge-obligation. Стор недоступен — доказать закрытость нельзя, а отказ по
 * догадке запрещён: гейт отказывает (fail-closed), а не пропускает. Ошибка
 * чтения названа в отказе и в журнале, но запуском не прикрыта.
 *
 * @returns {string[]} причины отказа; пустой список — активация разрешена.
 */
function edgeGateErrors(runtime, root, graph, node) {
  let runs;
  try {
    runs = listRuns(runtime, root);
    const storeProblem = runsStoreProblem(runtime);
    if (storeProblem) throw storeProblem;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.warn('[dsh-project-graph] edge-obligation: история прогонов недоступна — активация запрещена: ' + message);
    return ['edge-obligation: история прогонов недоступна — активация запрещена: ' + message];
  }
  const result = validateActivation(runs, graph, node);
  return result.ok ? [] : result.errors;
}

/** Живые прогоны узла: записи стора этого корня в состоянии running. */
function activeRuns(runtime, root, node) {
  let rows = [];
  try {
    rows = listRuns(runtime, root);
  } catch {
    /* Стор недоступен — доказать занятость нельзя, запуск не блокируем. */
    return [];
  }
  return rows.filter((row) => row && row.node === node
    && String(row.state || 'running').toLowerCase() === 'running');
}

/** Совет к отказу node-busy: очередь либо явная параллель (задание 0136). */
function busyMessage(node, mode, active, limit, via) {
  const head = 'узел «' + node + '» занят: активных прогонов ' + active
    + (mode === 'parallel'
      ? ', предел parallel: ' + limit
      : ', одновременно допустим один');
  const raise = Math.min(4, limit + 1);
  const advice = limit >= 4
    ? 'предел параллели уже 4 — это максимум; дождитесь завершения'
    : 'разрешите параллель: { "mode": "parallel", "max": ' + raise + ' } (1..4)';
  if (mode === 'queue') {
    return head + '. У узла режим "queue": в очередь ставит project_graph_spawn, '
      + 'а ожидающий project_graph_run очередь не ждёт. Дождитесь освобождения узла '
      + 'или ' + advice + '.';
  }
  if (via === 'run') {
    return head + '. Дождитесь завершения, поставьте задачу в очередь через project_graph_spawn '
      + '({ "mode": "queue" }) или ' + advice + '.';
  }
  return head + '. Дождитесь завершения либо объявите в структуре concurrency: '
    + '{ "mode": "queue" } — задача встанет в очередь, или ' + advice + '.';
}

/** Файл очереди узлов одного корня: <store>/runs/<hash>/queue.json (решение D2). */
export function queueFilePath(runtime, root) {
  return path.join(launchDir(runtime, root), 'queue.json');
}

/* Лок очереди: стор пишут координатор, субагент и панель в разных процессах.
   Без лока два одновременных queue-спавна теряли бы одну запись (последний
   перезаписывал файл). Ожидание короткое: очередь — часть ответа, а не повод
   держать вызов. */
const QUEUE_LOCK_WAIT_MS = 2000;
const QUEUE_LOCK_STALE_MS = 5000;

function pauseSync(ms) {
  const pause = Math.max(1, Math.floor(ms));
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
  } catch {
    const until = Date.now() + pause;
    while (Date.now() < until) { /* короткий спин вместо ожидания */ }
  }
}

/** Взять лок очереди; null — имя занято живым писателем дольше предела. */
function acquireQueueLock(file) {
  const lockPath = file + '.lock';
  /* Токен: отпускаем только свой лок — перехваченный по старости нам не принадлежит. */
  const token = String(process.pid) + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
  const deadline = Date.now() + QUEUE_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, token, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { path: lockPath, token };
    } catch (error) {
      if (!error || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }
    let abandoned = false;
    try {
      abandoned = Date.now() - fs.statSync(lockPath).mtimeMs > QUEUE_LOCK_STALE_MS;
    } catch {
      /* имя исчезло между попытками — повторяем */
    }
    if (abandoned) {
      try { fs.rmSync(lockPath, { force: true }); } catch { /* гонку выиграл другой */ }
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    pauseSync(Math.min(20, left));
  }
}

/** Отпустить только свой лок: чужой по возрасту уже мог быть перехвачен. */
function releaseQueueLock(lock) {
  if (!lock) return;
  try {
    if (fs.readFileSync(lock.path, 'utf8') !== lock.token) return;
  } catch {
    return;
  }
  try { fs.rmSync(lock.path, { force: true }); } catch { /* already gone */ }
}

/** Записи очереди; битый или отсутствующий файл — пустая очередь. */
function readQueue(runtime, root) {
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(queueFilePath(runtime, root), 'utf8'));
  } catch {
    return [];
  }
  return Array.isArray(rows) ? rows.filter((row) => isPlainObject(row)) : [];
}

/**
 * Положить задачу в очередь узла и вернуть её позицию.
 *
 * Позиция — 1-основанная от текущей длины очереди по этому узлу. Запись
 * { node, prompt, task?, root, at, position }. Сбой записи — отказ
 * queue-unavailable: задача, вставшая в очередь только в памяти, потерялась бы
 * при первом же перезапуске, а вызывающий считал бы её принятой.
 */
function enqueueRun(runtime, root, node, entry) {
  const file = queueFilePath(runtime, root);
  let lock = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lock = acquireQueueLock(file);
    if (!lock) throw new Error('лок очереди занят дольше ' + QUEUE_LOCK_WAIT_MS + ' мс');
    /* Очередь читается под локом: иначе два процесса запишут одну позицию. */
    const rows = readQueue(runtime, root);
    const position = rows.filter((row) => row.node === node).length + 1;
    const record = {
      node,
      prompt: entry.prompt,
      ...(entry.task ? { task: entry.task } : {}),
      root: path.resolve(String(root)),
      at: localIso(),
      position,
    };
    rows.push(record);
    /*
     * writeFileAtomic — не только «всё или ничего»: на Windows rename нового
     * файла упирается в EPERM/EBUSY сканера и повторяется там же. Прямой rename
     * один раз уже падал в полном прогоне (0136), хотя отдельный тест проходил.
     */
    writeFileAtomic(file, JSON.stringify(rows, null, 2) + '\n');
    return { position, record };
  } catch (error) {
    throw spawnError('queue-unavailable',
      'очередь узла «' + node + '» не записалась: ' + (error && error.message ? error.message : String(error))
        + '. Проверьте каталог стора запусков или запустите узел позже.');
  } finally {
    releaseQueueLock(lock);
  }
}

/**
 * Проверить занятость узла перед активацией (0136).
 *
 * @returns null — узел свободен, можно стартовать; { kind: 'queued', … } — узел
 *   занят и режим queue, задача записана в очередь; бросает node-busy — узел
 *   занят при refuse или исчерпанном parallel.
 * @param options.queue - true только у project_graph_spawn: ожидающий run
 *   очередь не умеет (у queued задачи ещё нет сессии, а run обязан ждать результат).
 * @param options.prompt - текст задачи для записи очереди.
 * @param options.task - необязательный контракт задания.
 * @param options.taskFields - факты задания для записи (0179): task/object/report,
 *   у приёмщика ещё verdict. Очередь их не выдумывает — берёт готовые.
 * @param options.via - 'spawn' | 'run': каким инструментом пришла задача, для совета.
 */
function checkNodeConcurrency(runtime, root, plan, options = {}) {
  const concurrency = plan.concurrency || { mode: 'refuse' };
  const active = activeRuns(runtime, root, plan.node);
  const limit = concurrency.mode === 'parallel' ? concurrency.max : 1;
  if (active.length < limit) return null;
  if (concurrency.mode === 'queue' && options.queue === true) {
    const placed = enqueueRun(runtime, root, plan.node, {
      prompt: String(options.prompt === undefined ? '' : options.prompt),
      task: options.task,
    });
    noteRun(runtime, {
      root,
      node: plan.node,
      state: 'queued',
      since: nextSince(),
      prompt: String(options.prompt === undefined ? '' : options.prompt),
      ...(options.taskFields || (options.task ? { task: String(options.task) } : {})),
    });
    return {
      kind: 'queued',
      node: plan.node,
      position: placed.position,
      provider: plan.provider,
      model: plan.model,
      ...(plan.preset ? { preset: plan.preset } : {}),
    };
  }
  throw spawnError('node-busy',
    busyMessage(plan.node, concurrency.mode, active.length, limit, options.via));
}

/**
 * Текст отказа structure-invalid по error-находкам валидатора (0161).
 *
 * Коды называются первыми: по ним ищут причину, поэтому они в начале строки.
 * Подробности — до четырёх находок, чтобы отказ оставался читаемым; полный
 * список остаётся у валидатора (панель покажет все).
 */
function validatorRefusal(errors) {
  const codes = [];
  for (const item of errors) if (item && item.code && !codes.includes(item.code)) codes.push(item.code);
  const details = errors.map((item) => text(item.message)).filter(Boolean).slice(0, 4);
  return 'структура неисправна (валидатор): коды ' + codes.join(', ') + '. '
    + (details.length > 0 ? details.join('; ') + '. ' : '')
    + 'Запуск узла заблокирован, пока находки не устранены: исправьте structure/*.json.';
}

/* ------------------------------------------------------------------------- *
 * 0168/0187: ревью-гейт — приёмка не начинается без review.json ревьюера.
 *
 * Заказчик: если ревьюер объявлен, схема не скипуется ни координатором, ни
 * воркером. Значит запуск с заданием (task) требует файла ревьюера ещё до
 * активации агента: review.json лежит рядом с task.md и обязан назвать того же
 * ревьюера. «Файл есть, а имя чужое» — тот же отказ, что и отсутствие файла:
 * иначе гейт обходится правкой одного поля, а не работой ревьюера. С 0187
 * ревьюер определяется не только контрактом, но и графом:
 * узел с id reviewer* или ролью «ревьюер» — такой же обязательный шаг, и его
 * отсутствие в TASK-META не отменяет требование. Гейт относится только к
 * приёмщику: воркер с заданием идёт дальше, иначе ревью блокировало бы работу,
 * а не приёмку.
 * ------------------------------------------------------------------------- */

/** Роль узла-ревьюера: «ревьюер» и английские написания. */
const REVIEWER_ROLE = /ревьюер|reviewer|review/iu;

/** Узлы структуры называют ревьюеров reviewer-1, reviewer-2, … — id тоже признак. */
const REVIEWER_ID = /^reviewer/iu;

/**
 * Узел-ревьюер структуры; null — ревьюера нет.
 *
 * Признаки те же, что у ожидаемого приёмщика (lib/contract.js): id «reviewer*»
 * либо роль со словом «ревьюер». Другие узлы (приёмщик, аудитор) ревьюером не
 * считаются: у них свои артефакты и гейты.
 */
function graphReviewerNode(graph) {
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes.find((node) => {
    if (!node || typeof node !== 'object') return false;
    if (REVIEWER_ID.test(text(node.id))) return true;
    return REVIEWER_ROLE.test(String(node.role === undefined || node.role === null ? '' : node.role));
  }) || null;
}

/**
 * 0198: узел-ревьюер задания — тот, чей закрытый прогон рождает квитанцию.
 *
 * Контракт называет его полем reviewerNode (или reviewer роли), структура —
 * узлом reviewer* / ролью «ревьюер». Пусто — шага ревью нет, квитанции не будет.
 */
function reviewerNodeFor(meta, graph) {
  const declared = declaredReviewer(meta);
  const fromMeta = text(declared && declared.node);
  if (fromMeta) return fromMeta;
  const fromGraph = graphReviewerNode(graph);
  return text(fromGraph && fromGraph.id);
}

/**
 * Претензия к review.json задания; null — файла хватает или шаг не про приёмщика.
 *
 * Ревьюер берётся из TASK-META (0168) и из графа (0187): контракт может не
 * объявлять поле, но узел-ревьюер в структуре — обязательный шаг. Гейт
 * применяется только к узлу-приёмщику этого задания: воркер с task не
 * блокируется (C5 задания 0187).
 *
 * Проверяются ровно три вещи (D1 задания 0168): файл существует, разбирается
 * как JSON-объект и reviewer в нём — объявленный узел. Качество ревью не
 * оценивается: это дело приёмщика, а не гейта запуска.
 *
 * @param meta - TASK-META задания.
 * @param graph - собранный граф структуры.
 * @param node - узел, который запускают.
 * @param root - корень узла: путь в отказе должен быть от него, а не абсолютный.
 * @param taskFile - абсолютный путь к task.md задания.
 * @returns {string|null} текст отказа с требованием либо null.
 */
function reviewGateProblem(meta, graph, node, root, taskFile) {
  const declared = declaredReviewer(meta);
  const fromGraph = graphReviewerNode(graph);
  const reviewer = text(declared && declared.node) || text(fromGraph && fromGraph.id);
  if (!reviewer) return null;
  /* Гейт — только приёмка: воркер и другие узлы при объявленном ревьюере проходят. */
  if (!taskAcceptorNode(graph, meta, node)) return null;
  const reviewPath = path.join(path.dirname(taskFile), 'review.json');
  const relPath = path.relative(path.resolve(String(root)), reviewPath).split(path.sep).join('/');
  const source = declared
    ? 'Задание объявляет ревьюера ' + reviewer
    : 'В структуре объявлен узел-ревьюер ' + reviewer;
  const head = 'нужен review.json от ' + reviewer + ' — ' + relPath + '. '
    + source + ': приёмка не начинается, пока его файла нет. '
    + 'В файле должен быть JSON-объект с полем "reviewer": "' + reviewer + '" (допустим и "reviewerNode") '
    + 'и вердикт "verdict" (например "ok")';
  let raw;
  try {
    raw = fs.readFileSync(reviewPath, 'utf8');
  } catch {
    return head + '. Файл не найден.';
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return head + '. Файл не разбирается как JSON: '
      + (error && error.message ? error.message : String(error)) + '.';
  }
  if (!isPlainObject(parsed)) return head + '. Корень файла — не JSON-объект.';
  const named = text(parsed.reviewer) || text(parsed.reviewerNode);
  if (!named) return head + '. В файле нет поля reviewer.';
  if (bareName(named) !== bareName(reviewer)) {
    return head + '. В файле reviewer «' + named + '» — это не объявленный узел.';
  }
  /*
   * 0198: правильные поля — ещё не ревью. Квитанцию пишет движок, закрывая
   * прогон объявленного ревьюера, и её artifactSha256 связывает подпись с
   * дословными байтами файла. review.json без квитанции (или с разошедшимся
   * хешем) отклоняется: файл, созданный координатором, приёмкой не считается.
   */
  const receipt = validateReviewReceipt({ taskDir: path.dirname(taskFile), reviewer });
  if (!receipt.ok) {
    return head + '. ' + receipt.errors.join('; ')
      + ' — квитанция пишется движком при завершении прогона ревьюера; файл, созданный координатором, не принимается.';
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * 0177: узел «Аудитор задач» — вход в запуск, а не совет.
 *
 * Заказчик: аудитор — узел схемы, его вердикт — артефакт, без которого работа
 * не идёт дальше. Значит, если структура объявила аудитора, запуск с заданием
 * требует docs/tasks/<id>/audit.json: нет файла, файл битый или verdict rework —
 * отказ audit-required с путём и полями. Без аудитора в графе поведение прежнее.
 * Гейт относится к активации: plan (dry-run) файла не требует.
 * ------------------------------------------------------------------------- */

/** Роль узла-аудитора: «Аудитор задач» и любые написания со словом «аудитор». */
const AUDITOR_ROLE = /аудитор|auditor/iu;

/**
 * Узел-аудитор структуры; null — аудитора нет.
 *
 * Признаки задания: id "auditor" либо роль со словом «аудитор». Другие роли
 * (ревьюер, приёмщик) аудитором не считаются: у них свои артефакты и гейты.
 */
function auditorNode(graph) {
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes.find((node) => {
    if (!node || typeof node !== 'object') return false;
    if (text(node.id).toLowerCase() === 'auditor') return true;
    return AUDITOR_ROLE.test(String(node.role === undefined || node.role === null ? '' : node.role));
  }) || null;
}

/**
 * Претензия к audit.json задания; null — вердикт аудитора позволяет запуск.
 *
 * Проверяется ровно то, что делает запуск законным (D1 задания 0177): файл
 * существует, разбирается как JSON-объект, проходит validateAudit (conform с
 * непустыми anchors и reason; version/task/at на месте) и относится к этому
 * заданию. Качество аудита не оценивается: это дело приёмщика, а не гейта.
 *
 * @param meta - TASK-META задания (может быть null).
 * @param graph - собранный граф структуры.
 * @param root - корень узла: путь в отказе должен быть от него.
 * @param taskFile - абсолютный путь к task.md задания.
 * @param consumes - якоря входа узла-аудитора (0186; пусто — привязки нет).
 * @returns {string|null} текст отказа с требованием либо null.
 */
function auditGateProblem(meta, graph, root, taskFile, consumes) {
  const auditor = auditorNode(graph);
  if (!auditor) return null;
  const auditPath = path.join(path.dirname(taskFile), 'audit.json');
  const relPath = path.relative(path.resolve(String(root)), auditPath).split(path.sep).join('/');
  const taskId = text(meta && meta.id);
  const head = 'нужен audit.json от узла «' + (text(auditor.id) || 'auditor') + '» — ' + relPath + '. '
    + 'В структуре объявлен аудитор задач: запуск с заданием не начинается без его вердикта. '
    + 'В файле должен быть JSON-объект с полями version (1), task (id задания'
    + (taskId ? ' — "' + taskId + '"' : '') + '), auditor, verdict ("conform" или "rework"), '
    + 'anchors (непустой список якорей проверки), reason (почему вердикт такой) и at (ISO-время); '
    + 'вердикт "rework" — отказ.';
  let raw;
  try {
    raw = fs.readFileSync(auditPath, 'utf8');
  } catch {
    return head + ' Файл не найден.';
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return head + ' Файл не разбирается как JSON: '
      + (error && error.message ? error.message : String(error)) + '.';
  }
  const verdict = validateAudit(parsed);
  if (!verdict.ok) {
    return head + ' Файл не прошёл проверку: ' + verdict.errors.join('; ') + '.';
  }
  if (taskId && text(parsed.task) !== taskId) {
    return head + ' audit.json относится к заданию «' + text(parsed.task)
      + '», а запускается «' + taskId + '»: вердикт по чужому заданию не годится.';
  }
  /*
   * 0186: вердикт судит только вход аудитора. Узел объявил consumes — каждый
   * из них обязан быть подтверждён в anchors либо назван в notJudged; якорь
   * чужого id — не его работа. Узел без anchors (0177) вопроса не ставит.
   */
  const claims = validateAnchorClaims(parsed, consumes);
  if (!claims.ok) {
    return head + ' Вердикт не покрывает вход аудитора: ' + claims.errors.join('; ') + '.';
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * 0186: якоря утверждены и привязаны к узлам — предусловие вердикта аудитора.
 *
 * Заказчик: аудитор формально есть, но с чем сверяет — не задано. Поэтому до
 * вердикта проверяется сам механизм: docs/anchors.json утверждён файлом
 * docs/anchors.approval.json (sha256 совпадает, подпись покрывает hash+by+at),
 * а структура ссылается только на существующие якоря. Нет файла, хеш разошёлся
 * или привязка врёт — запуск с заданием отклоняется (anchors-unapproved /
 * anchors-binding), а не идёт «на доверии».
 *
 * Гейт включается, когда структура объявила якоря (anchors.consumes/produces
 * хотя бы у одного узла) или когда в проекте уже лежат документы якорей: тогда
 * удаление поля из узла гейт не выключает. Проект без якорей и без документов
 * якорей живёт по прежним правилам 0177: привязки нет — проверять нечего.
 * ------------------------------------------------------------------------- */

/** Путь файла в отказе — от корня проекта, с прямыми слэшами (читают и на Windows). */
function projectFileRel(root, file) {
  return path.relative(path.resolve(String(root)), file).split(path.sep).join('/');
}

/**
 * Документы якорей проекта: docs/anchors.json и docs/anchors.approval.json.
 *
 * Утверждение проверяется по дословному тексту файла якорей — тому, что лежит
 * на диске сейчас, а не по пересказу. Поэтому текст читается один раз и тем же
 * уходит и в validateApproval, и в разбор списка.
 *
 * @returns {{ ok: true, anchors: unknown } | { ok: false, problem: string }}
 */
function readAnchorsDocs(root) {
  const anchorsPath = path.join(path.resolve(String(root)), 'docs', 'anchors.json');
  const approvalPath = path.join(path.resolve(String(root)), 'docs', 'anchors.approval.json');
  const anchorsRel = projectFileRel(root, anchorsPath);
  const approvalRel = projectFileRel(root, approvalPath);
  let anchorsText;
  try {
    anchorsText = fs.readFileSync(anchorsPath, 'utf8');
  } catch {
    return {
      ok: false,
      problem: 'нет ' + anchorsRel + ': структура объявила якоря, но утверждать нечего. '
        + 'Файл якорей — предмет утверждения, а не приложение к нему.',
    };
  }
  let anchors;
  try {
    anchors = JSON.parse(anchorsText);
  } catch (error) {
    return {
      ok: false,
      problem: anchorsRel + ': файл не разбирается как JSON: '
        + (error && error.message ? error.message : String(error)) + '.',
    };
  }
  if (Array.isArray(anchors)) {
    anchors = { version: 1, anchors };
  } else if (!isPlainObject(anchors) || !Array.isArray(anchors.anchors)) {
    return {
      ok: false,
      problem: anchorsRel + ': нет списка anchors — якорей нет, привязывать не к чему.',
    };
  }
  let approvalText;
  try {
    approvalText = fs.readFileSync(approvalPath, 'utf8');
  } catch {
    return {
      ok: false,
      problem: 'нет ' + approvalRel + ': якоря перечислены, но не утверждены. '
        + 'Нужен файл с algo sha256, hash файла якорей и signature.covers = "hash+by+at".',
    };
  }
  let approval;
  try {
    approval = JSON.parse(approvalText);
  } catch (error) {
    return {
      ok: false,
      problem: approvalRel + ': файл не разбирается как JSON: '
        + (error && error.message ? error.message : String(error)) + '.',
    };
  }
  const verdict = validateApproval(approval, anchorsText, { root });
  if (!verdict.ok) {
    return {
      ok: false,
      problem: approvalRel + ': утверждение не состоялось: ' + verdict.errors.join('; ') + '. '
        + 'Якоря считаются утверждёнными только при sha256, совпадающем с ' + anchorsRel
        + ', и signature.covers = "hash+by+at".',
    };
  }
  return { ok: true, anchors };
}

/**
 * Якоря в игре: структура их объявила или в проекте уже лежат документы якорей.
 *
 * Одного поля в структуре мало: удалить anchors из узла — не способ выключить
 * утверждение, если docs/anchors.json уже лежит в проекте. Тогда гейт остаётся
 * включённым, и узел-аудитор без consumes получает anchors-binding, а не тихий
 * проход по правилам 0177. Выключить механизм можно только убрав сам корпус.
 */
function anchorsInPlay(structure, root) {
  if (anchorsDeclared(structure)) return true;
  const docs = path.join(path.resolve(String(root)), 'docs');
  return fs.existsSync(path.join(docs, 'anchors.json'))
    || fs.existsSync(path.join(docs, 'anchors.approval.json'));
}

/**
 * Отказ якорного гейта (0186); null — запуск с заданием привязку не нарушает.
 *
 * @param anchorNodes - узлы структуры с объявленными якорями (structureAnchorBindings).
 * @param root - корень проекта: docs/anchors*.json лежат в нём.
 * @returns {{ code: 'anchors-unapproved'|'anchors-binding', problem: string } | null}
 */
function anchorsGateRefusal(anchorNodes, root) {
  const structure = { nodes: anchorNodes };
  if (!anchorsInPlay(structure, root)) return null;
  const docs = readAnchorsDocs(root);
  if (!docs.ok) return { code: 'anchors-unapproved', problem: docs.problem };
  const binding = validateBinding(structure, docs.anchors);
  if (!binding.ok) {
    return {
      code: 'anchors-binding',
      problem: 'структура объявила якоря, но привязка не сходится: ' + binding.errors.join('; ') + '. '
        + 'Каждый якорь узла обязан существовать в docs/anchors.json, '
        + 'а узел-аудитор и узел-ревьюер — объявить непустой anchors.consumes.',
    };
  }
  return null;
}

/**
 * Узлы структуры с объявленными якорями — из фрагментов, а не из графа (0186).
 *
 * Собранный граф (lib/graph.js) хранит только объявленные поля узла и выбрасывает
 * anchors, поэтому гейт читает те же фрагменты, что и структура. Ошибка чтения —
 * пусто: исправность структуры уже проверил readGraph, а гейт не гадает.
 */
function anchorNodesOf(runtime, root) {
  try {
    const read = readStructure(root, runtime.structureDir);
    return structureAnchorBindings(read.files);
  } catch {
    return [];
  }
}

/** Якоря входа узла-аудитора: с них спрашивается вердикт в audit.json (0186). */
function auditorConsumesOf(graph, anchorNodes) {
  const auditor = auditorNode(graph);
  if (!auditor) return [];
  const id = text(auditor.id);
  const declared = (Array.isArray(anchorNodes) ? anchorNodes : []).find((node) => node && node.id === id);
  return declared ? consumesOf(declared) : [];
}

/** The tool definition: JSON schema in, JSON value out. */
export function createSpawnTool(options) {
  const runtime = options.runtime;
  const config = isPlainObject(options.config) ? options.config : {};
  const getSubagents = options.getSubagents;
  const getAgentPresets = options.getAgentPresets;
  /* 0139: провайдеры рантайма — запасное доказательство, когда каталога нет. */
  const getKnownProviders = options.getKnownProviders;
  /*
   * 0138: проба фактического cwd ребёнка. По умолчанию — кэш сессий хоста, где
   * DSH держит рабочий каталог сессии; стенд и проверки передают свою пробу.
   */
  const probeCwd = typeof options.probeCwd === 'function' ? options.probeCwd : readSessionCwd;
  /*
   * 0142: создание служебной сессии в корне узла (ctx.agents.create). Хост без
   * такой службы не передаёт хук — тогда известный чужой cwd родителя даёт
   * честный отказ root-mismatch, а не молчаливый запуск не в том воркспейсе.
   */
  const createAgent = typeof options.createAgent === 'function' ? options.createAgent : null;
  /*
   * 0161: валидатор структуры — предусловие запуска, а не совет. Хук получает
   * собранный граф и отвечает { ok, findings }; error-находки блокируют запуск
   * до старта агента и называют свои коды. Не передан (стенд, проверка) —
   * поведение прежнее: проверку делает только сборщик графа.
   */
  const validateStructure = typeof options.validateStructure === 'function' ? options.validateStructure : null;

  return {
    name: SPAWN_TOOL_NAME,
    description:
      "Start one agent declared in the project's structure/ folder, on the provider and model assigned to that node. "
      + 'The model comes from the declaration, never from this call. Use it to delegate work to a declared role; '
      + 'use plan: true to check the route without starting anything.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', description: 'Node id from structure/*.json (for example "lead-code").' },
        prompt: { type: 'string', description: 'The task for the child agent.' },
        root: { type: 'string', description: 'Absolute project root; optional when exactly one root is configured.' },
        task: { type: 'string', description: 'Task contract (docs/tasks/<id>) this run executes; refused when its executor/acceptor contradict the structure.' },
        plan: { type: 'boolean', description: 'Resolve and return the route without starting an agent.' },
      },
      required: ['node', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['activation', 'plan', 'queued'] },
          childId: { type: 'string' },
          position: { type: 'number' },
          node: { type: 'string' },
          role: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          preset: { type: 'string' },
        },
        required: ['kind', 'node', 'provider', 'model'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'plan'
          ? 'node ' + value.node + ' -> ' + value.provider + '/' + value.model
            + (value.preset ? ' with preset ' + value.preset : '') + ' (plan only)'
          : value.kind === 'queued'
            ? 'node ' + value.node + ' is busy; queued at position ' + value.position
              + ' on ' + value.provider + '/' + value.model
            : 'started ' + value.node + ' as subagent ' + value.childId + ' on ' + value.provider + '/' + value.model
              + (value.preset ? ' with preset ' + value.preset : ''),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec && exec.agent;
      if (!parent) throw spawnError('no-parent', 'инструмент вызван без агента: вызовите его из сессии, у которой есть родитель');
      const subagents = typeof getSubagents === 'function' ? getSubagents() : null;
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw spawnError('spawn-unavailable', 'служба ctx.subagents не подключена: проверьте, что в DSH загружен плагин subagent');
      }
      const providerName = typeof config.provider === 'string' && config.provider.trim()
        ? config.provider.trim()
        : DEFAULT_PROVIDER;
      const provider = subagents.getProvider ? subagents.getProvider(providerName) : undefined;
      if (!provider) {
        throw spawnError('spawn-unavailable', 'провайдер «' + providerName + '» не зарегистрирован: проверьте, что в DSH подключён subagent-spawn-in-process');
      }
      if (!provider.capabilities || provider.capabilities.agentOptions !== true) {
        throw spawnError('spawn-unavailable',
          'провайдер «' + providerName + '» не умеет agentOptions: нужен локальный провайдер spawn, иначе модель узла не передать');
      }

      const rootSelection = resolveRoot(runtime, args && args.root);
      if (!rootSelection.ok) throw spawnError(rootSelection.code, rootSelection.message);
      const payload = readGraph(runtime, rootSelection.root);
      if (payload.errors.length > 0) {
        const first = payload.errors[0];
        throw spawnError('structure-invalid',
          'структура недействительна: ' + first.message + (first.fix ? ' Что сделать: ' + first.fix : ''));
      }
      /*
       * 0161: валидатор структуры — до плана и до старта. Error-находка
       * блокирует запуск: отказ structure-invalid перечисляет коды находок.
       * Warning блокировкой не является и в отказе не участвует. Валидатор не
       * передан — поведение прежнее; сам валидатор упал — запуск тоже не идёт
       * (неизвестная структура не доказана, а не «наверное, исправна»).
       */
      if (validateStructure) {
        let result;
        try {
          result = await validateStructure(payload.graph);
        } catch (error) {
          throw spawnError('structure-invalid',
            'валидатор структуры не смог проверить граф: '
              + (error && error.message ? error.message : String(error))
              + '. Запуск узла не принят: исправность структуры не доказана');
        }
        const findings = Array.isArray(result)
          ? result
          : (result && Array.isArray(result.findings) ? result.findings : []);
        const errors = findings.filter((item) => item && item.severity === 'error');
        if (errors.length > 0) throw spawnError('structure-invalid', validatorRefusal(errors));
      }
      /*
       * A task contract is checked against the structure before any work starts:
       * the graph decides who accepts whose result, so a contract that names a
       * different acceptor is a bypass and is refused here, not noticed later.
       */
      const taskArg = args && typeof args.task === 'string' ? args.task.trim() : '';
      /* 0179: контракт задания и его мета читаются здесь — факты записи берут их отсюда. */
      let taskFile = '';
      let taskMeta = null;
      if (taskArg) {
        const taskRoot = path.resolve(rootSelection.root);
        taskFile = path.resolve(taskRoot, taskArg);
        if (taskFile !== taskRoot && !taskFile.startsWith(taskRoot + path.sep)) {
          throw spawnError('task-outside-root', 'задание должно лежать внутри корня проекта: ' + taskArg);
        }
        const problems = validateTaskFile(payload.graph, taskFile);
        if (problems.length > 0) {
          throw spawnError('task-contradicts-structure',
            'контракт задания противоречит структуре: ' + problems.join('; ')
            + '. Исправьте acceptor в задании или связь в structure/*.json — обходить структуру нельзя.');
        }
        /*
         * 0168: ревьюер в контракте обязателен. План агента не запускает —
         * гейт относится к активации, поэтому dry-run (plan: true) файла не
         * требует. Без reviewer в TASK-META поведение прежнее.
         */
        if (!(args && args.plan === true)) {
          let taskText = '';
          try {
            taskText = fs.readFileSync(taskFile, 'utf8');
          } catch {
            /* validateTaskFile выше уже отказал бы: нечитаемый файл сюда не доходит */
            taskText = '';
          }
          taskMeta = parseTaskMeta(taskText);
          const reviewProblem = reviewGateProblem(taskMeta, payload.graph, args && args.node, taskRoot, taskFile);
          /*
           * 0198: отсутствие квитанции — свой отказ review-receipt-required,
           * а не общий review-required: читателю должно быть ясно, что файл
           * ревью есть, но он не подтверждён движком.
           */
          if (reviewProblem) {
            const receiptRefusal = reviewProblem.includes('review-receipt:');
            throw spawnError(receiptRefusal ? 'review-receipt-required' : 'review-required', reviewProblem);
          }
          /* 0186: сначала утверждение якорей и привязка — потом вердикт по ним. */
          const anchorNodes = anchorNodesOf(runtime, taskRoot);
          const anchorsRefusal = anchorsGateRefusal(anchorNodes, taskRoot);
          if (anchorsRefusal) throw spawnError(anchorsRefusal.code, anchorsRefusal.problem);
          /* 0177: аудитор задач в структуре — без его conform задание не стартует. */
          const auditProblem = auditGateProblem(taskMeta, payload.graph, taskRoot, taskFile,
            auditorConsumesOf(payload.graph, anchorNodes));
          if (auditProblem) throw spawnError('audit-required', auditProblem);
        }
      }
      /*
       * Каталог проверяется в плане, до старта: неизвестный провайдер или модель
       * отказывают с именами, а не всплывают падением уже запущенного агента.
       * Каталога нет — сверяемся со списком провайдеров рантайма (0139): без
       * адаптера узел не родится и не упадёт NO_ADAPTER уже в сессии.
       */
      const [catalog, knownProviders] = await Promise.all([
        readSpawnCatalog(runtime),
        readKnownProviders(getKnownProviders),
      ]);
      const plan = resolveNodePlan(payload.graph, args && args.node, { catalog, knownProviders });
      if (!plan.ok) throw spawnError(plan.code, plan.message);

      if (plan.preset) {
        if (!provider.capabilities || provider.capabilities.agentPreset !== true) {
          throw spawnError('spawn-unavailable',
            'провайдер «' + providerName + '» не умеет agentPreset: пресет узла не передать');
        }
        const presets = typeof getAgentPresets === 'function' ? getAgentPresets() : null;
        if (!presets || typeof presets.resolve !== 'function') {
          throw spawnError('preset-unavailable',
            'узел «' + plan.node + '» требует пресет «' + plan.preset + '», но служба agentPresets не подключена');
        }
        try {
          const resolved = await presets.resolve(plan.preset);
          if (resolved && resolved.broken) {
            throw spawnError('preset-broken',
              'пресет «' + plan.preset + '» у узла «' + plan.node + '» не активируется: '
                + (typeof resolved.broken === 'string' ? resolved.broken : JSON.stringify(resolved.broken)));
          }
        } catch (error) {
          if (error && (error.code === 'preset-broken' || error.code === 'preset-unavailable' || error.code === 'unknown-preset')) throw error;
          let available = [];
          try {
            const rows = typeof presets.list === 'function' ? await presets.list() : [];
            available = (rows || []).map((row) => row && row.id).filter(Boolean);
          } catch {
            available = [];
          }
          throw spawnError('unknown-preset',
            'пресета «' + plan.preset + '» нет в DSH'
              + (available.length > 0 ? '; доступны: ' + available.join(', ') : '')
              + '. Исправьте agentPreset в structure/*.json или объявите пресет.');
        }
      }

      const value = {
        kind: args && args.plan === true ? 'plan' : 'activation',
        node: plan.node,
        role: plan.role || undefined,
        provider: plan.provider,
        model: plan.model,
        ...(plan.preset ? { preset: plan.preset } : {}),
      };
      if (value.kind === 'plan') return value;

      /*
       * 0179: предмет запуска — до первой записи о нём. Факты названы один раз,
       * чтобы очередь, запуск и завершение не разошлись в том, что принято.
       */
      const taskFields = taskRunFields(rootSelection.root, payload.graph, taskMeta, taskFile, plan.node);

      /*
       * 0197: гейт активации — до родителя, очереди и startActivation. Незакрытый
       * результат предыдущего планового прогона нельзя перепрыгнуть новым
       * запуском; отказ пишется error-прогоном, ребёнок не поднимается.
       */
      const gateErrors = edgeGateErrors(runtime, rootSelection.root, payload.graph, plan.node);
      if (gateErrors.length > 0) {
        noteRun(runtime, {
          root: rootSelection.root,
          node: plan.node,
          state: 'error',
          since: nextSince(),
          finishedAt: Date.now(),
          ...(taskFields || {}),
          message: 'edge-obligation: ' + gateErrors.join('; '),
        });
        throw spawnError('edge-obligation',
          gateErrors.map((line) => line.replace(/^edge-obligation:\s*/u, '')).join('; '));
      }

      /*
       * 0142: где работает вызывающая сессия — до занятости и до старта. Хост
       * берёт cwd ребёнка от родителя (0138), поэтому известный чужой воркспейс
       * вызывающего требует служебной сессии в корне узла; иначе честный отказ,
       * а не запуск не в том воркспейсе.
       */
      const runId = newRunId();
      const parentChoice = await resolveActivationParent({
        probe: probeCwd,
        parent,
        root: rootSelection.root,
        createAgent,
        label: (plan.role ? plan.role + ':' : '') + plan.node,
        node: plan.node,
      });
      if (!parentChoice.ok) {
        /*
         * Свидетельство отказа до старта: сессии ребёнка нет, поэтому started с
         * пустым childId, settled ok:false и запись прогона error. Успешного
         * childId вызывающему не будет: он повёл бы работу не в том воркспейсе.
         */
        const refusalSince = nextSince();
        startedLaunch(runtime, {
          root: rootSelection.root,
          runId,
          ...launchTaskFields(taskFields, taskArg),
          node: plan.node,
          childId: '',
          provider: plan.provider,
          model: plan.model,
        });
        settledLaunch(runtime, { root: rootSelection.root, runId, ok: false, errorCode: 'root-mismatch' });
        noteRun(runtime, {
          root: rootSelection.root,
          node: plan.node,
          state: 'error',
          since: refusalSince,
          finishedAt: Date.now(),
          ...(taskFields || {}),
          message: parentChoice.error.message,
        });
        throw parentChoice.error;
      }

      /*
       * Занятость узла — до старта (0136): отказ и очередь не должны поднимать
       * сессию. Свободный узел стартует как раньше, при любом режиме.
       */
      const queued = checkNodeConcurrency(runtime, rootSelection.root, plan, {
        queue: true,
        via: 'spawn',
        prompt: args && args.prompt,
        task: taskArg,
        taskFields,
      });
      if (queued) return queued;

      let maxDepth;
      if (typeof subagents.resolveMaxDepth === 'function') {
        maxDepth = subagents.resolveMaxDepth(config.maxDepth === undefined ? DEFAULT_MAX_DEPTH : config.maxDepth);
      }
      const request = {
        /*
         * The child works in the workspace that declares the node, not in the
         * caller's directory: otherwise a structure of project B started from a
         * session of project A would read and write A's files while claiming to
         * run B's node.
         */
        cwd: rootSelection.root,
        prompt: promptWithRunId(String(args.prompt), runId, plan),
        parent: parentChoice.parent,
        agentOptions: { provider: plan.provider, model: plan.model },
        ...(plan.preset ? { agentPreset: plan.preset } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      };
      const since = nextSince();
      noteRun(runtime, { root: rootSelection.root, node: plan.node, state: 'running', since, ...(taskFields || {}) });
      let activation;
      try {
        activation = await subagents.startActivation({
          provider: providerName,
          label: (plan.role ? plan.role + ':' : '') + plan.node,
          request,
          signal: exec.signal,
          delivery: 'parent',
        });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        /*
         * Свидетельство «запуск не состоялся»: активация не вернула childId,
         * поэтому started идёт с пустым childId, а settled — ok=false. Движок
         * видит отказ, а не отсутствие записи.
         */
        startedLaunch(runtime, {
          root: rootSelection.root,
          runId,
          ...launchTaskFields(taskFields, taskArg),
          node: plan.node,
          childId: '',
          provider: plan.provider,
          model: plan.model,
        });
        settledLaunch(runtime, {
          root: rootSelection.root,
          runId,
          ok: false,
          errorCode: (error && error.code) || 'activation-error',
        });
        noteRun(runtime, {
          root: rootSelection.root,
          node: plan.node,
          state: 'error',
          since,
          finishedAt: Date.now(),
          ...(taskFields || {}),
          message,
        });
        throw error;
      }
      const childId = activation && activation.childId;
      let facts;
      if (parentChoice.sessionSource === 'created') {
        /*
         * 0142: родитель — сессия, созданная нами в корне узла. Воркспейс выбран
         * явно (и сверен с корнем при создании), а не навязан хостом; проба 0138
         * относится к случаю, когда cwd ребёнка задаёт чужая сессия вызывающего,
         * поэтому здесь она не применяется.
         */
        facts = createdSessionFacts(rootSelection.root);
      } else {
        /*
         * 0138: сначала факт, потом ответ вызывающему. Хост может принять root и
         * всё равно создать сессию в воркспейсе родителя (живой случай
         * ws-school-app --05) — тогда запуск не должен выглядеть успешным.
         * Недоступная проба — «неизвестно», и активация проходит как раньше (D1).
         */
        const childCwd = await probeChildCwd(probeCwd, childId);
        if (childCwd.known && !sameRealPath(childCwd.cwd, rootSelection.root)) {
          const rootPath = path.resolve(String(rootSelection.root));
          const message = 'сессия создана в другом воркспейсе: ' + childCwd.cwd
            + ', а узел объявлен в ' + rootPath
            + '. Запуск не принят: ребёнок читал бы и писал файлы чужого проекта, а не узла';
          /*
           * Свидетельство отказа: сессия действительно поднята, поэтому started
           * несёт её настоящий childId, но запуск не принят — settled ok:false, а
           * прогон записан как error. Успешного childId вызывающему не будет: он
           * повёл бы работу не в том воркспейсе.
           */
          startedLaunch(runtime, {
            root: rootSelection.root,
            runId,
            ...launchTaskFields(taskFields, taskArg),
            node: plan.node,
            childId,
            provider: plan.provider,
            model: plan.model,
          });
          settledLaunch(runtime, { root: rootSelection.root, runId, ok: false, errorCode: 'root-mismatch' });
          noteRun(runtime, {
            root: rootSelection.root,
            node: plan.node,
            state: 'error',
            since,
            finishedAt: Date.now(),
            childId,
            ...(taskFields || {}),
            message,
            ...cwdFacts(rootSelection.root, childCwd),
          });
          /*
           * Ребёнок поднят не там: не оставляем его работать в чужом воркспейсе.
           * Остановка не ждётся — отказ не должен зависеть от dispose; его сбой
           * уже ничего не меняет.
           */
          try {
            const stopping = activation && typeof activation.dispose === 'function' ? activation.dispose() : null;
            if (stopping && typeof stopping.catch === 'function') stopping.catch(() => {});
          } catch {
            /* сессия могла ещё не подняться — отказ уже состоялся */
          }
          throw spawnError('root-mismatch', message);
        }
        facts = cwdFacts(rootSelection.root, childCwd);
      }
      /*
       * started несёт childId, поэтому пишется сразу после активации и до
       * ожидания результата: append-only строку нельзя переписать задним
       * числом, а контроль C1 требует session id в единственной started-записи.
       */
      startedLaunch(runtime, {
        root: rootSelection.root,
        runId,
        ...launchTaskFields(taskFields, taskArg),
        node: plan.node,
        childId,
        provider: plan.provider,
        model: plan.model,
      });
      noteRun(runtime, { root: rootSelection.root, node: plan.node, state: 'running', since, childId, ...(taskFields || {}), ...facts });
      watchSpawnedRun(runtime, {
        root: rootSelection.root,
        node: plan.node,
        runId,
        since,
        activation,
        facts,
        taskFields,
        /* 0198: задание и граф нужны на завершении — движок пишет квитанцию ревьюера. */
        taskFile,
        taskMeta,
        graph: payload.graph,
        /* Вердикт мог появиться во время работы: на завершении факт перечитывается. */
        refreshTask: () => taskRunFields(rootSelection.root, payload.graph, taskMeta, taskFile, plan.node),
      });
      return { ...value, childId };
    },
  };
}

/**
 * Блок идентичности узла (0137): кто ребёнок, зачем он в структуре и по какой
 * спеке работает.
 *
 * Строки пустых полей не печатаются: узел без brief не получает
 * «Назначение: .», узел без роли — «роль undefined». undefined в промпте —
 * это утечка внутреннего поля в текст, который читает агент, поэтому каждое
 * поле проходит через text() и добавляется только непустым.
 */
function nodeIdentityBlock(plan) {
  const role = text(plan && plan.role);
  const brief = text(plan && plan.brief);
  const spec = text(plan && plan.spec);
  const lines = ['Ты — узел ' + text(plan && plan.node) + (role ? ', роль ' + role : '') + '.'];
  if (brief) lines.push('Назначение: ' + brief + '.');
  if (spec) lines.push('Спека: ' + spec);
  return lines.join('\n');
}

/**
 * Промпт активации: блок идентичности + дословный промпт вызывающего + runId.
 *
 * Порядок — часть контракта (0137): первым ребёнок читает, кто он, затем
 * задачу, которую ему передали, затем свой runId (0101). Блок стоит в том же
 * текстовом блоке, что и задача, — так ребёнок видит одно сообщение, а промпт
 * вызывающего остаётся в первом блоке дословно (на него опираются проверки
 * ветки, расписания и обмена: prompt[0].text — это задача).
 */
function promptWithRunId(prompt, runId, plan) {
  const identity = nodeIdentityBlock(plan);
  return [
    { type: 'text', text: identity ? identity + '\n\n' + prompt : prompt },
    { type: 'text', text: 'runId: ' + runId },
  ];
}

/**
 * started: свидетельство того, что узел запущен, а не объявлен (задание 0101).
 *
 * 0179: task — id задания из TASK-META, рядом object (название), report (путь
 * отчёта) и verdict приёмщика. Поля задания берутся из фактов, а не из аргумента:
 * запись обязана говорить, что именно запущено.
 */
function startedLaunch(runtime, { root, runId, task, node, childId, provider, model, object, report, verdict }) {
  return appendLaunch(runtime, root, {
    v: 1,
    runId,
    at: localIso(),
    root,
    task: task ? String(task) : null,
    ...(object ? { object } : {}),
    ...(report ? { report } : {}),
    ...(verdict ? { verdict } : {}),
    node,
    childId: childId || '',
    provider,
    model,
    depth: 1,
    state: 'started',
  });
}

/** settled: переход запуска в конечное состояние, тот же runId. */
function settledLaunch(runtime, { root, runId, ok, errorCode }) {
  return appendLaunch(runtime, root, {
    v: 1,
    runId,
    at: localIso(),
    state: 'settled',
    ok: ok === true,
    endedAt: localIso(),
    ...(errorCode ? { errorCode: String(errorCode) } : {}),
  });
}

/**
 * Record the end of a run the caller did not wait for.
 *
 * project_graph_spawn returns as soon as the child is accepted, so without this
 * the panel would show the catalog child while it lives and then nothing: the
 * card falls back to "no active agent" and the finished work leaves no trace in
 * /api/activity. The activation carries the same result promise
 * project_graph_run awaits; attach to it and write done/error when it settles.
 * A rejection is recorded, never rethrown: the caller is long gone, and an
 * unhandled rejection here would fail the process that hosted the spawn.
 *
 * @param runtime - graph runtime holding the run store.
 * @param record.root - project root the node belongs to.
 * @param record.node - node id that was started.
 * @param record.runId - launch id shared by started, settled and the child prompt.
 * @param record.since - start timestamp, kept so the panel shows the real run.
 * @param record.activation - accepted activation; a missing result is tolerated.
 * @param record.facts - cwd facts of the child (0138): what was asked and where it
 *   actually works. Carried into the final record, so the fact is not lost on the
 *   running → done/error transition.
 * @param record.taskFields - facts of the task (0179): task/object/report and the
 *   acceptor's verdict. Carried into the final record too.
 * @param record.taskFile - absolute task.md path; the receipt lives next to review.json.
 * @param record.taskMeta - parsed TASK-META: it names the reviewer whose run signs the review.
 * @param record.graph - the structure: when the contract is silent, the graph names the reviewer.
 * @param record.refreshTask - recounts the task facts at settlement: the verdict
 *   may appear while the run works (acceptance.json is written by the judge).
 */
function watchSpawnedRun(runtime, {
  root,
  node,
  runId,
  since,
  activation,
  facts,
  taskFields,
  taskFile,
  taskMeta,
  graph,
  refreshTask,
}) {
  /*
   * 0198: прогон объявленного ревьюера закрывает ревью — квитанцию пишет
   * движок, а не агент. Иначе координатор мог бы изготовить и review.json, и
   * «квитанцию» сам; здесь квитанция появляется только вместе с закрытым прогоном.
   */
  const writeReceipt = () => {
    if (!taskFile) return;
    const reviewer = reviewerNodeFor(taskMeta, graph);
    if (!reviewer || bareName(node) !== bareName(reviewer)) return;
    try {
      writeReviewReceipt({
        taskDir: path.dirname(taskFile),
        task: taskMeta && taskMeta.id,
        reviewer,
        node,
        runId,
        childId: activation && activation.childId,
        sessionId: activation && activation.childId,
      });
    } catch (error) {
      /* Сбой записи — предупреждение: прогон уже закрыт, квитанцию возьмут следующей. */
      console.warn('[dsh-project-graph] review receipt is unavailable: '
        + (error && error.message ? error.message : String(error)));
    }
  };
  const result = activation && activation.result;
  if (!result || typeof result.then !== 'function') return;
  const finalTaskFields = () => {
    if (typeof refreshTask !== 'function') return taskFields || {};
    try {
      return refreshTask() || {};
    } catch {
      return taskFields || {};
    }
  };
  result.then(
    (settled) => {
      const output = resultText(settled);
      const failed = Boolean(settled && settled.stopReason === 'error');
      /* 0101: свидетельство завершения — до записи в историю панели. */
      settledLaunch(runtime, { root, runId, ok: !failed, errorCode: failed ? 'agent-error' : '' });
      noteRun(runtime, {
        root,
        node,
        state: failed ? 'error' : 'done',
        since,
        finishedAt: Date.now(),
        childId: activation && activation.childId,
        ...finalTaskFields(),
        ...(facts || {}),
        ...(failed ? { message: output || 'агент завершился с ошибкой' } : {}),
      });
      /* Прогон закрылся успешно — провалившийся ревьюер квитанцию не выписывает. */
      if (!failed) writeReceipt();
    },
    (error) => {
      settledLaunch(runtime, { root, runId, ok: false, errorCode: (error && error.code) || 'activation-error' });
      noteRun(runtime, {
        root,
        node,
        state: 'error',
        since,
        finishedAt: Date.now(),
        childId: activation && activation.childId,
        ...finalTaskFields(),
        ...(facts || {}),
        message: error && error.message ? error.message : String(error),
      });
    },
  );
}

export const RUN_TOOL_NAME = 'project_graph_run';

function resultText(result) {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  const parts = Array.isArray(result.output) ? result.output : [];
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    try { return JSON.stringify(part); } catch { return String(part); }
  }).join('\n');
}

function clampTimeout(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.max(Math.round(number), 1000), 30 * 60 * 1000);
}

/**
 * The waiting half of the tool pair: same route as project_graph_spawn, but
 * delivery 'caller' and an awaited result. It also records running/done/error
 * in the runtime store the panel reads through /api/activity.
 */
export function createRunTool(options) {
  const runtime = options.runtime;
  const config = isPlainObject(options.config) ? options.config : {};
  const getSubagents = options.getSubagents;
  const getAgentPresets = options.getAgentPresets;

  return {
    name: RUN_TOOL_NAME,
    description:
      'Run one agent declared in the structure/ folder and wait for its result. '
      + 'The node decides provider, model and preset; the caller gets status, output and duration. '
      + 'Use project_graph_spawn when the caller should not wait.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', description: 'Node id from structure/*.json.' },
        prompt: { type: 'string', description: 'The task for the child agent.' },
        root: { type: 'string', description: 'Absolute project root; optional when exactly one root is configured.' },
        task: { type: 'string', description: 'Task contract (docs/tasks/<id>) this run executes; refused when its executor/acceptor contradict the structure.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the child, 1s..30min. Default 10min.' },
      },
      required: ['node', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: { type: 'string' },
          childId: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'error', 'timeout'] },
          output: { type: 'string' },
          error: { type: 'string' },
          stopReason: { type: 'string' },
          durationMs: { type: 'number' },
          provider: { type: 'string' },
          model: { type: 'string' },
          preset: { type: 'string' },
        },
        required: ['node', 'status', 'provider', 'model'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.node + ' ' + value.status + ' in ' + value.durationMs + 'ms on '
          + value.provider + '/' + value.model
          + (value.preset ? ' with preset ' + value.preset : '')
          + (value.output ? ': ' + value.output : '')
          + (value.error ? ' (' + value.error + ')' : ''),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec && exec.agent;
      if (!parent) throw spawnError('no-parent', 'инструмент вызван без агента: вызовите его из сессии, у которой есть родитель');
      const subagents = typeof getSubagents === 'function' ? getSubagents() : null;
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw spawnError('spawn-unavailable', 'служба ctx.subagents не подключена: проверьте, что в DSH загружен плагин subagent');
      }
      const providerName = typeof config.provider === 'string' && config.provider.trim()
        ? config.provider.trim()
        : DEFAULT_PROVIDER;
      const provider = subagents.getProvider ? subagents.getProvider(providerName) : undefined;
      if (!provider) {
        throw spawnError('spawn-unavailable', 'провайдер «' + providerName + '» не зарегистрирован: проверьте, что в DSH подключён subagent-spawn-in-process');
      }
      if (!provider.capabilities || provider.capabilities.agentOptions !== true) {
        throw spawnError('spawn-unavailable',
          'провайдер «' + providerName + '» не умеет agentOptions: нужен локальный провайдер spawn, иначе модель узла не передать');
      }
      const rootSelection = resolveRoot(runtime, args && args.root);
      if (!rootSelection.ok) throw spawnError(rootSelection.code, rootSelection.message);
      const payload = readGraph(runtime, rootSelection.root);
      if (payload.errors.length > 0) {
        const first = payload.errors[0];
        throw spawnError('structure-invalid',
          'структура недействительна: ' + first.message + (first.fix ? ' Что сделать: ' + first.fix : ''));
      }
      /*
       * A task contract is checked against the structure before any work starts:
       * the graph decides who accepts whose result, so a contract that names a
       * different acceptor is a bypass and is refused here, not noticed later.
       */
      const taskArg = args && typeof args.task === 'string' ? args.task.trim() : '';
      /* 0179: мета задания нужна и гейту, и фактам записи — читается один раз. */
      let taskFile = '';
      let taskMeta = null;
      if (taskArg) {
        const taskRoot = path.resolve(rootSelection.root);
        taskFile = path.resolve(taskRoot, taskArg);
        if (taskFile !== taskRoot && !taskFile.startsWith(taskRoot + path.sep)) {
          throw spawnError('task-outside-root', 'задание должно лежать внутри корня проекта: ' + taskArg);
        }
        const problems = validateTaskFile(payload.graph, taskFile);
        if (problems.length > 0) {
          throw spawnError('task-contradicts-structure',
            'контракт задания противоречит структуре: ' + problems.join('; ')
            + '. Исправьте acceptor в задании или связь в structure/*.json — обходить структуру нельзя.');
        }
        /*
         * 0177: project_graph_run тоже активирует агента, поэтому аудитор-гейт
         * стоит и здесь: иначе запуск «в обход спавна» проходил бы без вердикта.
         */
        let runTaskText = '';
        try {
          runTaskText = fs.readFileSync(taskFile, 'utf8');
        } catch {
          runTaskText = '';
        }
        taskMeta = parseTaskMeta(runTaskText);
        /*
         * 0198 (review R1): project_graph_run — такая же активация узла, поэтому
         * ревью-гейт стоит и здесь, до startActivation. Иначе ожидающий запуск
         * приёмщика с заданием обходил бы квитанцию: review.json мог написать
         * координатор, а review.receipt.json никто не проверял.
         */
        const reviewProblem = reviewGateProblem(taskMeta, payload.graph, args && args.node, taskRoot, taskFile);
        if (reviewProblem) {
          const receiptRefusal = reviewProblem.includes('review-receipt:');
          throw spawnError(receiptRefusal ? 'review-receipt-required' : 'review-required', reviewProblem);
        }
        /* 0186: ожидающий запуск идёт через тот же якорный гейт, что и спавн. */
        const anchorNodes = anchorNodesOf(runtime, taskRoot);
        const anchorsRefusal = anchorsGateRefusal(anchorNodes, taskRoot);
        if (anchorsRefusal) throw spawnError(anchorsRefusal.code, anchorsRefusal.problem);
        const auditProblem = auditGateProblem(taskMeta, payload.graph, taskRoot, taskFile,
          auditorConsumesOf(payload.graph, anchorNodes));
        if (auditProblem) throw spawnError('audit-required', auditProblem);
      }
      /*
       * Каталог проверяется в плане, до старта: неизвестный провайдер или модель
       * отказывают с именами, а не всплывают падением уже запущенного агента.
       * Недоступная служба llm каталога не даёт — план работает как раньше.
       */
      const plan = resolveNodePlan(payload.graph, args && args.node, { catalog: await readSpawnCatalog(runtime) });
      if (!plan.ok) throw spawnError(plan.code, plan.message);

      /* 0179: предмет запуска — как у спавна: task/object/report, у приёмщика verdict. */
      const taskFields = taskRunFields(rootSelection.root, payload.graph, taskMeta, taskFile, plan.node);
      const refreshTaskFields = () => {
        try {
          return taskRunFields(rootSelection.root, payload.graph, taskMeta, taskFile, plan.node) || taskFields || {};
        } catch {
          return taskFields || {};
        }
      };

      if (plan.preset) {
        if (!provider.capabilities || provider.capabilities.agentPreset !== true) {
          throw spawnError('spawn-unavailable',
            'провайдер «' + providerName + '» не умеет agentPreset: пресет узла не передать');
        }
        const presets = typeof getAgentPresets === 'function' ? getAgentPresets() : null;
        if (!presets || typeof presets.resolve !== 'function') {
          throw spawnError('preset-unavailable',
            'узел «' + plan.node + '» требует пресет «' + plan.preset + '», но служба agentPresets не подключена');
        }
        try {
          const resolved = await presets.resolve(plan.preset);
          if (resolved && resolved.broken) {
            throw spawnError('preset-broken',
              'пресет «' + plan.preset + '» у узла «' + plan.node + '» не активируется: '
                + (typeof resolved.broken === 'string' ? resolved.broken : JSON.stringify(resolved.broken)));
          }
        } catch (error) {
          if (error && (error.code === 'preset-broken' || error.code === 'preset-unavailable' || error.code === 'unknown-preset')) throw error;
          throw spawnError('unknown-preset',
            'пресета «' + plan.preset + '» нет в DSH. Исправьте agentPreset в structure/*.json или объявите пресет.');
        }
      }

      /*
       * 0197: та же дисциплина обмена, что у спавна. project_graph_run тоже
       * активирует агента, поэтому незакрытый report-результат предыдущего
       * планового прогона запрещает запуск и здесь: отказ edge-obligation,
       * error-запись, startActivation не вызывается.
       */
      const gateErrors = edgeGateErrors(runtime, rootSelection.root, payload.graph, plan.node);
      if (gateErrors.length > 0) {
        const gateBranchId = exec && typeof exec.branchId === 'string' ? exec.branchId : undefined;
        noteRun(runtime, {
          root: rootSelection.root,
          node: plan.node,
          state: 'error',
          since: nextSince(),
          finishedAt: Date.now(),
          ...(taskFields || {}),
          ...(gateBranchId ? { branchId: gateBranchId } : {}),
          message: 'edge-obligation: ' + gateErrors.join('; '),
        });
        throw spawnError('edge-obligation',
          gateErrors.map((line) => line.replace(/^edge-obligation:\s*/u, '')).join('; '));
      }

      /*
       * 0136: та же дисциплина узла, что и у спавна. Ожидающий вызов не умеет
       * ждать очередь (у queued задачи нет сессии, а run обязан вернуть
       * результат), поэтому при режиме queue занятость — отказ с советом.
       */
      checkNodeConcurrency(runtime, rootSelection.root, plan, { via: 'run' });

      let maxDepth;
      if (typeof subagents.resolveMaxDepth === 'function') {
        maxDepth = subagents.resolveMaxDepth(config.maxDepth === undefined ? DEFAULT_MAX_DEPTH : config.maxDepth);
      }
      const runId = newRunId();
      const request = {
        /*
         * The child works in the workspace that declares the node, not in the
         * caller's directory: otherwise a structure of project B started from a
         * session of project A would read and write A's files while claiming to
         * run B's node.
         */
        cwd: rootSelection.root,
        prompt: promptWithRunId(String(args.prompt), runId, plan),
        parent,
        agentOptions: { provider: plan.provider, model: plan.model },
        ...(plan.preset ? { agentPreset: plan.preset } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      };
      const since = nextSince();
      /* A branch tags every step, so the panel can group them later. */
      const branchId = exec && typeof exec.branchId === 'string' ? exec.branchId : undefined;
      const note = (fields) => {
        const row = { ...(taskFields || {}), ...fields };
        return noteRun(runtime, branchId ? { ...row, branchId } : row);
      };
      note({ root: rootSelection.root, node: plan.node, state: 'running', since, childId: undefined });
      let activation;
      try {
        activation = await subagents.startActivation({
          provider: providerName,
          label: (plan.role ? plan.role + ': ' : '') + plan.node,
          request,
          signal: exec.signal,
          delivery: 'caller',
        });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        /* Активация не вернула childId: started пустой, settled — отказ (0101). */
        startedLaunch(runtime, {
          root: rootSelection.root,
          runId,
          ...launchTaskFields(taskFields, taskArg),
          node: plan.node,
          childId: '',
          provider: plan.provider,
          model: plan.model,
        });
        settledLaunch(runtime, {
          root: rootSelection.root,
          runId,
          ok: false,
          errorCode: (error && error.code) || 'activation-error',
        });
        note({ root: rootSelection.root, node: plan.node, state: 'error', since, finishedAt: Date.now(), message });
        throw error;
      }
      /*
       * started с childId — сразу после активации, до ожидания результата:
       * append-only строку нельзя переписать, а контроль C1 требует session id.
       */
      startedLaunch(runtime, {
        root: rootSelection.root,
        runId,
        ...launchTaskFields(taskFields, taskArg),
        node: plan.node,
        childId: activation && activation.childId,
        provider: plan.provider,
        model: plan.model,
      });
      note({ root: rootSelection.root, node: plan.node, state: 'running', since, childId: activation && activation.childId });
      const timeoutMs = clampTimeout(args && args.timeoutMs, clampTimeout(config.runTimeoutMs, 10 * 60 * 1000));
      const marker = { timeout: true };
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(marker), timeoutMs); });
      try {
        const settled = await Promise.race([
          activation && activation.result ? activation.result : Promise.resolve({ output: [], stopReason: 'error' }),
          timeout,
        ]);
        if (settled === marker) {
          try { await activation.dispose(); } catch { /* cancellation is best effort */ }
          settledLaunch(runtime, { root: rootSelection.root, runId, ok: false, errorCode: 'timeout' });
          note({ root: rootSelection.root, node: plan.node, state: 'error', since, finishedAt: Date.now(), childId: activation && activation.childId, ...refreshTaskFields(), message: 'истекло ожидание ' + timeoutMs + ' мс' });
          return {
            node: plan.node,
            childId: activation && activation.childId,
            status: 'timeout',
            error: 'истекло ожидание ' + timeoutMs + ' мс',
            durationMs: Date.now() - since,
            provider: plan.provider,
            model: plan.model,
            ...(plan.preset ? { preset: plan.preset } : {}),
          };
        }
        const output = resultText(settled);
        const failed = Boolean(settled && settled.stopReason === 'error');
        settledLaunch(runtime, { root: rootSelection.root, runId, ok: !failed, errorCode: failed ? 'agent-error' : '' });
        note({
          root: rootSelection.root,
          node: plan.node,
          state: failed ? 'error' : 'done',
          since,
          finishedAt: Date.now(),
          childId: activation && activation.childId,
          ...refreshTaskFields(),
          ...(failed ? { message: output || 'агент завершился с ошибкой' } : {}),
        });
        return {
          node: plan.node,
          childId: activation && activation.childId,
          status: failed ? 'error' : 'ok',
          ...(output ? { output } : {}),
          ...(failed ? { error: output || 'агент завершился с ошибкой' } : {}),
          ...(settled && settled.stopReason ? { stopReason: String(settled.stopReason) } : {}),
          durationMs: Date.now() - since,
          provider: plan.provider,
          model: plan.model,
          ...(plan.preset ? { preset: plan.preset } : {}),
        };
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        settledLaunch(runtime, { root: rootSelection.root, runId, ok: false, errorCode: (error && error.code) || 'run-error' });
        note({ root: rootSelection.root, node: plan.node, state: 'error', since, finishedAt: Date.now(), childId: activation && activation.childId, ...refreshTaskFields(), message });
        return {
          node: plan.node,
          childId: activation && activation.childId,
          status: 'error',
          error: message,
          durationMs: Date.now() - since,
          provider: plan.provider,
          model: plan.model,
          ...(plan.preset ? { preset: plan.preset } : {}),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function registerRunTool(ctx, runtime, config) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error(RUN_TOOL_NAME + ': tools service is not available');
  }
  return ctx.tools.register(createRunTool({
    runtime,
    config,
    getSubagents: () => ctx.subagents,
    getAgentPresets: () => {
      try { return ctx.get ? ctx.get('agentPresets') : null; } catch { return null; }
    },
  }));
}

/** Register the tool on a context that already carries `tools` and `subagents`. */
export function registerSpawnTool(ctx, runtime, config, hooks = {}) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error(SPAWN_TOOL_NAME + ': tools service is not available');
  }
  const definition = createSpawnTool({
    runtime,
    config,
    getSubagents: () => ctx.subagents,
    getAgentPresets: () => {
      try {
        return ctx.get ? ctx.get('agentPresets') : null;
      } catch {
        return null;
      }
    },
    /* 0139: известные провайдеры рантайма; хост без llm передаёт undefined. */
    getKnownProviders: hooks.getKnownProviders,
    /*
     * 0138: проба фактического cwd ребёнка. Не передана — createSpawnTool берёт
     * умолчание (readSessionCwd), поэтому хост без кэша сессий не ломается.
     */
    probeCwd: hooks.probeCwd,
    /*
     * 0142: создание служебной сессии в корне узла. Не передано — известный
     * чужой cwd родителя даёт честный отказ root-mismatch (0138).
     */
    createAgent: hooks.createAgent,
    /*
     * 0161: предусловие запуска — валидатор структуры. lib/index.js передаёт
     * хук с настройками (forceModelCheck, knownProviders); хост без него
     * работает как раньше.
     */
    validateStructure: hooks.validateStructure,
  });
  return ctx.tools.register(definition);
}