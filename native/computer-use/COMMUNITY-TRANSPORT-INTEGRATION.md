# 기기 간 AI·Teams의 Cloudflare 연결: 최소 후속 구현안

검토 기준: 부모 `6dadf7a8`, Control 작업 `07ea0fee`, 2026-11-02.
이 문서는 현재 연결 상태와 후속 구현안이며, CF AI/Teams 통합 완료나 실기 통과 기록이 아니다.

## 실제 연결 상태

| 경계 | 확인한 소스와 실제 흐름 | 필요한 변경 |
|---|---|---|
| 브라우저 공통 동의 | `api-server.ts`의 `workroomBrowserHost` 생성에 `CommunityAdapterAuthorization`을 주입했다. inherited signed Main → Control의 읽기 전용 인증을 사용한다. | 서명된 Main/Control QA 설치에서 native lease 설치와 최초 owned-page 연결을 확인한다. |
| 기기 제어 전송 | `AgentDialogueHost.controlCall`은 `control-send` 후 `control-result`를 읽고, `controlPoll`은 `control-inbox`를 실행한다. api-server의 `rpc`는 Supabase `portmgr_agent_dialogue_call`을 호출한다. | 실시간 전송과 현재 멤버 admission을 CF 인증 채널에 주입한다. 데이터 적재·백업 경로는 분리한다. |
| 컴퓨터 유즈 암호화 | `ComputerUseRemoteClient.hello`와 `ComputerUseRemoteHost.hello`는 상대의 ephemeral `pub`로 바로 `ComputerUseRemoteChannel.establish`를 호출한다. | issuer가 결속한 기기 키의 양방향 서명과 ECDH key confirmation 뒤에만 채널을 활성화한다. |
| 후보 인증 모듈 | `computerUseCommunityCredential`, `computerUseCommunityHandshake`, `computerUseCommunityKeyConfirmation`은 검증 후보이다. 기준 커밋의 production import 검색에서 이 세 모듈 밖의 실행 경로로 연결되지 않았다. | 선언·단위 검사만으로 기존 hello가 인증됐다고 판단하지 않는다. 새 공통 인증서 형식에 맞춘 실제 연결이 필요하다. |
| CF SDK | `communityRelayClient`는 ticket proof·renewal·bounded ciphertext 운반을 한다. `from`은 인증된 record layer 전까지 routing hint이다. | E2EE peer record layer와 request/receipt dispatcher를 그 위에 연결한다. |
| Teams | 검토한 `TeamExecutionRef`는 local Workroom 또는 host-local external handle이다. `createWorkroomTeamHost`는 local terminal/external runtime을 주입한다. OPS 원격 전달은 별도로 `opsRequestDispatch → AgentDialogueHost.controlCall`을 쓴다. | OPS 작업 제출을 곧바로 원격 Teams 팀원이라고 표시하지 않는다. 실제 remote member binding과 수신 측 팀 실행 API가 필요하다. |

`computerUseRemoteCrypto.ts` 자체도 현재 ECDH가 service_role 보유 능동 중간자까지 막지는 못한다고
명시한다. CF TLS 또는 ticket만 추가해 이 한계가 해소됐다고 말하면 안 된다.

## 1. 신원 소유자 안에 목적 제한 broker 연결

현재 공통 Authorization의 operation key는 Viewer가 보유한다. Bun/Main/Control에 private blob을
옮기거나 JS software identity key를 만들지 않는다. 최소 경로는 그 키를 보유한 서명된 native
프로세스의 **별도 headless community broker**다. 화면 세션 시작·UI 클릭·캡처·입력 API는 제공하지 않는다.

Broker는 서명 검증된 Main의 audit identity/process generation만 받고 다음 typed 요청만 처리한다.

1. 고정 issuer/profile의 현재 `authorization`·`directory`와 목적별 `relay-ticket` 읽기·갱신.
2. `agent` 또는 `teams`라는 고정 purpose와 양쪽 issuer-verified subject를 결속한 handshake 서명.
3. 같은 연결 epoch의 relay challenge proof. 임의 byte/message signing은 받지 않는다.

목적은 각각 `agent.communicate` 또는 `teams.run`의 현재 lease로 검증한다. desktop의 양쪽 역할은
operation key에, mobile은 기존 생체 인증으로 연 공통 RAM session key에 결속한다. Screen의 receiver
host-key ticket은 현재 `screen` 전용이므로 agent/Teams 용도로 조용히 재사용하지 않는다.
일반 Control의 `community-authorize` 두 목적은 browser/agent-settings이며 agent/Teams 인증을
그 boolean으로 대체하지 않는다.

향후 Main이 독립적인 자동 통신 키를 소유하려면 Plan·digest·Authorization에 별도 `agentKey`를 추가하고
관리자의 일괄 검토에 포함하는 다른 설계가 필요하다. 기존 Viewer operation key의 소유권을 암묵적으로
넓히는 방식보다 변경 범위가 크므로, 이번 최소 경로와 혼합하지 않는다.

## 2. 하나의 인증된 peer record layer

새 `AuthenticatedCommunityConnection`이 `CommunityRelayClient`를 운반자로 사용한다. 아직 공개되지 않은
후보 credential v1을 공통 Authorization v2로 꾸미지 않고, **공통 issuer 서명 원문**을 직접 검증한다.
Directory에 든 peer라면 그 전체 issuer envelope와 선택한 정확한 peer의 결속을 보존한다.

상호 서명 transcript에는 최소 다음을 넣는다.

- protocol/domain, purpose, sender/receiver role, community/profile, 양쪽 device/enrollment IDs
- 양쪽 certificate/policy hash·revision·keyEpoch, 양쪽 relay connection ID와 boot/session epoch
- 양쪽 fresh ephemeral public key·nonce, 컴퓨터 유즈의 원래 MCP instance/session binding

서명 검증 → 양쪽 ECDH key confirmation → active 순서다. 어느 한쪽만 확인했거나 lease가 만료되면
`onAuthenticatedRecord`를 호출하지 않는다. HKDF와 AEAD AAD에도 transcript hash·purpose·방향·양쪽 신원·
connection epoch·단조 sequence·원래 request ID를 넣는다. 재연결은 새 키/epoch이며 이전 입력을 재전송하지 않는다.
신규 AI wire/protocol에서 협상하고, 기존 phone v4/Mac screen v5 및 기존 computer-use v1 bytes는 바꾸지 않는다.

## 3. 이미 실행 중인 call seam에 주입

| 수정 지점 | 최소 계약 |
|---|---|
| `api-server.ts`의 `agentDialogueHost` 조립과 `executeCommunityControl` | CF channel/dispatcher를 한 번 조립한다. 검증된 peer record에서만 기존 제한된 executor를 호출한다. 수신 전/큐 실행 직전에 현재 lease·capability·local-off를 재확인한다. |
| `AgentDialogueHost`의 `controlCall/controlResult/controlRespond/controlPoll` | 새 `CommunityControlTransport` dependency로 전송·영수증을 분리한다. 기존 timeout/unknown/onSent/source-owner 계약을 보존한다. CF와 기존 우편함에 이중 전송하지 않는다. |
| `createComputerUseRemoteSidecar` | 인증된 transport와 identity provider를 client/host 양쪽에 주입한다. 기존 instance, grant, 사람 제어, remote-chain 및 native OS guard는 그대로 둔다. |
| `ComputerUseRemoteClient.hello` | native-bound peer proof/key confirmation 성공 전 `link.session`을 만들지 않는다. |
| `ComputerUseRemoteHost.hello/execute` | 인증 전 session 저장·이전 session 종료·runtime admission·실행을 하지 않는다. 입력도 현재 peer lease를 재검사한다. |
| `opsRequestDispatch`와 수신 `opsRequestHost.receive` | 같은 원래 requestId를 같은 authenticated sender namespace로 전달한다. routing ACK는 submitted/completed 영수증이 아니다. |

유효한 v2 peer 목록이 아직 endpoint/project metadata를 주지는 않는다. DB display name이나 같은
`deviceId`라는 이유로 로컬 target을 추정하지 않는다. 인증된 peer의 bounded project/OPS discovery를
사용하고, 실행 측은 자신에게 등록된 target ID를 재해석한다. 경로·credential·명령 문자열은 내보내지 않는다.

전송 선택은 원래 작업 ID에 write-ahead로 고정한다. CF에서 결과를 잃었다고 Supabase로 같은 입력을
다시 보내지 않는다. 기존 우편함에서 미확정인 작업은 원래 receipt 경로로만 회복한다. 신규 공통 기능은
상대의 새 프로토콜/lease가 없으면 준비 필요로 표시하고 인증이 없는 hello로 downgrade하지 않는다.

## 4. Teams는 별도의 실행 binding 추가

같은 인증 채널에서 `purpose=teams` 전용 strict DTO로 `create-member/read/submit/receipt/close`를
다룬다. 수신 측은 등록된 project를 해석하고 기존 worktree lease·AI launch choice·permission mode로
팀원을 시작한다. 원격 body의 경로·계정 토큰·임의 shell·권한 우회는 받지 않는다.

`TeamExecutionRef`에는 별도 버전의 remote ref가 필요하다. 최소 community/device ID, remote opaque
handle, team/member ID, execution generation을 결속하고 private task capability는 UI projection에 넣지
않는다. `teamRuntimeBridge`의 start/observe/send/close가 이 ref를 통해 같은 원래 operation ID로 동작해야
한다. `working`은 원격 worker가 실제 시작과 지시 수신을 영수증으로 확인한 경우에만 사용한다.
모델·에포트·surface 선택은 기존 명시된 선택을 보존한다.

## 통과 조건

다음은 후속 구현의 인수 조건이며 현재 통과 기록이 아니다.

1. 실제 production factory로 두 isolated host를 만들고 CF Miniflare WS로 왕복한다. broker는 임시
   software signer fixture이며 실제 Keychain/운영 DB를 쓰지 않는다.
2. issuer/subject/role/purpose 바꿔치기, 양쪽 ephemeral 치환, reflection, key confirmation 생략,
   오래된 revision/epoch·replay를 모두 거절하고 executor 호출이0건이어야 한다.
3. enqueue 뒤 revoke/off/만료·사람 takeover와 late reply에서 추가 실행0건, 다른 requestId/transport로
   자동 재전송0건을 확인한다. routing ACK만으로 성공 판정하지 않는다.
4. 원격 Teams create 응답 유실·수신 재시작에서 같은 request ID의 receipt만 읽고 팀원 중복 생성0건,
   local/remote target·member binding 혼동0건을 확인한다.
5. 통합 브랜치 verify/personas 후 서명된 1호·3호 실기와 iPad5G의 생체 인증·유휴60분 정책을 별도 확인한다.

## 검토 근거의 한계

Tier2 graph `agentstoz-community-auth-policy`, generation `2026-11-02T11:36:03Z`에서 관련 class/method,
hello→channel·sidecar→client/host 호출을 확인하고 경로 coverage를 조회했다. api-server의 partial ranges와
조립부·수신부는 직접 읽었다. 새 CF SDK와 수정한 browser는 graph가 오래되어 `git show 6dadf7a8` 및 실제
작업 소스로 확인했다. Teams 결론은 위에 열거한 launch/ref/runtime·OPS 경로에 한정하며 전 저장소의
완전한 기능 부재를 주장하지 않는다.
