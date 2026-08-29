import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const APP_URL = process.env.LOCAL_URL ?? 'http://127.0.0.1:9000';
const fixtureFolder = '/tmp/agentstoz-memory-conflict-fixture';
const screenshotDir = join(process.cwd(), 'output', 'playwright');
const screenshotPath = join(screenshotDir, 'project-memory-conflict-resolver.png');

const localHash = 'local-content-hash';
const remoteHash = 'remote-content-hash';
let resolved = false;
let sessionEndCalls = 0;
let resolveRequest = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

const memoryStatus = () => ({
  exists: true,
  projectRoot: fixtureFolder,
  memoryPath: `${fixtureFolder}/.agent-memory/CORE.md`,
  sourcePath: '.agent-memory/CORE.md',
  kind: 'native',
  size: 42,
  modifiedAt: '2026-08-08T00:00:00.000Z',
  contentHash: localHash,
  config: {
    schemaVersion: 1,
    memoryId: 'fixture-memory-id',
    sourcePath: '.agent-memory/CORE.md',
    agent: 'codex',
    autoBackup: true,
    lastPulledRevisionId: 'remote-revision',
    lastSyncedHash: resolved ? localHash : 'base-hash',
    lastUpdatedAt: '2026-08-08T00:00:00.000Z',
    lastBackedUpAt: resolved ? '2026-08-08T00:02:00.000Z' : '2026-08-07T00:00:00.000Z',
    lastRememberedActivityFingerprint: 'old-activity',
    lastRememberedAt: '2026-08-07T00:00:00.000Z',
  },
  adapters: { claude: true, codex: true },
  memoryAgent: { installedVersion: 4, currentVersion: 4, updateAvailable: false },
  // Resolving the sync collision must not cause the skipped session AI action
  // to be silently retried or marked complete.
  activity: {
    needsRemember: true,
    reasons: ['project-changes'],
    currentFingerprint: 'new-activity',
    lastRememberedFingerprint: 'old-activity',
    lastActivityAt: '2026-08-08T00:01:00.000Z',
    lastRememberedAt: '2026-08-07T00:00:00.000Z',
    lastAgent: 'codex',
    worktreeCount: 0,
    hooks: { claude: true, codex: true },
  },
});

const conflict = {
  success: false,
  conflict: true,
  preflightConflict: true,
  localSaved: false,
  remoteBackedUp: false,
  remoteRevisionId: 'remote-revision',
  remoteCreatedAt: '2026-08-08T00:00:00.000Z',
  remoteContentHash: remoteHash,
  remoteDeviceName: 'Other Mac',
  remoteContent: '# Project Core Memory\n\n## Remote decision\nKeep the remote note.\n',
  localContentHash: localHash,
  localModifiedAt: '2026-08-08T00:00:00.000Z',
  lastSyncedHash: 'base-hash',
  localContent: '# Project Core Memory\n\n## Local decision\nKeep the local note.\n',
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();

try {
  await page.route('**/api/ports/merge', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/ports', route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'conflict-project',
          name: '충돌 검증 프로젝트',
          port: 9010,
          folderPath: fixtureFolder,
          isRunning: false,
        }]),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/workspace-roots', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/last-visits', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/last-git-activity', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/check-ports-batch', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/project-memory/detect', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(memoryStatus()),
  }));
  await page.route('**/api/project-memory/remote-status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      // The preflight detects the real collision at click time.  The ordinary
      // status endpoint may still show the last known synced head beforehand.
      exists: true,
      revisionId: resolved ? 'resolved-revision' : 'remote-revision',
      createdAt: '2026-08-08T00:00:00.000Z',
      contentHash: localHash,
      inSync: true,
    }),
  }));
  await page.route('**/api/project-memory/session-end', route => {
    sessionEndCalls += 1;
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify(conflict) });
  });
  await page.route('**/api/project-memory/resolve-conflict', route => {
    resolveRequest = route.request().postDataJSON();
    assert(resolveRequest.strategy === 'keep-local', 'resolver applies the explicitly selected local strategy');
    assert(resolveRequest.expectedLocalHash === localHash, 'resolver sends the previewed local hash');
    assert(resolveRequest.expectedRemoteRevisionId === 'remote-revision', 'resolver sends the previewed remote revision');
    resolved = true;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        strategy: 'keep-local',
        revisionId: 'resolved-revision',
        preservedRemoteRevisionId: 'remote-revision',
      }),
    });
  });
  await page.route('**/api/context-usage', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      captureInstalled: true,
      sessions: [{
        sessionId: 'fixture-session',
        sourceAgent: 'codex',
        cwd: fixtureFolder,
        modelId: 'gpt-5',
        modelName: 'Codex',
        windowSize: 258000,
        usedPercent: 85,
        remainingPercent: 15,
        usedTokens: 219300,
        costUsd: null,
        ageMs: 0,
        state: 'active',
        clientLabel: 'ChatGPT 앱 · Codex',
        surfaceKind: 'chatgpt-desktop',
        surfaceLabel: 'ChatGPT 데스크탑',
        surfaceDetail: null,
        navigation: { available: false, kind: null, exact: false, actionLabel: null, detail: 'mock' },
      }],
    }),
  }));
  await page.route('**/api/ai-usage/claude', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ report: 'mock Claude usage' }) }));
  await page.route('**/api/ai-usage/codex**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      source: 'live-app-server',
      checkedAt: '2026-08-08T00:00:00.000Z',
      rateLimits: { primary: { used_percent: 42, window_minutes: 10080, resets_at: 1786164688 }, plan_type: 'mock' },
    }),
  }));

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByTestId('btn-ai-usage').waitFor({ state: 'visible' });
  await page.getByTestId('btn-ai-usage').click();
  const moveToProject = page.getByTestId('context-session-open-project-fixture-session');
  await moveToProject.waitFor({ state: 'visible' });
  assert(await moveToProject.isVisible(), 'AI usage row exposes 프로젝트로 이동 for a registered project');
  await moveToProject.click();
  assert(await page.getByText('AI 사용량', { exact: true }).count() === 0, '프로젝트 이동 closes the usage dialog');

  const sessionEnd = page.getByTestId('project-memory-session-end');
  await sessionEnd.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '세션 기억하기 필요', exact: true }).waitFor({ state: 'visible' });
  const initialSessionLabel = await sessionEnd.textContent();
  console.log(`SESSION_ACTION ${initialSessionLabel}`);
  assert(initialSessionLabel?.includes('세션 기억하기 필요'), 'project panel keeps a real remember action before conflict');
  await sessionEnd.click();

  const resolver = page.getByTestId('project-memory-conflict-resolver');
  await resolver.waitFor({ state: 'visible' });
  assert((await resolver.textContent())?.includes('아직 자동으로 덮어쓰지 않았습니다'), 'conflict resolver explains no automatic overwrite occurred');
  assert((await resolver.textContent())?.includes('세션 기억 AI는 시작되지 않았습니다'), 'preflight conflict explains the AI update did not start');
  assert((await resolver.textContent())?.includes('Local decision'), 'conflict resolver renders the local version preview');
  assert((await resolver.textContent())?.includes('Remote decision'), 'conflict resolver renders the Supabase version preview');
  assert(sessionEndCalls === 1, 'conflict does not retry the session AI action');

  mkdirSync(screenshotDir, { recursive: true });
  await resolver.screenshot({ path: screenshotPath });
  console.log(`SCREENSHOT ${screenshotPath}`);

  await page.getByTestId('project-memory-conflict-keep-local').click();
  assert(await page.getByTestId('project-memory-conflict-confirm').isVisible(), 'choosing a direction requires a second explicit confirmation');
  assert(resolveRequest === null, 'resolver endpoint is not called until the second confirmation');
  await page.getByTestId('project-memory-conflict-confirm-apply').click();
  await resolver.waitFor({ state: 'detached' });
  assert(resolveRequest !== null, 'resolver endpoint is called after the explicit confirmation');
  await page.getByRole('button', { name: '세션 기억하기 필요', exact: true }).waitFor({ state: 'visible' });
  const resolvedSessionLabel = await sessionEnd.textContent();
  console.log(`RESOLVED_SESSION_ACTION ${resolvedSessionLabel}`);
  assert(resolvedSessionLabel?.includes('세션 기억하기 필요'), 'sync resolution does not silently rerun or complete the skipped session save');
  assert(sessionEndCalls === 1, 'only the user may run session memory again after resolving conflict');
} finally {
  await browser.close();
}

console.log('PASS Project-memory conflict resolver UI E2E');
