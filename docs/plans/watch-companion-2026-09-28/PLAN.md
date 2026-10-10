# AgentsToZ Apple Watch 계획 (최종안)

> 이 문서는 계획만 담고 있으며, 저장소 파일은 하나도 수정하지 않았다.
> **[V]**는 코드에서 확인한 사실이고 file:line 근거가 있다. **[I]**는 추론이거나 플랫폼 지식이라서 기기 실측이나 문서 확인이 필요하다.
> 초안에 보안·실현 가능성·UX·완결성 네 방향의 반박 검토를 반영했다. 심각도 높음(HIGH) 지적은 전부 본문에 넣었고, 중간(MEDIUM)과 낮음(LOW)의 채택·보류 여부는 §8에 정리했다.

이번에 다시 확인한 핵심 사실:
- `src/aiTerminalLaunchArgs.ts:7`: Claude 워크룸은 `--session-id <workroomId>`로 실행된다. Codex에는 세션 id가 없고 status-line 설정만 붙는다. [V]
- `src/aiTerminalService.ts:263`: env 필터는 `^(PORTMGR_|AGENTSTOZ_).*CAPABILITY`와 이름이 정해진 키 3개만 지운다. [V]
- `src/aiTerminalService.ts:264-266`: 워크룸 세션은 메모리 안의 Map에 `randomUUID()`로 들어 있다. 그래서 사이드카를 재시작하면 모두 사라진다. [V]
- `src/aiTerminalProtocol.ts:62,70,72`: 원격 `start`가 `bypassPermissions`와 `cols/rows`(필수)를 받는다. [V]
- `src/remoteControlTaskProtocol.ts:539-551`: `questions:false`와 `approvals:false`가 하드코딩돼 있다. [V]
- `src/conversationTargetAlias.ts:41-45`: `프로젝트담당자`만 떼어 내고, 실패해도 후보 목록을 돌려주지 않는다. 그래서 「헤르메스 담당자」는 NOT_FOUND가 된다. [V]
- `src/remoteControlRelayRpcClient.ts:495-528`: 릴레이 **호스트는 service_role 키와 `host_secret`으로 인증한다**(`remoteControlRelaySql.ts:212-234`). Mac 사이드카에 사용자 JWT가 있다는 근거는 없다. [V]
- `mobile/ios/AgentsToZCore/Package.swift:6`: 지원 플랫폼은 `.iOS(.v17), .macOS(.v14)`뿐이다. [V]
- `mobile/ios/App/RemoteHomeView.swift:110-125`: 앱이 백그라운드로 가면(화면 잠금 포함) 워크룸이 끝난다. 유일한 URL 핸들러도 열려 있는 워크룸을 먼저 `end(.disconnected)`한다. [V]
- `ports.json`: 141개 중 105개가 ASCII 이름이고, 108개는 `aiName ≠ name`이다. `test`와 `test2`는 각각 두 개씩 중복이다. [V]

---

## 1. 결론과 근거

**아래 순서의 하이브리드로 만든다.**

1. **Mac이 먼저 구조화된 워크룸 신호를 만든다.** 신호는 「차례 끝남 · 다음 지시 가능」, 「권한 승인 대기」, 「종료/실패」다.
2. **그 신호를 내용 없는 알림으로 손목에 보낸다.** MVP에서는 iPhone 알림을 워치에 미러링하는 방식이라 워치 앱이 필요 없다. 이름도 정직하게 「알림 → iPhone에서 바로 그 워크룸」이라고 붙인다. 손목에서 직접 부르는 기능이라고 약속하지 않는다.
3. **v2에서 독립 실행 네이티브 워치 컨트롤러를 만든다.** 워치는 자기 기기 키, SAS 승인, 최소 권한 grant, 슬롯 1개를 따로 갖는다. **Supabase 자격 증명은 들고 있지 않는다.** 대신 기기 키로 서명한 요청을 릴레이 전용 프록시로 보낸다.

**iPhone이 대신 중계하는 얇은 워치 앱은 기각한다.** 자격 증명을 모두 들고 있는 WK 페이지는 앱이 백그라운드로 가거나 화면이 잠기면 바로 내려간다(`RemoteHomeView.swift:119-125` [V]). 그렇게 만들면 폰을 잠금 해제해서 손에 들고 있을 때만 동작하는 워치가 된다.

사용자가 매일 얻는 이득은 세 가지다.
- 워크룸이 나를 필요로 할 때 손목이 두드려 준다.
- 짧은 지시를 확인한 뒤 보낼 수 있다.
- **고정한 프로젝트 목록**에서 아젠투지나 프로젝트 담당자를 한 번에 부를 수 있다.

워치에서 터미널을 탐색하는 기능은 목표가 아니다. 구조화된 신호가 Telegram, iPhone, 워치, Live Activity 모든 표면의 공통 기반이므로 가장 먼저 만든다.

**세 가지 전제 조건을 계획에 명시한다.**
- **Mac이 깨어 있어야 한다.** 코드에는 슬립 방지 장치가 없다. `src`, `api-server.ts`, `src-tauri/src`에 `caffeinate`나 IOPM이 한 건도 없다 [V]. 그래서 MVP에 opt-in 슬립 방지를 넣고, 「Mac이 N분 전부터 응답 없음 (잠자기일 수 있음)」 문구를 보여 준다.
- **MVP에서 손목 알림은 iPhone이 잠겨 있을 때만 온다.** 워치 미러링이 그렇게 동작한다 [I, Apple Support 108369]. v2에서는 워치 앱이 자기 APNs 토큰을 받아서 이 제약을 없앤다.
- **푸시 인프라는 멀티테넌트 문제가 있다.** `.p8` 키는 개발자 팀(`DA8QKAQ2C9`)의 것이다. 그런데 사용자마다 자기 Supabase를 쓰므로, 사용자 Supabase의 Edge Function에 `.p8`을 넣으면 배포할 수 없다. MVP는 **개인용 단일 테넌트**라고 명시하고, 다른 사용자에게 배포하기 전에 개발자가 운영하는 푸시 게이트웨이로 옮긴다(결정 Q1).

---

## 2. 핵심 사용자 시나리오

아래 시간은 모두 P0 실측 전 추정치다 [I].

| # | 시나리오 | 흐름 | 단계 | 목표 시간 |
|---|---|---|---|---|
| S1 | 「차례 끝남 · 다음 지시 가능」 | 햅틱 → 「ShadowLoop · claude — 차례 끝남」 → 본문을 탭하면 iPhone에서 **그 워크룸**이 열린다(딥링크) | MVP | 신호 발생 → 손목 p50 ≤10초 / p95 30초 (iPhone이 잠긴 상태) |
| S2 | 「권한 승인 대기」 | 같은 방식이지만 손목 응답은 없고 「iPhone/Mac에서 확인」만 가능 | MVP | S1과 같음 |
| S3 | 종료/실패 | 「…종료(코드 1)」. hook이 없는 에이전트는 「출력이 N초째 멈춤(추정)」으로 표시하고 「완료」라고 쓰지 않는다 | MVP | S1과 같음 |
| S4 | 아젠투지·담당자 부르기 | v2: 워치 **고정 목록**(`favorite`, pinned 순서) → 탭 → 실행 중인 최신 세션을 재사용하거나, 확인 후 권한 우회 없이 새로 시작 | MVP: 리졸버 수정과 iPhone 딥링크. 손목 부르기는 v2 | 1탭. 한가하던 Mac은 ≤20초이며 「Mac 깨우는 중」 표시 |
| S5 | **음성으로 부르기 (v2 핵심)** | 「아젠투지 불러줘」·「헤르메스 담당자」 → 워치 받아쓰기 또는 Siri/Action 버튼 → **워치 허용 목록(프로젝트 1~5개 + 아젠투지) 안에서만** 매칭 → 하나면 바로 열기, 모호하면 후보 탭 | v2 | 1발화 (모호할 때만 +1탭) |
| S6 | 진행 확인 | 세션 카드: 상태, 마지막 출력 경과 시간, 크롬을 뺀 마지막 응답 2~6줄, 컨텍스트 % | v2 | 알림이나 홈에서 1탭 |
| S7 | 중간 지시 | **빠른 답장 프리셋**(고정한 간단 프롬프트) 또는 받아쓰기 → 원문 그대로의 초안 → **보내기** 탭 → 「보냄·확인됨 / 실패(이유) / 전달 미확인」 | v2 | 5~8초 |
| S8 | CLI 권한 프롬프트 응답 | MVP와 v2에서는 막는다. v3 연구 과제이며 보안 결정 문서가 먼저 있어야 한다 | v3 | — |

**알림 종류는 사용자에게 두 가지만 보인다**(UX H5). 이유는 이렇다.
- 권한 우회가 기본으로 켜져 있어서(`src/AiTerminalPanel.tsx:47` [V]) 대부분의 「대기」는 사실 「차례 끝남」이다.
- Claude의 `Stop`과 idle `Notification`이 같은 차례에 두 번 울린다 [I]. 그래서 같은 세션에서 `Stop`이 N분 안에 이미 났으면 idle 알림은 버린다.

**알림 피로 대책**(UX H6):
- 기본적으로 **따라가는 워크룸**만 알린다. 따라가는 워크룸은 폰이나 워치에서 시작·열람했거나 「따라가기」를 켠 워크룸이다.
- 기본값은 「2분 넘게 돈 차례만」 알리는 것이다.
- 5분 안에 여러 세션이 끝나면 요약 알림 1건으로 묶는다.

---

## 3. 아키텍처와 데이터 흐름

```
 Claude PTY ─ launch 범위 --settings hooks(Notification/Stop) [I] ─┐
 Codex PTY  ─ -c notify=… [I] ─────────────────────────────────────┤ POST 127.0.0.1:<발견된 포트>/api/workroom-signal
 모든 에이전트 ─ 종료 핸들러 + 「조용함」 휴리스틱(opt-in) ─────────┤ (프롬프트·도구 내용은 즉시 버린다)
                                                                     ▼
 MAC 사이드카: WorkroomSignalBus (차례끝남|승인대기|종료|실패|조용함, 출처 hook|exit|추정,
               세션·종류별 병합, 세션·전역 예산, 조용한 시간, 음소거, Mac에서 보고 있으면 억제)
   ├─► notify-devices Edge Fn  ← host_id + host_secret 인증 (authorize_host 재사용), 본문은 enum+불투명 id뿐
   │      → APNs → iPhone(잠김) → 워치 미러링             [MVP, 단일 테넌트]
   │      → APNs → 워치 앱 자체 토큰                       [v2]
   ├─► (선택) 알림 전용 Telegram 봇 — 응답 기능 없음       [P0 유용성 실험]
   └─► follow-warm: 신호 뒤 3분 동안 릴레이 폴링 ≤5초, 호스트당 시간당 ≤20분

 SUPABASE: portmgr_push_devices (RLS, anon 회수, 키 (owner, controller_session, host_id), 30일 TTL)
           relay-proxy Edge Fn [v2]: 워치 기기 키 ECDSA 서명 + 타임스탬프·nonce 검증
             → 새 RPC controller_*_for_device (service_role 전용, 그 세션 하나만)
 iPHONE:   aps-environment, 알림 카테고리, NSE + App Group 이름 캐시(bridge가 채움),
           agentstoz://workroom 딥링크(세션을 "선택"만 하고, 기존 워크룸을 끝내지 않음)
           v2 「Apple Watch에 연결」: 네이티브 스캐너가 claim하지 않고 → WatchConnectivity sendMessage
 WATCH v2: SwiftUI, RelayKit(Swift 포팅: P-256 ECDH/HKDF/AES-GCM, seq/ack, strict normalizer),
           URLSession HTTPS만 사용. LANClient·WKWebView·WebRTC 없음, Supabase 토큰 없음
```

**각 구성 요소의 역할**
- **Mac**은 단일 정본이다. 대상 해석, 신호, digest, 레닥션, grant와 terminalPolicy 강제, 음성 API 키를 모두 Mac이 가진다.
- **Relay**는 E2E 암호문과 세션 메타데이터만 다룬다.
- **iPhone**은 푸시 토큰 등록, 알림 UI, 딥링크, 워치 페어링 전달을 맡는다. 페이지의 세션을 밖으로 내보내지 않는다(`NativeOAuthRequest.swift:3` 불변식 유지).
- **워치**는 자기 릴레이 세션(v2)과 라벨, 짧은 TTL digest를 **메모리에만** 둔다.

**여러 Mac**(완결성 H2, 메모리 노트: Mac 2대 운용):
- 페이로드에 `hostId`를 넣는다.
- `agentstozNotify` 브리지가 페이지를 불러올 때마다 `{hostId→기기 이름, projectCode→이름}` 캐시를 App Group에 쓴다.
- 캐시에 없으면 16진 코드 대신 「<기기> · 프로젝트 1개 · 차례 끝남」으로 떨어진다.
- 음소거와 조용한 시간은 호스트별로 둔다.

**재시작 내성**(완결성 H3):
- 딥링크와 워치 상태에는 `sessionId`만 넣지 않고 **`hostId + targetId + agent`**를 넣는다. `sessionId`는 힌트로만 쓴다.
- 링크를 열면 실행 중인 최신 세션으로 다시 해석한다. 세션이 없으면 「이 워크룸은 종료되었습니다 — 새로 시작?」을 보여 준다.
- 사이드카가 시작될 때 「Mac 앱이 다시 시작됨 — 워크룸 N개 종료」 신호를 1건 낼 수 있다.

---

## 4. 보안과 확인 정책

### 4.1 호스트가 강제하는 정책 (보안 H1)
UI에서 막는 것만으로는 부족하다. 변조되었거나 버그가 있는 클라이언트는 그 제한을 그냥 지나친다. 그래서 grant(`src/remoteTerminalGrant.ts`, `workspaceScopes` 옆)에 **`terminalPolicy`**를 추가하고, `aiTerminalRemoteGateway.ts`에서 `perform` 전에 강제한다.

```
terminalPolicy: { allowBypassStart:false, allowRawKeys:false, allowResize:false,
                  allowClose:false, textOnlyInput:true, requireFreshView:true }
```
- `textOnlyInput`은 다음 입력을 거절한다.
  - 제어 바이트(`\x00-\x1f`, `\x7f`, `\x9b`). 끝의 `\r` 하나는 허용한다.
  - 본문 중간의 `\r`, `\n`.
  - 승인처럼 생긴 본문(y/n/yes/no/1–9 단독, 빈 입력).
- **프리셋은 Mac 운영자가 SAS 승인 화면에서 고른다.** 클라이언트가 마음대로 정하는 `controller_name`(1~80자)에서는 절대 가져오지 않는다.
- 워치 `start`는 이 정책에 따라 항상 `bypassPermissions:false`다. `cols/rows`에는 **고정된 데스크톱급 크기**를 보낸다(폰 포털 기본값과 같은 값, [I] 확인 필요). `resize`는 보내지 않고 RelayKit 단위 테스트로 막는다(완결성 H4).
- 실행 세션 상한 12개(`aiTerminalService.ts:258` [V])에 걸리면 부르기 실패 상태로 명확히 보여 준다.

### 4.2 오래된 화면에서 보낸 텍스트가 승인이 되는 문제 (보안 H3)
`expectedInputRevision`은 입력 횟수만 센다(`aiTerminalService.ts:295-296` [V]). 그래서 출력이 권한 메뉴로 바뀐 것을 알지 못한다. 대책은 다음과 같다.
- 워치 입력에는 **`expectedInputRevision`과 `expectedOutputCursor`가 반드시 있어야 한다.** v2 첫날부터 필수다. digest는 새 op이므로 호환 비용이 없다.
- 다음 경우 호스트가 「화면이 바뀌었습니다 — 다시 확인」으로 거절한다.
  - 출력이 커서보다 허용치 이상 진행된 경우.
  - 그 세션에 hook 출처의 「승인 대기」 신호가 남아 있는 경우.
- 첫 바이트가 메뉴 키가 되지 않도록 bracketed paste나 중립 접두어를 쓴다. CLI마다 동작이 다르므로 스파이크로 확인한다 [I].
- **digest를 지원하지 않는 옛 호스트에서는 워치를 보기 전용으로 둔다.** 필수 검사를 강제할 수 없는 곳에는 보내지 않는다.
- 초안에 `createdAt`을 넣고, 호스트는 120초가 넘은 초안을 거절한다. 오프라인이나 대기열에 있던 지시는 절대 나중에 자동으로 보내지 않고, 워치에서 다시 확인받는다.

### 4.3 아젠투지(OPS)의 범위 문제 (보안 H2)
아젠투지 채팅은 Control 프로젝트에서 **실행 중인 최신 Codex 세션**을 재사용한다(`src/voiceRuntimeBinding.ts:92-94` [V]). 그 세션에는 기기 grant로 제한되지 않는 MCP 도구가 있다.
- `start_workroom_session`과 `send_workroom_instruction`(`agentstoz-use-mcp-server.ts:166,182` [V])
- `create_project`(`:76`), `create_github_repository`(`:117`)

그래서 「아젠투지 + 프로젝트 1~5개」 프리셋은 실제로는 경계가 되지 못한다. 한 문장으로 모든 프로젝트에 닿을 수 있는 confused deputy 문제다. 대책은 다음과 같다.
- 워치에서 아젠투지로 보낼 때는 **호스트가 이 컨트롤러용으로 `bypassPermissions:false`로 시작한 세션만** 쓴다. 최신 세션을 재사용하지 않는다. 호스트는 각 세션을 시작할 때의 bypass 여부를 세션 레코드에 저장한다. DTO에는 넣지 않는다.
- 기기의 허용 대상 집합을 **세션별 capability 토큰**으로 아젠투지 세션에 전달한다. 사이드카는 `start/send_workroom_*` 호출에서 이 토큰을 검사하고, 범위 밖이면 403을 돌려준다.
- 이 장치가 생기기 전에는 **워치 프리셋에서 아젠투지를 뺀다.** 포함한다면 Mac 승인 화면에 「아젠투지 포함 = 모든 프로젝트 지시 가능」을 명시한다(결정 Q4).
- 모델이 만든 초안(`voice.submit`의 `draftId`)은 워치 계열 컨트롤러에서 거절한다. 워치는 사용자가 직접 한 말만 terminal `input` op으로 보낼 수 있다(보안 M4).

### 4.4 워치 자격 증명 (보안 H4, 실현성 M8)
워치 OTP 세션을 쓰면 `portmgr_is_member()`를 통과해서 모든 `portmgr_*`를 읽을 수 있다. 여기에는 장기기억 리비전과 내가 한 말 기록이 포함되고, 다른 세션을 해지하거나 `owner_disable_host`를 호출할 수도 있다 [V, `20260823000600_…sql:6-23`, `remoteControlRelaySql.ts:907-944`]. 초안이 선호하던 커스텀 role JWT도 멤버 검사에서 거절된다. 게다가 JWT 서명 비밀을 함수 안에 넣어야 한다.

**채택하는 방식**
- 워치는 **Supabase 자격 증명을 갖지 않는다.**
- claim할 때 워치 기기 키(Secure Enclave P-256 [I, watchOS 지원 여부는 P0-7에서 확인])의 공개키를 `(host_id, session_id, controller_id)`에 묶어 등록한다.
- `relay-proxy` Edge Function이 요청마다 ECDSA 서명과 타임스탬프·nonce(재전송 방지)를 검증한다. 검증을 통과하면 **새 `controller_send/receive/ack/session_status_for_device` RPC**(service_role 전용)를 그 세션 하나에 대해서만 부른다.
- 워치를 잃어버려도 새는 범위는 해지 가능한 릴레이 세션 1개뿐이다.
- 대안(비권장): OTP 세션을 쓰는 경우 7일 grant, 72시간 유휴 시 자동 해지, `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`를 적용하고 사용자가 위험을 명시적으로 수락해야 한다.

### 4.5 푸시 인증과 내용 (보안 H5, 실현성 H2, 완결성 H1)
- `notify-devices`는 **`host_id + host_secret`을 기존 `portmgr_remote_control_authorize_host`로 검증한다**(`remoteControlRelaySql.ts:212-234` [V]). 사용자 JWT만으로는 절대 보낼 수 없다.
  - 참고: HMAC은 해시만 저장된 상태로는 검증할 수 없다. 그래서 기존 호스트 RPC와 같은 비밀 제시 방식을 따른다. 호스트 공개키 서명은 추가 강화 옵션으로 둔다 [I].
- 요청 본문은 `kind` enum과 불투명 id뿐이다. 문구는 서버의 **고정 템플릿**으로만 만든다. 승인이나 자격 증명을 요구하는 종류의 알림은 존재하지 않는다.
- 같은 호스트의 활성(approved, 미해지, 미만료) 릴레이 세션에 묶인 토큰에만 보낸다. 호스트당 속도 상한을 둔다(예: 시간당 30건).
- 기본 알림 문구는 일반 문구 「AgentsToZ: 워크룸 업데이트」다. 프로젝트 이름은 NSE가 **숨김 미리보기**로만 채운다(`hiddenPreviewsBodyPlaceholder`). NSE가 실패해도 아무것도 새지 않는다(보안 M1).
- `projectCode`는 식별 정보로 취급한다. 익명값이 아니다.

### 4.6 워치에서의 동작별 정책

| 동작 | 허용 | 확인 | 비고 |
|---|---|---|---|
| 알림 보기, 본문 탭(딥링크) | MVP | 없음 | 알림 동작 버튼 「iPhone에서 열기」는 **없앤다**(실현성 H3) |
| 「1시간 조용히」 | MVP | 없음 | iPhone NSE가 App Group의 음소거 값을 보고 `.passive`로 낮춘다. 햅틱 억제 여부는 P0-11에서 확인 |
| 세션 목록, digest, 호스트 상태 | v2 | 없음 | 레닥션은 Mac에서 한다. `Text(verbatim:)`로 표시하고 링크 감지는 끈다 |
| 사용자가 직접 한 말로 지시 | v2, Mac 설정 「지시까지」(기본 꺼짐) | **초안에서 보내기 1탭**. 더블 탭에는 연결하지 않는다 | 안정적인 `requestId`(`aiTerminalService.ts:186-193` [V])와 4.2의 필수 검사 |
| 권한 우회 세션으로 지시 | v2 | 빨간 「승인 없이 실행 (권한 우회)」 칩. **세션당 하루 첫 전송**에만 2차 확인 | digest에 `bypass` 필드를 **처음부터** 넣는다 |
| 새 워크룸 시작 | v2 | 확인 탭 | 항상 권한 우회 없이 시작한다 |
| 권한 우회 시작, raw 키, Ctrl+C, 크기 조절, 닫기, git/워크트리, `tester.run`, `duty.*`, 기억 저장·승인, SAS·grant 변경 | **절대 불가** | — | 호스트 `terminalPolicy`와 grant 프리셋으로 막는다 |
| CLI 권한 프롬프트 응답 | v3 연구 | 길게 누르기와 정확한 명령을 보여 주는 두 번째 화면 | 한 번만 허용. 명령이 N자를 넘거나 `; | && $(`가 들어 있으면 거절. 감사 로그를 남기고, 권한은 hook이 아니라 릴레이 세션에서 나온다 |

### 4.7 신호 위조
환경변수로 넘긴 nonce는 에이전트도 읽을 수 있다. 에이전트와 hook이 같은 OS 사용자로 돌고, loopback은 Origin 없이 받는다(`api-server.ts:9299-9303` [V]). 따라서 **신호는 원래 위조 가능하다.** 대책:
- 신호는 표시용으로만 쓰고 출처를 표시한다.
- 세션·전역 예산을 둔다.
- follow-warm은 호스트당 10분에 1회, 시간당 상한을 둔다.
- hook 명령은 고정된 helper 경로로 만든다. 프로젝트 이름과 경로를 셸 문자열에 끼워 넣지 않는다.
- nonce는 교차 오염 방지용일 뿐 보안 경계가 아니다.

### 4.8 감사와 분실 대응
- Mac 원격 기기 목록에 「Apple Watch · 마지막 N일 전」과 해지 버튼을 둔다. 컨트롤러별 로그에는 시각, 대상, 지시 앞 60자와 해시, 결과를 남긴다.
- 페어링할 때 워치의 `session_id`를 iPhone App Group에 저장해서 「워치 분실 — 연결 끊기」로 `revoke_session`을 부를 수 있게 한다(보안 L5).
- 워치에서 연결을 해제하면 `session.end`를 보낸다.

---

## 5. 프로토콜과 버전 영향

- **기능 문자열은 상한이 이미 찼다.** 8/8이다(`src/remoteControlInternetAgent.ts:497-504`, `src/remoteControlProtocol.ts:13`). 그래서 **새 기능 문자열을 추가하지 않는다.** `REMOTE_CONTROL_PROTOCOL_VERSION`은 MVP와 v2 모두 `agentstoz-local-v9`를 유지한다.
- **기존 DTO를 확장하지 않는다.** `AiTerminalSummary`, 프로젝트 카드, 워크스페이스 액션의 정규화기는 모르는 키를 거부한다. 음성용 「부르는 이름」 필드는 카드 DTO를 바꾸므로 **보류**한다(호환 파괴와 버전 상승이 필요하다).
- **digest(v2)는 새 terminal op이다.**
  - 권한은 `read`와 같다.
  - 형태: `{state, exitCode, agent, label, lastOutputAt, outputCursor, inputRevision, bypass, signal|null, tail[≤6×≤80자], contextPct|null}` (≤8,500B)
  - 호스트에 청크별 타임스탬프를 추가해야 한다.
  - 옛 호스트가 모르는 op을 거절하는 **정확한 오류 코드를 fixture로 고정**한다. 일반 실패를 「미지원」으로 읽지 않는다. 결과는 다음 `session.ready`까지 호스트별로 캐시한다.
  - 미지원 호스트에서는 워치를 보기 전용으로 두고 `read{snapshot:true}`로 떨어진다.
- **digest 내용**(UX M4, 보안 M2):
  - 원시 스트림이 아니라 headless 화면의 렌더된 행(`aiTerminalScreen.ts:89-106` [V])으로 만든다.
  - 에이전트별 입력창, 상태줄 크롬을 **제거**한다.
  - `Stop` hook이 난 경우 Mac 로컬 transcript의 마지막 assistant 메시지 앞 2줄을 쓴다(레닥션을 거치고 E2E로만 보낸다). APNs에는 넣지 않는다.
- **공유 레닥터**: 지금 `voiceOutput`(`voiceRuntimeBinding.ts:24-28` [V])은 좁다. 여기에 다음을 추가한 단일 모듈과 비밀 fixture 골든을 만든다.
  - AWS 키(`AKIA…`, `AWS_SECRET_ACCESS_KEY=`), PEM, `sb_secret_`, `xox*`, Telegram 봇 토큰, 홈 절대경로, 이메일
  - DCS/C1/bidi/zero-width 문자 제거
- **입력 op의 새 필드**(`expectedOutputCursor`, `createdAt`)는 digest를 지원하는 호스트에만 보낸다. 같은 probe 결과로 보낼지 정한다.
- **푸시 등록은 릴레이를 거치지 않는다.** 인증된 iPhone 페이지가 RLS 테이블에 직접 upsert한다. Vercel 포털에는 네이티브 브리지가 없으므로 등록은 no-op이다.
- **TS와 Swift가 함께 읽는 골든 fixture**:
  - 릴레이 암호 벡터(`remoteControlRelayCrypto.ts:15-22,302-345`). 랜덤 96비트 nonce와 바이트 단위로 같은 AAD(보안 L1)
  - SAS, 봉투, 정규화기
  - digest DTO, 레닥터, 대상 리졸버
  - APNs 페이로드 스키마, 딥링크 문법(워크룸 팝아웃 골든 패턴)
  - 프로토콜 상수 고정 테스트
- **배포 순서**: 마이그레이션(승인 후) → anon 401 확인 → Edge Function 배포 → DMG(신호 방출은 플래그 뒤) → iOS/워치 TestFlight → Vercel push는 마지막. 「Mac 앱 업데이트 필요」와 「워치 앱 업데이트 필요」는 따로 표시한다.

---

## 6. Mac 쪽 신호 작업

| 에이전트 | 출처 | 승인 대기 | 차례 끝남 | 종료/실패 | 확실성 |
|---|---|---|---|---|---|
| Claude | launch 범위 `--settings <json>` hook [I]. `session_id` = 워크룸 id(`aiTerminalLaunchArgs.ts:7` [V]) | `Notification`(권한) [I] | `Stop` [I]. 같은 차례의 idle `Notification`은 버림 | 종료 핸들러 | 확인됨 |
| Codex | `-c notify=[helper]` [I]와 워크룸 id env(이름이 `CAPABILITY`로 끝나지 않게) | 없음 | turn-complete [I] | 종료 핸들러 | 준구조 |
| Hermes, agy | 없음 | — | 「조용함 N초」 (opt-in, 「추정」 라벨) | 종료 핸들러 | 추정 |

**만들 것**
1. `POST /api/workroom-signal`: loopback 전용이고 세션 nonce를 확인한다. **프롬프트와 도구 내용은 즉시 버린다**(`.agent-memory/activity-hook.sh`와 같이 토큰 없음).
2. `WorkroomSignalBus`: 병합, 예산, 조용한 시간, 음소거, Mac에서 그 워크룸을 보는 중이면 억제한다(완결성 M6).
3. 세션별 `lastOutputAt`.
4. 푸시 디스패처: `host_secret` 인증, `apns-collapse-id = host+session+kind`, 410 토큰 삭제.
5. **per-project 생성기가 아니라 launch 범위로 주입한다.** 생성기를 바꾸면 전 프로젝트의 `CURRENT_PROJECT_MEMORY_VERSION`이 올라간다.
6. **hook 주입 세부**(완결성 H8), 모두 P0-2 통과 기준에 넣는다.
   - `--settings`가 프로젝트 `.claude/settings.json`(`UserPromptSubmit`)과 사용자 전역 hook에 **병합되는지 대체되는지** 확인한다.
   - helper는 앱 업데이트 뒤에도 안정적인 앱 리소스 경로에 둔다. `src/`에 두지 않는다.
   - dev api-server가 3001을 잡고 있을 수 있으므로 포트를 발견하는 방식으로 호출한다.
   - `.env`와 중립 cwd 규칙을 지킨다.
   - 생성되는 launch args와 settings JSON을 골든 테스트로 고정한다.
7. 프로젝트 설정에 `disableAllHooks` 같은 것이 있으면 「신호 출처 없음」으로 표시한다. 조용한 것을 유휴 상태로 오인하지 않게 한다.
8. **opt-in 슬립 방지**(UX H4): 원격제어가 켜져 있고 실행 중인 워크룸이 있을 때만 `caffeinate -i -w <사이드카 pid>` 자식을 둔다 [I].
9. 신호는 표시용 근거일 뿐이다(`src/workroomSessionStatus.ts:1`). PTY 텍스트를 보고 「완료」라고 주장하지 않는다.

**Supabase 부하 예산**(완결성 H6): 호스트 폴링은 한 번에 service_role RPC 2건과 행 쓰기를 발생시킨다(`remoteControlInternetAgent.ts:95-133` [V]).
- 워치는 화면이 보일 때만 ≥2초 간격으로 폴링하고, 손목을 내리면 멈춘다.
- follow-warm은 신호당 3분, 호스트당 시간당 ≤20분으로 제한한다.
- P0에서 하루 RPC와 행 쓰기 수의 기준선을 재고, 수용 기준에 상한을 넣는다.

---

## 7. 단계별 로드맵

### Phase 0: 스파이크 (각각 예/아니오 하나를 답한다)

| # | 질문 | 통과 기준 |
|---|---|---|
| P0-1 | `AgentsToZCore`에 `.watchOS(.v10)`을 추가하고 `LANClient/LANPairing`을 빼면 빌드되는가 | `xcodebuild -destination 'generic/platform=watchOS'` 성공 |
| P0-2 | 워크룸 PTY에서 Claude `--settings` hook이 병합되는가, payload의 `session_id`가 워크룸 id인가 | 실측 payload 일치, 병합 여부 기록 |
| P0-3 | Codex `-c notify`가 워크룸 PTY에서 차례마다 호출되는가 | helper 호출 기록 |
| P0-4 | 알림 전용 Telegram 봇으로 손목 두드림이 실제로 쓸모 있는가 | 사용자 판단(결정 Q6) |
| P0-5 | 폰을 끈 상태에서 워치 URLSession이 Wi-Fi/LTE로 Supabase에 닿는가, p50/p95는 얼마인가 | 왕복 성공과 수치 |
| P0-7 | watchOS에서 CryptoKit P-256/HKDF/AES-GCM과 Secure Enclave P-256을 쓸 수 있는가, TS 벡터와 일치하는가 | 골든 통과 |
| P0-9 | 10분 이상 유휴 뒤 첫 탭 지연, follow-warm 적용 시 지연 | 한가할 때 ≤20초, warm ≤5초 |
| P0-10 | 알림 본문 탭 → iPhone에서 사용 가능해질 때까지의 시간(딥링크) | 측정값을 MVP 목표로 사용 |
| P0-11 | NSE로 `.passive`로 낮추면 워치 햅틱이 멎는가 | 예/아니오 |
| P0-12 | watchOS에 `UNNotificationServiceExtension`이 정말 없는가, 커스텀 long-look PoC는 되는가 | 문서와 기기 확인 |
| P0-14 | `INAlternativeAppNames` 「아젠투지」와 고정 엔티티 한국어 구문이 실기기 Siri에서 동작하는가 | 호출 성공 |
| P0-15 | 개발자 `.p8` 하나로 운영하는 게이트웨이 PoC(설치별 자격, production/sandbox) | 결정 Q1이 게이트웨이일 때만 |
| P0-16 | 기기 키 서명 relay-proxy + `_for_device` RPC | 릴레이 RPC는 성공하고 `portmgr_ports` 접근은 실패 |
| P0-17 | 입력 첫 바이트 중립화(bracketed paste)가 Claude와 Codex 메뉴를 선택하지 않는가 | 두 CLI 모두 통과 |

초안의 P0-6(커스텀 role JWT)은 P0-16으로 대체하고, P0-8(Siri AI)은 P0-14로 대체했다.

### MVP: 「알림 → iPhone에서 바로 그 워크룸」 (워치 앱 없음)

**범위**
- §6 신호 작업과 opt-in 슬립 방지. 「Mac이 N분 전부터 응답 없음 (잠자기일 수 있음)」 문구를 `host_last_seen_at` 기준으로 보여 준다.
- `notify-devices` Edge Function(**개인용 단일 테넌트**라고 명시, `host_secret` 인증, 고정 템플릿, 속도 상한, 환경변수 kill switch).
- `portmgr_push_devices` 마이그레이션. **커밋만 하고, 사용자가 승인하기 전까지 적용하지 않는다.** 적용한 뒤에는 anon SELECT 401과 **다른 authenticated 사용자** 격리를 확인한다. 미적용이면 PGRST205와 404를 「알림 저장소가 아직 준비되지 않았습니다」로 표시한다.
- iPhone
  - `aps-environment`, Time Sensitive(「승인 대기」에만 사용)
  - 카테고리 두 가지, NSE와 App Group 캐시, `agentstozNotify` 브리지
  - 로그아웃·`session.end`·연결 해제 시 토큰 삭제, 실행할 때마다 재등록
  - `agentstoz://workroom?host=…&target=…&agent=…[&session=…]`: 불투명 id만 싣고, **세션을 선택만 하며 기존 워크룸을 끝내지 않는다**(UX H3). 「Mac 연결 중 → 세션 여는 중」 단계 표시
- **리졸버 수정**(MCP·음성·워치 공통, `src/conversationTargetAlias.ts`)
  - 앞뒤의 `담당자`를 허용한다.
  - `aiName`을 **정확히 일치**하는 경우에만 허용한다.
  - 필드끼리 충돌하면 AMBIGUOUS로 처리한다.
  - AMBIGUOUS와 NOT_FOUND일 때 **기기 grant로 거른** `candidates[]`(최근 사용 순, 최대 5개)를 돌려준다.
  - 퍼지나 음차 매칭으로 자동 선택하지 않는다(보안 M5).
  - 영어 이름의 한국어 음차 세트는 골든에 「실패가 기대값」으로 넣어 한계를 드러낸다.
- follow-warm(상한 적용).
- 조건부 P0.5(Q6 = 예): **별도의 알림 전용 Telegram 봇.** `project code + kind`만 보내고 답장 기능은 없다. Hermes 봇에 답장하는 것은 워크룸이 아니라 Hermes로 가는 별개의 제어 채널이기 때문이다(완결성 H7, 보안 M9).

**수용 기준**
1. iPhone이 잠긴 상태에서 워크룸 차례가 끝나면 손목 p50 ≤10초, p95 ≤30초 안에 알림이 온다. 잠금이 풀려 있으면 iPhone 배너가 ≤10초 안에 뜬다.
2. 종료는 코드와 함께 1회만 알린다. 같은 차례의 `Stop`과 idle 알림은 1건이다.
3. APNs 페이로드에 이름이나 터미널 텍스트가 없다(스키마 골든).
4. `host_secret`이 틀리면 401이고, 다른 사용자의 호스트로 가는 토큰은 0개다.
5. Mac에서 컨트롤러를 해지하면 그 기기로 가는 푸시가 멈춘다.
6. 음소거, 조용한 시간, 「Mac에서 보는 중」 억제가 지켜진다.
7. 「헤르메스 담당자」가 해석되고, 모호하면 후보가 나온다.
8. 사이드카를 재시작한 뒤 딥링크가 「종료됨 — 새로 시작?」으로 우아하게 떨어진다.

**테스트**
- `bun test`: 신호 bus(병합·예산·억제), nonce 거절, hook 내용 폐기, launch-arg와 settings 골든, 디스패처 스키마 골든, 리졸버 골든, 딥링크 골든(TS·Swift 공유).
- Deno: 인증, 소유자 범위, 속도 상한.
- RLS 확인.
- iOS: 카테고리와 NSE 매핑, `xcrun simctl push`.
- TestFlight 기기 체크리스트. 「개인 테스트」 그룹 추가, NSE App ID와 App Group을 웹사이트에서 수동 등록하는 단계를 포함한다.

### v2: 「손목에서 부르고 지시」 (독립 워치 컨트롤러)

**관문**: Q2가 결정되고 P0-1/5/7/16이 통과해야 한다.

**범위**
- 워치 타깃 `$(AGENTSTOZ_APP_BUNDLE_ID).watchkitapp`을 번들 변형마다 만든다. 워치 전용 App Group과 확장 ID도 필요하다.
- RelayKit(릴레이 TS 약 2.8k LOC의 Swift 포팅). send seq와 receive 커서는 키와 원자적으로 저장하고, 복원 시에는 재페어링한다.
- **페어링**(완결성 H9, 보안 M3)
  - iPhone **네이티브 스캐너**의 claim하지 않는 모드로 스캔한다.
  - 두 앱이 모두 전경에 있는 상태에서 `WatchConnectivity sendMessage`로 전달한다. `transferUserInfo`는 디스크에 남으므로 쓰지 않는다. TTL은 짧게 둔다.
  - 워치 기기 키로 claim한다.
  - **Mac에서 워치에 표시된 6자리를 입력해 확인한다.**
  - Mac 승인 화면에는 자기 보고 이름 대신 키 지문과 운영자가 고른 프리셋을 보여 준다.
- 「iPhone과 워치 함께 연결」을 한 자리에서 진행하면 30일 만료일이 맞춰진다(`remoteControlRelaySql.ts:88` [V], 고정 만료). 워치에 남은 일수와 D-3 알림을 표시한다.
- 「워치」 grant 프리셋: 프로젝트 1~5개, `workspaceScopes:[]`, §4.1 `terminalPolicy`. 아젠투지는 §4.3 조건을 만족할 때만 넣는다.
- **부르기는 기존 op만 조합한다**(UX H2). 탭이든 음성이든 도착점은 같다. 고정 목록에서 `targetId` → terminal `list` → 실행 중인 최신 세션을 재사용하거나, 확인 후 `start`(권한 우회 없음, 고정 크기). 음성 세션(15분 제한, 20초 heartbeat, 대상별 소유자 1명, `voiceSessionHost.ts:195-201` [V])은 쓰지 않는다.
- **음성 부르기는 v2 핵심 기능이다** (2026-09-28 사용자 결정으로 보조 → 핵심 승격).
  - 매칭 대상은 워치가 이미 받은 **grant 범위 목록**(프로젝트 1~5개 + 아젠투지)뿐이다. 그래서 새 워크스페이스 액션·기능 문자열이 필요 없고, 호스트는 어차피 grant 밖 대상을 거절한다.
  - 매칭 규칙은 `src/conversationTargetAlias.ts`(MVP에서 고친 리졸버)와 **같은 골든 표**를 TS·Swift가 함께 읽어 고정한다(`tests/fixtures/…-golden.json`, 워크룸 팝아웃·tmux 골든 패턴). 워치가 규칙을 따로 발명하지 않는다.
  - 결과: 정확히 1개 → 바로 부르기 / 여러 개 → 후보 탭 / 0개 → 「허용 목록에 없음 — Mac에서 워치 허용 대상에 추가하세요」 + 허용 목록 표시. 퍼지·음차 자동 선택은 하지 않는다.
  - 입구 3개: 워치 앱 마이크 버튼(받아쓰기) · Siri(App Intents, 허용 프로젝트 = `AppEntity`) · Action 버튼(Ultra)·스마트 스택 위젯. 받아쓰기 원문도 화면에 보여 준다(무엇으로 알아들었는지).
  - 오디오를 Mac으로 보내는 방식(원격 받아쓰기·실시간 마이크)은 **하지 않는다** (사용자 결정).
  - 아젠투지: **부르기·보기는 v2 기본 허용**, **지시 보내기**는 §4.3 조건(세션별 capability 토큰으로 아젠투지의 MCP 범위를 워치 grant로 제한)을 만족해야 켠다.
- 워치 자체 APNs 토큰으로 「차례 끝남」과 「전송 결과」를 직접 푸시한다(실현성 H4). 워치에는 NSE가 없으므로 일반 alert와 커스텀 long-look(`WKUserNotificationHostingController`)을 쓰고, long-look은 워치 자체 캐시로 이름을 채운다(실현성 H5).
- **일시 정지 내성**(실현성 H6, UX H7)
  - 보내기 전에 `{requestId, draftId, target, sentAt}`를 저장한다.
  - 다시 활성화되면 **requestId로 조회만 하고 재전송하지 않는다.**
  - 결과는 「보냄·확인됨 / 실패(이유) / 전달 미확인 — 다시 보내지 마세요, 확인 중」 세 가지로 보여 준다.
  - 새 `requestId`를 만드는 재시도 버튼은 없다.
  - 앱이 활성화되면 가벼운 read를 1회 보내 호스트를 미리 깨운다.
- **화면 3개만 만든다**(UX M2).
  - **지금**: 나를 기다리는 세션 카드. 답장과 열기를 제공한다.
  - **부르기**: 고정 목록(`src/pinnedOrder.ts` 순서) 다음에 최근 목록.
  - **설정**: 페어링 상태, 남은 일수, 연결 해제.
- 빠른 답장 프리셋은 고정한 **간단 프롬프트**(`src/promptLibrary.ts` `promptKindOf`)를 재사용한다. 사용자 본인이 한 말로 취급하고, 받아쓰기는 대안 수단이다. 대상 칩은 엔티티 선택기로 고칠 수 있다.
- 더블 탭은 새로고침이나 열기에만 쓰고 보내기에는 쓰지 않는다. 화면 버튼도 반드시 같이 둔다(Series 9 이상만 지원).
- App Intents: 매개변수 없는 「아젠투지에 지시」 고정 단축어와 고정 프로젝트 `AppEntity`. 의도는 `projectId`를 보낸다. `INAlternativeAppNames`에 아젠투지와 에이전츠투지를 넣는다. 개발 빌드는 「아젠투지 개발」과 겹치지 않는 다른 발화 이름을 쓴다(실현성 M1).
- 상태를 바꾸는 intent는 `.requiresAuthentication`을 쓰고, 보내기에는 손목 착용 인증을 요구한다 [I]. 딥링크는 화면 이동만 한다(보안 M6).
- 표시할 때 `isLuminanceReduced`와 잠금 상태면 tail을 숨기고 `.privacySensitive()`를 적용한다. VoiceOver와 Dynamic Type을 지원한다.
- CI: `verify.yml` native-ios job에 watchOS 빌드와 `swift test`를 추가한다. `bun run verify`는 iOS를 다루지 않는다.

**수용 기준**
1. 고정 프로젝트 부르기가 1탭이고, 실행 중이면 재사용하고 아니면 확인 후 시작한다.
1a. 「아젠투지 불러줘」·「<프로젝트> 담당자」·「<프로젝트> 프로젝트담당자」·프로젝트 이름만 — 네 형태가 음성·Siri 모두에서 같은 대상에 도착한다(TS·Swift 공유 골든). 허용 목록 밖 이름은 0개 결과로 정직하게 안내된다.
2. 강제로 재시도해도 정확히 1회만 반영된다.
3. 출력 커서가 오래된 전송은 호스트가 거절하고 UI가 다시 불러온다.
4. 옛 호스트에서는 보기 전용이다.
5. 폰을 끈 상태에서도 동작한다.
6. Mac에서 해지하면 폴링 1회 안에 반영된다.
7. 슬롯을 정확히 1개 쓰고, 연결 해제하면 반납된다.
8. 30일이 지나 만료되면 재페어링 안내가 나온다.
9. 레닥터 fixture(`sk-`, `ghp_`, JWT, AWS, PEM, `sb_secret_`)가 tail에 나타나지 않는다.
10. 변조 클라이언트가 권한 우회 시작, raw 키, 크기 조절을 시도하면 호스트가 거절한다.

### v3: 「구조적 승인·라이브」 (연구, 보안 관문)

**범위**
- Claude `PermissionRequest`: 한 번만 허용 또는 거부. 프로젝트별 opt-in은 Mac에서만 켤 수 있다. `workroom.approve` scope는 기본 꺼짐이다. 타임아웃은 결정 없음으로 처리하고 감사 로그를 남긴다.
- Codex 대화 질문 선택지(`questions:false`를 의도적으로 뒤집는 작업).
- Live Activity. iOS 17.2 이상이 필요하고 약 8시간 한도이므로 「몇 시간 따라가기」로 설명한다.
- watchOS 26 위젯 푸시 기반 개수 컴플리케이션. 「실시간 아님」이라고 표기한다.

**관문**: 서면 보안 결정 문서가 있어야 하고, 어떤 경로로도 자동 허용이 되지 않아야 한다.

---

## 8. 위험과 검토 반영 현황

**남는 위험**
- 새 APNs와 Edge Function 표면이 생긴다. Apple과 Supabase에는 메타데이터(시각, 종류, 코드, 호스트)가 남는다.
- Claude와 Codex hook 플래그는 아직 검증되지 않았다.
- 보안이 중요한 Swift 포팅이 약 2.8k LOC이고, TS와 Swift를 영구히 맞춰야 한다.
- 월 1회 재페어링이 필요하고, 슬롯 8개 중 1개를 쓴다.
- 한가하던 Mac의 첫 탭은 최대 20초가 걸린다.
- 번들 변형 5개 이상 × (앱, 워치, 위젯, NSE)를 웹사이트에서 수동으로 등록해야 한다.
- 물려받은 Mac 결함 중 워치가 죽은 것처럼 보이게 하는 것이 있다. 요청 핸들러 안의 동기 `bun install`, 최대 약 11분 가는 릴레이 액션 락이다.
- CLAUDE.md 「미해결 결함」 목록은 일부가 낡았다. LAN 영속과 IP 변경 항목은 「재시작은 재페어링이 아니다」 절과 모순된다. 인용하기 전에 다시 확인해야 한다.
- Orca로 분류된 Codex 세션은 사용량 패널에서 사라진다. 그래서 그 패널에서 Codex 「끝남」을 가져오지 않는다.

**MEDIUM/LOW 반영 현황**

| 지적 | 처리 | 이유 |
|---|---|---|
| 보안 M1 이름 노출, M2 레닥션, M3 SAS 입력 확인, M4 모델 초안 차단, M5 리졸버 확장 범위, M6 딥링크·intent, M7 토큰 수명, M8 신호 예산 | **채택** | 모두 저비용이고 경계를 지킨다 |
| 보안 M9, 완결성 H7 Telegram 답장 | **채택**(답장 없음, 별도 봇) | 제어 채널이 섞이는 것을 막는다 |
| 실현성 M2 위젯 푸시, M4 Live Activity | **v3로 보류** | 게이트웨이와 17.2 상향이 먼저 필요하다 |
| 실현성 M3 Controls | **MVP 제외**, v2에서 워치 자체 Control 스파이크(P0-13) | iPhone 쪽 Control은 네이티브 릴레이가 없어 무력하다 |
| 실현성 M5 토큰의 환경·topic, M6 Time Sensitive, M7 WC 전경 요구 | **채택** | 배포 필수 요소 |
| UX M1 만료 맞춤, M2 화면 3개, M3 프리셋, M4 크롬 제거, M5 우회 확인 빈도, M6 MVP 이름 정직화, M7 16진 대체 문구 | **채택** | |
| UX 「부르는 이름」 필드(H1 일부), 완결성 D7b | **보류** | 카드 DTO가 바뀌어 프로토콜 버전 상승이 필요하다. 고정 목록으로 충분한지 먼저 본다 |
| 완결성 M1 kill switch·지표, M2 APNs 수명주기, M3 미적용 저하 상태, M4 배포 순서, M5 probe 고정, M6 중복 억제, M7 grant 스냅샷 안내, M9 용어집, M10 접근성 | **채택** | `tests/ui-glossary.test.ts`를 Swift와 NSE 문자열까지 확장한다 |
| 완결성 M8 폭주 세션 중지(Ctrl+C/interrupt) | **보류**(결정 필요 시 v2 후반) | raw 키 금지 정책과 충돌한다. Codex `interrupt`만 따로 검토한다 |
| LOW 전반(Always-On 가림, 분실 해지, 120초 만료, 문서화) | **채택** | |

---

## 9. 명시적 비목표

- 워치에서 xterm 실시간 스트리밍이나 포털 UI를 띄우지 않는다. watchOS에는 WKWebView가 없다 [I].
- 워치의 LAN 제어는 하지 않는다. `LANClient`가 `URLSessionWebSocketTask`를 쓰는데(`LANClient.swift:37,140` [V]), watchOS에서는 금지다 [I, TN3135].
- 손목 실시간 음성 대 음성은 하지 않는다. 릴레이는 분당 60건인데 PCM에는 약 480건이 필요하고, WebRTC도 없다. 텍스트 받아쓰기만 쓴다.
- 워치에서 QR 스캔이나 대상 해석을 하지 않고, 음성 API 키를 두지 않는다. Supabase 자격 증명도 **두지 않는다.**
- iPhone 페이지에 의존하는 중계형 워치 앱은 만들지 않는다. 페이지의 세션이나 릴레이 키를 밖으로 내보내지 않는다.
- 터미널 텍스트로 「완료」를 주장하지 않는다. MVP와 v2에서 raw 키로 프롬프트에 답하지 않는다.
- 워치에서 되돌릴 수 없거나 권한을 부여하는 동작은 하지 않는다(§4.6).
- MVP와 v2에서 새 기능 문자열이나 프로토콜 버전 상승은 없다.
- 다른 사용자에게 배포할 때 사용자 Supabase에 `.p8`을 복사하지 않는다.

**핵심 파일**: `src/aiTerminalService.ts`, `src/aiTerminalLaunchArgs.ts`, `src/aiTerminalProtocol.ts`, `src/aiTerminalScreen.ts`, `src/aiTerminalRemoteGateway.ts`, `src/remoteTerminalGrant.ts`, `src/conversationTargetAlias.ts`, `src/voiceRuntimeBinding.ts`, `src/voiceSessionHost.ts`, `src/remoteControlRelaySql.ts`, `src/remoteControlRelayRpcClient.ts`, `src/remoteControlRelayCrypto.ts`, `src/remoteControlInternetAgent.ts`, `src/remoteControlTaskProtocol.ts`, `src/workroomSessionStatus.ts`, `src/promptLibrary.ts`, `src/pinnedOrder.ts`, `agentstoz-use-mcp-server.ts`, `mobile/ios/AgentsToZCore/Package.swift`, `mobile/ios/App/RemoteHomeView.swift`, `supabase/functions/`

---

## 사용자 결정 필요

1. **푸시 인프라를 어떻게 둘까요?** 내 Supabase Edge Function에 내 `.p8`을 넣는 개인용 단일 테넌트 방식과, 개발자가 운영하는 푸시 게이트웨이 방식이 있습니다.
   - **추천 기본값: 개인용 단일 테넌트로 MVP를 시작합니다.** 다른 사용자에게 배포하기 전에 게이트웨이(P0-15)로 옮깁니다. 마이그레이션은 커밋만 해 두고, 승인하신 뒤에 적용합니다.

2. **워치 자격 증명은 어떻게 할까요?** 기기 키로 서명한 요청을 릴레이 전용 프록시로 보내는 방식(워치에 Supabase 토큰 없음)과, 워치에서 이메일 OTP로 전체 계정에 로그인하는 방식이 있습니다.
   - **추천 기본값: 기기 키 + 릴레이 프록시입니다.** 워치를 잃어버려도 해지 가능한 세션 1개만 노출됩니다. OTP 방식은 모든 기억과 기록을 읽을 수 있는 토큰이 워치에 남습니다.

3. **워치에서 지시까지 보내도 될까요?** 권한 우회 세션으로 보내는 경우는 어떻게 할까요?
   - **추천 기본값: 「지시까지」는 Mac 설정에서 켤 때만 허용하고 기본은 꺼 둡니다.** 켜면 초안에서 1탭으로 확인하고, 호스트가 출력 커서를 검사합니다. 권한 우회 세션은 빨간 칩을 보여 주고, 세션마다 하루 첫 전송에만 2차 확인을 받습니다.

4. **아젠투지(OPS)를 워치 허용 대상에 넣을까요?**
   - **갱신된 추천 기본값 (2026-09-28, 음성 부르기 핵심화에 따라): 아젠투지를 넣되, 부르기·보기만 기본 허용합니다.** 아젠투지에 **지시 보내기**는 워치 허용 범위를 아젠투지 세션에 전달하는 장치(§4.3)가 생긴 뒤에 켭니다. 그 전에 바로 켜려면 Mac 승인 화면에 「아젠투지 포함 = 모든 프로젝트 지시 가능」을 표시합니다.

5. **자리를 비웠을 때 Mac이 잠들지 않게 할까요?**
   - **추천 기본값: opt-in입니다.** 원격제어가 켜져 있고 실행 중인 워크룸이 있을 때만 잠자기를 막습니다. 켜지 않으면 워치에 「Mac이 잠자기일 수 있음」이라고 정직하게 표시합니다.

6. **하드웨어와 P0 실험을 알려 주세요.** 워치 모델, LTE 여부, watchOS 버전이 무엇인가요? 앱을 만들기 전에 알림 전용 Telegram 봇으로 「손목 두드림이 쓸모 있는가」를 먼저 시험해 볼까요?
   - **추천 기본값: Series 9 이상, 비 LTE, watchOS 26을 가정합니다.** Telegram 실험은 답장 기능이 없는 별도 봇으로 1주일 해 보고, 그 결과로 APNs에 투자할지 정합니다.