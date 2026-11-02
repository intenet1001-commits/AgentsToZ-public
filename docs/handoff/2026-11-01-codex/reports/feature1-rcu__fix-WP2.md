# feature1-rcu · fix:WP2

(agent final report, verbatim)

I fixed all 9 findings and committed them on `feat/rcu-wp2` as `ca0a5a6f`, on top of `da5024e4`. Nothing was pushed. Package tests, the related suites and typecheck all pass.

`feat/rcu-wp2` was already checked out in worktree `wf_e9d0dfd2-de0-2`, so I used `git checkout --ignore-other-worktrees feat/rcu-wp2`, the same way `wf_e9d0dfd2-de0-5` shares `feat/rcu-wp1`. That worktree's branch now points at `ca0a5a6f`, so its files will look modified until it is reset or removed.

**Fixes:**
1. **Pending request left behind (RC-18)** (`src/computerUseRuntime.ts`): the request and both grant reads are now in one try/catch. Any failure, including a grant read that throws, calls `endSession`, which sends `scope-revoke-session` to Control. Errors without a code become `REMOTE_PEER_NOT_READY`; refusals with a code and "connection ended" pass through unchanged. New test: Control approves with `helperPublicKey:'bad'`, nothing stays pending, and this Mac's AI then gets a grant.
2. **SR-34 now covers the one-window tool** (`src/computerUseHost.ts`): press, set-value and click are held before the worker sees them. The answer is a settled `refused`/`person-has-control` receipt, with no ledger row and no halt. Observe and capture don't read the file. Two new tests.
3. **Idle grant handed over too early**: every check that can refuse (Control state, another pending request, a one-window grant) now runs first, and `yieldIdle` runs right before `requestApproval`. New test: with secure input on, a remote request is refused and this Mac's idle grant survives; once ready, the remote takes it over.
4. **D2 list**: added Hermes (`com.nousresearch.hermes`, read with plutil here on 3호) and Antigravity (`com.google.antigravity`). Antigravity isn't installed here, so that ID comes from the repo's verified one-window refused list. I also added Atlas and cmux from that same list, which goes slightly beyond the finding.
5. **Outdated Control**: new refusal `REMOTE_CONTROL_UPDATE_REQUIRED` (design §10 `control-update-required`). It covers no v2 scope support, an older Control process (`approval-expired`), and a Control with no `standing` field. Remote status guidance says the same. `REMOTE_NEEDS_STANDING` is kept for "the person turned it off". New test covers all four cases.
6. **Test comment**: corrected. Only Screen Sharing was read from an installed app; the other remote desktop client IDs are listed as still open, in both the test and the source comment.
7. **Tests depending on this Mac**: the runtime now reads no Screen file unless given a reader, the same pattern as `callerHost`. `api-server.ts` passes `createRemoteHumanInputReader()`, and a test checks that wiring.
8. **SR-34 guidance**: it now says status doesn't show the hold and to observe again after about 10 s with a new request ID. An AI on another Mac reads 「그 Mac」. A held input no longer updates `usedAt`.
9. **D11 risk sentence**: `REMOTE_GRANTED` and `REMOTE_READY` now warn that a pointer action ending unknown or as human-takeover stops all AI computer use on that Mac until a person reviews it. Both recommend background `type-text`/`key` first.

**Edits outside WP2's files (all small):**
- `api-server.ts`: two lines to pass the reader. This is WP6's file.
- `src/computerUseHost.ts`: the SR-34 check for the one-window tool.
- `src/computerUseProtocol.ts`: adds `person-has-control` to the v1 receipt reason type.

**Other files changed:** `src/computerUseRuntime.ts`, `src/computerUseScopeHost.ts` (new `lastNative()`), `src/computerUseScopeProtocol.ts`, `src/computerUseRemoteHumanInput.ts` (new `remoteHumanInputGuidance()`), `tests/computer-use-remote-human-input.test.ts`, `tests/computer-use-standing-allowance.test.ts`, `tests/computer-use-scope.test.ts`.

**Commands run:**

| Command | Result |
|---|---|
| `bun install` | exit 0 |
| `bun test` on scope, standing-allowance, remote-human-input, scope-mcp and runtime test files | 97 pass, 0 fail |
| `bun test tests/computer-use-` | 212 pass, 0 fail (19 files) |
| `bun test tests/agentstoz-use-mcp` | 19 pass, 0 fail (3 files) |
| `bun test tests/helpdesk.test.ts tests/agent-runtime-api-server-wiring.test.ts tests/app-install-safety.test.ts` (they read `api-server.ts`) | 31 pass, 0 fail |
| `bun run typecheck` | 0 errors |
| New tests against the old `src/computerUseRuntime.ts` (swapped in, then restored) | 4 fail as expected, 1 pass |

Together the first two suites are 231 = the reviewer's 224 plus 7 new tests.

**Not done:**
- WP1's error table has no code matching `REMOTE_CONTROL_UPDATE_REQUIRED`, so WP3 needs to map it.
- Design §8.5 still says scroll, drag and right click don't work from another Mac, which contradicts D11. That's WP5/WP8's file and I left it.
- The remote desktop client IDs other than Screen Sharing still need checking on 1호 and 3호 (RC-4).
- On a locked Mac a remote request can still take over an idle local grant, because Control reports no lock signal yet (planned for the 2nd stage).
- I did not run full `bun run verify`, `cargo test`, or the tester reconcile and personas.
