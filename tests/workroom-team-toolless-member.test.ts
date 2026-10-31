/**
 * 팀 작전 — a Workroom member whose AI has no agentstoz_use connection (the 2026-10-31 readiness check: Hermes and agy
 * were not configured, so their members could never report and nothing could record their result).
 *
 * The rules: the team still starts (refusing would leave a 4-agent team unbuildable until someone finds the setting);
 * only a connection known to be missing changes anything; that member is briefed to write its result in its terminal;
 * the leader alone may transcribe it, marked [리더 전사 · manual]; and the member's own report, if the tool was there
 * after all, stays authoritative.
 */
import {expect, test} from 'bun:test';
import type {AiTerminalAgent} from '../src/aiTerminalProtocol';
import {parseWorkroomTeamRequest, TEAM_TRANSCRIBED_MARK, WorkroomTeamService, WorkroomTeamStore, type WorkroomTeamHost, type WorkroomTeamRequest} from '../src/workroomTeam';
import {normalizeTeamPanelResult, teamPanelView} from '../src/workroomTeamPanel';
import type {TeamExternalStarted} from '../src/teamLaunchPlan';

const leader = {sessionId: 'leader-1', agent: 'claude' as const};
const create = (members: unknown[], requestId = 'team-request-toolless-1') =>
  parseWorkroomTeamRequest({op: 'create', portId: 'port-demo', requestId, title: '팀', goal: '목표', members}) as Extract<WorkroomTeamRequest, {op: 'create'}>;

function host(teamTool?: WorkroomTeamHost['teamTool']) {
  const prompts = new Map<string, string>(), asked: AiTerminalAgent[] = [];
  const base: WorkroomTeamHost = {
    resolveProject: async portId => ({projectId: portId, projectName: 'Demo', canonicalPath: '/repo'}),
    primary: async () => ({path: '/repo', base: '/repo', head: 'a'.repeat(40), branch: 'main', trackedChanges: [], untracked: 0}),
    attachable: async () => null,
    addWorktree: async () => {}, worktreeTargetId: (_project, path) => `rwt_${path.split('/').pop()}`,
    start: async input => { const sessionId = `session-${prompts.size + 1}`; prompts.set(sessionId, input.prompt); return {sessionId}; },
    session: () => ({state: 'running', lastOutputAt: 1}),
    sessionForTarget: async () => null,
    instruct: async () => 'written',
    close: async () => {},
    removeWorktree: async () => 'removed',
    branchGit: async () => ({commits: 0, files: 0, insertions: 0, deletions: 0, merged: false}),
    deleteMergedBranch: async () => 'deleted',
    external: {start: async (): Promise<TeamExternalStarted> => ({
      ref: {kind: 'external', surface: 'cmux', runtime: 'cmux', handle: 'surface_1', owned: true, evidence: {send: true, read: true}}, state: 'awaiting-ack', delivery: 'unknown'})},
    ...(teamTool ? {teamTool: async (agent: AiTerminalAgent) => { asked.push(agent); return teamTool(agent); }} : {}),
  };
  return {host: base, prompts, asked};
}
const status = (map: Partial<Record<AiTerminalAgent, 'connected' | 'missing' | 'unknown' | 'throws'>>): WorkroomTeamHost['teamTool'] => async agent => {
  const value = map[agent] ?? 'connected';
  if (value === 'throws') throw new Error('codex mcp get timed out');
  return value;
};

test('only a Workroom member whose AI is known to lack the team tool is marked, and the team still starts', async () => {
  const h = host(status({hermes: 'missing', agy: 'unknown', codex: 'throws', claude: 'missing'}));
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([
    {agent: 'hermes', task: '헤르메스 작업'},
    {agent: 'codex', task: '코덱스 작업'},
    {agent: 'agy', task: 'agy 작업'},
    {agent: 'claude', task: 'cmux 작업', surface: 'cmux'},
    {agent: 'hermes', task: '헤르메스 검토', role: 'reviewer'},
  ]), leader);
  // Asked once per AI that would report from a Workroom: claude only runs on cmux here, which has its own path.
  expect([...h.asked].sort()).toEqual(['agy', 'codex', 'hermes']);
  const [hermes, codex, agy, cmux, reviewer] = team.members;
  expect(team.members.map(member => member.state)).toEqual(['working', 'working', 'working', 'awaiting-ack', 'working']);
  expect(hermes).toMatchObject({reportsThroughLeader: true});
  expect(hermes!.note).toContain('agentstoz_use 연결이 없어');
  expect(hermes!.note).toContain(TEAM_TRANSCRIBED_MARK);
  expect(hermes!.note!.length).toBeLessThanOrEqual(300);
  expect(reviewer).toMatchObject({reportsThroughLeader: true});
  // A failed or uncertain check is not 「missing」: those members keep the ordinary brief.
  for (const member of [codex, agy, cmux]) { expect(member!.reportsThroughLeader).toBeUndefined(); expect(member!.note ?? '').not.toContain('agentstoz_use 연결이 없어'); }

  const hermesBrief = h.prompts.get(hermes!.sessionId!)!, codexBrief = h.prompts.get(codex!.sessionId!)!, reviewerBrief = h.prompts.get(reviewer!.sessionId!)!;
  expect(hermesBrief).toContain('agentstoz_use_report_team_task 도구가 보이면 그것으로 한 번 보고합니다');
  expect(hermesBrief).toContain('도구가 없으면 대신 현재 터미널에');
  expect(hermesBrief).toContain('manual: true');
  expect(codexBrief).toContain('agentstoz_use_report_team_task를 한 번 호출합니다');
  expect(codexBrief).not.toContain('현재 터미널에');
  expect(reviewerBrief).toContain('그 도구가 없으면 리더가 이 세션에 알려 줄 때까지 기다리고');
  expect(reviewerBrief).toContain('현재 터미널에');
});

test('a host that cannot tell changes nothing: every Workroom member reports with the team tool, as before', async () => {
  const h = host();
  const {team} = await new WorkroomTeamService(h.host, new WorkroomTeamStore(null)).create(create([{agent: 'hermes', task: '작업'}]), leader);
  expect(team.members[0]!.reportsThroughLeader).toBeUndefined();
  expect(team.members[0]!.note).toBeUndefined();
  expect(h.prompts.get(team.members[0]!.sessionId!)).toContain('agentstoz_use_report_team_task를 한 번 호출합니다');
});

test('the leader transcribes a tool-less member’s terminal result, marked, and only the leader may', async () => {
  const h = host(status({hermes: 'missing'}));
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'hermes', task: '헤르메스 작업'}, {agent: 'codex', task: '코덱스 작업'}]), leader);
  const report = (memberId: string, summary: string, manual = true) =>
    ({op: 'report' as const, teamId: team.id, memberId, status: 'done' as const, summary, ...(manual ? {manual: true as const} : {})});
  // Not the leader: refused, whether another session or no caller at all.
  await expect(service.report(report('m1', '터미널에서 읽음'), {sessionId: 'someone-else-1', agent: 'codex'})).rejects.toThrow('리더');
  await expect(service.report(report('m1', '터미널에서 읽음'), null)).rejects.toThrow('리더');
  // A Workroom member that has the tool still reports for itself.
  await expect(service.report(report('m2', '대신 적음'), leader)).rejects.toThrow('manual을 빼고');

  const recorded = await service.report(report('m1', '터미널에서 읽음: 커밋 abc123, bun test 12 pass'), leader);
  const hermes = recorded.team.members[0]!;
  expect(hermes.state).toBe('reported');
  expect(hermes.report).toMatchObject({status: 'done', provenance: 'manual', summary: `${TEAM_TRANSCRIBED_MARK} 터미널에서 읽음: 커밋 abc123, bun test 12 pass`});
  // A replay is a no-op, and a summary that already carries the mark is not marked twice.
  const at = hermes.report!.at;
  expect((await service.report(report('m1', '터미널에서 읽음: 커밋 abc123, bun test 12 pass'), leader)).team.members[0]!.report!.at).toBe(at);
  const again = await service.report(report('m1', `${TEAM_TRANSCRIBED_MARK} 다시 읽음`), leader);
  expect(again.team.members[0]!.report!.summary).toBe(`${TEAM_TRANSCRIBED_MARK} 다시 읽음`);

  // The strip shows it as a transcription; the ledger flag itself never leaves this Mac's ledger.
  const panel = teamPanelView(again.team, leader.sessionId);
  expect(panel.members[0]!.report!.provenance).toBe('manual');
  expect(panel.members[0]!.note).toContain('agentstoz_use 연결이 없어');
  expect(Object.keys(panel.members[0]!)).not.toContain('reportsThroughLeader');
  expect(normalizeTeamPanelResult({teams: [panel]})).toEqual({teams: [panel]});
});

test('a tool-less member that reports for itself after all is taken as its own word, and a transcription never replaces it', async () => {
  const h = host(status({agy: 'missing'}));
  const service = new WorkroomTeamService(h.host, new WorkroomTeamStore(null));
  const {team} = await service.create(create([{agent: 'agy', task: 'agy 작업'}]), leader);
  const member = {sessionId: team.members[0]!.sessionId!, agent: 'agy' as const};
  const own = await service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'blocked', summary: '질문: 어느 브랜치에 맞출까요?'}, member);
  expect(own.team.members[0]!.report).toMatchObject({status: 'blocked', provenance: 'member', summary: '질문: 어느 브랜치에 맞출까요?'});
  await expect(service.report({op: 'report', teamId: team.id, memberId: 'm1', status: 'done', summary: '대신 적음', manual: true}, leader))
    .rejects.toThrow('직접 보고했습니다');
  expect((await service.read({op: 'read', teamId: team.id})).team!.members[0]!.report!.provenance).toBe('member');
});
