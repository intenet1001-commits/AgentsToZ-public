/**
 * Real React + xterm regression tests, with a completely isolated in-memory API.
 * Run Vite on 127.0.0.1:9000, then: node tests/workroom-input-lifecycle.e2e.mjs
 * No app, real project, terminal process, or installed API is accessed.
 * Chromium CDP generates composition events; this does not replace a macOS IME check.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const origin = process.env.WORKROOM_TEST_ORIGIN || 'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname, '127.0.0.1', 'The fixture requires a loopback Vite server');
const output = new URL('../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
const source = await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r => {
  assert.equal(r.status, 200, 'Start the repository Vite server before this test');
  return r.text();
});
function dependency(name) {
  const path = source.match(new RegExp(`"([^"\\n]*\/node_modules\/\\.vite\/deps\/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"\\n]*)"`))?.[1];
  assert.ok(path, `Vite optimized dependency ${name} is required`);
  return path;
}
// Optional pre-transformed baseline replaces only this browser module response.
// The source worktree and the installed application remain untouched.
const moduleOverride = process.env.WORKROOM_TEST_MODULE
  ? (await readFile(process.env.WORKROOM_TEST_MODULE, 'utf8')).replace(/\?v=[a-f0-9]+/g, source.match(/\?v=[a-f0-9]+/)?.[0] || '')
  : null;
const resultSuffix = moduleOverride ? '-baseline' : '';
const react = dependency('react.js');
const xterm = dependency('@xterm_xterm.js');
const main = await fetch(`${origin}/src/main.tsx`).then(r => {
  assert.equal(r.status, 200, 'The Vite entry module is required');
  return r.text();
});
// Newly optimized dependencies may have a different hash from React itself.
const reactDom = main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(reactDom, 'Use the actual Vite react-dom/client dependency URL');
const session = (id, targetId, agent = 'codex') => ({ id, targetId, agent, state: 'running', createdAt: '2026-09-06T00:00:00.000Z', exitCode: null, cols: 100, rows: 28 });
const A = 'fixture-session-alpha';
const B = 'fixture-session-bravo';
const projects = [{ targetId: 'fixture-project-alpha', label: '입력 검증 A' }, { targetId: 'fixture-project-bravo', label: '입력 검증 B' }];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await wait(10);
  }
  assert.fail(message);
}
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#f5f3ef;color:#262626;font:14px system-ui}#root{padding:12px}
.ai-terminal-screen{min-height:320px}*{box-sizing:border-box}
</style><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
import React from ${JSON.stringify(react)};
import ReactDOM from ${JSON.stringify(reactDom)};
const {createRoot}=ReactDOM;
import {Terminal} from ${JSON.stringify(xterm)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
window.__workroom={instances:[],writes:[],composition:[]};
const open=Terminal.prototype.open;Terminal.prototype.open=function(...args){window.__workroom.instances.push(this);return open.apply(this,args)};
const write=Terminal.prototype.write;Terminal.prototype.write=function(data,callback){const event={text:typeof data==='string'?data:new TextDecoder().decode(data),at:performance.now(),instance:window.__workroom.instances.indexOf(this)};window.__workroom.writes.push(event);return write.call(this,data,()=>{event.appliedAt=performance.now();callback?.()})};
for(const type of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(type,event=>window.__workroom.composition.push({type,data:event.data}));
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
createRoot(document.getElementById('root')).render(React.createElement(AiTerminalPanel,{projects:${JSON.stringify(projects)},entry:{nonce:1,targetId:${JSON.stringify(projects[0].targetId)},sessionId:${JSON.stringify(A)}},sessionScope:'isolated-regression'}));
</script>`;

const browser = await chromium.launch({ headless: true });
const results = [];
async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 1050 }, serviceWorkers: 'block' });
  const state = {
    sessions: [session(A, projects[0].targetId), session(B, projects[1].targetId, 'claude')],
    requests: [], unexpected: [], errors: [], chunks: new Map([[A, []], [B, []]]), beforeRead: null, beforeOperation: null,
  };
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      state.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/src/AiTerminalPanel.tsx' && moduleOverride) return route.fulfill({ contentType: 'text/javascript', body: moduleOverride });
    if (url.pathname === '/__workroom-regression') return route.fulfill({ contentType: 'text/html', body: html });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const respond = body => route.fulfill({ json: body });
    if (url.pathname === '/api/agent-runtime/targets') return respond({ protocolVersion: 'agentstoz-tasks-v2', complete: true, targets: projects.map(p => ({ ...p, projectTargetId: p.targetId, scope: 'main', branch: 'main', locked: false, worktreeCapable: true })) });
    if (url.pathname === '/api/agent-runtime/terminals/access') return respond({ connections: [] });
    if (url.pathname === '/api/agent-runtime/terminals/memory') return respond({ jobs: [] });
    if (url.pathname !== '/api/agent-runtime/terminals') {
      state.unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 503, json: { error: 'Unmocked fixture API; no real API access is allowed' } });
    }
    const body = request.postDataJSON();
    state.requests.push({ ...body, at: performance.now() });
    if (state.beforeOperation) {
      const overridden = await state.beforeOperation(body);
      if (overridden) return route.fulfill({status: overridden.status ?? 200, json: overridden.body});
    }
    if (body.operation === 'list') {
      if (options.initialListDelayMs) await wait(options.initialListDelayMs);
      return respond({ sessions: state.sessions });
    }
    const current = state.sessions.find(s => s.id === body.sessionId);
    assert.ok(current, `Unknown fixture session for ${body.operation}`);
    if (body.operation === 'read') {
      if (state.beforeRead) {
        const overridden = await state.beforeRead(body);
        if (overridden) return respond(overridden);
      }
      const all = state.chunks.get(body.sessionId) || [];
      const pending = all.filter(c => c.seq > body.after);
      const chunks = pending.slice(0, 4);
      return respond({ session: current, chunks, nextCursor: chunks.at(-1)?.seq ?? body.after, truncated: false, hasMore: pending.length > chunks.length });
    }
    if (body.operation === 'close') {
      current.state = 'exited'; current.exitCode = 143;
      return respond({ session: current });
    }
    assert.ok(['input', 'resize'].includes(body.operation), `Unexpected fixture operation ${body.operation}`);
    return respond({ session: current });
  });
  const page = await context.newPage();
  const initializationFailures = [];
  page.on('console', message => { if (message.type() === 'error') initializationFailures.push(message.text()); });
  page.on('requestfailed', request => initializationFailures.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) initializationFailures.push(`${response.status()} ${response.url()}`); });
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto(`${origin}/__workroom-regression`);
  await page.getByTestId('ai-terminal-panel').waitFor({timeout: 10000}).catch(error => { throw new Error(error.message + '\nBrowser errors: ' + JSON.stringify(state.errors) + '\nBlocked: ' + JSON.stringify(state.unexpected) + '\nInitialization: ' + JSON.stringify(initializationFailures)); });
  await until(() => state.requests.some(r => r.operation === 'read' && r.sessionId === A), 'The initial fixture terminal was not read');
  return { context, page, state };
}
async function run(name, execute, options) {
  const f = await fixture(options);
  try {
    const measurements = await execute(f);
    assert.deepEqual(f.state.unexpected, [], 'Every API request must be mocked and external traffic blocked');
    assert.deepEqual(f.state.errors, [], 'The real React/xterm component must not throw');
    results.push({ name, status: 'passed', ...measurements });
    console.log(`PASS ${name}${measurements ? ' ' + JSON.stringify(measurements) : ''}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
    await f.page.screenshot({ path: new URL(`workroom-${name}.png`, output).pathname, fullPage: true }).catch(() => {});
  } finally {
    await f.context.close();
  }
}
function inputs(state, from = 0) {
  return state.requests.slice(from).filter(r => r.operation === 'input');
}
async function focusTerminal(page) {
  await page.locator('.xterm-helper-textarea').focus();
}
async function compose(cdp, values, committed) {
  for (const text of values) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  const committedAt = performance.now();
  await cdp.send('Input.insertText', { text: committed });
  return committedAt;
}

try {
  await run('read-outage-backoff-and-recovery', async ({ page, state }) => {
    let unavailable = true;
    state.beforeOperation = async body => body.operation === 'read' && unavailable
      ? {status: 503, body: {error: 'fixture output unavailable'}} : undefined;
    await page.getByRole('alert').filter({hasText: 'fixture output unavailable'}).waitFor();
    const from = state.requests.length;
    await wait(2700);
    const failedReads = state.requests.slice(from).filter(r => r.operation === 'read');
    assert.ok(failedReads.length <= 3, `Output outage generated ${failedReads.length} reads in 2.7s`);
    assert.ok(failedReads.length >= 1, 'A failed output read must remain recoverable');
    unavailable = false;
    state.chunks.set(A, [{seq: 1, text: 'RECOVERED_OUTPUT\r\n'}]);
    // A successful input wakes output immediately even during read backoff.
    const inputFrom = state.requests.length;
    await page.getByRole('button', {name: 'Enter', exact: true}).click();
    await until(() => page.evaluate(() => window.__workroom.writes.some(w => w.text.includes('RECOVERED_OUTPUT') && w.appliedAt !== undefined)), 'Successful input did not wake the backed-off output read', 1500);
    assert.equal(inputs(state, inputFrom).length, 1, 'Recovery must not retransmit input');
    await until(async () => await page.getByRole('alert').count() === 0, 'Recovered output kept the stale read error');
    return {failedReads: failedReads.length};
  });

  await run('read-recovery-preserves-action-error', async ({ page, state }) => {
    state.beforeOperation = async body => body.operation === 'input'
      ? {status: 400, body: {error: 'fixture input rejected'}} : undefined;
    await page.getByRole('button', {name: 'Enter', exact: true}).click();
    await page.getByRole('alert').filter({hasText: 'fixture input rejected'}).waitFor();
    state.chunks.set(A, [{seq: 1, text: 'HEALTHY_OUTPUT\r\n'}]);
    await until(() => page.evaluate(() => window.__workroom.writes.some(w => w.text.includes('HEALTHY_OUTPUT'))), 'Output read did not recover');
    assert.match(await page.getByRole('alert').innerText(), /fixture input rejected/, 'A healthy read must not hide a rejected user action');
  });

  await run('idle-read-budget', async ({ state }) => {
    const from = state.requests.length;
    await wait(4500);
    const reads = state.requests.slice(from).filter(r => r.operation === 'read');
    assert.ok(reads.length <= 6, `An idle terminal issued ${reads.length} output reads in 4.5s`);
    assert.ok(reads.length >= 2, 'An idle terminal must continue observing output');
    return {idleReads: reads.length};
  });

  await run('korean-ime-input', async ({ page, state }) => {
    const cdp = await page.context().newCDPSession(page);
    await focusTerminal(page);
    const from = state.requests.length;
    await cdp.send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 });
    await wait(100);
    assert.equal(inputs(state, from).length, 0, 'Korean preedit text must not be sent before composition is committed');
    const started = await compose(cdp, ['한', '한글', '한글 입력', '한글 입력 테스트'], '한글 입력 테스트');
    await until(() => inputs(state, from).map(r => r.data).join('') === '한글 입력 테스트', 'Committed Korean was lost, duplicated, or corrupted');
    const commitToWireMs = performance.now() - started;
    assert.ok(commitToWireMs < 500, `Committed Korean input took ${Math.round(commitToWireMs)}ms to reach the transport`);
    await wait(120);
    assert.equal(inputs(state, from).map(r => r.data).join(''), '한글 입력 테스트', 'Delayed composition handling duplicated Korean input');
    await cdp.send('Input.insertText', { text: ' English ' });
    await compose(cdp, ['ㅎ', '하', '한'], '한');
    await compose(cdp, ['ㅇ', '여', '영'], '영');
    await cdp.send('Input.insertText', { text: '🙂🚀' });
    const pasted = ' 붙여넣기 한국어 🙂\nsecond line';
    await page.locator('.xterm-helper-textarea').evaluate((textarea, text) => {
      const data = new DataTransfer(); data.setData('text/plain', text);
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, pasted);
    const expected = '한글 입력 테스트 English 한영🙂🚀' + pasted.replaceAll('\n', '\r');
    await until(() => inputs(state, from).map(r => r.data).join('') === expected, 'Mixed Korean/English, emoji, or paste text did not arrive exactly once');
    await wait(150);
    assert.equal(inputs(state, from).map(r => r.data).join(''), expected);
    assert.ok(inputs(state, from).every(r => r.sessionId === A));
    const longPaste = '한글🙂'.repeat(900);
    const longFrom = state.requests.length;
    await page.locator('.xterm-helper-textarea').evaluate((textarea, text) => {
      const data = new DataTransfer(); data.setData('text/plain', text);
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, longPaste);
    await until(() => inputs(state, longFrom).map(r => r.data).join('') === longPaste, 'Chunked multibyte paste lost or corrupted a character');
    assert.ok(inputs(state, longFrom).length > 1 && inputs(state, longFrom).every(r => Buffer.byteLength(r.data) <= 4096), 'Long Korean/emoji paste must respect the wire byte limit');
    const compositionEvents = await page.evaluate(() => window.__workroom.composition);
    assert.ok(compositionEvents.some(e => e.type === 'compositionstart') && compositionEvents.some(e => e.type === 'compositionend'), 'CDP must exercise the actual browser composition lifecycle');
    return { commitToWireMs: Math.round(commitToWireMs), compositionEvents: compositionEvents.length };
  });

  await run('output-backlog-drain', async ({ page, state }) => {
    const totalChunks = 64;
    const marker = 'OUTPUT_BACKLOG_COMPLETE';
    state.chunks.set(A, Array.from({ length: totalChunks }, (_, index) => ({ seq: index + 1, text: `${String(index + 1).padStart(3, '0')} ${'한글 output '.repeat(70)}\r\n${index === totalChunks - 1 ? marker : ''}` })));
    assert.ok(state.chunks.get(A).every(c => c.text.length <= 1024));
    const from = state.requests.length;
    await until(() => state.requests.slice(from).some(r => r.operation === 'read' && r.after === 0), 'No read picked up the queued output');
    const started = state.requests.slice(from).find(r => r.operation === 'read' && r.after === 0).at;
    await until(() => page.evaluate(text => window.__workroom.writes.some(w => w.text.includes(text) && w.appliedAt !== undefined), marker), 'Backlog did not reach and finish writing to real xterm', 8000);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 2000, `64-chunk backlog required ${Math.round(elapsedMs)}ms; hasMore output must drain without a 300ms pause after every four chunks`);
    const written = await page.evaluate(() => window.__workroom.writes.map(w => w.text).join(''));
    assert.equal(written, state.chunks.get(A).map(c => c.text).join(''), 'Backlog output was reordered or duplicated');
    return { chunks: totalChunks, bytes: Buffer.byteLength(written), elapsedMs: Math.round(elapsedMs) };
  });

  await run('ended-session-lifecycle', async ({ page, state }) => {
    state.chunks.set(A, [{seq: 1, text: 'ENDED_ALPHA_RECORD\r\n'}]);
    const tabs = page.getByRole('tablist', { name: '터미널 세션' });
    await page.getByRole('button', { name: '세션 종료', exact: true }).click();
    await until(async () => (await tabs.getByRole('tab').count()) === 1, 'Closing a terminal must hide its ended tab from the default list');
    await until(async () => await tabs.getByRole('tab', { selected: true }).getAttribute('aria-selected') === 'true', 'The other running session must become selected');
    assert.match(await tabs.getByRole('tab', { selected: true }).innerText(), /입력 검증 B/);
    await focusTerminal(page);
    const afterClose = state.requests.length;
    await page.keyboard.insertText('자동 선택 입력 한글');
    await until(() => inputs(state, afterClose).some(r => r.sessionId === B && r.data === '자동 선택 입력 한글'), 'Closing Alpha disabled stdin on the automatically selected running Bravo session');
    assert.ok(inputs(state, afterClose).every(r => r.sessionId === B), 'Auto-selected session input was sent to the closed session');
    state.sessions.find(s => s.id === B).state = 'exited';
    state.sessions.find(s => s.id === B).exitCode = 0;
    await until(async () => (await tabs.getByRole('tab').count()) === 2, 'A naturally exited selected session must retain its final screen');
    assert.match(await tabs.getByRole('tab', { selected: true }).innerText(), /입력 검증 B/);
    await page.getByText(/터미널이 종료되었습니다 \(종료 코드 0\)/).waitFor();
    await until(async () => (await tabs.getByRole('tab').count()) === 2, 'Ended session records must remain available in the history view');
    await tabs.getByRole('tab').filter({ hasText: '입력 검증 A' }).click();
    await until(async () => /입력 검증 A/.test(await tabs.getByRole('tab', { selected: true }).innerText()), 'The ended record was not opened');
    await until(() => page.evaluate(() => window.__workroom.writes.some(w => w.text.includes('ENDED_ALPHA_RECORD') && w.appliedAt !== undefined)), 'An ended session record was not written into xterm');
    await wait(100);
    const from = state.requests.length;
    await focusTerminal(page);
    await page.keyboard.type('must-not-send');
    await page.setViewportSize({ width: 870, height: 950 });
    await wait(450);
    assert.deepEqual(state.requests.slice(from).filter(r => ['input', 'resize', 'close'].includes(r.operation)), [], 'Ended terminals must be read-only, including resize');
    for (const key of ['Esc', 'Tab', 'Ctrl+C', 'Ctrl+L', 'Enter']) assert.ok(await page.getByRole('button', { name: key, exact: true }).isDisabled(), `Ended terminal key ${key} must be disabled`);
    assert.ok(await page.getByRole('button', { name: '세션 종료', exact: true }).isDisabled());
  });

  await run('last-session-close-late-resize-error', async ({page, state}) => {
    state.sessions.splice(1);
    await page.getByRole('button', {name: '터미널 새로고침'}).click();
    const tabs = page.getByRole('tablist', {name: '터미널 세션'});
    await until(async () => await tabs.getByRole('tab').count() === 1, 'The last-session race requires exactly one running session');
    await wait(80);
    let releaseResize;
    let releaseList;
    let releaseClose;
    let resizeHeld = false;
    let closeSeen = false;
    let listHeld = false;
    let lateResizeRejected = false;
    const listGate = new Promise(resolve => { releaseList = resolve; });
    const closeGate = new Promise(resolve => { releaseClose = resolve; });
    const beforeClose = {...state.sessions[0]};
    // Only the close reply can disclose exit until the delayed inventory is released.
    state.beforeRead = async body => ({session: beforeClose, chunks: [], nextCursor: body.after, truncated: false, hasMore: false});
    state.beforeOperation = async body => {
      if (body.operation === 'resize' && !resizeHeld) {
        resizeHeld = true;
        await new Promise(resolve => { releaseResize = resolve; });
        lateResizeRejected = true;
        return {status: 409, body: {error: '종료된 터미널입니다. 새 세션을 여세요.'}};
      }
      if (body.operation === 'close') {
        closeSeen = true;
        // Explicitly hold the response whose pending UI we assert. A fast
        // successful close legitimately removes the final session controls.
        await closeGate;
      }
      if (body.operation === 'list' && closeSeen) {
        listHeld = true;
        await listGate;
      }
    };
    try {
      await page.setViewportSize({width: 950, height: 990});
      await until(() => resizeHeld, 'An already transmitted resize must be pending before close');
      await page.getByRole('button', {name: '세션 종료', exact: true}).click();
      await until(() => closeSeen, 'Close must reach the server while resize remains pending');
      assert.ok(await page.getByRole('button', {name: '세션 종료', exact: true}).isDisabled(), 'Close must pause the selected terminal while its response is pending');
      // ResizeObserver runs again while the previously sent resize remains held.
      await page.setViewportSize({width: 900, height: 960});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      releaseResize();
      await until(() => lateResizeRejected, 'The old resize must reject while close is pending');
      releaseClose();
      await until(() => listHeld, 'The successful close must be followed by the intentionally delayed list');
      assert.ok(closeSeen && lateResizeRejected, 'Both the real close and the late resize rejection must have occurred');
      await until(async () => await tabs.getByRole('tab').count() === 0, 'The close response must remove the final active tab before the delayed list completes', 500);
      assert.equal(await page.getByRole('alert').count(), 0, 'A successful last-session close must clear the late rejected resize error immediately');
      assert.match(await page.locator('.ai-terminal-session-list h3').innerText(), /작업 세션\s*0/);
      const from = state.requests.length;
      await page.setViewportSize({width: 840, height: 920});
      await wait(150);
      assert.deepEqual(state.requests.slice(from).filter(r => ['resize', 'input'].includes(r.operation)), [], 'No write may be sent after the authoritative exited close response');
      assert.equal(await page.getByRole('alert').count(), 0, 'The late error must not return while inventory refresh remains pending');
      state.beforeRead = null;
      releaseList();
      await until(async () => !(await page.getByRole('button', {name: '새 터미널', exact: true}).isDisabled()), 'Close must finish after the delayed list resolves');
      assert.equal(await tabs.getByRole('tab').count(), 0);
      assert.equal(await page.getByRole('alert').count(), 0);
      await page.getByRole('button', {name: /종료된 세션 보기/}).click();
      assert.match(await tabs.getByRole('tab').innerText(), /종료 143/, 'The final closed session record must remain available');
      return {lateResizeRejected, activeAfterClose: 0};
    } finally {
      state.beforeOperation = null;
      state.beforeRead = null;
      releaseResize?.();
      releaseClose();
      releaseList();
    }
  });

  await run('close-bypasses-held-input', async ({page, state}) => {
    let releaseInput;
    let inputHeld=false,closeSeen=false;
    const tabs=page.getByRole('tablist',{name:'터미널 세션'});
    await until(async()=>await tabs.getByRole('tab').count()===2,'Both sessions must be available');
    state.beforeOperation=async body=>{
      if(body.operation==='input'&&body.sessionId===A&&!inputHeld){
        inputHeld=true;await new Promise(resolve=>{releaseInput=resolve;});
        return {status:409,body:{error:'종료된 터미널입니다. 새 세션을 여세요.'}};
      }
      if(body.operation==='close'&&body.sessionId===A)closeSeen=true;
    };
    try {
      await focusTerminal(page);await page.keyboard.insertText('ALREADY_SENT');
      await until(()=>inputHeld,'The first input must be awaiting its API response');
      await page.keyboard.insertText('MUST_NOT_SEND_AFTER_CLOSE');await wait(30);
      const closeAt=performance.now();
      await page.getByRole('button',{name:'세션 종료',exact:true}).click();
      await until(()=>closeSeen,'The actual close API must bypass a held input response',600);
      const closeDispatchMs=Math.round(performance.now()-closeAt);
      await until(async()=>/입력 검증 B/.test(await tabs.getByRole('tab',{selected:true}).innerText()),'Close must select the other running session before the old input finishes');
      await focusTerminal(page);await page.keyboard.insertText('다음 세션 입력');
      await until(()=>inputs(state).some(r=>r.sessionId===B&&r.data==='다음 세션 입력'),'The new session must remain writable while the old input is held');
      assert.equal(inputs(state).filter(r=>r.sessionId===A).map(r=>r.data).join(''),'ALREADY_SENT','Queued text must be discarded before transport when close is requested');
      assert.equal(state.requests.filter(r=>r.operation==='close'&&r.sessionId===A).length,1,'The UI must send one close and preserve backend session-memory semantics');
      releaseInput();await wait(100);
      assert.equal(await page.getByRole('alert').count(),0,'A late input rejection for the closed session must not poison the new session');
      assert.equal(inputs(state).filter(r=>r.sessionId===A).length,1);
      return {closeDispatchMs,queuedInputsDiscarded:true,nextSessionWritable:true};
    } finally {releaseInput?.();state.beforeOperation=null;}
  });

  await run('stale-read-cannot-revive-ended-session', async ({page, state}) => {
    const tabs = page.getByRole('tablist', {name: '터미널 세션'});
    state.chunks.set(A, [{seq: 1, text: 'ALPHA_BEFORE_EXIT\r\n'}]);
    state.sessions.find(s => s.id === B).state = 'exited';
    state.sessions.find(s => s.id === B).exitCode = 0;
    await page.getByRole('button', {name: '터미널 새로고침'}).click();
    await page.getByRole('button', {name: /종료된 세션 보기/}).click();
    await until(() => page.evaluate(() => window.__workroom.writes.some(w => w.text.includes('ALPHA_BEFORE_EXIT'))), 'Running Alpha output must be visible before the race');
    let releaseStaleRead;
    let releaseLaterReads;
    let held = false;
    const laterReads = new Promise(resolve => { releaseLaterReads = resolve; });
    state.beforeRead = async body => {
      if (body.sessionId !== A) return;
      if (held) { await laterReads; return; }
      held = true;
      const staleRunning = {...state.sessions.find(s => s.id === A)};
      assert.equal(staleRunning.state, 'running', 'The held response must precede the exit');
      await new Promise(resolve => { releaseStaleRead = resolve; });
      return {session: staleRunning, chunks: [{seq: 2, text: 'STALE_RUNNING_READ_DELIVERED\r\n'}], nextCursor: 2, truncated: false, hasMore: false};
    };
    try {
      await until(() => held, 'The pre-exit running read must be in flight');
      state.sessions.find(s => s.id === A).state = 'exited';
      state.sessions.find(s => s.id === A).exitCode = 0;
      await page.getByRole('button', {name: '터미널 새로고침'}).click();
      await until(async () => await page.getByRole('button', {name: 'Enter', exact: true}).isDisabled(), 'The newer exited list response must disable input before the stale read is released');
      assert.match(await tabs.getByRole('tab', {selected: true}).innerText(), /입력 검증 A.*종료/s);
      const from = state.requests.length;
      releaseStaleRead();
      await until(() => page.evaluate(() => window.__workroom.writes.some(w => w.text.includes('STALE_RUNNING_READ_DELIVERED') && w.appliedAt !== undefined)), 'The stale response output must be consumed, so the state guard is actually exercised');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.match(await tabs.getByRole('tab', {selected: true}).innerText(), /입력 검증 A.*종료/s, 'An old running read must not revive an already ended history record');
      assert.ok(await page.evaluate(() => window.__workroom.instances.at(-1).options.disableStdin), 'The old response must not re-enable xterm stdin');
      await focusTerminal(page);
      await page.keyboard.insertText('종료 세션에는 보내지 않음');
      await page.setViewportSize({width: 850, height: 950});
      await wait(180);
      assert.deepEqual(state.requests.slice(from).filter(r => ['input', 'resize', 'close'].includes(r.operation)), [], 'Stale running metadata must not restore any write operation');
      for (const key of ['Enter', 'Ctrl+C', '세션 종료']) assert.ok(await page.getByRole('button', {name: key, exact: true}).isDisabled(), `The stale read re-enabled ${key}`);
      assert.match(await tabs.getByRole('tab', {selected: true}).innerText(), /입력 검증 A.*종료/s);
    } finally {
      state.beforeRead = null;
      releaseStaleRead?.();
      releaseLaterReads();
    }
  });

  await run('unselected-session-exit', async ({page, state}) => {
    const tabs = page.getByRole('tablist', {name: '터미널 세션'});
    await until(async () => await tabs.getByRole('tab').count() === 2, 'Both fixture sessions must be listed before the background exit');
    const endedAt = performance.now();
    state.sessions.find(s => s.id === B).state = 'exited';
    state.sessions.find(s => s.id === B).exitCode = 0;
    await until(async () => await tabs.getByRole('tab').count() === 1, 'An unselected exited session must leave the active list within three seconds', 3000);
    assert.match(await tabs.getByRole('tab', {selected: true}).innerText(), /입력 검증 A/, 'Background session exit must preserve the selected running terminal');
    return {detectionMs: Math.round(performance.now() - endedAt)};
  });

  await run('session-switch-isolation', async ({ page, state }) => {
    state.chunks.set(A, [{ seq: 1, text: 'ALPHA_BEFORE_SWITCH\r\n' }]);
    state.chunks.set(B, [{ seq: 1, text: 'BRAVO_AFTER_SWITCH\r\n' }]);
    await until(() => page.evaluate(() => window.__workroom.writes.some(w => w.text.includes('ALPHA_BEFORE_SWITCH'))), 'Alpha fixture output did not render');
    let releaseRead;
    let readHeld = false;
    state.beforeRead = async body => {
      if (body.sessionId === A && body.after === 1 && !readHeld) {
        readHeld = true;
        await new Promise(resolve => { releaseRead = resolve; });
      }
    };
    await until(() => readHeld, 'The old session read was not held for the race test');
    state.chunks.set(A, [...state.chunks.get(A), { seq: 2, text: 'LATE_ALPHA_MUST_NOT_RENDER\r\n' }]);
    await focusTerminal(page);
    const from = state.requests.length;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.insertText', { text: 'old-session-input' });
    await page.getByRole('tab').filter({ hasText: '입력 검증 B' }).click();
    releaseRead();
    state.beforeRead = null;
    await until(() => page.evaluate(() => window.__workroom.writes.some(w => w.text.includes('BRAVO_AFTER_SWITCH'))), 'Bravo did not render after switching');
    await focusTerminal(page);
    await cdp.send('Input.insertText', { text: '새 세션🙂' });
    await until(() => inputs(state, from).some(r => r.sessionId === B && r.data.includes('새 세션🙂')), 'The new session input did not reach Bravo');
    await wait(150);
    assert.equal(inputs(state, from).filter(r => r.sessionId === B).map(r => r.data).join(''), '새 세션🙂', 'The old pending input leaked into the new session');
    assert.equal(inputs(state, from).filter(r => r.sessionId === A).map(r => r.data).join(''), 'old-session-input', 'The previous session input was dropped or changed ownership during switch');
    const writes = await page.evaluate(() => window.__workroom.writes);
    assert.ok(!writes.some(w => w.text.includes('LATE_ALPHA_MUST_NOT_RENDER')), 'An old in-flight read wrote to the newly selected terminal');
    const finalBuffer = await page.evaluate(() => {
      const term = window.__workroom.instances.at(-1);
      return Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true)).join('\n');
    });
    assert.ok(finalBuffer.includes('BRAVO_AFTER_SWITCH') && !finalBuffer.includes('ALPHA_'), 'The selected terminal retained another session’s output');
  });
  await run('delayed-session-initial-fit', async ({page, state}) => {
    await until(async () => {
      const actual = await page.evaluate(() => { const t = window.__workroom.instances.at(-1); return {cols: t.cols, rows: t.rows}; });
      return state.requests.some(r => r.operation === 'resize' && r.sessionId === A && r.cols === actual.cols && r.rows === actual.rows);
    }, 'A session selected before its delayed list response must still receive the actual initial xterm dimensions');
    const resize = state.requests.find(r => r.operation === 'resize' && r.sessionId === A);
    assert.ok(resize && (resize.cols !== 100 || resize.rows !== 28), 'The test viewport must differ from the default PTY dimensions');
    return {cols: resize.cols, rows: resize.rows};
  }, {initialListDelayMs: 350});
} finally {
  await browser.close();
  await writeFile(new URL(`workroom-input-lifecycle-results${resultSuffix}.json`, output), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + '\n');
}
console.log(`${results.filter(r => r.status === 'passed').length}/${results.length} workroom regressions passed`);
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
