# Mobile Workroom stability verification

Goal: the approved iPhone can enter the selected project's Workroom, see CLI
startup failures, send/receive work, and retain its 30-day connection across app
updates. Old UI receipts can be tidied without deleting memory or changing a
save result. Verify AI Tasks alongside the Workroom.

## Evidence and implementation

- Installed Mac baseline v453; iPhone main app baseline v451.
- Current internet connection is approved and has a durable 30-day Workroom grant.
- iPhone Mirroring was configured for iPhone 13 Pro Max. Changed the system's
  selected device to iPhone 17 Pro, connected, and observed `TypeError: Load failed`
  / `RELAY_REQUEST_FAILED` in the real app. Mirroring then closed at user request;
  prioritize USB execution/logs and repeatable automated checks.
- Workroom entry waited for an extra remote list round trip before navigation.
  Navigate immediately and let the panel resolve the selected project's session.
- Each tiny PTY callback consumed one of four chunks per response. Pack adjacent
  stored chunks into the existing 1,024-character / 8,500-byte response budget;
  preserve original cursor boundaries and all output.
- A selected terminal disappearing on process exit hid startup errors. Retain
  the terminal, final output and exit code until the user selects/dismisses it.
- Live Codex initially left a combined instruction + Enter in its composer.
  A separate Enter produced the requested response. Split pasted text from
  Enter for every CLI (Codex 150 ms; other providers 40 ms). A second live
  Codex check using the fixed service confirmed a response in 9,943 ms, including
  MCP startup wait. One earlier probe misclassified an ANSI-styled response;
  after correcting its text normalization, the live check passed.
- An expired ten-minute outbound envelope could erase a still-valid thirty-day
  approval. Replace only that uncertain delivery with an authenticated pairing
  checkpoint, persist the sequence/checkpoint atomically, and never replay the
  command. Only a valid encrypted pairing checkpoint may bridge a sender gap.
- Add reversible previous-receipt display storage. Pending, saving, retrying and
  backup jobs remain visible; changed states reappear. No queue/memory deletion.

## Completion checks

- [x] Focused unit and real-PTY regressions
- [x] React/xterm entry, exit, input and history-reset tests (33 usability + 12 lifecycle groups)
- [x] Relay restart, offline, expiry and retained-grant tests (41 focused tests;
  day 29 host/controller restart preserves approval and expiry, day 30 closes;
  delivered/undelivered uncertain input never replays; ordinary commands cannot bridge gaps)
- [x] Full repository verify: TypeScript clean; 4,200 Bun tests / 0 failures;
  58 Rust tests / 0 failures. Full retry completed in about 322 seconds for Bun.
- [x] Mac installed update and approved identity/expiry retained
- [x] Web deployment and mobile smoke/performance
- [x] USB iPhone main-bundle update without clearing its data
- [ ] Actual selected project Workroom input/output; AI Tasks smoke
- [x] Apply the requested old-record display reset, preserve original records

Thirty elapsed days cannot be asserted from a short test. Use controlled-clock
boundary tests and actual restart/update evidence; record untested physical
network transitions explicitly.

## Additional checks

- Synthetic 300 PTY callbacks: 75 responses before packing, 2 after packing,
  with identical text and resumable cursors. This measures response count, not
  internet round-trip latency.
- AI work request UI: 9 groups passed, including visible Control coordinator
  and four selectable worker CLIs.
- Chromium and WebKit mobile panels: record paging, reviewed draft, one memory
  save, backup distinction, and reviewed duty enable passed with fixture data.
- Native networking: 11 regression groups plus real native/Bun pairing, action,
  restore, redirect rejection and request cancellation passed.
- Actual iOS WKWebView on an owned disposable simulator: LAN/PTY/consent/draft,
  explicit stop, background/cold resume without QR, disconnect/revoke and redirect
  checks passed. These are simulator checks, not physical iPhone user testing.
- USB device query confirms iPhone 17 Pro, iOS 26.6, wired/paired/connected.
  Installed main bundle before update is v451.0.0.
- Hermes default remains `claude-opus-5`. Its local credential status reports
  logged in; a rendered live probe subsequently confirmed Anthropic 401 with
  Bearer OAuth/setup-token authentication. A successful model response remains
  unverified. Do not repeat inference probes until authentication changes.
- First full verification: 4,158 pass / 42 fail / 3 errors. Failures include
  actual `ENOSPC` / `SPACE_LOW` and I/O timeouts while simulator/CLI checks ran.
  Removed about 1.3 GiB of regenerable iOS derived builds only (preserved signed
  main-app baseline, source, memory and receipt evidence); free space about 11 GiB.
  The affected ten test files then passed 70/70. A subsequent full verify without
  overlapping heavy probes passed (4,200 Bun + 58 Rust, TypeScript clean).
- The owned installed diagnostic Codex terminal was closed; no other live
  terminal was listed before cleanup. Temporary direct-service CLI probes also
  shut down only their own processes.
- Follow-up with actual xterm buffer reconstruction confirmed Claude in 3,290 ms
  and Antigravity in 7,831 ms after submission (startup excluded). Each received
  a no-tools/no-files marker request, and the exact standalone reply was checked.
  All temporary CLI probes shut down their own sessions. This validates the live
  CLI service, not the physical iPhone screen.

## Installed v454 and deployment evidence

- Implementation `e0282f4`; official version bump `a233a51` pushed to main.
  Public snapshot also pushed (candidate `723a101`).
- Mac installed v454.0.0 with the same signing identity. The existing approved
  internet session, its expiry `2026-10-12T17:00:43.309Z`, and durable Workroom
  grant survived the update. Host status is online with no reported relay error.
- USB inspection confirms the iPhone 17 Pro main bundle
  `com.intenet.agentstoz.mobile`, v454.0.0, build `260912175231`. Its stored
  Workroom origin remained nonempty and unchanged; no app data was cleared.
- The configured personal portal's `/release-meta.json` identifies
  v454.0.0 / source `a233a51868200411a391e28c3a8893aae7fcebd3`.
  Desktop portal smoke 3/3, mobile 375px smoke 4/4 passed.
- Production portal performance: five cold and five warm browser runs on this
  Mac at a 390px viewport, no CPU/network throttling. Cold FCP/LCP p95 300 ms;
  warm 216 ms; CLS 0 and TBT 0 for both. Budgets passed. This measures the portal
  shell on this network, not authenticated relay/AI latency or cellular speed.
- Actual Mac UI displayed all 138 saved projects after one normal restart.
  Applied the old-record reset: 39 previous receipts (14 needing review) folded;
  four pending saves remain visible. No original records or statuses were erased.
- An installed Workroom Codex request for `이렇게만들었어요` produced the requested
  marker in its PTY output, but its visible native terminal appeared blank.
  A redraw and tab remount did not establish a visible response. Keep this open.
  The normal Chromium/WebKit fixture passes output/size/visibility checks;
  a private recording replay at different terminal dimensions is inconclusive.
- Mac became locked during native inspection. UI automation cannot unlock it.
  Continue non-UI checks; actual Mac/iPhone screen verification needs the user
  to unlock the Mac. Do not classify this as complete physical-device testing.
- Tab remount also reset the new-terminal selector to the first registered
  project. Follow-up source change persists project and CLI selectors per
  session scope; explicit project entries still override them. All 34 Workroom
  usability groups passed; final full verification is recorded below.
- Added `tests/workroom-rendering.e2e.mjs`: production CSS, actual xterm, paged
  synchronized TUI frames and Korean text, visibility/resizing on Chromium and
  WebKit at desktop/mobile sizes. Four rendering checks pass without test-only
  terminal sizing. These do not replace the unresolved native-screen check.
- Closed the owned installed marker-test session after reading its result; other
  CLI sessions were not stopped. No temporary rendered CLI probes remain active.

## Additional failures found during soak and follow-up verification

- At about 03:24 KST the installed sidecar stopped answering both ordinary ports
  and remote-status requests (8/12-second timeouts). The process remained alive.
  Native sampling found its main thread blocked in `read`; its open descriptor
  was a registered Documents/iCloud project's `.git/HEAD`. `ls -lO` confirmed
  `dataless`. The synchronous metadata cache stamp was attempting to download
  this placeholder, stopping the whole API event loop. This is not evidence
  that the device approval was revoked.
- Added a bounded, inode-pinned local metadata reader. On macOS its synchronous
  read uses the thread-scoped materialization opt-out and restores the prior
  policy in `finally`, following [Apple TN3150](https://developer.apple.com/documentation/technotes/tn3150-getting-ready-for-data-less-files).
  The actual blocked placeholder returned unavailable in 66 ms from Bun and
  1.5 ms from a compiled standalone probe, without materializing its contents.
  Ordinary Unicode files, oversize metadata, symlinks/FIFOs and policy restoration
  have focused regression coverage. The fix still needs official install and soak.
- A follow-up full verify found a real first-identity race: 4,199 pass / 1 fail.
  One process observed an O_EXCL-created empty host key before the creator wrote
  it. Host identity reads/creation now share the existing short SQLite file
  coordinator transaction. Corrupt or missing-existing-key states still do not
  rotate an identity. Eight concurrent first readers agree on one complete key.
- Focused local-metadata and durable-grant checks pass 13/13. Final full verify
  passed 4,206 Bun / 58 Rust with TypeScript clean, including the final API
  integration guard (`/tmp/agentstoz-v455-final-verify.log`).
- Existing but unreadable Git HEAD metadata now marks that one inventory row
  unknown and skips its Git discovery subprocess. A new isolated API regression
  uses a FIFO HEAD and confirms ordinary ports and other project inventory stay
  responsive; the focused integration file passes 11/11. A terminal binding
  cannot treat unavailable HEAD metadata as an unchanged checkout.
- Rendering fixtures now include the actual top-level terminal panel ID so its
  production flex rules participate. Chromium/WebKit desktop/mobile still pass
  all four rendering checks; the locked native screen remains unverified.

## Installed v455 follow-up

- Implementation `514c75c`, official bump `a16064e`, both pushed to main. The
  official build passed the clean, published-source guard and normal signing.
- The old API answered again immediately before installation, so no forced
  termination was needed. Installed through `/api/install-app`; the installer
  retained the old app bundle and reopened v455.0.0. A status request during
  replacement timed out; subsequent requests returned online normally.
- Existing approved controller, its exact expiry, and durable Workroom grant
  remained unchanged. Status took 10 ms and inventory 44 ms in one measured
  concurrent sample. Inventory includes 102 available targets with `complete:
  false` (some registrations remain unavailable); the selected project is present.
- A no-tools/no-files request through the installed API, using the exact initial
  prompt path shared by AI Tasks and Workroom, started Codex for
  `이렇게만들었어요` in 90 ms and produced the exact standalone marker after
  6,248 ms including startup. Reconstructed the actual xterm stream and closed
  only that owned diagnostic session. This confirms execution and output data,
  not visibility on the physical iPhone or the unresolved native Mac screen.
- USB confirms main iPhone app v455.0.0 / build `260912184926`, source `a16064e`.
  Its existing Workroom connection preference is unchanged and the app launched.
- Personal web portal deployed v455; mobile smoke passed 4/4. First public
  snapshot attempt correctly refused a personal portal URL newly recorded in
  this document; replaced it with the portable endpoint description above.
  The corrected public snapshot then published successfully (`2e0fef5`).
- The soak file retains both failures and recovery: at 03:52 KST, 59 samples
  included 39 online and 20 timeout samples. Recent samples were online with
  unchanged approval/expiry; this is not a whole-night pass.
- Recovered the legacy runtime supervisor's old manual lock after inspecting
  its exact dead owner: no tasks, guard records, live/lifecycle requests or
  unfinished turns; both stored conversations were idle and all three turns
  succeeded. Recorded the original lock and evidence privately, then used
  `recoverDeadManualFileLock` with that expected owner. No conversations were
  deleted and no other process was terminated.
- With no running Workroom sessions or active memory saves, sent normal TERM
  only to the inspected sidecar. Its native supervisor relaunched it. Legacy
  read-only Codex capability is now available, both conversations are listed,
  and remote status is online with the exact same approval and expiry.
  Managed writable SDK execution remains subject to its existing capability
  gate; do not equate that separate interface with Workroom CLI execution.
- Rechecked native UI access after installation: the Mac is still locked.
  Requested manual unlock and kept non-UI work running. The actual native
  blank-terminal issue and physical iPhone interaction remain open.

Night continuation heartbeat: `agentstoz`, every 30 minutes on this task, stops
at completion or 2026-09-13 09:00 Asia/Seoul. Preserve active work and use this
document to resume unfinished verification; do not report all checks as complete.

Read-only overnight soak also runs until 09:00: `/tmp/agentstoz-overnight-soak.py`
records 30-second samples in `/tmp/agentstoz-overnight-soak.jsonl`: relay status,
last-contact age, approval/expiry equality, local status latency and app/sidecar
RSS. It never starts a CLI, changes a grant or stores a credential. Review the
whole interval rather than claiming a multi-hour pass from the initial samples.

## 04:30–04:42 KST continuation

- At 04:30, all 81 post-update soak samples were online, with no approval/expiry
  changes or reported relay errors; status p95 17.89 ms, maximum 65.98 ms.
  The earlier 20 outage samples remain in the file and are not erased.
- Native UI became operable through CUA. Selected `이렇게만들었어요` in the
  installed app and started one no-tools/no-files Codex marker request. The
  actual output buffer includes its completed response at the current 55×16
  terminal dimensions; closed only that owned diagnostic session afterward.
- The native window screenshot initially appeared blank; focusing its terminal
  rendered a prompt line. A separate system WKWebView probe, with a retained,
  focused, centered floating window, reports `isVisible=true`, active Space,
  but `occlusionState.visible=false` and `document.visibilityState=hidden`.
  Buffer parsing succeeds while DOM animation-frame rendering is suspended.
  Thus this automation environment does not prove a foreground native renderer
  defect. Do not patch xterm internals or force background rendering on that
  inference. Unoccluded physical-screen confirmation remains open.
- Extended the real-xterm Chromium/WebKit test with 150 lines received while
  the same terminal is hidden, followed by restoration and resize. All four
  desktop/mobile cases display the new marker without replacing the terminal.
  This covers paused-renderer restoration beyond the previous remount checks.
- Briefly opened iPhone Mirroring only for remaining screen evidence. It targets
  iPhone 17 Pro, but reports `iPhone in Use` and requires the phone to be locked.
  Closed mirroring; did not lock or change the phone or its connection.
- Prepared an isolated USB XCUITest that activates the existing main app and
  navigates Home/Remote Work without changing its connections. Recorded the
  already-signed v455 app path for the eventual test-run configuration;
  the generated xctestrun was not reached and no fixture app was installed.
  `build-for-testing` failed before any installation: `No Accounts` and missing
  development profile for `com.intenet.agentstoz.mobile.uitests.xctrunner`.
  Existing main-app profiles suffice for updates, but do not authorize a new
  UI test runner. Xcode account/provisioning setup or a user-locked phone for
  mirroring is needed before physical UI automation can proceed. Do not repeat
  the same build until that prerequisite changes.
- No production source changed in this continuation. The new rendering
  regression and evidence are additional validation; existing v455 tests and
  installed artifacts remain the baseline. Hermes authentication is unchanged;
  no inference retry was made.
