# feature2-viewer · build:ui

(agent final report, verbatim)

English translation: "Once it's connected, the idea is that you can just keep using it comfortably, right?"

모델·에포트: 저는 Claude Code 하위 에이전트(Opus 5.5)라 여기서 에포트를 바꿀 수 없습니다. 남은 일은 사람이 하는 실기 확인이라 따로 권할 설정은 없습니다.

## 결과: wp-screen-ui 구현 완료, 커밋 1개

Screen 메뉴와 상태 창에 「다른 Mac에서 이 Mac 보기」 절을 넣었고, 이 패키지의 시험은 모두 통과했습니다. 다만 앱을 실제로 띄워 화면을 보지는 않았습니다(아래 「남은 것」). 푸시하지 않았고 main도 건드리지 않았습니다.

- **브랜치:** `feat/viewer-screen-ui` (worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-22`, main `aee852d0`에서 시작)
- **의존 브랜치 병합:** screen-host는 fast-forward로 들어왔습니다. input-origin(`b99c07c0`)과 pairing(`4e29097b`)은 `ScreenControlChecks.swift`의 `all` 한 줄에서 충돌했고, 세 묶음의 검사를 모두 남기는 쪽으로 풀었습니다.
- **커밋:** `78d8adef` feat(screen): 「다른 Mac에서 이 Mac 보기」 in Screen's menu and status window (wp-screen-ui). 지정된 trailer 두 줄을 붙였습니다.

## 화면에 들어간 것
- **「다른 Mac 연결 허용」 스위치:** 켜기는 하드웨어 클릭 다음에 Touch ID나 Watch를 받고, 끄기는 바로 됩니다.
- **「다른 Mac 추가…」:** wp-pairing의 등록 창을 엽니다. 폰이든 Mac이든 화면 연결이 있는 동안에는 비활성입니다.
- **추가한 Mac 목록:** 별칭과 등록 이름, 모델, 「키 지문 abcd」, 정품 Viewer 확인 여부, 권한, 등록일·마지막 연결·만료를 보입니다. 지금 연결할 수 없으면 이유도 보입니다(예: 「알림 연결 확인 전이라 받지 않음」). 조작 허용(올리기), 보기로 낮추기, 삭제, 이름 변경이 있습니다.
- **지금 보는 Mac:** 「지금 보는 Mac: ‘이름’ · 조작 가능/보기만」, 보기만인 이유, 「끊기」.
- **알림 상태 한 줄:** 「알림·원격 차단: 연결됨/확인 전」.
- **(D-2) 켜 두기:** 빌드와 알림 관문이 허락할 때만 보입니다. 다른 네트워크에서는 「이 네트워크도 켜 두기」가 나옵니다.
- **최근 기록 64건:** 최신순이고 정해진 문구만 씁니다.
- **끝내기 메뉴:** 켜 두기 중이면 「끄고 끝내기」가 기본이고, 「켜 둔 채 끝내기 · 다음 로그인 때 이 네트워크에서 다시 켜집니다.」가 따로 있습니다.
- **SR-29:** 권한을 올리는 버튼은 상태 창에만 있고, 모두 `ControllerSectionGate`(humanClick)를 통과한 뒤에야 인증을 요청합니다. 메뉴 막대 항목은 클릭이 어디서 왔는지 판정할 수 없어서, 올리는 항목은 상태 창을 여는 일만 합니다.

## 파일 (패키지 목록 밖의 파일 3개는 피할 수 없어서 고쳤습니다)
- `native/screen-control/Sources/AgentsToZScreen/ScreenApp.swift`: 수정. 폰 세션 표시는 폰일 때만 보이게 했습니다.
- `native/screen-control/Sources/AgentsToZScreen/ControllerSection.swift`: 새 파일. 메뉴와 상태 창의 화면, 그리고 모든 동작이 지나는 `ControllerSectionActions.run`(관문이 먼저)이 들어 있습니다.
- `native/screen-control/Sources/ScreenHost/ControllerSectionModel.swift`: 새 파일(목록 밖). 순수 UI 모델입니다. ScreenHostTests는 실행 타깃을 import할 수 없어서 ScreenHost에 둬야 했습니다.
- `native/screen-control/Sources/ScreenHost/ScreenService.swift`: 목록 밖. `public func controllerPairingEnded(_:)`를 더했습니다.
  - 이유: 등록 창은 키체인에 직접 저장하는데 그 사실을 서비스에 알리는 연결이 없었습니다. 그래서 새로 등록한 Mac은 Screen을 다시 열 때까지 연결할 수 없었고, 「기존 항목 바꾸기」로 밀려난 키는 메모리에 남아 계속 연결될 수 있었습니다.
  - 이제 앱이 `onEvent`를 이 함수로 보냅니다. 함수는 목록을 다시 읽고, 기록을 남기고, 종류 4 알림을 보냅니다. 다시 읽기에 실패하면 메모리에서 허용을 꺼서 막힌 쪽으로 둡니다.
  - 앱은 `closeControllerPairing`도 설정해서, 세션이 시작되면 등록 창이 닫힙니다(SR-37).
- `native/screen-control/Tests/ScreenHostTests/ControllerSectionTests.swift`: 새 파일, 19개.
- `scripts/check-screen-control.ts`: 목록 밖. XCTest 필터에 `|ControllerSectionTests`를 더했습니다.

## 실행한 명령과 결과
- `swift build --package-path native/screen-control` (AgentsToZScreen 포함), `--build-tests`, `--product AgentsToZScreen -c release`: 모두 완료. 제가 만든 파일에서 경고는 없었습니다.
- `swift test --package-path native/screen-control --filter ControllerSectionTests`: 19개 실행, 실패 0.
- `bun run test:screen-control` (커밋 뒤 다시 실행): EXIT 0.
  - 코어 검사 145/145 통과, SR-36 소스 검사와 상태 파일 계약 통과.
  - XCTest 필터 105개, 실패 0: ControllerSection 19, ControllerSession 24, PairingHost 14, ScreenPower 13, ControllerStore 12, ControllerLog 10, ScreenController 7, LocalInputMonitor 3, WeeklyUsageOutbox 3.
- 일부러 고장 낸 시험: 목록 다시 읽기를 없애고 `.unchecked`도 권한을 올릴 수 있게 바꿨더니 ControllerSectionTests에서 9건이 실패했습니다. 확인 뒤 원래대로 되돌렸습니다.
- `tsc --noEmit -p tsconfig.json`: EXIT 0. 이 worktree에는 node_modules가 없어 상위 폴더인 main의 node_modules를 읽기로만 썼습니다. tsconfig가 `scripts/`를 포함하지 않으므로, 스크립트 변경은 위의 실제 실행으로 확인한 것입니다.
- Rust는 바꾸지 않아 `cargo test`는 돌리지 않았습니다. 폰 프로토콜과 골든 벡터는 손대지 않았습니다.

## 남은 것과 알릴 것
- **실기(사람):** 스크립트나 Jump로 누른 권한 올리기가 실제로 거절되는지는 확인하지 않았습니다. 가짜 이벤트로 판정 표만 시험했습니다.
- **화면 확인 못 함:** Screen 앱을 띄우면 키체인과 TCC에 닿으므로 띄우지 않았습니다. 화면은 빌드와 소스 계약 시험으로만 확인했습니다.
- **키보드로 누르기:** 권한을 올리는 버튼은 클릭만 받습니다(pairing의 `HardwareButton`). Space나 Return으로 누르면 거절됩니다. 설계보다 엄격한 쪽입니다.
- **등록 거절은 기록에 남지 않습니다:** 거절 이벤트에는 컨트롤러 ID가 없어서 기록할 수 없습니다.
- **「조작」 판정이 두 곳에 있습니다(통합 때 하나로 모아야 함):** 서비스의 `controlChoiceOffered`는 Info.plist 빌드 플래그 `flags.macControl`을, 등록 창은 `ScreenInputCalibration.current.allowsControl`을 봅니다. 지금은 둘 다 꺼져 있습니다.
- **돌리지 않은 시험:** 필터 밖의 ScreenHostTests(ScreenPolishTests, DeviceRenameTests, TextAndReturnTests)는 키체인에 닿지 않는지 확인하지 않아 실행하지 않았습니다. 컴파일은 됩니다.
