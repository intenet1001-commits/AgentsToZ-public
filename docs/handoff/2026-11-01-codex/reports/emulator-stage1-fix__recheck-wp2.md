# emulator-stage1-fix · recheck:wp2

(agent final report, verbatim)

English translation: "This is the setup where, once it's connected, you can just keep using it comfortably, right?"

One finding is still open, a minor gap left from finding 3. The other 11 original findings are fixed.

**Still open:**
- **scripts/emulator-e2e/supabaseShim.ts:1391** (`if (!record.revoked) { record.revoked = true; record.updatedAt = now; }`), finding 3:
  - **Why:** in GoTrue, using an already-used token again inside the reuse window moves that window forward. The shim keeps the window fixed from the token's first use.
  - **GoTrue source (supabase/auth master, read today):** `GrantRefreshTokenSwap` always sets `token.Revoked = true` and calls `tx.UpdateOnly(token, "revoked")`. `UpdateOnly` (storage/sql.go) then calls `getExcludedColumns` (storage/dial.go), which never excludes `updated_at`, and pop's `Update` writes `updated_at = now()`. `RefreshTokenGrant` (tokens/service.go:395) measures the window from `token.UpdatedAt`.
  - **Effect:** say an old token A is first used at t=1, then reused at t=8 and again at t=15. GoTrue lets the t=15 reuse through, because t=8 moved the window to t=18. The shim answers `refresh_token_already_used` and revokes every refresh token of the session.
  - **Fix:** set `record.updatedAt = now` on every swap, and add a test step for it.
  - **Severity:** low. It only shows up when one old token is reused more than once and the reuses span more than the interval. A retry that resends the token just replaced (the common lost-response case) matches GoTrue.

**Fixed, checked in the diff `git diff main...emu/wp2` (53d8921d):**
1. **Timeouts:** every test or hook that starts a shim, a child process or openssl now has a 120 s timeout. A test that reads the test file's own syntax tree enforces this.
2. **Logout:** the self-check and the unit tests now log out a session that is still live. They check the session is live before logout, `403/session_not_found` after it, and that refresh then fails with `refresh_token_not_found`. The local, others and global scopes each delete only the sessions they should, plus their refresh tokens.
3. **Refresh-token reuse:** retrying the token that was just replaced returns the current token. GoTrue picks the current token as the newest active one, and the shim's `seq` counter does the same. Reuse past the window revokes all refresh tokens of the session and keeps the session itself, as GoTrue does. The only gap is the window shift listed above.
4. **Home and sandbox guard:** scratch and app-data folders must be outside the real home, which the shim reads with `id -P`. Evidence may not go into the app's real app data, Keychains, `.claude`, `.codex`, `.hermes` or `.gemini`. The CLI checks the environment (HOME, TMPDIR, app-data folder, forbidden keys) before anything runs. Whether the process is sandboxed is measured by the kernel and reported as `not-sandboxed`, which is what the review asked for until the WP1 launcher exists.
5. **Exit codes:** arguments are parsed strictly. Usage errors, refused environments and unreadable credentials now exit 2.
6. **Preflight headers:** a preflight asking for a header the shim does not emulate is recorded as an unknown route, so the report fails.
7. **HTTP status:** matches PostgREST's table. 53400 and class 54 give 500, and `PTxyz` gives xyz.
8. **Forbidden ports:** 3001, 52741 and 4723 are refused in `assertPort`, for the preferred https port and the CLI flag, and also when the OS hands one out for port 0.
9. **Self-check target:** it now connects only to a loopback address, and every request in it goes to that checked address. The production Supabase URL is refused before any request is sent.
10. **Shutdown:** `stop()` waits for the servers to close and then up to 10 s for requests still running. A request cut off by the shutdown is recorded separately and does not fail the run. Evidence that cannot be written is recorded as a stop error, `serve` exits 4 instead of crashing, and `stop()` no longer rejects. As the fixer said, removing only the wait-for-requests step still passes the tests; the fix itself is in the code.
11. **Windows:** every suite is skipped on Windows, enforced by the syntax-tree test.
12. **SECURITY DEFINER:** the difference is now in the header notes and in the report's `knownDifferences`, and the report counts the superuser-owned definer functions.

The extra fix for SIGTERM during startup also checks out: the signal handlers are set before startup, and a test covers it.

**Test runs:** in a temporary worktree (detached at 53d8921d, real `bun install`):
- `bun run typecheck`: exit 0.
- `bun test --cwd tests emulator-supabase-shim`: 28 pass, 0 fail (7.9 s), then three runs in parallel, each 28 pass, 0 fail (about 19 s each, load average about 17).

No probe folders were left under the real home and no shim processes remained. The worktree has been removed and the main checkout is unchanged. Nothing touched ports 3001, 52741 or 4723, the installed apps, production Supabase, the keychain or TCC.
