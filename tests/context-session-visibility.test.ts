import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  contextSessionActivityLabel,
  contextSurfacePresenceBadge,
  hiddenUnverifiedContextSurfaceCount,
  normalizeContextSurfacePresence,
  visibleContextSessions,
} from '../src/contextSessionVisibility';

describe('context-session visibility policy', () => {
  test('shows only verified runtime surfaces while preserving generic recent records', () => {
    const sessions = [
      { id: 'live', state: 'active' as const, surfacePresence: 'live' as const },
      { id: 'gone', state: 'active' as const, surfacePresence: 'gone' as const },
      { id: 'unverified', state: 'active' as const, surfacePresence: 'unverified' as const },
      { id: 'generic', state: 'active' as const, surfacePresence: 'not-applicable' as const },
      { id: 'legacy', state: 'idle' as const },
      { id: 'expired', state: 'stale' as const, surfacePresence: 'live' as const },
    ];

    expect(visibleContextSessions(sessions).map(session => session.id))
      .toEqual(['live', 'generic', 'legacy']);
    expect(hiddenUnverifiedContextSurfaceCount(sessions)).toBe(1);
  });

  test('uses a safe generic fallback for a missing or unknown API value', () => {
    expect(normalizeContextSurfacePresence(undefined)).toBe('not-applicable');
    expect(normalizeContextSurfacePresence('new-provider-state')).toBe('not-applicable');
  });

  test('never labels an unverified runtime surface as active', () => {
    expect(contextSessionActivityLabel({ state: 'active', surfacePresence: 'unverified' }, '방금'))
      .toBe('표면 미확인 · 방금');
    expect(contextSessionActivityLabel({ state: 'active', surfacePresence: 'live' }, '방금'))
      .toBe('● 활성');
    expect(contextSessionActivityLabel({ state: 'active', surfacePresence: 'not-applicable' }, '방금'))
      .toBe('최근 갱신 · 방금');
    expect(contextSurfacePresenceBadge('gone')).toBeNull();
    expect(contextSurfacePresenceBadge('unverified')).toMatchObject({ label: '표면 미확인' });
  });
});

describe('AI usage panel surface-presence contract', () => {
  const panelSource = readFileSync(new URL('../src/components/AiUsagePanel.tsx', import.meta.url), 'utf8');

  test('renders through the visibility policy and explains runtime checks', () => {
    expect(panelSource).toContain('visibleContextSessions(ctx.sessions)');
    expect(panelSource).toContain('contextSessionActivityLabel(s, formatAge(s.ageMs))');
    expect(panelSource).toContain('Orca/cmux 표면은 런타임 확인');
    expect(panelSource).toContain('hiddenUnverifiedContextSurfaceCount(ctx.sessions)');
    expect(panelSource).toContain('const contextRequestRef = useRef<Promise<void> | null>(null)');
    expect(panelSource).toContain('if (contextRequestRef.current) return contextRequestRef.current');
  });
});
