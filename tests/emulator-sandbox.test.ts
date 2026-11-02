/**
 * WP1 — 필수 sandbox-exec 프로필·카나리·격리 호스트 런처(scripts/emulator-e2e/{sandbox,isolatedSidecar}.ts).
 *
 * 실제 macOS 샌드박스로 잰다: 카나리 7종이 모두 막히는지(남의 loopback 리스너·자기 프로필 고쳐 쓰기 포함), 샌드박스 안의
 * 소스 모드 사이드카가 /api/health 200을 주는지, 그 사이드카 안에서 /usr/bin/security 실행이 거부 기록으로 남는지,
 * API_PORT가 3001이 아닌지, build-sidecar 진입점에 tests/ 경로가 없는지. 실제 앱 데이터·3001·52741·키체인에는 닿지
 * 않는다(샌드박스가 막고 카나리가 증명). 키체인 경로를 건드리는 사이드카 검사는 같은 실행의 카나리가 통과했을 때만 간다.
 * 연결 시험의 상대는 모두 이 테스트가 띄운 리스너다 — 이 Mac의 다른 리스너에는 연결하지 않는다.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {planSidecarBuild} from '../build-sidecar';
import {
  RESERVED_LOOPBACK_PORTS,
  PRODUCTION_SUPABASE_REFS,
  buildAllowlistedEnv,
  createIsolatedProfile,
  createRunScratch,
  realHome,
} from '../scripts/emulator-e2e/environment';
import {
  CANARY_IDS,
  DENIED_EXECUTABLES,
  activeLanBindingGuard,
  buildSandboxProfile,
  hostProfileStaticChecks,
  isDescendantOfThisProcess,
  lanListenerViolations,
  listenersOnPort,
  parseLsofListenNames,
  parseLsofListeners,
  profileDeniesLoopbackPort,
  profileLanInboundPorts,
  profileOutboundIsAllowlist,
  runSandboxCanaries,
  sandboxedArgv,
  sha256,
  startLanBindingGuard,
  writeSandboxProfile,
  type CanaryReport,
  type ListenSocket,
  type SandboxProfileInput,
  type WrittenSandboxProfile,
} from '../scripts/emulator-e2e/sandbox';
import {
  SIDE_EFFECT_GUARD_ENTRY,
  forbiddenOpenFiles,
  isolatedRoot,
  listenerOwnedBy,
  managementRequest,
  readSideEffectLog,
  reserveLoopbackPort,
  startSidecar,
  writeSidecarFixtures,
  type RunningSidecar,
} from '../scripts/emulator-e2e/isolatedSidecar';
import {LaneHosts, registerLane, runLanes, unregisterLane, type LaneContext} from '../scripts/emulator-e2e';
import type {PreflightReport} from '../scripts/emulator-e2e/preflight';

const REPO_ROOT = resolve(import.meta.dir, '..');
const macOnly = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

/** 실행 배치와 같다: <base>/work(호스트 쓰기 허용) · <base>/sandbox(프로필, 쓰기 허용 루트 밖). */
let base = '';
let scratch = '';
let profileDir = '';
let evidenceDir = '';
let hostInput: SandboxProfileInput = {writableRoots: []};
/** 같은 실행에서 잰 카나리 결과. 키체인 경로를 건드리는 사이드카 검사는 이것이 통과했을 때만 간다(검토 #7). */
let canaryGate: CanaryReport | null = null;

beforeAll(() => {
  if (!macOnly) return;
  base = createRunScratch(`sandbox-test-${process.pid}`);
  scratch = join(base, 'work');
  profileDir = join(base, 'sandbox');
  mkdirSync(scratch, {recursive: true, mode: 0o700});
  mkdirSync(profileDir, {recursive: true, mode: 0o700});
  evidenceDir = realpathSync(mkdtempSync(join(scratch, 'evidence-')));
  hostInput = {writableRoots: [scratch, evidenceDir]};
});

afterAll(() => {
  if (base) rmSync(base, {recursive: true, force: true});
});

async function runCanaries(): Promise<CanaryReport> {
  const profile = createIsolatedProfile(scratch, 'canary-test');
  return runSandboxCanaries({profileInput: hostInput, profileDir, env: buildAllowlistedEnv({profile}), scratchDir: profile.tmp, repoRoot: REPO_ROOT});
}

/**
 * LAN 가드 시험의 en0 자리. 실제 en0 주소는 쓰지 않는다 — 시험은 en0에 바인딩하지 않고, 「en0 밖」 리스너는 lo0의
 * link-local(fe80::1%lo0)에 연다. 그 주소는 이 Mac 밖에서 닿지 않으므로 시험이 LAN에 포트를 열지 않는다.
 */
const TEST_EN0 = '192.168.255.254';
const OFF_EN0_HOST = 'fe80::1%lo0';
const PASSING_PREFLIGHT = {status: 'pass', reasons: []} as unknown as PreflightReport;

/** 샌드박스 안에서 host:port에 리스너 하나를 연다(LAN 가드 시험용). */
function spawnSandboxedListener(profile: WrittenSandboxProfile, host: string, port: number, label: string): Bun.Subprocess<'ignore', 'ignore', 'pipe'> {
  const isolated = createIsolatedProfile(scratch, label);
  const code = `const server = Bun.serve({hostname: ${JSON.stringify(host)}, port: ${port}, fetch: () => new Response('x')}); console.log('listening ' + server.port); setInterval(() => {}, 1_000);`;
  return Bun.spawn(sandboxedArgv(profile, [process.execPath, '--env-file=/dev/null', '-e', code]), {
    cwd: isolated.root, env: buildAllowlistedEnv({profile: isolated}), stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  });
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe('sandbox profile generator', () => {
  test('denies the reserved ports after every allow rule and never uses an unfiltered network deny', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'atz-sbx-static-')));
    try {
      const profile = buildSandboxProfile({writableRoots: [dir], home: '/Users/example'});
      for (const port of RESERVED_LOOPBACK_PORTS) expect(profileDeniesLoopbackPort(profile.text, port)).toBe(true);
      expect(profile.text).toContain('(deny network-outbound (remote ip "localhost:3001"))');
      expect(profile.text).toContain('(deny network-bind (local ip "*:3001"))');
      expect(profile.text.split('\n').some(line => line.trim() === '(deny network*)')).toBe(false);
      for (const path of DENIED_EXECUTABLES) expect(profile.text).toContain(`(literal "${path}")`);
      expect(profile.text).toContain('(subpath "/Users/example/Library/Application Support/com.portmanager.portmanager")');
      expect(profile.text).toContain('(subpath "/Users/example/Library/Keychains")');
      expect(profile.text).toContain('(literal "/Users/example/.gitconfig")');
      // LAN 포트를 열어도 거부 포트는 그 뒤에 남는다.
      const lan = buildSandboxProfile({writableRoots: [dir], home: '/Users/example', lanInbound: {port: 45_000}});
      expect(profileDeniesLoopbackPort(lan.text, 3001)).toBe(true);
      expect(lan.sha256).not.toBe(profile.sha256);
      // bind 거부가 와일드카드 bind 허용보다 앞에 오면 정적 검사가 잡는다(나중 규칙이 이긴다 — 그 거부는 먹지 않는다).
      const reversedBind = profile.text.replace('(deny network-bind (local ip "*:3001"))\n', '')
        .replace('(allow network-bind (local ip "localhost:*"))', '(deny network-bind (local ip "*:3001"))\n(allow network-bind (local ip "localhost:*"))');
      expect(profileDeniesLoopbackPort(reversedBind, 3001)).toBe(false);
      // outbound가 허용 목록이 아니면(와일드카드 허용) 거부 행이 있어도 막힌 것으로 보지 않는다.
      expect(profileDeniesLoopbackPort(`${profile.text}\n(allow network-outbound (remote ip "localhost:*"))`, 3001)).toBe(false);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('loopback outbound is an allowlist of run-owned ports; reserved and denied ports cannot be allowed', () => {
    // 검토 #2 회귀: `localhost:*`를 열고 세 포트만 막으면 설치 앱의 다른 리스너(내장 Chromium 디버깅 포트 등)에 닿는다.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'atz-sbx-allow-')));
    try {
      const none = buildSandboxProfile({writableRoots: [dir], home: '/Users/example'});
      expect(none.text).not.toContain('(allow network-outbound (remote ip "localhost:*"))');
      expect(none.text.split('\n').filter(line => line.startsWith('(allow network-outbound (remote ip'))).toEqual([]);
      expect(profileOutboundIsAllowlist(none.text)).toBe(true);
      const some = buildSandboxProfile({writableRoots: [dir], home: '/Users/example', allowedLoopbackPorts: [45_002, 45_001, 45_001]});
      expect(some.allowedLoopbackPorts).toEqual([45_001, 45_002]);
      expect(some.text).toContain('(allow network-outbound (remote ip "localhost:45001"))');
      expect(profileOutboundIsAllowlist(some.text)).toBe(true);
      expect(hostProfileStaticChecks(some.text).every(check => check.passed)).toBe(true);
      expect(profileOutboundIsAllowlist(`${some.text}\n(allow network-outbound (remote ip "localhost:*"))`)).toBe(false);
      expect(hostProfileStaticChecks(`${some.text}\n(allow network-outbound (remote ip "localhost:*"))`).find(check => check.id === 'static-loopback-outbound-allowlist')?.passed).toBe(false);
      for (const port of RESERVED_LOOPBACK_PORTS) {
        expect(() => buildSandboxProfile({writableRoots: [dir], home: '/Users/example', allowedLoopbackPorts: [port]})).toThrow(/cannot be allowed/);
      }
      expect(() => buildSandboxProfile({writableRoots: [dir], home: '/Users/example', allowedLoopbackPorts: [45_010], extraDeniedPorts: [45_010]})).toThrow(/cannot be allowed/);
      expect(() => buildSandboxProfile({writableRoots: [dir], home: '/Users/example', allowedLoopbackPorts: [0]})).toThrow(/invalid/);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('the outbound allowlist is the last network-outbound rule (a later outbound rule drops some allowed ports)', () => {
    // 검증 중 발견한 결함의 회귀: 허용 뒤에 거부 포트·unix 소켓 규칙이 오면 일부 포트(측정: 53243·53262·60252 …, 약 5%)의
    // 허용이 사라져 사이드카·측정 서버·카나리 대조군에 연결하지 못했다(preflight 9회 중 2회 실패).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'atz-sbx-order-')));
    try {
      for (const input of [
        {writableRoots: [dir], home: '/Users/example', allowedLoopbackPorts: [53_243, 53_262]},
        {writableRoots: [dir], home: '/Users/example', allowedLoopbackPorts: [53_243], extraDeniedPorts: [53_244], lanInbound: {port: 45_100}},
      ]) {
        const profile = buildSandboxProfile(input);
        const lines = profile.text.split('\n');
        const outbound = lines.filter(line => /^\((allow|deny) network-outbound/.test(line));
        expect(outbound.slice(-input.allowedLoopbackPorts.length)).toEqual(input.allowedLoopbackPorts.map(port => `(allow network-outbound (remote ip "localhost:${port}"))`));
        expect(outbound[0]).toBe('(deny network-outbound (remote ip "*:*"))');
        expect(profileOutboundIsAllowlist(profile.text)).toBe(true);
        for (const port of [...RESERVED_LOOPBACK_PORTS, ...(input.extraDeniedPorts ?? [])]) expect(profileDeniesLoopbackPort(profile.text, port)).toBe(true);
        // 허용 뒤에 다른 outbound 규칙이 붙으면 정적 검사가 잡는다.
        expect(profileOutboundIsAllowlist(`${profile.text}\n(deny network-outbound (remote ip "localhost:3001"))`)).toBe(false);
        expect(profileOutboundIsAllowlist(`${profile.text}\n(deny network-outbound (remote unix-socket (path-regex #"^/")))`)).toBe(false);
        expect(hostProfileStaticChecks(`${profile.text}\n(deny network-outbound (remote ip "localhost:4723"))`).find(check => check.id === 'static-loopback-outbound-allowlist')?.passed).toBe(false);
      }
      // `*:*` 거부로 시작하지 않는 outbound는 허용 목록이 아니다.
      const none = buildSandboxProfile({writableRoots: [dir], home: '/Users/example'});
      expect(profileOutboundIsAllowlist(none.text.replace('(deny network-outbound (remote ip "*:*"))\n', ''))).toBe(false);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('LAN inbound opens one declared port, never every port on every interface', () => {
    // 검토 #9 회귀(부분): SBPL은 en0 주소를 쓸 수 없다(host must be * or localhost) — 포트 하나로 좁힌다.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'atz-sbx-lan-')));
    try {
      const lan = buildSandboxProfile({writableRoots: [dir], home: '/Users/example', lanInbound: {port: 45_100}});
      expect(lan.text).toContain('(allow network-bind (local ip "*:45100"))');
      expect(lan.text).toContain('(allow network-inbound (local ip "*:45100"))');
      expect(lan.text).not.toContain('(allow network-bind (local ip "*:*"))');
      expect(lan.text).not.toContain('(allow network-inbound (local ip "*:*"))');
      expect(lan.lanInbound).toEqual({port: 45_100});
      expect(() => buildSandboxProfile({writableRoots: [dir], home: '/Users/example', lanInbound: {port: 3001}})).toThrow(/denied/);
      expect(() => buildSandboxProfile({writableRoots: [dir], home: '/Users/example', lanInbound: true} as never)).toThrow(/invalid/);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('the LAN listener check accepts only <en0 address>:<port> besides loopback', () => {
    const names = parseLsofListenNames(['p123', 'f10', 'n127.0.0.1:45001', 'f11', 'n192.168.0.20:45100', 'f12', 'n[::1]:45002'].join('\n'));
    expect(names).toEqual([{address: '127.0.0.1', port: 45_001}, {address: '192.168.0.20', port: 45_100}, {address: '::1', port: 45_002}]);
    expect(lanListenerViolations(names, {address: '192.168.0.20', port: 45_100})).toEqual([]);
    expect(lanListenerViolations([...names, {address: '*', port: 45_100}], {address: '192.168.0.20', port: 45_100})).toEqual(['listens on *:45100 (only 192.168.0.20:45100 is allowed)']);
    expect(lanListenerViolations([{address: '10.8.0.2', port: 45_100}], {address: '192.168.0.20', port: 45_100})).toEqual([
      'listens on 10.8.0.2:45100 (only 192.168.0.20:45100 is allowed)', 'does not listen on 192.168.0.20:45100',
    ]);
    // 가드의 감시는 「아직 안 떴다」를 위반으로 보지 않는다(리스너는 레인이 켤 때 뜬다).
    expect(lanListenerViolations([{address: '127.0.0.1', port: 45_100}], {address: '192.168.0.20', port: 45_100}, {requireListening: false})).toEqual([]);
    expect(parseLsofListeners(['p123', 'f10', 'n*:45100', 'p456', 'f7', 'n[fe80:1::1]:45100'].join('\n'))).toEqual([
      {pid: 123, address: '*', port: 45_100}, {pid: 456, address: 'fe80:1::1', port: 45_100},
    ]);
  });

  test('refuses writable roots that would cover the real home or do not exist', () => {
    expect(() => buildSandboxProfile({writableRoots: ['/'], home: '/Users/example'})).toThrow();
    expect(() => buildSandboxProfile({writableRoots: ['/Users'], home: '/Users'})).toThrow(/real home/);
    expect(() => buildSandboxProfile({writableRoots: ['/definitely/not/here'], home: '/Users/example'})).toThrow(/must exist/);
    expect(() => buildSandboxProfile({writableRoots: [], home: '/Users/example'})).toThrow();
  });

  test('profiles are never written inside a writable root, and a rewritten profile is refused before spawn', () => {
    // 검토 #4 회귀: 호스트가 다음 레인의 프로필을 고쳐 쓸 수 있었다.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atz-sbx-tamper-')));
    try {
      const work = join(root, 'work');
      const profiles = join(root, 'sandbox');
      mkdirSync(work);
      expect(() => writeSandboxProfile(join(work, 'sandbox'), 'host', {writableRoots: [work], home: '/Users/example'})).toThrow(/inside the writable root/);
      expect(() => writeSandboxProfile(work, 'host', {writableRoots: [work], home: '/Users/example'})).toThrow(/inside the writable root/);
      const profile = writeSandboxProfile(profiles, 'host', {writableRoots: [work], home: '/Users/example'});
      expect(profile.dir).toBe(realpathSync(profiles));
      expect(sandboxedArgv(profile, ['/usr/bin/true'])).toEqual(['/usr/bin/sandbox-exec', '-f', profile.path, '/usr/bin/true']);
      appendFileSync(profile.path, '\n(allow network-outbound (remote ip "localhost:*"))\n');
      expect(() => sandboxedArgv(profile, ['/usr/bin/true'])).toThrow(/changed after it was written/);
      rmSync(profile.path);
      expect(() => sandboxedArgv(profile, ['/usr/bin/true'])).toThrow(/unreadable/);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

describe('LAN binding guard (검토 #9: en0 바인딩을 하네스가 집행한다)', () => {
  test('records listeners outside en0, stops only the offenders, and treats a failed observation as a violation', async () => {
    const port = 45_321;
    let current: ListenSocket[] = [];
    let failObservation = false;
    const terminated: number[] = [];
    const reported: string[][] = [];
    const guard = startLanBindingGuard({
      port, expectedAddress: '192.168.0.20', intervalMs: 60_000,
      observe: async () => { if (failObservation) throw new Error('lsof missing'); return current; },
      terminate: pid => { terminated.push(pid); return `pid ${pid} stopped`; },
      onViolation: lines => reported.push(lines),
    });
    try {
      expect(activeLanBindingGuard(port)).toBe(guard);
      expect(() => startLanBindingGuard({port, expectedAddress: '192.168.0.20', observe: async () => []})).toThrow(/already watches/);
      expect(await guard.check()).toEqual([]);
      expect(await guard.listening()).toBe(false);
      current = [{pid: 10, address: '127.0.0.1', port}, {pid: 10, address: '192.168.0.20', port}];
      expect(await guard.check()).toEqual([]);
      expect(await guard.listening()).toBe(true);
      // 모든 인터페이스(`*`)에 연 리스너: 위반, 그 pid만 멈춘다(en0에 바르게 연 pid 10은 건드리지 않는다).
      current = [{pid: 11, address: '*', port}, {pid: 10, address: '192.168.0.20', port}];
      expect(await guard.check()).toEqual([`listens on *:${port} (only 192.168.0.20:${port} is allowed)`, 'pid 11 stopped']);
      // utun·브리지 같은 다른 주소도 위반이다.
      current = [{pid: 12, address: '10.8.0.2', port}];
      expect(await guard.check()).toEqual([`listens on 10.8.0.2:${port} (only 192.168.0.20:${port} is allowed)`, 'pid 12 stopped']);
      expect(terminated).toEqual([11, 12]);
      // 관측이 실패하면 「없음」이 아니라 위반이다(fail-closed).
      failObservation = true;
      const failed = await guard.check();
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatch(/could not observe .*lsof missing.*treated as a violation/);
      expect(guard.violations).toEqual([
        `listens on *:${port} (only 192.168.0.20:${port} is allowed)`, 'pid 11 stopped',
        `listens on 10.8.0.2:${port} (only 192.168.0.20:${port} is allowed)`, 'pid 12 stopped',
        failed[0]!,
      ]);
      expect(reported).toHaveLength(3);
    } finally {
      await guard.stop();
    }
    expect(guard.active).toBe(false);
    expect(activeLanBindingGuard(port)).toBeNull();
    await guard.stop();
  });

  test('needs a real en0 IPv4 to hold the host to', () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '*', 'fe80::1', '', 'en0']) {
      expect(() => startLanBindingGuard({port: 45_322, expectedAddress: address, observe: async () => []})).toThrow(/en0 IPv4/);
    }
    expect(activeLanBindingGuard(45_322)).toBeNull();
  });

  test('a LAN inbound profile is spawned only while a guard watches its port; a wildcard-port profile never', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atz-sbx-lan-guard-')));
    try {
      const work = join(root, 'work');
      mkdirSync(work);
      const plain = writeSandboxProfile(join(root, 'sandbox'), 'plain', {writableRoots: [work], home: '/Users/example'});
      const lan = writeSandboxProfile(join(root, 'sandbox'), 'lan', {writableRoots: [work], home: '/Users/example', lanInbound: {port: 45_323}});
      expect(profileLanInboundPorts(plain.text)).toEqual([]);
      expect(profileLanInboundPorts(lan.text)).toEqual([45_323]);
      expect(sandboxedArgv(plain, ['/usr/bin/true'])[0]).toBe('/usr/bin/sandbox-exec');
      expect(() => sandboxedArgv(lan, ['/usr/bin/true'])).toThrow(/no LAN binding guard watches it/);
      // 런처도 같은 이유로 거절한다(띄우기 전에).
      await expect(startSidecar(isolatedRoot(root, 'lan-unguarded'), 'source', {sandbox: lan})).rejects.toThrow(/needs an active LAN binding guard/);
      const guard = startLanBindingGuard({port: 45_323, expectedAddress: '192.168.0.20', intervalMs: 60_000, observe: async () => []});
      try {
        expect(sandboxedArgv(lan, ['/usr/bin/true'])).toEqual(['/usr/bin/sandbox-exec', '-f', lan.path, '/usr/bin/true']);
      } finally {
        await guard.stop();
      }
      expect(() => sandboxedArgv(lan, ['/usr/bin/true'])).toThrow(/no LAN binding guard watches it/);
      // 생성기가 쓰지 않는 모든 포트 inbound는 가드가 있어도 띄우지 않는다.
      const wildPath = join(root, 'sandbox', 'wild.sb');
      const wildText = `${plain.text}\n(allow network-inbound (local ip "*:*"))\n`;
      writeFileSync(wildPath, wildText);
      expect(() => sandboxedArgv({path: wildPath, sha256: sha256(wildText)}, ['/usr/bin/true'])).toThrow(/every port of every interface/);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  test('a lane host scope refuses LAN hosts when preflight measured no en0 address', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atz-sbx-lan-hosts-')));
    try {
      const work = join(root, 'work');
      mkdirSync(work);
      const input: SandboxProfileInput = {writableRoots: [work], home: '/Users/example'};
      const hosts = new LaneHosts({profileDir: join(root, 'sandbox'), hostProfileInput: input, hostSandbox: writeSandboxProfile(join(root, 'sandbox'), 'host', input), en0PrivateIpv4: null, log: () => {}});
      expect(() => hosts.sandboxProfile('lan', {lanInbound: {port: 45_324}})).toThrow(/en0 private IPv4/);
      expect(activeLanBindingGuard(45_324)).toBeNull();
      // LAN이 아닌 변형은 그대로 만든다.
      expect(hosts.sandboxProfile('shim', {allowedLoopbackPorts: [45_325]}).allowedLoopbackPorts).toEqual([45_325]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

describe.skipIf(!macOnly)('sandbox canaries (real sandbox-exec)', () => {
  test('all canaries are blocked while their controls succeed', async () => {
    const report = await runCanaries();
    canaryGate = report;
    expect(report.error).toBeUndefined();
    expect(report.sandboxStarted).toBe(true);
    const byId = Object.fromEntries(report.results.map(result => [result.id, result]));
    expect(Object.keys(byId).sort()).toEqual([...CANARY_IDS].sort());
    for (const id of CANARY_IDS) {
      expect({id, verdict: byId[id]?.verdict, control: byId[id]?.controlPassed}).toEqual({id, verdict: 'blocked', control: true});
    }
    expect(report.staticChecks.map(check => check.id)).toContain('static-loopback-outbound-allowlist');
    expect(report.staticChecks.every(check => check.passed)).toBe(true);
    expect(report.passed).toBe(true);
    // 워크트리 카나리 파일과 카나리 프로필이 남지 않았다.
    const build = join(REPO_ROOT, 'mobile', 'ios', 'build');
    expect(existsSync(build) ? readdirSync(build).filter(name => name.startsWith('emulator-canary-')) : []).toEqual([]);
    expect(readdirSync(profileDir).filter(name => name.startsWith('canary-'))).toEqual([]);
  }, 60_000);

  test('a sandboxed child reaches only allowlisted loopback ports: denied and foreign listeners get nothing', async () => {
    // 검토 #2 회귀: 프로필이 언급하지 않는 리스너(남의 포트)로도 연결되지 않는다. 상대는 모두 이 테스트가 띄운 리스너다.
    const hits = {allowed: 0, denied: 0, foreign: 0};
    const listen = (key: keyof typeof hits) => Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => { hits[key] += 1; return new Response(key); }});
    const allowed = listen('allowed');
    const denied = listen('denied');
    const foreign = listen('foreign');
    try {
      const profile = writeSandboxProfile(profileDir, 'port-test', {...hostInput, allowedLoopbackPorts: [allowed.port!], extraDeniedPorts: [denied.port!]});
      const isolated = createIsolatedProfile(scratch, 'port-test');
      const curl = async (port: number) => {
        const child = Bun.spawn(sandboxedArgv(profile, ['/usr/bin/curl', '-sS', '--max-time', '3', `http://127.0.0.1:${port}/`]), {
          cwd: isolated.root, env: buildAllowlistedEnv({profile: isolated}), stdout: 'pipe', stderr: 'pipe',
        });
        return child.exited;
      };
      expect(await curl(allowed.port!)).toBe(0);
      expect(await curl(denied.port!)).not.toBe(0);
      expect(await curl(foreign.port!)).not.toBe(0);
      expect(hits).toEqual({allowed: 1, denied: 0, foreign: 0});
    } finally {
      allowed.stop(true);
      denied.stop(true);
      foreign.stop(true);
    }
  }, 30_000);

  test('every allowlisted port is reachable, including port numbers the old rule order dropped', async () => {
    // 검증 중 발견한 결함의 회귀: 허용 목록 뒤에 거부 포트·unix 소켓 규칙이 있으면 일부 포트 번호(이 Mac에서 매번 같은
    // 포트 — 53243·53262·53371·53386·60252·60279 …)로 연결되지 않았다. 고정 포트(비어 있을 때만)와 무작위 포트 48개를
    // 하나씩 허용해 본다 — 옛 순서라면 무작위 48개 중 평균 2~3개가 떨어진다. 막힌 쪽(거부·남의 포트)은 여전히 닿지 않는다.
    const KNOWN_DROPPED = [53_243, 53_262, 53_371, 53_386, 60_252, 60_279, 60_286, 60_294];
    const listeners: Array<ReturnType<typeof Bun.serve>> = [];
    const listen = (port: number) => {
      try { const server = Bun.serve({hostname: '127.0.0.1', port, fetch: () => new Response('ok')}); listeners.push(server); return server.port!; }
      catch { return null; }
    };
    try {
      const fixed = KNOWN_DROPPED.map(listen).filter((port): port is number => port !== null);
      const random = Array.from({length: 48}, () => listen(0)!);
      const outsider = listen(0)!;
      const isolated = createIsolatedProfile(scratch, 'port-order');
      const env = buildAllowlistedEnv({profile: isolated});
      const failures: string[] = [];
      const all = [...fixed, ...random];
      for (const [index, port] of all.entries()) {
        const denied = all[(index + 1) % all.length]!;
        const profile = writeSandboxProfile(profileDir, `port-order-${index}`, {...hostInput, allowedLoopbackPorts: [port], extraDeniedPorts: [denied]});
        try {
          const child = Bun.spawn(sandboxedArgv(profile, ['/usr/bin/curl', '-s', '--max-time', '3', '-w', ' %{http_code}\\n',
            `http://127.0.0.1:${port}/`, `http://127.0.0.1:${denied}/`, `http://127.0.0.1:${outsider}/`]), {cwd: isolated.root, env, stdout: 'pipe', stderr: 'ignore'});
          const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
          const codes = text.trim().split('\n').map(line => line.trim().split(' ').pop());
          if (codes[0] !== '200') failures.push(`allowed ${port} unreachable`);
          if (codes[1] === '200') failures.push(`denied ${denied} reached`);
          if (codes[2] === '200') failures.push(`foreign ${outsider} reached`);
        } finally {
          rmSync(profile.path, {force: true});
        }
      }
      expect({checked: all.length, failures}).toEqual({checked: all.length, failures: []});
      expect(all.length).toBeGreaterThanOrEqual(48);
    } finally {
      for (const server of listeners) server.stop(true);
    }
  }, 60_000);
});

describe.skipIf(!macOnly)('LAN binding guard (real lsof, real sandbox-exec)', () => {
  test('extraPorts (j1-pty): the lane scope guards every declared LAN port so the profile can start; a sidecar takes one LAN port only', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atz-sbx-lan-extra-')));
    const ports: number[] = [];
    while (ports.length < 3) { const port = reserveLoopbackPort(); if (!ports.includes(port)) ports.push(port); }
    try {
      const work = join(root, 'work');
      mkdirSync(work);
      const input: SandboxProfileInput = {writableRoots: [work], home: '/Users/example'};
      const hosts = new LaneHosts({profileDir: join(root, 'sandbox'), hostProfileInput: input, hostSandbox: writeSandboxProfile(join(root, 'sandbox'), 'host', input), en0PrivateIpv4: TEST_EN0, log: () => {}, guardIntervalMs: 60_000});
      const lan = hosts.sandboxProfile('j1-pty-lan', {lanInbound: {port: ports[0]!, extraPorts: ports.slice(1)}});
      expect(profileLanInboundPorts(lan.text)).toEqual(ports);
      for (const port of ports) expect(activeLanBindingGuard(port)?.expectedAddress).toBe(TEST_EN0);
      expect(sandboxedArgv(lan, ['/usr/bin/true'])).toEqual(['/usr/bin/sandbox-exec', '-f', lan.path, '/usr/bin/true']);
      await expect(hosts.startSidecar(isolatedRoot(root, 'lan-extra'), 'source', {profile: lan})).rejects.toThrow(/takes one LAN inbound port/);
      expect(await hosts.settle()).toEqual([]);
      for (const port of ports) expect(activeLanBindingGuard(port)).toBeNull();
      expect(() => sandboxedArgv(lan, ['/usr/bin/true'])).toThrow(/no LAN binding guard watches it/);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  test('only descendants of the harness are signalled', async () => {
    const child = Bun.spawn(['/bin/sleep', '30'], {stdout: 'ignore', stderr: 'ignore'});
    try {
      expect(isDescendantOfThisProcess(child.pid)).toBe(true);
      expect(isDescendantOfThisProcess(process.pid)).toBe(false);
      expect(isDescendantOfThisProcess(process.ppid)).toBe(false);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
  });

  test('a sandboxed listener on the LAN port outside en0 is seen and stopped; loopback on that port is not a violation', async () => {
    // 재점검 #9: SBPL은 LAN 포트를 모든 인터페이스에 연다(`*:<port>`). 그 포트의 리스너를 하네스 가드가 실제로 보고 멈춘다.
    // 「en0 밖」 리스너는 lo0의 link-local에 연다 — 이 Mac 밖에서 닿지 않는다.
    const lanPort = reserveLoopbackPort();
    const logs: string[] = [];
    const hosts = new LaneHosts({profileDir, hostProfileInput: hostInput, hostSandbox: writeSandboxProfile(profileDir, 'lan-guard-host', hostInput), en0PrivateIpv4: TEST_EN0, log: line => logs.push(line)});
    const children: Bun.Subprocess[] = [];
    try {
      const profile = hosts.sandboxProfile('lan-guard-probe', {lanInbound: {port: lanPort}});
      expect(activeLanBindingGuard(lanPort)?.expectedAddress).toBe(TEST_EN0);

      const loopback = spawnSandboxedListener(profile, '127.0.0.1', lanPort, 'lan-guard-loopback');
      children.push(loopback);
      expect(await waitFor(async () => (await listenersOnPort(lanPort)).some(entry => entry.pid === loopback.pid && entry.address === '127.0.0.1'), 10_000)).toBe(true);
      await Bun.sleep(800); // 감시 몇 번
      expect(loopback.exitCode).toBeNull();
      expect(activeLanBindingGuard(lanPort)?.violations).toEqual([]);
      loopback.kill('SIGKILL');
      await loopback.exited;

      const offEn0 = spawnSandboxedListener(profile, OFF_EN0_HOST, lanPort, 'lan-guard-off-en0');
      children.push(offEn0);
      const stopped = await Promise.race([offEn0.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
      const stderr = stopped ? await new Response(offEn0.stderr).text() : '';
      expect({stopped, signal: offEn0.signalCode, stderr: stderr.slice(-300)}).toEqual({stopped: true, signal: 'SIGKILL', stderr: ''});
      const violations = await hosts.settle();
      expect(violations.some(line => line.includes(`listens on fe80:1::1:${lanPort} (only ${TEST_EN0}:${lanPort} is allowed)`))).toBe(true);
      expect(violations.some(line => line.includes(`pid ${offEn0.pid} stopped (SIGKILL)`))).toBe(true);
      expect(logs.some(line => line.startsWith(`LAN binding guard (port ${lanPort})`))).toBe(true);
      expect(activeLanBindingGuard(lanPort)).toBeNull();
      expect(await listenersOnPort(lanPort)).toEqual([]);
    } finally {
      for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
      await hosts.settle();
    }
  }, 60_000);
});

describe('isolated sidecar fixtures', () => {
  test('refuse production Supabase, non-loopback portals and paths outside the run scratch', () => {
    const fixtureBase = realpathSync(mkdtempSync(join(tmpdir(), 'atz-fixture-')));
    try {
      const root = createIsolatedProfile(fixtureBase, 'fixture');
      expect(() => writeSidecarFixtures(root, {portal: {supabaseUrl: PRODUCTION_SUPABASE_REFS[0]!}}, {scratchRoot: fixtureBase})).toThrow(/production/);
      expect(() => writeSidecarFixtures(root, {portal: {supabaseUrl: 'https://external-supabase.invalid'}}, {scratchRoot: fixtureBase})).toThrow(/loopback/);
      expect(() => writeSidecarFixtures(root, {portal: {supabaseUrl: 'http://127.0.0.1:3001'}}, {scratchRoot: fixtureBase})).toThrow(/reserved/);
      expect(() => writeSidecarFixtures(root, {ports: [{id: 'p', name: 'p', folderPath: realHome()}]}, {scratchRoot: fixtureBase})).toThrow(/outside the run scratch/);
      expect(() => writeSidecarFixtures(root, {workspaceRoots: [{id: 'r', name: 'r', path: '/Users'}]}, {scratchRoot: fixtureBase})).toThrow(/outside the run scratch/);
      const project = join(fixtureBase, 'project');
      mkdirSync(project);
      writeSidecarFixtures(root, {
        ports: [{id: 'fixture-project', name: 'Fixture', folderPath: project}],
        workspaceRoots: [{id: 'root', name: 'root', path: fixtureBase}],
        portal: {supabaseUrl: 'https://localhost', deviceId: 'fixture-device'},
        fakeClis: {claude: 'echo RESULT:hello'},
      }, {scratchRoot: fixtureBase});
      expect(JSON.parse(readFileSync(join(root.appDataDir, 'portal.json'), 'utf8')).supabaseUrl).toBe('https://localhost');
      expect(readFileSync(join(root.localBin, 'claude'), 'utf8')).toStartWith('#!/bin/sh');
    } finally {
      rmSync(fixtureBase, {recursive: true, force: true});
    }
  });

  test('the side-effect guard wrapper is never a production build entry', () => {
    const plan = planSidecarBuild({kind: 'development'}, {projectRoot: REPO_ROOT, platform: 'darwin', arch: 'arm64', bunExecutable: '/opt/bun/bin/bun'});
    const entries = [...plan.commands.map(command => command.entrypoint), ...plan.nativeCommands.map(command => command.entrypoint)];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.replaceAll('\\', '/')).not.toMatch(/(^|\/)tests\//);
      expect(entry).not.toContain('side-effect-guard');
    }
    expect(plan.commands.flatMap(command => command.args).join('\n')).not.toContain('side-effect-guard');
    expect(readFileSync(join(REPO_ROOT, 'build-sidecar.ts'), 'utf8')).not.toContain('side-effect-guard');
    expect(SIDE_EFFECT_GUARD_ENTRY).toBe(join(REPO_ROOT, 'tests', 'fixtures', 'side-effect-guard-entry.ts'));
  });

  test('startSidecar requires an explicit sandbox choice written by the generator', async () => {
    const noSandboxBase = realpathSync(mkdtempSync(join(tmpdir(), 'atz-no-sandbox-')));
    try {
      const root = isolatedRoot(noSandboxBase, 'no-choice');
      await expect(startSidecar(root, 'source', {} as never)).rejects.toThrow(/explicit sandbox/);
      await expect(startSidecar(root, 'source', {sandbox: {path: '/tmp/x.sb', sha256: 'x'}} as never)).rejects.toThrow(/written by writeSandboxProfile/);
    } finally {
      rmSync(noSandboxBase, {recursive: true, force: true});
    }
  });
});

describe.skipIf(!macOnly)('sandboxed source sidecar', () => {
  let sidecar: RunningSidecar | null = null;

  beforeAll(async () => {
    // 검토 #7: 이 묶음만 따로 돌려도(--test-name-pattern) 같은 실행의 카나리를 먼저 잰다.
    if (!canaryGate) canaryGate = await runCanaries();
  }, 60_000);

  afterAll(async () => {
    await sidecar?.stop();
  });

  test('answers /api/health 200 on a non-reserved port it owns, and its security exec is denied and recorded', async () => {
    // 키체인으로 가는 경로(security find-generic-password)를 부르기 전에, 같은 프로필 입력의 카나리와 exec 거부 정적 검사가
    // 이 실행에서 통과했는지 본다. 통과하지 않았으면 여기서 실패하고 사이드카를 띄우지도 않는다(검토 #7).
    const gate = canaryGate!;
    expect({passed: gate.passed, error: gate.error ?? null}).toEqual({passed: true, error: null});
    expect(gate.staticChecks.find(check => check.id === 'static-exec-deny')?.passed).toBe(true);
    const profile = writeSandboxProfile(profileDir, 'sidecar-test', hostInput);
    expect(profile.sha256).toBe(gate.profileSha256);

    const root = isolatedRoot(scratch, 'sandbox-test');
    sidecar = await startSidecar(root, 'source', {sandbox: profile, observeSideEffects: true, healthTimeoutMs: 90_000});
    expect(sidecar.sandboxed).toBe(true);
    // 띄운 프로필은 같은 입력에 자기 포트만 loopback 허용 목록으로 더한 것이다.
    expect(sidecar.sandboxProfile?.allowedLoopbackPorts).toEqual([sidecar.port]);
    expect(sidecar.sandboxProfile?.path.startsWith(`${realpathSync(profileDir)}/`)).toBe(true);
    expect(profileOutboundIsAllowlist(readFileSync(sidecar.sandboxProfile!.path, 'utf8'))).toBe(true);
    expect((RESERVED_LOOPBACK_PORTS as readonly number[]).includes(sidecar.port)).toBe(false);
    expect(sidecar.port).not.toBe(3001);
    expect(sidecar.envKeys).toContain('API_PORT');
    expect(sidecar.envKeys).not.toContain('CODEX_HOME');
    expect(sidecar.envKeys).not.toContain('AGENTSTOZ_CLI_SHIM_DIR');
    expect(listenerOwnedBy(sidecar.pid, sidecar.port)).toBe(true);
    expect(sidecar.lanBinding).toBeNull();

    const health = await managementRequest(sidecar, '/api/health', undefined, 'GET');
    expect(health.status).toBe(200);
    expect(health.json.service).toBe('agentstoz-api');

    // 키체인 토큰을 찾는 경로: `security find-generic-password`를 실행하려다 샌드박스에 막히고 파일 토큰도 없다.
    const keys = await managementRequest(sidecar, '/api/supabase-cli/apikeys?ref=fixture', undefined, 'GET');
    expect(keys.status).toBe(401);
    const records = readSideEffectLog(sidecar);
    expect(records.some(entry => entry.api === 'guard' && entry.outcome === 'installed')).toBe(true);
    const security = records.filter(entry => entry.command === 'security');
    expect(security.length).toBeGreaterThan(0);
    expect(security.every(entry => entry.outcome === 'spawn-error' && String(entry.code).includes('EPERM'))).toBe(true);

    // 관측: 실제 앱 데이터·에이전트 설정 파일을 열지 않았다.
    expect(forbiddenOpenFiles(sidecar.pid)).toEqual([]);
  }, 120_000);

  test('a LAN host is checked right after health: a listener outside en0 on its port stops it and refuses the start', async () => {
    // 재점검 #9가 제안한 시작 시점 확인. 관측은 주입한다(이 Mac에 en0 밖 리스너를 실제로 열지 않는다) — 사이드카는 실제로 뜬다.
    const gate = canaryGate!;
    expect({passed: gate.passed, error: gate.error ?? null}).toEqual({passed: true, error: null});
    const lanPort = reserveLoopbackPort();
    const profile = writeSandboxProfile(profileDir, 'lan-start-refused', {...hostInput, lanInbound: {port: lanPort}});
    const guard = startLanBindingGuard({port: lanPort, expectedAddress: TEST_EN0, intervalMs: 60_000, observe: async () => [{address: '*', port: lanPort}]});
    const root = isolatedRoot(scratch, 'lan-start-refused');
    try {
      let message = '';
      try { await startSidecar(root, 'source', {sandbox: profile, healthTimeoutMs: 90_000}); }
      catch (error) { message = (error as Error).message; }
      expect(message).toContain(`LAN host bound outside ${TEST_EN0}:${lanPort} — stopped: listens on *:${lanPort} (only ${TEST_EN0}:${lanPort} is allowed)`);
      // 실제로 떴다가(health 200) 멈췄다: stderr 기록이 있고, 그 사이드카의 API 포트에는 아무도 없다.
      const logs = readdirSync(root.root).filter(name => /^sidecar-\d+-0\.stderr\.log$/.test(name));
      expect(logs).toHaveLength(1);
      const apiPort = Number(/^sidecar-(\d+)-0/.exec(logs[0]!)![1]);
      expect(await listenersOnPort(apiPort)).toEqual([]);
    } finally {
      await guard.stop();
    }
  }, 120_000);

  test('the harness holds a LAN host to en0: a listener outside en0 on its LAN port stops the host and fails the lane that claimed a pass', async () => {
    // 재점검 #9: 레인이 알아서 lanListenerViolations를 부르기로 한 문서가 아니라, 하네스(ctx.startSidecar → LaneHosts)가 집행한다.
    const gate = canaryGate!;
    expect({passed: gate.passed, error: gate.error ?? null}).toEqual({passed: true, error: null});
    const lanPort = reserveLoopbackPort();
    const logs: string[] = [];
    const hosts = new LaneHosts({profileDir, hostProfileInput: hostInput, hostSandbox: writeSandboxProfile(profileDir, 'lan-lane-host', hostInput), en0PrivateIpv4: TEST_EN0, log: line => logs.push(line)});
    const ctx = {
      preflight: PASSING_PREFLIGHT,
      sandboxProfile: (name: string, extra?: Parameters<LaneHosts['sandboxProfile']>[1]) => hosts.sandboxProfile(name, extra),
      startSidecar: (root: Parameters<LaneHosts['startSidecar']>[0], kind: 'source' | 'installed', options?: Parameters<LaneHosts['startSidecar']>[2]) => hosts.startSidecar(root, kind, options),
    } as unknown as LaneContext;
    const seen: {host: RunningSidecar | null; violator: Bun.Subprocess | null; listeningBefore: boolean | null; hostStopped: boolean} = {host: null, violator: null, listeningBefore: null, hostStopped: false};
    registerLane({
      id: 'j1-lan',
      run: async lane => {
        const profile = lane.sandboxProfile('lan-lane', {lanInbound: {port: lanPort}});
        seen.host = await lane.startSidecar(isolatedRoot(scratch, 'lan-lane'), 'source', {profile, healthTimeoutMs: 90_000});
        seen.listeningBefore = await seen.host.lanBinding!.listening();
        // 레인의 실수를 흉내 낸다: 같은 LAN 프로필로 그 포트를 en0 밖(lo0 link-local)에 연다.
        seen.violator = spawnSandboxedListener(profile, OFF_EN0_HOST, lanPort, 'lan-lane-violator');
        seen.hostStopped = await Promise.race([seen.host.child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
        return {status: 'pass'};
      },
    });
    try {
      const {lanes, conditionUnmet} = await runLanes(['j1-lan'], 'single', ctx, () => hosts, () => {});
      expect(conditionUnmet).toEqual([]);
      expect(lanes).toHaveLength(1);
      expect(lanes[0]!.status).toBe('fail');
      expect(lanes[0]!.reason).toContain(`listens on fe80:1::1:${lanPort} (only ${TEST_EN0}:${lanPort} is allowed)`);
      expect(lanes[0]!.reason).toContain('lane reported pass');
      expect(seen.host!.lanBinding).toMatchObject({port: lanPort, expectedAddress: TEST_EN0});
      expect(seen.listeningBefore).toBe(false); // 사이드카는 LAN을 켜지 않았다 — en0에 아무것도 열지 않았다
      // 가드가 위반 리스너와 그 포트의 LAN 호스트(사이드카)를 SIGKILL로 멈췄다.
      expect({hostStopped: seen.hostStopped, hostSignal: seen.host!.child.signalCode}).toEqual({hostStopped: true, hostSignal: 'SIGKILL'});
      await seen.violator!.exited;
      expect(seen.violator!.signalCode).toBe('SIGKILL');
      expect(logs.some(line => line.includes(`stopping LAN host pid ${seen.host!.pid}`))).toBe(true);
      expect(activeLanBindingGuard(lanPort)).toBeNull();
      expect(await listenersOnPort(lanPort)).toEqual([]);
    } finally {
      unregisterLane('j1-lan');
      try { seen.violator?.kill('SIGKILL'); } catch {}
      await seen.host?.stop();
      await hosts.settle();
    }
  }, 150_000);
});
