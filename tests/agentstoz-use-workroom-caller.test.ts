import {afterAll, beforeAll, expect, test} from 'bun:test';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProjectMemory} from '../project-memory-server';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {CONTROL_PROFILE_CONTROLLER, CONTROL_PROFILE_HEADER} from '../src/controlProfileContract';
import {readControlProfileAccess} from '../src/controlProfileStore';
import {AGENTSTOZ_CALLER_SESSION_HEADER, AGENTSTOZ_CALLER_TARGET_HEADER} from '../src/workroomCaller';
import {startTestApiServer} from './startTestApiServer';

// The user's own example: the OPS Workroom runs Antigravity (agy), and that agy orchestrates another
// agy Workroom in the same OPS project. The host must tell the calling session from the worker.
const client = join(import.meta.dir, 'fixtures', 'workroom-mcp-script-client.ts');
function fakeCli(agent: string, data: string): string {
  return `#!/bin/sh
stty -echo
agent='${agent}'
prompt=''; previous=''
for argument in "$@"; do case "$previous" in --|-q|-i) prompt="$argument";; esac; previous="$argument"; done
printf 'READY:%s\\n' "$agent"
[ -n "$prompt" ] && printf 'GOT:%s:%s\\n' "$agent" "$prompt"
while IFS= read -r line; do
  case "$line" in
    'SCRIPT '*) APP_DATA_DIR='${data}' '${process.execPath}' '${client}' "\${line#SCRIPT }" </dev/null; printf 'SCRIPTED\\n';;
    *) printf 'GOT:%s:%s\\n' "$agent" "$line";;
  esac
done
`;
}

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); }, 60_000);
afterAll(async () => {
  f?.child.kill(); await f?.child.exited;
  if (f) rmSync(f.home, {recursive: true, force: true});
}, 30_000); // The API's graceful shutdown with PTYs can take longer than the 5 s hook default.

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workroom-caller-')));
  const data = join(home, 'app-data'), ops = join(home, 'AgentsToZ-Control');
  mkdirSync(data); mkdirSync(ops);
  expect(Bun.spawnSync(['git', 'init', '-q', ops]).success).toBe(true);
  initializeProjectMemory({folderPath: ops, projectName: 'ops-project', autoBackup: false});
  writeFileSync(join(ops, 'CONTROL.md'), '# AgentsToZ OPS fixture\n');
  writeFileSync(join(data, 'ports.json'), JSON.stringify([{id: 'ops-project', name: 'ops-project', folderPath: ops}]));
  const bin = join(home, '.local', 'bin'); mkdirSync(bin, {recursive: true});
  for (const agent of ['codex', 'claude', 'hermes', 'agy']) { writeFileSync(join(bin, agent), fakeCli(agent, data)); chmodSync(join(bin, agent), 0o755); }
  const env = {...process.env, HOME: home, APP_DATA_DIR: data, NODE_ENV: 'test', AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1',
    AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1', AGENTSTOZ_SKIP_HERMES_SYNC: '1', AGENTSTOZ_TEST_SURFACE_LOG: '1'};
  const {baseUrl, child} = await startTestApiServer({cwd: join(import.meta.dir, '..'), env, entrypoint: 'tests/fixtures/ops-surface-api.ts'});
  const prepared = await fetch(`${baseUrl}/api/control-profile/prepare`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}).then(r => r.json()) as any;
  expect(prepared.profile).toMatchObject({state: 'ready', backend: 'control-folder'});
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await handleAgentsToZUseMcpRequest({id: 1, method: 'tools/call', params: {name: `agentstoz_use_${name}`, arguments: args}}, {...env, AGENTSTOZ_USE_ENDPOINT: `${baseUrl}/api/agentstoz-use/action`}) as any;
    if (r.result.structuredContent) return r.result.structuredContent as any;
    const error = JSON.parse(r.result.content[0].text);
    return error.data ?? error;
  };
  const post = async (body: Record<string, unknown>, extraHeaders: Record<string, string>) => {
    const response = await fetch(`${baseUrl}/api/agentstoz-use/action`, {method: 'POST',
      headers: {'Content-Type': 'application/json', [CONTROL_PROFILE_HEADER]: readControlProfileAccess(data)!.token, ...extraHeaders},
      body: JSON.stringify({controllerPortId: CONTROL_PROFILE_CONTROLLER, ...body})});
    return {status: response.status, body: await response.json() as any};
  };
  const until = async (sessionId: string, text: string) => {
    let last: any;
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(40)) {
      last = await call('read_workroom_session', {target: 'ops', sessionId});
      if (typeof last.text === 'string' && last.text.includes(text)) return last;
    }
    throw new Error(`Missing ${text}: ${JSON.stringify(last)}`);
  };
  /** Runs MCP calls from inside the Workroom session `sessionId` and returns each result. */
  const runInside = async (sessionId: string, name: string, calls: {name: string; args: Record<string, unknown>}[]) => {
    const script = join(home, `${name}.json`);
    writeFileSync(script, JSON.stringify(calls));
    expect(await call('send_workroom_instruction', {target: 'ops', sessionId, requestId: `run_${name}_12345`, instruction: `SCRIPT ${script}`})).toMatchObject({success: true});
    for (const deadline = Date.now() + 30_000; Date.now() < deadline && !existsSync(`${script}.done`); await Bun.sleep(50)) { /* the client is working */ }
    const lines = existsSync(`${script}.out.jsonl`) ? readFileSync(`${script}.out.jsonl`, 'utf8').trim().split('\n').filter(Boolean) : [];
    return lines.map(line => JSON.parse(line) as {name: string; isError: boolean; payload: any});
  };
  return {home, child, call, post, until, runInside};
}

test('B2: an agy OPS orchestrator never reuses, keys, instructs or closes its own Workroom session', async () => {
  const self = (await f.call('start_workroom_session', {target: 'ops', agent: 'agy', requestId: 'caller_orchestrator', foreground: false})).session.id;
  await f.until(self, 'READY:agy');
  const results = await f.runInside(self, 'self-check', [
    {name: 'list_workroom_sessions', args: {target: 'ops'}},
    {name: 'start_workroom_session', args: {target: 'ops', agent: 'agy', reuse: true, requestId: 'caller_reuse_1234', instruction: 'SELF-CHECK', foreground: false}},
    {name: 'read_workroom_session', args: {target: 'ops', sessionId: self}},
    {name: 'send_workroom_keys', args: {target: 'ops', sessionId: self, requestId: 'caller_keys_1234', keys: ['enter']}},
    {name: 'send_workroom_instruction', args: {target: 'ops', sessionId: self, requestId: 'caller_send_1234', instruction: 'SELF-SEND'}},
    {name: 'close_workroom_session', args: {target: 'ops', sessionId: self, requestId: 'caller_close_1234'}},
  ]);
  expect(results.map(result => result.name)).toEqual(['list_workroom_sessions', 'start_workroom_session', 'read_workroom_session', 'send_workroom_keys', 'send_workroom_instruction', 'close_workroom_session']);
  const [listed, started, read, keys, sent, closed] = results;
  // Listed with self:true, and only itself.
  expect(listed!.payload.sessions.find((session: any) => session.id === self)).toMatchObject({self: true, agent: 'agy', state: 'running'});
  expect(listed!.payload.sessions.filter((session: any) => session.self)).toHaveLength(1);
  // reuse=true leaves the caller out: a second agy session starts with the instruction as its first prompt.
  expect(started!.isError).toBe(false);
  expect(started!.payload).toMatchObject({success: true, reused: false, instruction: {delivered: true, via: 'launch-prompt'}, session: {agent: 'agy', targetId: 'ops-project'}});
  const worker = started!.payload.session.id as string;
  expect(worker).not.toBe(self);
  // Reading itself is harmless; typing into or closing itself is refused with a clear code.
  expect(read!.payload).toMatchObject({success: true, state: 'running'});
  for (const refused of [keys!, sent!, closed!]) {
    expect(refused.isError).toBe(true);
    expect(refused.payload.data).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_SELF_TARGET'});
  }
  await f.until(self, 'SCRIPTED');
  const own = await f.call('wait_workroom_session', {target: 'ops', sessionId: self, idleMs: 1_000, timeoutMs: 5_000});
  expect(own.state).toBe('running');
  expect(own.text).not.toContain('SELF-CHECK');
  expect(own.text).not.toContain('SELF-SEND');
  await f.until(worker, 'GOT:agy:SELF-CHECK');
  for (const [sessionId, requestId] of [[worker, 'caller_close_worker'], [self, 'caller_close_self']]) {
    expect(await f.call('close_workroom_session', {target: 'ops', sessionId, requestId})).toMatchObject({success: true, session: {state: 'exited'}});
  }
}, 90_000);

test('B2: the Workroom environment hint alone also marks and protects the caller, but only for its own target', async () => {
  const self = (await f.call('start_workroom_session', {target: 'ops', agent: 'codex', requestId: 'hint_self_123456', foreground: false})).session.id;
  await f.until(self, 'READY:codex');
  const hint = {[AGENTSTOZ_CALLER_SESSION_HEADER]: self, [AGENTSTOZ_CALLER_TARGET_HEADER]: 'ops-project'};
  const listed = await f.post({action: 'list-workroom-sessions', target: 'ops'}, hint);
  expect(listed.body.sessions.find((session: any) => session.id === self)).toMatchObject({self: true});
  expect(await f.post({action: 'close-workroom-session', target: 'ops', sessionId: self, requestId: 'hint_close_12345'}, hint))
    .toMatchObject({status: 409, body: {success: false, code: 'AGENTSTOZ_USE_WORKROOM_SELF_TARGET'}});
  // A hint naming another target is not this session: nothing is marked.
  const mismatched = await f.post({action: 'list-workroom-sessions', target: 'ops'}, {...hint, [AGENTSTOZ_CALLER_TARGET_HEADER]: 'another-target-1'});
  expect(mismatched.body.sessions.some((session: any) => session.self)).toBe(false);
  // Without a hint the same close is an ordinary close.
  expect(await f.post({action: 'close-workroom-session', target: 'ops', sessionId: self, requestId: 'hint_close_67890'}, {}))
    .toMatchObject({status: 200, body: {success: true, session: {state: 'exited'}}});
}, 30_000);
