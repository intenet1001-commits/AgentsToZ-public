# emulator-stage1-fix · fix:wp3

(agent final report, verbatim)

Branch emu/wp3 now has two commits, 2875ce4a and 5258153e, on top of 979e330f. All 10 review findings are fixed and none were rejected. 979e330f is the earlier merge of emu/wp0-1@cd89a7dd, which finding 1 needed. Nothing was pushed.

Commits:
- 2875ce4a fix(ios-fixture): one compile list for the three LANWorkroomView fixtures; module cache kept in the scratch folder
- 5258153e fix(check-workroom): runs only under the harness sandbox (j1-pty lane), never leaves an old pass behind, fails on isolation problems

Findings:
1. Fixed. New lane `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-3/scripts/emulator-e2e/workroomPty.ts`, registered in `LANE_MODULES` as opt-in.
   - It runs check-workroom under `sandbox-exec` with WP1's profile plus `lanInbound`, and holds the simulator boot lock.
   - check-workroom will not start the simulator journey unless the OS confirms the process is sandboxed and a probe write into the worktree is denied. This is stronger than an environment marker, which could be copied.
2. Fixed. Every swiftc call passes `-module-cache-path <buildDir>/ModuleCache`.
   - I also had to add `-disable-sandbox`, but only when the caller is already sandboxed. Measured: inside the sandbox, `@Observable` failed with "swift-plugin-server produced malformed response".
3. Fixed. The CSP check moved into WorkroomProbe.swift, which reads `/remote/` through the phone's own URLSession. That is an inbound connection to the host, which `lanInbound` allows.
   - The host no longer calls `fetch`; it only asserts the probe's `lan-page-csp-default-src-none` check.
4. Fixed. Before any check, the parent rewrites `run-status.json` as failed (stage `startup`).
   - Every refusal and usage error records a reason.
   - If an evidence folder holds other files, only our old verdict file is overwritten.
   - After the child exits, a missing or unfinished verdict becomes failed, and exit 0 without a pass becomes exit 1.
5. Fixed. A changed earlier simulator, an unreadable simulator list, or a newly started Simulator.app now fails the run instead of producing a warning.
6. Fixed. New shared module `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-3/mobile/ios/scripts/workroomFixtureCompile.ts`.
   - Regression test `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-3/tests/ios-workroom-fixture-compile.test.ts` checks every local-package import and every App type the compiled files use, and shows the old list would have been caught.
7. Fixed. The owned device set (absolute path), owner pid, udid and runtime are recorded before and after `simctl create`.
   - The parent and the lane sweep any leftover set and confirm it is empty before deleting it.
   - The lane also cleans up sets that earlier killed runs left behind.
8. Fixed. The udid and runtime are in `run-status.json` and `result.json`, and are passed to `ctx.ownSimulator`.
9. Fixed. Updated `mobile/ios/README.md`, `docs/plans/mobile-workspace-2026-09-11/NATIVE-EXECUTION.md` and `mobile/ios/DEVICE-CHECKLIST.md`. They now describe `j1-pty`, `--compile-only`, `--portal-url`, `--evidence-dir`, the TMPDIR rule, exit codes 0/1/78 and the sandbox requirement.
10. Fixed. Argument parsing is strict: extra words, repeated options and relative `--evidence-dir` paths are rejected. The redundant second `lastStage='startup'` is removed.

Regression tests for findings 1, 3–5, 7, 8 and 10 are in `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-3/tests/check-workroom-support.test.ts`. It includes a real `sandbox-exec` child (sandboxed, worktree write denied) and the real script refusing to run unsandboxed over a planted old pass.

Commands and results:
- `./node_modules/.bin/tsc --noEmit -p mobile/ios/tsconfig.json`: exit 0.
- `bun run typecheck`: exit 0. The first run found TS18047 in workroomPty.ts (`capabilities` can be null); I fixed it before committing.
- `bun test tests/check-workroom-support.test.ts tests/ios-workroom-fixture-compile.test.ts tests/ios-shell-contract.test.ts tests/emulator-e2e-guards.test.ts tests/emulator-sandbox.test.ts ./mobile/ios/scripts/tests/share-extension.test.ts`: 90 pass, 0 fail.
- `bun mobile/ios/scripts/check-workroom.ts --compile-only device` and `--compile-only simulator`, `bun mobile/ios/scripts/prepare-workroom-persona-device.ts --compile-only`, `bun mobile/ios/scripts/check-common-memory-device.ts --compile-only`: all exit 0 (32, 24, 22 and 26 s). The shared ModuleCache got 0 new files.
- Lane check from a copy at `/Users/cs-work/agentstoz-emulator/wp3fix-20261101a/wt` (`git archive 5258153e` then `bun install --frozen-lockfile`): `bun scripts/emulator-e2e.ts j1-pty` exited 0 on run 20261101-044353-3501af.
  - Preflight and the j1-pty lane both passed.
  - `run-status.json`: passed, stage complete; compile 26.3 s, boot 31.4 s, journey 77.6 s, total 153.3 s.
  - The script saw itself sandboxed, and its worktree write got EPERM.
  - 39 probe checks passed, including the CSP check; 0 foreign requests; 0 project-change attempts; no pairing-token leaks.
  - The owned simulator (EC532E23-F16A-44B5-85AA-A92590510DDB, iOS 26.5) was created and deleted, and its device set is gone. Nothing needed sweeping.
  - The 16 earlier simulators are unchanged (harness verdict and my own `simctl` comparison). Simulator.app was pid 606 before and after, with no new instance.
  - No sudo, port 443, OS prompt or installed-app port was involved. The copy and the run's scratch folder have been removed.
- Not run: the full `bun test` / `bun run verify`; only the affected test files above.

Things to know when integrating:
- emu/wp3 now contains emu/wp0-1. Use `git diff emu/wp0-1...emu/wp3` to see only the WP3 changes.
- The lane calls `ctx.sandboxProfile('j1-pty-lan', {lanInbound: true})`. If the wp0-1 fixer changes how `lanInbound` is passed, this call needs the same change.
- My `LANE_MODULES` entry may conflict with the wp7 fixer's registration. It is a one-line merge.
- I edited files outside WP3's list because I had to:
  - `tests/ios-shell-contract.test.ts` and `mobile/ios/scripts/tests/share-extension.test.ts` both checked the old hand-kept list.
  - `mobile/ios/DEVICE-CHECKLIST.md` is a WP4 file; I changed one command line.
- Follow-up for wp0-1: `HARNESS_SCAN_PATHS` in `scripts/emulator-e2e/preflight.ts` does not yet scan workroomPty.ts, checkWorkroomSupport.ts or workroomFixtureCompile.ts.
- `.agentstoz/maintainer.json` `iphone-workroom` runs only the `--device` path. It is unchanged and WP13 owns it.
- The main checkout still has an old `mobile/ios/build/workroom-evidence/run-status.json` showing passed from 2026-09-11. I didn't touch it because it is outside this worktree; the next run there replaces it, and the lane uses its own folder.
- emu/wp3 is also checked out in the builder worktree wf_d5beb4e7-552-3; I switched to it here with `--ignore-other-worktrees`. That worktree's files are now behind the branch.
- Commit 2875ce4a on its own still has check-workroom's old list, so the compile-list test passes only at 5258153e.
