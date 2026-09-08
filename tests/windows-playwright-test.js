/**
 * Windows Playwright 테스트 — 포트 관리 프로그램
 *
 * 실행 방법:
 *   1. bun run start  (다른 터미널에서 앱 먼저 실행)
 *   2. npx playwright install chromium  (최초 1회)
 *   3. node tests/windows-playwright-test.js
 *
 * 테스트 항목:
 *   A. API 서버 엔드포인트 (supabase-cli/status, supabase-cli/apikeys)
 *   B. SetupWizard — 추가 단말 등록 → CLI 자동 가져오기
 *   C. SetupWizard — 처음 사용 → CLI 자동 가져오기 (Step 5)
 *   D. Windows 빌드 버튼 UI 존재 확인
 */

const { chromium } = require('playwright');

const APP_URL = 'http://localhost:9000';
const API_URL = 'http://localhost:3001';

let pass = 0, fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✅ [PASS] ${label}${detail ? ' — ' + detail : ''}`);
    pass++;
  } else {
    console.log(`  ❌ [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

(async () => {
  console.log('\n======================================================');
  console.log('  포트 관리 프로그램 — Windows Playwright 테스트');
  console.log('======================================================\n');

  const browser = await chromium.launch({ headless: false, slowMo: 400 });
  const page = await browser.newPage();

  try {
    // ── A. API 엔드포인트 직접 테스트 ──────────────────────────
    console.log('[A] API 서버 엔드포인트 테스트');

    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 10000 });

    const statusRes = await page.evaluate(async (apiUrl) => {
      try {
        const r = await fetch(`${apiUrl}/api/supabase-cli/status`);
        return { status: r.status, body: await r.json() };
      } catch (e) { return { error: e.message }; }
    }, API_URL);

    check('API 서버 응답', !statusRes.error, statusRes.error ?? `HTTP ${statusRes.status}`);
    check('CLI 설치 감지', statusRes.body?.installed === true, statusRes.body?.cliPath ?? 'not found');
    check('CLI 로그인 상태', statusRes.body?.loggedIn === true, statusRes.body?.loggedIn ? '로그인됨' : 'supabase login 필요');

    if (statusRes.body?.projects?.length > 0) {
      const projectNames = statusRes.body.projects.map(p => p.name).join(', ');
      check('프로젝트 목록 조회', true, projectNames);
    }

    // ── B. SetupWizard — 추가 기기 연결 ─────────────────────────
    console.log('\n[B] SetupWizard — 추가 기기 연결 (CLI 자동 가져오기)');

    const settingsBtn = page.getByTitle('초기 설정 마법사');
    check('세팅 버튼 존재', await settingsBtn.isVisible());

    await settingsBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'tests/screenshots/win-01-choose.png' });

    // "추가 기기 연결" 카드 (구: "추가 단말 등록") — div role=button
    await page.locator('text=추가 기기 연결').first().click();
    await page.waitForTimeout(600);

    await page.getByText('다음').click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: 'tests/screenshots/win-02-urlkey.png' });

    const cliReady = await page.getByText('CLI 인증됨').isVisible();
    const cliNotInstalled = await page.getByText('설치되어 있지 않습니다').isVisible();
    const cliNotLoggedIn = await page.getByText('로그인 필요').isVisible();

    check('CLI 상태 표시', cliReady || cliNotInstalled || cliNotLoggedIn,
      cliReady ? 'ready' : cliNotInstalled ? 'not_installed' : 'not_logged_in');
    check('CLI 인증됨', cliReady, cliReady ? '프로젝트 드롭다운 표시' : '설치/로그인 필요');

    if (cliReady) {
      const select = page.locator('select').first();
      const options = await select.locator('option').allInnerTexts();
      const realOptions = options.filter(o => !o.includes('선택'));
      check('프로젝트 드롭다운', realOptions.length > 0, `${realOptions.length}개: ${realOptions.slice(0,2).join(', ')}`);

      if (realOptions.length > 0) {
        await select.selectOption({ index: 1 });
        await page.getByText('자동 입력').click();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'tests/screenshots/win-03-autofill.png' });

        const filled = await page.getByText('자동 입력 완료').isVisible();
        check('자동 입력 완료', filled);

        if (filled) {
          const urlVal = await page.locator('input[placeholder*="supabase.co"]').inputValue();
          check('URL 자동 입력', urlVal.includes('supabase.co'), urlVal);
        }
      }
    }

    // ── C. 처음 사용 → Step 5 CLI 자동 가져오기 ─────────────────
    console.log('\n[C] SetupWizard — 처음 사용 (CLI 자동 가져오기 Step 5)');

    // 닫고 다시 열기
    const closeBtn = page.locator('button[title="닫기 (건너뛰기)"]').or(page.getByText('건너뛰기'));
    if (await closeBtn.first().isVisible()) await closeBtn.first().click();
    await page.waitForTimeout(500);

    await page.getByTitle('초기 설정 마법사').click();
    await page.waitForTimeout(600);
    await page.getByText('처음 사용').click();
    await page.waitForTimeout(600);

    // Step 0~4 빠르게 통과 (각 다음 버튼)
    for (let i = 0; i < 4; i++) {
      const next = page.getByText('다음').first();
      if (await next.isVisible()) { await next.click(); await page.waitForTimeout(400); }
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'tests/screenshots/win-04-step5-apikey.png' });

    const cliAutoFill = page.locator('[class*="violet"]').first();
    check('Step5 CLI 자동 가져오기 영역 표시', await cliAutoFill.isVisible().catch(() => false));

    // ── D. 빌드 버튼 확인 ────────────────────────────────────────
    console.log('\n[D] Windows 빌드 UI 확인');

    // 창 닫기
    const skip = page.getByText('건너뛰기').first();
    if (await skip.isVisible()) await skip.click();
    await page.waitForTimeout(500);

    // 포트 탭으로 전환 → 빌드 버튼 확인 (웹 모드에서만 표시)
    const portsTab = page.getByText('프로젝트 관리');
    if (await portsTab.isVisible()) await portsTab.click();
    await page.waitForTimeout(500);

    // Windows: "Win 빌드" (ko) / "Build Win" (en) — data-help-key로 정확히 찾기
    const winBuildByKey = page.locator('[data-help-key="header-build-windows"]');
    const winBuildVisible = await winBuildByKey.isVisible().catch(() => false);
    check('Windows 빌드 버튼 (Win 빌드)', winBuildVisible);

    // macOS 전용 버튼은 없어야 함
    const appBuildHidden = !(await page.getByText('앱 빌드').isVisible().catch(() => false));
    const dmgHidden = !(await page.locator('button', { hasText: /^DMG$/ }).isVisible().catch(() => false));
    check('앱 빌드 버튼 숨김 (macOS 전용)', appBuildHidden);
    check('DMG 버튼 숨김 (macOS 전용)', dmgHidden);

    await page.screenshot({ path: 'tests/screenshots/win-05-build.png' });

  } catch (e) {
    console.log(`\n❌ 테스트 중 오류: ${e.message}`);
    fail++;
  }

  // ── 결과 요약 ───────────────────────────────────────────────
  console.log('\n======================================================');
  console.log(`  결과: PASS ${pass} / FAIL ${fail} / TOTAL ${pass + fail}`);
  console.log('======================================================');
  if (fail === 0) {
    console.log('  🎉 모든 테스트 통과!');
  } else {
    console.log('  ⚠️  실패 항목 확인 후 조치 필요');
    console.log('  스크린샷: tests/screenshots/win-*.png');
  }
  console.log('');

  await page.waitForTimeout(2000);
  await browser.close();
})();
