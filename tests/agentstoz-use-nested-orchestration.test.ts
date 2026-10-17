import {afterEach, expect, test} from 'bun:test';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProjectMemory} from '../project-memory-server';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {startTestApiServer} from './startTestApiServer';

// Nested, model-independent orchestration: an orchestrator CLI running in the OPS Workroom drives a
// worker CLI in another registered project through the real agentstoz_use MCP server (stdio) and the
// real API. Every agent orchestrates every agent, including its own kind: 4 x 4 = 16 pairs.
const AGENTS = ['codex', 'claude', 'hermes', 'agy'] as const;
const dirs: string[] = [], children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

/** One fake per agent name: a worker (echoes its launch prompt and lines) that can also orchestrate. */
function fakeCli(agent: string, data: string): string {
  const client = join(import.meta.dir, 'fixtures', 'workroom-orchestrator-client.ts');
  return `#!/bin/sh
stty -echo
agent='${agent}'
prompt=''; previous=''
for argument in "$@"; do case "$previous" in --|-q|-i) prompt="$argument";; esac; previous="$argument"; done
printf 'READY:%s\\n' "$agent"
[ -n "$prompt" ] && printf 'GOT:%s:%s\\n' "$agent" "$prompt"
while IFS= read -r line; do
  case "$line" in
    'ORCH '*) set -- $line; APP_DATA_DIR='${data}' '${process.execPath}' '${client}' "$2" "$3" "$4" </dev/null;;
    *) printf 'GOT:%s:%s\\n' "$agent" "$line";;
  esac
done
`;
}

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nested-orchestration-'))); dirs.push(home);
  const data = join(home, 'app-data'), ops = join(home, 'AgentsToZ-Control'), worker = join(home, 'projects', 'worker-app');
  mkdirSync(data); mkdirSync(ops); mkdirSync(worker, {recursive: true});
  for (const path of [ops, worker]) expect(Bun.spawnSync(['git', 'init', '-q', path]).success).toBe(true);
  initializeProjectMemory({folderPath: ops, projectName: 'ops-project', autoBackup: false});
  writeFileSync(join(ops, 'CONTROL.md'), '# AgentsToZ OPS fixture\n');
  // The worker project deliberately has no long-term memory.
  writeFileSync(join(data, 'ports.json'), JSON.stringify([
    {id: 'ops-project', name: 'ops-project', folderPath: ops},
    {id: 'worker-project', name: 'worker-app', folderPath: worker},
  ]));
  const bin = join(home, '.local', 'bin'); mkdirSync(bin, {recursive: true});
  for (const agent of AGENTS) { writeFileSync(join(bin, agent), fakeCli(agent, data)); chmodSync(join(bin, agent), 0o755); }
  const env = {...process.env, HOME: home, APP_DATA_DIR: data, NODE_ENV: 'test', AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1',
    AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1', AGENTSTOZ_SKIP_HERMES_SYNC: '1'};
  const {baseUrl, child} = await startTestApiServer({cwd: join(import.meta.dir, '..'), env, entrypoint: 'tests/fixtures/agentstoz-use-api.ts'});
  children.push(child);
  const prepared = await fetch(`${baseUrl}/api/control-profile/prepare`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}).then(r => r.json()) as any;
  expect(prepared.profile).toMatchObject({state: 'ready', backend: 'control-folder'});
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await handleAgentsToZUseMcpRequest({id: 1, method: 'tools/call', params: {name: `agentstoz_use_${name}`, arguments: args}}, {...env, AGENTSTOZ_USE_ENDPOINT: `${baseUrl}/api/agentstoz-use/action`}) as any;
    if (r.result.structuredContent) return r.result.structuredContent as any;
    const error = JSON.parse(r.result.content[0].text);
    return error.data ?? error;
  };
  return {home, ops, worker, call};
}

test('every agent drives every agent through agentstoz_use: 16 nested pairs relay and close their workers', async () => {
  const f = await fixture();
  const run = `${Date.now().toString(36)}`;
  const pairs = await Promise.all(AGENTS.map(async orchestrator => {
    const started = await f.call('start_workroom_session', {target: 'ops', agent: orchestrator, requestId: `orch_start_${orchestrator}_${run}`, foreground: false});
    expect(started).toMatchObject({success: true, target: 'ops', reused: false, openedWorkroom: false, session: {agent: orchestrator, targetId: 'ops-project'}});
    const sessionId: string = started.session.id;
    // wait returns the plain tail itself; an orchestrator stays quiet while it drives a worker.
    const until = async (pattern: RegExp, timeoutMs: number) => {
      let last: any;
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
        last = await f.call('wait_workroom_session', {target: 'ops', sessionId, idleMs: 1_000, timeoutMs: 5_000});
        const line = String(last.text ?? '').split('\n').find(value => pattern.test(value));
        if (line) return line;
      }
      throw new Error(`${orchestrator}: missing ${pattern}: ${JSON.stringify(last)}`);
    };
    await until(new RegExp(`^READY:${orchestrator}$`), 15_000);
    const relays: {orchestrator: string; worker: string; nonce: string; line: string}[] = [];
    for (const worker of AGENTS) {
      const nonce = `n_${orchestrator}_${worker}_${run}`;
      expect(await f.call('send_workroom_instruction', {target: 'ops', sessionId, requestId: `orch_${orchestrator}_${worker}_${run}`, instruction: `ORCH ${worker} worker-project ${nonce}`}))
        .toMatchObject({success: true, target: 'ops'});
      relays.push({orchestrator, worker, nonce, line: await until(new RegExp(`^(RELAY|FAIL):${nonce}`), 60_000)});
    }
    expect(await f.call('close_workroom_session', {target: 'ops', sessionId, requestId: `orch_close_${orchestrator}_${run}`}))
      .toMatchObject({success: true, target: 'ops', memorySave: 'skipped', session: {state: 'exited'}});
    return relays;
  }));
  const relays = pairs.flat();
  expect(relays).toHaveLength(16);
  for (const relay of relays) expect(relay.line).toMatch(new RegExp(`^RELAY:${relay.nonce}:[0-9a-f-]{36}$`));
  const relayedIds = relays.map(relay => relay.line.split(':').at(-1));
  expect(new Set(relayedIds).size).toBe(16);

  // Each relay named its worker; every worker session ran the requested agent in the worker project and is closed.
  const workers = await f.call('list_workroom_sessions', {portId: 'worker-project'});
  expect(workers).toMatchObject({success: true, projectId: 'worker-project', sessionCount: 16});
  const byId = new Map(workers.sessions.map((session: any) => [session.id, session]));
  for (const relay of relays) {
    expect(byId.get(relay.line.split(':').at(-1))).toMatchObject({agent: relay.worker, targetId: 'worker-project', state: 'exited'});
  }
  const orchestrators = await f.call('list_workroom_sessions', {target: 'ops'});
  expect(orchestrators.sessions.map((session: any) => [session.agent, session.state]).sort()).toEqual(AGENTS.map(agent => [agent, 'exited']).sort());
  // Background orchestration never brought the app forward and never created worker memory.
  expect(existsSync(join(f.home, 'dashboard-opens.jsonl'))).toBe(false);
  expect(existsSync(join(f.worker, '.agent-memory'))).toBe(false);
}, 240_000);
