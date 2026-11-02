# feature1-rcu · build:WP2

(agent final report, verbatim)

Branch `feat/rcu-wp2` has one new commit, `da5024e4`, on top of main `f3e96658`. It covers WP2 and the computer-use-exclusion package (SR-34). Typecheck and all related tests pass. Nothing was pushed.

**Files in the commit**
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-2/src/computerUseCallerHost.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-2/src/computerUseScopeProtocol.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-2/src/computerUseScopeHost.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-2/src/computerUseRuntime.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-2/src/computerUseRemoteHumanInput.ts` (new)
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-2/tests/computer-use-scope.test.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-2/tests/computer-use-standing-allowance.test.ts`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-2/tests/computer-use-remote-human-input.test.ts` (new)

**Commands run (current tree, real counts)**
| Command | Result |
|---|---|
| `bun install` | exit 0 |
| `bun test` on the 4 existing scope/runtime/standing/access-switch files, before my changes | 74 pass, 0 fail |
| `bun run typecheck` | 0 errors |
| `bun test tests/computer-use- tests/agent-dialogue-` | 269 pass, 0 fail, 2674 expects, 28 files |
| `bun test tests/agentstoz-use-mcp` | 19 pass, 0 fail |

I also switched off three rules one at a time to check the new tests catch them: the cancel-if-not-signed step, the remote pointer refusal, and the SR-34 refusal. The matching tests failed each time, and the code was put back.

**Interface for WP3 and WP6**
- **Main call:** `runtime.remote(sessionKey, peer, body)`.
  - `sessionKey` is 32 hex.
  - `peer` is `{deviceId (uuid), deviceName, instance (32 hex), client?, host?}`.
  - A refusal is an Error with a `.code` from `COMPUTER_USE_REMOTE_REFUSALS` in `computerUseScopeProtocol.ts`.
- **Other public methods:** `remoteAdmission(peer)`, `remoteGrants()`, `hasIncomingRemoteGrant()` (for the chain guard).
- **Constructor options:** `acceptRemote` (default off; it needs `remoteSettings`), `remoteSettings` (`computerUseRemoteSettingsFile(path)` or `computerUseRemoteSettingsMemory()`), `remoteHumanInput`, `sleep`.
- **Remote connections:** sessionId starts with `rcu_`, lane is `remote`, and status rows use scope `'remote-connection'`.
- **Panel setting:** `scope-remote-set {allowRemote?, block?:{deviceId, name?, connection? (32-hex connection tag), minutes? (1–1440, only with connection, default 30)}, unblock?:{deviceId}, noticeShown?:true}`.
- **Settings file:** a missing file means receive (D1). A file that can't be read means receive nothing until the person saves again.
- **Remote status:** shows only the kind of the person's switch, not which app they allowed.

**Changes outside the core plan**
- The error for a bad observe request now reads `(받는 항목: grant, epoch) · 선택 항목: capture, displayId`. Listing `capture` and `displayId` inside the brackets had broken an existing assertion in `tests/computer-use-scope-mcp.test.ts`. I changed the message, not that test.
- I extended the `scoped()` test fixture in `tests/computer-use-scope.test.ts` with optional extra apps and scroll/drag receipts. Existing tests still pass.
- When no reader is passed in, the runtime now reads Screen's real `remote-input.json`. That is how the SR-34 check works in production without touching `api-server.ts`. It also means runtime tests that don't inject a reader check the real path on the test Mac. The file doesn't exist here.

**Not done**
- **`api-server.ts` wiring (WP6):** `acceptRemote` (bundled sidecar on macOS only) and `computerUseRemoteSettingsFile(join(APP_DATA_DIR,'computer-use-remote.json'))` still need to be passed in.
- **Test registration (WP8):** `tests/computer-use-standing-allowance.test.ts` and `tests/computer-use-remote-human-input.test.ts` are not listed in `scripts/check-native-workflow.ts`, which I don't own.
- **MCP (WP5):** the MCP schema doesn't accept `capture` on observe yet. I did not change the MCP contract version.
- **Bundle IDs:** only Apple Screen Sharing was read from an installed app (on this Mac, 3호). The other remote desktop client IDs are the vendors' published ones, and 1호 was not checked.
- **WP3:** the mailbox sentAt check (RC-6), the receipt ledger and session crypto belong to WP3.
- **Docs:** `docs/claude/computer-use.md` was not updated because I don't own it.
- **Other runs:** I didn't run the full `bun test`, `cargo test`, smoke tests or the tester reconcile on 127.0.0.1:3001; my instructions excluded calling it.
