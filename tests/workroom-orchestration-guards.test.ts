import {afterEach, describe, expect, test} from 'bun:test';
import {
  AGENTSTOZ_USE_MCP_INSTRUCTIONS,
  AGENTSTOZ_USE_MCP_TOOLS,
  agentsToZUseMcpActionForTool,
  agentsToZUseMcpTimeoutMs,
  handleAgentsToZUseMcpRequest,
} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {
  WORKROOM_KEY_NAMES,
  WORKROOM_WAIT_CLIENT_MARGIN_MS,
  WORKROOM_WAIT_LIMITS,
  WORKROOM_WAIT_RENDER_ALLOWANCE_MS,
  normalizeWorkroomKeys,
  workroomWaitBudgetMs,
} from '../src/workroomOrchestration';
import {WorkroomRequestLedger} from '../src/workroomRequestLedger';
import {
  AGENTSTOZ_CALLER_PROCESSES_HEADER,
  AGENTSTOZ_CALLER_SESSION_HEADER,
  AGENTSTOZ_CALLER_TARGET_HEADER,
  parseProcessTable,
  parseWorkroomCallerHint,
  processAncestry,
  workroomCallerHeaders,
} from '../src/workroomCaller';

const description = (name: string) => AGENTSTOZ_USE_MCP_TOOLS.find(tool => tool.name === `agentstoz_use_${name}`)!.description;
const schema = (name: string) => AGENTSTOZ_USE_MCP_TOOLS.find(tool => tool.name === `agentstoz_use_${name}`)!.inputSchema as any;

describe('B3: Claude Code keeps only about the first 2,000 characters of MCP instructions', () => {
  // Measured: this session's own copy of the installed instructions was cut at ~2,095 characters.
  const LIMIT = 2_000;
  const phrases = [
    'Any connected agent (codex, claude, hermes or agy) may start and drive a Workroom of any agent',
    'start → wait → read (view=tail) → send → wait → read → close',
    'agentstoz_use_send_workroom_keys',
    'does not need long-term memory',
    '바이브2',
    'confirm with the user',
    '‘<프로젝트> 열어’ → agentstoz_use_open_dashboard',
    '‘<프로젝트> 담당자 불러’ → agentstoz_use_start_workroom_session with reuse=true',
    'agentstoz_use_send_workroom_instruction (target=ops',
    'self:true',
    // Dispatch (contract 1.31.0): a project to a Workroom CLI, or to a desktop app with a task.
    '‘<프로젝트>를 <CLI>로 워크룸에서 시작’ → start_workroom_session(portId, agent, instruction)',
    '‘<프로젝트>를 <앱>에서 열어’ → open_code_app(portId, agent, surface=app, task)',
    'only Codex takes task (prefill requested, unsent)',
    // Review N2: the rules Claude Code saw before the brief was added must still fit.
    'treat the remaining words as an AgentsToZ request',
    'First call agentstoz_use_get_control_profile',
    'Call agentstoz_use_resolve_target with the spoken or typed target before acting',
    'use only IDs returned by these tools',
    '아젠투지오피에스',
  ];
  for (const phrase of phrases) {
    test(`«${phrase.slice(0, 40)}…» ends before character ${LIMIT}`, () => {
      const at = AGENTSTOZ_USE_MCP_INSTRUCTIONS.indexOf(phrase);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at + phrase.length).toBeLessThanOrEqual(LIMIT);
    });
  }
  test('the loop sentence is not duplicated in full elsewhere', () => {
    const loop = 'start → wait → read (view=tail) → send → wait → read → close';
    expect(AGENTSTOZ_USE_MCP_INSTRUCTIONS.split(loop)).toHaveLength(2);
  });
});

describe('B6: descriptions word delivery conditionally', () => {
  test('a multi-line instruction is one message only when the CLI turned bracketed paste on', () => {
    const send = description('send_workroom_instruction');
    expect(send).not.toContain('submitted as one message');
    expect(send).toContain('only when the CLI has bracketed paste on');
    expect(send).toContain('prefer one line');
  });
  test('delivered/via say what AgentsToZ did, not that the CLI accepted it', () => {
    const start = description('start_workroom_session');
    expect(start).toContain('via=launch-prompt');
    expect(start).toContain('via=input');
    expect(start).toContain('not that the CLI accepted it');
  });
});

describe('B9: allowed keys and instruction prefixes cannot raise a worker\'s permissions', () => {
  test('shift-tab (Claude permission-mode cycling) is not an allowed key on either boundary', () => {
    expect(WORKROOM_KEY_NAMES as readonly string[]).not.toContain('shift-tab');
    expect(() => normalizeWorkroomKeys(['shift-tab'])).toThrow();
    expect(schema('send_workroom_keys').properties.keys.items.enum).not.toContain('shift-tab');
    expect(() => agentsToZUseMcpActionForTool('agentstoz_use_send_workroom_keys', {portId: 'study-id', sessionId: 'session_12345678', requestId: 'request_keys_1234', keys: ['shift-tab']}, 'controller-id')).toThrow('keys');
    expect(() => parseAgentsToZUseActionRequest({action: 'send-workroom-keys', controllerPortId: 'controller-id', portId: 'study-id', sessionId: 'session_12345678', requestId: 'request_keys_1234', keys: ['shift-tab']}))
      .toThrow(expect.objectContaining({code: 'AGENTSTOZ_USE_WORKROOM_KEYS_INVALID'}));
  });

  test('an instruction whose first non-space character is ! is refused on both boundaries', () => {
    for (const instruction of ['!rm -rf ~', '   !ls', '\n!whoami']) {
      for (const [action, extra] of [
        ['start-workroom-session', {agent: 'claude'}],
        ['send-workroom-instruction', {sessionId: 'session_12345678'}],
      ] as const) {
        expect(() => parseAgentsToZUseActionRequest({action, controllerPortId: 'controller-id', portId: 'study-id', requestId: 'request_bang_1234', instruction, ...extra}))
          .toThrow(expect.objectContaining({code: 'AGENTSTOZ_USE_WORKROOM_INSTRUCTION_SHELL_PREFIX'}));
        const tool = action === 'start-workroom-session' ? 'agentstoz_use_start_workroom_session' : 'agentstoz_use_send_workroom_instruction';
        expect(() => agentsToZUseMcpActionForTool(tool, {portId: 'study-id', requestId: 'request_bang_1234', instruction, ...extra}, 'controller-id')).toThrow('!');
      }
    }
    // A ! later in the text is ordinary prose; a leading / is a slash command and stays allowed.
    expect(parseAgentsToZUseActionRequest({action: 'send-workroom-instruction', controllerPortId: 'controller-id', portId: 'study-id', sessionId: 'session_12345678', requestId: 'request_bang_1234', instruction: '테스트 통과! 계속'}).instruction).toBe('테스트 통과! 계속');
    expect(parseAgentsToZUseActionRequest({action: 'send-workroom-instruction', controllerPortId: 'controller-id', portId: 'study-id', sessionId: 'session_12345678', requestId: 'request_bang_1234', instruction: '/help'}).instruction).toBe('/help');
  });

  test('the descriptions say what a leading / and ! do', () => {
    for (const name of ['send_workroom_instruction', 'start_workroom_session']) {
      expect(description(name)).toContain('slash command');
      expect(description(name)).toContain('A leading ! is refused');
    }
  });
});

describe('B5: the wait deadline is counted from the request\'s arrival', () => {
  test('the host budget subtracts elapsed time and a render allowance, and is never negative', () => {
    const arrived = 1_000_000;
    expect(workroomWaitBudgetMs(45_000, arrived, arrived)).toBe(45_000 - WORKROOM_WAIT_RENDER_ALLOWANCE_MS);
    expect(workroomWaitBudgetMs(45_000, arrived, arrived + 3_000)).toBe(45_000 - WORKROOM_WAIT_RENDER_ALLOWANCE_MS - 3_000);
    // A short wait keeps most of its time: the allowance never exceeds a quarter of it.
    expect(workroomWaitBudgetMs(1_000, arrived, arrived)).toBe(750);
    expect(workroomWaitBudgetMs(5_000, arrived, arrived + 60_000)).toBe(0);
    expect(workroomWaitBudgetMs(5_000, arrived, arrived - 10)).toBe(5_000 - WORKROOM_WAIT_RENDER_ALLOWANCE_MS);
  });
  test('the MCP client waits the same timeout plus a margin larger than the render allowance', () => {
    expect(WORKROOM_WAIT_CLIENT_MARGIN_MS).toBeGreaterThan(WORKROOM_WAIT_RENDER_ALLOWANCE_MS);
    expect(agentsToZUseMcpTimeoutMs({action: 'wait-workroom-session', timeoutMs: 45_000})).toBe(45_000 + WORKROOM_WAIT_CLIENT_MARGIN_MS);
    expect(agentsToZUseMcpTimeoutMs({action: 'wait-workroom-session'})).toBe(WORKROOM_WAIT_LIMITS.timeoutMs.default + WORKROOM_WAIT_CLIENT_MARGIN_MS);
  });
});

describe('request ledger (B1, B10): bounded and expiring', () => {
  test('entries expire after their TTL and the oldest are evicted at the bound', () => {
    let now = 0;
    const ledger = new WorkroomRequestLedger<string>({maxEntries: 3, ttlMs: 100}, () => now);
    ledger.set('a', 'A'); ledger.set('b', 'B'); ledger.set('c', 'C');
    expect(ledger.get('a')).toBe('A');
    ledger.set('d', 'D');
    expect(ledger.get('a')).toBeUndefined();
    expect([ledger.get('b'), ledger.get('c'), ledger.get('d')]).toEqual(['B', 'C', 'D']);
    now = 100;
    expect(ledger.get('b')).toBeUndefined();
    ledger.set('e', 'E');
    expect(ledger.size).toBe(1);
    ledger.delete('e');
    expect(ledger.get('e')).toBeUndefined();
  });
});

describe('B2: the calling Workroom is identified by process ancestry, only as a hint', () => {
  const table = parseProcessTable([
    '    1     0     1',
    '  500     1   500',   // the Workroom CLI: its own process group (spawned detached)
    '  600   500   500',   // a shell the CLI started
    '  700   600   700',   // the MCP server in a new group
    '  garbage line',
  ].join('\n'));

  test('parses ps output and walks up to six parents, adding each process group', () => {
    expect(table.get(700)).toEqual({ppid: 600, pgid: 700});
    expect(processAncestry(700, table)).toEqual([700, 600, 500]);
    expect(processAncestry(700, table, 1)).toEqual([700, 600, 500]); // 600's group is 500
    expect(processAncestry(9_999, table)).toEqual([9_999]);
  });

  test('headers carry the ancestry and the Workroom environment, and the host parses them strictly', () => {
    const headers = workroomCallerHeaders({AGENTSTOZ_WORKROOM_SESSION_ID: '0b7a2c1e-1111-4a4a-8b8b-000000000001', AGENTSTOZ_WORKROOM_TARGET_ID: 'ops-project'}, [700, 600, 500]);
    expect(headers).toEqual({
      [AGENTSTOZ_CALLER_PROCESSES_HEADER]: '700,600,500',
      [AGENTSTOZ_CALLER_SESSION_HEADER]: '0b7a2c1e-1111-4a4a-8b8b-000000000001',
      [AGENTSTOZ_CALLER_TARGET_HEADER]: 'ops-project',
    });
    expect(parseWorkroomCallerHint(new Headers(headers))).toEqual({processes: [700, 600, 500], sessionId: '0b7a2c1e-1111-4a4a-8b8b-000000000001', targetId: 'ops-project'});
    expect(workroomCallerHeaders({AGENTSTOZ_WORKROOM_SESSION_ID: 'bad id'}, [])).toEqual({});
    for (const bad of ['1,abc', '0', '-5', '1', '1,,2', Array(17).fill(12).join(','), '12345678901']) {
      expect(parseWorkroomCallerHint(new Headers({[AGENTSTOZ_CALLER_PROCESSES_HEADER]: bad})).processes).toEqual([]);
    }
    expect(parseWorkroomCallerHint(new Headers({[AGENTSTOZ_CALLER_SESSION_HEADER]: '../x', [AGENTSTOZ_CALLER_TARGET_HEADER]: 'a b'}))).toEqual({processes: [], sessionId: null, targetId: null});
  });
});

describe('B4: a newer MCP server refuses to report options an older AgentsToZ ignored', () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

  /** An AgentsToZ from before contract 1.21.0: every action succeeds, but new options are silently dropped. */
  function host(reply: (action: any) => Record<string, unknown>) {
    const server = Bun.serve({port: 0, hostname: '127.0.0.1', fetch: async request => {
      const action = await request.json() as any;
      return Response.json({success: true, performed: true, action: action.action, ...reply(action)});
    }});
    servers.push(server);
    const env = {AGENTSTOZ_CONTROLLER_PORT_ID: 'controller-id', AGENTSTOZ_USE_ENDPOINT: `http://127.0.0.1:${server.port}/api/agentstoz-use/action`};
    return async (name: string, args: Record<string, unknown>) => {
      const response = await handleAgentsToZUseMcpRequest({id: 1, method: 'tools/call', params: {name: `agentstoz_use_${name}`, arguments: args}}, env) as any;
      return {isError: response.result.isError, body: response.result.structuredContent ?? JSON.parse(response.result.content[0].text)};
    };
  }
  const session = {id: 'session_12345678', targetId: 'study-id', agent: 'codex', state: 'running'};

  test('an old host that dropped instruction, reuse, foreground, view or portId is reported, not trusted', async () => {
    const call = host(action => action.action === 'start-workroom-session' ? {effect: 'started-workroom-session', session} : action.action === 'read-workroom-session' ? {chunks: []} : {effect: 'opened-local-app'});
    for (const [name, args, option] of [
      ['start_workroom_session', {portId: 'study-id', agent: 'codex', requestId: 'request_12345678', instruction: '지시'}, 'instruction'],
      ['start_workroom_session', {portId: 'study-id', agent: 'codex', requestId: 'request_12345678', reuse: true}, 'reuse'],
      ['start_workroom_session', {portId: 'study-id', agent: 'codex', requestId: 'request_12345678', foreground: false}, 'foreground'],
      ['read_workroom_session', {portId: 'study-id', sessionId: 'session_12345678', view: 'screen'}, 'view'],
      ['open_dashboard', {portId: 'study-id'}, 'portId'],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.body.data).toMatchObject({code: 'AGENTSTOZ_USE_HOST_OUTDATED', unconfirmed: [option], hostResult: {success: true}});
      expect(result.body.error).toContain('Restart or update AgentsToZ');
    }
    // Calls without the new options keep working against the same old host.
    expect((await call('start_workroom_session', {portId: 'study-id', agent: 'codex', requestId: 'request_12345678'})).isError).toBe(false);
    expect((await call('read_workroom_session', {portId: 'study-id', sessionId: 'session_12345678'})).isError).toBe(false);
    expect((await call('open_dashboard', {})).isError).toBe(false);
  });

  test('a current host that echoes the options passes, including a screen read that fell back to the tail', async () => {
    const call = host(action => {
      if (action.action === 'start-workroom-session') return {session, reused: false, foreground: action.foreground !== false, instruction: action.instruction ? {delivered: true, via: 'launch-prompt'} : null};
      if (action.action === 'read-workroom-session') return action.view === 'screen' ? {view: 'tail', screenUnavailable: true, text: ''} : {view: action.view, text: ''};
      return {projectId: action.portId, focusRequested: true};
    });
    expect((await call('start_workroom_session', {portId: 'study-id', agent: 'codex', requestId: 'request_12345678', instruction: '지시', reuse: true, foreground: false})).isError).toBe(false);
    expect((await call('read_workroom_session', {portId: 'study-id', sessionId: 'session_12345678', view: 'screen'})).isError).toBe(false);
    expect((await call('read_workroom_session', {portId: 'study-id', sessionId: 'session_12345678', view: 'tail'})).isError).toBe(false);
    expect((await call('open_dashboard', {portId: 'study-id'})).isError).toBe(false);
  });

  test('open_code_app task and mode=new must be echoed (contract 1.31.0); an older host that reopened instead is reported', async () => {
    // Before 1.31.0 the host dropped task and mapped every non-prepared Codex result to «reopened».
    const old = host(action => ({effect: 'opened-local-app', agent: action.agent, surface: 'app', mode: 'reopened'}));
    // A Codex task now always travels with mode=new (a real older host refuses that at parse time); a host
    // that still answered without the echoes is reported on both.
    for (const [args, options] of [
      [{portId: 'study-id', agent: 'codex', task: '로그인 화면을 고쳐 주세요.'}, ['task', 'mode']],
      [{portId: 'study-id', agent: 'agy', task: '로그인 화면을 고쳐 주세요.'}, ['task']],
      [{portId: 'study-id', agent: 'codex', mode: 'new'}, ['mode']],
    ] as const) {
      const result = await old('open_code_app', args);
      expect(result.isError).toBe(true);
      expect(result.body.data).toMatchObject({code: 'AGENTSTOZ_USE_HOST_OUTDATED', unconfirmed: [...options]});
    }
    expect((await old('open_code_app', {portId: 'study-id', agent: 'codex'})).isError).toBe(false);
    const current = host(action => ({
      effect: 'opened-local-app', agent: action.agent, surface: 'app',
      ...(action.agent === 'codex' ? {mode: action.task !== undefined || action.mode === 'new' ? 'new' : 'reopened'} : {}),
      ...(action.task === undefined ? {} : action.agent === 'codex' ? {taskApplied: 'prefilled'} : {taskApplied: false, taskReason: 'unsupported-app'}),
    }));
    const prefilled = await current('open_code_app', {portId: 'study-id', agent: 'codex', task: '로그인 화면을 고쳐 주세요.'});
    expect(prefilled.isError).toBe(false);
    expect(prefilled.body).toMatchObject({taskApplied: 'prefilled', mode: 'new'});
    const unsupported = await current('open_code_app', {portId: 'study-id', agent: 'claude', task: '로그인 화면을 고쳐 주세요.'});
    expect(unsupported.isError).toBe(false);
    expect(unsupported.body).toMatchObject({taskApplied: false, taskReason: 'unsupported-app'});
    expect((await current('open_code_app', {portId: 'study-id', agent: 'codex', mode: 'new'})).isError).toBe(false);
  });
});
