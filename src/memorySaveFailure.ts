/** Fixed metadata only. Never accept a message, stack, prompt, response or path. */
export const MEMORY_SAVE_FAILURE_STAGES = ['input-binding','input-staging','attempt-admission','input-read','provider-readiness','provider-call','proposal-validation','host-plan','host-bind','host-commit'] as const;
export const MEMORY_SAVE_FAILURE_CODES = ['UNKNOWN','ABORTED','INVALID_INPUT','SOURCE_CONFLICT','REVISION_CONFLICT','RECOVERY_REQUIRED','STORAGE_UNAVAILABLE','POLICY_DISABLED','POLICY_CHANGED','CLOCK_ROLLBACK','BUDGET_PAUSED','UNAVAILABLE','CONFLICT','EXPIRED','LEASE_LOST','KEY_LOST','KEY_CHANGED'] as const;
export interface MemorySaveFailure {
 version:1;stage:typeof MEMORY_SAVE_FAILURE_STAGES[number];code:typeof MEMORY_SAVE_FAILURE_CODES[number];
 recordedAt:number;providerCallPossible:boolean;
}
export function parseMemorySaveFailure(raw:unknown):MemorySaveFailure|null {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const v=raw as MemorySaveFailure;
 if(Object.keys(raw).some(key=>!['version','stage','code','recordedAt','providerCallPossible'].includes(key))
  ||v.version!==1||!MEMORY_SAVE_FAILURE_STAGES.includes(v.stage)||!MEMORY_SAVE_FAILURE_CODES.includes(v.code)
  ||!Number.isSafeInteger(v.recordedAt)||v.recordedAt<0||v.recordedAt>8_640_000_000_000_000||typeof v.providerCallPossible!=='boolean')return null;
 return {version:1,stage:v.stage,code:v.code,recordedAt:v.recordedAt,providerCallPossible:v.providerCallPossible};
}
export function memorySaveFailureCode(error:unknown):MemorySaveFailure['code'] {
 try{
  if(!error||typeof error!=='object')return 'UNKNOWN';
  const code=(error as {code?:unknown}).code;
  if(typeof code==='string'&&MEMORY_SAVE_FAILURE_CODES.includes(code as MemorySaveFailure['code']))return code as MemorySaveFailure['code'];
  if((error as {name?:unknown}).name==='AbortError')return 'ABORTED';
 }catch{/* An exotic error getter must not replace the original failure. */}
 return 'UNKNOWN';
}
const stageLabels:Record<MemorySaveFailure['stage'],string>={
 'input-binding':'입력 연결 확인','input-staging':'암호화 입력 준비','attempt-admission':'호출 한도·실행 승인 확인',
 'input-read':'암호화 입력 읽기','provider-readiness':'모델 연결 재확인','provider-call':'모델 응답 확인',
 'proposal-validation':'응답·기억 안전 검증','host-plan':'로컬 저장 계획 준비','host-bind':'로컬 저장 계획 연결','host-commit':'로컬 저장·완료 확인',
};
export function memorySaveFailureDescription(raw:unknown):string {
 const failure=parseMemorySaveFailure(raw);
 if(!failure)return '원인 기록이 없는 이전 미확정 저장입니다. AI 호출 여부를 확인할 수 없습니다. 기존 작업과 대화는 보존되며 자동 재실행하지 않습니다.';
 return `${stageLabels[failure.stage]} 단계에서 중단 · 분류 ${failure.code} · ${new Date(failure.recordedAt).toISOString()} · ${failure.providerCallPossible?'AI가 호출되었을 수 있어 결과 확인 전 다시 실행하지 않습니다.':'AI 요청 전 중단되었습니다. 저장 상태를 확인한 뒤 복구해야 합니다.'}`;
}
