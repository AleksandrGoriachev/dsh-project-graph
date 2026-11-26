#!/usr/bin/env node
/**
 * 0356: монитор периодов таймкипера в настройках узла.
 *
 * Панель проверяется ИСПОЛНЕНИЕМ, а не чтением исходника: поднимаются настоящий
 * React и настоящий DOM (jsdom), настройки узла открываются кликами, «Добавить
 * период» и «Удалить» нажимаются, провайдер и модель выбираются в живом каталоге,
 * а тело POST /api/node читается из заглушки сети. Только так видно, что секция
 * «Монитор» есть у таймкипера, работает и уходит на сервер, а у узла другого вида
 * её нет и monitor в тело не попадает.
 *
 * jsdom — devDependency; если пакета нет, набор громко говорит «пропущен», а не
 * врёт про зелёный прогон (так же, как test/panel-render.test.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

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
  console.log('PANEL MONITOR: ПРОПУЩЕН — нет jsdom. Выполните pnpm install (devDependencies), положите копию в .tmp/jsdom/node_modules или задайте PG_JSDOM.');
  process.exit(0);
}
console.log('PANEL MONITOR: jsdom из ' + jsdomFrom);

const { JSDOM } = jsdomModule;
const require = createRequire(path.join(repo, 'package.json'));
const React = require('react');
const ReactDOM = require('react-dom/client');
const testUtils = require('react-dom/test-utils');
const act = React.act || testUtils.act;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = 'C:\\probe\\monitor-workspace';
const COORDINATOR = {
  id: 'coordinator', role: 'координатор', brief: 'ведёт план',
  provider: 'probe', model: 'probe-1', file: 'structure/graph.json',
};
const KEEPER = {
  id: 'keeper', label: 'Тайм-менеджер', type: 'timekeeper', role: 'тайм-менеджер',
  brief: 'следит за периодами останова', provider: 'probe', model: 'probe-1',
  file: 'structure/graph.json',
};
const WORKER = {
  id: 'worker', label: 'Воркер', type: 'worker', role: 'исполнитель',
  brief: 'делает работу', provider: 'probe', model: 'probe-1',
  file: 'structure/graph.json',
};
const CATALOG = {
  providers: [
    { id: 'probe', name: 'probe', models: [{ id: 'probe-1', name: 'probe-1' }, { id: 'probe-2', name: 'probe-2' }] },
    { id: 'other', name: 'other', models: [{ id: 'other-1', name: 'other-1' }] },
  ],
};

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

function layoutOf() {
  return {
    nodes: [
      { id: 'coordinator', x: 16, y: 0, w: 176, h: 62, layer: 0, cyclic: false },
      { id: 'keeper', x: 16, y: 110, w: 176, h: 62, layer: 1, cyclic: false },
      { id: 'worker', x: 16, y: 220, w: 176, h: 62, layer: 2, cyclic: false },
    ],
    edges: [],
    width: 420,
    height: 320,
    layers: 3,
    cyclic: [],
  };
}

/** Один DOM и один экземпляр панели на сценарий: клики настоящие, сеть — заглушка. */
async function mountPanel(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const win = dom.window;
  const calls = [];
  const errors = [];
  win.addEventListener('error', (event) => errors.push(String((event && event.error && event.error.message) || 'error')));
  win.confirm = () => false;
  win.matchMedia = (query) => ({
    matches: false,
    media: String(query || ''),
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  const raf = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.requestAnimationFrame = raf;
  win.cancelAnimationFrame = clearTimeout;
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  win.ResizeObserver = ResizeObserver;

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

  const keeper = { ...KEEPER };
  if (Array.isArray(options.monitor) && options.monitor.length > 0) keeper.monitor = options.monitor;
  let graph = {
    exists: true,
    root: ROOT,
    structureDir: 'structure',
    sources: [{ file: 'structure/graph.json', models: 1, nodes: 3, edges: 0, folders: 0 }],
    graph: {
      version: 1,
      models: { work: { provider: 'probe', model: 'probe-1' } },
      nodes: [COORDINATOR, keeper, WORKER],
      edges: [],
      folders: [],
    },
    layout: layoutOf(),
    selfNode: 'coordinator',
  };

  const answer = (value, ok = true, status = 200) => Promise.resolve({
    ok, status, json: () => Promise.resolve(value),
  });

  win.fetch = (input, fetchOptions) => {
    const url = String(input).replace(/^\/project-graph/u, '');
    const method = (fetchOptions && fetchOptions.method) || 'GET';
    calls.push({ method, url, body: (fetchOptions && fetchOptions.body) || null });
    if (url.startsWith('/api/status')) {
      return answer({
        roots: [ROOT],
        defaultRoot: ROOT,
        structureDir: 'structure',
        edgeKinds: ['delegate', 'review', 'peer', 'report'],
        workspaces: [{ label: 'structure', path: ROOT, name: 'monitor-workspace' }],
      });
    }
    if (url.startsWith('/api/projects')) {
      return answer({ projects: [{ root: ROOT, name: 'monitor-workspace', exists: true, hasStructure: true, nodes: 3, edges: 0, errors: 0, warnings: 0 }] });
    }
    if (url.startsWith('/api/models')) return answer(CATALOG);
    if (url.startsWith('/api/graph')) return answer(graph);
    if (url.startsWith('/api/anchors')) return answer({ ok: true, doc: { version: 3, anchors: [] } });
    if (url.startsWith('/api/obligations')) return answer({ ok: true, obligations: [] });
    if (url.startsWith('/api/exchange/scan')) {
      return answer({ ok: true, unread: [], seen: 0, skipped: [], boxes: [], obligations: [] });
    }
    if (url.startsWith('/api/exchange?')) {
      return answer({ root: ROOT, label: 'structure', participants: ['structure'], sources: [], total: 0, unparsed: 0, facts: [], links: [], folders: [] });
    }
    if (url.startsWith('/api/activity')) return answer({ root: ROOT, runs: [] });
    if (url.startsWith('/api/live')) {
      return answer({ root: ROOT, label: 'structure', sessions: { running: 0, items: [] }, total: 0, agents: [], active: [], unknown: [] });
    }
    if (url.startsWith('/api/node')) {
      if (method !== 'POST') return answer({ ok: true });
      const body = JSON.parse((fetchOptions && fetchOptions.body) || '{}');
      if (options.failNodePost) {
        return answer({
          ok: false,
          error: 'у узла «keeper» monitor[0].periods[0].start должен быть временем HH:MM',
          fix: 'Впишите начало периода как HH:MM, например 09:00.',
        }, false, 400);
      }
      graph = {
        ...graph,
        graph: {
          ...graph.graph,
          nodes: graph.graph.nodes.map((entry) => {
            if (!entry || entry.id !== body.id) return entry;
            const next = { ...entry, ...body };
            if (Object.hasOwn(body, 'monitor')) {
              if (Array.isArray(body.monitor) && body.monitor.length > 0) next.monitor = body.monitor;
              else delete next.monitor;
            }
            return next;
          }),
        },
      };
      return answer({ ok: true, node: (graph.graph.nodes || []).find((entry) => entry && entry.id === body.id) || null });
    }
    if (url.startsWith('/workflow/api/status')) return answer({ installed: false });
    const key = url.replace(/\?.*$/u, '');
    return answer((options.overrides && options.overrides[key]) || {});
  };
  globalThis.fetch = win.fetch;

  let entry = null;
  win.__ModuleLoader__ = { load: (value) => { entry = value; } };
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
        workspaces: { list: { getSnapshot: () => ({ items: [{ id: ROOT, path: ROOT, title: 'monitor-workspace', sessionIds: ['s1'] }] }) } },
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
  const type = async (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    await act(async () => {
      testUtils.Simulate.change(element);
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  };
  const choose = async (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set;
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
  const close = async () => {
    try { await act(async () => { reactRoot.unmount(); }); } catch { /* уже снят */ }
    win.close();
  };

  return { win, client, React, render, click, type, choose, find, all, text, posts, calls, errors, close };
}

/** Настройки узла: карточка → шестерёнка → «Редактировать» (как человек). */
async function openSettings(panel, id) {
  await panel.click(panel.find('[data-node="' + id + '"]'), 200);
  await panel.click(panel.find('[data-node-gear="' + id + '"]'), 250);
  const edit = panel.find('[data-node-info-edit]');
  if (edit) await panel.click(edit, 300);
}

function monitorBodyOf(panel) {
  const updates = panel.posts().filter((call) => /action=update/u.test(call.url));
  const posted = panel.posts().filter((call) => /^\/api\/node\?/u.test(call.url));
  const chosen = updates.length > 0 ? updates : posted;
  if (chosen.length !== 1) throw new Error('ожидался один POST /api/node, получено ' + chosen.length);
  return JSON.parse(chosen[0].body || '{}');
}

async function withPanel(name, scenario, options = {}) {
  const panel = await mountPanel(options);
  try {
    await panel.render();
    await scenario(panel);
  } catch (error) {
    failures.push({ name, error });
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : error));
  } finally {
    await panel.close();
  }
}

const addPeriodButton = (panel) => panel.all('button').find((button) => /^Добавить период$/u.test((button.textContent || '').trim()));

/*
 * 1. Таймкипер: секция есть, провайдер и модель — из живого каталога, периоды
 * добавляются и удаляются, «Сохранить» уносит monitor в теле POST.
 */
await withPanel('таймкипер: монитор в настройках', async (panel) => {
  await openSettings(panel, 'keeper');
  check('C1: у таймкипера секция «Монитор»', () => {
    const section = panel.find('[data-node-monitor]');
    if (!section) throw new Error('нет секции [data-node-monitor]; на экране: ' + panel.text().slice(0, 400));
    if (!/Монитор/u.test(section.textContent || '')) throw new Error('секция без заголовка «Монитор»: ' + (section.textContent || '').slice(0, 200));
    const headings = panel.all('[data-node-editor] div').map((node) => (node.textContent || '').trim());
    if (!headings.includes('Монитор')) throw new Error('среди заголовков формы нет «Монитор»');
  });
  const provider = panel.find('[data-monitor-provider]');
  check('C1: поля провайдера и модели нарисованы, модель — из каталога', () => {
    if (!provider) throw new Error('нет выбора провайдера монитора');
    if (!panel.find('[data-monitor-model]')) throw new Error('нет выбора модели монитора');
    const options = Array.from(provider.querySelectorAll('option')).map((option) => option.value).filter(Boolean);
    if (!options.includes('probe')) throw new Error('в провайдерах нет живого каталога: ' + options.join(','));
    if (provider.disabled) throw new Error('выбор провайдера выключен при живом каталоге');
  });
  if (!provider) return;
  await panel.choose(provider, 'probe');
  const model = panel.find('[data-monitor-model]');
  check('C1: модели берутся у выбранного провайдера', () => {
    if (!model) throw new Error('выбор модели пропал после выбора провайдера');
    const options = Array.from(model.querySelectorAll('option')).map((option) => option.value).filter(Boolean);
    if (!options.includes('probe-1')) throw new Error('у probe нет probe-1: ' + options.join(','));
    if (model.disabled) throw new Error('выбор модели выключен при выбранном провайдере');
  });
  if (!model) return;
  await panel.choose(model, 'probe-1');

  const add = addPeriodButton(panel);
  check('C1: кнопка «Добавить период» есть', () => {
    if (!add) throw new Error('нет кнопки «Добавить период»; на экране: ' + panel.text().slice(0, 300));
  });
  if (!add) return;
  await panel.click(add, 200);
  check('C1: «Добавить период» добавляет строку', () => {
    const rows = panel.all('[data-monitor-period]');
    if (rows.length !== 1) throw new Error('строк периодов: ' + rows.length);
  });
  const start = panel.find('[data-monitor-start="0"]');
  const end = panel.find('[data-monitor-end="0"]');
  const lead = panel.find('[data-monitor-lead="0"]');
  check('C1: у периода поля start, end, leadMinutes', () => {
    if (!start) throw new Error('нет поля start периода');
    if (!end) throw new Error('нет поля end периода');
    if (!lead) throw new Error('нет поля leadMinutes периода');
    if (start.type !== 'time' || end.type !== 'time') throw new Error('start/end не времени: ' + start.type + '/' + end.type);
    if (lead.type !== 'number') throw new Error('leadMinutes не число: ' + lead.type);
    if (start.value !== '') throw new Error('панель выдумала start: ' + start.value);
  });
  if (!start || !end || !lead) return;
  await panel.type(start, '09:00');
  await panel.type(end, '13:00');
  await panel.type(lead, '30');
  const addAgain = addPeriodButton(panel);
  if (addAgain) await panel.click(addAgain, 200);
  check('C1: второй период добавлен', () => {
    if (panel.all('[data-monitor-period]').length !== 2) throw new Error('строк периодов: ' + panel.all('[data-monitor-period]').length);
  });
  const remove = panel.find('[data-monitor-remove="1"]');
  check('C1: у периода кнопка «Удалить»', () => {
    if (!remove) throw new Error('нет кнопки «Удалить» у второго периода');
    if (!/^Удалить$/u.test((remove.textContent || '').trim())) throw new Error('кнопка называется «' + (remove.textContent || '').trim() + '»');
  });
  if (remove) await panel.click(remove, 200);
  check('C1: «Удалить» убирает только свой период', () => {
    const rows = panel.all('[data-monitor-period]');
    if (rows.length !== 1) throw new Error('строк периодов после удаления: ' + rows.length);
    const again = panel.find('[data-monitor-start="0"]');
    if (!again || again.value !== '09:00') throw new Error('удаление стёрло оставшийся период: ' + (again && again.value));
  });
  const save = panel.find('[data-editor-save]');
  check('C1: правки монитора включают «Сохранить»', () => {
    if (!save) throw new Error('нет кнопки «Сохранить» в линейке');
    if (save.disabled) throw new Error('сохранение осталось выключенным после правки монитора');
    const bar = panel.find('[data-settings-footer]');
    if (!/1 поле изменено/u.test(bar ? bar.textContent || '' : '')) throw new Error('линейка не увидела правку монитора: ' + (bar ? bar.textContent : 'нет линейки'));
  });
  check('C1: changedEditorFields видит разницу монитора', () => {
    const labels = panel.client.__changedEditorFields(
      { role: 'тайм-менеджер', monitor: [{ provider: 'probe', model: 'probe-1', periods: [] }] },
      { role: 'тайм-менеджер', monitor: [] },
    );
    if (JSON.stringify(labels) !== JSON.stringify(['монитор'])) {
      throw new Error('правка монитора названа не одним полем: ' + JSON.stringify(labels));
    }
  });
  if (!save) return;
  await panel.click(save, 800);
  const body = monitorBodyOf(panel);
  check('C1: «Сохранить» отправляет monitor в теле POST', () => {
    if (!Object.hasOwn(body, 'monitor')) throw new Error('в теле нет поля monitor: ' + JSON.stringify(body));
    const expected = [{ provider: 'probe', model: 'probe-1', periods: [{ start: '09:00', end: '13:00', leadMinutes: 30 }] }];
    if (JSON.stringify(body.monitor) !== JSON.stringify(expected)) {
      throw new Error('monitor ушёл не как ожидалось: ' + JSON.stringify(body.monitor));
    }
    if (body.role !== 'тайм-менеджер') throw new Error('прежние поля узла потерялись: ' + JSON.stringify(body));
  });
  check('C1: после успеха панель перечитывает граф и показывает монитор', () => {
    const graphReads = panel.calls.filter((call) => call.method === 'GET' && call.url.startsWith('/api/graph'));
    if (graphReads.length < 2) throw new Error('граф не перечитан после записи: ' + graphReads.length);
    const providerNow = panel.find('[data-monitor-provider]');
    const startNow = panel.find('[data-monitor-start="0"]');
    const endNow = panel.find('[data-monitor-end="0"]');
    const leadNow = panel.find('[data-monitor-lead="0"]');
    if (!providerNow || providerNow.value !== 'probe') throw new Error('сохранённый провайдер не показан: ' + (providerNow && providerNow.value));
    if (!startNow || startNow.value !== '09:00') throw new Error('сохранённый start не показан: ' + (startNow && startNow.value));
    if (!endNow || endNow.value !== '13:00') throw new Error('сохранённый end не показан: ' + (endNow && endNow.value));
    if (!leadNow || leadNow.value !== '30') throw new Error('сохранённый leadMinutes не показан: ' + (leadNow && leadNow.value));
    if (!/сохранён/u.test(panel.text())) throw new Error('линейка не сказала «сохранён»');
  });
  check('C1: перерисовка без исключения', () => {
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
});

/*
 * 2. Прочитанный монитор показан; удаление всех периодов — очистка пустым
 * массивом (задание 0356: «при очистке отправляется пустой массив»).
 */
await withPanel('таймкипер: прочитанный монитор и очистка', async (panel) => {
  await openSettings(panel, 'keeper');
  check('C1: прочитанный монитор показан при открытии узла', () => {
    const provider = panel.find('[data-monitor-provider]');
    const model = panel.find('[data-monitor-model]');
    const start = panel.find('[data-monitor-start="0"]');
    const end = panel.find('[data-monitor-end="0"]');
    const lead = panel.find('[data-monitor-lead="0"]');
    if (!provider || provider.value !== 'probe') throw new Error('провайдер монитора не прочитан: ' + (provider && provider.value));
    if (!model || model.value !== 'probe-2') throw new Error('модель монитора не прочитана: ' + (model && model.value));
    if (!start || start.value !== '18:00') throw new Error('start не прочитан: ' + (start && start.value));
    if (!end || end.value !== '19:00') throw new Error('end не прочитан: ' + (end && end.value));
    if (!lead || lead.value !== '10') throw new Error('leadMinutes не прочитан: ' + (lead && lead.value));
  });
  const remove = panel.find('[data-monitor-remove="0"]');
  check('C1: у прочитанного периода есть «Удалить»', () => {
    if (!remove) throw new Error('нет кнопки «Удалить»');
  });
  if (!remove) return;
  await panel.click(remove, 200);
  check('C1: период удалён из формы', () => {
    if (panel.all('[data-monitor-period]').length !== 0) throw new Error('период остался: ' + panel.all('[data-monitor-period]').length);
  });
  const save = panel.find('[data-editor-save]');
  if (save) await panel.click(save, 700);
  const body = monitorBodyOf(panel);
  check('C1: очистка уходит пустым массивом', () => {
    if (!Object.hasOwn(body, 'monitor')) throw new Error('в теле нет monitor: ' + JSON.stringify(body));
    if (!Array.isArray(body.monitor)) throw new Error('monitor не массив: ' + JSON.stringify(body.monitor));
    if (body.monitor.length !== 0) throw new Error('очистка ушла не пустой: ' + JSON.stringify(body.monitor));
  });
  check('C1: после очистки периодов на экране нет', () => {
    if (panel.all('[data-monitor-period]').length !== 0) throw new Error('период вернулся после сохранения');
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
}, {
  monitor: [{ provider: 'probe', model: 'probe-2', periods: [{ start: '18:00', end: '19:00', leadMinutes: 10 }] }],
});

/*
 * 3. Узел другого вида: секции нет и monitor в тело не попадает — прежнее тело
 * сохранения не меняется (инвариант 2 задания).
 */
await withPanel('воркер: монитора нет', async (panel) => {
  await openSettings(panel, 'worker');
  check('C1: у узла другого вида секции «Монитор» нет', () => {
    if (panel.find('[data-node-monitor]')) throw new Error('секция монитора нарисована у воркера');
    if (panel.find('[data-monitor-provider]')) throw new Error('поле провайдера монитора у воркера');
    const headings = panel.all('[data-node-editor] div').map((node) => (node.textContent || '').trim());
    if (headings.includes('Монитор')) throw new Error('заголовок «Монитор» есть у воркера');
  });
  const brief = panel.find('[data-node-editor] input[aria-label="назначение узла в редакторе"]');
  check('C1: поле назначения доступно', () => {
    if (!brief) throw new Error('нет поля назначения');
  });
  if (!brief) return;
  await panel.type(brief, 'делает другую работу');
  const save = panel.find('[data-editor-save]');
  if (save) await panel.click(save, 700);
  const body = monitorBodyOf(panel);
  check('C1: monitor в тело воркера не отправляется', () => {
    if (Object.hasOwn(body, 'monitor')) throw new Error('monitor ушёл у узла другого вида: ' + JSON.stringify(body.monitor));
    if (body.brief !== 'делает другую работу') throw new Error('прежнее поле назначения не ушло: ' + JSON.stringify(body.brief));
  });
  check('C1: перерисовка без исключения', () => {
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
});

/*
 * 4. Отказ сервера на monitor (400) виден там же, где остальные ошибки записи:
 * запись не притворяется успешной, линейка не зелёная.
 */
await withPanel('таймкипер: отказ 400 показан', async (panel) => {
  await openSettings(panel, 'keeper');
  const add = addPeriodButton(panel);
  if (!add) return;
  await panel.click(add, 200);
  const save = panel.find('[data-editor-save]');
  if (save) await panel.click(save, 700);
  check('C1: недобор монитора ушёл записью, а не молчаливой очисткой', () => {
    const posted = panel.posts().filter((call) => /^\/api\/node\?/u.test(call.url));
    if (posted.length !== 1) throw new Error('POST /api/node: ' + posted.length);
    const body = JSON.parse(posted[0].body || '{}');
    if (!Array.isArray(body.monitor) || body.monitor.length !== 1) {
      throw new Error('панель заменила недобор пустым массивом: ' + JSON.stringify(body.monitor));
    }
    const period = body.monitor[0].periods && body.monitor[0].periods[0];
    if (!period) throw new Error('набранный период не ушёл: ' + JSON.stringify(body.monitor));
    if (body.monitor[0].provider !== '') throw new Error('недобор провайдера не ушёл: ' + JSON.stringify(body.monitor));
  });
  check('C1: отказ сервера назван в форме', () => {
    const text = panel.text();
    if (!/Не удалось сохранить узел/u.test(text)) throw new Error('нет строки ошибки сохранения; на экране: ' + text.slice(0, 400));
    if (!/должен быть временем HH:MM/u.test(text)) throw new Error('отказ сервера не показан словами; на экране: ' + text.slice(0, 400));
    if (!/Впишите начало периода/u.test(text)) throw new Error('нет рецепта из ответа сервера');
  });
  check('C1: отказ не притворяется успехом', () => {
    if (/сохранён/u.test(panel.text())) throw new Error('панель сказала «сохранён» при отказе');
    if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
  });
}, { failNodePost: true });

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const message = failure.error && failure.error.message ? failure.error.message.split('\n') : [String(failure.error)];
  console.error('  ' + message.join('\n  '));
}
console.log('PANEL MONITOR TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
