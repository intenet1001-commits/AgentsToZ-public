# feature1-rcu · fix:WP1

(agent final report, verbatim)

I fixed all five findings on `feat/rcu-wp1` in commit `47cc1b24`, on top of `08338919`. The package tests, typecheck and related suites all pass. I partly disagreed with the arithmetic in finding 5 and skipped the optional HKDF change (both explained below).

**Branch:** `feat/rcu-wp1` was already checked out in the original builder's worktree (`/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-1`), so a plain checkout was refused. I used `git checkout --ignore-other-worktrees feat/rcu-wp1`. That other worktree still sits at `08338919`, so its files are now one commit behind the branch. Nothing was pushed, and main was not touched.

**Files changed (WP1-owned only):**
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-5/src/computerUseRemoteProtocol.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-5/src/computerUseRemoteCrypto.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-5/tests/computer-use-remote-protocol.test.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-5/tests/computer-use-remote-crypto.test.ts`

**Fixes:**
1. **Bad receipt answer stuck on "pending":** `remoteReceiptVerdict` now returns pending for a bad answer only inside sentAt + 10 min. After that it is `unknown-final('window-passed')`. Passing `undefined` (the receipt call itself failed) follows the same rule. New tests cover sentAt + 10 min, sentAt + 1 h, an extra key, a boxed `{error}`, and a NaN clock.
2. **Nonce reuse across channels:** `establish` now accepts a private key only once, and only if `generateComputerUseRemoteKeyPair` made it. It uses a module-level `WeakSet`, claims the key before any await, and a failed attempt also uses the key up. Anything else gets the new code `KEY_NOT_FRESH`. A `structuredClone` of the key is also refused (Bun makes a new CryptoKey object). The doc now says every hello needs a fresh key pair. Tests cover the reproduction, a clone, a foreign key, two concurrent attempts, a failed-then-retried attempt, and the receiver side.
3. **Wrong outcome for state-changing operations:**
   - New `computerUseRemoteEffect(operation)` sorts requests into input / state-change / read:
     - state-change: `scope-request-access`, `scope-request-human` and `disconnect`;
     - read: status, observe, capture, receipt, hello and heartbeat;
     - an unknown operation counts as an input.
   - New outcome `'state-unknown'` with code `REMOTE_STATE_UNKNOWN`. Its message says a grant may have opened or halted, nothing was resent, and to read status. It does not block input.
   - `REMOTE_PART_LOST` now means the call's reply was lost: `read` for a read call (matching the §10 table), open otherwise, never `not-run`. Any failure of a part request is classified this way.
   - A new test check asserts that every classified result's outcome matches its code's table entry.
4. **`part.seq`:** pinned in the protocol module as the seq of the call whose reply it fetches. It is unsealed, orders nothing, and never moves `lastRequestSeq`. New helpers: `computerUseRemotePartRequest(call, ref, sentAt)` for A, and `computerUseRemotePartMatches(part, {session, seq, ref})` for B. Tests run end to end through a real two-part reply.
5. **Sender forgetting late answers:** the sender now keeps unopened replies by age, `COMPUTER_USE_REMOTE_REPLY_MEMORY_MS` (= `lateAnswerMemoryMs`, 10 min), using an optional `clock` on `establish`. The count bound is now 8,192 and is only a memory limit. The receiver keeps its count bound of 256. A test seals 599 unopened requests and the late reply still opens, then shows it is forgotten after 10 min.
   - Where I disagree: the old set held only *unopened* seals, because opening a reply deletes its entry. So the cap is reached only by 256 replies that were never opened, not 256 seals of any kind. The finding was still worth fixing, because the limit was count-based rather than tied to the late-answer window.

**API changes WP4/WP5 must follow:**
- The classifiers now take `{operation, part?, requestId?}` instead of `{input}`.
- `ComputerUseRemoteOutcome` gains `'state-unknown'`.
- There is a new crypto error `KEY_NOT_FRESH`.
- No other branch uses these yet: `feat/rcu-wp2` does not import WP1.

**Verification (all run in this worktree):**
- `bun test tests/computer-use-remote-protocol.test.ts tests/computer-use-remote-crypto.test.ts`: 56 pass, 0 fail (1,561 expects).
- Mutation checks: I put each defect back one at a time (bad answer always pending, key check removed, state changes read as reads, PART_LOST as `not-run`, 256 count bound, fresh seq for a part). Each one made the new tests fail (1, 1, 8, 1, 1 and 2 failures). I restored the files and confirmed them byte-identical to the fixed versions.
- `bun run typecheck`: exit 0.
- `bun test tests/computer-use-*.test.ts tests/agent-dialogue-*.test.ts tests/remote-control-relay-crypto.test.ts`: 312 pass, 0 fail across 30 files.

**Left undone:**
- I did not bind both public keys into the HKDF info (the optional part of finding 2). The same keys give the same shared secret either way, so it would not prevent the reuse case, and §8.2 fixes the info string exactly.
- The design document (owned by WP8) should add `REMOTE_STATE_UNKNOWN` and the `state-unknown` outcome to §10, and the `part.seq` rule to §8.1. It also still carries the pre-D11 pointer-refusal wording in §8.5 and §12, as the review noted.
- I did not run `bun run verify` or the tester/persona profiles, and I did not touch the local API on port 3001.
