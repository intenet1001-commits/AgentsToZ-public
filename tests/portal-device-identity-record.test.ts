import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPortalDeviceIdentity } from '../src/portalDeviceIdentityRecord';

type GoldenCase = {
  name: string;
  incoming: Record<string, unknown>;
  current: Record<string, unknown> | null;
  record: Record<string, unknown> | null;
  expect: {
    deviceId: string | null;
    deviceName: string | null;
    restored: boolean;
    record: { deviceId: string; deviceName?: string } | null;
  };
};

const golden = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/portal-device-identity-golden.json'), 'utf8')) as { cases: GoldenCase[] };

describe('portal device identity guard (shared golden with Rust)', () => {
  for (const row of golden.cases) {
    test(row.name, () => {
      const result = applyPortalDeviceIdentity({ incoming: row.incoming, current: row.current, record: row.record });
      expect(result.portal.deviceId ?? null).toBe(row.expect.deviceId);
      expect(result.portal.deviceName ?? null).toBe(row.expect.deviceName);
      expect(result.restored).toBe(row.expect.restored);
      expect(result.record).toEqual(row.expect.record);
    });
  }

  test('other portal fields pass through untouched', () => {
    const result = applyPortalDeviceIdentity({
      incoming: { items: [{ id: 'a' }], supabaseUrl: 'https://x.supabase.co' },
      current: { deviceId: 'fe3088df-1a7a-4223-b886-75b99765fe74' },
      record: null,
    });
    expect(result.portal).toMatchObject({ items: [{ id: 'a' }], supabaseUrl: 'https://x.supabase.co' });
  });
});
