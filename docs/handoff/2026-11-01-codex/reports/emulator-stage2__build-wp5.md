# emulator-stage2 · build:wp5

(agent final report, verbatim)

English translation: Build lane WP5 J1-RELAY-WEB, which connects the production portal to the https Supabase shim and the sandboxed host. Verify it from a copy outside the repository, then report the branch, commits, files, commands and real results.

**Result: the lane passes end to end.** The final run used a fresh `git archive` of branch HEAD 96a0368b and ended `summary: pass (pass 2 · fail 0 · blocked 0 · skipped 0)`, exit 0.

**Branch:** `emu/wp5` in `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-2`. Nothing was pushed, and main and the main checkout were not touched.
- 92a6ecc1 feat(emulator-e2e): J1-RELAY-WEB lane — production portal ↔ https shim ↔ sandboxed host
- 96a0368b fix(emulator-e2e): j1-relay-web passes end to end from an outside copy

**Files:**
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-2/scripts/emulator-e2e/portalFixtureBuild.ts` (new)
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-2/scripts/emulator-e2e/relayWebPhone.ts` (new)
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-2/scripts/emulator-e2e/relayWebJourney.ts` (new)
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-2/scripts/emulator-e2e.ts` (registration only: `LANE_MODULES['j1-relay-web']`, `HARNESS_SOURCE_FILES` +3, header comment)
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-2/tests/remote-relay-real-host.e2e.mjs` (new; only runs `scripts/emulator-e2e.ts j1-relay-web`)
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_76da196f-0b8-2/tests/emulator-relay-web.test.ts` (new, 19 tests)

**Commands and results:**
1. In the worktree:
   - `bun test tests/emulator-relay-web.test.ts`: 19 pass, 0 fail.
   - `bun test` on all five `tests/emulator-*.test.ts` files: 149 pass, 0 fail.
   - `bun run typecheck`: 0 errors.
2. Outside copy:
   - `git archive --format=tar -o /Users/cs-work/agentstoz-emulator/wp5-final-96a0368b/src.tar emu/wp5`, then `tar -xf … -C …/wt`, then `bun install` (587 packages).
   - `bun scripts/emulator-e2e.ts preflight`: pass.
   - `bun scripts/emulator-e2e.ts j1-relay-web`:
     - **First run:** the lane passed (34/34 steps) but the overall summary failed. A simulator that was already booted (6E6F0A5F…) disappeared during the run while another worker held `sim.lock`. This lane uses no simulator.
     - **Second run:** on the same copy, with no other harness running. This is the clean result below.
3. Both outside copies (`wp5-run1` and `wp5-final-96a0368b`) were deleted afterwards. No `atz-emu-*` scratch folders remain.

**Real `index.json` summary from the clean run (20261101-065309-3fca2d):**
`{"total":2,"pass":2,"fail":0,"blocked":0,"skipped":0,"overall":"pass","exitCode":0,"passed":true}`
- Preflight: pass. Lane `j1-relay-web`: pass, 110869 ms. Simulator check: `unchanged`.

**Evidence from that run:**
- **QR:** carries `supabase`, and its URL and anon key match the shim.
- **Login:** email code through the shim (otp 2/2, verify 2/2).
- **SAS:** the phone's code equals the host's for both phones; approval is scripted and recorded with `scriptedApproval:true`.
- **Start/stop:** the fixture server's port was confirmed with lsof, and it booted once per tap (1, then 2 after the restart). The phone card showed `실행 중 · 포트 57249`.
- **Workroom:** the fake `claude` CLI received the typed token exactly once (`inputLinesWithToken: 1`).
- **Other-Supabase QR:** the guard title shows 「이 QR은 다른 사용자의 AgentsToZ(자기 Supabase)용입니다…」. The shim received 0 requests and 0 claim RPCs, and no `#pair` fragment was left in the address bar.
- **Restart:** the same session was restored as approved and the phone made no new claim (1 before, 1 after). The host's relay sequence numbers jumped by 1025 across the restart. Across 97 relay rows there were no reused or out-of-order sequence numbers and no duplicates.
- **Bundled portal:** paired and listed projects.
- **Shim:** 2 claim calls, both ok; 0 unknown routes, 0 rejected origins.
- **Host side effects:** none attempted (only the two guard start-up markers).

**Stand-ins (all named in the evidence):**
- The PGlite shim with a per-run CA, instead of real Supabase.
- `portal.test` served by a Playwright route, with the page's CSP widened by exactly the shim origin.
- Scripted SAS approval and workroom grant.
- A fixed OTP code instead of an email inbox.
- A fake CLI instead of a real AI agent.
- Desktop WebKit instead of iOS Safari or the app.
- The bundled portal served at `portal.test`.
- An empty `ps` stub on the host.

**Not registered in check-maintainer-web:** preflight refuses to run inside the registered root `/Users/cs-work/forcs`, and the lane takes about 111–134 s, too long for that suite. It stays as lane `j1-relay-web`.

**Product problems the lane found (none fixed here; I only changed harness files):**
1. **The host's project list fails inside the sandbox.** `api-server.ts:4150` (`runningHermesDesktops`) runs PATH-relative `ps` without catching errors. Under sandbox-exec, `/bin/ps` is refused (EPERM), so remote project listing fails with GATEWAY_UNAVAILABLE. The lane works around this with the empty `ps` stub.
2. **A start command that begins with `/` is refused.** `/api/execute-command` treats any `commandPath` starting with `/` as a `.command` file path. A `terminalCommand` such as `/path/bun server.ts` therefore gets a 400, and the phone shows ACTION_NOT_AVAILABLE. The fixture now uses `bun server.ts`.
3. **After 실행, the phone card stays 중지됨 until 새로고침 is tapped.** The host returns the card before the server has opened its port. The lane taps 새로고침 and records it; both starts needed one tap (`cardFollow` in the summary).
