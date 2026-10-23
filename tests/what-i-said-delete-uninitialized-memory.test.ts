import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initializeProjectMemory } from '../project-memory-server';
import { resolveAppDataDir } from '../src/appDataDir';
import {
  configureWhatISaidCapture,
  enableWhatISaidFeed,
  readWhatISaidStatus,
  whatISaidDatabasePath,
} from '../src/whatISaidStore';
import { startTestApiServer } from './startTestApiServer';

// Regression: a registered project that never started long-term memory could not
// be deleted. Removal revokes What-I-said sharing first (fail closed), and the
// family-removal branch of DELETE /api/what-i-said/source required an initialized
// memory, so it answered PROJECT_MEMORY_NOT_INITIALIZED forever (Coffee-v1, 2026-10-04).

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
const KEY = Buffer.alloc(32, 0x31);
const CAPABILITY = 'c'.repeat(64);

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitInit(path: string): void {
  const result = Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: path, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function fixture(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  roots.push(home);
  const env = {
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
  const appDataDir = resolveAppDataDir(process.platform, env, home);
  mkdirSync(appDataDir, { recursive: true });
  return { home, env, appDataDir };
}

async function start(env: Record<string, string | undefined>) {
  const { baseUrl, child } = await startTestApiServer({ cwd: join(import.meta.dir, '..'), env });
  children.push(child);
  return baseUrl;
}

async function revokeBeforeRemoval(baseUrl: string, folderPath: string, projectId: string, removingProjectIds: string[]) {
  const response = await fetch(`${baseUrl}/api/what-i-said/source`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://tauri.localhost',
      'X-AgentsToZ-What-I-Said-Capability': CAPABILITY,
    },
    body: JSON.stringify({ folderPath, projectId, removingProjectIds }),
  });
  return { status: response.status, body: await response.json() as any };
}

describe('What-I-said revocation before removing a project without long-term memory', () => {
  test('a registered Git project that never started memory can be removed', async () => {
    const { home, env, appDataDir } = fixture('agentstoz-wis-delete-nomem-');
    const projectPath = join(home, 'Coffee-v1');
    mkdirSync(projectPath, { recursive: true });
    gitInit(projectPath);
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      { id: 'coffee', name: 'Coffee-v1', folderPath: projectPath },
    ]));
    const baseUrl = await start(env);

    const result = await revokeBeforeRemoval(baseUrl, projectPath, 'coffee', ['coffee']);
    expect(result.body).toMatchObject({ success: true, status: { enabled: false } });
    expect(result.status).toBe(200);
  }, 30_000);

  test('a registered plain folder (no Git) that never started memory can be removed', async () => {
    const { home, env, appDataDir } = fixture('agentstoz-wis-delete-nomem-plain-');
    const projectPath = join(home, 'plain');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      { id: 'plain', name: 'plain', folderPath: projectPath },
    ]));
    const baseUrl = await start(env);

    const result = await revokeBeforeRemoval(baseUrl, projectPath, 'plain', ['plain']);
    expect(result.status).toBe(200);
    expect(result.body.status.enabled).toBe(false);
  }, 30_000);

  test('a feed still bound to the removed registration is revoked even though the folder lost its memory', async () => {
    const { home, env, appDataDir } = fixture('agentstoz-wis-delete-nomem-bound-');
    const projectPath = join(home, 'project');
    mkdirSync(projectPath, { recursive: true });
    gitInit(projectPath);
    const memory = initializeProjectMemory({ folderPath: projectPath, projectName: 'Bound', autoBackup: false });
    const location = { appDataDir, projectRoot: projectPath, memoryId: memory.config!.memoryId };
    configureWhatISaidCapture({ ...location, enabled: true, retention: 90, analysisAllowed: false, now: '2026-10-04T09:00:00Z' });
    enableWhatISaidFeed({ ...location, key: KEY, registrationId: 'bound', tokenBytes: Buffer.alloc(32, 0x47), now: '2026-10-04T09:01:00Z' });
    expect(readWhatISaidStatus(location).feed.enabled).toBe(true);
    // The whole memory folder disappears (deleted by hand); the store in app data stays.
    rmSync(join(projectPath, '.agent-memory'), { recursive: true, force: true });
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      { id: 'bound', name: 'Bound', folderPath: projectPath },
    ]));
    const baseUrl = await start(env);

    const result = await revokeBeforeRemoval(baseUrl, projectPath, 'bound', ['bound']);
    expect(result.status).toBe(200);
    expect(result.body.status.enabled).toBe(false);
    expect(readWhatISaidStatus(location).feed.enabled).toBe(false);
  }, 30_000);

  test('a damaged memory configuration still fails closed', async () => {
    const { home, env, appDataDir } = fixture('agentstoz-wis-delete-damaged-');
    const projectPath = join(home, 'project');
    mkdirSync(projectPath, { recursive: true });
    gitInit(projectPath);
    initializeProjectMemory({ folderPath: projectPath, projectName: 'Damaged', autoBackup: false });
    writeFileSync(join(projectPath, '.agent-memory', 'config.json'), '{not json');
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      { id: 'damaged', name: 'Damaged', folderPath: projectPath },
    ]));
    const baseUrl = await start(env);

    const result = await revokeBeforeRemoval(baseUrl, projectPath, 'damaged', ['damaged']);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.code).toBe('PROJECT_MEMORY_NOT_INITIALIZED');
  }, 30_000);

  test('a missing config next to a surviving memory folder still fails closed', async () => {
    const { home, env, appDataDir } = fixture('agentstoz-wis-delete-noconfig-');
    const projectPath = join(home, 'project');
    mkdirSync(projectPath, { recursive: true });
    gitInit(projectPath);
    initializeProjectMemory({ folderPath: projectPath, projectName: 'No config', autoBackup: false });
    rmSync(join(projectPath, '.agent-memory', 'config.json'));
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      { id: 'noconfig', name: 'No config', folderPath: projectPath },
    ]));
    const baseUrl = await start(env);

    const result = await revokeBeforeRemoval(baseUrl, projectPath, 'noconfig', ['noconfig']);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.code).toBe('PROJECT_MEMORY_NOT_INITIALIZED');
  }, 30_000);

  test('another project in the removal scope keeps its feed, and an ambiguous store still fails closed', async () => {
    const { home, env, appDataDir } = fixture('agentstoz-wis-delete-nomem-scope-');
    const coffee = join(home, 'Coffee-v1');
    mkdirSync(coffee, { recursive: true });
    gitInit(coffee);
    const other = join(home, 'other');
    mkdirSync(other, { recursive: true });
    gitInit(other);
    const memory = initializeProjectMemory({ folderPath: other, projectName: 'Other', autoBackup: false });
    const otherLocation = { appDataDir, projectRoot: other, memoryId: memory.config!.memoryId };
    configureWhatISaidCapture({ ...otherLocation, enabled: true, retention: 90, analysisAllowed: false, now: '2026-10-04T09:00:00Z' });
    enableWhatISaidFeed({ ...otherLocation, key: KEY, registrationId: 'other', tokenBytes: Buffer.alloc(32, 0x48), now: '2026-10-04T09:01:00Z' });
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      { id: 'coffee', name: 'Coffee-v1', folderPath: coffee },
      { id: 'other', name: 'Other', folderPath: other },
    ]));
    const baseUrl = await start(env);

    const result = await revokeBeforeRemoval(baseUrl, coffee, 'coffee', ['coffee', 'other']);
    expect(result.status).toBe(200);
    expect(readWhatISaidStatus(otherLocation).feed.enabled).toBe(true);

    // An unreadable store cannot be attributed to any registration.
    writeFileSync(join(dirname(whatISaidDatabasePath(otherLocation)), `${'0'.repeat(64)}.sqlite`), 'not a database');
    const ambiguous = await revokeBeforeRemoval(baseUrl, coffee, 'coffee', ['coffee']);
    expect(ambiguous.status).toBeGreaterThanOrEqual(400);
    expect(ambiguous.body.code).toBe('WHAT_I_SAID_FEED_REGISTRATION_AMBIGUOUS');
  }, 30_000);

  test('a registered folder that is missing on disk still fails closed', async () => {
    const { home, env, appDataDir } = fixture('agentstoz-wis-delete-missing-');
    const projectPath = join(home, 'unmounted');
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      { id: 'missing', name: 'missing', folderPath: projectPath },
    ]));
    const baseUrl = await start(env);

    const result = await revokeBeforeRemoval(baseUrl, projectPath, 'missing', ['missing']);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.success).toBe(false);
  }, 30_000);
});
