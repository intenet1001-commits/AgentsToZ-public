import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REMOTE_CONTROL_HOST_RECORD_VERSION,
  clearRemoteControlHostDisabledTombstone,
  deleteRemoteControlHostRecord,
  disableRemoteControlHostRecord,
  isRemoteControlHostLocallyDisabled,
  markRemoteControlHostLocallyDisabled,
  normalizeRemoteControlHostRecord,
  readRemoteControlHostRecord,
  remoteControlHostRejected,
  remoteControlHostDisabledPath,
  remoteControlHostRecordPath,
  writeRemoteControlHostRecord,
  type RemoteControlHostRecord,
} from '../src/remoteControlHostVault';
import { REMOTE_CONTROL_MAX_SESSIONS } from '../src/remoteControlProtocol';

const sessionId = '22222222-2222-4222-8222-222222222222';
const controllerId = '33333333-3333-4333-8333-333333333333';

function record(overrides: Partial<RemoteControlHostRecord> = {}): RemoteControlHostRecord {
  return {
    schemaVersion: REMOTE_CONTROL_HOST_RECORD_VERSION,
    hostId: '11111111-1111-4111-8111-111111111111',
    hostSecret: 'H'.repeat(43),
    hostPrivateScalar: 'S'.repeat(43),
    hostPublicKey: 'P'.repeat(86),
    hostName: '내 Mac',
    controllerOrigin: 'https://controller.example.test',
    pairingId: '44444444-4444-4444-8444-444444444444',
    pairingExpiresAt: '2099-08-31T12:00:00.000Z',
    hostExpiresAt: '2099-09-02T12:00:00.000Z',
    pairingSecrets: ['A'.repeat(43), 'B'.repeat(43)],
    pairingIds: [
      '55555555-5555-4555-8555-555555555555',
      '44444444-4444-4444-8444-444444444444',
    ],
    relayCursor: '7',
    sessions: [{
      sessionId,
      controllerId,
      sendSequence: 4,
      receiveCursor: { sessionId, controllerId, highestSequence: 3, recentMessageIds: ['55555555-5555-4555-8555-555555555555'] },
      scopes: [],
    }],
    ...overrides,
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'remote-control-host-vault-'));
}

describe('stored internet remote-control host identity', () => {
  test('survives a write/read round trip with the private material 0600', () => {
    const dir = scratch();
    writeRemoteControlHostRecord(dir, record());
    expect(readRemoteControlHostRecord(dir)).toEqual(record());
    // The host private scalar is in here. Anything readable by other accounts
    // would let them impersonate this Mac to phones that are already paired.
    expect(statSync(remoteControlHostRecordPath(dir)).mode & 0o077).toBe(0);
  });

  test('fails closed on anything it cannot fully trust', () => {
    const dir = scratch();
    expect(readRemoteControlHostRecord(dir)).toBeNull();
    for (const broken of [
      null,
      'not an object',
      { ...record(), schemaVersion: 2 },
      { ...record(), hostSecret: 'too-short' },
      { ...record(), pairingSecrets: [] },
      {
        ...record(),
        pairingSecrets: Array.from({ length: 17 }, () => 'A'.repeat(43)),
        pairingIds: Array.from({ length: 17 }, (_, index) => `pairing-identifier-${index}`),
      },
      { ...record(), pairingIds: [] },
      { ...record(), pairingIds: ['not-an-id', record().pairingId] },
      { ...record(), relayCursor: 'not-a-number' },
      { ...record(), pairingExpiresAt: 'not-a-date' },
      // A cursor belonging to a different session would advance the wrong one.
      { ...record(), sessions: [{ ...record().sessions[0]!, receiveCursor: { ...record().sessions[0]!.receiveCursor, sessionId: controllerId } }] },
      { ...record(), sessions: [{ ...record().sessions[0]!, sendSequence: -1 }] },
      { ...record(), sessions: [{ ...record().sessions[0]!, scopes: ['unknown-scope' as never] }] },
      { ...record(), sessions: [record().sessions[0]!, record().sessions[0]!] },
      { ...record(), revokedSessions: Array.from({ length: REMOTE_CONTROL_MAX_SESSIONS + 1 }, (_, index) => ({ sessionId: `revoked-session-${index}`, revokedAt: new Date().toISOString() })) },
      { ...record(), revokedSessions: [{ sessionId, revokedAt: 'not-a-date' }] },
      { ...record(), revokedSessions: [{ sessionId, revokedAt: new Date().toISOString() }, { sessionId, revokedAt: new Date().toISOString() }] },
    ]) {
      expect(normalizeRemoteControlHostRecord(broken)).toBeNull();
    }
    // A half-restored host answers with keys or counters no phone agrees with,
    // which is worse than an honest re-pair.
    writeFileSync(remoteControlHostRecordPath(dir), '{ not json', 'utf8');
    expect(readRemoteControlHostRecord(dir)).toBeNull();
  });

  test('upgrades an older schema-v1 record without replacing the host identity', () => {
    const legacy = record();
    delete legacy.pairingIds;
    const normalized = normalizeRemoteControlHostRecord(legacy);
    expect(normalized?.hostId).toBe(legacy.hostId);
    expect(normalized?.pairingIds).toEqual([null, legacy.pairingId]);
  });

  test('persists conversation authority separately and never grants it to legacy sessions', () => {
    const scoped = record({
      sessions: [{ ...record().sessions[0]!, scopes: ['tasks-v1', 'conversations-v1'] }],
    });
    expect(normalizeRemoteControlHostRecord(scoped)?.sessions[0]?.scopes)
      .toEqual(['tasks-v1', 'conversations-v1']);
    const legacy = record();
    delete legacy.sessions[0]!.scopes;
    expect(normalizeRemoteControlHostRecord(legacy)?.sessions[0]?.scopes).toEqual([]);
  });

  test('bounds persisted authority to eight live sessions and sixteen QR secrets', () => {
    const template = record().sessions[0]!;
    const sessions = Array.from({ length: REMOTE_CONTROL_MAX_SESSIONS + 1 }, (_, index) => {
      const boundedSessionId = `session-identifier-${index}`;
      return {
        ...template,
        sessionId: boundedSessionId,
        receiveCursor: { ...template.receiveCursor, sessionId: boundedSessionId },
      };
    });
    expect(normalizeRemoteControlHostRecord({ ...record(), sessions })).toBeNull();

    const sixteenSecrets = Array.from({ length: 16 }, (_, index) => (
      String.fromCharCode(65 + index).repeat(43)
    ));
    const sixteenPairingIds = Array.from({ length: 16 }, (_, index) => `pairing-identifier-${index}`);
    expect(normalizeRemoteControlHostRecord({
      ...record(),
      pairingSecrets: sixteenSecrets,
      pairingIds: sixteenPairingIds,
      pairingId: sixteenPairingIds.at(-1),
    })).not.toBeNull();
    expect(normalizeRemoteControlHostRecord({
      ...record(),
      pairingSecrets: [...sixteenSecrets, 'Q'.repeat(43)],
      pairingIds: [...sixteenPairingIds, 'pairing-identifier-overflow'],
    })).toBeNull();
  });

  test('replaces the file atomically and can be removed', () => {
    const dir = scratch();
    writeRemoteControlHostRecord(dir, record());
    writeRemoteControlHostRecord(dir, record({ relayCursor: '9' }));
    expect(readRemoteControlHostRecord(dir)?.relayCursor).toBe('9');
    expect(JSON.parse(readFileSync(remoteControlHostRecordPath(dir), 'utf8'))).toMatchObject({ relayCursor: '9' });
    deleteRemoteControlHostRecord(dir);
    expect(readRemoteControlHostRecord(dir)).toBeNull();
    // Removing what is already gone is the desired end state, not an error.
    expect(() => deleteRemoteControlHostRecord(dir)).not.toThrow();
  });

  test('keeps a durable local-disable tombstone authoritative when vault unlink fails', () => {
    const dir = scratch();
    writeRemoteControlHostRecord(dir, record());
    markRemoteControlHostLocallyDisabled(dir);
    expect(isRemoteControlHostLocallyDisabled(dir)).toBe(true);
    expect(statSync(remoteControlHostDisabledPath(dir)).mode & 0o077).toBe(0);

    if (process.platform !== 'win32') {
      // Simulate an app-data permission regression after the tombstone was
      // committed. The vault survives, but a restarted process still refuses
      // it instead of resurrecting remote authority.
      chmodSync(dir, 0o500);
      try {
        expect(() => deleteRemoteControlHostRecord(dir)).toThrow();
        expect(readRemoteControlHostRecord(dir)).toBeNull();
      } finally {
        chmodSync(dir, 0o700);
      }
    }

    expect(readRemoteControlHostRecord(dir)).toBeNull();
    expect(clearRemoteControlHostDisabledTombstone(dir)).toBe(true);
    expect(readRemoteControlHostRecord(dir)).toEqual(record());
    disableRemoteControlHostRecord(dir);
    expect(readRemoteControlHostRecord(dir)).toBeNull();
    expect(isRemoteControlHostLocallyDisabled(dir)).toBe(true);
  });

  test('fails closed on symlinks, permissive Unix modes, and multiply-linked inodes', () => {
    const dir = scratch();
    const path = remoteControlHostRecordPath(dir);
    const trusted = join(dir, 'trusted.json');
    writeRemoteControlHostRecord(dir, record());
    writeFileSync(trusted, readFileSync(path));
    chmodSync(trusted, 0o600);

    // The read must validate the inode opened with O_NOFOLLOW, not a path that
    // can be swapped after an lstat check.
    deleteRemoteControlHostRecord(dir);
    symlinkSync(trusted, path);
    expect(readRemoteControlHostRecord(dir)).toBeNull();

    if (process.platform !== 'win32') {
      deleteRemoteControlHostRecord(dir);
      writeRemoteControlHostRecord(dir, record());
      chmodSync(path, 0o644);
      expect(readRemoteControlHostRecord(dir)).toBeNull();

      chmodSync(path, 0o600);
      linkSync(path, join(dir, 'second-name.json'));
      expect(statSync(path).nlink).toBe(2);
      expect(readRemoteControlHostRecord(dir)).toBeNull();
    }
  });

  test('does not follow or overwrite the old predictable temporary symlink', () => {
    const dir = scratch();
    const path = remoteControlHostRecordPath(dir);
    const victim = join(dir, 'must-not-change.txt');
    const staleTemporary = `${path}.${process.pid}.tmp`;
    writeFileSync(victim, 'keep me', 'utf8');
    symlinkSync(victim, staleTemporary);

    writeRemoteControlHostRecord(dir, record({ relayCursor: '11' }));

    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(lstatSync(staleTemporary).isSymbolicLink()).toBe(true);
    expect(readRemoteControlHostRecord(dir)?.relayCursor).toBe('11');
  });

  test('refuses to store a record it would refuse to read back', () => {
    const dir = scratch();
    expect(() => writeRemoteControlHostRecord(dir, record({ pairingSecrets: [] })))
      .toThrow('REMOTE_CONTROL_HOST_RECORD_INVALID');
  });
});

describe('telling a refused host from an unreachable relay', () => {
  test('only an explicit refusal is allowed to discard the stored pairing', () => {
    for (const refusal of [
      new Error('REMOTE_CONTROL_HOST_AUTH_FAILED'),
      new Error('rpc failed: REMOTE_CONTROL_HOST_DISABLED'),
      new Error('RELAY_HOST_KEY_MISMATCH'),
      Object.assign(new Error('relay rpc error'), { detail: { message: 'REMOTE_CONTROL_HOST_AUTH_FAILED' } }),
    ]) {
      expect(remoteControlHostRejected(refusal)).toBe(true);
    }
    // A Mac that starts before its network does must keep its identity. Every
    // one of these used to cost the user a QR re-scan for nothing.
    for (const transient of [
      new Error('fetch failed'),
      new Error('getaddrinfo ENOTFOUND supabase.co'),
      new Error('The operation timed out'),
      new Error('connect ECONNREFUSED 127.0.0.1:443'),
      undefined,
      null,
    ]) {
      expect(remoteControlHostRejected(transient)).toBe(false);
    }
  });
});
