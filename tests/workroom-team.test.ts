import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {aiTerminalLaunchArgs, launchModelArgs} from '../src/aiTerminalLaunchArgs';
import {parseWorkroomTeamRequest, teamLeaderInstruction, WorkroomTeamService, WorkroomTeamStore, type WorkroomTeamHost, type WorkroomTeamRequest} from '../src/workroomTeam';
import {launchModelError, TEAM_MODEL_CHOICES} from '../src/workroomTeamInstruction';
import {CODEX_EFFORT_CATALOG} from '../src/codexEffortModel';
import {normalizeAiTerminalRequest} from '../src/aiTerminalProtocol';
import {parseTeamPanelRequest} from '../src/workroomTeamPanel';

type Started = {targetId: string; agent: string; prompt: string; requestId: string; model?: {model: string; provider?: string}; accountId?: string; bypassPermissions?: true; effort: {pinned: string} | {requestText: string}};
function fakeHost(overrides: Partial<WorkroomTeamHost> = {}) {
  const started: Started[] = [], worktrees: string[] = [], closed: string[] = [], removed: string[] = [], deleted: string[] = [];
  const sessions = new Map<string, 'running' | 'exited'>();
  const dirty = new Set<string>(), merged = new Set<string>(), gone = new Set<string>(), scopes: Array<{primaryPath: string; baseCheckout: string}> = [];
  // Open Workrooms that may join (attachable), and what the host typed into them (instruct).
  type Open = NonNullable<Awaited<ReturnType<WorkroomTeamHost['attachable']>>>;
  const open = new Map<string, Open>(), typed: Array<{sessionId: string; prompt: string; requestId: string}> = [], typing = {outcome: 'written' as 'written' | 'unknown'};
  const openSession = (sessionId: string, facts: Partial<Open> & {agent: Open['agent']}) => {
    open.set(sessionId, {targetId: `rwt_${sessionId}`, cwd: `/repo/worktrees/${sessionId}`, sameRepository: true, linked: true, baseCheckout: false, branch: `feature/${sessionId}`, containsBase: true, ...facts});
    sessions.set(sessionId, 'running');
  };
  const targetOf = (path: string) => `rwt_${path.split('/').pop()}`;
  const host: WorkroomTeamHost = {
    resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: '/repo'}),
    primary: async () => ({path: '/repo', base: '/repo', head: 'a'.repeat(40), branch: 'main', trackedChanges: [], untracked: 2}),
    addWorktree: async (_primary, path) => { worktrees.push(path); },
    worktreeTargetId: (_projectId, path) => targetOf(path),
    start: async input => { started.push(input); const sessionId = `s-${started.length}`; sessions.set(sessionId, 'running'); return {sessionId}; },
    session: (sessionId, _targetId) => ({state: sessions.get(sessionId) ?? 'missing', lastOutputAt: null}),
    close: async sessionId => { closed.push(sessionId); sessions.set(sessionId, 'exited'); },
    branchGit: async (scope, _base, branch) => (scopes.push(scope), {commits: 1, files: 2, insertions: 3, deletions: 0, merged: merged.has(branch)}),
    removeWorktree: async (_primary, path) => gone.has(path) ? 'missing' : dirty.has(path) ? 'dirty' : (removed.push(path), 'removed'),
    deleteMergedBranch: async (scope, branch) => (scopes.push(scope), merged.has(branch) ? (deleted.push(branch), 'deleted') : 'unmerged'),
    attachable: async sessionId => sessions.get(sessionId) === 'running' ? open.get(sessionId) ?? null : null,
    instruct: async input => { typed.push(input); return typing.outcome; },
    // Any Workroom running on a member's worktree target, which close keeps that checkout for unless it ended the member's own.
    sessionForTarget: async targetId => {
      for (const [sessionId, state] of sessions) if (state === 'running' && sessionTargets.get(sessionId) === targetId) return {sessionId};
      return null;
    },
    ...overrides,
  };
  const sessionTargets = new Map<string, string>();
  const start = host.start;
  host.start = async input => { const result = await start(input); sessionTargets.set(result.sessionId, input.targetId); return result; };
  return {host, started, worktrees, closed, removed, deleted, sessions, sessionTargets, dirty, merged, gone, scopes, targetOf, openSession, typed, typing};
}
const create = (members: unknown[], requestId = 'req-team-0001') => parseWorkroomTeamRequest({op: 'create', portId: 'port-1', requestId, title: '로그인 개선', goal: '로그인 흐름을 고친다', members}) as Extract<WorkroomTeamRequest, {op: 'create'}>;
const leader = {sessionId: 'leader-1', agent: 'claude' as const};

test('requests are exact: member bounds, agents, model only with a valid name, provider only for Hermes', () => {
  expect(() => create([])).toThrow('1명부터');
  expect(() => create(Array.from({length: 7}, () => ({agent: 'codex', task: 'x'})))).toThrow('6명까지');
  expect(() => create([{agent: 'gpt', task: 'x'}])).toThrow('AI는');
  expect(() => create([{agent: 'codex', task: 'x', cwd: '/tmp'}])).toThrow('알 수 없는 필드');
  expect(() => create([{agent: 'codex', task: 'x', model: 'gpt 5; rm -rf'}])).toThrow('모델 이름');
  expect(() => create([{agent: 'codex', task: 'x', model: 'gpt-5.6', provider: 'openai'}])).toThrow('Hermes에서만');
  expect(() => create([{agent: 'hermes', task: 'x', provider: 'anthropic'}])).toThrow('model과 함께');
  expect(create([{agent: 'hermes', task: '테스트', model: 'anthropic/claude-sonnet-4', provider: 'anthropic'}]).op).toBe('create');
  // effort: absent is 「자동」; a level pins it; Antigravity picks effort with its model variant.
  expect((create([{agent: 'codex', task: 'x', model: 'gpt-6.1-sol', effort: 'high'}]) as Extract<WorkroomTeamRequest, {op: 'create'}>).members[0]).toMatchObject({effort: 'high'});
  expect(() => create([{agent: 'codex', task: 'x', effort: 'xhigh'}])).toThrow('확인된 에포트');
  expect(() => create([{agent: 'claude', task: 'x', effort: 'auto'}])).toThrow('확인된 에포트');
  expect(() => create([{agent: 'agy', task: 'x', effort: 'low'}])).toThrow('확인된 에포트');
  expect(() => parseWorkroomTeamRequest({op: 'read'})).toThrow('하나로');
  expect(() => parseWorkroomTeamRequest({op: 'wait', teamId: 'team_0123456789ab', timeoutMs: 60_000})).toThrow('timeoutMs');
  expect(() => parseWorkroomTeamRequest({op: 'report', teamId: 'team_0123456789ab', memberId: 'm7', status: 'done', summary: 'x'})).toThrow('memberId');
  expect(() => parseWorkroomTeamRequest({op: 'merge', teamId: 'team_0123456789ab'})).toThrow('op는');
});

test('each CLI gets its own model flag; omitted keeps the launch byte-identical', () => {
  expect(launchModelArgs('claude', {model: 'claude-opus-5'})).toEqual(['--model', 'claude-opus-5']);
  expect(launchModelArgs('codex', {model: 'gpt-5.6'})).toEqual(['-m', 'gpt-5.6']);
  expect(launchModelArgs('agy', {model: 'gemini-3-pro'})).toEqual(['--model', 'gemini-3-pro']);
  expect(launchModelArgs('hermes', {model: 'anthropic/claude-sonnet-4', provider: 'anthropic'})).toEqual(['-m', 'anthropic/claude-sonnet-4', '--provider', 'anthropic']);
  expect(aiTerminalLaunchArgs('hermes', 'x', 'hi', false, null, null, false, null, {model: 'gpt-5.6', provider: 'openai-codex'}).slice(0, 5)).toEqual(['chat', '-m', 'gpt-5.6', '--provider', 'openai-codex']);
  expect(aiTerminalLaunchArgs('claude', 'id', undefined, false, null, null, false, null, {model: 'claude-opus-5'})).toEqual(['--session-id', 'id', '--permission-mode', 'default', '--model', 'claude-opus-5']);
  expect(aiTerminalLaunchArgs('claude', 'id')).toEqual(['--session-id', 'id', '--permission-mode', 'default']);
  expect(() => launchModelArgs('codex', {model: '--dangerously-bypass'})).toThrow('모델 이름');
});

test('a new member may name a registered CLI account and ask for bypass; both are explicit, validated and host-only', () => {
  const ACCOUNT = 'acct_3f2a9c1e-6b47-4d58-9a0e-7c15d2b8e410';
  const members = (list: unknown[]) => (create(list) as Extract<WorkroomTeamRequest, {op: 'create'}>).members;
  // Accepted for the CLIs that have accounts, with the app's own id shape.
  expect(members([{agent: 'codex', task: 'x', accountId: ACCOUNT}])[0]).toMatchObject({accountId: ACCOUNT});
  expect(members([{agent: 'claude', task: 'x', accountId: 'host-default'}])[0]).toMatchObject({accountId: 'host-default'});
  expect(() => create([{agent: 'codex', task: 'x', accountId: 'acct_not-a-uuid'}])).toThrow('accountId');
  expect(() => create([{agent: 'codex', task: 'x', accountId: ''}])).toThrow('accountId');
  // Hermes and Antigravity have no account registry, so naming one is a refusal rather than a value that does nothing.
  expect(() => create([{agent: 'hermes', task: 'x', accountId: ACCOUNT}])).toThrow('CLI 계정은');
  expect(() => create([{agent: 'agy', task: 'x', accountId: 'host-default'}])).toThrow('CLI 계정은');
  // Bypass is a boolean and only an explicit true survives: false and absent are the ordinary approval mode.
  expect(members([{agent: 'claude', task: 'x', bypassPermissions: true}])[0]).toMatchObject({bypassPermissions: true});
  expect(members([{agent: 'claude', task: 'x', bypassPermissions: false}])[0]!.bypassPermissions).toBeUndefined();
  expect(members([{agent: 'claude', task: 'x'}])[0]!.bypassPermissions).toBeUndefined();
  expect(() => create([{agent: 'claude', task: 'x', bypassPermissions: 'true'}])).toThrow('bypassPermissions');
  expect(() => create([{agent: 'claude', task: 'x', bypassPermissions: 1}])).toThrow('bypassPermissions');
  // An open session runs with the account and approval mode it already has; a launch option there would never apply.
  for (const option of [{accountId: ACCOUNT}, {bypassPermissions: true}, {bypassPermissions: false}]) {
    expect(() => create([{agent: 'codex', task: 'x', sessionId: 'session-join-1', ...option}])).toThrow('열린 세션');
  }
  expect(() => create([{agent: 'codex', task: 'x', accountToken: ACCOUNT}])).toThrow('알 수 없는 필드');
});

test('the account and the approval mode reach the real start request, the ledger and the retry fingerprint', async () => {
  const ACCOUNT = 'acct_3f2a9c1e-6b47-4d58-9a0e-7c15d2b8e410';
  const dir = mkdtempSync(join(tmpdir(), 'team-launch-')), file = join(dir, 'teams.json');
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(file));
  const result = await service.create(create([
    {agent: 'codex', task: 'API 수정', accountId: ACCOUNT, bypassPermissions: true},
    {agent: 'claude', task: '테스트 추가', accountId: 'host-default'},
    {agent: 'hermes', task: '화면 수정'},
  ]), leader);
  // What the host actually sends to AiTerminalService.perform for each member.
  expect(fake.started.map(input => [input.accountId, input.bypassPermissions])).toEqual([[ACCOUNT, true], ['host-default', undefined], [undefined, undefined]]);
  // The ledger keeps them, so a reload and the leader's own read still describe the session that was started.
  expect(result.team.members.map(member => [member.accountId, member.bypassPermissions])).toEqual([[ACCOUNT, true], ['host-default', undefined], [undefined, undefined]]);
  const reloaded = new WorkroomTeamStore(file).get(result.team.id)!;
  expect(reloaded.members[0]).toMatchObject({accountId: ACCOUNT, bypassPermissions: true});
  expect(reloaded.members[2]!.accountId).toBeUndefined();
  // A retry of the same requestId with a different account is a conflict, not a second start on another account.
  const other = create([{agent: 'codex', task: 'API 수정', accountId: 'host-default', bypassPermissions: true}, {agent: 'claude', task: '테스트 추가', accountId: 'host-default'}, {agent: 'hermes', task: '화면 수정'}]);
  await expect(service.create(other, leader)).rejects.toThrow('다른 팀 요청에 이미 쓰였습니다');
  const sameBypass = create([{agent: 'codex', task: 'API 수정', accountId: ACCOUNT}, {agent: 'claude', task: '테스트 추가', accountId: 'host-default'}, {agent: 'hermes', task: '화면 수정'}]);
  await expect(service.create(sameBypass, leader)).rejects.toThrow('다른 팀 요청에 이미 쓰였습니다');
  expect(fake.started).toHaveLength(3);
  // The identical request still replays the one team without starting anyone again.
  const replay = await service.create(create([{agent: 'codex', task: 'API 수정', accountId: ACCOUNT, bypassPermissions: true}, {agent: 'claude', task: '테스트 추가', accountId: 'host-default'}, {agent: 'hermes', task: '화면 수정'}]), leader);
  expect(replay.replayed).toBe(true); expect(fake.started).toHaveLength(3);
});


test('create starts every member in its own worktree and branch from one base, with the brief, and persists the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-')), file = join(dir, 'teams.json');
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(file));
  const result = await service.create(create([{agent: 'codex', task: 'API 수정'}, {agent: 'hermes', task: '테스트 추가', model: 'gpt-5.6', provider: 'openai-codex'}, {agent: 'agy', task: '화면 수정'}]), leader);
  const team = result.team;
  expect(team.id).toMatch(/^team_[0-9a-f]{12}$/); expect(team.leader).toEqual({sessionId: 'leader-1', agent: 'claude'});
  expect(team.members.map(member => [member.id, member.agent, member.state, member.session])).toEqual([['m1', 'codex', 'working', 'running'], ['m2', 'hermes', 'working', 'running'], ['m3', 'agy', 'working', 'running']]);
  const short = team.id.slice(5, 11);
  expect(fake.worktrees).toEqual([`/repo/worktrees/team-${short}-m1-codex`, `/repo/worktrees/team-${short}-m2-hermes`, `/repo/worktrees/team-${short}-m3-agy`]);
  expect(team.members[1]!.branch).toBe(`team/${short}/m2-hermes`);
  expect(fake.started[1]!.model).toEqual({model: 'gpt-5.6', provider: 'openai-codex'}); expect(fake.started[0]!.model).toBeUndefined();
  // 「자동」 members are classified by their own task, never by the brief's shared rules.
  expect(fake.started.map(input => input.effort)).toEqual([{requestText: 'API 수정'}, {requestText: '테스트 추가'}, {requestText: '화면 수정'}]);
  const brief = fake.started[0]!.prompt;
  for (const part of [team.id, 'memberId m1', `team/${short}/m1-codex`, 'agentstoz_use_report_team_task', 'push하지 않습니다', 'm2 Hermes (openai-codex/gpt-5.6)', 'aaaaaaaaaaaa']) expect(brief).toContain(part);
  expect(result.untracked).toBe(2);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const reloaded = new WorkroomTeamStore(file).get(team.id)!;
  expect(reloaded.members.map(member => member.sessionId)).toEqual(['s-1', 's-2', 's-3']);
  expect(JSON.parse(readFileSync(file, 'utf8')).teams[0].members[0].task).toBe('API 수정');
});

test('a retried requestId replays its team without starting anyone again; a different request on that id conflicts', async () => {
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null));
  const first = await service.create(create([{agent: 'codex', task: 'A'}]), leader);
  const again = await service.create(create([{agent: 'codex', task: 'A'}]), leader);
  expect(again.replayed).toBe(true); expect(again.team.id).toBe(first.team.id); expect(fake.started).toHaveLength(1);
  await expect(service.create(create([{agent: 'codex', task: 'B'}]), leader)).rejects.toMatchObject({code: 'WORKROOM_TEAM_REQUEST_ID_CONFLICT'});
});

test('uncommitted tracked changes stop the team before any worktree exists; a failed member does not stop the others', async () => {
  const dirty = fakeHost({primary: async () => ({path: '/repo', base: '/repo', head: 'b'.repeat(40), branch: 'main', trackedChanges: ['src/a.ts'], untracked: 0})});
  await expect(new WorkroomTeamService(dirty.host, new WorkroomTeamStore(null)).create(create([{agent: 'codex', task: 'A'}]), leader)).rejects.toMatchObject({code: 'WORKROOM_TEAM_SOURCE_DIRTY'});
  expect(dirty.worktrees).toEqual([]);
  let calls = 0;
  const flaky = fakeHost(); const start = flaky.host.start;
  flaky.host.start = async input => { if (++calls === 1) throw new Error('codex CLI가 설치되어 있지 않습니다.'); return start(input); };
  const team = (await new WorkroomTeamService(flaky.host, new WorkroomTeamStore(null)).create(create([{agent: 'codex', task: 'A'}, {agent: 'claude', task: 'B'}]), leader)).team;
  expect(team.members.map(member => member.state)).toEqual(['failed', 'working']);
  expect(team.members[0]!.error).toContain('설치되어 있지 않습니다');
});

test('reports settle members, wait returns on the first or on all, and one member cannot report as another', async () => {
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null), Date.now, 20);
  const team = (await service.create(create([{agent: 'codex', task: 'A'}, {agent: 'claude', task: 'B'}]), leader)).team;
  const timedOut = await service.wait({op: 'wait', teamId: team.id, timeoutMs: 1_000, until: 'any'});
  expect(timedOut.timedOut).toBe(true);
  const any = service.wait({op: 'wait', teamId: team.id, timeoutMs: 5_000, until: 'any'});
  await expect(service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: 'x'}, {sessionId: 's-2', agent: 'claude'})).rejects.toMatchObject({code: 'WORKROOM_TEAM_REPORT_DENIED'});
  await service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: 'API 수정 · 커밋 2개 · bun test 통과'}, {sessionId: 's-1', agent: 'codex'});
  const first = await any;
  expect(first.timedOut).toBe(false); expect(first.team.settled).toBe(1); expect(first.team.members[0]!.report?.summary).toContain('커밋 2개');
  const all = service.wait({op: 'wait', teamId: team.id, timeoutMs: 5_000, until: 'all'});
  fake.sessions.set('s-2', 'exited');
  expect((await all).team.settled).toBe(2);
  // A report that lands before the wait starts is still seen through the leader's cursor.
  await service.report({op: 'report', teamId: team.id, memberId: 'm2', status: 'blocked', summary: '스키마 결정이 필요합니다'}, null);
  const cursor = await service.wait({op: 'wait', teamId: team.id, timeoutMs: 1_000, until: 'any', afterSettled: 0});
  expect(cursor.timedOut).toBe(false); expect(cursor.team.settled).toBe(2);
  expect(() => parseWorkroomTeamRequest({op: 'wait', teamId: team.id, afterSettled: 7})).toThrow('afterSettled');
  expect((await service.read({op: 'read', teamId: team.id})).team!.members[1]!.state).toBe('blocked');
});

test('close ends sessions and removes clean worktrees, but keeps dirty work and unmerged branches; members cannot close', async () => {
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null));
  const team = (await service.create(create([{agent: 'codex', task: 'A'}, {agent: 'claude', task: 'B'}, {agent: 'agy', task: 'C'}]), leader)).team;
  const [m1, m2, m3] = team.members;
  fake.merged.add(m1!.branch); fake.dirty.add(m3!.worktreePath);
  await expect(service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, {sessionId: 's-2', agent: 'claude'})).rejects.toMatchObject({code: 'WORKROOM_TEAM_CLOSE_DENIED'});
  const closed = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, leader);
  expect(closed.outcomes).toEqual([
    {memberId: 'm1', session: 'closed', worktree: 'removed', branch: 'deleted'},
    {memberId: 'm2', session: 'closed', worktree: 'removed', branch: 'kept-unmerged'},
    {memberId: 'm3', session: 'closed', worktree: 'kept-dirty', branch: 'kept'},
  ]);
  expect(fake.deleted).toEqual([m1!.branch]); expect(fake.removed).toEqual([m1!.worktreePath, m2!.worktreePath]);
  expect(closed.team.state).toBe('closed');
  await expect(service.report({op: 'report', teamId: team.id, memberId: 'm2', status: 'done', summary: 'late'}, null)).rejects.toMatchObject({code: 'WORKROOM_TEAM_CLOSED'});
});

test('the leader instruction names every member, model and the merge-and-close order', () => {
  const instruction = teamLeaderInstruction({goal: '결제 오류 수정', members: [{agent: 'codex', task: '백엔드'}, {agent: 'hermes', model: 'claude-opus-5', provider: 'anthropic'}]});
  for (const part of ['[AgentsToZ 팀 작전 · 리더]', 'agentstoz-team', '결제 오류 수정', '팀원 1: Codex · 에포트 자동 — 백엔드', '팀원 2: Hermes (anthropic/claude-opus-5) · 에포트 자동 — 작업은 리더가 배분', 'agentstoz_use_create_team', 'agentstoz_use_close_team', 'push는 하지 않습니다']) {
    expect(instruction).toContain(part);
  }
});

test('a pinned effort rides the ledger, the brief and the member launch; the leader is told which members to pin', async () => {
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'codex', task: '큐 교착 수정', model: 'gpt-6.1-sol', effort: 'high'}, {agent: 'agy', task: '화면', model: 'gemini-4-argon-low'}]), leader);
  expect(team.members[0]).toMatchObject({effort: 'high', model: 'gpt-6.1-sol'});
  expect(team.members[1]!.effort).toBeUndefined();
  expect(fake.started[0]!.effort).toEqual({pinned: 'high'});
  expect(fake.started[0]!.model).toEqual({model: 'gpt-6.1-sol'});
  // Antigravity has no separate effort, so neither label claims one.
  expect(fake.started[1]!.prompt).toContain('m1 Codex (gpt-6.1-sol) · 에포트 고정 high');
  expect(fake.started[0]!.prompt).toContain('m2 Antigravity (gemini-4-argon-low):');
  const instruction = teamLeaderInstruction({goal: 'g', members: [{agent: 'claude', model: 'claude-opus-5-5', effort: 'low', task: '문구'}, {agent: 'hermes'}]});
  for (const part of ['팀원 1: Claude Code (claude-opus-5-5) · 에포트 고정 low — 문구', '팀원 2: Hermes · 에포트 자동', '「에포트 고정 <값>」인 팀원만 effort에']) expect(instruction).toContain(part);
});

test('the builder\'s model lists are launchable names, and every Codex choice is a model whose effort can be proven', () => {
  for (const [agent, choices] of Object.entries(TEAM_MODEL_CHOICES)) {
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) expect(launchModelError(agent as 'codex', {model: choice.model, ...(choice.provider ? {provider: choice.provider} : {})})).toBeNull();
    expect(new Set(choices.map(choice => `${choice.provider ?? ''}/${choice.model}`)).size).toBe(choices.length);
  }
  for (const choice of TEAM_MODEL_CHOICES.codex) expect(Object.hasOwn(CODEX_EFFORT_CATALOG, choice.model)).toBe(true);
  expect(TEAM_MODEL_CHOICES.hermes.every(choice => !!choice.provider)).toBe(true);
});

test('the ledger records a member worktree and its target before that member starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-')), file = join(dir, 'teams.json');
  const fake = fakeHost();
  const seen: Array<{state: string; targetId: string | null; sessionId: string | null}> = [];
  const start = fake.host.start;
  // What a crash during this start would leave behind: the worktree is already on disk, so the ledger must name it.
  fake.host.start = async input => { const stored = JSON.parse(readFileSync(file, 'utf8')).teams[0].members[0]; seen.push({state: stored.state, targetId: stored.targetId, sessionId: stored.sessionId}); return start(input); };
  const {team} = await new WorkroomTeamService(fake.host, new WorkroomTeamStore(file)).create(create([{agent: 'codex', task: 'A'}]), leader);
  expect(seen).toEqual([{state: 'starting', targetId: fake.targetOf(team.members[0]!.worktreePath), sessionId: null}]);
});

test('close never ends a Workroom the ledger did not record for the member, keeps that checkout, and keeps going when one member fails', async () => {
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null));
  let derive = 0;
  const targetId = fake.host.worktreeTargetId;
  // m1: the target could not be derived while starting (a realpath failure), so the ledger holds no target or session.
  fake.host.worktreeTargetId = (projectId, path) => { if (++derive === 1) throw new Error('realpath 실패'); return targetId(projectId, path); };
  const {team} = await service.create(create([{agent: 'codex', task: 'A'}, {agent: 'claude', task: 'B'}, {agent: 'agy', task: 'C'}]), leader);
  const [m1, m2, m3] = team.members;
  expect(m1!.state).toBe('failed'); expect(m1!.targetId).toBeNull(); expect(m1!.sessionId).toBeNull();
  // A Workroom running on m1's worktree that the ledger never recorded: a person may have opened it, so it is not the team's.
  fake.sessions.set('orphan-1', 'running'); fake.sessionTargets.set('orphan-1', fake.targetOf(m1!.worktreePath));
  fake.merged.add(m2!.branch);
  const removeWorktree = fake.host.removeWorktree;
  fake.host.removeWorktree = async (primary, path) => { if (path === m3!.worktreePath) throw new Error('worktree is locked'); return removeWorktree(primary, path); };
  const closed = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, leader);
  expect(closed.outcomes).toEqual([
    {memberId: 'm1', session: 'kept', worktree: 'kept', branch: 'kept', error: expect.stringContaining('orphan-1')},
    {memberId: 'm2', session: 'closed', worktree: 'removed', branch: 'deleted'},
    {memberId: 'm3', session: 'closed', worktree: 'kept-error', branch: 'kept-error', error: 'worktree is locked'},
  ]);
  expect(fake.closed).toEqual(['s-1', 's-2']);
  expect(fake.removed).toEqual([m2!.worktreePath]);
  // A member whose cleanup could not finish keeps the team closable again; nothing was lost.
  expect(closed.team.state).toBe('active');
  // m3's Workroom did end, so it is not 「working」 any more — but its cleanup did not finish, so it is not 「closed」 either.
  expect(closed.team.members.map(member => member.state)).toEqual(['failed', 'closed', 'exited']);
  fake.host.removeWorktree = removeWorktree;
  // That Workroom ends; the same close then finishes both checkouts.
  fake.sessions.set('orphan-1', 'exited');
  const again = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, leader);
  expect(again.outcomes[0]).toEqual({memberId: 'm1', session: 'not-running', worktree: 'removed', branch: 'kept-unmerged'});
  expect(again.outcomes[2]).toEqual({memberId: 'm3', session: 'not-running', worktree: 'removed', branch: 'kept-unmerged'});
  expect(fake.closed).toEqual(['s-1', 's-2']);
  expect(again.team.state).toBe('closed');
});

test('a Workroom that ended without a report reads exited; a ledger reopened in another run reads unknown and settles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-')), file = join(dir, 'teams.json');
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(file), Date.now, 20);
  const {team} = await service.create(create([{agent: 'codex', task: 'A'}, {agent: 'claude', task: 'B'}]), leader);
  fake.sessions.set('s-1', 'exited');
  const read = (await service.read({op: 'read', teamId: team.id})).team!;
  expect(read.members.map(member => [member.state, member.session])).toEqual([['exited', 'exited'], ['working', 'running']]);
  expect(read.settled).toBe(1);
  // Another run of the app: the PTYs are gone, so neither member can be observed any more.
  const after = new WorkroomTeamService(fakeHost().host, new WorkroomTeamStore(file), Date.now, 20);
  const reopened = (await after.read({op: 'read', teamId: team.id})).team!;
  expect(reopened.members.map(member => [member.state, member.session])).toEqual([['exited', 'missing'], ['unknown', 'missing']]);
  expect(reopened.settled).toBe(2);
  const all = await after.wait({op: 'wait', teamId: team.id, timeoutMs: 1_000, until: 'all'});
  expect(all.timedOut).toBe(false);
  expect(JSON.parse(readFileSync(file, 'utf8')).teams[0].members[1].state).toBe('unknown');
});

test('a report is answered while create is still starting other members', async () => {
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null));
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const start = fake.host.start;
  fake.host.start = async input => { const result = await start(input); if (input.targetId.endsWith('m2-claude')) await held; return result; };
  const creating = service.create(create([{agent: 'codex', task: 'A'}, {agent: 'claude', task: 'B'}]), leader);
  await new Promise(resolve => setTimeout(resolve, 20));
  const teamId = (await service.read({op: 'read', portId: 'port-1'})).teams![0]!.id;
  const reported = await service.report({op: 'report', teamId, memberId: 'm1', status: 'done', summary: '먼저 끝났습니다'}, {sessionId: 's-1', agent: 'codex'});
  expect(reported.team.members[0]!.state).toBe('reported');
  release();
  const {team} = await creating;
  expect(team.members.map(member => member.state)).toEqual(['reported', 'working']);
  expect(team.members[0]!.report?.summary).toBe('먼저 끝났습니다');
});

test('a requestId whose team the ledger dropped is refused, never started a second time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-')), file = join(dir, 'teams.json');
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(file));
  const first = await service.create(create([{agent: 'codex', task: 'A'}], 'req-team-keep-0'), leader);
  await service.close({op: 'close', teamId: first.team.id, deleteMergedBranches: false}, leader);
  for (let index = 1; index <= 40; index++) {
    const {team} = await service.create(create([{agent: 'codex', task: 'A'}], `req-team-keep-${index}`), leader);
    await service.close({op: 'close', teamId: team.id, deleteMergedBranches: false}, leader);
  }
  expect(new WorkroomTeamStore(file).get(first.team.id)).toBeUndefined();
  const startsBefore = fake.started.length;
  await expect(service.create(create([{agent: 'codex', task: 'A'}], 'req-team-keep-0'), leader)).rejects.toMatchObject({code: 'WORKROOM_TEAM_REQUEST_ID_RETIRED'});
  expect(fake.started).toHaveLength(startsBefore);
  // The refusal survives a restart: the retired ids are part of the ledger file.
  await expect(new WorkroomTeamService(fake.host, new WorkroomTeamStore(file)).create(create([{agent: 'codex', task: 'A'}], 'req-team-keep-0'), leader))
    .rejects.toMatchObject({code: 'WORKROOM_TEAM_REQUEST_ID_RETIRED'});
});

test('merged and branch deletion are judged in the leader\'s own checkout, not the primary', async () => {
  const fake = fakeHost({primary: async () => ({path: '/repo', base: '/repo/worktrees/leader', head: 'c'.repeat(40), branch: 'leader-branch', trackedChanges: [], untracked: 0})});
  const service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'codex', task: 'A'}]), leader);
  expect(team.baseCheckout).toBe('/repo/worktrees/leader');
  fake.merged.add(team.members[0]!.branch);
  await service.read({op: 'read', teamId: team.id});
  const closed = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, leader);
  expect(closed.outcomes[0]!.branch).toBe('deleted');
  expect(fake.scopes.length).toBeGreaterThan(0);
  for (const scope of fake.scopes) expect(scope).toEqual({primaryPath: '/repo', baseCheckout: '/repo/worktrees/leader'});
});

test('a reviewer is read-only: its brief reviews the workers\' branches, workers know it reads them, the leader is told when to merge', async () => {
  expect(() => create([{agent: 'codex', task: 'x', role: 'lead'}])).toThrow("role은 'worker' 또는 'reviewer'");
  const parsed = create([{agent: 'codex', task: 'API', role: 'worker'}, {agent: 'claude', task: '보안 관점으로', role: 'reviewer'}]);
  expect(parsed.members.map(member => member.role)).toEqual([undefined, 'reviewer']);
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null));
  const {team} = await service.create(parsed, leader);
  expect(team.members.map(member => member.role)).toEqual([undefined, 'reviewer']);
  const worker = fake.started[0]!.prompt, reviewer = fake.started[1]!.prompt;
  expect(worker).toContain('검토 담당(m2)이 이 브랜치를 읽습니다');
  expect(worker).toContain('m2 Claude Code · 에포트 자동 · 검토 담당: 보안 관점으로');
  for (const part of ['[AgentsToZ 팀 작전 · 검토 담당 m2]', '읽기 전용', '파일을 고치거나 커밋하지 않습니다', `브랜치 ${team.members[0]!.branch}: API`,
    'agentstoz_use_wait_team', `git diff ${'a'.repeat(12)}...<브랜치>`, '보고는 증거가 아닙니다', 'agentstoz_use_report_team_task']) expect(reviewer).toContain(part);
  expect(reviewer).not.toContain('의미 있는 단위마다 이 브랜치에 커밋');
  // Alone, a reviewer reads the base checkout's history instead of waiting for anyone.
  await service.create(create([{agent: 'claude', task: '최근 3커밋', role: 'reviewer'}], 'req-team-solo-0001'), leader);
  expect(fake.started.at(-1)!.prompt).toContain('작업 팀원이 없습니다');
  expect(fake.started.at(-1)!.prompt).not.toContain('agentstoz_use_wait_team');
  // The role is part of the request: a retry that changes it is a different team.
  await expect(service.create(create([{agent: 'codex', task: 'API'}, {agent: 'claude', task: '보안 관점으로'}]), leader)).rejects.toMatchObject({code: 'WORKROOM_TEAM_REQUEST_ID_CONFLICT'});
  const instruction = teamLeaderInstruction({goal: 'g', members: [{agent: 'codex', task: 'API'}, {agent: 'claude', role: 'reviewer'}]});
  for (const part of ['팀원 2: Claude Code · 에포트 자동 · 검토 담당 — 검토 범위는 리더가 정함', 'role "reviewer"', '검토 담당의 보고를 받은 뒤 병합']) expect(instruction).toContain(part);
  expect(teamLeaderInstruction({goal: 'g', members: [{agent: 'claude', role: 'reviewer', task: 'HEAD~3..HEAD'}]})).toContain('작업 팀원이 없으면');
  expect(teamLeaderInstruction({goal: 'g', members: [{agent: 'codex', task: 'API'}]})).not.toContain('검토 담당');
});

test('an open session joins without a new worktree: its brief is typed once, it keeps its checkout and branch, and close leaves all of it', async () => {
  expect(() => create([{agent: 'codex', task: 'x', sessionId: 'session-open', model: 'gpt-6.1-sol'}])).toThrow('그 세션의 설정 그대로');
  expect(() => create([{agent: 'codex', task: 'x', sessionId: 'session-open', effort: 'high'}])).toThrow('그 세션의 설정 그대로');
  expect(() => create([{agent: 'codex', task: 'x', sessionId: '../x'}])).toThrow('sessionId');
  expect(() => create([{agent: 'codex', task: 'x', sessionId: 'session-open'}, {agent: 'codex', task: 'y', sessionId: 'session-open', role: 'reviewer'}])).toThrow('같은 열린 세션');
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null));
  // A worker in its own linked worktree whose branch predates the base; a reviewer sitting in the primary checkout.
  fake.openSession('session-open1', {agent: 'codex', containsBase: false});
  fake.openSession('session-open2', {agent: 'claude', cwd: '/repo', linked: false, branch: 'main'});
  const {team} = await service.create(create([{agent: 'codex', task: 'API', sessionId: 'session-open1'}, {agent: 'claude', task: '보안 관점', role: 'reviewer', sessionId: 'session-open2'}, {agent: 'hermes', task: '테스트'}]), leader);
  expect(fake.worktrees).toEqual(['/repo/worktrees/team-' + team.id.slice(5, 11) + '-m3-hermes']);
  expect(fake.started.map(start => start.agent)).toEqual(['hermes']);
  expect(fake.typed.map(item => [item.sessionId, item.requestId])).toEqual([['session-open1', `team-${team.id}-m1`], ['session-open2', `team-${team.id}-m2`]]);
  expect(team.members.map(member => [member.attached ?? false, member.branch, member.worktreePath, member.sessionId, member.state])).toEqual([
    [true, 'feature/session-open1', '/repo/worktrees/session-open1', 'session-open1', 'working'],
    [true, '', '/repo', 'session-open2', 'working'],
    [false, `team/${team.id.slice(5, 11)}/m3-hermes`, `/repo/worktrees/team-${team.id.slice(5, 11)}-m3-hermes`, 's-1', 'working']]);
  const [worker, reviewer] = fake.typed.map(item => item.prompt);
  for (const part of ['[AgentsToZ 팀 작전 · 팀원 m1]', '사람이 열어 둔 세션', '브랜치 feature/session-open1만 씁니다', `git merge ${'a'.repeat(12)}`]) expect(worker).toContain(part);
  for (const part of ['[AgentsToZ 팀 작전 · 검토 담당 m2]', '검토 담당으로 합류', '이 체크아웃(/repo)', '브랜치를 바꾸지 않습니다', '리더가 돌릴 검사']) expect(reviewer).toContain(part);
  expect(reviewer).not.toContain('git checkout --detach');
  expect(fake.started[0]!.prompt).toContain('m1 Codex · 열린 세션: API');
  // The reviewer has no branch to summarise; nobody asks Git about it.
  const viewed = await service.read({op: 'read', teamId: team.id});
  expect(viewed.team!.members[1]!.git).toBeNull();
  fake.merged.add('feature/session-open1');
  const {outcomes} = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, null);
  expect(outcomes.slice(0, 2)).toEqual([{memberId: 'm1', session: 'kept', worktree: 'kept', branch: 'kept'}, {memberId: 'm2', session: 'kept', worktree: 'kept', branch: 'kept'}]);
  expect(fake.closed).toEqual(['s-1']);
  expect(fake.deleted).not.toContain('feature/session-open1');
  expect(fake.sessions.get('session-open1')).toBe('running');
});

test('a session that cannot join is refused before anything is written, and an unconfirmed brief is never typed again', async () => {
  const fake = fakeHost(), store = new WorkroomTeamStore(null), service = new WorkroomTeamService(fake.host, store);
  fake.openSession('leader-1', {agent: 'claude'});
  fake.openSession('session-main', {agent: 'codex', cwd: '/repo', linked: false, branch: 'main'});
  fake.openSession('session-base', {agent: 'codex', baseCheckout: true});
  fake.openSession('session-detached', {agent: 'codex', branch: null});
  fake.openSession('session-other', {agent: 'codex', sameRepository: false});
  fake.openSession('session-ok', {agent: 'codex'});
  const refusal = async (member: Record<string, unknown>, message: string) => {
    await expect(service.create(create([member], `req-attach-${String(member.sessionId)}`), leader)).rejects.toMatchObject({code: 'WORKROOM_TEAM_ATTACH_REFUSED', message: expect.stringContaining(message)});
  };
  await refusal({agent: 'claude', task: 'x', role: 'reviewer', sessionId: 'leader-1'}, '리더 자신의 세션');
  await refusal({agent: 'codex', task: 'x', sessionId: 'session-gone'}, '실행 중이 아닙니다');
  await refusal({agent: 'claude', task: 'x', sessionId: 'session-ok'}, '그 세션의 AI는 Codex');
  await refusal({agent: 'codex', task: 'x', sessionId: 'session-other'}, '저장소 밖');
  await refusal({agent: 'codex', task: 'x', sessionId: 'session-main'}, '검토 담당으로만 합류');
  await refusal({agent: 'codex', task: 'x', sessionId: 'session-base'}, '검토 담당으로만 합류');
  await refusal({agent: 'codex', task: 'x', sessionId: 'session-detached'}, 'detached HEAD');
  expect([store.all().length, fake.worktrees.length, fake.typed.length, fake.started.length]).toEqual([0, 0, 0, 0]);
  // In the primary checkout it may still review.
  const reviewing = await service.create(create([{agent: 'codex', task: '변경 검토', role: 'reviewer', sessionId: 'session-main'}], 'req-attach-review'), leader);
  expect(reviewing.team.members[0]!.state).toBe('working');
  // While it works for one active team, it cannot join another.
  await expect(service.create(create([{agent: 'codex', task: 'x', role: 'reviewer', sessionId: 'session-main'}], 'req-attach-busy'), leader)).rejects.toMatchObject({message: expect.stringContaining('다른 진행 중 팀')});
  // A brief whose delivery is unknown: said so, and a retry of the same request types nothing.
  fake.typing.outcome = 'unknown';
  const unsure = await service.create(create([{agent: 'codex', task: 'API', sessionId: 'session-ok'}], 'req-attach-unknown'), leader);
  expect(unsure.team.members[0]).toMatchObject({state: 'failed', error: expect.stringContaining('다시 입력하지 않습니다')});
  const typedBefore = fake.typed.length;
  expect((await service.create(create([{agent: 'codex', task: 'API', sessionId: 'session-ok'}], 'req-attach-unknown'), leader)).replayed).toBe(true);
  expect(fake.typed.length).toBe(typedBefore);
  // The person's composer names the session for the leader, which passes only agent and sessionId.
  const instruction = teamLeaderInstruction({goal: 'g', members: [{agent: 'codex', sessionId: 'session-ok', sessionLabel: 'Demo · codex #2', task: 'API'}, {agent: 'claude', role: 'reviewer'}]});
  for (const part of ['팀원 1: 열린 세션 「Demo · codex #2」 · Codex · sessionId session-ok — API', 'agent와 sessionId만 넣고 model·effort는 넣지 않습니다']) expect(instruction).toContain(part);
});

test('one checkout holds one worker: two open sessions of the same worktree never both take work', async () => {
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null));
  // 「새 작업」 opens a second Workroom on the same worktree, so two running sessions can share one working tree.
  fake.openSession('session-wt-1', {agent: 'codex', cwd: '/repo/worktrees/shared', branch: 'feature/shared'});
  fake.openSession('session-wt-2', {agent: 'codex', cwd: '/repo/worktrees/shared', branch: 'feature/shared'});
  fake.openSession('session-main-1', {agent: 'claude', cwd: '/repo', linked: false, baseCheckout: true, branch: 'main'});
  fake.openSession('session-main-2', {agent: 'claude', cwd: '/repo', linked: false, baseCheckout: true, branch: 'main'});
  // Two workers in one working tree would commit over each other on one branch: refused before anything is written.
  await expect(service.create(create([{agent: 'codex', task: 'A', sessionId: 'session-wt-1'}, {agent: 'codex', task: 'B', sessionId: 'session-wt-2'}], 'req-two-workers'), leader))
    .rejects.toMatchObject({code: 'WORKROOM_TEAM_ATTACH_REFUSED', message: expect.stringContaining('같은 체크아웃')});
  // A worker beside a reviewer in the same tree is refused too: the reviewer reads a tree the worker is writing.
  await expect(service.create(create([{agent: 'codex', task: 'A', sessionId: 'session-wt-1'}, {agent: 'codex', task: '검토', role: 'reviewer', sessionId: 'session-wt-2'}], 'req-worker-and-reviewer'), leader))
    .rejects.toMatchObject({code: 'WORKROOM_TEAM_ATTACH_REFUSED', message: expect.stringContaining('같은 체크아웃')});
  expect([fake.worktrees.length, fake.typed.length, fake.started.length]).toEqual([0, 0, 0]);
  // Two reviewers may share a checkout: neither writes.
  const {team} = await service.create(create([{agent: 'claude', task: '보안 검토', role: 'reviewer', sessionId: 'session-main-1'}, {agent: 'claude', task: '성능 검토', role: 'reviewer', sessionId: 'session-main-2'}], 'req-two-reviewers'), leader);
  expect(team.members.map(member => [member.id, member.state, member.branch])).toEqual([['m1', 'working', ''], ['m2', 'working', '']]);
  // Branches never collide either: an attached worker cannot land on another member's branch.
  const other = fakeHost(), service2 = new WorkroomTeamService(other.host, new WorkroomTeamStore(null));
  other.openSession('session-aa', {agent: 'codex', cwd: '/repo/worktrees/a', branch: 'feature/same'});
  other.openSession('session-bb', {agent: 'codex', cwd: '/repo/worktrees/b', branch: 'feature/same'});
  await expect(service2.create(create([{agent: 'codex', task: 'A', sessionId: 'session-aa'}, {agent: 'codex', task: 'B', sessionId: 'session-bb'}], 'req-same-branch'), leader))
    .rejects.toMatchObject({code: 'WORKROOM_TEAM_ATTACH_REFUSED', message: expect.stringContaining('브랜치')});
  expect([other.worktrees.length, other.typed.length, other.started.length]).toEqual([0, 0, 0]);
});

test('a session still on an open team cannot join another, whatever it is waiting for', async () => {
  const fake = fakeHost(), store = new WorkroomTeamStore(null), service = new WorkroomTeamService(fake.host, store);
  fake.openSession('session-join', {agent: 'codex'});
  const {team} = await service.create(create([{agent: 'codex', task: '첫 팀 작업', sessionId: 'session-join'}], 'req-first-team'), leader);
  // Blocked: it asked the leader a question and the answer is still coming — a second brief would collide with it.
  await service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'blocked', summary: '기준이 모호합니다'}, {sessionId: 'session-join', agent: 'codex'});
  await expect(service.create(create([{agent: 'codex', task: '다른 팀 작업', sessionId: 'session-join'}], 'req-second-team'), leader))
    .rejects.toMatchObject({code: 'WORKROOM_TEAM_ATTACH_REFUSED', message: expect.stringContaining('다른 진행 중 팀')});
  // Reported and done, but the team is still open: the leader may still answer it, so it is still that team's.
  await service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: '끝났습니다'}, {sessionId: 'session-join', agent: 'codex'});
  await expect(service.create(create([{agent: 'codex', task: '다른 팀 작업', sessionId: 'session-join'}], 'req-third-team'), leader))
    .rejects.toMatchObject({message: expect.stringContaining(team.id)});
  // Once that team is closed it is free again.
  await service.close({op: 'close', teamId: team.id, deleteMergedBranches: false}, null);
  const {team: next} = await service.create(create([{agent: 'codex', task: '다른 팀 작업', sessionId: 'session-join'}], 'req-after-close'), leader);
  expect(next.members[0]).toMatchObject({attached: true, state: 'working'});
});

test('an open session joins only when the host knows which Workroom leads, and its id follows the terminal rule', async () => {
  const fake = fakeHost(), service = new WorkroomTeamService(fake.host, new WorkroomTeamStore(null));
  fake.openSession('session-open', {agent: 'codex'});
  // Without a caller the host cannot tell the leader's own session from a member's: 「not the leader」 would be unchecked.
  await expect(service.create(create([{agent: 'codex', task: 'x', sessionId: 'session-open'}], 'req-no-caller'), null))
    .rejects.toMatchObject({code: 'WORKROOM_TEAM_ATTACH_REFUSED', message: expect.stringContaining('리더 워크룸')});
  expect([fake.typed.length, fake.started.length]).toEqual([0, 0]);
  // A team of new Workrooms still needs no caller.
  expect((await service.create(create([{agent: 'codex', task: 'x'}], 'req-no-caller-fresh'), null)).team.members[0]!.state).toBe('working');
  // The id a session is named by is the one the terminal accepts (src/aiTerminalProtocol.ts), so a brief cannot be
  // refused halfway through its submission.
  expect(() => create([{agent: 'codex', task: 'x', sessionId: 'short'}])).toThrow('sessionId');
  expect(() => create([{agent: 'codex', task: 'x', sessionId: 'has.dot.and:colon'}])).toThrow('sessionId');
  const accepted = '3f2a9c1e-6b47-4d58-9a0e-7c15d2b8e410';
  expect(create([{agent: 'codex', task: 'x', sessionId: accepted}]).members[0]!.sessionId).toBe(accepted);
  for (const sessionId of [accepted, 'session_fixture_1', 'a'.repeat(160)]) {
    expect(normalizeAiTerminalRequest({operation: 'read', requestId: 'req-fixture-0001', sessionId, after: 0}).sessionId).toBe(sessionId);
    expect(create([{agent: 'codex', task: 'x', sessionId}]).members[0]!.sessionId).toBe(sessionId);
  }
  for (const sessionId of ['short', 'has.dot', 'with:colon', 'a'.repeat(161)]) {
    expect(() => normalizeAiTerminalRequest({operation: 'read', requestId: 'req-fixture-0001', sessionId, after: 0})).toThrow();
    expect(() => create([{agent: 'codex', task: 'x', sessionId}])).toThrow('sessionId');
  }
  // The panel reads the same rule, so 팀 현황 and create_team agree on what a session id is.
  expect(() => parseTeamPanelRequest({sessionId: 'has.dot', git: false})).toThrow();
  expect(parseTeamPanelRequest({sessionId: accepted, git: false}).sessionId).toBe(accepted);
});