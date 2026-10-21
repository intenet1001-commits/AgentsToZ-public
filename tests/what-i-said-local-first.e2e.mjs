/** Local-first library loading (this Mac first, shared remote second).
 * Real React selection-harness preamble. Run Vite on 127.0.0.1:9000, then run this file with Node.
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
const item = (id, text, storage) => ({id, seq: '5', recordedAt: '2026-09-06T00:00:00Z', agent: 'codex', text, storage});
async function scenario(name, remoteBehavior) {
  const context = await browser.newContext({viewport: {width: 1000, height: 1050}, serviceWorkers: 'block'});
  const lists = []; const errors = [];
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname === '/__what-i-said-selection') return route.fulfill({contentType: 'text/html', body: html});
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace('/api/what-i-said/', '');
    const body = request.postDataJSON();
    const respond = (json, status = 200) => route.fulfill({json, status});
    if (path === 'global-status') return respond({configured: true, enabled: true, retentionDays: 90, analysisAllowed: false, updatedAt: '2026-09-06T00:00:00Z'});
    if (path === 'remote/status') return respond({enabled: true, credentialsReady: true, exclusionsReady: true, sharedPolicyReady: true, projects: memories, cloudProjects: [], deviceId: 'd', deviceName: 'Fixture Mac', storedRows: 1, remoteError: null});
    if (path === 'remote-key/status') return respond({keys: [], endpoint: null, error: null});
    if (path === 'status') return respond({status: {enabled: true, enabledAt: '2026-09-01T00:00:00Z', retentionDays: 90, analysisAllowed: false, cryptoState: 'ready', storedCount: 1, lastCaptureAt: '2026-09-06T00:00:00Z'}});
    if (path === 'list') {
      lists.push(body.source);
      if (body.source === 'local') return respond({items: [item('l1', '이 맥의 로컬 프롬프트', 'local')], hasMore: true, nextBeforeSeq: '4', source: 'local', localFirst: true, remoteDegraded: false, capture: {lastCaptureAt: '2026-09-06T00:00:00Z'}});
      await sleep(800);
      if (remoteBehavior === 'fail') return respond({success: false, code: 'WHAT_I_SAID_REMOTE_DEGRADED', error: 'x'}, 503);
      return respond({items: [item('r1', '공유된 원격 프롬프트', 'supabase')], hasMore: false, nextBeforeSeq: null, source: 'supabase', capture: {lastCaptureAt: '2026-09-06T00:00:00Z'}});
    }
    return respond({}, 200);
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/__what-i-said-selection`);
  await page.getByText('이 맥의 로컬 프롬프트').waitFor({timeout: 10000});
  const refreshingVisible = await page.getByTestId('what-i-said-remote-refreshing').isVisible();
  // 로컬 페이지에 다음 페이지가 있어도, 원격 새로고침 중에는 「더 불러오기」를 주지 않는다.
  // 누르면 요청 번호가 바뀌어 원격 새로고침이 버려지고 다른 기기 기록이 안내 없이 빠진다.
  const loadMoreDuringRefresh = await page.getByRole('button', {name: '더 불러오기'}).count();
  await page.screenshot({path: new URL(`${name}-local.png`, output).pathname});
  if (remoteBehavior === 'ok') {
    await page.getByText('공유된 원격 프롬프트').waitFor({timeout: 5000});
    assert.equal(await page.getByText('이 맥의 로컬 프롬프트').count(), 0);
  } else {
    await page.getByTestId('what-i-said-remote-notice').waitFor({timeout: 5000});
    assert.equal(await page.getByText('이 맥의 로컬 프롬프트').count(), 1);
    // 원격이 실패해 로컬이 최종 목록이 되면 로컬 커서로 이어 읽을 수 있어야 한다.
    await page.getByRole('button', {name: '더 불러오기'}).waitFor({timeout: 5000});
  }
  await sleep(1500);
  await page.screenshot({path: new URL(`${name}-final.png`, output).pathname});
  console.log(name, JSON.stringify({refreshingVisible, loadMoreDuringRefresh, lists, errors}));
  assert.equal(refreshingVisible, true);
  assert.equal(loadMoreDuringRefresh, 0, 'Load more must be hidden while the remote refresh is pending');
  assert.deepEqual(lists, ['local', 'remote'], 'exactly one local and one remote read, no reload loop');
  assert.deepEqual(errors, []);
  await context.close();
}
try {
  await scenario('ok', 'ok');
  await scenario('fail', 'fail');
  console.log('PASS');
} finally { await browser.close(); }
