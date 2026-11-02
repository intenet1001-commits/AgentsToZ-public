# feature2-viewer · review:ui

(agent final report, verbatim)

English translation: "Once it's connected, the idea is that you can just keep using it comfortably, right?"

모델·에포트: 저는 하위 에이전트라 에포트를 바꿀 수 없습니다. 이 검토에 따로 권할 설정은 없습니다.

## 결론: 결함 5건 (중간 1, 낮음 3, 사소 1)

**1. [중간] 「이 네트워크도 켜 두기」 버튼이 실제로는 한 번도 나오지 않습니다**
- 위치: `ControllerSectionModel.swift:411`(`network: listeningNetwork?.identity`), `:321`(`?? true`)
- 원인: `listeningNetwork`는 `binding`에서 나옵니다. 그런데 `turnOn`과 `resumeKeptOn`이 쓰는 `startListening`은 `binding`을 설정하지 않습니다. 화면 제어가 켜져 있으면 `reevaluate`도 바로 돌아갑니다(`ScreenService.swift:643`). 그래서 켜진 동안 `listeningNetwork`는 늘 nil이고, 모델은 nil을 「이미 저장된 네트워크」로 읽어 버튼을 숨깁니다.
- 실측: 임시 worktree에서 rig로 확인했습니다.
  - 네트워크 1에서 켜고 켜 두기를 켠 뒤, 네트워크를 2로 옮겼습니다.
  - `listeningNetwork=nil`, `state.network=nil`, `addNetwork=nil`이었습니다.
  - 그 상태에서 `enableKeepOn()`을 부르면 저장 네트워크가 2곳이 됩니다. 기능은 되는데 버튼만 막혀 있습니다.
- 빌더 보고의 「다른 네트워크에서는 ‘이 네트워크도 켜 두기’가 나옵니다」는 실제 연결 상태에서는 사실이 아닙니다. 모델 시험(`ControllerSectionTests.swift:245-260`)이 `network`를 손으로 넣어서 이 문제를 잡지 못했습니다.
- 고칠 것:
  - 서비스가 지금 네트워크를 관찰 가능한 값으로 갖게 합니다. `turnOn`, `enableKeepOn`, `followKeptOnNetworkNow`, 메뉴 열기 때 `environment.currentNetwork()`를 읽어 갱신하고, 그 값을 `listeningNetwork` 대신 넘깁니다.
  - 네트워크를 모를 때를 「저장됨」으로 치지 않습니다.
  - 서비스 수준 시험을 더합니다(rig에서 `net` 1→2 이동 뒤 `addNetwork`가 보이는지).

**2. [낮음] 목록 다시 읽기가 실패했을 때 막아 둔 것이 기억에만 있고, 다른 동작 하나로 다시 열립니다**
- 위치: `ScreenService.swift:1100-1111`
- 원인:
  - 실패하면 기억 속 `allowMacControllers`만 false가 됩니다. 저장소에는 등록 창이 저장한 true와 새 행이 그대로 있습니다.
  - 그 뒤에 `removeController`, `renameController`, 보기로 낮추기 중 어느 것이든 `mutateControllers`가 저장소를 다시 읽습니다. 그러면 Touch ID 없이 허용이 켜짐으로 돌아가고 새 Mac이 연결할 수 있게 됩니다. 재실행해도 같습니다.
  - 그래서 문서 주석과 안내 문구(「다시 켜 주세요」)가 말하는 「다시 켤 때까지 닫힘」이 지켜지지 않습니다. 화면에는 이미 바뀐 옛 행이 남고 새 행은 보이지 않습니다.
- 다만 다시 열리는 상태는 사람이 등록 때 Touch ID로 승인한 상태이므로, 승인 범위를 넘는 권한 상승은 아닙니다.
- 고칠 것:
  - 실패 경로에서 `mutateControllers { $0.allowMacControllers = false }`로 꺼짐을 저장합니다. 그것도 실패하면 다른 실패 경로처럼 `failClosed`로 화면 제어를 끕니다.
  - 또는 `setAllowMacControllers(true)` 전까지 `mutateControllers`가 지키는 「닫힘 유지」 플래그를 둡니다.
  - 「실패 뒤 다른 행을 삭제해도 허용이 켜지지 않는다」는 시험을 더합니다.

**3. [낮음] SR-30: 등록 거절이 기록에 남지 않습니다**
- 위치: `ScreenService.swift:1101`
- 증명 실패(정품이 아닌 Viewer의 등록 시도)처럼 보안상 의미 있는 거절도 버려집니다. 빌더가 이미 알렸습니다.
- 고칠 것: `ScreenControllerPairingEvent.refused`에 대기 중 상대의 지문을 싣고, 정해진 문구의 `.refused` 기록을 남깁니다.

**4. [낮음, 통합 때 처리] 조작(S-M3) 판정이 두 곳에 있습니다**
- 위치: 이 절의 「조작 허용」은 `flags.macControl`(`ScreenService.swift:125`), 등록 창은 `ScreenInputCalibration.current.allowsControl`(`ScreenService+Pairing.swift:87`)을 봅니다.
- 둘이 갈리면 B의 목록이 보정되지 않은 빌드에서 조작으로 올리기를 내놓습니다. 지금은 둘 다 꺼져 있습니다. 이 묶음 이전부터 있던 문제이고 빌더가 알렸습니다.
- 고칠 것: 판정 출처를 하나로 모읍니다.

**5. [사소, 시험] 소스 계약 시험이 세 파일만 봅니다**
- 위치: `ControllerSectionTests.swift:479-498`
- `ControllerSection`, `ScreenApp`, `ControllerPairingWindow`만 검사합니다. `main.swift`나 새로 생기는 파일에서 권한을 올리는 호출을 하면 잡지 못합니다.
- 고칠 것: `Sources/AgentsToZScreen/*.swift`를 모두 훑게 합니다.

## 확인해서 문제없던 것
- **병합 충돌:** `all` 줄에 세 묶음의 검사가 모두 남았습니다.
- **SR-29 관문:**
  - 판정이 실행보다 앞에 있습니다.
  - 권한을 올리는 버튼은 모두 `HardwareButton`입니다. 이 버튼은 `screenPid=ownPid`로 판정하므로, Screen이 대신 넣은 폰·컨트롤러의 클릭은 거절됩니다.
  - 메뉴의 올리기 항목은 상태 창을 여는 일만 합니다.
  - 「다른 Mac 추가…」는 창을 보이기만 하고, 120초 리스너는 창 안의 하드웨어 클릭으로 엽니다.
- **SR-37:** 세션을 받을 때 영상을 보내기 전에 `closeControllerPairing`이 불립니다.
- **알림 관문:** 목록의 판정이 서비스와 같은 `ReleaseGate.admitsController`를 씁니다.
- **켜 두기:** 「끄고 끝내기」가 기본이고 `quit(keepingOn:false)`가 켜 두기를 풉니다.
- **AI 진입점:** 새로 생긴 것이 없습니다(URL, AppleScript 없음).
- **골든 벡터와 폰 프로토콜:** 이 커밋은 Core를 건드리지 않았고, SR-36 검사를 통과합니다.
- **시험 환경:** rig는 키체인, 52741, TCC에 닿지 않습니다(메모리 저장소, `QuietSource`, 가짜 인증).

## 실행한 것
- 임시 worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/rv-viewer-ui`(78d8adef)에서 돌렸습니다.
  - `bun scripts/check-screen-control.ts`: EXIT 0. 코어 145/145, SR-36과 상태 파일 계약 통과, XCTest 105개 실패 0(ControllerSectionTests 19개 포함).
  - `swift build --product AgentsToZScreen`: 완료.
  - 위 1번을 확인하는 임시 탐침 시험 1개를 돌렸습니다.
- 끝난 뒤 탐침 파일과 worktree를 지우고 prune했습니다. main의 작업 트리는 깨끗합니다.

검토한 파일(빌더 worktree, 브랜치 `feat/viewer-screen-ui`):
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-22/native/screen-control/Sources/ScreenHost/ControllerSectionModel.swift
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-22/native/screen-control/Sources/ScreenHost/ScreenService.swift
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-22/native/screen-control/Sources/AgentsToZScreen/ControllerSection.swift
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-22/native/screen-control/Tests/ScreenHostTests/ControllerSectionTests.swift
