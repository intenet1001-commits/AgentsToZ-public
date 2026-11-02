# feature2-viewer · review:core

(agent final report, verbatim)

English translation: "Once it's connected, I can just keep using it comfortably, right?"

결함 6건을 찾았습니다(중간~낮음 4건, 사소 2건). 지금 폰을 깨뜨리거나 보안 규칙을 어기는 것은 없습니다. 테스트는 이 브랜치에서 그대로 통과합니다.

**확인한 것** (임시 worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/rv-viewer-core`, d543cc66, 끝난 뒤 지웠습니다)
- **테스트:** `bun scripts/check-screen-control.ts`가 EXIT 0이었습니다.
  - 117/117 screen-control checks passed
  - SR-36 계약 검사와 status file 검사 통과
  - XCTest: Executed 13 tests, 0 failures
- **골든 값:**
  - `key-schedule.py`의 v1·v2 출력이 main과 바이트 단위로 같습니다.
  - 새 v4 phone hello와 v4·v5 전사·키 값이 Python 참조 출력과 같습니다.
  - 기존 테스트의 골든 값은 하나도 바뀌지 않았습니다.
- **SR-36 변이 시험:** `MacHandshake.settle`에서 폰을 4로 묶는 코드를 지우면 검사가 실패합니다(role labels 검사가 실패하고 그 뒤에서 멈춥니다). 테스트가 이 성질을 실제로 지킵니다.
- **커넥터 판별:** 리스너가 받은 연결의 `NWConnection.currentPath?.localEndpoint`가 `start` 전에도 채워져 있음을 loopback의 임시 포트로 직접 확인했습니다. 실제 동작에서도 커넥터를 판별할 수 있습니다.
- **건드리지 않은 것:** ScreenPush·켜 두기·잠금 해제·TCC·키체인·52741, 그리고 AI 진입점은 바뀌지 않았습니다. ScreenService는 문구만 바뀌었습니다. 테스트는 loopback 임시 포트와 framePipe만 씁니다.

**결함 (심각한 순)**

1. **`native/screen-control/Sources/ScreenControlCore/VideoPump.swift:272-276`** (중간~낮음, SR-21)
   - **이유:** `features.grant`와 `input`이 서로 상관없이 정해집니다. 호스트가 `grant: .view`와 함께 입력 받는 객체(nil 아님)를 넘기면 다음이 동시에 일어납니다.
     - Viewer는 「보기만」(`sessionLimits(.view)`)을 듣습니다.
     - B는 그 컨트롤러의 입력 레코드를 그대로 주입합니다.
   - 「보기 권한의 입력은 버린다」가 호스트의 올바른 연결에만 기대고 있고, 코어에는 막는 장치가 없습니다. wp-screen-host가 바로 이 API 위에 올라갑니다.
   - **수정:** `connection.version >= 5 && features.grant == .view`이면 input을 nil로 다룹니다(레코드 버림, `.viewOnly`). `.view` 권한과 실제 입력이 함께 들어온 경우를 검사로 추가합니다.

2. **`native/screen-control/Sources/ScreenControlCore/Handshake.swift:421-422`** (낮음, SR-33)
   - **이유:** 공개 API `MacHandshake.respond(to:)`가 기본값으로 모든 peerClass를 받습니다. 리스너와 `ScreenTransportHandshake.accept`의 기본값(폰만)과 반대로 열려 있습니다. 지금 운영 코드에서 부르는 곳은 없지만, 나중에 누가 부르면 리스너별 종류 허용을 조용히 우회합니다.
   - **수정:** 기본값을 `[.phone]`으로 바꾸거나 internal로 내립니다.

3. **`native/screen-control/Sources/ScreenControlCore/PreAuthGate.swift:193` + `native/screen-control/Sources/ScreenControlCore/Transport.swift:267-268`** (낮음, SR-25)
   - **이유:** `rekey`의 `now`는 비동기 `handshake.knows()` 조회가 끝난 뒤에 잽니다. 첫 프레임이 2초 마감 직전에 도착해도, 조회가 마감을 넘기면 다음이 일어납니다.
     - 게이트의 `expireOverdue`가 티켓을 지웁니다.
     - 그 시도는 `.busy`로 거절됩니다.
     - v5 Viewer는 `busy` 안내를 받습니다.
   - **수정:** `framed.receive()` 직후의 도착 시각을 `rekey(at:)`에 넘깁니다. 또는 첫 프레임을 받은 티켓은 첫 프레임 마감으로 만료시키지 않습니다.

4. **`native/screen-control/Sources/ScreenControlCore/Handshake.swift:302`** (낮음, 문구만, 6.4)
   - **이유:** Viewer가 Mac 서명을 확인하기 전에 `versionBelowMinimum`으로 멈춥니다. 그래서 경로 중간의 공격자가 Nm의 버전 표식만 4로 바꿔도 「B를 업데이트하세요」가 뜹니다. 서명을 확인하는 일에는 생체 인증이 필요 없으므로 먼저 확인해도 비용이 없습니다.
   - **수정:** Mac 서명 확인을 버전 하한 검사 앞으로 옮깁니다. 생체 서명을 만들기 전에 닫는다는 성질은 그대로 유지됩니다.

5. **`native/screen-control/Tests/ScreenControlCoreTests/NegotiationChecks.swift:20-22`, `native/screen-control/Tests/ScreenControlCoreTests/ScreenControlChecks.swift:118`** (사소, 테스트 정직성)
   - **이유:** `.current`가 이제 Mac의 정책(최대 5)인데, 이름이 그 뜻을 따라가지 않았습니다.
     - 협상 표의 "two version-4 builds", "a newer phone/Mac settles on what this … speaks"는 실제로는 「5를 제안한 폰이 Mac 쪽 상한 때문에 4로 정해짐」을 검사합니다.
     - `Fixture.device()`의 설명 "A phone that negotiates like this build"도 진짜 폰 정책(`.phone`)이 아닙니다.
     - 판정 자체는 맞습니다.
   - **수정:** 표의 이름과 Fixture 설명을 실제 의미로 고칩니다. 진짜 폰 정책인 `.phone`↔`.upTo(3/4)` 줄을 TCP 표에 더합니다.

6. **`scripts/check-screen-control.ts:52`** (사소)
   - **이유:** SR-36 iOS 소스 검사가 gitignore된 `mobile/ios/build/**` 사본(DerivedData, ui-evidence 앱 소스 사본)까지 훑습니다. 지금은 걸리는 것이 없지만, 오래된 사본 때문에 거짓 실패가 날 수 있고 불필요하게 느립니다.
   - **수정:** `git ls-files 'mobile/ios/**/*.swift'`로 추적되는 파일만 검사합니다.

참고: 검토하는 동안 main이 `aee852d0`으로 움직였습니다. 제가 한 일은 아닙니다. 그래서 이 브랜치는 합치기 전에 main 위로 다시 맞춰야 합니다.
