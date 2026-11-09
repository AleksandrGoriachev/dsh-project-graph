
/**
 * Снимок ТЕКУЩЕЙ панели (до правки): рендер lib/client.js в jsdom и выгрузка
 * готового DOM в статичный HTML. Нужен, чтобы «было» на листе было настоящим
 * рендером, а не пересказом кода.
 *
 *   node tools/render-current.mjs  ->  tools/current-panel.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = 'C:/Users/Goryachev/Documents/deepseek-harness/dsh-project-graph';
const jsdomPath = path.join(repo, '.tmp', 'jsdom', 'node_modules', 'jsdom', 'lib', 'api.js');
const { JSDOM } = await import(pathToFileURL(jsdomPath).href);
const require = createRequire(path.join(repo, 'package.json'));
const React = require('react');
const ReactDOM = require('react-dom/client');
const testUtils = require('react-dom/test-utils');
const act = React.act || testUtils.act;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = 'C:\\probe\\validator-workspace';
const FOLDER = {
  id: 'folder-1',
  box: { path: 'coordination', root: 'shared' },
  exchange: { contract: 'contract.md' },
  participants: ['structure'],
  orchestrator: 'coordinator',
};
const NODES = [
  { id: 'coordinator', file: 'structure/graph.json', role: 'координатор', brief: 'ведёт план и раздаёт работу', model: 'work' },
  { id: 'worker', file: 'structure/graph.json', role: 'исполнитель', brief: 'делает основную работу', model: 'work' },
  { id: 'judge', file: 'structure/graph.json', role: 'приёмщик', brief: 'проверяет работу', model: 'critic' },
  { id: 'critic', file: 'structure/graph.json', role: 'критик', brief: 'разбирает прогон', model: 'critic' },
];
const LAYOUT = {
  nodes: [
    { id: 'coordinator', x: 0, y: 0, w: 176, h: 62, layer: 0, cyclic: false },
    { id: 'judge', x: 0, y: 96, w: 176, h: 62, layer: 0, cyclic: false },
    { id: 'worker', x: 380, y: 0, w: 176, h: 62, layer: 1, cyclic: false },
    { id: 'critic', x: 380, y: 96, w: 176, h: 62, layer: 1, cyclic: false },
  ],
  edges: [],
  width: 620,
  height: 200,
  layers: 2,
  cyclic: [],
};
const FINDINGS = [
  { code: 'duplicate-edge', severity: 'error', file: 'structure/graph.json', line: 12, message: 'связь coordinator → worker объявлена дважды', fix: { kind: 'safe', description: 'снять точный дубль' } },
  { code: 'model-missing', severity: 'error', file: 'structure/graph.json', line: 24, message: 'провайдер не подтвердил модель glm-5.3-flash', fix: { kind: 'choice', description: 'выбрать модель из списка провайдера' } },
  { code: 'no-acceptor', severity: 'warning', file: 'structure/graph.json', line: 31, message: 'у worker нет приёмщика', fix: { kind: 'choice', description: 'добавить review-связь' } },
  { code: 'dangling-edge', severity: 'error', file: 'structure/graph.json', line: 44, message: 'связь ведёт в несуществующий узел judge-1', fix: { kind: 'choice', description: 'удалить связь или объявить узел' } },
];

const mode = process.argv[2] || 'findings';
const graph = {
  exists: true,
  root: ROOT,
  structureDir: 'structure',
  sources: [{ file: 'structure/graph.json', models: 2, nodes: 4, edges: 3, folders: 1 }],
  graph: {
    version: 1,
    models: { work: { provider: 'probe', model: 'deepseek-v4.1' }, critic: { provider: 'probe', model: 'glm-5.3-flash' } },
    nodes: NODES,
    edges: [
      { from: 'coordinator', to: 'worker', kind: 'delegate' },
      { from: 'worker', to: 'judge', kind: 'review' },
      { from: 'judge', to: 'critic', kind: 'peer' },
    ],
    folders: [FOLDER],
  },
  layout: LAYOUT,
  selfNode: null,
  validation: mode === 'clean' ? { findings: [], ok: true } : { findings: FINDINGS, ok: false, checkedAt: '09.11 15:04' },
};

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const raf = (cb) => setTimeout(() => cb(Date.now()), 0);
win.requestAnimationFrame = raf;
win.cancelAnimationFrame = clearTimeout;
class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
win.ResizeObserver = ResizeObserver;
for (const [k, v] of Object.entries({ window: win, document: win.document, HTMLElement: win.HTMLElement, Node: win.Node, Event: win.Event, MouseEvent: win.MouseEvent })) {
  globalThis[k] = v;
}
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
globalThis.requestAnimationFrame = raf;
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = ResizeObserver;

const body = (value) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(value) });
win.fetch = (input, options) => {
  const url = String(input).replace(/^\/project-graph/, '');
  const method = (options && options.method) || 'GET';
  if (url.startsWith('/api/status')) return body({
    roots: [ROOT], defaultRoot: ROOT, structureDir: 'structure',
    edgeKinds: ['delegate', 'review', 'peer', 'report'],
    workspaces: [{ label: 'structure', path: ROOT, name: 'validator-workspace' }, { label: 'workflow', path: 'C:/probe/workflow', name: 'workflow' }],
  });
  if (url.startsWith('/api/projects')) return body({ projects: [{ root: ROOT, name: 'validator-workspace', exists: true, hasStructure: true, nodes: 4, edges: 3, errors: 3, warnings: 1 }] });
  if (url.startsWith('/api/graph')) return body(graph);
  if (url.startsWith('/api/obligations')) return body({ ok: true, obligations: [] });
  if (url.startsWith('/api/exchange/scan')) return body({ ok: true, unread: [], seen: 0, skipped: [], boxes: [], obligations: [] });
  if (url.startsWith('/api/exchange?')) return body({
    root: ROOT, label: 'structure', participants: ['structure'], sources: [], total: 0, unparsed: 0, facts: [],
    links: [{ id: 'folder-1', participants: ['structure'], state: 'draft', contract: 'contract.md', contractRev: 1, states: { structure: 'invited' }, outgoing: 3, incoming: 2, last: { at: Date.now(), dir: 'in', peer: 'structure' } }],
    folders: [{ id: 'folder-1', box: 'C:\\probe\\coordination', participants: ['structure'], state: 'draft', contract: 'contract.md', contractRev: 1, states: { structure: 'invited' }, outgoing: 3, incoming: 2 }],
  });
  if (url.startsWith('/api/activity')) return body({ root: ROOT, runs: [] });
  if (url.startsWith('/api/live')) return body({ root: ROOT, label: 'structure', sessions: { running: 1, items: [] }, total: 1, agents: [], active: [], unknown: [] });
  if (url.startsWith('/workflow/api/status')) return body({ installed: false });
  return body({});
};
globalThis.fetch = win.fetch;

let entry = null;
win.__ModuleLoader__ = { load: (value) => { entry = value; } };
new Function('window', fs.readFileSync(path.join(repo, 'lib', 'client.js'), 'utf8'))(win);
const client = entry.factory((id) => { if (id === 'react') return React; throw new Error('unexpected require: ' + id); });
let View = null;
client.apply({
  inject: (names, run) => run({
    uiWorkspace: {
      sessions: { list: { getSnapshot: () => ({ byId: { s1: { id: 's1', cwd: ROOT } } }) } },
      workspaces: { list: { getSnapshot: () => ({ items: [{ id: ROOT, path: ROOT, title: 'validator-workspace', sessionIds: ['s1'] }] }) } },
      mainReference: { sessionId: 's1' },
      selection: { getSnapshot: () => ({ sessionId: 's1' }) },
    },
  }),
  slots: { inject: (name, run) => run(), register: (descriptor, component) => { View = component; return () => {}; } },
});

const container = win.document.getElementById('root');
const reactRoot = ReactDOM.createRoot(container);
const settle = async (ms = 200) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
await act(async () => { reactRoot.render(React.createElement(View)); });
await settle(700);

// hover на выступе: как это выглядит при наведении в текущей реализации
if (mode !== 'collapsed') {
  const tab = container.querySelector('[data-validator-tab]');
  if (tab) {
    await act(async () => {
      tab.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 300));
    });
  }
}

if (mode === 'window') {
  const tabEl = container.querySelector('[data-validator-tab]');
  await act(async () => {
    tabEl.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 400));
  });
}
const html = container.innerHTML;
const tab = container.querySelector('[data-validator-tab]');
const rect = tab ? tab.querySelector('rect') : null;
const report = {
  mode,
  hasTab: Boolean(tab),
  transform: tab ? tab.getAttribute('transform') : null,
  width: rect ? rect.getAttribute('width') : null,
  height: rect ? rect.getAttribute('height') : null,
  rx: rect ? rect.getAttribute('rx') : null,
  fill: rect ? rect.getAttribute('fill') : null,
  stroke: rect ? rect.getAttribute('stroke') : null,
  badge: Boolean(container.querySelector('[data-validator-badge]')),
  summary: (container.querySelector('[data-validator-summary]') || {}).textContent || null,
};
fs.writeFileSync(path.join(here, 'current-panel-' + mode + '.html'), html, 'utf8');
fs.writeFileSync(path.join(here, 'current-panel-' + mode + '.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
await act(async () => { reactRoot.unmount(); });
win.close();