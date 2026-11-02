# emulator-stage2 · build:wp8

(agent final report, verbatim)

WP8 J2-SCREEN-SIM is built and its lane passed on the first real run from an outside copy: 9 of 9 UI tests passed and both ends agree. The optional session-bar exposure was not done because `feat/screen-session-bar` is not merged into `emu/integration`.

**Branch:** `emu/wp8`, cut from `emu/integration` at 3c06fc81 (no dependency branches). Nothing was pushed and main was not touched.

**Commits** (both end with the required Co-Authored-By and Claude-Session lines):
- 3b282eb5 feat(emulator-e2e): J2-SCREEN-SIM lane — gesture probe viewer mode against the fixture Screen host (WP8)
- 044735fc fix(emulator-e2e): widen J2 expected count types for typecheck (WP8)

**Files:**
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-3/mobile/ios/UITests/Fixtures/ScreenGestureProbeApp.swift` (edited): new `--screen-viewer` mode. It calls the public `ScreenViewer.connect(over:mac:signer:)` with an in-memory P-256 signer and shows pictures in the production `ScreenSurface.SurfaceView` and `ScreenComposeTextField`.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-3/mobile/ios/UITests/Fixtures/LoopbackFrameTransport.swift` (new): the in-probe loopback transport. It is wrapped in `#if targetEnvironment(simulator)` with `#error` otherwise, connects only to 127.0.0.1, and refuses ports 3001, 52741 and 4723. It exists because `ScreenClient` requires Wi-Fi on iOS.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-3/mobile/ios/UITests/ScreenViewerUITests.swift` (new): two tests, `testViewerStreamsFixtureMacAndSendsGestures` and `testImpostorKeyIsRefusedByTheMac`. Each body is inside `#if targetEnvironment(simulator)` and throws `XCTSkip` otherwise.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-3/mobile/ios/scripts/check-ui.py` (edited):
  - New flags: `--evidence-root` (same wording as WP4), `--no-screen-viewer`, `--screen-host-sandbox-base`, `--screen-host-state-parent`.
  - `--screen-gestures` now adds the two Swift files to the copied project, starts `screenFixtureHost.ts serve --mode viewer` alongside the build, and puts only the pins file path into the xctestrun.
  - It ends the session from the Mac once the host has recorded "hello", stops the host, deletes its scratch, and runs the judge.
  - It records `simulatorUdid` early (WP4's lines) and per-phase timings.
  - Expected counts: `GESTURE_LANE_PASSES = 7` plus `SCREEN_VIEWER_PASSES = 2`, so 9 passed / 0 skipped; 7/0 with `--no-screen-viewer`.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-3/scripts/emulator-e2e/screenViewerJudge.ts` (new): the shared judge that compares both ends. It also has a CLI: `judge --run-dir`.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-3/scripts/emulator-e2e/screenViewerLane.ts` (new): lane `j2`. It also checks that every listener is on 127.0.0.1 only, that production sources are unchanged, and that the owned simulator is gone. Evidence is labelled Core+표면만.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-3/scripts/emulator-e2e/screenFixtureHost.ts` (edited): `serve` gains `--sandbox-base FILE`.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-3/scripts/emulator-e2e.ts` (edited): one registration line, `'j2': () => import('./emulator-e2e/screenViewerLane'),`.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-3/tests/emulator-e2e-guards.test.ts` (edited): the same line-308 change as WP4. It is needed because later tests register a fake `j2`.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-3/tests/emulator-screen-viewer-lane.test.ts` (new): 22 tests. They cover the judge, check-ui plans and counts against the Swift test functions, simulator-only and loopback-only checks on the Swift, the forbidden-tool scan, and lane registration.

**Commands and results:**
- `bun test tests/emulator-screen-viewer-lane.test.ts`: 22 pass, 0 fail.
- `bun test tests/emulator-e2e-guards.test.ts tests/emulator-screen-fixture-host.test.ts`: 75 pass, 0 fail.
- In the outside copy, `bun test` on those three files plus `tests/ios-device-readiness.test.ts`: 105 pass, 0 fail.
- Outside copy: `git archive` of HEAD 044735fc into `/Users/cs-work/agentstoz-emulator/wp8-j2-1/wt`, then a real `bun install`.
- `bun run typecheck`: exit 0.
- `bun scripts/emulator-e2e.ts preflight`: pass, exit 0.
- `bun scripts/emulator-e2e.ts j2`: exit 0.
- The copy was deleted afterwards, and the owned simulator 34B6D184 no longer exists.

**index.json summary** (run 20261101-072328-5e0734):
`{"total":2,"pass":2,"fail":0,"blocked":0,"skipped":0,"overall":"pass","exitCode":0,"passed":true}`

Lane j2 (pass, no reason):
- **Timings:** portal build 12.5 s, build 24.2 s, simulator boot 26.4 s, host-ready wait 0 s, tests 80.8 s, total 144.1 s. That is well inside the 1500 s ios-ui budget, so the `--no-screen-viewer` fallback is not needed.
- **Tests:** summary 9 passed / 0 skipped / 0 failed; every one of the 7 gesture tests and 2 viewer tests passed.
- **Phone:** 201 frames, state `ended=endedAtMac`, impostor `impostor=refused`.
  - Sent: `M L+ L- M R+ R- M L+ M×21 L- T:hello`. That is the tap, the two-finger tap, the press-and-drag, then the text with Return.
- **Host:**
  - Input: recorded exactly the same token string (31 events, none released by the host).
  - Handshakes: 1 accepted, 1 refused as unknownDevice.
  - Session: 1 scripted end, session ended endedAtMac.
  - Frames and gate: frames.json sent 201, nm gate passed.
  - Exit: protocol 4, exit 0, scratch removed.
- **Listeners:** only 127.0.0.1:58878 was seen, across 148 samples.
- **Plans:** viewer 9/0, gesture-only 7/0, the device plan never starts the viewer.
- **Production sources:** digest identical before and after (53 files).
- **Evidence:** no key material.

**Merge notes:**
- `check-ui.py` will conflict with WP4. The `--evidence-root`, `simulatorUdid`/`write_report` and `timeout=900` lines are word-for-word the same as WP4's.
- On merge, WP4's `expected_outcomes(...)` gesture branch must become `GESTURE_LANE_PASSES + SCREEN_VIEWER_PASSES` when the viewer tests run.
- The `scripts/emulator-e2e.ts` registration line and the guards-test line will conflict too.
