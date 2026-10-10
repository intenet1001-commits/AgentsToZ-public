// The portal bundled in the iPhone app: built WITHOUT VITE_SUPABASE_*, served from an origin other
// than the portal's, configured only by the injected window.agentstozBundledPortal (as the app does).
// Build: bun mobile/ios/scripts/build-portal-web.ts   Run: bun tests/bundled-portal-runtime.e2e.mjs
// Fixture Supabase only; no real account or relay is touched.
import { webkit } from 'playwright';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildRemoteControlRelayPairingUrl, REMOTE_CONTROL_RELAY_SCHEMA_VERSION } from '../src/remoteControlRelayContract.ts';

const root = resolve(process.env.BUNDLED_PORTAL_DIST ?? 'mobile/ios/build/portal-web');
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const anon = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', iss: 'supabase' })}.c2lnbmF0dXJlc2lnbmF0dXJl`;
const config = { portalOrigin: 'https://portal.example', supabaseUrl: 'https://fixture-bundled.supabase.co', supabaseAnonKey: anon };
const key = new Uint8Array(65); key[0] = 4;
const pairingUrl = buildRemoteControlRelayPairingUrl('https://portal.example/remote/', {
  schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId: 'host_abcdefghijklmnop', pairingId: 'pair_abcdefghijklmnop',
  pairingSecret: Buffer.alloc(32, 7).toString('base64url'), hostPublicKey: Buffer.from(key).toString('base64url'),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), supabase: { url: config.supabaseUrl, anonKey: anon },
});
const fragment = new URL(pairingUrl).hash;

const browser = await webkit.launch();
try {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 } });
  const page = await context.newPage();
  const errors = [], supabaseHosts = new Set(), foreign = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(value => { Object.defineProperty(window, 'agentstozBundledPortal', { value: Object.freeze(value), writable: false }); }, config);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'bundled.test') {
      const path = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
      if (!path.startsWith(root + '/')) return route.abort();
      const file = Bun.file(path);
      return await file.exists() ? route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: file.type }) : route.fulfill({ status: 404, body: '' });
    }
    if (url.hostname.endsWith('.supabase.co')) {
      supabaseHosts.add(url.hostname);
      if (url.pathname === '/auth/v1/otp') return route.fulfill({ json: {} });
      if (url.pathname === '/auth/v1/settings') return route.fulfill({ json: { external: { google: true, email: true } } });
      return route.fulfill({ json: [] });
    }
    foreign.push(url.origin); return route.abort();
  });
  await page.goto('https://bundled.test/remote/' + fragment);
  await page.locator('button[data-workspace-tab="workroom"]').click();
  await page.getByRole('heading', { name: '이메일로 로그인' }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByText('개인 배포 설정이 필요합니다').count(), 0, 'runtime config replaces the build-time Supabase values');
  assert.equal(await page.getByTestId('remote-view-only').count(), 0, 'the QR for the portal origin is accepted on the app origin');
  assert.ok(await page.getByTestId('portal-email-login').isVisible(), 'email code sign-in is offered');
  assert.equal(await page.getByRole('button', { name: 'Google 계정으로 계속' }).count(), 0, 'the app signs in with an emailed code only');
  assert.ok(await page.getByRole('heading', { name: '이메일로 로그인' }).isVisible());
  await page.getByTestId('portal-email-login').getByLabel('이메일 코드로 로그인').fill('owner@example.com');
  await page.getByTestId('portal-email-login').getByRole('button', { name: '코드 받기', exact: true }).click();
  await page.getByTestId('portal-email-login').getByText('owner@example.com로 보낸 코드').waitFor();
  assert.deepEqual([...supabaseHosts], ['fixture-bundled.supabase.co'], 'only the injected Supabase project is contacted');
  assert.deepEqual(foreign, []);
  assert.deepEqual(errors, []);
  console.log('bundled portal: runtime config / foreign-origin QR / sign-in screen PASS');
} finally { await browser.close(); }
