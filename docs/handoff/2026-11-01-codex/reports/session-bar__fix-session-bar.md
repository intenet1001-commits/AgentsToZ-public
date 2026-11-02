# session-bar · fix:session-bar

(agent final report, verbatim)

English translation: The Mac control feature needs a floating bar like computer use has, both for Mac-to-Mac control and for controlling a Mac from a phone.

**결과:** 리뷰 결함 다섯 개를 모두 반영했고, 거절한 항목은 없습니다. 다만 1번은 리뷰가 제안한 기기별이 아니라 Mac 전체 단위로 더 엄격하게 고쳤습니다(아래). 테스트 `bun run test:screen-control`과 빌드 `swift build`가 모두 통과했습니다.

**브랜치:** `feat/screen-session-bar`는 다른 worktree(`.claude/worktrees/wf_c3da94a8-bf5-1`)가 잡고 있어서 이 worktree에서 checkout할 수 없었습니다. 그래서 그 끝(`ad00fed5`)에서 `feat/screen-session-bar-fixes`를 만들어 커밋했습니다. 이 브랜치는 `feat/screen-session-bar`를 그대로 앞으로 감기(fast-forward)한 것입니다. main은 건드리지 않았고 push도 하지 않았습니다.
- `3ec7656f` fix(screen): session bar holds survive reconnects; hand-back needs the pill's own single click
- `ded55801` docs(screen): session bar review — held input, click rule, Mac viewer gap and open items

**고친 내용**
1. **(high) 다시 연결하면 「직접 하기」가 풀리던 문제**
   - `ScreenMacHold`를 새로 두었습니다. 위치는 `ScreenSessionInputHold.swift`입니다.
   - 「직접 하기」나 「보기만」을 누른 뒤에는 새 세션이 원격 입력이 멈춘 채 시작합니다. 같은 기기로 다시 연결해도, 다른 등록 기기로 연결해도 같습니다.
   - 풀리는 길은 둘뿐입니다. 하드웨어 클릭으로 받아들여진 「다시 넘기기」, 그리고 이 Mac에서 Touch ID·암호로 다시 켜기입니다. 앱을 다시 열어도 지워지지만, 앱은 꺼진 채 열려 켜기를 이 Mac에서 묻습니다.
   - **리뷰와 다르게 정한 점 셋:**
     - 기기별이 아니라 Mac 전체로 묶었습니다. 기기별이면 같은 사람의 두 번째 등록 기기로 풀 수 있기 때문입니다.
     - 지우는 시점을 「끄기」가 아니라 인증을 거친 「켜기」로 했습니다. 끄기는 폰에서도 할 수 있지만, 다시 켜려면 어차피 이 Mac에서 인증해야 하니 결과는 같습니다.
     - 「보기만」은 설계대로 그 세션만 보기로 낮추고, 다음 세션에는 일시 정지로 이어집니다.
   - `ScreenService`의 세션 홀드는 이제 `macHold.begin()`에서만 나옵니다.
2. **(medium) 「다시 넘기기」를 접근성 누르기나 더블클릭으로 통과하던 문제**
   - 각 버튼이 스스로 받은 마우스 클릭인지 기록합니다(`PillButton.tracksOwnMouseDown`).
   - 「다시 넘기기」에 대한 접근성 누르기는 동작 전에 거절하고, 막대에 이유를 보입니다.
   - 클릭 판정에 두 조건을 더했습니다. 마우스를 뗀 위치가 그 버튼 안이어야 하고, 한 번 클릭이어야 합니다. 두 번 누르면 「두 번 누름은 받지 않습니다 · 한 번만 눌러 주세요」를 보입니다.
3. **(low) 맥끼리 세션에는 막대가 아직 안 뜸**
   - 지금은 Mac 컨트롤러 세션이 `ScreenService.accept`까지 오는 길이 없습니다. 이 사실을 코드 주석, `docs/claude/remote-control.md`, DESIGN 부록 A에 적었습니다.
   - Mac 뷰어 작업 묶음(wp-screen-host·wp-viewer-app)의 요구로 남겼습니다. `deviceModel`을 넣을 것, 같은 `ScreenMacHold`를 쓸 것, `canControl`을 `RegisteredController.grant`와 맞출 것입니다.
4. **(low) 클릭 규칙이 두 번째 사본인 문제**
   - `ScreenInputOrigin.humanClick`으로 바꿀 대상이라고 주석에 표시했습니다. 그 파일은 아직 main에 없고 `feat/viewer-input-origin` 브랜치에만 있습니다.
   - `check-screen-control.ts`가 상수(pid 0, 1초, 원격 데스크톱 목록)를 Control 막대 규칙과 같게 묶습니다. `ScreenInputOrigin.swift`가 패키지에 들어오면 그것과도 묶고, 어긋나면 실패합니다.
5. **(low) J2 레인 단언 미구현:** 에뮬레이터 하네스가 저장소에 없어서 문서에 열린 항목으로 적었습니다.

**바뀐 파일**
- `native/screen-control/Sources/ScreenHost/ScreenSessionInputHold.swift`
- `native/screen-control/Sources/ScreenHost/ScreenService.swift`
- `native/screen-control/Sources/ScreenHost/ScreenSessionBarModel.swift`
- `native/screen-control/Sources/AgentsToZScreen/ScreenSessionBar.swift`
- `native/screen-control/Sources/AgentsToZScreen/ScreenSessionBarView.swift`
- `native/screen-control/Tests/ScreenHostTests/ScreenSessionBarTests.swift`
- `native/screen-control/Tests/SessionBarRender/main.swift`
- `scripts/check-screen-control.ts`
- `docs/claude/remote-control.md`
- `docs/design/mac-to-mac-2026-11-01/DESIGN.md`

`ScreenApp.swift`와 폰 프로토콜은 그대로입니다.

**실행한 명령과 결과**

| 명령 | 결과 |
|---|---|
| `swift build --package-path native/screen-control` | Build complete, 경고 없음 |
| `bun run test:screen-control` | 종료 코드 0. 코어 검사 102/102 통과, XCTest 24개 실패 0(`ScreenSessionBarTests`는 10개에서 11개로), 오프스크린 렌더 14개 상태(새로 2개), 접근성 누르기 거절 검사와 패널 소스 계약 통과 |
| `bun test tests/claude-md-size.test.ts` | 3개 통과, 실패 0 |

- 렌더 이미지는 gitignore된 `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_c3da94a8-bf5-3/tests/results/screen-session-bar/`에 있습니다(`all.png`에 모든 상태).
- 새 소스 검사가 실제로 결함을 잡는지 확인하려고 결함 11개를 일부러 넣어 봤고, 11개 모두 실패로 잡혔습니다. 스크립트는 `/private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/mutations.ts`입니다.
- `feat/viewer-input-origin`의 `ScreenInputOrigin.swift`를 함께 넣고 확인했습니다. 상수가 같으면 통과하면서 교체 알림이 나오고, 상수가 어긋나면 실패합니다. 스크립트는 `/private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/origin-sync.ts`입니다.
- 이 worktree에 `node_modules`가 없어서 `bun run verify`(typecheck와 cargo 포함)는 돌리지 않았습니다. typecheck는 `scripts/`를 포함하지 않습니다.
- 진짜 창을 띄우거나 TCC, 키체인, 실제 캡처나 입력, 52741 포트는 건드리지 않았습니다.

**남은 항목**
- **사람이 정할 것:** 「보기만」 뒤 다음 세션을 일시 정지 대신 보기 전용으로 둘지.
- Control 막대(`native/computer-use` `ControlBar`)에도 같은 클릭 틈이 있습니다. 이번 범위 밖이라 고치지 않았습니다.
- 폰 쪽 문구는 그대로입니다. 멈춘 채 시작한 세션에서 폰은 "잠시 뒤 조작이 다시 가능합니다"를 듣지만, 실제로는 이 Mac의 사람이 넘겨야 풀립니다. 전용 문구는 프로토콜 변경이 필요합니다.
- J2 레인 단언(하네스가 생긴 뒤)과 맥끼리 세션 경로(Mac 뷰어 작업 묶음).
- 실제 Mac에서 확인할 것: 실제 더블클릭, osascript 누르기, 패널 레벨과 끌기.
- 첫 커밋 `f2f9c828` 메시지의 "Mac 컨트롤러 세션은 손댈 것 없이 Mac으로 보인다"는 지금은 사실이 아닙니다. 커밋은 고치지 않았고, 문서와 주석만 바로잡았습니다.
