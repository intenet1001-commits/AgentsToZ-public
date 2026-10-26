import {afterEach, expect, test} from 'bun:test';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {initializeProjectMemory} from '../project-memory-server';
import {startTestApiServer} from './startTestApiServer';
import {AI_TERMINAL_PREFIX} from '../src/aiTerminalProtocol';
import {HERMES_VARIANTS_PATH} from '../src/hermesVariants';

// 팀 작전 end to end: the real API and MCP server, real Git, and fake CLIs in real Workroom PTYs. A team is created
// over MCP, each member runs in its own worktree with its chosen model flag, commits, reports from inside its own
// Workroom (one member cannot report as another), the leader waits, merges and closes.
const dirs: string[] = [], children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const gitEnv = {GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com'};
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], {cwd, env: {...process.env, ...gitEnv}});
  if (!result.success) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};

function fakeCli(agent: string, data: string): string {
  const client = join(import.meta.dir, 'fixtures', 'team-member-report-client.ts');
  return `#!/bin/sh
stty -echo
model=''; provider=''; brief=''; previous=''
for argument in "$@"; do case "$previous" in -m|--model) model="$argument";; --provider) provider="$argument";; --|-q|-i) brief="$argument";; esac; previous="$argument"; done
printf 'READY:${agent}\\n'
printf 'CWD:%s\\n' "$(pwd -P)"
printf 'MODEL:%s:%s\\n' "$model" "$provider"
case "$brief" in *'AgentsToZ 팀 작전 · 팀원'*) printf 'BRIEF:member\\n';; esac
while IFS= read -r line; do
  case "$line" in
    COMMIT) printf 'work\\n' > team-work.txt && git add team-work.txt && git -c user.name=t -c user.email=t@example.com commit -qm 'team work' && printf 'COMMITTED\\n';;
    'REPORT '*) set -- $line; APP_DATA_DIR='${data}' '${process.execPath}' '${client}' "$2" "$3" "$4" </dev/null;;
    *) printf 'GOT:%s\\n' "$line";;
  esac
done
`;
}

test('a leader creates a team over MCP; members work in their own worktrees, report from their Workrooms, and close cleanly', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'team-e2e-'))); dirs.push(home);
  const data = join(home, 'app-data'), project = join(home, 'projects', 'shop'), ops = join(home, 'AgentsToZ-Control');
  mkdirSync(data); mkdirSync(project, {recursive: true}); mkdirSync(ops);
  // A connected OPS profile authorizes the MCP calls, as on a real Mac (the member's own MCP server reads it from app data).
  git(ops, 'init', '-q'); initializeProjectMemory({folderPath: ops, projectName: 'ops-project', autoBackup: false}); writeFileSync(join(ops, 'CONTROL.md'), '# OPS fixture\n');
  git(project, 'init', '-q', '-b', 'main'); writeFileSync(join(project, 'app.txt'), 'v1\n'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'init');
  writeFileSync(join(data, 'ports.json'), JSON.stringify([{id: 'ops-project', name: 'ops-project', folderPath: ops}, {id: 'shop-project', name: 'shop', folderPath: project}]));
  const bin = join(home, '.local', 'bin'); mkdirSync(bin, {recursive: true});
  for (const agent of ['codex', 'claude', 'hermes', 'agy']) { writeFileSync(join(bin, agent), fakeCli(agent, data)); chmodSync(join(bin, agent), 0o755); }
  const env = {...process.env, HOME: home, APP_DATA_DIR: data, NODE_ENV: 'test', AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1', AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1', AGENTSTOZ_SKIP_HERMES_SYNC: '1'};
  const {baseUrl, child} = await startTestApiServer({cwd: join(import.meta.dir, '..'), env, entrypoint: 'tests/fixtures/agentstoz-use-api.ts'});
  children.push(child);
  const prepared = await fetch(`${baseUrl}/api/control-profile/prepare`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}).then(r => r.json()) as any;
  expect(prepared.profile).toMatchObject({state: 'ready'});
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await handleAgentsToZUseMcpRequest({id: 1, method: 'tools/call', params: {name: `agentstoz_use_${name}`, arguments: args}}, {...env, AGENTSTOZ_USE_ENDPOINT: `${baseUrl}/api/agentstoz-use/action`}) as any;
    if (r.result.structuredContent) return r.result.structuredContent as any;
    const error = JSON.parse(r.result.content[0].text);
    return error.data ?? error;
  };
  const tail = async (sessionId: string, pattern: RegExp) => {
    let last = '', lastResult: unknown = null;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
      const waited = await call('wait_workroom_session', {portId: 'shop-project', sessionId, idleMs: 1_000, timeoutMs: 4_000});
      last = String(waited.text ?? ''); lastResult = waited;
      const line = last.split('\n').find(value => pattern.test(value));
      if (line) return line;
    }
    throw new Error(`missing ${pattern}: ${last.slice(-600)} ${JSON.stringify(lastResult).slice(0, 900)}`);
  };

  const created = await call('create_team', {portId: 'shop-project', requestId: 'team-e2e-0001', title: '결제 개선', goal: '결제 오류를 고친다',
    members: [{agent: 'codex', surface: 'internal', task: '서버 수정'}, {agent: 'hermes', surface: 'internal', hermesVariant: 'claude', task: '테스트 추가'}]});
  expect(created).toMatchObject({success: true, op: 'create', team: {state: 'active', projectId: 'shop-project'}});
  const team = created.team, [m1, m2] = team.members;
  expect([m1.state, m2.state]).toEqual(['working', 'working']);
  for (const member of [m1, m2]) {
    expect(existsSync(join(member.worktreePath, 'app.txt'))).toBe(true);
    expect(await tail(member.sessionId, /^CWD:/)).toBe(`CWD:${realpathSync(member.worktreePath)}`);
    expect(await tail(member.sessionId, /^BRIEF:/)).toBe('BRIEF:member');
  }
  expect(await tail(m1.sessionId, /^MODEL:/)).toBe('MODEL::');
  expect(await tail(m2.sessionId, /^MODEL:/)).toBe('MODEL:claude-opus-5-5:anthropic');
  // The same requestId replays the team instead of starting members again.
  const replay = await call('create_team', {portId: 'shop-project', requestId: 'team-e2e-0001', title: '결제 개선', goal: '결제 오류를 고친다',
    members: [{agent: 'codex', surface: 'internal', task: '서버 수정'}, {agent: 'hermes', surface: 'internal', hermesVariant: 'claude', task: '테스트 추가'}]});
  expect(replay).toMatchObject({replayed: true, team: {id: team.id}});

  expect((await call('send_workroom_instruction', {portId: 'shop-project', sessionId: m1.sessionId, requestId: 'team-e2e-commit', instruction: 'COMMIT'})).success).toBe(true);
  expect(await tail(m1.sessionId, /^COMMITTED$/)).toBe('COMMITTED');
  // Member 2's Workroom cannot report as member 1; member 1 reports for itself.
  await call('send_workroom_instruction', {portId: 'shop-project', sessionId: m2.sessionId, requestId: 'team-e2e-impersonate', instruction: `REPORT ${team.id} m2 m1`});
  expect(await tail(m2.sessionId, /^(REFUSED|REPORTED):/)).toContain('다른 팀원의 보고는 그 팀원 워크룸에서만');
  await call('send_workroom_instruction', {portId: 'shop-project', sessionId: m1.sessionId, requestId: 'team-e2e-report', instruction: `REPORT ${team.id} m1`});
  expect(await tail(m1.sessionId, /^(REFUSED|REPORTED):/)).toBe('REPORTED:m1');
  // The report landed before this wait: the cursor from create (settled 0) still sees it.
  const waited = await call('wait_team', {teamId: team.id, timeoutMs: 5_000, afterSettled: created.team.settled});
  expect(waited.timedOut).toBe(false);
  expect(waited.team.members[0]).toMatchObject({state: 'reported', report: {status: 'done'}, git: {commits: 1, files: 1, merged: false}});

  git(project, 'merge', '--no-ff', '-qm', 'merge team member 1', m1.branch);
  const closed = await call('close_team', {teamId: team.id});
  expect(closed.outcomes).toEqual([
    {memberId: 'm1', session: 'closed', worktree: 'removed', branch: 'deleted'},
    {memberId: 'm2', session: 'closed', worktree: 'removed', branch: 'deleted'},
  ]);
  expect(existsSync(join(project, 'team-work.txt'))).toBe(true);
  expect(git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  expect(git(project, 'branch', '--list', 'team/*')).toBe('');
  const listed = await call('read_team', {portId: 'shop-project'});
  expect(listed.teams.map((item: any) => [item.id, item.state])).toEqual([[team.id, 'closed']]);

  // 「Hermes · Claude」/「Hermes · Codex」 (src/hermesVariants.ts) on the same running sidecar: this Mac's panels add one
  // enum to a local start, and the host turns it into the model and provider that CLI actually receives.
  // This Mac's own window: the local sidecar answers the app's exact origin (no relay, no capability header).
  const localHeaders = {'Content-Type': 'application/json', Origin: 'http://tauri.localhost'};
  const terminal = async (body: Record<string, unknown>) => {
    const response = await fetch(`${baseUrl}${AI_TERMINAL_PREFIX}`, {method: 'POST', headers: localHeaders, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json() as any};
  };
  const variantStart = await terminal({operation: 'start', requestId: 'hermes-variant-e2e-1', targetId: 'shop-project', agent: 'hermes', cols: 100, rows: 28, hermesVariant: 'codex'});
  expect(variantStart.status).toBe(200);
  const variantSession = variantStart.body.session.id as string;
  expect(await tail(variantSession, /^MODEL:/)).toBe('MODEL:gpt-6.1-sol:openai-codex');
  // The session is read back as that variant through the local path — and nothing was added to the session summary.
  const view = await fetch(`${baseUrl}${HERMES_VARIANTS_PATH}`, {method: 'POST', headers: localHeaders, body: '{}'}).then(r => r.json()) as any;
  // Ended sessions retained by the host keep their exact tab labels too; the team's canonical Hermes preset is recognised.
  expect(view.sessions).toEqual([{sessionId: m2.sessionId, variant: 'claude'}, {sessionId: variantSession, variant: 'codex'}]);
  expect(view.items.map((item: any) => [item.variant, item.provider, item.model])).toEqual([['claude', 'anthropic', 'claude-opus-5-5'], ['codex', 'openai-codex', 'gpt-6.1-sol']]);
  expect(Object.keys(variantStart.body.session)).not.toContain('hermesVariant');
  // Natural MCP chooses the Hermes configuration explicitly. Matching reuse never borrows another provider's CLI.
  const unchosen=await call('start_workroom_session',{portId:'shop-project',agent:'hermes',surface:'internal',requestId:'mcp-hermes-no-choice',foreground:false});
  expect(unchosen).toMatchObject({performed:false,selectionRequired:true,stage:'variant'});
  const mcpCodexArgs={portId:'shop-project',agent:'hermes',surface:'internal',hermesVariant:'codex',requestId:'mcp-hermes-codex',foreground:false};
  const mcpCodex=await call('start_workroom_session',mcpCodexArgs);
  expect(mcpCodex).toMatchObject({success:true,hermesVariant:'codex',reused:false});
  expect(await tail(mcpCodex.session.id,/^MODEL:/)).toBe('MODEL:gpt-6.1-sol:openai-codex');
  const mcpReplay=await call('start_workroom_session',mcpCodexArgs);
  expect(mcpReplay.session.id).toBe(mcpCodex.session.id);
  const changed=await call('start_workroom_session',{...mcpCodexArgs,hermesVariant:'claude'});
  expect(changed.success).toBe(false);
  const mcpClaude=await call('start_workroom_session',{...mcpCodexArgs,requestId:'mcp-hermes-claude',hermesVariant:'claude',reuse:true});
  expect(mcpClaude).toMatchObject({success:true,hermesVariant:'claude',reused:false});
  expect(mcpClaude.session.id).not.toBe(mcpCodex.session.id);
  expect(await tail(mcpClaude.session.id,/^MODEL:/)).toBe('MODEL:claude-opus-5-5:anthropic');
  const reusedClaude=await call('start_workroom_session',{...mcpCodexArgs,requestId:'mcp-hermes-claude-reuse',hermesVariant:'claude',reuse:true});
  expect(reusedClaude).toMatchObject({success:true,hermesVariant:'claude',reused:true,session:{id:mcpClaude.session.id}});
  const mcpDefault=await call('start_workroom_session',{...mcpCodexArgs,requestId:'mcp-hermes-default',hermesVariant:'default',reuse:true});
  expect(mcpDefault).toMatchObject({success:true,hermesVariant:'default',reused:false});
  expect(await tail(mcpDefault.session.id,/^MODEL:/)).toBe('MODEL::');
  for(const id of [mcpCodex.session.id,mcpClaude.session.id,mcpDefault.session.id]){
    expect(await call('close_workroom_session',{portId:'shop-project',sessionId:id,requestId:'mcp-close-'+id,saveMemory:false})).toMatchObject({success:true});
  }
  // The enum is this Mac's start option only: another AI, a restart and an unknown value are all refused.
  for (const body of [
    {operation: 'start', requestId: 'hermes-variant-e2e-2', targetId: 'shop-project', agent: 'codex', cols: 100, rows: 28, hermesVariant: 'codex'},
    {operation: 'start', requestId: 'hermes-variant-e2e-3', targetId: 'shop-project', agent: 'hermes', cols: 100, rows: 28, hermesVariant: 'gpt'},
    {operation: 'start', requestId: 'hermes-variant-e2e-4', targetId: 'shop-project', agent: 'hermes', cols: 100, rows: 28, resumeFrom: variantSession, hermesVariant: 'claude'},
  ]) {
    const refused = await terminal(body);
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toMatch(/Hermes 실행 종류|다시 선택|다시 시작/);
  }
  await terminal({operation: 'close', requestId: 'hermes-variant-e2e-close', sessionId: variantSession});
}, 180_000);
