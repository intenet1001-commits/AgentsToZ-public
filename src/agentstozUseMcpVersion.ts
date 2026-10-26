import buildInfo from '../build-number.json';

/**
 * The agentstoz_use MCP server's reported version. It used to be a hard-coded
 * "1.20.0" that never moved, so an AI still running an MCP process from an
 * older app build was indistinguishable from a current one. The tool contract
 * part stays semver; the build number (bumped on every release and embedded by
 * `bun build --compile`) goes in the build metadata.
 */
/**
 * 1.21.0: send_workroom_keys, wait_workroom_session, close_workroom_session; start instruction/foreground/reuse; read view.
 * 1.22.0: open_dashboard portId (focus a project); self:true for the calling Workroom; retry-safe reuse and keys;
 *         shift-tab left the key allow-list and a leading ! is refused in instructions.
 * 1.23.0: register_existing_project for a direct child of a registered workspace root.
 * 1.24.0: opt-in cross-device OPS/project dialogue peer, invitation, send and bounded wait tools.
 * 1.25.0: explicit local Workroom shared-shell command and bounded output read tools.
 * 1.26.0: 30-day mutual dialogue pairing — pair_dialogue_peer, list_dialogue_pairings,
 *         revoke_dialogue_pairing. A paired couple opens rooms without a per-room approval and its
 *         invitations are joined by the host; every pairing itself is approved in the app.
 * 1.27.0: the community — community_status and enter_community. One standing group room per Control
 *         profile: a device enters once in the app and then talks with every other member without
 *         invitations. Leaving or closing it is refused for AI connections.
 */
// 1.28.0: 테스터 제안 읽기(`list_tester_proposals`)와 받아들이기(`accept_tester_scenario`) 두 도구 추가.
// 1.29.0: OPS 워크룸 이름 작업 — `read_ai_label_job`·`submit_ai_labels` 두 도구 추가.
// 1.30.0: 페르소나 — `get_tester`가 페르소나 요약을 싣고, `start_tester`의 profileId "personas",
//         `prepare_tester_handoff`의 mode "explore"+personaId(탐색 **초안**, 판정 없음).
// 1.31.0: `open_code_app` — agy가 앱 표면에서 Antigravity 앱을 띄운다(실행만, projectApplied=false),
//         선택 `task`(4,000바이트, 앞 ! 거절): Codex는 새 대화 입력칸에 채우고 보내지 않는다(taskApplied=prefilled),
//         다른 앱·Orca는 받지 못한다. Codex mode `new` 추가. 호스트는 taskApplied를 되돌려 주고, 없으면 HOST_OUTDATED.
// 1.32.0: independent meta common memories, project assignments, candidate proposals and bounded recall.
// 1.33.0: goal-specific cloud memory, pinned project bindings and portable managed SDK projects.
// 1.34.0: cloud source catalog/full entry reads, per-device common-memory project plans and durable result checks.
// 1.35.0: unified cloud knowledge, guarded legacy migration and project memory links.
// 1.36.0: CLI account profiles/default selection and account-bound Workroom sessions.
// 1.37.0: shared-topic OPS draft preparation and read-only update advice in parity with the app.
// 1.38.0: cloud-only source entry reads and topic discovery; evidence-bound proposals and batch human review.
// 1.39.0: common memory is the knowledge linked to long-term memories by memoryId — recall_common_memory takes
//         {memoryId|portId, query} (echo mode "memory", else HOST_OUTDATED), inspect_project_memory_links takes memoryId;
//         the five meta tools and the migration preview/execute tools left tools/list (the host still accepts them);
//         the host refuses AI knowledge review/accept/save-entry/import; list and inspect read only the requested page.
//         Knowledge requests name the group groupId and a long-term memory memoryId (recall {memoryId}, propose-entry's
//         source); the original top-level memoryId-as-group form still parses. The goal/publication tools say they are legacy.
// 1.41.0: common persona templates and reviewed project journey/check extensions.
// 1.42.0: read-only project test-set composition and contextual actor/scenario proposals.
// 1.43.0: cross-device OPS task admission, receiver-side Workroom and explicit result receipts.
// 1.44.0: bound Workroom task-thread progress, questions and actual result publication.
// 1.45.0: project platform-CLI accounts and reviewed, retry-safe GitHub pushes.
// 1.46.0: authenticated project-local historical user-instruction recall, bounded and read-only.
// 1.47.0: cross-agent @/# guidance, bounded role-specific memory references and typed product USE calls.
// 1.48.0: project Workroom USE preparation and explicitly connected generic app action catalogs.
// 1.49.0: 팀 작전 — create/read/wait/report/close team tools: members in their own worktrees, optional per-member model,
//         a leader-merges ledger (src/workroomTeam.ts). A host without action workroom-team answers HOST_OUTDATED.
// 1.50.0: explicit Workroom page grants with bounded observe/click/fill and outcome receipts.
// 1.51.0: workroom_browser observes same/cross-origin frames and open shadow roots (closed ones reported), and adds
//         select (receipted), scroll, bounded wait and a returned-only screenshot (image content).
// 1.52.0: workroom_browser tabs (this Workroom's own tab set only) and switch-tab within that set.
// 1.53.0: workroom_browser wait selectors take only tag/#id/.class parts (no attribute or state test) and match displayed,
//         non-password/hidden/file elements; option lists report moreOptions and truncated options, selectable as shown.
// 1.54.0: create_team members take an optional effort (low/medium/high pins it; omitted = 에포트 자동 from the member's task).
// 1.55.0: team merge questions belong to the checkout the team was cut from (read_team `merged`, close_team's branch
//         deletion — a leader in a linked worktree merges there); read_team members also read `exited` and `unknown`;
//         close_team reports per-member `kept-error` with an `error` and keeps the team open; a retired create
//         requestId is refused (WORKROOM_TEAM_REQUEST_ID_RETIRED) instead of starting a second team.
// 1.56.0: create_team members take an optional role ('reviewer' = read-only member that reviews the workers' branches
//         and reports findings; default worker).
// 1.57.0: create_team members take an optional sessionId: an open Workroom joins (brief typed once, no new worktree,
//         never closed or removed by close_team, whose outcome says `kept`); refused before any side effect otherwise.
// 1.58.0: workroom_browser request-human records a bounded local waiting notice under the current grant/epoch,
//         with an optional HTTP(S) address for open-page; only the person may navigate there.
// 1.59.0: a joining sessionId is judged by that session's checkout root (not the folder it was registered in), one
//         checkout holds one worker, no two members share a branch (nor the base branch), a session on an open team
//         needs that team closed first whatever it waits for, and the request must come from the leading Workroom.
//         sessionId follows the terminal's own id rule (^[A-Za-z0-9_-]{8,160}$) so a brief is never refused mid-submission.
// 1.60.0: explicit project launch choices and live external team-member bindings.
// 1.61.0: read-only, project-scoped recall of locally confirmed personal preferences, separate from OPS and history.
//         Team views return settledCursor for per-reader wait(afterCursor), independent of the legacy settled count.
//         Internal team-member output cursors bind to a session and reset only through verified resumeFrom lineage.
//         Team leader targets are retained when supplied, so verified leader resumeFrom continuations keep their role.
export const AGENTSTOZ_USE_MCP_CONTRACT_VERSION = '1.61.0';

export function agentsToZUseMcpServerVersion(buildNumber: number): string {
  return `${AGENTSTOZ_USE_MCP_CONTRACT_VERSION}+build.${buildNumber}`;
}

/** Build number from a reported version, or null when it predates build stamping or is malformed. */
export function parseAgentsToZUseMcpBuild(version: unknown): number | null {
  if (typeof version !== 'string') return null;
  const match = /\+build\.(\d{1,9})$/.exec(version);
  return match ? Number(match[1]) : null;
}

export const AGENTSTOZ_USE_MCP_BUILD_NUMBER: number = Number((buildInfo as { buildNumber?: unknown }).buildNumber) || 0;
export const AGENTSTOZ_USE_MCP_SERVER_VERSION = agentsToZUseMcpServerVersion(AGENTSTOZ_USE_MCP_BUILD_NUMBER);
