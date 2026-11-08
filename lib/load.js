/**
 * Reading a project's structure folder.
 *
 * The folder holds every fragment of the structure: structure/*.json. Files are
 * read in path order, so the merged graph does not depend on the filesystem's
 * directory order. Nothing is written and nothing outside the folder is read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveStructure } from './store.js';

/** Upper bounds: a structure is a small declaration, not a data set. */
export const MAX_FILES = 64;
export const MAX_FILE_BYTES = 256 * 1024;

/*
 * 0174: служебные файлы каталога стора — не фрагменты структуры.
 *
 * Стор хранит не только объявление: рядом с graph.json лежат health.json
 * (доказательство включённой структуры), digest.json (состояние дайджеста) и
 * exchange-seen.json (память вручений). Читать их как фрагменты нельзя: у
 * health.json нет nodes, поэтому e-trace получал nodes:0 и error empty-graph
 * вместо warning нового проекта (0173).
 *
 * Сравнение — по basename без учёта регистра, поэтому имя не зависит от
 * подпапки стора. Фильтр включён только в store-режиме: в repo-режиме
 * (workspace) это имена файлов самого проекта, и они остаются фрагментами.
 */
const STORE_SERVICE_FILES = ['health.json', 'digest.json', 'exchange-seen.json'];

function isStoreServiceFile(rel) {
  return STORE_SERVICE_FILES.includes(path.basename(rel).toLowerCase());
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
    return { dir, dirName: structureDir, mode: target.mode, exists: false, files: [], problems, count: 0 };
  }
  if (!stat.isDirectory()) {
    problems.push({ file: structureDir, message: 'это файл, а не папка со структурой' });
    return { dir, dirName: structureDir, mode: target.mode, exists: true, files: [], problems, count: 0 };
  }
  const found = { paths: [], problems: [] };
  walk(dir, '', found);
  problems.push(...found.problems);
  /*
   * 0174: служебные файлы стора отбрасываются до счёта и до лимита MAX_FILES —
   * иначе health.json считался бы фрагментом, а count врал бы о структуре.
   * Пустой после фильтра список — это новый проект: дальше buildGraph даст
   * warning empty-graph (0173), а не ошибку.
   */
  const paths = found.paths
    .filter((item) => target.mode !== 'store' || !isStoreServiceFile(item.rel))
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
  return { dir, dirName: structureDir, mode: target.mode, exists: true, files, problems, count: paths.length };
}
