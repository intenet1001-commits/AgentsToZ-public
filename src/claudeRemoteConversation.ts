export const CLAUDE_REMOTE_SESSION_START_TIMEOUT_MS = 30_000;

// Require Claude CLI's line/ANSI boundary after the complete ID. Accepting end
// of the current stream chunk would let a 129-byte ID split after byte 128 be
// mistaken for a valid prefix before the next chunk arrives.
const CLAUDE_REMOTE_SESSION_URL_RE = /https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]{12,128})(?![A-Za-z0-9])(?=[\s\u001b])/;
const OUTPUT_TAIL_LIMIT = 4_096;

export type ClaudeRemoteConversationErrorCode =
  | 'CLAUDE_REMOTE_SESSION_START_FAILED'
  | 'CLAUDE_REMOTE_SESSION_TIMEOUT'
  | 'CLAUDE_REMOTE_SESSION_CREATED_OPEN_FAILED'
  | 'CLAUDE_REMOTE_SESSION_WORKSPACE_BUSY'
  | 'CLAUDE_REMOTE_SESSION_WORKSPACE_UNKNOWN';

export class ClaudeRemoteConversationError extends Error {
  constructor(
    readonly code: ClaudeRemoteConversationErrorCode,
    readonly publicMessage: string,
    options?: { cause?: unknown },
  ) {
    super(publicMessage, options);
    this.name = 'ClaudeRemoteConversationError';
  }
}

interface WritablePipe {
  write(chunk: string | Uint8Array): unknown;
  flush?(): unknown;
  end?(): unknown;
}

export interface ClaudeRemoteControlProcess {
  pid?: number;
  stdin: WritablePipe;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): unknown;
}

export type SpawnClaudeRemoteControl = (
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'pipe';
  },
) => ClaudeRemoteControlProcess;

export type TerminateClaudeRemoteControlProcessTree = (pid: number) => Promise<void>;

type MaybePromise<T> = T | Promise<T>;

export interface ClaudeRemoteConversationWorkspaceLease {
  /** Only an exact `true` proves that this manager no longer owns the lease. */
  release(): MaybePromise<boolean>;
}

export type AcquireClaudeRemoteConversationWorkspaceLease = (input: Readonly<{
  projectKey: string;
  folderPath: string;
}>) => MaybePromise<ClaudeRemoteConversationWorkspaceLease | null>;

export interface ClaudeRemoteConversationManagerOptions {
  terminateProcessTree?: TerminateClaudeRemoteControlProcessTree;
  terminationGraceMs?: number;
  /**
   * Optional for backwards compatibility. Production callers should provide
   * the process-wide workspace coordinator so Claude cannot overlap another
   * managed writer for the same Git family.
   */
  acquireWorkspaceLease?: AcquireClaudeRemoteConversationWorkspaceLease;
  /** Bounds lease release and shutdown bookkeeping without assuming success. */
  leaseOperationTimeoutMs?: number;
}

export interface ClaudeRemoteConversationResult {
  sessionId: string;
  sessionUrl: string;
  reusedActiveSession: boolean;
}

interface ActiveClaudeRemoteConversation {
  sessionId: string;
  sessionUrl: string;
  process: ClaudeRemoteControlProcess;
  exited: boolean;
}

interface ProcessWorkspaceLease {
  projectKey: string;
  lease: ClaudeRemoteConversationWorkspaceLease;
}

function boundedSessionName(deviceName: string, projectName: string): string {
  const device = deviceName.trim().replace(/\s+/g, ' ').slice(0, 48) || '이 Mac';
  const project = projectName.trim().replace(/\s+/g, ' ').slice(0, 72) || '프로젝트';
  return `AgentsToZ · ${device} · ${project}`.slice(0, 128);
}

function privateFailureDetail(stdoutTail: string, stderrTail: string, exitCode?: number): Error | undefined {
  const cleaned = [
    stdoutTail ? `stdout: ${stdoutTail}` : '',
    stderrTail ? `stderr: ${stderrTail}` : '',
    typeof exitCode === 'number' ? `exit: ${exitCode}` : '',
  ].filter(Boolean).join('\n')
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .trim()
    .slice(-OUTPUT_TAIL_LIMIT);
  return cleaned ? new Error(cleaned) : undefined;
}

function startFailure(stdoutTail = '', stderrTail = '', exitCode?: number): ClaudeRemoteConversationError {
  return new ClaudeRemoteConversationError(
    'CLAUDE_REMOTE_SESSION_START_FAILED',
    'Claude Code 원격 대화를 시작하지 못했습니다. Claude Code 로그인과 프로젝트 신뢰 상태를 확인하세요.',
    { cause: privateFailureDetail(stdoutTail, stderrTail, exitCode) },
  );
}

function shutdownFailure(): ClaudeRemoteConversationError {
  return new ClaudeRemoteConversationError(
    'CLAUDE_REMOTE_SESSION_START_FAILED',
    'Claude Code 원격 대화를 시작하지 못했습니다. AgentsToZ 앱이 종료 중입니다.',
  );
}

function workspaceBusyFailure(): ClaudeRemoteConversationError {
  return new ClaudeRemoteConversationError(
    'CLAUDE_REMOTE_SESSION_WORKSPACE_BUSY',
    '이 프로젝트에서는 이미 다른 에이전트 작업이 실행 중입니다.',
  );
}

function workspaceUnknownFailure(cause?: unknown): ClaudeRemoteConversationError {
  return new ClaudeRemoteConversationError(
    'CLAUDE_REMOTE_SESSION_WORKSPACE_UNKNOWN',
    '프로젝트 작업 잠금 상태를 안전하게 확인하지 못했습니다.',
    cause === undefined ? undefined : { cause },
  );
}

function validWorkspaceLease(value: unknown): value is ClaudeRemoteConversationWorkspaceLease {
  return typeof value === 'object'
    && value !== null
    && typeof (value as ClaudeRemoteConversationWorkspaceLease).release === 'function';
}

const waitForSettlement = async (
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const waitForProcessExit = async (
  child: ClaudeRemoteControlProcess,
  timeoutMs: number,
): Promise<boolean> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // A rejected observation is not proof of exit. Keep ownership and force
      // the contained process boundary instead of treating telemetry failure
      // as successful cleanup.
      child.exited.then(() => true, () => false),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

/**
 * Starts Claude Code's official Remote Control server for exactly one project
 * session and opens the exact returned session in Claude Desktop. The process
 * stays alive because the mobile/web UI is only a window into this Mac's local
 * Claude Code runtime.
 *
 * Repeated presses are coalesced per canonical project path. Once a session URL
 * exists, an app-open failure is retryable without creating another session.
 */
export class ClaudeRemoteConversationManager {
  readonly #activeByProject = new Map<string, ActiveClaudeRemoteConversation>();
  readonly #inflightByProject = new Map<string, Promise<ClaudeRemoteConversationResult>>();
  readonly #ownedProcesses = new Set<ClaudeRemoteControlProcess>();
  readonly #terminationByProcess = new Map<ClaudeRemoteControlProcess, Promise<void>>();
  readonly #workspaceLeaseByProject = new Map<string, ClaudeRemoteConversationWorkspaceLease>();
  readonly #workspaceLeaseByProcess = new Map<ClaudeRemoteControlProcess, ProcessWorkspaceLease>();
  readonly #ownedWorkspaceLeases = new Set<ClaudeRemoteConversationWorkspaceLease>();
  readonly #workspaceLeaseRelease = new Map<ClaudeRemoteConversationWorkspaceLease, Promise<boolean>>();
  readonly #pendingLeaseAcquisitions = new Set<Promise<ClaudeRemoteConversationWorkspaceLease | null>>();
  readonly #lateLeaseCleanups = new Set<Promise<void>>();
  readonly #terminateProcessTree?: TerminateClaudeRemoteControlProcessTree;
  readonly #acquireWorkspaceLease?: AcquireClaudeRemoteConversationWorkspaceLease;
  readonly #terminationGraceMs: number;
  readonly #leaseOperationTimeoutMs: number;
  #leaseStateUncertain = false;
  #shuttingDown = false;

  constructor(options: ClaudeRemoteConversationManagerOptions = {}) {
    this.#terminateProcessTree = options.terminateProcessTree;
    this.#acquireWorkspaceLease = options.acquireWorkspaceLease;
    this.#terminationGraceMs = Math.max(1, Math.min(5_000, options.terminationGraceMs ?? 250));
    this.#leaseOperationTimeoutMs = Math.max(
      1,
      Math.min(30_000, options.leaseOperationTimeoutMs ?? 5_000),
    );
  }

  startAndOpen(input: {
    projectKey: string;
    folderPath: string;
    projectName: string;
    deviceName: string;
    claudePath: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    spawn?: SpawnClaudeRemoteControl;
    openSession(sessionId: string): void;
  }): Promise<ClaudeRemoteConversationResult> {
    if (this.#shuttingDown) {
      return Promise.reject(shutdownFailure());
    }
    const active = this.#activeByProject.get(input.projectKey);
    if (active && !active.exited) {
      return this.#openExisting(active, input.openSession);
    }
    const inflight = this.#inflightByProject.get(input.projectKey);
    if (inflight) return inflight;
    // A process that has exited is no longer reusable, but its exact lease
    // release may still be in flight. Do not ask the coordinator for a second
    // lease until the first ownership boundary is conclusively gone.
    if (this.#workspaceLeaseByProject.has(input.projectKey)) {
      return Promise.reject(workspaceBusyFailure());
    }
    if (this.#lateLeaseCleanups.size > 0) {
      return Promise.reject(workspaceUnknownFailure());
    }
    const task = this.#startAndOpen(input).finally(() => {
      if (this.#inflightByProject.get(input.projectKey) === task) {
        this.#inflightByProject.delete(input.projectKey);
      }
    });
    this.#inflightByProject.set(input.projectKey, task);
    return task;
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const owned = [...this.#ownedProcesses];
    const results = await Promise.allSettled(owned.map(process => this.#terminate(process)));

    // A start can be waiting for a coordinator when shutdown begins. It must
    // either finish (and observe #shuttingDown before spawn) or make shutdown
    // fail; returning success while a late lease may arrive would lose it.
    const inflightSettled = await Promise.all(
      [...this.#inflightByProject.values()]
        .map(task => waitForSettlement(task, this.#leaseOperationTimeoutMs)),
    );
    const releaseSettled = await Promise.all(
      [...this.#workspaceLeaseRelease.values(), ...this.#lateLeaseCleanups]
        .map(task => waitForSettlement(task, this.#leaseOperationTimeoutMs)),
    );
    this.#activeByProject.clear();
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (inflightSettled.some(value => !value)) {
      failures.push(new Error('Claude Remote Control start did not settle during shutdown.'));
    }
    if (releaseSettled.some(value => !value)) {
      failures.push(new Error('Claude Remote Control workspace lease cleanup did not settle.'));
    }
    if (failures.length > 0
      || this.#ownedProcesses.size > 0
      || this.#ownedWorkspaceLeases.size > 0
      || this.#pendingLeaseAcquisitions.size > 0
      || this.#lateLeaseCleanups.size > 0
      || this.#leaseStateUncertain) {
      throw new AggregateError(failures, 'Claude Remote Control shutdown was not confirmed.');
    }
  }

  /** Last-resort synchronous exit hook. Normal signals await shutdown(). */
  forceKillNow(): void {
    this.#shuttingDown = true;
    for (const process of this.#ownedProcesses) {
      try { process.kill('SIGKILL'); } catch { /* process may already be gone */ }
    }
    this.#activeByProject.clear();
  }

  async #acquireLease(
    input: { projectKey: string; folderPath: string },
    timeoutMs: number,
  ): Promise<ClaudeRemoteConversationWorkspaceLease | undefined> {
    if (!this.#acquireWorkspaceLease) return undefined;
    const acquisition = Promise.resolve().then(() => this.#acquireWorkspaceLease!({
      projectKey: input.projectKey,
      folderPath: input.folderPath,
    }));
    this.#pendingLeaseAcquisitions.add(acquisition);
    void acquisition.then(
      () => this.#pendingLeaseAcquisitions.delete(acquisition),
      () => this.#pendingLeaseAcquisitions.delete(acquisition),
    );

    const timedOut = Symbol('workspace lease acquisition timed out');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let lease: ClaudeRemoteConversationWorkspaceLease | null | typeof timedOut;
    try {
      lease = await Promise.race([
        acquisition,
        new Promise<typeof timedOut>(resolve => {
          timeout = setTimeout(() => resolve(timedOut), Math.max(1, timeoutMs));
        }),
      ]);
    } catch (cause) {
      throw workspaceUnknownFailure(cause);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (lease === timedOut) {
      this.#trackLateLeaseAcquisition(input.projectKey, acquisition);
      throw new ClaudeRemoteConversationError(
        'CLAUDE_REMOTE_SESSION_TIMEOUT',
        'Claude Code 원격 대화 연결 시간이 초과되었습니다. Claude Code 로그인과 네트워크 상태를 확인하세요.',
      );
    }
    if (lease === null) throw workspaceBusyFailure();
    if (!validWorkspaceLease(lease)) {
      // A coordinator that claims success without a releasable handle may
      // already own external state. Fence the manager rather than guessing.
      this.#leaseStateUncertain = true;
      this.#shuttingDown = true;
      throw workspaceUnknownFailure();
    }
    this.#ownedWorkspaceLeases.add(lease);
    this.#workspaceLeaseByProject.set(input.projectKey, lease);
    return lease;
  }

  #trackLateLeaseAcquisition(
    projectKey: string,
    acquisition: Promise<ClaudeRemoteConversationWorkspaceLease | null>,
  ): void {
    let cleanup!: Promise<void>;
    cleanup = (async () => {
      try {
        const lease = await acquisition;
        if (lease === null) return;
        if (!validWorkspaceLease(lease)) {
          this.#leaseStateUncertain = true;
          this.#shuttingDown = true;
          return;
        }
        // Register before the first await. Shutdown and new starts must see
        // this ownership even if release itself is asynchronous.
        this.#ownedWorkspaceLeases.add(lease);
        this.#workspaceLeaseByProject.set(projectKey, lease);
        await this.#releaseWorkspaceLease(projectKey, lease);
      } catch {
        // A rejected acquisition returned no ownership handle. The original
        // request already reported a fixed public timeout.
      } finally {
        this.#lateLeaseCleanups.delete(cleanup);
      }
    })();
    this.#lateLeaseCleanups.add(cleanup);
  }

  #releaseWorkspaceLease(
    projectKey: string,
    lease: ClaudeRemoteConversationWorkspaceLease,
  ): Promise<boolean> {
    const existing = this.#workspaceLeaseRelease.get(lease);
    if (existing) return existing;

    const rawRelease = Promise.resolve().then(() => lease.release());
    const timedOut = Symbol('workspace lease release timed out');
    const task = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const released = await Promise.race([
          rawRelease,
          new Promise<typeof timedOut>(resolve => {
            timeout = setTimeout(() => resolve(timedOut), this.#leaseOperationTimeoutMs);
          }),
        ]);
        if (released === true) {
          this.#ownedWorkspaceLeases.delete(lease);
          if (this.#workspaceLeaseByProject.get(projectKey) === lease) {
            this.#workspaceLeaseByProject.delete(projectKey);
          }
          return true;
        }
        // false, timeout, or any non-boolean response is not proof of release.
        this.#leaseStateUncertain = true;
        this.#shuttingDown = true;
        return false;
      } catch {
        this.#leaseStateUncertain = true;
        this.#shuttingDown = true;
        return false;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })();
    this.#workspaceLeaseRelease.set(lease, task);
    return task;
  }

  async #finalizeExitedProcess(child: ClaudeRemoteControlProcess): Promise<boolean> {
    this.#ownedProcesses.delete(child);
    const ownership = this.#workspaceLeaseByProcess.get(child);
    if (!ownership) return true;
    const released = await this.#releaseWorkspaceLease(ownership.projectKey, ownership.lease);
    if (released) this.#workspaceLeaseByProcess.delete(child);
    return released;
  }

  #terminate(child: ClaudeRemoteControlProcess): Promise<void> {
    const existing = this.#terminationByProcess.get(child);
    if (existing) return existing;
    const task = (async () => {
      let treeTerminationCompleted = false;
      if (this.#terminateProcessTree && Number.isInteger(child.pid) && Number(child.pid) > 1) {
        try {
          await this.#terminateProcessTree(Number(child.pid));
          treeTerminationCompleted = true;
        } catch {
          // Fall through to direct TERM/KILL so a tree helper failure does not
          // turn the Claude process into an orphan.
        }
        if (treeTerminationCompleted && await waitForProcessExit(child, this.#terminationGraceMs)) {
          if (!await this.#finalizeExitedProcess(child)) {
            throw new Error('Claude Remote Control workspace lease release was not confirmed.');
          }
          return;
        }
      } else {
        try { child.kill('SIGTERM'); } catch { /* process may already be gone */ }
        if (await waitForProcessExit(child, this.#terminationGraceMs)) {
          if (!await this.#finalizeExitedProcess(child)) {
            throw new Error('Claude Remote Control workspace lease release was not confirmed.');
          }
          return;
        }
      }
      try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
      if (!await waitForProcessExit(child, this.#terminationGraceMs)) {
        throw new Error('Claude Remote Control process termination was not confirmed.');
      }
      if (!await this.#finalizeExitedProcess(child)) {
        throw new Error('Claude Remote Control workspace lease release was not confirmed.');
      }
    })().catch(cause => {
      // Any failed termination proof fences the whole manager. Retrying a
      // start while this owned process may still be alive would create two
      // concurrent remote writers.
      this.#shuttingDown = true;
      throw cause;
    }).finally(() => {
      if (this.#terminationByProcess.get(child) === task) {
        this.#terminationByProcess.delete(child);
      }
    });
    this.#terminationByProcess.set(child, task);
    return task;
  }

  async #openExisting(
    active: ActiveClaudeRemoteConversation,
    openSession: (sessionId: string) => void,
  ): Promise<ClaudeRemoteConversationResult> {
    try {
      openSession(active.sessionId);
    } catch (cause) {
      throw new ClaudeRemoteConversationError(
        'CLAUDE_REMOTE_SESSION_CREATED_OPEN_FAILED',
        'Claude Code 원격 대화는 이미 실행 중이지만 Claude 앱에서 열지 못했습니다. Claude 앱 상태를 확인한 뒤 같은 버튼으로 다시 시도하세요.',
        { cause },
      );
    }
    return {
      sessionId: active.sessionId,
      sessionUrl: active.sessionUrl,
      reusedActiveSession: true,
    };
  }

  async #startAndOpen(input: {
    projectKey: string;
    folderPath: string;
    projectName: string;
    deviceName: string;
    claudePath: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    spawn?: SpawnClaudeRemoteControl;
    openSession(sessionId: string): void;
  }): Promise<ClaudeRemoteConversationResult> {
    const startTimeoutMs = Math.max(
      1,
      Math.min(CLAUDE_REMOTE_SESSION_START_TIMEOUT_MS, input.timeoutMs ?? CLAUDE_REMOTE_SESSION_START_TIMEOUT_MS),
    );
    const deadline = Date.now() + startTimeoutMs;
    // Preserve the legacy synchronous spawn boundary when no coordinator was
    // injected; the optional dependency exists only for backwards compatibility.
    const workspaceLease = this.#acquireWorkspaceLease
      ? await this.#acquireLease(input, startTimeoutMs)
      : undefined;
    if (this.#shuttingDown) {
      if (workspaceLease) {
        const released = await this.#releaseWorkspaceLease(input.projectKey, workspaceLease);
        if (!released) throw workspaceUnknownFailure();
      }
      throw shutdownFailure();
    }

    const spawn = input.spawn ?? ((command, options) => (
      Bun.spawn(command, options) as unknown as ClaudeRemoteControlProcess
    ));
    let child: ClaudeRemoteControlProcess;
    try {
      child = spawn([
        input.claudePath,
        'remote-control',
        '--spawn=session',
        '--name',
        boundedSessionName(input.deviceName, input.projectName),
        '--permission-mode',
        'default',
      ], {
        cwd: input.folderPath,
        env: input.env ?? process.env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (cause) {
      if (workspaceLease) {
        await this.#releaseWorkspaceLease(input.projectKey, workspaceLease);
      }
      throw new ClaudeRemoteConversationError(
        'CLAUDE_REMOTE_SESSION_START_FAILED',
        'Claude Code를 실행하지 못했습니다. 이 Mac에 Claude Code가 설치되어 있는지 확인하세요.',
        { cause },
      );
    }
    this.#ownedProcesses.add(child);
    if (workspaceLease) {
      this.#workspaceLeaseByProcess.set(child, {
        projectKey: input.projectKey,
        lease: workspaceLease,
      });
    }

    let settled = false;
    let childExited = false;
    let cleanupStarted = false;
    let stdoutTail = '';
    let stderrTail = '';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const session = new Promise<{ sessionId: string; sessionUrl: string }>((resolve, reject) => {
      const accept = (streamName: 'stdout' | 'stderr', chunk: string) => {
        if (streamName === 'stdout') {
          stdoutTail = `${stdoutTail}${chunk}`.slice(-OUTPUT_TAIL_LIMIT);
        } else {
          stderrTail = `${stderrTail}${chunk}`.slice(-OUTPUT_TAIL_LIMIT);
        }
        if (settled) return;
        const streamTail = streamName === 'stdout' ? stdoutTail : stderrTail;
        const match = streamTail.match(CLAUDE_REMOTE_SESSION_URL_RE);
        if (!match) return;
        settled = true;
        resolve({ sessionId: match[1]!, sessionUrl: match[0] });
      };
      const pump = async (streamName: 'stdout' | 'stderr', stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (value) accept(streamName, decoder.decode(value, { stream: true }));
            if (done) {
              const finalChunk = decoder.decode();
              if (finalChunk) accept(streamName, finalChunk);
              break;
            }
          }
        } catch { /* process exit owns the public failure */ }
        finally { reader.releaseLock(); }
      };
      void pump('stdout', child.stdout);
      void pump('stderr', child.stderr);
      void child.exited.then(async code => {
        childExited = true;
        cleanupStarted = true;
        const shouldRejectStart = !settled;
        if (shouldRejectStart) settled = true;
        const active = this.#activeByProject.get(input.projectKey);
        if (active?.process === child) {
          active.exited = true;
          this.#activeByProject.delete(input.projectKey);
        }
        await this.#finalizeExitedProcess(child);
        if (shouldRejectStart) {
          reject(startFailure(stdoutTail, stderrTail, code));
        }
      }).catch(cause => {
        // Losing the only trustworthy exit observation is a manager-wide
        // containment failure. Keep ownership and reject every later start so
        // an unconfirmed writer can never overlap a replacement session.
        this.#shuttingDown = true;
        cleanupStarted = true;
        const active = this.#activeByProject.get(input.projectKey);
        if (active?.process === child) {
          active.exited = true;
          this.#activeByProject.delete(input.projectKey);
        }
        if (!settled) {
          settled = true;
          const failure = new ClaudeRemoteConversationError(
            'CLAUDE_REMOTE_SESSION_START_FAILED',
            'Claude Code 원격 대화 프로세스 상태를 확인하지 못했습니다.',
            { cause },
          );
          void this.#terminate(child).then(
            () => reject(failure),
            () => reject(failure),
          );
        } else {
          void this.#terminate(child).catch(() => undefined);
        }
      });
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupStarted = true;
        const failure = new ClaudeRemoteConversationError(
          'CLAUDE_REMOTE_SESSION_TIMEOUT',
          'Claude Code 원격 대화 연결 시간이 초과되었습니다. Claude Code 로그인과 네트워크 상태를 확인하세요.',
        );
        // Always consume a failed termination proof. The public attempt still
        // reports timeout, while ownership remains for shutdown/force cleanup.
        void this.#terminate(child).then(
          () => reject(failure),
          () => reject(failure),
        );
      }, Math.max(1, deadline - Date.now()));
    });

    let created: { sessionId: string; sessionUrl: string };
    try {
      created = await session;
    } catch (error) {
      // Timeout and observed-exit paths already finish through #terminate or
      // #finalizeExitedProcess. This branch also contains malformed process
      // surfaces without abandoning their workspace ownership.
      if (!cleanupStarted && this.#ownedProcesses.has(child)) {
        await this.#terminate(child).catch(() => undefined);
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    // shutdown() snapshots every process it owns, but a still-starting Claude
    // child can print its URL while TERM is in the grace window. Re-check at
    // the irreversible UI boundary and share the same termination promise so
    // that late output can neither register an active session nor open Claude.
    if (this.#shuttingDown) {
      await this.#terminate(child);
      throw shutdownFailure();
    }
    if (childExited) {
      await this.#finalizeExitedProcess(child);
      throw startFailure(stdoutTail, stderrTail);
    }
    const active: ActiveClaudeRemoteConversation = {
      ...created,
      process: child,
      exited: false,
    };
    this.#activeByProject.set(input.projectKey, active);
    try {
      input.openSession(created.sessionId);
    } catch (cause) {
      throw new ClaudeRemoteConversationError(
        'CLAUDE_REMOTE_SESSION_CREATED_OPEN_FAILED',
        'Claude Code 원격 대화는 시작했지만 Claude 앱에서 열지 못했습니다. 같은 버튼을 다시 누르면 새 대화 없이 방금 대화를 다시 엽니다.',
        { cause },
      );
    }
    return { ...created, reusedActiveSession: false };
  }
}
