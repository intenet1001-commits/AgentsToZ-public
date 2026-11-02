/** Simulator-only controller invitation rejection; never presses registration or creates keys. */
import {existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import type {LaneContext, LaneDefinition} from '../emulator-e2e';
import type {LaneOutcome, PathLabels} from './evidence';
import {watchListeners} from './workroomPty';

const labels: PathLabels = {
  real: ['The shipped iOS app handles a synthetic Mac-controller invitation and displays its device-registration rejection in an owned simulator.'],
  standIn: ['A deterministic synthetic invitation replaces a camera-scanned QR; no registration action or key is created.',
    'Device registration before key/App Attest and ScreenViewerModel remain blocked by the no-keychain-change safety rule.',
    'The controller invitation uses a synthetic nearby name and proves no listener connection count.'],
};
const name = 'test30MacControllerInviteIsRejectedByDeviceRegistration';
function json(path: string): Record<string, any> | null { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function simulatorExists(udid: string, env: Record<string, string>): boolean | null {
  const p = Bun.spawnSync(['/usr/bin/xcrun', 'simctl', 'list', 'devices', '--json'], {env, stdout: 'pipe', stderr: 'ignore'});
  if (p.exitCode !== 0) return null;
  try { return Object.values((JSON.parse(p.stdout.toString()) as {devices: Record<string, Array<{udid: string}>>}).devices).flat().some(d => d.udid === udid); } catch { return null; }
}
export const lane: LaneDefinition = {
  id: 'j2-boundary', title: 'J2-APP-BOUNDARY — controller invitation rejection',
  async run(ctx: LaneContext): Promise<LaneOutcome> {
    const quiet = await ctx.waitForQuietSimulatorChecks(120_000);
    if (quiet.status !== 'clear') return {status: 'blocked', reason: 'another simulator check is running', labels};
    const lock = await ctx.acquireSimulatorBootLock(600_000);
    if (lock.status !== 'acquired') return {status: 'blocked', reason: lock.reason, labels};
    const root = ctx.evidence.path('j2-boundary'); mkdirSync(root, {recursive: true, mode: 0o700});
    const env = ctx.toolchainEnv(); const bin = join(ctx.scratchRoot, 'j2-boundary-bin'); mkdirSync(bin, {recursive: true, mode: 0o700});
    symlinkSync(process.execPath, join(bin, 'bun'));
    symlinkSync(Bun.which('node', {PATH: process.env.PATH ?? ''}) ?? process.execPath, join(bin, 'node'));
    env.PATH = `${bin}:${env.PATH}`;
    const script = join(ctx.repoRoot, 'mobile/ios/scripts/check-ui.py');
    const child = Bun.spawn(['/usr/bin/python3', '-I', script, '--boundary-only', '--evidence-root', root],
      {cwd: ctx.repoRoot, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
    const watch = watchListeners(child.pid); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGINT'); } catch {} }, 30 * 60_000);
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 34 * 60_000);
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer); clearTimeout(hard); const listeners = watch.stop();
    const log = ctx.evidence.writeText('j2-boundary.log', `${stdout}\n${stderr}`);
    const dirs = readdirSync(root).filter(x => x.startsWith('run-')); const dir = dirs.length === 1 ? join(root, dirs[0]!) : null;
    const result = dir ? json(join(dir, 'result.json')) : null; const summary = dir ? json(join(dir, 'summary.json')) : null;
    const problems: string[] = [];
    if (timedOut || code !== 0 || result?.state !== 'passed') problems.push(`check-ui exit ${code}, state ${String(result?.state)}, timedOut ${timedOut}`);
    if (result?.tests?.[name] !== 'passed' || summary?.passedTests !== 1 || summary?.skippedTests !== 0 || summary?.failedTests !== 0) problems.push('the controller invitation test did not pass exactly once');
    const udid = typeof result?.simulatorUdid === 'string' ? result.simulatorUdid : null;
    if (!udid) problems.push('no owned simulator was recorded');
    else {
      ctx.ownSimulator(udid, result?.simulatorRuntime);
      const exists = simulatorExists(udid, env);
      if (exists !== false) {
        if (exists === true) for (const action of ['shutdown', 'delete']) Bun.spawnSync(['/usr/bin/xcrun', 'simctl', action, udid], {env, stdout: 'ignore', stderr: 'ignore'});
        problems.push(`owned simulator not confirmed removed (present=${String(exists)})`);
      }
    }
    // No test listener is needed by this synthetic URL. Any non-loopback listener or reserved port is a failure.
    const invalid = listeners.seen.filter(x => x.address !== '127.0.0.1' || [3001, 52741, 4723].includes(x.port));
    if (invalid.length) problems.push(`unexpected listeners: ${JSON.stringify(invalid)}`);
    return {status: problems.length ? 'fail' : 'pass', ...(problems.length ? {reason: problems.join('; ')} : {}), labels,
      artifacts: [log, ...(dir && existsSync(join(dir, 'result.json')) ? [join(dir, 'result.json')] : [])].map(x => ctx.evidence.relative(x)),
      details: {test: name, result: result?.tests?.[name] ?? null, summary, ownedSimulator: udid, listeners,
        blockedSubstep: 'Device registration may create a Secure Enclave key before checking App Attest; not attempted under no-keychain-change rule.'}};
  },
};
