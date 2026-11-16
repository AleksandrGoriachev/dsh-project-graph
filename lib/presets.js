/**
 * 0202: неизменяемые пресеты узлов.
 *
 * Повод тот же, что у прототипа 0133: промпт узла — не ограничение, его можно
 * переписать или проигнорировать. Требования узла живут отдельным файлом
 * presets/<node>.json, закреплены хешем в presets/lock.json и проверяются ДО
 * активации агента (lib/spawn.js). Правка пресета без обновления замка — отказ.
 *
 * Схема пресета строгая: node, version, immutable, pipeline, requires, deny,
 * secrets; незнакомые поля запрещены. node обязан совпасть с идентификатором
 * узла, immutable обязан быть true, а release-1 дополнительно обязан нести
 * релизный пайплайн, предполёт и запреты (как в прототипе).
 *
 * Гейт не бросает исключений: он возвращает {warnings, errors}. Решение об
 * отказе принимает вызывающий (spawn/run), поэтому один и тот же гейт можно
 * использовать в проверке структуры без запуска.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PRESETS_DIR = 'presets';
export const PRESETS_LOCK = 'lock.json';
export const RELEASE_NODE = 'release-1';
export const RELEASE_PIPELINE = 'tools/release.mjs';
export const RELEASE_PREFLIGHT = ['check-version', 'release-receipt --online'];
export const RELEASE_DENY = ['git push', 'gh release create', 'publish-public'];
export const PRESET_FIELDS = Object.freeze([
  'node', 'version', 'immutable', 'pipeline', 'requires', 'deny', 'secrets',
]);
const REQUIRES_FIELDS = Object.freeze(['acceptance', 'preflight', 'evidence', 'guard']);
const GUARD_FIELDS = Object.freeze(['enabled', 'scope', 'reason']);
const LOCK_FIELDS = Object.freeze(['version', 'note', 'presets']);
const SHA256_HEX = /^[0-9a-f]{64}$/iu;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * Хеш пресета — sha256 ровно тех байт, что лежат в файле.
 *
 * Никакой нормализации: иначе дописанный перевод строки или пробел обходил бы
 * замок. Файлы пресетов пишутся без хвостового перевода, поэтому внешний
 * sha256 файла и значение в lock.json совпадают буквально.
 */
export function hash(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
}

/** JSON-файл с сохранением текста: хеш считается по тому, что лежит на диске. */
function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const missing = Boolean(error && error.code === 'ENOENT');
    return {
      exists: !missing,
      text: '',
      data: null,
      error: missing ? null : 'файл не читается: ' + messageOf(error),
    };
  }
  try {
    return {
      exists: true,
      text: raw,
      data: JSON.parse(raw.replace(/^\uFEFF/u, '')),
      error: null,
    };
  } catch (error) {
    return {
      exists: true,
      text: raw,
      data: null,
      error: 'не разбирается как JSON: ' + messageOf(error),
    };
  }
}

/**
 * Прочитать каталог пресетов и замок, не выбирая, какие узлы «объявлены».
 *
 * Решает гейт: у него есть граф. readPresets лишь отдаёт факты — какие файлы
 * есть, что в них, какой хеш и что говорит lock.json. Отсутствие каталога —
 * не ошибка чтения: гейт сам скажет preset-required/preset-missing по узлам.
 */
export function readPresets(root) {
  const repo = path.resolve(String(root || '.'));
  const dir = path.join(repo, PRESETS_DIR);
  const lockFile = path.join(dir, PRESETS_LOCK);
  const lockRead = readJsonFile(lockFile);
  const presets = [];
  let dirError = null;
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) dirError = 'каталог пресетов не читается: ' + messageOf(error);
  }
  const lockData = isPlainObject(lockRead.data) && isPlainObject(lockRead.data.presets)
    ? lockRead.data.presets
    : null;
  const files = names
    .filter((entry) => entry && entry.isFile && /\.json$/iu.test(entry.name) && entry.name !== PRESETS_LOCK)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  for (const name of files) {
    const id = name.slice(0, -'.json'.length);
    if (!id) continue;
    const file = path.join(dir, name);
    const read = readJsonFile(file);
    presets.push({
      id,
      node: id,
      file,
      exists: read.exists,
      text: read.text,
      data: read.data,
      readError: read.error,
      hash: read.exists ? hash(read.text) : '',
      pinned: lockData && Object.hasOwn(lockData, id) ? lockData[id] : undefined,
    });
  }
  return {
    root: repo,
    dir,
    lockFile,
    lockPresent: lockRead.exists,
    lock: lockRead.data,
    lockError: lockRead.error,
    presets,
    dirError,
  };
}

/** Ошибка схемы: одинаковый код, поле и человеческое объяснение. */
function schema(errors, field, message) {
  errors.push({ code: 'preset-schema', field, message });
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function checkStringArray(errors, value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    schema(errors, field, 'поле ' + field + ' обязано быть непустым массивом строк');
    return;
  }
  for (const item of value) {
    if (!nonEmptyString(item)) {
      schema(errors, field, 'в поле ' + field + ' только непустые строки');
      return;
    }
  }
}

/**
 * Проверить схему одного пресета.
 *
 * @param data - разобранный JSON пресета.
 * @param expectedNode - идентификатор узла из графа; node пресета обязан совпасть.
 * @returns {{ok: boolean, errors: {code: string, field?: string, message: string}[]}}
 */
export function validatePreset(data, expectedNode = '') {
  const errors = [];
  if (!isPlainObject(data)) {
    return { ok: false, errors: [{ code: 'preset-schema', message: 'пресет обязан быть JSON-объектом' }] };
  }
  const unknown = Object.keys(data).filter((key) => !PRESET_FIELDS.includes(key));
  if (unknown.length > 0) schema(errors, 'preset', 'неизвестные поля пресета: ' + unknown.join(', '));

  const node = text(data.node);
  if (!node) schema(errors, 'node', 'у пресета обязан быть непустой node');
  else if (expectedNode && node !== expectedNode) {
    schema(errors, 'node', 'node пресета «' + node + '» не совпадает с узлом «' + expectedNode + '»');
  }
  if (!Number.isInteger(data.version) || data.version < 1) {
    schema(errors, 'version', 'version обязан быть целым числом не меньше 1');
  }
  if (data.immutable !== true) {
    errors.push({
      code: 'preset-not-immutable',
      field: 'immutable',
      message: 'immutable обязан быть true — иначе пресет не ограничение',
    });
  }
  if (!nonEmptyString(data.pipeline)) schema(errors, 'pipeline', 'pipeline обязан быть непустой строкой');
  if (!isPlainObject(data.requires)) {
    schema(errors, 'requires', 'requires обязан быть объектом');
  } else {
    const unknownRequires = Object.keys(data.requires).filter((key) => !REQUIRES_FIELDS.includes(key));
    if (unknownRequires.length > 0) {
      schema(errors, 'requires', 'неизвестные поля requires: ' + unknownRequires.join(', '));
    }
    if (data.requires.acceptance !== undefined && !nonEmptyString(data.requires.acceptance)) {
      schema(errors, 'requires.acceptance', 'requires.acceptance обязан быть непустой строкой');
    }
    if (data.requires.preflight !== undefined) {
      checkStringArray(errors, data.requires.preflight, 'requires.preflight');
    }
    if (data.requires.evidence !== undefined) {
      checkStringArray(errors, data.requires.evidence, 'requires.evidence');
    }
    if (data.requires.guard !== undefined) {
      const guard = data.requires.guard;
      if (!isPlainObject(guard)) {
        schema(errors, 'requires.guard', 'requires.guard обязан быть объектом');
      } else {
        const unknownGuard = Object.keys(guard).filter((key) => !GUARD_FIELDS.includes(key));
        if (unknownGuard.length > 0) {
          schema(errors, 'requires.guard', 'неизвестные поля requires.guard: ' + unknownGuard.join(', '));
        }
        if (typeof guard.enabled !== 'boolean') {
          schema(errors, 'requires.guard.enabled', 'requires.guard.enabled обязан быть boolean');
        }
        if (!nonEmptyString(guard.scope)) {
          schema(errors, 'requires.guard.scope', 'requires.guard.scope обязан быть непустой строкой');
        }
        if (!nonEmptyString(guard.reason)) {
          schema(errors, 'requires.guard.reason', 'requires.guard.reason обязан быть непустой строкой');
        }
      }
    }
  }
  checkStringArray(errors, data.deny, 'deny');
  if (!nonEmptyString(data.secrets)) schema(errors, 'secrets', 'secrets обязан быть непустой строкой');

  /*
   * release-1 — обязательный узел-выпускающий: пресет без пайплайна, онлайн
   * предполёта, запретов push/gh/publish-public и guard.enabled не ограничение,
   * а декорация. Требования те же, что у прототипа 0133.
   */
  const release = expectedNode === RELEASE_NODE || (!expectedNode && node === RELEASE_NODE);
  if (release) {
    if (text(data.pipeline) !== RELEASE_PIPELINE) {
      errors.push({
        code: 'preset-release-requirements',
        field: 'pipeline',
        message: 'у release-1 pipeline обязан быть ' + RELEASE_PIPELINE,
      });
    }
    const preflight = Array.isArray(data.requires && data.requires.preflight)
      ? data.requires.preflight.map((item) => String(item))
      : [];
    for (const required of RELEASE_PREFLIGHT) {
      if (!preflight.some((item) => item.includes(required))) {
        errors.push({
          code: 'preset-release-requirements',
          field: 'requires.preflight',
          message: 'у release-1 в предполёте нет «' + required + '»',
        });
      }
    }
    const deny = Array.isArray(data.deny) ? data.deny.map((item) => String(item).toLowerCase()) : [];
    for (const required of RELEASE_DENY) {
      if (!deny.some((item) => item.includes(required))) {
        errors.push({
          code: 'preset-release-requirements',
          field: 'deny',
          message: 'у release-1 в запретах нет «' + required + '»',
        });
      }
    }
    if (!(data.requires && data.requires.guard && data.requires.guard.enabled === true)) {
      errors.push({
        code: 'preset-release-requirements',
        field: 'requires.guard.enabled',
        message: 'у release-1 обязан быть включён guard.enabled',
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------------- *
 * Сравнение запрещённой команды с текстом и argv.
 *
 * Ищем фразу целиком, но только на границе слова: «publish-public» ловится и
 * в «./publish-public --build», и в конце предложения, а «-f» не срабатывает
 * от «--ff-only», «git push» — от «git-push» или «publish-publication». Граница
 * слова — буква/цифра/подчёркивание/дефис; слэш и точка границей остаются,
 * поэтому путь перед командой не становится обходом.
 * ------------------------------------------------------------------------- */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function commandPattern(command) {
  const parts = String(command == null ? '' : command).trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return null;
  const body = parts.map(escapeRegExp).join('\\s+');
  return new RegExp('(^|[^\\p{L}\\p{N}_-])' + body + '(?=$|[^\\p{L}\\p{N}_-])', 'iu');
}

function mentionsCommand(value, command) {
  const pattern = commandPattern(command);
  if (!pattern) return false;
  const target = String(value == null ? '' : value).replace(/\s+/gu, ' ').toLowerCase();
  return pattern.test(target);
}

function errorKey(item) {
  return String(item && item.code) + '\u0000' + String(item && item.node) + '\u0000' + String(item && item.message);
}

function pushUnique(list, seen, item) {
  const key = errorKey(item);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(item);
}

/** Аргументы вызова: строка, массив строк или ничего (тогда argv процесса). */
function argvValues(value) {
  if (value === undefined || value === null) return process.argv.slice();
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

/**
 * Гейт пресетов по графу.
 *
 * release-1 без пресета — error preset-required; другой узел без пресета —
 * warning preset-missing. Неизвестный/битый пресет, несовпадение схемы или
 * замка — error. Строки deny ищутся в node.prompt и argv: совпадение —
 * preset-denied-command, и вызывающий обязан отказать без активации.
 *
 * target — узел, который собираются активировать. Тогда ошибки ЦЕЛЕВОГО узла
 * остаются errors, а ошибки остальных узлов уходят в warnings с кодом
 * preset-other-node: чужой нарушенный промпт не должен блокировать запуск
 * reviewer/judge. Глобальные проверки (замок, неизвестные пресеты, argv)
 * остаются errors при любом target. Без target поведение прежнее — весь граф
 * проверяется как один структурный гейт.
 *
 * @param graph - собранный граф структуры.
 * @param root - корень проекта, в котором лежит presets/.
 * @param options - { target, argv }; argv по умолчанию process.argv.
 * @returns {{warnings: object[], errors: object[]}}
 */
export function presetGate(graph, root, options = {}) {
  const warnings = [];
  const errors = [];
  const warningKeys = new Set();
  const errorKeys = new Set();
  const target = text(options && options.target);
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes.filter(isPlainObject) : [];
  const nodeById = new Map();
  for (const node of nodes) {
    const id = text(node.id);
    if (id && !nodeById.has(id)) nodeById.set(id, node);
  }
  const loaded = readPresets(root);
  if (loaded.dirError) {
    pushUnique(errors, errorKeys, { code: 'preset-broken', node: '', message: loaded.dirError });
  }

  let lockMap = null;
  if (loaded.lockPresent) {
    if (loaded.lockError) {
      pushUnique(errors, errorKeys, { code: 'preset-lock', node: '', message: PRESETS_LOCK + ' не читается: ' + loaded.lockError });
    } else if (!isPlainObject(loaded.lock)) {
      pushUnique(errors, errorKeys, { code: 'preset-lock', node: '', message: PRESETS_LOCK + ' обязан быть JSON-объектом' });
    } else {
      const unknownLock = Object.keys(loaded.lock).filter((key) => !LOCK_FIELDS.includes(key));
      if (unknownLock.length > 0) {
        pushUnique(errors, errorKeys, {
          code: 'preset-lock',
          node: '',
          message: 'неизвестные поля ' + PRESETS_LOCK + ': ' + unknownLock.join(', '),
        });
      }
      if (loaded.lock.version !== 1) {
        pushUnique(errors, errorKeys, { code: 'preset-lock', node: '', message: 'version замка обязан быть 1' });
      }
      if (!isPlainObject(loaded.lock.presets)) {
        pushUnique(errors, errorKeys, { code: 'preset-lock', node: '', message: 'у замка обязан быть объект presets' });
      } else {
        lockMap = loaded.lock.presets;
      }
    }
  } else if (loaded.presets.length > 0) {
    pushUnique(errors, errorKeys, {
      code: 'preset-lock',
      node: '',
      message: 'есть пресеты, но нет ' + PRESETS_DIR + '/' + PRESETS_LOCK + ': целостность не доказана',
    });
  }

  /*
   * Ошибка узла становится отказом только для целевого узла. Чужая ошибка
   * сохраняется в warnings с исходным кодом в тексте: её видно в отчёте, но
   * она не отменяет запуск reviewer/judge из-за промпта release-1.
   */
  const addNodeProblem = (problem) => {
    if (!target || problem.node === target) {
      pushUnique(errors, errorKeys, problem);
      return;
    }
    pushUnique(warnings, warningKeys, {
      code: 'preset-other-node',
      node: problem.node,
      originalCode: problem.code,
      message: 'другой узел «' + problem.node + '»: ' + problem.code + ': ' + problem.message,
    });
  };

  for (const [id, node] of nodeById) {
    const entry = loaded.presets.find((item) => item.id === id);
    if (!entry) {
      if (id === RELEASE_NODE) {
        addNodeProblem({
          code: 'preset-required',
          node: id,
          message: 'у узла release-1 обязан быть пресет ' + PRESETS_DIR + '/' + id + '.json',
        });
      } else if (lockMap && Object.hasOwn(lockMap, id)) {
        addNodeProblem({
          code: 'preset-unknown',
          node: id,
          message: 'замок закрепляет пресет «' + id + '», но файла ' + PRESETS_DIR + '/' + id + '.json нет',
        });
      } else {
        pushUnique(warnings, warningKeys, {
          code: 'preset-missing',
          node: id,
          message: 'у узла «' + id + '» нет пресета ' + PRESETS_DIR + '/' + id + '.json',
        });
      }
      continue;
    }
    if (entry.readError) {
      addNodeProblem({ code: 'preset-broken', node: id, message: entry.readError });
      continue;
    }
    const checked = validatePreset(entry.data, id);
    for (const item of checked.errors) {
      addNodeProblem({ ...item, node: id });
    }
    if (lockMap) {
      if (!Object.hasOwn(lockMap, id)) {
        addNodeProblem({
          code: 'preset-unpinned',
          node: id,
          message: 'в ' + PRESETS_LOCK + ' нет хеша пресета «' + id + '» — пресет не закреплён',
        });
      } else if (typeof entry.pinned !== 'string' || !SHA256_HEX.test(entry.pinned)) {
        addNodeProblem({
          code: 'preset-lock',
          node: id,
          message: 'хеш пресета «' + id + '» в замке не похож на sha256',
        });
      } else if (entry.pinned.toLowerCase() !== entry.hash) {
        addNodeProblem({
          code: 'preset-hash-mismatch',
          node: id,
          message: 'хеш пресета «' + id + '» не совпадает с замком: '
            + entry.hash.slice(0, 12) + '… != ' + entry.pinned.toLowerCase().slice(0, 12) + '…',
        });
      }
    }
    const deny = Array.isArray(entry.data && entry.data.deny) ? entry.data.deny : [];
    for (const command of deny) {
      if (mentionsCommand(node.prompt, command)) {
        addNodeProblem({
          code: 'preset-denied-command',
          node: id,
          message: 'промпт узла «' + id + '» содержит запрещённую команду «' + command + '»',
        });
      }
    }
  }

  /* Пресет без узла — неизвестный: он не ограничивает никого и вводит в заблуждение. */
  for (const entry of loaded.presets) {
    if (!nodeById.has(entry.id)) {
      pushUnique(errors, errorKeys, {
        code: 'preset-unknown',
        node: entry.id,
        message: 'пресет «' + entry.id + '» не соответствует ни одному узлу графа',
      });
    }
  }
  if (lockMap) {
    for (const id of Object.keys(lockMap)) {
      if (!nodeById.has(id)) {
        pushUnique(errors, errorKeys, {
          code: 'preset-unknown',
          node: id,
          message: 'замок закрепляет неизвестный узел «' + id + '»',
        });
      }
    }
  }

  /*
   * argv — канал вызова, а не объявление узла. Проверяем его против deny всех
   * валидных пресетов: запрет release-1 не должен обходиться запуском через
   * другую ветку.
   */
  const argv = argvValues(options && options.argv).join(' ');
  if (argv.trim()) {
    for (const entry of loaded.presets) {
      if (entry.readError || !isPlainObject(entry.data) || !Array.isArray(entry.data.deny)) continue;
      for (const command of entry.data.deny) {
        if (mentionsCommand(argv, command)) {
          pushUnique(errors, errorKeys, {
            code: 'preset-denied-command',
            node: entry.id,
            message: 'argv содержит запрещённую команду «' + command + '» (пресет «' + entry.id + '»)',
          });
        }
      }
    }
  }

  return { warnings, errors };
}
