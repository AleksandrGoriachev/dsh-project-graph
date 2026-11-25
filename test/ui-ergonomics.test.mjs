#!/usr/bin/env node
/**
 * Задание 0337: UI-эргономика проверяется ИСПОЛНЕНИЕМ, а не чтением исходника.
 *
 * Часть A — чистые функции панели: геометрия значка якорей, высота палитры,
 * зажим подвижного окна и модель связи source → target. Часть B поднимает
 * настоящий React + jsdom, кликает по панели, тянет окно за шапку и создаёт
 * связь — так проверяется то, чего не видят строковые проверки.
 *
 * jsdom — devDependency; если пакета нет, набор громко говорит «пропущен» и не
 * врёт про зелёный прогон DOM-части.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const clientPath = process.env.PG_CLIENT || path.join(repo, 'lib', 'client.js');

let passed = 0;
const failures = [];
function check(name, body) {
  try {
    body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : error));
  }
}

/* ---------- A. чистые функции панели (без DOM) ---------- */

function loadBundle() {
  let registered = null;
  const windowStub = { __ModuleLoader__: { load: (entry) => { registered = entry; } } };
  const sandboxRequire = (id) => {
    if (id === 'react') {
      return {
        createElement: () => null,
        Component: class Component { constructor(props) { this.props = props; this.state = {}; } setState() {} },
      };
    }
    throw new Error('unexpected require: ' + id);
  };
  new Function('window', fs.readFileSync(clientPath, 'utf8'))(windowStub);
  if (!registered) throw new Error('бандл не зарегистрировался в загрузчике модулей');
  return registered.factory(sandboxRequire);
}

const module = loadBundle();

check('0337: значок якорей — плитка 16×16 на оси w − 34, точка w − 10', () => {
  const geo = module.__anchorsBadgeGeometry({ x: 100, y: 50, w: 176, h: 62 });
  if (geo.tile.x !== 242 || geo.tile.y !== 64) throw new Error('плитка не на w−34/y14: ' + JSON.stringify(geo.tile));
  if (geo.tile.w !== 16 || geo.tile.h !== 16 || geo.tile.radius !== 4) throw new Error('плитка не 16×16/r4: ' + JSON.stringify(geo.tile));
  if (geo.dot.cx !== 266 || geo.dot.cy !== 60 || geo.dot.r !== 4) throw new Error('точка не w−10/y10/r4: ' + JSON.stringify(geo.dot));
  if (geo.glyph.w !== 12 || geo.glyph.h !== 12) throw new Error('глиф не 12×12: ' + JSON.stringify(geo.glyph));
});

check('0337: плитка и точка не пересекаются — просвет 4 px, до центра 8 px', () => {
  const geo = module.__anchorsBadgeGeometry({ x: 0, y: 0, w: 176, h: 62 });
  const tileRight = geo.tile.x + geo.tile.w; // 142
  const dotLeft = geo.dot.cx - geo.dot.r; // 166
  if (geo.clearanceX !== 4) throw new Error('просвет по x не 4: ' + geo.clearanceX);
  if (dotLeft - tileRight !== 4) throw new Error('арифметика просвета: ' + (dotLeft - tileRight));
  if (geo.gapToDotCenter !== 8) throw new Error('до центра точки не 8: ' + geo.gapToDotCenter);
  if (geo.overlap !== false) throw new Error('площади пересекаются');
  /* Иная ширина карточки не ломает формулу: обе координаты едут вместе. */
  const wide = module.__anchorsBadgeGeometry({ x: 0, y: 0, w: 240, h: 62 });
  if (wide.dot.cx - wide.tile.x !== 24) throw new Error('точка не на +24 от левого края плитки');
  if (wide.clearanceX !== 4) throw new Error('просвет зависит от ширины карточки');
});

check('0337: три состояния значка — цвет плитки/точки и слово', () => {
  const ok = module.__anchorsBadgeVisual('ok');
  if (ok.dot !== 'var(--dsw-alias-state-success-primary, #22c55e)') throw new Error('норма без зелёной точки: ' + ok.dot);
  if (ok.word !== 'норма') throw new Error('норма не названа словом');
  const attention = module.__anchorsBadgeVisual('attention');
  if (!/245,158,11/.test(attention.tileFill) || attention.word !== 'внимание') throw new Error('внимание не оранжевое: ' + JSON.stringify(attention));
  const error = module.__anchorsBadgeVisual('error');
  if (!/236,19,19/.test(error.tileFill) || error.word !== 'ошибка') throw new Error('ошибка не красная');
  const none = module.__anchorsBadgeVisual(null);
  if (none.state !== 'none' || none.tileDash !== '2 2' || none.dot !== null) throw new Error('нет данных не пунктиром: ' + JSON.stringify(none));
});

check('0337: палитра — clamp(320, 100vh−192, 560), scroll только списка', () => {
  const layout = module.__paletteLayout();
  if (layout.heightCss !== 'clamp(320px, calc(100vh - 192px), 560px)') throw new Error('высота не по формуле: ' + layout.heightCss);
  if (layout.box.overflow !== 'hidden') throw new Error('коробка палитры не прячет переполнение');
  if (layout.box.boxSizing !== 'border-box') throw new Error('box-sizing не border-box: высота «поплывёт»');
  if (layout.list.overflowY !== 'auto') throw new Error('у списка нет своего scroll');
  if (layout.list.minHeight !== 0) throw new Error('minHeight: 0 — иначе flex-список не сжимается');
  if (layout.list.overscrollBehavior !== 'contain') throw new Error('scroll не изолирован');
  if (layout.header.flex !== '0 0 auto' || layout.hint.flex !== '0 0 auto') throw new Error('шапка/подсказка входят в прокрутку');
});

check('0337: окно — clamp 8 px от краёв и центр по умолчанию', () => {
  const geo = module.__windowGeometry;
  const viewport = { width: 1024, height: 768 };
  const size = geo.nodeWindowBox(viewport);
  if (size.width !== 560 || size.height !== 520) throw new Error('штатный размер не 560×520: ' + JSON.stringify(size));
  const centered = geo.centeredWindowPosition(size, viewport);
  if (centered.x !== 232 || centered.y !== 124) throw new Error('не по центру: ' + JSON.stringify(centered));
  const topLeft = geo.clampWindowPosition({ x: -500, y: -500 }, size, viewport);
  if (topLeft.x !== 8 || topLeft.y !== 8) throw new Error('не прижато к 8 px: ' + JSON.stringify(topLeft));
  const bottomRight = geo.clampWindowPosition({ x: 99999, y: 99999 }, size, viewport);
  if (bottomRight.x !== 456 || bottomRight.y !== 240) throw new Error('не прижато к правому/нижнему краю: ' + JSON.stringify(bottomRight));
  const style = geo.windowPositionStyle({ x: 132, y: 64 }, size);
  if (style.position !== 'fixed' || style.left !== '132px' || style.top !== '64px' || style.zIndex !== 61) {
    throw new Error('стиль окна не fixed/61: ' + JSON.stringify(style));
  }
  const narrow = geo.nodeWindowBox({ width: 500, height: 500 });
  if (narrow.width !== 484 || narrow.height !== 484) throw new Error('узкий экран не 100vw−16: ' + JSON.stringify(narrow));
  if (geo.settingsWindowBackdropStyle().background !== 'rgba(20,22,26,0.22)') throw new Error('подложка не 0.22 — структура за окном не видна');
});

check('0337: модель связи — source и target явные, ребро from=source/to=target', () => {
  const nodes = [
    { id: 'coordinator', role: 'координатор' },
    { id: 'worker', role: 'исполнитель' },
    { id: 'folder-1', role: 'папка обмена' },
  ];
  const view = module.__linkEditorView({
    nodes,
    picked: 'worker',
    source: '',
    target: '',
    kind: 'delegate',
    edges: [{ from: 'coordinator', to: 'worker', kind: 'delegate' }],
  });
  if (view.source !== 'worker') throw new Error('source по умолчанию не выбранный узел: ' + view.source);
  if (view.target !== 'coordinator') throw new Error('target не первый другой узел: ' + view.target);
  if (view.edge.from !== 'worker' || view.edge.to !== 'coordinator' || view.edge.kind !== 'delegate') {
    throw new Error('ребро не from=source/to=target: ' + JSON.stringify(view.edge));
  }
  if (view.preview.direction !== 'source-to-target') throw new Error('предпросмотр не source→target');
  if (view.preview.from !== 'worker' || view.preview.to !== 'coordinator') throw new Error('чипы предпросмотра перепутаны');
  if (!/coordinator получает работу от worker/.test(view.phrase)) throw new Error('фраза не называет обе стороны: ' + view.phrase);
  if (view.nodes.indexOf('folder-1') >= 0) throw new Error('папка обмена попала в кандидаты связи');
  if (view.listRows.length !== 1 || view.listRows[0].arrow !== '←' || view.listRows[0].other !== 'coordinator') {
    throw new Error('список существующих связей не назвал входящую: ' + JSON.stringify(view.listRows));
  }
});

check('0337: review читается как «цель проверяет источник», а не наоборот', () => {
  const nodes = [{ id: 'worker' }, { id: 'judge' }];
  const forward = module.__linkEditorView({ nodes, picked: 'worker', source: 'worker', target: 'judge', kind: 'review', edges: [] });
  if (!/judge проверяет работу worker/.test(forward.phrase)) throw new Error('review source→target прочитан наоборот: ' + forward.phrase);
  const backward = module.__linkEditorView({ nodes, picked: 'worker', source: 'judge', target: 'worker', kind: 'review', edges: [] });
  if (!/worker проверяет работу judge/.test(backward.phrase)) throw new Error('обратный review прочитан наоборот: ' + backward.phrase);
  if (backward.edge.from !== 'judge' || backward.edge.to !== 'worker') throw new Error('ребро не следует за source/target');
});

check('0337: дубль и «узел сам с собой» не дают создать связь', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }];
  const duplicate = module.__linkEditorView({
    nodes, picked: 'a', source: 'a', target: 'b', kind: 'delegate',
    edges: [{ from: 'a', to: 'b', kind: 'delegate' }],
  });
  if (!duplicate.duplicate || !duplicate.disabled) throw new Error('дубль не распознан');
  if (duplicate.buttonLabel !== 'Такая связь уже есть') throw new Error('кнопка не говорит о дубле: ' + duplicate.buttonLabel);
  const peerDup = module.__linkEditorView({
    nodes, picked: 'a', source: 'a', target: 'b', kind: 'peer',
    edges: [{ from: 'b', to: 'a', kind: 'peer' }],
  });
  if (!peerDup.duplicate) throw new Error('равная связь не распознана в обратном порядке');
  const single = module.__linkEditorView({ nodes: [{ id: 'a' }], picked: 'a', source: 'a', target: 'a', kind: 'delegate', edges: [] });
  if (single.valid || single.target !== '') throw new Error('связь без второго узла осталась допустимой: ' + JSON.stringify(single.edge));
  if (!/нельзя связать узел с собой/.test(module.__linkPhrase('delegate', 'a', 'a'))) throw new Error('фраза не объясняет запрет связи с собой');
});

check('0337: uiStore v4 хранит позиции окон и читает старую запись v1', () => {
  const palette = module.__palette;
  if (palette.UI_STORAGE_KEY !== 'dsh.project-graph.ui.v1') throw new Error('ключ хранилища изменился');
  const old = palette.parseUiState(JSON.stringify({ v: 1, libraryOpen: false, outside: { 'C:/w': 120 } }), 'C:/w');
  if (old.libraryOpen !== false || old.outside !== 120) throw new Error('запись v1 потеряла прежние поля');
  if (!old.windows || Object.keys(old.windows).length !== 0 || old.position !== null) throw new Error('без windows позиция должна быть «не задана»');
  const fresh = palette.parseUiState(JSON.stringify({
    v: 4,
    windows: {
      'C:/w': { node: { x: 132, y: 64 }, folder: { x: 96, y: 88 } },
      'D:/other': { node: { x: 1, y: 2 } },
    },
  }), 'C:/w');
  if (!fresh.position || fresh.position.node.x !== 132 || fresh.position.node.y !== 64) throw new Error('позиция узла не прочитана: ' + JSON.stringify(fresh.position));
  if (fresh.position.folder.x !== 96) throw new Error('позиция папки не прочитана');
  if (palette.parseUiState(JSON.stringify({ v: 2, libraryOpen: false }), 'C:/w').libraryOpen !== true) {
    throw new Error('чужой v должен давать умолчания');
  }
});

check('0337 B2: строка структуры в линейке — покой, сохранено, отказ', () => {
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 'd', to: 'a' }, { from: 'a', to: 'c' }],
  };
  const idle = module.__settingsStructureNote({ graph });
  if (idle.text !== 'структура: 4 узла · 5 связей') throw new Error('покой: ' + idle.text);
  const saved = module.__settingsStructureNote({ graph, saveNote: { tone: 'success', changed: 3 } });
  if (saved.text !== 'сохранено: 3 поля · 4 узла · 5 связей — схема обновлена') throw new Error('сохранено: ' + saved.text);
  const failed = module.__settingsStructureNote({ graph, saveNote: { tone: 'danger', message: 'сервер отказал' } });
  if (failed.text !== 'не сохранено: сервер отказал' || failed.tone !== 'danger') throw new Error('отказ: ' + JSON.stringify(failed));
  if (module.__nodeHighlightDuration(false) !== 1200) throw new Error('подсветка не 1200 ms');
  if (module.__nodeHighlightDuration(true) !== 500) throw new Error('reduced-motion не 500 ms');
});

/* ---------- B. исполнение в DOM (React + jsdom) ---------- */

const ROOT = 'C:\\probe\\ui-ergonomics';
const FOLDER = {
  id: 'folder-1',
  box: { path: 'coordination', root: 'shared' },
  exchange: { contract: 'contract.md' },
  participants: ['structure'],
  orchestrator: 'coordinator',
};
const NODES = [
  { id: 'coordinator', file: 'structure/graph.json', role: 'координатор', brief: 'ведёт план', provider: 'probe', model: 'probe-1' },
  { id: 'worker', file: 'structure/graph.json', role: 'исполнитель', brief: 'делает работу', provider: 'probe', model: 'probe-1' },
];

const localJsdom = path.join(repo, '.tmp', 'jsdom', 'node_modules', 'jsdom', 'lib', 'api.js');
let jsdomModule = null;
let jsdomFrom = 'jsdom';
try {
  jsdomModule = await import('jsdom');
} catch {
  const override = process.env.PG_JSDOM || (fs.existsSync(localJsdom) ? localJsdom : null);
  if (override) {
    jsdomFrom = override;
    jsdomModule = await import(pathToFileURL(override).href);
  }
}

if (!jsdomModule) {
  console.log('UI ERGONOMICS: DOM-часть ПРОПУЩЕНА — нет jsdom. Выполните pnpm install (devDependencies) или задайте PG_JSDOM.');
  console.log('UI ERGONOMICS: чистые проверки — ' + passed + ', провалов — ' + failures.length);
  process.exit(failures.length === 0 ? 0 : 1);
}

const { JSDOM } = jsdomModule;
const require = createRequire(path.join(repo, 'package.json'));
const React = require('react');
const ReactDOM = require('react-dom/client');
const testUtils = require('react-dom/test-utils');
const act = React.act || testUtils.act;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function mountPanel(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const win = dom.window;
  const calls = [];
  const errors = [];
  win.addEventListener('error', (event) => errors.push(String((event && event.error && event.error.message) || 'error')));
  win.confirm = () => false;
  win.matchMedia = (query) => ({
    matches: false, media: String(query || ''),
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

  let graph = {
    exists: true,
    root: ROOT,
    structureDir: 'structure',
    sources: [{ file: 'structure/graph.json', models: 1, nodes: 2, edges: 1, folders: 1 }],
    graph: {
      version: 1,
      models: { work: { provider: 'probe', model: 'probe-1' } },
      nodes: NODES,
      edges: [{ from: 'coordinator', to: 'worker', kind: 'delegate' }],
      folders: [FOLDER],
    },
    layout: {
      nodes: [
        { id: 'coordinator', x: 4, y: 0, w: 176, h: 62, layer: 0, cyclic: false },
        { id: 'worker', x: 102, y: 118, w: 176, h: 62, layer: 1, cyclic: false },
      ],
      edges: [], width: 400, height: 220, layers: 2, cyclic: [],
    },
    selfNode: 'coordinator',
  };
  if (Array.isArray(options.edges)) graph.graph.edges = options.edges;
  if (Array.isArray(options.nodes)) graph.graph.nodes = options.nodes;
  if (Array.isArray(options.layoutNodes)) graph.layout.nodes = options.layoutNodes;
  const body = (value) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(value) });
  win.fetch = (input, fetchOptions) => {
    const url = String(input).replace(/^\/project-graph/, '');
    const method = (fetchOptions && fetchOptions.method) || 'GET';
    calls.push({ method, url, body: (fetchOptions && fetchOptions.body) || null });
    if (url.startsWith('/api/status')) {
      return body({
        roots: [ROOT], defaultRoot: ROOT, structureDir: 'structure',
        edgeKinds: ['delegate', 'review', 'peer', 'report'],
        workspaces: [{ label: 'structure', path: ROOT, name: 'ui-ergonomics' }],
      });
    }
    if (url.startsWith('/api/projects')) {
      return body({ projects: [{ root: ROOT, name: 'ui-ergonomics', exists: true, hasStructure: true, nodes: 2, edges: 1, errors: 0, warnings: 0 }] });
    }
    if (url.startsWith('/api/graph')) return body(graph);
    if (url.startsWith('/api/models')) {
      return body({ providers: [{ id: 'probe', name: 'probe', models: [{ id: 'probe-1', name: 'probe-1' }] }] });
    }
    if (url.startsWith('/api/node') && method === 'POST') {
      if (options.nodeSaveError) return Promise.reject(new Error(options.nodeSaveError));
      return body({ ok: true });
    }
    if (url.startsWith('/api/anchors')) {
      return body(options.anchors || {});
    }
    if (url.startsWith('/api/obligations')) return body({ ok: true, obligations: [] });
    if (url.startsWith('/api/exchange/scan')) return body({ ok: true, unread: [], seen: 0, skipped: [], boxes: [], obligations: [] });
    if (url.startsWith('/api/exchange?')) {
      return body({ root: ROOT, label: 'structure', participants: ['structure'], sources: [], total: 0, unparsed: 0, facts: [], links: [], folders: [] });
    }
    if (url.startsWith('/api/activity')) return body({ root: ROOT, runs: [] });
    if (url.startsWith('/api/live')) {
      const active = Array.isArray(options.liveActive) ? options.liveActive : [];
      return body({ root: ROOT, label: 'structure', sessions: { running: 0, items: [] }, total: 0, agents: [], active, unknown: [] });
    }
    if (url.startsWith('/api/link')) return body({ ok: true, added: true });
    if (url.startsWith('/workflow/api/status')) return body({ installed: false });
    return body({});
  };
  globalThis.fetch = win.fetch;

  let entry = null;
  win.__ModuleLoader__ = { load: (value) => { entry = value; } };
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
        workspaces: { list: { getSnapshot: () => ({ items: [{ id: ROOT, path: ROOT, title: 'ui-ergonomics', sessionIds: ['s1'] }] }) } },
        mainReference: { sessionId: 's1' },
        selection: { getSnapshot: () => ({ sessionId: 's1' }) },
      },
    }),
    slots: { inject: (name, run) => run(), register: (descriptor, component) => { View = component; return () => {}; } },
  });

  const container = win.document.getElementById('root');
  const reactRoot = ReactDOM.createRoot(container);
  const settle = async (ms = 120) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  const render = async () => {
    await act(async () => { reactRoot.render(React.createElement(View)); });
    await settle(350);
  };
  const click = async (element, ms = 200) => {
    if (!element) throw new Error('клик по отсутствующему элементу');
    await act(async () => {
      element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };
  const pointer = async (element, type, clientX, clientY) => {
    if (!element) throw new Error('pointer ' + type + ' по отсутствующему элементу');
    await act(async () => {
      element.dispatchEvent(new win.MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX, clientY,
      }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  };
  const dblclick = async (element) => {
    await act(async () => {
      element.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
  };
  const key = async (element, name, extra = {}) => {
    await act(async () => {
      element.dispatchEvent(new win.KeyboardEvent('keydown', {
        key: name, bubbles: true, cancelable: true, ...extra,
      }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  };
  const type = async (element, value) => {
    if (!element) throw new Error('ввод в отсутствующее поле');
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    await act(async () => {
      testUtils.Simulate.change(element);
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  };
  const choose = async (element, value) => {
    if (!element) throw new Error('выбор в отсутствующем select');
    const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set;
    setter.call(element, value);
    await act(async () => {
      testUtils.Simulate.change(element);
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
  };
  const find = (selector) => container.querySelector(selector);
  const all = (selector) => Array.from(container.querySelectorAll(selector));
  const close = async () => {
    try { await act(async () => { reactRoot.unmount(); }); } catch { /* уже снят */ }
    win.close();
  };
  return { win, client, calls, errors, render, click, pointer, dblclick, key, type, choose, find, all, close };
}

async function withPanel(scenario, options = {}) {
  const panel = await mountPanel(options);
  try {
    await panel.render();
    await scenario(panel);
    check('0337: перерисовка панели без исключения', () => {
      if (panel.errors.length > 0) throw new Error('ошибка DOM: ' + panel.errors.join('; '));
    });
  } finally {
    await panel.close();
  }
}

await withPanel(async (panel) => {
  /* Значок якорей: настоящие атрибуты SVG, а не строки исходника. */
  const badge = panel.find('[data-anchors-badge]');
  check('0337: значок якорей нарисован на карточке координатора', () => {
    if (!badge) throw new Error('нет [data-anchors-badge]');
    if (badge.getAttribute('data-anchors-badge-state') !== 'ok') throw new Error('состояние значка: ' + badge.getAttribute('data-anchors-badge-state'));
    if (!/Якоря: норма/.test(badge.getAttribute('aria-label') || '')) throw new Error('состояние не названо словом: ' + badge.getAttribute('aria-label'));
  });
  const tile = panel.find('[data-anchors-badge-tile]');
  const dot = panel.find('[data-anchors-badge-dot]');
  check('0337: плитка x=146/y=14 16×16, точка cx=170/cy=10 r=4 (координатор x=4, w=176)', () => {
    if (!tile) throw new Error('нет плитки якоря');
    const attrs = ['x', 'y', 'width', 'height', 'rx'].map((name) => Number(tile.getAttribute(name)));
    if (attrs[0] !== 146 || attrs[1] !== 14 || attrs[2] !== 16 || attrs[3] !== 16 || attrs[4] !== 4) {
      throw new Error('плитка не 16×16/r4 на w−34,y14: ' + JSON.stringify(attrs));
    }
    if (!dot) throw new Error('нет точки активности — состояние видно только цветом плитки');
    const cx = Number(dot.getAttribute('cx'));
    const cy = Number(dot.getAttribute('cy'));
    const r = Number(dot.getAttribute('r'));
    if (cx !== 170 || cy !== 10 || r !== 4) throw new Error('точка не cx=170/cy=10/r=4: ' + [cx, cy, r].join(','));
    if ((cx - r) - (attrs[0] + attrs[2]) !== 4) throw new Error('точка пересекает плитку: просвет ' + ((cx - r) - (attrs[0] + attrs[2])));
  });
  check('0337: якорь — силуэт из линий, а не текстовый глиф', () => {
    const glyph = panel.find('[data-anchors-badge-glyph]');
    if (!glyph) throw new Error('нет силуэта якоря');
    if (glyph.querySelector('text')) throw new Error('якорь нарисован текстом');
    const shapes = glyph.querySelectorAll('circle, path');
    if (shapes.length !== 4) throw new Error('силуэт не из четырёх линий: ' + shapes.length);
    if (Number(glyph.getAttribute('stroke-width')) !== 1.5) throw new Error('вес линии не 1.5: ' + glyph.getAttribute('stroke-width'));
  });
  check('0337: шестерёнка — та же плитка 16×16 и ось w−34', () => {
    const gear = panel.find('[data-node-gear="coordinator"]');
    if (!gear) throw new Error('нет шестерёнки');
    const text = gear.querySelector('text');
    if (!text || Number(text.getAttribute('x')) !== 150 || Number(text.getAttribute('y')) !== 47) {
      throw new Error('глиф шестерёнки не в центре плитки: ' + (text ? text.getAttribute('x') + ',' + text.getAttribute('y') : 'нет'));
    }
    const gearTile = gear.querySelector('[data-node-gear-tile]');
    if (!gearTile) throw new Error('у шестерёнки нет плитки');
    if (Number(gearTile.getAttribute('x')) !== 142 || Number(gearTile.getAttribute('y')) !== 34) {
      throw new Error('плитка шестерёнки не на w−34/y34: ' + gearTile.getAttribute('x') + ',' + gearTile.getAttribute('y'));
    }
  });

  /* Палитра: своя высота, свой scroll списка, подсказка вне прокрутки. */
  const palette = panel.find('[data-library="palette"]');
  const list = panel.find('[data-library-list]');
  check('0337: палитра ограничена по высоте и прячет переполнение', () => {
    if (!palette) throw new Error('нет палитры');
    if (palette.getAttribute('data-library-height') !== 'clamp(320px, calc(100vh - 192px), 560px)') {
      throw new Error('height не по формуле: ' + palette.getAttribute('data-library-height'));
    }
    if (palette.style.overflow !== 'hidden') throw new Error('палитра не прячет переполнение — низ уедет');
    if (palette.style.boxSizing !== 'border-box') throw new Error('высота без border-box');
  });
  check('0337: прокручивается только список, шапка и подсказка — нет', () => {
    if (!list) throw new Error('нет контейнера списка');
    if (list.style.overflowY !== 'auto') throw new Error('список не прокручивается: overflow-y=' + list.style.overflowY);
    if (list.style.minHeight !== '0px') throw new Error('min-height не 0 — flex-список не сожмётся: ' + list.style.minHeight);
    if (list.style.flex !== '1 1 auto') throw new Error('список не забирает высоту: ' + list.style.flex);
    const hint = Array.from(palette.children).find((child) => /Перетащите карточку/u.test(child.textContent || ''));
    if (!hint) throw new Error('подсказка палитры не найдена');
    if (list.contains(hint)) throw new Error('подсказка прокручивается вместе со списком');
    if (!list.textContent || !/Критик/u.test(list.textContent)) throw new Error('в списке нет карточек');
    if (palette.parentElement && palette.parentElement.style.alignItems !== 'stretch') throw new Error('строка палитры растягивает коробку по содержимому');
  });

  /* Окно настроек: открывается по центру, тянется за шапку, позиция сохраняется. */
  await panel.click(panel.find('[data-node="worker"]'));
  await panel.click(panel.find('[data-node-gear="worker"]'));
  const dialog = panel.find('[data-settings-window="node"]');
  const header = dialog ? dialog.querySelector('[data-settings-drag-handle]') : null;
  check('0337: окно узла — fixed по центру экрана 1024×768', () => {
    if (!dialog) throw new Error('окно узла не открылось');
    if (dialog.style.position !== 'fixed') throw new Error('окно не fixed: ' + dialog.style.position);
    if (dialog.style.left !== '232px' || dialog.style.top !== '124px') {
      throw new Error('окно не по центру: ' + dialog.style.left + ', ' + dialog.style.top);
    }
    if (dialog.style.zIndex !== '61') throw new Error('слой окна не 61: ' + dialog.style.zIndex);
    if (!header) throw new Error('у шапки нет drag-handle — окно не за что тянуть');
  });
  if (!dialog || !header) return;

  await panel.pointer(header, 'pointerdown', 300, 120);
  await panel.pointer(panel.win, 'pointermove', 360, 160);
  await panel.pointer(panel.win, 'pointerup', 360, 160);
  check('0337: перетаскивание за шапку двигает окно 1:1 и сохраняет позицию', () => {
    if (dialog.style.left !== '292px' || dialog.style.top !== '164px') {
      throw new Error('окно не сдвинулось на 60×40: ' + dialog.style.left + ', ' + dialog.style.top);
    }
    const raw = panel.win.localStorage.getItem('dsh.project-graph.ui.v1');
    if (!raw) throw new Error('позиция не записана в uiStore');
    const stored = JSON.parse(raw);
    if (stored.v !== 4) throw new Error('версия хранилища не 4: ' + stored.v);
    const pos = stored.windows && stored.windows[ROOT] && stored.windows[ROOT].node;
    if (!pos || pos.x !== 292 || pos.y !== 164) throw new Error('позиция узла не сохранена: ' + JSON.stringify(pos));
  });

  await panel.pointer(header, 'pointerdown', 400, 200);
  await panel.pointer(panel.win, 'pointermove', 5000, 5000);
  await panel.pointer(panel.win, 'pointerup', 5000, 5000);
  check('0337: за край окно не уезжает — clamp 8 px', () => {
    if (dialog.style.left !== '456px' || dialog.style.top !== '240px') {
      throw new Error('окно вышло за экран: ' + dialog.style.left + ', ' + dialog.style.top);
    }
  });

  await panel.dblclick(header);
  check('0337: двойной щелчок по шапке возвращает окно по центру', () => {
    if (dialog.style.left !== '232px' || dialog.style.top !== '124px') {
      throw new Error('окно не вернулось по центру: ' + dialog.style.left + ', ' + dialog.style.top);
    }
  });

  await panel.key(header, 'ArrowRight');
  check('0337: стрелка двигает окно на 8 px и пишет позицию', () => {
    if (dialog.style.left !== '240px' || dialog.style.top !== '124px') {
      throw new Error('стрелка не сдвинула окно: ' + dialog.style.left + ', ' + dialog.style.top);
    }
    const stored = JSON.parse(panel.win.localStorage.getItem('dsh.project-graph.ui.v1'));
    if (stored.windows[ROOT].node.x !== 240) throw new Error('позиция после стрелки не сохранена');
  });

  await panel.pointer(header, 'pointerdown', 300, 300);
  await panel.pointer(panel.win, 'pointermove', 350, 350);
  await panel.key(panel.win.document.body, 'Escape');
  check('0337: Esc во время перетаскивания отменяет жест, а не закрывает окно', () => {
    if (!panel.find('[data-settings-window="node"]')) throw new Error('Esc закрыл окно вместо отмены жеста');
    if (dialog.style.left !== '240px' || dialog.style.top !== '124px') {
      throw new Error('позиция после отмены не вернулась: ' + dialog.style.left + ', ' + dialog.style.top);
    }
  });
  await panel.pointer(panel.win, 'pointerup', 350, 350);

  /* Связь: два видимых узла, стрелка source → target, список и запись. */
  await panel.click(panel.find('[data-bottom-link]'));
  const card = panel.find('[data-link-card]');
  check('0337: карточка связи показывает source и target, а не «от/к»', () => {
    if (!card) throw new Error('карточка связи не открылась');
    const source = card.querySelector('[data-link-source]');
    const target = card.querySelector('[data-link-target]');
    if (!source || !target) throw new Error('нет двух полей source/target');
    if (source.value !== 'worker') throw new Error('source не выбранный узел: ' + source.value);
    if (target.value !== 'coordinator') throw new Error('target не первый другой узел: ' + target.value);
    if (card.querySelector('select[data-link-direction]')) throw new Error('остался скрытый переключатель направления');
    if (/от этого узла|к этому узлу/u.test(card.textContent || '')) throw new Error('в карточке остались относительные подписи «от/к»');
    const targetOptions = Array.from(target.options).map((option) => option.value);
    if (targetOptions.indexOf('worker') >= 0) throw new Error('target предлагает сам source');
  });
  const preview = card ? card.querySelector('[data-link-preview]') : null;
  check('0337: предпросмотр стрелки читается слева направо source → target', () => {
    if (!preview) throw new Error('нет предпросмотра стрелки');
    if (preview.getAttribute('data-link-from') !== 'worker' || preview.getAttribute('data-link-to') !== 'coordinator') {
      throw new Error('чипы не source→target: ' + preview.getAttribute('data-link-from') + ' → ' + preview.getAttribute('data-link-to'));
    }
    if (preview.getAttribute('data-link-direction') !== 'source-to-target') throw new Error('направление предпросмотра не названо');
    if (!preview.querySelector('[data-link-arrow]')) throw new Error('у стрелки нет наконечника у target');
    const phrase = card.querySelector('[data-link-phrase]');
    if (!phrase || !/coordinator получает работу от worker/.test(phrase.textContent || '')) {
      throw new Error('фраза смысла не называет обе стороны: ' + (phrase ? phrase.textContent : 'нет'));
    }
    const submit = card.querySelector('[data-link-submit]');
    if (!submit || !/Создать: worker → coordinator \(delegate\)/u.test(submit.textContent || '')) {
      throw new Error('подпись кнопки не называет, что создаётся: ' + (submit ? submit.textContent : 'нет'));
    }
  });
  check('0337: существующие связи узла перечислены до создания', () => {
    const listNode = card ? card.querySelector('[data-existing-links]') : null;
    if (!listNode) throw new Error('нет списка существующих связей');
    const rows = listNode.querySelectorAll('[data-existing-link]');
    if (rows.length !== 1) throw new Error('ожидалась одна связь worker, найдено ' + rows.length);
    const text = rows[0].textContent || '';
    if (!/←/u.test(text) || !/coordinator/u.test(text) || !/получает работу/u.test(text)) {
      throw new Error('входящая связь не объяснена: ' + text);
    }
  });

  await panel.click(card.querySelector('[data-link-kind="review"]'));
  check('0337: review читается «target проверяет source», а не наоборот', () => {
    if (preview.getAttribute('data-link-kind') !== 'review') throw new Error('вид не переключился');
    const phrase = card.querySelector('[data-link-phrase]');
    if (!/coordinator проверяет работу worker/.test(phrase.textContent || '')) {
      throw new Error('review прочитан наоборот: ' + (phrase ? phrase.textContent : 'нет'));
    }
    const submit = card.querySelector('[data-link-submit]');
    if (!/Создать: worker → coordinator \(review\)/u.test(submit.textContent || '')) {
      throw new Error('кнопка не назвала вид review: ' + submit.textContent);
    }
  });

  await panel.click(card.querySelector('[data-link-swap]'));
  check('0337: обмен местами меняет source и target и фразу, а не только подписи', () => {
    const source = card.querySelector('[data-link-source]');
    const target = card.querySelector('[data-link-target]');
    if (source.value !== 'coordinator' || target.value !== 'worker') throw new Error('обмен не сработал: ' + source.value + ' → ' + target.value);
    if (preview.getAttribute('data-link-from') !== 'coordinator' || preview.getAttribute('data-link-to') !== 'worker') throw new Error('предпросмотр не поменялся');
    const phrase = card.querySelector('[data-link-phrase]');
    if (!/worker проверяет работу coordinator/.test(phrase.textContent || '')) throw new Error('фраза не пересчитана: ' + phrase.textContent);
    const submit = card.querySelector('[data-link-submit]');
    if (!/Создать: coordinator → worker \(review\)/u.test(submit.textContent || '')) throw new Error('кнопка не пересчитана: ' + submit.textContent);
  });

  await panel.click(card.querySelector('[data-link-submit]'), 350);
  check('0337: запись уходит ровно той парой, что видна на экране', () => {
    const posts = panel.calls.filter((call) => call.method === 'POST' && /\/api\/link\?/u.test(call.url));
    if (posts.length !== 1) throw new Error('ожидался один POST /api/link, получено ' + posts.length);
    const url = posts[0].url;
    if (!/from=coordinator/u.test(url) || !/to=worker/u.test(url) || !/kind=review/u.test(url)) {
      throw new Error('запись не совпала с экраном: ' + url);
    }
    const result = panel.find('[data-link-result]');
    if (!result) throw new Error('нет строки «Создано: …» после записи');
    if (!/Создано: coordinator → worker/u.test(result.textContent || '')) throw new Error('строка успеха не называет ребро: ' + result.textContent);
  });
}, {
  anchors: { badge: { state: 'ok', counts: { anchors: 2, assigned: 2 }, anchors: [], errors: [], attention: [] } },
});

/* B1: список связей в «Настройках» читает ту же модель, что карточка. */
await withPanel(async (panel) => {
  await panel.click(panel.find('[data-node="worker"]'));
  await panel.click(panel.find('[data-node-gear="worker"]'));
  await panel.click(panel.find('[data-node-info-edit]'));
  const list = panel.find('[data-editor-links]');
  const row = list ? list.querySelector('[data-editor-link]') : null;
  check('0337 B1: входящая review-связь в «Настройках» — «цель проверяет источник»', () => {
    if (!row) throw new Error('нет строки связи в окне «Настройки»');
    const text = row.textContent || '';
    if (!/← coordinator/u.test(text) || !/review/u.test(text) || !/проверяет работу другого/u.test(text)) {
      throw new Error('строка не назвала смысл review по новой модели: ' + text);
    }
    if (/вас проверяют/u.test(text)) throw new Error('остался старый противоположный текст: ' + text);
  });
  await panel.click(panel.find('[data-node-info-close]'));
  await panel.click(panel.find('[data-node="coordinator"]'));
  await panel.click(panel.find('[data-node-gear="coordinator"]'));
  await panel.click(panel.find('[data-node-info-edit]'));
  const outRow = panel.find('[data-editor-link]');
  check('0337 B1: исходящая review-связь — «его работу проверяют», не «вы проверяете»', () => {
    if (!outRow) throw new Error('нет строки исходящей связи');
    const text = outRow.textContent || '';
    if (!/→ worker/u.test(text) || !/его работу проверяют/u.test(text)) {
      throw new Error('исходящая review прочитана неверно: ' + text);
    }
    if (/вы проверяете работу/u.test(text)) throw new Error('остался старый текст «вы проверяете»: ' + text);
  });
}, {
  anchors: { badge: { state: 'ok', counts: { anchors: 2, assigned: 2 }, anchors: [], errors: [], attention: [] } },
  edges: [{ from: 'coordinator', to: 'worker', kind: 'review' }],
});

/* B2 + N1: сохранение не закрывает окно, линейка и подсветка, пилюля; одна точка. */
await withPanel(async (panel) => {
  await panel.click(panel.find('[data-node="worker"]'));
  await panel.click(panel.find('[data-node-gear="worker"]'));
  await panel.click(panel.find('[data-node-info-edit]'));
  const dialog = panel.find('[data-settings-window="node"]');
  const footer = panel.find('[data-settings-footer]');
  check('0337 B2: в линейке покоя — «структура: N узлов · M связей»', () => {
    const structure = footer ? footer.querySelector('[data-settings-structure]') : null;
    if (!structure) throw new Error('в линейке нет строки структуры');
    if (structure.textContent !== 'структура: 2 узла · 1 связь') throw new Error('строка структуры: ' + structure.textContent);
    if (structure.getAttribute('role') !== 'status') throw new Error('строка структуры не объявляется статусом');
  });
  const roleInput = panel.find('[data-node-editor] input[aria-label="роль узла в редакторе"]');
  await panel.type(roleInput, 'исполнитель 2');
  const before = dialog ? dialog.style.left : null;
  await panel.click(panel.find('[data-editor-save]'), 450);
  check('0337 B2: после «Сохранить» окно не закрылось и не прыгнуло', () => {
    const again = panel.find('[data-settings-window="node"]');
    if (!again) throw new Error('окно закрылось после сохранения');
    if (before && again.style.left !== before) throw new Error('окно прыгнуло: ' + before + ' → ' + again.style.left);
    if (!panel.find('[data-node-editor]')) throw new Error('форма настроек исчезла');
  });
  check('0337 B2: линейка сказала «сохранено: … — схема обновлена»', () => {
    const structure = panel.find('[data-settings-structure]');
    if (!structure) throw new Error('нет строки структуры');
    const text = structure.textContent || '';
    if (!/^сохранено: 1 поле/u.test(text)) throw new Error('не названо число полей: ' + text);
    if (!/2 узла · 1 связь — схема обновлена$/u.test(text)) throw new Error('не названы узлы/связи: ' + text);
    if (structure.getAttribute('data-settings-structure-tone') !== 'success') throw new Error('тон строки не success');
  });
  check('0337 B2: изменённый узел подсвечен кольцом 2 px T.success', () => {
    const ring = panel.find('[data-node-highlight="worker"]');
    if (!ring) throw new Error('нет подсветки изменённого узла');
    if (ring.getAttribute('stroke-width') !== '2') throw new Error('кольцо не 2 px: ' + ring.getAttribute('stroke-width'));
  });
  await panel.click(panel.find('[data-settings-minimize]'), 250);
  check('0337 B2: «Свернуть» уводит окно в пилюлю 220×36, схема остаётся', () => {
    if (panel.find('[data-settings-window="node"]')) throw new Error('окно не свернулось');
    const pill = panel.find('[data-settings-pill="worker"]');
    if (!pill) throw new Error('нет пилюли свёрнутого окна');
    if (pill.style.width !== '220px' || pill.style.height !== '36px') throw new Error('пилюля не 220×36: ' + pill.style.width + '×' + pill.style.height);
    if (pill.style.zIndex !== '61') throw new Error('пилюля не на слое 61');
    if (panel.find('[role="dialog"]')) throw new Error('модальный диалог/подложка остались — схема недоступна');
  });
  await panel.click(panel.find('[data-settings-pill="worker"]'), 250);
  check('0337 B2: пилюля разворачивает окно на прежнее место', () => {
    const again = panel.find('[data-settings-window="node"]');
    if (!again) throw new Error('окно не развернулось из пилюли');
    if (again.style.left !== '232px' || again.style.top !== '124px') throw new Error('окно потеряло позицию: ' + again.style.left + ', ' + again.style.top);
  });
  check('0337 N1: у координатора одна точка — точка значка, а не активности', () => {
    if (!panel.find('[data-anchors-badge-dot]')) throw new Error('нет точки значка якорей');
    if (panel.find('[data-node-activity-dot="coordinator"]')) throw new Error('точка активности дублирует точку значка');
    /* Ровно одна окружность в точке (w−10,10): две точки не рисуются друг поверх друга. */
    const dots = panel.all('circle').filter((circle) =>
      Number(circle.getAttribute('cx')) === 170 && Number(circle.getAttribute('cy')) === 10);
    if (dots.length !== 1) throw new Error('в точке координатора не одна окружность: ' + dots.length);
    /* У обычного узла точка активности остаётся его собственной. */
    if (!panel.find('[data-node-activity-dot="worker"]')) throw new Error('у активного worker пропала точка активности');
  });
}, {
  anchors: { badge: { state: 'ok', counts: { anchors: 2, assigned: 2 }, anchors: [], errors: [], attention: [] } },
  liveActive: ['coordinator', 'worker'],
});

/* B2: отказ записи — красная строка «не сохранено», подсветки нет. */
await withPanel(async (panel) => {
  await panel.click(panel.find('[data-node="worker"]'));
  await panel.click(panel.find('[data-node-gear="worker"]'));
  await panel.click(panel.find('[data-node-info-edit]'));
  await panel.type(panel.find('[data-node-editor] input[aria-label="роль узла в редакторе"]'), 'исполнитель 2');
  await panel.click(panel.find('[data-editor-save]'), 450);
  check('0337 B2: отказ записи виден в линейке, успеха и подсветки нет', () => {
    const structure = panel.find('[data-settings-structure]');
    if (!structure) throw new Error('нет строки структуры');
    if (!/^не сохранено: сервер отказал/u.test(structure.textContent || '')) throw new Error('отказ не назван: ' + structure.textContent);
    if (structure.getAttribute('data-settings-structure-tone') !== 'danger') throw new Error('тон отказа не danger');
    if (panel.find('[data-node-highlight]')) throw new Error('подсветка показана при отказе');
    if (!panel.find('[data-settings-window="node"]')) throw new Error('окно закрылось при отказе');
  });
}, {
  anchors: { badge: { state: 'ok', counts: { anchors: 2, assigned: 2 }, anchors: [], errors: [], attention: [] } },
  nodeSaveError: 'сервер отказал',
});

/* N3: смена source чистит target — цель выбирается заново. */
const THREE_NODES = [
  { id: 'coordinator', file: 'structure/graph.json', role: 'координатор', brief: 'ведёт план', provider: 'probe', model: 'probe-1' },
  { id: 'worker', file: 'structure/graph.json', role: 'исполнитель', brief: 'делает работу', provider: 'probe', model: 'probe-1' },
  { id: 'judge', file: 'structure/graph.json', role: 'приёмщик', brief: 'проверяет', provider: 'probe', model: 'probe-1' },
];
await withPanel(async (panel) => {
  await panel.click(panel.find('[data-node="worker"]'));
  await panel.click(panel.find('[data-bottom-link]'));
  const card = panel.find('[data-link-card]');
  if (!card) return;
  const source = card.querySelector('[data-link-source]');
  const target = card.querySelector('[data-link-target]');
  await panel.choose(target, 'judge');
  check('0337 N3: цель можно выбрать явно', () => {
    if (target.value !== 'judge') throw new Error('target не выбран: ' + target.value);
  });
  await panel.choose(source, 'coordinator');
  check('0337 N3: смена source чистит target и он выбирается заново', () => {
    if (source.value !== 'coordinator') throw new Error('source не сменился');
    if (target.value !== 'worker') throw new Error('target остался старым/стал source: ' + target.value);
    const phrase = card.querySelector('[data-link-phrase]');
    if (!/worker получает работу от coordinator/.test(phrase.textContent || '')) throw new Error('фраза не пересчитана: ' + phrase.textContent);
  });
}, {
  anchors: { badge: { state: 'ok', counts: { anchors: 2, assigned: 2 }, anchors: [], errors: [], attention: [] } },
  nodes: THREE_NODES,
  layoutNodes: [
    { id: 'coordinator', x: 4, y: 0, w: 176, h: 62, layer: 0, cyclic: false },
    { id: 'worker', x: 102, y: 118, w: 176, h: 62, layer: 1, cyclic: false },
    { id: 'judge', x: 200, y: 236, w: 176, h: 62, layer: 2, cyclic: false },
  ],
  edges: [],
});

console.log('UI ERGONOMICS OK: ' + passed + ' проверок');
if (failures.length > 0) {
  console.error('UI ERGONOMICS FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
