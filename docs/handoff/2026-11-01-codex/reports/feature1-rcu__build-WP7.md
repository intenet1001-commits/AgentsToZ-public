# feature1-rcu · build:WP7

(agent final report, verbatim)

Branch `feat/rcu-wp7` (from main, with feat/rcu-wp2, wp3 and wp4 merged) has two new commits. The WP7 panel and its tests pass, but in the real app the A-side 사용 중 rows and the 「공유 총괄 폴더 연결 필요」 line will not show until WP6 passes the new `remoteLink` option in `api-server.ts`. Nothing pushed, nothing committed to main, and the main checkout was not touched.

**Commits**
- `e272643a` feat(computer-use): panel — receive switch, block/cut rows, first notice, A-side usage (WP7)
- `63ca7b3f` test(click-sweep): computer-use status fixture and baseline for the remote controls (WP7)

**What the panel does now**
- **B side, 「다른 Mac의 AI」 section:**
  - The 받기 switch sends `scope-remote-set {allowRemote}`.
  - Each remote connection gets a row 「원격 · <기기> (<코드>)」 showing its grant state, with 「끊기」 (that connection, 30 minutes) and 「이 기기의 AI 막기」.
  - Blocked devices and cut connections are listed with 「풀기」.
  - A state line shows 「받을 수 없음」 for an unsigned build or a missing shared control-folder link.
  - The pointer-input risk is stated in the text (D11: nothing is turned off).
- **First notice:** 「이제 다른 Mac의 AI도 받습니다 · 막기」 stays until the person presses 확인 or 막기.
- **Standing-allowance text** now follows D1, and the old sentence 「커뮤니티의 다른 Mac에서 맡긴 작업도 이 Mac의 AI가 하므로」 is gone.
- **Remote connections** appear only in their own rows. They are left out of the general grant list, the one-window 「AI 연결」 picker and 「연결 종료」.
- **A side:** 「이 Mac의 AI가 <기기>를 사용 중」 per device, with 「끊기」. Only theme tokens are used (no hex colours), and there is no HTML5 drag.

**Files** (under `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_e9d0dfd2-de0-17/`)
- Owned:
  - `src/ComputerUseScopeControls.tsx`
  - `src/ComputerUsePanel.tsx`
  - `tests/computer-use-panel-status.test.ts`
  - `tests/computer-use-panel-ui.mjs`
  - `tests/click-sweep/desktop.json`
- Outside my files, small and additive:
  - `src/computerUseRuntime.ts`: optional `remoteLink: () => {profileReady(), usage(), closeDevice(deviceId)} | null`. Status gains `outgoing[]` and `remote.profileReady` only when a link is given. New management-only operation `scope-remote-outgoing-close {deviceId}`; both the agent and remote routes refuse it.
  - `src/computerUseClient.ts`: the request type gains `scope-remote-set` and `scope-remote-outgoing-close` (types only).
  - `tests/click-sweep.e2e.mjs`: a fake computer-use status so the sweep reaches the new controls (it was previously answered with 503).

**Commands run (final results)**
- `bun run typecheck`: exit 0.
- `bun test tests/computer-use-panel-status.test.ts`: 15 pass, 0 fail. The three WP7 tests drive a real runtime through the buttons' own handlers.
- `bun test tests/computer-use-*.test.ts tests/agent-dialogue-*.test.ts`: 390 pass, 1 skip, 0 fail (32 files). This ran before a later fix that only added a type check in the panel test; that file was re-run afterwards (15 pass).
- `bun test tests/click-sweep-compare.test.ts tests/click-sweep-engine.test.ts tests/tester-click-sweep-enable.test.ts tests/tester-sets.test.ts`: 28 pass, 0 fail.
- `bun scripts/check-maintainer-web.ts computer-use`: passed in chromium and webkit at widths 1100 and 390. The new remote steps check the exact request each switch and button sends.
- `bun scripts/check-maintainer-web.ts click-sweep --update`: 483 targets, 0 errors.
  - 8 new targets: the receive switch, 끊기, 이 기기의 AI 막기, the two 풀기 buttons, the notice's 확인/막기 and the A-side 끊기.
  - The 컴퓨터 유즈 switch and the 전체 Mac/선택한 앱 options now react instead of being disabled, because the fake status reports a ready Control.
- `bun scripts/check-maintainer-web.ts click-sweep` (no `--update`): passed. 483 targets, 0 errors, no lost reactions, no missing targets.

**Left undone or worth noting**
- **WP6 wiring:** WP6 must pass `remoteLink` when it builds `ComputerUseRuntime` in `api-server.ts`, with `profileReady` from the shared profile and `usage()`/`closeDevice()` from the remote client. Until then the panel leaves those parts out without errors.
- **Cut connections can show without a device name.** The saved cut keeps no name, so when no live row of that device exists the cut list shows 「기기 (3a9d)」. Storing a name would change WP2's settings format and break its exact-match tests, so I left it.
- **One unrelated sweep target dropped:** the updated baseline no longer has `#root>#control-profile-panel` (the 아젠투지 설정 dialog itself as a click target). Neither run found it and my change does not touch that dialog.
- **Not run:**
  - `bun run verify` and `cargo test`.
  - The project tester reconcile, because it calls 127.0.0.1:3001, which the task forbids.
  - The persona run.
- **No docs update:** `docs/claude/computer-use.md` is not one of my files.
