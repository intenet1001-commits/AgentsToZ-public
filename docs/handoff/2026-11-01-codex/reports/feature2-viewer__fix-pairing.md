# feature2-viewer · fix:pairing

(agent final report, verbatim)

English translation: "Once it's connected, I can just keep using it comfortably, right?"

**wp-pairing 리뷰 수정 결과: 지적 7건을 모두 고쳤고, 거절한 항목은 없습니다**

- 브랜치: `feat/viewer-pairing`
- 커밋: `f2556eb5`, 부모는 `c15de055`. 푸시하지 않았습니다.
- 이 브랜치는 빌더 워크트리 `wf_5de5c4d1-61e-13`에도 체크아웃돼 있어서 `--ignore-other-worktrees`로 체크아웃했습니다. 그 결과 그 워크트리의 HEAD는 새 커밋을 가리키는데 디스크 파일은 예전 그대로라, 그쪽에서는 변경이 있는 것처럼 보입니다.

**지적별 수정**
1. **(중간) 승인 뒤 창이 닫혀도 저장되던 문제**
   - `PendingControllerPairing.complete`: P6를 확인한 뒤 잠금 안에서 `.approved → .storing`로 넘어가고, 그보다 먼저 거절이 왔으면 `.refused`를 던집니다. 저장하는 도중에 거절이 오면 P7을 보내지 않습니다.
   - 서비스의 저장 클로저: 창 세대(`generation`)가 바뀌었으면 던집니다.
   - 저장이 끝난 뒤 창이 닫히면 「추가했습니다」로 끝나고, 거절 이벤트는 남기지 않으며 P7은 A에게 그대로 갑니다.
   - 새 테스트 두 개는 수정 전 코드에서 리뷰어 재현과 같은 결과로 실패하는 것을 먼저 확인했습니다(`saves=1`, 이벤트 `[.refused, .enrolled]`).
2. **「승인」 두 번 누름**: `approvalInProgress` 플래그로 두 번째 누름은 무시하고, 그동안 버튼과 선택 컨트롤을 비활성화합니다.
3. **창 상태가 다음 등록으로 넘어가던 문제**
   - 권한과 「기존 항목 바꾸기」 상태를 새 `ControllerApprovalForm` 뷰로 옮겼습니다. 이 뷰는 승인 화면이 보일 때만 있으므로 등록마다 「보기」, 끔으로 다시 시작합니다.
   - 목록에 없는 바꿀 항목을 고르면 안내(`replacementNotice`)를 띄웁니다.
4. **Viewer 「그만두기」**
   - 취소된 등록은 이제 `.cancelled`(「등록을 그만두었습니다」)로 표시됩니다(`ControllerPairingError.afterGivingUp`, 연결을 여는 단계 포함). 다른 프로그램이 B의 창을 먼저 잡은 경우의 빨간 경고는 그대로 둡니다.
   - `gaveUp` 플래그로, 아직 뜨지 않은 코드 ② 입력 요청은 바로 nil로 끝납니다. 그래서 취소 뒤에 입력칸이 뜨거나 작업이 멈춰 남지 않습니다.
5. **코드 입력에 하드웨어 판정 강제**
   - `ControllerPairingCodeEntry.Submission`을 추가했고, init은 모듈 내부 전용입니다.
   - 이 타입만 받도록 바꾼 곳: `ScreenControllerPairing.enterCode`, `PendingControllerPairing.enterControllerCode`(public), Viewer의 코드 ② 입력 요청.
   - 다른 모듈에서 이 타입을 직접 만들면 컴파일 오류가 나는 것을 확인했습니다.
6. **테스트 공백**: 잘못된 주석을 고치고 다음 경우를 추가했습니다.
   - Touch ID가 떠 있는 동안 세션 시작
   - 코드 ②가 보이는 동안 세션 시작
   - 「승인」 두 번 누름
   - P6 도착 뒤 창 닫기 또는 세션 시작
   - 저장 뒤 세션 시작
   - 코어 쪽: P6 도착 뒤 거절, 저장 중 거절, A에서 그만두기
7. **DESIGN.md**: 7.1의 App Attest clientDataHash 식을 길이 접두(`LP[...]`)로 고쳤습니다. 이 패키지 밖 파일이지만 지적 사항이라 고칠 수밖에 없었습니다.

**변경 파일** (모두 `native/screen-control/` 아래, 마지막 하나만 예외)
- `Sources/ScreenControlCore/ControllerPairing.swift`
- `Sources/ScreenControlCore/ControllerPairingTransport.swift`
- `Sources/ScreenHost/ScreenService+Pairing.swift`
- `Sources/AgentsToZScreen/ControllerPairingWindow.swift`
- `Sources/AgentsToZViewer/PairingSheet.swift`
- `Tests/ScreenControlCoreTests/ControllerPairingChecks.swift`
- `Tests/ScreenHostTests/PairingHostTests.swift`
- `docs/design/mac-to-mac-2026-11-01/DESIGN.md`

**검증** (마지막 수정 뒤, 커밋 전에 실행)
- `bun run test:screen-control`: exit 0.
  - 코어 145/145(그중 등록 20개)
  - XCTest 39개 실행, 실패 0(PairingHostTests 14/14)
  - SR-36과 상태 파일 검사 통과
- 코어 검사 바이너리를 따로 컴파일해 8번 반복: 매번 145/145.
- `swift test --filter PairingHostTests` 6번 반복: 매번 14개 실행, 실패 0.
- `swift build --product AgentsToZScreen` 성공.
- `PairingSheet.swift`는 아직 빌드 타깃이 없어 `swiftc -typecheck -swift-version 6`로 빌드된 코어 모듈에 대고 검사했습니다: exit 0.
- `python3 -I reference/controller-pairing.py --check Tests/ControllerPairingContract/vectors.json`: 2개 케이스 모두 일치.
- 폰 프로토콜과 기존 골든 벡터는 바뀌지 않았습니다. TS와 Rust는 건드리지 않아 typecheck와 cargo는 돌리지 않았습니다.
- 테스트는 소프트웨어 키, 메모리, 루프백만 씁니다. 키체인, 실제 화면과 입력, TCC, 52741/3001은 쓰지 않았습니다.

**남은 것**
- 코어의 `.approved → .storing` 잠금 확인은 코어 테스트만으로는 결정적으로 재현할 수 없습니다. 비는 구간이 실행 스케줄링 사이라서입니다. 이 경로는 호스트 테스트(메인 액터를 잡아 둔 상태)에서 서비스의 세대 확인이 막는 것으로 검증했습니다.
- 3번의 SwiftUI 상태 초기화와 버튼 비활성화는 자동 UI 테스트가 없습니다. 뷰 구조로 보장하는 방식입니다.
- `PairingSheet`의 실제 타깃 연결은 wp-viewer-app 몫입니다.
