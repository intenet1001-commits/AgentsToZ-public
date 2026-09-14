# 아키텍처 설계: Mac·Vercel 원격 프로젝트와 워크룸

## 개요

Mac의 등록 프로젝트를 정본으로 두고, Mac 네이티브·Vercel 원격웹·iOS 네이티브에서 같은 두 가지 목적을 수행한다. 첫째는 **AgentsToZ 워크룸에서 실제 CLI 작업**, 둘째는 **정확한 Mac 프로젝트를 Codex 앱에 처음 열어 놓고 이후 Codex 앱에서 사용자가 작업**이다. 프로젝트 폴더·main/worktree 선택은 두 목적의 공통 선행 조건이다. Mac+웹을 먼저 납품하되 iOS의 같은 호스트 `프로젝트/워크룸` 두 탭과 하나의 연결 수명까지 최종 범위에 포함한다.

현재 PTY·등록 대상 해석·원격 권한·Codex 프로젝트 열기 구현을 재사용한다. 신규 대규모 디렉터리 구조나 Supabase 테이블을 만들지 않고, 작은 순수 정책·유스케이스·어댑터·UI의 네 책임을 기존 평면 `src/`에 나눈다. 추가 실행 Aggregate/Repository는 [domain-analysis.md](./domain-analysis.md)의 `ProjectLaunchReceipt` 하나이며 별도 기기 권한의 `RemoteTerminalGrantStore`를 사용한다. 이 문서는 계획이며 실제 앱·AI 실행, 환경 복구, 소스 변경을 수행하지 않았다.

## 현재 근거와 진단 범위

| 관측 | 설계에 미치는 영향 | 근거 |
|---|---|---|
| 관리형 쓰기 작업은 production 상수로 닫혀 있다. 읽기 전용 지속 대화는 다른 상수다. | 워크룸 실작업, 읽기 전용 대화, 관리형 실행을 같은 권한이나 준비 상태로 표현하지 않는다. | `src/agentRuntimeProtocol.ts:5`, `:9`, `:13` |
| PTY service는 supervisor 획득 try 밖에서 생성된다. supervisor 실패 서비스도 targets·readiness 조회를 유지한다. | 구조화 런타임 복구 필요를 프로젝트 생성·워크룸·Codex 앱 열기의 전역 차단으로 확대하지 않는다. | `api-server.ts:7703`, `:7729`, `:7651` |
| 로컬 워크룸 버튼은 inventory에서 정확한 대상 하나를 선택하고 start 결과의 session ID로 이동한다. | 이 경로를 재사용하고 target mismatch·start 실패·첫 출력 실패를 분리해 진단한다. | `src/App.tsx:9868` |
| 터미널 설정에 따라 Codex 실행이 내부 PTY·Orca·cmux·외부 터미널로 달라진다. | 주요 목적 버튼은 실행 표면을 명시하고 숨은 전역 터미널 설정에 따라 달라지지 않게 한다. | `src/App.tsx:5416`, `:12124`, `:12173` |
| 원격 생성 gateway가 생성 반환값을 버리고 core가 목록 0페이지를 반환한다. | 생성 직후 정확한 새 프로젝트 ID·controlId를 결과에 포함해 곧바로 다음 행동으로 연결한다. 이름 검색이나 첫 카드 추정은 쓰지 않는다. | `api-server.ts:11880`, `src/remoteControlCore.ts:1113` |
| `agent.codex`는 Orca이고 `app.codex`는 데스크톱 앱이다. | 기존 wire 의미를 유지하고 UI가 CLI와 앱을 구분한다. | `src/remoteControlExternalLaunchRoute.ts:23` |
| Codex `mode=new`는 무프롬프트 입력창 열기이고 영구 프로젝트 결속을 확정하지 않는다. 첫 대화 coordinator는 별도의 준비 기능이다. | 기본 최초 열기는 기존 고정 첫 메시지 경로로 프로젝트 결속을 준비한다. `mode=new`는 보조 ‘앱만 열기’다. | `api-server.ts:18179`, `:12215`, `code-app-links.ts:12` |
| 첫 Codex 대화 coordinator는 생성 ID를 보존·동시 요청 병합·복구 검증하지만 `openThread`는 void이고 호출 뒤 pending을 지운다. | OS 전달 접수와 실제 프로젝트 선택 확인을 분리하며 불확실한 결과에서 새 대화를 자동 생성하지 않는다. | `src/codexFirstConversationLaunch.ts:74`, `:104`, `:144` |
| LAN 일반 소켓 종료는 세션을 남기고, 현재 재접속은 새 management ID로 터미널 재승인을 요구한다. | 최초 Mac opt-in으로 지속형 기기 grant를 명시적으로 신설하고 현재 socket 권한으로 재검증한다. 기존 session-only grant를 자동 승격하지 않는다. | `src/remoteControlLanServer.ts:523`, `:587`; 오래된 설명 `docs/runtime-execution.md:31` |
| 네이티브 broker 등록·probe는 실제 모델 실행 준비 완료가 아니다. | 일반 사용자의 워크룸 준비 화면에서 broker 시험 버튼을 필수 선행 단계로 제시하지 않는다. | `src/MacOSRuntimeBrokerSetup.tsx:191` |

설치본에서 버튼이 실행되지 않는 실제 원인은 아직 특정하지 않는다. 계획팀의 sidecar·supervisor 관측은 구조화 런타임 장애 후보 근거이며 PTY 실패 증거와 다르다. 구현 첫 단계에서 해당 버튼 → Tauri 전송 → 대상 해석 → 실행 파일 발견 → PTY 생성 → 첫 출력 순서의 관측을 수집한다. 기존 로그의 작성 시각이나 health 성공만으로 개별 실행 성공을 추정하지 않는다.

**브리핑 정정:** `src/App.tsx:9870`의 `AgentRuntimeClient.targets()`가 supervisor 오류를 그대로 받는다는 초기 가설은 `api-server.ts:7656`의 독립 targets 구현으로 기각했다. 새 targets endpoint를 만들 이유가 없다. 이 독립성은 회귀 검증으로 고정한다.

## 레이어 구조

아래 신규 파일명은 책임을 나타내는 구현 제안이다. 기존 모듈을 이동하거나 일괄 개명하지 않는다.

```text
src/
├── projectLaunchPolicy.ts              # 신규: 순수 준비 상태·작업 결과 표시 정책
├── projectLaunchReceipt.ts             # 신규: domain 정본 VO/Receipt/Repository 계약
├── projectLaunchCoordinator.ts         # 신규: 생성·워크룸 시작·Codex 앱 최초 열기 조율
├── projectLaunchReceiptStore.ts        # 신규: 기존 파일 잠금/원자 저장을 사용하는 로컬 어댑터
├── remoteTerminalGrant.ts             # 신규: domain 정본 grant 계약·순수 정책
├── ProjectLaunchActions.tsx            # 신규: 로컬 상세/생성 완료의 공통 주요 행동
├── App.tsx                            # 기존: 주요 행동 조합과 워크룸 이동
├── AiTerminalPanel.tsx                 # 기존: 실제 PTY 표시·입력·다시 연결
├── aiTerminalService.ts                # 기존: PTY 수명·요청 중복 방지·입력 권한
├── aiTerminalRemoteGateway.ts          # 기존: 원격 authority·controlId 변환
├── remoteControlCore.ts                # 기존: LAN 세션/action 경계와 결과 DTO
├── remoteControlMobilePage.ts          # 기존: LAN 모바일 워크룸 UI
├── remote-control-portal-main.tsx      # 기존: Vercel/인터넷 호스트 선택·연결 UI
├── remoteControlExternalLaunchRoute.ts # 기존: Orca와 Codex 앱 의미 분리
├── codexFirstConversationLaunch.ts     # 기존: 명시적 첫 대화 생성의 중복 방지
└── agentRuntimeReadiness*.ts           # 기존: 관측/정규화 확장, 표면별 판정
api-server.ts                          # 기존 composition root와 HTTP gateway
src-tauri/src/lib.rs                    # 기존 capability 프록시, 변경 시 명시적 allowlist 유지
code-app-links.ts                      # 기존 Codex 프로젝트 딥링크
```

새 정책은 React/Bun/Tauri·파일 시스템을 import하지 않는다. coordinator는 작은 함수형 ports를 주입받고 transport를 알지 않는다. 어댑터가 기존 함수 결과를 정본 DTO로 변환한다. `api-server.ts`는 생성과 연결만 담당하며 새로운 상태기계를 추가로 복제하지 않는다. 모바일 정적 스크립트에는 기존 빌드 경로를 통해 같은 정책 결과/표시 문자열을 전달하고 별도 판단 규칙을 작성하지 않는다.

## Domain Layer

정본 용어·불변식·Repository 정의는 [domain-analysis.md](./domain-analysis.md)를 따른다. 기존 `RemoteControlRegisteredTarget`, `AiTerminalSummary`, `AiTerminalService` 세션을 새 모델로 대체하지 않는다.

`ProjectLaunchKey`는 hostId·owner·requestId, `ProjectLaunchTarget`은 targetId·kind·identityHash다. `ProjectLaunchReceipt`는 domain 문서의 operation·fingerprint·target·workspaceRoot·status·stage·생성 결과 식별자·revision·updatedAt를 그대로 사용한다. workspaceRoot는 workspaceRootId·identityHash 결속이다. status는 `requested | confirmed | unknown | failed`다. 타입 전체를 여기서 중복 정의하지 않는다.

`ProjectLaunchTarget`와 Receipt 원본은 서버 전용이다. 원격 DTO에는 현재 연결에서 다시 해석한 controlId, 호스트/프로젝트 표시명, main/worktree, 작업 종류, 단계·상태·재시도 방법만 내보낸다. canonical path·identityHash·안정 owner 식별자·로컬 thread ID를 그대로 송신하지 않는다. 공개 가능한 thread 연결은 기존 verified route를 거친다.

`ProjectLaunchKey.owner`는 재연결을 추적할 수 있는 승인 세션/controller의 서버 전용 안정 식별자다. 현재 PTY authority의 `lan:<management id>`와 동일시하지 않는다. Receipt는 권한이 아니며 재시도·상태 조회는 현재 connection과 target 권한을 다시 확인한다. 지속형 terminal grant도 현재 socket 증명을 대신하지 않는다.

### Repository Interfaces

아래는 domain 담당자가 정한 시그니처를 그대로 사용한다. 구현체는 reserve를 원자적으로 수행하며 같은 key의 다른 fingerprint는 충돌로 거부한다. update는 revision CAS다.

```typescript
interface ProjectLaunchReceiptRepository {
  find(key: ProjectLaunchKey): Promise<ProjectLaunchReceipt | null>;
  reserve(receipt: ProjectLaunchReceipt): Promise<{
    receipt: ProjectLaunchReceipt;
    created: boolean;
  }>;
  update(receipt: ProjectLaunchReceipt, expectedRevision: number): Promise<boolean>;
}

interface RemoteTerminalGrantStore {
  find(hostId: string, controllerId: string): Promise<RemoteTerminalGrant | null>;
  update(grant: RemoteTerminalGrant, expectedRevision: number | null): Promise<boolean>;
}
```

`RemoteTerminalGrant` 정본도 domain 문서를 따른다: hostId·controllerId·scope·grantedAt·expiresAt·revision·revokedAt. scope는 `targets(targetIds)` 또는 `controller-created-projects(workspaceRoots의 workspaceRootId+identityHash)`다. 후자는 사용자가 선택한 root에서 이 기기가 생성한 프로젝트를 포함하는 **권장 별도 opt-in**이다. 현재 root 신원+같은 controller의 생성 Receipt+현재 등록 target을 함께 검증하며 다른 기기/전체 프로젝트로 자동 확대하지 않는다. 생성 전 projectId를 Receipt의 reserved stage에 보존하되 registered 이전에는 생성 성공으로 표시하지 않는다.

최초 저장은 `expectedRevision:null`, 이후 변경은 CAS다. Mac 승인 화면에 `이 기기에서 워크룸 작업 허용`을 두고 범위·만료·해제를 표시한다. `grantedAt`은 QR 발급일이 아닌 최초 성공 pairing/SAS 승인 시각이며 유효기간은 **이 시각+30일과 현재 승인 세션 절대 상한 중 짧은 값**이다. 재접속으로 연장하지 않는다. task/conversation 동의를 재사용하지 않는다. LAN에는 주소와 분리된 안정 pairing principal+host binding을 versioned vault로 추가하고, 인터넷은 기존 controller/host identity에 결속한다. 기존 session-only 동의를 자동 이관하지 않는다.

### 기능별 준비 상태와 결과 의미

하나의 ‘실행 가능’ bool 대신 다음 네 표면을 독립 판정한다. 프로젝트 생성과 폴더 열기는 AI 표면 밖의 일반 프로젝트 동작으로 별도 판정한다.

| 표면 | 실행 주체 | 준비 근거 | 사용자에게 확정할 수 있는 범위 |
|---|---|---|---|
| 워크룸 CLI | Mac Bun PTY + 설치 CLI | 지원 OS, 살아 있는 sidecar, 정확한 target, 실행 파일, 현재 원격 terminal grant | PTY session 생성, 최초 출력 관측, 종료 상태를 각자 표시. 로그인 완료나 작업 완료는 spawn 성공과 구분 |
| 읽기 전용 지속 대화 | 구조화 Codex conversation service | supervisor, 읽기 전용 adapter readiness, 별도 scope | 대화 가능 여부. 코드 수정 가능이라는 표현 금지 |
| 관리형 파일 쓰기 실행 | managed task service | production gate와 실제 containment 증거 | 현재 미제공. broker 등록/probe나 terminal grant로 해제 불가 |
| Codex 앱 최초 열기 | Mac Codex Desktop | 앱 설치·첫 대화 준비에 필요한 로그인/권한·정확한 target·desktop membership | 고정 첫 메시지로 프로젝트 연결을 준비. OS 전달 요청·desktop membership+thread 결속·화면 활성화를 구분 |

진단 결과에는 관측 시각·유효성·reason code·다음 행동을 둔다. 호스트 offline/연결 지연/잠자기 추정, 앱·sidecar 버전 불일치, CLI 미설치, 로그인 필요/미확인, 원격 권한 필요, 프로젝트 경로 불일치, supervisor 복구 필요를 다른 이유로 표시한다. 클라이언트 연결 실패만으로 ‘잠자기’라고 단정하지 않고 마지막 관측을 함께 보여 준다. 로그인 점검은 수동 상태/기존 안전한 상태 조회를 먼저 사용하며 화면 진입만으로 AI 요청을 실행하지 않는다.

Receipt의 `confirmed`는 **해당 작업의 명시된 결과만** 확정한다. 프로젝트 생성은 폴더+등록 결과, 워크룸은 정확한 target의 PTY session 존재, Codex는 정확한 desktop membership+thread 결속이다. cwd 일치나 OS open 접수만으로 확인하지 않는다. OS open 접수만 확인했다면 `requested`; 제한시간 내 후속 증거를 얻지 못하면 `unknown`. `confirmed`도 창 전면 활성화나 실제 개발 작업 완료를 뜻하지 않는다.

## Application Layer

### Use Cases

| 유스케이스 | 입력 | 결과 | 사용 저장소/기존 서비스 | 이벤트 |
|---|---|---|---|---|
| UC1 createRemoteControlProject — 프로젝트 만들고 바로 선택하기 | action/request ID, 작업-root controlId, 검증된 이름 | 생성 Receipt + 정확한 새 프로젝트 DTO | Receipt Repository, 기존 생성 함수 | 기존 action.result 확장 |
| UC2 RemoteControlCore — 기본 폴더/워크트리 선택하기 | 현재 host, 프로젝트/control ID | exact main/worktree 대상 | 기존 target inventory/resolver | 기존 목록/상태 응답 |
| UC3 AiTerminalService.perform(start) — 워크룸에서 작업 시작하기 | request ID, exact target, AI, 선택적 요청 | Receipt + AiTerminalSummary | Receipt Repository, AiTerminalService | 기존 terminal response |
| UC4 AiTerminalService.perform(list/read/input/close) — 같은 워크룸 이어가기 | session ID, cursor, 현재 authority | 현재 세션·출력·종료 결과 | AiTerminalService | 기존 terminal response |
| UC5 CodexFirstConversationLaunchCoordinator.createAndOpen — Codex 앱에서 처음 열기 | request ID, exact target, 처음/기존 의도 | Receipt + 준비/열기 단계별 결과 | Receipt Repository, 기존 Codex coordinator | 기존 action.result 확장 |
| UC6 준비 상태 확인 — 가능한 행동과 해결할 항목 보여주기 | 현재 host, action, opaque target | 독립 준비 상태·원인·다음 행동 | 기존 readiness/설치 어댑터 | 없음 |
| UC7 재접속/권한 변경 — 프로젝트 연결과 작업 권한을 구분하여 복원하기 | pinned host/controller, 현재 socket, grant revision | 현재 authority·허용 대상 | RemoteTerminalGrantStore, 기존 연결/vault | 기존 연결 상태 응답 |

위 이름과 번호는 domain 정본 7개를 따른다. 미확정 결과의 재조회는 각 유스케이스의 공통 복구 단계이며 별도 유스케이스를 추가하지 않는다. 일반 이벤트 버스·새 백그라운드 작업 시스템을 도입하지 않고 기존 응답으로 결과를 반환한다.

### 공통 실행 순서

1. 현재 호스트·연결 권한·등록 target/root를 서버에서 해석한다. UI가 보낸 path나 branch 이름으로 대상을 새로 만들지 않는다.
2. request fingerprint를 계산하고 Receipt를 reserve한다. 생성 operation은 예정 projectId·root identity까지 부작용 전에 원자 저장한다. 같은 key·같은 요청이면 기존 결과/진행 상태를 반환하고, 다른 입력이면 충돌을 반환한다. crash 후 같은 이름의 기존 폴더만 보고 이번 생성으로 입양하지 않는다.
3. 외부 부작용 직전에 등록·canonical identity·main/worktree 연결과 현재 authority를 재검증한다. 기존 파일 lease의 범위와 순서를 재사용한다.
4. 생성된 프로젝트 ID·PTY session ID·Codex thread ID를 얻는 즉시 보존한다. 후속 UI 열기 실패로 생성 단계를 다시 실행하지 않는다.
5. 결과 단계별 근거로 Receipt를 CAS 갱신한다. 응답 유실·timeout이면 상태를 다시 읽고, 부작용 재실행은 자동으로 하지 않는다.
6. UI는 정확한 생성 결과로 이동한다. 기존 Git·장기기억 기본 준비는 유지하고 각 단계 상태를 분리한다. 최근 방문·백업은 생성 성공을 막지 않는 후속 처리로 옮긴다. 별도 Git 동기화·추가 저장은 사용자 선택 동작이다.

현재 `createAgentsToZUseProject`는 memory 초기화 뒤 등록하고 백업 응답을 기다린다(`api-server.ts:2290`, `:2307`, `:2341`). `saveLastVisitData`의 일반 I/O 실패는 이미 내부 catch로 nonblocking이다(`api-server.ts:8237`). outer try 안에 있다는 이유로 이 실패가 폴더 이동으로 전파된다는 초기 가설은 기각했다. 구현은 **폴더+등록**을 commit point로 명시해 추출 후에도 후속 부가 예외가 폴더를 옮기지 않는 예방 계약을 고정한다. 기존 실패 폴더는 보존하며, 초기 Git baseline 미준비는 main 워크룸 대신 worktree 생성만 기존 gate로 제한한다.

### Codex 앱 최초 열기

주요 버튼은 두 개다: `워크룸에서 작업`, 상태에 따라 `Mac의 Codex 앱에서 처음 열기` 또는 `Mac의 Codex 앱에서 이어 열기`. exact desktop membership+thread가 확인되면 이어 열기, 확실히 없으면 처음 열기, 메타데이터가 불명확하면 새 생성 없이 재확인을 제공한다. 브랜치 이름·cwd만 같은 다른 대화를 자동 선택하지 않는다.

처음 열기는 기존 `codex.thread.start`와 `CodexFirstConversationLaunchCoordinator`의 **프로젝트 준비용 고정 첫 메시지 1회** 경로를 재사용한다. 버튼 하단에 ‘프로젝트 연결용 첫 대화만 준비하며 실제 작업은 Mac Codex 앱에서 이어서 진행’을 표시한다. 프로젝트 메타데이터·desktop membership+thread 결속을 확인하고 사용자는 그 뒤 Codex 앱에서 실제 작업을 한다. 연결용 준비가 자동 개발·파일 수정 요청으로 확대되지 않도록 기존 고정 메시지와 검증 범위를 유지한다.

durable thread ID를 얻은 뒤 실패하면 같은 thread의 확인/열기만 다시 수행한다. `openThread:void`를 결과를 가진 비동기 어댑터로 좁혀 전달 접수와 확인을 기록한다. 확인을 얻지 못했다고 pending 정보를 지우거나 새 대화를 만들지 않는다. OS 전달만 됐다면 ‘Mac에 열기 요청을 보냈습니다. Codex 앱에서 프로젝트를 확인하세요’와 `requested/unknown`을 표시한다. 첫 메시지 전송 여부가 불명확한 경우도 새 전송 없이 기존 결과를 먼저 조회한다.

AI 호출 없는 `api-server.ts:18179`의 `mode=new`는 보조 `앱만 열기`로 유지하며 영구 프로젝트 준비 완료로 판정하지 않는다. `새 대화`도 보조 기능이다. 현재 `mode=open`은 Hermes에만 허용되므로 Codex용 의미를 기존 값에 덮어씌우지 않는다(`api-server.ts:18024`).

### Supervisor 복구 경계

`src/agentRuntimeSupervisor.ts:12`는 production 복구를 수동으로 제한한다. 죽은 owner나 과거 시간만으로 분리된 자식의 쓰기 권한이 사라졌다고 증명할 수 없다. 따라서 P0는 surface별 진단과 현재 가능한 기능으로 이어지는 안내를 제공하고, lock 삭제·대기시간 감소·production flag 변경을 해결책으로 사용하지 않는다.

복구 버튼의 구현은 **알려진 소유 범위, 필요한 전용 UID/OS 경계, 남은 작업·권한 종료의 사후조건**이 검증되는 경우에만 별도 게이트로 허용한다. 증명하지 못하는 설치본은 이유와 제한을 보여 주며 미완료 기록을 보존한다. 이 복구 경계가 PTY·프로젝트 생성·Codex 앱 열기의 독립 사용을 막지 않게 회귀 검증한다.

## Interface Adapters Layer

### Controllers와 전송

| 기존 경로/경계 | 변경 계획 | 유지할 제한 |
|---|---|---|
| `/api/agent-runtime`의 기존 readiness·targets | 표면별 readiness 결과와 관측 근거 보강 | capability 프록시 유지, targets는 supervisor 실패와 독립 |
| `/api/agent-runtime/terminals` | 기존 list/start/read/input/resize/close, 시작 Receipt 연결 | 임의 shell/path/env 금지, remote authority 재검증 |
| LAN/Internet `project.create` | 생성 ID 반환, 결과 controlId 생성, Receipt 상태·다음 행동 | 기존 root controlId 재해석, 이름 제한·삭제 fence 유지 |
| LAN/Internet `app.codex` 및 명시적 최초 열기 의도 | 현재 wire 의미를 유지하며 협상된 클라이언트에만 신규 최초 열기 계약 제공 | Orca `agent.codex`와 분리, 정확한 target |
| 로컬 Codex 처음/이어 열기와 `/api/open-code-app` | 첫 준비는 기존 첫 대화 coordinator, 이어 열기는 verified thread, 앱만 열기는 기존 mode=new | 외부 원격이 로컬 path API를 직접 호출하지 않음 |
| 미확정 결과 조회 | 기존 로컬 관리/원격 action 응답 계열에 versioned query 추가 여부를 구현 시 정한다 | 먼저 클라이언트·호스트 capability 협상, strict normalizer 동시 변경 |

현재 wire가 exact key 검사인 곳에 임의 필드를 덧붙이지 않는다. 호스트 우선 기능 지원·프로토콜 버전을 배포하고 웹은 지원 확인 후 사용한다. 구버전 호스트는 현재 동작과 명시적인 업데이트 안내를 유지한다. Vercel은 UI와 기존 암호화 relay를 제공하며 CLI 실행 호스트나 인증정보 보관 장소로 바꾸지 않는다.

### Repository Implementation

`projectLaunchReceiptStore.ts`는 기존 app-data 파일 잠금·원자 교체 도구를 사용한 작은 로컬 0600 저장소로 설계한다. 외부 DB·테이블 migration은 없다. `reserve/update`를 같은 app-data lease 아래 직렬화하고 원본 요청·토큰·출력을 저장하지 않는다. 기존 Codex pending-store와 Receipt는 단일 쓰기 경로로 연결한다. `RemoteTerminalGrantStore`는 기존 LAN/인터넷 vault의 versioned 어댑터로 구현한다. 잘못된 schema·불명확한 owner·시계/만료 검증 실패는 terminal grant를 허용하지 않으며 기존 기록을 삭제하지 않는다.

완료 Receipt만 유효기간/개수 한도에 따라 정리한다. **유효한 controller-created-projects grant의 대상 증명에 쓰이는 생성 Receipt는 grant 만료/해제와 허용 재시도 수명이 끝날 때까지 얇은 증거를 보존**한다. 완료됐다는 이유로 먼저 지워 30일 안의 자기 프로젝트 접근이 끊기면 안 된다. `requested/unknown`과 진행 중 생성·미완료 저장 기록은 임의 삭제하지 않는다. 한도가 차면 새 부작용 시작을 제한하고 기존 상태 조회·종료·복구는 계속 허용한다. 만료한 완료 요청의 자동 재전송은 허용하지 않으며 클라이언트 요청 수명도 함께 제한한다. 구체적 숫자는 기존 자원 예산과 동일한 테스트에서 정하고 무제한 map·timer를 만들지 않는다.

## Infrastructure Layer

### 의존성 주입

```text
App/Remote UI → transport adapter → projectLaunchCoordinator → projectLaunchPolicy
                                             ↓
                              ProjectLaunchReceiptRepository
                                             ↑
                         app-data atomic file + existing lease

projectLaunchCoordinator → injected existing target resolver / project creator
                         → AiTerminalService / Codex Desktop adapter
api-server.ts wires these implementations; policy imports none of them.
```

P0~P4의 Receipt/Grant 로컬 설계에는 새 환경변수·Vercel secret·Supabase schema를 전제하지 않는다. iOS 인터넷의 OAuth callback·인증 설정 변경 필요 여부는 구현 조사 전 미확정이다. 지원 버전/feature 응답으로 기능을 협상하고, 실제 Codex 앱 프로젝트 선택 계약은 설치 버전에서 재확인한다.

### 수명·재연결·예산

QR 1회+최초 동의 후 동일 기기는 **30일 동안** 일상적인 재연결·잠금·백그라운드·탭 전환·앱 재시작에 QR/승인을 반복하지 않는다. 만료·명시적 해제·사용자의 저장소 초기화는 새 pairing이 필요한 예외다. 별도 새 기기/새 host는 동일 기기 복귀로 취급하지 않는다. 현재 권한은 **grant의 host+cryptographic principal+scope+expiry+revocation revision과 새 socket epoch**를 함께 검증해 만든다. 비동기 조회 뒤·대기 입력 직전에도 검사하고, 오래된 소켓은 즉시 입력 권한을 잃는다. 현재 session-only grant는 자동 승격하지 않는다.

30일 pairing/controller 수명은 Google/Supabase access token 수명과 다르다. 기존 `getAuthenticatedSupabaseClient` refresh를 재사용하고 token 만료·네트워크 오류를 revoke로 분류해 QR을 요구하지 않는다. 필요하면 같은 계정 재인증 후 pinned controller/E2EE를 복원한다. 다른 계정·실제 권한 철회는 거부한다. 읽기 실패/offline으로 credential을 지우지 않으며 만료·해제·명시 signout의 정해진 정리만 수행한다. 새 고빈도 refresh loop나 RLS 완화를 추가하지 않는다.

Mac/기기 재시작에는 보호된 vault·기기 저장소의 stable identity로 pairing을 복원한다. LAN은 QR 시점의 host public identity와 기기 identity를 pin하고, 재연결 challenge의 nonce·서명·host/controller 결속을 검증한다. 기존 인터넷 E2EE identity를 재사용할 수 있는지는 계약으로 확인한다. IP/포트는 locator일 뿐이다. 주소가 바뀌면 제한된 로컬 discovery/사용자 지정 새 locator에서 **기존 pinned host proof**가 확인된 경우에만 locator를 갱신하고 새 QR을 요구하지 않는다. proof 불일치는 연결 거부이며 이름/IP가 같다는 이유로 host key를 교체하지 않는다. 이 범위의 새 versioned handshake를 지원하지 않는 구버전은 업데이트 안내를 표시한다.

sidecar 재시작 후 Receipt에 오래된 terminalSessionId가 있어도 세션이 살아 있다는 증거가 없으면 `unknown`이다. 자동 PTY 재시작·작업 요청 재전송을 하지 않는다. 호스트 전환 시 늦은 결과가 다른 호스트 UI를 덮어쓰지 않게 host generation을 검사한다. 모바일 출력/입력은 기존 암호화 크기 제한, FIFO, cursor, 잘림 표시를 유지한다.

PTY 기존 상한(동시 12개, 목록 24개, 세션 출력 약 100만 문자), 요청 이력 100,000건과 mutation 대기 256개를 확대하지 않는다(`src/aiTerminalService.ts:97`, `:214`, `:228`, `:244`). 원본 기억·미완료 저장 삭제로 UI 예산을 맞추지 않는다. 진단은 화면 활성 시 한 번/사용자 다시 확인/관련 결과 변화에 갱신하고 별도 고빈도 폴링을 추가하지 않는다.

### iOS 프로젝트/워크룸 연결 통합

현재 SwiftUI 프로젝트 연결과 WKWebView 워크룸이 분리돼 있고 인터넷은 시스템 브라우저다(`mobile/ios/README.md:3`, `:8`, `:32`). 최종 UX는 같은 host의 두 탭이 하나의 connection owner·principal·선택 target·재접속 상태를 사용하고, 전환 시 새 QR이 필요하지 않는 구조다. Mac+웹 우선은 납품 단계이지 iOS를 제외하는 완료 기준이 아니다.

최소 구현은 호스트별 동일 origin의 한 transport owner와 두 탭을 공유한다. 기존 웹 프로젝트/워크룸을 같은 WKWebView 수명 안에서 사용하는 방법을 먼저 검증해 socket·E2EE 구현 중복을 줄인다. 네이티브 프로젝트 코어와 웹 전송을 함께 유지해야 한다면 서버 검증 일회용 handoff로 한 owner만 활성화한다. 원시 token/cookie를 화면 간 복사하거나 두 개의 활성 controller를 숨겨 만들지 않는다. 별도 native JS bridge가 필요하면 등록 프로젝트/terminal의 typed 메시지만 받고 임의 URL·path·shell API는 노출하지 않는다.

인터넷 로그인은 시스템 인증 세션의 PKCE/state와 정확한 복귀 origin을 검증하고 같은 앱 connection owner로 돌아와 E2EE·SAS·grant를 연결한다. Google은 embedded user-agent를 허용하지 않으므로 WKWebView 안에서 OAuth를 직접 진행하지 않는다([공식 native OAuth 지침](https://developers.google.com/identity/protocols/oauth2/native-app#disallowed_useragent)). ASWebAuthenticationSession과 기존 Supabase/Google 복귀 계약은 구현 첫 조사에서 검증한다. 브라우저만 열어 두는 현행 경로는 중간 대안이며 최종 완료가 아니다. 실제 iPhone의 로그인 복귀·권한 거부·백그라운드 복원·탭 전환·같은 세션 입력을 출하 gate로 둔다. wire 변경에는 verify 외 `bun run test:ios`가 필요하다(`mobile/ios/README.md:55`).

### Vercel 디자인 통합

현재 일반 포털은 `index.css`의 warm-stone/copper·Manrope 토큰을 쓰지만 원격웹은 `src/remote-control-portal.css:1`의 강제 dark·Inter·navy/mint를 쓴다. 같은 원격 화면 안의 터미널도 `src/AiTerminalPanel.css:3`의 warm fallback을 써 혼재한다. 단순 카드 두 개 정리로 끝내지 않고 portal-main/remote/workroom의 색·폰트·간격·버튼·모달·오류·내비게이션을 통일한다.

`index.css`에서 토큰·자체 호스팅 폰트만 공통 stylesheet로 추출하고 `appAppearance.ts`의 gray/light 기본값·dark 선택을 재사용한다. 전체 index.css를 원격 페이지에 추가 import해 Tailwind reset을 겹치지 않는다. 공통 header/nav/card/input/dialog/status/empty/error 구성요소를 작게 재사용하고 `portal-main.tsx`의 별도 하드코딩 theme 변수도 같은 토큰에 연결한다. xterm ANSI/터미널 내부는 어두운 표면 예외로 유지한다.

로그인→승인→프로젝트→워크룸→오류/재시도 전 구간을 light/dark, 모바일 320~430px와 44px touch target, 데스크톱 1024/1440px·125% 확대에서 실제 상호작용으로 검증한다. 색만 바뀌었는지의 문자열 테스트는 완료 증거가 아니다.

## 아키텍처 결정사항 (ADR)

| 결정 | 선택 | 이유 |
|---|---|---|
| 주요 사용 경로 | 워크룸 실작업 / Mac Codex 앱 최초 열기 | 사용자 목적과 실행 주체를 바로 연결 |
| 실행 readiness | 네 표면별 독립 결과 | 관리형 미제공·읽기 전용 장애가 PTY까지 거짓 차단하는 것을 방지 |
| 대상 식별 | 기존 opaque ID + 직전 canonical identity 재검증 | main/worktree·동명 폴더·호스트 전환 오실행 방지 |
| 최초 Codex 열기 | 고정 준비용 첫 메시지 1회 + exact desktop membership/thread 확인 | 프로젝트를 준비한 뒤 사용자가 앱에서 이어서 작업 |
| 중복 방지 | 기존 request ID + 작은 durable Receipt | 응답 유실 후 생성·시작 중복 방지, 단계별 복구 |
| Receipt 저장 | 기존 로컬 app-data 파일/lease | 새 DB 의존성 없이 현 구조에 맞춘 구현 |
| 기능 확장 | 기존 route의 협상된 계약 확장 | 웹·설치본 배포 시차 및 strict normalizer 호환성 유지 |
| 미확정 결과 | 조회 먼저, 자동 부작용 재전송 금지 | 같은 프로젝트·세션을 보존하면서 안전한 재시도 제공 |
| 기본 준비/후속 처리 | Git·기억 기본 준비 유지, 최근 방문·백업 nonblocking | 초기화 상태를 정직하게 표시하고 등록 성공 이후 결과를 퇴행시키지 않음 |
| 원격 terminal 동의 | 명시적 지속형 기기 grant + 현재 socket epoch | 같은 기기 재접속 편의와 만료/해제/target 범위 보존 |
| iOS 연결 | 프로젝트/워크룸 두 탭, 한 connection owner | 전환 시 새 QR 제거, native 인터넷도 최종 완료 범위 |

## SOLID 체크리스트

- [x] SRP: 준비 정책, 실행 조율, 저장, UI의 변경 이유를 분리한다.
- [x] OCP: 새 실행 표면을 추가할 때 기존 PTY service와 managed gate를 수정하지 않는다.
- [x] LSP: Receipt 메모리 fake와 원자 파일 구현체가 reserve/CAS 계약을 동일하게 만족한다.
- [x] ISP: coordinator에 필요한 기존 resolver/creator/launcher만 주입한다.
- [x] DIP: 정책·coordinator는 React·Bun HTTP·Tauri·OS 자동화에 의존하지 않는다.

## 핵심 설계 결정

**선택한 결정:** 기존 PTY와 Codex Desktop 열기에 대상 검증·준비 상태·Receipt만 얇게 공유한다. Codex는 기존 연결이 확인되면 이어 열기, 확실히 없으면 준비용 고정 첫 메시지 1회로 처음 열기다. 지속형 terminal 동의는 별도 최초 opt-in과 현재 socket 검증을 함께 사용한다. iOS 두 탭은 같은 연결 수명을 공유한다. 불명확한 실행 결과를 새 요청으로 덮거나 production 관리형 gate를 풀지 않는다.

**대안 접근법:** 모든 기능을 새 관리형 실행 플랫폼으로 통합한 뒤 하나의 시작 버튼으로 제공한다. 중앙 상태·권한 모델은 단순해질 수 있지만 Mac containment·supervisor 복구·CLI 인증·Desktop UI 인계까지 한 일정에 묶이며, 현재 이미 있는 PTY/앱 열기를 사용할 수 있는 시점이 늦어진다. 이 요청에는 기존 구현을 살리는 선택이 더 작고 검증 가능하다.

## 발견·우려와 검증 게이트

| 항목 | 심각도 | 확신 | 근거/남은 검증 |
|---|---|---|---|
| 실제 버튼 실패 원인 미확정 | 높음 | 높음 | 소스 구조상 단계가 독립. 설치본의 해당 클릭 결과·첫 출력 증거 필요 |
| 생성 결과가 다음 행동 대상과 직접 연결되지 않음 | 높음 | 높음 | `api-server.ts:11880`, `src/remoteControlCore.ts:1118` |
| OS 열기 반환을 화면 선택 성공처럼 보일 위험 | 높음 | 높음 | `src/codexFirstConversationLaunch.ts:146`, `api-server.ts:18181` |
| supervisor 수동 잠금 복구를 임의 제거로 해결할 위험 | 높음 | 높음 | `src/agentRuntimeSupervisor.ts:12`; detached 자식 권한 종료 증거 필요 |
| 재연결 owner와 Receipt owner 혼동 | 높음 | 높음 | `src/remoteControlLanServer.ts:523`; 현재 terminal grant 별도 재검증 |
| native broker 상태를 CLI 준비 완료로 오인 | 중간 | 높음 | `src/MacOSRuntimeBrokerSetup.tsx:191` |
| iOS 탭 연결·native 인터넷 현재 격차 | 높음 | 높음 | `mobile/ios/README.md:3`, `:8`, `:32`; one-owner/handoff·PKCE 복귀 실기기 gate |
| Codex 최신 설치본의 정확한 선택 관측 가능성 | 중간 | 중간 | 현재 local deep-link 코드만 검토. 실제 버전의 지원 계약/선택 증거 별도 확인 |
| 원격 권한을 새로 주지 않고 Receipt만으로 실행 재개 | 높음 | 높음 | Repository는 결과 저장소이며 authority가 아님. deny/revoke/reconnect 회귀 필요 |

테스트 전략 정본은 별도 문서를 따른다. 아키텍처의 필수 검증은 supervisor 장애 중 targets/PTY 경로 독립, 새 프로젝트 정확한 ID 연결, main/worktree 교체 시 거부, 응답 유실·동시 클릭·재시작 시 중복 생성 없음, OS 전달만 된 Codex의 requested/unknown 표시, grant 철회/호스트 전환 후 입력 거부다. 계획 단계에서는 이 검증을 실행했다고 주장하지 않는다.
