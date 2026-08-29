/**
 * 실제 사용자 회귀: 배율 hit-test, 배포본 선택, localhost 실행 게이트, VOC 빠른 드래그.
 *
 * 실행: bun tests/e2e/core-user-flows.spec.ts
 * 전제: http://localhost:9000 개발 서버
 */
import { chromium, type BrowserContext, type Page } from 'playwright';

const LOCAL_URL = process.env.LOCAL_URL ?? 'http://localhost:9000';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
  console.log(`✓ ${message}`);
}

const projects = [
  { id: 'stopped', name: '중지 프로젝트', port: 4101, folderPath: '/tmp/stopped', isRunning: true },
  { id: 'running', name: '실행 프로젝트', port: 4102, folderPath: '/tmp/running', isRunning: false },
  { id: 'no-port', name: '포트 없는 프로젝트', folderPath: '/tmp/no-port', isRunning: false },
];

async function installRoutes(context: BrowserContext) {
  await context.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    if (url.pathname === '/api/ports') {
      return json(request.method() === 'GET' ? projects : { success: true });
    }
    if (url.pathname === '/api/portal') {
      return json({
        _hostname: 'core-user-e2e',
        items: [
          { id: 'auto:deploy:shared-only', name: '공유 배포본', type: 'web', url: 'https://shared.example.test/app' },
        ],
      });
    }
    if (url.pathname === '/api/check-ports-batch') {
      return json({
        success: true,
        results: [
          { port: 4101, isRunning: false },
          { port: 4102, isRunning: true },
        ],
      });
    }
    if (url.pathname === '/api/browser-profiles') return json({ success: true, profiles: [] });
    if (url.pathname === '/api/workspace-roots') return json([]);
    if (url.pathname === '/api/last-visits' || url.pathname === '/api/last-git-activity') return json({});
    if (url.pathname === '/api/project-memory/hermes-adapter') return json({ hermesCliPath: null });
    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        service: 'agentstoz-api',
        schemaVersion: 10,
        capabilities: [
          'project-memory.resolve-project', 'project-memory.recall', 'project-memory.thread-binding',
          'project-memory.thread-create', 'project-memory.thread-create-project',
          'project-memory.thread-sync', 'supabase.native-pkce',
        ],
      });
    }
    return json({ success: true, results: [] });
  });
}

async function openApp(context: BrowserContext, zoom: number, viewport = { width: 1280, height: 800 }): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.addInitScript(({ selectedZoom }) => {
    localStorage.setItem('portmanager-setup-wizard-seen-v1', '1');
    localStorage.setItem('portmanager-ui-zoom', String(selectedZoom));
    localStorage.removeItem('pm-guide-mode');
    (window as any).__openedUrls = [];
    window.open = ((url?: string | URL) => {
      (window as any).__openedUrls.push(String(url ?? ''));
      return null;
    }) as typeof window.open;
  }, { selectedZoom: zoom });
  await page.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.locator('[data-testid="header-ui-zoom"]').waitFor({ state: 'visible', timeout: 10_000 });
  return page;
}

async function testZoomHitTargets(context: BrowserContext) {
  const cases = [
    { zoom: 0.8, width: 1280, height: 800 },
    { zoom: 1, width: 1280, height: 800 },
    { zoom: 1.25, width: 1280, height: 800 },
    { zoom: 1.6, width: 1280, height: 800 },
    { zoom: 2, width: 1280, height: 800 },
    { zoom: 2.4, width: 900, height: 700 },
  ];

  for (const item of cases) {
    const page = await openApp(context, item.zoom, { width: item.width, height: item.height });
    try {
      await page.locator('[data-testid="header-ui-zoom"]').waitFor({ state: 'visible' });
      const shown = Number(await page.locator('[data-testid="header-ui-zoom"]').getAttribute('data-zoom'));
      assert(shown === item.zoom, `${Math.round(item.zoom * 100)}% 저장 배율 적용`);

      const geometry = await page.evaluate(() => {
        const root = document.getElementById('root')!;
        const rect = root.getBoundingClientRect();
        const mainHeader = document.querySelector('[data-testid="project-main-header"]')?.getBoundingClientRect();
        const newProject = document.querySelector('[data-testid="header-new-project"]')?.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          chromeBottom: mainHeader?.bottom ?? 0,
          headerLeft: mainHeader?.left ?? 0,
          headerRight: mainHeader?.right ?? 0,
          newProjectLeft: newProject?.left ?? -1,
          newProjectRight: newProject?.right ?? -1,
        };
      });
      assert(Math.abs(geometry.left) < 1 && Math.abs(geometry.top) < 1, `${Math.round(item.zoom * 100)}% 화면 원점 유지`);
      assert(geometry.width <= geometry.viewportWidth + 1, `${Math.round(item.zoom * 100)}% 루트가 가로 화면을 넘지 않음`);
      assert(geometry.height <= geometry.viewportHeight + 1, `${Math.round(item.zoom * 100)}% 루트가 세로 화면을 넘지 않음`);
      assert(geometry.chromeBottom <= geometry.viewportHeight * 0.55, `${Math.round(item.zoom * 100)}% 도구줄 아래 프로젝트 공간 유지`);
      assert(geometry.newProjectLeft >= geometry.headerLeft - 1 && geometry.newProjectRight <= geometry.headerRight + 1,
        `${Math.round(item.zoom * 100)}% New project 버튼이 헤더 안에 완전히 표시`);

      await page.locator('[data-testid="header-new-project"]').click({ timeout: 5_000 });
      await page.getByRole('heading', { name: '프로젝트 추가' }).locator('..').getByRole('button').click();
      assert(true, `${Math.round(item.zoom * 100)}% New project 실제 hit-test 통과`);

      // Playwright의 실제 pointer click을 사용한다. CSS zoom 회귀에서는 이 클릭을
      // <html>이 가로채 timeout이 났다.
      await page.locator('[data-testid="header-ui-zoom-reset"]').click({ timeout: 5_000 });
      await page.locator('[data-testid="header-ui-zoom"][data-zoom="1.25"]').waitFor({ state: 'visible', timeout: 5_000 });
      assert(true, `${Math.round(item.zoom * 100)}% 실제 버튼 hit-test 통과`);
    } finally {
      await page.close();
    }
  }
}

async function testDeploymentAndLocalhost(context: BrowserContext) {
  const page = await openApp(context, 1.25);
  try {
    await page.locator('[data-testid="sidebar-project-row"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    const stopped = page.locator('[data-testid="sidebar-open-localhost"][data-project-id="stopped"]');
    const running = page.locator('[data-testid="sidebar-open-localhost"][data-project-id="running"]');
    await page.waitForFunction(() => {
      const a = document.querySelector('[data-testid="sidebar-open-localhost"][data-project-id="stopped"]') as HTMLButtonElement | null;
      const b = document.querySelector('[data-testid="sidebar-open-localhost"][data-project-id="running"]') as HTMLButtonElement | null;
      return a?.disabled === false && b?.disabled === false;
    });
    assert(await stopped.isEnabled(), '실행 상태 미감지여도 등록된 localhost 주소는 활성');
    assert(await running.isEnabled(), '실제 실행 중인 포트의 localhost 버튼 활성');
    await stopped.click();
    await running.click();
    assert((await page.evaluate(() => (window as any).__openedUrls as string[])).includes('http://localhost:4101'), '중지 상태로 관측된 localhost도 사용자가 직접 열 수 있음');
    assert((await page.evaluate(() => (window as any).__openedUrls as string[])).includes('http://localhost:4102'), '실행 중 localhost를 기본 브라우저로 엶');

    await page.getByText('포트 없는 프로젝트', { exact: true }).first().click();
    const noPortBrowser = page.locator('[data-testid="detail-browser-localhost"]');
    assert(await noPortBrowser.isDisabled(), '주소 자체가 없는 프로젝트만 미리보기 버튼 비활성');
    await page.locator('[data-testid="local-preview-auto-port"]').click();
    await page.waitForFunction(() => !(document.querySelector('[data-testid="detail-browser-localhost"]') as HTMLButtonElement | null)?.disabled);
    assert(await noPortBrowser.isEnabled(), '빈 포트 자동 설정 직후 로컬 미리보기 활성');

    const deploy = page.locator('[data-testid="deployment-open-selected"]');
    await deploy.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !(document.querySelector('[data-testid="deployment-open-selected"]') as HTMLButtonElement | null)?.disabled);
    assert(await deploy.isEnabled(), '로컬 deployUrl이 없어도 공유 포털 배포본으로 헤더 버튼 활성');
    await deploy.click();
    const choice = page.locator('[data-testid="deployment-open-picker-item"]', { hasText: '공유 배포본' });
    await choice.waitFor({ state: 'visible' });
    await choice.click();
    assert((await page.evaluate(() => (window as any).__openedUrls as string[])).includes('https://shared.example.test/app'), '공유 배포본 선택 후 열기 실행');
  } finally {
    await page.close();
  }
}

async function testVocFastDrag(context: BrowserContext) {
  for (const zoom of [0.8, 1.25, 2]) {
    const page = await openApp(context, zoom);
    try {
      await page.locator('[data-testid="voc-toggle"]').click();
      await page.locator('[data-testid="voc-banner"]').waitFor({ state: 'visible' });

      // steps 없이 빠르게 놓아 React state commit 전 pointerup도 영역으로 잡히는지 확인.
      await page.mouse.move(160, 120);
      await page.mouse.down();
      await page.mouse.move(410, 260);
      await page.mouse.up();
      await page.locator('[data-testid="voc-form"]').waitFor({ state: 'visible', timeout: 5_000 });
      const region = (await page.locator('[data-testid="voc-region-contains"]').textContent()) ?? '';
      assert(region.includes('250×140px'), `${Math.round(zoom * 100)}% VOC 빠른 정방향 드래그 좌표 정확`);

      await page.locator('[data-testid="voc-repick"]').click();
      await page.mouse.move(430, 310);
      await page.mouse.down();
      await page.mouse.move(230, 180);
      await page.mouse.up();
      await page.locator('[data-testid="voc-form"]').waitFor({ state: 'visible', timeout: 5_000 });
      const reverse = (await page.locator('[data-testid="voc-region-contains"]').textContent()) ?? '';
      assert(reverse.includes('200×130px'), `${Math.round(zoom * 100)}% VOC 역방향 드래그 좌표 정확`);
    } finally {
      await page.close();
    }
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true, timeout: 20_000 });
  const context = await browser.newContext();
  await installRoutes(context);
  let failed = false;
  const run = async (name: string, task: () => Promise<void>) => {
    console.log(`\n─── ${name} ───`);
    try {
      await task();
      console.log(`✅ ${name} PASS`);
    } catch (error) {
      failed = true;
      console.error(`❌ ${name} FAIL:`, error instanceof Error ? error.message : error);
    }
  };

  await run('Zoom hit targets', () => testZoomHitTargets(context));
  await run('Deployment and localhost', () => testDeploymentAndLocalhost(context));
  await run('VOC fast drag', () => testVocFastDrag(context));
  await context.close();
  await browser.close();
  if (failed) process.exit(1);
}

if (import.meta.main && process.env.NODE_ENV !== 'test') {
  main().catch(error => {
    console.error('❌ E2E RUNNER CRASHED:', error);
    process.exit(1);
  });
}
