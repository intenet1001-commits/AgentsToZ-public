/**
 * 팀 작전 after an app restart, end to end in one process: agentstoz_use_team_member (the real MCP handler) → a loopback
 * stand-in for the app's /api/agentstoz-use/action that parses the action and runs the real member operation → the real
 * team runtime bridge, external host runtime, file journal and Orca recovery read → a scripted Orca CLI. Fixtures only:
 * nothing launches, types into or closes a real terminal.
 *
 * EXTERNAL_HOST_RESTART_READ_ONLY: an Orca member an earlier run of the app started is read once its terminal, worktree,
 * agent and process are checked again, with agentVerified:false. It is evidence, never authority: send, reveal and close
 * stay refused, and nothing is written to the journal or the Orca terminal.
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {createTeamExternalFileJournal, createTeamExternalHostRuntime, type TeamExternalHostOptions} from '../src/teamExternalHost';
import type {TeamExternalJournal, TeamExternalScope} from '../src/teamExternalRuntime';
import {createTeamOrcaRecoveryRead} from '../src/teamOrcaRecoveryRead';
import {createTeamRuntimeBridge, type TeamRuntimeBinding} from '../src/teamRuntimeBridge';
import {WorkroomTeamError} from '../src/workroomTeam';
import {runTeamMemberOperation} from '../src/workroomTeamMemberOperation';

const TEAM = 'team_0123456789ab', CWD = '/repo/member', TARGET = 'rwt-member-one';
const dirs: string[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

/** One Orca CLI that both runs of the app talk to; it records every command it receives. */
function orca() {
  const calls: string[][] = [];
  const live = {runtimeId: 'orca-runtime-one', incarnationId: 'process-one', agentIdentity: 'claude', worktreePath: CWD, worktreeId: 'repo::/repo/member', connected: true};
  const envelope = (result: unknown) => ({ok: true, result, _meta: {runtimeId: live.runtimeId}});
  const terminal = () => ({handle: 'term-exact', incarnationId: live.incarnationId, worktreeId: live.worktreeId, worktreePath: live.worktreePath, ptyId: 'pty-one',
    paneRuntimeId: 1, agentIdentity: live.agentIdentity, connected: live.connected, writable: true, executionHostId: 'local'});
  const runOrca: TeamExternalHostOptions['runOrca'] = async (_cli, argv) => {
    calls.push([...argv]);
    if (argv[0] === 'status') return envelope({status: 'running'});
    if (argv[1] === 'create' || argv[1] === 'show') return envelope({terminal: terminal()});
    if (argv[1] === 'read') return envelope({terminal: {handle: 'term-exact', status: 'running', tail: ['member output', 'next line'], nextCursor: '20'}});
    if (argv[1] === 'send') return envelope({send: {handle: 'term-exact', accepted: true, prompt: {processIncarnation: live.incarnationId, provider: 'claude', observation: 'supported', stages: ['input_accepted', 'turn_started']}}});
    if (argv[1] === 'switch') return envelope({terminal: {handle: 'term-exact'}});
    if (argv[1] === 'close') return envelope({terminal: {handle: 'term-exact', closed: true}});
    throw new Error(`unexpected orca ${argv.slice(0, 2).join(' ')}`);
  };
  return {calls, live, runOrca};
}

/** One run of the app: its own host instance id, runtime and bridge over the shared journal, wired as api-server.ts wires them. */
function appRun(hostInstanceId: string, journal: TeamExternalJournal, cli: ReturnType<typeof orca>, binding: () => TeamRuntimeBinding | null) {
  let bridge: ReturnType<typeof createTeamRuntimeBridge>;
  const runtime = createTeamExternalHostRuntime({journal, currentHostInstanceId: () => hostInstanceId, isCurrent: (scope: TeamExternalScope) => bridge.isCurrent(scope),
    resolveAgentExecutable: agent => `/verified/${agent}`, resolveOrcaCli: () => '/verified/orca', runOrca: cli.runOrca, platform: 'darwin', supportsManualLaunch: () => true,
    openCodeApp: async () => { throw new Error('no app in this test'); }, openTerminal: async () => { throw new Error('no terminal in this test'); }});
  const readAfterHostRestart = createTeamOrcaRecoveryRead({resolveOrcaCli: () => '/verified/orca', runOrca: cli.runOrca, bindingStillMatches: ref => {
    const b = binding();
    return !!b && b.active && b.targetId === ref.targetId && b.cwd === ref.cwd && b.agent === ref.agent && b.surface === ref.surface && b.generation === ref.generation;
  }});
  bridge = createTeamRuntimeBridge({journal, runtime, hostInstanceId, binding: () => binding(), readAfterHostRestart});
  return bridge;
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'team-restart-read-only-'));
  dirs.push(dir);
  const journal = createTeamExternalFileJournal(join(dir, 'workroom-team-executions.v1.json'));
  const cli = orca();
  let binding: TeamRuntimeBinding | null = {targetId: TARGET, cwd: CWD, agent: 'claude', surface: 'orca-worktree', generation: 1, active: true};
  // The run before the restart starts the member on Orca, as create_team does.
  const before = appRun('host-before-restart', journal, cli, () => binding);
  const started = await before.start({teamId: TEAM, memberId: 'm1', memberName: 'worker', agent: 'claude', plan: {surface: 'orca-worktree'}, cwd: CWD, targetId: TARGET,
    prompt: 'Implement the member task.', requestId: 'launch-request-0001', effort: {requestText: 'Implement the member task.'}});
  const team = {state: 'active', leader: {sessionId: 'leader_session'}, members: [{id: 'm1', surface: 'orca-worktree', execution: started.ref}]};
  // The run after the restart: a new host instance id over the same journal file and team ledger.
  const after = appRun('host-after-restart', journal, cli, () => binding);
  const host = {service: {store: {get: (id: string) => id === TEAM ? team : undefined}}, external: after,
    readWorkroom: async () => { throw new Error('not a Workroom member'); }} as unknown as Parameters<typeof runTeamMemberOperation>[0];
  // A stand-in for the app's action endpoint: the same parser and member operation, and the response shape api-server.ts returns.
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: async request => {
    if (new URL(request.url).pathname !== '/api/agentstoz-use/action') return new Response('not found', {status: 404});
    try {
      const action = parseAgentsToZUseActionRequest(await request.json());
      const member = action.team!;
      if (member.op !== 'member') throw new Error('only member operations in this test');
      const result = await runTeamMemberOperation(host, member, null);
      return Response.json({success: true, performed: true, action: action.action, op: member.op, effect: member.operation === 'read' ? 'read-only' : 'team-member', ...result});
    } catch (error) {
      const known = error instanceof WorkroomTeamError;
      return Response.json({success: false, performed: false, code: known ? error.code : 'TEST_FAILED', error: error instanceof Error ? error.message : String(error)}, {status: known ? error.status : 500});
    }
  }});
  servers.push(server);
  const env = {AGENTSTOZ_USE_ENDPOINT: `http://127.0.0.1:${server.port}/api/agentstoz-use/action`, AGENTSTOZ_CONTROLLER_PORT_ID: 'ops-project', HOME: dir};
  const call = async (args: Record<string, unknown>) => {
    const response = await handleAgentsToZUseMcpRequest({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'agentstoz_use_team_member', arguments: {teamId: TEAM, memberId: 'm1', ...args}}}, env) as any;
    const result = response.result;
    return {isError: result.isError as boolean, content: result.structuredContent ?? JSON.parse(result.content[0].text)};
  };
  const record = () => journal.read(`${TEAM}:m1`);
  return {cli, call, record, started, setBinding: (value: TeamRuntimeBinding | null) => { binding = value; }, afterRestart: cli.calls.length};
}

test('after a restart, agentstoz_use_team_member reads the earlier Orca member read-only, never verified, without writing anything', async () => {
  const f = await fixture();
  expect(f.started.state).toBe('awaiting-ack');
  const journalBefore = await f.record();
  expect(journalBefore!.receipt.executionRef.hostInstanceId).toBe('host-before-restart');
  const launchCalls = f.cli.calls.length;
  const read = await f.call({operation: 'read', limit: 400});
  expect(read.isError).toBe(false);
  expect(read.content).toMatchObject({success: true, performed: true, effect: 'read-only', memberId: 'm1', surface: 'orca-worktree',
    text: 'member output\nnext line', cursor: '20', agentVerified: false, outcome: 'read', reason: 'EXTERNAL_HOST_RESTART_READ_ONLY'});
  // Checked on both sides of the read, on the recorded terminal only — no send, focus, close or create.
  expect(f.cli.calls.slice(launchCalls).map(args => args.slice(0, 2))).toEqual([['terminal', 'show'], ['terminal', 'read'], ['terminal', 'show']]);
  expect(f.cli.calls.slice(launchCalls).every(args => args.includes('term-exact'))).toBe(true);
  // The read neither rebinds the execution to the new run nor records anything.
  expect(await f.record()).toEqual(journalBefore);
  // The native handle never reaches the caller.
  expect(JSON.stringify(read.content)).not.toContain('term-exact');
});

test('after a restart, send and reveal stay refused through the same MCP tool and reach no Orca terminal', async () => {
  const f = await fixture();
  const journalBefore = await f.record(), launchCalls = f.cli.calls.length;
  const sent = await f.call({operation: 'send', requestId: 'follow-up-request-0001', text: '진행 상황을 알려 주세요'});
  expect(sent.isError).toBe(true);
  expect(sent.content).toMatchObject({success: false, performed: false, data: {delivery: 'not-sent', performed: false, success: false}});
  const revealed = await f.call({operation: 'reveal', requestId: 'reveal-request-0001'});
  expect(revealed.isError).toBe(true);
  expect(revealed.content).toMatchObject({success: false, performed: false, data: {effect: 'reveal-refused', performed: false}});
  expect(f.cli.calls.slice(launchCalls)).toEqual([]);
  expect(await f.record()).toEqual(journalBefore);
});

test('after a restart, a recreated team, a moved checkout or a changed Orca process reads nothing', async () => {
  const f = await fixture();
  const launchCalls = f.cli.calls.length;
  // The team was recreated (another generation): not even the recorded terminal is asked.
  f.setBinding({targetId: TARGET, cwd: CWD, agent: 'claude', surface: 'orca-worktree', generation: 2, active: true});
  const regenerated = await f.call({operation: 'read'});
  expect(regenerated.isError).toBe(true);
  expect(regenerated.content.data).toMatchObject({performed: false, effect: 'read-unconfirmed', reason: 'EXTERNAL_GENERATION_STALE', text: ''});
  expect(f.cli.calls.slice(launchCalls)).toEqual([]);
  // The same team, but Orca now runs another process in that terminal: the first check refuses before any read.
  f.setBinding({targetId: TARGET, cwd: CWD, agent: 'claude', surface: 'orca-worktree', generation: 1, active: true});
  f.cli.live.incarnationId = 'process-two';
  const replaced = await f.call({operation: 'read'});
  expect(replaced.isError).toBe(true);
  expect(replaced.content.data).toMatchObject({performed: false, effect: 'read-unconfirmed', text: ''});
  expect(f.cli.calls.slice(launchCalls).map(args => args[1])).toEqual(['show']);
});
