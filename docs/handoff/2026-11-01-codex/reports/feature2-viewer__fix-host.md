# feature2-viewer · fix:host

(agent final report, verbatim)

English translation: "Once it's connected, the idea is that you can just keep using it comfortably, right?"

**결과:** 리뷰 지적 6건을 모두 고쳤고 거절한 것은 없습니다. 테스트는 전부 통과했고 `feat/viewer-screen-host`에 커밋 `49c571cf` 하나로 올렸습니다. 푸시하지 않았고 main도 건드리지 않았습니다.

**Branch:** `feat/viewer-screen-host`, worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-20`

**Commit:** `49c571cf` fix(screen): review findings on the screen host — push gate needs a phone, view-only reasons, log and marker safety (trailer 포함, base `23f59f7c`)

**지적별 처리**
1. **전화 없이 열리던 푸시 관문 (중상):** 두 겹으로 막았습니다.
   - `PushLiveness.noteRound(reaching:)`는 전화가 0대인 라운드면 관문을 바로 닫습니다. 예전 `noteRoundSucceeded`를 대신합니다.
   - 관문을 읽는 모든 곳(키 조회, `accept`, `pushLive`, 켜 두기)이 이제 `ScreenPeerKeys.pushGateOpen`을 거칩니다. 여기서 만료되지 않은 전화가 하나 있어야 합니다.
   - 테스트를 붙였습니다. 다른 Mac만 쓰는 Mac에서는 관문이 열리지 않고, 묶이지 않은 controller는 `notAccepted`를 받고, `keepOnOffered`는 false입니다.
2. **D-3·푸시 추가분 미검증:** 모두 테스트를 붙였습니다. 다룬 범위는 `ControllerLockedInput.admits` 표, `HostSessionPlan.lockedInputOpen`, 실제 경로의 lock 가드입니다. 이 가드는 `HostInputPath`로 옮겨 앱 streamer와 test rig가 같이 쓰고, 연결이 그대로인지 소스 계약 테스트로 확인합니다. 그 밖에 controller 행이 들어간 `remoteStopState`, `ScreenPush.apply`의 revokeDevice·revokeConnected·superseded, kind 3/4의 수신자와 actor, 30분 창과 시계 역행도 다뤘습니다. enrollController 쪽은 스위치가 켜지는지, kind 4 다음 kind 3이 가는지(`RecordingPushTransport`, turnOn 안 함), SR-22 거절을 확인합니다. `testEveryTurnOffLetsGo`에는 phone 끄기, remote 끄기, 저장 실패를 더했습니다.
3. **marker 경쟁:** `RemoteInputMarker`는 이제 큐 하나를 공유하고, 쓰기와 삭제를 자기 lock 안에서 요청하며, 삭제는 한 번만 합니다. 세션 순서 테스트를 붙였습니다.
4. **보기 전용 이유:** v5에 `notificationsUnconfirmed=6`, `controlNotInThisBuild=7`을 넣었습니다(v1–4에서는 malformed). 입력 보호가 없는 경우는 기존 `.permissionsRequired`를 그대로 씁니다.
   - `limitedByGate`는 `viewOnlyCause`(build / notifications / inputProtection)로 바뀌었고, `SessionFeatures.viewOnlyReason`으로 pump에 전달됩니다.
   - 전화(v4)가 받는 바이트는 그대로입니다. SR-36 검사 통과.
5. **로그 읽기 실패 시 이력 소실:** `StoredControllerLog.readFailed`일 때는 저장된 로그 위에 쓰지 않고, 다음 기록 때 다시 읽어 합칩니다. 메뉴용으로 `controllerHistoryUnread`를 추가했습니다.
6. **`enrollController`:** internal로 바꾸고 `phones: try store.devices()`를 씁니다. 다른 viewer 브랜치에 호출처는 없습니다.

**파일:** 소스 10, 테스트 4
- `native/screen-control/Sources/ScreenControlCore/{Session,VideoPump}.swift`: wp-core-v5 파일이지만 4번 때문에 고칠 수밖에 없었습니다. Core 파일이 viewer-app·viewer-pairing 브랜치와 같으므로 깨끗하게 합쳐집니다.
- `mobile/ios/App/ScreenViewerView.swift`: 이 enum을 빠짐없이 다루는 switch가 저장소에 이것 하나뿐이라 고칠 수밖에 없었습니다. 새 값은 "화면 보기만 가능합니다."로 표시합니다.
- `native/screen-control/Sources/ScreenHost/{ControllerLog,HostStreamer,RemoteInputMarker,ScreenPush,ScreenService,ScreenServiceEnvironment,ScreenSessionRules}.swift`
- `native/screen-control/Tests/ScreenControlCoreTests/SessionV5Checks.swift`
- `native/screen-control/Tests/ScreenHostTests/{ControllerSessionTests,ControllerLogTests,ScreenPowerTests}.swift`

**실행한 명령과 결과**
- `swift build --build-tests --package-path native/screen-control` → Build complete
- `swift test --package-path native/screen-control --filter ScreenHostTests` → 첫 실행 79개 중 1개 실패. 실패는 제 테스트가 틀린 것이었습니다(`disableKeepOn`은 화면 제어를 켜 둔 채로 둡니다). 그 assertion을 고쳤습니다.
- `swift test --package-path native/screen-control` → 85개, 실패 0
- `bun run test:screen-control` → exit 0, 119/119 검사 통과, XCTest 72개 실패 0, SR-36 줄 확인
- TS/Rust 변경이 없어 typecheck와 cargo는 돌리지 않았습니다. iOS 앱 빌드도 돌리지 않았고, switch는 눈으로만 확인했습니다.
- 실제 화면, 입력, TCC, 키체인, 52741/3001, 서명은 건드리지 않았습니다.

**남은 일과 넘길 것**
- **Viewer 쪽 문구:** `feat/viewer-app`의 `ScreenTargetRoute.swift`에서 `ScreenTargetText.band`가 아래 셋을 각각 따로 표시해야 합니다. 지금은 셋 다 `remoteInputPaused` 문구로 떨어집니다.
  - `.notificationsUnconfirmed`
  - `.controlNotInThisBuild`
  - 조작 권한 controller가 받는 `.permissionsRequired`
- **worktree -14:** 처음에 `git checkout --ignore-other-worktrees`를 썼기 때문에 `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14`도 같은 브랜치를 잡고 있습니다. 그쪽 작업 트리는 이제 `49c571cf`보다 뒤처져서, `git status`에 제 변경이 거꾸로 보입니다. 그곳에서 커밋하기 전에 맞춰야 합니다.
- **하지 않은 것:**
  - 세션 도중 관문이 닫힐 때 조작을 내리는 처리는 선택 항목이라 넣지 않았습니다. 이미 조작 중인 세션은 그대로 유지됩니다.
  - Info.plist 플래그 3개는 여전히 빌드 스크립트가 쓰지 않으므로 빌드 쪽에서 맡아야 합니다.
  - Screen이 꺼져 있을 때의 푸시 신원은 문제없어서 바꾸지 않았습니다.
- **"한번 연결하면 쭉 쓰는지"에 대해:** 이번 수정으로 바뀐 것은 없습니다.
  - 조작 권한 controller 세션은 무입력 1시간, 최대 8시간입니다. 보기 전용은 1시간/1시간입니다.
  - "켜 두기"(SR-27)는 저장한 네트워크에서만 다시 켜집니다. 이제 사용 중인 전화가 있고 푸시가 확인돼야(9절) 제공됩니다.
