/** Phone Workroom history must look like the phone Workroom and never widen the page (2026-10-16, iPhone 13 Pro Max).
 *
 * `RemoteWorkroomHistoryPanel` is mounted in the phone portal as a SIBLING of `AiTerminalPanel`, outside
 * `.ai-terminal-panel`, so none of the `.ai-terminal-panel …` rules it borrows class names from reached it. On the
 * device (428pt, dev app WKWebView) the project select was ~462px wide in a ~358px column — the whole page scrolled
 * sideways (VoiceOver: a horizontal scroll bar, 2 pages) — and 「불러오기」 was an unstyled ~45×19pt tap target.
 *
 * This renders the portal's real structure (`.remote-shell > .remote-panel.remote-workroom-content` holding the
 * remote AiTerminalPanel and the history panel side by side) in the portal's real cascade (index.css +
 * remote-control-portal.css + AiTerminalPanel.css), with long Korean project names and conversation titles, an
 * unsettled request, an orphaned request, a confirmed dismiss warning and the Mac's project-scope refusal. Then, at
 * 390 and 428 portrait and 926 landscape, in Chromium and WebKit, it checks:
 *   - the document is no wider than the viewport, and nothing in the panel sticks out of it;
 *   - the project select ends inside the viewport and the panel;
 *   - every button (and the select and summary) is at least 44px tall on a phone width or a coarse pointer;
 *   - the refusal is fully readable (wraps, not clipped).
 *
 * Widths are compared with the device width, not innerWidth (Chromium's mobile emulation widens innerWidth to fit
 * overflowing content). A control another element covers is reported, then pressed through the DOM to keep measuring.
 *
 * Start an isolated Vite dev server first (never 3001), then:
 *   node tests/remote-workroom-history-layout.e2e.mjs http://127.0.0.1:<port>
 * REMOTE_HISTORY_LAYOUT_SHOTS=<dir> also saves the panel per engine/size/step, after all checks.
 * Notes for the server: in a linked worktree Vite's watcher ignores `**\/worktrees/**` (restart it after edits, or
 * override `server.watch.ignored`); a custom `cacheDir` must keep `node_modules` in its path, or the React plugin
 * transforms the pre-bundled deps and the page dies with `$RefreshSig$ is not defined`.
 * Every request is answered in the page; nothing reaches a Mac, a relay or Supabase.
 */
import assert from 'node:assert/strict';
import {chromium, webkit} from 'playwright';
const origin = process.argv[2] || process.env.REMOTE_HISTORY_LAYOUT_ORIGIN || 'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.notEqual(new URL(origin).port, '3001');
const source = await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r => { assert.equal(r.status, 200, 'Start isolated Vite first'); return r.text(); });
const main = await fetch(`${origin}/src/main.tsx`).then(r => r.text());
// Any Vite cache directory (an isolated server may set its own cacheDir).
const react = source.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom = main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react && reactDom, 'Use the actual Vite dependency versions');

const HOST = 'host_fixture_0001', PAIRING = 'p_fixture_pairing_0001';
const ALLOWED = 'control_allowed_0001', REFUSED = 'control_refused_0002';
// What the Mac answers for a project outside this device's grant (src/mobileWorkspaceGateway.ts).
const GATEWAY_REFUSAL = 'Mac의 외부 인터넷 QR 원격제어에서 이 기기가 사용할 프로젝트 범위를 허용하세요.';
const historyProjects = [
  {targetId: ALLOWED, label: 'AgentsToZ_byCS · 휴대폰워크룸대화기록이어열기레이아웃점검용아주긴프로젝트이름 · codex/remote-workroom-history-overflow_0123456789'},
  {targetId: REFUSED, label: '허용되지않은다른프로젝트의아주아주긴한글이름으로선택창이넓어지는지확인합니다 · claude/worktree-with-an-unbreakable-branch-name_abcdefghij'},
  {targetId: 'control_short_0003', label: '블로그'},
];
const terminalProjects = [{targetId: ALLOWED, projectTargetId: ALLOWED, label: historyProjects[0].label, scope: 'main', branch: 'main', locked: false, worktreeCapable: true}];
const now = '2026-10-16T01:00:00.000Z';
const rows = [
  {id: 'conv_long_title_00001', title: '휴대폰에서이어열기한워크룸대화의제목이아주길어서한줄에들어가지않는경우에도페이지가옆으로넓어지면안됩니다확인용제목입니다아주길게', agent: 'claude', state: 'ended', resumable: true, updatedAt: now, revision: 3},
  {id: 'conv_url_title_000002', title: 'https://github.com/example-org-account/ExampleRepo_ab/blob/13641e76f0c3/src/HistoryPanel.tsx', agent: 'codex', state: 'detached', resumable: true, updatedAt: now, revision: 1},
  {id: 'conv_running_0000003', title: '실행 중인 대화', agent: 'codex', state: 'running', resumable: false, updatedAt: now, revision: 2},
  {id: 'conv_pending_0000004', title: '결과를 확인해야 하는 대화 · 이전에 이어 열기를 보냈습니다', agent: 'claude', state: 'ended', resumable: true, updatedAt: now, revision: 5},
];
const fixtureHtml = `<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/remote-control-portal.css';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const {RemoteWorkroomHistoryPanel}=await import('/src/RemoteWorkroomHistoryPanel.tsx');
const {savePendingRemoteHistoryResume}=await import('/src/workroomHistoryRemoteProtocol.ts');
const map=new Map();const storage={getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>{map.set(k,String(v));}};
savePendingRemoteHistoryResume(storage,{host:${JSON.stringify(HOST)},conversationId:'conv_pending_0000004',resumeRequestId:'resume_request_000001',controlId:${JSON.stringify(ALLOWED)},pairing:${JSON.stringify(PAIRING)},requestedAt:${JSON.stringify(now)}});
savePendingRemoteHistoryResume(storage,{host:'host_forgotten_mac_02',conversationId:'conv_orphan_00000005',resumeRequestId:'resume_request_000002',controlId:${JSON.stringify(ALLOWED)},pairing:'p_old_pairing_00000002',requestedAt:${JSON.stringify(now)}});
const terminal=async request=>{
 if(request.operation==='list')return {sessions:[]};
 if(request.operation==='workspace')return {kind:'workspace',action:'workroom.status',workroom:{sessionId:null,initialized:false,lastSavedAt:null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}}};
 return {};
};
const history=async request=>{
 const {action}=request.workspace;
 if(request.targetId!==${JSON.stringify(ALLOWED)})throw new Error(${JSON.stringify(GATEWAY_REFUSAL)});
 if(action==='history.list')return {kind:'workspace',action,history:{records:${JSON.stringify(rows)},nextBefore:'cursor_next_page_0001'}};
 throw new Error('unexpected '+action);
};
ReactDOM.createRoot(document.getElementById('root')).render(
 React.createElement('main',{className:'remote-shell','data-workspace-tab':'workroom','data-remote-pane':'workroom'},
  React.createElement('div',{className:'remote-panel remote-workroom-content'},
   React.createElement(AiTerminalPanel,{remote:true,projects:${JSON.stringify(terminalProjects)},transport:terminal,workspaceTransport:terminal,sessionScope:'history-layout-fixture'}),
   React.createElement(RemoteWorkroomHistoryPanel,{available:true,visible:true,online:true,host:${JSON.stringify(HOST)},pairing:${JSON.stringify(PAIRING)},knownHosts:[${JSON.stringify(HOST)}],projects:${JSON.stringify(historyProjects)},transport:history,storage}))));
</script></html>`;

/** Everything the check reads, in one pass: the page width, the panel and select edges, every tap target's height and
 *  every panel descendant that sticks out of the panel. */
const measure = page => page.evaluate(() => {
  const panel = document.querySelector('[data-testid="remote-workroom-history"]');
  const rect = el => el.getBoundingClientRect();
  const select = panel.querySelector('[data-testid="remote-workroom-history-project"]');
  const p = rect(panel);
  const shown = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const targets = [...panel.querySelectorAll('button, select, summary')].filter(shown).map(el => ({
    what: el.dataset.testid || el.tagName.toLowerCase() + ':' + (el.textContent || '').trim().slice(0, 16),
    height: Math.round(rect(el).height * 10) / 10, fontSize: parseFloat(getComputedStyle(el).fontSize),
  }));
  const sticking = [...panel.querySelectorAll('*')].filter(shown).filter(el => rect(el).right > p.right + 0.5 || rect(el).left < p.left - 0.5)
    .map(el => ({what: el.dataset.testid || el.className || el.tagName, left: Math.round(rect(el).left), right: Math.round(rect(el).right)})).slice(0, 8);
  return {
    viewport: innerWidth, docScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
    panelLeft: Math.round(p.left), panelRight: Math.round(p.right), selectRight: select ? Math.round(rect(select).right) : null,
    selectWidth: select ? Math.round(rect(select).width) : null, targets, sticking,
  };
});

// Optional: REMOTE_HISTORY_LAYOUT_SHOTS=<dir> saves the panel at each step for a human look.
const shots = process.env.REMOTE_HISTORY_LAYOUT_SHOTS || '';
const results = [], failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch({headless: true});
  try {
    for (const viewport of [{width: 390, height: 844}, {width: 428, height: 926}, {width: 926, height: 428}]) {
      const context = await browser.newContext({viewport, deviceScaleFactor: 3, hasTouch: true, isMobile: engineName === 'chromium', serviceWorkers: 'block'});
      const external = [], errors = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || url.pathname.startsWith('/api/')) { external.push(url.href); return route.abort(); }
        if (url.pathname === '/__remote-history-layout') return route.fulfill({contentType: 'text/html', body: fixtureHtml});
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message + ' @ ' + String(error.stack ?? '').split('\n').slice(0, 3).join(' / ')));
      await page.goto(origin + '/__remote-history-layout');
      const where = `${engineName} ${viewport.width}×${viewport.height}`;
      const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      const phone = viewport.width <= 640 || coarse;
      const panel = page.getByTestId('remote-workroom-history');
      try { await panel.waitFor({timeout: 15000}); }
      catch (error) { throw new Error(`${where}: the history panel never rendered (page errors: ${errors.join(' | ') || 'none'})`, {cause: error}); }
      // A real tap: Playwright hit-tests the point first. If something else covers the control (it sits off screen or
      // under a neighbour), that is the layout failure itself — record it, then press it through the DOM to go on measuring.
      const tap = async (locator, what) => {
        try { await locator.click({timeout: 3000}); }
        catch { failures.push(`${where}: ${what} cannot be tapped — another element covers it`); await locator.evaluate(el => el.click()); }
      };
      // The screen is the device width, not innerWidth: Chromium's mobile emulation widens the layout viewport to fit
      // overflowing content (innerWidth became 1059 on a 390px screen), which would hide exactly this bug.
      const screen = viewport.width;
      const verify = (m, step) => {
        check(m.docScrollWidth <= screen, `${where} ${step}: the page is ${m.docScrollWidth}px wide on a ${screen}px screen`);
        check(m.panelRight <= screen && m.panelLeft >= 0, `${where} ${step}: the panel spans ${m.panelLeft}–${m.panelRight}px of ${screen}px`);
        check(m.sticking.length === 0, `${where} ${step}: these stick out of the panel: ${JSON.stringify(m.sticking)}`);
        if (m.selectRight !== null) check(m.selectRight <= Math.min(screen, m.panelRight), `${where} ${step}: the project select ends at ${m.selectRight}px (panel ${m.panelRight}px, screen ${screen}px)`);
        if (phone) {
          const small = m.targets.filter(t => t.height < 44);
          check(small.length === 0, `${where} ${step}: tap targets under 44px: ${JSON.stringify(small)}`);
          const tiny = m.targets.filter(t => t.what === 'remote-workroom-history-project' && t.fontSize < 16);
          check(tiny.length === 0, `${where} ${step}: the project select is ${JSON.stringify(tiny)} (16px like every phone control)`);
        }
      };
      // Open: the panel loads the first project's conversations.
      await tap(panel.locator('summary'), 'the summary');
      await page.getByTestId('remote-workroom-history-row').first().waitFor({timeout: 15000});
      await page.getByTestId('remote-workroom-history-pending-row').waitFor();
      await page.getByTestId('remote-workroom-history-orphan-row').waitFor();
      const opened = await measure(page);
      verify(opened, 'opened');
      for (const id of ['remote-workroom-history-load', 'remote-workroom-history-resume', 'remote-workroom-history-check', 'remote-workroom-history-pending-check', 'remote-workroom-history-pending-dismiss'])
        check(opened.targets.some(t => t.what === id), `${where}: ${id} is shown`);
      // 「이어 열기」 → its confirm, and a dismiss → the long warning with two buttons.
      await tap(page.getByTestId('remote-workroom-history-resume').first(), '이어 열기');
      await page.getByTestId('remote-workroom-history-confirm').waitFor();
      await tap(page.getByTestId('remote-workroom-history-pending-dismiss').first(), '목록에서 지우기');
      await page.getByTestId('remote-workroom-history-pending-dismiss-warning').waitFor();
      const confirming = await measure(page);
      verify(confirming, 'confirming');
      // A project this device is not allowed to use: the Mac's refusal must be readable in full.
      await tap(page.getByTestId('remote-workroom-history-pending-dismiss-warning').getByRole('button', {name: '취소'}), '취소');
      await page.getByTestId('remote-workroom-history-project').selectOption(REFUSED);
      await tap(page.getByTestId('remote-workroom-history-load'), '불러오기');
      const message = page.getByTestId('remote-workroom-history-message');
      await message.waitFor();
      check((await message.textContent()).includes(GATEWAY_REFUSAL), `${where}: the refusal is shown as said`);
      const readable = await message.evaluate(el => { const r = el.getBoundingClientRect(); return {clipped: el.scrollWidth > el.clientWidth + 1, right: Math.round(r.right), lines: Math.round(r.height / parseFloat(getComputedStyle(el).lineHeight || '18'))}; });
      check(!readable.clipped && readable.right <= screen, `${where}: the refusal is clipped or off screen ${JSON.stringify(readable)}`);
      const refused = await measure(page);
      verify(refused, 'refused');
      check(external.length === 0, `${where}: requests left the page: ${external.join(', ')}`);
      check(errors.length === 0, `${where}: page errors: ${errors.join(' | ')}`);
      const summary = m => ({docScrollWidth: m.docScrollWidth, innerWidth: m.viewport, panel: `${m.panelLeft}–${m.panelRight}`, selectRight: m.selectRight, selectWidth: m.selectWidth,
        heights: Object.fromEntries(m.targets.filter(t => /history-(load|resume|confirm|check|pending-check|pending-dismiss|project)$|^summary/.test(t.what)).map(t => [t.what, t.height]))});
      results.push({engine: engineName, viewport: `${viewport.width}x${viewport.height}`, coarsePointer: coarse, opened: summary(opened), confirming: summary(confirming), refused: {...summary(refused), message: readable}});
      if (shots) {
        // After every check: Chromium's element screenshot re-applies device metrics and drops the touch emulation, so a
        // capture in the middle would change what (pointer: coarse) matches for the checks that follow.
        const shot = step => panel.screenshot({path: `${shots}/${engineName}-${viewport.width}x${viewport.height}-${step}.png`});
        await page.goto(origin + '/__remote-history-layout');
        await panel.locator('summary').evaluate(el => el.click());
        await page.getByTestId('remote-workroom-history-row').first().waitFor();
        await shot('opened');
        await page.getByTestId('remote-workroom-history-resume').first().evaluate(el => el.click());
        await page.getByTestId('remote-workroom-history-pending-dismiss').first().evaluate(el => el.click());
        await page.getByTestId('remote-workroom-history-pending-dismiss-warning').waitFor();
        await shot('confirming');
        await page.getByTestId('remote-workroom-history-project').selectOption(REFUSED);
        await page.getByTestId('remote-workroom-history-load').evaluate(el => el.click());
        await page.getByTestId('remote-workroom-history-message').waitFor();
        await shot('refused');
      }
      await context.close();
    }
  } finally { await browser.close(); }
}
console.log(JSON.stringify({passed: failures.length === 0, failures, results}, null, 1));
if (failures.length) process.exit(1);
