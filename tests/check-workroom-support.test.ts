/**
 * WP3 review fixes for check-workroom.ts and the j1-pty lane (2026-11-01 review of emu/wp3):
 * - the simulator journey starts only under a sandbox the OS confirms and that refuses a worktree write (finding 1);
 * - a refused or unparsable run never leaves an earlier run's pass behind (finding 4);
 * - design §2.5's isolation facts fail the run (finding 5);
 * - a killed run's owned simulator set is recorded, found and swept (finding 7), and its udid reaches the lane (8);
 * - the CSP check runs on the phone's LAN path, not as a host fetch (finding 3);
 * - the parser is strict (finding 10).
 * Follow-up review (emu/wp3 at 5258153e):
 * - a usage error aimed at a folder that also holds someone else's files still replaces our earlier verdict there;
 * - after WP1's port-scoped LAN inbound (emu/wp0-1 daeca98e), the lane declares the journey's three LAN ports, passes
 *   them to check-workroom and fails a run that listens anywhere else off loopback.
 * Nothing here boots a simulator, binds the LAN or touches app data: the integration runs end at the refusal.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  BLOCKED_EXIT, EVIDENCE_ARTIFACTS, SANDBOX_REQUIRED_REASON, UsageError, bestEffortEvidenceDir, claimEvidenceDir, findWorkroomDeviceSets,
  isWorkroomDeviceSet, isolationFailures, leftoverDeviceSet, parseCheckWorkroomArgs, parseLanBinding, prepareEvidenceDir, processSandboxed,
  readRunStatus, sandboxRefusal, settleRunStatus, startupRunStatus, sweepDeviceSet, writeProbe, writeRunStatus,
} from '../mobile/ios/scripts/checkWorkroomSupport';
import {
  J1_PTY_EVIDENCE, earlierLeftovers, laneOutcomeFromRunStatus, listenerProblems, processTree, reserveLanPorts, watchListeners,
} from '../scripts/emulator-e2e/workroomPty';
import {LANE_MODULES, lanesForAll, resolveLane} from '../scripts/emulator-e2e';
import {harnessScanTargets} from '../scripts/emulator-e2e/preflight';
import {RESERVED_LOOPBACK_PORTS, createRunScratch, realHome} from '../scripts/emulator-e2e/environment';
import {buildSandboxProfile, hostProfileStaticChecks, sandboxedArgv, writeSandboxProfile} from '../scripts/emulator-e2e/sandbox';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT = join(REPO_ROOT, 'mobile/ios/scripts/check-workroom.ts');
const macOnly = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const HOME = realHome();
/** Above macOS's pid ceiling (99998): never a live process. */
const DEAD_PID = 999_999;

let scratch = '';
beforeAll(() => { scratch = createRunScratch(`wp3-support-${process.pid}`); });
afterAll(() => { if (scratch) rmSync(scratch, {recursive: true, force: true}); });
let counter = 0;
const fresh = (label: string) => { const dir = join(scratch, `${label}-${++counter}`); mkdirSync(dir, {recursive: true}); return dir; };

describe('check-workroom arguments are strict', () => {
  test('accepts the documented forms', () => {
    expect(parseCheckWorkroomArgs([])).toEqual({mode: 'simulator'});
    expect(parseCheckWorkroomArgs(['--evidence-dir', '/abs/ev', '--portal-url', 'https://portal.example'])).toEqual({mode: 'simulator', evidenceDir: '/abs/ev', portalUrl: 'https://portal.example'});
    expect(parseCheckWorkroomArgs(['--compile-only'])).toEqual({mode: 'compile-only', target: 'simulator'});
    expect(parseCheckWorkroomArgs(['--compile-only', 'device'])).toEqual({mode: 'compile-only', target: 'device'});
    expect(parseCheckWorkroomArgs(['--device', 'UDID', '/apps/Signed.app', 'Apple Development: X'])).toEqual({mode: 'device', device: 'UDID', template: '/apps/Signed.app', identity: 'Apple Development: X'});
    expect(parseCheckWorkroomArgs(['--evidence-dir', '/abs/ev', '--device', 'UDID', '/apps/Signed.app', 'Id'])).toMatchObject({mode: 'device', evidenceDir: '/abs/ev'});
    expect(parseCheckWorkroomArgs(['--evidence-dir', '/abs/ev', '--lan-address', '192.168.0.20', '--lan-ports', '45100,45101,45102'])).toEqual({
      mode: 'simulator', evidenceDir: '/abs/ev', lan: {address: '192.168.0.20', serverPort: 45_100, foreignPort: 45_101, redirectPort: 45_102},
    });
  });

  test('the LAN binding comes whole: one dotted IPv4 and three different ports the LAN server accepts', () => {
    expect(parseLanBinding(undefined, undefined)).toBeUndefined();
    for (const [address, ports] of [
      ['192.168.0.20', undefined], [undefined, '45100,45101,45102'], ['192.168.0.256', '45100,45101,45102'], ['host.local', '45100,45101,45102'],
      ['192.168.0.20', '45100,45101'], ['192.168.0.20', '45100,45101,45102,45103'], ['192.168.0.20', '45100,45100,45102'],
      ['192.168.0.20', '80,45101,45102'], ['192.168.0.20', '45100,45101,70000'], ['192.168.0.20', '45100,,45102'], ['192.168.0.20', '0x10,45101,45102'],
    ] as Array<[string | undefined, string | undefined]>) expect(() => parseLanBinding(address, ports), `${address} ${ports}`).toThrow(UsageError);
    expect(() => parseCheckWorkroomArgs(['--compile-only', '--lan-address', '192.168.0.20', '--lan-ports', '45100,45101,45102'])).toThrow(UsageError);
  });

  test('refuses extra words, unknown options, relative or repeated folders and options compile-only cannot use', () => {
    for (const argv of [
      ['--compile-only', 'device', 'extra'], ['--compile-only', 'tablet'], ['--compile-only', '--evidence-dir', '/abs/ev'],
      ['--compile-only', '--portal-url', 'https://p.example'],
      ['--device', 'UDID', '/apps/Signed.app'], ['--device', 'UDID', '/apps/Signed.app', 'Id', 'extra'], ['--device', 'UDID', '-x', 'Id'],
      ['--evidence-dir', 'relative/ev'], ['--evidence-dir'], ['--evidence-dir', '--compile-only'], ['--evidence-dir', '/a', '--evidence-dir', '/b'],
      ['--bogus'], ['simulator'], ['--portal-url'],
    ]) expect(() => parseCheckWorkroomArgs(argv), argv.join(' ')).toThrow(UsageError);
  });

  test('a call that does not parse still names the folder its refusal goes to (never for --compile-only)', () => {
    expect(bestEffortEvidenceDir('/repo', ['--bogus'])).toEqual({dir: '/repo/mobile/ios/build/workroom-evidence', explicit: false});
    expect(bestEffortEvidenceDir('/repo', ['--device', 'only-one'])).toEqual({dir: '/repo/mobile/ios/build/workroom-device-evidence', explicit: false});
    expect(bestEffortEvidenceDir('/repo', ['--evidence-dir', '/abs/ev', '--bogus'])).toEqual({dir: '/abs/ev', explicit: true});
    expect(bestEffortEvidenceDir('/repo', ['--evidence-dir', 'relative'])).toBeUndefined();
    expect(bestEffortEvidenceDir('/repo', ['--compile-only', 'x', 'y'])).toBeUndefined();
    // --compile-only with a folder is itself a usage error; the folder it named still gets the failed verdict.
    expect(bestEffortEvidenceDir('/repo', ['--compile-only', '--evidence-dir', '/abs/ev'])).toEqual({dir: '/abs/ev', explicit: true});
  });
});

describe('an earlier verdict never outlives a new run', () => {
  test('a given folder: new is made, our own artifacts are removed, anything else is refused and kept', () => {
    const made = join(fresh('ev'), 'new');
    prepareEvidenceDir(made, true);
    expect(readdirSync(made)).toEqual([]);

    const earlier = fresh('ev');
    for (const name of EVIDENCE_ARTIFACTS) writeFileSync(join(earlier, name), 'old');
    prepareEvidenceDir(earlier, true);
    expect(readdirSync(earlier)).toEqual([]);

    const foreign = fresh('ev');
    writeFileSync(join(foreign, 'notes.txt'), 'mine');
    writeFileSync(join(foreign, 'run-status.json'), '{"state":"passed"}');
    mkdirSync(join(foreign, 'sub'));
    expect(() => prepareEvidenceDir(foreign, true)).toThrow(/new folder or an earlier run's evidence/);
    expect(readdirSync(foreign).sort()).toEqual(['notes.txt', 'run-status.json', 'sub']);
  });

  test('claiming a folder writes the verdict; a refused folder keeps its files but never our earlier pass', () => {
    const made = join(fresh('claim'), 'new');
    expect(claimEvidenceDir(made, true, why => ({state: 'failed', reason: why ?? 'started'}))).toBeNull();
    expect(readRunStatus(made)).toEqual({state: 'failed', reason: 'started'});

    const shared = fresh('claim');
    writeFileSync(join(shared, 'notes.txt'), 'mine');
    writeRunStatus(shared, {state: 'passed'});
    const refusal = claimEvidenceDir(shared, true, why => ({state: 'failed', reason: why ?? 'started'}));
    expect(refusal).toContain('notes.txt');
    expect(readRunStatus(shared)).toEqual({state: 'failed', reason: refusal});
    expect(readFileSync(join(shared, 'notes.txt'), 'utf8')).toBe('mine');

    // Refused without an earlier verdict: nothing is written into someone else's folder.
    const other = fresh('claim');
    writeFileSync(join(other, 'notes.txt'), 'mine');
    expect(claimEvidenceDir(other, true, () => ({state: 'failed'}))).not.toBeNull();
    expect(readdirSync(other)).toEqual(['notes.txt']);
  });

  test('the default folder is replaced whole', () => {
    const dir = fresh('default');
    writeFileSync(join(dir, 'anything'), 'x');
    prepareEvidenceDir(dir, false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('the startup status is a failure, and the parent settles a missing or unfinished verdict as failed', () => {
    expect(startupRunStatus(undefined, 'why')).toMatchObject({state: 'failed', stage: 'startup', mode: 'unknown', reason: 'why'});
    const fallback = startupRunStatus({mode: 'simulator'}, 'stopped');
    expect(settleRunStatus(null, 0, fallback)).toMatchObject({exitCode: 1, status: {state: 'failed', reason: 'exited with code 0 before writing a verdict'}});
    expect(settleRunStatus({state: 'running', stage: 'boot'}, 137, fallback)).toMatchObject({exitCode: 137, status: {state: 'failed', stage: 'boot'}});
    // A zero exit is not a pass unless the file says passed.
    expect(settleRunStatus({state: 'failed', reason: 'x'}, 0, fallback)).toEqual({status: null, exitCode: 1});
    expect(settleRunStatus({state: 'passed'}, 0, fallback)).toEqual({status: null, exitCode: 0});
    expect(settleRunStatus({state: 'blocked'}, BLOCKED_EXIT, fallback)).toEqual({status: null, exitCode: BLOCKED_EXIT});
  });

  // The real script, unsandboxed: it must stop at the sandbox refusal and leave `failed`, not the seeded pass.
  test('check-workroom (unsandboxed) refuses the simulator journey and replaces a seeded pass', () => {
    const dir = join(fresh('integration'), 'ev');
    mkdirSync(dir);
    writeRunStatus(dir, {state: 'passed', at: '2026-10-01T00:00:00Z'});
    writeFileSync(join(dir, 'workroom.png'), 'old');
    const run = Bun.spawnSync([process.execPath, SCRIPT, '--evidence-dir', dir], {cwd: REPO_ROOT, env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? HOME, TMPDIR: `${scratch}/`}, stdout: 'pipe', stderr: 'pipe'});
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain(SANDBOX_REQUIRED_REASON);
    expect(readRunStatus(dir)).toMatchObject({state: 'failed', stage: 'startup', mode: 'simulator'});
    expect(String(readRunStatus(dir)?.reason)).toContain('not sandboxed');
    expect(existsSync(join(dir, 'workroom.png'))).toBe(false);
    // The refusal happens before the probe: nothing was written into the worktree.
    expect(readdirSync(REPO_ROOT).some(name => name.startsWith('.check-workroom-sandbox-probe-'))).toBe(false);
  }, 30_000);

  test('check-workroom with arguments it does not understand still replaces a seeded pass', () => {
    const dir = join(fresh('integration'), 'ev');
    mkdirSync(dir);
    writeRunStatus(dir, {state: 'passed'});
    const run = Bun.spawnSync([process.execPath, SCRIPT, '--evidence-dir', dir, '--bogus'], {cwd: REPO_ROOT, env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? HOME, TMPDIR: `${scratch}/`}, stdout: 'pipe', stderr: 'pipe'});
    expect(run.exitCode).toBe(1);
    expect(readRunStatus(dir)).toMatchObject({state: 'failed', stage: 'startup'});
    expect(String(readRunStatus(dir)?.reason)).toContain('Usage error');
  }, 30_000);

  // Follow-up review: with arguments that do not parse, a folder that also holds someone else's file kept a seeded pass.
  test('check-workroom with arguments it does not understand, aimed at a shared folder, still replaces a seeded pass', () => {
    const dir = fresh('integration');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    writeRunStatus(dir, {state: 'passed'});
    const run = Bun.spawnSync([process.execPath, SCRIPT, '--evidence-dir', dir, '--bogus'], {cwd: REPO_ROOT, env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? HOME, TMPDIR: `${scratch}/`}, stdout: 'pipe', stderr: 'pipe'});
    expect(run.exitCode).toBe(1);
    expect(readRunStatus(dir)).toMatchObject({state: 'failed', stage: 'startup'});
    expect(String(readRunStatus(dir)?.reason)).toContain('Usage error');
    expect(String(readRunStatus(dir)?.reason)).toContain('notes.txt');
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('mine');
  }, 30_000);

  test('check-workroom --compile-only aimed at an evidence folder is a usage error that replaces a seeded pass there', () => {
    const dir = fresh('integration');
    writeRunStatus(dir, {state: 'passed'});
    const run = Bun.spawnSync([process.execPath, SCRIPT, '--compile-only', '--evidence-dir', dir], {cwd: REPO_ROOT, env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? HOME, TMPDIR: `${scratch}/`}, stdout: 'pipe', stderr: 'pipe'});
    expect(run.exitCode).toBe(1);
    expect(readRunStatus(dir)).toMatchObject({state: 'failed', stage: 'startup'});
    expect(String(readRunStatus(dir)?.reason)).toContain('--compile-only takes no');
  }, 30_000);

  test('check-workroom refuses a folder holding other files but still replaces our earlier verdict there', () => {
    const dir = fresh('integration');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    writeRunStatus(dir, {state: 'passed'});
    const run = Bun.spawnSync([process.execPath, SCRIPT, '--evidence-dir', dir], {cwd: REPO_ROOT, env: {PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? HOME, TMPDIR: `${scratch}/`}, stdout: 'pipe', stderr: 'pipe'});
    expect(run.exitCode).toBe(1);
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('mine');
    expect(readRunStatus(dir)).toMatchObject({state: 'failed', stage: 'startup'});
  }, 30_000);
});

describe('design §2.5 isolation facts fail the run', () => {
  test('a changed earlier simulator, an unreadable set or a new Simulator.app is a failure', () => {
    expect(isolationFailures({preexistingUnchanged: true, simulatorAppBefore: [10], simulatorAppAfter: [10]})).toEqual([]);
    expect(isolationFailures({preexistingUnchanged: false, simulatorAppBefore: [], simulatorAppAfter: []})).toHaveLength(1);
    expect(isolationFailures({preexistingUnchanged: null, simulatorAppBefore: [], simulatorAppAfter: []})).toHaveLength(1);
    expect(isolationFailures({preexistingUnchanged: true, simulatorAppBefore: [10], simulatorAppAfter: [10, 11]})[0]).toContain('Simulator.app started');
    expect(isolationFailures({preexistingUnchanged: true, simulatorAppBefore: [], simulatorAppAfter: null})).toHaveLength(1);
  });

  test('check-workroom computes its state from the isolation failures (they used to be warnings with a pass)', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain("const state=cleanupFailed||isolation.length?'failed'");
    expect(text).not.toMatch(/warnings\.push|warnings:/);
  });
});

describe('the simulator journey requires the harness sandbox', () => {
  test('refuses without a sandbox (and then writes no probe), or when the sandbox lets the worktree be written', () => {
    let probed = false;
    expect(sandboxRefusal('/repo', {sandboxed: () => false, probe: () => { probed = true; return {denied: true, code: 'EPERM'}; }})).toContain('not sandboxed');
    expect(probed).toBe(false);
    expect(sandboxRefusal('/repo', {sandboxed: () => true, probe: () => ({denied: false, code: 'CREATED'})})).toContain('allowed a write into the worktree');
    expect(sandboxRefusal('/repo', {sandboxed: () => true, probe: () => ({denied: true, code: 'EPERM'})})).toBeNull();
  });

  test('the write probe removes what it creates', () => {
    const dir = fresh('probe');
    expect(writeProbe(dir, 'p')).toEqual({denied: false, code: 'CREATED'});
    expect(readdirSync(dir)).toEqual([]);
  });

  test.skipIf(!macOnly)('the OS answers: this test process is not sandboxed, a child under the harness profile is, and its worktree write is denied', async () => {
    expect(processSandboxed()).toBe(false);
    const writable = fresh('sbx');
    // WP1 keeps the profile outside every writable root (a host could rewrite it there).
    const profile = writeSandboxProfile(fresh('sbx-profile'), 'wp3-probe', {writableRoots: [writable]});
    const script = join(writable, 'probe.ts');
    writeFileSync(script, `import {processSandboxed, writeProbe, sandboxRefusal} from ${JSON.stringify(join(REPO_ROOT, 'mobile/ios/scripts/checkWorkroomSupport.ts'))};
console.log(JSON.stringify({sandboxed: processSandboxed(), worktree: writeProbe(${JSON.stringify(REPO_ROOT)}), own: writeProbe(${JSON.stringify(writable)}), refusal: sandboxRefusal(${JSON.stringify(REPO_ROOT)})}));\n`);
    mkdirSync(join(writable, 'home'));
    const child = Bun.spawn(sandboxedArgv(profile, [process.execPath, script]), {cwd: writable, env: {PATH: '/usr/bin:/bin', HOME: join(writable, 'home'), TMPDIR: `${writable}/`}, stdout: 'pipe', stderr: 'pipe'});
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode, stderr).toBe(0);
    const seen = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(seen.sandboxed).toBe(true);
    expect(seen.worktree.denied).toBe(true);
    expect(seen.own).toEqual({denied: false, code: 'CREATED'});
    expect(seen.refusal).toBeNull();
    expect(readdirSync(REPO_ROOT).some(name => name.startsWith('.check-workroom-sandbox-probe-'))).toBe(false);
  }, 60_000);
});

describe('owned simulator sets a killed run leaves behind', () => {
  const makeSet = () => {
    const set = join(fresh('sets'), 'agentstoz-ios-workroom-Ab12Cd', 'sims');
    mkdirSync(set, {recursive: true});
    return realpathSync(set);
  };
  const owned = (deviceSet: string, extra: Record<string, unknown> = {}) => ({state: 'running', ownedSimulator: {deviceSet, udid: 'U', runtime: 'R', ownerPid: DEAD_PID, created: false, deleted: false, ...extra}});

  test('only sets this script made, outside the real home', () => {
    expect(isWorkroomDeviceSet('/private/tmp/x/agentstoz-ios-workroom-Ab12/sims', HOME)).toBe(true);
    expect(isWorkroomDeviceSet(`${HOME}/Library/Developer/CoreSimulator/Devices`, HOME)).toBe(false);
    expect(isWorkroomDeviceSet(`${HOME}/tmp/agentstoz-ios-workroom-Ab12/sims`, HOME)).toBe(false);
    expect(isWorkroomDeviceSet('/private/tmp/x/other/sims', HOME)).toBe(false);
    expect(isWorkroomDeviceSet('relative/agentstoz-ios-workroom-Ab12/sims', HOME)).toBe(false);
  });

  test('a recorded set is a leftover only when not deleted, its owner is gone, and it still exists (created or not)', () => {
    const set = makeSet();
    expect(leftoverDeviceSet(owned(set), {realHome: HOME})).toBe(set);
    expect(leftoverDeviceSet(owned(set, {created: true}), {realHome: HOME})).toBe(set);
    expect(leftoverDeviceSet(owned(set, {deleted: true}), {realHome: HOME})).toBeNull();
    expect(leftoverDeviceSet(owned(set, {ownerPid: process.pid}), {realHome: HOME})).toBeNull();
    expect(leftoverDeviceSet(owned(join(set, '..', '..', 'agentstoz-ios-workroom-Zz9', 'sims')), {realHome: HOME})).toBeNull();
    expect(leftoverDeviceSet(owned('/etc/sims'), {realHome: HOME})).toBeNull();
    expect(leftoverDeviceSet(null, {realHome: HOME})).toBeNull();
  });

  test('the lane finds them in earlier j1-pty evidence and in the default folder, never in its own run', () => {
    const repo = fresh('repo');
    const sets = [makeSet(), makeSet(), makeSet()];
    const place = (dir: string, status: Record<string, unknown>) => { mkdirSync(dir, {recursive: true}); writeRunStatus(dir, status); };
    place(join(repo, 'mobile/ios/build/emulator-evidence/run-a', J1_PTY_EVIDENCE), owned(sets[0]!));
    place(join(repo, 'mobile/ios/build/emulator-evidence/run-now', J1_PTY_EVIDENCE), owned(sets[1]!));
    place(join(repo, 'mobile/ios/build/workroom-evidence'), owned(sets[2]!));
    expect(earlierLeftovers(repo, 'run-now', HOME).sort()).toEqual([sets[0]!, sets[2]!].sort());
    expect(findWorkroomDeviceSets(scratch, HOME)).toEqual(expect.arrayContaining(sets));
  });

  test('a sweep shuts down and deletes everything in the set, then removes the scratch folder only when it is empty', () => {
    const calls: string[][] = [];
    const empty = makeSet();
    const sweep = sweepDeviceSet(empty, HOME, args => { calls.push(args); return {exitCode: 0, stdout: args.includes('list') ? '{"devices":{"r":[]}}' : ''}; });
    expect(calls.map(args => args.slice(4).join(' '))).toEqual(['shutdown all', 'delete all', 'list devices --json']);
    expect(calls.every(args => args[3] === empty)).toBe(true);
    expect(sweep).toEqual({deviceSet: empty, remaining: 0, removed: true});

    const busy = makeSet();
    expect(sweepDeviceSet(busy, HOME, args => ({exitCode: 0, stdout: args.includes('list') ? '{"devices":{"r":[{"udid":"U"}]}}' : ''}))).toEqual({deviceSet: busy, remaining: 1, removed: false});
    expect(existsSync(busy)).toBe(true);
    expect(() => sweepDeviceSet(`${HOME}/Library/Developer/CoreSimulator/Devices`, HOME, () => ({exitCode: 0, stdout: ''}))).toThrow(/did not make/);
  });

  test('check-workroom records the set (absolute), its owner and the udid before and after simctl create', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toMatch(/ownedSimulator=\{deviceSet,udid:null,[^}]*ownerPid:process\.pid/);
    expect(text).toMatch(/ownedSimulator\.udid=/);
  });
});

describe('the j1-pty lane', () => {
  test('is registered, resolves, and stays out of `all` (opt-in)', async () => {
    expect(typeof LANE_MODULES['j1-pty']).toBe('function');
    expect((await resolveLane('j1-pty'))?.id).toBe('j1-pty');
    expect(lanesForAll()).not.toContain('j1-pty');
  });

  test('its verdict comes from run-status.json, and nothing missing or unfinished is a pass', () => {
    expect(laneOutcomeFromRunStatus({state: 'passed'}, 0, false)).toEqual({status: 'pass'});
    expect(laneOutcomeFromRunStatus({state: 'passed'}, 1, false).status).toBe('fail');
    expect(laneOutcomeFromRunStatus(null, 0, false).status).toBe('fail');
    expect(laneOutcomeFromRunStatus({state: 'running'}, 0, false).status).toBe('fail');
    expect(laneOutcomeFromRunStatus({state: 'passed'}, 0, true).status).toBe('fail');
    expect(laneOutcomeFromRunStatus({state: 'blocked', reason: 'no private IPv4'}, BLOCKED_EXIT, false)).toEqual({status: 'blocked', reason: 'no private IPv4'});
    expect(laneOutcomeFromRunStatus({state: 'failed', reason: 'isolation: x'}, 1, false)).toEqual({status: 'fail', reason: 'isolation: x'});
  });

  test('runs check-workroom under the WP1 profile with LAN inbound on the three ports it passes, and its own evidence folder', () => {
    const text = readFileSync(join(REPO_ROOT, 'scripts/emulator-e2e/workroomPty.ts'), 'utf8');
    expect(text).toContain('const lanInbound: LanInbound = {port: serverPort, extraPorts: [foreignPort, redirectPort]};');
    expect(text).toContain("ctx.sandboxProfile('j1-pty-lan', {lanInbound})");
    // The hash-checked profile object, not a path (WP1 re-hashes it right before launch).
    expect(text).toContain("sandboxedArgv(sandbox, [process.execPath, join(ctx.repoRoot, J1_PTY_SCRIPT), '--evidence-dir', evidenceDir,");
    expect(text).toContain("'--lan-address', address, '--lan-ports', `${serverPort},${foreignPort},${redirectPort}`]");
    expect(text).toContain('watchListeners(pid)');
    expect(text).toContain("listenerProblems(listeners.seen, {address, ...lanInbound}, verdict.status === 'pass')");
    expect(text).toContain('ctx.acquireSimulatorBootLock(');
    expect(text).toContain('ctx.ownSimulator(owned.udid');
    // check-workroom binds exactly those: the server, the foreign origin and the redirect.
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('...(lan?{port:lan.serverPort}:{})');
    expect(script).toContain('port:lan?.foreignPort??0');
    expect(script).toContain('port:lan?.redirectPort??0');
    expect(script).toContain('if(!args.lan)refuse(');
  });

  test('its profile opens LAN inbound on exactly the three declared ports and keeps every reserved-port check', () => {
    const dir = fresh('lan-profile');
    const profile = buildSandboxProfile({writableRoots: [dir], home: '/Users/example', lanInbound: {port: 45_100, extraPorts: [45_101, 45_102]}});
    for (const port of [45_100, 45_101, 45_102]) {
      expect(profile.text).toContain(`(allow network-bind (local ip "*:${port}"))`);
      expect(profile.text).toContain(`(allow network-inbound (local ip "*:${port}"))`);
    }
    expect(profile.text.match(/\(allow network-(?:bind|inbound) \(local ip "\*:/g)).toHaveLength(6);
    expect(profile.text).not.toContain('(allow network-bind (local ip "*:*"))');
    expect(profile.lanInbound).toEqual({port: 45_100, extraPorts: [45_101, 45_102]});
    expect(hostProfileStaticChecks(profile.text).every(check => check.passed)).toBe(true);
    // The reserved-port denials still come after every LAN allow.
    const lines = profile.text.split('\n');
    const lastLanAllow = Math.max(...lines.map((line, index) => line.startsWith('(allow network-') && line.includes('(local ip "*:4510') ? index : -1));
    expect(lastLanAllow).toBeGreaterThan(0);
    for (const port of RESERVED_LOOPBACK_PORTS) expect(lines.indexOf(`(deny network-bind (local ip "*:${port}"))`)).toBeGreaterThan(lastLanAllow);
    for (const lanInbound of [{port: 45_100, extraPorts: [3001]}, {port: 45_100, extraPorts: [45_100]}, {port: 45_100, extraPorts: [0]}, {port: 45_100, extraPorts: 45_101}]) {
      expect(() => buildSandboxProfile({writableRoots: [dir], home: '/Users/example', lanInbound} as never), JSON.stringify(lanInbound)).toThrow();
    }
    // One port (WP1's own form) is unchanged.
    expect(buildSandboxProfile({writableRoots: [dir], home: '/Users/example', lanInbound: {port: 45_100}}).lanInbound).toEqual({port: 45_100});
  });

  test('the forbidden-tool scan covers what check-workroom imports and compiles, not only the script', () => {
    const paths = harnessScanTargets(REPO_ROOT).map(target => target.path);
    for (const path of ['scripts/emulator-e2e/workroomPty.ts', 'mobile/ios/scripts/check-workroom.ts', 'mobile/ios/scripts/checkWorkroomSupport.ts',
      'mobile/ios/scripts/workroomFixtureCompile.ts', 'mobile/ios/scripts/fixtures/WorkroomProbe.swift']) expect(paths).toContain(path);
  });

  test('reserves distinct, unreserved ports for the three listeners and releases them', () => {
    const ports = reserveLanPorts(3);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(1024);
      expect((RESERVED_LOOPBACK_PORTS as readonly number[]).includes(port)).toBe(false);
      // Released: the port can be bound again at once.
      const again = Bun.serve({hostname: '127.0.0.1', port, fetch: () => new Response('')});
      again.stop(true);
    }
  });

  test('watches the whole process tree, and fails a run on any other off-loopback listener', async () => {
    const rows = [{pid: 10, ppid: 1, command: 'bun'}, {pid: 11, ppid: 10, command: 'bun'}, {pid: 12, ppid: 11, command: 'python3'}, {pid: 20, ppid: 1, command: 'other'}];
    expect(processTree(rows, 10).sort()).toEqual([10, 11, 12]);

    const expected = {address: '192.168.0.20', port: 45_100, extraPorts: [45_101, 45_102]};
    const three = [45_100, 45_101, 45_102].map(port => ({address: '192.168.0.20', port}));
    expect(listenerProblems([...three, {address: '127.0.0.1', port: 50_000}], expected, true)).toEqual([]);
    expect(listenerProblems([...three, {address: '*', port: 45_103}], expected, true)).toEqual([
      'LAN listener: listens on *:45103 (only 192.168.0.20:45100, 192.168.0.20:45101, 192.168.0.20:45102 are allowed)',
    ]);
    expect(listenerProblems([{address: '100.109.0.1', port: 45_100}], expected, false)).toEqual([
      'LAN listener: listens on 100.109.0.1:45100 (only 192.168.0.20:45100, 192.168.0.20:45101, 192.168.0.20:45102 are allowed)',
    ]);
    // A pass must have shown all three; a run that failed before its listeners opened keeps its own reason.
    expect(listenerProblems(three.slice(0, 2), expected, true)).toEqual(['LAN listener: does not listen on 192.168.0.20:45102']);
    expect(listenerProblems([], expected, false)).toEqual([]);

    // The watcher keeps every distinct listener it sampled (including the final sample at stop).
    let call = 0;
    const samples = [[three[0]!], [three[0]!, three[1]!], [three[2]!]];
    const watch = watchListeners(process.pid, 5, () => samples[Math.min(call++, samples.length - 1)]!);
    await Bun.sleep(40);
    const seen = watch.stop();
    expect(seen.samples).toBeGreaterThanOrEqual(3);
    expect(seen.seen.map(entry => entry.port).sort()).toEqual([45_100, 45_101, 45_102]);
  });
});

describe('the LAN CSP is checked on the phone, not by a host fetch', () => {
  test('the probe reads /remote/ over its own URLSession and reports the check; the host only asserts it', () => {
    const probe = readFileSync(join(REPO_ROOT, 'mobile/ios/scripts/fixtures/WorkroomProbe.swift'), 'utf8');
    expect(probe).toContain('"lan-page-csp-default-src-none"');
    expect(probe).toContain('value(forHTTPHeaderField: "Content-Security-Policy")');
    expect(probe.indexOf('lan-page-csp-default-src-none')).toBeLessThan(probe.indexOf('LANWorkroomSession('));
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).not.toContain('await fetch(');
    expect(script).toContain("result.checks.includes('lan-page-csp-default-src-none')");
  });
});
