#!/usr/bin/env node
/**
 * Перенос структуры проекта из репозитория в store (задание 0345).
 *
 * Структура воркспейса — данные, а не код плагина: канонично она лежит в store
 * проекта, а в репозитории её быть не должно. Инструмент закрывает переезд для
 * проектов, которые ещё держат structure/graph.json:
 *
 *   --repo <путь>       корень проекта (по умолчанию .)
 *   --structure <имя>   логическое имя папки структуры (по умолчанию structure)
 *   --apply             после успешной сверки удалить файлы из репозитория git rm
 *   --check             только отчёт: режим repo|store и наличие store-графа
 *
 * Порядок безопасен: разбор источника → проверка координатора и buildGraph →
 * preflight git → резервные копии → запись в store → проверка readStructure+
 * buildGraph в режиме store → только потом git rm.
 *
 * Резервные копии лежат в <store>/backups/ и не оканчиваются на .json:
 * lib/load.js рекурсивно читает любой *.json под store как фрагмент структуры,
 * поэтому копия с именем graph.backup-<ISO>.json сделала бы граф недействительным
 * («coordinator объявлен дважды»). Формат — graph.backup-<ISO>.json.bak.
 *
 * Коды выхода: 0 — успех, 1 — отказ/расхождение, 2 — ошибка аргументов или
 * нечитаемый файл.
 *
 *   node tools/migrate-structure.mjs --repo . --check
 *   node tools/migrate-structure.mjs --repo .            # план, ничего не пишет
 *   node tools/migrate-structure.mjs --repo . --apply    # перенос и очистка
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nodeKindOf } from '../lib/node-spec.js';
import { buildGraph } from '../lib/graph.js';
import { readStructure } from '../lib/load.js';
import {
  STORE_ENV, normalizeStructureDir, resolveStructure, storeDir, storeName,
} from '../lib/store.js';

/** Подпапка store для резервных копий: не фрагмент структуры. */
const BACKUP_DIR = 'backups';

const USAGE = [
  'Использование:',
  '  node tools/migrate-structure.mjs --repo <путь> [--structure <имя>] [--apply|--check]',
  '',
  '  --repo       корень проекта (по умолчанию .)',
  '  --structure  логическое имя папки структуры (по умолчанию structure)',
  '  --apply      перенести граф в store и удалить его из репозитория через git rm',
  '  --check      только отчёт о режиме repo|store и наличии store-графа',
  '  --help       эта справка',
  '',
  'Без --apply инструмент печатает план и ничего не меняет.',
  'Коды: 0 — успех, 1 — отказ или расхождение, 2 — ошибка аргументов или нечитаемый файл.',
].join('\n');

/** Ошибка с кодом выхода: 1 — отказ, 2 — аргументы/чтение. */
function refusal(exitCode, message) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

/** Короткое сообщение об ошибке файловой системы. */
function reason(error) {
  return error && error.message ? error.message : 'ошибка';
}

/** Разбор аргументов: режимы --apply и --check взаимоисключающие. */
function parseArgs(argv) {
  const options = {
    repo: '.', structure: 'structure', apply: false, check: false, help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo' || arg === '--structure') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw refusal(2, arg + ' требует значение');
      }
      if (arg === '--repo') options.repo = value;
      else options.structure = value;
      index += 1;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw refusal(2, 'неизвестный аргумент: ' + arg);
  }
  if (options.apply && options.check) {
    throw refusal(2, '--check и --apply взаимоисключающие: отчёт и перенос — разные режимы');
  }
  return options;
}

/** Ссылки узла на якоря: элементы массивов и строковые id вида A1. */
function anchorReferences(node) {
  const anchors = node && typeof node === 'object' ? node.anchors : null;
  if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors)) return 0;
  let total = 0;
  for (const value of Object.values(anchors)) {
    if (Array.isArray(value)) total += value.length;
    else if (typeof value === 'string' && /^A\d+$/u.test(value)) total += 1;
  }
  return total;
}

/** Счётчики графа для отчёта и сверки. */
function graphCounts(document) {
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  const edges = Array.isArray(document.edges) ? document.edges : [];
  const folders = Array.isArray(document.folders) ? document.folders : [];
  let anchors = 0;
  let anchoredNodes = 0;
  for (const node of nodes) {
    const references = anchorReferences(node);
    anchors += references;
    if (references > 0) anchoredNodes += 1;
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    folders: folders.length,
    anchors,
    anchorNodes: anchoredNodes,
  };
}

/** Нормализованный JSON: ключи объектов отсортированы, массивы сохраняют порядок. */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = normalize(value[key]);
    return sorted;
  }
  return value;
}

/** Строка нормализованного JSON — «побайтово по смыслу». */
function canonical(value) {
  return JSON.stringify(normalize(value));
}

/** Прочитать JSON; нет файла или ошибка чтения — код 2, битый JSON — отказ 1. */
function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw refusal(2, 'не читается ' + label + ': ' + file + ' — ' + reason(error));
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw refusal(1, label + ' не разбирается как JSON: ' + file + ' — ' + reason(error));
  }
  return { text, document };
}

/** Граф обязан быть объектом с массивом nodes и узлом координатора. */
function validateGraph(document, file) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw refusal(1, 'граф не является JSON-объектом: ' + file);
  }
  if (!Array.isArray(document.nodes)) {
    throw refusal(1, 'в графе нет массива nodes: ' + file);
  }
  const coordinator = document.nodes.find((node) => node && typeof node === 'object'
    && nodeKindOf(node) === 'coordinator');
  if (!coordinator) {
    throw refusal(1, 'в графе нет узла координатора (id coordinator или роль «координатор»): ' + file);
  }
  return coordinator;
}

/** Короткий список ошибок buildGraph для причины отказа. */
function errorSummary(built) {
  const errors = Array.isArray(built && built.errors) ? built.errors : [];
  return errors.slice(0, 5).map((error) => {
    const code = error && error.code ? String(error.code) : 'error';
    const message = error && error.message ? String(error.message) : '';
    return code + (message ? ': ' + message : '');
  }).join(' | ') + (errors.length > 5 ? ' | …' : '');
}

/** Отчёт --check: режим и наличие store-графа; ничего не пишет. */
function checkStructure(repoRoot, structureDir) {
  const resolved = resolveStructure(repoRoot, structureDir);
  const directory = storeDir(repoRoot);
  const storedGraph = path.join(directory, 'graph.json');
  console.log('Проверка структуры');
  console.log('  проект: ' + repoRoot);
  console.log('  папка структуры: ' + structureDir);
  console.log('  режим: ' + resolved.mode);
  console.log('  store: ' + directory + ' (' + storeName(repoRoot) + ')');
  console.log('  store-граф: ' + (fs.existsSync(storedGraph)
    ? 'есть (' + storedGraph + ')'
    : 'нет (' + storedGraph + ')'));
  console.log('  файл графа по резолверу: ' + resolved.graphFile);
  return 0;
}

/** Уникальный путь резервной копии: всегда <store>/backups/*.json.bak. */
function backupFile(directory, stem, stamp) {
  let candidate = path.join(directory, stem + '-' + stamp + '.json.bak');
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, stem + '-' + stamp + '-' + suffix + '.json.bak');
    suffix += 1;
  }
  return candidate;
}

/** Относительный путь от корня проекта с прямыми слэшами — для git. */
function repositoryPath(repoRoot, file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/**
 * Проверить, что проект — git-репозиторий и источники отслеживаются.
 * Только для --apply: иначе git rm упадёт уже после записи в store и оставит
 * половинчатое состояние.
 */
function gitPreflight(repoRoot, files) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  });
  if (inside.error) throw refusal(1, 'git не запущен: ' + reason(inside.error));
  if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    throw refusal(1, 'проект не git-репозиторий: --apply удаляет источник через git rm; '
      + 'store не тронут, файл в репозитории не изменён');
  }
  const relative = files.map((file) => repositoryPath(repoRoot, file));
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', ...relative], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  });
  if (tracked.status !== 0) {
    throw refusal(1, 'файлы структуры не отслеживаются git: ' + relative.join(', ')
      + '; --apply не может удалить их через git rm, store не тронут');
  }
  return relative;
}

/** Удалить перенесённые файлы из индекса и рабочего дерева одним git rm. */
function gitRemove(repoRoot, files) {
  const relative = files.map((file) => repositoryPath(repoRoot, file));
  const result = spawnSync('git', ['rm', '-f', '--', ...relative], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    throw refusal(1, 'git rm не запущен: ' + reason(result.error));
  }
  if (result.status !== 0) {
    const output = String((result.stderr || '') + (result.stdout || '')).trim();
    throw refusal(1, 'git rm не выполнен (' + relative.join(', ') + '): ' + (output || 'код ' + result.status));
  }
  return relative;
}

/**
 * Прочитать store так, как его прочитает панель после удаления репозиторной
 * копии: временный корень без structure/ + подмена DSH_PROJECT_GRAPH_STORE.
 * Это ловит и лишние *.json (резервная копия в корне store), и битый граф.
 */
function readStoreView(structureDir, directory) {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-store-view-'));
  const previous = process.env[STORE_ENV];
  process.env[STORE_ENV] = directory;
  let read;
  try {
    read = readStructure(shadow, structureDir);
  } finally {
    if (previous === undefined) delete process.env[STORE_ENV];
    else process.env[STORE_ENV] = previous;
    try {
      fs.rmSync(shadow, { recursive: true, force: true });
    } catch {
      /* временный каталог: уборка не влияет на результат */
    }
  }
  const built = buildGraph(read.files, { dirName: structureDir });
  return { read, built };
}

/**
 * Проверить store-режим: режим store, канонические имена фрагментов, 0 ошибок
 * buildGraph и (если передан эталон) совпадение счётчиков с источником.
 */
function validateStoreView(structureDir, directory, sourceBuilt) {
  const view = readStoreView(structureDir, directory);
  if (view.read.mode !== 'store') {
    throw refusal(1, 'store-проверка: readStructure вернул режим ' + view.read.mode + ' вместо store');
  }
  if (path.resolve(view.read.dir) !== path.resolve(directory)) {
    throw refusal(1, 'store-проверка: readStructure читает ' + view.read.dir
      + ' вместо ' + directory);
  }
  if (view.read.problems.length > 0) {
    throw refusal(1, 'store-проверка: проблем чтения ' + view.read.problems.length
      + ': ' + view.read.problems.map((item) => item.file + ': ' + item.message).join(' | '));
  }
  const names = view.read.files.map((file) => file.name).sort((left, right) => left.localeCompare(right));
  if (!names.includes(structureDir + '/graph.json')) {
    throw refusal(1, 'store-проверка: в store нет канонического ' + structureDir + '/graph.json');
  }
  if (view.built.errors.length > 0) {
    throw refusal(1, 'store-проверка: buildGraph вернул ошибки (' + view.built.errors.length
      + '): ' + errorSummary(view.built));
  }
  const counts = graphCounts(view.built.graph);
  if (sourceBuilt) {
    const expected = graphCounts(sourceBuilt.graph);
    if (JSON.stringify(counts) !== JSON.stringify(expected)) {
      throw refusal(1, 'store-проверка: счётчики разошлись — store '
        + JSON.stringify(counts) + ', источник ' + JSON.stringify(expected));
    }
  }
  return { names, counts, errors: view.built.errors.length };
}

/** Свободный ISO-штамп, безопасный для имени файла на Windows. */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

/** Перенос: план или запись в store и очистка репозитория. */
function migrateStructure(repoRoot, structureDir, apply) {
  const resolved = resolveStructure(repoRoot, structureDir);
  const sourceGraph = path.join(repoRoot, structureDir, 'graph.json');
  const sourceLinks = path.join(repoRoot, structureDir, 'links.json');
  const directory = storeDir(repoRoot);
  const targetGraph = path.join(directory, 'graph.json');
  const targetLinks = path.join(directory, 'links.json');
  const backupsDir = path.join(directory, BACKUP_DIR);

  /*
   * R6: повторный --apply после успешного переноса — не ошибка. Источника в
   * репозитории уже нет, режим store, граф на месте: проверяем его и выходим 0.
   */
  if (!fs.existsSync(sourceGraph)) {
    if (resolved.mode === 'store' && fs.existsSync(resolved.graphFile)) {
      const checked = validateStoreView(structureDir, directory, null);
      console.log('Проект уже в store');
      console.log('  проект: ' + repoRoot);
      console.log('  store: ' + directory + ' (' + storeName(repoRoot) + ')');
      console.log('  граф: узлов ' + checked.counts.nodes + ', рёбер ' + checked.counts.edges
        + ', папок ' + checked.counts.folders + ', якорей ' + checked.counts.anchors);
      console.log('  переносить нечего: файла structure/graph.json в репозитории нет.');
      return 0;
    }
    throw refusal(1, 'нет файла структуры для переноса: ' + sourceGraph);
  }

  const graph = readJson(sourceGraph, 'граф');
  validateGraph(graph.document, sourceGraph);
  const links = fs.existsSync(sourceLinks) ? readJson(sourceLinks, 'связи links.json') : null;
  if (links && (!links.document || typeof links.document !== 'object' || Array.isArray(links.document))) {
    throw refusal(1, 'links.json не является JSON-объектом: ' + sourceLinks);
  }
  if (path.resolve(targetGraph) === path.resolve(sourceGraph)
    || path.resolve(directory) === path.resolve(path.join(repoRoot, structureDir))) {
    throw refusal(1, 'store совпадает с папкой структуры в репозитории: ' + directory);
  }

  const sourceFiles = [{ name: structureDir + '/graph.json', text: graph.text }];
  if (links) sourceFiles.push({ name: structureDir + '/links.json', text: links.text });
  const sourceBuilt = buildGraph(sourceFiles, { dirName: structureDir });
  if (sourceBuilt.errors.length > 0) {
    throw refusal(1, 'источник не проходит buildGraph (' + sourceBuilt.errors.length + ' ошибок): '
      + errorSummary(sourceBuilt));
  }
  const counts = graphCounts(sourceBuilt.graph);
  const sources = links ? [sourceGraph, sourceLinks] : [sourceGraph];

  console.log('Перенос структуры в store');
  console.log('  проект: ' + repoRoot);
  console.log('  источник: ' + sources.join(', '));
  console.log('  store: ' + directory + ' (' + storeName(repoRoot) + ')');
  console.log('  цель: ' + [targetGraph, ...(links ? [targetLinks] : [])].join(', '));
  console.log('  граф: узлов ' + counts.nodes + ', рёбер ' + counts.edges
    + ', папок ' + counts.folders + ', якорей ' + counts.anchors
    + ' (в ' + counts.anchorNodes + ' узлах)');
  if (!apply) {
    console.log('  резервная копия: ' + path.join(directory, BACKUP_DIR, 'graph.backup-<ISO>.json.bak'));
    console.log('  удаление из репозитория: git rm -- ' + sources.map((file) => repositoryPath(repoRoot, file)).join(' '));
    console.log('План: без --apply ни store, ни репозиторий не изменены.');
    return 0;
  }

  /* R5: git проверяется до первой записи, иначе проект без git оставит store изменённым. */
  gitPreflight(repoRoot, sources);

  const stamp = timestamp();
  let sourceBackup;
  try {
    fs.mkdirSync(backupsDir, { recursive: true });
    /*
     * R4: существующий store-граф не затирается молча. Копия в backups/
     * (не .json — иначе читатель принял бы её за фрагмент), затем явная сверка.
     */
    if (fs.existsSync(targetGraph)) {
      const previousText = fs.readFileSync(targetGraph, 'utf8');
      const previousFile = backupFile(backupsDir, 'graph.previous', stamp);
      fs.writeFileSync(previousFile, previousText, 'utf8');
      let verdict = 'не разбирается как JSON';
      try {
        const previous = JSON.parse(previousText);
        verdict = canonical(previous) === canonical(graph.document)
          ? 'совпадает с источником — перезапись подтверждена'
          : 'отличается от источника — перезапись по --apply, копия сохранена';
      } catch {
        /* вердикт уже «не разбирается» */
      }
      console.log('  существующий store-граф сохранён: ' + previousFile + ' (' + verdict + ')');
    }
    if (fs.existsSync(targetLinks)) {
      const previousLinksText = fs.readFileSync(targetLinks, 'utf8');
      const previousLinksFile = backupFile(backupsDir, 'links.previous', stamp);
      fs.writeFileSync(previousLinksFile, previousLinksText, 'utf8');
      if (links) {
        let verdict = 'не разбирается как JSON';
        try {
          verdict = canonical(JSON.parse(previousLinksText)) === canonical(links.document)
            ? 'совпадает с источником — перезапись подтверждена'
            : 'отличается от источника — перезапись по --apply, копия сохранена';
        } catch {
          /* вердикт уже «не разбирается» */
        }
        console.log('  существующий store-links сохранён: ' + previousLinksFile + ' (' + verdict + ')');
      } else {
        console.log('  существующий store-links сохранён: ' + previousLinksFile
          + ' (источник links.json не содержит — файл удаляется из store, структура приводится к источнику)');
      }
    }
    sourceBackup = backupFile(backupsDir, 'graph.backup', stamp);
    fs.writeFileSync(sourceBackup, graph.text, 'utf8');
    fs.writeFileSync(targetGraph, graph.text, 'utf8');
    if (links) fs.writeFileSync(targetLinks, links.text, 'utf8');
    else if (fs.existsSync(targetLinks)) fs.rmSync(targetLinks, { force: true });
  } catch (error) {
    if (error && Number.isInteger(error.exitCode)) throw error;
    throw refusal(1, 'запись в store не удалась: ' + directory + ' — ' + reason(error));
  }
  console.log('  резервная копия: ' + sourceBackup);
  console.log('  записано: ' + [targetGraph, ...(links ? [targetLinks] : [])].join(', '));

  /*
   * R1: до git rm проверяем не файл, а то, что прочитает панель в режиме store:
   * канонические фрагменты, ноль ошибок buildGraph, те же счётчики.
   */
  const checked = validateStoreView(structureDir, directory, sourceBuilt);
  console.log('  сверка store: readStructure — режим store, фрагментов ' + checked.names.length
    + ' (' + checked.names.join(', ') + '); buildGraph — 0 ошибок');
  console.log('  сверка: нормализованный JSON совпал (узлы/рёбра/папки/якоря)');

  const removed = gitRemove(repoRoot, sources);
  console.log('  удалено из репозитория: ' + removed.join(', '));

  const structurePath = path.join(repoRoot, structureDir);
  let remaining = [];
  try {
    remaining = fs.readdirSync(structurePath, { withFileTypes: true }).map((entry) => entry.name);
  } catch {
    remaining = [];
  }
  console.log('  осталось в репозитории: ' + (remaining.length
    ? structurePath + ' — ' + remaining.join(', ')
    : 'в ' + structurePath + ' файлов структуры нет'));
  console.log('Перенос выполнен: структура этого проекта читается из store.');
  return 0;
}

/** Точка входа: разбор, проверка каталога, выбранный режим. */
function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const repoRoot = path.resolve(options.repo);
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throw refusal(2, 'каталог проекта не найден: ' + repoRoot);
  }
  const structureDir = normalizeStructureDir(options.structure);
  if (options.check) return checkStructure(repoRoot, structureDir);
  return migrateStructure(repoRoot, structureDir, options.apply);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const code = error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
  const prefix = code === 2 ? 'ОШИБКА:' : 'ОТКАЗ:';
  console.error(prefix + ' ' + (error && error.message ? error.message : String(error)));
  process.exitCode = code;
}
