# emulator-stage2 · build:wp10

(agent final report, verbatim)

WP10 is done on branch `emu/wp10`. The `j4-fixture` lane passed from a copy outside the registered root.

**Result**
- In both sandboxed sidecars A and B, the real `ControlProfileStore.sharedProfileId()` returned the fixture profile id `bca37cf4-b695-47b5-a6a3-fcac1f9c2759`.
- The portal deviceIds differ (`8f5e8cae-…` and `0458ee58-…`), and so do the access keys.
- Both Macs enabled their OPS endpoint and joined the same community room through the shim.
- Each Mac's `controlDevices` lists only the other Mac's OPS endpoint. A `{kind:'projects'}` control call succeeded in both directions.
- The sandbox canary `real-app-data-read` was blocked, and the open-file check found no real user files.

**Commits** (not pushed; main and the main checkout untouched)
- `af8bea60` feat(emulator-e2e): WP10 shared control-folder profile fixture and j4-fixture lane
- `830666a9` fix(emulator-e2e): j4-fixture reads the control answer envelope and seeds OPS memory after boot
- `9955978d` docs(community): record the passing j4-fixture run (docs only, made after the lane run)

**Files**
- New: `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-4/scripts/emulator-e2e/controlProfileFixture.ts` (recipe and lane)
- New: `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-4/scripts/emulator-e2e/dialogueKeychainStandIn.ts`
- New: `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-4/scripts/emulator-e2e/dialogue-keychain-entry.ts`
- New: `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-4/tests/emulator-control-profile-fixture.test.ts`
- Modified: `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-4/docs/claude/community.md` (recipe section)
- Lane registration: `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-4/scripts/emulator-e2e.ts`
  - Added `j4-fixture` to `LANE_IDS`, the catalog (unattended, WP10, before j4-web), `LANE_MODULES`, `HARNESS_SOURCE_FILES` and the usage comment. Expect a merge conflict with emu/wp5 here.

**Changes outside the package's file list**
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-4/scripts/emulator-e2e/isolatedSidecar.ts` gets a new `entryWrapper` option (source mode only).
  - Why: the sandbox blocks `/usr/bin/security`, so the dialogue device key could not be created and enabling the endpoint failed.
  - Seams in the production sidecar are forbidden, so a lane-only wrapper redirects exactly two calls (find and add of the agent-dialogue key) to a scratch stand-in.
  - Everything else still runs real code (key provider, HMAC, `register-device`). The test confirms the wrapper is not a production build entry.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-4/tests/emulator-e2e-guards.test.ts` line 303: added `j4-fixture` to its hard-coded lane list.

**Commands and results**
- `bun run typecheck`: 0 errors.
- `bun test tests/emulator-control-profile-fixture.test.ts`: 14 pass, 0 fail.
  - This includes a real-store check: sandboxed seed and verify children plus the real `createControlProfileHost.prepare` on two scratch Macs.
- `bun test tests/emulator-control-profile-fixture.test.ts tests/emulator-e2e-guards.test.ts tests/claude-md-size.test.ts`: 56 pass, 0 fail.
- An earlier run of `bun test tests/emulator-e2e-guards.test.ts tests/emulator-sandbox.test.ts`: 62 pass, 0 fail.
- Outside copy:
  - `git archive emu/wp10` (at `830666a9`) unpacked to `/Users/cs-work/agentstoz-emulator/wp10-run2/wt`, then `bun install`.
  - `bun scripts/emulator-e2e.ts preflight`: pass.
  - `bun scripts/emulator-e2e.ts j4-fixture`: exit 0.
  - The new test file also passed there (14 pass).
  - Both copies have been deleted.

Real index.json summary (run `20261101-072734-7cd8d9`):
`{"total": 2, "pass": 2, "fail": 0, "blocked": 0, "skipped": 0, "overall": "pass", "exitCode": 0, "passed": true}`

j4-fixture: pass, 9.62 s.
- Before prepare, both Macs answered 409 `AGENT_DIALOGUE_SHARED_PROFILE_REQUIRED`. After prepare, the binding was ready, control-folder, and that Mac's own OPS registration.
- Shim dialogue database: 2 device keys, 2 active OPS endpoints, 1 community room, 2 joined members. Each control ran once (pending, taken, done), and no rows carried another profile.
- Shim report: ok, 0 unknown routes, 0 rejected origins, exit code 0.
- Keychain stand-in on each Mac: one find (absent), one add, one find (found), with 0 refused calls.
- 14 receipts, all `scriptedApproval:true`.
- Every canary result was blocked and canaries passed. `gitHead` shows "unknown" because the archive copy has no `.git`.
- Labels (`real`/`standIn`) are recorded in the lane evidence and summary.json.

**Problems found on the way**
- **First run failed.** It was run `20261101-072154-30bed7`, from the same kind of outside copy.
  - The lane read the projects answer without unwrapping its `{ok, body}` envelope; fixed and unit-tested.
  - The WP2 shim does not emulate `GET /rest/v1/portmgr_what_i_said_memory_policy`. The sidecar reads it at boot for every registered project that has memory, which produced 4 unknown routes and a shim exit code of 3.
- **Workaround for the shim gap.** The OPS memory is now seeded after each sidecar is up; this order is recorded in the stand-in labels and docs. It goes back to seed-then-boot once WP2 emulates that read.
- **Shim gap affects WP11.** Any J4 lane that registers a project with memory before boot will hit the same gap.

**Scope notes**
- The phone end is not in this lane; it belongs to WP11 (j4-web). Here the two ends checked are Mac A and Mac B, plus the shim database.
- No simulator was used, and no ios-ui or `check-ui.py` changes were needed.
