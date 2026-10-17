import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  contextSessionActivityLabel,
  contextSessionHistory,
  contextSurfacePresenceBadge,
  hiddenUnverifiedContextSurfaceCount,
  normalizeContextSurfacePresence,
  visibleContextSessions,
} from '../src/contextSessionVisibility';

describe('context-session visibility policy', () => {
  test('retains all hidden records for history without marking expired or closed surfaces active', () => {
    const sessions = [{state:'active' as const}, ...Array.from({length:141},()=>({state:'stale' as const}))];
    expect(visibleContextSessions(sessions)).toHaveLength(1);
    expect(contextSessionHistory(sessions)).toHaveLength(141);
    expect(contextSessionActivityLabel({state:'stale',surfacePresence:'live'},'1일')).toBe('이전 기록 · 1일');
    expect(contextSessionActivityLabel({state:'active',surfacePresence:'gone'},'방금')).toBe('이전 기록 · 방금');
  });
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

import {pinnedProjectVoiceHistory} from '../src/contextSessionVisibility';
test('only a recent project Voice chat stays pinned; an old dead one moves to history (VOC 2026-09-24)', () => {
  const voice = (ageMs: number) => ({state: 'stale' as const, sourceAgent: 'codex', threadSource: 'realtime_voice', projectHint: {name: 'p'}, ageMs, surfacePresence: 'not-applicable' as const});
  const recent = voice(3 * 3600_000), dead = voice(782 * 3600_000), other = {...voice(1000), threadSource: 'cli'};
  expect(pinnedProjectVoiceHistory([recent, dead, other])).toEqual([recent]);
});
