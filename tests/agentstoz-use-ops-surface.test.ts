import {expect, test} from 'bun:test';
import {agentsToZUseMcpActionForTool} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';

const examples = [
  ['open_dashboard', {}],
  ['open_code_app', {agent: 'codex', mode: 'prepare', bypass: true}],
  ['open_code_app', {agent: 'agy', surface: 'orca-worktree'}],
  ['list_workroom_sessions', {}],
  ['start_workroom_session', {agent: 'hermes', requestId: 'ops_start_12345'}],
  ['read_workroom_session', {sessionId: 'session_12345', after: 2}],
  ['send_workroom_instruction', {sessionId: 'session_12345', requestId: 'ops_input_12345', instruction: '상태를 확인해 주세요.'}],
  ['connect_buzz_channel', {channelId: '123e4567-e89b-42d3-a456-426614174000', channelName: 'OPS 운영'}],
  ['open_buzz_dev', {}],
] as const;

for (const [name, args] of examples) {
  test(`OPS ${name} uses the same MCP tool without a project ID or cwd`, () => {
    const action = agentsToZUseMcpActionForTool(`agentstoz_use_${name}`, {target: 'ops', ...args}, 'agentstoz-profile');
    expect(action.target).toBe('ops');
    expect(action).not.toHaveProperty('portId');
    const parsed = parseAgentsToZUseActionRequest(action);
    expect(parsed.target).toBe('ops');
    expect(parsed.portId).toBeNull();
    for (const [key, value] of Object.entries(args)) expect((parsed as any)[key]).toEqual(value);
  });
}

test('both boundaries reject ambiguous targets and invalid launch options instead of silently choosing a project', () => {
  for (const args of [
    {target: 'ops', portId: 'dev'}, {target: 'managed'}, {target: null},
    {target: 'ops', surface: 'shell'}, {target: 'ops', bypass: 'true'},
    {target: 'ops', surface: 'orca-floating', mode: 'prepare'},
    {target: 'ops', agent: 'agy'},
  ]) {
    const input = {agent: 'codex', ...args};
    expect(() => agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', input, 'controller')).toThrow();
    expect(() => parseAgentsToZUseActionRequest({action: 'open-code-app', controllerPortId: 'controller', ...input})).toThrow();
  }
  for (const action of ['project-status', 'create-project']) {
    expect(() => parseAgentsToZUseActionRequest({action, controllerPortId: 'controller', target: 'ops', portId: 'dev'})).toThrow();
  }
  expect(() => agentsToZUseMcpActionForTool('agentstoz_use_start_workroom_session', {target:'ops',agent:'codex',requestId:'no_bypass_123',bypass:true}, 'controller')).toThrow();
  expect(() => parseAgentsToZUseActionRequest({action:'start-workroom-session',controllerPortId:'controller',target:'ops',agent:'codex',requestId:'no_bypass_123',bypass:true})).toThrow();
});

test('legacy project launches remain unchanged and cannot inherit OPS implicitly', () => {
  const action = agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {portId: 'dev', agent: 'codex'}, 'controller');
  expect(action).toEqual({action: 'open-code-app', controllerPortId: 'controller', portId: 'dev', agent: 'codex'});
  expect(parseAgentsToZUseActionRequest(action).target).toBeUndefined();
  expect(() => agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {agent: 'codex'}, 'controller')).toThrow();
});
