#!/usr/bin/env bun
/**
 * 에뮬레이터(iOS 시뮬레이터 + 격리 로컬 호스트) 종단 시험 오케스트레이터.
 * 설계: ~/agentstoz-emulator/harness-design.md(개정 2). 이 파일은 WP0(preflight·허용 목록 환경·동시 실행 가드·능력
 * 측정)과 WP1(필수 샌드박스·카나리·격리 호스트 런처)의 진입점이고, 레인은 뒤 패키지가 등록한다.
 *
 *   bun scripts/emulator-e2e.ts preflight      # 아무것도 띄우지 않는다(측정용 단기 자식·리스너만)
 *   bun scripts/emulator-e2e.ts <lane>         # j1-lan | j1-pty | j1-relay-web | j1-relay-sim | j2 | j2-model | j2-boundary | j3a-process | j3b | j4-fixture | j4-web | j4-sim | screen-host-selfcheck
 *   bun scripts/emulator-e2e.ts all            # 무인 레인 + 조건이 충족된 조건부 레인(opt-in 제외). 조건이 안 된
 *                                              # 조건부 레인은 돌리지 않고 「조건 미충족」으로 따로 기록한다 — 통과도 아니고
 *                                              # 종료 코드에도 들지 않는다(설계 §8). 레인 하나를 직접 부르면 그때는 막힘(3)이다.
 *   bun scripts/emulator-e2e.ts list           # 레인 표와 등록 여부
 *   옵션: --keep-scratch(스크래치를 지우지 않는다)
 *
 * 종료 코드: 통과 0 · 실패 1 · 사용법 2 · 막힘 3 · 건너뜀 4 — 막힘·건너뜀은 통과가 아니다.
 * 증거: <worktree>/mobile/ios/build/emulator-evidence/<runId>/index.json (gitignore, 0700/0600).
 *
 * 레인 등록(뒤 패키지): 아래 LANE_MODULES 표에 `'<id>': () => import('./emulator-e2e/<module>')`를 더하고 그 모듈이
 * `export const lane: LaneDefinition`을 내보낸다. 등록되지 않은 레인은 「skipped: not implemented yet」이다.
 * 레인은 오케스트레이터 프로세스 안에서 호스트 코드(src/)를 import하지 않는다 — 호스트는 ctx의 샌드박스·허용 목록
 * 환경으로 별도 프로세스에 띄운다. 사이드카는 ctx.startSidecar로만 띄운다(샌드박스가 묶여 있다).
 * 조건부 레인은 preconditions를 반드시 선언한다(registerLane이 확인).
 * 등록된 레인: screen-host-selfcheck(WP7 — emulator-e2e/screenFixtureHost.ts의 selfcheck), j1-pty(WP3 —
 * emulator-e2e/workroomPty.ts가 `sandbox-exec … bun mobile/ios/scripts/check-workroom.ts --evidence-dir …
 * --lan-address <en0> --lan-ports <3개>`를 돌린다, opt-in). 격리 WebKit 릴레이와 커뮤니티 레인은
 * 각각 j1-relay-web, j4-fixture, j4-web이다. Supabase 대역은 ctx.startSupabaseShim을 쓴다.
 *
 * 스크래치 배치: <run>/work(호스트 쓰기 허용) · <run>/sandbox(프로필 — 쓰기 허용 루트 밖, 띄우기 직전 해시 확인).
 */
import {cpSync, mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {
  REPO_ROOT,
  buildAllowlistedEnv,
  buildToolchainEnv,
  createIsolatedProfile,
  createRunScratch,
  realHome,
  type AllowlistedEnvInput,
  type IsolatedProfile,
} from './emulator-e2e/environment';
import {
  USAGE_EXIT_CODE,
  createEvidenceRun,
  newRunId,
  normalizeOutcome,
  sourceDigest,
  summarize,
  writeIndex,
  type EvidenceIndex,
  type EvidenceRun,
  type LaneOutcome,
  type LaneResult,
  type LaneStatus,
} from './emulator-e2e/evidence';
import {
  acquireSimulatorBootLock,
  compareSimulatorSnapshots,
  runPreflight,
  takeSimulatorSnapshot,
  waitForQuietSimulatorChecks,
  type ConcurrencyWait,
  type PreflightReport,
  type SimulatorLockResult,
  type SnapshotComparison,
} from './emulator-e2e/preflight';
import {
  lanInboundPorts,
  startLanBindingGuard,
  writeSandboxProfile,
  type LanBindingGuard,
  type SandboxProfileInput,
  type WrittenSandboxProfile,
} from './emulator-e2e/sandbox';

// 뒤 패키지가 쓰는 도우미를 한곳에서 내보낸다.
export * from './emulator-e2e/environment';
export * from './emulator-e2e/evidence';
export * from './emulator-e2e/sandbox';
export {
  acquireSimulatorBootLock,
  compareSimulatorSnapshots,
  takeSimulatorSnapshot,
  waitForQuietSimulatorChecks,
  type PreflightReport,
} from './emulator-e2e/preflight';
export {
  forbiddenOpenFiles,
  isolatedRoot,
  managementRequest,
  readSideEffectLog,
  writeFakeCli,
  writeSidecarFixtures,
  type RunningSidecar,
  type SidecarFixtures,
} from './emulator-e2e/isolatedSidecar';
import {markHarnessActive, startSidecar, trackChild, type IsolatedRoot, type RunningSidecar, type StartSidecarOptions} from './emulator-e2e/isolatedSidecar';
export {
  SUPABASE_SHIM_SCRIPT,
  type RunningSupabaseShim,
  type SupabaseShimReady,
  type SupabaseShimStopped,
} from './emulator-e2e/supabaseShimHost';
import {startSupabaseShimHost, type RunningSupabaseShim, type SupabaseShimHostOptions} from './emulator-e2e/supabaseShimHost';

// ───────────────────────── 레인 표 ─────────────────────────

export const LANE_IDS = Object.freeze([
  'j1-lan', 'j1-pty', 'j1-relay-web', 'j1-relay-sim',
  'j2', 'j2-model', 'j2-boundary', 'j3a-process', 'j3b',
  'j4-fixture', 'j4-web', 'j4-sim',
  'screen-host-selfcheck',
] as const);
export type LaneId = typeof LANE_IDS[number];

/** unattended: 무인 · conditional: preflight 측정이 충족될 때만(아니면 막힘) · opt-in: `all`에 들지 않는다. */
export type LaneKind = 'unattended' | 'conditional' | 'opt-in';

export interface LaneCatalogEntry {id: LaneId; title: string; kind: LaneKind; workPackage: string}

/** 설계 §3·§5의 레인 표. 구현 여부와 관계없이 고정이다(`all`의 순서이기도 하다). */
export const LANE_CATALOG: readonly LaneCatalogEntry[] = Object.freeze([
  {id: 'screen-host-selfcheck', title: 'ScreenFixtureHost self-check (build · nm gate · loopback viewer)', kind: 'unattended', workPackage: 'WP7'},
  {id: 'j1-lan', title: 'J1-LAN-APP — real app LAN journey (simulator XCUITest + sandboxed LAN host)', kind: 'unattended', workPackage: 'WP4'},
  {id: 'j1-pty', title: 'J1-LAN-PTY — check-workroom simulator mode', kind: 'opt-in', workPackage: 'WP3'},
  {id: 'j1-relay-web', title: 'J1-RELAY-WEB — production portal ↔ https shim ↔ real host agent', kind: 'unattended', workPackage: 'WP5'},
  {id: 'j2', title: 'J2-SCREEN-SIM — gesture probe viewer mode (Core + surface only)', kind: 'unattended', workPackage: 'WP8'},
  {id: 'j2-boundary', title: 'J2-APP-BOUNDARY — real app controller-invite refusal', kind: 'unattended', workPackage: 'WP9'},
  {id: 'j3a-process', title: 'J3A fixture processes — MCP → mailbox → fake Control (not installed app)', kind: 'unattended', workPackage: 'J3A'},
  {id: 'j3b', title: 'J3B — controller protocol 5 and fixture session bar', kind: 'unattended', workPackage: 'WP13'},
  {id: 'j4-fixture', title: 'J4 fixture — two sandboxed sidecars share one control-folder profile through the shim community', kind: 'unattended', workPackage: 'WP10'},
  {id: 'j4-web', title: 'J4-COMMUNITY-WEB — phone → Mac A → community → Mac B', kind: 'unattended', workPackage: 'WP11'},
  {id: 'j1-relay-sim', title: 'J1-RELAY-SIM — real app internet path in the simulator', kind: 'conditional', workPackage: 'WP6'},
  {id: 'j4-sim', title: 'J4-COMMUNITY-SIM — community path through the real iOS app', kind: 'conditional', workPackage: 'WP11'},
  {id: 'j2-model', title: 'J2-VIEWER-MODEL — real ScreenViewerModel (Secure Enclave required)', kind: 'conditional', workPackage: 'WP9'},
]);

export interface LaneContext {
  runId: string;
  repoRoot: string;
  /** 실행 스크래치(실제 홈 밖, 호스트 쓰기 허용). 끝나면 지운다. */
  scratchRoot: string;
  /** 샌드박스 프로필 폴더(쓰기 허용 루트 밖). */
  profileDir: string;
  home: string;
  evidence: EvidenceRun;
  preflight: PreflightReport;
  /** 이 실행의 호스트 프로필(쓰기: 스크래치 + 증거). */
  hostSandbox: WrittenSandboxProfile;
  /**
   * 같은 생성기로 변형 프로필. loopback outbound는 허용 목록이다 — 호스트가 연결할 이 실행의 포트(shim·다른 호스트)를
   * `allowedLoopbackPorts`로 밝힌다. LAN 호스트는 `lanInbound: {port, extraPorts?}`(선언한 포트만). 그 프로필을 만드는
   * 순간 하네스가 **선언한 포트마다** LAN 바인딩 가드를 켠다: preflight가 잰 en0 주소 밖(`*`·utun·브리지)에서 리스너를 보면
   * 그 리스너와 그 포트의 사이드카를 멈추고, 레인이 무엇을 돌려주든 그 레인을 실패로 바꾼다(검토 #9). en0 주소가 없으면 던진다.
   */
  sandboxProfile(name: string, extra?: Partial<Pick<SandboxProfileInput, 'lanInbound' | 'extraDeniedPorts' | 'allowedLoopbackPorts'>>): WrittenSandboxProfile;
  /**
   * 격리 사이드카(샌드박스가 묶여 있다 — 기본 hostSandbox, 또는 sandboxProfile로 만든 변형). 비샌드박스 모드는 없다.
   * 레인이 끝날 때 아직 떠 있으면 하네스가 멈춘다.
   */
  startSidecar(root: IsolatedRoot, kind: 'source' | 'installed', options?: Omit<StartSidecarOptions, 'sandbox'> & {profile?: WrittenSandboxProfile}): Promise<RunningSidecar>;
  /**
   * WP2 Supabase shim을 이 레인의 격리 호스트로 띄운다: 샌드박스(기본 hostSandbox) · 허용 목록 환경 · 이 실행의 스크래치 ·
   * 증거 `supabase-shim/<label>/`(가린 덤프·보고서). ready를 기다려 돌려준다. 그 shim에 연결할 호스트는 돌려받은
   * `loopbackPorts`를 자기 프로필의 `allowedLoopbackPorts`에 넣는다(ctx.sandboxProfile). 키·OTP는 `credentials()`로만 읽는다.
   * 레인이 `stop()`하지 않으면 레인이 끝날 때 하네스가 멈춘다(사이드카 다음). 깨끗이 끝나지 않았거나(종료 코드 ≠ 0 — 모르는
   * 경로·거절한 origin·내부 오류·증거 실패) 샌드박스 밖이었으면 레인이 무엇을 돌려주든 실패다.
   */
  startSupabaseShim(options?: SupabaseShimLaneOptions): Promise<RunningSupabaseShim>;
  isolatedProfile(label: string): IsolatedProfile;
  allowlistedEnv(input: AllowlistedEnvInput): Record<string, string>;
  /** xcodebuild·simctl용(실제 HOME, 삭제 목록 적용, 샌드박스 밖). */
  toolchainEnv(): Record<string, string>;
  /** 이 실행이 만든 시뮬레이터 UDID(끝난 뒤 지워졌는지 판정한다). */
  ownSimulator(udid: string, runtime?: string): void;
  acquireSimulatorBootLock(timeoutMs: number): Promise<SimulatorLockResult>;
  waitForQuietSimulatorChecks(limitMs: number): Promise<ConcurrencyWait>;
  log(message: string): void;
}

/** ctx.startSupabaseShim의 선택지. 경로·환경·실행 id는 하네스가 채운다. */
export interface SupabaseShimLaneOptions {
  /** 증거 폴더 이름(레인 안에서 고유, `[a-z0-9-]`). 기본 'supabase'. */
  label?: string;
  members?: string[];
  outsiders?: string[];
  /** 기본 0(임시 포트). 포트 없는 https origin이 필요한 레인만 443(못 묶으면 ready.httpsFallback). */
  httpsPort?: number;
  requireHttpsPort?: boolean;
  http?: boolean;
  https?: boolean;
  /** 기본 hostSandbox. LAN inbound 프로필은 받지 않는다. */
  profile?: WrittenSandboxProfile;
  readyTimeoutMs?: number;
}

export interface LaneDefinition {
  id: LaneId;
  title?: string;
  /** 조건부 레인의 전제. 충족되지 않은 사유를 돌려주면 실행하지 않고 막힘으로 기록한다. */
  preconditions?(preflight: PreflightReport): string[];
  run(ctx: LaneContext): Promise<LaneOutcome>;
}

const registry = new Map<LaneId, LaneDefinition>();

export function isLaneId(value: string): value is LaneId {
  return (LANE_IDS as readonly string[]).includes(value);
}

/** 레인을 등록한다(같은 id를 두 번 등록하면 거절). 조건부 레인은 preconditions가 있어야 한다. */
export function registerLane(definition: LaneDefinition): void {
  if (!isLaneId(definition.id)) throw new Error(`unknown lane id ${definition.id}`);
  if (registry.has(definition.id)) throw new Error(`lane ${definition.id} is already registered`);
  if (typeof definition.run !== 'function') throw new Error(`lane ${definition.id} has no run()`);
  if (catalogEntry(definition.id).kind === 'conditional' && typeof definition.preconditions !== 'function') {
    throw new Error(`conditional lane ${definition.id} must declare preconditions()`);
  }
  registry.set(definition.id, definition);
}

/** 테스트용: 등록을 지운다. */
export function unregisterLane(id: LaneId): void {
  registry.delete(id);
}

/**
 * 뒤 패키지가 채우는 지연 로더 표. 모듈은 `export const lane: LaneDefinition`을 내보낸다.
 * 예: `'j1-lan': () => import('./emulator-e2e/lanJourney')`.
 */
export const LANE_MODULES: Partial<Record<LaneId, () => Promise<{lane: LaneDefinition}>>> = {
  'screen-host-selfcheck': () => import('./emulator-e2e/screenFixtureHost'),
  'j3b': () => import('./emulator-e2e/screenControllerLane'),
  'j1-pty': () => import('./emulator-e2e/workroomPty'),
  'j1-lan': () => import('./emulator-e2e/lanJourney'),
  'j1-relay-web': () => import('./emulator-e2e/relayWebJourney'),
  'j4-fixture': () => import('./emulator-e2e/controlProfileFixture'),
  'j3a-process': () => import('./emulator-e2e/computerUseProcessLane'),
  'j2': () => import('./emulator-e2e/screenViewerLane'),
  'j4-web': () => import('./emulator-e2e/communityWebJourney'),
  'j2-boundary': () => import('./emulator-e2e/screenBoundaryLane'),
  'j2-model': () => import('./emulator-e2e/screenViewerModelLane'),
};

export async function resolveLane(id: LaneId): Promise<LaneDefinition | null> {
  const registered = registry.get(id);
  if (registered) return registered;
  const loader = LANE_MODULES[id];
  if (!loader) return null;
  const module = await loader();
  if (!module?.lane || module.lane.id !== id) throw new Error(`lane module for ${id} does not export a matching lane`);
  registerLane(module.lane);
  return module.lane;
}

export function catalogEntry(id: LaneId): LaneCatalogEntry {
  return LANE_CATALOG.find(entry => entry.id === id)!;
}

/** `all`이 도는 레인: opt-in을 뺀 표 순서. */
export function lanesForAll(): LaneId[] {
  return LANE_CATALOG.filter(entry => entry.kind !== 'opt-in').map(entry => entry.id);
}

// ───────────────────────── 실행 ─────────────────────────

export const SUBCOMMANDS = Object.freeze(['preflight', 'all', 'list', ...LANE_IDS]);

export const HARNESS_SOURCE_FILES = Object.freeze([
  'scripts/emulator-e2e.ts',
  'scripts/emulator-e2e/environment.ts',
  'scripts/emulator-e2e/evidence.ts',
  'scripts/emulator-e2e/isolatedSidecar.ts',
  'scripts/emulator-e2e/preflight.ts',
  'scripts/emulator-e2e/sandbox.ts',
  'scripts/emulator-e2e/supabaseShimHost.ts',
  'scripts/emulator-e2e/supabaseShim.ts',
  'scripts/emulator-e2e/fixtureCa.ts',
  'scripts/emulator-e2e/screenFixtureHost.ts',
  'scripts/emulator-e2e/screenControllerLane.ts',
  'scripts/emulator-e2e/computerUseProcessLane.ts',
  'scripts/emulator-e2e/computerUseProcessFixture.ts',
  'scripts/emulator-e2e/workroomPty.ts',
  'scripts/emulator-e2e/portalFixtureBuild.ts',
  'scripts/emulator-e2e/relayWebPhone.ts',
  'scripts/emulator-e2e/relayWebJourney.ts',
  'scripts/emulator-e2e/controlProfileFixture.ts',
  'scripts/emulator-e2e/dialogueKeychainStandIn.ts',
  'scripts/emulator-e2e/dialogue-keychain-entry.ts',
  'scripts/emulator-e2e/lanJourney.ts',
  'scripts/emulator-e2e/screenViewerLane.ts',
  'scripts/emulator-e2e/screenViewerJudge.ts',
  'scripts/emulator-e2e/screenBoundaryLane.ts',
  'scripts/emulator-e2e/screenViewerModelLane.ts',
  'mobile/ios/scripts/check-ui.py',
  'mobile/ios/scripts/lan-journey-host.ts',
  'mobile/ios/UITests/WorkspaceUITests.swift',
  'mobile/ios/UITests/ScreenViewerUITests.swift',
  'mobile/ios/UITests/Fixtures/LoopbackFrameTransport.swift',
  'mobile/ios/UITests/Fixtures/ScreenGestureProbeApp.swift',
  'scripts/emulator-e2e/communityWebJourney.ts',

  'tests/fixtures/side-effect-guard-entry.ts',
]);

function git(args: string[]): string | null {
  const out = Bun.spawnSync(['/usr/bin/git', ...args], {cwd: REPO_ROOT, stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: '/var/empty'}});
  return out.exitCode === 0 ? out.stdout.toString().trim() : null;
}

function log(message: string): void {
  process.stderr.write(`[emulator-e2e] ${message}\n`);
}

/** 레인 하나를 어떻게 다룰지(순수 함수 — 테스트가 같은 판정을 쓴다). */
export type LanePlan =
  | {kind: 'result'; outcome: LaneOutcome}
  /** `all`에서만: 조건부 레인의 조건이 안 됐다. 돌리지 않고, 통과도 아니며, 종료 코드에 들지 않는다. */
  | {kind: 'condition-unmet'; reasons: string[]}
  | {kind: 'run'};

export function planLane(id: LaneId, mode: 'all' | 'single', definition: LaneDefinition | null, preflight: PreflightReport): LanePlan {
  if (!definition) return {kind: 'result', outcome: {status: 'skipped', reason: 'not implemented yet'}};
  if (preflight.status !== 'pass') return {kind: 'result', outcome: {status: 'blocked', reason: `preflight ${preflight.status}: ${preflight.reasons.join('; ')}`}};
  let unmet: string[];
  try { unmet = definition.preconditions?.(preflight) ?? []; }
  catch (error) { return {kind: 'result', outcome: {status: 'fail', reason: `preconditions threw: ${(error as Error)?.message ?? error}`}}; }
  if (unmet.length) {
    if (mode === 'all' && catalogEntry(id).kind === 'conditional') return {kind: 'condition-unmet', reasons: unmet};
    return {kind: 'result', outcome: {status: 'blocked', reason: unmet.join('; ')}};
  }
  return {kind: 'run'};
}

/** A fixture pass covers its own scope only; the human and installed-system steps stay open. */
export function fixtureBoundaryNote(id: LaneId, status: LaneStatus): string | null {
  if (status !== 'pass') return null;
  if (id === 'j3a-process') return 'fixture pass only: installed sidecar admission, signed Control and real OS remain unverified';
  if (id === 'j3b') return 'fixture pass only: human Viewer, biometric approval and physical input remain blocked';
  if (id === 'j2') return 'fixture and simulator pass only: actual ScreenService, panel and physical device remain unverified';
  return null;
}

export interface ConditionUnmet {id: LaneId; title: string; reasons: string[]}

/**
 * 레인 하나의 처리 결과. **분류는 이 태그로만 한다** — 레인이 돌려준 객체의 모양(예: `reasons` 키)으로 가르면 실패한 레인이
 * 「조건 미충족」으로 바뀌어 종료 코드에서 빠졌다(재점검 결함: #6 수정이 만든 것).
 */
export type LaneRun = {kind: 'ran'; result: LaneResult; cleanupFailed?: boolean} | {kind: 'condition-unmet'; unmet: ConditionUnmet};

/** 레인이 ctx로 만든 호스트 자원. 레인이 끝나면 하네스가 정리하고, 하네스가 지킨 규칙의 위반을 돌려받는다. */
export interface LaneScope {
  settle(): Promise<string[]>;
  /** Cleanup uncertainty is distinct from lane violations: the child may still be alive. */
  cleanupUncertain?(): string[];
}

/** 하네스가 지킨 규칙(LAN 바인딩 등)의 위반은 레인의 판정보다 앞선다 — 레인이 통과를 돌려줘도 실패다. */
export function applyHostViolations(outcome: LaneOutcome, violations: readonly string[]): LaneOutcome {
  if (!violations.length) return outcome;
  const laneSaid = outcome.reason ? `lane reported ${outcome.status}: ${outcome.reason}` : `lane reported ${outcome.status}`;
  return {...outcome, status: 'fail', reason: `harness host guard: ${violations.join('; ')} · ${laneSaid}`};
}

/** A lane owns at most one acquisition; no other lane can release or reuse its handle. */
export class LaneSimulatorLock {
  private held: Extract<SimulatorLockResult, {status: 'acquired'}> | null = null;
  private pending: Promise<SimulatorLockResult> | null = null;
  private closed = false;

  constructor(private readonly acquireUnderlying: (timeoutMs: number) => Promise<SimulatorLockResult>) {}

  async acquire(timeoutMs: number): Promise<SimulatorLockResult> {
    if (this.closed) throw new Error('simulator lock scope is closed');
    if (this.held || this.pending) throw new Error('simulator lock acquisition is not reentrant within a lane');
    const pending = this.acquireUnderlying(timeoutMs);
    this.pending = pending;
    try {
      const result = await pending;
      if (result.status === 'acquired') {
        this.held = result;
        if (this.closed) {
          await result.release();
          this.held = null;
          return {status: 'blocked', lockPath: result.lockPath, waitedMs: result.waitedMs, reason: 'lane ended while acquiring simulator lock', holder: null};
        }
      }
      return result;
    } finally {
      this.pending = null;
    }
  }

  async settle(): Promise<void> {
    this.closed = true;
    if (this.pending) await this.pending.catch(() => {});
    if (this.held) {
      await this.held.release();
      this.held = null;
    }
  }
}

export async function runOneLane(id: LaneId, mode: 'all' | 'single', ctx: LaneContext, scope: LaneScope): Promise<LaneRun> {
  const entry = catalogEntry(id);
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  // 레인이 실은 키는 normalizeOutcome이 걸러낸다 — id·제목·분류는 하네스 것이다.
  const done = (outcome: unknown): Extract<LaneRun, {kind: 'ran'}> => ({kind: 'ran', result: {id, title: entry.title, startedAt, durationMs: Math.round(performance.now() - t0), ...normalizeOutcome(outcome)}});
  const laneLock = new LaneSimulatorLock(timeoutMs => ctx.acquireSimulatorBootLock(timeoutMs));
  const laneContext: LaneContext = {...ctx, acquireSimulatorBootLock: timeoutMs => laneLock.acquire(timeoutMs)};
  let result: LaneRun;
  try {
    const definition = await resolveLane(id);
    const plan = planLane(id, mode, definition, ctx.preflight);
    if (plan.kind === 'result') result = done(plan.outcome);
    else if (plan.kind === 'condition-unmet') result = {kind: 'condition-unmet', unmet: {id, title: entry.title, reasons: plan.reasons}};
    else result = done(await definition!.run(laneContext));
  } catch (error) {
    result = done({status: 'fail', reason: `lane threw: ${(error as Error)?.stack ?? error}`.slice(0, 2_000)});
  }
  let violations: string[];
  try { violations = await scope.settle(); }
  catch (error) {
    // Do not give the next lane a lock while this lane's children may still be running. The run-level finally
    // retains the acquired handle and makes one more cleanup attempt before ending the run.
    violations = [`settling the lane's hosts failed: ${(error as Error)?.message ?? error}`];
    const failed = done(applyHostViolations(result.kind === 'ran' ? result.result : {status: 'skipped', reason: result.unmet.reasons.join('; ')}, violations));
    return {...failed, cleanupFailed: true};
  }
  let uncertain: string[];
  try { uncertain = scope.cleanupUncertain?.() ?? []; }
  catch (error) { uncertain = [`child exit check failed: ${(error as Error)?.message ?? error}`]; }
  if (uncertain.length) {
    const failed = done(applyHostViolations(result.kind === 'ran' ? result.result : {status: 'skipped', reason: result.unmet.reasons.join('; ')}, [...violations, ...uncertain]));
    return {...failed, cleanupFailed: true};
  }
  try { await laneLock.settle(); }
  catch (error) {
    violations.push(`releasing the lane's simulator lock failed: ${(error as Error)?.message ?? error}`);
    const failed = done(applyHostViolations(result.kind === 'ran' ? result.result : {status: 'skipped', reason: result.unmet.reasons.join('; ')}, violations));
    return {...failed, cleanupFailed: true};
  }
  if (violations.length) return done(applyHostViolations(result.kind === 'ran' ? result.result : {status: 'skipped', reason: result.unmet.reasons.join('; ')}, violations));
  return result;
}

/** 레인들을 차례로 돈다. 레인마다 `beginLane`이 새 호스트 범위를 연다. */
export async function runLanes(
  ids: readonly LaneId[],
  mode: 'all' | 'single',
  ctx: LaneContext,
  beginLane: (id: LaneId) => LaneScope,
  logLine: (message: string) => void = log,
): Promise<{lanes: LaneResult[]; conditionUnmet: ConditionUnmet[]; cleanupFailed: boolean}> {
  const lanes: LaneResult[] = [];
  const conditionUnmet: ConditionUnmet[] = [];
  let cleanupFailed = false;
  for (const id of ids) {
    logLine(`lane ${id} …`);
    const run = await runOneLane(id, mode, ctx, beginLane(id));
    if (run.kind === 'condition-unmet') {
      conditionUnmet.push(run.unmet);
      logLine(`lane ${id}: condition unmet — not run, not a pass, outside the exit code (${run.unmet.reasons.join('; ')})`);
      continue;
    }
    lanes.push(run.result);
    logLine(`lane ${id}: ${run.result.status}${run.result.reason ? ` — ${run.result.reason.split('\n')[0]}` : ''}`);
    if (run.cleanupFailed) { cleanupFailed = true; logLine('lane cleanup is uncertain; remaining lanes will not run'); break; }
  }
  return {lanes, conditionUnmet, cleanupFailed};
}

export interface LaneHostsInput {
  profileDir: string;
  hostProfileInput: SandboxProfileInput;
  hostSandbox: WrittenSandboxProfile;
  /** preflight가 샌드박스 자식 안에서 잰 en0 사설 IPv4. 없으면 LAN 호스트를 띄우지 않는다. */
  en0PrivateIpv4: string | null;
  log: (message: string) => void;
  guardIntervalMs?: number;
}

/**
 * 레인 하나가 ctx로 만든 호스트 자원(LAN 바인딩 가드·사이드카). 레인마다 새로 만들고 레인이 끝나면 settle로 판정·정리한다.
 * LAN 호스트는 en0 주소에만 바인딩해야 하는데 SBPL은 주소를 좁히지 못한다(`host must be * or localhost`). 그래서 LAN
 * 포트를 여는 프로필을 만드는 순간 그 포트의 가드를 켜고(가드 없이는 sandboxedArgv가 띄우지 않는다), 가드가 en0 밖
 * 리스너를 보면 그 리스너와 그 포트의 사이드카를 멈춘다. 위반은 레인의 판정을 실패로 바꾼다(검토 #9).
 */
export class LaneHosts implements LaneScope {
  readonly #input: LaneHostsInput;
  readonly #guards = new Map<number, LanBindingGuard>();
  readonly #sidecars: RunningSidecar[] = [];
  readonly #shims: RunningSupabaseShim[] = [];

  constructor(input: LaneHostsInput) {
    this.#input = input;
  }

  /** 그 포트의 LAN 바인딩 가드(이 레인에서 처음이면 켠다). en0 주소가 없으면 던진다. */
  lanGuard(port: number): LanBindingGuard {
    const existing = this.#guards.get(port);
    if (existing?.active) return existing;
    const address = this.#input.en0PrivateIpv4;
    if (!address) {
      throw new Error(`LAN inbound port ${port} needs the measured en0 private IPv4 address (preflight capabilities.en0PrivateIpv4 is empty) — the harness cannot hold a LAN host to en0`);
    }
    const guard = startLanBindingGuard({
      port,
      expectedAddress: address,
      ...(this.#input.guardIntervalMs ? {intervalMs: this.#input.guardIntervalMs} : {}),
      onViolation: lines => this.#stopLanHosts(port, lines),
    });
    this.#guards.set(port, guard);
    return guard;
  }

  sandboxProfile(name: string, extra: Partial<Pick<SandboxProfileInput, 'lanInbound' | 'extraDeniedPorts' | 'allowedLoopbackPorts'>> = {}): WrittenSandboxProfile {
    const profile = writeSandboxProfile(this.#input.profileDir, name, {...this.#input.hostProfileInput, ...extra});
    // 선언한 포트마다 가드를 켠다 — sandboxedArgv는 프로필이 여는 LAN 포트 하나라도 가드가 없으면 띄우지 않는다.
    if (profile.lanInbound) for (const port of lanInboundPorts(profile.lanInbound)) this.lanGuard(port);
    return profile;
  }

  async startSidecar(root: IsolatedRoot, kind: 'source' | 'installed', options: Omit<StartSidecarOptions, 'sandbox'> & {profile?: WrittenSandboxProfile} = {}): Promise<RunningSidecar> {
    const {profile, ...rest} = options;
    const sandbox = profile ?? this.#input.hostSandbox;
    const guard = sandbox.lanInbound ? this.lanGuard(sandbox.lanInbound.port) : null;
    const before = guard?.violations.length ?? 0;
    const sidecar = await startSidecar(root, kind, {...rest, sandbox});
    this.#sidecars.push(sidecar);
    // startSidecar의 마지막 확인 뒤, 여기 등록하기 전 사이에 가드가 본 위반도 놓치지 않는다.
    if (guard && guard.violations.length > before) this.#stopLanHosts(guard.port, guard.violations.slice(before));
    return sidecar;
  }

  /** 이 레인의 Supabase shim(격리 호스트). settle이 멈추고 판정한다. */
  async startSupabaseShim(options: SupabaseShimHostOptions): Promise<RunningSupabaseShim> {
    const shim = await startSupabaseShimHost({log: this.#input.log, ...options});
    this.#shims.push(shim);
    return shim;
  }

  #stopLanHosts(port: number, lines: readonly string[]): void {
    const hosts = this.#sidecars.filter(sidecar => sidecar.lanBinding?.port === port && sidecar.child.exitCode === null);
    this.#input.log(`LAN binding guard (port ${port}): ${lines.join('; ')}${hosts.length ? ` — stopping LAN host pid ${hosts.map(host => host.pid).join(', ')}` : ''}`);
    for (const host of hosts) { try { host.child.kill('SIGKILL'); } catch {} }
  }

  /**
   * 마지막으로 한 번 보고, 남은 사이드카를 멈추고, 남은 shim을 멈추고(사이드카가 shim을 부르고 있을 수 있어 그 다음), 가드를
   * 끈다. 위반 목록을 돌려준다(여러 번 불러도 된다 — shim의 stop도 같은 결과를 돌려준다).
   */
  async settle(): Promise<string[]> {
    for (const guard of this.#guards.values()) if (guard.active) await guard.check();
    for (const sidecar of this.#sidecars) {
      if (sidecar.child.exitCode === null && sidecar.child.signalCode === null) this.#input.log(`lane left sidecar pid ${sidecar.pid} running — stopping it`);
      await sidecar.stop();
    }
    for (const shim of this.#shims) {
      if (!shim.result()) this.#input.log(`lane left supabase shim ${shim.label} (pid ${shim.pid}) running — stopping it`);
      await shim.stop();
    }
    for (const guard of this.#guards.values()) await guard.stop();
    return [
      ...[...this.#guards.values()].flatMap(guard => guard.violations.map(line => `LAN binding guard port ${guard.port} (only ${guard.expectedAddress}): ${line}`)),
      ...this.#shims.flatMap(shim => shim.problems().map(line => `supabase shim ${shim.label}: ${line}`)),
    ];
  }

  /** Child termination, unlike a dirty exit or a guard violation, must be known before releasing the lock. */
  cleanupUncertain(): string[] {
    return ownedChildExitUncertainty([
      ...this.#sidecars.map(sidecar => ({label: `sidecar ${sidecar.pid}`, child: sidecar.child})),
      ...this.#shims.map(shim => ({label: `supabase shim ${shim.label} (${shim.pid})`, child: shim.child})),
    ]);
  }

  async waitForOwnedChildrenExit(): Promise<void> {
    const children = [...this.#sidecars.map(sidecar => sidecar.child), ...this.#shims.map(shim => shim.child)];
    await Promise.all(children.map(child => child.exited));
  }
}

/** Inspect only explicitly owned child handles, never pids or other runs' lock records. */
export function ownedChildExitUncertainty(children: readonly {label: string; child: Pick<Bun.Subprocess, 'exitCode' | 'signalCode'>}[]): string[] {
  return children.flatMap(({label, child}) => child.exitCode === null && child.signalCode === null ? [`${label}: exit not confirmed`] : []);
}

/** Keep the run's lock while an owned child might still be active, even when cleanup returned normally. */
export async function waitForLaneChildrenBeforeUnlock(hosts: Pick<LaneHosts, 'settle' | 'cleanupUncertain' | 'waitForOwnedChildrenExit'> | null, logLine: (message: string) => void): Promise<void> {
  if (!hosts) return;
  try { await hosts.settle(); }
  catch (error) { logLine(`lane cleanup retry failed: ${(error as Error)?.message ?? error}`); }
  let uncertain: string[];
  try { uncertain = hosts.cleanupUncertain(); }
  catch (error) { uncertain = [`child exit check failed: ${(error as Error)?.message ?? error}`]; }
  if (!uncertain.length) return;
  logLine(`simulator lock retained until owned children exit: ${uncertain.join('; ')}`);
  try { await hosts.waitForOwnedChildrenExit(); }
  catch (error) { logLine(`child exit could not be confirmed: ${(error as Error)?.message ?? error}`); await new Promise<never>(() => {}); }
  try { uncertain = hosts.cleanupUncertain(); }
  catch (error) { uncertain = [`child exit check failed: ${(error as Error)?.message ?? error}`]; }
  if (uncertain.length) {
    logLine(`simulator lock retained: ${uncertain.join('; ')}`);
    await new Promise<never>(() => {});
  }
}

/**
 * 실행 전체의 판정 항목: preflight + 돈 레인(+ 스냅샷 위반은 실패). `all`인데 돈 레인이 하나도 없으면 건너뜀을 더한다
 * (preflight 통과만으로 `all`이 통과하지 않게). 조건 미충족 레인은 여기에 들지 않는다.
 */
export function runEntries(command: string, preflightStatus: LaneStatus, lanes: ReadonlyArray<{status: LaneStatus}>, snapshotVerdict: SnapshotComparison['verdict']): Array<{status: LaneStatus}> {
  const entries: Array<{status: LaneStatus}> = [{status: preflightStatus}, ...lanes];
  if (snapshotVerdict === 'violated') entries.push({status: 'fail'});
  if (command === 'all' && lanes.length === 0) entries.push({status: 'skipped'});
  return entries;
}

export interface RunResult {exitCode: number; evidenceDir: string; index: EvidenceIndex}

export async function runHarness(subcommand: 'preflight' | 'all' | LaneId, options: {keepScratch?: boolean; repoRoot?: string} = {}): Promise<RunResult> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const home = realHome();
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const evidence = createEvidenceRun(repoRoot, runId);
  // <run>/work만 호스트가 쓸 수 있다. 프로필은 <run>/sandbox(쓰기 허용 루트 밖)에 둔다(검토 #4).
  const runBase = createRunScratch(runId);
  const scratchRoot = join(runBase, 'work');
  const profileDir = join(runBase, 'sandbox');
  mkdirSync(scratchRoot, {recursive: true, mode: 0o700});
  mkdirSync(profileDir, {recursive: true, mode: 0o700});
  // 하네스가 도는 동안 비샌드박스 성능 측정 모드를 거절한다(검토 #5).
  const releaseHarness = markHarnessActive();
  log(`run ${runId} · scratch ${scratchRoot} · profiles ${profileDir} · evidence ${evidence.dir}`);
  const owned: Array<{udid: string; runtime?: string}> = [];
  const lock: {release: (() => Promise<void>) | null} = {release: null};
  // 지금 도는 레인의 호스트 자원(LAN 가드·사이드카). 레인마다 새로 연다(runLanes의 beginLane).
  const laneHosts: {current: LaneHosts | null} = {current: null};
  try {
    const preflight = await runPreflight({runId, repoRoot, scratchRoot, profileDir, evidenceDir: evidence.dir, home});
    evidence.writeText('sandbox/host.sb', await Bun.file(preflight.hostProfile.path).text());
    log(`preflight ${preflight.status}${preflight.reasons.length ? `: ${preflight.reasons.join('; ')}` : ''}`);
    const before = preflight.simulators ?? takeSimulatorSnapshot();
    const hostSandbox = writeSandboxProfile(profileDir, 'host-lanes', preflight.hostProfileInput);
    const openLaneHosts = (): LaneHosts => {
      laneHosts.current = new LaneHosts({profileDir, hostProfileInput: preflight.hostProfileInput, hostSandbox, en0PrivateIpv4: preflight.capabilities?.en0PrivateIpv4 ?? null, log});
      return laneHosts.current;
    };
    const currentHosts = (): LaneHosts => laneHosts.current ?? openLaneHosts();
    const ctx: LaneContext = {
      runId, repoRoot, scratchRoot, profileDir, home, evidence, preflight, hostSandbox,
      sandboxProfile: (name, extra = {}) => currentHosts().sandboxProfile(name, extra),
      startSidecar: (root, kind, sidecarOptions = {}) => currentHosts().startSidecar(root, kind, sidecarOptions),
      startSupabaseShim: (shimOptions = {}) => {
        const {label = 'supabase', profile, ...rest} = shimOptions;
        const isolated = createIsolatedProfile(scratchRoot, `supabase-shim-${label}`);
        return currentHosts().startSupabaseShim({
          ...rest,
          repoRoot,
          runId,
          label,
          profile: profile ?? hostSandbox,
          env: buildAllowlistedEnv({home, profile: isolated}),
          scratchDir: join(isolated.root, 'shim'),
          evidenceDir: evidence.path(join('supabase-shim', label)),
          track: trackChild,
        });
      },
      isolatedProfile: label => createIsolatedProfile(scratchRoot, label),
      allowlistedEnv: input => buildAllowlistedEnv({home, ...input}),
      toolchainEnv: () => buildToolchainEnv({home}),
      ownSimulator: (udid, runtime) => { if (!owned.some(entry => entry.udid === udid)) owned.push({udid, runtime}); },
      acquireSimulatorBootLock: async timeoutMs => {
        const result = await acquireSimulatorBootLock({runId, timeoutMs});
        if (result.status === 'acquired') {
          lock.release = result.release;
          try { evidence.appendJsonl('simulator-lock.jsonl', {acquiredAfterMs: result.waitedMs, loadavg: result.loadavgAtAcquire, cpuCount: result.cpuCount}); }
          catch (error) { await result.release(); lock.release = null; throw error; }
          return {...result, release: async () => {
            await result.release();
            if (lock.release === result.release) lock.release = null;
          }};
        }
        return result;
      },
      waitForQuietSimulatorChecks: limitMs => waitForQuietSimulatorChecks({limitMs}),
      log,
    };
    const mode: 'all' | 'single' = subcommand === 'all' ? 'all' : 'single';
    const ids: LaneId[] = subcommand === 'preflight' ? [] : subcommand === 'all' ? lanesForAll() : [subcommand];
    const {lanes, conditionUnmet, cleanupFailed} = await runLanes(ids, mode, ctx, () => openLaneHosts());
    if (cleanupFailed) await waitForLaneChildrenBeforeUnlock(laneHosts.current, log);
    await lock.release?.();
    lock.release = null;
    const after = takeSimulatorSnapshot();
    const comparison: SnapshotComparison = compareSimulatorSnapshots(before, after, owned.map(entry => entry.udid));
    const summary = summarize(runEntries(subcommand, preflight.status, lanes, comparison.verdict));
    const digest = sourceDigest(repoRoot, HARNESS_SOURCE_FILES);
    const gitDirty = git(['status', '--porcelain']);
    const index: EvidenceIndex = {
      schemaVersion: 1,
      kind: 'agentstoz-emulator-e2e',
      runId,
      command: subcommand,
      startedAt,
      finishedAt: new Date().toISOString(),
      gitHead: git(['rev-parse', 'HEAD']) ?? 'unknown',
      gitDirty: gitDirty === null ? null : gitDirty.length > 0,
      harnessSource: digest,
      environment: {allowlistKeys: preflight.environment.allowlistKeys, toolchainKeys: preflight.environment.toolchainKeys, violations: [...preflight.environment.violations, ...preflight.environment.childViolations]},
      sandbox: {
        hostProfileSha256: preflight.hostProfile.sha256,
        hostProfileFile: 'sandbox/host.sb',
        deniedPorts: preflight.hostProfile.deniedPorts,
        allowedLoopbackPorts: preflight.hostProfile.allowedLoopbackPorts,
        canaries: preflight.canaries,
      },
      capabilities: preflight.capabilities,
      simulators: {
        owned,
        before: before ? {available: before.available, deviceCount: before.devices.length, simulatorAppPids: before.simulatorAppPids} : null,
        after: {available: after.available, deviceCount: after.devices.length, simulatorAppPids: after.simulatorAppPids},
        comparison,
      },
      concurrency: {busyAtPreflight: preflight.concurrency.busy, simulatorLock: preflight.simulatorLock, load: preflight.load},
      preflight: {status: preflight.status, reasons: preflight.reasons},
      lanes,
      conditionUnmet,
      summary,
    };
    evidence.writeJson('preflight.json', preflight);
    const indexPath = writeIndex(evidence, index);
    log(`summary: ${summary.overall} (pass ${summary.pass} · fail ${summary.fail} · blocked ${summary.blocked} · skipped ${summary.skipped}${conditionUnmet.length ? ` · condition unmet ${conditionUnmet.length}, not counted` : ''})`);
    if (conditionUnmet.length) log('coverage incomplete: condition-unmet lanes are not passes');
    for (const result of lanes) { const note = fixtureBoundaryNote(result.id as LaneId, result.status); if (note) log(`${result.id}: ${note}`); }
    log(`evidence: ${indexPath}`);
    return {exitCode: summary.exitCode, evidenceDir: evidence.dir, index};
  } finally {
    // 예외로 빠져나와도 LAN 가드·사이드카를 남기지 않는다(settle은 여러 번 불러도 된다).
    await waitForLaneChildrenBeforeUnlock(laneHosts.current, log);
    await lock.release?.();
    releaseHarness();
    if (options.keepScratch) {
      try { cpSync(profileDir, join(evidence.dir, 'sandbox', 'generated'), {recursive: true}); } catch {}
      log(`scratch kept: ${runBase}`);
    } else {
      rmSync(runBase, {recursive: true, force: true});
    }
  }
}

function printList(): void {
  for (const entry of LANE_CATALOG) {
    const state = registry.has(entry.id) || LANE_MODULES[entry.id] ? 'registered' : 'not implemented yet';
    process.stdout.write(`${entry.id.padEnd(22)} ${entry.kind.padEnd(12)} ${entry.workPackage.padEnd(5)} ${state.padEnd(20)} ${entry.title}\n`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.filter(arg => !arg.startsWith('--'));
  const flags = new Set(argv.filter(arg => arg.startsWith('--')));
  const unknownFlags = [...flags].filter(flag => flag !== '--keep-scratch' && flag !== '--help');
  const command = args[0];
  if (flags.has('--help') || !command || args.length > 1 || unknownFlags.length || !(SUBCOMMANDS as readonly string[]).includes(command)) {
    process.stderr.write(`usage: bun scripts/emulator-e2e.ts <${SUBCOMMANDS.join(' | ')}> [--keep-scratch]\n`);
    if (unknownFlags.length) process.stderr.write(`unknown flag(s): ${unknownFlags.join(', ')}\n`);
    return command === undefined && flags.has('--help') ? 0 : USAGE_EXIT_CODE;
  }
  if (command === 'list') { printList(); return 0; }
  const result = await runHarness(command as 'preflight' | 'all' | LaneId, {keepScratch: flags.has('--keep-scratch')});
  return result.exitCode;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
