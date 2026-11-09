#!/usr/bin/env node
/**
 * 0181 — реестр ежедневных запусков: пересборка и проверка.
 *
 *   node tools/rebuild-daily-runs-map.mjs          пересобрать docs/daily-runs-map.json
 *   node tools/rebuild-daily-runs-map.mjs --check  сравнить файл с графами; exit 1 при расхождении
 *
 * Источник — графы связанных воркспейсов (docs/workspace-links.md §3):
 * dsh-project-graph (этот репозиторий) и default-workspace рядом. Список
 * фиксирован намеренно: реестр лежит в этом репозитории и обязан быть
 * воспроизводимым, а обход всех воркспейсов DSH сделал бы его зависимым от
 * чужого окружения. Ручная правка реестра запрещена — он производная.
 *
 * Файл детерминирован: ни времени сборки, ни абсолютных путей в нём нет,
 * поэтому --check сравнивает документ целиком, а не отдельные поля.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDailyRunsMap } from '../lib/daily-map.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUTPUT = path.join(REPO, 'docs', 'daily-runs-map.json');

/** Версия формата документа: /1 был ручным, /2 строится из графов. */
export const FORMAT = 'dsh-daily-runs/2';

/** Правило чтения карты: расписание — только у узла с at. */
export const RULE = 'Узел с at запускается по расписанию; узел без at — событийный: разрыв без запусков у него — пауза, а не пропуск окна. Запуск вне окна расписания — событие с причиной.';

/**
 * Воркспейсы, которые покрывает реестр: связанная пара из docs/workspace-links.md §3.
 * display — путь графа для человека относительно корня этого репозитория.
 */
export function workspaceSources(repoRoot = REPO) {
  return [
    {
      workspace: 'dsh-project-graph',
      root: repoRoot,
      source: 'structure/graph.json',
      display: 'structure/graph.json',
    },
    {
      workspace: 'default-workspace',
      root: path.resolve(repoRoot, '..', 'default-workspace'),
      source: 'structure/graph.json',
      display: '../default-workspace/structure/graph.json',
    },
  ];
}

/** Читает графы по описаниям источников: { workspace: graph }. */
export function loadGraphs(sources = workspaceSources()) {
  const graphs = {};
  for (const item of sources) {
    const file = path.join(item.root, item.source);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error('не читается граф ' + item.workspace + ': ' + file + ' (' + error.message + ')');
    }
    try {
      graphs[item.workspace] = JSON.parse(text);
    } catch (error) {
      throw new Error('битый JSON графа ' + item.workspace + ': ' + file + ' (' + error.message + ')');
    }
  }
  return graphs;
}

/** Документ реестра из уже загруженных графов (без чтения диска). */
export function buildDocument(graphs, sources = workspaceSources()) {
  return {
    format: FORMAT,
    rule: RULE,
    sources: Object.fromEntries(sources.map((item) => [item.workspace, item.display])),
    workspaces: buildDailyRunsMap(graphs),
  };
}

/** Читает документ реестра; битый JSON и отсутствие файла — исключение. */
export function readDocument(file = OUTPUT) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* Порядок ключей в JSON не смысл: сравниваем каноническую форму. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

/* Первое расхождение словами: ожидаемое значение и что лежит в файле. */
function difference(expected, actual, at = 'документ') {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return at + ': тип не совпадает';
    if (expected.length !== actual.length) {
      return at + ': элементов ' + actual.length + ', ожидалось ' + expected.length;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const found = difference(expected[index], actual[index], at + '[' + index + ']');
      if (found) return found;
    }
    return '';
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return at + ': тип не совпадает';
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      if (!(key in expected)) return at + '.' + key + ': лишнее поле';
      if (!(key in actual)) return at + '.' + key + ': поля нет';
      const found = difference(expected[key], actual[key], at + '.' + key);
      if (found) return found;
    }
    return '';
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    return at + ': в файле ' + JSON.stringify(actual) + ', ожидалось ' + JSON.stringify(expected);
  }
  return '';
}

/**
 * Сравнивает построенный документ с тем, что лежит в файле.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function compareDocument(expected, actual) {
  if (JSON.stringify(canonical(expected)) === JSON.stringify(canonical(actual))) return { ok: true };
  return { ok: false, reason: difference(expected, actual) || 'документы различаются' };
}

function summary(document) {
  const workspaces = Object.keys(document.workspaces);
  const nodes = workspaces.reduce((sum, workspace) => sum + document.workspaces[workspace].nodes.length, 0);
  return 'воркспейсов: ' + workspaces.length + ', узлов: ' + nodes;
}

/** Точка входа CLI: 0 — успех, 1 — расхождение, 2 — ошибка аргументов/чтения. */
export function main(argv = process.argv.slice(2)) {
  const check = argv.length === 1 && argv[0] === '--check';
  if (argv.length > 1 || (argv.length === 1 && !check)) {
    process.stderr.write('usage: node tools/rebuild-daily-runs-map.mjs [--check]' + String.fromCharCode(10));
    return 2;
  }
  let expected;
  try {
    const sources = workspaceSources();
    expected = buildDocument(loadGraphs(sources), sources);
  } catch (error) {
    process.stderr.write('FAIL daily-map: ' + error.message + String.fromCharCode(10));
    return 2;
  }
  const text = JSON.stringify(expected, null, 2) + String.fromCharCode(10);
  if (check) {
    let actual;
    try {
      actual = readDocument();
    } catch (error) {
      console.log('FAIL check: docs/daily-runs-map.json не читается: ' + error.message);
      return 1;
    }
    const result = compareDocument(expected, actual);
    if (!result.ok) {
      console.log('FAIL check: реестр расходится с графами — ' + result.reason);
      return 1;
    }
    console.log('OK check: реестр совпадает с графами (' + summary(expected) + ')');
    return 0;
  }
  let current = null;
  try {
    current = fs.readFileSync(OUTPUT, 'utf8');
  } catch {
    /* файла ещё нет — это не ошибка пересборки */
  }
  if (current === text) {
    console.log('OK rebuild: реестр без изменений (' + summary(expected) + ')');
    return 0;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, text, 'utf8');
  console.log('OK rebuild: docs/daily-runs-map.json пересобран (' + summary(expected) + ')');
  return 0;
}

const INVOKED = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (INVOKED === import.meta.url) process.exitCode = main();
