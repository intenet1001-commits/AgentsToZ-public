/**
 * J2-SCREEN-SIM (WP8, unattended, 「Core + 표면만」): the gesture probe's viewer mode in an owned disposable simulator
 * against the fixture Screen host on this Mac's loopback.
 *
 * Who runs where:
 * - This module runs in the orchestrator, unsandboxed. It holds the simulator boot lock and runs
 *   `python3 -I mobile/ios/scripts/check-ui.py --screen-gestures --evidence-root <run>/j2 --screen-host-sandbox-base
 *   <the run's host profile> --screen-host-state-parent <the run's scratch>` with the toolchain environment: the same
 *   build and boot as the gesture lane (ios-ui), plus ScreenViewerUITests.
 * - check-ui.py starts `screenFixtureHost.ts serve --mode viewer` (the fixture under sandbox-exec, WP1's host profile
 *   plus the fixture's narrowing rules, an environment built from empty, 127.0.0.1 only, synthetic capture, input
 *   recorded and never injected). The probe (`--screen-viewer`) connects with ScreenControlCore's public
 *   `ScreenViewer.connect(over:mac:signer:)` over an in-probe loopback transport, an in-memory software key and the
 *   production `ScreenSurface.SurfaceView`; XCUITest taps, two-finger taps, presses and drags, and types text with Return.
 *   An impostor key must be refused by the Mac. check-ui.py ends the session from the Mac (scripted, recorded) once the
 *   host has recorded the text.
 * - The verdict needs both ends (screenViewerJudge.ts, run by check-ui.py and again here on the same folder): the phone's
 *   test outcomes and attached labels (pictures counted only while the display layer never failed), and the host's
 *   receipts, recorded input (token for token what the phone sent, every pointer x,y equal as numbers, the tap and the
 *   drag where the UI test put them), frame totals and nm gate. The process-tree listener sample below is a separate
 *   look at where anything listened.
 *
 * Out of scope (labelled): the AgentsToZMobile app screen, ScreenViewerModel, route selection, Face ID and the Secure
 * Enclave on the phone; ScreenService, capture, injection and TCC on the Mac (WP7's fixture). The session bar
 * (feat/screen-session-bar) is not on emu/integration, so the fixture exposes no session-bar model state yet.
 */
import {existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync} from 'node:fs';
import {join, relative} from 'node:path';
import {createHash} from 'node:crypto';
import type {LaneContext, LaneDefinition} from '../emulator-e2e';
import {sha256File, type LaneOutcome, type PathLabels} from './evidence';
import {watchListeners, type ListenerWatch} from './workroomPty';
import {DENIED_PORTS, SCREEN_FIXTURE_LABEL} from './screenFixtureHost';
import {SCOPE_LABEL, judgeRunDirectory, type JudgeVerdict} from './screenViewerJudge';

export const J2_SCRIPT = 'mobile/ios/scripts/check-ui.py';
export const J2_EVIDENCE = 'j2';
/** check-ui's own step limits (design §7, unchanged): portal 300 s, build 600 s, boot 480 s, host ready ≤600 s (overlaps the
 * build), tests 600 s; then the judge ≤120 s and the host stop ≤120 s. */
export const J2_TIMEOUT_MS = 50 * 60_000;
/** After SIGINT (Python runs its finally: host stop, simulator shutdown and delete). */
export const J2_STOP_GRACE_MS = 4 * 60_000;
export const J2_EXPECTED: Readonly<{passed: number; skipped: number}> = Object.freeze({passed: 9, skipped: 0});
export const J2_GESTURE_ONLY_EXPECTED: Readonly<{passed: number; skipped: number}> = Object.freeze({passed: 7, skipped: 0});
/** What the lane fingerprints before and after: it must change no production source. */
export const J2_PRODUCTION_SOURCE_DIRS = Object.freeze(['mobile/ios/App', 'native/screen-control/Sources/ScreenControlCore',
  'native/screen-control/Sources/ScreenHost']);
/** The probe app refers to the loopback transport whichever mode it launches in, so both plans compile it. */
export const J2_PROBE_APP_SOURCES = Object.freeze(['mobile/ios/UITests/Fixtures/ScreenGestureProbeApp.swift',
  'mobile/ios/UITests/Fixtures/LoopbackFrameTransport.swift']);
export const J2_VIEWER_TEST_SOURCE = 'mobile/ios/UITests/ScreenViewerUITests.swift';

/** The files a plan copies into the disposable project's app target (check-ui.py's gestureProjectSources). */
export function appTargetSources(plan: Record<string, any> | null): string[] {
  const sources = Array.isArray(plan?.gestureProjectSources) ? plan.gestureProjectSources : [];
  return sources.filter((item: any) => typeof item?.source === 'string' && typeof item?.as === 'string' && item.as.startsWith('App/'))
    .map((item: any) => item.source as string).sort();
}

export const J2_LABELS: PathLabels = Object.freeze({
  real: [
    `${SCOPE_LABEL}: ScreenControlCore on the phone — ScreenViewer.connect(over:mac:signer:) key exchange, PinnedMac check, SecureChannel records, pictures, notices, input, text-and-Return (protocol 4)`,
    'production ScreenSurface.SurfaceView touch gestures (tap → left click, two-finger tap → right click, press-and-drag) and ScreenComposeTextField Return, driven by XCUITest in an owned simulator; every pointer x,y the surface sent equals the host\'s record, and the tap and drag land where they were made',
    'H.264 samples enqueued while AVSampleBufferDisplayLayer reports rendering and no failures or recovery keyframes',
    'production 4-byte frame format (FrameReader) over TCP to 127.0.0.1',
    ...SCREEN_FIXTURE_LABEL.real.map(item => `fixture host: ${item}`),
  ],
  standIn: [
    `${SCOPE_LABEL}: no AgentsToZMobile app screen, ScreenViewerModel, route selection, Face ID or Secure Enclave on the phone`,
    'phone app -> gesture probe (ScreenGestureProbeApp --screen-viewer) compiled into a disposable copy of the project',
    'phone transport -> LoopbackFrameTransport in the probe (ScreenClient requires Wi-Fi on iOS)',
    'phone signer -> in-memory software P-256 key',
    ...SCREEN_FIXTURE_LABEL.substitutes.filter(item => !item.startsWith('selfcheck phone')).map(item => `fixture host: ${item}`),
    'Mac-side session end -> scripted `end` command from check-ui.py once the host recorded the text (receipt scripted:true)',
    'owned disposable headless simulator instead of an iPhone',
  ],
}) as PathLabels;

export interface CheckUiRun {
  exitCode: number | null;
  timedOut: boolean;
  result: Record<string, any> | null;
  summary: Record<string, any> | null;
}

/** check-ui.py's result → the phone-side outcome. Missing or unfinished means fail, never pass. */
export function laneOutcomeFromCheckUi(run: CheckUiRun): Pick<LaneOutcome, 'status' | 'reason'> {
  if (run.timedOut) return {status: 'fail', reason: `check-ui.py did not finish within ${J2_TIMEOUT_MS / 60_000} min`};
  const result = run.result;
  if (!result) return {status: 'fail', reason: `check-ui.py left no result.json (exit ${run.exitCode})`};
  if (result.state !== 'passed' || run.exitCode !== 0) {
    const problems = Array.isArray(result.problems) && result.problems.length ? result.problems.join('; ') : `state ${String(result.state)}`;
    return {status: 'fail', reason: `check-ui.py exit ${run.exitCode}: ${problems}`};
  }
  const problems: string[] = [];
  if (result.mode !== 'screen-gestures' || result.screenViewer !== true) problems.push('check-ui.py did not run the viewer tests');
  if (result.expected?.passed !== J2_EXPECTED.passed || result.expected?.skipped !== J2_EXPECTED.skipped) {
    problems.push(`check-ui.py expected ${JSON.stringify(result.expected)}, not ${JSON.stringify(J2_EXPECTED)}`);
  }
  const summary = run.summary;
  if (!summary) problems.push('no summary.json');
  else if (summary.failedTests !== 0 || summary.passedTests !== J2_EXPECTED.passed || summary.skippedTests !== J2_EXPECTED.skipped) {
    problems.push(`summary passed ${summary.passedTests} / skipped ${summary.skippedTests} / failed ${summary.failedTests} ≠ ${J2_EXPECTED.passed} / ${J2_EXPECTED.skipped} / 0`);
  }
  if (result.screenViewerVerdict?.ok !== true) problems.push('check-ui.py\'s both-ends verdict is not ok');
  if (result.screenViewerHost?.stateRemoved !== true) problems.push('the fixture host\'s scratch (keys, pins) was not removed');
  if (result.screenViewerHost?.exit !== 0) problems.push(`the fixture host exited ${String(result.screenViewerHost?.exit)}`);
  const bar = result.screenViewerHost?.bar;
  if (result.screenViewerHost?.barObservedByPhone !== true || bar?.status?.title !== 'iPhone ‘Fixture Phone’ · 조작 중'
      || bar?.pause?.title !== 'iPhone ‘Fixture Phone’ · 원격 입력 멈춤' || bar?.pause?.held !== true
      || bar?.view?.title !== 'iPhone ‘Fixture Phone’ · 보는 중' || bar?.view?.held !== true) {
    problems.push('fixture phone session-bar model did not pass flowing, paused and view-only states');
  }
  return problems.length ? {status: 'fail', reason: problems.join('; ')} : {status: 'pass'};
}

/** The three plans (nothing runs): the lane's own, the gesture-only fallback, and a device run (never a viewer). */
export function planProblems(plans: {viewer: Record<string, any> | null; gestureOnly: Record<string, any> | null; device: Record<string, any> | null}): string[] {
  const problems: string[] = [];
  const names = (plan: Record<string, any> | null) => JSON.stringify(plan?.commands ?? []);
  const {viewer, gestureOnly, device} = plans;
  if (!viewer) problems.push('check-ui.py --screen-gestures --plan printed no JSON');
  else {
    if (viewer.screenViewer !== true) problems.push('the gesture plan does not run the viewer tests');
    if (viewer.expected?.passed !== J2_EXPECTED.passed || viewer.expected?.skipped !== J2_EXPECTED.skipped) problems.push(`the gesture plan expects ${JSON.stringify(viewer.expected)}`);
    if (!names(viewer).includes('screenFixtureHost.ts') || !names(viewer).includes('"--mode","viewer"')) problems.push('the gesture plan does not start the fixture host in viewer mode');
    if (!names(viewer).includes('screenViewerJudge.ts')) problems.push('the gesture plan does not judge both ends');
    if (JSON.stringify(appTargetSources(viewer)) !== JSON.stringify([...J2_PROBE_APP_SOURCES].sort())) problems.push(`the gesture plan's app target compiles ${JSON.stringify(appTargetSources(viewer))}`);
    if (!JSON.stringify(viewer.gestureProjectSources ?? []).includes(J2_VIEWER_TEST_SOURCE)) problems.push('the gesture plan does not compile the viewer UI tests');
  }
  if (!gestureOnly) problems.push('check-ui.py --screen-gestures --no-screen-viewer --plan printed no JSON');
  else {
    if (gestureOnly.screenViewer !== false || names(gestureOnly).includes('screenFixtureHost.ts')) problems.push('the gesture-only plan still starts the fixture host');
    if (gestureOnly.expected?.passed !== J2_GESTURE_ONLY_EXPECTED.passed || gestureOnly.expected?.skipped !== J2_GESTURE_ONLY_EXPECTED.skipped) problems.push(`the gesture-only plan expects ${JSON.stringify(gestureOnly.expected)}`);
    // The fallback (design §7) must build: its app target is the same probe and needs the same transport.
    if (JSON.stringify(appTargetSources(gestureOnly)) !== JSON.stringify([...J2_PROBE_APP_SOURCES].sort())) problems.push(`the gesture-only plan's app target compiles ${JSON.stringify(appTargetSources(gestureOnly))}, not the probe and its transport`);
    if (JSON.stringify(gestureOnly.gestureProjectSources ?? []).includes(J2_VIEWER_TEST_SOURCE)) problems.push('the gesture-only plan still compiles the viewer UI tests');
  }
  if (!device) problems.push('check-ui.py --device … --plan printed no JSON');
  else if (device.screenViewer !== false || names(device).includes('screenFixtureHost.ts')) problems.push('a device plan would start the fixture host');
  return problems;
}

/** Every listener the run's process tree opened: 127.0.0.1 only, never a reserved port, and the fixture's port among them. */
export function loopbackListenerProblems(seen: ReadonlyArray<{address: string; port: number}>, fixturePort: number | null, viewerPassed: boolean): string[] {
  const problems: string[] = [];
  for (const listener of seen) {
    if (listener.address !== '127.0.0.1') problems.push(`listener on ${listener.address}:${listener.port} (only 127.0.0.1 is allowed)`);
    if ((DENIED_PORTS as readonly number[]).includes(listener.port)) problems.push(`listener on reserved port ${listener.port}`);
  }
  if (viewerPassed) {
    if (fixturePort === null) problems.push('result.json names no fixture port');
    else if (!seen.some(listener => listener.address === '127.0.0.1' && listener.port === fixturePort)) problems.push(`the fixture port 127.0.0.1:${fixturePort} was never seen listening`);
  }
  return problems;
}

/** SHA-256 of every Swift file under `dirs` (relative path → hash) and one digest over them. */
export function productionSourceDigest(root: string, dirs: readonly string[] = J2_PRODUCTION_SOURCE_DIRS): {files: number; digest: string} {
  const hashes: string[] = [];
  const visit = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const name of entries) {
      const path = join(dir, name);
      if (name.endsWith('.swift')) hashes.push(`${relative(root, path)} ${sha256File(path)}`);
      else if (!name.includes('.')) visit(path);
    }
  };
  for (const dir of dirs) visit(join(root, dir));
  return {files: hashes.length, digest: createHash('sha256').update(hashes.join('\n')).digest('hex')};
}

function readJson(path: string): Record<string, any> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function readText(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

async function runCheckUi(argv: string[], options: {cwd: string; env: Record<string, string>; onSpawn: (pid: number) => void}): Promise<{exitCode: number | null; output: string; timedOut: boolean}> {
  const child = Bun.spawn(argv, {cwd: options.cwd, env: options.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
  options.onSpawn(child.pid);
  let timedOut = false;
  // SIGINT, not SIGTERM: Python turns it into KeyboardInterrupt and runs check-ui's cleanup (host, simulator).
  const interrupt = setTimeout(() => { timedOut = true; try { child.kill('SIGINT'); } catch {} }, J2_TIMEOUT_MS);
  const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, J2_TIMEOUT_MS + J2_STOP_GRACE_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return {exitCode, output: `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`, timedOut};
  } finally {
    clearTimeout(interrupt);
    clearTimeout(kill);
  }
}

/** `bun` and `node` for check-ui (the portal build runs vite, the host and judge run in bun) without the person's tool folders. */
function toolBin(scratchRoot: string, inheritedPath: string | undefined): {dir: string; node: string} {
  const dir = join(scratchRoot, 'j2-bin');
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const node = Bun.which('node', {PATH: inheritedPath ?? ''}) ?? process.execPath;
  if (!existsSync(join(dir, 'bun'))) symlinkSync(process.execPath, join(dir, 'bun'));
  if (!existsSync(join(dir, 'node'))) symlinkSync(node, join(dir, 'node'));
  return {dir, node};
}

function simulatorExists(udid: string, env: Record<string, string>): boolean | null {
  const listed = Bun.spawnSync(['/usr/bin/xcrun', 'simctl', 'list', 'devices', '--json'], {env, stdout: 'pipe', stderr: 'ignore'});
  if (listed.exitCode !== 0) return null;
  try {
    const devices = (JSON.parse(listed.stdout.toString()) as {devices: Record<string, Array<{udid: string}>>}).devices;
    return Object.values(devices).flat().some(device => device.udid === udid);
  } catch { return null; }
}

function plan(script: string, args: string[], cwd: string, env: Record<string, string>): Record<string, any> | null {
  const out = Bun.spawnSync(['/usr/bin/python3', '-I', script, ...args, '--plan'], {cwd, env, stdout: 'pipe', stderr: 'pipe'});
  try { return JSON.parse(out.stdout.toString()); } catch { return null; }
}

export const lane: LaneDefinition = {
  id: 'j2',
  title: 'J2-SCREEN-SIM — gesture probe viewer mode (Core + surface only)',
  preconditions: () => [],
  async run(ctx: LaneContext): Promise<LaneOutcome> {
    const quiet = await ctx.waitForQuietSimulatorChecks(120_000);
    if (quiet.status !== 'clear') return {status: 'blocked', reason: `another simulator check is running: ${quiet.seen.map(row => row.command).join(' | ').slice(0, 300)}`, labels: J2_LABELS};
    const lock = await ctx.acquireSimulatorBootLock(10 * 60_000);
    if (lock.status !== 'acquired') return {status: 'blocked', reason: lock.reason, labels: J2_LABELS};

    const evidenceRoot = ctx.evidence.path(J2_EVIDENCE);
    mkdirSync(evidenceRoot, {recursive: true, mode: 0o700});
    const toolchain = ctx.toolchainEnv();
    const tools = toolBin(ctx.scratchRoot, process.env.PATH);
    const env = {...toolchain, PATH: `${tools.dir}:${toolchain.PATH}`};
    const script = join(ctx.repoRoot, J2_SCRIPT);

    const plans = {
      viewer: plan(script, ['--screen-gestures'], ctx.repoRoot, env),
      gestureOnly: plan(script, ['--screen-gestures', '--no-screen-viewer'], ctx.repoRoot, env),
      device: plan(script, ['--device', '00000000-0000000000000000'], ctx.repoRoot, env),
    };
    ctx.evidence.writeJson(`${J2_EVIDENCE}/plans.json`, plans);
    const sourcesBefore = productionSourceDigest(ctx.repoRoot);

    const argv = ['/usr/bin/python3', '-I', script, '--screen-gestures', '--evidence-root', evidenceRoot,
      '--screen-host-sandbox-base', ctx.hostSandbox.path, '--screen-host-state-parent', ctx.scratchRoot];
    ctx.log(`j2: python3 ${J2_SCRIPT} --screen-gestures (fixture Screen host on 127.0.0.1, host profile ${ctx.hostSandbox.sha256.slice(0, 12)})`);
    const watches: Array<{stop(): ListenerWatch}> = [];
    let listeners: ListenerWatch = {samples: 0, seen: []};
    let run: Awaited<ReturnType<typeof runCheckUi>>;
    try {
      run = await runCheckUi(argv, {cwd: ctx.repoRoot, env, onSpawn: pid => { watches.push(watchListeners(pid)); }});
    } finally {
      for (const watch of watches) listeners = watch.stop();
    }
    const log = ctx.evidence.writeText(`${J2_EVIDENCE}.log`, run.output);

    const runDirs = readdirSync(evidenceRoot).filter(name => name.startsWith('run-')).map(name => join(evidenceRoot, name));
    const runDir = runDirs.length === 1 ? runDirs[0]! : null;
    const result = runDir ? readJson(join(runDir, 'result.json')) : null;
    const summary = runDir ? readJson(join(runDir, 'summary.json')) : null;

    // The owned simulator: the harness checks it is gone; a run killed before its cleanup is swept here.
    const problems: string[] = [];
    const udid = typeof result?.simulatorUdid === 'string' ? result.simulatorUdid : null;
    let sweptSimulator = false;
    if (udid) {
      ctx.ownSimulator(udid, typeof result?.simulatorRuntime === 'string' ? result.simulatorRuntime : undefined);
      if (simulatorExists(udid, toolchain)) {
        for (const action of ['shutdown', 'delete']) Bun.spawnSync(['/usr/bin/xcrun', 'simctl', action, udid], {env: toolchain, stdout: 'ignore', stderr: 'ignore'});
        sweptSimulator = true;
        problems.push(`owned simulator ${udid} was still present after check-ui.py (swept${simulatorExists(udid, toolchain) ? ', still present' : ''})`);
      }
    } else problems.push('result.json names no owned simulator');
    if (runDirs.length !== 1) problems.push(`expected one check-ui run folder, found ${runDirs.length}`);

    const phone = laneOutcomeFromCheckUi({exitCode: run.exitCode, timedOut: run.timedOut, result, summary});
    // Both ends again, here, on the same folder (the judge reads only files).
    const verdict: JudgeVerdict | null = runDir ? judgeRunDirectory(runDir, true) : null;
    if (verdict && !verdict.ok) problems.push(...verdict.problems.map(problem => `both ends: ${problem}`));
    if (!verdict) problems.push('no run folder to judge');
    problems.push(...planProblems(plans));
    const fixturePort = typeof result?.screenViewerHost?.port === 'number' ? result.screenViewerHost.port : null;
    const listenerIssues = loopbackListenerProblems(listeners.seen, fixturePort, phone.status === 'pass');
    problems.push(...listenerIssues);
    const sourcesAfter = productionSourceDigest(ctx.repoRoot);
    if (sourcesAfter.digest !== sourcesBefore.digest) problems.push('a production source changed during the run');

    const outcome: Pick<LaneOutcome, 'status' | 'reason'> = problems.length
      ? {status: 'fail', reason: [...problems, ...(phone.reason ? [phone.reason] : [])].join('; ').slice(0, 4_000)}
      : phone;

    const hostDir = runDir ? join(runDir, 'screen-host') : null;
    const artifacts = [log, ...(runDir ? ['result.json', 'summary.json', 'screen-viewer-verdict.json', 'screen-host-ready.json',
      'screen-host/host-receipts.jsonl', 'screen-host/input-events.jsonl', 'screen-host/frames.json', 'screen-host/nm-gate.txt',
      'attachments/manifest.json'].map(name => join(runDir, name)).filter(existsSync) : [])].map(path => ctx.evidence.relative(path));
    return {
      ...outcome,
      labels: J2_LABELS,
      artifacts,
      details: {
        label: SCOPE_LABEL,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        timings: result?.timings ?? null,
        expected: J2_EXPECTED,
        phone: result ? {state: result.state, passed: result.passed ?? null, skipped: result.skipped ?? null, failed: result.failed ?? null,
          runtime: result.runtime ?? null, simulator: result.simulator ?? null, gitHead: result.gitHead ?? null, seen: verdict?.phone ?? null} : null,
        summary: summary ? {result: summary.result, passedTests: summary.passedTests, skippedTests: summary.skippedTests, failedTests: summary.failedTests,
          totalTestCount: summary.totalTestCount} : null,
        tests: verdict?.tests.observed ?? null,
        host: {...(verdict?.host ?? {}), port: fixturePort, protocolVersion: result?.screenViewerHost?.protocolVersion ?? null,
          sandboxProfileSha256: result?.screenViewerHost?.sandboxProfileSha256 ?? null, hostProfileSha256: ctx.hostSandbox.sha256,
          exit: result?.screenViewerHost?.exit ?? null, stateRemoved: result?.screenViewerHost?.stateRemoved ?? null,
          endReply: result?.screenViewerHost?.endReply ?? null, hostStderrBytes: hostDir ? readText(join(hostDir, 'host-stderr.log')).length : null},
        verdictProblems: verdict?.problems.slice(0, 20) ?? null,
        listeners: {samples: listeners.samples, seen: listeners.seen, problems: listenerIssues},
        plans: Object.fromEntries(Object.entries(plans).map(([name, value]) => [name, value ? {expected: value.expected, screenViewer: value.screenViewer,
          gestureProjectSources: value.gestureProjectSources ?? null} : null])),
        productionSources: {before: sourcesBefore, after: sourcesAfter},
        ownedSimulator: udid ? {udid, swept: sweptSimulator} : null,
        sessionBar: {exposed: true, scope: 'fixture session-bar model only; no panel or actual ScreenService', states: result?.screenViewerHost?.bar ?? null},
        sources: Object.fromEntries(['scripts/emulator-e2e/screenViewerLane.ts', 'scripts/emulator-e2e/screenViewerJudge.ts', 'scripts/emulator-e2e/screenFixtureHost.ts',
          J2_SCRIPT, 'mobile/ios/UITests/ScreenViewerUITests.swift', 'mobile/ios/UITests/Fixtures/ScreenGestureProbeApp.swift',
          'mobile/ios/UITests/Fixtures/LoopbackFrameTransport.swift']
          .map(file => [file, existsSync(join(ctx.repoRoot, file)) ? sha256File(join(ctx.repoRoot, file)) : null])),
        nodeForPortalBuild: tools.node === process.execPath ? 'bun (no node found)' : 'node from the orchestrator PATH (symlinked alone)',
      },
    };
  },
};
