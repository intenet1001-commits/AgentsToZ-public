/**
 * Served-surface verification for the hung-sidecar fix in ProjectMemoryPanel.
 *
 * The bug: memoryRequest() had no deadline, so when the local API wedged the
 * panel stayed on 「확인하는 중」 forever — remoteState never reached 'error',
 * the retry button never rendered, and the user saw the feature as missing.
 *
 * This renders the REAL memory surface against a deliberately hung synthetic
 * API (requests that never resolve) and asserts the user can still escape.
 * Owned Vite build + synthetic API only — never the live sidecar on 3001.
 *
 * Usage: bun tests/project-memory-hung-sidecar-ui.mjs <viteDistDir> [screenshotDir]
 */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';

const dist = process.argv[2];
if (!dist) throw new Error('Pass an isolated Vite build directory');
const shotDir = process.argv[3] ?? join(process.cwd(), '.agentstoz', 'maintainer', 'ui-evidence');
mkdirSync(shotDir, {recursive: true});

const PROJECT = {
  id: 'fixture-memory-project',
  name: 'mac-health',
  port: 9311,
  folderPath: '/fixture/projects/mac-health',
  isRunning: false,
  favorite: false,
  // The panel early-returns for 'ops'/'unknown'; managed is the ordinary case.
  role: 'managed',
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: req => {
    const path = new URL(req.url).pathname;
    return new Response(Bun.file(join(dist, path === '/' ? 'index.html' : path)));
  },
});

const VIEWPORTS = [
  {label: 'desktop-1440x900', width: 1440, height: 900, isMobile: false},
  {label: 'mobile-390x844', width: 390, height: 844, isMobile: true},
];

let browser;
const results = [];

try {
  browser = await chromium.launch();

  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: {width: vp.width, height: vp.height},
      deviceScaleFactor: 2,
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile,
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    // Hang exactly like a wedged sidecar: accept the request, never answer.
    const hungPaths = new Set(['/api/project-memory/panel-status']);
    let hungCount = 0;

    await page.route('**/*', async route => {
      const req = route.request();
      const u = new URL(req.url());
      if (hungPaths.has(u.pathname)) {
        hungCount += 1;
        return; // never fulfilled — reproduces the deadlocked sidecar
      }
      if (!u.pathname.startsWith('/api/') && u.hostname === '127.0.0.1') return route.continue();

      const values = {
        '/api/ports': [PROJECT],
        '/api/portal': {},
        '/api/workspace-roots': [{id: 'fixture-root', name: '테스트 작업 폴더', path: '/fixture/projects'}],
        '/api/portal/safety-lease/acquire': {success: true, token: 'a'.repeat(64), metadata: {}, fingerprint: portalLocalMetadataFingerprint({}), expiresInMs: 30000},
        '/api/portal/safety-lease/release': {released: true},
        '/api/health': {status: 'ok'},
        '/api/control-profile/status': {success: true, profile: {state: 'ready', projectId: 'fixture-ops-project'}},
        '/api/onboarding/status': {stage: 'ready'},
        '/api/check-port-status': {isRunning: false},
      };
      return route.fulfill({
        status: Object.hasOwn(values, u.pathname) ? 200 : 503,
        contentType: 'application/json',
        body: JSON.stringify(values[u.pathname] ?? {error: 'fixture blocked'}),
      });
    });

    await page.goto(`http://127.0.0.1:${server.port}`);

    const row = page.getByText(PROJECT.name, {exact: false}).first();
    await row.waitFor({timeout: 20000});
    await row.click();

    // The escape hatch this fix adds must render while the check is hung.
    // Wait for the panel-status hang itself before asserting — otherwise the
    // initial 'checking' state (which
    // exists before any request) would make this pass without proving anything.
    const cancel = page.getByTestId('project-memory-checking-cancel').first();
    for (let i = 0; i < 100 && hungCount === 0; i += 1) await page.waitForTimeout(100);
    assert.ok(hungCount >= 1, `${vp.label}: panel-status was never hung, nothing was proven`);
    await cancel.waitFor({timeout: 20000});

    const cancelBox = await cancel.boundingBox();
    assert.ok(cancelBox, `${vp.label}: escape hatch has no box`);
    assert.ok(cancelBox.width > 0 && cancelBox.height > 0, `${vp.label}: escape hatch not visible`);
    assert.ok(cancelBox.x >= 0 && cancelBox.x + cancelBox.width <= vp.width + 1,
      `${vp.label}: escape hatch overflows viewport (x=${cancelBox.x} w=${cancelBox.width})`);

    const cancelClipped = await cancel.evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.equal(cancelClipped, false, `${vp.label}: escape hatch label is clipped`);

    const beforeShot = join(shotDir, `memory-hung-${vp.label}-checking.png`);
    await cancel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({path: beforeShot, fullPage: false});

    // Using it must reach the error branch, which owns the retry button.
    await cancel.click();
    const retry = page.getByTestId('project-memory-check-remote').first();
    await retry.waitFor({timeout: 15000});

    const retryBox = await retry.boundingBox();
    assert.ok(retryBox, `${vp.label}: retry control has no box`);
    assert.ok(retryBox.x + retryBox.width <= vp.width + 1,
      `${vp.label}: retry control overflows viewport`);
    const retryClipped = await retry.evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.equal(retryClipped, false, `${vp.label}: retry label is clipped`);

    const afterShot = join(shotDir, `memory-hung-${vp.label}-recovered.png`);
    await retry.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({path: afterShot, fullPage: false});

    const retryLabel = (await retry.innerText()).trim().replace(/\s+/g, ' ');
    assert.deepEqual(errors, [], `${vp.label}: page errors ${errors.join(' | ')}`);

    results.push({
      viewport: vp.label,
      hungRequests: hungCount,
      escapeHatch: {w: Math.round(cancelBox.width), h: Math.round(cancelBox.height)},
      retryLabel,
      shots: [beforeShot, afterShot],
    });
    await page.close();
  }
} finally {
  await browser?.close();
  server.stop(true);
}

for (const r of results) {
  console.log(`ok ${r.viewport} · hung=${r.hungRequests} · escape ${r.escapeHatch.w}x${r.escapeHatch.h} · retry=${JSON.stringify(r.retryLabel)}`);
}
console.log(`${results.length} viewports verified against a hung sidecar`);
