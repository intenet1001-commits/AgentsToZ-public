/**
 * What has to survive a restart, and what must not.
 *
 * The listener used to live only in a module variable, so every app update closed it, dropped every
 * paired phone and — because the port was ephemeral — changed the URL the QR encodes. Resuming it
 * means writing bearer tokens down, so the rules about what comes back are the whole safety story.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REMOTE_CONTROL_LAN_RECORD_VERSION,
  clearRemoteControlLanLocalDisable,
  deleteRemoteControlLanRecord,
  isRemoteControlLanLocallyDisabled,
  markRemoteControlLanLocallyDisabled,
  normalizeRemoteControlLanRecord,
  readRemoteControlLanRecord,
  remoteControlLanRecordPath,
  writeRemoteControlLanRecord,
} from '../src/remoteControlLanVault';
import { REMOTE_CONTROL_PROTOCOL_VERSION, RemoteControlCore } from '../src/remoteControlCore';
import type { RemoteControlGateway } from '../src/remoteControlCore';

const token = (fill: string) => fill.repeat(43).slice(0, 43);

function record(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: REMOTE_CONTROL_LAN_RECORD_VERSION,
    bindAddress: '192.168.1.20',
    port: 43210,
    sessions: [{
      sessionToken: token('A'),
      createdAt: 1_000,
      lastActiveAt: 2_000,
      pairedAt: '2026-09-10T01:00:00.000Z',
    }],
    ...overrides,
  };
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'lan-vault-'));
}

describe('LAN remote-control record', () => {
  test('round-trips through a private file and refuses a symlink in its place', () => {
    const dir = scratch();
    try {
      expect(readRemoteControlLanRecord(dir)).toBeNull();
      writeRemoteControlLanRecord(dir, record() as never);
      expect(readRemoteControlLanRecord(dir)).toEqual(record() as never);
      // The file holds bearer tokens, so the mode is part of the contract, not a detail.
      expect(statSync(remoteControlLanRecordPath(dir)).mode & 0o777).toBe(0o600);

      rmSync(remoteControlLanRecordPath(dir));
      writeFileSync(join(dir, 'elsewhere.json'), JSON.stringify(record()));
      symlinkSync(join(dir, 'elsewhere.json'), remoteControlLanRecordPath(dir));
      expect(readRemoteControlLanRecord(dir)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('fails closed on anything it cannot fully vouch for', () => {
    // A half-restored listener advertises sessions no phone agrees with. One QR scan is cheaper.
    expect(normalizeRemoteControlLanRecord(record({ schemaVersion: 2 }))).toBeNull();
    expect(normalizeRemoteControlLanRecord(record({ bindAddress: '' }))).toBeNull();
    expect(normalizeRemoteControlLanRecord(record({ port: 0 }))).toBeNull();
    expect(normalizeRemoteControlLanRecord(record({ port: 70_000 }))).toBeNull();
    expect(normalizeRemoteControlLanRecord(record({ sessions: [{ sessionToken: 'short', createdAt: 1, lastActiveAt: 1, pairedAt: '2026-09-10T01:00:00.000Z' }] }))).toBeNull();
    expect(normalizeRemoteControlLanRecord(record({ sessions: [{ sessionToken: token('A'), createdAt: -1, lastActiveAt: 1, pairedAt: '2026-09-10T01:00:00.000Z' }] }))).toBeNull();
    expect(normalizeRemoteControlLanRecord(record({ sessions: [{ sessionToken: token('A'), createdAt: 1, lastActiveAt: 1, pairedAt: 'not-a-date' }] }))).toBeNull();
    // A duplicated token would restore one phone as two revocable rows.
    const twice = { sessionToken: token('A'), createdAt: 1, lastActiveAt: 1, pairedAt: '2026-09-10T01:00:00.000Z' };
    expect(normalizeRemoteControlLanRecord(record({ sessions: [twice, { ...twice }] }))).toBeNull();
  });

  test('the disable marker outranks the record, and enabling again withdraws it', () => {
    const dir = scratch();
    try {
      writeRemoteControlLanRecord(dir, record() as never);
      markRemoteControlLanLocallyDisabled(dir);
      expect(isRemoteControlLanLocallyDisabled(dir)).toBe(true);
      // Durable first: startup obeys the marker even if the record survived deletion.
      writeRemoteControlLanRecord(dir, record() as never);
      expect(readRemoteControlLanRecord(dir)).toBeNull();

      clearRemoteControlLanLocalDisable(dir);
      expect(isRemoteControlLanLocallyDisabled(dir)).toBe(false);
      expect(readRemoteControlLanRecord(dir)).not.toBeNull();
      deleteRemoteControlLanRecord(dir);
      expect(readRemoteControlLanRecord(dir)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('resuming sessions is a resume, not a grant', () => {
  const gateway: RemoteControlGateway = {
    listRegisteredProjects: () => [],
    executeRegisteredProjectAction: () => undefined,
  };
  const core = (now: () => number) => new RemoteControlCore(gateway, {
    hostName: '이 Mac',
    now,
    randomBytes: (length: number) => Uint8Array.from({ length }, (_, index) => (index * 13 + 5) & 0xff),
  });

  test('a restored token is the phone’s own and works without a new QR', async () => {
    const instance = core(() => 10_000);
    instance.enable('http://192.168.1.20:43210');
    expect(instance.restoreSessions([{ sessionToken: token('A'), createdAt: 1_000, lastActiveAt: 2_000 }])).toBe(1);
    const restored = await instance.restore(token('A'));
    expect(restored.type).toBe('session.restored');
    expect(restored.sessionToken).toBe(token('A'));
  });

  test('deadlines are the host’s, so a token that aged out while the Mac was off stays dead', () => {
    const day = 24 * 60 * 60_000;
    const instance = core(() => 40 * day);
    instance.enable('http://192.168.1.20:43210');
    // Idle past 30 days.
    expect(instance.restoreSessions([{ sessionToken: token('A'), createdAt: 39 * day, lastActiveAt: 1 }])).toBe(0);
    // Created past 30 days, still recently active.
    expect(instance.restoreSessions([{ sessionToken: token('B'), createdAt: 1, lastActiveAt: 40 * day - 1 }])).toBe(0);
    expect(instance.status().sessionCount).toBe(0);
  });

  test('exported sessions are exactly what restoreSessions needs, and the limit still applies', async () => {
    const first = core(() => 10_000);
    const pairing = first.enable('http://192.168.1.20:43210');
    const pair = new URLSearchParams(new URL(pairing.pairingUrl).hash.slice(1)).get('pair')!;
    const ready = await first.pair(pair);
    const exported = first.exportSessions();
    expect(exported).toEqual([{ sessionToken: ready.sessionToken, createdAt: 10_000, lastActiveAt: 10_000 }]);

    const second = core(() => 10_000);
    second.enable('http://192.168.1.20:43210');
    expect(second.restoreSessions(exported)).toBe(1);
    // Re-applying the same record must not double-count the phone.
    expect(second.restoreSessions(exported)).toBe(0);
    expect(second.status().sessionCount).toBe(1);
  });

  test('restoring into a disabled core is refused rather than silently enabling it', () => {
    const instance = core(() => 10_000);
    expect(() => instance.restoreSessions([{ sessionToken: token('A'), createdAt: 1, lastActiveAt: 1 }]))
      .toThrow();
  });
});
