export interface AgentsToZBotCreationPromptInput {
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  apiBaseUrl?: string;
  uiBaseUrl?: string;
  agentstozProfile?: string;
  workerProfile?: string;
}

export function buildAgentsToZBotCreationPrompt(input: AgentsToZBotCreationPromptInput): string {
  const deviceId = input.deviceId?.trim() ?? "";
  if (!deviceId) throw new Error("deviceId가 필요합니다.");
  const deviceName = input.deviceName?.trim() || "이 단말";
  const platform = input.platform?.trim() || "현재 단말 OS";
  const apiBaseUrl = input.apiBaseUrl?.trim() || "http://127.0.0.1:3002";
  const uiBaseUrl = input.uiBaseUrl?.trim() || "http://127.0.0.1:9000";
  const agentstozProfile = input.agentstozProfile?.trim() || "agentstoz-bot";
  const workerProfile = input.workerProfile?.trim() || "cs-ceo";

  return `# AgentsToZ Bot 생성·연결 프롬프트

이 프롬프트는 현재 단말에서만 실행해줘.

## 현재 단말 범위
- device_id: ${deviceId}
- device_name: ${deviceName}
- platform: ${platform}
- AgentsToZ UI: ${uiBaseUrl}
- AgentsToZ API: ${apiBaseUrl}
- control-plane profile: ${agentstozProfile}
- worker profile: ${workerProfile}

## 목표
Hermes Bot Mode에서 이 단말 소유의 두 봇을 확인하고 다음 역할로 연결해줘.

1. ${agentstozProfile}
   - AgentsToZ control-plane
   - 정확히 하나의 등록 프로젝트 selector만 허용
   - project path, project-memory identity, device identity, local Git identity를 작업 전 검증
   - 검증 실패 시 fail-closed
   - 작업을 직접 수행하지 않고 ${workerProfile}에게만 위임

2. ${workerProfile}
   - 승인된 작업만 실행
   - ${agentstozProfile}이 전달한 canonical project path에서만 실행
   - 다른 프로젝트, AgentsToZ root, 임의 fallback을 사용하지 않음
   - 테스트·변경·worker 종료 결과를 request_id와 함께 보고

## 반드시 지킬 연결 규칙
- resolved project == execution project == memory project == Git project
- 프로젝트 이름은 fuzzy-match하지 말고 exact selector만 사용
- 로컬 파일 작업은 등록 project ID, canonical path, memory ID, Git root가 모두 일치하면 허용
- Git origin이 없으면 local-only project로 보고하되 로컬 파일 작업과 로컬 테스트를 차단하지 않음
- Git origin은 push·pull·원격 저장소 비교·다른 단말 인수인계 또는 등록된 expected remote 검증에만 필수
- expected remote가 등록되어 있는데 없거나 다르면 repository mismatch로 fail-closed
- AgentsToZ_byCS control-plane root를 대상으로 한 자기 수정은 origin 유무와 관계없이 항상 거부
- request_id 없는 dispatch는 거부
- 같은 canonical project의 동시 worker는 거부
- 기존 파일·미커밋 변경을 임의로 삭제하거나 reset하지 않음
- 사용자의 명시적 승인 없이 commit·push하지 않음
- local memory 저장, remote backup, Git commit은 각각 별도 상태로 보고

## cs-ceo 기본 프로젝트 자동 준비
cs-ceo를 Ready로 보고하기 전에 csncompany2-0 프로젝트를 exact 기준으로 확인해.

- 프로젝트 selector: csncompany2-0
- canonical GitHub remote: https://github.com/intenet1001-commits/CSnCompany_2-0
- 기본 폴더 이름: CSnCompany_2-0

다음 순서를 반드시 지켜:
1. AgentsToZ exact resolver로 csncompany2-0 등록 여부를 확인한다.
2. 등록되어 있고 canonical path·memory ID·Git remote가 일치하면 기존 프로젝트를 사용한다.
3. 등록되지 않았거나 새 단말에 폴더가 없으면, 현재 단말의 등록된 workspace root가 정확히 하나일 때만 그 root 아래 CSnCompany_2-0을 target으로 정한다.
4. target 폴더가 이미 존재하지만 등록되지 않았거나 Git remote가 다르면 덮어쓰지 말고 PROJECT_BOOTSTRAP_CONFLICT로 중단한다.
5. target이 없을 때만 AgentsToZ의 clone 경로를 사용해 위 exact remote를 clone한다. 임의 git clone, 다른 remote, fuzzy repository 검색은 사용하지 않는다.
6. clone 성공 후 프로젝트 memory를 autoBackup=true로 초기화하고, AgentsToZ에 등록한다.
7. memory ID·canonical path·Git root·Git remote·device binding을 다시 readback한다.
8. remote memory backup 상태를 확인하고, backup 실패 시 Bot 생성 성공으로 보고하지 않는다.
9. 모든 검증이 통과한 뒤에만 cs-ceo worker profile을 Ready로 보고한다.

자동 clone은 폴더가 없을 때만 수행한다. 기존 폴더 삭제·reset·checkout·clean·stash는 하지 않는다. workspace root가 0개 또는 2개 이상이면 사용자에게 정확한 root 선택을 요청하고 멈춘다.

## 실행 전 확인
1. Hermes profile 목록에 두 profile이 존재하는지 확인
2. 이 요청의 device_id가 위 값과 같은지 확인
3. AgentsToZ API health를 조회
4. csncompany2-0 bootstrap/resolve 결과를 확인
5. 실제 등록 프로젝트를 exact selector로 resolve
6. resolve 결과와 worker cwd가 같은지 확인
7. 파일·memory·local Git을 readback하고, 원격 작업일 때만 origin·remote backup을 추가 확인

민감한 설정값이나 단말의 인증 데이터를 프롬프트에 추가하지 말고, 확인되지 않은 성공을 보고하지 마.
`;
}
