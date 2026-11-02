# emulator-stage2 · review:wp4

(agent final report, verbatim)

Seven defects, ranked by severity. The highest are two test20 steps that pass without exercising what they claim, and an exit-code change that breaks the ios-ui check on some Macs. Unit tests in a temporary worktree (since removed): `tests/lan-journey-host.test.ts` plus `tests/emulator-e2e-guards.test.ts` gave 61 pass / 0 fail, and `tests/emulator-sandbox.test.ts`, `tests/emulator-screen-fixture-host.test.ts` and `tests/emulator-supabase-shim.test.ts` gave 91 pass / 0 fail. I booted no simulator. I found no safety-rule violation in the code paths.

1. **The resume step passes even if socket restore is broken.**
   - Where: `mobile/ios/UITests/WorkspaceUITests.swift:201-208`, `mobile/ios/scripts/lan-journey-host.ts:200-205`, and the labels at `scripts/emulator-e2e/lanJourney.ts:40-41`.
   - Why: `LANWorkroomSession.end(.background)` returns immediately (`LANWorkroomView.swift:362`). It keeps the WebView and relies on the page to restore its own socket after iOS suspends networking. A 3-second Home press in the simulator never drops the socket.
   - The builder's own receipts confirm it: no `lan.sessions` change between pairing (seq 3) and disconnect (seq 17), and `managementIds` stayed 1 at "resumed". The unit-test fixture assumes 2.
   - So the restore path never ran, and the "resumed" check (1 session, 1 controller, no replay) cannot fail if restore breaks. The labels still claim "restore" and "background → foreground resume" as real paths.
   - Fix: force a real drop during the background window. For example, `server.stop({keepRecord:true})` (closes with 1012), then restart with `restore`, or have the host close the socket with 1001. Then require in "resumed" that `managementIds >= 2` and that receipts show a disconnected → connected transition. Otherwise remove "restore/resume" from the real-path labels and the checklist row.

2. **The consumed-URL replay step can pass without the host ever refusing anything.**
   - Where: `WorkspaceUITests.swift:236-242` and `lan-journey-host.ts:210-214`.
   - Why: the test accepts the native `workroomEnded` view, which also shows on a page-load failure (`ended == .failed`). The host records no pairing attempt, and its checks (`sessions === 0`, counts unchanged) hold trivially if the phone never reached it. A load failure or a local refusal in the app would pass as "the Mac refuses the consumed URL".
   - Fix: require the web page's own 「연결 종료」, which proves the host served the page and closed the pairing. Have the host record a refused-pair receipt, for example by watching `#handleHttp`/`/remote/` hits or an error on the socket, and require it in the "replayed" phase.

3. **A blocked LAN host makes the whole ios-ui manifest check fail and silently drops the gesture lane.**
   - Where: `mobile/ios/scripts/check-ui-suite.py:10` (`check=True`), with `check-ui.py:436-439` (exit 78).
   - Why: on a Mac with no private IPv4 on en0 (a Mac mini on Wi-Fi, an Ethernet adapter on another interface), check-ui.py exits 78. That happens only after a full build and boot. The suite then raises and exits 1, so the runner records "failed", not "blocked", and `--screen-gestures` never runs. Before this branch, ios-ui passed on those Macs.
   - Fix:
     - Check en0 before building.
     - Have the suite run both lanes and pass 78 through only when everything else passed.
     - Declare `notApplicableExitCode: 78` on the ios-ui check. Alternatively, mark test20 as skipped (recorded as blocked in result.json) instead of aborting the lane.

4. **The test-step timeout went from 600 s to 900 s, against design §7.**
   - Where: `check-ui.py:408`; the comment at `lanJourney.ts:31` describes the new limit.
   - Why: design §7 says the build 600 / boot 480 / test 600 limits do not change. The measured test step took 130 s. ios-ui runs check-ui twice inside a 1800-second cap.
   - Fix: restore 600 and update the comment.

5. **The port race the design ruled out is back, with a window of minutes.**
   - Where: `lanJourney.ts:167` (`reserveLanPorts(1)`) and `lan-journey-host.ts:364-369`.
   - Why: the port is taken by binding and releasing `127.0.0.1:0` at lane start. The host binds it on en0 only after the portal build, the xcodebuild build and the simulator boot (up to ~20 minutes cold). The probe also checks loopback, not en0. If another process takes that ephemeral port, the host fails to start and the lane reports fail with no retry. Design §2.5 requires binding port 0 and reading it back for exactly this reason.
   - Fix: choose the port right before `start_lan_host`, or let the supervisor pick it and report it back, and arm the harness guard then. At minimum, retry on EADDRINUSE with a fresh port.

6. **The lane ignores the firewall state that preflight measures.**
   - Where: `lanJourney.ts:157` (preconditions check only `en0PrivateIpv4`).
   - Why: preflight records `capabilities.firewall`, but j1-lan does not use it. This Mac's firewall is off, so the passing run says nothing about the firewall-on case. With it on, binding bun on en0 may pop a macOS "accept incoming connections" prompt on the person's desktop (not verified). Nobody answers it, and the lane ends as fail, not blocked as the safety rule requires.
   - Fix: make the precondition return blocked when the firewall global state or block-all is enabled.

7. **The sandboxed host never exits on its own if its supervisor dies abruptly.**
   - Where: `lan-journey-host.ts:390` (`stdin: 'ignore'`) and `:667`.
   - Why: `serve` stops only on SIGTERM/SIGINT, with no parent-death watch and no lifetime limit. If the supervisor alone is SIGKILLed (for example `check-ui.py` start_lan_host's `process.kill()` path, or an external kill), the en0 listener and its unused 30-minute pairing stay up indefinitely. The design says en0 is open only while the run lasts.
   - Fix: have `serve` poll the parent pid (or keep a stdin pipe from the supervisor) and exit on EOF, plus a hard self-stop slightly after `PAIRING_TTL_MS`.
