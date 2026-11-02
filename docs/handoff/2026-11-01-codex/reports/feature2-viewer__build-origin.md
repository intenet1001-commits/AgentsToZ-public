# feature2-viewer · build:origin

(agent final report, verbatim)

English translation: "Once it's connected, the idea is that you can just keep using it comfortably, right?"

**질문에 대한 답:** 절반만 맞습니다. 등록은 A→B 한 쌍마다 한 번만 하면 됩니다. 연결은 그렇지 않아서, 연결할 때마다 A에서 Touch ID(또는 Watch)를 받습니다. 세션에는 한도가 있습니다. 보기는 시작 후 60분, 조작은 아무 입력이 없으면 60분, 길어도 최대 8시간입니다. 끊기면 자동으로 다시 연결하지 않습니다. D-2 「켜 두기」를 켜면 재시작·업데이트 뒤에도 B가 저장한 네트워크에서 다시 켜집니다. 그러니 B 앞에 가서 다시 켤 필요는 없지만, A에서는 연결마다 생체 인증을 거칩니다.

**작업 결과 (wp-input-origin):** 하드웨어 입력만 받는 판정을 구현했고, 해당 검사가 모두 통과했습니다. 브랜치는 `feat/viewer-input-origin`(main `f3e96658`에서 시작, 합칠 의존 브랜치 없음), 커밋은 `fa83eb8f` 하나입니다.

**바꾼 파일**
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-2/native/screen-control/Sources/ScreenControlCore/ScreenInputOrigin.swift` (새 파일, Foundation만 import)
  - `forward(sourcePid:ownPid:screenPid:keyboardType:sourceState:poster:calibration:)`: pid 0인 이벤트만 B로 보냅니다.
  - `humanClick` / `humanKey`: 1초 안의 하드웨어 mouse-up이 컨트롤 안에 있거나, 하드웨어 key-down이 컨트롤에 들어왔을 때만 받습니다. 현재 이벤트가 없는 AX 액션은 `no-current-event`로 거절합니다.
  - 원격 데스크톱(screensharingd·Jump)은 어떤 경로로도 받지 않습니다. 서명 신원은 거절 문구를 고르는 데만 씁니다.
  - `ScreenInputCalibration.current`는 아직 S-M3를 하지 않아 `.unmeasured`(pid 0만으로 판정)입니다. 조작 빌드 플래그 `allowsControl`은 S-M3를 통과해야만 참이고, 지금은 거짓입니다.
  - 12절 거절 문구 두 개를 `ScreenInputOriginText`에 한국어로 넣었습니다.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-2/native/screen-control/Tests/InputOriginContract/vectors.json` (새 파일): forward 19개, humanClick 18개, humanKey 10개.
  - 가상 HID(HanYeong·JumpJamoRelay·Karabiner) 벡터는 지어낸 측정값 대신 `measured:false`와 `residualRisk` 표식을 달았습니다.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-2/native/screen-control/Tests/ScreenControlCoreTests/InputOriginChecks.swift` (새 파일, 검사 6개)
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-2/tests/screen-input-origin-sync.test.ts` (새 파일): ControlBarRules.swift와 ScreenInputOrigin.swift, 벡터 파일의 값이 같은지 봅니다(pid 0, 1초 경계 포함, 원격 데스크톱 목록). 두 Swift 패키지가 서로 의존하지 않는지도 봅니다.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-2/native/screen-control/Tests/ScreenControlCoreTests/ScreenControlChecks.swift`: 묶음 목록 밖의 파일이지만, 병합 규칙에 따라 `all` 줄에 `inputOriginChecks` 한 칸만 더했습니다.

폰 프로토콜, 기존 골든 벡터, 다른 기존 소스는 건드리지 않았습니다.

**검증 (마지막 커밋 기준으로 다시 돌린 결과)**

| 명령 | 결과 |
|---|---|
| `bun run test:screen-control` | 108/108 통과(새 검사 6개 포함), 호스트 XCTest 13건 0 실패, 상태 파일 계약 통과 |
| `swift test --package-path native/screen-control --filter 'ScreenControlCoreTests.ScreenControlCoreTests/testSecurityRequirements'` | 1건 0 실패(XCTest에서도 벡터 경로가 읽힘) |
| `bun test tests/screen-input-origin-sync.test.ts` | 6 pass, 0 fail, expect 99회 |
| `bun run typecheck` | 종료 코드 0 |
| `swift build --package-path native/screen-control` | Build complete |
| iOS 시뮬레이터용 `swiftc -typecheck`(ScreenControlCore) | 종료 코드 0 |

- 검사가 실제로 실패를 잡는지도 확인했습니다. Swift 쪽은 패키지 사본에 결함 11개를 넣어 모두 잡혔습니다. TS 쪽은 ControlBarRules와 벡터를 4가지로 잠시 바꿔 모두 잡혔고, 끝난 뒤 되돌려 트리는 깨끗합니다.

**돌리지 않은 것과 남은 일**
- 돌리지 않음: `cargo test`(Rust 변경 없음), 전체 `bun run verify`·전체 `bun test`, `bun run test:ios`. 테스터 quick·personas도 돌리지 않았습니다. 테스터 맞추기가 3001에 접속해야 하는데, 이번 작업에서는 금지돼 있습니다.
- S-M3 실측이 없습니다. 그래서 벡터의 keyboardType·sourceState는 예시 값이고, 가상 HID는 남는 위험으로 표시해 두었습니다. S-M3 결과를 기록할 때 `ScreenInputCalibration.current`, 벡터의 `calibration` 블록, SPIKES.md를 함께 바꿔야 하며, 어긋나면 검사가 실패합니다.
- 연결할 때 지킬 점:
  - wp-screen-host, wp-screen-ui, wp-viewer-app은 조작 빌드 플래그를 새로 만들지 말고 `ScreenInputCalibration.current.allowsControl`을 써야 합니다.
  - 이벤트를 보낸 프로세스의 서명 신원(`ScreenInputPoster`)을 읽는 일은 wp-viewer-app 몫입니다.
  - `ScreenControlChecks.all` 줄은 다른 묶음과 텍스트 충돌이 날 것으로 예상됩니다. 병합할 때 한 칸씩 합치면 됩니다.
