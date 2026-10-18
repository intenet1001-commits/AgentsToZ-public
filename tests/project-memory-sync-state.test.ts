import { describe, expect, test } from 'bun:test';
import {
  resolveProjectMemorySessionAction,
  resolveProjectMemorySyncDirection,
  type ProjectMemoryRemoteState,
} from '../src/projectMemorySyncState';

const remote = (overrides: Partial<{ exists: boolean; inSync: boolean; createdAt: string | null }> = {}): ProjectMemoryRemoteState => ({
  kind: 'ready',
  status: {
    exists: overrides.exists ?? true,
    inSync: overrides.inSync ?? true,
    createdAt: overrides.createdAt ?? '2026-08-07T12:00:00.000Z',
    contentHash: 'memory',
  },
});

const action = (input: {
  exists?: boolean;
  needsRemember?: boolean;
  autoBackup?: boolean;
  remote?: ProjectMemoryRemoteState;
  localUpdatedAt?: string;
}) => {
  const syncDirection = resolveProjectMemorySyncDirection({
    localExists: input.exists ?? true,
    autoBackup: input.autoBackup ?? true,
    localUpdatedAt: input.localUpdatedAt ?? '2026-08-07T12:00:00.000Z',
    remote: input.remote ?? remote(),
  });
  return resolveProjectMemorySessionAction({
    localExists: input.exists ?? true,
    needsRemember: input.needsRemember ?? false,
    autoBackup: input.autoBackup ?? true,
    syncDirection,
  });
};

describe('shared project-memory sync state', () => {
  test('marks an in-sync remembered project as truly current', () => {
    expect(action({})).toBe('current');
  });

  test('preserves a required local session save even if remote backup is unavailable', () => {
    expect(action({ needsRemember: true, remote: { kind: 'error', message: 'offline' } })).toBe('remember');
  });

  test('never calls a local save complete while a remote action remains', () => {
    expect(action({ remote: remote({ exists: false, inSync: false }) })).toBe('push');
    expect(action({
      remote: remote({ inSync: false, createdAt: '2026-08-07T13:00:00.000Z' }),
    })).toBe('pull');
    expect(action({
      remote: remote({ inSync: false, createdAt: null }),
    })).toBe('conflict');
  });

  test('uses local-current semantics when automatic backup is intentionally disabled', () => {
    expect(action({ autoBackup: false, remote: { kind: 'checking' } })).toBe('current');
    expect(action({ exists: false })).toBe('initialize');
  });
});
