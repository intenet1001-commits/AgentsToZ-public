# feature2-viewer · review:mainapp

(agent final report, verbatim)

English translation: "Once it's connected, you just keep using it comfortably, right?"

**Verdict: no blocking defects.** Nothing high or medium. I found five low-severity items and one doc follow-up, ranked below.

**What I re-ran** (temporary worktree `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/rv-viewer-mainapp`, now removed; main tree is clean):

| Command | Result |
|---|---|
| `cargo test --lib screen_helper` | 30 passed, 0 failed, 1 ignored (the opt-in signed-Screen test) |
| `bun test tests/work-mode-screen-helper.test.ts tests/feature-copy-language.test.ts` | 12 pass, 0 fail |
| `bun tests/work-mode-ui.mjs` | passed in Chromium and WebKit |
| `bun run typecheck` | 0 errors |

I did not re-run full `verify`, click-sweep or `test:screen-control`.

**Design and security checks that passed**
- **Scope:** the diff touches only the 8 listed files. Nothing under `native/` or `mobile/`, no golden vectors, Supabase, MCP, HTTP route or voice command. Input-origin enforcement, push gates and keep-on/unlock are not touched.
- **Open command:** `open_viewer_helper` is async, takes no arguments and answers in 3 states (confirmed, failed, not yet confirmed).
- **A running Viewer is never stopped.** For the Viewer, line 452 returns before the stop at 453. The rollback stop at 482 can only run after a relaunch, which is Screen-only.
- **SR-35:** a lower CFBundleVersion is refused for both Screen and Viewer.
- **Test isolation:** Rust tests write only to temporary scratch folders, and codesign/plutil run only on temporary fixtures. Nothing touches `/Applications`, TCC, the keychain, 52741 or 3001.
- **Version format:** build-macos.ts writes CFBundleVersion as `N.0.0`. Development builds write `2`, older builds `1`. All of these parse.
- **Builder's answer to the user is accurate.** Register once in front of both Macs, Touch ID on A for every connection, view sessions end after 60 min, control after 60 idle min or 8 h, and A locking or sleeping ends the session with no automatic reconnect. This matches DESIGN.md:362-363, 655 and 810.

**Ranked findings (all low)**

1. **The Viewer's running check is too early** — `src-tauri/src/screen_helper.rs:450-465`.
   - **Why:** the check at 450-452 runs before a second full `codesign --verify --deep` at 459-463, then the swap at 465. That second check is only needed after Screen was stopped. For the Viewer it makes the gap longer: someone can open the Viewer from the Dock in that gap, and its files get renamed to the backup while it runs. Keeping the backup (line 503) only helps if `pgrep` already sees the process.
   - **Fix:** when `defer_while_running` is set, do the running check right before `rename_new(destination, &backup)`. Or skip the second verify when nothing was stopped.

2. **A kept Viewer backup is never removed** — `screen_helper.rs:497-506`.
   - **Why:** when the old Viewer is still running from the backup, the backup is kept. No later pass removes it. An older, team-signed `.AgentsToZ Viewer-backup-<token>.app` stays in `/Applications` with the same bundle ID and can still be launched, which weakens SR-35.
   - **Fix:** at the next startup or deferred check, remove leftover `.{stem}-backup-*.app` bundles that pass the team signature check, are not running, and are not newer than the installed one.

3. **An unreadable version blocks opening an installed helper** — `screen_helper.rs:421-422` (with `open()` at line 627).
   - **Why:** refusing to install is correct. But the error stops `open()`, so the button cannot open even a properly signed installed copy. Today's builds never hit this.
   - **Fix:** treat a version-read failure like "keep the installed one" (log a warning) instead of an error, so `open()` still opens the checked installed app.

4. **Update-pending copy promises too much** — `src/i18n.ts` `viewerUpdatePending`, in all 7 languages.
   - **Why:** 「다음에 열 때나 10분 안에 바뀌어요」 is true only when the Viewer is opened with this panel's button. Opening it from the Dock, Launchpad or Finder does not apply the update.
   - **Fix:** say "the next time you open it here", or equivalent, in all 7 languages.

5. **No Rust test for the 3-state open** — DESIGN §16, Rust item 「3-상태 열기」.
   - **Why:** `open()` has no Rust test for confirmed, not-yet-confirmed and failed. Only the TypeScript mock covers them, and Screen was already in the same state.
   - **Fix:** put the open and wait steps behind the existing actions trait and test all three answers with a fake.

6. **Doc follow-up (not this package)** — `docs/claude/remote-control.md:289` and a comment in `tests/screen-push-config.test.ts`.
   - **Why:** both still say the bundled Screen overwrites any differently signed Screen. Now a Screen with a higher CFBundleVersion is kept.
   - **Fix:** the builder already handed this to wp-docs-tester; make sure it lands there, together with the `maintainer.json` change for `src/useViewerHelper.ts` and the 「Open the Mac viewer from work mode」 cover.
