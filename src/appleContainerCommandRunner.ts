import { Buffer } from 'node:buffer';
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

import {
  APPLE_CONTAINER_EXECUTABLE,
  APPLE_CONTAINER_GUEST_STAGING_PATH,
  APPLE_CONTAINER_KERNEL_PATH,
  APPLE_CONTAINER_MAX_OUTPUT_BYTES,
  APPLE_CONTAINER_NONCE_LABEL,
  APPLE_CONTAINER_RUNTIME_HANDLER,
  APPLE_CONTAINER_VMINIT_IMAGE,
} from './appleContainerCommandPlan';
import type { AppleContainerCommandResult } from './appleContainerRuntime';

/**
 * Host-private process adapter for argv emitted by appleContainerCommandPlan.
 *
 * It is intentionally narrower than a general command runner. It accepts only
 * the exact Apple Container binary and the planner's current command grammar,
 * never invokes a shell, never inherits the sidecar environment, and always
 * reaps the direct child and its detached POSIX process group before settling.
 * Successful execution is only a command result; it is not a containment
 * readiness or self-test proof. The argv grammar is defense in depth, not an
 * authorization boundary: an in-process caller can reproduce the same values,
 * so the outer orchestrator must still prove a durable registry reservation
 * and exact task ownership before invoking this adapter.
 *
 * Likewise, PGID cleanup here is only lifecycle hygiene for the trusted,
 * root-owned Apple CLI child. A process can escape a POSIX group with setsid();
 * only the Apple Container VM lifecycle and its separate adversarial self-test
 * may establish task containment.
 */

export const APPLE_CONTAINER_RUNNER_MAX_TIMEOUT_MS = 2 * 60_000;
export const APPLE_CONTAINER_RUNNER_MAX_ENV_VALUE_BYTES = 4 * 1024;
export const APPLE_CONTAINER_RUNNER_MAX_ARG_BYTES = 4 * 1024;
export const APPLE_CONTAINER_RUNNER_MAX_ARGV_BYTES = 32 * 1024;
export const APPLE_CONTAINER_RUNNER_MAX_ARGS = 64;

const PROCESS_TERM_GRACE_MS = 500;
const PROCESS_KILL_CONFIRM_MS = 3_000;
const PROCESS_STREAM_CLOSE_GRACE_MS = 400;
const PROCESS_POLL_MS = 20;
const PRIVATE_CONTAINER_NAME_RE = /^agentstoz-ar-[a-f0-9]{48}$/;
const NONCE_RE = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY_SEGMENT_RE = /^[a-z0-9]+(?:(?:[._-][a-z0-9]+)+)?$/;
const REGISTRY_HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OPTIONAL_ENVIRONMENT_KEYS = Object.freeze([
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
] as const);
const FIXED_ENVIRONMENT = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
  LANG: 'C',
  LC_ALL: 'C',
} as const);

export interface AppleContainerCommandRunnerOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}

export type AppleContainerCommandRunner = (
  executable: typeof APPLE_CONTAINER_EXECUTABLE,
  argv: readonly string[],
  options: AppleContainerCommandRunnerOptions,
) => Promise<AppleContainerCommandResult>;

export interface AppleContainerCommandRunnerDependencies {
  /** Test seam only. Production always uses node:child_process spawn. */
  readonly spawn?: (
    executable: string,
    argv: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  /** Test seam only. Apple Container execution is rejected off macOS. */
  readonly platform?: NodeJS.Platform;
}

export type AppleContainerCommandRunnerErrorCode =
  | 'APPLE_CONTAINER_RUNNER_INVALID_INPUT'
  | 'APPLE_CONTAINER_RUNNER_CLEANUP_UNCONFIRMED'
  | 'APPLE_CONTAINER_RUNNER_EXECUTION_FAILED';

export class AppleContainerCommandRunnerError extends Error {
  constructor(readonly code: AppleContainerCommandRunnerErrorCode) {
    // Never echo argv, paths, environment values, command output, or a cause.
    super(code);
    this.name = 'AppleContainerCommandRunnerError';
  }
}

function fail(code: AppleContainerCommandRunnerErrorCode): never {
  throw new AppleContainerCommandRunnerError(code);
}

function processErrorCode(cause: unknown): string | undefined {
  return cause !== null && typeof cause === 'object' && 'code' in cause
    ? String((cause as NodeJS.ErrnoException).code)
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function isExplicitRegistry(registry: string): boolean {
  const matchedPort = registry.match(/:([0-9]+)$/)?.[1];
  if (registry.includes(':') && matchedPort === undefined) return false;
  if (matchedPort !== undefined
    && (matchedPort.startsWith('0') || Number(matchedPort) > 65_535)) return false;
  const host = matchedPort === undefined
    ? registry
    : registry.slice(0, -(matchedPort.length + 1));
  if (host === 'localhost') return true;
  const labels = host.split('.');
  return labels.length >= 2 && labels.every(label => REGISTRY_HOST_LABEL_RE.test(label));
}

function isPinnedImage(image: string): boolean {
  if (image.length > 512 || image !== image.toLowerCase() || image.includes('://')) return false;
  const parts = image.split('@');
  if (parts.length !== 2) return false;
  const imageName = parts[0];
  const digest = parts[1];
  if (!imageName || !digest || !IMAGE_DIGEST_RE.test(digest)) return false;
  const nameParts = imageName.split('/');
  const registry = nameParts[0];
  return nameParts.length >= 2
    && registry !== undefined
    && isExplicitRegistry(registry)
    && nameParts.slice(1).every(segment => REPOSITORY_SEGMENT_RE.test(segment));
}

function isPlannerStagingMount(value: string): boolean {
  const prefix = 'type=bind,source=';
  const suffix = `,target=${APPLE_CONTAINER_GUEST_STAGING_PATH}`;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const source = value.slice(prefix.length, -suffix.length);
  return source.length > 1
    && Buffer.byteLength(source, 'utf8') <= APPLE_CONTAINER_RUNNER_MAX_ARG_BYTES
    && isAbsolute(source)
    && resolve(source) === source
    && source.normalize('NFC') === source
    && !source.includes(',')
    && !/[\0\r\n]/.test(source);
}

function isPlannerCreateArgv(argv: readonly string[]): boolean {
  const operation = argv[0];
  if (operation !== 'create') return false;
  let cursor = 1;
  const take = (expected: string): boolean => argv[cursor++] === expected;
  if (!take('--name')) return false;
  const name = argv[cursor++];
  if (name === undefined || !PRIVATE_CONTAINER_NAME_RE.test(name)) return false;
  if (!take('--label')) return false;
  const label = argv[cursor++];
  const labelPrefix = `${APPLE_CONTAINER_NONCE_LABEL}=`;
  if (label === undefined
    || !label.startsWith(labelPrefix)
    || !NONCE_RE.test(label.slice(labelPrefix.length))) return false;
  if (!take('--read-only') || !take('--cap-drop') || !take('ALL') || !take('--cpus')) return false;
  const cpuCount = Number(argv[cursor++]);
  if (!Number.isSafeInteger(cpuCount) || cpuCount < 1 || cpuCount > 8) return false;
  if (!take('--memory')) return false;
  const memoryMatch = argv[cursor++]?.match(/^([0-9]+)M$/);
  const memoryMiB = Number(memoryMatch?.[1]);
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB < 512 || memoryMiB > 16 * 1024) return false;
  if (!take('--network') || !take('none') || !take('--no-dns') || !take('--mount')) return false;
  const mount = argv[cursor++];
  if (mount === undefined || !isPlannerStagingMount(mount)) return false;
  if (!take('--workdir')
    || !take(APPLE_CONTAINER_GUEST_STAGING_PATH)
    || !take('--os')
    || !take('linux')
    || !take('--arch')
    || !take('arm64')
    || !take('--runtime')
    || !take(APPLE_CONTAINER_RUNTIME_HANDLER)
    || !take('--init-image')
    || !take(APPLE_CONTAINER_VMINIT_IMAGE)
    || !take('--kernel')
    || !take(APPLE_CONTAINER_KERNEL_PATH)
    || !take('--scheme')
    || !take('https')) return false;
  const image = argv[cursor++];
  return image !== undefined && isPinnedImage(image) && cursor === argv.length;
}

function isExactArgv(argv: readonly string[], expected: readonly string[]): boolean {
  return argv.length === expected.length
    && argv.every((value, index) => value === expected[index]);
}

function isPlannerArgv(argv: readonly string[]): boolean {
  const operation = argv[0];
  const name = argv.at(-1);
  if (operation === 'create') return isPlannerCreateArgv(argv);
  if (operation === 'list') return isExactArgv(argv, ['list', '--all', '--format', 'json']);
  if (name === undefined || !PRIVATE_CONTAINER_NAME_RE.test(name)) return false;
  if (operation === 'start') return isExactArgv(argv, ['start', name]);
  if (operation === 'inspect') return isExactArgv(argv, ['inspect', name]);
  if (operation === 'kill') return isExactArgv(argv, ['kill', '--signal', 'KILL', name]);
  if (operation === 'delete') return isExactArgv(argv, ['delete', '--force', name]);
  if (operation === 'stop') {
    if (argv.length !== 6
      || argv[1] !== '--signal'
      || argv[2] !== 'SIGTERM'
      || argv[3] !== '--time') return false;
    const seconds = Number(argv[4]);
    return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 30;
  }
  return false;
}

function assertRunnerInput(
  executable: string,
  argv: readonly string[],
  options: AppleContainerCommandRunnerOptions,
  platform: NodeJS.Platform,
): void {
  if (platform !== 'darwin'
    || executable !== APPLE_CONTAINER_EXECUTABLE
    || !Array.isArray(argv)
    || argv.length < 1
    || argv.length > APPLE_CONTAINER_RUNNER_MAX_ARGS
    || options === null
    || typeof options !== 'object'
    || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs > APPLE_CONTAINER_RUNNER_MAX_TIMEOUT_MS
    || !Number.isSafeInteger(options.maxOutputBytes)
    || options.maxOutputBytes < 1
    || options.maxOutputBytes > APPLE_CONTAINER_MAX_OUTPUT_BYTES
    || options.env === null
    || typeof options.env !== 'object'
    || Array.isArray(options.env)) {
    return fail('APPLE_CONTAINER_RUNNER_INVALID_INPUT');
  }
  let totalBytes = 0;
  for (const arg of argv) {
    if (typeof arg !== 'string'
      || arg.length < 1
      || arg.normalize('NFC') !== arg
      || /[\0\r\n]/.test(arg)) return fail('APPLE_CONTAINER_RUNNER_INVALID_INPUT');
    const bytes = Buffer.byteLength(arg, 'utf8');
    if (bytes > APPLE_CONTAINER_RUNNER_MAX_ARG_BYTES) {
      return fail('APPLE_CONTAINER_RUNNER_INVALID_INPUT');
    }
    totalBytes += bytes;
    if (totalBytes > APPLE_CONTAINER_RUNNER_MAX_ARGV_BYTES) {
      return fail('APPLE_CONTAINER_RUNNER_INVALID_INPUT');
    }
  }
  if (!isPlannerArgv(argv)) return fail('APPLE_CONTAINER_RUNNER_INVALID_INPUT');
}

function sanitizedEnvironment(
  supplied: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { ...FIXED_ENVIRONMENT };
  try {
    for (const key of OPTIONAL_ENVIRONMENT_KEYS) {
      const value = supplied[key];
      if (value === undefined) continue;
      if (typeof value !== 'string'
        || value.length < 1
        || value.normalize('NFC') !== value
        || /[\u0000-\u001f\u007f]/.test(value)
        || Buffer.byteLength(value, 'utf8') > APPLE_CONTAINER_RUNNER_MAX_ENV_VALUE_BYTES) {
        return fail('APPLE_CONTAINER_RUNNER_INVALID_INPUT');
      }
      environment[key] = value;
    }
  } catch {
    return fail('APPLE_CONTAINER_RUNNER_INVALID_INPUT');
  }
  return Object.freeze(environment);
}

function detachedProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    return processErrorCode(cause) !== 'ESRCH';
  }
}

function signalDetachedProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The exact absence check below is authoritative.
  }
}

function stableSpawnFailure(): Readonly<AppleContainerCommandResult> {
  return Object.freeze({
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputTruncated: false,
  });
}

function normalizedExitCode(code: number | null): number | null {
  return typeof code === 'number'
    && Number.isSafeInteger(code)
    && code >= 0
    && code <= 255
    ? code
    : null;
}

function strictDecode(buffer: Buffer, length: number): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch {
    return null;
  }
}

function runValidatedCommand(
  executable: typeof APPLE_CONTAINER_EXECUTABLE,
  argv: readonly string[],
  options: AppleContainerCommandRunnerOptions,
  environment: Readonly<Record<string, string>>,
  spawn: NonNullable<AppleContainerCommandRunnerDependencies['spawn']>,
): Promise<AppleContainerCommandResult> {
  // Two fixed buffers bound allocator overhead as well as captured bytes. The
  // combined captured byte ceiling remains maxOutputBytes, not twice that.
  const stdoutBuffer = Buffer.allocUnsafe(options.maxOutputBytes);
  const stderrBuffer = Buffer.allocUnsafe(options.maxOutputBytes);
  let child: ChildProcess;
  try {
    child = spawn(executable, Object.freeze([...argv]), {
      cwd: '/',
      detached: true,
      env: { ...environment },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    return Promise.resolve(stableSpawnFailure());
  }

  return new Promise((resolveRun, rejectRun) => {
    const deadline = performance.now() + options.timeoutMs;
    const stdout = child.stdout;
    const stderr = child.stderr;
    const stdoutValidator = new TextDecoder('utf-8', { fatal: true });
    const stderrValidator = new TextDecoder('utf-8', { fatal: true });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let combinedBytes = 0;
    let childExited = child.exitCode !== null || child.signalCode !== null;
    let observedExitCode: number | null = child.exitCode;
    let spawnFailed = false;
    let outputTruncated = stdout === null || stderr === null;
    let invalidUtf8 = false;
    let streamFailed = false;
    let childClosed = false;
    let finalizing = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let resolveClosed!: () => void;
    const closePromise = new Promise<void>(resolve => { resolveClosed = resolve; });

    const directChildGone = (): boolean => {
      if (childExited || child.exitCode !== null || child.signalCode !== null) return true;
      return spawnFailed && child.pid === undefined;
    };
    const cleanupConfirmed = (): boolean => {
      const pid = child.pid;
      return directChildGone()
        && (pid === undefined || !detachedProcessGroupAlive(pid));
    };
    const waitForCleanup = async (until: number): Promise<boolean> => {
      while (!cleanupConfirmed() && performance.now() < until) await delay(PROCESS_POLL_MS);
      return cleanupConfirmed();
    };

    let beginFinalize!: (trigger: 'natural' | 'timeout' | 'abort') => void;

    const capture = (
      destination: Buffer,
      stream: 'stdout' | 'stderr',
      rawChunk: Buffer | string,
    ): void => {
      let chunk: Buffer;
      try {
        chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      } catch {
        streamFailed = true;
        outputTruncated = true;
        beginFinalize('abort');
        return;
      }
      const streamBytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const streamRemaining = Math.max(0, options.maxOutputBytes - streamBytes);
      const combinedRemaining = Math.max(0, options.maxOutputBytes - combinedBytes);
      const accepted = Math.min(chunk.byteLength, streamRemaining, combinedRemaining);
      if (accepted > 0) {
        chunk.copy(destination, streamBytes, 0, accepted);
        try {
          (stream === 'stdout' ? stdoutValidator : stderrValidator)
            .decode(chunk.subarray(0, accepted), { stream: true });
        } catch {
          invalidUtf8 = true;
          outputTruncated = true;
        }
        if (stream === 'stdout') stdoutBytes += accepted;
        else stderrBytes += accepted;
        combinedBytes += accepted;
      }
      if (accepted < chunk.byteLength) outputTruncated = true;
      if (outputTruncated || invalidUtf8) beginFinalize('abort');
    };

    const finishDecoder = (decoder: TextDecoder): void => {
      try {
        decoder.decode();
      } catch {
        invalidUtf8 = true;
        outputTruncated = true;
        beginFinalize('abort');
      }
    };

    const finalize = async (trigger: 'natural' | 'timeout' | 'abort'): Promise<void> => {
      const timedOut = trigger === 'timeout'
        || (trigger === 'natural' && performance.now() >= deadline);
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      try {
        const pid = child.pid;
        if (pid !== undefined && detachedProcessGroupAlive(pid)) {
          signalDetachedProcessGroup(pid, 'SIGTERM');
        }
        if (!directChildGone()) {
          try { child.kill('SIGTERM'); } catch { /* absence proof below is authoritative */ }
        }
        if (!await waitForCleanup(performance.now() + PROCESS_TERM_GRACE_MS)) {
          if (pid !== undefined) signalDetachedProcessGroup(pid, 'SIGKILL');
          if (!directChildGone()) {
            try { child.kill('SIGKILL'); } catch { /* absence proof below is authoritative */ }
          }
        }
        if (!await waitForCleanup(performance.now() + PROCESS_KILL_CONFIRM_MS)) {
          return fail('APPLE_CONTAINER_RUNNER_CLEANUP_UNCONFIRMED');
        }

        if (!childClosed) {
          await Promise.race([closePromise, delay(PROCESS_STREAM_CLOSE_GRACE_MS)]);
        }
        if (!childClosed) {
          outputTruncated = true;
          try { stdout?.destroy(); } catch { /* bounded result records truncation */ }
          try { stderr?.destroy(); } catch { /* bounded result records truncation */ }
          await Promise.race([closePromise, delay(PROCESS_STREAM_CLOSE_GRACE_MS)]);
        }
        if (!cleanupConfirmed()) return fail('APPLE_CONTAINER_RUNNER_CLEANUP_UNCONFIRMED');

        const decodedStdout = strictDecode(stdoutBuffer, stdoutBytes);
        const decodedStderr = strictDecode(stderrBuffer, stderrBytes);
        if (decodedStdout === null || decodedStderr === null || invalidUtf8 || streamFailed) {
          outputTruncated = true;
        }
        resolveRun(Object.freeze({
          exitCode: timedOut || outputTruncated || spawnFailed
            ? null
            : normalizedExitCode(observedExitCode),
          stdout: decodedStdout ?? '',
          stderr: decodedStderr ?? '',
          timedOut,
          outputTruncated,
        }));
      } catch (cause) {
        try { stdout?.destroy(); } catch { /* keep the outward error stable */ }
        try { stderr?.destroy(); } catch { /* keep the outward error stable */ }
        rejectRun(cause instanceof AppleContainerCommandRunnerError
          ? cause
          : new AppleContainerCommandRunnerError('APPLE_CONTAINER_RUNNER_EXECUTION_FAILED'));
      }
    };

    beginFinalize = trigger => {
      if (finalizing) return;
      finalizing = true;
      void finalize(trigger);
    };

    child.once('error', () => {
      spawnFailed = true;
      beginFinalize('abort');
    });
    child.once('exit', code => {
      childExited = true;
      observedExitCode = code;
      beginFinalize('natural');
    });
    child.once('close', () => {
      childClosed = true;
      resolveClosed();
    });
    stdout?.on('data', (chunk: Buffer | string) => capture(stdoutBuffer, 'stdout', chunk));
    stderr?.on('data', (chunk: Buffer | string) => capture(stderrBuffer, 'stderr', chunk));
    stdout?.once('end', () => finishDecoder(stdoutValidator));
    stderr?.once('end', () => finishDecoder(stderrValidator));
    stdout?.once('error', () => {
      streamFailed = true;
      outputTruncated = true;
      beginFinalize('abort');
    });
    stderr?.once('error', () => {
      streamFailed = true;
      outputTruncated = true;
      beginFinalize('abort');
    });
    timeoutHandle = setTimeout(() => beginFinalize('timeout'), options.timeoutMs);
    if (outputTruncated) beginFinalize('abort');
  });
}

export function createAppleContainerCommandRunner(
  dependencies: AppleContainerCommandRunnerDependencies = {},
): AppleContainerCommandRunner {
  const spawn = dependencies.spawn
    ?? ((executable, argv, options) => nodeSpawn(executable, [...argv], options));
  const platform = dependencies.platform ?? process.platform;
  return async (executable, argv, options) => {
    try {
      assertRunnerInput(executable, argv, options, platform);
      const environment = sanitizedEnvironment(options.env);
      return await runValidatedCommand(executable, argv, options, environment, spawn);
    } catch (cause) {
      if (cause instanceof AppleContainerCommandRunnerError) throw cause;
      throw new AppleContainerCommandRunnerError('APPLE_CONTAINER_RUNNER_EXECUTION_FAILED');
    }
  };
}

/**
 * Default production adapter. exitCode 0 and grammar validation imply neither
 * authorization, registry ownership, containment readiness, nor self-test.
 */
export const runAppleContainerCommand: AppleContainerCommandRunner =
  createAppleContainerCommandRunner();
