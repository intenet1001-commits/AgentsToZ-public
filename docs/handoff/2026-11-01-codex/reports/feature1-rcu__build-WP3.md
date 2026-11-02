# feature1-rcu · build:WP3

(agent final report, verbatim)

WP3 is done and committed on branch `feat/rcu-wp3`. The new tests, the typecheck and the related suites all pass. Nothing was pushed and the main checkout was not touched. Two things are still open: WP6 has to wire the host into `api-server.ts`, and the full `bun run verify`, `cargo test` and smoke runs were not done.

**Branch and commit**
- Branch: `feat/rcu-wp3`. It already had WP1, WP2 and WP4 merged in (597c3680, 1954cffe, a5cf5dc9).
- New commit: 59cea02e, "feat(computer-use): B-side receiving host and community executor branch (WP3)". It ends with the required Co-Authored-By and Claude-Session lines.
- The working tree is clean after the commit.

**Files** (only the four this package owns; nothing outside them was edited)
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-13/src/computerUseRemoteHost.ts (new, 765 lines)
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-13/src/agentDialogueControl.ts (changed)
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-13/tests/computer-use-remote-host.test.ts (new, 20 tests)
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-13/tests/agent-dialogue-control.test.ts (one test added)

All commands were run from the worktree:

| Command | Result |
|---|---|
| `bun test tests/agent-dialogue-control.test.ts tests/computer-use-remote-host.test.ts` | 30 pass, 0 fail, 1396 expect() calls, 2 files |
| `bun test --rerun-each 5 tests/computer-use-remote-host.test.ts` (stability check) | 100 pass, 0 fail, 6600 expect() calls |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun test tests/computer-use-*.test.ts tests/agent-dialogue-*.test.ts` | 379 pass, 1 skip, 0 fail, 6094 expect() calls, 380 tests across 32 files |
| `bun test tests/agent-dialogue-control.test.ts tests/mobile-workspace-attachments.test.ts tests/ops-request.test.ts tests/ops-request-edge.test.ts tests/community-submission.test.ts` | 73 pass, 0 fail, 425 expect() calls, 5 files |

The one skip in the related suites is not in a WP3 file. Several earlier files have conditional skips (build-output, cooperative-activation, control-native, main-link, signing-profile), and one of them skipped on this machine.

**How the WP3 test list is covered**
- **sentAt guard:** checked when execution starts.
  - 12,000 ms old runs; 12,001 ms is not run (stale). 5,000 ms ahead runs; 5,001 ms is not run (clock).
  - `request-access` and `request-human` follow the same rule.
  - An item that was fresh when the poll took it but stale when its turn came is not run.
- **Ledger:**
  - The same requestId on another connection, or on another device with the same tag, runs on its own, and its receipt does not leak.
  - The same key with different content gets `COMPUTER_USE_REMOTE_HOST_ID_CHANGED` (not run).
  - With 1,030 entries the oldest settled ones are evicted and `evictedThroughSentAt` rises. Queued and running entries stay; the sender reads the evicted range as unknown-final.
  - After 15 minutes of retention the range is reported too.
  - Asking about an unseen ID leaves a marker, so the original row arriving later is not run (stale).
- **Receipts:** each of in-progress, the actual receipt, not-run, evicted (from ScopeHost) and unseen comes back with `bootId` and `evictedThroughSentAt`. All of them parse with WP4's `parseComputerUseRemoteReceiptAnswer`.
- **Restart:** a new host has a new `bootId`. An old session's request gets `REMOTE_SESSION_MISSING` with no runtime call at all.
- **Lane:**
  - Over 4 per device or 8 in total is not run (busy) straight away.
  - At the 15 s deadline a waiting item is not run, and a running one gets the deadline sentence once. It keeps running, then settles in the ledger.
  - Over the real PGlite mailbox, one poll handled a click (detached while Control was held), a terminal row, a call outside the allowed list and a refused observe. The terminal row was answered while the click was still running.
- **No plaintext after decryption:** every answer recorded in the database is checked, and none contains the secrets, coordinates, request IDs or operation names. A malformed frame that did open is answered inside the sealed reply.
- **Fixed refusals:** not bundled, `win32`, `linux`, a Windows sender, the person's switch off, and a blocked device or connection. Setting `PORTMGR_BUNDLED_SIDECAR=1` does not get around them.
- **Notices:** one when a remote grant opens and one after five minutes closed, grouped per sending device, with action counts and no content. A failed post is retried with the same ID.
- **Real runtime:** with the standing allowance on, `request-access` opens a grant labelled from the first call, and the open and end notices follow it. A connection block and turning `allowRemote` off both refuse the next hello.
- **Executor:**
  - Without a `computerUse` dependency, a computer-use row gets the `REMOTE_UNSUPPORTED` sentence.
  - A missing or invalid sender device ID, or a missing row ID, gets `REMOTE_BAD_REQUEST`.
  - Valid rows reach the host, and a `call` can come back DETACHED. `communityControlDetachable` is true only for a computer-use `call`.
  - Projects, terminal, ops-request and unknown kinds behave as before.

**Choices made without a design value**
- **In-progress duplicates:** a repeat of a requestId that is still queued or running is answered `REMOTE_UNKNOWN_OUTCOME` with outcome `unknown`, never not-run.
- **Refusals before dispatch:** a runtime refusal raised before anything reached Control is recorded in the ledger as `refused`, with the error code as the reason (for example `remote-loop-target`). The exceptions are blocked-by-person and unsupported (not-run, receiver-off) and device-blocked (not-run, blocked). The reply is an error with outcome `not-run`.
- **Seal failure:** when even a sealed reply cannot be produced, the row gets a fixed, content-free sentence, `COMPUTER_USE_REMOTE_HOST_SEAL_FAILED`. I checked that A's `classifyComputerUseRemoteRefusal` reads it as `REMOTE_UNKNOWN_OUTCOME` for an input and `REMOTE_BAD_ANSWER` for a read.
- **Hello freshness:** hello has no sentAt freshness check. Its sentAt only decides which session replaces which for the same connection.
- **Ledger across restarts:** the ledger is kept in memory only. After a restart the new `bootId` and the session-missing refusal cover it.

**What WP6 must wire in `api-server.ts`** (around lines 29117–29141):
1. Construct the host:
   `new ComputerUseRemoteHost({runtime, respond:(id,r)=>agentDialogueHost.controlRespond(id,r), notice:(t,id)=>agentDialogueHost.communityNotice(t,id), selfDeviceId, deviceName, bundled:IS_BUNDLED_API_SIDECAR, platform:process.platform})`
   - `runtime` is the sidecar's ComputerUseRuntime created with `acceptRemote:true`.
   - Use the `IS_BUNDLED_API_SIDECAR` constant, not the environment variable. The variable is deleted at line 4793.
2. Add `computerUse:(r,f,c)=>host.execute(r,f,c)` to `createCommunityControlExecutor`.
3. The poll currently drops the row ID. Change it to `controlPoll((request,from,controlId)=>executeCommunityControl(request,from,controlId),{detach:communityControlDetachable})`.
4. Call `host.dispose()` at shutdown. The host's 5 s tick starts on its own with the first request and stops when it is empty.

**Not done**
- Full `bun run verify`, `cargo test` and `bun run test:smoke` were not run; only the tests and typecheck listed above.
- The api-server wiring above is WP6's.
- The MCP contract version was not bumped (this is not WP5).
