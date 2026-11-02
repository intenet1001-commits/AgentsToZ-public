# feature2-viewer · build:viewer

(agent final report, verbatim)

English translation: "So the idea is that once it's connected, I can just keep using it comfortably, right?"

네, 거의 그렇습니다. 다만 "계속"에는 정해진 한도가 있습니다.
- **등록은 한 번이면 됩니다.** 등록한 Mac은 이 Mac의 키체인에만 남습니다.
- **연결할 때마다 Touch ID나 Apple Watch로 한 번 확인합니다.** 비밀번호는 묻지 않습니다.
- **연결된 뒤에는 B가 정한 한도까지 그대로 씁니다.** 보기는 시작 후 60분, 조작은 아무 입력이 없으면 60분, 최대 8시간입니다. 끝나기 5분 전에 소리와 함께 알려 줍니다.
- 이 Mac이 잠기거나 잠들거나 사용자가 바뀌면 바로 끝납니다. 저절로 다시 연결하지 않으므로, 이어 쓰려면 다시 연결하고 생체 인증을 한 번 더 합니다.
- **이 빌드는 보기만 됩니다.** 입력 출처 실측(S-M3)이 끝나기 전에는 조작이 꺼져 있습니다.

아래는 이번 작업 패키지(wp-viewer-app) 결과입니다.

**브랜치와 커밋**
- 브랜치 `feat/viewer-app`: main에서 갈라 의존 브랜치 3개를 병합했습니다.
  - `b01a0d38` feat/viewer-core-v5
  - `6c25a25d` feat/viewer-core-v5-fix
  - `461b7d6d` feat/viewer-input-origin
- 이번 작업 커밋은 `bfa50bfc`입니다. 푸시하지 않았습니다.

**작업 중 찾아 고친 결함**
저장 문서를 읽을 때 정상 문서 `{"format":1}`가 손상으로 거절되고 있었습니다. JSON 숫자 1을 참/거짓 값으로도 읽는 Foundation 동작 때문이었습니다. 이제 진짜 `true`일 때만 거절하고, 그 경우를 검사에 넣었습니다.

**검증 결과**
- `bun run test:screen-control`: 136/136 통과했습니다. 새 Viewer 검사 11개가 포함됩니다.
  - 폰이 버전 4로만 연결하는지 보는 iOS 소스 검사(SR-36)와 상태 파일 검사도 통과했습니다.
  - 같은 스크립트 안의 `swift test` 13개도 실패 없이 통과했습니다.
- `swift test --package-path native/screen-control --filter 'ScreenControlCoreTests.ScreenControlCoreTests'`: XCTest 2개(136개 검사 전체 포함)가 실패 없이 통과했습니다.
- `swift build --package-path native/screen-control --build-tests`와 `swift build --product AgentsToZViewer`: 둘 다 빌드됐고 경고는 없었습니다.
- 검사가 실제로 잡는지 복사본에 일부러 결함을 넣어 확인했습니다.
  - 앱 소스 규칙: 15개 중 15개를 잡았습니다. 실행 인자 읽기, 외부 열기 진입점, ScreenHost 가져오기, 확인 없이 B에 보내기, 붙여넣기 읽기, 화면 공유 차단 해제 등입니다.
  - 핵심 로직: 7개 중 7개를 잡았습니다. 인증 바이트 뒤 다른 경로 시도, 승인 전 연결, 저장 주소 없이 인터넷 경로, 읽기 실패를 빈 목록으로 처리, 조작 잠금 무시 등입니다.
- TypeScript와 Rust는 바꾸지 않아 `bun run typecheck`와 `cargo test`는 돌리지 않았습니다.
- 실제 화면, 실제 입력, TCC, 키체인, 포트 52741·3001에는 닿지 않았습니다. 가짜 객체, 메모리 경로, 빈 포트의 loopback만 썼습니다.

**새로 만든 파일**
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-15/native/screen-control/Sources/ScreenControlCore/ScreenTargetRoute.swift`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-15/native/screen-control/Sources/ScreenControlCore/ViewerTargets.swift`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-15/native/screen-control/Sources/AgentsToZViewer/` 폴더 안 10개: HumanAction, InputForwarder, SecureEntryView, SessionWindow, TargetList, ViewerApp, ViewerConnection, ViewerSession, ViewerStore, main
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-15/native/screen-control/Tests/ScreenControlCoreTests/ViewerRouteChecks.swift`

**공유 파일 수정** (이 패키지를 등록하려면 피할 수 없었습니다)
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-15/native/screen-control/Package.swift`: Viewer 제품과 타깃을 추가했습니다.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-15/native/screen-control/Tests/ScreenControlCoreTests/ScreenControlChecks.swift`: `all` 목록에 `+ viewerRouteChecks` 한 줄을 더했습니다.

폰 프로토콜, 기존 골든 벡터, 핸드셰이크 코드는 건드리지 않았습니다.

**남은 일**
- **B 쪽 실제 연결은 다른 패키지 몫입니다.** 끝단 검사는 B의 실제 앱 코드(ScreenService)가 아니라 코어 조각으로 B를 흉내 냈습니다. 진짜 listener, 가짜 인코더, 미리 넣은 등록을 썼습니다. 컨트롤러 중재, 폰이 오면 넘겨주기, 권한 적용을 실제로 엮는 일은 wp-screen-host와 wp-integration에 남아 있습니다.
- **Mac 추가(등록) 화면은 wp-pairing이 붙일 자리만 있습니다** (`TargetListController.presentPairing`). 지금은 「이 빌드에는 Mac 추가 화면이 아직 없습니다」라고만 나옵니다.
- **서명, entitlements, Info.plist, 앱 번들은 wp-viewer-build에서 합니다.** 그 전에 앱을 실행하면 키체인을 읽지 못해 「저장된 Mac 목록을 읽지 못했습니다」가 뜨고 목록에는 아무것도 쓰지 않습니다.
- **실기 스파이크가 남았습니다.**
  - S-M2: 그 전까지는 「이 Mac의 다른 화면 기록 앱에 B 화면이 보일 수 있습니다」 경고가 세션 창에 고정됩니다.
  - S-M3: 그 전까지 조작은 꺼진 채 보기만 됩니다.
  - S-K1, S-K2.
- **실제로 확인하지 못한 부분**
  - Viewer 앱 화면(AppKit)은 규칙상 실행하지 않았습니다. 빌드와 소스 규칙 검사로만 확인했습니다.
  - 응답이 없을 때 B가 옛 버전인지 안내하려고 근거리 광고를 조회하는 코드는 실제 Bonjour로 시험하지 않았습니다. 이 조회는 안내 문구에만 쓰이고 연결 결정에는 쓰이지 않습니다.
