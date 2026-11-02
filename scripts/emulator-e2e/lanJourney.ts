/**
 * J1-LAN-APP (WP4, unattended): the real AgentsToZMobile app (Debug simulator build) in an owned disposable simulator
 * pairs over the same-network URL with a sandboxed LAN journey host and walks project list → start → workroom →
 * command → output → background (real socket drop) / restore → explicit disconnect → consumed-URL replay (XCUITest test20).
 *
 * Who runs where:
 * - This module runs in the orchestrator, unsandboxed, and imports no host code (src/). It holds the simulator boot
 *   lock and runs `python3 mobile/ios/scripts/check-ui.py --evidence-root <run>/j1-lan --lan-address <en0>
 *   --require-lan-journey` with the toolchain environment (xcodebuild and simctl need the real HOME; nothing of the host
 *   runs in it). A Mac without an en0 private IPv4, or with the application firewall on, is blocked before anything runs
 *   (preconditions), and check-ui.py asks again before its build (exit 78 → blocked, never a pass).
 * - check-ui.py builds the app, creates and boots the owned simulator, and starts `lan-journey-host.ts supervise`, which
 *   picks the LAN port on <en0> at that moment (design §2.5: not at lane start — the build and boot take minutes; a port
 *   taken before the host binds it is retried with a fresh one), writes its own WP1 profile (writes only to its scratch
 *   and evidence folder, no outbound, LAN inbound on that one port), holds its own LAN binding guard and starts the host
 *   under sandbox-exec. The host refuses to start unless the OS confirms the sandbox. Once the supervisor reports the
 *   port ready, this lane arms the harness's own LAN binding guard on it (ctx.sandboxProfile with lanInbound): two guards
 *   watch the port and either one seeing a listener off <en0> fails the run. The process-tree listener sample below is
 *   the third look.
 * - The verdict needs both ends: the phone (test20 passed, the expected per-test outcomes and counts) and the host
 *   (its receipts re-judged here with the same evaluator the supervisor used).
 */
import {existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import type {LaneContext, LaneDefinition} from '../emulator-e2e';
import type {PreflightReport} from './preflight';
import {findPairTokenLeaks, sha256File, type LaneOutcome, type PathLabels} from './evidence';
import {isLoopbackListenAddress, type WrittenSandboxProfile} from './sandbox';
import {listenerProblems, watchListeners, type ListenerWatch} from './workroomPty';
import {
  BLOCKED_EXIT, JOURNEY_RESULT, RECEIPTS_FILE, VERDICT_FILE, evaluateJourneyReceipts, firewallBlockReason, parseReceipts,
} from '../../mobile/ios/scripts/lan-journey-host';

export const J1_LAN_SCRIPT = 'mobile/ios/scripts/check-ui.py';
export const J1_LAN_EVIDENCE = 'j1-lan';
/** check-ui's own step limits: portal 300 s, build 600 s, boot 480 s, host ready 150 s, tests 600 s, plus cleanup. */
export const J1_LAN_TIMEOUT_MS = 50 * 60_000;
/** After SIGINT (Python runs its finally: host stop, simulator shutdown and delete, 60 s each). */
export const J1_LAN_STOP_GRACE_MS = 4 * 60_000;
export const J1_LAN_TEST = 'test20SameNetworkJourneyPairsProjectAndWorkroom';

export const J1_LAN_LABELS: PathLabels = Object.freeze({
  real: [
    'shipped AgentsToZMobile app (Debug simulator build, XCUITest test20): onboarding 「연결 주소」 → same-network review → LANWorkroomView WKWebView',
    'RemoteControlLanServer on the en0 private IPv4 serving the shipped LAN page (HTML, JS, xterm) and WebSocket pairing, session.end and the consumed-pairing refusal (1008, refused-pair receipt; the page itself shows 「연결 종료」)',
    'LAN restart keeping the record (stop keepRecord → close 1012 → restart with restore) and the page\'s own session.restore onto a new socket after the app returns from the background (same controller, fresh management id, no new pairing)',
    'native 「작업 확인」 dialog for the page confirm, 「이 앱의 연결 정보 지우기」',
    'AiTerminalService PTY behind createAiTerminalRemoteGateway (consent check, start, input, read)',
  ],
  standIn: [
    'fake CLI (REMOTE_READY / RESULT:<line>) instead of an AI agent',
    'fixture registered projects A/B with a recording gateway (A start/stop recorded, nothing runs; B has no actions)',
    'scripted Mac consent through the journey control folder (scriptedApproval receipt)',
    'socket drop during the background forced by a scripted listener restart (phase backgrounded) — a 3-second simulator background does not drop the socket by itself, so iOS suspending networking is not what is exercised',
    'host-side transport tap around the listener\'s own Bun.serve handlers (page loads, pair/restore/end frames by type, close codes; no tokens) for the refused-pair and restore receipts',
    'URL typed into 「연결 주소」 instead of a camera QR scan',
    'terminal output read on the phone by Vision OCR of screenshots (xterm rows are hidden from accessibility), plus the host read receipt',
    'owned disposable headless simulator instead of an iPhone',
  ],
}) as PathLabels;

/** Why this Mac cannot run the journey, from preflight (empty: it can). A blocked lane, never a pass. */
export function lanJourneyPreconditions(preflight: Pick<PreflightReport, 'capabilities'>): string[] {
  const reasons: string[] = [];
  if (!preflight.capabilities?.en0PrivateIpv4) reasons.push('no private IPv4 address on en0: the LAN host has nothing to bind (no public or wildcard fallback)');
  const firewall = firewallBlockReason(preflight.capabilities?.firewall ?? null);
  if (firewall) reasons.push(`${firewall} (blocked, not answered — design §2.6)`);
  return reasons;
}

/** supervisor.json → the port the sandboxed host listened on (its `listening` attempt), once the supervisor saw it ready. */
export function supervisorReadyPort(text: string): number | null {
  try {
    const record = JSON.parse(text) as {portAttempts?: unknown};
    const attempts = Array.isArray(record.portAttempts) ? record.portAttempts as Array<{port?: unknown; outcome?: unknown}> : [];
    const port = attempts.find(attempt => attempt?.outcome === 'listening')?.port;
    return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : null;
  } catch { return null; }
}

/**
 * The listeners check-ui.py's tree opened, judged against the one host port (null: the host never became ready, so
 * nothing of the run may listen off loopback at all).
 */
export function lanListenerProblemsFor(seen: ReadonlyArray<{address: string; port: number}>, address: string, port: number | null, journeyPassed: boolean): string[] {
  if (port !== null) return listenerProblems(seen, {address, port}, journeyPassed);
  return seen.filter(entry => !isLoopbackListenAddress(entry.address)).map(entry => `LAN listener: ${entry.address}:${entry.port} although the journey host never became ready`);
}

export interface CheckUiRun {
  exitCode: number | null;
  timedOut: boolean;
  result: Record<string, any> | null;
  summary: Record<string, any> | null;
}

/** check-ui.py's result → the phone-side verdict. Missing or unfinished means fail, never pass. */
export function laneOutcomeFromCheckUi(run: CheckUiRun): Pick<LaneOutcome, 'status' | 'reason'> {
  if (run.timedOut) return {status: 'fail', reason: `check-ui.py did not finish within ${J1_LAN_TIMEOUT_MS / 60_000} min`};
  const result = run.result;
  if (run.exitCode === BLOCKED_EXIT || result?.state === 'blocked') {
    return {status: 'blocked', reason: typeof result?.reason === 'string' && result.reason ? result.reason : `check-ui.py exited ${run.exitCode} (blocked)`};
  }
  if (!result) return {status: 'fail', reason: `check-ui.py left no result.json (exit ${run.exitCode})`};
  if (result.state !== 'passed' || run.exitCode !== 0) {
    const problems = Array.isArray(result.problems) && result.problems.length ? result.problems.join('; ') : `state ${String(result.state)}`;
    return {status: 'fail', reason: `check-ui.py exit ${run.exitCode}: ${problems}`};
  }
  const problems: string[] = [];
  const expected = result.expected as {passed?: number; skipped?: number; tests?: Record<string, string> | null} | undefined;
  if (!expected || expected.tests == null) problems.push('result.json has no expected per-test outcomes');
  else {
    if (expected.tests[J1_LAN_TEST] !== 'passed') problems.push(`the plan does not expect ${J1_LAN_TEST} to pass on a simulator`);
    const tests = (result.tests ?? {}) as Record<string, string>;
    if (JSON.stringify(Object.entries(tests).sort()) !== JSON.stringify(Object.entries(expected.tests).sort())) {
      problems.push(`per-test outcomes ${JSON.stringify(tests)} ≠ ${JSON.stringify(expected.tests)}`);
    }
  }
  const summary = run.summary;
  if (!summary) problems.push('no summary.json');
  else if (summary.failedTests !== 0 || summary.passedTests !== expected?.passed || summary.skippedTests !== expected?.skipped) {
    problems.push(`summary passed ${summary.passedTests} / skipped ${summary.skippedTests} / failed ${summary.failedTests} ≠ ${expected?.passed} / ${expected?.skipped} / 0`);
  }
  if (result.lanJourney !== true) problems.push('check-ui.py did not run the same-network journey');
  if (!result.lanJourneyVerdict?.ok) problems.push('the journey host verdict is not ok');
  if (!Array.isArray(result.consumedFixtureToken?.files) || !result.consumedFixtureToken.files.includes('UI.xcresult')) {
    problems.push('the xcresult is not marked as holding the consumed fixture token');
  }
  return problems.length ? {status: 'fail', reason: problems.join('; ')} : {status: 'pass'};
}

/** The device branch of the same table, from `--plan` (nothing runs, no device is touched). */
export function devicePlanProblems(plan: Record<string, any> | null): string[] {
  if (!plan) return ['check-ui.py --device … --plan printed no JSON'];
  const problems: string[] = [];
  if (plan.lanJourney !== false) problems.push('a device plan would start the same-network journey host');
  if (plan.expected?.tests?.[J1_LAN_TEST] !== 'skipped') problems.push(`a device plan does not skip ${J1_LAN_TEST}`);
  if (typeof plan.expected?.passed !== 'number' || plan.expected.passed + plan.expected.skipped !== Object.keys(plan.expected.tests ?? {}).length) {
    problems.push('the device plan counts do not add up to its tests');
  }
  if (JSON.stringify(plan.commands ?? []).includes('lan-journey-host')) problems.push('the device plan names the journey host');
  return problems;
}

function readText(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function readJson(path: string): Record<string, any> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

const redactPair = (text: string) => text.replace(/#pair=[^\s"'&]+/g, '#pair=<redacted>');

async function runCheckUi(argv: string[], options: {cwd: string; env: Record<string, string>; onSpawn: (pid: number) => void}): Promise<{exitCode: number | null; output: string; timedOut: boolean}> {
  const child = Bun.spawn(argv, {cwd: options.cwd, env: options.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
  options.onSpawn(child.pid);
  let timedOut = false;
  // SIGINT, not SIGTERM: Python turns it into KeyboardInterrupt and runs check-ui's cleanup (host, simulator).
  const interrupt = setTimeout(() => { timedOut = true; try { child.kill('SIGINT'); } catch {} }, J1_LAN_TIMEOUT_MS);
  const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, J1_LAN_TIMEOUT_MS + J1_LAN_STOP_GRACE_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return {exitCode, output: `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`, timedOut};
  } finally {
    clearTimeout(interrupt);
    clearTimeout(kill);
  }
}

/** `bun` and `node` for check-ui (the portal build runs vite) without putting the person's tool folders on PATH. */
function toolBin(scratchRoot: string, inheritedPath: string | undefined): {dir: string; node: string} {
  const dir = join(scratchRoot, 'j1-lan-bin');
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

/** The first run-* folder's supervisor.json under the lane's evidence root, if the supervisor has written one. */
function readSupervisorRecord(evidenceRoot: string): string {
  try {
    for (const name of readdirSync(evidenceRoot)) {
      if (!name.startsWith('run-')) continue;
      const text = readText(join(evidenceRoot, name, 'lan-journey', 'supervisor.json'));
      if (text) return text;
    }
  } catch {}
  return '';
}

export const lane: LaneDefinition = {
  id: 'j1-lan',
  title: 'J1-LAN-APP — real app LAN journey (simulator XCUITest test20 + sandboxed LAN host)',
  preconditions: preflight => lanJourneyPreconditions(preflight),
  async run(ctx: LaneContext): Promise<LaneOutcome> {
    const quiet = await ctx.waitForQuietSimulatorChecks(120_000);
    if (quiet.status !== 'clear') return {status: 'blocked', reason: `another simulator check is running: ${quiet.seen.map(row => row.command).join(' | ').slice(0, 300)}`};
    const lock = await ctx.acquireSimulatorBootLock(10 * 60_000);
    if (lock.status !== 'acquired') return {status: 'blocked', reason: lock.reason};

    const address = ctx.preflight.capabilities!.en0PrivateIpv4!;
    const evidenceRoot = ctx.evidence.path(J1_LAN_EVIDENCE);
    mkdirSync(evidenceRoot, {recursive: true, mode: 0o700});
    // The harness's own LAN binding guard is armed on the port the supervisor reports ready (it picks the port right
    // before the host binds it; the supervisor holds its own guard from before the bind).
    let armed: {port: number; profile: WrittenSandboxProfile} | null = null;
    let armError: string | null = null;
    const armGuard = () => {
      if (armed || armError) return;
      const port = supervisorReadyPort(readSupervisorRecord(evidenceRoot));
      if (port === null) return;
      try {
        const profile = ctx.sandboxProfile('j1-lan-host', {lanInbound: {port}});
        ctx.evidence.writeText('sandbox/j1-lan-host.sb', readText(profile.path));
        armed = {port, profile};
        ctx.log(`j1-lan: harness LAN binding guard armed on ${address}:${port} (profile ${profile.sha256.slice(0, 12)})`);
      } catch (error) { armError = String((error as Error)?.message ?? error).slice(0, 300); }
    };

    const toolchain = ctx.toolchainEnv();
    const tools = toolBin(ctx.scratchRoot, process.env.PATH);
    const env = {...toolchain, PATH: `${tools.dir}:${toolchain.PATH}`};
    const script = join(ctx.repoRoot, J1_LAN_SCRIPT);

    // The device branch of the count table, without a device: --plan runs nothing.
    const planOut = Bun.spawnSync(['/usr/bin/python3', '-I', script, '--device', '00000000-0000000000000000', '--plan'], {cwd: ctx.repoRoot, env, stdout: 'pipe', stderr: 'pipe'});
    let devicePlan: Record<string, any> | null = null;
    try { devicePlan = JSON.parse(planOut.stdout.toString()); } catch {}
    const simulatorPlanOut = Bun.spawnSync(['/usr/bin/python3', '-I', script, '--plan'], {cwd: ctx.repoRoot, env, stdout: 'pipe', stderr: 'pipe'});
    let simulatorPlan: Record<string, any> | null = null;
    try { simulatorPlan = JSON.parse(simulatorPlanOut.stdout.toString()); } catch {}
    ctx.evidence.writeJson(`${J1_LAN_EVIDENCE}/plans.json`, {device: devicePlan, simulator: simulatorPlan});

    // --require-lan-journey: a Mac that cannot run the journey (no en0, firewall) exits 78 before the build — blocked.
    const argv = ['/usr/bin/python3', '-I', script, '--evidence-root', evidenceRoot, '--lan-address', address, '--require-lan-journey'];
    ctx.log(`j1-lan: python3 ${J1_LAN_SCRIPT} (LAN host on ${address}, port chosen by the supervisor right before it binds)`);
    const watches: Array<{stop(): ListenerWatch}> = [];
    let listeners: ListenerWatch = {samples: 0, seen: []};
    let run: Awaited<ReturnType<typeof runCheckUi>>;
    const arming = setInterval(armGuard, 500);
    try {
      run = await runCheckUi(argv, {cwd: ctx.repoRoot, env, onSpawn: pid => { watches.push(watchListeners(pid)); }});
    } finally {
      clearInterval(arming);
      for (const watch of watches) listeners = watch.stop();
    }
    armGuard();
    const log = ctx.evidence.writeText(`${J1_LAN_EVIDENCE}.log`, redactPair(run.output));

    const runDirs = readdirSync(evidenceRoot).filter(name => name.startsWith('run-')).map(name => join(evidenceRoot, name));
    const runDir = runDirs.length === 1 ? runDirs[0]! : null;
    const result = runDir ? readJson(join(runDir, 'result.json')) : null;
    const summary = runDir ? readJson(join(runDir, 'summary.json')) : null;
    const hostDir = runDir ? join(runDir, 'lan-journey') : null;
    const hostVerdict = hostDir ? readJson(join(hostDir, VERDICT_FILE)) : null;
    const receiptsText = hostDir ? readText(join(hostDir, RECEIPTS_FILE)) : '';
    const parsed = parseReceipts(receiptsText);
    const receipts = evaluateJourneyReceipts(parsed.receipts, receiptsText);

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
    } else if (run.exitCode !== BLOCKED_EXIT) problems.push('result.json names no owned simulator');

    const phone = laneOutcomeFromCheckUi({exitCode: run.exitCode, timedOut: run.timedOut, result, summary});
    if (runDirs.length !== 1) problems.push(`expected one check-ui run folder, found ${runDirs.length}`);
    if (phone.status === 'pass' || phone.status === 'fail') {
      if (!receipts.ok) problems.push(...receipts.problems.map(problem => `host receipts: ${problem}`));
      if (parsed.malformed) problems.push(`${parsed.malformed} malformed host receipt line(s)`);
      if (hostVerdict?.ok !== true) problems.push('host-verdict.json is not ok');
      if (!receiptsText.includes('"deliveredResult":true')) problems.push(`no host receipt that a read delivered ${JOURNEY_RESULT}`);
    }
    problems.push(...devicePlanProblems(devicePlan));
    if (simulatorPlan?.expected?.tests?.[J1_LAN_TEST] !== 'passed' || simulatorPlan?.lanJourney !== true) problems.push('the simulator plan does not run the same-network journey');

    const scanned = [
      {name: 'check-ui stdout/stderr', text: run.output},
      ...(runDir ? ['result.json', 'summary.json', 'lan-journey-supervisor.log', 'boot.log', 'build.log', 'portal-build.log', 'attachments.log']
        .map(name => ({name, text: readText(join(runDir, name))})) : []),
      ...(hostDir ? [RECEIPTS_FILE, VERDICT_FILE, 'host.log', 'host.stderr.log', 'supervisor.json', 'host-summary.json', 'host.sb']
        .map(name => ({name: `lan-journey/${name}`, text: readText(join(hostDir, name))})) : []),
    ];
    const leaks = findPairTokenLeaks(scanned);
    if (leaks.length) problems.push(`#pair= token in ${leaks.join(', ')}`);
    const journeyPassed = phone.status === 'pass';
    const armedNow = armed as {port: number; profile: WrittenSandboxProfile} | null;
    const resultPort = typeof result?.lanJourneyHost?.port === 'number' ? result.lanJourneyHost.port as number : null;
    const finalPort = resultPort ?? armedNow?.port ?? null;
    const lanProblems = lanListenerProblemsFor(listeners.seen, address, finalPort, journeyPassed);
    if (armError) lanProblems.push(`the harness LAN binding guard could not be armed: ${armError}`);
    if (resultPort !== null && !armedNow) lanProblems.push(`the host listened on ${address}:${resultPort} but the harness LAN binding guard was never armed`);
    if (resultPort !== null && armedNow && armedNow.port !== resultPort) lanProblems.push(`the harness guard was armed on port ${armedNow.port}, the host reports ${resultPort}`);
    problems.push(...lanProblems);

    // Blocked stays blocked only when nothing else went wrong; any other problem makes it a failure, never a pass.
    const outcome: Pick<LaneOutcome, 'status' | 'reason'> = problems.length
      ? {status: 'fail', reason: [...problems, ...(phone.reason ? [phone.reason] : [])].join('; ').slice(0, 4_000)}
      : phone;

    let screenshots: string[] = [];
    if (runDir) {
      const manifest = readJson(join(runDir, 'attachments', 'manifest.json')) as unknown;
      if (Array.isArray(manifest)) {
        screenshots = manifest.flatMap((test: any) => (test?.attachments ?? []) as any[])
          .filter(attachment => typeof attachment?.suggestedHumanReadableName === 'string' && /^lan-/.test(attachment.suggestedHumanReadableName))
          .map(attachment => `${attachment.suggestedHumanReadableName} → attachments/${attachment.exportedFileName}`);
      }
    }
    const artifacts = [log, ...(runDir ? ['result.json', 'summary.json', 'lan-journey/host-verdict.json', `lan-journey/${RECEIPTS_FILE}`, 'lan-journey/host.sb', 'attachments/manifest.json']
      .map(name => join(runDir, name)).filter(existsSync) : [])].map(path => ctx.evidence.relative(path));
    return {
      ...outcome,
      labels: J1_LAN_LABELS,
      artifacts,
      details: {
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        lan: {address, port: finalPort, guardProfileSha256: armedNow?.profile.sha256 ?? null, hostProfileSha256: result?.lanJourneyHost?.profileSha256 ?? null,
          portAttempts: hostVerdict?.portAttempts ?? null, samples: listeners.samples, seen: listeners.seen,
          ports: finalPort !== null ? [finalPort] : null, problems: lanProblems},
        phone: result ? {state: result.state, expected: result.expected, tests: result.tests ?? null, passed: result.passed ?? null,
          skipped: result.skipped ?? null, failed: result.failed ?? null, runtime: result.runtime ?? null, simulator: result.simulator ?? null,
          gitHead: result.gitHead ?? null, consumedFixtureToken: result.consumedFixtureToken ?? null} : null,
        summary: summary ? {result: summary.result, passedTests: summary.passedTests, skippedTests: summary.skippedTests, failedTests: summary.failedTests,
          totalTestCount: summary.totalTestCount} : null,
        host: {verdictOk: hostVerdict?.ok ?? null, counts: receipts.counts, problems: receipts.problems.slice(0, 20), childExit: hostVerdict?.childExit ?? null,
          guardViolations: hostVerdict?.guard?.violations ?? null},
        devicePlan: devicePlan ? {expected: devicePlan.expected, lanJourney: devicePlan.lanJourney} : null,
        simulatorPlan: simulatorPlan ? {expected: simulatorPlan.expected, lanJourney: simulatorPlan.lanJourney} : null,
        ownedSimulator: udid ? {udid, swept: sweptSimulator} : null,
        screenshots,
        pairTokenLeaks: leaks,
        sources: Object.fromEntries(['scripts/emulator-e2e/lanJourney.ts', 'mobile/ios/scripts/lan-journey-host.ts', J1_LAN_SCRIPT, 'mobile/ios/UITests/WorkspaceUITests.swift']
          .map(file => [file, existsSync(join(ctx.repoRoot, file)) ? sha256File(join(ctx.repoRoot, file)) : null])),
        nodeForPortalBuild: tools.node === process.execPath ? 'bun (no node found)' : 'node from the orchestrator PATH (symlinked alone)',
      },
    };
  },
};
