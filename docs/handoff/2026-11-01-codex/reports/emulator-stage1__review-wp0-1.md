# emulator-stage1 · review:wp0-1

(agent final report, verbatim)

English translation: Review branch emu/wp0-1 (WP0+WP1 emulator harness) against the design and safety rules, and return a ranked list of concrete defects (file:line, why, fix) or "no defects".

I checked the builder's claims in a temporary worktree, now removed. `bun test ./tests/emulator-e2e-guards.test.ts` gave 24 pass / 0 fail, `./tests/emulator-sandbox.test.ts` gave 8 pass / 0 fail, and `bun run typecheck` exited 0. tsconfig includes `tests/`, and the tests import the scripts, so the scripts are type-checked too. I did not run preflight. Nine defects, most severe first:

1. **High: the concurrency guard treats almost every process as "its own" and misses other runs** — `scripts/emulator-e2e/preflight.ts:184-194` (`ownProcessTree`), used at `:217` and `:575`.
   - Why: the descendant loop grows from the whole set, and that set already holds every ancestor. So siblings and cousins under the top ancestor count as "own". Measured live: 545 of 1818 processes were "own", which is the entire `/Applications/Orca.app` tree. A `check-ui.py` or `check-workroom.ts` started from another Orca, tmux or Workroom session is never reported as busy.
   - Why the tests missed it: the test at `tests/emulator-e2e-guards.test.ts:350-361` gives every row ppid 1.
   - Fix: own = the ancestor chain plus the descendants of `pid` only. Add a test where the orchestrator and an unrelated `check-ui.py` share a non-init parent.

2. **High (safety): the sandbox only blocks 3001, 52741 and 4723 on loopback, so other ports of the installed app are reachable** — `scripts/emulator-e2e/sandbox.ts:157-172`, `scripts/emulator-e2e/environment.ts:57`.
   - Why: `(allow network-outbound (remote ip "localhost:*"))` lets a host reach every other loopback listener. Observed: 127.0.0.1:50500 is listening in `/Applications/AgentsToZ_byCS.app/Contents/MacOS/app` (pid 42024), and the installed sidecar shares that socket. `native/workroom-browser/src/lib.rs:172-176` gives the embedded Chromium a random loopback remote-debugging port, which is likely this one. Orca, adb (5037) and agy listeners are also open. Design §1 promises that the sandbox blocks the installed app at OS level, and that does not hold.
   - Fix: at profile generation, deny every loopback LISTEN port owned by a pid outside the run (lsof the installed app, Screen, Control and other trees), or allow only ports the run owns. Add a canary that tries a foreign listener.

3. **Medium: stale simulator-lock reclaim can let two holders in** — `preflight.ts:287-290`, also `:264` and `:278-279`.
   - Why: two waiters can both see the same stale holder. A deletes it and creates its own lock. B then runs `rmSync` and deletes A's new lock, takes the lock itself, and both boot simulators.
   - Related: a holder whose `processStartedAt` is `'unknown'` always looks stale, so others take its lock while it is still running. `release` has the same read-then-delete gap.
   - Fix: reclaim by `renameSync` to a unique name, then re-read and compare the renamed holder before going on; refuse to write a lock with an unknown start time.

4. **Medium: hosts can rewrite their own sandbox profile** — `scripts/emulator-e2e.ts:244` and `:247` write `.sb` files into `join(scratchRoot,'sandbox')`, and `preflight.ts:517` makes `scratchRoot` writable.
   - Why: a host in one lane can edit `host-lanes.sb`, and later lanes spawn with the edited profile. `isolatedSidecar.ts:157,215` never checks the file against the recorded `sha256` before spawning.
   - Fix: keep profiles outside every writable root (a non-writable sibling directory), and re-hash before each `sandbox-exec`.

5. **Medium-low: lanes can skip the sandbox through the perf escape hatch** — `scripts/emulator-e2e/isolatedSidecar.ts:157,214-215`.
   - Why: `'unsandboxed-perf-measurement'` is a public option of the same `startSidecar` that lanes import. Nothing stops a harness lane from using it, so "all hosts go through sandbox-exec" is not enforced.
   - Fix: make it throw while `runHarness` is active, or expose only a sandbox-bound launcher on `LaneContext`. Add a static test that no `scripts/emulator-e2e/*` file uses the string.

6. **Low-medium: `all` can never pass on this Mac** — `scripts/emulator-e2e.ts:184-186` and `:220-222`.
   - Why: `lanesForAll()` includes every conditional lane, and unmet preconditions become `blocked`. The overall result is then `blocked` (exit 3) wherever 443 is not bindable, which the builder measured here. This contradicts the file's own header (line 9) and design §8 and WP13: "무인 + 조건 충족된 조건부 레인" (unattended lanes plus conditional lanes whose conditions are met).
   - Fix: run only conditional lanes whose conditions are met. Record the unmet ones as condition-unmet entries outside the exit calculation, or document that `all` is never green here.

7. **Low: the sidecar test exercises the real keychain path without waiting for the canaries** — `tests/emulator-sandbox.test.ts:203-210`.
   - Why: `/api/supabase-cli/apikeys` runs `security find-generic-password`. If the profile's exec deny regresses, this test reaches the user's real login keychain, with a possible OS prompt. It runs even when the canary test above fails.
   - Fix: skip it unless the canaries and the `static-exec-deny` check passed in the same run.

8. **Low: perf measurement conditions changed silently** — `scripts/perf/sidecar.ts:39-41`, through the shared `buildAllowlistedEnv`.
   - Why: the perf sidecar now runs with PATH stripped of Homebrew and `~/.bun`, with `NODE_ENV=test` (which turns on test-only branches at `api-server.ts:1069`, `:5492` and `:12329`), and with `PORT` set. It is still compared against `docs/perf/baseline.json`, which was measured under the old environment.
   - Fix: give perf its own environment builder that keeps the old conditions minus the forbidden keys, or record the environment change in the baseline metadata and re-baseline.

9. **Low: LAN mode allows binding on every interface, not just en0** — `sandbox.ts:164-168`.
   - Why: `lanInbound` adds `(allow network-bind (local ip "*:*"))`, which covers 0.0.0.0, utun and bridge interfaces. The design says "en0 inbound for the LAN host only".
   - Fix: allow only the en0 private IPv4 found at run time, for example `(local ip "<en0-ip>:*")`.
