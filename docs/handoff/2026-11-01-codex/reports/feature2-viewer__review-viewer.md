# feature2-viewer · review:viewer

(agent final report, verbatim)

English translation: "So the idea is that once it's connected, I can just keep using it comfortably, right?"

결함 10건을 찾았습니다(중간 3, 낮음 7). 심각한 순서입니다. 1번은 사용자에게 한 「연결하면 60분까지 그대로 본다」는 답과 직접 어긋납니다.

**확인한 것**
- 새 검사 worktree를 `bfa50bfc`에서 열고 `bun scripts/check-screen-control.ts`를 돌렸습니다. 136/136 checks, SR-36 소스 검사, 상태 파일 검사, `swift test` 13건이 모두 통과했습니다.
- `swift build --product AgentsToZViewer`는 경고 없이 빌드됐습니다.
- 공용 코어를 iOS 시뮬레이터 대상으로 타입 검사했고 통과했습니다.
- 폰 골든 벡터와 iOS 소스는 이 커밋에서 바뀌지 않았습니다.
- 검사는 실제 화면, TCC, 키체인, 52741에 닿지 않습니다. loopback도 빈 포트만 씁니다.
- 임시 worktree는 지웠습니다.

**결함**

1. **[중간] 보기 세션이 A의 화면 꺼짐 시간에 끊깁니다** — `native/screen-control/Sources/AgentsToZViewer/ViewerApp.swift:43`, `SessionWindow.swift:14-22`
   - 왜: 세션 경비가 `screensDidSleepNotification`(디스플레이 잠자기)에도 세션을 끝냅니다. 그런데 `displayLayer.preventsDisplaySleepDuringVideoPlayback`을 켜지 않습니다. SDK 헤더 기준으로 macOS 기본값은 NO이고, 다른 화면 꺼짐 방지 조치도 없습니다.
   - 영상만 보고 A를 만지지 않으면 A의 「디스플레이 끄기」 시간(기본 몇 분) 뒤에 세션이 끝납니다. 잠금 설정이 「즉시」이면 잠금 경비도 함께 걸립니다.
   - 이 빌드는 보기만 되므로 대부분의 세션이 해당합니다. 사용자 답의 「60분까지 그대로 쓴다」와 어긋납니다.
   - 고칠 방법: 세션 동안 화면 꺼짐을 막을지 설계에서 정해야 합니다(`preventsDisplaySleepDuringVideoPlayback = true` 또는 IOPMAssertion). 막으면 A가 보는 동안 자동으로 잠기지 않습니다. 막지 않으면 사용자에게 「A를 몇 분 만지지 않으면 끊긴다」고 알려야 합니다.

2. **[중간] SR-29 키 판정이 너무 넓습니다** — `HumanAction.swift:81`
   - 왜: `humanKey`에 `inControl: window.isKeyWindow`를 넘깁니다. 그래서 같은 창의 1초 안 하드웨어 keyDown 하나가 창 안의 **모든** 컨트롤을 작동시킨 것으로 판정됩니다. 계약은 「그 컨트롤에 전달된 keyDown」입니다.
   - AXPress나 osascript `click button`이 사람의 keyDown이 현재 이벤트인 순간에 들어오면 통과합니다. 예: 목록 창의 「이 Mac에서 삭제」(생체 인증 없이 지워짐). 조작 빌드에서는 보안 입력칸에 타이핑하는 동안 도구 막대, 「입력 재개」, 「보내기」도 통과합니다.
   - 실제로 AX가 그 순간에 맞아 떨어지는지는 실기로 확인하지 않았습니다. 코드로는 막는 장치가 없습니다.
   - 고칠 방법: `inControl: window.firstResponder === control`로 바꿉니다. 키 대응 단축키가 있는 HumanButton이 없으므로 그 밖의 keyDown은 거절합니다. 벡터나 소스 계약 검사도 하나 더합니다.

3. **[중간·낮음] 연결 중에 A가 잠기거나 잠들어도 세션이 열립니다** — `TargetList.swift:136-143`, `193-195`
   - 왜: `guardTripped()`는 이미 열린 `active` 세션만 끝냅니다.
   - Touch ID 뒤 경로를 여는 동안(최대 3+10초)이나 키 교환 중(5초)에 A가 잠기거나 잠들거나 사용자가 바뀌어도, 끝나면 세션 창이 열리고 B의 한도까지 스트림이 이어집니다. 설계는 「즉시 끝낸다」입니다.
   - 연결 중에 「이 Mac에서 삭제」를 눌러도 지운 대상의 세션이 열립니다.
   - 고칠 방법: 연결 Task를 보관했다가 경비가 걸리거나 삭제하면 취소합니다. `open` 직전에 경비 세대 번호를 확인하고, 걸렸으면 `connected.viewer.close()`만 합니다.

4. **[낮음, 조작 빌드에서만] Secure Event Input이 꺼지지 않고 남을 수 있습니다** — `SecureEntryView.swift:38-57`, `SessionWindow.swift:94-101`
   - 왜: 보안 입력칸에 초점이 있는 채로 세션이 끝나면, 버퍼만 지우고 창을 닫습니다. 창을 닫아도 `resignFirstResponder`나 `viewWillMove(toWindow:nil)`가 불리지 않으므로 `DisableSecureEventInput`이 실행되지 않고, Viewer가 살아 있는 동안 켜진 채 남습니다.
   - A에서 다른 앱으로 옮겨 가도 켜진 채 남습니다. SR-28은 「초점이 있는 동안」만 켜도록 정합니다.
   - 고칠 방법: `finished`와 `windowWillClose`에서 `makeFirstResponder(nil)`을 부릅니다. 창이 key를 잃거나 앱이 비활성이 될 때 끄고, deinit에서도 끕니다.

5. **[낮음, 추정] 잠긴 B 입력칸이 아예 열리지 않을 수 있습니다** — `ScreenTargetRoute.swift:169-171`
   - 왜: `allowsLockedEntry`가 `canSendInput`, 즉 `inputAvailability == .ready`를 요구합니다.
   - B의 `LocalInputMonitor`는 시스템 전체의 `IsSecureEventInputEnabled()`를 보는데, 잠금 화면은 보안 입력을 켭니다. 그러면 B가 `.secureInput`을 보내고 D-3 입력칸이 열리지 않습니다. B의 `InputInjector.swift:173`도 보안 입력 중에는 거절합니다.
   - SR-28의 조건은 권한, 관문, 잠김 세 가지뿐입니다.
   - 고칠 방법: wp-screen-host와 S0-2에서 잠긴 B가 무엇을 알릴지 계약을 정합니다. 그 전에는 입력칸 판정에서 `locked == true`일 때 `.secureInput`을 예외로 둘지 정하고 검사를 더합니다.

6. **[낮음, 조작 빌드에서만] 입력이 눌린 채 남습니다** — `InputForwarder.swift:46,73-77`
   - 영상 밖에서 뗀 버튼(mouseUp)을 B에 보내지 않습니다. 끌다가 띠나 도구 막대에서 놓으면 B의 버튼이 눌린 채 남습니다.
   - 창이 key를 잃거나(A에서 ⌘Tab) 입력 관문이 닫힐 때 누르던 키를 떼지 않습니다.
   - `acceptsMouseMovedEvents`를 켜지 않아 마우스를 올려 두는 동작이 B로 가지 않습니다.
   - 고칠 방법: 보낸 down에는 up을 가장자리로 고정해 보냅니다. 창이 key를 잃거나 관문이 닫히면 눌린 키를 뗍니다. 이동 이벤트를 켭니다.

7. **[낮음] 띠 문구가 이유를 빠뜨리거나 틀린 채 남습니다** — `ScreenTargetRoute.swift:338-353`, `ViewerSession.swift:74-78`
   - B가 `.permissionsRequired`, `.monitorUnavailable`, `.localActivity`를 알리면 입력은 막히는데 이유 줄이 없습니다.
   - 5분 경고(`limitWarned`)는 한 번 켜지면 다시 꺼지지 않습니다. 조작 세션에서 입력을 이어 가 마감이 늦춰져도 「5분 뒤 끝납니다」가 남습니다.
   - 고칠 방법: 세 경우의 문구를 더합니다. 경고는 `watch.warns`로 매번 다시 판정합니다.

8. **[낮음] 잠금 입력 줄이 헷갈리게 보입니다** — `SessionWindow.swift:178-184`
   - `locked == false`이거나 이 빌드에서 입력칸을 쓸 수 없을 때도 「B 잠금 암호」 라벨과 누를 수 있는 「보내기」 버튼이 칸 없이 보입니다.
   - 「가짜일 수 있으니 암호를 입력하지 마세요」 경고는 세션 내내 고정됩니다.
   - 고칠 방법: 칸을 숨기면 버튼도 숨깁니다. 경고를 고정할지 설계와 맞춥니다.

9. **[낮음, 시험 범위] 앱 쪽 연결 코드가 시험되지 않습니다** — `ViewerRouteChecks.swift:646-654,682`
   - loopback 검사는 `ViewerSession.hear`의 처리를 검사 안에서 다시 구현합니다.
   - 「폰 이어받기」는 B가 중재한 결과가 아니라 검사가 직접 `pump.end(.takenOver)`를 부른 것입니다.
   - 그래서 ViewerSession, TargetList, `HumanActions.verdict`(2번 문제 포함)는 소스 문자열 검사로만 지켜집니다. 빌더 보고서에도 적혀 있는 한계입니다.
   - 고칠 방법: ViewerSession의 순수 상태 부분(state, watch, 주소 제안, 원장 갱신)을 코어로 옮겨 시험합니다. 검사 이름에 「B 쪽 이어받기는 흉내」라고 밝힙니다.

10. **[낮음] 저장 실패를 조용히 삼킵니다** — `ViewerSession.swift:178`, `TargetList.swift:141`
   - 왜: 주소 저장과 연결 뒤 행 갱신이 `try?`로 실패를 버립니다. 주소 저장은 실패해도 제안을 닫아서, 사람은 저장된 줄 압니다.
   - 고칠 방법: 실패를 문구로 보이고, 저장 제안은 남겨 둡니다.
