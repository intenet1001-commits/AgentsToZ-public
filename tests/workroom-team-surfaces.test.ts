/**
 * 팀 작전 — the launch surface and its options, from the strict normalizer to the ledger, the fingerprint, the external
 * runtime the host injects, the honest waiting states, manual confirmation, manual report provenance and cleanup.
 *
 * The rule under every case here: the surface the user picked is the surface the member runs on. A member is never
 * quietly started as a Workroom, opening a window is never 「working」, an unconfirmed delivery is never resent, and a
 * process this team did not start is never ended.
 */
import {expect, test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeTeamLaunch, TEAM_LAUNCH_SURFACES, type TeamExternalLaunch, type TeamExternalRuntime, type TeamExternalStarted} from '../src/teamLaunchPlan';
import {parseWorkroomTeamRequest, WorkroomTeamService, WorkroomTeamStore, type WorkroomTeamHost, type WorkroomTeamRequest} from '../src/workroomTeam';
import {normalizeTeamPanelResult, teamMemberAwaiting, teamMemberDisplay, teamPanelView} from '../src/workroomTeamPanel';

import {parseTeamMemberSelection, teamLaunchDefaults, type TeamLaunchOptions} from '../src/teamLaunchOptions';

const leader = {sessionId: 'leader-1', agent: 'claude' as const};
const create = (members: unknown[], requestId = 'team-request-surface-1') =>
  parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId, title: '팀', goal: '목표', members}) as Extract<WorkroomTeamRequest, {op: 'create'}>;
const members = (list: unknown[]) => create(list).members;

/** A host whose Workroom side behaves and whose external side is whatever a case needs. */
function host(external?: TeamExternalRuntime) {
  const started: TeamExternalLaunch[] = [], workroom: string[] = [], closed: string[] = [], removed: string[] = [];
  const base: WorkroomTeamHost = {
    resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: '/repo'}),
    primary: async () => ({path: '/repo', base: '/repo', head: 'a'.repeat(40), branch: 'main', trackedChanges: [], untracked: 0}),
    attachable: async () => null,
    addWorktree: async () => {}, worktreeTargetId: (_project, path) => `rwt_${path.split('/').pop()}`,
    start: async input => { workroom.push(input.targetId); return {sessionId: `session-${workroom.length}`}; },
    session: () => ({state: 'running', lastOutputAt: 1}),
    sessionForTarget: async () => null,
    instruct: async () => 'written',
    close: async sessionId => { closed.push(sessionId); },
    removeWorktree: async (_primary, path) => { removed.push(path); return 'removed'; },
    branchGit: async () => ({commits: 0, files: 0, insertions: 0, deletions: 0, merged: false}),
    deleteMergedBranch: async () => 'deleted',
    ...(external ? {external: {...external, start: async (input: TeamExternalLaunch) => { started.push(input); return external.start(input); }}} : {}),
  };
  return {host: base, started, workroom, closed, removed};
}
const orca = (over: Partial<TeamExternalStarted> = {}): TeamExternalStarted => ({
  ref: {kind: 'external', surface: 'orca-worktree', runtime: 'orca', handle: 'term_7f31', owned: true, evidence: {send: true, read: true}},
  state: 'working', delivery: 'verified', ...over,
});

test('UI blocks and create share one strict catalog, including explicit off and rejected fresh attachment options', () => {
  for (const surface of TEAM_LAUNCH_SURFACES) for (const agent of ['codex', 'claude', 'hermes', 'agy'] as const) {
    const launchOptions = teamLaunchDefaults(surface, agent), raw = {agent, task: '작업', surface, ...(Object.keys(launchOptions).length ? {launchOptions} : {})};
    const selected = parseTeamMemberSelection(raw);
    expect(members([raw])[0]).toEqual(selected as never);
    expect(normalizeTeamLaunch({agent, surface, launchOptions: raw.launchOptions})).toEqual({surface, ...(selected.launchOptions ? {options: selected.launchOptions} : {})});
  }
  const options: TeamLaunchOptions = {bgMode: false, tmuxMode: false, reuse: 'new'};
  expect(members([{agent: 'claude', task: 'x', surface: 'cmux', launchOptions: options}])[0]!.launchOptions).toEqual(options);
  for (const change of [{model: 7}, {agent: 'hermes', model: 'valid', provider: 5}, {surface: 'app', launchOptions: {appMode: 'open'}}, {surface: 'cmux', model: 'gpt-6-sol'}, {surface: 'app', accountId: 'host-default'}, {surface: 'app', effort: 'low'}]) {
    expect(() => create([{agent: 'codex', task: 'x', ...change}])).toThrow();
  }
  expect(() => create([{agent: 'codex', task: 'x', surface: 'ssh'}])).toThrow('실행 위치');
  expect(() => create([{agent: 'codex', task: 'x', launchOptions: {reuse: 'new'}}])).toThrow();
  for (const option of [{surface: 'cmux'}, {launchOptions: {tmuxMode: false}}, {accountId: 'host-default'}, {bypassPermissions: false}, {model: 'gpt-6-sol'}, {provider: 'anthropic'}, {effort: 'low'}]) {
    expect(() => create([{agent: 'codex', task: 'x', sessionId: 'session-join-1', ...option}])).toThrow('열린 세션');
  }
  expect(members([{agent: 'codex', task: 'x', sessionId: 'session-join-1'}])[0]).toMatchObject({sessionId: 'session-join-1'});
  expect(() => create([{agent: 'codex', task: '한'.repeat(1334)}])).toThrow('4000');
  expect(() => parseTeamMemberSelection({agent: 'codex', task: 'bad\0task'})).toThrow('제어 문자');
  expect(members([{agent: 'codex', task: '한'.repeat(1333)}])[0]!.task).toHaveLength(1333);
});
test('an external member is started through the injected runtime, never as a Workroom, and its binding is the ledger', async () => {
  const sent: TeamExternalLaunch[] = [];
  const h = host({start: async input => { sent.push(input); return orca(); }});
  const dir = mkdtempSync(join(tmpdir(), 'team-surface-')), file = join(dir, 'teams.json');
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(file));
  const {team} = await service.create(create([
    {agent: 'claude', task: 'Orca에서 구현', surface: 'orca-worktree', bypassPermissions: true},
    {agent: 'codex', task: '워크룸에서 검증'},
  ]), leader);
  // The external member went nowhere near the Workroom start, and the Workroom member still did.
  expect(h.workroom).toEqual([team.members[1]!.targetId!]);
  expect(h.started).toHaveLength(1);
  const launch = h.started[0]!;
  expect(launch).toMatchObject({teamId: team.id, memberId: 'm1', agent: 'claude', plan: {surface: 'orca-worktree'},
    cwd: team.members[0]!.worktreePath, targetId: team.members[0]!.targetId, requestId: `team-${team.id}-m1`,
    bypassPermissions: true});
  // The brief is the host's own, and the launch carries the member's effort the same way a Workroom start does.
  expect(launch.prompt).toContain(team.members[0]!.branch);
  expect(launch.effort).toEqual({requestText: 'Orca에서 구현'});
  // The ledger keeps the choice and the binding; a Workroom member keeps the legacy sessionId shape.
  expect(team.members[0]).toMatchObject({surface: 'orca-worktree', state: 'working', delivery: 'verified',
    execution: {kind: 'external', surface: 'orca-worktree', runtime: 'orca', handle: 'term_7f31', owned: true}});
  expect(team.members[1]).toMatchObject({state: 'working', sessionId: 'session-1', execution: {kind: 'workroom', sessionId: 'session-1'}});
  expect(new WorkroomTeamStore(file).get(team.id)!.members[0]!.execution).toEqual(team.members[0]!.execution as never);
  // The same requestId with another surface is a conflict, not a second start somewhere else.
  await expect(service.create(create([{agent: 'claude', task: 'Orca에서 구현', surface: 'cmux', bypassPermissions: true}, {agent: 'codex', task: '워크룸에서 검증'}]), leader))
    .rejects.toThrow('다른 팀 요청에 이미 쓰였습니다');
  expect(sent).toHaveLength(1);
});

test('a surface with no runtime fails saying so — a Workroom is never started in its place', async () => {
  const h = host();
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'codex', task: 'cmux에서 작업', surface: 'cmux'}]), leader);
  expect(team.members[0]!.state).toBe('failed');
  expect(team.members[0]!.error).toContain('cmux 실행 런타임이 이 호스트에 연결되지 않았습니다');
  expect(team.members[0]!.surface).toBe('cmux');
  expect(h.workroom).toEqual([]);
  expect(team.members[0]!.sessionId).toBeNull();
});

test('a managed checkout replaces the planned path and branch durably before target derivation and external start', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'team-managed-')), 'teams.json'), calls: unknown[][] = [];
  const actual = {path: '/orca/managed/checkout', branch: 'orca/member-actual'};
  let targetChecked = false, started = 0;
  const h = host({start: async input => {
    started++;
    const persisted = new WorkroomTeamStore(file).get(input.teamId)!.members[0]!;
    expect(persisted).toMatchObject({branch: actual.branch, worktreePath: actual.path, targetId: 'rwt_actual'});
    expect(input).toMatchObject({cwd: actual.path, targetId: 'rwt_actual'});
    expect(input.prompt).toContain(actual.path); expect(input.prompt).toContain(actual.branch);
    return orca();
  }});
  h.host.addWorktree = async (...args) => { calls.push(args); return args[4] === 'orca-worktree' ? actual : undefined; };
  h.host.worktreeTargetId = (_project, path) => {
    if (path === actual.path) {
      const team = new WorkroomTeamStore(file).all()[0]!;
      expect(team.members[0]).toMatchObject({worktreePath: actual.path, branch: actual.branch}); targetChecked = true;
      return 'rwt_actual';
    }
    return 'rwt_legacy';
  };
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(file));
  const {team} = await service.create(create([{agent: 'claude', task: 'Orca', surface: 'orca-worktree'}, {agent: 'codex', task: '기존 워크룸'}]), leader);
  expect(targetChecked).toBe(true); expect(started).toBe(1);
  expect(calls.map(args => args.length)).toEqual([5, 4]); expect(calls[0]![4]).toBe('orca-worktree');
  expect(team.members[0]).toMatchObject({worktreePath: actual.path, branch: actual.branch, targetId: 'rwt_actual'});
});

test('an actual managed checkout stays in the ledger when target derivation fails and close never deletes it without a ref', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'team-managed-failed-')), 'teams.json');
  const h = host({start: async () => { throw new Error('must not start'); }});
  h.host.addWorktree = async () => ({path: '/orca/managed/kept', branch: 'orca/kept'});
  h.host.worktreeTargetId = () => { throw new Error('target inventory unavailable'); };
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(file));
  const {team} = await service.create(create([{agent: 'claude', task: 'Orca', surface: 'orca-worktree'}]), leader);
  expect(new WorkroomTeamStore(file).get(team.id)!.members[0]).toMatchObject({worktreePath: '/orca/managed/kept', branch: 'orca/kept', targetId: null, state: 'failed'});
  const closed = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, leader);
  expect(closed.outcomes[0]).toMatchObject({session: 'kept', worktree: 'kept', branch: 'kept'});
  expect(h.started).toHaveLength(0); expect(h.removed).toHaveLength(0);
});

test('opening or prefilling is not working: each awaiting state is kept, never settles a wait, and is never resent', async () => {
  const cases: Array<[TeamExternalStarted['state'], TeamExternalStarted]> = [
    ['awaiting-connection', orca({ref: {kind: 'external', surface: 'cmux', runtime: 'cmux', handle: 'ws_pending', owned: false}, state: 'awaiting-connection', delivery: 'not-sent', note: 'cmux가 응답하지 않습니다'})],
    ['awaiting-manual-join', orca({ref: {kind: 'external', surface: 'app', runtime: 'codex-app', handle: 'conv_1', owned: false}, state: 'awaiting-manual-join', delivery: 'not-sent'})],
    ['awaiting-ack', orca({state: 'awaiting-ack', delivery: 'unknown'})],
  ];
  for (const [expected, result] of cases) {
    const service = new WorkroomTeamService(host({start: async () => result}).host, new WorkroomTeamStore(null));
    const {team} = await service.create(create([{agent: 'codex', task: '작업', surface: result.ref.surface}], `team-request-${expected}`), leader);
    expect(team.members[0]!.state).toBe(expected);
    expect(team.members[0]!.delivery).toBe(result.delivery);
    // Not finished: a wait on this team times out instead of reading a window as a result.
    expect(team.settled).toBe(0);
    const waited = await service.wait({op: 'wait', teamId: team.id, timeoutMs: 20, until: 'any'});
    expect(waited.timedOut).toBe(true);
    expect(waited.team.members[0]!.state).toBe(expected);
    expect(teamMemberAwaiting(waited.team.members[0]!)).toBe(true);
    // The strip shows the awaiting state itself — neither 「working」 nor 「ended」.
    expect(teamMemberDisplay(waited.team.members[0]!)).toBe(expected);
  }
});

test('a member on a surface the host cannot read is confirmed and reported by hand, with its provenance kept', async () => {
  const service = new WorkroomTeamService(host({start: async () => orca({ref: {kind: 'external', surface: 'app', runtime: 'codex-app', handle: 'conv_1', owned: false}, state: 'awaiting-manual-join', delivery: 'not-sent'})}).host,
    new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'codex', task: '앱에서 작업', surface: 'app', launchOptions: {appMode: 'new'}}]), leader);
  // An unverifiable report is refused until the leader says it is a transcription.
  await expect(service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: '다 했습니다'}, leader))
    .rejects.toThrow('호스트가 확인할 수 없습니다');
  const confirmed = await service.confirm({op: 'confirm', teamId: team.id, memberId: 'm1', confirm: 'delivered'}, leader);
  expect(confirmed.team.members[0]).toMatchObject({state: 'working', delivery: 'manual', manual: {confirmed: 'delivered'}});
  const reported = await service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: '화면에서 읽었습니다', manual: true}, leader);
  expect(reported.team.members[0]!.report).toMatchObject({status: 'done', summary: '화면에서 읽었습니다', provenance: 'manual'});
  // A member cannot confirm itself, and a Workroom member is never confirmed by hand or reported as a transcription.
  const workroom = new WorkroomTeamService(host().host, new WorkroomTeamStore(null));
  const plain = (await workroom.create(create([{agent: 'codex', task: '워크룸 작업'}], 'team-request-plain-1'), leader)).team;
  await expect(workroom.confirm({op: 'confirm', teamId: plain.id, memberId: 'm1', confirm: 'started'}, leader)).rejects.toThrow('워크룸 팀원이라 호스트가 직접 확인합니다');
  await expect(workroom.report({op: 'report', teamId: plain.id, memberId: 'm1', status: 'done', summary: 'x', manual: true}, leader)).rejects.toThrow('manual을 빼고');
  // A Workroom member's own report keeps the member provenance, so the strip never tags it as transcribed.
  expect((await workroom.report({op: 'report', teamId: plain.id, memberId: 'm1', status: 'done', summary: 'x'}, null)).team.members[0]!.report!.provenance).toBe('member');
});

test('cleanup ends only what this team started, and keeps the worktree whenever the end is unconfirmed', async () => {
  const closes: string[] = [];
  const runtime = (owned: boolean, closed: 'closed' | 'unknown'): TeamExternalRuntime => ({
    start: async () => orca({ref: {kind: 'external', surface: 'orca-worktree', runtime: 'orca', handle: 'term_7f31', owned}}),
    close: async ref => { closes.push(ref.handle); return {closed}; },
  });
  // Owned and confirmed closed: the session is reported closed, and the worktree is still kept — the team removes no
  // external checkout, because another window of that surface may be standing in it.
  const ownedHost = host(runtime(true, 'closed'));
  const ownedService = new WorkroomTeamService(ownedHost.host, new WorkroomTeamStore(null));
  const owned = (await ownedService.create(create([{agent: 'codex', task: '작업', surface: 'orca-worktree'}], 'team-request-close-1'), leader)).team;
  const ownedClose = await ownedService.close({op: 'close', teamId: owned.id, deleteMergedBranches: true}, leader);
  expect(closes).toEqual(['term_7f31']);
  expect(ownedClose.outcomes).toEqual([{memberId: 'm1', session: 'closed', worktree: 'kept', branch: 'kept'}]);
  expect(ownedHost.removed).toEqual([]);
  expect(ownedClose.team.state).toBe('closed');
  // Not owned: nothing is closed at all, and the team stays open so the user can end it in their own window.
  closes.length = 0;
  const foreignHost = host(runtime(false, 'closed'));
  const foreignService = new WorkroomTeamService(foreignHost.host, new WorkroomTeamStore(null));
  const foreign = (await foreignService.create(create([{agent: 'codex', task: '작업', surface: 'orca-worktree'}], 'team-request-close-2'), leader)).team;
  const foreignClose = await foreignService.close({op: 'close', teamId: foreign.id, deleteMergedBranches: true}, leader);
  expect(closes).toEqual([]);
  expect(foreignClose.outcomes[0]).toMatchObject({memberId: 'm1', session: 'kept', worktree: 'kept'});
  expect(foreignClose.outcomes[0]!.error).toContain('확인하지 못해 워크트리를 그대로 두었습니다');
  expect(foreignHost.removed).toEqual([]);
  expect(foreignClose.team.state).toBe('active');
  expect(foreignClose.team.members[0]!.state).toBe('unknown');
  // Owned but the runtime is unsure: same rule as not owned — keep the worktree and say it is unconfirmed.
  closes.length = 0;
  const unsureHost = host(runtime(true, 'unknown'));
  const unsureService = new WorkroomTeamService(unsureHost.host, new WorkroomTeamStore(null));
  const unsure = (await unsureService.create(create([{agent: 'codex', task: '작업', surface: 'orca-worktree'}], 'team-request-close-3'), leader)).team;
  const unsureClose = await unsureService.close({op: 'close', teamId: unsure.id, deleteMergedBranches: true}, leader);
  expect(closes).toEqual(['term_7f31']);
  expect(unsureClose.outcomes[0]).toMatchObject({session: 'kept', worktree: 'kept'});
  expect(unsureHost.removed).toEqual([]);
  expect(unsureClose.team.state).toBe('active');
});

test('the team status shows every surface and its honest state, and no handle, account or permission leaves the ledger', async () => {
  const service = new WorkroomTeamService(host({start: async () => orca({ref: {kind: 'external', surface: 'cmux', effectiveSurface: 'cmux', runtime: 'cmux', handle: 'term_secret_handle', owned: false}, state: 'awaiting-ack', delivery: 'unknown', note: 'cmux 연결 확인 대기'})}).host,
    new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'claude', task: '작업', surface: 'cmux', launchOptions: {bgMode: false, tmuxMode: true}, bypassPermissions: true}]), leader);
  const panel = teamPanelView(await service.view(service.store.get(team.id)!, {git: false}), 'leader-1');
  expect(panel.members[0]).toMatchObject({surface: 'cmux', launch: 'cmux · bg off · tmux', effectiveSurface: 'cmux', owned: false, delivery: 'unknown', state: 'awaiting-ack'});
  expect(panel.members[0]!.note).toContain('cmux');
  expect(normalizeTeamPanelResult({teams: [panel]}).teams[0]!.members[0]!.launchOptions).toEqual({bgMode: false, tmuxMode: true});
  const serialized = JSON.stringify(panel);
  for (const key of ['execution', 'handle', 'runtime', 'accountId', 'bypassPermissions', 'worktreePath', 'targetId']) expect(serialized).not.toContain(`"${key}"`);
  expect(serialized).not.toContain('term_secret_handle');
});



test('a late observation cannot undo a report or a confirmed close', async () => {
  let pending = false, release!: (value: any) => void, entered!: () => void;
  let enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const h = host({start: async () => orca(), observe: async () => {
    if (!pending) return {state: 'working', delivery: 'verified'};
    entered(); return new Promise(resolve => { release = resolve; });
  }, close: async () => ({closed: 'closed'})});
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'claude', task: '작업', surface: 'orca-worktree'}]), leader);
  pending = true;
  const read = service.read({op: 'read', teamId: team.id}); await enteredPromise;
  await service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: '실제 보고', manual: true}, leader);
  release({state: 'working', delivery: 'unknown'});
  expect((await read).team!.members[0]).toMatchObject({state: 'reported', report: {summary: '실제 보고'}, delivery: 'verified'});
  // A separate unsettled member exercises close while a probe is still pending.
  pending = false;
  const second = (await service.create(create([{agent: 'claude', task: '다른 작업', surface: 'orca-worktree'}], 'team-request-close-race'), leader)).team;
  enteredPromise = new Promise<void>(resolve => { entered = resolve; }); pending = true;
  const late = service.read({op: 'read', teamId: second.id}); await enteredPromise;
  await service.close({op: 'close', teamId: second.id, deleteMergedBranches: true}, leader);
  release({state: 'working'});
  expect((await late).team!.state).toBe('closed');
  expect(service.store.get(second.id)!.members[0]!.state).toBe('closed');
});

test('manual progress survives passive waiting observations, with strict leader scope and replay preservation', async () => {
  let tick = 1000;
  const h = host({start: async () => orca({ref: {kind: 'external', surface: 'app', runtime: 'app', handle: 'app_1', owned: false}, state: 'awaiting-manual-join', delivery: 'not-sent'}),
    observe: async () => ({state: 'awaiting-manual-join', delivery: 'not-sent', note: '직접 확인', lastOutputAt: 900})});
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(null), () => tick);
  const {team} = await service.create(create([{agent: 'codex', task: '작업', surface: 'app'}]), leader);
  const confirm = {op: 'confirm' as const, teamId: team.id, memberId: 'm1', confirm: 'delivered' as const};
  for (const caller of [null, {sessionId: 'unrelated', agent: 'codex' as const}]) {
    await expect(service.confirm(confirm, caller)).rejects.toThrow('리더');
    await expect(service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: 'x', manual: true}, caller)).rejects.toThrow('리더');
  }
  const first = await service.confirm(confirm, leader), at = first.team.members[0]!.manual!.at;
  expect(first.team.members[0]).toMatchObject({state: 'working', delivery: 'manual', note: '직접 확인', lastOutputAt: 900});
  tick++;
  const repeated = await service.confirm({...confirm, confirm: 'started'}, leader);
  expect(repeated.team.members[0]!.manual).toEqual({confirmed: 'delivered', at});
  expect((await service.read({op: 'read', teamId: team.id})).team!.members[0]!.state).toBe('working');
  const externalLeader = (await service.create(create([{agent: 'codex', task: '작업', surface: 'app'}], 'team-request-external-leader'), null)).team;
  expect((await service.confirm({...confirm, teamId: externalLeader.id}, null)).team!.members[0]!.delivery).toBe('manual');
});

test('external start failure without a persisted ref never removes its possibly live checkout', async () => {
  const h = host({start: async () => { throw new Error('created a window but its receipt was lost'); }});
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'codex', task: '작업', surface: 'orca-worktree'}]), leader);
  expect(team.members[0]!.execution).toBeUndefined();
  const closed = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, leader);
  expect(closed.team.state).toBe('active');
  expect(closed.team.members[0]!.state).toBe('unknown');
  expect(closed.outcomes[0]).toMatchObject({session: 'kept', worktree: 'kept', branch: 'kept'});
  expect(h.removed).toEqual([]); expect(h.closed).toEqual([]);
});

test('a stuck external observer respects the wait budget and retains its ref without another launch', async () => {
  let stuck = false, observations = 0;
  const h = host({start: async () => orca(), observe: async () => {
    observations++;
    if (stuck) return new Promise(() => {});
    return {state: 'working', lastOutputAt: Infinity};
  }});
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'claude', task: '작업', surface: 'orca-worktree'}]), leader);
  expect(team.members[0]!.lastOutputAt).toBeNull();
  stuck = true; const before = performance.now();
  const result = await service.wait({op: 'wait', teamId: team.id, timeoutMs: 20, until: 'all'});
  expect(performance.now() - before).toBeLessThan(800);
  expect(result.team.members[0]).toMatchObject({state: 'unknown', execution: {handle: 'term_7f31'}});
  expect(observations).toBe(2); expect(h.started).toHaveLength(1);
});


test('member read/send/reveal parse strict operation-specific fields and UTF-8 bounds without launching', () => {
  const base = {op: 'member' as const, teamId: 'team_123456789abc', memberId: 'm1'};
  const parse = (fields: Record<string, unknown>) => parseWorkroomTeamRequest({...base, ...fields});
  expect(parse({operation: 'read'})).toEqual({...base, operation: 'read', limit: 4000});
  expect(parse({operation: 'read', cursor: 'cursor_1', limit: 8000})).toEqual({...base, operation: 'read', cursor: 'cursor_1', limit: 8000});
  const requestId = 'member-request-1';
  expect(parse({operation: 'send', requestId, text: '  후속 작업\n확인  '})).toEqual({...base, operation: 'send', requestId, text: '후속 작업\n확인'});
  expect(parse({operation: 'send', requestId, text: '한'.repeat(6666)})).toHaveProperty('text', '한'.repeat(6666));
  expect(parse({operation: 'reveal', requestId})).toEqual({...base, operation: 'reveal', requestId});
  for (const fields of [
    {operation: 'read', text: 'wrong'}, {operation: 'read', requestId}, {operation: 'read', limit: 8001}, {operation: 'read', limit: '8'}, {operation: 'read', limit: 0},
    {operation: 'read', cursor: 'x'.repeat(513)}, {operation: 'read', cursor: 'bad\n'},
    {operation: 'send', text: 'missing id'}, {operation: 'send', requestId, text: '한'.repeat(6667)}, {operation: 'send', requestId, text: 'bad\0text'},
    {operation: 'send', requestId, text: '!shell'}, {operation: 'send', requestId, text: ' ', cursor: 'wrong'}, {operation: 'send', requestId, text: 'x', limit: 2},
    {operation: 'reveal'}, {operation: 'reveal', requestId, cursor: 'wrong'}, {operation: 'reveal', requestId, text: 'wrong'}, {operation: 'destroy', requestId},
  ]) expect(() => parse(fields)).toThrow();
});

test('external workers and reviewers report in their own terminal for the leader to read and transcribe', async () => {
  const h = host({start: async () => orca()});
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(null));
  await service.create(create([{agent: 'claude', task: '구현', surface: 'orca-worktree'}, {agent: 'codex', task: '검토', role: 'reviewer', surface: 'orca-worktree'}]), leader);
  for (const launch of h.started) {
    expect(launch.prompt).toContain('현재 터미널에 teamId');
    expect(launch.prompt).toContain('팀원 통합 read');
    expect(launch.prompt).toContain('manual: true');
    expect(launch.prompt).not.toContain('agentstoz_use_report_team_task');
    expect(launch.prompt).toContain(launch.cwd);
  }
});
