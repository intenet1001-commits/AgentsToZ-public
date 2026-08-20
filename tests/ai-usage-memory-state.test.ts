import { describe, expect, test } from 'bun:test';
import { sessionMemoryAction, type SessionMemoryStatusState } from '../src/components/aiUsageMemoryState';

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
});
