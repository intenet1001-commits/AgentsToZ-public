# emulator-stage1 · review:wp7

(agent final report, verbatim)

WP7 review of `emu/wp7` (commit 35bebe20) against main: 10 defects, ranked by severity.

**What I checked:** I re-read the builder's selfcheck evidence: 43/43 checks, 32 frames, counters 0..31, source hashes equal. `bun run typecheck` and a scratch-tsconfig typecheck of `screenFixtureHost.ts` both exit 0. The diff touches only the 6 WP7 files; nothing under `native/screen-control/Sources` or `Package.swift` changes. I did not re-run the selfcheck or `test:screen-control`, because both start fixture servers.

1. **HIGH: the sandbox does not block signals** (`scripts/emulator-e2e/screenFixtureHost.ts:271`).
   - **Why:** I ran `sandbox-exec -f <this profile> /bin/kill -TERM <pid of an unrelated sleep>` and the sleep died. So `(deny signal (target others))` does nothing. A sandboxed host or viewer can signal any process owned by the same user, including the installed app's sidecar on 3001 and the real Screen on 52741. Design §2.5 relies on the sandbox blocking signals, and WP0-1 measured the same failure (`emu/wp0-1:scripts/emulator-e2e/sandbox.ts:10`). No selfcheck canary covers signals, which is how 43/43 passed.
   - **Fix:** use `(deny signal)` followed by `(allow signal (target same-sandbox))`. I tested this: the kill gets "Operation not permitted" and the sleep survives. Add a canary to `sandboxCanaries` (582-630) that sends SIGTERM to a harmless sibling `sleep` and asserts it is still alive.

2. **MEDIUM: not wired into the orchestrator** (`screenFixtureHost.ts`, whole module).
   - **Why:** WP0's lane contract (`emu/wp0-1:scripts/emulator-e2e.ts:16-17`, 160-176) needs an `export const lane: LaneDefinition` with id `screen-host-selfcheck`. This module has none, so the package's stated verification, `bun scripts/emulator-e2e.ts screen-host-selfcheck`, would report "skipped: not implemented yet". The builder verified with a different command and did not list that as a deviation.
   - **Fix:** export a `lane` whose `run(ctx)` uses `ctx.hostSandbox` and `ctx.allowlistedEnv`, then register it in `LANE_MODULES`.

3. **MEDIUM: `start({env})` rejects WP0's environment** (`screenFixtureHost.ts:77`).
   - **Why:** `FORBIDDEN_ENV` contains `^APP_DATA_DIR$`. Design §2.2 requires APP_DATA_DIR to be set to a scratch folder, and WP0's `buildAllowlistedEnv` always sets it. I confirmed that `assertFixtureEnvironment` on a WP0-style environment throws "forbidden keys: APP_DATA_DIR", so the orchestrator cannot pass its environment in. WP7 also brings its own sandbox generator, which drifts from WP1's single generator (design §2.3).
   - **Fix:** allow APP_DATA_DIR when it lies inside the scratch roots, and use WP1's `sandbox.ts`, or add WP7's extra rules to it.

4. **MEDIUM: `selfcheck --work-dir DIR` deletes DIR** (`screenFixtureHost.ts:737` and `:750`).
   - **Why:** whatever folder the caller passes is chmodded to 0700, then removed with `rmSync(work, {recursive: true, force: true})` unless `--keep` is given. If someone passes the run folder (`/Users/cs-work/agentstoz-emulator/<runId>`), the worktree and the evidence are deleted.
   - **Fix:** create a `mkdtemp` folder inside the given directory and delete only that, or refuse an existing folder that is not empty.

5. **MEDIUM-LOW: the nm gate does not stop anything** (`screenFixtureHost.ts:460`, `:771-780`).
   - **Why:** the exported `start()` and `selfcheck` both launch the host binary even when `build.gates` failed. Only `serve` refuses.
   - **Fix:** in `start()`, throw unless `options.build.gates.every(g => g.passed)`, and end the selfcheck as soon as a gate fails.

6. **LOW-MEDIUM: the environment check is too loose** (`screenFixtureHost.ts:98-107`).
   - **Why:** it only rejects a HOME that contains the real home. A HOME under the real home passes; I confirmed `HOME=/Users/cs-work/x/home` is accepted. Design §2.2 and WP0's `createRunScratch` refuse that. The check is also a denylist, so a supplied environment with `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, or `HERMES_HOME=~/.hermes` passes.
   - **Fix:** reject HOME and TMPDIR inside `REAL_HOME`, and enforce a key allowlist.

7. **LOW: the "deny one port does not work" finding sent to other packages is likely wrong as stated** (`screenFixtureHost.ts:251-254` and the builder's report).
   - **Why:** WP0-1 measured on this same Mac (`emu/wp0-1:scripts/emulator-e2e/sandbox.ts:7-9`) that a port deny after a filtered `localhost:*` allow does work. It only fails when the profile starts with an unfiltered `(deny network*)`, which WP7's profile does. WP7's own allowlist approach is fine, but telling other owners that 3001 is not blocked would cause needless churn.
   - **Fix:** correct the comment and the finding, or retest without the unfiltered prefix. I did not run this test, because it needs a listener.

8. **LOW: sandboxed viewers can rewrite their own profile** (`screenFixtureHost.ts:709-716`).
   - **Why:** `viewerChild` reuses an existing `.sb` file in `work`, and `work` is writable by the sandboxed viewer. A viewer can therefore change the profile used by later viewer launches.
   - **Fix:** regenerate the profile on every launch, or write profiles outside the sandbox's writable folders.

9. **LOW: some checks claim more than they measure.**
   - **Why:**
     - `host-loopback-only` (`:788`) only checks the port number, never the bound address.
     - The `listening` receipt's `"host":"127.0.0.1"` is a hard-coded string (`main.swift:466`).
     - `no-tcc-window-keychain-surface` (`:902`) is derived from other checks and measures nothing new.
     - `production-sources-unchanged` compares before and after within one run, not against main.
     - `tcc-no-prompt-observed` passes when nothing is attributed to the fixture, so it would pass quietly if the log format changed.
   - **Fix:** confirm the listener address with `lsof -a -p <pid> -iTCP -sTCP:LISTEN`, compare the source hashes with main's tree, and rename or drop the derived check.

10. **LOW: smaller gaps.**
    - **`serve` loses the caller's id** (`:964` with `:486`): the internal counter replaces the caller's `id`, so replies cannot be matched to requests. Echo the caller's id instead.
    - **No unit tests:** there is no `bun test` for the pure helpers: the profile generator refusing 3001, 52741 and 4723, the environment check, and the gate parsing. Because `tsconfig` does not include `scripts/`, `bun run verify` never type-checks this file either.
    - **Invite caveat:** the nearby-only `device` invite can never reach the counting listener. A J2-APP-BOUNDARY "0 connections" assertion on it proves nothing; only `deviceLegacy` points at the listener, and the code should say so.

The temporary worktree at `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/review-wp7` has been removed. My probe files are in `/private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/`; nothing in the repository was changed.
