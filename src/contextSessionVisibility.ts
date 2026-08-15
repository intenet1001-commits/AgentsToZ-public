import type { ContextSurfacePresence } from './contextSessionPresence';

/**
 * UI-only policy for context-session rows.
 *
 * Freshness says when a usage snapshot was last written; it does not prove the
 * terminal or chat surface still exists.  The API attaches surfacePresence for
 * integrations it can check at runtime.  Keep this policy separate from the
 * probe implementation so the panel cannot accidentally turn a recent record
 * into a claim that a window is open.
 */

export type { ContextSurfacePresence } from './contextSessionPresence';

export interface ContextSessionVisibilityCandidate {
  state: 'active' | 'idle' | 'stale';
  surfacePresence?: ContextSurfacePresence | null;
}

/** Treat an absent or forward-compatible value as a generic recent record.
 * Older API servers therefore retain their current behavior during rolling
 * upgrades, while only an explicit `gone` result hides a row. */
export function normalizeContextSurfacePresence(value: unknown): ContextSurfacePresence {
  switch (value) {
    case 'live':
    case 'gone':
    case 'unverified':
    case 'not-applicable':
      return value;
    default:
      return 'not-applicable';
  }
}

/** Keep existing freshness expiration, then remove application surfaces that
 * are closed or cannot currently be verified. A recent snapshot is not enough
 * to call an Orca/cmux window current. Generic/non-applicable records remain
 * visible as explicitly labelled recent records. */
export function visibleContextSessions<T extends ContextSessionVisibilityCandidate>(
  sessions: readonly T[] | null | undefined,
): T[] {
  return (sessions ?? []).filter(session => (
    session.state !== 'stale'
    && !['gone', 'unverified'].includes(normalizeContextSurfacePresence(session.surfacePresence))
  ));
}

/** Let the UI explain why a runtime-backed row is absent without putting a
 * potentially stale terminal back into the active list. */
export function hiddenUnverifiedContextSurfaceCount(
  sessions: readonly ContextSessionVisibilityCandidate[] | null | undefined,
): number {
  return (sessions ?? []).filter(session => (
    session.state !== 'stale'
    && normalizeContextSurfacePresence(session.surfacePresence) === 'unverified'
  )).length;
}

/** A runtime probe failure must never be painted as a live/active window. */
export function contextSessionActivityLabel(
  session: ContextSessionVisibilityCandidate,
  ageLabel: string,
): string {
  const presence = normalizeContextSurfacePresence(session.surfacePresence);
  if (presence === 'unverified') {
    return `표면 미확인 · ${ageLabel}`;
  }
  if (presence === 'not-applicable') {
    return session.state === 'active' ? `최근 갱신 · ${ageLabel}` : `최근 기록 · ${ageLabel}`;
  }
  return session.state === 'active' ? '● 활성' : `유휴 · ${ageLabel}`;
}

export function contextSessionActivityColor(session: ContextSessionVisibilityCandidate): string {
  const presence = normalizeContextSurfacePresence(session.surfacePresence);
  if (presence === 'unverified') return '#fbbf24';
  if (presence === 'not-applicable') return '#a1a1aa';
  return session.state === 'active' ? '#5eead4' : '#71717a';
}

/** Only checked runtime integrations receive a presence badge.  Generic
 * terminal/CLI records stay compact and continue to show as recent records. */
export function contextSurfacePresenceBadge(value: unknown): { label: string; title: string; tone: string } | null {
  switch (normalizeContextSurfacePresence(value)) {
    case 'live':
      return {
        label: '표면 확인됨',
        title: 'Orca·cmux 또는 Claude 백그라운드 에이전트 목록에서 이 세션의 실행 표면이 현재 존재함을 확인했습니다.',
        tone: '#99f6e4',
      };
    case 'unverified':
      return {
        label: '표면 미확인',
        title: '최근 사용량 기록은 있지만 현재 실행 표면을 확인하지 못했습니다.',
        tone: '#fde68a',
      };
    default:
      return null;
  }
}
