/** Helpers of check-workroom.ts that start nothing, so tests/check-workroom-support.test.ts can reach them.
 * Nothing here imports host code (src/). */
import {dlopen, FFIType} from 'bun:ffi';
import {closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative} from 'node:path';

export const BLOCKED_EXIT = 78;
export const USAGE = 'Usage: check-workroom.ts [--compile-only [simulator|device] | --device <id> <signed-isolated-app> <signing identity>] [--evidence-dir <new folder>] [--portal-url <https origin>] [--lan-address <private IPv4> --lan-ports <server>,<foreign>,<redirect>]';
/** The run-status states a finished run can leave. Anything else (running, a missing file) is not a verdict. */
export const FINAL_STATES: ReadonlySet<string> = new Set(['passed', 'failed', 'blocked']);

export class UsageError extends Error {}

/**
 * Where the journey's three LAN listeners bind: the pairing server, the 「foreign」 origin a navigation must never reach,
 * and the origin whose QR redirects there. Each is its own origin on one private address. The j1-pty lane picks the
 * ports, declares exactly these as LAN inbound in its sandbox profile, and asserts with lsof that nothing else listens
 * off loopback (that assertion, not SBPL, is what holds the binding — see scripts/emulator-e2e/workroomPty.ts).
 */
export interface LanBinding {address: string; serverPort: number; foreignPort: number; redirectPort: number}

export type CheckWorkroomArgs =
  | {mode: 'simulator'; evidenceDir?: string; portalUrl?: string; lan?: LanBinding}
  | {mode: 'device'; device: string; template: string; identity: string; evidenceDir?: string; portalUrl?: string; lan?: LanBinding}
  | {mode: 'compile-only'; target: 'simulator' | 'device'};

const VALUE_OPTIONS = ['--evidence-dir', '--portal-url', '--lan-address', '--lan-ports'] as const;

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** `--lan-address` and `--lan-ports` come together: a dotted IPv4 and three distinct ports in 1024–65535 (the LAN
 * server's own range). Whether the address is private and this Mac's is checked where host code may run (the child). */
export function parseLanBinding(address: string | undefined, ports: string | undefined): LanBinding | undefined {
  if (address === undefined && ports === undefined) return undefined;
  if (address === undefined || ports === undefined) throw new UsageError('--lan-address and --lan-ports go together');
  if (!IPV4.test(address)) throw new UsageError('--lan-address must be a dotted IPv4 address');
  const values = ports.split(',');
  const numbers = values.map(value => /^\d{1,5}$/.test(value) ? Number(value) : NaN);
  if (numbers.length !== 3 || numbers.some(port => !Number.isInteger(port) || port < 1024 || port > 65_535)) throw new UsageError('--lan-ports takes <server>,<foreign>,<redirect>: three ports in 1024-65535');
  if (new Set(numbers).size !== 3) throw new UsageError('--lan-ports must name three different ports');
  const [serverPort, foreignPort, redirectPort] = numbers as [number, number, number];
  return {address, serverPort, foreignPort, redirectPort};
}

/** Strict: every argument must be understood. Extra words after a mode used to be accepted silently. */
export function parseCheckWorkroomArgs(argv: readonly string[]): CheckWorkroomArgs {
  const options: Partial<Record<typeof VALUE_OPTIONS[number], string>> = {};
  const words: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if ((VALUE_OPTIONS as readonly string[]).includes(arg)) {
      const key = arg as typeof VALUE_OPTIONS[number];
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`${key} needs a value`);
      if (options[key] !== undefined) throw new UsageError(`${key} was given twice`);
      options[key] = value;
      index++;
      continue;
    }
    words.push(arg);
  }
  const evidenceDir = options['--evidence-dir'];
  if (evidenceDir !== undefined && !isAbsolute(evidenceDir)) throw new UsageError('--evidence-dir must be an absolute path');
  const portalUrl = options['--portal-url'];
  const lan = parseLanBinding(options['--lan-address'], options['--lan-ports']);
  const [mode, ...rest] = words;
  if (mode === undefined) return {mode: 'simulator', ...(evidenceDir ? {evidenceDir} : {}), ...(portalUrl ? {portalUrl} : {}), ...(lan ? {lan} : {})};
  if (mode === '--compile-only') {
    if (evidenceDir !== undefined || portalUrl !== undefined || lan !== undefined) throw new UsageError('--compile-only takes no --evidence-dir, --portal-url or --lan-*');
    if (rest.length > 1) throw new UsageError(`unexpected argument after --compile-only: ${rest.slice(1).join(' ')}`);
    const target = rest[0] ?? 'simulator';
    if (target !== 'simulator' && target !== 'device') throw new UsageError('--compile-only takes simulator or device');
    return {mode: 'compile-only', target};
  }
  if (mode === '--device') {
    if (rest.length !== 3 || rest.some(value => !value || value.startsWith('-'))) throw new UsageError('--device needs exactly <id> <signed-isolated-app> <signing identity>');
    const [device, template, identity] = rest as [string, string, string];
    return {mode: 'device', device, template, identity, ...(evidenceDir ? {evidenceDir} : {}), ...(portalUrl ? {portalUrl} : {}), ...(lan ? {lan} : {})};
  }
  throw new UsageError(`unexpected argument: ${mode}`);
}

export function defaultEvidenceDir(root: string, mode: 'simulator' | 'device'): string {
  return join(root, mode === 'device' ? 'mobile/ios/build/workroom-device-evidence' : 'mobile/ios/build/workroom-evidence');
}

export function evidenceDirFor(root: string, args: CheckWorkroomArgs): string | undefined {
  if (args.mode === 'compile-only') return undefined;
  return args.evidenceDir ?? defaultEvidenceDir(root, args.mode);
}

/** Where a refused invocation records its refusal when its arguments do not even parse. A folder the call names is
 * always used, even with --compile-only (that combination is itself a usage error, and an earlier pass in the folder
 * it aimed at must not outlive it). Without one, a compile-only call has no verdict file and touches none. */
export function bestEffortEvidenceDir(root: string, argv: readonly string[]): {dir: string; explicit: boolean} | undefined {
  const at = argv.indexOf('--evidence-dir');
  if (at >= 0) {
    const value = argv[at + 1];
    return value && isAbsolute(value) ? {dir: value, explicit: true} : undefined;
  }
  if (argv.includes('--compile-only')) return undefined;
  return {dir: defaultEvidenceDir(root, argv.includes('--device') ? 'device' : 'simulator'), explicit: false};
}

/** Every file this script (and its probe) leaves in an evidence folder. */
export const EVIDENCE_ARTIFACTS: ReadonlySet<string> = new Set([
  'run-status.json', 'result.json', 'diagnostic.json', 'native-failure.txt',
  'workroom.png', 'resumed.png', 'portal.png', 'failure.png', 'failure-screen.png',
  'draft-screen.png', 'draft-screen.json', 'workroom-screen.png', 'workroom-screen.json',
]);

/**
 * The evidence folder for this run, emptied before any check can refuse. A caller's folder is never deleted
 * recursively: it must be new, empty, or hold only this script's own artifacts (an earlier run's), which are removed
 * one by one. Anything else in it is refused and left alone. The script's own default folders are replaced.
 */
export function prepareEvidenceDir(dir: string, explicit: boolean): void {
  if (!isAbsolute(dir)) throw new Error('The evidence folder must be an absolute path');
  if (explicit) {
    const entries = existsSync(dir) ? readdirSync(dir, {withFileTypes: true}) : [];
    const foreign = entries.filter(entry => !entry.isFile() || !EVIDENCE_ARTIFACTS.has(entry.name));
    if (foreign.length) throw new Error(`--evidence-dir must name a new folder or an earlier run's evidence; it holds ${foreign.map(entry => entry.name).slice(0, 5).join(', ')}`);
    for (const entry of entries) rmSync(join(dir, entry.name), {force: true});
    mkdirSync(dir, {recursive: true, mode: 0o700});
    return;
  }
  rmSync(dir, {recursive: true, force: true});
  mkdirSync(dir, {recursive: true, mode: 0o700});
}

/**
 * Claims the evidence folder for a run (or a refusal) and writes its first verdict: `status()` once the folder is
 * prepared. A folder holding files this script does not own is refused and left alone — except an earlier verdict of
 * ours, which is overwritten with `status(refusal)`: it must not outlive this call. Returns the refusal, or null.
 * Both the parsed path and the usage-error path go through here, so neither can leave an earlier pass behind.
 */
export function claimEvidenceDir(dir: string, explicit: boolean, status: (refusal?: string) => Record<string, unknown>): string | null {
  try {
    prepareEvidenceDir(dir, explicit);
  } catch (error) {
    const refusal = String((error as Error)?.message ?? error);
    if (existsSync(join(dir, 'run-status.json'))) { try { writeRunStatus(dir, status(refusal)); } catch {} }
    return refusal;
  }
  writeRunStatus(dir, status());
  return null;
}

export function writeRunStatus(dir: string, status: Record<string, unknown>): void {
  writeFileSync(join(dir, 'run-status.json'), JSON.stringify(status, null, 2) + '\n', {mode: 0o600});
}

export function readRunStatus(dir: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'run-status.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** The verdict file of a run that has not started (or was refused). It is never a pass. */
export function startupRunStatus(args: CheckWorkroomArgs | undefined, reason: string): Record<string, unknown> {
  return {state: 'failed', stage: 'startup', at: new Date().toISOString(), mode: args?.mode ?? 'unknown', reason,
    actualIPhone: args?.mode === 'device', realAI: false, productionData: false};
}

/**
 * What the parent leaves after its child exits: a status that is not a verdict (still `running`, or missing)
 * becomes `failed`, and a zero exit without a pass becomes 1.
 */
export function settleRunStatus(status: Record<string, any> | null, exitCode: number, fallback: Record<string, unknown>): {status: Record<string, unknown> | null; exitCode: number} {
  if (!status || !FINAL_STATES.has(String(status.state))) {
    return {status: {...(status ?? fallback), state: 'failed', reason: `exited with code ${exitCode} before writing a verdict`}, exitCode: exitCode === 0 ? 1 : exitCode};
  }
  if (exitCode === 0 && status.state !== 'passed') return {status: null, exitCode: 1};
  return {status: null, exitCode};
}

// ───────────────────────── isolation verdict (design §2.5) ─────────────────────────

/**
 * Design §2.5 judges a simulator run on three things: earlier simulators unchanged, the owned simulator deleted,
 * and no new Simulator.app. The first and last used to be warnings with a passing exit; they now fail the run.
 * This run only reads the shared set, so such a change most likely came from outside it — but the run cannot then
 * show that it left the Mac as it found it, so it is not a pass.
 */
export function isolationFailures(input: {preexistingUnchanged: boolean | null; simulatorAppBefore: readonly number[]; simulatorAppAfter: readonly number[] | null}): string[] {
  const failures: string[] = [];
  if (input.preexistingUnchanged === false) failures.push('isolation: a simulator that existed before this run changed state or disappeared during it');
  else if (input.preexistingUnchanged === null) failures.push('isolation: the shared simulator set could not be read after the run');
  if (input.simulatorAppAfter === null) failures.push('isolation: Simulator.app processes could not be listed after the run');
  else if (input.simulatorAppAfter.some(pid => !input.simulatorAppBefore.includes(pid))) failures.push('isolation: Simulator.app started during this run (this run boots headless in its own device set)');
  return failures;
}

// ───────────────────────── sandbox requirement (design §2.3) ─────────────────────────

let sandboxCheck: ((pid: number) => number) | null | undefined;
/** `sandbox_check(pid, NULL, SANDBOX_FILTER_NONE)`: 1 when the process runs under a Seatbelt profile. */
export function processSandboxed(pid: number = process.pid): boolean {
  if (process.platform !== 'darwin') return false;
  if (sandboxCheck === undefined) {
    try {
      const lib = dlopen('/usr/lib/libSystem.B.dylib', {sandbox_check: {args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32}});
      sandboxCheck = target => lib.symbols.sandbox_check(target, null, 0);
    } catch { sandboxCheck = null; }
  }
  return sandboxCheck ? sandboxCheck(pid) === 1 : false;
}

/** Creates (and at once removes) a probe file at `dir`. Under the harness sandbox the creation must be refused. */
export function writeProbe(dir: string, name: string = `.check-workroom-sandbox-probe-${crypto.randomUUID()}`): {denied: boolean; code: string} {
  const path = join(dir, name);
  try {
    closeSync(openSync(path, 'wx', 0o600));
    try { unlinkSync(path); } catch {}
    return {denied: false, code: 'CREATED'};
  } catch (error) {
    const code = String((error as {code?: string}).code ?? 'ERROR');
    return {denied: code === 'EPERM' || code === 'EACCES' || code === 'EROFS', code};
  }
}

export const SANDBOX_REQUIRED_REASON = 'The simulator journey runs only inside the emulator harness sandbox (bun scripts/emulator-e2e.ts j1-pty, design §2.3)';

/**
 * The simulator journey binds a live pairing listener on the LAN, runs a PTY and Python. It refuses to start unless
 * the OS confirms a sandbox and that sandbox refuses a write into the worktree outside the run's own folders —
 * an environment marker could be copied, these cannot.
 */
export function sandboxRefusal(repoRoot: string, checks: {sandboxed?: () => boolean; probe?: (dir: string) => {denied: boolean; code: string}} = {}): string | null {
  const sandboxed = (checks.sandboxed ?? processSandboxed)();
  if (!sandboxed) return `${SANDBOX_REQUIRED_REASON}; this process is not sandboxed`;
  const probe = (checks.probe ?? writeProbe)(repoRoot);
  if (!probe.denied) return `${SANDBOX_REQUIRED_REASON}; its sandbox allowed a write into the worktree (${probe.code})`;
  return null;
}

// ───────────────────────── leftover owned simulators ─────────────────────────

const DEVICE_SET_PARENT = /^agentstoz-ios-workroom-[A-Za-z0-9]+$/;

function within(path: string, parent: string): boolean {
  const r = relative(parent, path);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** A device set this script made: `<scratch>/agentstoz-ios-workroom-XXXXXX/sims`, outside the real home. */
export function isWorkroomDeviceSet(path: unknown, realHome: string): path is string {
  return typeof path === 'string' && isAbsolute(path) && basename(path) === 'sims' && DEVICE_SET_PARENT.test(basename(dirname(path)))
    && !within(path, realHome) && !path.split('/').includes('..');
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as {code?: string}).code === 'EPERM'; }
}

/**
 * The owned device set an earlier run recorded but never saw deleted (its owner was killed, for example by the
 * maintainer's SIGKILL two seconds after SIGTERM). Only sets this script made, whose owner is gone, and that
 * still exist.
 */
export function leftoverDeviceSet(status: Record<string, any> | null, options: {realHome: string; alive?: (pid: number) => boolean; exists?: (path: string) => boolean}): string | null {
  const owned = status?.ownedSimulator;
  // `created` is not required: the set's path is recorded before `simctl create`, and a kill during it can leave a
  // half-made device behind.
  if (!owned || typeof owned !== 'object' || owned.deleted === true) return null;
  if (!isWorkroomDeviceSet(owned.deviceSet, options.realHome)) return null;
  if (typeof owned.ownerPid === 'number' && (options.alive ?? pidAlive)(owned.ownerPid)) return null;
  return (options.exists ?? existsSync)(owned.deviceSet) ? owned.deviceSet : null;
}

/** Device sets under `base` (a run's scratch), without descending into a set or deeper than `depth`. */
export function findWorkroomDeviceSets(base: string, realHome: string, depth = 5): string[] {
  const found: string[] = [];
  const walk = (dir: string, left: number) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (isWorkroomDeviceSet(path, realHome)) { found.push(path); continue; }
      if (left > 0) walk(path, left - 1);
    }
  };
  walk(base, depth);
  return found.sort();
}

export interface DeviceSetSweep {deviceSet: string; remaining: number | null; removed: boolean}

/** Shuts down and deletes every simulator in one owned device set, checks it is empty, then removes the scratch
 * folder around it. `run` is `simctl`'s runner (its environment is the caller's). */
export function sweepDeviceSet(deviceSet: string, realHome: string, run: (args: string[]) => {exitCode: number; stdout: string}): DeviceSetSweep {
  if (!isWorkroomDeviceSet(deviceSet, realHome)) throw new Error('Refusing to sweep a folder this script did not make');
  for (const action of [['shutdown', 'all'], ['delete', 'all']]) run(['xcrun', 'simctl', '--set', deviceSet, ...action]);
  let remaining: number | null = null;
  const listed = run(['xcrun', 'simctl', '--set', deviceSet, 'list', 'devices', '--json']);
  if (listed.exitCode === 0) {
    try { remaining = Object.values(JSON.parse(listed.stdout).devices as Record<string, unknown[]>).flat().length; } catch {}
  }
  let removed = false;
  if (remaining === 0) {
    try { rmSync(dirname(deviceSet), {recursive: true, force: true}); removed = !existsSync(dirname(deviceSet)); } catch {}
  }
  return {deviceSet, remaining, removed};
}
