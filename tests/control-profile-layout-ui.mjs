/**
 * 아젠투지 설정 layout (docs/design/agentstoz-settings-2026-10-26.md).
 *
 * One isolated, read-only fixture measured in a real browser at 1100×850 and 390×844. The baseline was taken from the
 * previous panel with CONTROL_PROFILE_LAYOUT_MEASURE_ONLY=1 (measurements only); the default run measures the same data
 * and asserts what the redesign promises: the status, the to-do and the main open action come first; a candidate shows
 * its title and a preview, and its full text before it can be saved; details fold by purpose without hiding a count, an
 * error, the sync state, a permission bypass or the local-only state. Escape and focus return stay the dialog's.
 *
 * Runs from tests/user-memory-ui.mjs (maintainer check user-memory-screen) or alone against an owned fixture origin:
 *   node tests/control-profile-layout-ui.mjs http://127.0.0.1:<port>
 * CONTROL_PROFILE_LAYOUT_OUT=<file> writes the measurements as JSON.
 */
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {chromium, webkit} from 'playwright';

const origin = process.argv[2];
if (!origin || new URL(origin).hostname !== '127.0.0.1' || new URL(origin).port === '3001') throw Error('Owned fixture origin required');
const measureOnly = process.env.CONTROL_PROFILE_LAYOUT_MEASURE_ONLY === '1';
const label = measureOnly ? 'before' : 'after';
const panelModule = await fetch(origin + '/src/ControlProfilePanel.tsx').then(r => r.text());
const main = await fetch(origin + '/src/main.tsx').then(r => r.text());
const react = panelModule.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom = main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react && reactDom, 'React dependency URLs from the owned Vite server');

const html = `<!doctype html><meta charset="utf-8"><title>아젠투지 설정 fixture</title><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};import '/src/index.css';
const {ControlProfilePanel}=await import('/src/ControlProfilePanel.tsx');
const restoreFrom=new URLSearchParams(location.search).get('restore');
function App(){const [open,setOpen]=React.useState(false),[events,setEvents]=React.useState([]);const note=name=>()=>setEvents(list=>[...list,name]);
 return React.createElement(React.Fragment,null,
  React.createElement('button',{type:'button',onClick:()=>setOpen(true)},'Open settings'),
  React.createElement('output',{'data-testid':'fixture-events'},events.join(' ')),
  open&&React.createElement(React.StrictMode,null,React.createElement(ControlProfilePanel,{onClose:()=>setOpen(false),onOpenWork:note('work'),
   onOpenProject:id=>note('project:'+id)(),onOpenUserMemory:note('user-memory'),onOpenUserProfile:note('user-profile'),onOpenMemoryStatus:note('memory-status'),
   ...(restoreFrom?{onRestoreOps:note('restore'),restoreFrom}:{})})));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));</script>`;

const PROFILE_ID = '11111111-1111-4111-8111-111111111111', MEMORY_ID = '22222222-2222-4222-8222-222222222222';
const at = minutes => new Date(Date.UTC(2026, 9, 26, 0, minutes)).toISOString();
const LONG_TAIL = '마지막 줄: 전체 내용을 확인한 뒤에만 저장한다.';
// ~1,100 Hangul characters (≈3.3 KB, under the store's 4,000-byte body limit) and a long evidence line.
const LONG_BODY = [...Array.from({length: 18}, (_, i) => `${i + 1}. 프로젝트 별칭이 실제 폴더와 다르면 등록된 프로젝트 ID로 먼저 해석하고 이름만 같은 다른 폴더는 고르지 않는다.`), LONG_TAIL].join('\n');
const LONG_EVIDENCE = Array.from({length: 4}, (_, i) => `근거 ${i + 1}: 2026-10-2${i}에 같은 혼동으로 다른 폴더를 열었던 기록과 사용자 정정 지시.`).join(' ');
const configured = {state: 'configured', profiles: 1, message: '설정 등록됨 · 실제 도구 응답은 해당 AI 대화에서 확인하세요.'};
// control-profile-server.ts: what the status says when the OPS memory pull finds local and remote different.
const SYNC_CONFLICT = '로컬과 원격 운영 기억이 다릅니다. 어느 쪽도 덮어쓰지 않았고 로컬 기억은 유지됩니다. 아젠투지 설정에서 운영 기억을 비교한 뒤 적용할 수 있습니다.';

function scenario(kind) {
  const ready = {state: 'ready', profileId: PROFILE_ID, memoryId: MEMORY_ID, displayName: 'AgentsToZ', aliases: ['agentstoz', '아젠투지', '에이전츠투지'],
    projectId: 'ops-project', revision: 'revision-1', lastSavedAt: at(30), problem: null, pendingCount: 3, backend: 'control-folder',
    coordinationPolicy: 'agentstoz', sync: {state: 'current', lastCheckedAt: at(31), problem: null}};
  const candidate = (id, title, body, evidence, minute) => ({id, requestId: `request-${id}`, title, body, evidence, baseRevision: 'revision-1', state: 'pending', createdAt: at(minute)});
  const s = {
    profile: ready,
    migration: {status: 'skipped', reason: 'folder-in-use', blocking: [{pid: 4242, command: 'codex'}], at: at(5)},
    proposals: [
      candidate('candidate-short', '프로젝트 별칭 규칙', 'song-app은 노래 앱 프로젝트를 가리킨다.', '사용자 요청', 10),
      candidate('candidate-long', '여러 Mac 운영 원칙', LONG_BODY, LONG_EVIDENCE, 11),
      candidate('candidate-medium', '검증 보고 형식', '검증 결과는 실행한 검사 ID와 실패·건너뜀을 구분해 보고한다.\n소스 통과를 설치 앱 실기 성공으로 말하지 않는다.\n이전 통과는 현재 검증이 아니다.', '세션 기록 2026-10-25', 12),
    ],
    controls: [{projectId: 'ops-project', memoryId: MEMORY_ID}],
    connections: [
      {agent: 'codex', ...configured},
      {agent: 'claude', ...configured, upgradable: true, message: '연결돼 있습니다. 앱 업데이트에도 끊기지 않도록 고정 경로로 다시 등록할 수 있습니다.'},
      {agent: 'hermes', state: 'needs-attention', profiles: 1, message: 'AgentsToZ MCP 연결을 준비하세요.'},
      {agent: 'agy', state: 'unavailable', profiles: 0, message: 'CLI와 설치된 AgentsToZ 제어 도구가 필요합니다.'},
    ],
    preference: {agent: 'codex', surface: 'app', mode: 'reopen', bypass: false},
    entries: Array.from({length: 24}, (_, i) => ({entryId: (i + 1).toString(16).padStart(2, '0').repeat(12), section: 'AgentsToZ 운영 결정', title: `운영 결정 ${String(i + 1).padStart(2, '0')}`})),
    entriesFail: false,
    device: {profileId: PROFILE_ID, deviceId: 'device-1', memoryId: MEMORY_ID, name: '시험 Mac', revision: 'device-revision-1', prepared: true, savedAt: at(20),
      entries: Array.from({length: 5}, (_, i) => ({entryId: `device-${i + 1}`, title: `이 Mac 습관 ${i + 1}`, body: `이 Mac에서는 터미널을 iTerm으로 열고 빌드 산출물은 홈 아래 cargo-targets에 둔다. 항목 ${i + 1}.`})),
      total: 5, nextOffset: null, offset: 0},
    tester: {hostName: '시험 Mac', checkedAt: at(40), revision: 'a'.repeat(64), total: 6, complete: true, nextOffset: null,
      entries: Array.from({length: 6}, (_, i) => ({projectId: `project-${i + 1}`, name: `시험 프로젝트 ${i + 1}`, state: i === 5 ? 'not-configured' : 'observed',
        run: i === 5 ? null : {state: i === 2 ? 'failed' : 'passed', profileId: 'quick', createdAt: at(35)}}))},
  };
  const localOnly = {...ready, projectId: null, backend: 'app-data', pendingCount: 0, sync: {state: 'not-configured', lastCheckedAt: null, problem: null}};
  const calm = [{agent: 'codex', ...configured}, {agent: 'claude', ...configured}, {agent: 'hermes', ...configured}, {agent: 'agy', state: 'unavailable', profiles: 0, message: 'CLI와 설치된 AgentsToZ 제어 도구가 필요합니다.'}];
  if (kind === 'local-only') Object.assign(s, {profile: localOnly, proposals: [], migration: null, controls: [], connections: calm, entries: s.entries.slice(0, 2)});
  if (kind === 'attention') Object.assign(s, {profile: {...ready, sync: {state: 'needs-attention', lastCheckedAt: at(31), problem: '다른 Mac의 운영 기억과 맞추지 못했습니다. 연결을 확인하세요.'}},
    entriesFail: true, preference: {agent: 'claude', surface: 'app', mode: 'reopen', bypass: true}});
  if (kind === 'restore') Object.assign(s, {profile: localOnly, proposals: [], migration: null, connections: calm, controls: [{projectId: 'other-ops', memoryId: '33333333-3333-4333-8333-333333333333'}]});
  // Only the OPS memory conflict waits: no candidate, no connection to check, no restore, no other folder.
  if (kind === 'sync-conflict') Object.assign(s, {profile: {...ready, pendingCount: 0, sync: {state: 'needs-attention', lastCheckedAt: at(31), problem: SYNC_CONFLICT}},
    proposals: [], migration: null, connections: calm});
  if (kind === 'many') s.proposals = Array.from({length: 7}, (_, i) => candidate(`candidate-${i + 1}`, `짧은 후보 ${i + 1}`, `짧은 본문 ${i + 1}`, '사용자 요청', 10 + i));
  return s;
}

async function routes(context, s, calls, unexpected) {
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
    if (url.pathname === '/__control-profile-layout') return route.fulfill({contentType: 'text/html', body: html});
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    calls.push({path: url.pathname, search: url.search, method: req.method(), body});
    const json = (value, status = 200) => route.fulfill({status, json: value});
    const prefix = '/api/control-profile/';
    if (!url.pathname.startsWith(prefix)) { unexpected.push(url.pathname); return json({success: false, error: 'Unmocked fixture request rejected'}, 503); }
    switch (url.pathname.slice(prefix.length)) {
      case 'status': return json({success: true, profile: s.profile, ...(s.migration ? {opsFolderMigration: s.migration} : {})});
      case 'pending': return json({success: true, proposals: s.proposals});
      case 'controls': return json({success: true, controls: s.controls});
      case 'connections': return body
        ? json({success: true, connection: {...s.connections.find(c => c.agent === body.agent), ...configured}, changed: true, executionVerified: false})
        : json({success: true, connections: s.connections});
      case 'launch-preference': return body ? json({success: true}) : json({success: true, preference: s.preference});
      case 'entries': {
        if (s.entriesFail) return json({success: false, error: 'fixture entries unavailable'}, 503);
        const entryId = url.searchParams.get('entryId');
        if (entryId) return json({success: true, entry: {entryId, body: `${entryId} 본문`, truncated: false, revision: s.profile.revision}});
        return json({success: true, memory: {ready: true, revision: s.profile.revision, total: s.entries.length, entries: s.entries}});
      }
      case 'device-memory': return json({success: true, memory: s.device, legacyAvailable: false});
      case 'tester-results': return json({success: true, overview: s.tester});
      case 'memory-conflict': return body.operation==='preview'
        ? json({success:true,comparison:{memoryId:MEMORY_ID,conflict:true,localContent:'# Project Core Memory\nLocal decision',remoteContent:'# Project Core Memory\nRemote decision',localContentHash:'a'.repeat(64),remoteContentHash:'b'.repeat(64),remoteRevisionId:'11111111-1111-4111-8111-111111111111'}})
        : json({success:true,resolution:{success:true,strategy:body.strategy}});
      case 'review': {
        s.proposals = s.proposals.filter(p => p.id !== body.id);
        s.profile = {...s.profile, revision: 'revision-2', pendingCount: s.proposals.length};
        return json({success: true, backup: {backedUp: false, reason: 'not-configured'}});
      }
      default: unexpected.push(url.pathname); return json({success: false, error: 'Unmocked fixture request rejected'}, 503);
    }
  });
}

/** Wait until the panel's opening reads have answered and nothing new has been asked for a moment. */
async function settle(page, calls) {
  const need = ['status', 'pending', 'controls', 'connections', 'launch-preference'].map(p => '/api/control-profile/' + p);
  const deadline = Date.now() + 15_000;
  let seen = -1, quietSince = Date.now();
  while (Date.now() < deadline) {
    if (calls.length !== seen) { seen = calls.length; quietSince = Date.now(); }
    const paths = new Set(calls.map(c => c.path));
    if (need.every(p => paths.has(p)) && Date.now() - quietSince > 700) break;
    await page.waitForTimeout(100);
  }
  await page.evaluate(() => document.fonts.ready);
}

/** Runs in the page: what a person sees in the dialog's first screen and how far the rest is. */
function measure() {
  const panel = document.querySelector('[data-testid="control-profile-panel"]');
  panel.scrollTop = 0;
  const box = panel.getBoundingClientRect();
  const shown = el => !!el && el.getClientRects().length > 0;
  const inView = el => { if (!shown(el)) return false; const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1; };
  const offset = el => shown(el) ? Math.round(el.getBoundingClientRect().top - box.top + panel.scrollTop) : null;
  let viewportTextChars = 0;
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.replace(/\s+/g, '');
    if (!text) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    if ([...range.getClientRects()].some(r => r.width > 0 && r.height > 0 && r.bottom > box.top && r.top < box.bottom)) viewportTextChars += text.length;
  }
  const controls = [...panel.querySelectorAll('button,select,input,textarea,summary')].filter(shown);
  const find = (selector, pattern) => [...panel.querySelectorAll(selector)].find(el => shown(el) && pattern.test(el.textContent.trim()));
  const status = panel.querySelector('[role="status"]');
  const pendingHeading = panel.querySelector('[data-testid="control-profile-pending"] h3');
  const openButton = find('button', /^(아젠투지를 .+ 열기|Antigravity 앱 열기.*)$/);
  const mcpHeading = find('h3', /MCP/);
  const longCandidate = [...panel.querySelectorAll('[data-testid="control-profile-pending"] article')].find(el => el.textContent.includes('여러 Mac 운영 원칙'));
  return {
    viewport: {width: innerWidth, height: innerHeight},
    panelClientHeight: panel.clientHeight, panelScrollHeight: panel.scrollHeight,
    renderedTextChars: panel.innerText.replace(/\s+/g, '').length, viewportTextChars,
    renderedControls: controls.length, viewportControls: controls.filter(inView).length,
    offsets: {status: offset(status), pendingHeading: offset(pendingHeading), openButton: offset(openButton), mcpHeading: offset(mcpHeading),
      savedMemory: offset(panel.querySelector('[data-testid="control-profile-saved-memory"]'))},
    firstScreen: {status: inView(status), pendingHeading: inView(pendingHeading), openButton: inView(openButton), mcpHeading: inView(mcpHeading)},
    longCandidateHeight: longCandidate ? Math.round(longCandidate.getBoundingClientRect().height) : null,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 || panel.scrollWidth > panel.clientWidth + 1,
  };
}

async function open(browser, kind, viewport, restore) {
  const s = scenario(kind), calls = [], unexpected = [], errors = [];
  const context = await browser.newContext({viewport, serviceWorkers: 'block'});
  await routes(context, s, calls, unexpected);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/__control-profile-layout' + (restore ? '?restore=' + encodeURIComponent(restore) : ''));
  // Opened from the keyboard, as tests/user-memory-ui.mjs does: WebKit (like macOS Safari) does not focus a clicked
  // button, so a mouse-opened panel there has no opener to give focus back to.
  const opener = page.getByRole('button', {name: 'Open settings', exact: true});
  await opener.focus();
  await opener.press('Enter');
  const panel = page.getByTestId('control-profile-panel');
  await panel.waitFor();
  await settle(page, calls);
  return {s, calls, unexpected, errors, context, page, panel, done: async () => {
    assert.deepEqual(unexpected, [], `${kind}: no request outside the fixture`);
    assert.deepEqual(errors, [], `${kind}: no page error`);
    await context.close();
  }};
}

const startup = calls => [...new Set(calls.filter(c => !c.search).map(c => c.path.replace('/api/control-profile/', '')))].sort();
// The previous panel (HEAD aeef663e) on this same fixture in Chromium, with CONTROL_PROFILE_LAYOUT_MEASURE_ONLY=1:
// 5471 / 6562 px tall and 3549 rendered characters at 1100 / 390 px, eight reads on opening, open button below the fold.
const BASELINE = {1100: {scrollHeight: 5471, renderedTextChars: 3549}, 390: {scrollHeight: 6562, renderedTextChars: 3549}};
/** The design's acceptance targets: at most 60% of the earlier height, at most half its text, six reads on opening. */
function targets(m) {
  const base = BASELINE[m.viewport.width];
  assert.ok(m.panelScrollHeight <= base.scrollHeight * 0.6, `${m.viewport.width}px: height ${m.panelScrollHeight} ≤ 60% of ${base.scrollHeight}`);
  assert.ok(m.renderedTextChars <= base.renderedTextChars * 0.5, `${m.viewport.width}px: rendered text ${m.renderedTextChars} ≤ 50% of ${base.renderedTextChars}`);
  assert.deepEqual(m.startupRequests, ['connections', 'controls', 'entries', 'launch-preference', 'pending', 'status'], 'The device memory and the test overview are read when opened');
}
const focusedId = page => page.evaluate(() => document.activeElement?.id ?? '');
const hiddenById = (page, id) => page.evaluate(target => { const el = document.getElementById(target); return !!el && el.getClientRects().length === 0; }, id);

/** The redesign's promises on the rich fixture at desktop width. */
async function richDesktop({page, panel, calls, engine}, m) {
  const status = panel.getByTestId('control-profile-status');
  await status.getByRole('status').filter({hasText: '운영 기억 연결됨'}).waitFor();
  assert.deepEqual({status: m.firstScreen.status, pending: m.firstScreen.pendingHeading, open: m.firstScreen.openButton},
    {status: true, pending: true, open: true}, 'Status, candidates and the main open action are in the first screen');
  await status.getByTestId('ops-folder-migration-notice').waitFor();
  await status.getByText('다른 Mac의 운영 기억과 동기화됨', {exact: true}).waitFor();
  const todo = panel.getByTestId('control-profile-todo');
  await todo.getByRole('button', {name: '저장 후보 3개 검토', exact: true}).waitFor();
  await todo.getByRole('button', {name: 'AI 연결 확인 필요 · Hermes', exact: true}).waitFor();
  assert.deepEqual(startup(calls).filter(p => p === 'device-memory' || p === 'tester-results'), [], 'Folded details are not read before they are opened');

  // A long candidate: title and preview first, its full text before the save.
  const long = panel.getByTestId('control-profile-candidate').filter({hasText: '여러 Mac 운영 원칙'});
  assert.equal(await long.getByText(LONG_TAIL, {exact: false}).count(), 0, 'The long body starts as a preview');
  const toggle = long.getByTestId('control-profile-candidate-toggle');
  assert.match(await toggle.innerText(), /^전체 보기 · \d+자$/);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(id => !!document.getElementById(id), await toggle.getAttribute('aria-controls')), true);
  const save = long.getByRole('button', {name: '운영 기억에 저장', exact: true});
  assert.equal(await save.isDisabled(), true, 'No save before the full text was shown');
  await long.getByTestId('control-profile-candidate-gate').waitFor();
  assert.equal(await long.getByRole('button', {name: '제외', exact: true}).isDisabled(), false, 'Excluding never needs the full text');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await long.getByText(LONG_TAIL, {exact: false}).waitFor();
  await long.getByText('근거 4:', {exact: false}).waitFor();
  assert.equal(await save.isDisabled(), false);
  await toggle.click();
  assert.equal(await save.isDisabled(), false, 'Once read, folding again keeps the save');
  const short = panel.getByTestId('control-profile-candidate').filter({hasText: '프로젝트 별칭 규칙'});
  await short.getByText('song-app은 노래 앱 프로젝트를 가리킨다.', {exact: true}).waitFor();
  assert.equal(await short.getByTestId('control-profile-candidate-toggle').count(), 0, 'A short candidate is shown whole');
  assert.equal(await short.getByRole('button', {name: '운영 기억에 저장', exact: true}).isDisabled(), false);

  // Every purpose section starts folded, its title is a heading, and its body is really hidden.
  const sections = [['control-profile-launch', '아젠투지 열기 방식'], ['control-profile-saved-memory', '저장된 운영 기억 · 24'],
    ['control-profile-device-memory', '아젠투지별 기억'], ['control-profile-connections', 'AI별 MCP 사용 설정'],
    ['control-profile-tester', '프로젝트 테스트 현황'], ['control-profile-guide', '기억 종류·호출 안내']];
  for (const [testId, title] of sections) {
    const section = panel.getByTestId(testId);
    await section.getByRole('heading', {name: title, exact: true}).waitFor();
    const button = section.getByRole('button', {name: title, exact: true});
    assert.equal(await button.getAttribute('aria-expanded'), 'false', `${testId} starts folded`);
    assert.equal(await hiddenById(page, await button.getAttribute('aria-controls')), true, `${testId} hides its body while folded`);
  }
  // Folded summaries still say what needs a person.
  const summary = await panel.getByTestId('control-profile-connections-summary').innerText();
  for (const part of ['확인 필요: Hermes', '다시 등록 권장: Claude', '연결됨: Codex', '사용 불가: Antigravity']) assert.ok(summary.includes(part), summary);
  assert.match(await panel.getByTestId('control-profile-launch-summary').innerText(), /외부 AI 앱 · Codex · 기존 대화 열기/);
  await panel.getByTestId('control-profile-guide').getByRole('button', {name: '내 지시·결과 기록 보기', exact: true}).waitFor();

  // The to-do opens the section that needs a person and moves focus to it.
  await todo.getByRole('button', {name: 'AI 연결 확인 필요 · Hermes', exact: true}).click();
  const connections = panel.getByTestId('control-profile-connections');
  assert.equal(await connections.getByRole('button', {name: 'AI별 MCP 사용 설정', exact: true}).getAttribute('aria-expanded'), 'true');
  assert.equal(await focusedId(page), 'control-profile-connections-toggle');
  assert.equal(await connections.getByRole('button', {name: '설정 점검·갱신', exact: true}).count(), 4);
  await todo.getByRole('button', {name: '저장 후보 3개 검토', exact: true}).click();
  assert.equal(await focusedId(page), 'control-profile-pending-title');

  // Folded details are read only when opened.
  await panel.getByTestId('control-profile-device-memory').getByRole('button', {name: '아젠투지별 기억', exact: true}).click();
  await panel.getByText('이 Mac 습관 1', {exact: true}).waitFor();
  assert.ok(startup(calls).includes('device-memory'));
  await panel.getByTestId('control-profile-tester').getByRole('button', {name: '프로젝트 테스트 현황', exact: true}).click();
  await panel.getByText('시험 프로젝트 1', {exact: true}).waitFor();
  assert.ok(startup(calls).includes('tester-results'));
  const saved = panel.getByTestId('control-profile-saved-memory');
  await saved.getByRole('button', {name: '저장된 운영 기억 · 24', exact: true}).click();
  await saved.getByRole('button', {name: /^운영 결정 01/}).click();
  await saved.getByText(`${'01'.repeat(12)} 본문`, {exact: true}).waitFor();
  const guide = panel.getByTestId('control-profile-guide');
  assert.equal(await guide.getByTestId('control-profile-memory-map').isVisible(), false);
  await guide.getByRole('button', {name: '기억 종류·호출 안내', exact: true}).click();
  await guide.getByTestId('control-profile-memory-map').getByText('내 지시', {exact: true}).waitFor();
  assert.ok((await guide.innerText()).includes('호출: agentstoz · 아젠투지 · 에이전츠투지'));
  assert.ok((await guide.innerText()).includes('내 지시는 「내가 한 말」에서'));
  const advanced = panel.locator('details').filter({hasText: '고급 정보'});
  await advanced.locator('summary').click();
  await advanced.getByText(MEMORY_ID, {exact: true}).waitFor();
  await advanced.getByText('마지막 기억 갱신', {exact: true}).waitFor();

  // 「열기 방식 바꾸기」 opens the launch options at the existing controls.
  await status.getByRole('button', {name: '열기 방식 바꾸기', exact: true}).click();
  assert.equal(await focusedId(page), 'control-profile-launch-toggle');
  assert.equal(await panel.getByLabel('OPS 실행 표면').inputValue(), 'app');
  assert.equal(await panel.getByLabel('OPS 실행 AI').inputValue(), 'codex');

  // A save after reading keeps the reviewed request exactly and reports next to the candidates.
  await toggle.click();
  await save.click();
  await panel.getByTestId('control-profile-pending').getByText('운영 기억은 로컬에 저장했습니다. 원격 백업 상태는 별도 확인이 필요합니다.', {exact: true}).waitFor();
  assert.deepEqual(calls.filter(c => c.path.endsWith('/review')).map(c => c.body), [{id: 'candidate-long', accept: true, expectedRevision: 'revision-1'}]);
  // The saved candidate leaves with the button that had focus (Chromium focuses a clicked button; WebKit, like macOS
  // Safari, keeps focus on the dialog). Either way focus stays in the dialog, so Escape still closes it.
  await long.waitFor({state: 'detached'});
  const focus = await page.evaluate(() => { const el = document.activeElement; return {inDialog: !!el?.closest('[data-testid="control-profile-panel"]'), id: el?.id ?? '', tag: el?.tagName ?? ''}; });
  assert.equal(focus.inDialog, true, `Focus is not lost to the page after a save (${engine}: ${focus.tag}#${focus.id})`);
  if (engine === 'chromium') assert.equal(focus.id, 'control-profile-pending-title', 'Chromium: focus returns to the candidates heading');

  await page.keyboard.press('Escape');
  await panel.waitFor({state: 'hidden'});
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Open settings', 'Escape returns focus to the opener');
}

async function attention({panel}) {
  const status = panel.getByTestId('control-profile-status');
  await status.getByText('다른 Mac의 운영 기억과 맞추지 못했습니다. 연결을 확인하세요.', {exact: true}).waitFor();
  await panel.getByTestId('control-profile-saved-memory').getByRole('alert').filter({hasText: '저장된 운영 기억을 읽지 못했습니다. 「상태 다시 확인」을 누르세요.'}).waitFor();
  await status.getByTestId('control-profile-bypass-on').waitFor();
  assert.match(await panel.getByTestId('control-profile-launch-summary').innerText(), /권한 우회 켜짐/);
  await status.getByRole('button', {name: '아젠투지를 Claude 앱으로 열기', exact: true}).waitFor();
  assert.equal(await panel.getByTestId('control-profile-launch').getByRole('button', {name: '아젠투지 열기 방식', exact: true}).getAttribute('aria-expanded'), 'false',
    'The bypass stays visible while the options are folded');
}

async function localOnly({panel}) {
  const status = panel.getByTestId('control-profile-status');
  await status.getByText('운영 기억 준비됨 · 이 Mac 전용', {exact: true}).waitFor();
  assert.equal(await status.getByRole('button', {name: '아젠투지를 Codex 앱으로 열기', exact: true}).isDisabled(), true);
  assert.equal(await status.getByRole('button', {name: '아젠투지 채팅·워크룸 열기', exact: true}).isDisabled(), true);
  await status.getByText(/로컬 전용 OPS는 패널·기억 호출/).waitFor();
  await panel.getByTestId('control-profile-todo').getByText('기다리는 후보나 연결 확인이 없습니다.', {exact: true}).waitFor();
  assert.match(await panel.getByTestId('control-profile-pending').innerText(), /후보 없이 바로 저장합니다/);
}

async function restore({page, panel}) {
  const todo = panel.getByTestId('control-profile-todo');
  const box = todo.getByTestId('control-profile-restore');
  await box.getByText('1호에서 쓰는 아젠투지(OPS)가 있습니다', {exact: false}).waitFor();
  await box.getByRole('button', {name: '다른 Mac의 아젠투지 복원', exact: true}).waitFor();
  await todo.getByRole('button', {name: '이 운영 기억을 아젠투지에 연결', exact: true}).waitFor();
  assert.equal(await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="control-profile-panel"]'), restore = document.querySelector('[data-testid="control-profile-restore"]');
    const a = panel.getBoundingClientRect(), b = restore.getBoundingClientRect(); return b.top >= a.top && b.bottom <= a.bottom;
  }), true, 'The restore a second Mac needs is in the first screen');
  assert.equal(await todo.getByText('기다리는 후보나 연결 확인이 없습니다.', {exact: true}).count(), 0);
}

/**
 * Review 2026-10-28: an OPS memory sync conflict alone used to leave 「기다리는 후보나 연결 확인이 없습니다.」 under the
 * conflict line. It is a to-do now, and its action only navigates to the 장기기억 tab — no request leaves the panel.
 */
async function syncConflict({page, panel, calls}) {
  const status = panel.getByTestId('control-profile-status');
  const line = status.getByRole('status').filter({hasText: SYNC_CONFLICT});
  await line.waitFor();
  assert.match(await line.getAttribute('class'), /text-amber-600/, 'The sync problem reads as a warning');
  const todo = panel.getByTestId('control-profile-todo');
  await todo.getByRole('heading', {name: '지금 할 일', exact: true}).waitFor();
  assert.equal(await todo.getByText('기다리는 후보나 연결 확인이 없습니다.', {exact: true}).count(), 0, 'Nothing-waiting is never said under a sync problem');
  const item = todo.getByTestId('control-profile-sync-attention');
  await item.getByText('운영 기억 동기화 확인', {exact: true}).waitFor();
  await item.getByText(/어느 쪽도 자동으로 덮어쓰지 않았습니다/).waitFor();
  // The dedicated OPS comparison leaves the DEV editor separate.
  assert.doesNotMatch(await status.innerText(), /충돌 검토/, 'No pointer to a review screen OPS cannot open');
  const itemText = await item.innerText();
  assert.match(itemText, /운영 기억 비교에서 두 내용을 읽고 적용할 수 있습니다/);
  assert.doesNotMatch(itemText, /맞춘 뒤/);
  const before = calls.length;
  await item.getByRole('button', {name: '장기기억 현황 보기', exact: true}).click();
  await page.getByTestId('fixture-events').filter({hasText: 'memory-status'}).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(calls.slice(before), [], 'Opening the 장기기억 status sends nothing: no pull, push, prepare or review');
  assert.equal(calls.some(c => c.method !== 'GET' && !c.path.endsWith('/launch-preference')), false, 'The panel resolved nothing by itself');
  await item.getByRole('button',{name:'운영 기억 비교',exact:true}).click();
  const review=item.getByTestId('control-memory-conflict-panel');
  assert.equal(calls.some(c=>c.path.endsWith('/memory-conflict')),false,'Opening the comparison does not read memory until requested');
  await review.getByRole('button',{name:'운영 기억 비교하기',exact:true}).click();
  await review.getByRole('textbox',{name:'이 Mac의 운영 기억',exact:true}).waitFor();
  assert.match(await review.getByRole('textbox',{name:'원격 운영 기억',exact:true}).inputValue(),/Remote decision/);
  const apply=review.getByRole('button',{name:'검토한 운영 기억 적용',exact:true});
  assert.equal(await apply.isDisabled(),true,'No apply before reviewing');
  await review.getByRole('radio',{name:'이 Mac의 내용',exact:true}).check();
  await review.getByRole('checkbox').check();await apply.click();
  await review.getByRole('status').filter({hasText:'검토한 운영 기억을 적용했습니다'}).waitFor();
  const writes=calls.filter(c=>c.path.endsWith('/memory-conflict')&&c.body.operation==='resolve');
  assert.equal(writes.length,1);assert.deepEqual(writes[0].body,{operation:'resolve',expectedProfileId:PROFILE_ID,expectedMemoryId:MEMORY_ID,strategy:'keep-local',reviewed:true,expectedLocalHash:'a'.repeat(64),expectedRemoteRevisionId:'11111111-1111-4111-8111-111111111111',expectedRemoteContentHash:'b'.repeat(64)});
}

async function many({panel}) {
  const pending = panel.getByTestId('control-profile-pending');
  assert.equal(await pending.getByTestId('control-profile-candidate').count(), 5);
  const more = pending.getByRole('button', {name: '후보 2개 더 보기', exact: true});
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  await more.click();
  assert.equal(await pending.getByTestId('control-profile-candidate').count(), 7);
  await pending.getByRole('heading', {name: '운영 기억 저장 후보 · 7', exact: true}).waitFor();
}

async function narrow({page}, m) {
  assert.equal(m.horizontalOverflow, false, 'No horizontal overflow at 390 px');
  assert.deepEqual({status: m.firstScreen.status, open: m.firstScreen.openButton}, {status: true, open: true}, 'Status and the main open action are in the first phone screen');
  const small = await page.evaluate(() => [...document.querySelectorAll('[data-testid="control-profile-panel"] button')]
    .filter(button => button.getClientRects().length && button.getBoundingClientRect().height < 44).map(button => button.textContent.trim()));
  assert.deepEqual(small, [], 'Every visible button keeps a 44 px target');
}

const engines = measureOnly ? [['chromium', chromium]] : [['chromium', chromium], ['webkit', webkit]];
const results = [];
mkdirSync('.agentstoz/maintainer', {recursive: true});
for (const [engineName, engine] of engines) {
  const browser = await engine.launch();
  try {
    for (const viewport of [{width: 1100, height: 850}, {width: 390, height: 844}]) {
      const run = await open(browser, 'rich', viewport);
      try {
        const m = await run.page.evaluate(measure);
        m.startupRequests = startup(run.calls);
        results.push({engine: engineName, ...m});
        if (!measureOnly && engineName === 'chromium') targets(m);
        await run.page.screenshot({path: `.agentstoz/maintainer/control-profile-layout-${label}-${engineName}-${viewport.width}.png`});
        if (!measureOnly) await (viewport.width === 1100 ? richDesktop({...run, engine: engineName}, m) : narrow(run, m));
      } finally { await run.done(); }
    }
    if (measureOnly) continue;
    for (const [kind, check, restoreFrom] of [['attention', attention], ['local-only', localOnly], ['restore', restore, '1호'], ['sync-conflict', syncConflict], ['many', many]]) {
      const run = await open(browser, kind, {width: 1100, height: 850}, restoreFrom);
      try { await check(run); } finally { await run.done(); }
    }
  } finally { await browser.close(); }
}
const summary = results.map(r => `${r.engine} ${r.viewport.width}×${r.viewport.height}: scrollHeight ${r.panelScrollHeight}, rendered text ${r.renderedTextChars}, first-screen text ${r.viewportTextChars}, controls ${r.renderedControls}/${r.viewportControls} in view, requests ${r.startupRequests.length}, first screen ${JSON.stringify(r.firstScreen)}`);
if (process.env.CONTROL_PROFILE_LAYOUT_OUT) writeFileSync(process.env.CONTROL_PROFILE_LAYOUT_OUT, JSON.stringify({label, results}, null, 2));
console.log(`control-profile-layout (${label}):\n  ${summary.join('\n  ')}`);
if (!measureOnly) console.log('PASS: 아젠투지 설정 — status, to-do and the main open action first; candidate preview with full text before save; folded details keep counts, errors, sync, bypass and local-only visible; Chromium + WebKit');
