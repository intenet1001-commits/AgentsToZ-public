/**
 * Workroom pop-out windows (「새 창으로 분리」) and the wide-view session switcher.
 * Real React + xterm against a completely isolated in-memory API — no app, real
 * project, terminal process or installed API (127.0.0.1:3001) is touched.
 *
 * Run a repository Vite server on a loopback port, then:
 *   WORKROOM_TEST_ORIGIN=http://127.0.0.1:9100 bun tests/workroom-popout.e2e.mjs
 * The web build has no Tauri, so the button takes the window.open fallback; the
 * Tauri window/capability contract is covered by tests/workroom-popout.test.ts and
 * the Rust workroom_popout tests.
 */
import assert from 'node:assert/strict';
import {workroomBackgroundResponse} from './fixtures/workroom-runtime-background-mocks.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { chromium, webkit } from 'playwright';

const origin = process.env.WORKROOM_TEST_ORIGIN || 'http://127.0.0.1:9100';
assert.equal(new URL(origin).hostname, '127.0.0.1', 'The fixture requires a loopback Vite server');
const output = new URL('../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
const source = await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r => {
  assert.equal(r.status, 200, 'Start the repository Vite server before this test');
  return r.text();
});
const dependency = name => {
  const path = source.match(new RegExp(`"([^"\\n]*\/node_modules\/\\.vite\/deps\/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"\\n]*)"`))?.[1];
  assert.ok(path, `Vite optimized dependency ${name} is required`);
  return path;
};
const main = await fetch(`${origin}/src/main.tsx`).then(r => r.text());
const reactDom = main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(reactDom, 'Use the actual Vite react-dom/client dependency URL');
const react = dependency('react.js');

const A = 'fixture-session-alpha';
const B = 'fixture-session-bravo';
const projects = [{ targetId: 'fixture-project-alpha', label: '입력 검증 A' }, { targetId: 'fixture-project-bravo', label: '입력 검증 B' }];
// Project A stands in for AgentsToZ DEV, where a pop-out VOC draft goes.
const ports = projects.map((p, i) => ({ id: p.targetId, name: p.label, folderPath: `/Users/fixture/project-${i}`, ...(i === 0 ? { role: 'dev' } : {}) }));
const session = (id, targetId, agent) => ({ id, targetId, agent, state: 'running', createdAt: '2026-09-25T00:00:00.000Z', exitCode: null, cols: 100, rows: 28 });
const popoutPath = `/?workroom-popout=1&session=${A}&target=${projects[0].targetId}&agent=codex&bypass=1`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await predicate()) return; await wait(20); }
  assert.fail(message);
}
const harness = (remote, dialog = false) => `<!doctype html><meta charset="utf-8"><style>body{margin:0}#root{padding:12px}${dialog?'':'.ai-terminal-screen{min-height:320px}'}*{box-sizing:border-box}</style>
<div data-testid="top-toolbar" style="height:40px">app sidebar stand-in</div><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
import React from ${JSON.stringify(react)};
import ReactDOM from ${JSON.stringify(reactDom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const transport=${remote}?async request=>{const r=await fetch('/api/agent-runtime/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});return r.json();}:undefined;
const panel=React.createElement(AiTerminalPanel,{projects:${JSON.stringify(projects)},remote:${remote},popout:${dialog},...(transport?{transport}:{}),entry:{nonce:1,targetId:${JSON.stringify(projects[0].targetId)},sessionId:${JSON.stringify(A)}},sessionScope:'isolated-popout'});
ReactDOM.createRoot(document.getElementById('root')).render(${dialog ? `React.createElement('dialog',{className:'workroom-session-dialog',ref:node=>{if(node&&!node.open)node.showModal()}},React.createElement('header',{className:'workroom-session-dialog-header'},React.createElement('strong',null,'아젠투지 2호 · 입력 검증 A'),React.createElement('button',{type:'button'},'창 닫기')),React.createElement('div',{className:'workroom-session-dialog-content'},panel))` : 'panel'});
</script>`;

// WORKROOM_BROWSER_CHANNEL=chrome uses the installed Chrome when the Playwright browser cache is busy.
// WebKit covers the same rendering engine used by the installed Mac webview.
const engine = process.env.WORKROOM_BROWSER_ENGINE || 'chromium';
assert.ok(['chromium','webkit'].includes(engine), 'Choose an isolated Chromium or WebKit fixture');
const browser = await (engine==='webkit'?webkit:chromium).launch({ headless: true, ...(engine==='chromium'&&process.env.WORKROOM_BROWSER_CHANNEL ? { channel: process.env.WORKROOM_BROWSER_CHANNEL } : {}) });
const results = [];
async function fixture(path, extraSessions = [], options = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1200, height: 1000 }, serviceWorkers: 'block' });
  if (options.fontSize) await context.addInitScript(size => {if(location.protocol==='http:')localStorage.setItem('portmanager-workroom-font-size', String(size));}, options.fontSize);
  const state = { sessions: options.sessions ?? [session(A, projects[0].targetId, 'codex'), session(B, projects[1].targetId, 'claude'), ...extraSessions], requests: [], scheduleReads: [], vocPosts: [], unexpected: [], errors: [] };
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { state.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort('blockedbyclient'); }
    if (url.pathname === '/__popout-harness') return route.fulfill({ contentType: 'text/html', body: harness(url.searchParams.get('remote') === '1', url.searchParams.get('dialog') === '1') });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const respond = body => route.fulfill({ json: body });
    // The VOC journey needs its explicit synthetic DEV project; other Workroom
    // fixtures use the shared empty suggestions list instead.
    if (url.pathname === '/api/ports' && request.method() === 'GET') return respond(ports);
    if (url.pathname === '/api/agent-runtime/workroom-schedules') state.scheduleReads.push(request.postDataJSON());
    const background = workroomBackgroundResponse(url.pathname, request.method(), request.postDataJSON());
    if (background) return respond(background);
    if (url.pathname === '/api/agent-runtime/targets') return respond({ protocolVersion: 'agentstoz-tasks-v2', complete: true, targets: projects.map(p => ({ ...p, projectTargetId: p.targetId, scope: 'main', branch: 'main', locked: false, worktreeCapable: true })) });
    if (url.pathname === '/api/agent-runtime/terminals/access') return respond({ connections: [] });
    // VOC in the pop-out: the fixture stores nothing; a save answers like a local-only sidecar.
    // The session footer reads the Codex weekly allowance; the fixture reports none.
    if (url.pathname === '/api/ai-usage/codex') return respond({ rateLimits: null });
    if (url.pathname === '/api/voc/access') return respond({ blocked: false });
    if (url.pathname === '/api/client-errors') return respond({ items: [] });
    if (url.pathname === '/api/voc' && request.method() === 'GET') return respond({ items: [] });
    if (url.pathname === '/api/voc' && request.method() === 'POST') { state.vocPosts.push(request.postDataJSON()); return respond({ success: true, file: '2026-09-27-1200-fixture.json', id: 'fixture', attachments: [], delivery: { status: 'local' } }); }
    if (url.pathname === '/api/agent-runtime/terminals/memory') return respond({ jobs: [] });
    // The pop-out asks once for this Mac's restart offer (w14, WorkroomRestartBanner); the fixture has none.
    if (url.pathname === '/api/agent-runtime/terminals/history') return respond({ protocolVersion: 'workroom-history-v1', storeInstanceId: 'popout-history-store-001', restart: null });
    // The regression includes the real three-device header. The other journeys omit the community row.
    if (url.pathname === '/api/agent-dialogue/control') return respond({ success:true, inside: !!options.devices?.length, deviceId: 'fixture-device', devices: options.devices??[], unread: 0, lastMessageAt: null });
    if (url.pathname === '/api/agent-runtime/voice-settings') return respond({ supported: true, configured: false, model: 'gemini-3.8-live', checkedAt: null, checkedModel: null });
    if (url.pathname !== '/api/agent-runtime/terminals') { state.unexpected.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 503, json: { error: 'Unmocked fixture API' } }); }
    const body = request.postDataJSON();
    // The pop-out owns its window's activity long-poll (src/useWorkroomActivity.ts): answer it like an idle host.
    if (body.operation === 'activity') { await wait(1500); return respond({ activity: { bootId: '00000000-0000-4000-8000-000000000001', cursor: 1, reset: !body.after, sessions: [], events: [] } }); }
    state.requests.push(body);
    if (body.operation === 'list') return respond({ sessions: state.sessions });
    if (body.operation === 'accounts' && body.accountAction === 'list' && projects.some(project => project.targetId === body.targetId) && ['codex','claude'].includes(body.agent)) return respond({accounts:{agent:body.agent,selectedAccountId:'host-default',items:[{id:'host-default',agent:body.agent,label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}});
    if (body.operation === 'workspace') return respond({ kind: 'workspace', action: body.workspace.action, workroom: { sessionId: body.workspace.sessionId, initialized: true, lastSavedAt: null, context: { usedPercent: null, observedAt: null, source: 'unavailable' }, save: { requestId: null, state: 'idle', localSaved: false, backupSaved: false, message: '' } } });
    const current = state.sessions.find(s => s.id === body.sessionId);
    if (!current) return route.fulfill({ status: 404, json: { error: 'unknown session' } });
    if (body.operation === 'read') return respond({ session: current, chunks: body.after ? [] : [{ seq: 1, text: `${body.sessionId === A ? 'ALPHA' : 'BRAVO'}_READY\r\n` }], nextCursor: 1, truncated: false, hasMore: false });
    if (body.operation === 'close') return route.fulfill({ status: 500, json: { error: 'The fixture never closes a session' } });
    return respond({ session: current });
  });
  context.on('page', page => page.on('pageerror', error => state.errors.push(`${page.url()}: ${error.message}`)));
  const page = await context.newPage();
  await page.goto(origin + path);
  await page.getByTestId('ai-terminal-panel').waitFor({ timeout: 15000 }).catch(error => { throw new Error(error.message + ' errors=' + JSON.stringify(state.errors) + ' blocked=' + JSON.stringify(state.unexpected)); });
  return { context, page, state };
}
const selectedTab = page => page.getByRole('tab', { selected: true }).textContent();
async function run(name, path, execute, extraSessions, options) {
  const f = await fixture(path, extraSessions, options);
  try {
    const measurements = await execute(f);
    assert.deepEqual(f.state.unexpected, [], 'Every API request must be mocked and external traffic blocked: ' + JSON.stringify(f.state.unexpected));
    assert.deepEqual(f.state.errors, [], 'The real React/xterm component must not throw');
    assert.ok(!f.state.requests.some(r => r.operation === 'close'), 'Opening, switching or closing a window must never close a CLI session');
    results.push({ name, status: 'passed', ...measurements });
    console.log(`PASS ${name}${measurements ? ' ' + JSON.stringify(measurements) : ''}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
    await f.page.screenshot({ path: new URL(`workroom-popout-${name}.png`, output).pathname, fullPage: true }).catch(() => {});
  } finally {
    await f.context.close();
  }
}

try {
  await run('agentstoz-unfinished-work-prepares-a-request-without-sending-or-replacing-a-draft', popoutPath, async ({page,state}) => {
    const composer=page.getByRole('textbox',{name:'워크룸 입력'});
    const button=page.getByTestId('workroom-unfinished-work');
    await button.waitFor();
    const sentBefore=state.requests.filter(request=>['input','submit'].includes(request.operation)).length;
    await composer.fill('작성 중인 요청');
    await button.click();
    assert.equal(await composer.inputValue(),'작성 중인 요청','A pending draft is never overwritten');
    await composer.fill('');
    await button.click();
    assert.equal(await composer.inputValue(),'agentstoz-unfinished-work 스킬을 사용해 이 프로젝트의 미처리 업무를 확인해 주세요.');
    assert.equal(state.requests.filter(request=>['input','submit'].includes(request.operation)).length,sentBefore,'The user must explicitly send the prepared request');
  });
  await run('schedule-controls-open-only-on-request-and-leave-the-initial-composer-visible', popoutPath, async ({page,state}) => {
    const composer=page.getByTestId('workroom-command-composer');
    await composer.waitFor();
    assert.equal(await page.getByTestId('workroom-schedule-card').count(),0);
    assert.deepEqual(state.scheduleReads,[], 'A closed schedule panel does not query its host');
    const opener=page.getByTestId('workroom-schedule-open');
    await opener.click();
    await page.getByTestId('workroom-schedule-card').waitFor();
    await until(()=>state.scheduleReads.length>0,'Opening schedule controls reads this exact session');
    // The real app uses StrictMode, which can replay a mount read in development. Every read stays scoped.
    for(const request of state.scheduleReads)assert.deepEqual(request,{operation:'list',sessionId:A});
    await opener.click();
    await page.getByTestId('workroom-schedule-card').waitFor({state:'detached'});
    const closedReads=state.scheduleReads.length;await wait(50);assert.equal(state.scheduleReads.length,closedReads,'Closing schedule controls stops its reads');
    const rect=await composer.boundingBox();
    assert.ok(rect&&rect.y>=0&&rect.y+rect.height<=780,'Closing schedule controls restores the laptop composer: '+JSON.stringify(rect));
  },[],{viewport:{width:1120,height:780},fontSize:16});
  await run('laptop-popup-keeps-composer-visible-with-ended-session-and-font16', popoutPath, async ({page,state}) => {
    await page.getByTestId('workroom-popout-window').waitFor();
    await until(async () => (await selectedTab(page))?.includes('입력 검증 A'), 'The actual popup selects its active session');
    assert.equal(await page.getByTestId('workroom-font-size').textContent(),'16','The saved real-Mac terminal preference is applied');
    await page.getByRole('button',{name:'종료된 세션 보기 (1)',exact:true}).waitFor();
    await page.getByTestId('workroom-device-tabs').waitFor();
    const composer=page.getByRole('textbox',{name:'워크룸 입력'}),send=page.getByRole('button',{name:'현재 세션에 전송',exact:true});
    const initiallyVisible=async()=>{
      for(const control of [composer,send,page.getByTestId('workroom-command-composer')]){const rect=await control.boundingBox();assert.ok(rect&&rect.y>=0&&rect.y+rect.height<=780,'The composer and send button are fully visible on the initial laptop screen without scrolling: '+JSON.stringify(rect));}
      assert.equal(await page.locator('.ai-terminal-panel').evaluate(node=>node.scrollTop),0,'The first view has not been scrolled to reveal the composer');
    };
    await initiallyVisible();
    // 팀 작전 opens from the session's own controls, in sight without scrolling; on the usage line under the terminal it
    // was out of sight in a short window (2026-10-25). The builder opens under the terminal and is brought into view.
    const teamOpen=page.locator('.ai-terminal-view-controls').getByTestId('workroom-team-open'),teamBox=await teamOpen.boundingBox();
    assert.ok(teamBox&&teamBox.y>=0&&teamBox.y+teamBox.height<=780,'The team opener is visible on the first screen: '+JSON.stringify(teamBox));
    await page.setViewportSize({width:1120,height:587});await teamOpen.click();
    await until(async()=>{const box=await page.getByTestId('workroom-team-builder').boundingBox();return !!box&&box.y>=0&&box.y<587;},'The opened team builder is scrolled into a short window');
    await teamOpen.click();await until(async()=>await page.getByTestId('workroom-team-builder').count()===0,'The opener closes the builder again');
    await page.setViewportSize({width:1120,height:780});await page.locator('.ai-terminal-panel').evaluate(node=>node.scrollTo(0,0));
    await page.getByRole('button',{name:'종료된 세션 보기 (1)',exact:true}).click();
    await until(async()=>await page.getByRole('tab').count()===2,'Active and ended sessions remain accessible');
    await initiallyVisible();
    const terminalHost=await page.locator('.ai-terminal-screen').elementHandle();
    assert.ok((await terminalHost.boundingBox()).height>=200,'The visible terminal has room for at least ten lines at font16');
    await composer.fill('작은 Mac 화면에서 한글 초안을 그대로 입력합니다.');
    await page.getByRole('button',{name:'계정 관리',exact:true}).click();
    const accountName=page.getByRole('textbox',{name:'추가할 CLI 계정 이름'});await accountName.scrollIntoViewIfNeeded();assert.ok(await accountName.isVisible(),'Account management remains reachable in the same popup');
    await page.getByRole('button',{name:'계정 관리',exact:true}).click();
    await page.locator('.ai-terminal-panel').evaluate(node=>node.scrollTo(0,0));
    await initiallyVisible();assert.equal(await composer.inputValue(),'작은 Mac 화면에서 한글 초안을 그대로 입력합니다.');
    assert.equal(await terminalHost.evaluate(node=>node.isConnected&&node===document.querySelector('.ai-terminal-screen')),true,'Showing settings never unmounts the live terminal');
    await send.click();await until(()=>state.requests.some(request=>request.operation==='input'&&request.sessionId===A&&request.data==='작은 Mac 화면에서 한글 초안을 그대로 입력합니다.\r'),'The initially visible composer still sends to the selected session');
    assert.ok(!state.requests.some(request=>request.operation==='start'||request.operation==='close'),'Changing the layout and settings preserves the existing host session');
    await page.screenshot({path:new URL('workroom-popout-font16-session-tabs.png',output).pathname,fullPage:false});
    return {engine,fontSize:16,viewport:{width:1120,height:780},terminalHeight:Math.round((await terminalHost.boundingBox()).height),composer:(await composer.boundingBox()).y};
  },[],{viewport:{width:1120,height:780},fontSize:16,devices:[{endpointId:'fixture-endpoint-two',deviceId:'fixture-device-two',displayName:'아젠투지2호',kind:'ops',lastSeenAt:null},{endpointId:'fixture-endpoint-three',deviceId:'fixture-device-three',displayName:'아젠투지3호',kind:'ops',lastSeenAt:null}],sessions:[session(A,projects[0].targetId,'codex'),{...session(B,projects[1].targetId,'claude'),state:'exited',exitCode:0}]});
  await run('popup-viewport-keeps-output-and-controls-reachable', popoutPath, async ({page}) => {
    await page.getByTestId('workroom-popout-window').waitFor();
    await until(async () => (await selectedTab(page))?.includes('입력 검증 A'), 'The popup opens on the selected session');
    const measurements = [];
    for (const viewport of [{width:1440,height:1200}, {width:1440,height:1000}, {width:1120,height:780}, {width:900,height:650}, {width:520,height:480}, {width:390,height:640}]) {
      await page.setViewportSize(viewport);
      const box = page.getByRole('textbox', {name:'워크룸 입력'});
      await box.scrollIntoViewIfNeeded();
      const measure = await page.evaluate(() => {
        const panel = document.querySelector('.ai-terminal-panel'), surface = document.querySelector('.ai-terminal-surface');
        const screen = document.querySelector('.ai-terminal-screen'), shell = document.querySelector('.workroom-popout');
        const rect = node => { const box = node.getBoundingClientRect(); return {x:box.x, width:box.width, height:box.height}; };
        return {panel:rect(panel), surface:rect(surface), screen:rect(screen), shell:rect(shell), scrollWidth:document.documentElement.scrollWidth,
          panelScrollWidth:panel.scrollWidth, panelClientWidth:panel.clientWidth, panelScrollHeight:panel.scrollHeight, panelClientHeight:panel.clientHeight};
      });
      assert.ok(measure.scrollWidth <= viewport.width + 1, `${viewport.width}px popup must not overflow horizontally: ${JSON.stringify(measure)}`);
      assert.ok(measure.panelScrollWidth <= measure.panelClientWidth + 1, 'Toolbar, composer and footer stay inside the popup');
      assert.ok(measure.surface.height >= (viewport.width <= 640 ? 160 : 220) - 1, 'Short windows retain a usable terminal, with scrolling for controls');
      assert.ok(measure.screen.height >= (viewport.width <= 640 ? 140 : 200), 'The actual xterm host receives enough height for the output');
      for (const control of [box, page.getByRole('button', {name:'현재 세션에 전송'}), page.getByTestId('workroom-session-footer')]) {
        await control.scrollIntoViewIfNeeded();
        const rect = await control.boundingBox();
        assert.ok(rect && rect.x >= -1 && rect.x + rect.width <= viewport.width + 1, 'Controls can be reached without horizontal scrolling');
        assert.ok(rect.y < viewport.height && rect.y + rect.height > 0, 'Short windows scroll to composer and footer');
      }
      measurements.push({...viewport, terminalHeight:Math.round(measure.screen.height), scrolls:measure.panelScrollHeight > measure.panelClientHeight + 1});
    }
    await page.setViewportSize({width:1120,height:780});
    await page.evaluate(()=>document.querySelector('.ai-terminal-panel').scrollTo(0,0));
    const initialComposer=await page.getByTestId('workroom-command-composer').boundingBox();
    assert.ok(initialComposer&&initialComposer.y>=0&&initialComposer.y+initialComposer.height<=780,'The initial laptop popup shows the whole composer without scrolling');
    const memoryDrawer=page.getByTestId('workroom-memory-drawer');
    assert.equal(await memoryDrawer.getAttribute('open'),null,'Dedicated views start with secondary memory settings folded');
    assert.equal(await page.getByTestId('workroom-memory-purpose').isVisible(),false);
    await memoryDrawer.locator(':scope > summary').click();
    assert.equal(await page.getByTestId('workroom-memory-purpose').isVisible(),true,'Opening the drawer restores the existing memory status and settings');
    await memoryDrawer.locator(':scope > summary').click();
    await page.getByTestId('workroom-composer-toggle').click();
    const prompt = page.getByRole('textbox', {name:'터미널에 전달할 작업'});
    await prompt.scrollIntoViewIfNeeded();
    await prompt.fill('크기가 작은 화면에서도 작성칸을 유지합니다.');
    assert.equal(await prompt.inputValue(), '크기가 작은 화면에서도 작성칸을 유지합니다.');
    await page.getByTestId('workroom-session-footer').scrollIntoViewIfNeeded();
    return {viewports:measurements};
  });
  await run('remote-dialog-uses-the-same-large-session-layout', '/__popout-harness?remote=1&dialog=1', async ({page}) => {
    await page.getByRole('dialog').waitFor();
    await page.locator('.workroom-session-dialog .ai-terminal-surface').waitFor({state:'visible'});
    const measurements=[];
    for (const viewport of [{width:1120,height:780},{width:900,height:650},{width:390,height:640}]) {
      await page.setViewportSize(viewport);
      const geometry=await page.locator('.workroom-session-dialog').evaluate(node=>{
        const rect=node.getBoundingClientRect(),surface=node.querySelector('.ai-terminal-surface').getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,terminalHeight:surface.height};
      });
      assert.ok(geometry.x>=0&&geometry.y>=0&&geometry.x+geometry.width<=viewport.width+1&&geometry.y+geometry.height<=viewport.height+1,'The full-size dialog stays inside the current viewport');
      assert.ok(geometry.terminalHeight>=(viewport.width<=640?160:220)-1,'Peer sessions keep a usable terminal in their modal view');
      for(const control of [page.getByRole('textbox',{name:'워크룸 입력'}),page.getByTestId('workroom-session-footer')]){
        await control.scrollIntoViewIfNeeded();
        const rect=await control.boundingBox();
        assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=viewport.width+1&&rect.y<viewport.height&&rect.y+rect.height>0,'Dialog controls remain reachable on small screens');
      }
      measurements.push({viewportWidth:viewport.width,viewportHeight:viewport.height,...geometry});
    }
    return {viewports:measurements};
  });
  await run('popout-route-renders-only-the-workroom-and-switches', popoutPath, async ({ page, state }) => {
    await page.getByTestId('workroom-popout-window').waitFor();
    assert.equal(await page.getByTestId('top-toolbar').count(), 0, 'A pop-out must not render the app shell');
    await until(async () => (await selectedTab(page))?.includes('입력 검증 A'), 'The pop-out must open on the chosen session');
    await until(() => state.requests.some(r => r.operation === 'read' && r.sessionId === A), 'The chosen session must be read');
    assert.equal(await page.getByTestId('workroom-wide-toggle').count(), 0, 'A pop-out has no sidebar to hide');
    await page.getByRole('textbox', { name: '워크룸 입력' }).waitFor();
    await until(async () => (await page.title()).includes('입력 검증 A · Codex CLI'), 'The window title names the project and agent');
    await page.getByRole('tab').filter({ hasText: '입력 검증 B' }).click();
    await until(async () => (await selectedTab(page))?.includes('입력 검증 B'), 'Session switching must work inside a pop-out');
    await until(() => state.requests.some(r => r.operation === 'read' && r.sessionId === B), 'The switched session must be read');
    await until(async () => (await page.title()).includes('입력 검증 B · Claude Code'), 'The title follows the switched session');
    // 「세션 기억하기」 must not silently vanish in a pop-out. Session B is Claude, which has the
    // slash command, so the button types it into that live CLI (CLAUDE.md 2026-10-04) — the draft
    // path stays for codex/agy. Either way the pop-out acts on its own window's session.
    assert.equal(await page.getByTestId('workroom-remember-session').textContent(), '이 세션에서 기억하기');
    await page.getByTestId('workroom-remember-session').click();
    await until(() => state.requests.some(r => r.operation === 'input' && r.sessionId === B && String(r.data).includes('remember-session')),
      'Remember-session acts on this pop-out window\'s session');
    assert.ok(!state.requests.some(r => r.operation === 'start'), 'It must never start a new session');
    assert.ok(!state.requests.some(r => r.operation === 'input' && r.sessionId === A), 'and never reach the session this window left');
    return { title: await page.title() };
  });

  await run('button-opens-several-independent-windows', '/__popout-harness', async ({ page, context, state }) => {
    const button = page.getByTestId('workroom-popout');
    await button.waitFor();
    assert.equal(await button.getAttribute('aria-disabled'), 'false');
    const [first] = await Promise.all([context.waitForEvent('page'), button.click()]);
    const [second] = await Promise.all([context.waitForEvent('page'), button.click()]);
    for (const popup of [first, second]) {
      await popup.waitForLoadState();
      const url = new URL(popup.url());
      assert.equal(url.origin, origin);
      assert.equal(url.search, popoutPath.slice(1), 'The pop-out URL carries opaque ids only');
      await popup.getByTestId('workroom-popout-window').waitFor({ timeout: 15000 });
      await until(async () => (await selectedTab(popup))?.includes('입력 검증 A'), 'Each pop-out opens on the chosen session');
    }
    // A pop-out switching sessions never moves the main window's selection.
    await second.getByRole('tab').filter({ hasText: '입력 검증 B' }).click();
    await until(async () => (await selectedTab(second))?.includes('입력 검증 B'), 'The second pop-out switched');
    assert.ok((await selectedTab(page)).includes('입력 검증 A'), 'The main window selection must not change');
    assert.ok((await selectedTab(first)).includes('입력 검증 A'), 'Another pop-out selection must not change');
    // Two windows typing into the same session: each request has its own id and arrives intact.
    const from = state.requests.length;
    for (const [win, text] of [[page, 'main-window-line'], [first, 'popout-window-line']]) {
      const box = win.getByRole('textbox', { name: '워크룸 입력' });
      await box.fill(text);
      await win.getByRole('button', { name: '현재 세션에 전송' }).click();
    }
    await until(() => state.requests.slice(from).filter(r => r.operation === 'input' && r.sessionId === A).length === 2, 'Both windows must deliver their line to the same session');
    const sent = state.requests.slice(from).filter(r => r.operation === 'input' && r.sessionId === A);
    assert.deepEqual(sent.map(r => r.data).sort(), ['main-window-line\r', 'popout-window-line\r']);
    assert.notEqual(sent[0].requestId, sent[1].requestId, 'Request ids are per window and never collide');
    // Raw terminal input is per window.
    await first.getByRole('button', { name: '터미널 직접 입력' }).click();
    assert.equal(await first.getByRole('button', { name: '직접 입력 끄기' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '터미널 직접 입력' }).getAttribute('aria-pressed'), 'false', 'Raw input in one window must not switch on another');
    // One PTY has one size: the window the user comes back to must re-assert its own size,
    // otherwise it keeps wrapping at the pop-out's width (seen in the real app, 2026-09-25).
    await first.setViewportSize({ width: 640, height: 560 });
    await until(() => state.requests.some(r => r.operation === 'resize' && r.sessionId === A && r.cols < 80), 'The smaller pop-out resizes the shared session');
    const popoutCols = state.requests.filter(r => r.operation === 'resize' && r.sessionId === A).at(-1).cols;
    const beforeFocus = state.requests.length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(() => state.requests.slice(beforeFocus).some(r => r.operation === 'resize' && r.sessionId === A && r.cols > popoutCols), 'The main window re-asserts its wider size when it comes back to the front');
    await first.close(); await second.close();
    await wait(300);
    assert.ok((await selectedTab(page)).includes('입력 검증 A'), 'Closing pop-outs leaves the main window as it was');
    return { windows: 2 };
  });

  await run('remote-transport-shows-readable-view-instead-of-popout', '/__popout-harness?remote=1', async ({ page, context, state }) => {
    assert.equal(await page.getByTestId('workroom-popout').count(), 0, 'A phone must not offer an action that always raises a red error');
    const pendingWork=page.getByTestId('workroom-unfinished-work');
    await pendingWork.click();
    assert.equal(await page.getByRole('textbox',{name:'워크룸 입력'}).inputValue(),'agentstoz-unfinished-work 스킬을 사용해 이 프로젝트의 미처리 업무를 확인해 주세요.');
    assert.equal(state.requests.filter(request=>['input','submit'].includes(request.operation)).length,0,'The phone also prepares without sending');
    const button = page.getByTestId('workroom-readable-toggle');
    await button.waitFor();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    let opened = false; context.on('page', () => { opened = true; });
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByTestId('workroom-readable-screen').count(), 0);
    assert.equal(opened, false, 'A remote pairing must never open a window it cannot drive');
  });

  await run('wide-view-keeps-the-session-switcher', '/__popout-harness', async ({ page, state }) => {
    await page.getByTestId('workroom-wide-toggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.workroomWide), 'true');
    assert.equal(await page.getByTestId('top-toolbar').isVisible(), false, 'Wide view hides the app sidebar');
    const tab = page.getByRole('tab').filter({ hasText: '입력 검증 B' });
    assert.ok(await tab.isVisible(), 'The session list must stay visible in wide view');
    const box = await tab.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, 'The session switcher must be on screen in wide view');
    await tab.click();
    await until(async () => (await selectedTab(page))?.includes('입력 검증 B'), 'Switching must work in wide view');
    await until(() => state.requests.some(r => r.operation === 'read' && r.sessionId === B), 'The switched session must be read in wide view');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.workroomWide), 'true', 'Switching keeps wide view');
    return { tabY: Math.round(box.y) };
  });
  await run('same-project-sessions-get-told-apart', '/__popout-harness', async ({ page }) => {
    await until(async () => (await page.getByRole('tab').count()) === 3, 'All three sessions are listed');
    const names = await page.getByRole('tab').allTextContents();
    assert.ok(names.some(n => n.includes('입력 검증 A · codex #1')), 'The older duplicate is #1: ' + names);
    assert.ok(names.some(n => n.includes('입력 검증 A · codex #2')), 'The newer duplicate is #2: ' + names);
    assert.ok(names.some(n => n.includes('입력 검증 B · claude') && !n.includes('#')), 'A unique session keeps its plain name');
    // The owner prefix was added deliberately (8d8e51dd, 「OPS와 프로젝트 기기 라벨 구분」);
    // this assertion was simply left behind. Pin both facts rather than loosening it.
    const tooltip = await page.getByRole('tab').filter({ hasText: '#2' }).getAttribute('title');
    assert.match(tooltip, / · \d{2}:\d{2} 시작$/, 'The tab tooltip shows when it started: ' + tooltip);
    assert.ok(tooltip.startsWith('이 기기'), 'and which device owns it: ' + tooltip);
    return { names };
  }, [{ ...session('fixture-session-charlie', projects[0].targetId, 'codex'), createdAt: '2026-09-25T00:05:00.000Z' }]);
  await run('popout-voc-shortcut-saves-and-drafts-into-this-workroom', popoutPath, async ({ page, state }) => {
    await page.getByTestId('workroom-popout-window').waitFor();
    await until(async () => (await selectedTab(page))?.includes('입력 검증 A'), 'The pop-out opens on the chosen session');
    await page.keyboard.press('Meta+Shift+KeyV');
    await page.getByTestId('voc-banner').waitFor({ timeout: 8000 });
    // The overlay takes every pointer event: pick the element under a point inside the Workroom.
    const box = await page.getByTestId('ai-terminal-panel').boundingBox();
    await page.mouse.click(box.x + 40, box.y + 60);
    await page.getByTestId('voc-comment').fill('팝아웃에서 남긴 개선 요청');
    await page.getByTestId('voc-save-and-workroom').click();
    await until(() => state.vocPosts.length === 1, 'The VOC is saved through the same /api/voc');
    assert.equal(state.vocPosts[0].tab, 'workroom-popout', 'The saved VOC says it came from a pop-out');
    await page.getByTestId('voc-banner').waitFor({ state: 'detached' });
    await until(async () => (await page.getByRole('textbox', { name: '터미널에 전달할 작업' }).inputValue().catch(() => '')).includes('2026-09-27-1200-fixture.json'), 'The VOC draft fills this window\'s Workroom composer');
    await page.getByTestId('workroom-popout-notice').waitFor();
    assert.ok(!state.requests.some(r => r.operation === 'start'), 'A VOC draft never starts a session by itself');
    // The shortcut toggles: on and off again without saving.
    await page.keyboard.press('Meta+Shift+KeyV');
    await page.getByTestId('voc-banner').waitFor();
    await page.keyboard.press('Meta+Shift+KeyV');
    await page.getByTestId('voc-banner').waitFor({ state: 'detached' });
  });
} finally {
  await browser.close();
  await writeFile(new URL('workroom-popout-results.json', output), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + '\n');
}
console.log(`${results.filter(r => r.status === 'passed').length}/${results.length} workroom pop-out checks passed`);
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
