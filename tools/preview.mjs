#!/usr/bin/env node
/**
 * Browser preview of the panel: real client bundle, real HTTP handler, local
 * React, no network. It walks the onboarding -> create -> activity -> edit-link
 * path and
 * fails on console errors or unexpected counts.
 *
 *   pnpm preview
 *
 * Screenshots land in preview-out/ (ignored by git). The temporary project is
 * removed afterwards, so the run leaves the repository untouched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createGraphRuntime, createWebHandler } from '../lib/api.js';
import { noteRun } from '../lib/runs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const outDir = path.join(repo, 'preview-out');
fs.mkdirSync(outDir, { recursive: true });

/* A parent folder of its own: the exchange convention lives next to the workspace. */
const previewParent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-'));
const root = path.join(previewParent, 'project');
fs.mkdirSync(root, { recursive: true });
const exchangeDir = path.join(previewParent, 'coordination', 'threads');
fs.mkdirSync(exchangeDir, { recursive: true });
const head = (from, to, date) => 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nThread: preview\nStatus: info\n';
fs.writeFileSync(path.join(exchangeDir, 'a.md'), head('structure', 'workflow', '2026-10-28T17:26+03:00'));
fs.writeFileSync(path.join(exchangeDir, 'b.md'), head('workflow', 'structure', '2026-10-28T23:40+03:00'));
/* The preview must not write run records into the real profile store. */
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-runs-'));
/*
 * Live agents of the mock host. They are filled in after the structure exists:
 * the point of the scenario is an agent from another session, not this view's
 * own child, so the local subagent catalog stays out of the way.
 */
let liveAgents = [];
const runtime = createGraphRuntime({
  roots: [root],
  runsDir,
  /* The card offers install only when a spec is configured; the mock host has no manager. */
  workflowInstallSpec: 'https://example.invalid/dsh-workflow-console.tgz',
  exchange: [],
  /* Which node stands for the session: the portal line starts at it. */
  self: 'coordinator',
  participants: { structure: root, workflow: 'C:/elsewhere/workflow' },
}, {
  providerName: 'spawn',
  getLlm: () => ({
    listProviders: () => [{ id: 'opencode', name: 'OpenCode' }],
    listModels: async () => [{ id: 'deepseek-v4.1-flash' }, { id: 'glm-5.3-flash' }],
  }),
  getSubagents: () => ({
    getProvider: (name) => (name === 'spawn' ? { name, capabilities: { agentOptions: true, agentPreset: true } } : undefined),
  }),
  getPresets: () => ({
    resolve: async (id) => ({ id }),
    list: async () => [{ id: 'standard', name: 'Standard', description: 'Базовый состав агента' }],
  }),
  getAgents: () => liveAgents,
});
/*
 * Freshness in the preview must not touch the network: a fake profile with an old
 * plugin and a mocked release make the "outdated" branch deterministic.
 */
runtime.profileDir = path.join(root, '.profile');
const previewPkg = path.join(runtime.profileDir, 'node_modules', 'dsh-workflow-console');
fs.mkdirSync(previewPkg, { recursive: true });
fs.writeFileSync(path.join(previewPkg, 'package.json'), JSON.stringify({ name: 'dsh-workflow-console', version: '0.6.9' }));
runtime.fetchRelease = async () => ({ plugin: '0.7.0', engine: '2.6.2' });

/* One branch: two steps share a branchId, which the node card must show. */
noteRun(runtime, { root, node: 'coordinator', state: 'done', since: Date.now() - 5000, finishedAt: Date.now() - 1000, branchId: 'br-preview-1' });
noteRun(runtime, { root, node: 'worker', state: 'done', since: Date.now() - 5000, finishedAt: Date.now() - 2000, branchId: 'br-preview-1' });
const api = createWebHandler(runtime);
const client = fs.readFileSync(path.join(repo, 'lib', 'client.js'), 'utf8');
const react = fs.readFileSync(path.join(repo, 'node_modules', 'react', 'umd', 'react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(repo, 'node_modules', 'react-dom', 'umd', 'react-dom.development.js'), 'utf8');

const html = '<!doctype html><html><head><meta charset="utf-8"><style>'
  + 'body{margin:0;padding:12px;background:#fff;font-family:system-ui,sans-serif}#root{height:820px}</style>'
  + '<script src="/react.js"><\/script><script src="/react-dom.js"><\/script>'
  + '<script>window.__catalogLabel="acceptor:judge";window.__ModuleLoader__={load:(entry)=>{window.__entry=entry;}};'
  + 'window.__workspace={mainReference:{sessionId:"s1"},sessions:{list:{getSnapshot:()=>({byId:{s1:{id:"s1",retainedBy:{mainView:1}},c1:{id:"c1",running:true}},projectionsBySession:{s1:{values:{subagentCatalog:[{id:"c1",label:window.__catalogLabel}]}}}})}},workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:"w1",title:"preview-project",path:' + JSON.stringify(root) + ',sessionIds:["s1"]}]})}}};'
  + '<\/script></head><body><div id="root"></div><script src="/client.js"><\/script>'
  + '<script>const mod=window.__entry.factory((id)=>{if(id==="react")return React;throw new Error("require "+id);});'
  + 'const slots={inject:(name,run)=>run(),register:(desc,View)=>{window.__View=View;return ()=>{};}};'
  + 'const ctx={slots,inject:(names,run)=>run({uiWorkspace:window.__workspace}),get:()=>window.__workspace};'
  + 'mod.apply(ctx);ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(window.__View));<\/script></body></html>';

const server = http.createServer((req, res) => {
  const url = String(req.url || '/');
  /* The panel asks with ?root=, so match the path, not the whole URL. */
  const pathname = (() => { try { return new URL(url, 'http://127.0.0.1').pathname; } catch { return url; } })();
  if (pathname === '/workflow/api/status') {
    if (process.env.PG_PREVIEW_WORKFLOW === 'missing') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not installed"}');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plugin: { name: 'dsh-workflow-console', version: '0.5.0', tool: 'dsh-workflow-console/0.5.0' } }));
    }
    return;
  }
  if (url.startsWith('/project-graph/api')) { api(req, res); return; }
  if (url === '/client.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(client); return; }
  if (url === '/react.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(react); return; }
  if (url === '/react-dom.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(reactDom); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});

function text(page) {
  return page.evaluate(() => document.body.innerText);
}

async function waitForText(page, pattern, timeout = 6000) {
  await page.waitForFunction((source) => new RegExp(source).test(document.body.innerText), pattern.source, { timeout });
}

/* The panel saves in the background: wait for the file, not for a fixed sleep. */
async function waitForFile(check, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  page.on('pageerror', (error) => problems.push('pageerror: ' + error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (process.env.PG_PREVIEW_WORKFLOW === 'missing' && /Failed to load resource/u.test(message.text())) return;
    problems.push('console: ' + message.text());
  });
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('http://127.0.0.1:' + port + '/');
  await waitForText(page, /В этом проекте ещё нет структуры/);
  await page.screenshot({ path: path.join(outDir, '01-onboarding.png'), fullPage: true });
  console.log('OK onboarding');

  await page.getByText('Создать иерархическую').click();
  if (process.env.PG_PREVIEW_WORKFLOW === 'missing') {
    await waitForText(page, /Иерархическая схема и workflow-плагин/);
    await page.screenshot({ path: path.join(outDir, '00-workflow-offer.png'), fullPage: true });
    /* The install button exists and a refusal is explained, not swallowed. */
    await page.getByRole('button', { name: 'Установить', exact: true }).click();
    await waitForText(page, /Установка не удалась/);
    await waitForText(page, /pluginManager/);
    console.log('OK workflow install: refusal explained');
    await page.getByRole('button', { name: 'Создать без плагина' }).click();
  }
  await waitForText(page, /3 узлов[\s\S]*2 связей/);
  console.log('OK create hierarchy: 3 nodes, 2 edges');

  /*
   * Live activity from another session. The judge is started outside this view,
   * in the same workspace; the local subagent catalog is pointed elsewhere first,
   * so a green judge below can only come from /api/live. The second agent has no
   * label naming a node: the panel must count it instead of inventing a role.
   */
  await page.evaluate(() => { window.__catalogLabel = 'acceptor:someone-else'; });
  liveAgents = [
    { id: 'foreign-judge', cwd: root, label: 'acceptor:judge', state: 'running' },
    { id: 'foreign-anon', cwd: root, title: 'посторонний агент', state: 'running' },
  ];
  await waitForText(page, /в воркспейсе работает агент, роль не объявлена: 1/);
  const liveJudge = await page.evaluate(() => {
    const group = [...document.querySelectorAll('g')].find(
      (el) => el.querySelector('text') && el.querySelector('text').textContent === 'judge',
    );
    if (!group) return null;
    return [...group.querySelectorAll('rect')].map((rect) => rect.getAttribute('stroke-width'));
  });
  assert.ok(liveJudge && liveJudge.includes('3'),
    'чужой агент с меткой judge должен сделать узел зелёным, а не остаться невидимым');
  await page.screenshot({ path: path.join(outDir, 'live-05-foreign.png'), fullPage: true });
  console.log('OK live: foreign judge marks the node, unknown role is counted');

  /*
   * Раскладка: узел тянется мышью, связь идёт за ним, стрелка двигает и
   * сохраняет, кнопка сброса убирает x/y. Позиции живут в structure/graph.json,
   * а не в браузере, поэтому проверяем именно файл.
   *
   * Тянем worker далеко вбок: карточка остаётся на своём ряду, но линия должна
   * уйти в её левую сторону, а не в верхнюю — ребро цепляется за ближайшую.
   */
  const graphFile = path.join(root, 'structure', 'graph.json');
  const readNodes = () => JSON.parse(fs.readFileSync(graphFile, 'utf8')).nodes;
  assert.ok(readNodes().every((node) => node.x === undefined && node.y === undefined),
    'до перетаскивания позиций в файле нет');
  const card = await page.locator('[data-node="worker"] rect').first().boundingBox();
  assert.ok(card, 'карточка worker должна быть на канве');
  const startX = card.x + card.width / 2;
  const startY = card.y + 24;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 600, startY, { steps: 10 });
  await page.mouse.up();
  const draggedNode = await waitForFile(() => {
    const node = readNodes().find((item) => item.id === 'worker');
    return node && Number.isInteger(node.x) && Number.isInteger(node.y) ? node : null;
  });
  assert.ok(draggedNode, 'отпускание мыши должно сохранить позицию в graph.json');
  const view = await page.evaluate(() => {
    const rectOf = (id) => {
      const group = document.querySelector('[data-node="' + id + '"]');
      const match = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(group.getAttribute('transform'));
      const rect = group.querySelector('rect');
      return {
        x: Number(match[1]),
        y: Number(match[2]),
        width: Number(rect.getAttribute('width')),
        height: Number(rect.getAttribute('height')),
      };
    };
    const line = document.querySelector('[data-edge="coordinator->worker"]');
    const worker = rectOf('worker');
    const coordinator = rectOf('coordinator');
    return {
      x: worker.x,
      y: worker.y,
      width: worker.width,
      height: worker.height,
      coordinatorX: coordinator.x,
      coordinatorWidth: coordinator.width,
      lineX1: Number(line.getAttribute('x1')),
      lineY1: Number(line.getAttribute('y1')),
      lineX2: Number(line.getAttribute('x2')),
      lineY2: Number(line.getAttribute('y2')),
    };
  });
  assert.equal(view.x, draggedNode.x, 'карточка нарисована по сохранённой позиции');
  assert.equal(view.y, draggedNode.y);
  assert.ok(view.x > 600, 'карточка сдвинулась далеко вправо: ' + view.x);
  assert.ok(view.y > 150, 'карточка осталась на своём нижнем ряду: ' + view.y);
  assert.ok(Math.abs(view.lineX2 - view.x) < 1,
    'ребро ушло в левую сторону карточки, а не в верхнюю: x2 ' + view.lineX2);
  assert.ok(view.lineY2 > view.y + 1 && view.lineY2 < view.y + view.height - 1,
    'точка на боковой стороне, а не в углу: y2 ' + view.lineY2);
  assert.ok(Math.abs(view.lineX1 - (view.coordinatorX + view.coordinatorWidth)) < 1,
    'ребро вышло из правой стороны координатора: x1 ' + view.lineX1);
  await page.screenshot({ path: path.join(outDir, '15-drag-node.png'), fullPage: true });
  console.log('OK drag: node moved sideways, the edge went to its side');

  /* Клавиатура: стрелка сдвигает на 8 px и сохраняет после паузы 400 мс. */
  await page.locator('[data-node="worker"]').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => /x \d+/.test(
    (document.querySelector('[aria-live="polite"]') || {}).textContent || ''));
  const afterKey = await waitForFile(() => {
    const node = readNodes().find((item) => item.id === 'worker');
    return node && node.x === draggedNode.x + 8 ? node : null;
  });
  assert.ok(afterKey, 'стрелка должна сдвинуть узел на 8 px и сохранить позицию');
  assert.equal(afterKey.y, draggedNode.y, 'по вертикали позиция не меняется');
  await page.screenshot({ path: path.join(outDir, '16-keyboard-node.png'), fullPage: true });
  console.log('OK keyboard: arrow moves 8 px and saves');

  await page.getByRole('button', { name: 'Сбросить схему' }).click();
  await waitForText(page, /Раскладка сброшена/);
  const cleared = await waitForFile(() => {
    const nodes = readNodes();
    return nodes.every((node) => node.x === undefined && node.y === undefined) ? nodes : null;
  });
  assert.ok(cleared, 'сброс убирает x/y из structure/graph.json');
  await page.screenshot({ path: path.join(outDir, '17-reset-layout.png'), fullPage: true });
  console.log('OK reset layout: x/y removed from structure/graph.json');

  /* The Workflow strip: its own state and its own update button. */
  if (process.env.PG_PREVIEW_WORKFLOW !== 'missing') {
    await waitForText(page, /Workflow\s*установлен/);
    await waitForText(page, /движок не развёрнут/);
    await page.getByRole('button', { name: 'Развернуть', exact: true }).waitFor();
    console.log('OK workflow strip: engine state and its own deploy action');
    await page.screenshot({ path: path.join(outDir, '10-workflow-strip.png'), fullPage: true });
    /* Freshness: the mock release is newer, so the strip must say where to update. */
    await page.getByRole('button', { name: 'Проверить актуальность' }).click();
    await waitForText(page, /сборка устарела/);
    /*
     * The panel does not offer a download it cannot complete (the release fails
     * the TLS check in this environment). It names the working update path
     * instead, and the test follows the visible UI rather than a stale button.
     */
    await waitForText(page, /Обновление из панели недоступно/);
    await page.screenshot({ path: path.join(outDir, '13-freshness.png'), fullPage: true });
    console.log('OK workflow strip: freshness explains where to update');
    /* External exchange: facts only, direction by the customer's rule. */
    await waitForText(page, /Внешняя связь/);
    await waitForText(page, /двусторонняя/);
    await page.getByRole('button', { name: /Сообщения \(2\)/ }).click();
    await waitForText(page, /исходящее/);
    await page.screenshot({ path: path.join(outDir, '14-exchange.png'), fullPage: true });
    console.log('OK exchange: facts and directions, no message text');
  } else {
    await waitForText(page, /Workflow\s*не установлен/);
    await waitForText(page, /Установить Workflow/);
    console.log('OK workflow strip: missing state offers its own install');
  }

  /*
   * Портал «Выход вне»: стоит за пунктирной границей, линия идёт от узла self,
   * наконечник — там, куда шёл последний по времени факт. Клик открывает уже
   * существующий список под схемой (данные /api/exchange), Esc закрывает его и
   * возвращает фокус порталу. Список не дублируется внутри портала.
   */
  const portal = await page.evaluate(() => {
    const group = document.querySelector('[data-portal]');
    if (!group) return null;
    const frame = [...group.querySelectorAll('rect')].find((rect) => rect.getAttribute('stroke-dasharray') === '5 4');
    const border = document.querySelector('[data-workspace-border] line');
    const line = document.querySelector('[data-portal-line]');
    const box = group.getBoundingClientRect();
    return {
      role: group.getAttribute('role'),
      tabIndex: group.getAttribute('tabindex'),
      aria: group.getAttribute('aria-label') || '',
      width: frame ? Number(frame.getAttribute('width')) : 0,
      frameX: frame ? Number(frame.getAttribute('x')) : 0,
      borderX: border ? Number(border.getAttribute('x1')) : 0,
      text: [...group.querySelectorAll('text')].map((item) => item.textContent).join(' | '),
      visible: box.width > 100 && box.height > 60,
      line: line ? {
        direction: line.getAttribute('data-portal-line'),
        from: line.getAttribute('data-portal-from'),
        start: line.getAttribute('marker-start'),
        end: line.getAttribute('marker-end'),
        d: line.getAttribute('d'),
        label: (document.querySelector('[data-portal-line-label]') || {}).textContent || '',
      } : null,
    };
  });
  assert.ok(portal, 'портал «Выход вне» должен быть на канве');
  assert.equal(portal.role, 'button', 'портал — кнопка, а не картинка');
  assert.equal(portal.tabIndex, '0', 'портал достижим с клавиатуры');
  assert.ok(portal.visible, 'портал виден, а не схлопнут');
  assert.equal(portal.width, 236, 'ширина портала — 236');
  assert.ok(portal.frameX > portal.borderX, 'портал стоит за границей воркспейса');
  assert.match(portal.text, /Выход вне/, 'в портале есть заголовок');
  assert.match(portal.text, /двусторонняя/, 'тип связи назван словом');
  assert.match(portal.text, /↗ 1 исходящее · ↙ 1 входящее/, 'счётчики в обе стороны');
  assert.match(portal.text, /вх\. \d\d\.\d\d, \d\d:\d\d · исх\. \d\d\.\d\d, \d\d:\d\d/, 'видны обе крайние даты');
  assert.match(portal.aria, /workflow, двусторонняя: ↗ 1 исходящее, ↙ 1 входящее/,
    'aria называет адресата, тип связи и счётчики');
  assert.match(portal.aria, /последнее входящее \d\d\.\d\d, \d\d:\d\d/, 'aria называет даты');
  assert.equal(portal.line.from, 'coordinator', 'линия выходит из узла self');
  assert.equal(portal.line.direction, 'incoming', 'последний по времени факт — входящее');
  assert.ok(portal.line.start, 'наконечник у графа: входящее шло к нам');
  assert.equal(portal.line.end, null, 'второго наконечника нет');
  assert.match(portal.line.label, /входящее \d\d\.\d\d, \d\d:\d\d/, 'рядом с линией стоит время факта');

  const geom = await page.evaluate(() => {
    const path = document.querySelector('[data-portal-line]').getAttribute('d');
    const nums = path.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const self = document.querySelector('[data-node="coordinator"]');
    const at = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(self.getAttribute('transform'));
    const rect = self.querySelector('rect');
    const frame = [...document.querySelector('[data-portal]').querySelectorAll('rect')]
      .find((item) => item.getAttribute('stroke-dasharray') === '5 4');
    const cards = [];
    for (const group of document.querySelectorAll('[data-node]')) {
      const match = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(group.getAttribute('transform'));
      const card = group.querySelector('rect');
      cards.push({
        x: Number(match[1]), y: Number(match[2]),
        w: Number(card.getAttribute('width')), h: Number(card.getAttribute('height')),
      });
    }
    return {
      startX: nums[0], startY: nums[1], corridorY: nums[3],
      portalX: nums[nums.length - 1], entryY: nums[nums.length - 2],
      selfX: Number(at[1]), selfY: Number(at[2]),
      selfW: Number(rect.getAttribute('width')), selfH: Number(rect.getAttribute('height')),
      frameX: Number(frame.getAttribute('x')),
      cards,
    };
  });
  assert.ok(Math.abs(geom.startX - (geom.selfX + geom.selfW)) < 0.5,
    'линия вышла из правой стороны self: ' + geom.startX);
  assert.ok(Math.abs(geom.startY - (geom.selfY + geom.selfH / 2)) < 0.5,
    'линия начинается с середины высоты карточки: ' + geom.startY);
  assert.ok(!geom.cards.some((card) => geom.corridorY > card.y && geom.corridorY < card.y + card.h),
    'линия идёт по свободной полосе, а не сквозь карточку: ' + geom.corridorY);
  assert.ok(geom.corridorY > geom.selfY + geom.selfH,
    'полоса линии ниже карточки self: ' + geom.corridorY);
  assert.ok(Math.abs(geom.portalX - geom.frameX) < 0.5, 'линия закончилась на левом краю портала');
  await page.screenshot({ path: path.join(outDir, '18-portal.png'), fullPage: true });
  console.log('OK portal: behind the border, the arrow follows the latest fact');

  /* Новый исходящий факт позже всех: наконечник переезжает к порталу. */
  fs.writeFileSync(path.join(exchangeDir, 'c.md'), head('structure', 'workflow', '2026-10-29T09:15+03:00'));
  await page.getByRole('button', { name: 'Перечитать факты' }).click();
  await page.waitForFunction(() => {
    const line = document.querySelector('[data-portal-line]');
    return Boolean(line) && line.getAttribute('data-portal-line') === 'outgoing';
  });
  const flipped = await page.evaluate(() => {
    const line = document.querySelector('[data-portal-line]');
    return {
      direction: line.getAttribute('data-portal-line'),
      start: line.getAttribute('marker-start'),
      end: line.getAttribute('marker-end'),
      label: (document.querySelector('[data-portal-line-label]') || {}).textContent || '',
    };
  });
  assert.equal(flipped.direction, 'outgoing');
  assert.equal(flipped.start, null, 'входящего позже нет — наконечника у графа нет');
  assert.ok(flipped.end, 'последний факт исходящий — наконечник у портала');
  assert.match(flipped.label, /исходящее → \d\d\.\d\d, 09:15/, 'время нового факта стоит у линии');
  console.log('OK portal: a later outgoing fact moves the arrowhead to the portal');

  /* Клик открывает существующий список под схемой, Esc закрывает и возвращает фокус. */
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.innerText.includes('preview · info'));
  await page.locator('[data-portal]').click();
  await page.waitForFunction(() => document.body.innerText.includes('preview · info'));
  const opened = await page.evaluate(() => ({
    focus: document.activeElement ? document.activeElement.id : '',
    expanded: document.querySelector('[data-portal]').getAttribute('aria-expanded'),
  }));
  assert.equal(opened.focus, 'pg-exchange-card', 'клик по порталу уводит фокус в существующий список');
  assert.equal(opened.expanded, 'true', 'портал говорит, что список открыт');
  await page.screenshot({ path: path.join(outDir, '19-portal-list.png'), fullPage: true });

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.innerText.includes('preview · info'));
  const closed = await page.evaluate(() => ({
    expanded: document.querySelector('[data-portal]').getAttribute('aria-expanded'),
    focus: document.activeElement && document.activeElement.getAttribute
      ? document.activeElement.getAttribute('data-portal')
      : null,
  }));
  assert.equal(closed.expanded, 'false', 'Esc закрывает список');
  assert.equal(closed.focus, 'exit', 'Esc возвращает фокус порталу');
  console.log('OK portal: click opens the existing list under the schema, Esc closes it');

  /*
   * Пустое состояние: источник пропал, но портал остаётся на месте с причиной и
   * рецептом exchange. Исчезнувший выход читался бы как «проект замкнут».
   */
  fs.renameSync(path.join(previewParent, 'coordination'), path.join(previewParent, 'coordination-hidden'));
  await page.getByRole('button', { name: 'Перечитать факты' }).click();
  await page.waitForFunction(() => {
    const group = document.querySelector('[data-portal]');
    return Boolean(group) && /обмена нет/.test(group.textContent);
  });
  const emptyPortal = await page.evaluate(() => {
    const group = document.querySelector('[data-portal]');
    const frame = [...group.querySelectorAll('rect')].find((rect) => rect.getAttribute('stroke-dasharray') === '5 4');
    const line = document.querySelector('[data-portal-line]');
    return {
      width: frame ? Number(frame.getAttribute('width')) : 0,
      text: group.textContent,
      aria: group.getAttribute('aria-label') || '',
      direction: line ? line.getAttribute('data-portal-line') : '',
      markerStart: line ? line.getAttribute('marker-start') : '',
      markerEnd: line ? line.getAttribute('marker-end') : '',
    };
  });
  assert.equal(emptyPortal.width, 236, 'портал не исчезает и не меняет ширину');
  assert.match(emptyPortal.text, /обмена нет/, 'портал называет причину');
  assert.match(emptyPortal.text, /cordis\.patch\.yml/, 'портал называет рецепт');
  assert.match(emptyPortal.aria, /Фактов обмена нет/, 'aria объясняет пустое состояние');
  assert.equal(emptyPortal.direction, 'none', 'без фактов направление не выдумывается');
  assert.equal(emptyPortal.markerStart, null, 'наконечника у графа нет');
  assert.equal(emptyPortal.markerEnd, null, 'наконечника у портала нет');
  await page.screenshot({ path: path.join(outDir, '20-portal-empty.png'), fullPage: true });
  console.log('OK portal: empty state keeps the exit with a reason and a recipe');

  /* Источник вернулся: портал снова называет адресата. */
  fs.renameSync(path.join(previewParent, 'coordination-hidden'), path.join(previewParent, 'coordination'));
  await page.getByRole('button', { name: 'Перечитать факты' }).click();
  await page.waitForFunction(() => {
    const group = document.querySelector('[data-portal]');
    return Boolean(group) && /workflow/.test(group.textContent);
  });
  console.log('OK portal: facts back, the portal names the addressee again');

  const active = await page.evaluate(() => {
    const group = [...document.querySelectorAll('g')].find((el) => el.querySelector('text') && el.querySelector('text').textContent === 'judge');
    if (!group) return null;
    return [...group.querySelectorAll('rect')].map((rect) => ({ stroke: rect.getAttribute('stroke'), width: rect.getAttribute('stroke-width') }));
  });
  assert.ok(active && active.some((rect) => rect.width === '3'), 'judge with a running child must have a 3px border');
  /* The state is a word on the card: judge works, coordinator finished. */
  const words = await page.evaluate(() => {
    const found = {};
    for (const group of document.querySelectorAll('g')) {
      const texts = [...group.querySelectorAll('text')].map((item) => item.textContent);
      /* Карточка несёт id, роль, состояние и строку расписания — состояние третье. */
      if (texts.length < 3) continue;
      found[texts[0]] = texts[2];
    }
    return found;
  });
  assert.equal(words.judge, 'работает', 'узел с живым агентом должен говорить «работает»');
  assert.equal(words.coordinator, 'завершил', 'узел с завершённым запуском должен говорить «завершил»');
  assert.equal(words.worker, 'завершил', 'шаг ветки должен говорить «завершил»');
  await waitForText(page, /report: возврат/);
  console.log('OK state words on cards');
  await page.getByText('judge', { exact: true }).first().click();
  await waitForText(page, /Состояние[\s\S]*работает — агент этого узла/);
  console.log('OK activity: judge is marked as working');
  await page.screenshot({ path: path.join(outDir, '03-active-node.png'), fullPage: true });

  await page.getByText('coordinator', { exact: true }).first().click();
  await waitForText(page, /Что дальше/);
  await waitForText(page, /Ветка[\s\S]*шагов 2:/);
  await waitForText(page, /coordinator — завершил/);
  await waitForText(page, /worker — завершил/);
  console.log('OK branch: steps of one run are listed in the card');
  await page.screenshot({ path: path.join(outDir, '09-branch-card.png'), fullPage: true });
  await page.getByRole('button', { name: 'Связь', exact: true }).click();
  await page.locator('select').nth(0).selectOption('peer');
  const selects = page.locator('select');
  await selects.nth((await selects.count()) - 1).selectOption('judge');
  await page.screenshot({ path: path.join(outDir, '02-link-form.png'), fullPage: true });
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await waitForFile(() => {
    const document = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    return document.edges.filter((edge) => edge.kind === 'peer').length === 1 ? true : null;
  });
  await page.screenshot({ path: path.join(outDir, '04-link-added.png'), fullPage: true });
  let parsed = JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
  assert.equal(parsed.edges.length, 3, 'link must be written to structure/graph.json');
  assert.ok(parsed.edges.some((edge) => edge.kind === 'peer'), 'peer edge missing');
  console.log('OK add peer: 3 edges on disk');

  await page.locator('li', { hasText: 'peer' }).first().getByTitle('удалить связь').click();
  await waitForFile(() => {
    const document = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    return document.edges.filter((edge) => edge.kind === 'peer').length === 0 ? true : null;
  });
  parsed = JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
  assert.equal(parsed.edges.length, 2, 'removal must restore two edges');
  console.log('OK remove peer: 2 edges on disk');

  await page.getByText('coordinator', { exact: true }).first().click();
  await waitForText(page, /завершил — последний запуск/);
  console.log('OK activity: coordinator shows completed');
  await page.screenshot({ path: path.join(outDir, '06-activity-done.png'), fullPage: true });

  await page.getByRole('button', { name: 'Собрать' }).click();
  await waitForText(page, /Сборка структуры/);
  /* The builder must never trap a person: one button and Esc lead back. */
  await page.getByRole('button', { name: '← К схеме' }).first().click();
  await waitForText(page, /3 узлов/);
  console.log('OK builder: back to the schema');
  await page.getByRole('button', { name: 'Собрать' }).click();
  await waitForText(page, /Сборка структуры/);
  await page.keyboard.press('Escape');
  await waitForText(page, /3 узлов/);
  console.log('OK builder: Esc closes it too');
  await page.getByRole('button', { name: 'Собрать' }).click();
  await waitForText(page, /Сборка структуры/);
  await page.getByLabel('provider', { exact: true }).waitFor();
  await page.getByPlaceholder('алиас').fill('ui');
  await page.getByLabel('provider', { exact: true }).selectOption('opencode');
  await page.getByLabel('модель', { exact: true }).selectOption('deepseek-v4.1-flash');
  await page.getByRole('button', { name: 'Добавить модель' }).click();
  await waitForText(page, /ui/);
  await page.locator('[data-model="ui"]').getByTitle('изменить provider и model').click();
  await page.getByLabel('модель', { exact: true }).selectOption('glm-5.3-flash');
  await page.getByRole('button', { name: 'Сохранить модель' }).click();
  await waitForText(page, /ui.*glm-5.3-flash/);
  await page.getByPlaceholder('id', { exact: true }).fill('extra');
  await page.getByPlaceholder('роль').fill('tester');
  await page.getByLabel('модель узла').selectOption('work');
  await page.getByLabel('пресет').selectOption('standard');
  await page.getByRole('button', { name: 'Добавить узел' }).click();
  await waitForText(page, /extra/);
  await page.locator('[data-node="extra"]').getByTitle('изменить узел').click();
  await page.getByPlaceholder('роль').fill('editor');
  await page.getByRole('button', { name: 'Сохранить узел' }).click();
  await waitForText(page, /extra.*editor/);
  await page.getByLabel('from', { exact: true }).selectOption('coordinator');
  await page.getByLabel('to', { exact: true }).selectOption('extra');
  await page.getByRole('button', { name: 'Добавить связь' }).click();
  await waitForText(page, /coordinator → extra/);
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await waitForText(page, /Проверка пройдена/);
  await page.screenshot({ path: path.join(outDir, '05-builder.png'), fullPage: true });
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await waitForText(page, /4 узлов/);
  parsed = JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
  assert.equal(parsed.nodes.length, 4, 'builder must write the extra node');
  assert.ok(parsed.nodes.some((node) => node.id === 'extra' && node.agentPreset === 'standard' && node.role === 'editor'));
  assert.equal(parsed.models.ui.model, 'glm-5.3-flash');
  assert.equal(parsed.edges.length, 3, 'builder must write the new edge');
  assert.ok(parsed.edges.some((edge) => edge.from === 'coordinator' && edge.to === 'extra' && edge.kind === 'delegate'));
  console.log('OK builder: 4 nodes, 3 edges on disk');

  /* A quick add on the schema itself, without opening the builder. */
  await page.getByRole('button', { name: 'Добавить узел', exact: true }).click();
  await waitForText(page, /Новый узел/);
  await page.getByLabel('id узла').fill('quick');
  await page.getByLabel('роль узла').fill('helper');
  await page.getByLabel('модель узла').selectOption('work');
  await page.getByLabel('назначение узла').fill('делает быстрые правки');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await waitForText(page, /5 узлов/);
  parsed = JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
  assert.equal(parsed.nodes.length, 5, 'quick add must write the node to the file');
  const quick = parsed.nodes.find((node) => node.id === 'quick');
  assert.equal(quick.role, 'helper');
  assert.equal(quick.model, 'work');
  assert.equal(quick.brief, 'делает быстрые правки');
  await page.screenshot({ path: path.join(outDir, '07-quick-node.png'), fullPage: true });
  console.log('OK quick node: 5 nodes on disk, no builder');

  /* The node menu: change the declaration in place, then a ready branch call. */
  await page.getByText('quick', { exact: true }).first().click();
  await waitForText(page, /Что дальше/);
  await page.getByRole('button', { name: 'Изменить узел' }).click();
  /* Редактор раскрывается у самой карточки, а не панелью внизу. */
  await page.locator('[data-node-editor="quick"]').waitFor();
  await page.getByLabel('роль узла в редакторе').fill('assistant');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await waitForText(page, /assistant/);
  parsed = JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
  assert.equal(parsed.nodes.find((node) => node.id === 'quick').role, 'assistant', 'правка узла должна попасть в файл');
  console.log('OK node menu: role changed without the builder');

  await page.getByRole('button', { name: 'Запустить ветку' }).click();
  await waitForText(page, /project_graph_branch/);
  await page.getByLabel('параллельность ветки').selectOption('4');
  await waitForText(page, /"parallelism": 4/);
  await page.getByRole('button', { name: 'Скопировать вызов' }).click();
  await page.screenshot({ path: path.join(outDir, '08-node-menu.png'), fullPage: true });
  console.log('OK node menu: branch call ready to copy');

  /* The return link: a node hands its result back without being judged. */
  await page.locator('[data-node="worker"]').first().click();
  await waitForText(page, /Что дальше/);
  await page.getByRole('button', { name: 'Связь', exact: true }).click();
  await page.locator('select').nth(0).selectOption('report');
  const reportSelects = page.locator('select');
  await reportSelects.nth((await reportSelects.count()) - 1).selectOption('coordinator');
  await page.screenshot({ path: path.join(outDir, '11-report-form.png'), fullPage: true });
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await waitForFile(() => {
    const document = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    return document.edges.filter((edge) => edge.kind === 'report').length === 1 ? true : null;
  });
  parsed = JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
  const returned = parsed.edges.find((edge) => edge.kind === 'report');
  assert.ok(returned, 'report edge missing');
  assert.equal(returned.from, 'worker');
  assert.equal(returned.to, 'coordinator');
  await page.screenshot({ path: path.join(outDir, '12-report-edge.png'), fullPage: true });
  console.log('OK report: worker returns to coordinator, written as report');

  /*
   * Библиотека узлов: палитра слева со сворачиванием, вынос «Критика» на канву,
   * связь по умолчанию report → coordinator, расписание 09:00 и редактор у самой
   * карточки, где время запуска правится на 07:30. Затем «Папка общего обмена» с
   * клавиатуры: узел без связей с агентами и с пометкой «только сообщения».
   */
  const library = page.locator('[data-library="palette"]');
  await library.waitFor();
  const expandedBox = await library.boundingBox();
  const canvasFirst = await page.locator('[data-canvas]').boundingBox();
  assert.ok(expandedBox && expandedBox.width >= 240,
    'развёрнутая палитра — колонка слева шириной 250: ' + (expandedBox && expandedBox.width));
  assert.ok(canvasFirst && canvasFirst.x >= expandedBox.x + expandedBox.width - 1,
    'канва стоит справа от палитры, а не под ней');
  for (const type of ['critic', 'worker', 'exchange']) {
    assert.equal(await page.locator('[data-library="' + type + '"]').count(), 1, 'в палитре нет карточки ' + type);
  }
  /* Строка связи в карточке обрезается многоточием, как в макете: полный текст — в aria-label. */
  const criticAria = await page.locator('[data-library="critic"]').getAttribute('aria-label');
  assert.match(criticAria, /возврат report координатору/u, 'карточка критика называет связь словами');
  const exchangeAria = await page.locator('[data-library="exchange"]').getAttribute('aria-label');
  assert.match(exchangeAria, /только сообщения/u, 'папка обмена названа словами');
  await page.screenshot({ path: path.join(outDir, '21-library.png'), fullPage: true });
  console.log('OK library: three cards with the default link in words');

  /* Простое нажатие не берёт карточку: рамка будущего узла на канве не появляется. */
  await page.locator('[data-library="critic"]').click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('[data-library-target]').count(), 0, 'клик не рисует рамку будущего узла');
  assert.equal(await page.locator('[data-library-ghost]').count(), 0, 'клик не рождает призрак');
  await waitForText(page, /перетащите её на схему или нажмите Enter/u);
  console.log('OK library: a click does not start the carry');

  await page.getByRole('button', { name: 'Свернуть библиотеку узлов' }).click();
  const collapsedBox = await library.boundingBox();
  const canvasCollapsed = await page.locator('[data-canvas]').boundingBox();
  assert.ok(collapsedBox && collapsedBox.width <= 60,
    'свёрнутая палитра — узкая полоса: ' + (collapsedBox && collapsedBox.width));
  assert.ok(canvasCollapsed && canvasCollapsed.x >= collapsedBox.x + collapsedBox.width - 1,
    'свёрнутая палитра не перекрывает канву');
  assert.equal(await page.getByRole('button', { name: 'Развернуть библиотеку узлов' }).getAttribute('aria-expanded'), 'false');
  await page.screenshot({ path: path.join(outDir, '22-library-collapsed.png'), fullPage: true });
  console.log('OK library: collapse keeps the canvas free');
  await page.getByRole('button', { name: 'Развернуть библиотеку узлов' }).click();
  await waitForText(page, /ежедневно 09:00/);

  const criticPalette = await page.locator('[data-library="critic"]').boundingBox();
  const canvasDrop = await page.locator('[data-canvas]').boundingBox();
  assert.ok(criticPalette && canvasDrop, 'карточка критика и канва должны быть видны');
  const dropX = canvasDrop.x + Math.min(520, canvasDrop.width - 90);
  const dropY = canvasDrop.y + 96;
  await page.mouse.move(criticPalette.x + criticPalette.width / 2, criticPalette.y + criticPalette.height / 2);
  await page.mouse.down();
  await page.mouse.move(dropX, dropY, { steps: 12 });
  const ghost = await page.evaluate(() => {
    const el = document.querySelector('[data-library-ghost]');
    return el ? { type: el.getAttribute('data-library-ghost'), text: el.textContent } : null;
  });
  assert.ok(ghost && ghost.type === 'critic', 'под курсором призрак карточки «Критик»');
  assert.match(ghost.text, /возврат report координатору/, 'призрак называет связь по умолчанию словами');
  assert.ok(await page.locator('[data-library-target]').count() > 0, 'на канве виден контур будущего узла');
  await page.mouse.up();

  const criticNode = await waitForFile(() => readNodes().find((node) => node.id === 'critic-1') || null);
  assert.ok(criticNode, 'сброс создаёт critic-1 в structure/graph.json');
  assert.equal(criticNode.role, 'критик');
  assert.deepEqual(criticNode.schedule, { at: '09:00', timeZone: 'Europe/Moscow' }, 'критик получает расписание 09:00');
  const defaultReport = await waitForFile(() => {
    const document = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    return document.edges.find((edge) => edge.from === 'critic-1' && edge.to === 'coordinator' && edge.kind === 'report') || null;
  });
  assert.ok(defaultReport, 'связь по умолчанию report → coordinator встала сразу');
  await page.locator('[data-node="critic-1"]').waitFor();
  /* Карточка встала именно в точку сброса, а не на расчётное место. */
  const droppedAt = await page.evaluate((id) => {
    const group = document.querySelector('[data-node="' + id + '"]');
    const match = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(group.getAttribute('transform'));
    const svg = document.querySelector('[data-canvas] svg');
    const rect = svg.getBoundingClientRect();
    return {
      x: Number(match[1]),
      y: Number(match[2]),
      left: rect.left,
      top: rect.top,
      scaleX: Number(svg.getAttribute('width')) / rect.width,
      scaleY: Number(svg.getAttribute('height')) / rect.height,
    };
  }, 'critic-1');
  const expectedX = (dropX - droppedAt.left) * droppedAt.scaleX - 16 - 88;
  const expectedY = (dropY - droppedAt.top) * droppedAt.scaleY - 16 - 31;
  assert.ok(Math.abs(droppedAt.x - expectedX) <= 2,
    'карточка встала по x в точку сброса: ' + droppedAt.x + ' vs ' + expectedX);
  assert.ok(Math.abs(droppedAt.y - expectedY) <= 2,
    'карточка встала по y в точку сброса: ' + droppedAt.y + ' vs ' + expectedY);
  console.log('OK library: dropping the critic makes critic-1 with a report edge and a schedule');

  const criticEditor = page.locator('[data-node-editor="critic-1"]');
  await criticEditor.waitFor();
  const editorBox = await criticEditor.boundingBox();
  const criticCardBox = await page.locator('[data-node="critic-1"] rect').first().boundingBox();
  assert.ok(editorBox && criticCardBox, 'редактор и карточка видны');
  assert.ok(editorBox.y >= criticCardBox.y, 'редактор раскрыт от карточки узла, а не панелью внизу');
  assert.ok(Math.abs(editorBox.x - criticCardBox.x) < 420, 'редактор стоит рядом с карточкой узла');
  const idField = page.getByLabel('id узла в редакторе');
  assert.equal(await idField.getAttribute('readonly'), '', 'id существующего узла только для чтения');
  assert.equal(await idField.inputValue(), 'critic-1');
  await page.screenshot({ path: path.join(outDir, '23-node-editor.png'), fullPage: true });

  await page.getByLabel('время запуска в редакторе').fill('07:30');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const rescheduled = await waitForFile(() => {
    const node = readNodes().find((item) => item.id === 'critic-1');
    return node && node.schedule && node.schedule.at === '07:30' ? node : null;
  });
  assert.ok(rescheduled, 'время запуска меняется из редактора и пишется в structure/graph.json');
  await waitForText(page, /Узел «critic-1» сохранён/);
  await page.screenshot({ path: path.join(outDir, '24-node-editor-saved.png'), fullPage: true });
  console.log('OK node editor: opened at the card, run time changed to 07:30');

  await page.locator('[data-library="exchange"]').focus();
  await page.keyboard.press('Enter');
  await waitForText(page, /Карточка «Папка общего обмена»/);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const exchangeNode = await waitForFile(() => readNodes().find((node) => node.id === 'exchange-1') || null);
  assert.ok(exchangeNode, 'Enter на карточке ставит узел с клавиатуры');
  assert.equal(exchangeNode.role, 'обмен');
  assert.equal(exchangeNode.model, undefined, 'у папки обмена нет модели');
  parsed = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  assert.equal(parsed.edges.filter((edge) => edge.from === 'exchange-1' || edge.to === 'exchange-1').length, 0,
    'папка обмена не соединяется с агентами');
  await page.locator('[data-node="exchange-1"]').waitFor();
  const exchangeText = await page.locator('[data-node="exchange-1"]').textContent();
  assert.match(exchangeText, /только сообщения/, 'на карточке папки обмена пометка «только сообщения»');
  await waitForText(page, /У папки общего обмена связей с агентами нет/);
  await page.locator('[data-editor-cancel]').click();
  await page.screenshot({ path: path.join(outDir, '25-exchange-node.png'), fullPage: true });
  console.log('OK library: the exchange folder is placed by keyboard, with no agent links');

  assert.deepEqual(problems, [], 'browser errors: ' + problems.join(' | '));
  console.log('PREVIEW OK — screenshots in ' + path.relative(repo, outDir));
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}