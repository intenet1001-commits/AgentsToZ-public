# feature1-rcu · build:WP4

(agent final report, verbatim)

English translation: (No user request this turn; the workflow harness assigned WP4, the A-side sending client and mailbox extensions for cross-Mac computer use. This is the final report.)

WP4 is finished and committed on `feat/rcu-wp4`. The WP4 tests, the related test files and `bun run typecheck` all pass. Nothing was pushed.

**Branch and commits**
- Branch: `feat/rcu-wp4`, made from `main`, with `feat/rcu-wp1` merged in first (merge commit `3ef1ab39`).
- Commit `ae82c725` "feat(computer-use): A-side remote client and mailbox extensions (WP4)", ending with the required two trailer lines.
- The working tree is clean.

**Files** (all owned by WP4; nothing outside WP4 was changed)
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-7/src/computerUseRemoteClient.ts` (new): the sending side.
  - Exports the route path `COMPUTER_USE_REMOTE_AGENT_PATH`, the handler `handleComputerUseRemote`, the class `ComputerUseRemoteClient`, and the reply helpers WP3 can use (`computerUseRemoteReplyFrame`, `computerUseRemoteErrorFrame`, `parseComputerUseRemoteReplyContent`).
  - Covers: one serialized session per (MCP connection, target device), pinned to the endpoint that opened it; an input whose result is unknown is never resent and blocks further input until a receipt, a late answer, a restart of the other Mac or the 10-minute window settles it; the per-device mailbox limits; heartbeat forwarding; the OPS-worker and chain guards; the device list.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-7/src/agentDialogueHost.ts`:
  - `controlCall` now reports `onSent({controlId, sourceEndpointId, targetDeviceId})`. Given an expected source endpoint that no longer matches, it refuses with `AGENT_DIALOGUE_CONTROL_SOURCE_CHANGED` before writing any row.
  - New `controlSource`, `controlResult(controlIds, sourceEndpointId)`, `controlRespond` and `communityNotice(text, requestId)`.
  - `controlPoll(execute, {detach})`: a detached row is answered later through `controlRespond`; if nothing answers within 25 s, a safety net sends the deadline sentence. `bg:1` rows are no longer counted in `handled`.
  - Existing callers of `controlPoll` compile unchanged.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-7/tests/computer-use-remote-client.test.ts` (new): 15 tests. All seven required WP4 cases are covered, plus two tests with two real hosts over the real mailbox SQL in PGlite:
  - a late answer collected through the endpoint that sent it, after this Mac's endpoint changed;
  - a receipt asked over a new session that reads the other Mac's ledger.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-7/tests/agent-dialogue-host.test.ts`: 3 new tests:
  - a detached row is answered by `controlRespond`, not by the poll, and `bg:1` rows are not counted;
  - a changed source endpoint is refused before any row, and `controlResult` reads only through the endpoint that sent the row;
  - `communityNotice` posts only once per requestId.

**Commands and results** (run on the committed tree)

| Command | Result |
|---|---|
| `bun test tests/computer-use-remote-client.test.ts tests/agent-dialogue-host.test.ts` | 31 pass, 0 fail |
| `bun test tests/computer-use-*.test.ts tests/agent-dialogue-*.test.ts tests/community-*.test.ts tests/ops-request-*.test.ts` | 354 pass, 0 fail, 36 files |
| `bun run typecheck` | exit 0 |

**Left undone**
- **Not wired yet (WP6):** nothing mounts `handleComputerUseRemote` in `api-server.ts` yet. The other pieces to wire are the `controlPoll` `detach` option on the receiving side, a timer that calls `client.forwardHeartbeats()`, `incomingRemoteGrant` set from WP2's `hasIncomingRemoteGrant`, and the OPS-worker hint.
- **Request/answer shape to agree with WP5 and WP3:** I could not open the WP5 worktree from this sandbox, so I defined the shapes myself. They are in the module header of `computerUseRemoteClient.ts`.
  - Request: scope-namespace body plus `device`, or the operations `devices` / `heartbeat` / `disconnect`.
  - Answer: always echoes `device`; an input with an unknown result answers `code:'REMOTE_UNKNOWN_OUTCOME', state:'unknown', requestId`.
  - Reply inside the sealed box: success carries the JPEG as raw bytes, refusals are `{success:false, error, code?, outcome}`. Only `not-run` is trusted as sent; anything else is treated as the worst case for that kind of request.
- **Restart of this Mac's sidecar:** if it restarts while the MCP process stays up, a receipt for an ID sent before the restart answers `unknown-final` without asking the other Mac. That is safe (nothing is resent or wrongly reported as not run) but less exact than it could be.
- **Not verified:**
  - The detached-row safety net firing after 25 s has no test, to keep the suite fast.
  - I did not run the project tester reconciliation, because it calls 127.0.0.1:3001, which the task forbids. The tester and persona sets did not run either.
  - The full `bun run verify` (including Rust) was not run.
  - I did not read `docs/claude/computer-use.md` or `docs/claude/community.md` directly; I relied on DESIGN.md and the code.
- I did not bump the MCP contract version.
