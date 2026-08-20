import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolvePortalDeviceIdentity } from '../src/portalDeviceIdentityOwner';

const manager = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

const existingId = '11111111-1111-4111-8111-111111111111';
const generatedId = '22222222-2222-4222-8222-222222222222';
const browserId = '33333333-3333-4333-8333-333333333333';

describe('portal device identity ownership', () => {
  test('Tauri trusts a valid portal.json identity without touching browser storage', () => {
    let browserReads = 0;
    const result = resolvePortalDeviceIdentity({
      runtime: 'tauri',
      portalDeviceId: existingId,
      createId: () => generatedId,
      getBrowserDeviceId: () => { browserReads += 1; return browserId; },
    });

    expect(result).toEqual({ deviceId: existingId, needsPersist: false });
    expect(browserReads).toBe(0);
  });

  test('Tauri creates and persists a new portal.json identity without browser fallback', () => {
    let browserReads = 0;
    const result = resolvePortalDeviceIdentity({
      runtime: 'tauri',
      portalDeviceId: undefined,
      createId: () => generatedId,
      getBrowserDeviceId: () => { browserReads += 1; return browserId; },
    });

    expect(result).toEqual({ deviceId: generatedId, needsPersist: true });
    expect(browserReads).toBe(0);
  });

  test('web surfaces retain the browser-owned identity', () => {
    let browserReads = 0;
    const result = resolvePortalDeviceIdentity({
      runtime: 'web',
      portalDeviceId: undefined,
      createId: () => generatedId,
      getBrowserDeviceId: () => { browserReads += 1; return browserId; },
    });

    expect(result).toEqual({ deviceId: browserId, needsPersist: true });
    expect(browserReads).toBe(1);
  });

  test('native load failures are fail-closed and native saves keep JSON object shape', () => {
    expect(manager).toContain('if (isTauri()) throw error;');
    expect(manager).toContain("runtime: isTauri() ? 'tauri' : 'web'");
    expect(manager).toContain('if (!isTauri()) setOwnDeviceId(newId);');
    expect(app).not.toContain("invoke('save_portal', { data: JSON.stringify(next) })");
    expect(app).toContain("invoke('save_portal', { data: next })");
  });
});
