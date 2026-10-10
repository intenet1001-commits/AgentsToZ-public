/**
 * Served-surface verification for the removal of the duplicated
 * 「프로젝트 대화 기록 · AgentsToZ에서 대화」 card from the project detail panel.
 *
 * Owned Vite build + synthetic API only — never the live sidecar on 3001.
 * Renders the real project detail surface at a desktop and a mobile width,
 * asserts the duplicate is gone, asserts the surviving Workroom entry point
 * still works, and writes screenshots for human inspection.
 *
 * Usage: bun tests/project-detail-workroom-entry-ui.mjs <viteDistDir> [screenshotDir]
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
  id: 'fixture-project-id',
  name: 'agent-framework-config',
  port: 9310,
  folderPath: '/fixture/projects/agent-framework-config',
  isRunning: false,
  favorite: false,
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: req => {
    const path = new URL(req.url).pathname;
    return new Response(Bun.file(join(dist, path === '/' ? 'index.html' : path)));
  },
});

let browser;
const results = [];

const VIEWPORTS = [
  {label: 'desktop-1440x900', width: 1440, height: 900, isMobile: false},
  {label: 'desktop-1100x850', width: 1100, height: 850, isMobile: false},
  {label: 'mobile-390x844', width: 390, height: 844, isMobile: true},
];

try {
  browser = await chromium.launch();

  for (const vp of VIEWPORTS) {
    let savedPorts = [PROJECT];
    let terminalStarts = [];
    const page = await browser.newPage({
      viewport: {width: vp.width, height: vp.height},
      deviceScaleFactor: 2,
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile,
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.route('**/*', async route => {
      const req = route.request();
      const u = new URL(req.url());
      if (!u.pathname.startsWith('/api/') && u.hostname === '127.0.0.1') return route.continue();

      if (u.pathname === '/api/ports/merge') {
        savedPorts = JSON.parse(req.postData()).ports;
        return route.fulfill({status: 200, contentType: 'application/json', body: '{"success":true}'});
      }
      if (u.pathname.startsWith('/api/agent-runtime/terminals')) {
        const body = req.postData() ? JSON.parse(req.postData()) : {};
        terminalStarts.push({path: u.pathname, operation: body.operation, agent: body.agent, targetId: body.targetId});
        // normalizeAiTerminalResponse (src/aiTerminalProtocol.ts) allows only
        // session/sessions/chunks/nextCursor/truncated/hasMore — a `success`
        // key makes it reject the whole response. A `start` must return the
        // created session or the launcher reports an unconfirmed result.
        const session = {
          id: 'fixture-session-0001',
          targetId: body.targetId ?? PROJECT.id,
          agent: body.agent ?? 'claude',
          state: 'running',
          createdAt: new Date().toISOString(),
          exitCode: null,
          cols: 80,
          rows: 24,
        };
        if (body.operation === 'start') {
          return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({session})});
        }
        if (body.operation === 'read') {
          return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({chunks: [], nextCursor: 0, truncated: false})});
        }
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({sessions: []})});
      }
      if (u.pathname === '/api/agent-runtime/targets') {
        // Shape is enforced by normalizeAgentRuntimeTargetsResponse in
        // src/agentRuntimeApiContract.ts — hasExactKeys rejects extra or missing
        // keys, so this fixture mirrors the contract exactly.
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
          protocolVersion: 'agentstoz-tasks-v2',
          targets: [{
            targetId: PROJECT.id,
            projectTargetId: PROJECT.id,
            label: PROJECT.name,
            scope: 'main',
            branch: null,
            locked: false,
            worktreeCapable: false,
          }],
          complete: true,
        })});
      }
      if (u.pathname === '/api/agentstoz-use/workroom-navigation') {
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({success: true, navigation: null})});
      }
      if (u.pathname === '/api/code-app-launch-options') {
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({success: true, options: []})});
      }
      const values = {
        '/api/ports': savedPorts,
        '/api/portal': {},
        '/api/workspace-roots': [{id: 'fixture-root', name: '테스트 작업 폴더', path: '/fixture/projects'}],
        '/api/portal/safety-lease/acquire': {success: true, token: 'a'.repeat(64), metadata: {}, fingerprint: portalLocalMetadataFingerprint({}), expiresInMs: 30000},
        '/api/portal/safety-lease/release': {released: true},
        '/api/health': {status: 'ok'},
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

    // Open the project detail surface that this change edits.
    // The sidebar row wraps the name with sibling text ("관리 프로젝트", ":9310"),
    // so match the name node itself rather than an exact full-row string.
    const row = page.getByText(PROJECT.name, {exact: false}).first();
    await row.waitFor({timeout: 20000});
    await row.click();

    // The surviving Workroom entry point must render.
    // testId comes from App.tsx: <ProjectLaunchActions testId="detail-project-launch" ...>
    // and the component renders `${testId}-workroom` on the Workroom button.
    const launch = page.getByTestId('detail-project-launch-workroom').first();
    await launch.waitFor({timeout: 15000});

    // The duplicate must be gone from the served DOM, not just from source.
    const duplicatePanel = await page.locator('[data-testid="desktop-project-app-panel"]').count();
    const duplicateButton = await page.locator('[data-testid="detail-agentstoz-conversation"]').count();
    const duplicateText = await page.getByText('AgentsToZ에서 대화', {exact: false}).count();
    const duplicateHeading = await page.getByText('프로젝트 대화 기록', {exact: false}).count();

    assert.equal(duplicatePanel, 0, `${vp.label}: duplicate panel still rendered`);
    assert.equal(duplicateButton, 0, `${vp.label}: duplicate button still rendered`);
    assert.equal(duplicateText, 0, `${vp.label}: duplicate label text still rendered`);
    assert.equal(duplicateHeading, 0, `${vp.label}: duplicate heading still rendered`);

    // Text layout: the surviving control must be visible, not clipped, and tappable.
    const box = await launch.boundingBox();
    assert.ok(box, `${vp.label}: Workroom control has no box`);
    assert.ok(box.width > 40, `${vp.label}: Workroom control too narrow (${box.width})`);
    assert.ok(box.height >= 24, `${vp.label}: Workroom control too short (${box.height})`);
    assert.ok(box.x >= 0 && box.x + box.width <= vp.width + 1,
      `${vp.label}: Workroom control overflows horizontally (x=${box.x} w=${box.width} vp=${vp.width})`);

    const label = (await launch.innerText()).replace(/\s+/g, ' ').trim();
    const clipped = await launch.evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.equal(clipped, false, `${vp.label}: Workroom control label is clipped ("${label}")`);

    // Evidence BEFORE the click: this is the surface the change edits.
    const beforeShot = join(shotDir, `project-detail-${vp.label}.png`);
    await page.screenshot({path: beforeShot, fullPage: false});
    const detailShot = join(shotDir, `project-detail-${vp.label}-panel.png`);
    await page.locator('[data-testid="detail-project-launch"]').first()
      .screenshot({path: detailShot}).catch(() => {});

    // Interaction: it must still route to the Workroom tab.
    // The panel is an id, not a data-testid: <div id="top-level-terminal-panel" role="tabpanel" hidden={...}>
    await launch.click();
    await page.waitForFunction(() => {
      const panel = document.getElementById('top-level-terminal-panel');
      return !!panel && !panel.hidden;
    }, {timeout: 15000}).catch(async () => {
      const err = await page.locator('[data-testid="detail-project-launch-error"]').innerText().catch(() => '(none)');
      throw new Error(`${vp.label}: Workroom tab never opened. launch error="${err.trim()}"`);
    });
    const onWorkroom = await page.evaluate(() => {
      const panel = document.getElementById('top-level-terminal-panel');
      return !!panel && !panel.hidden;
    });
    assert.equal(onWorkroom, true, `${vp.label}: Workroom tab did not open`);

    const shot = join(shotDir, `project-detail-${vp.label}-after-click.png`);
    await page.screenshot({path: shot, fullPage: false});

    assert.deepEqual(errors, [], `${vp.label}: page errors ${errors.join(' | ')}`);

    results.push({viewport: vp.label, label, box: {w: Math.round(box.width), h: Math.round(box.height)}, onWorkroom, shot: beforeShot, detailShot});
    await page.close();
  }

  for (const r of results) {
    console.log(`ok ${r.viewport} · "${r.label}" ${r.box.w}x${r.box.h} · workroom=${r.onWorkroom} · ${r.shot}`);
  }
  console.log(`project-detail-workroom-entry: ${results.length} viewports verified, duplicate absent in served DOM`);
} finally {
  await browser?.close();
  server.stop(true);
}
