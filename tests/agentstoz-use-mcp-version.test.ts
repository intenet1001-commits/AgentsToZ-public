import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  AGENTSTOZ_USE_MCP_CONTRACT_VERSION,
  AGENTSTOZ_USE_MCP_SERVER_VERSION,
  agentsToZUseMcpServerVersion,
  parseAgentsToZUseMcpBuild,
} from '../src/agentstozUseMcpVersion';
import { handleAgentsToZUseMcpRequest } from '../agentstoz-use-mcp-server';

const buildNumber = JSON.parse(readFileSync(new URL('../build-number.json', import.meta.url), 'utf8')).buildNumber as number;

describe('agentstoz_use MCP server version comes from the build', () => {
  test('the version carries the app build number', () => {
    expect(AGENTSTOZ_USE_MCP_SERVER_VERSION).toBe(agentsToZUseMcpServerVersion(buildNumber));
    expect(parseAgentsToZUseMcpBuild(AGENTSTOZ_USE_MCP_SERVER_VERSION)).toBe(buildNumber);
  });

  test('the tool contract version moves with the tool set', () => {
    // 1.21.0: send_workroom_keys, wait_workroom_session, close_workroom_session and the
    // start/read options for cross-agent orchestration.
    // 1.22.0 (deliberate bump): open_dashboard takes a portId, the calling Workroom is marked
    // self:true, and shift-tab left the key allow-list. 1.23.0 registers existing projects;
    // 1.26.0 adds the dialogue pairing tools; 1.27.0 adds the community (status + enter);
    // 1.28.0 adds the tester proposals (read) and accept (adopt one into the project layer);
    // 1.29.0 adds the OPS Workroom naming job (read a page, submit names);
    // 1.30.0 adds personas (get_tester summary, start profileId "personas", handoff mode "explore").
    // 1.31.0: open_code_app agy app launch, optional task (Codex prefill), Codex mode "new".
    // 1.32.0: independent meta common memory naming, links, candidate proposals and recall.
    // 1.33.0: goal-specific cloud memory and portable managed SDK projects.
    // 1.40.0 adds context persona discovery, review, acceptance and rejection.
    // 1.42.0 adds project-set composition and contextual role candidates.
    // 1.43.0 adds receiving-device OPS execution and explicit task results.
    // 1.49.0 adds 팀 작전 (team create/read/wait/report/close).
    // 1.50.0 adds explicitly granted, bounded Workroom browser operations.
    // 1.51.0 adds frames/shadow observation, select, scroll, bounded wait and a returned-only screenshot.
    // 1.52.0 adds the Workroom's own tab set (tabs, switch-tab).
    // 1.53.0 narrows wait selectors to tag/#id/.class and reports cut option lists (moreOptions, truncated).
    // 1.54.0 adds a per-member effort to create_team (pinned, or omitted for 에포트 자동).
    // 1.58.0 adds request-human to the bounded Workroom browser tool.
    // 1.59.0 hardens how an open session joins a team (checkout root, one worker per checkout).
    // 1.60.0 gives a team member the project launch choices (accountId, bypassPermissions, surface, launchOptions)
    // and the manual path an external surface needs (confirm_team_member, report manual: true).
    // 1.61.0 separates confirmed personal preferences from OPS and historical instructions.
    expect(AGENTSTOZ_USE_MCP_CONTRACT_VERSION).toBe('1.61.0');
    expect(AGENTSTOZ_USE_MCP_SERVER_VERSION.startsWith(`${AGENTSTOZ_USE_MCP_CONTRACT_VERSION}+build.`)).toBe(true);
  });

  test('older fixed versions parse as unknown build, not as a match', () => {
    expect(parseAgentsToZUseMcpBuild('1.20.0')).toBeNull();
    expect(parseAgentsToZUseMcpBuild('')).toBeNull();
    expect(parseAgentsToZUseMcpBuild(agentsToZUseMcpServerVersion(7))).toBe(7);
  });

  test('initialize reports it, so a stale MCP process is distinguishable', async () => {
    const response = await handleAgentsToZUseMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect((response?.result as any)?.serverInfo?.version).toBe(AGENTSTOZ_USE_MCP_SERVER_VERSION);
    const source = readFileSync(new URL('../agentstoz-use-mcp-server.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/SERVER_VERSION\s*=\s*"\d/);
  });
});
