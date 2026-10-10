/**
 * 북마크 탭 레이아웃 회귀 (2026-10-07 사용자 지적 「북마크 UX가 이상하다」).
 *
 *  1. 앱 기본 창(1000px)에서 왼쪽 카테고리 칸이 접히면 대신 나오는 칩 줄이 세로로 20px까지 눌려
 *     칩이 전부 잘렸다 — 카테고리를 고를 방법이 아예 없었다.
 *  2. 같은 폭에서 카드가 430px 한 줄로만 섰다(220px 칸 + 230px 최소 카드). 이제 두 줄.
 *  3. 카테고리 묶음 안의 카드마다 그 카테고리 이름이 다시 붙었다. 고정됨 묶음에서만 보인다.
 *  4. 열어본 횟수가 숫자만 있어 무엇인지 알 수 없었다 → 「N회」.
 *  5. 카드에 마우스를 올릴 때마다 큰 설명 말풍선이 옆 카드를 덮었다(가이드 모드에서만 설명).
 *
 * 격리 Vite 빌드 + 합성 API — 3001·Supabase에 닿지 않는다.
 * 사용: ./node_modules/.bin/vite build --outDir <dir> && bun tests/portal-bookmarks-layout.e2e.mjs <dir>
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
      '/api/portal': {"items": [{"id": "i0", "name": "Supabase 대시보드", "type": "web", "url": "https://example0.com/path", "category": "c1", "description": "자주 쓰는 사이트", "pinned": true, "visitCount": 12, "createdAt": "2026-10-01T00:00:00Z"}, {"id": "i1", "name": "GitHub", "type": "web", "url": "https://example1.com/path", "category": "c1", "description": null, "pinned": false, "visitCount": 0, "createdAt": "2026-10-01T00:00:00Z"}, {"id": "i2", "name": "Vercel", "type": "web", "url": "https://example2.com/path", "category": "c1", "description": "자주 쓰는 사이트", "pinned": false, "visitCount": 3, "createdAt": "2026-10-01T00:00:00Z"}, {"id": "i3", "name": "Figma 디자인", "type": "web", "url": "https://example3.com/path", "category": "c1", "description": null, "pinned": false, "visitCount": 48, "createdAt": "2026-10-01T00:00:00Z"}, {"id": "i4", "name": "Notion 업무", "type": "web", "url": "https://example4.com/path", "category": "c2", "description": "자주 쓰는 사이트", "pinned": false, "visitCount": 1, "createdAt": "2026-10-01T00:00:00Z"}, {"id": "i5", "name": "Google 애널리틱스", "type": "web", "url": "https://example5.com/path", "category": "c2", "description": null, "pinned": false, "visitCount": 0, "createdAt": "2026-10-01T00:00:00Z"}, {"id": "i6", "name": "Claude", "type": "web", "url": "https://example6.com/path", "category": "c2", "description": "자주 쓰는 사이트", "pinned": false, "visitCount": 7, "createdAt": "2026-10-01T00:00:00Z"}], "categories": [{"id": "c1", "name": "업무", "color": "teal", "order": 0}, {"id": "c2", "name": "개발 도구", "color": "violet", "order": 1}], "deviceId": "dev1"},
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


browser = await chromium.launch();
try {
  const {page, context, errors} = await openApp({width: 1000, height: 1050});
  await page.locator('#tab-portal').click();
  await page.locator('.portal-bookmark-card').first().waitFor({timeout: 10000});
  await page.mouse.move(5, 1000);
  await page.waitForTimeout(300);

  const m = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.portal-category-tabs > button')].map(b => b.getBoundingClientRect());
    const nav = document.querySelector('.portal-category-tabs').getBoundingClientRect();
    const grids = [...document.querySelectorAll('.portal-bookmark-grid')];
    const sections = [...document.querySelectorAll('.portal-bookmark-section')].map(sec => ({
      title: sec.querySelector('h2')?.textContent,
      categoryChips: sec.querySelectorAll('.portal-bookmark-card__category').length,
    }));
    return {
      navHeight: nav.height,
      chipsVisible: chips.length > 0 && chips.every(r => r.height >= 30 && r.bottom <= nav.bottom + 1),
      columns: getComputedStyle(grids[1]).gridTemplateColumns.split(' ').length,
      sections,
      visits: [...document.querySelectorAll('.portal-bookmark-card__visits')].map(e => e.textContent),
    };
  });
  assert.ok(m.chipsVisible, `category chips must be fully visible, got ${JSON.stringify(m)}`);
  pass('category chip row is not squeezed at the 1000px app window');
  assert.equal(m.columns, 2, 'two card columns at the default app window');
  pass('two bookmark columns at 1000px');
  const pinned = m.sections.find(s => s.title === '고정됨');
  assert.ok(pinned && pinned.categoryChips === 1, 'pinned cards keep their category');
  for (const s of m.sections.filter(s => s.title !== '고정됨')) assert.equal(s.categoryChips, 0, `${s.title}: no repeated category chip`);
  pass('category name is not repeated on cards inside its own section');
  assert.ok(m.visits.length > 0 && m.visits.every(v => /^\d+회$/.test(v)), `visit counts are labeled, got ${m.visits}`);
  pass('visit count reads 「N회」');

  // An unhovered card's URL must not sit under the (faded) action box.
  const covered = await page.evaluate(() => {
    const card = document.querySelectorAll('.portal-bookmark-section')[1].querySelector('.portal-bookmark-card');
    const url = card.querySelector('.portal-bookmark-card__url').getBoundingClientRect();
    const hit = document.elementFromPoint(url.left + Math.min(url.width - 2, 120), url.top + url.height / 2);
    return !(hit && card.querySelector('.portal-bookmark-card__url').contains(hit));
  });
  assert.equal(covered, false, 'URL text is not covered by the hover action box');
  pass('URL stays readable while not hovered');

  await page.locator('.portal-bookmark-section').nth(1).locator('.portal-bookmark-card__title').first().hover();
  await page.waitForTimeout(600);
  const bubble = await page.getByText('클릭하면 새 탭(Chrome)에서 URL을 열어요', {exact: false}).count();
  assert.equal(bubble, 0, 'resting on a card does not pop the guide explanation');
  const actions = await page.locator('.portal-bookmark-section').nth(1).locator('.portal-bookmark-card__actions').first().evaluate(e => getComputedStyle(e).opacity);
  assert.equal(actions, '1', 'hover still reveals the card actions');
  pass('card hover shows actions, not an explanation bubble');

  assert.deepEqual(errors, []);
  await context.close();
  console.log(`\n${results.length} checks passed`);
} finally { await browser.close(); server.stop(true); }
