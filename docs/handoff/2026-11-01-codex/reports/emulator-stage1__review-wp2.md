# emulator-stage1 · review:wp2

(agent final report, verbatim)

Defects in emu/wp2 (507994b3), most severe first. I reviewed it in a temporary worktree, which has now been removed. `bun run typecheck` exits 0.

The 13 shim tests did not pass reliably. On my first run the machine's load average was about 109, and the result was 5 pass, 2 fail (only 7 ran). A second run on a less busy machine gave 13 pass, 0 fail in 3.8s.

1. **The tests fail when the machine is busy** (tests/emulator-supabase-shim.test.ts:95 and :245).
   - Why: the `beforeAll` that starts the shim (PGlite plus schema plus openssl) has no timeout, so Bun's 5s default applies. It timed out at 6017ms, and every test in the "supabase shim" block was dropped. The strictness test, which starts its own shim, also has no timeout and timed out at 5204ms. `bun run test` and `bun run verify` will fail randomly under load.
   - Fix: `beforeAll(fn, 60_000)` and explicit timeouts on every test that starts a shim.

2. **The logout check proves nothing** (scripts/emulator-e2e/supabaseShim.ts:1055-1059 with :1404-1414).
   - Why: in `refresh-and-logout`, reusing the old refresh token sets `session.revoked = true` for the whole session. The following `phone.auth.signOut()` then gets 403 `session_not_found`, and auth-js ignores 401/403/404 on sign-out. The final `/user` check returns `session_not_found` because of the reuse, not the logout, so it would pass even if `#logout` did nothing.
   - The builder's claim "after logout, a session check gives session_not_found" is not supported by the test. The outsider's sign-out at :1388 is never checked.
   - Fix: test logout on a session that has not been revoked. Assert that the logout call returned 204 (authEvents logout ok) before checking `/user`.

3. **Refresh-token reuse behaves differently from real GoTrue, and the self-check asserts the shim's version** (supabaseShim.ts:1055-1060, :1404-1409).
   - Why: in supabase/auth `token_refresh.go`, reusing the token that the current one replaced returns the current token. Reuse within `RefreshTokenReuseInterval` (default 10s) is also allowed. The whole session is revoked only after that window. The shim answers `refresh_token_already_used` and revokes immediately.
   - Effect: a portal or app that retries a refresh after losing the response gets signed out in the emulator but not in production, and the self-check treats that as correct.
   - Fix: copy that GoTrue rule. Test the already-used case only with an injected `now` past the window.

4. **The required sandbox and home-folder guard are missing, and WP0/WP1 were skipped** (supabaseShim.ts:1434-1490; test :38-39 and :146).
   - Why: the design lists WP0 and WP1 as dependencies and requires every host process to run under sandbox-exec, with a check inside the child that its home and app-data folders are not the real ones.
   - `client-selfcheck` runs product host code (RemoteControlInternetAgent, AgentDialogueHost) in a child with no sandbox.
   - `--app-data`, `--scratch` and `--evidence` accept any absolute path, including the installed app's real app-data folder. AgentDialogueHost would then `mkdtemp` inside it.
   - Fix: refuse paths under the real app-data folder and run the CLI's own home/app-data check now. Start both commands through the WP1 launcher once it exists. Until then, mark the lane in the report as not isolated.

5. **`serve` usage errors exit 1, not 2** (supabaseShim.ts:1434-1436, :1499-1501).
   - Why: a missing or relative `--scratch`, or a non-numeric `--https-port`, throws and exits 1. Only an unknown command exits 2. The reported exit codes (0/3/2) are therefore wrong, and an orchestrator would misread usage errors.
   - Fix: check the arguments in `serveCli` and exit 2.

6. **The CORS preflight drops unsupported headers without recording them** (supabaseShim.ts:749-756).
   - Why: requested headers outside `PREFLIGHT_HEADERS` (for example `prefer`, or a header a newer supabase-js adds) are simply left out. The browser then fails with an unexplained CORS error while `report().ok` stays true. This breaks the "unknown requests fail the lane" rule, and the test only checks that `x-evil` is dropped.
   - Fix: record an unknown route whenever the requested headers include one that is not allowed.

7. **Some Postgres error codes get the wrong HTTP status** (supabaseShim.ts:404-408). I am fairly but not fully sure of PostgREST's table.
   - Why: PostgREST appears to map class 54 to 500 and 53400 to 500, and maps `PTxxx` codes to status xxx. The shim returns 413 for class 54 and 503 for 53400. The canonical SQL raises 54000 for `REMOTE_CONTROL_SESSION_LIMIT` (src/remoteControlRelaySql.ts:671) and 53400 in src/whatISaidFeedKeySql.ts:549.
   - Fix: match PostgREST's table, including `PT` codes.

8. **No guard against the forbidden ports** (supabaseShim.ts:446-449).
   - Why: `http.port` and `--https-port` accept 3001, 52741 and 4723, the ports the design says must never be touched. A misconfigured lane could take 3001 while the installed app is closed.
   - Fix: refuse those three ports in `assertPort`.

9. **The self-check will connect to any Supabase URL** (supabaseShim.ts:1150-1152).
   - Why: it uses whatever URL and service key are in the credentials file and writes hosts, pairings and dialogue rows there. Nothing prevents it from running against production Supabase.
   - Fix: refuse any URL whose host is not 127.0.0.1, ::1 or localhost.

10. **Shutdown can lose records or skip exit code 3** (supabaseShim.ts:673-694, :1462-1471).
    - Why: `stop()` builds the report without awaiting `server.stop(true)` and then closes the database, so requests still in progress are missing from the evidence.
    - If writing the dump or the evidence fails, `finish()` rejects inside `void finish(...)`. The result is an unhandled rejection and exit 1, not 3.
    - Fix: await the server stops, catch evidence-write errors, and still exit with 3 (or a dedicated code).

11. **The test runs on every platform** (tests/emulator-supabase-shim.test.ts:56 and :89).
    - Why: it needs `/usr/bin/openssl` and POSIX PATH handling, so `bun test` on the Windows PC will fail. 46 other test files in the repo skip by platform.
    - Fix: add `describe.skipIf(process.platform === 'win32')`.

12. **A known difference from Supabase is not documented** (supabaseShim.ts:248-303).
    - Why: SECURITY DEFINER functions are owned by PGlite's superuser, which bypasses every grant. In Supabase the owner, `postgres`, is not a superuser. A definer function missing a grant passes here and fails in production.
    - Fix: add this to the shim's "different from real Supabase" notes.
