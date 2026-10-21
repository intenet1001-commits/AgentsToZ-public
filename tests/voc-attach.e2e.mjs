/** VOC 사진 첨부(선택·붙여넣기·드롭·5장 한도·빼기) + 워크룸 인계 + 도구 영역 규격 명령 한 줄 컨트롤.
 * Isolated fixture (tests/fixtures/voc-attach.*): no sidecar, no Workroom, no Tauri.
 * Usage: ./node_modules/.bin/vite --port 9187 --strictPort & bun tests/voc-attach.e2e.mjs http://127.0.0.1:9187 [screenshotDir]
 */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:9187';
const shots = process.argv[3] || '';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw Error('Loopback fixture required');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const errors = [];
const browser = await chromium.launch({headless: true});
try {
  const context = await browser.newContext({viewport: {width: 1100, height: 900}, serviceWorkers: 'block'});
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/tests/fixtures/voc-attach.html`);

  // 1. Tools row: one segmented control per pinned command (copy + icon-only workroom), compact manage.
  const control = page.getByTestId('pinned-command-control').first();
  await control.waitFor();
  const segments = await control.evaluate(el => Array.from(el.children).map(c => ({id: c.getAttribute('data-testid'), text: c.textContent.trim(), title: c.getAttribute('title')})));
  assert.equal(segments.length, 2);
  assert.equal(segments[0].id, 'voc-workflow-prompt-copy');
  assert.equal(segments[1].id, 'pinned-command-workroom');
  assert.equal(segments[1].text, '', 'workroom segment is icon only');
  assert.match(segments[1].title, /초안으로 채워 엽니다/);
  assert.equal((await page.getByTestId('pinned-commands-manage').textContent()).trim(), '명령 관리');
  // The VOC overlay covers the page in this fixture, so trigger the segment directly.
  await page.getByTestId('pinned-command-workroom').first().evaluate(el => el.click());
  const pinned = await page.evaluate(() => window.__workroom.splice(0));
  assert.equal(pinned.length, 1);
  assert.match(pinned[0].prompt, /VOC/);
  if (shots) await page.getByTestId('fixture-tools').screenshot({path: `${shots}/pinned-tools.png`});

  // 2. Pick the target and write a request.
  const box = await page.getByTestId('fixture-target').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByTestId('voc-form').waitFor();
  await page.getByTestId('voc-comment').fill('이 버튼이 무엇을 하는지 모르겠어요');
  assert.equal((await page.getByTestId('voc-attachment-count').textContent()).trim(), '사진 0/5');

  // 3. File picker: 6 images → only 5 kept, the rest reported.
  const files = Array.from({length: 6}, (_, i) => ({name: `shot-${i + 1}.png`, mimeType: 'image/png', buffer: PNG}));
  await page.getByTestId('voc-attach-input').setInputFiles(files);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="voc-attachment-thumb"]').length === 5);
  assert.equal((await page.getByTestId('voc-attachment-count').textContent()).trim(), '사진 5/5');
  assert.match(await page.getByTestId('voc-attach-message').textContent(), /최대 5장/);
  assert.equal(await page.getByTestId('voc-attach-button').isDisabled(), true);

  // 4. Remove two, then paste a large JPEG (downscaled to long edge 2400) and drop one PNG.
  await page.getByTestId('voc-attachment-remove').first().click();
  await page.getByTestId('voc-attachment-remove').first().click();
  assert.equal((await page.getByTestId('voc-attachment-count').textContent()).trim(), '사진 3/5');
  await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), {width: 3000, height: 1500});
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'teal'; ctx.fillRect(0, 0, 3000, 1500);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
    const data = new DataTransfer(); data.items.add(new File([blob], 'big.jpg', {type: 'image/jpeg'}));
    document.querySelector('[data-testid="voc-comment"]').dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="voc-attachment-thumb"]').length === 4);
  const dropped = await page.evaluate(async png => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], 'dropped.png', {type: 'image/png'}));
    const form = document.querySelector('[data-testid="voc-form"]');
    form.dispatchEvent(new DragEvent('dragover', {dataTransfer: data, bubbles: true, cancelable: true}));
    await new Promise(r => setTimeout(r, 50));
    const active = form.getAttribute('data-drop-active');
    form.dispatchEvent(new DragEvent('drop', {dataTransfer: data, bubbles: true, cancelable: true}));
    return active;
  }, PNG.toString('base64'));
  assert.equal(dropped, 'true', 'dragover highlights the form');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="voc-attachment-thumb"]').length === 5);
  const pastedSize = await page.evaluate(() => new Promise(resolve => {
    const img = Array.from(document.querySelectorAll('[data-testid="voc-attachment-thumb"] img')).find(i => i.src.startsWith('data:image/jpeg'));
    const probe = new Image(); probe.onload = () => resolve([probe.naturalWidth, probe.naturalHeight]); probe.src = img.src;
  }));
  assert.deepEqual(pastedSize, [2400, 1200], 'large paste downscaled to long edge 2400');
  if (shots) await page.getByTestId('voc-form').screenshot({path: `${shots}/voc-form-attachments.png`});

  // 5. Save and hand off to the Workroom (draft only).
  await page.getByTestId('voc-save-and-workroom').click();
  await page.waitForFunction(() => window.__workroom.length >= 1 && window.__submits.length === 1);
  const submit = await page.evaluate(() => window.__submits[0]);
  assert.equal(submit.images.length, 5);
  assert.equal(submit.imagePaths, undefined);
  const handoff = await page.evaluate(() => window.__workroom.at(-1));
  assert.equal(handoff.title, 'VOC 처리 · 실행 전 확인');
  assert.match(handoff.prompt, /2026-09-27-1200-fixture-target\.json/);
  assert.match(handoff.prompt, /fixture-5\.png/);
  assert.equal(await page.evaluate(() => window.__closed), 1, 'overlay closes so the Workroom draft is visible');

  // 6. The saved card offers the same handoff again.
  await page.getByTestId('voc-saved').waitFor();
  if (shots) await page.getByTestId('voc-saved').screenshot({path: `${shots}/voc-saved.png`});
  await page.getByTestId('voc-open-workroom').click();
  await page.waitForFunction(() => window.__workroom.filter(w => w.title === 'VOC 처리 · 실행 전 확인').length === 2);
  assert.deepEqual(errors, []);
  console.log('voc-attach e2e: all checks passed');
} finally {
  await browser.close();
}
