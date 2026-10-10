/** 휴대폰 「VOC 작성」: 사진 최대 5장 · 고칠 내용 필수 · 오류 옆 두 버튼 · 공유로 들어온 사진 · 실패 시 글·사진 보존.
 * Isolated fixture (tests/fixtures/remote-voc.*): no relay, no Supabase, no Mac.
 * Usage: ./node_modules/.bin/vite --port 9188 --strictPort & bun tests/remote-voc-composer.e2e.mjs http://127.0.0.1:9188 [screenshotDir]
 */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:9188';
const shots = process.argv[3] || '';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw Error('Loopback fixture required');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const errors = [];
const browser = await chromium.launch({headless: true});
try {
  const context = await browser.newContext({viewport: {width: 393, height: 852}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/tests/fixtures/remote-voc.html`);

  // 1. Every error carries both actions; the one-tap Workroom action does not open the composer.
  await page.getByTestId('error-voc-workroom').click();
  assert.deepEqual(await page.evaluate(() => window.__errorWorkroom), ['Mac이 응답하지 않습니다.']);
  assert.equal(await page.getByTestId('remote-voc-composer').count(), 0);
  await page.getByTestId('error-voc-compose').click();
  await page.getByTestId('remote-voc-composer').waitFor();
  assert.match(await page.getByTestId('remote-voc-error-context').textContent(), /Mac이 응답하지 않습니다/);
  // iOS zooms the whole page into a text field below 16px and keeps the zoom (2026-10-09 TestFlight 712).
  assert.equal(await page.getByTestId('remote-voc-comment').evaluate(e => getComputedStyle(e).fontSize), '16px');

  // 2. Comment is required.
  await page.getByTestId('remote-voc-send').click();
  assert.match(await page.locator('.remote-voc-error').textContent(), /고칠 내용을 입력/);

  // 3. Up to five photos from the picker; the sixth is refused with a message.
  const files = Array.from({length: 6}, (_, i) => ({name: `s${i}.png`, mimeType: 'image/png', buffer: PNG}));
  await page.getByTestId('remote-voc-photo-input').setInputFiles(files);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="remote-voc-thumb"]').length === 5);
  assert.equal(await page.getByTestId('remote-voc-add-photo').count(), 0, 'add button hides at 5');
  assert.match(await page.locator('.remote-voc-error').textContent(), /5장까지/);
  await page.locator('[data-testid="remote-voc-thumb"] button').first().click();
  assert.equal(await page.getByTestId('remote-voc-thumb').count(), 4);
  if (shots) await page.screenshot({path: `${shots}/remote-voc-composer.png`});

  // 4. A failed send keeps the text and photos.
  await page.getByTestId('remote-voc-comment').fill('fail');
  await page.getByTestId('remote-voc-workroom').click();
  await page.locator('.remote-voc-error').filter({hasText: '손상'}).waitFor();
  assert.equal(await page.getByTestId('remote-voc-thumb').count(), 4);

  // 5. Success sends the whole set once and closes.
  await page.getByTestId('remote-voc-comment').fill('저장 버튼이 키보드에 가려요');
  await page.getByTestId('remote-voc-workroom').click();
  await page.getByTestId('remote-voc-composer').waitFor({state: 'detached'});
  assert.deepEqual(await page.evaluate(() => window.__sent), [{mode: 'workroom', comment: '저장 버튼이 키보드에 가려요', images: 4, error: 'Mac이 응답하지 않습니다.', source: 'phone-error'}]);

  // 6. Photos shared from the Photos app arrive prefilled.
  await page.evaluate(bytes => window.__share({comment: '공유 메모', images: [{bytes}, {bytes}]}), [...PNG]);
  await page.getByTestId('remote-voc-composer').waitFor();
  assert.equal(await page.getByTestId('remote-voc-thumb').count(), 2);
  assert.equal(await page.getByTestId('remote-voc-comment').inputValue(), '공유 메모');
  await page.getByTestId('remote-voc-send').click();
  await page.getByTestId('remote-voc-composer').waitFor({state: 'detached'});
  assert.equal((await page.evaluate(() => window.__sent))[1].source, 'phone-share');

  assert.deepEqual(errors, []);
  console.log('remote-voc composer e2e: all checks passed');
} finally {
  await browser.close();
}
