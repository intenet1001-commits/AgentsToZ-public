/**
 * WP0 — 에뮬레이터 종단 시험 preflight·허용 목록 환경·동시 실행 가드(scripts/emulator-e2e.ts, scripts/emulator-e2e/*).
 *
 * 확인하는 것: 허용 목록에서 금지 키가 빠지는지, 실제 홈으로 풀리면 거부하는지, 금지 도구를 탐지하는지, 등록 루트
 * 안의 워크트리를 거부하는지, 막힘·건너뜀이 통과로 세지지 않는지, 레인 표·등록 API, 시뮬레이터 스냅샷 판정,
 * 동시 실행 탐지와 부팅 잠금. 시뮬레이터를 만들거나 부팅하지 않는다.
 */
import {afterAll, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {
  FORBIDDEN_ENV_KEYS,
  PRODUCTION_SUPABASE_REFS,
  buildAllowlistedEnv,
  buildToolchainEnv,
  childIdentityViolations,
  createIsolatedProfile,
  createRunScratch,
  environmentViolations,
  realHome,
  validateLaneOverride,
  type ChildIdentityReport,
} from '../scripts/emulator-e2e/environment';
import {LANE_EXIT_CODES, createEvidenceRun, findPairTokenLeaks, normalizeOutcome, summarize, type LaneOutcome} from '../scripts/emulator-e2e/evidence';
import {
  FORBIDDEN_DECLARATION_MARKER,
  acquireSimulatorBootLock,
  checkWorktreeLocation,
  compareSimulatorSnapshots,
  detectForbiddenTools,
  findConcurrentChecks,
  harnessScanTargets,
  ownProcessTree,
  parsePsRows,
  parseSimctlDevices,
  readSimulatorLock,
  simulatorLockHolderPath,
  type PreflightReport,
  type SimulatorSnapshot,
} from '../scripts/emulator-e2e/preflight';
import {
  LANE_CATALOG,
  LANE_IDS,
  catalogEntry,
  lanesForAll,
  main,
  planLane,
  registerLane,
  resolveLane,
  runEntries,
  runLanes,
  unregisterLane,
  type LaneContext,
  type LaneDefinition,
  type LaneScope,
} from '../scripts/emulator-e2e';
import {
  PERF_MANAGEMENT_ORIGIN,
  buildPerfMeasurementEnv,
  isHarnessActive,
  isolatedRoot,
  markHarnessActive,
  startSidecar,
} from '../scripts/emulator-e2e/isolatedSidecar';

const REPO_ROOT = resolve(import.meta.dir, '..');
const cleanup: string[] = [];
afterAll(() => { for (const path of cleanup) rmSync(path, {recursive: true, force: true}); });

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

const POLLUTED: Record<string, string> = {
  CODEX_HOME: '/Users/someone/.codex',
  AGENTSTOZ_CLI_SHIM_DIR: '/Users/someone/Library/Application Support/com.portmanager.portmanager/platform-cli-v1/shims',
  AGENTSTOZ_USE_ENDPOINT: 'http://127.0.0.1:3001/api/agentstoz-use/action',
  AGENTSTOZ_IOS_PORTAL_URL: 'https://portal.example',
  PORTMGR_BUNDLED_SIDECAR: '1',
  SUPABASE_SERVICE_ROLE_KEY: 'secret',
  VITE_SUPABASE_URL: PRODUCTION_SUPABASE_REFS[0]!,
  CLAUDECODE: '1',
  API_PORT: '3001',
  APP_DATA_DIR: '/Users/someone/Library/Application Support/com.portmanager.portmanager',
  ORCA_AGENT_HOOK_TOKEN: 'token',
};

describe('allowlisted environment', () => {
  test('is built from empty: no forbidden key survives, even when the parent carries all of them', () => {
    const base = tempDir('atz-env-');
    const profile = createIsolatedProfile(base, 'env');
    const env = buildAllowlistedEnv({profile, inherited: {...process.env, ...POLLUTED}});
    for (const key of FORBIDDEN_ENV_KEYS) expect({key, value: env[key]}).toEqual({key, value: undefined});
    // 허용 키(APP_DATA_DIR 등)는 남되 부모 값이 아니라 scratch 값이어야 한다.
    for (const [key, value] of Object.entries(POLLUTED)) expect({key, same: env[key] === value}).toEqual({key, same: false});
    for (const key of Object.keys(env)) expect({key, prefix: /^(PORTMGR_|SUPABASE_|VITE_|ORCA_|CODEX_|CLAUDE_CODE_)/.test(key)}).toEqual({key, prefix: false});
    expect(env.HOME).toBe(profile.home);
    expect(env.APP_DATA_DIR).toBe(profile.appDataDir);
    expect(env.TMUX_TMPDIR).toBe(profile.tmuxDir);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.NODE_ENV).toBe('test');
    for (const key of ['AGENTSTOZ_SKIP_HERMES_SYNC', 'AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC', 'AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP', 'AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC']) expect(env[key]).toBe('1');
    const path = env.PATH!.split(':');
    expect(path[0]).toBe(profile.binDir);
    expect(path).not.toContain('/Users/someone/Library/Application Support/com.portmanager.portmanager/platform-cli-v1/shims');
    expect(path.some(entry => /pyenv|shims/.test(entry))).toBe(false);
    expect(environmentViolations(env, {scratchRoots: [base]})).toEqual([]);
  });

  test('reports every forbidden or inherited key in a polluted environment', () => {
    const problems = environmentViolations({...POLLUTED, PATH: '/Users/x/.pyenv/shims:/usr/bin'}, {inherited: POLLUTED});
    for (const key of ['CODEX_HOME', 'AGENTSTOZ_CLI_SHIM_DIR', 'AGENTSTOZ_USE_ENDPOINT', 'AGENTSTOZ_IOS_PORTAL_URL', 'PORTMGR_BUNDLED_SIDECAR', 'SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_URL', 'CLAUDECODE', 'ORCA_AGENT_HOOK_TOKEN']) {
      expect(problems.some(problem => problem.startsWith(key))).toBe(true);
    }
    expect(problems).toContain('API_PORT 3001 is reserved');
    expect(problems).toContain('API_PORT copies the inherited value');
    expect(problems.some(problem => problem.includes('production Supabase'))).toBe(true);
    expect(problems.some(problem => problem.startsWith('PATH contains a shim directory'))).toBe(true);
  });

  test('rejects reserved ports and lane overrides that copy, leak or reach production', () => {
    const base = tempDir('atz-env-ports-');
    const profile = createIsolatedProfile(base, 'ports');
    expect(() => buildAllowlistedEnv({profile, apiPort: 3001})).toThrow(/reserved/);
    expect(() => buildAllowlistedEnv({profile, apiPort: 52741})).toThrow(/reserved/);
    expect(() => buildAllowlistedEnv({profile, webUiPort: 4723})).toThrow(/reserved/);
    expect(buildAllowlistedEnv({profile, apiPort: 45_123}).API_PORT).toBe('45123');
    expect(validateLaneOverride('CODEX_HOME', '/x')).toMatch(/not a lane-overridable/);
    expect(validateLaneOverride('PORTMGR_ONBOARDING_CAPABILITY', 'same', {PORTMGR_ONBOARDING_CAPABILITY: 'same'})).toMatch(/copies the inherited/);
    expect(validateLaneOverride('VITE_SUPABASE_URL', 'https://external-supabase.invalid', {})).toMatch(/loopback/);
    expect(validateLaneOverride('VITE_SUPABASE_URL', PRODUCTION_SUPABASE_REFS[0]!, {})).toMatch(/production/);
    expect(validateLaneOverride('AGENTSTOZ_USE_ENDPOINT', 'http://127.0.0.1:3001/api/agentstoz-use/action', {})).toMatch(/reserved port 3001/);
    expect(validateLaneOverride('VITE_SUPABASE_URL', 'https://localhost', {})).toBeNull();
    expect(validateLaneOverride('AGENTSTOZ_USE_ENDPOINT', 'http://127.0.0.1:45000/api/agentstoz-use/action', {})).toBeNull();
    expect(() => buildAllowlistedEnv({profile, laneOverrides: {HOME: '/tmp'}})).toThrow();
  });

  test('xcodebuild/simctl environment keeps the real HOME but none of the deleted keys', () => {
    const env = buildToolchainEnv({inherited: {...POLLUTED, TMPDIR: '/var/folders/x/T/', DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer'}});
    expect(env.HOME).toBe(realHome());
    expect(env.AGENTSTOZ_IOS_PORTAL_URL).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.APP_DATA_DIR).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(['DEVELOPER_DIR', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'TMPDIR', 'USER']);
  });
});

describe('real home guard', () => {
  test('a child whose homedir or app data resolves under the real home is rejected', () => {
    const home = realHome();
    const scratchReport: ChildIdentityReport = {
      homedir: '/private/tmp/x/home', appDataDir: '/private/tmp/x/home/Library/Application Support/com.portmanager.portmanager',
      appDataDirFromEnvironment: '/private/tmp/x/app-data', tmpdir: '/private/tmp/x/tmp', cwd: '/private/tmp/x',
      en0PrivateIpv4: null, privateIpv4: [], forbiddenKeysPresent: [],
    };
    expect(childIdentityViolations(scratchReport, {home})).toEqual([]);
    const leaked = {...scratchReport, homedir: home, appDataDir: join(home, 'Library', 'Application Support', 'com.portmanager.portmanager')};
    const problems = childIdentityViolations(leaked, {home});
    expect(problems.some(problem => problem.startsWith('homedir'))).toBe(true);
    expect(problems.some(problem => problem.startsWith('appDataDir'))).toBe(true);
    expect(childIdentityViolations({...scratchReport, forbiddenKeysPresent: ['CODEX_HOME']}, {home})).toEqual(['child sees forbidden keys: CODEX_HOME']);
  });

  test('an allowlisted environment whose HOME is under the real home is a violation', () => {
    const home = realHome();
    const problems = environmentViolations({HOME: home, APP_DATA_DIR: join(home, 'Library')}, {home});
    expect(problems).toContain('HOME resolves under the real home');
    expect(problems).toContain('APP_DATA_DIR resolves under the real home');
  });

  test('the run scratch is never created under the (given) home', () => {
    const fakeHome = tempDir('atz-fake-home-');
    const inside = join(fakeHome, 'tmp');
    mkdirSync(inside);
    expect(() => createRunScratch('guard', {parents: [inside], home: fakeHome})).toThrow(/outside the real home/);
    const outside = tempDir('atz-outside-');
    const scratch = createRunScratch('guard', {parents: [inside, outside], home: fakeHome});
    expect(scratch.startsWith(`${outside}/`)).toBe(true);
  });

  test.skipIf(process.platform !== 'darwin')('a real child started with the allowlisted environment sees only scratch paths', async () => {
    const scratch = createRunScratch(`identity-${process.pid}`);
    cleanup.push(scratch);
    const profile = createIsolatedProfile(scratch, 'identity');
    const env = buildAllowlistedEnv({profile});
    const child = Bun.spawn([process.execPath, '--env-file=/dev/null', join(REPO_ROOT, 'scripts', 'emulator-e2e', 'environment.ts'), '--probe-identity'], {cwd: profile.root, env, stdout: 'pipe', stderr: 'pipe'});
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({code, stderr: stderr.slice(-300)}).toEqual({code: 0, stderr: ''});
    const report = JSON.parse(stdout.trim().split('\n').pop()!) as ChildIdentityReport;
    expect(childIdentityViolations(report, {profile})).toEqual([]);
    expect(report.homedir).toBe(profile.home);
    expect(report.appDataDirFromEnvironment).toBe(profile.appDataDir);
  }, 60_000);
});

describe('forbidden tools', () => {
  test('are detected in harness files; the declaration marker only exempts the declaration files', () => {
    const hits = detectForbiddenTools([
      {path: 'scripts/emulator-e2e/lane.ts', text: 'run(["swift", "mobile/ios/scripts/ScreenControlFixture.swift"])'},
      {path: 'scripts/emulator-e2e/lane2.ts', text: `spawn("tccutil", ["reset"]) // ${FORBIDDEN_DECLARATION_MARKER}`},
      {path: 'mobile/ios/scripts/check-ui.py', text: 'subprocess.run(["python3", "simulator-smoke.py"])'},
      {path: 'scripts/emulator-e2e/x.ts', text: '"/Users/me/Applications/AgentsToZ Screen.app/Contents/MacOS/AgentsToZScreen" --selftest'},
      {path: 'scripts/emulator-e2e/y.ts', text: 'PhysicalScreenControls\nComputerUseNativeLab --fixture\nworkroom-browser-native-screen'},
      {path: 'scripts/emulator-e2e/preflight.ts', text: `/tccutil/ // ${FORBIDDEN_DECLARATION_MARKER}`},
      {path: 'scripts/emulator-e2e/clean.ts', text: 'const ok = "AgentsToZScreen is the Mac app";'},
    ]);
    expect(hits.map(hit => `${hit.file}:${hit.id}`).sort()).toEqual([
      'mobile/ios/scripts/check-ui.py:simulator-smoke',
      'scripts/emulator-e2e/lane.ts:screen-control-fixture',
      'scripts/emulator-e2e/lane2.ts:tccutil',
      'scripts/emulator-e2e/x.ts:screen-selftest-identity',
      'scripts/emulator-e2e/y.ts:computer-use-native-lab',
      'scripts/emulator-e2e/y.ts:physical-screen-controls',
      'scripts/emulator-e2e/y.ts:workroom-browser-native-screen',
    ]);
  });

  test('the harness in this checkout references none of them', () => {
    const targets = harnessScanTargets(REPO_ROOT);
    expect(targets.map(target => target.path)).toContain('scripts/emulator-e2e.ts');
    expect(targets.map(target => target.path)).toContain('scripts/emulator-e2e/sandbox.ts');
    expect(detectForbiddenTools(targets)).toEqual([]);
  });

  test('the orchestrator and its helpers do not statically import host code (src/)', () => {
    for (const file of ['scripts/emulator-e2e.ts', 'scripts/emulator-e2e/environment.ts', 'scripts/emulator-e2e/evidence.ts', 'scripts/emulator-e2e/preflight.ts', 'scripts/emulator-e2e/sandbox.ts', 'scripts/emulator-e2e/isolatedSidecar.ts']) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      const staticImports = text.split('\n').filter(line => /^\s*(import|export)\b[^(]*from\s+['"]/.test(line) || /^\s*\}\s*from\s+['"]/.test(line));
      expect({file, hostImports: staticImports.filter(line => /['"](\.\.\/)+src\//.test(line))}).toEqual({file, hostImports: []});
    }
  });
});

describe('worktree location', () => {
  test('a worktree inside a registered workspace root is refused; outside is accepted', () => {
    const base = tempDir('atz-roots-');
    const root = join(base, 'forcs');
    const inside = join(root, 'AgentsToZ_byCS', '.claude', 'worktrees', 'wt');
    const outside = join(base, 'agentstoz-emulator', 'run', 'wt');
    mkdirSync(inside, {recursive: true});
    mkdirSync(outside, {recursive: true});
    const rootsFile = join(base, 'workspace-roots.json');
    writeFileSync(rootsFile, JSON.stringify([{id: '1', name: 'forcs', path: root}]));
    const refused = checkWorktreeLocation(inside, {workspaceRootsFile: rootsFile, home: join(base, 'home')});
    expect(refused.insideRegisteredRoot).toBe(root);
    expect(refused.problems.some(problem => problem.includes('inside the registered workspace root'))).toBe(true);
    const accepted = checkWorktreeLocation(outside, {workspaceRootsFile: rootsFile, home: join(base, 'home')});
    expect(accepted.problems).toEqual([]);
    const missingFile = checkWorktreeLocation(outside, {workspaceRootsFile: join(base, 'none.json'), home: join(base, 'home')});
    expect(missingFile.problems).toEqual([]);
    writeFileSync(rootsFile, '{not json');
    expect(checkWorktreeLocation(outside, {workspaceRootsFile: rootsFile, home: join(base, 'home')}).problems[0]).toMatch(/unreadable/);
  });

  test('a worktree under a sandbox read-denied path is refused', () => {
    const base = tempDir('atz-denied-');
    const home = join(base, 'home');
    const managed = join(home, '.codex', 'worktrees', 'wt');
    mkdirSync(managed, {recursive: true});
    const result = checkWorktreeLocation(managed, {workspaceRootsFile: join(base, 'none.json'), home});
    expect(result.underDeniedReadPath).toBe(join(home, '.codex'));
  });
});

describe('lane statuses', () => {
  test('blocked and skipped are never counted as a pass', () => {
    expect(summarize([{status: 'pass'}, {status: 'blocked'}])).toMatchObject({overall: 'blocked', passed: false, exitCode: LANE_EXIT_CODES.blocked, pass: 1, blocked: 1});
    expect(summarize([{status: 'pass'}, {status: 'skipped'}])).toMatchObject({overall: 'skipped', passed: false, exitCode: LANE_EXIT_CODES.skipped});
    expect(summarize([{status: 'blocked'}, {status: 'fail'}, {status: 'pass'}])).toMatchObject({overall: 'fail', passed: false, exitCode: 1});
    expect(summarize([{status: 'pass'}, {status: 'pass'}])).toMatchObject({overall: 'pass', passed: true, exitCode: 0});
    expect(summarize([])).toMatchObject({overall: 'skipped', passed: false});
    expect(new Set(Object.values(LANE_EXIT_CODES)).size).toBe(4);
    expect(LANE_EXIT_CODES.blocked).not.toBe(0);
    expect(LANE_EXIT_CODES.skipped).not.toBe(0);
  });

  test('a lane outcome without a reason, or with an invalid status, becomes a failure', () => {
    expect(normalizeOutcome({status: 'blocked'})).toMatchObject({status: 'fail'});
    expect(normalizeOutcome({status: 'skipped', reason: '  '})).toMatchObject({status: 'fail'});
    expect(normalizeOutcome({status: 'passed'})).toMatchObject({status: 'fail'});
    expect(normalizeOutcome(null)).toMatchObject({status: 'fail'});
    expect(normalizeOutcome({status: 'blocked', reason: '443 not bindable'})).toMatchObject({status: 'blocked'});
    expect(normalizeOutcome({status: 'pass'})).toMatchObject({status: 'pass'});
  });

  test('evidence folders are private and the index refuses #pair= tokens', () => {
    const repo = tempDir('atz-evidence-');
    const run = createEvidenceRun(repo, 'test-run-1');
    expect(run.dir.endsWith('/mobile/ios/build/emulator-evidence/test-run-1')).toBe(true);
    const path = run.writeJson('lane/host.json', {ok: true});
    expect((Bun.spawnSync(['/usr/bin/stat', '-f', '%Lp', run.dir]).stdout.toString().trim())).toBe('700');
    expect((Bun.spawnSync(['/usr/bin/stat', '-f', '%Lp', path]).stdout.toString().trim())).toBe('600');
    expect(() => createEvidenceRun(repo, 'test-run-1')).toThrow(/already exists/);
    expect(() => run.writeJson('../escape.json', {})).toThrow(/unsafe/);
    expect(findPairTokenLeaks([{name: 'host.log', text: 'https://x/remote/#pair=abcdefghijklmnop'}, {name: 'ok', text: 'no token'}])).toEqual(['host.log']);
  });
});

describe('lane table and registration', () => {
  test('the subcommand table covers every planned lane; unregistered lanes resolve to nothing', async () => {
    expect([...LANE_IDS].sort()).toEqual(['j1-lan', 'j1-pty', 'j1-relay-sim', 'j1-relay-web', 'j2', 'j2-boundary', 'j2-model', 'j3a-process', 'j3b', 'j4-fixture', 'j4-sim', 'j4-web', 'screen-host-selfcheck']);
    expect(LANE_CATALOG.map(entry => entry.id).sort()).toEqual([...LANE_IDS].sort());
    expect(lanesForAll()).not.toContain('j1-pty');
    expect(catalogEntry('j1-relay-sim').kind).toBe('conditional');
    for (const id of LANE_IDS) {
      if (await resolveLane(id)) { unregisterLane(id); continue; } // 뒤 패키지가 등록한 레인(아래 시험이 같은 id로 가짜 레인을 등록한다)
      expect(await resolveLane(id)).toBeNull();
    }
  });

  test('registerLane refuses unknown and duplicate ids', () => {
    expect(() => registerLane({id: 'nope' as never, run: async () => ({status: 'pass'})})).toThrow(/unknown lane/);
    registerLane({id: 'j2-model', preconditions: () => [], run: async () => ({status: 'blocked', reason: 'no Secure Enclave'})});
    try {
      expect(() => registerLane({id: 'j2-model', preconditions: () => [], run: async () => ({status: 'pass'})})).toThrow(/already registered/);
    } finally {
      unregisterLane('j2-model');
    }
  });

  test('a conditional lane must declare its preconditions', () => {
    expect(() => registerLane({id: 'j1-relay-sim', run: async () => ({status: 'pass'})})).toThrow(/must declare preconditions/);
    expect(catalogEntry('j1-lan').kind).toBe('unattended');
    registerLane({id: 'j1-lan', run: async () => ({status: 'pass'})});
    unregisterLane('j1-lan');
  });

  test('unknown subcommands and flags are usage errors, list is not a run', async () => {
    expect(await main(['bogus'])).toBe(2);
    expect(await main(['preflight', '--nope'])).toBe(2);
    expect(await main(['preflight', 'all'])).toBe(2);
  });
});

describe('simulator snapshot rule', () => {
  const device = (udid: string, state: string) => ({udid, state, runtime: 'iOS-26-5', name: udid});
  const snapshot = (devices: ReturnType<typeof device>[], extra: Partial<SimulatorSnapshot> = {}): SimulatorSnapshot => ({
    takenAt: 'now', available: true, devices, simulatorAppPids: [606], installedAppPids: [1, 2], screenPids: [3], ...extra,
  });

  test('preexisting devices unchanged and owned devices deleted is the only clean outcome', () => {
    const before = snapshot([device('A', 'Shutdown'), device('B', 'Booted')]);
    expect(compareSimulatorSnapshots(before, snapshot([device('A', 'Shutdown'), device('B', 'Booted')]), ['OWN']).verdict).toBe('unchanged');
    const leftOwned = compareSimulatorSnapshots(before, snapshot([device('A', 'Shutdown'), device('B', 'Booted'), device('OWN', 'Booted')]), ['OWN']);
    expect(leftOwned).toMatchObject({verdict: 'violated', ownedRemaining: ['OWN']});
    const touched = compareSimulatorSnapshots(before, snapshot([device('A', 'Booted'), device('B', 'Booted')]), []);
    expect(touched.preexistingChanged).toEqual([{udid: 'A', before: 'Shutdown', after: 'Booted'}]);
    const deleted = compareSimulatorSnapshots(before, snapshot([device('B', 'Booted')]), []);
    expect(deleted.preexistingChanged).toEqual([{udid: 'A', before: 'Shutdown', after: null}]);
    const launched = compareSimulatorSnapshots(before, snapshot(before.devices, {simulatorAppPids: [606, 900]}), []);
    expect(launched).toMatchObject({verdict: 'violated', simulatorAppLaunched: [900]});
  });

  test('installed app and Screen pid changes are warnings, not violations', () => {
    const before = snapshot([device('A', 'Shutdown')]);
    const result = compareSimulatorSnapshots(before, snapshot(before.devices, {installedAppPids: [1, 5], screenPids: []}), []);
    expect(result.verdict).toBe('unchanged');
    expect(result.warnings.length).toBe(2);
  });

  test('simctl JSON is parsed into UDID/state/runtime rows', () => {
    const rows = parseSimctlDevices(JSON.stringify({devices: {'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{udid: 'B', state: 'Booted', name: 'iPhone'}, {udid: 'A', state: 'Shutdown', name: 'iPad'}]}}));
    expect(rows).toEqual([
      {udid: 'A', state: 'Shutdown', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', name: 'iPad'},
      {udid: 'B', state: 'Booted', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', name: 'iPhone'},
    ]);
  });
});

describe('concurrency guard', () => {
  test('check-ui / check-workroom of another run are detected; our own process tree is not', () => {
    const rows = parsePsRows([
      '  100     1 /usr/bin/python3 mobile/ios/scripts/check-ui.py',
      '  200     1 bun mobile/ios/scripts/check-workroom.ts --device X',
      '  300     1 bun scripts/emulator-e2e.ts j1-lan',
      '  301   300 /usr/bin/python3 mobile/ios/scripts/check-ui.py',
      '  400     1 vim notes-about-check-ui.txt',
    ].join('\n'));
    const own = ownProcessTree(rows, 300);
    expect(own.has(301)).toBe(true);
    expect(findConcurrentChecks(rows, own).map(row => row.pid)).toEqual([100, 200]);
  });

  test('a check-ui.py started by a sibling under the same non-init parent (Orca, tmux, a Workroom) is another run', () => {
    // 검토 #1 회귀: 조상 집합에서 자손을 키우면 같은 Orca 트리 아래의 형제·사촌이 전부 「자기 것」이 됐다.
    const rows = parsePsRows([
      '  10     1 /Applications/Orca.app/Contents/MacOS/Orca',
      '  20    10 /bin/zsh -l',
      '  30    20 tmux new -s work',
      '  40    30 /bin/zsh',
      '  50    40 bun scripts/emulator-e2e.ts all',
      '  51    50 /usr/bin/python3 mobile/ios/scripts/check-ui.py',
      '  60    30 /bin/zsh',
      '  61    60 /usr/bin/python3 mobile/ios/scripts/check-ui.py --device',
      '  70    10 bun mobile/ios/scripts/check-workroom.ts',
      '  80    40 bun mobile/ios/scripts/check-workroom.ts',
    ].join('\n'));
    const own = ownProcessTree(rows, 50);
    // 조상 사슬과 자기 자손만.
    expect([...own].sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50, 51]);
    // 형제(같은 셸 40의 다른 자식 80), 사촌(tmux 30 아래 다른 창 61), 먼 친척(Orca 10의 다른 자식 70)은 다른 실행이다.
    expect(findConcurrentChecks(rows, own).map(row => row.pid)).toEqual([61, 70, 80]);
  });
});

describe('simulator boot lock (kernel flock through lockf)', () => {
  const lockScript = (dir: string) => {
    const script = join(dir, 'hold-lock.ts');
    writeFileSync(script, [
      `import {acquireSimulatorBootLock} from ${JSON.stringify(join(REPO_ROOT, 'scripts', 'emulator-e2e', 'preflight.ts'))};`,
      `import {appendFileSync} from 'node:fs';`,
      `const [lockPath, id, log, holdMs, mode] = process.argv.slice(2);`,
      `const result = await acquireSimulatorBootLock({runId: id!, lockPath: lockPath!, timeoutMs: 30_000, pollMs: 15});`,
      `if (result.status !== 'acquired') { console.log('blocked ' + result.reason); process.exit(3); }`,
      `appendFileSync(log!, 'start ' + id + ' ' + Date.now() + '\\n');`,
      `if (mode === 'hang') { console.log('held'); await new Promise(() => {}); }`,
      `await Bun.sleep(Number(holdMs));`,
      `appendFileSync(log!, 'end ' + id + ' ' + Date.now() + '\\n');`,
      `await result.release();`,
    ].join('\n'));
    return script;
  };

  test('serializes, blocks past its limit, and frees on release', async () => {
    const dir = tempDir('atz-simlock-');
    const lockPath = join(dir, 'sim.lock');
    expect(readSimulatorLock(lockPath)).toMatchObject({held: false});
    const first = await acquireSimulatorBootLock({runId: 'first', lockPath, timeoutMs: 0});
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;
    expect(first.loadavgAtAcquire.length).toBe(3);
    expect(readSimulatorLock(lockPath)).toMatchObject({held: true, holder: {runId: 'first', pid: process.pid}});
    const second = await acquireSimulatorBootLock({runId: 'second', lockPath, timeoutMs: 50, pollMs: 10});
    expect(second).toMatchObject({status: 'blocked', holder: {runId: 'first'}});
    await first.release();
    expect(existsSync(simulatorLockHolderPath(lockPath))).toBe(false);
    expect(readSimulatorLock(lockPath)).toMatchObject({held: false});
    const third = await acquireSimulatorBootLock({runId: 'third', lockPath, timeoutMs: 0});
    expect(third.status).toBe('acquired');
    if (third.status === 'acquired') await third.release();
  }, 30_000);

  test('a leftover lock file or a stale holder note is not a lock; only a live holder blocks', async () => {
    // 검토 #3 회귀: 예전에는 「죽은 보유자」 파일을 지우고 다시 만드는 회수 경쟁이 있었다. 이제 파일·표시는 잠금이 아니다.
    const dir = tempDir('atz-simlock-stale-');
    const lockPath = join(dir, 'sim.lock');
    writeFileSync(lockPath, JSON.stringify({pid: 999_999, processStartedAt: 'unknown', runId: 'dead', acquiredAt: 'x'}));
    writeFileSync(simulatorLockHolderPath(lockPath), JSON.stringify({pid: 999_999, lockfPid: 999_998, runId: 'dead', acquiredAt: 'x'}));
    expect(readSimulatorLock(lockPath)).toMatchObject({held: false, holder: null});
    const taken = await acquireSimulatorBootLock({runId: 'live', lockPath, timeoutMs: 0});
    expect(taken.status).toBe('acquired');
    if (taken.status === 'acquired') {
      expect(readSimulatorLock(lockPath).holder?.runId).toBe('live');
      await taken.release();
    }
  }, 30_000);

  test('a holder that dies (SIGKILL) frees the lock without anyone deleting a file', async () => {
    const dir = tempDir('atz-simlock-dead-');
    const lockPath = join(dir, 'sim.lock');
    const log = join(dir, 'log.txt');
    const holder = Bun.spawn([process.execPath, lockScript(dir), lockPath, 'doomed', log, '0', 'hang'], {stdout: 'pipe', stderr: 'pipe', env: {PATH: '/usr/bin:/bin'}});
    const reader = holder.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    expect(first.trim()).toBe('held');
    expect(readSimulatorLock(lockPath)).toMatchObject({held: true, holder: {runId: 'doomed'}});
    const whileHeld = await acquireSimulatorBootLock({runId: 'waiter', lockPath, timeoutMs: 100, pollMs: 20});
    expect(whileHeld.status).toBe('blocked');
    holder.kill('SIGKILL');
    await holder.exited;
    const after = await acquireSimulatorBootLock({runId: 'after-death', lockPath, timeoutMs: 10_000, pollMs: 20});
    expect(after.status).toBe('acquired');
    if (after.status === 'acquired') await after.release();
  }, 30_000);

  test('concurrent runs never hold the lock at the same time', async () => {
    // 검토 #3 회귀: 여러 프로세스가 동시에 기다릴 때 둘이 함께 들어가지 않는다.
    const dir = tempDir('atz-simlock-race-');
    const lockPath = join(dir, 'sim.lock');
    const log = join(dir, 'log.txt');
    writeFileSync(log, '');
    const script = lockScript(dir);
    const children = Array.from({length: 4}, (_, index) => Bun.spawn([process.execPath, script, lockPath, `run-${index}`, log, '120'], {stdout: 'pipe', stderr: 'pipe', env: {PATH: '/usr/bin:/bin'}}));
    const codes = await Promise.all(children.map(child => child.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    const events = readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' ')).map(([kind, id, at]) => ({kind: kind!, id: id!, at: Number(at)}));
    expect(events.length).toBe(8);
    // 시작·끝이 정확히 번갈아 나온다(겹친 보유가 없다).
    for (let i = 0; i < events.length; i += 2) {
      expect({kind: events[i]!.kind, next: events[i + 1]!.kind, same: events[i]!.id === events[i + 1]!.id}).toEqual({kind: 'start', next: 'end', same: true});
      if (i + 2 < events.length) expect(events[i + 2]!.at).toBeGreaterThanOrEqual(events[i + 1]!.at);
    }
  }, 60_000);
});

describe('lane planning for `all` and single lanes', () => {
  const passing = {status: 'pass', reasons: []} as unknown as PreflightReport;
  const unmet: LaneDefinition = {id: 'j1-relay-sim', preconditions: () => ['127.0.0.1:443 is not bindable (EACCES)'], run: async () => ({status: 'pass'})};

  test('in `all`, a conditional lane whose conditions are unmet is not run and not counted; called directly it is blocked', () => {
    // 검토 #6 회귀: 예전에는 `all`이 조건부 레인을 막힘으로 세서 443이 안 되는 이 Mac에서 영원히 3이었다.
    expect(planLane('j1-relay-sim', 'all', unmet, passing)).toEqual({kind: 'condition-unmet', reasons: ['127.0.0.1:443 is not bindable (EACCES)']});
    expect(planLane('j1-relay-sim', 'single', unmet, passing)).toEqual({kind: 'result', outcome: {status: 'blocked', reason: '127.0.0.1:443 is not bindable (EACCES)'}});
    expect(planLane('j1-relay-sim', 'all', {...unmet, preconditions: () => []}, passing)).toEqual({kind: 'run'});
  });

  test('an unattended lane with unmet preconditions stays blocked in `all`, and preflight failures still block', () => {
    const lan: LaneDefinition = {id: 'j1-lan', preconditions: () => ['no en0 private IPv4'], run: async () => ({status: 'pass'})};
    expect(planLane('j1-lan', 'all', lan, passing)).toEqual({kind: 'result', outcome: {status: 'blocked', reason: 'no en0 private IPv4'}});
    const blocked = {status: 'blocked', reasons: ['worktree inside a registered root']} as unknown as PreflightReport;
    expect(planLane('j1-relay-sim', 'all', unmet, blocked)).toMatchObject({kind: 'result', outcome: {status: 'blocked'}});
    expect(planLane('j2', 'all', null, passing)).toEqual({kind: 'result', outcome: {status: 'skipped', reason: 'not implemented yet'}});
    expect(planLane('j2', 'all', {id: 'j2', preconditions: () => { throw new Error('boom'); }, run: async () => ({status: 'pass'})}, passing))
      .toMatchObject({kind: 'result', outcome: {status: 'fail'}});
  });

  test('condition-unmet lanes stay out of the exit code; `all` with no lane run is not a pass', () => {
    const lanes = [{status: 'pass' as const}, {status: 'pass' as const}];
    expect(summarize(runEntries('all', 'pass', lanes, 'unchanged'))).toMatchObject({overall: 'pass', exitCode: 0, pass: 3});
    expect(summarize(runEntries('all', 'pass', [], 'unchanged'))).toMatchObject({overall: 'skipped', passed: false});
    expect(summarize(runEntries('preflight', 'pass', [], 'unchanged'))).toMatchObject({overall: 'pass', exitCode: 0});
    expect(summarize(runEntries('all', 'pass', lanes, 'violated'))).toMatchObject({overall: 'fail', exitCode: 1});
    expect(summarize(runEntries('j1-relay-sim', 'pass', [{status: 'blocked'}], 'unchanged'))).toMatchObject({overall: 'blocked', exitCode: 3});
  });
});

describe('lane runs are classified by the harness, never by what the lane returned', () => {
  // 재점검 결함(#6 수정이 만든 것): `'reasons' in result`로 갈라서, `reasons`를 실어 보낸 실패 레인이 「조건 미충족」이 되어
  // 종료 코드에서 빠졌다. 이제 분류는 runOneLane의 태그로만 하고, normalizeOutcome은 LaneOutcome의 키만 남긴다.
  const passing = {status: 'pass', reasons: []} as unknown as PreflightReport;
  const ctx = {preflight: passing} as unknown as LaneContext;
  const noHostViolations = (): LaneScope => ({settle: async () => []});
  const quiet = () => {};

  test('normalizeOutcome keeps only LaneOutcome keys', () => {
    expect(normalizeOutcome({status: 'fail', reason: 'viewer never connected', reasons: ['step 3 timed out'], id: 'j1-lan', title: 'spoof', kind: 'condition-unmet'}))
      .toEqual({status: 'fail', reason: 'viewer never connected'});
    expect(normalizeOutcome({status: 'pass', labels: {real: ['simulator app'], standIn: ['fixture shim']}, artifacts: ['lane/host.log'], details: {attempts: 1}, startedAt: 'x'}))
      .toEqual({status: 'pass', labels: {real: ['simulator app'], standIn: ['fixture shim']}, artifacts: ['lane/host.log'], details: {attempts: 1}});
    expect(normalizeOutcome({status: 'pass', labels: 'nope', artifacts: [1], details: ['x'], reason: 3})).toEqual({status: 'pass'});
    expect(normalizeOutcome({status: 'blocked', reasons: ['443 not bindable']})).toEqual({status: 'fail', reason: 'lane reported blocked without a reason'});
    expect(normalizeOutcome(['pass'])).toMatchObject({status: 'fail'});
  });

  test('a failing lane that carries a `reasons` key still fails `all` with exit code 1; only a real unmet condition is left out', async () => {
    registerLane({id: 'j1-lan', run: async () => ({status: 'pass'})});
    registerLane({id: 'j2', run: async () => ({status: 'fail', reason: 'viewer never connected', reasons: ['step 3 timed out']} as LaneOutcome)});
    registerLane({id: 'j1-relay-sim', preconditions: () => ['127.0.0.1:443 is not bindable (EACCES)'], run: async () => ({status: 'pass'})});
    try {
      const logs: string[] = [];
      const {lanes, conditionUnmet} = await runLanes(['j1-lan', 'j2', 'j1-relay-sim'], 'all', ctx, noHostViolations, line => logs.push(line));
      expect(lanes.map(lane => [lane.id, lane.status])).toEqual([['j1-lan', 'pass'], ['j2', 'fail']]);
      expect(lanes[1]).toMatchObject({id: 'j2', status: 'fail', reason: 'viewer never connected'});
      expect(Object.keys(lanes[1]!)).not.toContain('reasons');
      expect(conditionUnmet.map(entry => entry.id)).toEqual(['j1-relay-sim']);
      expect(logs.some(line => line.startsWith('lane j2: condition unmet'))).toBe(false);
      expect(logs).toContain('lane j2: fail — viewer never connected');
      expect(summarize(runEntries('all', 'pass', lanes, 'unchanged'))).toMatchObject({overall: 'fail', fail: 1, exitCode: 1});
    } finally {
      unregisterLane('j1-lan');
      unregisterLane('j2');
      unregisterLane('j1-relay-sim');
    }
  });

  test('a lane cannot rename itself or pose as condition-unmet by returning harness keys', async () => {
    registerLane({id: 'j2', run: async () => ({status: 'pass', id: 'j1-lan', title: 'spoofed', kind: 'condition-unmet', unmet: {reasons: ['x']}} as LaneOutcome)});
    try {
      const {lanes, conditionUnmet} = await runLanes(['j2'], 'all', ctx, noHostViolations, quiet);
      expect(conditionUnmet).toEqual([]);
      expect(lanes).toHaveLength(1);
      expect(lanes[0]).toMatchObject({id: 'j2', title: catalogEntry('j2').title, status: 'pass'});
      expect(Object.keys(lanes[0]!).sort()).toEqual(['durationMs', 'id', 'startedAt', 'status', 'title']);
    } finally {
      unregisterLane('j2');
    }
  });

  test('a host-guard violation turns any lane outcome into a failure; a failing settle is a failure too', async () => {
    registerLane({id: 'j1-lan', run: async () => ({status: 'pass'})});
    try {
      const violation = 'LAN binding guard port 45100 (only 192.168.0.20): listens on *:45100 (only 192.168.0.20:45100 is allowed)';
      let settled = 0;
      const guarded = await runLanes(['j1-lan'], 'single', ctx, () => ({settle: async () => { settled += 1; return [violation]; }}), quiet);
      expect(settled).toBe(1);
      expect(guarded.lanes[0]).toMatchObject({id: 'j1-lan', status: 'fail'});
      expect(guarded.lanes[0]!.reason).toContain(violation);
      expect(guarded.lanes[0]!.reason).toContain('lane reported pass');
      const broken = await runLanes(['j1-lan'], 'single', ctx, () => ({settle: async () => { throw new Error('lsof gone'); }}), quiet);
      expect(broken.lanes[0]).toMatchObject({status: 'fail'});
      expect(broken.lanes[0]!.reason).toContain("settling the lane's hosts failed: lsof gone");
      const clean = await runLanes(['j1-lan'], 'single', ctx, noHostViolations, quiet);
      expect(clean.lanes[0]).toMatchObject({status: 'pass'});
      expect(summarize(runEntries('j1-lan', 'pass', guarded.lanes, 'unchanged'))).toMatchObject({overall: 'fail', exitCode: 1});
    } finally {
      unregisterLane('j1-lan');
    }
  });
});

describe('unsandboxed perf mode', () => {
  test('is refused while the harness runs (the lane escape hatch is closed)', async () => {
    // 검토 #5 회귀.
    const base = tempDir('atz-perf-refused-');
    const root = isolatedRoot(base, 'refused');
    const release = markHarnessActive();
    try {
      expect(isHarnessActive()).toBe(true);
      await expect(startSidecar(root, 'source', {sandbox: 'unsandboxed-perf-measurement'})).rejects.toThrow(/refused while the emulator harness runs/);
    } finally {
      release();
      release();
    }
    expect(isHarnessActive()).toBe(false);
  });

  test('no harness file other than the launcher mentions it', () => {
    const files = ['scripts/emulator-e2e.ts', ...readdirSync(join(REPO_ROOT, 'scripts', 'emulator-e2e')).filter(name => name.endsWith('.ts')).map(name => `scripts/emulator-e2e/${name}`)];
    const offenders = files.filter(file => file !== 'scripts/emulator-e2e/isolatedSidecar.ts')
      .filter(file => /unsandboxed-perf-measurement|PERF_MEASUREMENT_MODE/.test(readFileSync(join(REPO_ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
    const launcher = readFileSync(join(REPO_ROOT, 'scripts', 'emulator-e2e', 'isolatedSidecar.ts'), 'utf8');
    expect(launcher).toContain("export const PERF_MEASUREMENT_MODE = 'unsandboxed-perf-measurement' as const;");
  });

  test('keeps the baseline measurement environment (no NODE_ENV, no PORT, inherited PATH/TMPDIR, origin :9000)', () => {
    // 검토 #8 회귀: docs/perf/baseline.json을 잰 환경과 같은 키·값.
    const base = tempDir('atz-perf-env-');
    const root = isolatedRoot(base, 'perf');
    const env = buildPerfMeasurementEnv(root, 45_678, {...POLLUTED, PATH: '/opt/homebrew/bin:/usr/bin:/bin', TMPDIR: '/var/folders/x/T/', NODE_ENV: 'production', PORT: '1234'});
    expect(Object.keys(env).sort()).toEqual([
      'AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP', 'AGENTSTOZ_SKIP_HERMES_SYNC', 'AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC', 'AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC',
      'API_PORT', 'APPDATA', 'APP_DATA_DIR', 'HERMES_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'USERPROFILE', 'XDG_CONFIG_HOME',
    ]);
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(env.TMPDIR).toBe('/var/folders/x/T/');
    expect(env.API_PORT).toBe('45678');
    expect(env.HOME).toBe(root.home);
    expect(env.APP_DATA_DIR).toBe(root.appDataDir);
    expect(env.APPDATA).toBe(join(root.root, 'roaming'));
    expect(env.XDG_CONFIG_HOME).toBe(join(root.home, '.config'));
    expect(env.HERMES_HOME).toBe(join(root.home, '.hermes'));
    for (const key of FORBIDDEN_ENV_KEYS.filter(key => key !== 'API_PORT')) expect(env[key]).toBeUndefined();
    expect(PERF_MANAGEMENT_ORIGIN).toBe('http://localhost:9000');
    expect(() => buildPerfMeasurementEnv(root, 3001)).toThrow(/reserved/);
  });
});
