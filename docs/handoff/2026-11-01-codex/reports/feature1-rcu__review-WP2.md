# feature1-rcu · review:WP2

(agent final report, verbatim)

WP2 + SR-34 review of `feat/rcu-wp2` at `da5024e4`: 9 defects, ranked below. None blocks the design's main path, but #1 is a confirmed hole in "nothing is left waiting" (RC-18).

Tests I ran in a temporary worktree at `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/rv-rcu-WP2` (now removed; main is clean):
- The 5 scope, standing, remote-human-input, scope-mcp and runtime test files: 90 pass, 0 fail.
- `tests/computer-use-*` and `tests/agentstoz-use-mcp*`: 224 pass, 0 fail.
- `bun run typecheck`: 0 errors.

These match the design and need no change:
- **D11:** there is no `REMOTE_POINTER_DISABLED`; right click, double click, scroll and drag from another Mac are accepted.
- **Refusals that work:** the remote-desktop-client refusal covers every AI, front app and focus-app. A remote AI's pointer is refused while such a client is running (RC-4). App scope is refused for remote (RC-3, D6).
- **Remote connections:** off by default (RC-12). A heartbeat makes no connection and doesn't move `usedAt` (RC-9). The caps are 4 per device and 16 in total.
- **Settings and cancellation:** the settings file behaves as specified (missing means receive, unreadable means receive nothing), and blocking ends connections at once. The cancel after two reads sends `scope-revoke-session`.
- **SR-34 refusal shape:** a settled `refused` receipt with reason `person-has-control`, not dispatched, not halted, no recovery row. Observe and capture skip the file read.

1. **MEDIUM — RC-18 hole: a pending request can be left behind** (`src/computerUseRuntime.ts:376-388`)
   - **Why:** after `scope.requestApproval` succeeds, both grant reads call `managementStatus()` → `scope.sync()`. `sync()` can throw: a bad `helperPublicKey`, a failed approval check, a recovery or SQLite error, or an unverifiable open-grant answer. The throw leaves `requestRemoteAccess` without calling `this.scope.endSession(c.id)`, and the error has no `.code`.
   - **Repro:** a fake Control answers `scope-approval-status` with `{state:'approved', helperPublicKey:'bad'}`. The remote request-access rejects with "범위 승인 공개키를 확인하지 못했습니다.", no `scope-revoke-session` is sent, and `scope.pending.size` is 1. That leftover request blocks this Mac's own AI (`OTHER_PENDING`) until it expires.
   - **Fix:** wrap the section from `requestApproval` to the end of the read loop in try/catch. On any error that is not an `admitted()` refusal, call `this.scope.endSession(c.id)` and rethrow as `REMOTE_PEER_NOT_READY`. Add this case as a test.

2. **MEDIUM-LOW — SR-34 covers only v2 scope input** (`src/computerUseHost.ts:~250-260`)
   - **Why:** the v1 one-window path (`agentstoz_use_computer`: press, set-value and click via `ComputerUseHost`) still sends input to Control while a remote person controls the Mac through Screen. SR-34 says "AI input"; mac-to-mac §5.5 named only `computerUseScopeHost.ts`.
   - **Fix:** pass the same `RemoteHumanInputReader` into `ComputerUseHost` and refuse before dispatch, or record the exclusion in the design.

3. **LOW — a remote request takes this Mac's idle grant before checking it can succeed** (`src/computerUseRuntime.ts:371`)
   - **Why:** `yieldIdle` runs before the checks for another pending request, secure input or permissions (373-375), and before Control can sign. A remote AI that will be refused still ends this Mac's own idle grant, and can do so every 10 s. This includes a locked Mac.
   - **Fix:** run the `remoteNotReadyDetail` and pending checks first, and yield only right before `requestApproval`.

4. **LOW — the D2 refused list misses AI agent apps AgentsToZ itself drives** (`src/computerUseScopeProtocol.ts:49`)
   - **Why:** Hermes.app (`com.nousresearch.hermes`, read with plutil on 3호) is missing. So is Antigravity. A remote AI could type a prompt into Hermes and have it run commands, which is exactly the loop D2 targets.
   - **Fix:** add both bundle IDs, read from the installed apps.

5. **LOW — an outdated Control is reported with the wrong code** (`src/computerUseRuntime.ts:362-367, 94-95`)
   - **Why:** when Control has no standing support, `standing()` returns null with `native.success` true, so the remote gets `REMOTE_NEEDS_STANDING` ("the person must turn on the standing allowance"). `scope-update-required` is folded into `REMOTE_PEER_NOT_READY`. Mac A cannot tell "update Control" from "locked"; design §10 lists `control-update-required` as its own case.
   - **Fix:** return a distinct `control-update-required` refusal for both.

6. **LOW — a test comment claims more checking than was done** (`tests/computer-use-scope.test.ts:644`)
   - **Why:** it says the IDs were "Read from the installed apps (plutil …, 3호)" and then asserts TeamViewer. Only Screen Sharing was read. RC-4 asks for the IDs to be confirmed on both 1호 and 3호, which is still open.
   - **Fix:** correct the comment and list the unverified IDs as an open item.

7. **LOW — runtime tests now depend on the test Mac** (`src/computerUseRuntime.ts:219`)
   - **Why:** the runtime's default reader is the real one. Every existing runtime test that doesn't inject `remoteHumanInput` reads the real `~/Library/Application Support/AgentsToZ Screen/remote-input.json` and may run pgrep. If Screen injected input within the last 10 s, those tests' input is refused.
   - **Fix:** inject `noRemoteHumanInput` in the test fixtures, or make the real reader opt-in from `api-server.ts` (WP6).

8. **LOW — the SR-34 guidance points at a status that never changes** (`src/computerUseRemoteHumanInput.ts`, `REMOTE_HUMAN_INPUT_GUIDANCE`)
   - **Why:** it tells the AI to check status every 30 s, but status never shows the hold (`g.person` is not set). The wording says "이 Mac" even when the reader is the other Mac's AI. The refused attempts also update `usedAt`, so they keep the grant from being handed over as idle.
   - **Fix:** say "observe again after about 10 s", or show a hint in status.

9. **LOW — the D11 risk warning is missing from the remote guidance** (`src/computerUseRuntime.ts:45-46`)
   - **Why:** RC-17 says the trade-off must be stated in the response text. If a pointer action ends unknown or as human-takeover, all AI computer use on that Mac stops until a person reviews it. Neither `REMOTE_GRANTED` nor `REMOTE_READY` says this or recommends background `type-text`/`key` first.
   - **Fix:** add one sentence to both.
   - **Related (WP5):** design §8.5 still says scroll, drag and right click don't work from another Mac, which contradicts D11.
