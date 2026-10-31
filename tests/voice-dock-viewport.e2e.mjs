/**
 * 음성 도크·음성 패널이 창 안에 머물고 프로젝트 머리의 도구를 가리지 않는지 — 전수 클릭 검사(2026-11-01, 1440×900)가
 * 찾은 두 결함의 회귀.
 *
 *  1. 음성 패널의 「음성 패널 닫기」·「대화 패널 닫기」가 창 위로 나가(패널 top y=-200) 누를 수 없었다. 브라우저 빌드는
 *     #root를 화면 배율(기본 125%)로 transform하는데, 패널이 100dvh와 확대된 도크 높이로 자기 위치를 잡았다.
 *  2. 「실행 도구」를 열면 목록 아래쪽(권한 우회 토글, 빌드 메뉴)이 도크(z 1000) 아래에 깔려 클릭이 도크에 먹혔다.
 *  + 도크가 펼쳐져도(저장 알림·열린 AI 세션) 머리 띠까지 올라오지 않고, 음성 패널과 세션 목록은 한 번에 하나만 뜬다.
 *
 * 판정은 기하다: 대상의 상자가 창 안에 있고, 가운데 점의 elementFromPoint가 대상 자신(또는 그 안)이며, Playwright의
 * 실제 클릭(trial 포함)이 통과한다. 1280×800 · 1440×900 · 1920×1200을 배율 125%(기본)와 100%에서 본다.
 *
 * 격리된 Vite 빌드 + 합성 API만 쓴다 — 실사용 사이드카(3001)·Supabase에 닿지 않는다.
 *   ./node_modules/.bin/vite build --outDir <dir> && bun tests/voice-dock-viewport.e2e.mjs <dir> [evidence-dir] [--shots]
 * evidence-dir(기본 .agentstoz/maintainer/voice-dock-viewport)에 크기·배율별 상자 측정(boxes.json)을 남긴다.
 */
import {chromium} from 'playwright';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dist = args.find(a => !a.startsWith('--'));
if (!dist) throw new Error('Pass an isolated Vite build directory');
const evidence = resolve(root, args.filter(a => !a.startsWith('--'))[1] ?? '.agentstoz/maintainer/voice-dock-viewport');
const shots = args.includes('--shots');
const SIZES = [{width: 1280, height: 800}, {width: 1440, height: 900}, {width: 1920, height: 1200}];
const ZOOMS = [null, '1']; // null = the app's default 배율 (125%)

const now = Date.now(), ago = minutes => new Date(now - minutes * 60_000).toISOString();
const PORTS = [
  {id: '11111111-aaaa-4aaa-8aaa-000000000001', name: 'AgentsToZ_byCS', aiName: 'Port Manager App', category: 'tool', port: 9000, folderPath: '/fixture/product/AgentsToZ_byCS', favorite: true, isRunning: true, terminalCommand: 'bun run dev'},
  {id: '22222222-aaaa-4aaa-8aaa-000000000002', name: 'song-app', aiName: 'Music Player', category: 'music', port: 5173, folderPath: '/fixture/product/song-app', role: 'dev'},
  {id: '44444444-aaaa-4aaa-8aaa-000000000004', name: 'vault', aiName: 'AI Knowledge Vault', category: 'notes', folderPath: '/fixture/vault'},
  {id: '55555555-aaaa-4aaa-8aaa-000000000005', name: 'ShadowLoop', category: 'game', port: 8080, folderPath: '/fixture/product/ShadowLoop', favorite: true},
];
// The click sweep's synthetic API (tests/click-sweep.e2e.mjs), so the screens match what it found.
const FIXTURE = {
  '/api/ports': PORTS, '/api/portal': {},
  '/api/workspace-roots': [{id: 'root1', name: 'product', path: '/fixture/product'}],
  '/api/portal/safety-lease/acquire': {success: true, token: 'a'.repeat(64), metadata: {}, fingerprint: portalLocalMetadataFingerprint({}), expiresInMs: 30000},
  '/api/portal/safety-lease/release': {released: true},
  '/api/ports/merge': {success: true}, '/api/health': {status: 'ok'}, '/api/onboarding/status': {stage: 'complete'},
  '/api/last-visits': Object.fromEntries(PORTS.map((p, i) => [p.id, now - i * 86400e3])),
  '/api/last-git-activity': {}, '/api/check-ports-batch': {success: true, results: [{port: 9000, isRunning: true}]},
  '/api/voc/access': {blocked: false}, '/api/browser-profiles': {profiles: []},
  '/api/orca-worktrees': {success: true, worktrees: []},
  '/api/discover-registered-git-worktrees': {success: true, worktrees: [], nextCursor: null},
  '/api/list-git-worktrees': {success: true, worktrees: [{path: '/fixture/product/AgentsToZ_byCS', branch: 'main', is_main: true, head: 'a'.repeat(40), locked: false}]},
  '/api/client-errors': {ok: true, items: []},
};
// A busy dock: three saved-notice cards (+1 more) and twelve open AI sessions, so the list wants more than the window.
const session = (n, agent) => ({sessionId: `s-${n}`, sourceAgent: agent, cwd: PORTS[n % PORTS.length].folderPath, projectDir: null, threadSource: null,
  threadTitle: `작업 ${n}`, projectHint: null, modelId: null, modelName: agent === 'claude' ? 'Opus' : 'GPT', windowSize: 200000, usedPercent: 20 + n * 5,
  remainingPercent: 80 - n * 5, usedTokens: 1000 * n, costUsd: null, ageMs: 1000, capturedAt: ago(1), state: 'active',
  clientLabel: agent === 'claude' ? 'Claude Code' : 'Codex CLI', surfaceKind: 'terminal', surfaceLabel: 'Terminal', surfaceDetail: null, surfacePresence: null});
const BUSY = {
  '/api/context-usage': {sessions: Array.from({length: 12}, (_, n) => session(n, n % 2 ? 'claude' : 'codex')), captureInstalled: true},
  '/api/project-memory/auto-checkpoint/status': {schemaVersion: 1, settings: {enabled: true, enabledAt: ago(999), thresholds: [50, 70, 75, 90]}, running: true, recoveryCheckpoints: [],
    sessions: ['AgentsToZ_byCS', 'song-app', 'vault', 'ShadowLoop'].map((projectName, i) => ({sourceAgent: i % 2 ? 'codex' : 'claude', sessionId: `n${i}`, projectName, lastCheckpointAt: ago(5 + i * 30), lastCheckpointThreshold: 70}))},
};

const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: req => {
  const path = new URL(req.url).pathname;
  const file = Bun.file(join(dist, path === '/' ? 'index.html' : path));
  return file.size ? new Response(file) : new Response(Bun.file(join(dist, 'index.html')));
}});

const failures = [], measured = [];
let passed = 0;
const check = (label, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`);
  console.log(`✗ ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`);
};

/** The box, whether it is inside the window, and what the topmost element at its centre is. */
const hitInfo = locator => locator.evaluate(el => {
  const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  const inWindow = r.width > 0 && r.top >= -0.5 && r.left >= -0.5 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
  const top = inWindow ? document.elementFromPoint(x, y) : null;
  const self = !!top && (top === el || el.contains(top));
  const coveredBy = top && !self ? (top.closest('[data-testid]')?.getAttribute('data-testid') || String(top.className || top.tagName).slice(0, 60)) : null;
  return {box: {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)}, inWindow, self, coveredBy};
});
const rectOf = locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom}; });
const clickable = async locator => { try { await locator.click({trial: true, timeout: 2500}); return true; } catch { return false; } };
/** A step that throws is a failure of that step, not the end of the run — so an unfixed build still reports every check. */
const step = async (label, fn) => { try { await fn(); } catch (e) { check(`${label}: step finished`, false, String(e.message).split('\n')[0]); } };
/** Dismiss a voice panel its own 닫기 could not close (the app's close event), so the next step starts clean. */
const dismissPanel = page => page.evaluate(() => window.dispatchEvent(new Event('agentstoz:close-ops-voice'))).then(() => page.getByTestId('voice-panel').waitFor({state: 'hidden', timeout: 2500})).catch(() => {});

async function openApp(browser, viewport, zoom, busy) {
  const context = await browser.newContext({viewport, timezoneId: 'Asia/Seoul', locale: 'ko-KR'});
  await context.addInitScript(value => {
    try {
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem('portmanager-setup-wizard-seen-v1', '1');
      if (value) localStorage.setItem('portmanager-ui-zoom', value);
    } catch {}
  }, zoom);
  const api = busy ? {...FIXTURE, ...BUSY} : FIXTURE;
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === '127.0.0.1' && !url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/ports' && request.method() === 'POST') return route.fulfill({json: {success: true}});
    if (busy && url.pathname === '/api/project-memory/detect') {
      const folderPath = JSON.parse(request.postData() || '{}').folderPath ?? '';
      return route.fulfill({json: {exists: false, projectRoot: folderPath, modifiedAt: null, contentHash: null, config: null, activity: {needsRemember: false, reasons: [], lastRememberedAt: null}}});
    }
    if (url.hostname === '127.0.0.1' && Object.hasOwn(api, url.pathname)) return route.fulfill({json: api[url.pathname]});
    return route.fulfill({status: 503, json: {error: 'fixture blocked'}});
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.url.toString(), {waitUntil: 'domcontentloaded'});
  await page.getByRole('tablist').first().waitFor({timeout: 20000});
  await page.getByTestId('voice-dock-call').waitFor();
  await page.waitForTimeout(600);
  return {context, page, errors};
}

const launchTools = page => page.locator('[data-testid="project-main-actions"] > details.workspace-tools').filter({has: page.locator(':scope > summary', {hasText: '실행 도구'})});

/** Every action in the project header is the topmost element at its centre. */
async function headerUncovered(page, label) {
  const targets = page.locator('[data-testid="project-main-header"] :is(button, summary, a[href])');
  const covered = [];
  for (let i = 0, n = await targets.count(); i < n; i++) {
    const target = targets.nth(i);
    if (!await target.isVisible()) continue;
    const info = await hitInfo(target);
    if (info.inWindow && !info.self) covered.push({name: (await target.innerText()).trim().slice(0, 20) || await target.getAttribute('aria-label'), ...info});
  }
  check(`${label}: no project header action is covered`, covered.length === 0, covered);
}

/** 「실행 도구」 open: its list ends above the dock, and 권한 우회 · 빌드 can be reached and pressed. */
async function launchToolsReachable(page, label, record) {
  const tools = launchTools(page);
  await tools.locator(':scope > summary').click({timeout: 5000});
  const panel = tools.locator(':scope > .workspace-tools-panel');
  await panel.waitFor();
  await page.waitForTimeout(300); // the fade-up animation moves the panel by 6px
  const panelBox = await rectOf(panel), dockBox = await rectOf(page.getByTestId('voice-dock'));
  // With room above the dock the list ends there; an expanded dock leaves none, so the list goes over it instead.
  const overDock = await tools.getAttribute('data-over-dock') === 'true';
  record.launchTools = {panel: panelBox, dock: dockBox, overDock};
  if (panelBox.right > dockBox.left && panelBox.left < dockBox.right) {
    if (!overDock) check(`${label}: 실행 도구 ends above the dock`, panelBox.bottom <= dockBox.top + 0.5, {panelBottom: Math.round(panelBox.bottom), dockTop: Math.round(dockBox.top)});
    else check(`${label}: an expanded dock steps below 실행 도구`, await page.getByTestId('voice-dock').evaluate(el => getComputedStyle(el).zIndex) === '9');
  }
  check(`${label}: 실행 도구 stays inside the window`, panelBox.top >= 0 && panelBox.bottom <= page.viewportSize().height + 0.5, panelBox);
  for (const [name, target] of [
    ['권한 우회 (#bypass-toggle)', page.getByTestId('bypass-toggle')],
    ['빌드 menu', panel.locator('details.workspace-tools > summary').filter({hasText: '빌드'})],
  ]) {
    await target.scrollIntoViewIfNeeded();
    const info = await hitInfo(target);
    record[name] = info;
    check(`${label}: ${name} is on screen and on top`, info.inWindow && info.self, info);
    check(`${label}: ${name} can be clicked`, await clickable(target));
  }
  if (shots) await page.screenshot({path: join(evidence, `${label.replace(/[^\w.-]+/g, '_')}-launch-tools.png`)});
  await tools.locator(':scope > summary').click({timeout: 5000});
}

/** The voice panel opened from the dock keeps its 닫기 inside the window, on top, and it closes the panel. */
async function panelCloses(page, label, opener, closeName, record) {
  await page.getByTestId(opener).click();
  const panel = page.getByTestId('voice-panel');
  await panel.waitFor();
  await page.waitForTimeout(250);
  const close = panel.getByRole('button', {name: closeName});
  const panelBox = await rectOf(panel), info = await hitInfo(close);
  record[closeName] = {panel: panelBox, close: info};
  check(`${label}: voice panel (${opener}) stays inside the window`, panelBox.top >= -0.5 && panelBox.bottom <= page.viewportSize().height + 0.5, panelBox);
  check(`${label}: 「${closeName}」 is on screen and on top`, info.inWindow && info.self, info);
  if (shots && closeName === '음성 패널 닫기') await page.screenshot({path: join(evidence, `${label.replace(/[^\w.-]+/g, '_')}-voice-panel.png`)});
  try { await close.click({timeout: 2500}); await panel.waitFor({state: 'hidden', timeout: 2500}); check(`${label}: 「${closeName}」 closes the panel`, true); }
  catch (e) { check(`${label}: 「${closeName}」 closes the panel`, false, String(e.message).split('\n')[0]); await dismissPanel(page); }
}

let browser;
try {
  mkdirSync(evidence, {recursive: true, mode: 0o700});
  browser = await chromium.launch();
  for (const viewport of SIZES) for (const zoom of ZOOMS) {
    const label = `${viewport.width}x${viewport.height}@${zoom ? Math.round(Number(zoom) * 100) : 125}%`;
    const record = {label};
    measured.push(record);
    { // The plain dock the sweep saw.
      const {context, page, errors} = await openApp(browser, viewport, zoom, false);
      const dock = await rectOf(page.getByTestId('voice-dock')), header = await rectOf(page.getByTestId('project-main-header'));
      record.idle = {dock, header};
      check(`${label}: the dock is inside the window`, dock.top >= 0 && dock.bottom <= viewport.height && dock.right <= viewport.width, dock);
      check(`${label}: the dock stays below the project header`, dock.top >= header.bottom, {dockTop: dock.top, headerBottom: header.bottom});
      await step(label, () => headerUncovered(page, label));
      await step(label, () => panelCloses(page, label, 'voice-dock-call', '음성 패널 닫기', record));
      await step(label, () => panelCloses(page, label, 'voice-dock-text-start', '대화 패널 닫기', record));
      await step(label, () => launchToolsReachable(page, label, record));
      await step(label, async () => { // The settings menu (z 1000) would cover the panel it opened, e.g. 대화 방식 → 음성's consent box.
        await page.getByTestId('voice-dock-settings').click({timeout: 5000});
        await page.getByTestId('voice-dock-menu').waitFor({timeout: 5000});
        await page.getByTestId('voice-dock-call').click({timeout: 5000});
        await page.getByTestId('voice-panel').waitFor({timeout: 5000});
        check(`${label}: opening the voice panel folds the dock settings menu`, await page.getByTestId('voice-dock-menu').count() === 0);
        await dismissPanel(page);
      });
      check(`${label}: no page errors`, errors.length === 0, errors);
      await context.close();
    }
    { // A busy dock: saved notices, then the open-session list expanded.
      const busyLabel = label + ' busy';
      const {context, page, errors} = await openApp(browser, viewport, zoom, true);
      await page.getByTestId('dock-notices').waitFor({timeout: 20000});
      await page.getByTestId('voice-dock-sessions').click();
      const sessions = page.getByTestId('voice-dock-sessions-panel');
      await sessions.locator('.az-session').first().waitFor({timeout: 10000});
      await page.waitForTimeout(400);
      const dock = await rectOf(page.getByTestId('voice-dock')), header = await rectOf(page.getByTestId('project-main-header'));
      record.busy = {dock, header, sessions: await rectOf(sessions)};
      check(`${busyLabel}: the expanded dock stays below the project header`, dock.top >= header.bottom, {dockTop: dock.top, headerBottom: header.bottom});
      check(`${busyLabel}: the expanded dock is inside the window`, dock.top >= 0 && dock.bottom <= viewport.height, dock);
      const call = await hitInfo(page.getByTestId('voice-dock-call'));
      check(`${busyLabel}: 아젠투지 호출 is still on screen and on top`, call.inWindow && call.self, call);
      const sessionsHead = await hitInfo(sessions.locator('.az-sessions__head strong'));
      check(`${busyLabel}: the session list's head is on screen`, sessionsHead.inWindow && sessionsHead.self, sessionsHead);
      await step(busyLabel, () => headerUncovered(page, busyLabel));
      if (shots) await page.screenshot({path: join(evidence, `${busyLabel.replace(/[^\w.-]+/g, '_')}-sessions.png`)});
      // One panel above the dock at a time: the voice panel folds the list away, and the list closes the panel.
      await step(busyLabel, () => panelCloses(page, busyLabel, 'voice-dock-call', '음성 패널 닫기', record));
      check(`${busyLabel}: opening the voice panel folded the session list`, await sessions.count() === 0);
      await step(busyLabel, async () => {
        if (await sessions.count() === 0) await page.getByTestId('voice-dock-sessions').click({timeout: 5000});
        await sessions.waitFor({timeout: 5000});
        await page.getByTestId('voice-dock-call').click({timeout: 5000});
        await page.getByTestId('voice-panel').waitFor({timeout: 5000});
        await page.getByTestId('voice-dock-sessions').click({timeout: 5000});
        await page.getByTestId('voice-panel').waitFor({state: 'hidden', timeout: 2500}).then(() => check(`${busyLabel}: opening the session list closes the voice panel`, true),
          () => check(`${busyLabel}: opening the session list closes the voice panel`, false));
      });
      await dismissPanel(page);
      await step(busyLabel, () => launchToolsReachable(page, busyLabel, record));
      check(`${busyLabel}: no page errors`, errors.length === 0, errors);
      await context.close();
    }
  }
} finally {
  await browser?.close().catch(() => {});
  server.stop(true);
}
writeFileSync(join(evidence, 'boxes.json'), JSON.stringify({at: new Date().toISOString(), dist, passed, failures, measured}, null, 2) + '\n');
console.log(`voice dock viewport: ${passed} passed, ${failures.length} failed (${join(evidence, 'boxes.json')})`);
if (failures.length) process.exitCode = 1;
