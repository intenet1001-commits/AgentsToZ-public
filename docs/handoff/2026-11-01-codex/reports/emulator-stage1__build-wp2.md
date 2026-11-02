# emulator-stage1 · build:wp2

(agent final report, verbatim)

WP2 is done and committed, and the shim test suite passes: 13 pass, 0 fail. One lane is blocked: on this Mac the https door cannot get port 443 without sudo, so it falls back to a random port.

Branch: emu/wp2, based on main d093fa88, in worktree /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-2.
Commit: 507994b3ebc09800e0709a564e44bae2e0dfe04b, "feat(emulator-e2e): PGlite Supabase shim with http/https doors and a per-run fixture CA". It ends with the two required trailer lines. Not pushed or merged, and the main checkout was not touched.

Files added (3 files, 2093 lines; nothing else changed):
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-2/scripts/emulator-e2e/supabaseShim.ts (1503 lines)
  - Library API: `startSupabaseShim` (alias `start`) returns an object with `stop()`, `report()`, `dump()` and `credentials()`. There is also `runShimClientSelfcheck` and `redactForEvidence`.
  - CLI: `serve` and `client-selfcheck`. `serve` exits 0 when the report is clean, 3 when something unsupported happened, and 2 on a usage error.
  - It runs the canonical schema from src/schemaSql.ts in PGlite, the same way tests/onboarding-cloud.test.ts does. It does not depend on WP0 or WP1.
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-2/scripts/emulator-e2e/fixtureCa.ts (224 lines)
  - Makes a fresh CA for each run using /usr/bin/openssl, and deletes the CA key straight after signing.
  - The certificate covers localhost, 127.0.0.1 and ::1. It refuses names that are not reserved test names and addresses that are not loopback.
- /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-2/tests/emulator-supabase-shim.test.ts (366 lines, 13 tests)

Verification, run just before the commit:

1. `bun test --cwd tests emulator-supabase-shim` (from the worktree root)
   ```
   bun test v1.4.2 (744846f84)
    13 pass
    0 fail
    158 expect() calls
   Ran 13 tests across 1 file. [4.11s]
   ```
   What the tests show:
   - **Relay round trip:** a real RemoteControlRelayRpcClient run (register → create_pairing → claim → controller_send → host_receive) passes over http in-process. It also passes over https in a child process that trusts the CA only through NODE_EXTRA_CA_CERTS. The same child without that variable fails at the first check with a TLS error.
   - **Who can call what (RLS):**
     - An anon key calling `register_host` or `agent_dialogue_call` is refused with 401/42501.
     - A member's token calling host-only functions gets 403. The service key calling `claim_pairing` gets 403.
     - Over the whole run, `register_host` calls came out as anon:401 ×2, authenticated:403 ×2, service_role:200 ×2.
   - **Dialogue:** an AgentDialogueHost control call and poll returns `{ok:true}`. The history saved at the end shows insert:pending → update:taken → update:done, twice.
   - **Email-code login:** gives a session; an unknown email, a wrong code and an already-used code are refused. The refresh token rotates, and reusing an old one gives `refresh_token_already_used`. After logout, a session check gives `session_not_found`.
   - **Bad tokens refused:** forged signature, unsigned, expired, a wrong role, and a missing or invalid apikey.
   - **Unknown routes:** 12 probes get 404 SHIM_UNKNOWN_ROUTE. A foreign Origin gets 403 and is recorded. Either one makes `report().ok` false, and the CLI then exits 3 after SIGTERM with the evidence files still written.
   - **Evidence files:** saved with mode 0600, and contain no keys or JWTs.

2. `bun run typecheck` (`tsc --noEmit`) exits 0 with 0 errors. tsconfig includes `tests`, and the test imports both scripts, so all three files are checked.

3. I checked the existing tests that list files on disk (guide-content-coverage, voc-transit-storage-sql, workroom-browser-error-codes and others). None of them scan `scripts/` or new test files, so the new files need no registration. I did not run the full `bun run verify`.

Blocked, or different from real Supabase:
- **Port 443 (blocked):** binding 127.0.0.1:443 or ::1:443 as a normal user fails with EACCES here. Bun reports it as EADDRINUSE; a separate probe gets the real error. The https door falls back to a random port and records `EACCES binding 127.0.0.1:443` in the report. Any later lane that needs a plain `https://localhost` with no port (J1-RELAY-SIM, J4-COMMUNITY-SIM / WP6) is blocked on this Mac without sudo, and I did not use sudo. Setting `requirePreferredPort` turns the fallback into a hard failure.
- **No IP limits on the CA:** Bun rejects IP name constraints (`UNSUPPORTED_CONSTRAINT_TYPE`), so the CA restricts names only.
- **Not emulated:** sign-in rate limits, table (REST) routes, realtime and storage. Calls to them fail as unknown routes rather than being silently accepted.
- **Not done:** no tester manifest entry was added, because the manifest belongs to WP13. Nothing was run on simulators or the desktop. Nothing touched the installed app (port 3001), Screen (52741), Appium (4723), the production Supabase, the keychain or TCC.
