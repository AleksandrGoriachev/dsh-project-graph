#!/usr/bin/env node
/**
 * Панель проверяется ИСПОЛНЕНИЕМ, а не чтением исходника.
 *
 * Здесь поднимается настоящий React и настоящий DOM (jsdom), панель рендерится
 * из lib/client.js, а действия делаются кликами по кнопкам: удалить папку,
 * сохранить папку, уведомить участников. Так ловится то, чего не видят проверки по
 * тексту: исключение при перерисовке после успешной записи (регрессия
 * 2026-11-02 — «Objects are not valid as a React child» вместо уведомления).
 *
 * jsdom — devDependency; если пакета нет (установка без dev-зависимостей),
 * набор громко говорит «пропущен» и не врёт про зелёный прогон. Полный прогон
 * включается так: pnpm install  (или PG_JSDOM=<путь к jsdom/lib/api.js>).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

/*
 * jsdom — devDependency. Если пакета нет (установка без dev-зависимостей или
 * менеджер не смог скачать), берём локальную копию из .tmp/jsdom/node_modules
 * (каталог уже в .gitignore) или путь из PG_JSDOM. Молча «пропустить» набор
 * нельзя: пропуск печатается громко, и в прогоне видно, что клики не проверены.
 */
const localCopy = path.join(repo, '.tmp', 'jsdom', 'node_modules', 'jsdom', 'lib', 'api.js');
let jsdomModule = null;
let jsdomFrom = 'jsdom';
try {
  jsdomModule = await import('jsdom');
} catch {
  const override = process.env.PG_JSDOM || (fs.existsSync(localCopy) ? localCopy : null);
  if (override) {
    jsdomFrom = override;
    jsdomModule = await import(pathToFileURL(override).href);
  }
}
if (!jsdomModule) {
  console.log('PANEL RENDER: ПРОПУЩЕН — нет jsdom. Выполните pnpm install (devDependencies), положите копию в .tmp/jsdom/node_modules или задайте PG_JSDOM.');
  process.exit(0);
}
console.log('PANEL RENDER: jsdom из ' + jsdomFrom);

const { JSDOM } = jsdomModule;
const require = createRequire(path.join(repo, 'package.json'));
const React = require('react');
const ReactDOM = require('react-dom/client');
const testUtils = require('react-dom/test-utils');
const act = React.act || testUtils.act;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = 'C:\\probe\\panel-workspace';
const FOLDER = {
  id: 'folder-1',
  box: { path: 'coordination', root: 'shared' },
  exchange: { contract: 'contract.md' },
  participants: ['structure'],
  orchestrator: 'coordinator',
};
const NODES = [
  { id: 'coordinator', file: 'structure/graph.json', role: 'координатор', brief: 'ведёт план', model: 'work' },
  { id: 'worker', file: 'structure/graph.json', role: 'исполнитель', brief: 'делает работу', model: 'work' },
];

const failures = [];
let passed = 0;
function check(name, body) {
  try {
    body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : error));
  }
}

/** Один DOM и один экземпляр панели на набор: клики настоящие, запросы — заглушка. */
async function mountPanel(overrides = {}, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const win = dom.window;
  const calls = [];
  const errors = [];
  win.addEventListener('error', (event) => errors.push(String((event && event.error && event.error.message) || 'error')));
  /*
   * Рабочий браузер отвечает на confirm() «нет» (галочка «предотвращать
   * дополнительные диалоги»), поэтому заглушка всегда false, а вызовы
   * считаются: удаление папки не имеет права зависеть от системного диалога.
   */
  const dialogs = [];
  win.confirm = (message) => { dialogs.push(message); return false; };
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const raf = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.requestAnimationFrame = raf;
  win.cancelAnimationFrame = clearTimeout;
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  win.ResizeObserver = ResizeObserver;

  /*
   * Панель читает window/document не только через параметр модуля: часть
   * обработчиков обращается к глобальным объектам, как в браузере. Поэтому
   * глобалы выставляются на каждый набор и снимаются вместе с DOM.
   */
  globalThis.window = win;
  globalThis.document = win.document;
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.Event = win.Event;
  globalThis.MouseEvent = win.MouseEvent;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = raf;
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.ResizeObserver = ResizeObserver;

  /*
   * Канва рисуется по layout, который считает сервер, а не по graph.nodes:
   * без layout панель честно пишет «узлов в них нет» и портала не будет.
   */
  let graph = {
    exists: true,
    root: ROOT,
    structureDir: 'structure',
    sources: [{ file: 'structure/graph.json', models: 1, nodes: 2, edges: 0, folders: 1 }],
    graph: { version: 1, models: { work: { provider: 'probe', model: 'probe-1' } }, nodes: NODES, edges: [], folders: [FOLDER] },
    layout: {
      nodes: [
        { id: 'coordinator', x: 4, y: 0, w: 176, h: 62, layer: 0, cyclic: false },
        { id: 'worker', x: 102, y: 118, w: 176, h: 62, layer: 1, cyclic: false },
      ],
      edges: [],
      width: 400,
      height: 220,
      layers: 2,
      cyclic: [],
    },
    selfNode: 'coordinator',
  };
  /*
   * Вариант структуры для сценария. Пустой список folders — папки ещё нет:
   * портал без папки открывает черновик «folder-1», и клик по сохранению
   * обязан звать action=add, а не action=update.
   */
  if (Array.isArray(options.folders)) {
    graph = { ...graph, graph: { ...graph.graph, folders: options.folders } };
  }
  const body = (value) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(value) });

  win.fetch = (input, options) => {
    const url = String(input).replace(/^\/project-graph/, '');
    const method = (options && options.method) || 'GET';
    calls.push({ method, url, body: (options && options.body) || null });
    if (url.startsWith('/api/status')) {
      /*
       * Реестр воркспейсов (задание 0024): панель выбирает участника папки
       * отсюда, а не из свободного ввода. Своя метка 'structure' уже в папке.
       */
      return body({
        roots: [ROOT],
        defaultRoot: ROOT,
        structureDir: 'structure',
        edgeKinds: ['delegate', 'review', 'peer', 'report'],
        workspaces: [
          { label: 'structure', path: ROOT, name: 'panel-workspace' },
          { label: 'workflow', path: 'C:/probe/workflow', name: 'workflow' },
        ],
      });
    }
    if (url.startsWith('/api/projects')) {
      return body({ projects: [{ root: ROOT, name: 'panel-workspace', exists: true, hasStructure: true, nodes: 2, edges: 0, errors: 0, warnings: 0 }] });
    }
    if (url.startsWith('/api/graph')) return body(graph);
    if (url.startsWith('/api/exchange?')) {
      /*
       * Портал рисуется по ленте обмена, а не по graph.json: без записи folders
       * в ней панель показывает пустую схему и кликать не по чему.
       */
      const folders = graph.graph.folders.map((folder) => ({
        id: folder.id,
        box: 'C:\\probe\\coordination',
        participants: folder.participants,
        state: 'draft',
        contract: folder.exchange && folder.exchange.contract ? folder.exchange.contract : false,
        contractRev: 1,
        states: { structure: 'invited' },
        outgoing: 0,
        incoming: 0,
      }));
      return body({ root: ROOT, label: 'structure', participants: ['structure'], sources: [], total: 0, unparsed: 0, facts: [], links: [], folders });
    }
    if (url.startsWith('/api/activity')) return body({ root: ROOT, runs: [] });
    if (url.startsWith('/api/live')) return body({ root: ROOT, label: 'structure', sessions: { running: 0, items: [] }, total: 0, agents: [], active: [], unknown: [] });
    if (url.startsWith('/api/folder')) {
      const action = new URL(url, 'http://localhost').searchParams.get('action');
      if (action === 'remove') {
        graph = { ...graph, graph: { ...graph.graph, folders: [] } };
        return body({ ok: true, removed: 'folder-1', file: 'structure/graph.json' });
      }
      if (action === 'contract') return body({ ok: true, folder: 'folder-1', contract: { rev: 2, file: 'contract.md' } });
      return body({ ok: true, folder: 'folder-1' });
    }
    if (url.startsWith('/workflow/api/status')) return body({ installed: false });
    return body(overrides[url.replace(/\?.*$/, '')] || {});
  };
  /*
   * Панель зовёт fetch из глобальной области, а не из window: заглушка должна
   * стоять на globalThis, иначе запросы уходят в сеть Node и панель показывает
   * «Failed to parse URL». Путь BASE относительный — в браузере его решает
   * адрес страницы, здесь его решает заглушка.
   */
  globalThis.fetch = win.fetch;

  let entry = null;
  win.__ModuleLoader__ = { load: (value) => { entry = value; } };
  /* PG_CLIENT — путь к другой сборке панели: так проверяется, что набор ловит
     именно дефект, а не проходит на любом файле. */
  const clientPath = process.env.PG_CLIENT || path.join(repo, 'lib', 'client.js');
  new Function('window', fs.readFileSync(clientPath, 'utf8'))(win);
  const client = entry.factory((id) => {
    if (id === 'react') return React;
    throw new Error('unexpected require: ' + id);
  });
  let View = null;
  client.apply({
    inject: (names, run) => run({
      uiWorkspace: {
        sessions: { list: { getSnapshot: () => ({ byId: { s1: { id: 's1', cwd: ROOT } } }) } },
        workspaces: { list: { getSnapshot: () => ({ items: [{ id: ROOT, path: ROOT, title: 'panel-workspace', sessionIds: ['s1'] }] }) } },
        mainReference: { sessionId: 's1' },
        selection: { getSnapshot: () => ({ sessionId: 's1' }) },
      },
    }),
    slots: { inject: (name, run) => run(), register: (descriptor, component) => { View = component; return () => {}; } },
  });

  const container = win.document.getElementById('root');
  const reactRoot = ReactDOM.createRoot(container);
  const settle = async (ms = 150) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  const render = async () => {
    await act(async () => { reactRoot.render(React.createElement(View)); });
    await settle(400);
  };
  const click = async (element, ms = 250) => {
    await act(async () => {
      element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };
  /*
   * Ввод в управляемое поле React: значение ставится нативным сеттером (DOM
   * показывает правку), а событие идёт через Simulate — так onChange срабатывает
   * и на React 18, где ручной input-эвент с обходом трекера до обработчика не доходит.
   */
  const type = async (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    await act(async () => {
      testUtils.Simulate.change(element);
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  };
  const find = (selector) => container.querySelector(selector);
  const all = (selector) => Array.from(container.querySelectorAll(selector));
  const text = () => container.textContent || '';
  const posts = () => calls.filter((call) => call.method === 'POST');
  /* Снятие внутри act останавливает таймеры опроса до закрытия окна: иначе
     их обновления приходят во время следующего набора и печатают предупреждения. */
  const close = async () => {
    try { await act(async () => { reactRoot.unmount(); }); } catch { /* уже снят */ }
    win.close();
  };

  return { win, client, React, reactRoot, dialogs, render, click, type, find, all, text, posts, calls, errors, close };
}

async function withPanel(name, scenario, options = {}) {
  const panel = await mountPanel({}, options);
  try {
    await panel.render();
    if (process.env.PG_DEBUG) {
      console.log('DBG calls', JSON.stringify(panel.calls.map((call) => call.method + ' ' + call.url)));
      console.log('DBG text', panel.text().slice(0, 3000));
    }
    check(name + ': портал папки нарисован', () => {
      if (!panel.find('[data-portal]')) throw new Error('нет портала обмена');
    });
    check(name + ': видна метка сборки панели', () => {
      const chip = panel.find('[data-client-build]');
      if (!chip) throw new Error('нет метки сборки: нельзя понять, какая версия клиента загружена');
      if (!/сборка/u.test(chip.textContent || '')) throw new Error('метка сборки без подписи');
    });
    await scenario(panel);
  } catch (error) {
    failures.push({ name, error });
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : error));
  } finally {
    await panel.close();
  }
}

/* 1. Удаление папки: запись уходит, окно закрывается, панель говорит «удалена». */
await withPanel('удаление папки', async (panel) => {
  await panel.click(panel.find('[data-portal]'), 200);
  check('удаление: редактор открылся', () => {
    if (!panel.find('[data-folder-editor]')) throw new Error('редактор папки не открылся');
  });
  const button = panel.find('[data-folder-remove]');
  check('удаление: кнопка доступна', () => {
    if (!button) throw new Error('нет кнопки «Удалить папку»');
    if (button.disabled) throw new Error('кнопка «Удалить папку» выключена у объявленной папки');
  });
  await panel.click(button, 250);
  check('удаление: первый клик только спрашивает', () => {
    if (!panel.find('[data-folder-delete-ask]')) throw new Error('нет окна подтверждения: клик ничего не объясняет');
    const early = panel.posts().filter((call) => /action=remove/.test(call.url));
    if (early.length !== 0) throw new Error('запись ушла до подтверждения');
  });
  check('удаление: системный confirm не нужен', () => {
    if (panel.dialogs.length !== 0) throw new Error('панель позвала window.confirm: ' + panel.dialogs.join('; '));
  });
  const confirmButton = panel.find('[data-delete-confirm]');
  check('удаление: в окне есть кнопка подтверждения', () => {
    if (!confirmButton) throw new Error('нет кнопки подтверждения в окне');
  });
  await panel.click(confirmButton, 400);
  const removes = panel.posts().filter((call) => /action=remove/.test(call.url));
  check('удаление: запрос remove ушёл с id папки', () => {
    if (removes.length !== 1) throw new Error('ожидался один запрос remove, получено ' + removes.length);
    const payload = JSON.parse(removes[0].body || '{}');
    if (payload.id !== 'folder-1') throw new Error('в теле нет id папки: ' + removes[0].body);
  });
  check('удаление: окна закрылись', () => {
    if (panel.find('[data-folder-editor]')) throw new Error('редактор папки остался открытым');
    if (panel.find('[data-folder-delete-ask]')) throw new Error('подтверждение осталось на экране');
  });
  check('удаление: панель сказала, что папка удалена', () => {
    const notice = panel.find('[role="status"], div');
    if (!/удалена из структуры/u.test(panel.text())) throw new Error('нет уведомления об удалении; на экране: ' + panel.text().slice(0, 200));
    void notice;
  });
  check('удаление: перерисовка без исключения', () => {
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
    if (!panel.find('[role="status"]')) throw new Error('нет строки состояния (role=status)');
  });
});

/* 2. Сохранение объявленной папки: update, уведомление «сохранена», без падения. */
await withPanel('сохранение папки', async (panel) => {
  await panel.click(panel.find('[data-portal]'), 200);
  const button = panel.find('[data-folder-save]');
  check('сохранение: кнопка есть', () => {
    if (!button) throw new Error('нет кнопки сохранения папки');
  });
  check('сохранение: кнопка называется «Сохранить изменения»', () => {
    const label = (button.textContent || '').trim();
    if (label !== 'Сохранить изменения') throw new Error('кнопка объявленной папки называется «' + label + '»');
  });
  await panel.click(button, 400);
  check('сохранение: запрос update ушёл', () => {
    const updates = panel.posts().filter((call) => /action=update/.test(call.url));
    if (updates.length !== 1) throw new Error('ожидался один запрос update, получено ' + updates.length);
  });
  check('сохранение: панель сказала «сохранена» без падения', () => {
    if (!/сохранена/u.test(panel.text())) throw new Error('нет уведомления о сохранении; на экране: ' + panel.text().slice(0, 200));
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
});

/*
 * 2а. Участник папки выбирается из реестра воркспейсов с поиском (задание 0024).
 * Свободного текстового поля метки нет: ввод — только поиск, метка ставится
 * кликом по элементу реестра, и в теле запроса уходит именно выбранная метка.
 */
await withPanel('участник из реестра', async (panel) => {
  await panel.click(panel.find('[data-portal]'), 200);
  const registry = panel.find('[data-participant-registry]');
  const search = panel.find('[data-participant-search]');
  check('реестр: список воркспейсов нарисован', () => {
    if (!registry) throw new Error('нет [data-participant-registry]');
  });
  check('реестр: есть поиск по подстроке', () => {
    if (!search) throw new Error('нет [data-participant-search]');
    if (!/поиск/u.test(search.getAttribute('aria-label') || '')) throw new Error('поле поиска не подписано');
  });
  check('реестр: свободного ввода метки нет', () => {
    if (panel.find('[data-folder-participant]')) throw new Error('осталась кнопка ручной метки');
    if (panel.find('[aria-label="метка участника папки"]')) throw new Error('осталось поле свободного ввода метки');
  });
  const options = () => panel.all('[data-participant-option]').map((item) => (item.textContent || '').trim());
  check('реестр: обе метки видны подписью «метка (имя каталога)»', () => {
    const labels = options();
    if (!labels.includes('workflow (workflow)')) throw new Error('в реестре нет workflow: ' + labels.join(', '));
    if (!labels.includes('structure (panel-workspace)')) throw new Error('в реестре нет structure: ' + labels.join(', '));
    const option = panel.all('[data-participant-option]').find((item) => (item.textContent || '').trim().startsWith('workflow ('));
    if (!option || option.getAttribute('title') !== 'C:/probe/workflow') {
      throw new Error('title элемента — не абсолютный путь: ' + (option && option.getAttribute('title')));
    }
  });
  check('участник в папке: подпись и title — абсолютный путь', () => {
    const chip = panel.find('[data-participant-resolved="1"]');
    if (!chip) throw new Error('нет найденной метки участника');
    if (!String(chip.textContent || '').includes('structure (panel-workspace)')) {
      throw new Error('подпись участника не «метка (имя каталога)»: ' + chip.textContent);
    }
    if (chip.getAttribute('title') !== ROOT) throw new Error('title участника — не абсолютный путь: ' + chip.getAttribute('title'));
  });
  await panel.type(search, 'work');
  check('реестр: поиск по подстроке оставляет только совпадения', () => {
    const labels = options();
    if (!labels.some((label) => label.startsWith('workflow ('))) throw new Error('поиск «work» потерял workflow: ' + labels.join(', '));
    if (labels.some((label) => label.startsWith('structure ('))) throw new Error('поиск «work» не отфильтровал structure; на экране: ' + labels.join(', '));
  });
  const option = panel.all('[data-participant-option]').find((item) => (item.textContent || '').trim().startsWith('workflow ('));
  await panel.click(option, 250);
  check('реестр: выбранная метка стала участником папки', () => {
    const editor = panel.find('[data-folder-editor]');
    if (!/workflow/u.test((editor && editor.textContent) || '')) throw new Error('метка не добавлена в папку');
  });
  await panel.click(panel.find('[data-folder-save]'), 400);
  const updates = panel.posts().filter((call) => /action=update/.test(call.url));
  check('реестр: в теле сохранения — выбранная метка реестра', () => {
    if (updates.length !== 1) throw new Error('ожидался один update, получено ' + updates.length);
    const payload = JSON.parse(updates[0].body || '{}');
    const participants = (payload.folder && payload.folder.participants) || [];
    if (!participants.includes('workflow')) throw new Error('workflow нет в участниках: ' + JSON.stringify(participants));
    if (!participants.includes('structure')) throw new Error('structure потерян: ' + JSON.stringify(participants));
  });
  check('реестр: перерисовка без исключения', () => {
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
});

/*
 * 2б. Метка вне реестра (задание 0029): помечена «не найден», похожие названы,
 * сохранить нельзя — свободного ввода нет, чужую метку панель не записывает.
 */
await withPanel('метка вне реестра', async (panel) => {
  await panel.click(panel.find('[data-portal]'), 200);
  const chip = panel.find('[data-participant-resolved="0"]');
  check('неразрешённая метка: помечена «не найден»', () => {
    if (!chip) throw new Error('метка struktura не помечена как неразрешённая');
    if (!/не найден/u.test(chip.textContent || '')) throw new Error('в подписи нет «не найден»: ' + chip.textContent);
  });
  check('неразрешённая метка: похожие названы', () => {
    const hint = panel.find('[data-participant-unresolved]');
    if (!hint) throw new Error('нет блока о метке вне реестра');
    if (!/Похожие метки: structure/u.test(hint.textContent || '')) {
      throw new Error('похожие не названы: ' + hint.textContent);
    }
  });
  check('неразрешённая метка: сохранить нельзя', () => {
    const save = panel.find('[data-folder-save]');
    if (!save) throw new Error('нет кнопки сохранения');
    if (!save.disabled) throw new Error('кнопка сохранения доступна при метке вне реестра');
  });
}, { folders: [{ ...FOLDER, participants: ['structure', 'struktura'] }] });

/* 3. Уведомление участников: кнопка называет дело, объяснение — когда письмо дойдёт; клик даёт Rev+1. */
await withPanel('уведомление участников', async (panel) => {
  await panel.click(panel.find('[data-portal]'), 200);
  const button = panel.find('[data-folder-contract]');
  check('уведомление: кнопка есть и доступна', () => {
    if (!button) throw new Error('нет кнопки «Уведомить участников»');
    if (button.disabled) throw new Error('кнопка «Уведомить участников» выключена у объявленной папки');
  });
  check('уведомление: кнопка называется «Уведомить участников»', () => {
    const label = ((button && button.textContent) || '').trim();
    if (label !== 'Уведомить участников') throw new Error('кнопка называется «' + label + '»');
  });
  check('уведомление: рядом объяснено, что будет и когда письмо не дойдёт', () => {
    const editor = panel.find('[data-folder-editor]');
    const editorText = (editor && editor.textContent) || '';
    if (!/Rev\+1/u.test(editorText)) throw new Error('в редакторе нет Rev+1: ' + editorText.slice(0, 300));
    if (!/письма-приглашения/u.test(editorText)) throw new Error('в редакторе нет писем-приглашений участникам');
    if (!/совпада/u.test(editorText) || !/воркспейс/u.test(editorText)) throw new Error('в редакторе не сказано, что метка должна совпасть с воркспейсом');
    if (!/адресата нет/u.test(editorText)) throw new Error('в редакторе не сказано, что при несовпадении адресата нет');
  });
  await panel.click(button, 400);
  check('уведомление: запрос contract ушёл', () => {
    const contracts = panel.posts().filter((call) => /action=contract/.test(call.url));
    if (contracts.length !== 1) throw new Error('ожидался один запрос contract, получено ' + contracts.length);
  });
  check('уведомление: сказано «переписан» с ревизией', () => {
    if (!/переписан/u.test(panel.text())) throw new Error('нет уведомления о контракте; на экране: ' + panel.text().slice(0, 200));
    if (!/Rev 2/u.test(panel.text())) throw new Error('в уведомлении нет номера ревизии');
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
});

/*
 * 4. Граница ошибок: объект вместо строки в children не должен гасить окно.
 * Именно так выглядел дефект «кнопка удалить не работает»: запись прошла, а
 * React снял всё дерево и панель стала пустой.
 */
await withPanel('граница ошибок отрисовки', async (panel) => {
  const guard = panel.client.__RenderGuard;
  check('граница: компонент экспортирован', () => {
    if (typeof guard !== 'function') throw new Error('RenderGuard не экспортирован из панели');
  });
  if (typeof guard !== 'function') return;
  const host = panel.win.document.createElement('div');
  panel.win.document.body.appendChild(host);
  const guardRoot = ReactDOM.createRoot(host);
  let retried = 0;
  const quiet = console.error;
  console.error = () => {};
  try {
    await act(async () => {
      guardRoot.render(React.createElement(guard, { onRetry: () => { retried += 1; } },
        React.createElement('div', null, { text: 'объект вместо строки' })));
    });
  } finally {
    console.error = quiet;
  }
  check('граница: карточка вместо пустого окна', () => {
    const text = host.textContent || '';
    if (!host.querySelector('[role="alert"]')) throw new Error('нет карточки ошибки, на экране: ' + text.slice(0, 200));
    if (!/Панель не смогла отрисовать структуру/u.test(text)) throw new Error('карточка без названия: ' + text.slice(0, 200));
    if (!/Что сделать:/u.test(text)) throw new Error('в карточке нет рецепта (И-1)');
  });
  const retryButton = Array.from(host.querySelectorAll('button')).find((button) => /Показать снова/u.test(button.textContent || ''));
  check('граница: есть кнопка повтора', () => {
    if (!retryButton) throw new Error('нет кнопки «Показать снова»');
  });
  if (retryButton) {
    const quietRetry = console.error;
    console.error = () => {};
    try {
      await act(async () => {
        retryButton.dispatchEvent(new panel.win.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
    } finally {
      console.error = quietRetry;
    }
    check('граница: повтор перечитывает структуру', () => {
      if (retried !== 1) throw new Error('onRetry вызван ' + retried + ' раз');
    });
  }
  try { await act(async () => { guardRoot.unmount(); }); } catch { /* уже снят */ }
});

/* 5. Отказ от удаления: «Оставить папку» ничего не пишет и не закрывает редактор. */
await withPanel('отмена удаления папки', async (panel) => {
  await panel.click(panel.find('[data-portal]'), 200);
  await panel.click(panel.find('[data-folder-remove]'), 200);
  check('отмена: окно подтверждения открыто', () => {
    if (!panel.find('[data-folder-delete-ask]')) throw new Error('нет окна подтверждения');
  });
  const cancelButton = panel.all('button').find((button) => /Оставить папку/u.test(button.textContent || ''));
  check('отмена: кнопка «Оставить папку» подписана', () => {
    if (!cancelButton) throw new Error('нет кнопки «Оставить папку» — отказ без объяснения');
  });
  if (cancelButton) await panel.click(cancelButton, 300);
  check('отмена: запись не ушла', () => {
    const removes = panel.posts().filter((call) => /action=remove/.test(call.url));
    if (removes.length !== 0) throw new Error('удаление ушло после отказа');
  });
  check('отмена: редактор папки на месте', () => {
    if (!panel.find('[data-folder-editor]')) throw new Error('редактор закрылся, хотя папка не удалена');
    if (panel.find('[data-folder-delete-ask]')) throw new Error('окно подтверждения осталось');
  });
});

/*
 * 6. Удаление узла: кнопка «Удалить узел» открывает [data-node-delete-ask],
 * запись уходит только по [data-node-delete-confirm], затем уведомление и
 * закрытый редактор. window.confirm не участвует: заглушка отвечает «нет»,
 * как браузер с галочкой «предотвращать дополнительные диалоги».
 */
await withPanel('удаление узла', async (panel) => {
  await panel.click(panel.find('[data-node="worker"]'), 200);
  const editButton = panel.all('button').find((button) => /Изменить узел/u.test(button.textContent || ''));
  check('узел: кнопка «Изменить узел» есть', () => {
    if (!editButton) throw new Error('карточка узла не предложила редактор');
  });
  if (!editButton) return;
  await panel.click(editButton, 200);
  check('узел: редактор открылся', () => {
    if (!panel.find('[data-node-editor]')) throw new Error('редактор узла не открылся');
  });
  const removeButton = panel.find('[data-editor-remove]');
  check('узел: кнопка «Удалить узел» есть и доступна', () => {
    if (!removeButton) throw new Error('нет кнопки «Удалить узел» в редакторе');
    if (removeButton.disabled) throw new Error('кнопка «Удалить узел» выключена');
  });
  await panel.click(removeButton, 250);
  check('узел: первый клик только спрашивает', () => {
    if (!panel.find('[data-node-delete-ask]')) throw new Error('нет окна подтверждения: клик ничего не объясняет');
    const early = panel.posts().filter((call) => /action=remove/.test(call.url));
    if (early.length !== 0) throw new Error('запись ушла до подтверждения');
    if (!panel.find('[data-node-editor]')) throw new Error('редактор закрылся, хотя узел ещё не удалён');
  });
  check('узел: системный confirm не нужен', () => {
    if (panel.dialogs.length !== 0) throw new Error('панель позвала window.confirm: ' + panel.dialogs.join('; '));
  });
  const confirmButton = panel.find('[data-node-delete-confirm]');
  check('узел: в окне есть кнопка подтверждения', () => {
    if (!confirmButton) throw new Error('нет кнопки подтверждения в окне');
  });
  if (!confirmButton) return;
  await panel.click(confirmButton, 400);
  const removes = panel.posts().filter((call) => /action=remove/.test(call.url));
  check('узел: один запрос remove с id узла', () => {
    if (removes.length !== 1) throw new Error('ожидался один запрос remove, получено ' + removes.length);
    if (!/\/api\/node\?/.test(removes[0].url)) throw new Error('запрос ушёл не на /api/node: ' + removes[0].url);
    const payload = JSON.parse(removes[0].body || '{}');
    if (payload.id !== 'worker') throw new Error('в теле нет id узла: ' + removes[0].body);
  });
  check('узел: окна закрылись', () => {
    if (panel.find('[data-node-editor]')) throw new Error('редактор узла остался открытым');
    if (panel.find('[data-node-delete-ask]')) throw new Error('подтверждение осталось на экране');
  });
  check('узел: панель сказала, что узел удалён', () => {
    if (!/Узел «worker» удалён/u.test(panel.text())) throw new Error('нет уведомления об удалении; на экране: ' + panel.text().slice(0, 300));
  });
  check('узел: перерисовка без исключения', () => {
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
    if (!panel.find('[role="status"]')) throw new Error('нет строки состояния (role=status)');
  });
});

/* 7. Отказ от удаления узла: «Оставить узел» ничего не пишет и оставляет редактор. */
await withPanel('отмена удаления узла', async (panel) => {
  await panel.click(panel.find('[data-node="worker"]'), 200);
  const editButton = panel.all('button').find((button) => /Изменить узел/u.test(button.textContent || ''));
  if (editButton) await panel.click(editButton, 200);
  await panel.click(panel.find('[data-editor-remove]'), 200);
  check('отмена узла: окно подтверждения открыто', () => {
    if (!panel.find('[data-node-delete-ask]')) throw new Error('нет окна подтверждения');
  });
  const cancelButton = panel.all('button').find((button) => /Оставить узел/u.test(button.textContent || ''));
  check('отмена узла: кнопка «Оставить узел» подписана', () => {
    if (!cancelButton) throw new Error('нет кнопки «Оставить узел» — отказ без объяснения');
  });
  if (cancelButton) await panel.click(cancelButton, 300);
  check('отмена узла: запись не ушла', () => {
    const removes = panel.posts().filter((call) => /action=remove/.test(call.url));
    if (removes.length !== 0) throw new Error('удаление ушло после отказа');
  });
  check('отмена узла: редактор узла на месте', () => {
    if (!panel.find('[data-node-editor]')) throw new Error('редактор закрылся, хотя узел не удалён');
    if (panel.find('[data-node-delete-ask]')) throw new Error('окно подтверждения осталось');
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
});

/*
 * 8. Черновик папки (папки в структуре ещё нет): основная кнопка подписана
 * «Сохранить изменения», клик уходит одним action=add и закрывает окно.
 */
await withPanel('сохранение черновика папки', async (panel) => {
  await panel.click(panel.find('[data-portal]'), 200);
  const editor = panel.find('[data-folder-editor]');
  check('черновик: редактор открылся на портале без папки', () => {
    if (!editor) throw new Error('редактор черновика не открылся');
    if (editor.getAttribute('data-folder-editor') !== 'folder-1') throw new Error('черновик получил id ' + editor.getAttribute('data-folder-editor'));
  });
  const button = panel.find('[data-folder-save]');
  check('черновик: кнопка называется «Сохранить изменения»', () => {
    if (!button) throw new Error('нет кнопки сохранения черновика');
    const label = (button.textContent || '').trim();
    if (label !== 'Сохранить изменения') throw new Error('кнопка черновика называется «' + label + '»');
  });
  await panel.click(button, 400);
  check('черновик: ровно один запрос add', () => {
    const adds = panel.posts().filter((call) => /action=add/.test(call.url));
    if (adds.length !== 1) throw new Error('ожидался один запрос add, получено ' + adds.length);
    if (!/\/api\/folder\?/.test(adds[0].url)) throw new Error('запись ушла не на /api/folder: ' + adds[0].url);
  });
  check('черновик: окно закрылось, сказано «создана»', () => {
    if (panel.find('[data-folder-editor]')) throw new Error('редактор черновика остался открытым');
    if (!/создана/u.test(panel.text())) throw new Error('нет уведомления о создании; на экране: ' + panel.text().slice(0, 200));
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
}, { folders: [] });

/*
 * 9. Крестик при несохранённых правках: подтверждение «Сохранить изменения?»,
 * «Да» сохраняет тем же action=add и закрывает окно.
 */
await withPanel('крестик папки: «Да» сохраняет', async (panel) => {
  await panel.click(panel.find('[data-portal]'), 200);
  const input = panel.find('[data-folder-editor] input[aria-label="путь ящика папки"]');
  check('крестик-да: поле ящика доступно', () => {
    if (!input) throw new Error('нет поля пути ящика');
  });
  if (input) await panel.type(input, 'coordination-2');
  check('крестик-да: правка отмечена «изменено · не сохранено»', () => {
    if (!panel.find('[data-folder-dirty]')) throw new Error('ввод не пометил редактор изменённым');
  });
  await panel.click(panel.find('[data-folder-close]'), 200);
  const confirm = panel.find('[data-close-confirm]');
  check('крестик-да: подтверждение спрашивает «Сохранить изменения?»', () => {
    if (!confirm) throw new Error('крестик не спросил подтверждения');
    if (!/Сохранить изменения\?/u.test(panel.text())) throw new Error('нет вопроса «Сохранить изменения?»; на экране: ' + panel.text().slice(0, 250));
  });
  const yes = panel.all('[data-close-confirm] button').find((button) => (button.textContent || '').trim() === 'Да');
  check('крестик-да: кнопка «Да» подписана словом', () => {
    if (!yes) throw new Error('нет кнопки «Да» — сохранить нечем');
  });
  check('крестик-да: до «Да» ничего не записано', () => {
    if (panel.posts().length !== 0) throw new Error('запись ушла до ответа: ' + panel.posts().map((call) => call.method + ' ' + call.url).join('; '));
  });
  if (yes) await panel.click(yes, 400);
  check('крестик-да: один запрос add с новым ящиком', () => {
    const adds = panel.posts().filter((call) => /action=add/.test(call.url));
    if (adds.length !== 1) throw new Error('ожидался один запрос add, получено ' + adds.length);
    const payload = JSON.parse(adds[0].body || '{}');
    if (!payload.folder || payload.folder.box.path !== 'coordination-2') throw new Error('в теле не новый ящик: ' + adds[0].body);
  });
  check('крестик-да: окна закрылись', () => {
    if (panel.find('[data-folder-editor]')) throw new Error('редактор остался открытым');
    if (panel.find('[data-close-confirm]')) throw new Error('подтверждение осталось на экране');
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
}, { folders: [] });

/*
 * 10. Негативный контроль: «Нет» закрывает без сохранения, запись не уходит.
 */
await withPanel('крестик папки: «Нет» закрывает без записи', async (panel) => {
  await panel.click(panel.find('[data-portal]'), 200);
  const input = panel.find('[data-folder-editor] input[aria-label="путь ящика папки"]');
  if (input) await panel.type(input, 'coordination-3');
  await panel.click(panel.find('[data-folder-close]'), 200);
  check('крестик-нет: подтверждение открыто', () => {
    if (!panel.find('[data-close-confirm]')) throw new Error('нет подтверждения');
  });
  const no = panel.all('[data-close-confirm] button').find((button) => (button.textContent || '').trim() === 'Нет');
  check('крестик-нет: кнопка «Нет» подписана словом', () => {
    if (!no) throw new Error('нет кнопки «Нет» — закрыть без записи нечем');
  });
  if (no) await panel.click(no, 300);
  check('крестик-нет: запись не ушла', () => {
    if (panel.posts().length !== 0) throw new Error('запись ушла после «Нет»: ' + panel.posts().map((call) => call.method + ' ' + call.url).join('; '));
  });
  check('крестик-нет: окна закрылись', () => {
    if (panel.find('[data-folder-editor]')) throw new Error('редактор остался открытым');
    if (panel.find('[data-close-confirm]')) throw new Error('подтверждение осталось на экране');
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
}, { folders: [] });

/*
 * 11. Негативный контроль: без правок крестик закрывает сразу, ничего не спрашивая.
 */
await withPanel('крестик папки без правок', async (panel) => {
  await panel.click(panel.find('[data-portal]'), 200);
  check('крестик-чисто: редактор открылся', () => {
    if (!panel.find('[data-folder-editor]')) throw new Error('редактор черновика не открылся');
  });
  await panel.click(panel.find('[data-folder-close]'), 200);
  check('крестик-чисто: вопроса нет, окно закрыто', () => {
    if (panel.find('[data-close-confirm]')) throw new Error('панель спросила без правок');
    if (panel.find('[data-folder-editor]')) throw new Error('редактор не закрылся сразу');
  });
  check('крестик-чисто: запись не ушла', () => {
    if (panel.posts().length !== 0) throw new Error('крестик без правок что-то записал');
  });
}, { folders: [] });

/*
 * 12. Крестик узла не изменился: правки по-прежнему предупреждают о потере,
 * «Продолжить редактирование» оставляет окно, «Закрыть без сохранения» — нет.
 */
await withPanel('крестик узла', async (panel) => {
  await panel.click(panel.find('[data-node="worker"]'), 200);
  const editButton = panel.all('button').find((button) => /Изменить узел/u.test(button.textContent || ''));
  if (editButton) await panel.click(editButton, 200);
  check('крестик узла: редактор открылся', () => {
    if (!panel.find('[data-node-editor]')) throw new Error('редактор узла не открылся');
  });
  const role = panel.find('[data-node-editor] input[aria-label="роль узла в редакторе"]');
  check('крестик узла: поле роли доступно', () => {
    if (!role) throw new Error('нет поля роли');
  });
  if (role) await panel.type(role, 'исполнитель-2');
  await panel.click(panel.find('[data-editor-close]'), 200);
  check('крестик узла: спрашивает «Закрыть без сохранения?»', () => {
    if (!panel.find('[data-close-confirm]')) throw new Error('крестик не спросил подтверждения');
    if (!/Закрыть без сохранения\?/u.test(panel.text())) throw new Error('нет вопроса о потере; на экране: ' + panel.text().slice(0, 250));
    if (/Сохранить изменения\?/u.test(panel.text())) throw new Error('у узла появился вопрос папки');
  });
  const keep = panel.all('[data-close-confirm] button').find((button) => /Продолжить редактирование/u.test(button.textContent || ''));
  check('крестик узла: «Продолжить редактирование» на месте', () => {
    if (!keep) throw new Error('нет кнопки продолжения');
  });
  if (keep) await panel.click(keep, 250);
  check('крестик узла: продолжение оставляет редактор', () => {
    if (!panel.find('[data-node-editor]')) throw new Error('редактор закрылся, хотя просили продолжить');
    if (panel.find('[data-close-confirm]')) throw new Error('подтверждение осталось');
  });
  await panel.click(panel.find('[data-editor-close]'), 200);
  const discard = panel.find('[data-close-discard]');
  check('крестик узла: «Закрыть без сохранения» на месте', () => {
    if (!discard) throw new Error('нет кнопки отказа');
  });
  if (discard) await panel.click(discard, 250);
  check('крестик узла: отказ закрывает без записи', () => {
    if (panel.find('[data-node-editor]')) throw new Error('редактор остался открытым');
    if (panel.posts().length !== 0) throw new Error('закрытие узла что-то записало: ' + panel.posts().length);
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
});

console.log(failures.length === 0
  ? 'PANEL RENDER OK: ' + passed + ' проверок, панель пережила клики по папке и узлу'
  : 'PANEL RENDER FAILED: ' + failures.length);
process.exit(failures.length === 0 ? 0 : 1);
