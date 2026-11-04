#!/usr/bin/env node
/**
 * Задание 0067 — миграция structure/graph.json с модельных алиасов на прямые маршруты.
 *
 * Старый файл объявлял маршрут алиасом: node.model = "work", а в models{} лежало
 * work -> { provider, model }. Новый контракт (0050/0061) хранит маршрут в узле:
 * provider + model (+ family, если он был в карте). Мигратор делает это с файлом,
 * а не с поведением читателя:
 *
 *   node tools/migrate-models.mjs --dry-run   показать изменения, файл не трогать
 *   node tools/migrate-models.mjs --write     бэкап и перезапись файла
 *
 * Инварианты:
 *   1. у каждого узла с model = алиас появляются прямые provider/model (family из
 *      карты, если у узла своего family нет), modelAlias не пишется;
 *   2. ключ models{} удаляется целиком;
 *   3. всё остальное сохраняется: version, порядок и состав узлов, role/brief/
 *      prompt/x/y/schedule, folders, edges;
 *   4. запись — JSON.stringify(doc, null, 2) + "\n", как формат файла;
 *   5. --write сначала пишет бэкап structure/graph.json.bak-models-YYYY-MM-DD
 *      (существующий бэкап за сегодня не перезаписывается), потом файл;
 *   6. повторный прогон идемпотентен: «изменений нет», файл байт-в-байт тот же;
 *   7. алиас без записи в models{} — отказ (exit 1) с причиной, файл не пишется;
 *   8. неизвестный провайдер/модель не выдумывается: в узел пишется ровно то,
 *      что лежит в карте.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const RELATIVE = 'structure/graph.json';
const FILE = path.join(ROOT, 'structure', 'graph.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const write = args.includes('--write');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  const error = new Error(message);
  error.userFacing = true;
  throw error;
}

/** Local calendar date of the machine (the same day the step runs). */
function localDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/** Copy a node keeping its key order; the route replaces the old model key. */
function migratedNode(node, route, family) {
  const next = {};
  let placed = false;
  const place = () => {
    next.provider = route.provider;
    next.model = route.model;
    if (family) next.family = family;
    placed = true;
  };
  for (const key of Object.keys(node)) {
    if (key === 'model') {
      if (!placed) place();
      continue;
    }
    if (key === 'provider' || key === 'family' || key === 'modelAlias') continue;
    next[key] = node[key];
  }
  if (!placed) place();
  return next;
}

/** Clone a node without the legacy modelAlias field, preserving key order. */
function withoutModelAlias(node) {
  const next = {};
  for (const key of Object.keys(node)) {
    if (key === 'modelAlias') continue;
    next[key] = node[key];
  }
  return next;
}

/**
 * Compute the migrated document and the list of changes. Nothing is written here:
 * a refusal leaves the file untouched.
 */
function plan(document) {
  if (!isPlainObject(document)) fail(RELATIVE + ' должен быть JSON-объектом');

  const hasModelsKey = Object.hasOwn(document, 'models');
  let models = {};
  if (hasModelsKey) {
    if (!isPlainObject(document.models)) fail('models должен быть объектом «алиас -> маршрут»');
    models = document.models;
    for (const [alias, entry] of Object.entries(models)) {
      if (!isPlainObject(entry)) fail('у модели «' + alias + '» маршрут должен быть объектом');
      if (!text(entry.provider) || !text(entry.model)) {
        fail('у модели «' + alias + '» нужны непустые provider и model');
      }
    }
  }

  if (!Array.isArray(document.nodes)) fail('nodes в ' + RELATIVE + ' должен быть массивом');

  const changes = [];
  const nodes = document.nodes.map((node) => {
    if (!isPlainObject(node)) fail('узел в ' + RELATIVE + ' должен быть объектом');
    const id = text(node.id) || '(без id)';
    const declaredModel = text(node.model);
    const declaredProvider = text(node.provider);

    if (declaredProvider) {
      /* Прямой маршрут уже записан. Остаётся снять legacy-поле modelAlias. */
      if (node.modelAlias !== undefined) {
        changes.push({ id, from: null, to: null, note: 'убран modelAlias' });
        return withoutModelAlias(node);
      }
      return node;
    }

    if (!declaredModel) {
      /* Узел без модели (например, обмен) — мигратор его не трогает. */
      return node;
    }

    if (!Object.hasOwn(models, declaredModel)) {
      fail('у узла «' + id + '» model «' + declaredModel + '» задан без provider, и алиаса «'
        + declaredModel + '» нет в models: укажите provider и model прямо в узле');
    }
    const entry = models[declaredModel];
    const route = { provider: text(entry.provider), model: text(entry.model) };
    /* Приоритет у своего family узла: прямой маршрут не перетирается картой. */
    const family = text(node.family) || text(entry.family);
    changes.push({
      id,
      from: declaredModel,
      to: route.provider + '/' + route.model,
      family: family || null,
    });
    return migratedNode(node, route, family);
  });

  /* Порядок ключей файла сохраняется: models выпадает, nodes остаётся на месте. */
  const next = {};
  for (const key of Object.keys(document)) {
    if (key === 'models') continue;
    next[key] = key === 'nodes' ? nodes : document[key];
  }
  if (!Object.hasOwn(document, 'nodes')) next.nodes = nodes;
  if (hasModelsKey) changes.push({ id: null, from: null, to: null, note: 'ключ models{} удалён (' + Object.keys(models).length + ' алиас(ов))' });

  const changed = changes.length > 0 || hasModelsKey;
  return { document: next, changes, changed, hasModelsKey };
}

function printChanges(changes) {
  for (const change of changes) {
    if (change.note) {
      console.log('  ' + change.note);
      continue;
    }
    const family = change.family ? ' (family: ' + change.family + ')' : '';
    console.log('  ' + change.id + ': ' + change.from + ' -> ' + change.to + family);
  }
}

function main() {
  if (dryRun === write) {
    console.error('usage: node tools/migrate-models.mjs --dry-run|--write');
    return 2;
  }

  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (error) {
    console.error('migrate-models: отказ: не читается ' + RELATIVE + ': ' + (error && error.message ? error.message : 'ошибка'));
    return 1;
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    console.error('migrate-models: отказ: ' + RELATIVE + ' не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'));
    return 1;
  }

  let result;
  try {
    result = plan(document);
  } catch (error) {
    console.error('migrate-models: отказ: ' + (error && error.message ? error.message : 'ошибка'));
    console.error('файл не изменён: ' + RELATIVE);
    return 1;
  }

  if (!result.changed) {
    console.log('migrate-models: изменений нет');
    return 0;
  }

  console.log('migrate-models: изменения есть');
  printChanges(result.changes);

  if (dryRun) {
    console.log('файл не изменён: --dry-run');
    return 0;
  }

  const output = JSON.stringify(result.document, null, 2) + '\n';
  const backup = FILE + '.bak-models-' + localDate(new Date());
  const backupRelative = path.relative(ROOT, backup).split(path.sep).join('/');
  if (fs.existsSync(backup)) {
    console.log('бэкап уже есть: ' + backupRelative);
  } else {
    fs.copyFileSync(FILE, backup);
    console.log('бэкап: ' + backupRelative);
  }
  fs.writeFileSync(FILE, output, 'utf8');
  console.log('записано: ' + RELATIVE);
  return 0;
}

process.exitCode = main();
