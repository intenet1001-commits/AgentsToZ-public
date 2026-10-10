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
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

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
const harness = remote => `<!doctype html><meta charset="utf-8"><style>body{margin:0}#root{padding:12px}.ai-terminal-screen{min-height:320px}*{box-sizing:border-box}</style>
<div data-testid="top-toolbar" style="height:40px">app sidebar stand-in</div><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
import React from ${JSON.stringify(react)};
import ReactDOM from ${JSON.stringify(reactDom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const transport=${remote}?async request=>{const r=await fetch('/api/agent-runtime/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});return r.json();}:undefined;
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiTerminalPanel,{projects:${JSON.stringify(projects)},remote:${remote},...(transport?{transport}:{}),entry:{nonce:1,targetId:${JSON.stringify(projects[0].targetId)},sessionId:${JSON.stringify(A)}},sessionScope:'isolated-popout'}));
</script>`;

// WORKROOM_BROWSER_CHANNEL=chrome uses the installed Chrome when the Playwright browser cache is busy.
const browser = await chromium.launch({ headless: true, ...(process.env.WORKROOM_BROWSER_CHANNEL ? { channel: process.env.WORKROOM_BROWSER_CHANNEL } : {}) });
const results = [];
async function fixture(path, extraSessions = []) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, serviceWorkers: 'block' });
  const state = { sessions: [session(A, projects[0].targetId, 'codex'), session(B, projects[1].targetId, 'claude'), ...extraSessions], requests: [], vocPosts: [], unexpected: [], errors: [] };
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { state.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort('blockedbyclient'); }
    if (url.pathname === '/__popout-harness') return route.fulfill({ contentType: 'text/html', body: harness(url.searchParams.get('remote') === '1') });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const respond = body => route.fulfill({ json: body });
    if (url.pathname === '/api/ports' && request.method() === 'GET') return respond(ports);
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
    // The pop-out carries the 「기기」 switch (WorkroomDeviceSwitch, 2026-10-05). With no other Mac in
    // the community the row is not rendered at all, so these checks see exactly the old Workroom.
    if (url.pathname === '/api/agent-dialogue/control') return respond({ inside: false, deviceId: 'fixture-device', devices: [], unread: 0, lastMessageAt: null });
    if (url.pathname === '/api/agent-runtime/voice-settings') return respond({ supported: true, configured: false, model: 'gemini-3.8-live', checkedAt: null, checkedModel: null });
    if (url.pathname !== '/api/agent-runtime/terminals') { state.unexpected.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 503, json: { error: 'Unmocked fixture API' } }); }
    const body = request.postDataJSON();
    state.requests.push(body);
    if (body.operation === 'list') return respond({ sessions: state.sessions });
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
async function run(name, path, execute, extraSessions) {
  const f = await fixture(path, extraSessions);
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

  await run('remote-transport-shows-readable-view-instead-of-popout', '/__popout-harness?remote=1', async ({ page, context }) => {
    assert.equal(await page.getByTestId('workroom-popout').count(), 0, 'A phone must not offer an action that always raises a red error');
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
