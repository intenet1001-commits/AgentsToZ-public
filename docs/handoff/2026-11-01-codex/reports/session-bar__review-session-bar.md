# session-bar · review:session-bar

(agent final report, verbatim)

English translation: The Mac control feature needs a floating bar like computer use has, both for Mac-to-Mac control and for controlling a Mac from a phone.

I found five defects, ranked below. The two most important are ways input can come back without a person clicking at the Mac.

**1. (high) The other side can undo 「직접 하기」 by reconnecting, with no click at this Mac.**
- Where: `native/screen-control/Sources/ScreenHost/ScreenService.swift:497` and `:503`. The bar's promise is at `native/screen-control/Sources/ScreenHost/ScreenSessionBarModel.swift:141`.
- Why: the hold lives only as long as one session. `accept()` lets the same registered device in again with no approval at the Mac, ends the old session as `.replaced`, and gives the new session a fresh `ScreenSessionInputHold()` that starts in `.remote`.
- What happens: the person presses 「직접 하기」. The phone sees `.localActivity` and says "잠시 뒤 조작이 다시 가능합니다". The phone user reconnects with Face ID, and remote input flows again.
- Effect: the bar's line 「다시 넘기기는 이 Mac에서만」 is false, and Appendix A's rule (giving input back takes a hardware click only, SR-29) is bypassed. 「보기만」 is undone the same way, and the phone text for it ("…다시 연결하세요") tells the user to do exactly that.
- Fix:
  - Keep the hold per device ID in `ScreenService`, and carry `.paused` into the new hold in `accept()` when the same device comes back. Clear it only through a hardware 「다시 넘기기」, 끄기, or app restart. Another option is to refuse that device's reconnect while it is held.
  - Ask the person whether 「보기만」 should also carry over.
  - Add a test that pauses, accepts the same device again, and expects the mode to still be `.paused`. Add a source check for the carry-over.
  - At the very least, correct the bar's wording.

**2. (medium, plausible) 「다시 넘기기」 accepts an accessibility press within 1 second of a real click anywhere on the bar.**
- Where: `native/screen-control/Sources/AgentsToZScreen/ScreenSessionBar.swift:158` and `native/screen-control/Sources/ScreenHost/ScreenSessionBarModel.swift:249`.
- Why: SR-29 requires the hardware mouse-up to be inside the control, and says an accessibility action without its own event is refused. The branch only checks `event.window === bar`. 「다시 넘기기」 takes the same spot 「직접 하기」 just had.
- What happens: the person clicks 「직접 하기」 with the real mouse. Within 1 second, a script or AI with accessibility access runs `osascript … click button "다시 넘기기"`. `NSApp.currentEvent` is still the person's fresh pid-0 mouse-up in the bar, so the hand-back is accepted.
- A related problem: an accidental double-click on 「직접 하기」 gives input straight back.
- Fix:
  - Have `PillButton` override `mouseDown` to set a flag, call `super`, then clear the flag. 「다시 넘기기」 should require that flag, `event.clickCount == 1`, and the click location inside the pill's bounds.
  - Refuse `accessibilityPerformPress` for 「다시 넘기기」.
  - Add an `inControl` input to `ScreenSessionBarClick` with tests, and extend the source check.
  - The Control bar has the same gap.

**3. (low) Mac-to-Mac ("맥끼리") cannot show the bar yet.**
- Why: no Mac controller session reaches `ScreenService.accept`. `ScreenHost/ScreenControllers.swift` only stores controllers, so the bar never appears for a Mac viewer today. The builder's statement "Mac controller sessions show as a Mac" only becomes true once that path exists.
- Also: when it is connected, 「보기만」 and `canControl` must agree with `RegisteredController.grant`.
- Fix: state the gap in the report and docs, and make passing `deviceModel` and using the same hold a requirement of the Mac viewer work package.

**4. (low) The click rule is a second copy instead of the planned shared one.**
- Why: the design names `ScreenInputOrigin.humanClick` (wp-input-origin, with golden vectors and a TypeScript sync check). The branch adds its own `ScreenSessionBarClick`, so two hardware-click rules can drift apart.
- Fix: mark it for replacement when `ScreenInputOrigin` lands, or put it where that package will take it over.

**5. (low) One test in Appendix A is not delivered, and the report doesn't say so.**
- Why: Appendix A asks for session-state assertions in the emulator harness J2 lane. That harness does not exist in the repo.
- Fix: list it as an open item.

**What I confirmed works:**
- **Reductions always work:** 끊기, 보기만 and 직접 하기 accept any click. The next remote event is refused before anything is injected, including text-and-return and keyboard/Spaces actions, and held keys and buttons are let go.
- **No capture exclusion:** there is no `sharingType` change, and capture leaves out only the viewer app.
- **Panel matches the Control bar:** the status-bar level is set after `isFloatingPanel` and again every tick, it is brought to the front, it joins every Space, and it can be dragged and remembers its spot (only while that spot is fully on a screen).
- **Locks:** the bar's hold and the input receiver are always locked in the same order, so they cannot deadlock.
- **Tests:** they open no window and touch no permissions, capture or real input, and they test the real `InputReceiver`.
- **App hook:** the change to `ScreenApp.swift` is one line.

**My test run** (temporary worktree at `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/rv-session-bar`, now removed): `bun scripts/check-screen-control.ts` exited 0. 102 core checks passed, 23 XCTests ran with 0 failures, 12 states rendered offscreen, and the panel source checks held. The rendered images are in `/private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/sbar/` (`all.png` shows every state).
