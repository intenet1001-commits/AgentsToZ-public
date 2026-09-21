# AgentsToZ 대화형 런타임 UX 적합성 결정

상태: **방향 확정, production capability는 containment gate 통과 전 폐쇄**
기준일: 2026-09-05

현재 macOS 실측 readiness는 UI 미구현이 아니라 실행 승격 차단이다. `host-platform`과
read-only `codex-adapter` 호환성 검사는 통과했고,
managed execution policy, production Team pin, embedded broker signing이 blocked이며 SMAppService channel,
전용 runtime identity, detached-descendant canary는 pending이다. 따라서 adapter 목록의 `unavailable`을
“대화 화면을 아직 만들지 않음”으로 해석하지 않는다.

## 결론

AgentsToZ의 기본 대화형 세션은 raw terminal/PTY를 앱 안에 복제하는 형태가 아니라,
**Codex App처럼 구조화된 앱-native 대화 화면**으로 만든다. 다만 기존 cmux·Orca·iTerm·Terminal
실행은 없애지 않고 `외부에서 열기`와 `고급 터미널` 보조 surface로 유지한다.

따라서 제품은 “제2의 Hermes 앱” 하나로 수렴하지 않는다. 더 정확한 정의는 다음과 같다.

> AgentsToZ는 여러 CLI·앱의 provider session을 동일한 프로젝트·워크트리·장기기억 문맥 아래
> 운영하는 agent control plane이며, 그 위에 공통 conversation client를 제공한다.

Codex, Claude, Hermes, agy의 고유 기능을 가장 작은 공통분모로 평준화하지 않는다. 공통 shell은
conversation/thread/turn 상태, 모델, 프로젝트, 워크트리, 작업 결과, 승인, memory 연결만 소유하고,
adapter별 추가 기능은 capability에 따라 점진적으로 노출한다.

## 두 후보의 적합성

| 기준 | 내장 터미널/PTY 중심 | 구조화된 앱-native 대화 중심 |
|---|---|---|
| 로컬 CLI 충실도 | ANSI/TUI를 거의 그대로 보일 수 있다 | adapter가 해석한 기능만 보인다 |
| 모바일 원격 조작 | 작은 PC 화면, 키보드 조합, resize, focus 때문에 불편하다 | 터치·알림·host 전환에 맞는 UI를 만들 수 있다 |
| 복수 단말 전환 | terminal/window handle이 단말마다 달라진다 | opaque conversation ID와 host ID로 안정적으로 전환한다 |
| 워크트리 결합 | 현재 cwd를 사람이 추정하기 쉽다 | 등록 target identity와 revision을 매 turn 재검증한다 |
| 진행 상태·오류 | escape sequence와 임의 문구를 parsing해야 한다 | typed event와 stable error code를 사용한다 |
| 승인·질문 | 키 입력을 원격 전달하면 replay·오입력 위험이 크다 | correlation ID·TTL·allow-once로 제한할 수 있다 |
| 접근성·검색 | 터미널 buffer에 종속된다 | semantic message, diff, test, 상태를 검색·읽기 쉽게 표시한다 |
| 장기기억 연동 | prompt 문자열에 암묵적으로 섞이기 쉽다 | memory/What I Said를 명시적 attachment와 audit로 연결한다 |
| 공급자 확장 | 모든 CLI가 화면·키 binding이 달라 유지비가 크다 | Codex App Server, Hermes ACP 등 machine protocol adapter로 분리한다 |
| 장애 복구 | tmux/process/window 생존 여부를 함께 추적해야 한다 | journal revision과 provider thread reconciliation으로 복구한다 |
| 보안 경계 | raw shell·clipboard·terminal control까지 권한이 넓어지기 쉽다 | 허용한 semantic action만 원격 capability로 내보낼 수 있다 |

raw terminal은 로컬 숙련 사용자에게 유용하지만, AgentsToZ의 핵심 목표인 모바일 원격제어,
복수 Mac 전환, 워크트리 identity, 장기기억, 감사 가능한 승인에는 기본 surface로 부적합하다.

## 현재 코드베이스와의 적합성

- React/Tauri 화면, localhost capability proxy, Bun sidecar, provider-private journal, E2EE relay가 이미
  구조화 대화의 필요한 층과 일치한다. 앱-native 방식은 현재 경계를 확장하지만 새 신뢰 경계를 만들지 않는다.
- 현재 프런트에는 xterm 계열 renderer가 없고 Rust에도 PTY 소유·resize·foreground process group을
  관리하는 dependency가 없다. 기존 `cmux | orca | iterm | terminal` 코드는 외부 앱에 정확한 작업
  폴더와 명령을 넘기는 launcher이며, 내장 PTY가 아니다.
- 내장 터미널을 정본으로 만들려면 PTY broker, ANSI renderer, 키 입력/IME/clipboard 정책, terminal
  resize, scrollback 제한, 재연결 cursor, shell escape 차단, process-tree 종료 증명을 새로 설계해야 한다.
  특히 이를 relay에 연결하면 현재 path-free fixed-action 원격 프로토콜보다 훨씬 넓은 shell 권한이 된다.
- Codex App Server의 stdio JSONL은 현재 sidecar가 소유하기 적합하고, semantic DTO만 UI와 relay에
  투영할 수 있다. 따라서 같은 개발 비용으로 모바일 사용성과 보안성이 더 높은 쪽은 앱-native다.

결론적으로 내장 터미널도 기술적으로 구현 가능하지만 별도 `고급 터미널 세션` 제품으로 취급해야 한다.
Codex structured conversation의 production 승격을 늦추면서까지 선행할 이유는 없다.

공식 App Server에는 `codex app-server --listen ...`와 `codex --remote ...`를 결합하는 remote terminal
UI 모드도 있다. 이것은 향후 보조 surface를 더 잘 만드는 근거다. AgentsToZ가 xterm/PTY를 직접
재구현하는 대신 선택한 cmux·Orca·iTerm·Terminal에서 공식 Codex TUI client를 host-private App Server
socket에 붙일 수 있다. 다만 현재 AgentsToZ adapter는 격리와 정리를 단순화하려고 **turn마다 새 stdio
App Server를 생성**한다. 동일 대화를 앱과 TUI가 동시에 소유하려면 long-lived listener, 단일 active-turn
ownership, client attach/detach, shutdown reconciliation을 별도 설계해야 한다.

또한 공식 문서는 WebSocket listener와 App Server command를 experimental/production unsupported로
표시한다. 그러므로 이 TUI handoff는 우선 localhost 또는 Unix socket 실험으로만 검증하고,
App Server WebSocket 자체를 모바일 relay나 공용 인터넷에 노출하지 않는다.

2026-09-05 Apple M5/macOS 26.5.1, Codex 0.148.0의 실제 2-turn 측정에서는 `gpt-5.6-sol/max`의
새 retained turn이 3.46초, 같은 thread resume가 2.90초였고 첫 semantic event까지의 로컬 준비 시간은
149ms/131ms였다. turn별 fresh stdio App Server가 차지하는 비용은 provider 총 응답보다 작고 resume와의
차이도 약 18ms였으므로, 성능만을 이유로 단일 writer 소유권과 crash reconciliation을 복잡하게 만드는
long-lived 공유 server를 먼저 도입하지 않는다. 측정은 `bun run benchmark:codex-conversation`으로
재현하며 temp workspace·workspace-write/never·provider thread 삭제와 비식별 receipt를 강제한다.

Codex 0.147 계열부터 공개 이슈와 test-client 시나리오에서 thread **single-writer ownership**이 실제
호환성 경계로 드러난다. 별도 app-server가 이미 열린 thread를 다시 resume하면 `already has an active
writer`로 거절될 수 있다. 이는 AgentsToZ와 외부 TUI를 동시에 writer로 두지 말아야 한다는 직접적인
근거다. 현재 turn별 stdio child는 turn 종료 때 writer를 놓는다는 장점이 있으므로, 초기 handoff는
`idle → 외부 TUI 단독 소유 → 외부 process 종료와 fresh resume/read 확인 → 앱 소유 복귀`가 long-lived
공유 listener보다 현재 구조에 더 잘 맞는다. 단, terminal 창을 열었다/닫았다는 UI 사실만으로 provider
writer의 획득·해제를 추정하지 않는다.

대형 thread에서는 전체 history를 포함한 `thread/resume` 자체가 비싸질 수 있다는 공개 재현도 있다.
따라서 handoff reconciliation은 가능하면 `excludeTurns: true`/paginated history 같은 metadata-first
경로를 사용하고, 구버전 stable subset에서 지원하지 않으면 지금처럼 bounded `thread/read`를 deadline
안에서 수행해 불명확 상태를 `unknown`으로 남긴다. 성능 timeout을 idle proof로 오인하지 않는다.

## 같은 대화를 터미널로 넘기는 상태 모델

`외부 CLI 열기`와 `같은 대화 터미널로 넘기기`는 서로 다른 기능이다. 전자는 지금처럼 선택한 폴더에서
독립 CLI를 시작한다. 후자는 AgentsToZ가 보유한 정확한 provider thread를 로컬 Codex TUI에 인계하므로,
다음 상태 전이가 모두 구현·검증되기 전에는 버튼을 광고하지 않는다.

```text
app_idle
   │ 사용자가 로컬 터미널로 넘기기 요청
   ▼
handoff_preparing ── 실패 ───────────────► app_idle
   │ target/revision/provider idle 재검증
   │ listener/socket + client attach 확인
   ▼
external_controlled
   │ 앱·모바일 continue/steer/archive/delete 거절
   │ 공개 화면에는 "외부 터미널에서 사용 중"만 표시
   ▼
reconciling
   │ terminal detach/exit 뒤 thread/read로 turn·history 확인
   ├─ 정확한 idle 확인 ──────────────────► app_idle
   └─ 종료·활성 상태 불명확 ─────────────► unknown
```

불변 조건은 다음과 같다.

- `app_idle`인 정확한 conversation revision만 handoff할 수 있다. running/unknown/archived는 거절한다.
- handoff lease는 conversation뿐 아니라 canonical worktree lease와 결합한다. 다른 대화나 task가 같은
  checkout을 동시에 쓰지 못한다.
- provider thread ID, socket 주소, 인증 material, cwd는 host-private이다. 모바일과 relay에는
  `external_controlled` 의미 상태와 공개 conversation ID만 보낸다.
- 외부 TUI가 붙은 동안 앱·모바일의 새 turn, steer, interrupt, archive, delete는 fail closed한다.
  모바일의 `중단`을 임의 키 입력이나 process kill로 번역하지 않는다.
- terminal app을 열었다는 사실만으로 handoff 성공으로 판정하지 않는다. 정확한 client attach 또는
  provider status proof가 있어야 `external_controlled`로 전이한다.
- 창 닫힘만으로 provider idle을 추정하지 않는다. detach 후 fresh `thread/read`/status reconciliation이
  끝나기 전에는 앱 제어권을 되돌리지 않는다.
- 앱 crash 뒤 남은 lease는 자동 만료만으로 회수하지 않는다. listener/process/provider 상태를 다시
  확인하고 불명확하면 `unknown`으로 둔다.
- 첫 구현은 이 Mac의 Unix socket/loopback과 선택한 로컬 터미널만 허용한다. relay가 App Server의
  WebSocket 또는 PTY bytes를 전달하지 않는다.

### 구현 선택지 판정

| 선택지 | 장점 | 치명적 제약 | 판정 |
|---|---|---|---|
| 기존 외부 CLI 독립 실행 | 단순하고 공급자 고유 UI를 그대로 사용 | AgentsToZ 대화와 별개이며 모바일 연속성이 없다 | 계속 제공 |
| `codex resume <thread>` one-shot handoff | 현재 turn별 child 구조와 맞고 한 시점에 한 writer를 강제하기 쉽다 | terminal wrapper의 attach/exit proof가 약하고 외부 turn 동기화가 사후적이다 | 초기 local-only 실험 후보 |
| long-lived App Server + `codex --remote` | 앱과 공식 TUI가 같은 writer-owning server에 client로 붙을 수 있다 | 현재 구조 전면 재설계, client별 active-turn 권한 조정, 공식 WebSocket production unsupported | 후속 연구 트랙 |
| 앱 내 xterm/PTY | 한 창 안에서 보인다 | 새 PTY 신뢰 경계·모바일 키 주입·복구 비용이 크다 | 핵심 제품에서 제외 |

따라서 1차 제품은 앱-native 대화를 완성하고 기존 독립 CLI launcher를 함께 유지한다. 같은 세션
handoff는 containment 승격 후 `codex resume`의 attach/detach 증명을 로컬에서 먼저 검증한 뒤,
공식 `--remote`의 안정성 상태가 production 사용에 맞게 바뀌었을 때 재평가한다.

## 첨부 화면에 대한 판정

- `cmux | orca | iterm | terminal` 탭은 **어디에서 CLI를 열지 선택하는 launcher/handoff**로 적합하다.
  대화 내용과 실행 상태의 정본으로 쓰면 terminal window·PTY·focus가 host마다 달라져 모바일 전환과
  재시작 복구가 깨진다.
- `Claude/Codex/Hermes 대화 열기` 버튼 묶음도 현재 의미는 외부 앱을 여는 launcher다. 이 영역만
  키워 “AgentsToZ 대화”라고 부르면 사용자는 외부 앱 실행과 자체 지속 세션을 구별할 수 없다.
- 따라서 카드의 주 동작은 `AgentsToZ에서 대화`로 두고, 공급자 앱과 터미널 선택은
  `외부에서 열기` 하위 동작으로 유지하는 편이 맞다.
- Codex는 이후 공식 `codex --remote` TUI를 같은 host-private listener에 연결하는 실험이 가능하지만,
  이것도 앱-native conversation identity 아래의 보조 client이지 세션 정본이 아니다.
- 화면의 외형은 Hermes와 비슷한 chat shell이 될 수 있지만 소유권은 다르다. Hermes 앱은 한 provider
  경험이고, AgentsToZ는 host/project/worktree/memory/provider를 함께 관리하는 상위 control plane이다.

## 화면 구조

### 데스크톱

1. **왼쪽: 운영 문맥**
   - 단말 → 프로젝트 → main/worktree → 대화 목록
   - adapter/model badge, running/waiting/unknown/archived 상태
   - 새 대화와 최근 대화 전환
2. **가운데: 대화**
   - 사용자 메시지, assistant 최종 답변, compact 진행 event
   - 실행 중 `추가 지시`와 `중단`
   - raw command/stdout 대신 파일 변경·테스트·계획의 semantic card
3. **오른쪽: 검토·운영**
   - diff, 테스트 결과, 질문/allow-once 승인
   - 현재 branch/worktree 및 dirty/ahead/behind 상태
   - 연결된 장기기억, 세션 기억하기 필요, What I Said attachment 상태

현재 최상위 `AI 런타임` 화면에서 `AgentRuntimePanel`의 “새 작업 + 작업 함 + 작업 타임라인”은 이 구조의 안전한
ephemeral-task 선행판이다. 이를 버리지 않고 내부에 `작업 | 대화` 모드를 두고, 대화 모드가 같은
target/model picker와 semantic timeline을 재사용하도록 확장한다.

### 모바일

세 칼럼을 축소한 PC 미러링으로 만들지 않는다.

1. host switcher
2. project/worktree/conversation picker
3. conversation timeline
4. 하단 composer와 `추가 지시/중단`
5. diff·tests·approval·memory는 bottom sheet

선택 host별 cursor와 draft는 분리한다. 단말을 바꾸어도 provider ID, 로컬 path, raw transcript,
token, shell command는 relay로 보내지 않는다.

## 기존 “프로젝트 대화 열기”와의 관계

현재 프로젝트 카드의 `Claude/Codex/Hermes 대화 열기`는 provider 앱이나 Orca를 여는
**launcher/handoff 기능**이다. 이것은 AgentsToZ 자체 대화 runtime이 아니다.

- launcher는 계속 제공한다: provider 고유 UI가 필요할 때 유용하다.
- 새 `AgentsToZ에서 대화`는 자체 structured session을 연다.
- 둘의 session을 이름이나 최근 시각으로 추측해 합치지 않는다.
- provider thread ID를 검증해 명시적으로 연결할 수 있을 때만 `외부 앱에서 같은 대화 열기`를
  제공한다.

## adapter 원칙

| adapter | 우선 transport | 앱-native 대화 적합성 | fallback |
|---|---|---|---|
| Codex | App Server JSON-RPC | 높음: thread/read/resume, turn/start/steer/interrupt, archive/delete | 외부 Codex 앱/Orca 열기 |
| Claude | 공식 stream JSON/remote session surface | 중간: 기능별 correlation 검증 필요 | Claude 앱/cmux/Orca 열기 |
| Hermes | ACP 또는 공식 machine protocol | 높음으로 목표하되 실제 protocol 검증 전 미광고 | Hermes 앱/Orca 열기 |
| agy | 공식 structured stream 확인 후 adapter | 미확정, 확인 전 사용 불가 | 로컬 terminal 실행만 별도 표시 |

공급자 구현 순서는 **Codex → Claude → Hermes → agy**로 고정한다. 모바일 `conversations-v1`은
의도적으로 Codex 하나만 허용하며, adapter-shaped wire contract는 다음 공급자를 검증한 뒤 버전이 있는
capability로 여는 확장 지점이다. 로컬 레지스트리에 이름이 있다는 이유만으로 원격 실행 권한을 열지 않는다.

machine protocol이 없는 CLI를 억지로 chat-compatible이라고 표시하지 않는다. 제한된 PTY adapter가
필요하면 `터미널 세션(고급)`이라는 별도 타입으로 제공하고, 모바일에는 raw key injection 대신
read-only tail 또는 매우 제한된 입력만 별도 동의 아래 검토한다.

### 2026-09-05 코드 결합도 감리

현재 구현을 provider 확장 관점에서 다시 대조한 결과는 다음과 같다.

| 층 | 현재 결합도 | 판정 |
|---|---|---|
| adapter registry/model catalog | provider-neutral, built-in ID와 capability로 선택 | 유지 |
| desktop conversation shell | adapter/model을 데이터로 렌더하고 provider ID를 직접 다루지 않음 | 유지 |
| E2EE conversation protocol/gateway | adapter-shaped이나 V1 허용값은 명시적으로 Codex 하나 | 의도한 fail-closed 경계 |
| durable conversation journal | public conversation과 private provider binding을 분리 | 다음 provider에도 재사용 |
| conversation service | `codexAgentRuntime`의 run/inspect/mutate/history 및 오류 타입에 직접 결합 | Codex V1에는 허용, 두 번째 adapter 전 반드시 추출 |
| mobile portal component | task·conversation·기존 원격제어가 한 큰 컴포넌트에 있고 Codex 문구가 V1 흐름에 직접 존재 | 두 번째 adapter 전에 panel/controller 분리 |

따라서 “registry에 Claude/Hermes 이름을 추가했다”를 확장 완료로 보지 않는다. 두 번째 structured
adapter에 착수하기 전 다음 내부 경계를 먼저 만든다.

```text
ConversationAdapter
  adapterId
  resolveModels(runtime)          // 공개 model ID → provider-private model
  startOrResumeTurn(context)      // provider IDs는 이 경계 밖으로 나오지 않음
  inspectThread(context)
  readFilteredHistory(context)
  mutateThread(context, action)
  classifyError(cause)            // aborted / indeterminate / unavailable / failed
  capability                      // steer, interrupt, archive, delete, history, question, approval
```

- service는 adapter map에서 exact ID 하나를 가져오고, 없으면 provider probe 전에 거절한다.
- adapter 결과는 공통 semantic event/history DTO를 통과한 뒤에만 journal과 UI에 들어간다.
- provider별 native ID·path·raw transcript·stderr는 adapter-private으로 유지한다.
- `classifyError`가 반영 여부를 증명하지 못하면 공통 `unknown` 상태와 durable receipt fence를 사용한다.
- capability가 없는 동작은 UI에서 숨기기만 하지 않고 service와 원격 gateway에서도 거절한다.
- 두 번째 adapter를 넣을 때 service나 portal에 `if (adapterId === 'claude')` 분기가 늘어난다면 추출이
  실패한 것으로 판정한다. provider 차이는 adapter와 capability projection 안에만 둔다.

이 분리는 지금 즉시 Codex 실행 로직을 일반화하는 작업이 아니다. 아직 한 provider밖에 없는 상태에서
가상의 공통 API를 넓히면 Codex의 실제 semantics를 잃을 수 있다. 먼저 containment를 통과한 Codex 설치본
E2E로 공통 의미를 고정하고, Claude adapter 착수 직전에 contract test를 유지한 채 위 경계를 추출한다.
Hermes/agy는 같은 계약을 통과할 수 있을 때만 structured conversation으로 승격한다.

## 제2의 Hermes 앱이 되지 않기 위한 제품 경계

AgentsToZ가 provider 로고와 `대화 열기` 버튼만 모으면 실행기 런처이자
제2의 Hermes 앱에 머문다. 상위 control plane이 되려면 다음 객체의 소유권이
분명해야 한다.

| 객체 | 소유자 | 의미 |
|---|---|---|
| provider native thread | Codex/Claude/Hermes/agy adapter | 모델 문맥과 provider 고유 실행 상태 |
| AgentsToZ conversation | AgentsToZ | host·project·worktree·provider segment를 묶는 사용자 정본 |
| workspace lease | AgentsToZ host | 같은 checkout/common-dir의 동시 writer 방지 |
| conversation surface | AgentsToZ | app-native, external launcher, future terminal handoff를 구분 |
| project memory | 프로젝트 로컬 정본 | 검토된 결정·규칙·맥락 |
| What I Said | 사용자 발화 원장 | 대화 원문과 자동 혼합하지 않는 explicit reference |
| remote controller session | AgentsToZ E2EE gateway | 단말·권한·폐기·audit 경계 |

provider를 바꿔도 AgentsToZ conversation과 memory identity는 유지되고, provider native
thread는 새 `RuntimeSegment`로 연결되어야 한다. 이 segment handoff는 아직 구현 전이므로
현재 V1은 하나의 conversation을 하나의 host/worktree/provider thread에 고정한다.

## 앱형 대화 적합성 gap 표

| 사용자 경험 | 현재 | 판정·순서 |
|---|---|---|
| 지속 대화 start/resume/archive/history | 기반 구현 | V1 유지, 설치본 containment 승격 후 실행 |
| 프로젝트·워크트리 고정 | opaque target으로 구현 | 실행 직전 fresh resolution과 lease 유지 |
| 실행 중 추가 지시·중단 | exact turn receipt로 구현 | V1 유지 |
| 불확실 turn 복구 | private exact-thread idle probe 구현, 일반 UI/API 미노출 | P1: turn 원인만 복구하고 lifecycle 불확실성과 분리 |
| 계획·진행 설명 | bounded semantic event로 구현 | raw terminal 없이 카드 품질 보강 |
| diff·test·commit 검토 | summary만 구현 | P1: 로컬 파일·비밀 제거 후 bounded detail/preview |
| diff·test·commit·memory 카드 구분 | 로컬·모바일 kind별 시각 구분 구현 | P1 detail 전에도 결과 종류를 즉시 식별 |
| AI 질문·사용자 응답 | Codex 0.148 `item/tool/requestUserInput` → 별도 `agentstoz-conversation-questions-v1` → 앱 질문 카드 구현. 30분 timeout·exact conversation/turn/revision binding, provider ID 비공개, 답변 비영속. 원격 응답은 아직 미연결 | P1: 인터넷 E2EE 원격 질문 grant·모바일 카드 연결(기존 `conversations-v1`과 분리) |
| 명령·도구 승인 | 미구현 | P1: 강한 containment 후 승인 inbox로 구현 |
| 대화 이름·검색·고정·분기 | 프로젝트·adapter·모델·상태 검색 구현 | P2: 사용자 제목·고정·분기 추가 |
| 장기기억 세션 종료 정리 | 관리 화면 이동만 구현 | P1: 사용자 확인 후 curated memory update |
| What I Said 연결 | 원장 관리 이동 구현, 첨부 미구현 | P2: stable reference·권한·폐기가 있는 explicit attachment |
| 같은 대화를 외부 TUI로 인계 | 미구현 | P2: Unix socket/local-only ownership proof 후 |
| 모바일 복수 host 전환 | host 격리 상태·E2EE 기반 구현 | 실제 provider 실행은 containment 승격 후 E2E |

이 표의 P1을 먼저 채워야 “터미널을 작게 원격 조종”하는 Orca형 UX와
분명히 달라진다. 터미널 handoff는 그 뒤의 전문가 용도다.

### 현재 UI acceptance 근거

- 데스크톱과 375px 모바일 viewport의 실제 브라우저 smoke가 최상위 `AI 런타임 → 대화`를 열고,
  `AgentsToZ 앱 대화 · 기본`과 `cmux · Orca · iTerm · Terminal · 보조`를 함께 확인한다.
- 별도 mock journal 흐름은 `unknown` conversation을 390px viewport에 투영하고, 경고가 보이는 동시에
  composer가 disabled라 같은 지시를 다시 보낼 수 없음을 확인한다.
- 로컬 UI는 background list/history/event 동기화 오류를 각각 사용자 mutation 오류와 분리한다. 한 종류의
  정상 polling이 다른 종류의 실패나 provider 반영 여부가 불명확하다는 오류를 자동으로 지우지 않는다.
  mutation 실패 직후에도 composer 잠금을 유지하며 목록을 즉시 다시 읽어 durable `unknown`을 투영한다.
- 모바일 mutation이 실패하면 원래 오류를 보존하고 composer를 잠근 채 같은 Mac의 목록·기록을 즉시
  재조회한다. 서버가 provider 경계를 `unknown`으로 봉인한 경우 사용자의 수동 새로고침 전에 잠금이 투영된다.
- 모바일 host별 panel state와 late completion notice는 host ID로 묶인다. Mac을 전환한 뒤 이전 Mac의
  늦은 응답이 현재 Mac의 대화·알림으로 나타나지 않는다.

이 검증은 대화 surface와 fail-closed UX의 도달 가능성을 증명한다. provider 실행 가능성의 증거는 아니며,
containment readiness가 `ready:false`인 동안 실제 Codex spawn은 계속 차단한다.

### 보관·삭제의 uncertain outcome gate

archive/unarchive/delete 호출은 provider 성공 뒤 로컬 revision 또는 tombstone을 갱신한다.
provider가 변경을 적용한 직후 응답 연결이 끊기면 로컬은 적용 여부를 증명할 수 없다. 특히 영구 삭제를
같은 request ID로 무조건 재전송하면 다른 thread를 지우지는 않더라도, 성공·실패를 거짓으로 표시하거나
provider의 `not found` 오류에 영구히 걸릴 수 있다. 공식 App Server 문서는 이 mutation들의
응답 유실 시 멱등성 계약을 보장하지 않는다.

이 때문에 journal schema v5에는 다음 수명주기 receipt가 구현됐다.

1. provider 호출 전에 `prepared` intent를 SQLite에 원자적으로 기록한다.
2. 정확한 응답 뒤 로컬 revision과 receipt를 한 transaction에서 `completed`로 확정하고, 삭제는 먼저
   영속 tombstone을 만든 뒤 receipt를 완료한다.
3. 응답 경계가 끊기면 `indeterminate`로 기록하고 대화를 `unknown`으로 잠가 continue·handoff·재삭제를
   금지한다. 단순 timeout을 미적용 증거로 사용하지 않는다.
동일 request ID의 정확한 재요청은 완료 결과만 재사용하며, `prepared`/`indeterminate` 요청은 provider를
다시 호출하지 않는다. 서버는 request ID와 별도로 `conversation + action + expectedRevision`을 유일
intent로 묶어 브라우저 저장소가 사라져 새 ID가 와도 같은 mutation을 재실행하지 않는다. 로컬 앱과
모바일 포털도 host·conversation·revision·action·model·prompt의
SHA-256 intent digest에 pending request ID를 24시간 결속하므로 응답 유실 뒤 사용자가 다시 눌러도
새 mutation ID를 만들지 않는다. 원문 prompt와 model은 브라우저 저장소에 기록하지 않는다. 아직
production 승격 전 남은 P1은 다음 reconciliation 경로다.

이어가기 turn과 실행 중 steer/interrupt도 `conversation + expectedRevision`을 서버의 유일 슬롯으로
사용한다. 새 request ID로 같은 digest가 재전송되면 기존 결과를 반환하고, 같은 revision에 다른 prompt나
다른 action이 들어오면 충돌로 거절한다. receipt는 sidecar 재시작 뒤에도 SQLite에서 유지된다. 반면
서로 독립된 새 대화가 우연히 같은 prompt일 수 있으므로 create 자체는 prompt digest만으로 합치지 않고
명시적인 client request ID만 멱등 키로 사용한다.

Sidecar가 `prepared` 기록 뒤 종료되면 provider 호출 전인지 응답 유실 뒤인지 시간만으로 판정하지 않는다.
다음 시작 시 해당 exact revision의 turn/lifecycle 대화를 즉시 `확인 필요`로 바꾸고 새 지시를 잠근다.
목록이 `대화 가능`으로 보이면서 내부 receipt만 거절하는 불일치도 허용하지 않는다.

1. archive/unarchive는 fresh provider metadata에서 목표 상태가 증명될 때만 `unknown`을 복구한다.
2. delete는 provider가 해당 thread의 부재를 권위 있게 증명할 수 있는 stable API가 확인될 때만
   tombstone을 복구 확정한다. 그렇지 않으면 사용자에게 수동 확인/복구 경로를 제공한다.
3. turn/steer/interrupt에서 생긴 `unknown`은 lifecycle receipt와 원인을 구분한 뒤 exact provider thread가
   idle임을 확인하는 명시적 `상태 다시 확인` API와 버튼으로만 복구한다.

현재 UI의 영구 삭제 동작은 managed-execution gate가 닫힌 동안 비활성화되어 있으며, 위 reconciliation과
설치본 E2E를 통과하기 전에는 production 기능으로 광고하지 않는다.

## 대화·기억 데이터 소유권

- AgentsToZ public ID와 provider thread/turn ID를 분리한다.
- provider ID와 cwd는 host private journal에만 둔다.
- 생성 시 `retain-provider-history-on-this-host` 명시 동의를 받는다.
- 현재 journal은 prompt/transcript를 복제하지 않고 intent digest와 상태만 저장한다.
- history UI는 provider `thread/read(includeTurns:true)` 결과에서 사용자/assistant 메시지만 bounded,
  redacted DTO로 변환한 뒤 제공한다. reasoning 원문, command 원문, raw tool output은 기본 제외한다.
- 장기기억은 대화 전체 transcript 저장이 아니다. 사용자가 `세션 기억하기`를 실행하거나 이 Mac의
  Codex 자동 세션 기억을 명시적으로 켠 경우에도, 등록 프로젝트의 변경과 검증된 결정·결과 요약만
  기존 project-memory 계약으로 반영한다. 자동 경로는 50·75·90%와 실제 완료 턴을 함께 요구한다.
- What I Said는 별도 scope의 명시적 attachment이며 기본 prompt에 몰래 주입하지 않는다.

## 구현 순서와 승격 조건

1. persistent provider binding/revision/consent/restart reconciliation
2. archive/unarchive/delete와 permanent-delete tombstone
3. exact live steer/interrupt + request receipt/replay fence
4. 비동기 turn supervisor, sidecar shutdown/forced abort, durable outcome/event cursor
5. bounded/redacted history reader와 앱-native conversation UI
6. local-only API/Tauri capability proxy
7. E2EE conversation-v1 scope와 host별 모바일 UI
8. Codex 설치본 E2E 후 capability 광고
9. Claude → Hermes → agy 순으로 각 structured adapter 검증

현재 1~7까지 구현됐다. 구체적으로 provider-private binding/revision, 보관·삭제와 schema v5 lifecycle
receipt/replay fence, revision별 유일 turn/live-control receipt, 비동기 create/continue, prompt 비복제 turn receipt, 순번 event cursor,
bounded/redacted history reader, exact local HTTP/Tauri proxy와 `작업 | 대화` 앱-native 화면이 테스트와
실제 Vite 브라우저 번들로 고정돼 있다. 원격도 별도 `conversations-v1` 승인, exact E2EE DTO,
fresh target authority 결합, host별 모바일 대화/기록/추가 지시/중단/보관·복원 UI까지 연결했다. 모델
카탈로그와 활성·보관 대화/기록은 반복 cursor와 catalog 변경을 거절하는 bounded pagination으로
읽는다. Codex의 raw 알림은 저장하지 않고 adapter가 정제한 계획/진행과 diff·test 등 산출물 요약만
conversation journal v5에 내구성 있게 기록해 로컬·모바일 카드로 재생한다. 한 turn 128개, 대화당
최근 512개로 제한하며 종료 이벤트 자리를 보장하고, 모바일 투영은 이벤트별 UTF-8 크기와 E2EE
응답 전체 크기를 다시 제한한다. 로컬과 모바일 모두 diff·test·commit·memory kind를 서로 다른
semantic card로 표시하되 raw path·command·output을 새로 노출하지 않는다. 모바일에서는
대화 본문을 목록보다 먼저 배치하고 데스크톱은 목록/대화/맥락 3열을 사용한다. 다만 8의 설치본
로컬 UI도 containment와 live Codex capability가 함께 확인되기 전에는 시작 버튼을
비활성화한다. 특히 readiness 진단은
설명용이며 production 실행을 여는 권한 증명이 아니다.
모바일도 `conversations-v1` scope 미승인과 설치본 runtime/containment 미준비를 서로 다른
blocker로 표시한다. 전자는 새 QR 재승인으로 해결하지만 후자는 Mac 설치본 승격 문제이므로,
권한을 반복 승인하게 만드는 안내를 하지 않는다.

로컬 생성 화면은 Codex 문자열을 내부 정본으로 쓰지 않고 capability의 adapter ID·label·model을
사용한다. 현재 Codex만 대화 adapter 승격 대상이지만 Claude·agy·Hermes도 목록에 보이며 검증 전에는
정확히 `현재 사용 불가`로 표시된다. 요청 멱등 fingerprint에도 adapter ID를 포함해 서로 다른 AI의
동일 target/model/prompt가 한 요청으로 충돌하지 않는다. 서버도 미구현 adapter를 target 해석·journal
생성·provider 호출 전에 거부하고, 저장된 대화의 adapter와 실제 provider가 다른 상태로
계속·기록 조회·보관·삭제·live control이 수행되지 않게 fail-closed한다. 오른쪽 컨텍스트에서는 프로젝트·워크트리·
외부 CLI 관리와 장기기억 관리, What I Said 원장으로 실제 이동할 수 있다. What I Said는 아직 explicit
attachment 계약이 없으므로 대화 prompt에 자동 주입하지 않으며 현재 버튼은 원장 관리 이동만 수행한다.

원격 대화는 기존 `tasks-v1` 승인에 몰래 포함하지 않는다. 같은 E2EE relay transport를 재사용하더라도
별도 `conversations-v1` scope, 별도 exact request/result union, 대화/이벤트/history cursor를 사용한다.
기존 승인 세션은 재승인 없이는 retained history 조회나 continue/steer 권한을 얻지 않는다.
영구 삭제는 원격 scope에 넣지 않고, 이 Mac의 로컬 보관함에서 명시적 재확인 후에만
provider thread와 AgentsToZ tombstone을 함께 정리한다.

## 명시적으로 피할 구조

- xterm.js 화면을 붙였다는 이유로 대화 세션 완료로 간주
- App Server WebSocket을 LAN/인터넷에 직접 노출
- provider ID나 로컬 path를 모바일 DTO에 포함
- terminal ANSI/stdout을 AI 진행 event로 추측 변환
- 한 adapter의 승인·memory 권한을 다른 adapter에 자동 승계
- “최근 대화”라는 이유만으로 프로젝트/worktree가 다른 provider thread를 연결
- provider raw transcript 전체를 AgentsToZ DB/Supabase에 자동 복제

## 기술 기준

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): rich client, conversation history,
  streamed event, `thread/read/resume`, `turn/steer/interrupt`의 기준. 공식 문서가 WebSocket transport를
  experimental/unsupported로 표시하므로 AgentsToZ host는 기본 stdio 연결을 소유하고, relay에는
  provider protocol을 그대로 공개하지 않고 bounded semantic DTO만 투영한다.
- [Codex Remote](https://learn.chatgpt.com/docs/remote): host/chat 전환과 모바일 원격 UX의 기준
- [Codex App Server test client](https://github.com/openai/codex/blob/main/codex-rs/app-server-test-client/README.md):
  두 연결의 thread rejoin 동작을 검증하는 공식 테스트 시나리오
- [Codex active-writer 호환성 사례](https://github.com/openai/codex/issues/37450): 별도 client가 같은
  thread를 resume할 때 관찰된 writer 충돌. 공식 안정성 계약이 아니라 설계 위험을 보여주는 공개 사례다.
- [대형 active thread resume 성능 사례](https://github.com/openai/codex/issues/38787): 전체 history
  복원 비용과 metadata-only resume 필요성을 보여주는 공개 사례다.
- AgentsToZ의 기존 E2EE relay: 공용 App Server proxy가 아니라 semantic DTO gateway로 유지
