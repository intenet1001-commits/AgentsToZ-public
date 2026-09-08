import { isAbsolute, relative, sep } from 'node:path';

import {
  AGENT_RUNTIME_EVENT_READ_LIMIT,
  AGENT_RUNTIME_MAX_CONCURRENT_TASKS,
  AGENT_RUNTIME_MAX_MODELS_PER_ADAPTER,
  AGENT_RUNTIME_TASK_LIST_LIMIT,
  type AgentRuntimeAdapterCapability,
  type AgentRuntimeCapabilitiesResponse,
  type AgentRuntimeModelCapability,
  type AgentTaskCancelRequest,
  type AgentTaskCancelResponse,
  type AgentTaskEventsResponse,
  type AgentTaskListResponse,
  type AgentTaskStartResponse,
  normalizeAgentTaskCancelRequest,
} from './agentRuntimeApiContract';
import {
  CodexAgentRuntimeError,
  codexAgentTaskFailure,
  type CodexAgentTaskResult,
  type RunCodexAgentTaskInput,
  runCodexAgentTask,
} from './codexAgentRuntime';
import {
  isCodexRuntimeExecutableIdentity,
  isCodexRuntimeExecutableIdentityForPlatform,
  type CodexRuntimeExecutableIdentity,
} from './codexRuntimeExecutable';
import { AgentRuntimeHttpError, type AgentRuntimeHttpService } from './agentRuntimeHttp';
import {
  AGENT_RUNTIME_DANGEROUS_MODE_ENABLED,
  AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED,
  AGENT_RUNTIME_MAX_PROMPT_BYTES,
  AGENT_RUNTIME_PROTOCOL_VERSION,
  normalizeAgentTaskStartRequest,
  type AgentTaskEvent,
  type AgentTaskEventDraft,
  type AgentTaskStartRequest,
  type AgentTaskStatus,
} from './agentRuntimeProtocol';
import {
  BUILTIN_AGENT_RUNTIME_REGISTRY,
  type BuiltinAgentRuntimeId,
} from './agentRuntimeRegistry';
import {
  AgentRuntimeTaskJournalError,
  type AgentRuntimeTaskJournal,
  type AgentTaskExecutionRecord,
  type CreateAgentRuntimeTaskInput,
} from './agentRuntimeTaskJournal';

const TASK_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const TERMINAL_STATUSES = new Set<AgentTaskStatus>(['succeeded', 'failed', 'cancelled']);
const DEFAULT_CANCEL_WAIT_MS = 2_000;
const MAX_CANCEL_WAIT_MS = 10_000;
const DEFAULT_RESOLUTION_TIMEOUT_MS = 5_000;
const MAX_RESOLUTION_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_WAIT_MS = 10_000;
const MAX_SHUTDOWN_WAIT_MS = 30_000;
export const AGENT_RUNTIME_MAX_PENDING_STARTS = 8;

type MaybePromise<T> = T | Promise<T>;

export interface AgentRuntimeResolvedTarget {
  targetId: string;
  projectLabel: string;
  cwd: string;
}

export type ResolveAgentRuntimeTarget = (
  targetId: string,
) => MaybePromise<AgentRuntimeResolvedTarget>;

export interface AgentRuntimeResolvedModel extends AgentRuntimeModelCapability {
  /** Provider launch value. It is internal and never serialized to clients. */
  providerModel: string;
  /** Catalog-supported provider effort. It is internal and never serialized to clients. */
  reasoningEffort: string;
}

export interface AgentRuntimeResolvedRuntime {
  executable: string;
  /** Full local-only executable proof; never serialized into task or capability DTOs. */
  executableIdentity: CodexRuntimeExecutableIdentity;
  models: AgentRuntimeResolvedModel[];
}

export interface ResolveAgentRuntimeOptions {
  /** Bypass a previously successful catalog cache before accepting new work. */
  fresh?: boolean;
}

/** `null` means unavailable; a thrown probe means availability is unknown. */
export type ResolveAgentRuntime = (
  adapterId: BuiltinAgentRuntimeId,
  options?: Readonly<ResolveAgentRuntimeOptions>,
) => MaybePromise<AgentRuntimeResolvedRuntime | null>;

export type RunCodexAgentRuntimeTask = (
  input: RunCodexAgentTaskInput,
) => Promise<CodexAgentTaskResult>;

/**
 * Structural lease surface supplied by the process-wide workspace coordinator.
 * `false` means exact ownership could not be proven at release time, so callers
 * must keep the workspace fail-closed rather than assuming it became free.
 */
export interface AgentRuntimeWorkspaceLease {
  release(): MaybePromise<boolean>;
  /**
   * Optional host-owned identity check bound when this lease was acquired.
   * It runs again immediately before durable acceptance and adapter spawn.
   */
  revalidate?(): MaybePromise<boolean>;
}

export type AcquireAgentRuntimeWorkspaceLease = (
  target: Readonly<AgentRuntimeResolvedTarget>,
) => MaybePromise<AgentRuntimeWorkspaceLease | null>;

/** Structural journal surface used by the service and deterministic tests. */
export interface AgentRuntimeServiceJournal {
  createOrGetTask(input: CreateAgentRuntimeTaskInput): {
    duplicate: boolean;
    task: AgentTaskStartResponse['task'];
  };
  appendEvent(taskId: string, draft: AgentTaskEventDraft): AgentTaskEvent;
  setProviderIds(
    taskId: string,
    ids: { threadId?: string; turnId?: string },
  ): AgentTaskExecutionRecord;
  getTask(taskId: string): AgentTaskStartResponse['task'] | null;
  getTaskExecution(taskId: string): AgentTaskExecutionRecord | null;
  getTaskByRequestId(requestId: string): AgentTaskStartResponse['task'] | null;
  assertStartRequestNotRetired(request: AgentTaskStartRequest): void;
  listTasks(limit?: number): AgentTaskStartResponse['task'][];
  readEvents(taskId: string, after: number, limit?: number): AgentTaskEvent[];
  recordCancellationIntent(taskId: string, requestId: string): { duplicate: boolean };
  reconcileInterruptedTasks(): number;
  pruneTerminalTasks(keep?: number): number;
}

export interface AgentRuntimeServiceDependencies {
  journal: AgentRuntimeServiceJournal | AgentRuntimeTaskJournal;
  resolveTarget: ResolveAgentRuntimeTarget;
  resolveRuntime: ResolveAgentRuntime;
  /** `null` is a proven busy workspace; a thrown error leaves its status unknown. */
  acquireWorkspaceLease: AcquireAgentRuntimeWorkspaceLease;
  /**
   * Host containment gate. It defaults to the production fail-closed flag.
   * Deterministic harnesses may opt in while exercising fake contained trees.
   */
  managedExecutionEnabled?: boolean;
  /**
   * Explicit full-access gate. Production defaults to the fail-closed protocol
   * constant; a source-development host may opt in without changing the
   * shipped policy constant.
   */
  dangerousModeEnabled?: boolean;
  runCodex?: RunCodexAgentRuntimeTask;
  /** Bounded HTTP cancellation wait; the durable state changes only on runner settlement. */
  cancelWaitMs?: number;
  /** Bounds registered-target and executable probes so the serialized start lane cannot wedge. */
  resolutionTimeoutMs?: number;
  /** A successful shutdown means every runner settled and every terminal event became durable. */
  shutdownWaitMs?: number;
}

interface ActiveTask {
  readonly taskId: string;
  readonly targetId: string;
  /** Internal canonical working directory; never serialized to clients. */
  readonly cwd: string;
  readonly workspaceLease: AgentRuntimeWorkspaceLease;
  readonly controller: AbortController;
  cancelRequested: boolean;
  runnerSettled: boolean;
  /** A provider/guard group may still be writing; never release its lease. */
  processOwnershipUncertain: boolean;
  leaseRelease: Promise<boolean> | null;
  leaseReleased: boolean;
  pendingTerminal: AgentTaskEventDraft | null;
  completion: Promise<void>;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string'
    && isAbsolute(value)
    && !/[\u0000\r\n]/.test(value);
}

function validWorkspaceLease(value: unknown): value is AgentRuntimeWorkspaceLease {
  return typeof value === 'object'
    && value !== null
    && typeof (value as AgentRuntimeWorkspaceLease).release === 'function';
}

function canonicalWorkingDirectoryContains(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ''
    || (!isAbsolute(pathFromParent)
      && pathFromParent !== '..'
      && !pathFromParent.startsWith(`..${sep}`));
}

function canonicalWorkingDirectoriesOverlap(left: string, right: string): boolean {
  return canonicalWorkingDirectoryContains(left, right)
    || canonicalWorkingDirectoryContains(right, left);
}

function validateResolvedTarget(
  value: unknown,
  requestedTargetId: string,
): AgentRuntimeResolvedTarget {
  if (!exactObject(value, ['targetId', 'projectLabel', 'cwd'])) {
    throw new AgentRuntimeHttpError(
      'AGENT_RUNTIME_TARGET_UNAVAILABLE',
      '등록된 작업 대상을 확인하지 못했습니다.',
      404,
    );
  }
  if (value.targetId !== requestedTargetId
    || typeof value.projectLabel !== 'string'
    || !value.projectLabel.trim()
    || value.projectLabel.length > 120
    || /[\u0000-\u001f\u007f]/.test(value.projectLabel)
    || !absolutePath(value.cwd)) {
    throw new AgentRuntimeHttpError(
      'AGENT_RUNTIME_TARGET_UNAVAILABLE',
      '등록된 작업 대상을 확인하지 못했습니다.',
      404,
    );
  }
  return {
    targetId: value.targetId,
    projectLabel: value.projectLabel,
    cwd: value.cwd,
  };
}

function validateExecutable(value: unknown): value is string {
  return absolutePath(value);
}

function runtimeModelIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

function providerModelIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function providerReasoningEffort(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 64
    && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
}

function validCodexExecutableIdentity(
  value: unknown,
): value is CodexRuntimeExecutableIdentity {
  // Production never advertises the Windows runtime before Job Object
  // containment exists. Keeping the pure validator here preserves portable
  // service tests without weakening the POSIX launcher's host-policy check.
  return process.platform === 'win32'
    ? isCodexRuntimeExecutableIdentity(value)
    : isCodexRuntimeExecutableIdentityForPlatform(value, process.platform);
}

function validateResolvedRuntime(value: unknown): AgentRuntimeResolvedRuntime {
  if (!exactObject(value, [
    'executable', 'executableIdentity', 'models',
  ])
    || !validateExecutable(value.executable)
    || !validCodexExecutableIdentity(value.executableIdentity)
    || value.executableIdentity.path !== value.executable
    || !Array.isArray(value.models)
    || value.models.length < 1
    || value.models.length > AGENT_RUNTIME_MAX_MODELS_PER_ADAPTER) {
    throw new Error('AGENT_RUNTIME_RESOLUTION_INVALID');
  }
  const models = value.models.map(candidate => {
    if (!exactObject(candidate, [
      'modelId', 'providerModel', 'reasoningEffort', 'label', 'isDefault',
    ])
      || !runtimeModelIdentifier(candidate.modelId)
      || !providerModelIdentifier(candidate.providerModel)
      || !providerReasoningEffort(candidate.reasoningEffort)
      || typeof candidate.label !== 'string'
      || !candidate.label.trim()
      || candidate.label.length > 120
      || /[\u0000-\u001f\u007f]/.test(candidate.label)
      || typeof candidate.isDefault !== 'boolean') {
      throw new Error('AGENT_RUNTIME_RESOLUTION_INVALID');
    }
    return {
      modelId: candidate.modelId,
      providerModel: candidate.providerModel,
      reasoningEffort: candidate.reasoningEffort,
      label: candidate.label,
      isDefault: candidate.isDefault,
    };
  });
  if (new Set(models.map(model => model.modelId)).size !== models.length
    || models.filter(model => model.isDefault).length !== 1) {
    throw new Error('AGENT_RUNTIME_RESOLUTION_INVALID');
  }
  return {
    executable: value.executable,
    executableIdentity: value.executableIdentity,
    models,
  };
}

function isTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function waitBounded(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function operationWithin<T>(
  operation: () => MaybePromise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = Promise.resolve().then(operation);
  try {
    return await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function terminalFailure(cause: unknown): Extract<AgentTaskEventDraft, { type: 'task.failed' }> {
  const nested = cause instanceof CodexAgentRuntimeError ? cause.cause : undefined;
  const journalError = cause instanceof AgentRuntimeTaskJournalError
    ? cause
    : nested instanceof AgentRuntimeTaskJournalError
      ? nested
      : null;
  if (journalError?.code === 'AGENT_RUNTIME_EVENT_LIMIT') {
    return {
      type: 'task.failed',
      payload: {
        code: 'EVENT_LIMIT_REACHED',
        message: '진행 이벤트 한도에 도달해 작업을 안전하게 종료했습니다.',
        retryable: true,
      },
    };
  }
  if (cause instanceof CodexAgentRuntimeError) {
    return { type: 'task.failed', payload: codexAgentTaskFailure(cause) };
  }
  return {
    type: 'task.failed',
    payload: {
      code: 'AGENT_RUNTIME_EXECUTION_FAILED',
      message: '에이전트 작업을 완료하지 못했습니다.',
      retryable: true,
    },
  };
}

function safeStartRequest(value: AgentTaskStartRequest): AgentTaskStartRequest {
  try {
    return normalizeAgentTaskStartRequest(value);
  } catch {
    throw new AgentRuntimeHttpError(
      'INVALID_REQUEST',
      '에이전트 런타임 요청이 올바르지 않습니다.',
      400,
    );
  }
}

function safeCancelRequest(value: AgentTaskCancelRequest): AgentTaskCancelRequest {
  try {
    return normalizeAgentTaskCancelRequest(value);
  } catch {
    throw new AgentRuntimeHttpError(
      'INVALID_REQUEST',
      '에이전트 런타임 요청이 올바르지 않습니다.',
      400,
    );
  }
}

function taskNotFound(): AgentRuntimeHttpError {
  return new AgentRuntimeHttpError(
    'AGENT_RUNTIME_TASK_NOT_FOUND',
    '에이전트 작업을 찾지 못했습니다.',
    404,
  );
}

function translateJournalError(error: unknown): never {
  if (error instanceof AgentRuntimeTaskJournalError) {
    if (error.code === 'AGENT_RUNTIME_TASK_NOT_FOUND') throw taskNotFound();
    if (error.code === 'AGENT_RUNTIME_REQUEST_CONFLICT') {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_REQUEST_CONFLICT',
        '같은 요청 ID가 다른 작업에 이미 사용되었습니다.',
        409,
      );
    }
    if (error.code === 'AGENT_RUNTIME_REQUEST_RETIRED') {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_REQUEST_RETIRED',
        '이 요청 ID의 작업 이력은 보존 기간이 지나 정리되었습니다. 다시 실행하려면 새 요청을 만들어 주세요.',
        409,
      );
    }
    if (error.code === 'AGENT_RUNTIME_CANCEL_REQUEST_CONFLICT') {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_CANCEL_REQUEST_CONFLICT',
        '같은 취소 요청 ID가 다른 작업에 이미 사용되었습니다.',
        409,
      );
    }
  }
  throw error;
}

function taskResponse(
  duplicate: boolean,
  task: AgentTaskStartResponse['task'],
): AgentTaskStartResponse {
  return { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, duplicate, task };
}

/**
 * Durable orchestration boundary for semantic agent tasks. Local paths and
 * executable details remain inside this service and never enter HTTP DTOs.
 */
export class AgentRuntimeService implements AgentRuntimeHttpService {
  readonly #journal: AgentRuntimeServiceJournal;
  readonly #resolveTarget: ResolveAgentRuntimeTarget;
  readonly #resolveRuntime: ResolveAgentRuntime;
  readonly #acquireWorkspaceLease: AcquireAgentRuntimeWorkspaceLease;
  readonly #managedExecutionEnabled: boolean;
  readonly #dangerousModeEnabled: boolean;
  readonly #runCodex: RunCodexAgentRuntimeTask;
  readonly #cancelWaitMs: number;
  readonly #resolutionTimeoutMs: number;
  readonly #shutdownWaitMs: number;
  readonly #active = new Map<string, ActiveTask>();
  readonly #detachedLeases = new Set<AgentRuntimeWorkspaceLease>();
  readonly #pendingLeaseCleanups = new Set<Promise<void>>();
  #leaseStateUncertain = false;
  #startTail: Promise<void> = Promise.resolve();
  #pendingStarts = 0;
  #degraded = false;
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor(dependencies: AgentRuntimeServiceDependencies) {
    this.#journal = dependencies.journal;
    this.#resolveTarget = dependencies.resolveTarget;
    this.#resolveRuntime = dependencies.resolveRuntime;
    this.#acquireWorkspaceLease = dependencies.acquireWorkspaceLease;
    this.#managedExecutionEnabled = dependencies.managedExecutionEnabled
      ?? AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED;
    this.#dangerousModeEnabled = dependencies.dangerousModeEnabled
      ?? AGENT_RUNTIME_DANGEROUS_MODE_ENABLED;
    this.#runCodex = dependencies.runCodex ?? runCodexAgentTask;
    this.#cancelWaitMs = Math.max(
      1,
      Math.min(MAX_CANCEL_WAIT_MS, dependencies.cancelWaitMs ?? DEFAULT_CANCEL_WAIT_MS),
    );
    this.#resolutionTimeoutMs = Math.max(
      1,
      Math.min(MAX_RESOLUTION_TIMEOUT_MS, dependencies.resolutionTimeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS),
    );
    this.#shutdownWaitMs = Math.max(
      1,
      Math.min(MAX_SHUTDOWN_WAIT_MS, dependencies.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS),
    );

    // Recovery is an explicit supervisor responsibility. Opening SQLite alone
    // must never make an interrupted execution appear live after restart.
    this.#journal.reconcileInterruptedTasks();
    this.#journal.pruneTerminalTasks();
  }

  async capabilities(): Promise<AgentRuntimeCapabilitiesResponse> {
    let codexAvailability: AgentRuntimeAdapterCapability['availability'];
    let codexModels: AgentRuntimeModelCapability[] = [];
    if (!this.#managedExecutionEnabled) {
      codexAvailability = 'unavailable';
    } else try {
      const resolved = await operationWithin(
        () => this.#resolveRuntime('codex'),
        this.#resolutionTimeoutMs,
        () => new Error('runtime capability probe timed out'),
      );
      codexAvailability = this.#degraded
        ? 'unknown'
        : resolved === null
        ? 'unavailable'
        : 'available';
      if (codexAvailability === 'available' && resolved) {
        codexModels = validateResolvedRuntime(resolved).models.map(({
          providerModel: _providerModel,
          reasoningEffort: _reasoningEffort,
          ...model
        }) => model);
      }
    } catch {
      codexAvailability = 'unknown';
      codexModels = [];
    }
    const adapters = BUILTIN_AGENT_RUNTIME_REGISTRY.list().map((adapter): AgentRuntimeAdapterCapability => {
      const codex = adapter.id === 'codex';
      return {
        adapterId: adapter.id as BuiltinAgentRuntimeId,
        label: adapter.label,
        availability: codex ? codexAvailability : 'unavailable',
        models: codex ? codexModels : [],
        features: {
          structuredProgress: codex,
          questions: false,
          approvals: false,
          cancellation: codex,
        },
      };
    });
    return {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      adapters,
      limits: {
        maxPromptBytes: AGENT_RUNTIME_MAX_PROMPT_BYTES,
        maxConcurrentTasks: AGENT_RUNTIME_MAX_CONCURRENT_TASKS,
      },
    };
  }

  listTasks(): AgentTaskListResponse {
    return {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      tasks: this.#journal.listTasks(AGENT_RUNTIME_TASK_LIST_LIMIT),
    };
  }

  readEvents(taskId: string, after: number): AgentTaskEventsResponse {
    if (!TASK_ID_RE.test(taskId)
      || !Number.isSafeInteger(after)
      || after < 0) {
      throw new AgentRuntimeHttpError(
        'INVALID_CURSOR',
        '작업 이벤트 cursor가 올바르지 않습니다.',
        400,
      );
    }
    let task: AgentTaskStartResponse['task'] | null;
    try {
      task = this.#journal.getTask(taskId);
    } catch (error) {
      return translateJournalError(error);
    }
    if (!task) throw taskNotFound();
    if (after > task.lastSeq) {
      throw new AgentRuntimeHttpError(
        'INVALID_CURSOR',
        '작업 이벤트 cursor가 현재 작업보다 앞서 있습니다.',
        400,
      );
    }
    let events: AgentTaskEvent[];
    try {
      events = this.#journal.readEvents(taskId, after, AGENT_RUNTIME_EVENT_READ_LIMIT);
    } catch (error) {
      return translateJournalError(error);
    }
    return {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId,
      after,
      nextCursor: events.at(-1)?.seq ?? after,
      events,
    };
  }

  async startTask(requestInput: AgentTaskStartRequest): Promise<AgentTaskStartResponse> {
    const request = safeStartRequest(requestInput);
    if (this.#pendingStarts >= AGENT_RUNTIME_MAX_PENDING_STARTS) {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_START_QUEUE_FULL',
        '에이전트 작업 시작 요청이 많습니다. 잠시 후 다시 시도해 주세요.',
        429,
      );
    }
    this.#pendingStarts += 1;
    try {
      return await this.#serializeStart(async () => {
        await this.#recoverPendingTerminals();
        const duplicate = this.#existingIntent(request);
        if (duplicate) return taskResponse(true, duplicate);
        if (!this.#dangerousModeEnabled
          && request.executionMode === 'dangerously-bypass-approvals-and-sandbox') {
          throw new AgentRuntimeHttpError(
            'AGENT_RUNTIME_DANGEROUS_MODE_UNAVAILABLE',
            '전체 접근 런타임은 분리된 백그라운드 프로세스까지 안전하게 종료할 수 있는 OS 격리가 마련된 뒤 사용할 수 있습니다. 기본 작업공간 모드를 사용해 주세요.',
            409,
          );
        }
        if (!this.#managedExecutionEnabled) {
          throw new AgentRuntimeHttpError(
            'AGENT_RUNTIME_CONTAINMENT_UNAVAILABLE',
            '분리된 백그라운드 프로세스까지 작업공간 쓰기 권한을 회수하는 OS 강제 격리가 아직 없어 새 에이전트 작업을 시작하지 않습니다.',
            409,
          );
        }
        if (this.#shuttingDown) {
          throw new AgentRuntimeHttpError(
            'AGENT_RUNTIME_SHUTTING_DOWN',
            '에이전트 런타임이 종료 중입니다.',
            503,
          );
        }
        if (this.#degraded) {
          throw new AgentRuntimeHttpError(
            'AGENT_RUNTIME_DEGRADED',
            '이전 작업의 종료 상태를 안전하게 기록하지 못해 새 작업을 시작하지 않습니다.',
            503,
          );
        }
        if (request.adapterId !== 'codex') {
          throw new AgentRuntimeHttpError(
            'AGENT_RUNTIME_ADAPTER_UNAVAILABLE',
            '선택한 에이전트 런타임은 아직 사용할 수 없습니다.',
            409,
          );
        }
        if (this.#active.size >= AGENT_RUNTIME_MAX_CONCURRENT_TASKS) {
          throw new AgentRuntimeHttpError(
            'AGENT_RUNTIME_CAPACITY',
            '동시에 실행할 수 있는 에이전트 작업 수를 초과했습니다.',
            429,
          );
        }
        if ([...this.#active.values()].some(active => active.targetId === request.targetId)) {
          throw new AgentRuntimeHttpError(
            'AGENT_RUNTIME_TARGET_BUSY',
            '이 프로젝트에서는 이미 에이전트 작업이 실행 중입니다.',
            409,
          );
        }

        let target: AgentRuntimeResolvedTarget;
        try {
          target = validateResolvedTarget(await operationWithin(
            () => this.#resolveTarget(request.targetId),
            this.#resolutionTimeoutMs,
            () => new AgentRuntimeHttpError(
              'AGENT_RUNTIME_TARGET_STATUS_TIMEOUT',
              '등록 프로젝트 상태 확인 시간이 초과되었습니다.',
              503,
            ),
          ), request.targetId);
        } catch (error) {
          if (error instanceof AgentRuntimeHttpError) throw error;
          throw new AgentRuntimeHttpError(
            'AGENT_RUNTIME_TARGET_STATUS_UNKNOWN',
            '등록된 작업 대상을 확인하지 못했습니다.',
            503,
          );
        }
        if (this.#shuttingDown) {
          throw new AgentRuntimeHttpError(
            'AGENT_RUNTIME_SHUTTING_DOWN',
            '에이전트 런타임이 종료 중입니다.',
            503,
          );
        }
        // Different persisted rows can resolve to the same canonical directory,
        // or to an ancestor/descendant within one file tree. Compare the
        // resolver-owned canonical cwd values with the host platform's path
        // semantics so two writers never enter overlapping workspace trees.
        if ([...this.#active.values()].some(active => (
          canonicalWorkingDirectoriesOverlap(active.cwd, target.cwd)
        ))) {
          throw new AgentRuntimeHttpError(
            'AGENT_RUNTIME_TARGET_BUSY',
            '이 프로젝트에서는 이미 에이전트 작업이 실행 중입니다.',
            409,
          );
        }

        const workspaceLease = await this.#acquireLease(target);
        let leaseTransferred = false;
        try {
          if (this.#shuttingDown) {
            throw new AgentRuntimeHttpError(
              'AGENT_RUNTIME_SHUTTING_DOWN',
              '에이전트 런타임이 종료 중입니다.',
              503,
            );
          }

          let runtime: AgentRuntimeResolvedRuntime | null;
          try {
            const resolved = await operationWithin(
              () => this.#resolveRuntime('codex', { fresh: true }),
              this.#resolutionTimeoutMs,
              () => new AgentRuntimeHttpError(
                'AGENT_RUNTIME_EXECUTABLE_TIMEOUT',
                'Codex 실행 파일 상태 확인 시간이 초과되었습니다.',
                503,
              ),
            );
            runtime = resolved === null ? null : validateResolvedRuntime(resolved);
          } catch (error) {
            if (error instanceof AgentRuntimeHttpError) throw error;
            throw new AgentRuntimeHttpError(
              'AGENT_RUNTIME_EXECUTABLE_UNKNOWN',
              'Codex 실행 파일 상태를 확인하지 못했습니다.',
              503,
            );
          }
          if (!runtime) {
            throw new AgentRuntimeHttpError(
              'AGENT_RUNTIME_EXECUTABLE_UNAVAILABLE',
              'Codex 실행 파일을 사용할 수 없습니다.',
              503,
            );
          }
          const selectedModel = runtime.models.find(model => model.modelId === request.modelId);
          if (!selectedModel) {
            throw new AgentRuntimeHttpError(
              'AGENT_RUNTIME_MODEL_UNAVAILABLE',
              '선택한 Codex 모델은 현재 사용할 수 없습니다. 모델 목록을 새로 확인해 주세요.',
              409,
            );
          }
          await this.#revalidateLeaseTarget(workspaceLease);
          if (this.#shuttingDown) {
            throw new AgentRuntimeHttpError(
              'AGENT_RUNTIME_SHUTTING_DOWN',
              '에이전트 런타임이 종료 중입니다.',
              503,
            );
          }

          let created: ReturnType<AgentRuntimeServiceJournal['createOrGetTask']>;
          try {
            created = this.#journal.createOrGetTask({
              ...request,
              projectLabel: target.projectLabel,
            });
          } catch (error) {
            return translateJournalError(error);
          }
          if (created.duplicate) return taskResponse(true, created.task);

          const execution = this.#journal.getTaskExecution(created.task.taskId);
          if (!execution) {
            throw new AgentRuntimeHttpError(
              'AGENT_RUNTIME_INTERNAL',
              '에이전트 작업을 준비하지 못했습니다.',
              500,
            );
          }
          const active: ActiveTask = {
            taskId: execution.taskId,
            targetId: execution.targetId,
            cwd: target.cwd,
            workspaceLease,
            controller: new AbortController(),
            cancelRequested: false,
            runnerSettled: false,
            processOwnershipUncertain: false,
            leaseRelease: null,
            leaseReleased: false,
            pendingTerminal: null,
            completion: Promise.resolve(),
          };
          this.#active.set(active.taskId, active);
          leaseTransferred = true;
          active.completion = this.#execute(
            active,
            execution,
            target,
            runtime.executable,
            runtime.executableIdentity,
            selectedModel.providerModel,
            selectedModel.reasoningEffort,
          )
            .catch(() => {
              this.#degraded = true;
            })
            .finally(async () => {
              await this.#finishActiveTask(active);
            });
          return taskResponse(false, created.task);
        } finally {
          if (!leaseTransferred) await this.#releasePreStartLease(workspaceLease);
        }
      });
    } finally {
      this.#pendingStarts -= 1;
    }
  }

  async cancelTask(
    taskId: string,
    requestInput: AgentTaskCancelRequest,
  ): Promise<AgentTaskCancelResponse> {
    const request = safeCancelRequest(requestInput);
    if (!TASK_ID_RE.test(taskId)) throw taskNotFound();
    let task: AgentTaskStartResponse['task'] | null;
    try {
      task = this.#journal.getTask(taskId);
    } catch (error) {
      return translateJournalError(error);
    }
    if (!task) throw taskNotFound();
    try {
      this.#journal.recordCancellationIntent(taskId, request.requestId);
    } catch (error) {
      return translateJournalError(error);
    }
    await this.#recoverPendingTerminals();
    task = this.#journal.getTask(taskId);
    if (!task) throw taskNotFound();
    if (isTerminal(task.status)) {
      return { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, task };
    }
    const active = this.#active.get(taskId);
    if (!active) {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_TASK_NOT_ACTIVE',
        '작업 실행 상태를 확인할 수 없어 취소하지 않았습니다.',
        409,
      );
    }
    if (active.runnerSettled) {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_DEGRADED',
        '작업 실행은 끝났지만 종료 상태를 안전하게 기록하지 못했습니다.',
        503,
      );
    }
    active.cancelRequested = true;
    active.controller.abort();
    await waitBounded(active.completion, this.#cancelWaitMs);
    const current = this.#journal.getTask(taskId);
    if (!current) throw taskNotFound();
    return { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, task: current };
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    // Abort work we already own before waiting for a serialized target/runtime
    // probe. Otherwise one wedged start can consume the entire native sidecar
    // grace while an unrelated provider keeps writing to its workspace.
    for (const task of this.#active.values()) {
      if (!task.runnerSettled) {
        task.cancelRequested = true;
        task.controller.abort();
      }
    }
    this.#shutdownPromise = (async () => {
      // Wait for an in-flight resolver/probe to observe #shuttingDown before
      // taking the final active snapshot. Recheck defensively in case a start
      // crossed its last synchronous shutdown check before this call.
      await this.#startTail;
      const active = [...this.#active.values()];
      for (const task of active) {
        if (!task.runnerSettled) {
          task.cancelRequested = true;
          task.controller.abort();
        }
      }
      const settled = await Promise.all(
        active.map(task => waitBounded(task.completion, this.#shutdownWaitMs)),
      );
      const leaseCleanupsSettled = await Promise.all(
        [...this.#pendingLeaseCleanups]
          .map(cleanup => waitBounded(cleanup, this.#shutdownWaitMs)),
      );
      await this.#recoverPendingTerminals();
      if (settled.some(value => !value)
        || leaseCleanupsSettled.some(value => !value)
        || this.#active.size > 0
        || this.#detachedLeases.size > 0
        || this.#pendingLeaseCleanups.size > 0
        || this.#leaseStateUncertain) {
        throw new Error('AGENT_RUNTIME_SHUTDOWN_INCOMPLETE');
      }
    })();
    return this.#shutdownPromise;
  }

  /** Last-resort process-exit hook. AbortSignal reaches the adapter synchronously. */
  forceAbortNow(): void {
    this.#shuttingDown = true;
    for (const task of this.#active.values()) {
      task.cancelRequested = true;
      task.controller.abort();
    }
  }

  #existingIntent(request: AgentTaskStartRequest): AgentTaskStartResponse['task'] | null {
    let summary: AgentTaskStartResponse['task'] | null;
    try {
      this.#journal.assertStartRequestNotRetired(request);
      summary = this.#journal.getTaskByRequestId(request.requestId);
    } catch (error) {
      return translateJournalError(error);
    }
    if (!summary) return null;
    const execution = this.#journal.getTaskExecution(summary.taskId);
    if (!execution) {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_INTERNAL',
        '기존 에이전트 작업을 확인하지 못했습니다.',
        500,
      );
    }
    if (execution.targetId !== request.targetId
      || execution.adapterId !== request.adapterId
      || execution.modelId !== request.modelId
      || execution.executionMode !== request.executionMode
      || execution.prompt !== request.prompt) {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_REQUEST_CONFLICT',
        '같은 요청 ID가 다른 작업에 이미 사용되었습니다.',
        409,
      );
    }
    return summary;
  }

  #serializeStart<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#startTail;
    let release!: () => void;
    this.#startTail = new Promise<void>(resolve => { release = resolve; });
    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  }

  async #acquireLease(
    target: AgentRuntimeResolvedTarget,
  ): Promise<AgentRuntimeWorkspaceLease> {
    const acquisition = Promise.resolve().then(() => this.#acquireWorkspaceLease(target));
    const timeoutError = new Error('workspace lease acquisition timed out');
    let lease: AgentRuntimeWorkspaceLease | null;
    try {
      lease = await operationWithin(
        () => acquisition,
        this.#resolutionTimeoutMs,
        () => timeoutError,
      );
    } catch (error) {
      if (error === timeoutError) this.#trackLateLeaseAcquisition(acquisition);
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_TARGET_STATUS_UNKNOWN',
        '프로젝트 작업 잠금 상태를 확인하지 못했습니다.',
        503,
      );
    }
    if (lease === null) {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_TARGET_BUSY',
        '이 프로젝트에서는 이미 다른 작업이 실행 중입니다.',
        409,
      );
    }
    if (!validWorkspaceLease(lease)) {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_TARGET_STATUS_UNKNOWN',
        '프로젝트 작업 잠금 상태를 확인하지 못했습니다.',
        503,
      );
    }
    return lease;
  }

  async #revalidateLeaseTarget(lease: AgentRuntimeWorkspaceLease): Promise<void> {
    if (typeof lease.revalidate !== 'function') return;
    let current: boolean;
    try {
      current = await operationWithin(
        () => lease.revalidate!(),
        this.#resolutionTimeoutMs,
        () => new Error('workspace lease target revalidation timed out'),
      );
    } catch {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_TARGET_STATUS_UNKNOWN',
        '프로젝트 작업 대상이 잠금 이후에도 같은 상태인지 확인하지 못했습니다.',
        503,
      );
    }
    if (current !== true) {
      throw new AgentRuntimeHttpError(
        'AGENT_RUNTIME_TARGET_STATUS_UNKNOWN',
        '프로젝트 작업 대상이 실행 전에 변경되어 작업을 시작하지 않습니다.',
        503,
      );
    }
  }

  #trackLateLeaseAcquisition(
    acquisition: Promise<AgentRuntimeWorkspaceLease | null>,
  ): void {
    this.#degraded = true;
    let cleanup!: Promise<void>;
    cleanup = (async () => {
      try {
        const lease = await acquisition;
        if (lease === null) return;
        if (!validWorkspaceLease(lease)) {
          this.#leaseStateUncertain = true;
          return;
        }
        // Register ownership before awaiting release so shutdown and every
        // competing start remain fail-closed throughout asynchronous cleanup.
        this.#detachedLeases.add(lease);
        if (await this.#releaseLease(lease)) this.#detachedLeases.delete(lease);
      } catch {
        // A rejected acquisition did not return ownership to this service.
        // The timed-out request still failed, but no lease exists to release.
      } finally {
        this.#pendingLeaseCleanups.delete(cleanup);
        await this.#recoverPendingTerminals();
      }
    })();
    this.#pendingLeaseCleanups.add(cleanup);
  }

  async #releaseLease(lease: AgentRuntimeWorkspaceLease): Promise<boolean> {
    try {
      return await operationWithin(
        () => lease.release(),
        this.#resolutionTimeoutMs,
        () => new Error('workspace lease release timed out'),
      ) === true;
    } catch {
      return false;
    }
  }

  async #releasePreStartLease(lease: AgentRuntimeWorkspaceLease): Promise<void> {
    if (await this.#releaseLease(lease)) return;
    // Retain the lease object and reject successful shutdown. An uncertain
    // release must never be treated as proof that another writer may enter.
    this.#detachedLeases.add(lease);
    this.#degraded = true;
    throw new AgentRuntimeHttpError(
      'AGENT_RUNTIME_TARGET_STATUS_UNKNOWN',
      '프로젝트 작업 잠금을 안전하게 해제하지 못했습니다.',
      503,
    );
  }

  async #execute(
    active: ActiveTask,
    execution: AgentTaskExecutionRecord,
    target: AgentRuntimeResolvedTarget,
    executable: string,
    executableIdentity: CodexRuntimeExecutableIdentity,
    providerModel: string,
    reasoningEffort: string,
  ): Promise<void> {
    // Force an asynchronous boundary so the accepted row and active ownership
    // are both observable before an adapter can run or be cancelled.
    await Promise.resolve();
    let terminal: AgentTaskEventDraft;
    try {
      // The executable catalog probe and accepted-task publication both create
      // time windows after lease acquisition. Rebind the current filesystem
      // and Git identity at the last await before the provider can spawn.
      await this.#revalidateLeaseTarget(active.workspaceLease);
      if (active.cancelRequested) {
        terminal = {
          type: 'task.cancelled',
          payload: { reason: '사용자가 에이전트 작업을 취소했습니다.' },
        };
      } else {
        this.#journal.appendEvent(active.taskId, {
          type: 'task.started',
          payload: { adapterId: execution.adapterId },
        });

        const result = await this.#runCodex({
          taskId: active.taskId,
          codexExecutable: executable,
          codexExecutableIdentity: executableIdentity,
          cwd: target.cwd,
          model: providerModel,
          reasoningEffort,
          executionMode: execution.executionMode,
          prompt: execution.prompt,
          signal: active.controller.signal,
          bindProviderIds: ids => {
            // Bind as soon as Codex creates each native identifier. A later
            // failure, timeout, cancellation, or sidecar restart must remain
            // traceable without exposing these provider IDs publicly.
            this.#journal.setProviderIds(active.taskId, ids);
          },
          emit: async draft => {
            // Once cancellation owns the outcome, discard late provider output.
            if (active.cancelRequested) return;
            if (draft.type !== 'task.progress' && draft.type !== 'task.artifact.summary') {
              throw new Error('AGENT_RUNTIME_ADAPTER_TERMINAL_EVENT_FORBIDDEN');
            }
            const current = this.#journal.getTask(active.taskId);
            if (!current || isTerminal(current.status)) return;
            this.#journal.appendEvent(active.taskId, draft);
          },
        });

        if (active.cancelRequested) {
          terminal = {
            type: 'task.cancelled',
            payload: { reason: '사용자가 에이전트 작업을 취소했습니다.' },
          };
        } else {
          // Provider IDs become durable before success. The runner promise has
          // already confirmed its complete process tree is gone at this point.
          this.#journal.setProviderIds(active.taskId, {
            threadId: result.threadId,
            turnId: result.turnId,
          });
          terminal = {
            type: 'task.result',
            payload: { summary: result.finalSummary },
          };
        }
      }
    } catch (error) {
      if (error instanceof CodexAgentRuntimeError
        && error.code === 'CODEX_PROCESS_TERMINATION_UNCONFIRMED') {
        active.processOwnershipUncertain = true;
      }
      if (active.cancelRequested) {
        terminal = {
          type: 'task.cancelled',
          payload: { reason: '사용자가 에이전트 작업을 취소했습니다.' },
        };
      } else {
        terminal = terminalFailure(error);
      }
    }
    active.runnerSettled = true;
    active.pendingTerminal = terminal;
    this.#persistPendingTerminal(active);
  }

  #persistPendingTerminal(active: ActiveTask): void {
    const pending = active.pendingTerminal;
    if (!pending) return;
    const current = this.#journal.getTask(active.taskId);
    if (!current) throw new Error('AGENT_RUNTIME_ACTIVE_TASK_MISSING');
    if (!isTerminal(current.status)) this.#journal.appendEvent(active.taskId, pending);
    active.pendingTerminal = null;
  }

  async #finishActiveTask(active: ActiveTask): Promise<void> {
    active.runnerSettled = true;
    try {
      const current = this.#journal.getTask(active.taskId);
      if (!current || !isTerminal(current.status) || active.pendingTerminal) {
        this.#degraded = true;
        return;
      }
      if (active.processOwnershipUncertain) {
        // A terminal event describes the request outcome, not proof that its
        // writer disappeared. Keep the exact workspace lease and active owner
        // until sidecar exit closes the guard pipe. Only replacement bootstrap
        // may recover it after the durable PGID registry proves ESRCH.
        this.#degraded = true;
        return;
      }
      active.leaseRelease ??= this.#releaseLease(active.workspaceLease);
      active.leaseReleased = await active.leaseRelease;
      if (!active.leaseReleased) {
        this.#degraded = true;
        return;
      }
      if (this.#active.get(active.taskId) === active) this.#active.delete(active.taskId);
      try {
        this.#journal.pruneTerminalTasks();
      } catch {
        // Terminal truth is durable, but a failed retention pass can indicate
        // storage corruption or exhaustion. Stop accepting more writes.
        this.#degraded = true;
      }
    } catch {
      this.#degraded = true;
    }
  }

  async #recoverPendingTerminals(): Promise<void> {
    for (const active of [...this.#active.values()]) {
      if (!active.runnerSettled) continue;
      try {
        if (active.pendingTerminal) this.#persistPendingTerminal(active);
        await this.#finishActiveTask(active);
      } catch {
        this.#degraded = true;
      }
    }
    const unresolvedTerminal = [...this.#active.values()]
      .some(active => active.runnerSettled);
    let retentionHealthy = true;
    try {
      this.#journal.pruneTerminalTasks();
    } catch {
      retentionHealthy = false;
    }
    this.#degraded = unresolvedTerminal
      || this.#detachedLeases.size > 0
      || this.#pendingLeaseCleanups.size > 0
      || this.#leaseStateUncertain
      || !retentionHealthy;
  }
}

export function createAgentRuntimeService(
  dependencies: AgentRuntimeServiceDependencies,
): AgentRuntimeService {
  return new AgentRuntimeService(dependencies);
}
