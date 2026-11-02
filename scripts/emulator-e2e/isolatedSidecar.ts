/**
 * 격리 사이드카 런처(설계 §2.2·§2.3·WP1). scripts/perf/sidecar.ts의 isolatedRoot·forbiddenOpenFiles·startSidecar를
 * 옮겨 와 에뮬레이터 하네스와 성능 기준선이 같이 쓴다.
 *
 * ⚠️ 실사용 사이드카(3001)와 실제 앱 데이터를 절대 쓰지 않는다. 사이드카마다 스크래치 HOME·APP_DATA_DIR을 준다.
 * - 에뮬레이터 레인은 **샌드박스 프로필을 반드시** 넘긴다(타입이 요구한다). 런처는 그 프로필 입력에 사이드카 자기
 *   포트를 loopback 허용 목록으로 더한 변형 프로필을 같은 폴더(쓰기 허용 루트 밖)에 쓰고, 띄우기 직전에 해시를 다시
 *   잰다. 환경은 허용 목록 환경(environment.ts)만 넘긴다.
 * - 성능 측정만 측정 의미를 지키려고 `'unsandboxed-perf-measurement'`를 명시해 샌드박스를 빼고, 예전 측정 환경
 *   (buildPerfMeasurementEnv — 상속 PATH·TMPDIR, NODE_ENV·PORT 없음, 관리 Origin localhost:9000)을 그대로 쓴다.
 *   하네스가 도는 동안(markHarnessActive)에는 이 모드를 거절한다 — 레인이 샌드박스를 우회할 길을 막는다.
 * - 포트는 port 0으로 받아 읽어 온다. 사이드카는 API_PORT=0을 3001로 바꿔 읽으므로(`Number(...) || 3001`)
 *   0을 그대로 넘길 수는 없다. 그래서 받아 온 번호로 띄운 뒤 **그 포트의 LISTEN 소켓이 우리 자식 pid의 것인지**
 *   lsof로 확인한다. 아니면(경쟁 창에 다른 프로세스가 잡았으면) 그 응답을 버리고 새 번호로 다시 띄운다.
 * - 소스 모드를 우선한다. 관리 요청은 Origin `http://localhost:$PORT`로 보낸다(PORT는 이 런처가 정한 값).
 * - 가짜 CLI는 $HOME/.local/bin에 둔다. 픽스처 ports.json·workspace-roots.json·portal.json도 쓴다 — 경로는
 *   실행 스크래치 안이어야 하고, Supabase 주소는 loopback이어야 한다.
 * - `observeSideEffects`는 tests/fixtures/side-effect-guard-entry.ts로 감싼다. 이 래퍼와 lsof는 **관측용**이다:
 *   api-server는 로드할 때 child_process를 바인딩하고 네이티브 애드온은 래퍼를 거치지 않으므로 차단을 보장하지
 *   못한다. 차단은 샌드박스가 한다. 래퍼는 build-sidecar 진입점에 들어가지 않는다.
 * - `entryWrapper`(WP10)는 레인 전용 **대역** 래퍼다(예: dialogue-keychain-entry.ts — 대화 기기 키의 키체인 → 스크래치 파일).
 *   scripts/emulator-e2e/*-entry.ts만 받고, 래퍼가 대역을 설치한 뒤 위 진입점(관측 래퍼 또는 api-server.ts)을 이어서 import한다.
 * - LAN 호스트(lanInbound 프로필)는 그 포트의 LAN 바인딩 가드(sandbox.ts)가 있어야 뜬다. health 확인 뒤 가드로 한 번
 *   더 보고, en0 밖 리스너가 있었으면(띄우는 동안 포함) 멈추고 실패로 던진다(검토 #9). 그 뒤는 가드의 감시가 맡는다.
 */
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  REPO_ROOT,
  RESERVED_LOOPBACK_PORTS,
  buildAllowlistedEnv,
  createIsolatedProfile,
  environmentKeyNames,
  isWithin,
  mentionsProductionSupabase,
  realAppDataDir,
  realHome,
  type IsolatedProfile,
} from './environment';
import {activeLanBindingGuard, sandboxedArgv, writeSandboxProfile, type LanBindingGuard, type WrittenSandboxProfile} from './sandbox';

export const REAL_APP_DATA_DIR = realAppDataDir();
export const INSTALLED_SIDECAR = '/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-api-sidecar';
export const SIDE_EFFECT_GUARD_ENTRY = resolve(REPO_ROOT, 'tests', 'fixtures', 'side-effect-guard-entry.ts');
export const SIDE_EFFECT_LOG_ENV = 'AGENTSTOZ_EMULATOR_SIDE_EFFECT_LOG';
/** 레인 진입 래퍼(entryWrapper)가 대역을 설치한 뒤 import할 진입점 — 관측 래퍼 또는 api-server.ts(이 런처만 정한다). */
export const NEXT_ENTRY_ENV = 'AGENTSTOZ_EMULATOR_NEXT_ENTRY';
/** 레인 진입 래퍼가 놓일 수 있는 유일한 폴더(운영 빌드 진입점이 아니다 — 테스트가 build-sidecar 계획으로 확인한다). */
export const LANE_ENTRY_WRAPPER_DIR = resolve(REPO_ROOT, 'scripts', 'emulator-e2e');

/** entryWrapper 검사: 샌드박스 소스 사이드카만, scripts/emulator-e2e/<name>-entry.ts만, 실제로 있는 파일만. */
export function assertLaneEntryWrapper(path: string, kind: 'source' | 'installed', sandbox: SidecarSandbox): void {
  if (kind !== 'source') throw new Error('an entry wrapper wraps the source entry only');
  if (sandbox === PERF_MEASUREMENT_MODE) throw new Error('the perf measurement mode takes no entry wrapper');
  if (typeof path !== 'string' || resolve(path) !== path || !path.startsWith(`${LANE_ENTRY_WRAPPER_DIR}/`)) {
    throw new Error(`an entry wrapper must be an absolute path under ${LANE_ENTRY_WRAPPER_DIR}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*-entry\.ts$/.test(path.slice(LANE_ENTRY_WRAPPER_DIR.length + 1)) || !existsSync(path)) {
    throw new Error(`entry wrapper ${path} must be an existing scripts/emulator-e2e/<name>-entry.ts`);
  }
}

/** 프로세스가 열면 안 되는 실제 사용자 위치(lsof 관측). */
export function forbiddenPrefixes(home: string = realHome()): string[] {
  return [realAppDataDir(home), join(home, '.claude'), join(home, '.codex'), join(home, '.hermes'), join(home, '.gemini'), join(home, 'Library', 'Keychains')];
}

/** 측정이 중단돼도(Ctrl-C·예외) 격리 사이드카를 남기지 않는다. */
const runningChildren = new Set<Bun.Subprocess>();
let cleanupInstalled = false;
/** 하네스가 띄운 자식을 추적한다 — 하네스가 끝나거나 신호로 죽을 때 SIGKILL한다(shim 호스트도 쓴다). */
export function trackChild(child: Bun.Subprocess): void {
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    const killAll = () => { for (const running of runningChildren) { try { running.kill('SIGKILL'); } catch {} } };
    process.on('exit', killAll);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { killAll(); process.exit(130); });
  }
  runningChildren.add(child);
  void child.exited.then(() => runningChildren.delete(child));
}

/** port 0으로 묶어 번호를 받아 온다(바로 놓는다 — 그 뒤 소유 확인으로 경쟁을 잡는다). */
export function reserveLoopbackPort(): number {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('')});
    const port = probe.port;
    probe.stop(true);
    if (port && !(RESERVED_LOOPBACK_PORTS as readonly number[]).includes(port)) return port;
  }
  throw new Error('no free loopback port');
}

/** 그 포트의 TCP LISTEN 소켓이 이 pid의 것인가(관측: lsof). */
export function listenerOwnedBy(pid: number, port: number): boolean {
  const out = Bun.spawnSync(['/usr/sbin/lsof', '-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin:/usr/sbin'}});
  return out.stdout.toString().split('\n').some(line => Number(line.trim()) === pid);
}

export type IsolatedRoot = IsolatedProfile;

/** 성능 기준선과 하네스가 같이 쓰는 격리 배치(HOME·앱 데이터·캐시·tmux·bin이 모두 `root` 아래). */
export function isolatedRoot(scratch: string, label: string): IsolatedRoot {
  return createIsolatedProfile(scratch, `sidecar-${label}`);
}

/** 프로세스가 연 파일 중 금지된 위치가 있으면 그 경로들을 돌려준다(관측). */
export function forbiddenOpenFiles(pid: number, options: {repoRoot?: string; home?: string} = {}): string[] {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const prefixes = forbiddenPrefixes(options.home);
  const out = Bun.spawnSync(['/usr/sbin/lsof', '-p', String(pid), '-Fn'], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin:/usr/sbin'}}).stdout.toString();
  return out.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1))
    // A managed checkout may live under ~/.codex/worktrees. lsof reports the
    // sidecar's cwd there even when it opens no user data; keep every child
    // path subject to the guard so .env and other files are still detected.
    .filter(path => path !== repoRoot && prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`)));
}

// ───────────────────────── 픽스처 ─────────────────────────

export interface WorkspaceRootFixture {id: string; name: string; path: string}

export interface SidecarFixtures {
  /** ports.json 행(PortInfo). folderPath·worktreePath는 실행 스크래치 안이어야 한다. */
  ports?: Array<Record<string, unknown>>;
  workspaceRoots?: WorkspaceRootFixture[];
  /** portal.json. supabaseUrl은 loopback(픽스처 shim)이어야 한다. */
  portal?: Record<string, unknown>;
  /** $HOME/.local/bin/<name> 가짜 CLI 스크립트(실행 권한으로 쓴다). */
  fakeClis?: Record<string, string>;
}

function assertScratchPath(label: string, value: unknown, scratchRoot: string): void {
  if (typeof value !== 'string' || !value.startsWith('/')) return;
  if (!isWithin(resolve(value), scratchRoot)) throw new Error(`${label} ${value} is outside the run scratch ${scratchRoot}`);
}

function assertLoopbackSupabase(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'string') throw new Error('portal.supabaseUrl must be a string');
  if (mentionsProductionSupabase(value)) throw new Error('portal.supabaseUrl points at the production Supabase project');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('portal.supabaseUrl must be a URL'); }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`portal.supabaseUrl must be a loopback fixture (got ${url.hostname})`);
  const port = url.port ? Number(url.port) : null;
  if (port !== null && (RESERVED_LOOPBACK_PORTS as readonly number[]).includes(port)) throw new Error(`portal.supabaseUrl targets reserved port ${port}`);
}

/** 픽스처 파일을 쓴다. 스크래치 밖 경로·운영 Supabase는 거절한다. */
export function writeSidecarFixtures(root: IsolatedRoot, fixtures: SidecarFixtures, options: {scratchRoot?: string} = {}): void {
  const scratchRoot = options.scratchRoot ?? resolve(root.root, '..');
  for (const [index, row] of (fixtures.ports ?? []).entries()) {
    assertScratchPath(`ports[${index}].folderPath`, row.folderPath, scratchRoot);
    assertScratchPath(`ports[${index}].worktreePath`, row.worktreePath, scratchRoot);
    if (typeof row.commandPath === 'string' && row.commandPath.endsWith('.command')) assertScratchPath(`ports[${index}].commandPath`, row.commandPath, scratchRoot);
    for (const value of Object.values(row)) if (typeof value === 'string' && mentionsProductionSupabase(value)) throw new Error(`ports[${index}] mentions the production Supabase project`);
  }
  for (const [index, entry] of (fixtures.workspaceRoots ?? []).entries()) assertScratchPath(`workspaceRoots[${index}].path`, entry.path, scratchRoot);
  if (fixtures.portal) {
    assertLoopbackSupabase(fixtures.portal.supabaseUrl);
    if (JSON.stringify(fixtures.portal).match(/yfbivsatsorbidfutkvb/)) throw new Error('portal.json mentions the production Supabase project');
  }
  mkdirSync(root.appDataDir, {recursive: true, mode: 0o700});
  if (fixtures.ports) writeFileSync(join(root.appDataDir, 'ports.json'), JSON.stringify(fixtures.ports, null, 2), {mode: 0o600});
  if (fixtures.workspaceRoots) writeFileSync(join(root.appDataDir, 'workspace-roots.json'), JSON.stringify(fixtures.workspaceRoots, null, 2), {mode: 0o600});
  if (fixtures.portal) writeFileSync(join(root.appDataDir, 'portal.json'), JSON.stringify(fixtures.portal, null, 2), {mode: 0o600});
  for (const [name, script] of Object.entries(fixtures.fakeClis ?? {})) writeFakeCli(root, name, script);
}

export function writeFakeCli(root: IsolatedRoot, name: string, script: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid fake CLI name ${name}`);
  mkdirSync(root.localBin, {recursive: true, mode: 0o700});
  const path = join(root.localBin, name);
  writeFileSync(path, script.startsWith('#!') ? script : `#!/bin/sh\n${script}`, {mode: 0o700});
  chmodSync(path, 0o700);
  return path;
}

// ───────────────────────── 실행 ─────────────────────────

export const PERF_MEASUREMENT_MODE = 'unsandboxed-perf-measurement' as const;
export type SidecarSandbox = WrittenSandboxProfile | typeof PERF_MEASUREMENT_MODE;

/** 예전 성능 측정의 관리 Origin(PORT를 넘기지 않으면 사이드카가 신뢰하는 웹 UI origin). */
export const PERF_MANAGEMENT_ORIGIN = 'http://localhost:9000';

let harnessActiveDepth = 0;

/**
 * 하네스가 도는 동안 표시한다(runHarness). 그동안 startSidecar는 비샌드박스 성능 측정 모드를 거절한다(검토 #5).
 * 돌려받은 함수로 표시를 푼다(두 번 불러도 한 번만 푼다).
 */
export function markHarnessActive(): () => void {
  harnessActiveDepth += 1;
  let released = false;
  return () => { if (!released) { released = true; harnessActiveDepth -= 1; } };
}

export function isHarnessActive(): boolean {
  return harnessActiveDepth > 0;
}

/**
 * 성능 측정 전용 환경 — scripts/perf/sidecar.ts가 옮겨 오기 전의 isolatedEnv와 같은 키·값이다(검토 #8: 측정 조건을
 * 조용히 바꾸지 않는다). NODE_ENV(test 전용 분기)·PORT·NO_COLOR 등은 넣지 않는다. 상속하는 것은 PATH·TMPDIR 값뿐이고
 * 금지 키는 하나도 복사하지 않는다(빈 객체에서 만든다).
 */
export function buildPerfMeasurementEnv(root: IsolatedRoot, port: number, inherited: Record<string, string | undefined> = process.env): Record<string, string> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('API_PORT must be a positive TCP port');
  if ((RESERVED_LOOPBACK_PORTS as readonly number[]).includes(port)) throw new Error(`API_PORT ${port} is reserved (installed sidecar / real Screen / Appium)`);
  return {
    PATH: inherited.PATH ?? '/usr/bin:/bin',
    HOME: root.home,
    USERPROFILE: root.home,
    TMPDIR: inherited.TMPDIR ?? '/tmp',
    LANG: 'en_US.UTF-8',
    APP_DATA_DIR: root.appDataDir,
    APPDATA: root.appDataRoaming,
    XDG_CONFIG_HOME: root.xdgConfig,
    HERMES_HOME: root.hermesHome,
    API_PORT: String(port),
    // 부팅 때 사용자 설정을 맞추는 작업은 격리 HOME에서도 돌 이유가 없다.
    AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1',
    AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1',
    AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC: '1',
  };
}

export interface StartSidecarOptions {
  /** 에뮬레이터 레인은 프로필을 넘긴다(writeSandboxProfile 결과). 성능 측정만 명시적으로 뺀다. */
  sandbox: SidecarSandbox;
  /** 관측 래퍼로 감싼다(소스 모드만). */
  observeSideEffects?: boolean;
  /**
   * 레인 전용 대역 진입 래퍼(소스 모드만, WP10). `scripts/emulator-e2e/*-entry.ts`만 받는다 — 운영 빌드 진입점이 아니다.
   * 래퍼는 자기 대역을 설치한 뒤 `AGENTSTOZ_EMULATOR_NEXT_ENTRY`(관측 래퍼 또는 api-server.ts — 이 런처가 정한다)를 import한다.
   */
  entryWrapper?: string;
  laneOverrides?: Record<string, string>;
  extraCaCerts?: string;
  healthTimeoutMs?: number;
  /** health가 다른 프로세스에서 왔을 때 새 포트로 다시 띄우는 횟수. */
  maxPortAttempts?: number;
  /** 시작 후 lsof 누수 검사를 한다(관측). */
  checkOpenFiles?: boolean;
}

export interface RunningSidecar {
  child: Bun.Subprocess;
  pid: number;
  port: number;
  baseUrl: string;
  /** 사이드카의 PORT — 신뢰 웹 UI origin(`http://localhost:$PORT`)에만 쓰인다. 성능 측정 모드는 null(PORT 없음). */
  webUiPort: number | null;
  managementOrigin: string;
  readyMs: number;
  stderrLog: string;
  sideEffectLog: string | null;
  sandboxed: boolean;
  /** 실제로 띄운 프로필(자기 포트를 더한 변형). 성능 측정 모드는 null. */
  sandboxProfile: {path: string; sha256: string; allowedLoopbackPorts: number[]} | null;
  /**
   * LAN 호스트(lanInbound 프로필)만: 그 포트를 지켜보는 하네스 가드. 안전 판정은 가드의 violations가 하고(레인이 끝나면
   * 하네스가 본다), `listening()`은 레인이 「en0:<포트>에 떴다」를 기능으로 확인할 때 쓴다. 아니면 null.
   */
  lanBinding: {port: number; expectedAddress: string; violations(): readonly string[]; listening(): Promise<boolean>} | null;
  envKeys: string[];
  stop: () => Promise<void>;
}

/**
 * LAN inbound를 여는 프로필이면 그 포트의 가드(없으면 던진다 — 가드 없이 LAN 호스트를 띄우지 않는다).
 * 사이드카의 LAN 서버는 포트 하나다 — 추가 포트(extraPorts, j1-pty처럼 스크립트가 여러 origin을 여는 레인 전용)를 연
 * 프로필로는 사이드카를 띄우지 않는다(그 포트들의 감시·멈춤을 사이드카 쪽이 맡지 않으므로).
 */
function lanGuardFor(profile: WrittenSandboxProfile): LanBindingGuard | null {
  if (!profile.lanInbound) return null;
  if (profile.lanInbound.extraPorts?.length) {
    throw new Error(`a sidecar LAN host takes one LAN inbound port (profile also opens ${profile.lanInbound.extraPorts.join(', ')}) — use a single-port lanInbound profile`);
  }
  const guard = activeLanBindingGuard(profile.lanInbound.port);
  if (!guard) throw new Error(`a LAN host (inbound port ${profile.lanInbound.port}) needs an active LAN binding guard — start it through the harness (ctx.startSidecar)`);
  return guard;
}

export async function startSidecar(root: IsolatedRoot, kind: 'source' | 'installed', options: StartSidecarOptions): Promise<RunningSidecar> {
  if (options.sandbox === undefined) throw new Error('startSidecar requires an explicit sandbox choice');
  if (options.sandbox === PERF_MEASUREMENT_MODE) {
    if (isHarnessActive()) throw new Error('the unsandboxed perf measurement mode is refused while the emulator harness runs — lanes must pass a sandbox profile');
    if (options.observeSideEffects || options.laneOverrides || options.extraCaCerts) throw new Error('the perf measurement mode takes no lane overrides, CA or side-effect wrapper');
  } else if (typeof options.sandbox !== 'object' || !options.sandbox.input || !options.sandbox.dir || !options.sandbox.sha256) {
    throw new Error('startSidecar needs a sandbox profile written by writeSandboxProfile');
  } else {
    lanGuardFor(options.sandbox);
  }
  if (kind === 'installed' && options.observeSideEffects) throw new Error('side-effect observation wraps the source entry only');
  if (options.entryWrapper !== undefined) assertLaneEntryWrapper(options.entryWrapper, kind, options.sandbox);
  const attempts = Math.max(1, options.maxPortAttempts ?? 5);
  const failures: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const started = await startOnce(root, kind, options, attempt);
    if (started.ok) return started.sidecar;
    failures.push(started.reason);
    if (!started.retry) break;
  }
  throw new Error(`isolated ${kind} sidecar did not start: ${failures.join(' | ')}`);
}

async function startOnce(root: IsolatedRoot, kind: 'source' | 'installed', options: StartSidecarOptions, attempt: number): Promise<{ok: true; sidecar: RunningSidecar} | {ok: false; retry: boolean; reason: string}> {
  const perf = options.sandbox === PERF_MEASUREMENT_MODE;
  const port = reserveLoopbackPort();
  const webUiPort = perf ? null : reserveLoopbackPort();
  const sideEffectLog = options.observeSideEffects ? join(root.root, `side-effects-${port}.jsonl`) : null;
  const productEntry = options.observeSideEffects ? SIDE_EFFECT_GUARD_ENTRY : join(REPO_ROOT, 'api-server.ts');
  const laneOverrides = {
    ...(options.laneOverrides ?? {}),
    ...(sideEffectLog ? {[SIDE_EFFECT_LOG_ENV]: sideEffectLog} : {}),
    ...(options.entryWrapper ? {[NEXT_ENTRY_ENV]: productEntry} : {}),
  };
  const env = perf
    ? buildPerfMeasurementEnv(root, port)
    : buildAllowlistedEnv({profile: root, apiPort: port, webUiPort: webUiPort!, extraCaCerts: options.extraCaCerts, laneOverrides});
  const entry = options.entryWrapper ?? productEntry;
  const base = kind === 'source'
    // --env-file=/dev/null: 작업 트리에 .env가 있어도 읽지 않는다(CLAUDE.md 「에이전트 런타임 가드」).
    ? [process.execPath, '--env-file=/dev/null', entry]
    : [INSTALLED_SIDECAR];
  // 사이드카는 자기 API_PORT로 자기 자신을 부른다(api-server.ts의 내부 fetch) — 그 포트만 loopback 허용 목록에 더한다.
  let spawnProfile: WrittenSandboxProfile | null = null;
  if (!perf) {
    const profile = options.sandbox as WrittenSandboxProfile;
    const name = `${profile.path.split('/').pop()!.replace(/\.sb$/, '')}-sidecar-${port}`;
    spawnProfile = writeSandboxProfile(profile.dir, name, {...profile.input, allowedLoopbackPorts: [...(profile.input.allowedLoopbackPorts ?? []), port]});
  }
  const lanGuard = spawnProfile ? lanGuardFor(spawnProfile) : null;
  const lanViolationsBefore = lanGuard?.violations.length ?? 0;
  const command = spawnProfile ? sandboxedArgv(spawnProfile, base) : base;
  // 파이프로 받으면 아무도 읽지 않는 동안 버퍼가 차서 사이드카가 멈출 수 있다 — 파일로 받는다.
  const stderrLog = join(root.root, `sidecar-${port}-${attempt}.stderr.log`);
  const t0 = performance.now();
  const child = Bun.spawn(command, {cwd: kind === 'source' ? REPO_ROOT : root.root, env, stdout: 'ignore', stderr: Bun.file(stderrLog)});
  trackChild(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  let exitCode: number | null = null;
  void child.exited.then(code => { exitCode = code; });
  let readyMs = -1;
  const deadline = options.healthTimeoutMs ?? 30_000;
  while (performance.now() - t0 < deadline) {
    if (exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.status === 200) { readyMs = performance.now() - t0; break; }
    } catch { /* not listening yet */ }
    await Bun.sleep(5);
  }
  const stop = async () => {
    try { child.kill('SIGTERM'); } catch {}
    const exited = await Promise.race([child.exited, Bun.sleep(8_000).then(() => null)]);
    if (exited === null) { try { child.kill('SIGKILL'); } catch {} await child.exited; }
  };
  if (readyMs < 0) {
    const stderr = existsSync(stderrLog) ? readFileSync(stderrLog, 'utf8') : '';
    await stop();
    const inUse = /EADDRINUSE|port \d+ in use|Is port \d+ in use/i.test(stderr);
    return {ok: false, retry: inUse, reason: `never became healthy (exit=${exitCode}): ${stderr.slice(-1500)}`};
  }
  // health 200이 정말 우리 자식에게서 왔는가(경쟁 창에 다른 프로세스가 그 포트를 잡았을 수 있다).
  if (!listenerOwnedBy(child.pid, port)) {
    await stop();
    return {ok: false, retry: true, reason: `port ${port} answered but is not owned by pid ${child.pid}`};
  }
  // LAN 호스트: 지금 한 번 더 보고, 띄우는 동안 가드가 본 위반까지 센다(검토 #9). 하나라도 있으면 멈추고 던진다.
  if (lanGuard) {
    const now = await lanGuard.check();
    const fresh = [...new Set([...lanGuard.violations.slice(lanViolationsBefore), ...now])];
    if (fresh.length) {
      await stop();
      throw new Error(`LAN host bound outside ${lanGuard.expectedAddress}:${lanGuard.port} — stopped: ${fresh.join('; ')}`);
    }
  }
  const sidecar: RunningSidecar = {
    child, pid: child.pid, port, baseUrl, webUiPort,
    managementOrigin: webUiPort === null ? PERF_MANAGEMENT_ORIGIN : `http://localhost:${webUiPort}`,
    readyMs, stderrLog, sideEffectLog, sandboxed: spawnProfile !== null,
    sandboxProfile: spawnProfile ? {path: spawnProfile.path, sha256: spawnProfile.sha256, allowedLoopbackPorts: spawnProfile.allowedLoopbackPorts} : null,
    lanBinding: lanGuard ? {
      port: lanGuard.port,
      expectedAddress: lanGuard.expectedAddress,
      violations: () => lanGuard.violations,
      listening: () => lanGuard.listening(),
    } : null,
    envKeys: environmentKeyNames(env),
    stop,
  };
  if (options.checkOpenFiles) {
    const leaks = forbiddenOpenFiles(child.pid);
    if (leaks.length) {
      await stop();
      throw new Error(`isolated sidecar opened real user files: ${leaks.slice(0, 5).join(', ')}`);
    }
  }
  return {ok: true, sidecar};
}

/** 관리 요청(Origin `http://localhost:$PORT`). 예약 포트로는 보내지 않는다. */
export async function managementRequest(sidecar: Pick<RunningSidecar, 'baseUrl' | 'port' | 'managementOrigin'>, path: string, body: unknown = {}, method: 'POST' | 'GET' = 'POST'): Promise<{status: number; json: Record<string, any>}> {
  if ((RESERVED_LOOPBACK_PORTS as readonly number[]).includes(sidecar.port)) throw new Error(`refusing to talk to reserved port ${sidecar.port}`);
  if (!path.startsWith('/')) throw new Error('management path must start with /');
  const response = await fetch(`${sidecar.baseUrl}${path}`, {
    method,
    headers: {'Content-Type': 'application/json', Origin: sidecar.managementOrigin},
    ...(method === 'POST' ? {body: JSON.stringify(body)} : {}),
  });
  const text = await response.text();
  let json: Record<string, any>;
  try { json = JSON.parse(text) as Record<string, any>; } catch { json = {raw: text.slice(0, 500)}; }
  return {status: response.status, json};
}

/** 관측 래퍼가 남긴 기록(JSONL). */
export function readSideEffectLog(sidecar: Pick<RunningSidecar, 'sideEffectLog'>): Array<Record<string, unknown>> {
  if (!sidecar.sideEffectLog || !existsSync(sidecar.sideEffectLog)) return [];
  return readFileSync(sidecar.sideEffectLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
