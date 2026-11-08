/**
 * Один резолвер ящика обмена (задание 0078).
 *
 * До этого задания правил было два: lib/obligations.js брал для box.root: shared
 * БЛИЖАЙШЕГО предка, у которого уже есть каталог box.path, а панель считала
 * общий корень как commonParent(путей участников). В воркспейсе со своим
 * coordination ближайший предок — сам воркспейс, поэтому shared-папка
 * склеивалась с workspace-папкой: две папки указывали в один каталог, письма
 * дизайнера не были видны, одно письмо считалось дважды.
 *
 * Теперь правило одно и живёт здесь:
 *
 *   workspace — root + box.path;
 *   shared    — commonParent(путей участников) + box.path, и НИКОГДА каталог
 *               внутри своего воркспейса. Пути участников берутся из
 *               folder.paths, иначе из roots по метке участника.
 *
 * Если общего предка нет, кандидатов несколько (включая свой каталог) или один
 * каталог объявлен двумя папками — это явная ошибка с кодом и кандидатами, а не
 * тихий выбор ближайшего. Ошибка одной папки не ломает остальные: сканер
 * получает status:'error' для неё и продолжает работу.
 *
 * Модуль не импортирует DSH и lib/api.js: его могут звать панель, CLI,
 * обязанности и сторож обмена.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readStructure } from './load.js';

/** Насколько высоко ищутся каталоги-кандидаты, когда путей участников нет. */
const MAX_CANDIDATE_DEPTH = 5;

/** Ключ сравнения путей: платформа решает, важен ли регистр. */
function pathKey(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Путь внутри root (сам root считается внутри). */
export function isInsidePath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Уникальные абсолютные пути в порядке появления. */
function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const resolved = path.resolve(value.trim());
    const key = pathKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

/**
 * Самый глубокий каталог, содержащий КАЖДЫЙ из путей.
 *
 * Пустая строка — общего предка нет (например, участники на разных дисках).
 */
export function commonParent(roots) {
  const list = uniquePaths(roots);
  if (list.length === 0) return '';
  let common = list[0];
  for (const other of list.slice(1)) {
    for (;;) {
      if (pathKey(other) === pathKey(common) || isInsidePath(common, other)) break;
      const parent = path.dirname(common);
      if (parent === common) break;
      common = parent;
    }
  }
  return common;
}

/** Пути, объявленные самой папкой: метка -> абсолютный путь. */
function folderPathsOf(folder) {
  const raw = folder && folder.paths;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
  const map = new Map();
  for (const [label, value] of Object.entries(raw)) {
    if (typeof label !== 'string' || !label.trim()) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    map.set(label.trim(), path.resolve(value.trim()));
  }
  return map;
}

/** Реестр меток воркспейсов по всем папкам структуры (folder.paths). */
function registryOf(folders, root) {
  const registry = new Map();
  const workspaces = [];
  const add = (label, value) => {
    if (typeof label !== 'string' || !label.trim()) return;
    if (typeof value !== 'string' || !value.trim()) return;
    const resolved = path.resolve(value.trim());
    if (!registry.has(label.trim())) registry.set(label.trim(), resolved);
    if (!workspaces.some((item) => pathKey(item) === pathKey(resolved))) workspaces.push(resolved);
  };
  for (const folder of Array.isArray(folders) ? folders : []) {
    for (const [label, value] of folderPathsOf(folder)) add(label, value);
  }
  if (root) add(path.basename(root), root);
  return { registry, workspaces };
}

/** Отказ резолвера: папка названа, код и кандидаты — в ответе. */
function failure(folderId, code, message, extra = {}) {
  const result = { folderId, path: null, status: 'error', code, message: String(message || '') };
  if (Array.isArray(extra.candidates) && extra.candidates.length > 0) {
    result.candidates = uniquePaths(extra.candidates);
  }
  return result;
}

/** Каталог-кандидат рядом с воркспейсом: перебор предков, но без тихого выбора. */
function ancestorCandidates(root, relative) {
  const found = [];
  const seen = new Set();
  let current = path.resolve(root);
  for (let depth = 0; depth < MAX_CANDIDATE_DEPTH; depth += 1) {
    const candidate = path.resolve(current, relative);
    if (!seen.has(pathKey(candidate))) {
      seen.add(pathKey(candidate));
      try {
        if (fs.statSync(candidate).isDirectory()) found.push(candidate);
      } catch {
        /* каталога нет — не кандидат */
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

/** Проверить общий корень: он должен содержать воркспейс и лежать вне его. */
function validateBase(base, paths, root, folderId, relative) {
  if (!base) {
    return failure(folderId, 'shared-ambiguous',
      'у папки «' + folderId + '» box.root: shared, но у участников нет общего каталога: '
        + paths.join(', ') + ' — укажите box.root: workspace',
      { candidates: paths.map((item) => path.resolve(item, relative)) });
  }
  const insideAll = paths.every((item) => pathKey(item) === pathKey(base) || isInsidePath(base, item));
  if (!insideAll) {
    return failure(folderId, 'shared-ambiguous',
      'у папки «' + folderId + '» box.root: shared, но у участников нет общего каталога: '
        + paths.join(', ') + ' — укажите box.root: workspace',
      { candidates: paths.map((item) => path.resolve(item, relative)) });
  }
  if (pathKey(base) === pathKey(root) || isInsidePath(root, base)) {
    return failure(folderId, 'shared-ambiguous',
      'у папки «' + folderId + '» box.root: shared указывает внутрь своего воркспейса: '
        + path.resolve(base, relative) + ' — общий ящик должен лежать вне ' + root,
      { candidates: [path.resolve(base, relative), path.resolve(root, relative)] });
  }
  if (!isInsidePath(base, root)) {
    return failure(folderId, 'shared-ambiguous',
      'у папки «' + folderId + '» box.root: shared: общий каталог ' + base
        + ' не содержит воркспейс ' + root + ' — укажите box.root: workspace',
      { candidates: [path.resolve(base, relative)] });
  }
  return null;
}

/**
 * Разрешить ящик одной папки.
 *
 * @param root - абсолютный корень объявившего воркспейса.
 * @param folder - запись folders[] структуры.
 * @param roots - разрешённые корни воркспейсов участников (необязательно).
 * @param folders - все папки структуры, если вызывающий их уже прочитал.
 * @returns { folderId, path, status:'ok'|'error', code?, message?, candidates? }.
 */
export function resolveBox({ root, folder, roots, folders, claimed = [] } = {}) {
  const resolvedRoot = path.resolve(String(root || process.cwd()));
  const id = folder && typeof folder.id === 'string' && folder.id.trim() ? folder.id.trim() : 'folder';
  const box = folder && folder.box && typeof folder.box === 'object' ? folder.box : null;
  if (!box || typeof box.path !== 'string' || !box.path.trim()) {
    return failure(id, 'box-missing', 'у папки «' + id + '» не объявлен box.path — где лежит ящик обмена');
  }
  const relative = box.path.trim();
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) {
    return failure(id, 'box-path-invalid',
      'у папки «' + id + '» box.path должен быть относительным и без «..»: ' + relative);
  }
  const mode = typeof box.root === 'string' && box.root.trim() ? box.root.trim() : 'shared';
  if (mode !== 'shared' && mode !== 'workspace') {
    return failure(id, 'box-root-invalid',
      'у папки «' + id + '» box.root должен быть "shared" или "workspace": ' + mode);
  }
  if (mode === 'workspace') {
    return { folderId: id, path: path.resolve(resolvedRoot, relative), status: 'ok', code: 'ok' };
  }

  const ownPaths = folderPathsOf(folder);
  const registryContext = registryOf(folders, resolvedRoot);
  const registry = registryContext.registry;
  for (const [label, value] of ownPaths) {
    if (!registry.has(label)) registry.set(label, value);
  }
  const explicitRoots = uniquePaths(roots);
  const participants = Array.isArray(folder.participants) ? folder.participants : [];
  const participantPaths = [];
  for (const participant of participants) {
    if (typeof participant !== 'string' || !participant.trim()) continue;
    const label = participant.trim();
    const hit = ownPaths.get(label) || registry.get(label);
    const absolute = hit || (path.isAbsolute(label) ? path.resolve(label) : '');
    if (absolute) {
      if (!participantPaths.some((item) => pathKey(item) === pathKey(absolute))) participantPaths.push(absolute);
    }
  }

  /*
   * 1. Пути участников известны (folder.paths или реестр): общий предок — из них.
   *    Именно это спасает от воркспейса со своим coordination: его каталог в
   *    списке участников не участвует.
   */
  if (participantPaths.length >= 2) {
    const base = commonParent(participantPaths);
    const invalid = validateBase(base, participantPaths, resolvedRoot, id, relative);
    if (invalid) return invalid;
    return { folderId: id, path: path.resolve(base, relative), status: 'ok', code: 'ok' };
  }

  /*
   * 2. Вызывающий назвал корни участников (панель, сторож, CLI): shared требует
   *    минимум двух — иначе общий ящик окажется внутри одного воркспейса.
   */
  if (explicitRoots.length >= 2) {
    const base = commonParent(explicitRoots);
    const invalid = validateBase(base, explicitRoots, resolvedRoot, id, relative);
    if (invalid) return invalid;
    return { folderId: id, path: path.resolve(base, relative), status: 'ok', code: 'ok' };
  }
  if (explicitRoots.length === 1) {
    return failure(id, 'shared-ambiguous',
      'у папки «' + id + '» box.root: shared требует минимум двух участников в roots, найден 1: '
        + 'иначе общий ящик окажется внутри одного воркспейса',
      { candidates: [path.resolve(explicitRoots[0], relative), path.resolve(resolvedRoot, relative)] });
  }

  /*
   * 3. Путей у папки нет, но структура знает несколько воркспейсов: общий
   *    предок — из них (это же правило читает панель при объявлении папки).
   */
  const knownWorkspaces = uniquePaths([resolvedRoot, ...registryContext.workspaces]);
  if (knownWorkspaces.length >= 2) {
    const base = commonParent(knownWorkspaces);
    const invalid = validateBase(base, knownWorkspaces, resolvedRoot, id, relative);
    if (invalid) return invalid;
    return { folderId: id, path: path.resolve(base, relative), status: 'ok', code: 'ok' };
  }

  /*
   * 4. Старое объявление без путей и с одним известным воркспейсом (так
   *    объявлен ящик в проверках одного воркспейса). Каталоги-кандидаты ищутся
   *    у предков; выбор делается только тогда, когда он не спорит с другой
   *    папкой. Кандидат, уже объявленный другой папкой (тот самый workspace-
   *    coordination рядом с shared), — это неоднозначность, а не «ближайший».
   *    Несколько НЕзанятых кандидатов — законный старый расклад: ящик у
   *    ближайшего предка, как его и читали до задания 0078.
   */
  const candidates = ancestorCandidates(resolvedRoot, relative);
  if (candidates.length === 0) {
    const fallback = [path.resolve(resolvedRoot, relative), path.resolve(path.dirname(resolvedRoot), relative)];
    return failure(id, 'shared-missing',
      'у папки «' + id + '» box.root: shared не найден: нет общего каталога участников и нет каталога-кандидата',
      { candidates: fallback });
  }
  const declaredElsewhere = candidates.filter((candidate) => claimed.some((item) => pathKey(item) === pathKey(candidate)));
  if (declaredElsewhere.length > 0) {
    return failure(id, 'shared-ambiguous',
      'у папки «' + id + '» box.root: shared неоднозначен: каталог ' + declaredElsewhere[0]
        + ' уже объявлен другой папкой, а рядом есть ещё кандидаты: ' + candidates.join(', ')
        + ' — укажите folder.paths участников',
      { candidates });
  }
  return { folderId: id, path: candidates[0], status: 'ok', code: 'ok' };
}

/** Нормализовать папку из структуры: только поля резолвера. */
function normalizeFolder(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const box = raw.box && typeof raw.box === 'object' && !Array.isArray(raw.box)
    ? {
      path: typeof raw.box.path === 'string' ? raw.box.path : '',
      root: typeof raw.box.root === 'string' ? raw.box.root : 'shared',
    }
    : null;
  const participants = Array.isArray(raw.participants)
    ? raw.participants.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const paths = {};
  if (raw.paths && typeof raw.paths === 'object' && !Array.isArray(raw.paths)) {
    for (const [label, value] of Object.entries(raw.paths)) {
      if (typeof label === 'string' && label.trim() && typeof value === 'string' && value.trim()) {
        paths[label.trim()] = value.trim();
      }
    }
  }
  return { ...raw, id, box, participants, paths };
}

/** Прочитать папки структуры, если вызывающий их ещё не прочитал. */
function readFolders(root) {
  const read = readStructure(root, 'structure');
  if (!read.exists) return { folders: [], problems: [{ code: 'no-structure', message: 'в проекте нет папки structure/: папки обмена не объявлены' }] };
  const folders = [];
  const problems = [];
  for (const file of read.files) {
    let document;
    try {
      document = JSON.parse(file.text);
    } catch (error) {
      problems.push({ code: 'invalid-structure', file: file.name, message: 'файл структуры не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка') });
      continue;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      problems.push({ code: 'invalid-structure', file: file.name, message: 'файл структуры — не JSON-объект' });
      continue;
    }
    if (!Array.isArray(document.folders)) continue;
    for (const raw of document.folders) {
      const folder = normalizeFolder(raw);
      if (folder) folders.push(folder);
    }
  }
  return { folders, problems };
}

/**
 * Разрешить ВСЕ папки структуры и назвать проблемы.
 *
 * @returns { boxes: [...], problems: [{ code, folderId?, folderIds?, message, candidates? }] }.
 *   Порядок boxes — порядок объявления. Дубль каталога оставляет первую папку
 *   рабочей, у остальных status:'error' code:'duplicate-box': письма не считаются
 *   дважды, а обе папки названы.
 */
export function resolveBoxes({ root, roots, folders } = {}) {
  const resolvedRoot = path.resolve(String(root || process.cwd()));
  const source = Array.isArray(folders) ? folders.map(normalizeFolder).filter(Boolean) : readFolders(resolvedRoot).folders;
  const all = source;
  const boxes = [];
  const problems = [];
  /*
   * Сначала — ящики workspace: они и есть «свои каталоги», с которыми не должен
   * спорить shared. Иначе shared без paths молча занял бы каталог соседней
   * workspace-папки (жалоба ws-school-app, П1).
   */
  const workspaceBoxes = new Map();
  for (const folder of all) {
    const mode = folder && folder.box && folder.box.root === 'workspace' ? 'workspace' : 'shared';
    if (mode !== 'workspace') continue;
    workspaceBoxes.set(folder.id, resolveBox({ root: resolvedRoot, folder }));
  }
  const claimed = [...workspaceBoxes.values()].filter((row) => row.status === 'ok' && row.path).map((row) => row.path);
  for (const folder of all) {
    const result = workspaceBoxes.get(folder.id) || resolveBox({ root: resolvedRoot, folder, roots, folders: all, claimed });
    boxes.push(result);
    if (result.status !== 'ok') {
      problems.push({
        code: result.code || 'box-error',
        folderId: result.folderId,
        message: result.message,
        ...(Array.isArray(result.candidates) ? { candidates: result.candidates } : {}),
      });
    }
  }
  /* Один каталог у двух папок — ошибка с обоими id, а не двойной счёт писем. */
  const groups = new Map();
  for (const box of boxes) {
    if (box.status !== 'ok' || !box.path) continue;
    const key = pathKey(box.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(box);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    for (const duplicate of rest) {
      duplicate.status = 'error';
      duplicate.code = 'duplicate-box';
      duplicate.message = 'каталог обмена «' + duplicate.path + '» объявлен двумя папками: '
        + [first.folderId, duplicate.folderId].join(', ') + ' — у каждой папки должен быть свой ящик';
      duplicate.candidates = [duplicate.path];
    }
    problems.push({
      code: 'duplicate-box',
      folderId: rest[0].folderId,
      folderIds: [first.folderId, rest[0].folderId],
      message: 'каталог обмена «' + first.path + '» объявлен двумя папками: '
        + [first.folderId, rest[0].folderId].join(', ') + ' — письма считались бы дважды',
      path: first.path,
      candidates: [first.path],
    });
  }
  return { boxes, problems };
}
