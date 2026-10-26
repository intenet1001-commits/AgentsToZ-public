/**
 * 팀 작전 production QA: failure and recovery as a user meets them, on the real API and MCP server, real Git and fake
 * CLIs in real Workroom PTYs (tests/fixtures/team-production-qa-stack.ts), plus the service with a file ledger for
 * the external surfaces this Mac must not open in a test.
 *
 * The 다시 시작 / reopen / wait-cursor / brief-wording tests began as reproduced defects
 * (/tmp/agentstoz-claude-team-production-qa.md) and now hold their fixes.
 */
import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {deriveAgentRuntimeWorktreeTargetId} from '../src/agentRuntimeTargetInventory';
import type {TeamExternalRuntime, TeamExternalStarted} from '../src/teamLaunchPlan';
import {parseWorkroomTeamRequest, WorkroomTeamService, WorkroomTeamStore, type WorkroomTeamHost, type WorkroomTeamRequest} from '../src/workroomTeam';
import {createWorkroomTeamHost, type WorkroomTeamHostDependencies} from '../src/workroomTeamHost';
import {runTeamMemberOperation} from '../src/workroomTeamMemberOperation';
import {teamsForSession, WORKROOM_TEAM_PANEL_PATH} from '../src/workroomTeamPanel';
import {git, startTeamQaStack, TEAM_QA_STACK_SUPPORTED, type TeamQaStack} from './fixtures/team-production-qa-stack';

// The real API + PTY scenarios run where the stack's /bin/sh fake CLIs can (macOS, Linux). On Windows they are skipped —
// reported as skipped, never as passed — and the service-level scenarios below still run.
const posixTest = TEAM_QA_STACK_SUPPORTED ? test : test.skip;
if (!TEAM_QA_STACK_SUPPORTED) console.warn('workroom-team-production-qa: real API/PTY scenarios skipped — POSIX-only fake CLIs (/bin/sh, stty).');

const stacks: TeamQaStack[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const stack = async (options?: Parameters<typeof startTeamQaStack>[0]) => { const created = await startTeamQaStack(options); stacks.push(created); return created; };
const createArgs = (requestId: string, members: unknown[]) => ({portId: 'shop-project', requestId, title: '결제 개선', goal: '결제 오류를 고친다', members});

posixTest('identical creates sent at once make one team, and each Claude Code or Hermes choice reaches its own CLI once', async () => {
  const s = await stack();
  const args = createArgs('team-qa-concurrent-0001', [
    {agent: 'claude', surface: 'internal', task: '화면 수정'},
    {agent: 'hermes', surface: 'internal', hermesVariant: 'default', task: '문서 정리'},
    {agent: 'hermes', surface: 'internal', hermesVariant: 'claude', task: '테스트 추가'},
    {agent: 'hermes', surface: 'internal', hermesVariant: 'codex', task: '서버 수정'},
  ]);
  const results = await Promise.all([s.call('create_team', args), s.call('create_team', args), s.call('create_team', args)]);
  expect(results.map(result => result.success)).toEqual([true, true, true]);
  expect(new Set(results.map(result => result.team.id)).size).toBe(1);
  expect(results.filter(result => result.replayed === false)).toHaveLength(1);
  const team = results.find(result => result.replayed === false)!.team;
  expect(team.members.map((member: any) => member.state)).toEqual(['working', 'working', 'working', 'working']);
  expect((await s.running()).map(session => session.id).sort()).toEqual(team.members.map((member: any) => member.sessionId).sort());
  expect(s.worktrees()).toHaveLength(5);
  for (const member of team.members) expect((await s.tail(member.sessionId, /^CWD:/)).line).toBe(`CWD:${realpathSync(member.worktreePath)}`);
  // Plain Hermes keeps its own configuration; the two variants become the model and provider that CLI receives.
  const models = [];
  for (const member of team.members) models.push((await s.tail(member.sessionId, /^MODEL:/)).line);
  expect(models).toEqual(['MODEL::', 'MODEL::', 'MODEL:claude-opus-5-5:anthropic', 'MODEL:gpt-6.1-sol:openai-codex']);
  // The same id with any other request is a conflict, and nothing more starts.
  expect(await s.call('create_team', {...args, goal: '다른 목표'})).toMatchObject({success: false, code: 'WORKROOM_TEAM_REQUEST_ID_CONFLICT'});
  expect(await s.running()).toHaveLength(4);
  expect(s.worktrees()).toHaveLength(5);
}, 120_000);

posixTest('a member whose CLI cannot start fails alone, is never retried, and its checkout is still cleaned up', async () => {
  // agy is not installed in this HOME, and the stack's PATH cannot reach a real one.
  const s = await stack({agents: ['codex', 'claude', 'hermes']});
  const args = createArgs('team-qa-partial-0001', [
    {agent: 'codex', surface: 'internal', task: '서버 수정'}, {agent: 'agy', surface: 'internal', task: '문서 정리'}, {agent: 'claude', surface: 'internal', task: '화면 수정'},
  ]);
  const created = await s.call('create_team', args);
  expect(created.success).toBe(true);
  const [m1, m2, m3] = created.team.members;
  expect([m1.state, m2.state, m3.state]).toEqual(['working', 'failed', 'working']);
  expect(m2.error).toContain('agy');
  expect(m2.sessionId).toBeNull();
  // Its checkout was made before the start failed; the others started in theirs.
  expect(existsSync(m2.worktreePath)).toBe(true);
  expect((await s.running()).map(session => session.id).sort()).toEqual([m1.sessionId, m3.sessionId].sort());
  const replay = await s.call('create_team', args);
  expect(replay).toMatchObject({success: true, replayed: true, team: {id: created.team.id}});
  expect(replay.team.members.map((member: any) => member.state)).toEqual(['working', 'failed', 'working']);
  expect(await s.running()).toHaveLength(2);
  const closed = await s.call('close_team', {teamId: created.team.id});
  expect(closed.outcomes).toEqual([
    {memberId: 'm1', session: 'closed', worktree: 'removed', branch: 'deleted'},
    {memberId: 'm2', session: 'not-running', worktree: 'removed', branch: 'deleted'},
    {memberId: 'm3', session: 'closed', worktree: 'removed', branch: 'deleted'},
  ]);
  expect(closed.team.state).toBe('closed');
  expect(s.worktrees()).toHaveLength(1);
  expect(s.teamBranches()).toEqual([]);
  expect(await s.running()).toEqual([]);
}, 120_000);

posixTest('after the app restarts, a replay starts nothing, a changed request conflicts, and members read unknown — never working', async () => {
  const s = await stack();
  const args = createArgs('team-qa-app-restart-0001', [{agent: 'claude', surface: 'internal', task: '화면 수정'}, {agent: 'codex', surface: 'internal', task: '서버 수정'}]);
  const created = await s.call('create_team', args);
  expect(created.team.members.map((member: any) => member.state)).toEqual(['working', 'working']);
  await s.call('send_workroom_instruction', {portId: 'shop-project', sessionId: created.team.members[1].sessionId, requestId: 'qa-restart-commit', instruction: 'COMMIT'});
  await s.tail(created.team.members[1].sessionId, /^COMMITTED$/);
  await s.restart();
  expect(await s.running()).toEqual([]);
  const read = await s.call('read_team', {teamId: created.team.id});
  expect(read.team.members.map((member: any) => [member.state, member.session])).toEqual([['unknown', 'missing'], ['unknown', 'missing']]);
  // The committed branch is still there to check; the ledger does not claim the member finished or is working.
  expect(read.team.members[1].git).toMatchObject({commits: 1, merged: false});
  const replay = await s.call('create_team', args);
  expect(replay).toMatchObject({success: true, replayed: true, team: {id: created.team.id}});
  expect(await s.call('create_team', {...args, goal: '다른 목표'})).toMatchObject({success: false, code: 'WORKROOM_TEAM_REQUEST_ID_CONFLICT'});
  expect(await s.running()).toEqual([]);
  expect(s.worktrees()).toHaveLength(3);
  // An instruction for a member of the earlier run is refused; nothing is typed into a session the team does not hold.
  expect(await s.call('team_member', {teamId: created.team.id, memberId: 'm1', operation: 'send', requestId: 'qa-member-send-0001', text: '진행 상황을 알려 주세요'}))
    .toMatchObject({success: false, performed: false});
  const closed = await s.call('close_team', {teamId: created.team.id});
  expect(closed.outcomes).toEqual([
    {memberId: 'm1', session: 'not-running', worktree: 'removed', branch: 'deleted'},
    {memberId: 'm2', session: 'not-running', worktree: 'removed', branch: 'kept-unmerged'},
  ]);
  expect(s.teamBranches()).toEqual([created.team.members[1].branch]);
}, 120_000);

posixTest('a member Workroom continued by 다시 시작 stays the member: the leader keeps waiting, and it is read, reports and is closed where it runs now', async () => {
  const s = await stack();
  const created = await s.call('create_team', createArgs('team-qa-member-restart-0001', [{agent: 'codex', surface: 'internal', task: '서버 수정'}]));
  const m1 = created.team.members[0];
  await s.tail(m1.sessionId, /^SESSION:/);
  const before = await s.call('team_member', {teamId: created.team.id, memberId: 'm1', operation: 'read'});
  // Taken as a value first: toMatchObject with a matcher would replace the field it matched.
  const beforeCursor = before.cursor as string;
  expect(beforeCursor).toMatch(new RegExp(`^${m1.sessionId}:[1-9][0-9]*$`));
  expect(before).toMatchObject({agentVerified: true, session: 'running'});
  // The Workroom's own 「다시 시작」: the same target and AI, a new session that replaces the old one.
  const restarted = await s.terminal({operation: 'start', requestId: 'qa-member-restart-1', targetId: m1.targetId, agent: 'codex', cols: 100, rows: 28, resumeFrom: m1.sessionId});
  expect(restarted.status).toBe(200);
  const continued = restarted.body.session.id as string;
  expect(continued).not.toBe(m1.sessionId);
  expect((await s.tail(continued, /^CWD:/)).line).toBe(`CWD:${realpathSync(m1.worktreePath)}`);
  // Still working, now in its new session: it does not settle the leader's wait as 「끝남 · 보고 없음」.
  const read = await s.call('read_team', {teamId: created.team.id});
  expect(read.team.members[0]).toMatchObject({state: 'working', session: 'running', sessionId: continued});
  expect(read.team.settled).toBe(0);
  expect(await s.call('wait_team', {teamId: created.team.id, timeoutMs: 1_000, afterSettled: 0})).toMatchObject({timedOut: true, team: {settled: 0}});
  // The leader's cursor from before 다시 시작 reads the continued session from its start: its output numbers began again.
  const output = await s.call('team_member', {teamId: created.team.id, memberId: 'm1', operation: 'read', cursor: beforeCursor});
  expect(output).toMatchObject({agentVerified: true, session: 'running'});
  expect(output.text).toContain(`SESSION:${continued}`);
  expect(output.cursor).toMatch(new RegExp(`^${continued}:[0-9]+$`));
  await s.call('send_workroom_instruction', {portId: 'shop-project', sessionId: continued, requestId: 'qa-continued-commit', instruction: 'COMMIT'});
  await s.tail(continued, /^COMMITTED$/);
  await s.call('send_workroom_instruction', {portId: 'shop-project', sessionId: continued, requestId: 'qa-continued-report', instruction: `REPORT ${created.team.id} m1`});
  await s.tail(continued, /^REPORTED:m1$/);
  const closed = await s.call('close_team', {teamId: created.team.id});
  expect(closed.outcomes).toEqual([{memberId: 'm1', session: 'closed', worktree: 'removed', branch: 'kept-unmerged'}]);
  expect(closed.team.state).toBe('closed');
  expect(await s.running()).toEqual([]);
  expect(existsSync(m1.worktreePath)).toBe(false);
}, 120_000);

posixTest('after an app restart, a Workroom reopened in a member checkout is never taken as the member, and close keeps its folder until it ends', async () => {
  const s = await stack();
  const created = await s.call('create_team', createArgs('team-qa-reopen-0001', [{agent: 'claude', surface: 'internal', task: '화면 수정'}]));
  const m1 = created.team.members[0];
  await s.restart();
  // The person reopens the member's Workroom: a new session on the same worktree target, with no lineage to the old one.
  const reopened = await s.terminal({operation: 'start', requestId: 'qa-reopen-1', targetId: m1.targetId, agent: 'claude', cols: 100, rows: 28});
  expect(reopened.status).toBe(200);
  const live = reopened.body.session.id as string;
  expect((await s.tail(live, /^CWD:/)).line).toBe(`CWD:${realpathSync(m1.worktreePath)}`);
  expect((await s.call('read_team', {teamId: created.team.id})).team.members[0]).toMatchObject({state: 'unknown', session: 'missing', sessionId: m1.sessionId});
  // Reading the member reads its own session, which this run does not have — never the reopened one, never as verified.
  expect(await s.call('team_member', {teamId: created.team.id, memberId: 'm1', operation: 'read'})).toMatchObject({agentVerified: false, session: 'missing', text: ''});
  const kept = await s.call('close_team', {teamId: created.team.id});
  expect(kept.outcomes).toEqual([{memberId: 'm1', session: 'kept', worktree: 'kept', branch: 'kept', error: expect.stringContaining(live.slice(0, 8))}]);
  expect(kept.team.state).toBe('active');
  expect((await s.running()).map(session => session.id)).toEqual([live]);
  expect(existsSync(m1.worktreePath)).toBe(true);
  expect(s.teamBranches()).toEqual([m1.branch]);
  // Once that Workroom is closed, the same close finishes.
  expect((await s.terminal({operation: 'close', requestId: 'qa-reopen-close', sessionId: live})).status).toBe(200);
  const closed = await s.call('close_team', {teamId: created.team.id});
  expect(closed.outcomes).toEqual([{memberId: 'm1', session: 'not-running', worktree: 'removed', branch: 'deleted'}]);
  expect(closed.team.state).toBe('closed');
  expect(s.teamBranches()).toEqual([]);
}, 120_000);

posixTest('a second Workroom opened beside a working member is never taken as it: close ends the member\'s own session and keeps the checkout for the other', async () => {
  const s = await stack();
  const created = await s.call('create_team', createArgs('team-qa-beside-0001', [{agent: 'codex', surface: 'internal', task: '서버 수정'}]));
  const m1 = created.team.members[0];
  // 「새 작업」 on the same target: a plain start, no resumeFrom — the same run, the same checkout, not a continuation.
  const beside = (await s.terminal({operation: 'start', requestId: 'qa-beside-1', targetId: m1.targetId, agent: 'codex', cols: 100, rows: 28})).body.session.id as string;
  await s.tail(beside, /^CWD:/);
  expect((await s.call('read_team', {teamId: created.team.id})).team.members[0]).toMatchObject({state: 'working', sessionId: m1.sessionId});
  const output = await s.call('team_member', {teamId: created.team.id, memberId: 'm1', operation: 'read'});
  expect(output).toMatchObject({agentVerified: true, session: 'running'});
  expect(output.text).toContain(`SESSION:${m1.sessionId}`);
  const kept = await s.call('close_team', {teamId: created.team.id});
  expect(kept.outcomes).toEqual([{memberId: 'm1', session: 'closed', worktree: 'kept', branch: 'kept', error: expect.stringContaining(beside.slice(0, 8))}]);
  expect(kept.team.state).toBe('active');
  expect((await s.running()).map(session => session.id)).toEqual([beside]);
  expect(existsSync(m1.worktreePath)).toBe(true);
}, 120_000);

posixTest('right after 다시 시작, before anything reads the team, the continued member can neither close the team nor report as another member', async () => {
  const s = await stack();
  const created = await s.call('create_team', createArgs('team-qa-continued-guard-0001', [{agent: 'codex', surface: 'internal', task: '서버 수정'}, {agent: 'claude', surface: 'internal', task: '화면 수정'}]));
  const [m1, m2] = created.team.members;
  const restart = async (member: any, requestId: string) => {
    const id = (await s.terminal({operation: 'start', requestId, targetId: member.targetId, agent: member.agent, cols: 100, rows: 28, resumeFrom: member.sessionId})).body.session.id as string;
    await s.tail(id, /^CWD:/);
    return {sessionId: id, targetId: member.targetId as string};
  };
  // Each member's first team call comes from its new session, before the ledger was read again: it still names the old one.
  const m1Now = await restart(m1, 'qa-guard-restart-1');
  expect(await s.call('close_team', {teamId: created.team.id}, m1Now)).toMatchObject({success: false, code: 'WORKROOM_TEAM_CLOSE_DENIED'});
  const m2Now = await restart(m2, 'qa-guard-restart-2');
  expect(await s.call('report_team_task', {teamId: created.team.id, memberId: 'm1', status: 'done', summary: '대신 보고'}, m2Now)).toMatchObject({success: false, code: 'WORKROOM_TEAM_REPORT_DENIED'});
  expect((await s.running()).map(session => session.id).sort()).toEqual([m1Now.sessionId, m2Now.sessionId].sort());
  expect(s.worktrees()).toHaveLength(3);
  // Its own report is its own.
  expect(await s.call('report_team_task', {teamId: created.team.id, memberId: 'm2', status: 'done', summary: '화면 수정 끝'}, m2Now)).toMatchObject({success: true});
  const read = await s.call('read_team', {teamId: created.team.id});
  expect(read.team.members.map((member: any) => [member.state, member.sessionId])).toEqual([['working', m1Now.sessionId], ['reported', m2Now.sessionId]]);
}, 120_000);

posixTest('a member whose start failed owns no Workroom: one a person opens in its checkout keeps running there, with its folder and branch', async () => {
  // agy is not installed in this HOME, so that member fails after its checkout was made.
  const s = await stack({agents: ['codex', 'claude']});
  const created = await s.call('create_team', createArgs('team-qa-failed-owner-0001', [{agent: 'agy', surface: 'internal', task: '문서 정리'}, {agent: 'codex', surface: 'internal', task: '서버 수정'}]));
  const [m1, m2] = created.team.members;
  expect([m1.state, m1.sessionId, existsSync(m1.worktreePath)]).toEqual(['failed', null, true]);
  // The person opens a Workroom of their own in that checkout; the team never recorded it.
  const opened = (await s.terminal({operation: 'start', requestId: 'qa-failed-owner-1', targetId: m1.targetId, agent: 'codex', cols: 100, rows: 28})).body.session.id as string;
  expect((await s.tail(opened, /^CWD:/)).line).toBe(`CWD:${realpathSync(m1.worktreePath)}`);
  const closed = await s.call('close_team', {teamId: created.team.id});
  expect(closed.outcomes).toEqual([
    {memberId: 'm1', session: 'kept', worktree: 'kept', branch: 'kept', error: expect.stringContaining(opened.slice(0, 8))},
    {memberId: 'm2', session: 'closed', worktree: 'removed', branch: 'deleted'},
  ]);
  expect(closed.team.state).toBe('active');
  expect((await s.running()).map(session => session.id)).toEqual([opened]);
  expect(existsSync(m1.worktreePath)).toBe(true);
  expect(s.teamBranches()).toEqual([m1.branch]);
  // Still the person's, still at work in that folder.
  await s.call('send_workroom_instruction', {portId: 'shop-project', sessionId: opened, requestId: 'qa-failed-owner-ping', instruction: 'PING'});
  await s.tail(opened, /^GOT:PING$/);
}, 120_000);

posixTest('a borrowed member continued by 다시 시작 is followed there, still cannot close the team, and keeps its session, checkout and branch on close', async () => {
  const s = await stack();
  const leaderStart = await s.terminal({operation: 'start', requestId: 'qa-leader-3', targetId: 'shop-project', agent: 'claude', cols: 100, rows: 28});
  const leader = {sessionId: leaderStart.body.session.id as string, targetId: 'shop-project'};
  const borrowedPath = join(s.project, 'worktrees', 'borrowed-restart');
  git(s.project, 'worktree', 'add', '-q', '-b', 'feature/borrowed-restart', borrowedPath);
  const borrowedTarget = deriveAgentRuntimeWorktreeTargetId('shop-project', realpathSync(borrowedPath));
  const borrowed = (await s.terminal({operation: 'start', requestId: 'qa-borrowed-restart-1', targetId: borrowedTarget, agent: 'codex', cols: 100, rows: 28})).body.session.id as string;
  await s.tail(borrowed, /READY:codex$/);
  const created = await s.call('create_team', createArgs('team-qa-borrowed-restart-0001', [{agent: 'codex', sessionId: borrowed, task: '결제 API 고치기'}]), leader);
  expect(created.team.members[0]).toMatchObject({attached: true, sessionId: borrowed, state: 'working'});
  const continued = (await s.terminal({operation: 'start', requestId: 'qa-borrowed-restart-2', targetId: borrowedTarget, agent: 'codex', cols: 100, rows: 28, resumeFrom: borrowed})).body.session.id as string;
  await s.tail(continued, /^CWD:/);
  expect(await s.call('close_team', {teamId: created.team.id}, {sessionId: continued, targetId: borrowedTarget})).toMatchObject({success: false, code: 'WORKROOM_TEAM_CLOSE_DENIED'});
  expect((await s.call('read_team', {teamId: created.team.id})).team.members[0]).toMatchObject({attached: true, sessionId: continued, state: 'working', session: 'running'});
  const closed = await s.call('close_team', {teamId: created.team.id}, leader);
  expect(closed.outcomes).toEqual([{memberId: 'm1', session: 'kept', worktree: 'kept', branch: 'kept'}]);
  expect(closed.team.state).toBe('closed');
  expect((await s.running()).map(session => session.id).sort()).toEqual([leader.sessionId, continued].sort());
  expect(existsSync(borrowedPath)).toBe(true);
  expect(git(s.project, 'branch', '--list', 'feature/borrowed-restart')).toContain('feature/borrowed-restart');
}, 120_000);

posixTest('the leader Workroom continued by 다시 시작 keeps leading there: it reads and instructs its members, another Workroom on its target cannot, and close keeps every window it did not start', async () => {
  const s = await stack();
  const leaderStart = await s.terminal({operation: 'start', requestId: 'qa-leader-restart-1', targetId: 'shop-project', agent: 'claude', cols: 100, rows: 28});
  const leader = {sessionId: leaderStart.body.session.id as string, targetId: 'shop-project'};
  await s.tail(leader.sessionId, /READY:claude$/);
  const borrowedPath = join(s.project, 'worktrees', 'borrowed-leader-restart');
  git(s.project, 'worktree', 'add', '-q', '-b', 'feature/borrowed-leader-restart', borrowedPath);
  const borrowedTarget = deriveAgentRuntimeWorktreeTargetId('shop-project', realpathSync(borrowedPath));
  const borrowed = (await s.terminal({operation: 'start', requestId: 'qa-leader-restart-borrowed', targetId: borrowedTarget, agent: 'codex', cols: 100, rows: 28})).body.session.id as string;
  await s.tail(borrowed, /READY:codex$/);
  const created = await s.call('create_team', createArgs('team-qa-leader-restart-0001', [{agent: 'codex', surface: 'internal', task: '서버 수정'}, {agent: 'codex', sessionId: borrowed, task: '결제 API 검토'}]), leader);
  // The target the actual calling session runs in is recorded with it: the only lineage the leader is followed along.
  expect(created.team.leader).toEqual({sessionId: leader.sessionId, agent: 'claude', targetId: 'shop-project'});
  const teamId = created.team.id as string, m1 = created.team.members[0];
  await s.tail(m1.sessionId, /^SESSION:/);
  // The leader's own 「다시 시작」: the same target and AI, a new session that replaces the old one.
  const restarted = await s.terminal({operation: 'start', requestId: 'qa-leader-restart-2', targetId: 'shop-project', agent: 'claude', cols: 100, rows: 28, resumeFrom: leader.sessionId});
  expect(restarted.status).toBe(200);
  const continued = {sessionId: restarted.body.session.id as string, targetId: 'shop-project'};
  await s.tail(continued.sessionId, /^CWD:/);
  // 「새 작업」 on the same target: a plain start, no resumeFrom — the same checkout, never the leader.
  const other = {sessionId: (await s.terminal({operation: 'start', requestId: 'qa-leader-restart-3', targetId: 'shop-project', agent: 'claude', cols: 100, rows: 28})).body.session.id as string, targetId: 'shop-project'};
  await s.tail(other.sessionId, /^CWD:/);
  // The person's first action can be copying a member's brief, before any poll or MCP read updates the ledger.
  const copyBrief = (sessionId: string) => fetch(`${s.baseUrl}${WORKROOM_TEAM_PANEL_PATH}`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: 'http://tauri.localhost'},
    body: JSON.stringify({operation: 'copy-brief', sessionId, teamId, memberId: 'm1'})});
  expect((await copyBrief(other.sessionId)).status).toBe(403);
  expect((await copyBrief(leader.sessionId)).status).toBe(403);
  const brief = await copyBrief(continued.sessionId);
  expect(brief.status).toBe(200);
  expect((await brief.json() as any).brief).toContain('서버 수정');
  // Before anything has read the team: the other Workroom is refused, the continued leader reads and instructs m1.
  const denied = {success: false, code: 'WORKROOM_TEAM_MEMBER_OPERATION_DENIED'};
  expect(await s.call('team_member', {teamId, memberId: 'm1', operation: 'read'}, other)).toMatchObject(denied);
  const output = await s.call('team_member', {teamId, memberId: 'm1', operation: 'read'}, continued);
  expect(output).toMatchObject({agentVerified: true, session: 'running'});
  expect(output.text).toContain(`SESSION:${m1.sessionId}`);
  expect(await s.call('team_member', {teamId, memberId: 'm1', operation: 'send', requestId: 'qa-leader-restart-send', text: 'LEADER-CHECK'}, continued))
    .toMatchObject({success: true, performed: true, delivery: 'verified'});
  await s.tail(m1.sessionId, /^GOT:LEADER-CHECK$/);
  expect(await s.call('team_member', {teamId, memberId: 'm1', operation: 'send', requestId: 'qa-leader-restart-other', text: 'OTHER'}, other)).toMatchObject(denied);
  // The team view and the Workroom strips name the session the leader works in now (the reads above moved the ledger;
  // the strip itself matches the recorded leader — workroomTeamPanel).
  expect((await s.call('read_team', {teamId})).team.leader).toEqual({sessionId: continued.sessionId, agent: 'claude', targetId: 'shop-project'});
  const strip = async (sessionId: string) => (await (await fetch(`${s.baseUrl}${WORKROOM_TEAM_PANEL_PATH}`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'http://tauri.localhost'},
    body: JSON.stringify({sessionId, git: false})})).json() as any).teams as any[];
  expect((await strip(borrowed))[0]).toMatchObject({id: teamId, role: 'member', leader: {sessionId: continued.sessionId, agent: 'claude'}});
  expect((await strip(continued.sessionId))[0]).toMatchObject({id: teamId, role: 'leader', leader: {sessionId: continued.sessionId}});
  expect(await strip(other.sessionId)).toEqual([]);
  // Close by the continued leader ends only the Workroom the team started: the leader, the other and the borrowed keep running.
  const closed = await s.call('close_team', {teamId}, continued);
  expect(closed.outcomes).toEqual([{memberId: 'm1', session: 'closed', worktree: 'removed', branch: 'deleted'}, {memberId: 'm2', session: 'kept', worktree: 'kept', branch: 'kept'}]);
  expect(closed.team.state).toBe('closed');
  expect((await s.running()).map(session => session.id).sort()).toEqual([continued.sessionId, other.sessionId, borrowed].sort());
  expect(existsSync(borrowedPath)).toBe(true);
}, 120_000);

posixTest('an open Workroom borrowed as a member keeps its own settings, gets its brief once, and is never closed or removed', async () => {
  const s = await stack();
  const leaderStart = await s.terminal({operation: 'start', requestId: 'qa-leader-1', targetId: 'shop-project', agent: 'claude', cols: 100, rows: 28});
  const leader = {sessionId: leaderStart.body.session.id as string, targetId: 'shop-project'};
  // The person's own linked worktree on its own branch, with a Codex Workroom already running there.
  const borrowedPath = join(s.project, 'worktrees', 'borrowed');
  git(s.project, 'worktree', 'add', '-q', '-b', 'feature/borrowed', borrowedPath);
  const borrowedTarget = deriveAgentRuntimeWorktreeTargetId('shop-project', realpathSync(borrowedPath));
  const borrowedStart = await s.terminal({operation: 'start', requestId: 'qa-borrowed-1', targetId: borrowedTarget, agent: 'codex', cols: 100, rows: 28});
  expect(borrowedStart.status).toBe(200);
  const borrowed = borrowedStart.body.session.id as string;
  await s.tail(borrowed, /READY:codex$/);
  const args = createArgs('team-qa-borrowed-0001', [{agent: 'codex', sessionId: borrowed, task: '결제 API 고치기'}, {agent: 'claude', surface: 'internal', task: '화면 수정'}]);
  // A borrowed session keeps its model, effort, account and permissions: asking for any of them is refused, and nothing is typed.
  for (const extra of [{model: 'gpt-5'}, {effort: 'high'}, {bypassPermissions: true}, {surface: 'iterm'}]) {
    const refused = await s.call('create_team', {...args, requestId: `team-qa-borrowed-x-${Object.keys(extra)[0]}`, members: [{agent: 'codex', sessionId: borrowed, task: '결제 API 고치기', ...extra}]}, leader);
    expect(refused.success).not.toBe(true);
  }
  // Without the leader's own Workroom the host cannot tell the leader from a member, so a join is refused.
  expect(await s.call('create_team', {...args, requestId: 'team-qa-borrowed-noleader'})).toMatchObject({success: false, code: 'WORKROOM_TEAM_ATTACH_REFUSED'});
  // The leader's own session can never be its member.
  expect(await s.call('create_team', {...args, requestId: 'team-qa-borrowed-self', members: [{agent: 'claude', sessionId: leader.sessionId, task: '자기 자신'}]}, leader))
    .toMatchObject({success: false, code: 'WORKROOM_TEAM_ATTACH_REFUSED'});
  const created = await s.call('create_team', args, leader);
  expect(created.success).toBe(true);
  expect(created.team.members[0]).toMatchObject({attached: true, sessionId: borrowed, branch: 'feature/borrowed', state: 'working', delivery: 'verified'});
  await s.tail(borrowed, /^TYPED-BRIEF$/);
  const replay = await s.call('create_team', args, leader);
  expect(replay).toMatchObject({replayed: true, team: {id: created.team.id}});
  const transcript = (await s.tail(borrowed, /^TYPED-BRIEF$/)).text;
  expect(transcript.split('\n').filter(line => line === 'TYPED-BRIEF')).toHaveLength(1);
  // While it is on this team it cannot join another one.
  expect(await s.call('create_team', {...args, requestId: 'team-qa-borrowed-0002', title: '다른 팀'}, leader)).toMatchObject({success: false, code: 'WORKROOM_TEAM_ATTACH_REFUSED'});
  // A member cannot close the team; the leader does, and the borrowed session, checkout and branch are left as they were.
  expect(await s.call('close_team', {teamId: created.team.id}, {sessionId: borrowed, targetId: borrowedTarget})).toMatchObject({success: false, code: 'WORKROOM_TEAM_CLOSE_DENIED'});
  const closed = await s.call('close_team', {teamId: created.team.id}, leader);
  expect(closed.outcomes).toEqual([
    {memberId: 'm1', session: 'kept', worktree: 'kept', branch: 'kept'},
    {memberId: 'm2', session: 'closed', worktree: 'removed', branch: 'deleted'},
  ]);
  expect((await s.running()).map(session => session.id).sort()).toEqual([leader.sessionId, borrowed].sort());
  expect(existsSync(borrowedPath)).toBe(true);
  expect(git(s.project, 'branch', '--list', 'feature/borrowed')).toContain('feature/borrowed');
}, 120_000);

posixTest('a borrowed Workroom that cannot take a multi-line brief is marked failed, gets nothing typed, and is still kept on close', async () => {
  const s = await stack({notPasteReady: ['agy']});
  const leaderStart = await s.terminal({operation: 'start', requestId: 'qa-leader-2', targetId: 'shop-project', agent: 'claude', cols: 100, rows: 28});
  const leader = {sessionId: leaderStart.body.session.id as string, targetId: 'shop-project'};
  const borrowedPath = join(s.project, 'worktrees', 'borrowed-agy');
  git(s.project, 'worktree', 'add', '-q', '-b', 'feature/agy', borrowedPath);
  const borrowedTarget = deriveAgentRuntimeWorktreeTargetId('shop-project', realpathSync(borrowedPath));
  const borrowed = (await s.terminal({operation: 'start', requestId: 'qa-borrowed-agy', targetId: borrowedTarget, agent: 'agy', cols: 100, rows: 28})).body.session.id as string;
  await s.tail(borrowed, /READY:agy$/);
  const args = createArgs('team-qa-borrowed-agy-0001', [{agent: 'agy', sessionId: borrowed, task: '문서 정리'}]);
  const created = await s.call('create_team', args, leader);
  expect(created.success).toBe(true);
  expect(created.team.members[0]).toMatchObject({attached: true, sessionId: borrowed, state: 'failed', session: 'running'});
  // Its reason is said, without the Workroom composer's 「작성 내용은 유지했으니」: a team brief has no kept draft.
  expect(created.team.members[0].error).toContain('여러 줄');
  expect(created.team.members[0].error).toContain('다시 입력하지 않습니다');
  expect(created.team.members[0].error).not.toContain('작성 내용');
  // A replay does not try again; only an explicit instruction would.
  expect(await s.call('create_team', args, leader)).toMatchObject({replayed: true, team: {members: [{state: 'failed'}]}});
  const transcript = (await s.call('wait_workroom_session', {portId: 'shop-project', sessionId: borrowed, idleMs: 1_000, timeoutMs: 4_000})).text as string;
  expect(transcript).not.toMatch(/GOT:|TYPED-BRIEF/);
  const closed = await s.call('close_team', {teamId: created.team.id}, leader);
  expect(closed.outcomes).toEqual([{memberId: 'm1', session: 'kept', worktree: 'kept', branch: 'kept'}]);
  expect((await s.running()).map(session => session.id).sort()).toEqual([leader.sessionId, borrowed].sort());
  expect(existsSync(borrowedPath)).toBe(true);
}, 120_000);

posixTest('selections the host must refuse launch nothing, even when sent to the host without the MCP server\'s own checks', async () => {
  const s = await stack();
  // The exact action the MCP server sends for a valid team, captured without reaching any host.
  let captured: {url: string; init: RequestInit} | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => { captured = {url: String(url), init}; throw new Error('captured'); }) as unknown as typeof fetch;
  try {
    await handleAgentsToZUseMcpRequest({id: 1, method: 'tools/call', params: {name: 'agentstoz_use_create_team', arguments: createArgs('team-qa-capture-0001', [{agent: 'claude', surface: 'internal', task: 'a'}])}},
      {...s.env, AGENTSTOZ_USE_ENDPOINT: `${s.baseUrl}/api/agentstoz-use/action`});
  } finally { globalThis.fetch = realFetch; }
  const body = JSON.parse(String(captured!.init.body));
  expect(body.team.op).toBe('create');
  const refused: Array<[string, unknown[]]> = [
    ['Hermes provider without a model', [{agent: 'hermes', provider: 'anthropic', task: 'a'}]],
    ['a model on iTerm', [{agent: 'hermes', surface: 'iterm', model: 'claude-sonnet-4-5', provider: 'anthropic', task: 'a'}]],
    ['a provider for Codex', [{agent: 'codex', model: 'gpt-5', provider: 'openai', task: 'a'}]],
    ['a model inside launch options', [{agent: 'claude', launchOptions: {model: 'opus'}, task: 'a'}]],
    ['a model for a desktop app', [{agent: 'claude', surface: 'app', model: 'opus', task: 'a'}]],
    ['an account on Terminal', [{agent: 'claude', surface: 'terminal', accountId: 'acct_1', task: 'a'}]],
    ['permission bypass for Hermes on Terminal', [{agent: 'hermes', surface: 'terminal', bypassPermissions: true, task: 'a'}]],
    ['an effort for agy', [{agent: 'agy', effort: 'high', task: 'a'}]],
    ['an unknown member field', [{agent: 'claude', task: 'a', color: 'blue'}]],
    ['seven members', Array.from({length: 7}, (_, index) => ({agent: 'claude', task: `t${index}`}))],
  ];
  for (const [label, members] of refused) {
    const team = {...body.team, requestId: `team-qa-refused-${refused.findIndex(([name]) => name === label)}-x`, members};
    // Guard: never send anything this Mac's own parser would accept — an accepted external surface opens a real window.
    expect(() => parseWorkroomTeamRequest(team), label).toThrow();
    const response = await fetch(captured!.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, s.baseUrl), {...captured!.init, body: JSON.stringify({...body, team})});
    const answer = await response.json() as any;
    expect(answer.success, label).not.toBe(true);
    expect(answer.code, label).toBe('WORKROOM_TEAM_REQUEST_INVALID');
  }
  // An omitted choice is asked about, not guessed.
  expect(await s.call('create_team', createArgs('team-qa-question-0001', [{agent: 'claude', task: 'a'}]))).toMatchObject({performed: false, selectionRequired: true});
  expect((await s.call('read_team', {portId: 'shop-project'})).teams).toEqual([]);
  expect(s.worktrees()).toHaveLength(1);
  expect(s.teamBranches()).toEqual([]);
  expect(await s.running()).toEqual([]);
}, 120_000);

/** Service-level: a surface the host cannot read, through two runs of the app on one ledger file. */
function externalHost(external: TeamExternalRuntime): WorkroomTeamHost {
  return {
    resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: '/repo'}),
    primary: async () => ({path: '/repo', base: '/repo', head: 'a'.repeat(40), branch: 'main', trackedChanges: [], untracked: 0}),
    attachable: async () => null, addWorktree: async () => {}, worktreeTargetId: (_project, path) => `rwt_${path.split('/').pop()}`,
    start: async () => { throw new Error('no Workroom may start for an external member'); },
    session: () => ({state: 'missing', lastOutputAt: null}), sessionForTarget: async () => null, instruct: async () => 'unknown',
    close: async () => { throw new Error('no Workroom to close'); }, removeWorktree: async () => 'removed',
    branchGit: async () => ({commits: 1, files: 1, insertions: 1, deletions: 0, merged: false}), deleteMergedBranch: async () => 'unmerged',
    external,
  };
}

test('a hand-confirmed external member keeps exactly what the leader confirmed across an app restart, and an unconfirmed one reads unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-qa-ledger-')); dirs.push(dir);
  const file = join(dir, 'workroom-teams.v1.json');
  const leader = {sessionId: 'leader-session-1', agent: 'claude' as const};
  const launched: string[] = [];
  const opened = (handle: string): TeamExternalStarted => ({ref: {kind: 'external', surface: 'app', runtime: 'codex-app', handle, owned: false}, state: 'awaiting-manual-join', delivery: 'not-sent'});
  const first = new WorkroomTeamService(externalHost({start: async input => { launched.push(input.memberId); return opened(`conv_${input.memberId}`); }}), new WorkroomTeamStore(file));
  const request = parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId: 'team-qa-manual-0001', title: '팀', goal: '목표', members: [
    {agent: 'codex', surface: 'app', launchOptions: {appMode: 'new'}, task: '앱에서 작업'},
    {agent: 'claude', surface: 'app', task: '앱에서 검토'},
  ]}) as Extract<WorkroomTeamRequest, {op: 'create'}>;
  const {team} = await first.create(request, leader);
  expect(team.members.map(member => [member.state, member.delivery])).toEqual([['awaiting-manual-join', 'not-sent'], ['awaiting-manual-join', 'not-sent']]);
  // Opening the app is not work: no wait settles on it, and its report cannot be taken as the member's own.
  expect((await first.wait({op: 'wait', teamId: team.id, timeoutMs: 1_000, until: 'any'})).timedOut).toBe(true);
  await expect(first.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: 'x'}, leader)).rejects.toMatchObject({code: 'WORKROOM_TEAM_REPORT_UNVERIFIED'});
  await first.confirm({op: 'confirm', teamId: team.id, memberId: 'm1', confirm: 'delivered'}, leader);

  // The app quits and opens again: the same ledger file, a runtime that cannot read either app.
  const second = new WorkroomTeamService(externalHost({start: async input => { launched.push(input.memberId); return opened('never'); }}), new WorkroomTeamStore(file));
  const reopened = (await second.read({op: 'read', teamId: team.id})).team!;
  expect(reopened.members.map(member => [member.state, member.delivery, member.manual?.confirmed ?? null]))
    .toEqual([['working', 'manual', 'delivered'], ['unknown', 'not-sent', null]]);
  // A replay starts nothing in either run.
  expect((await second.create(request, leader)).replayed).toBe(true);
  expect(launched).toEqual(['m1', 'm2']);
  // Only the leader transcribes, and the transcription is never presented as the member's own report.
  await expect(second.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: '앱 화면에서 읽음', manual: true}, {sessionId: 'someone-else-1', agent: 'codex'}))
    .rejects.toMatchObject({code: 'WORKROOM_TEAM_REPORT_DENIED'});
  await second.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: '앱 화면에서 읽음', manual: true}, leader);
  const third = new WorkroomTeamService(externalHost({start: async () => opened('never')}), new WorkroomTeamStore(file));
  const last = (await third.read({op: 'read', teamId: team.id})).team!;
  expect(last.members[0]).toMatchObject({state: 'reported', report: {status: 'done', provenance: 'manual'}, delivery: 'manual'});
  // Close never ends a window this team did not start, and keeps both checkouts.
  const closed = await third.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, leader);
  expect(closed.outcomes.map(outcome => [outcome.session, outcome.worktree])).toEqual([['kept', 'kept'], ['kept', 'kept']]);
  expect(closed.team.state).toBe('active');
});

test('a wait cursor taken while an external read was slow still wakes for the next report', async () => {
  // Orca answers at once, except the one read marked slow, which takes 600 ms — longer than the leader's first wait.
  let slowNext = false;
  const host: WorkroomTeamHost = {
    ...externalHost({
      start: async () => ({ref: {kind: 'external', surface: 'orca-worktree', runtime: 'orca', handle: 'term_1', owned: true, evidence: {send: true, read: true}}, state: 'working', delivery: 'verified'}),
      observe: async () => { if (!slowNext) return {state: 'working'}; slowNext = false; return new Promise(resolve => setTimeout(() => resolve({state: 'working'}), 600)); },
    }),
    start: async () => ({sessionId: 'member-session-2'}), session: () => ({state: 'running', lastOutputAt: 1}),
  };
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null), Date.now, 20);
  const leader = {sessionId: 'leader-session-1', agent: 'claude' as const};
  const {team} = await service.create(parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId: 'team-qa-cursor-0001', title: '팀', goal: '목표', members: [
    {agent: 'claude', surface: 'orca-worktree', task: 'Orca에서 작업'}, {agent: 'codex', task: '워크룸에서 작업'},
  ]}) as Extract<WorkroomTeamRequest, {op: 'create'}>, leader);
  // The slow read makes that member unknown, which counts as settled and ends the leader's first wait.
  slowNext = true;
  const firstWait = await service.wait({op: 'wait', teamId: team.id, timeoutMs: 300, until: 'any', afterSettled: 0});
  expect(firstWait.team.members.map(member => member.state)).toEqual(['unknown', 'working']);
  const cursor = firstWait.team.settled;
  await new Promise(resolve => setTimeout(resolve, 700));
  // The leader waits from the cursor it was given, as the tool asks; Orca answers again (the count drops back to 0) and
  // the Workroom member reports (back to 1 — no higher than the cursor).
  const waiting = service.wait({op: 'wait', teamId: team.id, timeoutMs: 2_000, until: 'any', afterSettled: cursor});
  await new Promise(resolve => setTimeout(resolve, 200));
  const reportedAt = Date.now();
  await service.report({op: 'report', teamId: team.id, memberId: 'm2', status: 'done', summary: '끝'}, {sessionId: 'member-session-2', agent: 'codex'});
  const second = await waiting;
  expect(second.team.members.map(member => member.state)).toEqual(['working', 'reported']);
  expect({cursor, settledNow: second.team.settled, timedOut: second.timedOut}).toEqual({cursor: 1, settledNow: 1, timedOut: false});
  expect(Date.now() - reportedAt).toBeLessThan(1_000);
  // Nothing new since that view: a wait from its cursor waits, rather than waking again on the same report.
  expect((await service.wait({op: 'wait', teamId: team.id, timeoutMs: 100, until: 'any', afterSettled: second.team.settled})).timedOut).toBe(true);
}, 15_000);

test('another caller\'s read after the count came back does not take the report from the leader\'s count cursor', async () => {
  // The same slow Orca read as above makes that member unknown once; it is working again before the other member reports.
  let slowNext = false;
  const host: WorkroomTeamHost = {
    ...externalHost({
      start: async () => ({ref: {kind: 'external', surface: 'orca-worktree', runtime: 'orca', handle: 'term_1', owned: true, evidence: {send: true, read: true}}, state: 'working', delivery: 'verified'}),
      observe: async () => { if (!slowNext) return {state: 'working'}; slowNext = false; return new Promise(resolve => setTimeout(() => resolve({state: 'working'}), 600)); },
    }),
    start: async () => ({sessionId: 'member-session-2'}), session: () => ({state: 'running', lastOutputAt: 1}),
  };
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null), Date.now, 20);
  const {team} = await service.create(parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId: 'team-qa-reader-0001', title: '팀', goal: '목표', members: [
    {agent: 'claude', surface: 'orca-worktree', task: 'Orca에서 작업'}, {agent: 'codex', task: '워크룸에서 작업'},
  ]}) as Extract<WorkroomTeamRequest, {op: 'create'}>, {sessionId: 'leader-session-1', agent: 'claude'});
  slowNext = true;
  const leaderView = (await service.wait({op: 'wait', teamId: team.id, timeoutMs: 300, until: 'any', afterSettled: 0})).team;
  expect([leaderView.settled, leaderView.members[0]!.state]).toEqual([1, 'unknown']);
  await new Promise(resolve => setTimeout(resolve, 700));
  await service.report({op: 'report', teamId: team.id, memberId: 'm2', status: 'done', summary: '끝'}, {sessionId: 'member-session-2', agent: 'codex'});
  // Someone else (a reviewer, another tool) reads first: the count is 1 again, now with the report in it.
  const other = (await service.read({op: 'read', teamId: team.id})).team!;
  expect([other.settled, other.members.map(member => member.state)]).toEqual([1, ['working', 'reported']]);
  // The leader's own cursors still wake for it: the count it saw, and its place in the settle events.
  const byCount = await service.wait({op: 'wait', teamId: team.id, timeoutMs: 1_000, until: 'any', afterSettled: leaderView.settled});
  expect({timedOut: byCount.timedOut, m2: byCount.team.members[1]!.state}).toEqual({timedOut: false, m2: 'reported'});
  const byCursor = await service.wait({op: 'wait', teamId: team.id, timeoutMs: 1_000, until: 'any', afterCursor: leaderView.settledCursor});
  expect({timedOut: byCursor.timedOut, m2: byCursor.team.members[1]!.state}).toEqual({timedOut: false, m2: 'reported'});
  // From the cursor that answer gave out, nothing is new.
  expect((await service.wait({op: 'wait', teamId: team.id, timeoutMs: 100, until: 'any', afterCursor: byCursor.team.settledCursor})).timedOut).toBe(true);
}, 15_000);

test('only the settle cursor is each caller\'s own: another waiter answered on the same count takes the event from a count cursor, never from it', async () => {
  let started = 0;
  const host: WorkroomTeamHost = {
    ...externalHost({start: async () => { throw new Error('no external member here'); }}),
    start: async () => ({sessionId: `member-session-${++started}`}), session: () => ({state: 'running', lastOutputAt: 1}),
  };
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null), Date.now, 20);
  const member = {sessionId: 'member-session-1', agent: 'codex' as const};
  const {team} = await service.create(parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId: 'team-qa-waiters-0001', title: '팀', goal: '목표', members: [
    {agent: 'codex', task: '작업'}, {agent: 'claude', task: '다른 작업'},
  ]}) as Extract<WorkroomTeamRequest, {op: 'create'}>, {sessionId: 'leader-session-1', agent: 'claude'});
  await service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'blocked', summary: '권한이 필요합니다'}, member);
  const seen = (await service.read({op: 'read', teamId: team.id})).team!;
  // Another waiter on the same count is answered with the done report first.
  const competing = service.wait({op: 'wait', teamId: team.id, timeoutMs: 2_000, until: 'any', afterSettled: seen.settled});
  await new Promise(resolve => setTimeout(resolve, 100));
  await service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: '끝'}, member);
  expect((await competing).team.members[0]!.state).toBe('reported');
  // The count alone cannot tell the leader's view from that answer — a known limit of `afterSettled`.
  expect((await service.wait({op: 'wait', teamId: team.id, timeoutMs: 300, until: 'any', afterSettled: seen.settled})).timedOut).toBe(true);
  // The leader's own cursor still wakes for the report it has not seen.
  const own = await service.wait({op: 'wait', teamId: team.id, timeoutMs: 1_000, until: 'any', afterCursor: seen.settledCursor});
  expect({timedOut: own.timedOut, m1: own.team.members[0]!.state}).toEqual({timedOut: false, m1: 'reported'});
  // A cursor from another run of the app (or another team) cannot say what it saw: it is answered at once, with one that can.
  const foreign = `${seen.settledCursor.split('.')[0] === 'ffffffff' ? '00000000' : 'ffffffff'}.3`;
  const answered = await service.wait({op: 'wait', teamId: team.id, timeoutMs: 1_000, until: 'any', afterCursor: foreign});
  expect(answered.timedOut).toBe(false);
  expect((await service.wait({op: 'wait', teamId: team.id, timeoutMs: 100, until: 'any', afterCursor: answered.team.settledCursor})).timedOut).toBe(true);
  expect(() => parseWorkroomTeamRequest({op: 'wait', teamId: team.id, afterCursor: 'nope'})).toThrow('afterCursor');
}, 10_000);

test('a member read is verified only while its session still runs as that member once the output is in, and its cursor follows 다시 시작', async () => {
  const sessions = new Map<string, 'running' | 'exited'>(), continued = new Map<string, string>(), reads: Array<[string, number]> = [];
  const host: WorkroomTeamHost = {
    ...externalHost({start: async () => { throw new Error('no external member here'); }}),
    start: async () => { sessions.set('member-session-1', 'running'); return {sessionId: 'member-session-1'}; },
    session: sessionId => ({state: sessions.get(sessionId) ?? 'missing', lastOutputAt: null}),
    continuation: sessionId => { let latest: string | null = null; for (let at = continued.get(sessionId); at; at = continued.get(at)) latest = at; return latest ? {sessionId: latest} : null; },
  };
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
  const leader = {sessionId: 'leader-session-1', agent: 'claude' as const};
  const {team} = await service.create(parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId: 'team-qa-member-read-0001', title: '팀', goal: '목표', members: [{agent: 'codex', task: '작업'}]}) as Extract<WorkroomTeamRequest, {op: 'create'}>, leader);
  const operation = (cursor?: string, during: () => void = () => {}) => runTeamMemberOperation({service, external: {} as never,
    readWorkroom: async (sessionId, _targetId, after) => { reads.push([sessionId, after]); during(); return {text: `SESSION:${sessionId}\nworking`, nextCursor: after + 7}; }},
    parseWorkroomTeamRequest({op: 'member', teamId: team.id, memberId: 'm1', operation: 'read', ...(cursor === undefined ? {} : {cursor})}) as Extract<WorkroomTeamRequest, {op: 'member'}>, leader);
  const first = await operation();
  expect(first).toMatchObject({session: 'running', agentVerified: true, cursor: 'member-session-1:7'});
  // 다시 시작 while that output is being read — even before the old session is seen to end: what was read is the old
  // session's, not the member at work now.
  const moved = await operation(first.cursor as string, () => { continued.set('member-session-1', 'member-session-2'); sessions.set('member-session-2', 'running'); });
  expect(moved).toMatchObject({agentVerified: false, cursor: 'member-session-1:14'});
  sessions.set('member-session-1', 'exited');
  // That cursor reads the continued session from its start — output numbers began again there — not from 14.
  const next = await operation(moved.cursor as string);
  expect(next).toMatchObject({session: 'running', agentVerified: true, cursor: 'member-session-2:7'});
  expect(reads.at(-1)).toEqual(['member-session-2', 0]);
  // A bare number (the earlier format) still counts in the session the member has now.
  await operation('3');
  expect(reads.at(-1)).toEqual(['member-session-2', 3]);
  // A cursor of a session outside this member's lineage is refused before anything is read.
  const count = reads.length;
  await expect(operation('someone-else-1:5')).rejects.toMatchObject({code: 'WORKROOM_TEAM_REQUEST_INVALID'});
  expect(reads).toHaveLength(count);
  // The CLI exits while its output is read: the text is still given, and said to be from an ended session.
  const ended = await operation(next.cursor as string, () => sessions.set('member-session-2', 'exited'));
  expect(ended).toMatchObject({session: 'exited', agentVerified: false, cursor: 'member-session-2:14'});
  expect(ended.text).toContain('working');
});

test('the team host finds a Workroom in a member checkout under any target that names that folder, never the primary that contains it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-qa-checkout-'))); dirs.push(root);
  const checkout = join(root, 'worktrees', 'team-a-m1'), inner = join(checkout, 'packages', 'web');
  mkdirSync(inner, {recursive: true});
  const cwds = new Map([['rwt_member', checkout], ['port-checkout', checkout], ['port-inner', inner], ['shop-project', root]]);
  let sessions: Array<{id: string; targetId: string; state: 'running' | 'exited'}> = [];
  const host = createWorkroomTeamHost({gitPath: '/usr/bin/git',
    terminal: {perform: async () => ({sessions}), runningSession: () => null, retiredSession: () => null, sessionActivity: () => ({}), wholeSubmissionSupported: () => true, submitHostInstruction: async () => ({})},
    resolveProject: async () => ({projectId: 'p', projectName: 'P', canonicalPath: root}), targetCwd: async (targetId: string) => cwds.get(targetId) ?? null,
    ensureExclude: async () => {}, seedConfig: () => {}, withLease: async (_path: string, _label: string, work: () => Promise<unknown>) => work(),
  } as unknown as WorkroomTeamHostDependencies);
  // The leader in the primary (whose worktrees/ holds the checkout) and an ended session there are not in the checkout.
  sessions = [{id: 'leader', targetId: 'shop-project', state: 'running'}, {id: 'ended', targetId: 'port-checkout', state: 'exited'}];
  expect(await host.sessionForTarget('rwt_member', checkout)).toBeNull();
  sessions.push({id: 'registered', targetId: 'port-checkout', state: 'running'});
  expect(await host.sessionForTarget('rwt_member', checkout)).toEqual({sessionId: 'registered'});
  // Without the checkout only the exact target counts, as before.
  expect(await host.sessionForTarget('rwt_member')).toBeNull();
  sessions = [{id: 'leader', targetId: 'shop-project', state: 'running'}, {id: 'inner', targetId: 'port-inner', state: 'running'}];
  expect(await host.sessionForTarget('rwt_member', checkout)).toEqual({sessionId: 'inner'});
  sessions.push({id: 'own-target', targetId: 'rwt_member', state: 'running'});
  expect(await host.sessionForTarget('rwt_member', checkout)).toEqual({sessionId: 'own-target'});
});

test('a member that was blocked and then reports done wakes a leader whose cursor already counted it', async () => {
  let started = 0;
  const host: WorkroomTeamHost = {
    ...externalHost({start: async () => { throw new Error('no external member here'); }}),
    start: async () => ({sessionId: `member-session-${++started}`}), session: () => ({state: 'running', lastOutputAt: 1}),
  };
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null), Date.now, 20);
  const leader = {sessionId: 'leader-session-1', agent: 'claude' as const}, member = {sessionId: 'member-session-1', agent: 'codex' as const};
  const {team} = await service.create(parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId: 'team-qa-blocked-0001', title: '팀', goal: '목표', members: [
    {agent: 'codex', task: '작업'}, {agent: 'claude', task: '다른 작업'},
  ]}) as Extract<WorkroomTeamRequest, {op: 'create'}>, leader);
  await service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'blocked', summary: '권한이 필요합니다'}, member);
  const seen = (await service.read({op: 'read', teamId: team.id})).team!;
  expect(seen.settled).toBe(1);
  // The leader answers and waits from the count it saw; the member's done report keeps that count at 1.
  const waiting = service.wait({op: 'wait', teamId: team.id, timeoutMs: 2_000, until: 'any', afterSettled: seen.settled});
  await new Promise(resolve => setTimeout(resolve, 100));
  await service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: '끝'}, member);
  const woke = await waiting;
  expect({timedOut: woke.timedOut, settled: woke.team.settled, m1: woke.team.members[0]!.state}).toEqual({timedOut: false, settled: 1, m1: 'reported'});
}, 10_000);

test('without the exact 다시 시작 lineage a session on the member target is never bound, and close keeps its checkout', async () => {
  const sessions = new Map<string, 'running' | 'exited'>(), closed: string[] = [], removed: string[] = [];
  const host: WorkroomTeamHost = {
    ...externalHost({start: async () => { throw new Error('no external member here'); }}),
    start: async () => { sessions.set('member-session-1', 'running'); return {sessionId: 'member-session-1'}; },
    session: sessionId => ({state: sessions.get(sessionId) ?? 'missing', lastOutputAt: null}),
    // The host knows a continuation only for another target: it is not this member's.
    continuation: (_sessionId, targetId) => targetId === 'rwt_elsewhere' ? {sessionId: 'someone-else'} : null,
    sessionForTarget: async () => { const running = [...sessions].find(([, state]) => state === 'running'); return running ? {sessionId: running[0]} : null; },
    close: async sessionId => { closed.push(sessionId); sessions.set(sessionId, 'exited'); },
    removeWorktree: async (_primary, path) => { removed.push(path); return 'removed'; },
  };
  const service = new WorkroomTeamService(host, new WorkroomTeamStore(null));
  const {team} = await service.create(parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId: 'team-qa-unbound-0001', title: '팀', goal: '목표', members: [{agent: 'codex', task: '작업'}]}) as Extract<WorkroomTeamRequest, {op: 'create'}>,
    {sessionId: 'leader-session-1', agent: 'claude'});
  // Its own session ends and another opens on the same target, as a plain 「새 작업」 or an untracked restart would.
  sessions.set('member-session-1', 'exited'); sessions.set('person-session-9', 'running');
  expect((await service.read({op: 'read', teamId: team.id})).team!.members[0]).toMatchObject({state: 'exited', sessionId: 'member-session-1'});
  const result = await service.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, {sessionId: 'leader-session-1', agent: 'claude'});
  expect(result.outcomes).toEqual([{memberId: 'm1', session: 'kept', worktree: 'kept', branch: 'kept', error: expect.stringContaining('person-s')}]);
  expect(result.team.state).toBe('active');
  expect({closed, removed}).toEqual({closed: [], removed: []});
});

test('the team host follows only the exact 다시 시작 chain to a session on the same target', () => {
  const continued = new Map([['s1', 's2'], ['s2', 's3'], ['loop-a', 'loop-b'], ['loop-b', 'loop-a']]);
  const targets = new Map([['s2', 'rwt_a'], ['s3', 'rwt_a'], ['loop-b', 'rwt_a']]);
  const summary = (id: string) => targets.has(id) ? {id, targetId: targets.get(id)!} as any : null;
  const deps = (continuationOf?: (id: string) => string | null) => ({gitPath: '/usr/bin/git',
    terminal: {perform: async () => ({}), runningSession: summary, retiredSession: () => null, sessionActivity: () => ({}), wholeSubmissionSupported: () => true, submitHostInstruction: async () => ({}),
      ...(continuationOf ? {continuationOf} : {})},
    resolveProject: async () => ({projectId: 'p', projectName: 'P', canonicalPath: '/repo'}), targetCwd: async () => null, ensureExclude: async () => {}, seedConfig: () => {}, withLease: async (_path: string, _label: string, work: () => Promise<unknown>) => work(),
  }) as unknown as WorkroomTeamHostDependencies;
  const host = createWorkroomTeamHost(deps(id => continued.get(id) ?? null));
  expect(host.continuation!('s1', 'rwt_a')).toEqual({sessionId: 's3'});
  expect(host.continuation!('s1', 'rwt_b')).toBeNull();
  expect(host.continuation!('loop-a', 'rwt_a')).toEqual({sessionId: 'loop-b'});
  expect(host.continuation!('unknown', 'rwt_a')).toBeNull();
  // A terminal that cannot name a continuation binds nothing.
  expect(createWorkroomTeamHost(deps()).continuation!('s1', 'rwt_a')).toBeNull();
});

test('the leader continued by 다시 시작 confirms, transcribes and reads for an external member; another session, a ledger without the leader target, or a later run cannot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-qa-leader-lineage-')); dirs.push(dir);
  const file = join(dir, 'workroom-teams.v1.json');
  // The exact resumeFrom links this run's terminal recorded, followed on the session's own target only (workroomTeamHost).
  const links = new Map<string, string>();
  const hostFor = (known: Map<string, string>): WorkroomTeamHost => ({
    ...externalHost({start: async input => ({ref: {kind: 'external', surface: 'app', runtime: 'codex-app', handle: `conv_${input.memberId}`, owned: false}, state: 'awaiting-manual-join', delivery: 'not-sent'})}),
    continuation: (sessionId, targetId) => { let latest: string | null = null; for (let at = known.get(sessionId); at; at = known.get(at)) latest = at; return latest && targetId === 'shop-project' ? {sessionId: latest} : null; },
  });
  const service = new WorkroomTeamService(hostFor(links), new WorkroomTeamStore(file));
  const create = (requestId: string) => parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId, title: '팀', goal: '목표', members: [{agent: 'codex', surface: 'app', task: '앱에서 작업'}]}) as Extract<WorkroomTeamRequest, {op: 'create'}>;
  const caller = (sessionId: string) => ({sessionId, agent: 'claude' as const, targetId: 'shop-project'});
  const {team} = await service.create(create('team-qa-leader-lineage-0001'), caller('leader-session-1'));
  expect(team.leader).toEqual({sessionId: 'leader-session-1', agent: 'claude', targetId: 'shop-project'});
  const confirm = (teamId: string) => ({op: 'confirm' as const, teamId, memberId: 'm1', confirm: 'delivered' as const});
  const report = {op: 'report' as const, teamId: team.id, memberId: 'm1', status: 'done' as const, summary: '앱 화면에서 읽음', manual: true as const};
  const member = (as: ReturnType<typeof caller>) => runTeamMemberOperation({service, readWorkroom: async () => { throw new Error('no Workroom member here'); },
    external: {read: async () => ({text: '앱 화면', agentVerified: null, outcome: 'read', reason: null})} as never},
    parseWorkroomTeamRequest({op: 'member', teamId: team.id, memberId: 'm1', operation: 'read'}) as Extract<WorkroomTeamRequest, {op: 'member'}>, as);

  // The leader's 다시 시작 (twice), and a person's 「새 작업」 on the same target; nothing has read the team since.
  links.set('leader-session-1', 'leader-session-2'); links.set('leader-session-2', 'leader-session-3');
  const continued = caller('leader-session-3'), other = caller('person-session-9');
  await expect(service.confirm(confirm(team.id), other)).rejects.toMatchObject({code: 'WORKROOM_TEAM_CONFIRM_DENIED'});
  await expect(member(other)).rejects.toMatchObject({code: 'WORKROOM_TEAM_MEMBER_OPERATION_DENIED'});
  expect(await member(continued)).toMatchObject({memberId: 'm1', success: true, text: '앱 화면'});
  await service.confirm(confirm(team.id), continued);
  await expect(service.report(report, other)).rejects.toMatchObject({code: 'WORKROOM_TEAM_REPORT_DENIED'});
  const reported = (await service.report(report, continued)).team;
  expect(reported.leader).toEqual({sessionId: 'leader-session-3', agent: 'claude', targetId: 'shop-project'});
  expect(reported.members[0]).toMatchObject({state: 'reported', delivery: 'manual', report: {status: 'done', provenance: 'manual'}});
  expect((await teamsForSession(service, {sessionId: 'leader-session-3', git: false})).teams.map(item => [item.id, item.role, item.leader.sessionId]))
    .toEqual([[team.id, 'leader', 'leader-session-3']]);
  await expect(member(other)).rejects.toMatchObject({code: 'WORKROOM_TEAM_MEMBER_OPERATION_DENIED'});

  // A ledger written before the leader's target was kept: only its recorded session leads, even along a real lineage.
  const old = (await service.create(create('team-qa-leader-lineage-0002'), {sessionId: 'old-leader-1', agent: 'claude'})).team;
  expect(old.leader).toEqual({sessionId: 'old-leader-1', agent: 'claude'});
  links.set('old-leader-1', 'old-leader-2');
  await expect(service.confirm(confirm(old.id), caller('old-leader-2'))).rejects.toMatchObject({code: 'WORKROOM_TEAM_CONFIRM_DENIED'});
  expect((await service.read({op: 'read', teamId: old.id})).team!.leader).toEqual({sessionId: 'old-leader-1', agent: 'claude'});
  await service.confirm(confirm(old.id), {sessionId: 'old-leader-1', agent: 'claude'});

  // The app quits and opens again: no lineage crosses runs, so a new session on the leader's target never leads.
  const later = new WorkroomTeamService(hostFor(new Map()), new WorkroomTeamStore(file));
  const reopened = (await later.read({op: 'read', teamId: team.id})).team!;
  expect(reopened.leader).toEqual({sessionId: 'leader-session-3', agent: 'claude', targetId: 'shop-project'});
  await expect(later.confirm(confirm(team.id), caller('next-run-session-1'))).rejects.toMatchObject({code: 'WORKROOM_TEAM_CONFIRM_DENIED'});
  await expect(later.report(report, caller('next-run-session-1'))).rejects.toMatchObject({code: 'WORKROOM_TEAM_REPORT_DENIED'});
  // Close never ends a window this team did not start.
  const closed = await later.close({op: 'close', teamId: team.id, deleteMergedBranches: true}, caller('leader-session-3'));
  expect(closed.outcomes.map(outcome => [outcome.session, outcome.worktree])).toEqual([['kept', 'kept']]);
});
