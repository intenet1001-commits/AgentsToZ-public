# feature1-rcu · review:WP4

(agent final report, verbatim)

English translation: Review the WP4 branch (the A-side sending client and mailbox extensions) against the design, security rules, CLAUDE.md and test honesty, and return "no defects" or a ranked list of defects (file:line, why, fix).

**Result: 9 defects, ranked.** Line numbers refer to commit `ae82c725`. Everything passes as committed: the WP4 and WP1 suites (87 pass, 0 fail), the related suites (354 pass, 0 fail) and `bun run typecheck` (exit 0). I ran probe tests that confirmed #1, #2 and #3, then removed the temporary worktree; main is clean.

1. **HIGH — receipt answers don't fit WP5, so an unknown outcome can never be settled.**
   - Where: `src/computerUseRemoteClient.ts:426-446` (`receipt`), `:700-710` (`receiptAnswer`, `notRunAnswer`, `unknownFinalAnswer`), `:353` (call answer).
   - Why: the receipt answer is a ready-made verdict (`{success, receipt, verdict, settled, guidance, device, deviceId}`) with no `bootId` or `evictedThroughSentAt`. No call answer carries B's `bootId` either.
   - DESIGN §6 puts the unknown-outcome ledger and `remoteReceiptVerdict` in the MCP process. `feat/rcu-wp5` (`src/computerUseMcp.ts` `remoteReceipt`) rebuilds `{bootId, evictedThroughSentAt, receipt}` from the route answer. The probe showed `parseComputerUseRemoteReceiptAnswer` returns null on WP4's answer.
   - Effect: the MCP returns `REMOTE_BAD_ANSWER` and keeps the entry open. Every unknown input therefore blocks that device for 10 minutes and ends `unknown-final`, even when B confirmed it. `unseen` can never become not-run, because the MCP never learns a bootId. It fails safe, but G4 and §7.8 are broken end to end.
   - Fix: for a receipt, return B's own receipt answer fields (`bootId`, `evictedThroughSentAt`, `receipt`, `owner`, `guidance`) plus the echo. Store that answer in the binding so stored and late answers reuse it. Add `bootId: session.bootId` to every device answer. Add a test that feeds this route's answers into WP5's `ComputerUseMcpConnection`.

2. **MEDIUM — connections from MCP processes that died are never pruned, which eventually blocks all new connections.**
   - Where: `:745-752` (`prune`), with the 64-connection limit at `:735-737`.
   - Why: if an MCP process dies without sending `disconnect` (killed or crashed; WP5 only closes on a clean stdin end), its `link.session` stays set. `prune` counts any open session as "holding", so the connection is never removed.
   - Effect: once 64 of these pile up over the sidecar's lifetime, every new MCP connection gets `REMOTE_RATE_LIMITED` until the sidecar restarts. Probe: 64 connections, clock moved 6 h, then a new instance was refused. `usage()` also lists these sessions forever, so the panel keeps showing them as in use.
   - Fix: treat a connection whose `mcpHeartbeatAt` is older than `COMPUTER_USE_REMOTE_MCP_ALIVE_MS` and whose `seenAt` is idle as dead. Close its sessions (best-effort disconnect) and drop it. Or, at the limit, evict the least recently seen idle connection.

3. **MEDIUM — a race lets new input reach a device while an earlier input there is still unknown (RC-7).**
   - Where: `:341-344` (the bound check runs outside the per-device queue) and `:382-385` (`connection.bindings.set` overwrites).
   - Why: two concurrent inputs with the same requestId to two devices both pass the bound check and both go out. The second overwrites the first's open entry.
   - Effect: the probe then sent a new click to device 1, and B ran 2 clicks, while `req-race-1`'s outcome there was still unknown. WP5's ledger is also keyed by requestId and has the same gap between check and bind.
   - Fix: inside the queued work in `call()`, check the binding again. Refuse with `REMOTE_ID_BOUND_ELSEWHERE` if it belongs to another device, and refuse with `REMOTE_BLOCKED_BY_UNKNOWN` rather than overwrite an unsettled binding.

4. **LOW-MEDIUM — refusals at the route level carry no `device` echo.**
   - Where: `:251-268` and `:870-873`.
   - Why: a bad instance, the 64-connection limit, an unknown operation and a non-UUID `device` all throw before `echo` exists. They are answered as HTTP 400 `{success:false, code, outcome:'not-run'}` without `device`.
   - Effect: WP5 only believes "not run" when the echo is present. For an input it records `REMOTE_UNKNOWN_OUTCOME` and blocks the device for 10 minutes, although nothing was sent. This makes #2 worse.
   - Fix: read `device` first and echo it on every refusal of a device request, for example by moving `connection()` inside the try in `deviceRequest`.

5. **LOW — heartbeats go out every 40 s, not 25 s.**
   - Where: `:308-321` with `heartbeatForwardMs` 25 s.
   - Why: forwarding is driven only by WP5's 20 s MCP heartbeat. The "≥25 s since the last exchange" check skips every other beat, so forwarding happens every 40 s, and the first can come about 45 s after the last exchange.
   - Effect: one lost heartbeat leaves a gap of about 80 s, longer than B's 75 s lease, so B ends the grant. DESIGN §7.7 and §8.7 expect 25 s, enough for three chances inside the lease. The builder listed the WP6 timer as remaining work, but the code comment presents the MCP's 20 s heartbeat as sufficient.
   - Fix: run a 5 s unref'd timer in the client, or lower the threshold to 25 s minus the MCP interval. Test with a 20 s MCP heartbeat.

6. **LOW — the `devices` answer names this Mac `self`, but WP5 reads `body.deviceId`.**
   - Where: `:275-283`.
   - Effect: when the AI names this Mac's own device, the MCP answers `REMOTE_DEVICE_UNKNOWN` instead of `REMOTE_SELF` ("이 Mac은 device 없이 쓰세요").
   - Fix: also return `deviceId`, or align WP5.

7. **LOW — B can lose the label information for a whole session.**
   - Where: `:463-472`.
   - Why: `session.labelsSent=true` is set before the row is written. If the first call is never sent (rate limit in `reserveRow`, or the source endpoint changed), `client` and `host` never reach B.
   - Effect: B's grant label, shown in Control as 「중단: …」, lacks them for that session.
   - Fix: set `labelsSent` only after `onSent`.

8. **LOW — `controlRespond` drops the safety net too early.**
   - Where: `src/agentDialogueHost.ts:858-866`.
   - Why: it clears the detached row's safety-net timer before the answer is written. If both `control-respond` attempts fail, the row stays `taken` with no answer.
   - Effect: the sender waits its 20 s, and the row holds the sender's 64-row quota for 10 minutes.
   - Fix: clear the timer only after a successful respond, or re-arm it on failure.

9. **Test honesty — coverage is overstated.** The report says all seven required WP4 cases are covered, but DESIGN §15 (WP4) also asks for these, and the client tests don't exercise them:
   - an older Mac's sentence on hello becoming `REMOTE_HOST_OUTDATED` and device state `outdated`;
   - the poll's "바빠" sentence settling an input as not-run.

   Also:
   - The 25 s safety net for detached rows has no test (the builder disclosed this).
   - No test runs WP4's route answers through WP5's MCP connection, which would have caught #1, #4 and #6.

   Fix: add those tests.

No breach of RC-5 (plaintext in database rows) or D11 (remote pointer allowed) found in WP4's own code.
