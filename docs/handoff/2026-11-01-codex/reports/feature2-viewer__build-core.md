# feature2-viewer · build:core

(agent final report, verbatim)

English translation: "Once it is connected, you can just keep using it comfortably, right?"

wp-core-v5와 wp-preauth를 구현해 `feat/viewer-core-v5`에 커밋 1개로 올렸고, 커밋한 트리에서 검사를 다시 돌려 모두 통과했습니다. 푸시하지 않았고 main은 건드리지 않았습니다.

질문에 대한 답: 네. 이번 작업은 한 번 연결해 두면 계속 편하게 쓰는 흐름을 위한 기반입니다. 등록된 기기는 프로토콜 5로 협상하고, 거절되면 그 이유를 안내받습니다. 같은 Mac 안 커넥터에서는 기기마다 연결 횟수 한도를 따로 세서, 한 기기가 막혀도 다른 기기나 LAN 연결은 막히지 않습니다. 기존 폰은 v4 그대로 바이트 단위까지 같게 동작합니다.

- **워크트리:** /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-1
- **브랜치:** feat/viewer-core-v5 (main f3e96658에서 분기)
- **커밋:** d543cc66 "feat(screen): session protocol 5 with phones pinned at 4, per-listener peer classes, pre-auth notices and connector sub-buckets" (요구된 Co-Authored-By / Claude-Session 트레일러 포함)

**바꾼 파일** (워크트리 기준 경로)
- `native/screen-control/Sources/ScreenControlCore/`: Encoding, Handshake, PreAuthGate, Transport, FrameTransport, Session, Video, VideoPump, Viewer (.swift)
- 새 검사 파일 `native/screen-control/Tests/ScreenControlCoreTests/`:
  - SessionV5Checks.swift (9개)
  - PreAuthConnectorChecks.swift (6개)
- 기존 검사 파일 `native/screen-control/Tests/ScreenControlCoreTests/`:
  - ScreenControlChecks.swift: v4 폰 세션을 다루는 두 검사가 이제 `phoneVersion`을 씁니다. `version`(5)이었다면 아무것도 확인하지 않고 통과했을 것입니다.
  - DesktopControlChecks, SessionControlChecks: 버전별 목록을 명시했습니다. 검사를 약하게 만든 곳은 없습니다.

**패키지 밖에서 어쩔 수 없이 고친 파일**
- `native/screen-control/Sources/ScreenHost/ScreenService.swift`: 새 종료 사유의 switch 분기.
- `mobile/ios/App/ScreenViewerView.swift`: 새 종료 사유 3개를 endedAtMac 분기에 합치고, viewOnly 문구를 넣었습니다.
- `native/screen-control/reference/key-schedule.py`: v4·v5 벡터를 추가했습니다. v1·v2 출력은 그대로입니다.
- `scripts/check-screen-control.ts`:
  - SR-36 소스 계약 검사를 추가했습니다.
  - 실행 제한 시간을 120초로 늘렸습니다.
  - `swift test --filter`에 Mac-to-Mac 호스트 테스트 그룹 이름을 미리 넣었습니다.

**실행한 명령과 결과**
- `bun scripts/check-screen-control.ts` (커밋 후 다시 실행): EXIT 0
  - 117/117 screen-control checks passed
  - SR-36 계약 줄 통과
  - status file 검사 통과
  - 필터한 XCTest: Executed 13 tests, with 0 failures
- `bun run test:ios` (커밋 전): EXIT 0
  - 21 native regression groups, 15 gesture, 21 lifecycle, 117/117 screen-control 통과
  - LAN 서버는 포트 0(임시 포트)만 썼고 3001·52741에는 붙지 않았습니다.
- `swift build --package-path native/screen-control`: Build complete
- `swiftc -typecheck` (core + checks): 경고·오류 0
- `scripts/check-screen-control.ts` strict tsc (scratchpad tsconfig): EXIT 0
- `git diff --check`: 문제 없음

**하지 않은 것**
- `bun run typecheck`는 돌리지 않았습니다. 이 워크트리에 node_modules가 없고, tsconfig가 `scripts/`를 포함하지 않으며, 앱 TS는 바꾸지 않았습니다.
- Rust를 바꾸지 않아 cargo test는 돌리지 않았습니다.
- iOS 앱 전체 빌드(xcodebuild 시뮬레이터, 서명 없음)는 "bundled portal missing"으로 멈췄습니다. ScreenViewerView.swift의 Swift 컴파일 자체는 arm64·x86_64 모두 오류 없이 끝났습니다.
- 52741 호스트가 컨트롤러를 받아들이게 하는 쪽은 wp-screen-host 작업으로 남았습니다. `accepting: [.phone, .controller]`를 켜고 컨트롤러 등록 정보를 넘겨야 하는데, 지금은 모든 리스너가 폰만 받습니다.
- 버전 광고(TXT pv=5)는 넣지 않았습니다.
- 실제 화면 캡처, 입력, TCC, 키체인, 서명은 쓰지 않았고, AI 경로에서 사람 화면 세션을 여는 길도 추가하지 않았습니다.
