// The same-Wi‑Fi QR page (src/remoteControlMobilePage.ts) has no transit, so attachments are internet-only. A file dragged
// onto its terminal panel must SAY so — through the browser's real drag pipeline, not by calling `ondrop` directly: with
// dropEffect 'none' a real browser ends the drag as failed and never dispatches `drop`, so a notice written only there was
// never shown (review w13). Chromium's CDP Input.dispatchDragEvent drives that pipeline; a text drag must stay silent and
// the page must never be navigated to the file.
//
// Isolated: the page's own assets served in-process; no Mac, no 3001, no network.
// Run: bun tests/remote-control-mobile-attach-drop.e2e.mjs
import { chromium } from 'playwright';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteControlMobileAsset } from '../src/remoteControlMobilePage.ts';

const NOTICE = '첨부는 인터넷 연결에서만 할 수 있습니다';
const dir = mkdtempSync(join(tmpdir(), 'lan-drop-'));
const file = join(dir, 'dropped.pdf');
writeFileSync(file, '%PDF-1.7\n%%EOF\n');
const failures = [];
const browser = await chromium.launch();
try {
  for (const kind of ['file', 'text']) {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const errors = [], navigations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://lan.test') return route.abort();
      const asset = remoteControlMobileAsset(url.pathname);
      return asset ? route.fulfill({ body: asset.body, contentType: asset.contentType }) : route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://lan.test/remote/');
    await page.waitForFunction(() => typeof document.querySelector('#terminal-panel')?.ondragover === 'function', null, { timeout: 10_000 });
    // The page keeps the workspace hidden until paired: show the panel where the drag lands.
    const at = await page.evaluate(() => {
      const panel = document.querySelector('#terminal-panel');
      for (let el = panel; el; el = el.parentElement) el.hidden = false;
      Object.assign(panel.style, { position: 'fixed', left: '0px', top: '0px', width: '600px', height: '400px', zIndex: '2147483647', display: 'block' });
      document.querySelector('#terminal-error').textContent = '';
      const r = panel.getBoundingClientRect();
      return { x: Math.round(r.left + 40), y: Math.round(r.top + 40) };
    });
    const before = navigations.length;
    const cdp = await page.context().newCDPSession(page);
    const data = kind === 'file' ? { items: [], files: [file], dragOperationsMask: 1 | 2 | 16 }
      : { items: [{ mimeType: 'text/plain', data: '그냥 글' }], dragOperationsMask: 1 | 2 | 16 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
    await page.waitForTimeout(400);
    const said = await page.evaluate(() => document.querySelector('#terminal-error')?.textContent ?? '');
    if (kind === 'file' && said !== NOTICE) failures.push(`a real file drag on the terminal panel says 「${said}」, not 「${NOTICE}」`);
    if (kind === 'text' && said) failures.push(`a text drag said 「${said}」`);
    if (navigations.length !== before || !page.url().startsWith('http://lan.test/remote/')) failures.push(`${kind}: the drop navigated the page to ${page.url()}`);
    if (errors.length) failures.push(`${kind}: page errors: ${errors.join(' | ')}`);
    await page.close();
  }
} finally { await browser.close(); rmSync(dir, { recursive: true, force: true }); }
if (failures.length) { console.error(`\n${failures.length} LAN drop failure(s):\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('LAN page attachment drop: all checks passed');
