# emulator-stage1 · review:wp3

(agent final report, verbatim)

1. **High: the package is incomplete, and nothing enforces the sandbox.** `mobile/ios/scripts/check-workroom.ts:43-68,210-221`
   - WP3's file list includes `scripts/emulator-e2e.ts`, but the branch never touches it. The file exists only on `emu/wp0-1`, where `j1-pty` is still "not implemented yet".
   - So the package's own check, `bun scripts/emulator-e2e.ts j1-pty`, was never run.
   - The script runs host code unsandboxed: it binds a live pairing listener plus two Bun.serve listeners on en0, and runs a PTY and python.
   - Design §2.3 requires sandbox-exec for every host process, and nothing in the script checks for it.
   - Fix: register the j1-pty lane on top of WP0-1 and run it under WP1's profile with `lanInbound`. Or make the child refuse to start without a sandbox marker that the orchestrator sets.

2. **Medium: the compile writes outside the scratch folder, so it will break under WP1's profile.** `check-workroom.ts:105,108`, `prepare-workroom-persona-device.ts:14,15`, `check-common-memory-device.ts:13,14`
   - None of the swiftc calls passes `-module-cache-path`. Swift therefore uses the shared module cache in `$(getconf DARWIN_USER_CACHE_DIR)clang/ModuleCache`, which is outside scratch. That folder was written today at 12:36–12:45.
   - The cache is shared between runs. WP1 denies writes outside scratch and evidence (`(deny file-write* (subpath "/"))`), so the j1-pty compile would fail once sandboxed.
   - Fix: pass `-module-cache-path join(temp,'ModuleCache')` to every swiftc call.

3. **Medium: the CSP self-check will be blocked under WP1's sandbox.** `check-workroom.ts:219`
   - `fetch(http://<en0 IP>:port/remote/)` is an outbound connection to a non-loopback address.
   - WP1 allows outbound only to `localhost:*`, even with `lanInbound` ("outbound는 여전히 localhost뿐"). So "LAN CSP missing" would fail every sandboxed run.
   - Fix: do the CSP/route check inside the process, through the server's handler, or have WP1 allow outbound to this run's own en0 address and port.

4. **Medium: a run refused before line 142 leaves the previous `run-status.json` in place.** `check-workroom.ts:142`
   - The old evidence is removed only at line 142. Refusals at 32/37/38 (arguments), 46 (TMPDIR), 74 (environment), 77 (app data), 136 (portal) and 139 (template) all happen earlier.
   - They exit 1 but leave the previous `run-status.json`. The main checkout holds one right now: state passed, dated 2026-09-11.
   - An orchestrator that reads the file, as the handoff suggests, can report a stale pass.
   - Fix: in the parent, before any check, remove the evidence folder or write `state:"failed"` with the reason.

5. **Medium: two of the design's pass conditions are only warnings.** `check-workroom.ts:347-357`
   - Design §2.5 judges the run on three things: earlier simulators unchanged, owned simulator deleted, and no new Simulator.app.
   - Only the deletion fails the run. A changed earlier simulator or a newly started Simulator.app still ends as passed, exit 0, with a warning.
   - The handoff tells the orchestrator to read only the exit code and state.
   - Fix: return failed (or blocked) for those two, or document that `warnings` must be treated as not passed.

6. **Medium: no regression test, and the compile list now exists in three hand-kept copies.** `check-workroom.ts:104-113`, `prepare-workroom-persona-device.ts:11-17`, `check-common-memory-device.ts:10-16`
   - This drift caused the original failure: `LANWorkroomView` gained `import ScreenControlCore` and no list followed. Nothing tests for it, which goes against the project's "reproduce, add regression, fix" rule.
   - Fix: move the module and file list into one shared module. Add a bun test that each local-package `import` in `LANWorkroomView.swift` has a matching `-l<Module>` in all three scripts.

7. **Low/medium: a run that is SIGKILLed leaves a booted simulator that nothing cleans up.** `check-workroom.ts:60-66,161,189`
   - The maintainer's `stop_group` sends SIGKILL to the whole group 2 s after SIGTERM. Cleanup needs `simctl shutdown`/`delete`, up to 30 s each.
   - If killed mid-cleanup, the simulator stays booted in `$TMPDIR/agentstoz-ios-workroom-*/sims`. The parent's safety net never runs, and the default `simctl list` never shows it (before this change it was at least visible there).
   - Fix: record the device-set path and UDID somewhere the orchestrator can sweep, or have the orchestrator sweep `agentstoz-ios-workroom-*/sims` sets.

8. **Low: the owned simulator's UDID and runtime are not in `run-status.json`.** `check-workroom.ts:190,320`
   - It records only `deviceSet:'owned-scratch'`. The UDID appears in no evidence file, and the runtime only in `result.json`, so a run that fails or is blocked before completing records neither.
   - Design §6 asks for the UDID and runtime. Without them, deletion can only be checked by trusting the script.
   - Fix: record `{udid, runtime}`.

9. **Low: the docs are out of date.**
   - `docs/plans/mobile-workspace-2026-09-11/NATIVE-EXECUTION.md:47` still says `AGENTSTOZ_IOS_PORTAL_URL` enables the portal smoke for `check-workroom.ts`; it now needs `--portal-url`.
   - `mobile/ios/README.md:125` says a missing private IPv4 interface is a failure; it now exits 78 (blocked).
   - Neither mentions `--compile-only`, the TMPDIR requirement, or the 0/1/78 exit codes.

10. **Low: the argument parsing accepts trailing extras.** `check-workroom.ts:33-38`
    - `--compile-only device extra` and `--device a b c extra` are accepted silently. Line 240 also sets `lastStage='startup'` a second time, which does nothing.

**Checked and not defects:**
- `bun run typecheck` exits 0; `tsc -p mobile/ios/tsconfig.json` exits 0; the two related test files give 29 pass, 0 fail.
- The builder's evidence matches the claims: `.claude/worktrees/wf_d5beb4e7-552-3/mobile/ios/build/workroom-evidence/run-status.json` shows passed at `efa39457`, 16 earlier simulators unchanged, owned simulator deleted, Simulator.app pids [606] before and after, and 49 compiled sources.
- The probe's change is sound: `confirm` returns true on response `""`, and `terminalClosing` stops the second tap.
- Nothing touches 3001, 52741 or 4723, nothing sends real input, and no test hook was added to production code.
- The "Mac 화면" sheet only opens on a tap, so the fixture never reaches the Screen network code.
- The review worktree `.claude/worktrees/review-wp3` has been removed.
