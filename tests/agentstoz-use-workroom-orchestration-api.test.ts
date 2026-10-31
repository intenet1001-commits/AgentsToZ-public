import {afterAll, beforeAll, expect, test} from 'bun:test';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProjectMemory} from '../project-memory-server';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {CONTROL_PROFILE_CONTROLLER, CONTROL_PROFILE_HEADER} from '../src/controlProfileContract';
import {readControlProfileAccess} from '../src/controlProfileStore';
import {startTestApiServer} from './startTestApiServer';

// One real API for the file: a registered OPS Control folder and a registered project WITHOUT
// long-term memory. Each fake CLI plays one role so every host path meets a real PTY.
const FAKES: Record<string, string> = {
  // Line CLI: colored banner, echoes its launch prompt and every line.
  codex: `#!/bin/sh
stty -echo
prompt=''; previous=''
for argument in "$@"; do case "$previous" in --|-q|-i) prompt="$argument";; esac; previous="$argument"; done
printf '\\033[1;32mREADY\\033[0m:codex\\n'
[ -n "$prompt" ] && printf 'GOT:codex:%s\\n' "$prompt"
while IFS= read -r line; do printf 'GOT:codex:%s\\n' "$line"; done
`,
  // Paste-aware CLI (DECSET 2004): ESC is printed as ^ so paste brackets are visible.
  claude: `#!/bin/sh
stty -echo
printf '\\033[?2004hREADY:claude\\n'
while IFS= read -r line; do printf 'GOT:claude:%s\\n' "$line" | tr '\\033' '^'; done
`,
  // Raw key CLIs print every received byte as hex; agy asks for application cursor keys.
  hermes: rawKeys(''),
  agy: rawKeys('\\033[?1h'),
};
function rawKeys(mode: string) {
  return `#!/bin/sh
stty raw -echo
printf '${mode}KEYS_READY\\r\\n'
if [ -f "$HOME/exit-screen" ]; then
  if [ "$(cat "$HOME/exit-screen")" = redraw ] || [ "$(cat "$HOME/exit-screen")" = delayed ] || [ "$(cat "$HOME/exit-screen")" = unchanged ]; then printf '❯ 1. Yes\\r\\n';
  elif [ "$(cat "$HOME/exit-screen")" = blank ]; then printf '\\033[2J\\033[H';
  else printf '❯ 2. No, exit\\r\\n'; fi
fi
while :; do
  byte=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n')
  [ -n "$byte" ] || exit 0
  printf 'KEY:%s\\r\\n' "$byte"
  if [ "$byte" = 42 ]; then
    if [ ! -f "$HOME/exit-screen" ]; then printf '❯ 1. Yes\\r\\n';
    elif [ "$(cat "$HOME/exit-screen")" = redraw ]; then printf '\\033[2J\\033[H❯ 2. No, exit\\r\\n';
    elif [ "$(cat "$HOME/exit-screen")" = delayed ]; then sleep 1; printf '\\033[2J\\033[H❯ 2. No, exit\\r\\n'; fi
  fi
done
`;
}

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); }, 60_000);
afterAll(async () => {
  f?.child.kill(); await f?.child.exited;
  if (f) rmSync(f.home, {recursive: true, force: true});
});

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workroom-orchestration-api-')));
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
  const post = async (body: unknown) => {
    const response = await fetch(`${baseUrl}/api/agentstoz-use/action`, {method: 'POST', headers: {'Content-Type': 'application/json', [CONTROL_PROFILE_HEADER]: readControlProfileAccess(data)!.token}, body: JSON.stringify({controllerPortId: CONTROL_PROFILE_CONTROLLER, ...body as object})});
    return {status: response.status, body: await response.json() as any};
  };
  const prepared = await fetch(`${baseUrl}/api/control-profile/prepare`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}).then(r => r.json()) as any;
  expect(prepared.profile).toMatchObject({state: 'ready', backend: 'control-folder'});
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    // These journeys explicitly choose a Workroom or desktop app; undecided-choice gates are tested separately.
    const chosen = name === 'start_workroom_session' || name === 'open_code_app'
      ? {surface: name === 'start_workroom_session' ? 'internal' : 'app', ...(args.agent === 'hermes' ? {hermesVariant: 'default'} : {}), ...args}
      : args;
    const r = await handleAgentsToZUseMcpRequest({id: 1, method: 'tools/call', params: {name: `agentstoz_use_${name}`, arguments: chosen}}, {...env, AGENTSTOZ_USE_ENDPOINT: `${baseUrl}/api/agentstoz-use/action`}) as any;
    if (r.result.structuredContent) return r.result.structuredContent as any;
    const error = JSON.parse(r.result.content[0].text);
    return error.data ?? error;
  };
  /** Reads the default (tail) view until it shows `text`. */
  const until = async (portId: string, sessionId: string, text: string) => {
    let last: any;
    for (const deadline = Date.now() + 8_000; Date.now() < deadline; await Bun.sleep(40)) {
      last = await call('read_workroom_session', {portId, sessionId});
      if (typeof last.text === 'string' && last.text.includes(text)) return last;
    }
    throw new Error(`Missing ${text}: ${JSON.stringify(last)}`);
  };
  const launches = () => existsSync(join(home, 'surface-launches.jsonl')) ? readFileSync(join(home, 'surface-launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return {home, data, ops, plain, baseUrl, child, post, call, until, launches};
}

test('a registered project without long-term memory can use Workroom tools and app launches; only Buzz needs memory', async () => {
  expect(existsSync(join(f.plain, '.agent-memory'))).toBe(false);
  expect(await f.call('project_status', {portId: 'plain-project'})).toMatchObject({
    success: true, project: {projectId: 'plain-project', memoryId: null, memory: {initialized: false}, buzzDev: {connected: false}},
  });
  const opened = await f.call('open_code_app', {portId: 'plain-project', agent: 'claude'});
  expect(opened).toMatchObject({success: true, projectId: 'plain-project', projectName: 'plain-app'});
  expect(realpathSync(f.launches().at(-1).body.folderPath)).toBe(f.plain);
  expect(JSON.stringify(opened)).not.toContain(f.home);
  expect(await f.call('list_workroom_sessions', {portId: 'plain-project'})).toMatchObject({success: true, projectId: 'plain-project', sessionCount: 0});
  expect(await f.call('open_buzz_dev', {portId: 'plain-project'})).toMatchObject({success: false, code: 'PROJECT_MEMORY_NOT_INITIALIZED'});
  expect(existsSync(join(f.plain, '.agent-memory'))).toBe(false);
}, 30_000);

test('start submits an initial instruction in the background and reuse continues the same agent exactly once', async () => {
  const first = await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'reuse_first_1234', instruction: '첫 지시', foreground: false});
  expect(first).toMatchObject({success: true, effect: 'started-workroom-session', reused: false, foreground: false, openedWorkroom: false,
    navigationWarning: null, instruction: {delivered: true, via: 'launch-prompt'}, session: {agent: 'codex', state: 'running', targetId: 'plain-project'}});
  const id = first.session.id;
  await f.until('plain-project', id, 'GOT:codex:첫 지시');
  const again = await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'reuse_again_1234', reuse: true, foreground: false});
  expect(again).toMatchObject({success: true, effect: 'reused-workroom-session', reused: true, instruction: null, session: {id}});
  const more = {portId: 'plain-project', agent: 'codex', requestId: 'reuse_more_12345', reuse: true, foreground: false, instruction: '이어서 진행'};
  expect(await f.call('start_workroom_session', more)).toMatchObject({reused: true, session: {id}, instruction: {delivered: true, via: 'input'}});
  expect(await f.call('start_workroom_session', more)).toMatchObject({reused: true, session: {id}}); // a retry never types twice
  // Replaying the original start ID (even with reuse) returns that start, not a second prompt.
  expect(await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'reuse_first_1234', instruction: '첫 지시', foreground: false, reuse: true}))
    .toMatchObject({success: true, reused: false, session: {id}});
  await f.until('plain-project', id, 'GOT:codex:이어서 진행');
  const settled = await f.call('wait_workroom_session', {portId: 'plain-project', sessionId: id, idleMs: 1_000, timeoutMs: 10_000});
  expect(settled.text.match(/GOT:codex:이어서 진행/g)).toHaveLength(1);
  expect(settled.text.match(/GOT:codex:첫 지시/g)).toHaveLength(1);
  const tooLarge = await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'reuse_large_1234', reuse: true, foreground: false, instruction: '가'.repeat(1_400)});
  expect(tooLarge).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_INSTRUCTION_TOO_LARGE'});
  const claude = await f.call('start_workroom_session', {portId: 'plain-project', agent: 'claude', requestId: 'reuse_claude_1234', reuse: true, foreground: false});
  expect(claude).toMatchObject({success: true, reused: false, session: {agent: 'claude'}});
  expect(claude.session.id).not.toBe(id);
  const listed = await f.call('list_workroom_sessions', {portId: 'plain-project'});
  expect(listed.sessions.filter((s: any) => s.state === 'running').map((s: any) => s.agent).sort()).toEqual(['claude', 'codex']);
  expect(existsSync(join(f.home, 'dashboard-opens.jsonl'))).toBe(false);
  for (const [sessionId, requestId] of [[id, 'reuse_close_codex'], [claude.session.id, 'reuse_close_claude']]) {
    expect(await f.call('close_workroom_session', {portId: 'plain-project', sessionId, requestId})).toMatchObject({success: true, session: {state: 'exited'}});
  }
}, 60_000);

test('read views: plain tail by default, the rendered screen, and the raw stream for a cursor, each with activity facts', async () => {
  const started = await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'views_start_1234', foreground: false});
  const id = started.session.id;
  const tail = await f.until('plain-project', id, 'READY:codex');
  expect(tail).toMatchObject({success: true, view: 'tail', text: 'READY:codex', truncated: false, state: 'running', exitCode: null, session: {id}});
  expect(tail).not.toHaveProperty('chunks');
  expect(Date.parse(tail.lastOutputAt)).toBeLessThanOrEqual(Date.now());
  expect(tail.idleMs).toBeGreaterThanOrEqual(0);
  expect(tail.nextCursor).toBeGreaterThan(0);
  const stream = await f.call('read_workroom_session', {portId: 'plain-project', sessionId: id, after: 0});
  expect(stream).toMatchObject({view: 'stream', state: 'running', truncated: false});
  expect(stream.chunks.map((chunk: any) => chunk.text).join('')).toContain('\x1b[1;32mREADY');
  const screen = await f.call('read_workroom_session', {portId: 'plain-project', sessionId: id, view: 'screen'});
  expect(screen).toMatchObject({view: 'screen', text: 'READY:codex', state: 'running', screen: {cols: 100, rows: 28, cursor: {row: 1, col: 0}, alternate: false}});
  expect(await f.call('send_workroom_instruction', {portId: 'plain-project', sessionId: id, requestId: 'views_send_1234', instruction: 'next'})).toMatchObject({success: true});
  await f.until('plain-project', id, 'GOT:codex:next');
  const newer = await f.call('read_workroom_session', {portId: 'plain-project', sessionId: id, after: tail.nextCursor, view: 'tail'});
  expect(newer).toMatchObject({view: 'tail', text: 'GOT:codex:next'});
  expect(await f.call('read_workroom_session', {portId: 'plain-project', sessionId: id, view: 'pixels'})).toMatchObject({success: false});
  await f.call('close_workroom_session', {portId: 'plain-project', sessionId: id, requestId: 'views_close_1234'});
}, 30_000);

test('a multi-line instruction reaches a paste-aware CLI as one bracketed paste', async () => {
  const started = await f.call('start_workroom_session', {portId: 'plain-project', agent: 'claude', requestId: 'paste_start_1234', foreground: false});
  const id = started.session.id;
  await f.until('plain-project', id, 'READY:claude');
  expect(await f.call('send_workroom_instruction', {portId: 'plain-project', sessionId: id, requestId: 'paste_send_1234', instruction: '첫 줄\n둘째 줄'})).toMatchObject({success: true});
  const read = await f.until('plain-project', id, 'GOT:claude:둘째 줄^[201~');
  expect(read.text).toContain('GOT:claude:^[200~첫 줄');
  await f.call('close_workroom_session', {portId: 'plain-project', sessionId: id, requestId: 'paste_close_1234'});
}, 30_000);

test('send_workroom_keys types only allow-listed keys, follows the cursor-key mode and never types twice', async () => {
  const normal = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'hermes', requestId: 'keys_start_normal', foreground: false})).session.id;
  await f.until('plain-project', normal, 'KEYS_READY');
  // Deliberate change (review 2026-09-29, finding 9): 'shift-tab' (Claude's permission-mode cycling)
  // left the allow-list, so it and its bytes 1b 5b 5a are gone from this list; it is refused below.
  const keys = {portId: 'plain-project', sessionId: normal, requestId: 'keys_send_normal', keys: ['1', 'down', 'enter', 'y', 'esc', 'ctrl-c']};
  expect(await f.call('send_workroom_keys', keys)).toMatchObject({success: true, effect: 'sent-workroom-keys', keys: keys.keys, session: {id: normal}});
  expect(await f.call('send_workroom_keys', keys)).toMatchObject({success: true});
  const expected = ['31', '1b', '5b', '42', '0d', '79', '1b', '03'];
  const typed = await f.until('plain-project', normal, 'KEY:03'); // the last byte: every key has been echoed
  expect([...typed.text.matchAll(/KEY:([0-9a-f]{2})/g)].map(match => match[1])).toEqual(expected);
  const refused = await f.post({action: 'send-workroom-keys', portId: 'plain-project', sessionId: normal, requestId: 'keys_send_refused', keys: ['enter', 'rm -rf /']});
  expect(refused).toMatchObject({status: 400, body: {success: false, code: 'AGENTSTOZ_USE_WORKROOM_KEYS_INVALID'}});
  const shiftTab = await f.post({action: 'send-workroom-keys', portId: 'plain-project', sessionId: normal, requestId: 'keys_send_shift_tab', keys: ['shift-tab']});
  expect(shiftTab).toMatchObject({status: 400, body: {success: false, code: 'AGENTSTOZ_USE_WORKROOM_KEYS_INVALID'}});
  const application = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'agy', requestId: 'keys_start_app', foreground: false})).session.id;
  await f.until('plain-project', application, 'KEYS_READY');
  await f.call('send_workroom_keys', {portId: 'plain-project', sessionId: application, requestId: 'keys_send_app', keys: ['up', 'left']});
  const arrows = await f.until('plain-project', application, 'KEY:44');
  expect([...arrows.text.matchAll(/KEY:([0-9a-f]{2})/g)].map(match => match[1])).toEqual(['1b', '4f', '41', '1b', '4f', '44']);
  const unchanged = await f.call('wait_workroom_session', {portId: 'plain-project', sessionId: normal, idleMs: 1_000, timeoutMs: 5_000});
  expect([...unchanged.text.matchAll(/KEY:([0-9a-f]{2})/g)].map(match => match[1])).toEqual(expected);
  for (const [sessionId, requestId] of [[normal, 'keys_close_normal'], [application, 'keys_close_app']]) {
    await f.call('close_workroom_session', {portId: 'plain-project', sessionId, requestId});
  }
}, 60_000);

test('send_workroom_keys refuses an exit choice and never resumes a partly sent request on retry', async () => {
  writeFileSync(join(f.home, 'exit-screen'), 'fixture');
  try {
    const id = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'hermes', requestId: 'keys_exit_start1', foreground: false})).session.id;
    await f.until('plain-project', id, 'No, exit');
    const first = {portId: 'plain-project', sessionId: id, requestId: 'keys_exit_first1', keys: ['enter']};
    expect(await f.call('send_workroom_keys', first)).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_KEYS_WOULD_EXIT', keysSent: 0});
    expect(await f.call('send_workroom_keys', {...first, requestId: 'keys_exit_number', keys: ['2']})).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_KEYS_WOULD_EXIT', keysSent: 0});
    const partial = {...first, requestId: 'keys_exit_partial', keys: ['down', 'enter']};
    const concurrent = await Promise.all([f.call('send_workroom_keys', partial), f.call('send_workroom_keys', partial)]);
    for (const result of concurrent) expect(result).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_KEYS_WOULD_EXIT', keysSent: 1});
    expect(await f.call('send_workroom_keys', partial)).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_KEYS_WOULD_EXIT', keysSent: 1});
    const seen = await f.until('plain-project', id, 'KEY:42');
    expect([...seen.text.matchAll(/KEY:([0-9a-f]{2})/g)].map(match => match[1])).toEqual(['1b', '5b', '42']);
    await f.call('close_workroom_session', {portId: 'plain-project', sessionId: id, requestId: 'keys_exit_close1'});
    writeFileSync(join(f.home, 'exit-screen'), 'redraw');
    const redrawn = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'hermes', requestId: 'keys_exit_redraw1', foreground: false})).session.id;
    await f.until('plain-project', redrawn, '1. Yes');
    expect(await f.call('send_workroom_keys', {portId: 'plain-project', sessionId: redrawn, requestId: 'keys_exit_redraw2', keys: ['down', 'enter']}))
      .toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_KEYS_WOULD_EXIT', keysSent: 1});
    expect((await f.call('read_workroom_session', {portId: 'plain-project', sessionId: redrawn, view: 'screen'})).text).toContain('No, exit');
    await f.call('close_workroom_session', {portId: 'plain-project', sessionId: redrawn, requestId: 'keys_exit_close2'});
  } finally {
    rmSync(join(f.home, 'exit-screen'), {force: true});
  }
}, 30_000);

test('independent key requests for one Workroom wait for the preceding sequence before checking a selection', async () => {
  writeFileSync(join(f.home, 'exit-screen'), 'redraw');
  try {
    const id = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'hermes', requestId: 'keys_queue_start1', foreground: false})).session.id;
    await f.until('plain-project', id, '1. Yes');
    const first = f.call('send_workroom_keys', {portId: 'plain-project', sessionId: id, requestId: 'keys_queue_first1', keys: [...Array(11).fill('y'), 'down']});
    await f.until('plain-project', id, 'KEY:79');
    const second = f.call('send_workroom_keys', {portId: 'plain-project', sessionId: id, requestId: 'keys_queue_second1', keys: ['enter']});
    expect(await Promise.race([second.then(() => 'finished'), Bun.sleep(250).then(() => 'pending')])).toBe('pending');
    expect(await first).toMatchObject({success: true, effect: 'sent-workroom-keys'});
    expect(await second).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_KEYS_WOULD_EXIT', keysSent: 0});
    await f.call('close_workroom_session', {portId: 'plain-project', sessionId: id, requestId: 'keys_queue_close1'});
  } finally { rmSync(join(f.home, 'exit-screen'), {force: true}); }
}, 30_000);

test('slow redraw and unchanged selection never send Enter after navigation', async () => {
  for (const mode of ['delayed', 'unchanged']) {
    writeFileSync(join(f.home, 'exit-screen'), mode);
    try {
      const id = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'hermes', requestId: `slow_start_${mode}`, foreground: false})).session.id;
      await f.until('plain-project', id, '1. Yes');
      expect(await f.call('send_workroom_keys', {portId: 'plain-project', sessionId: id, requestId: `slow_arrow_${mode}`, keys: ['down']})).toMatchObject({success: true});
      const request = {portId: 'plain-project', sessionId: id, requestId: `slow_enter_${mode}`, keys: ['enter']};
      const results = await Promise.all([f.call('send_workroom_keys', request), f.call('send_workroom_keys', request)]);
      for (const result of results) expect(result).toMatchObject({success: false, code: mode === 'delayed' ? 'AGENTSTOZ_USE_WORKROOM_KEYS_WOULD_EXIT' : 'AGENTSTOZ_USE_WORKROOM_KEYS_SCREEN_UNCHANGED', keysSent: 0});
      expect(await f.call('send_workroom_keys', request)).toMatchObject({success: false, keysSent: 0});
      const read = await f.call('read_workroom_session', {portId: 'plain-project', sessionId: id});
      expect(read.text).not.toContain('KEY:0d');
      await f.call('close_workroom_session', {portId: 'plain-project', sessionId: id, requestId: `slow_close_${mode}`});
    } finally { rmSync(join(f.home, 'exit-screen'), {force: true}); }
  }
}, 30_000);

test('a blank Workroom screen never counts as a readable selection', async () => {
  writeFileSync(join(f.home, 'exit-screen'), 'blank');
  try {
    const id = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'hermes', requestId: 'keys_blank_start1', foreground: false})).session.id;
    await Bun.sleep(500); // Let the fixture clear the screen after startup.
    const result = await f.call('send_workroom_keys', {portId: 'plain-project', sessionId: id, requestId: 'keys_blank_enter1', keys: ['enter']});
    expect(result).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_KEYS_SCREEN_UNAVAILABLE', keysSent: 0});
    const screen = await f.call('read_workroom_session', {portId: 'plain-project', sessionId: id, view: 'screen'});
    expect(screen.text).not.toContain('KEY:0d');
    await f.call('close_workroom_session', {portId: 'plain-project', sessionId: id, requestId: 'keys_blank_close1'});
  } finally { rmSync(join(f.home, 'exit-screen'), {force: true}); }
}, 30_000);

test('wait returns on quiet or exit, and close ends only that session and skips memory unless asked', async () => {
  const id = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'wait_start_12345', foreground: false})).session.id;
  const other = (await f.call('start_workroom_session', {portId: 'plain-project', agent: 'codex', requestId: 'wait_other_12345', foreground: false})).session.id;
  await f.until('plain-project', id, 'READY:codex');
  await f.call('send_workroom_instruction', {portId: 'plain-project', sessionId: id, requestId: 'wait_send_12345', instruction: 'hello'});
  await f.until('plain-project', id, 'GOT:codex:hello');
  const quiet = await f.call('wait_workroom_session', {portId: 'plain-project', sessionId: id, idleMs: 1_000, timeoutMs: 10_000});
  expect(quiet).toMatchObject({success: true, view: 'tail', waitResult: 'idle', state: 'running'});
  expect(quiet.text).toContain('GOT:codex:hello');
  expect(quiet.waitedMs).toBeGreaterThanOrEqual(1_000);
  const closed = await f.call('close_workroom_session', {portId: 'plain-project', sessionId: id, requestId: 'wait_close_12345'});
  expect(closed).toMatchObject({success: true, effect: 'closed-workroom-session', memorySave: 'skipped', session: {id, state: 'exited'}});
  const exited = await f.call('wait_workroom_session', {portId: 'plain-project', sessionId: id, idleMs: 20_000, timeoutMs: 30_000});
  expect(exited).toMatchObject({waitResult: 'exited', state: 'exited'});
  expect(exited.waitedMs).toBeLessThan(5_000);
  expect(await f.call('send_workroom_instruction', {portId: 'plain-project', sessionId: id, requestId: 'wait_after_12345', instruction: 'late'})).toMatchObject({success: false});
  expect((await f.call('read_workroom_session', {portId: 'plain-project', sessionId: other})).state).toBe('running');
  const saved = await f.call('close_workroom_session', {portId: 'plain-project', sessionId: other, requestId: 'wait_close_other', saveMemory: true});
  expect(saved).toMatchObject({success: true, session: {state: 'exited'}});
  expect(saved.memorySave).not.toBe('skipped');
}, 60_000);
