/** The portal QR scanner does not hammer a refused QR that stays in view (w5 review of the audit 2026-10-16 fix).
 *
 * A decoded value that was refused is not tried again while it stays in front of the camera: a refusal of the QR
 * itself (PortalRemoteQrError) for as long as the scanner is open, and any other failure (the app's 「연결 준비
 * 중입니다…」, a vault write that failed) once every PORTAL_QR_RETRY_AFTER_MS (2.5 s) — so a transient app-side failure
 * heals by itself while the QR is held up, without re-running the pairing on every decode (the live scan decodes about
 * every 500 ms). Nothing else checked this: removing the suppression entirely still passed every other test.
 * This bundles the real scanner (tests/fixtures/portal-qr-scanner-retry.tsx) with a stub camera that shows a real
 * pairing QR for this page's origin, and counts the accept attempts, in WebKit and Chromium.
 * Self-contained: Bun.build, served to the page by request interception on a fake https origin (a pairing QR names an
 * HTTPS portal). No app, no sidecar, no 3001, no Supabase, no network.
 * Usage: bun tests/portal-qr-scanner-retry.e2e.mjs
 */
import {chromium, webkit} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QRCodeSVG} from 'qrcode.react';
import {buildRemoteControlRelayPairingUrl, REMOTE_CONTROL_RELAY_SCHEMA_VERSION} from '../src/remoteControlRelayContract.ts';
import {PORTAL_QR_RETRY_AFTER_MS} from '../src/PortalRemoteQrScanner.tsx';

const built = await Bun.build({entrypoints: [join(import.meta.dir, 'fixtures', 'portal-qr-scanner-retry.tsx')], target: 'browser', format: 'esm',
  // The scanner reads the portal's build-time Supabase settings through portalRuntimeConfig; this page has none.
  define: {'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_SUPABASE_URL': '""', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '""'}});
if (!built.success) throw Error('bundle failed: ' + built.logs.map(log => log.message).join('; '));
const js = await built.outputs.find(output => output.path.endsWith('.js')).text();
const css = await (built.outputs.find(output => output.path.endsWith('.css'))?.text() ?? '');
const origin = 'https://scanner.test';
const html = '<!doctype html><html data-app-theme="gray"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
const serve = async route => {
  const url = new URL(route.request().url());
  if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
  if (url.origin !== origin) return route.abort();
  if (url.pathname === '/app.js') return route.fulfill({body: js, contentType: 'text/javascript; charset=utf-8'});
  if (url.pathname === '/app.css') return route.fulfill({body: css, contentType: 'text/css; charset=utf-8'});
  return route.fulfill({body: html, contentType: 'text/html; charset=utf-8'});
};
const key = new Uint8Array(65); key[0] = 4;
const pairingUrl = buildRemoteControlRelayPairingUrl(`${origin}/remote/`, {
  schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId: 'host_abcdefghijklmnop', pairingId: 'pair_abcdefghijklmnop',
  // A fixed secret whose rendered QR the stub camera decodes reliably in both engines (zxing misses a few perfectly
  // synthetic grids; the camera itself is not under test here).
  pairingSecret: Buffer.alloc(32, 9).toString('base64url'), hostPublicKey: Buffer.from(key).toString('base64url'),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});
const svg = renderToStaticMarkup(React.createElement(QRCodeSVG, {value: pairingUrl, level: 'Q', marginSize: 4}));
const qr = {size: Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)[1]), d: /fill="#000000" d="([^"]+)"/.exec(svg)[1]};

// A stub rear camera (as in tests/portal-qr-scanner-camera.e2e.mjs) that shows `window.__qr` when set.
const camera = () => {
  window.__qr = null;
  const ideal = (value, fallback) => (value && typeof value === 'object' && typeof value.ideal === 'number' ? value.ideal : fallback);
  const getUserMedia = async constraints => {
    const video = (constraints && typeof constraints.video === 'object' && constraints.video) || {};
    const canvas = document.createElement('canvas');
    canvas.width = ideal(video.width, 480); canvas.height = ideal(video.height, 640);
    const context = canvas.getContext('2d');
    const draw = () => {
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      const code = window.__qr; if (!code) return;
      const scale = Math.floor((Math.min(canvas.width, canvas.height) * 0.8) / code.size), side = scale * code.size;
      context.save(); context.translate(Math.round((canvas.width - side) / 2), Math.round((canvas.height - side) / 2)); context.scale(scale, scale);
      context.fillStyle = '#000'; context.fill(new Path2D(code.d)); context.restore();
    };
    draw(); setInterval(draw, 100);
    return canvas.captureStream(10);
  };
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {configurable: true, writable: true, value: getUserMedia});
};

async function hold(page, ms) {
  await page.evaluate(code => { window.__qr = code; }, qr);
  await page.waitForFunction(() => window.__detected.length > 0, null, {timeout: 15_000})
    .catch(async error => { throw new Error(`nothing was accepted (scanner says: ${await page.locator('.portal-qr-scanner').innerText().catch(() => '?')})`, {cause: error}); });
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__detected.slice());
}

try {
  for (const [name, engine] of [['webkit', webkit], ['chromium', chromium]]) {
    const browser = await engine.launch({headless: true});
    try {
      for (const refuseAs of ['app', 'qr']) {
        const context = await browser.newContext({viewport: {width: 390, height: 844}});
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', serve);
        await page.addInitScript(camera);
        await page.addInitScript(value => { window.__refuseAs = value; }, refuseAs);
        await page.goto(origin + '/');
        await page.getByTestId('open-scanner').click();
        await page.waitForFunction(() => document.querySelector('.portal-qr-scanner__camera video')?.videoWidth > 0, null, {timeout: 15_000});
        if (refuseAs === 'app') {
          // Held in view for most of one window: the refused value is not tried again (it decodes about every 500 ms).
          const early = await hold(page, PORTAL_QR_RETRY_AFTER_MS - 700);
          assert.equal(early.length, 1, `${name}: an app-side refusal was retried ${early.length - 1} time(s) within ${PORTAL_QR_RETRY_AFTER_MS} ms`);
          // Then once per window while it stays in view, so a not-ready app heals by itself.
          await page.waitForTimeout(2 * PORTAL_QR_RETRY_AFTER_MS + 700);
          const attempts = await page.evaluate(() => window.__detected.slice());
          assert.ok(attempts.length >= 2 && attempts.length <= 4, `${name}: ${attempts.length} attempts in ~${3 * PORTAL_QR_RETRY_AFTER_MS} ms`);
          for (let i = 1; i < attempts.length; i += 1)
            assert.ok(attempts[i] - attempts[i - 1] >= PORTAL_QR_RETRY_AFTER_MS - 50, `${name}: attempts ${Math.round(attempts[i] - attempts[i - 1])} ms apart`);
          assert.match(await page.locator('.portal-qr-scanner [role="alert"]').textContent(), /연결 준비 중/);
          console.log(`${name}: an app-side refusal held in view: ${attempts.length} attempts, ≥ ${PORTAL_QR_RETRY_AFTER_MS} ms apart`);
        } else {
          const attempts = await hold(page, 3 * PORTAL_QR_RETRY_AFTER_MS);
          assert.equal(attempts.length, 1, `${name}: a refused QR was tried ${attempts.length} times while it stayed in view`);
          assert.match(await page.locator('.portal-qr-scanner [role="alert"]').textContent(), /다른 연결용/);
          console.log(`${name}: a refused QR held in view for ${3 * PORTAL_QR_RETRY_AFTER_MS} ms: tried once`);
        }
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  }
  console.log('portal QR scanner refusal retry PASS');
} catch (error) { console.error(error); process.exitCode = 1; }
