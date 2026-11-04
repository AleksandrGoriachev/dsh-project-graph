/**
 * The base spec of the critic, written when the node is created.
 *
 * The scheduler reads the spec from the workspace (docs/critic/spec.md), so a new
 * critic node without that file would improvise. Creating the node therefore also
 * lays down the template: the customer edits it afterwards, and the file is never
 * overwritten once it exists.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CRITIC_SPEC_PATH = path.join('docs', 'critic', 'spec.md');

export const CRITIC_SPEC_TEMPLATE = `# Базовая спека критика

Постоянные правила узла \`critic\`. Их меняет человек; дневную спеку критик собирает
сам из фактов и она живёт один запуск.

## Вход

Только факты: запуски за сутки (узел, вид, состояние, начало/конец, ошибка),
шапки обмена (отправитель, адресат, время, статус) и структура. Тексты сообщений и
содержимое чужих воркспейсов не читаются.

## Что проверяет

1. Сбои: запуски в состоянии error, их доля и повторяемость.
2. Простой: узлы, которые должны были работать, но не запускались.
3. Расписания: пропущенные окна (пропуск не догоняется).
4. Связи: узлы без приёмки (review или report владельцу).
5. Обмен: перекос направлений, старые связи, неразобранные файлы.
6. Контракты: приёмщик, противоречащий структуре.

## Выход

Аналитика одной связью report координатору: итог дня, риски с указанием узла и
факта, что делать дальше, чего не хватило по данным.

## Границы

Не менять структуру, код и расписания; не запускать агентов; не выдавать догадку
за факт — «неизвестно» допустимый вывод.
`;

/** Write the template only when the file is absent; never overwrite a person's spec. */
export function ensureCriticSpec(root) {
  const absolute = path.join(root, CRITIC_SPEC_PATH);
  try {
    if (fs.existsSync(absolute)) return { created: false, path: CRITIC_SPEC_PATH };
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, CRITIC_SPEC_TEMPLATE, 'utf8');
    return { created: true, path: CRITIC_SPEC_PATH };
  } catch (error) {
    return { created: false, path: CRITIC_SPEC_PATH, error: error && error.message ? error.message : String(error) };
  }
}

/** Does this node look like the critic (by id or by role word)? */
export function isCriticNode(node) {
  if (!node || typeof node !== 'object') return false;
  const id = typeof node.id === 'string' ? node.id : '';
  /* `Critic`, `critic`, `critic-2` — the same role, whatever the case or suffix. */
  if (/^critic(-|$)/iu.test(id)) return true;
  return typeof node.role === 'string' && /критик|critic/iu.test(node.role);
}
