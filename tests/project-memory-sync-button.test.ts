import { describe, expect, test } from 'bun:test';
import {
  resolveProjectMemorySaveButtonAction,
  resolveProjectMemorySyncButtonAction,
  type ProjectMemorySessionAction,
  type ProjectMemorySyncDirection,
} from '../src/projectMemorySyncState';

const button = (
  syncDirection: ProjectMemorySyncDirection,
  overrides: { localExists?: boolean; hasConflict?: boolean } = {},
) => resolveProjectMemorySyncButtonAction({
  localExists: overrides.localExists ?? true,
  syncDirection,
  hasConflict: overrides.hasConflict ?? false,
});

describe('single 싱크 button (replaces the manual Push/Pull pair)', () => {
  test('follows the direction the panel already resolved', () => {
    expect(button('push')).toBe('push');
    expect(button('pull')).toBe('pull');
  });

  test('opens the review screen instead of picking a winner when both sides moved', () => {
    expect(button('conflict')).toBe('conflict');
  });

  // A real API 409 carries the two immutable versions the user must compare.
  // It must outrank any direction inferred from hashes or timestamps.
  test('lets a surfaced API conflict override an inferred direction', () => {
    expect(button('push', { hasConflict: true })).toBe('conflict');
    expect(button('pull', { hasConflict: true })).toBe('conflict');
    expect(button('synced', { hasConflict: true })).toBe('conflict');
  });

  // The old panel let a user press Push while the remote state was unknown.
  // One button must not silently keep that hazard: read before writing.
  test('re-reads the remote instead of writing blind when the direction is unknown', () => {
    expect(button('error')).toBe('recheck');
    expect(button('unknown')).toBe('recheck');
  });

  // Turning auto-backup off used to leave the manual Push button as the only
  // way to reach Supabase. Removing that button must not remove the capability.
  test('keeps a manual backup path when automatic backup is off', () => {
    expect(button('not-required')).toBe('push');
  });

  // Push is idempotent and answers "is it really backed up?" with the server's
  // verdict, so an already-synced project still has a meaningful press.
  test('verifies against the server when local and remote already agree', () => {
    expect(button('synced')).toBe('push');
  });

  test('stays inert while there is nothing to sync or nothing decided yet', () => {
    expect(button('checking')).toBe('disabled');
    expect(button('push', { localExists: false })).toBe('disabled');
    expect(button('conflict', { localExists: false, hasConflict: true })).toBe('disabled');
  });
});

const save = (
  sessionAction: ProjectMemorySessionAction,
  overrides: { needsRemember?: boolean; hasConflict?: boolean } = {},
) => resolveProjectMemorySaveButtonAction({
  needsRemember: overrides.needsRemember ?? false,
  hasConflict: overrides.hasConflict ?? false,
  sessionAction,
});

describe('save button next to the 싱크 button', () => {
  // The combined action put a sync verb on the save button, so the panel showed
  // 「동기화 상태 다시 확인」 beside 「싱크 다시 확인」 — two buttons, one action,
  // no way to tell which one to press.
  test('never repeats a verb the 싱크 button already owns', () => {
    for (const sessionAction of ['push', 'pull', 'retry'] as ProjectMemorySessionAction[]) {
      expect(save(sessionAction)).toBe('current');
      expect(save(sessionAction, { needsRemember: true })).toBe('remember');
    }
  });

  test('still asks for a save whenever the session needs one', () => {
    expect(save('remember', { needsRemember: true })).toBe('remember');
    expect(save('current')).toBe('current');
  });

  // Saving during a conflict writes over one of the two versions the user has
  // not compared yet, so the save button must not be the way out of it.
  test('blocks saving while a conflict is unresolved', () => {
    expect(save('remember', { needsRemember: true, hasConflict: true })).toBe('blocked');
    expect(save('conflict', { hasConflict: true })).toBe('blocked');
  });

  test('waits while the remote state is still unknown', () => {
    expect(save('checking', { needsRemember: true })).toBe('checking');
  });
});
