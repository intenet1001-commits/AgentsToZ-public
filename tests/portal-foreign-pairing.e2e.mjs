// Web portal (non-bundled) opened by a phone CAMERA scan of a QR from a Mac on ANOTHER Supabase
// project (app-only self-hosters share the public default origin). The page must show
// 「이 QR은 다른 사용자의 AgentsToZ(자기 Supabase)용입니다…」 and send NOTHING to its own
// Supabase or relay. A QR for its own project, or one without `supabase`, keeps today's page.
// Isolated: a portal build with fixture VITE_* values, routed by Playwright; no real network.
// Build: VITE_SUPABASE_URL=https://own-project.supabase.co VITE_SUPABASE_ANON_KEY=<jwt-shaped> \
//          ./node_modules/.bin/vite build --config vite.portal.config.ts --outDir <dir>
// Run:   bun tests/portal-foreign-pairing.e2e.mjs <dir> [screenshotDir]
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildRemoteControlRelayPairingUrl, REMOTE_CONTROL_RELAY_SCHEMA_VERSION } from '../src/remoteControlRelayContract.ts';

const root = resolve(process.argv[2] || 'dist-portal');
const shots = process.argv[3] || '';
const OWN = 'https://own-project.supabase.co';
const OTHER = 'https://friend-project.supabase.co';
const PAGE = 'https://portal.test';
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const anon = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', iss: 'supabase' })}.c2lnbmF0dXJlc2lnbmF0dXJl`;
const key = new Uint8Array(65); key[0] = 4;
const pairingUrl = supabaseUrl => buildRemoteControlRelayPairingUrl(`${PAGE}/remote/`, {
  schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId: 'host_abcdefghijklmnop', pairingId: 'pair_abcdefghijklmnop',
  pairingSecret: Buffer.alloc(32, 7).toString('base64url'), hostPublicKey: Buffer.from(key).toString('base64url'),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...(supabaseUrl ? { supabase: { url: supabaseUrl, anonKey: anon } } : {}),
});

const browser = await chromium.launch();
try {
  for (const [name, qrSupabase, expectGuard] of [['foreign', OTHER, true], ['own', OWN, false], ['legacy', null, false]]) {
    const context = await browser.newContext({ viewport: { width: 402, height: 874 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [], supabase = [], other = [];
    page.on('pageerror', e => errors.push(e.message));
    // A signed-in-but-expired portal session: the normal page refreshes it against its own
    // Supabase, which proves the guard (not an idle page) is what keeps the foreign case silent.
    await page.addInitScript(() => {
      const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
      localStorage.setItem('portmgr-auth', JSON.stringify({ access_token: 'expired', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) - 60, refresh_token: 'fixture-refresh', user }));
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === PAGE) {
        const path = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
        if (!path.startsWith(root + '/')) return route.abort();
        const file = Bun.file(path);
        return await file.exists() ? route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: file.type }) : route.fulfill({ status: 404, body: '' });
      }
      if (url.hostname.endsWith('.supabase.co')) { supabase.push(`${url.hostname}${url.pathname}`); return route.fulfill({ json: {} }); }
      other.push(url.origin); return route.abort();
    });
    await page.goto(pairingUrl(qrSupabase));
    if (expectGuard) {
      const guard = page.getByTestId('remote-foreign-pairing');
      await guard.waitFor({ timeout: 15_000 });
      assert.equal(await page.getByTestId('remote-foreign-pairing-title').textContent(),
        '이 QR은 다른 사용자의 AgentsToZ(자기 Supabase)용입니다. iPhone의 AgentsToZ 앱으로 스캔하세요.');
      assert.match(await page.getByTestId('remote-foreign-pairing-app-hint').textContent(), /App Store 또는 TestFlight/);
      await page.waitForTimeout(1_500);
      assert.deepEqual(supabase, [], `foreign QR must not touch the portal's Supabase/relay: ${supabase.join(', ')}`);
      assert.equal(await page.locator('input[type="email"]').count(), 0, 'no login on the guard page');
      // The fragment (pairing secret) is not left in the address bar.
      assert.equal(new URL(page.url()).hash, '');
      if (shots) await page.screenshot({ path: `${shots}/portal-foreign-pairing.png` });
    } else {
      await page.locator('.remote-shell, [data-testid="remote-build-stamp"]').first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1_000);
      assert.equal(await page.getByTestId('remote-foreign-pairing').count(), 0, `${name}: normal page`);
      assert.ok(supabase.length > 0, `${name}: the normal page does talk to its own Supabase (control for the foreign case)`);
    }
    assert.deepEqual(errors, [], `${name}: page errors`);
    await context.close();
    console.log(`ok ${name}${expectGuard ? ' (guard, 0 Supabase requests)' : ` (normal page, ${supabase.length} Supabase requests)`}`);
  }
} finally {
  await browser.close();
}
