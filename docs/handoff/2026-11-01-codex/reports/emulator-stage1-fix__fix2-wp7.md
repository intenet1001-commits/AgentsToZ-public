# emulator-stage1-fix · fix2:wp7

(agent final report, verbatim)

English translation: "It's meant so that once you connect, you can just keep using it comfortably, right?"

Finding 2 is now fixed on `emu/wp7`. Running `bun scripts/emulator-e2e.ts screen-host-selfcheck` now finds the lane, and the lane passed 45/45 in a real run. All 10 review findings are now closed.

**What changed on `emu/wp7`** (it moved from `82752762` to `b47b8855`)

1. **`d4c221c7`: merged `emu/wp0-1` into `emu/wp7`.** This is the same thing `emu/wp3` did in `979e330f`, and it brings in the orchestrator file that `emu/wp7` was missing. The two branches change different files, so the merge had no conflicts.
2. **`b47b8855`: registered the lane.** In `scripts/emulator-e2e.ts`:
   ```ts
   export const LANE_MODULES: Partial<Record<LaneId, () => Promise<{lane: LaneDefinition}>>> = {
     'screen-host-selfcheck': () => import('./emulator-e2e/screenFixtureHost'),
   };
   ```
   Two more changes in the same commit:
   - **New test** in `tests/emulator-screen-fixture-host.test.ts`. It checks that the lane has a loader and that the orchestrator resolves it to the lane the module exports.
   - **The two minor wording notes:**
     - The comment in `scripts/emulator-e2e/screenFixtureHost.ts` now says which WP1 version each measurement refers to.
     - The signal and reachability tests now also run against WP1's real sandbox generator from `5c8d645d`, not just the two older hand-written versions of it.

**Checks**

These ran on a fresh copy of `b47b8855` at `/Users/cs-work/agentstoz-emulator/wp7-reg-20261101/wt`, made with `git archive`, after a real `bun install --frozen-lockfile` (587 packages):

| Command | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `PATH="/usr/bin:$PATH" bun test --cwd tests emulator-` | 85 pass, 0 fail, 3 files (was 82; +1 registration test, +2 tests on WP1's real profile) |
| `bun scripts/emulator-e2e.ts list` | `screen-host-selfcheck … registered` |
| `bun scripts/emulator-e2e.ts screen-host-selfcheck` | exit 0 |

Details of the lane run:
- Preflight passed, the lane passed 45/45 checks, and the summary was pass 2, fail 0, blocked 0, skipped 0.
- The sandbox base the lane recorded (`sandboxBaseSha256`) matches both the run's `sandbox/host.sb` and the host profile hash in the index: `63d712d0…`.
- The TCC check recognised 8 requests: 0 from the fixture and 0 prompts.
- One check was not measured: the copy has no git metadata, so it could not compare the production sources with `main`.

**Things to know**
- When `emu/wp3` and `emu/wp7` are merged into integration, the `LANE_MODULES` object will conflict, but only trivially: keep both entries, `j1-pty` and `screen-host-selfcheck`.
- Two other worktrees still have `emu/wp7` checked out (`wf_35f16659-79d-4`, `wf_d5beb4e7-552-4`). Since the branch moved forward under them, their working trees will look out of date until they are reset to the new commit.

**Cleanup and safety:** the copy is deleted, no fixture processes are left, and the run's temporary files and the test temp folders are gone. Nothing was pushed. None of the forbidden ports, apps, simulators, keychain or TCC were touched, and no OS prompts appeared.

The lane log is at `/private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/wp7-reg-lane.log`.
