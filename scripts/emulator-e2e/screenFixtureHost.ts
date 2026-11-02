/**
 * Emulator e2e — ScreenFixtureHost (WP7): the AgentsToZ Screen host core without capture or injection, for the
 * phone-to-Mac-screen lanes (J2-SCREEN-SIM, J2-VIEWER-MODEL, J2-APP-BOUNDARY).
 *
 * Build: ScreenControlCore as its own Swift module, then one executable from
 * native/screen-control/Sources/ScreenHost/HostStreamer.swift and the fixture-only files in
 * native/screen-control/Tests/Fixtures/ScreenFixtureHost (a synthetic `ScreenCaptureBackend`, a record-only
 * `InputReceiver`, a software Mac signer). Capture.swift, InputInjector, ScreenService, LocalInputMonitor and
 * DesktopController are never compiled in; an `nm -u`/`otool -L` gate checks the linked binary, and nothing starts a
 * binary the gate did not pass (or one that changed after it). Production sources are only read: no Package.swift
 * target, no seam in Sources, nothing a production build could switch on.
 *
 * Run: always inside sandbox-exec, with an environment built from empty (design §2.2). Under the orchestrator the
 * profile starts from WP1's single generator (`ctx.hostSandbox.text`, scripts/emulator-e2e/sandbox.ts); standalone it
 * starts from `(allow default)`. Either way this file's rules are appended after it and only narrow it: the host makes
 * no outbound connection at all and the stand-in phone reaches the host's port only (so 3001/52741/4723 are
 * unreachable), no exec but the fixture binary, signals only inside the sandbox, writes only to its state, home,
 * temporary and evidence folders, secrets unreadable, and tccd, WindowServer, securityd, coreauthd, pasteboard,
 * LaunchServices, Apple Events and HID unreachable. Profiles and binaries live where no fixture may write.
 * Modes: viewer, pinned-device, invite (see main.swift in the fixture folder).
 *
 *   bun scripts/emulator-e2e.ts screen-host-selfcheck       # the orchestrator lane (`lane` below)
 *   bun scripts/emulator-e2e/screenFixtureHost.ts selfcheck [--evidence-dir NEW_DIR] [--work-dir PARENT] [--keep]
 *   bun scripts/emulator-e2e/screenFixtureHost.ts build --out-dir DIR [--evidence-dir DIR]
 *   bun scripts/emulator-e2e/screenFixtureHost.ts serve --mode viewer|pinned-device|invite --state-dir DIR
 *       --evidence-dir DIR [--build-dir DIR] [--device-public-key BASE64]... [--fps N] [--displays WxH,...]
 *       [--sandbox-base SBPL_FILE]   (the orchestrator's host profile, as `start({sandboxBase})`)
 *
 * `--work-dir` names a parent: the selfcheck makes its own folder inside it and deletes only that. `--evidence-dir`
 * must be new or empty. Scratch folders (HOME, TMPDIR and the other path-valued keys) must lie outside the real home.
 *
 * `serve` is for scripts in other languages (check-ui.py's gesture lane): it prints the host's `ready` line, forwards
 * each JSON line it reads on stdin to the host as a command and prints the reply with the caller's own `id`, and stops
 * the host when stdin closes or on SIGTERM/SIGINT. The orchestrator imports `start`/`stop` instead.
 */
import {createHash, generateKeyPairSync} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createConnection, createServer, type Server} from 'node:net';
import {tmpdir, userInfo} from 'node:os';
import {basename, dirname, join, relative, resolve} from 'node:path';

export const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const PACKAGE_DIR = join(REPO_ROOT, 'native', 'screen-control');
const CORE_DIR = join(PACKAGE_DIR, 'Sources', 'ScreenControlCore');
const HOST_DIR = join(PACKAGE_DIR, 'Sources', 'ScreenHost');
const FIXTURE_DIR = join(PACKAGE_DIR, 'Tests', 'Fixtures', 'ScreenFixtureHost');
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export type ScreenFixtureMode = 'viewer' | 'controller' | 'pinned-device' | 'invite';
export type LaneStatus = 'pass' | 'fail' | 'blocked' | 'skipped';

/** The ScreenHost files the fixture must never compile (journey J2-SCREEN-SIM). */
export const EXCLUDED_HOST_SOURCES = ['Capture.swift', 'InputInjector.swift', 'ScreenService.swift', 'LocalInputMonitor.swift',
  'DesktopController.swift'] as const;
/** Undefined symbols the fixture binaries must not import: the gate the design names. */
export const NM_GATE_REQUIRED = ['CGEventPost', 'CGEventTapPostEvent', 'CGWarpMouseCursorPosition', 'SCStream', 'SCShareableContent'] as const;
/** Also absent: other capture, injection, TCC, window, keychain-item and clipboard entry points. */
export const NM_GATE_EXTENDED = ['SCContentFilter', 'CGDisplayStream', 'CGDisplayCreateImage', 'CGWindowListCreateImage',
  'CGPreflightScreenCaptureAccess', 'CGRequestScreenCaptureAccess', 'CGEventTapCreate', 'CGEventCreate', 'CGMainDisplayID',
  'AXIsProcessTrusted', 'AXUIElement', 'IOHIDRequestAccess', 'IOHIDCheckAccess', 'IOHIDPostEvent', 'SecItemAdd',
  'SecItemUpdate', 'SecItemDelete', 'SecKeychain', 'NSWindow', 'NSApplication', 'NSWorkspace', 'NSPasteboard',
  'TISSelectInputSource'] as const;
export const FORBIDDEN_FRAMEWORKS = ['ScreenCaptureKit', 'AppKit', 'ApplicationServices', 'CoreGraphics', 'Carbon', 'IOKit'] as const;
/** Linked because ScreenControlCore's phone-side signer lives beside code the host needs; the host never calls them,
 * and the sandbox makes their services unreachable. Reported, not refused. */
const NOTED_SYMBOLS = ['LAContext', 'SecureEnclave'] as const;

/**
 * Which invitations the invite mode's counting registration listener can ever see a connection from. The nearby-only
 * `device` and `controller` invitations carry Bonjour service names and no address: a phone following them looks for a
 * nearby service the fixture never advertises, so it can never reach the counting listener. A "0 connections"
 * assertion (J2-APP-BOUNDARY) is evidence about `deviceLegacy` only; for the nearby invitations it proves nothing.
 */
export const INVITES_REACHING_COUNTING_LISTENER = ['deviceLegacy'] as const;

/** Real-path vs stand-in label for the evidence index (design §1, §6). */
export const SCREEN_FIXTURE_LABEL = {
  label: 'Core+표면만',
  scope: 'Core+HostStreamer only: ScreenService, InputInjector, Capture (ScreenCaptureKit), LocalInputMonitor, DesktopController, ScreenViewerModel and Face ID are not part of this host',
  real: ['ScreenControlCore key exchange, PreAuthGate, SecureChannel records', 'HostStreamer, HostCapture, VideoPump session loop',
    'VideoEncoder (VideoToolbox H.264)', 'InputReceiver decoding, rate gate and held-input release', 'RegistrationInvite text and parser'],
  substitutes: ['ScreenCaptureBackend -> synthetic NV12 test card with a frame counter (FixtureCaptureBackend.swift)',
    'input injection -> InputReceiver inject/release/compound write input-events.jsonl, nothing is posted',
    'Mac identity -> in-memory software P-256 key (no Secure Enclave)', 'App Attest -> not exercised',
    'invite registration listener -> connection counter only, reachable from the deviceLegacy invitation alone',
    'selfcheck phone -> macOS stand-in on Core ScreenViewer'],
} as const;

/** Mach services the sandboxed fixture may not reach: no TCC prompt, window, keychain item, Touch ID, clipboard, Apple
 * Event or audio. WP1's list (scripts/emulator-e2e/sandbox.ts) plus the audio and CoreAuthentication daemons, which the
 * builder saw querying TCC about the fixture until their lookups were denied. */
export const DENIED_MACH_SERVICES = ['com.apple.tccd', 'com.apple.tccd.system', 'com.apple.windowserver.active',
  'com.apple.SecurityServer', 'com.apple.securityd.xpc', 'com.apple.CoreAuthentication.daemon', 'com.apple.pasteboard.1',
  'com.apple.coreservices.launchservicesd', 'com.apple.coreservices.appleevents', 'com.apple.audio.audiohald',
  'com.apple.audio.coreaudiod'] as const;
export const DENIED_IOKIT_CLASSES = ['IOHIDParamUserClient', 'IOHIDLibUserClient'] as const;
/** The installed sidecar, the real AgentsToZ Screen and Appium: never in a fixture's outbound allowlist. */
export const DENIED_PORTS = [3001, 52741, 4723] as const;
/** The operational Supabase project: no fixture environment value may name it. */
const PRODUCTION_SUPABASE_REFS = ['yfbivsatsorbidfutkvb'] as const;

// MARK: - Paths

/** The real path of `path`, resolving the deepest existing ancestor when the rest does not exist yet. */
export function canonical(path: string): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let head = absolute;
  for (;;) {
    try { return join(realpathSync(head), ...tail.reverse()); } catch {}
    const parent = dirname(head);
    if (parent === head) return absolute;
    tail.push(basename(head));
    head = parent;
  }
}

/** `path` is `root` or inside it (both canonical). */
export function isInside(path: string, root: string): boolean {
  const base = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
  return path === base || path.startsWith(base === '/' ? '/' : `${base}/`);
}

let cachedRealHome: string | undefined;
/**
 * The account's home from directory services. Bun's `os.userInfo().homedir` follows HOME (WP0 measured a child with a
 * scratch HOME getting the scratch back), so it cannot tell a scratch home from the real one.
 */
export function realHome(): string {
  if (cachedRealHome) return cachedRealHome;
  if (process.platform === 'darwin') {
    const env = {PATH: '/usr/bin:/bin'};
    const user = Bun.spawnSync(['/usr/bin/id', '-un'], {env, stdout: 'pipe', stderr: 'ignore'}).stdout.toString().trim();
    if (/^[A-Za-z0-9._-]+$/.test(user)) {
      const record = Bun.spawnSync(['/usr/bin/dscl', '.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], {env, stdout: 'pipe', stderr: 'ignore'}).stdout.toString();
      const match = /NFSHomeDirectory:\s*(\/\S.*)$/m.exec(record);
      if (match?.[1]) return (cachedRealHome = canonical(match[1].trim()));
    }
    throw new Error('could not resolve the real home from directory services');
  }
  return (cachedRealHome = canonical(userInfo().homedir));
}

/** Paths the sandboxed fixture may not read (design §2.3, plus WP1's credential files). */
export function deniedReadPaths(home = realHome()): string[] {
  const paths = ['.claude', '.codex', '.hermes', '.gemini', 'Library/Keychains', 'Library/CloudStorage', '.gitconfig', '.zshrc',
    '.zprofile', '.zshenv', '.zlogin', '.bashrc', '.bash_profile', '.profile', 'Library/Application Support/com.portmanager.portmanager',
    'Library/Application Support/AgentsToZ Screen', '.ssh', '.aws', '.supabase', '.config/gh', '.config/git', '.git-credentials',
    '.netrc', '.npmrc'].map(path => join(home, path));
  const inherited = process.env.APP_DATA_DIR;
  if (inherited?.startsWith('/') && !paths.includes(inherited)) paths.push(inherited);
  return paths;
}

/** A folder only this account can open: made 0700 when missing. An existing folder is never chmodded: it must already
 * be private, or it is refused (a caller's folder is not ours to change). */
export function privateDirectory(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, {recursive: true, mode: 0o700});
    chmodSync(path, 0o700);
  }
  const stat = statSync(path);
  if (!stat.isDirectory()) throw new Error(`${path} is not a folder`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${path} belongs to another account`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`refusing ${path}: other accounts can open it (mode ${(stat.mode & 0o777).toString(8)})`);
  return realpathSync(path);
}

/** An evidence folder for one run: new, or existing and empty. */
export function freshEvidenceDirectory(path: string): string {
  if (existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length) {
    throw new Error(`refusing to write evidence into ${path}: it is not empty`);
  }
  return privateDirectory(path);
}

/** A scratch parent outside the real home: the given one, else the first of tmpdir() and /private/tmp that qualifies. */
export function scratchParent(home = realHome(), given?: string): string {
  const realHomePath = canonical(home);
  const candidates = given ? [given] : [tmpdir(), '/private/tmp'];
  for (const candidate of candidates) {
    const path = canonical(candidate);
    if (!isInside(path, realHomePath) && !isInside(realHomePath, path)) return path;
  }
  throw new Error(given ? `--work-dir ${given} is inside the real home: scratch must live outside it (design §2.2)`
    : 'no scratch parent outside the real home is available');
}

/** The selfcheck's own folder: always a fresh mkdtemp inside `parent`. Only this folder is ever deleted. */
export function createSelfcheckWorkDir(parent?: string, home = realHome()): string {
  const base = scratchParent(home, parent);
  if (parent) mkdirSync(base, {recursive: true, mode: 0o700});
  const work = realpathSync(mkdtempSync(join(base, 'agentstoz-screen-fixture-')));
  chmodSync(work, 0o700);
  return work;
}

// MARK: - Environment

/**
 * The keys a fixture child may carry: WP0's allowlist (scripts/emulator-e2e/environment.ts, BASE_ALLOWED_ENV_KEYS)
 * plus the run's CA file. Anything else — an inherited token, CODEX_HOME, API_PORT, a Supabase or Vite URL — is refused.
 */
export const FIXTURE_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'APP_DATA_DIR',
  'APPDATA', 'USERPROFILE', 'HERMES_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMUX_TMPDIR',
  'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'NODE_ENV', 'NO_COLOR', 'AGENTSTOZ_SKIP_HERMES_SYNC', 'AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC',
  'AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP', 'AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC', 'NODE_EXTRA_CA_CERTS']);
/** Path-valued keys: each must resolve inside the scratch roots and outside the real home. */
const SCRATCH_PATH_KEYS = Object.freeze(['HOME', 'TMPDIR', 'APP_DATA_DIR', 'APPDATA', 'USERPROFILE', 'HERMES_HOME', 'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMUX_TMPDIR', 'NODE_EXTRA_CA_CERTS']);

/** Why an environment may not reach a fixture child (empty when it may). */
export function fixtureEnvironmentProblems(env: Record<string, string>, scratchRoots: string[], home = realHome()): string[] {
  const problems: string[] = [];
  const realHomePath = canonical(home);
  const roots = scratchRoots.map(canonical);
  if (!roots.length) problems.push('no scratch root');
  for (const root of roots) {
    if (isInside(root, realHomePath) || isInside(realHomePath, root)) problems.push(`scratch root ${root} is not outside the real home`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (!FIXTURE_ENV_KEYS.includes(key)) problems.push(`${key} is not on the fixture allowlist`);
    if (PRODUCTION_SUPABASE_REFS.some(ref => value.includes(ref))) problems.push(`${key} mentions the production Supabase project`);
  }
  for (const key of ['HOME', 'TMPDIR']) if (!env[key]) problems.push(`no ${key}`);
  for (const key of SCRATCH_PATH_KEYS) {
    const value = env[key];
    if (value === undefined) continue;
    if (!value.startsWith('/')) { problems.push(`${key} is not an absolute path`); continue; }
    const path = canonical(value);
    if (isInside(path, realHomePath)) problems.push(`${key} ${value} is under the real home`);
    else if (!roots.some(root => isInside(path, root))) problems.push(`${key} ${value} is outside the scratch roots`);
  }
  for (const entry of (env.PATH ?? '').split(':').filter(Boolean)) {
    if (!entry.startsWith('/')) problems.push(`PATH entry ${entry} is relative`);
    else if (/pyenv|platform-cli|\/shims(\/|$)/i.test(entry)) problems.push(`PATH contains a shim directory ${entry}`);
    else if (isInside(canonical(entry), realHomePath)) problems.push(`PATH entry ${entry} is under the real home`);
  }
  return problems;
}

/** Refuses an environment with a key off the allowlist, or a scratch path inside the real home or outside the roots. */
export function assertFixtureEnvironment(env: Record<string, string>, scratchRoots: string[], home = realHome()): void {
  const problems = fixtureEnvironmentProblems(env, scratchRoots, home);
  if (problems.length) throw new Error(`fixture environment rejected: ${problems.join('; ')}`);
}

/** An environment built from empty: system PATH only, scratch HOME and TMPDIR (design §2.2). */
export function fixtureEnvironment(home: string, tmp: string, extra: Record<string, string> = {}): Record<string, string> {
  return {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: tmp.endsWith('/') ? tmp : tmp + '/', LANG: 'en_US.UTF-8', ...extra};
}

/** One process role's environment and the folder it lives in. */
export interface FixtureEnvironment { env: Record<string, string>; root: string }

/** Standalone (no orchestrator): `<work>/env/<role>/{home,tmp}`. */
function standaloneEnvironment(work: string, role: string): FixtureEnvironment {
  const root = privateDirectory(join(work, 'env', role));
  return {env: fixtureEnvironment(privateDirectory(join(root, 'home')), privateDirectory(join(root, 'tmp'))), root};
}

/** The folders a process with `env` may write besides its own: its HOME and TMPDIR. */
function homeAndTemporary(env: Record<string, string>): string[] {
  return [env.HOME, env.TMPDIR].filter((value): value is string => !!value).map(canonical);
}

function uniqueRoots(paths: string[]): string[] {
  return [...new Set(paths.map(canonical))];
}

// MARK: - Processes

interface Ran { code: number; stdout: string; stderr: string; timedOut: boolean }

async function run(argv: string[], options: {env: Record<string, string>; cwd?: string; timeoutMs?: number}): Promise<Ran> {
  const child = Bun.spawn(argv, {env: options.env, cwd: options.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 300_000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return {code, stdout, stderr, timedOut};
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, {stream: true});
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer) yield buffer;
}

type JsonEvent = Record<string, unknown> & {event?: string};

/** A child that speaks one JSON object per stdout line and takes commands on stdin. */
class JsonLineChild {
  readonly events: JsonEvent[] = [];
  readonly exited: Promise<number>;
  readonly stderr: Promise<string>;
  private readonly child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  private waiters: {test: (event: JsonEvent) => boolean; resolve: (event: JsonEvent) => void}[] = [];
  private closed = false;

  constructor(argv: string[], env: Record<string, string>, cwd: string) {
    this.child = Bun.spawn(argv, {env, cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
    this.exited = this.child.exited;
    this.stderr = new Response(this.child.stderr).text();
    void this.pump();
  }

  get pid(): number { return this.child.pid; }

  private async pump(): Promise<void> {
    for await (const line of lines(this.child.stdout)) {
      if (!line.trim()) continue;
      let event: JsonEvent;
      try { event = JSON.parse(line) as JsonEvent; } catch { event = {event: 'unparsed', line}; }
      this.events.push(event);
      this.waiters = this.waiters.filter(waiter => !(waiter.test(event) && (waiter.resolve(event), true)));
    }
    this.closed = true;
    for (const waiter of this.waiters) waiter.resolve({event: 'closed'});
    this.waiters = [];
  }

  /** The first event, already received or still to come, that passes `test`; `{event: 'closed'}` if stdout ends first. */
  waitFor(test: (event: JsonEvent) => boolean, timeoutMs: number, label: string): Promise<JsonEvent> {
    const seen = this.events.find(test);
    if (seen) return Promise.resolve(seen);
    if (this.closed) return Promise.resolve({event: 'closed'});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter.resolve !== done);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      const done = (event: JsonEvent) => { clearTimeout(timer); resolve(event); };
      this.waiters.push({test, resolve: done});
    });
  }

  /** False when the child's stdin is already gone (it exited). */
  send(object: Record<string, unknown>): boolean {
    try {
      this.child.stdin.write(JSON.stringify(object) + '\n');
      this.child.stdin.flush();
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(): void {
    try { this.child.stdin.end(); } catch {}
  }

  kill(signal: NodeJS.Signals): void {
    try { this.child.kill(signal); } catch {}
  }
}

const liveChildren = new Set<JsonLineChild>();
let cleanupInstalled = false;
function track(child: JsonLineChild): JsonLineChild {
  liveChildren.add(child);
  void child.exited.then(() => liveChildren.delete(child));
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    // Never leave a fixture host listening after the harness is gone.
    process.on('exit', () => { for (const live of liveChildren) live.kill('SIGKILL'); });
  }
  return child;
}

// MARK: - Sandbox

function sbplString(path: string): string {
  if (/["\\\n\r\0]/.test(path)) throw new Error(`refusing to put ${JSON.stringify(path)} in a sandbox profile`);
  return `"${path}"`;
}

/** Marks where this file's rules start in a profile; everything after it only narrows what comes before. */
export const FIXTURE_RULES_MARKER = ';; ScreenFixtureHost rules (scripts/emulator-e2e/screenFixtureHost.ts): appended, narrowing only';

export interface SandboxProfileOptions {
  /** Folders the process may write: its state, home, temporary and evidence folders. */
  writable: string[];
  /** The only programs it may run (the fixture binary itself). None may lie inside a writable folder. */
  executables: string[];
  /** The only loopback ports it may connect to (the stand-in phone: the fixture host's port). None by default: the host
   * only accepts connections. */
  outboundPorts?: number[];
  /** Ports that must never be in `outboundPorts`, on top of DENIED_PORTS. */
  deniedPorts?: number[];
  /** SBPL from the orchestrator's single generator (WP1's `ctx.hostSandbox.text`). This file's rules follow it. */
  base?: string;
  realHome?: string;
}

/**
 * SBPL for one fixture process (design §2.3): loopback only, no exec, signals inside the sandbox only, writes confined,
 * secrets unreadable, user-session services unreachable.
 *
 * Precedence, measured on this Mac (Darwin 25.5, 2026-11-01) with sandboxed `nc -z` against three loopback listeners
 * the probe opened itself (no other port touched): among filtered rules the later one wins. After a filtered
 * `(deny network-outbound (remote ip "*:*"))` and an allow for `localhost:*`, a later deny for one port refuses that
 * port (WP0-1 measured the same), and appending a deny-all plus a one-port allow after such a base leaves exactly that
 * port reachable. Only a profile that starts with an unfiltered `(deny network*)` ignores a later port deny. The note
 * that used to stand here — "a port deny after a wildcard allow never works" — was measured under that unfiltered
 * prefix and was wrong as a general statement; this generator no longer emits an unfiltered network deny at all.
 * The fixture still uses an outbound allowlist (empty for the host), so 3001/52741/4723 stay unreachable even when a
 * base allowed `localhost:*`; the generator also refuses them as allowlist entries.
 *
 * Order matters in one more, unexpected way: any `network-outbound` deny placed AFTER a one-port allow (a deny for an
 * unrelated port, or the unix-socket deny) made connections to the allowed port fail now and then with EPERM — 9 of 60
 * trials with a deny for `localhost:1` after it, 60 of 60 trials clean with the allow last (same Mac, same day). So the
 * outbound allowlist is the very last network rule, and every outbound deny comes before it. `localhost:*` followed by
 * port denies (WP1's base at cd89a7dd) showed no such failures in 60 trials. WP1's base since 5c8d645d is itself a
 * one-port loopback allowlist placed last, measured the same way there; this file's rules follow it, and the tests run
 * the fixture rules after WP1's real generator output as well as after both older shapes.
 *
 * Signals: `(deny signal (target others))` did NOT stop a sandboxed `kill -TERM` reaching an unrelated `sleep` (the
 * review measured it and so did this rework); `(deny signal)` followed by `(allow signal (target same-sandbox))` did.
 * The selfcheck's canaries re-measure every one of these on each run.
 */
export function screenFixtureSandboxProfile(options: SandboxProfileOptions): string {
  const home = canonical(options.realHome ?? realHome());
  const denied = new Set<number>([...DENIED_PORTS, ...(options.deniedPorts ?? [])]);
  for (const port of denied) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  const outbound = [...new Set(options.outboundPorts ?? [])];
  for (const port of outbound) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
    if (denied.has(port)) throw new Error(`refusing to let a fixture connect to port ${port}`);
  }
  const writable = uniqueRoots(options.writable).map(path => {
    if (!path.startsWith('/') || path === '/') throw new Error(`writable root must be an absolute folder below /: ${path}`);
    if (isInside(home, path)) throw new Error(`writable root ${path} would cover the real home`);
    return realpathSync(path);
  });
  if (!writable.length) throw new Error('a fixture needs at least one writable folder');
  const executables = options.executables.map(path => realpathSync(path));
  if (!executables.length) throw new Error('a fixture needs the one program it runs');
  for (const program of executables) {
    const covering = writable.find(root => isInside(program, root));
    if (covering) throw new Error(`refusing to run ${program}: it lies inside the writable folder ${covering}, so a fixture could replace it`);
  }
  if (options.base !== undefined && !options.base.trimStart().startsWith('(version 1)')) {
    throw new Error('a base sandbox profile must start with (version 1)');
  }
  const reads = deniedReadPaths(home);
  return [
    ...(options.base === undefined ? ['(version 1)', '(allow default)'] : [options.base.trimEnd()]),
    '',
    FIXTURE_RULES_MARKER,
    ';; exec: the fixture binary only',
    '(deny process-exec* (subpath "/"))',
    `(allow process-exec* ${executables.map(path => `(literal ${sbplString(path)})`).join(' ')})`,
    ';; signals: only inside this sandbox (a deny filtered to other targets lets signals through)',
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    ';; writes: the given folders only',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${writable.map(path => `(subpath ${sbplString(path)})`).join(' ')} (literal "/dev/null") (literal "/dev/dtracehelper"))`,
    ';; reads: no real app data, agent settings, keychains, credentials, shell rc or cloud storage',
    `(deny file-read* ${reads.map(path => existsSync(path) && statSync(path).isDirectory()
      ? `(subpath ${sbplString(path)})` : `(literal ${sbplString(path)})`).join(' ')})`,
    ';; the user session: TCC, WindowServer, keychain, Touch ID, pasteboard, LaunchServices, Apple Events, audio, HID',
    `(deny mach-lookup ${DENIED_MACH_SERVICES.map(name => `(global-name ${sbplString(name)})`).join(' ')})`,
    '(deny appleevent-send)',
    `(deny iokit-open ${DENIED_IOKIT_CLASSES.map(name => `(iokit-user-client-class ${sbplString(name)})`).join(' ')})`,
    ';; network: filtered rules only; loopback in except the never-ports, then the outbound allowlist LAST',
    '(deny network-outbound (remote ip "*:*"))',
    '(deny network-outbound (remote unix-socket (path-regex #"^/")))',
    ...[...denied].map(port => `(deny network-outbound (remote ip "localhost:${port}"))`),
    '(deny network-bind (local ip "*:*"))',
    '(deny network-inbound (local ip "*:*"))',
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    ...[...denied].map(port => `(deny network-bind (local ip "*:${port}"))`),
    ...[...denied].map(port => `(deny network-inbound (local ip "*:${port}"))`),
    ...outbound.map(port => `(allow network-outbound (remote ip "localhost:${port}"))`),
    '',
  ].join('\n');
}

/** The fixture rules of a generated profile (after the marker, comments dropped), for static checks. */
export function fixtureRules(profile: string): string[] {
  const index = profile.indexOf(FIXTURE_RULES_MARKER);
  return index < 0 ? [] : rulesOf(profile.slice(index + FIXTURE_RULES_MARKER.length));
}

function rulesOf(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith(';'));
}

/** Static shape the canaries back up: no unfiltered network deny anywhere, the signal pair, `allowedOutbound` exactly the
 * outbound allows after the marker, and those allows after every outbound deny (see the generator's comment). */
export function profileShapeProblems(profile: string, allowedOutbound: number[]): string[] {
  const problems: string[] = [];
  const all = rulesOf(profile);
  const rules = fixtureRules(profile);
  if (!rules.length) problems.push('no fixture rules marker');
  if (all.includes('(deny network*)')) problems.push('an unfiltered (deny network*) makes later port denies ineffective');
  if (all.some(line => line.includes('(target others)'))) problems.push('(target others) does not stop signals');
  const signal = rules.indexOf('(deny signal)');
  if (signal < 0 || rules[signal + 1] !== '(allow signal (target same-sandbox))') problems.push('signals are not confined to the sandbox');
  const denyAll = rules.indexOf('(deny network-outbound (remote ip "*:*"))');
  if (denyAll < 0) problems.push('no outbound deny-all after the base');
  const allows = rules.flatMap(line => /^\(allow network-outbound \(remote ip "localhost:(\d+)"\)\)$/.exec(line)?.[1] ?? []).map(Number);
  if (rules.some(line => line.startsWith('(allow network-outbound') && !/"localhost:\d+"/.test(line))) problems.push('a non-port outbound allow');
  if (JSON.stringify([...allows].sort()) !== JSON.stringify([...allowedOutbound].sort())) problems.push(`outbound allows ${allows.join(',') || 'none'} != ${allowedOutbound.join(',') || 'none'}`);
  const firstAllow = rules.findIndex(line => line.startsWith('(allow network-outbound'));
  if (firstAllow >= 0 && firstAllow < denyAll) problems.push('an outbound allow precedes the deny-all');
  if (firstAllow >= 0 && rules.slice(firstAllow).some(line => line.startsWith('(deny network-outbound'))) {
    problems.push('an outbound deny follows the outbound allowlist (makes the allowed port fail intermittently)');
  }
  for (const name of DENIED_MACH_SERVICES) if (!profile.includes(`(global-name "${name}")`)) problems.push(`${name} not denied`);
  return problems;
}

/** Writes a profile where no fixture can rewrite it: its folder must lie outside every folder a fixture may write. */
export function writeFixtureProfile(dir: string, name: string, profile: string, writable: string[]): {path: string; sha256: string} {
  const folder = canonical(dir);
  const covering = uniqueRoots(writable).find(root => isInside(folder, root));
  if (covering) throw new Error(`refusing to write a sandbox profile into ${folder}: a fixture may write ${covering}`);
  privateDirectory(folder);
  const path = join(folder, `${name.replace(/[^A-Za-z0-9_.-]/g, '-')}.sb`);
  writeFileSync(path, profile, {mode: 0o600});
  return {path, sha256: sha256(profile)};
}

function sha256(data: string | Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }

// MARK: - Build and nm gate

export interface NmGateResult {
  binary: string;
  sha256: string;
  passed: boolean;
  undefinedSymbols: number;
  requiredFound: string[];
  extendedFound: string[];
  frameworks: string[];
  forbiddenFrameworks: string[];
  noted: string[];
}

export interface ScreenFixtureBuild {
  outDir: string;
  hostBinary: string;
  viewerBinary: string;
  coreLibrary: string;
  hostSources: string[];
  seconds: number;
  gates: NmGateResult[];
}

function swiftFiles(dir: string): string[] {
  return readdirSync(dir).filter(name => name.endsWith('.swift')).sort().map(name => join(dir, name));
}

const FIXTURE_HOST_SOURCES = ['HostStreamer.swift', 'ScreenSessionBarModel.swift', 'ScreenSessionInputHold.swift'] as const;
/** The streamer and pure session-bar model, plus the fixture's synthetic capture and recorded input. */
export function hostSourceList(): string[] {
  return [...FIXTURE_HOST_SOURCES.map(name => join(HOST_DIR, name)), ...swiftFiles(FIXTURE_DIR), ...swiftFiles(join(FIXTURE_DIR, 'Shared'))];
}

/** Only the streamer and pure bar model may come from ScreenHost; the nm gate still rejects real OS effects. */
export function checkHostSourceList(sources: string[]): {passed: boolean; fromScreenHost: string[]; excludedPresent: string[]} {
  const fromScreenHost = sources.filter(path => isInside(path, HOST_DIR)).map(path => relative(HOST_DIR, path));
  const excludedPresent = sources.map(path => path.split('/').pop() ?? '').filter(name => (EXCLUDED_HOST_SOURCES as readonly string[]).includes(name));
  return {passed: fromScreenHost.length === FIXTURE_HOST_SOURCES.length && FIXTURE_HOST_SOURCES.every(name => fromScreenHost.includes(name)) && excludedPresent.length === 0,
    fromScreenHost, excludedPresent};
}

/** The last type is panel placement (CGRect), unrelated to state and pulls CoreGraphics into the gated host. Copy the
 * exact unchanged prefix into the build scratch; fail closed if the source no longer has this one known trailing type. */
export function barModelWithoutPlacement(source: string): string {
  const marker = '/// Where the bar opens.\npublic enum ScreenSessionBarPlacement {';
  const at = source.indexOf(marker);
  if (at < 0 || at !== source.lastIndexOf(marker)
      || sha256(source.slice(at)) !== 'a03b05a46265db8e6353c2405c0a1c1ef3ff399778d1db790ef405b8cd245f69') {
    throw new Error('bar model placement boundary changed; inspect the excluded suffix');
  }
  return source.slice(0, at);
}

async function toolchain(env: Record<string, string>): Promise<{swiftc: string; sdk: string; developerDir: string}> {
  const selected = await run(['/usr/bin/xcode-select', '-p'], {env, timeoutMs: 30_000});
  if (selected.code !== 0) throw new BlockedError('xcode-select -p failed: no developer directory');
  const developerDir = selected.stdout.trim();
  const toolEnv = {...env, DEVELOPER_DIR: developerDir};
  const swiftc = await run(['/usr/bin/xcrun', '--find', 'swiftc'], {env: toolEnv, timeoutMs: 60_000});
  const sdk = await run(['/usr/bin/xcrun', '--show-sdk-path', '--sdk', 'macosx'], {env: toolEnv, timeoutMs: 60_000});
  if (swiftc.code !== 0 || sdk.code !== 0) throw new BlockedError('xcrun cannot find swiftc or the macOS SDK');
  return {swiftc: swiftc.stdout.trim(), sdk: sdk.stdout.trim(), developerDir};
}

export class BlockedError extends Error {}

/** Builds ScreenControlCore (static module), the fixture host and the stand-in viewer into `outDir`, then gates both. */
export async function buildScreenFixture(options: {outDir: string; evidenceDir?: string; env?: Record<string, string>;
  scratchRoots?: string[]; realHome?: string}): Promise<ScreenFixtureBuild> {
  if (process.platform !== 'darwin') throw new BlockedError('the screen fixture host needs macOS');
  const started = performance.now();
  const outDir = privateDirectory(options.outDir);
  const env = options.env ?? fixtureEnvironment(privateDirectory(join(outDir, 'home')), privateDirectory(join(outDir, 'tmp')));
  assertFixtureEnvironment(env, options.scratchRoots ?? [outDir], options.realHome);
  const tools = await toolchain(env);
  const buildEnv = {...env, DEVELOPER_DIR: tools.developerDir};
  const common = ['-swift-version', '6', '-sdk', tools.sdk, '-module-cache-path', join(outDir, 'module-cache')];
  const compile = async (label: string, argv: string[]) => {
    const result = await run([tools.swiftc, ...common, ...argv], {env: buildEnv, cwd: outDir, timeoutMs: 600_000});
    if (options.evidenceDir) writeFileSync(join(options.evidenceDir, `build-${label}.log`), result.stdout + result.stderr, {mode: 0o600});
    if (result.code !== 0) throw new Error(`swiftc (${label}) failed${result.timedOut ? ' (timed out)' : ''}:\n${result.stderr.slice(-4000)}`);
  };
  const coreLibrary = join(outDir, 'libScreenControlCore.a');
  await compile('core', ['-parse-as-library', '-module-name', 'ScreenControlCore', '-emit-module', '-emit-module-path',
    join(outDir, 'ScreenControlCore.swiftmodule'), '-emit-library', '-static', '-o', coreLibrary, ...swiftFiles(CORE_DIR)]);
  const hostSources = hostSourceList();
  const listCheck = checkHostSourceList(hostSources);
  if (!listCheck.passed) throw new Error(`host compile list breaks the design: ${JSON.stringify(listCheck)}`);
  const link = ['-I', outDir, '-L', outDir, '-lScreenControlCore', '-Xlinker', '-dead_strip'];
  const hostBinary = join(outDir, 'screen-fixture-host'), viewerBinary = join(outDir, 'screen-fixture-viewer');
  const model = join(HOST_DIR, 'ScreenSessionBarModel.swift');
  const copiedModel = join(outDir, 'FixtureBarModel.swift');
  writeFileSync(copiedModel, barModelWithoutPlacement(readFileSync(model, 'utf8')), {mode: 0o600});
  const safeHostSources = hostSources.map(source => source === model ? copiedModel : source);
  await compile('host', ['-module-name', 'ScreenFixtureHost', ...link, ...safeHostSources, '-o', hostBinary]);
  await compile('viewer', ['-module-name', 'ScreenFixtureViewer', ...link, ...swiftFiles(join(FIXTURE_DIR, 'Viewer')),
    ...swiftFiles(join(FIXTURE_DIR, 'Shared')), '-o', viewerBinary]);
  const gates = [await nmGate(hostBinary, buildEnv), await nmGate(viewerBinary, buildEnv)];
  if (options.evidenceDir) writeFileSync(join(options.evidenceDir, 'nm-gate.txt'), gates.map(formatGate).join('\n'), {mode: 0o600});
  return {outDir, hostBinary, viewerBinary, coreLibrary, hostSources: hostSources.map(path => relative(REPO_ROOT, path)),
    seconds: Math.round(performance.now() - started) / 1000, gates};
}

/** The gate verdict from `nm -u` and `otool -L` output. */
export function evaluateGate(binary: string, binarySha256: string, nmOutput: string, otoolOutput: string): NmGateResult {
  const symbols = nmOutput.split('\n').map(line => line.trim()).filter(Boolean);
  const found = (names: readonly string[]) => names.filter(name => symbols.some(symbol => symbol.includes(name)));
  const frameworks = otoolOutput.split('\n').slice(1).map(line => line.trim().split(' (')[0] ?? '').filter(Boolean);
  const forbiddenFrameworks = FORBIDDEN_FRAMEWORKS.filter(name => frameworks.some(path => path.includes(`/${name}.framework/`)));
  const requiredFound = found(NM_GATE_REQUIRED), extendedFound = found(NM_GATE_EXTENDED);
  return {binary, sha256: binarySha256, undefinedSymbols: symbols.length, requiredFound, extendedFound, frameworks,
    forbiddenFrameworks, noted: found(NOTED_SYMBOLS),
    passed: requiredFound.length === 0 && extendedFound.length === 0 && forbiddenFrameworks.length === 0};
}

/** `nm -u` and `otool -L` on a linked fixture binary. */
export async function nmGate(binary: string, env: Record<string, string>): Promise<NmGateResult> {
  const nm = await run(['/usr/bin/nm', '-u', binary], {env, timeoutMs: 60_000});
  const otool = await run(['/usr/bin/otool', '-L', binary], {env, timeoutMs: 60_000});
  if (nm.code !== 0 || otool.code !== 0) throw new Error(`nm/otool failed on ${binary}: ${nm.stderr}${otool.stderr}`);
  return evaluateGate(binary, sha256(readFileSync(binary)), nm.stdout, otool.stdout);
}

/** Refuses to start `binary` unless every gate of its build passed and the binary is still the one that was gated. */
export function assertGatedBinary(build: ScreenFixtureBuild, binary: string): void {
  if (!build.gates.length || !build.gates.every(gate => gate.passed)) {
    const failed = build.gates.filter(gate => !gate.passed).map(gate => basename(gate.binary));
    throw new Error(`the nm gate did not pass (${failed.join(', ') || 'no gate ran'}): refusing to start ${basename(binary)}`);
  }
  const gate = build.gates.find(item => item.binary === binary);
  if (!gate) throw new Error(`${binary} was never gated: refusing to start it`);
  if (sha256(readFileSync(binary)) !== gate.sha256) throw new Error(`${binary} changed after the nm gate: refusing to start it`);
}

export function formatGate(gate: NmGateResult): string {
  const row = (name: string, present: boolean) => `  ${present ? 'PRESENT' : 'absent '} ${name}`;
  return [
    `binary: ${gate.binary}`, `sha256: ${gate.sha256}`, `nm -u: ${gate.undefinedSymbols} undefined symbols`,
    'required absent (design J2-SCREEN-SIM):', ...NM_GATE_REQUIRED.map(name => row(name, gate.requiredFound.includes(name))),
    'also absent (capture, injection, TCC, window, keychain item, clipboard):',
    ...NM_GATE_EXTENDED.map(name => row(name, gate.extendedFound.includes(name))),
    'linked libraries (otool -L):', ...gate.frameworks.map(path => `  ${path}`),
    `forbidden frameworks linked: ${gate.forbiddenFrameworks.length ? gate.forbiddenFrameworks.join(', ') : 'none'}`,
    `noted, not refused (ScreenControlCore phone-side signer code; never called by the fixture, its services denied by the sandbox): ${gate.noted.join(', ') || 'none'}`,
    `verdict: ${gate.passed ? 'PASS' : 'FAIL'}`, '',
  ].join('\n');
}

// MARK: - Production source hashes

const PRODUCTION_SOURCE_PATHS = ['native/screen-control/Sources', 'native/screen-control/Package.swift'] as const;

/** SHA-256 of every file under native/screen-control/Sources and of Package.swift, by repository path. */
export function hashProductionSources(root = REPO_ROOT): {files: Record<string, string>; digest: string} {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files[relative(root, path)] = sha256(readFileSync(path));
    }
  };
  walk(join(root, 'native', 'screen-control', 'Sources'));
  files['native/screen-control/Package.swift'] = sha256(readFileSync(join(root, 'native', 'screen-control', 'Package.swift')));
  return {files, digest: sha256(Object.entries(files).map(([path, hash]) => `${hash}  ${path}`).join('\n'))};
}

export interface SourcesVsMain {
  measured: boolean;
  /** Why it could not be measured (no git metadata, as in a git-archive copy; no main ref). */
  reason?: string;
  ref?: string;
  base?: string;
  /** Production screen files that differ between the main merge base and this working tree (committed or not). */
  changed?: string[];
}

/** Whether this checkout's production screen sources (working tree) equal those at its merge base with main. */
export function productionSourcesVsMain(root = REPO_ROOT): SourcesVsMain {
  const git = (args: string[]) => {
    const out = Bun.spawnSync(['/usr/bin/git', '-C', root, ...args], {stdout: 'pipe', stderr: 'ignore',
      env: {PATH: '/usr/bin:/bin', HOME: '/var/empty', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0'}});
    return out.exitCode === 0 ? out.stdout.toString().trim() : null;
  };
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top || canonical(top) !== canonical(root)) return {measured: false, reason: 'no git metadata for this checkout (a git-archive copy)'};
  for (const ref of ['main', 'origin/main']) {
    const base = git(['merge-base', 'HEAD', ref]);
    if (!base) continue;
    const changed = git(['diff', '--name-only', base, '--', ...PRODUCTION_SOURCE_PATHS]);
    if (changed === null) return {measured: false, reason: `git diff against ${ref} failed`, ref, base};
    return {measured: true, ref, base, changed: changed.split('\n').filter(Boolean)};
  }
  return {measured: false, reason: 'neither main nor origin/main is known to this checkout'};
}

// MARK: - Host

export interface ScreenFixtureStartOptions {
  mode: ScreenFixtureMode;
  build: ScreenFixtureBuild;
  /** Scratch for this host: pins.json / invites.json (private keys, one-time codes) land here, owner-only. */
  stateDir: string;
  /** host-receipts.jsonl, input-events.jsonl, frames.json, host-stderr.log. */
  evidenceDir: string;
  /** Base64 of 65-byte uncompressed P-256 public keys to pin at start (pinned-device). */
  devicePublicKeys?: string[];
  framesPerSecond?: number;
  /** `WIDTHxHEIGHT[,WIDTHxHEIGHT…]`, the main display first. */
  displays?: string;
  idleSeconds?: number;
  /** An environment the orchestrator built (it is still checked); by default one is built from empty here. */
  env?: Record<string, string>;
  /** Where that environment's path-valued keys may live; by default the state folder. */
  scratchRoots?: string[];
  /** SBPL from the orchestrator's single generator (`ctx.hostSandbox.text`); this file's rules are appended to it. */
  sandboxBase?: string;
  /** Where the generated profile is written; never inside a folder the host may write. Default: `<stateDir>.profile`. */
  profileDir?: string;
  realHome?: string;
  readyTimeoutMs?: number;
}

export interface ScreenFixtureHost {
  mode: ScreenFixtureMode;
  pid: number;
  ready: JsonEvent;
  port?: number;
  pinsPath?: string;
  invitesPath?: string;
  evidence: {receipts: string; inputEvents: string; frames: string; stderr: string};
  sandboxProfilePath: string;
  sandboxProfileSha256: string;
  exited: Promise<number>;
  command(op: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<JsonEvent>;
  /** Ends the running session from the Mac; the phone hears `reason`. Recorded as a scripted Mac action. */
  endSession(reason?: string): Promise<JsonEvent>;
  pinDevice(publicKeyBase64: string): Promise<JsonEvent>;
  status(): Promise<JsonEvent>;
  stop(): Promise<{exitCode: number; why?: unknown}>;
}

/** Starts the fixture host inside sandbox-exec and waits for its `ready` line. Refuses an ungated binary. */
export async function start(options: ScreenFixtureStartOptions): Promise<ScreenFixtureHost> {
  assertGatedBinary(options.build, options.build.hostBinary);
  const stateDir = privateDirectory(options.stateDir), evidenceDir = privateDirectory(options.evidenceDir);
  const env = options.env ?? fixtureEnvironment(privateDirectory(join(stateDir, 'home')), privateDirectory(join(stateDir, 'tmp')));
  assertFixtureEnvironment(env, options.scratchRoots ?? [stateDir], options.realHome);
  const writable = uniqueRoots([stateDir, evidenceDir, ...homeAndTemporary(env)]);
  // The host only accepts connections: no outbound port at all.
  const profile = screenFixtureSandboxProfile({writable, executables: [options.build.hostBinary], base: options.sandboxBase,
    realHome: options.realHome});
  const written = writeFixtureProfile(options.profileDir ?? `${stateDir}.profile`, 'screen-fixture-host', profile, writable);
  const args = ['--mode', options.mode, '--state-dir', stateDir, '--evidence-dir', evidenceDir];
  for (const key of options.devicePublicKeys ?? []) args.push('--device-public-key', key);
  if (options.framesPerSecond) args.push('--fps', String(options.framesPerSecond));
  if (options.displays) args.push('--displays', options.displays);
  if (options.idleSeconds) args.push('--idle-seconds', String(options.idleSeconds));
  const child = track(new JsonLineChild([SANDBOX_EXEC, '-f', written.path, options.build.hostBinary, ...args], env, stateDir));
  const stderrPath = join(evidenceDir, 'host-stderr.log');
  void child.stderr.then(text => writeFileSync(stderrPath, text, {mode: 0o600}));
  const ready = await child.waitFor(event => ['ready', 'error', 'closed'].includes(String(event.event)), options.readyTimeoutMs ?? 20_000,
    'the fixture host to be ready').catch(error => { child.kill('SIGKILL'); throw error; });
  if (ready.event !== 'ready') {
    child.kill('SIGKILL');
    throw new Error(`fixture host did not start: ${JSON.stringify(ready)} ${await child.stderr}`);
  }
  let commands = 0;
  const command = async (op: string, fields: Record<string, unknown> = {}, timeoutMs = 15_000) => {
    const id = ++commands;
    child.send({...fields, id, op});
    return child.waitFor(event => event.event === 'reply' && event.id === id, timeoutMs, `reply to ${op}`);
  };
  let stopping: Promise<{exitCode: number; why?: unknown}> | undefined;
  return {
    mode: options.mode,
    pid: child.pid,
    ready,
    port: typeof ready.port === 'number' ? ready.port : undefined,
    pinsPath: typeof ready.pinsPath === 'string' ? ready.pinsPath : undefined,
    invitesPath: typeof ready.invitesPath === 'string' ? ready.invitesPath : undefined,
    evidence: {receipts: join(evidenceDir, 'host-receipts.jsonl'), inputEvents: join(evidenceDir, 'input-events.jsonl'),
      frames: join(evidenceDir, 'frames.json'), stderr: stderrPath},
    sandboxProfilePath: written.path,
    sandboxProfileSha256: written.sha256,
    exited: child.exited,
    command,
    endSession: (reason = 'endedAtMac') => command('end', {reason}),
    pinDevice: publicKey => command('pin-device', {publicKey}),
    status: () => command('status'),
    stop: () => stopping ??= (async () => {
      child.send({op: 'stop'});
      child.closeStdin();
      const late = (ms: number) => new Promise<'late'>(resolve => setTimeout(() => resolve('late'), ms));
      if (await Promise.race([child.exited, late(10_000)]) === 'late') {
        child.kill('SIGTERM');
        if (await Promise.race([child.exited, late(5_000)]) === 'late') child.kill('SIGKILL');
      }
      const exitCode = await child.exited;
      await child.stderr;
      return {exitCode, why: child.events.find(event => event.event === 'stopped')?.why};
    })(),
  };
}

export async function stop(host: ScreenFixtureHost): Promise<{exitCode: number; why?: unknown}> { return host.stop(); }

/** What `serve` prints for a caller's command: the host's reply carrying the caller's own `id` (none if it sent none),
 * never the internal counter `start` uses to match replies. */
export function replyForCaller(command: Record<string, unknown>, reply: JsonEvent): JsonEvent {
  const {id: _internal, ...rest} = reply;
  return 'id' in command ? {...rest, id: command.id} : rest;
}

// MARK: - Observation

/** Listening TCP sockets from `lsof -Fn` output: `n127.0.0.1:5000`, `n[::1]:5000`, `n*:5000`. */
export function parseLsofListeners(output: string): {address: string; port: number}[] {
  return output.split('\n').filter(line => line.startsWith('n')).flatMap(line => {
    const match = /^(\[[^\]]+\]|[^:\s]+):(\d+)$/.exec(line.slice(1).trim());
    return match?.[1] && match[2] ? [{address: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2])}] : [];
  });
}

/** Every listener on 127.0.0.1, each expected port among them, none of the never-ports. */
export function loopbackOnlyVerdict(listeners: {address: string; port: number}[], expectedPorts: number[]): {passed: boolean; problems: string[]} {
  const problems: string[] = [];
  if (!listeners.length) problems.push('no listening socket observed');
  for (const listener of listeners) if (listener.address !== '127.0.0.1') problems.push(`listening on ${listener.address}:${listener.port}`);
  for (const port of expectedPorts) if (!listeners.some(listener => listener.port === port)) problems.push(`port ${port} not listening`);
  for (const listener of listeners) if ((DENIED_PORTS as readonly number[]).includes(listener.port)) problems.push(`listening on never-port ${listener.port}`);
  return {passed: problems.length === 0, problems};
}

/** The bound addresses of a process's listening TCP sockets, measured with lsof (not what the host says it asked for). */
async function listeningSockets(pid: number, env: Record<string, string>): Promise<{address: string; port: number}[]> {
  const listed = await run(['/usr/sbin/lsof', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-nP', '-Fn'], {env, timeoutMs: 20_000});
  return parseLsofListeners(listed.stdout);
}

/** Files a process has open under the real secrets and app data, by `lsof -p` (observation only, design §2.3). */
async function forbiddenOpenFiles(pid: number, env: Record<string, string>, home: string): Promise<string[]> {
  const listed = await run(['/usr/sbin/lsof', '-p', String(pid), '-Fn'], {env, timeoutMs: 20_000});
  const forbidden = deniedReadPaths(home);
  return listed.stdout.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1))
    .filter(path => forbidden.some(root => isInside(path, root)));
}

export interface TccBucket { requests: number; preflightOnly: number; prompts: number; services: Record<string, number> }
export interface TccObservation {
  observed: boolean;
  error?: string;
  /** Log entries read for the run window (tccd AUTHREQ lines and launchd lines naming the fixture). */
  entries: number;
  /** AUTHREQ_CTX records whose request id and service the parser recognised, for any process. Zero means the log format
   * changed or nothing was logged: the run cannot tell whether a prompt appeared, so it does not pass. */
  recognizedRequests: number;
  /** AUTHREQ_ATTRIBUTION records whose accessor the parser recognised, for any process. */
  recognizedAttributions: number;
  /** TCC requests whose accessor was a fixture binary (screen-fixture-host / -viewer). */
  fixture: TccBucket;
  /** Requests for the system VideoToolbox services the real encoder runs in; other apps may share these. */
  videoToolboxService: TccBucket;
  /** Mach lookups launchd refused a fixture binary with "Sandbox restriction", by service. */
  deniedLookups: Record<string, number>;
}

function localLogTime(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** Counts from `log show --style ndjson` output; only counts are kept, never log text. */
export function summarizeTccLog(ndjson: string): Omit<TccObservation, 'observed' | 'error'> {
  const empty = (): TccBucket => ({requests: 0, preflightOnly: 0, prompts: 0, services: {}});
  const observation: Omit<TccObservation, 'observed' | 'error'> = {entries: 0, recognizedRequests: 0, recognizedAttributions: 0,
    fixture: empty(), videoToolboxService: empty(), deniedLookups: {}};
  const requests = new Map<string, {service?: string; preflight?: boolean; accessor?: string; prompted: boolean}>();
  const entry = (id: string) => requests.get(id) ?? requests.set(id, {prompted: false}).get(id)!;
  for (const line of ndjson.split('\n')) {
    if (!line.startsWith('{')) continue;
    let message: string;
    try { message = String((JSON.parse(line) as {eventMessage?: unknown}).eventMessage ?? ''); } catch { continue; }
    observation.entries += 1;
    const id = /msgID=([0-9.]+)/.exec(message)?.[1];
    const denied = /denied lookup: name = ([^,]+), .*requestor = screen-fixture-.*Sandbox restriction/.exec(message);
    if (denied?.[1]) observation.deniedLookups[denied[1]] = (observation.deniedLookups[denied[1]] ?? 0) + 1;
    if (!id) continue;
    if (message.includes('AUTHREQ_CTX:')) {
      const item = entry(id);
      item.service = /service=([A-Za-z]+)/.exec(message)?.[1];
      item.preflight = /preflight=yes/.test(message);
      if (item.service) observation.recognizedRequests += 1;
    } else if (message.includes('AUTHREQ_ATTRIBUTION:')) {
      const accessor = /accessing=\{TCCDProcess: identifier=([^,]+)/.exec(message)?.[1];
      entry(id).accessor = accessor;
      if (accessor) observation.recognizedAttributions += 1;
    } else if (message.includes('AUTHREQ_PROMPTING')) {
      entry(id).prompted = true;
    }
  }
  for (const item of requests.values()) {
    const bucket = item.accessor?.startsWith('screen-fixture-') ? observation.fixture
      : item.accessor === 'com.apple.coremedia.videoencoder' || item.accessor === 'com.apple.coremedia.videodecoder' ? observation.videoToolboxService
      : undefined;
    if (!bucket) continue;
    bucket.requests += 1;
    if (item.preflight) bucket.preflightOnly += 1;
    if (item.prompted) bucket.prompts += 1;
    const service = item.service ?? 'unknown';
    bucket.services[service] = (bucket.services[service] ?? 0) + 1;
  }
  return observation;
}

/** No prompt for anything the run started, the fixture only ever preflighted, and the log was demonstrably readable. */
export function tccVerdict(tcc: TccObservation): {passed: boolean; why: string} {
  if (!tcc.observed) return {passed: false, why: `the unified log was not read: ${tcc.error ?? 'unknown'}`};
  if (tcc.recognizedRequests === 0 || tcc.recognizedAttributions === 0) {
    return {passed: false, why: 'no TCC request was recognised in the run window: the log format changed or nothing was logged, so "no prompt" cannot be told apart from "not seen"'};
  }
  if (tcc.fixture.prompts || tcc.videoToolboxService.prompts) return {passed: false, why: 'a TCC prompt was logged for the fixture or its encoder'};
  if (tcc.fixture.preflightOnly !== tcc.fixture.requests) return {passed: false, why: 'the fixture made a TCC request that was not a preflight'};
  return {passed: true, why: `${tcc.recognizedRequests} TCC requests recognised, none prompted for the fixture`};
}

/**
 * What tccd and launchd logged about the fixture since `since` (design: "TCC prompt 0"). Read-only: the unified log is
 * queried, never TCC itself. A preflight query never shows a prompt; tccd logs AUTHREQ_PROMPTING when it does show one.
 */
export async function observeTcc(since: Date, env: Record<string, string>): Promise<TccObservation> {
  await Bun.sleep(1000);
  const shown = await run(['/usr/bin/log', 'show', '--start', localLogTime(new Date(since.getTime() - 1000)), '--style', 'ndjson',
    '--predicate', '(process == "tccd" AND eventMessage CONTAINS "AUTHREQ") OR (process == "launchd" AND eventMessage CONTAINS "screen-fixture")'],
    {env, timeoutMs: 120_000});
  if (shown.code !== 0) {
    return {...summarizeTccLog(''), observed: false, error: `log show exited ${shown.code}${shown.timedOut ? ' (timed out)' : ''}`};
  }
  return {...summarizeTccLog(shown.stdout), observed: true};
}

// MARK: - Selfcheck

export interface SelfcheckCheck { name: string; passed: boolean; detail?: unknown; atSeconds?: number }
export interface SelfcheckReport {
  lane: 'screen-host-selfcheck';
  status: LaneStatus;
  blockedReason?: string;
  label: typeof SCREEN_FIXTURE_LABEL;
  checks: SelfcheckCheck[];
  evidenceDir: string;
  seconds: number;
  build?: {seconds: number; hostSources: string[]; hostSha256: string; viewerSha256: string};
  sandboxProfileSha256?: string;
  /** The orchestrator's base profile (WP1), when this ran as a lane. */
  sandboxBaseSha256?: string;
  /** Within this run: the build and the hosts did not touch production sources. */
  sourcesDigest?: {before: string; after: string};
  /** Against main: whether this checkout changes production screen sources at all. */
  sourcesVsMain?: SourcesVsMain;
}

function readJsonLines(path: string): JsonEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as JsonEvent);
}

function deepEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

async function waitUntil(test: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline) return test();
    await Bun.sleep(50);
  }
  return true;
}

/** A P-256 key for the pinned-device lane: the stand-in phone's private scalar and its uncompressed public point. */
function softwareDeviceKey(): {publicKey: string; privateKey: string} {
  const {privateKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const jwk = privateKey.export({format: 'jwk'}) as {x: string; y: string; d: string};
  const bytes = (value: string) => Buffer.from(value, 'base64url');
  return {publicKey: Buffer.concat([Buffer.from([4]), bytes(jwk.x), bytes(jwk.y)]).toString('base64'), privateKey: bytes(jwk.d).toString('base64')};
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePort(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function connectOnce(port: number): Promise<boolean> {
  return new Promise(resolveConnected => {
    const socket = createConnection({host: '127.0.0.1', port}, () => { socket.destroy(); resolveConnected(true); });
    socket.once('error', () => resolveConnected(false));
    socket.setTimeout(3000, () => { socket.destroy(); resolveConnected(false); });
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface CanaryOptions {
  /** The canary processes' own scratch (their only writable folder). */
  scratch: FixtureEnvironment;
  profileDir: string;
  base?: string;
  realHome: string;
  sandboxExec: string;
}

/** Canaries for the profile generator on harmless targets (design §2.3): every one must be refused, every control allowed. */
export async function sandboxCanaries(options: CanaryOptions): Promise<SelfcheckCheck[]> {
  const checks: SelfcheckCheck[] = [];
  const {env} = options.scratch;
  const cwd = env.HOME ?? options.scratch.root;
  const writable = homeAndTemporary(env);
  const profileFile = (name: string, profile: string) => writeFixtureProfile(options.profileDir, `canary-${name}`, profile, writable).path;
  const generate = (executables: string[], outboundPorts: number[] = []) =>
    screenFixtureSandboxProfile({writable, executables, outboundPorts, base: options.base, realHome: options.realHome});
  const sandboxed = (profile: string, argv: string[]) => run([options.sandboxExec, '-f', profile, ...argv], {env, cwd, timeoutMs: 20_000});
  const denied = createServer(socket => socket.destroy()), allowed = createServer(socket => socket.destroy());
  const deniedPort = await listen(denied), allowedPort = await listen(allowed);
  // An unrelated process the canary tries to signal: owned by this harness, harmless if the sandbox fails.
  const bystander = Bun.spawn(['/bin/sleep', '60'], {stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: {PATH: '/usr/bin:/bin'}});
  try {
    // The stand-in phone's shape: one allowed loopback port. A listening port outside the list stands for 3001, 52741
    // and 4723, which are never touched. /bin/sh re-executes /bin/bash, so both are allowed here.
    const tools = profileFile('tools', generate(['/usr/bin/nc', '/usr/bin/touch', '/bin/ls', '/bin/sh', '/bin/bash'], [allowedPort]));
    const execOnly = profileFile('exec', generate(['/usr/bin/true']));
    const open = await sandboxed(execOnly, ['/usr/bin/open', '-h']);
    checks.push({name: 'sandbox-canary-exec-denied', passed: open.code !== 0 && /not permitted/i.test(open.stderr),
      detail: {code: open.code, stderr: open.stderr.trim().slice(0, 200)}});
    const refused = await sandboxed(tools, ['/usr/bin/nc', '-z', '-w', '2', '127.0.0.1', String(deniedPort)]);
    const reached = await sandboxed(tools, ['/usr/bin/nc', '-z', '-w', '2', '127.0.0.1', String(allowedPort)]);
    checks.push({name: 'sandbox-canary-port-outside-allowlist-refused', passed: refused.code !== 0, detail: {port: deniedPort, code: refused.code}});
    checks.push({name: 'sandbox-canary-allowed-loopback-port', passed: reached.code === 0, detail: {port: allowedPort, code: reached.code}});
    const target = join(REPO_ROOT, '.screen-fixture-write-canary');
    const wrote = await sandboxed(tools, ['/usr/bin/touch', target]);
    const leaked = existsSync(target);
    if (leaked) rmSync(target, {force: true});
    checks.push({name: 'sandbox-canary-write-outside-scratch-denied', passed: wrote.code !== 0 && !leaked, detail: {target, code: wrote.code}});
    const appData = join(options.realHome, 'Library', 'Application Support', 'com.portmanager.portmanager');
    const readTarget = existsSync(appData) ? appData : join(options.realHome, '.claude');
    // `ls -d` only looks the folder itself up, so even a broken profile would read nothing inside it; only the exit code
    // is kept.
    const listed = await sandboxed(tools, ['/bin/ls', '-d', readTarget]);
    const control = await sandboxed(tools, ['/bin/ls', '-d', cwd]);
    checks.push({name: 'sandbox-canary-real-app-data-unreadable', passed: existsSync(readTarget) && listed.code !== 0 && control.code === 0,
      detail: {target: readTarget, code: listed.code, controlCode: control.code}});
    // Signals: SIGTERM to the bystander must be refused and the bystander must live; signalling itself must work.
    const signal = await sandboxed(tools, ['/bin/sh', '-c', `kill -TERM ${bystander.pid}`]);
    const self = await sandboxed(tools, ['/bin/sh', '-c', 'kill -0 $$']);
    await Bun.sleep(200);
    const survived = bystander.exitCode === null && bystander.signalCode === null && alive(bystander.pid);
    checks.push({name: 'sandbox-canary-signal-outside-sandbox-refused', passed: signal.code !== 0 && survived && self.code === 0,
      detail: {code: signal.code, stderr: signal.stderr.trim().slice(0, 200), bystanderAlive: survived, selfSignalCode: self.code}});
    const hostProfile = generate(['/usr/bin/true']);
    const refusedPorts = DENIED_PORTS.filter(port => {
      try { generate(['/usr/bin/true'], [port]); return false; } catch { return true; }
    });
    const problems = [...profileShapeProblems(hostProfile, []), ...profileShapeProblems(generate(['/usr/bin/true'], [allowedPort]), [allowedPort])];
    checks.push({name: 'sandbox-profile-static', passed: problems.length === 0 && refusedPorts.length === DENIED_PORTS.length,
      detail: {problems, generatorRefusesPorts: refusedPorts, base: options.base === undefined ? 'standalone' : sha256(options.base)}});
  } finally {
    bystander.kill('SIGKILL');
    await bystander.exited;
    denied.close();
    allowed.close();
  }
  return checks;
}

interface ViewerContext {
  build: ScreenFixtureBuild;
  phone: FixtureEnvironment;
  profileDir: string;
  base?: string;
  realHome: string;
  sandboxExec: string;
  launches: number;
}

/** The stand-in phone, sandboxed like the host, that may connect to the host's port only (none for parse-invites). It
 * may write its own home and temporary folders only; its profile is regenerated on every launch, outside them. */
function viewerChild(context: ViewerContext, args: string[], port?: number): JsonLineChild {
  assertGatedBinary(context.build, context.build.viewerBinary);
  const writable = homeAndTemporary(context.phone.env);
  const profile = screenFixtureSandboxProfile({writable, executables: [context.build.viewerBinary], outboundPorts: port ? [port] : [],
    base: context.base, realHome: context.realHome});
  const written = writeFixtureProfile(context.profileDir, `screen-fixture-viewer-${++context.launches}`, profile, writable);
  return track(new JsonLineChild([context.sandboxExec, '-f', written.path, context.build.viewerBinary, ...args], context.phone.env,
    context.phone.env.HOME ?? context.phone.root));
}

async function viewerOnce(context: ViewerContext, args: string[], timeoutMs: number, port?: number):
  Promise<{events: JsonEvent[]; code: number; last: JsonEvent | undefined}> {
  const child = viewerChild(context, args, port);
  const late = new Promise<'late'>(resolveLate => setTimeout(() => resolveLate('late'), timeoutMs));
  if (await Promise.race([child.exited, late]) === 'late') child.kill('SIGKILL');
  const code = await child.exited;
  await Bun.sleep(20);
  return {events: child.events, code, last: child.events.at(-1)};
}

export interface SelfcheckOptions {
  /** New or empty. Default: mobile/ios/build/emulator-evidence/screen-host-selfcheck-<time>. */
  evidenceDir?: string;
  /** Parent of the run's own work folder (a fresh mkdtemp, the only thing deleted afterwards). Outside the real home. */
  workParent?: string;
  keep?: boolean;
  /** Under the orchestrator: an allowlisted environment per process role (ctx.isolatedProfile + ctx.allowlistedEnv). */
  environmentFor?: (role: string) => FixtureEnvironment;
  /** Where those environments live (ctx.scratchRoot); default the work folder. */
  scratchRoots?: string[];
  /** The orchestrator's base profile (ctx.hostSandbox.text). */
  sandboxBase?: string;
  realHome?: string;
  /** For tests: a sandbox-exec path (a missing one ends the run as blocked before anything starts). */
  sandboxExecPath?: string;
  log?: (line: string) => void;
}

/**
 * WP7 verification: build, nm gate (nothing runs if it fails), sandbox canaries, then each mode against the macOS
 * stand-in viewer on Core's ScreenViewer over loopback — at least 30 pictures read back in order, the recorded input
 * equal to what was sent, the Mac's end reason heard, an impostor key refused, pinning and invitation counting, every
 * listener measured on 127.0.0.1 — and production sources untouched by the run and, where git can tell, unchanged
 * from main.
 */
export async function selfcheck(options: SelfcheckOptions = {}): Promise<SelfcheckReport> {
  const started = performance.now(), startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, '-');
  const home = canonical(options.realHome ?? realHome());
  const sandboxExec = options.sandboxExecPath ?? SANDBOX_EXEC;
  const say = options.log ?? ((line: string) => console.log(line));
  const evidenceDir = freshEvidenceDirectory(options.evidenceDir ?? join(REPO_ROOT, 'mobile', 'ios', 'build', 'emulator-evidence', `screen-host-selfcheck-${runId}`));
  const work = createSelfcheckWorkDir(options.workParent, home);
  const checks: SelfcheckCheck[] = [];
  const check = (name: string, passed: boolean, detail?: unknown) => {
    const atSeconds = Math.round(performance.now() - started) / 1000;
    checks.push({name, passed, detail, atSeconds});
    say(`${passed ? 'pass' : 'FAIL'}  ${atSeconds.toFixed(1).padStart(5)}s  ${name}${passed || detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 600)}`}`);
  };
  const report: SelfcheckReport = {lane: 'screen-host-selfcheck', status: 'fail', label: SCREEN_FIXTURE_LABEL, checks, evidenceDir, seconds: 0};
  if (options.sandboxBase !== undefined) report.sandboxBaseSha256 = sha256(options.sandboxBase);
  const finish = (status: LaneStatus, blockedReason?: string) => {
    report.status = status;
    if (blockedReason) report.blockedReason = blockedReason;
    report.seconds = Math.round(performance.now() - started) / 1000;
    writeFileSync(join(evidenceDir, 'selfcheck-report.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    // Only the folder this run made; never the parent it was given.
    if (!options.keep) rmSync(work, {recursive: true, force: true});
    return report;
  };
  try {
    if (process.platform !== 'darwin') return finish('blocked', 'not macOS');
    if (!existsSync(sandboxExec)) return finish('blocked', `${sandboxExec} is missing`);
    const scratchRoots = options.scratchRoots ?? [work];
    const environmentFor = (role: string) => {
      const made = options.environmentFor?.(role) ?? standaloneEnvironment(work, role);
      assertFixtureEnvironment(made.env, scratchRoots, home);
      return made;
    };
    const tools = environmentFor('tools');
    // Profiles and binaries live in folders no fixture may write (each writable list is checked against them).
    const profileDir = privateDirectory(join(work, 'profiles'));
    const before = hashProductionSources();

    let build: ScreenFixtureBuild;
    try {
      build = await buildScreenFixture({outDir: join(work, 'build'), evidenceDir, env: environmentFor('build').env, scratchRoots, realHome: home});
    } catch (error) {
      if (error instanceof BlockedError) return finish('blocked', error.message);
      throw error;
    }
    report.build = {seconds: build.seconds, hostSources: build.hostSources, hostSha256: build.gates[0]?.sha256 ?? '',
      viewerSha256: build.gates[1]?.sha256 ?? ''};
    check('build', true, {seconds: build.seconds});
    check('host-compile-list', checkHostSourceList(hostSourceList()).passed, checkHostSourceList(hostSourceList()));
    for (const gate of build.gates) {
      check(`nm-gate-${gate.binary.endsWith('host') ? 'host' : 'viewer'}`, gate.passed,
        {requiredFound: gate.requiredFound, extendedFound: gate.extendedFound, forbiddenFrameworks: gate.forbiddenFrameworks});
    }
    // An ungated binary never runs: stop here (start() and the viewer refuse it as well).
    if (!build.gates.every(gate => gate.passed)) return finish('fail');
    const canaries = await sandboxCanaries({scratch: environmentFor('canary'), profileDir: join(profileDir, 'canary'), base: options.sandboxBase,
      realHome: home, sandboxExec});
    for (const canary of canaries) check(canary.name, canary.passed, canary.detail);
    // A sandbox that does not hold is not a place to run the fixture.
    if (!canaries.every(canary => canary.passed)) return finish('fail');

    const viewerContext: ViewerContext = {build, phone: environmentFor('phone'), profileDir: join(profileDir, 'phone'), base: options.sandboxBase,
      realHome: home, sandboxExec, launches: 0};
    const startHost = (mode: ScreenFixtureMode, label: string, evidence: string) => {
      const hostEnvironment = environmentFor(`host-${label}`);
      return start({mode, build, stateDir: join(work, `state-${label}`), evidenceDir: evidence, env: hostEnvironment.env, scratchRoots,
        sandboxBase: options.sandboxBase, profileDir: join(profileDir, `host-${label}`), realHome: home}).then(host => ({host, env: hostEnvironment.env}));
    };
    const expectedKeys = (env: Record<string, string>) => [...Object.keys(env), '__CF_USER_TEXT_ENCODING'];

    // viewer: the J2-SCREEN-SIM host as the probe will meet it.
    {
      const evidence = privateDirectory(join(evidenceDir, 'viewer'));
      const {host, env: hostEnv} = await startHost('viewer', 'viewer', evidence);
      report.sandboxProfileSha256 = host.sandboxProfileSha256;
      try {
        const keys = (host.ready.environmentKeys as string[] | undefined) ?? [];
        check('host-environment-allowlisted', keys.every(key => expectedKeys(hostEnv).includes(key))
          && canonical(String(host.ready.home)) === canonical(hostEnv.HOME ?? ''),
          {keys, home: host.ready.home, foundationHome: host.ready.foundationHome});
        check('pins-owner-only', !!host.pinsPath && (statSync(host.pinsPath).mode & 0o777) === 0o600);
        const sockets = await listeningSockets(host.pid, tools.env);
        const loopback = loopbackOnlyVerdict(sockets, typeof host.port === 'number' ? [host.port] : [0]);
        check('host-listens-on-loopback-only', loopback.passed, {port: host.port, measured: sockets, problems: loopback.problems});
        const viewer = viewerChild(viewerContext, ['session', '--pins', host.pinsPath ?? '', '--frames', '30', '--timeout', '45'], host.port);
        const done = await viewer.waitFor(event => ['inputs-done', 'error', 'closed'].includes(String(event.event)), 60_000, 'scripted input');
        const sent = (done.sent as unknown[] | undefined) ?? [];
        await waitUntil(() => readJsonLines(host.evidence.inputEvents).length >= sent.length, 5_000);
        const recorded = readJsonLines(host.evidence.inputEvents);
        const phone = recorded.filter(line => line.source === 'phone').map(line => line.event);
        check('scripted-input-sent', done.event === 'inputs-done' && sent.length === 16 && done.textAndReturnResult === 'posted', done);
        check('input-record-matches-sent', sent.length > 0 && deepEqual(phone, sent), {recorded: phone.length, sent: sent.length});
        check('no-held-input-released', recorded.every(line => line.source === 'phone'), recorded.filter(line => line.source !== 'phone'));
        const openFiles = await forbiddenOpenFiles(host.pid, tools.env, home);
        check('host-opened-no-real-secrets', openFiles.length === 0, openFiles);
        const ended = await host.endSession('endedAtMac');
        const result = await viewer.waitFor(event => ['session-ended', 'error', 'closed'].includes(String(event.event)), 20_000, 'session end');
        const viewerExit = await viewer.exited;
        check('mac-ended-session', ended.ok === true && result.endReason === 'endedAtMac' && viewerExit === 0, {reply: ended, endReason: result.endReason, viewerExit});
        check('frames-received-30-in-order', Number(result.pictures) >= 30 && Number(result.decoded) >= 30 && result.unreadable === 0
          && result.countersInOrder === true, {pictures: result.pictures, decoded: result.decoded, first: result.firstCounter, last: result.lastCounter});
        const notices = (result.notices as string[] | undefined) ?? [];
        check('notices', ['displays:1:0', 'inputAvailability:ready', 'textAndReturnResult:1:posted'].every(name => notices.includes(name)), notices);
        check('protocol-version', viewer.events.find(event => event.event === 'connected')?.protocolVersion === host.ready.protocolVersion,
          {viewer: viewer.events.find(event => event.event === 'connected')?.protocolVersion, host: host.ready.protocolVersion});
        const impostor = await viewerOnce(viewerContext, ['expect-refused', '--pins', host.pinsPath ?? '', '--key', 'impostor'], 20_000, host.port);
        check('impostor-refused', impostor.code === 0 && impostor.last?.event === 'refused', impostor.last);
        const stopped = await host.stop();
        check('host-stopped-cleanly', stopped.exitCode === 0, stopped);
        const receipts = readJsonLines(host.evidence.receipts);
        const handshakes = receipts.filter(line => line.event === 'handshake');
        check('handshakes', handshakes.filter(line => line.outcome === 'accepted').length === 1
          && handshakes.some(line => line.outcome === 'failed' && line.reason === 'unknownDevice'), handshakes);
        check('host-session-ended-endedAtMac', receipts.some(line => line.event === 'session-ended' && line.reason === 'endedAtMac'
          && line.session === 1), receipts.filter(line => line.event === 'session-ended'));
        check('scripted-mac-actions-marked', receipts.filter(line => line.event === 'command').every(line => line.scripted === true));
        const frames = JSON.parse(readFileSync(host.evidence.frames, 'utf8')) as {totals: {sent: number}; capture: {delivered: number; lastWidth: number; lastHeight: number}};
        check('frames-json', frames.totals.sent >= 30 && frames.capture.delivered >= 30 && frames.capture.lastWidth === 1920
          && frames.capture.lastHeight === 1080, {totals: frames.totals, capture: frames.capture});
        check('evidence-owner-only', [host.evidence.receipts, host.evidence.inputEvents, host.evidence.frames]
          .every(path => (statSync(path).mode & 0o777) === 0o600));
      } finally {
        await host.stop();
      }
    }

    // Controller protocol 5 with software keys and a synthetic display. This is the shared Viewer core, not the
    // human-gated Viewer application or ScreenService. Scripted bar actions operate only on the fixture model.
    {
      const evidence = privateDirectory(join(evidenceDir, 'controller'));
      const {host} = await startHost('controller', 'controller', evidence);
      try {
        const first = viewerChild(viewerContext, ['session', '--pins', host.pinsPath ?? '', '--peer', 'controller',
          '--frames', '5', '--inputs', 'scripted', '--timeout', '45'], host.port);
        const sent = await first.waitFor(event => ['inputs-done', 'error', 'closed'].includes(String(event.event)), 60_000, 'controller scripted input');
        const frames = first.events.find(event => event.event === 'frames');
        const connected = first.events.find(event => event.event === 'connected');
        check('controller-v5-frames', connected?.protocolVersion === 5 && frames?.event === 'frames' && Number(frames.pictures) >= 5,
          {connected, frames});
        const sentInput = (sent.sent as unknown[] | undefined) ?? [];
        await waitUntil(() => readJsonLines(host.evidence.inputEvents).length >= sentInput.length, 5_000);
        const recorded = readJsonLines(host.evidence.inputEvents);
        check('controller-input-recorded-only', sent.event === 'inputs-done' && sentInput.length === 16
          && deepEqual(recorded.filter(row => row.source === 'phone').map(row => row.event), sentInput)
          && recorded.every(row => row.source === 'phone'), {sent: sentInput.length, recorded: recorded.length});
        const start = await host.command('bar', {action: 'status'});
        const paused = await host.command('bar', {action: 'pause'});
        const lowered = await host.command('bar', {action: 'view'});
        const refusedResume = await host.command('bar', {action: 'resume'});
        check('controller-bar-flow-pause-view', start.title === '‘Fixture Mac’ · 조작 중'
          && paused.title === '‘Fixture Mac’ · 원격 입력 멈춤' && paused.held === true
          && lowered.title === '‘Fixture Mac’ · 보는 중' && lowered.held === true
          && refusedResume.title === lowered.title && refusedResume.held === true,
          {start, paused, lowered, refusedResume});
        await host.endSession('endedAtMac');
        const ended = await first.waitFor(event => ['session-ended', 'error', 'closed'].includes(String(event.event)), 20_000, 'controller end');
        const firstExit = await first.exited;
        check('controller-session-ended', firstExit === 0 && ended.endReason === 'endedAtMac', ended);
        const second = viewerChild(viewerContext, ['session', '--pins', host.pinsPath ?? '', '--peer', 'controller',
          '--frames', '5', '--inputs', 'none', '--timeout', '45'], host.port);
        const reconnected = await second.waitFor(event => ['frames', 'error', 'closed'].includes(String(event.event)), 60_000, 'controller reconnect frames');
        const held = await host.command('bar', {action: 'status'});
        check('controller-bar-hold-survives-reconnect', reconnected.event === 'frames' && held.held === true
          && held.title === '‘Fixture Mac’ · 원격 입력 멈춤', held);
        await host.endSession('endedAtMac');
        const secondEnd = await second.waitFor(event => ['session-ended', 'error', 'closed'].includes(String(event.event)), 20_000, 'controller reconnect end');
        check('controller-reconnect-ended', await second.exited === 0 && secondEnd.endReason === 'endedAtMac', secondEnd);
        const stopped = await host.stop();
        const receipts = readJsonLines(host.evidence.receipts);
        check('controller-handshakes-v5-only', stopped.exitCode === 0 && receipts.filter(row => row.event === 'handshake' && row.outcome === 'accepted')
          .length === 2 && receipts.filter(row => row.event === 'handshake' && row.outcome === 'accepted').every(row => row.version === 5), receipts);
      } finally { await host.stop(); }
    }

    // pinned-device: a key the host did not make (J2-VIEWER-MODEL pins the probe's Secure Enclave key this way).
    {
      const evidence = privateDirectory(join(evidenceDir, 'pinned-device'));
      const {host} = await startHost('pinned-device', 'pinned', evidence);
      try {
        const key = softwareDeviceKey();
        const pins = JSON.parse(readFileSync(host.pinsPath ?? '', 'utf8')) as Record<string, unknown>;
        check('pinned-mode-hands-out-no-keys', !('devicePrivateKey' in pins) && !('impostorPrivateKey' in pins));
        // Read by the phone, written by the harness only: outside every fixture's writable folders.
        const viewerPins = join(privateDirectory(join(work, 'phone-input')), 'viewer-pins.json');
        writeFileSync(viewerPins, JSON.stringify({...pins, devicePrivateKey: key.privateKey}), {mode: 0o600});
        const before = await viewerOnce(viewerContext, ['expect-refused', '--pins', viewerPins, '--key', 'device'], 20_000, host.port);
        check('unpinned-device-refused', before.code === 0 && before.last?.event === 'refused', before.last);
        const pinned = await host.pinDevice(key.publicKey);
        check('pin-device-command', pinned.ok === true && typeof pinned.deviceID === 'string', pinned);
        const session = await viewerOnce(viewerContext, ['session', '--pins', viewerPins, '--frames', '5', '--inputs', 'none', '--leave', 'true',
          '--timeout', '30'], 45_000, host.port);
        check('pinned-device-connects', session.code === 0 && session.last?.event === 'session-ended' && Number(session.last?.pictures) >= 5,
          session.last);
        const stopped = await host.stop();
        const receipts = readJsonLines(host.evidence.receipts);
        check('pinned-receipts', stopped.exitCode === 0
          && receipts.some(line => line.event === 'device-pinned' && line.how === 'command' && line.scripted === true)
          && receipts.some(line => line.event === 'handshake' && line.outcome === 'failed' && line.reason === 'unknownDevice')
          && receipts.some(line => line.event === 'handshake' && line.outcome === 'accepted' && line.deviceID === pinned.deviceID),
          receipts.filter(line => line.event === 'handshake' || line.event === 'device-pinned'));
      } finally {
        await host.stop();
      }
    }

    // invite: invitation texts for J2-APP-BOUNDARY and a registration port that only counts connections.
    {
      const evidence = privateDirectory(join(evidenceDir, 'invite'));
      const {host} = await startHost('invite', 'invite', evidence);
      try {
        check('invites-owner-only', !!host.invitesPath && (statSync(host.invitesPath).mode & 0o777) === 0o600);
        const sockets = await listeningSockets(host.pid, tools.env);
        const loopback = loopbackOnlyVerdict(sockets, [Number(host.ready.registrationPort), Number(host.ready.screenPort)]);
        check('invite-listens-on-loopback-only', loopback.passed, {measured: sockets, problems: loopback.problems});
        const selfParsed = host.ready.deviceRegistrationParse as Record<string, string> | undefined;
        check('invite-host-parse', selfParsed?.device === 'device' && selfParsed?.deviceLegacy === 'device'
          && selfParsed?.controller === 'wrongPurpose', selfParsed);
        const parsed = await viewerOnce(viewerContext, ['parse-invites', '--invites', host.invitesPath ?? ''], 20_000);
        const entry = (name: string) => (parsed.last?.[name] ?? {}) as Record<string, unknown>;
        check('invite-phone-parse', parsed.code === 0 && entry('device').deviceRegistration === 'accepted'
          && entry('deviceLegacy').deviceRegistration === 'accepted' && entry('deviceLegacy').address === '127.0.0.1'
          && entry('deviceLegacy').registrationPort === host.ready.registrationPort
          && entry('controller').purpose === 'macController' && entry('controller').deviceRegistration === 'wrongPurpose', parsed.last);
        // Only deviceLegacy names an address the counting listener can be reached at (INVITES_REACHING_COUNTING_LISTENER).
        const reachable = (['device', 'deviceLegacy', 'controller'] as const).filter(name => entry(name).nearby === false && entry(name).address !== undefined);
        check('invite-only-legacy-reaches-counting-listener', deepEqual(reachable, [...INVITES_REACHING_COUNTING_LISTENER]), {reachable});
        const quiet = await host.command('counts');
        const zero = quiet.connections as {registration: number; screen: number} | undefined;
        check('invite-no-connections-unprompted', zero?.registration === 0 && zero?.screen === 0, zero);
        const connected = await connectOnce(Number(host.ready.registrationPort));
        let counted: {registration: number} | undefined;
        const deadline = Date.now() + 3000;
        do {
          counted = (await host.command('counts')).connections as {registration: number} | undefined;
          if (counted?.registration) break;
          await Bun.sleep(50);
        } while (Date.now() < deadline);
        check('invite-counts-a-connection', connected && counted?.registration === 1, {connected, counted});
        const stopped = await host.stop();
        check('invite-host-stopped-cleanly', stopped.exitCode === 0, stopped);
      } finally {
        await host.stop();
      }
    }

    const tcc = await observeTcc(startedAt, tools.env);
    writeFileSync(join(evidenceDir, 'tcc-observation.json'), JSON.stringify(tcc, null, 2) + '\n', {mode: 0o600});
    // macOS daemons query TCC about new processes; a preflight never prompts and changes nothing.
    const tccResult = tccVerdict(tcc);
    check('tcc-no-prompt-observed', tccResult.passed, {why: tccResult.why, fixture: tcc.fixture, videoToolboxService: tcc.videoToolboxService,
      recognizedRequests: tcc.recognizedRequests, deniedLookups: tcc.deniedLookups});
    const after = hashProductionSources();
    report.sourcesDigest = {before: before.digest, after: after.digest};
    const changed = Object.keys({...before.files, ...after.files}).filter(path => before.files[path] !== after.files[path]);
    check('production-sources-untouched-by-run', before.digest === after.digest, changed);
    // Against main where git can tell; a git-archive copy cannot, and then no check claims it.
    report.sourcesVsMain = productionSourcesVsMain();
    if (report.sourcesVsMain.measured) {
      check('production-sources-match-main-base', report.sourcesVsMain.changed?.length === 0, report.sourcesVsMain);
    } else {
      say(`note  production sources vs main not measured: ${report.sourcesVsMain.reason}`);
    }
    const leftovers = [...liveChildren].map(child => child.pid);
    check('no-fixture-process-left', leftovers.length === 0, leftovers);
    return finish(checks.every(item => item.passed) ? 'pass' : 'fail');
  } catch (error) {
    check('selfcheck-ran-to-the-end', false, String(error instanceof Error ? error.stack ?? error.message : error));
    for (const child of liveChildren) child.kill('SIGKILL');
    return finish('fail');
  }
}

// MARK: - Orchestrator lane

/**
 * The parts of WP0's `LaneContext` (scripts/emulator-e2e.ts) this lane uses, kept structural so this module also stands
 * alone. Registered in that file's `LANE_MODULES` as `'screen-host-selfcheck': () => import('./emulator-e2e/screenFixtureHost')`.
 */
export interface ScreenHostLaneContext {
  runId: string;
  repoRoot: string;
  /** The run scratch, outside the real home; removed by the orchestrator. */
  scratchRoot: string;
  /** The real home (directory services). */
  home: string;
  evidence: {dir: string};
  /** WP1's host profile for this run: the base every fixture profile starts from. */
  hostSandbox: {text: string; sha256: string};
  isolatedProfile(label: string): {root: string; home: string; tmp: string};
  allowlistedEnv(input: {profile: {root: string; home: string; tmp: string}}): Record<string, string>;
  log(message: string): void;
}

export interface ScreenHostLaneOutcome {
  status: LaneStatus;
  reason?: string;
  labels?: {real: string[]; standIn: string[]};
  artifacts?: string[];
  details?: Record<string, unknown>;
}

export interface ScreenHostLane {
  id: 'screen-host-selfcheck';
  title: string;
  run(ctx: ScreenHostLaneContext): Promise<ScreenHostLaneOutcome>;
}

/** The orchestrator's outcome for a selfcheck report: blocked and failed carry their reason, every outcome its labels. */
export function laneOutcomeFromReport(report: SelfcheckReport, evidenceRoot: string): ScreenHostLaneOutcome {
  const failed = report.checks.filter(item => !item.passed).map(item => item.name);
  const passed = report.checks.length - failed.length;
  const labels = {real: [...SCREEN_FIXTURE_LABEL.real], standIn: [...SCREEN_FIXTURE_LABEL.substitutes]};
  const artifacts = ['selfcheck-report.json', 'nm-gate.txt', 'tcc-observation.json', 'viewer/host-receipts.jsonl', 'viewer/input-events.jsonl',
    'viewer/frames.json', 'controller/host-receipts.jsonl', 'controller/input-events.jsonl', 'controller/frames.json'].map(name => join(report.evidenceDir, name)).filter(existsSync).map(path => relative(evidenceRoot, path));
  const details = {label: SCREEN_FIXTURE_LABEL.label, scope: SCREEN_FIXTURE_LABEL.scope, checks: `${passed}/${report.checks.length}`, failed,
    seconds: report.seconds, sandboxProfileSha256: report.sandboxProfileSha256, sandboxBaseSha256: report.sandboxBaseSha256,
    sourcesDigest: report.sourcesDigest, sourcesVsMain: report.sourcesVsMain, build: report.build};
  if (report.status === 'pass') return {status: 'pass', labels, artifacts, details};
  if (report.status === 'blocked') return {status: 'blocked', reason: report.blockedReason ?? 'blocked without a reason', labels, artifacts, details};
  if (report.status === 'skipped') return {status: 'skipped', reason: report.blockedReason ?? 'skipped', labels, artifacts, details};
  return {status: 'fail', reason: failed.length ? `failed checks: ${failed.join(', ')}` : 'the selfcheck failed', labels, artifacts, details};
}

/** Keep each lane's report separate: `all` runs the self-check and J3B in the same evidence root. */
export async function runScreenFixtureLane(ctx: ScreenHostLaneContext, evidenceName: 'screen-host' | 'screen-host-j3b'): Promise<ScreenHostLaneOutcome> {
  const environmentFor = (role: string): FixtureEnvironment => {
    const profile = ctx.isolatedProfile(`screen-${role}`);
    return {env: ctx.allowlistedEnv({profile}), root: profile.root};
  };
  const report = await selfcheck({
    evidenceDir: join(ctx.evidence.dir, evidenceName), workParent: ctx.scratchRoot, environmentFor,
    scratchRoots: [ctx.scratchRoot], sandboxBase: ctx.hostSandbox.text, realHome: ctx.home,
    log: line => ctx.log(`screen-host ${line}`),
  });
  return laneOutcomeFromReport(report, ctx.evidence.dir);
}

export const lane: ScreenHostLane = {
  id: 'screen-host-selfcheck',
  title: 'ScreenFixtureHost self-check (build · nm gate · sandbox canaries · loopback viewer)',
  run: ctx => runScreenFixtureLane(ctx, 'screen-host'),
};

// MARK: - CLI

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args: string[], name: string): string[] {
  return args.flatMap((arg, index) => arg === `--${name}` && args[index + 1] ? [args[index + 1] as string] : []);
}

async function serve(args: string[]): Promise<number> {
  const mode = option(args, 'mode') as ScreenFixtureMode | undefined;
  const stateDir = option(args, 'state-dir'), evidenceDir = option(args, 'evidence-dir');
  if (!mode || !['viewer', 'controller', 'pinned-device', 'invite'].includes(mode) || !stateDir || !evidenceDir) {
    console.error('serve needs --mode viewer|pinned-device|invite --state-dir DIR --evidence-dir DIR');
    return 64;
  }
  privateDirectory(evidenceDir);
  const build = await buildScreenFixture({outDir: option(args, 'build-dir') ?? join(stateDir, 'build'), evidenceDir});
  if (!build.gates.every(gate => gate.passed)) {
    console.log(JSON.stringify({event: 'error', message: 'nm gate failed', gates: build.gates}));
    return 1;
  }
  const fps = option(args, 'fps');
  const sandboxBasePath = option(args, 'sandbox-base');
  const sandboxBase = sandboxBasePath ? readFileSync(sandboxBasePath, 'utf8') : undefined;
  const host = await start({mode, build, stateDir: join(stateDir, 'host'), evidenceDir, devicePublicKeys: options(args, 'device-public-key'),
    framesPerSecond: fps ? Number(fps) : undefined, displays: option(args, 'displays'), profileDir: join(stateDir, 'profiles'), sandboxBase});
  console.log(JSON.stringify({...host.ready, sandboxProfileSha256: host.sandboxProfileSha256,
    ...(sandboxBase === undefined ? {} : {sandboxBaseSha256: sha256(sandboxBase)}), label: SCREEN_FIXTURE_LABEL}));
  let stopping = false;
  const shutDown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    const stopped = await host.stop();
    console.log(JSON.stringify({event: 'stopped', why, exitCode: stopped.exitCode}));
    process.exit(stopped.exitCode === 0 ? 0 : 1);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutDown(signal));
  void host.exited.then(code => { if (!stopping) { console.log(JSON.stringify({event: 'host-exited', code})); process.exit(1); } });
  for await (const line of lines(Bun.stdin.stream())) {
    if (!line.trim()) continue;
    let command: Record<string, unknown>;
    try { command = JSON.parse(line) as Record<string, unknown>; } catch { console.log(JSON.stringify({event: 'reply', ok: false, error: 'not JSON'})); continue; }
    if (command.op === 'stop') break;
    const {op, id: _callerId, ...fields} = command;
    const reply = await host.command(String(op), fields).catch(error => ({event: 'reply', ok: false, error: String(error)}) as JsonEvent);
    console.log(JSON.stringify(replyForCaller(command, reply)));
  }
  await shutDown('stdin');
  return 0;
}

if (import.meta.main) {
  const [subcommand, ...args] = process.argv.slice(2);
  if (subcommand === 'selfcheck') {
    const report = await selfcheck({evidenceDir: option(args, 'evidence-dir'), workParent: option(args, 'work-dir'), keep: args.includes('--keep')});
    const failed = report.checks.filter(item => !item.passed).map(item => item.name);
    console.log(`screen-host-selfcheck: ${report.status}${report.blockedReason ? ` (${report.blockedReason})` : ''} — ${report.checks.length - failed.length}/${report.checks.length} checks passed in ${report.seconds}s${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
    console.log(`evidence: ${report.evidenceDir}`);
    process.exit(report.status === 'pass' ? 0 : report.status === 'blocked' ? 2 : 1);
  } else if (subcommand === 'build') {
    const outDir = option(args, 'out-dir');
    if (!outDir) { console.error('build needs --out-dir DIR'); process.exit(64); }
    const evidenceDir = option(args, 'evidence-dir');
    if (evidenceDir) privateDirectory(evidenceDir);
    const build = await buildScreenFixture({outDir, evidenceDir});
    for (const gate of build.gates) console.log(formatGate(gate));
    process.exit(build.gates.every(gate => gate.passed) ? 0 : 1);
  } else if (subcommand === 'serve') {
    process.exit(await serve(args));
  } else {
    console.error('usage: bun scripts/emulator-e2e/screenFixtureHost.ts selfcheck|build|serve …');
    process.exit(64);
  }
}
