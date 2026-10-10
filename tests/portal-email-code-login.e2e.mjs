// Email one-time-code sign-in on the real portal build, with a fixture Supabase.
// Build: VITE_SUPABASE_URL=https://workspace-fixture.supabase.co VITE_SUPABASE_ANON_KEY=fixture-anon-key \
//   ./node_modules/.bin/vite build --config vite.portal.config.ts --outDir <dir>
// Run:   NAV_FIXTURE_DIST=<dir> bun tests/portal-email-code-login.e2e.mjs
// No real account, mail or Supabase is touched.
import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const root = resolve(process.env.NAV_FIXTURE_DIST ?? '/tmp/agentstoz-nav-fixture-dist');
const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: { provider: 'google' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const session = () => ({ access_token: 'fixture-access-token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fixture-refresh-token', user });

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch();
  try {
    for (const scenario of ['success', 'rate-limited']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
      const page = await context.newPage();
      const errors = [], otp = [], verify = [];
      let membershipChecks = 0;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.hostname === 'workspace.example') {
          const filePath = resolve(root, '.' + (url.pathname === '/' ? '/portal.html' : url.pathname));
          if (!filePath.startsWith(root + '/')) return route.abort();
          const file = Bun.file(filePath);
          return await file.exists()
            ? route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: file.type })
            : route.fulfill({ status: 404, body: '' });
        }
        if (url.hostname !== 'workspace-fixture.supabase.co') return route.abort();
        if (url.pathname === '/auth/v1/otp') {
          otp.push(request.postDataJSON());
          return scenario === 'rate-limited'
            ? route.fulfill({ status: 429, json: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' } })
            : route.fulfill({ json: {} });
        }
        if (url.pathname === '/auth/v1/verify') { verify.push(request.postDataJSON()); return route.fulfill({ json: session() }); }
        if (url.pathname === '/auth/v1/user') return route.fulfill({ json: user });
        if (url.pathname === '/rest/v1/rpc/portmgr_is_member') { membershipChecks++; return route.fulfill({ json: true }); }
        if (url.pathname === '/auth/v1/settings') return route.fulfill({ json: { external: { google: true, email: true } } });
        return route.fulfill({ json: [] });
      });
      await page.goto('https://workspace.example/?tab=ports');
      const box = page.getByTestId('portal-email-login');
      await box.waitFor();
      await box.getByLabel('이메일 코드로 로그인').fill(' Owner@Example.com ');
      await box.getByRole('button', { name: '코드 받기', exact: true }).click();
      if (scenario === 'rate-limited') {
        await box.getByRole('alert').waitFor();
        assert.match(await box.getByRole('alert').textContent(), /발송 한도/);
        assert.equal(await box.getByRole('button', { name: '코드 받기', exact: true }).count(), 1, 'stays on the email step');
      } else {
        const code = box.getByLabel('owner@example.com로 보낸 코드');
        await code.waitFor();
        await code.fill('1234 5678');
        await box.getByRole('button', { name: '로그인', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('[data-testid=portal-email-login]'), null, { timeout: 10_000 });
        assert.equal(verify.length, 1);
        assert.equal(verify[0].email, 'owner@example.com');
        assert.equal(verify[0].token, '12345678', 'spaces in a pasted code are dropped');
        assert.equal(verify[0].type, 'email');
        assert.ok(membershipChecks >= 1, 'the DB allowlist still decides access after a code sign-in');
      }
      assert.equal(otp.length, 1);
      assert.equal(otp[0].email, 'owner@example.com');
      assert.equal(otp[0].create_user, false, 'a code request must never create an account');
      assert.deepEqual(errors, []);
      console.log(`${name}: ${scenario} PASS`);
      await context.close();
    }
  } finally { await browser.close(); }
}
