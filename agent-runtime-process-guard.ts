#!/usr/bin/env bun

/**
 * Minimal parent-death guard for one Agent Runtime or Claude Remote Control
 * provider process.
 *
 * The API sidecar owns this guard's stdin. If the sidecar exits normally,
 * crashes, or is SIGKILLed, the pipe reaches EOF. The guard then closes the
 * provider protocol, terminates the provider-owned process group if needed,
 * confirms it is gone, and only then exits. No prompt is passed in argv.
 */

import { once } from 'node:events';
import {
  assertCodexRuntimeExecutableIdentityCurrent,
  isCodexRuntimeExecutableIdentityForPlatform,
  type CodexRuntimeExecutableIdentity,
} from './src/codexRuntimeExecutable';
import {
  AGENT_RUNTIME_GUARD_RESERVATION_ENV,
  activateAgentRuntimeGuardReservation,
  decodeAgentRuntimeGuardReservation,
  type AgentRuntimeGuardKind,
} from './src/agentRuntimeGuardRegistry';

const STDIN_EXIT_GRACE_MS = 100;
const TERM_GRACE_MS = 250;
const KILL_GRACE_MS = 250;
const PARENT_POLL_MS = 250;
const CODEX_IDENTITY_ENV = 'AGENTSTOZ_CODEX_EXECUTABLE_IDENTITY_V1';
const MAX_ENCODED_CODEX_IDENTITY_BYTES = 32 * 1024;

function fail(message: string, code = 64): never {
  process.stderr.write(`[agent-runtime-guard] ${message}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (process.platform === 'win32') {
  fail('Windows execution is disabled until Job Object containment is available.');
}
const launchProtocol = argv[0];
if ((launchProtocol !== 'agentstoz-provider-argv-v4'
    && launchProtocol !== 'agentstoz-claude-remote-argv-v3')
  || argv.length < 3
  || argv.some(value => value.includes('\u0000'))) {
  fail('A provider argv array is required.');
}

// The workspace travels in argv, never as this process's own cwd. Bun autoloads
// a `.env` from the cwd before any user code runs -- in compiled binaries too,
// where no build flag disables it -- so a guard started inside the target
// project imports that project's dotenv into its own `process.env` and hands it
// to the provider below. Running the guard from a fixed neutral directory
// removes the vector instead of filtering after the fact.
const workspaceCwd = argv[1] ?? '';
if (!workspaceCwd.startsWith('/')) {
  fail('An absolute provider working directory is required.');
}

const providerArgv = argv.slice(2);
const guardKind: AgentRuntimeGuardKind = launchProtocol === 'agentstoz-provider-argv-v4'
  ? 'codex'
  : 'claude-remote';
const encodedGuardReservation = process.env[AGENT_RUNTIME_GUARD_RESERVATION_ENV];
if (typeof encodedGuardReservation !== 'string') {
  fail('A durable process guard reservation is required.');
}
try {
  const decoded = decodeAgentRuntimeGuardReservation(encodedGuardReservation);
  if (decoded.kind !== guardKind) throw new Error('guard kind mismatch');
} catch {
  fail('The durable process guard reservation is invalid.');
}
let codexExecutableIdentity: CodexRuntimeExecutableIdentity | null = null;
if (launchProtocol === 'agentstoz-provider-argv-v4') {
  const encoded = process.env[CODEX_IDENTITY_ENV];
  if (typeof encoded !== 'string'
    || encoded.length < 1
    || Buffer.byteLength(encoded) > MAX_ENCODED_CODEX_IDENTITY_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    fail('A bounded Codex executable identity is required.');
  }
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw new Error('non-canonical identity encoding');
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    if (!isCodexRuntimeExecutableIdentityForPlatform(parsed, process.platform)
      || parsed.path !== providerArgv[0]) {
      throw new Error('invalid executable identity');
    }
    codexExecutableIdentity = parsed;
  } catch {
    fail('The Codex executable identity is invalid.');
  }
}
// Never make the private supervisor-to-guard proof available to the provider.
delete process.env[CODEX_IDENTITY_ENV];
delete process.env[AGENT_RUNTIME_GUARD_RESERVATION_ENV];
const parentPid = process.ppid;
if (!Number.isSafeInteger(parentPid) || parentPid <= 1) {
  fail('The owning sidecar process is unavailable.', 70);
}
const PROVIDER_ENV_ALLOWLIST = new Set([
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMP', 'TEMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'CODEX_HOME',
]);
const providerEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value !== 'string') continue;
  if (launchProtocol === 'agentstoz-claude-remote-argv-v3') {
    // Claude Remote Control historically receives the user's effective
    // environment (proxy/auth/config overrides included). The guard itself is
    // started with dotenv autoload disabled, so this preserves that contract
    // without importing a target project's `.env` into the provider.
    providerEnv[key] = value;
  } else if (PROVIDER_ENV_ALLOWLIST.has(key.toUpperCase())) {
    // Canonicalize names so a project `.env` cannot smuggle a second
    // case-variant into a Windows-like downstream environment.
    const canonical = key.toUpperCase();
    if (!(canonical in providerEnv)) providerEnv[canonical] = value;
  }
}
if (codexExecutableIdentity) {
  try {
    // This synchronous check is intentionally adjacent to the provider spawn.
    // It closes the sidecar -> guard scheduling window by re-reading stat and
    // SHA-256 inside the process that actually opens the provider path.
    assertCodexRuntimeExecutableIdentityCurrent(codexExecutableIdentity);
  } catch {
    fail('The Codex executable changed before provider launch.', 70);
  }
}

function assertOwningParentStillCurrent(): void {
  // A large executable may take longer to hash than the replacement
  // sidecar's dead-owner grace. If the original sidecar died while this guard
  // was synchronously hashing, POSIX reparents the guard. Refuse to create a
  // late provider instead of relying on an EOF callback that could not run
  // while the event loop was blocked.
  if (process.ppid !== parentPid) {
    fail('The owning sidecar exited before provider launch.', 70);
  }
  try {
    process.kill(parentPid, 0);
  } catch {
    // EPERM is also fail-closed. The launcher and guard normally share the
    // same user, so inability to prove liveness must never grant execution.
    fail('The owning sidecar could not be proven alive before provider launch.', 70);
  }
  // Close the reparenting race across the liveness probe itself. If the parent
  // dies after this final synchronous check, the already-established stdin
  // pipe and PID poll below still reap the newly spawned group inside the
  // supervisor's one-second recovery fence.
  if (process.ppid !== parentPid) {
    fail('The owning sidecar exited before provider launch.', 70);
  }
}

assertOwningParentStillCurrent();
try {
  // The durable registry treats this PID as the task PGID. Prove the launcher
  // actually created the detached group before publishing `active`.
  process.kill(-process.pid, 0);
} catch {
  fail('The process guard group identity could not be proven.', 70);
}
try {
  // The launcher committed `reserved` before spawning this process. This
  // transaction commits `active` before any provider exists. A replacement
  // supervisor that deleted a dead parent's reservation therefore makes this
  // exact update fail, while a committed active row blocks stale lease reuse.
  activateAgentRuntimeGuardReservation(
    encodedGuardReservation,
    parentPid,
    guardKind,
  );
} catch {
  fail('The durable process guard reservation could not be activated.', 70);
}
assertOwningParentStillCurrent();
// Bun can load the target working directory's `.env` while creating a child
// process, even when an explicit `env` object was supplied here.  Run through
// the system `env -i` boundary so that automatic injection is discarded before
// the provider executable starts.  The only values that can cross are the
// fixed allowlist serialized below; this keeps project-controlled dotenv files
// out of the provider and its descendants.
const providerEnvArgs = Object.entries(providerEnv).map(([key, value]) => `${key}=${value}`);
const provider = Bun.spawn(['/usr/bin/env', '-i', ...providerEnvArgs, ...providerArgv], {
  cwd: workspaceCwd,
  // `env -i` is authoritative. Keep the direct child environment empty too,
  // so a future change cannot accidentally depend on Bun's dotenv behavior.
  env: {},
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
  // The guard itself is launched as a detached group leader. Keep the provider
  // in that same task group so the API adapter's negative-PGID fallback also
  // reaps the provider if this tiny guard crashes unexpectedly.
  detached: false,
});
const providerPid = provider.pid;
if (!Number.isSafeInteger(providerPid) || providerPid <= 1) {
  try { provider.kill('SIGKILL'); } catch { /* best effort before fatal exit */ }
  fail('The provider process identity is unavailable.', 70);
}

function signalTaskGroup(signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-process.pid, signal);
  } catch (error: any) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function providerExitedWithin(timeoutMs: number): Promise<boolean> {
  return Promise.race([
    provider.exited.then(() => true, () => true),
    Bun.sleep(Math.max(0, timeoutMs)).then(() => false),
  ]);
}

let cleanupPromise: Promise<boolean> | null = null;
function cleanupProvider(urgent: boolean): Promise<boolean> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    try { provider.stdin.end(); } catch { /* process may already be gone */ }
    if (!urgent) await providerExitedWithin(STDIN_EXIT_GRACE_MS);
    // The group contains this guard too. Its SIGTERM handler deliberately
    // stays alive for the grace window; SIGKILL then removes the guard,
    // provider, and TERM-ignoring ordinary descendants atomically.
    try { signalTaskGroup('SIGTERM'); } catch { /* KILL remains available */ }
    await Bun.sleep(TERM_GRACE_MS);
    try { signalTaskGroup('SIGKILL'); } catch { return false; }
    await Bun.sleep(KILL_GRACE_MS);
    return false;
  })();
  return cleanupPromise;
}

async function writeWithBackpressure(
  destination: NodeJS.WriteStream,
  chunk: Uint8Array,
): Promise<void> {
  if (!destination.write(chunk)) await once(destination, 'drain');
}

async function forwardOutput(
  source: ReadableStream<Uint8Array>,
  destination: NodeJS.WriteStream,
): Promise<void> {
  const reader = source.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      await writeWithBackpressure(destination, next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

const inputReader = Bun.stdin.stream().getReader();
const inputPump = (async () => {
  try {
    while (true) {
      const next = await inputReader.read();
      if (next.done) {
        await cleanupProvider(false);
        return;
      }
      provider.stdin.write(next.value);
      provider.stdin.flush?.();
    }
  } catch {
    await cleanupProvider(true);
  }
})();
const stdoutPump = forwardOutput(provider.stdout, process.stdout);
const stderrPump = forwardOutput(provider.stderr, process.stderr);

let signalExitStarted = false;
function handleSignal(exitCode: number): void {
  if (signalExitStarted) return;
  signalExitStarted = true;
  void cleanupProvider(true).then(confirmed => {
    process.exit(confirmed ? exitCode : 70);
  });
}
process.once('SIGTERM', () => handleSignal(143));
process.once('SIGINT', () => handleSignal(130));

// EOF is the primary parent-death signal. PID liveness is a second independent
// trigger for runtimes that delay pipe closure; it never grants kill authority
// over anything except the detached task group created by the launcher.
const parentPoll = setInterval(() => {
  if (parentPid <= 1) return;
  try {
    process.kill(parentPid, 0);
  } catch (error: any) {
    if (error?.code === 'ESRCH') void cleanupProvider(true);
  }
}, PARENT_POLL_MS);
parentPoll.unref?.();

const exitCode = await provider.exited.catch(() => 70);
clearInterval(parentPoll);
await inputReader.cancel().catch(() => undefined);
await Promise.allSettled([inputPump, stdoutPump, stderrPump]);
// Even a provider that exits by itself may have left ordinary descendants in
// the task group. Reap the group rather than trusting only the leader status.
void exitCode;
await cleanupProvider(true);
process.exit(70);
