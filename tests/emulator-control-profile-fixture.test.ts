/**
 * WP10 — 공유 제어 폴더 프로필 픽스처 레시피(scripts/emulator-e2e/controlProfileFixture.ts)와 대화 기기 키 대역
 * (dialogueKeychainStandIn.ts · dialogue-keychain-entry.ts).
 *
 * - 순수 판정(대화 DB 덤프·controlDevices)과 대역 스크립트의 동작(security와 같은 종료 코드)을 본다.
 * - 레시피가 손으로 추정한 파일 형식에 기대지 않는다는 것을 **실제 코드로** 증명한다: 두 스크래치 Mac에 seed 자식이 실제
 *   initializeProjectMemory로 OPS 폴더를 만들고, 실제 createControlProfileHost.prepare가 binding/access를 쓰고, verify 자식이
 *   실제 ControlProfileStore.sharedProfileId()로 같은 픽스처 id를 돌려받는다(deviceId는 Mac마다 다르다). darwin + sandbox-exec가
 *   있으면 seed·verify 자식은 WP1 샌드박스 안에서 돈다.
 * - 두 사이드카가 shim을 거쳐 서로를 controlDevices로 보는 종단 확인은 레인(`bun scripts/emulator-e2e.ts j4-fixture`)이 한다 —
 *   레인은 등록 루트 밖 복사본에서만 돈다.
 */
import {afterAll, describe, expect, test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {planSidecarBuild} from '../build-sidecar';
import {createControlProfileHost} from '../control-profile-server';
import {CONTROL_PROFILE_MARKER} from '../src/controlProfileContract';
import {OPS_FOLDER_NAME as PRODUCT_OPS_FOLDER_NAME} from '../src/opsFolderName';
import {HARNESS_SOURCE_FILES, LANE_IDS, catalogEntry, lanesForAll, resolveLane} from '../scripts/emulator-e2e';
import {
  CONTROL_PROFILE_FIXTURE_SCRIPT,
  DIALOGUE_KEYCHAIN_ENTRY,
  J4_FIXTURE_LABELS,
  LANE_ID,
  OPS_FOLDER_NAME,
  assertDistinctMacs,
  communityMacPortal,
  communityMacPorts,
  communityMacSpecs,
  judgeControlDevices,
  judgeDialogueDump,
  judgeProjectsAnswer,
  newSharedProfileFixture,
  runFixtureChild,
  settleCommunityStartups,
  summarizeHostSideEffects,
  type MacEndpointExpectation,
  type SeedReport,
  type VerifyReport,
} from '../scripts/emulator-e2e/controlProfileFixture';
import {
  DIALOGUE_KEYCHAIN_ACCOUNT,
  DIALOGUE_KEYCHAIN_SERVICE,
  KEYCHAIN_DUPLICATE_ITEM,
  KEYCHAIN_ITEM_NOT_FOUND,
  REAL_SECURITY,
  dialogueKeychainCall,
  installDialogueKeychainStandIn,
  readKeychainStandInLog,
  summarizeKeychainStandIn,
  writeKeychainStandIn,
} from '../scripts/emulator-e2e/dialogueKeychainStandIn';
import {LANE_ENTRY_WRAPPER_DIR, PERF_MEASUREMENT_MODE, assertLaneEntryWrapper, reserveLoopbackPort, type SidecarSandbox} from '../scripts/emulator-e2e/isolatedSidecar';
import {buildAllowlistedEnv, createIsolatedProfile, realHome, type AllowlistedEnvInput} from '../scripts/emulator-e2e/environment';
import {sandboxedArgv, writeSandboxProfile, type WrittenSandboxProfile} from '../scripts/emulator-e2e/sandbox';

const REPO_ROOT = resolve(import.meta.dir, '..');
/** seed·verify 자식은 project-memory-server를 읽는다(수 초). 부하 아래에서도 조용히 빠지지 않게 넉넉히. */
const CHILD_TEST_TIMEOUT_MS = 240_000;
const MAC_ARGS = ['-a', DIALOGUE_KEYCHAIN_ACCOUNT, '-s', DIALOGUE_KEYCHAIN_SERVICE, '-w'];
const roots: string[] = [];
function scratch(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `atz-wp10-${label}-`)));
  roots.push(root);
  return root;
}
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

function runStandIn(script: string, args: string[], stdin?: string): {code: number | null; stdout: string} {
  const result = Bun.spawnSync([script, ...args], {stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', env: {PATH: '/usr/bin:/bin'}});
  return {code: result.exitCode, stdout: result.stdout.toString()};
}

describe('agent-dialogue device key stand-in', () => {
  test('the constants are the product\'s own keychain item and security call', () => {
    const host = readFileSync(join(REPO_ROOT, 'src/agentDialogueHost.ts'), 'utf8');
    expect(host).toContain(`keychainService:'${DIALOGUE_KEYCHAIN_SERVICE}'`);
    expect(host).toContain(`keychainAccount:'${DIALOGUE_KEYCHAIN_ACCOUNT}'`);
    const provider = readFileSync(join(REPO_ROOT, 'src/promptGuideKeyProvider.ts'), 'utf8');
    expect(provider).toContain("const macArgs = ['-a', namespace.keychainAccount, '-s', namespace.keychainService, '-w'];");
    expect(provider).toContain(`command('${REAL_SECURITY}', ['find-generic-password', ...macArgs])`);
    expect(provider).toContain(`command('${REAL_SECURITY}', ['add-generic-password', ...macArgs], stdin)`);
    expect(provider).toContain('if (result.status === 44) return null;');
    expect(KEYCHAIN_ITEM_NOT_FOUND).toBe(44);
  });

  test('only the exact find/add call for the dialogue device key is matched', () => {
    expect(dialogueKeychainCall(REAL_SECURITY, ['find-generic-password', ...MAC_ARGS])).toBe('find');
    expect(dialogueKeychainCall(REAL_SECURITY, ['add-generic-password', ...MAC_ARGS])).toBe('add');
    // 다른 키체인 항목(음성 기록·프롬프트 가이드)·다른 동작·다른 실행 파일·인자 수는 손대지 않는다.
    expect(dialogueKeychainCall(REAL_SECURITY, ['find-generic-password', '-a', 'voice-history', '-s', 'com.agentstoz.voice.history.v1', '-w'])).toBeNull();
    expect(dialogueKeychainCall(REAL_SECURITY, ['delete-generic-password', ...MAC_ARGS])).toBeNull();
    expect(dialogueKeychainCall(REAL_SECURITY, ['find-generic-password', ...MAC_ARGS, '-g'])).toBeNull();
    expect(dialogueKeychainCall('security', ['find-generic-password', ...MAC_ARGS])).toBeNull();
    expect(dialogueKeychainCall(REAL_SECURITY, 'find-generic-password')).toBeNull();
  });

  test('the spawn wrapper sends only that call to the stand-in and passes everything else through unchanged', () => {
    const calls: unknown[][] = [];
    const childProcess = {spawn: (...args: unknown[]) => { calls.push(args); return {pid: calls.length}; }};
    const installed = installDialogueKeychainStandIn(childProcess, '/scratch/keychain-standin/security');
    childProcess.spawn(REAL_SECURITY, ['find-generic-password', ...MAC_ARGS], {stdio: 'pipe'});
    childProcess.spawn(REAL_SECURITY, ['find-generic-password', '-a', 'voice-history', '-s', 'com.agentstoz.voice.history.v1', '-w']);
    childProcess.spawn('/usr/bin/git', ['status']);
    expect(installed.redirected()).toBe(1);
    expect(calls[0]).toEqual(['/scratch/keychain-standin/security', ['find-generic-password', ...MAC_ARGS], {stdio: 'pipe'}]);
    expect(calls[1]![0]).toBe(REAL_SECURITY);
    expect(calls[2]![0]).toBe('/usr/bin/git');
    expect(() => installDialogueKeychainStandIn(childProcess, 'relative/security')).toThrow();
  });

  test('the stand-in script answers like security(1) for that one item and records only operations', () => {
    const standIn = writeKeychainStandIn(join(scratch('keychain'), 'keychain-standin'));
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(runStandIn(standIn.scriptPath, ['find-generic-password', ...MAC_ARGS]).code).toBe(KEYCHAIN_ITEM_NOT_FOUND);
    expect(runStandIn(standIn.scriptPath, ['add-generic-password', ...MAC_ARGS], `${key}\n${key}\n`).code).toBe(0);
    const found = runStandIn(standIn.scriptPath, ['find-generic-password', ...MAC_ARGS]);
    expect(found.code).toBe(0);
    expect(found.stdout).toBe(`${key}\n`);
    // Add-only: 이미 있으면 덮어쓰지 않는다.
    expect(runStandIn(standIn.scriptPath, ['add-generic-password', ...MAC_ARGS], `other\nother\n`).code).toBe(KEYCHAIN_DUPLICATE_ITEM);
    expect(readFileSync(standIn.storePath, 'utf8')).toBe(`${key}\n`);
    // 다른 항목·확인 불일치는 거절하고 기록한다.
    expect(runStandIn(standIn.scriptPath, ['find-generic-password', '-a', 'x', '-s', 'y', '-w']).code).toBe(1);
    expect(runStandIn(join(standIn.dir, 'security'), ['add-generic-password', ...MAC_ARGS], 'a\nb\n').code).toBe(1);
    const log = readKeychainStandInLog(standIn.logPath);
    expect(readFileSync(standIn.logPath, 'utf8')).not.toContain(key);
    expect(log.map(entry => `${entry.op}:${entry.outcome}`)).toEqual(['find:absent', 'add:added', 'find:found', 'add:duplicate', 'unknown:refused', 'add:mismatch']);
    const summary = summarizeKeychainStandIn(log);
    expect(summary.refused).toBe(2);
    expect(summary.createdOnce).toBe(false); // duplicate가 있었다
    expect(summarizeKeychainStandIn(log.slice(0, 3))).toEqual({calls: 3, byOutcome: {'find:absent': 1, 'add:added': 1, 'find:found': 1}, refused: 0, createdOnce: true});
    expect(() => writeKeychainStandIn('/tmp/has space/x')).toThrow();
  });

  test('the lane entry wrapper is only accepted for the source sidecar and is no production entry', () => {
    const profile = {path: '/x', sha256: 'y'} as unknown as SidecarSandbox;
    expect(() => assertLaneEntryWrapper(DIALOGUE_KEYCHAIN_ENTRY, 'source', profile)).not.toThrow();
    expect(() => assertLaneEntryWrapper(DIALOGUE_KEYCHAIN_ENTRY, 'installed', profile)).toThrow('source entry only');
    expect(() => assertLaneEntryWrapper(DIALOGUE_KEYCHAIN_ENTRY, 'source', PERF_MEASUREMENT_MODE)).toThrow('perf measurement');
    expect(() => assertLaneEntryWrapper(join(REPO_ROOT, 'api-server.ts'), 'source', profile)).toThrow('under');
    expect(() => assertLaneEntryWrapper(join(LANE_ENTRY_WRAPPER_DIR, 'controlProfileFixture.ts'), 'source', profile)).toThrow('-entry.ts');
    expect(() => assertLaneEntryWrapper(join(LANE_ENTRY_WRAPPER_DIR, 'missing-entry.ts'), 'source', profile)).toThrow('-entry.ts');
    expect(() => assertLaneEntryWrapper(`${LANE_ENTRY_WRAPPER_DIR}/../emulator-e2e/dialogue-keychain-entry.ts`, 'source', profile)).toThrow();
    const plan = planSidecarBuild({kind: 'development'}, {projectRoot: REPO_ROOT, platform: 'darwin', arch: 'arm64', bunExecutable: '/opt/bun/bin/bun'});
    const entries = [...plan.commands.map(command => command.entrypoint), ...plan.nativeCommands.map(command => command.entrypoint)];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry).not.toMatch(/emulator-e2e|keychain/i);
    expect(plan.commands.flatMap(command => command.args).join('\n')).not.toMatch(/dialogue-keychain-entry|dialogueKeychainStandIn/);
    expect(readFileSync(join(REPO_ROOT, 'build-sidecar.ts'), 'utf8')).not.toMatch(/dialogue-keychain-entry|dialogueKeychainStandIn/);
  });

  test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))('the entry wrapper refuses to start (exit 64, before loading the server) unless both values are its own', () => {
    const root = scratch('wrapper');
    const appData = join(root, 'mac', 'app-data');
    mkdirSync(appData, {recursive: true});
    const inside = writeKeychainStandIn(join(root, 'mac', 'keychain-standin'));
    const outside = writeKeychainStandIn(join(root, 'elsewhere'));
    const port = reserveLoopbackPort();
    const profile = writeSandboxProfile(join(root, 'sandbox'), 'wrapper', {writableRoots: [join(root, 'mac'), join(root, 'elsewhere')]});
    const run = (env: Record<string, string>) => {
      const result = Bun.spawnSync(sandboxedArgv(profile, [process.execPath, '--env-file=/dev/null', DIALOGUE_KEYCHAIN_ENTRY]), {cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000, env: {PATH: '/usr/bin:/bin', HOME: root, API_PORT: String(port), ...env}});
      return {code: result.exitCode, stderr: result.stderr.toString()};
    };
    const apiServer = join(REPO_ROOT, 'api-server.ts');
    expect(run({})).toMatchObject({code: 64});
    expect(run({AGENTSTOZ_EMULATOR_NEXT_ENTRY: join(REPO_ROOT, 'build-sidecar.ts'), AGENTSTOZ_EMULATOR_KEYCHAIN_STANDIN: inside.scriptPath, APP_DATA_DIR: appData}).stderr).toContain('must be the side-effect guard or api-server.ts');
    expect(run({AGENTSTOZ_EMULATOR_NEXT_ENTRY: apiServer, APP_DATA_DIR: appData}).stderr).toContain('must name an existing stand-in script');
    const foreign = run({AGENTSTOZ_EMULATOR_NEXT_ENTRY: apiServer, AGENTSTOZ_EMULATOR_KEYCHAIN_STANDIN: outside.scriptPath, APP_DATA_DIR: appData});
    expect(foreign.code).toBe(64);
    expect(foreign.stderr).toContain('must live inside this sidecar');
    expect(run({AGENTSTOZ_EMULATOR_NEXT_ENTRY: apiServer, AGENTSTOZ_EMULATOR_KEYCHAIN_STANDIN: inside.scriptPath}).stderr).toContain('APP_DATA_DIR must be');
  }, CHILD_TEST_TIMEOUT_MS);
});

describe('lane registration', () => {
  test('j4-fixture is an unattended WP10 lane that loads, with its sources in the harness digest', async () => {
    expect(LANE_IDS).toContain(LANE_ID);
    expect(catalogEntry(LANE_ID)).toMatchObject({kind: 'unattended', workPackage: 'WP10'});
    expect(lanesForAll()).toContain(LANE_ID);
    const lane = await resolveLane(LANE_ID);
    expect(lane?.id).toBe(LANE_ID);
    for (const file of ['scripts/emulator-e2e/controlProfileFixture.ts', 'scripts/emulator-e2e/dialogueKeychainStandIn.ts', 'scripts/emulator-e2e/dialogue-keychain-entry.ts']) {
      expect(HARNESS_SOURCE_FILES).toContain(file);
      expect(existsSync(join(REPO_ROOT, file))).toBe(true);
    }
    expect(J4_FIXTURE_LABELS.real.length).toBeGreaterThan(0);
    expect(J4_FIXTURE_LABELS.standIn.some(line => line.includes('Keychain'))).toBe(true);
    expect(J4_FIXTURE_LABELS.standIn.some(line => line.includes('PGlite shim'))).toBe(true);
  });

  test('the fixture uses the product\'s own OPS folder name and profile marker', () => {
    expect(OPS_FOLDER_NAME).toBe(PRODUCT_OPS_FOLDER_NAME);
    const source = readFileSync(CONTROL_PROFILE_FIXTURE_SCRIPT, 'utf8');
    // 표식 파일 이름을 문자열로 다시 쓰지 않는다 — 자식이 계약 모듈의 상수를 읽는다.
    expect(source).toContain('contract.CONTROL_PROFILE_MARKER');
    expect(source).not.toContain(`'${CONTROL_PROFILE_MARKER}'`);
    // 오케스트레이터 쪽은 호스트 코드를 정적으로 import하지 않는다(자식 모드만 동적으로).
    const staticImports = new Bun.Transpiler({loader: 'ts'}).scanImports(source).filter(entry => entry.kind === 'import-statement').map(entry => entry.path);
    expect(staticImports).toContain('./dialogueKeychainStandIn');
    const multiline = new Bun.Transpiler({loader: 'ts'}).scanImports("import {\n initializeProjectMemory\n} from '../../project-memory-server';");
    expect(multiline.some(entry => entry.kind === 'import-statement' && entry.path === '../../project-memory-server')).toBe(true);
    expect(staticImports.filter(path => /\.\.\/\.\.\/|\/src\/|project-memory-server|control-profile-server/.test(path))).toEqual([]);
  });
});

test('partial startup failure waits for late sidecars and stops each of them', async () => {
  const started: Array<{stop(): Promise<void>}> = [];
  const stopped: string[] = [];
  let completeLate!: () => void;
  const late = new Promise<string>(resolve => { completeLate = () => {
    started.push({stop: async () => { stopped.push('late'); }});
    resolve('late');
  }; });
  started.push({stop: async () => { stopped.push('early'); }});
  const result = settleCommunityStartups([Promise.reject(new Error('seed failure')), late], started);
  completeLate();
  await expect(result).rejects.toThrow('seed failure');
  expect(stopped.sort()).toEqual(['early', 'late']);
});

describe('fixture specs and judges (pure)', () => {
  test('two Macs share nothing that identifies a device', () => {
    const specs = communityMacSpecs();
    expect(specs.map(spec => spec.label)).toEqual(['a', 'b']);
    expect(specs[0]!.deviceId).not.toBe(specs[1]!.deviceId);
    expect(() => assertDistinctMacs([specs[0]!, {...specs[1]!, deviceId: specs[0]!.deviceId}])).toThrow('deviceId');
    expect(() => assertDistinctMacs([specs[0]!])).toThrow('two Macs');
    expect(() => communityMacSpecs(['A'])).toThrow();
    const shared = newSharedProfileFixture();
    expect(shared.profileId).not.toBe(shared.memoryId);
    const ports = communityMacPorts(specs[0]!, {opsFolder: '/s/AgentsToZ-OPS', projectFolder: '/s/p'});
    expect(ports[0]).toEqual({id: specs[0]!.opsProjectId, name: 'AgentsToZ-OPS', role: 'ops', folderPath: '/s/AgentsToZ-OPS', category: '프로젝트'});
    expect(communityMacPortal(specs[1]!, {url: 'http://127.0.0.1:5', anonKey: 'k'})).toEqual({supabaseUrl: 'http://127.0.0.1:5', supabaseAnonKey: 'k', deviceId: specs[1]!.deviceId, deviceName: 'Fixture Mac B'});
  });

  const profileId = randomUUID();
  const a: MacEndpointExpectation = {label: 'a', deviceId: randomUUID(), endpointId: randomUUID()};
  const b: MacEndpointExpectation = {label: 'b', deviceId: randomUUID(), endpointId: randomUUID()};
  const roomId = randomUUID();
  const controlAB = randomUUID();
  const controlBA = randomUUID();
  const controlRows = (id: string, from: string, to: string) => ['pending', 'taken', 'done'].map((state, index) => ({control_id: id, event: index ? 'update' : 'insert', state, from_endpoint_id: from, to_endpoint_id: to, request_kind: 'projects'}));
  const goodDump = () => ({
    tables: {
      portmgr_agent_dialogue_device_keys: [a, b].map(mac => ({profile_id: profileId, device_id: mac.deviceId, secret_hash: '[redacted]', revoked_at: null})),
      portmgr_agent_dialogue_endpoints: [a, b].map(mac => ({endpoint_id: mac.endpointId, profile_id: profileId, device_id: mac.deviceId, kind: 'ops', state: 'active'})),
      portmgr_agent_dialogue_rooms: [{room_id: roomId, profile_id: profileId, kind: 'community', state: 'active'}],
      portmgr_agent_dialogue_members: [a, b].map(mac => ({room_id: roomId, endpoint_id: mac.endpointId, state: 'joined'})),
    },
    audit: {dialogue_controls: [...controlRows(controlAB, a.endpointId, b.endpointId), ...controlRows(controlBA, b.endpointId, a.endpointId)]},
  });
  const controls = [{from: 'a', to: 'b', kind: 'projects'}, {from: 'b', to: 'a', kind: 'projects'}];

  test('a dialogue dump passes only with one shared profile, two live devices, two joined OPS endpoints and each control run once', () => {
    const judged = judgeDialogueDump(goodDump(), {profileId, macs: [a, b], controls});
    expect(judged.problems).toEqual([]);
    expect(judged.facts).toEqual({deviceKeys: 2, activeOpsEndpoints: 2, communityRooms: 1, joinedMembers: 2, controlsDone: 2, otherProfileRows: 0});

    const otherProfile = goodDump();
    otherProfile.tables.portmgr_agent_dialogue_device_keys[1]!.profile_id = randomUUID();
    expect(judgeDialogueDump(otherProfile, {profileId, macs: [a, b], controls}).problems.join('\n')).toMatch(/other than the fixture profile[\s\S]*Mac b: no live device key/);

    const revoked = goodDump();
    (revoked.tables.portmgr_agent_dialogue_device_keys[0] as Record<string, unknown>).revoked_at = '2026-11-01T00:00:00Z';
    expect(judgeDialogueDump(revoked, {profileId, macs: [a, b], controls}).problems.join('\n')).toContain('Mac a: no live device key');

    const outside = goodDump();
    outside.tables.portmgr_agent_dialogue_members[1]!.state = 'left';
    expect(judgeDialogueDump(outside, {profileId, macs: [a, b], controls}).problems.join('\n')).toContain('Mac b: its OPS endpoint is not a joined community member');

    const wrongEndpoint = goodDump();
    expect(judgeDialogueDump(wrongEndpoint, {profileId, macs: [a, {...b, endpointId: randomUUID()}], controls}).problems.join('\n')).toContain('Mac b: the active OPS endpoint is not the one enable() returned');

    const twice = goodDump();
    twice.audit.dialogue_controls.push({control_id: controlAB, event: 'update', state: 'done', from_endpoint_id: a.endpointId, to_endpoint_id: b.endpointId, request_kind: 'projects'});
    expect(judgeDialogueDump(twice, {profileId, macs: [a, b], controls}).problems.join('\n')).toContain('control a→b projects: taken 1× · done 2×');

    const missing = goodDump();
    missing.audit.dialogue_controls = missing.audit.dialogue_controls.filter(row => row.control_id !== controlBA);
    expect(judgeDialogueDump(missing, {profileId, macs: [a, b], controls}).problems.join('\n')).toContain('control b→a projects: 0 request row(s)');

    expect(judgeDialogueDump(null, {profileId, macs: [a, b]}).problems.length).toBeGreaterThan(0);
  });

  test('controlDevices must show the other Mac through its OPS endpoint and never this Mac itself', () => {
    const answer = {inside: true, deviceId: a.deviceId, devices: [{endpointId: b.endpointId, deviceId: b.deviceId, kind: 'ops', displayName: 'Fixture Mac B'}]};
    expect(judgeControlDevices(answer, a, [b])).toEqual([]);
    expect(judgeControlDevices({...answer, inside: false}, a, [b])).toContain('Mac a: controlDevices says it is not inside the community');
    expect(judgeControlDevices({...answer, devices: []}, a, [b]).join('\n')).toContain('does not see Mac b');
    expect(judgeControlDevices({...answer, devices: [...answer.devices, {endpointId: a.endpointId, deviceId: a.deviceId, kind: 'ops'}]}, a, [b]).join('\n')).toContain('lists itself');
    expect(judgeControlDevices({...answer, devices: [{...answer.devices[0]!, kind: 'project'}]}, a, [b]).join('\n')).toContain('another endpoint');
  });

  test('host side effects: refused desktop launches are reported, security outcomes are counted', () => {
    const summary = summarizeHostSideEffects([
      {api: 'guard', command: 'start', outcome: 'installed'},
      {api: 'child_process.spawn', command: 'security', outcome: 'spawned'},
      {api: 'child_process.spawn', command: 'security', outcome: 'spawn-error', code: 'EPERM'},
      {api: 'Bun.spawn', command: 'open', outcome: 'refused-by-wrapper'},
    ]);
    expect(summary).toEqual({refusedByWrapper: ['open via Bun.spawn'], security: {'child_process.spawn spawned': 1, 'child_process.spawn spawn-error:EPERM': 1}, total: 3});
  });

  test('a projects answer counts only when the other Mac answered with its own name, OPS registration and project', () => {
    const [spec] = communityMacSpecs();
    const body = {deviceName: spec!.deviceName, opsTargetId: spec!.opsProjectId, projects: [{targetId: spec!.projectId, label: spec!.projectName}]};
    expect(judgeProjectsAnswer({ok: true, body}, spec!, 'b')).toEqual({problems: [], summary: {ok: true, deviceName: spec!.deviceName, opsTargetIsOwnRegistration: true, projectLabels: [spec!.projectName]}});
    // controlPoll의 봉투를 벗기지 않고 읽으면(예전 레인의 실수) 전부 비어 보인다 — 그것은 실패다.
    expect(judgeProjectsAnswer(body, spec!, 'b').problems).toEqual(['control b→a: the other Mac answered ok=undefined']);
    expect(judgeProjectsAnswer({ok: false, error: '지원하지 않는 기기 제어 요청입니다.'}, spec!, 'b').problems[0]).toContain('지원하지 않는');
    expect(judgeProjectsAnswer({ok: true, body: {...body, deviceName: 'Fixture Mac B'}}, spec!, 'b').problems).toEqual(['control b→a: answered by "Fixture Mac B", not Mac a']);
    expect(judgeProjectsAnswer({ok: true, body: {...body, opsTargetId: null, projects: []}}, spec!, 'b').problems).toHaveLength(2);
  });
});

describe('recipe on the real ControlProfileStore (two scratch Macs, no sidecar)', () => {
  test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))('both stores bind the fixture profile from the shared marker; deviceIds and access keys differ', async () => {
    const root = scratch('recipe');
    const work = join(root, 'work');
    mkdirSync(work, {recursive: true, mode: 0o700});
    const hostSandbox: WrittenSandboxProfile = writeSandboxProfile(join(root, 'sandbox'), 'host', {writableRoots: [work]});
    const ctx = {
      hostSandbox,
      allowlistedEnv: (input: AllowlistedEnvInput) => buildAllowlistedEnv({...input, home: realHome()}),
    };
    const shared = newSharedProfileFixture();
    const specs = communityMacSpecs();
    const results: VerifyReport[] = [];
    for (const spec of specs) {
      const mac = createIsolatedProfile(work, `mac-${spec.label}`);
      const opsFolder = join(mac.root, 'projects', OPS_FOLDER_NAME);
      const projectFolder = join(mac.root, 'projects', `fixture-${spec.label}`);
      mkdirSync(opsFolder, {recursive: true});
      mkdirSync(projectFolder, {recursive: true});
      // 음성 대조: 준비 전에는 공유 프로필이 없다.
      const before = await runFixtureChild<VerifyReport>(ctx, mac, ['verify', '--app-data', mac.appDataDir]);
      expect(before.sharedProfileId).toBeNull();
      expect(before.status.state).toBe('unprepared');
      const seeded = await runFixtureChild<SeedReport>(ctx, mac, ['seed', '--ops-folder', opsFolder, '--profile-id', shared.profileId, '--memory-id', shared.memoryId]);
      expect(seeded).toMatchObject({event: 'seeded', memoryId: shared.memoryId, memoryInitialized: true, markerFile: CONTROL_PROFILE_MARKER});
      // 다른 Mac의 폴더를 seed하라고 하면 거절한다(자식은 자기 격리 루트 안만 쓴다).
      if (spec.label === 'b') {
        await expect(runFixtureChild(ctx, mac, ['seed', '--ops-folder', join(results[0]!.appDataDir, '..', 'projects', OPS_FOLDER_NAME), '--profile-id', shared.profileId, '--memory-id', shared.memoryId])).rejects.toThrow('isolated root');
      }
      const ports = communityMacPorts(spec, {opsFolder, projectFolder});
      writeFileSync(join(mac.appDataDir, 'portal.json'), JSON.stringify(communityMacPortal(spec, {url: 'http://127.0.0.1:9', anonKey: 'unused'})));
      // 사이드카의 관리 경로와 같은 함수(createControlProfileHost.prepare) — 이 테스트에서는 프로세스 안에서 부른다.
      const host = createControlProfileHost({
        appDataDir: mac.appDataDir, portalDataFile: join(mac.appDataDir, 'portal.json'), gitPath: '/nonexistent/git', ghPath: '/nonexistent/gh',
        registered: async () => ports as Array<{id: string; name?: string; folderPath?: string}>,
        register: async () => { throw new Error('the fixture never registers a new OPS folder'); },
        lease: async (_root, _label, operation) => operation(),
      });
      const prepared = await host.prepare(spec.opsProjectId);
      expect(prepared).toMatchObject({state: 'ready', profileId: shared.profileId, memoryId: shared.memoryId, backend: 'control-folder', projectId: spec.opsProjectId});
      const verified = await runFixtureChild<VerifyReport>(ctx, mac, ['verify', '--app-data', mac.appDataDir]);
      expect(verified.sharedProfileId).toBe(shared.profileId);
      expect(verified.status).toMatchObject({state: 'ready', profileId: shared.profileId, memoryId: shared.memoryId, backend: 'control-folder', projectId: spec.opsProjectId, problem: null});
      expect(verified.location).toMatchObject({state: 'ready', backend: 'control-folder', projectId: spec.opsProjectId, rootIsOpsFolder: true});
      expect(verified.accessProfileId).toBe(shared.profileId);
      expect(verified.accessTokenSha256Prefix).toMatch(/^[0-9a-f]{12}$/);
      expect(JSON.stringify(verified)).not.toMatch(/[0-9a-f]{64}/); // 연결 키 값은 나오지 않는다
      // 다른 Mac의 앱 데이터는 읽지 않는다.
      if (spec.label === 'b') {
        await expect(runFixtureChild(ctx, mac, ['verify', '--app-data', results[0]!.appDataDir])).rejects.toThrow('own APP_DATA_DIR');
      }
      results.push(verified);
    }
    expect(results[0]!.sharedProfileId).toBe(results[1]!.sharedProfileId!);
    expect(results[0]!.accessTokenSha256Prefix).not.toBe(results[1]!.accessTokenSha256Prefix);
    expect(specs[0]!.deviceId).not.toBe(specs[1]!.deviceId);
    for (const result of results) {
      const portal = JSON.parse(readFileSync(join(result.appDataDir, 'portal.json'), 'utf8'));
      expect(specs.map(spec => spec.deviceId)).toContain(portal.deviceId);
    }
  }, CHILD_TEST_TIMEOUT_MS);
});
