# Проверка модели узлов (T6, задание 0030)

Дата: 2026-11-03. Источник требования: workflow --76 (T6), уточнение --82.
Проверял: worker (structure), сессия суб-агента.

## Факт

- **Провайдер:** `opencode-go` (объявлен в профиле `~/.dsh/profiles/desktop/cordis.patch.yml`,
  блок `llm-pi-ai`; там же `agent-default-model` = `opencode-go` / `deepseek-v4.1-flash`).
- **Модель:** `deepseek-v4.1-flash`.
- **Маршрут узла:** `structure/graph.json` → `models.work`, `models.critic`, `models.designer`
  переведены на `opencode-go` / `deepseek-v4.1-flash`; узлы `worker`, `judge`, `designer`, `critic`
  ссылаются на эти алиасы, поэтому идут тем же маршрутом.

## Что проверено (команда и вывод)

### 1. Маршрут узла разрешается до provider/model

Команда: `project_graph_spawn({ node: "worker", plan: true, root: "C:/Users/Goryachev/Documents/deepseek-harness/dsh-project-graph" })`

Вывод (дословно):

```json
{
  "kind": "plan",
  "node": "worker",
  "role": "исполнитель",
  "provider": "opencode-go",
  "model": "deepseek-v4.1-flash"
}
```

### 2. Провайдер отдаёт модель в списке

Команда: `GET https://opencode.ai/zen/go/v1/models` с `Authorization: Bearer $OPENCODE_GO_API_KEY`.

Вывод: `HTTP 200`, в `data[]` 28 моделей, среди них `"id": "deepseek-v4.1-flash"`.

### 3. Провайдер принимает запрос к модели

Команда:

```
POST https://opencode.ai/inference/go/openai/v1/chat/completions
Authorization: Bearer $OPENCODE_GO_API_KEY
Content-Type: application/json
x-opencode-session: <uuid>

{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Ответь ровно одной строкой: РОУТ ЖИВ. Без пояснений."}],"max_tokens":200,"reasoning_effort":"low","stream":false}
```

Вывод (дословно, сокращены только необязательные поля ответа):

```json
{
  "id": "gw-c2a0aa5c2d63-cf38f3",
  "model": "deepseek-v4.1-flash",
  "choices": [
    { "index": 0, "finish_reason": "stop",
      "message": { "role": "assistant", "content": "РОУТ ЖИВ." } }
  ]
}
```

`HTTP 200`, `model` в ответе совпадает с запрошенным, `finish_reason: "stop"` — провайдер модель
принял и ответил.

### 4. Ограничение прогона узла в этой сессии

Попытка `project_graph_run({ node: "worker", prompt: "эхо-проверка маршрута", root: "…/dsh-project-graph" })`
отклонена хостом дословно:

```
subagent depth 2 exceeds maxDepth 1
```

Это ограничение вложенности субагента, а не отказ провайдера: маршрут и сама модель проверены
запросами 1–3. Фактический запуск узла `worker` через `project_graph_run` выполняет координатор
(родительская сессия) — вывод запуска прикладывается к сдаче отдельно, если требуется.

### Ограничение живой прогон узла

Живой прогон узла из суб-агента невозможен (`subagent depth 2 exceeds maxDepth 1`);
доказательство — маршрут `plan` + ответ провайдера; живой прогон приложит координатор при
следующем спавне узла.

## Решение

Решение: переведено — `models.work`, `models.critic`, `models.designer` в `structure/graph.json`
имеют `provider: "opencode-go"`, `model: "deepseek-v4.1-flash"`; провайдер отдаёт эту модель
(HTTP 200 и ответ модели), отказ провайдера отсутствует.
