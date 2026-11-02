# emulator-stage1-fix · recheck:wp7

(agent final report, verbatim)

Still open: 1 finding (finding 2, only partly fixed). The other nine findings (1 and 3–10) are fixed.

**Still open**

- **Finding 2 (MEDIUM, orchestrator wiring): the module side is fixed, but the lane is still not registered.**
  - **Where:** `scripts/emulator-e2e.ts:181` on emu/wp0-1, which is still `export const LANE_MODULES ... = {};`. emu/wp7 has no orchestrator file. No emu/* branch contains the `'screen-host-selfcheck': () => import('./emulator-e2e/screenFixtureHost')` line (emu/integration has no orchestrator file either).
  - **Why it is open:** on every branch, `bun scripts/emulator-e2e.ts screen-host-selfcheck` still has no loader. In my copy, before I added the line, `list` reported the lane as "not implemented yet". The review asked for both the export and the registration; only the export was done.
  - **The fix exists and works:**
    - I made a copy at `/Users/cs-work/agentstoz-emulator/rc-wp7-20261101135745/wt` from emu/wp7 `82752762` plus the 10 emu/wp0-1 files at the newer head `5c8d645d` and that one line. That head reorders WP1's outbound rules, and the fixer had only tested `daeca98e`. I ran a real `bun install --frozen-lockfile` there.
    - `bun run typecheck` exited 0.
    - `bun test --cwd tests emulator-` gave 82 pass, 0 fail.
    - `list` showed the lane as `registered`.
    - The lane run passed 45/45, summary pass 2, fail 0. Its `sandboxBaseSha256` equals the run's `sandbox/host.sb` hash (`7e6986aa…`). The TCC check recognised 12 requests and found 0 fixture requests and 0 prompts.
  - **To close it:** commit the line. emu/wp3 already did this for its own lane by merging emu/wp0-1 in `979e330f` and adding a `LANE_MODULES` entry. Otherwise the integration step has to add it.

**Fixed (checked in `git diff main...emu/wp7` and by running tests)**

1. **Signals:** `screenFixtureHost.ts:460-461` now has `(deny signal)` then `(allow signal (target same-sandbox))`. The canary is at `:1075-1081`. The real `sandbox-exec` tests pass standalone and on both WP1-shaped bases, and the canary passed in the lane run.
3. **APP_DATA_DIR and the separate generator:** `FIXTURE_ENV_KEYS` (`:203-206`) is the same as WP0's `BASE_ALLOWED_ENV_KEYS` plus `NODE_EXTRA_CA_CERTS`. Path keys must lie inside the scratch roots. The fixture rules are appended after `base` (`:453`), and the lane passes `ctx.hostSandbox.text`.
4. **`--work-dir` deleting the folder:** `createSelfcheckWorkDir` (`:189-195`) makes a fresh mkdtemp folder, and `finish` deletes only that. The parent is never chmodded, and a non-empty evidence folder is refused (`:169-174`).
5. **nm gate:** `assertGatedBinary` (`:643-651`) runs in `start()` and `viewerChild`. The selfcheck stops on a failed gate (`:1210`) or failed canaries (`:1215`).
6. **Environment check:** it is now a key allowlist. The real home comes from directory services. HOME, TMPDIR and the other path keys under the real home are refused, and so are shim PATH entries.
7. **Port-deny claim:** the comment (`:403-425`) is corrected, the outbound allowlist comes last, `profileShapeProblems` enforces that order, and the 30-trial reachability tests pass.
8. **Viewer profiles:** each viewer launch writes a fresh profile with mode 0600 (`:1113-1115`). `writeFixtureProfile` refuses a folder the fixture can write.
9. **Overclaiming checks:**
   - The bound address is measured with lsof (`:854-857`, `:1237-1239`, `:1319-1321`).
   - `main.swift` now logs `requestedHost`.
   - The derived `no-tcc-window-keychain-surface` check is gone.
   - `productionSourcesVsMain` returned `{"measured":true,"ref":"main","changed":[]}` in the temporary worktree.
   - `tccVerdict` fails when no TCC request was recognised.
10. **Smaller gaps:**
    - `replyForCaller` gives `serve` replies the caller's id.
    - 33 unit tests pass, and `tests/` is in the tsconfig `include`, so `bun run typecheck` (exit 0) now covers the script.
    - The invite caveat is recorded in `INVITES_REACHING_COUNTING_LISTENER`, `countingListenerReachable` and a check.

**Minor wording, not a review finding**

- The comment at `screenFixtureHost.ts:421` calls "`localhost:*` followed by port denies" WP1's base. WP1's current base (`5c8d645d`) is a port allowlist placed last, with no `localhost:*` outbound allow.
- `WP1_ALLOWLIST_SHAPED_BASE` in the test file models `daeca98e`. The real composition with `5c8d645d` passed in the lane run above.

**Cleanup:** the temporary worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/rc-wp7` and the copy under `/Users/cs-work/agentstoz-emulator/` are both removed. No fixture processes are left, the run scratch in TMPDIR is gone, and the main checkout is clean.

**Safety:** no forbidden ports, apps, simulators, keychain or TCC were touched, and no OS prompts appeared.

The lane log is at `/private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/rc-wp7-lane.log`.
