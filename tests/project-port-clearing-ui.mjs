/**
 * Served-surface verification for clearing a project's port.
 *
 * Two bugs met here:
 *   1. the edit path stored `port: 0` instead of undefined, and `lsof -ti:0`
 *      matches unrelated system processes (identityservicesd, sharingd, ...);
 *   2. the edit spreads `...original`, so a stale `isRunning: true` survived the
 *      removal of the very port that justified it and froze the row as running.
 *
 * This renders the real detail editor, clears the port, saves, and inspects BOTH
 * the payload the app persists and what the user then sees on screen.
 *
 * Owned Vite build + synthetic API only; never the live sidecar on 3001.
 *
 * Usage: bun tests/project-port-clearing-ui.mjs <viteDistDir> [screenshotDir]
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

// Mirrors the reported row: a port that the user wants to remove, still flagged running.
const PROJECT = {
  id: 'fixture-port-project',
  name: 'capitalgaintax-fixture',
  port: 9010,
  folderPath: '/fixture/projects/capitalgaintax-fixture',
  isRunning: true,
  favorite: false,
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

    let saved = null;            // the rows the app persisted
    let rows = [PROJECT];        // what /api/ports serves back

    await page.route('**/*', async route => {
      const request = route.request();
      const u = new URL(request.url());
      if (!u.pathname.startsWith('/api/') && u.hostname === '127.0.0.1') return route.continue();

      if ((u.pathname === '/api/ports/merge' || u.pathname === '/api/ports') && request.method() === 'POST') {
        const body = JSON.parse(request.postData() || '{}');
        const list = Array.isArray(body) ? body : (body.ports ?? []);
        saved = list;
        rows = list;
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({success: true, ports: list})});
      }
      if (u.pathname === '/api/ports') {
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(rows)});
      }

      const values = {
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

    const edit = page.getByRole('button', {name: '수정', exact: true}).first();
    await edit.waitFor({timeout: 20000});
    await edit.scrollIntoViewIfNeeded();
    await edit.click();

    const portInput = page.locator('input[type="number"][placeholder="포트"]').first();
    await portInput.waitFor({timeout: 15000});
    assert.equal(await portInput.inputValue(), String(PROJECT.port), `${vp.label}: editor did not load the port`);

    // The port field and its save control must be usable at this size.
    const inputBox = await portInput.boundingBox();
    assert.ok(inputBox && inputBox.width > 0 && inputBox.height >= 20, `${vp.label}: port input unusable ${JSON.stringify(inputBox)}`);
    assert.ok(inputBox.x >= 0 && inputBox.x + inputBox.width <= vp.width + 1,
      `${vp.label}: port input overflows viewport (x=${Math.round(inputBox.x)} w=${Math.round(inputBox.width)})`);

    const beforeShot = join(shotDir, `port-clear-${vp.label}-editing.png`);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(150);
    await page.screenshot({path: beforeShot, fullPage: false});

    // Clear the port, exactly as the user did, then save.
    await portInput.fill('');
    const save = page.getByTestId('detail-edit-save').first();
    await save.scrollIntoViewIfNeeded();
    const saveBox = await save.boundingBox();
    assert.ok(saveBox && saveBox.width > 0 && saveBox.height > 0, `${vp.label}: save control not visible`);
    assert.ok(saveBox.x >= 0 && saveBox.x + saveBox.width <= vp.width + 1,
      `${vp.label}: save control overflows viewport`);
    await save.click();

    await page.waitForFunction(() => true);
    for (let i = 0; i < 100 && saved === null; i += 1) await page.waitForTimeout(100);
    assert.ok(saved, `${vp.label}: the app never persisted the edit`);

    const persisted = saved.find(r => r.id === PROJECT.id);
    assert.ok(persisted, `${vp.label}: the edited project vanished from the payload`);

    // Bug 1: a cleared port must not become the number 0.
    assert.notEqual(persisted.port, 0,
      `${vp.label}: cleared port persisted as 0 — lsof -ti:0 matches unrelated system processes`);
    assert.ok(persisted.port === undefined || persisted.port === null,
      `${vp.label}: cleared port persisted as ${JSON.stringify(persisted.port)}`);

    // Bug 2: the stale running flag must not survive the port that justified it.
    assert.notEqual(persisted.isRunning, true,
      `${vp.label}: isRunning stayed true after the port was cleared`);

    // And the user must actually see the row stop claiming it is running.
    await page.waitForTimeout(400);
    const afterShot = join(shotDir, `port-clear-${vp.label}-cleared.png`);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(150);
    await page.screenshot({path: afterShot, fullPage: false});

    const portText = await page.evaluate(() => document.body.innerText);
    assert.ok(!portText.includes(':9010'),
      `${vp.label}: the removed port is still rendered on screen`);

    assert.deepEqual(errors, [], `${vp.label}: page errors ${errors.join(' | ')}`);
    results.push({
      viewport: vp.label,
      persistedPort: persisted.port === undefined ? 'undefined' : JSON.stringify(persisted.port),
      persistedRunning: persisted.isRunning,
      shots: [beforeShot, afterShot],
    });
    await page.close();
  }
} finally {
  await browser?.close();
  server.stop(true);
}

for (const r of results) {
  console.log(`ok ${r.viewport} · persisted port=${r.persistedPort} isRunning=${r.persistedRunning}`);
}
console.log(`${results.length} viewports verified for clearing a project port`);
