import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProjectMemory} from '../project-memory-server';
import {AGENTSTOZ_USE_MCP_TOOLS, agentsToZUseMcpActionForTool, handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {AGENTSTOZ_USE_MCP_CONTRACT_VERSION} from '../src/agentstozUseMcpVersion';
import {
  AGENTSTOZ_USE_NAVIGATION_POLL_MS,
  parseAgentsToZUseNavigation,
  projectFocusSection,
  startAgentsToZUseNavigationPolling,
} from '../src/agentstozUseNavigation';
import {startTestApiServer} from './startTestApiServer';

// 「<프로젝트> 열어」 means: show that project in the AgentsToZ app. It is navigation only.
describe('open_dashboard accepts a registered portId (contract 1.22.0)', () => {
  test('the MCP tool maps portId, keeps it exclusive with target, and says it runs nothing', () => {
    // portId arrived with contract 1.22.0; tests/agentstoz-use-mcp-version.test.ts pins the exact version.
    const [major, minor] = AGENTSTOZ_USE_MCP_CONTRACT_VERSION.split('.').map(Number);
    expect(major! > 1 || (major === 1 && minor! >= 22)).toBe(true);
    expect(agentsToZUseMcpActionForTool('agentstoz_use_open_dashboard', {portId: 'study-id', folderPath: '/tmp/ignored'}, 'controller-id'))
      .toEqual({action: 'open-dashboard', controllerPortId: 'controller-id', portId: 'study-id'});
    expect(agentsToZUseMcpActionForTool('agentstoz_use_open_dashboard', {}, 'controller-id')).toEqual({action: 'open-dashboard', controllerPortId: 'controller-id'});
    expect(() => agentsToZUseMcpActionForTool('agentstoz_use_open_dashboard', {projectId: 'study-id'}, 'controller-id'))
      .toThrow('Use the registered project ID as portId');
    expect(() => agentsToZUseMcpActionForTool('agentstoz_use_open_dashboard', {target: 'ops', portId: 'study-id'}, 'controller-id')).toThrow();
    const tool = AGENTSTOZ_USE_MCP_TOOLS.find(candidate => candidate.name === 'agentstoz_use_open_dashboard')!;
    expect((tool.inputSchema as any).properties.portId).toMatchObject({type: 'string'});
    expect((tool.inputSchema as any).not).toEqual({required: ['target', 'portId']});
    expect(tool.description).toContain('portId');
    expect(tool.description).toContain('Navigation only');
  });
  test('the host parser keeps the portId and still refuses it next to target', () => {
    expect(parseAgentsToZUseActionRequest({action: 'open-dashboard', controllerPortId: 'controller-id', portId: 'study-id'}).portId).toBe('study-id');
    expect(parseAgentsToZUseActionRequest({action: 'open-dashboard', controllerPortId: 'controller-id'}).portId).toBeNull();
    expect(() => parseAgentsToZUseActionRequest({action: 'open-dashboard', controllerPortId: 'controller-id', target: 'ops', portId: 'study-id'})).toThrow();
  });
});

describe('the app consumes one navigation request at a time', () => {
  test('parses the three navigation kinds and ignores anything else', () => {
    expect(parseAgentsToZUseNavigation({success: true, navigation: {nonce: 'n1', panel: 'ops'}})).toEqual({kind: 'ops', nonce: 'n1'});
    expect(parseAgentsToZUseNavigation({success: true, navigation: {nonce: 'n2', projectId: 'study-id'}})).toEqual({kind: 'project', nonce: 'n2', projectId: 'study-id'});
    expect(parseAgentsToZUseNavigation({success: true, navigation: {nonce: 'n3', targetId: 'study-id', agent: 'agy', sessionId: 'session_1'}}))
      .toEqual({kind: 'workroom', nonce: 'n3', targetId: 'study-id', agent: 'agy', sessionId: 'session_1'});
    for (const body of [null, {}, {success: false, navigation: {nonce: 'n4', panel: 'ops'}}, {success: true, navigation: null},
      {success: true, navigation: {panel: 'ops'}}, {success: true, navigation: {nonce: 'n5', projectId: ''}},
      {success: true, navigation: {nonce: 'n6', targetId: 't', agent: 'gpt', sessionId: 's'}}]) {
      expect(parseAgentsToZUseNavigation(body)).toBeNull();
    }
  });

  test('a project is selected in its sidebar section; an unknown one is reported', () => {
    const ports = [{id: 'main-id'}, {id: 'tree-id', worktreePath: '/repo/worktrees/x'}];
    expect(projectFocusSection(ports, 'main-id')).toBe('all');
    expect(projectFocusSection(ports, 'tree-id')).toBe('wt');
    expect(projectFocusSection(ports, 'missing')).toBeNull();
  });

  test('polls every 2 s while visible, consumes each nonce once, never overlaps, and stops cleanly', async () => {
    expect(AGENTSTOZ_USE_NAVIGATION_POLL_MS).toBe(2_000);
    const intervals: {ms: number; run: () => void; cleared: boolean}[] = [];
    const subscribers = new Set<() => void>();
    let visible = true, fetches = 0;
    const responses: ((body: unknown) => void)[] = [];
    const seen: unknown[] = [];
    const lastNonce = {current: ''};
    const stop = startAgentsToZUseNavigationPolling({
      fetchNavigation: () => { fetches++; return new Promise(resolve => responses.push(resolve)); },
      onNavigation: navigation => seen.push(navigation),
      isVisible: () => visible,
      lastNonce,
      subscribe: check => { subscribers.add(check); return () => subscribers.delete(check); },
      setInterval: (run, ms) => { const timer = {ms, run, cleared: false}; intervals.push(timer); return timer; },
      clearInterval: timer => { (timer as {cleared: boolean}).cleared = true; },
    });
    expect(intervals.map(timer => timer.ms)).toEqual([2_000]);
    expect(fetches).toBe(1); // the immediate first check
    intervals[0]!.run(); // a tick while the first request is still open does not overlap it
    expect(fetches).toBe(1);
    responses[0]!({success: true, navigation: {nonce: 'n1', projectId: 'study-id'}});
    await Bun.sleep(0);
    expect(seen).toEqual([{kind: 'project', nonce: 'n1', projectId: 'study-id'}]);
    intervals[0]!.run();
    expect(fetches).toBe(2);
    responses[1]!({success: true, navigation: {nonce: 'n1', projectId: 'study-id'}}); // the same request again
    await Bun.sleep(0);
    expect(seen).toHaveLength(1);
    visible = false;
    intervals[0]!.run();
    for (const check of subscribers) check();
    expect(fetches).toBe(2); // hidden: nothing is fetched
    visible = true;
    for (const check of subscribers) check(); // focus / visibilitychange
    expect(fetches).toBe(3);
    responses[2]!(null);
    await Bun.sleep(0);
    stop();
    expect(intervals[0]!.cleared).toBe(true);
    expect(subscribers.size).toBe(0);
  });
});

describe('open_dashboard with a portId focuses that project through the real API', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

  async function fixture(dashboardFails = false, sharedFolderRows = false) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'open-project-')));
    cleanup.push(() => rmSync(home, {recursive: true, force: true}));
    const data = join(home, 'app-data'), ops = join(home, 'AgentsToZ-Control'), plain = join(home, 'projects', 'plain-app');
    mkdirSync(data); mkdirSync(ops); mkdirSync(plain, {recursive: true});
    for (const path of [ops, plain]) expect(Bun.spawnSync(['git', 'init', '-q', path]).success).toBe(true);
    initializeProjectMemory({folderPath: ops, projectName: 'ops-project', autoBackup: false});
    writeFileSync(join(ops, 'CONTROL.md'), '# AgentsToZ OPS fixture\n');
    // The project has no long-term memory: navigation must not need it.
    const rows: Record<string, unknown>[] = [{id: 'ops-project', name: 'ops-project', folderPath: ops}, {id: 'plain-project', name: 'plain-app', folderPath: plain}];
    // Two registrations of one folder: both IDs are listed, so both must be focusable as themselves.
    if (sharedFolderRows) {
      rows.push({id: 'shared-second', name: 'plain-app second', folderPath: plain});
      // With memory, the registry groups the two rows under the folder's main row.
      initializeProjectMemory({folderPath: plain, projectName: 'plain-app', autoBackup: false});
    }
    writeFileSync(join(data, 'ports.json'), JSON.stringify(rows));
    const env = {...process.env, HOME: home, APP_DATA_DIR: data, NODE_ENV: 'test', AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1', AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1',
      AGENTSTOZ_SKIP_HERMES_SYNC: '1', AGENTSTOZ_TEST_SURFACE_LOG: '1', AGENTSTOZ_TEST_DASHBOARD_FAILURE: dashboardFails ? '1' : '0'};
    const {baseUrl, child} = await startTestApiServer({cwd: join(import.meta.dir, '..'), env, entrypoint: 'tests/fixtures/ops-surface-api.ts'});
    cleanup.push(async () => { child.kill(); await child.exited; });
    await fetch(`${baseUrl}/api/control-profile/prepare`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await handleAgentsToZUseMcpRequest({id: 1, method: 'tools/call', params: {name: `agentstoz_use_${name}`, arguments: args}}, {...env, AGENTSTOZ_USE_ENDPOINT: `${baseUrl}/api/agentstoz-use/action`}) as any;
      if (r.result.structuredContent) return r.result.structuredContent as any;
      const error = JSON.parse(r.result.content[0].text);
      return error.data ?? error;
    };
    const navigation = async () => (await fetch(`${baseUrl}/api/agentstoz-use/workroom-navigation`).then(response => response.json()) as any).navigation;
    const opens = () => existsSync(join(home, 'dashboard-opens.jsonl')) ? readFileSync(join(home, 'dashboard-opens.jsonl'), 'utf8').trim().split('\n').length : 0;
    return {home, plain, call, navigation, opens};
  }

  test('sets a project navigation, brings the app forward, and never starts a Workroom', async () => {
    const f = await fixture();
    const opened = await f.call('open_dashboard', {portId: 'plain-project'});
    expect(opened).toMatchObject({success: true, effect: 'opened-local-app', projectId: 'plain-project', projectName: 'plain-app', focusRequested: true});
    expect(JSON.stringify(opened)).not.toContain(f.home);
    const served = await f.navigation();
    expect(served).toEqual({nonce: expect.any(String), projectId: 'plain-project'});
    expect(f.opens()).toBe(1);
    expect((await f.call('list_workroom_sessions', {portId: 'plain-project'})).sessionCount).toBe(0);
    expect(existsSync(join(f.plain, '.agent-memory'))).toBe(false);
    // An unregistered project is refused and leaves the pending navigation alone.
    expect(await f.call('open_dashboard', {portId: 'not-registered-1'})).toMatchObject({success: false});
    expect(await f.navigation()).toEqual(served);
    expect(f.opens()).toBe(1);
  }, 30_000);

  test('two registrations of one folder each focus their own row (no false "outdated" error)', async () => {
    const f = await fixture(false, true);
    const opened = await f.call('open_dashboard', {portId: 'shared-second'});
    expect(opened).toMatchObject({success: true, effect: 'opened-local-app', projectId: 'shared-second', projectName: 'plain-app second', focusRequested: true});
    expect(await f.navigation()).toEqual({nonce: expect.any(String), projectId: 'shared-second'});
    const first = await f.call('open_dashboard', {portId: 'plain-project'});
    expect(first).toMatchObject({success: true, projectId: 'plain-project', projectName: 'plain-app'});
    expect(await f.navigation()).toEqual({nonce: expect.any(String), projectId: 'plain-project'});
  }, 30_000);

  test('a failed app launch rolls the project navigation back', async () => {
    const f = await fixture(true);
    expect(await f.call('open_dashboard', {portId: 'plain-project'})).toMatchObject({success: false, code: 'AGENTSTOZ_USE_DASHBOARD_OPEN_FAILED'});
    expect(await f.navigation()).toBeNull();
  }, 30_000);
});
