/**
 * Served-surface check for 「<프로젝트> 열어」: a pending project navigation (agentstoz_use
 * open_dashboard with a portId, or OPS voice open_project) selects that project in the real App
 * while the app already has focus — no focus or visibilitychange event arrives, which is exactly
 * the case of OPS voice running inside the app — and each request is followed once.
 *
 * Owned Vite build + synthetic API only — never the live sidecar on 3001.
 * Usage: ./node_modules/.bin/vite build --outDir <dir> && bun tests/agentstoz-use-open-project.e2e.mjs <dir>
 */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';

const dist = process.argv[2];
if (!dist) throw new Error('Pass an isolated Vite build directory');

const ALPHA = {id: 'fixture-project-alpha', name: 'alpha-project', port: 9311, folderPath: '/fixture/projects/alpha-project', isRunning: false, favorite: false};
const BRAVO = {id: 'fixture-project-bravo', name: 'bravo-project', port: 9312, folderPath: '/fixture/projects/bravo-project', isRunning: false, favorite: false};
let navigation = null;
let navigationReads = 0;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: req => {
    const path = new URL(req.url).pathname;
    return new Response(Bun.file(join(dist, path === '/' ? 'index.html' : path)));
  },
});

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1280, height: 860}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let savedPorts = [ALPHA, BRAVO];
  await page.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (!u.pathname.startsWith('/api/') && u.hostname === '127.0.0.1') return route.continue();
    const json = (body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
    if (u.pathname === '/api/agentstoz-use/workroom-navigation') { navigationReads++; return json({success: true, navigation}); }
    if (u.pathname === '/api/ports/merge') { savedPorts = JSON.parse(req.postData()).ports; return json({success: true}); }
    if (u.pathname.startsWith('/api/agent-runtime/terminals')) return json({sessions: []});
    if (u.pathname === '/api/agent-runtime/targets') {
      return json({protocolVersion: 'agentstoz-tasks-v2', complete: true, targets: [ALPHA, BRAVO].map(project => ({
        targetId: project.id, projectTargetId: project.id, label: project.name, scope: 'main', branch: null, locked: false, worktreeCapable: false,
      }))});
    }
    if (u.pathname === '/api/code-app-launch-options') return json({success: true, options: []});
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
    return json(values[u.pathname] ?? {error: 'fixture blocked'}, Object.hasOwn(values, u.pathname) ? 200 : 503);
  });

  await page.goto(`http://127.0.0.1:${server.port}`);
  const row = id => page.locator(`[data-testid="sidebar-project-row"][data-project-id="${id}"]`);
  const selected = id => page.locator(`[data-testid="sidebar-project-row"][data-project-id="${id}"][data-selected="true"]`);
  await row(ALPHA.id).waitFor({timeout: 20000});
  await row(ALPHA.id).click();
  await selected(ALPHA.id).waitFor({timeout: 5000});
  // The user is on the Workroom tab when the request arrives.
  await page.locator('[data-top-level-tab="terminal"]').click();
  assert.equal(await page.locator('[data-top-level-tab="terminal"]').getAttribute('aria-selected'), 'true');

  // The page already has focus: no focus or visibilitychange event will be dispatched from here on.
  const readsBefore = navigationReads;
  navigation = {nonce: 'nav-project-bravo-1', projectId: BRAVO.id};
  await selected(BRAVO.id).waitFor({timeout: 6000});
  assert.ok(navigationReads > readsBefore, 'the focused app checked for the request by itself');
  assert.equal(await page.locator('[data-top-level-tab="ports"]').getAttribute('aria-selected'), 'true');
  assert.equal(await row(ALPHA.id).getAttribute('data-selected'), 'false');

  // Followed once: picking another project is not undone while the same request is still served.
  await row(ALPHA.id).click();
  await selected(ALPHA.id).waitFor({timeout: 5000});
  const readsAfterChoice = navigationReads;
  await page.waitForTimeout(4_500);
  assert.ok(navigationReads >= readsAfterChoice + 1, 'polling continues while visible');
  assert.equal(await row(BRAVO.id).getAttribute('data-selected'), 'false');

  // An unknown project is reported, not silently ignored.
  navigation = {nonce: 'nav-project-missing-1', projectId: 'fixture-project-missing'};
  await page.getByText('요청한 프로젝트를 목록에서 찾지 못했습니다', {exact: false}).first().waitFor({timeout: 6000});

  assert.deepEqual(errors, []);
  console.log(`PASS: project navigation selects ${BRAVO.name} in the focused app without a focus event (${navigationReads} polls), once per request, and reports an unknown project`);
} finally {
  await browser?.close();
  server.stop(true);
}
