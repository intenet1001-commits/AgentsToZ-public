import {expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deriveAgentRuntimeWorktreeTargetId} from '../src/agentRuntimeTargetInventory';
import {agentsToZUseMcpActionForTool, agentsToZUseMcpTimeoutMs} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {parseWorkroomTeamRequest, WorkroomTeamService, WorkroomTeamStore, type WorkroomTeamRequest} from '../src/workroomTeam';
import {createWorkroomTeamHost, type WorkroomTeamHostDependencies} from '../src/workroomTeamHost';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com'}}).trim();
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-repo-')));
  git(root, 'init', '-q', '-b', 'main'); writeFileSync(join(root, 'app.txt'), 'v1\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  return root;
}
function terminal() {
  const calls: Array<{request: any; options: any}> = [], running = new Set<string>(), targets = new Map<string, string>();
  return {calls, running, service: {
    perform: async (request: any, _authority?: unknown, options: any = {}) => {
      calls.push({request, options});
      if (request.operation === 'start') { const id = `session-${calls.length}`; running.add(id); targets.set(id, request.targetId); return {session: {id, targetId: request.targetId}}; }
      if (request.operation === 'close') { running.delete(request.sessionId); return {}; }
      if (request.operation === 'list') return {sessions: [...running].map(id => ({id, targetId: targets.get(id), state: 'running'}))};
      return {};
    },
    runningSession: (id: string) => running.has(id) ? {id} : null,
    retiredSession: () => null,
    sessionActivity: (id: string) => ({id, lastOutputAt: 1}),
  }};
}
const create = (members: unknown[]) => parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId: 'team-request-1', title: '팀', goal: '목표', members}) as Extract<WorkroomTeamRequest, {op: 'create'}>;

function checkoutHost(root: string, overrides: Partial<WorkroomTeamHostDependencies> = {}) {
  return createWorkroomTeamHost({gitPath: 'git', terminal: terminal().service as any,
    resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: root}), targetCwd: async () => null,
    ensureExclude: async () => {}, seedConfig: () => {}, withLease: async (_path, _label, work) => work(), ...overrides});
}

test('real Git: four-argument checkout creation stays internal; Orca without its manager never falls back to Git', async () => {
  const root = repository(), base = git(root, 'rev-parse', 'HEAD'), seeds: string[] = [];
  const host = checkoutHost(root, {seedConfig: (_primary, path) => { seeds.push(path); }});
  const path = join(root, 'worktrees', 'legacy');
  expect(await host.addWorktree(root, path, 'team/legacy', base)).toBeUndefined();
  expect(git(path, 'rev-parse', 'HEAD')).toBe(base); expect(seeds).toEqual([path]);
  const missing = join(root, 'worktrees', 'orca-missing');
  await expect(host.addWorktree(root, missing, 'team/orca-missing', base, 'orca-worktree')).rejects.toThrow('Orca 관리 워크트리 생성 연결이 없습니다');
  expect(existsSync(missing)).toBe(false); expect(git(root, 'branch', '--list', 'team/orca-missing')).toBe('');
  expect(seeds).toEqual([path]);
});

test('real Git: Orca actual checkout is verified after creation and seeded only under the verification lease', async () => {
  const root = repository(), base = git(root, 'rev-parse', 'HEAD'), actual = join(root, 'worktrees', 'managed'), planned = join(root, 'worktrees', 'planned');
  const events: string[] = [], hooks: unknown[] = [];
  let leased = false;
  const host = checkoutHost(root, {
    createExternalWorktree: async input => {
      expect(leased).toBe(false); hooks.push(input); events.push('create');
      git(root, 'worktree', 'add', '-q', '-b', 'orca/managed', actual, input.base);
      return {path: actual, branch: 'orca/managed'};
    },
    withLease: async (_path, _label, work) => { leased = true; try { return await work(); } finally { leased = false; } },
    seedConfig: (primary, path) => { expect(primary).toBe(root); expect([actual, planned]).toContain(path); if (path === actual) expect(leased).toBe(true); events.push('seed'); },
  });
  expect(await host.addWorktree(root, planned, 'team/planned', base, 'orca-worktree')).toEqual({path: actual, branch: 'orca/managed'});
  expect(hooks).toEqual([{primaryPath: root, path: planned, branch: 'team/planned', base, surface: 'orca-worktree'}]);
  expect(events).toEqual(['create', 'seed']); expect(existsSync(planned)).toBe(false);
  // Supplying a manager does not change the old four-argument path or call that manager a second time.
  await host.addWorktree(root, planned, 'team/planned', base);
  expect(hooks).toHaveLength(1);
});

test('real Git: foreign, primary, non-root, detached, wrong-branch and wrong-base Orca paths are preserved without seeding', async () => {
  const root = repository(), base = git(root, 'rev-parse', 'HEAD'), actual = join(root, 'worktrees', 'managed');
  git(root, 'worktree', 'add', '-q', '-b', 'orca/managed', actual, base);
  mkdirSync(join(actual, 'subdir'));
  const foreign = repository(), detached = join(root, 'worktrees', 'detached'), advanced = join(root, 'worktrees', 'advanced');
  git(root, 'worktree', 'add', '-q', '--detach', detached, base);
  git(root, 'worktree', 'add', '-q', '-b', 'orca/advanced', advanced, base);
  writeFileSync(join(advanced, 'app.txt'), 'v2\n'); git(advanced, 'commit', '-qam', 'advance');
  const cases = [
    {path: foreign, branch: 'main'}, {path: root, branch: 'main'}, {path: join(actual, 'subdir'), branch: 'orca/managed'},
    {path: detached, branch: 'orca/detached'}, {path: actual, branch: 'orca/other'}, {path: advanced, branch: 'orca/advanced'},
    {path: actual, branch: '@{-1}'},
  ];
  for (const checkout of cases) {
    let seeded = false;
    const host = checkoutHost(root, {createExternalWorktree: async () => checkout, seedConfig: () => { seeded = true; }});
    await expect(host.addWorktree(root, join(root, 'worktrees', 'planned'), 'team/planned', base, 'orca-worktree')).rejects.toThrow('저장소·브랜치·기준 커밋을 확인하지 못했습니다');
    expect(seeded).toBe(false); expect(existsSync(checkout.path)).toBe(true);
  }
});

test('real Git: an uncertain Orca creation preserves its partial checkout without seeding, fallback or automatic cleanup', async () => {
  const root = repository(), base = git(root, 'rev-parse', 'HEAD'), actual = join(root, 'worktrees', 'partial'), planned = join(root, 'worktrees', 'planned');
  let seeded = false, attempts = 0;
  const host = checkoutHost(root, {seedConfig: () => { seeded = true; }, createExternalWorktree: async input => {
    attempts++; git(root, 'worktree', 'add', '-q', '-b', 'orca/partial', actual, input.base);
    throw new Error('Orca creation outcome is unknown');
  }});
  await expect(host.addWorktree(root, planned, 'team/planned', base, 'orca-worktree')).rejects.toThrow('outcome is unknown');
  expect(attempts).toBe(1); expect(seeded).toBe(false); expect(existsSync(actual)).toBe(true); expect(existsSync(planned)).toBe(false);
  expect(git(root, 'branch', '--list', 'orca/partial')).toContain('orca/partial'); expect(git(root, 'branch', '--list', 'team/planned')).toBe('');
});

test('real Git: members get worktrees and branches from one base; close keeps dirty work and unmerged branches', async () => {
  const root = repository(), term = terminal(), leases: string[] = [];
  const host = createWorkroomTeamHost({gitPath: 'git', terminal: term.service as any,
    resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: root}), targetCwd: async () => null,
    ensureExclude: async primary => { writeFileSync(join(primary, '.git/info/exclude'), '/worktrees/\n'); },
    seedConfig: () => {}, withLease: async (path, label, work) => { leases.push(`${label}@${path}`); return work(); }});
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
  writeFileSync(join(root, 'notes.md'), 'untracked\n');
  const {team, untracked} = await service.create(create([{agent: 'codex', task: 'API'}, {agent: 'hermes', task: '테스트', model: 'claude-opus-5', provider: 'anthropic'}]), {sessionId: 'leader', agent: 'claude'});
  expect(untracked).toBe(1);
  const [m1, m2] = team.members;
  expect(team.baseCommit).toBe(git(root, 'rev-parse', 'HEAD'));
  for (const member of [m1!, m2!]) {
    expect(existsSync(join(member.worktreePath, 'app.txt'))).toBe(true);
    expect(git(member.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(member.branch);
    expect(member.targetId).toBe(deriveAgentRuntimeWorktreeTargetId('port-demo', realpathSync(member.worktreePath)));
  }
  expect(git(root, 'status', '--porcelain')).toBe('?? notes.md');
  const starts = term.calls.filter(call => call.request.operation === 'start');
  expect(starts.map(call => call.request.targetId)).toEqual([m1!.targetId, m2!.targetId]);
  // 「에포트 자동」 members are classified by their own task, not by the brief.
  expect(starts[0]!.options).toEqual({launchEffort: {requestText: 'API'}});
  expect(starts[1]!.options).toEqual({launchModel: {model: 'claude-opus-5', provider: 'anthropic'}, launchEffort: {requestText: '테스트'}});
  expect(starts[1]!.request.prompt).toContain(m2!.branch);
  expect(leases.every(lease => lease.endsWith(`@${root}`))).toBe(true);

  writeFileSync(join(m1!.worktreePath, 'api.txt'), 'api\n'); git(m1!.worktreePath, 'add', '.'); git(m1!.worktreePath, 'commit', '-qm', 'api');
  writeFileSync(join(m2!.worktreePath, 'wip.txt'), 'not committed\n');
  const read = (await service.read({op: 'read', teamId: team.id})).team!;
  expect(read.members[0]!.git).toMatchObject({commits: 1, files: 1, insertions: 1, merged: false});
  expect(read.members[1]!.git).toMatchObject({commits: 0, merged: false});

  git(root, 'merge', '--no-ff', '-qm', 'merge m1', m1!.branch);
  expect((await service.read({op: 'read', teamId: team.id})).team!.members[0]!.git!.merged).toBe(true);
  const closed = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, {sessionId: 'leader', agent: 'claude'});
  expect(closed.outcomes).toEqual([
    {memberId: 'm1', session: 'closed', worktree: 'removed', branch: 'deleted'},
    {memberId: 'm2', session: 'closed', worktree: 'kept-dirty', branch: 'kept'},
  ]);
  expect(existsSync(m1!.worktreePath)).toBe(false); expect(existsSync(join(m2!.worktreePath, 'wip.txt'))).toBe(true);
  expect(git(root, 'branch', '--list', m1!.branch)).toBe(''); expect(git(root, 'branch', '--list', m2!.branch)).toContain(m2!.branch);
  expect(existsSync(join(root, 'api.txt'))).toBe(true);
});

test('real host: a member account and its approval mode ride on the start request, and nothing rides when unasked', async () => {
  const ACCOUNT = 'acct_3f2a9c1e-6b47-4d58-9a0e-7c15d2b8e410';
  const root = repository(), term = terminal();
  const host = createWorkroomTeamHost({gitPath: 'git', terminal: term.service as any,
    resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: root}), targetCwd: async () => null,
    ensureExclude: async () => {}, seedConfig: () => {}, withLease: async (_path, _label, work) => work()});
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([
    {agent: 'claude', task: '구현', accountId: ACCOUNT, bypassPermissions: true},
    {agent: 'codex', task: '검증'},
  ]), {sessionId: 'leader', agent: 'claude'});
  const starts = term.calls.filter(call => call.request.operation === 'start');
  expect(starts).toHaveLength(2);
  // The same request fields the app's own start sends (src/aiTerminalProtocol.ts), so account launch and validation are reused.
  expect(starts[0]!.request).toMatchObject({operation: 'start', targetId: team.members[0]!.targetId, agent: 'claude', accountId: ACCOUNT, bypassPermissions: true});
  // Launch options stay in the request; the host's own options object keeps carrying only the model and the effort.
  expect(starts[0]!.options).toEqual({launchEffort: {requestText: '구현'}});
  // A member that asked for neither is launched byte-identically to before: no account, no approval key at all.
  expect('accountId' in starts[1]!.request).toBe(false);
  expect('bypassPermissions' in starts[1]!.request).toBe(false);
});


test('real Git: a tracked change in the primary checkout refuses the team before any worktree', async () => {
  const root = repository(), term = terminal();
  const host = createWorkroomTeamHost({gitPath: 'git', terminal: term.service as any, resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: root}), targetCwd: async () => null,
    ensureExclude: async () => {}, seedConfig: () => {}, withLease: async (_path, _label, work) => work()});
  writeFileSync(join(root, 'app.txt'), 'edited\n');
  await expect(new WorkroomTeamService(host, new WorkroomTeamStore(null)).create(create([{agent: 'codex', task: 'x'}]), null)).rejects.toMatchObject({code: 'WORKROOM_TEAM_SOURCE_DIRTY', details: {changedPaths: ['app.txt']}});
  expect(existsSync(join(root, 'worktrees'))).toBe(false); expect(term.calls).toEqual([]);
});

test('real Git: a leader working in a linked worktree is the base; its own uncommitted changes refuse, another repository is ignored', async () => {
  const root = repository(), term = terminal();
  const leaderTree = join(root, 'worktrees', 'leader-branch');
  git(root, 'worktree', 'add', '-q', '-b', 'leader-branch', leaderTree);
  writeFileSync(join(leaderTree, 'plan.md'), 'plan\n'); git(leaderTree, 'add', '.'); git(leaderTree, 'commit', '-qm', 'leader plan');
  const other = repository();
  const cwdOf: Record<string, string> = {'rwt_leader': leaderTree, 'other-project': other};
  const host = createWorkroomTeamHost({gitPath: 'git', terminal: term.service as any, resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: root}),
    targetCwd: async targetId => cwdOf[targetId] ?? null, ensureExclude: async () => {}, seedConfig: () => {}, withLease: async (_path, _label, work) => work()});
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
  const fromLeader = (await service.create(create([{agent: 'codex', task: 'x'}]), {sessionId: 'leader', agent: 'claude', targetId: 'rwt_leader'})).team;
  expect(fromLeader.baseCommit).toBe(git(leaderTree, 'rev-parse', 'HEAD')); expect(fromLeader.baseBranch).toBe('leader-branch');
  expect(realpathSync(fromLeader.baseCheckout)).toBe(realpathSync(leaderTree));
  expect(fromLeader.members[0]!.worktreePath.startsWith(`${root}/worktrees/team-`)).toBe(true);
  expect(existsSync(join(fromLeader.members[0]!.worktreePath, 'plan.md'))).toBe(true);
  // An OPS leader driving this project from another repository: its checkout is not this repository's, so the primary is the base.
  const fromOps = (await service.create(parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId: 'team-request-ops', title: '팀', goal: '목표', members: [{agent: 'agy', task: 'y'}]}) as Extract<WorkroomTeamRequest, {op: 'create'}>,
    {sessionId: 'ops', agent: 'agy', targetId: 'other-project'})).team;
  expect(fromOps.baseCommit).toBe(git(root, 'rev-parse', 'HEAD')); expect(fromOps.baseCheckout).toBe(root);
  writeFileSync(join(leaderTree, 'plan.md'), 'edited plan\n');
  await expect(service.create(parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId: 'team-request-dirty', title: '팀', goal: '목표', members: [{agent: 'codex', task: 'z'}]}) as Extract<WorkroomTeamRequest, {op: 'create'}>,
    {sessionId: 'leader', agent: 'claude', targetId: 'rwt_leader'})).rejects.toMatchObject({code: 'WORKROOM_TEAM_SOURCE_DIRTY', details: {changedPaths: ['plan.md']}});
});

test('real Git: seeded .claude/ and .env copies do not keep a finished worktree, but an edited copy does', async () => {
  const root = repository(), term = terminal();
  // Untracked, not ignored, in the primary — as in a project that never added .claude/ to .gitignore.
  mkdirSync(join(root, '.claude', 'skills'), {recursive: true});
  writeFileSync(join(root, '.claude', 'settings.json'), '{"hooks":{}}\n'); writeFileSync(join(root, '.claude', 'skills', 'note.md'), 'skill\n'); writeFileSync(join(root, '.env'), 'TOKEN=local\n');
  const seed = (primary: string, worktree: string) => { cpSync(join(primary, '.claude'), join(worktree, '.claude'), {recursive: true}); cpSync(join(primary, '.env'), join(worktree, '.env')); };
  const host = createWorkroomTeamHost({gitPath: 'git', terminal: term.service as any, resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: root}), targetCwd: async () => null,
    ensureExclude: async () => {}, seedConfig: seed, withLease: async (_path, _label, work) => work()});
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'codex', task: 'a'}, {agent: 'claude', task: 'b'}]), {sessionId: 'leader', agent: 'claude'});
  const [m1, m2] = team.members;
  for (const member of [m1!, m2!]) { writeFileSync(join(member.worktreePath, `${member.id}.txt`), 'work\n'); git(member.worktreePath, 'add', `${member.id}.txt`); git(member.worktreePath, 'commit', '-qm', member.id); }
  expect(git(m1!.worktreePath, 'status', '--porcelain')).toBe('?? .claude/\n?? .env');
  writeFileSync(join(m2!.worktreePath, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash"]}}\n');
  git(root, 'merge', '--no-ff', '-qm', 'merge m1', m1!.branch); git(root, 'merge', '--no-ff', '-qm', 'merge m2', m2!.branch);
  const closed = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, {sessionId: 'leader', agent: 'claude'});
  expect(closed.outcomes).toEqual([
    {memberId: 'm1', session: 'closed', worktree: 'removed', branch: 'deleted'},
    {memberId: 'm2', session: 'closed', worktree: 'kept-dirty', branch: 'kept'},
  ]);
  expect(existsSync(m1!.worktreePath)).toBe(false);
  expect(readFileSync(join(m2!.worktreePath, '.claude', 'settings.json'), 'utf8')).toContain('Bash');
  expect(existsSync(join(m2!.worktreePath, '.env'))).toBe(true);
  expect(readFileSync(join(root, '.env'), 'utf8')).toBe('TOKEN=local\n'); expect(existsSync(join(root, '.claude', 'skills', 'note.md'))).toBe(true);
});

test('real Git: the leader\'s own checkout decides merged, and close deletes a branch merged there', async () => {
  const root = repository(), term = terminal();
  const leaderTree = join(root, 'worktrees', 'leader-branch');
  git(root, 'worktree', 'add', '-q', '-b', 'leader-branch', leaderTree);
  const host = createWorkroomTeamHost({gitPath: 'git', terminal: term.service as any, resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: root}),
    targetCwd: async targetId => targetId === 'rwt_leader' ? leaderTree : null, ensureExclude: async () => {}, seedConfig: () => {}, withLease: async (_path, _label, work) => work()});
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'codex', task: 'A'}]), {sessionId: 'leader', agent: 'claude', targetId: 'rwt_leader'});
  const m1 = team.members[0]!;
  writeFileSync(join(m1.worktreePath, 'api.txt'), 'api\n'); git(m1.worktreePath, 'add', '.'); git(m1.worktreePath, 'commit', '-qm', 'api');
  expect((await service.read({op: 'read', teamId: team.id})).team!.members[0]!.git).toMatchObject({commits: 1, merged: false});
  // The leader merges where it works, as the skill tells it to. The primary checkout never sees that merge.
  git(leaderTree, 'merge', '--no-ff', '-qm', 'merge m1', m1.branch);
  expect(git(root, 'rev-parse', 'HEAD')).not.toBe(git(leaderTree, 'rev-parse', 'HEAD'));
  expect(git(root, 'branch', '--merged', 'HEAD')).not.toContain(m1.branch);
  expect((await service.read({op: 'read', teamId: team.id})).team!.members[0]!.git!.merged).toBe(true);
  const closed = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, {sessionId: 'leader', agent: 'claude'});
  expect(closed.outcomes).toEqual([{memberId: 'm1', session: 'closed', worktree: 'removed', branch: 'deleted'}]);
  expect(git(root, 'branch', '--list', m1.branch)).toBe('');
  expect(existsSync(join(leaderTree, 'api.txt'))).toBe(true);
});

test('real Git: close never ends a Workroom the ledger did not record, and cleans its worktree up once that Workroom ends', async () => {
  const root = repository(), term = terminal();
  const host = createWorkroomTeamHost({gitPath: 'git', terminal: term.service as any, resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: root}), targetCwd: async () => null,
    ensureExclude: async () => {}, seedConfig: () => {}, withLease: async (_path, _label, work) => work()});
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'codex', task: 'A'}]), {sessionId: 'leader', agent: 'claude'});
  const m1 = team.members[0]!;
  // What a crash between the worktree and the start leaves: the row names neither the target nor the session, while a
  // detached member Workroom and its worktree are both still there.
  const stored = (service.store.get(team.id))!.members[0]!;
  stored.targetId = null; stored.sessionId = null; stored.state = 'starting';
  expect(term.running.size).toBe(1);
  // The ledger cannot tell that Workroom from one a person opened there, so it keeps it — and its folder and branch.
  const kept = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, {sessionId: 'leader', agent: 'claude'});
  expect(kept.outcomes).toEqual([{memberId: 'm1', session: 'kept', worktree: 'kept', branch: 'kept', error: expect.stringContaining(m1.sessionId!.slice(0, 8))}]);
  expect(kept.team.state).toBe('active');
  expect(term.running.size).toBe(1);
  expect(existsSync(m1.worktreePath)).toBe(true);
  await term.service.perform({operation: 'close', sessionId: m1.sessionId});
  const closed = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, {sessionId: 'leader', agent: 'claude'});
  expect(closed.outcomes).toEqual([{memberId: 'm1', session: 'not-running', worktree: 'removed', branch: 'deleted'}]);
  expect(term.running.size).toBe(0);
  expect(existsSync(m1.worktreePath)).toBe(false);
  expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(m1.worktreePath);
  expect(git(root, 'branch', '--list', m1.branch)).toBe('');
});

test('MCP tools map to one host action whose parser re-checks every field', () => {
  const create = agentsToZUseMcpActionForTool('agentstoz_use_create_team', {portId: 'p1', requestId: 'req-00000001', title: 't', goal: 'g', members: [{agent: 'agy', task: 'UI'}]}, 'controller-1');
  expect(create).toEqual({action: 'workroom-team', controllerPortId: 'controller-1', team: {op: 'create', portId: 'p1', requestId: 'req-00000001', title: 't', goal: 'g', members: [{agent: 'agy', task: 'UI'}]}});
  expect(parseAgentsToZUseActionRequest(create).team).toMatchObject({op: 'create', members: [{agent: 'agy', task: 'UI'}]});
  const wait = agentsToZUseMcpActionForTool('agentstoz_use_wait_team', {teamId: 'team_0123456789ab', timeoutMs: 30_000}, 'controller-1');
  expect(agentsToZUseMcpTimeoutMs(wait)).toBeGreaterThan(30_000);
  expect(agentsToZUseMcpTimeoutMs(create)).toBe(180_000);
  expect(() => parseAgentsToZUseActionRequest(agentsToZUseMcpActionForTool('agentstoz_use_close_team', {teamId: 'team_0123456789ab', force: true}, 'controller-1'))).toThrow('알 수 없는 필드');
  expect(() => parseAgentsToZUseActionRequest(agentsToZUseMcpActionForTool('agentstoz_use_report_team_task', {teamId: 'team_0123456789ab', memberId: 'm1', status: 'merged', summary: 'x'}, 'controller-1'))).toThrow("status는");
});

test('real Git: an open session may join only from this repository, a worker only from its own linked worktree, and its brief is one host submission', async () => {
  const root = repository(), other = repository();
  git(root, 'worktree', 'add', '-q', '-b', 'feature/old', join(root, 'worktrees/old'));
  writeFileSync(join(root, 'app.txt'), 'v2\n'); git(root, 'commit', '-qam', 'base moves on');
  const sessions = new Map([['session-old', {agent: 'codex', targetId: 't-old'}], ['session-main', {agent: 'claude', targetId: 't-main'}], ['session-other', {agent: 'codex', targetId: 't-other'}]]);
  const cwd: Record<string, string> = {'t-old': join(root, 'worktrees/old'), 't-main': root, 't-other': other};
  const submitted: any[] = [];
  const host = createWorkroomTeamHost({gitPath: 'git', resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: root}),
    terminal: {perform: async () => ({}), retiredSession: () => null, sessionActivity: () => ({lastOutputAt: 1}),
      runningSession: (id: string) => sessions.has(id) ? {id, ...sessions.get(id)!, state: 'running'} : null,
      wholeSubmissionSupported: () => true, submitHostInstruction: async (input: any) => (submitted.push(input), {state: input.id.endsWith('m2') ? 'unknown' : 'written'})} as any,
    targetCwd: async targetId => cwd[targetId] ?? null, ensureExclude: async () => {}, seedConfig: () => {}, withLease: async (_path, _label, work) => work()});
  const head = git(root, 'rev-parse', 'HEAD'), team = {primaryPath: root, baseCheckout: root, baseCommit: head};
  expect(await host.attachable('session-old', team)).toMatchObject({agent: 'codex', sameRepository: true, linked: true, baseCheckout: false, branch: 'feature/old', containsBase: false});
  expect(await host.attachable('session-main', team)).toMatchObject({sameRepository: true, linked: false, baseCheckout: true, branch: 'main', containsBase: true});
  expect(await host.attachable('session-other', team)).toMatchObject({sameRepository: false});
  expect(await host.attachable('session-none', team)).toBeNull();
  expect(await host.instruct({sessionId: 'session-old', prompt: '브리프', requestId: 'team-team_0123456789ab-m1'})).toBe('written');
  expect(await host.instruct({sessionId: 'session-main', prompt: '브리프', requestId: 'team-team_0123456789ab-m2'})).toBe('unknown');
  expect(submitted[0]).toEqual({id: 'team-team_0123456789ab-m1', sessionId: 'session-old', data: '브리프\r', receiptOwner: 'workroom-team', skipCorrections: true});
});

test('real Git: an open session is judged by its checkout root, not by the folder its Workroom was registered in', async () => {
  // A registered project (or a sibling project) may sit in a SUBDIRECTORY of the repository — the product supports a
  // fixed relative subpath. The worker rule asks 「is this its own linked worktree?」, so that must be read from the
  // checkout root; comparing the registered folder made a session inside the primary look like a linked worktree.
  const root = repository();
  mkdirSync(join(root, 'pkg'), {recursive: true}); writeFileSync(join(root, 'pkg/app.txt'), 'v1\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'pkg');
  git(root, 'worktree', 'add', '-q', '-b', 'feature/wt', join(root, 'worktrees/wt'));
  mkdirSync(join(root, 'worktrees/wt/pkg'), {recursive: true});
  const sessions = new Map([['session-sub', {agent: 'codex', targetId: 't-sub'}], ['session-wt-sub', {agent: 'codex', targetId: 't-wt-sub'}]]);
  const cwd: Record<string, string> = {'t-sub': join(root, 'pkg'), 't-wt-sub': join(root, 'worktrees/wt/pkg')};
  const host = createWorkroomTeamHost({gitPath: 'git', resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: root}),
    terminal: {perform: async () => ({}), retiredSession: () => null, sessionActivity: () => ({lastOutputAt: 1}),
      runningSession: (id: string) => sessions.has(id) ? {id, ...sessions.get(id)!, state: 'running'} : null,
      wholeSubmissionSupported: () => true, submitHostInstruction: async () => ({state: 'written'})} as any,
    targetCwd: async targetId => cwd[targetId] ?? null, ensureExclude: async () => {}, seedConfig: () => {}, withLease: async (_path, _label, work) => work()});
  const head = git(root, 'rev-parse', 'HEAD'), team = {primaryPath: root, baseCheckout: root, baseCommit: head};
  // A session registered at <primary>/pkg is the primary checkout: not linked, and the base checkout itself.
  expect(await host.attachable('session-sub', team)).toMatchObject({cwd: root, sameRepository: true, linked: false, baseCheckout: true, branch: 'main'});
  // A session registered at a subdirectory of a linked worktree is that worktree.
  expect(await host.attachable('session-wt-sub', team)).toMatchObject({cwd: join(root, 'worktrees/wt'), sameRepository: true, linked: true, baseCheckout: false, branch: 'feature/wt'});
  // The same rule from the service: such a session cannot take work, and nothing is written when it is refused.
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
  const request = (members: unknown[], requestId: string) => parseWorkroomTeamRequest({op: 'create', portId: 'port-1', requestId, title: 'T', goal: 'G', members}) as Extract<WorkroomTeamRequest, {op: 'create'}>;
  await expect(service.create(request([{agent: 'codex', task: '하위 폴더에서 작업', sessionId: 'session-sub'}], 'req-subdir-worker'), {sessionId: 'leader-x', agent: 'claude', targetId: 't-leader'}))
    .rejects.toMatchObject({code: 'WORKROOM_TEAM_ATTACH_REFUSED', message: expect.stringContaining('검토 담당으로만 합류')});
  // Joined as a worker from the linked worktree, the member works on that worktree's root, not on the registered subfolder.
  const {team: created} = await service.create(request([{agent: 'codex', task: '워크트리에서 작업', sessionId: 'session-wt-sub'}], 'req-wt-worker'), {sessionId: 'leader-x', agent: 'claude', targetId: 't-leader'});
  expect(created.members[0]).toMatchObject({attached: true, branch: 'feature/wt', worktreePath: join(root, 'worktrees/wt')});
});
