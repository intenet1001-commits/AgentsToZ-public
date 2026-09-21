import {afterEach, expect, test} from 'bun:test';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProjectMemory} from '../project-memory-server';
import {readControlProfileAccess} from '../src/controlProfileStore';
import {CONTROL_PROFILE_CONTROLLER, CONTROL_PROFILE_HEADER} from '../src/controlProfileContract';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {startTestApiServer} from './startTestApiServer';

const dirs: string[] = [], children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

async function fixture(registered = true, entrypoint = 'tests/fixtures/ops-surface-api.ts', dashboardFails = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ops-surface-'))); dirs.push(home);
  const data = join(home, 'app-data'), root = join(home, 'AgentsToZ-Control'), dev = join(home, 'development');
  mkdirSync(data); mkdirSync(dev); if (registered) mkdirSync(root);
  const ports = [];
  for (const [id, path] of [['dev-project', dev], ...(registered ? [['ops-project', root]] : [])]) {
    expect(Bun.spawnSync(['git', 'init', '-q', path!]).success).toBe(true);
    initializeProjectMemory({folderPath: path!, projectName: id!, autoBackup: false});
    ports.push({id, name: id, folderPath: path});
  }
  writeFileSync(join(data, 'ports.json'), JSON.stringify(ports));
  if (registered) writeFileSync(join(root, 'CONTROL.md'), '# AgentsToZ OPS fixture\n');
  const bin = join(home, '.local', 'bin'); mkdirSync(bin, {recursive: true});
  for (const agent of ['codex', 'claude', 'hermes', 'agy']) {
    const path = join(bin, agent);
    writeFileSync(path, `#!/bin/sh\nstty -echo\nprintf 'READY:${agent} CWD:%s\\n' "$PWD"\nwhile IFS= read -r line; do printf 'GOT:${agent}:%s\\n' "$line"; done\n`);
    chmodSync(path, 0o755);
  }
  const env = {...process.env, HOME: home, APP_DATA_DIR: data, NODE_ENV: 'test', AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1', AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1', AGENTSTOZ_SKIP_HERMES_SYNC: '1', AGENTSTOZ_TEST_SURFACE_LOG: '1', AGENTSTOZ_TEST_DASHBOARD_FAILURE: dashboardFails ? '1' : '0'};
  const {baseUrl, child} = await startTestApiServer({cwd: join(import.meta.dir, '..'), env, entrypoint}); children.push(child);
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(baseUrl + path, {method: 'POST', headers: {'Content-Type': 'application/json', ...(token ? {[CONTROL_PROFILE_HEADER]: token} : {})}, body: JSON.stringify(body)});
    return {status: r.status, body: await r.json() as any};
  };
  const prepared = await post('/api/control-profile/prepare', {});
  expect(prepared.body.profile.state).toBe('ready');
  expect(prepared.body.profile.backend).toBe(registered ? 'control-folder' : 'app-data');
  const access = readControlProfileAccess(data)!;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await handleAgentsToZUseMcpRequest({id: 1, method: 'tools/call', params: {name: `agentstoz_use_${name}`, arguments: args}}, {...env, AGENTSTOZ_USE_ENDPOINT: baseUrl + '/api/agentstoz-use/action'}) as any;
    if (r.result.structuredContent) return r.result.structuredContent as any;
    const error = JSON.parse(r.result.content[0].text);
    return error.data ?? error;
  };
  const launches = () => existsSync(join(home, 'surface-launches.jsonl')) ? readFileSync(join(home, 'surface-launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return {home, data, root, dev, ports, baseUrl, post, call, launches, access, profile: prepared.body.profile};
}

test('OPS external-app/Orca adapters resolve the bound folder and preserve modes, warnings and errors', async () => {
  const f = await fixture();
  // Display names/roles never override the profile binding.
  writeFileSync(join(f.data, 'ports.json'), JSON.stringify(f.ports.map(p => ({...p, name: 'renamed', role: p.id === 'ops-project' ? 'managed' : 'ops'}))));
  for (const agent of ['codex', 'claude', 'hermes']) {
    const r = await f.call('open_code_app', {target: 'ops', agent, bypass: true, ...(agent === 'codex' ? {mode: 'prepare'} : {})});
    expect(r).toMatchObject({success: true, target: 'ops', projectId: 'ops-project', projectName: 'AgentsToZ OPS', bypassRequested: true});
    expect(r.permissionModeForwarded).toBe(agent === 'claude');
    expect(r.warnings.length).toBe(agent === 'claude' ? 0 : 1);
    expect(JSON.stringify(r)).not.toContain(f.home); expect(JSON.stringify(r)).not.toContain(f.access.token);
    const launch = f.launches().at(-1);
    expect(launch).toMatchObject({path: '/api/open-code-app', body: {agent, folderPath: f.root, bypass: true}});
    expect(launch.body.mode).toBe(agent === 'codex' ? 'prepare' : agent === 'hermes' ? 'open' : undefined);
  }
  for (const surface of ['orca-floating', 'orca-worktree']) {
    const r = await f.call('open_code_app', {target: 'ops', agent: 'agy', surface, bypass: false});
    expect(r).toMatchObject({success: true, surface, orcaSurface: 'floating', reused: true});
    expect(r.fallbackNotice).toBe(surface === 'orca-worktree' ? 'selector_not_found: AgentsToZ OPS → Floating' : null);
    expect(r.warnings).toContain('Orca 창에서 해당 탭을 직접 확인하세요.');
    expect(f.launches().at(-1)).toEqual({path: '/api/open-orca-agent', body: {agent: 'agy', folderPath: f.root, name: 'AgentsToZ OPS', bypass: false, floating: surface === 'orca-floating'}});
  }
  writeFileSync(join(f.home, 'surface-result.json'), JSON.stringify({status: 409, body: {success: false, code: 'CLAUDE_REMOTE_SESSION_PERMISSION_MODE_MISMATCH', error: `기존 모드와 다름: ${f.root}`}}));
  const failed = await f.call('open_code_app', {target: 'ops', agent: 'claude', bypass: true});
  expect(failed).toMatchObject({success: false, performed: false, code: 'CLAUDE_REMOTE_SESSION_PERMISSION_MODE_MISMATCH'});
  expect(JSON.stringify(failed)).not.toContain(f.root);
}, 30_000);

test('all four OPS Workroom agents use real isolated sessions with exact target and request identity', async () => {
  const f = await fixture();
  for (const agent of ['codex', 'claude', 'hermes', 'agy']) {
    const args = {target: 'ops', agent, requestId: `ops_start_${agent}_123`};
    const started = await f.call('start_workroom_session', args);
    expect(started).toMatchObject({success: true, target: 'ops', projectId: 'ops-project', session: {targetId: 'ops-project', agent, state: 'running'}});
    const sessionId = started.session.id;
    expect((await f.call('start_workroom_session', args)).session.id).toBe(sessionId);
    let initial: any;
    for (let i = 0; i < 30; i++) {
      initial = await f.call('read_workroom_session', {target: 'ops', sessionId});
      if (JSON.stringify(initial.chunks).includes(`READY:${agent}`)) break;
      await Bun.sleep(50);
    }
    expect(JSON.stringify(initial.chunks)).toContain(`CWD:${f.root}`);
    const sent = await f.call('send_workroom_instruction', {target: 'ops', sessionId, requestId: `ops_send_${agent}_123`, instruction: '운영 상태 확인'});
    expect(sent).toMatchObject({success: true, target: 'ops', session: {id: sessionId}});
    let output: any;
    for (let i = 0; i < 30; i++) {
      output = await f.call('read_workroom_session', {target: 'ops', sessionId});
      if (JSON.stringify(output.chunks).includes(`GOT:${agent}:운영 상태 확인`)) break;
      await Bun.sleep(50);
    }
    expect(JSON.stringify(output.chunks)).toContain(`GOT:${agent}:운영 상태 확인`);
    const wrong = await f.call('read_workroom_session', {portId: 'dev-project', sessionId});
    expect(wrong).toMatchObject({success: false, code: 'AGENTSTOZ_USE_WORKROOM_SESSION_NOT_FOUND'});
  }
  const list = await f.call('list_workroom_sessions', {target: 'ops'});
  expect(list).toMatchObject({success: true, target: 'ops', sessionCount: 4});
  expect(list.sessions.every((s: any) => s.targetId === 'ops-project')).toBe(true);
}, 30_000);

test('OPS Buzz reuses the bound Control project and reports the exact-channel limitation', async () => {
  const f = await fixture();
  const channelId = '123e4567-e89b-42d3-a456-426614174000';
  const connected = await f.call('connect_buzz_channel', {target: 'ops', channelId, channelName: 'OPS 운영'});
  expect(connected).toMatchObject({
    success: true,
    target: 'ops',
    connection: {projectId: 'ops-project', channel: {channelId, channelName: 'OPS 운영'}},
  });
  const opened = await f.call('open_buzz_dev', {target: 'ops'});
  expect(opened).toMatchObject({
    success: true,
    target: 'ops',
    projectId: 'ops-project',
    channelId,
    channelName: 'OPS 운영',
    exactChannelOpened: false,
  });
  expect(opened.message).toContain('OPS 운영 채널');
  expect(f.launches().at(-1)).toEqual({path: 'buzz://foreground'});
  expect(JSON.stringify(opened)).not.toContain(f.root);
  expect(JSON.stringify(opened)).not.toContain(f.access.token);
}, 30_000);

test('OPS launch fails closed on missing authentication, changed registration or memory identity', async () => {
  const f = await fixture();
  const action = {action: 'open-code-app', controllerPortId: CONTROL_PROFILE_CONTROLLER, target: 'ops', agent: 'codex'};
  expect((await f.post('/api/agentstoz-use/action', action)).status).toBe(403);
  expect((await f.post('/api/agentstoz-use/action', action, 'a'.repeat(64))).status).toBe(403);
  const local = {action: 'open-code-app', agent: 'hermes', expectedProfileId: f.profile.profileId};
  expect((await f.post('/api/control-profile/open', {...local, expectedProfileId: 'stale-profile'})).body.code).toBe('CONTROL_PROFILE_SURFACE_MISMATCH');
  expect((await f.post('/api/control-profile/open', {...local, folderPath: f.dev})).status).toBe(400);
  writeFileSync(join(f.data, 'ports.json'), JSON.stringify(f.ports.map(p => p.id === 'ops-project' ? {...p, folderPath: f.dev} : p)));
  expect((await f.call('open_code_app', {target: 'ops', agent: 'hermes'})).success).toBe(false);
  expect(f.launches()).toEqual([]);
  writeFileSync(join(f.data, 'ports.json'), JSON.stringify(f.ports));
  const configPath = join(f.root, '.agent-memory', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({...config, memoryId: crypto.randomUUID()}));
  expect((await f.call('start_workroom_session', {target: 'ops', agent: 'codex', requestId: 'never_start_123'})).success).toBe(false);
  expect(f.launches()).toEqual([]);
}, 30_000);

test('local-only OPS keeps dashboard/memory available and reports launch gaps without registration or replacement memory', async () => {
  const f = await fixture(false);
  const binding = readFileSync(join(f.data, 'control-profile', 'binding.json'), 'utf8');
  const dashboard = await f.call('open_dashboard', {target: 'ops'});
  expect(dashboard).toMatchObject({success: true, target: 'ops', panel: 'ops', focusRequested: true});
  const nav = await fetch(f.baseUrl + '/api/agentstoz-use/workroom-navigation').then(r => r.json()) as any;
  expect(nav.navigation).toMatchObject({panel: 'ops'}); expect(nav.navigation).not.toHaveProperty('targetId');
  for (const [name, args] of [['open_code_app', {agent: 'codex'}], ['open_code_app', {agent: 'hermes', surface: 'orca-floating'}], ['start_workroom_session', {agent: 'agy', requestId: 'local_only_start'}]] as const) {
    expect(await f.call(name, {target: 'ops', ...args})).toMatchObject({success: false, code: 'CONTROL_PROFILE_SURFACE_UNAVAILABLE'});
  }
  expect((await f.call('get_control_profile')).profile.memoryId).toBe(f.profile.memoryId);
  expect((await f.call('recall_control_context', {query: '운영'})).success).toBe(true);
  expect(readFileSync(join(f.data, 'control-profile', 'binding.json'), 'utf8')).toBe(binding);
  expect(JSON.parse(readFileSync(join(f.data, 'ports.json'), 'utf8'))).toEqual(f.ports);
  expect(existsSync(f.root)).toBe(false); expect(f.launches()).toEqual([]);
}, 30_000);

test('the local OPS panel uses the same authenticated launch dispatcher without exposing the credential', async () => {
  const f = await fixture();
  const r = await f.post('/api/control-profile/open', {action: 'open-code-app', agent: 'hermes', expectedProfileId: f.profile.profileId});
  expect(r).toMatchObject({status: 200, body: {success: true, target: 'ops', projectId: 'ops-project'}});
  expect(f.launches()).toHaveLength(1); expect(f.launches()[0].body.folderPath).toBe(f.root);
  expect(JSON.stringify(r)).not.toContain(f.access.token); expect(JSON.stringify(r)).not.toContain(f.root);
}, 30_000);

test('generic project-memory writes cannot bypass shared OPS candidate review', async () => {
  const f = await fixture();
  const nested=join(f.root,'nested');mkdirSync(nested);
  for (const [path, body] of [
    ['/api/project-memory/init', {folderPath: f.root, projectName: 'AgentsToZ'}],
    ['/api/project-memory/update', {folderPath: f.root, projectName: 'AgentsToZ', agent: 'codex'}],
    ['/api/project-memory/push', {folderPath: f.root, projectName: 'AgentsToZ'}],
    ['/api/project-memory/pull', {folderPath: f.root, projectName: 'AgentsToZ'}],
    ['/api/project-memory/session-end', {folderPath: f.root, projectName: 'AgentsToZ', agent: 'codex'}],
  ] as const) {
    const response = await f.post(path, body);
    expect(response.body.code).toBe('CONTROL_PROFILE_REVIEW_REQUIRED');
  }
  const nestedUpdate=await f.post('/api/project-memory/update',{folderPath:nested,projectName:'AgentsToZ',agent:'codex'});
  expect(nestedUpdate.body.code).toBe('CONTROL_PROFILE_REVIEW_REQUIRED');
}, 30_000);

test('shared OPS capture stays pending until the authenticated panel reviews it',async()=>{
  const f=await fixture();
  const proposed=await f.call('propose_control_memory',{requestId:'shared_ops_memory_1',title:'검증 우선',body:'검증 결과를 확인한 뒤 완료를 보고한다.',evidence:'사용자의 명시적 운영 지시',expectedRevision:f.profile.revision});
  expect(proposed).toMatchObject({success:true,saved:false,effect:'proposed-memory',proposal:{state:'pending'}});
  expect(readFileSync(join(f.root,'.agent-memory','CORE.md'),'utf8')).not.toContain('검증 결과를 확인한 뒤');
  const listed=await f.call('list_control_memory_candidates');
  expect(listed.proposals.map((proposal:any)=>proposal.id)).toContain(proposed.proposal.id);
  const reviewed=await f.post('/api/control-profile/review',{id:proposed.proposal.id,accept:true,expectedRevision:f.profile.revision});
  expect(reviewed).toMatchObject({status:200,body:{success:true,proposal:{state:'saved'}}});
  expect(readFileSync(join(f.root,'.agent-memory','CORE.md'),'utf8')).toContain('검증 결과를 확인한 뒤 완료를 보고한다.');
},30_000);

test('a foreground failure retains the started Workroom receipt and never reports the panel as opened', async () => {
  const f = await fixture(true, 'tests/fixtures/ops-surface-api.ts', true);
  expect(await f.call('open_dashboard', {target: 'ops'})).toMatchObject({success:false, performed:false, code:'AGENTSTOZ_USE_DASHBOARD_OPEN_FAILED'});
  expect((await fetch(f.baseUrl+'/api/agentstoz-use/workroom-navigation').then(r=>r.json()) as any).navigation).toBeNull();
  const args={target:'ops',agent:'codex',requestId:'ops_foreground_failure'};
  const started=await f.call('start_workroom_session',args);
  expect(started).toMatchObject({success:true, performed:true, openedWorkroom:false, session:{targetId:'ops-project'}});
  expect(started.navigationWarning).toContain('새 세션을 다시 만들지');
  expect((await f.call('start_workroom_session',args)).session.id).toBe(started.session.id);
}, 30_000);

test('OPS traverses the actual Orca launcher: selector_not_found falls back once and later reuses the same floating terminal', async () => {
  const f = await fixture(true, 'tests/fixtures/ops-orca-api.ts');
  const args = {target: 'ops', agent: 'claude', surface: 'orca-worktree'};
  const opened = await f.call('open_code_app', args);
  expect(opened).toMatchObject({success: true, orcaSurface: 'floating', reused: false});
  expect(opened.fallbackNotice).toContain('AgentsToZ OPS');
  const reused = await f.call('open_code_app', args);
  expect(reused).toMatchObject({success: true, orcaSurface: 'floating', reused: true});
  expect(JSON.stringify(reused)).not.toContain(f.root);
  const commands: string[] = readFileSync(join(f.home, 'orca-processes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const created = commands.filter(c => c.includes("'terminal' 'create'") && c.includes("'--worktree' 'id:global-floating-terminal'"));
  expect(created).toHaveLength(1); expect(created[0]).toContain(f.root);
  expect(commands.some(c => c.includes("'terminal' 'switch'") && c.includes('fixture-orca-handle'))).toBe(true);
  expect(commands.some(c => c.includes("'terminal' 'send'"))).toBe(false);
}, 30_000);
