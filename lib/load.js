/**
 * Reading a project's structure folder.
 *
 * The folder holds every fragment of the structure: structure/*.json. Files are
 * read in path order, so the merged graph does not depend on the filesystem's
 * directory order. Nothing is written and nothing outside the folder is read.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Upper bounds: a structure is a small declaration, not a data set. */
export const MAX_FILES = 64;
export const MAX_FILE_BYTES = 256 * 1024;

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
 * @param root - absolute project root.
 * @param dirName - folder inside the project (default "structure").
 * @returns The folder, whether it exists, the readable fragments, and every
 *   problem met while reading (a missing fragment is a problem, not a crash).
 */
export function readStructure(root, dirName = 'structure') {
  const dir = path.join(root, dirName);
  const problems = [];
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    return { dir, dirName, exists: false, files: [], problems, count: 0 };
  }
  if (!stat.isDirectory()) {
    problems.push({ file: dirName, message: 'это файл, а не папка со структурой' });
    return { dir, dirName, exists: true, files: [], problems, count: 0 };
  }
  const found = { paths: [], problems: [] };
  walk(dir, '', found);
  problems.push(...found.problems);
  const paths = found.paths.sort((left, right) => left.rel.localeCompare(right.rel));
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
      files.push({ name: dirName + '/' + item.rel, text: fs.readFileSync(item.full, 'utf8') });
    } catch (error) {
      problems.push({ file: item.rel, message: 'файл не читается: ' + (error && error.message ? error.message : 'ошибка') });
    }
  }
  if (paths.length > MAX_FILES) {
    problems.push({ file: dirName, message: 'файлов больше ' + MAX_FILES + ' — прочитаны первые ' + MAX_FILES });
  }
  return { dir, dirName, exists: true, files, problems, count: paths.length };
}
