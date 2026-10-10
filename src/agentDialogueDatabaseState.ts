/**
 * 연결된 Supabase가 이 기능을 아직 모를 때를 사람이 읽을 수 있게 바꾼다.
 *
 * 대화 RPC는 **DB 함수 한 덩어리**이고, 모르는 동작이 오면 함수가
 * `AGENT_DIALOGUE_OPERATION_INVALID`를 raise한다(`agentDialogueSql.ts`의 fallthrough). 그래서 앱이
 * 새 동작(커뮤니티·1:1 연결)을 보내는데 DB가 옛 함수면 화면에 그 코드가 그대로 떴다 — 무엇을 해야
 * 하는지 알 수 없는 문구였고, 실제로 「이런 오류가 또 있네」로 접수됐다(2026-10-04).
 *
 * ⚠️ 이 판정은 **보낸 동작을 아는 쪽에서만** 할 수 있다. 같은 코드가 「정말 없는 동작」에도 쓰이므로,
 * 새 기능의 동작일 때만 「DB가 뒤처졌다」로 바꾼다.
 */
export const AGENT_DIALOGUE_DATABASE_OUTDATED='AGENT_DIALOGUE_DATABASE_OUTDATED';
export const AGENT_DIALOGUE_COMMUNITY_MIGRATION='20261004030000_agent_dialogue_community.sql';
export const AGENT_DIALOGUE_CONTROL_MIGRATION='20261005010000_agent_dialogue_control.sql';
/**
 * 커뮤니티를 유휴 2시간 규칙에서 빼는 마이그레이션. ⚠️ 이것이 **동작 이름으로는 판정되지 않는다** —
 * 새 동작을 더한 것이 아니라 기존 `send` 의 **행동**을 바꿨기 때문이다(`agentDialogueSql.ts` 의
 * `kind='room'` 조건). 그래서 옛 DB 에서는 `community-send` 가 `AGENT_DIALOGUE_ROOM_INACTIVE` 라는
 * 원시 코드로 조용히 거절되고, 화면에는 무엇을 해야 하는지 없는 문구가 그대로 떴다.
 */
export const AGENT_DIALOGUE_COMMUNITY_IDLE_MIGRATION='20261005020000_agent_dialogue_community_idle.sql';
export const AGENT_DIALOGUE_ROOM_INACTIVE='AGENT_DIALOGUE_ROOM_INACTIVE';

/** DB 함수가 추가된 뒤에만 아는 동작들. */
const NEWER_THAN_FIRST_RELEASE=new Set([
  'pair','pair-revoke','pairings','device-pairings','device-invitations',
  'community-join','community-leave','community-status',
  'control-send','control-result','control-inbox','control-respond',
]);

export function isAgentDialogueOperationUnknown(error:unknown):boolean{
  const text=error instanceof Error?error.message:typeof error==='string'?error:'';
  return text.includes('AGENT_DIALOGUE_OPERATION_INVALID');
}

export function agentDialogueDatabaseOutdatedMessage(operation:string):string{
  const control=operation.startsWith('control');
  const what=control?'다른 기기 제어':operation.startsWith('community')?'커뮤니티':'기기 간 1:1 연결';
  return `연결된 Supabase에 ${what} 기능이 아직 설치되지 않았습니다. `
    +`마이그레이션 ${control?AGENT_DIALOGUE_CONTROL_MIGRATION:AGENT_DIALOGUE_COMMUNITY_MIGRATION}을 적용한 뒤 다시 시도하세요. `
    +'앱을 다시 설치할 필요는 없습니다.';
}

/**
 * 커뮤니티 동작이 「방이 유휴」로 거절됐다. 커뮤니티는 **나가지 않는 한 계속**이므로 그런 일이 있을 수
 * 없다 — 적용되지 않은 유휴 면제 마이그레이션이 유일하게 알려진 원인이다. 그 파일 이름을 말한다.
 */
export function isAgentDialogueRoomIdleRefusal(error:unknown):boolean{
  const text=error instanceof Error?error.message:typeof error==='string'?error:'';
  return text.includes(AGENT_DIALOGUE_ROOM_INACTIVE);
}

/** 새 기능의 동작이 DB에서 거절됐으면 안내 문구로 바꾸고, 그 밖에는 원래 오류를 그대로 돌려준다. */
export function describeAgentDialogueRpcError(operation:string,error:unknown):
  {code:string;message:string}|null{
  if(operation.startsWith('community')&&isAgentDialogueRoomIdleRefusal(error)){
    return {code:AGENT_DIALOGUE_DATABASE_OUTDATED,
      message:'커뮤니티는 나가지 않는 한 계속 유지되는데 연결된 Supabase가 유휴로 거절했습니다. '
        +`마이그레이션 ${AGENT_DIALOGUE_COMMUNITY_IDLE_MIGRATION}을 적용한 뒤 다시 시도하세요. `
        +'앱을 다시 설치할 필요는 없습니다.'};
  }
  if(!NEWER_THAN_FIRST_RELEASE.has(operation)||!isAgentDialogueOperationUnknown(error))return null;
  return {code:AGENT_DIALOGUE_DATABASE_OUTDATED,message:agentDialogueDatabaseOutdatedMessage(operation)};
}
