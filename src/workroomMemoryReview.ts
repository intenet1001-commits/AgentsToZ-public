import type {TerminalMemoryState} from './terminalMemoryQueue';

export type WorkroomMemoryReviewTarget = {
  targetId: string;
  state: Extract<TerminalMemoryState, 'failed' | 'backup-pending' | 'recovery-required'>;
  count: number;
};

const reviewLabels: Record<WorkroomMemoryReviewTarget['state'], string> = {
  failed: '세션 기억 저장 실패',
  'backup-pending': '로컬 저장 완료·Supabase 백업 확인 필요',
  'recovery-required': '이전 저장 결과 확인 후 복구 필요',
};

export function buildWorkroomMemoryReviewPrompt(target: WorkroomMemoryReviewTarget): string {
  const count = Number.isSafeInteger(target.count) && target.count > 0 ? target.count : 1;
  return `이 프로젝트의 워크룸 종료 후 저장 결과판에 “${reviewLabels[target.state]}” ${count}건이 표시됩니다. 이는 기존 세션을 이어 여는 동작이 아니라 새 AI 세션에서 상태를 조사하는 요청입니다. 표시 기록에는 각 건의 오류 원인과 발생 시각이 없어, ${count}건 모두 같은 원인이라고 단정하지 마세요. 실제 저장소 루트·장기기억·백업 상태와 미확정 저장 영수증을 읽기 전용으로 확인하고, 이미 해결된 항목과 조치가 필요한 항목을 구분해 설명하세요. 기존 기억과 Git 변경을 보존하고, 충돌은 양쪽 근거를 비교하여 초안을 제시하세요. 임의 force push, reset, 기억 덮어쓰기나 저장 재시도는 하지 마세요.`;
}
