import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const built = await Bun.build({ entrypoints: ['tests/fixtures/remote-connection-settings.tsx'], target: 'browser', format: 'esm',
  define: { 'process.env.NODE_ENV': '"production"' } });
if (!built.success) throw Error(built.logs.join('\n'));
const js = await built.outputs[0].text();
const css = (await Bun.file('src/appearanceTokens.css').text()) + (await Bun.file('src/remote-control-portal.css').text()).replace(/@import[^;]+;/g, '');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new URL(request.url).pathname === '/fixture.js'
  ? new Response(js, { headers: { 'Content-Type': 'text/javascript' } })
  : new Response(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script type="module" src="/fixture.js"></script>`, { headers: { 'Content-Type': 'text/html' } }) });
const evidence = process.env.SCREENSHOT_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/?single`);
      assert.equal(await page.getByRole('button', { name: '아젠투지 1호 연결 해제', exact: true }).isVisible(), false);
      await page.getByRole('button', { name: '화면 새로 불러오기' }).tap();
      assert.deepEqual(await page.evaluate(() => window.fixture.requests), []);
      if (evidence) await page.screenshot({ path: `${evidence}/${name}-collapsed.png` });
      await page.locator('summary').tap();
      const disconnect = page.getByRole('button', { name: '아젠투지 1호 연결 해제', exact: true });
      assert.ok((await disconnect.boundingBox()).height >= 44);
      await disconnect.tap();
      const dialog = page.getByRole('dialog'); await dialog.waitFor();
      assert.match(await dialog.innerText(), /아젠투지 1호/);
      assert.match(await dialog.innerText(), /새 QR/);
      assert.deepEqual(await page.evaluate(() => window.fixture.requests), []);
      assert.equal(await page.getByRole('button', { name: '연결 유지', exact: true }).evaluate(el => el === document.activeElement), true);
      if (evidence) await page.screenshot({ path: `${evidence}/${name}-confirm.png` });
      await page.getByRole('button', { name: '연결 유지', exact: true }).tap();
      await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(await page.evaluate(() => window.fixture.requests), []);
      assert.equal(await disconnect.evaluate(el => el === document.activeElement), true);
      await disconnect.tap(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(await page.evaluate(() => window.fixture.requests), []);
      await disconnect.tap();
      await page.evaluate(() => { window.fixture.hold = true; });
      await page.getByRole('button', { name: '연결 해제 확인', exact: true }).tap();
      assert.equal(await page.getByRole('button', { name: '해제 중…', exact: true }).isDisabled(), true);
      assert.deepEqual(await page.evaluate(() => window.fixture.requests), ['host-1']);
      await page.evaluate(() => window.fixture.release());
      await page.getByTestId('remote-connection-settings').waitFor({ state: 'detached' });

      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.locator('summary').tap();
      await page.getByRole('button', { name: '아젠투지 3호-회사 연결 해제', exact: true }).tap();
      await page.getByRole('dialog').waitFor();
      assert.match(await page.getByRole('dialog').innerText(), /아젠투지 3호-회사/);
      await page.getByRole('button', { name: '연결 해제 확인', exact: true }).tap();
      await page.getByRole('button', { name: '아젠투지 3호-회사 연결 해제', exact: true }).waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => window.fixture.requests), ['host-3']);
      assert.equal(await page.getByRole('button', { name: '아젠투지 1호 연결 해제', exact: true }).isVisible(), true);
      assert.deepEqual(errors, []);
      console.log(`${name}: collapsed setting / refresh / named confirmation / cancel / Escape / touch / single dispatch / per-device isolation PASS`);
    } finally { await browser.close(); }
  }
} finally { server.stop(true); }
