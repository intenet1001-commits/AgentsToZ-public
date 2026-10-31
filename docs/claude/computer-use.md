# 컴퓨터 유즈 — 한 창(v1)·앱/전체 Mac(v2)·동의·자기 호스트 (2026-10-29)

정본 계약은 [`native/computer-use/CONTRACT.md`](../../native/computer-use/CONTRACT.md)(v1)와
[`native/computer-use/SCOPE-CONTRACT.md`](../../native/computer-use/SCOPE-CONTRACT.md)(v2)다. 이 문서는 그 위의 색인·한도·함정이다.
설치 1548 인수인계는 `docs/plans/computer-use-v1548-session-handoff-2026-10-28.md`. 남은 팀 앱 작업은
`docs/design/computer-use-2026-10-26/TEAM-APP-CONTROL.md`.

## 구조

- **두 MCP 도구, 두 동의.** `agentstoz_use_computer`(v1)는 사람이 고른 **한 창**에 관찰된 AX 버튼 누르기·값 바꾸기를 보낸다.
  창마다 따로 켠 화면 이미지 허용이 있으면 `capture`(그 창만)와 capture 좌표의 관찰된 버튼에 대한 AXPress `click`도 된다 — 합성 마우스 이벤트가 아니다.
  v1은 Hermes·Orca·다른 AI 앱·터미널 앱을 거절한다. `agentstoz_use_computer_session`(v2, 계약 1.66.0~)은 **전체 Mac** 또는 **선택한 앱**에
  화면(ScreenCaptureKit)·포인터·키보드(CGEvent)를 쓴다. v1 창 승인은 v2 권한이 되지 않는다.
- **경로.** MCP 프로세스 → api-server(`src/computerUseApi.ts`, 로컬 전용) → `src/computerUseRuntime.ts`(연결 등록·관리 요청·승인 대기) →
  v2는 `src/computerUseScopeHost.ts`(grant·관찰·영수증·중지) → 사이드카 private 소켓 → 서명 검증된 main ↔ **AgentsToZ Control.app** XPC → Swift 엔진
  (`native/computer-use/Sources/ComputerUseEngine/Scoped*.swift`). MCP 스키마는 `src/computerUseMcp.ts`·`src/computerUseScopeMcp.ts`.
- **연결 = MCP 프로세스.** 연결은 instance 헤더 해시로 묶이고, host가 발급한 code를 앱·Control 검토에 보인다. 한 연결을 앱 안 여러 대화가 함께 쓸 수 있으며
  대화별 격리를 주장하지 않는다. MCP 도구 목록은 CLI 세션 시작 때 고정되므로 1.66.0 이전에 뜬 세션에는 `_session` 도구가 없다.

## 동의 모델

- **범위는 사람이 켜고, 요청은 켜진 동안 AI가 만든다(v2, 2026-10-30, 계약 1.72.0).** 패널의 「컴퓨터 유즈」 스위치가 관리 경로
  `scope-access-set {enabled:true, scope}`로 범위(전체 Mac 또는 한 앱)를 켠다 — **연결 선택은 없다.** 켜진 동안 AI는 `request-access`(필드 없음)로
  그 범위의 Control 승인 요청을 만들고, 사람은 패널의 「승인 검토 열기」 → Control에서 Touch ID 또는 Mac 로그인 암호로 승인한다(요청마다 한 번). **승인은 끌 때까지 유지된다**(2026-10-31) — 아래 「끌 때까지」.
  Control은 스스로 검토 창을 띄우지 않는다(사람의 동작 + AgentsToZ 전면일 때만 `show-review`) — 그래서 버튼 한 번은 남는다.
  v1584 실기(2026-10-31) 「눌러도 창이 안 보였다」의 두 원인: ① 실패 문구가 스크롤된 대화상자의 **맨 위**에 떠서 버튼 옆에서는 아무 일도 없어 보였다 —
  이제 「승인 대기」 안 버튼 바로 아래에 뜬다. ② Control이 창을 주 디스플레이 가운데(또는 예전 자리)에 열고도 보인다고 답할 수 있었다 — 이제 포인터의
  디스플레이로 옮기고 그곳에 있어야만 확인한다([CONTRACT](../../native/computer-use/CONTRACT.md) 「Root 통합 후속」). 실제 디스플레이 배치는 실기 미확인.
  패널은 승인 대기를 `expiresAt`(10분)이 지나면 상태를 새로 받지 못해도 지운다(`liveComputerUsePending`, 1초마다 시계를 다시 읽는다) —
  예전에는 마지막 상태를 그대로 보여 만료된 행과 「승인 검토 열기」가 남았다. `expiresAt`이 숫자가 아닌 항목은 추측해 지우지 않는다.
  2026-10-31 헬프데스크 실기 준비에서 승인 버튼이 설명·범위 설정 아래에 가려졌다. 「승인 대기」와 검토 버튼은 이제 스크롤되는 설정 본문 위의
  고정 헤더에 함께 표시한다. 좁고 낮은 화면에서도 버튼을 스크롤 없이 찾을 수 있어야 한다(`tests/computer-use-panel-ui.mjs`). 검토를 여는 동작과
  Control에서 사람이 직접 서명하는 경계는 같다. 이 소스 변경은 설치본 반영 전까지 설치 앱의 개선을 뜻하지 않는다.
  검토 가시성 확인이 실패하면 같은 대기 영역의 「Control 앱 직접 열기」로 기존 서명된 도우미 열기 경로를 실행할 수 있다.
  새 승인 요청을 만들지 않고, 앱 열기 응답을 창 가시성이나 승인 성공으로 표시하지 않는다. 마지막 Touch ID/암호 인증은 사람이 한다.
  네이티브 인증 대기도 원래 요청의 만료·철회에 결속한다(`ApprovalAuthentication`, v1·v2 service의1초 refresh).
  요청이 끝나면 그 LAContext를 invalidate하고, 늦은 인증 성공으로 서명하지 않는다. 완료된 인증의 context는 서명에 쓸 수 있도록 유지한다.
  예전에는 인증 continuation이 끝날 때만 approving을 비워, 만료된 인증이 다음 요청의 승인 버튼까지 계속 막을 수 있었다.
  Core44개·Swift70개 검사와 Control 컴파일은 통과했으며, 설치본 반영과 실제 Touch ID 재시험은 별도다.
  요청 이름은 runtime이 만든다: `연결 <코드 앞 8자> / <MCP 클라이언트 이름> · <프로세스 계보의 앱> · <범위>`. AI 본문은 scope·label·caller·permission을
  정할 수 없고(`parseComputerScopeAgentRequest`는 `scope-request-access`에 operation 외 키를 거절), 에이전트 경로로 스위치를 켤 수 없다.
  남용 방지: 대기 요청은 전체에서 하나, 같은 연결은 1분에 한 번, 다른 연결이 제어 중이면 거절. 1분은 요청이 **Control에 닿았거나 닿았을 수 있을 때**
  시작한다(2026-10-31) — 호스트를 못 읽음·화면 기록 권한 없음·대기 중인 다른 요청·복구 행·확정된 미전송(`notDispatched`)처럼 Control에 가기 전 거절은
  1분을 쓰지 않는다(예전에는 `await` 전에 세서, 권한을 켜고 바로 다시 물어도 1분을 기다렸다). 결과를 모르는 전송(throw)은 닿았다고 보고 센다 —
  결과 모르는 요청 뒤 새 요청 금지는 그대로다. 동시에 온 요청은 연결과 무관하게 하나만 보내고(대기 요청은 전체에서 하나) 나머지는 「보내는 중」으로 거절한다(`accessRequesting`).
  **끄기**는 모든 연결의 v2 grant·대기 요청과 v1 창 grant·대기를 즉시 끝낸다(연결 자체는 유지). 다른 범위로 다시 켜면 먼저 끈다. 스위치는 메모리 전용 —
  앱을 다시 실행하면 꺼진다. 정본 `src/computerUseRuntime.ts`(`requestAccess`·`turnAccessOff`), 검사 `tests/computer-use-access-switch.test.ts`.
  v1 한 창은 예전처럼 사람이 패널에서 연결과 창을 골라 `request-approval {connectionId, target, label}`로 만든다. 관리 경로 `scope-request-approval`도 남아 있다(패널은 더 쓰지 않음).
  AI는 자기 접근을 승인하지 않는다.
- **결속.** 승인은 caller(`sessionId,lane,generation`)·main owner(pid·시작 시각, 인증된 XPC peer에서만)·범위·권한·만료에 서명으로 묶인다.
  앱 범위는 `bundleId,teamId,codeHash,pid,processStart` 전체 — 앱 재시작·업데이트는 재승인이다. macOS TCC 허용·앱 설정·Screen/OPS 동의는 이 동의가 아니다.
- **제외 대상.** Control·AgentsToZ 자체, 시스템 인증·로그인·암호 화면, 보안 입력, 화면 잠금, 사람이 조작 중인 상태는 입력하지 않는다.
  2026-10-29부터 **호출 AI의 자기 호스트 앱**도 제외한다(아래).

## 한도

| 항목 | 값 |
|---|---|
| 승인 대기 | 최대 10분(v1은 대기 8개). 2026-10-31에 120초에서 늘렸다 — 사람이 Control에 닿기 전에 끝나 다시 요청해야 하는 일이 잦았다(실측: 승인 직전 만료). Control 카운트다운은 「m분 s초 남음」(`ControlCountdown`) |
| grant | v1 창: open부터 최대 10분. v2: **끌 때까지**(기술적 상한 30일, 남은 시간을 보이지 않음). 승인마다 Touch ID/암호 한 번. v2 scoped grant는 전역 하나이고 v1 창 grant와 상호 배제 |
| 작업 수 | v1 창: grant당 영수증 64개. v2: 상한 64개 없음 — 전체 영수증은 최근 256개, 쓴 requestId는 모두 기억, 승인 하나에 동작 100,000개(넘으면 grant를 끝내고 새 승인) |
| 관찰 | v2 관찰은 15초 유효, 동작마다 소모된다. 다음 동작은 새 관찰. 좌표는 같은 관찰에서 캡처한 디스플레이에만 |
| 캡처 | JPEG 긴 변 1,280px·240,000 bytes 이하, 저장하지 않는다. 좌표는 **디스플레이 상대 point**(`pixelX * displayWidth / imageWidth`) |

**초광폭 화면 축소.** 3440×1440 한 화면이면 v2 캡처는 1280×535(약 2.69배 축소)이고, 다른 AI 앱의 작은 허용 버튼이 7~10px가 된다.
`scope-capture`에는 자르기·확대 입력이 없다. 팀 승인 클릭의 정확도를 이것이 직접 깎는다.

**결과.** `confirmed`·`refused`·`dispatched-unverified`(전송은 끝났지만 UI 효과 미검증 — 다시 관찰해 확인, 완료 보고 금지)·`unknown`·`human-takeover`.
뒤의 둘은 원문 없는 복구 행을 남기고, 사람이 패널에서 검토하기 전까지 그 범위를 막는다(전체 Mac 행은 모든 앱). **같은 requestId로도 재전송하지 않는다.**

## 끌 때까지 — v2 승인의 수명 (2026-10-31)

사람의 결정: 「10분은 너무 짧다」 → **스위치가 켜진 동안 AI 연결 하나에 Touch ID 한 번, 시간·동작 수 한도 없음.** 끝나는 경우는
스위치 끄기, 앱·Control 재시작(owner 프로세스 세대), 그 AI 연결 종료(75초 lease — heartbeat 20초마다 갱신, api-server가 10초마다 reap),
Control의 중지, 사람 개입·결과 불명 중지뿐이다. 자동 갱신은 없다.
- **서명 형식은 그대로다.** v2 서명의 `expires`는 원래부터 grant 수명이 아니라 open 마감(요청+10분, 2026-10-31 전에는 120초)이었다.
  서명 창 상한은 그래서 600초에서 610초가 됐다(`maxGrantMs`·`COMPUTER_USE_SCOPE_APPROVAL_MAX_MS` — 마감 + skew 5초에 10초 여유).
  ⚠️ 승인 대기를 다시 늘리면 이 상한도 함께 올릴 것 — 그대로 두면 요청 즉시 한 승인의 서명이 거절된다. 바뀐 것은 Control이 open 때 정하는
  grant `expiresAt`(30일, `ControlLimits.scopeGrantMs`)과 호스트의 검사(`COMPUTER_USE_SCOPE_LIMITS.grantMs`, `src/computerUseScopeProtocol.ts`).
  두 값은 `tests/computer-use-scope.test.ts`가 Swift 리터럴과 비교한다. v1 창(`grantMs` 600초·64개)은 바꾸지 않았다.
- ⚠️ **숨은 시간 한도 둘을 함께 없앴다.** ① `setTimeout`은 2^31-1ms(약 24.8일)를 넘는 지연을 **즉시** 실행한다(Bun 실측 —
  `TimeoutOverflowWarning` 뒤 1ms) — 30일 grant 제거 타이머를 그대로 걸면 승인 직후 grant가 사라진다. `schedule()`이 상한까지 나눠 기다린다.
  ② runtime의 `ComputerCallerRegistry` 자격은 기본 24시간이었다 — 하루가 지나면 연결이 끝나 grant도 끝났다. 연결 자격 수명을 같은 30일로 맞췄다
  (연결은 여전히 75초 lease로 끝난다). 검사 `tests/computer-use-access-switch.test.ts`의 「lasts until it is ended」(26시간 heartbeat 뒤에도 같은 grant).
- **재전송 안전.** 영수증 64개 상한 대신 전체 영수증은 최근 256개만, 쓴 requestId는 모두 기억한다(TS `spent`, Swift `spent`). 밀려난 ID를 다시 보내거나
  영수증을 물으면 `{state:'evicted'}`(Control은 `receipt-evicted`) — 「없음」으로 답하지 않는다(AI가 다시 보내도 된다고 읽는다).
  기억의 메모리 상한으로 승인 하나는 100,000동작이며, 넘으면 호스트가 grant를 끝내 `request-access`가 다시 사람에게 묻게 한다
  (끝내지 않으면 「이미 허용됨」이 돌아와 새 승인을 못 받는다).
- Swift의 `beginMutation`·`finishMutation`은 grant를 제자리에서 바꾼다 — 구조체를 복사해 되쓰면 동작마다 쓴 ID 집합 전체가 copy-on-write로 복사된다.
- 문구: 패널 「승인은 끌 때까지 유지됩니다(앱·Control을 다시 실행하거나 그 AI 연결이 끝나도 끝납니다)」, grant 행 「AI가 사용 중 · 끌 때까지 유지」(사람이 쥐면 「직접 사용 중 · Control 막대에서 「AI에게 넘기기」」, 아래 절),
  Control 검토 「승인하면 컴퓨터 유즈를 끌 때까지」, Touch ID 사유 「컴퓨터 유즈를 끌 때까지 이 범위의…」. 승인 대기 카운트다운(10분)은 그대로 보인다.

## 상시 허용 — 이 Mac의 모든 AgentsToZ AI, 재시작 뒤에도 (2026-11-01)

사람의 결정: 「커뮤니티의 호끼리는 세션별이 아니라 항상 크로스로 쓸 수 있어야 의미가 있다」 → 누가: **이 Mac의 모든 AgentsToZ AI**,
재시작: **유지**. 다른 Mac(3호)이 맡긴 일은 OPS 요청으로 이 Mac(1호)의 OPS AI가 하므로, 새 워크룸 세션(=새 MCP 연결)마다 Touch ID를
받던 것이 불편의 원인이었다.
- **켜는 것은 Control 창뿐이다.** 승인 행의 「항상 허용…」(그 요청도 같은 인증으로 승인), Control 메뉴·설정의 「상시 허용 켜기…」.
  LocalAuthentication 성공 뒤에만 Secure Enclave 키(`…control.standing-key.v1`, **presence 요구 없음**, `WhenUnlockedThisDeviceOnly`)를 만든다.
  **키의 존재가 곧 허용이다** — 라벨 `agentstoz-standing scope=desktop since=<ms>`(`StandingAllowance.swift`)만 기록이고 파일은 없다.
  Control의 키체인 접근 그룹 밖의 프로세스는 이 키를 만들거나 쓸 수 없으니, 파일 서명 같은 재생(되살리기) 문제가 없다. MCP·XPC에는 켜는 동작이 없다.
- **효과.** 대기 중인 **전체 Mac** 요청을 Control이 그 키로 직접 서명·승인한다(`approveByStanding`) — 받는 즉시, 아니면 다음
  `scope-approval-status`에서(다른 grant가 아직 정리 중일 때). 같은 동의 환경 검사(권한·잠금·보안 입력)와 「다른 창·범위 제어 중이면 안 함」은 그대로.
  **앱 범위는 늘 사람에게 묻는다**(pid 세대에 묶여 재시작으로 끝나는 범위라 상시가 될 수 없다). 서명 형식·호스트 검증·grant 열기는 바뀌지 않았다.
- **메인 앱.** 스위치가 꺼져 있어도(앱 재시작 뒤) 상시 허용이면 `access`가 `{enabled:true,scope:desktop,standing:{since}}`로 읽힌다.
  상시 허용 아래에서는 1분 재요청 제한을 걸지 않고(묻는 사람이 없다), 다른 연결이 **2분 동안 요청이 없고**(`STANDING_IDLE_MS`) 실행 중·사람이 쥔 상태·멈춤이
  아닌 grant는 새 연결이 넘겨받는다(`yieldIdle`) — 끝난 워크룸이 grant를 쥔 채 남아 다음 OPS 작업을 막지 않게. 쓰는 중인 grant는 절대 뺏지 않는다.
- **끄기.** 패널 스위치 끄기 → `scope-standing-off`(Control이 키 삭제 + 열린 grant 중지). Control 메뉴·설정의 「상시 허용 끄기」. 그리고
  **사람의 「중단」(막대·메뉴·검토 창)은 상시 허용도 끈다** — 멈춘 AI가 바로 새 grant를 스스로 열지 못하게. 잠시 넘겨받을 때는 「직접 하기」.
- ⚠️ `scope-standing-off`는 끄기 직후 쌓인 revoke 뒤에 와서 채널이 바쁘다 — `RevokingComputerUseChannel`의 기다리는 요청 목록에 넣었다
  (넣지 않으면 즉시 `busy`로 거절돼 스위치는 꺼졌는데 상시 허용은 남는다. 테스트가 잡았다).
- ⚠️ 패널의 주기 `status`는 Control을 다시 묻지 않는다(기존 계약) — 상시 허용은 10초마다 오는 `scope-status`·AI의 status/request-access에서 갱신된다.
- 검사: `tests/computer-use-standing-allowance.test.ts`(재시작 뒤 켜짐·즉시 grant·이전 Control·1분 제한 없음·2분 유휴 인계·사람이 쥔 grant 보호·
  앱 범위는 대기·끄기 전파·Control에서 끔·AI는 켜고 끌 수 없음), Swift `testStandingAllowanceLabel`·`testStrictV2Shapes`.

## 제어 막대 — 지금 누가 Mac을 쥐었나 (2026-10-31)

사람의 요청: 내장 브라우저처럼 v2에도 「AI가 쓰는 중 / 내가 쓰는 중」이 보이고 잠깐 넘겨받을 수 있어야 한다. 사람의 결정 둘 —
**넘겨주기는 막대 클릭 한 번**(Control이 사람의 클릭인지 확인), **사람에게 넘어가는 길은 막대의 「직접 하기」뿐**(AI 동작 중의 마우스 입력은
예전대로 그 동작을 멈추고 grant를 중지하며 사람이 복구 행을 검토한다).
- **막대**(`native/computer-use/Sources/AgentsToZControl/ControlBar.swift`): v2 grant가 열려 있고 중지되지 않은 동안만 메뉴 막대 화면
  아래 가운데에 뜬다. 상태 점·「AI가 사용 중 / 직접 사용 중」·마지막 동작과 시각·「직접 하기 / AI에게 넘기기」·「중단」. key·main이 되지 않는
  nonactivating 패널이라 키 입력을 받지 않고 Control을 앞으로 가져오지 않는다. 문구·판정은 `ComputerUseControlCore/ControlBarRules.swift`.
- **상태**: Swift `ScopedGrantEntry.person`. 켜지면 `access()`가 영수증 읽기 말고 모든 에이전트 동작을 **전송 전에** `person-has-control`로
  거절한다(notDispatched — 중지·복구 행 없음). 관찰은 무효가 되고, 넘겨받으면 새 관찰부터다. 중지된 grant는 이 길로 돌아오지 않는다.
  `scope-status`의 `control`(`agent`/`person`/`halted`)로 호스트가 알고, MCP status의 grant `owner`와 `guidance`가 「request-access·재전송 말고
  30초마다 status」를 말한다. 사람이 쥔 동안의 동작은 `refused`(reason `person-has-control`) 영수증이고 그 requestId는 다시 쓰지 않는다.
- **「AI에게 넘기기」는 사람의 클릭만**(`ControlBarClick.handBackRefusal`): 버튼을 실행한 이벤트가 막대 창의 1초 이내 mouse-up이고,
  엔진의 합성 표식(`ScopedSyntheticEvents.tag`)이 아니며, 보낸 프로세스가 없거나(하드웨어) 원격 데스크톱 서명(Apple 화면 공유·ARD,
  Jump Desktop Connect 팀 `2HCKV38EEC`)일 때만. 그 밖의 보낸 쪽(AI 앱·스크립트·이 프로세스)은 거절하고 4초 안내를 띄운다.
  ⚠️ 실기 보정 전이다 — 거절·수락마다 `control-bar` 로그에 보낸 pid와 서명 이름만 남긴다. 「직접 하기」·「중단」은 사람에게서 아무것도
  가져가지 않아 이 검사가 없다.
- **엔진 예외는 이 창 하나**: `ScopedOwnStatusWindows.ids`에 등록된, Control 자신 pid의 status-bar(25)·floating(3) 층 창만 `noProtectedOverlays`가
  건너뛴다(`ScopedOSGuard.ownStatusWindow`). 같은 번호라도 다른 프로세스 창은 막는다. 막대 위의 점은 여전히 Control의 것이라
  `protected-target`, 캡처 필터도 Control을 뺀다.
- **막대는 status-bar 층(25)이고 매 초 앞으로 다시 올린다**(2026-10-31). 1634까지는 floating(3)이었는데, 1호에서 grant가 열려 있는 내내
  ChatGPT의 같은 층 1138×2009 창이 막대 앞에 있어 사람은 「직접 하기」를 보지 못했다(창 목록 실측: 막대 794는 화면 안 580,946에 있었다).
  같은 층의 다른 앱 창은 나중에 올라온 쪽이 위다. 그래서 다른 앱의 floating 패널보다 높은 층을 쓰고, 그 층의 경쟁에도 매 tick
  `orderFrontRegardless`로 다시 앞에 선다. 엔진 예외는 그 층 하나뿐이다(floating·modal·pop-up 층의 같은 번호는 막는다).
  ⚠️ 막대가 「안 보인다」는 보고는 창이 없는지부터 보지 말고 **창 목록에서 막대 앞의 창**을 본다.
  ⚠️ **`isFloatingPanel = true`는 레벨을 floating으로 되돌린다** — 1637은 레벨을 그 앞에 써서 막대가 그대로 3층이었고(1호 실측, 여전히 ChatGPT 뒤),
  엔진 예외는 25층만 받아서 막대 자체가 `protected-overlay`가 될 뻔했다. 지금은 레벨을 그 뒤에 쓰고 매 tick 확인하며, 엔진은 등록된 막대를
  25·3층 둘 다 받는다(modal·pop-up 층은 여전히 막는다). `ControlBar.swift`는 앱 타깃이라 이 순서는 단위 검사가 없다 — 실기 창 목록으로 본다.
- **모양**(2026-11-01, 사람의 요청 「촌스럽다 — 에고 라이트처럼 세련되게」): `ControlBarView.swift`가 528×52 어두운 유리 캡슐
  (`hudWindow` 블러 + 검정 50% + 흰 16% 테두리, `darkAqua` 고정)을 그린다. AI가 쥔 동안은 보라 점이 숨 쉬고 테두리를 보라·분홍·파랑 빛이
  돈다. 사람이 쥐면 초록 점만 남는다. 「직접 하기」는 흰 알약, 「AI에게 넘기기」는 보라 알약, 「중단」은 회색 알약이고 마우스를 올리면 빨개진다.
  「동작 줄이기」가 켜져 있으면 움직임이 없다. 단추는 여전히 `NSButton`(첫 클릭 수락)이다 — 넘겨주기 판정이 읽는 이벤트가 막대 창의
  mouse-up이어야 하므로 직접 그린 `NSView` 컨트롤로 바꾸지 말 것. 거절 안내는 두 줄(`handBackRefusedTitle`·`handBackRefused`)이라
  잘리지 않는다. 뷰는 AppKit만 가져와서 `swiftc main.swift ControlBarView.swift`로 따로 띄워 `screencapture -l<창 번호>`로 볼 수 있다.
- 검증: `bun scripts/check-computer-use-control.ts`(막대 상태·클릭 판정), `swift test --filter ScopedOSGuardTests`(창 예외),
  `tests/computer-use-scope.test.ts`의 「the person holding the Mac from the Control bar…」(중지·복구 행·revoke 없음, status owner, 넘긴 뒤 새 관찰).

## 배경 입력 — 사람과 커서를 나눠 쓰지 않는다 (2026-10-31)

사람의 결정: 「Codex 컴퓨터 유즈는 충돌이 안 난다 — Codex처럼 개선하고, 우리는 제어권 주고받기(막대)까지 있으니 더 좋은 기능」.
계기: 1호 1632 TextEdit 입력이 `human-takeover / human-active-idle`로 멈췄다. 표본은 `before` 유휴 32143ms·카운터 `{}`, `after` 32153ms
(`sincePostMs` 9), `refusal` 유휴 **15ms**·`sincePostMs` **25**·카운터 `{}` — 사람 입력 카운터 14종이 끝까지 그대로인데 우리 키 이벤트 약 10ms 뒤
HID 유휴만 0으로 돌아갔다(1577·1578 실기 클릭 3번과 같은 모양). 즉 session tap 전송이 HID 유휴 시계를 되돌린다 — **실제 커서·키보드를 쓰는
한 유휴 검사는 자기 입력을 사람으로 읽는다.**
- **Codex가 하는 것**(이 Mac의 `~/.codex/computer-use/Codex Computer Use.app` 바이너리 문자열로 확인): `VirtualCursor`(「Enable the virtual
  cursor in Computer Use」), `AXPress`·`AXShowMenu`·`AXIncrement`·`AXUIElementSetAttributeValue`, `SyntheticAppFocusEnforcer`. 설치된 오픈소스
  `cua-driver`도 「대상 pid로 보내고 앞으로 가져오지 않는다 — 커서 이동·포커스 뺏기 없음, 안 되는 것(드래그 등)만 잠깐 전면」으로 문서화한다.
- **우리 v2의 경로**(`native/computer-use/Sources/ComputerUseEngine/ScopedBackgroundInput.swift`, 분기는 `ScopedNativeSession.act`):
  - `type-text`: 관찰 때 전면 앱(앱 범위는 그 앱)의 **앱 자신의 포커스**(`backgroundFocus`, 시스템 전체 포커스가 아니다)가 검증된 비보안
    `AXTextField/AXTextArea`면 `kAXSelectedTextAttribute`로 캐럿에 삽입한다. 그렇게 안 받는 칸·컨테이너 포커스는 키 이벤트를 **그 pid에만**
    보낸다(`ScopedProcessEventSink`, `postToPid`). 앱이 앞에 있을 필요가 없다.
  - `key`: 같은 대상 pid로 키 이벤트. `focus-app`은 여전히 앱을 앞으로 가져온다(사람 화면을 바꾸는 유일한 동작).
  - 왼쪽 한 번 클릭: 그 점의 최상위 앱(`pointTargetIdentity`)에서 AX 히트 → 자신이나 조상 4단계 안의 `AXPress` 요소를 누르거나, 비보안 텍스트
    칸이면 `AXFocused`를 준다. 창은 그 프로세스의 보통 창이어야 한다(시트·대화상자·경고·모달·보안 칸이면 포인터로 넘긴다).
  - 오른쪽·두 번 클릭, 스크롤, 끌기, 누를 요소가 없는 점: **실제 포인터**(기존 경로).
  - AX 호출이 시간 초과(`cannotComplete`)면 앱이 했을 수 있으므로 `unknown`, 그 밖의 AX 오류는 아무것도 안 바뀐 `refused/background-action-failed`.
    배경 키 전송 중 가드가 실패하면 `human-takeover`가 아니라 `unknown`이다(사람과 충돌한 것이 아니다).
- **사람의 활동은 배경 입력을 멈추지 않는다.** observe·capture·배경 입력은 유휴·카운터를 보지 않는다(잠금·보안 입력·권한·대상 신원·범위·
  보호 오버레이는 그대로 본다). 관찰은 카운터를 기록만 해 포인터 입력이 「관찰 뒤 사람이 움직였다」를 알게 한다.
- **포인터 입력의 가드**: 첫 이벤트 전에는 예전대로 유휴 1.5초 + 카운터 불변. **첫 이벤트 뒤에는 카운터만** 본다(`ScopedEventDispatcher`가
  `validate(afterPost:)`로 알린다) — 그 뒤의 유휴 나이는 이 동작 자신의 것이다. 카운터 변화는 여전히 `human-takeover`·중지·복구 행이다.
- 「직접 하기」는 다음 동작을 시작에서 거절하고, 이미 들어간 동작은 끝까지 간다(`access(allowPerson:)` — 진행 중 재검사만).
- 검증: `ScopedEventDispatcherTests`의 `testChecksAreToldWhenTheActionAlreadyPostedItsOwnInput`·`testBackgroundKeysGoToTheTargetProcessOnly`·
  `testAnAccessibilityCallThatTimedOutIsUnknownNotRefused`, Control 검사의 진행 중 `allowPerson`. ⚠️ AX 삽입·`postToPid`가 실제 앱에서 받히는지는
  가짜 sink로 증명되지 않는다 — 실기(1호 TextEdit)로 확인한다. Chromium·Electron 칸은 배경 키를 무시할 수 있다(결과는 관찰로 확인).

## 자기 호스트 앱 — 요청 필드가 아니라 연결의 프로세스 계보 (2026-10-29)

`src/computerUseCallerHost.ts`. 연결이 **처음 등록될 때** api-server가 `bunServer.requestIP(req)`의 loopback peer port로
`/usr/sbin/lsof -nP -iTCP@127.0.0.1:<port> -sTCP:ESTABLISHED -Fp`(자기 pid 제외, 정확히 한 프로세스) → `/bin/ps -A -o pid=,ppid=,comm=`로 부모 사슬 →
각 조상의 가장 바깥 `.app` → `plutil`로 `CFBundleIdentifier`를 읽는다. 사슬의 **모든** 앱이 호스트다(이 Mac 실측 한 건: `com.intenet.agentstozbycs`·`com.stablyai.orca` 둘).
고정 경로·5초 timeout·최소 env로만 실행한다. 등록 요청은 이 확인이 끝날 때까지 기다린다(소켓이 열려 있을 때 읽어야 한다).

- **앱 범위**: 승인 요청 때와 **모든 동작마다** 다시 본다. 호스트가 그 bundle이면 `OWN_HOST_REFUSED`, 호스트를 못 읽었으면(`unknown`) `HOST_UNKNOWN_REFUSED`.
- **전체 Mac**: 관찰된 전면 앱이 호스트인 동안의 입력(click·type-text·key·scroll·drag)과 호스트로의 focus-app을 거절한다.
  전면이 호스트일 때의 focus-app은 대상이 호스트도 보호 앱도 아니면 **허용한다**(2026-10-31, 계약 1.73.0) — v1584 실기에서 AI가 자기 호스트가
  전면인 채 시작해 focus-app까지 막혀 아무것도 못 했다. 빠져나가는 길은 이것 하나이고, 네이티브는 원래 AgentsToZ 전면의 focus-app을 허용했다
  (`allowOwnForeground`). 보호 전면·오버레이 검사는 네이티브에 그대로 있다.
  호스트가 `unknown`이면 입력은 전부 거절하고 observe·capture만 허용한다. 전면 앱이 비어 있으면(호스트를 아는 경우) 막지 않는다.
- **이것은 거절만 한다.** 호스트를 안다고 권한이 생기지 않는다. 테스트: `tests/computer-use-scope.test.ts` 「caller host」 describe.
- **한계(미해결)**: ① 전체 Mac에서 포인터 아래에 있는 **뒤쪽** 호스트 창은 구분하지 못한다 — 네이티브 hit test가 필요하다. ② v1 창 grant에는 적용하지 않았다
  (v1은 이미 AI·터미널 앱을 거절하지만, 그 밖의 호스트 앱은 이 검사를 받지 않는다). ③ tmux·분리된 세션은 조상이 launchd로 끊겨 터미널 앱이 호스트로 잡히지 않는다.
  ④ 첫 등록에 lsof·ps·plutil 지연이 붙는다.

## 팀 승인 화면

사람의 결정: **터미널 팀원은 키, 앱 팀원은 옵트인한 1회성 클릭만**. 터미널 팀원(워크룸·Orca)은 `send_workroom_keys`·`team_member keys`로만 답하고
화면을 클릭하지 않는다. `team_member keys`는 Enter·숫자를 몇 번째 키든 보내기 직전에 화면을 다시 읽어 「No, exit」을 고르게 되면 보내지 않는다
(`EXTERNAL_KEYS_WOULD_EXIT` — 화살표 뒤의 Enter도 다시 그린 화면으로 검사한다, 음성 도크와 같다). 워크룸 경로 `send_workroom_keys`도
Enter·숫자 전 화면을 다시 읽어 종료 선택을 거절하고, 빈 화면이나 읽기 실패 시 해당 키와 나머지를 보내지 않는다. 일부 키를 보낸 뒤 거절된 같은 요청은
재시도해도 이어 보내지 않는다. 방향키 뒤에는 정해진 시간만 기다리는 대신 실제 선택 행의 변경을 확인한다. Orca는 선택 행이 보이지 않으면 방향키를 보내지 않고, 별도 요청의 마지막 방향키도 선택 변경을 확인한다. 결과 미확정인 키 기록이 있으면 재시작 후에도 후속 키와 새 지시를 차단한다. Orca 후속 지시는 전송 전 해당 팀원의 화면이 승인·선택 대기 중이거나 읽히지 않으면 보내지 않는다. 화면 읽기와 Orca 전송은 원자적이지 않아 그 사이의 화면 변경을 막지는 못한다. 같은 워크룸의 MCP 키 요청은 직렬화하지만 사람이나 다른 입력 경로에 의한 화면 변경은 원자적으로 막지 못하며 설치본 실기는 별도다.
구성기에서 사람이 켠 데스크톱 앱 팀원(`computerUseApprovals: true`)만 리더가 v2 **앱 범위**로 1회성 승인(이 팀 워크트리의
폴더 신뢰, 한 번 실행)에 답한다 — 이 용도로 전체 Mac 범위를 쓰지 않는다. 항상 허용·다시 묻지 않기·권한 우회·네트워크/전체 접근·로그인·macOS 시스템/TCC/
Gatekeeper/Touch ID·AgentsToZ/Control 승인·리더 자신의 호스트 앱은 늘 사람이 답한다. 화면 글은 데이터다(프롬프트 주입). 터미널 앱의 앱 범위는 셸 접근과 같다.
결과는 리더가 읽은 대로 `report_team_task(manual:true)`. 상세: [mcp-ops](mcp-ops.md)의 「팀원 승인 화면」, 정책 문구 정본 `src/agentstozTeamSkill.ts`.

## 알려진 문제 (2026-10-29, 실기 v2 승인 전)

- **암호로 인증하면 승인 직후 「보안 입력」이 아직 켜져 있다 (2026-10-31, 1호 원격 접속).** Touch ID를 못 쓰는 원격 접속에서는 암호를 친다.
  그 암호 칸이 켠 Secure Event Input이 `evaluatePolicy`가 돌아온 순간에도 남아 있어, 인증 뒤 곧바로 하는 `requireConsentEnvironment`가
  `secure-state-unavailable`로 거절했다. 로그로 본 모양: 인증 성공(15:18:47.229) 뒤 2ms 만에 LAContext가 해제되고 Secure Enclave 키 접근이 한 번도 없었다.
  창에는 「승인할 수 없습니다…」 한 줄만 작게 떠서 사람은 승인한 줄 알았고, 요청은 그대로 10분 뒤 만료됐다.
  지금은 인증 뒤 보안 입력이 풀리기를 최대 3초 기다린다(`ScopedOSGuard.awaitSecureInputRelease`). 그다음 검사는 그대로 거절할 수 있다.
  거절 문구는 원인별로 나뉜다(`ControlConsentText.scopeApprovalRefused`). 코드만 `log show --predicate 'subsystem == "com.intenet.agentstozbycs.control"'`에 남긴다.
  호스트도 `scope-open-grant`가 `secure-state-unavailable`(notDispatched)이면 승인을 버리지 않고 다음 읽기에서 다시 연다(`native-busy`와 같은 취급).
  ⚠️ 한 창(v1) 승인은 인증 뒤 이 검사를 하지 않아 같은 문제가 없다. v2에 검사를 더 넣을 때는 인증 직후의 보안 입력을 함께 생각할 것.
- **패널과 AI가 동시에 상태를 물으면 채널이 '사용 중'으로 거절했다 (2026-10-31, 1호).** Control 채널은 한 번에 하나만 보낸다. 패널은 2초마다,
  AI는 제 주기로 `status`·`scope-status`를 묻는데, 겹치면 즉시 `busy`로 거절돼 `scope-status-unavailable`(「범위 제어 도우미 상태를 확인하지 못했습니다」)로 보였다.
  지금은 Control을 바꾸지 않는 상태 읽기 4종(`status`·`scope-status`·`approval-status`·`scope-approval-status`)만 최대 10×150ms 기다린다
  (`RevokingComputerUseChannel`). 입력·허용 열기·관찰은 여전히 기다리지 않고 바로 `busy`로 거절한다 — 이 목록에 넣지 말 것.
- **새로 설치한 Control의 첫 캡처에 macOS가 「bypass the system private window picker」 창을 띄운다 (2026-10-31, 1호 v1624).**
  UserNotificationCenter의 동의 창이라 `securitySurfaces`에 걸려, 떠 있는 동안 입력은 `protected-foreground`, 캡처는 `protected-overlay`로 거절된다(의도된 동작).
  이 창은 합성 클릭을 무시한다(osascript `click button "Allow"`가 전달됐지만 창이 남았다). 1호에서는 Jump Desktop 화면에도 보이지 않았다 — 창은
  주 화면 가운데 위쪽(710,192 · 260×364)에 실제로 떠 있었다. 사람이 그 Mac 앞에서 **Allow**를 눌러야 한다. AI·Codex 컴퓨터 유즈로 누르게 하지 말 것.
  Control만 바뀌지 않은 메인 앱 업데이트에서는 다시 뜨지 않는다. 거절 안내는 MCP 도구 설명이 「OS 권한·로그인 창이 열려 있으면 사람에게 답하게 하라」로 준다.
- **AI가 받지 않는 항목을 넣으면 거절 문구가 그 항목을 짚는다 (2026-10-31, 1호).** `observe`에 `requestId`를 두 번 넣고 「요청이 올바르지 않습니다」만 읽었다.
  지금은 `scopeAgentProblem`이 「observe: 넣지 않는 항목 requestId (받는 항목: grant, epoch)」·「빠진 항목 …」을 붙인다. 표는 `SCOPE_AGENT_FIELDS` 하나.

- **메인 앱만 바꾸면 Control이 뒤처진다 (2026-10-31, 1호).** Control은 별도 앱이라 `scripts/install-remote-mac.ts`·앱 업데이트가 바꾸지 않는다.
  1호가 메인 1619 + Control 1557이었을 때, 새 호스트는 10분짜리 승인 요청을 보내고 옛 Control은 120초까지만 받아 `approval-expired`로 거절했다 —
  AI에는 「승인 요청 전달을 확인하지 못했습니다」만 보였고 사람 화면에는 「승인 대기」가 끝내 나타나지 않았다. 지금은 방금 만든 요청이 `approval-expired`면
  그 Control 프로세스(pid+start)를 이전 버전으로 기억해 `scope-update-required`(화면: 「이 Mac의 AgentsToZ Control이 이전 버전입니다…」)와
  `control-update-required` 오류를 내고 같은 Control에는 다시 묻지 않는다. 다른 Control 프로세스가 답하면(새로 설치) 풀린다. 다른 거절은 코드를 붙인다
  (`Control: approval-limit`). 원격 설치는 끝에 `control=<버전|none>`을 찍고 이 Mac보다 오래됐으면 경고한다 — **다른 Mac에 설치할 때 Control도 함께 바꾼다.**
  검증: `tests/computer-use-scope.test.ts`(이전 Control·코드 표시), `tests/install-remote-mac.test.ts`(`control=`·경고).
- ~~Dock이 「최상위 대상」으로 잡힌다~~ — **`0a9dabb1`에서 고쳤다(v1570부터 설치본에 있음).** 예전 `topmost(at:)`는 앞→뒤 CGWindowList의 첫 창을 골라
  화면 전체 크기의 Dock 창(layer 20)이 모든 점에서 먼저 잡혔다. 지금은 `ScopedOSGuard.pointTargetIdentity`가 AX hit test
  (`AXUIElementCopyElementAtPosition`, 0.25초 한도) → pid를 CGWindow와 교차 확인하고, 서명이 확인된 `com.apple.dock`의 전체 화면 창만 건너뛴다. 불일치는 거절.
- ~~음성 도크 「아젠투지 호출」 창이 v2를 전부 막는다~~ — **2026-10-30에 규칙 자체를 바로잡았다.** 겹침 규칙(`noProtectedOverlays`)은 보호 앱의
  layer>0 창이 화면 **어디에든** 보이면 전부 거절했는데, 같은 아젠투지의 일반 창(layer 0)은 대상 앱을 덮고 있어도 허용했다 — 같은 앱의 창을 층으로만
  다르게 다룬 것이다. 입력 경로마다 보면 그 창이 더 막는 것이 없다: ① 캡처 필터가 아젠투지 창을 뺀다(앱 범위는 대상만 포함, 전체 Mac은 보호 앱 제외)
  ② 그 창 위의 점은 AX hit test가 아젠투지로 답해 `protected-target` ③ tao 창은 활성화형 NSWindow(NSPanel이 아니다)라 아젠투지가 전면일 때만 키를
  받고, 그때는 `protected-foreground`. 그래서 **본 앱(`com.intenet.agentstozbycs` 정확히)의 always-on-top 층만** 전역 거절에서 뺐다
  (`ScopedOSGuard.ownAlwaysOnTop`). tao는 always-on-top에 키 상수 `kCGFloatingWindowLevelKey`(5)를 레벨로 넣는다 — 진짜 floating 레벨 3이 아니다
  (tao 0.34.5 `ffi.rs`, 10-28 실측 layer 5). 둘 다 받는다. Control(접두사)·시스템 설정·키체인·WindowServer의 layer>0 창, 본 앱의 다른 층(모달 8·팝업 101)은
  그대로 막고, 보안 화면은 어느 층이든 막는다. `0a9dabb1`의 「grant 동안 창 숨기기」(`ScopeGrantMirror`·숨김/복원·열기 거절)는 이 규칙을 피하던
  우회였고 사람이 그 창으로 AI와 말하는 것을 막았으므로 걷어냈다. 남는 것: 호출 창이 대상 앱을 덮은 자리의 클릭은 거절된다(AI 캡처에는 그 창이
  없다) — 창을 옮기면 된다. ⚠️ 새 always-on-top 창을 nonactivating panel로 만들면 ③이 깨진다(전면이 아니어도 키를 받는다) — 그런 창에는 면제를 주지 말 것.
  실기(v1572, 2026-10-30, 계산기 앱 범위): 호출 창(layer 5)이 열린 채 observe·focus-app은 통과했다. 캡처는 아래 결함에 막혀 거기까지만 확인했다.
- **실측(2026-10-30, 이 Mac)**: 「Force Quit Applications」(loginwindow, layer 8) 창이 화면에 남아 있었다. loginwindow는 보안 화면이라 보이는 동안
  v2 캡처·입력 전체가 `protected-overlay`다 — 실기 시험 전에 창 목록을 보고 닫는다.
- **마우스 포인터 창이 v2 전체를 막았다(2026-10-31 실측, v1607, macOS 26.7).** 승인·observe·focus-app은 통과했는데 첫 캡처가
  `protected-overlay`였다. 원인은 WindowServer가 포인터를 자기 창으로 그린 것이다 — 창 4, 이름 「Cursor」, cursor 레벨, 28×40, 포인터 위치.
  그때 화면에는 녹화 표시(StatusIndicator)도 있었다(휴대폰 화면 제어가 켜져 있었다). 예외는 메뉴 막대·녹화 표시 둘뿐이라, 서명 확인된
  WindowServer의 layer>0 창으로 걸렸다. 지금은 `ScopedOSGuard.pointerWindow`(이름 「Cursor」·cursor 레벨·256pt 이하)를 세 번째
  compositor 장식으로 받는다. 클릭 경로(`pointTargetIdentity`)에서도 서명된 WindowServer의 포인터 창만 통과시키고, 그 아래 창이
  여전히 AX hit-test 주인과 같아야 한다. 포인터는 어디로든 움직이므로 위치가 아니라 크기로만 묶는다.
- **v2 캡처가 실기에서 매번 거절됐다 — WindowServer의 빈 번들(2026-10-30 실측, macOS 26.7, v1572까지).** ScreenCaptureKit 목록은 WindowServer(pid 169)를
  `bundleIdentifier ""`로 준다. `scopedCaptureFilter`가 빈 번들을 `scope-app-unverifiable`로 거절해서, 메뉴 막대·녹화 표시가 화면에 있는 한 앱 범위·전체 Mac
  모두 첫 캡처부터 실패했다(합성 fixture에는 이 항목이 없어 통과했다). 지금은 빈 번들을 **resolver가 서명된 compositor로 증명한 pid에만** 받는다
  (`ScopedNativeSession` resolver는 `isVerifiedCompositor`를 요구) — 다른 빈 번들은 여전히 거절이다. 이 Mac의 목록에서 빈 번들은 WindowServer 하나였다.
  같은 날 v2 호스트 오류도 v1처럼 native 거절 코드를 붙이게 했다(`화면을 읽지 못했습니다: <code>`) — 코드 없이는 원인을 진단 스크립트로 찾아야 했다.
- **HID 자기 오인(실기 원인 확정 전)**: v1573은 `.privateState` source로 `.cghidEventTap`에 이벤트를 보내고, down/up 사이·키 묶음 사이·scroll/drag 뒤에
  가드를 다시 돌린다. 가드는 HID 1.5초 유휴와 `.hidSystemState` 카운터 불변을 요구한다. macOS가 자기 주입을 그 카운터에 센다면 **모든 v2 변경이 전송 뒤
  `human-takeover`가 되고 복구 행이 범위를 막는다.** 첫 실기 검사는 fixture 앱 범위·한 번의 왼쪽 클릭·영수증 확인으로 하고(음성 도크는 열어 둬도
된다 — 막히면 `protected-overlay`로 따로 보인다),
  사람이 복구 행을 검토할 준비를 한 뒤에 한다. 확인되면 자기 전송 뒤의 카운터 스냅샷이나 태그된 이벤트 구분이 필요하다.
  2026-10-30 소스는 원격 제어 입력 지점인 `.cgSessionEventTap`으로 전송하도록 수정했다. private source와 HID 상태 검사는 유지하며
  카운터 변화 무시·사후 기준값 덮어쓰기는 하지 않는다. fake sink는 전송 지점과 이벤트 균형, 가드 거절 시 중단·버튼 해제를
  검사하며 실제 HID 분리를 증명하지 않는다. 1577 설치본에서 Calculator 7→78 효과는 관측됐지만 클릭 영수증은 다시
  human-takeover / human-active였다(requestId 1577-click-calculator-eight-2d249e5d). 재전송하지 않았다. 원인은 미확정이다.
  후속 진단은 최근 입력 시간 거절을 human-active-idle, 관찰 이후 카운터 변화를 human-active-events로 나눈다.
  유휴 1.5초·카운터 불변 조건은 바꾸지 않으며 코드 자체로 사람/합성 이벤트 출처를 단정하지 않는다.
- **1578 실기 — 코드로 좁힌 곳(2026-10-30)**: 계산기 9 왼쪽 클릭 1회(`1578-click-calculator-nine-1793346935277`)로 78→789, 즉시 영수증과
  같은 ID 재조회 모두 `human-takeover / human-active-idle`, 호스트 halt(epoch 2). `pair()`는 down 전 가드가 거절하면 `refused/guard-refused`로
  아무것도 보내지 않으므로, 효과와 takeover가 함께 있다는 것은 **down 전 가드 통과 → down 전송 → down·up 사이 가드의 유휴 검사 거절 → 해제용 up 전송**이다.
  그 가드는 유휴(`requireGeneral`)를 카운터보다 먼저 보므로 카운터 결과는 모른다. 즉 down 전 가드의 마지막 유휴 읽기와 그 뒤 읽기 사이(그 사이에
  AX hit test·창 목록이 들어 있다)에 HID 유휴 시계를 1.5초 아래로 되돌린 무언가가 있었고, 그 구간에 알려진 사건은 우리 down 하나다. v1573·1577·1578
  실기 클릭 3번이 모두 효과+takeover였다(앞 둘은 사유가 `human-active` 하나라 유휴/카운터를 가르지 못한다). 자기 귀속 가설과 맞지만, 같은 구간의 사람·다른 자동화 입력을 배제하지 못하므로 **원인은 미확정**이다.
- **가드 표본(`guardSamples`, 영수증 선택 필드)**: 위 구간을 재기 위해 Control이 동작마다 **표본을 최대 3개** 보관·전달한다 — `before`(첫 이벤트 직전)·
  `after`(이벤트 뒤 마지막 가드 시작)·`refusal`(첫 거절 순간). 각 `idleMs`·`sincePostMs`(이벤트를 넘기기 직전부터)·`counters`(관찰 대비 바뀐 종류만).
  읽기 횟수는 3번보다 많을 수 있다: `before` 1번, 이벤트 뒤 가드가 시작될 때마다 1번(마지막 값만 `after`로 남는다 — 클릭·스크롤 1번, 키 조합은
  누르는 키 수만큼, 드래그는 최대 13번), 첫 거절 때 1번. 한 번 읽을 때 유휴 1회·카운터 14회를 OS에 묻는다.
  계약은 [SCOPE-CONTRACT](../../native/computer-use/SCOPE-CONTRACT.md). 판정·임계값·halt·복구 행·재전송 금지는 그대로이고 원문은 없다.
  ⚠️ 에이전트 영수증에 보이려면 **Control과 본 앱을 함께** 바꿔야 한다 — 표본은 Control이 만들지만, 본 앱 사이드카의 `computerUseScopeHost.ts`가
  영수증을 `requestId`·`state`·`reason`으로 새로 짜므로 이 변경 전 호스트(1577)는 표본을 버린다(Rust 브리지는 객체를 그대로 넘긴다). Control만 교체하면 안 보인다.
  새 외부 영수증 필드라 MCP 계약을 1.71.0으로 올렸다(파라미터·권한·입력 의미는 그대로). 진단을 더한 것이지 원인을 고친 것도 성능을 바꾼 것도 아니다.
  `counters: {}`는 **버그가 아니다**(v1584 실기에서 거절 영수증에 보였다) — 관찰 이후 바뀐 카운터가 없다는 뜻이고, 못 읽으면 `null`이다.
- **거절 사유(`guardReason`, 1.73.0)**: v1584 실기의 거절 영수증은 `refused / guard-refused`만 보여 어느 검사인지 알 수 없었다. Control은 그 코드
  (`ScopedNativeSession.actionFailureCode` — `target-changed`·`protected-overlay`·`human-active` 등)를 이미 알았지만 `finishMutation`이
  `human-takeover`에만 실었다. 이제 `refused`에 `guardReason`으로 싣고, 호스트는 `^[a-z-]{1,60}$`일 때만 같은 requestId의 영수증에 옮긴다.
  `reason`·상태·중지·재전송 금지는 그대로다. 보이려면 표본처럼 **Control과 본 앱을 함께** 바꿔야 한다.
  읽는 법 — 모두 **조건부 관찰**이고 어느 것도 출처를 확정하지 않는다. 한 번의 결과로 원인을 정하지 말고 같은 조건의 반복과 함께 본다.
  ① `dispatched-unverified`이고 `after.idleMs`≥1500 — 마지막 가드 시작 때 HID 유휴가 1.5초 이상이었다는 관찰이다. 자기 이벤트가 유휴를 갱신하지 않은
  경우와 맞지만, 이벤트 전달·가드 지연 동안 1.5초가 흘렀을 수도 있다. `after.sincePostMs`가 `after.idleMs`보다 뚜렷이 작을 때만 그쪽에 무게가 실리고,
  `sincePostMs`가 1500 근처 이상이면 이것으로는 가르지 못한다.
  ② takeover인데 `after.counters`가 `{}` — 세는 14종이 관찰 때와 같은 채 유휴만 1.5초 아래였다는 관찰이다. 자기 이벤트가 유휴만 갱신하는 경우와 맞고,
  14종 밖의 입력(제스처 등)도 같은 모양이 된다.
  ③ 보낸 종류만 +1(`{"leftMouseDown":1}`) — 자기 이벤트가 HID 카운터로도 세지는 경우와 맞지만, 같은 종류의 사람 입력 1번과 구별되지 않는다(자기 귀속이 맞다면
  유휴를 고쳐도 카운터 검사가 막는다).
  ④ 보내지 않은 종류(`keyDown`·`scrollWheel`, 클릭 중 큰 `mouseMoved`) — 동시 입력(사람 또는 다른 자동화)과 맞는다. 다른 위치로의 클릭이 커서를 옮기며
  `mouseMoved` 1을 남길 가능성도 확인되지 않았다.
  시각 비교는 보조다. 두 값은 서로 다른 순간에 읽고(유휴 → 카운터 → 시계 순) 정수 ms로 내림하므로 약 1ms의 양자화 오차와 읽기 간격이 붙는다.
  `after.idleMs`가 `after.sincePostMs`보다 수 ms 이상 작으면 마지막 HID 사건이 우리 전송 시작 이후였다는 관찰과 맞고, 수 ms 이상 크면 전송 전 사건과
  맞는다(단, OS가 이벤트 생성 시각(가드 전)을 쓰면 자기 이벤트도 그렇게 보인다). 차이가 몇 ms 안이면 어느 쪽으로도 읽지 않는다.
- HID 가설과 초광폭 축소, 그리고 위 두 수정의 실기 미확인 때문에 실기 v2 승인·입력·두 창 이동은 아직 완료로 보고하지 않는다. 합성 fixture·fake event sink 통과는 TCC·생체 인증·OS 이벤트의 증거가 아니다.

### v1573 전체 Mac 실기 (2026-10-30, 3호)

- 사람이 Codex MCP 연결에 전체 Mac 범위를 승인했다. 첫 observe는 코드 없는 거절이었고, 뒤의 새 관찰은 성공했다. 원인은 확인되지 않았다.
- 계산기 focus 영수증은 `dispatched-unverified`, 이후 실제 전면 앱 확인과 전체 Mac 캡처는 성공했다. 계산기 숫자 7 한 번 클릭한 영수증은
  `human-takeover`였고 별도 읽기 전용 AX 관찰에서 표시값 7을 확인했다. 클릭을 재전송하지 않았다. 사용자의 입력과 자체 이벤트 중 어느 것이
  takeover를 일으켰는지는 구분하지 못했으므로 HID 자기 오인은 여전히 가설이다. 사람이 복구 행을 검토해야 한다.
- 소스의 observe 오류는 허용된 형식의 네이티브 거절 코드만 보여주도록 개선했다. 이 변경은 설치본에 아직 반영되지 않았고, 앱 범위 캡처·두 창 이동은 미검증이다.

## 검증

`tests/computer-use-scope.test.ts`·`computer-use-runtime`·`computer-use`·`computer-use-scope-mcp`·`computer-use-hardening`·`computer-use-session-lifecycle`,
Swift `swift test --package-path native/computer-use --disable-automatic-resolution`. 실기 확인은 서명·공증·설치 앱에서 사람이 범위를 승인한 뒤 따로 기록한다.
