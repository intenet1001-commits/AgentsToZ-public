# feature2-viewer · review:pairing

(agent final report, verbatim)

English translation: "Once it's connected, I can just keep using it comfortably, right?"

**wp-pairing review (feat/viewer-pairing, c15de055): 7 defects (1 medium, 6 low)**

Paths are under `native/screen-control/` (builder worktree: /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-13/native/screen-control/).

1. **[Medium, confirmed by reproduction] If the person at B cancels after approving, or a session starts (SR-37), while P6 is arriving, B stores the controller anyway and turns 「다른 Mac 연결 허용」 on.**
   - **Where:**
     - `Sources/ScreenControlCore/ControllerPairing.swift:633-648`: `complete` does not check phase again after it receives P6.
     - `ControllerPairing.swift:650-651`: the comment on `refuse()` promises otherwise.
     - `Sources/ScreenHost/ScreenService+Pairing.swift:192-197`: the store closure does not check `generation`.
   - **Why:** `close()` → `refuse()` → `end()` only ends the connection. If P6 has already been received, verification and the store still run. This breaks the comment's promise ("After an approval it only ends the connection; nothing is stored then") and the intent of SR-37.
   - **Reproduction (temporary probe):**
     - Steps: block the main actor for 1 second so P6 arrives and verifies, then call `pairing.close()`.
     - B: `saves=1`, `allowMacControllers=true`.
     - Events: `[.refused("창 닫음"), .enrolled(...)]`, which contradict each other.
     - B screen: `.closed(notice: nil)`.
     - A: `needsCheck`.
   - **Missing test:** the "after approval" case in `Tests/ScreenControlCoreTests/ControllerPairingChecks.swift:759-764` calls `refuse()` before `complete()`, so it never covers this order.
   - **Fix:**
     - After P6 verifies, move `.approved → .storing` inside the lock, and throw `.refused` if the phase is `.finished`.
     - In the service's store closure, throw when `current != self.generation`.
     - Add a regression test for this order: P6 arrives, then close / sessionStarted.

2. **[Low, code path confirmed] A double click on 「승인」 breaks the approval already in progress** (`ScreenService+Pairing.swift:169-203`).
   - **Why:** nothing marks an approval as in progress. When both calls pass authentication, the second `pending.approve` throws `.refused` and `close()` ends the first approval.
   - **Probe result:** `.closed("등록하지 않았습니다: 등록 창이 닫혔습니다")`, `saves=0`. I did not check whether a real LAContext lets two concurrent authentications both pass.
   - It fails closed, so this is not a security problem.
   - **Fix:** set an in-progress flag before authenticating, ignore a second call, and disable the button meanwhile.

3. **[Low] B's 「기존 항목 바꾸기」 and grant choice carry over to the next pairing in the same window** (`Sources/AgentsToZScreen/ControllerPairingWindow.swift:183-185`, `214-229`).
   - **Why:** the `@State` values (`grant`, `replace`, `replacing`) live as long as the NSWindow.
     - When the person retries with 「등록 창 열기」 after a failure, replacing starts switched on, even though the design says it is off by default. Once S-M3 passes, the grant would also stop defaulting to 「보기」.
     - If the old `replacing` ID is not among the new candidates, `approve` returns at `ScreenService+Pairing.swift:172` without any notice.
   - **Fix:** reset the state on every entry to `.approving` (an `.id(...)` per window number, or a reset on phase change), and give line 172 a notice.

4. **[Low] The Viewer's 「그만두기」 handling** (`Sources/AgentsToZViewer/PairingSheet.swift:176-183`, `191-193`, `205-212`).
   - **Wrong message:** cancelling on the code ① screen shows 「B의 등록 창이 닫혔습니다 … Cloudflare One을 잠시 끄세요」 instead of 「등록을 그만두었습니다」.
   - **Hang:** if `cancel()` or `stop()` arrives at the same moment as P5, the `hostCode` continuation is installed afterwards.
     - The code ② field then appears after the person already cancelled.
     - If the sheet has closed, the continuation leaks and the pairing task never ends. K_A stays in memory only and is never stored.
   - **Fix:**
     - Map task cancellation to `.cancelled`.
     - Check a cancelled flag inside the main-actor hop and resume with nil right away, or wrap the wait in a cancellation handler.

5. **[Low] `ScreenControllerPairing.enterCode(_ code: String)` takes no hardware judgement** (`ScreenService+Pairing.swift:155`).
   - **Why:** `open` and `approve` take `click:`, but code ① entry takes a plain string. The API does not enforce the file header comment or the SR-29 source contract. The only current caller (`PairingCodeField`) does pass the judgement.
   - **Fix:** take a judged submission type or a `ScreenInputRefusal?`.

6. **[Low, test honesty] A test comment claims a case the test does not run** (`Tests/ScreenHostTests/PairingHostTests.swift:246-251`).
   - **Why:** the comment says "at 「승인」 with Touch ID up", but `sessionStarted()` is called before `approve()`. Two paths have no host-level test:
     - a session starting while Touch ID is in progress (`ScreenService+Pairing.swift:183`);
     - a session starting while code ② is on screen (`.showingHostCode`). Finding 1 sits in this gap.
   - **Fix:** add a case that holds `authenticate`, calls `sessionStarted`, then releases it, and a case that calls `sessionStarted` during `showingHostCode`.

7. **[Low, design doc] `DESIGN.md:440` (section 7.1) writes the App Attest clientDataHash as plain concatenation.**
   - **Why:** the code (`ControllerPairing.swift:21-23`, `373-377`) and `reference/controller-pairing.py`, which says it was written "from the specification", both use length-prefixed fields. The code is right, because names vary in length.
   - **Fix:** change the design formula to length-prefixed before the S-K2 vectors are recorded.

**Verification** (temporary worktree `.claude/worktrees/rv-viewer-pairing`, now removed along with the probes)
- `bun run test:screen-control` exited 0: core checks 143/143 (18 of them pairing), XCTest 34 run with 0 failures, including PairingHostTests 9/9. This matches the builder's report.
- `python3 -I reference/controller-pairing.py --check` matches the vectors (2 cases).
- `PairingSheet.swift` compiles at HEAD with a temporary library target. `swift build --product AgentsToZScreen` succeeded.

**Held up in this review**
- Phone golden vectors and the v1–v4 vectors are unchanged; only new vector files were added.
- The tests use only software keys, memory and loopback. They do not touch the keychain, the real screen, TCC or 52741.
- There is no AI, HTTP or MCP entry point.
- `requiresAttestation=false` is tied by a check to the "pending S-K2" block in vectors.json.
- The grant is clamped to 「보기」 until S-M3.
- Also holding: SR-22 (a phone key is refused), SR-31 (P6 is never resent), the busy alarm, each code taken once, and the signature labels kept apart.
- The wiring the builder reported as left to wp-screen-host, wp-screen-ui and wp-viewer-app is not counted as a defect.
