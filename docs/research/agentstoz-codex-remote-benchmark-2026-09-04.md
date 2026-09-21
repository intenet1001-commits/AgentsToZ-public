# AgentsToZ × Codex CLI/Remote 기술 벤치마크

조사 기준일: 2026-09-04
오픈소스 기준: OpenAI Codex `main`의 [`8e6a44b428e31f91b21edc97904fcdf4f0931ade`](https://github.com/openai/codex/tree/8e6a44b428e31f91b21edc97904fcdf4f0931ade)
판정 범위: 공식 문서, 위 커밋의 공개 소스, 현재 AgentsToZ 로컬 코드

> 이 문서는 확인된 사실과 설계 제안을 구분한다. Codex의 공개 소스에서 확인되지 않는 ChatGPT relay 내부 저장·가시성·암호화 방식은 추정하지 않는다.

> **2026-09-05 구현 후속:** 아래 “현재 AgentsToZ” 표는 조사를 시작한 9월 4일 기준선이다.
> 이후 persistent conversation journal/provider binding, create/continue/steer/interrupt/archive,
> bounded history, local 앱형 UI와 별도 E2EE `conversations-v1` 모바일 UI가 구현됐다.
> 최신 판정은 [`agent-runtime-conversation-ux.md`](../agent-runtime-conversation-ux.md)와
> [`agent-runtime-architecture.md`](../agent-runtime-architecture.md)가 정본이다. production 실행은
> 여전히 non-escapable containment 설치본 gate 전까지 비활성이다.

> **2026-09-05 terminal surface 후속:** 로컬 설치본 `codex-cli 0.148.0`과 공식 App Server 문서에서
> `codex app-server --listen ws://127.0.0.1:4500` 및 `codex --remote <ws/wss/unix>`를 확인했다.
> 이는 AgentsToZ가 PTY를 직접 내장하지 않고도 공식 Codex TUI를 보조 client로 붙일 수 있다는 기술적
> 근거다. 그러나 공식 문서는 App Server command/WebSocket transport를 experimental이며 production
> unsupported라고 명시한다. 따라서 현재 제품 결정은 **앱-native 대화가 정본, 외부 terminal은 독립
> launcher, 동일 세션 handoff는 local-only 연구 트랙**이다. 소유권 상태기계는
> [`agent-runtime-conversation-ux.md`](../agent-runtime-conversation-ux.md)에 고정했다.
> 최신 공개 test-client와 0.147 계열 호환성 사례에서는 같은 thread의 별도 writer가 충돌할 수 있음도
> 확인했다. 따라서 shared thread를 두 UI가 동시에 쓰게 하지 않고, 한 surface에서 다른 surface로
> 명시적으로 소유권을 넘긴 뒤 provider 상태를 재확인한다.

> **2026-09-05 Codex 0.148.0 재검증:** 현재 설치된 CLI는 `codex remote-control
> start|stop|pair --json`, `codex app-server daemon bootstrap|start|restart`, `codex app-server
> proxy`, `--remote-auth-token-env`를 노출한다. App Server도 loopback WebSocket 외에
> `unix://PATH`, capability-token, signed bearer token 인증을 지원한다. 이는 Codex 전용
> 원격·TUI 인계를 실험할 때 유용한 참조 구현이지만 AgentsToZ의 정본 transport가
> 될 수는 없다. 전체 app-server command·WebSocket 생명주기가 아직 experimental/production
> unsupported이고, Claude·Hermes·agy와 공유할 host/worktree/memory/audit 계약을 제공하지
> 않기 때문이다. 따라서 이 기능은 로컬 Codex terminal handoff의 참고·선택형 bridge로만
> 평가하고, 모바일은 계속 AgentsToZ E2EE semantic gateway를 사용한다.

## 1. 결론

구현 가능하다. 그리고 목표는 단순히 “AgentsToZ에서 여러 CLI를 실행한다”보다 한 단계 위로 정의하는 편이 맞다.

**AgentsToZ는 Codex·Claude·Hermes·agy를 직접 대체하는 에이전트 엔진이 아니라, 여러 실행기와 여러 단말을 하나의 프로젝트·워크트리·대화·기억·정책 체계로 지휘하는 provider-neutral control plane이 되어야 한다.**

Codex에서 가져와야 할 핵심은 다음 네 가지다.

1. `Thread → Turn → Item` 기반의 지속형 대화와 구조화된 실행 이벤트
2. 실행 중 steering·interrupt, 질문·승인, diff·테스트·터미널을 포함한 검토 경험
3. 프로젝트와 Git worktree를 대화의 실행 장소로 다루는 모델
4. controller가 작은 원격 데스크톱을 조작하지 않고 host의 대화를 곧바로 시작·전환·이어가는 Remote UX

AgentsToZ가 더해야 할 차별점은 다음 네 가지다.

1. Codex에 종속되지 않는 공통 대화·승인·artifact 계약
2. 프로젝트 로컬 정본 장기기억과 별도의 암호화된 “내가 한 말” 원장
3. 여러 Mac·Windows·Linux/AWS host와 여러 provider 사이의 명시적 handoff
4. 목표·의존성·예산·승인·평가·기억 정리를 통합하는 AI 리더십 계층

따라서 **바로 다음 단계는 Remote UI나 지속 대화 확대가 아니라 비탈출 lifecycle containment**다. OS가 강제하는 process container 또는 writer 권한을 종료 시 확실히 폐기할 수 있는 single-use 격리 workspace를 만들고, detached/`setsid` 회귀 테스트를 통과해야 한다. 그 뒤 `Local Codex Conversations v1`으로 일회성 thread를 승격하고 동일 이벤트 계약을 E2EE Internet relay에 투영한다.

## 2. 해결하려는 문제

사용자의 목표를 제품 문제로 바꾸면 다음과 같다.

### 2.1 현재 도구들이 분리하는 것을 하나로 묶는다

- CLI마다 대화 방식, 세션 ID, 모델, 승인, 출력 형식이 다르다.
- 프로젝트와 worktree는 Git에 있고, 대화는 provider 저장소에 있으며, 장기기억과 사용자 발언은 또 다른 저장소에 있다.
- 같은 프로젝트를 여러 단말에서 이어갈 때 “어느 host, 어느 worktree, 어느 대화가 현재 정본인가”가 흐려진다.
- 원격 제품이 PC 화면을 축소해 보여주는 방식이면 모바일에서 판단과 지휘가 느리다.

AgentsToZ가 해결해야 하는 것은 **CLI 실행 자체보다 실행 문맥의 단절**이다.

### 2.2 모바일을 원격 데스크톱이 아닌 지휘 화면으로 만든다

Codex Remote의 제품 단위는 PC 화면이 아니라 `host → project → chat`이다. 휴대폰에서 대화를 시작하거나 이어가고, 진행을 steering하고, 승인을 처리하고, diff와 테스트를 검토한다. 실제 파일·셸·credential·MCP·skills·브라우저는 host가 제공한다. [Codex Remote](https://learn.chatgpt.com/docs/remote), [Remote connections](https://learn.chatgpt.com/docs/remote-connections)

AgentsToZ의 모바일도 다음 질문에 한두 번의 탭으로 답해야 한다.

- 지금 어느 단말에서 무엇이 실행 중인가?
- 어느 프로젝트와 worktree를 변경하고 있는가?
- AI가 무엇을 했고 무엇을 기다리는가?
- 내가 승인하거나 방향을 바꿔야 하는가?
- 이 대화를 다른 단말·worktree·provider로 넘겨도 안전한가?

### 2.3 에이전트 실행을 리더십 시스템으로 승격한다

세계 최고 수준의 기준은 “CLI N개를 등록했다”가 아니다. 아래가 함께 작동해야 한다.

- 목표와 성공 조건
- 작업 분해와 의존성
- 실행 host·provider·model 선택
- worktree 격리와 충돌 예방
- 진행·비용·시간·위험 상태
- 사람 승인과 감사 이력
- 결과 검증과 실패 복구
- 세션 종료 후 장기기억 정리

## 3. 현재 AgentsToZ의 확인된 기준선

현재 adapter 구현은 데모용 가짜 실행이 아니다. `src/codexAgentRuntime.ts`는 Codex `app-server`를 stdio JSONL RPC로 실제 실행하고, 모델 카탈로그를 조회하고, `thread/start`와 `turn/start`를 호출한다. 다만 production capability는 아래 containment blocker 때문에 safety hold 상태다.

이 절의 “현재”는 2026-09-04 조사 시작 시점이다. 당시에는 **작업 실행기**였고 아직
**지속형 대화 런타임**은 아니었다. 위 후속 메모에 적힌 기능은 다음 날 구현됐다.

| 항목 | 현재 판정 | 코드 근거 |
|---|---|---|
| 실제 Codex 실행 | 기전 구현·production 비활성 | `src/codexAgentRuntime.ts`, `AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED=false` |
| 모델 동적 조회 | 기전 구현·production 비활성 | verified resolver와 service capability gate |
| 작업 이벤트·취소 | 등록 PGID 범위 구현 | provider event 정규화, task journal, 같은 PGID TERM→KILL/ESRCH |
| 지속형 대화 | 9월 4일 기준 미구현, 9월 5일 구현 | retained provider binding, continue/steer/interrupt/archive와 bounded history를 별도 conversation 계층에 추가 |
| Codex 외 adapter | 미구현 | registry에는 있으나 Codex 외 모두 `unavailable` (`src/agentRuntimeService.ts:496-508`) |
| 질문·승인 UI | 미구현 | capability가 `questions:false`, `approvals:false` |
| worktree 안전 기반 | containment 구성요소 구현·설치 E2E 미충족 | target 재해석/lease, disposable staging, 결과 allowlist, durable containment registry와 Apple VM command policy는 있으나 별도-UID broker E2E 전 |
| 원격 Agent Runtime | 9월 4일 기준 계약, 9월 5일 E2EE 작업·대화 UI 연결 | `tasks-v1`와 별도 `conversations-v1`; production execution safety hold는 유지 |
| 기존 원격제어 | 구현 | v7의 프로젝트·worktree·process·Git 동작과 다중 host 기반 |
| Agent prompt 원격 전송 | 미구현 | v8 wiring 전이며 LAN prompt 전송은 의도적으로 금지 |
| 프로젝트 장기기억 | 별도 구현 | project-local memory와 revision/backup 체계 존재 |
| “내가 한 말” 연동 | 미구현 | 저장 체계는 있으나 AgentRuntimePanel 대화 흐름과 연결되지 않음 |

사용자가 본 `CODEX_TASK_FAILED`는 “Codex가 전혀 실행되지 않는다”는 뜻과 같지 않다. 현재 코드는 알려진 `codexErrorInfo`만 안전한 오류 코드로 변환하고, 분류되지 않은 provider·protocol·stream·구현 예외는 일반화한다(`src/codexAgentRuntime.ts:744-756`). 따라서 **이 코드 하나로 원인을 확정할 수 없으며, 안전하게 분류되지 않은 실패였다는 사실만 알 수 있다.** task journal과 로컬 진단 로그를 확인해야 app-server protocol/version 불일치, 조기 stream 종료, provider 오류, 구현 결함 등을 구분할 수 있다. 다음 단계에서는 민감한 원문을 노출하지 않으면서도 `Unauthorized`, `UsageLimitExceeded`, `SandboxError`, 연결 끊김, protocol 불일치를 구분해야 한다. Codex App Server도 이 구조화 오류 분류를 공식 제공한다. [App Server errors](https://learn.chatgpt.com/docs/app-server#errors)

## 4. Codex 대비 벤치마크 표

표의 `부분`은 기반 또는 일부 코드가 있지만 사용자가 끝까지 쓸 수 있는 제품 흐름이 아직 없다는 뜻이다.

| 벤치마크 축 | Codex CLI/App/Remote | 현재 AgentsToZ | 목표 판정 |
|---|---|---|---|
| 엔진 통합 | app-server 양방향 RPC | 실제 Codex app-server 사용 | 유지, versioned adapter로 격리 |
| 지속 세션 | start/resume/fork/list/read/archive | 일회성 ephemeral thread | 가장 먼저 구현 |
| 대화 모델 | Thread → Turn → Item | Task → Event 중심 | provider-neutral Conversation 모델 추가 |
| 실시간 제어 | follow-up, steer, interrupt | cancel 중심 | steering과 다음 turn queue 분리 |
| 승인·질문 | server-initiated request | 미구현 | 일급 도메인 객체로 구현 |
| 결과 검토 | 답변·diff·파일·test·terminal·screenshot | 텍스트/진행 일부 | 구조화 artifact 카드 |
| 모델 선택 | runtime capability 조회 | Codex 동적 조회 구현 | 공통 capability negotiation |
| worktree 병렬성 | chat별 worktree, Local handoff | 관리 기반은 있으나 chat binding 없음 | 대화와 정확한 worktree를 결속 |
| 단말 전환 | host/chat 전환 | host 제어 기반만 존재 | `host → project → worktree → conversation` |
| host handoff | chat과 Git 상태 이동 | 미구현 | 안전한 segment handoff 구현 |
| reconnect | 검토한 OSS host transport에 seq/ACK/cursor/replay | 기존 E2EE relay, task wiring 없음 | durable replay와 정확한 gap 처리 |
| 원격 보안 | secure relay; 공개 문서상 E2EE 세부 미기재 | P-256 ECDH + AES-256-GCM 구현 | 앱 계층 E2EE를 검증 가능한 강점으로 유지 |
| 기억 | Codex 로컬 memory 별도 제공 | project memory와 What I Said 별도 존재 | 계층 분리 후 bounded recall 연동 |
| 다중 provider | Codex 중심 | registry만 존재 | Codex 이후 Claude/Hermes/agy |
| 리더십 | goal·queue·multi-agent 일부 | 통합 계층 미구현 | 목표·의존성·예산·평가 control plane |

## 5. Codex 오픈소스에서 차용할 기술

### 5.1 rich client는 `codex exec`보다 app-server가 맞다

`codex exec --json`은 CI와 일회성 자동화에 적합하고 JSONL 이벤트와 session resume도 제공한다. 그러나 모바일 follow-up, 실행 중 steering, server-initiated approval, 여러 대화의 동시 구독에는 app-server가 더 적합하다. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [App Server](https://learn.chatgpt.com/docs/app-server)

권장 분리:

- 대화형 로컬/원격 런타임: app-server adapter
- CI·batch·복구 fallback: `codex exec --json`
- provider가 rich protocol을 제공하지 않을 때: CLI JSON/stream parser adapter

### 5.2 안정 subset과 버전 고정을 함께 사용한다

App Server는 실행한 Codex 버전에 정확히 맞는 TypeScript/JSON Schema를 생성한다. 동시에 app-server 프로세스와 WebSocket transport 자체는 아직 experimental/unsupported로 문서화되어 있다. [Schema generation and transport](https://learn.chatgpt.com/docs/app-server#message-schema)

그러므로 AgentsToZ는 다음을 가져야 한다.

- 지원 Codex 버전 범위
- 버전별 생성 schema snapshot
- 시작 시 binary/version probe
- `initialize` capability 협상
- stable subset allowlist
- contract test 실패 시 fail-closed
- 새 Codex 버전에서 조용히 필드를 무시하지 않는 strict decoder

MVP가 experimental method에 의존하면 안 된다. 필요한 기능이 experimental뿐이면 AgentsToZ 공통 계층에 자체 구현하고, 안정화 후 adapter 최적화로 연결한다.

### 5.3 `Thread → Turn → Item`을 공통 언어로 삼는다

App Server는 새 대화, 재개, 분기, 검색·목록, 보관, steering, interrupt와 item stream을 제공한다. 지속 thread 예시는 `ephemeral:false`이며, steering은 `expectedTurnId` 일치를 요구한다. [App Server thread lifecycle](https://learn.chatgpt.com/docs/app-server#threads), [turn steering](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)

AgentsToZ 공통 모델은 provider 이름을 제거한 아래 구조가 적합하다.

```text
Conversation
  └─ RuntimeSegment(provider + host + workspace + nativeThreadId)
       └─ Turn
            ├─ MessageItem
            ├─ CommandItem
            ├─ FileChangeItem / DiffArtifact
            ├─ TestArtifact
            ├─ Question
            ├─ ApprovalRequest
            ├─ AgentActivity / Delegation
            └─ Error
```

`providerThreadId`는 사용자용 정본 ID가 아니라 private binding이다. 사용자가 보는 `conversationId`는 provider나 host가 바뀌어도 유지하고, 실행 장소가 바뀔 때 새 `RuntimeSegment`를 만든다.

### 5.4 이벤트는 reducer로 보여주고 정본으로 재수화한다

Codex event stream은 delta가 먼저 오고 `item/completed`가 최종 item이 된다. 하위 agent의 늦은 완료처럼 부모 turn 완료 이후 도착할 수 있는 event도 있다. 공개 app-server notification에는 모든 상황을 복구하는 durable cursor 보장이 없다. [Codex app-server lifecycle source](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/app-server/README.md#L1854-L1905)

권장 수신 규칙:

1. provider event를 strict decode한다.
2. host 최초 수신 시 `journalEventId`, `providerConnectionEpoch`, 단조 증가 journal sequence를 부여한다. provider가 stable event ID를 줄 때만 보조 correlation으로 사용한다.
3. AgentsToZ durable event journal에 append한 뒤 UI에 broadcast한다. relay 재전송은 `journalEventId`와 sequence로 idempotent 처리한다.
4. provider delta를 내용 hash로 중복 제거하지 않는다. delta는 순서가 중요한 임시 projection이고 completed item을 정본 projection으로 삼는다.
5. provider 연결이 끊기면 임의 delta replay를 추측하지 않고 native `thread/read`와 AgentsToZ journal을 reconciliation한다.
6. late child event를 허용하되 이미 닫힌 UI를 조용히 유실하지 않는다.

### 5.5 structured error를 제품 상태로 번역한다

Codex는 context 초과, 사용량 제한, HTTP 연결 실패, stream 단절, unauthorized, sandbox 오류 등을 구분한다. 승인 요청도 `threadId`, `turnId`, `itemId`, 명령·cwd·이유·network context에 귀속된다. [Errors and approvals](https://learn.chatgpt.com/docs/app-server#errors)

AgentsToZ 오류는 최소 다음 축을 보존해야 한다.

- 사용자에게 보여줄 안전한 원인 코드
- 재시도 가능 여부와 권장 동작
- host/provider/runtime/version
- conversation/turn correlation ID
- 민감 내용을 제거한 진단 fingerprint
- 원문이 로컬 보안 로그에만 존재하는지 여부

`CODEX_TASK_FAILED` 하나로 끝내는 것은 최종 fallback이어야 한다.

### 5.6 JSONL 정본과 재생성 가능한 projection 패턴

Codex thread store는 transcript JSONL을 먼저 기록하고 SQLite를 검색·메타데이터 projection으로 활용하는 방향을 보인다. [Codex thread-store live writer](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/thread-store/src/local/live_writer.rs#L283-L346)

AgentsToZ는 Codex rollout 원문을 경쟁 정본으로 복제하지 않는 편이 낫다. 대신 cross-device UI와 감사에 필요한 공개 대화 event는 별도 암호화 ledger로 보존해야 한다.

- provider native thread: native resume에 필요한 모델 문맥과 provider 내부 상태의 정본
- AgentsToZ encrypted conversation ledger: 논리 conversation의 공개 user/assistant message, redacted structured event, segment binding, 승인·감사 이력의 정본
- 검색·모바일 UI: encrypted ledger에서 재생성 가능한 projection
- 사용자 발언 원장: What I Said가 원문을 별도 소유하고 conversation ledger는 stable reference를 가짐
- 장기 의사결정·교훈: project memory가 별도 소유

provider private reasoning, credential, raw environment, 전체 native rollout은 AgentsToZ ledger에 복제하지 않는다.

### 5.7 0.148 수명주기 응답과 uncertain outcome 한계

설치된 Codex 0.148.0에서 `codex app-server generate-ts --experimental`로 생성한 v2 계약을
현재 adapter와 다시 대조했다.

- `Thread`에는 ID·status·cwd·ephemeral 등은 있지만 `archived` boolean이 없다.
- `thread/read`는 exact thread ID를 받지만 반환 `Thread`만으로 보관 여부를 구분할 수 없다.
- `thread/list`/`thread/search`에는 `archived` 필터가 있으나 exact thread-ID filter가 아니므로,
  전체 pagination을 끝까지 읽지 않는 한 특정 ID의 부재를 권위 있게 증명하지 못한다.
- `thread/archive`와 `thread/delete` 응답은 빈 객체이며 `thread/unarchive`만 `Thread`를 반환한다.
- 동일 연결에는 archived/deleted/unarchived notification이 있지만, 바로 그 응답 경계에서 transport가
  끊긴 경우 notification도 증거로 사용할 수 없다.

따라서 provider 요청 전 durable `prepared` receipt를 남기고, 응답 경계 실패는 `indeterminate`와
AgentsToZ conversation `unknown`으로 잠그는 것이 현재 가능한 안전한 하한이다. 같은 request ID를
provider에 재전송하지 않는다. 자동 복구는 향후 Codex가 exact-ID archived/deleted 조회 또는 명시적
idempotency key를 안정 계약으로 제공할 때 승격하고, 그 전에는 host 로컬 수동 확인 흐름이 필요하다.
이 판단은 App Server transport가 아직 experimental이라는 공식 경고와도 일치한다.
[Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 6. Codex Remote에서 차용할 기술과 보완할 점

### 6.0 Codex 전용 Remote Control은 대체제가 아닌 benchmark adapter다

Codex 0.148.0의 `remote-control` 명령과 managed app-server daemon은 Codex 자체의 pairing,
재시작, Unix control socket, 외부 TUI 연결을 빠르게 제공한다. 이를 AgentsToZ의
런타임 전체로 단순 채택하면 다음 문제가 남는다.

- Codex provider만 제어하므로 다중 provider control plane이 되지 못한다.
- AgentsToZ의 opaque host·project·worktree identity와 장기기억/What I Said 권한을
  자동으로 연결하지 않는다.
- AgentsToZ의 복수 단말 E2EE session, revision fence, 승인·감사 원장의 정본이
  될 수 없다.
- 공식 문서가 app-server WebSocket을 아직 production workload에 지원하지 않는다.

그러나 local-only terminal handoff 실험에서는 직접 PTY를 재구현하는 것보다
공식 TUI + Unix socket을 우선한다. AgentsToZ는 handoff lease와 exact conversation revision을
잠그고, 외부 writer 종료 후 metadata-first `thread/read(includeTurns:false)`로 상태를
재확인한 뒤에만 제어권을 회수해야 한다.

### 6.1 벤치마크 단위는 원격 PC가 아니라 원격 대화다

공식 Remote는 host의 프로젝트와 대화를 골라 새 작업 또는 기존 대화를 이어가고, 후속 지시·steering·질문 응답·승인·diff/test/terminal/screenshot 검토·알림·host 전환을 제공한다. [Remote capabilities](https://learn.chatgpt.com/docs/remote-connections#what-you-can-do-remotely)

AgentsToZ의 모바일 첫 화면도 프로세스 버튼 목록보다 다음 구조가 우선이어야 한다.

```text
전체 단말 / 단말별 상태
  └─ 프로젝트
       └─ Main 또는 Worktree
            └─ 진행 중 / 승인 필요 / 실패 / 완료 대화
```

각 대화 카드는 provider, model, branch, 마지막 activity, 실행 host, 상태, 다음 사용자 행동을 한눈에 보여야 한다.

### 6.2 공개 Remote transport에서 검증된 복구 패턴

고정 커밋에서 검토한 공개 host-side Remote transport는 protocol v3이며 다음을 구현한다. 이는 **배포된 Codex Remote 서비스의 SLA나 영구 호환성 계약이 아니라, 해당 오픈소스 구현에서 관찰한 패턴**이다.

- controller `clientId`와 연결 세대 `streamId`
- stream별 `seqId`
- cumulative ACK와 미확인 outbound replay
- reconnect subscribe cursor
- 10초 ping, 60초 pong timeout, 최대 30초 reconnect backoff
- bounded queue와 큰 메시지 segmentation
- account enrollment와 WebSocket bearer token 분리
- controller 목록·개별 revoke

소스: [remote envelope](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/app-server-transport/src/transport/remote_control/protocol.rs#L104-L191), [reconnect and replay](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/app-server-transport/src/transport/remote_control/websocket.rs#L72-L156), [writer replay](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/app-server-transport/src/transport/remote_control/websocket.rs#L903-L1065)

이 패턴은 AgentsToZ에도 유용하지만 그대로 복제하면 부족한 부분이 있다.

| 공개 transport 관찰 | AgentsToZ 요구 |
|---|---|
| cursor·unacked buffer가 process memory 중심 | restart 후에도 이어지는 durable cursor/outbox |
| `seq <= last` 중복 제거 | 정확한 다음 seq 검증, gap이면 replay/resync |
| 전역 shared backpressure | controller별 quota + global ceiling + 공정 scheduling |
| chunk assembly 일부가 client 중심 key | controller + stream + message/seq key와 만료·byte quota |
| 원격 revoke API 중심 | relay 장애보다 우선하는 로컬 durable revoke tombstone |
| raw app-server JSON-RPC가 transport payload | provider-neutral bounded action DTO만 허용 |

### 6.3 보안 주장을 정확히 한다

공식 문서는 Remote가 secure relay를 사용해 host를 public internet에 직접 노출하지 않는다고 설명한다. 그러나 E2EE, cipher, relay가 볼 수 있는 payload, pairing/session TTL은 문서에 명시하지 않는다. [Remote host boundary](https://learn.chatgpt.com/docs/remote-connections#what-comes-from-the-connected-host)

검토한 공개 host transport는 JSON-RPC/OutgoingMessage를 JSON envelope 또는 Base64 chunk로 넣어 WSS로 전송하며, 이 transport layer에 별도의 key exchange·AEAD nonce·ciphertext 필드는 없다. [Remote protocol source](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/app-server-transport/src/transport/remote_control/protocol.rs#L104-L191)

따라서 정확한 표현은 다음과 같다.

- Codex: 공개 문서상 secure relay + TLS/WSS, application-layer E2EE 여부는 확인 불가
- AgentsToZ: 현재 P-256 ECDH/HKDF + AES-256-GCM envelope가 코드에 존재
- 제품 차별점으로 주장하려면 relay가 관찰하는 값이 ciphertext와 최소 metadata뿐임을 자동 시험해야 함

Base64 segmentation은 암호화가 아니다. 또한 relay backend나 모바일 controller의 비공개 구현까지 이 소스만으로 판단해서는 안 된다.

### 6.4 app-server를 인터넷에 직접 노출하지 않는다

App Server WebSocket transport는 experimental/unsupported이고, 공식 Remote 문서도 shared/public network에 app-server transport를 직접 노출하지 말라고 한다. [App Server transport](https://learn.chatgpt.com/docs/app-server#protocol), [Remote network exposure](https://learn.chatgpt.com/docs/remote-connections#authentication-and-network-exposure)

AgentsToZ에서는 다음 경계를 유지한다.

- app-server는 host 내부 stdio 또는 사용자 전용 local socket
- host daemon이 provider protocol을 공통 DTO로 정규화
- relay에는 allowlist된 AgentsToZ request/event만 송신
- 모바일은 provider command, 절대경로, credential, raw environment를 받지 않음
- LAN plaintext 채널에는 prompt·approval을 추가하지 않음

### 6.5 계정·단말·채널 자격을 분리한다

Codex 공개 구현은 ChatGPT 계정 인증으로 enrollment를 얻고, WebSocket에는 별도 remote-control bearer token을 쓴다. API key 인증은 Remote에서 거부된다. enrollment identity는 SQLite에 남기지만 bearer token은 재시작 시 그대로 복원하지 않는다. [Remote auth source](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/app-server-transport/src/transport/remote_control/auth.rs#L37-L79), [enrollment persistence](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/app-server-transport/src/transport/remote_control/enroll.rs#L245-L374)

AgentsToZ도 아래를 서로 대체하지 못하게 해야 한다.

- 사용자 계정 인증
- controller device identity
- host identity
- pairing artifact
- session/channel capability
- action scope
- E2EE session key

disable, logout, revoke, key rotation의 의미도 각각 분리한다.

## 7. 목표 아키텍처

```text
┌────────────────────────────────────────────────────────────┐
│ Controller clients                                         │
│ Desktop · Mobile · Web · future `agentstoz` CLI            │
│ plaintext UI → controller-side E2EE endpoint                │
└───────────────────────┬────────────────────────────────────┘
                        │ ciphertext + minimum routing metadata
┌───────────────────────▼────────────────────────────────────┐
│ Cloud relay / cloud management plane                       │
│ account/session routing · seq/ACK/replay · revoke           │
│ no prompt/command/diff/approval plaintext                   │
└───────────────────────┬────────────────────────────────────┘
                        │ ciphertext; host makes outbound link
┌───────────────────────▼────────────────────────────────────┐
│ Host daemon — host-side E2EE endpoint                       │
│ decrypt → local Control Plane                               │
│ conversation binding · policy · approval · audit            │
│ target re-resolution · event journal · runtime supervisor   │
├────────────────────────────────────────────────────────────┤
│ Codex adapter │ Claude adapter │ Hermes adapter │ agy       │
│ app-server    │ CLI protocol   │ CLI protocol   │ CLI       │
└──────────┬──────────────┬──────────────┬────────────────────┘
           │              │              │
┌──────────▼─────────────────────────────────────────────────┐
│ Local authorities                                          │
│ Git/worktrees · provider auth · project memory · What I Said│
└────────────────────────────────────────────────────────────┘
```

Cloud의 host 목록·conversation badge·approval inbox에는 최소 표시 metadata만 둘 수 있다. prompt, command, diff, approval 상세는 ciphertext여야 하며, 어떤 필드가 평문인지 protocol schema와 threat model에 열거해야 한다.

### 7.1 식별자 체계

경로 문자열을 ID로 사용하지 않는다.

| ID | 소유자 | 역할 |
|---|---|---|
| `hostId` | AgentsToZ | 실제 실행·credential·승인 정책의 단말 |
| `projectId` / `memoryId` | AgentsToZ | 사용자 프로젝트와 장기기억 계보 |
| `repositoryIdentity` | Git/GitHub 검증 | 동일 저장소 handoff 판정 |
| `workspaceId` | AgentsToZ | main 또는 특정 worktree의 stable identity |
| `runtimeProfileId` | AgentsToZ host | provider 계정·OS 사용자·Codex home·실행파일/version·정책 profile의 격리 단위 |
| `conversationId` | AgentsToZ | 사용자가 보는 논리 대화 |
| `segmentId` | AgentsToZ | 특정 provider+host+workspace에서의 실행 구간 |
| `providerThreadId` | provider adapter | native 대화 binding, 외부에 직접 노출하지 않음 |
| `turnId` / `itemId` | 공통 계층 | 실행과 UI 상태·승인 correlation |

`providerThreadId`는 반드시 `runtimeProfileId` 안에서만 해석한다. 같은 host라도 다른 OS 사용자, `CODEX_HOME`, 계정, executable/version에서 우연히 같은 ID를 resume하지 않는다.

모든 turn 직전에 등록 row, canonical path, Git common-dir, branch/HEAD, memoryId를 다시 해석하고 Workspace Lease를 획득한다. 저장된 경로를 그대로 신뢰하지 않는다.

### 7.2 runtime supervisor

권장 Codex 프로세스 모델은 host의 OS 사용자·Codex 설치/version·정책 profile별 supervised app-server다.

- stdio 연결과 단일 initialization
- readiness/version probe
- bounded concurrent turns
- crash 시 native thread를 `thread/resume`해 복구
- OS-enforced non-escapable process containment와 graceful→forced shutdown
- prompt와 secret이 argv·환경·로그에 남지 않는 규칙
- dangerous profile은 일반 worker와 분리

한 app-server가 여러 thread를 처리할 수 있지만 inherited environment는 process-wide다. 서로 다른 credential 또는 신뢰 경계가 필요하면 별도 worker로 분리해야 한다. 공개 Codex daemon은 유용한 supervisor 참고자료지만 experimental이므로 AgentsToZ가 lifecycle 정본을 소유한다. [Codex app-server-daemon](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/app-server-daemon/README.md)

기존 범용 `resolveAgentBin`은 macOS에서 ChatGPT/Codex 앱 내부의 `Contents/Resources/codex`를 user-installed 경로보다 먼저 선택했다. 앱 내부 경로는 업데이트로 바뀔 수 있는 구현 세부이며 AgentsToZ가 재배포할 수 있는 공개 계약도 아니다. Phase 0 adapter는 이 resolver와 분리해 공식 standalone 설치를 우선하고, bundled binary를 명시적 호환 fallback으로만 제한했다. canonical path·native format·version·SHA-256·macOS signing identity를 내부 revision으로 묶고 task start와 spawn 직전에 다시 검증한다. Linux의 hash/version은 동일성 근거이지 배포자 서명 근거는 아니며, identity는 어떤 공개·원격 DTO에도 포함하지 않는다. 이 공급망 경계는 구현되어 있지만 production start는 별도의 containment gate가 계속 차단한다.

## 8. Worktree와 대화 결속

Codex Worktrees는 여러 chat이 같은 프로젝트에서 서로 방해하지 않고 병렬 실행되며, repository와 worktree는 host에 남는다고 설명한다. Handoff는 Local과 Worktree 사이에서 chat과 코드를 옮긴다. [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)

AgentsToZ의 핵심 불변식은 다음이어야 한다.

1. conversation segment는 정확히 한 `workspaceId`에 결속된다.
2. `workspaceId`는 canonical path만이 아니라 Git common-dir, worktree backlink, branch/HEAD로 검증한다.
3. 일반 파일 수정 turn은 `workspaceId`별 exclusive lease와 non-escapable process containment(또는 종료 시 쓰기 권한을 폐기하는 single-use workspace)를 함께 적용해 sibling worktree끼리 병렬 실행한다. Lease만으로 비협조적 escaped writer를 막을 수는 없다.
4. worktree 생성·삭제, branch/ref 이동, merge처럼 Git 공용 metadata를 바꾸는 작업만 `repositoryIdentity`/Git-family lease를 잡는다.
5. worktree 생성과 runtime target 등록은 하나의 원자적 서비스로 수행한다.
6. 삭제·branch 전환·merge 중 해당 workspace의 대화 실행은 차단한다.
7. 앱 재시작 후에도 conversation → worktree binding을 다시 검증한다.

현재의 보수적인 Git-family lease를 모든 turn에 그대로 적용하면 sibling worktree 대화까지 직렬화된다. 목표 구현에서는 위의 계층형 lease로 좁혀 안전성과 worktree 병렬성을 함께 확보해야 한다.

### 8.1 host 간 Handoff

공식 Codex Remote는 목적지에 같은 저장소와 같은 subdirectory의 saved project가 있어야 하며, 사용자가 destination과 branch를 검토하면 worktree를 생성 또는 재사용하고 chat과 Git 상태를 옮긴다. 실행 중이면 먼저 응답을 interrupt한다. [Host-to-host Handoff](https://learn.chatgpt.com/docs/remote-connections#hand-off-a-chat-between-hosts)

AgentsToZ 권장안은 두 단계다.

#### Handoff v1 — clean state만

- 활성 turn을 먼저 interrupt하고 종료를 확인
- repository immutable identity와 relative subdirectory 일치 확인
- source branch/HEAD가 commit되고 필요 시 push됐는지 확인
- destination에 같은 repo를 검증하고 worktree 생성 또는 재사용
- memoryId와 선택 revision hash 확인
- E2EE handoff capsule 전송
- 목적지에서 새 RuntimeSegment와 native provider thread 생성
- UI에 handoff 경계를 명시

capsule에는 목표, 최근 공개 대화 요약, 미완료 항목, 검증 결과, artifact hash, memory revision reference만 포함한다. credential, 절대경로, raw environment, provider auth, 전체 What I Said 원장은 포함하지 않는다.

#### Handoff v2 — dirty state

암호화된 Git patch/bundle과 preimage hash, 충돌 preview, 적용 전 snapshot, rollback을 추가한다. clean handoff가 왕복 검증되기 전에는 시작하지 않는다.

Codex → Claude처럼 provider를 바꾸는 handoff는 native transcript 복사를 약속하면 안 된다. 동일한 논리 `conversationId` 아래 새 segment를 만들고, 검증된 요약·memory reference·Git 상태로 이어간다고 표시해야 한다.

## 9. 기억과 “내가 한 말”의 경계

Codex에도 이제 별도의 로컬 memories가 있다. `~/.codex/memories/` 아래 생성 상태를 두며 기본은 꺼져 있고, eligible 과거 chat에서 background로 요약·durable entry·recent input·evidence를 만든다. 공식 문서는 반드시 지켜야 할 규칙은 memory가 아니라 `AGENTS.md`나 checked-in 문서에 두라고 한다. [Codex Memories](https://learn.chatgpt.com/docs/customization/memories)

따라서 “Codex에는 장기기억이 없다”를 차별점으로 삼으면 안 된다. 차이는 정본과 범위다.

| 계층 | 정본 | 역할 | 자동 주입 정책 |
|---|---|---|---|
| 강제 규칙 | `AGENTS.md`, 저장소 문서 | 반드시 지킬 팀·프로젝트 규칙 | 항상, 명시적 |
| AgentsToZ 프로젝트 기억 | `.agent-memory` + revision 계보 | provider-neutral 결정·교훈·현재 상태 | bounded recall + 근거 표시 |
| provider native memory | Codex/Claude 등 각 저장소 | provider 편의와 개인화 | opt-in, 정책 가시화 |
| What I Said | 암호화된 사용자 발언 원장 | 사용자가 실제로 말한 내용의 보존·검색 | 전체 자동 주입 금지 |
| 대화 transcript | provider native + redacted projection | 현재 대화의 정확한 진행 | 해당 conversation에 한정 |

### 9.1 권장 입력 saga

로컬 저장소와 provider dispatch 사이에는 단일 원자 transaction을 만들 수 없다. 사용자가 전송을 누르면 transactional outbox 기반의 idempotent saga로 처리한다.

1. consent가 켜져 있으면 원문을 로컬 암호화 What I Said와 outbox에 먼저 commit
2. stable `clientUserMessageId`/`turnRequestId`, conversation, host/project/workspace 참조를 연결
3. project memory에서 제한된 top-k 근거를 recall
4. outbox 상태를 `pending → dispatching → confirmed | failed | unknown-dispatch`로 전이
5. provider에게 prompt와 필요한 근거만 전송하고 native thread/turn을 연결
6. 응답 유실로 수락 여부가 불명확하면 blind retry하지 않고 `thread/read`와 host journal을 먼저 reconciliation
7. 성공·실패·취소를 원장에 연결하되 사용자 발언 자체를 수정하지 않음
8. 세션 종료 시 명시적 기억 정리 후보를 제시하고 승인된 내용만 curated memory에 반영

전체 발언 원장이나 native memory를 매 turn에 무조건 넣으면 비용·privacy·오염 문제가 생긴다. retrieval 범위, 출처, revision, 사용 여부를 사용자가 확인할 수 있어야 한다.

## 10. 승인과 위험 모드

Codex 승인은 server-initiated request이며 정확한 thread/turn/item에 귀속된다. Remote에서도 host의 sandbox·security·approval 정책이 유지된다. [App Server approvals](https://learn.chatgpt.com/docs/app-server#approvals), [Remote host policy](https://learn.chatgpt.com/docs/remote-connections#what-comes-from-the-connected-host)

AgentsToZ `ApprovalRequest`는 최소 다음을 가진다.

- host, project, workspace, conversation, turn, item
- 요청 action과 안전하게 표시한 command/diff/permission
- 요청 사유와 만료시각
- 허용 가능한 정확한 decision 목록
- one-shot 또는 session-scoped 범위
- idempotency key와 최종 응답자 controller
- 감사 event와 provider resolution 결과

`dangerously-bypass-approvals-and-sandbox`는 현재 Managed Runtime에서 비활성화한다. macOS의 일반 process group은 unrestricted child의 `setsid()`/detached escape를 강제로 막지 못하므로, provider group의 종료만으로 workspace writer 전체가 사라졌다고 증명할 수 없다. wire/history 값은 호환성을 위해 보존하지만 새 작업은 spawn 전에 거절한다. 공식 문서도 이 모드는 sandbox와 approval을 모두 제거하는 elevated risk로 설명한다. [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security#run-without-approval-prompts)

위 문제는 dangerous mode에 한정되지 않는다. Codex 0.148.0/macOS의 `workspace-write` sandbox에서 Node `spawn({ detached:true })`가 PID 1 아래 새 PGID로 이탈하고 provider 종료 뒤에도 workspace marker를 계속 갱신하는 것을 재현했다. Codex Seatbelt는 child에 파일 sandbox를 상속하지만 process lifecycle container는 아니다. 따라서 현재는 일반 모드를 포함한 **모든 production managed start**를 capability, service, resolver, UI에서 fail closed한다. [Codex Seatbelt base policy](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)

특히 app-server의 `thread/shellCommand`처럼 thread sandbox를 상속하지 않는 표면은 일반 원격 API allowlist에 포함하면 안 된다.

## 11. 단계별 구현 로드맵

일정이 아니라 **통과 게이트**로 진행한다. 앞 단계의 불변식이 검증되기 전에는 다음 권한 면을 열지 않는다.

### Phase 0 — 현재 one-shot 기반 안정화

목표: 지금 있는 Codex task가 실패 이유와 workspace를 정확히 남기고 종료된다.

현재 판정: **BLOCKED / NO-GO**. Adapter·journal·등록 PGID restart fixture는 검증됐지만, 일반 `workspace-write`의 detached descendant가 same-workspace single-writer 계약을 깨는 것이 실측됐다. 이를 보완하는 disposable staging/결과 allowlist, reserve→seal containment registry, exact Apple Container create/inspect/start/cleanup planner, 설치 payload proof와 정책/TCB digest까지 구현했다. Apple Container 1.3.1 설치 identity는 실제 Mac에서 검증됐다. macOS app/broker static signing snapshot도 build-pinned Team ID, Developer ID issuer/leaf OID, exact role entitlement, thin arm64와 파일 drift를 fail-closed로 확인하지만 명시적으로 non-authoritative/non-reusable/not-ready다. production-shaped Swift broker 골격과 bounded same-UID challenge fixture도 구현·통과했지만 앱과 완전히 분리돼 있고 같은 non-authoritative/not-ready 결과만 낸다. 현재 앱은 ad-hoc·Gatekeeper rejected이고 설치된 helper가 없으며, 별도-UID Developer ID broker 등록과 공개 XPC live peer requirement/crash/escape E2E 전이므로 Production managed execution은 계속 `unavailable`이다.

- 구조화 오류 매핑 확대와 correlation ID
- 공식 standalone/user-installed Codex를 우선 선택하고 ChatGPT/Codex 앱 내부 bundled binary는 명시적 fallback으로 제한
- 선택 binary의 canonical path, hash, version, 가능한 플랫폼에서는 code-signing identity를 기록하고 앱/CLI update 뒤 다시 검증
- task journal 재시작 복구 확인
- provider spawn 전 durable guard reservation, PGID activation, 등록 group 소멸 증명
- 같은 PGID의 lifecycle fixture는 유지하되 이를 전체 process tree 증명으로 표시하지 않음
- production runtime/supervisor/workspace dead-owner lock은 strong containment 전 자동 회수하지 않음
- macOS는 `signed Tauri main → SMAppService root broker → 전용 non-login UID user-domain worker`로 로그인 UID와 Apple service namespace를 분리
- 실제 project 대신 제어 파일 없는 task staging만 VM에 RW mount하고, VM 부재 proof 뒤 bounded regular-file 결과만 새 branch/worktree에 반영
- resource 생성 전 private registry reserve, staging 준비 뒤 CAS seal, exact image/policy/kernel/broker TCB digest를 모든 감사행에 결속
- Apple 1.3.1의 exact app/install/log root, closed plugin tree, 추출 kernel과 pinned vminit/workload image를 검증
- target/worktree 재해석 실패 시 실행 전 차단
- 기존 project/process/remote 기능 회귀 방지

통과 조건:

- 성공·실패·취소·timeout·sidecar restart E2E
- 일반 fallback 전에 안전한 원인 코드가 노출됨
- `workspace-write`의 `setsid`/`setpgid`/daemon/`detached:true` 자손이 정상 종료·취소·timeout·sidecar crash 뒤 대상 workspace에 한 바이트도 쓰지 못함
- provider descendant가 남지 않고 lease가 조기 해제되지 않음
- cancellation intent 직후 sidecar crash에서도 terminal event와 `RUNTIME_RESTARTED`가 중복되지 않음
- linked worktree 작업 중 main checkout을 포함한 Git-family writer가 함께 차단됨
- 로그인 UID의 Apple service register/bootout/swap과 config/plugin/kernel 교체가 별도 namespace와 mutual code-signing 인증에서 거절됨
- 앱/sidecar/worker/broker crash와 reboot 뒤 독립 reconciler가 OS namespace 부재를 증명하기 전 다음 writer를 열지 않음

### Phase 1 — Local Codex Conversations v1

목표: AgentsToZ 안에서 Codex 앱 수준의 최소 지속 대화를 쓴다.

현재 판정: **IMPLEMENTED FOUNDATION / PRODUCTION HELD**. 별도 conversation protocol, opaque provider
binding, retained start/resume, exact revision, create/continue/live-control/lifecycle receipts, bounded
semantic event와 history, local HTTP/Tauri proxy, 앱-native 3열/모바일 본문 우선 UI까지 구현됐다.
archive/unarchive/delete는 동일 request ID뿐 아니라 `conversation + action + expectedRevision`의
동일 의도도 중복 실행하지 않는다. continue와 steer/interrupt도 `conversation + expectedRevision`을
유일 실행 슬롯으로 사용하며 receipt가 sidecar 재시작을 견딘다. create는 서로 독립된 동일 prompt를
허용해야 하므로 명시적 request ID만 멱등 키로 사용한다. 다만 Phase 0 containment가 NO-GO이고, 사용자 제목/RuntimeSegment,
provider가 보장하는 uncertain archive/delete reconciliation, 설치본 3-turn E2E는 남아 있으므로 실제
모델 capability를 열지 않는다.

`unknown`의 원인이 turn인지 archive/delete인지 구분하지 않은 일반 복구 버튼은 금지한다. Codex 0.148의
exact thread read는 idle turn은 확인할 수 있지만 archived/deleted 결과는 권위 있게 구분하지 못하므로,
turn 전용 fresh probe와 lifecycle 수동 확인 흐름을 별도 API로 설계해야 한다.

- `Conversation`, `RuntimeSegment`, `Turn`, `Item` 저장 계약
- `ephemeral:false` thread 생성
- opaque `conversationId ↔ providerThreadId` durable binding
- list/read/resume/name/archive
- `turn/start`, `turn/steer(expectedTurnId)`, `turn/interrupt`
- provider event reducer와 durable cursor
- 매 turn workspace revalidation + Workspace Lease
- app-server/version/schema capability 검사
- `runtimeProfileId`와 executable/account/Codex-home namespace 검증

통과 조건:

- 3-turn 대화가 앱·sidecar·Codex 재시작 뒤 같은 문맥으로 이어짐
- 저장한 conversation과 실제 provider thread/worktree가 불일치하면 fail-closed
- active turn에 stale steering이 들어오면 거부
- native thread가 없어졌을 때 silent 새 대화가 아니라 복구 선택지를 표시

### Phase 2 — Codex-app-grade worktree·검토·승인

목표: 대화창이 최종 텍스트 상자가 아니라 실행 검토 화면이 된다.

- message, command, diff, file, test, plan, error 카드
- 질문·approval inbox와 deep-link
- search, pin, archive, unread/needs-attention
- conversation-worktree binding UI
- worktree create와 runtime registration 원자화
- 안전한 on-request approval 정책

통과 조건:

- 큰 diff·terminal output도 pagination/backpressure에서 순서 보존
- 승인 replay·만료·다른 turn 오적용이 모두 차단
- 같은 Git family의 병렬 쓰기가 충돌하지 않음

### Phase 3 — 장기기억·What I Said 결합

목표: 대화가 기억을 사용하되 정본 경계를 흐리지 않는다.

- 전송 전 What I Said transactional outbox
- bounded project-memory recall과 provenance 카드
- 명시적 “세션 기억하기”/session-end flow
- provider native memory 사용 여부 표시
- memory revision과 conversation/segment 연결

통과 조건:

- provider 실패에도 사용자 발언 원장이 유실되지 않음
- recall된 모든 항목에 memoryId/revision/source가 존재
- transcript, native memory, curated memory, What I Said가 서로 덮어쓰지 않음

### Phase 4 — E2EE Internet Remote Conversations

목표: 모바일에서 여러 host의 대화를 Codex Remote 이상으로 편리하게 지휘한다.

현재 판정: **TRANSPORT/UI FOUNDATION IMPLEMENTED / EXECUTION HELD**. 기존 원격제어의 host switcher와
E2EE relay 안에 별도 `conversations-v1` scope, exact DTO, target authority join, 모델·대화·event·history
pagination, start/continue/steer/interrupt/archive/unarchive 화면을 구현했다. host별 선택·cursor·draft를
분리하고 lifecycle request ID를 digest receipt로 재사용한다. 서버의 revision별 유일 turn/control receipt도
새 모바일 request ID가 같은 작업을 두 번 실행하지 못하게 한다. 질문/승인, bounded diff detail,
notification deep-link와 production runtime E2E는 남아 있으며, Phase 0 gate 전에는 scope가 있어도
Codex start capability를 광고하지 않는다.

- frozen v7과 분리된 새 protocol/scope
- host/project/worktree/conversation inbox
- start/follow-up/steer/interrupt
- question/approval response
- live event replay와 notification deep-link
- diff/test/terminal artifact 조회
- per-controller stream, durable seq/ACK/cursor/outbox
- P-256/AES-GCM threat-model과 relay-observation test

통과 조건:

- 네트워크 단절·앱 재시작 후 gap을 검출·replay/resync하고 중복 event가 UI 상태에 재적용되지 않음
- relay가 허용 metadata와 ciphertext 외 prompt/command/diff를 관찰하지 못함
- revoked controller와 재사용 pairing이 즉시 거부됨
- `online`, `sleeping`, `app-offline`, `runtime-unavailable`, `auth-expired`가 구분됨
- dangerous mode, 임의 shell/path, memory-write는 원격에 없음

### Phase 5 — Host Handoff·SSH·headless

목표: Mac/Windows/AWS를 대화 실행 장소로 자연스럽게 교체한다.

- clean Git handoff v1
- broker host와 SSH execution host 분리
- repository identity/subdirectory/branch/worktree preflight
- headless `agentstozd` supervisor와 health/auth 상태
- 이후에만 dirty patch/bundle handoff v2

통과 조건:

- active turn interrupt가 확정된 뒤만 이동
- 같은 repository identity와 subdirectory만 목적지 후보
- 왕복 handoff 후 Git HEAD·branch·memory revision·대화 목표가 일치
- mismatch·dirty conflict·branch collision은 변경 전에 중단

### Phase 6 — Claude·Hermes·agy adapter

목표: 같은 UI가 provider 차이를 숨기는 것이 아니라 정확히 설명한다.

- 공통 adapter interface와 capability negotiation
- provider별 create/resume/steer/approval/artifact support 표
- unsupported 기능은 비활성화하고 이유 표시
- provider auth는 provider가 소유, AgentsToZ는 상태만 읽음
- native session이 약한 CLI는 AgentsToZ segment summary와 event journal로 보완

통과 조건:

- provider마다 최소 3-turn, cancel, restart, worktree, error E2E
- 존재하지 않는 기능을 `available`로 표시하지 않음
- 한 provider 장애가 다른 adapter supervisor를 막지 않음

### Phase 7 — AI 리더십 계층

목표: 여러 agent를 실행하는 앱에서 목표 달성을 지휘하는 인프라로 확장한다.

- Goal: 목적, 완료 조건, 상태, token/time/cost budget
- Delegation graph: parent/child, dependency, owner provider/host/worktree
- Queue: idempotent submission, 우선순위, pause/resume, fairness
- Policy: 허용 provider/model/host/action, human approval gate
- Evaluation: test/evidence/critic 결과와 완료 판정
- Memory curation: 어떤 결과를 project memory에 승격할지 제안·승인
- Audit: 누가 무엇을 지시·승인·변경·검증했는지 추적

Codex 공개 API의 Goal과 Queue는 좋은 의미론 참고자료지만 provider-specific API를 제품 정본으로 삼지 않는다. Goal은 현재 일반 API에 있고 Queue는 고정 커밋에서 experimental로 표시된다. [Codex app-server API overview](https://learn.chatgpt.com/docs/app-server#api-overview), [experimental thread queue source](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/app-server/README.md#L927-L949)

## 12. Phase 1의 정확한 첫 수직 슬라이스

다음 구현 작업은 범위를 아래로 고정하는 것이 좋다.

1. `agent_runtime_conversations`, `agent_runtime_segments`와 event projection migration
2. `AgentConversationAdapter` 공통 interface
3. Codex adapter의 create/list/read/resume/startTurn/steer/interrupt/archive
4. `ephemeral:false`와 native thread binding
5. `/api/agent-runtime/conversations/*` localhost-only API
6. 프로젝트·worktree별 대화 목록과 하나의 지속 대화 화면
7. restart/reconcile/structured-error contract tests

이 슬라이스에서는 아직 하지 않는다.

- Claude/Hermes/agy 실행
- 모바일 prompt 전송
- host handoff
- dirty Git state 이동
- cross-provider transcript 복제
- AI 자동 기억 쓰기
- 원격 dangerous mode

이렇게 제한하면 기존 포트·프로젝트·장기기억·원격제어 기능을 그대로 보존하면서 가장 큰 사용자 체감 차이인 “작업이 아니라 대화가 이어짐”을 먼저 완성할 수 있다.

## 13. 전체 제품 승인 기준

최종적으로 아래 테스트가 모두 자동화되어야 “Codex 앱과의 결합 조화”라는 목표를 달성했다고 볼 수 있다.

1. **지속성**: 여러 turn이 앱·sidecar·provider restart를 넘어 유지된다.
2. **workspace 정확성**: 모든 turn이 올바른 repo/worktree에서만 실행된다.
3. **event 완전성**: disconnect/reconnect에서 gap을 검출해 replay/resync하고, 중복 event가 사용자 상태에 중복 적용되지 않으며 stream별 causal order를 보존한다.
4. **동시 제어**: 두 controller의 steering과 next-turn queue가 결정적으로 처리된다.
5. **승인 격리**: 승인은 정확한 host/conversation/turn/item에만 적용된다.
6. **artifact 검토**: diff/test/terminal/screenshot이 bounded·paginated·redacted된다.
7. **원격 기밀성**: relay 관측 테스트가 E2EE 불변식을 증명한다.
8. **단말 상태 진실성**: sleep, offline, app 종료, CLI 부재, auth 만료를 구분한다.
9. **handoff 안전성**: repo identity, subdirectory, branch, HEAD, dirty 상태를 검증한다.
10. **버전 호환성**: provider protocol 변경 시 contract test가 실패하고 실행이 차단된다.
11. **기억 provenance**: 주입된 기억은 출처·revision·범위가 보인다.
12. **기능 정직성**: adapter가 지원하지 않는 기능은 사용할 수 있다고 표시하지 않는다.

## 14. 하지 말아야 할 것

- Codex 엔진 자체를 복제하지 않는다.
- ChatGPT 전용 Remote backend를 범용 다중-provider 전송으로 가정하지 않는다.
- raw app-server WebSocket을 LAN 또는 인터넷에 공개하지 않는다.
- 모바일에 임의 shell, 절대경로, 환경변수, credential을 전달하지 않는다.
- Codex rollout 파일을 host 사이에서 직접 복사해 지속성을 흉내 내지 않는다.
- transcript, provider memory, project memory, What I Said를 하나의 테이블로 합치지 않는다.
- `dangerously-bypass-approvals-and-sandbox`를 기억되는 기본 설정으로 만들지 않는다.
- experimental API를 핵심 데이터 정본으로 삼지 않는다.
- provider capability를 추측하거나 가짜 성공 상태를 보여주지 않는다.
- 기존 v7 원격 세션에 새 prompt 권한을 암묵적으로 부여하지 않는다.

## 15. 최종 기술 판단

현재 AgentsToZ는 출발점이 충분하다. Codex app-server adapter, 모델 조회, task journal, target 재해석, Workspace Lease, 기존 다중 host 원격제어, 프로젝트 장기기억, What I Said, Internet E2EE가 각각 존재한다. 그러나 실제 Codex execution은 구현·fixture 검증 상태일 뿐 production capability는 safety hold다.

첫 번째 부족분은 **비탈출 process/workspace containment**, 그 다음은 **하나의 지속형 Conversation 정본**이다. 두 기반이 생기면 다음이 같은 축에 정렬된다.

```text
사용자 발언
  → 대화/turn
  → 선택한 host·project·worktree
  → provider 실행과 approval
  → diff/test/artifact
  → 검증된 결과
  → 프로젝트 장기기억
  → 다음 단말·provider로 handoff
```

제품 방향은 **Go**지만 Phase 1 진입은 현재 **NO-GO**다. 구현 순서는 `비탈출 containment → 로컬 지속 대화 → worktree/승인/검토 → 기억 → E2EE 원격 → handoff → 다중 provider → 리더십`이어야 한다. Phase 0 escape gate를 통과하기 전에는 production 모델 capability나 원격 task 권한을 열지 않는다.

## 16. 출처와 한계

주요 공식 출처:

- [OpenAI Codex repository](https://github.com/openai/codex)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex Remote](https://learn.chatgpt.com/docs/remote)
- [Remote connections](https://learn.chatgpt.com/docs/remote-connections)
- [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Memories](https://learn.chatgpt.com/docs/customization/memories)

오픈소스 검증은 빠르게 변하는 `main` 대신 위의 정확한 커밋에 고정했다. Remote 모바일 client와 relay backend 전체가 공개된 것으로 간주하지 않았고, 공개 host transport에서 확인되는 범위만 기록했다.

프로젝트 기억 회상 중 원격 Pull은 10초 안에 완료되지 않았다. 이 보고서는 2026-09-03에 마지막 갱신된 프로젝트 로컬 정본 기억과 현재 workspace 코드를 기준으로 작성했으며, 원격 기억의 최신성은 주장하지 않는다.
