# session-bar · build:session-bar

(agent final report, verbatim)

English translation: The Mac control feature needs a floating bar like computer use has, both for Mac-to-Mac control and for controlling a Mac from a phone.

The floating session bar for AgentsToZ Screen is built and committed on `feat/screen-session-bar`. `bun run test:screen-control` and `swift build` both pass. Nothing was pushed and `main` was not touched. I have not shown the real panel on screen, so its level, staying in front and dragging still need a check on a real Mac.

**Branch:** `feat/screen-session-bar`, made from `main` at `aee852d0`, in worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_c3da94a8-bf5-1`.

**Commits:**
- `f2f9c828` feat(screen): floating session bar on the watched Mac for phone and Mac sessions
- `ad00fed5` docs(screen): note the session bar's hold, hand-back rule and checks

Both end with the requested Co-Authored-By and Claude-Session lines.

**How it behaves:**
- **When it shows:** for any active session, and it hides when the session ends. The device kind (iPhone, iPad or Mac) comes from the model the device registered with, so Mac controller sessions show as a Mac without changing the bar.
- **What it says:** device kind and name, 보는 중 or 조작 중, elapsed time and the next session limit, 「이 Mac에서 조작 중 — 원격 입력 멈춤」 when the Mac's own input pauses remote input, and ⌃⌥⌘. on the 끊기 button.
- **Window behaviour:** the same as the Control bar. It is a non-activating panel at the status-bar level, set again every second and brought to the front. It joins every Space and full screen, can be dragged, and remembers where it was left. It is not removed from the stream, so the remote person sees it too.
- **Placement:** by default it sits one bar-height above where the Control bar opens, so both can show at once.
- **Buttons:** 끊기, 보기만 and 직접 하기 accept any click. 다시 넘기기 accepts only a fresh hardware click on the bar (pid 0, not marked as Screen-injected). Clicks from Screen's injected remote input, other programs, AI tools, scripts and remote desktops are refused, and the bar explains why. Unlike the Control bar, remote desktop is refused here, as the design requires (SR-29).
- **No protocol change:** the phone learns about 직접 하기 and 보기만 through messages it already understands.

**One limitation:** after 보기만, the phone shows its existing text "Mac 입력 우선 보호가 중단되어 화면만 보여줍니다… 다시 연결하세요". The cause it names is wrong, though the effect is right. A dedicated phone message needs a new protocol value, so I left it out.

**Files:**
- New:
  - `native/screen-control/Sources/AgentsToZScreen/ScreenSessionBar.swift` (the panel)
  - `native/screen-control/Sources/AgentsToZScreen/ScreenSessionBarView.swift` (its look)
  - `native/screen-control/Sources/ScreenHost/ScreenSessionBarModel.swift` (Foundation-only: words, buttons, click rule, placement)
  - `native/screen-control/Sources/ScreenHost/ScreenSessionInputHold.swift` (connects the bar's buttons to the session's input)
  - `native/screen-control/Tests/ScreenHostTests/ScreenSessionBarTests.swift`
  - `native/screen-control/Tests/SessionBarRender/main.swift` (offscreen render)
- Changed:
  - `native/screen-control/Sources/AgentsToZScreen/ScreenApp.swift`: one line, `ScreenSessionBar.shared.start()`.
  - `native/screen-control/Sources/ScreenHost/ScreenService.swift`: new methods `pauseRemoteInput`, `resumeRemoteInput(refusal:)`, `lowerSessionToView`, plus `sessionInput`, `sessionDeadline` and `Session.deviceModel`.
  - `native/screen-control/Sources/ScreenHost/HostStreamer.swift` and `native/screen-control/Sources/ScreenControlCore/VideoPump.swift`: a read-only session deadline.
  - `native/screen-control/Tests/ScreenControlCoreTests/SessionChecks.swift`: two checks on that deadline.
  - `scripts/check-screen-control.ts`: runs the new tests, the render and the panel source checks.
  - `docs/claude/remote-control.md`: a note on the bar.

**Commands run:**

| Command | Result |
|---|---|
| `bun run test:screen-control` | exit 0. 102/102 core checks; 23 XCTests, 0 failures (13 existing + 10 new in `ScreenSessionBarTests`); 12 states rendered offscreen with no cut-off text and no window opened; panel source checks pass |
| `swift build --package-path native/screen-control` | all targets recompiled, "Build complete!", 0 warnings |
| `bun test` on the 6 TS files that read these sources | 93 pass, 0 fail |
| deliberately broken copies | allowing remote desktop for 다시 넘기기 failed 2 tests; skipping the click check in the bar failed the source check; both files restored |

Before these changes the same test run gave 102/102 and 13 XCTests.

**Evidence:** PNGs of every state are in `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_c3da94a8-bf5-1/tests/results/screen-session-bar/`, which is gitignored. Open `all.png` to see them all on one sheet.

No test opens a real window, touches permissions, the keychain, real capture or real input, or connects to port 52741.
