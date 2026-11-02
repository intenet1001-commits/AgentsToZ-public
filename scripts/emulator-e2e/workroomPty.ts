/**
 * J1-LAN-PTY (WP3, opt-in): check-workroom.ts's simulator journey under WP1's sandbox with LAN inbound.
 *
 * Who runs where:
 * - This module runs in the orchestrator, unsandboxed, and imports no host code (src/). It holds the simulator boot
 *   lock, writes the lane's sandbox profile, builds the allowlisted environment, sweeps owned simulators that an
 *   earlier killed run left behind, and turns check-workroom's run-status.json into the lane verdict.
 * - `sandbox-exec -f <j1-pty profile> bun mobile/ios/scripts/check-workroom.ts --evidence-dir <run>/j1-pty
 *   --lan-address <en0> --lan-ports <server>,<foreign>,<redirect>` compiles the probe, creates and boots an owned
 *   simulator in its scratch device set, and runs the real LAN server, PTY and Python tester there. check-workroom
 *   refuses to start unless the OS confirms that sandbox (design §2.3).
 *
 * The profile is WP1's host profile plus LAN inbound declared on exactly three ports the lane picks: writes only to the
 * run scratch and this run's evidence folder, no outbound but the (empty) loopback allowlist, signals only within the
 * sandbox. The journey needs three origins on the en0 address — the pairing server, a foreign origin that a navigation
 * must never reach, and a QR origin that redirects there — so it gets three declared ports, not one.
 * The listener check below is what actually holds the binding, not the profile: SBPL cannot name the en0 address, and
 * on this Mac (Darwin 25.5, measured 2026-11-01) WP1's `(allow network-bind|network-inbound (local ip "localhost:*"))`
 * also matched the en0 address — under the host profile, with or without LAN inbound, a sandboxed child bound
 * <en0>:<any port> and an unsandboxed client on the Mac reached it; without those two lines both en0 and loopback binds
 * were refused. So while the script runs the lane samples its process tree with lsof and fails the run if anything
 * listens off loopback other than <en0>:<those ports> (lanListenerViolations), or if a pass never showed all three.
 * The probe app in the simulator is outside the sandbox and reaches the host over the LAN address.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {LaneContext, LaneDefinition} from '../emulator-e2e';
import {RESERVED_LOOPBACK_PORTS} from './environment';
import {evidenceRoot, findPairTokenLeaks, type LaneOutcome, type PathLabels} from './evidence';
import {listProcesses, type ProcessRow} from './preflight';
import {lanInboundPorts, lanListenerViolations, listeningSockets, sandboxedArgv, type LanInbound} from './sandbox';
import {
  BLOCKED_EXIT, findWorkroomDeviceSets, leftoverDeviceSet, readRunStatus, sweepDeviceSet, type DeviceSetSweep,
} from '../../mobile/ios/scripts/checkWorkroomSupport';

export const J1_PTY_SCRIPT = 'mobile/ios/scripts/check-workroom.ts';
/** check-workroom measured 100 s (compile 14, boot 37, journey 30); its own step limits add up to well under this. */
export const J1_PTY_TIMEOUT_MS = 20 * 60_000;
/** After SIGTERM: the script's own cleanup (simctl shutdown and delete, 30 s each, then the listeners). */
export const J1_PTY_STOP_GRACE_MS = 90_000;
export const J1_PTY_EVIDENCE = 'j1-pty';

export const J1_PTY_LABELS: PathLabels = Object.freeze({
  real: [
    'shipped LANWorkroomView in a WKWebView on an owned iOS simulator',
    'shipped Mac LAN page (HTML, JS, CSP) and WebSocket from RemoteControlLanServer on the en0 private IPv4',
    'AiTerminalService PTY, remote gateway and mobile workspace gateway',
    'TesterAgentHost running the real maintainer runner (Python) on a fixture project',
  ],
  standIn: [
    'probe app (WorkroomProbe.swift) instead of the AgentsToZMobile app target',
    'fake CLI instead of an AI agent',
    'fixture registered projects A/B with project mutation refused',
    'scripted consent and revocation from the host (scriptedApproval)',
  ],
}) as PathLabels;

/** check-workroom's verdict file → the lane verdict. Missing or unfinished means fail, never pass. */
export function laneOutcomeFromRunStatus(status: Record<string, any> | null, exitCode: number | null, timedOut: boolean): Pick<LaneOutcome, 'status' | 'reason'> {
  if (timedOut) return {status: 'fail', reason: `check-workroom did not finish within ${J1_PTY_TIMEOUT_MS / 1000} s`};
  if (!status) return {status: 'fail', reason: `check-workroom left no run-status.json (exit ${exitCode})`};
  const reason = typeof status.reason === 'string' && status.reason.trim() ? status.reason : undefined;
  if (status.state === 'passed' && exitCode === 0) return {status: 'pass'};
  if (status.state === 'blocked' || exitCode === BLOCKED_EXIT) return {status: 'blocked', reason: reason ?? `check-workroom exited ${exitCode} (blocked)`};
  return {status: 'fail', reason: reason ?? `check-workroom ended ${String(status.state)} with exit ${exitCode}`};
}

/** Owned device sets that earlier j1-pty runs in this worktree recorded and never saw deleted (their owner killed). */
export function earlierLeftovers(repoRoot: string, currentRunId: string, realHome: string): string[] {
  const root = evidenceRoot(repoRoot);
  const statuses: string[] = [join(repoRoot, 'mobile/ios/build/workroom-evidence')];
  try {
    for (const runId of readdirSync(root).sort()) if (runId !== currentRunId) statuses.push(join(root, runId, J1_PTY_EVIDENCE));
  } catch {}
  const sets = new Set<string>();
  for (const dir of statuses) {
    const set = leftoverDeviceSet(readRunStatus(dir), {realHome});
    if (set) sets.add(set);
  }
  return [...sets];
}

/**
 * Distinct free TCP ports for the journey's LAN listeners. The loopback probes are held open together (so the ports
 * differ) and released before the sandboxed script binds the same numbers on the en0 address — the orchestrator never
 * opens a LAN listener itself. Reserved ports (installed sidecar, real Screen, Appium) and ports below 1024 are skipped.
 */
export function reserveLanPorts(count = 3): number[] {
  const probes: Array<ReturnType<typeof Bun.serve>> = [];
  try {
    for (let attempt = 0; probes.length < count && attempt < count + 20; attempt++) {
      const probe = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('')});
      const port = probe.port ?? 0;
      if (port >= 1024 && !(RESERVED_LOOPBACK_PORTS as readonly number[]).includes(port) && !probes.some(other => other.port === port)) probes.push(probe);
      else probe.stop(true);
    }
    if (probes.length < count) throw new Error(`could not reserve ${count} free ports for the LAN listeners`);
    return probes.map(probe => probe.port!);
  } finally {
    for (const probe of probes) probe.stop(true);
  }
}

/** `root` and every process under it (ps rows). */
export function processTree(rows: readonly ProcessRow[], root: number): number[] {
  const tree = new Set<number>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (tree.has(row.ppid) && !tree.has(row.pid)) { tree.add(row.pid); grew = true; }
    }
  }
  return [...tree];
}

export interface ListenerWatch {samples: number; seen: Array<{address: string; port: number}>}

/**
 * Samples the TCP listeners of `rootPid`'s process tree (ps + lsof) every `intervalMs` until `stop()`, and returns
 * every distinct one seen. check-workroom opens its listeners in its isolated child, so the whole tree is watched.
 */
export function watchListeners(rootPid: number, intervalMs = 1_000, sample: (pids: number[]) => Array<{address: string; port: number}> = listeningSockets): {stop(): ListenerWatch} {
  const seen = new Map<string, {address: string; port: number}>();
  let samples = 0;
  const tick = () => {
    try {
      for (const entry of sample(processTree(listProcesses('comm'), rootPid))) seen.set(`${entry.address}:${entry.port}`, entry);
      samples += 1;
    } catch {}
  };
  const timer = setInterval(tick, intervalMs);
  return {stop: () => { clearInterval(timer); tick(); return {samples, seen: [...seen.values()]}; }};
}

/**
 * What the observed listeners say about the run. Anything off loopback other than <en0>:<declared ports> fails it
 * whatever the journey said. A missing declared listener fails only a passing journey: a run that stopped before its
 * listeners opened has failed already, and its own reason stays the one to read.
 */
export function listenerProblems(seen: ReadonlyArray<{address: string; port: number}>, expected: {address: string} & LanInbound, journeyPassed: boolean): string[] {
  const missing = new Set(lanInboundPorts(expected).map(port => `does not listen on ${expected.address}:${port}`));
  return lanListenerViolations(seen, expected).filter(problem => journeyPassed || !missing.has(problem)).map(problem => `LAN listener: ${problem}`);
}

function simctlRunner(env: Record<string, string>) {
  return (args: string[]) => {
    const result = Bun.spawnSync(args, {env, stdout: 'pipe', stderr: 'ignore'});
    return {exitCode: result.exitCode ?? 1, stdout: result.stdout.toString()};
  };
}

const redactPair = (text: string) => text.replace(/#pair=[^\s"'&]+/g, '#pair=<redacted>');

async function runSandboxed(argv: string[], options: {cwd: string; env: Record<string, string>; onSpawn?: (pid: number) => void}): Promise<{exitCode: number | null; output: string; timedOut: boolean}> {
  const child = Bun.spawn(argv, {cwd: options.cwd, env: options.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
  // sandbox-exec execs, so this pid is the sandboxed script itself.
  options.onSpawn?.(child.pid);
  let timedOut = false;
  const term = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} }, J1_PTY_TIMEOUT_MS);
  const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, J1_PTY_TIMEOUT_MS + J1_PTY_STOP_GRACE_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return {exitCode, output: `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`, timedOut};
  } finally {
    clearTimeout(term);
    clearTimeout(kill);
  }
}

function readText(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

export const lane: LaneDefinition = {
  id: 'j1-pty',
  title: 'J1-LAN-PTY — check-workroom simulator mode (sandboxed, LAN inbound)',
  preconditions: preflight => preflight.capabilities?.en0PrivateIpv4
    ? []
    : ['no private IPv4 address on en0: the LAN host has nothing to bind (no public or wildcard fallback)'],
  async run(ctx: LaneContext): Promise<LaneOutcome> {
    const toolchain = ctx.toolchainEnv();
    const sweptEarlier: DeviceSetSweep[] = earlierLeftovers(ctx.repoRoot, ctx.runId, ctx.home)
      .map(set => sweepDeviceSet(set, ctx.home, simctlRunner(toolchain)));
    if (sweptEarlier.length) ctx.log(`j1-pty: swept ${sweptEarlier.length} owned simulator set(s) an earlier killed run left behind`);
    const quiet = await ctx.waitForQuietSimulatorChecks(120_000);
    if (quiet.status !== 'clear') return {status: 'blocked', reason: `another simulator check is running: ${quiet.seen.map(row => row.command).join(' | ').slice(0, 300)}`, details: {sweptEarlier}};
    const lock = await ctx.acquireSimulatorBootLock(10 * 60_000);
    if (lock.status !== 'acquired') return {status: 'blocked', reason: lock.reason, details: {sweptEarlier}};

    const profile = ctx.isolatedProfile('j1-pty');
    const env = ctx.allowlistedEnv({profile});
    // The preconditions guarantee the en0 address. Three origins on it: the pairing server, the foreign origin and the
    // redirect QR's origin. The profile declares these ports; the lsof check below holds them (see the header).
    const address = ctx.preflight.capabilities!.en0PrivateIpv4!;
    const [serverPort, foreignPort, redirectPort] = reserveLanPorts(3) as [number, number, number];
    const lanInbound: LanInbound = {port: serverPort, extraPorts: [foreignPort, redirectPort]};
    const sandbox = ctx.sandboxProfile('j1-pty-lan', {lanInbound});
    ctx.evidence.writeText('sandbox/j1-pty-lan.sb', readText(sandbox.path));
    const evidenceDir = ctx.evidence.path(J1_PTY_EVIDENCE);
    const argv = sandboxedArgv(sandbox, [process.execPath, join(ctx.repoRoot, J1_PTY_SCRIPT), '--evidence-dir', evidenceDir,
      '--lan-address', address, '--lan-ports', `${serverPort},${foreignPort},${redirectPort}`]);
    ctx.log(`j1-pty: sandbox-exec (LAN inbound on ${lanInboundPorts(lanInbound).join(', ')}, profile ${sandbox.sha256.slice(0, 12)}) bun ${J1_PTY_SCRIPT}`);
    const watches: Array<{stop(): ListenerWatch}> = [];
    let listeners: ListenerWatch = {samples: 0, seen: []};
    let run: Awaited<ReturnType<typeof runSandboxed>>;
    try {
      run = await runSandboxed(argv, {cwd: ctx.repoRoot, env, onSpawn: pid => { watches.push(watchListeners(pid)); }});
    } finally {
      // The final sample runs after the script exited; whatever it saw while running is kept.
      for (const watch of watches) listeners = watch.stop();
    }

    // The script deletes its simulator itself; this catches a kill before that (and checks it really happened).
    const sweptAfter = findWorkroomDeviceSets(profile.root, ctx.home).map(set => sweepDeviceSet(set, ctx.home, simctlRunner(toolchain)));
    const status = readRunStatus(evidenceDir);
    const recorded = leftoverDeviceSet(status, {realHome: ctx.home});
    if (recorded && !sweptAfter.some(entry => entry.deviceSet === recorded)) sweptAfter.push(sweepDeviceSet(recorded, ctx.home, simctlRunner(toolchain)));
    const owned = status?.ownedSimulator;
    if (owned && typeof owned.udid === 'string') ctx.ownSimulator(owned.udid, typeof owned.runtime === 'string' ? owned.runtime : undefined);

    const log = ctx.evidence.writeText('j1-pty.log', redactPair(run.output));
    const leaks = findPairTokenLeaks([
      {name: 'stdout/stderr', text: run.output},
      ...['run-status.json', 'result.json'].map(name => ({name: `${J1_PTY_EVIDENCE}/${name}`, text: readText(join(evidenceDir, name))})),
    ]);
    const leftBehind = sweptAfter.filter(entry => entry.remaining !== 0 || existsSync(entry.deviceSet));
    const verdict = laneOutcomeFromRunStatus(status, run.exitCode, run.timedOut);
    const lanProblems = listenerProblems(listeners.seen, {address, ...lanInbound}, verdict.status === 'pass');
    const problems = [
      ...lanProblems,
      ...(leaks.length ? [`#pair= token in ${leaks.join(', ')}`] : []),
      ...(sweptAfter.length ? [`owned simulator set left after the run (swept: ${sweptAfter.map(entry => `remaining ${entry.remaining}`).join(', ')})`] : []),
      ...(leftBehind.length ? ['an owned simulator set could not be removed'] : []),
    ];
    const outcome: Pick<LaneOutcome, 'status' | 'reason'> = problems.length
      ? {status: 'fail', reason: [...problems, ...(verdict.reason ? [verdict.reason] : [])].join('; ')}
      : verdict;
    let result: Record<string, any> | null = null;
    try { result = JSON.parse(readText(join(evidenceDir, 'result.json'))); } catch {}
    return {
      ...outcome,
      labels: J1_PTY_LABELS,
      artifacts: [log, ...['run-status.json', 'result.json', 'workroom.png', 'resumed.png', 'failure.png'].map(name => join(evidenceDir, name)).filter(existsSync)]
        .map(path => ctx.evidence.relative(path)),
      details: {
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        sandbox: {profileSha256: sandbox.sha256, lanInbound: sandbox.lanInbound, deniedPorts: sandbox.deniedPorts, allowedLoopbackPorts: sandbox.allowedLoopbackPorts, seenByScript: status?.sandbox ?? null},
        lanListeners: {address, ports: lanInboundPorts(lanInbound), samples: listeners.samples, seen: listeners.seen, problems: lanProblems},
        runStatus: status ? {state: status.state, stage: status.stage, seconds: status.seconds, ownedSimulator: status.ownedSimulator ?? null,
          preexistingSimulators: status.preexistingSimulators ?? null, simulatorApp: status.simulatorApp ?? null, isolation: status.isolation ?? null} : null,
        probeChecks: Array.isArray(result?.checks) ? result!.checks.length : null,
        foreignRequests: result?.foreignRequests ?? null,
        projectMutationAttempts: result?.projectMutationAttempts ?? null,
        sweptEarlier,
        sweptAfter,
        pairTokenLeaks: leaks,
      },
    };
  },
};
