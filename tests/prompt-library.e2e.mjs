/** 자주 쓰는 프롬프트: 간단 프롬프트 / 규격 명령, 도구 영역 고정, AI 초안 흐름, 미리보기, 재렌더 비용.
 * Isolated fixture (tests/fixtures/prompt-library.*): in-memory library, fake Workroom bridge, stubbed clipboard.
 * Usage: bun tests/prompt-library.e2e.mjs http://127.0.0.1:9090
 */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:9090';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw Error('Loopback fixture required');
const nineLines = Array.from({length: 9}, (_, i) => `단계 ${i + 1}: 확인합니다`).join('\n');
const legacy = [{id: 'legacy-1', title: '단계별 테스트·진행', body: nineLines, pinned: true, updatedAt: '2026-09-01T00:00:00.000Z'}];
const errors = [];

async function open(browser, {viewport = {width: 1100, height: 1000}, query = '', hasTouch = false} = {}) {
  const context = await browser.newContext({viewport, hasTouch, serviceWorkers: 'block'});
  await context.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async text => { window.__copies = [...(window.__copies ?? []), text]; }}}); });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) { errors.push('external ' + url.href); return route.abort(); }
    if (url.pathname.startsWith('/api/')) return route.abort(); // best-effort provenance only
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/tests/fixtures/prompt-library.html?seed=${encodeURIComponent(JSON.stringify(legacy))}${query}`);
  await page.getByTestId('prompt-guide-pinned-copy').waitFor();
  return {context, page};
}
const copies = page => page.evaluate(() => window.__copies ?? []);

const browser = await chromium.launch({headless: true});
try {
  const {page} = await open(browser);

  // 1. Legacy 5-key entry still works; its chip previews on hover (no title tooltip).
  const chip = page.getByTestId('prompt-guide-pinned-copy');
  assert.equal(await chip.getAttribute('title'), null);
  await chip.hover();
  const preview = page.getByTestId('prompt-preview');
  await preview.waitFor();
  assert.equal(await preview.getAttribute('data-truncated'), 'true');
  assert.match(await page.getByTestId('prompt-preview-body').textContent(), /단계 9/);
  const box = await page.getByTestId('prompt-preview-body').evaluate(el => ({client: el.clientHeight, scroll: el.scrollHeight, line: parseFloat(getComputedStyle(el).lineHeight)}));
  assert.ok(box.scroll > box.client, 'full text scrolls inside the preview');
  assert.ok(Math.abs(box.client - box.line * 6) <= 2, `preview shows about six lines (${box.client}px vs ${box.line * 6}px)`);
  await page.mouse.move(5, 900); await preview.waitFor({state: 'hidden'});
  // Keyboard focus previews too.
  await chip.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  await preview.waitFor();
  await page.keyboard.press('Escape'); await preview.waitFor({state: 'hidden'});

  // 2. The two former hard-coded tool buttons are default 규격 명령 with the same test ids and exact text.
  const voc = page.getByTestId('voc-workflow-prompt-copy'), git = page.getByTestId('git-sync-workflow-prompt-copy');
  await voc.waitFor(); await git.waitFor();
  await voc.hover(); await preview.waitFor();
  assert.match(await page.getByTestId('prompt-preview-body').textContent(), /미처리 VOC/);
  await voc.click();
  await page.waitForFunction(() => (window.__copies ?? []).length === 1);
  assert.match((await copies(page))[0], /"registeredProjectPath": "\/projects\/AgentsToZ_byCS"/);
  assert.deepEqual(await page.evaluate(() => window.__toasts), ['「VOC 처리→머지·푸시→빌드·열기」 규격 명령을 복사했습니다']);
  assert.equal(await page.getByTestId('prompt-guide-pinned-copy').count(), 1, 'commands never become top-bar chips');

  // 3. Manage → 규격 명령 tab; reorder stores only the default whose new position needs it (the other stays virtual).
  await page.getByTestId('pinned-commands-manage').click();
  await page.getByTestId('prompt-guide-dialog').waitFor();
  assert.equal(await page.getByTestId('prompt-library-tab-command').getAttribute('aria-selected'), 'true');
  const listed = page.getByTestId('prompt-guide-saved-list').getByTestId('prompt-guide-edit');
  assert.deepEqual(await listed.evaluateAll(els => els.map(el => el.dataset.guideId)), ['builtin-voc-workflow', 'builtin-git-sync-workflow']);
  await page.locator('[data-testid="prompt-guide-move-up"][data-guide-id="builtin-git-sync-workflow"]').click();
  await page.waitForFunction(() => window.__saves.length === 1);
  const afterMove = await page.evaluate(() => window.__saves[0]);
  assert.deepEqual(afterMove.map(e => [e.id, e.kind ?? 'simple']), [['legacy-1', 'simple'], ['builtin-git-sync-workflow', 'command']]);
  assert.equal(Object.keys(afterMove[0]).length, 5, 'legacy entry keeps its five-key shape');
  const toolOrder = () => page.getByTestId('fixture-tools').locator('[data-command-id]').evaluateAll(els => els.map(el => el.dataset.commandId));
  await page.waitForFunction(() => document.querySelector('[data-testid="fixture-tools"] [data-command-id]')?.dataset.commandId === 'builtin-git-sync-workflow');

  // 4. Unpin a default: it disappears from the tools area; a default cannot be deleted.
  await page.locator('[data-testid="prompt-guide-edit"][data-guide-id="builtin-voc-workflow"]').click();
  assert.equal(await page.getByTestId('prompt-guide-delete').count(), 0);
  await page.getByTestId('prompt-guide-pin').uncheck();
  await page.getByTestId('prompt-guide-save').click();
  await page.waitForFunction(() => window.__saves.length === 2);
  await page.getByTestId('voc-workflow-prompt-copy').waitFor({state: 'detached'});
  assert.deepEqual(await toolOrder(), ['builtin-git-sync-workflow']);

  // 5. AI로 규격 명령 만들기 → Workroom draft; nothing is saved until the user pastes and saves.
  await page.getByTestId('prompt-command-ai-toggle').click();
  await page.getByTestId('prompt-command-ai-description').fill('매주 의존성 보안 점검 후 표로 보고');
  // The selector picks where the drafting AI runs, not an owner: say so, next to it.
  assert.match(await page.getByTestId('prompt-command-ai-project').locator('xpath=..').textContent(), /초안을 쓸 워크룸/);
  assert.match(await page.getByTestId('prompt-command-ai-project-hint').textContent(), /어느 프로젝트에도 묶이지 않/);
  await page.getByTestId('prompt-command-ai-open').click();
  await page.getByTestId('prompt-guide-dialog').waitFor({state: 'hidden'});
  const opens = await page.evaluate(() => window.__workroomOpens);
  assert.equal(opens.length, 1); assert.equal(opens[0].targetId, 'project-aaaa-1111');
  for (const section of ['목적', '전제', '단계', '확인 기준', '금지 사항', '보고 형식']) assert.ok(opens[0].prompt.includes(`## ${section}`));
  assert.ok(opens[0].prompt.includes('매주 의존성 보안 점검 후 표로 보고'));
  assert.equal(await page.evaluate(() => window.__saves.length), 2, 'AI output is never auto-saved');
  await page.getByTestId('pinned-commands-manage').click();
  assert.equal(await page.getByTestId('prompt-guide-title').inputValue(), '매주 의존성 보안 점검 후 표로 보고');
  assert.equal(await page.getByTestId('prompt-guide-body').inputValue(), '');
  assert.match(await page.getByTestId('prompt-guide-notice').textContent(), /자동으로 저장되지 않습니다/);
  await page.getByTestId('prompt-guide-body').fill('## 목적\n- 의존성 점검\n\n## 단계\n1. bun audit');
  await page.getByTestId('prompt-guide-save').click();
  await page.waitForFunction(() => window.__saves.length === 3);
  const created = (await page.evaluate(() => window.__saves[2])).at(-1);
  assert.equal(created.kind, 'command'); assert.equal(created.pinned, true);
  await page.keyboard.press('Escape');
  await page.locator(`[data-testid="pinned-command-copy"][data-command-id="${created.id}"]`).waitFor();

  // 6. 간단 프롬프트 tab explains itself and still lists the legacy entry only.
  await page.getByTestId('prompt-guide-open').click();
  await page.getByTestId('prompt-library-tab-simple').click();
  assert.deepEqual(await page.getByTestId('prompt-guide-saved-list').getByTestId('prompt-guide-edit').evaluateAll(els => els.map(el => el.dataset.guideId)), ['legacy-1']);
  // Preview inside the modal dialog renders in the dialog's top layer.
  await page.locator('[data-testid="prompt-guide-list-copy"][data-guide-id="legacy-1"]').hover();
  await preview.waitFor();
  assert.equal(await preview.evaluate(el => !!el.closest('dialog')), true);
  await page.keyboard.press('Escape');

  // 7. Re-render cost while the host re-renders 50 times (stable props vs the pre-fix unstable callback).
  const measure = async p => p.evaluate(async () => { window.__barRenderMs = 0; for (let i = 0; i < 50; i++) { window.__tick(); await new Promise(r => setTimeout(r, 0)); } return window.__barRenderMs; });
  const stableMs = await measure(page);
  const {page: unstablePage, context: unstableContext} = await open(browser, {query: '&unstable=1'});
  const unstableMs = await measure(unstablePage);
  await unstableContext.close();
  console.log(`re-render cost over 50 host renders: memoized ${stableMs.toFixed(2)}ms vs unstable props ${unstableMs.toFixed(2)}ms`);
  assert.ok(stableMs < unstableMs, 'memoized bar skips host re-renders');

  // 8. Mobile: long-press opens the preview and does not copy.
  const {page: phone, context: phoneContext} = await open(browser, {viewport: {width: 390, height: 844}, hasTouch: true});
  await phone.getByTestId('prompt-guide-open').tap();
  const copyButton = phone.locator('[data-testid="prompt-guide-list-copy"][data-guide-id="legacy-1"]');
  const b = await copyButton.boundingBox();
  const cdp = await phoneContext.newCDPSession(phone);
  const point = [{x: b.x + b.width / 2, y: b.y + b.height / 2}];
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: point});
  await phone.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await phone.getByTestId('prompt-preview').waitFor();
  await phone.waitForTimeout(200);
  assert.deepEqual(await copies(phone), [], 'long press previews without copying');
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await phone.screenshot({path: '/tmp/agentstoz-prompt-library-mobile.png'});
  await page.screenshot({path: '/tmp/agentstoz-prompt-library-desktop.png'});
  await phoneContext.close();

  assert.deepEqual(errors, []);
  console.log('PASS legacy chips + hover/focus/long-press preview, default 규격 명령 with kept test ids, reorder/unpin, AI Workroom draft without auto-save, dialog-layer preview, memoized re-render');
} finally { await browser.close(); }
