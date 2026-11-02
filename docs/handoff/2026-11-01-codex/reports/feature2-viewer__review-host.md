# feature2-viewer · review:host

(agent final report, verbatim)

English translation: "So the idea is that once it's connected, you can just keep using it comfortably?"

The branch has 6 defects, ranked below; none blocks the package outright. All tests pass when re-run, the phone protocol is still pinned at 4, and no test touches the real screen, TCC, the keychain or port 52741.

**Re-run in a temporary worktree** (`.claude/worktrees/rv-viewer-host`, removed afterwards; main tree clean):
- `swift build --build-tests` completed.
- `swift test --filter ScreenHostTests`: 64 tests, 0 failures.
- `bun scripts/check-screen-control.ts`: 119/119 checks. SR-36 passes byte for byte, the status file matches the contract, and the filtered native run is 57 tests, 0 failures.
- The v1–v4 golden values and `status.json` are unchanged.
- No test uses `ScreenService()`, `.system()`, `ScreenStore()`, `RemoteInputMarker.url` or `PowerHold.url`. The `NWListener` in the TXT test is never started.

**Checked against the design and correct:** the arbitration table, relay serving phones only (SR-33), no `turnOff` for controllers, `unenrollSelf`, the SR-37 hook before capture, narrowing ending the session, raising needing Touch ID or Watch only, every keep-on release path, a quit from outside keeping keep-on, the hold file, a view grant injecting nothing, and the phone path behaving as on main.

**Ranked defects**

1. **Medium-high: the push gate opens when no phone is in use.**
   - Where: `native/screen-control/Sources/ScreenHost/ScreenPush.swift:75-80, 98, 175`
   - Why: `deviceIDs()` can be empty, and both `PushWire.ids` (`PushCommands.swift:57`) and the relay's `ids()` (`supabase/functions/screen-push/protocol.ts:117`) accept an empty list. The fetch then succeeds, `roundSucceeded()` runs and `pushLive` becomes true.
   - Result: on a B with no unexpired phone, unbound controllers are admitted, control opens (where the build allows it) and keep-on is offered. Yet `controllerEvent` returns nil (no recipients), so kinds 3 and 4 reach nobody, and no phone exists to send a remote stop. This defeats the stated purpose of 9절 and F2. The design's literal wording ("폴링 성공") is met, but the gate gives no protection on a B used only Mac-to-Mac.
   - Fix: count a round as live only when `ids` is non-empty, or require at least one in-use phone wherever `pushLive` is read. Add a test.

2. **Medium: D-3 and the push additions are not tested.**
   - Where: `ScreenSessionRules.swift:196-220` (`ControllerLockedInput`) and `ScreenServiceEnvironment.swift:37, 44` (the guards in the live closure).
   - Why: the test rig replaces the `.live` streamer entirely. No test calls `ControllerLockedInput.admits`, checks `HostSessionPlan.lockedInputOpen`, or runs the live guard, so an inverted guard would still pass all 64 tests. SR-28 requires unit tests.
   - Also untested:
     - `ScreenPush.remoteStopState` with controller rows (a phone's 해지 reaching `removeController`)
     - `controllerEvent` kinds 3 and 4
     - `PushLiveness` closing after 30 minutes or when the clock moves backwards
     - `enrollController`: switch on, refusing a key a phone holds (SR-22), kind 4
   - `testEveryTurnOffLetsGo` only covers the menu and `disableKeepOn`. It does not cover a phone's 끄기, a remote turnOff or a stop after a failed save.
   - Fix: pure tests for all of these, and rename or extend that test.

3. **Low: one session can delete the next session's remote-input file.**
   - Where: `RemoteInputMarker.swift:49, 72-76`
   - Why: each marker has its own serial queue. On `.replace` or `.takeOver`, the old marker's queued write and remove can run after the new session's first write and delete it. The new marker then waits 2 seconds before writing again, so the sidecar sees no file while the remote person is typing (a gap in SR-34).
   - Fix: one shared static queue, or remove only a record this marker wrote.

4. **Low: the Viewer cannot tell why a session is view-only.**
   - Where: `ScreenSessionRules.swift:188`
   - Why: grant `.control` plus `viewOnly` is sent for all three causes: the push gate is closed, the input monitor is missing, or the build has not passed S-M3. 6.5 and 12절 require the Viewer to show the push-gate reason specifically. `limitedByGate` is also true when only the S-M3 build flag is off, so B's own UI would give the push reason wrongly.
   - Fix: carry a reason in v5 now, before it ships (a separate availability value or a reason byte; this is a wp-core-v5 change), and split `limitedByGate` into gate and build.

5. **Low: a failed log read wipes the stored history.**
   - Where: `ControllerLog.swift:141`
   - Why: `ControllerLogBook` ignores `unreadable` and starts empty, so after a transient keychain read failure the next `record()` overwrites the saved 64 entries.
   - Fix: while the log is unreadable, keep entries in memory only, or read again before the first save.

6. **Low: `enrollController` checks phones against a possibly empty in-memory list.**
   - Where: `ScreenService.swift:1075-1076`
   - Why: the SR-22 check uses `devices` from memory. If the phone list failed to load at init, `devices` is empty and a key a phone holds can be stored as a controller. Both keys then stop working (it fails closed), so the damage is a broken store and lost access, not a security hole. `approvePending` re-reads the store instead.
   - Also: the method is `public` and does no authentication itself; it relies on the pairing flow to do Touch ID first.
   - Fix: pass `phones: try store.devices()`, and make the method `internal`, since `ScreenService+Pairing.swift` lives in ScreenHost (15절).

**Open items from the builder's report**
- **Gate closing mid-session:** the design checks the gate when a session starts ("보기로 낮춰 시작"), so this is not a defect. Ending or lowering the session when it closes would be an optional extra.
- **Push identity loaded while Screen is off:** this matches 7.6 (kind 4 on enrollment) and is fine.
- **Three Info.plist flags not written by the build scripts:** they default to off, which is the safe side. This is a hand-off to the build or integration package.
