/**
 * Одно правило адресации: «ярлык → корень → база ящика» (задание 0374).
 *
 * До этого задания правило считалось в трёх местах: область обмена в стороже
 * (только participants), участие в папке в панели (только строки participants) и
 * разрешение адресата при записи письма (своя лестница). Расхождения и давали
 * дефекты A3/B2/C2 из характеризации 0372. Теперь правило одно и живёт здесь:
 *
 *   label        — ярлык объявлен картой участников (profile participants);
 *   label        — ярлык объявлен объявленными путями папки (folders[].paths);
 *   path         — абсолютный путь, СОВПАВШИЙ с корнем участника или с
 *                  объявленным путём папки;
 *   legacy       — идентификатор узла или роль (устаревший адрес, не ошибка):
 *                  письмо пишется, но база ящика считается прежней лестницей;
 *   unresolved   — ни ярлык, ни путь, ни роль: адрес не разрешается.
 *
 * Приоритет источников предсказуем: карта участников сильнее объявленных путей
 * папки (при конфликте ярлык и корень берутся из карты), и это видно в поле
 * source результата — participants | folders.paths | legacy.
 *
 * Прежняя лестница разрешения БАЗЫ ЯЩИКА не удалена: она остаётся запасным
 * путём для устаревшего адреса (kind legacy) и живёт в legacyBoxBase.
 *
 * Сравнение ярлыков — без учёта регистра (как в 0373), сравнение путей — без
 * учёта регистра и разделителей (Windows-правило проекта). Модуль не читает
 * диск и не импортирует lib/api.js: его могут звать и сторож, и панель, и
 * модуль обмена.
 */
import path from 'node:path';
import { commonParent } from './boxes.js';

/** Устаревшие адреса: роль или id узла. Тот же список, что был в lib/exchange.js. */
const LEGACY_IDENTITY = /^(?:subagent:)?(?:coordinator|orchestrator|worker|designer|reviewer|acceptor|judge|critic|tester|timekeeper|keeper|release|auditor|adviser|interlocutor|folder|lead|architect|planner|executor|panel)(?:-[a-z0-9]+)*$/iu;

/** Откуда взято соответствие. */
export const IDENTITY_SOURCE = {
  participants: 'participants',
  folderPaths: 'folders.paths',
  legacy: 'legacy',
};

/** Ключ сравнения путей: регистр и разделители не решают, чей это корень. */
function pathKeyOf(value) {
  try {
    return path.resolve(String(value == null ? '' : value)).replace(/\\/gu, '/').toLowerCase();
  } catch {
    return String(value == null ? '' : value).replace(/\\/gu, '/').toLowerCase();
  }
}

/** Непустая строка без хвостовых пробелов, иначе пустая. */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Объявленные пути ОДНОЙ папки: метка -> абсолютный путь. */
function folderPathEntries(folder) {
  const raw = folder && folder.paths;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const entries = [];
  for (const [label, value] of Object.entries(raw)) {
    const name = textOf(label);
    const root = textOf(value);
    if (!name || !root) continue;
    entries.push({ label: name, root: path.resolve(root) });
  }
  return entries;
}

/** Абсолютные пути участников ОДНОЙ папки (устаревшая форма объявления). */
function absoluteParticipantEntries(folder) {
  const entries = [];
  const list = folder && Array.isArray(folder.participants) ? folder.participants : [];
  for (const item of list) {
    const value = textOf(item);
    if (!value || !path.isAbsolute(value)) continue;
    const root = path.resolve(value);
    const label = path.basename(root);
    if (!label) continue;
    entries.push({ label, root });
  }
  return entries;
}

/**
 * Реестр соответствий одного контекста.
 *
 * Порядок добавления и есть приоритет: карта участников, затем абсолютные пути
 * участников папки, затем объявленные пути папки, затем собственная личность
 * вызывающего. Первое объявление ярлыка/корня побеждает; объявленный путём
 * корень «повышается» до participants, если тот же корень назван картой.
 */
function identityRegistry(context = {}) {
  const labels = new Map();
  const roots = [];
  const add = (rawLabel, rawRoot, source) => {
    const rootText = textOf(rawRoot);
    if (!rootText) return;
    let root;
    try {
      root = path.resolve(rootText);
    } catch {
      return;
    }
    const label = textOf(rawLabel) || path.basename(root);
    if (!label) return;
    const labelKey = label.toLowerCase();
    if (!labels.has(labelKey)) labels.set(labelKey, { label, root, source });
    const rootKey = pathKeyOf(root);
    const known = roots.find((item) => item.key === rootKey);
    if (!known) roots.push({ key: rootKey, label, root, source });
    else if (known.source !== IDENTITY_SOURCE.participants && source === IDENTITY_SOURCE.participants) {
      known.label = label;
      known.source = source;
    }
  };
  const participants = context && context.participants && typeof context.participants === 'object'
    && !Array.isArray(context.participants) ? context.participants : {};
  for (const [label, value] of Object.entries(participants)) add(label, value, IDENTITY_SOURCE.participants);
  const folders = context && Array.isArray(context.folders) ? context.folders.filter(Boolean) : [];
  for (const folder of folders) {
    for (const entry of absoluteParticipantEntries(folder)) add(entry.label, entry.root, IDENTITY_SOURCE.participants);
  }
  for (const folder of folders) {
    for (const entry of folderPathEntries(folder)) add(entry.label, entry.root, IDENTITY_SOURCE.folderPaths);
  }
  /*
   * Имя каталога корня — тоже метка (панель называет воркспейс и так). Добавляется
   * ПОСЛЕ явных ярлыков, поэтому не перекрывает ни один объявленный ярлык.
   */
  for (const entry of roots) {
    const alias = path.basename(entry.root);
    const key = alias.toLowerCase();
    if (key && !labels.has(key)) labels.set(key, { label: alias, root: entry.root, source: entry.source });
  }
  const selfLabel = textOf(context && context.selfLabel);
  const selfRoot = textOf(context && context.root);
  if (selfRoot) add(selfLabel || path.basename(path.resolve(selfRoot)), selfRoot, IDENTITY_SOURCE.participants);
  return { labels, roots };
}

/**
 * Карта ярлык → корень по тому же правилу, что identityOf.
 *
 * Карта несёт каноническое написание ярлыка и, рядом, его нижний регистр — как
 * labelRoots сторожа: вызывающему не нужно помнить, в каком регистре объявлена
 * сторона. Конфликт ярлыков решает приоритет источников (карта участников
 * сильнее объявленных путей папки).
 *
 * @returns {Map<string,string>} ярлык (и его нижний регистр) → абсолютный корень.
 */
export function labelRootsMap(context = {}) {
  const { labels } = identityRegistry(context);
  const map = new Map();
  for (const entry of labels.values()) {
    if (!map.has(entry.label)) map.set(entry.label, entry.root);
    const lower = entry.label.toLowerCase();
    if (!map.has(lower)) map.set(lower, entry.root);
  }
  return map;
}

/**
 * Прежняя лестница разрешения базы ящика — запасной путь для устаревшего адреса.
 *
 * Порядок тот же, что был в панели: корни участников (карта профиля и
 * объявленные пути) → известные корни вызывающего → свой корень; база — их
 * общий каталог. Ничего не выдумывается: нет общего каталога — пустая база.
 */
function legacyBoxBase(context, roots) {
  const candidates = [];
  const add = (value) => {
    const text = textOf(value);
    if (!text) return;
    let resolved;
    try {
      resolved = path.resolve(text);
    } catch {
      return;
    }
    if (!candidates.some((item) => pathKeyOf(item) === pathKeyOf(resolved))) candidates.push(resolved);
  };
  for (const entry of roots) add(entry.root);
  for (const value of Array.isArray(context && context.roots) ? context.roots : []) add(value);
  add(context && context.root);
  if (candidates.length === 0) return '';
  if (candidates.length === 1) return candidates[0];
  return commonParent(candidates) || '';
}

/**
 * Разрешить одно значение адресации.
 *
 * @param value - ярлык, абсолютный путь, роль/узел или что угодно ещё.
 * @param context - { participants?, folders?, roots?, root?, selfLabel? }:
 *   карта профиля, папки структуры (их participants и paths), известные корни,
 *   свой корень и своя метка.
 * @returns {{ kind: 'label'|'path'|'legacy'|'unresolved', label: string,
 *   root: string, boxBase: string, source: 'participants'|'folders.paths'|'legacy'|'' }}
 *   root — воркспейс, boxBase — каталог, от которого считается ящик;
 *   source — сработавший источник (пустой у unresolved).
 */
export function identityOf(value, context = {}) {
  const text = textOf(value);
  if (!text) return { kind: 'unresolved', label: '', root: '', boxBase: '', source: '' };
  const { labels, roots } = identityRegistry(context);
  const byLabel = labels.get(text.toLowerCase());
  if (byLabel) {
    return { kind: 'label', label: byLabel.label, root: byLabel.root, boxBase: byLabel.root, source: byLabel.source };
  }
  if (path.isAbsolute(text)) {
    const key = pathKeyOf(text);
    const exact = roots.find((item) => item.key === key);
    if (exact) {
      return { kind: 'path', label: exact.label, root: exact.root, boxBase: exact.root, source: exact.source };
    }
  }
  if (LEGACY_IDENTITY.test(text)) {
    return { kind: 'legacy', label: text, root: '', boxBase: legacyBoxBase(context, roots), source: IDENTITY_SOURCE.legacy };
  }
  return { kind: 'unresolved', label: text, root: '', boxBase: '', source: '' };
}
