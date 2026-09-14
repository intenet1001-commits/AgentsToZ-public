import {expect, test} from 'bun:test';
import {agentsToZUseMcpActionForTool, agentsToZUseMcpTimeoutMs} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';

test('explicit first-conversation intent survives MCP and host parsing', () => {
  const action = agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {
    portId: 'registered-project', agent: 'codex', mode: 'prepare',
  }, 'controller');
  expect(action.mode).toBe('prepare');
  expect(parseAgentsToZUseActionRequest(action).mode).toBe('prepare');
  expect(agentsToZUseMcpTimeoutMs(action)).toBeGreaterThanOrEqual(120_000);
});

test('opening an existing conversation never implicitly sends a first message', () => {
  const action = agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {
    portId: 'registered-project', agent: 'codex',
  }, 'controller');
  expect(action.mode).toBeUndefined();
  expect(parseAgentsToZUseActionRequest(action).mode).toBeUndefined();
});

for (const [agent, mode] of [['claude', 'prepare'], ['hermes', 'prepare'], ['codex', 'run-shell'], ['codex', null]]) {
  test(`rejects unsupported mode ${agent}/${mode} at both boundaries`, () => {
    expect(() => agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {
      portId: 'registered-project', agent, mode,
    }, 'controller')).toThrow();
    expect(() => parseAgentsToZUseActionRequest({
      action: 'open-code-app', controllerPortId: 'controller', portId: 'registered-project', agent, mode,
    })).toThrow();
  });
}
