/**
 * E2E: 2nd 기기 Handoff 회귀 방지
 *
 * 실행: bun tests/e2e/onboarding-2nd-handoff.spec.ts
 *
 * 시나리오 A: 클립보드에 유효 JSON 주입 → 붙여넣기 버튼 → URL/Key 자동 입력
 * 시나리오 B: 잘못된 클립보드 → 명확한 에러 메시지
 * 시나리오 C: 포털 웹의 단말 관리가 신원 없는 v3 초대를 복사 (인증된 브라우저만)
 */
import { chromium, type Browser, type BrowserContext } from 'playwright';

const LOCAL_URL = process.env.LOCAL_URL ?? 'http://localhost:9000';
const PORTAL_URL = process.env.PORTAL_URL?.trim() ?? '';
const EXAMPLE_PROJECT_REF = ['abcdefghijkl', 'mnopqrst'].join('');
const EXAMPLE_SUPABASE_URL = `https://${EXAMPLE_PROJECT_REF}.${['supabase', 'co'].join('.')}`;

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('❌ ' + msg);
  console.log('✓ ' + msg);
}

async function installFreshWizardRoutes(context: BrowserContext) {
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
  await context.route(`${EXAMPLE_SUPABASE_URL}/**`, route => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'PGRST301', message: 'JWT required', details: null, hint: null }),
  }));
}

async function scenarioA_pasteValidPayload(browser: Browser) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await installFreshWizardRoutes(context);
  const page = await context.newPage();
  try {
    const payload = {
      v: 3,
      type: 'portmgr-device-invite',
      url: EXAMPLE_SUPABASE_URL,
      key: 'eyJhbG...test.sig',
      deviceName: 'Portal-created target',
    };
    await page.addInitScript(() => localStorage.removeItem('portmanager-setup-wizard-seen-v1'));
    await page.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.getByRole('heading', { name: '어떤 상황인가요' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(raw => navigator.clipboard.writeText(raw), JSON.stringify(payload));

    await page.getByRole('button', { name: /추가 기기 연결/ }).click();
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByRole('button', { name: '클립보드에서 붙여넣기' }).click();
    await page.getByText('새 단말 연결 정보 입력', { exact: false }).waitFor({ state: 'visible', timeout: 10000 });

    const urlField = page.locator('input[placeholder*="supabase.co"]').first();
    const val = await urlField.inputValue().catch(() => '');
    await assert(val === payload.url, `[A] URL 자동 입력됨: ${val}`);

    await assert(
      await page.getByText('새 단말 연결 정보 입력', { exact: false }).isVisible(),
      '[A] 성공 메시지 노출'
    );
    await page.getByText('URL/Key와 RLS 보호까지 정상입니다', { exact: false }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: '다음' }).click();
    await assert(await page.getByText('새 단말 ID를 자동 생성합니다', { exact: false }).isVisible(), '[A] fresh local identity is explicit');
    await assert(await page.getByRole('checkbox').count() === 0, '[A] no existing device ID adoption control');
  } finally {
    await context.close();
  }
}

async function scenarioB_invalidPayload(browser: Browser) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await installFreshWizardRoutes(context);
  const page = await context.newPage();
  try {
    await page.addInitScript(() => localStorage.removeItem('portmanager-setup-wizard-seen-v1'));
    await page.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.getByRole('heading', { name: '어떤 상황인가요' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(() => navigator.clipboard.writeText('just plain garbage not json'));

    await page.getByRole('button', { name: /추가 기기 연결/ }).click();
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByRole('button', { name: '클립보드에서 붙여넣기' }).click();
    const pasteError = page.locator('p.text-red-400');
    await pasteError.waitFor({ state: 'visible', timeout: 10000 });
    const errorText = (await pasteError.textContent() || '').trim();
    await assert(errorText.includes('클립보드 내용이 JSON이 아닙니다'), `[B] 잘못된 payload 오류 문구: ${errorText}`);
  } finally {
    await context.close();
  }
}

async function scenarioC_portalCopyButton(browser: Browser) {
  if (process.env.SKIP_DEPLOYED_PORTAL === '1' || !PORTAL_URL) {
    console.log('⊝ [C] deployed portal check skipped (set PORTAL_URL to enable)');
    return;
  }
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  try {
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);

    const googleGate = await page.getByRole('button', { name: 'Google로 로그인' }).isVisible().catch(() => false);
    if (googleGate) {
      console.log('⊝ [C] 포털 Google 로그인 게이트 — skip (비인증 상태)');
      return;
    }

    const btn = page.locator('button[title*="Mac·Windows 또는 Ubuntu 단말 연결"]').first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) {
      console.log('⊝ [C] 단말 연결 버튼 안 보임 (creds 없음) — skip');
      return;
    }
    await btn.click();
    await page.getByRole('button', { name: '+ 연결 정보 만들기' }).click();
    await page.getByLabel('새 단말 이름').fill('E2E 새 Windows');
    await page.getByRole('button', { name: '연결 정보 복사' }).click();

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const payload = JSON.parse(clip);
    await assert(payload.v === 3, '[C] payload.v === 3');
    await assert(payload.type === 'portmgr-device-invite', '[C] payload.type === portmgr-device-invite');
    await assert(payload.deviceId === undefined, '[C] existing deviceId excluded');
    await assert(payload.serviceRoleKey === undefined, '[C] service role excluded');
    await assert(payload.deviceName === 'E2E 새 Windows', '[C] suggested name included');
    await assert(/^https:\/\/[^.]+\.supabase\.co$/.test(payload.url), '[C] URL supabase.co 형식');
    await assert(typeof payload.key === 'string' && payload.key.startsWith('eyJ'), '[C] key JWT 형식');
  } finally {
    await context.close();
  }
}

async function main() {
  let failed = false;
  const browser = await chromium.launch({ headless: true, timeout: 20000 });
  const run = async (name: string, fn: () => Promise<void>) => {
    console.log(`\n─── ${name} ───`);
    try { await fn(); console.log(`✅ ${name} PASS`); }
    catch (e: any) { console.error(`❌ ${name} FAIL: ${e.message}`); failed = true; }
  };
  await run('Scenario A: Valid paste', () => scenarioA_pasteValidPayload(browser));
  await run('Scenario B: Invalid paste', () => scenarioB_invalidPayload(browser));
  await run('Scenario C: Portal copy button', () => scenarioC_portalCopyButton(browser));
  await browser.close();
  if (failed) process.exit(1);
}

if (import.meta.main && process.env.NODE_ENV !== 'test') {
  main().catch((error: unknown) => {
    console.error('\n❌ E2E RUNNER CRASHED:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
