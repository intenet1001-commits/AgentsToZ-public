# Phase 3 work pack contract

A work pack attaches a reviewed read plan to one **local** 규격 명령 so the same procedure runs in
any registered DEV project's task thread. Running one is an ordinary Phase 2 batch: the same
host admission, budgets, thread receipts, `AGENTSTOZ_READ_TOOL_BATCH_ENABLED` gate and
"a known request ID is read, never replayed" rule. Packs start no AI, test, memory write or send.

## Source binding (decision 2026-10-24)

The guide store has no delete/reimport history, so `src/workPackGuideSource.ts` binds a pack to
`(local-guides, this-device, guideId, sha256(body))`; `sourceRevision` is derived from the ID and
the body hash. A changed body → `stale`, a missing ID → `orphan`, a pin/reorder/title change
(library revision only) → still `reviewed`. An identical body under the same ID is the same
command: packs can only run the five read operations, so this equivalence cannot widen
authority. Shared/synced libraries and built-in virtual commands are not pack sources yet.

## Routes

- Management, behind the existing What I Said capability (`/api/what-i-said/guides/packs`, exact
  POST, 8 KiB): `{operation:'list'}`, `{operation:'save',expectedRevision,guideId,plan,queryInput?}`
  (saving *is* the explicit review against the current body), `{operation:'disable',expectedRevision,guideId}`.
- Execution, on the Phase 2 path (`/api/agent-runtime/project-state`):
  `{operation:'pack.run',targetId,threadId,requestId,guideId,values}` and
  `{operation:'pack.read',targetId,threadId,requestId,guideId}`. Responses add
  `completion:{complete,meaning:'read-completion-only',conditions}` (or `null`).
  `pack.run` first reads the request ID's receipt and returns it if it exists.

The only pack input is the memory step's query (`query`, ≤300 chars, reviewed default).
Completion requires every unconditional step to complete; a conditional report is optional.
Completion means reads finished, never that checks passed.

## UI

Inside the read batch dialog of a selected local DEV thread: 「작업 팩」 lists packs (non-reviewed
ones are visible but not runnable) and runs one; after an ordinary batch settles,
「이 조회를 작업 팩으로 저장」 attaches its plan to a chosen 규격 명령.

Tests: `tests/work-pack-host.test.ts`, `tests/work-pack-http.test.ts`, `tests/read-tool-batch-ui.mjs`.
