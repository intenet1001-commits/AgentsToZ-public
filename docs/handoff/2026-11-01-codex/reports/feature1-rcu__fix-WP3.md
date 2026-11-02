# feature1-rcu · fix:WP3

(agent final report, verbatim)

I fixed all five findings and committed the fixes on `feat/rcu-wp3`. The three new regression tests fail when run against the old host code and pass on the fixed code.

**Branch:** `feat/rcu-wp3`. That branch was already checked out in `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-13`, so I checked it out here with `--ignore-other-worktrees`. As a result, the de0-13 worktree's files are now one commit behind the branch tip, and `git status` there will show this commit's changes reversed. Do not commit from de0-13 without resetting it first.

**Commit:** `cc8f60ad fix(computer-use): WP3 review — dispose answers waiting inputs as not run, notices retried by time, evicted kept in the ledger`, on top of `59cea02e`. It is not pushed.

**Files:**
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-15/src/computerUseRemoteHost.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-15/tests/computer-use-remote-host.test.ts`

`src/agentDialogueControl.ts` did not need a change.

**Findings:**
1. **`dispose()` did not stop the lane — fixed.**
   - `dispose()` now takes every waiting input out of the lane, records it in the ledger as not run (`receiver-off`), and answers it with the sealed not-run reply.
   - `run()` now refuses to start anything once the host is disposed.
   - An input that is already running keeps its 15 s deadline timer and still gets its real answer when it ends.
   - `dispose()` now returns a Promise that resolves once those not-run answers have been handed to the mailbox, so WP6 should `await host.dispose()` before the mailbox stops.
2. **The community notice could be lost — fixed.**
   - Retries are now spaced in time instead of capped at 3: one tick, then doubling, at most 60 s apart.
   - A start notice keeps retrying while its episode is open. An end notice keeps retrying for 30 minutes after it becomes due, then stops, so pending notices cannot pile up.
   - Every retry uses the same ID. The mailbox's `communityNotice` posts an ID only once, so retrying is safe.
3. **`evicted` was stored as `unknown` — fixed.** The ledger now keeps `evicted`, so the later receipt and a repeated row match the immediate reply. An evicted input is also no longer counted as an action in the end notice.
4. **Test honesty — fixed.**
   - The notice retry test now records the ID of every attempt, failed or not, and asserts they are all the same. It also covers the burst of 5 calls, the backoff gaps (5/10/20/40/60 s) and the end notice giving up.
   - I removed the `PORTMGR_BUNDLED_SIDECAR` block and replaced it with a test that scans the source and asserts the host reads no environment variable.
5. **WP6 handoff — written down as comments, not code.** The module's doc comment and the `selfDeviceId`/`bundled` doc comments now state what WP6 must do:
   - pass `IS_BUNDLED_API_SIDECAR` as `bundled`;
   - pass the community identity deviceId (the inbox's `to_device_id`) as `selfDeviceId`;
   - `await host.dispose()` on shutdown;
   - make the general `call` path and the phone forwarding path refuse the `computer-use` kind themselves (RC-14).

**Commands run (after the last edit):**

| Command | Result |
|---|---|
| `bun install` (node_modules was missing) | exit 0 |
| `bun test tests/computer-use-remote-host.test.ts tests/agent-dialogue-control.test.ts` | 33 pass, 0 fail |
| The same host test file with the old host restored from git (`git show HEAD:…`) | 20 pass, 3 fail — the three new tests; the fixed file is back in place |
| `bun run typecheck` (`tsc --noEmit`) | exit 0, no errors |
| `bun test tests/computer-use-*.test.ts tests/agent-dialogue-*.test.ts` (32 files, covering every test file this branch changes) | 382 pass, 1 skip, 0 fail |

The skip was not identified. It was also present at the reviewer's run and is probably an environment-gated test, since the `skip`/`skipIf` matches are all in suites this branch does not touch.

**Not done:**
- Wiring the host into `api-server.ts`, the RC-14 refusals and the `IS_BUNDLED_API_SIDECAR` test all belong to WP6.
- I did not run the AgentsToZ project-tester reconciliation, because it calls `127.0.0.1:3001`, which this task forbids.
