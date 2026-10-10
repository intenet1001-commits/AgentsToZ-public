/**
 * 실제 로컬 UI + 실제 API 파일 검증으로 상세 수정의 경로 필드 네 개를 확인한다.
 * 저장 버튼은 누르지 않고 Escape로 취소하므로 사용자 ports.json은 바꾸지 않는다.
 *
 * 실행: bun tests/e2e/edit-path-fields.spec.ts
 * 전제: http://127.0.0.1:9000 Vite, http://127.0.0.1:3001 AgentsToZ API
 */
import { chromium, type Locator, type Page } from 'playwright';

const LOCAL_URL = process.env.LOCAL_URL ?? 'http://127.0.0.1:9000';
const PROJECT_PATH = process.env.PROJECT_PATH ?? '/Users/cs-work/forcs/AgentsToZ_byCS';
const COMMAND_PATH = `${PROJECT_PATH}/실행.command`;
const DOCUMENT_PATH = `${PROJECT_PATH}/README.md`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
  console.log(`✓ ${message}`);
}

async function dropPlainPath(page: Page, target: Locator, path: string) {
  await target.evaluate((element, droppedPath) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', droppedPath);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  }, path);
}

async function main() {
  const browser = await chromium.launch({ headless: true, timeout: 20_000 });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => {
      localStorage.setItem('portmanager-setup-wizard-seen-v1', '1');
      localStorage.setItem('portmanager-ui-zoom', '1.25');
    });
    await page.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    const projectRow = page.locator(`[data-testid="sidebar-project-row"][data-folder-path="${PROJECT_PATH}"]`).first();
    await projectRow.waitFor({ state: 'visible', timeout: 15_000 });
    await projectRow.getByText('AgentsToZ_byCS', { exact: true }).click();
    await page.waitForTimeout(200);
    await page.locator('h2', { hasText: 'AgentsToZ_byCS' }).waitFor({ state: 'visible', timeout: 8_000 });
    await page.getByTestId('detail-edit-project').click();

    const cases = [
      ['edit-command-file-field', COMMAND_PATH, COMMAND_PATH, '실행 파일'],
      ['edit-folder-field-detail', PROJECT_PATH, PROJECT_PATH, '프로젝트 폴더'],
      ['edit-manual-file-field-detail', DOCUMENT_PATH, DOCUMENT_PATH, '매뉴얼'],
      ['edit-log-file-field-detail', DOCUMENT_PATH, DOCUMENT_PATH, '로그 관리'],
    ] as const;

    for (const [testId, droppedPath, expectedValue, label] of cases) {
      const field = page.getByTestId(testId);
      await field.waitFor({ state: 'visible' });
      await dropPlainPath(page, field, droppedPath);
      const input = field.locator('input');
      await input.waitFor({ state: 'visible' });
      await page.waitForFunction(
        ({ id, value }) => (document.querySelector(`[data-testid="${id}"] input`) as HTMLInputElement | null)?.value === value,
        { id: testId, value: expectedValue },
        { timeout: 8_000 },
      );
      assert(await input.inputValue() === expectedValue, `${label} 드롭 → 절대경로 검증 및 입력`);
    }

    // 직접 타이핑도 다른 형제 필드와 같은 규칙으로 동작해야 한다.
    const manualInput = page.getByTestId('edit-manual-file-field-detail').locator('input');
    await manualInput.fill(`${PROJECT_PATH}/README.md`);
    assert(await manualInput.inputValue() === DOCUMENT_PATH, '매뉴얼 직접 입력 가능');

    await manualInput.press('Escape');
    await page.getByTestId('detail-edit-project').waitFor({ state: 'visible' });
    assert(await page.getByTestId('edit-command-file-field').count() === 0, 'Escape 취소 후 사용자 데이터 미저장');
  } finally {
    await browser.close();
  }

  console.log('PASS detail edit path fields E2E');
}

// `bun test` discovers every `*.spec.ts` file. This script needs a live Vite/API
// pair, so unit-test discovery must only import it, never execute the browser flow.
if (import.meta.main && process.env.NODE_ENV !== 'test') {
  main().catch(error => {
    console.error('FAIL detail edit path fields E2E:', error);
    process.exit(1);
  });
}
