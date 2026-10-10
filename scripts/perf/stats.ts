/**
 * 성능 기준선의 통계·비교·스키마 — 시간을 재지 않는 순수 함수만 둔다.
 *
 * `tests/perf-baseline.test.ts`가 이 파일만 검사한다. 측정값 자체를 테스트 단언으로 쓰면
 * 기기·부하에 따라 흔들리는 테스트가 되므로, 테스트는 「같은 입력이면 같은 판정」만 본다.
 */

export const PERF_BASELINE_SCHEMA_VERSION = 1 as const;

export type PerfUnit = 'ms' | 'count';

export interface PerfSummary {
  min: number;
  median: number;
  p90: number;
}

export interface PerfMeasurement extends PerfSummary {
  unit: PerfUnit;
  samples: number[];
  method: string;
  /** true만 비교에서 회귀 판정을 받는다. 실기(2호/3호·실제 CLI)처럼 남이 바꾸는 것은 false. */
  reproducible: boolean;
  notes: string;
  /** 이 측정을 시작·끝낼 때의 1분 load average — 숫자가 시끄러웠는지 판단하는 근거. */
  loadavg?: { start: number[]; end: number[] };
  /** 이보다 작은 절대 증가는 회귀로 보지 않는다(단위는 `unit`). 없으면 단위 기본값. */
  regressionFloor?: number;
}

export interface PerfEnvironment {
  machineModel: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryGiB: number;
  os: string;
  bunVersion: string;
  gitHead: string;
  gitDirty: boolean;
  loadavgStart: number[];
  loadavgEnd: number[];
}

export interface PerfBaseline {
  schemaVersion: typeof PERF_BASELINE_SCHEMA_VERSION;
  measuredAt: string;
  environment: PerfEnvironment;
  measurements: Record<string, PerfMeasurement>;
}

/** Nearest-rank 백분위수(표본이 적을 때 보간보다 해석이 쉽다). 빈 배열은 던진다. */
export function percentile(values: readonly number[], ratio: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) throw new Error('percentile of no finite samples');
  if (!(ratio >= 0 && ratio <= 1)) throw new Error('ratio must be within [0,1]');
  if (ratio === 0) return sorted[0]!;
  return sorted[Math.min(sorted.length, Math.ceil(sorted.length * ratio)) - 1]!;
}

/** 짝수 개면 가운데 둘의 평균. 반올림은 소수 셋째 자리까지(파일이 쓸데없이 길어지지 않게). */
export function median(values: readonly number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) throw new Error('median of no finite samples');
  const mid = sorted.length >> 1;
  return round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summarize(samples: readonly number[]): PerfSummary {
  return {
    min: round(percentile(samples, 0)),
    median: median(samples),
    p90: round(percentile(samples, 0.9)),
  };
}

export function measurement(input: {
  unit: PerfUnit;
  samples: readonly number[];
  method: string;
  reproducible: boolean;
  notes?: string;
  loadavg?: { start: number[]; end: number[] };
  regressionFloor?: number;
}): PerfMeasurement {
  const samples = input.samples.map(value => round(value));
  return {
    unit: input.unit,
    samples,
    ...summarize(samples),
    method: input.method,
    reproducible: input.reproducible,
    notes: input.notes ?? '',
    ...(input.loadavg ? { loadavg: input.loadavg } : {}),
    ...(input.regressionFloor === undefined ? {} : { regressionFloor: input.regressionFloor }),
  };
}

// ───────────────────────── 비교 ─────────────────────────

/**
 * 회귀 판정은 두 조건을 **모두** 만족할 때만이다:
 *   현재 중앙값 > 기준 중앙값 × ratio   그리고   현재 − 기준 > floor
 * 비율만 보면 2ms → 4ms 같은 잡음이 「두 배 느려짐」이 되고, 절대값만 보면 큰 측정의 실제
 * 회귀를 놓친다. 중앙값만 쓰는 이유도 같다 — p90은 표본 5개에서 사실상 최댓값이다.
 */
export const DEFAULT_REGRESSION_RATIO = 1.5;
export const DEFAULT_REGRESSION_FLOOR: Record<PerfUnit, number> = { ms: 50, count: 2 };

export type PerfVerdict = 'ok' | 'improved' | 'regressed' | 'informational' | 'missing' | 'new' | 'unit-changed';

export interface PerfComparisonRow {
  id: string;
  verdict: PerfVerdict;
  unit: PerfUnit | null;
  baselineMedian: number | null;
  currentMedian: number | null;
  ratio: number | null;
  delta: number | null;
  floor: number | null;
}

export interface PerfComparison {
  rows: PerfComparisonRow[];
  regressed: string[];
  ratioThreshold: number;
}

export function compareBaselines(
  baseline: Pick<PerfBaseline, 'measurements'>,
  current: Pick<PerfBaseline, 'measurements'>,
  options: { ratio?: number; floors?: Partial<Record<PerfUnit, number>> } = {},
): PerfComparison {
  const ratioThreshold = options.ratio ?? DEFAULT_REGRESSION_RATIO;
  if (!(ratioThreshold > 1)) throw new Error('regression ratio must be > 1');
  const rows: PerfComparisonRow[] = [];
  const ids = [...new Set([...Object.keys(baseline.measurements), ...Object.keys(current.measurements)])].sort();
  for (const id of ids) {
    const before = baseline.measurements[id];
    const after = current.measurements[id];
    if (!before || !after) {
      rows.push({
        id, verdict: before ? 'missing' : 'new', unit: (after ?? before)!.unit,
        baselineMedian: before?.median ?? null, currentMedian: after?.median ?? null,
        ratio: null, delta: null, floor: null,
      });
      continue;
    }
    if (before.unit !== after.unit) {
      rows.push({ id, verdict: 'unit-changed', unit: after.unit, baselineMedian: before.median, currentMedian: after.median, ratio: null, delta: null, floor: null });
      continue;
    }
    const floor = after.regressionFloor ?? before.regressionFloor
      ?? options.floors?.[after.unit] ?? DEFAULT_REGRESSION_FLOOR[after.unit];
    const delta = round(after.median - before.median);
    const ratio = before.median > 0 ? round(after.median / before.median) : (after.median > 0 ? Infinity : 1);
    let verdict: PerfVerdict;
    // 실기·외부 CLI는 우리가 바꾸지 않아도 흔들린다. 보여 주기만 하고 실패시키지 않는다.
    if (!before.reproducible || !after.reproducible) verdict = 'informational';
    else if (ratio > ratioThreshold && delta > floor) verdict = 'regressed';
    else if (before.median > 0 && after.median * ratioThreshold < before.median && -delta > floor) verdict = 'improved';
    else verdict = 'ok';
    rows.push({ id, verdict, unit: after.unit, baselineMedian: before.median, currentMedian: after.median, ratio, delta, floor });
  }
  return { rows, regressed: rows.filter(row => row.verdict === 'regressed').map(row => row.id), ratioThreshold };
}

export function formatComparison(comparison: PerfComparison): string {
  const lines = [`기준 대비 (회귀 = 중앙값 > 기준×${comparison.ratioThreshold} 이고 증가분 > floor)`];
  const pad = (value: string, width: number) => value.padEnd(width);
  for (const row of comparison.rows) {
    const fmt = (value: number | null) => value === null ? '—' : String(value);
    lines.push([
      pad(row.verdict.toUpperCase(), 14),
      pad(row.id, 44),
      `기준 ${fmt(row.baselineMedian)} → 현재 ${fmt(row.currentMedian)} ${row.unit ?? ''}`,
      row.ratio === null ? '' : `(×${row.ratio}, ${row.delta! >= 0 ? '+' : ''}${row.delta}, floor ${row.floor})`,
    ].join(' '));
  }
  lines.push(comparison.regressed.length ? `회귀: ${comparison.regressed.join(', ')}` : '회귀 없음');
  return lines.join('\n');
}

// ───────────────────────── 스키마 ─────────────────────────

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item));

/** 기준선 파일이 비교에 쓸 수 있는 모양인지. 문제를 모두 모아 돌려준다(첫 문제에서 멈추지 않는다). */
export function validateBaseline(doc: unknown): string[] {
  const problems: string[] = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['root must be an object'];
  const root = doc as Record<string, unknown>;
  if (root.schemaVersion !== PERF_BASELINE_SCHEMA_VERSION) problems.push(`schemaVersion must be ${PERF_BASELINE_SCHEMA_VERSION}`);
  if (typeof root.measuredAt !== 'string' || Number.isNaN(Date.parse(root.measuredAt))) problems.push('measuredAt must be an ISO date');
  const env = root.environment as Record<string, unknown> | undefined;
  if (!env || typeof env !== 'object') problems.push('environment must be an object');
  else {
    for (const key of ['machineModel', 'cpuModel', 'os', 'bunVersion', 'gitHead'] as const) {
      if (typeof env[key] !== 'string' || !env[key]) problems.push(`environment.${key} must be a non-empty string`);
    }
    if (typeof env.cpuCount !== 'number' || env.cpuCount < 1) problems.push('environment.cpuCount must be a positive number');
    if (typeof env.gitDirty !== 'boolean') problems.push('environment.gitDirty must be boolean');
    if (!isNumberArray(env.loadavgStart) || !isNumberArray(env.loadavgEnd)) problems.push('environment.loadavgStart/End must be number arrays');
  }
  const measurements = root.measurements as Record<string, unknown> | undefined;
  if (!measurements || typeof measurements !== 'object' || Array.isArray(measurements)) {
    problems.push('measurements must be an object');
    return problems;
  }
  if (!Object.keys(measurements).length) problems.push('measurements must not be empty');
  for (const [id, raw] of Object.entries(measurements)) {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) problems.push(`${id}: id must be lowercase dotted`);
    const m = raw as Record<string, unknown>;
    if (!m || typeof m !== 'object') { problems.push(`${id}: must be an object`); continue; }
    if (m.unit !== 'ms' && m.unit !== 'count') problems.push(`${id}: unit must be ms|count`);
    if (!isNumberArray(m.samples) || !m.samples.length) { problems.push(`${id}: samples must be a non-empty number array`); continue; }
    for (const key of ['min', 'median', 'p90'] as const) {
      if (typeof m[key] !== 'number' || !Number.isFinite(m[key])) problems.push(`${id}: ${key} must be a finite number`);
    }
    // 요약이 표본에서 다시 계산되는지 — 손으로 고친 기준선이 몰래 끼어드는 것을 막는다.
    const recomputed = summarize(m.samples);
    for (const key of ['min', 'median', 'p90'] as const) {
      if (typeof m[key] === 'number' && Math.abs((m[key] as number) - recomputed[key]) > 1e-6) {
        problems.push(`${id}: ${key} ${m[key]} does not match samples (${recomputed[key]})`);
      }
    }
    if (typeof m.method !== 'string' || m.method.length < 10) problems.push(`${id}: method must describe how it was measured`);
    if (typeof m.reproducible !== 'boolean') problems.push(`${id}: reproducible must be boolean`);
    if (typeof m.notes !== 'string') problems.push(`${id}: notes must be a string`);
    if (m.regressionFloor !== undefined && (typeof m.regressionFloor !== 'number' || m.regressionFloor < 0)) problems.push(`${id}: regressionFloor must be >= 0`);
  }
  return problems;
}
