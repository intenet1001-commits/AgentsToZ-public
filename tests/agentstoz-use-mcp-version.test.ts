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
    expect(AGENTSTOZ_USE_MCP_CONTRACT_VERSION).toBe('1.31.0');
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
