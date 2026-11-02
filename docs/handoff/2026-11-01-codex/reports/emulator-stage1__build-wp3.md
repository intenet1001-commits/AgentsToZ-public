# emulator-stage1 · build:wp3

(agent final report, verbatim)

**WP3 is done on branch `emu/wp3`. The simulator mode now passes end to end and the device-path compile passes.** The probe needed one fix outside my file list (below). Nothing was pushed or merged.

**Commits** (base d093fa88)
- `e5bd8b7b`: `mobile/ios/scripts/check-workroom.ts`
- `df5605d0`: `mobile/ios/scripts/fixtures/WorkroomProbe.swift` (not on my owned list, but no other package owns it)
- `efa39457`: `mobile/ios/scripts/prepare-workroom-persona-device.ts`, `mobile/ios/scripts/check-common-memory-device.ts`

**Failure reproduced on d093fa88** (HEAD script, environment built from empty, failed before any simulator was created):
```
LANWorkroomView.swift:7:8: error: no such module 'ScreenControlCore'
```

**What changed**
- **Compile fix:** ScreenControlCore is now built as a static module, the same way as AgentsToZCore. The Screen views that `LANWorkroomView` reaches are added to the list: ScreenMacsSection, ScreenMacStore, ScreenRegistrationSheet, ScreenRemoteStopMenu, ScreenPushRegistration, ScreenViewerView and QRScannerSheet. Everything compiles with `-swift-version 6`, matching the app target and both packages. The two device scripts got the same list.
- **Clean environment:** `check-workroom.ts` runs itself again with an environment built from empty. HOME, TMPDIR and app data are scratch paths outside the real home. Only that child process imports host code, and it refuses any other environment.
- **Real home:** Bun's `os.homedir()` and `os.userInfo().homedir` both follow `$HOME` (I measured this), so the script reads the real home from `/usr/bin/id -P`. WP0's checks should not use `userInfo()` either.
- **Portal variable:** the simulator run now ignores an inherited `AGENTSTOZ_IOS_PORTAL_URL`; you opt in with `--portal-url`. The device run still reads the variable.
- **Simulator:** it is created in its own device set inside the scratch folder. Simulator.app (already running as pid 606) never shows it, and the shared simulator list is only read. Compile and boot happen before any network listener opens. Deletion is checked after cleanup. A SIGTERM test confirmed the simulator is still deleted when the run is interrupted.
- **`run-status.json`:**
  - States are passed, failed or blocked; exit codes are 0, 1 and 78.
  - Always false: `realAI`, `productionData`, `actualIPhone`.
  - Also recorded: `gitHead`, environment key names, whether the owned simulator was created and deleted, whether earlier simulators are unchanged, Simulator.app pids, and hashes of the 49 compiled sources.
  - Old evidence is cleared at the start of each run.
- **`--compile-only simulator|device`** runs only the compile step. The device path needs no template, device or signing identity. The two device scripts got the same `--compile-only` flag.
- **Probe fix:** once it compiled, the first simulator run timed out at `terminal-input-output`. Commit ddbc3b4d added a confirmation before closing a session, and the probe never answered it. The probe now answers that confirmation in the app and checks that the second tap doesn't ask again.

**Verification run**

| Command | Result |
|---|---|
| `bun mobile/ios/scripts/check-workroom.ts` (on committed `efa39457`) | exit 0. `run-status.json`: state passed, stage complete. Owned simulator created and deleted; 16 earlier simulators unchanged; Simulator.app pids [606] before and after. 38 probe checks; foreignRequests 0, projectMutationAttempts 0. Compile 14.4 s, boot 37.3 s, journey 30.2 s, total 100.6 s. |
| After that run | Scratch folder removed, no `launchd_sim` left, no `#pair=` in the evidence JSON or log |
| Interrupted run (SIGTERM during boot) | failed as expected; owned simulator deleted (checked) |
| `check-workroom.ts --compile-only device` | `{"compiled":true,"target":"device","swiftVersion":6,"seconds":17,"swiftSources":49}` |
| `check-workroom.ts --compile-only simulator` | compiled, 14 s |
| `prepare-workroom-persona-device.ts --compile-only` and `check-common-memory-device.ts --compile-only` (empty environment) | both exit 0 |
| Negative checks | fake isolation marker → refused; `--device` with a missing template → refused; unknown flag → usage error |
| `bun test ./mobile/ios/scripts/tests/share-extension.test.ts tests/ios-shell-contract.test.ts` | 29 pass, 0 fail |
| `bun run typecheck` | exit 0 |
| `tsc --noEmit -p mobile/ios/tsconfig.json` | exit 0 |

**Command for the orchestrator (j1-pty)**
- Run `bun mobile/ios/scripts/check-workroom.ts` from the worktree root. The environment you pass is replaced by the script's own, but TMPDIR must resolve outside `/Users/cs-work` or the script refuses to start.
- Exit codes: 0 passed, 1 failed, 78 blocked. Evidence is in `<wt>/mobile/ios/build/workroom-evidence/`: `run-status.json`, `result.json`, `workroom.png`, `resumed.png`, plus `failure.png` on failure.
- The script does not take `/Users/cs-work/agentstoz-emulator/sim.lock`, so the orchestrator must hold that lock around this call.
- For the device compile check, use `--compile-only device`.

**Not done**
- **Device run:** only the compile step is verified; installing on a real iPhone needs a person. The `iphone-workroom` manifest entry has no `notApplicableExitCode: 78`, so a blocked run there counts as failed. That is for WP13 to add.
- **Sandbox:** I did not run the script under `sandbox-exec`, because WP1's profile wasn't available to me.
- **Tester runs:** project tester setup was skipped because it calls 127.0.0.1:3001, which the safety rules forbid. I did not run the maintainer quick/persona profiles or `bun run verify`.
- **Docs:** `mobile/ios/README.md` and `docs/plans/mobile-workspace-2026-09-11/NATIVE-EXECUTION.md` still say the environment variable enables the portal smoke for the simulator run. They need to say `--portal-url` now; I left them because they are outside my files.
