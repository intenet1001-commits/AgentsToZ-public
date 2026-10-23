/**
 * 프로젝트·폴더 탭과 공용 셸의 회귀 — 2026-09 UI 감사에서 실측으로 재현된 것들.
 *
 *  1. 설정(⚙ Supabase/기기) 첫 클릭이 아무것도 안 보였다. PortalManager 가 마운트될 때
 *     `showSettings=false` 로 onSettingsClosed 를 불러 부모 플래그를 즉시 내렸고, 모달은
 *     숨겨진 북마크 탭 패널 안에 갇혔다. 두 번째 클릭에서만 열렸다.
 *  2. 가이드(안전 탐색) 모드가 localStorage 에 저장돼, 켠 채로 앱을 다시 열면 모든
 *     클릭이 설명으로 바뀌어 앱이 멈춘 것처럼 보였다. VOC 모드와 같은 세션 한정 규칙.
 *  3. 사이드바 프로젝트 목록이 1440x900 에서 3.8행(242px), 태그·작업 루트를 펼치면
 *     1행 미만(57px)으로 눌렸다. 역할 칩이 데스크톱에서도 44px 터치 높이였다.
 *  4. 새 프로젝트·정리 검토·삭제 확인 대화상자가 Escape 로 닫히지 않았고, 새 프로젝트
 *     바깥 클릭은 입력한 기존 폴더 경로를 말없이 지웠다.
 *  5. 검색 결과 0건일 때 본문이 "왼쪽 목록에서 프로젝트를 선택하세요"라고 했다.
 *
 * 격리된 Vite 빌드 + 합성 API 만 쓴다 — 실사용 사이드카(3001)와 Supabase 에 닿지 않는다.
 *
 * 사용: ./node_modules/.bin/vite build --outDir <dir> && bun tests/projects-tab-ui.e2e.mjs <dir>
 */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';

const dist = process.argv[2];
if (!dist) throw new Error('Pass an isolated Vite build directory');

const DAY = 86400e3;
const savedRoots = [];
const PORTS = [
  {id: '11111111-aaaa-4aaa-8aaa-000000000001', name: 'AgentsToZ_byCS', aiName: 'Port Manager App', category: 'tool', port: 9000, folderPath: '/fixture/product/AgentsToZ_byCS', favorite: true, isRunning: true, terminalCommand: 'bun run dev'},
  {id: '22222222-aaaa-4aaa-8aaa-000000000002', name: 'song-app', aiName: 'Music Player', category: 'music', port: 5173, folderPath: '/fixture/product/song-app', role: 'dev'},
  {id: '33333333-aaaa-4aaa-8aaa-000000000003', name: 'long-name-project', category: 'tool', port: 3100, folderPath: '/fixture/product/long-name-project'},
  {id: '44444444-aaaa-4aaa-8aaa-000000000004', name: 'vault', aiName: 'AI Knowledge Vault', category: 'notes', folderPath: '/fixture/vault'},
  {id: '55555555-aaaa-4aaa-8aaa-000000000005', name: 'ShadowLoop', category: 'game', port: 8080, folderPath: '/fixture/product/ShadowLoop', favorite: true},
  {id: '66666666-aaaa-4aaa-8aaa-000000000006', name: 'freeparking-1', category: 'web', port: 4000, folderPath: '/fixture/other/freeparking-1'},
  {id: '77777777-aaaa-4aaa-8aaa-000000000007', name: 'old-one', category: 'web', port: 4100, folderPath: '/fixture/other/old-one'},
  {id: '88888888-aaaa-4aaa-8aaa-000000000008', name: 'old-two', category: 'etc', port: 4200, folderPath: '/fixture/other/old-two'},
  {id: '99999999-aaaa-4aaa-8aaa-000000000009', name: 'recent-three', category: 'etc', port: 4300, folderPath: '/fixture/product/recent-three'},
  {id: 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000a', name: 'recent-four', category: 'tool', port: 4400, folderPath: '/fixture/product/recent-four'},
];

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.E2E_PORT ?? 0),
  fetch: req => {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(dist, path === '/' ? 'index.html' : path));
    return file.size ? new Response(file) : new Response(Bun.file(join(dist, 'index.html')));
  },
});

let browser;
const results = [];
const pass = name => { results.push(name); console.log(`✓ ${name}`); };

async function openApp({width = 1440, height = 900, preset = {}, ports = PORTS, opsProjectId = null} = {}) {
  const context = await browser.newContext({viewport: {width, height}});
  await context.addInitScript(values => {
    try {
      if (!sessionStorage.getItem('projects-tab-e2e-init')) {
        sessionStorage.setItem('projects-tab-e2e-init', '1');
        localStorage.setItem('portmanager-setup-wizard-seen-v1', '1');
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
      }
    } catch {}
  }, preset);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const u = new URL(request.url());
    if (!u.pathname.startsWith('/api/') && u.hostname === '127.0.0.1') return route.continue();
    if (u.pathname === '/api/ports' && request.method() === 'POST') return route.fulfill({json: {success: true}});
    if (u.pathname === '/api/ports/merge') return route.fulfill({json: {success: true}});
    if (u.pathname === '/api/workspace-roots' && request.method() === 'POST') { savedRoots.push(JSON.parse(request.postData() || '[]')); return route.fulfill({json: {success: true}}); }
    if (u.pathname === '/api/list-git-worktrees') return route.fulfill({json: {success: true, worktrees: [
      {path: '/fixture/product/AgentsToZ_byCS', branch: 'main', is_main: true, head: 'a'.repeat(40), locked: false},
      {path: '/fixture/product/AgentsToZ_byCS/worktrees/feature-a', branch: 'feature-a', is_main: false, head: 'b'.repeat(40), locked: false},
      {path: '/fixture/product/AgentsToZ_byCS/worktrees/feature-b', branch: 'feature-b', is_main: false, head: 'c'.repeat(40), locked: false},
    ]}});
    const now = Date.now();
    const values = {
      '/api/ports': ports,
      '/api/portal': {},
      '/api/workspace-roots': [
        {id: 'root1', name: 'product', path: '/fixture/product'},
        {id: 'root2', name: 'other', path: '/fixture/other'},
        {id: 'root3', name: 'third', path: '/fixture/third'},
        {id: 'root4', name: 'fourth', path: '/fixture/fourth'},
      ],
      '/api/portal/safety-lease/acquire': {success: true, token: 'a'.repeat(64), metadata: {}, fingerprint: portalLocalMetadataFingerprint({}), expiresInMs: 30000},
      '/api/portal/safety-lease/release': {released: true},
      '/api/health': {status: 'ok'},
      '/api/onboarding/status': {stage: 'complete'},
      '/api/last-visits': Object.fromEntries(PORTS.slice(0, 6).map((p, i) => [p.id, now - i * DAY])),
      '/api/last-git-activity': {},
      '/api/check-ports-batch': {success: true, results: [{port: 9000, isRunning: true}]},
      '/api/voc/access': {blocked: false},
      '/api/browser-profiles': {profiles: []},
      '/api/orca-worktrees': {success: true, worktrees: []},
      '/api/discover-registered-git-worktrees': {success: true, worktrees: [], nextCursor: null},
      '/api/cleanup-stale-worktrees': {success: true, removed: []},
      '/api/client-errors': {ok: true},
      ...(opsProjectId ? {'/api/control-profile/status': {success: true, profile: {state: 'ready', projectId: opsProjectId, profileId: null, memoryId: null}}} : {}),
    };
    if (Object.hasOwn(values, u.pathname)) return route.fulfill({status: 200, json: values[u.pathname]});
    return route.fulfill({status: 503, json: {error: 'fixture blocked'}});
  });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByTestId('sidebar-project-row').first().waitFor({timeout: 20000});
  await page.waitForTimeout(800);
  return {page, context, errors};
}

const toolsSummary = page => page.locator('.workspace-sidebar-footer > .workspace-tools > summary');
async function openTools(page) {
  const open = await page.locator('.workspace-sidebar-footer > .workspace-tools').evaluate(el => el.open);
  if (!open) await toolsSummary(page).click();
}

function listMetrics(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="sidebar-project-list"]');
    const rows = [...document.querySelectorAll('[data-testid="sidebar-project-row"]')];
    const footer = document.querySelector('.workspace-sidebar-footer')?.getBoundingClientRect();
    const roots = document.querySelector('[data-testid="sidebar-workspace-roots-toggle"]')?.getBoundingClientRect();
    return {
      listHeight: list ? Math.round(list.getBoundingClientRect().height) : -1,
      rowHeight: rows[0] ? Math.round(rows[0].getBoundingClientRect().height) : -1,
      footerBottom: footer ? Math.round(footer.bottom) : -1,
      rootsToggleVisible: !!roots && roots.height > 0 && roots.bottom <= (footer?.top ?? innerHeight) + 1,
      viewport: innerHeight,
    };
  });
}

try {
  browser = await chromium.launch();

  // 1. 설정 첫 클릭
  {
    const {page, context} = await openApp();
    await openTools(page);
    await page.locator('.workspace-tools[open] [data-help-key="btn-settings"]').click();
    const dialog = page.locator('[role=dialog]').filter({hasText: 'Project URL'}).first();
    await dialog.waitFor({state: 'visible', timeout: 4000}).catch(() => {});
    assert.equal(await dialog.isVisible(), true, 'settings dialog must be visible after the FIRST gear click');
    pass('settings gear opens the dialog on the first click');
    // 닫은 뒤 다시 열어도 열린다(닫힘 통지는 true→false 전환에서만).
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'hidden', timeout: 4000}).catch(async () => {
      await page.locator('[role=dialog]').filter({hasText: 'Project URL'}).getByRole('button', {name: /취소|닫기/}).first().click();
    });
    await dialog.waitFor({state: 'hidden', timeout: 4000});
    await openTools(page);
    await page.locator('.workspace-tools[open] [data-help-key="btn-settings"]').click();
    await dialog.waitFor({state: 'visible', timeout: 4000});
    pass('settings gear reopens after closing');
    await context.close();
  }

  // 2. 가이드 모드는 세션 한정
  {
    const {page, context} = await openApp();
    await openTools(page);
    await page.locator('.workspace-tools[open] [data-help-key="btn-guide-toggle"]').click();
    await page.locator('.guide-mode-banner').waitFor({state: 'visible', timeout: 4000});
    await page.reload();
    await page.getByTestId('sidebar-project-row').first().waitFor({timeout: 20000});
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.guide-mode-banner').count(), 0, 'guide mode must not come back after a restart');
    // 실제로 클릭이 통과해야 한다(오버레이가 가로채면 timeout).
    await toolsSummary(page).click({timeout: 4000});
    const stored = await page.evaluate(() => localStorage.getItem('pm-guide-mode'));
    assert.equal(stored, null, 'guide mode must not be written to localStorage');
    pass('guide mode is session-only and clicks work after reload');
    await context.close();
  }

  // 2b. 이전 버전이 남긴 저장값('1')도 무시한다 — 업데이트 직후 첫 실행이 곧 그 상황이다.
  {
    const {page, context} = await openApp({preset: {'pm-guide-mode': '1'}});
    assert.equal(await page.locator('.guide-mode-banner').count(), 0, 'a stored guide flag from an older build must be ignored');
    await toolsSummary(page).click({timeout: 4000});
    pass('stale stored guide flag is ignored');
    await context.close();
  }

  // 3. 사이드바 목록 높이
  {
    const {page, context} = await openApp({width: 1440, height: 900});
    const collapsed = await listMetrics(page);
    assert.ok(collapsed.listHeight >= 300, `collapsed list must keep ≥300px at 1440x900, got ${JSON.stringify(collapsed)}`);
    await page.getByTestId('sidebar-tags-toggle').click();
    await page.getByTestId('sidebar-workspace-roots-toggle').click();
    await page.waitForTimeout(400);
    const expanded = await listMetrics(page);
    assert.ok(expanded.listHeight >= 190, `list must keep ≥190px with 태그+작업 루트 open, got ${JSON.stringify(expanded)}`);
    assert.ok(expanded.rootsToggleVisible, `작업 루트 header must stay visible, got ${JSON.stringify(expanded)}`);
    assert.ok(expanded.footerBottom <= expanded.viewport + 1, `sidebar footer must stay on screen, got ${JSON.stringify(expanded)}`);
    // 루트 목록은 자체 스크롤로 전부 닿을 수 있어야 한다.
    const lastRoot = page.getByTestId('workspace-root-move-down-root4');
    await lastRoot.scrollIntoViewIfNeeded();
    assert.equal(await lastRoot.isVisible(), true, 'last work root must be reachable by scrolling');
    pass(`sidebar list keeps room (collapsed ${collapsed.listHeight}px, expanded ${expanded.listHeight}px)`);
    await context.close();
  }

  // 4. 대화상자 Escape · 바깥 클릭
  {
    const {page, context} = await openApp();
    // 새 프로젝트: 기존 폴더 탭에 경로를 입력한 뒤 바깥 클릭은 지우지 않고, Escape 는 닫는다.
    await page.getByTestId('header-new-project').click();
    const dialog = page.getByTestId('new-project-dialog');
    await dialog.waitFor({state: 'visible', timeout: 4000});
    // 한글 조합 중의 Esc 는 조합 취소일 뿐 — 대화상자를 닫으면 입력이 지워진다.
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', isComposing: true, bubbles: true})));
    await page.waitForTimeout(200);
    assert.equal(await dialog.isVisible(), true, 'Escape during IME composition must not close the new-project dialog');
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'hidden', timeout: 4000});
    pass('new-project dialog closes on Escape (not during IME composition)');

    // 정리 검토
    await page.getByTestId('open-cleanup-review').click();
    const cleanup = page.getByRole('dialog', {name: /정리 검토/});
    await cleanup.waitFor({state: 'visible', timeout: 4000});
    await page.keyboard.press('Escape');
    await cleanup.waitFor({state: 'hidden', timeout: 4000});
    pass('cleanup review is a dialog and closes on Escape');

    // 삭제 확인: 안전한 선택이 먼저, 제목은 프로젝트 기준
    await page.getByTestId('sidebar-project-row').filter({hasText: 'song-app'}).first().click();
    const del = page.getByRole('button', {name: '삭제', exact: true}).first();
    await del.waitFor({timeout: 10000});
    await del.scrollIntoViewIfNeeded();
    await del.click();
    const delDialog = page.getByRole('dialog', {name: '프로젝트 목록에서 지우기'});
    await delDialog.waitFor({state: 'visible', timeout: 4000});
    const order = await delDialog.evaluate(el => [...el.querySelectorAll('[data-testid^="delete-confirm-"]')].map(b => b.getAttribute('data-testid')));
    assert.deepEqual(order, ['delete-confirm-local', 'delete-confirm-remote', 'delete-confirm-cancel'], 'safer local-only choice comes first');
    await page.keyboard.press('Escape');
    await delDialog.waitFor({state: 'hidden', timeout: 4000});
    pass('delete dialog puts the safe choice first and closes on Escape');
    await context.close();
  }

  // 4b. 새 프로젝트 — 기존 폴더 입력 후 바깥 클릭은 입력을 지우지 않는다
  {
    const {page, context} = await openApp();
    await page.getByTestId('header-new-project').click();
    const dialog = page.getByTestId('new-project-dialog');
    await dialog.waitFor({state: 'visible', timeout: 4000});
    const existingTab = dialog.getByRole('button', {name: /기존 폴더/}).first();
    if (await existingTab.count()) {
      await existingTab.click();
      const input = dialog.locator('input[type="text"], input:not([type])').first();
      await input.fill('/fixture/product/typed-path');
      await page.mouse.click(5, 450);
      await page.waitForTimeout(300);
      assert.equal(await dialog.isVisible(), true, 'backdrop click must not discard a typed folder path');
      pass('new-project backdrop click keeps typed input');
    }
    await context.close();
  }

  // 5. 검색 0건
  {
    const {page, context} = await openApp();
    await page.getByTestId('project-search-input').fill('zzzz-no-match');
    const empty = page.getByTestId('sidebar-empty-state');
    await empty.waitFor({state: 'visible', timeout: 4000});
    assert.match(await empty.innerText(), /zzzz-no-match/);
    const main = await page.locator('.workspace-empty').innerText();
    assert.doesNotMatch(main, /왼쪽 목록에서 프로젝트를 선택/, 'main pane must not ask to pick from an empty list');
    await empty.getByRole('button', {name: '검색 지우기'}).click();
    await page.getByTestId('sidebar-project-row').first().waitFor({timeout: 4000});
    pass('zero-result search explains itself and offers a way back');
    await context.close();
  }

  // 6. The OPS Workroom landing has no voice entry of its own; the dock is the only one, and the box says it
  //    types to the OPS AI (VOC 2026-09-29).
  {
    const ops = {id: '77777777-aaaa-4aaa-8aaa-000000000007', name: 'AgentsToZ-Control', role: 'ops', folderPath: '/fixture/product/AgentsToZ-Control'};
    const {page, context} = await openApp({ports: [...PORTS, ops], opsProjectId: ops.id});
    // The header chip became the always-on voice dock; the OPS Workroom is in its menu (VOC 2026-09-29).
    await page.getByTestId('voice-dock-settings').click();
    await page.getByTestId('voice-dock-open-ops-workroom').click();
    await page.locator('[data-top-level-tab="terminal"][aria-selected="true"]').waitFor({timeout: 4000});
    // One voice entry (VOC 2026-09-29): no 음성으로 시작 here; the box says it types to the OPS AI.
    assert.equal(await page.getByTestId('workroom-ops-voice-start').count(), 0);
    assert.match(await page.getByTestId('workroom-ops-input-hint').innerText(), /OPS 워크룸의 .*아젠투지 호출/);
    await page.getByTestId('voice-dock').waitFor({state: 'visible', timeout: 4000});
    pass('OPS landing has one voice entry (the dock) and labels its box');
    await context.close();
  }

  // 7. Work roots: reorder is a clear control that saves, and 「−」 only removes from the list after a
  //    neutral confirmation (VOC 2026-09-25).
  {
    const {page, context} = await openApp();
    const rootsToggle = page.getByTestId('sidebar-workspace-roots-toggle');
    if (!(await page.getByTestId('workspace-root-move-down-root1').isVisible().catch(() => false))) await rootsToggle.click();
    const before = savedRoots.length;
    await page.getByRole('button', {name: 'product 아래로'}).click();
    await page.waitForFunction(n => true, before);
    for (let i = 0; i < 20 && savedRoots.length === before; i++) await page.waitForTimeout(100);
    assert.deepEqual(savedRoots.at(-1).map(r => r.id).slice(0, 2), ['root2', 'root1'], 'moving down must save the new order');
    await page.getByRole('button', {name: 'other 목록에서 빼기'}).click();
    const confirm = page.getByTestId('workspace-root-remove-confirm');
    await confirm.waitFor({state: 'visible', timeout: 4000});
    assert.match(await page.locator('h3', {hasText: '작업 루트 목록에서 빼기'}).innerText(), /목록에서 빼기/);
    assert.match(await confirm.innerText(), /목록에서 빼기/);
    await page.getByRole('button', {name: '취소'}).last().click();
    await confirm.waitFor({state: 'hidden', timeout: 4000});
    pass('work roots reorder saves; remove is a neutral list-only confirmation');
    await page.screenshot({path: '/private/tmp/claude-503/-Users-gwanli-product-2026-AgentsToZ-byCS/0c38fa1a-e6a6-419c-ad0e-af4b814aabaf/scratchpad/ui-work-roots.png'});
    await context.close();
  }

  // 8. Main vs worktree cards read differently at a glance (VOC 2026-09-25).
  {
    const {page, context} = await openApp();
    await page.getByTestId('sidebar-project-row').filter({hasText: 'AgentsToZ_byCS'}).first().click();
    const main = page.locator('[data-worktree-kind="main"]').first();
    await main.waitFor({state: 'visible', timeout: 6000}).catch(async () => { await page.locator('[data-help-key="card-worktree"]').first().click(); await main.waitFor({state: 'visible', timeout: 6000}); });
    assert.equal(await page.getByTestId('worktree-main-label').first().innerText(), '메인 작업 폴더');
    assert.match(await page.getByTestId('worktree-branch-divider').first().innerText(), /워크트리 2개/);
    const indent = await page.locator('[data-worktree-kind="branch"]').first().evaluate(el => getComputedStyle(el).marginLeft);
    assert.equal(indent, '14px');
    await main.scrollIntoViewIfNeeded();
    await page.screenshot({path: '/private/tmp/claude-503/-Users-gwanli-product-2026-AgentsToZ-byCS/0c38fa1a-e6a6-419c-ad0e-af4b814aabaf/scratchpad/ui-worktrees.png'});
    pass('main working folder vs indented worktrees are visually distinct');
    await context.close();
  }

  // 9. 「도구 및 설정 → 더 보기」 is the last item of a height-capped, scrolling panel. The menu
  //    expanded below the fold, so the click looked dead (VOC 2026-09-29: 0–6px visible at 1512x982).
  for (const [width, height] of [[1512, 982], [1280, 800]]) {
    const {page, context} = await openApp({width, height});
    await openTools(page);
    await page.locator('.workspace-sidebar-footer .workspace-more-menu > button').click();
    const menu = page.locator('.workspace-sidebar-footer .workspace-more-menu > div');
    await menu.waitFor({state: 'visible', timeout: 4000});
    await page.waitForTimeout(300);
    const box = await page.evaluate(() => {
      const panel = document.querySelector('.workspace-sidebar-footer .workspace-tools-panel').getBoundingClientRect();
      const m = document.querySelector('.workspace-sidebar-footer .workspace-more-menu > div').getBoundingClientRect();
      return {panelTop: panel.top, panelBottom: panel.bottom, menuTop: m.top, menuBottom: m.bottom};
    });
    assert.ok(box.menuTop >= box.panelTop - 1 && box.menuBottom <= box.panelBottom + 1,
      `more menu is inside the visible panel at ${width}x${height}: ${JSON.stringify(box)}`);
    await context.close();
  }
  pass('tools panel 더 보기 menu scrolls into view when opened');

  // 10. Tapping 총괄 in the voice dock only switches who answers; it must not pop up 아젠투지 설정 (VOC 2026-09-30).
  {
    const {page, context} = await openApp();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('agentstoz:voice-target-change', {detail: {kind: 'ops', label: 'AgentsToZ OPS'}})));
    await page.waitForTimeout(400);
    assert.equal(await page.getByTestId('control-profile-panel').count(), 0);
    pass('switching the voice back to 총괄 opens nothing');
    await context.close();
  }

  console.log(`\n${results.length} checks passed`);
} finally {
  await browser?.close();
  server.stop(true);
}
