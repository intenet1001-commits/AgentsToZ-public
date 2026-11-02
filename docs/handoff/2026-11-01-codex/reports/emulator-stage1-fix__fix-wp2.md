# emulator-stage1-fix · fix:wp2

(agent final report, verbatim)

English translation: "This is the setup where, once it's connected, you can just keep using it comfortably, right?"

I fixed 11 of the 12 review findings on emu/wp2 and committed them. Finding 10 is partly fixed: the original symptom did not reproduce. I also fixed one extra bug that turned up during testing. Tests, typecheck and a full CLI run all pass.

**Commit:** `53d8921d` on emu/wp2 (base 507994b3). It ends with the two required attribution lines. Nothing was pushed. Files changed:
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-2/scripts/emulator-e2e/supabaseShim.ts
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-2/tests/emulator-supabase-shim.test.ts

emu/wp2 was also checked out in the stage-1 worktree wf_d5beb4e7-552-2. Nothing was running there, so I checked it out here with `--ignore-other-worktrees`.

**Findings.** To prove each regression test works, I put each defect back one at a time and re-ran the test file. "Caught" means at least one test then failed.
1. **Fixed: tests fail under load.** Every test or hook that starts the shim, a child process or openssl now has a 120 s timeout. A new test reads the test file's own syntax tree and fails if one is missing. Caught.
2. **Fixed: logout check proved nothing.** The self-check and unit tests now log out a session that is still live. They assert the 204, the logout count, `session_not_found` afterwards, and that refresh then fails with `refresh_token_not_found`. The local, others and global logout scopes each delete only the sessions they should, plus those sessions' refresh tokens. Caught: making logout do nothing failed 4 tests.
3. **Fixed: refresh-token reuse differed from GoTrue.** It now follows supabase/auth:
   - Retrying the token that was just replaced returns the current token.
   - Reuse within the reuse window (10 s by default, configurable) swaps the token.
   - After the window, the whole token family is revoked and the call fails with `refresh_token_already_used`.

   A test with an injected clock covers this. Caught: putting back the old behaviour failed 4 tests.
4. **Fixed (partly deferred): no sandbox or home-folder guard.**
   - Scratch and app-data folders must be outside the real home. The real home comes from `/usr/bin/id -P`, because Bun's home lookup follows `$HOME`.
   - Evidence may not go into the app's real app-data, Keychains, `.claude`, `.codex`, `.hermes` or `.gemini`.
   - The CLI refuses a HOME or TMPDIR under the real home and refuses forbidden environment keys.
   - Whether the process is sandboxed is now measured by the kernel and recorded in the ready line, the report and the self-check result.

   The WP1 launcher is on emu/wp0-1, so it is not used yet. Until it is, the lane reports itself as `not-sandboxed`. Caught: each guard's removal failed 1–2 tests.
5. **Fixed: usage errors exit 1, not 2.** Arguments are now parsed strictly, and every usage error or refused environment exits 2 before anything starts. Caught.
6. **Fixed: preflight drops unsupported headers silently.** A preflight asking for a header the shim does not emulate is now recorded as an unknown route, so the report fails. Caught.
7. **Fixed: wrong HTTP status for some Postgres codes.** I checked PostgREST's own table: 53400 and class 54 map to 500, and `PTxyz` codes map to status xyz. The shim now matches. Caught.
8. **Fixed: forbidden ports not refused.** Ports 3001, 52741 and 4723 are refused on both doors, including when the OS hands one out for port 0. Caught: 3 tests failed.
9. **Fixed: self-check would connect to any URL.** It now connects only to 127.0.0.1, ::1 or localhost. A test confirms the production URL is refused before any connection. Caught.
10. **Partly fixed: shutdown could lose records or exit wrongly.**
    - `stop()` now awaits the servers and then waits up to 10 s for requests still running.
    - A request cut off by the shutdown is recorded separately and does not fail the run.
    - Evidence that cannot be written is recorded as a stop error and fails the report. `stop()` no longer rejects, and `serve` exits 4 instead of crashing with an unhandled rejection.

    The evidence-failure half is caught by 2 tests. The "lost records" half did not reproduce on Bun 1.4.2: stopping the server settles the cut-off request before the call returns. So removing only the wait-for-requests step still passes, and I added that step as a safeguard. A test does catch a cut-off request being reported as an internal error.
11. **Fixed: tests run on Windows.** Every suite is skipped on Windows, enforced by the same syntax-tree test. Caught.
12. **Fixed: SECURITY DEFINER difference undocumented.** It is now in the header notes and in the report's list of known differences. The report also counts superuser-owned definer functions (76 in the run below). Caught.

**Extra fix: SIGTERM at startup.** `serve` registered its SIGTERM/SIGINT handlers only after printing the ready line. Under load, a signal in that gap killed it with exit 143 and no evidence; one test run hit this. The handlers are now registered before startup, a signal during startup is acted on once startup finishes, and `serve` prints a `starting` line first. A new test that sends SIGTERM during startup checks for exit 0 and a written report. Caught.

**Verification on the final tree:**
- `bun run typecheck`: exit 0.
- `bun test --cwd tests emulator-supabase-shim`: 28 pass, 0 fail, five runs in a row (7.8–8.5 s each, load average about 15–20).
- Mutation runner `bun /private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/wp2fix/mutate.ts <worktree>` put back 19 defects one at a time. 18 were caught; the one that was not is the wait-for-requests step described under finding 10. Both files were restored with identical hashes afterwards.
- Full CLI run `bun /private/tmp/claude-501/-Users-cs-work-forcs-AgentsToZ-byCS/65c85685-d82e-4450-b799-283279defd29/scratchpad/wp2fix/cli-e2e.ts <worktree>`, with every child's environment built from empty:
  - `serve` printed `starting` then `ready`.
  - `client-selfcheck` exited 0 over both http and https, all 10 checks passing.
  - After SIGTERM, `serve` exited 0. The report showed version 2, ok, 134 requests, no unknown routes or internal errors, no stop errors.
  - The scratch folder was removed and no shim processes are left.

**Blocked and constraints:** Port 443 is still blocked. Binding 127.0.0.1:443 fails with `EACCES`, so the https door used a random port (51339 in this run) and the report records the fallback. I did not use sudo or pf. The shim needs no copy outside /Users/cs-work/forcs, because it runs no preflight lane. I edited only files this branch owns; other branches have no references to the shim. Nothing touched ports 3001, 52741 or 4723, the installed apps, production Supabase, the keychain, TCC or desktop input.
