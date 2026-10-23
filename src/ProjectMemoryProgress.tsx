import React from 'react';
import type {ProjectMemoryStatus} from './ProjectMemoryPanel';
import type {ProjectMemorySyncDirection} from './projectMemorySyncState';

/** A read-only explanation of the evidence already loaded by the editor.
 * Initializing a memory also sets its activity baseline; that is not a saved AI task. */
export type ConfirmedMemorySave = 'backed-up' | 'local-only' | 'backup-unconfirmed';

export function ProjectMemoryProgress({status, readFailed, syncDirection, conflict, recoveryPending, onRecheck, busy, confirmedSave}: {
  status: ProjectMemoryStatus | null;
  readFailed: boolean;
  syncDirection: ProjectMemorySyncDirection;
  conflict: boolean;
  recoveryPending: boolean;
  onRecheck: () => void;
  busy: boolean;
  confirmedSave: ConfirmedMemorySave | null;
}) {
  const local = status === null ? 'checking' : status.exists ? 'ready' : 'absent';
  const activityKnown = !readFailed && typeof status?.activity?.needsRemember === 'boolean';
  const needsRemember = activityKnown && status?.activity.needsRemember;
  const backup = conflict ? 'conflict' : syncDirection;
  // Copy is kept together so the three independent results stay visible on a small screen.
  const rows = [
    ['이 폴더의 기억', readFailed ? status ? '현재 상태 확인 필요 · 마지막 확인 내용 유지' : '현재 상태 확인 필요' : local === 'checking' ? '확인 중' : local === 'ready' ? '기억 파일 준비됨' : '아직 준비하지 않음'],
    ['대화·작업 저장', recoveryPending ? '중단된 저장 결과 확인 필요' : readFailed ? '활동 상태 확인 필요' : !status?.exists ? '기억 준비 후 확인' : !activityKnown ? '활동 상태 확인 필요' : needsRemember ? '새로 기억할 활동 있음' : '새로 저장할 활동 없음'],
    ['클라우드 사본', readFailed ? '최신 상태 확인 필요' : !status?.exists ? '기억 준비 후 확인' : ({
      'not-required': '이 기기에서만 사용', checking: '확인 중', synced: '현재 내용과 일치',
      push: '백업 필요', pull: '원격 변경 확인 필요', conflict: '양쪽 변경 검토 필요',
      error: '연결 상태 확인 필요', unknown: '상태 확인 필요',
    } as const)[backup]],
  ];
  const next = recoveryPending ? '위의 저장 복구에서 같은 작업의 결과를 확인하세요. AI를 다시 실행하지 않습니다.'
    : readFailed ? '상태를 다시 확인한 뒤 저장을 이어가세요. 조회 실패는 기억 삭제나 저장 실패를 뜻하지 않습니다.'
    : !status ? '기억 상태를 확인하고 있습니다.'
    : !status.exists ? '아래에서 기억을 준비하거나 기존 백업을 복원한 뒤, 프로젝트 워크룸에서 첫 작업을 시작하세요.'
    : conflict || syncDirection === 'conflict' ? '동기화 충돌 검토에서 양쪽 내용을 비교하세요. 백업 재시도만으로는 충돌이 풀리지 않습니다.'
    : !activityKnown ? '활동 상태를 다시 확인하세요. 기억 파일이 있다는 것만으로 작업 저장 완료를 판단하지 않습니다.'
    : needsRemember ? '아래의 세션 기억하기로 새 활동을 저장하세요. 저장 후 로컬 결과와 클라우드 사본을 각각 확인합니다.'
    : syncDirection === 'error' || syncDirection === 'unknown' ? 'Supabase 다시 확인으로 연결 상태를 읽으세요. 같은 대화를 다시 저장할 필요는 없습니다.'
    : syncDirection === 'push' ? 'Supabase 동기화로 현재 로컬 기억을 백업하세요. AI를 다시 실행하지 않습니다.'
    : syncDirection === 'pull' ? 'Supabase 동기화에서 원격 변경을 확인하고 이어가세요.'
    : '프로젝트 워크룸에서 다음 작업을 이어가세요. 도구 준비·AI 작업·기억 저장은 각각 확인합니다.';
  return <section data-testid="project-memory-progress" aria-label="기억 저장 상태" className="mb-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 text-xs text-[var(--ink)]">
    <strong>기억 저장 상태</strong>
    <dl className="my-2 grid gap-2">{rows.map(([label,value])=><div key={label} className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1">
      <dt className="text-[var(--ink-2)]">{label}</dt><dd className="m-0 min-w-0 break-words font-semibold">{value}</dd>
    </div>)}</dl>
    {confirmedSave && <p data-testid="project-memory-save-result" className="my-2 rounded-lg bg-[var(--sunken)] p-2 leading-relaxed">
      이번 요청 · 로컬 저장 확인 · {confirmedSave === 'backed-up' ? '클라우드 백업 확인' : confirmedSave === 'local-only' ? '클라우드 백업 생략' : '클라우드 백업 확인 필요'}
    </p>}
    <p role="status" className="m-0 leading-relaxed text-[var(--ink-2)]">다음 · {next}</p>
    {(readFailed || (status?.exists && !activityKnown)) && <button type="button" disabled={busy} onClick={onRecheck}
      className="mt-2 min-h-11 rounded-lg border border-[var(--line)] px-3 font-semibold disabled:opacity-50">기억 상태 다시 확인</button>}
  </section>;
}
