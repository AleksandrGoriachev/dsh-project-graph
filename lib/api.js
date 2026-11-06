/**
 * HTTP half: loopback-only routes for the structure panel — GET reads and the
 * few POST writes limited to the structure folder (starter, links, node, layout,
 * build).
 *
 * The handler is a pure wiring function — mock request/response objects work in
 * tests, so every route is exercised without a DSH host. Nothing is read or
 * written outside the allowed project roots.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGraph, layoutGraph, summarizeGraph, GRAPH_VERSION, EDGE_KINDS, NODE_ID, FOLDER_REMEDIES, PROMPT_REMEDY } from './graph.js';
import { readStructure } from './load.js';
import { resolveStructure } from './store.js';
import { ensureCriticSpec, isCriticNode } from './critic-spec.js';
import { fetchRelease, isOutdated, releaseStatus } from './release.js';
import { exchangeDirs, readExchange } from './exchange.js';
/*
 * Ящик разрешает lib/boxes.js — один резолвер для панели, CLI, обязанностей и
 * сторожа (задание 0078). Остальные помощники обмена живут в exchange-watch; два
 * модуля импортируют друг друга, и это безопасно: exchange-watch читает граф
 * только во время работы, никогда при загрузке.
 */
import { commonParent, resolveBox } from './boxes.js';
import {
  declaredExchangeWorkspaces, messageFiles, nextLetterNumber, normalizeSession, readExchangeFolders,
} from './exchange-watch.js';
import { listRuns } from './runs.js';
import { scheduleForGraph } from './schedule.js';
import {
  attributeSessions, bindSessions, mapLiveAgents, mapNodeActivity, mapRunActivity, readSessionActivity,
} from './live.js';
import { validateReport, projectBox } from './report-evidence.js';
/*
 * Журнал альтернативного пути читается тем же роутером, что и структура: он
 * лежит в хранилище проекта (lib/store.js), а не в репозитории. Импорт не создаёт
 * цикла: structure-policy знает только graph/load/store.
 */
import { readAlternatives, readStructurePolicy } from './structure-policy.js';
/*
 * Обязанности структуры (задание 0075) читаются тем же роутером: модуль берёт
 * объявление через lib/store.js, поэтому работает и для репозитория, и для
 * внешнего хранилища, и не тянет за собой рантайм хоста.
 */
import { evaluateObligations, exchangeAttention, markExchangeSeen, scanExchange } from './obligations.js';

/**
 * Monotonic part of a temporary file name: two writes in one process must not
 * even theoretically pick the same temp file, whatever Math.random returns.
 */
let atomicWriteCounter = 0;

/** Synchronous pause for a rename retry: the write path is synchronous by design. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait where Atomics is unavailable */ }
  }
}

/**
 * Write a file through a unique temporary sibling and a rename.
 *
 * Parallel writes to one structure file used to collide on a temp name built
 * from pid + random only, and the loser surfaced as EEXIST/EPERM (500 on
 * /api/layout and /api/session). The name now carries pid, a process-local
 * counter and randomness, and a rename that loses a race is retried instead of
 * failing the request. On any failure the temp file is removed, so a refusal
 * never leaves litter in the structure folder.
 *
 * @param target - absolute or relative file to replace.
 * @param text - complete new contents.
 * @returns the resolved absolute path written.
 */
export function writeFileAtomic(target, text) {
  const absolute = path.resolve(String(target));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  atomicWriteCounter += 1;
  const temp = path.join(
    path.dirname(absolute),
    '.' + path.basename(absolute) + '.tmp-' + process.pid + '-' + atomicWriteCounter + '-'
      + Math.random().toString(36).slice(2, 10),
  );
  try {
    fs.writeFileSync(temp, text, 'utf8');
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the write error is what matters */ }
    throw error;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, absolute);
      return absolute;
    } catch (error) {
      const code = error && error.code;
      const retryable = code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!retryable || attempt >= 40) {
        try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
        throw error;
      }
      sleepSync(Math.min(2 + attempt * 2, 25));
    }
  }
}

/**
 * What to do about a problem, in one sentence with an action.
 *
 * Every error and warning carries a remedy: a code alone tells a person what a
 * machine calls the problem, not what to change. The panel and the tool both
 * render this next to the message.
 */
export const REMEDIES = {
  'no-structure-folder': 'Создайте папку structure/ и файл structure/graph.json в корне проекта.',
  'no-fragments': 'Положите в structure/ хотя бы один файл *.json — каждый файл считается фрагментом структуры.',
  'invalid-json': 'Откройте файл и исправьте JSON: кавычки, запятые, никаких комментариев.',
  'invalid-fragment': 'Сделайте содержимым файла JSON-объект { … }, а не массив или строку.',
  'unsupported-version': 'Поставьте "version": 1 или удалите поле version.',
  'invalid-models': 'Опишите модели объектом «алиас -> { provider, model }».',
  'invalid-model-alias': 'Дайте алиасу непустое имя, например "work".',
  'invalid-model': 'У модели должны быть непустые provider и model, например opencode и deepseek-v4.1-flash.',
  'invalid-nodes': 'Сделайте nodes массивом узлов: [ { "id": "…" } ].',
  'invalid-node': 'Опишите узел объектом с полем id.',
  'invalid-node-id': 'Используйте в id латиницу, цифры, точку, дефис или подчёркивание, без пробелов.',
  'duplicate-node': 'Оставьте один узел с таким id: объедините фрагменты или переименуйте.',
  'unknown-model': 'Укажите provider и model прямо в узле: provider — из каталога DSH, model — id модели.',
  'model-conflict': 'Сведите объявление алиаса к одному provider/model во всех фрагментах.',
  'unknown-edge-endpoint': 'Создайте узел с таким id или исправьте from/to у связи.',
  'self-loop': 'Уберите связь узла с самим собой.',
  'unknown-edge-kind': 'Поставьте kind: delegate, review или peer.',
  'delegate-cycle': 'Разорьте цикл: связи delegate должны идти в одну сторону, без возврата.',
  'same-family': 'Дайте одному из узлов модель другого семейства или уберите mustDifferFrom.',
  'empty-graph': 'Добавьте в structure/*.json хотя бы один узел.',
  'invalid-must-differ': 'Сделайте mustDifferFrom массивом id узлов.',
  'invalid-agent-preset': 'Укажите agentPreset непустой строкой — id пресета из DSH, например "standard".',
  'invalid-position': 'Задайте у узла x и y вместе, целыми числами ≥ 0 — это пиксели канвы, например x: 240, y: 40; или уберите обе координаты.',
  'invalid-schedule': 'Опишите расписание объектом { "at": "09:00", "timeZone": "Europe/Moscow" } или уберите schedule.',
  'invalid-schedule-at': 'Поставьте schedule.at строго в HH:MM, например "09:00"; часы 00–23, минуты 00–59.',
  'invalid-schedule-timezone': 'Укажите schedule.timeZone поясом из Intl, например "Europe/Moscow".',
  'invalid-edges': 'Сделайте edges массивом связей: [ { "from": "…", "to": "…" } ].',
  'invalid-edge': 'У связи должны быть непустые from и to — id существующих узлов.',
  'unknown-node': 'Исправьте id в mustDifferFrom: такого узла нет в структуре.',
  'read-problem': 'Проверьте, что файл существует, доступен на чтение и сохранён в UTF-8.',
  'no-model': 'Укажите nodes[].model — иначе агента по узлу запустить нельзя.',
  'no-role': 'Добавьте nodes[].role, чтобы было понятно, чем узел отличается от соседей.',
  'no-prompt': PROMPT_REMEDY,
  'isolated-node': 'Свяжите узел с другими: добавьте ребро delegate, review или peer.',
  'no-delegate-edges': 'Добавьте хотя бы одну связь delegate, если работа идёт сверху вниз; для равных достаточно peer.',
  'duplicate-edge': 'Удалите повторную связь: один вид связи между парой узлов достаточно объявить один раз.',
  'uncomparable-difference': 'Задайте модели обоим узлам из mustDifferFrom, иначе различие семейств не проверить.',
  /* Папки обмена — не узлы: рецепты живут в модели, панель повторяет их слово в слово. */
  ...FOLDER_REMEDIES,
};

/** Remedy for a stable problem code, or a neutral action when the code is new. */
/**
 * The starter structure `POST /api/init` writes on an explicit click.
 *
 * It is a valid three-node graph, not a placeholder: coordinator delegates to a
 * worker, the worker's result is reviewed by a judge on another model family.
 * The panel never edits or overwrites an existing structure; this file is only
 * created when the project has no fragments at all.
 */
export const STARTER_GRAPH = {
  version: 1,
  models: {
    work: { provider: 'opencode', model: 'deepseek-v4.1-flash' },
    critic: { provider: 'opencode', model: 'glm-5.3-flash', family: 'zhipu' },
  },
  nodes: [
    { id: 'coordinator', role: 'координатор', model: 'work', brief: 'ведёт план и раздаёт работу',
      prompt: 'Роль: координатор — ведёт план, раздаёт задания и собирает результат. Definition of Done: план записан, у заданий есть исполнители, итог проверен и возвращён заказчику.' },
    { id: 'worker', role: 'исполнитель', model: 'work', brief: 'делает основную работу',
      prompt: 'Роль: исполнитель — делает основную работу по заданию. Definition of Done: результат собран, тесты пройдены, в отчёте названы файлы, команды и отклонения.' },
    { id: 'judge', role: 'приёмщик', model: 'critic', brief: 'проверяет работу отдельной сессией', mustDifferFrom: ['worker'],
      prompt: 'Роль: приёмщик — проверяет работу отдельной сессией. Definition of Done: вердикт принято или отклонено, замечания подкреплены доказательствами, чужой код не правится.' },
  ],
  edges: [
    { from: 'coordinator', to: 'worker', kind: 'delegate' },
    { from: 'worker', to: 'judge', kind: 'review' },
  ],
};

/**
 * The peer starter: equal members, no coordinator and no direction. Every edge
 * is `peer`; the validator allows cycles there by design.
 */
export const PEER_STARTER_GRAPH = {
  version: 1,
  models: {
    work: { provider: 'opencode', model: 'deepseek-v4.1-flash' },
    critic: { provider: 'opencode', model: 'glm-5.3-flash', family: 'zhipu' },
  },
  nodes: [
    { id: 'analyst', role: 'аналитик', model: 'work', brief: 'разбирает требования и проверяет факты',
      prompt: 'Роль: аналитик — разбирает требования и проверяет факты. Definition of Done: требования сформулированы, факты подтверждены источниками, спорные места названы явно.' },
    { id: 'developer', role: 'разработчик', model: 'work', brief: 'делает основную работу',
      prompt: 'Роль: разработчик — делает основную работу по общему плану. Definition of Done: код собран, тесты пройдены, отчёт называет файлы, команды и отклонения.' },
    { id: 'designer', role: 'дизайнер', model: 'critic', brief: 'отвечает за интерфейс и подачу',
      prompt: 'Роль: дизайнер — отвечает за интерфейс и подачу. Definition of Done: макеты соответствуют брифу, исходники и превью приложены, отклонения названы.' },
  ],
  edges: [
    { from: 'analyst', to: 'developer', kind: 'peer' },
    { from: 'analyst', to: 'designer', kind: 'peer' },
    { from: 'developer', to: 'designer', kind: 'peer' },
  ],
};

/**
 * The mixed starter: both shapes in one graph. Delegation gives the hierarchy
 * (two leads under a coordinator), peers make the leads equal, and reviews send
 * both results to a judge on another model family.
 */
export const MIXED_STARTER_GRAPH = {
  version: 1,
  models: {
    work: { provider: 'opencode', model: 'deepseek-v4.1-flash' },
    critic: { provider: 'opencode', model: 'glm-5.3-flash', family: 'zhipu' },
  },
  nodes: [
    { id: 'coordinator', role: 'координатор', model: 'work', brief: 'ведёт план и раздаёт работу',
      prompt: 'Роль: координатор — ведёт план, раздаёт задания и собирает результат. Definition of Done: план записан, у заданий есть исполнители, итог проверен и возвращён заказчику.' },
    { id: 'lead-code', role: 'lead', model: 'work', brief: 'координирует программистов',
      prompt: 'Роль: ведущий программист — координирует программистов и держит план кода. Definition of Done: задачи распределены, код собран и проверен, итог передан приёмщику.' },
    { id: 'lead-design', role: 'lead', model: 'work', brief: 'координирует дизайнеров',
      prompt: 'Роль: ведущий дизайнер — координирует дизайнеров и держит подачу. Definition of Done: макеты готовы, исходники приложены, итог передан приёмщику.' },
    { id: 'judge', role: 'приёмщик', model: 'critic', brief: 'проверяет работу отдельной сессией', mustDifferFrom: ['lead-code', 'lead-design'],
      prompt: 'Роль: приёмщик — проверяет работу отдельной сессией. Definition of Done: вердикт принято или отклонено, замечания подкреплены доказательствами, чужой код не правится.' },
  ],
  edges: [
    { from: 'coordinator', to: 'lead-code', kind: 'delegate' },
    { from: 'coordinator', to: 'lead-design', kind: 'delegate' },
    { from: 'lead-code', to: 'lead-design', kind: 'peer' },
    { from: 'lead-code', to: 'judge', kind: 'review' },
    { from: 'lead-design', to: 'judge', kind: 'review' },
  ],
};

/**
 * The team starter: a hierarchy with no evaluator. Delegation only, no review
 * edge, so the graph shows who hands work down without a judge.
 */
export const TEAM_STARTER_GRAPH = {
  version: 1,
  models: {
    work: { provider: 'opencode', model: 'deepseek-v4.1-flash' },
  },
  nodes: [
    { id: 'coordinator', role: 'координатор', model: 'work', brief: 'ведёт план и раздаёт работу',
      prompt: 'Роль: координатор — ведёт план, раздаёт задания и собирает результат. Definition of Done: план записан, у заданий есть исполнители, итог проверен и возвращён заказчику.' },
    { id: 'lead-code', role: 'lead', model: 'work', brief: 'координирует программистов',
      prompt: 'Роль: ведущий программист — координирует программистов и держит план кода. Definition of Done: задачи распределены, код собран и проверен, итог передан приёмщику.' },
    { id: 'dev-code', role: 'developer', model: 'work', brief: 'делает работу по коду',
      prompt: 'Роль: разработчик — делает работу по коду в своей ветке. Definition of Done: код собран, тесты пройдены, отчёт называет файлы и команды.' },
    { id: 'lead-design', role: 'lead', model: 'work', brief: 'координирует дизайнеров',
      prompt: 'Роль: ведущий дизайнер — координирует дизайнеров и держит подачу. Definition of Done: макеты готовы, исходники приложены, итог передан приёмщику.' },
    { id: 'designer', role: 'designer', model: 'work', brief: 'делает дизайн',
      prompt: 'Роль: дизайнер — отвечает за интерфейс и подачу. Definition of Done: макеты соответствуют брифу, исходники и превью приложены, отклонения названы.' },
  ],
  edges: [
    { from: 'coordinator', to: 'lead-code', kind: 'delegate' },
    { from: 'coordinator', to: 'lead-design', kind: 'delegate' },
    { from: 'lead-code', to: 'dev-code', kind: 'delegate' },
    { from: 'lead-design', to: 'designer', kind: 'delegate' },
  ],
};

/** The templates `POST /api/init` can write, keyed by the request's template. */
export const STARTER_TEMPLATES = {
  hierarchy: STARTER_GRAPH,
  peer: PEER_STARTER_GRAPH,
  mixed: MIXED_STARTER_GRAPH,
  team: TEAM_STARTER_GRAPH,
};

/**
 * Create the starter structure in a project that has none.
 *
 * @returns { ok: true, created } or { ok: false, status, error, fix }.
 *   Nothing is overwritten: an existing fragment, or a file racing us to the
 *   same name, is refused with 409.
 */
export function createStarterStructure(runtime, root, template = 'hierarchy') {
  const graph = STARTER_TEMPLATES[template];
  if (!graph) {
    return {
      ok: false,
      status: 400,
      error: 'неизвестный шаблон структуры: ' + template,
      fix: 'Доступны hierarchy (иерархическая), peer (одноранговая), mixed (смешанная) и team (без оценщика).',
    };
  }
  /*
   * The starter goes where the structure of this project lives: the repository
   * for a legacy project, the external store for a fresh one. In store mode the
   * repository must stay untouched — that is the whole point of the change.
   */
  const target = resolveStructure(root, runtime.structureDir);
  const legacy = target.mode === 'repo';
  const logical = runtime.structureDir + '/graph.json';
  const place = legacy ? runtime.structureDir + '/' : target.dir;
  let read;
  try {
    read = readStructure(root, runtime.structureDir);
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: 'не удалось прочитать папку структуры: ' + (error && error.message ? error.message : 'ошибка'),
      fix: 'Проверьте права на папку проекта и нажмите «Создать структуру» ещё раз.',
    };
  }
  if (read.count > 0) {
    return {
      ok: false,
      status: 409,
      error: 'в проекте уже есть структура (' + read.count + ' файлов)',
      fix: 'Панель не перезаписывает существующую структуру: откройте её или удалите файлы вручную, если хотите начать заново.',
    };
  }
  const dir = target.dir;
  const file = target.graphFile;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: 'не удалось создать папку ' + place + ': ' + (error && error.message ? error.message : 'ошибка'),
      fix: legacy
        ? 'Проверьте, что путь не занят файлом и у процесса есть право записи в корень проекта.'
        : 'Проверьте, что каталог хранилища доступен для записи и не занят файлом.',
    };
  }
  try {
    fs.writeFileSync(file, JSON.stringify(graph, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return {
        ok: false,
        status: 409,
        error: 'файл ' + (legacy ? logical : file) + ' уже существует',
        fix: 'Панель не перезаписывает файлы: откройте структуру или удалите файл вручную.',
      };
    }
    return {
      ok: false,
      status: 500,
      error: 'не удалось записать ' + (legacy ? logical : file) + ': ' + (error && error.message ? error.message : 'ошибка'),
      fix: legacy
        ? 'Проверьте права на запись в корень проекта и повторите.'
        : 'Проверьте права на каталог хранилища и повторите.',
    };
  }
  /* `created` names the real file: the panel opens it and the checks look there. */
  return { ok: true, created: legacy ? logical : file, template, mode: target.mode };
}

/**
 * Add or remove one edge in the structure file that owns it.
 *
 * The panel writes only edges: nodes, roles, models and fragments stay hand-made.
 * An edge inside one fragment goes to that fragment; an edge between fragments
 * goes to `<structureDir>/links.json`. Every write is validated by re-reading
 * the whole structure and rolled back if it introduces an error (a delegate
 * cycle, a duplicate, a broken reference).
 */
export function editLink(runtime, root, query) {
  const action = String(query.action || '');
  const from = String(query.from || '').trim();
  const to = String(query.to || '').trim();
  const kind = String(query.kind || '').trim();
  if (action !== 'add' && action !== 'remove') {
    return { status: 400, error: 'действие связи должно быть add или remove', fix: 'Передайте action=add или action=remove.' };
  }
  if (!from || !to) {
    return { status: 400, error: 'нужны from и to — id узлов', fix: 'Выберите узел-источник и узел-цель.' };
  }
  if (from === to) {
    return { status: 400, error: 'узел не может быть связан сам с собой', fix: 'Выберите другой узел.' };
  }
  if (action === 'add' && !EDGE_KINDS.includes(kind)) {
    return { status: 400, error: 'неизвестный вид связи: ' + kind, fix: 'Доступны delegate, review и peer.' };
  }
  const before = readGraph(runtime, root);
  if (before.errors.length > 0) {
    const first = before.errors[0];
    return {
      status: 409,
      error: 'структура уже недействительна: ' + first.message,
      fix: first.fix || 'Сначала исправьте ошибки структуры.',
    };
  }
  const nodes = new Map(before.graph.nodes.map((node) => [node.id, node]));
  const fromNode = nodes.get(from);
  const toNode = nodes.get(to);
  if (!fromNode || !toNode) {
    return {
      status: 404,
      error: 'узла «' + (!fromNode ? from : to) + '» нет в структуре',
      fix: 'Выберите узлы из списка — панель не создаёт узлы.',
    };
  }
  const edge = { from, to, kind };
  let relative;
  let original = null;
  if (action === 'add') {
    if (before.graph.edges.some((item) => item.from === from && item.to === to && item.kind === kind)) {
      return { status: 409, error: 'такая связь уже объявлена', fix: 'Выберите другой вид связи или другой узел.' };
    }
    relative = fromNode.file === toNode.file ? fromNode.file : runtime.structureDir + '/links.json';
  } else {
    const existing = before.graph.edges.find((item) => item.from === from && item.to === to && item.kind === kind);
    if (!existing) {
      return { status: 404, error: 'такой связи нет в структуре', fix: 'Обновите панель: возможно, связь уже удалена.' };
    }
    relative = existing.file;
  }
  const absolute = resolveStructureFile(root, runtime, relative);
  if (!absolute) {
    return { status: 400, error: 'файл связи вне папки структуры: ' + relative, fix: 'Проверьте structure/*.json.' };
  }
  try {
    original = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
    const document = original === null ? { version: 1, edges: [] } : JSON.parse(original);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return { status: 409, error: 'файл ' + relative + ' — не JSON-объект', fix: 'Исправьте файл вручную.' };
    }
    const edges = Array.isArray(document.edges) ? document.edges : [];
    if (action === 'add') {
      document.edges = edges.concat([edge]);
    } else {
      document.edges = edges.filter((item) => !(item && item.from === from && item.to === to && item.kind === kind));
      if (document.edges.length === edges.length) {
        return { status: 404, error: 'связь не найдена в файле ' + relative, fix: 'Обновите панель.' };
      }
    }
    fs.writeFileSync(absolute, JSON.stringify(document, null, 2) + '\n', 'utf8');
  } catch (error) {
    if (original !== null) {
      try { fs.writeFileSync(absolute, original, 'utf8'); } catch { /* the message below is enough */ }
    }
    return { status: 500, error: 'не удалось записать связь: ' + (error && error.message ? error.message : 'ошибка'), fix: 'Проверьте права на файл структуры.' };
  }
  const after = readGraph(runtime, root);
  if (after.errors.length > 0) {
    try { if (original === null) fs.rmSync(absolute, { force: true }); else fs.writeFileSync(absolute, original, 'utf8'); } catch { /* ignore rollback failure */ }
    const first = after.errors[0];
    return {
      status: 409,
      error: first.message,
      fix: first.fix || 'Такая связь нарушает правила структуры; изменение отменено.',
    };
  }
  return { status: 200, ok: true, file: relative, action };
}

/**
 * Save the canvas layout: x/y of nodes, or a reset that removes them.
 *
 * Positions live next to their node declaration, in the same fragment that
 * declares it, so a structure split over several files stays one graph. A node
 * of structure/graph.json therefore gets x/y in structure/graph.json; a node of
 * structure/teams/code.json gets them there — a coordinate written into another
 * file would not belong to any node.
 *
 * Validation is the whole point of the route: coordinates are integers ≥ 0, node
 * ids must exist, and the request's root must be one the panel may write. Every
 * file is written through a temp file and renamed, so a crash never leaves half
 * a JSON document on disk.
 *
 * @returns { status, ... }: 200 with the files touched, or 400/404/500 with an
 *   error and the one action that fixes it.
 */
export function saveLayout(runtime, root, body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!input) {
    return {
      status: 400,
      error: 'тело раскладки должно быть JSON-объектом',
      fix: 'Передайте { root, positions: { nodeId: { x, y } } } — или { root, reset: true } для сброса.',
    };
  }
  if (input.reset !== undefined && typeof input.reset !== 'boolean') {
    return { status: 400, error: 'reset должен быть true или false', fix: 'Передайте { root, reset: true } без positions.' };
  }
  const reset = input.reset === true;
  const hasPositions = input.positions !== undefined && input.positions !== null;
  if (reset && hasPositions) {
    return {
      status: 400,
      error: 'нельзя одновременно сохранить позиции и сбросить раскладку',
      fix: 'Передайте либо { root, positions: { … } }, либо { root, reset: true }.',
    };
  }
  if (!reset && !hasPositions) {
    return {
      status: 400,
      error: 'нечего сохранять: в теле нет positions',
      fix: 'Передайте { root, positions: { nodeId: { x, y } } } с целыми x и y ≥ 0.',
    };
  }

  const payload = readGraph(runtime, root);
  if (!payload.exists) {
    return {
      status: 404,
      error: 'в проекте нет папки ' + runtime.structureDir + '/',
      fix: 'Создайте структуру, иначе сохранять раскладку некуда.',
    };
  }
  const nodeFiles = new Map(payload.graph.nodes.map((node) => [node.id, node.file]));

  const wanted = new Map();
  if (!reset) {
    if (typeof input.positions !== 'object' || Array.isArray(input.positions)) {
      return { status: 400, error: 'positions должен быть объектом «id -> {x, y}»', fix: 'Передайте { root, positions: { nodeId: { x, y } } }.' };
    }
    const entries = Object.entries(input.positions);
    if (entries.length === 0) {
      return { status: 400, error: 'в positions нет ни одного узла', fix: 'Передайте хотя бы одну позицию: { root, positions: { nodeId: { x, y } } }.' };
    }
    for (const [rawId, value] of entries) {
      const id = String(rawId || '').trim();
      if (!id) return { status: 400, error: 'пустой id узла в positions', fix: 'Укажите id узла, объявленного в структуре.' };
      if (!nodeFiles.has(id)) {
        return {
          status: 404,
          error: 'узла «' + id + '» нет в структуре',
          fix: 'Панель сохраняет раскладку только существующих узлов: обновите панель после правки структуры.',
        };
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { status: 400, error: 'позиция узла «' + id + '» должна быть объектом {x, y}', fix: 'Передайте { x: 240, y: 40 }.' };
      }
      if (!Number.isInteger(value.x) || !Number.isInteger(value.y) || value.x < 0 || value.y < 0) {
        return {
          status: 400,
          error: 'x и y узла «' + id + '» — целые числа ≥ 0',
          fix: 'Пиксели канвы: x: 8, y: 8 — допустимо, 0.5 и -8 — нет.',
        };
      }
      wanted.set(id, { x: value.x, y: value.y });
    }
  }

  const plans = [];
  const originals = new Map();
  try {
    if (reset) {
      const read = readStructure(root, runtime.structureDir);
      for (const file of read.files) {
        const absolute = resolveStructureFile(root, runtime, file.name);
        if (!absolute) continue;
        let document;
        try { document = JSON.parse(file.text); } catch { continue; }
        if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.nodes)) continue;
        let touched = 0;
        for (const node of document.nodes) {
          if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
          if (Object.hasOwn(node, 'x') || Object.hasOwn(node, 'y')) {
            delete node.x;
            delete node.y;
            touched += 1;
          }
        }
        if (touched > 0) {
          originals.set(absolute, file.text);
          plans.push({ absolute, relative: file.name, text: JSON.stringify(document, null, 2) + '\n', touched });
        }
      }
    } else {
      const byFile = new Map();
      for (const [id, value] of wanted) {
        const relative = nodeFiles.get(id);
        if (!byFile.has(relative)) byFile.set(relative, new Map());
        byFile.get(relative).set(id, value);
      }
      for (const [relative, entries] of byFile) {
        const absolute = resolveStructureFile(root, runtime, relative);
        if (!absolute) {
          return { status: 400, error: 'файл узла вне папки структуры: ' + relative, fix: 'Проверьте structure/*.json.' };
        }
        const original = fs.readFileSync(absolute, 'utf8');
        let document;
        try { document = JSON.parse(original); } catch (error) {
          return {
            status: 409,
            error: 'файл ' + relative + ' не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'),
            fix: 'Исправьте файл вручную — панель не пишет раскладку в битый файл.',
          };
        }
        if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.nodes)) {
          return { status: 409, error: 'в файле ' + relative + ' нет массива nodes', fix: 'Исправьте файл вручную.' };
        }
        let touched = 0;
        for (const node of document.nodes) {
          if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
          const position = entries.get(node.id);
          if (!position) continue;
          node.x = position.x;
          node.y = position.y;
          touched += 1;
        }
        if (touched !== entries.size) {
          return {
            status: 409,
            error: 'узел изменился во время сохранения: в ' + relative + ' нашлись не все',
            fix: 'Обновите панель и повторите: файл структуры правился параллельно.',
          };
        }
        originals.set(absolute, original);
        plans.push({ absolute, relative, text: JSON.stringify(document, null, 2) + '\n', touched });
      }
    }
  } catch (error) {
    return {
      status: 500,
      error: 'не удалось прочитать структуру для записи раскладки: ' + (error && error.message ? error.message : 'ошибка'),
      fix: 'Проверьте права на папку structure/ и повторите.',
    };
  }

  const written = [];
  try {
    for (const plan of plans) {
      writeFileAtomic(plan.absolute, plan.text);
      written.push(plan);
    }
  } catch (error) {
    for (const plan of written) {
      try { fs.writeFileSync(plan.absolute, originals.get(plan.absolute), 'utf8'); } catch { /* best effort */ }
    }
    return {
      status: 500,
      error: 'не удалось записать раскладку: ' + (error && error.message ? error.message : 'ошибка'),
      fix: 'Проверьте права на файлы structure/*.json и повторите.',
    };
  }

  return {
    status: 200,
    ok: true,
    root,
    reset,
    files: plans.map((plan) => plan.relative),
    positions: reset ? 0 : wanted.size,
    cleared: reset ? plans.reduce((sum, plan) => sum + plan.touched, 0) : 0,
  };
}

/** What to do about each refusal of the workflow plugin install, in one sentence. */
const WORKFLOW_INSTALL_FIX = {
  'no-spec': 'Задайте workflowInstallSpec в cordis.patch.yml плагина: строку установки пакета dsh-workflow-console.',
  'no-manager': 'Установка идёт через службу pluginManager: проверьте, что в DSH загружен плагин управления плагинами.',
  'already-installed': 'Плагин уже стоит в профиле (так отвечает хост со службой hmr). Повторная установка в остальных хостах безопасна: она переустанавливает тот же пакет и отвечает applied без поля version. Версию берите из plugin.version в статусе; другую версию — удалите плагин (Настройки → Плагины) и поставьте заново.',
  'not-bundle': 'Пакет не объявляет dsh.bundle, то есть это не плагин DSH. В спеке должен быть пакет плагина (dsh-workflow-console), а не корень спецификации.',
  'incompatible-version': 'Пакет требует другую версию DSH: обновите DSH или возьмите версию плагина под свою сборку.',
  'not-found': 'Пакет не найден по спеке: проверьте ссылку и что релиз содержит этот ассет.',
  network: 'Установщик не смог скачать пакет: проверьте подключение к сети и повторите.',
  timeout: 'Установщик не успел скачать пакет: проверьте сеть и повторите.',
  'invalid-spec': 'Спека не разбирается: нужна ссылка на .tgz, имя пакета с версией или абсолютный путь.',
  unknown: 'Установщик отказал без понятной причины: смотрите вывод pnpm в ответе.',
};

/** Last lines of pnpm output; enough to explain a failure without flooding the panel. */
function tailOutput(text, limit = 3000) {
  const value = String(text || '');
  return value.length > limit ? value.slice(value.length - limit) : value;
}

/**
 * Install a bundle through the host's own plugin manager.
 *
 * The panel does not invent an installer: it hands the spec to
 * `pluginManager.installBundle`, which runs pnpm in the profile, refuses a
 * package without a bundle patch, and reports `applied` or `restart-required`.
 * Refusals are mapped to a reason and a next step, because a bare code tells a
 * person nothing.
 *
 * @param runtime - graph runtime carrying the manager getter.
 * @param rawSpec - package spec, tarball URL or absolute path.
 * @returns `{ status, ok, application, version?, bundle?, restartReason?, spec }` or `{ status, code, error, fix }`.
 */
async function installBundleSpec(runtime, rawSpec) {
  const spec = typeof rawSpec === 'string' ? rawSpec.trim() : '';
  if (!spec) {
    return {
      status: 409,
      code: 'no-spec',
      error: 'в конфиге плагина не задан workflowInstallSpec',
      fix: WORKFLOW_INSTALL_FIX['no-spec'],
    };
  }
  const manager = readRuntimeService(runtime, 'getPluginManager');
  if (!manager || typeof manager.installBundle !== 'function') {
    return {
      status: 503,
      code: 'no-manager',
      error: 'служба pluginManager недоступна в этом хосте',
      fix: WORKFLOW_INSTALL_FIX['no-manager'],
    };
  }
  let result;
  try {
    result = await manager.installBundle(spec);
  } catch (error) {
    const raw = (error && (error.code || error.name)) || 'unknown';
    const code = Object.hasOwn(WORKFLOW_INSTALL_FIX, raw) ? raw : 'unknown';
    const message = error && error.message ? error.message : String(error);
    return {
      status: code === 'invalid-spec' ? 400 : code === 'incompatible-version' ? 409 : 409,
      code,
      error: 'установка отклонена: ' + message,
      fix: WORKFLOW_INSTALL_FIX[code],
    };
  }
  const packageResult = result && result.packageResult;
  const pnpmFailed = Boolean(packageResult && (packageResult.exitCode !== 0 || packageResult.timedOut === true));
  if (pnpmFailed) {
    return {
      status: 502,
      code: packageResult.timedOut === true ? 'timeout' : 'network',
      error: 'pnpm не смог установить пакет',
      fix: WORKFLOW_INSTALL_FIX[packageResult.timedOut === true ? 'timeout' : 'network'],
      output: tailOutput(packageResult.output),
    };
  }
  const application = result && result.application === 'restart-required' ? 'restart-required' : 'applied';
  return {
    status: 200,
    ok: true,
    application,
    spec,
    ...(result && result.bundle ? { bundle: result.bundle } : {}),
    ...(result && result.version ? { version: result.version } : {}),
    ...(result && result.restartReason ? { restartReason: String(result.restartReason) } : {}),
  };
}

/**
 * Install the workflow plugin through the host's own plugin manager.
 *
 * @param runtime - graph runtime carrying `workflowInstallSpec`.
 * @returns the install result, or a refusal with a code and a next step.
 */
export async function installWorkflow(runtime) {
  return installBundleSpec(runtime, specOf(runtime));
}

/** Configured install spec, trimmed, or an empty string. */
function specOf(runtime) {
  return runtime && typeof runtime.workflowInstallSpec === 'string' ? runtime.workflowInstallSpec.trim() : '';
}

/** Version of the workflow plugin currently installed in the profile, if readable. */
export function readInstalledPluginVersion(runtime) {
  const dir = runtime && typeof runtime.profileDir === 'string' && runtime.profileDir.trim()
    ? runtime.profileDir.trim()
    : (typeof process !== 'undefined' && process.env && process.env.DSH_PROFILE_DIR ? process.env.DSH_PROFILE_DIR : '');
  if (!dir) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'dsh-workflow-console', 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : null;
  } catch {
    return null;
  }
}

/** Profile directory this runtime belongs to, or an empty string. */
function profileDirOf(runtime) {
  const dir = runtime && typeof runtime.profileDir === 'string' && runtime.profileDir.trim()
    ? runtime.profileDir.trim()
    : (typeof process !== 'undefined' && process.env && process.env.DSH_PROFILE_DIR ? process.env.DSH_PROFILE_DIR : '');
  return dir || '';
}

/**
 * How a plugin is installed in the profile: a package copy or a link to a folder.
 *
 * This matters before an update: reinstalling from the release replaces the link
 * with a package copy, so local edits stop applying. The panel must say that
 * plainly instead of leaving the person to guess.
 */
function readPluginInstall(runtime, name) {
  const dir = profileDirOf(runtime);
  if (!dir) return { link: false, source: null };
  const target = path.join(dir, 'node_modules', name);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) return { link: false, source: null };
    let source = null;
    try { source = fs.readlinkSync(target); } catch { source = null; }
    return { link: true, source };
  } catch {
    return { link: false, source: null };
  }
}

/** Is the workflow plugin a symlink to a local folder (`link:` install)? */
export function readPluginLink(runtime) {
  return readPluginInstall(runtime, 'dsh-workflow-console');
}

/**
 * Install mode of this very plugin: 'link' when the profile points at a folder,
 * 'package' otherwise. A missing profile entry is not a link — the panel then
 * offers the ordinary package update instead of inventing a dev copy.
 */
export function readStructureInstallMode(runtime) {
  return readPluginInstall(runtime, PLUGIN_NAME).link ? 'link' : 'package';
}

/**
 * Where the engine is updated, in the words the panel may show.
 *
 * The three answers are not a mirror of readEngine: they answer a different
 * question. A local engine is updated here, in the workspace; an external one is
 * updated in the repository that owns it — the update runs there, not in this
 * workspace, so the scope names the repository root, not the engine subfolder
 * inside it. When there is no engine anywhere, there is nothing to update.
 *
 * @param engine - the answer of readEngine for this workspace.
 * @returns { mode, where, path } with an absolute path or null.
 */
function engineScopeOf(engine) {
  if (!engine || engine.mode === 'absent' || !engine.installed) {
    return { mode: 'absent', where: 'none', path: null };
  }
  if (engine.mode === 'local') {
    return { mode: 'local', where: 'workspace', path: engine.path ? path.resolve(engine.path) : null };
  }
  if (engine.mode === 'mapped') {
    /* The repository, not <repo>/docs/subagent-workflow: the update is a repo action. */
    const repository = engine.repo
      ? engine.repo
      : (engine.path ? path.dirname(path.dirname(path.resolve(engine.path))) : null);
    return { mode: 'mapped', where: 'engine-repo', path: repository ? path.resolve(repository) : null };
  }
  return { mode: 'absent', where: 'none', path: null };
}

/**
 * Compare the installed pair (plugin in the profile, engine in the workspace)
 * with the released tarball. Only an explicit check fetches the release: the
 * panel must not go to the network on page load.
 */
export async function checkWorkflow(runtime, root) {
  const spec = specOf(runtime);
  if (!spec) {
    return { status: 409, code: 'no-spec', error: 'в конфиге плагина не задан workflowInstallSpec', fix: WORKFLOW_INSTALL_FIX['no-spec'] };
  }
  const target = typeof root === 'string' && root.trim() ? path.resolve(root.trim()) : null;
  const engine = target
    ? readEngine(target, runtime)
    : {
      installed: false, mode: 'absent', path: null, root: null, version: null, source: 'none',
      deployed: false, dir: 'docs/subagent-workflow',
    };
  const installed = readInstalledPluginVersion(runtime);
  const fetchLatest = typeof runtime.fetchRelease === 'function' ? runtime.fetchRelease : (url) => fetchRelease(url);
  let latest;
  try {
    latest = await fetchLatest(spec);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return {
      status: 502,
      code: 'release-unreachable',
      error: 'не удалось прочитать релиз: ' + message,
      fix: 'Проверьте сеть и повторите. Установка и развёртывание от этой проверки не зависят.',
    };
  }
  const details = isOutdated({ plugin: installed, engine: engine.version }, latest);
  const link = readPluginLink(runtime);
  /*
   * Our update reinstalls the plugin from the release and rewrites the engine. That
   * is fine for a package install and destructive for a linked one: the local folder
   * would be detached and the running setup replaced. When it is not safe, the panel
   * must not offer the button at all — it recommends updating through the workflow
   * plugin's own interface instead.
   */
  /*
   * Our update downloads the release tarball with pnpm. In this environment that
   * download does not pass the TLS checks (proxy/antivirus certificate), so the
   * button would fail every time — a promise we cannot keep. The panel says what to
   * do instead: update the plugin through the workflow plugin's own interface.
   */
  const safe = false;
  const why = link.link
    ? 'плагин подключён локальной папкой ' + (link.source || 'link') + ', а загрузка пакета с GitHub не проходит проверку сертификата'
    : 'загрузка пакета с GitHub не проходит проверку сертификата (прокси/антивирус)';
  const engineScope = engineScopeOf(engine);
  /*
   * A mapped engine is updated in its own repository, not in this workspace. The
   * recommendation must say that plainly and name the repository path: the panel
   * then repeats the same fact in its freshness line, and nobody waits for an
   * update here that only ever happens there.
   */
  const engineNote = engineScope.mode === 'mapped'
    ? ' Движок обновляется в репозитории движка, а не здесь: ' + engineScope.path + '.'
    : '';
  return {
    status: 200,
    ok: true,
    current: { plugin: installed, engine: engine.version, deployed: engine.deployed, link: link.link, source: link.source },
    latest,
    details,
    outdated: details.plugin || details.engine,
    safe,
    /* Where the engine is updated: workspace, its own repository, or nowhere. */
    engineScope,
    recommendation: {
      code: link.link ? 'linked' : 'download-blocked',
      text: 'Обновление из панели недоступно: ' + why + '. Обновите плагин через интерфейс самого workflow'
        + (link.source ? ': ' + link.source : '') + '.' + engineNote,
    },
  };
}

/** Where the latest release of this structure is published. */
export const STRUCTURE_RELEASE_API =
  'https://api.github.com/repos/AleksandrGoriachev/dsh-project-graph/releases/latest';

/** `v1.0.10` and `1.0.10` name the same release; only the number is compared. */
function releaseVersion(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.replace(/^v/iu, '').trim() || null;
}

/** First `.tgz` asset of the release — the bundle the panel can install. */
function releaseAssetUrl(payload) {
  const assets = payload && Array.isArray(payload.assets) ? payload.assets : [];
  const asset = assets.find((item) => item
    && typeof item.name === 'string' && /\.(?:tgz|tar\.gz)$/iu.test(item.name)
    && typeof item.browser_download_url === 'string' && item.browser_download_url.trim());
  return asset ? asset.browser_download_url.trim() : null;
}

/** GitHub releases/latest with a timeout: a hung request must not hang the panel. */
async function defaultStructureReleaseFetcher(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': PLUGIN_NAME },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compare the installed structure version with the latest GitHub release.
 *
 * The check is a network read, so it never throws: a failed request, a non-OK
 * answer or a payload without a tag comes back as `outdated: null` plus an
 * `error` sentence, and the panel offers a retry instead of a broken card.
 * `fetcher` is the seam for tests and for a host that fetches differently.
 *
 * @param options - `{ current, mode, fetcher }`.
 * @returns `{ current, latest, outdated, canUpdate, mode, assetUrl?, reason?, error? }`.
 */
export async function checkStructureRelease(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const current = typeof input.current === 'string' && input.current.trim() ? input.current.trim() : null;
  const mode = typeof input.mode === 'string' && input.mode.trim() ? input.mode.trim() : 'package';
  const fetcher = typeof input.fetcher === 'function' ? input.fetcher : defaultStructureReleaseFetcher;
  let response;
  try {
    response = await fetcher(STRUCTURE_RELEASE_API);
  } catch (error) {
    return { current, latest: null, outdated: null, canUpdate: false, mode, error: 'не удалось проверить релиз: ' + reasonOf(error) };
  }
  if (!response || response.ok !== true) {
    const status = response && response.status !== undefined ? response.status : '?';
    return { current, latest: null, outdated: null, canUpdate: false, mode, error: 'GitHub не отдал релиз: HTTP ' + status };
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { current, latest: null, outdated: null, canUpdate: false, mode, error: 'ответ GitHub не разбирается как JSON: ' + reasonOf(error) };
  }
  const latest = releaseVersion(payload && payload.tag_name);
  if (!latest) {
    return { current, latest: null, outdated: null, canUpdate: false, mode, error: 'в релизе нет tag_name — сравнивать не с чем' };
  }
  const status = releaseStatus({ current, latest, mode, publishedAt: payload && payload.published_at });
  const assetUrl = releaseAssetUrl(payload);
  /*
   * Режим установки едет вместе со статусом (задание 0107): панель решает, чем
   * обновлять — пакетом из релиза или fast-forward-ом связанного каталога, — по
   * факту профиля, а не по догадке о текущем хосте.
   */
  return assetUrl ? { ...status, mode, assetUrl } : { ...status, mode };
}

/** Version from a checkout's own `package.json`, or null. */
function readCheckoutVersion(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : null;
  } catch {
    return null;
  }
}

/** Default git runner for the linked checkout: full argv, no shell. */
function defaultGitRun(args) {
  let result;
  try {
    result = spawnSync('git', args, { encoding: 'utf8', timeout: 120000, windowsHide: true });
  } catch (error) {
    return { code: -1, stdout: '', stderr: String(error && error.message ? error.message : error) };
  }
  const failed = result && result.error ? String(result.error.message || result.error) : '';
  return {
    code: typeof result.status === 'number' ? result.status : (failed ? -1 : 0),
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '') + (failed ? failed : ''),
  };
}

/**
 * One git call through the seam. A runner that throws or returns nothing is a
 * failure of the tool, not of the repository: it is reported, never masked.
 */
function callGit(run, args) {
  let result;
  try {
    result = run(args);
  } catch (error) {
    return { code: -1, stdout: '', stderr: '', failed: String(error && error.message ? error.message : error) };
  }
  if (!result || typeof result !== 'object') {
    return { code: -1, stdout: '', stderr: '', failed: 'git-раннер вернул пустой ответ' };
  }
  const code = typeof result.code === 'number' ? result.code : (typeof result.status === 'number' ? result.status : 0);
  return { code, stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), failed: null };
}

/** Head of git output, squeezed for a one-sentence refusal. */
function gitOutputTail(git, limit = 600) {
  const text = (String(git.stdout || '') + ' ' + String(git.stderr || '')).trim();
  return tailOutput(text.replace(/\s+/gu, ' ').trim(), limit);
}

/** First lines of git output — enough for a dirty-tree refusal. */
function gitFirstLines(git, limit = 5) {
  const lines = (String(git.stdout || '') + String(git.stderr || ''))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, limit).join('; ');
}

/**
 * Absolute checkout behind the profile's `link:` entry, or null.
 *
 * The target is read from the profile, never from a request: the panel updates
 * the folder the person linked, not an arbitrary path someone posts. A relative
 * symlink target resolves against the profile's `node_modules`, where it sits.
 */
function linkCheckoutPath(runtime, source) {
  const raw = typeof source === 'string' ? source.trim().replace(/^\\\\\?\\/u, '') : '';
  if (!raw) return null;
  try {
    if (path.isAbsolute(raw)) return path.resolve(raw);
    const profile = profileDirOf(runtime);
    return path.resolve(profile ? path.join(profile, 'node_modules') : process.cwd(), raw);
  } catch {
    return null;
  }
}

/**
 * Update a linked structure checkout with a fast-forward pull.
 *
 * A `link:` install is a live folder the person edits, so the panel never
 * reinstalls it from the release and never rewrites it. The one safe repository
 * action stays: `git pull --ff-only` moves a clean checkout forward and refuses
 * to invent merges. A dirty tree is a refusal, not a cleanup — someone else's
 * work is not the panel's to commit, stash or reset. Force never appears in the
 * argv.
 *
 * `run(args)` is the seam: it receives the full git argv and answers
 * `{ code, stdout, stderr }`; the default runs git itself. Refusals carry a
 * reason and, where the person has something to do, a next step.
 *
 * @param options - `{ linkPath, run? }`: the linked folder (absolute or resolvable).
 * @returns `{ status, updated, version?, reason?, fix? }`.
 */
export function updateLinkRelease(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const rawPath = typeof input.linkPath === 'string' ? input.linkPath.trim() : '';
  if (!rawPath) {
    return {
      status: 409,
      updated: false,
      reason: 'не передан каталог связанной установки: обновлять нечего',
      fix: 'Профиль должен держать плагин ссылкой на каталог — проверьте node_modules профиля DSH.',
    };
  }
  const linkPath = path.resolve(rawPath);
  let stat = null;
  try { stat = fs.statSync(linkPath); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) {
    return {
      status: 409,
      updated: false,
      reason: 'связанный каталог не найден: ' + linkPath,
      fix: 'Восстановите ссылку в профиле DSH или переустановите плагин.',
    };
  }
  const run = typeof input.run === 'function' ? input.run : defaultGitRun;
  const state = callGit(run, ['-C', linkPath, 'status', '--porcelain']);
  if (state.failed) {
    return {
      status: 409,
      updated: false,
      reason: 'не удалось проверить каталог: git не запустился — ' + state.failed,
      fix: 'Проверьте, что git установлен и доступен в PATH, и повторите.',
    };
  }
  if (state.code !== 0) {
    return {
      status: 409,
      updated: false,
      reason: 'каталог не git-репозиторий или git отказал: ' + gitOutputTail(state),
      fix: 'Обновите связанный каталог вручную: панель не трогает папку, которую git не признаёт.',
    };
  }
  if (String(state.stdout || '').trim()) {
    return {
      status: 409,
      updated: false,
      reason: 'есть локальные правки — закоммитьте или уберите их: ' + gitFirstLines(state),
      fix: 'Панель не коммитит, не прячет и не откатывает чужую работу; повторите на чистом дереве.',
    };
  }
  const branchResult = callGit(run, ['-C', linkPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchResult.failed || branchResult.code !== 0 ? null : String(branchResult.stdout || '').trim() || null;
  const pull = callGit(run, ['-C', linkPath, 'pull', '--ff-only']);
  if (pull.failed) {
    return {
      status: 409,
      updated: false,
      reason: 'не удалось запустить git pull' + (branch ? ' в ветке ' + branch : '') + ': ' + pull.failed,
      fix: 'Проверьте, что git установлен и доступен в PATH, и повторите.',
    };
  }
  if (pull.code !== 0) {
    return {
      status: 409,
      updated: false,
      reason: 'git pull --ff-only не удался' + (branch ? ' в ветке ' + branch : '') + ': '
        + (gitOutputTail(pull) || ('код ' + pull.code)),
      fix: 'Разберите конфликт в связанном каталоге и повторите: force, reset и stash панель не делает.',
    };
  }
  const version = readCheckoutVersion(linkPath);
  return {
    status: 200,
    updated: true,
    ...(version ? { version } : {}),
    reason: 'обновлено' + (branch ? ' в ветке ' + branch : '') + ' — перезапустите DSH, чтобы панель взяла новую сборку',
  };
}

/**
 * Update the structure plugin from the latest release, or refuse with a reason.
 *
 * A package install is replaced by the released bundle through the same manager
 * the workflow install uses; the answer says whether anything was installed and
 * which version now runs. A `link:` install is a live folder: the panel does not
 * detach it and does not put a package in its place. It runs the one safe
 * repository action instead — `git pull --ff-only` in that folder — and asks for
 * a restart; a dirty tree or a failed pull is a refusal with the reason. The
 * answer keeps the 0105 shape, so the panel and the route read it unchanged.
 *
 * @param runtime - graph runtime carrying the profile and the manager getter.
 * @returns `{ status, updated, version?, reason?, fix? }`.
 */
export async function updateStructureRelease(runtime) {
  const mode = readStructureInstallMode(runtime);
  if (mode === 'link') {
    const install = readPluginInstall(runtime, PLUGIN_NAME);
    const linkPath = linkCheckoutPath(runtime, install.source);
    if (!linkPath) {
      return {
        status: 409,
        updated: false,
        reason: 'ссылка профиля не называет каталог: обновлять из репозитория нечего',
        fix: 'Проверьте, что node_modules/' + PLUGIN_NAME + ' в профиле DSH — ссылка на существующий каталог.',
      };
    }
    const runner = runtime && typeof runtime.runGit === 'function' ? runtime.runGit : null;
    const updated = updateLinkRelease({ linkPath, ...(runner ? { run: runner } : {}) });
    return {
      status: updated.status,
      updated: updated.updated === true,
      ...(updated.version ? { version: updated.version } : {}),
      ...(updated.reason ? { reason: updated.reason } : {}),
      ...(updated.fix ? { fix: updated.fix } : {}),
    };
  }
  const fetcher = runtime && typeof runtime.fetchStructureRelease === 'function' ? runtime.fetchStructureRelease : null;
  const checked = await checkStructureRelease({ current: PLUGIN_VERSION, mode, ...(fetcher ? { fetcher } : {}) });
  if (checked.error) {
    return {
      status: 502,
      updated: false,
      reason: checked.error,
      fix: 'Проверьте сеть и повторите: проверка релиза не зависит от структуры проекта.',
    };
  }
  if (!checked.outdated) {
    return { status: 200, updated: false, version: checked.current, reason: 'установлена последняя версия — обновлять нечего' };
  }
  if (!checked.assetUrl) {
    return {
      status: 409,
      updated: false,
      reason: 'в релизе ' + checked.latest + ' нет файла .tgz — кнопке нечего ставить',
      fix: 'Добавьте пакет в релиз на GitHub и повторите.',
    };
  }
  const installed = await installBundleSpec(runtime, checked.assetUrl);
  if (installed.status !== 200) {
    return {
      status: installed.status,
      updated: false,
      reason: String(installed.error || 'установка отклонена'),
      ...(installed.code ? { code: installed.code } : {}),
      ...(installed.fix ? { fix: installed.fix } : {}),
    };
  }
  return {
    status: 200,
    updated: true,
    version: installed.version || checked.latest,
    ...(installed.application ? { application: installed.application } : {}),
    ...(installed.restartReason ? { reason: String(installed.restartReason) } : {}),
  };
}

/** Run the deployed engine's own init --force from the freshly installed package. */
function defaultRunEngineInit(runtime, root) {
  const profileDir = runtime && typeof runtime.profileDir === 'string' && runtime.profileDir.trim()
    ? runtime.profileDir.trim()
    : (process.env.DSH_PROFILE_DIR || '');
  const init = path.join(profileDir, 'node_modules', 'dsh-workflow-console', 'vendor', 'spec', 'scripts', 'init.mjs');
  if (!fs.existsSync(init)) {
    return { updated: false, reason: 'в установленном пакете нет vendor/spec — обновите панель workflow' };
  }
  /* ELECTRON_RUN_AS_NODE turns the desktop binary into a plain node for the script. */
  const result = spawnSync(process.execPath, [init, '--repo', root, '--force'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const engine = readEngine(root, runtime);
  const output = String(result.stdout || '') + String(result.stderr || '');
  if (result.status !== 0) {
    return { updated: false, version: engine.version, reason: 'init --force завершился с кодом ' + result.status, output: tailOutput(output) };
  }
  return { updated: true, version: engine.version, output: tailOutput(output, 400) };
}

/**
 * Update the engine inside the workspace after the plugin was updated: both
 * layers must move together, otherwise a new plugin would serve an old engine.
 */
export function updateEngine(runtime, root) {
  if (!root || typeof root !== 'string' || !fs.existsSync(root)) {
    return { updated: false, reason: 'не выбран воркспейс для обновления движка' };
  }
  const runner = runtime && typeof runtime.runEngineInit === 'function' ? runtime.runEngineInit : defaultRunEngineInit;
  return runner(runtime, root);
}

/**
 * Replace the installed workflow plugin with the configured spec.
 *
 * This is an update, not an install: the bundle is removed through the manager
 * (`pnpm remove`) and then installed from the spec, so the profile ends with the
 * released package instead of whatever was there. A local `link:` installation is
 * replaced too — the panel says so before asking, because that is the difference
 * between a dev loop and a released copy.
 *
 * @param runtime - graph runtime carrying the spec and the manager.
 * @returns the install result plus `removed`, or a refusal with a code and a next step.
 */
export async function updateWorkflow(runtime, root) {
  const spec = runtime && typeof runtime.workflowInstallSpec === 'string' ? runtime.workflowInstallSpec.trim() : '';
  if (!spec) {
    return { status: 409, code: 'no-spec', error: 'в конфиге плагина не задан workflowInstallSpec', fix: WORKFLOW_INSTALL_FIX['no-spec'] };
  }
  const manager = readRuntimeService(runtime, 'getPluginManager');
  if (!manager || typeof manager.installBundle !== 'function') {
    return { status: 503, code: 'no-manager', error: 'служба pluginManager недоступна в этом хосте', fix: WORKFLOW_INSTALL_FIX['no-manager'] };
  }
  /*
   * An update is a replacement: the old bundle is removed before the new one is
   * installed. If the install then fails, the profile would lose the plugin, so
   * the previous spec is captured first and restored on failure. A local
   * `link:` spec is valid here — the manager resolves it the same way.
   */
  let previous = null;
  if (typeof manager.listBundles === 'function') {
    try {
      const rows = await manager.listBundles();
      const row = Array.isArray(rows) ? rows.find((item) => item && item.name === 'dsh-workflow-console') : null;
      if (row) {
        if (row.removable === false) {
          return {
            status: 409,
            code: 'not-removable',
            error: 'плагин dsh-workflow-console нельзя удалить из профиля',
            fix: 'Удалите его в «Настройки → Плагины» вручную и нажмите «Обновить Workflow» снова.',
          };
        }
        previous = typeof row.source === 'string' && row.source.trim() ? row.source.trim() : null;
      }
    } catch {
      /* A list failure must not block the update: the install path still works. */
    }
  }
  let removed = false;
  if (typeof manager.removeBundle === 'function') {
    try {
      await manager.removeBundle('dsh-workflow-console');
      removed = true;
    } catch (error) {
      const code = error && (error.code || error.name);
      /* Nothing to remove is not a failure: the install below is the whole job. */
      if (code !== 'not-removable' && code !== 'unknown-plugin' && code !== 'not-installed') {
        const message = error && error.message ? error.message : String(error);
        return {
          status: 409,
          code: code || 'remove-failed',
          error: 'не удалось удалить прежнюю версию плагина: ' + message,
          fix: 'Удалите dsh-workflow-console в «Настройки → Плагины» и нажмите «Обновить Workflow» снова.',
        };
      }
    }
  }
  const installed = await installWorkflow(runtime);
  if (installed.status !== 200) {
    if (!removed || !previous) return installed;
    /* Put the profile back the way it was, so a failed update is not a loss. */
    try {
      await manager.installBundle(previous);
      return {
        ...installed,
        error: installed.error + ' — прежняя установка восстановлена',
        fix: 'Плагин остался в прежнем виде (' + previous + '). Проверьте сеть или спеку и повторите.',
        previous,
        restored: true,
      };
    } catch (restoreError) {
      const message = restoreError && restoreError.message ? restoreError.message : String(restoreError);
      return {
        ...installed,
        error: installed.error + ' — восстановить прежнюю установку не удалось: ' + message,
        fix: 'Поставьте плагин вручную: ' + previous + '.',
        previous,
        restored: false,
      };
    }
  }
  /*
   * Both layers move together: a new plugin serving an old engine is exactly the
   * mismatch the freshness check exists for. The engine is updated from the
   * freshly installed package's vendored spec, never from the old copy.
   */
  const engine = updateEngine(runtime, typeof root === 'string' ? path.resolve(root) : null);
  return { ...installed, removed, action: 'update', previous, engine };
}

/** Строка маршрута: в файле и каталоге живут простые строки без пробелов по краям. */
function routeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Число узлов с моделью: summary.models считается по прямым полям, а не по models{}. */
function nodeModelCount(graph) {
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes.filter((node) => node && routeText(node.model)).length;
}

/** Карта старых алиасов `models{}` из уже прочитанного графа. */
function aliasMap(before) {
  const models = before && before.graph ? before.graph.models : null;
  return models && typeof models === 'object' && !Array.isArray(models) ? models : {};
}

/**
 * Маршрут узла к записи: provider + model (+ family).
 *
 * Панель и новые вызовы передают прямые поля. Старый вызов мог передать только
 * `model` с именем алиаса models{}: он разворачивается здесь, потому что файл
 * больше не хранит алиасов (решение 0050 D1). Если provider передан явно, model —
 * идентификатор модели, а не алиас.
 */
function nodeRoute(provider, model, family, aliases, explicitProvider) {
  let nextProvider = routeText(provider);
  let nextModel = routeText(model);
  let nextFamily = routeText(family);
  if (!explicitProvider && !nextProvider && nextModel && aliases && Object.hasOwn(aliases, nextModel)) {
    const route = aliases[nextModel];
    if (route && typeof route === 'object' && !Array.isArray(route)) {
      nextProvider = routeText(route.provider);
      nextModel = routeText(route.model);
      nextFamily = nextFamily || routeText(route.family);
    }
  }
  return { provider: nextProvider, model: nextModel, family: nextFamily };
}

/** Провайдеры живого каталога: массив или ответ `{ ok, providers }`. */
function catalogProviders(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (catalog && catalog.ok === true && Array.isArray(catalog.providers)) return catalog.providers;
  return null;
}

/**
 * Проверка маршрута по живому каталогу ДО записи (решение 0050 D2).
 *
 * Отказ называет то, что человек выбрал, и то, что доступно: провайдера нет —
 * provider-missing, модели нет — model-missing, каталог не прочитан —
 * catalog-unavailable. «Сохранить как есть» здесь нет: непроверенный маршрут
 * выглядел бы рабочим, а запуск упал бы позже.
 */
function catalogRefusal(runtime, route, catalog) {
  if (!route.provider && !route.model) return null;
  const source = catalog === undefined ? readModelCatalogNow(runtime) : catalog;
  const providers = catalogProviders(source);
  if (!providers) {
    const reason = source && source.reason
      ? source.reason
      : (source && source.pending ? 'каталог моделей читается службой llm асинхронно' : 'служба llm не ответила');
    return {
      status: 400,
      code: 'catalog-unavailable',
      error: 'каталог моделей недоступен: ' + reason,
      fix: 'Проверьте, что плагин LLM загружен и отвечает, затем повторите сохранение: '
        + 'без живого каталога маршрут узла не проверить.',
    };
  }
  const providerIds = providers.map((row) => routeText(row && row.id)).filter(Boolean);
  const providerRow = providers.find((row) => row && routeText(row.id) === route.provider) || null;
  if (!providerRow) {
    return {
      status: 400,
      code: 'provider-missing',
      error: route.provider
        ? 'провайдера «' + route.provider + '» нет в каталоге службы llm'
        : 'модель «' + route.model + '» не сохраняется: у неё не задан провайдер',
      fix: 'Доступные провайдеры: ' + (providerIds.length > 0 ? providerIds.join(', ') : 'ни одного')
        + '. Выберите провайдера из списка — неизвестный каталогу маршрут не сохраняется.',
    };
  }
  const models = Array.isArray(providerRow.models) ? providerRow.models : [];
  const modelIds = models.map((row) => routeText(row && row.id)).filter(Boolean);
  if (!route.model) {
    return {
      status: 400,
      code: 'model-missing',
      error: 'у провайдера «' + route.provider + '» не выбрана модель: сохранение без модели не проверить',
      fix: 'Выберите модель из списка: доступны ' + (modelIds.length > 0 ? modelIds.join(', ') : '—') + '.',
    };
  }
  if (!models.some((row) => row && routeText(row.id) === route.model)) {
    return {
      status: 400,
      code: 'model-missing',
      error: 'модели «' + route.model + '» нет у провайдера «' + route.provider + '»',
      fix: modelIds.length > 0
        ? 'Доступные модели: ' + modelIds.join(', ') + '. Выберите модель из списка — пропавшая не заменяется другой.'
        : 'У провайдера «' + route.provider + '» нет объявленных моделей: выберите другого провайдера.',
    };
  }
  return null;
}

/**
 * Одноразовая миграция документа структуры при записи узла.
 *
 * Все оставшиеся алиасы разворачиваются в прямые provider/model/family у всех
 * узлов документа, ключ models{} удаляется, modelAlias в файл не пишется. Так
 * файл перестаёт быть двусмысленным: маршрут виден рядом с узлом, а не в карте.
 */
function expandDocumentAliases(document, aliases) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return;
  const map = aliases && typeof aliases === 'object' ? aliases : {};
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    delete node.modelAlias;
    const provider = routeText(node.provider);
    const model = routeText(node.model);
    if (provider || !model || !Object.hasOwn(map, model)) continue;
    const route = map[model];
    if (!route || typeof route !== 'object' || Array.isArray(route)) continue;
    if (routeText(route.provider)) node.provider = routeText(route.provider);
    if (routeText(route.model)) node.model = routeText(route.model);
    const family = routeText(node.family) || routeText(route.family);
    if (family) node.family = family;
  }
  delete document.models;
}

/**
 * Add one node to the structure file that should own it.
 *
 * The panel used to write edges only; adding an executor meant opening the whole
 * builder, which replaces the graph view and reads like a different screen. A
 * single node is a small edit, so it gets a small route: the node lands in the
 * fragment that already holds the others when there is exactly one, otherwise in
 * `<structureDir>/graph.json`, which is merged with the fragments on read.
 *
 * The node carries its route directly: provider + model (+ family). The live LLM
 * catalog is checked before the write, and the same write expands every remaining
 * models{} alias of the file, so the file stops storing aliases (0050 D1/D2).
 *
 * As with links, the write is validated by re-reading the whole structure and
 * rolled back if it introduces an error.
 *
 * @param runtime - graph runtime (structure folder, plugin identity).
 * @param root - project root.
 * @param input - `{ id?, type?, role?, provider?, model?, family?, brief?, prompt?, agentPreset? }`.
 *   Without an id the node is named `<type>-N`, N being the first free number from 1.
 *   A non-empty prompt — the role spec in words — is written trimmed; a blank one
 *   leaves the field out (0120).
 * @param options - `{ catalog }` already read by the HTTP route; without it the
 *   synchronous catalog read is attempted.
 * @returns `{ status, ok, file, node }` or `{ status, code, error, fix }`.
 */
export function addNode(runtime, root, input, options = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const explicitId = typeof source.id === 'string' ? source.id.trim() : '';
  /*
   * The library knows a kind of node, not a name: a person drags "Критик" and
   * must not invent ids. The server hands out <type>-N with the first free
   * number, so two drops in a row become critic-1 and critic-2 instead of a
   * duplicate error or a silent overwrite. An explicit id still wins.
   */
  const type = typeof source.type === 'string' ? source.type.trim() : '';
  if (!explicitId && !type) {
    return {
      status: 400,
      error: 'у нового узла нет ни id, ни type',
      fix: 'Задайте id: строчные латинские буквы, цифры, точка, дефис или подчёркивание, например worker-2. '
        + 'Или задайте type — тогда id получит номер: critic-1, critic-2, worker-1, exchange-1.',
    };
  }
  if (explicitId && !NODE_ID.test(explicitId)) {
    return {
      status: 400,
      error: 'id «' + explicitId + '» не подходит',
      fix: 'Латинские строчные буквы, цифры, точка, дефис или подчёркивание; начинать с буквы или цифры.',
    };
  }
  if (!explicitId && !NODE_ID.test(type)) {
    return {
      status: 400,
      error: 'тип узла «' + type + '» не подходит для id',
      fix: 'Тип пишется латиницей без пробелов: critic, worker, exchange. Из него получится id critic-1.',
    };
  }
  const before = readGraph(runtime, root);
  if (before.errors.length > 0) {
    const first = before.errors[0];
    return {
      status: 409,
      error: 'структура уже недействительна: ' + first.message,
      fix: first.fix || 'Сначала исправьте ошибки структуры.',
    };
  }
  let id = explicitId;
  if (!id) {
    let number = 1;
    while (before.graph.nodes.some((node) => node && node.id === type + '-' + number)) number += 1;
    id = type + '-' + number;
  }
  if (before.graph.nodes.some((node) => node && node.id === id)) {
    return { status: 409, error: 'узел «' + id + '» уже есть в структуре', fix: 'Выберите другой id или отредактируйте существующий узел.' };
  }
  const role = typeof source.role === 'string' ? source.role.trim() : '';
  const brief = typeof source.brief === 'string' ? source.brief.trim() : '';
  /* Спека роли словами: непустая строка идёт в файл, пустая/пробельная поля не даёт. */
  const prompt = typeof source.prompt === 'string' ? source.prompt.trim() : '';
  const agentPreset = typeof source.agentPreset === 'string' ? source.agentPreset.trim() : '';
  const aliases = aliasMap(before);
  const route = nodeRoute(source.provider, source.model, source.family, aliases, Object.hasOwn(source, 'provider'));
  const catalogOption = options && typeof options === 'object' && Object.hasOwn(options, 'catalog')
    ? options.catalog
    : undefined;
  /* Каталог проверяется до записи: отказ не оставляет ни узла, ни мигрированного файла. */
  const refusal = catalogRefusal(runtime, route, catalogOption);
  if (refusal) return refusal;
  const sources = Array.isArray(before.sources) ? before.sources : [];
  const single = sources.length === 1 && Number(sources[0].nodes) > 0 ? sources[0].file : null;
  const relative = single || runtime.structureDir + '/graph.json';
  const absolute = resolveStructureFile(root, runtime, relative);
  if (!absolute) {
    return { status: 400, error: 'файл структуры вне папки ' + runtime.structureDir + ': ' + relative, fix: 'Проверьте структуру проекта.' };
  }
  const node = {
    id,
    ...(role ? { role } : {}),
    ...(route.provider ? { provider: route.provider } : {}),
    ...(route.model ? { model: route.model } : {}),
    ...(route.family ? { family: route.family } : {}),
    ...(brief ? { brief } : {}),
    ...(prompt ? { prompt } : {}),
    ...(agentPreset ? { agentPreset } : {}),
  };
  /*
   * A critic is useless without a run time: dropping one from the library promises a
   * daily schedule. Adding the default here keeps the node editable from the panel.
   */
  if (isCriticNode(node) && !node.schedule) {
    node.schedule = { at: '09:00', timeZone: 'Europe/Moscow' };
  }
  let original = null;
  try {
    original = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
    const document = original === null ? { version: 1, nodes: [] } : JSON.parse(original);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return { status: 409, error: 'файл ' + relative + ' — не JSON-объект', fix: 'Исправьте файл вручную.' };
    }
    document.nodes = (Array.isArray(document.nodes) ? document.nodes : []).concat([node]);
    expandDocumentAliases(document, aliases);
    fs.writeFileSync(absolute, JSON.stringify(document, null, 2) + '\n', 'utf8');
  } catch (error) {
    if (original !== null) {
      try { fs.writeFileSync(absolute, original, 'utf8'); } catch { /* the message below is enough */ }
    }
    return {
      status: 500,
      error: 'не удалось записать узел: ' + (error && error.message ? error.message : 'ошибка'),
      fix: 'Проверьте права на файл структуры.',
    };
  }
  const after = readGraph(runtime, root);
  if (after.errors.length > 0) {
    try {
      if (original === null) fs.rmSync(absolute, { force: true });
      else fs.writeFileSync(absolute, original, 'utf8');
    } catch { /* ignore rollback failure */ }
    const first = after.errors[0];
    return {
      status: 409,
      error: first.message,
      fix: first.fix || 'Такой узел нарушает правила структуры; изменение отменено.',
    };
  }
  /*
   * A critic without its base spec would improvise every day. Creating the node lays
   * the template down once; an existing spec is never overwritten.
   */
  const spec = isCriticNode(node) ? ensureCriticSpec(root) : null;
  return { status: 200, ok: true, file: relative, node, ...(spec ? { spec } : {}) };
}

/**
 * Change the declared fields of one existing node.
 *
 * The node keeps its id: a rename is a new node, and silently rewriting links
 * would hide that from whoever reads the file. Only the fields present in the
 * input change; an empty string clears a field, and for prompt an empty string or
 * null removes the stored spec while a missing key leaves it as it was (0120).
 * The route is written directly (provider + model + family) and checked against the
 * live catalog before the
 * write; the same write expands every remaining models{} alias of the file
 * (решение 0050 D1/D2). The write is validated by re-reading the whole structure
 * and rolled back if it breaks something.
 *
 * @param runtime - graph runtime.
 * @param root - project root.
 * @param input - `{ id, role?, provider?, model?, family?, brief?, prompt?, agentPreset? }`.
 * @param options - `{ catalog }` already read by the HTTP route; without it the
 *   synchronous catalog read is attempted.
 * @returns `{ status, ok, file, node }` or `{ status, code, error, fix }`.
 */
export function updateNode(runtime, root, input, options = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (!id) {
    return { status: 400, error: 'не указан узел для изменения', fix: 'Передайте id узла и поля, которые меняете.' };
  }
  const before = readGraph(runtime, root);
  if (before.errors.length > 0) {
    const first = before.errors[0];
    return {
      status: 409,
      error: 'структура уже недействительна: ' + first.message,
      fix: first.fix || 'Сначала исправьте ошибки структуры.',
    };
  }
  const node = before.graph.nodes.find((item) => item && item.id === id);
  if (!node) {
    return { status: 404, error: 'узла «' + id + '» нет в структуре', fix: 'Обновите панель: возможно, узел уже удалён или переименован.' };
  }
  if (Object.hasOwn(source, 'id') && typeof source.id === 'string' && source.id.trim() !== id) {
    return {
      status: 400,
      error: 'id узла нельзя менять: это другой узел',
      fix: 'Создайте узел с новым id и перенесите связи; панель не переименовывает.',
    };
  }
  const patch = {};
  for (const field of ['role', 'brief', 'provider', 'model', 'family', 'agentPreset']) {
    if (!Object.hasOwn(source, field)) continue;
    patch[field] = typeof source[field] === 'string' ? source[field].trim() : '';
  }
  /*
   * prompt — текст спеки, а не короткое поле: непустая строка обновляет её,
   * пустая/пробельная строка и null удаляют поле, отсутствие ключа его не трогает
   * (0120). Иное значение (не текст и не null) не пишется и не стирает спеку.
   */
  if (Object.hasOwn(source, 'prompt')) {
    if (source.prompt === null) patch.prompt = '';
    else if (typeof source.prompt === 'string') patch.prompt = source.prompt.trim();
  }
  if (Object.keys(patch).length === 0) {
    return {
      status: 400,
      error: 'нечего менять: поля не переданы',
      fix: 'Передайте хотя бы одно из role, brief, model, agentPreset (или provider и family).',
    };
  }
  const aliases = aliasMap(before);
  /*
   * Старый вызов мог прислать только model=алиас (до 0050 панель знала лишь
   * алиасы). Если provider не передан явно, алиас разворачивается в прямую пару:
   * файл хранит прямые поля, и ответ сохранения тоже должен их назвать.
   */
  if (!Object.hasOwn(patch, 'provider') && patch.model && Object.hasOwn(aliases, patch.model)) {
    const aliasRoute = aliases[patch.model];
    if (aliasRoute && typeof aliasRoute === 'object' && !Array.isArray(aliasRoute)) {
      patch.provider = routeText(aliasRoute.provider);
      patch.model = routeText(aliasRoute.model);
      patch.family = routeText(aliasRoute.family) || routeText(patch.family);
    }
  }
  const resultingRoute = {
    provider: Object.hasOwn(patch, 'provider') ? patch.provider : routeText(node.provider),
    model: Object.hasOwn(patch, 'model') ? patch.model : routeText(node.model),
    family: Object.hasOwn(patch, 'family') ? patch.family : routeText(node.family),
  };
  const catalogOption = options && typeof options === 'object' && Object.hasOwn(options, 'catalog')
    ? options.catalog
    : undefined;
  /* Каталог проверяется до записи: отказ не оставляет ни правки, ни мигрированного файла. */
  const refusal = catalogRefusal(runtime, resultingRoute, catalogOption);
  if (refusal) return refusal;
  const relative = node.file || runtime.structureDir + '/graph.json';
  const absolute = resolveStructureFile(root, runtime, relative);
  if (!absolute) {
    return { status: 400, error: 'файл структуры вне папки ' + runtime.structureDir + ': ' + relative, fix: 'Проверьте структуру проекта.' };
  }
  let original = null;
  try {
    original = fs.readFileSync(absolute, 'utf8');
    const document = JSON.parse(original);
    if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.nodes)) {
      return { status: 409, error: 'файл ' + relative + ' не содержит массива nodes', fix: 'Исправьте файл вручную.' };
    }
    const at = document.nodes.findIndex((item) => item && item.id === id);
    if (at === -1) {
      return { status: 404, error: 'узла «' + id + '» нет в файле ' + relative, fix: 'Обновите панель: структура изменилась.' };
    }
    const updated = { ...document.nodes[at] };
    for (const [field, value] of Object.entries(patch)) {
      if (value === '') delete updated[field];
      else updated[field] = value;
    }
    document.nodes = document.nodes.map((item, index) => (index === at ? updated : item));
    expandDocumentAliases(document, aliases);
    fs.writeFileSync(absolute, JSON.stringify(document, null, 2) + '\n', 'utf8');
  } catch (error) {
    if (original !== null) {
      try { fs.writeFileSync(absolute, original, 'utf8'); } catch { /* the message below is enough */ }
    }
    return {
      status: 500,
      error: 'не удалось изменить узел: ' + (error && error.message ? error.message : 'ошибка'),
      fix: 'Проверьте права на файл структуры.',
    };
  }
  const after = readGraph(runtime, root);
  if (after.errors.length > 0) {
    try { fs.writeFileSync(absolute, original, 'utf8'); } catch { /* ignore rollback failure */ }
    const first = after.errors[0];
    return {
      status: 409,
      error: first.message,
      fix: first.fix || 'Такое изменение нарушает правила структуры; оно отменено.',
    };
  }
  /*
   * Ответ — узел в том виде, как он записан в файле: прямые provider/model/family.
   * Лента (readGraph) отдаёт мигрированный узел со служебными полями чтения — это её
   * контракт, и он не должен подменять ответ сохранения (решение 0054 D5).
   */
  let saved = null;
  try {
    const document = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    saved = (Array.isArray(document.nodes) ? document.nodes : []).find((item) => item && item.id === id) || null;
  } catch {
    saved = null;
  }
  return { status: 200, ok: true, file: relative, node: saved };
}

/**
 * Remove one declared node and every edge it takes part in.
 *
 * The panel could add and edit a node but not delete one: the node stayed in the
 * structure and only the file could be edited by hand. Deleting is the same small
 * edit as adding, so it gets a small route: the declaration goes, every link that
 * names the node goes with it in the same write, and the whole structure is
 * re-read afterwards. If the result is invalid (for example the node was the
 * orchestrator of a declared folder), all touched files are rolled back.
 *
 * The coordinator is not deletable: it stands for the workspace itself, and
 * removing it would leave the structure without the role that owns the plan.
 *
 * @param runtime - graph runtime (structure folder, plugin identity).
 * @param root - project root.
 * @param input - `{ id }`.
 * @returns `{ status, ok, removed, file, edges }` or `{ status, error, fix }`.
 */
export function removeNode(runtime, root, input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const id = typeof source.id === 'string' ? source.id.trim()
    : (typeof source.node === 'string' ? source.node.trim() : '');
  if (!id) {
    return {
      status: 400,
      error: 'не указан узел для удаления',
      fix: 'Передайте id узла, например critic: узел и все его связи уйдут из структуры.',
    };
  }
  const before = readGraph(runtime, root);
  if (!before.exists) {
    return {
      status: 404,
      error: 'в проекте нет папки ' + runtime.structureDir + '/',
      fix: 'Создайте структуру: узел удаляется из ' + runtime.structureDir + '/*.json.',
    };
  }
  if (before.errors.length > 0) {
    const first = before.errors[0];
    return {
      status: 409,
      error: 'структура уже недействительна: ' + first.message,
      fix: first.fix || 'Сначала исправьте ошибки структуры.',
    };
  }
  const node = before.graph.nodes.find((item) => item && item.id === id);
  if (!node) {
    return {
      status: 404,
      error: 'узла «' + id + '» нет в структуре',
      fix: 'Обновите панель: возможно, узел уже удалён или переименован.',
    };
  }
  if (isCoordinatorNode(node)) {
    return {
      status: 400,
      error: 'координатор не удаляется',
      fix: 'координатор не удаляется: узел «' + id + '» держит структуру и от его имени идёт план. '
        + 'Удалите другой узел или смените координатора в structure/*.json вручную.',
    };
  }
  const edges = (before.graph.edges || []).filter((edge) => edge && (edge.from === id || edge.to === id));
  const files = [];
  const addFile = (relative) => {
    if (typeof relative === 'string' && relative && !files.includes(relative)) files.push(relative);
  };
  addFile(node.file);
  for (const edge of edges) addFile(edge.file);
  if (files.length === 0) {
    return {
      status: 409,
      error: 'узел «' + id + '» не привязан ни к одному файлу структуры',
      fix: 'Нажмите «Обновить»: файл структуры мог измениться. Если повторяется — правьте structure/*.json вручную.',
    };
  }
  /*
   * Все файлы читаются и проверяются до первой записи: иначе отказ на втором
   * файле оставил бы первый уже переписанным.
   */
  const plan = [];
  try {
    for (const relative of files) {
      const absolute = resolveStructureFile(root, runtime, relative);
      if (!absolute) {
        return {
          status: 400,
          error: 'файл структуры вне папки ' + runtime.structureDir + ': ' + relative,
          fix: 'Проверьте структуру проекта.',
        };
      }
      const text = fs.readFileSync(absolute, 'utf8');
      const document = JSON.parse(text);
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        return {
          status: 409,
          error: 'файл ' + relative + ' — не JSON-объект',
          fix: 'Исправьте файл вручную.',
        };
      }
      if (Array.isArray(document.nodes)) {
        document.nodes = document.nodes.filter((item) => !(item && item.id === id));
      }
      if (Array.isArray(document.edges)) {
        document.edges = document.edges.filter((item) => !(item && (item.from === id || item.to === id)));
      }
      plan.push({ absolute, text, next: JSON.stringify(document, null, 2) + '\n' });
    }
  } catch (error) {
    return {
      status: 500,
      error: 'не удалось прочитать структуру: ' + (error && error.message ? error.message : 'ошибка'),
      fix: 'Проверьте права на файлы structure/*.json.',
    };
  }
  const originals = new Map();
  try {
    for (const item of plan) {
      originals.set(item.absolute, item.text);
      writeFileAtomic(item.absolute, item.next);
    }
  } catch (error) {
    for (const [absolute, text] of originals) {
      try { fs.writeFileSync(absolute, text, 'utf8'); } catch { /* the message below is enough */ }
    }
    return {
      status: 500,
      error: 'не удалось удалить узел: ' + (error && error.message ? error.message : 'ошибка'),
      fix: 'Проверьте права на файл структуры.',
    };
  }
  const after = readGraph(runtime, root);
  if (after.errors.length > 0) {
    for (const [absolute, text] of originals) {
      try { fs.writeFileSync(absolute, text, 'utf8'); } catch { /* ignore rollback failure */ }
    }
    const first = after.errors[0];
    return {
      status: 409,
      error: first.message,
      fix: first.fix || 'Такое удаление нарушает правила структуры; оно отменено.',
    };
  }
  return { status: 200, ok: true, removed: id, file: node.file, edges: edges.length };
}

/** Координатор держит структуру: его нельзя удалить ни из панели, ни маршрутом. */
function isCoordinatorNode(node) {
  if (!node || typeof node !== 'object') return false;
  const id = String(node.id || '').trim().toLowerCase();
  const role = String(node.role || '').toLowerCase();
  return id === 'coordinator' || role.includes('координатор') || role.includes('coordinator');
}

/**
 * Check a draft graph without touching the project: schema, layout and the
 * resources the graph would need (LLM routes, a subagent provider, presets).
 *
 * @returns { ok, errors, warnings, checks, graph, layout, summary }.
 */
export async function checkDraft(runtime, draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return {
      ok: false,
      errors: [{ code: 'invalid-draft', message: 'черновик должен быть JSON-объектом', fix: 'Передайте { version, models, nodes, edges }.' }],
      warnings: [],
      checks: [],
      graph: { version: GRAPH_VERSION, models: {}, nodes: [], folders: [], edges: [] },
      layout: { nodes: [], edges: [], width: 0, height: 0, layers: 0, cyclic: [] },
      summary: { nodes: 0, edges: 0, byKind: { delegate: 0, review: 0, peer: 0 }, roles: {}, models: 0, folders: 0, layers: 0 },
    };
  }
  const built = buildGraph([{ name: 'draft.json', text: JSON.stringify(draft) }]);
  const errors = built.errors.map(withRemedy);
  const warnings = built.warnings.map(withRemedy);
  const checks = await draftCapabilities(runtime, built.graph);
  for (const item of checks) {
    if (item.level === 'error') errors.push(item);
    else warnings.push(item);
  }
  const layout = layoutGraph(built.graph);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks,
    graph: built.graph,
    layout,
    summary: { ...summarizeGraph(built.graph, layout), models: nodeModelCount(built.graph) },
  };
}

/**
 * Materialize a checked draft as <structureDir>/graph.json.
 *
 * The builder writes one file. If the project already has a structure, the
 * caller must pass overwrite, and fragments other than graph.json are refused:
 * replacing them silently would drop a block.
 */
export async function buildStructure(runtime, root, draft, overwrite = false) {
  const checked = await checkDraft(runtime, draft);
  if (!checked.ok) {
    const first = checked.errors[0] || {};
    return {
      status: 409,
      error: 'граф пока нельзя реализовать: ' + (first.message || 'есть ошибки'),
      fix: first.fix || 'Исправьте ошибки в сборке и проверьте снова.',
      details: checked,
    };
  }
  const target = resolveStructure(root, runtime.structureDir);
  const dir = target.dir;
  const file = target.graphFile;
  const before = readGraph(runtime, root);
  if (before.exists && before.fileCount > 0) {
    if (!overwrite) {
      return {
        status: 409,
        error: 'в проекте уже есть структура (' + before.fileCount + ' файлов)',
        fix: 'Подтвердите перезапись structure/graph.json или уберите старую структуру вручную.',
      };
    }
    const files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'));
    const foreign = files.filter((name) => name !== 'graph.json');
    if (foreign.length > 0) {
      return {
        status: 409,
        error: 'структура разбита на фрагменты: ' + foreign.join(', '),
        fix: 'Сборщик пишет один файл graph.json. Объедините фрагменты вручную или создайте сборку в пустом проекте.',
      };
    }
  }
  /*
   * Файл хранит маршрут рядом с узлом: ключа models{} и modelAlias в нём нет
   * (0061 D1). Алиас черновика разворачивается здесь, до записи, — иначе файл
   * снова стал бы двусмысленным, а проверка после записи отвергла бы узел как
   * «model без provider».
   */
  const aliases = draft.models && typeof draft.models === 'object' && !Array.isArray(draft.models) ? draft.models : {};
  const clean = {
    version: GRAPH_VERSION,
    nodes: [],
    edges: [],
  };
  for (const node of Array.isArray(draft.nodes) ? draft.nodes : []) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const route = nodeRoute(node.provider, node.model, node.family, aliases, Boolean(routeText(node.provider)));
    clean.nodes.push({
      id: node.id,
      ...(node.role ? { role: node.role } : {}),
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.family ? { family: route.family } : {}),
      ...(node.brief ? { brief: node.brief } : {}),
      ...(node.agentPreset ? { agentPreset: node.agentPreset } : {}),
      ...(Array.isArray(node.mustDifferFrom) && node.mustDifferFrom.length > 0 ? { mustDifferFrom: node.mustDifferFrom } : {}),
    });
  }
  for (const edge of draft.edges || []) {
    clean.edges.push({ from: edge.from, to: edge.to, kind: edge.kind });
  }
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  } catch (error) {
    return { status: 500, error: 'не удалось записать структуру: ' + (error && error.message ? error.message : 'ошибка'), fix: 'Проверьте права на папку structure/.' };
  }
  /* Ответ сборки несёт ту же ленту: маршруты сверяются с каталогом до ответа. */
  const after = await readGraph(runtime, root);
  if (after.errors.length > 0) {
    try {
      if (original === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, original, 'utf8');
    } catch { /* the error below is enough */ }
    const first = after.errors[0];
    return { status: 409, error: first.message, fix: first.fix || 'Запись отменена: структура не прошла проверку.', details: after };
  }
  /* summary.models — число узлов с моделью: models{} в файле больше нет. */
  return {
    status: 200,
    ok: true,
    file: runtime.structureDir + '/graph.json',
    ...after,
    summary: { ...after.summary, models: nodeModelCount(after.graph) },
  };
}

async function draftCapabilities(runtime, graph) {
  const items = [];
  const add = (level, code, message, fix, node) => items.push({
    level, code, message, fix, ...(node ? { node } : {}),
  });
  const providerName = runtime.providerName || 'spawn';
  const subagents = readRuntimeService(runtime, 'getSubagents');
  const subagentProvider = subagents && typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : null;
  if (!subagentProvider) {
    add('error', 'spawn-unavailable',
      'провайдер субагентов «' + providerName + '» не зарегистрирован',
      'Проверьте, что в DSH подключён subagent-spawn-in-process.');
  } else if (!subagentProvider.capabilities || subagentProvider.capabilities.agentOptions !== true) {
    add('error', 'spawn-unavailable',
      'провайдер «' + providerName + '» не умеет agentOptions',
      'Нужен локальный провайдер spawn, иначе модель узла не передать.');
  }

  const llm = readRuntimeService(runtime, 'getLlm');
  if (!llm || typeof llm.listProviders !== 'function') {
    add('error', 'llm-unavailable', 'служба llm недоступна: маршруты моделей не проверить',
      'Проверьте, что плагин LLM загружен, и повторите проверку.');
  } else {
    /*
     * Маршрут черновика живёт в узле: provider + model (+ family). Алиас models{}
     * уже развёрнут при разборе (buildGraph). Пара сверяется с живым каталогом до
     * записи: без этой проверки файл получил бы модель, которой нет в DSH, и
     * сборка падала бы только при запуске узла (0061 D2).
     */
    const catalog = await readModelCatalog(runtime);
    const seen = new Set();
    for (const node of graph.nodes || []) {
      if (!node || typeof node !== 'object') continue;
      const route = {
        provider: routeText(node.provider),
        model: routeText(node.model),
        family: routeText(node.family),
      };
      if (!route.provider && !route.model) continue;
      const key = route.provider + '/' + route.model;
      if (seen.has(key)) continue;
      seen.add(key);
      const refusal = catalogRefusal(runtime, route, catalog);
      if (!refusal) continue;
      add('error', refusal.code,
        'у узла «' + node.id + '» маршрут не принят: ' + refusal.error,
        refusal.fix, node.id);
    }
  }

  const presets = readRuntimeService(runtime, 'getPresets');
  const withPreset = (graph.nodes || []).filter((node) => node.agentPreset);
  if (withPreset.length > 0) {
    if (!presets || typeof presets.resolve !== 'function') {
      add('error', 'preset-unavailable', 'узлы требуют agentPreset, но служба agentPresets недоступна',
        'Проверьте, что плагин пресетов загружен.');
    } else {
      for (const node of withPreset) {
        try {
          const resolved = await presets.resolve(node.agentPreset);
          if (resolved && resolved.broken) {
            add('error', 'preset-broken',
              'пресет «' + node.agentPreset + '» у узла «' + node.id + '» не активируется',
              'Выберите другой пресет или исправьте его объявление.');
          }
        } catch {
          let available = [];
          try { available = (await presets.list()).map((row) => row && row.id).filter(Boolean); } catch { available = []; }
          add('error', 'unknown-preset',
            'пресета «' + node.agentPreset + '» у узла «' + node.id + '» нет в DSH',
            available.length > 0 ? 'Доступны: ' + available.join(', ') + '.' : 'Объявите пресет или уберите agentPreset.');
        }
      }
      if (subagentProvider && (!subagentProvider.capabilities || subagentProvider.capabilities.agentPreset !== true)) {
        add('error', 'preset-unavailable', 'провайдер субагентов не умеет agentPreset',
          'Уберите agentPreset у узлов или используйте локальный spawn.');
      }
    }
  }
  return items;
}

/** Read a lazily provided service; an inactive scope must not throw through the route. */
function readRuntimeService(runtime, name) {
  try {
    const getter = runtime[name];
    return typeof getter === 'function' ? getter() : null;
  } catch {
    return null;
  }
}

/** Текст причины отказа службы: строка, а не «[object Object]». */
function reasonOf(error) {
  if (!error) return 'ошибка без описания';
  if (typeof error === 'string') return error;
  return error.message ? String(error.message) : String(error);
}

/*
 * Каталог моделей службы llm — единственный источник правды о том, какая
 * модель реально доступна. Панель не спрашивает провайдера напрямую и не
 * запоминает прошлый ответ: маршрут узла сверяется с каталогом на момент
 * чтения структуры. Ошибка службы не роняет чтение — она возвращается как
 * отказ с причиной, и маршрут получает статус unknown.
 */
function catalogProvider(row) {
  if (!row || typeof row.id !== 'string' || !row.id.trim()) return null;
  const id = row.id.trim();
  return {
    id,
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id,
    models: [],
  };
}

function catalogModel(row) {
  if (!row || typeof row.id !== 'string' || !row.id.trim()) return null;
  return {
    id: row.id.trim(),
    ...(typeof row.name === 'string' && row.name.trim() ? { name: row.name.trim() } : {}),
    ...(typeof row.family === 'string' && row.family.trim() ? { family: row.family.trim() } : {}),
  };
}

/** Каталог провайдеров и моделей службы llm; отказ службы — данные, а не исключение. */
async function readModelCatalog(runtime) {
  const llm = readRuntimeService(runtime, 'getLlm');
  if (!llm || typeof llm.listProviders !== 'function') {
    return { ok: false, at: localStamp(), providers: [], reason: 'служба llm не подключена' };
  }
  if (typeof llm.listModels !== 'function') {
    return { ok: false, at: localStamp(), providers: [], reason: 'служба llm не умеет listModels' };
  }
  let providers;
  try {
    providers = await llm.listProviders();
  } catch (error) {
    return { ok: false, at: localStamp(), providers: [], reason: 'служба llm не ответила: ' + reasonOf(error) };
  }
  if (!Array.isArray(providers)) {
    return { ok: false, at: localStamp(), providers: [], reason: 'служба llm вернула не список провайдеров' };
  }
  const rows = [];
  for (const provider of providers) {
    const row = catalogProvider(provider);
    if (!row) continue;
    let models;
    try {
      models = await llm.listModels(row.id);
    } catch (error) {
      return {
        ok: false,
        at: localStamp(),
        providers: [],
        reason: 'каталог моделей провайдера «' + row.id + '» не прочитан: ' + reasonOf(error),
      };
    }
    row.models = (Array.isArray(models) ? models : []).map(catalogModel).filter(Boolean);
    rows.push(row);
  }
  return { ok: true, at: localStamp(), providers: rows, reason: '' };
}

/**
 * Синхронная попытка прочитать тот же каталог.
 *
 * readGraph остаётся синхронным: его читают раскладка, планировщик и файловые
 * помощники задолго до того, как служба llm ответит. Служба, которая отвечает
 * промисами, синхронно не читается — такой ответ честно помечается pending, а
 * не выдаётся за каталог: иначе панель показала бы available там, где ничего
 * не проверено.
 */
function readModelCatalogNow(runtime) {
  const llm = readRuntimeService(runtime, 'getLlm');
  if (!llm || typeof llm.listProviders !== 'function') {
    return { ok: false, pending: false, at: localStamp(), providers: [], reason: 'служба llm не подключена' };
  }
  if (typeof llm.listModels !== 'function') {
    return { ok: false, pending: false, at: localStamp(), providers: [], reason: 'служба llm не умеет listModels' };
  }
  let providers;
  try {
    providers = llm.listProviders();
  } catch (error) {
    return { ok: false, pending: false, at: localStamp(), providers: [], reason: 'служба llm не ответила: ' + reasonOf(error) };
  }
  if (providers && typeof providers.then === 'function') {
    /* Отказ прочитает ожидающий вызов; без этого промис остался бы необработанным. */
    providers.catch(() => {});
    return { ok: false, pending: true, at: localStamp(), providers: [], reason: 'каталог моделей читается службой llm асинхронно' };
  }
  if (!Array.isArray(providers)) {
    return { ok: false, pending: false, at: localStamp(), providers: [], reason: 'служба llm вернула не список провайдеров' };
  }
  const rows = [];
  for (const provider of providers) {
    const row = catalogProvider(provider);
    if (!row) continue;
    let models;
    try {
      models = llm.listModels(row.id);
    } catch (error) {
      return {
        ok: false,
        pending: false,
        at: localStamp(),
        providers: [],
        reason: 'каталог моделей провайдера «' + row.id + '» не прочитан: ' + reasonOf(error),
      };
    }
    if (models && typeof models.then === 'function') {
      models.catch(() => {});
      return { ok: false, pending: true, at: localStamp(), providers: [], reason: 'каталог моделей читается службой llm асинхронно' };
    }
    row.models = (Array.isArray(models) ? models : []).map(catalogModel).filter(Boolean);
    rows.push(row);
  }
  return { ok: true, pending: false, at: localStamp(), providers: rows, reason: '' };
}

/**
 * Маршрут узла для ленты: объявленное имя + разрешённые provider/model.
 *
 * Решение 0054 (D5): после миграции графа node.model — идентификатор модели,
 * а объявленный маршрут хранится в node.modelAlias. Поэтому alias берётся из
 * modelAlias (иначе — прямая пара provider/model строкой), а provider/model —
 * из прямых полей узла, а не из models[alias]. models[alias] остаётся запасным
 * чтением для графа, который ещё не мигрирован (сырой вызов без buildGraph).
 *
 * Статус по-прежнему решает каталог службы llm: available|missing|unknown.
 * Дефолт не подставляется: узел без модели получает modelRoute: null.
 */
function modelRouteFor(node, models, catalog) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  let provider = typeof node.provider === 'string' ? node.provider.trim() : '';
  let model = typeof node.model === 'string' ? node.model.trim() : '';
  let family = typeof node.family === 'string' ? node.family.trim() : '';
  if (!provider && !model) return null;
  const declaredAlias = typeof node.modelAlias === 'string' ? node.modelAlias.trim() : '';
  /*
   * Старый граф до миграции: узел ссылается на алиас, а прямых полей нет.
   * Такое чтение остаётся рабочим — лента не делает вид, что маршрута нет.
   */
  let legacyAlias = '';
  if (!provider && model && models && Object.hasOwn(models, model)) {
    const declared = models[model];
    if (declared && typeof declared === 'object') {
      legacyAlias = model;
      provider = typeof declared.provider === 'string' ? declared.provider.trim() : '';
      model = typeof declared.model === 'string' ? declared.model.trim() : '';
      if (!family && typeof declared.family === 'string') family = declared.family.trim();
    }
  }
  const alias = declaredAlias || legacyAlias
    || (provider && model ? provider + '/' + model : model || provider);
  const route = { alias: alias || null, provider: provider || null, model: model || null, family: family || null };
  if (!provider || !model) {
    return { ...route, status: 'unknown', reason: 'алиас «' + (alias || '') + '» не объявлен в models' };
  }
  if (!catalog || catalog.ok !== true) {
    return { ...route, status: 'unknown', reason: (catalog && catalog.reason) || 'каталог моделей недоступен' };
  }
  const providerRow = catalog.providers.find((item) => item.id === provider);
  if (!providerRow) {
    return { ...route, status: 'missing', reason: 'провайдера «' + provider + '» нет в каталоге службы llm' };
  }
  const modelRow = providerRow.models.find((item) => item.id === model);
  if (!modelRow) {
    return { ...route, status: 'missing', reason: 'модели «' + model + '» нет у провайдера «' + provider + '» в каталоге службы llm' };
  }
  return { ...route, family: family || modelRow.family || null, status: 'available' };
}

/** Каждому узлу — маршрут на момент чтения; прежние поля узла не меняются. */
function applyModelRoutes(payload, catalog) {
  const graph = payload && payload.graph;
  if (!graph || !Array.isArray(graph.nodes)) return payload;
  const models = graph.models && typeof graph.models === 'object' ? graph.models : {};
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    node.modelRoute = modelRouteFor(node, models, catalog);
  }
  return payload;
}

/**
 * Дополнить ленту маршрутами и дать ожидающему читателю точный статус.
 *
 * Синхронный читатель получает то, что доказано синхронно. Если служба llm
 * отвечает промисами, у ленты появляется ненавязчивое завершение (не
 * перечисляемое свойство then): await readGraph(...) дожидается каталога и
 * получает available/missing, а синхронный доступ к payload.graph остаётся
 * прежним. Завершение не бросает: сбой службы оставляет честный unknown.
 */
function attachModelRoutes(payload, runtime) {
  const immediate = readModelCatalogNow(runtime);
  applyModelRoutes(payload, immediate);
  if (!immediate.pending) return payload;
  let completion = null;
  Object.defineProperty(payload, 'then', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(resolve, reject) {
      if (!completion) {
        completion = (async () => {
          try {
            applyModelRoutes(payload, await readModelCatalog(runtime));
          } catch {
            /* синхронный статус честнее выдуманного: ошибку службы уже видно в reason */
          }
        })();
      }
      completion.then(() => {
        /* Сначала снять завершение, потом отдать ленту: иначе ожидание уйдёт в себя. */
        delete payload.then;
        resolve(payload);
      }, reject);
    },
  });
  return payload;
}

/**
 * Read the live agents from the host's agents service.
 *
 * The host may hand over the service itself (with `list()`/`roots()`) or, in tests,
 * a plain array. A missing or broken service is not an exception: the route
 * answers 200 with an empty list and a recipe, because the panel must keep
 * working when the service is not there.
 *
 * @returns `{ available, agents, message? }`. `available: false` means the service was
 *   absent or could not answer; `agents: []` with `available: true` means it answered
 *   and there are simply no live agents.
 */
/**
 * Where the manual session pins live when the runtime names no file.
 *
 * The pin is a choice of a person, not a fact of the structure: it lives in the
 * profile folder, never in structure/*.json, so a pinned session does not rewrite
 * the graph and a stale pin is deleted by deleting one file.
 */
function defaultPinsFile() {
  return path.join(os.homedir(), '.dsh', 'project-graph', 'session-pins.json');
}

/**
 * Read the pin map `{ [root]: { node, session } }` for the live route.
 *
 * A missing file is the normal state — nobody pinned anything yet — so it is an
 * empty map without an error. A broken file is also an empty map, but the answer
 * says why: the panel then shows pins as unavailable instead of pretending the
 * person never chose a session. This function never throws.
 *
 * @param runtime - graph runtime; `pinsFile` overrides the profile default.
 * @returns `{ file, pins, count, error? }` where `error` is a human sentence.
 */
function readSessionPins(runtime) {
  const configured = runtime && typeof runtime.pinsFile === 'string' && runtime.pinsFile.trim()
    ? runtime.pinsFile.trim()
    : '';
  const file = configured ? path.resolve(configured) : defaultPinsFile();
  let pins = {};
  let error = null;
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (document && typeof document === 'object' && !Array.isArray(document)) pins = document;
    else error = 'файл пинов — не JSON-объект: ' + file;
  } catch (failure) {
    /* Отсутствие файла — не ошибка: пинов ещё не выбирали. */
    if (!failure || failure.code !== 'ENOENT') {
      error = 'файл пинов не прочитан: ' + (failure && failure.message ? failure.message : String(failure));
    }
  }
  return { file, pins, count: Object.keys(pins).length, ...(error ? { error } : {}) };
}

async function readLiveAgentRows(runtime) {
  let service = readRuntimeService(runtime, 'getAgents');
  try {
    if (service && typeof service.then === 'function') service = await service;
  } catch (error) {
    return { available: false, agents: [], message: error && error.message ? error.message : 'служба не ответила' };
  }
  if (!service) return { available: false, agents: [] };
  if (Array.isArray(service)) return { available: true, agents: service };
  const failures = [];
  for (const method of ['list', 'all', 'roots']) {
    if (typeof service[method] !== 'function') continue;
    try {
      let rows = service[method]();
      if (rows && typeof rows.then === 'function') rows = await rows;
      if (Array.isArray(rows)) return { available: true, agents: rows };
      failures.push(method + '() вернул не массив');
    } catch (error) {
      failures.push(method + '(): ' + (error && error.message ? error.message : String(error)));
    }
  }
  return {
    available: false,
    agents: [],
    message: failures.length > 0 ? failures.join('; ') : 'служба не умеет list()/roots()',
  };
}

function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function') { resolve(''); return; }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > limit) {
        const error = new Error('тело запроса больше ' + limit + ' байт');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(error));
  });
}

/**
 * Map a logical fragment name to the real file of this project's structure.
 *
 * Fragments are named `<structureDir>/<rel>` in both modes; the store resolver
 * says where that logical name really lies. A name that escapes the folder, or
 * that does not start with the logical prefix, is refused.
 */
function resolveStructureFile(root, runtime, relative) {
  const target = resolveStructure(root, runtime.structureDir);
  const prefix = target.structureDir + '/';
  const text = String(relative === undefined || relative === null ? '' : relative).replace(/\\/gu, '/');
  if (!text.startsWith(prefix)) return null;
  const dir = target.dir;
  const absolute = path.resolve(dir, text.slice(prefix.length));
  if (absolute !== dir && !absolute.startsWith(dir + path.sep)) return null;
  return absolute;
}

export function remedyFor(code) {
  return REMEDIES[code] || 'Исправьте файл structure/*.json и нажмите «Обновить».';
}

function withRemedy(problem) {
  return problem && typeof problem === 'object' ? { ...problem, fix: remedyFor(problem.code) } : problem;
}

export const API_PREFIX = '/project-graph';
/** Released bundle of the workflow console; used when the profile sets no spec. */
export const DEFAULT_WORKFLOW_INSTALL_SPEC =
  'https://github.com/AleksandrGoriachev/subagent-workflow/releases/latest/download/dsh-workflow-console.tgz';

export const PLUGIN_NAME = 'dsh-project-graph';

/**
 * Version of the package this module ships in.
 *
 * One truth per package: a release bumps `package.json`, and the panel,
 * `/api/status` and the letters read the version here instead of a hand-edited
 * constant that silently fell behind (0.2.0 against 1.0.2). The file is resolved
 * from this module through `import.meta.url` — never from the working directory,
 * which differs for the host, the CLI and the tests — and is read once, at module
 * evaluation, so every caller sees the same cached value.
 *
 * A broken package.json must not take the panel down: the version degrades to
 * `0.0.0` and exactly one warning goes to stderr for this load.
 */
function readPluginVersion() {
  const fallback = '0.0.0';
  const warn = (reason) => {
    process.stderr.write('[dsh-project-graph] package.json: ' + reason + ' — версия плагина ' + fallback + '\n');
  };
  try {
    const file = new URL('../package.json', import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const version = manifest && manifest.version;
    if (typeof version === 'string' && version.trim() !== '') return version.trim();
    warn('нет строкового поля version');
  } catch (error) {
    warn('не читается (' + (error && error.message ? error.message : String(error)) + ')');
  }
  return fallback;
}

export const PLUGIN_VERSION = readPluginVersion();

function samePath(left, right) {
  const a = path.resolve(String(left)).replace(/[\\/]+$/u, '');
  const b = path.resolve(String(right)).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function normalizeRoots(config) {
  const raw = [];
  if (Array.isArray(config && config.roots)) {
    for (const item of config.roots) if (typeof item === 'string' && item.trim()) raw.push(item.trim());
  }
  if (config && typeof config.root === 'string' && config.root.trim()) raw.push(config.root.trim());
  const roots = [];
  for (const item of raw) {
    if (!path.isAbsolute(item)) continue;
    const resolved = path.resolve(item);
    if (!roots.some((existing) => samePath(existing, resolved))) roots.push(resolved);
  }
  return roots;
}

function rootsFromRegistry(getter) {
  if (typeof getter !== 'function') return [];
  try {
    const registry = getter();
    if (!registry || typeof registry.list !== 'function') return [];
    const roots = [];
    for (const workspace of registry.list()) {
      const value = workspace && workspace.path;
      if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
      const resolved = path.resolve(value);
      if (!roots.some((existing) => samePath(existing, resolved))) roots.push(resolved);
    }
    return roots;
  } catch {
    return [];
  }
}

/**
 * Реестр воркспейсов: метка → канонический абсолютный путь (задание 0024).
 *
 * Источники, в порядке силы: карта `participants` профиля (подпись → путь),
 * реестр воркспейсов DSH (ctx.workspaceRegistry) и объявленные корни проекта.
 * Метка участника папки — подпись воркспейса; путь берётся отсюда, а не из тела
 * запроса, поэтому панель не может подсунуть чужой путь.
 *
 * @returns [{ label, path, name }] без повторов путей; метка уникальна,
 *   name — имя каталога воркспейса (path.basename(path)), панель показывает
 *   участника парой «метка (имя каталога)» (задание 0029).
 */
export function workspaceRegistry(runtime) {
  const rows = [];
  const push = (label, value) => {
    const name = typeof label === 'string' ? label.trim() : '';
    const target = typeof value === 'string' ? value.trim() : '';
    if (!name || !target || !path.isAbsolute(target)) return;
    const resolved = path.resolve(target);
    if (rows.some((row) => samePath(row.path, resolved))) return;
    if (rows.some((row) => row.label === name)) return;
    rows.push({ label: name, path: resolved, name: path.basename(resolved) });
  };
  const map = runtime && runtime.participants && typeof runtime.participants === 'object'
    ? runtime.participants
    : {};
  for (const [label, value] of Object.entries(map)) push(label, value);
  let listed = [];
  try {
    const registry = runtime && typeof runtime.getWorkspaceRegistry === 'function'
      ? runtime.getWorkspaceRegistry()
      : null;
    if (registry && typeof registry.list === 'function') listed = registry.list() || [];
  } catch {
    listed = [];
  }
  for (const workspace of listed) {
    const value = workspace && workspace.path;
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    if (rows.some((row) => samePath(row.path, resolved))) continue;
    const declared = ['label', 'name', 'title']
      .map((key) => (workspace && typeof workspace[key] === 'string' ? workspace[key].trim() : ''))
      .find(Boolean);
    push(declared || path.basename(resolved), resolved);
  }
  const roots = runtime && Array.isArray(runtime.roots) ? runtime.roots : [];
  for (const value of roots) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    if (rows.some((row) => samePath(row.path, resolved))) continue;
    push(path.basename(resolved), resolved);
  }
  return rows;
}

/**
 * Build the static runtime of the plugin: allowed roots, the structure folder
 * name and the plugin identity shown in the panel header.
 */
export function createGraphRuntime(config = {}, options = {}) {
  const structureDir = typeof config.structureDir === 'string' && config.structureDir.trim()
    ? config.structureDir.trim().replace(/[\\/]+$/u, '')
    : 'structure';
  const getWorkspaceRegistry = typeof options.getWorkspaceRegistry === 'function'
    ? options.getWorkspaceRegistry
    : null;
  let roots = normalizeRoots(config);
  if (roots.length === 0) roots = rootsFromRegistry(getWorkspaceRegistry);
  const runtime = {
    roots,
    structureDir,
    getWorkspaceRegistry,
    /* Where the run store persists; unset means the plugin's own data folder. */
    runsDir: typeof config.runsDir === 'string' && config.runsDir.trim() ? path.resolve(config.runsDir.trim()) : null,
    /*
     * Install spec of the workflow plugin. The profile layer can shadow the bundle
     * patch with a partial config (that is how the button once disappeared), so a
     * MISSING key falls back to the released asset, while an explicitly empty
     * string still means "the panel must not offer installation".
     */
    workflowInstallSpec: !Object.hasOwn(config || {}, 'workflowInstallSpec')
      ? DEFAULT_WORKFLOW_INSTALL_SPEC
      : (typeof config.workflowInstallSpec === 'string' && config.workflowInstallSpec.trim()
        ? config.workflowInstallSpec.trim()
        : null),
    /*
     * Engine links declared in the plugin config: engines.roots maps an absolute
     * workspace path to the repository that serves it. The raw value is kept even
     * when malformed: the resolver reads a broken declaration as "no link", so the
     * panel must see the shape as declared instead of a guess.
     */
    engines: config && Object.hasOwn(config, 'engines') ? config.engines : null,
    /* Exchange facts: configured folders and the label mapping of this team. */
    exchange: Array.isArray(config && config.exchange) ? config.exchange : [],
    participants: config && config.participants && typeof config.participants === 'object' ? config.participants : {},
    /*
     * Отдельная карта ТОЛЬКО для предупреждений обмена (задание 0052, WC-15).
     * Идентичность стороны ею не определяется: свои метки панель и квитанции
     * берут из runtime.participants (профиль), как и раньше. Иначе второй
     * аргумент createGraphRuntime молча менял бы подпись стороны: проверка 0047
     * передаёт участников вторым аргументом и ждёт в квитанции имя каталога
     * (split-optimizer), а не метку профиля (split).
     */
    warningParticipants: options && options.participants && typeof options.participants === 'object'
      ? options.participants
      : null,
    me: config && typeof config.me === 'string' && config.me.trim() ? config.me.trim() : null,
    /*
     * Which node represents the session that owns this structure. Declared, not
     * guessed: the panel may underline it while the session works, and without a
     * declaration it must not invent activity.
     */
    selfNode: config && typeof config.self === 'string' && config.self.trim() ? config.self.trim() : null,
    defaultRoot: roots.length > 0 ? roots[0] : null,
    plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION, graphVersion: GRAPH_VERSION },
    providerName: typeof options.providerName === 'string' && options.providerName.trim() ? options.providerName.trim() : 'spawn',
  };
  if (typeof options.getLlm === 'function') runtime.getLlm = options.getLlm;
  if (typeof options.getSubagents === 'function') runtime.getSubagents = options.getSubagents;
  if (typeof options.getPresets === 'function') runtime.getPresets = options.getPresets;
  /* Live agents of the host: the route maps them onto this project's nodes. */
  if (typeof options.getAgents === 'function') runtime.getAgents = options.getAgents;
  runtime.allowedRoots = () => {
    const list = [...roots];
    for (const candidate of rootsFromRegistry(getWorkspaceRegistry)) {
      if (!list.some((existing) => samePath(existing, candidate))) list.push(candidate);
    }
    return list;
  };
  return runtime;
}

/** Pick the requested root, or the default one; refuse anything unlisted. */
/**
 * Change a node's scheduled time (HH:MM) in the fragment that declares it.
 *
 * The schedule is part of the structure, so the panel edits the file instead of
 * keeping a private copy: the host scheduler reads the same file on every tick and
 * starts using the new time at once.
 */
export function saveSchedule(runtime, root, body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!input) {
    return { status: 400, error: 'тело расписания должно быть JSON-объектом', fix: 'Передайте { root, node, at: "HH:MM" }.' };
  }
  const nodeId = typeof input.node === 'string' ? input.node.trim() : '';
  const at = typeof input.at === 'string' ? input.at.trim() : '';
  const timeZone = typeof input.timeZone === 'string' && input.timeZone.trim() ? input.timeZone.trim() : null;
  if (!nodeId) return { status: 400, error: 'не указан узел', fix: 'Передайте node: "critic".' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(at)) {
    return { status: 400, error: 'время должно быть HH:MM в сутках 00:00–23:59', fix: 'Например: 09:00 или 21:30.' };
  }
  const payload = readGraph(runtime, root);
  if (!payload.exists) {
    return { status: 404, error: 'в проекте нет папки ' + runtime.structureDir + '/', fix: 'Создайте структуру, иначе менять расписание негде.' };
  }
  const node = payload.graph.nodes.find((item) => item.id === nodeId);
  if (!node) {
    return { status: 404, error: 'узла «' + nodeId + '» нет в структуре', fix: 'Обновите панель: узел мог быть переименован.' };
  }
  /*
   * A node created before this rule (or added by hand) may have no schedule yet. For
   * a critic the panel creates it on save: the card promises a run-time field, and a
   * node that cannot be scheduled is a dead end.
   */
  if (!node.schedule && !isCriticNode(node)) {
    return { status: 409, error: 'у узла «' + nodeId + '» нет расписания', fix: 'Расписание объявляется у критиков; этому узлу добавьте schedule в ' + (node.file || 'structure/*.json') + '.' };
  }
  const absolute = resolveStructureFile(root, runtime, node.file);
  if (!absolute) return { status: 400, error: 'файл узла вне папки структуры', fix: 'Проверьте structure/*.json.' };
  let document;
  let original;
  try {
    original = fs.readFileSync(absolute, 'utf8');
    document = JSON.parse(original);
  } catch (error) {
    return { status: 409, error: 'файл ' + node.file + ' не разбирается как JSON', fix: 'Исправьте файл вручную — панель не пишет в битый файл.' };
  }
  const target = Array.isArray(document && document.nodes) ? document.nodes.find((item) => item && item.id === nodeId) : null;
  if (!target) {
    return { status: 409, error: 'узел изменился во время сохранения', fix: 'Обновите панель и повторите.' };
  }
  if (!target.schedule) target.schedule = { at, timeZone: timeZone || 'Europe/Moscow' };
  else {
    target.schedule.at = at;
    if (timeZone) target.schedule.timeZone = timeZone;
  }
  try {
    writeFileAtomic(absolute, JSON.stringify(document, null, 2) + '\n');
  } catch (error) {
    return {
      status: 500,
      error: 'не удалось записать время запуска: ' + (error && error.message ? error.message : 'ошибка'),
      fix: 'Проверьте права на файлы structure/*.json и повторите.',
    };
  }
  return { status: 200, ok: true, root, node: nodeId, schedule: { at, timeZone: target.schedule.timeZone || null }, file: node.file };
}

/**
 * Bind a node to the session that owns it, or clear the binding.
 *
 * The binding is optional: delivery works without it by starting the addressee from a
 * live session. With it, the report reaches exactly that session — and the card shows
 * whether the session is still alive.
 */
export function saveSessionBinding(runtime, root, body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!input) return { status: 400, error: 'тело привязки должно быть JSON-объектом', fix: 'Передайте { root, node, session }.' };
  const nodeId = typeof input.node === 'string' ? input.node.trim() : '';
  const session = input.session === null || input.session === undefined ? null : String(input.session).trim();
  if (!nodeId) return { status: 400, error: 'не указан узел', fix: 'Передайте node: "coordinator".' };
  if (session !== null && session === '') return { status: 400, error: 'пустой идентификатор сессии', fix: 'Передайте session: "<id>" или session: null, чтобы отвязать.' };
  const payload = readGraph(runtime, root);
  if (!payload.exists) return { status: 404, error: 'в проекте нет структуры', fix: 'Создайте структуру, иначе привязывать нечего.' };
  const node = payload.graph.nodes.find((item) => item.id === nodeId);
  if (!node) return { status: 404, error: 'узла «' + nodeId + '» нет в структуре', fix: 'Обновите панель: узел мог быть переименован.' };
  const absolute = resolveStructureFile(root, runtime, node.file);
  if (!absolute) return { status: 400, error: 'файл узла вне папки структуры', fix: 'Проверьте structure/*.json.' };
  let document;
  let original;
  try {
    original = fs.readFileSync(absolute, 'utf8');
    document = JSON.parse(original);
  } catch {
    return { status: 409, error: 'файл ' + node.file + ' не разбирается как JSON', fix: 'Исправьте файл вручную.' };
  }
  const target = Array.isArray(document && document.nodes) ? document.nodes.find((item) => item && item.id === nodeId) : null;
  if (!target) return { status: 409, error: 'узел изменился во время сохранения', fix: 'Обновите панель и повторите.' };
  if (session === null) delete target.session;
  else target.session = session;
  try {
    writeFileAtomic(absolute, JSON.stringify(document, null, 2) + '\n');
  } catch (error) {
    return { status: 500, error: 'не удалось записать привязку: ' + (error && error.message ? error.message : 'ошибка'), fix: 'Проверьте права на structure/*.json.' };
  }
  return { status: 200, ok: true, root, node: nodeId, session, file: node.file };
}

/**
 * Участники папки общего обмена и их императив проверки.
 *
 * Обмен идёт не между двумя узлами, а между несколькими воркспейсами. Поэтому у узла
 * папки хранится список участников, а каждому участнику пишется спека с императивом
 * «проверяй папку на новые сообщения для тебя»: без этого добавленный воркспейс не
 * знает, что его ждут в обмене.
 */
export function saveExchangeParticipants(runtime, root, body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!input) return { status: 400, error: 'тело участников должно быть JSON-объектом', fix: 'Передайте { root, node, participants: [пути воркспейсов] }.' };
  const nodeId = typeof input.node === 'string' ? input.node.trim() : '';
  if (!nodeId) return { status: 400, error: 'не указан узел папки обмена', fix: 'Передайте node: "exchange-1".' };
  if (!Array.isArray(input.participants) || input.participants.length === 0) {
    return { status: 400, error: 'нужен хотя бы один участник обмена', fix: 'Передайте participants: ["C:/путь/воркспейса", …].' };
  }
  const payload = readGraph(runtime, root);
  if (!payload.exists) return { status: 404, error: 'в проекте нет структуры', fix: 'Создайте структуру.' };
  const node = payload.graph.nodes.find((item) => item.id === nodeId);
  if (!node) return { status: 404, error: 'узла «' + nodeId + '» нет в структуре', fix: 'Обновите панель.' };
  if (!/обмен/iu.test(String(node.role || ''))) {
    return { status: 409, error: 'узел «' + nodeId + '» — не папка обмена', fix: 'Участники есть только у узла с ролью «обмен».' };
  }
  const known = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
  const participants = [];
  for (const item of input.participants) {
    const value = String(item || '').trim();
    if (!value) continue;
    const match = known.find((candidate) => path.resolve(candidate).toLowerCase() === path.resolve(value).toLowerCase());
    if (!match) {
      return { status: 400, error: 'воркспейс «' + value + '» не открыт в панели', fix: 'Участник выбирается из списка воркспейсов панели: ' + known.join(', ') };
    }
    if (!participants.includes(match)) participants.push(match);
  }
  if (participants.length === 0) return { status: 400, error: 'после проверки не осталось участников', fix: 'Выберите хотя бы один воркспейс.' };
  const absolute = resolveStructureFile(root, runtime, node.file);
  if (!absolute) return { status: 400, error: 'файл узла вне папки структуры', fix: 'Проверьте structure/*.json.' };
  let document;
  try {
    document = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return { status: 409, error: 'файл ' + node.file + ' не разбирается как JSON', fix: 'Исправьте файл вручную.' };
  }
  const target = Array.isArray(document && document.nodes) ? document.nodes.find((item) => item && item.id === nodeId) : null;
  if (!target) return { status: 409, error: 'узел изменился во время сохранения', fix: 'Обновите панель.' };
  target.participants = participants;
  try {
    writeFileAtomic(absolute, JSON.stringify(document, null, 2) + '\n');
  } catch (error) {
    return { status: 500, error: 'не удалось записать участников: ' + (error && error.message ? error.message : 'ошибка'), fix: 'Проверьте права на structure/*.json.' };
  }
  /* Спека каждому участнику: императив проверять папку обмена. */
  const folder = exchangeDirs(root, runtime.exchange)[0] || path.join(path.dirname(root), 'coordination');
  const labels = participants.map((item) => {
    const configured = runtime.participants && typeof runtime.participants === 'object'
      ? Object.entries(runtime.participants).find(([, value]) => path.resolve(String(value)).toLowerCase() === path.resolve(item).toLowerCase())
      : null;
    return configured ? configured[0] : path.basename(item);
  });
  const written = [];
  const failures = [];
  participants.forEach((item, index) => {
    const line = 'Папка обмена: `' + folder.split(path.sep).join('/') + '`';
    const list = participants.map((other, position) => '- ' + labels[position] + ': `' + other.split(path.sep).join('/') + '`').join('\n');
    const spec = [
      '# Обмен между воркспейсами',
      '',
      '<!-- dsh-exchange:begin (блок обновляется панелью Structure) -->',
      line,
      '',
      'Участники:',
      list,
      '',
      '## Императив',
      '1. Перед началом работы и после каждого запуска проверяй папку обмена на новые сообщения для этого воркспейса: файлы, где From или To — его имя участника (' + labels[index] + ').',
      '2. Читай только шапки (From, To, Date, Thread, Status, Reply-To); тексты чужих сообщений не читай.',
      '3. На новое сообщение со Status: request отвечай в ту же ветку (Reply-To) сообщением со статусом по смыслу.',
      '4. Переписку между другими участниками не читай: она не твоя.',
      '<!-- dsh-exchange:end -->',
      '',
    ].join('\n');
    try {
      const file = path.join(item, 'docs', 'exchange.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, spec, 'utf8');
      written.push(file);
    } catch (error) {
      failures.push(item + ': ' + (error && error.message ? error.message : 'ошибка'));
    }
  });
  return { status: 200, ok: true, root, node: nodeId, participants, folder, written, failures };
}

/* ---------- папка обмена: создание, правка, удаление, контракт ---------- */

/** Формат контракта в ящике (docs/exchange-format.md §8). */
const CONTRACT_FORMAT = 'dsh-exchange/1-contract';
const CONTRACT_DEFAULT = 'contract.md';

/** Метка участника: объявленная метка остаётся, абсолютный путь сводится к метке профиля. */
function participantLabel(value, map) {
  const item = String(value || '').trim();
  if (!item) return '';
  if (!path.isAbsolute(item)) return item;
  const mapped = Object.entries(map || {}).find(([, target]) =>
    typeof target === 'string' && target.trim() && path.resolve(target) === path.resolve(item));
  return mapped ? mapped[0] : path.basename(item);
}

/** Метки участников папки без повторов: контракт и панель называют стороны одинаково. */
function folderParticipantLabels(runtime, participants) {
  const map = runtime && runtime.participants && typeof runtime.participants === 'object' ? runtime.participants : {};
  const labels = [];
  for (const item of Array.isArray(participants) ? participants : []) {
    const label = participantLabel(item, map);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Местная отметка времени с поясом: «2026-11-02T14:46+03:00», как в примере формата. */
function localStamp(date = new Date()) {
  const pad = (value) => String(Math.trunc(Math.abs(value))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    + sign + pad(Math.trunc(offset / 60)) + ':' + pad(offset % 60);
}

/** Шапка контракта: ровно те поля, по которым стороны договариваются (Rev, Initiator, Invited). */
function contractText({ dir, rev, initiator, invited, created }) {
  return [
    'Format: ' + CONTRACT_FORMAT,
    'Portal: ' + dir.split(path.sep).join('/'),
    'Rev: ' + rev,
    'Initiator: ' + initiator,
    'Invited: ' + invited.join(', '),
    'Created: ' + created,
    '',
  ].join('\n');
}

/** Поля уже лежащего контракта: ревизия, инициатор и дата создания переживают ревизию. */
function readContractFields(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const field = (name) => {
    const match = new RegExp('^' + name + ':[ \t]*(.*)$', 'im').exec(String(text || ''));
    return match ? match[1].trim() : '';
  };
  const rev = Number.parseInt(field('Rev'), 10);
  const invited = field('Invited')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    rev: Number.isInteger(rev) && rev > 0 ? rev : 0,
    initiator: field('Initiator'),
    invited,
    created: field('Created'),
  };
}

/**
 * Имя файла контракта: exchange.contract; по умолчанию contract-<id>.md (задание 0024).
 *
 * Имя уникально на папку: две папки одного ящика не могут делить один файл, и
 * умолчание не сталкивает folder-1 с folder-2. Явное имя проверяется отдельно.
 */
function contractNameOf(folder) {
  const exchange = folder && folder.exchange;
  const declared = exchange && typeof exchange === 'object' && typeof exchange.contract === 'string'
    ? exchange.contract.trim()
    : '';
  if (declared) return declared;
  const id = folder && typeof folder.id === 'string' && folder.id.trim() ? folder.id.trim() : '';
  return id ? 'contract-' + id + '.md' : CONTRACT_DEFAULT;
}

/** Строка реестра для метки: точное совпадение, затем без учёта регистра. */
function registryRowFor(runtime, label) {
  const wanted = String(label || '').trim();
  if (!wanted) return null;
  const rows = workspaceRegistry(runtime);
  return rows.find((row) => row.label === wanted)
    || rows.find((row) => row.label.toLowerCase() === wanted.toLowerCase())
    || null;
}

/**
 * Пути, записанные в структуре рядом с метками (запись папки в structure/*.json).
 *
 * lib/graph.js намеренно отдаёт панели только объявленные поля папки, поэтому
 * карта путей читается из того же файла, где лежит запись: у папки без paths
 * путь вычисляется из реестра (миграция из задания 0024).
 */
function storedFolderPaths(runtime, root, folder) {
  const relative = folder && typeof folder.file === 'string' && folder.file.trim()
    ? folder.file.trim()
    : runtime.structureDir + '/graph.json';
  const absolute = resolveStructureFile(root, runtime, relative);
  if (!absolute) return {};
  let document;
  try {
    document = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return {};
  }
  const list = document && Array.isArray(document.folders) ? document.folders : [];
  const raw = list.find((item) => item && item.id === folder.id);
  if (!raw || !raw.paths || typeof raw.paths !== 'object' || Array.isArray(raw.paths)) return {};
  const paths = {};
  for (const [label, value] of Object.entries(raw.paths)) {
    const name = String(label || '').trim();
    if (!name || typeof value !== 'string' || !path.isAbsolute(value.trim())) continue;
    paths[name] = path.resolve(value.trim());
  }
  return paths;
}

/**
 * Канонический путь каждого участника папки: реестр сильнее записанного пути.
 *
 * @returns { paths, unresolved } — paths = { метка: абсолютный путь }.
 */
function folderParticipantPaths(runtime, root, folder) {
  const stored = storedFolderPaths(runtime, root, folder);
  const paths = {};
  const unresolved = [];
  for (const label of folderParticipantLabels(runtime, folder && folder.participants)) {
    const row = registryRowFor(runtime, label);
    if (row) {
      paths[label] = row.path;
      continue;
    }
    if (stored[label]) {
      paths[label] = stored[label];
      continue;
    }
    unresolved.push(label);
  }
  return { paths, unresolved };
}

/**
 * Участники папки для ленты обмена (задание 0028, D3): пара «метка + каталог».
 *
 * path — абсолютный путь (реестр сильнее записанного рядом с меткой) или null,
 * name — имя каталога. Метка, которая не разрешается ни реестром, ни записанным
 * путём, остаётся в members с path: null и честно помечается в states как
 * unresolved — лента не прячет неизвестного участника.
 */
function exchangeMemberRows(runtime, root, folder) {
  const resolved = folderParticipantPaths(runtime, root, folder);
  const members = [];
  for (const label of folderParticipantLabels(runtime, folder && folder.participants)) {
    const target = resolved.paths[label] || null;
    members.push({ label, path: target, name: target ? path.basename(target) : null });
  }
  return members;
}

/**
 * Карта «метка → путь» для предупреждений обмена (задание 0052, WC-15).
 *
 * Объявленный профиль сильнее второго аргумента: options.participants — только
 * источник для проверки, а не новая идентичность стороны. Копия изолирует
 * предупреждения от runtime.participants, которым живут квитанции и панель.
 */
function warningParticipantMap(runtime) {
  const declared = runtime && runtime.participants && typeof runtime.participants === 'object'
    ? runtime.participants
    : {};
  const extra = runtime && runtime.warningParticipants && typeof runtime.warningParticipants === 'object'
    ? runtime.warningParticipants
    : {};
  return { ...extra, ...declared };
}

/**
 * Почему ящик участника не читается (задание 0052, WC-15).
 *
 * Участник папки, не разрешённый в воркспейс, остаётся в ленте — но пустой ящик
 * нельзя выдавать за факт «0 писем»: панель обязана назвать причину и рецепт.
 * Разрешение даёт только объявление пути: карта participants профиля
 * (метка → абсолютный путь), путь, записанный рядом с меткой в структуре или
 * реестре, либо корень из roots, названный этой меткой. README ящика разрешением
 * НЕ является: таблица в ящике объявляет соседа, но не даёт права читать его
 * каталог — иначе предупреждение не возникло бы никогда, ведь свой ящик
 * перечисляет все стороны (проверка C1 задания это и требует).
 *
 * Читающая сторона не судит о себе: её собственный ящик открыт по определению.
 */
function exchangeUnresolvedWarnings(runtime, root, folder, members, self) {
  const map = warningParticipantMap(runtime);
  const allowed = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
  const here = path.resolve(String(root || '.'));
  const me = runtime && typeof runtime.me === 'string' ? runtime.me.trim().toLowerCase() : '';
  const own = self && typeof self.label === 'string' ? self.label.trim().toLowerCase() : '';
  const warnings = [];
  for (const member of Array.isArray(members) ? members : []) {
    const label = member && typeof member.label === 'string' ? member.label.trim() : '';
    if (!label) continue;
    const lower = label.toLowerCase();
    if ((own && lower === own) || (me && lower === me)) continue;
    const declared = typeof map[label] === 'string' && map[label].trim() ? path.resolve(map[label].trim()) : '';
    const stored = typeof member.path === 'string' && member.path.trim() ? path.resolve(member.path) : '';
    /* Объявленный путь этой стороны — мы сами, а не чужой нечитаемый ящик. */
    if ((declared && sameExchangePath(declared, here)) || (stored && sameExchangePath(stored, here))) continue;
    const rooted = allowed
      .filter((item) => typeof item === 'string' && item.trim())
      .find((item) => path.basename(path.resolve(item)).toLowerCase() === lower);
    if (declared || stored || rooted) continue;
    warnings.push({
      code: 'participant-unresolved',
      label,
      message: 'участник «' + label + '» не в roots/participants — его ящик не читается',
      fix: 'добавьте ' + label + ' в roots и participants профиля (cordis.patch.yml)',
    });
  }
  return warnings;
}

/**
 * Same path on this platform (задание 0031, D4).
 *
 * Windows compares paths without case, POSIX compares them with case. Deciding
 * by the running file system keeps one rule for the panel, the guard and the
 * exchange box instead of a single "always lowercase" shortcut.
 */
function sameExchangePath(left, right) {
  const fold = (value) => {
    const resolved = path.resolve(String(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return fold(left) === fold(right);
}

/**
 * Paths a label is ALLOWED to have, without guessing (задание 0031, D5).
 *
 * Sources, strongest first: the profile participants map (label → absolute path),
 * a workspace registry row with a declared label, and the path stored next to the
 * label in the structure. A bare workspace root is NOT a source: its directory
 * name is not a declaration, so it cannot make a folder recognize this side.
 */
function declaredExchangePaths(runtime, root, folder) {
  const declared = new Map();
  const map = runtime && runtime.participants && typeof runtime.participants === 'object' ? runtime.participants : {};
  const add = (label, value) => {
    const name = typeof label === 'string' ? label.trim() : '';
    const target = typeof value === 'string' ? value.trim() : '';
    if (!name || !target || !path.isAbsolute(target) || declared.has(name)) return;
    declared.set(name, path.resolve(target));
  };
  for (const [label, value] of Object.entries(map)) add(label, value);
  let listed = [];
  try {
    const registry = runtime && typeof runtime.getWorkspaceRegistry === 'function' ? runtime.getWorkspaceRegistry() : null;
    if (registry && typeof registry.list === 'function') listed = registry.list() || [];
  } catch {
    listed = [];
  }
  for (const workspace of listed) {
    const label = ['label', 'name', 'title']
      .map((key) => (workspace && typeof workspace[key] === 'string' ? workspace[key].trim() : ''))
      .find(Boolean);
    add(label, workspace && typeof workspace.path === 'string' ? workspace.path : '');
  }
  for (const [label, value] of Object.entries(storedFolderPaths(runtime, root, folder))) add(label, value);
  return declared;
}

/**
 * Which side of a folder is THIS workspace (задание 0030 D2, уточнено 0031 D5).
 *
 * self = { label, path } — the label under which this workspace is known in the
 * folder and its absolute path. null means the folder does not recognize us:
 * then the panel must not apply the 409 "not your turn" rule and says so instead
 * of guessing a side. Two sources only: a participant label whose ALLOWED path
 * is this workspace, and the declared runtime.me. The directory name of the root
 * is not evidence: "alpha" as a label and "alpha" as a folder name are different
 * facts, and the panel invented a side from the second one.
 */
function exchangeSelfRow(runtime, root, folder, members) {
  const here = path.resolve(root);
  const labels = folderParticipantLabels(runtime, folder && folder.participants);
  const declared = declaredExchangePaths(runtime, root, folder);
  for (const label of labels) {
    const target = declared.get(label);
    if (target && sameExchangePath(target, here)) return { label, path: here };
  }
  const me = runtime && typeof runtime.me === 'string' && runtime.me.trim()
    ? runtime.me.trim().toLowerCase()
    : '';
  if (me) {
    const byDeclaration = labels.find((label) => label.toLowerCase() === me);
    if (byDeclaration) return { label: byDeclaration, path: here };
  }
  return null;
}

/**
 * Похожие метки реестра: подстрока и расстояние правки; список всегда непустой,
 * когда реестр не пуст, — человеку нужен адрес, а не констатация «нет».
 */
function similarParticipantLabels(runtime, label) {
  const wanted = String(label || '').trim().toLowerCase();
  const rows = workspaceRegistry(runtime);
  if (rows.length === 0) return [];
  const distance = (left, right) => {
    const a = Array.from(left);
    const b = Array.from(right);
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const kept = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = kept;
      }
    }
    return row[b.length];
  };
  const scored = rows.map((row) => {
    const name = row.label.toLowerCase();
    const substring = wanted && (name.includes(wanted) || wanted.includes(name)) ? 0 : 1;
    return { label: row.label, score: distance(wanted, name), substring };
  });
  scored.sort((left, right) => (left.substring - right.substring) || (left.score - right.score));
  const close = scored.filter((item) => item.substring === 0
    || item.score <= Math.max(2, Math.ceil(Array.from(wanted).length / 3)));
  const picked = (close.length > 0 ? close : scored.slice(0, 5)).map((item) => item.label);
  return picked.slice(0, 6);
}

/**
 * Пустая ветка threads в уже существующих ящиках папки (задание 0024, D3).
 *
 * Отказ по неразрешённой метке не пишет ни контракта, ни письма. Но отказ не
 * должен и прятать объявленный ящик: если каталог обмена уже есть на диске,
 * в нём остаётся пустая ветка threads — готовое место для писем. Новых
 * каталогов отказ не создаёт: он не меняет диск больше, чем разрешённая
 * ревизия. Общий ящик участников того же имени тоже готовится, если он уже
 * существует: папку читают с обеих сторон, и «писем нет» должно быть видно
 * из любого из них.
 */
function prepareMailBranch(runtime, root, folder) {
  const candidates = [];
  const target = folderContractTarget(runtime, root, folder);
  if (target && typeof target.dir === 'string') candidates.push(target.dir);
  const box = folder && folder.box && typeof folder.box.path === 'string' ? folder.box.path.trim() : '';
  if (box && !path.isAbsolute(box) && !box.split(/[\\/]/u).includes('..')) {
    try {
      const allowed = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [root];
      const declared = declaredExchangeWorkspaces(runtime, allowed);
      for (const scope of [allowed, declared]) {
        const shared = scope.length > 0 ? commonParent(scope) : '';
        if (shared) candidates.push(path.resolve(shared, box));
      }
    } catch {
      /* общий ящик необязателен: его может не быть */
    }
  }
  for (const dir of candidates) {
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      fs.mkdirSync(path.join(dir, 'threads'), { recursive: true });
    } catch {
      /* каталога нет — готовить нечего и создавать нечего */
    }
  }
}

/** Ящик объявленной папки: каталог или null, если путь не разрешается. */
function folderContractBox(runtime, root, folder) {
  const target = folderContractTarget(runtime, root, folder);
  return target && typeof target.dir === 'string' ? target.dir : null;
}

/** Свободное имя контракта в этом ящике: contract-<id>.md, contract-<id>-2.md, … */
function freeContractName(runtime, root, folder, dir) {
  const taken = new Set();
  let folders = [];
  try {
    const payload = readGraph(runtime, root);
    folders = payload && payload.graph && Array.isArray(payload.graph.folders) ? payload.graph.folders : [];
  } catch {
    folders = [];
  }
  for (const other of folders) {
    if (!other || other.id === folder.id || other.exchange === false) continue;
    const otherDir = folderContractBox(runtime, root, other);
    if (!otherDir || !samePath(otherDir, dir)) continue;
    taken.add(contractNameOf(other).toLowerCase());
  }
  const id = folder && typeof folder.id === 'string' && folder.id.trim() ? folder.id.trim() : 'folder';
  let candidate = 'contract-' + id + '.md';
  let index = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = 'contract-' + id + '-' + index + '.md';
    index += 1;
  }
  return candidate;
}

/**
 * Имя контракта уникально на папку в одном ящике (задание 0024, D4).
 *
 * @returns Отказ 409 с рецептом и свободным именем или null, когда имя свободно.
 */
function contractNameClash(runtime, root, folder, folders) {
  if (!folder || folder.exchange === false) return null;
  const name = contractNameOf(folder);
  const dir = folderContractBox(runtime, root, folder);
  if (!dir) return null;
  for (const other of Array.isArray(folders) ? folders : []) {
    if (!other || other.id === folder.id || other.exchange === false) continue;
    if (contractNameOf(other).toLowerCase() !== name.toLowerCase()) continue;
    const otherDir = folderContractBox(runtime, root, other);
    if (!otherDir || !samePath(otherDir, dir)) continue;
    const free = freeContractName(runtime, root, folder, dir);
    return {
      status: 409,
      code: 'contract-name-taken',
      error: 'имя контракта «' + name + '» уже занято папкой «' + other.id + '» в том же ящике: две папки не делят один файл',
      fix: 'Дайте папке своё имя контракта, свободное — «' + free + '»: имя уникально на папку.',
      free,
    };
  }
  return null;
}

/** Ящик папки, разрешённый тем же lib/boxes.js, что читают сторож и CLI. */
function folderBoxDir(runtime, root, folder) {
  const allowed = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [root];
  const declared = declaredExchangeWorkspaces(runtime, allowed);
  const scope = declared.length > 0 ? declared : allowed;
  return resolveBox({ root, folder, roots: scope });
}

/**
 * Ящик и файл контракта одной папки; причина и рецепт, если путь не разрешается.
 *
 * Код отказа резолвера (shared-ambiguous, duplicate-box, box-path-invalid, …)
 * уходит в ответ панели: текста «нельзя» мало, причина должна быть машинной.
 */
function folderContractTarget(runtime, root, folder) {
  const box = folderBoxDir(runtime, root, folder);
  if (box.code === 'box-missing') {
    return { status: 400, code: 'box-missing', error: 'у папки «' + folder.id + '» не объявлен box: где лежит ящик обмена', fix: 'Задайте box: { "path": "coordination", "root": "shared" }.' };
  }
  if (box.status !== 'ok' || !box.path) {
    return {
      status: 400,
      code: box.code || 'box-error',
      error: box.message,
      fix: 'Поставьте box.root: "workspace" (ящик внутри своего воркспейса) или откройте в панели второго участника для общего корня.',
      ...(Array.isArray(box.candidates) ? { candidates: box.candidates } : {}),
    };
  }
  return { dir: box.path, file: path.join(box.path, contractNameOf(folder)) };
}

/* Запись идёт через общую атомарную функцию: временное имя уникально, rename повторяется. */

/** Формат квитанции папки (docs/exchange-format.md §4, §8): документ обмена, не отчёт. */
const RECEIPT_FORMAT = 'dsh-exchange/1';
const RECEIPT_THREAD_FALLBACK = 'critic-report';
/** Сколько байт письма достаточно, чтобы прочитать шапку: тело не читается. */
const RECEIPT_HEADER_BYTES = 8192;

/**
 * Метка нашей стороны в квитанциях и письмах движка (задание 0085).
 *
 * Источники, в порядке силы:
 *   1. явный runtime.me — профиль сказал, как нас зовут;
 *   2. ключ карты runtime.participants, чей путь совпадает с нашим корнем
 *      (нормализованные пути: регистр и слэши не важны — samePath);
 *   3. имя каталога корня — прежнее поведение 0047.
 *
 * options.invitation — контракт, на который отвечаем отказом: если карты нет
 * ВОВСЕ, приглашённая метка контракта и есть наше имя, а имя каталога подписало
 * бы отказ чужим именем (дефект, ради которого выпущено задание). При живой
 * карте, где нашего корня нет, контракт не подставляется: профиль уже ответил
 * «мы не объявлены», и подпись приглашённой меткой была бы догадкой.
 *
 * declared: false означает «карта объявлена, а нашего корня в ней нет»: ответ
 * операции обязан нести предупреждение identity-not-declared, а не молчать.
 */
function sideIdentity(runtime, root, options = {}) {
  const here = path.resolve(String(root));
  const declared = runtime && typeof runtime.me === 'string' ? runtime.me.trim() : '';
  if (declared) return { label: declared, source: 'me', declared: true };
  const map = runtime && runtime.participants && typeof runtime.participants === 'object'
    ? runtime.participants
    : {};
  const labels = Object.keys(map).filter((label) => typeof map[label] === 'string' && path.isAbsolute(String(map[label]).trim()));
  for (const label of labels) {
    if (samePath(map[label], here)) return { label, source: 'participants', declared: true };
  }
  const contract = options && options.invitation;
  if (labels.length === 0 && contract && Array.isArray(contract.invited)) {
    const invited = contract.invited.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
    const initiator = typeof contract.initiator === 'string' ? contract.initiator.trim() : '';
    if (invited.length === 1 && invited[0] !== initiator) {
      return { label: invited[0], source: 'invitation', declared: true };
    }
  }
  return { label: path.basename(here), source: 'directory', declared: labels.length === 0 };
}

/** Прежняя сигнатура резолвера: только метка строкой. */
function workspaceLabel(runtime, root) {
  return sideIdentity(runtime, root).label;
}

/** Предупреждение ответа операции, когда нашего корня нет в объявленной карте (0085). */
function identityWarnings(identity) {
  if (!identity || identity.declared !== false) return [];
  return [{
    code: 'identity-not-declared',
    label: identity.label,
    message: 'наш корень не объявлен в карте participants: квитанция подписана «' + identity.label + '» — именем каталога',
    fix: 'Добавьте наш корень в participants (cordis.patch.yml) под меткой контракта или задайте me: иначе партнёр видит чужую метку и держит нас непринятыми.',
  }];
}

/** Первая ветка, уже объявленная каталогом threads/* в ящике, или '' — ветки ещё нет. */
function declaredThreadOf(boxDir) {
  try {
    const entries = fs.readdirSync(path.join(boxDir, 'threads'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    return entries.length > 0 ? entries[0] : '';
  } catch {
    return '';
  }
}

/** Первая ветка папки: exchange.threads, иначе первая объявленная, иначе умолчание. */
function firstThreadOf(folder, boxDir) {
  const declared = folder && folder.exchange && Array.isArray(folder.exchange.threads)
    ? folder.exchange.threads.filter((item) => typeof item === 'string' && item.trim())
    : [];
  if (declared.length > 0) return declared[0].trim();
  return declaredThreadOf(boxDir) || RECEIPT_THREAD_FALLBACK;
}

/** Ветки из объекта exchange: непустые строки, без повторов, в порядке объявления. */
function exchangeThreadsOf(exchange) {
  if (!exchange || typeof exchange !== 'object' || Array.isArray(exchange)) return [];
  if (!Array.isArray(exchange.threads)) return [];
  const threads = [];
  for (const item of exchange.threads) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (text && !threads.includes(text)) threads.push(text);
  }
  return threads;
}

/**
 * Ветка, в которой лежит письмо: родительский каталог внутри threads/*.
 *
 * Формат §3 кладёт письмо в threads/<ветка>/<файл>.md, поэтому каталог письма и
 * есть ветка. Поле Thread шапки — резерв для письма, положенного прямо в threads/
 * (и согласованность с Ref, по которому письмо ищут).
 */
function letterThreadOf(boxDir, head) {
  let relative = '';
  try {
    relative = path.relative(boxDir, head.file);
  } catch {
    relative = '';
  }
  if (relative && !path.isAbsolute(relative) && !relative.startsWith('..')) {
    const parts = relative.split(path.sep);
    if (parts.length >= 3 && parts[0].toLowerCase() === 'threads') return parts[1];
  }
  const declared = typeof head.thread === 'string' ? head.thread.trim() : '';
  if (declared && declared !== '.' && declared !== '..'
    && !declared.includes('/') && !declared.includes('\\')) return declared;
  return '';
}

/**
 * Метки этой стороны по README ящика: таблица «метка → воркспейс» (формат §2).
 *
 * Реестр профиля может быть не передан join (приглашённый открыл панель без
 * второго воркспейса), а README канала — факт ящика: по нему и приглашение
 * адресовано стороне, и путь стороны известен.
 */
function boxLabelsFor(boxDir, root) {
  const labels = [];
  let text = '';
  try {
    text = fs.readFileSync(path.join(boxDir, 'README.md'), 'utf8');
  } catch {
    return labels;
  }
  for (const match of text.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gmu)) {
    const label = match[1].trim();
    const value = match[2].trim();
    if (label && path.isAbsolute(value) && samePath(value, root) && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Адреса этой стороны для поля To: метка профиля, метка папки, README ящика и имя каталога. */
function letterAddressesFor(runtime, root, labels, boxDir) {
  const here = path.resolve(String(root));
  const addresses = [];
  const add = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text && !addresses.some((item) => item.toLowerCase() === text.toLowerCase())) addresses.push(text);
  };
  add(runtime && typeof runtime.me === 'string' ? runtime.me : '');
  add(participantLabel(here, runtime && runtime.participants));
  for (const label of boxLabelsFor(boxDir, here)) add(label);
  add(here);
  add(path.basename(here));
  for (const label of Array.isArray(labels) ? labels : []) {
    const row = registryRowFor(runtime, label);
    if (row && samePath(row.path, here)) add(label);
  }
  return addresses;
}

/**
 * Ветка письма-приглашения для этой папки (задание 0051, D1; задание 0064).
 *
 * В ящике бывает несколько веток threads/*, и первая по порядку каталога — не
 * доказательство того, что приглашённую сторону позвали именно туда. Приглашение
 * — письмо со Status: invitation (или с Ref на контракт этой папки), адресованное
 * этой стороне (To = её метка или путь). В ящике с двумя папками лежат приглашения
 * обеим, поэтому одного «самого позднего приглашения стороны» мало: сначала
 * берутся письма, чей Ref нормализованно равен контракту этой папки
 * (normalizeLetterRef, contractRef). Только если приглашения своей папки нет,
 * берётся любое приглашение этой стороне — совместимость со старым форматом без
 * Ref, порядок по времени сохраняется. Ветка приглашения — каталог письма;
 * из нескольких берётся самое позднее. Пустая строка — приглашения нет.
 */
function invitationThreadOf(boxDir, addresses, contractRef) {
  const wantedLabels = new Set(
    (Array.isArray(addresses) ? addresses : [])
      .filter((item) => typeof item === 'string' && !path.isAbsolute(item))
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  const wantedPaths = new Set(
    (Array.isArray(addresses) ? addresses : [])
      .filter((item) => typeof item === 'string' && path.isAbsolute(item))
      .map((item) => normalizeLetterRef(item)),
  );
  const contracts = (Array.isArray(contractRef) ? contractRef : [contractRef])
    .map((item) => normalizeLetterRef(item))
    .filter(Boolean);
  const invitations = [];
  for (const entry of messageFiles([boxDir])) {
    const head = readLetterHead(entry.file);
    if (!head || !head.to) continue;
    const status = String(head.status || '').toLowerCase();
    const ref = normalizeLetterRef(head.ref);
    const contractHit = contracts.length > 0
      && contracts.some((name) => ref === name || ref.endsWith('/' + name));
    if (status !== 'invitation' && !contractHit) continue;
    const addressed = String(head.to).split(/[,;]/u)
      .map((item) => item.trim())
      .filter(Boolean)
      .some((item) => wantedLabels.has(item.toLowerCase())
        || (path.isAbsolute(item) && wantedPaths.has(normalizeLetterRef(item))));
    if (!addressed) continue;
    const thread = letterThreadOf(boxDir, head);
    if (!thread) continue;
    invitations.push({ thread, at: head.at, mtime: Number(entry.mtimeMs) || 0, status, contractHit });
  }
  if (invitations.length === 0) return '';
  /*
   * Приоритет — приглашение своей папки: Ref письма адресует её контракт. Если
   * такого нет, остаётся прежний выбор любого приглашения этой стороне (0051).
   */
  const own = invitations.filter((item) => item.status === 'invitation' && item.contractHit);
  const pool = own.length > 0 ? own : invitations;
  const best = pool.reduce((newest, item) => {
    if (!newest) return item;
    if (item.at > newest.at) return item;
    if (item.at === newest.at && item.mtime > newest.mtime) return item;
    return newest;
  }, null);
  return best ? best.thread : '';
}

/**
 * Положить в ящик одно письмо-квитанцию и вернуть его путь относительно ящика.
 *
 * Имя — по формату §3: <дата>T<ЧЧ-ММ±ЧЧ-ММ>--<автор>--<NN>.md, номер — следующий
 * свободный у этого автора, а не «сколько файлов лежит»: две квитанции в одну
 * секунду не должны затирать друг друга.
 */
function writeReceipt(boxDir, thread, fields) {
  const dir = path.join(boxDir, 'threads', thread);
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date();
  const stamp = localStamp(at).replace(/:/gu, '-');
  const from = fields.from;
  let counter = Number.parseInt(nextLetterNumber(dir, from), 10);
  if (!Number.isInteger(counter) || counter < 1) counter = 1;
  let name = stamp + '--' + from + '--' + String(counter).padStart(2, '0') + '.md';
  let absolute = path.join(dir, name);
  while (fs.existsSync(absolute)) {
    counter += 1;
    name = stamp + '--' + from + '--' + String(counter).padStart(2, '0') + '.md';
    absolute = path.join(dir, name);
  }
  /*
   * Дополнительные поля шапки идут между Ref и Subject: так приглашение несёт
   * Rev и Box (задание 0020), а квитанция — ровно те же восемь полей, что и раньше.
   */
  const extra = Array.isArray(fields.extra) ? fields.extra.filter((line) => typeof line === 'string' && line.trim()) : [];
  const head = [
    'Format: ' + RECEIPT_FORMAT,
    'From: ' + from,
    'To: ' + fields.to,
    'Date: ' + localStamp(at),
    'Thread: ' + thread,
    'Status: ' + fields.status,
    'Session: ' + fields.session,
    'Ref: ' + fields.ref,
    ...extra,
    'Subject: ' + fields.subject,
    '',
  ].join('\n');
  fs.writeFileSync(absolute, head + fields.body + '\n', 'utf8');
  return path.relative(boxDir, absolute).split(path.sep).join('/');
}

/** Сессия автора квитанции: тело запроса, затем env DSH_SESSION_ID, затем честная заглушка. */
function receiptSession(input) {
  const fromBody = input && typeof input.session === 'string' ? input.session.trim() : '';
  if (fromBody) return normalizeSession(fromBody);
  const fromEnv = typeof process !== 'undefined' && process.env && typeof process.env.DSH_SESSION_ID === 'string'
    ? process.env.DSH_SESSION_ID.trim()
    : '';
  /* Голый uuid — та же сессия, что session-<uuid>: формат §4 требует форму session-. */
  return fromEnv ? normalizeSession(fromEnv) : 'session-unknown';
}

/** Шапка одного письма: только заголовки, тело не читается. */
function readLetterHead(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(RECEIPT_HEADER_BYTES);
    const read = fs.readSync(fd, buffer, 0, RECEIPT_HEADER_BYTES, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const header = {};
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) break;
      const match = /^([A-Za-z][A-Za-z-]*):\s*(.+?)\s*$/u.exec(line);
      if (match) header[match[1]] = match[2];
    }
    const from = (header.From || '').trim();
    if (!from) return null;
    const at = Date.parse((header.Date || '').trim());
    return {
      file,
      from,
      /* To нужен join: письмо-приглашение адресовано этой стороне (задание 0051). */
      to: (header.To || '').trim(),
      /* Ref адресует контракт папки (или собственную квитанцию): по нему письмо и относится к папке. */
      ref: (header.Ref || '').trim(),
      thread: (header.Thread || '').trim(),
      status: (header.Status || '').trim(),
      at: Number.isFinite(at) ? at : 0,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Квитанции одного автора в ящике, самые новые первыми.
 *
 * В одном ящике лежат письма нескольких папок, поэтому одной метки автора мало
 * (задание 0063): при переданном contractRef остаются только квитанции, чей Ref
 * нормализованно равен контракту этой папки (normalizeLetterRef). Без contractRef
 * поведение прежнее — все квитанции автора: так вызывают совместимые места.
 */
function ownReceipts(boxDir, label, contractRef) {
  const wanted = String(label || '').trim().toLowerCase();
  if (!wanted) return [];
  const wantedRef = normalizeLetterRef(contractRef);
  return messageFiles([boxDir])
    .map((entry) => readLetterHead(entry.file))
    .filter((item) => item && item.from.toLowerCase() === wanted
      && item.status.toLowerCase() === 'accepted'
      && (!wantedRef || normalizeLetterRef(item.ref) === wantedRef))
    .sort((left, right) => right.at - left.at);
}

/** Путь из шапки письма сравнивается без разделителей, регистра и ведущего «./». */
function normalizeLetterRef(value) {
  return String(value || '').trim().replace(/\\/gu, '/').replace(/^\.\//u, '').toLowerCase();
}

/**
 * Последний ответ стороны по контракту одной папки: accepted или disconnected
 * (задание 0047, D2).
 *
 * В одном ящике лежат письма нескольких папок, поэтому одной метки автора мало:
 * Ref квитанции accepted адресует контракт папки, а Ref отключения — собственную
 * квитанцию (docs/exchange-format.md §8). Квитанция ищется по контракту,
 * отключение — по ссылке на такую квитанцию или на тот же контракт: письма чужой
 * папки состояние этой не меняют. Возвращается самое позднее письмо (Date, затем
 * время записи файла — квитанция и отключение бывают в одну минуту).
 */
function ownFolderAnswer(boxDir, label, contractRef) {
  const author = String(label || '').trim().toLowerCase();
  if (!author) return null;
  const wanted = normalizeLetterRef(contractRef);
  const heads = [];
  for (const entry of messageFiles([boxDir])) {
    const head = readLetterHead(entry.file);
    if (!head) continue;
    if (String(head.from || '').trim().toLowerCase() !== author) continue;
    heads.push({
      ...head,
      mtime: Number(entry.mtimeMs) || 0,
      relative: normalizeLetterRef(path.relative(boxDir, head.file)),
    });
  }
  const accepted = heads.filter((head) => String(head.status || '').toLowerCase() === 'accepted'
    && (!wanted || normalizeLetterRef(head.ref) === wanted));
  const ownReceiptPaths = new Set(accepted.map((head) => head.relative));
  const answers = heads.filter((head) => {
    const status = String(head.status || '').toLowerCase();
    if (status === 'accepted') return accepted.includes(head);
    if (status !== 'disconnected') return false;
    const ref = normalizeLetterRef(head.ref);
    return ownReceiptPaths.has(ref) || (wanted !== '' && ref === wanted);
  });
  if (answers.length === 0) return null;
  return answers.reduce((newest, head) => {
    if (!newest) return head;
    if (head.at > newest.at) return head;
    if (head.at === newest.at && head.mtime > newest.mtime) return head;
    return newest;
  }, null);
}

/**
 * Ответил ли участник на приглашение: квитанция accepted или отключение disconnected.
 * Обе означают «приглашать больше не нужно» (задание 0020).
 */
function hasAnyReceipt(boxDir, label) {
  const wanted = String(label || '').trim().toLowerCase();
  if (!wanted) return false;
  return messageFiles([boxDir]).some((entry) => {
    const head = readLetterHead(entry.file);
    if (!head || String(head.from).toLowerCase() !== wanted) return false;
    const status = String(head.status || '').toLowerCase();
    return status === 'accepted' || status === 'disconnected';
  });
}

/**
 * Письма-приглашения после записи контракта (Rev+1).
 *
 * Приглашается каждый участник папки, кроме инициатора и того, кто уже ответил
 * квитанцией accepted или отключением disconnected. Приглашение несёт Rev новой
 * ревизии и абсолютный путь ящика (Box): без него приглашённый не знает, куда
 * подключаться, а вывести путь из метки нельзя.
 */
function invitationLetters(runtime, folder, target, contract, session) {
  const labels = folderParticipantLabels(runtime, folder.participants);
  const initiator = contract.initiator || labels[0] || '';
  const labelsToInvite = labels.filter((label) => label !== initiator);
  const thread = firstThreadOf(folder, target.dir);
  const contractRef = path.relative(target.dir, target.file).split(path.sep).join('/');
  /*
   * Box — АБСОЛЮТНЫЙ путь ящика в том виде, в каком его понимает файловая
   * система приглашённого (на Windows — диск и обратные слэши). Именно это
   * значение приглашённый передаёт в join; вывести путь из метки нельзя.
   */
  const boxPath = path.resolve(target.dir);
  const written = [];
  for (const label of labelsToInvite) {
    if (hasAnyReceipt(target.dir, label)) continue;
    const file = writeReceipt(target.dir, thread, {
      from: initiator,
      to: label,
      status: 'invitation',
      session,
      ref: contractRef,
      extra: ['Rev: ' + contract.rev, 'Box: ' + boxPath],
      subject: 'приглашение в папку обмена',
      body: 'Приглашение в папку «' + folder.id + '» (контракт ' + contractRef + ', ревизия ' + contract.rev + ').\n'
        + 'Ящик: ' + boxPath + '\n'
        + 'Принять папку — действие join с этим путём ящика, отказаться — действие decline.\n'
        + '— ' + initiator,
    });
    written.push({ to: label, file });
  }
  return written;
}

/**
 * Объявление ящика для записи join.
 *
 * Приглашённый получил АБСОЛЮТНЫЙ путь ящика, а формат папки хранит только
 * относительный: внутри своего воркспейса — root: workspace, вне его — root: shared
 * от общего каталога участников. Если общего каталога нет, это отказ с рецептом,
 * а не абсолютный путь в structure/graph.json.
 */
function boxDeclarationFor(runtime, root, boxDir) {
  const workspace = path.resolve(String(root));
  const box = path.resolve(String(boxDir));
  const contains = (base, target) => {
    const relative = path.relative(base, target);
    if (relative === '') return true;
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  if (contains(workspace, box)) {
    const relative = path.relative(workspace, box);
    if (!relative) {
      return {
        error: 'ящик совпадает с корнем воркспейса «' + workspace + '»',
        fix: 'Укажите ящик отдельным каталогом, например coordination внутри воркспейса.',
      };
    }
    return { box: { path: relative.split(path.sep).join('/'), root: 'workspace' } };
  }
  const allowed = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [workspace];
  const scope = [workspace];
  const push = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const resolved = path.resolve(value);
    if (!scope.some((item) => samePath(item, resolved))) scope.push(resolved);
  };
  const declared = declaredExchangeWorkspaces(runtime, allowed);
  if (declared.length > 0) for (const item of declared) push(item);
  else for (const item of allowed) push(item);
  let base = commonParent(scope);
  if (!contains(base, box)) {
    /*
     * Общий каталог не выводится из объявленных участников (второй воркспейс ещё
     * не открыт в панели) — поднимаемся от своего корня, пока каталог не накроет
     * ящик. Дальше его разрешит то же правило, что читает сторож: commonParent
     * участников, и при одном участнике shared честно откажет, а не соврёт.
     */
    let candidate = path.dirname(workspace);
    while (!contains(candidate, box) && path.dirname(candidate) !== candidate) candidate = path.dirname(candidate);
    if (contains(candidate, box)) base = candidate;
  }
  if (!contains(base, box)) {
    return {
      error: 'ящик ' + box + ' вне общего каталога участников',
      fix: 'Общего каталога нет: положите ящик внутрь своего воркспейса (box.root: workspace) или откройте второй воркспейс в панели.',
    };
  }
  const relative = path.relative(base, box);
  if (!relative || path.isAbsolute(relative)) {
    return {
      error: 'не удалось выразить ящик относительным путём: ' + box,
      fix: 'Укажите ящик отдельным каталогом внутри общего корня участников.',
    };
  }
  return { box: { path: relative.split(path.sep).join('/'), root: 'shared' } };
}

/**
 * Подключение по приглашению (задание 0020).
 *
 * Тело несёт абсолютный путь ящика (Box из письма), участников и оркестратора.
 * Папка записывается в structure/graph.json приглашённого, затем пишется квитанция
 * accepted с Ref на контракт — та же, что у действия accept.
 */
function joinFolder(runtime, root, folderInput, input) {
  const body = input && typeof input === 'object' ? input : {};
  const id = typeof folderInput.id === 'string' ? folderInput.id.trim() : '';
  if (!id) {
    return { status: 400, error: 'не указана папка', fix: 'Передайте id папки из письма-приглашения, например folder-1.' };
  }
  const rawBox = typeof folderInput.box === 'string' ? folderInput.box.trim()
    : (folderInput.box && typeof folderInput.box === 'object' && typeof folderInput.box.path === 'string'
      ? folderInput.box.path.trim()
      : (typeof body.box === 'string' ? body.box.trim() : ''));
  if (!rawBox || !path.isAbsolute(rawBox)) {
    return {
      status: 400,
      error: 'для join нужен box — абсолютный путь ящика из письма-приглашения',
      fix: 'Передайте box: "C:/…/coordination" — значение поля Box в шапке письма Status: invitation.',
    };
  }
  const boxDir = path.resolve(rawBox);
  let stat = null;
  try {
    stat = fs.statSync(boxDir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    return {
      status: 400,
      error: 'ящика нет по пути ' + boxDir,
      fix: 'Проверьте поле Box в письме-приглашении: папка обмена должна существовать.',
    };
  }
  const payload = readGraph(runtime, root);
  if (!payload.exists) {
    return { status: 404, error: 'в проекте нет папки ' + runtime.structureDir + '/', fix: 'Создайте структуру: папка обмена записывается в ' + runtime.structureDir + '/graph.json.' };
  }
  if (payload.errors.length > 0) {
    const first = payload.errors[0];
    return { status: 409, error: 'структура уже недействительна: ' + first.message, fix: first.fix || 'Сначала исправьте ошибки структуры.' };
  }
  /*
   * Запись папки приглашённого могла уже существовать (повторный join после
   * отключения). Её exchange — threads и имя контракта — наследуется так же, как
   * при update (задание 0028, D1): join не затирает объявленную ветку одной
   * строкой contract.
   */
  const declaredFolders = Array.isArray(payload.graph.folders) ? payload.graph.folders : [];
  const existingFolder = declaredFolders.find((item) => item && item.id === id) || null;
  const existingContract = existingFolder && existingFolder.exchange
    && typeof existingFolder.exchange === 'object'
    && typeof existingFolder.exchange.contract === 'string'
    ? existingFolder.exchange.contract.trim()
    : '';
  /*
   * Имя контракта join берёт из тела (Ref письма), затем из прежней записи папки,
   * затем из ящика: сначала имя, которое папка получила бы по умолчанию, потом
   * прежнее contract.md. Это факт файла, а не догадка — и старая, и новая папка
   * подключаются одним действием.
   */
  let contractName = typeof body.contract === 'string' && body.contract.trim()
    ? body.contract.trim()
    : (typeof folderInput.contract === 'string' && folderInput.contract.trim() ? folderInput.contract.trim() : '');
  if (!contractName) contractName = existingContract;
  if (!contractName) {
    const idName = id ? 'contract-' + id + '.md' : CONTRACT_DEFAULT;
    if (fs.existsSync(path.join(boxDir, idName))) contractName = idName;
    else if (fs.existsSync(path.join(boxDir, CONTRACT_DEFAULT))) contractName = CONTRACT_DEFAULT;
    else contractName = idName;
  }
  const contract = readContractFields(path.join(boxDir, contractName)) || { rev: 0, initiator: '', invited: [], created: '' };
  const given = Array.isArray(folderInput.participants)
    ? folderInput.participants.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
  /* Без списка участников берём его из контракта: это факт, а не догадка. */
  const participants = given.length > 0
    ? given
    : [contract.initiator, ...(Array.isArray(contract.invited) ? contract.invited : [])].filter(Boolean);
  if (participants.length === 0) {
    return {
      status: 400,
      error: 'у папки «' + id + '» нет участников',
      fix: 'Передайте participants: ["structure", "workflow"] — тот же список, что в контракте ящика.',
    };
  }
  const declaredBox = boxDeclarationFor(runtime, root, boxDir);
  if (declaredBox.error) return { status: 400, error: declaredBox.error, fix: declaredBox.fix };
  const known = (payload.graph.nodes || []).map((node) => node && node.id).filter(Boolean);
  const orchestrator = typeof folderInput.orchestrator === 'string' ? folderInput.orchestrator.trim() : '';
  if (!orchestrator) {
    return {
      status: 400,
      error: 'у папки «' + id + '» не задан orchestrator',
      fix: known.length > 0
        ? 'Укажите id одного из объявленных узлов: ' + known.join(', ') + '.'
        : 'Сначала добавьте узел: папку должен представлять объявленный агент.',
    };
  }
  if (!known.includes(orchestrator)) {
    return {
      status: 400,
      error: 'orchestrator «' + orchestrator + '» не объявлен в структуре',
      fix: known.length > 0 ? 'Укажите id одного из объявленных узлов: ' + known.join(', ') + '.' : 'Сначала добавьте узел.',
    };
  }
  /*
   * Путь рядом с меткой (задание 0024): приглашённый мог получить письмо раньше,
   * чем реестр узнал его метку, поэтому join пишет пути тех меток, которые
   * разрешаются, и не отвергает папку из-за чужой метки: отказ — дело contract.
   */
  const joinPaths = {};
  const participantMap = runtime && runtime.participants && typeof runtime.participants === 'object'
    ? runtime.participants
    : {};
  const joinLabels = [];
  for (const item of participants) {
    const label = participantLabel(item, participantMap);
    if (label && !joinLabels.includes(label)) joinLabels.push(label);
    const row = label ? registryRowFor(runtime, label) : null;
    if (row) joinPaths[label] = row.path;
  }
  const folder = { id, box: declaredBox.box, participants: joinLabels, orchestrator };
  folder.paths = joinPaths;
  /*
   * exchange наследуется от прежней записи папки (как update), а у первой записи
   * ветка выбирается по источникам: тело запроса, письмо-приглашение для этой
   * папки, и только последним резервом — первая threads/* каталога. Объявленная
   * ветка прежней записи сильнее приглашения: повторный join её не затирает
   * (задание 0028, инвариант 1; задание 0051, D1 и контроль C3). Так join не
   * теряет ни threads, ни имя контракта.
   */
  const bodyThreads = exchangeThreadsOf(folderInput.exchange);
  folder.exchange = { contract: contractName };
  if (bodyThreads.length > 0) folder.exchange.threads = [bodyThreads[0]];
  if (existingFolder) {
    folder.exchange = inheritFolderExchange(folder, existingFolder).exchange;
  }
  const declaredThreads = exchangeThreadsOf(folder.exchange);
  if (declaredThreads.length > 0) {
    folder.exchange.threads = [declaredThreads[0]];
  } else if (!(existingFolder && existingFolder.exchange === false)) {
    const addresses = letterAddressesFor(runtime, root, joinLabels, boxDir);
    const thread = invitationThreadOf(boxDir, addresses, contractName)
      || declaredThreadOf(boxDir);
    if (thread) folder.exchange.threads = [thread];
  }
  const relative = runtime.structureDir + '/graph.json';
  const absolute = resolveStructureFile(root, runtime, relative);
  if (!absolute) return { status: 400, error: 'файл папки вне папки структуры: ' + relative, fix: 'Проверьте structure/*.json.' };
  let original = null;
  try {
    original = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
    const document = original === null ? { version: GRAPH_VERSION, folders: [] } : JSON.parse(original);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return { status: 409, error: 'файл ' + relative + ' — не JSON-объект', fix: 'Исправьте файл вручную.' };
    }
    if (document.folders !== undefined && !Array.isArray(document.folders)) {
      return { status: 409, error: 'в файле ' + relative + ' folders — не массив', fix: 'Исправьте файл вручную.' };
    }
    const list = Array.isArray(document.folders) ? document.folders : [];
    /* Повторный join (после отключения) заменяет запись, а не плодит двойника. */
    document.folders = list.some((item) => item && item.id === id)
      ? list.map((item) => (item && item.id === id ? folder : item))
      : list.concat([folder]);
    writeFileAtomic(absolute, JSON.stringify(document, null, 2) + '\n');
  } catch (error) {
    if (original !== null) {
      try { fs.writeFileSync(absolute, original, 'utf8'); } catch { /* the message below is enough */ }
    }
    return { status: 500, error: 'не удалось записать папку: ' + (error && error.message ? error.message : 'ошибка'), fix: 'Проверьте права на файл структуры.' };
  }
  const after = readGraph(runtime, root);
  if (after.errors.length > 0) {
    try {
      if (original === null) fs.rmSync(absolute, { force: true });
      else fs.writeFileSync(absolute, original, 'utf8');
    } catch { /* ignore rollback failure */ }
    const first = after.errors[0];
    return { status: 409, error: first.message, fix: first.fix || 'Запись отменена: структура не прошла проверку.' };
  }
  const joinedFolder = (after.graph.folders || []).find((item) => item && item.id === id) || folder;
  const written = { ...joinedFolder, paths: folder.paths };
  const identity = sideIdentity(runtime, root);
  const me = identity.label;
  const warnings = identityWarnings(identity);
  const labels = folderParticipantLabels(runtime, participants);
  const initiator = contract.initiator || labels.find((label) => label !== me) || labels[0] || '';
  const session = receiptSession(body);
  const thread = firstThreadOf(folder, boxDir);
  let receipt;
  try {
    receipt = writeReceipt(boxDir, thread, {
      from: me,
      to: initiator,
      status: 'accepted',
      session,
      ref: contractName,
      subject: 'приглашение в папку принято',
      body: 'Приглашение в папку «' + id + '» принято. Обмен включён.\n— ' + me,
    });
  } catch (error) {
    return {
      status: 500,
      error: 'папка записана, но квитанция не записалась: ' + (error && error.message ? error.message : 'ошибка'),
      fix: 'Проверьте права на ящик обмена ' + boxDir + ' и повторите: папка уже есть в структуре.',
    };
  }
  return {
    status: 200,
    ok: true,
    folder: written,
    file: relative,
    receipt,
    ref: contractName,
    session,
    box: boxDir,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Отказ от приглашения (задание 0020): письмо Status: declined с Ref на контракт.
 * Папка при этом в структуру не пишется — отказ и есть отсутствие подключения.
 */
function declineFolder(runtime, root, folderInput, input, folders) {
  const body = input && typeof input === 'object' ? input : {};
  const id = typeof folderInput.id === 'string' ? folderInput.id.trim() : '';
  if (!id) {
    return { status: 400, error: 'не указана папка', fix: 'Передайте id папки из письма-приглашения, например folder-1.' };
  }
  const existing = (Array.isArray(folders) ? folders : []).find((item) => item && item.id === id) || null;
  const rawBox = typeof folderInput.box === 'string' ? folderInput.box.trim()
    : (folderInput.box && typeof folderInput.box === 'object' && typeof folderInput.box.path === 'string'
      ? folderInput.box.path.trim()
      : (typeof body.box === 'string' ? body.box.trim() : ''));
  let boxDir = '';
  if (rawBox && path.isAbsolute(rawBox)) {
    boxDir = path.resolve(rawBox);
  } else if (existing) {
    const target = folderContractTarget(runtime, root, existing);
    if (target.status) return target;
    boxDir = target.dir;
  }
  if (!boxDir) {
    return {
      status: 400,
      error: 'для decline нужен box — абсолютный путь ящика из письма-приглашения',
      fix: 'Передайте box: "C:/…/coordination" — значение поля Box в шапке письма Status: invitation.',
    };
  }
  let stat = null;
  try {
    stat = fs.statSync(boxDir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    return { status: 400, error: 'ящика нет по пути ' + boxDir, fix: 'Проверьте поле Box в письме-приглашении.' };
  }
  const contractName = existing && existing.exchange && typeof existing.exchange === 'object'
    && typeof existing.exchange.contract === 'string' && existing.exchange.contract.trim()
    ? existing.exchange.contract.trim()
    : (typeof body.contract === 'string' && body.contract.trim() ? body.contract.trim() : CONTRACT_DEFAULT);
  const contract = readContractFields(path.join(boxDir, contractName)) || { rev: 0, initiator: '', invited: [], created: '' };
  /*
   * Тот же резолвер, что у join. Отличие одно и названо: отказ адресован
   * приглашённой метке контракта, поэтому при ПОЛНОМ отсутствии карты в
   * контракте берётся единственная приглашённая метка (задание 0085, D-extension
   * согласовано с координатором). Несколько приглашённых — basename: угадывать
   * сторону нельзя.
   */
  const identity = sideIdentity(runtime, root, { invitation: contract });
  const me = identity.label;
  const warnings = identityWarnings(identity);
  const labels = existing ? folderParticipantLabels(runtime, existing.participants) : [];
  const initiator = contract.initiator || labels.find((label) => label !== me) || labels[0] || '';
  const thread = firstThreadOf(existing, boxDir);
  const session = receiptSession(body);
  let receipt;
  try {
    receipt = writeReceipt(boxDir, thread, {
      from: me,
      to: initiator,
      status: 'declined',
      session,
      ref: contractName,
      subject: 'приглашение в папку отклонено',
      body: 'Приглашение в папку «' + id + '» отклонено. Подключение не выполнено.\n— ' + me,
    });
  } catch (error) {
    return {
      status: 500,
      error: 'не удалось записать отказ: ' + (error && error.message ? error.message : 'ошибка'),
      fix: 'Проверьте права на ящик обмена ' + boxDir + ' и повторите.',
    };
  }
  return {
    status: 200,
    ok: true,
    folder: id,
    letter: receipt,
    receipt,
    ref: contractName,
    session,
    box: boxDir,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Прочитать одну папку из тела запроса и проверить её поля.
 *
 * Папка — не узел: у неё нет роли и модели, зато есть ящик, участники и
 * оркестратор. Проверки повторяют модель (lib/graph.js), но отвечают рецептом
 * сразу, до записи: панель не должна оставлять в файле заведомо битую запись.
 *
 * @returns `{ folder }` or `{ status, error, fix }`.
 */
function normalizeFolderInput(runtime, root, payload, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 400, error: 'папка должна быть JSON-объектом', fix: 'Передайте { id, box: { path, root }, exchange: { threads, contract }, participants, orchestrator }.' };
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    return { status: 400, error: 'у папки нет id', fix: 'Назовите папку латиницей, например folder-2.' };
  }
  if (!NODE_ID.test(id)) {
    return { status: 400, error: 'id папки «' + id + '» не подходит', fix: 'Латинские буквы, цифры, точка, дефис или подчёркивание, без пробелов: folder-2.' };
  }
  const box = typeof raw.box === 'string' ? { path: raw.box } : raw.box;
  const boxPath = box && typeof box === 'object' && typeof box.path === 'string' ? box.path.trim() : '';
  if (!boxPath) {
    return { status: 400, error: 'у папки «' + id + '» нет ящика (box.path)', fix: 'Передайте box: { "path": "coordination", "root": "shared" } — путь к папке обмена.' };
  }
  if (path.isAbsolute(boxPath) || boxPath.split(/[\\/]/u).includes('..')) {
    return { status: 400, error: 'box.path должен быть относительным и без «..»: ' + boxPath, fix: 'Ящик задаётся относительным путём внутри корня участников, например "coordination"; абсолютный путь и «..» запрещены.' };
  }
  const boxRoot = box && box.root !== undefined ? String(box.root).trim() : 'shared';
  if (boxRoot !== 'shared' && boxRoot !== 'workspace') {
    return { status: 400, error: 'box.root должен быть "shared" или "workspace": ' + boxRoot, fix: 'shared — общий корень участников, workspace — внутри своего воркспейса.' };
  }
  if (!Array.isArray(raw.participants) || raw.participants.length === 0
    || raw.participants.some((item) => typeof item !== 'string' || !item.trim())) {
    return { status: 400, error: 'у папки «' + id + '» нет участников', fix: 'Перечислите хотя бы один воркспейс канала: participants: ["structure", "workflow"]. Без участников у папки нет выхода во вне.' };
  }
  /*
   * Участник — МЕТКА реестра воркспейсов, а не свободный текст и не путь:
   * абсолютный путь, если он объявлен в карте участников, сводится к метке.
   * Путь воркспейса рядом с меткой пишется отдельно (paths), из реестра.
   */
  const participantMap = runtime && runtime.participants && typeof runtime.participants === 'object'
    ? runtime.participants
    : {};
  const participants = [];
  for (const item of raw.participants) {
    const label = participantLabel(item.trim(), participantMap);
    if (label && !participants.includes(label)) participants.push(label);
  }
  const orchestrator = typeof raw.orchestrator === 'string' ? raw.orchestrator.trim() : '';
  if (!orchestrator) {
    return { status: 400, error: 'у папки «' + id + '» не задан orchestrator', fix: 'Укажите id объявленного узла-оркестратора, например coordinator: связь папки с агентом задаётся полем, а не ребром.' };
  }
  const known = ((payload && payload.graph && payload.graph.nodes) || []).map((node) => node && node.id).filter(Boolean);
  if (!known.includes(orchestrator)) {
    return {
      status: 400,
      error: 'orchestrator «' + orchestrator + '» не объявлен в структуре',
      fix: known.length > 0
        ? 'Укажите id одного из объявленных узлов: ' + known.join(', ') + '.'
        : 'Сначала добавьте узел: папку должен представлять объявленный агент.',
    };
  }
  const folder = { id, box: { path: boxPath, root: boxRoot } };
  if (raw.exchange !== undefined) {
    if (raw.exchange === false) {
      folder.exchange = false;
    } else if (!raw.exchange || typeof raw.exchange !== 'object' || Array.isArray(raw.exchange)) {
      return { status: 400, error: 'exchange у папки «' + id + '» должен быть объектом или false', fix: 'Передайте exchange: { "threads": ["critic-report"], "contract": "contract.md" }.' };
    } else {
      folder.exchange = {};
      if (raw.exchange.threads !== undefined) {
        if (!Array.isArray(raw.exchange.threads)
          || raw.exchange.threads.some((item) => typeof item !== 'string' || !item.trim())) {
          return { status: 400, error: 'exchange.threads должен быть массивом имён веток', fix: 'Передайте threads: ["critic-report"] — по имени на ветку.' };
        }
        folder.exchange.threads = raw.exchange.threads.map((item) => item.trim());
      }
      if (raw.exchange.contract !== undefined) {
        const contract = typeof raw.exchange.contract === 'string' ? raw.exchange.contract.trim() : '';
        if (!contract || contract.split(/[\\/]/u).includes('..') || path.isAbsolute(contract)) {
          return { status: 400, error: 'exchange.contract должен быть именем файла', fix: 'Контракт лежит в корне ящика: "contract.md".' };
        }
        folder.exchange.contract = contract;
      }
    }
  }
  const brief = typeof raw.brief === 'string' ? raw.brief.trim() : '';
  if (brief) folder.brief = brief;
  /*
   * Сверка с реестром (задание 0024, D2): неизвестная метка — 400 с причиной,
   * похожими метками реестра и рецептом; запись не происходит.
   */
  const paths = {};
  const unknown = [];
  for (const label of participants) {
    const row = registryRowFor(runtime, label);
    if (row) paths[label] = row.path;
    else unknown.push(label);
  }
  if (unknown.length > 0) {
    const first = unknown[0];
    const similar = similarParticipantLabels(runtime, first);
    return {
      status: 400,
      code: 'participant-unknown',
      label: first,
      unresolved: unknown,
      similar,
      error: 'метка «' + first + '» не найдена в реестре воркспейсов: папка не может звать того, кого нет',
      fix: similar.length > 0
        ? 'Выберите участника из реестра: ' + similar.join(', ') + '. Метка — подпись воркспейса, а не свободный текст; новый воркспейс объявляется в participants (cordis.patch.yml, метка: абсолютный путь).'
        : 'Объявите воркспейс в реестре: participants в cordis.patch.yml (метка: абсолютный путь) или откройте воркспейс в DSH. Метка — подпись воркспейса, а не свободный текст.',
    };
  }
  folder.participants = participants;
  folder.paths = paths;
  folder.orchestrator = orchestrator;
  return { folder };
}

/**
 * Сохранить поля exchange, которых нет в теле обновления (задание 0018).
 *
 * Редактор папки больше не шлёт threads: поле убрано как декларация, которая
 * ничего не фильтровала. Но у старых папок ветки объявлены, и «Сохранить» не
 * должно их стирать: тело без exchange.threads наследует их от существующей
 * записи. Так же переживают правку прочие поля exchange, которых нет в теле
 * (например contract). Явное «exchange: false» («выключить обмен») уважается.
 */
function inheritFolderExchange(folder, existing) {
  const current = existing && existing.exchange && typeof existing.exchange === 'object'
    && !Array.isArray(existing.exchange)
    ? existing.exchange
    : null;
  if (!current || folder.exchange === false) return folder;
  if (folder.exchange === undefined) return { ...folder, exchange: { ...current } };
  if (!folder.exchange || typeof folder.exchange !== 'object' || Array.isArray(folder.exchange)) {
    return folder;
  }
  return { ...folder, exchange: { ...current, ...folder.exchange } };
}

/**
 * Папка обмена: создание, замена, удаление и ревизия контракта.
 *
 * Папка живёт в `folders` и не трогает узлы: агентов панель не создаёт. Контракт
 * — манифест в корне ящика (docs/exchange-format.md §8): при создании Rev 1, при
 * действии `contract` ревизия растёт, инициатор сохраняется, приглашённые берутся
 * из participants. Каждый отказ несёт рецепт.
 *
 * При update поля exchange, которых нет в теле, наследуются от существующей
 * записи: панель больше не шлёт threads, но объявленные ветки старых папок
 * должны пережить «Сохранить» (задание 0018).
 *
 * @param runtime - graph runtime (structure folder, participants map, roots).
 * @param root - project root.
 * @param action - add | update | remove | contract | accept | disconnect | join | decline.
 * @param body - папка ({ id, box, exchange, participants, orchestrator }) или { id };
 *   для join/decline — ещё абсолютный путь ящика box из письма-приглашения.
 * @returns `{ status, ok, folder, contract, invitations, receipt }` or `{ status, error, fix }`.
 */
export function saveFolder(runtime, root, action, body) {
  if (action !== 'add' && action !== 'update' && action !== 'remove' && action !== 'contract'
    && action !== 'accept' && action !== 'disconnect' && action !== 'join' && action !== 'decline') {
    return {
      status: 400,
      error: 'действие папки должно быть add, update, remove, contract, accept, disconnect, join или decline',
      fix: 'Передайте action=add, action=update, action=remove, action=contract, action=accept, action=disconnect, action=join или action=decline.',
    };
  }
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const folderInput = input.folder && typeof input.folder === 'object' && !Array.isArray(input.folder) ? input.folder : input;
  const id = typeof folderInput.id === 'string' ? folderInput.id.trim()
    : (typeof input.id === 'string' ? input.id.trim() : '');
  /*
   * Отказ не трогает структуру и не требует действительного graph.json: у
   * приглашённого может не быть папки вообще — есть только письмо и путь ящика.
   * Поэтому decline отвечает раньше проверок структуры, а папку (если она есть)
   * читает снисходительно, ради имени контракта и участников.
   */
  if (action === 'decline') {
    let declared = [];
    try {
      const document = JSON.parse(fs.readFileSync(resolveStructure(root, runtime.structureDir).graphFile, 'utf8'));
      if (document && Array.isArray(document.folders)) declared = document.folders;
    } catch {
      declared = [];
    }
    return declineFolder(runtime, root, folderInput, input, declared);
  }
  const payload = readGraph(runtime, root);
  if (!payload.exists) {
    return { status: 404, error: 'в проекте нет папки ' + runtime.structureDir + '/', fix: 'Создайте структуру: папка обмена записывается в ' + runtime.structureDir + '/graph.json.' };
  }
  if (payload.errors.length > 0) {
    const first = payload.errors[0];
    return { status: 409, error: 'структура уже недействительна: ' + first.message, fix: first.fix || 'Сначала исправьте ошибки структуры.' };
  }
  const folders = Array.isArray(payload.graph.folders) ? payload.graph.folders : [];

  if (action === 'remove' || action === 'contract') {
    if (!id) return { status: 400, error: 'не указана папка', fix: 'Передайте id папки, например folder-1.' };
    const folder = folders.find((item) => item && item.id === id);
    if (!folder) {
      return { status: 404, error: 'папки «' + id + '» нет в структуре', fix: 'Обновите панель: возможно, папку уже удалили или переименовали.' };
    }
    if (action === 'contract') {
      if (folder.exchange === false) {
        return { status: 409, error: 'у папки «' + id + '» обмен выключен (exchange: false)', fix: 'Включите exchange у папки и повторите: контракт нужен только обмену.' };
      }
      /*
       * Приглашение адресуется только разрешённому участнику (задание 0024, D3):
       * метка, которая не разрешается в путь, — 409 с названием метки и рецептом.
       * Проверка стоит ДО записи контракта: не переписанный контракт и ноль писем,
       * а не контракт, разосланный в пустоту.
       */
      const resolution = folderParticipantPaths(runtime, root, folder);
      if (resolution.unresolved.length > 0) {
        const label = resolution.unresolved[0];
        /*
         * Отказ не пишет ни контракта, ни письма. Ветку threads он готовит только
         * в тех ящиках папки, которые УЖЕ существуют: «писем нет» — пустой
         * список, а не отсутствующий каталог, и новых каталогов отказ не создаёт.
         */
        prepareMailBranch(runtime, root, folder);
        return {
          status: 409,
          code: 'participant-unresolved',
          label,
          unresolved: resolution.unresolved,
          error: 'метка «' + label + '» не разрешается в воркспейс: приглашение некуда адресовать',
          fix: 'Объявите воркспейс «' + label + '» в реестре (participants в cordis.patch.yml, метка: абсолютный путь) или уберите метку из папки; контракт не переписан, письма не записаны.',
        };
      }
      const target = folderContractTarget(runtime, root, folder);
      if (target.status) return target;
      const existing = readContractFields(target.file);
      const labels = folderParticipantLabels(runtime, folder.participants);
      const me = runtime && typeof runtime.me === 'string' ? runtime.me.trim() : '';
      /*
       * Ревизию поднимает только инициатор контракта (задание 0028, D2): если в
       * ящике объявлен чужой Initiator, ответ 409 с его названием и рецептом, а
       * Rev не растёт и письма не пишутся. Своя метка — runtime.me, иначе метка
       * реестра для нашего корня, если она среди участников папки: без опознания
       * себя отказ не выносится.
       */
      const mappedMe = me ? '' : workspaceLabel(runtime, root);
      const ownLabel = me || (labels.includes(mappedMe) ? mappedMe : '');
      const foreign = existing && existing.initiator && ownLabel
        && existing.initiator.toLowerCase() !== ownLabel.toLowerCase();
      if (foreign) {
        return {
          status: 409,
          code: 'contract-foreign-initiator',
          initiator: existing.initiator,
          error: 'контракт в ящике объявлен инициатором «' + existing.initiator
            + '», а не «' + ownLabel + '»: ревизию поднимает только инициатор',
          fix: 'Попросите инициатора «' + existing.initiator + '» выполнить action=contract в своём воркспейсе: Rev не поднят, письма не записаны.',
        };
      }
      const initiator = (existing && existing.initiator) || (me && labels.includes(me) ? me : (labels[0] || ''));
      const invited = labels.filter((label) => label !== initiator);
      const created = (existing && existing.created) || localStamp();
      const rev = ((existing && existing.rev) || 0) + 1;
      try {
        writeFileAtomic(target.file, contractText({ dir: target.dir, rev, initiator, invited, created }));
      } catch (error) {
        return {
          status: 500,
          error: 'не удалось переписать контракт: ' + (error && error.message ? error.message : 'ошибка'),
          fix: 'Проверьте права на ящик обмена ' + target.dir + ' и повторите.',
        };
      }
      /*
       * Rev+1 — это и есть приглашение (задание 0020): каждый участник, который
       * ещё не ответил квитанцией, получает письмо Status: invitation с Ref на
       * контракт, новой ревизией и абсолютным путём ящика.
       */
      let invitations = [];
      try {
        invitations = invitationLetters(runtime, folder, target, { rev, initiator }, receiptSession(input));
      } catch (error) {
        return {
          status: 500,
          error: 'контракт записан (Rev ' + rev + '), но письма-приглашения не записались: '
            + (error && error.message ? error.message : 'ошибка'),
          fix: 'Проверьте права на ящик обмена ' + target.dir + ' и повторите: ревизия уже поднята.',
        };
      }
      return { status: 200, ok: true, folder: id, contract: { rev, file: target.file }, invitations };
    }
    const relative = folder.file || runtime.structureDir + '/graph.json';
    const absolute = resolveStructureFile(root, runtime, relative);
    if (!absolute) return { status: 400, error: 'файл папки вне папки структуры: ' + relative, fix: 'Проверьте structure/*.json.' };
    let original = null;
    try {
      original = fs.readFileSync(absolute, 'utf8');
      const document = JSON.parse(original);
      if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.folders)) {
        return { status: 409, error: 'в файле ' + relative + ' нет массива folders', fix: 'Исправьте файл вручную.' };
      }
      const kept = document.folders.filter((item) => !(item && item.id === id));
      if (kept.length === document.folders.length) {
        return { status: 404, error: 'папки «' + id + '» нет в файле ' + relative, fix: 'Обновите панель: структура изменилась.' };
      }
      document.folders = kept;
      writeFileAtomic(absolute, JSON.stringify(document, null, 2) + '\n');
    } catch (error) {
      if (original !== null) {
        try { fs.writeFileSync(absolute, original, 'utf8'); } catch { /* the message below is enough */ }
      }
      return { status: 500, error: 'не удалось удалить папку: ' + (error && error.message ? error.message : 'ошибка'), fix: 'Проверьте права на файл структуры.' };
    }
    const after = readGraph(runtime, root);
    if (after.errors.length > 0) {
      try { fs.writeFileSync(absolute, original, 'utf8'); } catch { /* ignore rollback failure */ }
      const first = after.errors[0];
      return { status: 409, error: first.message, fix: first.fix || 'Удаление отменено: структура не прошла проверку.' };
    }
    return { status: 200, ok: true, removed: id, file: relative };
  }

  /*
   * Подключение и отказ по приглашению (задание 0020). join несёт абсолютный путь
   * ящика из письма Box, потому что папки в структуре приглашённого ещё нет;
   * decline вообще не пишет структуру — это письмо, а не запись папки.
   */
  if (action === 'join') return joinFolder(runtime, root, folderInput, input);

  /*
   * Квитанция и отключение: связь в папке включается только явным письмом стороны.
   * accept кладёт ОДНО письмо Status: accepted с Ref на контракт и своим Session;
   * disconnect без квитанции — конфликт с рецептом, после квитанции — письмо
   * Status: disconnected с Ref на собственную квитанцию (docs/exchange-format.md §8).
   */
  if (action === 'accept' || action === 'disconnect') {
    if (!id) return { status: 400, error: 'не указана папка', fix: 'Передайте id папки, например folder-1.' };
    const folder = folders.find((item) => item && item.id === id);
    if (!folder) {
      return { status: 404, error: 'папки «' + id + '» нет в структуре', fix: 'Обновите панель: возможно, папку уже удалили или переименовали.' };
    }
    if (folder.exchange === false) {
      return { status: 409, error: 'у папки «' + id + '» обмен выключен (exchange: false)', fix: 'Включите exchange у папки и повторите: квитанция нужна только обмену.' };
    }
    const target = folderContractTarget(runtime, root, folder);
    if (target.status) return target;
    const me = workspaceLabel(runtime, root);
    const labels = folderParticipantLabels(runtime, folder.participants);
    const contract = readContractFields(target.file) || { rev: 0, initiator: '', created: '' };
    const contractRef = path.relative(target.dir, target.file).split(path.sep).join('/');
    const initiator = contract.initiator || labels.find((label) => label !== me) || me;
    const session = receiptSession(input);
    if (action === 'accept') {
      /*
       * Идемпотентность (задание 0047, D2; docs/exchange-format.md §8: одна
       * квитанция на пару папка-сторона). Если у стороны уже есть действующая
       * квитанция accepted по этой папке, второе письмо НЕ пишется: ответ 200
       * отдаёт прежнюю квитанцию и alreadyAccepted: true. Двойной клик по
       * кнопке «Принять папку» больше не плодит письма в ящике.
       *
       * Отключение сильнее квитанции: после Status: disconnected старый приём
       * не действует (§8 «старые приёмы истекли»), поэтому включение снова —
       * это новое письмо accepted, а не alreadyAccepted.
       */
      const answer = ownFolderAnswer(target.dir, me, contractRef);
      if (answer && String(answer.status).toLowerCase() === 'accepted') {
        return {
          status: 200,
          ok: true,
          folder: folder.id,
          receipt: path.relative(target.dir, answer.file).split(path.sep).join('/'),
          session,
          ref: contractRef,
          alreadyAccepted: true,
        };
      }
      const thread = firstThreadOf(folder, target.dir);
      let receipt;
      try {
        receipt = writeReceipt(target.dir, thread, {
          from: me,
          to: initiator,
          status: 'accepted',
          session,
          ref: contractRef,
          subject: 'приглашение в папку принято',
          body: 'Приглашение в папку «' + folder.id + '» принято. Обмен включён.\n— ' + me,
        });
      } catch (error) {
        return {
          status: 500,
          error: 'не удалось записать квитанцию: ' + (error && error.message ? error.message : 'ошибка'),
          fix: 'Проверьте права на ящик обмена ' + target.dir + ' и повторите.',
        };
      }
      return { status: 200, ok: true, folder: folder.id, receipt, session, ref: contractRef, alreadyAccepted: false };
    }
    /*
     * Квитанция именно этой папки: Ref квитанции адресует её контракт
     * (задание 0063). Самая поздняя квитанция ящика — чужая, если папок
     * несколько; у папки без квитанции отключаться не от чего.
     */
    const receipts = ownReceipts(target.dir, me, contractRef);
    if (receipts.length === 0) {
      return {
        status: 409,
        error: 'у папки «' + id + '» нет квитанции: отключаться не от чего',
        fix: 'сначала примите приглашение (accept)',
      };
    }
    /*
     * Идемпотентность отключения (задание 0065, D1; docs/exchange-format.md §8).
     * Действующее отключение этой стороны по этой папке — письмо Status:
     * disconnected, чей Ref ведёт на свою квитанцию (или на контракт папки) и
     * которое позже любого нового accepted по той же папке. Тогда второе письмо
     * не пишется: ответ 200 отдаёт путь существующего отключения и
     * alreadyDisconnected: true. Новый accept («старые приёмы истекли») снимает
     * это состояние — следующее отключение снова пишет письмо.
     */
    const answer = ownFolderAnswer(target.dir, me, contractRef);
    if (answer && String(answer.status).toLowerCase() === 'disconnected') {
      return {
        status: 200,
        ok: true,
        folder: folder.id,
        receipt: path.relative(target.dir, answer.file).split(path.sep).join('/'),
        session,
        ref: answer.ref,
        alreadyDisconnected: true,
      };
    }
    const own = receipts[0];
    const thread = own.thread || firstThreadOf(folder, target.dir);
    const ownRef = path.relative(target.dir, own.file).split(path.sep).join('/');
    let receipt;
    try {
      receipt = writeReceipt(target.dir, thread, {
        from: me,
        to: initiator,
        status: 'disconnected',
        session,
        ref: ownRef,
        subject: 'отключение от папки',
        body: 'Отключение от папки «' + folder.id + '». Связь прекращена.\n— ' + me,
      });
    } catch (error) {
      return {
        status: 500,
        error: 'не удалось записать отключение: ' + (error && error.message ? error.message : 'ошибка'),
        fix: 'Проверьте права на ящик обмена ' + target.dir + ' и повторите.',
      };
    }
    return { status: 200, ok: true, folder: folder.id, receipt, session, ref: ownRef, alreadyDisconnected: false };
  }

  const normalized = normalizeFolderInput(runtime, root, payload, folderInput);
  if (normalized.status) return normalized;
  let folder = normalized.folder;
  const existing = folders.find((item) => item && item.id === folder.id);

  if (action === 'add') {
    if (existing) {
      return { status: 409, error: 'папка «' + folder.id + '» уже есть в структуре', fix: 'Выберите другой id или откройте портал папки и измените её.' };
    }
  } else if (!existing) {
    return { status: 404, error: 'папки «' + folder.id + '» нет в структуре', fix: 'Обновите панель: возможно, папку уже удалили. Новую создайте выносом «Папки» из библиотеки.' };
  } else {
    /*
     * Правка не стирает объявленные ветки: тело панели их больше не несёт,
     * а у старых папок exchange.threads остаётся источником первой ветки
     * для квитанции.
     */
    folder = inheritFolderExchange(folder, existing);
  }

  /*
   * Имя контракта уникально на папку в одном ящике (задание 0024, D4): совпадение
   * с контрактом другой папки — 409 со свободным именем, а не общий файл.
   * Умолчание contract-<id>.md записывается в exchange явно: так панель и
   * сторож обмена видят одно и то же имя, а не два разных умолчания.
   */
  const clash = contractNameClash(runtime, root, folder, folders);
  if (clash) return clash;
  if (folder.exchange !== false) {
    const contractName = contractNameOf(folder);
    folder = {
      ...folder,
      exchange: folder.exchange && typeof folder.exchange === 'object' && !Array.isArray(folder.exchange)
        ? { ...folder.exchange, contract: contractName }
        : { contract: contractName },
    };
  }

  /*
   * Новую папку панель пишет в structure/graph.json — тот же файл, что и
   * стартовая структура: папка не принадлежит ни одному узлу, поэтому её место
   * в общем файле. Существующую правят в том файле, где она объявлена.
   */
  const relative = action === 'update' && existing && existing.file
    ? existing.file
    : runtime.structureDir + '/graph.json';
  const absolute = resolveStructureFile(root, runtime, relative);
  if (!absolute) return { status: 400, error: 'файл папки вне папки структуры: ' + relative, fix: 'Проверьте structure/*.json.' };
  let original = null;
  try {
    original = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
    const document = original === null ? { version: GRAPH_VERSION, folders: [] } : JSON.parse(original);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return { status: 409, error: 'файл ' + relative + ' — не JSON-объект', fix: 'Исправьте файл вручную.' };
    }
    if (document.folders !== undefined && !Array.isArray(document.folders)) {
      return { status: 409, error: 'в файле ' + relative + ' folders — не массив', fix: 'Исправьте файл вручную.' };
    }
    const list = Array.isArray(document.folders) ? document.folders : [];
    if (action === 'add') {
      document.folders = list.concat([folder]);
    } else {
      const at = list.findIndex((item) => item && item.id === folder.id);
      if (at === -1) {
        return { status: 404, error: 'папки «' + folder.id + '» нет в файле ' + relative, fix: 'Обновите панель: структура изменилась.' };
      }
      document.folders = list.map((item, index) => (index === at ? folder : item));
    }
    writeFileAtomic(absolute, JSON.stringify(document, null, 2) + '\n');
  } catch (error) {
    if (original !== null) {
      try { fs.writeFileSync(absolute, original, 'utf8'); } catch { /* the message below is enough */ }
    }
    return { status: 500, error: 'не удалось записать папку: ' + (error && error.message ? error.message : 'ошибка'), fix: 'Проверьте права на файл структуры.' };
  }
  const after = readGraph(runtime, root);
  if (after.errors.length > 0) {
    try {
      if (original === null) fs.rmSync(absolute, { force: true });
      else fs.writeFileSync(absolute, original, 'utf8');
    } catch { /* ignore rollback failure */ }
    const first = after.errors[0];
    return { status: 409, error: first.message, fix: first.fix || 'Запись отменена: структура не прошла проверку.' };
  }
  /*
   * Запись панели несёт карту путей рядом с метками (задание 0024): graph.js
   * отдаёт панели только объявленные поля папки, поэтому paths добавляются к
   * ответу здесь — тем же значениям, что записаны в structure/*.json.
   */
  const savedFolder = (after.graph.folders || []).find((item) => item && item.id === folder.id) || folder;
  const written = { ...savedFolder, paths: folder.paths };

  /* Выключенный обмен контракта не требует: письма некуда писать. */
  if (folder.exchange === false) {
    return { status: 200, ok: true, folder: written, ...(action === 'update' ? { file: relative } : {}) };
  }
  const target = folderContractTarget(runtime, root, written);
  if (target.status) {
    try {
      if (original === null) fs.rmSync(absolute, { force: true });
      else fs.writeFileSync(absolute, original, 'utf8');
    } catch { /* ignore rollback failure */ }
    return target;
  }
  /*
   * Правка папки, у которой контракта ещё нет, его создаёт (Rev 1): папка,
   * объявленная в structure/graph.json без контракта, — черновик, а сохранение
   * из панели означает «папка настроена». Уже лежащий контракт правка не
   * переписывает: ревизия поднимается только действием contract.
   */
  const existingContract = readContractFields(target.file);
  if (action === 'update' && existingContract) {
    return { status: 200, ok: true, folder: written, file: relative };
  }
  const labels = folderParticipantLabels(runtime, written.participants);
  const me = runtime && typeof runtime.me === 'string' ? runtime.me.trim() : '';
  const initiator = me && labels.includes(me) ? me : (labels[0] || '');
  const invited = labels.filter((label) => label !== initiator);
  try {
    writeFileAtomic(target.file, contractText({ dir: target.dir, rev: 1, initiator, invited, created: localStamp() }));
  } catch (error) {
    try {
      if (original === null) fs.rmSync(absolute, { force: true });
      else fs.writeFileSync(absolute, original, 'utf8');
    } catch { /* ignore rollback failure */ }
    return {
      status: 500,
      error: 'папка не создана: контракт не записался в ящик (' + (error && error.message ? error.message : 'ошибка') + ')',
      fix: 'Проверьте права на ящик ' + target.dir + ' и повторите.',
    };
  }
  return { status: 200, ok: true, folder: written, file: relative, contract: { rev: 1, file: target.file } };
}

export function selectRoot(runtime, requested) {
  const allowed = runtime.allowedRoots();
  const value = typeof requested === 'string' && requested.trim() ? requested.trim() : '';
  if (!value) {
    /*
     * The workspace registry may arrive after the runtime is built, so defaultRoot
     * can be null while the allowed list is already populated. Falling back to the
     * first allowed root keeps query-less requests working instead of pretending the
     * project list is empty.
     */
    const fallback = runtime.defaultRoot || (allowed.length > 0 ? allowed[0] : null);
    if (!fallback) return { root: null, error: 'нет ни одного корня проекта: задайте roots в cordis.patch.yml' };
    return { root: fallback, error: null };
  }
  if (!path.isAbsolute(value)) return { root: null, error: 'корень должен быть абсолютным путём: ' + value };
  const resolved = path.resolve(value);
  const match = allowed.find((root) => samePath(root, resolved));
  if (!match) return { root: null, error: 'корень вне разрешённого списка: ' + resolved };
  return { root: match, error: null };
}

/**
 * Read, merge, validate and lay out one project's structure.
 *
 * @returns Everything the panel shows: the graph, errors, warnings, the sources
 *   that produced it, the layout and the summary counts.
 */
/** Where the engine lives inside the repository that serves it. */
const ENGINE_SUBDIR = path.join('docs', 'subagent-workflow');

/** Default workspace -> engine-repository map; the environment overrides it. */
export const DEFAULT_ENGINE_ROOTS = path.join('.dsh', 'workflow', 'engine-roots.json');

/**
 * Absolute path of the engine map: `WF_ENGINE_ROOTS` when set, otherwise
 * `~/.dsh/workflow/engine-roots.json`. Read on every call, never cached: the
 * checks and tests point the variable at a temporary file.
 */
function engineRootsFile() {
  const fromEnv = typeof process !== 'undefined' && process.env ? process.env.WF_ENGINE_ROOTS : '';
  const configured = typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : '';
  if (configured) return path.resolve(configured);
  try {
    return path.join(os.homedir(), DEFAULT_ENGINE_ROOTS);
  } catch {
    return path.resolve(DEFAULT_ENGINE_ROOTS);
  }
}

/** One path key for both platforms: trailing separator dropped, case folded on Windows. */
function enginePathKey(value) {
  const resolved = path.resolve(String(value || ''));
  const trimmed = resolved.length > path.parse(resolved).root.length
    ? resolved.replace(/[\\/]+$/u, '')
    : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** Does a map key name this workspace? File-system rules, not string equality. */
function sameEngineRoot(left, right) {
  try {
    return enginePathKey(left) === enginePathKey(right);
  } catch {
    return false;
  }
}

/**
 * Read the workspace -> engine-repository map and return the entry for `root`.
 *
 * A missing or broken map, a non-object document, an empty value and a record
 * whose repository has no engine are all "no record": the caller must see the
 * `absent` state, never an exception.
 */
function readEngineMap(root, mapFile) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  for (const [key, value] of Object.entries(parsed)) {
    const rawKey = String(key || '').trim();
    const rawValue = typeof value === 'string' ? value.trim() : '';
    /*
     * Only absolute paths are links. A relative key or value would be resolved
     * against the current directory of whoever reads the map, so the same file
     * would name a different engine in every process — a false link. Such a
     * record is "no record": the caller sees absent, never an engine that was
     * not declared.
     */
    if (!rawKey || !path.isAbsolute(rawKey)) continue;
    if (!rawValue || !path.isAbsolute(rawValue)) continue;
    if (!sameEngineRoot(rawKey, root)) continue;
    try {
      return { repo: path.resolve(rawValue), mapFile };
    } catch {
      return null;
    }
  }
  return null;
}

/** Version from `VERSION`, or null when the engine is not there. */
function readEngineVersion(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Is a complete engine present in `dir`? VERSION alone is not an engine. */
function engineDeployedAt(dir) {
  try {
    return fs.existsSync(path.join(dir, 'workflow.config.json')) && readEngineVersion(dir) !== null;
  } catch {
    return false;
  }
}

/**
 * The engine link declared in the plugin config: `config.engines.roots`.
 *
 * The config is the declarative half of the link: it names a repository per
 * absolute workspace path, in the same block the plugin loads from
 * cordis.patch.yml. Three answers, because the caller must not guess:
 *
 * - `record`: a repository is declared for this workspace;
 * - `none`:   the config does not speak about this workspace;
 * - `broken`: the block is malformed, or the declared value is not an absolute
 *              path. The config keeps precedence over the map, so a broken
 *              declaration must read as "no link" rather than open the door to
 *              a weaker source behind the person's back.
 *
 * A key that is not an absolute path is not a declaration at all: it would be
 * resolved against the current directory of whoever reads the config, so the
 * same file would link a different workspace in every process. Such a key is
 * skipped — the config stays silent about this workspace and the map may answer,
 * exactly as it does when the block has no entry for the workspace.
 *
 * @param workspace - absolute workspace path.
 * @param runtime - plugin runtime (createGraphRuntime) or a raw config object.
 */
function configEngineRecord(workspace, runtime) {
  const source = runtime && typeof runtime === 'object' && !Array.isArray(runtime) ? runtime : null;
  if (!source || !workspace) return { state: 'none' };
  let engines;
  try {
    engines = source.engines;
  } catch {
    return { state: 'broken' };
  }
  if (engines === undefined || engines === null) return { state: 'none' };
  if (typeof engines !== 'object' || Array.isArray(engines)) return { state: 'broken' };
  let roots;
  try {
    roots = engines.roots;
  } catch {
    return { state: 'broken' };
  }
  if (roots === undefined || roots === null) return { state: 'none' };
  if (typeof roots !== 'object' || Array.isArray(roots)) return { state: 'broken' };
  for (const [key, value] of Object.entries(roots)) {
    const rawKey = String(key || '').trim();
    /*
     * Mirror of the map rule: only absolute keys name a workspace. A relative
     * key ("delta", ".", "..\delta") depends on the reader's current directory;
     * it is not a declaration and must not shadow the map by accident.
     */
    if (!rawKey || !path.isAbsolute(rawKey)) continue;
    let matches = false;
    try {
      matches = sameEngineRoot(rawKey, workspace);
    } catch {
      matches = false;
    }
    if (!matches) continue;
    if (typeof value !== 'string' || !value.trim()) return { state: 'broken' };
    const target = value.trim();
    if (!path.isAbsolute(target)) return { state: 'broken' };
    return { state: 'record', repo: path.resolve(target) };
  }
  return { state: 'none' };
}

/** The "no engine anywhere" answer: a state with a source, never an exception. */
function absentEngine(mapFile) {
  return {
    installed: false,
    mode: 'absent',
    path: null,
    root: null,
    version: null,
    source: 'none',
    deployed: false,
    dir: 'docs/subagent-workflow',
    mapFile,
  };
}

/** One absolute engine directory as the contract shows it, whichever source named it. */
function mappedEngine(dir, source, extra = {}) {
  const absolute = path.resolve(dir);
  return {
    installed: true,
    mode: 'mapped',
    path: absolute,
    root: absolute,
    version: readEngineVersion(absolute),
    source,
    deployed: true,
    dir: 'docs/subagent-workflow',
    ...extra,
  };
}

/**
 * Where the workflow engine is for this workspace, and which version.
 *
 * Four answers, because "the plugin is installed", "the engine is here", "the
 * link is declared in the config" and "the link is chosen in the panel map" are
 * four different facts:
 *
 * - `local`:  the engine is inside the workspace (`<root>/docs/subagent-workflow`);
 * - `mapped` + `source: 'config'`: `config.engines.roots[<workspace>]` names the
 *   repository; it wins over the map, and the map is not consulted at all;
 * - `mapped` + `source: 'mapping'`: the map (`~/.dsh/workflow/engine-roots.json`,
 *   env `WF_ENGINE_ROOTS`) names the repository;
 * - `absent`: none of the above — a choice of two routes, not a failure.
 *
 * The second argument is the plugin runtime (or a raw config object carrying
 * `engines`). Called without it, the resolver keeps the T8 behaviour: local →
 * map → absent. A broken config, a broken map, a relative path and a record
 * without an engine are all "no link", never an exception.
 *
 * The legacy `deployed`/`dir` fields stay for the panel and the old tests, but
 * `installed`, `mode`, `path`, `root`, `version` and `source` are the contract.
 */
export function readEngine(root, runtime) {
  const workspace = String(root || '').trim();
  const localDir = path.join(workspace || '.', ENGINE_SUBDIR);
  const localVersion = readEngineVersion(localDir);
  const localDeployed = Boolean(workspace) && engineDeployedAt(localDir);

  if (localDeployed) {
    const absolute = path.resolve(localDir);
    return {
      installed: true,
      mode: 'local',
      path: absolute,
      root: absolute,
      version: localVersion,
      source: 'workspace',
      deployed: true,
      dir: 'docs/subagent-workflow',
    };
  }

  /*
   * The config is consulted first and, when it names this workspace, it decides
   * alone: its broken value is "no link", not an invitation to take the map
   * instead. The map is read only when the config is silent about the workspace.
   */
  const declared = configEngineRecord(workspace, runtime);
  if (declared.state === 'broken') return absentEngine(engineRootsFile());
  if (declared.state === 'record') {
    const externalDir = path.join(declared.repo, ENGINE_SUBDIR);
    if (engineDeployedAt(externalDir)) {
      return mappedEngine(externalDir, 'config', { repo: declared.repo });
    }
    return absentEngine(engineRootsFile());
  }

  const mapFile = engineRootsFile();
  const mapped = readEngineMap(workspace, mapFile);
  if (mapped) {
    const externalDir = path.join(mapped.repo, ENGINE_SUBDIR);
    if (engineDeployedAt(externalDir)) {
      return mappedEngine(externalDir, 'mapping', { mapFile, repo: mapped.repo });
    }
  }

  return absentEngine(mapFile);
}

/**
 * Чтение структуры. Остаётся синхронным: раскладка, планировщик и файловые
 * помощники читают ленту без ожидания. Маршруты моделей добавляются обёрткой
 * readGraph: она сверяет их с каталогом службы llm на момент чтения.
 */
function readGraphStructure(runtime, root) {
  const read = readStructure(root, runtime.structureDir);
  const payload = {
    root,
    name: path.basename(root),
    structureDir: runtime.structureDir,
    dir: read.dir,
    exists: read.exists,
    fileCount: read.count,
    sources: [],
    graph: { version: GRAPH_VERSION, models: {}, nodes: [], folders: [], edges: [] },
    families: {},
    errors: [],
    warnings: [],
    layout: { nodes: [], edges: [], width: 0, height: 0, layers: 0, cyclic: [] },
    summary: { nodes: 0, edges: 0, byKind: { delegate: 0, review: 0, peer: 0 }, roles: {}, models: 0, folders: 0, layers: 0 },
    /* Declared daily cadence per node, with the next run computed once here. */
    schedule: {},
    edgeKinds: EDGE_KINDS,
    /* The node that stands for the session owning this structure, if declared. */
    selfNode: runtime.selfNode || null,
    /* Deployed engine is a property of the project; the config link comes from the runtime. */
    engine: readEngine(root, runtime),
    /*
     * Режим удержания структуры — тот же блок workflow, что читает отказ
     * pre-execute (задание 0091). Панель показывает его человеку, не блокируя
     * работу; старый ответ без поля остаётся читаемым (enforcementView → null).
     */
    enforcement: readStructurePolicy(root),
  };

  if (!read.exists) {
    payload.errors.push(withRemedy({
      code: 'no-structure-folder',
      message: 'в проекте нет папки ' + runtime.structureDir + '/: создайте ' + runtime.structureDir + '/graph.json',
    }));
    return payload;
  }

  for (const problem of read.problems) {
    payload.errors.push(withRemedy({ code: 'read-problem', file: problem.file, message: problem.message }));
  }
  const built = buildGraph(read.files, { dirName: runtime.structureDir });
  payload.graph = built.graph;
  payload.families = built.families;
  payload.sources = built.sources;
  payload.errors.push(...built.errors.map(withRemedy));
  payload.warnings.push(...built.warnings.map(withRemedy));
  payload.layout = layoutGraph(built.graph);
  payload.summary = summarizeGraph(built.graph, payload.layout);
  payload.schedule = scheduleForGraph(built.graph, new Date());
  return payload;
}

/**
 * Прочитать структуру и разрешить маршрут каждой модели по каталогу службы llm.
 *
 * Возвращает ленту сразу; если служба llm отвечает промисами, ожидание
 * (await) получает точные статусы, а синхронный читатель — то, что доказано
 * без ожидания. Ни один сбой службы не роняет чтение структуры.
 */
export function readGraph(runtime, root) {
  return attachModelRoutes(readGraphStructure(runtime, root), runtime);
}

/**
 * Сколько писем ТРЕБУЕТ ХОДА — по папкам объявленной структуры.
 *
 * Источник ровно один: exchangeAttention из lib/obligations.js (задание 0113).
 * До него здесь стоял scanExchange.unread — «адресовано и не отмечено
 * прочитанным»; у живого воркспейса это дало 192, где 108 писем были answer,
 * 43 — report, и бейдж показывал всю историю переписки. Теперь считаются
 * request и question без нашего ответа (письма с Reply-To на их путь).
 *
 * Форма ответа не меняется: { total, folders: [{ id, unread }] }, и unread
 * папки — это её attention. Панель читает то же поле и ничего не знает о второй
 * семантике. Сканер — наблюдение: его отказ не бросается, а возвращается
 * строкой error, а ошибка одной папки остаётся её attention 0.
 *
 * @param {{ root?: string, runtime?: object }} [options] - корень проекта; без
 *   него берётся первый корень runtime.
 * @returns {{ total: number, folders: Array<{ id: string, unread: number }>, error?: string }}
 *   folders — по строке на объявленную папку (id и число требующих хода).
 */
export function exchangeUnread({ root, runtime } = {}) {
  let workspace = typeof root === 'string' ? root.trim() : '';
  if (!workspace && runtime && typeof runtime.allowedRoots === 'function') {
    const roots = runtime.allowedRoots();
    workspace = Array.isArray(roots) && typeof roots[0] === 'string' ? roots[0] : '';
  }
  if (!workspace) return { total: 0, folders: [], error: 'корень проекта не выбран' };
  let attention;
  try {
    attention = exchangeAttention({ root: workspace });
  } catch (error) {
    return {
      total: 0,
      folders: [],
      error: 'не удалось прочитать обмен: ' + (error && error.message ? error.message : 'ошибка'),
    };
  }
  /* Отрицательное и нечисло — не факт, а ноль: счётчик не имеет права врать вверх. */
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);
  const folders = (Array.isArray(attention && attention.folders) ? attention.folders : []).map((folder) => ({
    id: folder && folder.id !== undefined && folder.id !== null ? String(folder.id) : '',
    unread: count(folder && folder.attention),
  }));
  const result = { total: folders.reduce((sum, folder) => sum + folder.unread, 0), folders };
  if (attention && attention.error) {
    result.error = String(attention.error.error || attention.error.code || 'сканер обмена отказал');
  }
  return result;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (res.writableEnded === true) return;
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    });
  }
  if (typeof res.end === 'function') res.end(body);
}

function isLoopback(req) {
  const address = req && req.socket ? req.socket.remoteAddress : undefined;
  if (address === undefined || address === null || address.length === 0) return true;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** The prefix route handler: pure wiring over {@link readGraph}. */
export function createWebHandler(runtime) {
  return async function handler(req, res) {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'панель отвечает только локально' });
        return;
      }
      const method = String((req && req.method) || 'GET').toUpperCase();
      const url = new URL(String((req && req.url) || '/'), 'http://127.0.0.1');
      let rel = url.pathname;
      if (rel.startsWith(API_PREFIX)) rel = rel.slice(API_PREFIX.length);
      if (rel === '' ) rel = '/';
      rel = rel.replace(/\/+$/u, '') || '/';

      if (method === 'POST') {
        if (rel !== '/api/init' && rel !== '/api/link' && rel !== '/api/node' && rel !== '/api/layout'
          && rel !== '/api/schedule' && rel !== '/api/session' && rel !== '/api/exchange-participants'
          && rel !== '/api/exchange/mark'
          && rel !== '/api/workflow-install' && rel !== '/api/workflow-check' && rel !== '/api/check'
          && rel !== '/api/release/update'
          && rel !== '/api/build' && rel !== '/api/folder' && rel !== '/api/report-check') {
          sendJson(res, 405, {
            error: 'панель пишет только структуру: метод ' + method + ' не поддерживается',
            fix: 'Доступны стартовая структура, проверка и сборка графа, связь, узел, папка обмена и раскладка.',
          });
          return;
        }
        /*
         * Installing the workflow plugin is a profile action, not a project one:
         * it must work before any project is chosen, so this route answers before
         * the root selection below.
         */
        if (rel === '/api/workflow-check') {
          const checked = await checkWorkflow(runtime, url.searchParams.get('root') || runtime.defaultRoot);
          if (checked.status !== 200) {
            sendJson(res, checked.status, {
              error: checked.error,
              fix: checked.fix,
              ...(checked.code ? { code: checked.code } : {}),
            });
            return;
          }
          sendJson(res, 200, checked);
          return;
        }
        if (rel === '/api/workflow-install') {
          const action = url.searchParams.get('action') || 'install';
          if (action !== 'install' && action !== 'update') {
            sendJson(res, 400, { error: 'действие установки должно быть install или update', fix: 'Передайте action=install или action=update.' });
            return;
          }
          const requestedRoot = url.searchParams.get('root') || runtime.defaultRoot || null;
          const installed = action === 'update' ? await updateWorkflow(runtime, requestedRoot) : await installWorkflow(runtime);
          if (installed.status !== 200) {
            sendJson(res, installed.status, {
              error: installed.error,
              fix: installed.fix,
              ...(installed.code ? { code: installed.code } : {}),
              ...(installed.output ? { output: installed.output } : {}),
              ...(typeof installed.restored === 'boolean' ? { restored: installed.restored } : {}),
              ...(installed.previous ? { previous: installed.previous } : {}),
              ...(installed.engine ? { engine: installed.engine } : {}),
            });
            return;
          }
          sendJson(res, 200, installed);
          return;
        }
        /*
         * Updating the structure itself is a profile action too: the bundle lives
         * in the profile, not in the project, so this route answers before the root
         * selection. A link install is refused with the repository remedy instead
         * of being replaced behind the person's back.
         */
        if (rel === '/api/release/update') {
          const updated = await updateStructureRelease(runtime);
          sendJson(res, updated.status, {
            updated: updated.updated === true,
            ...(updated.version ? { version: updated.version } : {}),
            ...(updated.reason ? { reason: updated.reason } : {}),
            ...(updated.fix ? { fix: updated.fix } : {}),
            ...(updated.code ? { code: updated.code } : {}),
            ...(updated.application ? { application: updated.application } : {}),
          });
          return;
        }
        /*
         * The layout route carries its own root in the body (the canvas belongs to
         * the selected project), so the query-only gate must not run first: with an
         * empty roots list it refused before the body was even read.
         */
        const selection = selectRoot(runtime, url.searchParams.get('root'));
        /*
         * Canvas routes carry their root in the body, so a query-less request is not
         * fatal there: the body root is checked in its own branch below.
         */
        const bodyRootRoute = rel === '/api/layout' || rel === '/api/schedule' || rel === '/api/session'
          || rel === '/api/exchange-participants';
        if (!bodyRootRoute && !selection.root) {
          sendJson(res, 400, {
            error: selection.error,
            fix: 'Добавьте абсолютный путь проекта в roots (cordis.patch.yml) и перезагрузите плагин.',
          });
          return;
        }
        let stat = null;
        try {
          stat = fs.statSync(selection.root);
        } catch {
          stat = null;
        }
        if (!stat || !stat.isDirectory()) {
          sendJson(res, 404, {
            error: 'корень не найден: ' + selection.root,
            fix: 'Проверьте путь в roots: папка проекта должна существовать.',
          });
          return;
        }
        /*
         * Отметка прочитанного (задание 0077): панель и CLI снимают плашку одним
         * маршрутом, а не каждое своим скриптом. Пустой или битый список — отказ с
         * рецептом, а не «ok: true, marked: 0»: вызов, который ничего не отметил,
         * иначе выглядел бы выполненным.
         */
        if (rel === '/api/exchange/mark') {
          let text;
          try {
            text = await readJsonBody(req);
          } catch (error) {
            sendJson(res, error && error.status ? error.status : 400, {
              ok: false,
              code: 'bad-request',
              error: error && error.message ? error.message : 'не удалось прочитать тело запроса',
              fix: 'Передайте { paths: ["<абсолютный путь письма>", ...] } одним JSON-объектом.',
            });
            return;
          }
          let draft;
          try {
            draft = JSON.parse(text || '{}');
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              code: 'bad-request',
              error: 'тело отметки не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'),
              fix: 'Передайте { paths: ["<абсолютный путь письма>", ...] }.',
            });
            return;
          }
          const paths = draft && Array.isArray(draft.paths)
            ? draft.paths.filter((item) => typeof item === 'string' && item.trim())
            : null;
          if (!paths || paths.length === 0) {
            sendJson(res, 400, {
              ok: false,
              code: 'bad-request',
              error: 'пустой список путей: отметить нечего',
              fix: 'Передайте { paths: [...] } с хотя бы одним путём письма — пути берутся из unread[].path скана.',
            });
            return;
          }
          let result;
          try {
            result = markExchangeSeen({ root: selection.root, paths });
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              code: 'mark-failed',
              error: 'не удалось отметить письма: ' + (error && error.message ? error.message : 'ошибка'),
              fix: 'Проверьте права на каталог хранилища (DSH_PROJECT_GRAPH_STORE); отметки живут вне репозитория.',
            });
            return;
          }
          sendJson(res, 200, { ok: true, marked: result.marked });
          return;
        }
        if (rel === '/api/init') {
          const template = url.searchParams.get('template') || 'hierarchy';
          const created = createStarterStructure(runtime, selection.root, template);
          if (!created.ok) {
            sendJson(res, created.status, { error: created.error, fix: created.fix });
            return;
          }
          sendJson(res, 201, {
            ok: true,
            created: created.created,
            template: created.template,
            plugin: runtime.plugin,
            ...(await readGraph(runtime, selection.root)),
          });
          return;
        }
        /*
         * Доказательный отчёт шага (CONTRACT-report-evidence v1): маршрут зовёт тот
         * же модуль, что и приёмочная проверка. Отказ — 422 с code/message/missing/fix,
         * чтобы панель показала не «нельзя», а что именно дописать.
         */
        if (rel === '/api/report-check') {
          let text;
          try {
            text = await readJsonBody(req);
          } catch (error) {
            sendJson(res, error && error.status ? error.status : 400, {
              error: error && error.message ? error.message : 'не удалось прочитать тело запроса',
              fix: 'Передайте { file: "docs/tasks/<id>/report.<node>.json" } одним JSON-объектом: ящик и часы берутся из проекта.',
            });
            return;
          }
          let draft;
          try {
            draft = JSON.parse(text || '{}');
          } catch (error) {
            sendJson(res, 400, {
              error: 'тело проверки отчёта не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'),
              fix: 'Передайте { file: "docs/tasks/<id>/report.<node>.json" }.',
            });
            return;
          }
          /*
           * The clock and the box belong to the runtime, not to the request. A body
           * that could move either one would let the caller pass exactly the check
           * the acceptance check would fail: P-10 would accept a future report and
           * P-5 would look at an empty box instead of the project's letters.
           * draft.now and draft.box are therefore read but never used; the box is
           * the one the project declares in its structure, the clock is Date.now().
           */
          const checked = validateReport({
            root: selection.root,
            file: draft && typeof draft.file === 'string' ? draft.file : '',
            box: projectBox(selection.root, runtime.structureDir) || undefined,
          });
          if (!checked.ok) {
            sendJson(res, 422, {
              ok: false,
              code: checked.code,
              message: checked.message,
              missing: checked.missing,
              fix: checked.fix,
            });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        /*
         * The canvas layout: the only route that writes x/y, and only next to
         * the declaration of an existing node. The body carries its own root, so
         * the request cannot write a node of one project into the panel's
         * default one; selectRoot still refuses anything outside the list.
         */
        if (rel === '/api/layout') {
          let text;
          try {
            text = await readJsonBody(req);
          } catch (error) {
            sendJson(res, error && error.status ? error.status : 400, {
              error: error && error.message ? error.message : 'не удалось прочитать тело запроса',
              fix: 'Передайте раскладку одним JSON-объектом: { root, positions: { nodeId: { x, y } } }.',
            });
            return;
          }
          let draft;
          try {
            draft = JSON.parse(text || '{}');
          } catch (error) {
            sendJson(res, 400, {
              error: 'раскладка не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'),
              fix: 'Проверьте кавычки и запятые в JSON.',
            });
            return;
          }
          const requested = draft && typeof draft.root === 'string' && draft.root.trim()
            ? draft.root.trim()
            : selection.root;
          const choice = selectRoot(runtime, requested);
          if (!choice.root) {
            sendJson(res, 400, {
              error: choice.error,
              fix: 'Передайте корень проекта из списка панели: раскладка пишется только в свой проект.',
            });
            return;
          }
          const saved = saveLayout(runtime, choice.root, draft);
          if (saved.status !== 200) {
            sendJson(res, saved.status, { error: saved.error, fix: saved.fix });
            return;
          }
          sendJson(res, 200, saved);
          return;
        }
        if (rel === '/api/exchange-participants') {
          let text;
          try {
            text = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { error: 'не удалось прочитать тело участников', fix: 'Передайте { root, node, participants }.' });
            return;
          }
          let draft;
          try {
            draft = JSON.parse(text || '{}');
          } catch {
            sendJson(res, 400, { error: 'участники не разбираются как JSON', fix: 'Проверьте кавычки и запятые.' });
            return;
          }
          const requested = draft && typeof draft.root === 'string' && draft.root.trim() ? draft.root.trim() : selection.root;
          const choice = selectRoot(runtime, requested);
          if (!choice.root) {
            sendJson(res, 400, { error: choice.error, fix: 'Передайте корень проекта из списка панели.' });
            return;
          }
          const saved = saveExchangeParticipants(runtime, choice.root, draft);
          if (saved.status !== 200) {
            sendJson(res, saved.status, { error: saved.error, fix: saved.fix });
            return;
          }
          sendJson(res, 200, saved);
          return;
        }
        if (rel === '/api/session') {
          let text;
          try {
            text = await readJsonBody(req);
          } catch (error) {
            sendJson(res, 400, { error: 'не удалось прочитать тело привязки', fix: 'Передайте { root, node, session }.' });
            return;
          }
          let draft;
          try {
            draft = JSON.parse(text || '{}');
          } catch {
            sendJson(res, 400, { error: 'привязка не разбирается как JSON', fix: 'Проверьте кавычки и запятые.' });
            return;
          }
          const requested = draft && typeof draft.root === 'string' && draft.root.trim() ? draft.root.trim() : selection.root;
          const choice = selectRoot(runtime, requested);
          if (!choice.root) {
            sendJson(res, 400, { error: choice.error, fix: 'Передайте корень проекта из списка панели.' });
            return;
          }
          const saved = saveSessionBinding(runtime, choice.root, draft);
          if (saved.status !== 200) {
            sendJson(res, saved.status, { error: saved.error, fix: saved.fix });
            return;
          }
          sendJson(res, 200, saved);
          return;
        }
        if (rel === '/api/schedule') {
          let text;
          try {
            text = await readJsonBody(req);
          } catch (error) {
            sendJson(res, error && error.status ? error.status : 400, {
              error: error && error.message ? error.message : 'не удалось прочитать тело запроса',
              fix: 'Передайте { root, node, at: "HH:MM" } одним JSON-объектом.',
            });
            return;
          }
          let draft;
          try {
            draft = JSON.parse(text || '{}');
          } catch (error) {
            sendJson(res, 400, { error: 'расписание не разбирается как JSON', fix: 'Проверьте кавычки и запятые в JSON.' });
            return;
          }
          const requested = draft && typeof draft.root === 'string' && draft.root.trim() ? draft.root.trim() : selection.root;
          const choice = selectRoot(runtime, requested);
          if (!choice.root) {
            sendJson(res, 400, { error: choice.error, fix: 'Передайте корень проекта из списка панели: расписание правится только в своём проекте.' });
            return;
          }
          const saved = saveSchedule(runtime, choice.root, draft);
          if (saved.status !== 200) {
            sendJson(res, saved.status, { error: saved.error, fix: saved.fix });
            return;
          }
          sendJson(res, 200, saved);
          return;
        }
        if (rel === '/api/node') {
          let text;
          try {
            text = await readJsonBody(req);
          } catch (error) {
            sendJson(res, error && error.status ? error.status : 400, {
              error: error && error.message ? error.message : 'не удалось прочитать тело запроса',
              fix: 'Передайте узел одним JSON-объектом: { "id": "..." }.',
            });
            return;
          }
          let draft;
          try {
            draft = JSON.parse(text || '{}');
          } catch (error) {
            sendJson(res, 400, {
              error: 'узел не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'),
              fix: 'Проверьте кавычки и запятые в JSON.',
            });
            return;
          }
          const action = url.searchParams.get('action') || 'add';
          if (action !== 'add' && action !== 'update' && action !== 'remove') {
            sendJson(res, 400, { error: 'действие узла должно быть add, update или remove', fix: 'Передайте action=add, action=update или action=remove.' });
            return;
          }
          /* Удаление — своё действие: узел и все его связи уходят одним заданием. */
          if (action === 'remove') {
            const removed = removeNode(runtime, selection.root, draft);
            if (removed.status !== 200) {
              sendJson(res, removed.status, { error: removed.error, fix: removed.fix });
              return;
            }
            sendJson(res, 200, { ok: true, removed: removed.removed, file: removed.file, edges: removed.edges });
            return;
          }
          /*
           * Каталог читается до записи: отказ маршрута (provider-missing,
           * model-missing, catalog-unavailable) приходит с кодом, чтобы панель
           * показала не «нельзя», а что именно выбрано и что доступно.
           */
          const catalog = await readModelCatalog(runtime);
          const result = action === 'update'
            ? updateNode(runtime, selection.root, draft, { catalog })
            : addNode(runtime, selection.root, draft, { catalog });
          if (result.status !== 200) {
            sendJson(res, result.status, {
              ok: false,
              ...(result.code ? { code: result.code } : {}),
              error: result.error,
              fix: result.fix,
            });
            return;
          }
          sendJson(res, action === 'update' ? 200 : 201, { ok: true, file: result.file, node: result.node });
          return;
        }
        /*
         * Папка обмена: создание, правка, удаление и ревизия контракта. Корень
         * проекта берётся из запроса или из тела (абсолютный путь), а поля самой
         * папки — из тела: box.root у папки значит «shared/workspace», не путь.
         */
        if (rel === '/api/folder') {
          let text;
          try {
            text = await readJsonBody(req);
          } catch (error) {
            sendJson(res, error && error.status ? error.status : 400, {
              error: error && error.message ? error.message : 'не удалось прочитать тело запроса',
              fix: 'Передайте папку одним JSON-объектом: { id, box, exchange, participants, orchestrator }.',
            });
            return;
          }
          let draft;
          try {
            draft = JSON.parse(text || '{}');
          } catch (error) {
            sendJson(res, 400, {
              error: 'папка не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'),
              fix: 'Проверьте кавычки и запятые в JSON.',
            });
            return;
          }
          if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
            sendJson(res, 400, { error: 'папка должна быть JSON-объектом', fix: 'Передайте { id, box, participants, orchestrator }.' });
            return;
          }
          const action = url.searchParams.get('action') || 'add';
          if (action !== 'add' && action !== 'update' && action !== 'remove' && action !== 'contract'
            && action !== 'accept' && action !== 'disconnect' && action !== 'join' && action !== 'decline') {
            sendJson(res, 400, {
              error: 'действие папки должно быть add, update, remove, contract, accept, disconnect, join или decline',
              fix: 'Передайте action=add, action=update, action=remove, action=contract, action=accept, action=disconnect, action=join или action=decline.',
            });
            return;
          }
          const declaredRoot = typeof draft.root === 'string' && draft.root.trim() && path.isAbsolute(draft.root.trim())
            ? draft.root.trim()
            : selection.root;
          const choice = selectRoot(runtime, declaredRoot);
          if (!choice.root) {
            sendJson(res, 400, { error: choice.error, fix: 'Передайте корень проекта из списка панели: папка пишется только в свой проект.' });
            return;
          }
          const saved = saveFolder(runtime, choice.root, action, draft);
          if (saved.status !== 200) {
            /*
             * Отказ участника несёт не только рецепт: similar — похожие метки
             * реестра, free — свободное имя контракта, label — виновника.
             * Панель показывает их человеку, а проверка читает тело.
             */
            sendJson(res, saved.status, {
              error: saved.error,
              fix: saved.fix,
              ...(saved.code ? { code: saved.code } : {}),
              ...(Array.isArray(saved.similar) ? { similar: saved.similar } : {}),
              ...(saved.label ? { label: saved.label } : {}),
              ...(saved.initiator ? { initiator: saved.initiator } : {}),
              ...(Array.isArray(saved.unresolved) ? { unresolved: saved.unresolved } : {}),
              ...(saved.free ? { free: saved.free } : {}),
            });
            return;
          }
          sendJson(res, 200, { ...saved, action });
          return;
        }
        if (rel === '/api/check' || rel === '/api/build') {
          let text;
          try {
            text = await readJsonBody(req);
          } catch (error) {
            sendJson(res, error && error.status ? error.status : 400, {
              error: error && error.message ? error.message : 'не удалось прочитать тело запроса',
              fix: 'Передайте граф одним JSON-объектом.',
            });
            return;
          }
          let draft;
          try {
            draft = JSON.parse(text);
          } catch (error) {
            sendJson(res, 400, {
              error: 'граф не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'),
              fix: 'Проверьте кавычки и запятые в JSON.',
            });
            return;
          }
          if (rel === '/api/check') {
            const checked = await checkDraft(runtime, draft);
            sendJson(res, 200, checked);
            return;
          }
          const built = await buildStructure(runtime, selection.root, draft, url.searchParams.get('overwrite') === 'true');
          if (built.status !== 200) {
            sendJson(res, built.status, {
              error: built.error,
              fix: built.fix,
              ...(built.details ? { details: built.details } : {}),
            });
            return;
          }
          sendJson(res, 200, { ok: true, file: built.file, ...built });
          return;
        }
        const result = editLink(runtime, selection.root, {
          action: url.searchParams.get('action'),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          kind: url.searchParams.get('kind'),
        });
        if (result.status !== 200) {
          sendJson(res, result.status, { error: result.error, fix: result.fix });
          return;
        }
        sendJson(res, 200, { ok: true, file: result.file, action: result.action });
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, {
          error: 'панель не поддерживает метод ' + method,
          fix: 'Панель читает структуру, создаёт стартовую и меняет связи; остальное — вручную.',
        });
        return;
      }

      if (rel === '/' || rel === '/api/status') {
        sendJson(res, 200, {
          plugin: runtime.plugin,
          roots: runtime.allowedRoots(),
          /* Same fallback as selectRoot: the registry may arrive after the runtime. */
        defaultRoot: runtime.defaultRoot || (runtime.allowedRoots()[0] || null),
          structureDir: runtime.structureDir,
          edgeKinds: EDGE_KINDS,
          /*
           * Реестр воркспейсов для панели (задание 0024): участник папки
           * выбирается из него, а не печатается. Один и тот же список сверяет
           * сервер при POST /api/folder — панель не может позвать не того.
           */
          workspaces: workspaceRegistry(runtime),
          /* The card needs to know whether it may offer an install button at all. */
          workflow: { installSpec: runtime.workflowInstallSpec || null },
        });
        return;
      }

      /*
       * Версия структуры против последнего релиза (задание 0105). Режим установки
       * (пакет или ссылка на каталог) — свойство профиля, а не проекта, поэтому
       * root принимается для симметрии с панелью и на ответ не влияет. Проверка
       * ходит в сеть и не бросает: сбой возвращается полем error, панель
       * показывает повтор.
       */
      if (rel === '/api/release') {
        const fetcher = typeof runtime.fetchStructureRelease === 'function' ? runtime.fetchStructureRelease : null;
        const checked = await checkStructureRelease({
          current: PLUGIN_VERSION,
          mode: readStructureInstallMode(runtime),
          ...(fetcher ? { fetcher } : {}),
        });
        sendJson(res, 200, checked);
        return;
      }

      if (rel === '/api/activity') {
        const selection = selectRoot(runtime, url.searchParams.get('root'));
        if (!selection.root) {
          sendJson(res, 400, {
            error: selection.error,
            fix: 'Передайте абсолютный root из списка проектов панели.',
          });
          return;
        }
        sendJson(res, 200, { ok: true, runs: listRuns(runtime, selection.root) });
        return;
      }

      /*
       * Live agents of the host, mapped onto this project's nodes.
       *
       * The open session sees only its own children; an agent started from another
       * session or workspace is alive too. The route reads them from ctx.agents and
       * matches each one by cwd and label. A missing service is not an error: the
       * panel gets an empty list with a recipe and keeps working.
       */
      if (rel === '/api/live') {
        const selection = selectRoot(runtime, url.searchParams.get('root'));
        if (!selection.root) {
          sendJson(res, 400, {
            error: selection.error,
            fix: 'Передайте абсолютный root из списка проектов панели.',
          });
          return;
        }
        let nodes = [];
        let folders = [];
        try {
          const graphPayload = readGraph(runtime, selection.root);
          nodes = (graphPayload.graph && graphPayload.graph.nodes) || [];
          folders = (graphPayload.graph && graphPayload.graph.folders) || [];
        } catch {
          nodes = [];
          folders = [];
        }
        const live = await readLiveAgentRows(runtime);
        /*
         * The agent service is the primary source, but in some host builds it hands
         * the plugin nothing. Sessions on disk are the second source: a recently
         * written journal proves work is happening here even when no agent is
         * visible, and the binding already knows which node that session works on.
         */
        const sessions = readSessionActivity(selection.root,
          typeof runtime.sessionsDir === 'string' && runtime.sessionsDir.trim() ? { sessionsDir: runtime.sessionsDir } : {});
        /*
         * The run journal is the third source, and the only one that names the node
         * actually working: the tools write { node, state: 'running', root, since }
         * when they start, so a running record of this root is an exact fact of the
         * run. Reading it must never fail the route: a broken store is no evidence,
         * not a 500.
         */
        let runs = [];
        try {
          runs = listRuns(runtime, selection.root);
        } catch {
          runs = [];
        }
        const sample = live.agents.length > 0
          ? Object.fromEntries(Object.entries(live.agents[0]).filter(([key]) => ['id', 'cwd', 'state', 'label', 'title', 'role'].includes(key)))
          : null;
        /*
         * Who works on which node is a projection, not a declaration: the route
         * computes it from the sessions and the pins on every call, so the panel
         * never writes the answer into structure/*.json. Pins are read from the
         * profile file; a missing or broken file is an empty map with a reason,
         * never an exception on the route.
         */
        const pinState = readSessionPins(runtime);
        const pinReport = {
          file: pinState.file,
          count: pinState.count,
          ...(pinState.error ? { error: pinState.error } : {}),
        };
        const mapped = live.available
          ? mapLiveAgents(live.agents, selection.root, nodes)
          : { agents: [], active: [], unknown: [] };
        /*
         * The binding is computed even without the agents service: sessions on disk
         * are enough for the automatic source, and the service reason is not hidden.
         */
        const now = Date.now();
        const bound = bindSessions({
          root: selection.root,
          sessions: sessions.items,
          nodes,
          folders,
          agents: mapped.agents,
          pins: pinState.pins,
          now,
        });
        const bindingFields = {
          binding: bound.binding,
          ...(bound.reason ? { bindingReason: bound.reason } : {}),
        };
        /*
         * Every session gets its node and the name of the source, one row at a
         * time: the binding covers one session, an agent of this root covers its
         * own, and a running record of the run journal covers the child it started.
         * What remains without a node is "outside the structure" — and only while
         * it is actually running. The projection invents no node and no role.
         */
        const attributed = attributeSessions({
          root: selection.root,
          sessions: sessions.items,
          nodes,
          binding: bound.binding,
          agents: mapped.agents,
          runs,
          now,
        });
        /*
         * Живой дефект 2026-11-06: сессия, привязанная к узлу (binding/run), оставалась
         * в mapped.unknown, потому что хост отдаёт голую сессию без метки — панель
         * показывала «вне структуры: 1», хотя это работающий координатор. Неизвестный
         * агент — только тот, кому узел не достался ни одним источником.
         */
        const attributedIds = new Set(attributed.items
          .filter((row) => row && row.node)
          .map((row) => row.id));
        const unknownAgents = mapped.unknown.filter((id) => !attributedIds.has(id));
        const base = {
          root: selection.root,
          label: path.basename(selection.root),
          sessions: { running: sessions.running, items: attributed.items.slice(0, 10) },
          /* Unattributed sessions of this root, with the agent label when the host gave one. */
          unattributed: attributed.unattributed,
          total: live.agents.length,
          sample,
          pins: pinReport,
        };
        /*
         * Activity has three honest sources and the answer names which one: a live
         * agent of this root, a running record of the run journal, or the fresh
         * journal of the session bound to a node. The run journal is what makes the
         * node actually working light up: the binding points at the freshest
         * session of the workspace (the orchestrator), so a run of the worker or the
         * judge used to light the coordinator and leave the working node grey.
         * Priority is agent > run > session: an agent is the strongest fact, a run
         * record is exact about the node, and a session journal only proves that
         * someone works here. No source invents a node, and a session is never
         * counted as an unnamed agent.
         */
        const runActivity = mapRunActivity({
          active: mapped.active,
          runs,
          nodes,
          root: selection.root,
          now,
        });
        const sessionActivity = mapNodeActivity({
          active: mapped.active,
          binding: bound.binding,
          sessions: sessions.items,
        });
        const activity = { active: [...runActivity.active], activityByNode: { ...runActivity.activityByNode } };
        for (const node of sessionActivity.active) {
          if (!activity.active.includes(node)) activity.active.push(node);
          /* A run record (or an agent) on the same node is stronger than a journal. */
          if (!activity.activityByNode[node]) activity.activityByNode[node] = 'session';
        }
        const activityFields = {
          active: activity.active,
          activityByNode: activity.activityByNode,
        };
        if (!live.available) {
          sendJson(res, 200, {
            ...base,
            ...bindingFields,
            ...activityFields,
            agents: [],
            unknown: [],
            reason: 'служба живых агентов недоступна: хост не передал ctx.agents'
              + (live.message ? ' (' + live.message + ')' : '')
              + ' — активность показана по журналу запусков и по сессиям, без имён агентов.',
            fix: 'Живые агенты приходят из ctx.agents; без службы панель видит работу по журналу запусков и по сессиям, но не имён агентов.',
          });
          return;
        }
        sendJson(res, 200, {
          ...base,
          ...bindingFields,
          ...activityFields,
          agents: mapped.agents,
          unknown: unknownAgents,
        });
        return;
      }

      if (rel === '/api/presets') {
        const presets = readRuntimeService(runtime, 'getPresets');
        if (!presets || typeof presets.list !== 'function') {
          sendJson(res, 200, {
            ok: false,
            presets: [],
            error: 'список пресетов недоступен: служба agentPresets не подключена',
            fix: 'Проверьте, что плагин пресетов загружен; id пресета можно ввести вручную.',
          });
          return;
        }
        const presetsDocument = typeof presets.readDocument === 'function' ? presets.readDocument.bind(presets) : null;
        let rows = [];
        try {
          rows = (await presets.list()) || [];
        } catch (error) {
          sendJson(res, 500, {
            error: 'не удалось прочитать пресеты: ' + (error && error.message ? error.message : 'ошибка'),
            fix: 'Проверьте настройки пресетов в DSH.',
          });
          return;
        }
        const items = [];
        for (const row of rows) {
          if (!row || !row.id) continue;
          let plugins = [];
          if (!row.broken && typeof presetsDocument === 'function') {
            try {
              const document = await presetsDocument(row.id);
              if (document && typeof document.content === 'string') {
                plugins = [...document.content.matchAll(/^\s*(?:-\s*)?name:\s*["']?([^"'\n]+)/gmu)]
                  .map((match) => match[1].trim())
                  .filter((name, index, all) => name && all.indexOf(name) === index)
                  .slice(0, 12);
              }
            } catch { plugins = []; }
          }
          items.push({
            id: row.id,
            ...(row.name ? { name: row.name } : {}),
            ...(row.description ? { description: row.description } : {}),
            ...(row.broken ? { broken: true } : {}),
            ...(plugins.length > 0 ? { plugins } : {}),
          });
        }
        sendJson(res, 200, { ok: true, presets: items });
        return;
      }

      if (rel === '/api/models') {
        /*
         * Каталог читается при КАЖДОМ вызове: список моделей — факт рантайма на
         * момент вопроса, а не запомненный ответ. Отметка at говорит, когда
         * именно служба ответила. Отказ службы тоже датирован и несёт рецепт:
         * молча пустого списка не бывает.
         */
        const catalog = await readModelCatalog(runtime);
        if (catalog.ok !== true) {
          sendJson(res, 200, {
            ok: false,
            at: catalog.at,
            providers: [],
            error: 'список моделей недоступен: ' + (catalog.reason || 'служба llm не ответила'),
            fix: 'Проверьте, что плагин LLM загружен и отвечает, затем обновите панель. '
              + 'Пока каталог недоступен, маршруты узлов имеют статус unknown, и панель не подставляет модель по умолчанию.',
          });
          return;
        }
        sendJson(res, 200, { ok: true, at: catalog.at, source: 'llm', providers: catalog.providers });
        return;
      }

      if (rel === '/api/projects') {
        const projects = runtime.allowedRoots().map((root) => {
          if (!fs.existsSync(root)) {
            return { root, name: path.basename(root), exists: false, hasStructure: false, error: 'корень не найден', nodes: 0, edges: 0, errors: 1, warnings: 0 };
          }
          const payload = readGraph(runtime, root);
          return {
            root,
            name: payload.name,
            exists: true,
            hasStructure: payload.exists,
            nodes: payload.summary.nodes,
            edges: payload.summary.edges,
            errors: payload.errors.length,
            warnings: payload.warnings.length,
          };
        });
        sendJson(res, 200, { plugin: runtime.plugin, projects });
        return;
      }

      if (rel === '/api/exchange') {
        const selection = selectRoot(runtime, url.searchParams.get('root'));
        if (!selection.root) {
          sendJson(res, 400, { error: selection.error, fix: 'Выберите проект в панели или передайте root абсолютным путём.' });
          return;
        }
        try {
          /*
           * A declared folder is authoritative: its box is the only source, and its
           * declared participants are shown as they are. Without declarations the
           * legacy single portal remains (auto-discovered coordination), but it
           * belongs to THIS workspace only: the read uses the workspace's own name,
           * so foreign labels and foreign letters never enter it.
           */
          let folders = [];
          let foldersError = null;
          try {
            folders = readExchangeFolders(runtime, selection.root);
          } catch (error) {
            folders = [];
            foldersError = 'не удалось прочитать папки обмена: '
              + (error && error.message ? error.message : 'ошибка');
          }
          const declared = folders.length > 0;
          const boxes = folders
            .map((folder) => (folder && typeof folder.box === 'string' ? folder.box : ''))
            .filter(Boolean);
          const facts = declared
            ? readExchange(selection.root, {
              paths: boxes,
              discover: false,
              participants: runtime.participants,
              me: runtime.me,
            })
            : readExchange(selection.root, { paths: [], discover: true, selfOnly: true });
          /*
           * One portal per folder the STRUCTURE declares: the panel draws the list,
           * and a broken folder is one element with an error instead of a failed read.
           * Участник отдаётся парой «метка + каталог» (задание 0028, D3): members
           * [{ label, path, name }], а неразрешённая метка — states[label] =
           * 'unresolved', чтобы панель не выдавала чужую подпись за воркспейс.
           */
          const participantWarnings = [];
          const warnedLabels = new Set();
          facts.folders = folders.map((folder) => {
            const members = exchangeMemberRows(runtime, selection.root, folder);
            const states = folder && folder.states && typeof folder.states === 'object'
              ? { ...folder.states }
              : {};
            for (const member of members) {
              if (member.path === null) states[member.label] = 'unresolved';
            }
            /*
             * self — сторона этого воркспейса в папке (задание 0030, D2). null
             * означает «своя метка не опознана»: панель тогда не применяет 409
             * и показывает, что сторона не определена.
             */
            const self = exchangeSelfRow(runtime, selection.root, folder, members);
            /*
             * Предупреждения о неразрешённых участниках (задание 0052, WC-15):
             * панель не имеет права показывать их пустой ящик как «0 писем».
             * Метка повторяется из папки в папку — предупреждение одно.
             */
            for (const warning of exchangeUnresolvedWarnings(runtime, selection.root, folder, members, self)) {
              const key = warning.code + ':' + warning.label.toLowerCase();
              if (warnedLabels.has(key)) continue;
              warnedLabels.add(key);
              participantWarnings.push(warning);
            }
            return { ...folder, members, states, self };
          });
          facts.warnings = participantWarnings;
          if (foldersError) facts.foldersError = foldersError;
          /*
           * Непрочитанные письма (задание 0082): тот же scanExchange, что у CLI
           * и у /api/exchange/scan, поэтому панель показывает число, не открывая
           * ящик, и второго счёта нет. Поле unread добавлено рядом: прежние
           * label/links/folders/warnings не меняются.
           */
          facts.unread = exchangeUnread({ root: selection.root, runtime });
          sendJson(res, 200, facts);
        } catch (error) {
          sendJson(res, 500, {
            error: 'не удалось прочитать обмен: ' + (error && error.message ? error.message : 'ошибка'),
            fix: 'Проверьте права на папку обмена; панель читает только шапки сообщений.',
          });
        }
        return;
      }
      /*
       * Сканер обмена (задание 0077): один ответ на вопрос «что не разобрано».
       * unread — письма этому воркспейсу, которых нет в отметках прочитанного;
       * obligations — тот же вывод, что у /api/obligations, чтобы плашка панели и
       * скан не расходились в том, какая обязанность не выполнена.
       */
      if (rel === '/api/exchange/scan') {
        const selection = selectRoot(runtime, url.searchParams.get('root'));
        if (!selection.root) {
          sendJson(res, 400, {
            ok: false,
            code: 'no-root',
            error: selection.error,
            fix: 'Выберите проект в панели или передайте root абсолютным путём.',
          });
          return;
        }
        if (!fs.existsSync(selection.root)) {
          sendJson(res, 404, {
            ok: false,
            code: 'no-root',
            error: 'корень не найден: ' + selection.root,
            fix: 'Проверьте путь в roots: папка проекта должна существовать.',
          });
          return;
        }
        let scan;
        try {
          scan = scanExchange({ root: selection.root });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            code: 'scan-failed',
            error: 'не удалось прочитать обмен: ' + (error && error.message ? error.message : 'ошибка'),
            fix: 'Проверьте права на папку обмена; сканер читает только шапки писем.',
          });
          return;
        }
        let status = null;
        try {
          status = evaluateObligations({ root: selection.root });
        } catch {
          status = null;
        }
        const obligations = status && Array.isArray(status.obligations) ? status.obligations : [];
        if (scan.error) {
          sendJson(res, 200, {
            ok: false,
            code: scan.error.code,
            error: scan.error.error,
            fix: scan.error.fix,
            unread: [],
            seen: 0,
            skipped: [],
            boxes: [],
            obligations,
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          unread: scan.unread,
          seen: scan.seen,
          skipped: scan.skipped,
          boxes: scan.boxes,
          obligations,
        });
        return;
      }
      /*
       * Обязанности структуры: домен проверяется машинно, а не обещается текстом.
       * Ответ всегда 200 с `ok` — панель показывает отказ как факт, а не как
       * сломанную страницу; `fix` называет, что именно поправить в структуре.
       */
      if (rel === '/api/obligations') {
        const selection = selectRoot(runtime, url.searchParams.get('root'));
        if (!selection.root) {
          sendJson(res, 400, {
            ok: false,
            code: 'no-root',
            error: selection.error,
            fix: 'Выберите проект в панели или передайте root абсолютным путём.',
          });
          return;
        }
        let status;
        try {
          status = evaluateObligations({ root: selection.root });
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            code: 'obligations-failed',
            error: 'не удалось проверить обязанности: ' + (error && error.message ? error.message : 'ошибка'),
            fix: 'Проверьте структуру и права на каталог хранилища; маршрут не роняет панель.',
          });
          return;
        }
        if (status.error) {
          sendJson(res, 200, {
            ok: false,
            code: status.error.code,
            error: status.error.error,
            fix: status.error.fix,
          });
          return;
        }
        sendJson(res, 200, { ok: true, workspace: status.workspace, obligations: status.obligations });
        return;
      }
      if (rel === '/api/graph') {
        const selection = selectRoot(runtime, url.searchParams.get('root'));
        if (!selection.root) {
          sendJson(res, 400, {
            error: selection.error,
            fix: 'Добавьте абсолютный путь проекта в roots (cordis.patch.yml) и перезагрузите плагин.',
          });
          return;
        }
        if (!fs.existsSync(selection.root)) {
          sendJson(res, 404, {
            error: 'корень не найден: ' + selection.root,
            fix: 'Проверьте путь в roots: папка проекта должна существовать.',
          });
          return;
        }
        /*
         * Ленту отдаём после ожидания: маршруты моделей должны быть сверены с
         * каталогом службы llm на момент этого ответа, а не на момент начала.
         */
        const graphPayload = await readGraph(runtime, selection.root);
        sendJson(res, 200, { plugin: runtime.plugin, ...graphPayload });
        return;
      }

      /*
       * Альтернативный путь виден панели: последние события журнала (не больше
       * 50, новые первыми). Это наблюдение, а не контракт — поэтому даже ошибка
       * чтения отдаётся как `ok: true` с пустым списком и предупреждением:
       * плашка в панели не имеет права ломаться из-за журнала.
       */
      if (rel === '/api/alternatives') {
        const selection = selectRoot(runtime, url.searchParams.get('root'));
        if (!selection.root) {
          sendJson(res, 200, {
            ok: true,
            events: [],
            warnings: [{
              code: 'no-root',
              message: selection.error || 'не выбран корень проекта для журнала альтернативных вызовов',
              fix: 'Добавьте абсолютный путь проекта в roots (cordis.patch.yml) и перезагрузите плагин.',
            }],
          });
          return;
        }
        try {
          sendJson(res, 200, { ok: true, events: readAlternatives({ root: selection.root }) });
        } catch (error) {
          sendJson(res, 200, {
            ok: true,
            events: [],
            warnings: [{
              code: 'alternatives-unreadable',
              message: 'не удалось прочитать журнал альтернативных вызовов: '
                + (error && error.message ? error.message : 'ошибка'),
              fix: 'Проверьте права на каталог хранилища; журнал живёт вне репозитория и не влияет на структуру.',
            }],
          });
        }
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      if (res && res.writableEnded !== true) {
        sendJson(res, 500, { error: error && error.message ? error.message : 'Internal server error' });
      }
    }
  };
}

function warn(ctx, message) {
  try {
    ctx.logger.warn(message);
  } catch {
    console.warn('[dsh-project-graph] ' + message);
  }
}

/** Route currently registered per runtime, so a repeated call does not re-register. */
const routeByRuntime = new WeakMap();

/** The one watchdog this module instance runs; a newer activation replaces it. */
let routeWatchdog = null;

/**
 * How often the claimed prefix route is re-checked, in milliseconds. The panel
 * is useless while the route is missing, so the re-check stays frequent; each
 * pass is one Map lookup.
 */
export const ROUTE_WATCHDOG_MS = 2000;

/**
 * Register the `/project-graph` prefix route on the DSH web server.
 *
 * The route is registered directly, never through `ctx.effect`: an effect that
 * belongs to the injected activation scope is disposed when that scope goes
 * away, and its disposer deletes the route by key — the panel then answers 404
 * from the server's empty fallback while the tools keep working. That is the
 * failure this watchdog exists for.
 *
 * A watchdog re-claims the route, because a disposer of a *dead* fiber deletes
 * by key without asking who owns it. A route stamped by a later activation is
 * left alone, so two live copies of the plugin do not flap the route between
 * their runtimes.
 *
 * @param ctx - web-server injection scope (`ctx.webServer`, optional `ctx.effect`).
 * @param runtime - the runtime the routes and the tools share.
 * @param options.watchdogMs - re-check period; tests shorten it.
 * @returns the registered route descriptor.
 */
export function registerGraphWeb(ctx, runtime, options = {}) {
  const watchdogMs =
    Number.isFinite(options.watchdogMs) && options.watchdogMs > 0 ? options.watchdogMs : ROUTE_WATCHDOG_MS;

  const prefixTable = () => {
    try {
      const server = ctx.webServer;
      return server && server.prefixes && typeof server.prefixes.get === 'function' ? server.prefixes : null;
    } catch {
      return null;
    }
  };

  /* A second call for the same runtime is not a new activation: keep its route. */
  const previous = routeByRuntime.get(runtime);
  if (previous) {
    const table = prefixTable();
    if (table && table.get(API_PREFIX) === previous) return previous;
  }

  const handler = createWebHandler(runtime);
  const route = { kind: 'prefix', path: API_PREFIX, handler };
  /* Wall-clock stamp: the newest activation keeps the seat. */
  const stamp = Date.now();
  route.stamp = stamp;
  routeByRuntime.set(runtime, route);

  const ownsRoute = () => {
    const table = prefixTable();
    if (!table) return false;
    const current = table.get(API_PREFIX);
    return Boolean(current) && current.handler === handler;
  };

  const claim = () => {
    let server;
    try {
      server = ctx.webServer;
    } catch {
      server = null;
    }
    if (!server || typeof server.register !== 'function') return false;
    if (ownsRoute()) return true;
    const table = prefixTable();
    const current = table ? table.get(API_PREFIX) : undefined;
    if (current && Number.isFinite(current.stamp) && current.stamp > stamp) return false;
    /* A stale owner: its fiber is gone, and its disposer can no longer help. */
    try {
      if (table && typeof table.delete === 'function') table.delete(API_PREFIX);
    } catch {
      /* the table is read-only in some hosts; register() then reports the clash */
    }
    try {
      server.register(route);
    } catch {
      /* a concurrent claim won the race; ownership is read below */
    }
    return ownsRoute();
  };

  /* Claim now: activation must not wait for the first watchdog pass. */
  claim();
  if (typeof setInterval === 'function') {
    if (routeWatchdog !== null && typeof clearInterval === 'function') clearInterval(routeWatchdog);
    routeWatchdog = setInterval(claim, watchdogMs);
    /*
     * Do not tie the timer to `ctx.effect`: the scope that runs this function is
     * exactly the scope whose teardown deletes the route, so a scoped cleanup
     * would disarm the watchdog at the same moment it is needed. A newer
     * activation replaces this timer instead, so reloads do not pile up guards.
     */
    if (routeWatchdog && typeof routeWatchdog.unref === 'function') routeWatchdog.unref();
  }
  return route;
}