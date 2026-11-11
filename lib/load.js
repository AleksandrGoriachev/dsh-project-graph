/**
 * Reading a project's structure folder.
 *
 * The folder holds every fragment of the structure: structure/*.json. Files are
 * read in path order, so the merged graph does not depend on the filesystem's
 * directory order. Nothing is written and nothing outside the folder is read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildGraph } from './graph.js';
import { resolveStructure } from './store.js';

/** Upper bounds: a structure is a small declaration, not a data set. */
export const MAX_FILES = 64;
export const MAX_FILE_BYTES = 256 * 1024;

/*
 * 0174/0176: служебные файлы каталога — не фрагменты структуры НИ В ОДНОМ режиме.
 *
 * Стор хранит не только объявление: рядом с graph.json лежат health.json
 * (доказательство включённой структуры), digest.json (состояние дайджеста) и
 * exchange-seen.json (память вручений). Читать их как фрагменты нельзя: у
 * health.json нет nodes, поэтому e-trace получал nodes:0 и error empty-graph
 * вместо warning нового проекта. 0174 фильтровал их только в store-режиме, и
 * проект, у которого в structure/ лежат одни служебные файлы, снова падал.
 * 0176 закрывает класс: это файлы плагина, а не структуры, поэтому фильтр
 * действует и в workspace-режиме. Если, кроме них, ничего нет — проект новый.
 *
 * Сравнение — по basename без учёта регистра, поэтому имя не зависит от подпапки.
 */
const SERVICE_FILES = ['health.json', 'digest.json', 'exchange-seen.json', 'approval.json'];

function isServiceFile(rel) {
  return SERVICE_FILES.includes(path.basename(rel).toLowerCase());
}

function walk(dir, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    out.problems.push({ file: base || '.', message: 'папка не читается: ' + (error && error.message ? error.message : 'ошибка') });
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      walk(full, rel, out);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.json')) continue;
    out.paths.push({ full, rel });
  }
}

/**
 * Собранный граф рядом с фрагментами (0192).
 *
 * Читатели структуры спрашивают не только «какие файлы», но и «что из них
 * следует»: привязка якорей (anchors.consumes), панель и проверки смотрят на
 * узлы, а не на текст. Граф собирается тем же buildGraph, что и у панели, —
 * второй трактовки у структуры не появляется. Ошибки сборки остаются у сборщика
 * (readGraphStructure), здесь только данные: readStructure по-прежнему не
 * бросает и не превращает находки в проблемы чтения.
 */
function withGraph(result, structureDir) {
  let built;
  try {
    built = buildGraph(result.files, { dirName: structureDir, missingDir: result.exists !== true });
  } catch {
    built = { graph: { version: 1, models: {}, nodes: [], folders: [], edges: [] } };
  }
  result.graph = built.graph;
  result.edges = built.graph.edges;
  return result;
}

/**
 * Read every JSON fragment of one project's structure.
 *
 * The folder comes from the store resolver: a legacy project keeps its files in
 * `<root>/<structureDir>`, a fresh one in the external store. Fragment names
 * stay logical (`<structureDir>/<rel>`) in both modes, so the merged graph and
 * the panel do not depend on where the files actually lie.
 *
 * @param root - absolute project root.
 * @param dirName - logical folder of the project (default "structure").
 * @returns The real folder, whether it exists, the readable fragments, and every
 *   problem met while reading (a missing fragment is a problem, not a crash).
 */
export function readStructure(root, dirName = 'structure') {
  const target = resolveStructure(root, dirName);
  const structureDir = target.structureDir;
  const dir = target.dir;
  const problems = [];
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    return withGraph(
      { dir, dirName: structureDir, mode: target.mode, exists: false, files: [], problems, count: 0 },
      structureDir,
    );
  }
  if (!stat.isDirectory()) {
    problems.push({ file: structureDir, message: 'это файл, а не папка со структурой' });
    return withGraph(
      { dir, dirName: structureDir, mode: target.mode, exists: true, files: [], problems, count: 0 },
      structureDir,
    );
  }
  const found = { paths: [], problems: [] };
  walk(dir, '', found);
  problems.push(...found.problems);
  /*
   * 0176: служебные файлы отбрасываются в любом режиме — до счёта и до лимита
   * MAX_FILES, иначе health.json считался бы фрагментом, а count врал бы о
   * структуре. Пустой после фильтра список — это новый проект: дальше buildGraph
   * даст warning empty-graph и неявного координатора, а не ошибку.
   */
  const paths = found.paths
    .filter((item) => !isServiceFile(item.rel))
    .sort((left, right) => left.rel.localeCompare(right.rel));
  const files = [];
  for (const item of paths.slice(0, MAX_FILES)) {
    let size = 0;
    try {
      size = fs.statSync(item.full).size;
    } catch {
      /* the read below reports the real failure */
    }
    if (size > MAX_FILE_BYTES) {
      problems.push({ file: item.rel, message: 'файл больше ' + Math.round(MAX_FILE_BYTES / 1024) + ' КБ — пропущен' });
      continue;
    }
    try {
      files.push({ name: structureDir + '/' + item.rel, text: fs.readFileSync(item.full, 'utf8') });
    } catch (error) {
      problems.push({ file: item.rel, message: 'файл не читается: ' + (error && error.message ? error.message : 'ошибка') });
    }
  }
  if (paths.length > MAX_FILES) {
    problems.push({ file: structureDir, message: 'файлов больше ' + MAX_FILES + ' — прочитаны первые ' + MAX_FILES });
  }
  return withGraph(
    { dir, dirName: structureDir, mode: target.mode, exists: true, files, problems, count: paths.length },
    structureDir,
  );
}
