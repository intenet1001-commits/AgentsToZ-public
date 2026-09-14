# AgentsToZ Agent Runtime Architecture

- 상태: Phase 0 구현 검증 중 · non-escapable containment gate `BLOCKED` · production managed execution 비활성
- Task protocol: `agentstoz-tasks-v2`
- 기존 원격 프로토콜: `agentstoz-local-v7` (동결)
- Internet task transport: `agentstoz-local-v8` + explicit `tasks-v1` scope (구현, execution safety hold)
- Internet conversation transport: 같은 E2EE v8 + explicit `conversations-v1` scope (구현, execution safety hold)
- 최종 갱신: 2026-09-05

## 목적과 제품 모델

AgentsToZ Runtime은 기존 Orca·외부 터미널 실행 기능을 대체하지 않는 additive control plane이다. PC는 프로젝트와 실행 자격을 보유한 **trusted execution node**, 모바일은 요청·진행·질문·승인·결과를 다루는 **leadership console**이 된다. 원격 기본 UX는 작은 PC 화면이나 터미널 미러링이 아니라 작업 함과 구조화된 타임라인이다.

실행 권한과 민감한 로컬 상태는 항상 PC에 남는다. 클라이언트는 등록된 대상의 opaque `targetId`, adapter ID, prompt만 제출한다. PC가 작업 직전에 대상을 다시 해석하고 실제 경로, 실행 파일, 환경, provider 세션을 관리한다.

```text
Desktop task center / future mobile leadership console
                         │ exact bounded task DTO
                         ▼
Local API ── Supervisor ── Durable intent journal
                │                    ▲
                │ trusted inputs     │ semantic events
                ▼                    │
        Structured CLI adapter ──────┘
                │
                ▼
       Local provider process
```

## 두 세션은 합치지 않는다

| 구분 | `AgentTaskSession` | 미래 `TerminalSession` |
|---|---|---|
| 목적 | prompt를 목표 작업으로 실행하고 상태·결과를 관리 | 사람이 로컬 CLI를 직접 조작·진단 |
| 데이터 | bounded semantic event와 cursor | PTY byte stream, 키 입력, resize |
| 상태 | accepted/running/waiting/terminal | 연결됨/종료됨 등 터미널 생명주기 |
| 내구성 | intent와 event journal을 재시작 후 복원 | 기본적으로 로컬·일시적 |
| 원격 허용 | 향후 명시적 `tasks-v1` scope에서만 | 허용하지 않음 |

`AgentTaskSession`은 현재 코드의 논리적 작업 단위이며 별도 공개 class 이름을 뜻하지 않는다. 기존 Orca 터미널과 향후 로컬 PTY 탭은 `TerminalSession` 계열의 고급·진단 surface다. PTY를 task event로 포장하거나 두 세션의 저장소·API·권한을 공유하지 않는다.

지속형 `ConversationSession`도 PTY와 합치지 않는다. 앱-native conversation이 공개 identity와 상태의
정본이고, 외부 터미널이 정확히 같은 provider thread를 열 수 있게 될 경우에도
`app_idle → handoff_preparing → external_controlled → reconciling → app_idle | unknown`의 단일 소유권
lease를 거친다. 상세 불변 조건과 선택지 판정은
[`agent-runtime-conversation-ux.md`](./agent-runtime-conversation-ux.md)의 “같은 대화를 터미널로 넘기는
상태 모델”을 따른다. 현재 cmux·Orca·iTerm·Terminal 버튼은 독립 CLI launcher이며 같은 session handoff로
표시하지 않는다.

## V1 구성 요소와 책임

| 구성 요소 | 정본 | 책임 |
|---|---|---|
| Adapter registry | `src/agentRuntimeRegistry.ts` | 단계적 순서 `codex`, `claude`, `hermes`, `agy`의 stable ID, transport, memory/prompt integration 가능성, 안전 정책을 선언한다. Registry 등록은 live availability 보장이 아니다. |
| Task protocol | `src/agentRuntimeProtocol.ts` | `agentstoz-tasks-v2`, start request, status, exact `AgentTaskEvent` union, 크기 제한, 원격 금지 키를 정의한다. Adapter는 `{type, payload}` draft만 만들고 journal이 envelope를 붙인다. |
| API contract | `src/agentRuntimeApiContract.ts` | capability·path-free target·task summary·cursor event·start/cancel 응답을 exact DTO로 재검증한다. `available`, `unavailable`, `unknown`을 구분한다. |
| Target inventory | `src/agentRuntimeTargetInventory.ts` | 등록 프로젝트·폴더와 현재 Git porcelain을 결합한다. 연결 워크트리는 경로를 포함하지 않는 결정적 opaque ID로 투영하고, 실행 직전에 서버가 다시 해석한다. |
| Durable journal | `src/agentRuntimeTaskJournal.ts` | SQLite에 create intent와 `task.accepted`를 spawn 전에 원자 기록하고, `requestId` 멱등성 및 task별 단조 증가 `seq`를 보장한다. |
| Process guard registry | `src/agentRuntimeGuardRegistry.ts` | provider spawn 전 `reserved`, guard가 PGID leader임을 증명한 뒤 `active`를 FULL-durable SQLite에 기록한다. `ESRCH`는 등록 PGID의 소멸만 증명하며 detached/`setsid` 자손 부재를 증명하지 않는다. |
| Workspace lease | `src/workspaceLease.ts` | canonical directory와 Git common-dir을 함께 잠가 메인 checkout과 linked worktree의 협조적 writer를 직렬화한다. strong containment 전 production dead-owner recovery는 `manual`이다. |
| Containment registry | `src/agentRuntimeContainmentRegistry.ts` | OS resource 생성 전 private identity와 image/policy/kernel/broker TCB digest를 FULL-durable 예약하고, staging seal과 모든 lifecycle edge를 CAS+append-only audit로 기록한다. 공개 DTO에는 네 필드 상태만 투영한다. |
| Staging builder/result | `src/agentRuntimeStagingBuilder.ts`, `src/agentRuntimeStagingResult.ts` | 검증된 Git blob manifest로 제어 파일 없는 disposable tree를 만들고, 종료 뒤 regular-file/write/delete allowlist 결과만 산출한다. macOS production은 별도 UID와 native fd-relative mount 직전 재검증이 추가로 필요하다. |
| Apple Container policy | `src/appleContainerCommandPlan.ts`, `src/appleContainerExecutionPolicy.ts` | shell 없는 fixed `create → full stopped inspect → start → full running inspect`와 exact cleanup을 만들고, argv·OCI init process·kernel·broker TCB를 하나의 state-independent digest로 묶는다. |
| macOS privilege boundary | `src/macOSRuntimeBrokerSigning.ts`, `src-tauri/native/macos-runtime`, `docs/agent-runtime-macos-broker.md` | static signing snapshot과 native fixture는 모두 `authoritative:false`, `reusable:false`, `ready:false`다. Tauri main에만 링크된 Objective-C bridge가 SMAppService와 mutual-pinned XPC를 소유하고, Swift root broker는 exact 32-byte challenge만 받는 probe, OpenDirectory 전용 계정 provisioner, dedicated-UID fixture를 제공한다. `_agentstoz`/Background user-domain worker, collision-safe account/manifest rollback, fixed launchctl coordinator와 digest-verified development bundle stage는 구현됐지만 checked-in Team ID가 `nil`이고 Developer ID inside-out 서명·실제 계정 생성/재부팅 검증·관리자 승인·설치본 실행 증거가 없어 모든 개발 호출은 ServiceManagement 전에 닫힌다. 실제 권한은 fresh TCB와 crash/reboot/escape reconciliation gate까지 통과한 뒤에만 열린다. |
| Readiness diagnostic | `src/agentRuntimeReadinessContract.ts`, `src/agentRuntimeReadinessProbe.ts` | 운영 실행 정책, host platform, compile-time Team pin, embedded broker 정적 서명, SMAppService, 전용 UID, detached-descendant canary를 path-free fixed reason으로 보여준다. 응답은 literal `authoritative:false`, `reusable:false`, `ready:false`라 capability나 TCB 입력으로 쓸 수 없다. |
| Codex adapter | `src/codexAgentRuntime.ts` | 검증된 로컬 Codex executable을 shell 없이 `app-server` stdio로 실행하고 provider 알림을 non-terminal progress/artifact draft로 축약한다. `thread/start`와 `turn/start`의 검증된 ID는 다음 단계 전에 내부 journal에 결속한다. Terminal event는 supervisor만 기록한다. |
| Persistent conversation foundation | `src/agentRuntimeConversationProtocol.ts`, `src/agentRuntimeConversationJournal.ts`, `src/agentRuntimeConversationService.ts` | task-v2와 분리된 v1 conversation ID/revision/보관 동의 계약, provider ID private binding, prompt/transcript 비복제 SQLite, `ephemeral:false` start와 exact resume, restart unknown reconciliation, replay-safe create/continue, 비동기 live-control-ready start, path-free event cursor와 bounded history의 기반이다. journal schema v5는 raw provider 알림 대신 정제된 progress/artifact summary만 저장하며 turn당 128개·대화당 최근 512개로 제한한다. continue와 steer/interrupt는 request ID 외에 conversation revision을 유일 실행 슬롯으로 고정해 모바일이 새 ID로 재전송해도 같은 의도를 두 번 실행하지 않으며, receipt는 sidecar 재시작 뒤에도 유지된다. 재시작 때 exact current revision의 `prepared` turn/lifecycle receipt도 `unknown`으로 승격해 목록과 실행 잠금이 어긋나지 않는다. 아직 구현되지 않은 adapter는 target/journal/provider 경계 전에 거부하고, 저장 adapter와 provider가 다른 대화 조작도 fail-closed한다. archive/unarchive/delete는 provider 호출 전 lifecycle receipt를 영속화하고 응답 경계 실패 시 `indeterminate`/`unknown`으로 잠가 자동 재실행을 막는다. archive/delete의 fresh provider reconciliation과 설치본 E2E가 남아 있어 containment와 mutation capability는 계속 닫아 둔다. 메타데이터 API는 사용할 수 있지만 containment gate가 닫힌 동안 provider 실행은 열지 않는다. |
| Conversation API/UI | `src/agentRuntimeConversationApiContract.ts`, `src/agentRuntimeConversationHistory.ts`, `src/agentRuntimeClient.ts`, `src/AgentRuntimeConversationView.tsx` | browser-safe exact history DTO, local/Tauri routes, 대화 목록·생성·이어가기·steer·interrupt·보관과 데스크톱 3열/모바일 본문 우선 UI를 제공한다. 진행·계획·diff/test 산출물 요약은 수명주기 상태와 분리된 semantic card로 재생된다. 서버용 Codex process module은 renderer bundle에 들어가지 않으며 Vite production build로 검증한다. |
| Conversation UX decision | `docs/agent-runtime-conversation-ux.md` | raw terminal 미러링이 아닌 app-native structured conversation을 기본으로 하고, cmux·Orca·iTerm·provider 앱은 보조 handoff surface로 유지한다. |
| Runtime supervisor | `src/agentRuntimeSupervisor.ts` | 한 sidecar만 journal reconciliation과 task start를 소유하게 한다. production dead-owner lock은 자동 회수하지 않는다. 등록 PGID recovery는 이탈하지 않는 fixture의 restart protocol 검증에만 쓴다. |
| Local HTTP | `src/agentRuntimeHttp.ts` | 고정된 local task route만 method·query·body 제한과 함께 노출한다. 기존 host/origin gate 바깥으로 직접 공개하지 않는다. |
| Browser client | `src/agentRuntimeClient.ts` | 설치 앱에서는 별도 Tauri capability proxy를, 개발 웹에서는 same-origin Vite proxy를 사용하고 timeout, abort, 응답 byte limit, exact response 검증을 수행한다. |
| Projection | `src/agentRuntimeState.ts` | 중복 event를 멱등 처리하고 sequence gap에서 마지막 정상 cursor를 보존한다. |
| Task center UI | `src/AgentRuntimePanel.tsx` | 등록 프로젝트·폴더 및 자동 발견 Git 워크트리와 live-capable adapter 선택, 기존 프로젝트/worktree 관리 화면 이동, prompt 제출, task inbox, structured timeline, cancel을 제공한다. 알 수 없는 capability를 사용 불가로 단정하지 않는다. |
| Internet task gateway | `src/remoteControlTaskProtocol.ts`, `src/remoteControlTaskGateway.ts` | 기존 v7과 분리된 v8 `tasks-v1` exact DTO를 E2EE relay 안에서 처리한다. 세션 control ID를 fresh registered target과 Agent Runtime inventory의 canonical directory identity(dev/inode 포함)로 다시 결합하며 로컬 path/runtime target ID를 투영하지 않는다. |
| Internet conversation gateway | `src/remoteControlConversationProtocol.ts`, `src/remoteControlConversationGateway.ts` | `tasks-v1`과 분리된 `conversations-v1` 권한으로 bounded history, start/continue/steer/interrupt/archive를 처리한다. provider/local target ID와 path를 원격 DTO에 포함하지 않는다. |
| Mobile leadership console | `src/remote-control-portal-main.tsx` | 선택한 Mac별로 프로젝트·워크트리/모델, task inbox와 앱형 지속 대화/기록/composer 상태를 각각 분리 보존한다. 작은 터미널 미러링 없이 기존 다중 Mac 전환과 v7 프로젝트 제어를 유지한다. |

### Codex App/Remote 벤치마크와 지속형 대화 방향

공식 Codex App Server는 rich client용 정본 인터페이스로 `thread/list`, `thread/read`,
`thread/resume`, `thread/fork`, `turn/start`, `turn/steer`, `turn/interrupt`, approval 및 streamed
event를 제공한다. 공식 Remote UX도 새 대화 시작뿐 아니라 기존 대화 계속하기, 실행 중 steer,
승인, diff·test 검토, host/chat 전환을 기준으로 한다. AgentsToZ도 이 의미 모델을 벤치마크하되
App Server WebSocket을 공용 인터넷에 직접 노출하지 않고 현재 E2EE relay의 bounded semantic DTO와
host-side policy gateway만 외부에 둔다.

공식 App Server의 remote terminal UI(`codex --remote`)는 내장 PTY를 만들지 않고도 선택한 외부
터미널에 TUI를 제공할 수 있는 후속 benchmark다. 현재 adapter는 turn마다 fresh stdio App Server를
생성하므로 아직 공유 listener가 아니다. production unsupported인 WebSocket을 모바일에 직접 노출하지
않고, 설치본 containment 승격 뒤 localhost/Unix socket에서 단일 active-turn ownership과 재접속을
먼저 검증한 경우에만 보조 handoff capability로 추가한다.

- 현재 task는 고의로 `ephemeral: true`인 한 turn이다. provider raw transcript를 남기면서도 이를
  조회·보관·삭제할 제품 surface가 아직 없기 때문이다.
- 지속형 대화는 task ID를 thread ID로 재해석하지 않는다. 별도 opaque conversation ID가 로컬의
  provider thread binding, 등록 target identity, adapter/model, 보존·삭제 상태를 가리킨다.
- 새 turn은 `thread/resume` 뒤 `turn/start`, 실행 중 추가 지시는 exact active turn correlation을 가진
  `turn/steer`, 취소는 `turn/interrupt`를 사용한다. provider thread/turn ID와 local path는 원격에
  노출하지 않는다.
- conversation v1은 생성 시 exact `retain-provider-history-on-this-host` 동의를 요구한다. SQLite는
  provider thread/turn binding과 public revision만 저장하며 prompt/transcript를 복제하지 않는다.
  새 대화의 `thread/start(ephemeral:false)`, 기존 대화의 exact-ID `thread/resume`, transcript 없는
  `thread/read(includeTurns:false)` 상태 reconciliation, archive/unarchive/delete+tombstone,
  exact active-turn steer/interrupt와 request replay fence, live-control-ready 비동기 start,
  continued-turn receipt, durable semantic event cursor와 bounded/redacted history reader가 구현됐다.
  앱-native history UI, local API/Tauri proxy, 별도 E2EE `conversations-v1` 승인과 host별 모바일 UI까지
  구현했다. 설치본 containment 검증이 완성되기 전에는 실제 provider start/resume capability를 광고하지 않는다.
- supervisor 재시작이나 transport 단절 중이던 turn은 완료/취소로 추정하지 않고 `unknown`으로
  revision을 올린다. fresh `thread/read`가 `notLoaded | idle`이며 provider ID가 일치한다고 증명한
  뒤에만 다시 idle로 전환한다.

공식 기준: [Codex App Server](https://learn.chatgpt.com/docs/app-server),
[Remote connections](https://learn.chatgpt.com/docs/remote-connections),
[Codex Remote](https://learn.chatgpt.com/docs/remote).

V1 local task API surface는 다음 일곱 종류다.

- `GET /api/agent-runtime/capabilities`
- `GET /api/agent-runtime/readiness`
- `GET /api/agent-runtime/targets`
- `GET /api/agent-runtime/tasks`
- `POST /api/agent-runtime/tasks/start`
- `GET /api/agent-runtime/tasks/:taskId/events?after=<seq>`
- `POST /api/agent-runtime/tasks/:taskId/cancel`

Additive conversation-v1 local surface는 다음 exact route만 허용한다.

- `GET /api/agent-runtime/conversations`
- `GET /api/agent-runtime/conversations/archived`
- `POST /api/agent-runtime/conversations/start`
- `POST /api/agent-runtime/conversations/:conversationId/continue`
- `GET /api/agent-runtime/conversations/:conversationId/events?after=<seq>`
- `POST /api/agent-runtime/conversations/:conversationId/history`
- `POST /api/agent-runtime/conversations/:conversationId/{steer|interrupt|archive|unarchive|delete}`

이 surface는 목록·상태를 읽을 수 있다는 사실과 provider를 실행할 수 있다는 사실을 분리한다. 실행,
history provider read, mutation은 전역 containment gate와 live runtime 확인을 통과해야 한다.

Start는 client-generated `requestId`를 사용한다. 같은 intent의 retry는 기존 task를 반환하고, 같은 `requestId`를 다른 target·adapter·execution mode·prompt에 재사용하면 충돌로 거절한다. UI는 응답 유실·reload 뒤 재시도를 위해 raw prompt가 아닌 intent SHA-256과 request ID만 24시간 로컬 저장한다. 공개 task summary에는 prompt, request ID, provider thread/turn ID가 없다. 실행 감독자만 로컬 execution record를 읽는다. 공개 `taskId`는 사용자가 복사할 수 있는 진단 ID로 쓰며, provider ID는 실패·취소·timeout이 발생해도 내부 correlation에만 남는다. 내부 ID 결속이 실패하면 turn을 계속 실행하지 않고 `CODEX_TASK_BINDING_FAILED`로 중단한다.

Journal은 다음 불변 조건을 가진다.

- Task row와 첫 `task.accepted` event는 하나의 `BEGIN IMMEDIATE` transaction에서 기록된다. 기록이 끝나기 전에는 provider를 spawn하지 않는다.
- Adapter가 sequence나 wall-clock을 선택하지 않는다. Journal이 transaction 안에서 task별 다음 `seq`를 배정한다.
- restart fixture는 이전의 **등록 PGID** 소멸 뒤 accepted/running/waiting task를 `task.failed` + `RUNTIME_RESTARTED`로 정확히 한 번 reconcile한다. 이 검증은 detached 자손 부재의 증명이 아니므로 production supervisor/workspace lock 자동 회수 근거로 쓰지 않는다.
- 오래된 terminal task만 bounded pruning할 수 있다. accepted/running/waiting/unknown task는 pruning과 삭제 대상이 아니다.
- Event 저장과 읽기 양쪽에서 shared exact union과 원격 안전 검사를 다시 적용한다.
- 한 task의 non-terminal event는 511번까지만 허용하고 512번 sequence는 종료 결과를 위해 비워 둔다. provider가 과도한 알림을 보내도 journal이 무한히 커지지 않고 실패 이유를 끝까지 기록할 수 있어야 한다.

Codex V1 adapter는 `workspace-write` sandbox와 `approvalPolicy: never`인 한 turn을 구현했지만 production capability는 현재 `unavailable`이다. Codex 0.148.0/macOS 실측에서 sandbox 내부 Node의 `spawn({ detached: true })` 자손이 PID 1 아래 새 PGID로 이탈해 provider 종료 뒤에도 허용된 workspace 파일을 계속 수정했다. 따라서 PGID guard는 lifecycle bookkeeping primitive이지 security containment boundary가 아니다. `AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED=false`를 protocol, service, verified resolver, UI start 조건에 중복 적용해 모든 새 managed task를 target/lease/runtime probe/journal mutation 전에 차단한다.

`dangerously-bypass-approvals-and-sandbox` 값은 기존 journal/history를 정확히 읽기 위해 wire union에 남아 있지만 별도 spawn 전 거절도 유지한다. 위험 모드 비활성은 필요하지만 충분하지 않으며, 일반 `workspace-write`도 OS-enforced non-escapable containment 또는 쓰기 권한을 확실히 폐기할 수 있는 single-use execution workspace와 escape 회귀 테스트가 완성될 때까지 열지 않는다. 원격 v8은 task start를 `workspace-write`로 고정하고 dangerous 값을 요청 DTO에 넣을 수 없지만, 전역 production execution gate가 닫혀 있으므로 현재 설치본은 실제 provider start를 광고하거나 실행하지 않는다.

Child argv는 배열이며 prompt와 cwd를 shell string에 보간하지 않는다. Child environment는 명시적 allowlist로 새로 구성한다. stderr는 backpressure 해소를 위해 읽되 저장하거나 event로 내보내지 않는다. Agent message는 로컬 절대 경로와 일반적인 credential 패턴을 제거한 bounded summary로만 변환한다. Provider가 승인, elicitation 또는 다른 server-initiated interaction을 요구하면 대신 응답하지 않고 fail closed한다.

MCP는 별도 `codex mcp list` 결과를 신뢰하지 않는다. 같은 app-server 연결에서 turn 전에 `config/read`를 실제 cwd로 호출하고 effective config와 모든 project/user/system layer의 MCP 이름을 수집한다. 이어지는 `thread/start.config`에서 그 이름을 전부 `enabled: false`로 덮은 뒤에만 thread를 만든다. 이름·shape·개수 또는 config/read 계약을 확인할 수 없으면 thread를 시작하지 않는다. 로컬 명령 실행에 필요한 app-server 자체 Code Mode host는 유지하지만 외부 `--code-mode-host` URL은 받거나 전달하지 않는다.

### Codex 실행 파일 identity

Managed Runtime은 기존 터미널 launcher의 경로 탐색 결과를 재사용하지 않는다. `src/codexRuntimeExecutable.ts`가 별도 공급망 경계를 소유하며 다음 순서로 하나의 native 실행 파일만 선택한다.

1. 로컬 사용자가 명시한 standalone 후보와 현재 OS 사용자의 설치 경로
2. 공식 `@openai/codex` npm launcher인 경우 package 계약을 검증한 뒤 플랫폼 package 안의 native payload로 unwrap
3. standalone 후보가 모두 없을 때만 ChatGPT/Codex 앱 번들의 native binary

후보가 존재하지만 native 형식·실행 권한·version 또는 검증 가능한 서명이 맞지 않으면 앱 번들로 조용히 바꾸지 않고 fail closed한다. macOS는 OpenAI Team ID와 `codex` identifier의 code-signing requirement를 확인한다. Linux는 동등한 플랫폼 서명 증명이 없으므로 ELF 형식·version·SHA-256만 identity에 포함하며, 이는 로컬 파일의 동일성을 증명할 뿐 배포자 진위를 새로 증명한다고 표시하지 않는다. 현재 모든 production 플랫폼은 managed execution을 광고하지 않는다. macOS는 비탈출 lifecycle boundary, Linux는 cgroup/PID namespace 적용과 legacy fallback 차단의 설치본 증거, Windows는 `KILL_ON_JOB_CLOSE` Job Object의 전체 경로 적용 및 각각의 escape E2E를 통과해야 플랫폼 capability를 열 수 있다.

내부 identity는 canonical path, source, semantic version, SHA-256, device/inode/size/mode/mtime/ctime, 가능한 경우 signing identity와 이들을 묶은 revision으로 구성한다. revision은 플랫폼·아키텍처·검사 정책으로 분리된 호환성 cache key로 사용하며 CLI update로 stat이 바뀌면 자동으로 새 identity를 만든다. 실제 task start의 `fresh` 검사는 서명·hash·version을 다시 읽는다. Sidecar의 호환성 probe/launch 검증에 더해 Codex 전용 guard protocol v2가 같은 identity를 private environment로 받고, provider에는 전달하지 않은 채 guard 내부에서 stat+SHA-256을 동기 재검증한 직후 실제 app-server를 spawn한다. 달라졌으면 provider를 열지 않으며 identity 없는 Codex guard v1도 거부한다. 검사에 쓰는 `codesign`/`codex --version` 역시 독립 process group에서 실행해 timeout·과다 출력·상속 pipe가 발생해도 해당 group에 TERM→KILL을 보내고 소멸을 확인한 뒤 반환한다. 이 executable identity는 공급망 입력 검증일 뿐 descendant containment를 대신하지 않는다.

이 identity와 executable path/hash/signature는 supervisor 내부에만 존재하며 capability, task, event, LAN/Internet DTO로 직렬화하지 않는다. 경로 재검증과 실제 OS spawn 사이의 극히 짧은 file-open 경쟁은 Node/Bun의 path 기반 spawn 한계로 남으며, 현재 단계에서는 같은 tick의 인접 검증과 변경 시 재시도로 줄인다. 향후 fd/handle 기반 검증 실행이 플랫폼에서 가능해지면 이 경계를 교체한다.

Unix에서는 API가 고정된 작은 process guard를 별도 task process group으로 시작한다. Launcher는 먼저 durable `reserved` row를 만들고, guard는 자신이 PGID leader임을 확인해 이를 `active`로 전환한 뒤에만 provider를 spawn한다. Sidecar pipe EOF, 취소, 정상 종료에서 해당 group에 TERM→KILL을 보내고 `ESRCH`를 확인한다. 이 절차는 같은 PGID에 남는 foreground/background descendant만 처리한다. Provider 또는 실행된 코드가 `setsid`, `setpgid`, daemonization, `detached:true`로 새 session/group을 만들면 일반 `workspace-write`에서도 이탈할 수 있다. 그러므로 PGID 소멸만으로 terminal success, workspace authority 회수, 다음 writer 시작을 안전하다고 주장하지 않는다. UI 경고만으로도 이 불변식을 충족할 수 없으므로 production start 자체가 차단되어 있다.

Workspace lock owner는 `guarded`와 `manual`을 구분하지만 `guarded`는 등록 PGID 확인 능력만 뜻한다. strong containment 증거가 아니므로 production Agent Runtime, POSIX Claude Remote, Git·장기기억·빌드 등 일반 mutation은 모두 `manual` recovery를 사용한다. Sidecar가 mutation 중 비정상 종료되면 lock을 자동 탈취하지 않아 중복 writer를 막는다. `guarded` 자동 회수는 이탈하지 않는 bounded fixture와 이전 owner-format migration 검증에만 남긴다.

Phase 0의 플랫폼별 containment 결정, state machine, 결과 반영 allowlist와 설치본 escape 시험은
[`docs/agent-runtime-containment.md`](./agent-runtime-containment.md)가 정본이다. macOS 첫 구현은
Apple Container의 task별 Linux VM 안에서 실제 project가 아닌 제어 파일 제외 독립 staging
checkout만 수정하고,
VM 부재를 확인한 뒤 host가 새 branch/worktree로 검증된 regular-file 변경만 반영한다.
동일 로그인 UID의 Apple service는 경계로 인정하지 않으며, macOS 권한 분리의 상세 정본은
[`docs/agent-runtime-macos-broker.md`](./agent-runtime-macos-broker.md)다.

Protocol에는 `task.question`, `task.approval.requested`, `task.approval.resolved`가 미리 정의되어 있다. 이는 wire shape를 먼저 고정한 것이며, V1에 질문 답변이나 승인 실행 경로가 있다는 뜻은 아니다.

## 보안 및 데이터 경계

Prompt는 사용자가 의도적으로 보내는 작업 입력이지만, 다음 실행 내부 정보는 desktop·LAN·Internet의 semantic task DTO에 포함하지 않는다.

- raw PTY, stdin, stdout, stderr, tool output, raw transcript
- 로컬 path, cwd, canonical/worktree path, `memoryId`
- command, executable, argv, shell, environment, environment override
- PID와 기타 process 제어 세부 정보
- token, credential, secret, API key, authorization, cookie, private key
- `CORE.md`, journal, feedback 등 raw project-memory 내용

프로젝트 장기기억은 별도 local-authoritative data plane이다. Adapter가 등록 프로젝트 안에서 기존 기억 기능을 사용할 수는 있지만, runtime task API가 기억 원문을 읽거나 원격 전송하는 새 통로가 되지 않는다. 원격에는 bounded progress, question, approval, artifact summary, result, failure만 전달할 수 있다.

대상 선택은 항상 registered-root-only다. 기본 대상은 등록 행 ID를 쓰고, 연결 워크트리는 등록된 parent와 현재 `git worktree list --porcelain` 근거에서만 opaque ID를 파생한다. `/targets`에는 경로 대신 parent ID, main/worktree 구분, branch, Git lock, worktree 지원 여부만 담긴다. PC는 launch 직전에 등록 행과 실제 project/worktree identity를 다시 검증하며, Git 탐색이 불완전하면 persisted worktree 힌트나 사라진 synthetic ID를 실행하지 않는다. Adapter availability도 registry 선언이 아니라 현재 PC의 read-only runtime probe 결과로 판정한다. `unknown`은 부재가 아니다.

## 원격 버전 정책

현재 `agentstoz-local-v7`은 기존 프로젝트·프로세스 원격제어 계약으로 동결한다. Task route나 event를 v7 DTO에 끼워 넣지 않으며, 기존 v7 pairing/session이 앱 업데이트만으로 agent 실행 권한을 얻지 않는다.

Internet 원격 Agent Runtime은 `agentstoz-local-v8` transport의 별도 `tasks-v1` scope로 구현했다. 기존 세션은 자동 승격되지 않으며 Mac의 SAS 승인 화면에서 이 모바일 기기에 작업 권한을 명시적으로 체크해야 한다. 다만 로컬 production containment gate가 닫혀 있어 end-to-end 실행은 safety hold 상태다.

지속형 대화는 같은 암호화 transport를 쓰지만 `conversations-v1`을 별도로 승인한다. `tasks-v1`만 가진
기기는 retained history나 continue/steer 권한을 얻지 않으며, 기존 승인 세션도 앱 업데이트만으로 이
권한을 얻지 않는다. 모바일 DTO는 session-scoped control ID와 bounded/filtered message만 포함한다.

- `tasks-v1`은 enable/pair/session 승인 과정에서 명시적으로 opt-in한다. 기본값은 없음이다.
- v7과 v8은 전환 기간에 공존하고, scope가 없는 session의 task 요청은 fail closed한다.
- LAN v1은 plaintext WebSocket이므로 task prompt를 허용하지 않는다. 향후 LAN v8을 추가하더라도 별도 E2EE와 semantic task DTO/cursor만 허용하며 PTY나 로컬 실행 세부 정보는 추가하지 않는다.
- Internet v8은 같은 task 의미 계층을 기존 E2EE session 안에 넣었다. Relay에는 고정 envelope metadata와 ciphertext만 보이고, host가 scope·target·execution gate를 최종 판정한다.
- downgrade, reconnect, relay resume가 권한 확대나 중복 start를 만들지 않도록 `requestId`, task cursor, session counter, revoke 상태를 함께 검증한다.
- 로컬의 `dangerously-bypass-approvals-and-sandbox` 선택은 원격 scope로 승계하지 않는다. V8 첫 버전은 이 mode를 명시적으로 거절한다. 향후에도 host OS containment proof를 먼저 통과한 뒤에만 별도 물리 승인·짧은 TTL·감사 기록을 추가 검토한다.

## 단계별 로드맵

1. **Local Codex vertical slice — V1**
   - App task center → local API/supervisor → durable journal → Codex app-server → structured timeline을 연결한다.
   - registered target 재해석, live capability, 멱등 start, cancellation, restart reconciliation, terminal retention을 검증한다.
   - 현재 adapter 기전 테스트는 통과하지만 production capability는 safety hold 상태다.
   - readiness schema v2는 Codex CLI·로그인·모델 catalog·app-server 대화 호환성 검사를
     `codex-adapter` 진단으로 별도 표시한다. 이 read-only 검사 통과는 설치/계정 문제와 containment
     문제를 구분할 뿐 실행 권한이 아니다. 2026-09-05 실제 Codex 0.148.0에서 새 대화와 동일 thread
     resume 2턴이 통과했다. Apple M5/macOS 26.5.1의 live benchmark에서 `gpt-5.6-sol/max` 한 단어
     응답은 새 retained turn 3.46초, resume turn 2.90초였고 app-server 시작부터 첫 semantic event까지는
     각각 149ms/131ms였다. 현재 총 지연의 주 병목은 provider 응답이며, 이 18ms 차이 때문에 single-writer
     위험이 있는 공유 long-lived App Server로 성급히 전환하지 않는다. `bun run benchmark:codex-conversation`
     은 temp workspace와 workspace-write/never만 사용하고 provider thread를 삭제하며 prompt·transcript·
     provider ID·경로를 receipt에 남기지 않는다.
   - `workspace-write`의 detached/`setsid` 자손이 정상 종료·취소·timeout·sidecar crash 뒤 대상 workspace에 한 바이트도 쓰지 못한다는 설치본 E2E를 통과한 뒤에만 capability를 열고 다음 단계로 간다.

2. **Questions and allow-once approval**
   - question answer와 approval decision용 exact request/response 계약을 추가한다.
   - correlation ID, expiry, replay 방지, deny/timeout 처리를 journal에 남긴다.
   - 허용 정책은 `allow-once`와 `deny`뿐이다. `allow-always`, bypass, 원격 desktop 권한 상속은 도입하지 않는다.

3. **Claude, Hermes, agy structured adapters**
   - Codex 승격 뒤 Claude stream JSON → Hermes ACP → agy stream JSON 순으로 별도 adapter를 구현한다.
   - 각 adapter가 동일한 semantic draft, cancel, timeout, redaction, live availability 계약을 통과해야 한다.
   - CLI별 검증되지 않은 conversation/memory 기능은 capability로 광고하지 않는다.

4. **Internet E2EE `agentstoz-local-v8` + opt-in `tasks-v1` — transport/UI 구현**
   - 기존 v7 surface와 분리된 capability negotiation, bounded model/task/event cursor, start/cancel을 추가했다.
   - SAS 승인별 scope consent, vault 복원, stale core token checkpoint, E2EE request/result correlation, 다중 Mac별 task UI 상태를 검증한다.
   - production local containment gate가 열린 설치본에서 실제 Codex start/cancel E2E를 최종 통과해야 완료다.

4b. **Internet E2EE `conversations-v1` — 별도 권한과 앱형 모바일 UI 구현**
   - task 권한과 분리된 승인·vault scope, exact request/result, bounded/filtered history와 host별 UI를 추가했다.
   - 활성·보관 목록 전환, 보관·복원, cursor 기반 모델/대화/history pagination을 제공하며 반복 cursor,
     catalog 교체, 중복 모델, 페이지 상한 초과는 성공으로 축약하지 않고 중단한다.
   - provider ID·로컬 path·raw tool output은 모바일 DTO로 내보내지 않는다.
   - 선택 대화의 bounded semantic event cursor를 host별로 유지하고, 앱 재진입 시 최근 retained window를
     페이지로 복원한다. 이벤트별 UTF-8 제한과 암호화 전 result envelope 전체 제한을 모두 적용한다.
   - 실제 create/continue/steer/interrupt E2E는 같은 production containment gate가 열린 설치본에서만 승격한다.
   - 휴대폰은 Mac별 sealed session과 task/conversation panel state를 독립 보관한다. 여러 Mac의 초기 복원과
     due status poll은 host별로 병렬 수행하고, 선택 Mac은 1초·백그라운드 Mac은 20초 cadence를 유지한다.
     서로 다른 Mac의 작업은 동시에 진행할 수 있지만 각 명령은 해당 Mac 카드에서 개별 확인한다. 다중 Mac
     일괄 mutation은 오조작 범위가 커 V1에 넣지 않는다.

5. **선택형 LAN E2EE v8**
   - 현재 plaintext LAN v1에는 prompt/task를 추가하지 않는다.
   - LAN task가 실제로 필요하면 인터넷 E2EE와 동일한 의미 계약을 별도 암호화 handshake 위에서만 재사용한다.

6. **Mobile project, memory, and What I Said operations**
   - Phone에서 등록 프로젝트별 worktree 생성·선택, task 배치, 기억 필요 상태, session-end 갱신, Supabase backup/restore 상태를 하나의 운영 흐름으로 보여 준다.
   - `tasks-v1`, `worktrees-v1`, `memory-ops-v1`, `what-i-said-ops-v1`은 서로 독립된 opt-in scope와 폐기 권한을 가진다. 한 scope의 승인이 다른 데이터 plane을 암묵적으로 열지 않는다.
   - 장기기억 원문과 What I Said 원문은 기본 원격 task event에 섞지 않는다. 사용자가 민감 데이터 조회를 명시적으로 허용한 세션에서만 별도 endpoint, 더 짧은 TTL, 화면 재인증, audit event를 거친다.
   - memory update·pull·restore 및 worktree 변경은 PC가 launch 직전에 등록 identity와 현재 Git/기억 상태를 다시 확인하고, 충돌이나 불명확한 결과는 성공으로 표시하지 않는다.

7. **AI leadership orchestration**
   - 신뢰 가능한 단일 task 위에 delegation graph, 우선순위, 예산, dependency, handoff, human approval, 결과 평가를 올린다.
   - Orchestrator도 임의 shell 권한을 갖지 않고 registered target과 adapter capability를 조합한다. 장기기억에는 검증된 결정·결과 요약만 기존 기억 계약을 통해 저장한다.

각 단계는 이전 단계의 failure semantics, restart behavior, installed-runtime proof가 유지될 때만 승격한다. 현재 Phase 0 containment gate가 `NO-GO`이므로 구현된 Questions/Conversation/원격 task 인터페이스도 실제 provider 실행 capability로 승격하지 않는다. 새 transport나 adapter를 추가하는 일은 기존 권한을 암묵적으로 넓히는 일이 아니다.

## 아직 포함하지 않은 기능

- 원격 또는 로컬 raw PTY terminal tab과 terminal mirroring
- 질문에 답하거나 approval을 실행하는 interactive response API
- `allow-always`, 원격 sandbox bypass, arbitrary shell/command/path 입력
- Claude, Hermes, agy의 실제 task 실행 adapter
- LAN v8 task transport
- production containment가 열린 설치본에서의 실제 Internet E2EE conversation create/continue/steer/interrupt E2E
- provider raw transcript, raw tool output, 전체 command log 저장
- project-memory 원문 조회·전송 또는 runtime 전용 기억 저장소
- 재시작 후 provider process/thread 자동 재개
- 임의 third-party CLI/plugin의 동적 설치·실행
- multi-agent delegation, autonomous scheduling, budget/policy orchestration

이 비포함 목록의 항목은 registry ID나 protocol event type이 존재한다는 이유만으로 구현 완료로 표시하지 않는다. UI는 현재 PC에서 실제로 확인된 capability와 실제 journal outcome만 보고한다.
