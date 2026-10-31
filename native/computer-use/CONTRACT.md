# AgentsToZ Control XPC 계약 v1

> 전체 Mac·선택한 앱의 새 범위 동의와 실행은 [v2 범위 계약](SCOPE-CONTRACT.md)을 따른다. 아래 기존 창 v1 승인이 v2 권한을 부여하지 않는다.

상태: **확정 (2026-10-27)**. root의 메인 앱 브리지(`src-tauri/native/computer-use/ClientBridge/ComputerUseClientBridge.m`,
`src-tauri/src/computer_use_bridge.rs`, `src/computerUseMainLink.ts`)와 맞춘 판입니다.

정본은 세 곳이며 함께 바꿉니다.

- 코드: `Sources/ComputerUseControlCore/ControlProtocol.swift`, `ControlState.swift`
- 사례: `Tests/ControlContract/requests.json` (유효 23건, 무효 38건, 성공 응답 4건 `replies`)
- 이 문서

검증은 `bun scripts/check-computer-use-control.ts`(Swift core 검사 25건)와 `swift test`로 합니다. 시험 결과는 문서 끝에 적었습니다.

## 1. 전송

| 항목 | 값 |
|---|---|
| 프로세스 | 형제 앱 `/Applications/AgentsToZ Control.app`(`com.intenet.agentstozbycs.control`)과 그 앱 자체의 LaunchAgent |
| Mach service | `com.intenet.agentstozbycs.control.xpc` |
| 프로토콜 | `@objc(AgentsToZControlXPC)`의 `func request(_ data: Data, reply: @escaping @Sendable (Data) -> Void)`. Objective-C selector는 `request:reply:` |
| 본문 | UTF-8 JSON 객체 하나. 요청 1개에 응답 1개 |
| 요청 상한 | **16,384 bytes**. 넘으면 `invalid-request`로 거부 |
| 응답 상한 | **512,000 bytes**(메인 브리지 cap 524,288 이하). 넘는 응답은 고정 실패 `response-too-large` |
| 연결 수명 | 호출마다 연결을 만들고 닫아도 됩니다. 연결이 닫혀도 아무 권한도 끝나지 않습니다(3절 소유자 참고) |
| 시간 | helper는 요청마다 바로 답합니다. 사람 승인은 `approval-status` 폴링으로 기다리며, 요청 하나가 사람을 기다리며 막히는 일은 없습니다 |

메인 브리지의 8초 시간초과는 `native-outcome-unknown`, `notDispatched:false`로 처리됩니다. 이 처리가 맞습니다. press/set-value가 시간을 넘기면 결과를 모르는 것으로 두고 재전송하지 않습니다. helper는 그 요청의 영수증을 `receipt`로 계속 보관합니다.

## 2. 양방향 서명 요구

두 방향 모두 Developer ID와 team `DA8QKAQ2C9`, 그리고 정확한 identifier를 요구합니다. ad-hoc 서명이나 다른 팀, 이름을 바꾼 사본, CLI는 통과하지 못하며, 통과하지 못하는 것이 맞습니다.

- **helper가 메인을 검증.** `NSXPCListener.setConnectionCodeSigningRequirement`(macOS 13+)를 `resume()` 전에 한 번 겁니다. 고정 문자열이며 env·파일·인수에서 읽지 않습니다. 개발용으로 완화하는 실행 시 스위치도 없습니다.
  ```
  anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier "com.intenet.agentstozbycs" and certificate leaf[subject.OU] = "DA8QKAQ2C9"
  ```
- **메인이 helper를 검증.** root 브리지의 `HelperRequirement`입니다. 그대로 유지하면 됩니다.
  ```
  anchor apple generic and identifier "com.intenet.agentstozbycs.control" and certificate leaf[subject.OU] = "DA8QKAQ2C9" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists
  ```
- 런타임 브로커(`RuntimeBrokerClientBridge.m`)와 달리 entitlement 조건은 없습니다. 원하면 같은 형식으로 추가할 수 있지만, 그러려면 양쪽 서명 entitlement를 함께 바꿔야 합니다(리더 결정).

## 3. 소유자 = 감사된 Main 프로세스 세대

- `shouldAcceptNewConnection`에서 소유자를 정합니다. 서명 요구를 통과한 연결의 `NSXPCConnection.processIdentifier`와, 그 PID의 커널 시작 시각(`sysctl KERN_PROC_PID`의 `p_starttime`, µs)을 묶어 `ControlOwner(pid, start)`로 씁니다. 요청 본문의 PID나 generation은 받지 않습니다.
- 요청을 처리할 때마다 그 PID의 시작 시각이 아직 같은지 다시 확인합니다. 다르거나 프로세스가 없으면 `owner-unavailable`(`notDispatched:true`)로 거부합니다.
- 공개 SDK에 `auditToken`이 없어서 PID와 시작 시각을 씁니다. 연결 수명 동안 PID는 고정입니다.
- approval 요청과 grant는 모두 소유자에 묶입니다. 다른 소유자에게는 `unknown`/`grant-unknown`으로만 답해 아무 정보도 주지 않습니다.
- Main이 종료하거나 재시작하거나 PID가 재사용되면 새 소유자가 됩니다. 다음 요청 때나 helper의 1초 정리 타이머 때, 이전 소유자의 대기·승인 요청은 `cancelled`로, grant는 삭제로 정리됩니다. 되살아나지 않습니다.
- 연결 invalidation과 interruption은 아무것도 끝내지 않습니다. 브리지가 호출마다 연결을 닫기 때문입니다.

## 4. 봉투

```json
{"v": 1, "channel": "agent" | "management", "op": "<작업>", ...작업별 필드}
```

- 키 집합은 작업마다 정확히 일치해야 합니다. 모르는 키나 빠진 키가 하나라도 있으면 `invalid-request`입니다.
- `v`는 정수 1이어야 합니다(boolean `true` 거부).
- root 매핑은 `version→v`, `surface→channel`, `operation→op`이고 나머지 필드는 그대로 둡니다. 이 세 원래 키를 helper 요청에 남기면 안 됩니다. helper는 이를 모르는 키로 보고 거부합니다(무효 사례 "the root bridge's field names are adapted before XPC").
- `channel`은 메인이 강제합니다.
  - sidecar private link로 들어온 것은 모두 `agent`입니다.
  - 사람이 메인 UI에서 실행한 Tauri 명령만 `management`입니다.
- 두 channel 모두 같은 서명된 메인에서 오므로 helper가 channel을 서명으로 구별할 수는 없습니다. 대신 권한을 갈라 둡니다(5절).

## 5. 작업 표

| op | agent | management | 필드 | 성격 |
|---|:-:|:-:|---|---|
| `status` | O | O | (없음) | 읽기. keychain·권한 요청 없음 |
| `show-review` | — | O | (없음) | 사람이 Main 창에서 요청한 승인 검토 UI 열기. 승인·동작은 하지 않음 |
| `catalog` | — | O | (없음) | 사람의 창 선택용 목록 |
| `approvals` | — | O | (없음) | 이 소유자의 승인 요청 목록(서명 없음) |
| `request-approval` | O | O | `approvalId`, `target`, `caller`, `label`, `expiresAt` | Control 메뉴에 대기 요청만 생성. focus·활성화·자동 승인 없음 |
| `approval-status` | O | O | `approvalId`, `caller` | 읽기. 승인됐으면 서명된 승인과 공개키 |
| `cancel-approval` | — | O | `approvalId` | 사람이 대기 중이거나 승인 후 아직 열지 않은 요청을 철회 |
| `open-grant` | O | — | `approvalId`, `caller`, `target` | 1회용 승인을 native grant로 전환 |
| `observe` | O | — | `grant`, `caller` | 엔진 읽기 |
| `capture` | O | — | `grant`, `caller`, `snapshotId` | 별도 승인된 창 이미지 읽기 |
| `click` | O | — | `grant`, `caller`, `requestId`, `snapshotId`, `x`, `y` | 이미지로 확인한 창 좌표의 AX 요소 누르기 |
| `press` | O | — | `grant`, `caller`, `requestId`, `snapshotId`, `element` | 엔진 동작 |
| `set-value` | O | — | `grant`, `caller`, `requestId`, `snapshotId`, `element`, `value` | 엔진 동작 |
| `receipt` | O | — | `grant`, `caller`, `requestId` | 영수증 읽기(재실행 아님) |
| `revoke` | O | O | `grant`, `caller` | grant 하나 종료 |
| `revoke-session` | O | O | `sessionId` | 이 소유자 안의 그 세션만 종료 |
| `disconnect-owner` | O | O | (없음) | **회수 전용.** 이 소유자의 모든 요청과 grant 종료 |

- 엔진(`open-grant`/`observe`/`capture`/`click`/`press`/`set-value`/`receipt`)은 agent에서만 열립니다.
- `capture`와 `click`도 agent 전용입니다. 화면 이미지 허용은 Control 승인창의 기본 꺼진 선택이며 XPC 요청으로 켤 수 없습니다. `capture`는 이전 `observe`의 snapshot과 프로세스 순서를 검사하고, 캡처한 창을 움직이면 좌표 클릭을 거부합니다. 좌표는 창의 왼쪽 위 기준 포인트이며 임의 마우스 이벤트가 아닌 정확히 관찰한 AX 요소의 동작만 실행합니다.
- 화면 이미지 한도: 창의 긴 변을 최대 **1,280px**로 줄이고(작은 창은 키우지 않음) JPEG **240,000 bytes** 이하(base64 320,000자, host 상한)로 보냅니다. 품질을 낮춰도 넘으면 잘린 이미지 대신 `screen-image-too-large`로 거부합니다. `width`/`height`는 이미지 픽셀, `windowWidth`/`windowHeight`는 창의 포인트 크기이며, 이미지 픽셀 (px, py)의 창 좌표는 `(px × windowWidth / width, py × windowHeight / height)`입니다. 창 오른쪽·아래 끝(`x ≥ windowWidth`, `y ≥ windowHeight`)은 창 밖입니다. Control은 macOS 화면 기록 권한을 확인만 하고(`CGPreflightScreenCaptureAccess`) 요청하지 않습니다. 창 목록 조회와 이미지 생성 두 번의 대기 뒤마다 grant·관찰·창 frame·사람 상태를 다시 확인하며, 그 사이 사람의 중단·철회·만료·조작이 있으면 이미지를 내보내지 않습니다.
- `click`은 같은 관찰의 성공한 `capture`가 묶은 창 frame이 그대로일 때만 받습니다. 좌표가 관찰에 정확히 기록된 요소 하나에 맞지 않으면(빈 곳, 창 밖, 관찰하지 않은 하위 요소) `coordinate-unavailable`이고, 맞으면 그 요소에 `press`와 같은 AXPress를 보냅니다. 버튼·체크박스·라디오·링크 외의 역할은 `unsupported-action`입니다.
- `catalog`, `approvals`, `cancel-approval`은 management에서만 열립니다.
- 두 channel이 공유하는 작업은 요청하거나 읽거나 끝내는 일만 합니다.
- 관찰·입력은 `ExactAXTree`/`NativeAXDriver`가 직접 처리합니다. PID와 AX 창 ID가 정확히 일치하는 창에서 원래 AX 객체를 보관하며, 이름·위치로 다른 객체를 찾아 대체하지 않습니다. 역할·보안 하위 역할을 먼저 읽고, 보안 입력 또는 하위 역할 읽기 실패 시 제목·설명·값과 그 자식을 읽지 않습니다. AX 서버가 `attributeUnsupported`/`noValue`로 답한 경우는 검증된 부재로 구분하므로 일반 텍스트 필드·텍스트 영역은 다시 입력할 수 있습니다. Peekaboo의 일반 요소 수집기·값 스냅샷은 사용하지 않으며, 프로세스/창 신원 조회만 유지합니다.
- 관찰은 500개 노드·노드당 자식 100개·깊이 12·단조 시계 2초 예산으로 제한합니다. 속성 RPC의 시간초과는 150ms입니다. 값은 UTF-16 1,000단위·레이블은 240단위로 제한하며 이모지·결합문자를 자르지 않습니다. 전체 JSON 요소도 응답 상한에서 봉투 여유를 뺀 예산 안에 담고 생략 시 `truncated`로 알립니다. 긴 값의 변경은 보관한 SHA-256으로 비교합니다. 스냅샷은 새 관찰·동작 시도·종료 때 비우고 15초 만료 작업도 예약합니다. macOS 스케줄러의 실시간 실행이나 메모리의 물리적 영점 삭제를 보장하지는 않습니다.
- 동작 직전에 원래 객체의 창·역할·하위 역할·관찰 상태·활성/쓰기 가능 여부와 host/human 상태를 재확인합니다. 관찰 뒤 사람이 값을 바꾸거나 대상이 비활성·읽기 전용·보안 입력이 되면 전송하지 않습니다. AX 변경을 시도한 뒤 오류는 미확정 결과이며 자동 재전송하지 않습니다.
- `truncated`는 노드/자식/깊이/시간 한도, 불완전 AX 읽기, 보안/메뉴 제외로 요소를 생략하면 참입니다. `ControlResponse`의 응답 크기 제한도 별도로 유지합니다.

helper에 없는 작업: 승인·거부(Control 창에서만), 키 준비, 설정 변경, `pending-recovery`/`review-recovery`.

- 복구 원장은 sidecar(`src/computerUseRecovery.ts`)의 것이므로 root는 이 두 작업을 helper로 보내지 않습니다. 보내면 `invalid-request`입니다.
- `disconnect-owner`는 root 계획대로 Rust private-link teardown에서만 보내고 agent/MCP에는 노출하지 않습니다. helper는 두 channel 모두에서 받지만 하는 일은 종료뿐입니다.

## 6. 필드 형식

| 필드 | 형식 |
|---|---|
| `approvalId` | 소문자 hex 64자 |
| `grant` | 소문자 hex 32자. helper가 `open-grant`에서 발급 |
| `caller` | `{"sessionId": [A-Za-z0-9_-]{8,160}, "lane": [A-Za-z0-9_-]{1,64}, "generation": 소문자 hex 32자}`. generation은 `computerCallerGeneration(caller)`(src/computerUseCaller.ts) |
| `target` | `{"bundleId": [A-Za-z0-9.-]{1,200}, "teamId": "" 또는 [A-Z0-9]{10}, "codeHash": 소문자 hex 40~64자, "pid": 1~2147483647 정수, "processStart": 앞자리 0 없는 십진 문자열 1~20자, "windowId": 1~4294967295 정수}` |
| `label` | 앞뒤 공백 제거 뒤 1~100자, 제어문자 없음 |
| `expiresAt` | 정수 ms epoch. `now < expiresAt ≤ now + 605,000`(10분 + skew 5초. 2026-10-31 전에는 120초) |
| `requestId` | `[A-Za-z0-9_-]{8,128}`. host의 요청 ID(computerUseProtocol.ts)를 그대로 사용 |
| `snapshotId` | 공백 없는 출력 가능 ASCII 1~200 bytes(`observe`가 준 값) |
| `element` | 공백 없는 출력 가능 ASCII 1~160 bytes(`observe`의 `elements[].id`) |
| `value` | 문자열, UTF-8 4,000 bytes 이하 |
| `sessionId` | caller.sessionId와 같은 형식 |

숫자는 정수만 받습니다. 소수, boolean, |n| ≥ 2^53은 거부합니다.

## 7. 응답

모든 응답은 키를 정렬한 JSON 객체이며 `success`(bool)와 `halted`(bool)가 항상 있습니다.

`halted`는 grant를 지정한 요청에서만 의미가 있습니다. 그 grant가 없거나 멈췄으면 true입니다. 원인은 만료, revoke, 사람의 중단, 결과 불명, 사람의 가로채기, 소유자 종료 중 하나입니다. host는 true를 받으면 자기 grant도 멈춥니다(`ComputerUseHost.sync`). grant를 지정하지 않는 작업은 false입니다.

실패 응답 형식:

```json
{"success": false, "halted": false, "code": "<코드>", "notDispatched": true, "retryAfterMs": 700}
```

`retryAfterMs`는 `human-active`일 때만 붙습니다.

`notDispatched:true`는 이 요청 때문에 어떤 앱에도 AX 동작이 가지 않았다는 약속입니다.

- `notDispatched:false`는 press, set-value, click에서만 의미가 있습니다. 그 경우 결과를 모르는 것으로 기록하고 grant를 멈춥니다. 재전송하지 않습니다.
- 다른 작업의 실패는 동작을 보내지 않으므로 모두 `true`입니다. 유일한 예외는 고정 응답 `response-too-large`로, 항상 `false`입니다.

성공 본문(`success:true`, `halted` 외):

| op | 본문 |
|---|---|
| `status` | `protocolVersion: 1`, `workerProtocol: 2`, `accessibility: bool`, `secureInput: bool`, `backgroundOnly: true`, `pendingApprovals: int`, `grants: int`(이 소유자 기준), `operations: ["capture","click","observe","press","receipt","set-value"]`(15절) |
| `catalog` | `windows: [{bundleId, teamId, codeHash, pid, processStart, windowId, title(≤200), appName(≤100)}]`(최대 100) |
| `approvals` | `approvals: [{approvalId, state, label, expiresAt, target, caller: {sessionId, lane}}]` |
| `request-approval` | `state: "pending"` |
| `approval-status` | `state`: `pending`·`approved`·`consumed`·`denied`·`cancelled`·`expired`·`unknown`. `approved`일 때만 아래 두 필드가 붙음. **`approval`**: `{approvalId, target, caller: {sessionId, lane}, issuedAt, expiresAt, signature}`(signature는 DER ECDSA P-256/SHA-256 base64, 바이트 형식은 `src/computerUseApproval.ts`). **`helperPublicKey`**: 65-byte X9.63 점의 base64 |
| `cancel-approval` | `cancelled: bool` |
| `open-grant` | `bound: true`, `grant`, `protocolVersion: 2`, `expiresAt`, `operations`(`status`와 같음) |
| `observe` | `snapshotId`, `elements: [{id, role, label(≤240), value(≤1000), enabled, settable}]`(최대 500), `truncated` |
| `capture` | `mediaType`, `data`(base64), `width`, `height`, `windowWidth`, `windowHeight` |
| `press`/`set-value`/`click` | `outcome`(Peekaboo `DesktopActionOutcome` JSON). root는 `outcome.state`만 읽음: `confirmed_change`/`confirmed_no_change`는 confirmed, `refused`는 refused, `dispatched_unverified`는 dispatched-unverified, 그 밖은 unknown. 그리고 `humanStatePreserved: bool`(false면 human-takeover) |
| `receipt` | `receipt: {requestId, state: unknown/confirmed/refused/dispatched-unverified/human-takeover, reason?}` |
| `revoke` | `revoked: true`(`halted: true`) |
| `revoke-session` / `disconnect-owner` | `revoked: int`, `cancelled: int` |

실패 코드:

| code | 언제 | notDispatched |
|---|---|---|
| `invalid-request` | 형식·키·channel·op 위반, 중복 approvalId, 거부된 승인 서명 형식 | true |
| `owner-unavailable` | 요청 소유자의 프로세스 세대가 이미 없음 | true |
| `target-refused` | AgentsToZ 계열, 에이전트·터미널·보안 앱, team DA8QKAQ2C9 서명 앱 | true |
| `approval-expired` / `approval-limit` | `expiresAt` 범위 밖 / 대기 요청 8개 초과 | true |
| `approval-unknown` | 승인되지 않았거나 이미 소비·만료·취소된 요청, 또는 다른 소유자·caller | true |
| `grant-limit` | 열린 grant 8개 | true |
| `grant-unknown` | 없는 grant, 또는 다른 소유자·caller의 grant | true |
| `worker-halted` | grant가 멈춤(사람의 중단, 결과 불명, 가로채기) | true |
| `target-changed` / `target-unavailable` / `identity-unavailable` / `window-not-exact` | 대상 프로세스 세대·창·서명이 승인 때와 다르거나 확인 불가. click에서는 캡처한 창이 움직이거나 크기가 바뀐 경우도 `target-changed` | press/set-value/click에서 동작 후 발생하면 false, 그 밖은 true |
| `permission-or-secure-input` | Control에 손쉬운 사용 권한이 없거나 secure input이 켜짐 | true |
| `observation-discarded` | 관찰·캡처 중 사람이 화면을 쓰거나, 같은 프로세스에 변경이 있거나, 캡처 중 grant가 멈추거나 관찰이 바뀌거나 15초를 넘어 이번 결과만 버림 | true |
| `human-state-unavailable` | 맨 앞 앱이나 focus를 읽지 못해 사람이 쓰는 중인지 판단할 수 없음 | true |
| `screen-consent-required` | 이 grant의 승인에서 화면 이미지를 허용하지 않음(기본값) | true |
| `screen-permission-required` | Control에 macOS 화면 기록 권한이 없음. Control은 권한을 요청하지 않음 | true |
| `screen-image-too-large` | 가장 낮은 JPEG 품질로도 240,000 bytes를 넘음 | true |
| `coordinate-unavailable` | click 좌표가 이 관찰에 정확히 기록된 요소 하나에 맞지 않음 | true |
| `process-busy` | 같은 앱 프로세스의 다른 변경이 진행 중 | true |
| `stale-observation` | 관찰이 없거나 다르거나 15초를 넘음(관찰 1회에 시도 1회) | true |
| `duplicate-request` / `receipt-limit` | 같은 requestId 재사용 / grant당 영수증 64개 | true |
| `unsupported-action` | 그 요소에 허용되지 않은 동작 | true |
| `human-active` | 사람이 1.5초 안에 입력함. `retryAfterMs` ≤ 1500 | true |
| `human-using-target-app` | 대상 앱이 사람의 맨 앞 앱 | true |
| `receipt-unknown` | 그 grant에 그 requestId가 없음 | true |
| `native-operation-unconfirmed` | AX 호출 중이나 이후의 실패 | press/set-value/click에서 false, 그 밖은 true |
| `response-too-large` | 응답이 상한을 넘음(고정 응답) | false |

## 8. 수명과 한도

- **승인 요청.** 대기는 최대 8개, 10분입니다. 이미 결정된 요청(approved, consumed, denied, cancelled, expired)은 그 소유자와 caller에게 120초 동안 읽힙니다.
- **승인.** Control 창에서 사람이 승인을 누를 때만 이루어집니다. 순서는 다음과 같습니다.
  1. Control이 대상을 다시 해석해 승인 때와 같은지 확인합니다. 바뀌었으면 거부만 할 수 있습니다.
  2. LocalAuthentication(Touch ID 또는 로그인 암호)을 통과합니다.
  3. Secure Enclave 승인 키로 서명합니다. 키가 없으면 이때 처음 만듭니다.

  status·request·approval-status를 읽는 것만으로는 keychain에 접근하지 않습니다.
- **open-grant.** 승인 뒤 `expiresAt` 전에 한 번만 됩니다. 같은 소유자, 같은 caller(session·lane·generation), 같은 target이어야 합니다. 성공하면 승인은 `consumed`가 되고 서명이 지워집니다. grant는 open 시점부터 10분 유효하며 최대 8개입니다.
- **grant.** 관찰 1회에 시도 1회만 허용합니다.
  - 같은 앱 프로세스의 변경은 프로세스 단위로 순서를 지킵니다. 진행 중에 들어온 다른 요청은 `process-busy`로 받습니다. 변경이 일어나면 그 프로세스의 다른 관찰은 모두 낡은 것이 됩니다(창이 달라도 같음).
  - 다른 프로세스와는 병렬로 처리합니다.
  - 결과를 모르거나 사람이 가로챈 경우 그 grant가 멈춥니다. 영수증은 계속 읽을 수 있습니다.
- **종료.** 아래 경우에는 정리할 대상이 없어도 남은 것 없이 끝납니다.
  - `revoke-session`: 이 소유자 안에서 그 세션의 대기·승인 요청과 grant를 끝냅니다.
  - `disconnect-owner`: 이 소유자 전체를 끝냅니다. 다른 소유자는 그대로입니다.
  - 소유자 프로세스 종료.
  - 사람이 「모두 중단」을 누른 경우.

  종료 후 세션 종료 전에 시작된 서명이 도착해도 아무것도 생기지 않습니다. 같은 세션 ID로 새 generation이 와도 이전 승인을 쓸 수 없습니다.

## 9. 예시 흐름

```jsonc
// 1. agent: 대기 요청 (Control 메뉴 막대 배지만 바뀜)
{"v":1,"channel":"agent","op":"request-approval","approvalId":"abab…(64)","target":{"bundleId":"com.example.editor","teamId":"ABCDEFGHIJ","codeHash":"abab…(40)","pid":100,"processStart":"9007199254740995","windowId":321},"caller":{"sessionId":"workroom_session_a","lane":"leader","generation":"cdcd…(32)"},"label":"Edit draft","expiresAt":1793000120000}
→ {"halted":false,"state":"pending","success":true}

// 2. 폴링: 사람이 Control 창에서 Touch ID로 승인한 뒤
{"v":1,"channel":"agent","op":"approval-status","approvalId":"abab…","caller":{…}}
→ {"approval":{"approvalId":"abab…","caller":{"lane":"leader","sessionId":"workroom_session_a"},"expiresAt":1793000120000,"issuedAt":1793000031000,"signature":"MEUCIQ…","target":{…}},"halted":false,"helperPublicKey":"BJ…(65 bytes)","state":"approved","success":true}

// 3. host가 서명을 검증(redeem)한 뒤 worker bind → open-grant
{"v":1,"channel":"agent","op":"open-grant","approvalId":"abab…","caller":{…},"target":{…}}
→ {"bound":true,"expiresAt":1793000631000,"grant":"efef…(32)","halted":false,"protocolVersion":2,"success":true}

// 4. 관찰과 동작 1회
{"v":1,"channel":"agent","op":"observe","grant":"efef…","caller":{…}}
→ {"elements":[{"enabled":true,"id":"elem_1","label":"Send","role":"button","settable":false,"value":""}],"halted":false,"snapshotId":"…","success":true,"truncated":false}
{"v":1,"channel":"agent","op":"press","grant":"efef…","caller":{…},"requestId":"control_request_0001","snapshotId":"…","element":"elem_1"}
→ {"halted":false,"humanStatePreserved":true,"outcome":{"state":"confirmed_change",…},"success":true}
→ 또는 {"code":"human-active","halted":false,"notDispatched":true,"retryAfterMs":700,"success":false}

// 4b. 화면 이미지를 허용한 grant: 같은 관찰을 캡처한 뒤 이미지 픽셀 (640,400)을 창 좌표 (1280,800)으로 환산해 클릭
{"v":1,"channel":"agent","op":"capture","grant":"efef…","caller":{…},"snapshotId":"…"}
→ {"data":"/9j/…","halted":false,"height":800,"mediaType":"image/jpeg","success":true,"width":1280,"windowHeight":1600,"windowWidth":2560}
{"v":1,"channel":"agent","op":"click","grant":"efef…","caller":{…},"requestId":"control_request_0002","snapshotId":"…","x":1280,"y":800}
→ {"halted":false,"humanStatePreserved":true,"outcome":{"state":"confirmed_change",…},"success":true}
→ 또는 {"code":"coordinate-unavailable","halted":false,"notDispatched":true,"success":false}

// 5. sidecar private link EOF (Rust teardown)
{"v":1,"channel":"agent","op":"disconnect-owner"}
→ {"cancelled":0,"halted":false,"revoked":1,"success":true}
```

## 10. root 연결 지점 (파일·메서드)

Rust: `src-tauri/src/computer_use_bridge.rs`(root 소유)

- `native_request`가 `{operation, …}`를 `{v:1, channel, op, …}`로 바꿉니다. `version`/`surface`/`operation` 키는 남기지 않습니다.
- `AGENT_OPERATIONS`는 helper agent 집합에서 `disconnect-owner`를 뺀 그대로입니다. sidecar가 보낼 수 없게 하려는 것입니다.
- `MANAGEMENT_OPERATIONS`에서 `pending-recovery`와 `review-recovery`는 helper로 보내지 말고 sidecar의 복구 원장 API로 처리합니다.
- `private_link::serve`가 EOF, 오류, 잘못된 프레임으로 return할 때 `request(json!({"op":"disconnect-owner"}), …)`를 한 번 보냅니다. 응답이 실패여도 재시도하지 않습니다. 그때 남은 권한은 소유자 정리(3절)와 10분 만료가 회수합니다.

core hook: 이 worktree의 core TS에 반영됐습니다(`tests/computer-use-control-hooks.test.ts`). root 어댑터는 이것만 의존합니다.

- `src/computerUseHost.ts`
  - `createWorker(context: ComputerWorkerContext)`. context는 `{approvalId, target, caller: {sessionId, lane}, generation}`이고 `host.grant(approval)`의 서명 검증(redeem)이 끝난 뒤에만 만들어집니다. caller와 generation은 redeem 결과에서 오며 요청 본문의 caller는 쓰지 않습니다. 인수 없는 기존 팩토리도 그대로 동작합니다.
  - worker 변경 본문은 `{operation, requestId, snapshotId, element, value?}`입니다. 여기서 `requestId`는 host의 요청 ID이자 원장 행의 requestId입니다.
- `src/computerUseApproval.ts`
  - `new ComputerApprovalVerifier({helperPublicKey: Uint8Array | (() => Uint8Array)})`. 함수 형태는 생성 때나 `request` 때 읽지 않고, `redeem`의 실제 서명 검증 직전에만 읽습니다. boolean·1회 사용·대상·caller·수명 검사가 모두 끝난 뒤입니다.
  - root는 이 함수에 검증된 helper 연결의 `approval-status` 응답에 담긴 `helperPublicKey`만 공급합니다. disk·env·API 요청의 키는 받지 않습니다.
  - 키를 읽지 못하거나, 형식이 틀리거나, 서명과 맞지 않으면 redeem은 거부합니다. 이때 요청은 소비되지 않습니다.
  - `redeem()`은 `approvalId`도 돌려줍니다.

root TS 어댑터(root 소유, `ComputerUseMainLink` 위): `ComputerWorker`를 구현합니다.

| host → worker | helper 요청 | 응답 처리 |
|---|---|---|
| `{operation:'bind', target}` | `open-grant`(context의 approvalId·caller+generation) | 성공이면 `{success:true, bound:true, protocolVersion:2}`를 돌려주고 grant를 보관 |
| `{operation:'observe'}` | `observe` | 그대로 전달 |
| `{operation:'press'/'set-value', requestId, …}` | 같은 op | 그대로 전달 |
| `{operation:'capture', snapshotId}` / `{operation:'click', requestId, snapshotId, x, y}` | 같은 op | `open-grant` 응답의 `operations`에 둘이 모두 있을 때만 전달. 없으면 보내지 않고 `control-update-required`(`notDispatched:true`)로 답하며, host는 차선·원장·영수증을 만들기 전에 거부합니다(15절) |
| `close()` | `revoke`(최선 노력). **root 후속 보강(2026-10-27, root 소스·root 회귀, core 검사 범위 밖):** 입력 요청은 queue하거나 재전송하지 않고, revocation(`revoke`·`revoke-session`)만 최대 72개까지 우선 직렬화해 보냅니다. 그래서 다른 세션 하나가 끝났다고 모든 권한이 불필요하게 끊기지 않습니다. revocation 하나라도 결과가 불명이거나 실패하면 root는 private link를 닫고, Rust teardown의 `disconnect-owner`가 그 소유자 전체를 회수합니다(fail closed). 이 판의 처음 문구(revoke를 보낼 수 없으면 곧바로 링크를 닫음)는 이 보강으로 대체됐습니다. 무한 queue는 없습니다 | — |

- 승인 흐름은 다음 순서입니다.
  1. `host.requestApproval()`의 결과(approvalId·expiresAt·target·caller)와 label, `computerCallerGeneration(caller)`로 `request-approval`을 보냅니다.
  2. `approval-status`를 1초 간격으로 `expiresAt`까지 폴링합니다.
  3. `approved`가 오면 그 응답의 `helperPublicKey`를 verifier의 키 함수가 돌려주도록 해 두고 `host.grant(answer.approval)`을 부릅니다.
- `host.endSession(id)`를 부를 때 `revoke-session`을 함께 보냅니다.
- 링크 실패(`ComputerUseLinkError`)는 throw합니다. 기존 host가 observe면 worker-unavailable로 멈추고, 동작이면 unknown 영수증과 사람 확인으로 처리합니다.

UI(root 소유):

- 메인 UI의 창 선택은 management `catalog`를 씁니다.
- 대기 목록은 `approvals`, 철회는 `cancel-approval`을 씁니다.
- 「승인은 AgentsToZ Control 메뉴에서」라는 안내를 둡니다. 메인 UI는 승인·키 생성 버튼을 두지 않습니다.

## 11. 번들과 실행 구조

`bun scripts/build-computer-use-control-app.ts --output <abs path>/AgentsToZ Control.app`가 만듭니다. 이 스크립트는 설치, launchctl, 서명 ID 조회를 하지 않습니다. 서명 빌드는 기본으로 보안 타임스탬프를 붙이며, `--timestamp=none`은 공증할 수 없는 로컬 빌드에만 씁니다. 공증은 `--notarize --notary-profile <기존 keychain 프로필>`을 줄 때만 하는 옵트인 네트워크 단계입니다(자격 증명을 만들거나 출력하지 않음, 절차는 `docs/claude/build-release.md`).

```
AgentsToZ Control.app/Contents/
  Info.plist   CFBundleIdentifier=com.intenet.agentstozbycs.control, CFBundleExecutable=AgentsToZ Control,
               LSUIElement=true, LSMinimumSystemVersion=14.0
  MacOS/AgentsToZ Control
  Library/LaunchAgents/com.intenet.agentstozbycs.control.agent.plist
      Label=com.intenet.agentstozbycs.control.agent, BundleProgram=Contents/MacOS/AgentsToZ Control,
      MachServices={com.intenet.agentstozbycs.control.xpc=true}, AssociatedBundleIdentifiers=[…control],
      ProcessType=Interactive, RunAtLoad=false (첫 XPC 요청 때 launchd가 시작)
```

- **LaunchAgent 등록.** Control.app이 자기 번들의 plist를 `SMAppService.agent(plistName:)`로 등록합니다. 사람이 Control 설정 창에서 「백그라운드 실행 등록」을 누를 때만 합니다. 등록 상태 `requiresApproval`과 `enabled`는 다른 상태로 표시합니다. 등록이 성공해도 손쉬운 사용 권한이나 격리의 증거는 아닙니다.
- **실행 방식 구분.** launchd가 job으로 실행한 경우에만 listener를 엽니다(`XPC_SERVICE_NAME`이 agent label일 때). Finder로 연 실행본은 설정 창만 띄웁니다. 이 값은 실행 방식만 정하고 신뢰를 대신하지 않습니다. 남이 이 값을 흉내 내도 Mach service check-in에 실패할 뿐입니다.
- **서명(리더 단계).** 아래가 모두 필요합니다.
  - Developer ID Application, hardened runtime, 공증.
  - Secure Enclave 승인 키는 data protection keychain을 씁니다. 그래서 entitlement `com.apple.application-identifier = DA8QKAQ2C9.com.intenet.agentstozbycs.control`, `com.apple.developer.team-identifier = DA8QKAQ2C9`, `keychain-access-groups = [DA8QKAQ2C9.com.intenet.agentstozbycs.control]`과, 이 entitlement를 허용하는 Developer ID provisioning profile(`Contents/embedded.provisionprofile`)이 필요합니다. 템플릿은 `scripts/computerUseControlBundle.ts`에 있습니다.
  - **실기 확인 필요:** profile 없이 서명하면 키 생성이 실패하고 승인은 거부만 할 수 있습니다(fail closed).
- **TCC.** 손쉬운 사용 권한은 Control.app 자신이 받습니다. 메인 앱, Workroom shell, CLI는 그 권한을 상속하지 않습니다. 실제 TCC 귀속은 서명된 공개 빌드에서 리더가 확인합니다.

## 12. 이 판의 검증 범위

이 절은 core worktree의 실제 소스만 다룹니다.

- **실제 소스 범위.** `src/computerUse{Protocol,Host,Worker,Caller,Approval,Recovery}.ts`, `src/desktopSessionEffort.ts`, `native/computer-use/Sources/**`, `Package.swift`, `scripts/computerUseControlBundle.ts`, `scripts/build-computer-use-control-app.ts`, `scripts/check-computer-use-control.ts`
- **시험.** `tests/computer-use*.test.ts`, `tests/desktop-session-effort.test.ts`, `tests/fixtures/computer-use-approval-swift-vector.json`, `native/computer-use/Tests/**`
- **검증 문서.** 이 문서, `docs/design/computer-use-2026-10-26/{HELPER-DESIGN,EXECUTION}.md`. 실행되지 않는 설명입니다.
- **범위 밖.** 10절의 root 소유 동작(Rust teardown, revocation queue, TS 어댑터, UI)은 root 회귀가 다루며 core 검사는 실행하지 않습니다.
- **동결 뒤 결과.** 동결 뒤 실행한 maintainer 결과(run ID)는 이 문서가 아니라 커밋 메시지와 인계 기록에 남깁니다. 문서를 고치면 검증한 소스가 달라지기 때문입니다.

실제 결과(2026-10-27):

- **Swift core 검사.** `bun scripts/check-computer-use-control.ts`(`swiftc -D CORE_CHECKS`, XCTest·Peekaboo 불필요)에서 **17/17 passed**, 템플릿 plist 3개도 유효합니다. 검사 범위는 다음과 같습니다.
  - 계약 사례(유효 20, 무효 36)
  - channel 권한 분리
  - 소유자 세대·재시작·PID 재사용
  - disconnect-owner와 revoke-session의 소유자 범위
  - 1회용 open-grant
  - 승인 대기 10분·grant 10분·8개 한도
  - 세션 종료 뒤 늦은 서명 무효
  - 프로세스 단위 직렬 변경
  - 영수증 한도
  - 사람의 모두 중단
- **Swift build.** `swift build --disable-automatic-resolution`에서 소스 9개(Control 앱 3, core 2, engine, approval, lab worker, approval lab)가 모두 컴파일됐고, 실행 파일 3개를 링크했으며 경고는 0입니다.
- **바이너리 확인.** `agentstoz-control`에 `AgentsToZControlXPC`, selector `request:reply:`, Mach service 문자열이 들어 있고, `handle:withReply:`는 없습니다.
- **TS 집중 회귀.** computer-use 8개 파일과 effort 1개에서 **70 pass / 0 fail / 435 expect**입니다. 리더 재현 3건, deferred key, createWorker context, 번들 계약, Swift core 실행이 포함됩니다. `bun run typecheck`는 exit 0입니다.
- **lab worker smoke.** 엔진을 분리해 재빌드한 lab worker를 앱에 닿지 않는 요청으로만 확인했습니다. status는 protocol 2이고, 관찰 없는 press는 `stale-observation`(`notDispatched:true`)입니다. requestId는 받아들이고 잘못된 형식은 거부하며, Hermes PID bind는 `target-refused`입니다. 저장소 상태 해시는 실행 전후로 같습니다.
- **packaging `--debug` 구조 빌드.** Info.plist와 LaunchAgent 키가 계약과 같습니다.
  - 서명하지 않은 번들은 root의 helper requirement를 통과하지 못합니다(codesign exit 1, lab `not-satisfied`).
  - 같은 requirement 명령 형식은 설치된 팀 서명 `AgentsToZ Screen.app`(자기 identifier)에서 통과합니다(exit 0, 읽기 전용).

검증하지 않음:

- 실제 XPC 연결과 양방향 서명 통과(서명된 빌드 필요)
- LaunchAgent 등록, TCC 귀속
- Secure Enclave 키 생성과 Touch ID
- 사람 승인 UI 실조작

이 세션은 설치, 서비스 등록, 권한 요청, 키 생성, 실제 승인, 사용자 앱 조작을 하지 않았습니다.


## Root 통합 후속 · 2026-10-27

설정 프로세스와 LaunchAgent는 분리될 수 있으므로 Main의 명시적 「승인 검토 열기」는 management 전용 `show-review`로 실제 서비스 프로세스의 검토 창을 연다. 에이전트 channel은 이 op를 거부하며 승인·서명·grant 생성은 하지 않는다. 최초 도우미 설정 열기는 기존 고정 경로·서명 확인 후의 앱 열기를 유지한다. 이 변경의 실제 서명된 XPC·창 활성화는 설치 실기에서 별도 확인한다.

2026-10-31(v1584 실기 「눌러도 창이 안 보였다」): 검토 창은 주 디스플레이 가운데에 처음 열리고, 이미 있는 창은 있던 곳에 남았다. 다른 디스플레이나
원격 화면을 보는 사람에게는 보이지 않는데, 보이는지 판정(`ReviewPresentationEvidence`)에는 디스플레이 조건이 없어 `visibilityConfirmed`까지 답할 수 있었다.
이제 `show-review`는 버튼을 누른 포인터가 있는 디스플레이로 창을 옮기고(`ReviewPlacement` — 창 가운데가 이미 그 디스플레이에 있으면 사람이 놓은 자리를
존중해 옮기지 않는다, 보이는 영역 가운데에 그 크기 이하로), 판정에 `onPointerScreen`을 더했다 — 창이 그 디스플레이에 없으면 확인하지 않는다.
포인터가 어느 디스플레이에도 없으면 옮기지 않고 확인도 하지 않는다. 회귀는 `ControlChecks`의 「review opens on the display the person clicked」.
실제 다중 디스플레이·Jump Desktop 배치는 설치 실기에서 별도 확인한다.


## 14. Root 통합 후 승인·회수 경합 보강

- helper의 `revoke`는 해당 owner/caller의 살아 있는 grant만 제거한다. 이미 만료되거나 helper 재시작으로 없는 grant는 `success:true, revoked:false`인 멱등 종료다. 살아 있는 다른 owner/caller의 grant는 거부한다. 결과 불명 전송 실패 때 전체 private link를 닫는 규칙은 유지한다.
- Host는 서명·nonce·대상·caller·generation을 먼저 `verify`하고 native bind 성공 뒤 다시 확인하여 `redeem`한다. 같은 approvalId의 동시 bind를 막는다. 미전송이 확정된 busy만 원래 승인을 보존하며 다음 상태 조회에서 확인한다. 불명 bind를 자동 재전송하지 않는다.
- 연결 표시는 client가 고른 instance의 짧은 해시를 쓰지 않는다. host 발급 session UUID를 별도 code 필드로 AI status·App·Control 검토에 표시한다. client 표시 이름을 native 승인 label에 넣지 않으며 앱의 전용 코드 항목과 혼합하지 않는다. 개별 대화 격리 또는 같은 macOS 사용자 프로세스의 보안 격리를 주장하지 않는다.
- `ComputerUseControlCoreChecks`는 기존 17개에 만료·재시작·타 caller 회수 거부를 포함한 18번째 검사를 더한다. 실제 서명 XPC·TCC·생체 승인은 별도 설치 실기다.


## 15. capture/click 버전 신호와 동의 표시 · 2026-10-28

- **버전 신호.** Control은 형제 앱으로 따로 설치되므로 Main보다 오래된 Control과 짝지어질 수 있습니다. 오래된 Control은 `capture`/`click`을 모르는 op로 보고 `invalid-request`로 거부해 원인을 알 수 없었습니다. 이제 `status`와 `open-grant` 응답에 `operations`(엔진 작업 목록, `ControlContract.engineOperations`)가 붙습니다. `v`·`protocolVersion`·`workerProtocol`은 그대로라 기존 작업은 영향이 없습니다.
- **Main의 판정(fail closed).** `operations`가 없거나 배열이 아니거나 `capture`와 `click`이 둘 다 들어 있지 않으면 지원하지 않는 것으로 봅니다(`controlAdvertisesScreen`, src/computerUseProtocol.ts). grant마다 그 grant를 연 Control의 `open-grant` 응답으로 판정하며, 그 grant의 `capture`/`click`은 보내지 않고 `control-update-required`로 거부합니다. `observe`/`press`/`set-value`/`receipt`는 계속 됩니다. AI용 status의 `native.capture`는 최근 관리 status 기준 `supported` 또는 `control-update-required`입니다. 사람이 보는 컴퓨터 유즈 패널도 같은 판정으로, 연결된 Control이 둘을 알리지 않으면 「도우미 연결됨」 아래에 Control을 업데이트해야 창 화면 확인과 좌표 선택을 쓸 수 있다고 적습니다(`ComputerUseHelperStatus`).
- **lab worker.** 실험·시험용 child worker(src/computerUseWorker.ts, Sources/ComputerUseWorker)에는 화면 이미지 동의도 캡처 바인딩도 없습니다. host는 그 grant의 `capture`/`click`을 차선·원장·영수증 전에 `lab-worker-unsupported` 문구로 거부하고, worker 자신도 둘과 모르는 op를 `notDispatched:true`로 거부합니다(아무것도 읽거나 보내지 않았으므로 결과 불명이 아닙니다).
- **좌표 선택은 보내지 않는다.** click의 좌표→요소 선택 중 창을 다시 읽지 못하면(창이 닫힘, AX 시간초과, 창 목록 0.75초 한도) `window-not-exact`, `notDispatched:true`입니다. 선택은 AXPress 전이라 grant를 결과 불명으로 멈추지 않습니다.
- **동의 표시.** 화면 이미지 허용을 켠 승인의 Touch ID·로그인 암호 안내 문구는 그 창의 화면 이미지도 읽는다고 적고, 제어 중인 창 목록은 grant마다 화면 이미지 허용 여부를 보여 줍니다(`ControlConsentText`). 실제 생체 인증 창의 표시는 설치 앱에서 따로 확인해야 합니다.
- **사례.** `replies`의 `status`·`open-grant`·`capture`·`click` 성공 응답이 Swift core(`ControlResponse.status`/`openGrant`), 엔진의 캡처 본문, TS 어댑터·host 시험에서 같은 필드인지 확인합니다. Rust 브리지 시험은 같은 파일의 요청 사례가 `native_request` 결과와 정확히 같은지 확인합니다.
- **범위 밖.** 합성 마우스·키보드 입력, 캔버스 픽셀 클릭, Hermes/Orca 대상은 여전히 없습니다. 실제 서명 XPC·TCC·생체 승인은 설치 실기에서 확인합니다.
