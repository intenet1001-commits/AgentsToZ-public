// Run against a public-fixture portal build; no real accounts or login reset.
import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const root = resolve(process.env.NAV_FIXTURE_DIST ?? '/tmp/agentstoz-nav-fixture-dist');
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch();
  try {
    for (const scenario of ['retry', 'direct', 'disabled', 'native']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
      const page = await context.newPage();
      let mode = scenario === 'retry' ? 'stall' : scenario === 'direct' ? 'network' : scenario;
      let checks = 0;
      const navigations = [], errors = [];
      await page.addInitScript(({ native }) => {
        localStorage.setItem('portal-login-fixture', 'keep-my-data');
        localStorage.setItem('portmgr-auth-fixture', 'keep-session-helpers');
        if (native) {
          window.agentstozNativeOAuth = true;
          window.webkit = { messageHandlers: { agentstozOAuth: { postMessage(value) {
            window.nativeLoginRequest = value;
            window.dispatchEvent(new CustomEvent('agentstoz-oauth-result', { detail: { state: value.state, error: 'cancelled' } }));
          } } } };
        }
      }, { native: scenario === 'native' });
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.isNavigationRequest()) navigations.push(request.url()); });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'workspace.example') {
          const filePath = resolve(root, '.' + (url.pathname === '/' ? '/portal.html' : url.pathname));
          if (!filePath.startsWith(root + '/')) return route.abort();
          const file = Bun.file(filePath);
          return await file.exists()
            ? route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: file.type })
            : route.fulfill({ status: 404, body: '' });
        }
        if (url.hostname !== 'workspace-fixture.supabase.co') return route.abort();
        if (url.pathname === '/auth/v1/settings') {
          checks++;
          if (mode === 'stall') {
            await new Promise(resolve => setTimeout(resolve, 9_000));
          } else if (mode === 'network') return route.abort();
          return route.fulfill({ json: { external: { google: mode !== 'disabled' } } }).catch(() => {});
        }
        if (url.pathname === '/auth/v1/authorize') {
          assert.equal(url.searchParams.get('provider'), 'google');
          assert.equal(url.searchParams.get('code_challenge_method'), 's256');
          assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43,128}$/);
          return route.fulfill({ contentType: 'text/html', body: '<h1>Google login fixture</h1>' });
        }
        return route.fulfill({ json: [] });
      });
      try {
        await page.goto('https://workspace.example/?tab=ports');
        const login = page.getByRole('button', { name: 'Google 계정으로 계속', exact: true });
        await login.waitFor();
        // Simulate the CSS inset value supplied by standalone Safari. Headless
        // WebKit itself does not expose a hardware notch/status bar.
        await page.addStyleTag({ content: ':root { --workspace-safe-top: 44px; }' });
        const top = (await page.locator('.remote-header').boundingBox()).y;
        assert.ok(top >= 44 + 20, `status bar has inset plus spacing: ${top}`);
        assert.ok((await page.locator('.portal-login-build').boundingBox()).y > top + 40);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.setViewportSize({ width: 320, height: 640 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.evaluate(() => scrollTo(0, 100));
        const shield = await page.locator('.workspace-statusbar').boundingBox();
        assert.equal(shield.y, 0);
        assert.equal(shield.height, 44, 'status-bar surface covers the full inset while scrolling');
        assert.equal(await page.locator('.workspace-statusbar').evaluate(el => getComputedStyle(el).position), 'fixed');
        await page.evaluate(() => scrollTo(0, 0));
        await page.setViewportSize({ width: 390, height: 844 });
        await login.evaluate(button => { button.click(); button.click(); });
        if (scenario === 'native') {
          await page.waitForFunction(() => !!window.nativeLoginRequest);
          const request = await page.evaluate(() => window.nativeLoginRequest);
          assert.match(new URL(request.authorizeURL).searchParams.get('redirect_to'), /^agentstoz-mobile:\/\/auth\/callback\?state=/);
          await page.getByRole('alert').filter({ hasText: '취소' }).waitFor();
          assert.equal(navigations.length, 1, 'native login uses the system bridge, retaining WKWebView');
        } else {
          const retry = page.getByRole('button', { name: '로그인 다시 시도', exact: true });
          await retry.waitFor({ timeout: 12_000 });
          assert.equal(navigations.length, 1, 'readiness failure keeps the current screen');
          assert.equal(checks, 1);
          assert.equal(await page.getByRole('button', { name: '이 기기 로그인 초기화', exact: true }).count(), 0);
          assert.equal(await page.evaluate(() => localStorage.getItem('portmgr-auth-fixture')), 'keep-session-helpers');
          assert.equal(await page.evaluate(() => localStorage.getItem('portal-login-fixture')), 'keep-my-data');
          const direct = page.getByRole('button', { name: 'Google 로그인 페이지로 이동', exact: true });
          if (scenario === 'disabled') {
            assert.equal(await direct.count(), 0, 'disabled provider is not treated as a connection failure');
          } else {
            if (scenario === 'retry') {
              await page.screenshot({ path: `/tmp/agentstoz-login-${name}.png`, fullPage: true });
              mode = 'healthy';
              await retry.click();
            } else await direct.click();
            await page.getByRole('heading', { name: 'Google login fixture' }).waitFor();
            assert.equal(checks, scenario === 'retry' ? 2 : 1, 'retry repeats OAuth; direct choice skips only readiness');
            assert.equal(navigations.length, 2);
          }
        }
        assert.deepEqual(errors, []);
        console.log(`${name}: ${scenario} / preserved data / safe area / mobile width PASS`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
