// The app's bundled portal: its in-page QR scanner (「작업 기기 연결 · QR 스캔」 → PortalRemoteQrScanner).
// Measured on iPhone 17 Pro (iOS 26.6, WKWebView): asked only for the rear camera, WebKit gave a 480×640
// track; the Mac's ~862-character pairing QR then had 1–2 px modules, zxing never decoded it and the
// page said nothing. This checks, in WebKit with a stubbed camera:
//   1. the stream request asks for a 1080p-class rear camera (ideal, not exact);
//   2. a live camera that decodes nothing shows a hint after ~8 s, and the scanner stays open;
//   3. a dense pairing QR (rendered like the Mac's: level Q, margin 4) decodes from the live stream,
//      and one for ANOTHER Supabase project is refused with the path the app really offers
//      (「연결 설정」 → 「다른 연결 QR 스캔」), which also clears the hint;
//   4. after that refusal the live camera is still scanning: another QR held up next decodes (the camera used
//      to be stopped before the QR was accepted and never restarted, leaving a black preview);
//   5. a photo with no QR in it is refused, and the live camera comes back and decodes the next QR.
// Fixture Supabase only; no real account, relay, camera or Mac is touched.
// Build: bun mobile/ios/scripts/build-portal-web.ts   Run: bun tests/portal-qr-scanner-camera.e2e.mjs [screenshotDir]
import { webkit } from 'playwright';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import { buildPhoneConnectLink, parsePhoneConnectLink } from '../src/phoneConnectLink.ts';
import { buildRemoteControlRelayPairingUrl, REMOTE_CONTROL_RELAY_SCHEMA_VERSION } from '../src/remoteControlRelayContract.ts';

const root = resolve(process.env.BUNDLED_PORTAL_DIST ?? 'mobile/ios/build/portal-web');
const shots = process.argv[2] || '';
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
// Shaped like a real Supabase anon JWT (~200 chars), so the QR is about as dense as the Mac's (~862 chars).
const anon = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'anon', iat: 1700000000, exp: 2015576000 })}.${'s'.repeat(43)}`;
const link = parsePhoneConnectLink(buildPhoneConnectLink({ portalOrigin: 'https://portal.example', supabaseUrl: 'https://fixture-linked.supabase.co', anonKey: anon, hostName: 'Fixture Mac' }));
const config = { portalOrigin: link.portalOrigin, supabaseUrl: link.supabaseUrl, supabaseAnonKey: link.anonKey };

// A real-shaped pairing QR for the same portal but another Supabase project.
const key = new Uint8Array(65); key[0] = 4;
const pairingUrl = buildRemoteControlRelayPairingUrl(`${config.portalOrigin}/remote/`, {
  schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId: 'host_abcdefghijklmnop', pairingId: 'pair_abcdefghijklmnop',
  pairingSecret: Buffer.alloc(32, 7).toString('base64url'), hostPublicKey: Buffer.from(key).toString('base64url'),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), supabase: { url: 'https://other-project.supabase.co', anonKey: anon },
});
const toQr = value => {
  const svg = renderToStaticMarkup(React.createElement(QRCodeSVG, { value, level: 'Q', marginSize: 4 }));
  return { size: Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)[1]), d: /fill="#000000" d="([^"]+)"/.exec(svg)[1] };
};
const qr = toQr(pairingUrl);
// Two QRs that are not AgentsToZ pairing QRs: each is refused at once, so a changed message proves a live decode.
const notOurs = toQr('https://example.com/not-agentstoz');
const another = toQr('https://example.com/another-qr');
const NOT_OURS = 'AgentsToZ 원격제어 QR이 아닙니다.';

const browser = await webkit.launch();
try {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 } });
  const page = await context.newPage();
  const errors = [], supabaseHosts = new Set(), relay = [], foreign = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(value => { Object.defineProperty(window, 'agentstozBundledPortal', { value: Object.freeze(value), writable: false }); }, config);
  // A stub camera that honours the requested size the way a phone would, falling back to the 480×640
  // portrait track WebKit gave on the iPhone when no size was asked for. It shows `window.__qr` when set.
  await page.addInitScript(() => {
    window.__qrConstraints = [];
    window.__qr = null;
    const ideal = (value, fallback) => (value && typeof value === 'object' && typeof value.ideal === 'number' ? value.ideal : fallback);
    const getUserMedia = async constraints => {
      window.__qrConstraints.push(JSON.parse(JSON.stringify(constraints ?? null)));
      const video = (constraints && typeof constraints.video === 'object' && constraints.video) || {};
      const canvas = document.createElement('canvas');
      canvas.width = ideal(video.width, 480); canvas.height = ideal(video.height, 640);
      const context = canvas.getContext('2d');
      const draw = () => {
        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
        const code = window.__qr;
        if (!code) return;
        // Whole pixels per module: a fractional scale leaves anti-aliasing seams between the path's rows,
        // which no real camera frame has.
        const scale = Math.floor((Math.min(canvas.width, canvas.height) * 0.8) / code.size);
        const side = scale * code.size;
        context.save();
        context.translate(Math.round((canvas.width - side) / 2), Math.round((canvas.height - side) / 2));
        context.scale(scale, scale);
        context.fillStyle = '#000'; context.fill(new Path2D(code.d));
        context.restore();
      };
      draw(); setInterval(draw, 100);
      return canvas.captureStream(10);
    };
    // On the prototype: WebKit can drop an expando set on the `navigator.mediaDevices` wrapper itself.
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { configurable: true, writable: true, value: getUserMedia });
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    // The chosen photo is read from a page-local blob: URL (WebKit routes it too); it never leaves the page.
    if (url.protocol === 'blob:') return route.continue();
    if (url.hostname === 'bundled.test') {
      const path = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
      if (!path.startsWith(root + '/')) return route.abort();
      const file = Bun.file(path);
      return await file.exists() ? route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: file.type }) : route.fulfill({ status: 404, body: '' });
    }
    if (url.hostname.endsWith('.supabase.co')) {
      supabaseHosts.add(url.hostname);
      if (url.pathname.includes('remote_control') || url.pathname.includes('relay')) relay.push(url.pathname);
      if (url.pathname === '/auth/v1/settings') return route.fulfill({ json: { external: { google: true, email: true } } });
      return route.fulfill({ json: [] });
    }
    foreign.push(url.origin); return route.abort();
  });

  await page.goto('https://bundled.test/remote/');
  await page.locator('button[data-workspace-tab="workroom"]').click();
  await page.getByTestId('remote-view-only').waitFor({ timeout: 15_000 });
  await page.getByTestId('remote-view-only-scan').click();
  const scanner = page.getByRole('dialog', { name: '원격제어 QR 스캔' });
  await scanner.waitFor({ timeout: 10_000 });

  // 1. The camera request.
  await page.waitForFunction(() => window.__qrConstraints.length > 0, null, { timeout: 10_000 });
  const opened = Date.now();
  const [constraints] = await page.evaluate(() => window.__qrConstraints);
  assert.equal(constraints.audio, false);
  assert.deepEqual(constraints.video.facingMode, { ideal: 'environment' });
  assert.ok(constraints.video.width?.ideal >= 1920, `width ideal ≥ 1920: ${JSON.stringify(constraints.video)}`);
  assert.ok(constraints.video.height?.ideal >= 1080, `height ideal ≥ 1080: ${JSON.stringify(constraints.video)}`);
  for (const value of [constraints.video.width, constraints.video.height]) assert.deepEqual(Object.keys(value), ['ideal'], 'ideal only, never exact/min');
  await page.waitForFunction(() => document.querySelector('.portal-qr-scanner__camera video')?.videoWidth > 0, null, { timeout: 10_000 });
  const track = await page.evaluate(() => { const v = document.querySelector('.portal-qr-scanner__camera video'); return { w: v.videoWidth, h: v.videoHeight }; });
  console.log(`requested ${JSON.stringify(constraints.video)} → stub track ${JSON.stringify(track)}`);

  // 2. Nothing decodes: no hint early, a hint after ~8 s, the scanner stays open.
  const hint = page.getByTestId('portal-qr-scanner-slow-hint');
  await page.waitForTimeout(4_000);
  assert.equal(await hint.count(), 0, 'no hint while the scan has just started');
  await hint.waitFor({ timeout: 10_000 });
  const shownAfter = Date.now() - opened;
  assert.ok(shownAfter >= 7_000, `hint shown after ${shownAfter} ms`);
  const hintText = await hint.textContent();
  assert.match(hintText, /가까이/);
  assert.match(hintText, /「QR 사진 선택」/);
  assert.ok(await scanner.isVisible(), 'the scanner is not closed by the hint');
  assert.equal(await scanner.getByRole('alert').count(), 0, 'the hint is advice, not an error');
  if (shots) await page.screenshot({ path: `${shots}/portal-qr-scanner-slow-hint.png` });
  console.log(`no decode: hint after ${shownAfter} ms, scanner still open`);

  // 3. The Mac's dense QR (another Supabase project) decodes from the live stream and is refused with the reachable path.
  await page.evaluate(code => { window.__qr = code; }, qr);
  const message = scanner.getByRole('alert');
  await message.waitFor({ timeout: 15_000 });
  const refused = await message.textContent();
  assert.match(refused, /other-project\.supabase\.co/);
  assert.match(refused, /오른쪽 위 「연결 설정」의 「다른 연결 QR 스캔」/);
  assert.doesNotMatch(refused, /앱 첫 화면/);
  assert.equal(await hint.count(), 0, 'a decode clears the hint');
  if (shots) await page.screenshot({ path: `${shots}/portal-qr-scanner-mismatch.png` });
  console.log(`dense QR (${qr.size} modules incl. margin, ${pairingUrl.length} chars) decoded; mismatch refused with the reachable path`);

  // 4. The refused QR did not end the live scan: another QR held up next decodes.
  const liveTracks = () => page.evaluate(() => {
    const stream = document.querySelector('.portal-qr-scanner__camera video')?.srcObject;
    return stream instanceof MediaStream ? stream.getVideoTracks().filter(track => track.readyState === 'live').length : 0;
  });
  assert.ok(await liveTracks() > 0, 'the camera is still live after the refusal');
  await page.evaluate(code => { window.__qr = code; }, notOurs);
  await page.waitForFunction(text => document.querySelector('.portal-qr-scanner [role="alert"]')?.textContent === text, NOT_OURS, { timeout: 10_000 })
    .catch(async () => { throw new Error(`a second QR was not decoded after the refusal (message: ${await message.textContent()}, live tracks: ${await liveTracks()})`); });
  console.log('after the refusal the camera kept scanning: the next QR decoded');

  // 5. A photo with no QR: refused, then the live camera is back and decodes the next QR.
  await page.evaluate(() => { window.__qr = null; });
  const blank = Buffer.from((await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 64); return c.toDataURL('image/png'); })).split(',')[1], 'base64');
  const gumBefore = await page.evaluate(() => window.__qrConstraints.length);
  await page.setInputFiles('.portal-qr-scanner input[type=file]', { name: 'blank.png', mimeType: 'image/png', buffer: blank });
  await page.waitForFunction(() => /사진에서/.test(document.querySelector('.portal-qr-scanner [role="alert"]')?.textContent ?? ''), null, { timeout: 10_000 })
    .catch(async () => { throw new Error(`the unreadable photo was not refused (message: ${await message.textContent().catch(() => '(none)')}, photo button: ${await scanner.locator('.portal-qr-scanner__photo').textContent()})`); });
  await page.waitForFunction(count => window.__qrConstraints.length > count && document.querySelector('.portal-qr-scanner__camera video')?.videoWidth > 0, gumBefore, { timeout: 10_000 })
    .catch(async () => { throw new Error(`the camera did not come back after the unreadable photo (live tracks: ${await liveTracks()})`); });
  assert.match(await message.textContent(), /사진에서/, 'the photo refusal stays readable while the camera restarts');
  await page.evaluate(code => { window.__qr = code; }, another);
  await page.waitForFunction(text => document.querySelector('.portal-qr-scanner [role="alert"]')?.textContent === text, NOT_OURS, { timeout: 10_000 });
  assert.ok(await scanner.isVisible(), 'the scanner stays open');
  if (shots) await page.screenshot({ path: `${shots}/portal-qr-scanner-after-photo.png` });
  console.log('an unreadable photo is refused; the camera restarts and decodes the next QR');

  assert.deepEqual([...supabaseHosts].filter(host => host !== 'fixture-linked.supabase.co'), [], 'the other project is never contacted');
  assert.deepEqual(relay, [], 'no pairing or relay call for a refused QR');
  assert.deepEqual(foreign, []);
  assert.deepEqual(errors, []);
  console.log('bundled portal QR scanner: hi-res request / slow hint / dense QR + mismatch path / camera kept after refusal and photo PASS');
} finally { await browser.close(); }
