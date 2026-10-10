/**
 * (E) 프로젝트 150개·북마크 200개 목록 그리기 — 격리 Vite 빌드 + 합성 API + Playwright(chromium).
 *
 * tests/projects-tab-ui.e2e.mjs와 같은 방식이다: 모든 /api 요청을 가로채 합성 응답만 주고(3001·DB·AI
 * 없음), 모르는 요청은 503으로 막는다. 시각은 페이지 안에서 rAF마다 선택자 개수를 세어 기록한다 —
 * 그래서 Playwright 왕복 지연이 숫자에 섞이지 않는다. Long Task(50ms 이상 메인 스레드 점유)는
 * PerformanceObserver로 센다.
 *
 * 사용: bun scripts/perf/ui-lists.mjs <vite outDir> [samples] → 표준 출력에 JSON 한 줄.
 * (보통은 `bun run perf:baseline`이 빌드와 함께 부른다.)
 */
import {chromium} from 'playwright';
import {join} from 'node:path';
import {portalLocalMetadataFingerprint} from '../../src/portalLocalMetadata.ts';

const dist = process.argv[2];
const samples = Number(process.argv[3] ?? 5);
if (!dist) throw new Error('Pass an isolated Vite build directory');

export const PROJECT_COUNT = 150;
export const BOOKMARK_COUNT = 200;
/** 첫 화면을 본 뒤 탭을 누르기까지 — 유휴 미리 데우기가 끝날 만한 시간. */
export const DWELL_MS = 3_000;
const CATEGORIES = ['tool', 'web', 'music', 'notes', 'game', 'etc'];
const DAY = 86400e3;
const hex = (i, width) => i.toString(16).padStart(width, '0');

const PORTS = Array.from({length: PROJECT_COUNT}, (_, i) => ({
  id: `${hex(i + 1, 8)}-aaaa-4aaa-8aaa-${hex(i + 1, 12)}`,
  name: `perf-project-${String(i).padStart(3, '0')}`,
  aiName: `Perf Project ${i}`,
  category: CATEGORIES[i % CATEGORIES.length],
  folderPath: `/fixture/${i % 2 ? 'product' : 'other'}/perf-project-${String(i).padStart(3, '0')}`,
  ...(i < 100 ? {port: 40_000 + i} : {}),
  ...(i % 17 === 0 ? {favorite: true} : {}),
}));
const BOOKMARK_CATEGORIES = Array.from({length: 8}, (_, i) => ({id: `c${i}`, name: `카테고리 ${i}`, color: ['teal', 'violet', 'amber', 'rose'][i % 4], order: i}));
const PORTAL = {
  items: Array.from({length: BOOKMARK_COUNT}, (_, i) => ({
    id: `perf-bookmark-${i}`, name: `북마크 ${i} · Perf site`, type: 'web', url: `https://example${i}.com/path`,
    category: `c${i % BOOKMARK_CATEGORIES.length}`, description: i % 3 ? null : '자주 쓰는 사이트',
    pinned: i % 25 === 0, visitCount: i % 13, createdAt: '2026-10-01T00:00:00Z',
  })),
  categories: BOOKMARK_CATEGORIES,
  deviceId: 'perf-device',
};

const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch: req => {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(dist, path === '/' ? 'index.html' : path));
    return file.size ? new Response(file) : new Response(Bun.file(join(dist, 'index.html')));
  },
});

// 페이지 안의 계측기 — 탐색 시작(performance.now 0) 기준 시각.
const MONITOR = () => {
  const perf = {longtasks: [], watches: {}, clicks: {}};
  window.__perf = perf;
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) perf.longtasks.push({start: e.startTime, duration: e.duration}); })
      .observe({type: 'longtask', buffered: true});
  } catch {}
  perf.watch = (key, selector) => {
    const state = {first: null, lastChange: null, count: 0};
    perf.watches[key] = state;
    const tick = () => {
      const count = document.querySelectorAll(selector).length;
      const t = performance.now();
      if (count > 0 && state.first === null) state.first = t;
      if (count !== state.count) { state.count = count; state.lastChange = t; }
      requestAnimationFrame(tick);
    };
    tick();
  };
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('#tab-portal') : null;
    if (target) perf.clicks.portal = performance.now();
  }, true);
  perf.watch('projects', '[data-testid="sidebar-project-row"]');
  perf.watch('bookmarks', '.portal-bookmark-card');
};

async function openApp(browser) {
  const context = await browser.newContext({viewport: {width: 1440, height: 900}});
  await context.addInitScript(() => {
    try {
      localStorage.setItem('portmanager-setup-wizard-seen-v1', '1');
    } catch {}
  });
  await context.addInitScript(MONITOR);
  const page = await context.newPage();
  const blocked = new Set();
  await page.route('**/*', async route => {
    const request = route.request();
    const u = new URL(request.url());
    if (!u.pathname.startsWith('/api/') && u.hostname === '127.0.0.1') return route.continue();
    if (u.hostname !== '127.0.0.1') { blocked.add(u.hostname); return route.abort(); }
    if (request.method() === 'POST' && ['/api/ports', '/api/ports/merge', '/api/workspace-roots'].includes(u.pathname)) return route.fulfill({json: {success: true}});
    const now = Date.now();
    const values = {
      '/api/ports': PORTS,
      '/api/portal': PORTAL,
      '/api/workspace-roots': [{id: 'root1', name: 'product', path: '/fixture/product'}, {id: 'root2', name: 'other', path: '/fixture/other'}],
      '/api/portal/safety-lease/acquire': {success: true, token: 'a'.repeat(64), metadata: {}, fingerprint: portalLocalMetadataFingerprint({}), expiresInMs: 30000},
      '/api/portal/safety-lease/release': {released: true},
      '/api/health': {status: 'ok'},
      '/api/onboarding/status': {stage: 'complete'},
      '/api/last-visits': Object.fromEntries(PORTS.slice(0, 60).map((p, i) => [p.id, now - i * DAY])),
      '/api/last-git-activity': {},
      '/api/check-ports-batch': {success: true, results: []},
      '/api/voc/access': {blocked: false},
      '/api/browser-profiles': {profiles: []},
      '/api/orca-worktrees': {success: true, worktrees: []},
      '/api/list-git-worktrees': {success: true, worktrees: []},
      '/api/discover-registered-git-worktrees': {success: true, worktrees: [], nextCursor: null},
      '/api/cleanup-stale-worktrees': {success: true, removed: []},
      '/api/client-errors': {ok: true},
    };
    if (Object.hasOwn(values, u.pathname)) return route.fulfill({status: 200, json: values[u.pathname]});
    return route.fulfill({status: 503, json: {error: 'fixture blocked'}});
  });
  return {context, page, blocked};
}

/** 개수가 quietMs 동안 그대로면 「다 그렸다」로 본다. */
async function waitStable(page, key, quietMs = 800, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(k => {
      const w = window.__perf.watches[k];
      return {first: w.first, lastChange: w.lastChange, count: w.count, now: performance.now()};
    }, key);
    if (state.first !== null && state.now - state.lastChange >= quietMs) return state;
    await page.waitForTimeout(100);
  }
  throw new Error(`${key} never became stable`);
}

const longTasksBetween = (tasks, from, to) => {
  const inside = tasks.filter(t => t.start >= from && t.start <= to);
  return {count: inside.length, total: inside.reduce((sum, t) => sum + t.duration, 0), max: inside.reduce((m, t) => Math.max(m, t.duration), 0)};
};

const out = {
  projects: {first: [], all: [], rows: [], longTaskCount: [], longTaskTotal: [], longTaskMax: []},
  bookmarks: {first: [], all: [], cards: [], longTaskCount: [], longTaskTotal: [], longTaskMax: []},
  // 사람이 첫 화면을 잠시 본 뒤 탭을 누르는 경우 — 유휴 미리 데우기(src/lazyTabPreload.ts)가 돌 시간이 있다.
  bookmarksAfterDwell: {first: [], dwellMs: DWELL_MS},
  blocked: [],
};

const browser = await chromium.launch();
try {
  for (let i = 0; i < samples; i += 1) {
    const {context, page, blocked} = await openApp(browser);
    await page.goto(`http://127.0.0.1:${server.port}`);
    await waitStable(page, 'projects');
    await page.waitForTimeout(DWELL_MS);
    await page.locator('#tab-portal').click();
    const bookmarks = await waitStable(page, 'bookmarks');
    const click = await page.evaluate(() => window.__perf.clicks.portal);
    await context.close();
    out.bookmarksAfterDwell.first.push(bookmarks.first - click);
    for (const host of blocked) if (!out.blocked.includes(host)) out.blocked.push(host);
  }
  for (let i = -1; i < samples; i += 1) {
    const {context, page, blocked} = await openApp(browser);
    await page.goto(`http://127.0.0.1:${server.port}`);
    const projects = await waitStable(page, 'projects');
    const projectTasks = await page.evaluate(() => window.__perf.longtasks);
    // 북마크 탭으로 — 클릭 시각은 페이지 안의 capture 리스너가 기록한다.
    await page.locator('#tab-portal').click();
    const bookmarks = await waitStable(page, 'bookmarks');
    const after = await page.evaluate(() => ({tasks: window.__perf.longtasks, click: window.__perf.clicks.portal}));
    await context.close();
    if (i < 0) continue; // 첫 실행은 브라우저·디스크 캐시 데우기
    const p = out.projects, b = out.bookmarks;
    p.first.push(projects.first); p.all.push(projects.lastChange); p.rows.push(projects.count);
    const pt = longTasksBetween(projectTasks, 0, projects.lastChange);
    p.longTaskCount.push(pt.count); p.longTaskTotal.push(pt.total); p.longTaskMax.push(pt.max);
    b.first.push(bookmarks.first - after.click); b.all.push(bookmarks.lastChange - after.click); b.cards.push(bookmarks.count);
    const bt = longTasksBetween(after.tasks, after.click, bookmarks.lastChange);
    b.longTaskCount.push(bt.count); b.longTaskTotal.push(bt.total); b.longTaskMax.push(bt.max);
    for (const host of blocked) if (!out.blocked.includes(host)) out.blocked.push(host);
  }
} finally {
  await browser.close();
  server.stop(true);
}
console.log(JSON.stringify(out));
