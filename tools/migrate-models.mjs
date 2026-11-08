#!/usr/bin/env node
/**
 * Задание 0067 + 0087 — structure/graph.json: алиасы → прямые маршруты и проверка
 * маршрута по живому каталогу службы llm.
 *
 * Старый файл объявлял маршрут алиасом: node.model = "work", а в models{} лежало
 * work -> { provider, model }. Новый контракт (0050/0061) хранит маршрут в узле:
 * provider + model (+ family, если он был в карте). Задание 0087 добавляет второй
 * проход по тому же плану: маршрут каждого узла сверяется с каталогом службы llm
 * (/project-graph/api/models), и провайдер заменяется, только если модель есть
 * ровно у одного провайдера каталога. Никаких похожих имён и дефолтов.
 *
 *   node tools/migrate-models.mjs --dry-run [--catalog <file>|--models-url <url>]
 *   node tools/migrate-models.mjs --write   [--catalog <file>|--models-url <url>]
 *   node tools/migrate-models.mjs --dry-run --require-catalog
 *
 * Каталог:
 *   --catalog <file>  снимок ответа /project-graph/api/models
 *                     ({ ok, providers: [{ id, models: [{ id, family? }] }] });
 *                     битый или отсутствующий файл — отказ (exit 1);
 *   --models-url <url> иначе $DSH_WEB_URL + '/project-graph/api/models' (fetch с
 *                     коротким таймаутом);
 *   недоступный каталог (сеть/служба/нет флага) — предупреждение в stderr и
 *                     миграция алиасов как в 0067 (exit 0); --require-catalog
 *                     превращает это в отказ.
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
 *   8. без каталога неизвестный провайдер/модель не выдумывается: в узел пишется
 *      ровно то, что лежит в карте;
 *   9. с каталогом: объявленный провайдер есть и модель у него есть — маршрут не
 *      меняется (даже если модель есть у других); иначе провайдер заменяется,
 *      только если модель есть ровно у одного провайдера; ноль или несколько —
 *      отказ (exit 1) без записи и без бэкапа;
 *  10. --dry-run ничего не пишет и бэкап не создаёт.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const RELATIVE = 'structure/graph.json';
const FILE = path.join(ROOT, 'structure', 'graph.json');
const CATALOG_PATH = '/project-graph/api/models';
const FETCH_TIMEOUT_MS = 3000;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const write = args.includes('--write');
const requireCatalog = args.includes('--require-catalog');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error) {
  return error && error.message ? error.message : 'ошибка';
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

/** Value of a flag that takes an argument; a flag without one is a refusal. */
function flagValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  const value = text(args[index + 1]);
  if (!value || value.startsWith('--')) fail('флаг ' + name + ' требует значения');
  return value;
}

/**
 * Validate the catalog shape { ok, providers: [{ id, models: [{ id }] }] }.
 * Returns providers as a Map id -> Set(model id), preserving catalog order.
 */
function normalizeCatalog(document, source) {
  if (!isPlainObject(document) || document.ok === false) {
    fail('каталог ' + source + ' не в форме ответа /project-graph/api/models');
  }
  if (!Array.isArray(document.providers)) {
    fail('каталог ' + source + ': нет массива providers');
  }
  const providers = new Map();
  for (const provider of document.providers) {
    if (!isPlainObject(provider)) fail('каталог ' + source + ': провайдер должен быть объектом');
    const id = text(provider.id);
    if (!id) fail('каталог ' + source + ': у провайдера нет id');
    if (providers.has(id)) fail('каталог ' + source + ': провайдер «' + id + '» объявлен дважды');
    if (!Array.isArray(provider.models)) fail('каталог ' + source + ': у провайдера «' + id + '» нет массива models');
    const models = new Set();
    for (const model of provider.models) {
      if (!isPlainObject(model) || !text(model.id)) {
        fail('каталог ' + source + ': у провайдера «' + id + '» модель без id');
      }
      models.add(text(model.id));
    }
    providers.set(id, models);
  }
  return { providers };
}

function readCatalogFile(file) {
  const absolute = path.resolve(ROOT, file);
  let raw;
  try {
    raw = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    fail('каталог «' + file + '» не читается: ' + messageOf(error));
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    fail('каталог «' + file + '» не разбирается как JSON: ' + messageOf(error));
  }
  return normalizeCatalog(document, 'файл «' + file + '»');
}

function catalogUrl() {
  const explicit = flagValue('--models-url');
  if (explicit) return explicit;
  const base = text(process.env.DSH_WEB_URL);
  if (!base) return '';
  return base.replace(/\/+$/u, '') + CATALOG_PATH;
}

async function fetchCatalog(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Acquire the catalog. An explicitly requested --catalog file is mandatory:
 * missing/broken means refusal. A live catalog that cannot be fetched only
 * warns, unless --require-catalog is set.
 */
async function loadCatalog() {
  const file = flagValue('--catalog');
  if (file) return { catalog: readCatalogFile(file), source: 'файл «' + file + '»' };

  const url = catalogUrl();
  if (!url) {
    const reason = 'ни --catalog, ни --models-url, ни $DSH_WEB_URL не заданы';
    if (requireCatalog) fail('каталог обязателен (--require-catalog): ' + reason);
    console.error('migrate-models: предупреждение: каталог службы llm недоступен (' + reason + '); проверка маршрутов пропущена');
    return { catalog: null, source: null };
  }

  let document;
  try {
    document = await fetchCatalog(url);
  } catch (error) {
    const reason = 'каталог ' + url + ' недоступен: ' + messageOf(error);
    if (requireCatalog) fail(reason);
    console.error('migrate-models: предупреждение: ' + reason + '; проверка маршрутов пропущена');
    return { catalog: null, source: null };
  }

  let catalog;
  try {
    catalog = normalizeCatalog(document, 'служба llm ' + url);
  } catch (error) {
    if (requireCatalog) throw error;
    console.error('migrate-models: предупреждение: ' + messageOf(error) + '; проверка маршрутов пропущена');
    return { catalog: null, source: null };
  }
  return { catalog, source: 'служба llm ' + url };
}

/** All catalog providers that declare exactly this model id, in catalog order. */
function catalogOwners(catalog, model) {
  const owners = [];
  for (const [id, models] of catalog.providers) {
    if (models.has(model)) owners.push(id);
  }
  return owners;
}

/** Replace provider in place, keeping the node key order. */
function replaceProvider(node, provider) {
  const next = {};
  for (const key of Object.keys(node)) {
    next[key] = key === 'provider' ? provider : node[key];
  }
  if (!Object.hasOwn(next, 'provider')) next.provider = provider;
  return next;
}

/**
 * Compare a node route with the catalog. The declared provider wins when the
 * catalog knows both it and the model; otherwise the only exact owner of the
 * model replaces it. Zero owners or several owners is a refusal — no guessing.
 */
function repairRoute(node, catalog) {
  const id = text(node.id) || '(без id)';
  const provider = text(node.provider);
  const model = text(node.model);
  if (!provider || !model) return { node, change: null };

  const declared = catalog.providers.get(provider);
  if (declared && declared.has(model)) return { node, change: null };

  const owners = catalogOwners(catalog, model);
  if (owners.length === 1) {
    return {
      node: replaceProvider(node, owners[0]),
      change: { id, from: provider + '/' + model, to: owners[0] + '/' + model, route: true },
    };
  }
  if (owners.length === 0) {
    fail('модели «' + model + '» нет в каталоге службы llm (узел «' + id + '», объявлен провайдер «'
      + provider + '»); файл не тронут, провайдер не выдумывается');
  }
  fail('модель «' + model + '» есть у нескольких провайдеров каталога: ' + owners.join(', ')
    + ' (узел «' + id + '», объявлен провайдер «' + provider + '»); укажите провайдера прямо — мигратор не угадывает');
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
 * a refusal leaves the file untouched and creates no backup.
 */
function plan(document, catalog) {
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
    const nodeChanges = [];
    let nextNode = node;

    if (declaredProvider) {
      /* Прямой маршрут уже записан. Остаётся снять legacy-поле modelAlias. */
      if (node.modelAlias !== undefined) {
        nodeChanges.push({ id, note: 'убран modelAlias' });
        nextNode = withoutModelAlias(node);
      }
    } else if (declaredModel) {
      if (!Object.hasOwn(models, declaredModel)) {
        fail('у узла «' + id + '» model «' + declaredModel + '» задан без provider, и алиаса «'
          + declaredModel + '» нет в models: укажите provider и model прямо в узле');
      }
      const entry = models[declaredModel];
      const route = { provider: text(entry.provider), model: text(entry.model) };
      /* Приоритет у своего family узла: прямой маршрут не перетирается картой. */
      const family = text(node.family) || text(entry.family);
      nodeChanges.push({
        id,
        from: declaredModel,
        to: route.provider + '/' + route.model,
        family: family || null,
      });
      nextNode = migratedNode(node, route, family);
    }
    /* Узел без модели (например, обмен) — мигратор его не трогает. */

    if (catalog) {
      const repaired = repairRoute(nextNode, catalog);
      if (repaired.change) nodeChanges.push(repaired.change);
      nextNode = repaired.node;
    }

    changes.push(...nodeChanges);
    return nextNode;
  });

  /* Порядок ключей файла сохраняется: models выпадает, nodes остаётся на месте. */
  const next = {};
  for (const key of Object.keys(document)) {
    if (key === 'models') continue;
    next[key] = key === 'nodes' ? nodes : document[key];
  }
  if (!Object.hasOwn(document, 'nodes')) next.nodes = nodes;
  if (hasModelsKey) changes.push({ id: null, note: 'ключ models{} удалён (' + Object.keys(models).length + ' алиас(ов))' });

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
    const route = change.route ? ' (провайдер по каталогу)' : '';
    console.log('  ' + change.id + ': ' + change.from + ' -> ' + change.to + family + route);
  }
}

async function main() {
  if (dryRun === write) {
    console.error('usage: node tools/migrate-models.mjs --dry-run|--write [--catalog <file>|--models-url <url>] [--require-catalog]');
    return 2;
  }

  let loaded;
  try {
    loaded = await loadCatalog();
  } catch (error) {
    console.error('migrate-models: отказ: ' + messageOf(error));
    console.error('файл не изменён: ' + RELATIVE);
    return 1;
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
    result = plan(document, loaded.catalog);
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

process.exitCode = await main();
