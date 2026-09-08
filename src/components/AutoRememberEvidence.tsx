import type { CodexAutoRememberStatus } from '../codexAutoRememberContract';

/** The status endpoint exposes at most 24 recent sessions, not all-time totals. */
export function automaticCheckpointEvidence(status: CodexAutoRememberStatus, now = Date.now()) {
  const rows = status.sessions.slice(0, 24);
  const checkpoints = rows.map(row => Date.parse(row.lastCheckpointAt ?? ''))
    .filter(time => Number.isFinite(time) && time > 0 && time <= now);
  return {
    observed: rows.length,
    saved: checkpoints.length,
    lastSavedAt: checkpoints.length ? new Date(Math.max(...checkpoints)).toISOString() : null,
    attention: rows.filter(row => ['failed', 'recovery-required'].includes(row.phase)).length,
    waiting: rows.filter(row => ['waiting-for-turn', 'waiting-for-project', 'waiting-for-changes', 'retrying'].includes(row.phase)).length,
  };
}

export function AutoRememberEvidence({ status }: { status: CodexAutoRememberStatus }) {
  const evidence = automaticCheckpointEvidence(status);
  return <span data-testid="automatic-checkpoint-evidence" style={{ flexBasis: '100%', color: 'var(--text-secondary)' }}>
    최근 조회 {evidence.observed}개 세션: {evidence.saved
      ? `로컬 저장 기록 ${evidence.saved}개 · 마지막 ${new Date(evidence.lastSavedAt!).toLocaleString('ko-KR')}`
      : '확인된 로컬 저장 기록 없음'}
    {` · 조건 대기 ${evidence.waiting}개 · 확인 필요 ${evidence.attention}개`}
    <span style={{ display: 'block' }}>켜짐은 자동 실행 설정입니다. 이 조회에 기록이 없다는 것이 전체 저장 이력이 없다는 뜻은 아니며, 로컬 저장과 원격 백업은 별도로 확인합니다.</span>
  </span>;
}
