# feature2-viewer · integrate:viewer

(agent final report, verbatim)

English translation: "Once it's connected, I can just keep using it comfortably, right?"

모델·에포트: Claude Code 하위 에이전트(Opus 5.5)라 여기서는 에포트를 바꿀 수 없습니다. 통합 작업은 지금 설정으로 충분했습니다.

## 결과: 8개 묶음을 모두 합쳤고, 합친 뒤 깨진 곳 2개를 커밋 2개로 고쳤습니다. 검사는 환경 탓 실패 1건을 빼고 모두 통과했습니다.

- **브랜치:** `feat/viewer-integration` (main `aee852d0` 기준), worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-25`. push하지 않았고 main도 건드리지 않았습니다.
- **빠진 브랜치:** 없습니다. 리뷰 수정이 `-fix` 브랜치에 있는 core-v5, controller-store, main-app은 `-fix` 쪽을 합쳤습니다. `-fix`는 원래 브랜치에서 fast-forward한 것이라 원래 브랜치도 함께 들어왔습니다.

**합친 순서 (`--no-edit`)**
1. `01df976f` core-v5-fix
2. `3eb93db9` input-origin
3. `0cdd81b8` controller-store-fix
4. `3a628b77` main-app-fix
5. `3a787825` pairing
6. `130968a8` screen-host
7. `a870b982` viewer-app
8. `be1d1283` screen-ui

충돌은 `ScreenControlChecks.swift`의 `all` 검사 목록 한 곳에서만 3번 났습니다. 세 번 모두 양쪽 검사를 다 남겼습니다(pairing 브랜치가 고른 방식과 같습니다).

## 합친 뒤 깨진 것과 고친 커밋

**1. `74aba961` fix(viewer): show B's two new view-only reasons in the Viewer's band**
- screen-host가 `ScreenInputAvailability`에 `.notificationsUnconfirmed`와 `.controlNotInThisBuild`를 더했습니다. viewer-app의 `ScreenTargetRoute.swift`는 옛 목록을 기준으로 만들어져 switch 2곳이 빠짐없이 처리하지 못했고, swift build가 실패했습니다.
- 띠 문구를 더했습니다. 첫째는 설계 9절 문구 그대로 「B의 알림·원격 차단 연결 확인 전이라 보기만 됩니다」, 둘째는 B 메뉴 문구에 맞춘 「B의 AgentsToZ Screen이 아직 다른 Mac에 조작을 열지 않아 보기만 됩니다」입니다.
- 두 이유 모두 잠긴 B 입력칸을 닫습니다. `ViewerRouteChecks`의 "every reason" 목록과 잠금 목록에 두 경우를 더했습니다.

**2. `737980e9` fix(viewer): bring the 「Mac 추가」 sheet under the Viewer's source contract and wire it in**
- **문제:** wp-pairing이 만든 `PairingSheet.swift`는 Viewer 타깃이 생기기 전에 SwiftUI로 쓰였습니다. 합치자 Viewer 빌드에 들어가면서 viewer-app의 소스 계약 검사에 걸렸습니다(첫 실패: `PairingSheet.swift imports CryptoKit`, 158개 중 157개 통과). SwiftUI, Observation, SystemConfiguration import와 자체 `NSButton`·`@objc`·`#selector`도 계약 위반이었습니다. 「Mac 추가…」는 여전히 「이 빌드에는 Mac 추가 화면이 아직 없습니다」만 띄웠습니다.
- **검사를 약하게 하지 않았습니다.** 대신 시트를 계약에 맞췄습니다.
  - 시트를 AppKit으로 다시 썼습니다. 등록 흐름은 wp-pairing 것 그대로입니다.
  - 버튼은 모두 `HumanButton`이라 `HumanActions`가 매 클릭을 판정합니다.
  - 코드 ② 입력칸은 `ViewerEvent.read`로 이벤트를 읽어 `ControllerPairingCodeEntry`에 넘기고, 접근성 값을 설정할 수 없습니다.
  - Bonjour 목록이 바뀌어도 진행 중인 등록 화면을 다시 그리지 않습니다. 다시 그리면 입력하던 코드가 지워지는 문제가 있었습니다.
- **K_A 생성은 코어로 옮겼습니다:** 새 파일 `native/screen-control/Sources/ScreenControlCore/ControllerKey.swift`(macOS 전용). Viewer는 계속 ScreenControlCore만 링크합니다(SR-32). 컴퓨터 이름은 SystemConfiguration 대신 `Host`에서 읽습니다.
- **`TargetList.swift`**:
  - 연결 중이거나 세션 중이 아닐 때만 시트를 엽니다.
  - 등록이 성공하면 B의 창을 고른 클릭의 증거와 함께 행을 저장합니다. 같은 B가 이미 있으면 키만 바꾸고 저장 주소와 경로는 그대로 둡니다.
  - 저장에 실패하면 B에는 이미 등록됐다는 안내를 시트에 띄웁니다.
  - 이 Mac이 잠기거나 잠들면 시트를 닫습니다. 하드웨어가 아닌 클릭은 시트에 안내합니다.
- **`ViewerApp.swift`**: 거절 안내를 시트로 보냅니다.
- 쓰지 않게 된 `pairingUnavailable` 문구를 지웠습니다.
- **계약 검사 보강:** `PairingSheet.swift`를 예상 소스에 넣었고, 코드 ② 입력칸, 행 저장 경로, 시트의 경비를 검사합니다. 입력칸에 `setAccessibilityValue`를 넣은 변형 사본으로 돌려 실패하는 것을 확인했습니다.

## 검사 (모두 이 브랜치에서 실제로 돌린 결과)

| 명령 | 결과 |
|---|---|
| `swift build --package-path native/screen-control` (AgentsToZViewer, AgentsToZScreen product 각각 포함) | 성공 |
| `bun run test:screen-control` | 158/158 통과, SR-36 통과, status file 일치, ScreenHost 필터 XCTest 108개 0 실패 |
| `swift test --package-path native/screen-control` (전체) | 121개 0 실패, 모든 suite 통과 |
| `bun run typecheck` | 종료 코드 0 (모든 병합 뒤 실행, 이후 TS 변경 없음) |
| `PATH="/usr/bin:$PATH" bun run test` | 9814 pass, 12 skip, **1 fail**, 9827개, 1109 파일 |
| `cd src-tauri && cargo test` | lib 165 통과, 1 ignored, 0 실패. 새 Viewer 설치 시험 2개 포함 |
| `bun run test:ios` | 종료 코드 0. 네이티브 21그룹, 제스처 15, 생명주기 21, screen-control 158/158, 네이티브↔Bun 페어링·재개·리다이렉트·취소 통과 |

**bun test 실패 1건은 환경 탓입니다.**
- 실패한 시험은 `computer-use-main-link.test.ts`의 "real inherited socket is close-on-exec"입니다. 오류는 `'node_api.h' file not found`입니다.
- 이 worktree에 `node_modules`가 없어서, 시험이 `<root>/node_modules/node-api-headers`를 찾지 못했습니다. 통합 변경은 이 영역을 건드리지 않았습니다.
- 확인 방법: main 체크아웃의 `node_modules`를 잠시 링크하고 그 파일만 다시 돌렸더니 10 pass, 0 fail이었습니다. 링크는 바로 지웠습니다.

**그 밖에**
- cargo test용 빈 자리표시자(gitignored `src-tauri/resources/*`, `templates/`)는 커밋하지 않았고, 끝난 뒤 지웠습니다.
- 폰 프로토콜과 기존 골든 벡터는 이 통합에서 손대지 않았습니다. 묶음들이 바꾼 부분은 v4/v5 벡터를 더한 것과 iOS switch 두 곳이고, 폰에 보이는 동작은 그대로입니다.

## 남은 것
- 테스터 quick 프로필, personas run, `/api/project-tester/ensure`는 돌리지 않았습니다. 3001 연결이 금지라서입니다.
- S-M3 보정, 서명·공증 릴리스, 실기 점검표는 사람 단계라 하지 않았습니다. 조작은 S-M3 플래그 뒤에서 기본 꺼짐 그대로입니다.
- 새 AppKit 등록 시트는 컴파일과 소스 계약으로만 확인했습니다. 실제 두 Mac에서 등록하는 실기 확인은 아직 하지 않았습니다.
- `docs/claude`와 테스터 매니페스트는 수정하지 않았습니다.
