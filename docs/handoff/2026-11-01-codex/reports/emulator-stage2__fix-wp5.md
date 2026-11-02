# emulator-stage2 · fix:wp5

(agent final report, verbatim)

English translation: Fix the review findings on `emu/wp5` (the J1-RELAY-WEB lane), check the fixes for real (including a lane run from a copy outside the registered root), and commit.

**Result: I fixed all 9 findings, and the lane passes from an outside copy.** Three findings were fixed differently from the reviewer's main suggestion (#4, #6 and #9, below). Two came with extra real fixes: the bundled phone opening its QR unmodified, and serving the real response headers.

**Branch.** `emu/wp5` is checked out in another worktree (`.claude/worktrees/wf_76da196f-0b8-2`), so git would not let me check it out here. The commits are on **`emu/wp5-fix`**, a plain fast-forward of `emu/wp5`: `96a0368b` → `79527724` → `5e414e35`. Nothing was pushed, and main was not touched.
- `79527724` fix(emulator-e2e): j1-relay-web review — bounded waits, cleanup, restart skip, headers
- `5e414e35` fix(emulator-e2e): j1-relay-web bundled phone signs in from 원격 작업; prove cleanup on a real server

**Files changed:** `scripts/emulator-e2e/relayWebJourney.ts`, `scripts/emulator-e2e/relayWebPhone.ts`, `scripts/emulator-e2e/portalFixtureBuild.ts`, `tests/emulator-relay-web.test.ts`, `tests/remote-relay-real-host.e2e.mjs`. The lane registration line was not touched.

**Fixes, by finding**
1. **Lane could hang forever:** a new `followCard` counts attempts (at most 3), not successful taps, and stops at a 150 s deadline. A unit test with an offline phone (no 새로고침 button) shows it ends.
2. **Fixture server left running:** I confirmed this is real. Two `bun server.ts` processes from earlier failed runs (pids 89043 and 96702) were still listening on 127.0.0.1, in deleted scratch folders. I checked each one's folder and stopped them. The lane now runs `reapFixtureServers` after the host stops. It only kills a pid from the starts file that it can prove is its own (it is the port listener, or its folder is the alpha folder), sends SIGTERM then SIGKILL, and records what it killed. If a passing run needed it, the lane fails. A unit test runs a real server and checks it gets stopped while an unrelated live pid is left alone.
3. **Restart skip not checked:** `judgeRestartSkip` now requires the restored session's host_to_controller jump to be at least 1024. Missing data counts as a fail. A unit test checks 1024 against `REMOTE_CONTROL_SEND_SEQUENCE_RECOVERY_GAP` in src.
4. **Refresh taps hid regressions:** each transition now has an allowed number of taps: before 0, start 1, stop 0. Going over fails. Taps within the limit are reported as the named known issue `card-does-not-follow-start`, in `details.knownIssues` and in a `labels.standIn` line. I chose this over failing on any tap because one tap after 실행 is a known product issue (the card doesn't update by itself) and happened in both runs.
5. **Origin and CSP problems ignored:** a phone now fails on any blocked origin, on any page or CSP header that could not be widened (including a page with no CSP at all), and on a `/remote/` page where no meta or header CSP was widened.
6. **Unlabeled stand-ins:**
   - Three new stand-in labels: WebKit uses the real HOME, `?tab=workroom` is added to the web and foreign QRs, and the bundled supabaseUrl has a port.
   - The route now serves the `vercel.json` headers for each path (later rules win, as on Vercel), with the CSP widened.
   - The bundled phone gets the iPhone app's `PortalSchemeHandler` headers and the same CSP widening as `servedHTML`. A unit test compares them with the CSP written in the Swift file.
   - The bundled phone now opens its QR unmodified. The first run with this change failed: a QR opened as scanned lands on 홈, and the sign-in, SAS and connection status only appear under the 원격 작업 tab. The phone now taps 원격 작업 first, like a person would.
   - **Not fixed:** WebKit still runs with the real HOME. It is now labeled; the builder measured that WebKit hangs under a scratch HOME, and I did not re-measure that.
7. **Trivial "연결됨 again" check:** that step is now labeled as a precondition only. Resume is proved by the start/stop round trip, no new claim, and the sequence skip.
8. **Port owner not checked:** start and stop now check that the listener is the latest pid in the starts file (using `listenerOwnedBy`).
9. **Entry only worked under Bun:** `tests/remote-relay-real-host.e2e.mjs` now uses `fileURLToPath` and `node:child_process`, so it runs under node too. Its comment now gives the real reason the lane isn't in the maintainer suite: preflight refuses to run inside the registered root, where the maintainer runs.

**Checks run (in the worktree)**
- `bun test tests/emulator-relay-web.test.ts`: 29 pass, 0 fail
- `bun test tests/emulator-*.test.ts`: 159 pass, 0 fail
- `bun run typecheck` (`tsc --noEmit`): 0 errors

**Lane run from an outside copy**
- Steps: `git archive` HEAD `5e414e35` to `/Users/cs-work/agentstoz-emulator/wp5fix-run2/wt`, `bun install --frozen-lockfile`, `bun scripts/emulator-e2e.ts preflight` (pass), then `node tests/remote-relay-real-host.e2e.mjs`, which also exercises fix #9.
- Result: EXIT 0. The copy has since been deleted, and no lane processes or scratch folders are left.
- `index.json` summary: `{"total":2,"pass":2,"fail":0,"blocked":0,"skipped":0,"overall":"pass","exitCode":0,"passed":true}` and preflight `pass`. The lane took 120536 ms and passed 35/35 steps.
  - Shim: claims 2 of 2 succeeded, 0 unknown routes, 0 rejected origins.
  - Restart skip: jump 1025, minimum 1024.
  - Relay audit: 96 rows, 0 reused, 0 out of order, 0 duplicate sequence numbers.
  - Phones (web, foreign, bundled): none had a blocked origin; each widened 1 meta CSP and 1 header CSP; none were missing. The foreign-QR phone made 0 shim requests and 0 claims.
  - The bundled phone landed on `home` with sign-in not visible.
  - Known issue `card-does-not-follow-start` happened twice (web-start and after-restart-start, 1 tap each).
  - Fixture servers: 2 started, 0 had to be killed after the host stopped. No post-run problems.
- `gitHead` shows `unknown` because an archive copy has no `.git`.
- An earlier run on `79527724` failed at the bundled sign-in step. That is what led to the second commit.

**Product issues the lane surfaced (not fixed, product code untouched):**
- After 실행, the project card doesn't switch to 실행 중 by itself; it takes one 새로고침 tap.
- A QR opened as scanned lands on 홈 with no sign-in prompt; the person has to tap 원격 작업.
- The host doesn't stop the project servers it started when it shuts down (`executableProcesses` in `api-server.ts`).

This lane uses no simulator, so the `check-ui.py` and simulator-only test checks don't apply.
