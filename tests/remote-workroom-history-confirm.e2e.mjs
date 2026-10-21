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
 *   5. direct success and a status check after an uncertain execute both select the restored session;
 *   6. delayed lists and resume results from another Mac cannot replace the current Mac's view or session selection.
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
      await context.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', {value: undefined, configurable: true}));
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
      // The uncertain execute is checked once, then the actual resumed session is selected without a second launch.
      await page.getByTestId('remote-workroom-history-pending-check').click();
      await page.waitForFunction(()=>window.__historyFixture.selected.length===1);
      assert.deepEqual(await sent(page),['history.resume.review','history.resume.execute','history.resume.status']);
      assert.equal(await page.getByTestId('remote-workroom-history-pending-row').count(),0);
      assert.match(await page.getByTestId('remote-workroom-history-message').innerText(),/그 세션을 골랐습니다/);

      // A direct success selects the restored session too.
      await page.reload();await page.evaluate(()=>{window.__historyFixture.completed=true;});
      await page.locator('[data-testid="remote-workroom-history"] > summary').click();
      await page.getByTestId('remote-workroom-history-resume').first().click();
      await page.waitForTimeout(550);await page.getByTestId('remote-workroom-history-confirm').click();
      await page.waitForFunction(()=>window.__historyFixture.selected.length===1);
      assert.deepEqual(await sent(page),['history.resume.review','history.resume.execute']);

      // A list requested from Mac A cannot reappear under Mac B after a delayed response.
      await page.reload();await page.evaluate(()=>{window.__historyFixture.holdList=true;});
      await page.locator('[data-testid="remote-workroom-history"] > summary').click();
      await page.waitForFunction(()=>window.__historyFixture.listWaiting);
      await page.evaluate(()=>window.__historyFixture.switchHost('host_fixture_0002'));
      await page.waitForFunction(()=>document.querySelector('[data-testid="remote-workroom-history-project"]').value==='control_fixture_0002');
      await page.evaluate(()=>window.__historyFixture.releaseList());
      await page.waitForFunction(()=>!document.querySelector('[data-testid="remote-workroom-history-load"]').disabled);
      assert.equal(await page.getByTestId('remote-workroom-history-row').count(),0,`${name}: Mac A's late list must not appear on Mac B`);
      await page.getByTestId('remote-workroom-history-load').click();
      await page.getByTestId('remote-workroom-history-row').filter({hasText:'두번째 Mac의 대화'}).waitFor();

      // Finishing A's already-sent resume must settle its receipt without selecting A's session on B.
      await page.reload();await page.evaluate(()=>{window.__historyFixture.completed=true;window.__historyFixture.holdExecute=true;});
      await page.locator('[data-testid="remote-workroom-history"] > summary').click();
      await page.getByTestId('remote-workroom-history-resume').first().click();
      await page.waitForTimeout(550);await page.getByTestId('remote-workroom-history-confirm').click();
      await page.waitForFunction(()=>window.__historyFixture.executeWaiting);
      await page.evaluate(()=>window.__historyFixture.switchHost('host_fixture_0002'));
      await page.waitForFunction(()=>document.querySelector('[data-testid="remote-workroom-history-project"]').value==='control_fixture_0002');
      await page.evaluate(()=>window.__historyFixture.releaseExecute());
      await page.getByTestId('remote-workroom-history-load').click();
      await page.getByTestId('remote-workroom-history-row').filter({hasText:'두번째 Mac의 대화'}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.__historyFixture.selected),[],`${name}: A's delayed success never selects its session on B`);
      assert.equal(await page.getByTestId('remote-workroom-history-message').count(),0);
      assert.deepEqual(await sent(page),['history.resume.review','history.resume.execute']);
      // Closing the history view cannot invoke a session-selection callback after unmount.
      await page.reload();await page.evaluate(()=>{__historyFixture.completed=true;__historyFixture.holdExecute=true;});
      await page.locator('[data-testid="remote-workroom-history"] > summary').click();
      await page.getByTestId('remote-workroom-history-resume').first().click();await page.waitForTimeout(550);await page.getByTestId('remote-workroom-history-confirm').click();
      await page.waitForFunction(()=>__historyFixture.executeWaiting);await page.evaluate(()=>__historyFixture.mount(false));
      await page.getByText('대화 목록을 닫았습니다.',{exact:true}).waitFor();await page.evaluate(()=>__historyFixture.releaseExecute());
      await page.waitForFunction(()=>__historyFixture.executeSettled);await page.waitForTimeout(100);
      assert.deepEqual(await page.evaluate(()=>__historyFixture.selected),[],`${name}: a closed history view never selects a delayed session`);
      // Real navigation hides the panel without unmounting it. A stale response cannot navigate back.
      for(const method of ['visibility','availability','connection']){
        await page.reload();await page.evaluate(()=>{__historyFixture.completed=true;__historyFixture.holdExecute=true;});
        await page.locator('[data-testid="remote-workroom-history"] > summary').click();
        await page.getByTestId('remote-workroom-history-resume').first().click();await page.waitForTimeout(550);await page.getByTestId('remote-workroom-history-confirm').click();
        await page.waitForFunction(()=>__historyFixture.executeWaiting);await page.evaluate(method=>__historyFixture[method](false),method);await page.waitForFunction(method=>document.querySelector('[data-testid=history-fixture-context]').dataset[method]==='false',method);
        await page.evaluate(()=>__historyFixture.releaseExecute());await page.waitForFunction(()=>__historyFixture.executeSettled);await page.waitForTimeout(100);
        assert.deepEqual(await page.evaluate(()=>__historyFixture.selected),[],`${name}: a ${method} change cannot select a stale session`);
      }
      // An unavailable action says why and never sends a read while offline or project-less.
      await page.reload();await page.evaluate(()=>__historyFixture.connection(false));
      await page.locator('[data-testid="remote-workroom-history"] > summary').click();await page.getByTestId('remote-workroom-history-offline').waitFor();
      assert.equal(await page.getByTestId('remote-workroom-history-load').isDisabled(),true);assert.deepEqual(await page.evaluate(()=>__historyCalls),[]);
      await page.evaluate(()=>{__historyFixture.connection(true);__historyFixture.emptyProjects(true);});await page.getByTestId('remote-workroom-history-no-project').waitFor();
      assert.equal(await page.getByTestId('remote-workroom-history-load').isDisabled(),true);assert.deepEqual(await page.evaluate(()=>__historyCalls),[]);
      await page.reload();await page.evaluate(()=>{__historyFixture.holdList=true;});await page.locator('[data-testid="remote-workroom-history"] > summary').click();
      await page.getByTestId('remote-workroom-history-progress').filter({hasText:'불러오는 중'}).waitFor();await page.evaluate(()=>__historyFixture.releaseList());await page.getByTestId('remote-workroom-history-resume').first().waitFor();
      await page.reload();await page.evaluate(()=>{__historyFixture.listError='Mac에서 이 기기의 워크룸 대화 기록 보기 권한을 허용하세요.';});await page.locator('[data-testid="remote-workroom-history"] > summary').click();
      await page.getByTestId('remote-workroom-history-permission-help').waitFor();assert.equal(await sent(page).then(v=>v.length),0);
      await page.evaluate(()=>{__historyFixture.listError='';});await page.getByRole('button',{name:'권한 확인 후 다시 불러오기',exact:true}).click();await page.getByTestId('remote-workroom-history-resume').first().waitFor();
      assert.equal(await page.getByTestId('remote-workroom-history-permission-help').count(),0);assert.deepEqual(await sent(page),[]);
      // Physical v1139: two different saved conversations were both 「Codex CLI 대화 · 종료됨 · 00:12」.
      // The visible labels must distinguish them, and choosing the second must still review only its exact identity.
      await page.reload();await page.evaluate(()=>{__historyFixture.duplicates=true;});
      await page.locator('[data-testid="remote-workroom-history"] > summary').click();
      const duplicateRows=page.getByTestId('remote-workroom-history-row');
      await duplicateRows.nth(1).waitFor();
      const labels=await duplicateRows.locator('.ai-terminal-history-title').allTextContents();
      assert.equal(new Set(labels).size,2,`${name}: same-minute rows need distinct visible labels`);
      assert.match(labels[0],/00:12:05/);assert.match(labels[1],/00:12:06/);
      await duplicateRows.nth(1).getByTestId('remote-workroom-history-resume').click();
      await page.waitForTimeout(550);await page.getByTestId('remote-workroom-history-confirm').click();
      await page.waitForFunction(()=>__historyFixture.reviewed.length===1);
      assert.deepEqual(await page.evaluate(()=>__historyFixture.reviewed),['conv_fixture_0000002']);
      assert.deepEqual(errors, []);
      console.log(`${name}: confirmation and double-tap guard, direct and lost-reply resume selection, delayed host responses passed`);
      await context.close();
    } finally { await browser.close(); }
  }
  console.log('remote workroom history confirm PASS');
} finally { server.stop(true); }
