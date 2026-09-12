import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProjectMemory } from '../project-memory-server';
import { resolveAppDataDir } from '../src/appDataDir';
import {
  captureWhatISaidPrompt,
  configureWhatISaidCapture,
  enableWhatISaidFeed,
  readWhatISaidStatus,
  whatISaidDatabasePath,
  type WhatISaidLocation,
} from '../src/whatISaidStore';
import {
  createWhatISaidAdapterAuthorization,
  verifyWhatISaidAdapterResponse,
} from '../src/whatISaidFeedAdapter';
import { startTestApiServer } from './startTestApiServer';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
const KEY = Buffer.alloc(32, 0x31);
const CAPABILITY = 'c'.repeat(64);
const TAURI_ORIGIN = 'http://tauri.localhost';

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitInit(path: string): void {
  const result = Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], {
    cwd: path,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  body: unknown,
  options: { method?: 'POST' | 'DELETE'; capability?: string | null; origin?: string | null } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.origin !== null) headers.Origin = options.origin ?? TAURI_ORIGIN;
  if (options.capability !== null) {
    headers['X-AgentsToZ-What-I-Said-Capability'] = options.capability ?? CAPABILITY;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

function addPrompt(
  location: WhatISaidLocation,
  event: string,
  recordedAt: string,
  text: string,
): void {
  const result = captureWhatISaidPrompt({
    ...location,
    key: KEY,
    agent: 'codex',
    sourceIdentity: `${location.memoryId}.jsonl`,
    sourceEventIdentity: event,
    recordedAt,
    text,
    now: '2026-08-30T13:00:00Z',
  });
  if (!result.stored) throw new Error(`fixture prompt was not stored: ${result.reason}`);
}

async function challengedFeed(
  baseUrl: string,
  requestTarget: string,
  token: string,
) {
  const challengeResponse = await fetch(`${baseUrl}${requestTarget}`);
  const challengeBody = await challengeResponse.json() as any;
  expect(challengeResponse.status).toBe(401);
  expect(challengeBody.auth).toMatchObject({
    scheme: 'AgentsToZ-HMAC',
    version: 1,
    algorithm: 'hmac-sha256',
    requestProofDomain: 'agentstoz-what-i-said-feed-request-v1\0',
    responseProofDomain: 'agentstoz-what-i-said-feed-response-v1\0',
    requestTarget,
  });
  const authorization = createWhatISaidAdapterAuthorization({
    accessKey: token,
    challenge: challengeBody.auth.challenge,
    requestTarget,
  });
  return {
    challenge: challengeBody.auth.challenge as string,
    authorization,
    response: await fetch(`${baseUrl}${requestTarget}`, { headers: { Authorization: authorization } }),
  };
}

describe('What-I-said local HTTP boundary', () => {
  test('keeps immediate capture boundaries alongside bounded background rotation', () => {
    expect(apiSource).toContain('const whatISaidCapture = await bestEffortWhatISaidCapture(folderPath)');
    expect(apiSource).toContain('const whatISaidCapture = await bestEffortWhatISaidCapture(body.folderPath)');
    expect(apiSource).toContain('new WhatISaidAutoCapture(');
    expect(apiSource).toContain('onlyIfConfigured: true, background: true');
    expect(apiSource).toContain('result.budgetExhausted && !options.background');
    expect(apiSource).not.toContain('const whatISaidInitialCaptureTimer = setTimeout');
    expect(apiSource).toContain('WHAT_I_SAID_PROJECT_RESOLUTION_CACHE_MS = 5_000');
    expect(apiSource).toContain('Global opt-in must never turn one save into an all-project scan.');
    expect(apiSource).toContain('onTurnSettled: projectRoot => scheduleWhatISaidCaptureFollowUp(projectRoot)');
    expect(apiSource).toContain('captureRegisteredWhatISaid(key, { onlyIfConfigured: true })');
  });

  test('starts every current project immediately and applies the same opt-in lazily to future projects', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-global-api-'));
    roots.push(home);
    const apiEnv = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      NODE_ENV: 'test',
      PORT: '9000',
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_BUNDLED_SIDECAR: '1',
      PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
      PORTMGR_WHAT_I_SAID_TEST_KEY: KEY.toString('hex'),
      AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    };
    const appDataDir = resolveAppDataDir(process.platform, apiEnv, home);
    const projectPath = join(home, 'projects', 'lazy');
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(appDataDir, { recursive: true });
    gitInit(projectPath);
    const memory = initializeProjectMemory({
      folderPath: projectPath,
      projectName: 'Lazy project',
      autoBackup: false,
    });
    const location: WhatISaidLocation = {
      appDataDir,
      projectRoot: projectPath,
      memoryId: memory.config!.memoryId,
    };
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      { id: 'lazy', name: 'Lazy project', folderPath: projectPath },
    ]));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: apiEnv,
    });
    children.push(child);

    const initialGlobalStatus = await jsonRequest(baseUrl, '/api/what-i-said/global-status', {});
    expect(initialGlobalStatus.response.status).toBe(200);
    expect(initialGlobalStatus.body.status).toEqual({
      configured: false,
      enabled: false,
      retentionDays: 90,
      analysisAllowed: false,
      updatedAt: null,
    });

    const configured = await jsonRequest(baseUrl, '/api/what-i-said/configure-all', {
      enabled: true,
      retentionDays: 90,
      analysisAllowed: false,
    });
    expect(configured.response.status).toBe(200);
    expect(configured.body.policy).toMatchObject({ enabled: true, retentionDays: 90 });
    expect(configured.body.applied).toEqual({
      registeredProjects: 1,
      appliedProjects: 1,
      failedProjects: 0,
    });
    expect(existsSync(whatISaidDatabasePath(location))).toBe(true);

    const configuredGlobalStatus = await jsonRequest(baseUrl, '/api/what-i-said/global-status', {});
    expect(configuredGlobalStatus.response.status).toBe(200);
    expect(configuredGlobalStatus.body.status).toMatchObject({
      configured: true,
      enabled: true,
      retentionDays: 90,
      analysisAllowed: false,
    });
    expect(Date.parse(configuredGlobalStatus.body.status.updatedAt)).toBeGreaterThan(0);

    const effective = await jsonRequest(baseUrl, '/api/what-i-said/status', { folderPath: projectPath });
    expect(effective.body.status).toMatchObject({
      enabled: true,
      retentionDays: 90,
      globalConfigured: true,
      cryptoState: 'ready',
    });
    expect(effective.body.status.lastCaptureAt).toBeNull();

    const captured = await jsonRequest(baseUrl, '/api/what-i-said/capture', { folderPath: projectPath });
    expect(captured.response.status).toBe(200);
    expect(captured.body.result.enabled).toBe(true);
    expect(existsSync(whatISaidDatabasePath(location))).toBe(true);

    const futurePath = join(home, 'projects', 'future');
    mkdirSync(futurePath, { recursive: true });
    gitInit(futurePath);
    const futureMemory = initializeProjectMemory({
      folderPath: futurePath,
      projectName: 'Future project',
      autoBackup: false,
    });
    const futureLocation: WhatISaidLocation = {
      appDataDir,
      projectRoot: futurePath,
      memoryId: futureMemory.config!.memoryId,
    };
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      { id: 'lazy', name: 'Lazy project', folderPath: projectPath },
      { id: 'future', name: 'Future project', folderPath: futurePath },
    ]));
    expect(existsSync(whatISaidDatabasePath(futureLocation))).toBe(false);

    const futureCaptured = await jsonRequest(baseUrl, '/api/what-i-said/capture', { folderPath: futurePath });
    expect(futureCaptured.response.status).toBe(200);
    expect(futureCaptured.body.result.enabled).toBe(true);
    expect(existsSync(whatISaidDatabasePath(futureLocation))).toBe(true);
  });

  test('reconciles an already-enabled global policy for every current project at server startup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-startup-policy-'));
    roots.push(home);
    const apiEnv = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      NODE_ENV: 'test',
      PORT: '9000',
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_BUNDLED_SIDECAR: '1',
      PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
      PORTMGR_WHAT_I_SAID_TEST_KEY: KEY.toString('hex'),
      AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    };
    const appDataDir = resolveAppDataDir(process.platform, apiEnv, home);
    const projectPath = join(home, 'projects', 'existing-policy');
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(appDataDir, { recursive: true });
    gitInit(projectPath);
    const memory = initializeProjectMemory({
      folderPath: projectPath,
      projectName: 'Existing policy project',
      autoBackup: false,
    });
    const location: WhatISaidLocation = {
      appDataDir,
      projectRoot: projectPath,
      memoryId: memory.config!.memoryId,
    };
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      { id: 'existing-policy', name: 'Existing policy project', folderPath: projectPath },
    ]));
    writeFileSync(join(appDataDir, 'what-i-said-settings.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      retentionDays: 365,
      analysisAllowed: false,
      updatedAt: '2026-08-31T00:00:00.000Z',
    }));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: apiEnv,
    });
    children.push(child);

    const deadline = Date.now() + 3_000;
    while (!existsSync(whatISaidDatabasePath(location)) && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(existsSync(whatISaidDatabasePath(location))).toBe(true);
    const status = await jsonRequest(baseUrl, '/api/what-i-said/status', { folderPath: projectPath });
    expect(status.body.status).toMatchObject({
      enabled: true,
      retentionDays: 365,
      cryptoState: 'ready',
      globalConfigured: true,
    });
  });

  test('returns the global empty state without probing every registered project', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-empty-api-'));
    roots.push(home);
    const apiEnv = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      NODE_ENV: 'test',
      PORT: '9000',
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_BUNDLED_SIDECAR: '1',
      PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
      PORTMGR_WHAT_I_SAID_TEST_KEY: KEY.toString('hex'),
      AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    };
    const appDataDir = resolveAppDataDir(process.platform, apiEnv, home);
    mkdirSync(appDataDir, { recursive: true });
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify(
      Array.from({ length: 250 }, (_, index) => ({
        id: `stale-${index}`,
        name: `Stale ${index}`,
        folderPath: join(home, 'missing', String(index)),
      })),
    ));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: apiEnv,
    });
    children.push(child);

    const startedAt = performance.now();
    const page = await jsonRequest(baseUrl, '/api/what-i-said/list', { limit: 50 });
    const elapsedMs = performance.now() - startedAt;
    expect(page.response.status).toBe(200);
    expect(page.body).toMatchObject({
      success: true,
      items: [],
      nextBeforeSeq: null,
      hasMore: false,
      scan: null,
    });
    // 범위에 장기기억이 하나도 없으면 신선도에 대해 할 말이 없다. null 은 「모름」이고,
    // 화면은 그때 「아직 수집된 적 없음」이라고 단정하지 않는다.
    expect(page.body.capture).toBeNull();
    expect(elapsedMs).toBeLessThan(2_000);
  });

  test('protects management, paginates every project without loss, and exposes only the redacted signed feed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-api-'));
    roots.push(home);
    const apiEnv = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      NODE_ENV: 'test',
      PORT: '9000',
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_BUNDLED_SIDECAR: '1',
      PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
      PORTMGR_WHAT_I_SAID_TEST_KEY: KEY.toString('hex'),
      AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    };
    const appDataDir = resolveAppDataDir(process.platform, apiEnv, home);
    mkdirSync(appDataDir, { recursive: true });

    const projects = [
      { id: 'alpha', name: 'Alpha', path: join(home, 'projects', 'alpha') },
      { id: 'beta', name: 'Beta', path: join(home, 'projects', 'beta') },
    ];
    const locations = new Map<string, WhatISaidLocation>();
    for (const project of projects) {
      mkdirSync(project.path, { recursive: true });
      gitInit(project.path);
      const memory = initializeProjectMemory({
        folderPath: project.path,
        projectName: project.name,
        autoBackup: false,
      });
      const location = {
        appDataDir,
        projectRoot: project.path,
        memoryId: memory.config!.memoryId,
      };
      configureWhatISaidCapture({
        ...location,
        enabled: true,
        retention: 'forever',
        analysisAllowed: false,
        now: '2026-08-30T09:00:00Z',
      });
      locations.set(project.id, location);
    }
    const alpha = locations.get('alpha')!;
    const beta = locations.get('beta')!;
    // Alpha's timestamps intentionally move backwards relative to its store
    // sequence. Flatten-sort-then-advance would permanently lose one of these.
    addPrompt(alpha, '1', '2026-08-30T12:00:00Z', 'email me at person@example.com from /Users/alice/private.txt');
    addPrompt(alpha, '2', '2026-08-30T10:00:00Z', 'password=correct-horse-battery-staple');
    addPrompt(beta, '1', '2026-08-30T11:00:00Z', 'beta middle prompt');
    const portsPath = join(appDataDir, 'ports.json');
    const projectRows = projects.map(project => ({
      id: project.id,
      name: project.name,
      folderPath: project.path,
    }));
    writeFileSync(portsPath, JSON.stringify(projectRows));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: apiEnv,
    });
    children.push(child);

    const health = await (await fetch(`${baseUrl}/api/health`)).json() as any;
    expect(health.schemaVersion).toBeGreaterThanOrEqual(11);
    expect(health.capabilities).toContain('what-i-said.management-v1');
    expect(health.capabilities).toContain('what-i-said.feed-v1');
    expect(health.sidecarProof).toBeUndefined();

    const proofHealth = await (await fetch(`${baseUrl}/api/health?nonce=${'11'.repeat(32)}`)).json() as any;
    expect(proofHealth.sidecarProof)
      .toBe('e5906a92c66f8e34cb3c9d66ef95d58e8aaee69bedf172a30b13cea700bf5d74');
    expect(JSON.stringify(proofHealth)).not.toContain(CAPABILITY);
    for (const invalidNonce of ['', '11'.repeat(31), 'AA'.repeat(32), 'not-hex']) {
      const invalidHealth = await (await fetch(`${baseUrl}/api/health?nonce=${invalidNonce}`)).json() as any;
      expect(invalidHealth.sidecarProof).toBeUndefined();
    }

    const noOrigin = await jsonRequest(baseUrl, '/api/what-i-said/status', { folderPath: projects[0]!.path }, {
      origin: null,
    });
    expect(noOrigin.response.status).toBe(403);
    expect(noOrigin.response.headers.get('access-control-allow-origin')).toBeNull();
    const noCapability = await jsonRequest(baseUrl, '/api/what-i-said/status', { folderPath: projects[0]!.path }, {
      capability: null,
    });
    expect(noCapability.response.status).toBe(403);
    const wrongCapability = await jsonRequest(baseUrl, '/api/what-i-said/status', { folderPath: projects[0]!.path }, {
      capability: 'd'.repeat(64),
    });
    expect(wrongCapability.response.status).toBe(403);
    const status = await jsonRequest(baseUrl, '/api/what-i-said/status', { folderPath: projects[0]!.path });
    expect(status.response.status).toBe(200);
    expect(status.body.status).toMatchObject({ enabled: true, retentionDays: 'forever', analysisAllowed: false });

    const seen: string[] = [];
    let beforeSeq: string | undefined;
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const page = await jsonRequest(baseUrl, '/api/what-i-said/list', { limit: 1, beforeSeq });
      expect(page.response.status).toBe(200);
      seen.push(...page.body.items.map((item: any) => item.text));
      if (!page.body.nextBeforeSeq) break;
      expect(page.body.nextBeforeSeq).toMatch(/^wisg1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      beforeSeq = page.body.nextBeforeSeq;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toContain('beta middle prompt');
    expect(seen).toContain('password=correct-horse-battery-staple');

    const firstPage = await jsonRequest(baseUrl, '/api/what-i-said/list', { limit: 1 });
    const cursor = String(firstPage.body.nextBeforeSeq);
    const replacement = cursor.endsWith('A') ? 'B' : 'A';
    const tampered = `${cursor.slice(0, -1)}${replacement}`;
    const badCursor = await jsonRequest(baseUrl, '/api/what-i-said/list', { limit: 1, beforeSeq: tampered });
    expect(badCursor.response.status).toBe(400);
    expect(badCursor.body.code).toBe('WHAT_I_SAID_CURSOR_INVALID');

    const source = await jsonRequest(baseUrl, '/api/what-i-said/source/enable', { folderPath: projects[0]!.path });
    expect(source.response.status).toBe(200);
    expect(source.body.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(source.body.status)).not.toContain(source.body.accessToken);
    const sourceStatus = await jsonRequest(baseUrl, '/api/what-i-said/source/status', { folderPath: projects[0]!.path });
    expect(JSON.stringify(sourceStatus.body)).not.toContain(source.body.accessToken);

    const unauthorized = await fetch(`${baseUrl}/api/what-i-said/feed`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('access-control-allow-origin')).toBeNull();
    const unauthorizedBody = await unauthorized.json() as any;
    expect(unauthorizedBody.code).toBe('WHAT_I_SAID_FEED_CHALLENGE_REQUIRED');
    expect(unauthorizedBody.auth.challenge).toMatch(/^[0-9a-f]{64}$/);
    const browserFeed = await fetch(`${baseUrl}/api/what-i-said/feed`, {
      headers: { Origin: TAURI_ORIGIN, Authorization: `Bearer ${source.body.accessToken}` },
    });
    expect(browserFeed.status).toBe(403);
    expect(browserFeed.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${baseUrl}/api/what-i-said/feed`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const controlAttempt = await fetch(`${baseUrl}/api/what-i-said/feed`, { method });
      expect(controlAttempt.status).toBe(405);
      expect((await controlAttempt.json() as any).code).toBe('METHOD_NOT_ALLOWED');
    }

    // Put a damaged unrelated store first to prove enumeration and auth keep
    // its failure scoped instead of blocking Alpha's valid credential.
    const betaDatabase = new Database(whatISaidDatabasePath(beta));
    const betaSchemaVersion = Number((betaDatabase.query('PRAGMA user_version').get() as any).user_version);
    betaDatabase.exec('PRAGMA user_version = 999');
    betaDatabase.close();
    writeFileSync(portsPath, JSON.stringify([...projectRows].reverse()));
    const feedAttempt = await challengedFeed(baseUrl, '/api/what-i-said/feed?limit=10', source.body.accessToken);
    const restoredBetaDatabase = new Database(whatISaidDatabasePath(beta));
    restoredBetaDatabase.exec(`PRAGMA user_version = ${betaSchemaVersion}`);
    restoredBetaDatabase.close();
    writeFileSync(portsPath, JSON.stringify(projectRows));
    const feed = feedAttempt.response;
    const feedBytes = new Uint8Array(await feed.arrayBuffer());
    const feedText = new TextDecoder().decode(feedBytes);
    const feedBody = JSON.parse(feedText) as any;
    expect(feed.status).toBe(200);
    expect(feed.headers.get('access-control-allow-origin')).toBeNull();
    expect(verifyWhatISaidAdapterResponse({
      accessKey: source.body.accessToken,
      challenge: feedAttempt.challenge,
      requestTarget: '/api/what-i-said/feed?limit=10',
      responseBody: feedBytes,
      responseProof: feed.headers.get('x-agentstoz-what-i-said-feed-proof'),
    })).toBe(true);
    expect(verifyWhatISaidAdapterResponse({
      accessKey: source.body.accessToken,
      challenge: feedAttempt.challenge,
      requestTarget: '/api/what-i-said/feed?limit=10',
      responseBody: new TextEncoder().encode('{"items":[{"text":"fabricated"}]}'),
      responseProof: feed.headers.get('x-agentstoz-what-i-said-feed-proof'),
    })).toBe(false);
    expect(feedBody.project).toMatchObject({ label: 'Alpha' });
    expect(feedBody.project.id).toMatch(/^wisp_[0-9a-f]{64}$/);
    expect(feedBody.scan.withheld).toBe(1);
    expect(feedBody.items).toHaveLength(1);
    expect(feedBody.items[0].text).not.toContain('person@example.com');
    expect(feedBody.items[0].text).not.toContain('/Users/alice');
    expect(JSON.stringify(feedBody)).not.toContain(alpha.memoryId);
    expect(JSON.stringify(feedBody)).not.toContain(projects[0]!.path);
    expect((await fetch(`${baseUrl}/api/what-i-said/feed?limit=10`, {
      headers: { Authorization: feedAttempt.authorization },
    })).status).toBe(401);
    const fakeListenerProof = createWhatISaidAdapterAuthorization({
      accessKey: source.body.accessToken,
      challenge: 'fe'.repeat(32),
      requestTarget: '/api/what-i-said/feed?limit=10',
    });
    expect((await fetch(`${baseUrl}/api/what-i-said/feed?limit=10`, {
      headers: { Authorization: fakeListenerProof },
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/what-i-said/feed?limit=10`, {
      headers: { Authorization: `Bearer ${source.body.accessToken}` },
    })).status).toBe(401);

    const rotated = await jsonRequest(baseUrl, '/api/what-i-said/source/rotate', { folderPath: projects[0]!.path });
    expect(rotated.body.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect((await challengedFeed(baseUrl, '/api/what-i-said/feed', source.body.accessToken)).response.status).toBe(401);
    expect((await challengedFeed(baseUrl, '/api/what-i-said/feed', rotated.body.accessToken)).response.status).toBe(200);
    const revoked = await jsonRequest(baseUrl, '/api/what-i-said/source', { folderPath: projects[0]!.path }, { method: 'DELETE' });
    expect(revoked.body.status.enabled).toBe(false);
    expect((await challengedFeed(baseUrl, '/api/what-i-said/feed', rotated.body.accessToken)).response.status).toBe(401);

    const alphaList = await jsonRequest(baseUrl, '/api/what-i-said/list', { folderPath: projects[0]!.path, limit: 10 });
    // 신선도는 목록 응답이 함께 나른다. 이 픽스처는 프롬프트를 직접 넣었을 뿐 스캔을
    // 돌린 적이 없으므로 「저장소는 읽었지만 수집 시각은 없다」가 정답이다 — 응답 자체가
    // 없는 것(=모름)과 다른 상태이고, 화면도 둘을 다르게 그려야 한다.
    // `oldestCaptureAt` 은 신선도를 판정하는 값이다. 최신값 하나만 보면 오늘 건드린
    // 프로젝트 하나가 나머지 전부의 정체를 가린다.
    expect(alphaList.body.capture).toEqual({ lastCaptureAt: null, oldestCaptureAt: null });
    const alphaItem = alphaList.body.items[0];
    const wrongProjectDelete = await jsonRequest(baseUrl, '/api/what-i-said/delete', {
      folderPath: projects[1]!.path,
      id: alphaItem.id,
    });
    expect(wrongProjectDelete.response.status).toBe(404);
    const unverifiedDelete = await jsonRequest(baseUrl, '/api/what-i-said/delete', {
      folderPath: projects[0]!.path,
      id: alphaItem.id,
    });
    expect(unverifiedDelete.response.status).toBe(503);
    expect(unverifiedDelete.body.code).toBe('WHAT_I_SAID_REMOTE_DELETE_UNVERIFIED');
    // Default failure keeps the local row intact. Only a second, explicit
    // local-only request may accept that an old remote copy could remain.
    const preserved = await jsonRequest(baseUrl, '/api/what-i-said/list', {
      folderPath: projects[0]!.path,
      limit: 10,
    });
    expect(preserved.body.items.some((item: any) => item.id === alphaItem.id)).toBe(true);
    const deleted = await jsonRequest(baseUrl, '/api/what-i-said/delete', {
      folderPath: projects[0]!.path,
      id: alphaItem.id,
      localOnly: true,
    });
    expect(deleted.body).toMatchObject({ success: true, purged: 1 });
    expect(deleted.body.remoteDeletion).toEqual({
      status: 'skipped', deleted: 0, reason: 'explicit-local-only',
    });

    const malformed = await fetch(`${baseUrl}/api/what-i-said/status`, {
      method: 'POST',
      headers: {
        Origin: TAURI_ORIGIN,
        'Content-Type': 'application/json',
        'X-AgentsToZ-What-I-Said-Capability': CAPABILITY,
      },
      body: '{"prompt":"must-not-echo"',
    });
    const malformedBody = await malformed.text();
    expect(malformed.status).toBe(400);
    expect(malformedBody).not.toContain('must-not-echo');
    expect(malformedBody).toContain('What-I-said 요청을 완료하지 못했습니다.');
  }, 30_000);

  test('revokes an orphaned feed before attaching a pathless registered project', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-path-attachment-'));
    roots.push(home);
    const projectPath = join(home, 'project');
    mkdirSync(projectPath, { recursive: true });
    gitInit(projectPath);
    const memory = initializeProjectMemory({
      folderPath: projectPath,
      projectName: 'Path attachment',
      autoBackup: false,
    });
    const apiEnv = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      NODE_ENV: 'test',
      PORT: '9000',
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_BUNDLED_SIDECAR: '1',
      PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
      PORTMGR_WHAT_I_SAID_TEST_KEY: KEY.toString('hex'),
      AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    };
    const appDataDir = resolveAppDataDir(process.platform, apiEnv, home);
    mkdirSync(appDataDir, { recursive: true });
    const location = {
      appDataDir,
      projectRoot: projectPath,
      memoryId: memory.config!.memoryId,
    };
    configureWhatISaidCapture({
      ...location,
      enabled: true,
      retention: 90,
      analysisAllowed: false,
      now: '2026-08-30T09:00:00Z',
    });
    const source = enableWhatISaidFeed({
      ...location,
      key: KEY,
      registrationId: 'pulled-pathless',
      tokenBytes: Buffer.alloc(32, 0x45),
      now: '2026-08-30T09:01:00Z',
    });
    const portsPath = join(appDataDir, 'ports.json');
    writeFileSync(portsPath, JSON.stringify([{
      id: 'pulled-pathless',
      name: 'Pulled pathless',
    }]));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: apiEnv,
    });
    children.push(child);
    expect(readWhatISaidStatus(location).feed.enabled).toBe(true);

    const revoked = await jsonRequest(baseUrl, '/api/what-i-said/source', {
      projectId: 'pulled-pathless',
    }, { method: 'DELETE' });
    expect(revoked.response.status).toBe(200);
    expect(revoked.body.status.enabled).toBe(false);
    expect(readWhatISaidStatus(location).feed.enabled).toBe(false);

    const attachmentSource = enableWhatISaidFeed({
      ...location,
      key: KEY,
      registrationId: 'older-registration',
      tokenBytes: Buffer.alloc(32, 0x46),
      now: '2026-08-30T09:02:00Z',
    });
    const attachmentRevoked = await jsonRequest(baseUrl, '/api/what-i-said/source', {
      projectId: 'pulled-pathless',
      folderPath: projectPath,
    }, { method: 'DELETE' });
    expect(attachmentRevoked.response.status).toBe(200);
    expect(readWhatISaidStatus(location).feed.enabled).toBe(false);

    // Simulate the UI persisting the destination path only after revocation.
    writeFileSync(portsPath, JSON.stringify([{
      id: 'pulled-pathless',
      name: 'Pulled pathless',
      folderPath: projectPath,
    }]));
    expect((await challengedFeed(
      baseUrl,
      '/api/what-i-said/feed',
      source.token,
    )).response.status).toBe(401);
    expect((await challengedFeed(
      baseUrl,
      '/api/what-i-said/feed',
      attachmentSource.token,
    )).response.status).toBe(401);
  }, 30_000);

  test('keeps a consented feed live while a removed alias is rebound and ports persistence catches up', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-alias-rebind-'));
    roots.push(home);
    const projectPath = join(home, 'project');
    mkdirSync(projectPath, { recursive: true });
    gitInit(projectPath);
    const memory = initializeProjectMemory({
      folderPath: projectPath,
      projectName: 'Alias rebind',
      autoBackup: false,
    });
    const apiEnv = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      NODE_ENV: 'test',
      PORT: '9000',
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_BUNDLED_SIDECAR: '1',
      PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
      PORTMGR_WHAT_I_SAID_TEST_KEY: KEY.toString('hex'),
      AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    };
    const appDataDir = resolveAppDataDir(process.platform, apiEnv, home);
    mkdirSync(appDataDir, { recursive: true });
    const location = {
      appDataDir,
      projectRoot: projectPath,
      memoryId: memory.config!.memoryId,
    };
    configureWhatISaidCapture({
      ...location,
      enabled: true,
      retention: 90,
      analysisAllowed: false,
      now: '2026-08-30T09:00:00Z',
    });
    const source = enableWhatISaidFeed({
      ...location,
      key: KEY,
      registrationId: 'alias-a',
      tokenBytes: Buffer.alloc(32, 0x47),
      now: '2026-08-30T09:01:00Z',
    });
    const portsPath = join(appDataDir, 'ports.json');
    const aliasB = { id: 'alias-b', name: 'Alias B', folderPath: projectPath };
    writeFileSync(portsPath, JSON.stringify([
      { id: 'alias-a', name: 'Alias A', folderPath: projectPath },
      aliasB,
    ]));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: apiEnv,
    });
    children.push(child);

    const rebound = await jsonRequest(baseUrl, '/api/what-i-said/source', {
      folderPath: projectPath,
      projectId: 'alias-a',
      removingProjectIds: ['alias-a'],
    }, { method: 'DELETE' });
    expect(rebound.response.status).toBe(200);
    expect(rebound.body.status.enabled).toBe(true);

    // The app intentionally persists ports only after the sharing transition.
    // A polling reader in this window must resolve the newly bound alias B,
    // not mismatch against the still-present representative A and revoke it.
    expect((await challengedFeed(
      baseUrl,
      '/api/what-i-said/feed',
      source.token,
    )).response.status).toBe(200);
    expect(readWhatISaidStatus(location).feed.enabled).toBe(true);

    writeFileSync(portsPath, JSON.stringify([aliasB]));
    expect((await challengedFeed(
      baseUrl,
      '/api/what-i-said/feed',
      source.token,
    )).response.status).toBe(200);
    expect(readWhatISaidStatus(location).feed.enabled).toBe(true);
  }, 30_000);

  test('does not enable or rotate a source before secure-key preflight succeeds', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-key-preflight-'));
    roots.push(home);
    const projectPath = join(home, 'project');
    mkdirSync(projectPath, { recursive: true });
    gitInit(projectPath);
    const memory = initializeProjectMemory({
      folderPath: projectPath,
      projectName: 'Key preflight',
      autoBackup: false,
    });
    const appDataDir = resolveAppDataDir(process.platform, {
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
    }, home);
    mkdirSync(appDataDir, { recursive: true });
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([{
      id: 'key-preflight',
      name: 'Key preflight',
      folderPath: projectPath,
    }]));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME: join(home, '.config'),
        NODE_ENV: 'test',
        PORT: '9000',
        PORTMGR_ALLOWED_ORIGINS: '',
        PORTMGR_BUNDLED_SIDECAR: '1',
        PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
        PORTMGR_WHAT_I_SAID_TEST_KEY: 'malformed-test-key',
        AGENTSTOZ_SKIP_HERMES_SYNC: '1',
      },
    });
    children.push(child);

    const location = {
      appDataDir,
      projectRoot: projectPath,
      memoryId: memory.config!.memoryId,
    };
    const virginStatus = await jsonRequest(baseUrl, '/api/what-i-said/status', { folderPath: projectPath });
    expect(virginStatus.response.status).toBe(200);
    expect(virginStatus.body.status.enabled).toBe(false);
    expect(existsSync(whatISaidDatabasePath(location))).toBe(false);

    const configure = await jsonRequest(baseUrl, '/api/what-i-said/configure', {
      folderPath: projectPath,
      enabled: true,
      retentionDays: 90,
      analysisAllowed: false,
    });
    expect(configure.response.status).toBe(503);
    expect(configure.body.code).toBe('WHAT_I_SAID_KEY_MALFORMED');
    expect(existsSync(whatISaidDatabasePath(location))).toBe(false);

    const enable = await jsonRequest(baseUrl, '/api/what-i-said/source/enable', { folderPath: projectPath });
    expect(enable.response.status).toBe(503);
    expect(enable.body.code).toBe('WHAT_I_SAID_KEY_MALFORMED');
    const status = await jsonRequest(baseUrl, '/api/what-i-said/source/status', { folderPath: projectPath });
    expect(status.response.status).toBe(200);
    expect(status.body.status.enabled).toBe(false);

    const rotate = await jsonRequest(baseUrl, '/api/what-i-said/source/rotate', { folderPath: projectPath });
    expect(rotate.response.status).toBe(503);
    expect(rotate.body.code).toBe('WHAT_I_SAID_KEY_MALFORMED');
    const statusAfterRotate = await jsonRequest(baseUrl, '/api/what-i-said/source/status', { folderPath: projectPath });
    expect(statusAfterRotate.body.status.enabled).toBe(false);
  }, 30_000);

  test('an unauthorized feed proof cannot bind a key to an OFF source', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-feed-readonly-'));
    roots.push(home);
    const projectPath = join(home, 'project');
    mkdirSync(projectPath, { recursive: true });
    gitInit(projectPath);
    const memory = initializeProjectMemory({
      folderPath: projectPath,
      projectName: 'Feed read only',
      autoBackup: false,
    });
    const apiEnv = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      NODE_ENV: 'test',
      PORT: '9000',
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_BUNDLED_SIDECAR: '1',
      PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
      PORTMGR_WHAT_I_SAID_TEST_KEY: '31'.repeat(32),
      AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    };
    const appDataDir = resolveAppDataDir(process.platform, apiEnv, home);
    mkdirSync(appDataDir, { recursive: true });
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([{
      id: 'feed-readonly', name: 'Feed read only', folderPath: projectPath,
    }]));
    const location = {
      appDataDir,
      projectRoot: projectPath,
      memoryId: memory.config!.memoryId,
    };
    expect(readWhatISaidStatus(location).feed.enabled).toBe(false);
    const databasePath = whatISaidDatabasePath(location);
    const beforeBytes = readFileSync(databasePath);
    const beforeStat = statSync(databasePath);
    const before = new Database(databasePath, { readonly: true });
    const beforeVersion = (before.query(`PRAGMA user_version`).get() as any).user_version;
    expect((before.query(`SELECT key_verifier FROM what_i_said_settings`).get() as any).key_verifier).toBeNull();
    before.close();

    const { baseUrl, child } = await startTestApiServer({ cwd: join(import.meta.dir, '..'), env: apiEnv });
    children.push(child);
    const challengeResponse = await fetch(`${baseUrl}/api/what-i-said/feed`);
    const challenge = (await challengeResponse.json() as any).auth.challenge as string;
    const authorization = createWhatISaidAdapterAuthorization({
      accessKey: '22'.repeat(32),
      challenge,
      requestTarget: '/api/what-i-said/feed',
    });
    expect((await fetch(`${baseUrl}/api/what-i-said/feed`, {
      headers: { Authorization: authorization },
    })).status).toBe(401);

    const after = new Database(databasePath, { readonly: true });
    expect((after.query(`SELECT key_verifier FROM what_i_said_settings`).get() as any).key_verifier).toBeNull();
    expect((after.query(`PRAGMA user_version`).get() as any).user_version).toBe(beforeVersion);
    after.close();
    expect(readFileSync(databasePath)).toEqual(beforeBytes);
    expect(statSync(databasePath).mtimeMs).toBe(beforeStat.mtimeMs);
  }, 30_000);

  test('rejects a valid-looking replacement key before Ready or mutation and preserves the original feed key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-wrong-key-'));
    roots.push(home);
    const projectPath = join(home, 'project');
    mkdirSync(projectPath, { recursive: true });
    gitInit(projectPath);
    const memory = initializeProjectMemory({
      folderPath: projectPath,
      projectName: 'Wrong key',
      autoBackup: false,
    });
    const appDataDir = resolveAppDataDir(process.platform, {
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
    }, home);
    mkdirSync(appDataDir, { recursive: true });
    const location = { appDataDir, projectRoot: projectPath, memoryId: memory.config!.memoryId };
    configureWhatISaidCapture({
      ...location,
      enabled: true,
      retention: 'forever',
      analysisAllowed: false,
      now: '2026-08-30T09:00:00Z',
    });
    addPrompt(location, 'bound', '2026-08-30T12:00:00Z', 'original encrypted prompt');
    const source = enableWhatISaidFeed({
      ...location,
      key: KEY,
      registrationId: 'wrong-key',
      tokenBytes: Buffer.alloc(32, 0x23),
      now: '2026-08-30T12:01:00Z',
    });
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([{
      id: 'wrong-key',
      name: 'Wrong key',
      folderPath: projectPath,
    }]));
    const commonEnv = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      NODE_ENV: 'test',
      PORT: '9000',
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_BUNDLED_SIDECAR: '1',
      PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
      AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    };

    const wrong = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: { ...commonEnv, PORTMGR_WHAT_I_SAID_TEST_KEY: Buffer.alloc(32, 0x7f).toString('hex') },
    });
    children.push(wrong.child);
    for (const path of ['/api/what-i-said/status', '/api/what-i-said/source/status']) {
      const response = await jsonRequest(wrong.baseUrl, path, { folderPath: projectPath });
      expect(response.response.status).toBe(503);
      expect(response.body.code).toBe('WHAT_I_SAID_KEY_INVALID');
    }
    const disabledWithoutKey = await jsonRequest(wrong.baseUrl, '/api/what-i-said/configure', {
      folderPath: projectPath,
      enabled: false,
      retentionDays: 30,
      analysisAllowed: false,
    });
    expect(disabledWithoutKey.response.status).toBe(200);
    expect(disabledWithoutKey.body.status).toMatchObject({
      enabled: false,
      retentionDays: 30,
      cryptoState: 'unavailable',
    });
    expect(readWhatISaidStatus(location).enabled).toBe(false);
    expect((await challengedFeed(
      wrong.baseUrl,
      '/api/what-i-said/feed',
      source.token,
    )).response.status).toBe(401);
    wrong.child.kill();
    await wrong.child.exited;

    const restored = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: { ...commonEnv, PORTMGR_WHAT_I_SAID_TEST_KEY: KEY.toString('hex') },
    });
    children.push(restored.child);
    const restoredStatus = await jsonRequest(restored.baseUrl, '/api/what-i-said/source/status', { folderPath: projectPath });
    expect(restoredStatus.response.status).toBe(200);
    expect(restoredStatus.body.status.enabled).toBe(true);
    const feed = (await challengedFeed(
      restored.baseUrl,
      '/api/what-i-said/feed',
      source.token,
    )).response;
    expect(feed.status).toBe(200);
    const restoredText = await feed.text();
    expect(JSON.parse(restoredText).items[0]?.text).toBe('original encrypted prompt');
  }, 30_000);
});
