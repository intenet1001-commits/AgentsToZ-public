# feature2-viewer · fix:core

(agent final report, verbatim)

English translation: "Once it's connected, I can just keep using it comfortably, right?"

**결과:** 결함 6건을 모두 고쳤고 거절한 것은 없습니다. 다만 커밋은 지시된 `feat/viewer-core-v5`가 아니라 새 브랜치 `feat/viewer-core-v5-fix`에 있습니다.

**브랜치와 커밋**
- `feat/viewer-core-v5`는 다른 worktree(`/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-1`)가 체크아웃하고 있어서 제 worktree에서 체크아웃할 수 없었습니다. 그 worktree는 격리 규칙상 건드릴 수 없었습니다.
- 그래서 `feat/viewer-core-v5`(d543cc66)에서 `feat/viewer-core-v5-fix`를 만들고 커밋 1개를 올렸습니다. `97055da4 fix(screen): review findings on session protocol 5 and the connector gate`
- 원래 브랜치는 d543cc66 그대로입니다. 이 커밋은 그 위에 바로 이어지므로 fast-forward로 합칠 수 있습니다.
- main이 움직였지만(aee852d0) 다시 맞추지 않았습니다. 합칠 때 해야 합니다.

**고친 것 (리뷰 번호 순)**
1. **SR-21, `VideoPump.swift`:** 버전 5 세션에서 권한이 `view`이면 호스트가 입력을 넘겨도 입력이 없는 세션처럼 동작합니다(`SessionFeatures.grantsViewOnly`).
   - 입력 레코드는 버립니다. `textAndReturn`에는 `.blocked`로 답하고 Viewer는 `viewOnly`를 듣습니다.
   - 같은 규칙이라 리뷰 범위를 조금 넓혔습니다. 보기 권한에서는 `keyboardAction`과 `navigateSpace`도 실행하지 않고 `.blocked`로만 답합니다.
   - 폰(버전 4 이하)은 권한이 없으므로 동작이 바뀌지 않습니다.
2. **SR-33, `Handshake.swift`:** `MacHandshake.respond(to:)`는 이제 폰만 받습니다. 컨트롤러를 받아야 하는 시험은 받을 종류를 직접 넘기도록 고쳤습니다.
3. **SR-25, `PreAuthGate.swift`와 `Transport.swift`:** 첫 프레임을 받은 직후, 기기 조회 전에 도착 시각을 게이트에 알립니다(`PreAuthGate.heardFirstFrame(_:at:)`, 새 public 메서드).
   - 마감 안에 온 프레임은 첫 프레임 마감으로 만료되지 않습니다. 전체 5초 마감은 그대로입니다.
   - 늦게 온 프레임은 그대로 늦은 것으로 칩니다.
4. **6.4, `Handshake.swift`:** Viewer가 Mac 서명과 확인값을 먼저 검증하고, 그다음 버전 하한을 봅니다.
   - 경로 중간에서 버전 표식을 4로 바꾸면 이제 `badSignature`가 되고 「B를 업데이트하세요」는 뜨지 않습니다.
   - 생체 서명보다 먼저 닫는 성질은 유지됩니다.
5. **시험 이름:** 협상 표의 이름을 실제 의미대로 고쳤습니다.
   - 진짜 폰 정책 `.phone`을 Mac 1~4, 이 Mac과 짝지은 줄을 더했고, 「5를 제안한 폰 키는 4로 정해짐」 두 줄도 넣었습니다.
   - 이 표는 메모리 시험과 TCP 시험이 함께 씁니다.
   - `Fixture.device()`는 다른 시험의 의미가 바뀌지 않도록 기본값 `.current`를 그대로 두고 설명만 고쳤습니다.
6. **`scripts/check-screen-control.ts`:** iOS 소스 검사는 이제 `git ls-files --cached --others --exclude-standard -- mobile/ios`에 나오는 파일만 봅니다. 목록에 `ScreenViewerView.swift`가 없으면 실패하므로 빈 목록으로 통과할 수 없습니다.

**새 검사**
- "SR-21: a view grant drops the input the host passed"
- "connector: a first frame in time outlives a slow lookup": 게이트 단위와 framePipe로 600ms 걸리는 조회 두 가지
- 기본 `respond(to:)`가 컨트롤러를 거절하는 검사
- 표식을 바꾼 v5 macHello가 `badSignature`가 되고 서명이 0번인 검사

**실행한 명령과 결과**
- 최종 트리에서 커밋 전과 후에 두 번 돌렸고 둘 다 같은 결과입니다. `bun scripts/check-screen-control.ts` → EXIT 0
  - 119/119 screen-control checks passed (이전 117에서 새 검사 2개 추가)
  - SR-36 계약 검사와 status file 검사 통과
  - XCTest: Executed 13 tests, 0 failures
- **변이 시험:** 패키지 사본 4개에서 수정을 하나씩 되돌렸고, 4개 모두 해당 검사가 실패했습니다(118/119).
  - 1번: SR-21 검사 실패 (`inputAvailability(.ready)`, posted)
  - 2번: "expected peerClassRefused, nothing was thrown"
  - 3번: `PreAuthAccountRefusal(... busy)`
  - 4번: "expected badSignature, got versionBelowMinimum"
- **6번 확인:** gitignore된 `mobile/ios/build/Bait/Bait.swift`에 `peerClass: .controller`를 넣어 두었습니다.
  - 목록에 잡힌 것은 Swift 파일 39개, build/ 아래 0개였습니다.
  - 그 파일을 둔 채 돌린 최종 실행도 통과했습니다. 미끼 파일은 지웠습니다.
- **스크립트 타입 검사:** `scripts/`는 `tsconfig` 범위 밖이라, 바뀐 스크립트만 `tsc`로 따로 검사했습니다. EXIT 0입니다.
- **골든 값:** `reference/`, `mobile/ios`, 시험의 `hex("…")` 골든 값은 하나도 바뀌지 않았습니다(diff 0줄).

**하지 않은 것**
- `cargo test`: Rust를 바꾸지 않았습니다.
- `bun run typecheck`: 바뀐 TS 파일이 그 범위에 없고 worktree에 node_modules도 없습니다.
- `bun run test:ios`: iOS와 AgentsToZCore를 바꾸지 않았고, 그중 screen-control 부분은 위 스크립트와 같습니다. 이 스크립트는 사설 인터페이스에 LAN 서버를 띄웁니다. 그런데 패키지 시험 목록에는 들어 있으니 합치기 전에 한 번 돌려야 합니다.
- **남은 작은 틈:** 첫 프레임을 읽은 뒤 `heardFirstFrame`을 부르기까지 actor 한 번을 거치는 아주 짧은 순간이 남아 있습니다. 마감 바로 그 시점에 도착한 프레임에만 해당합니다.

**바꾼 파일** (모두 `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-12/` 아래)
- `native/screen-control/Sources/ScreenControlCore/VideoPump.swift`
- `native/screen-control/Sources/ScreenControlCore/Handshake.swift`
- `native/screen-control/Sources/ScreenControlCore/PreAuthGate.swift`
- `native/screen-control/Sources/ScreenControlCore/Transport.swift`
- `native/screen-control/Tests/ScreenControlCoreTests/SessionV5Checks.swift`
- `native/screen-control/Tests/ScreenControlCoreTests/PreAuthConnectorChecks.swift`
- `native/screen-control/Tests/ScreenControlCoreTests/NegotiationChecks.swift`
- `native/screen-control/Tests/ScreenControlCoreTests/ScreenControlChecks.swift`
- `scripts/check-screen-control.ts`
