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

## 05:16 KST read-only follow-up

- All 172 post-update samples were online, with no approval/expiry changes or
  reported relay errors. Status p95 16.8 ms, maximum 65.98 ms; the 63 samples
  since the previous check also had no failures. Current API probe returned
  online in 8.73 ms. The original pre-fix outage remains in the complete log.
- The connected iPhone's installed main-app icon was retrieved with
  `devicectl device info appIcon --allow-placeholder false`. The device returned
  the actual gold/cyan icon, visually inspected from the generated PNG. This
  confirms an installed icon rather than merely an asset in the source tree.
  Private evidence: `/tmp/agentstoz-phone-icon-0516.png`.
- No account/provisioning or Hermes authentication change was reported. Did
  not repeat the blocked XCUITest build, inference request, app installation,
  or connection approval. No new product-source change was needed.
- At 05:48, all 237 post-update samples remained online with unchanged approval
  and expiry; cumulative status p95 17.6 ms, maximum 65.98 ms. The new 66-sample
  interval also had no errors. Kept the existing soak running and did not repeat
  the blocked physical UI or authentication operations.
- At 06:20, all 300 post-update host-status samples remained online, with no
  approval/expiry changes or relay errors; cumulative p95 17.89 ms, maximum
  65.98 ms. The latest interval's sidecar RSS ranged 88.3–195.4 MiB, within the
  observed post-update range. A separate immediate API probe returned online
  in 81.33 ms. These are host/relay observations, not 300 physical-phone actions.
- At 06:51, all 362 post-update host-status samples were still online without
  approval/expiry changes or relay errors; cumulative p95 17.39 ms, maximum
  115.82 ms. No new failure or changed prerequisite justified another build,
  installation, inference call, or connection mutation.
- At 07:23, all 425 post-update host-status samples remained online, with no
  approval/expiry changes or relay errors; cumulative p95 17.39 ms, maximum
  115.82 ms. The new 65-sample interval had no failures. The physical UI test
  still awaits its previously reported prerequisite; the existing iOS view
  does not enable Web Inspector as an alternative inspection channel.

## USB priority and remote permission clarity (07:45 KST onward)

- User needs to disconnect the iPhone within an hour. Prioritize the installed
  iPhone 17 Pro and actual remote Workroom before other overnight follow-ups.
- The approved-device card showed an unavailable managed Codex execution scope
  as "안전 격리 준비 중", although the separate CLI Workroom grant was valid.
  Show the actual Workroom grant and expiry, provide a Workroom navigation
  button, label retained Codex conversations read-only, and hide the unavailable
  managed scope unless an older grant needs revocation. No execution gate,
  controller identity, approval, or expiry is changed by this UI correction.
- Full validation: TypeScript clean, 4,206 Bun tests and 58 Rust tests pass.
  Real React approval regression: 8/8, including persisted grant display,
  unavailable scope absence, navigation, and grant-only partial-success retry.
- Xcode Accounts is still empty and Mirroring reports iPhone in use. Apple's
  supported `lldb device process attach` can attach to this already-signed
  development app without a second test-runner profile. USB inspection confirmed
  the real iPhone's visible WKWebView, restored logged-in portal, remote host
  "connected/responding", and 20/108 projects including the reported project.
  A UIKit screenshot from the actual app was captured; no simulator substitute,
  private credential copy, new controller, or re-pairing was used.
  Further physical Workroom action results are recorded below when verified.

### Actual iPhone Workroom failure and v457 correction

- On the existing iPhone internet connection, selecting the reported project
  reproduced "프로젝트 실행 대상을 안전하게 확인하지 못했습니다" before CLI start.
  The host remained online. The shared remote-to-runtime resolver threw for
  any unresolved registration in the whole binding list, including unrelated
  projects in an incomplete inventory, preventing every Workroom list/start.
- Resolve only uniquely verified directory identities and omit each unresolved
  or ambiguous binding. Duplicate control/runtime identities never choose an
  arbitrary winner. Requested unresolved projects remain blocked, with a
  project-specific path/Git diagnostic; unrelated verified projects retain
  their existing grant and the runtime's per-action identity revalidation.
- Full final verification: 4,210 Bun tests, 58 Rust tests, and TypeScript pass
  (`/tmp/agentstoz-v457-final-verify.log`). Includes real encrypted relay/PTY
  verification that one unresolved registration cannot block the valid target
  and still cannot start its own process. An obsolete source-location assertion
  was updated for the extracted resolver; the entire verify command was rerun.
- The real iPhone accepted the test draft in its Workroom composer. Additional
  project pages loaded while preserving that selected project and draft. The
  test was deliberately left before start for the installed-host recheck.
- v456 contains the permission-card correction and was built but not installed;
  the combined correction will replace installed v455 after v457 packaging.

### Installed v457 and physical iPhone response

- Installed the official v457 Mac build after checking that no terminal or
  memory save was running. The already-open iPhone restored its existing
  controller approval and the same expiry after the host restart, without QR
  pairing. Its unsent draft survived. Temporary project IDs changed on restart,
  so the UI requested explicit project reselection instead of guessing a target.
- From the actual iPhone Workroom, started Codex on the reported project with
  a no-tools/no-file-access probe. Both the host PTY and the actual iPhone's
  rendered terminal showed `IPHONE-REMOTE-READY-457`. Closed only that probe
  session through the phone UI; the host subsequently reported it exited.
  Private physical screenshot: `/tmp/agentstoz-iphone-codex-response-v457.png`.
- The phone terminal initially sat below the viewport. Its offscreen xterm
  renderer paused painting, making received output appear absent until scrolled
  into view. Reveal the selected remote terminal once when opening/returning;
  subsequent output must preserve the user's deliberate scroll position.
- Chromium and WebKit, desktop and mobile rendering checks pass 4/4, including
  automatic reveal below a tall project-controls area and no scrolling caused
  by subsequent output (`/tmp/agentstoz-v458-rendering.log`).
- Full verification also passes: TypeScript, 4,210 Bun tests, and 58 Rust tests
  (`/tmp/agentstoz-v458-verify.log`).
- Public web deployment was verified at v457.0.0. The physical native app still
  used its older installed wrapper during the host upgrade test; its separate
  update/relaunch result is recorded after completion. No cellular handoff
  result is claimed without observing the phone change networks.

### v458 physical update, cold restart, and continued input

- Installed official Mac v458 and the same-bundle iPhone 17 Pro USB development
  app v458.0.0, source `4620c7c`, build `260912232915`. The phone's own bundle
  metadata and loaded web footer both confirmed v458. The existing logged-in
  portal and approved remote connection returned without QR pairing. The Mac's
  controller identity and original expiry were preserved across both updates.
- Started Claude Code from the actual iPhone on the reported project. Its
  displayed answer was `IPHONE-CLAUDE-READY-458`. The terminal automatically
  appeared within the 724px viewport (top 212, bottom 512), without a manual
  scroll. Physical evidence: `/tmp/agentstoz-iphone-claude-response-v458.png`.
- Detached the debugger, terminated and relaunched only the phone app, then
  reopened the project Workroom. The same host CLI session and its output were
  recovered. Sent a second instruction through the phone's terminal input and
  Enter control; the actual rendered answer was `IPHONE-RESUMED-458`.
  Evidence: `/tmp/agentstoz-iphone-resumed-v458.png`.
- The first close overlapped relay activity and reported another request in
  progress. After that activity completed, the phone close succeeded and the
  host confirmed the owned test session exited. This is not a first-tap success.
  Claude's post-response Stop hooks also took roughly 30 seconds; distinguish
  those hooks from delivery of the already displayed model response.
- Removed only diagnostic files created for this USB test from the phone's
  Documents directory and cleanly detached LLDB. The user was told the USB
  cable could be removed before the one-hour deadline. The remote connection
  remains enabled; no user session, approval, or memory was deleted.
- After USB cleanup, reproduced a relay scheduling issue in an encrypted
  controller test: a new periodic refresh could take the free slot before a
  waiting terminal close. Reserve that slot for bounded command waiters;
  preserve existing timeout, pending-request guards, and single-send behavior.
  The new regression fails before the change; all 35 controller tests pass
  after it. Full verification passes with TypeScript, 4,211 Bun tests, and
  58 Rust tests (`/tmp/agentstoz-v459-verify.log`; this log label is the planned
  follow-up iteration, not a native v459 installation). This portal-controller
  change ships through the web deployment; installed native apps remain v458.
- At 08:47 KST, all 593 host-status samples since 03:50 were online, with no
  approval/expiry changes or probe failures; p95 status latency was 20.62 ms.
  Sampling can miss a short planned installer restart and is not evidence of
  continuous phone actions. The scheduled observation still ends at 09:00.
- Local session memory and its journal were marked saved; Supabase reported
  content, journal, and complete backup success. Remaining evidence gaps:
  cellular/Wi-Fi handoff, Hermes's previously observed Anthropic 401, and the
  exact slow Claude Stop hook. The final relay scheduling change is covered
  by encrypted regression tests; it has not been retested on the phone after
  USB cleanup. No existing CLI plugin or user hook was disabled to hide delay.

### Workroom session controls follow-up

- Added the selected-session footer: measured context usage, confirmed local
  memory-save time, manual save, and a modal save/skip/cancel exit flow. See
  `docs/workroom-session-controls.md` for runtime support and receipt semantics.
- Chromium and WebKit mobile tests pass all 14 save/close, recovery, cancel,
  permission, lost-response and changed-activity scenarios. Real React+xterm
  input, output and session switching regressions pass 12/12. These fixtures
  never call a model or modify actual project memory.
- V2 segment saves intentionally retain the legacy whole-project baseline.
  Exit therefore compares the save admission's project-activity evidence and
  input revision with current evidence, rather than requiring the old badge to
  disappear. Memory writes themselves do not count as new project work.
- The user changed the physical test target to the USB-connected iPhone 13 Pro
  Max. Device connectivity and Developer Mode were verified; iPhone 17 Pro is
  no longer the physical test target. The 13 Pro Max has no detected AgentsToZ
  installation. The ordinary installation attempt stopped before installing:
  Xcode lacks the existing app development-team account, and its provisioning
  profile does not contain the newly selected phone. Account authentication
  was requested; no credential, device approval or signing identity was changed.
- The overnight heartbeat, whose deadline was 09:00 KST, was paused during
  this follow-up. The explicitly
  requested Workroom follow-up continues independently of that completed timer.
- Final frozen-source verification passed TypeScript, 4,219 Bun tests and 58
  Rust tests (`/tmp/agentstoz-workroom-release-verify.log`). The separate web
  production build passed. Native and web installation evidence follows the
  source verification; the iPhone signing blocker remains separate.
- Official Mac v459 was built from feature commit `4f00049` and installed with
  the standard staged installer; version commit `cd715db` was pushed. The same
  approved controller and original expiry were confirmed after replacement.
- The installed host opened an owned Claude CLI, returned correctly bound
  Workroom memory status, and reported an actual 16% Claude statusline reading
  after a bounded marker instruction. The probe was closed with explicit skip;
  no production memory-save result is claimed from this display-only probe.
- Production web v459 was deployed from `cd715db`; the mobile portal smoke
  passed 4/4. The public snapshot publication completed. These results do not
  remove the iPhone 13 Pro Max signing/account blocker.


### iPhone 13 Pro Max installation follow-up

- Resolved the signing blocker after the user completed Xcode authentication.
  The authenticated development team differed from the previously selected team.
  Verified that its provisioning profile included the selected USB device, then
  passed that team explicitly to the existing development installer. No account
  credentials, provisioning secrets, or personal portal address are recorded here.
- Installed and launched the main app bundle on iPhone 13 Pro Max: v459.0.0,
  build 260913013641, source `19bda523`. This was a fresh installation, so it
  does not prove preservation of an existing connection on this phone.
- USB UIKit inspection confirmed the actual first-run screen and version. The
  personal portal address was entered through the native text field. The app
  remained on the “작업 공간 열기” screen; a Google login screen was not observed.
  Portal login, new-device pairing, and v459 Workroom save/exit actions on this
  phone remain unverified. Do not conflate Apple signing authentication with
  portal authentication or claim that login was required without observing it.
- Removed the owned screenshot diagnostic from the app container and detached
  LLDB cleanly, leaving the app running. Existing Mac remote approvals were not
  revoked or replaced. No mirroring was used for this physical inspection.
