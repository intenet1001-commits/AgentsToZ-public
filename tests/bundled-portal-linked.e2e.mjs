// 「폰 연결 링크」 state of the app's bundled portal: Supabase configured (as the link does), NO paired Mac.
// Email-code sign-in → synced data (프로젝트 현황) works; 원격 작업 shows a clear view-only state with how to
// pair, not an error. Fixture Supabase only; no real account, relay or Mac is touched.
// Build: bun mobile/ios/scripts/build-portal-web.ts   Run: bun tests/bundled-portal-linked.e2e.mjs [screenshotDir]
import { webkit } from 'playwright';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildPhoneConnectLink, parsePhoneConnectLink } from '../src/phoneConnectLink.ts';

const root = resolve(process.env.BUNDLED_PORTAL_DIST ?? 'mobile/ios/build/portal-web');
const shots = process.argv[2] || '';
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const anon = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', iss: 'supabase' })}.c2lnbmF0dXJlc2lnbmF0dXJl`;
// Exactly what the app injects after applying a link (LANWorkroomSession(linked:) → BundledPortalConfig).
const link = parsePhoneConnectLink(buildPhoneConnectLink({ portalOrigin: 'https://portal.example', supabaseUrl: 'https://fixture-linked.supabase.co', anonKey: anon, hostName: 'Fixture Mac' }));
const config = { portalOrigin: link.portalOrigin, supabaseUrl: link.supabaseUrl, supabaseAnonKey: link.anonKey };
const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const session = () => ({ access_token: 'fixture-access-token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fixture-refresh-token', user });
const device = '11111111-2222-4333-8444-555555555555';

const browser = await webkit.launch();
try {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 } });
  const page = await context.newPage();
  const errors = [], supabaseHosts = new Set(), foreign = [], relay = [];
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
      if (url.pathname.includes('remote_control') || url.pathname.includes('relay')) relay.push(url.pathname);
      if (url.pathname === '/auth/v1/otp') return route.fulfill({ json: {} });
      if (url.pathname === '/auth/v1/verify') return route.fulfill({ json: session() });
      if (url.pathname === '/auth/v1/user') return route.fulfill({ json: user });
      if (url.pathname === '/auth/v1/settings') return route.fulfill({ json: { external: { google: true, email: true } } });
      if (url.pathname === '/rest/v1/rpc/portmgr_is_member') return route.fulfill({ json: true });
      if (url.pathname === '/rest/v1/portmgr_devices') return route.fulfill({ json: [{ id: device, name: 'Fixture Mac', last_push_at: new Date().toISOString() }] });
      if (url.pathname === '/rest/v1/portmgr_ports') return route.fulfill({ json: [{ id: 'p1', device_id: device, name: 'Linked Fixture Project', port: 5173, favorite: false }] });
      return route.fulfill({ json: [] });
    }
    foreign.push(url.origin); return route.abort();
  });

  await page.goto('https://bundled.test/remote/');
  // 원격 작업: view-only state with the steps to pair — not an error, not a login wall.
  await page.locator('button[data-workspace-tab="workroom"]').click();
  const viewOnly = page.getByTestId('remote-view-only');
  await viewOnly.waitFor({ timeout: 15_000 });
  assert.match(await viewOnly.textContent(), /보기 전용 · Mac 제어는 Mac 앞에서 QR 승인 후/);
  assert.equal(await page.getByTestId('remote-view-only-steps').locator('li').count(), 3);
  assert.equal(await page.getByRole('alert').count(), 0, 'no error in the linked-not-paired state');
  if (shots) await page.screenshot({ path: `${shots}/bundled-linked-view-only.png` });

  // 프로젝트 현황: email-code sign-in, then the synced data.
  await page.locator('button[data-workspace-tab="projects"]').click();
  const box = page.getByTestId('portal-email-login');
  await box.waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole('button', { name: 'Google 계정으로 계속' }).count(), 0, 'the app signs in with an emailed code only');
  await box.getByLabel('이메일 코드로 로그인').fill('owner@example.com');
  await box.getByRole('button', { name: '코드 받기', exact: true }).click();
  const code = box.getByLabel('owner@example.com로 보낸 코드');
  await code.waitFor();
  await code.fill('12345678');
  await box.getByRole('button', { name: '로그인', exact: true }).click();
  // The synced device list comes from the linked project; picking the Mac shows its synced projects.
  const deviceButton = page.locator('button:visible', { hasText: '프로젝트 1개' }).filter({ hasText: 'Fixture Mac' }).first();
  await deviceButton.waitFor({ timeout: 15_000 });
  await deviceButton.click();
  await page.getByText('Linked Fixture Project').first().waitFor({ timeout: 15_000 });
  if (shots) await page.screenshot({ path: `${shots}/bundled-linked-projects.png` });

  // Still view-only for control after signing in; the same session is used, nothing reaches a relay.
  await page.locator('button[data-workspace-tab="workroom"]').click();
  await viewOnly.waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual([...supabaseHosts], ['fixture-linked.supabase.co'], 'only the linked Supabase project is contacted');
  assert.deepEqual(relay, [], 'no pairing or relay call without a QR');
  assert.deepEqual(foreign, []);
  assert.deepEqual(errors, []);
  console.log('bundled portal (linked, not paired): view-only workroom / email sign-in / synced projects PASS');
} finally { await browser.close(); }
