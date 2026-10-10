/**
 * 성능 기준선 — 한 명령으로 재현 가능한 측정을 모두 돌리고 docs/perf/baseline.json에 남긴다.
 *
 *   bun run perf:baseline                                   # 측정 → docs/perf/baseline.json 덮어쓰기
 *   bun run perf:baseline -- --compare docs/perf/baseline.json   # 측정 → 기준과 비교(파일은 쓰지 않음)
 *
 * 선택: --samples N(기본 5) · --only sidecar,workroom,community,remote,ui · --out <path>
 *       --ratio 1.5(회귀 비율) · --real-cli(실제 claude/codex 첫 출력, 비교 대상 아님) · --keep(스크래치 보존)
 *
 * 비교의 종료 코드: reproducible 측정 중 하나라도 「중앙값 > 기준×ratio 그리고 증가분 > floor」면 1.
 * 실기·설치본·외부 CLI 측정은 보여 주기만 한다. 측정 방법과 안전 경계는 각 모듈 머리 주석에 있다:
 *   sidecar.ts(A·D) · workroom.ts(B·D) · community.ts(C) · ui-lists.mjs(E) · stats.ts(통계·비교·스키마)
 */
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {REPO_ROOT, captureEnvironment, load, log, record, sampled} from './environment';
import {compareBaselines, formatComparison, PERF_BASELINE_SCHEMA_VERSION, validateBaseline, type PerfBaseline, type PerfMeasurement} from './stats';
import {buildProjectsFixture, measureRemoteProjectList, measureSidecarStart} from './sidecar';
import {measureRealCliFirstOutput, measureWorkroomRead, measureWorkroomStart} from './workroom';
import {measureCommunityControl} from './community';

const GROUPS = ['sidecar', 'workroom', 'community', 'remote', 'ui'] as const;
type Group = typeof GROUPS[number];

function parseArgs(argv: string[]) {
  const value = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const samples = Number(value('--samples') ?? 5);
  if (!Number.isInteger(samples) || samples < 3 || samples > 30) throw new Error('--samples must be an integer from 3 to 30');
  const only = value('--only')?.split(',').map(s => s.trim()).filter(Boolean) as Group[] | undefined;
  for (const group of only ?? []) if (!GROUPS.includes(group)) throw new Error(`--only: unknown group ${group} (${GROUPS.join(',')})`);
  const compare = value('--compare');
  const ratio = Number(value('--ratio') ?? 1.5);
  return {
    samples, groups: new Set<Group>(only ?? GROUPS), compare: compare ? resolve(compare) : null, ratio,
    out: value('--out') ? resolve(value('--out')!) : (compare ? null : join(REPO_ROOT, 'docs', 'perf', 'baseline.json')),
    realCli: argv.includes('--real-cli'), keep: argv.includes('--keep'),
  };
}

async function measureUi(scratch: string, samples: number): Promise<Record<string, PerfMeasurement>> {
  log('E 목록 그리기 — 격리 Vite 빌드');
  const dist = join(scratch, 'ui-dist');
  const build = Bun.spawnSync([join(REPO_ROOT, 'node_modules', '.bin', 'vite'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], {cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe'});
  if (build.exitCode !== 0) throw new Error(`vite build failed: ${build.stderr.toString().slice(-1500)}`);
  log('E Playwright(chromium) — 프로젝트 150 · 북마크 200');
  let raw = '';
  const data = await sampled(async () => {
    const child = Bun.spawnSync([process.execPath, join(REPO_ROOT, 'scripts', 'perf', 'ui-lists.mjs'), dist, String(samples)], {cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 300_000});
    if (child.exitCode !== 0) throw new Error(`ui-lists failed: ${child.stderr.toString().slice(-1500)}`);
    raw = child.stdout.toString().trim().split('\n').at(-1) ?? '';
    return [];
  });
  const r = JSON.parse(raw) as {projects: Record<string, number[]>; bookmarks: Record<string, number[]>; bookmarksAfterDwell: {first: number[]; dwellMs: number}; blocked: string[]};
  const withSamples = (samplesOut: number[]) => ({samples: samplesOut, loadavg: data.loadavg});
  const where = '격리 Vite 빌드 + 합성 /api(모든 요청 가로챔, 3001·DB 없음) + Playwright chromium 1440×900, 실행마다 새 컨텍스트(첫 실행 버림). 시각은 페이지 안 rAF에서 잰다.';
  const blocked = r.blocked.length ? ` 외부 요청은 차단(${r.blocked.join(', ')}).` : '';
  return {
    'ui.projects.rows-visible': record({method: `${where} 탐색 시작부터 사이드바 프로젝트 행이 처음 보일 때까지(프로젝트 150개).`, reproducible: true, regressionFloor: 100,
      notes: `행 ${r.projects.rows?.join('/')}개.${blocked}`, data: withSamples(r.projects.first!)}),
    'ui.projects.rows-settled': record({method: `${where} 탐색 시작부터 행 개수가 800ms 동안 그대로인 마지막 변화 시각까지.`, reproducible: true, regressionFloor: 100,
      notes: '행이 한 번에 다 그려지면 rows-visible과 같다.', data: withSamples(r.projects.all!)}),
    'ui.projects.long-tasks': record({unit: 'count', method: `${where} 탐색 시작~행 안정까지 50ms 이상 Long Task 수(PerformanceObserver).`, reproducible: true,
      notes: `최대 ${Math.max(...r.projects.longTaskMax!).toFixed(0)}ms, 합 ${Math.max(...r.projects.longTaskTotal!).toFixed(0)}ms(실행 중 최대).`, data: withSamples(r.projects.longTaskCount!)}),
    'ui.bookmarks.first-card': record({method: `${where} 북마크 탭 클릭(capture 리스너 시각)부터 첫 카드가 보일 때까지(북마크 200개, 카테고리 8).`, reproducible: true, regressionFloor: 60,
      notes: `카드 ${r.bookmarks.cards?.join('/')}개(한 페이지). PortalManager는 lazy chunk라 첫 방문에 React 19 Suspense 공개 지연을 받는다(react-dom-client: globalMostRecentFallbackTime + 300). chunk는 클릭 뒤 ~10ms에 도착한다.`, data: withSamples(r.bookmarks.first!)}),
    'ui.bookmarks.first-page-settled': record({method: `${where} 탭 클릭부터 카드 개수가 800ms 동안 그대로인 마지막 변화 시각까지.`, reproducible: true, regressionFloor: 60,
      data: withSamples(r.bookmarks.all!)}),
    'ui.bookmarks.first-card-after-dwell': record({method: `${where} 첫 화면이 안정된 뒤 ${r.bookmarksAfterDwell.dwellMs}ms 머문 다음 북마크 탭을 눌러 첫 카드가 보일 때까지(새 페이지마다 첫 방문).`, reproducible: true, regressionFloor: 60,
      notes: '사람이 화면을 본 뒤 누르는 보통의 경우. 유휴 미리 데우기(src/lazyTabPreload.ts)가 lazy 탭을 동기 thenable로 준비해 Suspense 공개 지연(300ms)을 피한다. 즉시 클릭(ui.bookmarks.first-card)은 그 전이라 여전히 지연을 받는 최악 경우다.',
      data: withSamples(r.bookmarksAfterDwell.first)}),
    'ui.bookmarks.long-tasks': record({unit: 'count', method: `${where} 탭 클릭~카드 안정까지 Long Task 수.`, reproducible: true,
      notes: `최대 ${Math.max(...r.bookmarks.longTaskMax!).toFixed(0)}ms.`, data: withSamples(r.bookmarks.longTaskCount!)}),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const loadStart = load();
  const scratch = mkdtempSync(join(tmpdir(), 'agentstoz-perf-'));
  log(`스크래치 ${scratch} · 표본 ${options.samples} · ${[...options.groups].join(',')}`);
  const measurements: Record<string, PerfMeasurement> = {};
  try {
    const fixture = options.groups.has('sidecar') || options.groups.has('remote') ? buildProjectsFixture(scratch) : null;
    if (options.groups.has('sidecar')) Object.assign(measurements, await measureSidecarStart(scratch, options.samples, fixture));
    if (options.groups.has('workroom')) {
      Object.assign(measurements, await measureWorkroomStart(scratch, options.samples));
      Object.assign(measurements, await measureWorkroomRead(scratch, options.samples));
      if (options.realCli) Object.assign(measurements, await measureRealCliFirstOutput(scratch, ['claude', 'codex'], 3));
    }
    if (options.groups.has('community')) Object.assign(measurements, await measureCommunityControl(scratch, options.samples));
    if (options.groups.has('remote') && fixture) Object.assign(measurements, await measureRemoteProjectList(scratch, options.samples, fixture));
    if (options.groups.has('ui')) Object.assign(measurements, await measureUi(scratch, options.samples));
  } finally {
    if (!options.keep) rmSync(scratch, {recursive: true, force: true});
  }
  const result: PerfBaseline = {
    schemaVersion: PERF_BASELINE_SCHEMA_VERSION,
    measuredAt: new Date().toISOString(),
    environment: captureEnvironment(loadStart),
    measurements: Object.fromEntries(Object.entries(measurements).sort(([a], [b]) => a.localeCompare(b))),
  };
  const problems = validateBaseline(result);
  if (problems.length) throw new Error(`produced an invalid baseline:\n${problems.join('\n')}`);

  for (const [id, m] of Object.entries(result.measurements)) {
    console.log(`${id.padEnd(44)} median ${String(m.median).padStart(9)} ${m.unit}  p90 ${String(m.p90).padStart(9)}  min ${String(m.min).padStart(9)}${m.reproducible ? '' : '  (비교 대상 아님)'}`);
  }
  console.log(`환경: ${result.environment.machineModel} · ${result.environment.cpuCount} CPU · load ${result.environment.loadavgStart.join('/')} → ${result.environment.loadavgEnd.join('/')} · ${result.environment.gitHead.slice(0, 8)}${result.environment.gitDirty ? ' (dirty)' : ''}`);

  if (options.out) {
    mkdirSync(dirname(options.out), {recursive: true});
    writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
    log(`저장: ${options.out}`);
  }
  if (options.compare) {
    const baseline = JSON.parse(readFileSync(options.compare, 'utf8'));
    const baselineProblems = validateBaseline(baseline);
    if (baselineProblems.length) throw new Error(`baseline file is invalid:\n${baselineProblems.join('\n')}`);
    // 일부만 돌렸으면 돌린 것만 비교한다(나머지를 「missing」으로 세지 않는다).
    const ran = new Set(Object.keys(result.measurements));
    const scoped = options.groups.size === GROUPS.length ? baseline
      : {...baseline, measurements: Object.fromEntries(Object.entries(baseline.measurements).filter(([id]) => ran.has(id)))};
    const comparison = compareBaselines(scoped, result, {ratio: options.ratio});
    console.log(`\n${formatComparison(comparison)}`);
    if (baseline.environment?.machineModel !== result.environment.machineModel) {
      console.log(`⚠️ 기준선은 ${baseline.environment?.machineModel}에서 쟀다 — 다른 기기의 비교는 참고만 할 것.`);
    }
    if (comparison.regressed.length) process.exitCode = 1;
  }
}

await main();
