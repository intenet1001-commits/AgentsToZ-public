# Follow-up evidence — 2026-09-12

## Completed: visible AI Tasks mission coordinator — 2026-09-13

- AI Tasks now separates a direct single-CLI launch from an AgentsToZ mission.
  The mission launches a visible coordinator in the registered
  `AgentsToZ-Control` Workroom and can select Codex, Claude, Hermes, and agy as
  workers.
- The strategy choice is provider-neutral AgentsToZ coordination or the same
  Control/target-memory scope with cs-ceo goal decomposition and review. cs-ceo
  does not own sessions, receipts, resume state, or memory promotion.
- The coordinator prompt requires exact project-name resolution, durable
  mission creation, read-before-instruct for full-screen CLIs, one writer per
  checkout, verified results, and no automatic replay after uncertainty.
- Repeated memory-save receipts are grouped by exact target and state in the
  Workroom UI while the durable queue and raw counts remain unchanged.
- A concurrent Workroom start no longer blocks a newer routed voice/text draft;
  the late receipt cannot clear the new draft or select another session.
- Typecheck, the complete Bun suite (4,188 pass / 0 fail), all 58 Rust tests,
  9 isolated AI Tasks UI groups, and all 30 isolated Workroom usability groups
  pass. Installed package/mobile delivery is recorded separately when complete.

## Completed: local store recovery and retry guards

- `OrchestrationMissionStore.create` now verifies that an existing request receipt
  belongs to `mission-created`. Reusing a pause/action request ID with the same
  mission title and goal previously returned success; it now raises
  `MISSION_REQUEST_CONFLICT` without changing the mission.
- `OrchestrationMissionStore.#key` rejects missing metadata when missions or
  events exist, and rejects multiple metadata rows. Previously, losing metadata
  and the key could create a replacement key and write a new verifier before
  failing decryption. The store now reports `MISSION_METADATA_INVALID` before
  key creation and preserves the records for recovery.
- Both reproduced failures have behavioral regression tests. They are included
  in the focused mission checks and the full repository verification below.

## Completed: four-agent voice Workroom and resumable mission reads

- The bounded AgentsToZ USE/MCP bridge can start and instruct Codex, Claude,
  Hermes, and agy through the same registered-project Workroom runtime. The
  desktop navigation handoff accepts all four agents and opens the exact session
  returned by the sidecar.
- Mission event history now uses bounded keyset pagination (`afterEventId`,
  `eventLimit`, `nextEventId`, `hasMore`). A cursor must belong to the selected
  mission, so one mission cannot be used to probe another mission's continuation.
- On sidecar startup, missions left `active` by the previous process are changed
  to `interrupted` in one transaction. Paused and completed missions are kept;
  no mission resumes without the user's explicit `resume` transition.
- A Workroom start or instruction that carries an interrupted or paused mission
  ID is rejected before the terminal side effect. The real API restart test
  verifies interruption, the no-session-before-resume boundary, explicit
  resume, and continued agy Workroom execution with mission recording.
- Real PTY integration covers Codex, Claude, Hermes, and agy start plus
  instruction delivery through the same bounded API.
  Focused voice/mission/model checks pass (24 tests, 179 assertions), as do the
  focused Workroom/UI checks. The first full Bun run
  had one unrelated timed `agent-runtime-restart-e2e` progress-wait failure; the
  same test passed immediately alone (1 test, 163 assertions). A subsequent
  complete `bun run verify` passed, including typecheck, the full Bun suite, and
  all 58 Rust tests. `git diff --check` also passes.

## Completed: portable control-center project

- The public MCP contract now has a dedicated control-center creation tool. It
  creates portable control documents before the initial Git snapshot and gives
  the project its own long-term-memory identity.
- The desktop tools area exposes **Control 바로 열기**. It opens the registered
  `AgentsToZ-Control` directly; when absent, it opens the create/clone flow with
  the portable name prefilled.
- Another Mac restores the same control center through the existing GitHub
  clone path. Git carries the documents and memory config; the clone path pulls
  Supabase by repository lineage before it can push a new empty memory.
- This project remains separate from the encrypted live mission store and from
  each target project's own memory.

## Local installation baseline

- The installed v443 app predates these source changes. It remains untouched.
- This Mac exposes all four required CLIs: Codex CLI 0.154.0, Claude Code
  2.1.269, Hermes Agent 0.20.6, and agy 1.2.1.
- The existing E2EE mobile Workroom already offers all four agents through the
  same `AiTerminalService`; its connection restore, permission revocation, and
  session ownership regressions pass in the full suite.

## Unpublished package evidence

- Source commit `88685a7` produced an explicit local-only v444 `.app` and DMG
  through `bun build-macos.ts --allow-unpublished-source`. The installed v443
  app was not replaced, and the artifacts are not approved for distribution.
- `codesign --verify --deep --strict` passes for the v444 app. Its packaged MCP
  server reports version 1.9.0, exposes the four-agent Workroom enum, and carries
  the bounded mission pagination fields. The packaged API sidecar contains the
  runtime-restart interruption and explicit-resume guard.
- Local DMG SHA-256:
  `ff9bacb4d0f89baf1030ec58b3d384bf25e46647cccedd240dcbf51d491f94a3`.

## Remaining delivery work

- Review UI and explicit global-preference promotion (design step 6): expose
  candidate references for review, keep project memory canonical, and record the
  user's explicit promotion decision. Candidate creation alone is not a saved
  project memory or a promoted preference.
- Account-scoped synchronization (design step 7) remains deferred until local
  recovery and conflict behavior pass installed-app tests; use a separate
  versioned migration.
- Installed-app validation: exercise voice start/instruct/read/restart/resume for
  all four locally installed CLIs. Source fixtures prove the shared runtime
  contract, not provider login, profile selection, or installed GUI focus.
