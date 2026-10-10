/**
 * Served-surface verification for the project folder move dialog.
 *
 * Moving a project used to require typing the full destination path by hand, pre-filled
 * with the current path — the one place a typo silently sends a folder somewhere
 * unintended. This checks the Finder picker actually renders next to the field, only for
 * a move (a rename keeps the parent), and that the field stays usable beside it.
 *
 * Owned Vite build + synthetic API only; never the live sidecar on 3001.
 *
 * Usage: bun tests/project-folder-move-picker-ui.mjs <viteDistDir> [screenshotDir]
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
  id: 'fixture-move-project',
  name: 'move-fixture',
  folderPath: '/fixture/projects/parent/move-fixture',
  isRunning: false,
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

    await page.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (!u.pathname.startsWith('/api/') && u.hostname === '127.0.0.1') return route.continue();
      if (u.pathname === '/api/pick-folder') {
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({path: '/fixture/chosen/destination'})});
      }
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

    const open = page.getByRole('button', {name: '폴더명·위치 변경', exact: false}).first();
    await open.waitFor({timeout: 20000});
    await open.scrollIntoViewIfNeeded();
    await open.click();

    const field = page.getByTestId('folder-rename-prompt-name').first();
    await field.waitFor({timeout: 15000});

    // Rename is the default: browsing for a parent would be misleading there.
    assert.equal(await page.getByTestId('folder-rename-prompt-browse').count(), 0,
      `${vp.label}: the picker must not appear for a rename`);

    await page.getByRole('button', {name: '위치 이동', exact: true}).first().click();

    const browse = page.getByTestId('folder-rename-prompt-browse').first();
    await browse.waitFor({timeout: 15000});

    const browseBox = await browse.boundingBox();
    const fieldBox = await field.boundingBox();
    assert.ok(browseBox && fieldBox, `${vp.label}: move controls have no box`);
    assert.ok(browseBox.width > 0 && browseBox.height >= 28, `${vp.label}: picker not usable ${JSON.stringify(browseBox)}`);
    assert.ok(browseBox.x >= 0 && browseBox.x + browseBox.width <= vp.width + 1,
      `${vp.label}: picker overflows viewport (x=${Math.round(browseBox.x)} w=${Math.round(browseBox.width)})`);
    assert.ok(fieldBox.width > 60, `${vp.label}: path field squeezed to ${Math.round(fieldBox.width)}px by the picker`);
    assert.equal(await browse.evaluate(n => n.scrollWidth > n.clientWidth + 1), false,
      `${vp.label}: picker label is clipped`);

    const beforeShot = join(shotDir, `folder-move-${vp.label}-move-mode.png`);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(150);
    await page.screenshot({path: beforeShot, fullPage: false});

    // Choosing a parent must append the folder name, not replace the whole path.
    await browse.click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="folder-rename-prompt-name"]')?.value?.startsWith('/fixture/chosen/destination'),
      {timeout: 15000},
    );
    const value = await field.inputValue();
    assert.equal(value, '/fixture/chosen/destination/move-fixture',
      `${vp.label}: picked parent produced ${JSON.stringify(value)}`);

    const afterShot = join(shotDir, `folder-move-${vp.label}-picked.png`);
    await page.waitForTimeout(150);
    await page.screenshot({path: afterShot, fullPage: false});

    assert.deepEqual(errors, [], `${vp.label}: page errors ${errors.join(' | ')}`);
    results.push({viewport: vp.label, picker: {w: Math.round(browseBox.width), h: Math.round(browseBox.height)}, field: Math.round(fieldBox.width), value});
    await page.close();
  }
} finally {
  await browser?.close();
  server.stop(true);
}

for (const r of results) {
  console.log(`ok ${r.viewport} · picker ${r.picker.w}x${r.picker.h} · field ${r.field}px · value=${r.value}`);
}
console.log(`${results.length} viewports verified for the folder move picker`);
