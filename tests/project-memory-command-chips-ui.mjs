/**
 * Served-surface verification for the 「로컬 터미널 AI」 command chips.
 *
 * Each agent invokes the remember-session skill with its own prefix:
 *   Claude      /remember-session
 *   Codex       $remember-session
 *   Hermes      /remember_session      (label carries no <경로> placeholder)
 *   Antigravity /remember-session      (reads the same .agents/skills as Codex)
 *
 * A fourth chip was added, so this checks the row still wraps cleanly instead of
 * clipping labels or overflowing the viewport — especially at 390px.
 *
 * Owned Vite build + synthetic API only; never the live sidecar on 3001.
 *
 * Usage: bun tests/project-memory-command-chips-ui.mjs <viteDistDir> [screenshotDir]
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
  id: 'fixture-chip-project',
  name: 'chip-fixture',
  port: 9312,
  folderPath: '/fixture/projects/chip-fixture',
  isRunning: false,
  favorite: false,
  role: 'managed',
};

const MEMORY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// label -> the exact command the chip must copy
const EXPECTED = [
  {testId: 'copy-claude-remember-session', label: 'Claude /remember-session'},
  {testId: 'copy-codex-remember-session', label: 'Codex $remember-session'},
  {testId: 'copy-hermes-remember-session-local', label: 'Hermes /remember_session'},
  {testId: 'copy-agy-remember-session', label: 'Antigravity /remember-session'},
];

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

      if (u.pathname === '/api/project-memory/panel-status') {
        // The current panel reads local and remote state in one response.
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
          status: {
            exists: true,
            projectRoot: PROJECT.folderPath,
            memoryPath: `${PROJECT.folderPath}/.agent-memory`,
            sourcePath: `${PROJECT.folderPath}/.agent-memory/CORE.md`,
            contentHash: 'f'.repeat(64),
            config: {
              schemaVersion: 1, memoryId: MEMORY_ID, sourcePath: '.agent-memory/CORE.md',
              agent: 'codex', autoBackup: true, lastPulledRevisionId: null,
              lastSyncedHash: 'f'.repeat(64), lastUpdatedAt: null, lastBackedUpAt: null,
              lastRememberedActivityFingerprint: null, lastRememberedAt: null,
            },
            memoryAgent: {installedVersion: 21, currentVersion: 21, updateAvailable: false},
          },
          privateGitHubArchive: null,
          remote: {ok: true, exists: true, revisionId: 'r'.repeat(20), memoryId: MEMORY_ID,
            createdAt: '2026-09-22T00:00:00Z', contentHash: 'f'.repeat(64), inSync: true},
          computedAt: Date.now(),
          stale: false,
        })});
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

    const observed = [];
    for (const chip of EXPECTED) {
      const el = page.getByTestId(chip.testId).first();
      await el.waitFor({timeout: 20000});
      await el.scrollIntoViewIfNeeded();

      const box = await el.boundingBox();
      assert.ok(box, `${vp.label}: ${chip.testId} has no box`);
      assert.ok(box.width > 0 && box.height > 0, `${vp.label}: ${chip.testId} not visible`);
      assert.ok(box.x >= 0 && box.x + box.width <= vp.width + 1,
        `${vp.label}: ${chip.testId} overflows viewport (x=${Math.round(box.x)} w=${Math.round(box.width)})`);

      const clipped = await el.evaluate(n => n.scrollWidth > n.clientWidth + 1);
      assert.equal(clipped, false, `${vp.label}: ${chip.testId} label is clipped`);

      const text = (await el.innerText()).trim().replace(/\s+/g, ' ');
      assert.ok(text.startsWith(chip.label),
        `${vp.label}: ${chip.testId} shows ${JSON.stringify(text)}, expected ${JSON.stringify(chip.label)}`);

      observed.push({label: chip.label, w: Math.round(box.width), h: Math.round(box.height), y: Math.round(box.y)});
    }

    // The removed footnote must not come back.
    const bodyText = await page.evaluate(() => document.body.innerText);
    assert.ok(!bodyText.includes('$remember-session은 Codex 입력창에서 직접 선택'),
      `${vp.label}: the removed footnote is still rendered`);
    assert.ok(!bodyText.includes('Hermes /remember_session <경로>'),
      `${vp.label}: the <경로> placeholder is still rendered`);

    // A fixture toast can cover the lower chips in the screenshot; dismiss it so the
    // captured evidence shows the row itself.
    for (const name of ['닫기', 'Close']) {
      const close = page.getByRole('button', {name}).first();
      if (await close.count() && await close.isVisible().catch(() => false)) { await close.click().catch(() => {}); break; }
    }
    await page.evaluate(() => document.querySelectorAll('[class*="toast"],[data-testid*="toast"]').forEach(n => n.remove()));
    // scrollIntoViewIfNeeded leaves the pointer over a chip, and the native title tooltip
    // then covers its neighbour in the capture. Park the pointer away from the row.
    await page.mouse.move(vp.width - 4, 4);
    await page.getByTestId(EXPECTED[EXPECTED.length - 1].testId).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    const shot = join(shotDir, `memory-command-chips-${vp.label}.png`);
    await page.screenshot({path: shot, fullPage: false});

    // The Telegram Hermes box cross-references the chip row by label. When the chip label
    // changed, that sentence kept pointing at a label that no longer exists, so a user
    // following it would hunt for something absent. Open the box and read the live text.
    const zoom = page.getByTestId('project-memory-hermes-zoom').first();
    await zoom.scrollIntoViewIfNeeded();
    await zoom.click();
    const scope = page.getByTestId('project-memory-hermes-scope').first();
    await scope.waitFor({timeout: 15000});
    const scopeText = (await scope.innerText()).replace(/\s+/g, ' ').trim();
    assert.ok(scopeText.includes('/remember_session'),
      `${vp.label}: cross-reference lost the command: ${JSON.stringify(scopeText)}`);
    assert.ok(!scopeText.includes('<경로>'),
      `${vp.label}: cross-reference still names the removed <경로> label`);

    const scopeBox = await scope.boundingBox();
    assert.ok(scopeBox, `${vp.label}: cross-reference paragraph has no box`);
    assert.ok(scopeBox.x >= 0 && scopeBox.x + scopeBox.width <= vp.width + 1,
      `${vp.label}: cross-reference paragraph overflows viewport (x=${Math.round(scopeBox.x)} w=${Math.round(scopeBox.width)})`);

    // The app scales #root, so raw vw/vh inside this fixed overlay resolve against the
    // unscaled viewport. Check the dialog box itself on both axes, not just the text.
    const dialogBox = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="project-memory-hermes-scope"]')?.closest('details');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x: r.x, y: r.y, w: r.width, h: r.height};
    });
    assert.ok(dialogBox, `${vp.label}: expanded Hermes box not found`);
    assert.ok(dialogBox.x >= -1 && dialogBox.x + dialogBox.w <= vp.width + 1,
      `${vp.label}: expanded box overflows horizontally (x=${Math.round(dialogBox.x)} w=${Math.round(dialogBox.w)})`);
    assert.ok(dialogBox.y >= -1 && dialogBox.y + dialogBox.h <= vp.height + 1,
      `${vp.label}: expanded box overflows vertically (y=${Math.round(dialogBox.y)} h=${Math.round(dialogBox.h)})`);

    await page.mouse.move(vp.width - 4, 4);
    await page.waitForTimeout(200);
    const zoomShot = join(shotDir, `memory-hermes-box-${vp.label}.png`);
    await page.screenshot({path: zoomShot, fullPage: false});

    assert.deepEqual(errors, [], `${vp.label}: page errors ${errors.join(' | ')}`);
    const rows = new Set(observed.map(o => o.y)).size;
    results.push({viewport: vp.label, chips: observed.length, rows, shot, zoomShot, scopeText, observed});
    await page.close();
  }
} finally {
  await browser?.close();
  server.stop(true);
}

for (const r of results) {
  console.log(`ok ${r.viewport} · ${r.chips} chips on ${r.rows} row(s) · ${r.observed.map(o => `${o.label}=${o.w}x${o.h}`).join(' | ')}`);
}
console.log(`${results.length} viewports verified for the command chip row`);
