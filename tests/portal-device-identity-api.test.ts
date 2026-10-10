import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppDataDir } from '../src/appDataDir';
import { startTestApiServer } from './startTestApiServer';

const DEVICE_ID = 'fe3088df-1a7a-4223-b886-75b99765fe74';
const roots: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(portal: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'agentstoz-portal-identity-'));
  roots.push(home);
  const env = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    NODE_ENV: 'test',
    PORTMGR_ALLOWED_ORIGINS: '',
    PORTMGR_BUNDLED_SIDECAR: '1',
    AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1',
  };
  const appDataDir = resolveAppDataDir(process.platform, env, home);
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(join(appDataDir, 'portal.json'), JSON.stringify(portal));
  const { baseUrl, child } = await startTestApiServer({ cwd: join(import.meta.dir, '..'), env });
  children.push(child);
  return { baseUrl, appDataDir };
}

describe('portal.json device identity survives whole-file writes', () => {
  test('a POST without deviceId (the 2026-09-27 fixture write) keeps the id and records it', async () => {
    const { baseUrl, appDataDir } = await start({ deviceId: DEVICE_ID, deviceName: 'Mac A', items: [] });
    const response = await fetch(`${baseUrl}/api/portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'stale-bookmark' }], categories: [] }),
    });
    expect(response.status).toBe(200);
    const stored = JSON.parse(readFileSync(join(appDataDir, 'portal.json'), 'utf8'));
    expect(stored.deviceId).toBe(DEVICE_ID);
    expect(stored.deviceName).toBe('Mac A');
    const recordPath = join(appDataDir, 'portal-device-identity.json');
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual({ deviceId: DEVICE_ID, deviceName: 'Mac A' });
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
  });

  test('a portal.json that already lost its id is healed from the record on the next read', async () => {
    const { baseUrl, appDataDir } = await start({ deviceId: DEVICE_ID, deviceName: 'Mac A', items: [] });
    // First read records the identity.
    expect(((await (await fetch(`${baseUrl}/api/portal`)).json()) as any).deviceId).toBe(DEVICE_ID);
    // Something outside the API clobbers portal.json.
    writeFileSync(join(appDataDir, 'portal.json'), JSON.stringify({ items: [], categories: [] }));
    const loaded = await (await fetch(`${baseUrl}/api/portal`)).json() as any;
    expect(loaded.deviceId).toBe(DEVICE_ID);
    expect(loaded.deviceName).toBe('Mac A');
    expect(JSON.parse(readFileSync(join(appDataDir, 'portal.json'), 'utf8')).deviceId).toBe(DEVICE_ID);
  });

  test('a first install without any identity stays empty so the app mints exactly once', async () => {
    const { baseUrl, appDataDir } = await start({ items: [], categories: [] });
    const loaded = await (await fetch(`${baseUrl}/api/portal`)).json() as any;
    expect(loaded.deviceId).toBeUndefined();
    expect(existsSync(join(appDataDir, 'portal-device-identity.json'))).toBe(false);
  });
});
