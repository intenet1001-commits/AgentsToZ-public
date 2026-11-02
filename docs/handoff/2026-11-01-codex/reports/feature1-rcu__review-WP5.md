# feature1-rcu · review:WP5

(agent final report, verbatim)

English translation: Review WP5 on `feat/rcu-wp5` against the design, security, CLAUDE.md rules and test honesty, then return "no defects" or a ranked list of defects (file:line, why, fix).

I found 5 defects, most serious first. Throwaway probe tests confirmed #1 to #3.

**1. Medium-high: a check-then-bind race breaks the binding table and the unknown-outcome ledger (RC-7).** `src/computerUseMcp.ts:123`, `:126`, `:136`, `:275`, `:92`/`:142`
- **Why:** `remoteSession` checks `boundElsewhere` at :123, then waits in the per-device lane (:126). The grant and requestId are only bound later, inside `remoteSend` (:136). When `bindRequest` (:275) finds an existing binding, it updates `sentAt` but keeps the old target. The ledger is keyed by requestId alone (:142).
- **Probe (a):** an input with requestId R to B waits in B's lane behind another input. Meanwhile a local input with the same R binds R to this Mac. The remote R is then still sent to B, and its unknown outcome is ledgered for B. Every `receipt {device:B, requestId:R}` is refused with `REMOTE_ID_BOUND_ELSEWHERE`. The ledger can only be cleared by a receipt verdict, so all later input to B stays `REMOTE_BLOCKED_BY_UNKNOWN` until the MCP process restarts. R also ran on both Macs.
- **Probe (b):** two parallel inputs with the same R go to B and C. Both are sent, and C's ledger entry overwrites B's. B is unblocked while its outcome is still unknown, and the next input to B was sent.
- **How likely:** an AI that runs two Macs in parallel with a counter per Mac would produce exactly these duplicate IDs.
- **Fix:**
  - Claim the grant and requestId in `remoteSession` right after the check, before any await or lane. Or check `boundElsewhere` again inside the lane, right before `bindRequest`.
  - Make `bindRequest` refuse when the existing binding points somewhere else.
  - Key the ledger by device and requestId, or refuse a requestId that is already open.
  - Add a concurrency test.

**2. Low-medium: the route's `outcome` field wins over a stricter `code`.** `src/computerUseMcp.ts:164`
- **Why:** when an input answer carries both a known `code` and an `outcome`, the `outcome` is used even if it is weaker.
- **Probe:** `{success:false, device, code:'REMOTE_UNKNOWN_OUTCOME', outcome:'not-run'}` reaches the AI as `REMOTE_UNKNOWN_OUTCOME` with outcome `not-run`. It is not ledgered and the device is not blocked. Only the route's consistency (WP4) prevents this.
- **Fix:** use the stricter of `body.outcome` and `COMPUTER_USE_REMOTE_ERRORS[code].outcome`. For an input, never accept `not-run` when the code's own outcome is open.

**3. Low: a 404 is read as "host outdated" even when the route echoed the device.** `src/computerUseMcp.ts:246`
- **Why:** a 404 whose body echoes `device` but carries a code missing from WP1's table becomes `AGENTSTOZ_USE_HOST_OUTDATED` (not-run). That holds even for an input that may already have been sent (probe confirmed). An old sidecar's real 404 is `{error:"Not found"}` with no echo (`api-server.ts:29077`).
- **Fix:** treat a 404 as host outdated only when the body has no `device` field. Otherwise use the normal open-outcome path.
- **Test gap:** the tests reach the 404 only through `devices`, never with a `{device, ...}` scope body.

**4. Low: the 1.76.0 contract comment is missing codes the MCP returns to the AI.** `src/agentstozUseMcpVersion.ts:109-127`
- **Why:** it omits `REMOTE_BAD_ANSWER`, `REMOTE_NOT_RUN`, `REMOTE_SESSION_MISSING`, `REMOTE_BAD_REQUEST` and `AGENTSTOZ_USE_HOST_UNAVAILABLE`. Design §8.5 asks for the remote codes to be named there.
- **Fix:** add them.

**5. Low (judgment call): the shortened tool text dropped an anti-overclaim rule.** `src/computerUseScopeMcp.ts:20-46`
- **Why:** it dropped "Do not claim a dispatched event proved the intended UI result; observe it." It also dropped "or the approved app" from where typed text goes. With remote steps taking 1 to 3 s and `dispatched-unverified` receipts, that rule matters more.
- **Fix:** trim elsewhere to bring it back; only 10 characters of the 2,000 budget remain.

**Checks I re-ran and confirmed:**
- In the temporary worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/rv-rcu-WP5` (now removed):
  - `tests/computer-use-scope-mcp.test.ts` plus the version test: 25 pass, 0 fail.
  - The builder's 35-file set: 393 pass, 0 fail.
  - `tsc --noEmit` exited 0.
- The tool text is 1,990 characters, and the rules for another Mac end at character 732.
- No other branch or worktree uses 1.76.0.
- `/api/computer-use-agent` is matched exactly (`api-server.ts:16991`), and unknown paths fall through to the 404, so "old app → `AGENTSTOZ_USE_HOST_OUTDATED`" holds.
- The test file has 16 new tests, not the 15 the builder reported (5 before, 21 after).

The probe test files are kept at `/private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/zz-review-probe.test.ts` and `/private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/zz-review-probe2.test.ts`.
