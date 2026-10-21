# ChatGPT 분석을 통한 AgentsToZ 대화 세션과 원격제어 개선 연구

2026-10-13 · AgentsToZ 소스 `8711599f3c928437063a80d3744d36a2cc734db3` 기준

우선 개선할 부분은 **앱 재시작 후 같은 대화 복원**, **요청이 어디까지 전달됐는지 표시**, **진행 중 추가 지시와 다음 요청 대기의 구분**이다. 현재 AgentsToZ의 창 닫기 후 실행 유지, 기기별 소유권 확인, 암호화 연결 복구, 터미널 화면 스냅샷을 기반으로 확장한다. 대화 기록과 CLI 실행 세션을 연결하되, 각각의 수명과 권한을 유지해야 한다.

이 연구의 ChatGPT 근거는 설치 번들의 정적 코드와 OpenAI 공식 문서다. 실제 화면의 사용성, 네트워크 장애 후 동작, 서버의 저장·잠금 구현은 확인하지 않았다. 제품 코드는 변경하지 않았다.

## 분석 대상과 REA 준비 상태

| 항목 | 확인 결과 |
| --- | --- |
| 설치 앱 | `/Applications/ChatGPT.app` |
| 앱 버전 | `26.928.21956`, build `12404` |
| Bundle ID | `com.openai.codex` |
| REA CLI | `/Users/cs-work/.local/bin/rea`, `6.4.0` |
| JavaScript 분석 | CLI로 실행 성공. Hopper·Ghidra 없이 수행 |
| 네이티브 심층 분석 | Hopper·Ghidra·IDA provider가 준비되지 않아 수행하지 않음 |
| Codex MCP 연결 | `rea doctor --client codex --json`이 registration drift 보고. 현재 채팅에 REA MCP 도구는 노출되지 않음 |
| 화면 관찰 | CUA가 `com.openai.codex` 접근을 안전 제한으로 거절. 다른 UI 접근 경로로 우회하지 않음 |

REA는 앱의 JavaScript를 실행하지 않고 분석할 수 있고, 네이티브 분석에는 별도 provider가 필요하다. MCP 연결 여부와 CLI의 정적 분석 가능 여부는 구분된다. [REA 설치와 분석 안내](https://rea.tools/get-started/)

`app.asar`의 SHA-256은 `3bda98f2265ad23677dfe0163d1cc7855beade6bef11d27f830f6663d7658406`이다. REA의 기본 artifact 검사는 unpacked native 파일의 선언 해시 불일치로 중단됐다. 읽기 전용 `record-and-continue` 검사에서 불일치 7건을 기록했다. 해당 native 내용은 신뢰 근거로 사용하지 않았다. 별도로 `codesign --verify --deep --strict`는 설치 앱의 서명 검증을 통과했다. 서명 통과만으로 ASAR 해시 불일치의 원인을 확정하지는 않는다.

ASAR에서 관련 파일 50개를 골라 각각의 선언 SHA-256 일치를 확인한 뒤, 격리된 임시 폴더에서 REA JavaScript 분석을 실행했다. REA는 관련 입력 46개와 JavaScript 파싱 45개를 보고했다. `.vite/build/main-…js`와 `browser-page-preload.js`의 semantic 분석은 heap 한도를 초과했고 일부 관계는 결과 예산을 넘었다. 따라서 전체 그래프의 coverage는 `partial`이다. 아래 결론은 확인한 작은 기능 모듈에 한정한다.

재개·복구 안내·대기 메시지·조회 오류의 핵심 모듈 4개, 30,289 bytes를 별도로 분석했다. REA는 4개 모두 파싱했고 이 입력 범위의 application graph coverage를 `complete`로 보고했다. 이 결과는 제외된 의존성이나 실제 실행을 확인했다는 의미가 아니며 semantic coverage는 `unknown`이다. 작은 기능 모듈의 명시적 분기를 근거로 삼고 대형 번들의 미해결 관계와 구분했다.

재현에 필요한 파일별 해시, REA evidence ID, 제한 및 근거 위치는 [분석 증거](rea-chatgpt-sessions-remote-2026-10-13.evidence.json)에 저장했다. 추출한 ChatGPT 코드와 대형 원시 그래프는 저장소에 포함하지 않았다.

## ChatGPT 코드에서 확인한 동작

아래의 ‘확인’은 해당 분기나 UI 코드가 번들에 존재한다는 의미다. 계정별 활성화, 실제 실행 경로, 서버의 보장 수준까지 증명하지는 않는다.

| 관찰 | 정적 근거 | AgentsToZ에 주는 시사점 |
| --- | --- | --- |
| 대화 재개가 대화 ID와 host를 사용한다 | `use-resume-conversation-if-needed-337394ec06dd.js`에서 `resumeConversation`에 conversation ID, workspace roots, 접근 설정을 전달 | 최근 실행 시각이나 같은 프로젝트 이름으로 대화를 추정하지 않고 확인된 provider 대화 ID를 연결 |
| 재개 실패를 원인별로 처리한다 | 같은 모듈에 writer conflict, 잘못된 config, 지원되지 않는 history 형식, rollout 소실을 구분하는 분기 | 모든 오류에 ‘다시 연결’을 제공하지 않고 복구 가능한 원인에 맞는 동작 제공 |
| 늦게 끝난 재개 요청이 현재 선택을 바꾸지 않게 검사한다 | 같은 모듈이 현재 요청 대화 ID와 선택 상태를 await 전후에 확인 | 기기·계정·대화 전환 때 이전 응답을 적용하지 않는 기존 세대 검사를 복구 과정까지 유지 |
| 복구 상태를 입력부 근처와 접근성 상태로 전달한다 | `thread-recovery-notice-1c5a2941798a.js`에 loading/reconnecting 분기, `role=status`, `aria-live=polite` | 연결 배지와 작성칸의 전송 가능 상태를 일치시킴 |
| 대기 메시지는 사용자에게 보이는 조작 대상이다 | `queued-message-list-3ff8f553d6e5.js`에 수정·삭제·순서 변경·즉시 전송·별도 대화로 열기 callback | 미전송 초안, 실행 예약, 실행 중 방향 수정의 의미를 구분 |
| 중단 이후 대기열을 일시 정지한 상태로 보여준다 | 같은 모듈에 interrupted queue와 명시적 resume 분기 | 중단·연결 복구 후 대기 작업을 예상치 못하게 자동 실행하지 않음 |
| 대화 상태와 읽지 않음이 별도 정보다 | `unavailable-local-conversation-page-f5fc4b97aa58.js`에 승인/실행/오류/유휴 및 unread 표시 분기 | ‘프로세스 실행 중’과 ‘AI가 답변 중’을 구분하고 확인된 응답 이벤트로 읽지 않음 계산 |
| 연결 관리의 인증 오류와 일반 조회 실패가 구분된다 | `remote-connections-settings-412b2a6b1159.js`에 재로그인 안내와 조회 재시도 분기 | 휴대폰 네트워크, Mac 연결, 계정 인증, 권한 만료를 같은 오류로 표시하지 않음 |

특히 writer conflict의 **클라이언트 처리 코드**가 있다는 것은 확인했다. ChatGPT 서버의 잠금 저장소, fencing 방식이나 lease 수명을 알아낸 것으로 해석하면 안 된다. `remote-conversation-page`라는 파일명도 특정 Mac 원격제어 구현의 증거로 사용하지 않았다.

## 공식 문서와의 교차 확인

ChatGPT의 모바일 Codex는 연결한 컴퓨터의 대화를 이어 보고, 지시·승인·변경 파일 검토를 지원한다. 사용자가 휴대폰에서 작업의 진행과 결과를 파악하는 흐름을 제공한다. AgentsToZ도 원격 터미널 관찰에 더해 **현재 작업과 필요한 사용자 행동**을 보여주는 방향이 적합하다. [Codex 모바일 안내](https://learn.chatgpt.com/docs/mobile)

공식 문서는 대화 동기화와 프로젝트 파일 접근이 별개이며, Work와 Codex의 대화 기록도 구분된다고 설명한다. AgentsToZ에서도 대화 목록·실행 권한·프로젝트 기억·공통기억을 하나의 상태로 합치지 않는다. [프로젝트와 대화](https://learn.chatgpt.com/docs/projects)

Codex app-server는 thread 재개, turn 시작, 진행 중 turn에 대한 steer, interrupt와 완료 이벤트를 구분한다. 이는 Codex adapter가 제공할 수 있는 의미론의 근거다. 다른 CLI가 같은 기능을 지원한다고 추정하지 않는다. WebSocket transport는 현재 문서상 experimental이며, 기존 AgentsToZ의 권한 검증과 E2EE 경로 안에서 연결해야 한다. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 현재 AgentsToZ의 기반과 부족한 연결

### 현재 사용자 화면

`WorkroomDeviceSwitch`가 여는 `WorkroomSessionDirectory`는 CLI 세션 목록이다. 기기·프로젝트 그룹, 검색, 실행/종료 필터, 큰 별도 창과 같은 세션의 dialog fallback이 있다. 창을 닫아도 실행은 유지되며 원격 대상이 사라지면 초안을 남기고 입력을 막는다.

현재 목록은 기기별 `endpointId + sessionId`를 사용한다. 최대 32개 기기, 동시 4개 조회와 호스트당 최대 24개 세션으로 제한한다. 조회 실패 때 이전 목록을 유지하고, deviceId가 바뀌면 이전 응답을 적용하지 않는다. `createdAt` 기준 최근 시작을 보여 주며 마지막 발언·대화 제목·읽지 않음을 추정하지 않는다. [설계](../plans/project-conversation-sessions-2026-10-12/DESIGN.md), [목록 모델](../../src/workroomSessionDirectoryModel.ts), [현재 화면](../../src/WorkroomSessionDirectory.tsx)

이 목록은 호스트 재시작을 넘는 대화 보관함이 아니다. 종료 세션의 마지막 화면과 provider의 저장된 대화 기록도 서로 다르다. 이미 있는 `aiTerminalResume`는 검증 가능한 Codex/Claude 대화만 이어 열며, 저장된 대화나 소유자를 확인하지 못하면 추정 재개를 하지 않는다. [재개 판정](../../src/aiTerminalResume.ts)

### 재사용할 안정성 장치

- `AiTerminalService`는 같은 owner/request ID의 중복 입력을 막고 동일 ID의 다른 내용을 거절한다. 세션별 큐와 실행 직전 권한 검사가 있다. 이 요청 이력은 메모리 Map이므로 앱 재시작을 넘는 영수증 보장으로 해석하지 않는다. [입력 실행](../../src/aiTerminalService.ts)
- relay controller는 보내지 못한 요청, 앞선 미전송 때문에 거절된 새 요청, 휴대폰 오프라인, Mac의 결과를 읽지 못한 상태를 구분한다. 동일 암호화 envelope의 재전송과 고정 전달 기한을 유지한다. [relay controller](../../src/remoteControlRelayController.ts)
- host/controller vault와 순번 저장, E2EE, SAS 승인, 기기별 grant가 존재한다. 네트워크 복원 때문에 이 승인 범위를 늘려서는 안 된다. [controller vault](../../src/remoteControlRelaySessionVault.ts), [재연결 정책](../../src/remoteControlReconnectPolicy.ts)
- `AiTerminalScreen`은 긴 출력 전체 재생 대신 현재 화면을 페이지로 전달하고 CPR/DA 응답을 호스트에서 처리한다. 이것은 화면 복구이며 대화 기록의 저장을 대신하지 않는다. [화면 스냅샷](../../src/aiTerminalScreen.ts)
- 별도 semantic conversation service/journal에는 conversation ID, revision, turn, request receipt가 있다. 현재 CLI 세션 목록과 다른 계약이므로 그대로 병합하지 않고, 기존 기능의 실행·준비 gate를 존중하면서 연결할 수 있는 부분을 검토한다. [대화 service](../../src/agentRuntimeConversationService.ts), [journal](../../src/agentRuntimeConversationJournal.ts)

2026-09-04의 [기존 Codex 벤치마크](agentstoz-codex-remote-benchmark-2026-09-04.md)는 선행 연구다. 현재 구현 상태는 10월의 세션 설계와 코드로 다시 확인했으며, 과거 보고서의 NO-GO 판단을 오늘의 모든 기능에 그대로 적용하지 않는다.

## 개선 우선순위

| 순서 | 개선 | 사용자가 얻는 변화 | 구현 방향 |
| --- | --- | --- | --- |
| P0 | 재시작을 넘는 대화 식별 | 앱을 다시 열어도 같은 작업을 찾고 검증된 대화를 이어감 | 대화 record와 실행 segment 연결, provider 대화 ID·기기·계정·프로젝트 결속 검증 |
| P0 | 전송 및 결과 확인 상태 | 보낸 것인지, Mac이 받았는지, 실행 결과가 불확실한지 이해 | 명시적 제출 단위의 durable receipt와 상태 조회; PTY 기록만으로 AI 접수 성공을 표시하지 않음 |
| P0 | 재연결 복구 상태 | QR 재등록 요구 없이 같은 화면·초안으로 돌아오고 현재 동작을 알 수 있음 | 권한·프로젝트·세션 확인 후 snapshot/cursor 복구. 해지·만료·버전 오류는 자동 재시도와 분리 |
| P1 | 작업 상태 중심 목록 | 답변 중, 확인 필요, 새 응답을 필요한 순서로 찾음 | 지원 adapter의 turn·approval 이벤트와 읽음 cursor. 미지원 CLI는 ‘CLI 실행 중’ 수준만 표시 |
| P1 | 추가 지시와 다음 요청 대기 | 실행 중 작업을 바꿀지, 다음에 실행할지 선택 | semantic steer와 host queue 분리. 원시 PTY에는 지원되지 않는 동작을 노출하지 않음 |
| P1 | 초안의 재시작 복원 | 창뿐 아니라 앱 재시작 뒤에도 작성 내용을 복원 | 기기·계정·대화·실행 대상에 묶인 opt-in 암호화 저장. raw terminal 키·비밀번호는 저장하지 않음 |
| P1 | 결과 검토 | 휴대폰에서 변경 파일·테스트·필요한 승인을 바로 확인 | 기존 bounded DTO에 검토용 요약과 페이지형 artifact 조회 추가 |
| P2 | 확인된 작업의 기기 이동 | 단순 다시 보기와 실제 실행 위치 변경을 구분 | 동일 기기의 보기 복원부터 제공. 다른 host로 이동은 repo·HEAD·dirty 상태·권한 검사 후 별도 흐름 |

### P0 대화 record와 실행 segment

UI가 보여 주는 대화의 안정된 ID와 PTY session ID를 분리한다. 하나의 대화에 여러 실행 segment를 연결할 수 있지만 연결 증거가 필요하다.

```text
대화 record
  ├─ 사용자 제목·분류·읽음 상태
  ├─ 확인된 provider 대화 binding
  └─ 실행 segment들
       ├─ 기기·provider·계정·프로젝트/worktree binding
       ├─ 현재 또는 종료된 PTY session
       └─ 접수·실행·완료 영수증과 복구 상태
```

호스트 시작 시 record를 읽어 목록을 복원한다. **목록 복원은 CLI 자동 실행이 아니다.** 사용자가 이어 열기를 선택하면 원래 기기·계정·provider 대화·프로젝트 binding과 현재 writer를 확인한다. 연결할 대화를 증명하지 못하면 ‘기록 보기’와 ‘새 대화 시작’을 분리한다. 같은 이름의 프로젝트나 가장 최근 rollout을 임의 선택하지 않는다.

첫 적용은 이미 재개 판정이 있는 Codex/Claude 범위에서 시작한다. Hermes/agy는 확인된 복구 capability가 생기기 전까지 목록·출력 보관만 제공한다. provider ID와 host-local 경로는 호스트 내부에 보관하고 모바일에는 opaque 대화 ID를 보낸다.

### P0 요청 영수증과 사용자 상태

작성칸의 명시적 요청 제출에는 다음 상태를 제안한다.

| 상태 | 실제 근거 | 가능한 사용자 행동 |
| --- | --- | --- |
| 작성 중 | 아직 전송 요청하지 않음 | 편집·삭제 |
| 휴대폰에 보관 중 | 기존 controller outbox의 동일 envelope와 전달 기한 | 연결 복구·남은 전달 기한 확인 |
| Mac 접수 확인 | host의 durable 접수 영수증 | 결과 조회 |
| 터미널 전달 확인 | 해당 PTY 쓰기 반환 | 실행 화면 확인. AI 접수 완료로 표시하지 않음 |
| AI 실행 확인 | 지원 provider의 turn-start 이벤트 | 추가 지시·중지 등 지원 동작 |
| 결과 확인 필요 | 응답 유실 또는 write/receipt 사이 crash | 같은 요청 ID로 상태 조회. 새 ID로 자동 실행하지 않음 |
| 완료 | 해당 요청과 연결된 완료 이벤트 | 결과 검토 |

host receipt는 owner, logical conversation, execution segment, request ID, payload digest, grant epoch에 묶는다. 제출 준비를 부작용 전에 기록하고 동일 ID의 다른 payload를 거절한다. crash가 PTY 쓰기와 완료 기록 사이에 발생하면 결과를 `unknown`으로 남긴다. 외부 CLI의 입력 수신과 DB 기록은 하나의 트랜잭션이 아니므로, durable receipt만 추가해 **재시작 이후 exactly-once 실행을 보장한다고 주장하지 않는다.**

모든 키 입력을 영구 저장하는 변경은 피한다. 명시적 요청 제출의 영수증과 provider turn 결과부터 적용한다. 비밀번호·보안 키 입력·원시 terminal stream을 일반 초안 저장소에 넣지 않는다.

### P0 재연결 화면

복구 순서는 `원래 연결/권한 확인 → 대상 binding 확인 → 작업/영수증 상태 조회 → 현재 화면과 cursor 복구 → 입력 활성화`다. 화면 복원을 위해 Enter, 초기 프롬프트나 resize 입력을 다시 보내지 않는다. 화면 snapshot 이후 delta는 같은 세션·복구 세대에 결속한다.

사용자 문구는 다음처럼 실제 확인 범위에 맞춘다.

- `휴대폰 네트워크가 끊겼습니다. 작성 내용은 보존했습니다.`
- `Mac 응답을 기다리고 있습니다. 마지막 확인 …`
- `같은 대화를 다시 연결하고 있습니다.`
- `요청은 전달됐지만 결과를 확인하지 못했습니다. 결과 확인`
- `연결 권한이 만료됐습니다. Mac에서 연결 확인`

heartbeat가 없다는 이유만으로 ‘Mac이 잠자기 중’이라고 단정하지 않는다. 잠자기는 host의 확인된 신호가 있을 때만 표시한다. 네트워크·foreground 복귀에는 단일 상태 조회를 우선하고, 실패 재시도는 상한과 jitter를 둔다. 숨겨진 화면의 중복 조회를 늘리지 않는다.

### P1 대기열과 writer 충돌

‘지금 작업에 추가’는 provider의 steer 지원이 있을 때만 제공한다. ‘다음 요청으로 대기’는 사용자가 승인한 host queue이며, ‘초안으로 보관’은 실행 예약이 아니다. 대기 항목은 수정·취소·순서 변경이 가능하고, host·계정·프로젝트가 바뀌면 실행 전 확인한다. interrupt 후에는 대기열이 멈춘 상태로 남고 사람이 재개한다.

여러 기기의 **보기**는 유지하되, 동시 입력 충돌을 제어할 host-side writer lease를 검토한다. takeover는 명시적 동작으로 하고 기존 writer의 작업을 자동 종료하지 않는다. lease와 epoch를 await 뒤 실행 직전에 다시 확인한다. provider writer lock과 충돌하면 안전하게 거절하고 원인을 표시한다. 화면 크기 소유권은 현재의 전면 창 규칙과 함께 설계해야 한다.

## 구현과 검증 순서

1. **기준선 측정**: 현재 버전에서 동일한 대화의 창 재열기, 앱 재시작, 휴대폰 네트워크 전환을 나눠 기록한다. 대화 ID, PTY ID, turn ID, 요청 ID와 확인 시간을 결속한다.
2. **첫 구현 범위**: 로컬 Codex/Claude 대화 binding의 영속 보관과 명시적 재개. 기존 실행과 권한 설정을 바꾸지 않는다. 다른 provider에는 확인된 기능만 노출한다.
3. **요청 상태 통합**: 기존 relay outbox/순번/영수증을 재사용해 작성칸과 세션 목록이 같은 접수·미확정 상태를 보여 준다.
4. **원격 적용**: 기존 E2EE, SAS, grant 안에서 같은 대화를 복원한다. 원격 permission을 추가할 때 기존 연결에 암묵적으로 부여하지 않는다.
5. **UX 확장**: 확인된 이벤트가 있는 대화에 제목, 최근 활동, 읽지 않음, 승인 필요, 대기열 및 결과 검토를 추가한다.

### 통과해야 할 장애 시나리오

아래는 후속 구현의 승인 기준이며 이번 연구에서 실행한 테스트 결과가 아니다.

| 시나리오 | 관찰 가능한 통과 기준 |
| --- | --- |
| 창 닫기 후 다시 열기 | 같은 대화·PTY를 보여 주며 초기 요청을 재전송하지 않음 |
| 앱 정상 종료 후 재실행 | 대화 목록을 복원하되 CLI는 자동 실행하지 않음. 명시적 재개는 검증된 같은 provider 대화로 연결 |
| host 접수 뒤 응답 유실 | 같은 ID의 상태 조회로 결과를 확인. 중복 제출 0회 |
| PTY 쓰기 직후 crash | 미확정 상태를 표시하며 자동 재실행 0회 |
| 휴대폰 잠금·백그라운드 복귀 | 승인 범위와 같은 대화의 초안을 유지. 현재 화면을 복구하고 delta를 중복 표시하지 않음 |
| Wi-Fi·셀룰러 전환 | QR 재페어링 없이 기존 유효 권한으로 복원. 전송 전/결과 유실 상태를 구분 |
| 권한 해지·만료 | 상태 조회와 입력을 기존 권한 계약대로 차단. 복원으로 권한이 부활하지 않음 |
| 두 기기 동시 제어 | 읽기는 유지하고 쓰기는 revision/lease로 결정. 이전 epoch의 대기 입력은 실행되지 않음 |
| 같은 session ID를 가진 두 host | 목록·초안·영수증이 섞이지 않음 |
| 대화 변경 중 늦은 복구 응답 | 이전 대화의 결과가 현재 화면·초안을 바꾸지 않음 |
| 긴 terminal 출력·snapshot 중 단절 | 전체 기록을 매번 처음부터 재생하지 않음. snapshot page와 cursor가 같은 복구 세대에 연결 |
| 구버전 host 또는 미지원 provider | 기능 없음과 일시 오류를 구분. 새 세션이나 다른 계정으로 자동 fallback하지 않음 |
| queue interrupt 후 재연결 | 예약 작업을 자동 실행하지 않고 명시적 재개를 기다림 |
| 저장 중 새 활동 후 종료 | 기존 저장 영수증·활동 지문 검사를 유지해 CLI를 함부로 종료하지 않음 |

회귀의 출발점은 `tests/workroom-session-directory.test.ts`, `tests/workroom-session-directory.e2e.mjs`, `tests/ai-terminal-resume.test.ts`, `tests/ai-terminal-scheduling.test.ts`, `tests/ai-terminal-screen.test.ts`, relay/vault 관련 테스트와 conversation service/journal 테스트다. 브라우저 fixture, 실제 설치 Mac, 실제 iPhone의 증거를 구분한다. 실제 원격 장애 검증은 격리된 시험 프로젝트와 무과금 fixture CLI에서 먼저 수행한다.

측정 항목은 복원 성공률, 사용자 요청 중복 실행 건수, 복귀 후 현재 화면 표시 시간, 초안 손실 건수, 불필요한 재페어링 비율, 이전 owner의 입력 거절 여부다. 이번 정적 분석에는 이를 측정한 성능 수치가 없으므로 ChatGPT보다 빠르거나 안정적이라는 결론은 내리지 않는다.

## 다음 REA 심층 분석 범위

현재 확인한 기능 모듈만으로 위의 개선 방향을 정할 수 있다. 추가 분석은 미해결 질문에 한정한다.

- 호스트 연결·복구 계층: 대형 main bundle을 기능별로 분할해 정적 관계를 다시 분석하고 누락된 import의 실제 경로를 검증한다. 이름이 비슷하다는 이유로 모듈을 연결하지 않는다.
- 상태 저장: 읽음 cursor, draft, queue가 실제로 저장되는 위치와 복원 조건을 확인한다. 현재 연구는 관련 UI의 존재를 확인했으며 crash durability를 입증하지 않았다.
- 네이티브 계층: 사용할 provider가 준비되면 정확한 바이너리 해시에 고정해 분석한다. 이번에 신뢰하지 않은 unpacked native 파일과 별도로 취급한다.
- 실제 UX: 허용된 관찰 도구 또는 사용자 시연으로 복구·writer 충돌·queue 중단 흐름을 확인한다. 현재 도구의 ChatGPT UI 차단을 우회하지 않는다.

이 단계에서도 기존 운영 대화의 종료, 계정 변경, 실결제 모델 호출이나 네트워크 전체 차단은 연구의 기본 동작에 포함하지 않는다. 실제 장애 주입은 격리된 시험 환경에서 수행한다.
