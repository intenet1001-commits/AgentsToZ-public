import {expect, test} from 'bun:test';
import {AI_TERMINAL_AGENTS} from '../src/aiTerminalProtocol';
import {hermesVariantModel, launchChoiceLabel, workroomLaunchChoices} from '../src/hermesVariants';
import {TEAM_MAX_MEMBERS, teamLaunchSurfacesFor, teamLaunchSupport, teamSurfaceName} from '../src/teamLaunchOptions';
import {AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE, agentstozMcpAgentChoice, prepareMcpAgentLaunch} from '../src/agentstozMcpAgentChoice';

const start = 'agentstoz_use_start_workroom_session', open = 'agentstoz_use_open_code_app', team = 'agentstoz_use_create_team';

test('launch omissions ask the person without inferring an agent, returning context, or mutating the draft', () => {
  const raw = Object.freeze({target: 'ops', requestId: 'private-request-id', instruction: 'PRIVATE_TASK /Users/private/project TOKEN=secret'});
  for (const tool of [start, open]) {
    const result = agentstozMcpAgentChoice(tool, raw);
    expect(result).toMatchObject({success: false, performed: false, selectionRequired: true, effect: 'agent-selection-required'});
    expect(result && 'agents' in result && result.agents).toEqual(AI_TERMINAL_AGENTS.map(agent => ({agent, label: launchChoiceLabel(agent)})));
    expect(Object.keys(result!).sort()).toEqual(['agents', 'effect', 'performed', 'question', 'scope', 'selectionRequired', 'stage', 'success', 'toolName']);
    expect(result).toMatchObject({stage: 'agent', scope: 'launch', toolName: tool});
    for (const secret of ['private-request-id', 'PRIVATE_TASK', '/Users/', 'TOKEN=']) expect(JSON.stringify(result)).not.toContain(secret);
  }
  expect(raw.instruction).toContain('PRIVATE_TASK');
});

test('complete explicit selections and malformed agents stay with execution validation; none are replaced', () => {
  for (const tool of [start, open]) for (const agent of [...AI_TERMINAL_AGENTS, null, '', 'unknown', 1, false, {}]) {
    expect(agentstozMcpAgentChoice(tool, {agent, surface: tool === start ? 'internal' : 'app', ...(agent === 'hermes' ? {hermesVariant: 'default'} : {})})).toBeNull();
  }
  for (const raw of [undefined, null, [], 'codex', 7, false, new Date()]) expect(agentstozMcpAgentChoice(start, raw)).toBeNull();
  for (const tool of ['agentstoz_use_read_team', 'agentstoz_use_read_workroom_session', 'start_workroom_session', 'unknown']) expect(agentstozMcpAgentChoice(tool, {})).toBeNull();
});

test('team omissions expose only missing member indices and keep explicit selection blocks unchanged', () => {
  const absent = agentstozMcpAgentChoice(team, {});
  expect(absent).toMatchObject({performed: false, selectionRequired: true, missingMemberIndices: []});
  const members = [Object.freeze({agent: 'claude', task: 'keep explicit', surface: 'orca-worktree'}), Object.freeze({task: 'PRIVATE_TASK'}), Object.freeze({agent: 'hermes', model: 'preset', provider: 'provider'}), Object.freeze({})];
  const result = agentstozMcpAgentChoice(team, Object.freeze({members: Object.freeze(members)}));
  expect(result).toMatchObject({success: false, performed: false, effect: 'agent-selection-required', missingMemberIndices: [1, 3]});
  expect(result && 'question' in result && result.question).toContain('2, 4');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_TASK');
  expect(result).toMatchObject({stage: 'agent', scope: 'team-member', toolName: team, memberIndex: 1});
  expect(agentstozMcpAgentChoice(team, {members: members.filter(member => 'agent' in member).map(member => ({...member, surface: 'internal'}))})).toBeNull();
});

test('malformed teams and explicit unknown/null agents keep strict errors instead of becoming selection requests', () => {
  for (const members of [null, {}, '', [], Array(TEAM_MAX_MEMBERS + 1).fill({}), [null], [[]], ['claude'], [{}, {agent: null}], [{}, {agent: 'unknown'}], [{}, undefined], [Object.create(null), , {}]]) {
    expect(agentstozMcpAgentChoice(team, {members})).toBeNull();
  }
  expect(agentstozMcpAgentChoice(team, {members: [{agent: false}]})).toBeNull();
});

test('selection options do not share mutable state across calls', () => {
  const first = agentstozMcpAgentChoice(start, {});
  if (!first || !('agents' in first)) throw new Error('Expected agent choices');
  first.agents[0]!.label = 'changed'; first.agents.pop();
  const second = agentstozMcpAgentChoice(start, {});
  expect(second && 'agents' in second && second.agents).toEqual(AI_TERMINAL_AGENTS.map(agent => ({agent, label: launchChoiceLabel(agent)})));
});

test('Hermes asks its variant only after an explicit surface; complete defaults/presets are not reinterpreted', () => {
  expect(agentstozMcpAgentChoice(start, {agent: 'hermes'})).toMatchObject({stage: 'surface', scope: 'launch', toolName: start});
  const result = agentstozMcpAgentChoice(start, {agent: 'hermes', surface: 'internal', instruction: 'PRIVATE_TASK'});
  expect(result).toMatchObject({success: false, performed: false, selectionRequired: true, stage: 'variant', effect: 'hermes-variant-selection-required'});
  expect(JSON.stringify(result)).not.toContain('PRIVATE_TASK');
  for (const hermesVariant of ['default', 'claude', 'codex', null, 'unknown']) expect(agentstozMcpAgentChoice(start, {agent: 'hermes', surface: 'internal', hermesVariant})).toBeNull();
  expect(agentstozMcpAgentChoice(open, {agent: 'hermes', surface: 'app'})).toMatchObject({stage: 'variant', scope: 'launch', toolName: open});
  expect(agentstozMcpAgentChoice(open, {agent: 'hermes', surface: 'app', hermesVariant: 'default'})).toBeNull();
});

test('known agents never let an execution tool name supply a missing surface', () => {
  for (const toolName of [start, open]) for (const agent of AI_TERMINAL_AGENTS) {
    const result = agentstozMcpAgentChoice(toolName, {agent, requestId: 'SECRET_VALUE', instruction: 'PRIVATE_TASK', target: 'ops'});
    expect(result).toMatchObject({success: false, ready: false, performed: false, selectionRequired: true, stage: 'surface', scope: 'launch', toolName, draft: {agent}});
    expect(result && 'draft' in result && result.draft).toEqual({agent});
    for (const secret of ['SECRET_VALUE', 'PRIVATE_TASK', 'target', 'requestId']) expect(JSON.stringify(result)).not.toContain(secret);
  }
  expect(agentstozMcpAgentChoice(open, {agent: 'claude'})).toMatchObject({effect: 'surface-selection-required'}); // Real QA P1.
  const windows = agentstozMcpAgentChoice(open, {agent: 'claude'}, true);
  expect(windows && 'choices' in windows && windows.choices.map(choice => 'surface' in choice ? choice.surface : null)).toEqual(teamLaunchSurfacesFor(true));
});

test('single execution routes reject explicit surface mismatches and external Hermes pins without a fallback', () => {
  for (const toolName of [start, open]) for (const surface of teamLaunchSurfacesFor(false)) {
    const result = agentstozMcpAgentChoice(toolName, {agent: 'claude', surface});
    const supported = toolName === start ? surface === 'internal' : ['app', 'orca-floating', 'orca-worktree'].includes(surface);
    if (supported) expect(result).toBeNull();
    else expect(result).toMatchObject({success: false, performed: false, selectionRequired: false, effect: 'agent-launch-refused', scope: 'launch', toolName});
  }
  for (const surface of ['app', 'orca-floating', 'orca-worktree']) for (const hermesVariant of ['claude', 'codex']) {
    expect(agentstozMcpAgentChoice(open, {agent: 'hermes', surface, hermesVariant})).toMatchObject({effect: 'agent-launch-refused', performed: false, selectionRequired: false});
  }
  for (const raw of [{agent: 'claude', surface: null}, {agent: 'hermes', surface: 'app', hermesVariant: null}, {agent: 'hermes', surface: 'app', hermesVariant: 'invalid'}, {agent: 'claude', surface: 'app', hermesVariant: 'default'}, {agent: 'claude', surface: 'unknown'}]) {
    expect(agentstozMcpAgentChoice(open, raw)).toBeNull();
  }
});

test('fresh teams resolve the first missing dimension with a strict public member scope', () => {
  const members: Array<{agent?: string; task?: string; surface?: string}> = [{agent: 'claude', task: 'PRIVATE_TASK'}, {}, {agent: 'hermes', task: 'SECRET_VALUE', surface: 'internal'}];
  expect(agentstozMcpAgentChoice(team, {members})).toMatchObject({stage: 'agent', scope: 'team-member', toolName: team, memberIndex: 1});
  members[1] = {agent: 'codex'};
  const location = agentstozMcpAgentChoice(team, {members});
  expect(location).toMatchObject({stage: 'surface', scope: 'team-member', toolName: team, memberIndex: 0, draft: {agent: 'claude'}});
  for (const text of ['PRIVATE_TASK', 'SECRET_VALUE']) expect(JSON.stringify(location)).not.toContain(text);
  const withLocations = members.map(member => ({...member, surface: 'internal'}));
  const variant = agentstozMcpAgentChoice(team, {members: withLocations});
  expect(variant).toMatchObject({stage: 'variant', scope: 'team-member', toolName: team, memberIndex: 2, draft: {agent: 'hermes', surface: 'internal'}});
  expect(agentstozMcpAgentChoice(team, {members: withLocations.map(member => ({...member, ...(member.agent === 'hermes' ? {hermesVariant: 'default'} : {})}))})).toBeNull();
  expect(agentstozMcpAgentChoice(team, {})).toMatchObject({stage: 'agent', scope: 'team', toolName: team, missingMemberIndices: []});
});

test('attached sessions keep current settings and complete Hermes UI/model choices are never asked again', () => {
  expect(agentstozMcpAgentChoice(team, {members: [{agent: 'hermes', sessionId: 'session_joined_1'}]})).toBeNull();
  expect(agentstozMcpAgentChoice(team, {members: [{agent: 'hermes', sessionId: 'session_joined_1'}, {agent: 'hermes', surface: 'app'}]})).toMatchObject({scope: 'team-member', memberIndex: 1, stage: 'variant'});
  for (const surface of teamLaunchSurfacesFor(false)) {
    expect(agentstozMcpAgentChoice(team, {members: [{agent: 'hermes', surface, hermesVariant: 'default'}]})).toBeNull();
  }
  for (const hermesVariant of ['claude', 'codex'] as const) {
    expect(agentstozMcpAgentChoice(team, {members: [{agent: 'hermes', surface: 'internal', ...hermesVariantModel(hermesVariant)}]})).toBeNull();
    expect(agentstozMcpAgentChoice(team, {members: [{agent: 'hermes', surface: 'internal', hermesVariant}]})).toBeNull();
  }
  expect(agentstozMcpAgentChoice(team, {members: [{agent: 'hermes', surface: 'internal', model: 'valid-custom-model', provider: 'valid-provider'}]})).toBeNull();
  expect(agentstozMcpAgentChoice(team, {members: [{agent: 'hermes', surface: 'internal', model: 'valid-custom-model'}]})).toBeNull();
  expect(agentstozMcpAgentChoice(team, {members: [{agent: 'hermes', model: 'valid-custom-model'}]})).toMatchObject({stage: 'surface', memberIndex: 0});
});

test('invalid explicit team values are not hidden behind another member or missing-choice question', () => {
  for (const invalid of [{agent: 'codex', model: 7}, {agent: 'hermes', provider: 'anthropic'}, {agent: 'claude', unknown: 'SECRET_VALUE'}, {agent: 'claude', surface: null},
    {agent: 'hermes', surface: 'internal', hermesVariant: 'default', ...hermesVariantModel('claude')},
    {agent: 'hermes', sessionId: 'session_joined_1', hermesVariant: 'default'}, {agent: 'codex', sessionId: 'session_joined_1', surface: 'app'}, {agent: 'codex', sessionId: null}]) {
    expect(agentstozMcpAgentChoice(team, {members: [{}, invalid]})).toBeNull();
  }
});

test('otherwise valid external Hermes team presets are refused locally rather than reaching an execution endpoint', () => {
  for (const surface of teamLaunchSurfacesFor(false).filter(surface => surface !== 'internal')) for (const hermesVariant of ['claude', 'codex']) {
    const result = agentstozMcpAgentChoice(team, {members: [{agent: 'claude', surface: 'internal'}, {agent: 'hermes', surface, hermesVariant, task: 'SECRET_VALUE'}]});
    expect(result).toMatchObject({scope: 'team-member', toolName: team, memberIndex: 1, success: false, performed: false, selectionRequired: false, effect: 'agent-launch-refused'});
    expect(JSON.stringify(result)).not.toContain('SECRET_VALUE');
  }
  expect(agentstozMcpAgentChoice(team, {members: [{agent: 'hermes', surface: 'app', hermesVariant: 'claude'}, {agent: null}]})).toBeNull();
});

test('prepare asks only missing choices in agent -> surface -> Hermes variant order, without a default surface', () => {
  expect(prepareMcpAgentLaunch({})).toMatchObject({success: false, ready: false, performed: false, selectionRequired: true, stage: 'agent', draft: {}});
  expect(prepareMcpAgentLaunch(undefined)).toMatchObject({stage: 'agent'});
  expect(prepareMcpAgentLaunch({surface: 'app'})).toMatchObject({stage: 'agent', draft: {surface: 'app'}});
  expect(prepareMcpAgentLaunch({agent: 'claude'})).toMatchObject({stage: 'surface', draft: {agent: 'claude'}});
  expect(prepareMcpAgentLaunch({agent: 'hermes'})).toMatchObject({stage: 'surface', draft: {agent: 'hermes'}});
  expect(prepareMcpAgentLaunch({agent: 'hermes', surface: 'internal'})).toMatchObject({stage: 'variant', draft: {agent: 'hermes', surface: 'internal'}});
  expect(prepareMcpAgentLaunch({agent: 'hermes', hermesVariant: 'codex'})).toMatchObject({stage: 'surface', draft: {agent: 'hermes', hermesVariant: 'codex'}});
});

test('prepare surface choices use the project-open platform catalog and capabilities without claiming installation', () => {
  for (const windows of [false, true]) for (const agent of AI_TERMINAL_AGENTS) {
    const result = prepareMcpAgentLaunch({agent}, windows);
    if (!result.selectionRequired || result.stage !== 'surface') throw new Error('Expected surface choices');
    expect(result.choices.map(choice => choice.surface)).toEqual(teamLaunchSurfacesFor(windows));
    for (const choice of result.choices) {
      expect(choice.label).toBe(teamSurfaceName(choice.surface, agent));
      expect(choice.support).toEqual(teamLaunchSupport(choice.surface, agent));
      expect(choice.executionRoutes).toContain(team);
      expect(choice.singleLaunch).toBe(['internal', 'app', 'orca-floating', 'orca-worktree'].includes(choice.surface));
      if (choice.surface === 'internal') expect(choice.executionRoutes).toEqual([start, team]);
      else if (choice.surface === 'app' || choice.surface.startsWith('orca-')) expect(choice.executionRoutes).toEqual([open, team]);
      else expect(choice.executionRoutes).toEqual([team]);
    }
    expect(result.installation).toBe('not-checked'); expect(result.credentials).toBe('not-checked');
  }
});

test('every explicit supported ordinary launch is a nonexecuting ready draft, including platform-specific terminal surfaces', () => {
  for (const windows of [false, true]) for (const agent of AI_TERMINAL_AGENTS) for (const surface of teamLaunchSurfacesFor(windows)) {
    const draft = Object.freeze({agent, surface, ...(agent === 'hermes' ? {hermesVariant: 'default' as const} : {})});
    const result = prepareMcpAgentLaunch(draft, windows);
    expect(result).toMatchObject({success: true, ready: true, performed: false, selectionRequired: false, effect: 'agent-launch-prepared', draft, installation: 'not-checked', credentials: 'not-checked'});
    expect('launchModel' in result).toBe(false);
    if (!result.ready) throw new Error('Expected prepared draft');
    expect(result.support.model).toBe(surface === 'internal');
    expect(result.executionRoutes).toContain(team);
    expect(result.singleLaunch).toBe(['internal', 'app', 'orca-floating', 'orca-worktree'].includes(surface));
    if (!['internal', 'app', 'orca-floating', 'orca-worktree'].includes(surface)) expect(result.executionRoutes).toEqual([team]);
  }
});

test('ready means choices only, and desktop app notes retain the real prefill and unsupported-delivery limits', () => {
  for (const agent of AI_TERMINAL_AGENTS) {
    const result = prepareMcpAgentLaunch({agent, surface: 'app', ...(agent === 'hermes' ? {hermesVariant: 'default'} : {})});
    expect(result).toMatchObject({ready: true, preparationOnly: true, readiness: 'choices-only', performed: false, installation: 'not-checked', credentials: 'not-checked'});
    if (!result.ready) throw new Error('Expected choices-only draft');
    expect(result.note).toContain('선택 준비만 끝났으며 실행·요청 전달은 하지 않았습니다');
    if (agent === 'codex') expect(result.note).toContain('앱이 채웠는지는 알려 주지 않으니');
    else if (agent === 'agy') expect(result.note).toContain('이 앱은 폴더를 받지 않습니다');
    else expect(result.note).toContain('바깥에서 첫 요청을 받지 않습니다');
    expect('taskApplied' in result).toBe(false); expect('projectApplied' in result).toBe(false);
  }
});

test('Hermes questions reuse canonical variants and advertise unsupported external pins without guessing a provider for default', () => {
  for (const surface of teamLaunchSurfacesFor(false)) {
    const result = prepareMcpAgentLaunch({agent: 'hermes', surface});
    if (!result.selectionRequired || result.stage !== 'variant') throw new Error('Expected Hermes variant choices');
    expect(result.choices.map(choice => choice.hermesVariant)).toEqual(['default', 'claude', 'codex']);
    expect(result.choices.map(choice => choice.supported)).toEqual(surface === 'internal' ? [true, true, true] : [true, false, false]);
    expect(result.choices[0]!.label).toContain('현재 CLI·앱 설정 그대로');
    expect(result.choices.slice(1).map(choice => choice.label)).toEqual(workroomLaunchChoices(['hermes']).slice(1).map(launchChoiceLabel));
    for (const choice of result.choices.filter(choice => !choice.supported)) expect(choice.unsupportedReason).toContain('지원하지 않습니다');
    expect('launchModel' in result).toBe(false);
  }
});

test('Hermes Claude/Codex presets are exact Workroom-only host models, with no external or app fallback', () => {
  for (const hermesVariant of ['claude', 'codex'] as const) {
    const internal = prepareMcpAgentLaunch({agent: 'hermes', surface: 'internal', hermesVariant});
    expect(internal).toMatchObject({success: true, ready: true, performed: false, draft: {agent: 'hermes', surface: 'internal', hermesVariant}, launchModel: hermesVariantModel(hermesVariant)});
    for (const windows of [false, true]) for (const surface of teamLaunchSurfacesFor(windows).filter(surface => surface !== 'internal')) {
      const external = prepareMcpAgentLaunch({agent: 'hermes', surface, hermesVariant}, windows);
      expect(external).toMatchObject({success: false, ready: false, performed: false, selectionRequired: false, effect: 'agent-launch-refused', installation: 'not-checked', credentials: 'not-checked'});
      expect('draft' in external).toBe(false); expect('launchModel' in external).toBe(false);
    }
  }
  const choices = prepareMcpAgentLaunch({agent: 'hermes', hermesVariant: 'claude'});
  if (!choices.selectionRequired || choices.stage !== 'surface') throw new Error('Expected surface choices');
  expect(choices.choices.map(choice => [choice.surface, choice.hermesVariantSupported])).toEqual(teamLaunchSurfacesFor(false).map(surface => [surface, surface === 'internal']));
});

test('prepare refuses malformed, unsupported and non-string selections without coercion or leaking private fields', () => {
  const noString = {toString: () => { throw new Error('must not coerce'); }};
  const cases = [null, [], false, 1, 'claude', new Date(), {agent: null}, {agent: noString}, {agent: 'Claude'}, {surface: null}, {surface: noString}, {surface: 'powershell'},
    {agent: 'hermes', surface: 'internal', hermesVariant: null}, {agent: 'hermes', hermesVariant: 'unknown'}, {agent: 'codex', hermesVariant: 'default'},
    {agent: 'claude', surface: 'internal', task: '/Users/PRIVATE_TOKEN'}, {caller: 'PRIVATE_TOKEN'}, {agent: 'hermes', model: 'PRIVATE_TOKEN', provider: 'secret'}];
  for (const raw of cases) {
    const result = prepareMcpAgentLaunch(raw);
    expect(result).toMatchObject({success: false, ready: false, performed: false, selectionRequired: false, effect: 'agent-launch-refused'});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN'); expect(JSON.stringify(result)).not.toContain('/Users/');
  }
  expect(prepareMcpAgentLaunch({agent: 'codex', surface: 'cmux'}, true)).toMatchObject({effect: 'agent-launch-refused'});
});

test('compact client guidance keeps the selection boundary without pushing dispatch/self guards past the shared instruction budget', () => {
  expect(AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE.length).toBeLessThanOrEqual(260);
  for (const rule of ['agent/surface/Hermes(default/Claude/Codex)', 'agentstoz_use_prepare_agent_launch', 'ask and wait', 'explicit choices/buttons/blocks', 'current AI/tool names/defaults', 'only on explicit delegation', 'Preparation never executes']) expect(AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE).toContain(rule);
});
