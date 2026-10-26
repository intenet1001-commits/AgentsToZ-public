import {expect, test} from 'bun:test';
import {parseWorkroomTeamRequest, WorkroomTeamService, WorkroomTeamStore, type WorkroomTeamHost, type WorkroomTeamRequest} from '../src/workroomTeam';
import {normalizeTeamPanelResult, parseTeamPanelRequest, teamMemberDisplay, teamsForSession, TEAM_PANEL_MAX_TEAMS} from '../src/workroomTeamPanel';

function fakeHost() {
  const sessions = new Map<string, 'running' | 'exited'>(), gitCalls: string[] = [];
  let started = 0;
  const host: WorkroomTeamHost = {
    resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: '/Users/someone/repo'}),
    primary: async () => ({path: '/Users/someone/repo', base: '/Users/someone/repo', head: 'a'.repeat(40), branch: 'main', trackedChanges: [], untracked: 0}),
    addWorktree: async () => {},
    worktreeTargetId: (_projectId, path) => `rwt_${path.split('/').pop()}`,
    start: async () => { const sessionId = `s-${++started}`; sessions.set(sessionId, 'running'); return {sessionId}; },
    session: sessionId => ({state: sessions.get(sessionId) ?? 'missing', lastOutputAt: sessions.has(sessionId) ? 1_000 : null}),
    close: async sessionId => { sessions.set(sessionId, 'exited'); },
    sessionForTarget: async () => null,
    attachable: async () => null,
    instruct: async () => 'written',
    branchGit: async (_scope, _base, branch) => { gitCalls.push(branch); return {commits: 2, files: 3, insertions: 10, deletions: 1, merged: false}; },
    removeWorktree: async () => 'removed',
    deleteMergedBranch: async () => 'unmerged',
  };
  return {host, sessions, gitCalls};
}
const create = (requestId: string, members: unknown[]) => parseWorkroomTeamRequest({op: 'create', portId: 'port-1', requestId, title: '로그인 개선', goal: '로그인 흐름을 고친다', members}) as Extract<WorkroomTeamRequest, {op: 'create'}>;

test('requests are exact: a session id, and git only as a boolean (default on)', () => {
  expect(parseTeamPanelRequest({sessionId: 'leader-1'})).toEqual({sessionId: 'leader-1', git: true});
  expect(parseTeamPanelRequest({sessionId: 'leader-1', git: false})).toEqual({sessionId: 'leader-1', git: false});
  expect(() => parseTeamPanelRequest({sessionId: 'leader-1', portId: 'x'})).toThrow('허용되지 않은');
  expect(() => parseTeamPanelRequest({sessionId: '../etc'})).toThrow('세션');
  // The same session-id rule the terminal itself uses (src/workroomTeamInstruction.ts TEAM_SESSION_ID).
  expect(() => parseTeamPanelRequest({sessionId: 'a'})).toThrow('세션');
  expect(() => parseTeamPanelRequest({sessionId: 'has.dot.id'})).toThrow('세션');
  expect(() => parseTeamPanelRequest({sessionId: 'leader-1', git: 'yes'})).toThrow('형식');
  expect(() => parseTeamPanelRequest([])).toThrow('형식');
});

test('the leader and each member see their team; others see nothing; no local path leaves the sidecar', async () => {
  const {host, sessions} = fakeHost();
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null), () => Date.parse('2026-10-25T01:00:00Z'));
  await service.create(create('req-panel-0001', [{agent: 'codex', task: 'API', model: 'gpt-6.1-sol', effort: 'high'}, {agent: 'hermes', task: '테스트', role: 'reviewer'}]), {sessionId: 'leader-1', agent: 'claude'});
  const asLeader = await teamsForSession(service, {sessionId: 'leader-1', git: true});
  expect(asLeader.teams).toHaveLength(1);
  expect(asLeader.teams[0]).toMatchObject({role: 'leader', memberId: null, settled: 0, leader: {sessionId: 'leader-1', agent: 'claude'}});
  expect(asLeader.teams[0]!.members.map(member => [member.id, member.agent, member.effort ?? null, member.state, member.session])).toEqual([['m1', 'codex', 'high', 'working', 'running'], ['m2', 'hermes', null, 'working', 'running']]);
  // A reviewer is marked so the strip can tag it; a worker carries no role at all.
  expect(asLeader.teams[0]!.members.map(member => member.role ?? null)).toEqual([null, 'reviewer']);
  expect(JSON.stringify(asLeader)).not.toContain('/Users/someone');
  for (const key of ['primaryPath', 'worktreePath', 'baseCheckout', 'targetId', 'requestId', 'fingerprint']) expect(JSON.stringify(asLeader)).not.toContain(`"${key}"`);
  const asMember = await teamsForSession(service, {sessionId: 's-2', git: true});
  expect(asMember.teams[0]).toMatchObject({role: 'member', memberId: 'm2'});
  expect((await teamsForSession(service, {sessionId: 'someone-else', git: true})).teams).toEqual([]);
  // A member whose session ended without a report is shown as ended, not working (the ledger now says `exited`).
  sessions.set('s-1', 'exited');
  const after = await teamsForSession(service, {sessionId: 'leader-1', git: false});
  expect(after.teams[0]!.settled).toBe(1);
  expect(after.teams[0]!.members.map(member => [member.state, teamMemberDisplay(member)])).toEqual([['exited', 'ended'], ['working', 'working']]);
  expect(teamMemberDisplay({state: 'working', session: 'missing'})).toBe('ended');
  expect(teamMemberDisplay({state: 'unknown', session: null})).toBe('unknown');
});

test('a launch option of a member — its CLI account and its approval mode — never reaches the 팀 현황 projection', async () => {
  const ACCOUNT = 'acct_3f2a9c1e-6b47-4d58-9a0e-7c15d2b8e410';
  const {host} = fakeHost();
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null), () => Date.parse('2026-10-25T01:00:00Z'));
  const {team} = await service.create(create('req-panel-0009', [{agent: 'claude', task: 'API', accountId: ACCOUNT, bypassPermissions: true}]), {sessionId: 'leader-1', agent: 'claude'});
  // The ledger does keep them, so this proves the projection drops them rather than the team never having them.
  expect(team.members[0]).toMatchObject({accountId: ACCOUNT, bypassPermissions: true});
  const panel = JSON.stringify(await teamsForSession(service, {sessionId: 'leader-1', git: false}));
  for (const key of ['accountId', 'bypassPermissions']) expect(panel).not.toContain(`\"${key}\"`);
  expect(panel).not.toContain(ACCOUNT);
  expect(panel).not.toContain('acct_');
});


test('git:false reads only the ledger and live sessions — the poll never spawns Git', async () => {
  const {host, gitCalls} = fakeHost();
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
  await service.create(create('req-panel-0002', [{agent: 'codex', task: 'API'}, {agent: 'claude', task: '문서'}]), {sessionId: 'leader-1', agent: 'claude'});
  gitCalls.length = 0;
  const polled = await teamsForSession(service, {sessionId: 'leader-1', git: false});
  expect(gitCalls).toEqual([]);
  expect(polled.teams[0]!.members.every(member => member.git === null)).toBe(true);
  const full = await teamsForSession(service, {sessionId: 'leader-1', git: true});
  expect(gitCalls).toHaveLength(2);
  expect(full.teams[0]!.members[0]!.git).toEqual({commits: 2, files: 3, insertions: 10, deletions: 1, merged: false});
});

test('opening the strip first after a leader or member restart follows only the exact continuation', async () => {
  // No MCP read/view happens between the restart and the panel request. Filtering on old ledger IDs first would
  // hide the team forever in that session's status strip, even though MCP operations can already follow it.
  for (const restarted of ['leader', 'member'] as const) {
    const {host, sessions, gitCalls} = fakeHost();
    const continuations = new Map<string, {sessionId: string; targetId: string}>();
    host.continuation = (id, targetId) => {
      const next = continuations.get(id);
      return next?.targetId === targetId ? {sessionId: next.sessionId} : null;
    };
    const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
    const {team} = await service.create(create(`req-panel-restart-${restarted}`, [{agent: 'codex', task: 'API'}]),
      {sessionId: 'leader-old', targetId: 'project-target', agent: 'claude'});
    const member = team.members[0]!;
    const old = restarted === 'leader' ? 'leader-old' : member.sessionId!;
    const targetId = restarted === 'leader' ? 'project-target' : member.targetId!;
    const next = `${restarted}-continued`;
    sessions.set(old, 'exited'); sessions.set(next, 'running');
    continuations.set(old, {sessionId: next, targetId});
    gitCalls.length = 0;
    const panel = await teamsForSession(service, {sessionId: next, git: false});
    expect(panel.teams).toHaveLength(1);
    expect(panel.teams[0]!.role).toBe(restarted);
    expect(panel.teams[0]!.memberId).toBe(restarted === 'member' ? member.id : null);
    expect(restarted === 'leader' ? panel.teams[0]!.leader.sessionId : panel.teams[0]!.members[0]!.sessionId).toBe(next);
    expect(gitCalls).toEqual([]);
    expect((await teamsForSession(service, {sessionId: old, git: false})).teams).toEqual([]);
    // A different session on the same target has no verified resumeFrom edge and never sees this team.
    sessions.set('unrelated-session', 'running');
    expect((await teamsForSession(service, {sessionId: 'unrelated-session', git: false})).teams).toEqual([]);
    for (const key of ['targetId', 'worktreePath', 'baseCheckout', 'fingerprint']) expect(JSON.stringify(panel)).not.toContain(`"${key}"`);
  }
});

test('active teams come first, then the latest, and at most three', async () => {
  const {host} = fakeHost();
  let clock = Date.parse('2026-10-25T01:00:00Z');
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null), () => clock);
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    clock += 60_000;
    ids.push((await service.create(create(`req-panel-order-${index}`, [{agent: 'codex', task: `작업 ${index}`}]), {sessionId: 'leader-1', agent: 'claude'})).team.id);
  }
  clock += 60_000;
  await service.close({op: 'close', teamId: ids[4]!, deleteMergedBranches: false}, null);
  const shown = await teamsForSession(service, {sessionId: 'leader-1', git: false});
  expect(shown.teams).toHaveLength(TEAM_PANEL_MAX_TEAMS);
  expect(shown.teams.map(team => team.id)).toEqual([ids[3]!, ids[2]!, ids[1]!]);
});

test('the client keeps what it can read and drops a malformed team or member instead of guessing', () => {
  const member = {id: 'm1', name: 'm1-codex', agent: 'codex', task: 'API', branch: 'team/abc/m1-codex', state: 'reported', sessionId: 's-1', session: 'exited', lastOutputAt: 5,
    report: {status: 'done', summary: '끝', at: '2026-10-25T01:00:00Z'}, git: {commits: 1, files: 1, insertions: 1, deletions: 0, merged: true}};
  const team = {id: 'team_abc', title: 't', goal: 'g', state: 'active', role: 'leader', memberId: null, leader: {sessionId: 'leader-1', agent: 'claude'}, settled: 1,
    createdAt: '2026-10-25T01:00:00Z', updatedAt: '2026-10-25T01:00:00Z', members: [member]};
  const read = normalizeTeamPanelResult({teams: [team, {...team, id: 'team_bad', members: [{...member, agent: 'gpt'}]}, {...team, id: 'team_bad2', state: 'paused'}]});
  expect(read.teams.map(item => item.id)).toEqual(['team_abc']);
  expect(read.teams[0]!.members[0]).toMatchObject({report: {status: 'done', summary: '끝'}, git: {merged: true}});
  expect(read.teams[0]!.members[0]!.role).toBeUndefined();
  expect(normalizeTeamPanelResult({teams: [{...team, members: [{...member, role: 'reviewer'}]}]}).teams[0]!.members[0]!.role).toBe('reviewer');
  expect(normalizeTeamPanelResult({teams: [{...team, members: [{...member, role: 'boss'}]}]}).teams[0]!.members[0]!.role).toBeUndefined();
  expect(normalizeTeamPanelResult({teams: [{...team, members: [{...member, attached: true}]}]}).teams[0]!.members[0]!.attached).toBe(true);
  expect(normalizeTeamPanelResult({teams: [{...team, members: [{...member, attached: 'yes'}]}]}).teams[0]!.members[0]!.attached).toBeUndefined();
  expect(normalizeTeamPanelResult({teams: [{...team, members: [{...member, git: {commits: -1}}]}]}).teams[0]!.members[0]!.git).toBeNull();
  expect(normalizeTeamPanelResult(null)).toEqual({teams: []});
  expect(normalizeTeamPanelResult({teams: Array.from({length: 5}, (_, index) => ({...team, id: `team_${index}`}))}).teams).toHaveLength(TEAM_PANEL_MAX_TEAMS);
});
