/** Display metadata only. These labels grant no recovery or provider authority. */
export type MemorySaveRecoveryEvidence='bound-plan'|'saved-plan'|'no-retained-plan'|'plan-needs-review'|'unavailable';
export function memorySaveRecoveryDescription(value:unknown):string|null {
 switch(value){
  case 'bound-plan':return '이 저장과 연결된 복구 계획이 있습니다. 프로젝트 장기기억 화면에서 기존 계획 복구를 검토하세요. 실제 내용 검증 전까지 저장 완료로 처리하지 않습니다.';
  case 'saved-plan':return '로컬 저장 영수증과 같은 계획의 후처리 기록이 남아 있습니다. 프로젝트 장기기억 화면에서 남은 복구 계획을 확인하세요.';
  case 'no-retained-plan':return '남아 있는 저장 계획과 연결 기록이 없어 기존 결과를 재개할 근거가 없습니다. 새 시도는 별도 승인 절차가 필요하며 상태 조회만으로 이 작업을 다시 실행하지 않습니다.';
  case 'plan-needs-review':return '복구 계획과 저장 연결을 함께 확인하지 못했습니다. 일부 기록이 없거나 다른 계획일 수 있어 기존 기록을 보존한 채 확인해야 합니다.';
  case 'unavailable':return '복구 기록을 확인하지 못했습니다. 계획이 없다고 판단할 수 없으므로 상태를 다시 확인하세요. 기존 작업은 보존됩니다.';
  default:return null;
 }
}
