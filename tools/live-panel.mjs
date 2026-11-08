/**
 * Screenshot the real panel against a running DSH host.
 *
 * tools/preview.mjs renders the panel against a mock runtime, which is what the
 * tests need. This script renders the same client against the *live* web server:
 * it proxies /project-graph and /workflow to the origin and shims only the
 * workspace object the panel reads. The result is the panel as the host serves
 * it now — useful to prove that a run appears (running, then done) without
 * opening the GUI.
 *
 * Usage:
 *   node tools/live-panel.mjs --origin http://127.0.0.1:64785 --root <project> --node worker
 *
 * --root defaults to the repository itself, --node to worker. Screenshots land
 * in preview-out/live-01-panel.png, live-02-state.png, live-03-running.png and
 * live-04-done.png.
 */
import { chromium } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const repo = path.resolve(import.meta.dirname, '..');
const origin = arg('origin', process.env.PG_LIVE_ORIGIN || 'http://127.0.0.1:64785');
const root = arg('root', repo).replace(/\\/gu, '/');
const nodeId = arg('node', 'worker');
const outDir = path.join(repo, 'preview-out');
fs.mkdirSync(outDir, { recursive: true });

const client = fs.readFileSync(path.join(repo, 'lib', 'client.js'), 'utf8');
const react = fs.readFileSync(path.join(repo, 'node_modules', 'react', 'umd', 'react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(repo, 'node_modules', 'react-dom', 'umd', 'react-dom.development.js'), 'utf8');

const html = '<!doctype html><html><head><meta charset="utf-8"><style>'
  + 'body{margin:0;padding:12px;background:#fff;font-family:system-ui,sans-serif}#root{height:900px}</style>'
  + '<script src="/react.js"><\/script><script src="/react-dom.js"><\/script>'
  + '<script>window.__ModuleLoader__={load:(entry)=>{window.__entry=entry;}};'
  + 'window.__workspace={mainReference:{sessionId:"s1"},sessions:{list:{getSnapshot:()=>({byId:{s1:{id:"s1",retainedBy:{mainView:1},running:' + (process.argv.includes('--self-running') ? 'true' : 'false') + '}},projectionsBySession:{s1:{values:{subagentCatalog:[]}}}})}},workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:"w1",title:"live",path:' + JSON.stringify(root) + ',sessionIds:["s1"]}]})}}};'
  + '<\/script></head><body><div id="root"></div><script src="/client.js"><\/script>'
  + '<script>const mod=window.__entry.factory((id)=>{if(id==="react")return React;throw new Error("require "+id);});'
  + 'const slots={inject:(name,run)=>run(),register:(desc,View)=>{window.__View=View;return ()=>{};}};'
  + 'const ctx={slots,inject:(names,run)=>run({uiWorkspace:window.__workspace}),get:()=>window.__workspace};'
  + 'mod.apply(ctx);ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(window.__View));<\/script></body></html>';

/* Only the two plugin prefixes are proxied: everything else is the harness. */
function proxy(req, res) {
  const upstream = new URL(req.url, origin);
  const request = http.request(
    { hostname: upstream.hostname, port: upstream.port, path: upstream.pathname + upstream.search, method: req.method, headers: { accept: 'application/json' } },
    (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    },
  );
  request.on('error', (error) => { res.writeHead(502); res.end('proxy error: ' + error.message); });
  req.pipe(request);
}

const server = http.createServer((req, res) => {
  const url = String(req.url || '/');
  if (url.startsWith('/project-graph') || url.startsWith('/workflow/')) { proxy(req, res); return; }
  if (url === '/client.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(client); return; }
  if (url === '/react.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(react); return; }
  if (url === '/react-dom.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(reactDom); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});

const stateLines = (body) => body.split('\n')
  .filter((line) => /завершил|ошибка|работает|последний запуск/.test(line))
  .slice(0, 4);

let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const problems = [];
  page.on('pageerror', (error) => problems.push('pageerror: ' + error.message));
  page.on('console', (message) => { if (message.type() === 'error') problems.push('console: ' + message.text()); });

  await page.goto('http://127.0.0.1:' + port + '/');
  await page.waitForFunction(() => /узлов/u.test(document.body.innerText), null, { timeout: 15000 });
  await page.screenshot({ path: path.join(outDir, 'live-01-panel.png'), fullPage: true });
  console.log('OK panel');

  await page.locator('[data-node="' + nodeId + '"]').first().click();
  await page.waitForFunction(() => /Состояние/u.test(document.body.innerText), null, { timeout: 10000 });
  await page.screenshot({ path: path.join(outDir, 'live-02-state.png'), fullPage: true });
  console.log('STATE: ' + JSON.stringify(stateLines(await page.evaluate(() => document.body.innerText))));

  /* Optional: catch the node while it works, then after it settles. */
  if (process.argv.includes('--watch')) {
    await page.waitForFunction(() => /работает — агент/u.test(document.body.innerText), null, { timeout: 60000 });
    console.log('RUNNING: ' + JSON.stringify(stateLines(await page.evaluate(() => document.body.innerText))));
    await page.screenshot({ path: path.join(outDir, 'live-03-running.png'), fullPage: true });
    await page.waitForFunction(() => /завершил — последний запуск/u.test(document.body.innerText), null, { timeout: 180000 });
    console.log('DONE: ' + JSON.stringify(stateLines(await page.evaluate(() => document.body.innerText))));
    await page.screenshot({ path: path.join(outDir, 'live-04-done.png'), fullPage: true });
  }
  console.log('problems: ' + JSON.stringify(problems));
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
