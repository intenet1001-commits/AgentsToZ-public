import type {AiTerminalAgent} from './aiTerminalProtocol';

export type AiWorkMode = 'direct'|'mission';
export type AiWorkOrchestrationPolicy = 'agentstoz'|'cs-ceo';

export function aiWorkTargetDisplayName(label:string):string {
 return label.split(' · ')[0]?.trim() || label.trim();
}

export function buildAiWorkMissionPrompt(input:{title:string;goal:string;targetLabel:string;workers:readonly AiTerminalAgent[];policy:AiWorkOrchestrationPolicy}):string{
 const method=input.policy==='cs-ceo'
  ? 'AgentsToZ-Control의 장기기억과 대상 프로젝트의 장기기억을 회상한 뒤, cs-ceo의 Goal Gate와 작업 분해·검토 절차를 적용하세요. cs-ceo는 계획자와 검토자이며 실제 세션·상태·재개는 AgentsToZ 미션이 소유합니다.'
  : 'AgentsToZ-Control의 장기기억과 대상 프로젝트의 장기기억을 회상해 운영 원칙, 활성 제약, 프로젝트 문맥을 적용하세요.';
 return `당신은 AgentsToZ 관제 에이전트입니다. 직접 구현을 독점하지 말고 등록된 하위 에이전트에게 미션을 배정하고 결과를 검증하세요.

${method}
AgentsToZ MCP의 프로젝트 목록에서 표시 이름이 정확히 “${input.targetLabel}”인 대상을 다시 확인하세요. 이름이 없거나 중복이면 실행하지 말고 사용자에게 알려 주세요.
create_mission으로 하나의 지속형 미션을 만든 뒤 다음 작업자를 필요와 순서에 맞게 사용하세요: ${input.workers.join(', ')}. 같은 checkout을 동시에 수정하지 말고, 병렬 수정은 서로 다른 프로젝트나 격리된 worktree에서만 실행하세요.
각 Workroom 세션은 시작 후 출력을 먼저 읽고, 로그인·신뢰·설정 화면이면 작업 지시를 보내지 말고 필요한 조치를 보고하세요. 준비된 세션에만 한 번씩 지시하고, 결과를 읽어 교차 검증하세요.
변경·결정·검증된 결과가 있는 프로젝트만 미션 결과와 장기기억 후보로 기록하세요. 불확실한 결과를 완료로 표시하거나 미확정 요청을 재실행하지 마세요.

미션 제목: ${input.title.trim()}
달성 목표:
${input.goal.trim()}`;
}
