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
export const AGENTSTOZ_USE_MCP_CONTRACT_VERSION = '1.31.0';

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
