# emulator-stage2 · review:wp10

(agent final report, verbatim)

Ranked defects for emu/wp10 (5, none high-severity):

The lane itself holds up. It runs the real production code: each sidecar's own `/api/control-profile/prepare`, the real `candidates()` and marker check, and the dialogue identity, which calls `sharedProfileId()` at `api-server.ts:4907-4917`. It runs a sandboxed verify child that calls the real `ControlProfileStore.sharedProfileId()`, and the canonical dialogue SQL on PGlite. The keychain stand-in only changes which executable is spawned; the key provider, decoding, HMAC and `register-device` stay real.

It checks both Macs and the shim database: the 409 before `prepare`, `controlDevices` on A and B, the `projects` answer coming from the other Mac, and DB rows showing one profile, two device ids, and each control done exactly once. Because `profileId` differs from `memoryId`, the run proves the marker was read.

I ran `bun test` on both test files in a temporary worktree: 53 pass, 0 fail. The worktree has been removed. I found no lane logic that could pass with the feature broken. The defects are in the guards and in cleanup.

1. **`tests/emulator-control-profile-fixture.test.ts:155-173` (spawn at :162): latent safety hazard.**
   - **Why:** The "wrapper refuses" probes run `dialogue-keychain-entry.ts` outside the sandbox, with `api-server.ts` (an allowed next entry) as the next entry and no `API_PORT`. Every probe relies on the wrapper's own checks to exit 64.
   - **Failure case:** If one check regresses (for example the stand-in-inside-root check exercised by the `outside` case), the test boots a real api-server on the person's Mac, outside the sandbox, on the default port 3001 (`api-server.ts:16895`). `Bun.spawnSync` has no timeout, so `bun run verify` also hangs.
   - **Fix:** Run the probes through `sandboxedArgv(hostSandbox, …)`, set `API_PORT` to a reserved ephemeral port, and add a `timeout` to `spawnSync`.

2. **`tests/emulator-control-profile-fixture.test.ts:199-200`: weak guard (can pass when the rule is broken).**
   - **Why:** This test checks that the orchestrator file has no static imports of host code. The regex `^import\s.*from\s+'…';$` does not span lines, so it misses multi-line imports.
   - **Evidence:** I ran it against the file. It does not see `./dialogueKeychainStandIn` (`controlProfileFixture.ts:39-46`). A multi-line `import {initializeProjectMemory} from '../../project-memory-server'` passes the check.
   - **Fix:** Use `new Bun.Transpiler({loader:'ts'}).scanImports(source).filter(i => i.kind === 'import-statement')`. This drops type-only and dynamic imports, which are allowed.

3. **`scripts/emulator-e2e/controlProfileFixture.ts:427-441` and `:357`: cleanup leak on partial failure.**
   - **Why:** `startCommunityMacs` uses `Promise.all`. If Mac A's sidecar or seed fails while Mac B's `ctx.startSidecar` is still waiting on health (up to 90 s), the lane returns and `runOneLane` settles the lane's hosts. Mac B's sidecar registers after that settle, so it is never stopped.
   - **Effect:** That sidecar keeps running, and its scratch folder may already be deleted. In `all` mode it overlaps later lanes until the process exits. The seed and verify children from `runFixtureChild` are also not registered with `trackChild`, so a signal to the harness does not kill them.
   - **Fix:** Use `Promise.allSettled`, stop every sidecar that did start, then rethrow. Call `trackChild(child)` in `runFixtureChild`.

4. **`tests/emulator-control-profile-fixture.test.ts:311`: a skip reported as a pass.**
   - **Why:** When `sandbox-exec` is missing (for example on the Windows PC), the test hits `console.warn(...); return;` and reports a pass. Its own comment says a skip is not a pass.
   - **Fix:** Use `test.skipIf(!sandboxed)(…)`.

5. **`scripts/emulator-e2e/controlProfileFixture.ts:438` (seed runs after the sidecar is up): low flake risk and a fidelity gap.**
   - **Why:** Avoiding the unemulated `GET /rest/v1/portmgr_what_i_said_memory_policy` depends on timing that nothing enforces. The sidecar's startup reconcile (`api-server.ts:29170` → `:12531-12533`) must finish listing projects before the seed child writes OPS memory. The margin is only the seed child's startup time, so a heavily loaded machine could produce unknown routes and fail the lane.
   - **Fidelity:** Real Macs start with OPS memory already present. The order is labeled as a stand-in, but it hides the shim gap from WP11.
   - **Fix:** Have the WP2 shim emulate that read (return an empty list), then go back to seeding before boot.
