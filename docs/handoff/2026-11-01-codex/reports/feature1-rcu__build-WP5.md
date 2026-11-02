# feature1-rcu · build:WP5

(agent final report, verbatim)

English translation: Finish WP5 (MCP surface 1.76.0 for AI computer use between community Macs, with no Workroom), verify it, commit it on the branch, and report.

WP5 is committed on `feat/rcu-wp5` as `bfe3ccaf` and not pushed. Every check below passed, but nothing can reach another Mac yet because the route it calls is WP4/WP6 work that does not exist; until then, calls with `device` get `AGENTSTOZ_USE_HOST_OUTDATED`.

**Branch and commits**
- `feat/rcu-wp5`, branched from main. It merges `feat/rcu-wp1` (`cbfa6e8e`) and `feat/rcu-wp2` (`3c2cc4a0`), then adds the WP5 commit `bfe3ccaf`. The commit message ends with the two required attribution lines.

**Files changed** (all owned by WP5; nothing else was edited)
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-8/src/computerUseScopeMcp.ts`
  - New tool text: 1,990 characters, with the rules for another Mac first (they end at character 732).
  - New `device` field (uuid), `devices` operation and `observe` `capture` field.
  - `computerUseScopeMcpCall`, which takes `device` off before the existing closed parser.
  - `COMPUTER_USE_REMOTE_AGENT_PATH`, whose comment documents the route contract.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-8/src/computerUseMcp.ts`
  - `ComputerUseMcpConnection.session` routes each call to this Mac, the device list, or another Mac.
  - Binding table (15 minutes): `REMOTE_ID_BOUND_ELSEWHERE` when a grant or requestId is used somewhere else. A receipt for an ID this connection never sent is not asked about; it answers `unknown-final` with reason `not-this-connection`.
  - Unknown-outcome ledger: it blocks new input to that device and still allows reads. Only a settled `remoteReceiptVerdict` releases an entry. Inputs to one device run one at a time.
  - These input cases become `REMOTE_UNKNOWN_OUTCOME` and enter the ledger: a lost answer, a mismatched echo, a failure that does not claim not-run, and a success with no receipt or a receipt for another requestId.
  - A read with a mismatched echo is discarded.
  - A 404 is `AGENTSTOZ_USE_HOST_OUTDATED`, and nothing runs on this Mac instead.
  - Heartbeat and disconnect cover remote sessions too.
  - `computerUseMcpResult` now sets `isError` when `success` is false. Old local paths are unaffected, because the local request still throws on failure.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-8/agentstoz-use-mcp-server.ts`
  - New `computerUseRemoteHttpRequest`, which sends the profile, instance and client headers plus the Workroom caller headers, with a 45 s limit (devices and heartbeat 15 s, disconnect 2 s).
  - New `sendComputerUseRemote`.
  - The scope tool now goes through `session()`.
  - The MCP server instructions are unchanged.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-8/src/agentstozUseMcpVersion.ts`: version 1.76.0. The comment explains the not-run, unseen, in-progress, evicted and unknown-final states.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-8/tests/agentstoz-use-mcp-version.test.ts`: now expects 1.76.0.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-8/tests/computer-use-scope-mcp.test.ts`: 15 new tests. This file is already listed in `scripts/check-native-workflow.ts`.

**Commands and results**

| Command | Result |
|---|---|
| Before any change: `bun test` on `tests/computer-use-scope-mcp.test.ts`, `tests/agentstoz-use-mcp-version.test.ts`, `tests/computer-use-access-switch.test.ts`, `tests/ops-worker-tool-approval.test.ts` | 27 pass, 0 fail |
| `bun test tests/computer-use-scope-mcp.test.ts` (final) | 21 pass, 0 fail, 198 expect() calls |
| `bun run typecheck` (`tsc --noEmit`) | exit 0 |
| `PATH="/usr/bin:$PATH" bun test tests/computer-use-*.test.ts tests/agent-dialogue-*.test.ts tests/agentstoz-use-mcp-version.test.ts tests/agentstoz-use-mcp-stdio.test.ts tests/agentstoz-use-control.test.ts tests/workroom-shared-shell-contract.test.ts tests/ops-worker-tool-approval.test.ts` | 393 pass, 0 fail, 4967 expect() calls, 35 files |
| `PATH="/usr/bin:$PATH" bun test` on the 42 other test files that import the changed modules (`tests/agentstoz-mcp-launch-flow.test.ts`, `tests/ops-request-mcp.test.ts`, `tests/workroom-team-*.test.ts`, `tests/common-memory*.test.ts` and others) | 488 pass, 0 fail, 4176 expect() calls |

- **Typecheck:** the first run reported 3 type errors in the new test file: a possibly-undefined array index, and `jest.advanceTimersByTime`, which Bun's bundled types do not declare. I fixed them in the test only; no assertion was weakened.
- **Mutation checks:** for each check I disabled one rule, ran the scope test file, and restored the original (confirmed with `cmp`). Every mutation made tests fail:

  | Rule disabled | Failing tests |
  |---|---|
  | Ledger block on new input | 2 |
  | Treat failures that claim no outcome as not-run | 1 |
  | Skip asking about IDs this connection never sent, plus the binding check | 1 |
  | 404 handling, plus treating `unseen` as positive | 2 |
  | "An input answer must be its own receipt" | 1 |

**1.76.0 collision check:** main and the main checkout are at 1.75.0. `git log --all -S"'1.76.0'" -- src/agentstozUseMcpVersion.ts` finds nothing, and no other worktree's `src/agentstozUseMcpVersion.ts` is at 1.76 or higher.

**Contract WP4/WP6 must implement** at `/api/computer-use-agent/remote` (documented at `COMPUTER_USE_REMOTE_AGENT_PATH`):
- **Request bodies:** `{operation:'devices'|'heartbeat'|'disconnect'}`, or `{device, ...closed scope-* request}`.
- **Every answer to a body with `device`:**
  - echoes `device` in lower case and carries the target's `bootId` (32 hex characters);
  - on failure, is `{success:false, device, code?, outcome?, error}`, where `outcome` is `not-run`, `unknown`, `state-unknown` or `read`.
- **Input success:** must carry `receipt.requestId` equal to the request's requestId.
- **`scope-receipt` answers:** carry `bootId`, `evictedThroughSentAt` and `receipt`, with `owner` and `guidance` optional.
- **`devices` answer:** `{success:true, deviceId:<this Mac>, devices:[{deviceId|device, endpointId, ...}]}`.

**Left undone**
- **Remote route:** the handler and its api-server wiring belong to WP4/WP6 (the `feat/rcu-wp4` branch has only merges so far).
- **Docs:** belong to WP8.
- **Codes not in WP1's error table:**
  - `AGENTSTOZ_USE_HOST_OUTDATED` and `AGENTSTOZ_USE_HOST_UNAVAILABLE` are local to the MCP process, with their own Korean messages;
  - `REMOTE_NOT_RUN` is a fallback used when a route failure that is believed not-run has no code.
- **Not tested end to end:** there is no test against a real route or between two real Macs.
- **Not run:** full `bun run verify`, `cargo test` (no Rust changes) and the smoke tests.

Nothing was pushed. Nothing on main or in the main checkout was changed, and the installed app's sidecar on port 3001 was not called.
