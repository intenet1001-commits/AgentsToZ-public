# feature2-viewer · fix:origin

(agent final report, verbatim)

English translation: "Once it's connected, the idea is that you can just keep using it comfortably, right?"

모델·에포트: Claude Code 하위 에이전트(Opus 5.5)라 여기서 에포트를 바꿀 수 없습니다. 남은 일은 정해진 리뷰 수정이라 지금 수준이면 충분합니다.

## 결과: 리뷰 4건 모두 반영, `feat/viewer-input-origin`에 커밋 `cfc10c75`

브랜치 순서는 `fa83eb8f` 다음 `cfc10c75`이고, 바탕은 main `f3e96658`입니다. 바꾼 파일은 이 패키지 파일 4개뿐입니다. 폰 프로토콜과 골든 벡터는 건드리지 않았고 Rust 변경도 없습니다.

⚠️ **다른 worktree 주의:** 이 브랜치는 이미 `.claude/worktrees/wf_5de5c4d1-61e-2`에 체크아웃돼 있었습니다. 그 worktree는 잠기지 않은 쉬는 상태여서 `git checkout --ignore-other-worktrees`로 가져왔습니다. 그래서 그쪽 작업 트리는 아직 `fa83eb8f` 내용이고, `git status`를 보면 이번 수정을 되돌리는 변경처럼 나옵니다. 그 worktree에서 커밋하기 전에 먼저 `git checkout -- .`을 해야 합니다.

## 지적별 처리

**1. pid 0 전제 (반영, 요청보다 넓힘)**
- `vectors.json`의 `"device": "virtual-hid"`를 `"premise"`로 바꿨습니다. 값은 `virtual-hid-pid-0`, `synthetic-pid-0`, `remote-desktop-pid-0` 세 가지입니다. 이 파일을 읽는 곳은 검사 두 개뿐인 것을 grep으로 확인했습니다.
- 새 벡터는 요청한 2개보다 많은 6개입니다. 기대값은 모두 accept이고 `measured:false`와 residualRisk가 붙어 있습니다.
  - forward: `synthetic-pid-0`, `remote-desktop-pid-0`
  - humanClick: `synthetic-click-pid-0`, `remote-desktop-click-pid-0`
  - humanKey: `synthetic-keystroke-pid-0`, `remote-desktop-key-pid-0`
- `fields` 설명에 sourcePid도 S-M3가 잴 대상이라고 적었습니다. S-M3를 기록할 때 각 벡터를 어떻게 고치는지도 적었습니다(가를 수 있으면 refused, 못 가르면 accepted로 두고 residualRisk 유지, pid 0으로 오지 않으면 삭제).
- Swift 검사와 TS 검사 모두 다음을 강제합니다.
  - premise 이름은 이 세 가지만 됩니다.
  - accept인 벡터의 residualRisk는 `"<premise>: "`로 시작해야 합니다.
  - premise 없이 measured나 residualRisk만 있으면 실패합니다.
  - unmeasured인 동안에는 세 판정(forward, click, key) 각각에 세 premise가 모두 있어야 합니다.
- 검사 이름은 「a remote desktop that posts with its own pid is refused and named」(`testRemoteDesktopWithItsOwnPidIsRefused`)로 좁혔습니다. 헤더 주석에도 이 전제를 적었습니다.

**2. SPIKES.md (반영)**
- 주석에 실제 위치를 적었습니다. DESIGN 13절과 wp-spikes·wp-integration이 쓸 예정인 `docs/design/mac-to-mac-2026-11-01/SPIKES.md`이고, 아직 없는 파일입니다.
- 「어긋나면 실패」는 `current`와 vectors의 `calibration` 사이에만 해당하며, SPIKES.md는 어떤 검사도 읽지 않는다고 고쳤습니다. `InputOriginChecks`의 주석도 같이 고쳤습니다.

**3. 조작 빌드 플래그 우회 (반영, 요청보다 넓힘)**
- `ScreenInputCalibration`의 `init`을 internal로 바꿨습니다.
- `uncalibrated`도 internal로 바꿨습니다. 다른 모듈이 S-M3 뒤에 출시 규칙보다 넓은 규칙을 넘기지 못하게 하려는 것입니다. 그래서 다른 모듈에서 쓸 수 있는 것은 `current`뿐입니다.
- 별도 모듈에서 `@testable` 없이 `swiftc -typecheck`로 시험했습니다.
  - init과 `uncalibrated`는 「inaccessible due to 'internal' protection level」 오류가 납니다.
  - `.current.allowsControl`은 컴파일됩니다.
- TS 검사가 이 상태를 지킵니다. 구조체에서 public static은 `current` 하나여야 하고, public init이 없어야 하며, Sources 안에 `extension ScreenInputCalibration`이 없어야 합니다.
- 위험: 동시에 만들어지는 다른 묶음이 다른 모듈에서 이 init이나 `uncalibrated`를 쓰면 합칠 때 컴파일이 깨집니다. 이 브랜치에서 grep한 결과로는 쓰는 곳이 없습니다.

**4. 사용자 질문에 대한 답 (코드 아님, 조건을 넣어 고친 답)**

대체로 맞습니다. 등록은 두 Mac 사이에 한 번 하고, B에서 「켜 두기」를 켜 두면 재시작이나 업데이트 뒤에도 저장한 네트워크에서 Screen이 다시 켜집니다. 다만 조건이 있습니다.
1. **켜 두기는 pushLive일 때만 켤 수 있습니다.**
   - 푸시 배포(H10)가 끝나야 합니다. 여기에는 Supabase 적용, APNs, TestFlight 사람 단계, 폰마다 「알림 받기」 켜기가 들어갑니다.
   - 원격 차단 폴링이 30분 안에 성공해야 합니다.
   - 빌드에 Apple 보고 발송 기록이 있어야 합니다.
   - 그 전에는 선택지가 숨겨집니다(9절, SR-27). 저장하지 않은 네트워크에서는 `waiting` 상태가 됩니다.
2. **90일 동안 쓰지 않은 등록은 만료됩니다(6.6).** 「한 번 등록」은 계속 쓰는 동안에만 해당합니다.
3. **조작은 지금 빌드에서 꺼져 있습니다.** 빌드 쪽 S-M3 보정과 실행 중 pushLive를 둘 다 통과해야 열립니다. 그 전에는 보기로 낮춰 시작하고, S-M3가 실패하면 D-10으로 사람에게 묻습니다.
4. **A가 잠기거나, 잠들거나, 사용자를 바꾸면 세션이 바로 끝납니다.** 창을 닫거나 앱을 끝내도 마찬가지이고, 자동으로 다시 연결하지 않습니다(5.1, 12절).

이 밖에도 연결할 때마다 A에서 생체 인증을 받습니다(H7). 세션 한도는 보기 60분, 조작은 입력 없이 60분이고 최대 8시간입니다. 한도가 끝나면 생체 인증으로 다시 연결합니다.

## 검증 (커밋한 내용으로 실제 실행)

| 명령 | 결과 |
|---|---|
| `bun run test:screen-control` | 종료 0, 108/108 통과(input origin 6건 포함), 호스트 XCTest 13건 0 실패 |
| `swift test --package-path native/screen-control --filter 'ScreenControlCoreTests.ScreenControlCoreTests/testSecurityRequirements'` | 1건, 0 실패 |
| `bun test tests/screen-input-origin-sync.test.ts` | 7 pass, 0 fail(expect 188개) |
| 이웃 테스트 8개 파일(screen-input-origin-sync, computer-use-control-bundle·hooks·native, screen-push-config·protocol·sql·weekly-usage) | 64 pass, 0 fail |
| `bun run typecheck` | 종료 0 |

검사가 결함을 잡는지 보려고 일부러 망가뜨려 봤고, 네 가지 모두 실패로 잡혔습니다. 끝난 뒤 git으로 원래대로 되돌렸습니다.
- Swift 검사(스크래치 복사본에서 실행):
  - forward의 `remote-desktop-pid-0`을 빼면 107/108로 FAIL입니다.
  - residualRisk 앞머리를 틀리게 쓰면 FAIL입니다.
- TS 검사(트리에서 잠시 고쳐서 실행):
  - init을 public으로 바꾸면 1 fail입니다.
  - humanKey의 `remote-desktop-key-pid-0`을 빼면 2 fail입니다.

## 하지 않은 것
- Rust를 바꾸지 않아서 `cargo test`는 돌리지 않았고, 전체 `bun run verify`도 돌리지 않았습니다.
- 푸시하지 않았습니다.
- S-M3 실측은 사람이 하는 단계라 하지 않았고, SPIKES.md도 아직 없습니다(wp-spikes 산출물).

## 바꾼 파일
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-8/native/screen-control/Sources/ScreenControlCore/ScreenInputOrigin.swift
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-8/native/screen-control/Tests/InputOriginContract/vectors.json
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-8/native/screen-control/Tests/ScreenControlCoreTests/InputOriginChecks.swift
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-8/tests/screen-input-origin-sync.test.ts
