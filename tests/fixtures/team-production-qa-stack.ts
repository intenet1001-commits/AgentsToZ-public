// A disposable 팀 작전 stack for production QA: the real API and MCP server, real Git, and fake CLIs in real Workroom
// PTYs, in a temporary HOME. `restart()` replaces the API process on the same app data, as an app quit and relaunch
// does. Only internal Workrooms are started here: the real API also wires Orca, cmux, Terminal and desktop apps, and
// those would open real windows on this Mac.
//
// POSIX only (TEAM_QA_STACK_SUPPORTED): the fake CLIs are /bin/sh scripts that use stty. On Windows they cannot run,
// and a CLI the stack cannot provide is looked up on PATH — so it refuses to start there instead of failing quietly or
// reaching a real AI.
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {handleAgentsToZUseMcpRequest} from '../../agentstoz-use-mcp-server';
import {initializeProjectMemory} from '../../project-memory-server';
import {AI_TERMINAL_PREFIX} from '../../src/aiTerminalProtocol';
import {startTestApiServer} from '../startTestApiServer';

export const TEAM_QA_STACK_SUPPORTED = process.platform !== 'win32';

const gitEnv = {GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com'};
export const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], {cwd, env: {...process.env, ...gitEnv}});
  if (!result.success) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};

/**
 * Prints what it was started with (cwd, model flags, its own Workroom session), then works and reports on command. Like
 * the real CLIs it turns on bracketed paste, which the Workroom requires before it types a multi-line brief.
 */
function fakeCli(agent: string, data: string, pasteReady = true): string {
  const client = join(import.meta.dir, 'team-member-report-client.ts');
  return `#!/bin/sh
stty -echo
model=''; provider=''; brief=''; previous=''
for argument in "$@"; do case "$previous" in -m|--model) model="$argument";; --provider) provider="$argument";; --|-q|-i) brief="$argument";; esac; previous="$argument"; done
printf '${pasteReady ? '\\033[?2004h' : ''}READY:${agent}\\n'
printf 'CWD:%s\\n' "$(pwd -P)"
printf 'MODEL:%s:%s\\n' "$model" "$provider"
printf 'SESSION:%s\\n' "$AGENTSTOZ_WORKROOM_SESSION_ID"
case "$brief" in *'AgentsToZ 팀 작전 · 팀원'*) printf 'BRIEF:member\\n';; *'AgentsToZ 팀 작전 · 검토 담당'*) printf 'BRIEF:reviewer\\n';; esac
while IFS= read -r line; do
  case "$line" in
    COMMIT) printf 'work\\n' > team-work.txt && git add team-work.txt && git -c user.name=t -c user.email=t@example.com commit -qm 'team work' && printf 'COMMITTED\\n';;
    'REPORT '*) set -- $line; APP_DATA_DIR='${data}' '${process.execPath}' '${client}' "$2" "$3" "$4" </dev/null;;
    *'AgentsToZ 팀 작전 · 팀원'*) printf 'TYPED-BRIEF\\n';;
    *) printf 'GOT:%s\\n' "$line";;
  esac
done
`;
}

export type TeamQaStack = Awaited<ReturnType<typeof startTeamQaStack>>;

/** `notPasteReady`: these CLIs never turn on bracketed paste, as a shell or a sign-in screen does not. */
export async function startTeamQaStack(options: {agents?: string[]; notPasteReady?: string[]} = {}) {
  if (!TEAM_QA_STACK_SUPPORTED) throw new Error('team-production-qa-stack is POSIX-only: its fake CLIs are /bin/sh scripts using stty.');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'team-production-qa-')));
  const data = join(home, 'app-data'), project = join(home, 'projects', 'shop'), ops = join(home, 'AgentsToZ-Control');
  mkdirSync(data); mkdirSync(project, {recursive: true}); mkdirSync(ops);
  git(ops, 'init', '-q'); initializeProjectMemory({folderPath: ops, projectName: 'ops-project', autoBackup: false}); writeFileSync(join(ops, 'CONTROL.md'), '# OPS fixture\n');
  git(project, 'init', '-q', '-b', 'main'); writeFileSync(join(project, 'app.txt'), 'v1\n'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'init');
  writeFileSync(join(data, 'ports.json'), JSON.stringify([{id: 'ops-project', name: 'ops-project', folderPath: ops}, {id: 'shop-project', name: 'shop', folderPath: project}]));
  const bin = join(home, '.local', 'bin'); mkdirSync(bin, {recursive: true});
  for (const agent of options.agents ?? ['codex', 'claude', 'hermes', 'agy']) { writeFileSync(join(bin, agent), fakeCli(agent, data, !options.notPasteReady?.includes(agent))); chmodSync(join(bin, agent), 0o755); }
  // A CLI missing from this HOME is looked up with `which` (api-server resolveLocalExecutable): with the user's own
  // PATH that finds the real installed AI and would start it. Only system folders and Bun stay on PATH, and the stack
  // refuses to start if a real agent CLI is still reachable there.
  const path = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  for (const agent of ['codex', 'claude', 'hermes', 'agy']) {
    const reachable = Bun.which(agent, {PATH: path});
    if (reachable) throw new Error(`a real ${agent} CLI is reachable on the sanitized PATH (${reachable}); refusing to start the QA stack`);
  }
  const env: Record<string, string | undefined> = {...process.env, PATH: path, HOME: home, APP_DATA_DIR: data, NODE_ENV: 'test', AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1', AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1', AGENTSTOZ_SKIP_HERMES_SYNC: '1'};
  const entry = {cwd: join(import.meta.dir, '..', '..'), env, entrypoint: 'tests/fixtures/agentstoz-use-api.ts'};
  let server = await startTestApiServer(entry);
  const prepared = await fetch(`${server.baseUrl}/api/control-profile/prepare`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}).then(r => r.json()) as any;
  if (prepared.profile?.state !== 'ready') throw new Error(`control profile: ${JSON.stringify(prepared).slice(0, 300)}`);

  /** An MCP tool call as an AI outside any Workroom would make it, or — with `caller` — from inside that Workroom. */
  const call = async (name: string, args: Record<string, unknown> = {}, caller?: {sessionId: string; targetId: string}) => {
    const callerEnv = caller ? {AGENTSTOZ_WORKROOM_SESSION_ID: caller.sessionId, AGENTSTOZ_WORKROOM_TARGET_ID: caller.targetId} : {};
    const r = await handleAgentsToZUseMcpRequest({id: 1, method: 'tools/call', params: {name: `agentstoz_use_${name}`, arguments: args}},
      {...env, ...callerEnv, AGENTSTOZ_USE_ENDPOINT: `${server.baseUrl}/api/agentstoz-use/action`}) as any;
    if (r.result?.structuredContent) return r.result.structuredContent as any;
    const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
    try { const error = JSON.parse(text); return error.data ?? error; } catch { return {isError: true, text}; }
  };
  /** This Mac's own window: the local terminal route the Workroom panel uses (start, 다시 시작, list, close). */
  const terminal = async (body: Record<string, unknown>) => {
    const response = await fetch(`${server.baseUrl}${AI_TERMINAL_PREFIX}`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'http://tauri.localhost'}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json() as any};
  };
  let listed = 0;
  const running = async (): Promise<Array<{id: string; targetId: string; agent: string}>> => {
    const result = await terminal({operation: 'list', requestId: `qa-list-${++listed}`});
    return (result.body.sessions ?? []).filter((session: any) => session.state === 'running');
  };
  /** The whole PTY transcript so far, read through the same MCP wait the leader uses, until `pattern` appears. */
  const tail = async (sessionId: string, pattern: RegExp, timeoutMs = 30_000) => {
    let last = '';
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
      const waited = await call('wait_workroom_session', {portId: 'shop-project', sessionId, idleMs: 1_000, timeoutMs: 4_000});
      last = String(waited.text ?? '');
      const line = last.split('\n').find(value => pattern.test(value));
      if (line) return {line, text: last};
    }
    throw new Error(`missing ${pattern} in ${sessionId}: ${last.slice(-600)}`);
  };
  const worktrees = () => (git(project, 'worktree', 'list', '--porcelain').match(/^worktree .+$/gm) ?? []).map(line => line.slice(9));
  const teamBranches = () => git(project, 'branch', '--list', 'team/*').split('\n').map(line => line.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
  /** The app quits (its API process ends) and opens again on the same app data and ledger. */
  const restart = async () => {
    server.child.kill(); await server.child.exited;
    server = await startTestApiServer(entry);
  };
  const stop = async () => {
    server.child.kill(); await server.child.exited;
    rmSync(home, {recursive: true, force: true});
  };
  return {home, data, project, bin, env, call, terminal, running, tail, worktrees, teamBranches, restart, stop, get baseUrl() { return server.baseUrl; }};
}
