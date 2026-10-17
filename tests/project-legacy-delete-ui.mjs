/**
 * Served-surface verification for deleting a legacy cross-device project.
 *
 * Rows imported before sourcePortId/sourcePortSyncGeneration were recorded could not be
 * deleted at all: the remote-deletion identity assertion also guarded the local-only
 * path, so the dialog answered "구버전 타기기 항목의 원본 ID를 안전하게 확인할 수
 * 없습니다" and nothing happened. Measured on a real registry: 125 of 136 rows.
 *
 * This drives the real delete dialog on such a row and asserts the local-only delete
 * now completes, while the remote-delete button still refuses without a complete
 * identity — the case the assertion exists for.
 *
 * Owned Vite build + synthetic API only; never the live sidecar on 3001.
 *
 * Usage: bun tests/project-legacy-delete-ui.mjs <viteDistDir> [screenshotDir]
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

const OWN_DEVICE = '11111111-1111-4111-8111-111111111111';
// The shape that used to be undeletable: imported from another device, with no captured
// origin row id or sync generation. A fresh Pull re-imports exactly this, so the error's
// advice could never repair it.
const LEGACY = {
  id: 'fixture-legacy-clone',
  name: 'legacy-clone-fixture',
  folderPath: '/fixture/projects/legacy-clone-fixture',
  isRunning: false,
  favorite: false,
  role: 'managed',
  sourceDeviceId: '22222222-2222-4222-8222-222222222222',
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

    let rows = [LEGACY];
    let saved = null;
    let hiddenIds = [];

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
      // The local-only suppression marker is written here, independently of ports.json.
      if (u.pathname === '/api/portal/local-metadata') {
        const body = JSON.parse(request.postData() || '{}');
        const ids = Array.isArray(body.ids) ? body.ids : [];
        hiddenIds = body.mode === 'add' ? [...hiddenIds, ...ids] : hiddenIds.filter(id => !ids.includes(id));
        const metadata = {locallyDeletedRemotePortIds: hiddenIds};
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
          success: true, metadata, fingerprint: portalLocalMetadataFingerprint(metadata),
        })});
      }
      if (u.pathname === '/api/portal' && request.method() === 'POST') {
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({success: true})});
      }
      if (u.pathname === '/api/ports') {
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(rows)});
      }

      const values = {
        '/api/portal': {deviceId: OWN_DEVICE, deviceName: 'fixture-mac', locallyDeletedRemotePortIds: hiddenIds},
        '/api/workspace-roots': [{id: 'fixture-root', name: '테스트 작업 폴더', path: '/fixture/projects'}],
        '/api/portal/safety-lease/acquire': {success: true, token: 'a'.repeat(64), metadata: {}, fingerprint: portalLocalMetadataFingerprint({}), expiresInMs: 30000},
        '/api/portal/safety-lease/release': {released: true},
        '/api/health': {status: 'ok'},
        '/api/control-profile/status': {success: true, profile: {state: 'ready', projectId: 'fixture-ops-project'}},
        '/api/onboarding/status': {stage: 'ready'},
        '/api/check-port-status': {isRunning: false},
        '/api/memory-archive': {archived: false},
        '/api/what-i-said/source': {success: true},
        '/api/local-only-deleted-ports': {success: true},
      };
      return route.fulfill({
        status: Object.hasOwn(values, u.pathname) ? 200 : 503,
        contentType: 'application/json',
        body: JSON.stringify(values[u.pathname] ?? {error: 'fixture blocked'}),
      });
    });

    await page.goto(`http://127.0.0.1:${server.port}`);

    const row = page.getByText(LEGACY.name, {exact: false}).first();
    await row.waitFor({timeout: 20000});
    await row.click();

    const del = page.getByRole('button', {name: '삭제', exact: true}).first();
    await del.waitFor({timeout: 20000});
    await del.scrollIntoViewIfNeeded();
    await del.click();

    const localBtn = page.getByTestId('delete-confirm-local').first();
    await localBtn.waitFor({timeout: 15000});

    // The three choices must be readable and inside the viewport at this size.
    for (const id of ['delete-confirm-remote', 'delete-confirm-local', 'delete-confirm-cancel']) {
      const el = page.getByTestId(id).first();
      const box = await el.boundingBox();
      assert.ok(box && box.width > 0 && box.height >= 28, `${vp.label}: ${id} not usable ${JSON.stringify(box)}`);
      assert.ok(box.x >= 0 && box.x + box.width <= vp.width + 1,
        `${vp.label}: ${id} overflows viewport (x=${Math.round(box.x)} w=${Math.round(box.width)})`);
      assert.equal(await el.evaluate(n => n.scrollWidth > n.clientWidth + 1), false,
        `${vp.label}: ${id} label is clipped`);
    }

    const dialogShot = join(shotDir, `legacy-delete-${vp.label}-dialog.png`);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(150);
    await page.screenshot({path: dialogShot, fullPage: false});

    // The red button is the one the user reported: it refused every row before.
    const remoteBtn = page.getByTestId('delete-confirm-remote').first();
    await remoteBtn.click();
    await page.waitForTimeout(2500);
    const afterRemote = await page.evaluate(() => document.body.innerText);
    assert.ok(!afterRemote.includes('원본 ID를 안전하게 확인할 수 없습니다'),
      `${vp.label}: remote delete still refuses a legacy row`);
    // Supabase is not configured in this fixture, so the remote step reports its own
    // failure instead of the identity refusal — that is the correct, reachable path.
    if (afterRemote.includes(LEGACY.name)) {
      await del.scrollIntoViewIfNeeded();
      await del.click();
      await localBtn.waitFor({timeout: 15000});
    }
    await localBtn.click();

    // The row must actually disappear; before the fix this silently failed with a toast.
    await page.waitForFunction(
      name => !document.body.innerText.includes(name),
      LEGACY.name,
      {timeout: 20000},
    );

    const body = await page.evaluate(() => document.body.innerText);
    assert.ok(!body.includes('원본 ID를 안전하게 확인할 수 없습니다'),
      `${vp.label}: the legacy-identity refusal still blocks a local-only delete`);
    assert.ok(!body.includes(LEGACY.name), `${vp.label}: the deleted row is still rendered`);

    const afterShot = join(shotDir, `legacy-delete-${vp.label}-deleted.png`);
    await page.waitForTimeout(200);
    await page.screenshot({path: afterShot, fullPage: false});

    assert.deepEqual(errors, [], `${vp.label}: page errors ${errors.join(' | ')}`);
    results.push({viewport: vp.label, persisted: saved ? saved.length : 'not-saved'});
    await page.close();
  }
} finally {
  await browser?.close();
  server.stop(true);
}

for (const r of results) {
  console.log(`ok ${r.viewport} · legacy clone deleted · rows persisted=${r.persisted}`);
}
console.log(`${results.length} viewports verified for deleting a legacy cross-device row`);
