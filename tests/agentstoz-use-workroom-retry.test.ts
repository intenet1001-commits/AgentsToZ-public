import {afterAll, beforeAll, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProjectMemory} from '../project-memory-server';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {WORKROOM_WAIT_CLIENT_MARGIN_MS, WORKROOM_WAIT_RENDER_ALLOWANCE_MS} from '../src/workroomOrchestration';
import {startTestApiServer} from './startTestApiServer';

// Retries of one agentstoz_use request must never act twice, whatever happened to the Workroom
// sessions in between (review 2026-09-29, findings 1, 5, 10 and 11). Real isolated API, real PTYs.
const FAKES: Record<string, string> = {
  // Line CLI: echoes its launch prompt and every line.
  codex: `#!/bin/sh
stty -echo
prompt=''; previous=''
for argument in "$@"; do case "$previous" in --|-q|-i) prompt="$argument";; esac; previous="$argument"; done
printf 'READY:codex\\n'
[ -n "$prompt" ] && printf 'GOT:codex:%s\\n' "$prompt"
while IFS= read -r line; do printf 'GOT:codex:%s\\n' "$line"; done
`,
  // Raw key CLI: prints every byte as hex; an "x" switches it to application cursor keys (DECCKM).
  agy: `#!/bin/sh
stty raw -echo
printf 'KEYS_READY\\r\\n'
while :; do
  byte=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n')
  [ -n "$byte" ] || exit 0
  printf 'KEY:%s\\r\\n' "$byte"
  [ "$byte" = 78 ] && printf '\\033[?1hMODE:app\\r\\n'
done
`,
  // Says its last words and exits at once.
  hermes: `#!/bin/sh
printf 'LAST-WORDS\\n'
`,
};

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); }, 60_000);
afterAll(async () => {
  f?.child.kill(); await f?.child.exited;
  if (f) rmSync(f.home, {recursive: true, force: true});
}, 30_000); // The API's graceful shutdown with many PTYs can take longer than the 5 s hook default.

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workroom-retry-')));
  const data = join(home, 'app-data'), ops = join(home, 'AgentsToZ-Control'), plain = join(home, 'projects', 'plain-app');
  mkdirSync(data); mkdirSync(ops); mkdirSync(plain, {recursive: true});
  for (const path of [ops, plain]) expect(Bun.spawnSync(['git', 'init', '-q', path]).success).toBe(true);
  initializeProjectMemory({folderPath: ops, projectName: 'ops-project', autoBackup: false});
  writeFileSync(join(ops, 'CONTROL.md'), '# AgentsToZ OPS fixture\n');
  writeFileSync(join(data, 'ports.json'), JSON.stringify([
    {id: 'ops-project', name: 'ops-project', folderPath: ops},
    {id: 'plain-project', name: 'plain-app', folderPath: plain},
  ]));
  const bin = join(home, '.local', 'bin'); mkdirSync(bin, {recursive: true});
  for (const [agent, script] of Object.entries(FAKES)) { writeFileSync(join(bin, agent), script); chmodSync(join(bin, agent), 0o755); }
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
  const until = async (sessionId: string, text: string) => {
    let last: any;
    for (const deadline = Date.now() + 8_000; Date.now() < deadline; await Bun.sleep(40)) {
      last = await call('read_workroom_session', {portId: 'plain-project', sessionId});
      if (typeof last.text === 'string' && last.text.includes(text)) return last;
    }
    throw new Error(`Missing ${text}: ${JSON.stringify(last)}`);
  };
  const occurrences = async (sessionId: string, text: string) => {
    const read = await call('read_workroom_session', {portId: 'plain-project', sessionId});
    return String(read.text).split(text).length - 1;
  };
  const sessions = async () => (await call('list_workroom_sessions', {portId: 'plain-project'})).sessions as any[];
  return {home, child, call, until, occurrences, sessions};
}

test('B1: a retried reuse start goes back to the session it continued, even after another session appears', async () => {
  const a = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'retry_start_a_123', foreground: false})).session.id;
  await f.until(a, 'READY:codex');
  const same = {portId: 'plain-project', agent: 'codex', requestId: 'retry_reuse_12345', reuse: true, foreground: false, instruction: 'ONCE-ONLY'};
  expect(await f.call('start_workroom_session', same)).toMatchObject({success: true, reused: true, session: {id: a}, instruction: {delivered: true, via: 'input'}});
  await f.until(a, 'GOT:codex:ONCE-ONLY');
  // Another codex session of the same project appears (the user opened one, or another orchestrator did).
  const b = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'retry_start_b_123', foreground: false})).session.id;
  await f.until(b, 'READY:codex');
  const retried = await f.call('start_workroom_session', same);
  expect(retried).toMatchObject({success: true, reused: true, session: {id: a}});
  const quietB = await f.call('wait_workroom_session', {portId: 'plain-project', sessionId: b, idleMs: 1_000, timeoutMs: 5_000});
  expect(quietB.text).not.toContain('ONCE-ONLY');
  expect(await f.occurrences(a, 'GOT:codex:ONCE-ONLY')).toBe(1);
  // The same requestId cannot be reused for a different request.
  expect(await f.call('start_workroom_session', {...same, instruction: 'SOMETHING-ELSE'})).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_REQUEST_ID_CONFLICT'});
  expect(await f.call('start_workroom_session', {...same, reuse: false})).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_REQUEST_ID_CONFLICT'});

  // Once the recorded session has ended, a retry reports the unknown outcome and starts nothing.
  await f.call('close_workroom_session', {portId: 'plain-project', sessionId: a, requestId: 'retry_close_a_123'});
  const before = (await f.sessions()).length;
  const ended = await f.call('start_workroom_session', same);
  expect(ended).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_REUSE_OUTCOME_UNKNOWN', sessionId: a});
  await f.call('close_workroom_session', {portId: 'plain-project', sessionId: b, requestId: 'retry_close_b_123'});
  expect(await f.call('start_workroom_session', same)).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_REUSE_OUTCOME_UNKNOWN'});
  const after = await f.sessions();
  expect(after.length).toBe(before);
  expect(after.filter(session => session.state === 'running' && session.agent === 'codex')).toEqual([]);
}, 60_000);

test('B1: two identical reuse calls in flight type the instruction once into one session', async () => {
  const a = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'race_start_a_1234', foreground: false})).session.id;
  await f.until(a, 'READY:codex');
  const same = {portId: 'plain-project', agent: 'codex', requestId: 'race_reuse_123456', reuse: true, foreground: false, instruction: 'RACE-ONCE'};
  const [first, second] = await Promise.all([f.call('start_workroom_session', same), f.call('start_workroom_session', same)]);
  expect(first).toMatchObject({success: true, reused: true, session: {id: a}});
  expect(second).toMatchObject({success: true, reused: true, session: {id: a}});
  await f.until(a, 'GOT:codex:RACE-ONCE');
  await f.call('wait_workroom_session', {portId: 'plain-project', sessionId: a, idleMs: 1_000, timeoutMs: 5_000});
  expect(await f.occurrences(a, 'GOT:codex:RACE-ONCE')).toBe(1);
  await f.call('close_workroom_session', {portId: 'plain-project', sessionId: a, requestId: 'race_close_a_1234'});
}, 30_000);

test('B10: a key retry replays the bytes chosen first, even after the CLI changed its cursor-key mode', async () => {
  const id = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'agy', requestId: 'keys_retry_start', foreground: false})).session.id;
  await f.until(id, 'KEYS_READY');
  const down = {portId: 'plain-project', sessionId: id, requestId: 'keys_retry_down1', keys: ['down']};
  expect(await f.call('send_workroom_keys', down)).toMatchObject({success: true, keys: ['down']});
  await f.until(id, 'KEY:42');
  // The CLI turns on application cursor keys between the attempt and its retry.
  await f.call('send_workroom_instruction', {portId: 'plain-project', sessionId: id, requestId: 'keys_retry_mode1', instruction: 'x'});
  await f.until(id, 'MODE:app');
  expect(await f.call('send_workroom_keys', down)).toMatchObject({success: true, keys: ['down']});
  expect(await f.call('send_workroom_keys', {...down, keys: ['up']})).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_REQUEST_ID_CONFLICT'});
  // A new request does follow the new mode.
  expect(await f.call('send_workroom_keys', {...down, requestId: 'keys_retry_down2'})).toMatchObject({success: true});
  await f.until(id, 'KEY:4f\nKEY:42');
  const bytes = [...String((await f.call('wait_workroom_session', {portId: 'plain-project', sessionId: id, idleMs: 1_000, timeoutMs: 5_000})).text).matchAll(/KEY:([0-9a-f]{2})/g)].map(match => match[1]);
  // down (normal mode), x + Enter, then down in application mode — nothing typed twice.
  expect(bytes).toEqual(['1b', '5b', '42', '78', '0d', '1b', '4f', '42']);
  await f.call('close_workroom_session', {portId: 'plain-project', sessionId: id, requestId: 'keys_retry_close'});
}, 30_000);

test('B5: a wait answers within its timeout counted from the request, leaving time to render', async () => {
  const id = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'budget_start_1234', foreground: false})).session.id;
  await f.until(id, 'READY:codex');
  const started = Date.now();
  const waited = await f.call('wait_workroom_session', {portId: 'plain-project', sessionId: id, idleMs: 20_000, timeoutMs: 4_000});
  const elapsed = Date.now() - started;
  expect(waited).toMatchObject({success: true, waitResult: 'timeout', state: 'running'});
  // The host's own wait ends a render allowance before timeoutMs counted from arrival (was the full 4,000 ms)…
  expect(waited.waitedMs).toBeLessThanOrEqual(4_000 - WORKROOM_WAIT_RENDER_ALLOWANCE_MS + 300);
  // …so the answer reaches the MCP client well inside the budget it waits for.
  expect(elapsed).toBeLessThan(4_000 + WORKROOM_WAIT_CLIENT_MARGIN_MS);
  await f.call('close_workroom_session', {portId: 'plain-project', sessionId: id, requestId: 'budget_close_1234'});
}, 30_000);

test('B11: read and wait on a session pruned after it exited answer exited with its last output', async () => {
  const retired = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'hermes', requestId: 'prune_target_1234', foreground: false})).session.id;
  expect(await f.call('wait_workroom_session', {portId: 'plain-project', sessionId: retired, idleMs: 20_000, timeoutMs: 10_000})).toMatchObject({waitResult: 'exited'});
  // A start whose answer timed out (a loaded machine) is uncertain: the documented recovery is the
  // same requestId again, which replays that start instead of opening a second session.
  const startFiller = async (index: number): Promise<string> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = await f.call('start_workroom_session', {portId: 'plain-project', agent: 'hermes', requestId: `prune_fill_${index}_1234`, foreground: false});
      if (started.session) return started.session.id;
      if (!/timed? ?out|abort/i.test(String(started.error))) throw new Error(`filler ${index} did not start: ${JSON.stringify(started)}`);
    }
    throw new Error(`filler ${index} kept timing out`);
  };
  // Start quickly-exiting sessions in batches (at most 12 may run) until the live list no longer
  // holds it: more than 24 sessions prune the oldest exited ones.
  for (let batch = 0; batch < 5 && (await f.sessions()).some(session => session.id === retired); batch++) {
    const fillers: string[] = [];
    for (let index = 0; index < 8; index++) fillers.push(await startFiller(batch * 8 + index));
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; await Bun.sleep(100)) {
      const listed = await f.sessions();
      if (fillers.every(id => listed.find(session => session.id === id)?.state !== 'running')) break;
    }
  }
  expect((await f.sessions()).some(session => session.id === retired)).toBe(false);
  expect(await f.call('read_workroom_session', {portId: 'plain-project', sessionId: retired})).toMatchObject({success: true, view: 'tail', state: 'exited', text: 'LAST-WORDS'});
  const waited = await f.call('wait_workroom_session', {portId: 'plain-project', sessionId: retired, idleMs: 20_000, timeoutMs: 30_000});
  expect(waited).toMatchObject({success: true, waitResult: 'exited', state: 'exited', text: 'LAST-WORDS'});
  expect(waited.waitedMs).toBeLessThan(1_000);
  const stream = await f.call('read_workroom_session', {portId: 'plain-project', sessionId: retired, after: 0});
  expect(stream).toMatchObject({success: true, view: 'stream', state: 'exited'});
  expect(stream.chunks.map((chunk: any) => chunk.text).join('')).toContain('LAST-WORDS');
  // Only read and wait fall back; instructing a pruned session is still "not found".
  expect(await f.call('send_workroom_instruction', {portId: 'plain-project', sessionId: retired, requestId: 'prune_send_12345', instruction: 'late'})).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_SESSION_NOT_FOUND'});
  // Another project's retired session is not visible here.
  expect(await f.call('read_workroom_session', {target: 'ops', sessionId: retired})).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_SESSION_NOT_FOUND'});
}, 120_000);
