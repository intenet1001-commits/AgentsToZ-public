# 전체 Mac·앱별 제어 계약 (v2)

2026-10-28. 기존 [창별 제어 v1](CONTRACT.md)과 별도로 동의하고 실행한다.
화면에 옵션이 있다는 사실이나 합성 fixture 통과만으로 설치 앱의 지원·실기 완료를 판정하지 않는다.
실제 Control의 전체 v2 capability 응답과 별도의 사람 승인이 필요하다.

## 사용 범위와 동의

- **전체 Mac**: 화면을 보고 여러 실행 중인 앱을 오가며 마우스·키보드를 사용한다.
- **선택한 앱**: 선택한 실행 프로세스의 여러 창에서 같은 기능을 사용한다. 예: Orca, Claude, Hermes.
- **한 창**: 기존 v1의 접근성 누르기·입력과 별도 동의한 창 이미지·관찰된 버튼 좌표 선택을 유지한다.

v2는 `screen,pointer,keyboard`를 묶어 Control의 네이티브 검토 화면에 표시하고,
사람이 Touch ID 또는 Mac 로그인 암호로 직접 승인한다. 웹 UI·MCP는 요청만 만들며 인증하지 않는다.

네이티브 인증 대기는 원래 승인 요청이 유효한 동안만 유지한다. 만료·거부·연결 종료로 요청이 끝나면
그 요청의 LAContext를 무효화하고, 늦게 온 인증 응답은 서명에 사용하지 않는다. 새 요청의 인증 대기나
정상적으로 완료된 인증 뒤의 서명용 context를 예전 요청의 정리로 취소하지 않는다.
기존 창 승인·macOS TCC 허용·앱 설정을 새 범위 동의로 해석하지 않는다.
승인은 현재 MCP 연결에 적용되고 **사람이 컴퓨터 유즈를 끌 때까지** 유지된다(2026-10-31). 시간·동작 수로 끝나지 않으며 자동 갱신도 없다.
연결이 앱의 여러 대화에서 공유될 수 있으며 대화별 격리를 주장하지 않는다.
스위치를 끄거나, Control에서 중지하거나, 그 연결(75초 lease, heartbeat로 갱신)·소유 main 프로세스·Control이 끝나면 해당 권한도 끝난다.
grant의 `expiresAt`은 open부터 30일(`ControlLimits.scopeGrantMs`)인 기술적 상한일 뿐이며 화면에 남은 시간으로 보이지 않는다.

**상시 허용**(2026-11-01): 사람이 Control 창에서 Touch ID·암호로 켜면 Secure Enclave의 상시 허용 키(presence 요구 없음)가 생기고,
그동안 Control은 **전체 Mac** 요청을 그 키로 직접 서명·승인한다. 앱 범위는 계속 사람이 승인한다. 키가 곧 허용이라 앱·Control 재시작과
업데이트 뒤에도 유지된다. 프로토콜에는 켜는 동작이 없고 `scope-standing-off`(본문 없음)만 있다. 사람의 「중단」과 「끄기」가 키를 지운다.
`scope-status`는 `standing: {scope:{kind:"desktop"}, since}` 또는 `null`을 함께 돌려준다(이전 Control은 키가 없다 — 꺼짐으로 읽는다).

앱 선택 목록은 실제 실행 앱의 서명과 프로세스 시작 시점을 확인한다. 앱 이름으로 권한을 결정하지 않는다.
앱 범위는 `bundleId,teamId,codeHash,pid,processStart` 전체에 결속하므로 앱 재시작·업데이트에는 다시 승인이 필요하다.
전체 Mac에는 가짜 PID·창 번호를 만들지 않는다. 전체 제어에서도 실제 입력 대상을 매번 검증한다.
Control·AgentsToZ 자체와 시스템 인증·로그인·암호 관리 화면은 제어 대상에서 제외한다.
기존 창 모드에서 제외하던 AI·터미널 앱은 v2의 별도 동의 범위에서 사용할 수 있다.

## 전달·서명 경계

서명 검증된 main ↔ Control XPC와 기존 private sidecar 소켓을 사용한다.
Rust는 닫힌 operation 목록과 channel을 강제하고 `scope-*`에만 envelope `v:2`를 쓴다.
v1의 승인 바이트·operation 의미는 보존한다. main owner PID·시작 시점은 인증된 XPC peer에서만 얻는다.

승인 JSON은 `version:2,approvalId,scope,permissions,caller,owner,issuedAt,expiresAt,signature`다.
`caller`는 `sessionId,lane,generation`, `owner`는 실제 `pid,start`이며,
일회용 approval ID·서명·만료·원래 요청과 모두 일치해야 grant를 열 수 있다.
기존 Secure Enclave 키를 사용하더라도 다음 서명 도메인과 정규 바이트로 v1과 분리한다.

```text
agentstoz-computer-use-scope/v2
approval=<64hex>
scope=desktop|application
bundle=<bundleId 또는 ->
team=<teamId 또는 ->
code=<codeHash 또는 ->
pid=<pid 또는 ->
start=<processStart 또는 ->
permissions=screen,pointer,keyboard
session=<sessionId>
lane=<lane>
generation=<32hex>
owner-pid=<main pid>
owner-start=<main start>
issued=<milliseconds>
expires=<milliseconds>
```

UTF-8·LF이며 마지막 LF도 서명한다. 서명의 `expires`는 grant를 열어야 하는 **승인 대기 마감**(요청부터 최대 10분, 2026-10-31 전에는 120초)이며
서명 형식은 `expires - issued ≤ 610초`만 허용한다(마감 + skew 5초에 여유 10초). 열린 grant의 수명은 서명에 들어가지 않는다 — Control이 open 때 30일 상한으로 정한다.
공개키는 인증된 helper 응답에서만 읽고, boolean 성공 응답을 서명으로 취급하지 않는다.

## MCP와 네이티브 동작

새 `agentstoz_use_computer_session`은 기존 MCP 프로세스의 연결·heartbeat를 공유한다.
외부 operation은 `status,observe,capture,click,type-text,key,scroll,drag,focus-app,receipt,request-human`이다.
AI가 scope·caller·owner·permission을 body로 지정하는 경로는 없다.
기존 `agentstoz_use_computer`는 v1 의미를 유지한다. 이 도구는 MCP 계약 1.66.0에 들어왔다.
1.67.0(2026-10-29)부터 호스트는 **호출 AI의 자기 호스트 앱**을 거절한다. 호스트는 요청 필드가 아니라 연결 등록 때의 프로세스 계보에서 읽는다
(`src/computerUseCallerHost.ts`). 그 앱의 앱 범위는 요청·매 동작에서 거절하고, 전체 Mac에서는 그 앱이 관찰된 전면 앱인 동안의
click·type-text·key·scroll·drag와 그 앱으로의 focus-app을 거절한다. 1.73.0(2026-10-31)부터 전면이 호스트일 때의 focus-app은
대상이 호스트도 보호 앱도 아니면 허용한다 — AI가 자기 호스트에서 빠져나가는 유일한 길이다(그 전에는 호스트 전면에서 모든 입력이 막혀 멈췄다).
네이티브의 보호 전면·오버레이 검사는 그대로다. 호스트를 읽지 못하면 앱 범위와 전체 Mac 입력을 모두 거절한다. 한계는 [docs/claude/computer-use.md](../../docs/claude/computer-use.md).

네이티브 operation은 `scope-status,scope-catalog,scope-request-approval,scope-approval-status,scope-open-grant,`
`scope-observe,scope-capture,scope-click,scope-type-text,scope-key,scope-scroll,scope-drag,scope-focus-app,scope-receipt,`
`scope-revoke,scope-revoke-session,scope-disconnect-owner`다. catalog는 관리 경로에서만 읽는다.
owner disconnect는 자기 XPC owner의 권한만 철회한다. 구형 helper에서 v2가 거절돼도 v1 종료는 먼저 수행한다.

관찰은 15초 이내 snapshot ID와 앱의 불투명 ID·디스플레이 원점/크기/배율/회전·전면 앱을 반환한다.
파일 경로·키·원문 입력은 노출하지 않는다. 좌표는 **디스플레이 상대 point**다.
이미지 pixel 좌표는 `pixelX * displayWidth / imageWidth`, Y도 같은 방식으로 환산한다.
음수 전역 디스플레이 원점은 native가 합산한다. 좌표 입력은 같은 관찰에서 캡처한 디스플레이에만 허용한다.
앱 캡처는 선택 프로세스의 창만 포함하고 전체 Mac 캡처는 보호 앱을 제외한 실제 디스플레이를 사용한다.
JPEG는 240,000 bytes 이하, 한 변은 1,280 pixels 이하로 반환하며 저장하지 않는다.

입력은 클릭·우클릭·더블클릭·제한된 드래그·스크롤·Unicode 문자열과 닫힌 키/수식키 목록이다.
클립보드·임의 shell·argv를 사용하지 않는다. focus-app은 해당 관찰의 정확한 실행 앱만 선택한다.
앱 실행은 기존의 별도 앱 실행 경로와 권한을 사용한다.
모든 down/up을 쌍으로 보내고 중단 시 누른 키·버튼을 해제한다.

## 수명·전송 결과

v1/v2가 동시에 제어하지 않도록 native는 전역 scoped grant 하나만 허용하며 기존 창 grant와 상호 배제한다.
승인 대기를 여러 개 만들더라도 동시 제어 허용으로 바뀌지 않는다.
동작마다 관찰을 소모한다. 다음 별개 동작에는 새 관찰이 필요하며 같은 request ID는 재전송하지 않는다.

- `confirmed`: native가 해당 결과를 검증했다.
- `refused`: 전송 전에 거절했다.
- `dispatched-unverified`: 모든 이벤트 전송과 마지막 안전 검사가 끝났지만 의도한 UI 효과는 검증하지 못했다.
  grant는 유지하고 새 화면을 관찰해 결과를 확인한다. 작업 완료로 보고하지 않는다.
- `unknown` / `human-takeover`: 전송 여부·부분 실행 결과가 불명확하거나 사람이 개입했다. 제어를 중지하고 자동 재시도하지 않는다.
- 사람이 Control 막대의 「직접 하기」를 누르면 grant는 열린 채 `person`이 되고, 영수증 읽기 외 모든 에이전트 동작이 전송 전에
  `person-has-control`로 거절된다(중지·복구 행 없음, 관찰 무효). 돌려주는 길은 같은 막대의 「AI에게 넘기기」뿐이며 Control이 그 클릭이
  하드웨어 또는 서명된 원격 데스크톱 도구에서 온 것인지 확인한다. AI는 request-access나 재전송 대신 status를 기다린 뒤 새로 관찰한다.
  AI 동작 중의 사람 입력은 여전히 `human-takeover`다.

CGEventPost 자체는 앱의 처리 결과를 확인해 주지 않는다. 정상 이벤트 전송을 task 성공으로 승격하지 않는다.
반대로 정상 전송마다 사람의 재승인을 요구하는 영구 중지 상태도 만들지 않는다.
전송 전에 기존 SQLite에 원문 없는 복구 메타데이터를 FULL sync로 기록하고,
전송 완료 또는 명확한 미전송 영수증을 받으면 정리한다. 불명 기록은 재시작 뒤에도 남는다.
전체 Mac 불명 기록은 모든 앱, 앱 범위 불명 기록은 같은 앱의 v1/v2 작업을 원자적으로 막는다.
사람의 직접 검토 전에는 새 grant나 재전송으로 해소하지 않는다.

grant 하나의 동작 수에 64개 상한은 없다. 전체 영수증은 **최근 256개**만 보관하고(`ControlLimits.scopeReceiptsKept`),
그 grant가 쓴 requestId는 **모두** 기억해 다시 오면 보내지 않는다(Control `duplicate-request`). 밀려난 영수증을 물으면
없음이 아니라 별도 답을 준다 — Control `receipt-evicted`, MCP `{state:'evicted'}`와 다시 보내지 말라는 안내. 밀려나는 것은 결과가 정해진
영수증뿐이다(`unknown`·`human-takeover`는 grant를 멈추므로 항상 가장 최근이다). 기억하는 ID의 메모리 상한으로 승인 하나는 동작
**100,000개**(`scopeActionsPerGrant`)까지이며, 넘으면 전송 전에 거절하고(Control `receipt-limit`) 호스트가 grant를 끝내 새 승인을 받게 한다.

## OS 검증과 한계

Accessibility·Screen Recording·보안 입력·물리 사용자 활동·전면 앱·프로세스 세대·최상위 창과
화면 구성은 실제 작업 경계에서 다시 확인한다. 캡처의 await 전후도 검사하고 바뀌면 이미지를 버린다.
보호 UI·보안 입력·화면 잠금·사람 개입·판정 불가 시 입력하지 않는다.
물리 입력 판별은 HID 상태와 생성 이벤트의 별도 source를 사용하며 이를 무결점 격리라고 설명하지 않는다.
합성 이벤트는 private source로 만들고 `cgSessionEventTap`에 전달한다. 원격 제어 입력을 HID 장치 진입점에 넣어
물리 입력 근거를 오염시키지 않기 위한 선택이며, HID 유휴·카운터 검사 자체를 생략하거나 차이를 빼지 않는다.
Apple의 [입력 지점 정의](https://developer.apple.com/documentation/coregraphics/cgeventtaplocation)와
[source state 정의](https://developer.apple.com/documentation/coregraphics/cgeventsourcestateid)를 따른다.
합성 sink 회귀만으로 지원 macOS의 실제 카운터 동작을 증명하지 않으며 서명 설치본에서 별도 확인한다.
중단 영수증에는 제한된 안전 검사 코드(소문자·하이픈, 최대 60 bytes)만 포함할 수 있다. 원문 입력·화면·예외 메시지는
남기지 않으며, 코드가 있어도 `human-takeover`의 중지·직접 복구 검토·재전송 금지는 그대로다.
`human-active-idle`은 1.5초 유휴 조건(또는 유효한 시간 값) 거절, `human-active-events`는 관찰 이후 카운터 변화다.
어떤 코드도 이벤트가 사람에게서 왔는지 합성 전송에서 왔는지 증명하지 않는다. 1577·1578·1632 실기에서 session tap 전송 뒤
카운터는 그대로인 채 HID 유휴만 우리 이벤트 약 10ms 뒤 0이 됐다. 그래서(2026-10-31 사람의 결정) 입력은 두 길로 나뉜다.
- **배경 입력**(`type-text`, `key`, 누를 수 있는 컨트롤·텍스트 칸의 왼쪽 한 번 클릭): Accessibility 동작·값과 대상 프로세스로만 가는 키
  이벤트. 포인터·전면 앱·사람의 키보드 포커스를 쓰지 않으므로 사람의 활동을 보지 않고 사람과 충돌하지 않는다. 잠금·보안 입력·권한·
  대상 신원·범위·보호 오버레이·관찰 신선도는 매번 본다. AX 시간 초과와 전송 뒤 가드 실패는 `unknown`이다.
- **포인터 입력**(그 밖의 클릭, 스크롤, 끌기): 첫 이벤트 전에는 유휴 1.5초와 관찰 대비 카운터 불변, 첫 이벤트 뒤에는 카운터 불변만 본다.
  카운터 변화는 `human-takeover`이고 중지·직접 검토·재전송 금지는 그대로다.
관찰과 캡처는 사람의 활동을 요구하지 않는다(잠금·보안 입력·전면 앱 세대·화면 구성은 그대로 묶는다).

v2 동작 영수증은 선택 필드 `guardSamples`를 가질 수 있다(Control의 `ScopedGuardSamples`). 두 물리 입력 검사가 비교하는 값만 읽고
표본은 최대 3개를 보관·전달한다 — `before`(그 동작의 첫 합성 이벤트 직전), `after`(이벤트 뒤 마지막 가드의 시작), `refusal`(가드가 처음 거절한 순간).
읽기는 이벤트 뒤 가드마다 일어나 마지막 값만 `after`로 남으므로 키 조합·드래그는 3번보다 많이 읽는다.
각 표본은 `idleMs`(HID 유휴, 0~600000, 유한·비음수가 아니면 -1), `sincePostMs`(그 동작이 마지막 이벤트를 넘기기 직전부터,
0~60000, `before`에는 없고 `after`에는 반드시 있다), `counters`(관찰 때와 달라진 카운터만 닫힌 이름 14개 → 1~99, 99는 99 이상,
-1은 감소, 벡터를 못 읽으면 `null`)다. 좌표·키 코드·문자·화면·예외 문구·토큰은 없다. 호스트(`scopeGuardSamples`)는 이 모양이
아니면 필드 전체를 버린다. 표본은 판정에 쓰지 않는다 — 1.5초 기준·정확한 카운터 비교·결과 상태·중지·복구 행·재전송 금지는
표본 유무와 무관하게 같다. 표본도 출처를 증명하지 않으며 실기 해석은 [docs/claude/computer-use.md](../../docs/claude/computer-use.md)에 둔다.
이 필드는 MCP 계약 1.71.0에서 더했다. 에이전트에게 보이려면 Control과 본 앱(호스트)이 모두 이 버전이어야 한다.
`counters: {}`는 읽기 실패가 아니다 — 세는 14종 모두 관찰 때와 같다는 뜻이다(바뀐 것만 싣는다). 읽기 실패는 `null`이다.

`refused` 영수증은 선택 필드 `guardReason`을 가질 수 있다(1.73.0). `reason`은 그대로 일반 코드(`guard-refused` 등)이고,
`guardReason`은 그 거절을 낸 네이티브 검사의 코드(`ScopedNativeSession`의 `actionFailureCode` — 대상 위치·키보드 전면·focus-app·오버레이)다.
소문자·하이픈 1~60 bytes만 싣고(Control `finishMutation`, 호스트 `computerUseScopeHost.ts`가 다시 검사), 원문·좌표·앱 이름은 없다.
`refused` 외 상태에는 붙지 않는다(`human-takeover`의 코드는 예전처럼 `reason`). 상태·중지·복구 행·같은 requestId 재전송 금지는 이 필드와 무관하게 같다.

잠금 근거는 IOKit registry root `IOConsoleLocked`가 **실제 CFBoolean false**인 것과,
같은 UID의 GUI console·loginDone을 함께 확인한다. 값 부재·타입 불일치·세션 부재를 unlocked로 해석하지 않는다.
`IOConsoleLocked`는 [Apple XNU 소스](https://github.com/apple-oss-distributions/xnu/blob/main/iokit/IOKit/IOKitKeysPrivate.h)에 있는
진단 키로 공개 SDK의 안정성 계약이 아니다. 지원 macOS 실측과 회귀가 필요하다.
분산 notification이나 protected-data/keybag 상태만으로 화면이 잠기지 않았다고 판정하지 않는다.

ScreenCaptureKit 필터와 OS 상태 검사는 원자적이지 않다. 두 검사 사이에 잠깐 나타났다 사라지는
보호창을 완전히 가린다고 보장하지 않는다. 캡처 전후 확인된 보호/불명 상태에서는 반환하지 않고,
새 보호 앱이 발견되면 캡처를 폐기한다. 입력 시 최상위 대상과 보안 상태를 별도로 다시 검사한다.

입력 대상은 창 목록에서 그 점을 덮는 맨 위 창이 아니다. 디스플레이 크기의 투명한 Dock 시트(제목 "Dock", Dock 레벨,
Apple 서명 `com.apple.dock`)가 모든 점의 맨 위에 있기 때문이다(2026-10-29 실측). 대상은 시스템 전체 손쉬운 사용 hit-test
(`AXUIElementCopyElementAtPosition`)가 답한 pid이고, 그 점을 덮는 창 중 Dock 시트만 건너뛴 첫 창의 소유자와 같아야 한다
(건너뛸 창 뒤에 아무것도 없으면 Dock 자신이어야 한다). 둘이 다르거나, hit-test가 실패·시간 초과하거나, 판정 뒤 창 목록·디스플레이·
대상 pid 세대·Dock 세대가 바뀌면 입력하지 않는다. 그래서 창 위에 걸친 Dock 타일, 바탕화면(Finder 데스크톱 창은 목록 밖),
메뉴 막대 클릭은 거절된다. hit-test가 통과하는 다른 앱의 큰 투명 floating 창 안쪽도 거절된다 — 예로 ChatGPT의 layer-3 창
(alpha 1)이 화면 오른쪽 약 1/4을 덮는데, 그 아래 점의 hit-test는 뒤의 Orca를 답했다(2026-10-29 실측). 화면에는 클릭을 받지 않는
창의 픽셀이 보이므로 건너뛰지 않는다. 통과 창을 허용할지는 별도 정책 결정이다. 보호 앱과 보안 화면(알림 권한 `UserNotificationCenter`, Gatekeeper `coreservices.uiagent`,
Touch ID `LocalAuthentication.UIAgent` 등)의 목록은 `Tests/ControlContract/protected-targets.json` 하나를 Swift 검사와
TS 테스트가 함께 비교한다 — 한쪽만 바꾸면 둘 다 실패한다.

보호 앱의 layer>0 창은 화면 어디에 있든 캡처·입력을 막는다. 예외는 본 앱(`com.intenet.agentstozbycs`)의 always-on-top 창
(「아젠투지 호출」, tao 레벨 5 또는 floating 3)이다. 그 창은 캡처 필터에서 빠지고, 그 위의 점은 보호 대상으로 거절되며, 활성화형 창이라
본 앱이 전면일 때만 키를 받는다(전면 보호 앱은 거절). 그래서 사람이 그 창을 연 채로 AI가 다른 앱을 제어할 수 있고, grant 동안
창을 숨기지 않는다. Control·시스템 설정·키체인·WindowServer의 layer>0 창, 본 앱의 다른 층(모달·팝업 메뉴), 보안 화면(층 무관)은 그대로 막는다.

## 검증 범위

서명 Swift/TS golden·변조·소유 연결·만료·관찰 소모·영수증·복구 DB·구형 helper 거절을 검사한다.
격리 Chromium/WebKit UI는 전체 Mac/앱/기존 창 선택과 pending-only 요청·종료·직접 복구 검토를 검사한다.
이 결과는 실제 TCC·생체 인증·OS 이벤트 전송·Hermes/Orca 작업 성공의 증거가 아니다.
공식 서명·공증·설치 뒤 별도 scope를 사람이 승인하고, 두 창 이동·입력·캡처·좌표·종료의 실제 결과를 기록한다.
수동으로 연 창·수동 승인과 앱이 자동으로 표시한 창의 증거를 구분한다.
