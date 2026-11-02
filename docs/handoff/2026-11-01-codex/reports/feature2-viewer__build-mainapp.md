# feature2-viewer · build:mainapp

(agent final report, verbatim)

**Answer to your question (한번 연결하면 쭉 쓰는가):** 아니요, 이 설계에서는 그렇지 않습니다.
- **처음 한 번만 하는 것:** Mac 두 대의 등록입니다. 두 Mac 앞에서 숫자 코드를 맞추고 Touch ID를 씁니다.
- **매번 하는 것:** 연결할 때마다 보는 쪽 Mac(A)에서 Touch ID를 받습니다.
- **연결 시간:** 보기만 하는 세션은 60분, 조작은 손대지 않은 채 60분이 지나거나 최대 8시간이면 끝납니다.
- **끊김:** A가 잠기거나 잠들면 바로 끝나고, 자동으로 다시 연결하지 않습니다.

이 작업 묶음(wp-main-app)이 하는 일은 본 앱이 AgentsToZ Viewer를 설치·갱신하고 여는 것까지입니다. 화면 연결 자체는 Viewer 안에서 합니다.

wp-main-app is implemented and committed, and `bun run verify` passes on the committed tree.

**Branch:** `feat/viewer-main-app`, cut from main `f3e96658`. There were no dependency branches to merge.
**Commit:** `467c78e5` feat(viewer): install, update and open AgentsToZ Viewer from the main app

**What changed**
- **One installer for both helpers:** `screen_helper.rs` now installs AgentsToZ Screen and AgentsToZ Viewer (`com.intenet.agentstozbycs.viewer`) the same way. The signature check, symlink refusal, staging and backup/restore are reused, and Screen's install behaviour is otherwise unchanged.
- **No downgrades (SR-35):** for both helpers, a lower CFBundleVersion never replaces the installed one. The newer installed app is kept and is still what gets opened. If either version can't be read, the installed app stays.
- **A running Viewer is never stopped.** Its update waits and is retried when the main app starts, right before the button opens it, and every 10 minutes while an update is waiting. Two edge cases are covered:
  - If the Viewer is opened while the new copy is being made, it is not replaced under it.
  - If the old Viewer is still running from the backup copy after the swap, that backup is kept.
- **New Tauri commands:** `get_viewer_helper` and `open_viewer_helper`, registered in `lib.rs`. Both are async and take no arguments, and opening reports confirmed, failed or not yet confirmed. There is no HTTP route, MCP tool or voice command.
- **Work-mode button:** the panel has a 「다른 Mac 화면 보기」 section with copy in all 7 languages. It is hidden when this app carries no Viewer and none is installed, so it never offers a button that can only fail.

**Files**
- `src-tauri/src/screen_helper.rs`
- `src-tauri/src/lib.rs`
- `src/useViewerHelper.ts` (new)
- `src/WorkModeControl.tsx`
- `src/i18n.ts`
- `tests/work-mode-screen-helper.test.ts`
- `tests/work-mode-ui.mjs`
- `tests/fixtures/voice/popout.tsx` — outside my file list. I added the two Viewer command stubs there because the work-mode UI test needs them.

**Verification (real runs)**

| Command | Result |
|---|---|
| `cargo test --lib screen_helper` | 30 passed, 0 failed, 1 ignored (an existing opt-in test that needs a signed Screen) |
| `bun test tests/work-mode-screen-helper.test.ts tests/feature-copy-language.test.ts` | 12 pass, 0 fail |
| `bun tests/work-mode-ui.mjs` | passed in Chromium and WebKit |
| `bun run typecheck` | 0 errors |
| `bun scripts/check-maintainer-web.ts click-sweep` | passed: 476 targets, 443 clicks, 0 unresponsive, 0 errors |
| `bun run test:screen-control` | 102/102 checks, 13/13 XCTest |
| `PATH="/usr/bin:$PATH" bun run verify` | exit 0 (breakdown below) |

The `verify` breakdown:
- maintainer: 138 OK
- `tsc`: OK
- `bun test`: 9808 pass, 0 fail, 12 skip (9820 tests in 1108 files)
- `cargo test`: 157 passed, 0 failed, 1 ignored

**Not done, and things other packages need**
- **Click-sweep baseline:** I did not run `--update` and `tests/click-sweep/desktop.json` is unchanged. The sweep runs in a browser, where the work-mode panel doesn't render, so the run found exactly the same 476 targets as the baseline.
- **wp-viewer-build** must match what the installer expects:
  - the bundle at `Contents/Helpers/AgentsToZ Viewer.app`
  - an executable named `AgentsToZViewer`
  - a Developer ID signature for team `DA8QKAQ2C9`, the same requirement shape as Screen
  - a CFBundleVersion in the `N.0.0` form
- **Screen behaviour change (wp-docs-tester):** a separately built push Screen with a higher build number is no longer overwritten by the bundled one. Two places still say "overwritten if the signature differs": `docs/claude/remote-control.md` (around line 289) and a comment in `tests/screen-push-config.test.ts`.
- **Manifest (wp-docs-tester):** `.agentstoz/maintainer.json` `public-guide-contracts` should add `src/useViewerHelper.ts` to its paths and the cover 「Open the Mac viewer from work mode」.
- **Retries:** a failed install is not retried every 10 minutes. It is tried again at the next app start or when the button is pressed.
- **Not tested here:** the installer has never run against a real signed Viewer, because none is built yet. No signing or notarization was done, the real screen and keychain were not touched, and nothing connected to 52741 or 3001.
