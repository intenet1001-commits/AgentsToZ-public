import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type {
  CodexAgentAppServerProcess,
  SpawnCodexAgentAppServer,
} from './codexAgentRuntime';
import { confirmCodexProcessGroupTerminated } from './codexAgentRuntime';
import {
  isCodexRuntimeExecutableIdentityForPlatform,
  type CodexRuntimeExecutableIdentity,
} from './codexRuntimeExecutable';
import type {
  ClaudeRemoteControlProcess,
  SpawnClaudeRemoteControl,
} from './claudeRemoteConversation';
import {
  AGENT_RUNTIME_GUARD_RESERVATION_ENV,
  encodeAgentRuntimeGuardReservation,
  type AgentRuntimeGuardRegistry,
  type AgentRuntimeGuardReservation,
} from './agentRuntimeGuardRegistry';

const PACKAGED_API_NAME_RE = /^agentstoz-api-sidecar(?:\.exe)?$/i;
const GUARD_BASENAME = process.platform === 'win32'
  ? 'agentstoz-agent-runtime-guard.exe'
  : 'agentstoz-agent-runtime-guard';
export const AGENT_RUNTIME_CODEX_IDENTITY_ENV = 'AGENTSTOZ_CODEX_EXECUTABLE_IDENTITY_V1';
const MAX_ENCODED_CODEX_IDENTITY_BYTES = 32 * 1024;
/**
 * The guard never runs inside the target workspace. Bun autoloads a `.env` from
 * the process cwd before any user code executes, and a compiled guard has no
 * CLI flag that can turn that off, so an untrusted project directory as cwd
 * would inject that project's dotenv into the guard and then into the provider.
 * `/` is guaranteed to exist and is not writable by the launching user.
 */
const GUARD_NEUTRAL_CWD = '/';

export interface AgentRuntimeGuardLaunchers {
  readonly spawnCodex: SpawnCodexAgentAppServer;
  readonly spawnClaudeRemote: SpawnClaudeRemoteControl;
}

function assertWorkspaceDirectory(cwd: string): void {
  // Spawning the guard from GUARD_NEUTRAL_CWD means Bun no longer raises ENOENT
  // for a workspace that was deleted or renamed while the app was running: '/'
  // always exists. Without this check the launch would look like it started,
  // the durable reservation would be committed to 'active', and the failure
  // would surface later inside the guard as an unhandled posix_spawn error
  // naming /usr/bin/env instead of the missing project. Fail here, before the
  // reservation, so the caller still gets a clean startup error.
  let info;
  try {
    info = statSync(cwd);
  } catch {
    throw new Error(`The workspace directory is unavailable: ${cwd}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`The workspace path is not a directory: ${cwd}`);
  }
}

function isDefinitelyMissingPath(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function verifiedRegularFile(path: string, executable: boolean): string | null {
  try {
    const canonical = realpathSync(path);
    const info = statSync(canonical);
    if (!info.isFile()) return null;
    if (executable && process.platform !== 'win32' && (info.mode & 0o111) === 0) return null;
    return canonical;
  } catch (error) {
    if (isDefinitelyMissingPath(error)) return null;
    throw error;
  }
}

/** Internal-only fixed launcher prefix. No remote value participates in it. */
export function resolveAgentRuntimeGuardCommand(): readonly string[] | null {
  if (process.platform === 'win32') return null;
  if (PACKAGED_API_NAME_RE.test(basename(process.execPath))) {
    const packaged = verifiedRegularFile(join(dirname(process.execPath), GUARD_BASENAME), true);
    return packaged ? [packaged] : null;
  }

  const bun = verifiedRegularFile(process.execPath, true);
  const source = verifiedRegularFile(join(import.meta.dir, '..', 'agent-runtime-process-guard.ts'), false);
  const bunfig = verifiedRegularFile(
    join(import.meta.dir, '..', 'agent-runtime-guard.bunfig.toml'),
    false,
  );
  return bun && source && bunfig
    ? [bun, '--env-file=/dev/null', '--no-install', `--config=${bunfig}`, source]
    : null;
}

/**
 * Spawns the fixed guard, which in turn owns the provider process group. The
 * prompt still travels only over stdio; this argv contains provider policy and
 * executable details but no user content.
 */
function removeFailedReservation(
  registry: AgentRuntimeGuardRegistry,
  reservation: AgentRuntimeGuardReservation,
): void {
  try { registry.cancelReservation(reservation); } catch {
    // A surviving/uncertain record intentionally blocks stale lease recovery.
  }
}

/**
 * Claude Remote Control needs the same parent-death boundary as Agent Runtime.
 * Its exposed `kill` method targets the detached process group, not only the
 * guard leader, so synchronous exit hooks cannot strand the provider while
 * preventing the guard from observing its parent pipe closing.
 */
export function createAgentRuntimeGuardLaunchers(
  registry: AgentRuntimeGuardRegistry,
): AgentRuntimeGuardLaunchers {
  const spawnCodex: SpawnCodexAgentAppServer = (
    command,
    options,
    executableIdentity,
  ): CodexAgentAppServerProcess => {
    const guard = resolveAgentRuntimeGuardCommand();
    if (!guard) throw new Error('Agent Runtime process guard is unavailable.');
    if (!isCodexRuntimeExecutableIdentityForPlatform(executableIdentity, process.platform)
      || executableIdentity.path !== command[0]) {
      throw new Error('A verified Codex executable identity is required by the process guard.');
    }
    const encodedIdentity = Buffer.from(
      JSON.stringify(executableIdentity),
      'utf8',
    ).toString('base64url');
    if (Buffer.byteLength(encodedIdentity) > MAX_ENCODED_CODEX_IDENTITY_BYTES) {
      throw new Error('The Codex executable identity exceeds the process guard limit.');
    }
    assertWorkspaceDirectory(options.cwd);
    const reservation = registry.reserve({ kind: 'codex', cwd: options.cwd });
    let child: Bun.PipedSubprocess;
    try {
      child = Bun.spawn([
        ...guard,
        'agentstoz-provider-argv-v4',
        options.cwd,
        ...command,
      ], {
        ...options,
        cwd: GUARD_NEUTRAL_CWD,
        env: {
          ...options.env,
          [AGENT_RUNTIME_CODEX_IDENTITY_ENV]: encodedIdentity,
          [AGENT_RUNTIME_GUARD_RESERVATION_ENV]:
            encodeAgentRuntimeGuardReservation(reservation),
        },
      });
    } catch (error) {
      removeFailedReservation(registry, reservation);
      throw error;
    }
    let releaseResult: boolean | null = null;
    const releaseGuardRecordAfterTermination = (): boolean => {
      if (releaseResult !== null) return releaseResult;
      releaseResult = registry.releaseAfterGroupTermination(reservation, child.pid);
      return releaseResult;
    };
    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill: signal => child.kill(signal),
      releaseGuardRecordAfterTermination,
    } as CodexAgentAppServerProcess;
  };

  const spawnClaudeRemote: SpawnClaudeRemoteControl = (command, options): ClaudeRemoteControlProcess => {
    const guard = resolveAgentRuntimeGuardCommand();
    if (!guard) throw new Error('Claude Remote Control process guard is unavailable.');
    assertWorkspaceDirectory(options.cwd);
    const reservation = registry.reserve({ kind: 'claude-remote', cwd: options.cwd });
    let child: Bun.PipedSubprocess;
    try {
      child = Bun.spawn([
        ...guard,
        'agentstoz-claude-remote-argv-v3',
        options.cwd,
        ...command,
      ], {
        ...options,
        cwd: GUARD_NEUTRAL_CWD,
        detached: true,
        env: {
          ...options.env,
          [AGENT_RUNTIME_GUARD_RESERVATION_ENV]:
            encodeAgentRuntimeGuardReservation(reservation),
        },
      });
    } catch (error) {
      removeFailedReservation(registry, reservation);
      throw error;
    }
    const signalGroup = (signal: number | NodeJS.Signals): unknown => {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error: any) {
        // Darwin can transiently report EPERM while the group is being reaped;
        // ESRCH can race with the subsequent probe. Neither is treated as proof
        // here: the caller must still confirm the PGID disappeared.
        if (error?.code === 'ESRCH' || error?.code === 'EPERM') return error;
        throw error;
      }
    };
    const containedExit = child.exited.then(async exitCode => {
      if (!await confirmCodexProcessGroupTerminated(child.pid, 0)) {
        // A leader exit is not proof that helpers are gone. Reap and verify the
        // detached PGID before the manager is allowed to release ownership.
        const signalError = signalGroup('SIGKILL');
        if (!await confirmCodexProcessGroupTerminated(child.pid, 1_000)) {
          throw new Error(
            'Claude Remote Control process group termination was not confirmed.',
            signalError === undefined ? undefined : { cause: signalError },
          );
        }
      }
      if (!registry.releaseAfterGroupTermination(reservation, child.pid)) {
        throw new Error('Claude Remote Control durable guard ownership was not released.');
      }
      return exitCode;
    });
    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: containedExit,
      kill(signal) {
        const groupSignal = signal ?? 'SIGTERM';
        signalGroup(groupSignal);
      },
    };
  };

  return Object.freeze({ spawnCodex, spawnClaudeRemote });
}
