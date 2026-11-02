# emulator-stage1-fix · fix:wp7

(agent final report, verbatim)

No review finding was rejected: all ten are fixed and committed on emu/wp7. The fixes make the package's tests, `bun run typecheck`, the standalone selfcheck (46/46) and the orchestrator lane in a disposable copy (45/45) pass.

**Commits on emu/wp7** (worktree /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-4):
- `91dec26a` fix(emulator): close the WP7 review findings on the screen fixture host. It changes three files:
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-4/scripts/emulator-e2e/screenFixtureHost.ts
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-4/native/screen-control/Tests/Fixtures/ScreenFixtureHost/main.swift
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-4/tests/emulator-screen-fixture-host.test.ts (new)
- `82752762` test(emulator): check fixture reachability on WP1's allowlist-shaped base.
- Both end with the two required trailer lines.
- I checked out with `git checkout --ignore-other-worktrees emu/wp7`, because the idle builder worktree wf_d5beb4e7-552-4 already had the branch checked out. That worktree's files are now older than the branch.

**Findings**
1. **HIGH, signals: fixed.**
   - The profile now uses `(deny signal)` plus `(allow signal (target same-sandbox))`.
   - A new selfcheck canary, `sandbox-canary-signal-outside-sandbox-refused`, sends SIGTERM to an unrelated `sleep` and checks it survives.
   - Real `sandbox-exec` tests check the same with no base and composed on both WP1-shaped bases.
2. **MEDIUM, orchestrator wiring: fixed.**
   - The module now has `export const lane` with id `screen-host-selfcheck`.
   - `run(ctx)` uses `ctx.hostSandbox.text` as the sandbox base, `ctx.isolatedProfile` with `ctx.allowlistedEnv` for the environment, `ctx.scratchRoot` and `ctx.evidence.dir`.
   - One step is left for integration: `scripts/emulator-e2e.ts` exists only on emu/wp0-1, so the `LANE_MODULES` line has to be added there. The line is `'screen-host-selfcheck': () => import('./emulator-e2e/screenFixtureHost'),` and it was verified in the copy below.
3. **MEDIUM, APP_DATA_DIR and the separate generator: fixed.**
   - The environment check now uses WP0's key list plus NODE_EXTRA_CA_CERTS. APP_DATA_DIR is accepted when it is inside the scratch roots.
   - The fixture rules are now appended after WP1's generated host profile through `base`, instead of replacing it.
   - WP7 still writes the fixture-specific additions (allowed programs, a one-port outbound allowlist), because WP1's generator has neither.
4. **MEDIUM, `--work-dir` deleting the folder: fixed.**
   - `--work-dir` is now a parent folder. The run creates a 0700 `agentstoz-screen-fixture-*` subfolder inside it and deletes only that.
   - The parent is never chmodded, and an evidence folder that is not empty is refused.
5. **MEDIUM-LOW, the nm gate not stopping anything: fixed.**
   - `start()` refuses a binary that failed the gate, was never gated, or changed after gating.
   - The selfcheck stops on a failed gate or failed canaries.
6. **LOW-MEDIUM, the loose environment check: fixed.**
   - It is now a key allowlist. Scratch path keys must be inside the scratch roots and not under the real home, which is read from directory services.
7. **LOW, the "deny one port does not work" claim: fixed by correcting the comment.**
   - The reviewer was right: a port deny placed after filtered rules works, and a test measures this.
   - I measured a different problem: any outbound deny placed after a one-port allow makes that allowed port fail intermittently (9/60 trials).
   - WP7 now puts its allowlist last (0/100 failures), and a static check rejects a profile that puts an outbound deny after the allow.
   - 30-trial tests cover three cases: no base, the older WP1 shape, and WP1's current allowlist shape.
8. **LOW, viewers rewriting their own profile: fixed.**
   - The profile is regenerated on every launch, outside the sandbox's writable folders, with mode 0600.
9. **LOW, checks claiming more than they measure: fixed.**
   - The bound address is now measured with lsof (`host-listens-on-loopback-only`, `invite-listens-on-loopback-only`).
   - The `listening` receipt now says `requestedHost` instead of claiming the bound host.
   - The derived `no-tcc-window-keychain-surface` check is dropped.
   - A new check, `production-sources-match-main-base`, compares against main's merge base when the checkout has git metadata.
   - The TCC check now fails if no TCC request was recognized in the run window.
10. **LOW, smaller gaps: fixed.**
    - `serve` returns the caller's id.
    - There are now 33 unit tests, and because a test imports the script, `bun run typecheck` covers it.
    - The invite caveat is recorded: `countingListenerReachable` (only `deviceLegacy` reaches the listener) in invites.json and the receipt, plus a check and a label.

**Note for the WP0-1 owner (their file, not edited).** In emu/wp0-1 `daeca98e`, `scripts/emulator-e2e/sandbox.ts` `buildSandboxProfile` puts the reserved-port and unix-socket outbound denies after the `allowedLoopbackPorts` allows. Measured alone, its own allowed port was refused in 8 of 60 trials. Moving the allowlist after all outbound denies should fix it. WP7's rules added on top of that base reached the allowed port in 60 of 60 trials.

**Commands and results**
- `bun test --cwd tests emulator-screen-fixture-host`: 33 pass, 0 fail.
- `bun run typecheck`: exit 0.
- `bun run test:screen-control`: exit 0. 102/102 screen-control checks, the status-file contract check, and `swift test` (filtered) with 13 tests, 0 failures.
- `bun scripts/emulator-e2e/screenFixtureHost.ts selfcheck`: exit 0, 46/46 in 22.5s, no fixture processes left.
  - Evidence: /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-4/mobile/ios/build/emulator-evidence/screen-host-selfcheck-2026-11-01T04-43-56-257Z
- Mutation checks: I temporarily put back each old behavior and confirmed its tests fail (the old signal rule, the old network order, `start()` skipping the gate, `serve` dropping the caller's id). For the network order, all 3 reachability tests fail. The file was restored each time.
- Integrated copy at /Users/cs-work/agentstoz-emulator/wp7-lane-20261101134757/wt:
  - Built from a git archive of `82752762`, plus the 10 files from emu/wp0-1 `daeca98e`, plus the `LANE_MODULES` line, then `bun install --frozen-lockfile` (587 packages).
  - `bun run typecheck`: exit 0. This confirms the lane type-checks against `LaneDefinition`.
  - `bun test --cwd tests emulator-`: 80 pass, 0 fail across 3 files, including WP0's forbidden-tool scan over the WP7 files.
  - `bun scripts/emulator-e2e.ts screen-host-selfcheck`: exit 0, preflight pass, lane pass 45/45, summary pass 2, fail 0, blocked 0, skipped 0.
  - The main-base comparison was not measured there, because the archive copy has no git metadata.
  - `sandboxBaseSha256` equals the run's `hostProfileSha256` (9cdd7ea9…), so the lane really ran on WP1's host profile.
  - The copy is removed. Its evidence is saved at /private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/wp7fix/lane-evidence

**Safety**
- No sudo, no pf, no keychain or TCC changes.
- No connections to 3001, 52741, 4723 or any installed app's port, and none of the forbidden tools were used.
- No simulators were used, and no OS prompts appeared.
- Port 443 is not needed by this lane; WP0's preflight only measured it.
- I left alone two temp folders in TMPDIR, `agentstoz-screen-control-eweCnz` and `atz-emu-identity-14265-xQh8o6`. Both were created after my runs finished, so they are not from this work.
