# emulator-stage1 · build:wp7

(agent final report, verbatim)

WP7 is done and committed on branch `emu/wp7`. The selfcheck passes 43/43, `test:screen-control` and `typecheck` pass, and the production Sources are unchanged. Nothing was pushed or merged.

**Branch:** `emu/wp7`
**Commit:** `35bebe20c33679f00ba027100d4c38cfb852d819`, "test(emulator): add the fixture-only screen host and its selfcheck (WP7)". It ends with the two required trailer lines.

**Files added** (all owned by WP7; no other files touched):
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-4/native/screen-control/Tests/Fixtures/ScreenFixtureHost/main.swift`: the host. Modes: viewer, pinned-device, invite. Takes JSON commands on stdin: end, pin-device, physical-input, status, stop.
- `.../ScreenFixtureHost/FixtureCaptureBackend.swift`: a public stand-in `ScreenCaptureBackend` that sends a synthetic NV12 test card with a frame counter.
- `.../ScreenFixtureHost/Shared/FixtureSupport.swift`: software P-256 signer, POSIX owner-only file writes, JSONL writer, input-event JSON.
- `.../ScreenFixtureHost/Shared/FixturePattern.swift`: paints and reads back the frame counter.
- `.../ScreenFixtureHost/Viewer/main.swift`: a macOS stand-in phone built on Core `ScreenViewer`. Commands: session, expect-refused, parse-invites.
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-4/scripts/emulator-e2e/screenFixtureHost.ts`: build, nm gate, sandbox profile, environment allowlist, source hashes, `start`/`stop` exports, and the `selfcheck|build|serve` commands.

**Verification commands and real results:**
- `bun scripts/emulator-e2e/screenFixtureHost.ts selfcheck` (final run on committed content): `screen-host-selfcheck: pass — 43/43 checks passed in 14.666s`, exit 0.
  - **Viewer session:** 32 pictures received, 32 decoded, counters 0..31 in order.
  - **Input record:** all 16 recorded phone events equal the 16 sent, and nothing was released.
  - **Handshakes and end:** one accepted handshake at protocol v4; the impostor key was refused with `failed unknownDevice`. The Mac ended the session with `endedAtMac` and the phone received that reason.
  - **frames.json:** 32 frames sent.
  - **nm gate:** host and viewer both PASS. None of the 5 required symbols, none of the 23 extended symbols, no forbidden framework.
  - **Other modes:** pinned-device refuses the key before pinning and accepts it after; invite parses correctly and counts 0 connections, then 1 after a test connection.
  - **TCC observation:** 0 prompts.
  - **Sources hash:** before and after are both `9932302d…80d8b9`.
  - **Processes:** none left running.
  - **Evidence:** `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-4/mobile/ios/build/emulator-evidence/screen-host-selfcheck-2026-11-01T04-04-03-208Z/`. It holds `nm-gate.txt`, `tcc-observation.json`, `selfcheck-report.json`, and `viewer/{host-receipts.jsonl,input-events.jsonl,frames.json}`.
- `bun run test:screen-control`: `102/102 screen-control checks passed`; XCTest ran 13 tests with 0 failures; exit 0.
- `bun run typecheck`: `tsc --noEmit`, exit 0. Because `tsconfig.json` does not include `scripts/`, I also ran `tsc --noEmit -p` with a temporary tsconfig covering `screenFixtureHost.ts`: exit 0. The temporary file was deleted.
- `git diff --stat HEAD -- native/screen-control/Sources native/screen-control/Package.swift`: empty.
- The `serve` command was smoke-tested once: ready line, a status reply, an unknown-op reply, then `stopped` with exit code 0 when stdin closed.

**Findings for other packages:**
- **The deny-a-port sandbox pattern does not work.** In SBPL, `(allow network-outbound (remote ip "localhost:*"))` followed by a deny for one port does NOT refuse that port. I measured this on Darwin 25.5 with nc against local listeners, in either rule order and with the `remote tcp`, `network*` and `require-not` forms. Only a port allowlist works. My profile now gives the host no outbound connections at all, and the stand-in phone may only reach the host's port. If WP owners of `sandbox.ts` and the other profiles rely on allow-wildcard-then-deny to keep 3001/52741/4723 out, those ports are not actually blocked.
- **macOS daemons query TCC about the fixture processes.** coreaudiod asked TCC (Microphone, ScreenCapture) about the host until I denied the `com.apple.audio.audiohald` and `com.apple.audio.coreaudiod` lookups. With those denied, it no longer did. WindowServer still runs a ListenEvent query for the system `com.apple.coremedia.videoencoder` service that the real encoder uses. All of these were preflight only (no prompt, no change), answered from grants the terminal app already has.
- **Sandbox denials observed:** the fixture tried to look up `tccd.system` and `windowserver.active`, and the sandbox refused both.

**Deviations and limits:**
- The spec said one swiftc module. I compiled ScreenControlCore as its own static module so `HostStreamer.swift` sees only the public API, as in production.
- The "keychain items 0" and "windows 0" results are structural, not counted. The binaries import no keychain or window API, and securityd, coreauthd and WindowServer are unreachable. I did not read the keychain or list windows, because the rules forbid touching the keychain.
- LAContext and SecureEnclave symbols are still linked in from Core's phone-side code. They are never called, and their services are denied; `nm-gate.txt` notes this instead of failing on it.
- `NSHomeDirectory()` inside the fixture still returns the real `/Users/cs-work` even though `HOME` is the scratch folder. This is recorded for information only; the environment `HOME` is checked strictly.

Nothing is blocked or left undone within WP7.
