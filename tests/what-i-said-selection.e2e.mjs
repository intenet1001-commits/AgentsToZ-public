/** Real React selection tests. Run Vite on 127.0.0.1:9000, then run this file with Node.
 * Every API response is an in-memory fixture. No real capture, sync, or settings
 * operation is performed. Chromium layout is not proof of a native WebKit screen.
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const origin = process.env.WHAT_I_SAID_TEST_ORIGIN || 'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname, '127.0.0.1');
const output = new URL('../output/playwright/', import.meta.url);
await mkdir(output, {recursive: true});
const source = await fetch(`${origin}/src/WhatISaidPanel.tsx`).then(r => {
  assert.equal(r.status, 200, 'Start Vite before running the isolated fixture');
  return r.text();
});
const react = source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
assert.ok(react, 'The real React dependency must be supplied by Vite');
const mainSource = await fetch(`${origin}/src/main.tsx`).then(r => r.text());
const reactDom = mainSource.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(reactDom, 'ReactDOM must use its own Vite dependency version');
const projects = ['A', 'B', 'C'].map(letter => ({id: `fixture-project-${letter.toLowerCase()}`, name: `기억 ${letter}`, folderPath: `/fixture-only/what-i-said/${letter}`}));
const memories = projects.map((project, i) => ({memoryId: `memory-${'abc'[i]}`, name: project.name, folderPath: project.folderPath, excluded: false, captureConfigured: true, captureEnabled: true}));
const html = `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
import React from ${JSON.stringify(react)};
import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';
import {applyZoomToDocument} from '/src/uiZoom.ts';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';
localStorage.setItem('portmanager-ui-zoom','1.25');applyZoomToDocument(document,1.25);
const {WhatISaidPanel}=await import('/src/WhatISaidPanel.tsx');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(WhatISaidPanel,{projects:${JSON.stringify(projects)},language:'ko',visible:true}));
</script>`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(10); }
  assert.fail(message);
}
const browser = await chromium.launch({headless: true});
const results = [];
const readOnlyRoutes = new Set(['global-status', 'status', 'remote/status', 'remote-key/status', 'list']);
async function fixture() {
  const context = await browser.newContext({viewport: {width: 1000, height: 1050}, serviceWorkers: 'block'});
  const state = {requests: [], unexpected: [], errors: [], statusHook: null};
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) { state.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort('blockedbyclient'); }
    if (url.pathname === '/__what-i-said-selection') return route.fulfill({contentType: 'text/html', body: html});
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace('/api/what-i-said/', '');
    const body = request.postDataJSON();
    state.requests.push({path, body, method: request.method()});
    const respond = (json, status = 200) => route.fulfill({json, status});
    if (path === 'global-status') return respond({configured: true, enabled: true, retentionDays: 90, analysisAllowed: false, updatedAt: '2026-09-06T00:00:00Z'});
    if (path === 'remote/status') return respond({enabled: true, credentialsReady: true, exclusionsReady: true, sharedPolicyReady: true, projects: memories, cloudProjects: [{memoryId: 'cloud-only', name: '다른 단말 기억'}], deviceId: 'fixture-device', deviceName: 'Fixture Mac', storedRows: 66, remoteError: null});
    if (path === 'remote-key/status') return respond({keys: [], endpoint: null, error: null});
    if (path === 'status') {
      if (state.statusHook) { const override = await state.statusHook(body); if (override) return respond(override.body, override.status); }
      const index = memories.findIndex(m => m.memoryId === body.memoryId || m.folderPath === body.folderPath);
      assert.ok(index >= 0, 'Only invented fixture memories may be queried');
      return respond({enabled: true, cryptoState: 'ready', retentionDays: 90, analysisAllowed: false, count: (index + 1) * 11, lastCaptureAt: `2026-09-0${index + 1}T00:00:00Z`, scan: {complete: true, unreadable: 0, withheld: 0}});
    }
    if (path === 'list') return respond({items: [], hasMore: false, nextBeforeSeq: null, capture: {lastCaptureAt: '2026-09-06T00:00:00Z'}});
    if (path === 'sync') return respond({requested: body.memoryIds.length, succeeded: body.memoryIds.length, captured: 4, pushed: 4});
    state.unexpected.push(`${request.method()} ${url.pathname}`);
    return respond({error: 'Unmocked API request; real user data is never accessed'}, 503);
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('requestfailed', request => {if (!new URL(request.url()).pathname.startsWith('/api/')) state.errors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`);});
  await page.goto(`${origin}/__what-i-said-selection`);
  const bulk = page.getByTestId('what-i-said-memory-bulk-card');
  const status = page.getByTestId('what-i-said-project-status-card');
  await bulk.waitFor({timeout: 10000}).catch(error => {throw new Error(error.message + '\nBrowser errors: ' + JSON.stringify(state.errors) + '\nBlocked: ' + JSON.stringify(state.unexpected));});
  await until(async () => await bulk.getByRole('checkbox').count() === 3 && await status.getByRole('combobox').inputValue() === 'memory-a', 'The independent fixture selectors must finish loading');
  await until(async () => await status.locator('dd').filter({hasText: /^11$/}).count() === 1, 'The first memory status must finish loading');
  return {context, page, state, bulk, status};
}
function syncCalls(state) { return state.requests.filter(r => r.path === 'sync'); }
function mutations(state) { return state.requests.filter(r => !readOnlyRoutes.has(r.path)); }
async function checkedNames(bulk) {
  return bulk.getByRole('checkbox').evaluateAll(inputs => inputs.filter(input => input.checked).map(input => input.closest('label').textContent.trim()));
}
async function chooseAC(bulk) { await bulk.getByRole('checkbox', {name: '기억 B', exact: true}).uncheck(); }
async function run(name, execute) {
  let f;
  try {
    f = await fixture();
    const details = await execute(f);
    assert.deepEqual(f.state.unexpected, [], 'Every API must remain isolated from the actual app');
    assert.deepEqual(f.state.errors, [], 'The real component must not throw');
    results.push({name, status: 'passed', ...details});
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({name, status: 'failed', error: error.message});
    console.error(`FAIL ${name}: ${error.message}`);
    await f?.page.screenshot({path: new URL(`what-i-said-${name}.png`, output).pathname, fullPage: true}).catch(() => {});
  } finally { await f?.context.close(); }
}

try {
  await run('cloud-library-filter-does-not-become-local-capture', async ({page, bulk, status, state}) => {
    const filter = page.getByRole('combobox', {name: '장기기억 필터', exact: true});
    await filter.selectOption('cloud-only');
    await until(() => state.requests.some(r => r.path === 'list' && r.body.memoryIds?.[0] === 'cloud-only'), 'Cloud-only scope must reach the read API');
    assert.equal(await bulk.getByRole('checkbox', {name: '다른 단말 기억', exact: true}).count(), 0);
    assert.equal(await status.getByRole('combobox').locator('option[value="cloud-only"]').count(), 0);
    assert.deepEqual(mutations(state), []);
  });
  await run('independent-selection-and-exact-sync-targets', async ({bulk, status, state}) => {
    assert.deepEqual(await checkedNames(bulk), ['기억 A', '기억 B', '기억 C'], 'The existing all-memory initial selection must be retained');
    assert.deepEqual(mutations(state), [], 'Opening the panel must never collect or alter policy');
    await chooseAC(bulk);
    await status.getByRole('combobox').selectOption('memory-b');
    await until(async () => await status.locator('dd').filter({hasText: /^22$/}).count() === 1, 'Only memory B status must be displayed');
    assert.deepEqual(await checkedNames(bulk), ['기억 A', '기억 C']);
    assert.deepEqual(state.requests.filter(r => r.path === 'status').at(-1).body, {memoryId: 'memory-b'});
    const statusReads = state.requests.filter(r => r.path === 'status').length;
    await bulk.getByRole('checkbox', {name: '기억 C', exact: true}).uncheck();
    await sleep(80);
    assert.equal(await status.getByRole('combobox').inputValue(), 'memory-b');
    assert.equal(state.requests.filter(r => r.path === 'status').length, statusReads, 'Checkbox changes must not select a different status memory');
    await bulk.getByRole('checkbox', {name: '기억 C', exact: true}).check();
    assert.deepEqual(mutations(state), [], 'Selector changes must not collect, sync, or modify automatic policy');
    await bulk.getByRole('button', {name: '선택한 2개 기억 수집·동기화', exact: true}).click();
    await until(() => syncCalls(state).length === 1, 'An explicit bulk action must issue exactly one fixture sync');
    assert.deepEqual(syncCalls(state)[0], {path: 'sync', method: 'POST', body: {memoryIds: ['memory-a', 'memory-c'], backfill: false}});
    await until(async () => !(await bulk.getByRole('checkbox').first().isDisabled()), 'The fixture sync must settle');
    assert.deepEqual(await checkedNames(bulk), ['기억 A', '기억 C'], 'Refreshing remote metadata after sync must preserve the chosen subset');
    assert.equal(await status.getByRole('combobox').inputValue(), 'memory-b');
    assert.ok(mutations(state).every(r => r.path === 'sync'));
  });

  await run('empty-selection-does-not-disable-status', async ({bulk, status, state}) => {
    await bulk.getByRole('button', {name: '선택 해제', exact: true}).click();
    assert.deepEqual(await checkedNames(bulk), []);
    assert.ok(await bulk.getByRole('button', {name: '선택한 0개 기억 수집·동기화', exact: true}).isDisabled());
    assert.ok(await bulk.getByTestId('what-i-said-backfill').isDisabled());
    await status.getByRole('combobox').selectOption('memory-c');
    await until(async () => await status.locator('dd').filter({hasText: /^33$/}).count() === 1, 'Single-memory status must remain usable with no bulk targets');
    await bulk.getByRole('button', {name: '전체 선택', exact: true}).click();
    assert.deepEqual(await checkedNames(bulk), ['기억 A', '기억 B', '기억 C']);
    assert.equal(await status.getByRole('combobox').inputValue(), 'memory-c');
    assert.deepEqual(mutations(state), []);
  });

  await run('status-loading-does-not-hide-bulk-action', async ({bulk, status, state}) => {
    await chooseAC(bulk);
    let releaseStatus; let held = false;
    const gate = new Promise(resolve => { releaseStatus = resolve; });
    state.statusHook = async body => { if (body.memoryId === 'memory-b') {held = true; await gate;} };
    try {
      await status.getByRole('combobox').selectOption('memory-b');
      await until(() => held, 'The single-memory status request must actually be pending');
      const button = bulk.getByRole('button', {name: '선택한 2개 기억 수집·동기화', exact: true});
      assert.ok(await button.isVisible() && await button.isEnabled());
      await button.click();
      await until(() => syncCalls(state).length === 1, 'Bulk collection must be available while the unrelated status read is pending');
      assert.deepEqual(syncCalls(state)[0].body, {memoryIds: ['memory-a', 'memory-c'], backfill: false});
    } finally {state.statusHook = null; releaseStatus();}
  });

  await run('status-failure-does-not-hide-bulk-action', async ({bulk, status, state}) => {
    await chooseAC(bulk);
    state.statusHook = async body => body.memoryId === 'memory-b' ? {status: 503, body: {error: 'Fixture single-memory status unavailable'}} : undefined;
    await status.getByRole('combobox').selectOption('memory-b');
    await status.getByRole('alert').waitFor();
    const button = bulk.getByRole('button', {name: '선택한 2개 기억 수집·동기화', exact: true});
    assert.ok(await button.isVisible() && await button.isEnabled());
    await button.click();
    await until(() => syncCalls(state).length === 1, 'A failed single status must not block the explicit batch action');
    assert.deepEqual(syncCalls(state)[0].body, {memoryIds: ['memory-a', 'memory-c'], backfill: false});
    assert.ok(mutations(state).every(r => r.path === 'sync'));
  });

  await run('backfill-confirmation-uses-the-bulk-count', async ({page, bulk, status, state}) => {
    await chooseAC(bulk);
    await status.getByRole('combobox').selectOption('memory-b');
    const confirmations = [];
    page.once('dialog', async dialog => {confirmations.push(dialog.message()); await dialog.dismiss();});
    await bulk.getByTestId('what-i-said-backfill').click();
    assert.equal(syncCalls(state).length, 0, 'Cancelled backfill must not issue any capture/sync request');
    assert.match(confirmations[0], /2개/, 'Backfill must name the number of checked memories, not the status dropdown');
    page.once('dialog', async dialog => {confirmations.push(dialog.message()); await dialog.accept();});
    await bulk.getByTestId('what-i-said-backfill').click();
    await until(() => syncCalls(state).length === 1, 'Confirmed backfill must issue exactly one request');
    assert.deepEqual(syncCalls(state)[0].body, {memoryIds: ['memory-a', 'memory-c'], backfill: true});
    assert.equal(confirmations.length, 2);
    assert.ok(mutations(state).every(r => r.path === 'sync'));
  });

  await run('separate-cards-at-saved-125-percent', async ({page, bulk, status, state}) => {
    assert.equal(await page.evaluate(() => localStorage.getItem('portmanager-ui-zoom')), '1.25');
    assert.match(await bulk.getByRole('heading', {level: 2}).innerText(), /프롬프트 일괄 수집·동기화/);
    assert.match(await status.getByRole('heading', {level: 2}).innerText(), /장기기억별 프롬프트 상태/);
    assert.equal(await status.getByLabel('상태를 확인할 장기기억').count(), 1);
    assert.equal(await bulk.getByRole('combobox').count(), 0);
    assert.equal(await status.getByRole('checkbox').count(), 0);
    assert.equal(await status.getByTestId('what-i-said-project-actions').count(), 0);
    assert.equal(await bulk.getByRole('button', {name: '이 장기기억의 프롬프트 모두 삭제', exact: true}).count(), 0);
    assert.equal(await status.getByRole('button', {name: '이 장기기억의 프롬프트 모두 삭제', exact: true}).count(), 1);
    assert.ok(await page.evaluate(() => {
      const bulk = document.querySelector('[data-testid="what-i-said-memory-bulk-card"]');
      const status = document.querySelector('[data-testid="what-i-said-project-status-card"]');
      return bulk.parentElement === status.parentElement && !!(bulk.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), 'Bulk and single status must be separate sibling cards in the declared order');
    await bulk.scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      sections: ['what-i-said-memory-bulk-card', 'what-i-said-project-status-card'].map(id => {
        const card = document.querySelector(`[data-testid="${id}"]`);
        const box = card.getBoundingClientRect();
        return {id, left: box.left, right: box.right, overflow: card.scrollWidth - card.clientWidth};
      }),
    }));
    assert.ok(layout.scrollWidth <= layout.width + 2 && layout.sections.every(s => s.left >= -2 && s.right <= layout.width + 2 && s.overflow <= 2), `Saved 125% zoom must not clip either card horizontally: ${JSON.stringify(layout)}`);
    await page.screenshot({path: new URL('what-i-said-separated-selection-125.png', output).pathname, fullPage: true});
    assert.deepEqual(mutations(state), []);
    return {viewport: '1000×1050', zoom: '125%'};
  });
} finally {
  await browser.close();
  await writeFile(new URL('what-i-said-selection-results.json', output), JSON.stringify({generatedAt: new Date().toISOString(), results}, null, 2) + '\n');
}
console.log(`${results.filter(r => r.status === 'passed').length}/${results.length} What I said selection regressions passed`);
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
