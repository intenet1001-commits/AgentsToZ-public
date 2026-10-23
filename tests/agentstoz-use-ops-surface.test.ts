import {expect, test} from 'bun:test';
import {agentsToZUseMcpActionForTool} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';

const examples = [
  ['open_dashboard', {}],
  ['open_code_app', {agent: 'codex', mode: 'prepare', bypass: true}],
  ['open_code_app', {agent: 'agy', surface: 'orca-worktree'}],
  // Antigravity.app: launch/focus only, the host reports projectApplied:false.
  ['open_code_app', {agent: 'agy', surface: 'app'}],
  // A task: Codex gets it as a prefilled new thread, other apps report taskApplied:false (host side).
  ['open_code_app', {agent: 'codex', task: '로그인 화면을 고쳐 주세요.'}],
  ['open_code_app', {agent: 'codex', mode: 'new', task: '여러 줄\n작업 요청'}],
  ['open_code_app', {agent: 'agy', surface: 'app', task: '로그인 화면을 고쳐 주세요.'}],
  ['open_code_app', {agent: 'claude', task: '/review 해 주세요'}],
  ['list_workroom_sessions', {}],
  ['start_workroom_session', {agent: 'hermes', requestId: 'ops_start_12345'}],
  ['read_workroom_session', {sessionId: 'session_12345', after: 2}],
  ['send_workroom_instruction', {sessionId: 'session_12345', requestId: 'ops_input_12345', instruction: '상태를 확인해 주세요.'}],
  ['start_workroom_session', {agent: 'claude', requestId: 'ops_start_67890', instruction: '첫 지시', foreground: false, reuse: true}],
  ['read_workroom_session', {sessionId: 'session_12345', view: 'screen'}],
  ['send_workroom_keys', {sessionId: 'session_12345', requestId: 'ops_keys_12345', keys: ['1', 'enter']}],
  ['wait_workroom_session', {sessionId: 'session_12345', idleMs: 2000, timeoutMs: 20000}],
  ['close_workroom_session', {sessionId: 'session_12345', requestId: 'ops_close_12345', saveMemory: true}],
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
    {target: 'ops', agent: 'gpt'},
    // task: same natural-language rules as a Workroom instruction, app surface only, new Codex thread only.
    {target: 'ops', surface: 'orca-floating', task: '고쳐 주세요'},
    {target: 'ops', agent: 'agy', surface: 'orca-worktree', task: '고쳐 주세요'},
    {target: 'ops', mode: 'prepare', task: '고쳐 주세요'},
    {target: 'ops', mode: 'reopen', task: '고쳐 주세요'},
    {target: 'ops', task: '!rm -rf ~'},
    {target: 'ops', task: '  !whoami'},
    {target: 'ops', task: '가'.repeat(8_001)},
    {target: 'ops', task: 'a'.repeat(24_001)},
    {target: 'ops', task: '줄\u0007벨'},
    {target: 'ops', task: '   '},
    {target: 'ops', task: 42},
    {target: 'ops', agent: 'claude', mode: 'new'},
  ]) {
    const input = {agent: 'codex', ...args};
    expect(() => agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', input, 'controller')).toThrow();
    expect(() => parseAgentsToZUseActionRequest({action: 'open-code-app', controllerPortId: 'controller', ...input})).toThrow();
  }
  for (const action of ['project-status', 'create-project']) {
    expect(() => parseAgentsToZUseActionRequest({action, controllerPortId: 'controller', target: 'ops', portId: 'dev'})).toThrow();
  }
  // task belongs to open_code_app only; a Workroom start carries its request as instruction.
  expect(() => parseAgentsToZUseActionRequest({action:'start-workroom-session',controllerPortId:'controller',target:'ops',agent:'codex',requestId:'no_task_1234',task:'고쳐 주세요'})).toThrow();
  expect(() => agentsToZUseMcpActionForTool('agentstoz_use_start_workroom_session', {target:'ops',agent:'codex',requestId:'no_bypass_123',bypass:true}, 'controller')).toThrow();
  expect(() => parseAgentsToZUseActionRequest({action:'start-workroom-session',controllerPortId:'controller',target:'ops',agent:'codex',requestId:'no_bypass_123',bypass:true})).toThrow();
});

test('legacy project launches remain unchanged and cannot inherit OPS implicitly', () => {
  const action = agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {portId: 'dev', agent: 'codex'}, 'controller');
  expect(action).toEqual({action: 'open-code-app', controllerPortId: 'controller', portId: 'dev', agent: 'codex'});
  expect(parseAgentsToZUseActionRequest(action).target).toBeUndefined();
  expect(() => agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {agent: 'codex'}, 'controller')).toThrow();
});

test('a task at the 24,000-byte bound passes both boundaries unchanged (the sidecar decides the Codex prefill), one byte more is refused by both', () => {
  // The MCP boundary uses the sidecar's own bound: whether the task fits the Codex link is the sidecar's call
  // (taskApplied:false, taskReason too-large), so a 5,000-byte Claude task is no longer refused here.
  const fits = 'a'.repeat(24_000);
  const action = agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', {portId: 'dev', agent: 'codex', task: fits}, 'controller');
  expect(action.task).toBe(fits);
  expect(parseAgentsToZUseActionRequest(action).task).toBe(fits);
  // CRLF is folded and the text trimmed exactly as for a Workroom instruction.
  expect(parseAgentsToZUseActionRequest({action: 'open-code-app', controllerPortId: 'c', portId: 'dev', agent: 'hermes', task: ' 첫 줄\r\n둘째 줄 '}).task).toBe('첫 줄\n둘째 줄');
  const codes = (input: Record<string, unknown>) => {
    const errors: string[] = [];
    for (const run of [
      () => agentsToZUseMcpActionForTool('agentstoz_use_open_code_app', input, 'controller'),
      () => parseAgentsToZUseActionRequest({action: 'open-code-app', controllerPortId: 'controller', ...input}),
    ]) { try { run(); errors.push('accepted'); } catch (error) { errors.push((error as any).code); } }
    return errors;
  };
  expect(codes({portId: 'dev', agent: 'codex', task: fits + 'a'})).toEqual(['AGENTSTOZ_USE_CODE_APP_TASK_TOO_LARGE', 'AGENTSTOZ_USE_CODE_APP_TASK_TOO_LARGE']);
  expect(codes({portId: 'dev', agent: 'codex', task: '!ls'})).toEqual(['AGENTSTOZ_USE_CODE_APP_TASK_SHELL_PREFIX', 'AGENTSTOZ_USE_CODE_APP_TASK_SHELL_PREFIX']);
  expect(codes({portId: 'dev', agent: 'codex', surface: 'orca-floating', task: '고쳐'})).toEqual(['AGENTSTOZ_USE_CODE_APP_TASK_SURFACE_INVALID', 'AGENTSTOZ_USE_CODE_APP_TASK_SURFACE_INVALID']);
  expect(codes({portId: 'dev', agent: 'codex', mode: 'prepare', task: '고쳐'})).toEqual(['AGENTSTOZ_USE_CODE_APP_MODE_INVALID', 'AGENTSTOZ_USE_CODE_APP_MODE_INVALID']);
});
