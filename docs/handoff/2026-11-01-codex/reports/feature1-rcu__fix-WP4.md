# feature1-rcu · fix:WP4

(agent final report, verbatim)

Branch: feat/rcu-wp4, fast-forwarded from ae82c725 to e34cbaf5 with a guarded `git update-ref`. Not pushed, and main was not touched.

Commit: e34cbaf5 "fix(computer-use): WP4 review — raw receipt answers for WP5, prune dead MCP connections, one-step ID reservation, 25 s heartbeats, kept safety net". It ends with the required Co-Authored-By and Claude-Session lines.

Files (all owned by WP4; nothing else was edited):
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-12/src/computerUseRemoteClient.ts
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-12/src/agentDialogueHost.ts
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-12/tests/computer-use-remote-client.test.ts
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-12/tests/agent-dialogue-host.test.ts

All 9 findings are fixed and none were rejected:
1. **HIGH, receipt answers:** a receipt answer is now B's raw `{success, bootId, evictedThroughSentAt, receipt, owner?, guidance?}` plus the device echo, with no verdict from the route. A settled input keeps its raw answer together with the boot that ran it. Every device answer carries `bootId` when known.
2. **Dead MCP connections:** a connection that is silent past `COMPUTER_USE_REMOTE_MCP_ALIVE_MS` and idle is dropped by the client's own unref'd 5 s tick. Its sessions get best-effort disconnects, and `usage()` no longer lists it. New `dispose()`.
3. **Same requestId to two devices:** the check and the reservation happen in one synchronous step, with no await before the send. The second device gets `REMOTE_ID_BOUND_ELSEWHERE`; an open input still gives `REMOTE_BLOCKED_BY_UNKNOWN`. If nothing was sent, the reservation is released.
4. **Route refusals:** any request naming a device now gets an answer with the `device` echo (bad instance, non-UUID device, bad operation, the 64-connection limit). Only a body without a device that is malformed still gets a 400.
5. **Heartbeats:** forwarded 25 s after the last exchange, using the 5 s tick (`COMPUTER_USE_REMOTE_TICK_MS`). The tick stops when the last session closes.
6. **`devices`:** now returns `deviceId` for this Mac.
7. **`labelsSent`:** set only in `onSent`, once a row was written.
8. **`controlRespond`:** the safety net is cleared only after an answer is written. If the write fails, the net stays armed, or is armed again within `CONTROL_DETACHED_RETRY_MS` (1 s) when none was left. New test-only dependency `controlDetachedDeadlineMs`.
9. **New tests:**
   - an old Mac's hello gives `REMOTE_HOST_OUTDATED` and device state `outdated`;
   - the poll's busy sentence settles an input as not-run;
   - the same-ID race to two devices;
   - 25–30 s heartbeat gaps with a 20 s MCP heartbeat;
   - 64 dead connections pruned;
   - labels resent after a refused first call;
   - the detached-row safety net, and the net kept or re-armed when an answer fails to write;
   - a WP5 cross-test that drives `ComputerUseMcpConnection` over the real loopback route (`test.if` on WP5's `session`).

   A mutation check confirmed the safety-net test catches the old behaviour: with clear-before-write restored, it fails (Expected 1, Received 0).

Commands, run on the committed tree e34cbaf5:
- `bun run typecheck`: exit 0.
- `bun test tests/computer-use-remote-client.test.ts tests/agent-dialogue-host.test.ts`: 39 pass, 1 skip, 0 fail (40 tests). The skip is the WP5 cross-test, which has no WP5 code to drive on this branch.
- `bun test tests/agent-dialogue-*.test.ts tests/computer-use-*.test.ts`: 329 pass, 1 skip, 0 fail (330 tests, 30 files).

The same checks with a temporary `git merge --no-commit --no-ff feat/rcu-wp5` (1c7568c2), aborted afterwards so the tree is clean at e34cbaf5:
- `bun test tests/computer-use-remote-client.test.ts`: 22 pass, 0 fail (the cross-test ran and passed).
- `bun run typecheck`: exit 0.
- `bun test tests/agent-dialogue-*.test.ts tests/computer-use-*.test.ts tests/agentstoz-use-mcp-version.test.ts`: 384 pass, 0 fail (32 files).

Left undone or for others:
- **Stale checkout:** feat/rcu-wp4 is also checked out in /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-7, which I couldn't switch into. That checkout's files are still at ae82c725, so `git status` there shows this commit as reverse diffs. Do not commit there with -a; sync it to HEAD first.
- **WP6:** must call `ComputerUseRemoteClient.dispose()` on shutdown.
- **Safety net's own write:** if the net's deadline answer itself fails to write, it is not re-armed (the row stays taken until the database expires it). This was already the case before my change.
- **Contract version:** not bumped; that belongs to WP5.
