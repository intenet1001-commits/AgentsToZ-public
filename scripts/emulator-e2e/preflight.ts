/**
 * 에뮬레이터 종단 시험 preflight(설계 §2·WP0). **아무것도 띄우지 않는다** — 측정용 단기 자식과 리스너만 쓰고
 * 모두 끝내고 돌아온다. 시뮬레이터를 만들거나 부팅하지 않고 Simulator.app도 열지 않는다.
 *
 * 하는 일
 * - 허용 목록 환경을 만들고, 샌드박스 자식 안에서 homedir·resolveAppDataDir가 실제 홈 밖인지 본다.
 * - 샌드박스 프로필을 만들고 카나리 자기 시험을 돌린다.
 * - 금지 도구 정적 검사, 워크트리가 등록 작업공간 루트 밖인지 검사.
 * - 동시 실행(check-ui·check-workroom)과 시뮬레이터 부팅 잠금 상태, 부하.
 * - 시뮬레이터 스냅샷(UDID·상태)과 설치 앱·Screen·Simulator.app pid(경고용).
 * - 능력 측정: en0 사설 IPv4, 127.0.0.1:443 바인딩·점유, Bun의 NODE_EXTRA_CA_CERTS 신뢰, 방화벽 상태.
 *   Secure Enclave·App Attest는 시뮬레이터 안의 프로브 앱(WP9)이 잰다 — 여기서는 「미측정」으로 남긴다.
 *
 * 이 파일을 `--measure-bind-443` / `--measure-ca`로 띄우면 샌드박스 안의 측정 자식이 된다.
 */
import {existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {cpus, loadavg} from 'node:os';
import {join, relative} from 'node:path';
import {
  REPO_ROOT,
  buildAllowlistedEnv,
  buildToolchainEnv,
  childIdentityViolations,
  createIsolatedProfile,
  environmentKeyNames,
  environmentViolations,
  isWithin,
  realAppDataDir,
  realHome,
  type ChildIdentityReport,
  type IsolatedProfile,
} from './environment';
import {type LaneStatus} from './evidence';
import {
  runSandboxCanaries,
  sandboxedArgv,
  sensitiveReadPaths,
  writeSandboxProfile,
  type CanaryReport,
  type SandboxProfileInput,
  type WrittenSandboxProfile,
} from './sandbox';

// ───────────────────────── 금지 도구 정적 검사 ─────────────────────────

/** 이 표시가 붙은 줄은 「금지 목록 선언」이다. 선언 파일(이 파일·sandbox.ts) 안에서만 예외가 된다. */
export const FORBIDDEN_DECLARATION_MARKER = 'emulator-guard:forbidden-tool-declaration';
const DECLARATION_FILES = new Set(['scripts/emulator-e2e/preflight.ts', 'scripts/emulator-e2e/sandbox.ts', 'tests/fixtures/side-effect-guard-entry.ts']);

export interface ForbiddenToolPattern {id: string; pattern: RegExp; why: string}

/** 실제 데스크톱 입력·TCC·화면 캡처로 이어지는 도구(설계 §4). */
export const FORBIDDEN_TOOL_PATTERNS: readonly ForbiddenToolPattern[] = Object.freeze([
  {id: 'screen-control-fixture', pattern: /ScreenControlFixture/, why: 'injects input into the real desktop'}, // emulator-guard:forbidden-tool-declaration
  {id: 'physical-screen-controls', pattern: /PhysicalScreenControls/, why: 'drives the physical screen'}, // emulator-guard:forbidden-tool-declaration
  {id: 'computer-use-native-lab', pattern: /ComputerUseNativeLab/, why: 'native lab fixture acts on the real desktop'}, // emulator-guard:forbidden-tool-declaration
  {id: 'screen-selftest-identity', pattern: /AgentsToZScreen[^\n]*--(?:selftest|identity)/, why: 'real Screen self-test touches TCC and the keychain'}, // emulator-guard:forbidden-tool-declaration
  {id: 'simulator-smoke', pattern: /simulator-smoke(?:\.py)?/, why: 'launches Simulator.app'}, // emulator-guard:forbidden-tool-declaration
  {id: 'tccutil', pattern: /\btccutil\b/, why: 'changes TCC'}, // emulator-guard:forbidden-tool-declaration
  {id: 'workroom-browser-native-screen', pattern: /workroom-browser-native-screen/, why: 'captures the real screen'}, // emulator-guard:forbidden-tool-declaration
]);

export interface ForbiddenToolHit {file: string; line: number; id: string; text: string}

/** 텍스트 목록에서 금지 도구 언급을 찾는다. 선언 표시는 선언 파일 안에서만 면제된다. */
export function detectForbiddenTools(files: ReadonlyArray<{path: string; text: string}>): ForbiddenToolHit[] {
  const hits: ForbiddenToolHit[] = [];
  for (const file of files) {
    const declarationFile = DECLARATION_FILES.has(file.path);
    file.text.split('\n').forEach((line, index) => {
      if (declarationFile && line.includes(FORBIDDEN_DECLARATION_MARKER)) return;
      for (const {id, pattern} of FORBIDDEN_TOOL_PATTERNS) {
        if (pattern.test(line)) hits.push({file: file.path, line: index + 1, id, text: line.trim().slice(0, 160)});
      }
    });
  }
  return hits;
}

/** 하네스가 실행하는 파일(있는 것만). 레인 패키지가 늘면 여기도 넓어진다. */
export const HARNESS_SCAN_PATHS = Object.freeze([
  'scripts/emulator-e2e.ts',
  'scripts/emulator-e2e',
  'tests/fixtures/side-effect-guard-entry.ts',
  'mobile/ios/scripts/check-ui.py',
  'mobile/ios/scripts/check-ui-suite.py',
  'mobile/ios/scripts/check-workroom.ts',
  // j1-pty: what check-workroom imports and compiles into its probe app.
  'mobile/ios/scripts/checkWorkroomSupport.ts',
  'mobile/ios/scripts/workroomFixtureCompile.ts',
  'mobile/ios/scripts/fixtures/WorkroomProbe.swift',
  'mobile/ios/scripts/lan-journey-host.ts',
  'tests/remote-relay-real-host.e2e.mjs',
  'tests/remote-community-real-hosts.e2e.mjs',
  'native/screen-control/Tests/Fixtures/ScreenFixtureHost',
  'mobile/ios/UITests/Fixtures/LoopbackFrameTransport.swift',
  'mobile/ios/UITests/ScreenViewerUITests.swift',
]);

export function harnessScanTargets(repoRoot: string = REPO_ROOT): Array<{path: string; text: string}> {
  const out: Array<{path: string; text: string}> = [];
  const visit = (relativePath: string) => {
    const absolute = join(repoRoot, relativePath);
    if (!existsSync(absolute)) return;
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${relativePath}/${name}`);
    } else if (/\.(ts|mjs|js|py|swift)$/.test(relativePath)) {
      out.push({path: relativePath, text: readFileSync(absolute, 'utf8')});
    }
  };
  for (const path of HARNESS_SCAN_PATHS) visit(path);
  return out;
}

// ───────────────────────── 워크트리 위치 ─────────────────────────

export interface WorktreeLocation {
  repoRoot: string;
  registeredRoots: string[];
  insideRegisteredRoot: string | null;
  underDeniedReadPath: string | null;
  workspaceRootsFile: string;
  workspaceRootsReadable: boolean;
  problems: string[];
}

/**
 * 워크트리가 등록 작업공간 루트 밖에 있어야 한다(설계 §2.1·검토 #15). 루트 안이면 설치 앱이 그것을 목록에 올리고
 * 휴대폰에도 광고한다. 샌드박스가 읽기를 막는 위치(예: ~/.codex/worktrees) 안이어도 소스 모드 호스트가 못 뜬다.
 */
export function checkWorktreeLocation(repoRoot: string, options: {workspaceRootsFile?: string; home?: string} = {}): WorktreeLocation {
  const home = options.home ?? realHome();
  const file = options.workspaceRootsFile ?? join(realAppDataDir(home), 'workspace-roots.json');
  const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  const root = real(repoRoot);
  const result: WorktreeLocation = {
    repoRoot: root, registeredRoots: [], insideRegisteredRoot: null, underDeniedReadPath: null,
    workspaceRootsFile: file, workspaceRootsReadable: false, problems: [],
  };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('not an array');
      result.registeredRoots = parsed
        .map(entry => (entry && typeof entry === 'object' && typeof (entry as {path?: unknown}).path === 'string') ? (entry as {path: string}).path : null)
        .filter((path): path is string => !!path && path.startsWith('/'));
      result.workspaceRootsReadable = true;
    } catch (error) {
      result.problems.push(`workspace-roots.json is unreadable: ${(error as Error).message}`);
    }
  } else {
    result.workspaceRootsReadable = true;
  }
  for (const registered of result.registeredRoots) {
    if (isWithin(root, real(registered))) { result.insideRegisteredRoot = registered; break; }
  }
  if (result.insideRegisteredRoot) {
    result.problems.push(`worktree ${root} is inside the registered workspace root ${result.insideRegisteredRoot} — create it under ${join(home, 'agentstoz-emulator', '<runId>', 'wt')}`);
  }
  const denied = sensitiveReadPaths(home);
  for (const path of [...denied.subpaths, ...denied.literals]) {
    if (isWithin(root, path)) { result.underDeniedReadPath = path; break; }
  }
  if (result.underDeniedReadPath) result.problems.push(`worktree is under a sandbox read-denied path ${result.underDeniedReadPath}`);
  return result;
}

// ───────────────────────── 프로세스 목록 ─────────────────────────

export interface ProcessRow {pid: number; ppid: number; command: string}

export function parsePsRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim()});
  }
  return rows;
}

export function listProcesses(format: 'command' | 'comm' = 'command'): ProcessRow[] {
  const out = Bun.spawnSync(['/bin/ps', '-axo', `pid=,ppid=,${format}=`], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin'}});
  return parsePsRows(out.stdout.toString());
}

/**
 * 「자기 것」= 이 프로세스의 조상 사슬 + **이 프로세스의** 자손(자기 레인이 띄운 check-ui는 동시 실행이 아니다).
 * 조상의 다른 자식(형제·사촌)은 자기 것이 아니다 — 같은 Orca·tmux·워크룸 세션에서 따로 띄운 check-ui.py는
 * 다른 실행이다(검토 #1: 조상 집합에서 자손을 키우면 Orca 트리 전체가 「자기 것」이 됐다).
 */
export function ownProcessTree(rows: readonly ProcessRow[], pid: number = process.pid): Set<number> {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const ancestors = new Set<number>();
  for (let cursor = byPid.get(pid); cursor && cursor.ppid > 1 && !ancestors.has(cursor.ppid) && cursor.ppid !== pid; cursor = byPid.get(cursor.ppid)) ancestors.add(cursor.ppid);
  const descendants = new Set<number>([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) if (!descendants.has(row.pid) && descendants.has(row.ppid)) { descendants.add(row.pid); grew = true; }
  }
  return new Set<number>([...ancestors, ...descendants]);
}

export const CONCURRENT_CHECK_PATTERNS = Object.freeze([
  /check-ui\.py\b/,
  /check-ui-suite\.py\b/,
  /check-workroom\.ts\b/,
  /check-common-memory-device\.ts\b/,
  /prepare-workroom-persona-device\.ts\b/,
]);

/** 다른 실행의 check-ui·check-workroom(이 프로세스 트리 밖). */
export function findConcurrentChecks(rows: readonly ProcessRow[], own: ReadonlySet<number>): ProcessRow[] {
  return rows.filter(row => !own.has(row.pid) && CONCURRENT_CHECK_PATTERNS.some(pattern => pattern.test(row.command)));
}

export interface ConcurrencyWait {status: 'clear' | 'blocked'; waitedMs: number; seen: Array<{pid: number; command: string}>}

/** 한도 안에서 기다린다. 넘으면 「막힘: 동시 실행」(설계 §2.5). */
export async function waitForQuietSimulatorChecks(options: {limitMs: number; pollMs?: number; list?: () => ProcessRow[]} = {limitMs: 0}): Promise<ConcurrencyWait> {
  const started = Date.now();
  const list = options.list ?? (() => listProcesses('command'));
  for (;;) {
    const rows = list();
    const busy = findConcurrentChecks(rows, ownProcessTree(rows));
    const seen = busy.map(row => ({pid: row.pid, command: row.command.slice(0, 200)}));
    if (!busy.length) return {status: 'clear', waitedMs: Date.now() - started, seen};
    if (Date.now() - started >= options.limitMs) return {status: 'blocked', waitedMs: Date.now() - started, seen};
    await Bun.sleep(options.pollMs ?? 5_000);
  }
}

// ───────────────────────── 시뮬레이터 부팅 잠금 ─────────────────────────

export function defaultSimulatorLockPath(home: string = realHome()): string {
  return join(home, 'agentstoz-emulator', 'sim.lock');
}

/** 보유자 표시(정보용). 잠금 자체는 커널의 flock이고 이 파일은 누가 쥐고 있는지 보여 줄 뿐이다. */
export interface SimulatorLockHolder {pid: number; lockfPid: number; runId: string; acquiredAt: string}

export const LOCKF = '/usr/bin/lockf';
/** lockf(1)의 EX_TEMPFAIL — 다른 프로세스가 잠금을 쥐고 있다. */
const LOCK_BUSY_EXIT = 75;
/** lockf -n: 파일이 없으면 EX_UNAVAILABLE — 아무도 잠근 적이 없다. */
const LOCK_FILE_MISSING_EXIT = 69;

export function simulatorLockHolderPath(lockPath: string): string {
  return `${lockPath}.holder.json`;
}

function readHolderInfo(lockPath: string): SimulatorLockHolder | null {
  try { return JSON.parse(readFileSync(simulatorLockHolderPath(lockPath), 'utf8')) as SimulatorLockHolder; } catch { return null; }
}

export interface SimulatorLockState {held: boolean; holder: SimulatorLockHolder | null; error?: string}

/**
 * 지금 잠금이 쥐어져 있는가(관측). `lockf -n -k -s -t 0 <잠금> /usr/bin/true`가 75면 쥐어져 있고, 0이면 비어 있다
 * (그 순간 잠깐 잡았다 놓는다 — 동시에 기다리던 쪽은 다음 폴링에 잡는다). 보유자 표시는 쥐어져 있을 때만 믿는다.
 */
export function readSimulatorLock(lockPath: string): SimulatorLockState {
  if (!existsSync(lockPath)) return {held: false, holder: null};
  const probe = Bun.spawnSync([LOCKF, '-n', '-k', '-s', '-t', '0', lockPath, '/usr/bin/true'], {stdout: 'ignore', stderr: 'pipe', env: {PATH: '/usr/bin:/bin'}});
  if (probe.exitCode === LOCK_BUSY_EXIT) return {held: true, holder: readHolderInfo(lockPath)};
  if (probe.exitCode === 0 || probe.exitCode === LOCK_FILE_MISSING_EXIT) return {held: false, holder: null};
  return {held: false, holder: null, error: `lockf probe exited ${probe.exitCode}: ${probe.stderr.toString().trim().slice(0, 200)}`};
}

export type SimulatorLockResult =
  | {status: 'acquired'; lockPath: string; waitedMs: number; loadavgAtAcquire: number[]; cpuCount: number; holder: SimulatorLockHolder; release: () => Promise<void>}
  | {status: 'blocked'; lockPath: string; waitedMs: number; reason: string; holder: SimulatorLockHolder | null};

async function firstLine(child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>, timeoutMs: number): Promise<string | null> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Bun.sleep(timeoutMs).then(() => null);
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === null || chunk.done) return text.includes('\n') ? text.split('\n')[0]! : null;
      text += decoder.decode(chunk.value, {stream: true});
      if (text.includes('\n')) return text.split('\n')[0]!;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 시뮬레이터 부팅을 직렬화한다(설계 §2.5). 잠금은 **커널 flock**이다 — lockf(1)가 잠금을 쥔 채 오케스트레이터의
 * stdin을 읽는 `cat`을 실행하고, 놓을 때는 stdin을 닫는다. 오케스트레이터가 죽으면(SIGKILL 포함) 파이프가 닫혀
 * cat이 끝나고 커널이 잠금을 푼다. 그래서 「죽은 보유자 회수」가 없다 — 파일을 지우고 다시 만드는 경쟁(검토 #3:
 * 두 대기자가 같은 죽은 보유자를 보고 둘 다 들어가던 문제)과 시작 시각을 모르는 보유자를 죽은 것으로 보던 문제가
 * 생길 자리가 없다. 보유자가 살아 있으면 한도까지 기다리고, 넘으면 「막힘」.
 */
export async function acquireSimulatorBootLock(options: {runId: string; lockPath?: string; timeoutMs: number; pollMs?: number}): Promise<SimulatorLockResult> {
  const lockPath = options.lockPath ?? defaultSimulatorLockPath();
  mkdirSync(join(lockPath, '..'), {recursive: true, mode: 0o700});
  const started = Date.now();
  for (;;) {
    const child = Bun.spawn([LOCKF, '-k', '-s', '-t', '0', lockPath, '/bin/sh', '-c', 'echo acquired; exec /bin/cat >/dev/null'], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {PATH: '/usr/bin:/bin'},
    });
    const line = await firstLine(child, 15_000);
    if (line === 'acquired') {
      const holder: SimulatorLockHolder = {pid: process.pid, lockfPid: child.pid, runId: options.runId, acquiredAt: new Date().toISOString()};
      // 잠금을 쥔 동안에만 쓴다(정보용). 놓기 전에 지운다 — 놓은 뒤에는 다음 보유자의 표시일 수 있다.
      try { writeFileSync(simulatorLockHolderPath(lockPath), JSON.stringify(holder), {mode: 0o600}); }
      catch (error) {
        // The lock is already ours, even though recording its informational holder failed.
        try { child.stdin.end(); } catch {}
        const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
        if (exited === null) { try { child.kill('SIGKILL'); } catch {} await child.exited; }
        throw error;
      }
      let released: Promise<void> | null = null;
      return {
        status: 'acquired', lockPath, waitedMs: Date.now() - started, holder,
        loadavgAtAcquire: loadavg().map(value => Math.round(value * 100) / 100), cpuCount: cpus().length,
        release: () => {
          released ??= (async () => {
            try {
              const current = readHolderInfo(lockPath);
              if (current?.lockfPid === holder.lockfPid && current.runId === holder.runId) rmSync(simulatorLockHolderPath(lockPath), {force: true});
            } finally {
              try { child.stdin.end(); } catch {}
              const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
              if (exited === null) { try { child.kill('SIGKILL'); } catch {} await child.exited; }
            }
          })();
          return released;
        },
      };
    }
    // 잡지 못했다: lockf가 끝날 때까지 기다려 사유를 본다.
    try { child.stdin.end(); } catch {}
    const exitCode = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
    if (exitCode === null) { try { child.kill('SIGKILL'); } catch {} await child.exited; }
    if (exitCode !== LOCK_BUSY_EXIT) {
      const stderr = await new Response(child.stderr).text().catch(() => '');
      return {status: 'blocked', lockPath, waitedMs: Date.now() - started, reason: `lockf could not take the simulator lock (exit ${exitCode}): ${stderr.trim().slice(0, 200)}`, holder: null};
    }
    if (Date.now() - started >= options.timeoutMs) {
      const holder = readHolderInfo(lockPath);
      return {status: 'blocked', lockPath, waitedMs: Date.now() - started, reason: `simulator boot lock is held by pid ${holder?.pid ?? 'unknown'} (run ${holder?.runId ?? 'unknown'})`, holder};
    }
    await Bun.sleep(options.pollMs ?? 2_000);
  }
}

// ───────────────────────── 시뮬레이터 스냅샷 ─────────────────────────

export interface SimulatorDevice {udid: string; state: string; runtime: string; name: string}

export interface SimulatorSnapshot {
  takenAt: string;
  available: boolean;
  error?: string;
  devices: SimulatorDevice[];
  simulatorAppPids: number[];
  installedAppPids: number[];
  screenPids: number[];
}

export function parseSimctlDevices(json: string): SimulatorDevice[] {
  const parsed = JSON.parse(json) as {devices?: Record<string, Array<{udid?: string; state?: string; name?: string}>>};
  const out: SimulatorDevice[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    for (const device of devices ?? []) {
      if (typeof device.udid === 'string') out.push({udid: device.udid, state: String(device.state ?? 'unknown'), runtime, name: String(device.name ?? '')});
    }
  }
  return out.sort((a, b) => a.udid.localeCompare(b.udid));
}

export function classifyWatchedProcesses(rows: readonly ProcessRow[]): {simulatorAppPids: number[]; installedAppPids: number[]; screenPids: number[]} {
  const pids = (test: (comm: string) => boolean) => rows.filter(row => test(row.command)).map(row => row.pid).sort((a, b) => a - b);
  return {
    simulatorAppPids: pids(comm => comm.endsWith('/Simulator.app/Contents/MacOS/Simulator')),
    installedAppPids: pids(comm => comm.startsWith('/Applications/AgentsToZ_byCS.app/')),
    screenPids: pids(comm => comm.includes('/AgentsToZ Screen.app/') || comm.endsWith('/AgentsToZScreen')),
  };
}

/** 읽기 전용 목록(`simctl list devices --json`). 부팅·생성은 하지 않는다. */
export function takeSimulatorSnapshot(): SimulatorSnapshot {
  const watched = classifyWatchedProcesses(listProcesses('comm'));
  const base = {takenAt: new Date().toISOString(), ...watched};
  if (process.platform !== 'darwin') return {...base, available: false, error: 'not macOS', devices: []};
  const result = Bun.spawnSync(['/usr/bin/xcrun', 'simctl', 'list', 'devices', '--json'], {env: buildToolchainEnv(), stdout: 'pipe', stderr: 'pipe'});
  if (result.exitCode !== 0) return {...base, available: false, error: result.stderr.toString().trim().slice(0, 300), devices: []};
  try { return {...base, available: true, devices: parseSimctlDevices(result.stdout.toString())}; }
  catch (error) { return {...base, available: false, error: (error as Error).message, devices: []}; }
}

export interface SnapshotComparison {
  verdict: 'unchanged' | 'violated' | 'unknown';
  preexistingChanged: Array<{udid: string; before: string; after: string | null}>;
  ownedRemaining: string[];
  simulatorAppLaunched: number[];
  warnings: string[];
}

/**
 * 판정은 세 가지뿐이다(설계 §2.5): 이전부터 있던 시뮬레이터의 UDID·상태가 그대로인가, 이 실행이 만든 UDID가
 * 모두 지워졌는가, Simulator.app이 새로 뜨지 않았는가. 설치 앱·Screen pid 변화는 경고다.
 */
export function compareSimulatorSnapshots(before: SimulatorSnapshot, after: SimulatorSnapshot, owned: readonly string[] = []): SnapshotComparison {
  const warnings: string[] = [];
  if (!before.available || !after.available) {
    return {verdict: 'unknown', preexistingChanged: [], ownedRemaining: [], simulatorAppLaunched: [], warnings: [`simctl unavailable: ${before.error ?? after.error ?? ''}`]};
  }
  const ownedSet = new Set(owned);
  const afterByUdid = new Map(after.devices.map(device => [device.udid, device]));
  const preexistingChanged = before.devices
    .filter(device => !ownedSet.has(device.udid))
    .map(device => ({udid: device.udid, before: device.state, after: afterByUdid.get(device.udid)?.state ?? null}))
    .filter(change => change.after !== change.before);
  const ownedRemaining = owned.filter(udid => afterByUdid.has(udid));
  const simulatorAppLaunched = after.simulatorAppPids.filter(pid => !before.simulatorAppPids.includes(pid));
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index]);
  if (!same(before.installedAppPids, after.installedAppPids)) warnings.push('installed AgentsToZ processes changed during the run (outside the run; sandbox blocks 3001)');
  if (!same(before.screenPids, after.screenPids)) warnings.push('AgentsToZ Screen processes changed during the run (outside the run; sandbox blocks 52741)');
  const violated = preexistingChanged.length > 0 || ownedRemaining.length > 0 || simulatorAppLaunched.length > 0;
  return {verdict: violated ? 'violated' : 'unchanged', preexistingChanged, ownedRemaining, simulatorAppLaunched, warnings};
}

// ───────────────────────── 측정 자식 ─────────────────────────

async function measureBind443(): Promise<void> {
  let result: {bindable: boolean; code: string; detail: string};
  try {
    const listener = Bun.listen({hostname: '127.0.0.1', port: 443, socket: {data() {}}});
    listener.stop(true);
    result = {bindable: true, code: 'OK', detail: 'bound and released 127.0.0.1:443'};
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    const code = (error as {code?: string}).code
      ?? (/EADDRINUSE|in use/i.test(message) ? 'EADDRINUSE' : /EACCES|permission/i.test(message) ? 'EACCES' : /EPERM|not permitted/i.test(message) ? 'EPERM' : 'ERROR');
    result = {bindable: false, code, detail: message.slice(0, 200)};
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/**
 * 샌드박스 안의 Bun이 NODE_EXTRA_CA_CERTS로 실행용 CA를 믿는가 — 클라이언트 쪽만 잰다. TLS 서버는 오케스트레이터가
 * 띄우고(그 포트만 이 측정 프로필의 loopback 허용 목록에 있다), 자식은 `https://localhost:<port>`로 연결만 한다.
 */
async function measureCa(args: {port: number}): Promise<void> {
  let result: {ok: boolean; detail: string};
  try {
    const response = await fetch(`https://localhost:${args.port}/`, {signal: AbortSignal.timeout(8_000)});
    result = {ok: response.ok && (await response.text()) === 'trusted', detail: `status=${response.status}`};
  } catch (error) {
    result = {ok: false, detail: String((error as {code?: string}).code ?? (error as Error)?.message ?? error).slice(0, 200)};
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

interface ChildRun {exitCode: number | null; stdout: string; stderr: string; timedOut: boolean}

export async function runChild(argv: string[], options: {cwd: string; env: Record<string, string>; timeoutMs?: number}): Promise<ChildRun> {
  const child = Bun.spawn(argv, {cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe'});
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, options.timeoutMs ?? 30_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return {exitCode, stdout, stderr, timedOut};
}

function lastJsonLine<T>(text: string): T | null {
  const line = text.trim().split('\n').pop();
  if (!line) return null;
  try { return JSON.parse(line) as T; } catch { return null; }
}

function listenersOn(port: number): number[] {
  const out = Bun.spawnSync(['/usr/sbin/lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin:/usr/sbin'}});
  return out.stdout.toString().split('\n').map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value > 0);
}

export interface Capabilities {
  en0PrivateIpv4: string | null;
  privateIpv4: Array<{name: string; address: string}>;
  /**
   * bindable·code는 샌드박스 안(호스트가 실제로 뜨는 조건)의 결과다. 같은 측정을 샌드박스 밖(허용 목록 환경)에서도
   * 한 번 해서 막은 쪽이 커널(특권 포트)인지 샌드박스인지 구별한다.
   */
  loopback443: {bindable: boolean | null; code: string; detail: string; unsandboxed: {bindable: boolean | null; code: string}; listenerPids: number[]};
  bunExtraCaTrust: {trusted: boolean | null; withCa: {ok: boolean; detail: string} | null; withoutCa: {ok: boolean; detail: string} | null; error?: string};
  firewall: {globalState: string | null; stealthMode: string | null; blockAll: string | null};
  secureEnclave: {status: 'not-measured'; by: string};
  appAttest: {status: 'not-measured'; by: string};
  /** 조건부 레인 J1-RELAY-SIM·J4-COMMUNITY-SIM의 전제(443 바인딩·빈 443·Bun CA 신뢰). */
  relaySimConditions: {met: boolean; reasons: string[]};
}

function readFirewall(): Capabilities['firewall'] {
  const read = (flag: string) => {
    const out = Bun.spawnSync(['/usr/libexec/ApplicationFirewall/socketfilterfw', flag], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin'}});
    return out.exitCode === 0 ? out.stdout.toString().trim() : null;
  };
  if (process.platform !== 'darwin' || !existsSync('/usr/libexec/ApplicationFirewall/socketfilterfw')) return {globalState: null, stealthMode: null, blockAll: null};
  return {globalState: read('--getglobalstate'), stealthMode: read('--getstealthmode'), blockAll: read('--getblockall')};
}

/** 측정 전용 CA(openssl). 셰임용 정식 CA는 scripts/emulator-e2e/fixtureCa.ts(WP2)가 만든다. */
async function makeMeasurementCa(dir: string, profile: {path: string; sha256: string}, env: Record<string, string>): Promise<{caPath: string; certPath: string; keyPath: string}> {
  mkdirSync(dir, {recursive: true, mode: 0o700});
  writeFileSync(join(dir, 'server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n', {mode: 0o600});
  const steps: string[][] = [
    ['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1',
      '-subj', '/CN=AgentsToZ emulator preflight measurement CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'],
    ['/usr/bin/openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost'],
    ['/usr/bin/openssl', 'x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '1', '-extfile', 'server.ext'],
  ];
  for (const step of steps) {
    const run = await runChild(sandboxedArgv(profile, step), {cwd: dir, env, timeoutMs: 30_000});
    if (run.exitCode !== 0) throw new Error(`openssl failed (${run.exitCode}): ${run.stderr.trim().slice(-300)}`);
  }
  return {caPath: join(dir, 'ca.pem'), certPath: join(dir, 'server.pem'), keyPath: join(dir, 'server.key')};
}

// ───────────────────────── preflight ─────────────────────────

export interface PreflightOptions {
  runId: string;
  repoRoot?: string;
  /** 실행 스크래치(실제 홈 밖). */
  scratchRoot: string;
  /** 이 실행의 증거 폴더(샌드박스가 쓰기를 허용한다). */
  evidenceDir: string;
  /** 샌드박스 프로필을 쓸 폴더 — 스크래치·증거(쓰기 허용 루트) **밖**이어야 한다(호스트가 프로필을 고쳐 쓰지 못하게). */
  profileDir: string;
  workspaceRootsFile?: string;
  home?: string;
  /** 시뮬레이터 스냅샷을 건너뛴다(단위 테스트용). */
  skipSimulatorSnapshot?: boolean;
  /** 능력 측정을 건너뛴다(단위 테스트용). */
  skipCapabilities?: boolean;
  simulatorLockPath?: string;
}

export interface PreflightReport {
  status: LaneStatus;
  reasons: string[];
  scratchRoot: string;
  hostProfileInput: SandboxProfileInput;
  hostProfile: Pick<WrittenSandboxProfile, 'path' | 'sha256' | 'deniedPorts' | 'allowedLoopbackPorts' | 'lanInbound'>;
  environment: {
    allowlistKeys: string[];
    toolchainKeys: string[];
    violations: string[];
    childIdentity: ChildIdentityReport | null;
    childViolations: string[];
  };
  canaries: CanaryReport | null;
  worktree: WorktreeLocation;
  forbiddenTools: {scanned: string[]; hits: ForbiddenToolHit[]};
  concurrency: {busy: Array<{pid: number; command: string}>};
  simulatorLock: {path: string; held: boolean; holderPid: number | null; error?: string};
  load: {loadavg: number[]; cpuCount: number};
  capabilities: Capabilities | null;
  simulators: SimulatorSnapshot | null;
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const home = options.home ?? realHome();
  const failures: string[] = [];
  const blockers: string[] = [];
  const hostProfileInput: SandboxProfileInput = {writableRoots: [options.scratchRoot, options.evidenceDir], home};
  const hostProfile = writeSandboxProfile(options.profileDir, 'host', hostProfileInput);

  // 1) 허용 목록 환경 + 자식 안의 신원.
  const probeProfile = createIsolatedProfile(options.scratchRoot, 'preflight-probe');
  let env: Record<string, string> = {};
  const environment: PreflightReport['environment'] = {allowlistKeys: [], toolchainKeys: [], violations: [], childIdentity: null, childViolations: []};
  try {
    env = buildAllowlistedEnv({profile: probeProfile, home});
    environment.allowlistKeys = environmentKeyNames(env);
    environment.violations = environmentViolations(env, {home, scratchRoots: [options.scratchRoot]});
  } catch (error) {
    environment.violations.push((error as Error).message);
  }
  environment.toolchainKeys = environmentKeyNames(buildToolchainEnv({home}));
  if (environment.violations.length) failures.push(`allowlisted environment: ${environment.violations.join('; ')}`);

  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    blockers.push('sandbox-exec is unavailable (macOS only)');
  } else if (!environment.violations.length) {
    const identity = await runChild(sandboxedArgv(hostProfile, [process.execPath, '--env-file=/dev/null', join(import.meta.dir, 'environment.ts'), '--probe-identity']), {cwd: probeProfile.root, env, timeoutMs: 60_000});
    environment.childIdentity = lastJsonLine<ChildIdentityReport>(identity.stdout);
    if (!environment.childIdentity) {
      environment.childViolations.push(`identity probe did not report (exit=${identity.exitCode}): ${identity.stderr.trim().slice(-300)}`);
    } else {
      environment.childViolations = childIdentityViolations(environment.childIdentity, {home, profile: probeProfile});
    }
    if (environment.childViolations.length) failures.push(`child identity: ${environment.childViolations.join('; ')}`);
  }

  // 2) 샌드박스 카나리.
  let canaries: CanaryReport | null = null;
  if (!blockers.length && !environment.violations.length) {
    const canaryProfile = createIsolatedProfile(options.scratchRoot, 'canary');
    canaries = await runSandboxCanaries({
      profileInput: hostProfileInput,
      profileDir: options.profileDir,
      env: buildAllowlistedEnv({profile: canaryProfile, home}),
      scratchDir: canaryProfile.tmp,
      repoRoot,
      home,
    });
    if (!canaries.passed) {
      const notBlocked = canaries.results.filter(result => !result.passed).map(result => `${result.id}=${result.verdict}${result.controlPassed ? '' : '(control failed)'}`);
      const staticFailed = canaries.staticChecks.filter(check => !check.passed).map(check => check.id);
      failures.push(`sandbox canaries did not all block: ${[...notBlocked, ...staticFailed, canaries.error ?? ''].filter(Boolean).join(', ')}`);
    }
  }

  // 3) 워크트리 위치, 금지 도구.
  const worktree = checkWorktreeLocation(repoRoot, {workspaceRootsFile: options.workspaceRootsFile, home});
  if (worktree.problems.length) blockers.push(...worktree.problems);
  const scan = harnessScanTargets(repoRoot);
  const hits = detectForbiddenTools(scan);
  if (hits.length) failures.push(`forbidden tools referenced by the harness: ${hits.map(hit => `${hit.file}:${hit.line}(${hit.id})`).join(', ')}`);

  // 4) 동시 실행·부팅 잠금·부하(기다리지 않고 기록만 — 레인이 기다린다).
  const rows = listProcesses('command');
  const busy = findConcurrentChecks(rows, ownProcessTree(rows)).map(row => ({pid: row.pid, command: row.command.slice(0, 200)}));
  const lockPath = options.simulatorLockPath ?? defaultSimulatorLockPath(home);
  const lock = readSimulatorLock(lockPath);

  // 5) 능력 측정.
  let capabilities: Capabilities | null = null;
  if (!options.skipCapabilities && !blockers.includes('sandbox-exec is unavailable (macOS only)') && !environment.violations.length) {
    capabilities = await measureCapabilities({scratchRoot: options.scratchRoot, profileDir: options.profileDir, hostProfile, identity: environment.childIdentity, home});
  }

  const status: LaneStatus = failures.length ? 'fail' : blockers.length ? 'blocked' : 'pass';
  return {
    status,
    reasons: [...failures, ...blockers],
    scratchRoot: options.scratchRoot,
    hostProfileInput,
    hostProfile: {path: hostProfile.path, sha256: hostProfile.sha256, deniedPorts: hostProfile.deniedPorts, allowedLoopbackPorts: hostProfile.allowedLoopbackPorts, lanInbound: hostProfile.lanInbound},
    environment,
    canaries,
    worktree,
    forbiddenTools: {scanned: scan.map(file => file.path), hits},
    concurrency: {busy},
    simulatorLock: {path: lockPath, held: lock.held, holderPid: lock.holder?.pid ?? null, ...(lock.error ? {error: lock.error} : {})},
    load: {loadavg: loadavg().map(value => Math.round(value * 100) / 100), cpuCount: cpus().length},
    capabilities,
    simulators: options.skipSimulatorSnapshot ? null : takeSimulatorSnapshot(),
  };
}

export async function measureCapabilities(input: {scratchRoot: string; profileDir: string; hostProfile: WrittenSandboxProfile; identity: ChildIdentityReport | null; home?: string}): Promise<Capabilities> {
  const home = input.home ?? realHome();
  const measureProfile = createIsolatedProfile(input.scratchRoot, 'capabilities');
  const env = buildAllowlistedEnv({profile: measureProfile, home});
  const self = import.meta.path;

  // 127.0.0.1:443 — 점유는 관측(lsof), 바인딩 가능 여부는 샌드박스 자식이 실제로 묶어 보고 바로 놓는다.
  const listenerPids = listenersOn(443);
  const bindArgv = [process.execPath, '--env-file=/dev/null', self, '--measure-bind-443'];
  const bind = await runChild(sandboxedArgv(input.hostProfile, bindArgv), {cwd: measureProfile.root, env, timeoutMs: 30_000});
  const bound = lastJsonLine<{bindable: boolean; code: string; detail: string}>(bind.stdout);
  const bareBind = await runChild(bindArgv, {cwd: measureProfile.root, env, timeoutMs: 30_000});
  const bareBound = lastJsonLine<{bindable: boolean; code: string; detail: string}>(bareBind.stdout);
  const loopback443 = {
    bindable: bound?.bindable ?? null, code: bound?.code ?? 'NO_REPORT', detail: bound?.detail ?? bind.stderr.trim().slice(-200),
    unsandboxed: {bindable: bareBound?.bindable ?? null, code: bareBound?.code ?? 'NO_REPORT'},
    listenerPids,
  };

  // Bun이 NODE_EXTRA_CA_CERTS를 따르는가 — 같은 서버를 CA 있이·없이 한 번씩(없이가 실패해야 측정이 의미 있다).
  // 서버는 여기(샌드박스 밖)서 띄우고, 측정 프로필은 그 포트 하나만 loopback 허용 목록에 넣는다.
  const bunExtraCaTrust: Capabilities['bunExtraCaTrust'] = {trusted: null, withCa: null, withoutCa: null};
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    const ca = await makeMeasurementCa(join(input.scratchRoot, 'measurement-ca'), input.hostProfile, env);
    server = Bun.serve({hostname: '127.0.0.1', port: 0, tls: {cert: readFileSync(ca.certPath, 'utf8'), key: readFileSync(ca.keyPath, 'utf8')}, fetch: () => new Response('trusted')});
    const caProfile = writeSandboxProfile(input.profileDir, 'measure-ca', {...input.hostProfile.input, allowedLoopbackPorts: [...(input.hostProfile.input.allowedLoopbackPorts ?? []), server.port!]});
    const argv = sandboxedArgv(caProfile, [process.execPath, '--env-file=/dev/null', self, '--measure-ca', JSON.stringify({port: server.port})]);
    const withCa = await runChild(argv, {cwd: measureProfile.root, env: buildAllowlistedEnv({profile: measureProfile, home, extraCaCerts: ca.caPath}), timeoutMs: 30_000});
    const withoutCa = await runChild(sandboxedArgv(caProfile, argv.slice(3)), {cwd: measureProfile.root, env, timeoutMs: 30_000});
    bunExtraCaTrust.withCa = lastJsonLine(withCa.stdout) ?? {ok: false, detail: withCa.stderr.trim().slice(-200)};
    bunExtraCaTrust.withoutCa = lastJsonLine(withoutCa.stdout) ?? {ok: false, detail: withoutCa.stderr.trim().slice(-200)};
    bunExtraCaTrust.trusted = bunExtraCaTrust.withCa.ok && !bunExtraCaTrust.withoutCa.ok ? true
      : !bunExtraCaTrust.withCa.ok && !bunExtraCaTrust.withoutCa.ok ? false : null;
    if (bunExtraCaTrust.trusted === null) bunExtraCaTrust.error = 'control request without the CA also succeeded — measurement is inconclusive';
  } catch (error) {
    bunExtraCaTrust.error = (error as Error).message;
  } finally {
    server?.stop(true);
  }

  const reasons: string[] = [];
  if (loopback443.bindable !== true) {
    const where = loopback443.unsandboxed.bindable === false ? 'refused by the kernel as well (privileged port, no sudo)' : 'refused inside the host sandbox';
    reasons.push(`127.0.0.1:443 is not bindable (${loopback443.code}; ${where})`);
  }
  if (listenerPids.length) reasons.push(`port 443 is already in use (pid ${listenerPids.join(', ')})`);
  if (bunExtraCaTrust.trusted !== true) reasons.push(`Bun does not demonstrably trust NODE_EXTRA_CA_CERTS (${bunExtraCaTrust.error ?? bunExtraCaTrust.withCa?.detail ?? 'unknown'})`);
  return {
    en0PrivateIpv4: input.identity?.en0PrivateIpv4 ?? null,
    privateIpv4: input.identity?.privateIpv4 ?? [],
    loopback443,
    bunExtraCaTrust,
    firewall: readFirewall(),
    secureEnclave: {status: 'not-measured', by: 'simulator probe app capability mode (WP9)'},
    appAttest: {status: 'not-measured', by: 'simulator probe app capability mode (WP9)'},
    relaySimConditions: {met: reasons.length === 0, reasons},
  };
}

export function preflightRelativePath(repoRoot: string, path: string): string {
  return relative(repoRoot, path);
}

if (import.meta.main) {
  if (process.argv[2] === '--measure-bind-443') await measureBind443();
  else if (process.argv[2] === '--measure-ca') await measureCa(JSON.parse(process.argv[3] ?? '{}') as {port: number});
}
