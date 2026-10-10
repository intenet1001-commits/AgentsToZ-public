/**
 * Evaluator for the sidecar's cumulative-load slowdown.
 *
 * ⚠️ KNOWN LIMIT — read before trusting a number from this file.
 * Synthetic fixtures cannot reach the production status path. Measured attempts:
 *   - no .agent-memory/config.json      -> HTTP 400 (rejection branch)
 *   - unreachable Supabase in portal    -> HTTP 400 after ~7s of connect retries
 *   - real portal + fabricated memoryId -> HTTP 409 (identity claim conflict)
 * The guard below fails the run when samples never reach the real path, so this file
 * is currently useful as a harness skeleton and a warning, not as a source of latency
 * numbers. For real figures, measure a registered project against the running sidecar.
 *
 * What a live measurement showed (registered project, warm):
 *   ~1240ms per /api/project-memory/remote-status
 *     ~83ms   synchronous git inspection (8 spawnSync calls)  ~7%
 *     ~1157ms four sequential Supabase round trips            ~93%
 *   One of those round trips is a device-status upsert issued by a read-only query.
 *
 * Usage: bun tests/sidecar-load-degradation-bench.mjs [requests] [--panel] [--json out.json]
 */
import {startTestApiServer} from './startTestApiServer.ts';
import {mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';

const requests = Number(process.argv[2] ?? 60);
// `sweep` walks many distinct projects (the audit pattern); `panel` re-reads one
// project the way the detail panel and its refreshes do. They stress different
// costs, so a fix that helps one may do nothing for the other.
const mode = process.argv.includes('--panel') ? 'panel' : 'sweep';
const jsonFlag = process.argv.indexOf('--json');
const jsonOut = jsonFlag > 0 ? process.argv[jsonFlag + 1] : null;

// Isolated app data + a set of distinct project folders, so the workload looks like
// the real sweep (many different folderPaths) rather than one cached path.
const appData = mkdtempSync(join(tmpdir(), 'az-perf-appdata-'));
const projectsRoot = mkdtempSync(join(tmpdir(), 'az-perf-projects-'));

// The status route loads portal.json for the Supabase client and the deviceId it
// reports. Without a reachable Supabase the route throws and answers 400, which is how
// an earlier run ended up timing the failure branch. Reuse this machine's real portal
// so every request stays on the production path; the benchmark still runs its own
// isolated api-server and never touches the live sidecar on 3001.
const realPortal = join(homedir(), 'Library', 'Application Support', 'com.portmanager.portmanager', 'portal.json');
if (!existsSync(realPortal)) {
  console.error(`FAIL: ${realPortal} is required so the status path can reach Supabase.`);
  process.exit(1);
}
copyFileSync(realPortal, join(appData, 'portal.json'));
const folders = Array.from({length: 12}, (_, i) => {
  const dir = join(projectsRoot, `project-${i}`);
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'README.md'), `fixture ${i}\n`);
  // Real registered projects are git repositories, and the status path runs a
  // synchronous git inspection per request. A non-git fixture would measure a
  // path the production sweep never takes.
  const git = args => Bun.spawnSync(['git', '-C', dir, ...args], {stdout: 'ignore', stderr: 'ignore'});
  git(['init', '-q']);
  git(['config', 'user.email', 'bench@example.invalid']);
  git(['config', 'user.name', 'bench']);
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  // Without .agent-memory/config.json the status route short-circuits before the
  // git inspection and the device report, so the benchmark would only ever time the
  // rejection path. An earlier run measured exactly that and produced meaningless
  // numbers — every sample came back as the "no local memory" answer.
  mkdirSync(join(dir, '.agent-memory'), {recursive: true});
  writeFileSync(join(dir, '.agent-memory', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    memoryId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    sourcePath: '.agent-memory/CORE.md',
    agent: 'claude',
    autoBackup: false,
  }, null, 2));
  writeFileSync(join(dir, '.agent-memory', 'CORE.md'), `# fixture ${i}\n\nbenchmark memory body.\n`);
  git(['add', '-A']);
  git(['commit', '-qm', 'memory']);
  return dir;
});

const {baseUrl, child} = await startTestApiServer({
  cwd: join(import.meta.dir, '..'),
  env: {
    ...process.env,
    APP_DATA_DIR: appData,
    // No Supabase credentials: remote lookups short-circuit, which isolates the
    // local/filesystem cost this benchmark is about.
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
  },
});

const samples = [];
let reachedStatusPath = 0;
try {
  for (let i = 0; i < requests; i += 1) {
    const folderPath = mode === 'panel' ? folders[0] : folders[i % folders.length];
    const url = `${baseUrl}/api/project-memory/remote-status?folderPath=${encodeURIComponent(folderPath)}`;
    const started = performance.now();
    let status = 0;
    try {
      const response = await fetch(url, {method: 'POST', signal: AbortSignal.timeout(20_000)});
      status = response.status;
      const text = await response.text();
      // Guard the benchmark itself. A folder without local memory is answered before
      // the git inspection runs, so those samples time the rejection path and say
      // nothing about the cost under investigation.
      if (status === 200 && !text.includes('"memoryId":null')) reachedStatusPath += 1;
    } catch (error) {
      status = error?.name === 'TimeoutError' ? -1 : -2;
    }
    samples.push({index: i + 1, ms: Math.round(performance.now() - started), status});
  }
} finally {
  child.kill();
}

if (reachedStatusPath < requests * 0.9) {
  console.error(`FAIL: only ${reachedStatusPath}/${requests} requests reached the real status path — the numbers below would measure the rejection branch.`);
  process.exitCode = 1;
}

const window = Math.max(1, Math.floor(requests / 6));
const buckets = [];
for (let start = 0; start < samples.length; start += window) {
  const chunk = samples.slice(start, start + window);
  const times = chunk.map(s => s.ms).sort((a, b) => a - b);
  buckets.push({
    range: `${chunk[0].index}-${chunk[chunk.length - 1].index}`,
    median: times[Math.floor(times.length / 2)],
    max: times[times.length - 1],
    timeouts: chunk.filter(s => s.status === -1).length,
    errors: chunk.filter(s => s.status === -2).length,
  });
}

const first = buckets[0];
const last = buckets[buckets.length - 1];
// Degradation ratio: if the cost is per-request work, this stays near 1.
const ratio = first.median > 0 ? last.median / first.median : (last.median > 0 ? Infinity : 1);

for (const b of buckets) {
  console.log(`  #${b.range.padEnd(9)} median ${String(b.median).padStart(6)}ms  max ${String(b.max).padStart(6)}ms  timeouts ${b.timeouts}  errors ${b.errors}`);
}
console.log(`mode=${mode} degradation: first=${first.median}ms last=${last.median}ms ratio=${ratio === Infinity ? 'inf' : ratio.toFixed(2)}x`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({requests, buckets, ratio: ratio === Infinity ? null : ratio, samples}, null, 1));
  console.log(`json: ${jsonOut}`);
}
