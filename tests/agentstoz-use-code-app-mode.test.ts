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

for (const [agent, mode] of [['claude', 'prepare'], ['hermes', 'prepare'], ['claude', 'new'], ['agy', 'new'], ['codex', 'run-shell'], ['codex', null]]) {
  test(`rejects unsupported mode ${agent}/${mode} at both boundaries`, () => {
    expect(() => agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {
      portId: 'registered-project', agent, mode,
    }, 'controller')).toThrow();
    expect(() => parseAgentsToZUseActionRequest({
      action: 'open-code-app', controllerPortId: 'controller', portId: 'registered-project', agent, mode,
    })).toThrow();
  });
}

test('mode=new opens a new Codex conversation at both boundaries (contract 1.31.0)', () => {
  const action = agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {portId: 'registered-project', agent: 'codex', mode: 'new'}, 'controller');
  expect(action.mode).toBe('new');
  expect(parseAgentsToZUseActionRequest(action).mode).toBe('new');
  // Not the prepare budget: a new conversation sends nothing.
  expect(agentsToZUseMcpTimeoutMs(action)).toBe(120_000);
});

test('a Codex task always travels with mode=new (an older host refuses it before opening anything) and never with prepare or reopen', () => {
  const action = agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {portId: 'registered-project', agent: 'codex', task: '첫 요청'}, 'controller');
  expect(action).toMatchObject({agent: 'codex', task: '첫 요청', mode: 'new'});
  expect(parseAgentsToZUseActionRequest(action)).toMatchObject({agent: 'codex', task: '첫 요청', mode: 'new'});
  // An older AgentsToZ accepted only reopen/prepare: `new` is refused at parse time, so it cannot drop the
  // task and reopen the old conversation first.
  // Other apps take no mode at all; their task is reported as not delivered.
  const claude = agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {portId: 'registered-project', agent: 'claude', task: '첫 요청'}, 'controller');
  expect(claude.mode).toBeUndefined();
  for (const mode of ['prepare', 'reopen']) {
    expect(() => agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {portId: 'registered-project', agent: 'codex', mode, task: '첫 요청'}, 'controller')).toThrow();
    expect(() => parseAgentsToZUseActionRequest({action: 'open-code-app', controllerPortId: 'controller', portId: 'registered-project', agent: 'codex', mode, task: '첫 요청'})).toThrow();
  }
});
