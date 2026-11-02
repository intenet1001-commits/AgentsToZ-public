# feature2-viewer · fix:ui

(agent final report, verbatim)

English translation: "Once it's connected, the idea is that you can just keep using it comfortably, right?"

모델·에포트: 저는 하위 에이전트라 에포트를 바꿀 수 없고, 따로 권할 설정도 없습니다.

## 결과: 검토에서 나온 5건을 모두 고쳤습니다 (거절한 것 없음)

- **브랜치:** `feat/viewer-screen-ui`
- **커밋:** `f186b389` (부모는 `78d8adef`)
- **작업 위치:** `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-24`
- 이 브랜치는 빌더 worktree `wf_5de5c4d1-61e-22`에도 체크아웃되어 있어서 `checkout --ignore-other-worktrees`로 열었습니다. 그래서 그 worktree에서는 이제 제 커밋이 거꾸로 된 변경처럼 보입니다.
- push와 main 커밋은 하지 않았습니다.

**1. [중간] 「이 네트워크도 켜 두기」 버튼이 안 나오던 문제**
- 서비스가 지금 네트워크를 `presentNetwork`로 들고 있게 했습니다. 다음 때마다 다시 읽습니다.
  - 화면 제어를 켤 때(`turnOn`), 켜 두기를 켤 때(`enableKeepOn`), 재시작 뒤 스스로 켤 때, 켜 둔 동안 네트워크를 따라갈 때
  - 메뉴나 상태 창이 열릴 때
  - 켜 둔 채 연결을 받는 동안 10초마다
- 모델은 이 값을 씁니다. 네트워크를 모를 때는 「저장됨」으로 치지 않아 버튼이 보이고, 누르면 이 네트워크를 구별할 수 없다고 안내합니다.
- 서비스 시험을 더했습니다(`testAddingThisNetworkFollowsAMoveWhileOn`). 네트워크 1에서 켜고 2로 옮기면 버튼이 나오고, 누르면 저장 네트워크가 2곳이 됩니다.

**2. [낮음] 목록 다시 읽기 실패 뒤 다른 동작으로 허용이 다시 켜지던 문제**
- 실패하면 바로 「꺼짐」을 저장합니다.
- `controllersHeldClosed` 플래그를 두어, 그 뒤 삭제·이름 변경·권한 변경이 저장할 때도 늘 꺼짐으로 저장합니다. 이 플래그는 사람이 이 Mac에서 「다른 Mac 연결 허용」을 켜거나 새 등록을 승인해야 풀립니다.
- 꺼짐을 저장하지도 못하면 다른 실패 경로처럼 `failClosed`로 화면 제어를 끄고 켜 두기도 풉니다. 이때는 폰 연결도 함께 끊깁니다.
- 시험 2개를 더했습니다. 삭제나 이름 변경 뒤에도 허용이 꺼진 채 저장되고, 재실행해도 꺼짐으로 읽히며, 다시 켜야 연결됩니다.

**3. [낮음] SR-30: 등록 거절이 기록에 남지 않던 문제**
- 거절 이벤트에 정해진 사유(`ScreenControllerPairingRefusal`, 11가지)와 상대 키 ID를 싣습니다. 정품 증명 실패처럼 키를 알기 전이면 ID는 비워 둡니다.
- 서비스가 이를 `.refused`로 기록하고, 기록 화면에는 「등록 거절 · …」을 정해진 문구로 보입니다.

**4. [낮음] 조작(S-M3) 판정이 두 곳에 있던 문제**
- 빌드 플래그 `macControl` 하나로 모았습니다. 빌드 설정이 켜도 S-M3 보정이 통과하지 않았으면 꺼진 것으로 읽습니다.
- 등록 창은 서비스와 같은 값(`controlChoiceOffered`)을 받습니다. 예전 기본값은 없앴습니다.
- 시험으로 Screen 소스에서 보정값을 직접 읽는 곳이 `ScreenSessionRules.swift` 하나뿐인지 확인합니다.

**5. [사소] 소스 계약 시험이 세 파일만 보던 문제**
- `Sources/AgentsToZScreen/*.swift`를 모두 훑습니다(`main.swift`와 앞으로 생길 파일 포함).
- 등록 창의 `open`/`approve` 호출이 그 창의 하드웨어 버튼 안에만 있는지도 확인합니다.

## 이 묶음 밖에서 고친 파일
3번과 4번을 고치려면 피할 수 없었습니다.
- `ScreenService+Pairing.swift`: 이벤트 모양, 정해진 사유, 의존성 주입
- `ScreenSessionRules.swift`: `fromBundle` 판정
- `PairingHostTests.swift`: 거절 이벤트 확인 5곳에 사유와 키 ID를 넣고, 확인 2개를 더함

Core, 폰 프로토콜, 골든 벡터는 건드리지 않았습니다.

## 실행한 것

| 명령 | 결과 |
|---|---|
| `swift build --package-path native/screen-control --build-tests` | 완료, 경고 0 |
| `swift test --package-path native/screen-control --skip-build --filter 'ControllerSectionTests\|PairingHostTests'` | 36개, 실패 0 |
| `bun run test:screen-control` | EXIT 0 (아래) |
| `swift build --package-path native/screen-control --product AgentsToZScreen` | 완료 |

- `bun run test:screen-control` 내용:
  - 코어 검사 145/145 통과
  - SR-36 통과(폰은 버전 4 유지), 상태 파일 계약 통과
  - XCTest 108개 실패 0. 이 중 ControllerSectionTests 22개, PairingHostTests 14개
- 확인용으로 고친 것을 잠깐 되돌려 봤습니다. 1번과 2번 수정을 빼면 새 시험 3개에서 9건이 실패해 원래 결함을 잡는 것을 확인했고, 그 뒤 원래대로 되돌렸습니다.
- TS와 Rust는 바꾸지 않아 typecheck와 cargo test는 돌리지 않았습니다.
- 실제 화면, 입력, 키체인, TCC, 52741, 3001에는 닿지 않았습니다.

## 남은 것
- **바로 다시 읽기에 성공하는 경로:** 목록 다시 읽기가 실패한 뒤 이어서 「꺼짐」 저장까지 성공하는 경우만 따로 시험하지 못했습니다. 시험용 메모리 저장소에 「한 번만 실패」 기능이 없고, 그 파일은 다른 묶음의 것입니다. 이 경로도 다른 시험이 거치는 같은 저장 코드를 씁니다.
- **실기 확인:** 메뉴가 열릴 때(`NSMenu.didBeginTrackingNotification`) 네트워크를 다시 읽는 것은 소스 계약으로만 확인했습니다. 실제 메뉴 막대에서는 통합 실기 때 봐야 합니다.
