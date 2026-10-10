/** Phone portal Workroom must not make iOS zoom or scroll the page sideways (2026-10-09, TestFlight 712).
 *
 * iOS WebKit zooms the page to 16/font-size when a text field below 16px gains focus and keeps that zoom
 * after blur: the 13px composer turned a 428pt iPhone into a 528pt "page" (기록 tab at 365–468pt, the
 * end-session dialog clipped). Playwright cannot zoom like iOS, so the guard is the cause: every text field
 * the real remote AiTerminalPanel shows, inside the portal's real cascade (index.css + remote-control-portal.css),
 * is at least 16px — portrait, and landscape/touch where (pointer: coarse) applies. Two states: a running session
 * (composer, xterm helper) and no session with 「요청 적고 시작하기」 open (the start-prompt textarea, which was 16px
 * only under 640px before, so iPhone landscape still zoomed). Selects are excluded:
 * iOS opens a menu for them without zooming (measured on the iOS 26.5 simulator).
 * Second guard (WebKit only): a long selected project name in the appearance:none project select must not
 * widen the document (it made it 692px on a 428px screen).
 *
 * Start an isolated Vite dev server first (never 3001), then:
 *   node tests/remote-workroom-ios-zoom.e2e.mjs http://127.0.0.1:<port>
 * Every request is answered in the page; nothing reaches a Mac, a relay or Supabase.
 */
import assert from 'node:assert/strict';
import {chromium, webkit} from 'playwright';
const origin = process.argv[2] || process.env.REMOTE_IOS_ZOOM_ORIGIN || 'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.notEqual(new URL(origin).port, '3001');
const source = await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r => { assert.equal(r.status, 200, 'Start isolated Vite first'); return r.text(); });
const main = await fetch(`${origin}/src/main.tsx`).then(r => r.text());
const react = source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom = main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react && reactDom, 'Use the actual Vite dependency versions');

const LONG = 'fixture-long-project', SESSION = 'fixture-session-codex';
const projects = [
  {targetId: 'fixture-ops', projectTargetId: 'fixture-ops', label: 'AgentsToZ-OPS · 총괄(아젠투지1호 MacBook Pro)', scope: 'main', branch: 'main', locked: false, worktreeCapable: true},
  {targetId: LONG, projectTargetId: LONG, label: 'AgentsToZ_byCS · codex/remote-workroom-overflow-investigation-with-an-unbreakable-branch-name_0123456789', scope: 'worktree', branch: 'codex/x', locked: false, worktreeCapable: true},
];
const fixtureHtml = withSession => `<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/remote-control-portal.css';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const session={id:${JSON.stringify(SESSION)},targetId:${JSON.stringify(LONG)},agent:'codex',state:'running',createdAt:'2026-10-09T00:00:00Z',exitCode:null,cols:100,rows:28};
const screen='\\u256d'+'\\u2500'.repeat(58)+'\\u256e\\r\\n\\u2502 >_ OpenAI Codex (v0.146.0) https://github.com/example-org-account/ExampleRepo_ab/blob/13641e76f0c3a5d2b8e9f0a1b2c3d4e5/src/remote-control-portal.css\\r\\n';
const transport=async request=>{
 if(request.operation==='list')return {sessions:${withSession ? '[session]' : '[]'}};
 if(request.operation==='read')return {session,chunks:request.after<1?[{seq:1,text:screen}]:[],nextCursor:1,truncated:false,hasMore:false};
 if(request.operation==='workspace')return {kind:'workspace',action:'workroom.status',workroom:{sessionId:${JSON.stringify(SESSION)},initialized:true,lastSavedAt:null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}}};
 return {session};
};
ReactDOM.createRoot(document.getElementById('root')).render(
 React.createElement('main',{className:'remote-shell','data-workspace-tab':'workroom','data-remote-pane':'workroom'},
  React.createElement('div',{className:'remote-panel remote-workroom-content'},
   React.createElement(AiTerminalPanel,{remote:true,projects:${JSON.stringify(projects)},transport,workspaceTransport:transport,sessionScope:'ios-zoom-fixture-${withSession ? 'session' : 'start'}',entry:{nonce:1,targetId:${JSON.stringify(LONG)}${withSession ? `,sessionId:${JSON.stringify(SESSION)}` : ''}}}))));
</script></html>`;

const results = [];
for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch({headless: true});
  try {
    for (const viewport of [{width: 390, height: 844}, {width: 428, height: 926}, {width: 926, height: 428}]) {
      const context = await browser.newContext({viewport, deviceScaleFactor: 3, hasTouch: true, isMobile: engineName === 'chromium', serviceWorkers: 'block'});
      const external = [], errors = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || url.pathname.startsWith('/api/')) { external.push(url.href); return route.abort(); }
        if (url.pathname === '/__remote-ios-zoom') return route.fulfill({contentType: 'text/html', body: fixtureHtml(true)});
        if (url.pathname === '/__remote-ios-zoom-start') return route.fulfill({contentType: 'text/html', body: fixtureHtml(false)});
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/__remote-ios-zoom');
      const composer = page.getByLabel('워크룸 입력');
      await composer.waitFor({timeout: 15000});
      await page.getByLabel('터미널 프로젝트').waitFor();
      assert.equal(await page.getByLabel('터미널 프로젝트').inputValue(), LONG, 'the long project is the selected one');
      await composer.fill('휴대폰 원격 워크룸 입력 https://github.com/example-org-account/ExampleRepo_ab/blob/13641e76/src/remote-control-portal.css');
      const measure = () => page.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]),textarea')]
        .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
        .map(e => ({field: e.getAttribute('aria-label') ?? e.className, fontSize: parseFloat(getComputedStyle(e).fontSize)})));
      const fields = await measure();
      const small = fields.filter(f => f.fontSize < 16);
      const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      const where = `${engineName} ${viewport.width}×${viewport.height}`;
      assert.ok(fields.some(f => f.field === '워크룸 입력'), `${where}: the composer is measured`);
      if (viewport.width <= 640 || coarse) assert.deepEqual(small, [], `${where}: iOS zooms the page into these fields: ${JSON.stringify(small)}`);
      if (engineName === 'webkit') {
        const width = await page.evaluate(() => ({doc: document.documentElement.scrollWidth, view: innerWidth}));
        assert.ok(width.doc <= width.view, `${where}: the selected project name widened the page ${JSON.stringify(width)}`);
      }
      // No session: 「요청 적고 시작하기」 opens the start-prompt textarea (.ai-terminal-textarea).
      await page.goto(origin + '/__remote-ios-zoom-start');
      await page.getByTestId('workroom-composer-toggle').click({timeout: 15000});
      const startPrompt = page.getByLabel('터미널에 전달할 작업');
      await startPrompt.waitFor();
      await startPrompt.fill('휴대폰에서 새 작업 요청 https://github.com/example-org-account/ExampleRepo_ab/blob/13641e76/src/AiTerminalPanel.css');
      const startFields = await measure();
      assert.ok(startFields.some(f => f.field === '터미널에 전달할 작업'), `${where}: the start prompt is measured`);
      if (viewport.width <= 640 || coarse) assert.deepEqual(startFields.filter(f => f.fontSize < 16), [], `${where}: iOS zooms the page into these start fields: ${JSON.stringify(startFields)}`);
      if (engineName === 'webkit') {
        const width = await page.evaluate(() => ({doc: document.documentElement.scrollWidth, view: innerWidth}));
        assert.ok(width.doc <= width.view, `${where}: the start form widened the page ${JSON.stringify(width)}`);
      }
      assert.deepEqual(external, [], 'everything is answered in the page');
      assert.deepEqual(errors, []);
      results.push({engine: engineName, viewport: `${viewport.width}x${viewport.height}`, coarsePointer: coarse, fields, startFields, passed: true});
      await context.close();
    }
  } finally { await browser.close(); }
}
console.log(JSON.stringify({passed: results.length, failed: 0, results}, null, 1));
