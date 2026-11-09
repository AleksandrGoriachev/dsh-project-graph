/**
 * dsh-project-graph client half (classic browser module).
 *
 * A view of a project's structure: roles, models and links declared in
 * structure/*.json. Requests are reads, plus the one write the person makes on
 * the canvas — the saved x/y of a dragged node; nothing here runs an agent, a
 * gate or a command. Kept as plain classic JS on purpose: DSH serves lib/client.js
 * directly and third-party plugin clients have no bundler.
 *
 * Two rules shape the screen. First, a person opens it, not an agent: every
 * problem says what to do, and an empty project gets an instruction with an
 * example instead of a technical error. Second, every element explains itself:
 * nodes, links, roles and models carry a human sentence, not just a label.
 */
window.__ModuleLoader__.load({
  id: "dsh-project-graph",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;

    const BASE = "/project-graph";
    const VIEW_ID = "project-graph";
    const WORKFLOW_REPO = "https://github.com/AleksandrGoriachev/subagent-workflow";
    const WORKFLOW_PLUGIN = WORKFLOW_REPO + "/tree/main/plugin";
    const VIEW_LABEL = "Structure";
    const ORDER = 45;
    /*
     * Метка сборки панели. Браузер охотно держит старый файл клиента, и тогда
     * «исправленная» кнопка ведёт себя как прежняя: по этой метке видно, какая
     * сборка реально загружена. Менять при каждой правке lib/client.js.
     */
    const CLIENT_BUILD = "09.11 12:55";

    const T = {
      text: "var(--dsw-alias-label-primary, inherit)",
      secondary: "var(--dsw-alias-label-secondary, rgba(127,127,127,0.95))",
      tertiary: "var(--dsw-alias-label-tertiary, rgba(127,127,127,0.78))",
      caption: "var(--dsw-alias-label-caption, rgba(127,127,127,0.62))",
      bg1: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))",
      bg2: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))",
      border1: "var(--dsw-alias-border-l1, rgba(127,127,127,0.24))",
      border2: "var(--dsw-alias-border-l2, rgba(127,127,127,0.36))",
      link: "var(--dsw-alias-link, #4176e6)",
      success: "var(--dsw-alias-state-success-primary, #22c55e)",
      warn: "var(--dsw-alias-state-warn-primary, #f59e0b)",
      danger: "var(--dsw-alias-state-error-primary, #ec1313)",
      mono: "var(--dsw-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    };

    /* Роли различимы по цвету, но цвет не единственный признак: роль написана
       на карточке словом, а список ролей выводится рядом со сводкой. */
    const ROLE_COLORS = [T.link, T.success, T.warn, "#a855f7", "#06b6d4", "#f472b6", "#84cc16", "#fb7185"];

    /* Что означает каждый вид связи — на человеческом языке, не кодом. */
    const EDGE_HELP = {
      delegate: "поручение: источник передаёт работу цели",
      review: "проверка: цель оценивает работу источника",
      report: "возврат: цель принимает результат источника без оценки",
      peer: "сотрудничество равных, без направления",
    };

    const SAMPLE = {
      version: 1,
      models: {
        work: { provider: "opencode", model: "deepseek-v4.1-flash" },
        critic: { provider: "opencode", model: "glm-5.3-flash", family: "zhipu" },
      },
      nodes: [
        { id: "coordinator", role: "координатор", model: "work", brief: "ведёт план и раздаёт работу" },
        { id: "worker", role: "исполнитель", model: "work", brief: "делает основную работу" },
        { id: "judge", role: "приёмщик", model: "critic", brief: "проверяет работу отдельной сессией", mustDifferFrom: ["worker"] },
      ],
      edges: [
        { from: "coordinator", to: "worker", kind: "delegate" },
        { from: "worker", to: "judge", kind: "review" },
      ],
    };
    const SAMPLE_TEXT = JSON.stringify(SAMPLE, null, 2);

    /*
     * Библиотека узлов: карточки, которые человек выносит на схему. У каждой
     * связь по умолчанию написана словами — цвет стрелки только дублирует.
     * Папка общего обмена — место, а не агент: модели у неё нет. Но связь видна:
     * рёбра exchange от узлов, которые пишут в ящик, и путь папки на карточке
     * (решение заказчика от 2026-11-01 отменяет «связей нет» от 2026-10-31).
     */
    const NODE_LIBRARY = [
      {
        type: "critic",
        label: "Критик",
        icon: "⚖",
        role: "критик",
        brief: "проверяет работу отдельной сессией",
        schedule: { at: "09:00", timeZone: "Europe/Moscow" },
        link: { kind: "report", from: "node", to: "coordinator", words: "возврат report координатору" },
      },
      {
        type: "worker",
        label: "Воркер",
        icon: "⚙",
        role: "исполнитель",
        brief: "делает основную работу",
        link: { kind: "delegate", from: "coordinator", to: "node", words: "координатор поручает · delegate" },
      },
      {
        /*
         * Папка, а не «обмен»: обмен — свойство папки (поле exchange), а не её сущность.
         * Роли у папки нет: роль — принадлежность агента (решение заказчика 2026-11-02).
         */
        type: "folder",
        label: "Папка",
        icon: "📁",
        kind: "folder",
        role: null,
        brief: "общая папка: в ней лежат сообщения, если включён обмен",
        link: null,
        words: "папка, не агент",
      },
      /*
       * Роли, закрывающие сегодняшние провалы (задание 0119): ревьюер видит
       * дефекты до приёмки, тестировщик даёт независимый полный прогон,
       * выпускающий ведёт версию и релиз. Спека роли живёт в prompt узла:
       * пресеты DSH общие, а роль — проектная, поэтому agentPreset
       * необязателен и по умолчанию не выставляется (D2).
       */
      {
        type: "reviewer",
        label: "Ревьюер",
        icon: "🧐",
        role: "ревьюер",
        brief: "читает диф и контракт до приёмки",
        /* Второе мнение: ревьюер смотрит чужую работу моделью другого семейства (0126 D3). */
        model: "glm-5.3-flash",
        link: { kind: "review", from: "worker", to: "node", words: "воркер отдаёт диф на ревью · review" },
        prompt: "Роль: ревьюер — читает диф и контракт до приёмки, ничего не меняет.\nПроверь: критерии не ослаблены и не подогнаны под проверку; ошибки и пустые пути; секреты и внешние вызовы; тесты проверяют поведение, а не реализацию.\nКаждое замечание: файл:строка, серьёзность, почему, что чинить. Отдельно — список «не судил» с причиной.\nDefinition of Done: вердикт ok|issues, замечания с адресами, список «не судил»; дерево не изменено.",
      },
      {
        type: "tester",
        label: "Тестировщик",
        icon: "🧪",
        role: "тестировщик",
        brief: "независимый полный прогон",
        /* Прогон идёт рабочей моделью: рекомендация карточки, а не жёсткая привязка (0126 D3). */
        model: "deepseek-v4.1-flash",
        link: { kind: "delegate", from: "coordinator", to: "node", words: "координатор поручает прогон · delegate" },
        prompt: "Роль: тестировщик — независимый прогон, код не правит.\nПрогони полный набор сторожем: node docs/subagent-workflow/scripts/job.mjs start -- node tools/test.mjs; затем точечные тесты задания.\nФиксируй: команда, exit, время, первая упавшая проверка; флак — только с доказательством повтора.\nDefinition of Done: команды и exit в отчёте, вердикт pass|fail, первое падение названо.",
      },
      {
        type: "release",
        label: "Выпускающий",
        icon: "🚀",
        role: "выпускающий",
        brief: "версия и релиз после приёмки",
        /* Релиз — рабочая модель; карточка рекомендует, человек вправе выбрать другую (0126 D3). */
        model: "deepseek-v4.1-flash",
        link: { kind: "report", from: "node", to: "coordinator", words: "возврат релиза координатору · report" },
        prompt: "Роль: выпускающий — версия и релиз после приёмки.\nШаги: bump по классу изменений, package.json и README, publish-public --build --push, pnpm pack, релиз и ассет по API, проверка HTTP 200 и размера.\nСекреты не печатать; токен только через git credential fill.\nDefinition of Done: версия, тег, URL и размер ассета, HTTP-код, изменённые файлы; при сбое — шаг и текст ошибки.",
      },
    ];

    /** Цвет полосы роли — как в утверждённом макете библиотеки. */
    function libraryRoleColor(type) {
      if (type === "critic") return "#f59e0b";
      if (type === "worker") return "#3b82f6";
      return "#10b981";
    }

    /*
     * Корешок свёрнутой палитры (макет docs/design/palette-nodes-2026-11-05.md, §3).
     * Свёрнутая палитра — не набор плашек, а корешок книги: полоса 44 px, на ней
     * вертикальная надпись «Набор узлов структуры» (чтение снизу вверх:
     * vertical-rl + rotate(180deg) — выбор заказчика 2026-11-05) и три иконки.
     * Ширина не анимируется: transition на width заставлял бы SVG канвы
     * пересчитываться в каждом кадре и выглядел бы миганием.
     */
    const SPINE_WIDTH = 44;
    const SPINE_LABEL = "Набор узлов структуры";
    const SPINE_ICON = 32;

    /*
     * Иконки корешка. Всегда ровно три — critic, worker, folder: заказчик
     * 2026-11-05 («трёх достаточно») решил, что число узлов и папок на состав
     * корешка не влияет, а новые типы живут только в развёрнутом списке.
     * Аргумент nodes оставлен намеренно: панель передаёт сюда то, что прочитала,
     * и это видно в коде, а не только в комментарии.
     */
    function spineIcons(nodes) {
      /* Аргумент nodes намеренно не меняет состав: узлов может быть 0, 3 или 30. */
      return NODE_LIBRARY.slice(0, 3).map((item) => ({
        role: item.type,
        type: item.type,
        label: item.label,
        /* У будущего элемента без глифа полоса не «прыгает»: та же плитка, глиф «＋». */
        icon: item.icon || "＋",
        stripe: libraryRoleColor(item.type),
        size: SPINE_ICON,
        item,
      }));
    }

    /**
     * Папка: не агент. Обмен — её свойство (exchange), а не роль.
     *
     * Старые структуры писали роль «обмен»; такие узлы тоже считаем папками, чтобы
     * миграция не ломала ни карточку, ни редактор.
     */
    function isFolderNode(node) {
      if (!node) return false;
      if (String(node.kind || "") === "folder") return true;
      return /обмен|папка/iu.test(String(node.role || ""));
    }

    /** Прежняя точка входа: по роли. Оставлена для совместимости вызовов. */
    function isExchangeRole(role) {
      return isFolderNode({ role });
    }

    /*
     * Координатор держит структуру: он стоит за сам воркспейс, и удалять его
     * нельзя ни из панели, ни маршрутом. Правило одно для клиента и сервера:
     * id coordinator или роль со словом «координатор».
     */
    function isCoordinatorNode(node) {
      if (!node || typeof node !== "object") return false;
      const id = String(node.id || "").trim().toLowerCase();
      const role = String(node.role || "").toLowerCase();
      return id === "coordinator" || role.includes("координатор") || role.includes("coordinator");
    }

    /*
     * 0170: карточка координатора есть на канве всегда.
     *
     * Координатор — отправная точка воркспейса, но в палитре его нет: он не
     * узел, который можно забыть. Пока узла нет в файле структуры, панель
     * рисует виртуальную карточку — человек видит, с чего начать, а не пустую
     * канву. Существующий узел не подменяется: virtual=false и тот же объект.
     */
    function coordinatorCard(graph) {
      const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
      const node = nodes.find((item) => item && typeof item === "object" && isCoordinatorNode(item)) || null;
      if (node) return { virtual: false, node };
      return {
        virtual: true,
        node: {
          id: "coordinator",
          role: "координатор",
          brief: "отправная точка воркспейса: план и раздача работы",
        },
        hint: "структура только создана — добавьте узлы",
      };
    }

    /*
     * Модель узла: алиас — это ссылка, а не модель. Панель показывает маршрут,
     * разрешённый службой llm при чтении структуры (modelRoute), и говорит
     * прямо, если модель пропала из каталога или каталог недоступен. Молча
     * подставленной «первой доступной» модели здесь нет.
     */
    function modelRouteView(route) {
      if (!route) return null;
      const alias = String(route.alias || "");
      const provider = String(route.provider || "");
      const model = String(route.model || "");
      const family = String(route.family || "");
      const path = provider || model ? provider + "/" + model : "маршрут не объявлен";
      const status = String(route.status || "unknown");
      const reason = String(route.reason || "");
      if (status === "available") {
        return {
          kind: "available",
          text: alias + " → " + path + (family ? " · семейство " + family : ""),
          hint: "",
        };
      }
      if (status === "missing") {
        return {
          kind: "missing",
          text: alias + " → " + path + " · модель не найдена в каталоге",
          hint: "модель не найдена в каталоге: " + path + (reason ? " (" + reason + ")" : "")
            + ". Откройте сборку и выберите модель из списка или объявите доступную в models — "
            + "подставлять другую молча панель не будет.",
        };
      }
      if (/не объявлен/u.test(reason)) {
        return {
          kind: "unknown",
          text: alias + " (алиас не объявлен в models)",
          hint: "алиас «" + alias + "» не объявлен в models: объявите его в сборке — "
            + "агента по этому узлу запустить не на чем.",
        };
      }
      return {
        kind: "unknown",
        text: alias + " → " + path + " · каталог моделей недоступен",
        hint: "каталог моделей недоступен" + (reason ? ": " + reason : "")
          + ". Проверьте, что плагин LLM загружен, и обновите панель: "
          + "маршрут не подтверждён, и модель не подменяется.",
      };
    }

    /** Маршрут узла для карточки: modelRoute, а для старой ленты — честный алиас. */
    function nodeModelView(node, graph) {
      if (!node || !node.model) return null;
      if (node.modelRoute) return modelRouteView(node.modelRoute);
      const declared = graph && graph.models ? graph.models[node.model] : null;
      return declared
        ? {
          kind: "unknown",
          text: node.model + " → " + declared.provider + "/" + declared.model,
          hint: "маршрут не сверен с каталогом: обновите панель",
        }
        : { kind: "unknown", text: node.model + " (алиас не объявлен в models)", hint: "" };
    }

    /**
     * Что панель запишет как модель: только явный выбор из каталога.
     *
     * Пустые provider/model не превращаются в первую доступную модель, а
     * пропавшая из каталога модель — в соседнюю: это отказ с рецептом.
     */
    function builderModelDraft(form, catalog) {
      const source = form && typeof form === "object" ? form : {};
      const provider = String(source.provider || "").trim();
      const model = String(source.model || "").trim();
      const family = String(source.family || "").trim();
      if (catalog === null || catalog === undefined) {
        return {
          error: {
            message: "список моделей ещё загружается: дождитесь ответа службы llm",
            fix: "Обновите панель и выберите модель из списка.",
          },
        };
      }
      const list = Array.isArray(catalog) ? catalog : [];
      if (!provider || !model) {
        if (list.length === 0) {
          return {
            error: {
              message: "список моделей недоступен: введите provider и model вручную",
              fix: "Служба llm не ответила — каталога нет. Проверьте, что плагин LLM загружен.",
            },
          };
        }
        return {
          error: {
            message: "выберите модель из списка: provider и model не подставляются по умолчанию",
            fix: "Выберите провайдера и модель в списке — панель не берёт первую доступную вместо вашего выбора.",
          },
        };
      }
      const providerInfo = list.find((item) => item && item.id === provider) || null;
      const chosen = providerInfo && Array.isArray(providerInfo.models)
        ? providerInfo.models.find((item) => item && item.id === model) || null
        : null;
      if (list.length > 0 && !chosen) {
        return {
          error: {
            message: "модель не найдена в каталоге: " + provider + "/" + model,
            fix: "Обновите панель и выберите модель из списка — пропавшая модель не заменяется другой.",
          },
        };
      }
      const resolvedFamily = family || (chosen && chosen.family ? String(chosen.family) : "");
      return { provider, model, ...(resolvedFamily ? { family: resolvedFamily } : {}) };
    }

    /**
     * Выбор модели узла для карточки: только явная пара provider+model из живого
     * каталога. Пустой выбор — «выберите модель из списка», пропавшая модель —
     * «модель не найдена в каталоге»; первая модель не подставляется (0050 D3).
     */
    function nodeModelChoice(catalog, provider, model, family) {
      return builderModelDraft({ provider, model, family }, catalog);
    }

    /**
     * Маршрут узла сборки: алиас разворачивается в прямые provider/model/family.
     *
     * В карточке модели стоит явная пара provider+model; узел ссылается на алиас
     * только как на имя этой пары. Сервер пишет прямые поля, поэтому черновик
     * уходит без models{}. Неизвестный алиас не заменяется первой моделью
     * каталога: узел уходит как есть, и сервер скажет, чего не хватает (0061 D1).
     */
    function builderNodeRoute(node, models) {
      const source = node && typeof node === "object" ? node : {};
      const provider = String(source.provider || "").trim();
      const model = String(source.model || "").trim();
      const family = String(source.family || "").trim();
      if (provider || !model) return { provider, model, family };
      const route = models && typeof models === "object" && Object.prototype.hasOwnProperty.call(models, model)
        ? models[model]
        : null;
      if (!route || typeof route !== "object" || Array.isArray(route)) {
        return { provider: "", model, family };
      }
      const nextProvider = String(route.provider || "").trim();
      const nextModel = String(route.model || "").trim();
      const nextFamily = family || String(route.family || "").trim();
      return { provider: nextProvider, model: nextModel, family: nextFamily };
    }

    /**
     * Черновик сборки для /api/check и /api/build: у каждого узла прямые поля.
     *
     * Ключ models{} в тело не попадает — файл структуры его больше не хранит.
     * Пустая модель остаётся пустой: «без модели» — честное состояние узла, а не
     * повод подставить первую объявленную.
     */
    function builderDraft(source) {
      const state = source && typeof source === "object" ? source : {};
      const models = state.models && typeof state.models === "object" && !Array.isArray(state.models) ? state.models : {};
      const nodes = (Array.isArray(state.nodes) ? state.nodes : []).map((node) => {
        const route = builderNodeRoute(node, models);
        return {
          id: node && node.id ? node.id : "",
          ...(node && node.role ? { role: node.role } : {}),
          ...(route.provider ? { provider: route.provider } : {}),
          ...(route.model ? { model: route.model } : {}),
          ...(route.family ? { family: route.family } : {}),
          ...(node && node.brief ? { brief: node.brief } : {}),
          ...(node && node.agentPreset ? { agentPreset: node.agentPreset } : {}),
          ...(node && Array.isArray(node.mustDifferFrom) && node.mustDifferFrom.length > 0
            ? { mustDifferFrom: node.mustDifferFrom }
            : {}),
        };
      });
      const edges = (Array.isArray(state.edges) ? state.edges : []).map((edge) => ({
        from: edge && edge.from,
        to: edge && edge.to,
        kind: edge && edge.kind,
      }));
      return { version: 1, nodes, edges };
    }

    /** One element of the library by its type, or null for an unknown one. */
    function libraryItem(type) {
      return NODE_LIBRARY.find((item) => item.type === type) || null;
    }

    /*
     * Карточки палитры для проверки и панели (задание 0119): роль, brief и
     * спека в prompt. Пресет DSH необязателен: пресеты общие, роль — проектная,
     * и по умолчанию он не выставляется (D2).
     */
    function libraryItems() {
      return NODE_LIBRARY.map((item) => ({
        type: item.type,
        role: item.role === undefined ? null : item.role,
        brief: item.brief || "",
        prompt: String(item.prompt || ""),
        /* Рекомендованная модель — часть карточки: у critic/worker/folder её нет (0126 C4). */
        ...(item.model ? { model: String(item.model) } : {}),
        ...(item.agentPreset ? { agentPreset: item.agentPreset } : {}),
      }));
    }

    /*
     * 0177: виды узлов — реестр палитры. Карточки NODE_LIBRARY — готовые плитки
     * с рекомендованной связью; их число закреплено проверкой 0126 (шесть), и
     * аудитор туда не добавляется. Вид узла отвечает за роль и назначение, и
     * аудитор задач — вид без плитки: он проверяет задание по якорям до приёмки,
     * а его вердикт (audit.json) обязателен для запуска.
     */
    const AUDITOR_KIND = {
      id: "auditor",
      role: "Аудитор задач",
      brief: "проверяет задачу по якорям до приёмки",
    };

    /** Виды узлов палитры: id, роль, назначение. Аудитор задач — среди них. */
    function nodeKinds() {
      return NODE_LIBRARY.map((item) => ({
        id: item.type,
        role: item.role === undefined ? null : item.role,
        brief: item.brief || "",
      })).concat([{ ...AUDITOR_KIND }]);
    }

    /** Тело узла из карточки: тип, роль, brief, спека и необязательный пресет. */
    function libraryNodeDraft(item) {
      if (!item || typeof item !== "object") return null;
      const role = item.role === undefined || item.role === null ? null : String(item.role);
      const prompt = String(item.prompt || "");
      return {
        type: String(item.type || ""),
        ...(role !== null ? { role } : {}),
        ...(item.brief ? { brief: String(item.brief) } : {}),
        ...(prompt ? { prompt } : {}),
        ...(item.agentPreset ? { agentPreset: String(item.agentPreset) } : {}),
      };
    }

    /*
     * Узел из карточки: спека переносится один-в-один, иначе роль в графе есть,
     * а Definition of Done нет (проверка C2 задания 0119).
     */
    function libraryNode(item, id) {
      const draft = libraryNodeDraft(item);
      if (!draft) return null;
      const { type, ...fields } = draft;
      /*
       * Рекомендованная модель — свойство карточки и объявления узла, а не
       * тела POST /api/node: сервер принимает только полный маршрут
       * provider+model, а провайдер выбирает человек в живом каталоге.
       */
      return {
        id: id === undefined || id === null ? "" : String(id),
        ...fields,
        ...(item.model ? { model: String(item.model) } : {}),
      };
    }

    /*
     * Рекомендованная модель карточки → полный маршрут узла (0126 D3).
     *
     * POST /api/node принимает только provider+model: модель без провайдера
     * получает отказ provider-missing. Поэтому провайдера ищем в живом
     * каталоге, и только если он ровно один — рекомендация применяется.
     * Ноль или несколько кандидатов — модель остаётся подсказкой, выбирает
     * человек: угадывать провайдера панель не должна.
     */
    function libraryModelRoute(item, catalog) {
      const model = item && item.model ? String(item.model) : "";
      if (!model) return null;
      const providers = Array.isArray(catalog) ? catalog : [];
      const found = providers.filter((provider) => provider && Array.isArray(provider.models)
        && provider.models.some((row) => row && String(row.id || "") === model));
      if (found.length !== 1) return null;
      const provider = String((found[0] && found[0].id) || "");
      return provider ? { provider, model } : null;
    }

    /*
     * Порядок частей карточки (0126 C2): подпись — НАД плиткой, ниже роль и
     * вид связи словами, затем краткое назначение. Панель собирает карточку
     * этим же списком, поэтому проверка видит ровно тот порядок, что человек.
     */
    function libraryCardParts(item) {
      if (!item || typeof item !== "object") return [];
      return ["label", "tile", "role", "link", "brief"];
    }

    /*
     * Подсказка карточки (0126 C1): роль, назначение, связь словами и первая
     * строка спеки роли. Спека целиком не показывается — подсказка не должна
     * занимать экран; Definition of Done уже в первой строке спеки.
     */
    function libraryHoverText(item) {
      if (!item || typeof item !== "object") return "";
      /*
       * Карточка из __libraryItems несёт роль, назначение и спеку, но не
       * объект link: вид связи берём из объявления NODE_LIBRARY по типу,
       * иначе подсказка молчала бы о связи (0126 C1).
       */
      const card = !item.link && !item.words && item.type ? (libraryItem(item.type) || item) : item;
      const role = item.role === undefined || item.role === null ? "" : String(item.role);
      const link = card.link && card.link.words
        ? String(card.link.words)
        : String(card.words || "связей с агентами нет");
      const lines = ["Роль: " + (role || "папка — не агент")];
      if (item.brief) lines.push("Назначение: " + String(item.brief));
      lines.push("Связь: " + link);
      if (item.model) {
        lines.push("Рекомендованная модель: " + String(item.model)
          + " — провайдера выберите в живом каталоге при сохранении.");
      }
      const firstSpec = String(item.prompt || "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)[0] || "";
      if (firstSpec) lines.push(firstSpec);
      lines.push("Перетащите на схему или нажмите Enter, чтобы поставить с клавиатуры.");
      return lines.join("\n");
    }

    /** Счётчик палитры по числу элементов: «1 элемент», «2 элемента», «6 элементов». */
    function libraryCountLabel(count) {
      const value = Number.isFinite(Number(count)) ? Math.abs(Math.trunc(Number(count))) : 0;
      const tail = value % 100;
      const last = value % 10;
      let word = "элементов";
      if (tail < 11 || tail > 14) {
        if (last === 1) word = "элемент";
        else if (last >= 2 && last <= 4) word = "элемента";
      }
      return value + " " + word;
    }

    /*
     * Счётчик элементов (0143): «N элементов» — часть РАЗВЁРНУТОЙ палитры.
     * Свёрнутый корешок — полоса 44 px без счётчика: подпись там не влезает и
     * не нужна, её роль играют три иконки. Функция одна для панели и проверки:
     * свёрнуто → false, развёрнуто → true.
     */
    function paletteCounterVisible(expanded) {
      return Boolean(expanded);
    }

    /**
     * The default link of a dropped card, in words the caller can show:
     * a critic reports to the coordinator, a worker is delegated from it, and
     * the shared folder is not connected to agents at all.
     */
    function libraryEdge(type, id, coordinatorPresent) {
      const item = libraryItem(type);
      if (!item || !item.link || !id || !coordinatorPresent) return null;
      return {
        from: item.link.from === "node" ? id : item.link.from,
        to: item.link.to === "node" ? id : item.link.to,
        kind: item.link.kind,
      };
    }

    /** Where a card taken from the library lands by default: under the last row. */
    function libraryStartPoint(layout) {
      const nodes = (layout && Array.isArray(layout.nodes)) ? layout.nodes : [];
      let bottom = -1;
      for (const node of nodes) {
        if (Number.isFinite(node.y)) bottom = Math.max(bottom, node.y + (Number(node.h) || 62));
      }
      return { x: 16, y: bottom >= 0 ? bottom + 24 : 16 };
    }

    function roleColor(role) {
      const value = String(role || "");
      let hash = 0;
      for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) % 100000;
      return ROLE_COLORS[hash % ROLE_COLORS.length];
    }

    /* Ответ об ошибке несёт и рецепт: сервер кладёт его в fix. */
    function fetchJson(path, options) {
      return fetch(BASE + path, Object.assign({ headers: { Accept: "application/json" } }, options || {})).then((response) =>
        response.json().then((body) => {
          if (!response.ok) {
            const failure = new Error((body && body.error) || ("HTTP " + response.status));
            if (body && body.fix) failure.fix = body.fix;
            /* Похожие метки реестра: отказ 400 объясняет, что человек имел в виду. */
            if (body && Array.isArray(body.similar)) failure.similar = body.similar;
            throw failure;
          }
          return body;
        }),
      ).catch((failure) => {
        if (failure && failure.fix) throw failure;
        const wrapped = new Error(failure && failure.message ? failure.message : String(failure));
        wrapped.fix = "Нажмите «Обновить». Если повторяется — проверьте, что плагин dsh-project-graph загружен и сервер отвечает.";
        throw wrapped;
      });
    }

    /*
     * Подпись версии структуры (задание 0105): «структура X · доступна Y»,
     * когда сборка отстала от релиза, и «структура X · актуальна» иначе. Одна
     * функция на панель и проверку, чтобы текст не разъезжался.
     */
    function releaseLabel(status) {
      const value = status && typeof status === "object" ? status : {};
      const current = value.current ? String(value.current) : "неизвестно";
      if (value.outdated && value.latest) return "структура " + current + " · доступна " + String(value.latest);
      return "структура " + current + " · актуальна";
    }

    /*
     * Действие карточки версии (задание 0107): чем обновляется сборка. Пакет
     * ставится из релиза, связанный каталог — fast-forward-ом из его
     * репозитория, поэтому подписи разные; актуальной сборке действие не нужно,
     * а причина 0105 («обновите репозиторий») больше не тупик — она стала
     * подписью кнопки. Одна функция на карточку и проверку, чтобы текст не
     * разъезжался.
     */
    function releaseAction(status) {
      const value = status && typeof status === "object" ? status : {};
      if (value.outdated !== true) return { enabled: false };
      if (value.mode === "link") return { enabled: true, label: "Обновить из репозитория" };
      return { enabled: true, label: "Обновить" };
    }

    const S = {
      root: { display: "flex", flexDirection: "column", gap: "10px", height: "100%", minHeight: 0, fontSize: "13px", color: T.text },
      bar: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      title: { fontSize: "15px", fontWeight: 600 },
      chip: { padding: "2px 8px", borderRadius: "999px", background: T.bg2, color: T.secondary, fontSize: "11px" },
      button: { padding: "3px 10px", borderRadius: "6px", border: "1px solid " + T.border1, background: T.bg1, color: T.text, cursor: "pointer", fontSize: "12px" },
      buttonActive: { padding: "3px 10px", borderRadius: "6px", border: "1px solid " + T.link, background: T.bg2, color: T.text, cursor: "pointer", fontSize: "12px" },
      buttonPrimary: { padding: "5px 14px", borderRadius: "6px", border: "1px solid " + T.link, background: T.link, color: "#fff", cursor: "pointer", fontSize: "13px", fontWeight: 600 },
      error: { padding: "8px 10px", borderRadius: "8px", border: "1px solid " + T.danger, color: T.danger, whiteSpace: "pre-wrap" },
      errorTitle: { fontWeight: 600, color: T.danger, marginBottom: "2px" },
      fix: { marginTop: "3px", color: T.text, fontSize: "12px" },
      info: { padding: "8px 10px", borderRadius: "8px", border: "1px solid " + T.border1, background: T.bg1, color: T.secondary, fontSize: "12px" },
      canvas: { position: "relative", border: "1px solid " + T.border1, borderRadius: "0 0 10px 10px", background: T.bg1, overflow: "auto", flex: "1 1 auto", minHeight: "220px", borderTop: 0 },
      canvasPanel: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" },
      canvasHead: { display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", border: "1px solid " + T.border1, borderBottom: 0, borderRadius: "10px 10px 0 0", background: T.bg1 },
      panel: { display: "flex", gap: "12px", alignItems: "flex-start", flexWrap: "wrap" },
      list: { margin: 0, paddingLeft: "18px", color: T.secondary, fontSize: "12px", lineHeight: "1.5" },
      steps: { margin: 0, paddingLeft: "20px", color: T.secondary, fontSize: "12px", lineHeight: "1.6" },
      card: { border: "1px solid " + T.border1, borderRadius: "8px", padding: "8px 10px", background: T.bg1, minWidth: "240px", maxWidth: "520px" },
      hint: { color: T.tertiary, fontSize: "12px", whiteSpace: "pre-wrap" },
      mono: { fontFamily: T.mono, fontSize: "11px", color: T.tertiary },
      onboarding: { display: "flex", flexDirection: "column", gap: "10px", border: "1px solid " + T.border1, borderRadius: "10px", padding: "12px 14px", background: T.bg1, overflow: "auto" },
      pre: { margin: 0, padding: "8px 10px", borderRadius: "8px", background: T.bg2, color: T.text, fontFamily: T.mono, fontSize: "11px", whiteSpace: "pre", overflow: "auto", maxHeight: "420px" },
      legend: { display: "flex", gap: "14px", flexWrap: "wrap", color: T.tertiary, fontSize: "11px" },
      legendItem: { display: "inline-flex", alignItems: "center", gap: "4px" },
      issueList: { margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "6px" },
      issue: { color: T.text, whiteSpace: "pre-wrap" },
      issueMeta: { fontFamily: T.mono, fontSize: "10px", color: T.tertiary },
      row: { display: "flex", gap: "6px", alignItems: "baseline", flexWrap: "wrap" },
      label: { color: T.tertiary, fontSize: "11px", minWidth: "72px" },
      value: { fontSize: "12px", color: T.text },
      linkList: { margin: 0, paddingLeft: "16px", color: T.secondary, fontSize: "12px", lineHeight: "1.5" },
      input: { padding: "3px 6px", border: "1px solid " + T.border2, borderRadius: "6px", background: T.bg2, color: T.text, fontSize: "12px" },
      select: { padding: "3px 6px", border: "1px solid " + T.border2, borderRadius: "6px", background: T.bg2, color: T.text, fontSize: "12px" },
      /* Палитра — колонка слева от канвы; в свёрнутом виде узкая полоса. */
      library: { flex: "0 0 250px", width: "250px", display: "flex", flexDirection: "column", gap: "8px", border: "1px solid " + T.border1, borderRadius: "10px", background: T.bg1, padding: "8px", minHeight: 0, overflow: "auto" },
      /* Корешок: 44 px, фон и тень как у развёрнутой панели, скругление 16 (макет §3.2). */
      librarySpine: {
        flex: "0 0 44px", width: "44px", display: "flex", flexDirection: "column",
        alignItems: "center", gap: "8px", padding: "8px 6px", position: "relative",
        boxSizing: "border-box", borderRadius: "16px", overflow: "hidden",
        background: "var(--dsw-alias-bg-base, #fff)", boxShadow: "0 8px 22px rgb(20 20 45 / 6%)",
      },
      /* Обрез страниц: 3 px справа во всю высоту — «за полосой целая книга». */
      pageEdge: {
        position: "absolute", right: 0, top: 0, bottom: 0, width: "3px", borderRadius: "2px",
        background: "linear-gradient(90deg, transparent, var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.18)))",
        pointerEvents: "none",
      },
      spineButton: {
        display: "flex", alignItems: "center", justifyContent: "center", flex: "1 1 auto",
        width: "100%", minHeight: 0, padding: "10px 0", border: 0, borderRadius: "12px",
        background: "transparent", color: T.secondary, cursor: "pointer", font: "inherit",
        transition: "background 120ms ease, color 120ms ease",
      },
      /* Надпись корешка: снизу вверх (vertical-rl + rotate(180deg)), обрезка многоточием. */
      spineText: {
        writingMode: "vertical-rl", transform: "rotate(180deg)", textOrientation: "mixed",
        textTransform: "uppercase", fontSize: "11px", fontWeight: 600, letterSpacing: "0.12em",
        lineHeight: 1.2, textAlign: "center", maxHeight: "100%", overflow: "hidden",
        textOverflow: "ellipsis", whiteSpace: "nowrap", color: "inherit",
      },
      spineIcon: {
        position: "relative", width: "32px", height: "32px", padding: 0, borderRadius: "8px",
        border: "1px solid " + T.border2, background: "#efeff3", color: T.text, fontSize: "14px",
        lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "grab", overflow: "hidden",
      },
      spineIconFocus: {
        borderColor: T.link, boxShadow: "0 0 0 3px rgb(65 118 230 / 14%)",
        outline: "2px solid " + T.link, outlineOffset: "-3px",
      },
      libraryItem: { display: "flex", flexDirection: "column", gap: "1px", padding: "7px 8px", borderRadius: "10px", border: "1px solid " + T.border2, background: T.bg2, color: T.text, cursor: "grab", textAlign: "left", fontSize: "12px", width: "100%" },
      libraryIcon: { width: "34px", height: "34px", borderRadius: "8px", border: "1px solid " + T.border2, background: T.bg2, color: T.text, cursor: "grab", fontSize: "15px" },
      editorRow: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
      /* Меню по правому клику: светлая панель, цвета только из токенов T. */
      menu: {
        position: "fixed", zIndex: 46, width: "272px", padding: "6px",
        borderRadius: "10px", border: "1px solid " + T.border1,
        background: "var(--dsw-alias-bg-base, #ffffff)", color: T.text,
        boxShadow: "0 12px 32px rgba(0,0,0,0.20)", display: "flex", flexDirection: "column", gap: "2px",
      },
      menuItem: {
        display: "flex", alignItems: "center", width: "100%", padding: "10px 12px",
        border: "1px solid transparent", borderRadius: "8px", background: "transparent",
        color: T.text, cursor: "pointer", fontSize: "13px", textAlign: "left",
      },
      /* Подложка и окно: по центру, светлая тема панели, не темнее фона. */
      modalBackdrop: {
        position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center",
        padding: "56px 24px 16px", background: "rgba(20,22,26,0.38)", boxSizing: "border-box",
      },
      modal: {
        width: "min(640px, calc(100vw - 32px))", maxHeight: "calc(100vh - 88px)", display: "flex",
        flexDirection: "column", minHeight: 0, background: "var(--dsw-alias-bg-base, #ffffff)", color: T.text,
        border: "1px solid " + T.border1, borderRadius: "12px", boxShadow: "0 18px 48px rgba(0,0,0,0.24)", overflow: "hidden",
      },
      modalInfo: { width: "min(600px, calc(100vw - 32px))" },
      /* Окно узла (0129): фиксированный размер; прокручивается только тело вкладки. */
      modalNode: {
        width: "min(560px, calc(100vw - 32px))",
        height: "min(520px, calc(100vh - 88px))",
        maxHeight: "none",
      },
      modalHeader: {
        display: "flex", alignItems: "center", gap: "10px", padding: "14px 18px",
        borderBottom: "1px solid " + T.border1, background: T.bg1,
      },
      modalTitle: { fontWeight: 600, fontSize: "15px", color: T.text, flex: "1 1 auto", minWidth: 0 },
      modalBody: {
        padding: "14px 18px", overflowY: "auto", display: "flex", flexDirection: "column",
        gap: "10px", minHeight: 0,
      },
      modalFooter: {
        display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", padding: "12px 18px",
        borderTop: "1px solid " + T.border1, background: T.bg1,
      },
      modalClose: {
        width: "36px", height: "36px", flex: "0 0 36px", display: "inline-flex", alignItems: "center",
        justifyContent: "center", padding: 0, border: "1px solid " + T.border1, borderRadius: "8px",
        background: "var(--dsw-alias-bg-base, #ffffff)", color: T.text, cursor: "pointer", fontSize: "20px", lineHeight: "1",
      },
      modalRow: { display: "flex", gap: "10px", alignItems: "baseline", flexWrap: "wrap" },
      modalLabel: { color: T.tertiary, fontSize: "12px", minWidth: "96px" },
      modalValue: { color: T.text, fontSize: "14px", whiteSpace: "pre-wrap" },
      /* Окно узла (0122): три вкладки одной формы; подпись вкладки — не действие. */
      nodeTabs: { display: "flex", alignItems: "center", gap: "2px", flex: "0 0 auto" },
      nodeTab: {
        padding: "8px 12px", border: "1px solid transparent", borderBottom: "2px solid transparent",
        background: "transparent", color: T.secondary, cursor: "pointer", fontSize: "13px",
      },
      nodeTabActive: { color: T.text, fontWeight: 600, borderBottomColor: T.link },
      nodeTabNote: { color: T.tertiary, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em" },
      /* Плашка обязанностей — над канвой: невыполненный долг виден до схемы. */
      banner: {
        display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
        padding: "8px 10px", borderRadius: "8px", border: "1px solid " + T.warn,
        background: T.bg1, color: T.text, fontSize: "12px",
      },
      bannerText: { flex: "1 1 auto", minWidth: 0, fontWeight: 600, color: T.text, whiteSpace: "pre-wrap" },
    };

    function edgeStroke(kind) {
      if (kind === "delegate") return T.link;
      if (kind === "review") return T.warn;
      if (kind === "report") return T.secondary;
      return T.border2;
    }

    function edgeDash(kind) {
      if (kind === "review") return "5 4";
      if (kind === "peer") return "2 4";
      if (kind === "report") return "1 4";
      return null;
    }

    function markerFor(kind) {
      if (kind === "delegate") return "url(#pg-arrow-delegate)";
      if (kind === "review") return "url(#pg-arrow-review)";
      if (kind === "report") return "url(#pg-arrow-report)";
      return null;
    }

    function renderDefs() {
      return h(
        "defs",
        null,
        h("marker", { id: "pg-arrow-delegate", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
          h("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: T.link })),
        h("marker", { id: "pg-arrow-review", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
          h("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: T.warn })),
        h("marker", { id: "pg-arrow-report", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
          h("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: T.secondary })),
      );
    }

    /* ===== Портал «Выход вне» ===== */
    /*
     * Портал стоит за пунктирной границей воркспейса: карточка 236 px шириной,
     * 48 px от границы. Внутри — по строке на адресата: тип связи словом,
     * счётчики в обе стороны и крайние даты обеих сторон. Больше трёх адресатов
     * на канву не влезают: остальные уходят в «ещё N» и остаются в списке под
     * схемой. Здесь только вид и счёт геометрии: данные приходят с /api/exchange,
     * тексты сообщений не читаются нигде.
     */
    const PORTAL_W = 236;
    const PORTAL_GAP = 48;
    /* Просвет до пунктира больше не константа: его задаёт барьер (OUTSIDE_MIN). */
    const PORTAL_ROW_H = 60;
    const PORTAL_ROWS = 3;
    /* Лента порталов: расстояние между выходами по вертикали. */
    const PORTAL_STACK_GAP = 26;

    /*
     * Барьер «воркспейс | вне» (макет §4). outside — просвет от крайней карточки
     * до пунктира: 20 — сегодняшний вид, 360 — предел. Сетка 8 px отсчитана от
     * минимума, иначе сам минимум недостижим: округление от нуля давало 24.
     * Shift во время переноса — 1 px, без сетки.
     */
    const OUTSIDE_MIN = 20;
    const OUTSIDE_MAX = 360;
    const OUTSIDE_STEP = 8;

    /* Вторая колонка порталов: 236 + 16 (макет §4.2, §4.7). */
    const PORTAL_COLUMN_GUTTER = 16;
    const TWO_COLUMNS_NEED = 536;
    const TWO_COLUMNS_HYSTERESIS = 24;

    /**
     * Зажим просвета: 20…360, ближайшая точка сетки step от минимума.
     *
     * Половина шага округляется вниз (24 → 20, 25 → 28) — так минимум остаётся
     * достижимым. Два значения не округляются: предел 360 (сетка кончается на
     * 356, а End и перетаскивание дают крайнюю точку) и уже сохранённое число,
     * кратное шагу (120 = 15 × 8): иначе после каждой перезагрузки барьер
     * уезжал бы на 4 px. step = 1 (Shift) — точное значение без сетки.
     */
    function clampOutside(value, step) {
      const raw = Number(value);
      if (!Number.isFinite(raw)) return OUTSIDE_MIN;
      if (raw <= OUTSIDE_MIN) return OUTSIDE_MIN;
      if (raw >= OUTSIDE_MAX) return OUTSIDE_MAX;
      const grid = Number(step) > 0 ? Number(step) : OUTSIDE_STEP;
      if (grid <= 1) return Math.round(raw);
      /* Первый шаг от минимума: всё, что ближе к 20, чем к 28, — 20. */
      if (raw < OUTSIDE_MIN + grid) {
        return raw <= OUTSIDE_MIN + grid / 2 ? OUTSIDE_MIN : OUTSIDE_MIN + grid;
      }
      if (raw % grid === 0) return raw;
      const whole = Math.ceil((raw - OUTSIDE_MIN) / grid - 0.5);
      const snapped = OUTSIDE_MIN + whole * grid;
      return Math.min(OUTSIDE_MAX, Math.max(OUTSIDE_MIN, snapped));
    }

    /**
     * Число колонок порталов: вторая — только при N ≥ 2 папках обмена и видимой
     * части канвы ≥ 536 px; выключается ниже 512 px (гистерезис 24), поэтому
     * окно, суженное до 512…535, не «мигает» между колонками.
     */
    function portalColumns(folderCount, width, current) {
      const count = Number(folderCount) || 0;
      if (count < 2) return 1;
      const visible = Number(width);
      if (!Number.isFinite(visible)) return 1;
      const need = Number(current) === 2 ? TWO_COLUMNS_NEED - TWO_COLUMNS_HYSTERESIS : TWO_COLUMNS_NEED;
      return visible >= need ? 2 : 1;
    }

    /* Ширина зоны «вне»: 48 до первой колонки + 236 на колонку + 16 на зазор. */
    function outsideZoneWidth(columns) {
      const count = Math.max(1, Number(columns) || 1);
      return PORTAL_GAP + count * PORTAL_W + (count - 1) * PORTAL_COLUMN_GUTTER;
    }

    /*
     * Состояние панели в браузере: один ключ и одно место чтения/записи.
     * Здесь только место на экране — свёрнута ли палитра (на браузер) и какой
     * просвет у барьера (на корень воркспейса). Раскладка узлов живёт в
     * structure/*.json, как и раньше: панель не пишет её в браузер.
     */
    const UI_STORAGE_KEY = "dsh.project-graph.ui.v1";
    const UI_VERSION = 1;

    /**
     * Разбор сохранённого состояния. Битый JSON, чужой v и отсутствие корня —
     * умолчания (развёрнуто, просвет 20): панель не показывает ошибку и не
     * падает, а человек видит привычный вид. outside зажимается clampOutside.
     */
    function parseUiState(raw, root) {
      const fallback = { v: UI_VERSION, libraryOpen: true, outside: OUTSIDE_MIN, roots: {} };
      let parsed = null;
      if (typeof raw === "string") {
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          parsed = null;
        }
      } else if (raw && typeof raw === "object") {
        parsed = raw;
      }
      if (!parsed || typeof parsed !== "object" || Number(parsed.v) !== UI_VERSION) return fallback;
      const libraryOpen = typeof parsed.libraryOpen === "boolean" ? parsed.libraryOpen : true;
      const stored = parsed.outside && typeof parsed.outside === "object" ? parsed.outside : {};
      const roots = {};
      for (const key of Object.keys(stored)) {
        if (!Number.isFinite(Number(stored[key]))) continue;
        roots[key] = clampOutside(stored[key]);
      }
      const name = typeof root === "string" ? root : "";
      const outside = name && Object.prototype.hasOwnProperty.call(roots, name) ? roots[name] : OUTSIDE_MIN;
      return { v: UI_VERSION, libraryOpen, outside, roots };
    }

    const uiStore = {
      key: UI_STORAGE_KEY,
      read(root) { return parseUiState(this.readRaw(), root); },
      /* Недоступное хранилище (приватный режим, iframe) — это null, а не ошибка. */
      readRaw() {
        try {
          if (typeof window === "undefined" || !window || !window.localStorage) return null;
          return window.localStorage.getItem(UI_STORAGE_KEY);
        } catch (error) {
          return null;
        }
      },
      write(state) {
        try {
          if (typeof window === "undefined" || !window || !window.localStorage) return false;
          window.localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({
            v: UI_VERSION,
            libraryOpen: state && state.libraryOpen !== false,
            outside: state && state.outside && typeof state.outside === "object" ? state.outside : {},
          }));
          return true;
        } catch (error) {
          return false;
        }
      },
      /* Запись одного поля: остальные корни и libraryOpen сохраняются. */
      save(root, patch) {
        const name = typeof root === "string" ? root : "";
        const current = this.read(name);
        const next = patch && typeof patch === "object" ? patch : {};
        const roots = { ...(current.roots || {}) };
        if (name && Number.isFinite(Number(next.outside))) roots[name] = clampOutside(next.outside);
        return this.write({
          libraryOpen: typeof next.libraryOpen === "boolean" ? next.libraryOpen : current.libraryOpen,
          outside: roots,
        });
      },
    };

    /* «1 исходящее», «2 исходящих» — счётчик и в строке портала, и в aria-label. */
    function portalCount(count, one, many) {
      const value = Number(count) || 0;
      return value + " " + (value === 1 ? one : many);
    }

    /* Строки адресатов: не больше трёх, остальные — «ещё N» и список под схемой. */
    function portalRows(links, limit = PORTAL_ROWS) {
      const list = (Array.isArray(links) ? links : []).filter((link) => link && link.counterpart);
      const cap = Math.max(1, Number(limit) || PORTAL_ROWS);
      return { rows: list.slice(0, cap), more: Math.max(0, list.length - cap), total: list.length };
    }

    /*
     * Наконечник линии показывает последний по времени факт: входящее — у графа,
     * исходящее — у портала. При равном времени честнее назвать входящее: оно
     * идёт к нам, а не от нас, и «последнее» не превращается в догадку.
     */
    function portalLatest(links) {
      let latest = null;
      const note = (at, direction, link) => {
        const moment = Number(at) || 0;
        if (moment <= 0) return;
        if (latest && moment <= latest.at) return;
        latest = { at: moment, direction, counterpart: link.counterpart, kind: link.kind };
      };
      for (const link of Array.isArray(links) ? links : []) {
        if (!link || !link.counterpart) continue;
        note(link.lastIncoming, "incoming", link);
        note(link.lastOutgoing, "outgoing", link);
      }
      return latest;
    }

    /* Линия идёт от узла self; без объявленного self — от границы воркспейса. */
    function portalStart(selfBox, borderX, portalHeight) {
      if (selfBox && Number.isFinite(selfBox.x) && Number.isFinite(selfBox.y)) {
        return {
          x: selfBox.x + selfBox.w,
          y: selfBox.y + selfBox.h / 2,
          from: selfBox.id || null,
          box: selfBox,
        };
      }
      const edge = Math.max(24, (Number(portalHeight) || 0) - 24);
      return { x: borderX, y: Math.min(28, edge), from: null, box: null };
    }

    /*
     * Связь с внешней папкой — один прямой отрезок, как у связей узел → узел.
     * Начало — правый край карточки (без объявленного self — граница
     * воркспейса), конец — край портала на высоте входа. Коридоров нет:
     * линия идёт по кратчайшему пути и не «обходит» соседние карточки.
     */
    function __portalLineD(start, portalX, entryY) {
      const source = start && typeof start === "object" ? start : {};
      const box = source.box && typeof source.box === "object" ? source.box : source;
      const hasBox = Number.isFinite(box.x) && Number.isFinite(box.y)
        && Number.isFinite(box.w) && Number.isFinite(box.h);
      /* Узел без объявленного self соединяется с порталом от границы. */
      const x1 = hasBox ? box.x + box.w : (Number(source.x) || 0);
      const y1 = hasBox ? box.y + box.h / 2 : (Number(source.y) || 0);
      const x2 = Number(portalX) || 0;
      const y2 = Number(entryY) || 0;
      return "M " + x1 + " " + y1 + " L " + x2 + " " + y2;
    }

    /* Перенос причины и рецепта по словам: SVG-текст сам строк не переносит. */
    function wrapWords(text, perLine = 40, maxLines = 4) {
      const words = String(text || "").split(/\s+/u).filter(Boolean);
      const lines = [];
      /*
       * Путь ящика — одно длинное «слово» без пробелов: без разрыва по символам
       * он вылезал за рамку портала и наезжал на соседнюю карточку.
       */
      const breakLong = (word) => {
        let rest = word;
        while (rest.length > perLine) {
          lines.push(rest.slice(0, perLine));
          rest = rest.slice(perLine);
        }
        return rest;
      };
      let line = "";
      for (const word of words) {
        if (word.length > perLine) {
          if (line) { lines.push(line); line = ""; }
          line = breakLong(word);
          continue;
        }
        if (!line) { line = word; continue; }
        if ((line + " " + word).length <= perLine) line += " " + word;
        else { lines.push(line); line = word; }
      }
      if (line) lines.push(line);
      return lines.length > 0 ? lines.slice(0, Math.max(1, maxLines)) : [""];
    }

    /* Минимальный отступ поповера от края видимой области. */
    const POPOVER_MARGIN = 8;

    /*
     * Безопасная зона под кнопками окна DSH: сворачивание, разворот и закрытие
     * живут в правом верхнем углу окна. Поповер редактора не должен заезжать
     * под них — иначе кнопки «Сохранить/Отмена» перекрыты чужими кнопками.
     * Зона задана в пикселях окна и не зависит от канвы.
     */
    const POPOVER_SAFE_TOP = 56;
    const POPOVER_SAFE_RIGHT = 120;

    /* Размер видимой области: {width,height}, {innerWidth,innerHeight} и {w,h}. */
    function viewportSize(viewport) {
      const source = viewport && typeof viewport === "object" ? viewport : {};
      const width = Number(source.width ?? source.innerWidth ?? source.w ?? source.right ?? 0);
      const height = Number(source.height ?? source.innerHeight ?? source.h ?? source.bottom ?? 0);
      return {
        width: Number.isFinite(width) && width > 0 ? width : 0,
        height: Number.isFinite(height) && height > 0 ? height : 0,
      };
    }

    /*
     * clampPopover: удерживает поповер внутри видимой области с отступом 8 px и
     * вне безопасной зоны под кнопками окна DSH (сверху справа). Панель настройки
     * узла, созданного из палитры, раньше уходила за край поля — кнопки
     * «Сохранить/Отмена» оказывались вне экрана, а в правом верхнем углу поповер
     * прятался под кнопками сворачивания и закрытия окна. Левый верхний угол
     * всегда ниже зоны кнопок, а правый край не заезжает в неё. Функция чистая,
     * поэтому её границы проверяются без браузера.
     */
    function clampPopover(left, top, width, height, viewport) {
      const view = viewportSize(viewport);
      const boxWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
      const boxHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
      const minTop = Math.max(POPOVER_MARGIN, POPOVER_SAFE_TOP);
      const minLeft = POPOVER_MARGIN;
      const maxLeft = Math.max(minLeft, view.width - boxWidth - Math.max(POPOVER_MARGIN, POPOVER_SAFE_RIGHT));
      const maxTop = Math.max(minTop, view.height - boxHeight - POPOVER_MARGIN);
      const wantedLeft = Number.isFinite(left) ? left : minLeft;
      const wantedTop = Number.isFinite(top) ? top : minTop;
      return {
        left: Math.max(minLeft, Math.min(wantedLeft, maxLeft)),
        top: Math.max(minTop, Math.min(wantedTop, maxTop)),
      };
    }

    /*
     * «Изменено» — сравнение значений с моментом открытия окна, а не факт
     * нажатия клавиши: вернули прежнее значение — диалога не будет.
     */
    const EDITOR_COMPARE_FIELDS = ["role", "provider", "model", "family", "brief", "prompt", "at", "withSchedule", "boxPath", "boxRoot", "participants", "contract", "orchestrator"];
    const EDITOR_FIELD_LABELS = {
      role: "роль", provider: "провайдер", model: "модель", family: "семейство", brief: "назначение",
      prompt: "спека",
      at: "расписание", withSchedule: "расписание",
      boxPath: "ящик", boxRoot: "корень ящика", participants: "участники",
      contract: "контракт", orchestrator: "оркестратор",
    };

    function editorDraftChanged(draft, baseline) {
      if (!draft || !baseline) return false;
      return EDITOR_COMPARE_FIELDS.some((field) =>
        JSON.stringify(draft[field] === undefined ? null : draft[field])
        !== JSON.stringify(baseline[field] === undefined ? null : baseline[field]));
    }

    function changedEditorFields(draft, baseline) {
      if (!draft || !baseline) return [];
      const labels = [];
      for (const field of EDITOR_COMPARE_FIELDS) {
        if (JSON.stringify(draft[field] === undefined ? null : draft[field])
          !== JSON.stringify(baseline[field] === undefined ? null : baseline[field])) {
          const label = EDITOR_FIELD_LABELS[field] || field;
          if (!labels.includes(label)) labels.push(label);
        }
      }
      return labels;
    }

    /*
     * Копия диалога крестика — чистая функция, чтобы подписи проверялись без DOM.
     * Папку можно не терять: «Да» записывает её тем же запросом, что основная
     * кнопка, «Нет» закрывает без записи. У узла запись живёт в отдельной кнопке
     * редактора, поэтому там остаётся прежнее предупреждение о потере правок.
     */
    function closeConfirmView(target) {
      if (target === "folder") {
        return {
          title: "Сохранить изменения?",
          text: "Сохранить изменения?",
          fallback: "Правки не записаны.",
          save: "Да",
          discard: "Нет",
          keep: "",
        };
      }
      return {
        title: "Закрыть без сохранения?",
        text: "Изменения не сохранятся. Закрыть без сохранения?",
        fallback: "Поля изменены — при закрытии правки будут потеряны.",
        save: "",
        discard: "Закрыть без сохранения",
        keep: "Продолжить редактирование",
      };
    }

    /*
     * Пустое состояние портала: причина и рецепт. Портал не исчезает — исчезнувший
     * выход читался бы как «проект замкнут», а это было бы неправдой.
     */
    function portalEmptyLines(data) {
      const reason = (text) => wrapWords(text, 40, 4);
      const fix = (text) => wrapWords(text, 40, 2);
      if (!data) {
        /* Ответ ещё не пришёл: это не «обмена нет», а «ещё не прочитано». */
        return {
          title: "читаю факты обмена",
          reason: reason("панель спрашивает /api/exchange"),
          fix: fix("Если это длится — нажмите «Обновить»."),
        };
      }
      if (data.failed) {
        return {
          title: "обмена нет",
          reason: reason("факты обмена прочитать не удалось"),
          fix: fix("Проверьте папку обмена и нажмите «Перечитать факты»."),
        };
      }
      if (!data.label) {
        return {
          title: "обмена нет",
          reason: reason(data.reason || "не объявлено, какое имя принадлежит этому воркспейсу"),
          fix: fix("Задайте exchange.me или participants в cordis.patch.yml."),
        };
      }
      return {
        title: "обмена нет",
        reason: reason("фактов обмена не найдено: папка coordination рядом с воркспейсом не найдена или exchange не задан"),
        fix: fix("Задайте exchange в cordis.patch.yml."),
      };
    }

    /* Высота портала: заголовок, строки адресатов или причина с рецептом, подвал. */
    function portalFrameHeight(rows, empty) {
      if (rows.total === 0) return 70 + (empty.reason.length + empty.fix.length) * 12;
      return 24 + rows.rows.length * PORTAL_ROW_H + (rows.more > 0 ? 47 : 33);
    }

    /*
     * Папки обмена из ответа /api/exchange: по порталу на папку. Пустой список
     * означает структуру без объявленных папок — тогда остаётся прежний
     * единственный портал (совместимость со старыми структурами).
     */
    function exchangeFolders(data) {
      if (!data || data.failed === true) return [];
      return (Array.isArray(data.folders) ? data.folders : []).filter((folder) => folder && typeof folder === "object");
    }

    /* Состояние папки словами (docs/exchange-format.md §8): английский код — не для человека. */
    function folderStateWord(state) {
      if (state === "portal") return "портал";
      if (state === "archive") return "архив";
      return "черновик";
    }

    /*
     * Внешняя сторона папки — её участники без нас самих. Метка нашего
     * воркспейса приходит в ответе полем label, поэтому «вне» не выдумывается.
     */
    function folderSides(folder, data) {
      const list = (Array.isArray(folder && folder.participants) ? folder.participants : [])
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim());
      const me = data && typeof data.label === "string" ? data.label : "";
      /* Пусто означает «внешней стороны ещё нет» — так и сказано на карточке. */
      return me ? list.filter((item) => item !== me) : list;
    }

    /*
     * Действие «Принять папку» (задание 0047). До него accept был только в API:
     * приглашённая сторона видела приглашение, но нажать было нечего. Действие
     * показывается ровно той стороне, которая папку ещё не приняла — состояние
     * читается из /api/exchange (folder.states[своя метка]): invited значит
     * «квитанции accepted ещё нет», accepted — «папка принята», disconnected —
     * «сторона вышла, нужно новое приглашение». Своя метка берётся из
     * folder.self.label (задание 0030) или из label ответа: метку панель не
     * выдумывает. Функция чистая: ничего не читает и не пишет.
     */
    function folderAcceptAction(folder, data) {
      if (!folder || typeof folder !== "object" || !folder.id) return null;
      /* Сломанная папка не даёт действия: сначала должен прочитаться ящик. */
      if (folder.error) return null;
      const info = data && typeof data === "object" ? data : {};
      const self = folder.self && typeof folder.self === "object" ? folder.self : null;
      const me = [self && self.label, info.label]
        .find((value) => typeof value === "string" && value.trim());
      if (!me) return null;
      const mine = me.trim();
      const participants = (Array.isArray(folder.participants) ? folder.participants : [])
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim());
      /* Папка без нас в участниках — не наша сторона: принимать нечего. */
      if (participants.length > 0 && !participants.includes(mine)) return null;
      const states = folder.states && typeof folder.states === "object" ? folder.states : {};
      const state = typeof states[mine] === "string" ? states[mine] : "";
      if (state !== "invited") return null;
      return {
        id: folder.id,
        action: "accept",
        label: "Принять папку",
        state,
        side: mine,
      };
    }

    /* Адрес действия: root и id папки — в запросе, кто нажал (session) — в теле POST. */
    function folderAcceptPath(root, id) {
      return "/api/folder?action=accept&root=" + encodeURIComponent(root || "")
        + "&id=" + encodeURIComponent(id || "");
    }

    /*
     * Чем заменить кнопку, когда действие не нужно: принятая папка говорит
     * «папка принята», отключённая — что для возврата нужно новое приглашение.
     * Пустая строка означает «сказать нечего»: мы не сторона или папка не
     * прочиталась. Функция чистая, проверяется без DOM.
     */
    function folderAcceptNote(folder, data) {
      if (!folder || typeof folder !== "object" || !folder.id || folder.error) return "";
      const info = data && typeof data === "object" ? data : {};
      const self = folder.self && typeof folder.self === "object" ? folder.self : null;
      const me = [self && self.label, info.label]
        .find((value) => typeof value === "string" && value.trim());
      if (!me) return "";
      const states = folder.states && typeof folder.states === "object" ? folder.states : {};
      const state = typeof states[me.trim()] === "string" ? states[me.trim()] : "";
      if (state === "accepted") return "папка принята";
      if (state === "disconnected") return "связь отключена: включение снова — после нового приглашения (Rev+1)";
      if (state === "unresolved") return "сторона не опознана: метка участника не разрешается в воркспейс";
      return "";
    }

    /* Счётчики папки: числа из ответа, отрицательное — не факт, а ноль. */
    function folderCounters(folder) {
      return {
        outgoing: Math.max(0, Number(folder && folder.outgoing) || 0),
        incoming: Math.max(0, Number(folder && folder.incoming) || 0),
      };
    }

    /*
     * 0143, вариант C: вход в окно папки — шестерёнка в её шапке, рядом с ней
     * бейдж участников. Обе кнопки видны всегда и открывают то же окно, что у
     * узла («Сведения» / «Состояние» / «Настройки»); свойств папки внизу
     * панели нет — они живут в этом окне.
     */
    function folderGear() {
      return { visible: "always", opens: "window" };
    }

    /*
     * Бейдж участников папки: «structure + workflow». Полный список — из записи
     * папки; если ответ его не принёс, остаётся наша метка и внешняя сторона.
     * Пустая папка так и говорит, а не показывает пустую плашку.
     */
    function folderParticipantsBadge(folder, data) {
      const info = data && typeof data === "object" ? data : {};
      const list = (Array.isArray(folder && folder.participants) ? folder.participants : [])
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim());
      const labels = list.length > 0
        ? list
        : [typeof info.label === "string" ? info.label.trim() : ""].concat(folderSides(folder, info)).filter(Boolean);
      return labels.length > 0 ? labels.join(" + ") : "участники не заданы";
    }

    /*
     * Подпись счётчика непрочитанных (задание 0082): «непрочитано N» —
     * честная и при нуле. N — целое ≥ 0; отрицательное и нечисло читаются
     * как ноль, чтобы подпись не обещала больше, чем есть.
     */
    function unreadLabel(n) {
      const value = Number(n);
      const count = Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
      return "непрочитано " + count;
    }

    /*
     * Сколько писем обмена ждёт разбора по ответу /api/exchange (поле
     * unread). null — сервер его не прислал: подпись тогда не показывается,
     * «непрочитано 0» не выдумывается. Функция чистая, проверяется без DOM.
     */
    function unreadTotal(data) {
      if (!data || typeof data !== "object") return null;
      const unread = data.unread;
      if (!unread || typeof unread !== "object") return null;
      const total = Number(unread.total);
      return Number.isFinite(total) && total >= 0 ? Math.trunc(total) : null;
    }

    /*
     * Подпись просроченных заявок (задания 0128, 0130): окно 14 суток считает
     * сервер, панель только называет число. Единица измерения названа — «дн.»
     * (задание 0130): без неё «просрочено 3» читается как «просрочено 3 письма»
     * и путается с соседним счётчиком «непрочитано 3». Ноль — пустая подпись:
     * «просрочено 0 дн.» ничего не сообщает и занимало бы место у счётчика.
     */
    function staleLabel(n) {
      const value = Number(n);
      const count = Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
      return count > 0 ? "просрочено " + count + " дн." : "";
    }

    /* Сколько заявок старше окна пришло в /api/exchange (поле unread.stale). */
    function staleTotal(data) {
      if (!data || typeof data !== "object") return 0;
      const unread = data.unread;
      if (!unread || typeof unread !== "object") return 0;
      const stale = Number(unread.stale);
      return Number.isFinite(stale) && stale > 0 ? Math.trunc(stale) : 0;
    }

    /*
     * Тело ack-письма (задание 0128): закрытие заявки без ответа. Сервер пишет
     * то же самое в свой ящик; здесь — тот же текст для подписи кнопки, чтобы
     * человек видел, что будет отправлено. Reply-To — полный путь от папки
     * обмена: по нему счётчик внимания снимает заявку тем же правилом, что и
     * обычный ответ. Функция чистая, кроме Date: письмо закрытия датируется
     * моментом вызова, а не датой заявки.
     */
    function closeAck(item) {
      const letter = item && typeof item === "object" ? item : {};
      const replyTo = typeof letter.path === "string" ? letter.path.trim() : "";
      const from = typeof letter.from === "string" && letter.from.trim() ? letter.from.trim() : "неизвестно";
      const me = typeof letter.me === "string" && letter.me.trim()
        ? letter.me.trim()
        : (typeof letter.to === "string" && letter.to.trim() ? letter.to.trim() : "me");
      const thread = typeof letter.thread === "string" && letter.thread.trim() ? letter.thread.trim() : "critic-report";
      const fallback = replyTo ? replyTo.split(/[\\/]/u).pop() : "заявка";
      const subject = typeof letter.subject === "string" && letter.subject.trim() ? letter.subject.trim() : fallback;
      /* Ack пишется сейчас: Date заявки в письме закрытия был бы чужой датой. */
      const date = new Date().toISOString();
      return [
        "Format: dsh-exchange/1",
        "From: " + me,
        "To: " + from,
        "Date: " + date,
        "Thread: " + thread,
        "Status: ack",
        "Reply-To: " + replyTo,
        "Subject: Закрыто: " + subject,
        "",
        "закрыто без ответа: отвечать нечего",
        "",
      ].join(String.fromCharCode(10));
    }

    /*
     * Предупреждения папки из ответа /api/exchange (задание 0052, WC-15):
     * участник, которого нет в roots/participants профиля, не «0 писем» —
     * его ящик не читается. Метка сверяется со сторонами этой папки, наша
     * собственная сторона предупреждением не считается. Функция чистая.
     */
    function folderUnresolvedWarnings(folder, data) {
      const warnings = Array.isArray(data && data.warnings) ? data.warnings : [];
      if (warnings.length === 0) return [];
      const labels = new Set((Array.isArray(folder && folder.participants) ? folder.participants : [])
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim().toLowerCase()));
      const me = data && typeof data.label === "string" ? data.label.trim().toLowerCase() : "";
      return warnings.filter((item) => item && typeof item.label === "string"
        && labels.has(item.label.trim().toLowerCase())
        && item.label.trim().toLowerCase() !== me);
    }

    /*
     * Подвал портала папки: путь ящика, а если папка не прочиталась — ошибка.
     * Ошибка уже называет ящик, поэтому в этом случае путь отдельно не дублируется.
     * Предупреждение о неразрешённом участнике стоит здесь же: это причина, по
     * которой счётчики папки пусты, и она видима без открытия карточки.
     */
    function folderPortalLines(folder, data) {
      const lines = [];
      const box = folder && typeof folder.box === "string" && folder.box.trim() ? folder.box.trim() : "";
      if (folder && folder.error) {
        lines.push({ text: "ошибка:", fill: T.warn });
        for (const line of wrapWords(folder.error, 34, 4)) lines.push({ text: line, fill: T.warn });
      } else if (box) {
        lines.push({ text: "ящик обмена:", fill: T.caption });
        /* Абсолютный путь длиннее строки: разрыв по символам, чтобы ящик был назван целиком. */
        for (const line of wrapWords(box, 34, 3)) lines.push({ text: line, fill: T.caption });
      }
      for (const warning of folderUnresolvedWarnings(folder, data)) {
        const message = warning.message || ("участник «" + warning.label + "» не в roots/participants — его ящик не читается");
        for (const line of wrapWords(message, 34, 4)) lines.push({ text: line, fill: T.warn });
        const fix = warning.fix || ("добавьте " + warning.label + " в roots и participants профиля (cordis.patch.yml): иначе его ящик не читается");
        for (const line of wrapWords(fix, 34, 4)) lines.push({ text: line, fill: T.secondary });
      }
      if (lines.length === 0) lines.push({ text: "ящик не объявлен", fill: T.caption });
      return lines;
    }

    /*
     * Высота портала папки: шапка, строка бейджа участников (0143), одна строка
     * стороны и подвал с ящиком/ошибкой. 18 px бейджа — часть шапки, а не
     * наложения на строку адресата.
     */
    function folderPortalHeight(folder, data) {
      return 119 + folderPortalLines(folder, data).length * 12;
    }

    /* Первый свободный id папки: folder-1, folder-2 — по занятым записям. */
    function freeFolderId(folders) {
      const taken = new Set((Array.isArray(folders) ? folders : [])
        .map((item) => item && item.id).filter(Boolean));
      let number = 1;
      while (taken.has("folder-" + number)) number += 1;
      return "folder-" + number;
    }

    /*
     * Черновик папки из портала, у которого папки ещё нет (легаси-портал или
     * воркспейс без объявленных folders). Клик по такому порталу открывает
     * редактор, а не только список фактов: папку можно создать из панели в
     * любом воркспейсе. Значения — разумная заготовка: ящик coordination
     * внутри воркспейса, участник — текущая метка, оркестратор — coordinator.
     * Функция чистая: ничего не читает и не пишет.
     */
    function folderDraftFromPortal(portal, data) {
      const source = portal && typeof portal === "object" ? portal : {};
      const info = data && typeof data === "object" ? data
        : (typeof data === "string" ? { label: data } : {});
      /* Объявленная папка проходит через обычный черновик, а не через заготовку. */
      const declared = source.folder && typeof source.folder === "object" && source.folder.id
        ? source.folder
        : null;
      if (declared) return folderEditorDraft(declared);
      const rawLabel = [info.label, source.label, typeof portal === "string" ? portal : ""]
        .find((value) => typeof value === "string" && value.trim());
      const labels = rawLabel ? folderParticipantLabels([rawLabel]) : [];
      const folders = Array.isArray(info.folders) ? info.folders
        : (Array.isArray(source.folders) ? source.folders : []);
      const orchestrator = typeof info.orchestrator === "string" && info.orchestrator.trim()
        ? info.orchestrator.trim()
        : "coordinator";
      const id = freeFolderId(folders);
      return {
        id,
        boxPath: typeof info.boxPath === "string" && info.boxPath.trim() ? info.boxPath.trim() : "coordination",
        boxRoot: info.boxRoot === "shared" ? "shared" : "workspace",
        participants: labels,
        contract: "contract-" + id + ".md",
        orchestrator,
      };
    }

    /*
     * Редактор папки обмена: черновик, который человек видит в поповере у
     * портала. Папка — не узел, поэтому и поля другие: ящик (path + root),
     * метки участников и имя контракта. Без записи папки (folder === null)
     * возвращается черновик из портала — чтобы создать папку из панели.
     */
    function folderEditorDraft(folder, context) {
      if (!folder || typeof folder !== "object" || !folder.id) {
        return folderDraftFromPortal(folder && typeof folder === "object" ? folder : null, context);
      }
      const box = folder.box && typeof folder.box === "object" ? folder.box : {};
      const exchange = folder.exchange && typeof folder.exchange === "object" ? folder.exchange : {};
      return {
        id: folder.id,
        boxPath: typeof box.path === "string" ? box.path : "",
        boxRoot: box.root === "workspace" ? "workspace" : "shared",
        participants: folderParticipantLabels(folder.participants),
        contract: typeof exchange.contract === "string" && exchange.contract.trim()
          ? exchange.contract.trim()
          : "contract-" + folder.id + ".md",
        orchestrator: typeof folder.orchestrator === "string" ? folder.orchestrator : "",
      };
    }

    /*
     * Переключение редактора папки — чистая функция. У закрытого редактора
     * черновик открывается, у того же самого — закрывается, у другой папки —
     * заменяется черновиком новой. Состояние не живёт в DOM, поэтому повторный
     * клик по порталу после closeFolderEditor снова открывает меню.
     */
    function toggleFolderEditor(current, folder) {
      /* Одна форма вызова — открыть папку; две — переключить уже открытый редактор. */
      const target = folder === undefined ? current : folder;
      const shown = folder === undefined ? null : current;
      if (!target || !target.id) return null;
      if (shown && shown.id === target.id) return null;
      return folderEditorDraft(target);
    }

    /*
     * Открыть редактор заново. Принимает (current, folder) и (folder): после
     * закрытия current === null, поэтому всегда возвращается новый черновик.
     */
    function reopenFolderEditor(current, folder) {
      const target = folder === undefined ? current : folder;
      if (!target || !target.id) return null;
      return folderEditorDraft(target);
    }

    /* Метки участников: метка остаётся, абсолютный путь сводится к имени папки. */
    function folderParticipantLabels(list) {
      const labels = [];
      for (const item of Array.isArray(list) ? list : []) {
        const value = String(item || "").trim();
        if (!value) continue;
        const absolute = /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("/") || value.startsWith("\\\\");
        const label = absolute ? (value.split(/[\\/]/u).filter(Boolean).pop() || value) : value;
        if (!labels.includes(label)) labels.push(label);
      }
      return labels;
    }

    /* Имя каталога воркспейса: поле name от сервера, иначе последний сегмент пути. */
    function workspaceName(entry) {
      const declared = entry && typeof entry.name === "string" ? entry.name.trim() : "";
      if (declared) return declared;
      const target = entry && typeof entry.path === "string" ? entry.path.trim() : "";
      return target ? rootLabel(target) : "";
    }

    /*
     * Подпись участника (задание 0029) — «метка (имя каталога)». Одна метка на
     * разных машинах не говорит, какой каталог за ней стоит; имя каталога
     * приходит из реестра (/api/status.workspaces[].name) и не выдумывается.
     */
    function participantLabel(entry) {
      if (typeof entry === "string") return entry.trim();
      const label = entry && typeof entry.label === "string" ? entry.label.trim() : "";
      const name = workspaceName(entry);
      if (!label) return name;
      if (!name) return label;
      return label + " (" + name + ")";
    }

    /*
     * Реестр воркспейсов из /api/status (задание 0024): участник папки
     * выбирается из него, свободного текстового поля метки нет. Строка несёт
     * label, абсолютный путь и name — имя каталога (задание 0029).
     */
    function registryWorkspaces(status) {
      const list = status && Array.isArray(status.workspaces) ? status.workspaces : [];
      const rows = [];
      for (const item of list) {
        const label = item && typeof item.label === "string" ? item.label.trim() : "";
        const target = item && typeof item.path === "string" ? item.path.trim() : "";
        if (!label || !target) continue;
        if (rows.some((row) => row.label === label)) continue;
        rows.push({ label, path: target, name: workspaceName(item) });
      }
      return rows;
    }

    /* Запись реестра по метке: подпись участника ссылается на метку, не на путь. */
    function registryEntry(list, label) {
      const value = String(label || "").trim();
      if (!value) return null;
      return (Array.isArray(list) ? list : []).find((row) => row && row.label === value) || null;
    }

    /*
     * Похожие метки для неразрешённой: подстрока или общий префикс от трёх
     * символов. Сервер считает похожие для отказа POST /api/folder, панель
     * повторяет это правило локально, чтобы подсказать до отправки.
     */
    function similarWorkspaces(list, label) {
      const needle = String(label || "").trim().toLowerCase();
      if (!needle) return [];
      return (Array.isArray(list) ? list : []).filter((row) => {
        const candidate = String(row && row.label || "").trim().toLowerCase();
        if (!candidate || candidate === needle) return false;
        if (candidate.includes(needle) || needle.includes(candidate)) return true;
        let common = 0;
        while (common < candidate.length && common < needle.length && candidate[common] === needle[common]) common += 1;
        return common >= 3;
      });
    }

    /*
     * Состояние участников папки по реестру: найденная метка несёт путь для
     * title, неразрешённая помечается «не найден» и получает похожие. Сохранить
     * такую метку нельзя — это решает и панель, и сервер.
     */
    function participantRows(participants, registry) {
      return (Array.isArray(participants) ? participants : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .map((label) => {
          const entry = registryEntry(registry, label);
          if (entry) {
            return { label, name: workspaceName(entry), path: entry.path, found: true, similar: [] };
          }
          return {
            label,
            name: "",
            path: "",
            found: false,
            similar: similarWorkspaces(registry, label).map((row) => row.label),
          };
        });
    }

    /*
     * Поиск по подстроке МЕТКИ, регистр не важен. Путь не ищется намеренно:
     * подстрока в пути («C:/.../panel-workspace») ловила бы чужие воркспейсы,
     * и поиск перестал бы быть поиском по реестру.
     */
    function filterWorkspaces(list, query) {
      const needle = String(query || "").trim().toLowerCase();
      const rows = Array.isArray(list) ? list : [];
      if (!needle) return rows.slice();
      return rows.filter((row) => String(row.label || "").toLowerCase().includes(needle));
    }

    /* Список через запятую — для меток, которые человек печатает руками. */
    function splitList(text) {
      return String(text || "").split(",").map((item) => item.trim()).filter(Boolean);
    }

    /* Тело записи папки: ровно те поля, что ждёт POST /api/folder. */
    function folderBody(draft) {
      return {
        id: draft.id,
        box: { path: String(draft.boxPath || "").trim(), root: draft.boxRoot === "workspace" ? "workspace" : "shared" },
        exchange: {
          /*
           * Пустое имя не шлём как «contract.md»: сервер сам назовёт контракт
           * contract-<id>.md, чтобы две папки одного ящика не делили файл.
           */
          contract: String(draft.contract || "").trim() || ("contract-" + String(draft.id || "") + ".md"),
        },
        participants: (draft.participants || []).slice(),
        orchestrator: draft.orchestrator,
      };
    }

    /* Имя для папки, созданной выносом из библиотеки: первый свободный folder-N. */
    function libraryFolderDraft(folders, orchestrator, label) {
      const id = freeFolderId(folders);
      return {
        id,
        boxPath: "coordination",
        boxRoot: "workspace",
        participants: [label],
        contract: "contract-" + id + ".md",
        orchestrator,
      };
    }

    /* Имя стороны в строке портала: длинное имя обрезается, чтобы не выйти за рамку. */
    function portalName(text, max = 26) {
      const value = String(text || "");
      return value.length > max ? value.slice(0, max - 1) + "…" : value;
    }

    /* Шаг клавиатуры: 8 px обычным нажатием и 1 px с Shift — так же, как мышь. */
    const KEYBOARD_STEP = 8;
    const KEYBOARD_FINE_STEP = 1;

    /*
     * Стрелка двигает узел по канве и не выпускает его в отрицательные
     * координаты: x и y в схеме — целые ≥ 0, и это же правило здесь.
     * Возвращает новую позицию или null, если клавиша не про перемещение.
     */
    function keyboardMove(position, key, shift) {
      const step = shift ? KEYBOARD_FINE_STEP : KEYBOARD_STEP;
      let dx = 0;
      let dy = 0;
      if (key === "ArrowLeft") dx = -step;
      else if (key === "ArrowRight") dx = step;
      else if (key === "ArrowUp") dy = -step;
      else if (key === "ArrowDown") dy = step;
      else return null;
      return { x: Math.max(0, Math.round(position.x + dx)), y: Math.max(0, Math.round(position.y + dy)) };
    }

    /*
     * Связи не хранят координат: обе точки считаются от сторон карточек при
     * каждой перерисовке. Правило то же, что в layoutGraph — точка на ближайшей
     * к соседу стороне прямоугольника; парные связи сдвигаются перпендикулярно
     * обеими точками, чтобы не лечь друг на друга. Поэтому линия не может
     * оторваться от узла ни при перетаскивании, ни при стрелках.
     */
    function nearestAnchor(box, toward) {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const dx = toward.x + toward.w / 2 - cx;
      const dy = toward.y + toward.h / 2 - cy;
      if (dx === 0 && dy === 0) return { x: cx, y: cy };
      const scale = Math.min(
        dx === 0 ? Infinity : (box.w / 2) / Math.abs(dx),
        dy === 0 ? Infinity : (box.h / 2) / Math.abs(dy),
      );
      return { x: cx + dx * scale, y: cy + dy * scale };
    }

    function edgeSegments(boxes, edges) {
      const pairOf = (edge) => [edge.from, edge.to].sort().join("\u0000");
      const pairTotal = new Map();
      for (const edge of edges) {
        const key = pairOf(edge);
        pairTotal.set(key, (pairTotal.get(key) || 0) + 1);
      }
      const pairSeen = new Map();
      return edges.map((edge) => {
        const from = boxes.get(edge.from);
        const to = boxes.get(edge.to);
        if (!from || !to) return { ...edge, x1: 0, y1: 0, x2: 0, y2: 0, missing: true };
        /* 0184: у координатора точка выхода уходит за вкладку (x + w + 13). */
        const start = validatorAnchor(from, nearestAnchor(from, to));
        const end = validatorAnchor(to, nearestAnchor(to, from));
        const x1 = start.x;
        const y1 = start.y;
        const x2 = end.x;
        const y2 = end.y;
        const key = pairOf(edge);
        const total = pairTotal.get(key) || 1;
        const index = pairSeen.get(key) || 0;
        pairSeen.set(key, index + 1);
        if (total === 1) return { ...edge, x1, y1, x2, y2 };
        const shift = (index - (total - 1) / 2) * 9;
        const firstBox = boxes.get([edge.from, edge.to].sort()[0]);
        const secondBox = boxes.get([edge.from, edge.to].sort()[1]);
        const across = firstBox && secondBox
          ? { x: secondBox.x + secondBox.w / 2 - (firstBox.x + firstBox.w / 2), y: secondBox.y + secondBox.h / 2 - (firstBox.y + firstBox.h / 2) }
          : { x: x2 - x1, y: y2 - y1 };
        const length = Math.hypot(across.x, across.y) || 1;
        const nx = (-across.y / length) * shift;
        const ny = (across.x / length) * shift;
        return { ...edge, x1: x1 + nx, y1: y1 + ny, x2: x2 + nx, y2: y2 + ny };
      });
    }

    /* "30.10 09:00" in the declared zone, never in the browser's own. */
    function scheduleMoment(entry) {
      const iso = entry && entry.nextRun;
      if (!iso) return "";
      try {
        const parts = new Intl.DateTimeFormat("ru-RU", {
          timeZone: entry.timeZone || undefined,
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).formatToParts(new Date(iso));
        const value = (type) => (parts.find((part) => part.type === type) || {}).value || "";
        return value("day") + "." + value("month") + " " + value("hour") + ":" + value("minute");
      } catch {
        return "";
      }
    }

    function renderNode(node, detail, selected, state, schedule, onPick, interaction = {}) {
      const color = roleColor(detail && detail.role);
      const role = (detail && detail.role) || "роль не задана";
      /* Папка обмена — не агент: на карточке написано «только сообщения». */
      const exchange = isFolderNode(detail);
      const model = detail && detail.model ? detail.model : "модель не задана";
      const label = [role, model].join(" · ");
      const brief = (detail && detail.brief) || "назначение не задано";
      const preset = detail && detail.agentPreset ? detail.agentPreset : "пресет не задан";
      const active = state.key === "running";
      const clipId = "pg-node-" + String(node.id).replace(/[^A-Za-z0-9_-]/g, "_");
      /*
       * Only a node with a schedule carries the run line: printing "расписание: выкл"
       * on every card turned the canvas into noise and read as if something was off.
       * The tip still explains the absence in words.
       */
      const scheduleInfo = schedule && schedule.nextRun ? schedule : null;
      const scheduleText = !exchange && scheduleInfo ? "◷ следующий запуск " + scheduleMoment(scheduleInfo) : "";
      const boxPath = detail && detail.box && detail.box.path ? String(detail.box.path) : "";
      const participants = detail && Array.isArray(detail.participants) ? detail.participants : [];
      const exchangeText = exchange ? "⇄ " + (boxPath ? "папка " + boxPath : "папка не задана") : "";
      const scheduleTip = scheduleInfo
        ? "\n" + "расписание: " + (scheduleInfo.daily || "ежедневно " + scheduleInfo.at)
          + " (" + scheduleInfo.timeZone + ")" + "\n" + "следующий запуск: " + scheduleMoment(scheduleInfo)
        : "\n" + "расписание: выкл — узел запускается только по поручению";
      /* Связь с сессией — в подсказке карточки: на самой карточке места нет. */
      const bindingText = interaction && typeof interaction.binding === "string" ? interaction.binding : "";
      /*
       * 0143: шестерёнка в строке роли — видимый вход в окно узла. Она стоит
       * всегда и отнимает у подписи роли те же 22 px, что в макете C.
       */
      const gear = nodeGear();
      const roleText = label.length > 21 ? label.slice(0, 20) + "…" : label;
      const openWindow = () => {
        if (interaction && typeof interaction.onOpenWindow === "function") interaction.onOpenWindow(node);
      };
      const tip = node.id + "\n" + "роль: " + role + "\n" + "модель: " + model + "\n" + "пресет: " + preset
        + "\n" + "состояние: " + state.word + " — " + state.hint
        + (state.sourceWord ? "\n" + "источник активности: " + state.sourceWord : "")
        + (bindingText ? "\n" + "связь: " + bindingText : "") + scheduleTip
        + (exchange
          ? "\n" + "папка обмена: " + (boxPath || "не задана — добавьте box { path, root }")
            + "\n" + "участники: " + (participants.length ? participants.join(", ") : "не заданы")
            + "\n" + "связь: рёбра exchange от узлов, которые пишут в ящик"
          : "")
        + "\n" + "позиция на канве: x " + Math.round(node.x) + ", y " + Math.round(node.y) + "\n" + brief;
      /* Карточка — кнопка: Tab доводит до неё, стрелки двигают, фокус виден рамкой. */
      return h(
        "g",
        {
          key: node.id,
          "data-node": node.id,
          transform: "translate(" + node.x + " " + node.y + ")",
          tabIndex: 0,
          role: "button",
          style: { cursor: interaction.dragging ? "grabbing" : "grab", outline: "none" },
          onClick: () => onPick(node.id),
          /*
           * 0143: правый клик по узлу меню не открывает. Браузерное меню тоже
           * гасим — иначе оно перекрыло бы канву; действие входа у шестерёнки.
           */
          onContextMenu: (event) => { if (event && event.preventDefault) event.preventDefault(); },
          onPointerDown: interaction.onPointerDown ? (event) => interaction.onPointerDown(event, node) : undefined,
          onKeyDown: interaction.onKeyDown ? (event) => interaction.onKeyDown(event, node) : undefined,
          onFocus: interaction.onFocus ? () => interaction.onFocus(node.id) : undefined,
          onBlur: interaction.onBlur ? () => interaction.onBlur(node.id) : undefined,
          "aria-label": node.id + ", " + state.word + (exchange ? ", только сообщения" : ""),
          "aria-describedby": "pg-layout-hint",
        },
        h("title", null, tip),
        /*
         * The stripe is clipped to the card: drawn at x=0 with its own rounded
         * corner it stuck out of the card's rounded left edge.
         */
        h("defs", null,
          h("clipPath", { id: clipId },
            h("rect", { width: node.w, height: node.h, rx: 10 }))),
        /*
         * Карточка непрозрачна: подложка базовым цветом, поверх — оттенок. Иначе
         * связи и линия к порталу просвечивают сквозь карточку и пересекают текст.
         */
        h("rect", {
          width: node.w,
          height: node.h,
          rx: 10,
          fill: "var(--dsw-alias-bg-base, #ffffff)",
        }),
        h("rect", {
          width: node.w,
          height: node.h,
          rx: 10,
          fill: T.bg2,
          stroke: active ? state.color : selected || interaction.focused ? T.link : T.border2,
          strokeWidth: active ? 3 : selected || interaction.focused ? 2 : 1,
          strokeDasharray: node.cyclic ? "6 4" : null,
        }),
        h("g", { clipPath: "url(#" + clipId + ")" },
          h("rect", { width: 4, height: node.h, rx: 2, fill: color })),
        active
          ? h("circle", { cx: node.w - 10, cy: 10, r: 4, fill: T.success, stroke: T.bg1, strokeWidth: 1 },
            h("title", null, state.hint))
          : null,
        h("text", { x: 14, y: 22, fill: T.text, fontSize: 13, fontWeight: 600, style: { fontFamily: T.mono } }, node.id),
        h("text", { x: 14, y: 38, fill: T.tertiary, fontSize: 11 }, roleText),
        /*
         * Шестерёнка строки роли (0143): не появляется по наведению — стоит
         * всегда, поэтому вход находится и без мыши. Клик открывает окно узла
         * на «Сведениях»; клик по карточке по-прежнему только выбирает узел.
         */
        gear.visible === "always"
          ? h("g", {
            key: "gear",
            "data-node-gear": node.id,
            role: "button",
            tabIndex: 0,
            "aria-label": "Окно узла " + node.id + ": сведения, состояние, настройки",
            style: { cursor: "pointer" },
            onClick: (event) => {
              if (event && event.stopPropagation) event.stopPropagation();
              openWindow();
            },
            onKeyDown: (event) => {
              if (!event) return;
              if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
              if (event.preventDefault) event.preventDefault();
              if (event.stopPropagation) event.stopPropagation();
              openWindow();
            },
          },
            h("title", null, "Открыть окно узла: «Сведения», «Состояние», «Настройки»"),
            h("text", {
              x: node.w - 16, y: 39, fontSize: 14, fill: T.tertiary, textAnchor: "middle",
              style: { userSelect: "none" },
            }, "⚙"))
          : null,
        /* The state is a word, not only a colour: it reads on both themes. */
        h("text", { x: 14, y: 50, fill: state.color, fontSize: 10, fontWeight: 600 }, state.word),
        /* The cadence line sits under the state, as in the approved mock. */
        scheduleText ? h("text", { x: 14, y: 61, fill: T.tertiary, fontSize: 9 }, scheduleText) : null,
        /* У папки обмена вместо расписания — честная пометка о способе связи. */
        exchangeText ? h("text", { x: 14, y: 61, fill: T.caption, fontSize: 9 }, exchangeText) : null,
      );
    }

    function displayPath(value) {
      return String(value || "").replace(/\\/g, "/");
    }

    function samePath(left, right) {
      const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase();
      return normalize(left) === normalize(right) && String(left || "").length > 0;
    }

    function rootLabel(value) {
      const parts = String(value || "").split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : String(value || "");
    }

    /* Текущий воркспейс из клиентской службы DSH: по нему панель открывается. */
    function currentWorkspace(service) {
      if (!service) return null;
      try {
        const sessions = service.sessions && service.sessions.list && service.sessions.list.getSnapshot();
        const workspaces = service.workspaces && service.workspaces.list && service.workspaces.list.getSnapshot();
        if (!sessions || !workspaces) return null;
        const items = workspaces.items || [];
        let sessionId = service.mainReference && service.mainReference.sessionId;
        if (!sessionId && service.selection && typeof service.selection.getSnapshot === "function") {
          sessionId = service.selection.getSnapshot().sessionId;
        }
        if (!sessionId) {
          const active = Object.values(sessions.byId || {}).find(
            (session) => session && session.retainedBy && (session.retainedBy.mainView || 0) > 0,
          );
          sessionId = active && active.id;
        }
        const summary = sessionId ? sessions.byId && sessions.byId[sessionId] : null;
        let workspace = items.find(
          (item) => item && Array.isArray(item.sessionIds) && sessionId && item.sessionIds.includes(sessionId),
        );
        /* Последний резерв: рабочая папка самой сессии. */
        if (!workspace && summary && typeof summary.cwd === "string") {
          workspace = items.find((item) => item && samePath(item.path, summary.cwd));
        }
        if (!workspace || typeof workspace.path !== "string" || workspace.path.length === 0) return null;
        return { path: workspace.path, title: workspace.title || rootLabel(workspace.path), sessionId };
      } catch {
        return null;
      }
    }

    /*
     * A node is active when a child agent spawned for it is running right now.
     * The label written by project_graph_spawn is "role:node" (or just "node"),
     * and the session summary carries "running".
     */
    function activeNodeIds(snapshot, parentSessionId, nodes) {
      const result = new Set();
      if (!snapshot || !parentSessionId) return result;
      const byId = snapshot.byId || {};
      const catalog = snapshot.projectionsBySession
        && snapshot.projectionsBySession[parentSessionId]
        && snapshot.projectionsBySession[parentSessionId].values
        && snapshot.projectionsBySession[parentSessionId].values.subagentCatalog;
      for (const entry of Array.isArray(catalog) ? catalog : []) {
        if (!entry || !entry.id || !(byId[entry.id] && byId[entry.id].running === true)) continue;
        const label = String(entry.label || "");
        for (const node of nodes) {
          if (label === node.id || label.endsWith(":" + node.id)) { result.add(node.id); break; }
        }
      }
      return result;
    }

    /*
     * The live route answers in one shape; the view only needs the node ids and the
     * count of agents whose label named no node. A broken answer is not activity:
     * it becomes an empty list, never a guess about who is working.
     */
    function liveView(body) {
      const items = body && Array.isArray(body.active)
        ? body.active.filter((id) => typeof id === "string" && id.length > 0)
        : [];
      const named = body && Array.isArray(body.unknown)
        ? body.unknown.filter((id) => typeof id === "string" && id.length > 0).length
        : 0;
      /*
       * When the host's agent service says nothing, the session files still prove
       * that work is happening. Those agents have no role, so they are counted on
       * top of the unknown ones instead of being attached to a node.
       */
      const bySession = body && body.sessions && typeof body.sessions.running === "number"
        ? body.sessions.running
        : 0;
      /*
       * The route now names the sessions it could NOT attach to a node. Only they
       * are "outside the structure": a working session already bound to a node is
       * not an unknown role, and counting sessions.running whole was the defect
       * the panel showed to the customer. An older host has no unattributed list,
       * so its answer keeps the previous meaning instead of turning green.
       */
      const declared = body && Array.isArray(body.unattributed);
      const unattributed = declared
        ? body.unattributed
          .filter((row) => row && typeof row === "object" && !Array.isArray(row)
            && typeof row.id === "string" && row.id.length > 0)
          .map((row) => ({
            id: row.id,
            at: typeof row.at === "number" ? row.at : null,
            label: typeof row.label === "string" ? row.label : "",
          }))
        : [];
      const unknown = declared ? named + unattributed.length : named + bySession;
      return { active: [...new Set(items)], unknown, bySession, unattributed };
    }

    /*
     * WHERE the activity of each node comes from. The route names the source in
     * activityByNode; an answer without it (an older host) can only mean the agent
     * service, so a node of `active` defaults to "agent". The reverse never
     * happens: a session is not promoted to a live agent, and an unknown source
     * word is not guessed from the node's looks.
     */
    function activitySources(body) {
      const sources = {};
      const declared = body && body.activityByNode;
      if (declared && typeof declared === "object" && !Array.isArray(declared)) {
        for (const [id, source] of Object.entries(declared)) {
          if (typeof id !== "string" || !id) continue;
          if (source !== "session" && source !== "agent" && source !== "run") continue;
          sources[id] = source;
        }
      }
      const active = body && Array.isArray(body.active) ? body.active : [];
      for (const id of active) {
        if (typeof id !== "string" || !id) continue;
        if (!sources[id]) sources[id] = "agent";
      }
      return sources;
    }

    /*
     * How old the bound session is, in words. The age is computed from the instant
     * the caller passes in (the same "now" as the poll), never from a wall-clock
     * read hidden inside the sentence: a test and the panel then say the same thing.
     */
    function bindingAge(at, now) {
      const value = typeof at === "number" && Number.isFinite(at) ? at : null;
      if (value === null) return "время активности неизвестно";
      const minutes = Math.max(0, Math.round(((typeof now === "number" ? now : Date.now()) - value) / 60000));
      if (minutes < 1) return "только что";
      if (minutes < 60) return minutes + " мин назад";
      const hours = Math.round(minutes / 60);
      if (hours < 24) return hours + " ч назад";
      return Math.round(hours / 24) + " дн назад";
    }

    /*
     * The binding of a node in one honest line: which session, how long ago it was
     * active, and WHERE the link comes from. The source is never implied — a label,
     * a manual choice and freshness look identical on the canvas otherwise. Two
     * sessions within a minute are both named: the panel shows the freshest and
     * says "одинаково свежие" instead of choosing one silently.
     */
    /*
     * Режим императива — отображение, а не блокировка работы. Панель называет
     * режим словами: fail отклоняет нативный обход, warn — пилот с
     * предупреждением, off осознанно ослаблен и помечается заметно. Старый
     * ответ без enforcement (хост до 0092) строки не порождает: панель не
     * падает и ничего не выдумывает.
     */
    function enforcementView(payload) {
      const enforcement = payload && payload.enforcement;
      if (!enforcement || typeof enforcement !== "object" || Array.isArray(enforcement)) return null;
      const mode = typeof enforcement.mode === "string" ? enforcement.mode.trim() : "";
      const where = enforcement.source === "config"
        ? "задан конфигом workflow"
        : "режим по умолчанию: конфиг workflow его не задаёт";
      if (mode === "fail") {
        return { level: "ok", text: "режим fail — нативный обход отклоняется (" + where + ")" };
      }
      if (mode === "warn") {
        return { level: "pilot", text: "режим warn — пилот: обход предупреждается (" + where + ")" };
      }
      if (mode === "off") {
        return {
          level: "weak",
          text: "императив ослаблен: режим off — нативный обход не отклоняется и не предупреждается ("
            + where + ")",
        };
      }
      return null;
    }

    function bindingView(binding, now) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
      const session = typeof binding.session === "string" ? binding.session.trim() : "";
      if (!session) return null;
      const short = session.slice(0, 8);
      const source = binding.source === "label"
        ? "привязана по метке"
        : binding.source === "pin"
          ? "выбрана вручную"
          : binding.source === "auto"
            ? "привязана автоматически по свежести"
            : "источник связи не определён";
      const ambiguous = Array.isArray(binding.ambiguous)
        ? binding.ambiguous
          .filter((item) => item && typeof item.id === "string" && item.id.length > 0)
          .map((item) => item.id.slice(0, 8))
        : [];
      const same = ambiguous.length > 1 ? " · одинаково свежие: " + ambiguous.join(", ") : "";
      return "сессия " + short + " · активна " + bindingAge(binding.at, now) + " · " + source + same;
    }

    /*
     * The state a node shows, in words. A run is "работает" while its child
     * lives or while the run store still calls it running; "завершил" and
     * "ошибка" come from the recorded run; "свободен" is only claimed once the
     * activity store answered — otherwise "нет данных", because a panel that
     * cannot know must not tell a person the node is free.
     */
    function nodeState(input) {
      const active = Boolean(input && input.active);
      const run = input && input.run;
      const known = Boolean(input && input.activityKnown);
      if (active) {
        /*
         * The activity has a source, and the card says which. A live agent keeps
         * the word "работает" it always had. A fresh session journal — the only
         * proof in a workspace whose agents ctx.agents cannot see — says "активен
         * по журналу" instead, because naming no agent is the honest answer. The
         * source comes from the route's activityByNode, never from a guess here:
         * a session is not dressed up as a live agent.
         */
        const source = input && (input.source === "session" || input.source === "agent" || input.source === "run")
          ? input.source
          : "";
        if (source === "session") {
          return { key: "running", word: "активен по журналу", source, sourceWord: "по журналу сессии",
            color: T.success,
            hint: input && input.self
              ? "эта сессия сейчас выполняет работу по структуре"
              : "живого агента панель не видит, но журнал сессии писался меньше двух минут назад" };
        }
        if (source === "run") {
          /*
           * The run journal names the node itself, so the card can say the node is
           * executing — a different fact from "a live agent works here" and from
           * "the bound session wrote recently". The start time comes from the run
           * record the panel already reads; without it the sentence stays honest.
           */
          const started = run && run.state === "running" && typeof run.since === "number"
            ? new Date(run.since).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
            : "";
          return { key: "running", word: "выполняется", source,
            sourceWord: "журнал запусков — узел запущен", color: T.success,
            hint: "запуск этого узла идёт сейчас" + (started ? " с " + started : "") };
        }
        if (source === "agent") {
          return { key: "running", word: "работает", source, sourceWord: "живой агент", color: T.success,
            hint: input && input.self
              ? "эта сессия сейчас выполняет работу по структуре"
              : "агент этого узла выполняет работу сейчас" };
        }
        return { key: "running", word: "работает", color: T.success,
          hint: input && input.self
            ? "эта сессия сейчас выполняет работу по структуре"
            : "агент этого узла выполняет работу сейчас" };
      }
      if (run && run.state === "running") {
        return { key: "running", word: "работает", color: T.success,
          hint: "запуск записан, агент узла ещё не отчитался" };
      }
      if (run && run.state === "done") {
        return { key: "done", word: "завершил", color: T.link,
          hint: "последний запуск закончился успешно" };
      }
      if (run && run.state === "error") {
        return { key: "error", word: "ошибка", color: T.danger,
          hint: run.message ? "последний запуск: " + run.message : "последний запуск завершился ошибкой" };
      }
      if (!known) {
        return { key: "unknown", word: "нет данных", color: T.tertiary,
          hint: "активность ещё не получена: панель не знает, занят ли узел" };
      }
      return { key: "idle", word: "свободен", color: T.tertiary,
        hint: "по этому узлу сейчас никто не работает" };
    }

    /* The long form for the detail card: state, why, and what to do next. */
    function stateSentence(state, run, clock) {
      const at = clock || "";
      if (state.key === "running") {
        const since = run && run.since ? " с " + new Date(run.since).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
        if (state.source === "session") {
          return "живого агента панель не видит, но журнал сессии писался меньше двух минут назад" + since;
        }
        if (state.source === "run") {
          return "узел выполняется — запуск этого узла идёт сейчас" + since;
        }
        return "агент этого узла выполняет работу сейчас" + since;
      }
      if (state.key === "done") return "последний запуск закончился" + (at ? " " + at : "");
      if (state.key === "error") return (run && run.message) || "последний запуск завершился ошибкой — откройте журнал запуска";
      if (state.key === "unknown") {
        return "активность ещё не получена (панель спрашивает раз в 2 с) — нажмите «Обновить», если это длится";
      }
      return "по этому узлу сейчас никто не работает — запустите его через project_graph_run или project_graph_spawn";
    }

    /*
     * 0122: окно узла по макету C. Паспорт (объявление узла) и живое
     * состояние — разные вкладки одной формы, а не строки нижней панели:
     * снизу остаются два действия. Всё ниже — чистые функции: панель и
     * проверка без DOM пользуются одними и теми же строками (C1–C4).
     */
    function nodeTabs() {
      return [
        { id: "info", label: "Сведения", hint: "только чтение" },
        { id: "state", label: "Состояние", hint: "только чтение" },
        { id: "settings", label: "Настройки", hint: "правка" },
      ];
    }

    /*
     * 0143, вариант C заказчика: вход в окно узла — шестерёнка в строке роли.
     * Она видна ВСЕГДА (не по наведению: на тач-экране наведения нет), а клик
     * открывает окно с вкладками. Правого меню больше нет — один пункт меню не
     * оправдывал правую кнопку. Функция одна для панели и проверки: панель
     * рисует ровно те свойства, которые здесь названы.
     */
    function nodeGear() {
      return { visible: "always", opens: "window" };
    }

    /*
     * Окно узла (0129): размер фиксирован, чтобы окно не прыгало по вкладкам.
     * Шапка с вкладками и футер с кнопками неподвижны, а тело вкладки получает
     * остаток высоты и прокручивается: длинная спека не растягивает окно.
     * Числа и стиль тела — чистые функции: панель и проверка пользуются ими же.
     */
    const NODE_WINDOW_WIDTH = 560;
    const NODE_WINDOW_HEIGHT = 520;
    function nodeModalSize() {
      return { width: NODE_WINDOW_WIDTH, height: NODE_WINDOW_HEIGHT };
    }
    function nodeBodyStyle() {
      /* minHeight: 0 — иначе flex-элемент не сжимается и прокрутки не будет. */
      return { ...S.modalBody, overflowY: "auto", minHeight: 0, flex: "1 1 auto" };
    }

    /*
     * 0160: окно «Настройки» по макету 05–06 (docs/design/validator-2026-11-08).
     * Шапка с названием и вкладками закреплена, между ней и линейкой
     * прокручивается только тело, а линейка с «Сохранить» и «Удалить узел»
     * всегда на месте. Раньше кнопки лежали в конце прокрутки: человек до них
     * не доходил и не знал, что они есть — отсюда дефект «кнопки скрыты».
     * Числа и состояния — чистые функции: панель и проверки берут их здесь.
     */
    const SETTINGS_HEADER_HEIGHT = 37;
    const SETTINGS_TABS_HEIGHT = 31;
    const SETTINGS_FOOTER_HEIGHT = 44;

    function settingsLayout() {
      return {
        header: "fixed",
        tabs: "fixed",
        body: "scroll",
        footer: "fixed",
        headerHeight: SETTINGS_HEADER_HEIGHT,
        tabsHeight: SETTINGS_TABS_HEIGHT,
        footerHeight: SETTINGS_FOOTER_HEIGHT,
        bodyOverflowY: "auto",
        /* Нижний отступ тела не меньше футера: последнее поле не прячется. */
        bodyPaddingBottom: SETTINGS_FOOTER_HEIGHT + 12,
        bodyScrollPaddingBottom: SETTINGS_FOOTER_HEIGHT,
      };
    }

    /* Действия линейки: порядок и подписи — одна точка правды для панели и проверки. */
    function settingsActions() {
      return [
        {
          label: "Сохранить",
          place: "footer",
          visible: "always",
          tone: "primary",
          action: "save",
          disabledWhen: "no-changes",
        },
        {
          label: "Удалить узел",
          place: "footer",
          visible: "always",
          tone: "danger",
          action: "remove",
          confirms: true,
        },
      ];
    }

    /*
     * Затемнение удаления не выходит за тело: верх — шапка и вкладки, низ —
     * высота линейки. Слой живёт внутри слота тела, поэтому шапку и футер он
     * не накрывает даже если они вырастут; эти числа — границы макета.
     */
    function deleteConfirmInsets() {
      const layout = settingsLayout();
      return {
        top: layout.headerHeight + layout.tabsHeight,
        bottom: layout.footerHeight,
        scope: "body",
      };
    }

    function settingsBodyStyle() {
      const layout = settingsLayout();
      return {
        ...nodeBodyStyle(),
        overflowY: layout.bodyOverflowY,
        paddingBottom: layout.bodyPaddingBottom + "px",
        scrollPaddingBottom: layout.bodyScrollPaddingBottom + "px",
        overscrollBehavior: "contain",
      };
    }

    function settingsBodySlotStyle() {
      return {
        flex: "1 1 auto",
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
      };
    }

    function settingsHeaderStyle() {
      return { ...S.modalHeader, flex: "0 0 auto" };
    }

    function settingsTabsBandStyle() {
      return {
        padding: "0 18px",
        background: T.bg1,
        borderBottom: "1px solid " + T.border1,
        flex: "0 0 auto",
      };
    }

    function settingsFooterStyle() {
      return {
        ...S.modalFooter,
        flex: "0 0 auto",
        minHeight: SETTINGS_FOOTER_HEIGHT + "px",
        boxSizing: "border-box",
        padding: "6px 18px",
        borderTop: "1px solid " + T.border1,
        background: T.bg1,
      };
    }

    /* Русский счёт: «1 поле», «2 поля», «5 полей» — число без кривой формы. */
    function ruPlural(number, one, few, many) {
      const n = Math.abs(Math.floor(Number(number) || 0)) % 100;
      const n10 = n % 10;
      if (n > 10 && n < 20) return many;
      if (n10 === 1) return one;
      if (n10 >= 2 && n10 <= 4) return few;
      return many;
    }

    /*
     * 0184: валидатор структуры — вкладка-выступ, а не приклеенный узел.
     *
     * Макет: docs/design/validator-tab-2026-11-09 (§2–§5, 06-spec). Вкладка —
     * продолжение поверхности карточки, а не предмет рядом с ней: левый край
     * квадратный и уходит под карточку на 1 px, скругление только справа,
     * рамка по трём сторонам. В покое это ручка 14 × 44 по центру блока, по
     * наведению из-под карточки выезжает панель 180 × 104 (translateX −166 → 0,
     * 140 мс, задержка 160 мс; уход — 250 мс). Слой — над рёбрами и под
     * карточками: стык 1 px перекрывает сама карточка, а рёбра начинаются за
     * полосой (x + w + 13), иначе провод обрывался бы на её середине.
     */
    const VALIDATOR_TAB = {
      attachedTo: "coordinator",
      edge: "right",
      leftEdge: "square",
      overlapPx: 1,
      radiusRight: 7,
      height: 44,
      collapsedWidth: 14,
      expandedWidth: 180,
      hover: {
        expandedWidth: 180,
        transitionMs: 140,
        opacityMs: 120,
        delayMs: 160,
        closeDelayMs: 250,
        handleFadeMs: 90,
      },
      layer: "below-nodes",
    };
    /* Панель выезда: 180 × 104, верх на уровне карточки — вертикального прыжка нет. */
    const VALIDATOR_CARD_HEIGHT = 104;
    const VALIDATOR_CARD_RADIUS = 10;
    /* Панель выезжает на свою ширину минус видимую ручку: 180 − 14 = 166. */
    const VALIDATOR_CARD_INSET = VALIDATOR_TAB.expandedWidth - VALIDATOR_TAB.collapsedWidth;
    /* Статус — внешнее ребро 2 px: это и есть правая граница вкладки, не «палочка». */
    const VALIDATOR_STATUS_EDGE = 2;
    /* Тень стыка 8 px: свет падает от карточки на вкладку. */
    const VALIDATOR_SEAM = 8;

    /** Модель вкладки: панель, проверка и тесты читают одни числа, а не копии. */
    function validatorTab() {
      return { ...VALIDATOR_TAB, hover: { ...VALIDATOR_TAB.hover } };
    }

    /* 0184: система просит меньше движения — вкладка раскрывается без сдвига и задержек. */
    function prefersReducedMotion() {
      try {
        if (typeof window === "undefined" || !window || typeof window.matchMedia !== "function") return false;
        const query = window.matchMedia("(prefers-reduced-motion: reduce)");
        return Boolean(query && query.matches);
      } catch {
        return false;
      }
    }

    /** Находки приходят и списком, и ответом /api/graph с полем validation. */
    function validatorFindings(source) {
      if (Array.isArray(source)) return source;
      const box = source && typeof source === "object" ? source : {};
      const main = box.validation && typeof box.validation === "object" ? box.validation : box;
      return Array.isArray(main.findings) ? main.findings : [];
    }

    /** Степень находки: error, warning или info (info — справка, а не тревога). */
    function validatorSeverity(item) {
      const raw = item && typeof item === "object" ? String(item.severity || "warning").toLowerCase() : "warning";
      if (raw === "error") return "error";
      if (raw === "info") return "info";
      return "warning";
    }

    /** Находка — всё, кроме info: у валидатора info (пустая структура) не находка. */
    function validatorIsFinding(item) {
      return validatorSeverity(item) !== "info";
    }

    /** Только настоящие находки: info не считается ни в сводке, ни в чипе, ни в счёте. */
    function validatorVisibleFindings(source) {
      return validatorFindings(source).filter(validatorIsFinding);
    }

    /** «структура исправна» | «1 находка» | «2 находки» | «5 находок» — info не находка. */
    function validatorSummary(findings) {
      const list = validatorVisibleFindings(findings);
      if (list.length === 0) return "структура исправна";
      return list.length + " " + ruPlural(list.length, "находка", "находки", "находок");
    }

    /*
     * Состояние вкладки (0184): одно из четырёх — error, warn, empty, ok.
     *
     * Пустая структура — «empty»: валидатор говорит о ней info-находкой
     * empty-graph (ok: true), и это начало, а не тревога; раньше панель
     * показывала «1 находка» янтарным и пугала на ровном месте. Принимается и
     * список находок, и ответ /api/graph целиком ({ graph, findings|validation }).
     */
    function validatorState(source) {
      const graph = source && typeof source === "object" && !Array.isArray(source)
        && source.graph && typeof source.graph === "object" && !Array.isArray(source.graph)
        ? source.graph : null;
      const findings = validatorFindings(source);
      const visible = findings.filter(validatorIsFinding);
      if (visible.some((item) => validatorSeverity(item) === "error")) return "error";
      if (visible.length > 0) return "warn";
      if (graph) return Array.isArray(graph.nodes) && graph.nodes.length === 0 ? "empty" : "ok";
      const emptyInfo = findings.some((item) => item && typeof item === "object"
        && String(item.code || "") === "empty-graph");
      return emptyInfo ? "empty" : "ok";
    }

    /** Подпись состояния словами: у пустой структуры своя, у остальных — сводка находок. */
    function validatorStateText(state, source) {
      return state === "empty" ? "структура пуста" : validatorSummary(source);
    }

    /** Блокирует запуск только severity=error: предупреждение — не запрет. */
    function validatorBlocked(findings) {
      return validatorFindings(findings).some((item) =>
        item && typeof item === "object" && String(item.severity || "").toLowerCase() === "error");
    }

    /** Одна находка словами: код, адрес, что не так и что сделать. */
    function validatorFindingLine(item) {
      const finding = item && typeof item === "object" ? item : {};
      const line = Number(finding.line);
      const where = finding.file
        ? String(finding.file) + (Number.isFinite(line) && line > 0 ? ":" + line : "")
        : "";
      /*
       * 0170: у валидатора есть info (пустой граф — начало, а не ошибка), а
       * fix — объект { kind, code, description }; у сборщика fix по-прежнему
       * строка. Оба вида читаются человеком: «[object Object]» на экран не
       * попадает.
       */
      const severity = String(finding.severity || "warning").toLowerCase();
      const fix = typeof finding.fix === "string"
        ? finding.fix
        : (finding.fix && typeof finding.fix.description === "string" ? finding.fix.description : "");
      return {
        code: String(finding.code || "находка"),
        severity: severity === "error" ? "error" : severity === "info" ? "info" : "warning",
        where,
        message: String(finding.message || finding.problem || ""),
        fix,
      };
    }

    /*
     * Тон вкладки по состоянию: зелёный — исправна, янтарный — предупреждения,
     * красный — блокировка, нейтральный — пустая структура (не тревога).
     * Принимается и состояние ('warn'), и список/ответ с находками.
     */
    function validatorTone(source) {
      const state = typeof source === "string" ? source : validatorState(source);
      if (state === "error") return T.danger;
      if (state === "warn") return T.warn;
      if (state === "empty") return T.caption;
      return T.success;
    }

    /** Подпись вкладки для скринридера: состояние словом и запрет запуска. */
    function validatorAria(state, findings) {
      const text = validatorStateText(state, findings);
      if (state === "empty") return "Валидатор структуры: " + text;
      return "Валидатор структуры: " + text
        + (state === "error" ? ", запуск заблокирован" : ", запуск доступен");
    }

    /* Чип шапки канвы (0184): одно состояние — одна фраза, у пустой структуры свой текст. */
    function validatorChipText(state, findings) {
      if (state === "empty") return "структура пуста · начните с координатора";
      if (state === "ok") return "структура исправна";
      return validatorSummary(findings)
        + (state === "error" ? " · запуск заблокирован" : " · запуск доступен");
    }

    /*
     * 0184: рёбра координатора начинаются не на его правом ребре, а за
     * вкладкой: иначе первые 13 px каждой исходящей связи скрыты под полосой
     * и линия обрывается на её середине — «провод надет на узел».
     */
    function validatorEdgeOffset() {
      return VALIDATOR_TAB.collapsedWidth - VALIDATOR_TAB.overlapPx;
    }

    /** Координатор на канве: у раскладки только id, у графа ещё и роль. */
    function validatorCoordinatorBox(box) {
      if (!box || typeof box !== "object") return false;
      return isCoordinatorNode(box) || String(box.id || "").toLowerCase() === "coordinator";
    }

    /** Точка выхода на правом ребре координатора сдвигается за вкладку. */
    function validatorAnchor(box, point) {
      if (!point || !validatorCoordinatorBox(box)) return point;
      const right = Number(box.x) + Number(box.w);
      if (!Number.isFinite(right) || Math.abs(Number(point.x) - right) > 0.5) return point;
      return { x: right + validatorEdgeOffset(), y: point.y };
    }

    /** Ребро серверной раскладки: обе точки проверяются тем же правилом. */
    function validatorEdge(edge, boxes) {
      if (!edge || !boxes) return edge;
      const start = validatorAnchor(boxes.get(edge.from), { x: edge.x1, y: edge.y1 });
      const end = validatorAnchor(boxes.get(edge.to), { x: edge.x2, y: edge.y2 });
      if (start.x === edge.x1 && end.x === edge.x2) return edge;
      return { ...edge, x1: start.x, y1: start.y, x2: end.x, y2: end.y };
    }

    /*
     * Форма вкладки: левый край квадратный, скругление только справа (0 7 7 0
     * у ручки, 0 10 10 0 у панели). Четыре скругления делали из выступа
     * второй объект, приставленный к карточке (макет §2).
     */
    function validatorShapePath(width, height, radius) {
      const w = Number(width) || 0;
      const h = Number(height) || 0;
      const r = Math.max(0, Math.min(Number(radius) || 0, w, h / 2));
      return "M0 0 H" + (w - r) + " A" + r + " " + r + " 0 0 1 " + w + " " + r
        + " V" + (h - r) + " A" + r + " " + r + " 0 0 1 " + (w - r) + " " + h + " H0 Z";
    }

    /* Рамка по трём сторонам: слева её нет — там вкладка продолжает карточку. */
    function validatorOutlinePath(width, height, radius) {
      const w = Number(width) || 0;
      const h = Number(height) || 0;
      const r = Math.max(0, Math.min(Number(radius) || 0, w, h / 2));
      return "M0 0 H" + (w - r) + " A" + r + " " + r + " 0 0 1 " + w + " " + r
        + " V" + (h - r) + " A" + r + " " + r + " 0 0 1 " + (w - r) + " " + h + " H0";
    }

    /*
     * Вкладка на канве (0184). Два узла одной вкладки: ручка 14 × 44 стоит на
     * правом краю карточки и заходит под неё на 1 px; по наведению из-под
     * карточки выезжает панель 180 × 104 (translateX −166 → 0, 140 мс,
     * задержка 160 мс), ручка гаснет. Слой — над рёбрами и под карточками:
     * стык 1 px перекрывает сама карточка. Статус — внешнее ребро 2 px, счёт —
     * цифрой внутри полосы, бейджа наружу нет. Enter и шестерёнка открывают
     * окно блока; при prefers-reduced-motion выезда и задержек нет.
     */
    function renderValidatorTab(node, options) {
      if (!node) return null;
      const input = options && typeof options === "object" ? options : {};
      const findings = validatorFindings(input.findings);
      const graph = input.graph && typeof input.graph === "object" && !Array.isArray(input.graph)
        ? input.graph : null;
      const state = validatorState({ graph, findings });
      const summary = validatorStateText(state, findings);
      const blocked = state === "error";
      const found = findings.filter(validatorIsFinding);
      const open = Boolean(input.hovered);
      const focused = Boolean(input.focused);
      const reduced = Boolean(input.reducedMotion);
      const tone = validatorTone(state);
      const lines = found.slice(0, 3).map(validatorFindingLine);
      const rest = found.length - lines.length;
      /* Высота вкладки не зависит от карточки: 44 — ручка, а не сплющенный блок. */
      const cardHeight = Number(node.h) > 0 ? Number(node.h) : 62;
      const handleWidth = VALIDATOR_TAB.collapsedWidth;
      const handleHeight = VALIDATOR_TAB.height;
      const panelWidth = VALIDATOR_TAB.expandedWidth;
      const panelHeight = VALIDATOR_CARD_HEIGHT;
      const insetY = (cardHeight - handleHeight) / 2;
      const originX = node.x + node.w - VALIDATOR_TAB.overlapPx;
      const originY = node.y + insetY;
      const clipKey = String(node.id).replace(/[^A-Za-z0-9_-]/g, "_");
      const handleClip = "pg-validator-handle-" + clipKey;
      const cardClip = "pg-validator-card-" + clipKey;
      const seamId = "pg-validator-seam-" + clipKey;
      const handleShape = validatorShapePath(handleWidth, handleHeight, VALIDATOR_TAB.radiusRight);
      const cardShape = validatorShapePath(panelWidth, panelHeight, VALIDATOR_CARD_RADIUS);
      const handleOutline = validatorOutlinePath(handleWidth, handleHeight, VALIDATOR_TAB.radiusRight);
      const cardOutline = validatorOutlinePath(panelWidth, panelHeight, VALIDATOR_CARD_RADIUS);
      /* Заливка тоном 9 % при находках: цвет читается и на 14 px. */
      const tint = state === "warn" || state === "error" ? tone : null;
      const openWindow = () => { if (typeof input.onOpen === "function") input.onOpen(); };
      const handleKey = (event) => {
        if (!event) return;
        if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        openWindow();
      };
      const hover = typeof input.onHover === "function" ? input.onHover : null;
      const focus = typeof input.onFocusChange === "function" ? input.onFocusChange : null;
      const cardTransition = reduced
        ? "none"
        : "transform " + VALIDATOR_TAB.hover.transitionMs + "ms cubic-bezier(.2,.8,.2,1), opacity "
          + VALIDATOR_TAB.hover.opacityMs + "ms linear";
      const handleTransition = reduced ? "none" : "opacity " + VALIDATOR_TAB.hover.handleFadeMs + "ms linear";
      const tilt = "translate(" + (open ? 0 : -VALIDATOR_CARD_INSET) + "px, " + (-insetY) + "px)";
      return h("g", {
        key: "validator-" + node.id,
        "data-validator-tab": "1",
        "data-validator-state": state,
        "data-validator-attached": VALIDATOR_TAB.attachedTo,
        "data-validator-edge": VALIDATOR_TAB.edge,
        "data-validator-layer": VALIDATOR_TAB.layer,
        "data-validator-width": String(open ? panelWidth : handleWidth),
        "data-validator-blocked": blocked ? "1" : "0",
        "data-validator-open": open ? "1" : "0",
        /* Левый край уходит под карточку на 1 px: стыка и второй рамки нет. */
        transform: "translate(" + originX + " " + originY + ")",
        tabIndex: 0,
        role: "button",
        "aria-label": validatorAria(state, findings),
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "dialog",
        style: { cursor: "pointer", outline: "none" },
        onClick: openWindow,
        onKeyDown: handleKey,
        onMouseEnter: hover ? () => hover(true) : undefined,
        onMouseLeave: hover ? () => hover(false) : undefined,
        onFocus: () => { if (hover) hover(true); if (focus) focus(true); },
        onBlur: () => { if (hover) hover(false); if (focus) focus(false); },
      },
        h("title", null, "Валидатор структуры\n" + summary
          + (blocked
            ? "\nзапуск заблокирован до устранения ошибок"
            : state === "empty" ? "\nструктура пуста: начните с координатора" : "\nзапуск доступен")
          + "\nEnter — окно блока"),
        h("defs", null,
          h("clipPath", { id: handleClip }, h("path", { d: handleShape })),
          h("clipPath", { id: cardClip }, h("path", { d: cardShape })),
          h("linearGradient", { id: seamId, x1: "0", y1: "0", x2: "1", y2: "0" },
            h("stop", { offset: "0", stopColor: "rgba(20,20,45,0.10)" }),
            h("stop", { offset: "1", stopColor: "rgba(20,20,45,0)" }))),
        /*
         * Панель ниже ручки: в покое она сдвинута под карточку на 166 px и
         * прозрачна, по наведению выезжает вправо. Верх — на уровне карточки,
         * поэтому вертикального прыжка нет.
         */
        h("g", {
          key: "card",
          "data-validator-card": "1",
          "data-validator-open": open ? "1" : "0",
          "aria-hidden": "true",
          style: {
            transform: tilt,
            opacity: open ? 1 : 0,
            transition: cardTransition,
            pointerEvents: open ? "auto" : "none",
            filter: "drop-shadow(0 10px 26px rgba(20,20,45,.16))",
          },
        },
          h("path", { d: cardShape, fill: "var(--dsw-alias-bg-base, #ffffff)" }),
          tint ? h("path", { d: cardShape, fill: tint, opacity: 0.09 }) : null,
          h("g", { clipPath: "url(#" + cardClip + ")" },
            /* Стык: свет падает от карточки на вкладку, 8 px. */
            h("path", { d: "M0 0 H" + VALIDATOR_SEAM + " V" + panelHeight + " H0 Z", fill: "url(#" + seamId + ")" }),
            h("path", {
              "data-validator-edge-status": "1",
              d: "M" + (panelWidth - VALIDATOR_STATUS_EDGE) + " 0 H" + panelWidth
                + " V" + panelHeight + " H" + (panelWidth - VALIDATOR_STATUS_EDGE) + " Z",
              fill: tone,
            })),
          h("path", { d: cardOutline, fill: "none", stroke: T.border2, strokeWidth: 1 }),
          h("text", { key: "title", x: 10, y: 18, fill: T.text, fontSize: 10, fontWeight: 600 },
            "Валидатор структуры"),
          h("text", {
            key: "summary", x: 10, y: 32, fill: tone, fontSize: 10.5, fontWeight: 600,
            "data-validator-summary": "1",
          }, summary),
          lines.length > 0
            ? h("g", { key: "lines" },
              lines.map((line, index) => h("text", {
                key: "line-" + index,
                x: 10, y: 48 + index * 12,
                fill: line.severity === "error" ? T.danger : T.secondary,
                fontSize: 8, style: { fontFamily: T.mono },
              }, line.code)))
            : null,
          blocked
            ? h("text", {
              key: "blocked", x: 10, y: panelHeight - 22,
              fill: T.danger, fontSize: 9, fontWeight: 600,
              "data-validator-blocked-label": "1",
            }, "Запуск заблокирован")
            : null,
          h("text", { key: "footer", x: 10, y: panelHeight - 8, fill: T.tertiary, fontSize: 9 },
            state === "empty"
              ? "начните с координатора"
              : found.length === 0
                ? "запуск доступен"
                : (rest > 0
                  ? "ещё " + rest + " · все " + found.length + " и diff →"
                  : "все " + found.length + " и diff →")),
          h("g", {
            key: "gear",
            "data-validator-gear": "1",
            /*
             * Шестерёнка — знак того же действия, что Enter на вкладке:
             * отдельной точкой фокуса она не нужна, а вложенная кнопка
             * в кнопке ломала бы обход с клавиатуры. Клик всплывает к вкладке.
             */
            "aria-hidden": "true",
            style: { cursor: "pointer" },
          },
            h("title", null, "Окно блока: сведения и настройки валидатора"),
            h("text", {
              x: panelWidth - 14, y: 16, fontSize: 12, fill: T.tertiary, textAnchor: "middle",
              style: { userSelect: "none" },
            }, "⚙"))),
        /*
         * Ручка — то, что видно в покое. Выехавшая панель занимает её место,
         * поэтому ручка гаснет за 90 мс; знак и счёт живут внутри полосы.
         */
        h("g", {
          key: "handle",
          "data-validator-handle": "1",
          "data-validator-open": open ? "1" : "0",
          "aria-hidden": "true",
          style: { opacity: open ? 0 : 1, transition: handleTransition },
        },
          h("path", { d: handleShape, fill: "var(--dsw-alias-bg-base, #ffffff)" }),
          tint ? h("path", { d: handleShape, fill: tint, opacity: 0.09 }) : null,
          h("g", { clipPath: "url(#" + handleClip + ")" },
            h("path", {
              "data-validator-edge-status": "1",
              d: "M" + (handleWidth - VALIDATOR_STATUS_EDGE) + " 0 H" + handleWidth
                + " V" + handleHeight + " H" + (handleWidth - VALIDATOR_STATUS_EDGE) + " Z",
              fill: tone,
            })),
          h("path", { d: handleOutline, fill: "none", stroke: T.border2, strokeWidth: 1 }),
          found.length > 0
            ? h("text", {
              key: "count",
              x: handleWidth / 2, y: 17, fill: tone, fontSize: 9, fontWeight: 700,
              textAnchor: "middle", "data-validator-count": String(found.length),
            }, String(found.length))
            : null,
          h("text", {
            key: "sign", x: handleWidth / 2,
            y: found.length > 0 ? 32 : handleHeight / 2 + 4,
            fill: tone, fontSize: 11, fontWeight: 700, textAnchor: "middle",
          }, state === "ok" ? "✓" : state === "empty" ? "○" : "!")),
        /* Фокус-рамка 2 px accent: видно и без наведения мышью. */
        h("path", {
          key: "focus",
          "data-validator-focus": focused ? "1" : "0",
          d: handleOutline, fill: "none", stroke: T.link, strokeWidth: 2,
          opacity: focused ? 1 : 0,
          style: { pointerEvents: "none", transition: reduced ? "none" : "opacity 120ms linear" },
        }),
      );
    }

    /*
     * Окно блока (0162 — вход и состояние): статус, список находок, баннер
     * блокировки и кнопка «Запустить», недоступная при error-находках.
     * Полное окно «Сведения/Настройки» с расписанием — задача 0164.
     */
    function renderValidatorWindow(view, open, onClose) {
      if (!open) return null;
      const findings = validatorFindings(view && view.validation);
      const graph = view && view.graph && typeof view.graph === "object" ? view.graph : null;
      const state = validatorState({ graph, findings });
      const found = findings.filter(validatorIsFinding);
      const blocked = validatorBlocked(findings);
      const summary = validatorStateText(state, findings);
      const checkedAt = view && view.validation && view.validation.checkedAt
        ? String(view.validation.checkedAt)
        : "";
      const close = () => { if (typeof onClose === "function") onClose(); };
      return h("div", {
        style: S.modalBackdrop,
        "data-validator-window": "1",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Окно блока валидатора структуры",
        onClick: (event) => { if (event && event.target === event.currentTarget) close(); },
      },
      h("div", { style: S.modal },
        h("div", { style: S.modalHeader },
          h("div", { style: S.modalTitle }, "Валидатор структуры"),
          h("button", {
            type: "button",
            "data-validator-close": "1",
            style: S.modalClose,
            "aria-label": "Закрыть окно валидатора",
            onClick: close,
          }, "×")),
        h("div", { style: S.modalBody },
          h("div", { style: S.modalRow },
            h("span", { style: S.modalLabel }, "Статус"),
            h("span", {
              style: { ...S.modalValue, color: validatorTone(state) },
              "data-validator-state": state,
              "data-validator-status": "1",
            }, summary)),
          checkedAt
            ? h("div", { style: S.modalRow },
              h("span", { style: S.modalLabel }, "Проверка"),
              h("span", { style: S.modalValue }, checkedAt))
            : null,
          blocked
            ? h("div", { "data-validator-blocked-banner": "1", role: "status", style: S.error },
              h("div", { style: S.errorTitle }, "Запуск заблокирован"),
              h("div", null, "Пока в структуре есть ошибки, новые задания не запускаются. "
                + "Идущая сессия доработает."))
            : h("div", { style: S.info }, state === "empty"
              ? "Структура пуста: начните с координатора — остальные узлы добавляются к нему."
              : found.length > 0
                ? "Ошибок нет: предупреждения не блокируют запуск."
                : "Находок нет: структура исправна, запуск доступен."),
          found.length > 0
            ? h("ul", { style: S.issueList, "data-validator-findings": String(found.length) },
              found.map((item, index) => {
                const line = validatorFindingLine(item);
                return h("li", { key: "finding-" + index, style: S.issue },
                  h("div", { style: { fontFamily: T.mono, fontSize: 11 } },
                    line.code + (line.where ? " · " + line.where : "")),
                  line.message ? h("div", { style: S.issueMeta }, line.message) : null,
                  line.fix ? h("div", { style: S.fix }, "Что сделать: " + line.fix) : null);
              }))
            : null),
        h("div", { style: S.modalFooter },
          h("button", {
            type: "button",
            "data-validator-launch": "1",
            style: S.buttonPrimary,
            disabled: blocked,
            title: blocked
              ? "запуск заблокирован: сначала устраните ошибки структуры"
              : "запуск выполняет модель через project_graph_run",
          }, "Запустить"),
          h("span", { style: S.hint }, blocked
            ? "Кнопка недоступна: сначала устраните ошибки структуры."
            : "Панель сама агентов не запускает — запуск идёт через project_graph_run."))));
    }

    /* «1 поле изменено», «2 поля изменены», «5 полей изменено» — число и глагол вместе. */
    function fieldsChangedText(number) {
      const n = Math.max(0, Math.floor(Number(number) || 0));
      const word = ruPlural(n, "поле", "поля", "полей");
      return n + " " + word + (word === "поля" ? " изменены" : " изменено");
    }

    /*
     * Находки валидатора структуры (задача 0152 приносит их в ответе /api/graph).
     * До неё поля нет — 0, и линейка честно молчит про находки. Принимается и
     * список, и готовое число: панель не диктует форму валидатору.
     */
    function validatorFindingsCount(source) {
      const box = source && typeof source === "object" ? source : {};
      const main = box.validation && typeof box.validation === "object" ? box.validation : box;
      const value = main.findings;
      if (Array.isArray(value)) return value.length;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
      const total = Number(main.findingsTotal);
      return Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
    }

    /*
     * Состояния «Сохранить» из макета §3.4:
     *   нет правок  — недоступна, в линейке «нет правок»;
     *   есть правки — доступна, «• 2 поля изменены» янтарным;
     *   есть находки — доступна (иначе не записать саму правку), число красным,
     *   рамка линейки красная: писать можно, запуск заблокирован.
     */
    function settingsFooterState(options) {
      const input = options && typeof options === "object" ? options : {};
      const changed = Math.max(0, Math.floor(Number(input.changed) || 0));
      const findings = Math.max(0, Math.floor(Number(input.findings) || 0));
      const busy = Boolean(input.busy);
      const save = {
        label: busy ? "Сохраняю…" : "Сохранить",
        disabled: busy || (changed === 0 && findings === 0),
        primary: true,
      };
      const remove = {
        label: "Удалить узел",
        danger: true,
        disabled: busy,
      };
      let tone = "muted";
      let text = "нет правок";
      if (findings > 0) {
        tone = "danger";
        text = findings + " " + ruPlural(findings, "находка", "находки", "находок") + " валидатора";
        if (changed > 0) {
          text += " · " + fieldsChangedText(changed);
        }
      } else if (changed > 0) {
        tone = "warn";
        text = "• " + fieldsChangedText(changed);
      }
      return {
        save,
        remove,
        note: { text, tone },
        frame: findings > 0 ? "danger" : null,
        changed,
        findings,
      };
    }

    /*
     * Поля формы «Настройки» (0126 C3): одни для панели и проверки. Спека —
     * key prompt, вид textarea: это текст роли с Definition of Done, а не
     * короткая подпись. Пустая спека допустима — роль без спеки.
     */
    function nodeFormFields() {
      return [
        {
          key: "id", label: "id", kind: "readonly", width: "180px",
          aria: "id узла в редакторе",
          title: "id не меняется: другой id — другой узел, и связи пришлось бы переносить руками",
        },
        {
          key: "role", label: "Роль", kind: "text", width: "180px",
          aria: "роль узла в редакторе", placeholder: "роль",
        },
        {
          key: "brief", label: "Назначение", kind: "text", width: "220px",
          aria: "назначение узла в редакторе", placeholder: "назначение (brief)",
        },
        {
          key: "prompt", label: "Спека", kind: "textarea", rows: 7,
          aria: "спека узла в редакторе",
          placeholder: "Роль: ...\nDefinition of Done: ...",
          title: "текст роли: что делать и Definition of Done. Пусто — роль без спеки; "
            + "при постановке из палитры сюда попадает спека карточки",
        },
      ];
    }

    /*
     * Пунктов меню правой кнопки НЕТ (0143, вариант C): при видимой шестерёнке
     * правый клик теряет смысл — окно открывается с карточки. Функция остаётся
     * точкой правды для панели и проверки и всегда возвращает пустой список;
     * удаление узла живёт на вкладке «Настройки» с подтверждением.
     */
    function nodeMenuLabels() {
      return [];
    }

    /* Низ панели после 0122: только действия, ни одной строки состояния. */
    function bottomBarItems() {
      return ["Связь", "Запустить"];
    }

    /* Связь словами: вид и направление читаются без легенды. */
    function edgeKindWords(kind, direction) {
      if (kind === "delegate") return direction === "out" ? "задание" : "поручение";
      if (kind === "review") return direction === "out" ? "приёмка" : "проверка";
      if (kind === "report") return direction === "out" ? "отчёт" : "приём отчёта";
      if (kind === "peer") return "равное сотрудничество";
      return "связь";
    }

    function passportLinksText(node, links) {
      const id = node && node.id;
      const list = Array.isArray(links)
        ? links.filter((edge) => edge && typeof edge === "object" && (edge.from === id || edge.to === id))
        : [];
      const words = (edge, direction) => {
        const other = direction === "out" ? edge.to : edge.from;
        return String(other) + " — " + edgeKindWords(edge.kind, direction);
      };
      const outgoing = list.filter((edge) => edge.from === id).map((edge) => words(edge, "out"));
      const incoming = list.filter((edge) => edge.to === id).map((edge) => words(edge, "in"));
      const line = (label, items, empty) => label + " " + (items.length > 0 ? items.join(" · ") : empty);
      return [
        line("исходящие", outgoing, "нет — узел ничего не поручает"),
        line("входящие", incoming, "нет — узел корневой"),
      ].join("\n");
    }

    /* Модель паспорта: провайдер и семейство словами, без живого каталога. */
    function passportModelText(node) {
      const entry = node && typeof node === "object" ? node : {};
      const provider = String(entry.provider || "").trim();
      const model = String(entry.model || "").trim();
      const family = String(entry.family || "").trim();
      if (!provider && !model) {
        return "не задана — агента по этому узлу запустить нельзя, добавьте model";
      }
      const route = [provider, model].filter(Boolean).join(" · ");
      return family ? route + " · семейство " + family : route;
    }

    /*
     * Паспорт узла: объявление, а не живое состояние. Папка обмена сюда не
     * попадает — её связь с миром сами сообщения.
     */
    function nodePassportRows(node, links) {
      const entry = node && typeof node === "object" ? node : {};
      const id = String(entry.id || "");
      return [
        { key: "id", label: "id", value: id || "не задан" },
        { key: "role", label: "Роль", value: entry.role || "не задана — узел читается как исполнитель без специализации" },
        { key: "model", label: "Модель", value: passportModelText(entry) },
        { key: "brief", label: "Назначение", value: entry.brief || "не задано — добавьте brief, чтобы было понятно, что узел делает" },
        /* Спека — текст роли с Definition of Done; в паспорте только для чтения (0126 C3). */
        { key: "prompt", label: "Спека", value: entry.prompt || "не задана — роль без спеки" },
        { key: "agentPreset", label: "Пресет", value: entry.agentPreset || "не задан — агент наследует пресет родителя" },
        { key: "file", label: "Файл объявления", value: (entry.file || "structure/*.json") + (id ? " · узел " + id : "") },
        { key: "links", label: "Связи", value: passportLinksText(entry, links) },
      ];
    }

    /*
     * Строки живой вкладки: слово состояния с фразой, источник, отчёт,
     * сессия-владелец, расписание и следующий запуск, ветка. Паспортных
     * ключей здесь нет и быть не может — это разные вкладки.
     */
    function nodeStateRows(state) {
      const view = state && typeof state === "object" ? state : {};
      const word = String(view.word || "нет данных");
      const sentence = String(view.sentence || "");
      const session = String(view.session || "");
      const schedule = String(view.schedule || "");
      const next = String(view.next || "");
      return [
        { key: "state", label: "Состояние", value: sentence ? word + " — " + sentence : word },
        { key: "source", label: "Источник активности", value: String(view.source || "не виден — ни живого агента, ни журнала по этому узлу нет") },
        { key: "report", label: "Отчёт", value: String(view.report || "нет отчёта") },
        { key: "session", label: "Сессия-владелец", value: session || "не привязана — доставка идёт запуском от живой сессии" },
        { key: "schedule", label: "Расписание", value: (schedule || "выкл — узел не запускается сам, только по поручению")
          + (next ? " — следующий запуск " + next : "") },
        { key: "branch", label: "Ветка", value: String(view.branch || "нет — узел работает сам") },
      ];
    }

    /*
     * Whether a draft matches the workflow-shaped hierarchy: one root, delegate
     * chains, and reviewers covering the executors. Applicability is only
     * "delegate + review"; coverage issues are reported separately, because a
     * partially covered hierarchy is still a valid structure.
     */
    function workflowFit(draft) {
      const nodes = (draft && draft.nodes) || [];
      const edges = (draft && draft.edges) || [];
      const delegate = edges.filter((edge) => edge.kind === "delegate");
      const review = edges.filter((edge) => edge.kind === "review");
      const fit = { applicable: false, root: null, reviewers: [], uncovered: [], issues: [] };
      if (delegate.length === 0 || review.length === 0) return fit;
      fit.applicable = true;
      const incoming = new Set(delegate.map((edge) => edge.to));
      const reviewers = new Set(review.map((edge) => edge.to));
      /*
       * A node with its own schedule is an event source, not a waiting executor: it
       * has no delegate parent by design, so it must not be counted as a second root
       * and must not be demanded to have a reviewer.
       */
      const scheduled = new Set(nodes.filter((node) => node && node.schedule).map((node) => node.id));
      /*
       * Папка общего обмена — место, а не исполнитель: она не требует ни
       * делегата, ни оценки и не может быть вторым корнем иерархии.
       */
      const exchange = new Set(nodes.filter((node) => node && isFolderNode(node)).map((node) => node.id));
      const roots = nodes.filter((node) => !incoming.has(node.id) && !reviewers.has(node.id)
        && !scheduled.has(node.id) && !exchange.has(node.id));
      if (roots.length !== 1) {
        fit.issues.push(roots.length === 0 ? "нет корня иерархии" : "корней несколько: " + roots.map((node) => node.id).join(", "));
      }
      fit.root = roots[0] ? roots[0].id : null;
      fit.reviewers = [...reviewers];
      const reviewed = new Set(review.map((edge) => edge.from));
      /*
       * A worked result reaches the customer either through a reviewer or through a
       * return to the owner of the work. The graph declares the second case as
       * report to the root, so such an executor is covered, not forgotten.
       */
      const returned = new Set(
        edges.filter((edge) => edge.kind === "report" && edge.to === fit.root).map((edge) => edge.from),
      );
      const reachable = new Set(fit.root ? [fit.root] : []);
      let changed = true;
      while (changed) {
        changed = false;
        for (const edge of delegate) {
          if (reachable.has(edge.from) && !reachable.has(edge.to)) {
            reachable.add(edge.to);
            changed = true;
          }
        }
      }
      const executors = [...reachable].filter((id) => id !== fit.root && !reviewers.has(id)
        && !scheduled.has(id) && !exchange.has(id));
      fit.uncovered = executors.filter((id) => !reviewed.has(id) && !returned.has(id));
      if (fit.uncovered.length > 0) {
        fit.issues.push("ни оценки, ни возврата корню: " + fit.uncovered.join(", "));
      }
      return fit;
    }

    /*
     * Граница ошибок отрисовки. try/catch вокруг сборки body ловит только саму
     * сборку: исключение, которое React бросает при сверке дерева (объект вместо
     * строки в children, кривое поле папки), приходит уже после неё и гасит всю
     * панель — окно становится пустым, хотя запись на диск уже прошла. Так и
     * выглядела «неработающая» кнопка «Удалить папку» 2026-11-02.
     */
    class RenderGuard extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failure: null };
        this.retry = this.retry.bind(this);
      }

      static getDerivedStateFromError(failure) {
        return { failure };
      }

      componentDidCatch() {
        /* Текст ошибки уже в состоянии: карточка, а не пустое окно. */
      }

      retry() {
        this.setState({ failure: null });
        if (typeof this.props.onRetry === "function") this.props.onRetry();
      }

      render() {
        if (!this.state.failure) return this.props.children;
        return h("div", { style: S.error, role: "alert" },
          h("div", { style: S.errorTitle }, "Панель не смогла отрисовать структуру"),
          h("div", null, String((this.state.failure && this.state.failure.message) || this.state.failure)),
          h("div", { style: S.fix },
            "Что сделать: нажмите «Показать снова»; если повторяется — пришлите этот текст. Файлы структуры на диске целы."),
          h("button", { type: "button", style: S.button, onClick: this.retry }, "Показать снова"));
      }
    }

    function createView(readWorkspace) {
      return function StructureView() {
        const [status, setStatus] = React.useState(null);
        /* Черновик участников папки обмена: узел может быть между двумя и более воркспейсами. */
        const [exchangeDraft, setExchangeDraft] = React.useState(null);
        /* Сколько фактов обмена уже показано: по приросту панель говорит о новом письме. */
        const exchangeSeenRef = React.useRef(null);
        const [projects, setProjects] = React.useState([]);
        const [root, setRoot] = React.useState(null);
        const [payload, setPayload] = React.useState(null);
        const [picked, setPicked] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [note, setNote] = React.useState(null);
        const [current, setCurrent] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [copyState, setCopyState] = React.useState("idle");
        const [creating, setCreating] = React.useState(null);
        const [linkOpen, setLinkOpen] = React.useState(false);
        const [linkKind, setLinkKind] = React.useState("delegate");
        const [linkDirection, setLinkDirection] = React.useState("from");
        const [linkTarget, setLinkTarget] = React.useState("");
        const [linkError, setLinkError] = React.useState(null);
        const [linking, setLinking] = React.useState(false);
        const [activeIds, setActiveIds] = React.useState(() => new Set());
        /* Live agents of the host, including children of other sessions/workspaces. */
        const [liveNodes, setLiveNodes] = React.useState(() => new Set());
        /* How many live agents in this workspace name no declared node. */
        const [liveUnknown, setLiveUnknown] = React.useState(0);
        /*
         * Working sessions the route could not attach to a node: they are shown by
         * one with a label and a bind action, instead of being summed into "agent
         * without role". A node chosen in the select is kept per session id.
         */
        const [liveUnattributed, setLiveUnattributed] = React.useState([]);
        const [unattributedPick, setUnattributedPick] = React.useState({});
        /* Whose session the structure sees on a node, and where that link comes from. */
        const [liveBinding, setLiveBinding] = React.useState(null);
        /* Where each node's activity comes from: a live agent or a session journal. */
        const [liveSources, setLiveSources] = React.useState(() => ({}));
        const [activityKnown, setActivityKnown] = React.useState(false);
        const [runStates, setRunStates] = React.useState({});
        /* The whole history: a branch needs its steps, not just the last state. */
        const [runList, setRunList] = React.useState([]);
        /* Facts of exchange with the outside; never its content. */
        const [exchange, setExchange] = React.useState(null);
        const [exchangeOpen, setExchangeOpen] = React.useState(null);
        /*
         * Плашка обязанностей (задание 0077): duty with ok:false из
         * /api/obligations видна вверху панели, пока долг не снят. Ответ без
         * обязанностей и ошибка сети плашку не показывают — панель работает как
         * раньше.
         */
        const [obligationsBanner, setObligationsBanner] = React.useState(null);
        /* Итог кнопки «Проверить ящики»: число непрочитанных из /api/exchange/scan. */
        const [exchangeScanNote, setExchangeScanNote] = React.useState(null);
        const [exchangeScanBusy, setExchangeScanBusy] = React.useState(false);
        /* Какое письмо закрывается ack-ом (0128): путь факта, пока идёт POST. */
        const [exchangeCloseBusy, setExchangeCloseBusy] = React.useState(null);
        /* Whether the session that owns this view is working right now. */
        const [selfRunning, setSelfRunning] = React.useState(false);
        const [builder, setBuilder] = React.useState(null);
        /* A quick add: one node without opening the whole builder. */
        const [newNode, setNewNode] = React.useState(null);
        const [newNodeError, setNewNodeError] = React.useState(null);
        const [newNodeBusy, setNewNodeBusy] = React.useState(false);
        /*
         * Редактор узла — поповер у самой карточки: id, роль, модель, назначение,
         * расписание и связи. Раскрывается от узла, а не панелью внизу.
         */
        const [nodeEditor, setNodeEditor] = React.useState(null);
        const [nodeEditorError, setNodeEditorError] = React.useState(null);
        const [nodeEditorBusy, setNodeEditorBusy] = React.useState(false);
        /*
         * Подтверждение удаления узла — окном панели, а не window.confirm:
         * браузер молча возвращает false, если человек однажды включил
         * «предотвращать дополнительные диалоги», и кнопка «Удалить узел»
         * выглядит нерабочей: запроса нет, текста нет. Панель спрашивает сама.
         */
        const [nodeDeleteAsk, setNodeDeleteAsk] = React.useState(false);
        const [editorEdge, setEditorEdge] = React.useState({ kind: "delegate", direction: "from", target: "" });
        /* Значения на момент открытия: по ним видно, терять ли правки при закрытии. */
        const [nodeEditorBaseline, setNodeEditorBaseline] = React.useState(null);
        /* «Сведения об узле» — модальное окно; с 0143 единственный вход — шестерёнка. */
        const [nodeInfo, setNodeInfo] = React.useState(null);
        /* 0184: вкладка валидатора у координатора — выезд, фокус-рамка и окно блока. */
        const [validatorHover, setValidatorHover] = React.useState(false);
        const [validatorFocused, setValidatorFocused] = React.useState(false);
        const [validatorOpen, setValidatorOpen] = React.useState(false);
        /*
         * Выезд — по таймерам, а не мгновенно: курсор, идущий мимо блока, не
         * раскрывает панель (160 мс), уход закрывает через 250 мс, чтобы
         * курсор успел перейти в саму панель. prefers-reduced-motion убирает и
         * задержки, и переходы.
         */
        const validatorTimer = React.useRef(null);
        const validatorHoverIntent = (inside) => {
          if (validatorTimer.current) {
            clearTimeout(validatorTimer.current);
            validatorTimer.current = null;
          }
          if (!inside && !validatorHover) return;
          const reduced = prefersReducedMotion();
          const delay = reduced ? 0 : (inside ? VALIDATOR_TAB.hover.delayMs : VALIDATOR_TAB.hover.closeDelayMs);
          if (delay <= 0) {
            setValidatorHover(inside);
            return;
          }
          validatorTimer.current = setTimeout(() => {
            validatorTimer.current = null;
            setValidatorHover(inside);
          }, delay);
        };
        React.useEffect(() => () => {
          if (validatorTimer.current) clearTimeout(validatorTimer.current);
          validatorTimer.current = null;
        }, []);
        /* Вкладка окна узла (0122): паспорт, состояние или настройки. */
        const [nodeTab, setNodeTab] = React.useState("info");
        /* Диалог подтверждения крестика: "node" или "folder"; null — диалога нет. */
        const [closeConfirm, setCloseConfirm] = React.useState(null);
        /*
         * Редактор папки обмена: поповер у портала. Здесь ящик (path + root),
         * метки участников и имя контракта; отсюда же ревизия контракта
         * и удаление папки — папка живёт в graph.json, а не в узлах.
         */
        const [folderEditor, setFolderEditor] = React.useState(null);
        const [folderEditorError, setFolderEditorError] = React.useState(null);
        const [folderEditorBusy, setFolderEditorBusy] = React.useState(false);
        /* Кнопка «Принять папку» (задание 0047): своя занятость, чтобы запись квитанции не блокировала правку папки. */
        const [folderAcceptBusy, setFolderAcceptBusy] = React.useState(false);
        /*
         * Поиск по реестру воркспейсов в редакторе папки (задание 0024): метка
         * участника выбирается из списка, поле ввода — только для поиска.
         */
        const [participantSearch, setParticipantSearch] = React.useState("");
        /*
         * Подтверждение удаления папки — окном панели, а не window.confirm.
         * Браузер молча возвращает false, если человек однажды включил
         * «предотвращать дополнительные диалоги», и кнопка тогда выглядит
         * нерабочей: запроса нет, текста нет. Панель обязана спрашивать сама.
         */
        const [folderDeleteAsk, setFolderDeleteAsk] = React.useState(false);
        /* Значения папки на момент открытия — та же проверка «изменено». */
        const [folderEditorBaseline, setFolderEditorBaseline] = React.useState(null);
        /*
         * Библиотека узлов: колонка слева, в свёрнутом виде — корешок 44 px.
         * Состояние читается синхронно в инициализаторе (макет §3.7): после
         * отрисовки человек успел бы увидеть 250 px, которые через кадр станут
         * 44. Ошибка хранилища — умолчание «развёрнуто», без плашки.
         */
        const [libraryOpen, setLibraryOpen] = React.useState(() => uiStore.read(null).libraryOpen);
        /* Какая иконка корешка в фокусе: кольцо внутри плитки (2 px, смещение -3). */
        const [spineFocus, setSpineFocus] = React.useState(null);
        /* Корешок ниже 190 px прячет надпись: две буквы — шум, иконки остаются. */
        const [spineShort, setSpineShort] = React.useState(false);
        /*
         * Просвет барьера «воркспейс | вне»: 20 по умолчанию, хранится на корень.
         * Читается при первом payload.root (см. ниже), пишется на изменение.
         */
        const [outside, setOutside] = React.useState(OUTSIDE_MIN);
        const [outsideFocus, setOutsideFocus] = React.useState(false);
        /* Заморозка колонок на время переноса: null — не тянем, число — заморожено. */
        const [barrierColumns, setBarrierColumns] = React.useState(null);
        /* Видимая ширина канвы: от неё зависит вторая колонка порталов. */
        const [canvasWidth, setCanvasWidth] = React.useState(0);
        /* Вынос карточки: призрак под курсором и точка постановки. */
        const [carry, setCarry] = React.useState(null);
        const [libraryNote, setLibraryNote] = React.useState(null);
        const [launch, setLaunch] = React.useState(null);
        const [launchDepth, setLaunchDepth] = React.useState(2);
        const [launchParallelism, setLaunchParallelism] = React.useState(2);
        const [callCopy, setCallCopy] = React.useState("idle");
        const [builderCheck, setBuilderCheck] = React.useState(null);
        const [builderError, setBuilderError] = React.useState(null);
        const [builderBusy, setBuilderBusy] = React.useState(false);
        const [nodeForm, setNodeForm] = React.useState({ id: "", role: "", model: "", brief: "", agentPreset: "" });
        const [modelForm, setModelForm] = React.useState({ alias: "", provider: "", model: "", family: "" });
        const [availableModels, setAvailableModels] = React.useState(null);
        const [modelsError, setModelsError] = React.useState(null);
        const [availablePresets, setAvailablePresets] = React.useState(null);
        const [presetsError, setPresetsError] = React.useState(null);
        const [edgeForm, setEdgeForm] = React.useState({ from: "", to: "", kind: "delegate" });
        const [editingNodeId, setEditingNodeId] = React.useState(null);
        const [editingModelAlias, setEditingModelAlias] = React.useState(null);
        const [workflow, setWorkflow] = React.useState({ status: "checking" });
        const [workflowOffer, setWorkflowOffer] = React.useState(false);
        const [workflowInstall, setWorkflowInstall] = React.useState({ status: "idle" });
        /* Второй путь при отсутствии движка: где объявляется связь. */
        const [engineConnectHint, setEngineConnectHint] = React.useState(false);
        /* Freshness of the build: installed pair vs the released tarball. */
        const [workflowCheck, setWorkflowCheck] = React.useState({ status: "idle" });
        /*
         * Версия структуры (задание 0105): сравнение с последним релизом идёт
         * только по кнопке — панель не ходит в сеть при открытии.
         */
        const [release, setRelease] = React.useState({ status: "idle" });
        const [releaseUpdate, setReleaseUpdate] = React.useState({ status: "idle" });
        /*
         * Раскладка. positions — то, что человек уже подвинул, но ещё не
         * перечитал с диска; пустая карта значит «всё на расчётных местах».
         * Сохранение идёт своим маршрутом, движение не ждёт сети.
         */
        const [positions, setPositions] = React.useState({});
        const [dragging, setDragging] = React.useState(null);
        const [focusedNode, setFocusedNode] = React.useState(null);
        const [live, setLive] = React.useState("");
        const [layoutError, setLayoutError] = React.useState(null);
        const [layoutNotice, setLayoutNotice] = React.useState(null);
        const positionsRef = React.useRef({});
        const saveTimerRef = React.useRef(null);
        const pendingRef = React.useRef({});
        const dragRef = React.useRef(null);
        const suppressClickRef = React.useRef(0);
        const svgRef = React.useRef(null);
        /* Канва-контейнер: вынос из библиотеки считается от её прямоугольника. */
        const canvasRef = React.useRef(null);
        /* Текущий вынос в ref: Esc гасит его раньше, чем придёт pointerup. */
        const carryRef = React.useRef(null);
        /* Барьер: текущее значение, корень хранения, перенос и отложенная запись. */
        const outsideRef = React.useRef(OUTSIDE_MIN);
        const outsideRootRef = React.useRef(null);
        const outsideDragRef = React.useRef(null);
        const outsideSaveRef = React.useRef(null);
        /* Число колонок порталов: помним, чтобы гистерезис 24 px работал. */
        const columnsRef = React.useRef(1);
        /* Корешок: его высота решает, видна ли надпись. */
        const libraryRef = React.useRef(null);
        /* Портал и карточка-список: портал открывает её и уводит в неё фокус. */
        const portalRef = React.useRef(null);
        const exchangeCardRef = React.useRef(null);
        const [portalFocus, setPortalFocus] = React.useState(false);
        const [portalHot, setPortalHot] = React.useState(false);

        const load = React.useCallback((nextRoot, keepPicked = false) => {
          setBusy(true);
          setError(null);
          setCopyState("idle");
          const workspace = currentWorkspace(readWorkspace ? readWorkspace() : null);
          Promise.all([fetchJson("/api/status"), fetchJson("/api/projects")])
            .then(([statusBody, projectsBody]) => {
              setStatus(statusBody);
              setCurrent(workspace ? { path: workspace.path, title: workspace.title, sessionId: workspace.sessionId } : null);
              const list = (projectsBody && projectsBody.projects) || [];
              setProjects(list);
              let active = nextRoot || (workspace && workspace.path) || null;
              let locationNote = null;
              if (active) {
                const match = list.find((project) => samePath(project.root, active));
                if (!match) {
                  const shown = statusBody.defaultRoot || (list[0] && list[0].root) || null;
                  locationNote = {
                    text: "Текущий воркспейс «" + ((workspace && workspace.title) || rootLabel(active))
                      + "» не входит в список проектов панели. Показан «" + (shown ? rootLabel(shown) : "другой проект")
                      + "». Чтобы открыть текущий, добавьте его путь в roots (cordis.patch.yml).",
                  };
                  active = shown;
                }
              } else {
                active = statusBody.defaultRoot || (list[0] && list[0].root) || null;
              }
              setNote(locationNote);
              setRoot(active);
              if (!active) {
                setPayload(null);
                return null;
              }
              return fetchJson("/api/graph?root=" + encodeURIComponent(active)).then((graphBody) => {
                setPayload(graphBody);
                if (!keepPicked) setPicked(null);
              });
            })
            .catch((failure) => setError({
              message: failure && failure.message ? failure.message : String(failure),
              fix: failure && failure.fix ? failure.fix : "Нажмите «Обновить». Если повторяется — проверьте, что плагин загружен.",
            }))
            .finally(() => setBusy(false));
        }, []);

        React.useEffect(() => {
          const service = readWorkspace ? readWorkspace() : null;
          const list = service && service.sessions && service.sessions.list;
          const sessionId = current && current.sessionId;
          const nodes = (payload && payload.graph && payload.graph.nodes) || [];
          const update = () => {
            const next = new Set();
            if (list && sessionId && nodes.length > 0) {
              try {
                for (const id of activeNodeIds(list.getSnapshot(), sessionId, nodes)) next.add(id);
              } catch { /* the catalog may be mid-load */ }
            }
            for (const [node, run] of Object.entries(runStates)) {
              if (run && run.state === "running") next.add(node);
            }
            /* An agent of any session in this workspace is activity of its node. */
            for (const id of liveNodes) next.add(id);
            /*
             * The session that owns the structure is itself a participant: while
             * it works, the declared node shows "работает" — otherwise the panel
             * would call a working coordinator finished.
             */
            let working = false;
            if (list && sessionId) {
              try {
                const snapshot = list.getSnapshot();
                working = Boolean(snapshot && snapshot.byId && snapshot.byId[sessionId] && snapshot.byId[sessionId].running === true);
              } catch { working = false; }
            }
            setSelfRunning(working);
            if (working && payload && payload.selfNode) next.add(payload.selfNode);
            setActiveIds(next);
          };
          update();
          return list && typeof list.subscribe === "function" ? list.subscribe(update) : undefined;
        }, [payload, current, runStates, liveNodes]);

        /*
         * Exchange facts follow the selected workspace and are re-read on a timer:
         * the box gets new letters while a person is looking at the schema, and a
         * panel that only reads on load would show yesterday's picture.
         */
        React.useEffect(() => {
          if (!root) { setExchange(null); setExchangeOpen(null); return undefined; }
          let stopped = false;
          setExchangeOpen(null);
          const tick = () => {
            fetchJson("/api/exchange?root=" + encodeURIComponent(root))
              .then((body) => {
                if (stopped) return;
                const before = exchangeSeenRef.current;
                const total = body && typeof body.total === "number" ? body.total : 0;
                if (before !== null && total > before) {
                  setLive("в папке обмена новое сообщение: " + (total - before) + " (всего " + total + ")");
                }
                exchangeSeenRef.current = total;
                setExchange(body);
              })
              .catch(() => { if (!stopped) setExchange({ failed: true }); });
          };
          tick();
          const timer = setInterval(tick, 10000);
          return () => { stopped = true; clearInterval(timer); };
        }, [root]);

        /*
         * Обязанности структуры (задание 0077) читаются на выбранный корень.
         * Плашка — только для невыполненной обязанности: структура без объявленных
         * обязанностей и недоступный маршрут оставляют панель без плашки.
         */
        React.useEffect(() => {
          if (!root) { setObligationsBanner(null); setExchangeScanNote(null); return undefined; }
          let stopped = false;
          setExchangeScanNote(null);
          fetchJson("/api/obligations?root=" + encodeURIComponent(root))
            .then((body) => {
              if (stopped) return;
              const failed = body && body.ok === true && Array.isArray(body.obligations)
                ? body.obligations.filter((row) => row && row.ok === false)
                : [];
              if (failed.length === 0) { setObligationsBanner(null); return; }
              const first = failed[0];
              setObligationsBanner({
                id: String(first.id || "обязанность"),
                detail: String(first.detail || ""),
                total: failed.length,
              });
            })
            .catch(() => { if (!stopped) setObligationsBanner(null); });
          return () => { stopped = true; };
        }, [root]);

        /*
         * Esc закрывает список фактов под схемой и возвращает фокус порталу:
         * карточка далеко внизу, и после закрытия человеку нужен обратный путь.
         */
        React.useEffect(() => {
          if (exchangeOpen === null) return undefined;
          if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
          const onKey = (event) => {
            if (!event || event.key !== "Escape") return;
            setExchangeOpen(null);
            const portal = portalRef.current;
            if (portal && typeof portal.focus === "function") portal.focus();
            setLive("список фактов обмена закрыт, фокус вернулся порталу");
          };
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        }, [exchangeOpen]);

        React.useEffect(() => {
          if (!root) { setRunStates({}); setRunList([]); setActivityKnown(false); return undefined; }
          let stopped = false;
          const tick = () => {
            if (stopped) return;
            fetchJson("/api/activity?root=" + encodeURIComponent(root))
              .then((body) => {
                if (stopped) return;
                const next = {};
                for (const run of (body && body.runs) || []) {
                  /* Newest first: the first record of a node is its current state. */
                  if (run && run.node && !next[run.node]) next[run.node] = run;
                }
                setRunStates(next);
                setRunList(Array.isArray(body && body.runs) ? body.runs : []);
                setActivityKnown(true);
              })
              .catch(() => { /* activity is optional; the schedule stays readable */ });
          };
          tick();
          const timer = setInterval(tick, 2000);
          return () => { stopped = true; clearInterval(timer); };
        }, [root]);

        /*
         * Один разбор ответа /api/live на все случаи: опрос по таймеру и обновление
         * после привязки сессии. Панель не досчитывает активность сама — она кладёт
         * в состояние ровно то, что назвал маршрут, вместе с непривязанными сессиями.
         */
        function applyLive(body) {
          const view = liveView(body);
          setLiveNodes(new Set(view.active));
          setLiveUnknown(view.unknown);
          setLiveUnattributed(view.unattributed);
          /* The route computes the projection; the panel only words it. */
          setLiveBinding(body && body.binding && body.binding.node ? body.binding : null);
          /* The route names the source of the activity; the panel keeps it. */
          setLiveSources(activitySources(body));
          return view;
        }

        /*
         * Who works in this workspace, from any session. The route sees the whole
         * host; the local catalog sees only this view's children. The poll is slow
         * (5 s) because it only adds a "works" mark. A broken route must stay
         * silent: clearing the set is honest, keeping stale activity is not.
         */
        React.useEffect(() => {
          if (!root) {
            setLiveNodes(new Set()); setLiveUnknown(0); setLiveUnattributed([]); setLiveBinding(null); setLiveSources({});
            return undefined;
          }
          let stopped = false;
          const tick = () => {
            if (stopped) return;
            fetchJson("/api/live?root=" + encodeURIComponent(root))
              .then((body) => { if (!stopped) applyLive(body); })
              .catch(() => {
                /* An error means "no data", not "free" and not "busy". */
                if (stopped) return;
                setLiveNodes(new Set());
                setLiveUnknown(0);
                setLiveUnattributed([]);
                setLiveBinding(null);
                setLiveSources({});
              });
          };
          tick();
          const timer = setInterval(tick, 5000);
          return () => { stopped = true; clearInterval(timer); };
        }, [root]);

        /*
         * Немедленное обновление ленты после записи привязки: ждать следующего
         * опроса (5 с) незачем — ответ маршрута уже учитывает node.session.
         * Ошибка молчит: живая лента необязательна, привязка уже записана.
         */
        function refreshLive() {
          if (!root) return Promise.resolve(null);
          return fetchJson("/api/live?root=" + encodeURIComponent(root))
            .then((body) => applyLive(body))
            .catch(() => null);
        }

        React.useEffect(() => { checkWorkflow(); }, []);

        /* Esc leaves the builder: the top bar alone is easy to miss in a long form. */
        React.useEffect(() => {
          if (!builder) return undefined;
          if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
          const onKey = (event) => { if (event && event.key === "Escape") closeBuilder(); };
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        }, [builder]);

        /*
         * Esc ведёт себя как крестик: окно закрывается сразу, редактор — через
         * ту же проверку правок. В диалоге подтверждения Esc означает
         * «Продолжить редактирование»: случайно не терять правки.
         */
        React.useEffect(() => {
          if (!nodeInfo && !nodeEditor && !folderEditor && !closeConfirm) return undefined;
          if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
          const onKey = (event) => {
            if (!event || event.key !== "Escape") return;
            event.preventDefault();
            if (closeConfirm) { setCloseConfirm(null); return; }
            if (nodeEditor) { requestCloseNodeEditor(); return; }
            if (nodeInfo) { requestCloseNodeWindow(); return; }
            if (folderEditor) { requestCloseFolderEditor(); }
          };
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        }, [nodeInfo, nodeEditor, nodeEditorBaseline, folderEditor, folderEditorBaseline, closeConfirm]);

        const rootRef = React.useRef(null);
        const userPickedRef = React.useRef(false);
        React.useEffect(() => { rootRef.current = root; }, [root]);

        React.useEffect(() => {
          load(null);
          /*
           * The client workspace service may arrive after this view mounts (it is
           * injected asynchronously). Until the workspace matches the open one,
           * keep asking: otherwise the panel sticks to the default project.
           */
          const sync = () => {
            if (userPickedRef.current) return;
            const workspace = currentWorkspace(readWorkspace ? readWorkspace() : null);
            if (!workspace) return;
            if (!rootRef.current || !samePath(rootRef.current, workspace.path)) load(workspace.path);
          };
          const timers = [600, 1600, 3200].map((delay) => setTimeout(sync, delay));
          return () => { for (const timer of timers) clearTimeout(timer); };
        }, []);

        const nodesById = React.useMemo(() => {
          const map = new Map();
          for (const node of (payload && payload.graph && payload.graph.nodes) || []) map.set(node.id, node);
          return map;
        }, [payload]);

        /* Новый ответ графа — новые позиции с диска: локальные надстройки не нужны. */
        React.useEffect(() => {
          positionsRef.current = {};
          setPositions({});
        }, [payload]);

        React.useEffect(() => { outsideRef.current = outside; }, [outside]);

        /*
         * Просвет барьера — на воркспейс: читается синхронно при первом
         * payload.root. setState в рендере того же компонента перерисовывает до
         * коммита, поэтому первого кадра с чужим просветом не видно (макет
         * §3.7, приём «adjust state during render»). Корень сравнивается по
         * строке: при переключении воркспейса просвет другой.
         */
        if (payload && payload.root && outsideRootRef.current !== payload.root) {
          outsideRootRef.current = payload.root;
          const storedOutside = uiStore.read(payload.root).outside;
          if (storedOutside !== outside) setOutside(storedOutside);
        }

        /*
         * Видимая ширина канвы. Вторая колонка порталов зависит от неё, поэтому
         * пересчёт идёт на resize и после смены палитры — «складывание колонок
         * только на pointerup и resize» (макет §4.5).
         */
        React.useEffect(() => {
          const measure = () => {
            const node = canvasRef.current;
            const width = node && typeof node.clientWidth === "number" ? node.clientWidth : 0;
            if (!width) return;
            setCanvasWidth((prev) => (prev === width ? prev : width));
          };
          measure();
          if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
          window.addEventListener("resize", measure);
          return () => window.removeEventListener("resize", measure);
        }, [payload, libraryOpen, outside, builder]);

        /*
         * Корешок ниже 190 px: надпись скрыта, иконки остаются (макет §3.4).
         * Обрезка многоточием — чистый CSS, замер нужен только для этой границы.
         */
        React.useEffect(() => {
          const node = libraryRef.current;
          if (!node || typeof node.getBoundingClientRect !== "function") return undefined;
          const apply = () => {
            const height = node.getBoundingClientRect().height;
            const short = height > 0 && height < 190;
            setSpineShort((prev) => (prev === short ? prev : short));
          };
          apply();
          if (typeof ResizeObserver === "function") {
            const observer = new ResizeObserver(apply);
            observer.observe(node);
            return () => observer.disconnect();
          }
          if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
          window.addEventListener("resize", apply);
          return () => window.removeEventListener("resize", apply);
        }, [payload, libraryOpen, builder]);

        /* Отложенная запись просвета не должна пережить вид. */
        React.useEffect(() => () => {
          if (outsideSaveRef.current) clearTimeout(outsideSaveRef.current);
        }, []);

        /* Таймер паузы не должен пережить вид: иначе сохранение после закрытия. */
        React.useEffect(() => () => {
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        }, []);

        function copySample() {
          try {
            const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : null;
            if (clipboard && typeof clipboard.writeText === "function") {
              clipboard.writeText(SAMPLE_TEXT)
                .then(() => setCopyState("done"))
                .catch(() => setCopyState("manual"));
              return;
            }
          } catch {
            /* fall through to the manual hint below */
          }
          setCopyState("manual");
        }

        function checkWorkflow() {
          setWorkflow({ status: "checking" });
          /* The plugin accepts ?root= only for a root it may read; the open project is one. */
          const query = root ? "?root=" + encodeURIComponent(root) : "";
          return fetch("/workflow/api/status" + query, { headers: { Accept: "application/json" }, cache: "no-store" })
            .then((response) => {
              if (!response.ok) throw new Error("HTTP " + response.status);
              return response.json();
            })
            .then((body) => {
              /* Installed means the plugin answered with its own identity, not a bare 200. */
              if (!body || !body.plugin || !body.plugin.name) {
                setWorkflow({ status: "missing" });
                return false;
              }
              setWorkflow({
                status: "installed",
                version: body.plugin.version || "",
                tool: body.plugin.tool || "",
              });
              return true;
            })
            .catch(() => {
              setWorkflow({ status: "missing" });
              return false;
            });
        }

        function startHierarchy() {
          setWorkflowOffer(true);
          checkWorkflow().then((installed) => {
            if (!installed) return;
            setWorkflowOffer(false);
            createStructure("hierarchy");
          });
        }

        /*
         * Install through the host: the panel only posts its configured spec.
         * The answer is one of applied / restart-required / refusal with a code.
         */
        /*
         * Install and update go through one path: the only difference is that an
         * update removes the installed bundle first, and asks before replacing a
         * local folder installation with the released package.
         */
        /*
         * Freshness is checked on demand: the release archive is fetched only
         * here, never on page load. Outdated means either layer is behind.
         */
        function checkFreshness() {
          if (workflowCheck.status === "checking") return;
          setWorkflowCheck({ status: "checking" });
          fetchJson("/api/workflow-check?root=" + encodeURIComponent(root || ""), { method: "POST" })
            /* `...body` first: the route's own `status: 200` must not overwrite the UI state. */
            .then((body) => setWorkflowCheck({ ...body, status: "done" }))
            .catch((failure) => setWorkflowCheck({
              status: "error",
              message: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Проверьте сеть и повторите.",
            }));
        }

        /*
         * Версия структуры против релиза (задание 0105): проверка идёт по кнопке,
         * а сбой сети не бросается наружу — карточка показывает причину и повтор.
         */
        function checkRelease() {
          if (release.status === "checking") return Promise.resolve();
          setRelease({ status: "checking" });
          const query = root ? "?root=" + encodeURIComponent(root) : "";
          return fetchJson("/api/release" + query)
            .then((body) => {
              if (body && body.error) {
                setRelease({ status: "error", message: String(body.error), fix: "Проверьте сеть и повторите." });
                return;
              }
              setRelease({ ...body, status: "done" });
            })
            .catch((failure) => setRelease({
              status: "error",
              message: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Проверьте сеть и повторите.",
            }));
        }

        /*
         * Пакет ставится тем же установщиком, что и Workflow. Ссылка на каталог
         * обновляется иначе — сервер делает там git pull --ff-only (задание
         * 0107); грязное дерево и упавший pull приходят отказом 409, и панель
         * показывает причину с рецептом как есть, ничего не пряча.
         */
        function updateRelease() {
          if (releaseUpdate.status === "updating") return Promise.resolve();
          setReleaseUpdate({ status: "updating" });
          const query = root ? "?root=" + encodeURIComponent(root) : "";
          return fetch(BASE + "/api/release/update" + query, { method: "POST", headers: { Accept: "application/json" } })
            .then((response) => response.json().then((body) => {
              if (!response.ok) {
                if (response.status === 409) {
                  return {
                    updated: false,
                    reason: (body && (body.reason || body.error)) || "обновление недоступно",
                    fix: (body && body.fix) || "",
                  };
                }
                const failure = new Error((body && (body.reason || body.error)) || ("HTTP " + response.status));
                if (body && body.fix) failure.fix = body.fix;
                throw failure;
              }
              return body || {};
            }))
            .then((body) => {
              if (body.updated) {
                setReleaseUpdate({ status: "done", version: body.version || "", reason: body.reason || "" });
                checkRelease();
                return;
              }
              setReleaseUpdate({
                status: "refused",
                reason: body.reason || "обновление не выполнено",
                fix: body.fix || "",
              });
            })
            .catch((failure) => setReleaseUpdate({
              status: "error",
              message: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Проверьте сеть и повторите.",
            }));
        }

        function runWorkflowInstall(action) {
          const busy = action === "update" ? "updating" : "installing";
          if (workflowInstall.status === busy) return;
          if (action === "update") {
            const spec = status && status.workflow ? status.workflow.installSpec : "";
            const current = (workflowCheck && workflowCheck.current) || {};
            /*
             * The person must not have to guess. When the plugin is a link to a local
             * folder, reinstalling from the release detaches that folder — the panel
             * says so and recommends cancelling; when it is a package, it says the
             * update is safe for their files and only rewrites the engine.
             */
            const verdict = current.link
              ? "РЕКОМЕНДАЦИЯ: отменить. Плагин подключён локальной папкой:\n"
                + (current.source || "link") + "\n"
                + "Обновление удалит эту связь и поставит пакет из релиза — правки в локальной папке перестанут применяться.\n"
                + "Обновляйтесь, только если сознательно переходите с локальной папки на релиз.\n\n"
              : "Плагин установлен пакетом — ваши файлы обновление не затрагивает. Движок будет перезаписан "
                + "(init --force), ключ приёмки может быть пересоздан: прошлые записи остаются, новые подписи пойдут новым ключом.\n\n";
            const question = "Обновить Workflow — оба слоя?\n\n"
              + verdict
              + "1. Плагин dsh-workflow-console будет удалён и поставлен заново из:\n"
              + (spec || "(workflowInstallSpec)") + "\n"
              + "2. Движок в этом воркспейсе обновится из спеки нового пакета (init --force).";
            if (typeof window !== "undefined" && !window.confirm(question)) return;
          }
          setWorkflowInstall({ status: busy });
          const target = root ? "&root=" + encodeURIComponent(root) : "";
          fetch(BASE + "/api/workflow-install" + (action === "update" ? "?action=update" + target : ""), { method: "POST", headers: { Accept: "application/json" } })
            .then((response) => response.json()
              .then((body) => ({ ok: response.ok, status: response.status, body }))
              .catch(() => ({ ok: response.ok, status: response.status, body: null })))
            .then(({ ok, status: code, body }) => {
              if (!ok) {
                const failure = new Error((body && body.error) || ("HTTP " + code));
                failure.fix = body && body.fix;
                failure.code = body && body.code;
                throw failure;
              }
              if (body && body.application === "restart-required") {
                setWorkflowInstall({
                  status: "restart",
                  reason: (body && body.restartReason) || "новый слой плагина применится после перезапуска DSH",
                });
                return;
              }
              const engine = body && body.engine;
              setWorkflowInstall({
                status: "done",
                version: (body && body.version) || "",
                action,
                engine: engine && engine.updated ? (engine.version || "") : "",
                engineReason: engine && !engine.updated ? String(engine.reason || "") : "",
              });
              checkWorkflow();
              if (action === "update" && root) {
                fetchJson("/api/graph?root=" + encodeURIComponent(root))
                  .then((graphBody) => setPayload(graphBody))
                  .catch(() => {});
              }
            })
            .catch((failure) => {
              /*
               * "already-installed" is the manager saying the plugin is there:
               * that is a fact, not a failure. The version comes from the status
               * check, so the panel shows what is actually loaded.
               */
              if (failure && failure.code === "already-installed") {
                setWorkflowInstall({ status: "present", action });
                checkWorkflow();
                return;
              }
              setWorkflowInstall({
                status: "error",
                message: failure && failure.message ? failure.message : String(failure),
                fix: (failure && failure.fix) || "Проверьте спеку установки и повторите.",
                code: failure && failure.code ? failure.code : "",
                action,
              });
            });
        }

        function installWorkflow() {
          runWorkflowInstall("install");
        }

        /*
         * Deploying the engine is a different action from installing the plugin:
         * the engine lives inside this workspace (`docs/subagent-workflow`), and the
         * route belongs to the workflow console (0.7.0+). The panel only calls it,
         * with the explicit confirmation the route requires.
         */
        function deployWorkflow() {
          if (workflowInstall.status === "deploying") return;
          const target = root || (payload && payload.root) || "";
          if (typeof window !== "undefined" && !window.confirm(
            "Развернуть движок Workflow в этом воркспейсе?\n\n"
            + "Появятся docs/subagent-workflow, docs/tasks и локальные git-хуки.\n"
            + "Папка: " + target,
          )) return;
          setWorkflowInstall({ status: "deploying" });
          fetch("/workflow/api/deploy", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ confirm: true, root: target }),
          })
            .then((response) => response.json()
              .then((body) => ({ ok: response.ok, status: response.status, body }))
              .catch(() => ({ ok: response.ok, status: response.status, body: null })))
            .then(({ ok, status: code, body }) => {
              if (!ok) {
                const failure = new Error((body && body.error) || ("HTTP " + code));
                failure.fix = (body && body.fix)
                  || "Развернуть можно панелью workflow 0.7.0 и новее: обновите её или разверните на вкладке «Совместимость».";
                throw failure;
              }
              setWorkflowInstall({ status: "deployed", version: (body && body.version) || "" });
              /* Re-read the graph: the engine state changed, the route reads it. */
              fetchJson("/api/graph?root=" + encodeURIComponent(target))
                .then((graphBody) => setPayload(graphBody))
                .catch(() => {});
            })
            .catch((failure) => setWorkflowInstall({
              status: "error",
              message: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Проверьте, что папка воркспейса доступна, и повторите.",
              code: "",
            }));
        }

        function updateWorkflow() {
          runWorkflowInstall("update");
        }

        /*
         * «Подключить существующий» не пишет ни конфиг профиля, ни карту: эта
         * половина принадлежит панели workflow. Кнопка называет оба места, где
         * связь объявляется декларативно, — человеку не нужно угадывать файл.
         */
        function connectExistingEngine() {
          setEngineConnectHint(true);
        }

        /*
         * Карточка версии структуры (задание 0105): текущая сборка, версия в
         * репозитории и кнопка «Обновить» — только когда обновление безопасно.
         * Ссылка на каталог обновляется в репозитории, поэтому кнопки нет, а
         * причина названа словами; сбой проверки даёт повтор, а не пустую карточку.
         */
        function renderReleaseStrip() {
          const currentVersion = release.current
            || (status && status.plugin ? status.plugin.version : "")
            || "неизвестно";
          const busy = releaseUpdate.status === "updating";
          const done = release.status === "done";
          /* Действие зависит от режима установки: пакет из релиза или pull связанного каталога. */
          const action = done ? releaseAction({ ...release, current: currentVersion }) : { enabled: false };
          const line = done
            ? releaseLabel({ ...release, current: currentVersion })
            : "структура " + currentVersion
              + (release.status === "checking" ? " · проверяю релиз…" : " · релиз не проверялся");
          return h("div", {
            "data-release-card": "1",
            style: { ...S.card, display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", padding: "8px 10px", maxWidth: "100%" },
          },
            h("span", { style: { fontWeight: 600, fontSize: "12px" } }, "Версия"),
            h("span", { style: { color: T.secondary, fontSize: "12px" } }, line),
            release.status === "checking"
              ? null
              : h("button", {
                type: "button",
                style: S.button,
                disabled: busy,
                title: "сравнить текущую сборку с последним релизом в репозитории",
                onClick: checkRelease,
              }, release.status === "error" ? "Повторить" : (done ? "Проверить снова" : "Проверить релиз")),
            action.enabled
              ? h("button", {
                type: "button",
                style: S.buttonPrimary,
                disabled: busy,
                title: release.mode === "link"
                  ? "обновить связанный каталог из репозитория (git pull --ff-only) и перезапустить DSH"
                  : "поставить пакет последнего релиза и перезапустить DSH",
                onClick: updateRelease,
              }, busy ? "Обновляю…" : action.label)
              : null,
            /*
             * Причина без действия — настоящий блокер (сервер объяснил, почему
             * обновить нельзя). У ссылки причины больше не тупик: подпись кнопки
             * говорит, что делать.
             */
            done && !action.enabled && release.outdated && release.reason
              ? h("span", { style: { ...S.hint, color: T.warn, maxWidth: "620px" } }, release.reason)
              : null,
            done && !release.outdated
              ? h("span", { style: S.hint }, "обновлять нечего")
              : null,
            release.status === "error"
              ? h("span", { style: { ...S.hint, color: T.danger, maxWidth: "620px" } },
                "не удалось проверить релиз: " + release.message
                + (release.fix ? " — " + release.fix : ""))
              : null,
            releaseUpdate.status === "done"
              ? h("span", { style: S.hint },
                "обновлено" + (releaseUpdate.version ? " до " + releaseUpdate.version : "")
                + (releaseUpdate.reason ? " — " + releaseUpdate.reason : "") + ".")
              : null,
            releaseUpdate.status === "refused"
              ? h("span", { style: { ...S.hint, color: T.warn, maxWidth: "620px" } },
                "обновление не выполнено: " + releaseUpdate.reason
                + (releaseUpdate.fix ? " — " + releaseUpdate.fix : ""))
              : null,
            releaseUpdate.status === "error"
              ? h("span", { style: { ...S.hint, color: T.danger, maxWidth: "620px" } },
                "не удалось обновить: " + releaseUpdate.message
                + (releaseUpdate.fix ? " — " + releaseUpdate.fix : ""))
              : null);
        }

        /* A permanent Workflow strip: its state and its own update button. */
        function renderWorkflowStrip() {
          if (!payload || !payload.exists) return null;
          const installed = workflow.status === "installed";
          const checking = workflow.status === "checking";
          const spec = status && status.workflow ? status.workflow.installSpec : null;
          const busy = workflowInstall.status === "installing" || workflowInstall.status === "updating";
          const engineMode = payload && payload.engine ? payload.engine.mode : "";
          /*
           * Где движок обновляется — это отдельный факт проверки, а не догадка по
           * режиму: local обновляется здесь, mapped — в своём репозитории, и панель
           * называет этот репозиторий, а не обещает работу в этом воркспейсе.
           */
          const engineScope = workflowCheck && workflowCheck.engineScope ? workflowCheck.engineScope : {};
          return h("div", {
            style: {
              ...S.card,
              display: "flex",
              gap: "10px",
              alignItems: "center",
              flexWrap: "wrap",
              padding: "8px 10px",
              borderColor: installed ? T.success : T.warn,
            },
          },
            h("span", { style: { fontWeight: 600, fontSize: "12px" } }, "Workflow"),
            h("span", { style: { color: T.secondary, fontSize: "12px" } },
              checking
                ? "проверяю наличие…"
                : installed
                  ? "установлен" + (workflow.version ? " " + workflow.version : "")
                  : "не установлен"),
            installed
              ? h("button", {
                type: "button",
                style: S.button,
                disabled: busy || checking || workflowCheck.status === "checking",
                title: "сравнить установленную сборку с релизом: плагин и движок",
                onClick: checkFreshness,
              }, workflowCheck.status === "checking" ? "Проверяю сборку…" : "Проверить актуальность")
              : null,
            /*
             * Installing from the panel downloads the release with pnpm, and that
             * download fails the TLS check in this environment. The panel does not
             * offer a promise it cannot keep: it says where the plugin is installed
             * from instead.
             */
            !installed
              ? h("span", { style: { ...S.hint, color: T.warn } },
                "плагин не установлен. Панель его не ставит: установите через интерфейс самого workflow"
                + (spec ? " (" + spec + ")" : "") + ".")
              : null,
            h("span", { style: { width: "1px", height: "18px", background: T.border2 } }),
            /*
             * The engine is read by the server as one of three states: it lives here,
             * it serves this workspace from another repository through the map, or it
             * is nowhere. Absence is a choice of two routes, not a failure: no red and
             * no alarm icon, and the failure word is not part of this block.
             */
            h("span", {
              style: { color: T.secondary, fontSize: "12px" },
              /*
               * Видимый текст говорит о состоянии, а подсказка — о том, что
               * движка не нашлось ни в одном из источников: это прежняя
               * формулировка «движок не найден», оставленная подсказкой.
               */
              title: engineMode === "absent"
                ? "движок не найден ни здесь, ни в конфиге профиля, ни по карте"
                : undefined,
            },
              !payload.engine
                ? "движок: нет данных"
                : payload.engine.mode === "local"
                  ? "движок: v" + (payload.engine.version || "?") + " (здесь)"
                  : payload.engine.mode === "mapped"
                    ? "движок внешний · v" + (payload.engine.version || "?") + " · "
                      + String(payload.engine.path || "") + " · "
                      + (payload.engine.source === "config" ? "задано конфигом профиля" : "выбрано в панели")
                      + (payload.engine.source === "mapping" ? " · карта ~/.dsh/workflow/engine-roots.json" : "")
                    : payload.engine.mode === "absent"
                      ? "движок не подключён"
                      : payload.engine.deployed
                        ? "движок " + (payload.engine.version || "развёрнут")
                        : "движок не развёрнут"),
            /*
             * The engine is external: deploying it here would contradict the map, so
             * the button stays visible but inactive and says where deployment happens.
             */
            payload.engine && payload.engine.mode === "mapped"
              ? h("button", {
                type: "button",
                style: S.buttonPrimary,
                disabled: true,
                title: "разворачивается в репозитории движка, а не здесь",
                onClick: deployWorkflow,
              }, "Развернуть")
              : payload.engine && payload.engine.mode === "absent"
                /*
                 * No engine anywhere: two equal routes. "Развернуть здесь" is the
                 * button; pointing at the map is the sentence next to it.
                 */
                ? [
                  h("button", {
                    key: "deploy-here",
                    type: "button",
                    style: S.buttonPrimary,
                    disabled: busy || !installed || workflowInstall.status === "deploying",
                    title: "развернуть движок workflow в этом воркспейсе (docs/subagent-workflow)",
                    onClick: deployWorkflow,
                  }, workflowInstall.status === "deploying" ? "Разворачиваю…" : "Развернуть здесь"),
                  /*
                   * Второй равный путь: движок уже развёрнут в другом репозитории.
                   * Панель не пишет ни конфиг профиля, ни карту — это половина
                   * workflow, поэтому кнопка показывает, где связь объявляется.
                   */
                  h("button", {
                    key: "connect-existing",
                    type: "button",
                    style: S.buttonPrimary,
                    title: "подключить движок, который уже развёрнут в другом репозитории: строка engines.roots в конфиге профиля или карта",
                    onClick: connectExistingEngine,
                  }, "Подключить существующий"),
                ]
                : installed && payload.engine && payload.engine.deployed === false
                  ? h("button", {
                    type: "button",
                    style: S.buttonPrimary,
                    disabled: busy || workflowInstall.status === "deploying",
                    title: "развернуть движок workflow в этом воркспейсе (docs/subagent-workflow)",
                    onClick: deployWorkflow,
                  }, workflowInstall.status === "deploying" ? "Разворачиваю…" : "Развернуть")
                  : null,
            payload.engine && payload.engine.mode === "absent"
              ? h("span", { style: S.hint },
                "или укажите карту ~/.dsh/workflow/engine-roots.json, если движок уже развёрнут в другом репозитории")
              : null,
            payload.engine && payload.engine.mode === "absent" && engineConnectHint
              ? h("span", { style: S.hint },
                "Подключить существующий: путь к репозиторию движка задаётся строкой engines.roots "
                + "в конфиге профиля (cordis.patch.yml) или картой ~/.dsh/workflow/engine-roots.json; "
                + "панель эти файлы не пишет.")
              : null,
            /*
             * The button only appears when our update cannot break the setup. A linked
             * plugin is not replaced behind the person's back: the strip explains the
             * risk and points to the workflow plugin's own update instead.
             */
            workflowCheck.status === "done" && workflowCheck.outdated
              ? h("span", {
                style: { ...S.hint, color: T.warn, maxWidth: "620px" },
              }, (workflowCheck.recommendation && workflowCheck.recommendation.text)
                || "Обновление из панели недоступно. Обновите плагин через интерфейс самого workflow.")
              : null,
            /* Installed: the freshness check is the check. Missing: re-read the plugin state. */
            !installed
              ? h("button", { type: "button", style: S.button, disabled: busy || checking, onClick: () => checkWorkflow() }, "Проверить Workflow")
              : null,
            workflowCheck.status === "done"
              ? h("span", { style: { ...S.hint, color: workflowCheck.outdated ? T.warn : T.secondary } },
                (workflowCheck.outdated
                  ? "сборка устарела: плагин " + (workflowCheck.current && workflowCheck.current.plugin || "неизвестно")
                    + " → " + (workflowCheck.latest && workflowCheck.latest.plugin || "неизвестно")
                    + ", движок " + (workflowCheck.current && workflowCheck.current.engine || "неизвестно")
                    + " → " + (workflowCheck.latest && workflowCheck.latest.engine || "неизвестно")
                  : "сборка актуальна: плагин " + (workflowCheck.current && workflowCheck.current.plugin || "неизвестно")
                    + ", движок " + (workflowCheck.current && (workflowCheck.current.engine || "не развёрнут")))
                + (engineScope.mode === "mapped"
                  ? " · движок обновляется в репозитории движка: " + String(engineScope.path || "")
                  : engineScope.mode === "local"
                    ? " · движок обновляется здесь"
                    : ""))
              : null,
            workflowCheck.status === "error"
              ? h("span", { style: { ...S.hint, color: T.danger } }, "проверка не удалась: " + workflowCheck.message + " — " + workflowCheck.fix)
              : null,
            workflowInstall.status === "done"
              ? h("span", { style: S.hint },
                (workflowInstall.action === "update" ? "обновлён" : "установлен")
                + (workflowInstall.version ? " " + workflowInstall.version : "")
                + (workflowInstall.engine ? ", движок " + workflowInstall.engine : "")
                + (workflowInstall.engineReason ? " — движок: " + workflowInstall.engineReason : "") + ".")
              : null,
            workflowInstall.status === "present"
              ? h("span", { style: S.hint }, "уже установлено — версия из проверки Workflow")
              : null,
            workflowInstall.status === "deployed"
              ? h("span", { style: S.hint }, "движок развёрнут" + (workflowInstall.version ? " " + workflowInstall.version : "") + ".")
              : null,
            workflowInstall.status === "restart"
              ? h("span", { style: S.hint }, "нужен перезапуск DSH: " + workflowInstall.reason)
              : null,
            workflowInstall.status === "error"
              ? h("span", { style: { ...S.hint, color: T.danger } }, "не удалось: " + workflowInstall.message + " — " + workflowInstall.fix)
              : null);
        }

        function renderWorkflowCard() {
          if (!workflowOffer) return null;
          const installed = workflow.status === "installed";
          const checking = workflow.status === "checking";
          const spec = status && status.workflow ? status.workflow.installSpec : null;
          const installing = workflowInstall.status === "installing";
          return h("div", { style: { ...S.card, borderColor: installed ? T.success : T.warn } },
            h("div", { style: { fontWeight: 600, fontSize: "13px" } }, "Иерархическая схема и workflow-плагин"),
            h("div", { style: S.hint },
              "Схема архитектор → исполнитель → оценщик рассчитана на отдельный DSH-плагин workflow: "
              + "доска задач, карточка и политика. Он не запускает агентов — запуск остаётся за структурой."),
            h("div", { style: S.row },
              h("span", { style: S.label }, "Статус"),
              h("span", { style: S.value }, checking
                ? "проверяю наличие…"
                : installed
                  ? "установлен" + (workflow.version ? " " + workflow.version : "")
                  : "не установлен")),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
              h("a", { href: WORKFLOW_REPO, target: "_blank", rel: "noreferrer", style: { color: T.link, fontSize: "12px" } }, "Репозиторий"),
              h("a", { href: WORKFLOW_PLUGIN, target: "_blank", rel: "noreferrer", style: { color: T.link, fontSize: "12px" } }, "Инструкция по установке"),
              installed
                ? h("button", { type: "button", style: S.buttonPrimary, onClick: () => { setWorkflowOffer(false); createStructure("hierarchy"); } }, "Создать иерархическую")
                : h("button", { type: "button", style: S.button, disabled: checking, onClick: () => checkWorkflow() }, "Проверить снова"),
              !installed && spec
                ? h("button", {
                  type: "button",
                  style: S.buttonPrimary,
                  disabled: installing,
                  title: "поставить " + spec + " через установщик DSH",
                  onClick: installWorkflow,
                }, installing ? "Устанавливаю…" : "Установить")
                : null,
              installed
                ? h("button", { type: "button", style: S.button, onClick: () => setWorkflowOffer(false) }, "Отмена")
                : h("button", { type: "button", style: S.button, onClick: () => { setWorkflowOffer(false); createStructure("hierarchy"); } }, "Создать без плагина")),
            workflowInstall.status === "installing"
              ? h("div", { style: S.hint }, "Ставлю " + spec + ": pnpm ставит пакет в профиль, это может занять до минуты.")
              : workflowInstall.status === "done"
                ? h("div", { style: S.hint }, "Установлено" + (workflowInstall.version ? " " + workflowInstall.version : "") + ". Статус перечитан.")
                : workflowInstall.status === "present"
                  ? h("div", { style: S.hint }, "Уже установлено — версия берётся из проверки Workflow.")
                  : workflowInstall.status === "restart"
                  ? h("div", { style: S.info },
                    h("div", null, "Плагин установлен, но нужен перезапуск DSH"),
                    h("div", { style: S.hint }, workflowInstall.reason),
                    h("button", { type: "button", style: S.button, onClick: () => { setWorkflowInstall({ status: "idle" }); checkWorkflow(); } }, "Проверить снова"))
                  : workflowInstall.status === "error"
                    ? h("div", { style: S.error },
                      h("div", null, "Установка не удалась: " + workflowInstall.message
                        + (workflowInstall.code ? " (" + workflowInstall.code + ")" : "")),
                      h("div", { style: S.fix }, "Что сделать: " + workflowInstall.fix))
                    : null,
            installed
              ? null
              : h("div", { style: S.hint },
                spec
                  ? "Панель поставит пакет плагина из workflowInstallSpec. Это не запуск агентов: доска задач и гейты появятся после установки и, если установщик попросит, после перезапуска DSH."
                  : "Пока плагин не установлен, иерархию можно создать: структура валидна и запускается, "
                    + "но панели задач и гейтов не будет. workflowInstallSpec не задан — поставьте пакет вручную из папки plugin/, затем «Проверить снова»."));
        }

        function createStructure(template) {
          const target = payload && payload.root ? payload.root : root;
          if (!target || creating !== null) return;
          setCreating(template);
          setError(null);
          fetch(BASE + "/api/init?root=" + encodeURIComponent(target) + "&template=" + encodeURIComponent(template), {
            method: "POST",
            headers: { Accept: "application/json" },
          })
            .then((response) => response.json().then((body) => {
              if (!response.ok) {
                const failure = new Error((body && body.error) || ("HTTP " + response.status));
                if (body && body.fix) failure.fix = body.fix;
                throw failure;
              }
              return body;
            }))
            .then(() => load(target))
            .catch((failure) => setError({
              message: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Нажмите «Создать структуру» ещё раз или создайте structure/graph.json вручную.",
            }))
            .finally(() => setCreating(null));
        }

        function renderProjects() {
          if (projects.length === 0) return null;
          return h(
            "div",
            { style: S.bar },
            projects.map((project) => {
              const isCurrent = current && samePath(project.root, current.path);
              const isDefault = status && status.defaultRoot && samePath(project.root, status.defaultRoot);
              const marks = [];
              if (isCurrent) marks.push("текущий");
              else if (isDefault) marks.push("по умолчанию");
              if (project.exists === false) marks.push("папка не найдена");
              else if (project.hasStructure === false) marks.push("нет структуры");
              return h("button", {
                key: project.root,
                type: "button",
                style: root === project.root ? S.buttonActive : S.button,
                title: project.root + (project.exists === false
                  ? " — папка проекта не найдена"
                  : project.hasStructure === false ? " — папки структуры пока нет" : ""),
                onClick: () => {
                  userPickedRef.current = true;
                  load(project.root);
                },
              }, project.name + (marks.length > 0 ? " · " + marks.join(" · ") : ""));
            }),
          );
        }

        function renderSummary() {
          if (!payload || !payload.summary) return null;
          const summary = payload.summary;
          const roles = Object.entries(summary.roles || {});
          return h(
            "div",
            { style: S.bar },
            h("span", { style: S.title }, payload.name || ""),
            h("span", { style: S.chip, title: "узлы — кто в проекте" }, "узлов: " + summary.nodes),
            h("span", { style: S.chip, title: "связи — кто кому поручает, кого проверяет и с кем сотрудничает" }, "связей: " + summary.edges),
            h("span", { style: S.chip, title: "delegate — поручение работы" }, "delegate: " + summary.byKind.delegate),
            h("span", { style: S.chip, title: "review — проверка работы" }, "review: " + summary.byKind.review),
            h("span", { style: S.chip, title: "report — возврат результата без оценки" }, "report: " + summary.byKind.report),
            h("span", { style: S.chip, title: "peer — сотрудничество равных" }, "peer: " + summary.byKind.peer),
            h("span", { style: S.chip, title: "слои — сколько уровней поручений в графе" }, "слоёв: " + summary.layers),
            roles.length > 0
              ? h("span", { style: S.chip, title: "роли в структуре и сколько узлов на каждой" }, roles.map(([role, count]) => role + "×" + count).join(", "))
              : null,
          );
        }

        /*
         * Строка режима стоит рядом со схемой: человек видит, действует ли
         * императив. off — заметно (danger), fail — нейтрально: режим лишь
         * называется и никогда не выключает панель.
         */
        function renderEnforcement() {
          const view = enforcementView(payload);
          if (!view) return null;
          const color = view.level === "weak" ? T.danger : view.level === "pilot" ? T.warn : T.secondary;
          const mode = payload && payload.enforcement && payload.enforcement.mode
            ? String(payload.enforcement.mode)
            : "";
          return h("div", {
            "data-enforcement-mode": mode,
            "data-enforcement-level": view.level,
            role: view.level === "weak" ? "alert" : undefined,
            style: { ...S.hint, color, fontWeight: view.level === "weak" ? 600 : 400 },
          }, view.text);
        }

        function renderOnboarding(body) {
          const dir = (body && body.structureDir) || "structure";
          const base = displayPath((body && body.root) || "корень проекта");
          return h(
            "div",
            { style: S.onboarding },
            h("div", { style: { fontWeight: 600, fontSize: 14 } }, "В этом проекте ещё нет структуры"),
            h("div", { style: S.hint },
              "Структура — небольшой JSON-файл, который описывает проект: кто в нём работает, "
              + "на какой модели и кто кому поручает. Панель не меняет узлы, роли и модели: стартовую создаёт "
              + "по кнопке, связи добавляет и удаляет, существующие файлы не перезаписывает."),
            h("div", { style: S.bar },
              h("button", { type: "button", style: S.buttonPrimary, onClick: startHierarchy, disabled: creating !== null },
                creating === "hierarchy" ? "Создаю…" : "Создать иерархическую"),
              h("button", { type: "button", style: S.button, onClick: () => createStructure("peer"), disabled: creating !== null },
                creating === "peer" ? "Создаю…" : "Создать одноранговую"),
              h("button", { type: "button", style: S.button, onClick: () => createStructure("mixed"), disabled: creating !== null },
                creating === "mixed" ? "Создаю…" : "Создать смешанную"),
              h("button", { type: "button", style: S.button, onClick: () => createStructure("team"), disabled: creating !== null },
                creating === "team" ? "Создаю…" : "Создать без оценщика"),
              h("span", { style: S.hint }, "все создадут " + dir + "/graph.json; существующие файлы не меняются")),
            h("div", { style: S.hint },
              "Иерархическая: координатор → исполнитель → приёмщик. "
              + "Одноранговая: равные участники, только связи peer. "
              + "Смешанная: координатор поручает двум лидам, лиды равны, обоих проверяет приёмщик. "
              + "Без оценщика: та же иерархия, но без review — только поручения."),
            renderWorkflowCard(),
            h("div", { style: { marginTop: 2, color: T.secondary, fontSize: 12, fontWeight: 600 } }, "Или создайте вручную:"),
            h("ol", { style: S.steps },
              h("li", null, "Создайте папку " + dir + "/ в корне проекта: " + base + "."),
              h("li", null, "В ней создайте файл graph.json."),
              h("li", null, "Вставьте пример ниже и поправьте id, роли и модели под свой проект."),
              h("li", null, "Сохраните файл и нажмите «Обновить» — появится граф.")),
            h("div", { style: S.bar },
              h("button", { type: "button", style: S.button, onClick: copySample },
                copyState === "done" ? "Скопировано" : "Скопировать пример"),
              copyState === "manual"
                ? h("span", { style: S.hint }, "Браузер не дал доступ к буферу — выделите пример ниже и скопируйте вручную.")
                : null,
              h("span", { style: S.mono }, base + "/" + dir + "/graph.json")),
            h("pre", { style: S.pre }, SAMPLE_TEXT),
            h("ul", { style: S.list },
              h("li", null, "nodes — кто в проекте: id (короткое имя), role (роль), model (алиас модели), brief (чем занимается)."),
              h("li", null, "edges — связи: from и to (id узлов), kind — delegate (поручение), review (проверка), report (возврат результата), peer (равные)."),
              h("li", null, "models — маршруты моделей: алиас → provider и model. Эти модели должны быть доступны в DSH."),
              h("li", null, "Обязателен только id у узла; роль, модель и назначение можно добавить позже.")),
          );
        }

        /* ---------- раскладка: мышь, клавиатура, сохранение ---------- */

        function applyPositions(map) {
          positionsRef.current = map;
          setPositions(map);
        }

        /* Участники папки обмена: каждый выбранный воркспейс получает спеку с императивом. */
        function toggleParticipant(nodeId, rootPath) {
          setExchangeDraft((prev) => {
            const list = prev && prev.node === nodeId ? prev.list.slice() : [];
            const existing = payload && payload.graph && payload.graph.nodes
              ? (payload.graph.nodes.find((item) => item.id === nodeId) || {}).participants || []
              : [];
            const base = prev && prev.node === nodeId ? list : existing.slice();
            const at = base.findIndex((item) => item.toLowerCase() === String(rootPath).toLowerCase());
            if (at === -1) base.push(rootPath);
            else base.splice(at, 1);
            return { node: nodeId, list: base };
          });
        }

        function saveParticipants(nodeId) {
          const draft = exchangeDraft && exchangeDraft.node === nodeId ? exchangeDraft.list : [];
          if (draft.length === 0) {
            setLayoutError({ message: "У папки обмена нет участников", fix: "Отметьте хотя бы один воркспейс — иначе обмен ни с кем не объявлен." });
            return;
          }
          setLayoutError(null);
          fetchJson("/api/exchange-participants", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ root, node: nodeId, participants: draft }),
          })
            .then((saved) => fetchJson("/api/graph?root=" + encodeURIComponent(root)).then((fresh) => {
              setPayload(fresh);
              setExchangeDraft(null);
              const files = Array.isArray(saved.written) ? saved.written.length : 0;
              setLive("участники обмена сохранены: " + draft.length + ", спеки обновлены у " + files
                + (saved.failures && saved.failures.length ? ", ошибок " + saved.failures.length : ""));
            }))
            .catch((failure) => setLayoutError({
              message: "Не удалось сохранить участников: " + (failure && failure.message ? failure.message : String(failure)),
              fix: (failure && failure.fix) || "Проверьте structure/*.json и повторите.",
            }));
        }

        /* ---------- папка обмена: редактор у портала ---------- */

        /* Отказ панели: что случилось, почему и что сделать — три части, как у узла. */
        function folderProblem(what, failure) {
          const fix = (failure && failure.fix) || "Обновите панель и повторите; если повторяется — проверьте structure/graph.json.";
          const similar = failure && Array.isArray(failure.similar) ? failure.similar.filter((item) => typeof item === "string" && item.trim()) : [];
          return {
            what,
            why: failure && failure.message ? failure.message : String(failure || "сервер отказал без причины"),
            fix: similar.length > 0 ? fix + " Похожие метки реестра: " + similar.join(", ") + "." : fix,
          };
        }

        /*
         * Клик, Enter или Space по порталу открывает редактор папки. У объявленной
         * папки — её запись; у легаси-портала без записи folders — черновик папки
         * (folderEditorDraft(null)), чтобы папку можно было создать из панели в
         * любом воркспейсе. Список фактов не исчез: он открывается кнопкой в
         * редакторе — там, где его теперь ищут.
         */
        function openPortal(portal) {
          const folder = portal && portal.folder ? portal.folder : null;
          /*
           * Папка не объявлена (легаси-портал): клик всё равно открывает редактор.
           * Черновик собирает чистая функция folderEditorDraft(null) — id folder-1,
           * ящик coordination/workspace, участник — текущая метка, оркестратор coordinator.
           * Так папку можно создать из панели в любом воркспейсе, а список фактов
           * остаётся кнопкой в редакторе.
           */
          if (!folder || !folder.id) {
            const draft = folderEditorDraft(null, folderDraftContext());
            if (folderEditor && folderEditor.id === draft.id) {
              closeFolderEditor();
              setLive("черновик папки «" + draft.id + "» закрыт: клик по порталу откроет его снова");
              return;
            }
            showFolderEditorDraft(draft);
            setLive("портал без папки: открыт черновик «" + draft.id + "» — «Сохранить изменения» создаст папку обмена");
            return;
          }
          /*
           * Состояние переключает чистая функция, а не побочный флаг в DOM:
           * после closeFolderEditor current === null, и следующий клик по
           * порталу снова получает черновик, а не тишину.
           */
          const next = folderEditor
            ? toggleFolderEditor(folderEditor, folder)
            : reopenFolderEditor(folder);
          if (!next) {
            /* Клик по тому же порталу — тот же крестик: с правками сначала спросить. */
            if (folderEditorChanged()) { setCloseConfirm("folder"); return; }
            closeFolderEditor();
            setLive("редактор папки «" + folder.id + "» закрыт: клик по порталу откроет его снова");
            return;
          }
          openFolderEditor(folder.id);
          setLive("портал папки «" + folder.id + "» открыт: редактор ящика, участников и контракта");
        }

        /*
         * Контекст черновика: текущая метка воркспейса, занятые id папок и
         * оркестратор. Метка приходит в ответе /api/exchange, поэтому участник
         * черновика — факт, а не догадка.
         */
        function folderDraftContext() {
          const graph = (payload && payload.graph) || {};
          const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter((node) => node && node.id) : [];
          const hasCoordinator = nodes.some((node) => node.id === "coordinator");
          return {
            label: exchange && typeof exchange.label === "string" ? exchange.label : "",
            folders: Array.isArray(graph.folders) ? graph.folders : [],
            orchestrator: hasCoordinator ? "coordinator" : ((nodes[0] && nodes[0].id) || "coordinator"),
          };
        }

        /* Поповер папки: черновик собирается из записи folders, а не из узла. */
        function openFolderEditor(id, sourceGraph) {
          const source = sourceGraph || (payload && payload.graph) || { folders: [] };
          const folder = ((source && source.folders) || []).find((item) => item && item.id === id) || null;
          if (!folder) {
            setFolderEditorError({
              what: "Папка «" + id + "» не найдена в структуре",
              why: "возможно, её уже удалили или переименовали",
              fix: "Нажмите «Обновить» и выберите портал заново.",
            });
            return;
          }
          showFolderEditorDraft(folderEditorDraft(folder));
        }

        /* Один вход для черновика: окно, значения на момент открытия и чистый диалог. */
        function showFolderEditorDraft(draft) {
          setFolderEditor(draft);
          setFolderEditorBaseline(draft);
          setFolderEditorError(null);
          /* Поиск не переезжает из прошлой папки: реестр показывается целиком. */
          setParticipantSearch("");
          setFolderDeleteAsk(false);
          setCloseConfirm(null);
          setNodeInfo(null);
        }

        function closeFolderEditor() {
          setFolderEditor(null);
          setFolderEditorBaseline(null);
          setFolderEditorError(null);
          setFolderEditorBusy(false);
          setParticipantSearch("");
          setFolderDeleteAsk(false);
          setCloseConfirm(null);
        }

        function folderEditorChanged() {
          return editorDraftChanged(folderEditor, folderEditorBaseline);
        }

        /* Крестик папки: без правок закрывает сразу, с правками спрашивает. */
        function requestCloseFolderEditor() {
          if (!folderEditor) return;
          if (folderEditorChanged()) { setCloseConfirm("folder"); return; }
          closeFolderEditor();
        }

        function setFolderField(field, value) {
          setFolderEditor((prev) => (prev ? { ...prev, [field]: value } : prev));
        }

        /*
         * Метка приходит только из реестра воркспейсов (задание 0024): у
         * функции нет ветки «взять напечатанное», поэтому свободный ввод не
         * может стать участником папки даже случайно.
         */
        function addFolderParticipant(label) {
          if (!folderEditor) return;
          const value = String(label || "").trim();
          if (!value) {
            setFolderEditorError({ what: "Участник не выбран", why: "метка берётся только из реестра воркспейсов", fix: "Найдите воркспейс поиском и нажмите на его метку в списке." });
            return;
          }
          if (folderEditor.participants.includes(value)) {
            setFolderEditorError({ what: "Метка «" + value + "» уже в списке", why: "участники папки не повторяются", fix: "Выберите другую метку реестра." });
            return;
          }
          setFolderEditorError(null);
          setFolderEditor({ ...folderEditor, participants: folderEditor.participants.concat([value]) });
        }

        function removeFolderParticipant(label) {
          if (!folderEditor) return;
          setFolderEditor({ ...folderEditor, participants: folderEditor.participants.filter((item) => item !== label) });
        }

        /* Перечитывание схемы и ленты обмена после записи: устаревшее не показывается. */
        function reloadFolderGraph() {
          return fetchJson("/api/graph?root=" + encodeURIComponent(root))
            .then((fresh) => {
              setPayload(fresh);
              reloadExchange();
              return fresh;
            });
        }

        /*
         * «Сохранить изменения»: объявленная папка заменяется (action=update), черновик от
         * портала создаётся (action=add) — иначе папку нельзя было бы завести из
         * воркспейса, где она ещё не объявлена. Контракт при этом не переписывается.
         */
        function submitFolderEditor() {
          if (!folderEditor || !root || folderEditorBusy) return;
          const draft = folderEditor;
          if (!draft.id) {
            setFolderEditorError({ what: "У папки нет id", why: "id — имя записи в folders", fix: "Обновите панель и откройте портал заново." });
            return;
          }
          if (!String(draft.boxPath || "").trim()) {
            setFolderEditorError({ what: "Не указан ящик обмена", why: "box.path — путь к папке обмена внутри корня участников", fix: "Напишите относительный путь, например coordination." });
            return;
          }
          if (!draft.participants || draft.participants.length === 0) {
            setFolderEditorError({ what: "У папки нет участников", why: "участник — воркспейс канала, минимум один", fix: "Добавьте хотя бы одну метку." });
            return;
          }
          /* Метка вне реестра не сохраняется: показываем похожие, запись не уходит. */
          const unresolvedParticipants = participantRows(draft.participants, registryWorkspaces(status))
            .filter((row) => !row.found);
          if (unresolvedParticipants.length > 0) {
            const similar = unresolvedParticipants.flatMap((row) => row.similar);
            setFolderEditorError({
              what: "Метка вне реестра — не найден: " + unresolvedParticipants.map((row) => row.label).join(", "),
              why: "участник папки — воркспейс из реестра; такой метки в реестре нет, сохранить нельзя",
              fix: similar.length > 0
                ? "Похожие метки: " + similar.join(", ") + ". Уберите метку и выберите воркспейс из реестра."
                : "Похожих меток нет: уберите метку и выберите воркспейс из реестра.",
            });
            return;
          }
          if (!draft.orchestrator) {
            setFolderEditorError({ what: "Не выбран оркестратор", why: "папку представляет объявленный узел структуры", fix: "Выберите узел в поле «Оркестратор»." });
            return;
          }
          const declared = ((payload && payload.graph && payload.graph.folders) || [])
            .some((item) => item && item.id === draft.id);
          const action = declared ? "update" : "add";
          setFolderEditorBusy(true);
          setFolderEditorError(null);
          fetchJson("/api/folder?root=" + encodeURIComponent(root) + "&action=" + action, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ root, folder: folderBody(draft) }),
          })
            .then(() => reloadFolderGraph())
            .then(() => {
              const id = draft.id;
              closeFolderEditor();
              setLayoutNotice(action === "add"
                ? "Папка «" + id + "» создана из черновика: запись в structure/graph.json и контракт Rev 1 в ящике."
                : "Папка «" + id + "» сохранена: запись в structure/graph.json заменена. Контракт не переписан — ревизия поднимается кнопкой «Уведомить участников».");
              setLive("папка «" + id + "» " + (action === "add" ? "создана" : "сохранена"));
            })
            .catch((failure) => {
              setFolderEditorBusy(false);
              setFolderEditorError(folderProblem("Не удалось сохранить папку", failure));
            });
        }

        /* «Уведомить участников»: action=contract — Rev+1, инициатор сохраняется, Invited из participants. */
        function refreshFolderContract() {
          if (!folderEditor || !root || folderEditorBusy) return;
          const id = folderEditor.id;
          setFolderEditorBusy(true);
          setFolderEditorError(null);
          fetchJson("/api/folder?root=" + encodeURIComponent(root) + "&action=contract", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ root, id }),
          })
            .then((saved) => reloadFolderGraph().then(() => saved))
            .then((saved) => {
              setFolderEditorBusy(false);
              const rev = saved && saved.contract ? saved.contract.rev : "?";
              setLayoutNotice("Контракт папки «" + id + "» переписан: Rev " + rev + " — инициатор сохранён, приглашённые взяты из participants.");
              setLive("контракт папки «" + id + "» переписан: Rev " + rev);
            })
            .catch((failure) => {
              setFolderEditorBusy(false);
              setFolderEditorError(folderProblem("Не удалось переписать контракт", failure));
            });
        }

        /*
         * «Принять папку»: POST /api/folder?action=accept с id папки и сессией,
         * из которой нажали. Сервер идемпотентен (задание 0047, D2): повторное
         * нажатие второго письма не пишет и возвращает alreadyAccepted. После
         * успеха факты обмена перечитываются — карточка сразу говорит «папка
         * принята», а не держит устаревшее состояние invited.
         */
        function acceptFolder(folder, data) {
          const action = folderAcceptAction(folder, data);
          if (!action || !root || folderAcceptBusy) return;
          /* Кто нажал: сессия панели, а если её нет — вид, который её показал. */
          const sessionId = (current && current.sessionId) || "session-panel";
          setFolderAcceptBusy(true);
          setFolderEditorError(null);
          fetchJson(folderAcceptPath(root, action.id), {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ id: action.id, session: sessionId }),
          })
            .then((saved) => reloadExchange().then(() => saved))
            .then((saved) => {
              setFolderAcceptBusy(false);
              const already = Boolean(saved && saved.alreadyAccepted === true);
              const receipt = (saved && saved.receipt) || "письмо в ящике обмена";
              setLayoutNotice(already
                ? "Папка «" + action.id + "» уже принята: квитанция " + receipt + " — второе письмо не записано."
                : "Папка «" + action.id + "» принята: квитанция " + receipt + " записана в ящик обмена.");
              setLive(already
                ? "папка «" + action.id + "» уже принята: повторной квитанции нет"
                : "папка «" + action.id + "» принята: квитанция accepted записана");
            })
            .catch((failure) => {
              setFolderAcceptBusy(false);
              setFolderEditorError(folderProblem("Не удалось принять папку", failure));
            });
        }

        /* Первый клик по «Удалить папку» только спрашивает: ничего не пишется. */
        function requestRemoveFolder() {
          if (!folderEditor || !root || folderEditorBusy) return;
          setFolderDeleteAsk(true);
          setLive("удаление папки «" + folderEditor.id + "»: панель спрашивает подтверждение");
        }

        function cancelRemoveFolder() {
          setFolderDeleteAsk(false);
          setLive("удаление папки отменено");
        }

        /* «Удалить папку»: action=remove — запись уходит, ящик и письма остаются. */
        function removeFolder() {
          if (!folderEditor || !root || folderEditorBusy) return;
          const id = folderEditor.id;
          setFolderDeleteAsk(false);
          setFolderEditorBusy(true);
          setFolderEditorError(null);
          fetchJson("/api/folder?root=" + encodeURIComponent(root) + "&action=remove", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ root, id }),
          })
            .then(() => reloadFolderGraph())
            .then(() => {
              /* Удалённая папка не должна оставлять за собой открытых окон. */
              setCloseConfirm(null);
              setNodeInfo(null);
              closeFolderEditor();
              setLayoutNotice("Папка «" + id + "» удалена из структуры: узлы не тронуты, ящик и письма остались на диске.");
              setLive("папка «" + id + "» удалена");
            })
            .catch((failure) => {
              setFolderEditorBusy(false);
              setFolderEditorError(folderProblem("Не удалось удалить папку", failure));
            });
        }

        /* Привязка «узел → сессия»: необязательная, но точная адресация доставки. */
        function bindSession(nodeId, sessionId) {
          setLayoutError(null);
          setLayoutNotice(null);
          fetchJson("/api/session", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ root, node: nodeId, session: sessionId }),
          })
            .then(() => fetchJson("/api/graph?root=" + encodeURIComponent(root)))
            .then((fresh) => {
              setPayload(fresh);
              setLive(sessionId
                ? "узел " + nodeId + " привязан к сессии " + sessionId
                : "узел " + nodeId + " отвязан: доставка пойдёт запуском от живой сессии");
              /* node.session записан: живая лента должна увидеть привязку сразу. */
              refreshLive();
            })
            .catch((failure) => setLayoutError({
              message: "Не удалось сохранить привязку: " + (failure && failure.message ? failure.message : String(failure)),
              fix: (failure && failure.fix) || "Проверьте structure/*.json и повторите.",
            }));
        }

        function saveLayoutPositions(patch) {
          if (!root) return Promise.resolve(null);
          const body = {};
          for (const [id, value] of Object.entries(patch || {})) body[id] = { x: value.x, y: value.y };
          if (Object.keys(body).length === 0) return Promise.resolve(null);
          setLayoutError(null);
          setLayoutNotice(null);
          return fetchJson("/api/layout", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ root, positions: body }),
          }).then((saved) => {
            setLive("позиция сохранена: " + Object.keys(body).join(", "));
            return saved;
          }).catch((failure) => {
            setLayoutError({
              message: "Не удалось сохранить раскладку: " + (failure && failure.message ? failure.message : String(failure)),
              fix: failure && failure.fix
                ? failure.fix
                : "Позиция пока только на экране: нажмите «Обновить» и повторите.",
            });
            return null;
          });
        }

        /* Пауза 400 мс после стрелки: серия нажатий даёт одну запись. */
        function scheduleLayoutSave(id, position) {
          pendingRef.current = { ...pendingRef.current, [id]: { x: position.x, y: position.y } };
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            const patch = pendingRef.current;
            pendingRef.current = {};
            saveLayoutPositions(patch);
          }, 400);
        }

        /* Уход фокуса и конец перетаскивания сохраняют сразу, без ожидания паузы. */
        function flushLayoutSave() {
          if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
          }
          const patch = pendingRef.current;
          pendingRef.current = {};
          if (Object.keys(patch).length > 0) saveLayoutPositions(patch);
        }

        function startDrag(event, node) {
          if (event.button !== undefined && event.button !== 0) return;
          if (typeof window === "undefined") return;
          const svg = svgRef.current;
          if (!svg) return;
          if (event.currentTarget && typeof event.currentTarget.focus === "function") event.currentTarget.focus();
          const rect = svg.getBoundingClientRect();
          const widthAttr = Number(svg.getAttribute("width"));
          const scale = rect.width > 0 && Number.isFinite(widthAttr) && widthAttr > 0 ? widthAttr / rect.width : 1;
          const drag = { id: node.id, clientX: event.clientX, clientY: event.clientY, x: node.x, y: node.y, moved: false, scale };
          dragRef.current = drag;
          setDragging(node.id);
          setFocusedNode(node.id);
          function move(moveEvent) {
            const active = dragRef.current;
            if (!active) return;
            const dx = (moveEvent.clientX - active.clientX) * active.scale;
            const dy = (moveEvent.clientY - active.clientY) * active.scale;
            if (!active.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
            active.moved = true;
            const x = Math.max(0, Math.round(active.x + dx));
            const y = Math.max(0, Math.round(active.y + dy));
            applyPositions({ ...positionsRef.current, [active.id]: { x, y } });
          }
          function stop() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
            const finished = dragRef.current;
            dragRef.current = null;
            setDragging(null);
            if (!finished || !finished.moved) return;
            suppressClickRef.current = Date.now() + 350;
            const moved = positionsRef.current[finished.id];
            setLive("узел «" + finished.id + "» перемещён: x " + moved.x + ", y " + moved.y + "; связи идут за ним");
            saveLayoutPositions({ [finished.id]: moved });
          }
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", stop);
          window.addEventListener("pointercancel", stop);
          event.preventDefault();
        }

        function handleNodeKey(event, node) {
          /* 0143: меню нет; вход в окно — шестерёнка в строке роли (Tab + Enter). */
          const current = positionsRef.current[node.id] || { x: node.x, y: node.y };
          const next = keyboardMove(current, event.key, Boolean(event.shiftKey));
          if (!next) return;
          event.preventDefault();
          setFocusedNode(node.id);
          applyPositions({ ...positionsRef.current, [node.id]: next });
          setLive("узел «" + node.id + "»: x " + next.x + ", y " + next.y);
          scheduleLayoutSave(node.id, next);
        }

        function handleNodeBlur() {
          setFocusedNode(null);
          flushLayoutSave();
        }

        /* Клик после перетаскивания не должен переключать выбор: карточку тянули. */
        function pickNode(id) {
          if (Date.now() < suppressClickRef.current) return;
          setPicked(id);
        }

        function resetLayout() {
          if (!root) return;
          setLayoutError(null);
          fetchJson("/api/layout", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ root, reset: true }),
          }).then((saved) => {
            if (saveTimerRef.current) {
              clearTimeout(saveTimerRef.current);
              saveTimerRef.current = null;
            }
            pendingRef.current = {};
            applyPositions({});
            setLayoutError(null);
            const files = saved && Array.isArray(saved.files) && saved.files.length > 0
              ? saved.files.join(", ")
              : (payload && payload.structureDir ? payload.structureDir : "structure") + "/*.json";
            setLayoutNotice("Раскладка сброшена: координаты x/y убраны из " + files
              + ". Узлы вернулись на расчётные места.");
            setLive("раскладка сброшена: узлы вернулись на расчётные места, x/y убраны из " + files);
            load(root, true);
          }).catch((failure) => {
            setLayoutError({
              message: "Не удалось сбросить раскладку: " + (failure && failure.message ? failure.message : String(failure)),
              fix: failure && failure.fix ? failure.fix : "Нажмите «Обновить» и повторите.",
            });
          });
        }

        /* Связи и координаты на карточках — часть объяснения, а не только картинка. */
        function renderLayoutHint() {
          if (!payload || !payload.exists || builder) return null;
          return h("div", { id: "pg-layout-hint", style: S.hint },
            "Узлы можно двигать: тяните карточку мышью — связи идут за ней. "
            + "С клавиатуры: Tab до карточки, стрелки — 8 px, Shift+стрелка — 1 px. "
            + "Позиция сохраняется в " + (payload.structureDir || "structure") + "/*.json; "
            + "кнопка «Сбросить схему» убирает её и возвращает расчётные места. "
            + "Границу воркспейса можно тянуть мышью: стрелки — 8 px, Shift — 1 px, "
            + "Home — сброс на 20 px, двойной щелчок по риске — тоже сброс.");
        }

        /* Полная подпись карточки: роль, связь словами, расписание, «папка — не агент». */
        function libraryAria(item) {
          const edgeWords = item.link ? item.link.words : "связей с агентами нет";
          return item.label + ": " + edgeWords
            + (item.schedule ? ", ежедневно " + item.schedule.at : "")
            + (item.type === "exchange" || item.type === "folder" ? ", папка — не агент" : "")
            + ". Enter — взять карточку, стрелки — двигать, Enter — поставить, Esc — отмена.";
        }

        /*
         * Вынос карточки: pointerdown начинает перенос (beginPointerCarry), Enter
         * и Space берут её с клавиатуры (beginKeyboardCarry). Те же обработчики
         * стоят и на большой карточке, и на иконке корешка — иначе свёрнутая
         * палитра перестала бы быть палитрой (макет §3.5).
         */
        function libraryHandlers(item) {
          return {
            onPointerDown: (event) => beginPointerCarry(event, item),
            onKeyDown: (event) => {
              if (!event) return;
              /*
               * Пока карточка в руке, клавиши обрабатывает окно: второй Enter
               * ставит узел, стрелки двигают точку, Esc отменяет. Иначе фокус
               * на карточке съел бы Enter и вынос начался бы заново.
               */
              if (carry) return;
              if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
                event.preventDefault();
                /* Тот же Enter не должен дойти до окна: иначе он сразу поставит узел. */
                event.stopPropagation();
                beginKeyboardCarry(item);
              }
            },
          };
        }

        /* Палитра слева: три карточки со связью по умолчанию словами. */
        function renderLibrary() {
          if (!payload || !payload.exists || builder) return null;
          /*
           * 0143: счётчик элементов — часть развёрнутой палитры. В свёрнутом
           * корешке его нет (там 44 px и три иконки): одна точка правды для
           * панели и проверки — paletteCounterVisible(libraryOpen).
           */
          const showCounter = paletteCounterVisible(libraryOpen);
          /*
           * Свёрнутая палитра — корешок книги (макет §3): 44 px, вертикальная
           * надпись снизу вверх и ровно три иконки 32×32. Ни стрелки, ни
           * галочки: вся полоса и есть палитра, а надпись — кнопка разворота.
           * Ширина не анимируется: transition на width гнал бы SVG канвы
           * пересчитываться в каждом кадре.
           */
          if (!libraryOpen) {
            const tiles = spineIcons((payload.graph && payload.graph.nodes) || []);
            return h("div", {
              ref: libraryRef,
              "data-library": "palette",
              "data-library-collapsed": "1",
              style: S.librarySpine,
            },
              h("span", { "data-library-page-edge": "1", "aria-hidden": "true", style: S.pageEdge }),
              h("div", { style: { display: "flex", flex: "1 1 auto", minHeight: 0, width: "100%", justifyContent: "center" } },
                h("button", {
                  type: "button",
                  id: "pg-spine-toggle",
                  "aria-expanded": "false",
                  "aria-controls": "pg-library-items",
                  "aria-label": "Развернуть набор узлов структуры",
                  title: "Развернуть набор узлов структуры — панель 250 px",
                  style: S.spineButton,
                  onClick: () => {
                    setLibraryOpen(true);
                    uiStore.save(uiRootName(), { libraryOpen: true, outside: outsideRef.current });
                    setLive("библиотека узлов развёрнута");
                  },
                },
                  spineShort ? null : h("span", { "data-library-spine-text": "1", style: S.spineText }, SPINE_LABEL))),
              h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", flex: "0 0 auto", width: "100%" } },
                tiles.map((tile) => h("button", {
                  key: tile.role,
                  type: "button",
                  "data-library": tile.role,
                  "data-library-icon": tile.role,
                  style: { ...S.spineIcon, ...(spineFocus === tile.role ? S.spineIconFocus : null) },
                  title: tile.label + " — " + ((tile.item.link && tile.item.link.words) || "папка, не агент"),
                  "aria-label": libraryAria(tile.item),
                  ...libraryHandlers(tile.item),
                  onFocus: () => setSpineFocus(tile.role),
                  onBlur: () => setSpineFocus(null),
                },
                  h("span", {
                    style: { position: "absolute", left: 0, top: 0, width: "4px", height: "100%", borderRadius: "2px", background: tile.stripe },
                  }),
                  h("span", { "aria-hidden": "true" }, tile.icon)))),
              /*
               * aria-controls ведёт на этот контейнер, и он есть в DOM всегда:
               * в свёрнутом виде скрыт стилями, а не удалён (макет §3.8).
               */
              h("div", { id: "pg-library-items", "data-library-open": "false", style: { display: "none" } }));
          }
          const items = NODE_LIBRARY.map((item) => {
            const edgeWords = item.link ? item.link.words : "связей с агентами нет";
            const aria = libraryAria(item);
            const handlers = libraryHandlers(item);
            /*
             * Карточка (0126 C1/C2): подпись НАД плиткой, ниже роль и вид связи
             * словами, затем краткое назначение. Порядок частей задаёт
             * libraryCardParts, подсказку при наведении — libraryHoverText:
             * панель пользуется теми же функциями, что и проверка.
             */
            const cardBase = {
              position: "relative", display: "block", width: "176px", height: "62px",
              borderRadius: "10px", background: "#efeff3",
              border: "1px solid " + T.border2, overflow: "hidden",
            };
            const stripe = { position: "absolute", left: 0, top: 0, width: "4px", height: "100%", borderRadius: "2px", background: libraryRoleColor(item.type) };
            const plus = { position: "absolute", right: "7px", top: "7px", width: "16px", height: "16px", borderRadius: "999px", border: "1px solid " + T.border2, background: "#fff", color: T.link, fontSize: "12px", lineHeight: "14px", textAlign: "center", fontWeight: 700 };
            const folder = item.type === "exchange" || item.type === "folder";
            const roleWords = (item.role || "папка") + " · " + (folder ? "не агент" : "work");
            const linkWords = edgeWords
              + (item.schedule ? " · ежедневно " + item.schedule.at : (folder ? " · папка, не агент" : ""));
            const parts = {
              label: h("span", {
                key: "label",
                style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "2px", paddingLeft: "2px", fontSize: "11px", fontWeight: 700, color: T.text },
              },
                h("span", { "aria-hidden": "true", style: { width: "4px", height: "12px", borderRadius: "2px", background: libraryRoleColor(item.type) } }),
                item.label),
              tile: h("span", { key: "tile", style: cardBase },
                h("span", { style: stripe }),
                h("span", { style: plus, "aria-hidden": "true" }, "+"),
                h("span", { style: { position: "absolute", left: "14px", top: "9px", fontFamily: T.mono, fontSize: "12.5px", fontWeight: 600 } }, item.type),
                h("span", {
                  style: { position: "absolute", left: "14px", top: "31px", right: "8px", fontSize: "9.5px", color: T.tertiary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
                  title: item.model ? "рекомендованная модель карточки" : undefined,
                }, item.model ? "модель · " + item.model : (item.icon || "＋"))),
              role: h("span", { key: "role", style: { display: "block", marginTop: "4px", fontSize: "10.5px", color: T.tertiary } }, roleWords),
              link: h("span", { key: "link", style: { display: "block", marginTop: "1px", fontSize: "9.5px", fontWeight: 600, color: T.secondary } }, linkWords),
              brief: h("span", { key: "brief", style: { display: "block", marginTop: "2px", fontSize: "10.5px", lineHeight: 1.4, color: T.secondary } }, item.brief),
            };
            return h("button", {
              key: item.type,
              type: "button",
              "data-library": item.type,
              style: { display: "block", width: "100%", padding: 0, border: 0, background: "none", textAlign: "left", cursor: "grab", borderRadius: "12px" },
              title: libraryHoverText(item),
              "aria-label": aria,
              ...handlers,
            }, libraryCardParts(item).map((part) => parts[part] || null));
          });
          /*
           * Колонка как в макете: белая панель с тенью и скруглением 16, заголовок
           * 0.98rem, счётчик элементов, кнопка сворачивания справа.
           */
          const paletteStyle = { ...S.library, width: "250px", flex: "0 0 250px", padding: "12px 12px 14px", borderRadius: "16px", background: "var(--dsw-alias-bg-base, #fff)", boxShadow: "0 8px 22px rgb(20 20 45 / 6%)", gap: "10px" };
          return h("div", { ref: libraryRef, "data-library": "palette", "data-library-open": "true", style: paletteStyle },
            /* Шапка — одна строка: счётчик не переносится, заголовок ужимается. */
            h("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "nowrap", minWidth: 0 } },
              h("span", {
                style: {
                  fontWeight: 700, fontSize: "0.98rem", minWidth: 0,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                },
              }, "Библиотека узлов"),
              showCounter
                ? h("span", {
                  "data-library-counter": "1",
                  title: "элементов в библиотеке: " + NODE_LIBRARY.length,
                  style: {
                    marginLeft: "auto", padding: "1px 7px", border: "1px solid " + T.border2,
                    borderRadius: "999px", fontSize: "10px", color: T.secondary,
                    whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", flex: "0 0 auto",
                  },
                }, libraryCountLabel(NODE_LIBRARY.length))
                : null,
              h("button", {
                type: "button",
                "data-library-collapse": "1",
                /*
                 * Кнопка — иконкой, а не словом (0143): «Свернуть» забирала
                 * ~75 px, и счётчик ломался на две строки. Подпись осталась в
                 * aria-label/title — для скринридера и наведения.
                 */
                style: {
                  ...S.button, width: "21px", height: "21px", minWidth: "21px",
                  padding: 0, lineHeight: 1, fontSize: "14px", flex: "0 0 auto",
                },
                "aria-expanded": "true",
                "aria-controls": "pg-library-items",
                "aria-label": "Свернуть библиотеку узлов",
                title: "Свернуть библиотеку: схема получит больше места",
                onClick: () => {
                  setLibraryOpen(false);
                  uiStore.save(uiRootName(), { libraryOpen: false, outside: outsideRef.current });
                  setLive("библиотека узлов свёрнута: схема получила больше места");
                },
              }, "‹")),
            h("div", {
              id: "pg-library-items",
              "data-library-open": "true",
              style: { display: "flex", flexDirection: "column", gap: "10px" },
            }, items),
            h("div", { style: { ...S.hint, fontSize: "0.76rem", lineHeight: 1.45 } },
              "Перетащите карточку на схему — узел встанет в точке сброса и сразу получит связь по умолчанию. "
              + "С клавиатуры: Tab до карточки, Enter — взять, стрелки — двигать, Enter — поставить, Esc — отмена."));
        }

        /* Итог постановки — под палитрой во всю ширину: в свёрнутой полосе он не влезает. */
        function renderLibraryNote() {
          if (!libraryNote || !payload || !payload.exists || builder) return null;
          return h("div", { style: S.info, role: "status" }, libraryNote.text);
        }

        /* Строка над канвой: карточка взята и ждёт постановки. */
        function renderCarryHint() {
          if (!carry) return null;
          return h("div", { style: S.info, role: "status" },
            "Карточка «" + carry.item.label + "» "
            + (carry.mode === "keyboard"
              ? "взята с клавиатуры: стрелки двигают точку, Enter ставит узел, Esc отменяет."
              : "в руке: отпустите над канвой, чтобы поставить узел; Esc отменяет."));
        }

        /* Призрак карточки под курсором: видно, что именно несут и куда. */
        function renderLibraryGhost() {
          if (!carry || carry.mode !== "pointer") return null;
          const item = carry.item;
          return h("div", {
            "data-library-ghost": item.type,
            style: {
              position: "fixed",
              left: (carry.clientX - 88) + "px",
              top: (carry.clientY - 31) + "px",
              width: "176px",
              height: "62px",
              padding: "6px 10px",
              boxSizing: "border-box",
              borderRadius: "10px",
              border: "1px dashed " + (carry.overCanvas ? T.link : T.warn),
              background: "var(--dsw-alias-bg-base, #ffffff)",
              color: T.text,
              boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
              pointerEvents: "none",
              zIndex: 60,
              fontSize: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "2px",
            },
          },
            h("span", { style: { fontWeight: 600, fontFamily: T.mono } }, item.label),
            h("span", { style: { color: T.tertiary, fontSize: "10px" } },
              item.link ? item.link.words : (item.words || "только сообщения")));
        }

        /* Пунктирный контур будущего узла на канве: место видно до сброса. */
        function renderCarryOutline(width, height) {
          if (!carry) return null;
          let left;
          let top;
          if (carry.mode === "keyboard") {
            left = carry.x + 16;
            top = carry.y + 16;
          } else {
            if (!carry.overCanvas) return null;
            const canvas = canvasRef.current;
            if (!canvas) return null;
            const rect = canvas.getBoundingClientRect();
            left = carry.clientX - rect.left + canvas.scrollLeft - 88;
            top = carry.clientY - rect.top + canvas.scrollTop - 31;
          }
          return h("div", {
            "data-library-target": carry.item.type,
            style: {
              position: "absolute",
              left: Math.max(0, Math.min(left, width + 16 - 176)) + "px",
              top: Math.max(0, Math.min(top, height + 16 - 62)) + "px",
              width: "176px",
              height: "62px",
              borderRadius: "10px",
              border: "2px dashed " + T.link,
              background: "transparent",
              pointerEvents: "none",
              zIndex: 4,
            },
          });
        }

        /*
         * «Настройки» — третья вкладка окна узла (задание 0122): прежние поля
         * формы (id в чтении, роль, модель, назначение, расписание, связи) и
         * одно «Сохранить». Пути записи прежние: POST /api/node и /api/schedule.
         * Подложку, заголовок и вкладки держит renderNodeInfo: вкладка не
         * открывает второе модальное окно поверх первого.
         * Ошибка говорит тремя частями: что, почему, что сделать.
         */
        function renderNodeEditModal() {
          if (!nodeEditor) return null;
          const graph = (payload && payload.graph) || { models: {}, nodes: [], edges: [] };
          const node = ((graph.nodes) || []).find((item) => item && item.id === nodeEditor.id);
          if (!node) return null;
          const exchange = isFolderNode(nodeEditor);
          const others = ((graph.nodes) || []).filter((item) => item.id !== nodeEditor.id && !isFolderNode(item));
          const edges = ((graph.edges) || []).filter((edge) => edge.from === nodeEditor.id || edge.to === nodeEditor.id);
          const target = others.some((item) => item.id === editorEdge.target) ? editorEdge.target : ((others[0] && others[0].id) || "");
          const dirty = nodeEditorChanged();
          /*
           * Маршрут узла выбирается из ЖИВОГО каталога (/api/models): провайдер и
           * модель. Текущая пара остаётся в списке, даже если каталог её уже не
           * знает; тогда рядом честная строка «модель не найдена в каталоге».
           * Первая модель каталога не подставляется — пустой выбор это отказ.
           */
          const currentProvider = String(nodeEditor.provider || "");
          const currentModel = String(nodeEditor.model || "");
          const providerList = Array.isArray(availableModels) ? [...availableModels] : [];
          if (currentProvider && !providerList.some((item) => item && item.id === currentProvider)) {
            providerList.unshift({ id: currentProvider, name: currentProvider, models: [] });
          }
          const selectedProvider = providerList.find((item) => item && item.id === currentProvider) || null;
          const providerModels = selectedProvider && Array.isArray(selectedProvider.models) ? selectedProvider.models : [];
          const modelKnown = Boolean(currentModel && providerModels.some((item) => item && item.id === currentModel));
          const modelList = providerModels.map((item) => ({ ...item }));
          if (currentModel && !modelKnown) modelList.push({ id: currentModel, name: currentModel });
          const field = (label, control) => h("div", { style: S.editorRow },
            h("span", { style: S.label }, label), control);
          /*
           * Поля формы — из nodeFormFields (0126 C3): id и роль читаются,
           * назначение и спека правятся. Спека — textarea: в неё входит текст
           * роли с Definition of Done, а пустое значение означает роль без спеки.
           */
          const formField = (key) => {
            const def = nodeFormFields().find((entry) => entry.key === key);
            if (!def) return null;
            const value = key === "id" ? nodeEditor.id : String(nodeEditor[key] || "");
            const common = {
              "aria-label": def.aria,
              ...(def.title ? { title: def.title } : {}),
              ...(def.placeholder ? { placeholder: def.placeholder } : {}),
            };
            if (def.kind === "readonly") {
              return field(def.label, h("input", {
                ...common, style: { ...S.input, width: def.width }, value, readOnly: true,
              }));
            }
            if (def.kind === "textarea") {
              return field(def.label, h("textarea", {
                ...common,
                style: { ...S.input, width: "100%", minHeight: "112px", resize: "vertical", fontFamily: T.mono, fontSize: "11.5px", lineHeight: 1.45 },
                rows: def.rows || 6,
                value,
                "data-node-field": def.key,
                onChange: (event) => setNodeEditor({ ...nodeEditor, [def.key]: event.target.value }),
              }));
            }
            return field(def.label, h("input", {
              ...common,
              style: { ...S.input, width: def.width },
              value,
              "data-node-field": def.key,
              onChange: (event) => setNodeEditor({ ...nodeEditor, [def.key]: event.target.value }),
            }));
          };
          return h("div", {
            "data-node-editor": nodeEditor.id,
            "data-node-settings": nodeEditor.id,
            role: "group",
            "aria-label": "Редактировать узел " + nodeEditor.id,
            style: { display: "flex", flexDirection: "column", gap: "10px", minHeight: 0 },
          },
            dirty ? h("span", { style: S.chip, "data-editor-dirty": "1" }, "изменено · не сохранено") : null,
            formField("id"),
            formField("role"),
            exchange
              ? field("Модель", h("span", { style: S.hint }, "без модели — папка обмена не агент, запускать нечего"))
              : h(React.Fragment, null,
                field("Провайдер", h("select", {
                  style: { ...S.select, minWidth: "180px" },
                  value: currentProvider,
                  "aria-label": "провайдер узла в редакторе",
                  disabled: availableModels === null,
                  onChange: (event) => setNodeEditor({
                    ...nodeEditor, provider: event.target.value, model: "", family: "",
                  }),
                },
                  h("option", { value: "" }, "выберите провайдера"),
                  providerList.map((provider) => h("option", { key: "pe-" + provider.id, value: provider.id },
                    provider.id + (provider.name && provider.name !== provider.id ? " — " + provider.name : ""))))),
                field("Модель", h("select", {
                  style: { ...S.select, minWidth: "180px" },
                  value: currentModel,
                  "aria-label": "модель узла в редакторе",
                  disabled: availableModels === null || !selectedProvider,
                  onChange: (event) => {
                    const chosen = modelList.find((item) => item && item.id === event.target.value) || null;
                    setNodeEditor({
                      ...nodeEditor,
                      model: event.target.value,
                      family: chosen && chosen.family ? String(chosen.family) : "",
                    });
                  },
                },
                  h("option", { value: "" }, "выберите модель из списка"),
                  modelList.map((modelOption) => h("option", { key: "me-" + modelOption.id, value: modelOption.id },
                    modelOption.id + (modelOption.name && modelOption.name !== modelOption.id ? " — " + modelOption.name : ""))))),
                availableModels === null
                  ? field("Каталог", h("span", { style: S.hint }, "Загружаю живой список моделей…"))
                  : currentProvider && currentModel && !modelKnown
                    ? field("Каталог", h("span", { style: { ...S.hint, color: T.warn } },
                      "модель не найдена в каталоге: " + currentProvider + "/" + currentModel))
                    : null,
                availableModels !== null && modelsError
                  ? field("Каталог", h("span", { style: { ...S.hint, color: T.warn } },
                    "Список моделей недоступен: " + modelsError.message))
                  : null,
                nodeEditor.family
                  ? field("Семейство", h("span", { style: S.hint }, nodeEditor.family))
                  : null),
            formField("brief"),
            formField("prompt"),
            nodeEditor.withSchedule && !exchange
              ? field("Расписание", h("span", { style: { display: "inline-flex", gap: "6px", alignItems: "center" } },
                h("input", {
                  type: "time",
                  style: { ...S.input, width: "100px" },
                  value: nodeEditor.at,
                  "aria-label": "время запуска в редакторе",
                  onChange: (event) => setNodeEditor({ ...nodeEditor, at: event.target.value }),
                }),
                h("span", { style: S.hint }, "ежедневно, " + nodeEditor.timeZone)))
              : field("Расписание", h("span", { style: S.hint }, exchange
                ? "нет: папка обмена не запускается сама"
                : "нет: узел запускается только по поручению")),
            exchange
              ? h("div", null,
                h("div", { style: { marginTop: "2px", fontWeight: 600, fontSize: "12px" } }, "Участники обмена"),
                h("div", { style: S.hint },
                  "Отметьте воркспейсы, между которыми идёт обмен: каждый получает спеку с императивом проверять папку на новые сообщения для него."),
                (status && Array.isArray(status.roots) ? status.roots : []).map((rootPath) => {
                  const current = exchangeDraft && exchangeDraft.node === nodeEditor.id
                    ? exchangeDraft.list
                    : ((payload.graph.nodes.find((item) => item.id === nodeEditor.id) || {}).participants || []);
                  const checked = current.some((item) => String(item).toLowerCase() === String(rootPath).toLowerCase());
                  return h("label", {
                    key: rootPath,
                    style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "11px", fontFamily: T.mono, padding: "2px 0" },
                  },
                    h("input", {
                      type: "checkbox",
                      checked,
                      "aria-label": "участник обмена " + rootPath,
                      onChange: () => toggleParticipant(nodeEditor.id, rootPath),
                    }),
                    h("span", null, String(rootPath).split(/[\\/]/u).pop() + " — " + rootPath));
                }),
                h("div", { style: S.editorRow },
                  h("button", { type: "button", style: S.button, onClick: () => saveParticipants(nodeEditor.id) }, "Сохранить участников"),
                  h("span", { style: S.hint }, "участников: " + ((exchangeDraft && exchangeDraft.node === nodeEditor.id ? exchangeDraft.list : ((payload.graph.nodes.find((item) => item.id === nodeEditor.id) || {}).participants || [])).length))))
              : null,
            h("div", { style: { marginTop: "2px", fontWeight: 600, fontSize: "12px" } }, "Связи"),
            exchange
              ? h("div", { style: S.hint },
                "У папки общего обмена связей с агентами нет: её связь с миром — сами сообщения (только сообщения).")
              : (edges.length > 0
                ? h("ul", { style: S.linkList }, edges.map((edge) =>
                  h("li", { key: edge.from + "->" + edge.to + "-" + edge.kind },
                    describeEdge(edge, nodeEditor.id),
                    h("button", {
                      type: "button",
                      style: { padding: "0 6px", marginLeft: "6px", borderRadius: "6px", border: "1px solid " + T.border1, background: T.bg1, color: T.text, cursor: "pointer", fontSize: "12px" },
                      disabled: nodeEditorBusy,
                      title: "удалить связь",
                      onClick: () => removeEditorLink(edge),
                    }, "×"))))
                : h("div", { style: S.hint }, "Связей нет: узел никому не поручает, и его работу никто не проверяет.")),
            exchange
              ? null
              : h("div", { style: S.editorRow },
                h("select", {
                  style: S.select,
                  value: editorEdge.kind,
                  "aria-label": "вид связи в редакторе",
                  onChange: (event) => setEditorEdge({ ...editorEdge, kind: event.target.value }),
                },
                  h("option", { value: "delegate" }, "delegate — поручение"),
                  h("option", { value: "review" }, "review — проверка"),
                  h("option", { value: "report" }, "report — возврат"),
                  h("option", { value: "peer" }, "peer — равные")),
                editorEdge.kind === "peer" ? null : h("select", {
                  style: S.select,
                  value: editorEdge.direction,
                  "aria-label": "направление связи в редакторе",
                  onChange: (event) => setEditorEdge({ ...editorEdge, direction: event.target.value }),
                },
                  h("option", { value: "from" }, "от этого узла"),
                  h("option", { value: "to" }, "к этому узлу")),
                h("select", {
                  style: S.select,
                  value: target,
                  "aria-label": "узел связи в редакторе",
                  onChange: (event) => setEditorEdge({ ...editorEdge, target: event.target.value }),
                },
                  others.length === 0
                    ? h("option", { value: "" }, "других узлов нет")
                    : others.map((item) => h("option", { key: item.id, value: item.id },
                      item.id + (item.role ? " · " + item.role : "")))),
                h("button", {
                  type: "button",
                  style: S.button,
                  "data-editor-edge-add": "1",
                  disabled: nodeEditorBusy || !target,
                  onClick: addEditorLink,
                }, "Добавить связь")),
            nodeEditorError
              ? h("div", { style: S.error },
                h("div", { style: S.errorTitle }, nodeEditorError.what),
                h("div", { style: S.fix }, "Почему: " + nodeEditorError.why),
                h("div", { style: S.fix }, "Что сделать: " + nodeEditorError.fix))
              : null);
          /*
           * Действий записи здесь больше нет (0160): «Сохранить» и «Удалить узел»
           * живут в закреплённой линейке окна — renderNodeSettingsFooter. Поля
           * прокручиваются, линейка стоит: кнопки видны всегда, а не в конце
           * длинной вкладки.
           */
        }

        /*
         * Окно узла (задание 0122, макет C): одна форма с тремя вкладками.
         * «Сведения» — паспорт объявления, «Состояние» — что происходит сейчас,
         * «Настройки» — прежняя форма записи. Чтение отдельно от правки:
         * «Сведения» и «Состояние» ничего не сохраняют, а паспорт не смешивается
         * с живым состоянием. Папка обмена — не агент: у неё те же сведения.
         */
        function renderNodeRow(row, extra, title) {
          const mono = row.key === "links" || row.key === "report";
          /* Спека многострочная: переносы и моноширинный шрифт — часть чтения. */
          const spec = row.key === "prompt";
          const valueStyle = spec
            ? { ...S.modalValue, whiteSpace: "pre-wrap", fontFamily: T.mono, fontSize: "11.5px", lineHeight: 1.45 }
            : mono ? { ...S.modalValue, fontSize: "12px" } : S.modalValue;
          return h("div", { key: row.key, "data-node-row": row.key, title: title || undefined, style: S.modalRow },
            h("span", { style: S.modalLabel }, row.label),
            h("span", { style: valueStyle }, row.value),
            extra || null);
        }

        /* Паспорт: только объявление узла, без живого состояния. */
        function renderNodePassportTab(node, edges) {
          const rows = nodePassportRows(node, edges);
          const modelView = nodeModelView(node, payload.graph);
          return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" }, "data-node-passport": node.id },
            h("div", { style: S.nodeTabNote }, "паспорт узла · только чтение"),
            rows.map((row) => renderNodeRow(row)),
            modelView && modelView.hint
              ? h("div", { key: "catalog", "data-node-row": "catalog", style: S.modalRow },
                h("span", { style: S.modalLabel }, "Каталог"),
                h("span", { style: { ...S.modalValue, color: modelView.kind === "available" ? T.text : T.warn } }, modelView.hint))
              : null);
        }

        /*
         * Живое состояние словами: слово с фразой, источник, отчёт, сессия,
         * расписание и ветка. Панель отдаёт строки в nodeStateRows — те же
         * строки видит проверка без DOM, поэтому вкладка не обрастает копией.
         */
        function nodeStateView(node) {
          const run = runStates[node.id];
          const state = nodeState({
            active: activeIds.has(node.id),
            self: Boolean(selfRunning && payload && payload.selfNode === node.id),
            run,
            activityKnown,
            source: liveSources[node.id],
          });
          const runAt = run && (run.finishedAt || run.since);
          const runClock = runAt ? new Date(runAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
          const scheduleInfo = payload && payload.schedule ? payload.schedule[node.id] : null;
          const folder = isFolderNode(node);
          const looksCritic = /^critic(-|$)/iu.test(String(node.id || ""))
            || /критик|critic/iu.test(String(node.role || ""));
          /* Проекция называет сессию узла; объявление сильнее — оно и остаётся. */
          const binding = liveBinding && liveBinding.node === node.id && !node.session
            ? bindingView(liveBinding, Date.now())
            : "";
          const branchSteps = run && run.branchId
            ? runList.filter((item) => item && item.branchId === run.branchId)
            : [];
          const sourceWords = folder
            ? "не применимо: папка обмена — не агент"
            : state.source === "session"
              ? "по журналу сессии — живого агента по этому узлу панель не видит"
              : state.source === "run"
                ? "журнал запусков — узел выполняется сейчас"
                  + (run && run.state === "running" && typeof run.since === "number"
                    ? ", запуск с " + new Date(run.since).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
                    : "")
                : state.source === "agent"
                  ? "живой агент — служба агентов видит его запущенным"
                  : "";
          const scheduleWords = scheduleInfo
            ? (scheduleInfo.daily || "ежедневно " + scheduleInfo.at) + " (" + scheduleInfo.timeZone + ")"
            : folder
              ? "нет — папка обмена не запускается сама"
              : looksCritic
                ? "не задано — узел не запускается сам; сохраните время, расписание появится"
                : "выкл — узел не запускается сам, только по поручению";
          return {
            word: folder ? "папка обмена" : state.word,
            sentence: folder
              ? "не агент: здесь лежат сообщения, запускать нечего"
              : stateSentence(state, run, runClock),
            source: sourceWords,
            report: run && run.report ? run.report : "",
            session: node.session ? "привязана: " + node.session : binding,
            schedule: scheduleWords,
            next: scheduleInfo ? scheduleMoment(scheduleInfo) : "",
            branch: branchSteps.length > 0
              ? "шагов " + branchSteps.length + ": "
                + branchSteps
                  .map((step) => step.node + " — " + nodeState({ active: false, run: step, activityKnown: true }).word)
                  .join(", ")
              : "",
            folder,
            state,
            run,
            scheduleInfo,
          };
        }

        /* Вкладка «Состояние»: только чтение, действия — лишь привязка сессии. */
        function renderNodeStateTab(node) {
          const view = nodeStateView(node);
          return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" }, "data-node-state": node.id },
            h("div", { style: S.nodeTabNote }, "живое состояние · только чтение"),
            nodeStateRows(view).map((row) => renderNodeRow(row, row.key === "session" && !view.folder
              ? h("span", { style: { display: "inline-flex", gap: "6px", flexWrap: "wrap" } },
                h("button", {
                  type: "button",
                  style: S.button,
                  "data-node-bind": "1",
                  disabled: !current || !current.sessionId,
                  title: current && current.sessionId ? "текущая сессия: " + current.sessionId : "панель не знает текущую сессию",
                  onClick: () => bindSession(node.id, current && current.sessionId),
                }, "Привязать текущую"),
                node.session
                  ? h("button", {
                    type: "button",
                    style: S.button,
                    "data-node-unbind": "1",
                    onClick: () => bindSession(node.id, null),
                  }, "Отвязать")
                  : null)
              : null, row.key === "branch" && view.run
              ? "шаги одного запуска project_graph_branch; их общий id: " + String(view.run.branchId)
              : undefined)));
        }

        /* Вкладки окна: «Настройки» открывают ту же форму, а не второе окно. */
        function renderNodeTabs(active) {
          return h("div", { style: S.nodeTabs, role: "tablist", "aria-label": "вкладки окна узла" },
            nodeTabs().map((tab) => h("button", {
              key: tab.id,
              type: "button",
              role: "tab",
              "data-node-tab": tab.id,
              "aria-selected": active === tab.id ? "true" : "false",
              title: tab.hint,
              style: active === tab.id ? { ...S.nodeTab, ...S.nodeTabActive } : S.nodeTab,
              onClick: () => openNodeWindowTab(tab.id),
            }, tab.label)));
        }

        /*
         * Линейка «Настроек» (0160): «Сохранить» — основная кнопка, «Удалить
         * узел» — вторичная опасная в правом конце. Обе видны всегда: без правок
         * «Сохранить» недоступна, но не исчезает — иначе непонятно, что запись
         * вообще есть. Счёт находок валидатора называет линейка, а не подсказка.
         */
        function renderNodeSettingsFooter(node) {
          const changed = nodeEditor ? changedEditorFields(nodeEditor, nodeEditorBaseline).length : 0;
          const findings = validatorFindingsCount(payload && payload.validation);
          const state = settingsFooterState({ changed, findings, busy: nodeEditorBusy });
          const coordinator = isCoordinatorNode(node);
          const noteColor = state.note.tone === "danger" ? T.danger
            : state.note.tone === "warn" ? T.warn : T.tertiary;
          const style = settingsFooterStyle();
          if (state.frame === "danger") style.boxShadow = "inset 0 2px 0 " + T.danger;
          return h("div", {
            "data-settings-footer": "1",
            "data-settings-findings": String(findings),
            role: "toolbar",
            "aria-label": "действия вкладки «Настройки»: «Сохранить» и «Удалить узел»",
            style,
          },
            h("button", {
              type: "button",
              style: S.buttonPrimary,
              "data-editor-save": "1",
              "data-editor-save-disabled": state.save.disabled ? "1" : "0",
              disabled: state.save.disabled,
              title: state.save.disabled
                ? "изменений нет — записывать нечего"
                : "записать поля узла в structure/*.json",
              onClick: submitNodeEditor,
            }, state.save.label),
            h("span", { style: { ...S.hint, color: noteColor }, "data-settings-note": "1" }, state.note.text),
            h("span", { style: { flex: "1 1 auto" } }),
            h("button", {
              type: "button",
              style: { ...S.button, color: T.danger, borderColor: T.danger, opacity: coordinator ? 0.55 : 1 },
              "data-editor-remove": "1",
              disabled: state.remove.disabled || coordinator,
              title: coordinator
                ? "координатор не удаляется: он держит структуру воркспейса"
                : "удалить узел и все связи, где он участвует: панель спросит подтверждение",
              onClick: requestRemoveNode,
            }, "Удалить узел"));
        }

        function renderNodeWindowFooter(node, tab) {
          if (tab === "settings") return renderNodeSettingsFooter(node);
          return h("div", { style: S.modalFooter },
            h("button", {
              type: "button",
              style: tab === "info" ? S.buttonPrimary : S.button,
              "data-node-info-edit": "1",
              title: "вкладка «Настройки»: роль, модель, назначение, пресет, расписание и связи",
              onClick: editFromNodeInfo,
            }, "Изменить в «Настройках» →"),
            h("span", { style: S.hint }, tab === "info" ? "вкладка только для чтения" : "состояние только читается"),
            h("span", { style: { flex: "1 1 auto" } }),
            h("span", { style: S.hint }, "Esc — закрыть"));
        }

        /*
         * Окно узла: подложка, заголовок, вкладки и тело одной вкладки. Всё,
         * что можно сохранить, живёт только на «Настройках»; чтение не пишет.
         */
        function renderNodeInfo() {
          if (!nodeInfo) return null;
          const graph = (payload && payload.graph) || { nodes: [], edges: [], folders: [], models: {} };
          const settings = nodeTab === "settings" && Boolean(nodeEditor);
          const closeWindow = () => (settings ? requestCloseNodeEditor() : requestCloseNodeWindow());
          const closeButton = h("button", {
            type: "button",
            style: S.modalClose,
            "data-modal-close": "1",
            "data-node-info-close": "1",
            "data-editor-close": settings ? "1" : undefined,
            title: "крестик или Esc — закрыть; в «Настройках» при правках спросит подтверждение",
            "aria-label": "Закрыть окно узла",
            onClick: closeWindow,
          }, "×");

          if (nodeInfo.kind === "folder") {
            const folder = ((graph.folders) || []).find((item) => item && item.id === nodeInfo.id);
            if (!folder) return null;
            const box = folder.box && typeof folder.box === "object" ? folder.box : {};
            const exchangeInfo = folder.exchange && typeof folder.exchange === "object" ? folder.exchange : {};
            const participants = Array.isArray(folder.participants) ? folder.participants : [];
            const row = (label, value) => h("div", { style: S.modalRow },
              h("span", { style: S.modalLabel }, label),
              h("span", { style: S.modalValue }, value));
            return h("div", {
              "data-node-info": folder.id,
              "data-info-kind": "folder",
              style: S.modalBackdrop,
              onClick: closeNodeInfo,
              onContextMenu: (event) => { event.preventDefault(); closeNodeInfo(); },
            },
              h("div", {
                role: "dialog",
                "aria-modal": "true",
                "aria-label": "Сведения о папке обмена " + folder.id,
                style: { ...S.modal, ...S.modalInfo },
                onClick: (event) => event.stopPropagation(),
              },
                h("div", { style: S.modalHeader },
                  h("span", { style: S.modalTitle }, "Сведения о папке обмена"),
                  h("span", { style: { flex: "1 1 auto" } }),
                  closeButton),
                h("div", { style: S.modalBody },
                  row("id", folder.id),
                  row("Ящик", (box.path || "не задан") + (box.root ? " · " + box.root : "")),
                  row("Участники", participants.join(", ") || "не заданы — нужна хотя бы одна метка"),
                  row("Контракт", exchangeInfo.contract || "contract.md"),
                  row("Оркестратор", folder.orchestrator || "не задан"),
                  row("Связи", "папка обмена — не агент: её связь с миром — сами сообщения")),
                h("div", { style: S.modalFooter },
                  h("button", {
                    type: "button",
                    style: S.buttonPrimary,
                    "data-node-info-edit": "1",
                    onClick: editFromNodeInfo,
                  }, "Редактировать"),
                  h("span", { style: S.hint }, "крестик или Esc — закрыть"))));
          }

          const node = nodesById.get(nodeInfo.id);
          if (!node) return null;
          const tab = nodeTab === "state" ? "state" : (nodeTab === "settings" && nodeEditor ? "settings" : "info");
          const edges = ((graph.edges) || []).filter((edge) => edge.from === node.id || edge.to === node.id);
          const aria = (tab === "settings" ? "Редактировать узел " : tab === "state" ? "Состояние узла " : "Сведения об узле ") + node.id;
          return h("div", {
            "data-node-info": node.id,
            "data-info-kind": "node",
            "data-node-window-tab": tab,
            style: S.modalBackdrop,
            onClick: closeWindow,
            onContextMenu: (event) => { event.preventDefault(); closeWindow(); },
          },
            h("div", {
              role: "dialog",
              "aria-modal": "true",
              "aria-label": aria,
              style: { ...S.modal, ...S.modalNode },
              onClick: (event) => event.stopPropagation(),
            },
              h("div", { "data-settings-header": "1", style: settingsHeaderStyle() },
                h("span", { style: S.modalTitle }, "Узел " + node.id),
                h("span", { style: S.hint }, tab === "settings" ? "правка — одно «Сохранить»" : "только чтение · правка — на «Настройках»"),
                h("span", { style: { flex: "1 1 auto" } }),
                closeButton),
              h("div", { "data-settings-tabs": "1", style: settingsTabsBandStyle() },
                renderNodeTabs(tab)),
              /*
               * 0160: тело — отдельный прокручиваемый слот (flex: 1, minHeight: 0)
               * между двумя полосами flex: 0 0 auto. Линейка не «прилипает», она
               * не входит в прокрутку и уехать не может. Затемнение удаления —
               * дочерний слой того же слота, поэтому шапку и футер не накрывает.
               */
              h("div", { "data-settings-slot": "1", style: settingsBodySlotStyle() },
                h("div", {
                  "data-settings-body": tab === "settings" ? "1" : undefined,
                  "data-settings-body-overflow": settingsLayout().bodyOverflowY,
                  style: tab === "settings" ? settingsBodyStyle() : nodeBodyStyle(),
                },
                  tab === "settings"
                    ? renderNodeEditModal()
                    : tab === "state"
                      ? renderNodeStateTab(node)
                      : renderNodePassportTab(node, edges)),
                tab === "settings" ? renderNodeDeleteConfirm() : null),
              renderNodeWindowFooter(node, tab)));
        }
        /*
         * Диалог крестика: спрашивает только когда поля действительно менялись.
         * У папки «Да» сохраняет (тот же запрос, что основная кнопка) и закрывает,
         * «Нет» закрывает без записи. У узла остаётся предупреждение о потере.
         * Esc и клик вне диалога — вернуться к редактированию.
         */
        function renderCloseConfirm() {
          if (!closeConfirm) return null;
          const nodeMode = closeConfirm === "node";
          const changed = changedEditorFields(nodeMode ? nodeEditor : folderEditor, nodeMode ? nodeEditorBaseline : folderEditorBaseline);
          const copy = closeConfirmView(nodeMode ? "node" : "folder");
          return h("div", {
            "data-close-confirm": "1",
            "data-close-confirm-mode": nodeMode ? "node" : "folder",
            style: { ...S.modalBackdrop, zIndex: 80 },
            onClick: () => setCloseConfirm(null),
            onContextMenu: (event) => { event.preventDefault(); setCloseConfirm(null); },
          },
            h("div", {
              role: "alertdialog",
              "aria-modal": "true",
              "aria-label": copy.title,
              style: { ...S.modal, width: "min(560px, calc(100vw - 32px))" },
              onClick: (event) => event.stopPropagation(),
            },
              h("div", { style: S.modalHeader },
                h("span", { style: S.modalTitle }, copy.title)),
              h("div", { style: S.modalBody },
                h("div", { style: { fontWeight: 600, fontSize: "14px" } }, copy.text),
                h("div", { style: S.hint }, changed.length > 0
                  ? "Не сохранено: " + changed.join(", ") + "."
                  : copy.fallback)),
              h("div", { style: S.modalFooter },
                nodeMode
                  ? h("button", {
                    type: "button",
                    style: S.button,
                    autoFocus: true,
                    "data-close-continue": "1",
                    onClick: () => setCloseConfirm(null),
                  }, copy.keep)
                  : h("button", {
                    type: "button",
                    style: S.buttonPrimary,
                    autoFocus: true,
                    "data-close-save": "1",
                    disabled: folderEditorBusy,
                    onClick: saveFolderAndClose,
                  }, copy.save),
                h("button", {
                  type: "button",
                  style: { ...S.button, color: T.danger, borderColor: T.danger },
                  "data-close-discard": "1",
                  onClick: discardEditorChanges,
                }, copy.discard))));
        }

        /*
         * Редактор папки обмена — модальное окно по центру: ящик (path + root),
         * метки участников и имя контракта. Кнопки: «Сохранить изменения» — запись папки,
         * «Уведомить участников» — Rev+1 и письма-приглашения, «Удалить папку» — с подтверждением.
         * Тот же крестик, что у узла: с правками сначала спросит подтверждение.
         */
        function renderFolderEditor() {
          if (!folderEditor) return null;
          const graph = (payload && payload.graph) || { nodes: [], folders: [] };
          const nodes = (graph.nodes || []).filter((node) => node && node.id);
          /* Черновик из портала ещё не объявлен: «Сохранить изменения» создаст папку. */
          const declared = (graph.folders || []).some((item) => item && item.id === folderEditor.id);
          /*
           * Сторона папки по ленте обмена (задание 0047): по ней видно, приняла ли
           * наша сторона папку. Ленты нет — действие не показывается, а не
           * выдумывается: состояние приходит только из /api/exchange.
           */
          const folderRecord = exchangeFolders(exchange)
            .find((item) => item && item.id === folderEditor.id) || null;
          const acceptAction = folderAcceptAction(folderRecord, exchange);
          const acceptNote = folderAcceptNote(folderRecord, exchange);
          const dirty = folderEditorChanged();
          /* Участник папки — только из реестра воркспейсов (/api/status.workspaces). */
          const registry = registryWorkspaces(status);
          const visible = filterWorkspaces(registry, participantSearch);
          const participantStates = participantRows(folderEditor.participants, registry);
          const unresolved = participantStates.filter((row) => !row.found);
          const field = (label, control) => h("div", { style: S.editorRow },
            h("span", { style: S.label }, label), control);
          const labelChip = (label) => {
            const entry = registryEntry(registry, label);
            const similar = entry ? [] : similarWorkspaces(registry, label).map((row) => row.label);
            return h("span", {
              key: label,
              style: entry ? S.chip : { ...S.chip, color: T.danger, borderColor: T.danger },
              /* title — абсолютный путь воркспейса (задание 0029). */
              title: entry
                ? entry.path
                : "метка вне реестра воркспейсов: не найден"
                  + (similar.length > 0 ? "; похожие: " + similar.join(", ") : ""),
              "data-participant-resolved": entry ? "1" : "0",
              "data-participant-label": label,
            },
              entry ? participantLabel(entry) : label + " (не найден)",
              h("button", {
              type: "button",
              "aria-label": "убрать метку " + label,
              style: { marginLeft: "4px", padding: "0 4px", borderRadius: "6px", border: "1px solid " + T.border1, background: "transparent", color: T.text, cursor: "pointer", fontSize: "11px" },
              onClick: () => removeFolderParticipant(label),
              }, "×"));
          };
          return h("div", {
            "data-folder-edit": folderEditor.id,
            style: S.modalBackdrop,
            onClick: requestCloseFolderEditor,
            onContextMenu: (event) => { event.preventDefault(); requestCloseFolderEditor(); },
          },
            h("div", {
              "data-folder-editor": folderEditor.id,
              role: "dialog",
              "aria-modal": "true",
              "aria-label": "редактор папки обмена " + folderEditor.id + ": модальное окно по центру",
              style: S.modal,
              onClick: (event) => event.stopPropagation(),
            },
              h("div", { style: S.modalHeader },
                h("span", { style: S.modalTitle }, "Папка обмена " + folderEditor.id),
                dirty ? h("span", { style: S.chip, "data-folder-dirty": "1" }, "изменено · не сохранено") : null,
                h("button", {
                  type: "button",
                  style: S.modalClose,
                  "data-modal-close": "1",
                  "data-folder-close": "1",
                  title: "крестик: при несохранённых правках спросит «Сохранить изменения?»",
                  "aria-label": "Закрыть редактор папки",
                  onClick: requestCloseFolderEditor,
                }, "×")),
              h("div", { style: S.modalBody },
            field("Ящик", h("span", { style: { display: "inline-flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
              h("input", {
                style: { ...S.input, width: "150px" },
                value: folderEditor.boxPath,
                placeholder: "coordination",
                "aria-label": "путь ящика папки",
                onChange: (event) => setFolderField("boxPath", event.target.value),
              }),
              h("select", {
                style: S.select,
                value: folderEditor.boxRoot,
                "aria-label": "корень ящика папки",
                onChange: (event) => setFolderField("boxRoot", event.target.value),
              },
                h("option", { value: "workspace" }, "workspace — внутри воркспейса"),
                h("option", { value: "shared" }, "shared — общий корень участников")))),
            field("Участники (метки)", h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
              h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
                folderEditor.participants.length === 0
                  ? h("span", { style: S.hint }, "меток нет — нужна хотя бы одна")
                  : folderEditor.participants.map(labelChip)),
              /*
               * Реестр воркспейсов с поиском по подстроке (задание 0024).
               * Поле ввода здесь — поиск, а не метка: метка ставится кликом по
               * элементу списка, поэтому свободного ввода метки в панели нет.
               */
              h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, "data-participant-registry": "1" },
                h("input", {
                  style: { ...S.input, width: "220px" },
                  value: participantSearch,
                  placeholder: "поиск по реестру: structure",
                  "data-participant-search": "1",
                  "aria-label": "поиск участника по реестру воркспейсов",
                  onChange: (event) => setParticipantSearch(event.target.value),
                }),
                registry.length === 0
                  ? h("span", { style: S.hint },
                    "реестр воркспейсов пуст: объявите participants в cordis.patch.yml (метка: абсолютный путь).")
                  : (visible.length === 0
                    ? h("span", { style: S.hint }, "по запросу «" + participantSearch + "» в реестре ничего нет")
                    : h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
                      visible.map((item) => h("button", {
                        type: "button",
                        key: item.label,
                        style: { ...S.button, opacity: folderEditor.participants.includes(item.label) ? 0.5 : 1 },
                        title: item.path,
                        disabled: folderEditor.participants.includes(item.label),
                        "data-participant-option": item.label,
                        "data-participant-label": item.label,
                        onClick: () => addFolderParticipant(item.label),
                      }, participantLabel(item)))))),
              unresolved.length > 0
                ? h("div", { style: S.error, "data-participant-unresolved": "1" },
                  h("div", { style: S.errorTitle },
                    "Метка вне реестра — не найден: " + unresolved.map((row) => row.label).join(", ")),
                  unresolved.some((row) => row.similar.length > 0)
                    ? h("div", { style: S.fix },
                      "Похожие метки: " + unresolved.flatMap((row) => row.similar).join(", "))
                    : h("div", { style: S.fix }, "Похожих меток в реестре нет"),
                  h("div", { style: S.fix },
                    "Сохранить нельзя: уберите метку и выберите воркспейс из реестра."))
                : null,
              h("span", { style: S.hint },
                "метка выбирается из реестра воркспейсов, свободного ввода нет; из меток контракт берёт Initiator и Invited."))),
            field("Контракт", h("input", {
              style: { ...S.input, width: "180px" },
              value: folderEditor.contract,
              placeholder: "contract-" + folderEditor.id + ".md",
              "aria-label": "имя контракта папки",
              onChange: (event) => setFolderField("contract", event.target.value),
            })),
            field("Оркестратор", nodes.length === 0
              ? h("span", { style: S.hint }, "узлов нет — папке некому говорить от её имени")
              : h("select", {
                style: S.select,
                value: folderEditor.orchestrator,
                "aria-label": "оркестратор папки",
                onChange: (event) => setFolderField("orchestrator", event.target.value),
              },
                h("option", { value: "" }, "выберите узел"),
                nodes.map((node) => h("option", { key: node.id, value: node.id },
                  node.id + (node.role ? " · " + node.role : ""))))),
            /*
             * Принятие папки (задание 0047): раньше accept существовал только в
             * API, и приглашённой стороне было нечего нажать. Кнопку видит ровно
             * та сторона, у которой ещё нет квитанции accepted; у принятой папки
             * вместо неё стоит «папка принята», у отключённой — честная причина.
             */
            field("Принятие папки", acceptAction
              ? h("span", { style: { display: "inline-flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
                h("button", {
                  type: "button",
                  style: S.buttonPrimary,
                  "data-folder-accept": "1",
                  title: "POST /api/folder?action=accept&root=…: квитанция Status: accepted в ящик папки от метки «"
                    + acceptAction.side + "». Повторное нажатие второго письма не пишет — сервер вернёт уже существующую квитанцию.",
                  disabled: folderEditorBusy || folderAcceptBusy,
                  onClick: () => acceptFolder(folderRecord, exchange),
                }, folderAcceptBusy ? "Принимаю…" : "Принять папку"),
                h("span", { style: S.hint }, "состояние стороны «" + acceptAction.side
                  + "»: invited — квитанции accepted в ящике ещё нет"))
              : h("span", { style: S.hint, "data-folder-accept-note": "1" },
                acceptNote || "кнопка не нужна: папка не прочиталась или наша сторона в ней не опознана")),
            h("div", { style: S.hint },
              declared
                ? "«Сохранить изменения» правит запись папки и не трогает контракт."
                : "Черновик: папки «" + folderEditor.id + "» в структуре ещё нет. «Сохранить изменения» создаст запись в folders и контракт Rev 1 в ящике."),
            /*
             * Объяснение у кнопки: человек читает, что произойдёт и когда письмо
             * не дойдёт. Без второй половины «Уведомить участников» — обещание
             * без адресата: метка, не совпавшая с воркспейсом, писем не получит.
             */
            h("div", { style: S.hint, "data-folder-contract-hint": "1" },
              "«Уведомить участников» поднимает Rev контракта (Rev+1) и рассылает письма-приглашения всем участникам, кроме инициатора. Письмо дойдёт только той метке, которая совпадает с воркспейсом из реестра: если воркспейс исчез из реестра, сервер ответит 409 — контракт не переписан, письма не записаны, адресата нет."),
            folderEditorError
              ? h("div", { style: S.error },
                h("div", { style: S.errorTitle }, folderEditorError.what),
                h("div", { style: S.fix }, "Почему: " + folderEditorError.why),
                h("div", { style: S.fix }, "Что сделать: " + folderEditorError.fix))
              : null,
            ),
            h("div", { style: S.modalFooter },
              h("button", {
                type: "button",
                style: S.buttonPrimary,
                "data-folder-save": "1",
                title: unresolved.length > 0
                  ? "сохранить нельзя: метка вне реестра — не найден; выберите похожую метку из реестра"
                  : "записать папку в structure/graph.json",
                disabled: folderEditorBusy || unresolved.length > 0,
                onClick: submitFolderEditor,
              }, folderEditorBusy ? "Сохраняю…" : "Сохранить изменения"),
              h("button", {
                type: "button",
                style: S.button,
                "data-folder-contract": "1",
                title: declared
                  ? "уведомить участников: Rev+1 в ящике и письма-приглашения участникам; письмо дойдёт только метке, совпадающей с воркспейсом, иначе адресата нет"
                  : "сначала создайте папку: у черновика контракта ещё нет",
                disabled: folderEditorBusy || !declared || unresolved.length > 0,
                onClick: refreshFolderContract,
              }, "Уведомить участников"),
              h("button", {
                type: "button",
                style: { ...S.button, color: T.danger },
                "data-folder-remove": "1",
                title: declared
                  ? "удалить запись папки: панель спросит подтверждение, ящик и письма останутся"
                  : "черновик ещё не объявлен — удалять нечего",
                disabled: folderEditorBusy || !declared,
                onClick: requestRemoveFolder,
              }, "Удалить папку"),
              /*
               * Список фактов из редактора: клик по порталу теперь открывает
               * редактор, поэтому факты остаются доступны этой кнопкой.
               */
              h("button", {
                type: "button",
                style: S.button,
                "data-folder-facts": "1",
                onClick: () => openExchangeFromPortal(null),
              }, "Список фактов"))
            ));
        }

        /*
         * Подтверждение удаления папки — своё окно панели поверх редактора.
         * Первый клик «Удалить папку» ничего не пишет: он открывает это окно.
         * Второй клик по кнопке здесь — и есть запись. window.confirm не
         * используется: браузер умеет молча отвечать «нет» (галочка
         * «предотвращать дополнительные диалоги»), и кнопка выглядит сломанной.
         */
        function renderFolderDeleteConfirm() {
          if (!folderDeleteAsk || !folderEditor) return null;
          const id = folderEditor.id;
          return h("div", {
            "data-folder-delete-ask": "1",
            style: { ...S.modalBackdrop, zIndex: 70 },
            onClick: cancelRemoveFolder,
            onContextMenu: (event) => { event.preventDefault(); cancelRemoveFolder(); },
          },
            h("div", {
              role: "dialog",
              "aria-modal": "true",
              "aria-label": "подтверждение удаления папки " + id,
              style: { ...S.modal, width: "min(460px, calc(100vw - 32px))" },
              onClick: (event) => event.stopPropagation(),
            },
              h("div", { style: S.modalHeader },
                h("span", { style: S.modalTitle }, "Удалить папку «" + id + "»?"),
                h("button", {
                  type: "button",
                  style: S.modalClose,
                  "data-delete-cancel": "1",
                  title: "оставить папку: ничего не записывается",
                  "aria-label": "Оставить папку",
                  onClick: cancelRemoveFolder,
                }, "×")),
              h("div", { style: S.modalBody },
                h("div", null, "Запись папки уйдёт из structure/graph.json. Ящик обмена, контракт и письма останутся на диске."),
                h("div", { style: S.hint }, "Узлы структуры не меняются: удаляется только портал обмена.")),
              h("div", { style: S.modalFooter },
                h("button", {
                  type: "button",
                  style: { ...S.button, color: T.danger, borderColor: T.danger },
                  "data-delete-confirm": "1",
                  disabled: folderEditorBusy,
                  title: "удалить запись папки из structure/graph.json",
                  onClick: removeFolder,
                }, folderEditorBusy ? "Удаляю…" : "Удалить папку"),
                h("button", {
                  type: "button",
                  style: S.button,
                  "data-delete-cancel": "1",
                  onClick: cancelRemoveFolder,
                }, "Оставить папку"))));
        }

        /*
         * Подтверждение удаления узла — то же окно панели, что у папки.
         * Первый клик «Удалить узел» ничего не пишет: он открывает это окно
         * [data-node-delete-ask]. Второй клик по [data-node-delete-confirm]
         * и есть запись. window.confirm в этом пути не вызывается: браузер
         * умеет молча отвечать «нет», и кнопка тогда выглядит сломанной.
         */
        function renderNodeDeleteConfirm() {
          if (!nodeDeleteAsk || !nodeEditor) return null;
          const id = nodeEditor.id;
          /*
           * 0160 (макет 06): затемнение — слой ВНУТРИ тела настроек, а не
           * подложка на всё окно. Шапка, вкладки и линейка остаются читаемыми:
           * у слоя top/bottom тела (deleteConfirmInsets), у окна они снаружи.
           * Подтверждение стоит над кнопкой — в правом нижнем углу тела.
           */
          const insets = deleteConfirmInsets();
          return h("div", {
            "data-node-delete-ask": "1",
            "data-delete-confirm-scope": insets.scope,
            "data-delete-confirm-top": String(insets.top),
            "data-delete-confirm-bottom": String(insets.bottom),
            "aria-label": "затемнены только поля настроек: шапка и линейка не перекрыты",
            style: {
              position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 70,
              display: "flex", alignItems: "flex-end", justifyContent: "flex-end",
              padding: "16px 14px", boxSizing: "border-box",
              background: "rgba(20,22,26,0.38)",
            },
            onClick: cancelRemoveNode,
            onContextMenu: (event) => { event.preventDefault(); cancelRemoveNode(); },
          },
            h("div", {
              role: "dialog",
              "aria-modal": "true",
              "aria-label": "подтверждение удаления узла " + id,
              style: { ...S.modal, width: "min(360px, 100%)", maxHeight: "100%" },
              onClick: (event) => event.stopPropagation(),
            },
              h("div", { style: S.modalHeader },
                h("span", { style: S.modalTitle }, "Удалить узел «" + id + "»?"),
                h("button", {
                  type: "button",
                  style: S.modalClose,
                  "data-node-delete-cancel": "1",
                  title: "оставить узел: ничего не записывается",
                  "aria-label": "Оставить узел",
                  onClick: cancelRemoveNode,
                }, "×")),
              h("div", { style: S.modalBody },
                h("div", null, "Узел и все связи, где он участвует, уйдут из structure/*.json."),
                h("div", { style: S.hint },
                  "Папки обмена, контракты и письма не меняются. Отмена оставляет узел и редактор открытым.")),
              h("div", { style: S.modalFooter },
                h("button", {
                  type: "button",
                  style: { ...S.button, color: T.danger, borderColor: T.danger },
                  "data-node-delete-confirm": "1",
                  disabled: nodeEditorBusy,
                  title: "удалить узел и все связи, где он участвует, из structure/*.json",
                  onClick: removeNodeFromEditor,
                }, nodeEditorBusy ? "Удаляю…" : "Удалить узел"),
                h("button", {
                  type: "button",
                  style: S.button,
                  "data-node-delete-cancel": "1",
                  onClick: cancelRemoveNode,
                }, "Оставить узел"))));
        }

        function renderLayoutError() {
          if (!layoutError) return null;
          return h("div", { style: S.error },
            h("div", null, layoutError.message),
            h("div", { style: S.fix }, "Что сделать: " + layoutError.fix));
        }

        /*
         * Уведомление приходит и строкой, и объектом {text} — панель показывает
         * текст. Раньше объект попадал в children напрямую: React падал на
         * "Objects are not valid as a React child", и после удачной записи
         * (удаление папки, сохранение, контракт) экран пропадал — кнопка
         * выглядела нерабочей, хотя файл уже был записан.
         */
        function noticeText(value) {
          if (value === null || value === undefined) return "";
          if (typeof value === "string") return value;
          if (typeof value === "object" && typeof value.text === "string") return value.text;
          return String(value);
        }

        function renderLayoutNotice() {
          if (!layoutNotice) return null;
          return h("div", { style: S.info, role: "status" }, noticeText(layoutNotice));
        }

        /*
         * «Вне структуры» — только то, что правда снаружи: живой агент, чья метка
         * не назвала ни одного узла, и работающая сессия без узла. Сессии, уже
         * привязанные к узлам (binding, метка агента или childId запуска), сюда не
         * попадают: их считает маршрут. Непривязанная сессия показывается по одной —
         * с меткой (или коротким id) и выбором объявленного узла; выбор уходит тем
         * же POST /api/session, и живая лента обновляется сразу.
         */
        function bindUnattributedSession(sessionId, nodeId) {
          if (!sessionId || !nodeId) return;
          bindSession(nodeId, sessionId);
          setUnattributedPick({ ...(unattributedPick || {}), [sessionId]: "" });
        }

        function renderUnattributedRow(row) {
          const id = row && typeof row.id === "string" ? row.id : "";
          if (!id) return null;
          const nodes = (payload && payload.graph && Array.isArray(payload.graph.nodes)) ? payload.graph.nodes : [];
          const label = row && typeof row.label === "string" && row.label.trim()
            ? row.label.trim()
            : id.slice(0, 8);
          const pick = (unattributedPick || {})[id] || "";
          return h("div", {
            key: "unattributed-" + id,
            "data-unattributed": id,
            style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
          },
            h("span", {
              style: S.value,
              title: "работающая сессия без узла: " + id,
            }, label),
            h("select", {
              style: S.select,
              "data-unattributed-node": id,
              "aria-label": "узел для сессии " + id,
              value: pick,
              onChange: (event) => setUnattributedPick({
                ...(unattributedPick || {}),
                [id]: event.target.value,
              }),
            },
              h("option", { value: "" }, "выберите узел"),
              nodes.map((node) => node && typeof node.id === "string" && node.id
                ? h("option", { key: "unattributed-node-" + node.id, value: node.id },
                  node.id + (typeof node.role === "string" && node.role ? " — " + node.role : ""))
                : null)),
            h("button", {
              type: "button",
              style: S.button,
              "data-unattributed-bind": id,
              disabled: !pick,
              title: pick
                ? "привязать сессию к узлу " + pick
                : "сначала выберите объявленный узел: панель узлы не создаёт",
              onClick: () => bindUnattributedSession(id, pick),
            }, "привязать к узлу"));
        }

        function renderLiveUnknown() {
          if (!payload || !payload.exists || liveUnknown <= 0) return null;
          const rows = Array.isArray(liveUnattributed) ? liveUnattributed : [];
          const agents = Math.max(0, liveUnknown - rows.length);
          return h("div", {
            style: S.info,
            role: "status",
            "data-live-outside": "1",
            title: "вне структуры — работающие сессии без узла и агенты, чья метка не назвала ни одного объявленного узла; "
              + "привязка идёт существующим маршрутом, узел и роль панель не выдумывает",
          },
            h("div", null, "вне структуры: " + liveUnknown
              + (agents > 0 ? " — агентов без роли: " + agents : "")
              + (rows.length > 0 ? (agents > 0 ? ", " : " — ") + "непривязанных сессий: " + rows.length : "")),
            rows.length > 0
              ? h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 6 } },
                rows.map((row) => renderUnattributedRow(row)))
              : null);
        }

        /*
         * Клик, Enter или Space по порталу открывают уже существующую карточку
         * «Внешняя связь» под схемой: список фактов живёт там и не дублируется
         * внутри портала. Фокус уходит в карточку, чтобы человека не искать её.
         */
        function openExchangeFromPortal(portal) {
          const folder = portal && portal.folder ? portal.folder : null;
          const links = folder ? [] : (exchange && Array.isArray(exchange.links) ? exchange.links : []);
          const target = links.find((link) => link && link.counterpart) || null;
          if (target) setExchangeOpen(target.counterpart);
          setLive(folder
            ? "портал папки «" + (folder.id || "обмена") + "» открыт: факты обмена — в карточке под схемой"
            : (target
              ? "список фактов обмена открыт под схемой: " + target.counterpart
              : "фактов обмена нет: под схемой причина и рецепт"));
          const card = exchangeCardRef.current;
          if (card && typeof card.focus === "function") {
            card.focus();
            if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "nearest" });
          }
        }

        function handlePortalKey(event, portal) {
          if (!event) return;
          if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
            event.preventDefault();
            openPortal(portal);
          }
        }

        /* Подписи портала: адресат, тип связи словом, счётчики и обе крайние даты. */
        function portalAria(rows) {
          if (rows.total === 0) {
            const empty = portalEmptyLines(exchange);
            return "Выход вне воркспейса. Фактов обмена нет: " + empty.reason.join(" ") + " " + empty.fix.join(" ")
              + " Enter открывает объяснение и рецепт под схемой.";
          }
          const named = rows.rows.map((link) => link.counterpart + ", " + linkKindWord(link.kind, link)
            + (link.box ? ", ящик: " + link.box : "")
            + (link.error ? ", ошибка: " + link.error : "")
            + ": ↗ " + portalCount(link.outgoing, "исходящее", "исходящих")
            + ", ↙ " + portalCount(link.incoming, "входящее", "входящих")
            + ", последнее входящее " + (factTime(link.lastIncoming) || "нет")
            + ", последнее исходящее " + (factTime(link.lastOutgoing) || "нет"));
          return "Выход вне воркспейса. " + named.join("; ")
            + (rows.more > 0 ? ". Ещё адресатов: " + rows.more : "")
            + ". Enter открывает список фактов под схемой.";
        }

        /* Имя корня в состоянии панели: сервер называет его payload.root. */
        function uiRootName() {
          return (payload && payload.root) || root || "";
        }

        /* Запись одного поля: остальные корни и libraryOpen не теряются. */
        function savePanelUi(patch) {
          const merge = patch && typeof patch === "object" ? { ...patch } : {};
          if (!Number.isFinite(Number(merge.outside))) merge.outside = outsideRef.current;
          uiStore.save(uiRootName(), merge);
        }

        /* Просвет словами: и aria-valuetext, и aria-live после шага. */
        function outsideText(value, columns) {
          const count = Math.max(1, Number(columns) || 1);
          return value + " пикселей между схемой и зоной «вне»; зона " + outsideZoneWidth(count)
            + " пикселей, " + count + (count === 1 ? " колонка" : " колонки") + " порталов";
        }

        /*
         * Новый просвет: зажим по сетке (step = 1 у Shift), слово в aria-live и
         * запись в хранилище. Один путь для стрелок, Home/End и двойного щелчка.
         */
        function applyOutside(value, message, step) {
          const next = clampOutside(value, step);
          if (message) setLive(message);
          if (next === outsideRef.current) return next;
          outsideRef.current = next;
          setOutside(next);
          savePanelUi({ outside: next });
          return next;
        }

        function detachOutsideDrag() {
          if (typeof window === "undefined" || typeof window.removeEventListener !== "function") return;
          window.removeEventListener("pointermove", onOutsidePointerMove);
          window.removeEventListener("pointerup", endOutsideDrag);
          window.removeEventListener("pointercancel", endOutsideDrag);
          window.removeEventListener("keydown", onOutsideDragKey);
        }

        /* Esc во время переноса — отмена: просвет возвращается, ничего не сохранено. */
        function onOutsideDragKey(event) {
          if (!event || event.key !== "Escape" || !outsideDragRef.current) return;
          event.preventDefault();
          const drag = outsideDragRef.current;
          outsideDragRef.current = null;
          detachOutsideDrag();
          if (drag.frame && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
            window.cancelAnimationFrame(drag.frame);
          }
          setBarrierColumns(null);
          outsideRef.current = drag.startOutside;
          setOutside(drag.startOutside);
          setLive("перенос границы отменён: просвет " + drag.startOutside + " px");
        }

        /*
         * Пересчёт в requestAnimationFrame: порталы и линии считаются от borderX
         * и идут за линией в том же кадре. setPointerCapture уже держит события,
         * поэтому pointermove слушается на window — перенос не обрывается, если
         * курсор ушёл с риски.
         */
        function onOutsidePointerMove(event) {
          const drag = outsideDragRef.current;
          if (!drag) return;
          const dx = event.clientX - drag.startClientX;
          drag.next = clampOutside(drag.startOutside + dx, event.shiftKey ? 1 : OUTSIDE_STEP);
          if (drag.frame) return;
          const apply = () => {
            const current = outsideDragRef.current;
            if (!current) return;
            current.frame = 0;
            if (current.next === outsideRef.current) return;
            outsideRef.current = current.next;
            setOutside(current.next);
            /* Запись — паузой 200 ms: в кадре она не нужна (макет §4.5). */
            if (outsideSaveRef.current) clearTimeout(outsideSaveRef.current);
            outsideSaveRef.current = setTimeout(() => savePanelUi({ outside: current.next }), 200);
          };
          if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
            drag.frame = window.requestAnimationFrame(apply);
          } else {
            apply();
          }
        }

        function beginOutsideDrag(event) {
          if (!event) return;
          if (event.button !== undefined && event.button !== 0) return;
          if (typeof event.preventDefault === "function") event.preventDefault();
          const start = outsideRef.current;
          outsideDragRef.current = { startClientX: event.clientX, startOutside: start, next: start, frame: 0 };
          /* Число колонок замирает на время переноса: портал не прыгает под курсором. */
          setBarrierColumns(columnsRef.current);
          const target = event.currentTarget;
          /*
           * preventDefault не даёт браузеру выделять текст, но и не отдаёт
           * фокус: без него клавиатура барьера заработала бы только после Tab.
           */
          if (target && typeof target.focus === "function") target.focus();
          if (target && typeof target.setPointerCapture === "function" && event.pointerId !== undefined) {
            try { target.setPointerCapture(event.pointerId); } catch (error) { /* старые движки: перенос идёт по window */ }
          }
          if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
          window.addEventListener("pointermove", onOutsidePointerMove);
          window.addEventListener("pointerup", endOutsideDrag);
          window.addEventListener("pointercancel", endOutsideDrag);
          window.addEventListener("keydown", onOutsideDragKey);
        }

        function endOutsideDrag() {
          detachOutsideDrag();
          const drag = outsideDragRef.current;
          outsideDragRef.current = null;
          if (!drag) return;
          if (drag.frame && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
            window.cancelAnimationFrame(drag.frame);
          }
          if (drag.next !== outsideRef.current) {
            outsideRef.current = drag.next;
            setOutside(drag.next);
          }
          if (outsideSaveRef.current) clearTimeout(outsideSaveRef.current);
          savePanelUi({ outside: drag.next });
          /* Разморозка колонок и их пересчёт — только здесь и на resize. */
          setBarrierColumns(null);
          setLive("граница воркспейса: " + drag.next + " px до зоны «вне»");
        }

        /* Клавиатура разделителя: стрелки ±8, Shift ±1, Home — 20, End — 360. */
        function handleOutsideKey(event) {
          if (!event) return;
          const key = event.key;
          if (key === "Home") {
            event.preventDefault();
            applyOutside(OUTSIDE_MIN, "граница воркспейса: 20 px, как при первом входе");
            return;
          }
          if (key === "End") {
            event.preventDefault();
            applyOutside(OUTSIDE_MAX, "граница воркспейса: 360 px, предел");
            return;
          }
          if (key === "Escape") { onOutsideDragKey(event); return; }
          const direction = key === "ArrowLeft" || key === "ArrowDown" ? -1
            : key === "ArrowRight" || key === "ArrowUp" ? 1 : 0;
          if (!direction) return;
          event.preventDefault();
          const step = event.shiftKey ? 1 : OUTSIDE_STEP;
          const next = clampOutside(outsideRef.current + direction * step, step);
          applyOutside(next, "граница воркспейса: " + next + " px до зоны «вне»", step);
        }

        function resetOutsideByDoubleClick(event) {
          if (event && typeof event.preventDefault === "function") event.preventDefault();
          applyOutside(OUTSIDE_MIN, "граница воркспейса: 20 px, как при первом входе");
        }

        /*
         * Пунктирная граница воркспейса: всё, что правее, — «вне». Линия идёт по
         * крайней карточке, поэтому узел никогда не оказывается за своей же
         * границей, а портал стоит 48 px за ней и не перекрывает карточки.
         */
        function renderWorkspaceBorder(borderX, height) {
          return h("g", { key: "workspace-border", "data-workspace-border": "line" },
            h("line", {
              x1: borderX, y1: -8, x2: borderX, y2: height + 8,
              stroke: outsideFocus ? T.link : T.border2,
              strokeWidth: outsideFocus ? 2 : 1,
              strokeDasharray: outsideFocus ? null : "4 4",
            }),
            h("text", { x: borderX - 7, y: -3, fontSize: 9, fill: T.caption, textAnchor: "end" }, "воркспейс"),
            h("text", { x: borderX + 7, y: -3, fontSize: 9, fill: T.caption }, "вне"));
        }

        /*
         * Сам барьер как орган управления: role="separator" (по ARIA — window
         * splitter), Tab доводит до него, стрелки двигают просвет, значение
         * озвучивается словами по-русски. Зона захвата 12 px не перекрывает ни
         * карточки (они левее borderX − outside), ни порталы (они правее +48).
         */
        function renderWorkspaceSeparator(borderX, height, columns) {
          return h("g", {
            key: "workspace-separator",
            "data-workspace-separator": "1",
            role: "separator",
            tabIndex: 0,
            "aria-orientation": "vertical",
            "aria-label": "Граница воркспейса и зоны «вне»",
            "aria-valuemin": String(OUTSIDE_MIN),
            "aria-valuemax": String(OUTSIDE_MAX),
            "aria-valuenow": String(outside),
            "aria-valuetext": outsideText(outside, columns),
            "aria-controls": "pg-workspace-pane pg-outside-pane",
            style: { cursor: "col-resize", touchAction: "none", outline: "none" },
            onPointerDown: beginOutsideDrag,
            onKeyDown: handleOutsideKey,
            onDoubleClick: resetOutsideByDoubleClick,
            onFocus: () => setOutsideFocus(true),
            onBlur: () => setOutsideFocus(false),
          },
            h("title", { key: "sep-title" },
              "Граница воркспейса: " + outside + " px до зоны «вне». "
              + "Стрелки — 8 px, Shift — 1 px, Home — сброс на 20 px, двойной щелчок — тоже сброс."),
            h("rect", {
              key: "sep-hit",
              "data-outside-hit": "1",
              x: borderX - 6, y: -14, width: 12, height: height + 28,
              fill: "transparent", pointerEvents: "all", style: { touchAction: "none" },
            }),
            h("rect", {
              key: "sep-grip",
              x: borderX - 3, y: 6, width: 6, height: 36, rx: 3,
              fill: T.bg2, stroke: outsideFocus ? T.link : T.border2, strokeWidth: 1,
            }),
            h("circle", { key: "sep-dot-1", cx: borderX, cy: 18, r: 1, fill: T.caption }),
            h("circle", { key: "sep-dot-2", cx: borderX, cy: 24, r: 1, fill: T.caption }),
            h("circle", { key: "sep-dot-3", cx: borderX, cy: 30, r: 1, fill: T.caption }));
        }

        /*
         * Линия во вторую колонку: вход в верхнюю грань через полосу y = −8.
         * Прямоугольный маршрут из трёх поворотов, без кривых: та же линия, что
         * у колонки 1, только вход сверху.
         */
        function portalColumnLineD(start, borderX, portalX, portalY) {
          const source = start && typeof start === "object" ? start : {};
          const box = source.box && typeof source.box === "object" ? source.box : source;
          const hasBox = Number.isFinite(box.x) && Number.isFinite(box.y)
            && Number.isFinite(box.w) && Number.isFinite(box.h);
          const x1 = hasBox ? box.x + box.w : (Number(source.x) || 0);
          const y1 = hasBox ? box.y + box.h / 2 : (Number(source.y) || 0);
          const laneX = (Number(borderX) || 0) - 8;
          const entryX = (Number(portalX) || 0) + 26;
          const entryY = (Number(portalY) || 0) + 1;
          return "M " + x1 + " " + y1
            + " L " + laneX + " " + y1
            + " L " + laneX + " -8"
            + " L " + entryX + " -8"
            + " L " + entryX + " " + entryY;
        }

        /*
         * Линия от узла self к порталу: наконечник на стороне, куда шёл последний
         * по времени факт, рядом — его время. Направление — факт, а не догадка:
         * без фактов линия остаётся без наконечника.
         */
        function renderPortalConnector(portal) {
          /*
           * У портала папки адресат один — её участники; «последнее» берётся из
           * крайних дат папки. Прежний портал по-прежнему читает links всего обмена.
           */
          const links = portal.folder
            ? [{
              counterpart: (portal.sides && portal.sides.join(", ")) || portal.folder.id || "папка обмена",
              kind: "folder",
              state: portal.folder.state,
              outgoing: portal.counters ? portal.counters.outgoing : 0,
              incoming: portal.counters ? portal.counters.incoming : 0,
              lastIncoming: portal.folder.lastIncoming,
              lastOutgoing: portal.folder.lastOutgoing,
            }]
            : (exchange && Array.isArray(exchange.links) ? exchange.links : []);
          const latest = portalLatest(links);
          const start = portalStart(portal.self, portal.borderX, portal.height);
          /* Высота входа — середина портала в ленте, без выхода за его край. */
          const entryY = (portal.y || 0) + Math.max(20, Math.min(portal.height / 2, portal.height - 20));
          /* Без узла self линия начинается у границы воркспейса на высоте портала. */
          if (!start.box) start.y = entryY;
          /*
           * Вторая колонка: линия входит в верхнюю грань портала. Она идёт по
           * свободной полосе между рядами карточек, поднимается в зазоре
           * borderX … portalX, идёт по полосе y = −8 над всеми порталами и
           * опускается в верхний край своего портала — так она не пересекает
           * первую колонку (макет §4.4).
           */
          const d = portal.column > 0
            ? portalColumnLineD(start, portal.borderX, portal.x, portal.y)
            : __portalLineD(start, portal.x, entryY);
          const labelX = start.x + (start.box ? 12 : 10);
          const labelY = start.box ? start.y + 14 : start.y - 8;
          const label = latest
            ? "последнее: " + (latest.direction === "incoming" ? "← входящее " : "исходящее → ") + factTime(latest.at)
            : "фактов нет — направление не подтверждено";
          return h("g", {
            key: portal.folder ? "portal-connector-" + (portal.folder.id || "folder") : "portal-connector",
          },
            h("path", {
              key: "portal-line",
              "data-portal-line": latest ? latest.direction : "none",
              "data-portal-from": start.from || "border",
              d,
              fill: "none",
              stroke: T.secondary,
              strokeWidth: 1.5,
              strokeDasharray: "2 4",
              markerStart: latest && latest.direction === "incoming" ? "url(#pg-arrow-report)" : null,
              markerEnd: latest && latest.direction === "outgoing" ? "url(#pg-arrow-report)" : null,
            }),
            /*
             * Подпись «последнее» — только у прежнего единственного портала.
             * У ленты подписи легли бы друг на друга; направление показывает
             * наконечник, а обе крайние даты стоят в самой карточке папки.
             */
            portal.folder ? null : h("text", {
              key: "portal-line-label",
              "data-portal-line-label": "1",
              x: labelX, y: labelY, fontSize: 9.5, fill: T.secondary,
              /* Обводка фоном: подпись читается и там, где под ней идёт связь. */
              stroke: "var(--dsw-alias-bg-base, #ffffff)",
              strokeWidth: 3, strokeLinejoin: "round", paintOrder: "stroke",
            }, label));
        }

        /*
         * Портал — кнопка, а не картинка: Tab доводит до него, Enter и Space
         * открывают список под схемой, Esc закрывает его обратно. Кольцо фокуса
         * видимое, тип связи назван словом, счётчики стоят в обе стороны.
         */
        function renderPortal(portal) {
          const x = portal.x;
          const width = PORTAL_W;
          const height = portal.height;
          const folder = portal.folder || null;
          /*
           * У папки одна строка — внешняя сторона канала. Поля те же, что у связи
           * обмена, поэтому счётчики, даты и подписи рисуются тем же кодом.
           */
          const rows = folder
            ? {
              total: 1,
              more: 0,
              rows: [{
                counterpart: portalName((portal.sides && portal.sides.join(", ")) || "внешней стороны нет"),
                kind: "folder",
                state: folder.state,
                box: typeof folder.box === "string" ? folder.box : "",
                error: folder.error || "",
                outgoing: portal.counters ? portal.counters.outgoing : 0,
                incoming: portal.counters ? portal.counters.incoming : 0,
                lastIncoming: folder.lastIncoming,
                lastOutgoing: folder.lastOutgoing,
              }],
            }
            : portal.rows;
          const empty = portal.empty;
          const hot = portalHot || portalFocus;
          const parts = [];
          const name = (suffix) => "portal-" + suffix;
          const tip = (folder
            ? "папка " + (folder.id || "обмена")
              + ((portal.sides && portal.sides.length) ? " · участники: " + portal.sides.join(", ") : "")
              + " · состояние: " + folderStateWord(folder.state)
              + (folder.error ? " · ошибка: " + folder.error : "")
            : (rows.total === 0
              ? empty.reason.join(" ") + "\n" + empty.fix.join(" ")
              : rows.rows.map((link) => link.counterpart + " · " + linkKindWord(link.kind, link)).join("\n")))
            + "\n\n" + "Только факты: направление, время, ветка, статус. Тексты сообщений не читаются."
            + "\n" + "Клик или Enter — список фактов под схемой, Esc — закрыть.";
          parts.push(h("title", { key: name("tip") }, tip));
          parts.push(h("rect", {
            key: name("ring"),
            x: x - 4, y: -4, width: width + 8, height: height + 8, rx: 15,
            fill: "none", stroke: T.link, strokeWidth: 2, opacity: hot ? 1 : 0,
          }));
          parts.push(h("rect", {
            key: name("frame"),
            x, y: 0, width, height, rx: 12,
            fill: T.bg2,
            stroke: hot ? T.link : T.border2,
            strokeWidth: hot ? 2 : 1.2,
            strokeDasharray: "5 4",
          }));
          /* Вторая рамка, как в макете: карточка «оттуда», а не наш узел. */
          parts.push(h("rect", {
            key: name("frame-inner"),
            x: x + 5, y: 5, width: width - 10, height: height - 10, rx: 9,
            fill: "none", stroke: T.border1, strokeWidth: 1, strokeDasharray: "2 3",
          }));
          /* Состояние папки стоит в шапке: строка адресата остаётся именем стороны. */
          const subtitle = folder
            ? (folder.id || "папка обмена") + " · " + folderStateWord(folder.state)
            : (rows.total === 1 ? rows.rows[0].counterpart : "вне воркспейса");
          /* Подпись шапки не заезжает под шестерёнку папки: длинное — с многоточием. */
          const subtitleText = subtitle.length > 24 ? subtitle.slice(0, 23) + "…" : subtitle;
          parts.push(h("text", { key: name("head"), x: x + 12, y: 18, fontSize: 12, fontWeight: 600, fill: T.text },
            "Выход вне",
            h("tspan", { dx: 6, fontSize: 9, fontWeight: 400, fill: T.caption }, "· " + subtitleText)));
          /*
           * 0143: у папки в шапке — шестерёнка, под шапкой — бейдж участников
           * («structure + workflow»). Обе кнопки видны всегда и открывают окно
           * папки; клик по телу портала по-прежнему ведёт в редактор.
           */
          if (folder) {
            const gear = folderGear();
            if (gear.visible === "always") {
              parts.push(h("g", {
                key: name("gear"),
                "data-folder-gear": folder.id || "folder",
                role: "button",
                tabIndex: 0,
                "aria-label": "Окно папки " + (folder.id || "обмена"),
                style: { cursor: "pointer" },
                onClick: (event) => {
                  if (event && event.stopPropagation) event.stopPropagation();
                  openFolderWindow(folder.id);
                },
                onKeyDown: (event) => {
                  if (!event) return;
                  if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
                  if (event.preventDefault) event.preventDefault();
                  if (event.stopPropagation) event.stopPropagation();
                  openFolderWindow(folder.id);
                },
              },
                h("title", null, "Открыть окно папки: «Сведения», «Состояние», «Настройки»"),
                h("text", {
                  x: x + width - 16, y: 18, fontSize: 13, fill: T.tertiary, textAnchor: "middle",
                  style: { userSelect: "none" },
                }, "⚙")));
            }
            const badge = folderParticipantsBadge(folder, exchange);
            /*
             * Бейдж — кнопка, а не подпись: окно папки открывается и им, и
             * шестерёнкой. Ширина по тексту, но не шире карточки.
             */
            const badgeLimit = Math.max(8, Math.floor((width - 48) / 5.2));
            const badgeText = badge.length > badgeLimit ? badge.slice(0, badgeLimit - 1) + "…" : badge;
            const badgeWidth = Math.min(width - 24, 16 + badgeText.length * 5.2);
            parts.push(h("g", {
              key: name("participants"),
              "data-folder-participants": folder.id || "folder",
              role: "button",
              tabIndex: 0,
              "aria-label": "Участники папки " + (folder.id || "обмена") + ": " + badge + " — открыть окно папки",
              style: { cursor: "pointer" },
              onClick: (event) => {
                if (event && event.stopPropagation) event.stopPropagation();
                openFolderWindow(folder.id);
              },
              onKeyDown: (event) => {
                if (!event) return;
                if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
                if (event.preventDefault) event.preventDefault();
                if (event.stopPropagation) event.stopPropagation();
                openFolderWindow(folder.id);
              },
            },
              h("title", null, "Участники папки: " + badge + ". Клик — окно папки: ящик, участники, контракт"),
              h("rect", {
                x: x + 12, y: 27, width: badgeWidth, height: 14, rx: 7,
                fill: T.bg1, stroke: T.border2, strokeWidth: 1,
              }),
              h("text", { x: x + 18, y: 37, fontSize: 9, fill: T.secondary }, badgeText)));
          }
          parts.push(h("line", {
            key: name("head-rule"),
            x1: x + 12, y1: 24, x2: x + width - 12, y2: 24,
            stroke: T.border1, strokeWidth: 1,
          }));
          if (rows.total === 0) {
            parts.push(h("text", { key: name("empty-title"), x: x + 12, y: 44, fontSize: 11.5, fontWeight: 600, fill: T.text }, empty.title));
            let y = 60;
            empty.reason.forEach((line, index) => {
              parts.push(h("text", { key: name("reason-" + index), x: x + 12, y, fontSize: 9.5, fill: T.caption }, line));
              y += 12;
            });
            y += 2;
            empty.fix.forEach((line, index) => {
              parts.push(h("text", { key: name("fix-" + index), x: x + 12, y, fontSize: 9.5, fill: T.secondary }, line));
              y += 12;
            });
          } else {
            /* Строка адресата у папки ниже бейджа участников (0143). */
            const rowTop = folder ? 42 : 24;
            rows.rows.forEach((link, index) => {
              const top = rowTop + index * PORTAL_ROW_H;
              parts.push(h("text", { key: name("row-" + index), x: x + 12, y: top + 18, fontSize: 11.5, fill: T.text },
                h("tspan", { style: { fontFamily: T.mono }, fontWeight: 600 }, link.counterpart),
                h("tspan", { dx: 5, fill: T.secondary, fontSize: 9.5 },
                  link.kind === "folder" ? "" : " · " + linkKindWord(link.kind, link))));
              parts.push(h("text", { key: name("count-" + index), x: x + 12, y: top + 33, fontSize: 9.5, fill: T.secondary },
                "↗ " + portalCount(link.outgoing, "исходящее", "исходящих")
                + " · ↙ " + portalCount(link.incoming, "входящее", "входящих")));
              parts.push(h("text", { key: name("dates-" + index), x: x + 12, y: top + 47, fontSize: 9, fill: T.caption },
                "вх. " + (factTime(link.lastIncoming) || "—") + " · исх. " + (factTime(link.lastOutgoing) || "—")));
              if (index < rows.rows.length - 1) {
                parts.push(h("line", {
                  key: name("rule-" + index),
                  x1: x + 12, y1: top + 54, x2: x + width - 12, y2: top + 54,
                  stroke: T.border1, strokeWidth: 1, strokeDasharray: "2 3",
                }));
              }
            });
            const foot = rowTop + rows.rows.length * PORTAL_ROW_H;
            parts.push(h("line", {
              key: name("foot-rule"),
              x1: x + 12, y1: foot, x2: x + width - 12, y2: foot,
              stroke: T.border1, strokeWidth: 1,
            }));
            let y = foot + 13;
            if (folder) {
              /* Подвал папки: путь ящика и ошибка, если папка не прочиталась. */
              folderPortalLines(folder, exchange).forEach((line, index) => {
                parts.push(h("text", {
                  key: name("folder-" + index),
                  x: x + 12, y, fontSize: 9, fill: line.fill,
                }, line.text));
                y += 12;
              });
            } else {
              if (rows.more > 0) {
                parts.push(h("text", { key: name("more"), x: x + 12, y, fontSize: 9, fill: T.warn },
                  "ещё " + rows.more + " — в списке под схемой"));
                y += 14;
              }
              parts.push(h("text", { key: name("source"), x: x + 12, y, fontSize: 9, fill: T.caption },
                "источник: coordination · по соглашению"));
              parts.push(h("text", {
                key: name("unparsed"),
                x: x + 12, y: y + 12, fontSize: 9,
                fill: exchange && exchange.unparsed ? T.warn : T.caption,
              }, "не разобрано: " + ((exchange && exchange.unparsed) || 0)));
            }
          }
          /* Подпись под рамкой: портал сам говорит, что он открывает. */
          parts.push(h("text", {
            key: name("hint"),
            x: x + 2, y: height + 15, fontSize: 9.5, fill: T.secondary, opacity: hot ? 1 : 0.85,
          }, folder
            ? "клик или Enter — редактор папки: ящик, участники, контракт; ⚙ или бейдж участников — окно папки"
            : "клик или Enter — список фактов под схемой"));
          return h("g", {
            key: folder ? "portal-" + (folder.id || "folder") : "portal",
            transform: portal.y ? "translate(0," + portal.y + ")" : null,
            "data-portal": "exit",
            "data-portal-folder": folder ? (folder.id || "folder") : null,
            "data-portal-state": folder ? (folder.state || "draft") : null,
            /* Колонка портала: вторая колонка входит линией в верхнюю грань. */
            "data-portal-column": String(portal.column || 0),
            ref: portalRef,
            tabIndex: 0,
            role: "button",
            "aria-label": portalAria(rows),
            "aria-expanded": portal.open ? "true" : "false",
            "aria-controls": "pg-exchange-card",
            "aria-describedby": "pg-layout-hint",
            style: { cursor: "pointer", outline: "none" },
            onClick: () => openPortal(portal),
            /* 0143: правый клик меню не открывает — только гасит браузерное. */
            onContextMenu: (event) => { if (event && event.preventDefault) event.preventDefault(); },
            onKeyDown: (event) => handlePortalKey(event, portal),
            onFocus: () => setPortalFocus(true),
            onBlur: () => setPortalFocus(false),
            onPointerEnter: () => setPortalHot(true),
            onPointerLeave: () => setPortalHot(false),
          }, parts);
        }

        /* Пустая канва: координатор на ней уже стоит (0170). */
        const EMPTY_CANVAS = { width: 400, height: 120, padding: 16 };
        const EMPTY_COORDINATOR_BOX = { x: 16, y: 16, w: 176, h: 62 };

        /*
         * Пустая структура — не тупик (0170): координатор уже на канве.
         *
         * Палитра не даёт координатора, потому что он есть всегда; поэтому
         * первая карточка — виртуальная: узла в файле ещё нет, но человек
         * видит отправную точку и подсказку, как добавить остальные. Канва
         * по-прежнему принимает вынос: первый настоящий узел можно поставить
         * сюда.
         */
        function renderEmptyCanvas() {
          const card = coordinatorCard(payload && payload.graph);
          const box = { ...EMPTY_COORDINATOR_BOX, id: card.node.id };
          const state = nodeState({ active: false, self: false, run: null, activityKnown: false, source: null });
          const structureDir = (payload && payload.structureDir) || "structure";
          /*
           * 0184: пустая структура — состояние empty, и оно видно там, где
           * человек её и застаёт: у виртуального координатора стоит та же
           * вкладка, только нейтральная («структура пуста»), без счёта находок.
           */
          const emptyFindings = validatorFindings(payload && payload.validation);
          return h("div", { ref: canvasRef, "data-canvas": "1", style: S.canvas },
            h("div", { style: S.hint, "data-empty-structure": "1" },
              "Схема пуста: " + card.hint
                + ". Координатор — отправная точка воркспейса; остальные узлы добавьте из библиотеки "
                + "слева или в " + structureDir + "/*.json и нажмите «Обновить»."),
            h("svg", {
              ref: svgRef,
              width: EMPTY_CANVAS.width + EMPTY_CANVAS.padding * 2,
              height: EMPTY_CANVAS.height + EMPTY_CANVAS.padding * 2,
              viewBox: "-" + EMPTY_CANVAS.padding + " -" + EMPTY_CANVAS.padding + " "
                + (EMPTY_CANVAS.width + EMPTY_CANVAS.padding * 2) + " "
                + (EMPTY_CANVAS.height + EMPTY_CANVAS.padding * 2),
              style: { display: "block" },
            },
              renderDefs(),
              /* Вкладка до карточки: карточка перекрывает стык 1 px. */
              renderValidatorTab(box, {
                findings: emptyFindings,
                graph: payload && payload.graph,
                hovered: validatorHover,
                focused: validatorFocused,
                reducedMotion: prefersReducedMotion(),
                onHover: validatorHoverIntent,
                onFocusChange: setValidatorFocused,
                onOpen: () => setValidatorOpen(true),
              }),
              h("g", { "data-coordinator-card": card.virtual ? "virtual" : "fixed" },
                renderNode(box, card.node, false, state, null, () => {}, {}))),
            renderCarryOutline(320, 160));
        }

        function renderCanvas() {
          if (!payload) return null;
          const layout = payload.layout || { nodes: [], edges: [], width: 0, height: 0 };
          if (layout.nodes.length === 0) return renderEmptyCanvas();
          /*
           * Карточка с позицией рисуется по ней, остальные — на расчётных местах
           * слоёв. Канва растягивается до крайней карточки, иначе узел, который
           * утащили вправо, обрезался бы рамкой прокрутки.
           */
          const boxes = new Map();
          const moved = Object.keys(positions).length > 0;
          const canvasNodes = (layout.nodes || []).map((node) => {
            const override = positions[node.id];
            const box = override ? { ...node, x: override.x, y: override.y } : node;
            boxes.set(box.id, box);
            return box;
          });
          let width = Math.max(layout.width, 240);
          let height = Math.max(layout.height, 160);
          for (const box of boxes.values()) {
            width = Math.max(width, box.x + box.w);
            height = Math.max(height, box.y + box.h);
          }
          const padding = 16;
          /*
           * 0184: рёбра координатора начинаются за вкладкой (x + w + 13), иначе
           * первые 13 px каждой исходящей связи скрыты под полосой. Правило
           * одно для серверной раскладки и для перетащенной карточки.
           */
          const edges = moved
            ? edgeSegments(boxes, (payload.graph && payload.graph.edges) || [])
            : (layout.edges || []).map((edge) => validatorEdge(edge, boxes));
          /*
           * Барьер «воркспейс | вне» (макет §4.2): borderX = cardsRight + outside.
           * Порталы стоят за границей: +48, а вторая колонка — 236 + 16, если
           * папок обмена ≥ 2 и видимой части канвы ≥ 536 px; ниже 512 px она
           * складывается (гистерезис 24). Во время переноса число колонок
           * заморожено: иначе портал прыгал бы под курсором, а просвет — это и
           * есть единственная управляемая часть зоны «вне».
           */
          let cardsRight = 0;
          for (const box of boxes.values()) cardsRight = Math.max(cardsRight, box.x + box.w);
          width = Math.max(width, cardsRight);
          const borderX = cardsRight + outside;
          const portalX = borderX + PORTAL_GAP;
          const selfBox = (payload.selfNode && boxes.get(payload.selfNode)) || null;
          /*
           * 0162: находки валидатора рисуются выступом у координатора. Ответ
           * /api/graph кладёт их в validation; пока листенера нет (0164),
           * свежий ответ приносит «Обновить».
           */
          const validatorFindingsNow = validatorFindings(payload && payload.validation);
          /* 0184: одно состояние на вкладку и чип шапки — ok | warn | error | empty. */
          const validatorNow = validatorState({
            graph: payload && payload.graph,
            findings: validatorFindingsNow,
          });
          const coordinatorBox = [...boxes.values()].find((box) =>
            isCoordinatorNode(nodesById.get(box.id))
            || String(box.id).toLowerCase() === "coordinator") || null;
          /*
           * Выдвинутая карточка выше блока на 42 px. Канва растёт только по
           * высоте прокрутки: карточки не двигаются, но нижний край выступа не
           * обрезается, даже если координатор — нижний узел схемы.
           */
          if (coordinatorBox) {
            height = Math.max(height, coordinatorBox.y + VALIDATOR_CARD_HEIGHT + padding);
          }
          const portalNodes = [...boxes.values()];
          const folders = exchangeFolders(exchange);
          /*
           * visible — то, что осталось канве правее пунктира. Пока ширина не
           * измерена, берём 980 px: это видимая часть при окне 1280 px (макет
           * §9.5), и первый кадр не показывает лишнюю колонку на глаз.
           */
          const visible = (canvasWidth > 0 ? canvasWidth : 980) - borderX - padding;
          const columns = barrierColumns === null
            ? portalColumns(folders.length, visible, columnsRef.current)
            : barrierColumns;
          columnsRef.current = columns;
          const portals = [];
          if (folders.length > 0) {
            /*
             * Папка структуры даёт свой выход, поэтому выходов столько же,
             * сколько папок. В двух колонках они делятся половинами поровну
             * сверху вниз: col 0 — первые ceil(N/2), col 1 — остальные.
             */
            const perColumn = Math.max(1, Math.ceil(folders.length / columns));
            const tops = [];
            for (let index = 0; index < columns; index += 1) tops.push(0);
            folders.forEach((folder, index) => {
              const column = Math.min(columns - 1, Math.floor(index / perColumn));
              const portalHeight = folderPortalHeight(folder, exchange);
              portals.push({
                x: portalX + column * (PORTAL_W + PORTAL_COLUMN_GUTTER),
                borderX,
                y: tops[column],
                height: portalHeight,
                column,
                stackIndex: index,
                folder,
                sides: folderSides(folder, exchange),
                counters: folderCounters(folder),
                open: exchangeOpen !== null,
                self: selfBox,
                nodes: portalNodes,
              });
              tops[column] += portalHeight + PORTAL_STACK_GAP;
            });
          } else {
            const rows = portalRows(exchange && exchange.links);
            const empty = portalEmptyLines(exchange);
            portals.push({
              x: portalX,
              borderX,
              y: 0,
              height: portalFrameHeight(rows, empty),
              column: 0,
              rows,
              empty,
              open: exchangeOpen !== null,
              self: selfBox,
              nodes: portalNodes,
            });
          }
          width = Math.max(width, portalX + columns * PORTAL_W + (columns - 1) * PORTAL_COLUMN_GUTTER);
          const stripBottom = portals.reduce((lowest, item) => Math.max(lowest, item.y + item.height), 0);
          height = Math.max(height, stripBottom + 22);
          const interaction = {
            dragging,
            focused: focusedNode,
            onPointerDown: startDrag,
            /* 0143: шестерёнка карточки открывает окно узла — правого меню нет. */
            onOpenWindow: (node) => openNodeWindow(node.id),
            onKeyDown: handleNodeKey,
            onFocus: (id) => setFocusedNode(id),
            onBlur: handleNodeBlur,
          };
          /*
           * Шапка схемы как в макете: «Structure», счётчики узлов и связей, а под
           * ней — сама прокручиваемая канва.
           */
          return h(
            "div",
            { style: S.canvasPanel },
            h("div", { style: S.canvasHead },
              h("span", { style: { fontWeight: 700, fontSize: "15px" } }, "Structure"),
              h("span", { style: S.chip, title: "узлы структуры" }, boxes.size + " узлов"),
              h("span", { style: S.chip, title: "связи между узлами" }, ((payload.graph && payload.graph.edges) || []).length + " связей"),
              /* Чип барьера: он же показывает, что стало после переноса (макет §4.5). */
              h("span", {
                style: S.chip,
                "data-outside-chip": "1",
                title: "просвет между схемой и зоной «вне»: тянется мышью и стрелками",
              }, "вне: " + outsideZoneWidth(columns) + " px · " + columns + (columns === 1 ? " колонка" : " колонки")),
              /*
               * 0184: один чип на состояние, а не только красный при ошибках:
               * человек видит вердикт валидатора на канве, не открывая окно.
               */
              h("span", {
                style: {
                  ...S.chip,
                  color: validatorTone(validatorNow),
                  border: "1px solid " + validatorTone(validatorNow),
                },
                "data-validator-chip": "1",
                "data-validator-state": validatorNow,
                title: validatorNow === "error"
                  ? "новые задания не запускаются, пока в структуре есть ошибки"
                  : validatorNow === "empty"
                    ? "структура только создана: начните с координатора"
                    : "вердикт валидатора структуры",
              }, validatorChipText(validatorNow, validatorFindingsNow)),
              h("span", { style: { marginLeft: "auto", display: "inline-flex", gap: "6px" } },
                h("button", {
                  type: "button",
                  style: S.button,
                  title: "вернуть все узлы на расчётные места: x/y будут убраны из structure/*.json",
                  onClick: resetLayout,
                }, "Сбросить схему"))),
            h("div",
            { ref: canvasRef, "data-canvas": "1", style: S.canvas },
            h("svg", {
              ref: svgRef,
              width: width + padding * 2,
              height: height + padding * 2,
              viewBox: "-" + padding + " -" + padding + " " + (width + padding * 2) + " " + (height + padding * 2),
              style: { display: "block" },
            },
              renderDefs(),
              /*
               * Зона «вне» — отдельной группой: на неё ссылается aria-controls
               * разделителя. Линии к порталам идут до карточек: иначе линия
               * проходит по тексту карточки и читается как зачёркивание.
               */
              h("g", { id: "pg-outside-pane" },
                portals.map((item) => renderPortalConnector(item)),
                portals.map((item) => renderPortal(item))),
              renderWorkspaceBorder(borderX, height),
              h("g", { id: "pg-workspace-pane" },
              edges.map((edge, index) =>
                h("line", {
                  key: "edge-" + index,
                  "data-edge": edge.from + "->" + edge.to,
                  "data-kind": edge.kind,
                  x1: edge.x1, y1: edge.y1, x2: edge.x2, y2: edge.y2,
                  stroke: edgeStroke(edge.kind),
                  strokeWidth: edge.kind === "peer" ? 1 : 1.5,
                  strokeDasharray: edgeDash(edge.kind),
                  markerEnd: markerFor(edge.kind),
                  opacity: edge.kind === "peer" ? 0.8 : 1,
                })),
              /*
               * 0184: слой — 1 рёбра → 2 вкладка → 3 карточки. Вкладка идёт
               * между рёбрами и карточками: карточка перекрывает 1 px стыка,
               * поэтому шва и второй рамки не видно, а рёбра её не задевают.
               */
              coordinatorBox
                ? renderValidatorTab(coordinatorBox, {
                  findings: validatorFindingsNow,
                  graph: payload && payload.graph,
                  hovered: validatorHover,
                  focused: validatorFocused,
                  reducedMotion: prefersReducedMotion(),
                  onHover: validatorHoverIntent,
                  onFocusChange: setValidatorFocused,
                  onOpen: () => setValidatorOpen(true),
                })
                : null,
              canvasNodes.map((node) =>
                renderNode(
              node,
              nodesById.get(node.id),
              picked === node.id,
              nodeState({
                active: activeIds.has(node.id),
                self: Boolean(selfRunning && payload && payload.selfNode === node.id),
                run: runStates[node.id],
                activityKnown,
                source: liveSources[node.id],
              }),
              (payload.schedule && payload.schedule[node.id]) || null,
              pickNode,
              {
                ...interaction,
                dragging: dragging === node.id,
                focused: focusedNode === node.id,
                binding: liveBinding && liveBinding.node === node.id ? bindingView(liveBinding, Date.now()) : "",
              },
            ))),
              /* Сам разделитель — поверх всего: его зона захвата не перекрывает ни карточки, ни порталы. */
              renderWorkspaceSeparator(borderX, height, columns),
            ),
            /* Контур будущего узла живёт поверх канвы. */
            renderCarryOutline(width, height),
            ),
          );
        }

        /* Human words for the classification the customer defined. */
        function linkKindWord(kind, link) {
          /* Папка обмена — не связь: её «вид» — состояние канала, а не направление. */
          if (kind === "folder") return folderStateWord(link && link.state);
          if (kind === "two-way") return "двусторонняя";
          if (kind === "outgoing") return "исходящая односторонняя";
          return "входящая односторонняя";
        }

        function factTime(ms) {
          if (!ms) return "";
          return new Date(ms).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        }

        function reloadExchange() {
          if (!root) return;
          fetchJson("/api/exchange?root=" + encodeURIComponent(root))
            .then((body) => setExchange(body))
            .catch(() => setExchange({ failed: true }));
        }

        /*
         * Закрытие заявки без ответа (задание 0128): один POST на
         * /api/exchange/close, затем перечитываются факты. Счётчик и список
         * приходят из одного источника, поэтому панель не вычитает число сама.
         */
        function closeExchangeLetter(fact) {
          const target = fact && typeof fact.file === "string" ? fact.file : "";
          if (!target || exchangeCloseBusy) return;
          setExchangeCloseBusy(target);
          fetchJson("/api/exchange/close", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ root, path: target }),
          })
            .then((closed) => {
              setLive(closed && closed.reason === "already-closed"
                ? "заявка уже закрыта: " + target
                : "заявка закрыта ack-письмом: " + target);
              return fetchJson("/api/exchange?root=" + encodeURIComponent(root))
                .then((body) => setExchange(body))
                .catch(() => setExchange({ failed: true }));
            })
            .catch((failure) => setLive("не удалось закрыть заявку: "
              + (failure && failure.message ? failure.message : String(failure))
              + (failure && failure.fix ? " — " + failure.fix : "")))
            .finally(() => setExchangeCloseBusy(null));
        }

        /*
         * Предупреждения обмена (задание 0052, WC-15): участник, которого нет в
         * roots/participants профиля, — не «0 писем», а причина: его ящик не
         * читается. Строка видимая, не тост: человек видит её в карточке обмена
         * рядом со счётчиками, вместе с рецептом, что и куда добавить.
         */
        function renderExchangeWarnings(data) {
          const warnings = Array.isArray(data && data.warnings) ? data.warnings : [];
          if (warnings.length === 0) return null;
          return h("div", { style: S.error, "data-exchange-warning": "1" },
            warnings.map((item) => {
              const label = item && typeof item.label === "string" && item.label.trim() ? item.label.trim() : "участник";
              const code = item && typeof item.code === "string" ? item.code : "";
              return h("div", { key: (code || "warning") + ":" + label, "data-exchange-warning-code": code },
                h("div", { style: S.errorTitle },
                  (item && (item.message || item.error)) || ("участник «" + label + "» не в roots/participants — его ящик не читается")),
                h("div", { style: S.fix },
                  (item && item.fix)
                    || ("добавьте " + label + " в roots и participants профиля (cordis.patch.yml): иначе его ящик не читается")));
            }));
        }

        /*
         * The panel shows what actually crossed the border — direction, time and
         * counterpart. Message bodies stay outside; the list is facts, not a chat.
         */
        function renderExchange() {
          if (!payload || !payload.exists || !exchange) return null;
          const data = exchange;
          /*
           * Карточка — цель портала: он её открывает и уводит в неё фокус. Список
           * фактов живёт здесь и внутри портала не повторяется.
           */
          const sheet = {
            id: "pg-exchange-card",
            tabIndex: -1,
            ref: exchangeCardRef,
            style: { ...S.card, display: "flex", flexDirection: "column", gap: "6px", padding: "8px 10px" },
          };
          /*
           * Счётчик требующих хода — в карточке «Внешняя связь», сразу и без
           * открывания ящика (задания 0082/0113/0128): число приходит из
           * /api/exchange, считает его сервер тем же exchangeAttention, что у CLI.
           */
          const unread = unreadTotal(data);
          const unreadChip = unread === null ? null : h("span", {
            style: { ...S.chip, fontWeight: 600, color: unread > 0 ? T.danger : T.secondary },
            "data-exchange-unread": String(unread),
            title: "писем обмена, требующих хода: " + unread + ". Счёт ведёт exchangeAttention — request/question без ответа за последние 14 суток; ящик открывать не нужно",
          }, unreadLabel(unread));
          /*
           * Просроченные (задание 0128): заявки старше окна 14 суток в счётчик не
           * входят, но видны отдельной подписью — хвост не теряется молча.
           */
          const stale = staleTotal(data);
          const staleChip = stale > 0 ? h("span", {
            style: { ...S.chip, color: T.warn },
            "data-exchange-stale": String(stale),
            title: "заявки старше 14 суток: в счётчик «требуют хода» не входят, но видны в списке и закрываются кнопкой",
          }, staleLabel(stale)) : null;
          const head = h("div", { style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
            h("span", { style: { fontWeight: 600, fontSize: "12px" } }, "Внешняя связь"),
            unreadChip,
            staleChip,
            h("span", { style: S.hint }, data.label ? "мы в обмене: " + data.label : "имя этого воркспейса в обмене не объявлено"),
            h("button", { type: "button", style: S.button, onClick: reloadExchange }, "Перечитать факты"));
          /*
           * Предупреждения показываются во всех состояниях карточки: причина
           * пустого ящика важнее счётчиков и не прячется за «0 писем».
           */
          const warningRows = renderExchangeWarnings(data);
          if (data.failed) {
            return h("div", sheet, head, warningRows,
              h("div", { style: S.hint }, "факты обмена прочитать не удалось: проверьте папку обмена"));
          }
          if (!data.label) {
            return h("div", sheet, head, warningRows,
              h("div", { style: S.hint }, data.reason || "задайте exchange.me или participants в cordis.patch.yml"));
          }
          const links = Array.isArray(data.links) ? data.links : [];
          if (links.length === 0) {
            const sources = (data.sources || []).map((item) => item.path).join(", ") || "папки не найдены";
            return h("div", sheet, head, warningRows,
              h("div", { style: S.hint }, "фактов обмена не найдено. Источники: " + sources
                + (data.unparsed ? "; не разобрано файлов: " + data.unparsed : "")
                + ". Папка обмена задаётся exchange в cordis.patch.yml."));
          }
          return h("div", sheet, head, warningRows,
            links.map((link) => h("div", { key: link.counterpart, style: { display: "flex", flexDirection: "column", gap: "4px" } },
              h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
                h("span", { style: { ...S.mono, fontWeight: 600 } }, link.counterpart),
                h("span", { style: { fontSize: "12px" } }, linkKindWord(link.kind)),
                h("span", { style: S.hint }, "↗ " + link.outgoing + " / ↙ " + link.incoming + (link.last ? " · последнее " + factTime(link.last) : "")),
                h("button", {
                  type: "button",
                  style: S.button,
                  onClick: () => setExchangeOpen(exchangeOpen === link.counterpart ? null : link.counterpart),
                }, exchangeOpen === link.counterpart ? "Скрыть сообщения" : "Сообщения (" + (link.outgoing + link.incoming) + ")")),
              exchangeOpen === link.counterpart
                ? h("div", { style: S.linkList }, link.facts.slice(0, 50).map((fact) => {
                  const key = String(fact.file) + String(fact.at);
                  const line = factTime(fact.at) + " · "
                    + (fact.from === data.label ? "исходящее → " + fact.to : "← входящее " + fact.from)
                    + (fact.thread ? " · " + fact.thread : "")
                    + (fact.status ? " · " + fact.status : "")
                    + (fact.stale ? " · просрочено" : "");
                  /*
                   * Заявка без ответа (задание 0128): кнопка «Закрыть» пишет
                   * ack-письмо и снимает заявку из счётчика, не требуя ответа по
                   * существу. Подпись кнопки — само письмо: человек видит, что
                   * будет отправлено, ещё до нажатия.
                   */
                  if (!fact.attention) {
                    return h("div", { key, style: { ...S.hint, fontFamily: T.mono } }, line);
                  }
                  const ack = closeAck({
                    path: fact.file,
                    from: fact.from,
                    to: data.label,
                    thread: fact.thread,
                    subject: fact.subject,
                  });
                  return h("div", {
                    key,
                    style: { ...S.hint, fontFamily: T.mono, display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
                  },
                    h("span", null, line),
                    h("button", {
                      type: "button",
                      style: S.button,
                      "data-exchange-close": fact.file,
                      disabled: exchangeCloseBusy === fact.file,
                      title: ack,
                      onClick: () => closeExchangeLetter(fact),
                    }, "Закрыть"));
                }))
                : null,
              h("div", { style: S.hint }, "показываются только факты: направление, время, ветка; тексты не читаются"))),
            data.unparsed
              ? h("div", { style: S.hint }, "не разобрано файлов без From/To/Date: " + data.unparsed)
              : null);
        }

        function renderLegend() {
          return h(
            "div",
            { style: S.legend },
            Object.keys(EDGE_HELP).map((kind) =>
              h("span", { key: kind, style: S.legendItem, title: EDGE_HELP[kind] },
                h("span", { style: { color: edgeStroke(kind), fontWeight: 700 } }, "—"),
                " " + kind + ": " + EDGE_HELP[kind])),
          );
        }

        function renderIssues() {
          if (!payload) return null;
          const errors = payload.errors || [];
          const warnings = payload.warnings || [];
          if (errors.length === 0 && warnings.length === 0) return null;
          return h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "8px" } },
            errors.length > 0
              ? h("div", { style: S.error },
                h("div", { style: S.errorTitle }, "Структура недействительна — исправьте файл (" + errors.length + "):"),
                h("ul", { style: S.issueList }, errors.map((item, index) =>
                  h("li", { key: "err-" + index, style: S.issue },
                    h("div", null, (item.file ? item.file + ": " : "") + item.message),
                    item.fix ? h("div", { style: S.fix }, "Что сделать: " + item.fix) : null,
                    h("div", { style: S.issueMeta }, item.code || "")))))
              : null,
            warnings.length > 0
              ? h("details", null,
                h("summary", { style: { cursor: "pointer", color: T.warn, fontSize: "12px" } }, "Предупреждения (" + warnings.length + ") — структура читается, но неполна"),
                h("ul", { style: S.list }, warnings.map((item, index) =>
                  h("li", { key: "warn-" + index },
                    (item.file ? item.file + ": " : "") + item.message,
                    item.fix ? " — " + item.fix : ""))))
              : null,
          );
        }

        function describeEdge(edge, nodeId) {
          const outgoing = edge.from === nodeId;
          const other = outgoing ? edge.to : edge.from;
          let meaning;
          if (edge.kind === "delegate") meaning = outgoing ? "вы поручаете работу" : "вам поручают работу";
          else if (edge.kind === "review") meaning = outgoing ? "вы проверяете работу" : "вас проверяют";
          else if (edge.kind === "report") meaning = outgoing ? "вы возвращаете результат" : "вам возвращают результат";
          else meaning = "равное сотрудничество";
          return h("span", null,
            h("span", { style: { fontFamily: T.mono } }, (outgoing ? "→ " : "← ") + other),
            " · " + edge.kind + ": " + meaning);
        }

        function linkMeaning(kind, direction, target) {
          if (kind === "peer") return "равное сотрудничество с «" + target + "»: связь без направления";
          if (kind === "delegate") {
            return direction === "from" ? "вы поручаете работу «" + target + "»" : "«" + target + "» поручает работу вам";
          }
          if (kind === "report") {
            return direction === "from" ? "вы возвращаете результат «" + target + "»" : "«" + target + "» возвращает результат вам";
          }
          return direction === "from" ? "«" + target + "» будет проверять вашу работу" : "вы будете проверять работу «" + target + "»";
        }

        function submitLink(target) {
          if (!target || linking) return;
          const from = linkKind === "peer" || linkDirection === "from" ? picked : target;
          const to = linkKind === "peer" || linkDirection === "from" ? target : picked;
          setLinking(true);
          setLinkError(null);
          fetchJson("/api/link?root=" + encodeURIComponent(root)
            + "&action=add&from=" + encodeURIComponent(from)
            + "&to=" + encodeURIComponent(to)
            + "&kind=" + encodeURIComponent(linkKind), { method: "POST" })
            .then(() => {
              setLinkOpen(false);
              setLinkTarget("");
              return load(root, true);
            })
            .catch((failure) => setLinkError({
              message: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Проверьте структуру и повторите.",
            }))
            .finally(() => setLinking(false));
        }

        /* ---------- библиотека узлов: палитра, вынос, редактор у узла ---------- */

        /* Курсор → координаты схемы: карточка встаёт центром под курсором. */
        function canvasPoint(event) {
          const svg = svgRef.current;
          if (!svg) return overCanvas(event) ? { x: 16, y: 16 } : null;
          if (!event) return null;
          const rect = svg.getBoundingClientRect();
          if (!(rect.width > 0) || !(rect.height > 0)) return null;
          const widthAttr = Number(svg.getAttribute("width"));
          const heightAttr = Number(svg.getAttribute("height"));
          const scaleX = Number.isFinite(widthAttr) && widthAttr > 0 ? widthAttr / rect.width : 1;
          const scaleY = Number.isFinite(heightAttr) && heightAttr > 0 ? heightAttr / rect.height : scaleX;
          /*
           * viewBox начинается с -16: пользовательская точка отличается от
           * экранной на этот отступ. Карточка центрируется под курсором.
           */
          return {
            x: Math.max(0, Math.round((event.clientX - rect.left) * scaleX - 16 - 88)),
            y: Math.max(0, Math.round((event.clientY - rect.top) * scaleY - 16 - 31)),
          };
        }

        function overCanvas(event) {
          const canvas = canvasRef.current;
          if (!canvas || !event) return false;
          const rect = canvas.getBoundingClientRect();
          return event.clientX >= rect.left && event.clientX <= rect.left + rect.width
            && event.clientY >= rect.top && event.clientY <= rect.top + rect.height;
        }

        function cancelCarry(message) {
          carryRef.current = null;
          setCarry(null);
          setLibraryNote(message ? { text: message } : null);
        }

        /*
         * Вынос мышью: pointerdown на карточке библиотеки рождает призрак, сброс
         * над канвой ставит узел в точку сброса. Сброс мимо канвы — не молчание,
         * а объяснение: иначе карточка «пропала».
         */
        function beginPointerCarry(event, item) {
          if (!item) return;
          if (event && event.button !== undefined && event.button !== 0) return;
          if (event && typeof event.preventDefault === "function") event.preventDefault();
          setLibraryNote(null);
          const started = { item, mode: "pointer", clientX: event.clientX, clientY: event.clientY, overCanvas: overCanvas(event) };
          /* Ref ставится сразу: очень быстрый клик может отпустить кнопку до эффекта. */
          carryRef.current = started;
          setCarry(started);
          if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
          let moved = false;
          function move(moveEvent) {
            if (!moved && Math.abs(moveEvent.clientX - started.clientX) + Math.abs(moveEvent.clientY - started.clientY) > 4) {
              moved = true;
            }
            setCarry((prev) => (prev ? {
              ...prev,
              clientX: moveEvent.clientX,
              clientY: moveEvent.clientY,
              overCanvas: overCanvas(moveEvent),
            } : prev));
          }
          function stop(upEvent) {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
            /* Esc мог уже отменить вынос: тогда узел не ставится. */
            if (!carryRef.current) return;
            carryRef.current = null;
            setCarry(null);
            /*
             * Простое нажатие — это не вынос: рамка будущего узла на канве не
             * появляется и узел не ставится. Взять карточку можно перетаскиванием
             * или клавишей Enter на самой карточке.
             */
            if (!moved) {
              setLibraryNote({ text: "Карточка «" + item.label + "»: перетащите её на схему "
                + "или нажмите Enter, чтобы поставить с клавиатуры." });
              setLive("карточка «" + item.label + "» не взята: перетащите её на схему или нажмите Enter");
              return;
            }
            if (!upEvent || !overCanvas(upEvent)) {
              setLibraryNote({ text: "Вынос отменён: сброс был вне канвы. Отпустите карточку над схемой." });
              return;
            }
            const point = canvasPoint(upEvent);
            if (!point) {
              setLibraryNote({ text: "Вынос отменён: канва ещё не готова. Нажмите «Обновить» и повторите." });
              return;
            }
            placeLibraryNode(item, point.x, point.y);
          }
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", stop);
          window.addEventListener("pointercancel", stop);
        }

        /*
         * Вынос с клавиатуры: Enter на карточке берёт её, стрелки двигают точку,
         * Enter ставит, Esc отменяет — без мыши.
         */
        function beginKeyboardCarry(item) {
          if (!item) return;
          const point = libraryStartPoint(payload && payload.layout);
          setLibraryNote(null);
          setCarry({ item, mode: "keyboard", x: point.x, y: point.y });
          setLive("карточка «" + item.label + "» взята: стрелки двигают, Enter ставит, Esc отменяет");
        }

        React.useEffect(() => { carryRef.current = carry; }, [carry]);

        React.useEffect(() => {
          if (!carry) return undefined;
          if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
          const onKey = (event) => {
            if (!event) return;
            if (event.key === "Escape") {
              event.preventDefault();
              cancelCarry("Вынос отменён: карточка вернулась в библиотеку.");
              setLive("вынос отменён");
              return;
            }
            if (carry.mode !== "keyboard") return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              const item = carry.item;
              const point = { x: carry.x, y: carry.y };
              setCarry(null);
              placeLibraryNode(item, point.x, point.y);
              return;
            }
            const next = keyboardMove({ x: carry.x, y: carry.y }, event.key, Boolean(event.shiftKey));
            if (!next) return;
            event.preventDefault();
            setCarry({ ...carry, x: next.x, y: next.y });
            setLive("карточка «" + carry.item.label + "»: x " + next.x + ", y " + next.y);
          };
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        }, [carry]);

        /*
         * Постановка узла: тип, роль и спека (prompt) из библиотеки, id выдаёт сервер (critic-1),
         * затем связь по умолчанию, позиция на канве и открытый редактор у узла.
         */
        function placeLibraryNode(item, x, y) {
          if (!item || !root) return;
          /* Папка — не узел: вынос создаёт запись folders и контракт Rev 1 в ящике. */
          if (item.type === "folder") {
            placeFolderFromLibrary(item);
            return;
          }
          const graph = (payload && payload.graph) || { models: {}, nodes: [] };
          const existing = new Set(((graph.nodes) || []).map((node) => node.id));
          const coordinator = existing.has("coordinator");
          /*
           * Модель не подставляется даже первой из каталога: карточка узла
           * откроется сразу после постановки, и человек выберет провайдера и
           * модель сам (0050 D3). Пока выбора нет, узел остаётся без маршрута.
           */
          /* Тело узла — из карточки целиком, вместе со спекой роли (prompt). */
          const body = libraryNodeDraft(item);
          /*
           * Рекомендованная модель добавляется только полным маршрутом из
           * живого каталога: модель без провайдера сервер отклонит (0126 D3).
           */
          Object.assign(body, libraryModelRoute(item, availableModels) || {});
          setLibraryNote(null);
          setLayoutError(null);
          setLive("ставлю «" + item.label + "» на схему: x " + x + ", y " + y);
          let linkFailed = null;
          fetchJson("/api/node?root=" + encodeURIComponent(root), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
            .then((created) => {
              const node = created && created.node ? created.node : null;
              if (!node || !node.id) throw new Error("сервер не вернул id нового узла");
              const edge = libraryEdge(item.type, node.id, coordinator);
              const step = edge
                ? fetchJson("/api/link?root=" + encodeURIComponent(root)
                  + "&action=add&from=" + encodeURIComponent(edge.from)
                  + "&to=" + encodeURIComponent(edge.to)
                  + "&kind=" + encodeURIComponent(edge.kind), { method: "POST" })
                  /* Отказ связи не теряет узел: редактор объяснит и даст исправить. */
                  .catch((failure) => { linkFailed = failure; return null; })
                : Promise.resolve(null);
              return step
                .then(() => fetchJson("/api/layout", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Accept: "application/json" },
                  body: JSON.stringify({ root, positions: { [node.id]: { x, y } } }),
                }))
                .catch(() => null)
                .then(() => fetchJson("/api/graph?root=" + encodeURIComponent(root)))
                .then((fresh) => {
                  setPayload(fresh);
                  setPicked(node.id);
                  openNodeEditor(node.id, fresh.graph);
                  const words = libraryItem(item.type);
                  const noteParts = ["Узел «" + node.id + "» поставлен на схему."];
                  if (edge) noteParts.push("Связь по умолчанию — " + (words.link ? words.link.words : edge.kind) + ".");
                  if (item.type === "exchange" || item.type === "folder") noteParts.push("Это папка, а не агент: обмен — её свойство.");
                  if (!edge && words.link && !coordinator) {
                    noteParts.push("Связь по умолчанию не поставлена: в структуре нет узла coordinator — "
                      + "добавьте его на схему или проведите связь в редакторе узла.");
                  }
                  if (linkFailed) {
                    noteParts.push("Связь по умолчанию не встала: " + (linkFailed.message || "ошибка")
                      + " — " + (linkFailed.fix || "проведите связь в редакторе узла") + ".");
                  }
                  setLibraryNote({ text: noteParts.join(" ") });
                  setLive("узел " + node.id + " поставлен: x " + x + ", y " + y);
                });
            })
            .catch((failure) => setLayoutError({
              message: "Не удалось поставить узел из библиотеки: " + (failure && failure.message ? failure.message : String(failure)),
              fix: (failure && failure.fix) || "Проверьте structure/*.json и повторите.",
            }));
        }

        /*
         * Вынос «Папки» из библиотеки — это папка обмена, а не узел: POST
         * /api/folder?action=add пишет запись в folders и кладёт в ящик контракт
         * Rev 1. Оркестратором становится объявленный узел: coordinator, если он
         * есть, иначе первый узел структуры.
         */
        function placeFolderFromLibrary(item) {
          if (!root) return;
          const graph = (payload && payload.graph) || { nodes: [], folders: [] };
          const nodes = (graph.nodes || []).filter((node) => node && node.id);
          if (nodes.length === 0) {
            setLibraryNote({ text: "Папке нужен оркестратор — объявленный узел. Сначала вынесите «Воркер» или «Критик», затем повторите." });
            setLive("папка не создана: в структуре нет ни одного узла");
            return;
          }
          const orchestrator = nodes.some((node) => node.id === "coordinator") ? "coordinator" : nodes[0].id;
          const label = String(root).split(/[\\/]/u).filter(Boolean).pop() || "structure";
          const draft = libraryFolderDraft(graph.folders, orchestrator, label);
          setLibraryNote(null);
          setLayoutError(null);
          setLive("создаю папку «" + draft.id + "»: ящик " + draft.boxPath + ", оркестратор " + orchestrator);
          fetchJson("/api/folder?root=" + encodeURIComponent(root) + "&action=add", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ root, folder: folderBody(draft) }),
          })
            .then((saved) => reloadFolderGraph().then((fresh) => ({ saved, fresh })))
            .then(({ saved, fresh }) => {
              const folder = saved && saved.folder ? saved.folder : draft;
              const rev = saved && saved.contract ? saved.contract.rev : 1;
              setLibraryNote({ text: "Папка «" + folder.id + "» создана: запись в folders, контракт Rev " + rev + " в ящике. Узлы не менялись." });
              setLive("папка " + folder.id + " создана: контракт Rev " + rev);
              /* Свежий граф передаётся явно: state ещё не обновился в этом кадре. */
              openFolderEditor(folder.id, fresh && fresh.graph);
            })
            .catch((failure) => setLayoutError({
              message: "Не удалось создать папку обмена: " + (failure && failure.message ? failure.message : String(failure)),
              fix: (failure && failure.fix) || "Проверьте structure/graph.json и повторите.",
            }));
        }

        /* Редактор раскрывается от узла: id, роль, модель, назначение, расписание, связи. */
        function nodeEditorDraft(node) {
          const declared = node && node.schedule && typeof node.schedule === "object" ? node.schedule : null;
          const looksCritic = node && (/^critic(-|$)/iu.test(String(node.id || ""))
            || /критик|critic/iu.test(String(node.role || "")));
          return {
            id: node.id,
            role: node.role || "",
            provider: node.provider || "",
            model: node.model || "",
            family: node.family || "",
            brief: node.brief || "",
            /* Спека — текст роли; пустая строка значит «роль без спеки», а не «нет поля». */
            prompt: typeof node.prompt === "string" ? node.prompt : "",
            at: declared && declared.at ? declared.at : "09:00",
            timeZone: declared && declared.timeZone ? declared.timeZone : "Europe/Moscow",
            withSchedule: Boolean(declared || looksCritic),
          };
        }

        function openNodeEditor(id, graph) {
          const source = graph || (payload && payload.graph) || { nodes: [] };
          const node = ((source && source.nodes) || []).find((item) => item && item.id === id) || null;
          if (!node) { setNodeEditor(null); setNodeEditorBaseline(null); return; }
          const draft = nodeEditorDraft(node);
          setNodeEditor(draft);
          setNodeEditorBaseline(draft);
          setNodeEditorError(null);
          /* Живой каталог на момент открытия: список моделей — факт, а не кэш. */
          refreshModelCatalog();
          setNodeDeleteAsk(false);
          setEditorEdge({ kind: "delegate", direction: "from", target: "" });
          /* «Настройки» — вкладка того же окна: второго окна поверх первого нет. */
          setNodeInfo({ id: node.id, kind: "node" });
          setNodeTab("settings");
          setCloseConfirm(null);
          setLinkOpen(false);
          setLinkError(null);
          setLaunch(null);
        }

        function closeNodeEditor() {
          setNodeEditor(null);
          setNodeEditorBaseline(null);
          setNodeEditorError(null);
          setNodeDeleteAsk(false);
          setCloseConfirm(null);
          setEditorEdge({ kind: "delegate", direction: "from", target: "" });
          /* Редактор живёт вкладкой окна узла: закрывая его, закрываем окно. */
          setNodeInfo((open) => (open && open.kind === "node" ? null : open));
          setNodeTab("info");
        }

        function nodeEditorChanged() {
          return editorDraftChanged(nodeEditor, nodeEditorBaseline);
        }

        /* Крестик «Настроек»: без правок закрывает сразу, с правками спрашивает. */
        function requestCloseNodeEditor() {
          if (!nodeEditor) { closeNodeInfo(); return; }
          if (nodeEditorChanged()) { setCloseConfirm("node"); return; }
          closeNodeEditor();
        }

        /* Крестик окна на вкладках чтения: та же проверка несохранённых правок. */
        function requestCloseNodeWindow() {
          if (nodeEditor && nodeEditorChanged()) { setCloseConfirm("node"); return; }
          if (nodeEditor) { closeNodeEditor(); return; }
          closeNodeInfo();
        }

        /* Переход между вкладками: «Настройки» открывают форму, чтение — просто вкладку. */
        function openNodeWindowTab(tab) {
          if (!nodeInfo || nodeInfo.kind === "folder") return;
          if (tab === "settings") {
            /* Черновик этой же формы не пересоздаётся: несохранённые правки не теряются. */
            if (nodeEditor && nodeEditor.id === nodeInfo.id) setNodeTab("settings");
            else openNodeEditor(nodeInfo.id);
            return;
          }
          setNodeTab(tab === "state" ? "state" : "info");
        }

        /* «Нет» в диалоге крестика: правки отброшены, окно закрыто, запись не уходит. */
        function discardEditorChanges() {
          const target = closeConfirm;
          setCloseConfirm(null);
          if (target === "node") closeNodeEditor();
          else if (target === "folder") closeFolderEditor();
        }

        /*
         * «Да» в диалоге крестика папки: подтверждение закрывается, дальше тот же
         * путь, что у основной кнопки — один POST action=add|update, затем окно
         * закрывается. Ошибка записи остаётся в редакторе, а не теряется с окном.
         */
        function saveFolderAndClose() {
          setCloseConfirm(null);
          submitFolderEditor();
        }

        function closeNodeInfo() {
          setNodeInfo(null);
          setNodeTab("info");
          setNodeEditor(null);
          setNodeEditorBaseline(null);
          setNodeEditorError(null);
          setNodeDeleteAsk(false);
        }

        /*
         * 0143: шестерёнка в строке роли — единственный вход в окно узла.
         * Окно всегда открывается на «Сведениях»; правка — вкладкой внутри,
         * поэтому удаление остаётся в «Настройках» с подтверждением.
         */
        function openNodeWindow(id) {
          if (!id) return;
          setCloseConfirm(null);
          setNodeEditor(null);
          setNodeEditorBaseline(null);
          setNodeEditorError(null);
          setNodeDeleteAsk(false);
          setNodeInfo({ id, kind: "node" });
          setNodeTab("info");
        }

        /*
         * 0143: шестерёнка в шапке папки и бейдж участников открывают окно
         * папки — те же «Сведения», «Состояние», «Настройки», что у узла.
         * Правка по-прежнему в «Настройках»: редактор папки, а не второе окно.
         */
        function openFolderWindow(id) {
          if (!id) return;
          setCloseConfirm(null);
          setNodeEditor(null);
          setNodeEditorBaseline(null);
          setNodeEditorError(null);
          setNodeDeleteAsk(false);
          setNodeInfo({ id, kind: "folder" });
          setNodeTab("info");
        }

        /* «Изменить в «Настройках» →» — переход внутри окна, а не второе окно. */
        function editFromNodeInfo() {
          const target = nodeInfo;
          if (!target || !target.id) return;
          if (target.kind === "folder") { closeNodeInfo(); openFolderEditor(target.id); return; }
          if (nodeEditor && nodeEditor.id === target.id) { setNodeTab("settings"); return; }
          openNodeEditor(target.id);
        }

        /*
         * «Удалить узел» спрашивает окном панели, а не window.confirm.
         * Первый клик ничего не пишет: он открывает подтверждение
         * [data-node-delete-ask]. Запись делает кнопка [data-node-delete-confirm]
         * -> removeNodeFromEditor. Координатор защищён: у него нет кнопки,
         * а маршрут отказал бы с рецептом.
         */
        function requestRemoveNode() {
          if (!nodeEditor || nodeEditorBusy) return;
          const id = nodeEditor.id;
          const current = nodesById.get(id) || { id, role: nodeEditor.role };
          if (isCoordinatorNode(current)) {
            setNodeEditorError({
              what: "Узел «" + id + "» не удаляется",
              why: "это координатор: он держит структуру воркспейса",
              fix: "координатор не удаляется — удалите другой узел или смените координатора в structure/*.json.",
            });
            return;
          }
          setNodeDeleteAsk(true);
          setLive("удаление узла «" + id + "»: панель спрашивает подтверждение");
        }

        function cancelRemoveNode() {
          setNodeDeleteAsk(false);
          setLive("удаление узла отменено");
        }

        /*
         * Запись: узел и все связи, где он участвовал, уходят из
         * structure/*.json одним запросом action=remove. Системный диалог
         * здесь не участвует: подтверждение уже дано окном панели.
         */
        function removeNodeFromEditor() {
          if (!nodeEditor || nodeEditorBusy) return;
          const id = nodeEditor.id;
          const current = nodesById.get(id) || { id, role: nodeEditor.role };
          if (isCoordinatorNode(current)) {
            setNodeEditorError({
              what: "Узел «" + id + "» не удаляется",
              why: "это координатор: он держит структуру воркспейса",
              fix: "координатор не удаляется — удалите другой узел или смените координатора в structure/*.json.",
            });
            return;
          }
          setNodeDeleteAsk(false);
          setNodeEditorBusy(true);
          setNodeEditorError(null);
          fetchJson("/api/node?root=" + encodeURIComponent(root) + "&action=remove", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ id }),
          })
            .then(() => fetchJson("/api/graph?root=" + encodeURIComponent(root)))
            .then((fresh) => {
              setPayload(fresh);
              closeNodeEditor();
              setPicked(null);
              setLibraryNote({ text: "Узел «" + id + "» удалён: связи, где он участвовал, убраны из структуры." });
              setLive("узел " + id + " удалён");
            })
            .catch((failure) => setNodeEditorError({
              what: "Не удалось удалить узел «" + id + "»",
              why: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Обновите панель и повторите; если узел — координатор, его не удаляют.",
            }))
            .finally(() => setNodeEditorBusy(false));
        }

        function submitNodeEditor() {
          if (!nodeEditor || nodeEditorBusy) return;
          const draft = nodeEditor;
          const role = String(draft.role || "").trim();
          if (!role) {
            setNodeEditorError({
              what: "Не удалось сохранить узел «" + draft.id + "»",
              why: "роль пустая: узел станет неотличим от соседей и на канве, и в палитре",
              fix: "Впишите роль словами — например, «критик», «исполнитель» или «обмен».",
            });
            return;
          }
          const exchange = isExchangeRole(role);
          /*
           * Маршрут узла — только явная пара из живого каталога. Пустой выбор и
           * пропавшая модель — отказ с рецептом до запроса, без первой модели
           * каталога и без старого поля «алиас».
           */
          let route = { provider: "", model: "", family: "" };
          if (!exchange) {
            const choice = nodeModelChoice(availableModels, draft.provider, draft.model, draft.family);
            if (choice.error) {
              setNodeEditorError({
                what: "Не удалось сохранить узел «" + draft.id + "»",
                why: choice.error.message,
                fix: choice.error.fix || "Выберите провайдера и модель в живом каталоге.",
              });
              return;
            }
            route = choice;
          }
          const node = nodesById.get(draft.id) || null;
          setNodeEditorBusy(true);
          setNodeEditorError(null);
          fetchJson("/api/node?root=" + encodeURIComponent(root) + "&action=update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: draft.id,
              role,
              brief: String(draft.brief || "").trim(),
              /* Спека сохраняется тем же POST /api/node: пустая строка очищает её. */
              ...(exchange ? {} : { prompt: String(draft.prompt || "").trim() }),
              provider: exchange ? "" : String(route.provider || "").trim(),
              model: exchange ? "" : String(route.model || "").trim(),
              family: exchange ? "" : String(route.family || "").trim(),
            }),
          })
            .then(() => {
              const declared = node && node.schedule && node.schedule.at ? node.schedule.at : null;
              if (!draft.withSchedule || exchange || declared === draft.at) return null;
              /* Время запуска читает планировщик: у него свой маршрут. */
              return fetchJson("/api/schedule", {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({ root, node: draft.id, at: draft.at }),
              });
            })
            .then(() => fetchJson("/api/graph?root=" + encodeURIComponent(root)))
            .then((fresh) => {
              setPayload(fresh);
              setPicked(draft.id);
              closeNodeEditor();
              setLibraryNote({
                text: "Узел «" + draft.id + "» сохранён: роль «" + role + "»"
                  + (draft.withSchedule && !exchange ? ", запуск в " + draft.at + " (" + draft.timeZone + ")" : "")
                  + (exchange ? ", связей с агентами нет — только сообщения" : "") + ".",
              });
              setLive("узел " + draft.id + " сохранён");
            })
            .catch((failure) => setNodeEditorError({
              what: "Не удалось сохранить узел «" + draft.id + "»",
              why: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix)
                || "Проверьте поля: время пишется как HH:MM. Объявление узла могло сохраниться, расписание — нет.",
            }))
            .finally(() => setNodeEditorBusy(false));
        }

        function addEditorLink() {
          if (!nodeEditor || nodeEditorBusy) return;
          const graph = (payload && payload.graph) || { nodes: [], edges: [] };
          const others = ((graph.nodes) || []).filter((node) => node.id !== nodeEditor.id && !isFolderNode(node));
          const targetId = others.some((node) => node.id === editorEdge.target) ? editorEdge.target : ((others[0] && others[0].id) || "");
          if (!targetId) {
            setNodeEditorError({
              what: "Не удалось добавить связь",
              why: "других узлов нет: связывать не с кем",
              fix: "Поставьте на схему второй узел из библиотеки и повторите.",
            });
            return;
          }
          const from = editorEdge.kind === "peer" || editorEdge.direction === "from" ? nodeEditor.id : targetId;
          const to = editorEdge.kind === "peer" || editorEdge.direction === "from" ? targetId : nodeEditor.id;
          setNodeEditorBusy(true);
          setNodeEditorError(null);
          fetchJson("/api/link?root=" + encodeURIComponent(root)
            + "&action=add&from=" + encodeURIComponent(from)
            + "&to=" + encodeURIComponent(to)
            + "&kind=" + encodeURIComponent(editorEdge.kind), { method: "POST" })
            .then(() => fetchJson("/api/graph?root=" + encodeURIComponent(root)))
            .then((fresh) => {
              setPayload(fresh);
              setLibraryNote({ text: "Связь добавлена: " + from + " → " + to + " (" + editorEdge.kind + ")." });
              setLive("связь " + from + " → " + to + " добавлена");
            })
            .catch((failure) => setNodeEditorError({
              what: "Не удалось добавить связь",
              why: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Проверьте узлы и вид связи, затем повторите.",
            }))
            .finally(() => setNodeEditorBusy(false));
        }

        function removeEditorLink(edge) {
          if (!edge || nodeEditorBusy) return;
          const label = edge.from + " → " + edge.to + " (" + edge.kind + ")";
          if (typeof window !== "undefined" && !window.confirm("Удалить связь " + label + "?")) return;
          setNodeEditorBusy(true);
          setNodeEditorError(null);
          fetchJson("/api/link?root=" + encodeURIComponent(root)
            + "&action=remove&from=" + encodeURIComponent(edge.from)
            + "&to=" + encodeURIComponent(edge.to)
            + "&kind=" + encodeURIComponent(edge.kind), { method: "POST" })
            .then(() => fetchJson("/api/graph?root=" + encodeURIComponent(root)))
            .then((fresh) => {
              setPayload(fresh);
              setLibraryNote({ text: "Связь удалена: " + label + "." });
              setLive("связь удалена: " + label);
            })
            .catch((failure) => setNodeEditorError({
              what: "Не удалось удалить связь",
              why: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Обновите панель и повторите.",
            }))
            .finally(() => setNodeEditorBusy(false));
        }

        /*
         * The panel cannot start an agent: the tools need a session, and a web
         * route has none. So "запустить" here means "prepare the call": the
         * person copies it into the chat, and the declaration decides the route.
         */
        function launchCall() {
          if (!picked) return "";
          if (launch === "branch") {
            return 'project_graph_branch ' + JSON.stringify({
              node: picked,
              prompt: "…задание для ветки…",
              depth: launchDepth,
              parallelism: launchParallelism,
            }, null, 2);
          }
          return 'project_graph_run ' + JSON.stringify({ node: picked, prompt: "…задание для узла…" }, null, 2);
        }

        function copyLaunchCall() {
          const text = launchCall();
          setCallCopy("manual");
          try {
            const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : null;
            if (clipboard && typeof clipboard.writeText === "function") {
              clipboard.writeText(text).then(() => setCallCopy("done")).catch(() => setCallCopy("manual"));
            }
          } catch {
            setCallCopy("manual");
          }
        }

        /*
         * Низ панели (задание 0122): два действия — «Связь» и «Запустить».
         * Строки состояния уехали в окно узла: паспорт и живое состояние
         * живут на разных вкладках и в нижней панели не смешиваются.
         */
        function renderDetails() {
          if (!picked) {
            return h("div", { style: S.hint },
              "Выберите узел на графе: внизу останутся «Связь» и «Запустить», а три вкладки — "
              + "«Сведения», «Состояние», «Настройки» — открываются шестерёнкой на карточке.");
          }
          const node = nodesById.get(picked);
          if (!node) return null;
          /* Папка обмена не соединяется с агентами — в кандидатах её нет. */
          const others = ((payload.graph && payload.graph.nodes) || [])
            .filter((item) => item.id !== picked && !isFolderNode(item));
          const pickedExchange = isFolderNode(node);
          /*
           * 0162: при error-находках «Запустить» недоступна — правку записать
           * можно, а новое задание не стартует (макет §2.5, четвёртое место
           * блокировки).
           */
          const validationNow = validatorFindings(payload && payload.validation);
          const launchBlocked = validatorBlocked(validationNow);
          const targetId = others.some((item) => item.id === linkTarget) ? linkTarget : ((others[0] && others[0].id) || "");
          const labels = bottomBarItems();
          return h(
            "div",
            { style: S.card, "data-bottom-bar": picked },
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
              h("span", { style: { fontWeight: 600, fontFamily: T.mono, fontSize: 13 } }, node.id),
              h("span", { style: { color: T.tertiary, fontSize: 11 } }, (node.role || "роль не задана") + " · выбран"),
              /*
               * Вход в окно узла — шестерёнка в строке роли (0143, вариант C):
               * в низу только два действия, «Связь» и «Запустить», как в макете.
               * Компат-кнопки редактирования в низу нет.
               */
              h("span", { style: { flex: "1 1 auto" } }),
              h("span", { style: S.hint, title: "окно узла открывается шестерёнкой в строке роли" },
                "три вкладки — ⚙ на карточке"),
              h("button", {
                type: "button",
                style: S.button,
                "data-bottom-link": "1",
                disabled: linking || pickedExchange,
                title: pickedExchange
                  ? "папка обмена не соединяется с агентами: её связь с миром — сами сообщения"
                  : (others.length === 0
                    ? "других узлов нет: связь добавить не с кем"
                    : "связь delegate, review, report или peer — с кем и в какую сторону"),
                onClick: () => { setLinkOpen(!linkOpen); setLinkError(null); closeNodeEditor(); setLaunch(null); },
              }, labels[0]),
              h("button", {
                type: "button",
                style: S.button,
                "data-bottom-launch": "1",
                disabled: !node.model || launchBlocked,
                title: launchBlocked
                  ? "запуск заблокирован: в структуре есть ошибки — устраните их, чтобы «Запустить» стала доступна"
                  : (pickedExchange
                    ? "папка обмена — не агент: запускать нечего"
                    : (node.model
                      ? "готовый вызов project_graph_run или project_graph_branch: скопируйте его в чат"
                      : "у узла нет модели: агента запустить не на чем — задайте модель")),
                onClick: () => {
                  setCallCopy("idle");
                  setLaunch(launch ? null : "run");
                  setLinkOpen(false);
                  closeNodeEditor();
                },
              }, labels[1]),
              launchBlocked
                ? h("span", {
                  "data-bottom-blocked": "1",
                  role: "status",
                  style: { color: T.danger, fontSize: 11 },
                  title: "пока в структуре есть ошибки, новые задания не запускаются",
                }, "Запуск заблокирован: " + validatorSummary(validationNow) + " — «Запустить» недоступна")
                : null),
            launch
              ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" } },
                h("div", { style: S.hint },
                  "Ручной запуск панель не выполняет: вызов выполняет модель в чате. Узлы с расписанием хост "
                  + "запускает сам по времени. Скопируйте вызов и отправьте как задание — маршрут возьмётся "
                  + "из объявления узла, а не из этого экрана."),
                h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
                  h("span", { style: S.label }, "что запускаем"),
                  h("select", {
                    style: S.select,
                    "aria-label": "что запускаем",
                    value: launch,
                    onChange: (event) => { setCallCopy("idle"); setLaunch(event.target.value); },
                  },
                    h("option", { value: "run" }, "узел — project_graph_run"),
                    h("option", { value: "branch" }, "ветку — project_graph_branch"))),
                launch === "branch"
                  ? h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
                    h("span", { style: S.label }, "глубина"),
                    h("select", {
                      style: S.select,
                      "aria-label": "глубина ветки",
                      value: launchDepth,
                      onChange: (event) => setLaunchDepth(Number(event.target.value)),
                    }, [1, 2, 3, 4, 5].map((value) => h("option", { key: value, value }, String(value)))),
                    h("span", { style: S.label }, "параллельно"),
                    h("select", {
                      style: S.select,
                      "aria-label": "параллельность ветки",
                      value: launchParallelism,
                      onChange: (event) => setLaunchParallelism(Number(event.target.value)),
                    }, [1, 2, 4, 6, 8, 10, 16].map((value) => h("option", { key: value, value }, String(value)))))
                  : null,
                h("pre", { style: { ...S.mono, margin: 0, whiteSpace: "pre-wrap" } }, launchCall()),
                h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
                  h("button", { type: "button", style: S.buttonPrimary, onClick: copyLaunchCall },
                    callCopy === "done" ? "Скопировано" : "Скопировать вызов"),
                  h("button", { type: "button", style: S.button, onClick: () => { setLaunch(null); setCallCopy("idle"); } }, "Закрыть"),
                  callCopy === "manual"
                    ? h("span", { style: S.hint }, "буфер обмена недоступен — выделите текст вызова выше")
                    : null))
              : null,
            !pickedExchange && linkOpen && others.length > 0
              ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" } },
                h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" } },
                  h("select", { style: S.select, value: linkKind, onChange: (event) => setLinkKind(event.target.value) },
                    h("option", { value: "delegate" }, "delegate — поручение"),
                    h("option", { value: "review" }, "review — проверка"),
                    h("option", { value: "report" }, "report — возврат"),
                    h("option", { value: "peer" }, "peer — равные")),
                  linkKind === "peer"
                    ? null
                    : h("select", { style: S.select, value: linkDirection, onChange: (event) => setLinkDirection(event.target.value) },
                      h("option", { value: "from" }, "от этого узла"),
                      h("option", { value: "to" }, "к этому узлу")),
                  h("select", { style: S.select, value: targetId, onChange: (event) => setLinkTarget(event.target.value) },
                    others.map((item) => h("option", { key: item.id, value: item.id },
                      item.id
                      + (item.role ? " · " + item.role : "")
                      + (item.model ? " · " + item.model : " · без модели")))),
                  h("button", { type: "button", style: S.buttonPrimary, disabled: linking || !targetId, onClick: () => submitLink(targetId) },
                    linking ? "Сохраняю…" : "Добавить"),
                  h("button", { type: "button", style: S.button, onClick: () => { setLinkOpen(false); setLinkError(null); } }, "Отмена")),
                h("div", { style: S.hint },
                  linkMeaning(linkKind, linkDirection, targetId)
                  + ". Внутри одного файла связь пишется в него, между блоками — в links.json."))
              : null,
            linkError
              ? h("div", { style: S.error },
                h("div", null, "Не удалось изменить связь: " + linkError.message),
                h("div", { style: S.fix }, "Что сделать: " + linkError.fix))
              : null,
            !pickedExchange && others.length === 0
              ? h("div", { style: S.hint }, "Других узлов нет: связь добавить не с кем. Узлы создаются в structure/*.json.")
              : null,
          );
        }

        /* Leaving the builder must never strand a person on that screen. */
        function closeBuilder() {
          setBuilder(null);
          setBuilderError(null);
          setBuilderCheck(null);
        }

        function openAddNode() {
          setNewNode({ id: "", role: "", model: "", brief: "" });
          setNewNodeError(null);
        }

        function submitAddNode() {
          if (newNodeBusy) return;
          const draft = newNode || {};
          if (!String(draft.id || "").trim()) {
            setNewNodeError({ message: "у узла нет id", fix: "Задайте id: worker, judge, code.lead — латиница, цифры, точка, дефис." });
            return;
          }
          setNewNodeBusy(true);
          setNewNodeError(null);
          fetchJson("/api/node?root=" + encodeURIComponent(root), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(draft),
          })
            .then(() => {
              setNewNode(null);
              return load(root, false);
            })
            .catch((failure) => setNewNodeError({
              message: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Проверьте id и модель, затем попробуйте снова.",
            }))
            .finally(() => setNewNodeBusy(false));
        }

        /**
         * Живой каталог провайдеров и моделей. Читается при каждом открытии
         * редактора или сборки: список моделей — факт рантайма на момент вопроса,
         * а не запомненный ответ. Отказ службы не прячется — он виден человеку.
         */
        function refreshModelCatalog() {
          setAvailableModels(null);
          setModelsError(null);
          return fetchJson("/api/models")
            .then((body) => {
              const providers = (body && body.providers) || [];
              if (body && body.ok === false) {
                setAvailableModels([]);
                setModelsError({
                  message: body.error || "список моделей недоступен",
                  fix: body.fix || "Проверьте, что плагин LLM загружен, и повторите.",
                });
                return [];
              }
              /*
               * Провайдер и модель не выбираются за человека: пустое поле — это
               * вопрос, а не повод взять первую модель каталога. Выбор остаётся
               * за пользователем, и сохранение без него — отказ с рецептом.
               */
              setAvailableModels(providers);
              return providers;
            })
            .catch((failure) => {
              setAvailableModels([]);
              setModelsError({
                message: failure && failure.message ? failure.message : String(failure),
                fix: (failure && failure.fix) || "Проверьте, что плагин LLM загружен, и повторите.",
              });
              return [];
            });
        }

        function openBuilder() {
          const graph = (payload && payload.graph) || { models: {}, nodes: [], edges: [] };
          const models = {};
          for (const [alias, route] of Object.entries(graph.models || {})) {
            models[alias] = { provider: route.provider, model: route.model, ...(route.family ? { family: route.family } : {}) };
          }
          setBuilder({
            version: 1,
            models,
            nodes: (graph.nodes || []).map((node) => ({
              id: node.id, role: node.role || "", model: node.model || "", brief: node.brief || "", agentPreset: node.agentPreset || undefined,
            })),
            edges: (graph.edges || []).map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
          });
          setBuilderCheck(null);
          setBuilderError(null);
          setNodeForm({ id: "", role: "", model: "", brief: "", agentPreset: "" });
          setModelForm({ alias: "", provider: "", model: "", family: "" });
          setEditingNodeId(null);
          setEditingModelAlias(null);
          setAvailableModels(null);
          setModelsError(null);
          setAvailablePresets(null);
          setPresetsError(null);
          setEdgeForm({
            from: (graph.nodes[0] && graph.nodes[0].id) || "",
            to: (graph.nodes[1] && graph.nodes[1].id) || "",
            kind: "delegate",
          });
          refreshModelCatalog();
          fetchJson("/api/presets")
            .then((body) => {
              const presets = (body && body.presets) || [];
              setAvailablePresets(presets);
              if (body && body.ok === false) {
                setPresetsError({ message: body.error || "список пресетов недоступен", fix: body.fix || "Введите id пресета вручную." });
              }
            })
            .catch((failure) => {
              setAvailablePresets([]);
              setPresetsError({ message: failure && failure.message ? failure.message : String(failure), fix: (failure && failure.fix) || "Введите id пресета вручную." });
            });
        }

        function patchBuilder(mutator) {
          setBuilder((current) => {
            if (!current) return current;
            const next = {
              version: 1,
              models: { ...current.models },
              nodes: current.nodes.map((node) => ({ ...node })),
              edges: current.edges.map((edge) => ({ ...edge })),
            };
            mutator(next);
            return next;
          });
          setBuilderCheck(null);
          setBuilderError(null);
        }

        function saveBuilderModel() {
          const editing = editingModelAlias;
          const alias = (editing || modelForm.alias.trim()).trim();
          if (!alias || /\s/u.test(alias)) {
            setBuilderError({ message: "алиас модели не может быть пустым или содержать пробелы", fix: "Например, work или critic." });
            return;
          }
          /*
           * Никаких молчаливых дефолтов: пустые поля — отказ «выберите модель из
           * списка», а пара, которой нет в каталоге, — отказ «модель не найдена в
           * каталоге». Подставить первую доступную вместо объявленной нельзя.
           */
          const draft = builderModelDraft(modelForm, availableModels);
          if (draft.error) {
            setBuilderError(draft.error);
            return;
          }
          if (!editing && builder.models[alias]) {
            setBuilderError({ message: "модель «" + alias + "» уже объявлена", fix: "Выберите другой алиас или удалите старую модель." });
            return;
          }
          patchBuilder((next) => {
            next.models[alias] = draft.family
              ? { provider: draft.provider, model: draft.model, family: draft.family }
              : { provider: draft.provider, model: draft.model };
          });
          setEditingModelAlias(null);
          setModelForm({ alias: "", provider: "", model: "", family: "" });
        }

        function editBuilderModel(alias) {
          const route = builder.models[alias];
          if (!route) return;
          setEditingModelAlias(alias);
          setModelForm({ alias, provider: route.provider, model: route.model, family: route.family || "" });
          setBuilderError(null);
        }

        function cancelBuilderModel() {
          setEditingModelAlias(null);
          setModelForm({ alias: "", provider: "", model: "", family: "" });
          setBuilderError(null);
        }

        function removeBuilderModel(alias) {
          if (builder.nodes.some((node) => node.model === alias)) {
            setBuilderError({ message: "модель «" + alias + "» используется узлами", fix: "Сначала смените модель у этих узлов." });
            return;
          }
          if (editingModelAlias === alias) cancelBuilderModel();
          patchBuilder((next) => { delete next.models[alias]; });
        }

        function saveBuilderNode() {
          const editing = editingNodeId;
          const id = nodeForm.id.trim();
          if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
            setBuilderError({ message: "id узла: строчные латинские буквы, цифры, точка, дефис или подчёркивание", fix: "Например, coordinator, code.lead, judge-2." });
            return;
          }
          if (builder.nodes.some((node) => node.id === id && node.id !== editing)) {
            setBuilderError({ message: "узел «" + id + "» уже есть", fix: "Выберите другой id." });
            return;
          }
          patchBuilder((next) => {
            if (editing) {
              const node = next.nodes.find((item) => item.id === editing);
              if (!node) return;
              node.id = id;
              node.role = nodeForm.role.trim();
              node.model = nodeForm.model;
              node.brief = nodeForm.brief.trim();
              node.agentPreset = nodeForm.agentPreset.trim() || undefined;
              if (id !== editing) {
                for (const edge of next.edges) {
                  if (edge.from === editing) edge.from = id;
                  if (edge.to === editing) edge.to = id;
                }
              }
              return;
            }
            next.nodes.push({ id, role: nodeForm.role.trim(), model: nodeForm.model, brief: nodeForm.brief.trim(), agentPreset: nodeForm.agentPreset.trim() || undefined });
          });
          if (!editing) {
            setEdgeForm((form) => {
              const ids = [...builder.nodes.map((node) => node.id), id];
              const from = form.from && ids.includes(form.from) ? form.from : (ids[0] || "");
              const to = form.to && ids.includes(form.to) ? form.to : (ids.find((item) => item !== from) || "");
              return { ...form, from, to };
            });
          } else if (editing !== id) {
            setEdgeForm((form) => ({
              ...form,
              from: form.from === editing ? id : form.from,
              to: form.to === editing ? id : form.to,
            }));
          }
          setEditingNodeId(null);
          setNodeForm({ id: "", role: "", model: "", brief: "", agentPreset: "" });
        }

        function editBuilderNode(node) {
          setEditingNodeId(node.id);
          setNodeForm({ id: node.id, role: node.role || "", model: node.model || "", brief: node.brief || "", agentPreset: node.agentPreset || "" });
          setBuilderError(null);
        }

        function cancelBuilderNode() {
          setEditingNodeId(null);
          setNodeForm({ id: "", role: "", model: "", brief: "", agentPreset: "" });
          setBuilderError(null);
        }

        function removeBuilderNode(id) {
          if (editingNodeId === id) cancelBuilderNode();
          patchBuilder((next) => {
            next.nodes = next.nodes.filter((node) => node.id !== id);
            next.edges = next.edges.filter((edge) => edge.from !== id && edge.to !== id);
          });
        }

        function addBuilderEdge() {
          /*
           * The selects fall back to the first two ids when the form state is
           * still empty; without the same fallback the visible "coordinator"
           * was not actually submitted.
           */
          const ids = builder.nodes.map((node) => node.id);
          const from = edgeForm.from && ids.includes(edgeForm.from) ? edgeForm.from : (ids[0] || "");
          const to = edgeForm.to && ids.includes(edgeForm.to) ? edgeForm.to : (ids.find((item) => item !== from) || "");
          if (!from || !to || from === to) {
            setBuilderError({ message: "для связи нужны два разных узла", fix: "Выберите from и to." });
            return;
          }
          if (builder.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === edgeForm.kind)) {
            setBuilderError({ message: "такая связь уже есть", fix: "Выберите другой вид или другого узла." });
            return;
          }
          patchBuilder((next) => { next.edges.push({ from, to, kind: edgeForm.kind }); });
          setEdgeForm({ ...edgeForm, from: "", to: "" });
        }

        function removeBuilderEdge(index) {
          patchBuilder((next) => { next.edges.splice(index, 1); });
        }

        function runBuilderCheck() {
          if (builderBusy) return;
          setBuilderBusy(true);
          setBuilderError(null);
          fetchJson("/api/check?root=" + encodeURIComponent(root), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(builderDraft(builder)),
          })
            .then((result) => setBuilderCheck(result))
            .catch((failure) => setBuilderError({
              message: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Проверьте соединение и повторите.",
            }))
            .finally(() => setBuilderBusy(false));
        }

        function submitBuilder() {
          if (builderBusy) return;
          const overwrite = Boolean(payload && payload.exists);
          if (overwrite && typeof window !== "undefined"
            && !window.confirm("В проекте уже есть структура. Перезаписать structure/graph.json?")) return;
          setBuilderBusy(true);
          setBuilderError(null);
          fetchJson("/api/build?root=" + encodeURIComponent(root) + "&overwrite=" + (overwrite ? "true" : "false"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(builderDraft(builder)),
          })
            .then(() => {
              setBuilder(null);
              setBuilderCheck(null);
              return load(root, false);
            })
            .catch((failure) => setBuilderError({
              message: failure && failure.message ? failure.message : String(failure),
              fix: (failure && failure.fix) || "Исправьте граф и проверьте снова.",
            }))
            .finally(() => setBuilderBusy(false));
        }

        function builderInput(value, onChange, placeholder, width) {
          return h("input", {
            style: { ...S.input, width },
            value,
            placeholder,
            onChange: (event) => onChange(event.target.value),
          });
        }

        function renderBuilderCheck() {
          if (!builderCheck) return null;
          const errors = builderCheck.errors || [];
          const warnings = builderCheck.warnings || [];
          return h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
            h("div", { style: { color: builderCheck.ok ? T.success : T.danger, fontWeight: 600, fontSize: "13px" } },
              builderCheck.ok ? "Проверка пройдена: структуру можно создать" : "Проверка не пройдена — исправьте ошибки"),
            errors.length > 0
              ? h("ul", { style: S.issueList }, errors.map((item, index) =>
                h("li", { key: "be-" + index, style: S.issue },
                  h("div", null, item.message),
                  item.fix ? h("div", { style: S.fix }, "Что сделать: " + item.fix) : null,
                  h("div", { style: S.issueMeta }, item.code || ""))))
              : null,
            warnings.length > 0
              ? h("ul", { style: S.issueList }, warnings.map((item, index) =>
                h("li", { key: "bw-" + index, style: S.issue },
                  h("div", null, "Предупреждение: " + item.message),
                  item.fix ? h("div", { style: S.fix }, "Что сделать: " + item.fix) : null)))
              : null,
            h("div", { style: S.hint },
              "узлов: " + builderCheck.summary.nodes
              + ", связей: " + builderCheck.summary.edges
              + ", слоёв: " + builderCheck.summary.layers));
        }

        function renderBuilder() {
          if (!builder) return null;
          const aliases = Object.keys(builder.models);
          const nodeIds = builder.nodes.map((node) => node.id);
          const edgeFrom = edgeForm.from && nodeIds.includes(edgeForm.from) ? edgeForm.from : (nodeIds[0] || "");
          const edgeTo = edgeForm.to && nodeIds.includes(edgeForm.to) ? edgeForm.to : (nodeIds[1] || "");
          const builderFit = workflowFit(builder);
          const providerOptions = [...(availableModels || [])];
          if (modelForm.provider && !providerOptions.some((item) => item.id === modelForm.provider)) {
            providerOptions.unshift({ id: modelForm.provider, name: modelForm.provider, models: [] });
          }
          /*
           * Выбор только явный: пустое поле не превращается в первую строку
           * списка. Первая модель провайдера — подсказка для человека, а не
           * значение формы: панель не подставляет её молча.
           */
          const selectedProvider = providerOptions.find((item) => item.id === modelForm.provider) || null;
          const modelOptions = selectedProvider && Array.isArray(selectedProvider.models) ? [...selectedProvider.models] : [];
          if (modelForm.model && !modelOptions.some((item) => item.id === modelForm.model)) {
            modelOptions.push({ id: modelForm.model, name: modelForm.model, family: modelForm.family || "" });
          }
          const presetOptions = availablePresets || [];
          const selectedPreset = presetOptions.find((item) => item.id === nodeForm.agentPreset) || null;
          const presetPlugins = selectedPreset && Array.isArray(selectedPreset.plugins) ? selectedPreset.plugins : [];
          const presetDetails = selectedPreset
            ? (selectedPreset.description
              || (presetPlugins.length > 0
                ? "Состав (" + presetPlugins.length + "): "
                  + presetPlugins.slice(0, 5).map((name) => name.replace(/^@deepseek-ai\/dsh-/u, "")).join(", ")
                  + (presetPlugins.length > 5 ? "…" : "")
                : "Описание не объявлено."))
            : "";
          const sectionTitle = (text) => h("div", { style: { fontWeight: 600, fontSize: "12px" } }, text);
          return h("div", { style: { ...S.card, maxWidth: "980px", display: "flex", flexDirection: "column", gap: "10px" } },
            h("div", { style: S.bar },
              h("span", { style: { fontWeight: 600, fontSize: "14px" } }, "Сборка структуры"),
              h("button", { type: "button", style: S.buttonPrimary, disabled: builderBusy, onClick: runBuilderCheck },
                builderBusy ? "Проверяю…" : "Проверить"),
              h("button", { type: "button", style: S.button, disabled: builderBusy || builder.nodes.length === 0, onClick: submitBuilder }, "Создать"),
              h("button", { type: "button", style: S.button, disabled: builderBusy,
                title: "вернуться к схеме; несохранённые правки сборки при этом теряются",
                onClick: closeBuilder }, "← К схеме")),
            h("div", { style: S.hint },
              "Соберите граф из моделей, узлов и связей. «Проверить» сверяет схему, модели в DSH, пресеты и провайдера субагентов; "
              + "«Создать» записывает " + (payload && payload.dir ? payload.dir : "structure") + "/graph.json. "
              + "Вернуться к схеме можно этой же кнопкой «← К схеме» или клавишей Esc; несохранённые правки сборки при этом теряются."),
            builderFit.applicable && (workflow.status === "missing" || builderFit.issues.length > 0)
              ? h("div", { style: S.info },
                h("div", null, workflow.status === "missing"
                  ? "Иерархическая схема: workflow-плагин не установлен."
                  : "Workflow-схема: иерархия неполная."),
                h("div", { style: S.hint },
                  "Workflow даёт доску задач, карточку и политику; агентов он не запускает. "
                  + "Неполнота не блокирует структуру, но гейты ожидают проверку исполнителей."),
                builderFit.issues.length > 0
                  ? h("ul", { style: S.list }, builderFit.issues.map((issue, index) => h("li", { key: "fit-" + index }, issue)))
                  : null,
                h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
                  h("a", { href: WORKFLOW_REPO, target: "_blank", rel: "noreferrer", style: { color: T.link, fontSize: "12px" } }, "Репозиторий"),
                  h("a", { href: WORKFLOW_PLUGIN, target: "_blank", rel: "noreferrer", style: { color: T.link, fontSize: "12px" } }, "Инструкция"),
                  h("button", { type: "button", style: S.button, onClick: () => checkWorkflow() }, "Проверить снова")))
              : null,
            h("div", { style: S.builderSection },
              sectionTitle("Модели"),
              Object.entries(builder.models).map(([alias, route]) => h("div", { key: "m-" + alias, "data-model": alias, style: S.builderRow },
                h("span", { style: S.mono }, alias),
                h("span", null, "→ " + route.provider + "/" + route.model + (route.family ? " · " + route.family : "")),
                h("button", { type: "button", style: S.button, onClick: () => editBuilderModel(alias), title: "изменить provider и model" }, "✎"),
                h("button", { type: "button", style: S.button, onClick: () => removeBuilderModel(alias), title: "удалить модель" }, "×"))),
              h("div", { style: S.builderRow },
                editingModelAlias
                  ? h("input", { style: { ...S.input, width: 80 }, value: modelForm.alias, disabled: true, title: "алиас не меняется: на него ссылаются узлы" })
                  : builderInput(modelForm.alias, (value) => setModelForm({ ...modelForm, alias: value }), "алиас", 80),
                availableModels === null
                  ? h("span", { style: S.hint }, "Загружаю модели…")
                  : providerOptions.length > 0
                    ? [
                      h("select", { key: "prov", style: S.select, "aria-label": "provider", value: modelForm.provider,
                        onChange: (event) => {
                          /*
                           * Смена провайдера сбрасывает модель: подставить первую
                           * модель нового провайдера значило бы заменить выбор
                           * человека молча — ради этого выбора он и открыт.
                           */
                          setModelForm({ ...modelForm, provider: event.target.value, model: "", family: "" });
                        } },
                      h("option", { value: "" }, "выберите провайдера"),
                      providerOptions.map((provider) => h("option", { key: "p-" + provider.id, value: provider.id },
                        provider.id + (provider.name && provider.name !== provider.id ? " — " + provider.name : "")))),
                      h("select", { key: "mod", style: S.select, "aria-label": "модель", value: modelForm.model, disabled: !selectedProvider,
                        onChange: (event) => {
                          const model = modelOptions.find((item) => item.id === event.target.value);
                          setModelForm({ ...modelForm, model: event.target.value, family: model && model.family ? model.family : "" });
                        } },
                      h("option", { value: "" }, "выберите модель из списка"),
                      modelOptions.map((model) => h("option", { key: "mm-" + model.id, value: model.id },
                        model.id + (model.name && model.name !== model.id ? " — " + model.name : "")))),
                      modelForm.family ? h("span", { key: "fam", style: S.hint }, "family: " + modelForm.family) : null,
                    ]
                    : [
                      builderInput(modelForm.provider, (value) => setModelForm({ ...modelForm, provider: value }), "provider", 100),
                      builderInput(modelForm.model, (value) => setModelForm({ ...modelForm, model: value }), "model", 180),
                      builderInput(modelForm.family, (value) => setModelForm({ ...modelForm, family: value }), "family", 110),
                    ],
                h("button", { type: "button", style: S.button, onClick: saveBuilderModel },
                  editingModelAlias ? "Сохранить модель" : "Добавить модель"),
                editingModelAlias
                  ? h("button", { type: "button", style: S.button, onClick: cancelBuilderModel }, "Отмена")
                  : null),
              providerOptions.length === 0 && availableModels !== null
                ? h("div", { style: S.hint },
                  modelsError
                    ? "Список моделей недоступен: " + modelsError.message + ". Введите provider и model вручную."
                    : "Нет доступных моделей: введите provider и model вручную.")
                : null),
            h("div", { style: S.builderSection },
              sectionTitle("Узлы"),
              builder.nodes.map((node) => h("div", { key: "n-" + node.id, "data-node": node.id, style: S.builderRow },
                h("span", { style: { ...S.mono, minWidth: "90px" } }, node.id),
                h("span", null, "· " + (node.role || "роль не задана")),
                h("span", { style: S.hint }, node.model ? "· " + node.model : "· без модели"),
                node.agentPreset ? h("span", { style: S.hint }, "· пресет " + node.agentPreset) : null,
                node.brief ? h("span", { style: S.hint }, "· " + node.brief) : null,
                h("button", { type: "button", style: S.button, onClick: () => editBuilderNode(node), title: "изменить узел" }, "✎"),
                h("button", { type: "button", style: S.button, onClick: () => removeBuilderNode(node.id), title: "удалить узел" }, "×"))),
              h("div", { style: S.builderRow },
                builderInput(nodeForm.id, (value) => setNodeForm({ ...nodeForm, id: value }), "id", 90),
                builderInput(nodeForm.role, (value) => setNodeForm({ ...nodeForm, role: value }), "роль", 100),
                h("select", { style: S.select, "aria-label": "модель узла", value: nodeForm.model, onChange: (event) => setNodeForm({ ...nodeForm, model: event.target.value }) },
                  h("option", { value: "" }, "без модели"),
                  aliases.map((alias) => h("option", { key: "na-" + alias, value: alias }, alias))),
                availablePresets === null
                  ? h("span", { style: S.hint }, "Загружаю пресеты…")
                  : presetOptions.length > 0
                    ? h("select", { style: S.select, "aria-label": "пресет", value: nodeForm.agentPreset,
                      onChange: (event) => setNodeForm({ ...nodeForm, agentPreset: event.target.value }) },
                    h("option", { value: "" }, "без пресета — наследует родителя"),
                    presetOptions.map((preset) => h("option", { key: "pr-" + preset.id, value: preset.id },
                      preset.id + (preset.name ? " — " + preset.name : "") + (preset.broken ? " ⚠" : ""))),
                    nodeForm.agentPreset && !presetOptions.some((preset) => preset.id === nodeForm.agentPreset)
                      ? h("option", { key: "pr-unknown", value: nodeForm.agentPreset }, nodeForm.agentPreset + " (нет в DSH)")
                      : null)
                    : builderInput(nodeForm.agentPreset, (value) => setNodeForm({ ...nodeForm, agentPreset: value }), "пресет", 90),
                builderInput(nodeForm.brief, (value) => setNodeForm({ ...nodeForm, brief: value }), "назначение", 180),
                h("button", { type: "button", style: S.button, onClick: saveBuilderNode },
                  editingNodeId ? "Сохранить узел" : "Добавить узел"),
                editingNodeId
                  ? h("button", { type: "button", style: S.button, onClick: cancelBuilderNode }, "Отмена")
                  : null),
              h("div", { style: S.hint },
                "Пресет — это состав агента: персона, набор инструментов и модель по умолчанию. "
                + "Без пресета узел наследует пресет родителя."
                + (selectedPreset
                  ? " Выбран «" + selectedPreset.id + "»"
                    + (selectedPreset.name ? " (" + selectedPreset.name + ")" : "")
                    + (presetDetails ? ": " + presetDetails : ".")
                  : "")
                + (presetsError ? " Список пресетов недоступен: " + presetsError.message + "." : ""))),
            h("div", { style: S.builderSection },
              sectionTitle("Связи"),
              builder.edges.map((edge, index) => h("div", { key: "e-" + index, style: S.builderRow },
                h("span", { style: S.mono }, edge.from + " → " + edge.to),
                h("span", null, "· " + edge.kind),
                h("button", { type: "button", style: S.button, onClick: () => removeBuilderEdge(index), title: "удалить связь" }, "×"))),
              h("div", { style: S.builderRow },
                h("select", { style: S.select, "aria-label": "from", value: edgeFrom, onChange: (event) => setEdgeForm({ ...edgeForm, from: event.target.value }) },
                  nodeIds.map((id) => h("option", { key: "ef-" + id, value: id }, id))),
                h("span", null, "→"),
                h("select", { style: S.select, "aria-label": "to", value: edgeTo, onChange: (event) => setEdgeForm({ ...edgeForm, to: event.target.value }) },
                  nodeIds.map((id) => h("option", { key: "et-" + id, value: id }, id))),
                h("select", { style: S.select, "aria-label": "kind", value: edgeForm.kind, onChange: (event) => setEdgeForm({ ...edgeForm, kind: event.target.value }) },
                  h("option", { value: "delegate" }, "delegate"),
                  h("option", { value: "review" }, "review"),
                  h("option", { value: "report" }, "report"),
                  h("option", { value: "peer" }, "peer")),
                h("button", { type: "button", style: S.button, onClick: addBuilderEdge }, "Добавить связь"))),
            renderBuilderCheck(),
            builderError
              ? h("div", { style: S.error },
                h("div", null, "Сборка: " + builderError.message),
                h("div", { style: S.fix }, "Что сделать: " + builderError.fix))
              : null);
        }

        /* The quick add: one node, right on the structure screen. */
        function renderAddNode() {
          if (!newNode) return null;
          const aliases = Object.keys((payload && payload.graph && payload.graph.models) || {});
          return h("div", { style: { ...S.card, display: "flex", flexDirection: "column", gap: "8px" } },
            h("div", { style: { fontWeight: 600, fontSize: "13px" } }, "Новый узел"),
            h("div", { style: S.hint },
              "Узел запишется в " + (payload && payload.dir ? payload.dir : "structure") + "/*.json сразу — в сборку заходить не нужно. "
              + "Модель выбирается из объявленных: от неё зависит, на чём пойдёт агент; без модели узел описан, но не запускается."),
            h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
              h("input", {
                style: { ...S.input, width: "150px" },
                placeholder: "id",
                "aria-label": "id узла",
                value: newNode.id,
                onChange: (event) => setNewNode({ ...newNode, id: event.target.value }),
              }),
              h("input", {
                style: { ...S.input, width: "170px" },
                placeholder: "роль",
                "aria-label": "роль узла",
                value: newNode.role,
                onChange: (event) => setNewNode({ ...newNode, role: event.target.value }),
              }),
              h("select", {
                style: { ...S.select, width: "170px" },
                "aria-label": "модель узла",
                value: newNode.model,
                onChange: (event) => setNewNode({ ...newNode, model: event.target.value }),
              },
                h("option", { value: "" }, "без модели"),
                aliases.map((alias) => h("option", { key: alias, value: alias }, alias))),
              h("input", {
                style: { ...S.input, width: "260px" },
                placeholder: "назначение (brief)",
                "aria-label": "назначение узла",
                value: newNode.brief,
                onChange: (event) => setNewNode({ ...newNode, brief: event.target.value }),
              })),
            newNodeError
              ? h("div", { style: S.error },
                h("div", null, "Не удалось добавить узел: " + newNodeError.message),
                h("div", { style: S.fix }, "Что сделать: " + newNodeError.fix))
              : null,
            h("div", { style: { display: "flex", gap: "8px" } },
              h("button", { type: "button", style: S.buttonPrimary, disabled: newNodeBusy, onClick: submitAddNode },
                newNodeBusy ? "Добавляю…" : "Добавить"),
              h("button", { type: "button", style: S.button, onClick: () => { setNewNode(null); setNewNodeError(null); } }, "Отмена")));
        }

        function renderWorkflowFit() {
          if (!payload || !payload.exists) return null;
          const fit = workflowFit(payload.graph);
          if (!fit.applicable || fit.issues.length === 0) return null;
          return h("div", { style: S.info },
            h("div", { style: { fontWeight: 600 } }, "Workflow-схема: иерархия неполная"),
            h("ul", { style: S.list }, fit.issues.map((issue, index) => h("li", { key: "panel-fit-" + index }, issue))),
            h("div", { style: S.hint },
              "Это не ошибка структуры: запуск и связи работают. "
              + "Workflow-гейты ожидают, что каждый исполнитель проверяется оценщиком."));
        }

        /*
         * Счётчик непрочитанных в заголовке панели (задание 0082): человек
         * видит число, не открывая ящик. Источник — поле unread ответа
         * /api/exchange; пока сервер его не прислал, подписи нет.
         */
        function renderUnreadChip() {
          const total = unreadTotal(exchange);
          if (total === null) return null;
          return h("span", {
            style: {
              ...S.chip,
              fontWeight: 600,
              color: total > 0 ? T.danger : T.secondary,
              border: "1px solid " + (total > 0 ? T.danger : T.border2),
            },
            "data-panel-unread": String(total),
            title: "непрочитанных писем обмена: " + total + ". Счёт — scanExchange на сервере: чтобы увидеть число, ящик открывать не нужно",
          }, unreadLabel(total));
        }

        /*
         * Плашка обязанностей (задание 0077): вверху панели, над канвой.
         * Кнопка зовёт скан обмена и показывает число непрочитанных — долг
         * перестаёт быть обещанием и становится числом.
         */
        function renderObligationsBanner() {
          if (!obligationsBanner) return null;
          const text = "Обязанности не выполнены: " + obligationsBanner.id
            + (obligationsBanner.detail ? " — " + obligationsBanner.detail : "");
          const checkBoxes = () => {
            if (!root || exchangeScanBusy) return;
            setExchangeScanBusy(true);
            fetchJson("/api/exchange/scan?root=" + encodeURIComponent(root))
              .then((body) => {
                if (body && body.ok === false) {
                  setExchangeScanNote("скан не прочитан: " + (body.error || body.code || "ошибка"));
                  return;
                }
                const unread = body && Array.isArray(body.unread) ? body.unread.length : 0;
                setExchangeScanNote("непрочитано: " + unread);
              })
              .catch((failure) => setExchangeScanNote("скан не ответил: "
                + (failure && failure.message ? failure.message : String(failure))))
              .finally(() => setExchangeScanBusy(false));
          };
          return h("div", { "data-obligations-banner": "1", style: S.banner, role: "status" },
            h("span", { style: S.bannerText }, text),
            h("button", {
              type: "button",
              "data-check-exchange": "1",
              style: S.button,
              disabled: exchangeScanBusy,
              title: "прочитать объявленные ящики обмена и показать, сколько писем этому воркспейсу не разобрано",
              onClick: checkBoxes,
            }, exchangeScanBusy ? "Проверяю…" : "Проверить ящики"),
            exchangeScanNote ? h("span", { "data-exchange-scan-note": "1", style: S.mono }, exchangeScanNote) : null);
        }

        function renderSources() {
          if (!payload || !payload.sources || payload.sources.length === 0) return null;
          return h("div", { style: S.mono },
            "фрагменты: " + payload.sources.map((source) => source.file + " (" + source.nodes + " узлов, " + source.edges + " связей)").join("; "));
        }

        /*
         * Защита от пустого экрана: исключение в отрисовке гасит панель целиком,
         * и пользователь видит пустоту вместо структуры. Ловим и показываем текст.
         */
        let body;
        try {
        if (!payload && !error && projects.length === 0 && !busy) {
          body = h("div", { style: S.info },
            "Панель пока не знает ни одного проекта. Добавьте абсолютный путь проекта в roots (cordis.patch.yml) и перезагрузите плагин.");
        } else if (error) {
          body = h("div", { style: S.error },
            h("div", { style: S.errorTitle }, "Панель не смогла прочитать структуру"),
            h("div", null, error.message),
            error.fix ? h("div", { style: S.fix }, "Что сделать: " + error.fix) : null);
        } else if (builder) {
          body = renderBuilder();
        } else if (payload && payload.exists === false) {
          body = renderOnboarding(payload);
        } else if (payload) {
          body = h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "10px", minHeight: 0 } },
            renderAddNode(),
            /* Библиотека слева, канва справа: в свёрнутом виде палитра не перекрывает схему. */
            h("div", { style: { display: "flex", gap: "10px", alignItems: "stretch", flex: "0 0 auto", minWidth: 0 } },
              renderLibrary(),
              h("div", { style: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: "10px", minHeight: 0 } },
                renderEnforcement(),
                renderCanvas(),
                renderCarryHint(),
                renderLayoutError(),
                renderLayoutNotice(),
                renderLayoutHint())),
            renderLibraryNote(),
            renderExchange(),
            renderLegend(),
            h("div", { style: S.panel }, renderDetails()),
            renderWorkflowFit(),
            renderIssues(),
            renderSources(),
          );
        } else {
          body = h("div", { style: S.hint }, busy ? "Чтение структуры…" : "Нет данных: нажмите «Обновить».");
        }
        } catch (panelError) {
          body = h("div", { style: S.error },
            h("div", { style: S.errorTitle }, "Панель не смогла отрисовать структуру"),
            h("div", null, String((panelError && panelError.message) || panelError)),
            h("div", { style: S.fix },
              "Что сделать: нажмите «Обновить». Если повторяется — пришлите этот текст, структура на диске цела."));
        }

        return h(
          "div",
          { style: S.root },
          h("div", { style: S.bar },
            h("span", { style: S.title }, "Структура проекта"),
            h("span", { style: S.chip, title: "структуру панель читает, связи правит, стартовую создаёт по кнопке" }, "структура"),
            renderUnreadChip(),
            h("span", {
              "data-client-build": CLIENT_BUILD,
              style: S.chip,
              title: "сборка панели, которая загружена в браузере. Если после перезапуска DSH метка старая — браузер держит файл: нажмите Ctrl+Shift+R",
            }, "сборка " + CLIENT_BUILD),
            h("button", { type: "button", style: S.button, onClick: () => load(root), disabled: busy }, busy ? "…" : "Обновить"),
            builder
              ? h("button", {
                type: "button",
                style: S.buttonPrimary,
                title: "вернуться к схеме; несохранённые правки сборки при этом теряются",
                onClick: closeBuilder,
              }, "← К схеме")
              : h("button", { type: "button", style: S.button, onClick: openBuilder, disabled: busy || !payload || !payload.exists }, "Собрать"),
            payload && payload.exists && !builder
              ? h("button", {
                type: "button",
                style: S.button,
                title: "добавить один узел прямо в структуру, без сборки",
                onClick: openAddNode,
              }, "Добавить узел")
              : null,
            ),
          /* Обязанности структуры — первой строкой под заголовком панели. */
          renderObligationsBanner(),
          /*
           * aria-live: координаты после каждой стрелки и итог сохранения
           * объявляются словами, а не только двигают картинку.
           */
          h("div", {
            role: "status",
            "aria-live": "polite",
            "aria-atomic": "true",
            style: {
              position: "absolute", width: 1, height: 1, margin: -1, padding: 0,
              overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
            },
          }, live),
          note ? h("div", { style: S.info }, note.text) : null,
          renderProjects(),

          !builder ? renderLiveUnknown() : null,
          /* Workflow has its own strip: install, update and re-check live here. */
          payload && payload.exists && !builder ? renderWorkflowStrip() : null,
          /* Версия структуры: текущая и доступная в репозитории (задание 0105). */
          !builder ? renderReleaseStrip() : null,
          /* Тело панели под границей ошибок: исключение сверки не гасит окно целиком. */
          h(RenderGuard, { onRetry: () => load(root) }, body),
          /*
           * Окна живут на уровне вида, а не внутри прокручиваемой канвы:
           * окно по центру не обрезается прокруткой (0143: правого меню нет).
           */
          renderNodeInfo(),
          /* Окно блока валидатора: вход — выступ или его шестерёнка. */
          renderValidatorWindow(payload, validatorOpen, () => setValidatorOpen(false)),
          renderFolderEditor(),
          renderFolderDeleteConfirm(),
          /* Подтверждение удаления узла живёт внутри окна: затемняет только тело. */
          renderCloseConfirm(),
          /* Призрак выноса живёт поверх панели и не ловит события мыши. */
          renderLibraryGhost(),
        );
      };
    }

    function apply(ctx) {
      let workspaceService = null;
      if (typeof ctx.inject === "function") {
        try {
          ctx.inject(["uiWorkspace"], (scope) => {
            workspaceService = (scope && scope.uiWorkspace) || null;
          });
        } catch {
          /* the client may run without the optional workspace service */
        }
      }
      const readWorkspace = () => {
        if (workspaceService) return workspaceService;
        try {
          return ctx.get ? ctx.get("uiWorkspace") : null;
        } catch {
          return null;
        }
      };
      const View = createView(readWorkspace);
      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          { name: "conversation.view", id: VIEW_ID, order: ORDER, label: () => VIEW_LABEL },
          View,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.__workflowFit = workflowFit;
    exports.__nodeState = nodeState;
    exports.__stateSentence = stateSentence;
    exports.__keyboardMove = keyboardMove;
    exports.__edgeSegments = edgeSegments;
    exports.__nearestAnchor = nearestAnchor;
    exports.__liveView = liveView;
    exports.__enforcementView = enforcementView;
    exports.__activitySources = activitySources;
    exports.__bindingView = bindingView;
    exports.__portalRows = portalRows;
    exports.__portalLatest = portalLatest;
    exports.__exchangeFolders = exchangeFolders;
    exports.__folderStateWord = folderStateWord;
    exports.__folderSides = folderSides;
    /* Кнопка «Принять папку» (задание 0047): чистые функции действия и подписи. */
    exports.__folderAcceptAction = folderAcceptAction;
    exports.__folderAcceptPath = folderAcceptPath;
    exports.__folderAcceptNote = folderAcceptNote;
    exports.__folderCounters = folderCounters;
    exports.__folderPortalLines = folderPortalLines;
    exports.__folderPortalHeight = folderPortalHeight;
    exports.__portalStart = portalStart;
    exports.__portalLineD = __portalLineD;
    exports.__portalCount = portalCount;
    exports.__wrapWords = wrapWords;
    exports.__libraryEdge = libraryEdge;
    exports.__libraryStartPoint = libraryStartPoint;
    exports.__libraryItem = libraryItem;
    /* Карточки ролей и узел из карточки: спека, счётчик (задание 0119). */
    exports.__libraryItems = libraryItems;
    /* Виды узлов палитры (задание 0177): аудитор задач — вид узла, не карточка. */
    exports.__nodeKinds = nodeKinds;
    exports.__libraryNode = libraryNode;
    exports.__libraryNodeDraft = libraryNodeDraft;
    /* Карточка (0126): подпись над плиткой и полная подсказка — чистые функции. */
    exports.__libraryCardParts = libraryCardParts;
    exports.__libraryHoverText = libraryHoverText;
    /* Рекомендованная модель → полный маршрут provider+model из каталога. */
    exports.__libraryModelRoute = libraryModelRoute;
    exports.__libraryCountLabel = libraryCountLabel;
    exports.__folderEditorDraft = folderEditorDraft;
    exports.__folderDraftFromPortal = folderDraftFromPortal;
    exports.__modelRouteView = modelRouteView;
    exports.__nodeModelView = nodeModelView;
    exports.__builderModelDraft = builderModelDraft;
    exports.__builderNodeRoute = builderNodeRoute;
    exports.__builderDraft = builderDraft;
    /* Выбор модели узла в карточке: прямой пары из живого каталога (0050). */
    exports.__nodeModelChoice = nodeModelChoice;
    exports.__isCoordinatorNode = isCoordinatorNode;
    exports.__coordinatorCard = coordinatorCard;
    exports.__POPOVER_SAFE_TOP = POPOVER_SAFE_TOP;
    exports.__POPOVER_SAFE_RIGHT = POPOVER_SAFE_RIGHT;
    exports.__toggleFolderEditor = toggleFolderEditor;
    exports.__reopenFolderEditor = reopenFolderEditor;
    /* Проверяемые имена чистых переключателей редактора папки. */
    exports.__folderEditorToggle = toggleFolderEditor;
    exports.__folderEditorOpen = reopenFolderEditor;
    exports.__clampPopover = clampPopover;
    exports.__folderBody = folderBody;
    exports.__libraryFolderDraft = libraryFolderDraft;
    exports.__folderParticipantLabels = folderParticipantLabels;
    /* Реестр воркспейсов и поиск по нему — чистые функции, проверяются без DOM. */
    exports.__registryWorkspaces = registryWorkspaces;
    exports.__filterWorkspaces = filterWorkspaces;
    /* Подпись участника — «метка (имя каталога)» (задание 0029). */
    exports.__participantLabel = participantLabel;
    exports.__workspaceName = workspaceName;
    exports.__registryEntry = registryEntry;
    exports.__similarWorkspaces = similarWorkspaces;
    exports.__participantRows = participantRows;
    exports.__splitList = splitList;
    exports.__isExchangeRole = isExchangeRole;
    exports.__isFolderNode = isFolderNode;
    /*
     * 0143, вариант C: шестерёнка узла и папки, бейдж участников и счётчик
     * палитры — чистые функции, проверяются без браузера.
     */
    exports.__nodeGear = nodeGear;
    exports.__folderGear = folderGear;
    exports.__folderParticipantsBadge = folderParticipantsBadge;
    exports.__paletteCounterVisible = paletteCounterVisible;
    exports.__editorDraftChanged = editorDraftChanged;
    /* Граница ошибок отрисовки: проверяется исполнением, а не чтением. */
    exports.__RenderGuard = RenderGuard;
    exports.__changedEditorFields = changedEditorFields;
    /* Окно узла (задание 0122): вкладки, паспорт, состояние, низ и меню — без DOM. */
    exports.__nodeTabs = nodeTabs;
    exports.__nodeFormFields = nodeFormFields;
    exports.__nodePassportRows = nodePassportRows;
    exports.__nodeStateRows = nodeStateRows;
    exports.__bottomBarItems = bottomBarItems;
    exports.__nodeMenuLabels = nodeMenuLabels;
    /* Окно узла (0129): фиксированный размер и прокрутка тела вкладки — без DOM. */
    exports.__nodeModalSize = nodeModalSize;
    exports.__nodeBodyStyle = nodeBodyStyle;
    /* 0160: раскладка «Настроек», линейка действий и границы затемнения. */
    exports.__settingsLayout = settingsLayout;
    exports.__settingsActions = settingsActions;
    exports.__deleteConfirmInsets = deleteConfirmInsets;
    exports.__settingsBodyStyle = settingsBodyStyle;
    exports.__settingsBodySlotStyle = settingsBodySlotStyle;
    exports.__settingsFooterStyle = settingsFooterStyle;
    exports.__settingsFooterState = settingsFooterState;
    exports.__validatorFindingsCount = validatorFindingsCount;
    /* 0162: выступ валидатора — модель вкладки, сводка и блокировка запуска. */
    exports.__validatorTab = validatorTab;
    /* 0184: состояние вкладки (ok|warn|error|empty) и сдвиг рёбер за вкладку. */
    exports.__validatorState = validatorState;
    exports.__validatorStateText = validatorStateText;
    exports.__validatorChipText = validatorChipText;
    exports.__validatorEdgeOffset = validatorEdgeOffset;
    exports.__validatorAnchor = validatorAnchor;
    exports.__validatorEdge = validatorEdge;
    exports.__validatorSummary = validatorSummary;
    exports.__validatorBlocked = validatorBlocked;
    exports.__validatorFindings = validatorFindings;
    exports.__validatorFindingLine = validatorFindingLine;
    /* Подписи диалога крестика — чистая функция, проверяется без DOM. */
    exports.__closeConfirmView = closeConfirmView;
    /*
     * Корешок и барьер проверяются без DOM: числа макета, зажим просвета,
     * правило колонок и разбор состояния из хранилища — чистые функции,
     * и панель пользуется ими же, а не только проверка (задание 0097).
     */
    /*
     * Счётчик непрочитанных (задание 0082): подпись и разбор поля unread
     * ответа /api/exchange. Панель пользуется ими же — проверка без DOM.
     */
    exports.__unreadLabel = unreadLabel;
    exports.__unreadTotal = unreadTotal;
    /*
     * Окно 14 суток и закрытие заявки ack-письмом (задание 0128): подпись
     * просроченных и тело письма — чистые функции, проверяются без DOM.
     */
    exports.__staleLabel = staleLabel;
    exports.__closeAck = closeAck;
    /* Подпись версии структуры (задание 0105) — чистая функция, проверяется без DOM. */
    exports.__releaseLabel = releaseLabel;
    /* Действие карточки версии по режиму установки (задание 0107). */
    exports.__releaseAction = releaseAction;
    exports.__palette = {
      SPINE_WIDTH,
      SPINE_LABEL,
      SPINE_ICON,
      OUTSIDE_MIN,
      OUTSIDE_MAX,
      OUTSIDE_STEP,
      UI_STORAGE_KEY,
      TWO_COLUMNS_NEED,
      TWO_COLUMNS_HYSTERESIS,
      PORTAL_COLUMN_GUTTER,
      clampOutside,
      portalColumns,
      outsideZoneWidth,
      spineIcons,
      parseUiState,
    };
    return module.exports;
  },
});
