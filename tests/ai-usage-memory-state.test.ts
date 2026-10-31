import { describe, expect, test } from 'bun:test';
import { dockSyncButtonState, sessionMemoryAction, type SessionMemoryStatusState } from '../src/components/aiUsageMemoryState';

const ready = (exists: boolean, needsRemember: boolean): SessionMemoryStatusState => ({
  kind: 'ready',
  status: {
    exists,
    activity: { needsRemember },
  } as any,
  remote: { kind: 'ready', status: { exists: true, createdAt: '2026-08-07T00:00:00.000Z', contentHash: 'same', inSync: true } },
  checkedAt: Date.now(),
});

describe('AI usage project-memory action state', () => {
  test('does not keep advertising a save after the project area reports memory is current', () => {
    expect(sessionMemoryAction('/work/회의실', ready(true, false))).toBe('saved');
  });

  test('offers a save whenever project activity needs one, independently of context usage', () => {
    expect(sessionMemoryAction('/work/회의실', ready(true, true))).toBe('remember');
    expect(sessionMemoryAction('/work/새 프로젝트', ready(false, false))).toBe('start');
  });

  test('keeps uncertain states safe and retryable', () => {
    expect(sessionMemoryAction('/work/회의실')).toBe('checking');
    expect(sessionMemoryAction('/work/회의실', { kind: 'checking' })).toBe('checking');
    expect(sessionMemoryAction('/work/회의실', { kind: 'error', message: 'offline', checkedAt: Date.now() })).toBe('retry');
    expect(sessionMemoryAction(null, ready(true, true))).toBe('unavailable');
  });

  test('the dock 「동기화」 turns off once both sides are the same, and back on when one side moves', () => {
    const synced = ready(true, false);
    expect(dockSyncButtonState(true, synced)).toEqual({ enabled: false, synced: true });
    // Unsaved activity is 「지금 저장」's question: a synced memory still has nothing to sync.
    expect(dockSyncButtonState(true, ready(true, true))).toEqual({ enabled: false, synced: true });
    const remoteMissing: SessionMemoryStatusState = { ...synced, remote: { kind: 'ready', status: { exists: false, createdAt: null, contentHash: null, inSync: false } } } as SessionMemoryStatusState;
    expect(dockSyncButtonState(true, remoteMissing)).toEqual({ enabled: true, synced: false });
    expect(dockSyncButtonState(true, { ...synced, remote: { kind: 'error', message: 'offline' } } as SessionMemoryStatusState)).toEqual({ enabled: true, synced: false });
    expect(dockSyncButtonState(true, { ...synced, remote: { kind: 'checking' } } as SessionMemoryStatusState).enabled).toBe(false);
    expect(dockSyncButtonState(false, synced)).toEqual({ enabled: false, synced: false });
  });
});
