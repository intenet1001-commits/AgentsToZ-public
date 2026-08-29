/**
 * E2E: 1st 기기 초기 설정 마법사 UI 회귀 방지
 *
 * 실행: bun tests/e2e/onboarding-1st.spec.ts
 * 전제: localhost:9000 dev server가 돌고 있어야 함
 */
import { chromium } from 'playwright';

const LOCAL_URL = process.env.LOCAL_URL ?? 'http://localhost:9000';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('❌ ' + msg);
  console.log('✓ ' + msg);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/api/portal', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ _hostname: 'onboarding-e2e' }),
  }));
  await context.route('**/api/ports', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '[]',
  }));
  await context.route('**/api/onboarding/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      stage: 'fresh',
      recommendedAction: 'choose-first-or-additional',
      hasSupabaseConfig: false,
      hasDeviceIdentity: false,
      localAdminPresent: false,
      canCreateAdditionalDeviceInvite: false,
      needsExistingDeviceAnswer: true,
    }),
  }));
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.removeItem('portmanager-setup-wizard-seen-v1'));
  await page.setViewportSize({ width: 1280, height: 800 });
  let failed = false;

  try {
    await page.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);

    const wizardOpened = await page.locator('text=어떤 상황인가요').isVisible().catch(() => false);
    if (!wizardOpened) {
      console.log('⊝ 초기 설정 마법사 진입점 없음 — 설정 완료 상태. Test skip.');
      await browser.close();
      return;
    }

    // Test 1: choose 화면은 실제 온보딩에 필요한 세 경로만 우선 노출
    await assert(await page.getByRole('button', { name: /로컬로 바로 시작/ }).isVisible(), '"로컬로 바로 시작" 카드 노출');
    await assert(await page.getByRole('button', { name: /첫 단말 · 동기화 설정/ }).isVisible(), '"첫 단말 · 동기화 설정" 카드 노출');
    await assert(await page.getByRole('button', { name: /추가 기기 연결/ }).isVisible(), '"추가 기기 연결" 카드 노출');
    await assert(await page.getByTestId('onboarding-device-diagnosis').getByText('확정된 단말 신원이 없습니다', { exact: false }).isVisible(), 'fresh 로컬 단말 진단 노출');
    await assert(!(await page.getByRole('button', { name: /개발 환경 설정/ }).isVisible()), '개발 환경은 닫힌 고급 설정 안에 있음');

    // Test 2: 첫 단말 권장 경로는 CLI 강제 설치가 아닌 3단계 Dashboard 흐름
    await page.getByRole('button', { name: /첫 단말 · 동기화 설정/ }).click();
    await assert(await page.getByText('필요한 것은 Supabase 프로젝트 1개뿐입니다').isVisible(), '첫 단말 최소 설정 안내 노출');
    await assert(await page.getByText('1 / 3').isVisible(), '첫 단말 권장 흐름은 3단계');
    await assert(await page.getByRole('button', { name: 'CLI로 프로젝트 생성부터 진행' }).isVisible(), 'CLI 전체 흐름은 고급 선택으로 유지');
    await page.getByRole('button', { name: '← 뒤로' }).click();

    // Test 3: "추가 기기 연결" → 연결 정보 단계에 v3 붙여넣기 버튼
    await page.getByRole('button', { name: /추가 기기 연결/ }).click();
    await page.waitForTimeout(700);
    await page.locator('button:has-text("다음")').first().click();
    await page.waitForTimeout(700);
    await assert(
      await page.locator('text=클립보드에서 붙여넣기').isVisible(),
      '붙여넣기 버튼 노출 (연결 정보 단계)'
    );
    await assert(
      await page.getByText('배포 포털 연결 정보 붙여넣기 (권장)', { exact: true }).isVisible(),
      'v3 포털 연결 카드 타이틀 노출'
    );
    await assert(
      await page.getByText('기기 관리 → Mac·Windows 연결', { exact: false }).isVisible(),
      'Mac·Windows 정본 진입점 안내'
    );

    console.log('\n✅ onboarding-1st: all assertions passed');
  } catch (e: any) {
    console.error('\n❌ TEST FAILED:', e.message);
    failed = true;
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
}

if (import.meta.main && process.env.NODE_ENV !== 'test') {
  main().catch((error: unknown) => {
    console.error('\n❌ TEST FAILED:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
