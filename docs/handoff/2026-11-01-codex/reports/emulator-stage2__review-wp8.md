# emulator-stage2 · review:wp8

(agent final report, verbatim)

1. **Medium-high: the `--no-screen-viewer` fallback cannot compile**
   - Where: `mobile/ios/scripts/check-ui.py:224-228` and `mobile/ios/UITests/Fixtures/ScreenGestureProbeApp.swift:328-329`.
   - Why: check-ui.py always copies the probe file in as `AgentsToZMobileApp.swift`, and it now refers to `LoopbackFrameTransport` (`let transport: LoopbackFrameTransport` / `LoopbackFrameTransport.open(...)`) with no `#if`. But `LoopbackFrameTransport.swift` is copied and added to the project only `if SCREEN_VIEWER:`.
   - Result: `check-ui.py --screen-gestures --no-screen-viewer` fails at xcodebuild with "cannot find 'LoopbackFrameTransport' in scope". This is the fallback design §7 requires when ios-ui goes over 1500 s.
   - The builder's "7/0 with --no-screen-viewer" was checked only through `--plan`. `planProblems` and the unit tests never build that mode.
   - Fix: for every `--screen-gestures` run, copy and add `LoopbackFrameTransport.swift`. It is simulator-only and does nothing without `--screen-viewer`. Keep only `ScreenViewerUITests.swift` conditional. Alternatively, wrap the viewer mode in a compilation condition that check-ui.py sets. Then add a test that the gesture-only copy includes every type the probe refers to, or run one real gesture-only build.

2. **Medium: the two ends are compared by event kind only, never by position**
   - Where: `scripts/emulator-e2e/screenViewerJudge.ts:76` (`case 'pointerMove': return 'M'`) and `ScreenGestureProbeApp.swift:416`.
   - Why: the codec and the host's input records carry exact x/y values, but the judge only compares tokens like "M L+ L-". The existing gesture tests also don't check position in touch mode.
   - Result: a broken SurfaceView touch-to-Mac mapping, or a codec that swaps or zeroes x/y, still passes.
   - Fix: record `M(x,y)` in the probe's sent list and require the host's x/y to match exactly. Also add a rough check: the tap lands near (0.5, 0.5), and the drag's x rises from about 0.3 to about 0.7 inside the 16:9 band.

3. **Medium-low: "frames ≥30" counts pictures received, not pictures shown**
   - Where: `ScreenGestureProbeApp.swift:362-370`.
   - Why: when the display layer's renderer fails, the probe quietly flushes and calls `requestKeyframe()`, and nothing records it.
   - Result: a broken H.264 stream or bad sample buffers from ScreenControlCore would still show a high frame count and pass.
   - Fix: count renderer failures and keyframe requests in a label (for example `render=failures=0`), assert 0 in the UI test and the judge, and optionally cross-check the host's keyframe-request count.

4. **Low: the test step limit was raised against the design**
   - Where: `check-ui.py:466` (`timeout=900`), with the matching comment at `screenViewerLane.ts:36`.
   - Why: design §7 says the step limits stay at build 600, boot 480, test 600. The measured test step was 80.8 s, so WP8 doesn't need the raise. WP4 makes the same change.
   - Fix: either keep 600 here, or change §7 in one place and let WP4 own the raise.

5. **Low: the 1500 s budget claim measures only half of ios-ui**
   - Why: "well inside the 1500 s budget" is based on the gesture run alone (144 s). The manifest's ios-ui runs `check-ui-suite.py`, which does a normal build and boot plus a gesture build and boot under one 1800 s limit. §7's fallback rule is about the measured ios-ui total.
   - Fix: record one full `check-ui-suite.py` run (or `agentstoz-maintainer.py run --profile native`, ios-ui) before treating the viewer as on by default.

**Safety rules:** no violations found.
- The j2 lane is reached only through the harness, whose preflight checks the copy is outside the registered root.
- It takes the simulator boot lock and waits for other simulator checks to finish.
- The simulator is owned and headless. Its id is recorded as soon as it is created, and the lane deletes it if it is still there afterwards.
- The probe connects only to 127.0.0.1, checks the path really is loopback, and refuses 3001, 52741 and 4723.
- The fixture host is sandboxed, with an environment built from empty, and passes the nm gate.
- Only the pins file's path goes into the xctestrun. The pins file is owner-only and deleted at the end.
- None of the forbidden tools are used, and nothing touches Supabase, sudo, the keychain or TCC.
- Skipping the session-bar part is acceptable: `feat/screen-session-bar` exists but is not merged into `emu/integration`.

**Checks I ran:** in a temporary worktree at 044735fc, with a real `bun install`:
- `bun test` on `tests/emulator-screen-viewer-lane.test.ts`, `tests/emulator-e2e-guards.test.ts` and `tests/emulator-screen-fixture-host.test.ts`: 97 pass, 0 fail.
- `bun run typecheck`: exit 0.
- The worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/rv-wp8` has been removed.
- No simulator was booted.
