/** 휴대폰 「VOC」: 보내지 않은 캡처(닫아도 남음·새로고침 후에도 남음·이어서 보내기·삭제) + Mac에 쌓인 VOC(목록·업데이트 안내·워크룸 초안).
 * Isolated fixture (tests/fixtures/remote-voc-hub.*): real capture store (IndexedDB) and share-intake order; no relay, no Mac.
 * Usage: ./node_modules/.bin/vite --port 9188 --strictPort & bun tests/remote-voc-hub.e2e.mjs http://127.0.0.1:9188 [screenshotDir]
 */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:9188';
const shots = process.argv[3] || '';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw Error('Loopback fixture required');
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4];
const b64 = bytes => Buffer.from(bytes).toString('base64');
const A = '11111111-2222-4333-8444-555555555555';
const B = '11111111-2222-4333-8444-666666666666';
const share = (id, comment, count, createdAt) => ({id, createdAt, comment, images: Array.from({length: count}, (_, i) => ({name: `${i + 1}.jpg`, mime: 'image/jpeg', dataBase64: b64(JPEG)}))});
const errors = [];
const browser = await chromium.launch({headless: true});
try {
  const context = await browser.newContext({viewport: {width: 393, height: 852}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/tests/fixtures/remote-voc-hub.html`);
  await page.getByTestId('remote-voc-open').waitFor();

  // 1. A share is stored first, acked, and opens the composer; a second share while it is open waits in the store.
  assert.equal(await page.evaluate(d => window.__hubDeliver(d), share(A, '공유 A', 2, '2026-09-27T01:00:00Z')), 'stored');
  await page.getByTestId('remote-voc-composer').waitFor();
  assert.equal(await page.getByTestId('remote-voc-thumb').count(), 2);
  assert.equal(await page.evaluate(d => window.__hubDeliver(d), share(B, '', 1, '2026-09-27T02:00:00Z')), 'stored');
  assert.deepEqual(await page.evaluate(() => window.__hubAcks), [A, B]);
  assert.match(await page.getByTestId('fixture-notice').textContent(), /보내지 않은 캡처/);
  assert.equal(await page.getByTestId('remote-voc-comment').inputValue(), '공유 A', 'the open composer was not replaced');
  // Re-delivery of an unacknowledged-looking item keeps one copy.
  assert.equal(await page.evaluate(d => window.__hubDeliver(d), share(A, '다시', 2, '2026-09-27T01:00:00Z')), 'duplicate');

  // 2. Closing without sending keeps the capture with the edited text.
  await page.getByTestId('remote-voc-capture-note').waitFor();
  await page.getByTestId('remote-voc-comment').fill('A 고친 내용');
  await page.getByTestId('remote-voc-close').click();
  await page.getByTestId('remote-voc-composer').waitFor({state: 'detached'});
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-voc-open-badge"]')?.textContent === '2');

  // 3. The captures survive a reload (IndexedDB), and the hub lists them.
  await page.reload();
  await page.getByTestId('remote-voc-open-badge').waitFor();
  await page.getByTestId('remote-voc-open').click();
  await page.getByTestId('remote-voc-hub').waitFor();
  assert.equal(await page.getByTestId('remote-voc-captures-count').textContent(), '2개');
  assert.equal(await page.getByTestId('remote-voc-capture').count(), 2);
  assert.equal(await page.getByTestId('remote-voc-inbox-offline').count(), 1);
  if (shots) await page.screenshot({path: `${shots}/remote-voc-hub-captures.png`});

  // 4. Resume A → composer with its photos and edited text → sending removes it.
  await page.getByTestId('remote-voc-capture').filter({hasText: 'A 고친 내용'}).getByTestId('remote-voc-capture-resume').click();
  await page.getByTestId('remote-voc-composer').waitFor();
  assert.equal(await page.getByTestId('remote-voc-comment').inputValue(), 'A 고친 내용');
  assert.equal(await page.getByTestId('remote-voc-thumb').count(), 2);
  await page.getByTestId('remote-voc-send').click();
  await page.getByTestId('remote-voc-composer').waitFor({state: 'detached'});
  assert.deepEqual(await page.evaluate(() => window.__hubSent), [{comment: 'A 고친 내용', images: 2}]);
  assert.deepEqual(await page.evaluate(() => window.__hubCaptureIds()), [B]);

  // 5. Deleting B asks first, then removes it from the store for real.
  await page.getByTestId('remote-voc-open').click();
  await page.getByTestId('remote-voc-capture-delete').click();
  await page.getByTestId('remote-voc-capture-delete-confirm').click();
  await page.getByTestId('remote-voc-captures').waitFor({state: 'detached'});
  assert.deepEqual(await page.evaluate(() => window.__hubCaptureIds()), []);

  // 6. An older Mac: a clear update notice, and the whole-inbox Workroom draft still works.
  await page.evaluate(() => window.__hubSetInbox({kind: 'update-required'}));
  assert.match(await page.getByTestId('remote-voc-inbox-update').textContent(), /Mac 앱 업데이트 필요/);
  await page.getByTestId('remote-voc-inbox-workroom').click();
  await page.getByTestId('remote-voc-hub').waitFor({state: 'detached'});
  let prompts = await page.evaluate(() => window.__hubWorkroom);
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0].includes('<focus_voc>') && prompts[0].includes('/api/voc'));

  // 7. The Mac's piled-up VOCs: count, list, one item → focus draft (no path, photo count only).
  await page.getByTestId('remote-voc-open').click();
  await page.evaluate(() => window.__hubSetInbox({kind: 'ready', inbox: {total: 5, unreadable: 1, items: [
    {file: '2026-09-27-0900-phone.json', createdAt: '2026-09-27T09:00:00Z', source: 'phone-share', summary: '저장 버튼이 가려요', photos: 2},
    {file: '2026-09-26-1800-save.json', createdAt: '2026-09-26T18:00:00Z', source: 'mac', summary: '헤더 정렬', photos: 0},
  ]}}));
  assert.equal(await page.getByTestId('remote-voc-inbox-count').textContent(), '5건');
  assert.equal(await page.getByTestId('remote-voc-inbox-item').count(), 2);
  assert.match(await page.getByTestId('remote-voc-inbox-item').first().textContent(), /휴대폰 사진 공유 · 사진 2장/);
  if (shots) await page.screenshot({path: `${shots}/remote-voc-hub-inbox.png`});
  await page.getByTestId('remote-voc-inbox-item').first().getByTestId('remote-voc-inbox-item-workroom').click();
  await page.getByTestId('remote-voc-hub').waitFor({state: 'detached'});
  prompts = await page.evaluate(() => window.__hubWorkroom);
  assert.ok(prompts[1].includes('<focus_voc>') && prompts[1].includes('2026-09-27-0900-phone.json') && prompts[1].includes('사진 2장'));

  // No horizontal scroll at phone width.
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('remote-voc hub e2e: all checks passed');
} finally {
  await browser.close();
}
