# feature2-viewer · build:pairing

(agent final report, verbatim)

English translation: wp-pairing은 AgentsToZ_byCS 기능 2(Mac → Mac 화면 보기·조작)에서 Mac 컨트롤러를 직접 등록하는 작업입니다. 이를 feat/viewer-pairing 브랜치에 구현하고, 실제로 검증한 뒤 커밋하고 결과를 보고합니다.

wp-pairing을 구현해 feat/viewer-pairing에 c15de055로 커밋했습니다. 마지막 수정 뒤 다시 돌린 검증은 전부 통과했고, 푸시하지 않았으며 main은 건드리지 않았습니다.

**브랜치와 커밋**
- 브랜치: feat/viewer-pairing (워크트리 /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-13)
- 새 커밋: `c15de055 feat(screen): direct Mac controller pairing (protocol 7.1, wp-pairing)` — 10개 파일, +3343/−2
- 이 커밋은 브랜치에 이미 있던 의존 병합 e62f6f91, 6f726477, f6050a26 위에 올라갑니다.
- 작업 트리는 깨끗합니다.

**파일** (모두 /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-13/native/screen-control/ 아래)
- 새 파일
  - Sources/ScreenControlCore/ControllerPairing.swift
  - Sources/ScreenControlCore/ControllerPairingTransport.swift
  - Sources/ScreenHost/ScreenService+Pairing.swift
  - Sources/AgentsToZScreen/ControllerPairingWindow.swift
  - Sources/AgentsToZViewer/PairingSheet.swift
  - Tests/ScreenControlCoreTests/ControllerPairingChecks.swift
  - Tests/ScreenHostTests/PairingHostTests.swift
  - Tests/ControllerPairingContract/vectors.json
  - reference/controller-pairing.py
- 수정한 공유 파일: Tests/ScreenControlCoreTests/ScreenControlChecks.swift. 새 검사를 등록하려면 피할 수 없어서 `all`에 `controllerPairingChecks`를 더하고 주석 한 줄을 고쳤습니다(2줄).
- Package.swift는 바꾸지 않았습니다. 휴대폰 프로토콜과 기존 v1–v4 골든 벡터도 그대로입니다.

**검증** (최종 트리에서 실행)
- `bun run test:screen-control` → 종료 코드 0
  - CORE_CHECKS: 143/143 통과, 이 중 pairing 검사가 18개
  - XCTest(선택된 테스트): 34개 실행, 0 실패. PairingHostTests 9/9 포함
- `swift build --package-path native/screen-control --product AgentsToZScreen` → 성공, 종료 코드 0
- `python3 -I reference/controller-pairing.py --check Tests/ControllerPairingContract/vectors.json` → 독립 참조 구현과 벡터 2건 일치
- TS와 Rust를 바꾸지 않아 typecheck와 cargo는 돌리지 않았습니다.
- 실제 화면 캡처·입력 주입·TCC·키체인과 52741·3001 접속은 하지 않았고, 가짜 객체와 루프백만 썼습니다.

**남은 일**
- **실행 확인:** UI는 실행해 보지 않고 컴파일만 했습니다.
  - PairingSheet.swift는 Viewer 타깃이 아직 없어 기본 빌드에서 컴파일되지 않습니다. 임시 타깃을 붙여 컴파일을 확인하고 되돌렸습니다.
  - 그 확인은 마지막 두 수정 전이었습니다. 두 수정은 다른 파일(ControllerPairing.swift, ScreenService+Pairing.swift)의 내부 동작과 문구만 바꿔 PairingSheet가 쓰는 API는 그대로입니다.
- **S-K2:** 실제 App Attest 벡터가 없습니다. 그래서 `requiresAttestation`은 기본 꺼짐이고, vectors.json의 attestation 항목은 "pending S-K2"로 비어 있습니다.
- **S-M3·S-N3·S-M2:**
  - S-M3 판정 전이라 승인 권한은 "보기"로 제한됩니다.
  - S-N3(WARP)는 손대지 않았습니다.
  - `sharingType = .none`으로 화면 캡처에서 빠지는지는 확인하지 않았습니다(S-M2). 대신 세션이 시작되면 창을 닫는 규칙(SR-37)이 안전장치입니다.
- **wp-screen-host:** 세 가지를 연결해야 합니다.
  - 스트리밍 시작 전 `accept`에서 `pairing.sessionStarted()` 호출
  - `ScreenService.makeControllerPairing()` 사용
  - `onEvent`를 컨트롤러 기록(SR-30)과 푸시 kind 4에 연결
- **wp-screen-ui:** 메뉴의 「다른 Mac 추가…」가 `ControllerPairingWindow.show()`를 호출하게 해야 합니다.
- **wp-viewer-app:** 네 가지가 필요합니다.
  - Package.swift에 AgentsToZViewer 타깃 추가
  - `PairingSheet` 표시
  - `onPaired`(결과와 K_A blob) 저장
  - S-K2 뒤 App Attest `attest` 연결
- **알려진 제한:** 원격 데스크톱 클릭은 어느 프로그램이 보냈는지 가려내지 못해 "합성 입력"으로 거절됩니다. 안내 문구는 일반 합성 입력과 같습니다.
- **병합 출처:** 의존 브랜치는 원본이 아니라 -fix 브랜치를 병합했습니다.
