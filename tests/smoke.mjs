/**
 * 스모크 테스트 — 핵심 경로만 빠르게 확인.
 * 사용: `node tests/smoke.mjs`
 *
 * 옵션 환경변수:
 *   TARGET=local   → http://localhost:9000 (기본)  — 로컬 App.tsx 전체 (ports + portal)
 *   TARGET=vercel  → https://portmanager-portal.vercel.app — 포털 전용
 *   TARGET=<url>   → 임의 URL (자동 감지)
 *   VIEWPORT=mobile → 375x812 (iPhone SE 세로)
 *   API_PORT=3101  → 격리된 로컬 API 포트 (기본 3001)
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { classifySmokeTarget } from './smoke-target.mjs';

const API_PORT = Number(process.env.API_PORT) || 3001;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const contextApiContract = JSON.parse(
  readFileSync(new URL('../context-api-contract.json', import.meta.url), 'utf8'),
);

const TARGET = process.env.TARGET === 'vercel'
  ? 'https://portmanager-portal.vercel.app'
  : process.env.TARGET && process.env.TARGET.startsWith('http')
    ? process.env.TARGET
    : 'http://localhost:9000';

const { isLocalFullApp, isPortalOnly } = classifySmokeTarget(TARGET);
const isMobileViewport = process.env.VIEWPORT === 'mobile';
const viewport = isMobileViewport ? { width: 375, height: 812 } : { width: 1280, height: 800 };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  console.log(`\n▶ Smoke test against ${TARGET} (${viewport.width}x${viewport.height})\n`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport, isMobile: isMobileViewport });
  const page = await ctx.newPage();
  // 이 스모크는 초기 설정 마법사가 아닌 일반 프로젝트 관리 화면을 검증한다.
  // 매번 새 브라우저 컨텍스트에서 wizard overlay가 뒤늦게 떠 UI 클릭을 가로막지 않게 한다.
  await page.addInitScript(() => localStorage.setItem('portmanager-setup-wizard-seen-v1', 'true'));

  try {
    if (isLocalFullApp) {
      // 새 프로젝트 옵션을 실제 생성 없이 검증한다. App은 GET으로 읽은 루트를 상태에
      // 반영한 직후 POST로 자동 저장하므로, 읽기만 mock하고 쓰기를 실제 API로 보내면
      // `smoke-root` fixture가 사용자의 workspace-roots.json을 오염시킨다.
      // smoke-workspace-roots:start
      await page.route('**/api/workspace-roots', async route => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([{ id: 'smoke-root', name: 'Smoke', path: process.cwd() }]),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true }),
          });
        }
      });
      // smoke-workspace-roots:end
      // 로컬이 원격보다 최신인 상태를 고정해 Push 안내를 결정적으로 검증한다.
      await page.route('**/api/project-memory/remote-status', async route => {
        const body = route.request().postDataJSON();
        if (body?.folderPath === process.cwd()) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              exists: true,
              revisionId: 'smoke-remote-revision',
              createdAt: '2000-01-01T00:00:00.000Z',
              contentHash: 'smoke-remote-content',
              inSync: false,
            }),
          });
        } else {
          await route.continue();
        }
      });
    }
    const res = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 20000 });
    check('page loads 2xx/3xx', !!res && res.status() < 400, `status ${res?.status()}`);

    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // 가로 오버플로우 체크 — scrollWidth > clientWidth 면 UI 잘림
    if (isMobileViewport) {
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      check(
        `Mobile: 가로 오버플로우 없음 (scrollWidth ${overflow.scrollWidth} ≤ clientWidth ${overflow.clientWidth})`,
        overflow.scrollWidth <= overflow.clientWidth + 1, // 1px 여유
      );
    }
    const bodyText = await page.locator('body').innerText().catch(() => '');

    if (isPortalOnly) {
      // Deployment/preview = portal-main.tsx only (북마크 전용 앱, 비밀번호 가드 가능)
      const passwordGate = bodyText.includes('비밀번호') && bodyText.includes('입장');
      if (passwordGate) {
        check('Portal: 비밀번호 게이트 정상 렌더', true, '비밀번호 보호 활성');
        check('Portal: "프로젝트 추가" 버튼 없음 (포털 전용)',
          await page.getByRole('button', { name: /프로젝트 추가/ }).count() === 0);
      } else {
        check('Portal: 북마크 헤더 노출', bodyText.includes('북마크') || bodyText.includes('Bookmarks'));
        check('Portal: "프로젝트 추가" 버튼 없음 (포털 전용)',
          await page.getByRole('button', { name: /프로젝트 추가/ }).count() === 0);
      }
    } else if (isLocalFullApp) {
      const addBtn = await page.getByRole('button', { name: /프로젝트 추가|New project/ }).count();
      check('Local: 프로젝트 추가 버튼 노출', addBtn > 0);
      const worktreeButtons = page.locator('button[data-help-key="card-worktree"]');
      if (await worktreeButtons.count() > 0) {
        const worktreePressedStates = await worktreeButtons.evaluateAll(buttons =>
          buttons.map(button => button.getAttribute('aria-pressed'))
        );
        check('Local: 워크트리 버튼 기본 ON',
          worktreePressedStates.includes('true'));
      }

      if (addBtn > 0) {
        await page.getByRole('button', { name: /프로젝트 추가|New project/ }).first().click();
        await page.waitForTimeout(500);
        check('Local: "기존 폴더 등록" 탭', await page.getByRole('button', { name: /기존 폴더 (연결|등록)/ }).count() > 0);
        check('Local: "새 폴더 만들기" 탭', await page.getByRole('button', { name: /새 폴더 만들기/ }).count() > 0);
        await page.getByRole('button', { name: /기존 폴더 (연결|등록)/ }).click();
        await page.getByLabel('폴더 경로').fill(process.cwd());
        const existingGitSelect = page.getByLabel('Git 저장소');
        await existingGitSelect.locator('option[value="keep"]').waitFor({ state: 'attached', timeout: 10000 });
        check('Local: 기존 Git 저장소 유지 선택지', await existingGitSelect.locator('option[value="keep"]').count() > 0);
        check('Local: Git 초기화 후 다시 만들기 선택지', await existingGitSelect.locator('option[value="reinitialize"]').count() > 0);
        const existingRunCheckbox = page.getByLabel('등록 후 프로젝트 실행');
        check('Local: 기존 프로젝트 등록 후 실행 기본 OFF (임의 실행 방지)', !(await existingRunCheckbox.isChecked()));
        check('Local: 기존 프로젝트 장기기억 자동 감지 UI', await page.getByText('프로젝트 장기기억', { exact: true }).count() > 0);
        const memorySyncStatus = page.getByTestId('project-memory-sync-status');
        const memorySyncText = (await memorySyncStatus.textContent().catch(() => '') || '').trim();
        check('Local: 장기기억 동기화 상태를 표시', memorySyncText.length > 0, memorySyncText);
        const memoryStateAnchor = page.locator(
          '[data-testid="project-memory-create-primary"], [data-testid="project-memory-restore-primary"], [data-testid="project-memory-id-copy"]',
        );
        check(
          'Local: 장기기억 상태에 맞는 생성·복원 또는 기존 기억 ID 제공',
          await memoryStateAnchor.count() === 1,
        );
        const memoryFeatureVersion = (await page.getByTestId('project-memory-feature-version').textContent().catch(() => '') || '').trim();
        check('Local: 장기기억 기능 버전 표시', /^v\d+$|^v\d+ → v\d+$/.test(memoryFeatureVersion), memoryFeatureVersion);
        await existingRunCheckbox.check();
        check('Local: 기존 프로젝트 실행 옵션 선택 가능', await existingRunCheckbox.isChecked());
        await page.getByRole('button', { name: /새 폴더 만들기/ }).click();
        await page.waitForTimeout(300);
        check('Local: 새 프로젝트 입력 UI 노출', await page.getByPlaceholder('my-project').count() > 0);

        const gitCheckbox = page.getByLabel('Git 저장소 만들기');
        const runCheckbox = page.getByLabel('생성 후 프로젝트 실행');
        const memoryCheckbox = page.getByLabel('처음부터 프로젝트 장기기억 사용');
        const memoryBackupCheckbox = page.getByLabel('Supabase 백업');
        check('Local: Git 저장소 만들기 기본 ON', await gitCheckbox.isChecked());
        check('Local: 생성 후 프로젝트 실행 기본 OFF (임의 실행 방지)', !(await runCheckbox.isChecked()));
        check('Local: 새 프로젝트 장기기억 기본 ON', await memoryCheckbox.isChecked());
        check('Local: 새 프로젝트 장기기억 Supabase 백업 기본 ON', await memoryBackupCheckbox.isChecked());
        await gitCheckbox.uncheck();
        await runCheckbox.check();
        check('Local: Git/실행 옵션 변경 가능',
          !(await gitCheckbox.isChecked()) && await runCheckbox.isChecked());
        await page.keyboard.press('Escape').catch(() => {});
      }

      // api-server health
      try {
        const apiRes = await page.request.get(`${API_BASE}/api/health`);
        const health = await apiRes.json().catch(() => null);
        const capabilities = new Set(health?.capabilities || []);
        const missing = contextApiContract.requiredCapabilities
          .filter(capability => !capabilities.has(capability));
        const healthy = apiRes.status() === 200
          && health?.service === 'agentstoz-api'
          && health?.schemaVersion >= contextApiContract.schemaVersion
          && missing.length === 0;
        check(
          `Local: api-server :${API_PORT} schema/capability 계약`,
          healthy,
          healthy ? `schema ${health.schemaVersion}` : `missing ${missing.join(', ') || 'valid health'}`,
        );
      } catch (error) {
        check(
          `Local: api-server :${API_PORT} schema/capability 계약`,
          false,
          error instanceof Error ? error.message : 'api-server not running',
        );
      }
    } else {
      check(`unknown target ${TARGET}`, true, 'skipping mode-specific checks');
    }
  } catch (e) {
    check('no exceptions during smoke', false, e.message);
  } finally {
    await browser.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\nResult: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('Failed:');
    failed.forEach(f => console.log(`  - ${f.name} (${f.detail})`));
    process.exit(1);
  }
})();
