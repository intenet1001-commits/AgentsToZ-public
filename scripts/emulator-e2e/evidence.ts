/**
 * 에뮬레이터 종단 시험의 증거와 레인 상태(설계 §1·§6).
 *
 * 레인 상태는 넷이다: pass / fail / blocked(사유) / skipped. **막힘과 건너뜀은 통과가 아니다** — 집계와 종료 코드가
 * 둘을 pass와 구별한다. 증거는 `<worktree>/mobile/ios/build/emulator-evidence/<runId>/`(gitignore)에 umask 077로
 * 남기고 업로드하지 않는다. index.json에는 값 없이 키 이름만, 토큰 없이 판정만 넣는다.
 */
import {createHash, randomBytes} from 'node:crypto';
import {appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';

export const LANE_STATUSES = Object.freeze(['pass', 'fail', 'blocked', 'skipped'] as const);
export type LaneStatus = typeof LANE_STATUSES[number];

/** 종료 코드: 통과 0, 실패 1, 사용법 2, 막힘 3, 건너뜀 4. 막힘·건너뜀은 0이 될 수 없다. */
export const LANE_EXIT_CODES: Readonly<Record<LaneStatus, number>> = Object.freeze({pass: 0, fail: 1, blocked: 3, skipped: 4});
export const USAGE_EXIT_CODE = 2;

/** 여정마다 「실제 경로」와 「대역」을 증거에 남긴다(설계 §1). */
export interface PathLabels {
  real: string[];
  standIn: string[];
}

export interface LaneOutcome {
  status: LaneStatus;
  /** fail·blocked·skipped에는 사유가 반드시 있다. */
  reason?: string;
  labels?: PathLabels;
  artifacts?: string[];
  details?: Record<string, unknown>;
}

export interface LaneResult extends LaneOutcome {
  id: string;
  title: string;
  startedAt: string;
  durationMs: number;
}

export function isLaneStatus(value: unknown): value is LaneStatus {
  return typeof value === 'string' && (LANE_STATUSES as readonly string[]).includes(value);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string');

/**
 * 레인이 돌려준 값을 검사한다. 사유 없는 막힘·건너뜀·실패는 실패로 바꾼다(조용한 통과를 막는다).
 * **LaneOutcome의 키만 남긴다** — 레인이 실은 다른 키(`reasons`·`id`·`title`·`kind` …)가 하네스의 분류(조건 미충족)나
 * 결과의 id·제목을 바꾸지 못하게 한다. 모양이 틀린 선택 키는 버린다.
 */
export function normalizeOutcome(value: unknown): LaneOutcome {
  if (!isPlainObject(value) || !isLaneStatus(value.status)) return {status: 'fail', reason: 'lane returned no valid status'};
  const status = value.status;
  const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason : undefined;
  const labels = isPlainObject(value.labels) && isStringArray(value.labels.real) && isStringArray(value.labels.standIn)
    ? {real: [...value.labels.real], standIn: [...value.labels.standIn]} : undefined;
  const artifacts = isStringArray(value.artifacts) ? [...value.artifacts] : undefined;
  const details = isPlainObject(value.details) ? value.details : undefined;
  const optional = {...(labels ? {labels} : {}), ...(artifacts ? {artifacts} : {}), ...(details ? {details} : {})};
  if (status !== 'pass' && !reason) return {status: 'fail', reason: `lane reported ${status} without a reason`, ...optional};
  return {status, ...(reason ? {reason} : {}), ...optional};
}

const SEVERITY: Readonly<Record<LaneStatus, number>> = {pass: 0, skipped: 1, blocked: 2, fail: 3};

export interface RunSummary {
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  skipped: number;
  /** 하나라도 실패면 fail, 아니면 막힘, 아니면 건너뜀. 전부 통과일 때만 pass. 레인이 없으면 skipped. */
  overall: LaneStatus;
  exitCode: number;
  passed: boolean;
}

export function summarize(results: ReadonlyArray<{status: LaneStatus}>): RunSummary {
  const counts = {pass: 0, fail: 0, blocked: 0, skipped: 0};
  for (const result of results) counts[result.status] += 1;
  let overall: LaneStatus = results.length ? 'pass' : 'skipped';
  for (const result of results) if (SEVERITY[result.status] > SEVERITY[overall]) overall = result.status;
  return {total: results.length, ...counts, overall, exitCode: LANE_EXIT_CODES[overall], passed: overall === 'pass'};
}

// ───────────────────────── 증거 폴더 ─────────────────────────

export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export function evidenceRoot(repoRoot: string): string {
  return join(repoRoot, 'mobile', 'ios', 'build', 'emulator-evidence');
}

export interface EvidenceRun {
  runId: string;
  dir: string;
  repoRoot: string;
  path(name: string): string;
  writeJson(name: string, value: unknown): string;
  writeText(name: string, value: string): string;
  appendJsonl(name: string, value: unknown): string;
  /** 증거 폴더 기준 상대 경로(index.json에 절대 경로 대신 넣는다). */
  relative(path: string): string;
}

function safeName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\/-]*$/.test(name) || name.includes('..')) throw new Error(`unsafe evidence name: ${name}`);
  return name;
}

export function createEvidenceRun(repoRoot: string, runId: string = newRunId()): EvidenceRun {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(runId)) throw new Error(`invalid run id ${runId}`);
  const root = evidenceRoot(repoRoot);
  mkdirSync(root, {recursive: true, mode: 0o700});
  const dir = join(root, runId);
  if (existsSync(dir)) throw new Error(`evidence folder for ${runId} already exists`);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  chmodSync(dir, 0o700);
  const realDir = realpathSync(dir);
  const ensureParent = (path: string) => {
    const parent = join(path, '..');
    if (!existsSync(parent)) mkdirSync(parent, {recursive: true, mode: 0o700});
  };
  const run: EvidenceRun = {
    runId,
    dir: realDir,
    repoRoot,
    path: name => join(realDir, safeName(name)),
    writeJson(name, value) {
      const path = run.path(name);
      ensureParent(path);
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
      return path;
    },
    writeText(name, value) {
      const path = run.path(name);
      ensureParent(path);
      writeFileSync(path, value, {mode: 0o600});
      return path;
    },
    appendJsonl(name, value) {
      const path = run.path(name);
      ensureParent(path);
      appendFileSync(path, `${JSON.stringify(value)}\n`, {mode: 0o600});
      return path;
    },
    relative: path => relative(realDir, path),
  };
  return run;
}

// ───────────────────────── 소스 해시 ─────────────────────────

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 하네스 소스의 SHA-256(파일별 + 합계). 없는 파일은 null로 남긴다. */
export function sourceDigest(repoRoot: string, files: readonly string[]): {files: Record<string, string | null>; combined: string} {
  const out: Record<string, string | null> = {};
  const combined = createHash('sha256');
  for (const file of [...files].sort()) {
    const path = join(repoRoot, file);
    const digest = existsSync(path) ? sha256File(path) : null;
    out[file] = digest;
    combined.update(`${file}\0${digest ?? 'missing'}\n`);
  }
  return {files: out, combined: combined.digest('hex')};
}

// ───────────────────────── 누수 검사 ─────────────────────────

/**
 * `#pair=` 토큰이 호스트 로그·stdout·index·summary에 남았는지 본다(설계 §6). xcresult는 범위 밖이다 —
 * XCUITest가 입력한 URL이 활동 로그에 남으므로 그쪽에는 「소비된 픽스처 토큰」 표시를 단다.
 */
export function findPairTokenLeaks(texts: ReadonlyArray<{name: string; text: string}>): string[] {
  const pattern = /#pair=[A-Za-z0-9_-]{8,}/;
  return texts.filter(entry => pattern.test(entry.text)).map(entry => entry.name);
}

// ───────────────────────── index.json ─────────────────────────

export interface EvidenceIndex {
  schemaVersion: 1;
  kind: 'agentstoz-emulator-e2e';
  runId: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  gitHead: string;
  gitDirty: boolean | null;
  harnessSource: {files: Record<string, string | null>; combined: string};
  environment: {allowlistKeys: string[]; toolchainKeys: string[]; violations: string[]};
  sandbox: unknown;
  capabilities: unknown;
  simulators: unknown;
  concurrency: unknown;
  preflight: {status: LaneStatus; reasons: string[]};
  lanes: LaneResult[];
  /** `all`에서 조건이 안 돼 돌리지 않은 조건부 레인. 통과가 아니고 summary·종료 코드에 들지 않는다(설계 §8). */
  conditionUnmet: Array<{id: string; title: string; reasons: string[]}>;
  summary: RunSummary;
}

export function writeIndex(run: EvidenceRun, index: EvidenceIndex): string {
  const text = JSON.stringify(index, null, 2);
  const leaks = findPairTokenLeaks([{name: 'index.json', text}]);
  if (leaks.length) throw new Error('index.json would contain a #pair= token');
  return run.writeText('index.json', `${text}\n`);
}
