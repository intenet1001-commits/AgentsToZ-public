export type MemorySaveProblem = 'conflict' | 'agent' | 'unknown' | 'backup' | 'state';
/** Fixed user-facing text only. Errors and provider output are untrusted, private diagnostic input. */
export const MEMORY_SAVE_PROBLEM_TEXT: Record<MemorySaveProblem, string> = {
  conflict: '로컬·Supabase 기억이 모두 바뀌어 저장하지 않았습니다. 두 기억을 비교해 해결하세요.',
  agent: 'AI 기억 정리가 실패했습니다. 워크룸에서 로그인·모델 설정과 연결 상태를 확인하세요.',
  unknown: '저장 결과를 확인하지 못해 다시 보내지 않았습니다. 기존 작업 결과부터 확인하세요.',
  backup: '로컬에 저장했습니다. Supabase 백업 상태를 확인하세요.',
  state: '기억 저장 상태에 확인이 필요합니다. 워크룸에서 원인을 확인하세요.',
};
export function memorySaveProblem(data: { preflightConflict?: unknown; code?: unknown }): MemorySaveProblem {
  if (data.preflightConflict === true) return 'conflict';
  return data.code === 'PROJECT_MEMORY_AGENT_FAILED' ? 'agent' : 'state';
}
export function memorySaveNeedsRecovery(item: { status: string; problem?: MemorySaveProblem }): boolean {
  return item.status === 'failed' || item.status === 'unknown' || item.problem === 'backup';
}
