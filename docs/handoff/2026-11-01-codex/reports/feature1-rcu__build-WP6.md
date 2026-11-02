# feature1-rcu · build:WP6

(agent final report, verbatim)

WP6 is committed on `feat/rcu-wp6` (not pushed). Typecheck and every test run below pass with 0 failures. One file outside WP6's owned list was added: `src/computerUseRemoteSidecar.ts`.

**Branch:** `feat/rcu-wp6`, in worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-16`. It is main plus the merges of wp2, wp3 and wp5 (wp4 comes in through wp3). Nothing was committed to main, and the main checkout was not touched.

**Commit:** `5bd40cb0` "feat(computer-use): wire remote computer use into the sidecar and test two hosts end to end (WP6)", with the required trailer.

**Files:**
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-16/api-server.ts` (owned, +52/-5):
  - Turns on receiving from other Macs and the remote settings file `computer-use-remote.json`.
  - The community executor's `computerUse` and the poll's `detach` option now go to the new sidecar module.
  - New route `/api/computer-use-agent/remote`. It uses the agent route's checks: no Origin plus the profile token. It also passes the OPS worker guard (from the Workroom caller hint) and the caller's host-app label.
  - `/api/agent-dialogue/control` refuses kind `computer-use` before it calls `controlCall`.
  - Shutdown now disposes the remote module.
  - Phone forwarding is unchanged.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-16/src/computerUseRemoteSidecar.ts` (new, not on the owned list):
  - I added it so the two-host test runs the same wiring factory that api-server ships, rather than a copy of it.
  - It contains `createComputerUseRemoteSidecar` and `computerUseRemoteReceives` (true only for the bundled sidecar on darwin, and it reads no environment variables). It also has `refuseCommunityControlComputerUse` and the per-instance cache for the caller's host-app label.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-16/tests/computer-use-remote-two-host.test.ts` (owned, new, 9 tests): PGlite with the real AGENT_DIALOGUE_SQL, two sidecar hosts with injected identities and a fake native channel. Coverage of the eight WP6 cases:
  1. hello, status, request-access, observe plus capture at worst size, checked against the real 262,144 limit; then click, type-text and receipt.
  2. After a timeout the receipt settles as not-run/unseen in the same boot.
  3. A late answer is read through the endpoint that sent it, after A's endpoint changes. The same requestId on two MCP connections does not collide.
  4. B restart gives unknown-final. After B leaves, the next request fails at once and no row is written. An old B gives `REMOTE_HOST_OUTDATED`. Non-bundled and win32 hosts are refused.
  5. A stuck Control on B does not delay another device's terminal row.
  6. DB row bodies carry no plaintext coordinates, text, image bytes or AI field names.
  7. Exactly one community notice.
  8. The general call refuses computer-use; phone forwarding is unchanged.

  Further tests cover the sending route's chain guard, its 403, and source-wiring checks on `api-server.ts`. D11 is applied: there is no `REMOTE_POINTER_DISABLED`.

**Commands run on the final tree** (all with `PATH="/usr/bin:$PATH"`, from the worktree):
- `bun run typecheck`: exit 0.
- `bun test tests/computer-use-*.test.ts tests/agent-dialogue-*.test.ts tests/community-*.test.ts tests/agentstoz-use-mcp-version.test.ts`: 436 pass, 0 fail, 6810 expect() calls, 38 files.
- `bun test tests/agent-runtime-api-server-wiring.test.ts tests/local-api-shutdown.test.ts tests/workspace-lease-recovery-wiring.test.ts tests/mobile-workspace-attachments.test.ts tests/ops-request.test.ts tests/ops-request-edge.test.ts tests/ai-terminal-activity.test.ts tests/workroom-effort-workspace.test.ts tests/onboarding-cloud-effects.test.ts tests/ops-request-mcp.test.ts tests/agentstoz-use-mcp-stdio.test.ts`: 139 pass, 0 fail, 947 expect() calls, 11 files.
- Earlier in the session, `bun test tests/computer-use-remote-two-host.test.ts` passed 9/0 (274 expects) four times in a row.

No test touched 127.0.0.1:3001 (the stdio test binds port 0), production Supabase, real desktop input or TCC. The MCP contract version was not bumped, and `bun run verify` and `cargo test` were not run.

**Left undone:**
- Sending side (A): nothing exposes `usage()` / `closeDevice()` over a route yet. WP7's panel lines need them: "이 Mac의 AI가 <기기>를 사용 중" and "끊기". Adding that route needs `api-server.ts` plus the Tauri `lib.rs` allowlist, so it is left for integration.
- The host-name map in `src/computerUseRemoteSidecar.ts` is a copy of the one in `src/computerUseRuntime.ts`, which does not export it.
- In the restart test only B's computer-use host and runtime restart; B's community mailbox host is reused.
- Nothing was tested live: no real Supabase, Control app or two physical Macs. That is WP9.
