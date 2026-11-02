# emulator-stage2 · review:wp5

(agent final report, verbatim)

English translation: Review branch `emu/wp5` (the J1-RELAY-WEB lane) for whether it really runs production code, checks both ends, fails when the feature is broken, follows the safety rules, and is stable. Return "no defects" or a ranked list of defects with file:line, why and fix.

**Verdict: 9 defects, no safety violation.** The lane does run production code. It uses the real `vite.portal.config.ts` portal bundle (the bundled variant matches `mobile/ios/scripts/build-portal-web.ts`), the real `api-server.ts` sidecar under sandbox-exec, the canonical relay SQL on the shim, and the real foreign-QR guard in `src/remote-control-portal-main.tsx:189,4297`. It checks both ends:
- SAS on the phone against the host's SAS.
- Fixture boot lines plus the LISTEN socket for start and stop.
- The fake CLI transcript recording the input exactly once.
- Shim claim counts against the host's approved sessions.
- Zero shim requests from the foreign-QR phone. The web portal only talks to its own Supabase, so a broken guard would show up as shim traffic.

I checked these in a temporary worktree at 96a0368b, which I have since removed: `tests/emulator-relay-web.test.ts` 19 pass / 0 fail, all `tests/emulator-*.test.ts` 149 pass / 0 fail, `tsc --noEmit` clean. I did not run the lane itself.

Ranked defects:

1. **The lane can hang forever** — `scripts/emulator-e2e/relayWebJourney.ts:437-441`.
   - Why: in `while (!followed && refreshTaps < 3)`, `refreshTaps` only goes up when `tapRefresh()` succeeds. The `remote-refresh` button is only rendered while the phone is `online` and not busy (`src/remote-control-portal-main.tsx:3632-3644`). If the host dies or the phone goes offline without showing `.remote-alert`, each pass takes about 60 s and the loop never ends. The harness has no per-lane timeout. So a broken feature becomes a hang instead of a fail, and the sidecar and shim are left running.
   - Fix: count attempts, not successful taps (for example `for (let attempt = 0; attempt < 3 && !followed; attempt++)`), or put a deadline on the whole helper.

2. **The fixture project server leaks when the lane fails** — cleanup at `relayWebJourney.ts:559-591`.
   - Why: alpha is started by the host's `/api/execute-command`, which spawns `/bin/bash -c 'bun server.ts'` (`api-server.ts:22675`). The host never kills those processes on shutdown (`executableProcesses` has no exit cleanup; `shutdownRemoteControlApi` at `api-server.ts:15476`). Stopping the sidecar therefore leaves them alive. Any failure between 「실행」 and a successful 「중지」 (for example `cardFollows` failing after start) leaves a process listening on `127.0.0.1:<alphaPort>` on the person's Mac after the scratch folder is deleted.
   - Fix: in cleanup, take the `pid=` values from `alpha-starts.log`, cross-check them with `lsof -t -iTCP:<alphaPort> -sTCP:LISTEN`, send SIGTERM then SIGKILL, and record what was killed in the evidence.

3. **The skip of relay sequence numbers across a restart is measured but never asserted** — `relayWebJourney.ts:608-615`.
   - Why: design §2.7 and the CLAUDE.md relay rule (write-ahead plus a 1024 skip on each restart) require checking for the skip. `jumpAcrossRestart` is computed and never checked. The reuse and ordering checks add little, because the relay RPC already refuses `sender_sequence <= max` (`src/remoteControlRelaySql.ts:383-386`). With a graceful SIGTERM restart, a regression that removed the 1024 skip would still pass.
   - Fix: require `jumpAcrossRestart >= 1024` (and not null) for the restored web session's `host_to_controller` group.

4. **Manual refresh taps hide a card-follow regression** — `relayWebJourney.ts:433-445`.
   - Why: up to 3 「새로고침」 taps per transition (including the step before start) are accepted silently and only recorded in `cardFollow`. This is the builder's product issue #3, and a further regression in how the card updates itself would also pass.
   - Fix: assert an expected upper bound on taps, or report taps > 0 as a named known issue in the lane outcome or labels rather than only in details.

5. **Origin and CSP problems on the phone are recorded but never fail the lane** — `relayWebJourney.ts:618-621`, `scripts/emulator-e2e/relayWebPhone.ts:108-112`.
   - Why: `aborted()` origins from the web and bundled phones (which would include attempts to reach 3001 or `*.supabase.co`) are never asserted. An HTML page with no CSP at all counts as neither `widened` nor `missing`. That contradicts the module comment "원문 CSP를 찾지 못하면 실패다"; only the unit test's check of `remote/index.html` covers it.
   - Fix: fail when a paired phone has any aborted origin, and require `csp.widened >= 1` for each phone that loaded `/remote/`.

6. **Some stand-ins are not labeled** — `relayWebJourney.ts:66-76`, `relayWebPhone.ts:114`, `relayWebJourney.ts:402`.
   - Why: three differences from production are missing from `labels.standIn`:
     - WebKit runs with the real HOME. Design §2.2 requires a scratch HOME for Playwright; this is written only in `summary.details`.
     - The route serves none of the `vercel.json` `/remote/(.*)` response headers (header CSP, COOP, CORP, X-Frame-Options, `Referrer-Policy: no-referrer`).
     - Every QR is opened with `?tab=workroom` added, which a camera scan never does.
   - Fix: add all three to `STAND_IN_LABELS`. Ideally also apply the `vercel.json` headers in `route.fulfill` (with the same CSP widening) and open one QR unmodified.

7. **The "연결됨 again without a new QR" check passes trivially** — `relayWebJourney.ts:517-528`.
   - Why: if the pill never left 「연결됨」, `waitForPill` returns at once, and `pillWhileStopped` is not asserted. Resume itself is still proved by the start/stop after the restart (starts = 2).
   - Fix: rename the step or drop the claim, or assert a state change if the product is supposed to show one.

8. **`listening(alphaPort)` does not check which process owns the socket** — `relayWebJourney.ts:251-254, 354`.
   - Why: the port is reserved, released, and only bound minutes later. Any process that grabs it in between would satisfy the start and stop checks. This is a low-probability flake.
   - Fix: match the listener's pid to the latest `pid=` in the starts file, the same way `listenerOwnedBy` does in the harness.

9. **The e2e entry only works under Bun** — `tests/remote-relay-real-host.e2e.mjs:13-16`.
   - Why: it uses `import.meta.dir` and `Bun.spawn`, but sibling `*.e2e.mjs` entries are run with `node` by `check-maintainer-web.ts`. Wired the usual way, it would crash.
   - Fix: use `fileURLToPath(new URL('..', import.meta.url))` and `node:child_process`.

Notes (not defects in this diff):
- **Not registering in the check-maintainer-web workroom suite is the right call, but the stated reason is wrong.** 111–134 s fits easily in the 900 s web-workroom budget. The real blocker is that preflight refuses to run inside the registered root (`scripts/emulator-e2e/preflight.ts:155-159`), and the maintainer runs from the main checkout, which is inside it.
- **The first run's overall fail comes from the harness, not this lane.** The run-level simulator check (`runEntries`, part of `emu/integration`) fails the whole run when another worker's simulator, already booted before the run, changes. So lanes that use no simulator can still fail when other workers run at the same time. That is outside this diff.
- **Safety:** I found no connection to 3001, 52741 or 4723 (the phone's route blocks any other origin), no production Supabase, no desktop input, no sudo, keychain or TCC changes, and the host stays under sandbox-exec. The remote portal uses no WebSocket, realtime or service worker, so blocking requests through the route is enough.

Effort: re-running the lane after these fixes is routine wiring work, so a higher setting isn't needed. This is a recommendation only; I don't know whether this surface lets the effort setting be changed.
