/**
 * Единственный источник формы notice-контекста (задание 0088).
 *
 * Плагин добавляет к результату инструмента служебное сообщение для модели
 * («структура: альтернативный путь», «структура: обязанности»). Харнесс
 * сохраняет `additionalContexts` в журнал сессии как `user/message`, а читатель
 * формата v4 (`dsh-session-format-v3-to-v4`) принимает сообщение только целиком:
 *
 *   - непустой строковый `id` — без него сессия не восстанавливается
 *     («seed user/message at index N lacks an identified message»), и журнал
 *     перестаёт открываться; 0086 закрыло только `role`;
 *   - `role: 'user'` — иначе отклоняется следующий запрос к модели целиком
 *     (`messages[N]: missing field role`, задание 0086);
 *   - producer-owned `source.kind` — непустая строка, не равная 'plugin'; без
 *     неё читатель v4 отказывает всему журналу («format v4 message requires a
 *     producer-owned source kind»);
 *   - `content` — массив блоков.
 *
 * Поэтому поля собираются здесь, а не дублируются по модулям: иначе следующая
 * правка формы снова потребует двух одинаковых изменений (как было с 0086, где
 * роль добавляли в двух местах).
 *
 * Импортов пакетов DSH нет: `node:crypto` достаточно, бренд значения не меняет.
 */
import { randomUUID } from 'node:crypto';

/** Producer-owned вид источника: ровно его ждёт мигратор v3→v4. */
export const NOTICE_SOURCE_KIND = 'plugin:dsh-project-graph';

/**
 * Полный message формата v4 для notice-контекста.
 *
 * @param options.text - текст предупреждения (content — один текстовый блок).
 * @param options.summary - короткая подпись для `source.summary` (не меняется с 0086).
 * @returns `{ id, role: 'user', content, source: { kind, form: 'notice', summary } }`.
 *          `id` свежий на каждый вызов: две записи журнала — два разных сообщения.
 */
export function noticeMessage({ text, summary } = {}) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_SOURCE_KIND, form: 'notice', summary },
  };
}
