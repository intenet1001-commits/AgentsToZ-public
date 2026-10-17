/** Phone Workroom history: 「이어 열기」 is confirmed on purpose, never by one double tap (audit 2026-10-16).
 *
 * The confirm button used to replace 「이어 열기」 in exactly the same place and size, so one double tap armed and
 * confirmed: review and execute went to the Mac and the conversation's CLI started there. Once armed there was no
 * cancel, and 「새로 고침」 left it armed for a later stray tap. This renders the real panel (tests/fixtures/
 * remote-workroom-history-confirm.tsx, its own stylesheet included) against a fake Mac and checks, in Chromium (mobile,
 * touch) and WebKit at 390×844:
 *   1. a double tap on 「이어 열기」 sends nothing and leaves a confirmation that says what opens, with 「취소」;
 *   2. the confirm button is not where 「이어 열기」 was;
 *   3. 「취소」 disarms it, and so does 「새로 고침」;
 *   4. a confirm within ~500 ms of arming is ignored even on the button; a deliberate one sends review and execute once.
 * Self-contained: bundles the fixture with Bun.build and serves it on 127.0.0.1. No app, no sidecar, no 3001.
 * Usage: bun tests/remote-workroom-history-confirm.e2e.mjs
 */
import {chromium, webkit} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';

const built = await Bun.build({entrypoints: [join(import.meta.dir, 'fixtures', 'remote-workroom-history-confirm.tsx')], target: 'browser', format: 'esm',
  define: {'process.env.NODE_ENV': '"production"'}});
if (!built.success) throw Error('bundle failed: ' + built.logs.map(log => log.message).join('; '));
const js = await built.outputs.find(output => output.path.endsWith('.js')).text();
const css = await (built.outputs.find(output => output.path.endsWith('.css'))?.text() ?? '');
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/app.js') return new Response(js, {headers: {'content-type': 'text/javascript; charset=utf-8'}});
    if (path === '/app.css') return new Response(css, {headers: {'content-type': 'text/css; charset=utf-8'}});
    return new Response('<!doctype html><html data-app-theme="gray"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>', {headers: {'content-type': 'text/html; charset=utf-8'}});
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const sent = page => page.evaluate(() => window.__historyCalls.filter(action => action !== 'history.list'));

try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({headless: true});
    try {
      const context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true, isMobile: name === 'chromium'});
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/');
      await page.locator('[data-testid="remote-workroom-history"] > summary').click();
      const resume = page.getByTestId('remote-workroom-history-resume').first();
      await resume.waitFor();

      // 1. One double tap where 「이어 열기」 is.
      const box = await resume.boundingBox();
      const point = {x: box.x + box.width / 2, y: box.y + box.height / 2};
      await page.mouse.click(point.x, point.y, {clickCount: 2, delay: 40});
      await page.waitForTimeout(700);
      assert.deepEqual(await sent(page), [], `${name}: a double tap on 「이어 열기」 sent ${JSON.stringify(await sent(page))}`);
      const warning = page.getByTestId('remote-workroom-history-resume-warning');
      await warning.waitFor({timeout: 3000});
      assert.match(await warning.textContent(), /Mac에서 다시 엽니다/);
      const cancel = page.getByTestId('remote-workroom-history-resume-cancel');
      assert.equal(await cancel.textContent(), '취소');
      if (name === 'chromium') {
        // The same with two quick touches.
        await cancel.click();
        await page.touchscreen.tap(point.x, point.y);
        await page.waitForTimeout(60);
        await page.touchscreen.tap(point.x, point.y);
        await page.waitForTimeout(700);
        assert.deepEqual(await sent(page), [], `${name}: two quick touches sent ${JSON.stringify(await sent(page))}`);
        await warning.waitFor({timeout: 3000});
      }

      // 2. The confirm button is somewhere else.
      const confirm = page.getByTestId('remote-workroom-history-confirm');
      const at = await confirm.boundingBox();
      const under = point.x >= at.x && point.x <= at.x + at.width && point.y >= at.y && point.y <= at.y + at.height;
      assert.equal(under, false, `${name}: the confirm button ${JSON.stringify(at)} sits under the finger at ${JSON.stringify(point)}`);

      // 3. 「취소」 disarms; so does 「새로 고침」.
      await cancel.click();
      assert.equal(await warning.count(), 0, `${name}: 취소 leaves the confirmation`);
      await resume.click();
      await warning.waitFor();
      await page.getByTestId('remote-workroom-history-load').click();
      await page.waitForFunction(() => window.__historyCalls.filter(action => action === 'history.list').length >= 2);
      await page.waitForTimeout(200);
      assert.equal(await warning.count(), 0, `${name}: 새로 고침 leaves the confirmation armed`);
      assert.deepEqual(await sent(page), [], `${name}: nothing was sent while arming and cancelling`);

      // 3b. Keyboard and VoiceOver (w5 review): arming must not drop focus to <body> — it moves into the confirmation,
      // the next Tab reaches 「이 Mac에서 열기」, and 「취소」 hands focus back to that row's 「이어 열기」. WebKit tabs to
      // buttons only with Option held, as Safari does.
      const tab = name === 'webkit' ? 'Alt+Tab' : 'Tab';
      const focused = () => page.evaluate(() => ({tag: document.activeElement?.tagName, testid: document.activeElement?.getAttribute('data-testid') ?? null,
        inWarning: !!document.activeElement?.closest('[data-testid="remote-workroom-history-resume-warning"]'),
        firstResume: document.activeElement === document.querySelector('[data-testid="remote-workroom-history-resume"]')}));
      await resume.focus();
      await page.keyboard.press('Enter');
      await warning.waitFor();
      await page.waitForTimeout(50);
      assert.ok((await focused()).inWarning, `${name}: arming left focus on ${JSON.stringify(await focused())}`);
      await page.keyboard.press(tab);
      assert.equal((await focused()).testid, 'remote-workroom-history-confirm', `${name}: Tab after arming went to ${JSON.stringify(await focused())}`);
      await page.keyboard.press(tab);
      assert.equal((await focused()).testid, 'remote-workroom-history-resume-cancel', `${name}: the next Tab went to ${JSON.stringify(await focused())}`);
      await page.keyboard.press('Enter');
      assert.equal(await warning.count(), 0, `${name}: 취소 by keyboard leaves the confirmation`);
      await page.waitForTimeout(50);
      assert.ok((await focused()).firstResume, `${name}: 취소 left focus on ${JSON.stringify(await focused())}`);
      assert.deepEqual(await sent(page), [], `${name}: nothing was sent by keyboard arming and cancelling`);

      // 4. A confirm right after arming (even one that lands on the button) is ignored; a deliberate one sends once.
      await resume.click();
      await warning.waitFor();
      await confirm.evaluate(el => el.click());
      await page.waitForTimeout(100);
      assert.deepEqual(await sent(page), [], `${name}: a confirm within the double-tap window sent ${JSON.stringify(await sent(page))}`);
      await page.waitForTimeout(600);
      await confirm.click();
      await page.getByTestId('remote-workroom-history-message').waitFor();
      assert.deepEqual(await sent(page), ['history.resume.review', 'history.resume.execute'], `${name}: the confirm`);
      assert.deepEqual(errors, []);
      console.log(`${name}: double tap sends nothing, the confirmation has 취소 and its own place, 새로 고침 disarms, a confirm sends once`);
      await context.close();
    } finally { await browser.close(); }
  }
  console.log('remote workroom history confirm PASS');
} finally { server.stop(true); }
