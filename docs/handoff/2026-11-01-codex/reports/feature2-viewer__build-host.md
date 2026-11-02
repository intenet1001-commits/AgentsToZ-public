# feature2-viewer · build:host

(agent final report, verbatim)

The wp-screen-host package is done and committed on `feat/viewer-screen-host` (not pushed). All its tests pass, and the phone protocol, the v1-v4 golden vectors and the status file contract are unchanged.

**Branch and commits** (worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14`)
- Dependency merges already on the branch: `edf23a49` (merges `feat/viewer-core-v5-fix`) and `5a821b36` (merges `feat/viewer-controller-store-fix`). I used these two fix branches as supersets of the named dependency branches.
- `23f59f7c` feat(screen): host side of Mac controllers — arbitration, release gate, keep-on, controller log. It ends with the required Co-Authored-By and Claude-Session lines.

**Files**
- Modified:
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Sources/ScreenHost/ScreenService.swift`
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Sources/ScreenHost/ScreenPush.swift`
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Sources/ScreenHost/HostStreamer.swift`
- New:
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Sources/ScreenHost/ControllerLog.swift`
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Sources/ScreenHost/RemoteInputMarker.swift`
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Sources/ScreenHost/ScreenPower.swift`
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Tests/ScreenHostTests/ControllerSessionTests.swift`
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Tests/ScreenHostTests/ScreenPowerTests.swift`
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Tests/ScreenHostTests/ControllerLogTests.swift`
- New files outside the package's file list:
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Sources/ScreenHost/ScreenSessionRules.swift` holds the arbitration, release gate, listener classes, session plan, address hints and authentication rules.
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Sources/ScreenHost/ScreenServiceEnvironment.swift` lets tests swap in fakes for the keychain store, authentication, listeners, sessions, clock and file paths.
- Edits I had to make in files owned by other packages:
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Sources/ScreenControlCore/Transport.swift` (core): an optional `nearbyTXT` parameter. Its default is empty, so the nearby advertisement stays as it was unless the host passes `pv`.
  - `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-14/native/screen-control/Sources/AgentsToZScreen/ScreenApp.swift` (wp-screen-ui's file): one `NetworkText` case for the new `Waiting.notKept`. Without it the app target does not compile.

**Verification on the committed tree**
- `swift build --package-path native/screen-control --build-tests`: build complete, no errors, and no warnings in the rebuilt changed files.
- `swift test --package-path native/screen-control --filter 'ControllerSessionTests|ScreenPowerTests|ControllerLogTests'`: 32 tests, 0 failures (12 + 13 + 7). I ran this before a final one-line fix to a deprecated call; the two runs below came after it.
- `swift test --package-path native/screen-control --filter 'ScreenHostTests'`: 64 tests, 0 failures.
- `bun run test:screen-control`: exit 0.
  - 119/119 screen-control checks passed.
  - SR-36 passed: phones still offer version 4.
  - The status file still matches `Tests/StatusContract/status.json`.
  - The script's filtered native run (including ControllerStoreTests, LocalInputMonitorTests, ScreenControllerTests and WeeklyUsageOutboxTests) had 57 tests, 0 failures.
- No TypeScript or Rust changed, so I did not run typecheck or `cargo test`.
- Nothing here ran `--selftest`/`--identity`, ScreenControlFixture or PhysicalScreenControls. No test touched the keychain, TCC, real capture or input, or ports 52741 and 3001. Nothing was signed or pushed.

**Not done or open**
- **Build flags:** the build scripts do not write the three new Info.plist flags yet (`AgentsToZScreenMacControl`, `AgentsToZScreenKeepOn`, `AgentsToZScreenLockedInput`). All three default to off, so control (D-10, the S-M3 flag) and keep-on stay off until a build sets them.
- **View-only reason:** a session the release gate lowered to view and one with no input monitor both tell the Viewer `viewOnly`, so the Viewer cannot tell which reason applies.
- **Gate closing mid-session:** if the release gate closes during a session (the remote-stop poll goes stale), the session is not ended. The gate is only checked when a session starts.
- **Hand-offs to other packages:**
  - **wp-screen-ui:** the UI for controllers, keep-on and the controller log.
  - **wp-screen-pairing:** must set `closeControllerPairing` and call `enrollController(_:replacing:)`.
  - **wp-computer-use-exclusion:** must read the `remote-input.json` format: `{format:1, lastInputAt (ms), session:"phone"|"controller"}`.
- **Push identity:** `enrollController` loads the push identity even while Screen is off, so push kind 4 can go out. Check that this is wanted.
