# feature1-rcu · build:WP1

(agent final report, verbatim)

WP1 is finished and committed on `feat/rcu-wp1` as `08338919`, branched from main `f3e96658`. It has no dependency branches, so nothing was merged. Typecheck passes, the full test suite has 0 failures, and nothing was pushed.

**Files** (all new, no other files touched):
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-1/src/computerUseRemoteProtocol.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-1/src/computerUseRemoteCrypto.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-1/tests/computer-use-remote-protocol.test.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-1/tests/computer-use-remote-crypto.test.ts`

**What's in it**
- **Protocol module:** It has no Node built-ins, so the MCP process and the panel can import it too.
  - **Envelopes:** the five request shapes and their replies are checked against exact key sets, box size, seq range (hello is 0, others 1 to the largest safe integer) and platform (`darwin`, `win32`, `other`).
  - **Limits:** all §8.7 values sit in one constant. It also has the sentAt check (more than 12 s late or 5 s early is not run), with 12 s and 5 s themselves allowed.
  - **Error codes:** the §10 codes have fixed sentences. Per D11 there is no `REMOTE_POINTER_DISABLED`, and a test asserts it stays absent.
  - **Reading the other Mac's answers:** the old executor's sentence maps to `REMOTE_HOST_OUTDATED`. The "busy" sentence maps to not-run. The execution-deadline sentence makes an input's outcome unknown and is a plain failure for a read.
  - **`remoteReceiptVerdict`:** `unseen` counts as "not run" only with the same bootId, no evicted entry at or after that sentAt, and inside sentAt + 10 min. `evicted` and a bootId mismatch are always unknown-final.
- **Crypto module:**
  - **Keys:** P-256 key agreement reuses the relay's key helpers, then HKDF under `agentstoz.computer-use.remote/v1` gives one AES-256-GCM key per direction.
  - **Nonce and AAD:** the nonce is a direction tag plus seq. The AAD is `v1|session|seq|sentAt|from|to|instance|platform|op`.
  - **Replay protection:** each seq is sealed once. The receiver accepts only increasing seqs, and a box that fails to open does not use up the seq.
  - **Payload format:** the plaintext is a binary frame (meta up to 60 KB plus raw JPEG up to 240,000 bytes). Large replies split into at most two parts of 210,000 characters.

**Verification**
- New WP1 tests: `bun test --cwd tests computer-use-remote-protocol computer-use-remote-crypto` → 48 pass, 0 fail.
  - They cover every item on the WP1 test list.
  - The worst case measured exactly 400,028 characters in 2 parts. Both answers fit under 262,144 bytes, measured as the database's `octet_length(jsonb::text)` in PGlite. A full 16,000-byte request fits under 65,536.
  - A test pins the "busy" sentence to its exact text in `src/agentDialogueHost.ts`.
  - I deliberately broke three rules one at a time: dropping platform from the AAD, `>=` changed to `>` in the eviction check, and removing the replay re-check. Each broke at least one test, and the code was restored.
- `bun run typecheck` → exit 0.
- Related existing tests: `bun test --cwd tests --max-concurrency=1 computer-use agent-dialogue remote-control-relay-crypto ops-request` → 363 pass, 0 fail, 34 files.
- Full suite: `PATH="/usr/bin:$PATH" bun run test` → 9853 pass, 12 skip, 0 fail, 1110 files.
- I ran `bun install` because `node_modules` was missing.

**Additions beyond the design, for WP3/WP4/WP5**
- Three codes not in §10:
  - `REMOTE_SESSION_MISSING`: the other Mac's "no session" refusal. WP4 should run hello again for reads and report `REMOTE_SESSION_RESTARTED` for inputs.
  - `REMOTE_BAD_REQUEST`: the other Mac rejected the envelope as malformed.
  - `REMOTE_BAD_ANSWER` and `REMOTE_NOT_RUN`: an unusable answer, and a not-run receipt.
- `classifyComputerUseRemoteTransportFailure` needs a `sent` flag from WP4's `onSent`. Before the row is confirmed written, only the database's own refusal tokens (busy, not in community and similar) count as not-run. A network error may still have written the row, so for an input it stays unknown.
- The receipt answer the other Mac returns must be `{bootId, evictedThroughSentAt, receipt}`, plus optional `success`, `owner`, `guidance`. WP3 should build it with `computerUseRemoteReceiptAnswer()`, which runs the same parser WP4 uses.

**Left undone or for others**
- WP2 is running concurrently and will write its own sentences for the terminal/remote-desktop refusals in the runtime. The `REMOTE_LOOP_TARGET` and `REMOTE_DESKTOP_CLIENT` wording in my table may need to be made to match in WP6/WP8.
- Design §8.5 still says remote scroll, drag and right-click are refused. That is outdated under D11, so WP5 should not copy it into the tool description.
- I did not touch the MCP contract version.
