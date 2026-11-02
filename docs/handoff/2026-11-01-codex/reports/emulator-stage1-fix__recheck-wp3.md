# emulator-stage1-fix · recheck:wp3

(agent final report, verbatim)

Not all fixed. 8 of the 10 findings are fully fixed on emu/wp3 at 5258153e. Finding 1 (sandbox, j1-pty lane) is fixed only against the old WP0-1 base (cd89a7dd) and breaks when merged with the current one. Finding 4 still has a small gap, which I reproduced.

**Still open**

1. **Finding 4, low — `mobile/ios/scripts/check-workroom.ts:48-49`**
   - When the arguments don't parse, the script calls `prepareEvidenceDir(dir, explicit)` and `writeRunStatus` inside one `try{}catch{}`.
   - If the `--evidence-dir` folder holds any file the script doesn't own, `prepareEvidenceDir` throws, so the old `run-status.json` is never overwritten.
   - Reproduced with a folder holding `run-status.json` (`{"state":"passed"}`) plus `notes.txt`, then `check-workroom.ts --evidence-dir <dir> --bogus`: the file still says `passed`. Without `notes.txt` it correctly becomes `failed`.
   - The path for valid arguments already handles this case (`check-workroom.ts:72`); the usage-error path doesn't. The fixer's claim that every usage error leaves only a failed verdict is therefore not quite true.
   - Related: `--compile-only --evidence-dir <dir>` is a usage error, but it never touches `<dir>`, because `bestEffortEvidenceDir` returns `undefined` whenever `--compile-only` is present (`checkWorkroomSupport.ts:70`).
   - Fix: do what line 72 does. If preparing the folder throws and `run-status.json` exists, overwrite it with the failed status.

2. **Merge blocker that undoes finding 1 — `scripts/emulator-e2e/workroomPty.ts:117,120`**
   - emu/wp3 is built on emu/wp0-1@cd89a7dd, but emu/wp0-1 is now at daeca98e.
   - daeca98e changed `lanInbound` from a boolean to `{port:number}`, and `sandboxedArgv` now takes `{path, sha256}` instead of a path.
   - I merged emu/wp0-1 into a throwaway worktree. Git merged it without conflicts, but `tsc` then fails:
     - `workroomPty.ts(117,55)` TS2322
     - `workroomPty.ts(120,32)` TS2345
     - `tests/check-workroom-support.test.ts(179,43)` TS2345
   - The tests at `check-workroom-support.test.ts:271-272` also match the old call text as strings, so they will fail too.
   - **This is more than updating two calls.**
     - The new profile allows binding and inbound connections outside localhost on one port only (`sandbox.ts:189-192` at daeca98e).
     - check-workroom opens three listeners on en0, all on port 0: the LAN server (`:246`, no port option, so `port ?? 0`), `forbidden` (`:252`) and `redirector` (`:253`).
     - The new single-listener assertion (`lanListenerViolations`) also expects exactly one listener.
     - So after the merge, those binds should be denied under the j1-pty sandbox and the lane would fail.
   - It needs fixed ports passed into check-workroom, plus a WP1 profile that allows those ports (or a different approach for `forbidden` and `redirector`).

**Minor (not among the original findings, not blocking)**
- `docs/plans/remote-release-hardening-2026-09-12/PLAN.md:248` still lists bare `bun mobile/ios/scripts/check-workroom.ts` as a required release-candidate command. That command now always refuses and exits 1.
- `workroomPty.ts` is already scanned by `HARNESS_SCAN_PATHS`, because the whole `scripts/emulator-e2e` folder is listed, so the fixer's note is half wrong. `mobile/ios/scripts/checkWorkroomSupport.ts` and `workroomFixtureCompile.ts` are not scanned.

**Confirmed fixed**
- **1 (against cd89a7dd):** the lane is registered as opt-in. It holds the simulator boot lock and runs the script under `sandbox-exec`. The script checks the OS sandbox status and that a write into the worktree is refused, in both the parent (`:79`) and the child (`:117-118`).
- **2:** every swiftc call passes `-module-cache-path` to the scratch folder. `-disable-sandbox` is added only when already sandboxed.
- **3:** the CSP check now runs in the probe (`WorkroomProbe.swift`). The host makes no `fetch` and only checks that the probe's CSP check passed (`:353`).
- **5:** the isolation checks now fail the run (`:382-395`).
- **6:** there is one shared compile list in `workroomFixtureCompile.ts`. The test checks that every local-package import is linked and every App type is compiled, and that the old list would have been caught.
- **7:** the device set path, owner pid and udid are written to `run-status.json` before and after `simctl create`. The parent and the lane both clean up leftover sets.
- **8:** udid and runtime are in `run-status.json` and `result.json`, and are passed to `ctx.ownSimulator`.
- **9:** `mobile/ios/README.md` and `NATIVE-EXECUTION.md` are updated.
- **10:** argument parsing is strict, and the redundant `lastStage` line is gone (the remaining one at `:234` is real).

**What I ran** (in `.claude/worktrees/rc-wp3` at 5258153e)
- The six affected test files: 90 pass, 0 fail.
- `tsc --noEmit` on the root and on `mobile/ios/tsconfig.json`: no errors.
- `check-workroom.ts --compile-only simulator` inside a WP1 profile that can write only to scratch: exit 0, 49 sources, 24 s, and 0 new files in the shared `$(getconf DARWIN_USER_CACHE_DIR)clang/ModuleCache`.
- Not re-run: the full j1-pty lane (I relied on the fixer's run 20261101-044353-3501af), and the full `bun test` / `bun run verify`. I created no simulators.

The rc-wp3 worktree and my scratch files have been removed. Branches and refs are unchanged.
