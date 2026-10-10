/** 측정 환경 기록과 반복 측정 도우미. 시간이 섞이는 코드는 여기와 각 측정 모듈에만 둔다. */
import {execFileSync} from 'node:child_process';
import {cpus, loadavg, release, totalmem, type} from 'node:os';
import {resolve} from 'node:path';
import {measurement, round, type PerfEnvironment, type PerfMeasurement, type PerfUnit} from './stats';

export const REPO_ROOT = resolve(import.meta.dir, '..', '..');

const text = (command: string, args: string[]): string => {
  try { return execFileSync(command, args, {encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore']}).trim(); }
  catch { return ''; }
};

export const load = (): number[] => loadavg().map(value => round(value, 2));

export function captureEnvironment(loadavgStart: number[]): PerfEnvironment {
  return {
    machineModel: text('sysctl', ['-n', 'hw.model']) || 'unknown',
    cpuModel: text('sysctl', ['-n', 'machdep.cpu.brand_string']) || cpus()[0]?.model || 'unknown',
    cpuCount: cpus().length,
    totalMemoryGiB: round(totalmem() / 1024 ** 3, 1),
    os: `${type()} ${release()} (${text('sw_vers', ['-productVersion']) || '?'})`,
    bunVersion: Bun.version,
    gitHead: text('git', ['rev-parse', 'HEAD']) || 'unknown',
    // 더러운 작업 트리에서 잰 숫자는 그 커밋의 숫자가 아니다 — 비교할 때 이것부터 본다.
    gitDirty: text('git', ['status', '--porcelain']).length > 0,
    loadavgStart,
    loadavgEnd: load(),
  };
}

export const now = (): number => performance.now();

export interface SampleOptions {
  samples: number;
  warmup?: number;
  /** 표본 사이 쉬는 시간(ms) — 앞 표본의 정리(프로세스 종료·GC)가 다음 표본에 섞이지 않게. */
  gapMs?: number;
}

/** fn이 돌려준 값(ms 또는 개수)을 samples번 모은다. 워밍업 표본은 버린다. */
export async function collect(fn: (index: number) => Promise<number>, options: SampleOptions): Promise<number[]> {
  for (let i = 0; i < (options.warmup ?? 0); i += 1) await fn(-1 - i);
  const values: number[] = [];
  for (let i = 0; i < options.samples; i += 1) {
    values.push(await fn(i));
    if (options.gapMs) await Bun.sleep(options.gapMs);
  }
  return values;
}

export interface Sampled { samples: number[]; loadavg: {start: number[]; end: number[]} }

/** 표본을 모으는 구간의 load average를 앞뒤로 기록한다. 측정 기록은 이것으로만 만든다. */
export async function sampled(run: () => Promise<number[]>): Promise<Sampled> {
  const start = load();
  const samples = await run();
  return {samples, loadavg: {start, end: load()}};
}

/** 한 실행에서 여러 측정의 표본을 함께 모을 때 쓰는 기록기 — 각 측정이 같은 구간의 load를 갖는다. */
export function recorder<K extends string>(keys: readonly K[]) {
  const start = load();
  const samples = Object.fromEntries(keys.map(key => [key, [] as number[]])) as Record<K, number[]>;
  return {samples, done: (): Record<K, Sampled> => {
    const end = load();
    return Object.fromEntries(keys.map(key => [key, {samples: samples[key], loadavg: {start, end}}])) as Record<K, Sampled>;
  }};
}

export function record(input: {
  unit?: PerfUnit;
  method: string;
  reproducible: boolean;
  notes?: string;
  regressionFloor?: number;
  data: Sampled;
}): PerfMeasurement {
  if (!input.data.samples.length) throw new Error(`no samples for: ${input.method.slice(0, 60)}`);
  return measurement({
    unit: input.unit ?? 'ms',
    samples: input.data.samples,
    method: input.method,
    reproducible: input.reproducible,
    notes: input.notes,
    regressionFloor: input.regressionFloor,
    loadavg: input.data.loadavg,
  });
}

export const log = (line: string) => console.error(`[perf] ${line}`);
