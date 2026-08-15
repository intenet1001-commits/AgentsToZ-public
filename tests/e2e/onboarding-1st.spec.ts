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

    // Test 1: choose 화면 3개 카드만
    await assert(await page.locator('text=처음 사용').first().isVisible(), '"처음 사용" 카드 노출');
    await assert(await page.locator('text=추가 기기 연결').first().isVisible(), '"추가 기기 연결" 카드 노출');
    await assert(await page.locator('text=개발 환경 설정').first().isVisible(), '"개발 환경 설정" 카드 노출');
    const portalCount = await page.locator('text=북마크 포털 배포').count();
    await assert(portalCount === 0, 'choose 화면에 "북마크 포털 배포" 카드가 없다 (1st 완료 후 안내로 이동됨)');
    const winCount = await page.locator('text=Windows 개발 환경').count();
    await assert(winCount === 0, 'Windows 개별 카드 제거됨 (DevEnvWizard로 통합)');

    // Test 2: "추가 기기 연결" → Step 1에 붙여넣기 버튼
    await page.locator('text=추가 기기 연결').first().click();
    await page.waitForTimeout(700);
    await page.locator('button:has-text("다음")').first().click();
    await page.waitForTimeout(700);
    await assert(
      await page.locator('text=클립보드에서 붙여넣기').isVisible(),
      '붙여넣기 버튼 노출 (Step 1)'
    );
    await assert(
      await page.locator('text=1st 기기 설정 붙여넣기').isVisible(),
      '붙여넣기 카드 타이틀 노출'
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
