import {
  AGENT_RUNTIME_MAX_PROMPT_BYTES,
  AGENT_RUNTIME_PROTOCOL_VERSION,
  assertAgentRuntimeRemoteSafe,
  normalizeAgentTaskEvent,
  normalizeAgentRuntimeModelId,
  type AgentTaskEvent,
  type AgentTaskExecutionMode,
  type AgentTaskStatus,
} from './agentRuntimeProtocol';
import {
  isBuiltinAgentRuntimeId,
  type BuiltinAgentRuntimeId,
} from './agentRuntimeRegistry';

export const AGENT_RUNTIME_MAX_CONCURRENT_TASKS = 4;
export const AGENT_RUNTIME_TASK_LIST_LIMIT = 100;
export const AGENT_RUNTIME_TARGET_LIST_LIMIT = 1_000;
// 32 maximally escaped, protocol-valid events still fit below the 3 MiB
// desktop proxy/client response ceiling with envelope headroom.
export const AGENT_RUNTIME_EVENT_READ_LIMIT = 32;
export const AGENT_RUNTIME_MAX_MODELS_PER_ADAPTER = 64;

export type AgentRuntimeAvailability = 'available' | 'unavailable' | 'unknown';

export interface AgentRuntimeModelCapability {
  modelId: string;
  label: string;
  isDefault: boolean;
}

export interface AgentRuntimeAdapterCapability {
  adapterId: BuiltinAgentRuntimeId;
  label: string;
  availability: AgentRuntimeAvailability;
  models: AgentRuntimeModelCapability[];
  features: {
    structuredProgress: boolean;
    questions: boolean;
    approvals: boolean;
    cancellation: boolean;
  };
}

export interface AgentRuntimeCapabilitiesResponse {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  adapters: AgentRuntimeAdapterCapability[];
  limits: {
    maxPromptBytes: number;
    maxConcurrentTasks: number;
  };
}

export type AgentRuntimeTargetScope = 'main' | 'worktree';

/**
 * Path-free runnable target projected from the current local registration and
 * Git worktree inventory. `projectTargetId` points back to the stable project
 * row so the UI can open the existing project/worktree manager without ever
 * receiving a local filesystem path.
 */
export interface AgentRuntimeTarget {
  targetId: string;
  projectTargetId: string;
  label: string;
  scope: AgentRuntimeTargetScope;
  branch: string | null;
  locked: boolean;
  /** True only when the current Git inventory proved a repository family. */
  worktreeCapable: boolean;
}

export interface AgentRuntimeTargetsResponse {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  targets: AgentRuntimeTarget[];
  /** False keeps the UI from treating an unreadable Git family as empty. */
  complete: boolean;
}

export interface AgentTaskSummary {
  taskId: string;
  targetId: string;
  projectLabel: string;
  adapterId: BuiltinAgentRuntimeId;
  /** Null is reserved for tasks migrated from the pre-model-selection journal. */
  modelId: string | null;
  executionMode: AgentTaskExecutionMode;
  status: AgentTaskStatus;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskListResponse {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  tasks: AgentTaskSummary[];
}

export interface AgentTaskEventsResponse {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  taskId: string;
  after: number;
  nextCursor: number;
  events: AgentTaskEvent[];
}

export interface AgentTaskStartResponse {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  duplicate: boolean;
  task: AgentTaskSummary;
}

export interface AgentTaskCancelRequest {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  requestId: string;
}

export interface AgentTaskCancelResponse {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  task: AgentTaskSummary;
}

export interface AgentRuntimeErrorResponse {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  ok: false;
  code: string;
  error: string;
}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

function invalid(message = '에이전트 런타임 API 응답이 올바르지 않습니다.'): never {
  throw new Error(message);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function identifier(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 128 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    return invalid();
  }
  return normalized;
}

function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || value.includes('\u0000')) {
    return invalid();
  }
  return value;
}

function isoDate(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    return invalid();
  }
  return value;
}

function safeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    return invalid();
  }
  return value;
}

const TASK_STATUSES: readonly AgentTaskStatus[] = [
  'accepted', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'unknown',
];

export function normalizeAgentTaskSummary(value: unknown): AgentTaskSummary {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, [
    'taskId', 'targetId', 'projectLabel', 'adapterId', 'modelId', 'executionMode',
    'status', 'lastSeq', 'createdAt', 'updatedAt',
  ])) invalid();
  if (!isBuiltinAgentRuntimeId(raw.adapterId)) invalid();
  if (typeof raw.status !== 'string' || !TASK_STATUSES.includes(raw.status as AgentTaskStatus)) invalid();
  const executionMode: AgentTaskExecutionMode = raw.executionMode === 'workspace-write'
    || raw.executionMode === 'dangerously-bypass-approvals-and-sandbox'
    ? raw.executionMode
    : invalid();
  const normalized: AgentTaskSummary = {
    taskId: identifier(raw.taskId),
    targetId: identifier(raw.targetId),
    projectLabel: label(raw.projectLabel),
    adapterId: raw.adapterId,
    modelId: raw.modelId === null ? null : normalizeAgentRuntimeModelId(raw.modelId),
    executionMode,
    status: raw.status as AgentTaskStatus,
    lastSeq: safeInteger(raw.lastSeq),
    createdAt: isoDate(raw.createdAt),
    updatedAt: isoDate(raw.updatedAt),
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentRuntimeCapabilitiesResponse(value: unknown): AgentRuntimeCapabilitiesResponse {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, ['protocolVersion', 'adapters', 'limits'])
    || raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION
    || !Array.isArray(raw.adapters)) invalid();
  const adapters = raw.adapters.map((candidate): AgentRuntimeAdapterCapability => {
    const adapter = asObject(candidate) ?? invalid();
    if (!hasExactKeys(adapter, ['adapterId', 'label', 'availability', 'models', 'features'])
      || !isBuiltinAgentRuntimeId(adapter.adapterId)
      || !['available', 'unavailable', 'unknown'].includes(String(adapter.availability))
      || !Array.isArray(adapter.models)
      || adapter.models.length > AGENT_RUNTIME_MAX_MODELS_PER_ADAPTER) invalid();
    const availability = adapter.availability as AgentRuntimeAvailability;
    const models = adapter.models.map((candidate): AgentRuntimeModelCapability => {
      const model = asObject(candidate) ?? invalid();
      if (!hasExactKeys(model, ['modelId', 'label', 'isDefault'])
        || typeof model.isDefault !== 'boolean') invalid();
      return {
        modelId: normalizeAgentRuntimeModelId(model.modelId),
        label: label(model.label),
        isDefault: model.isDefault,
      };
    });
    if (new Set(models.map(model => model.modelId)).size !== models.length) invalid();
    if (availability === 'available') {
      if (models.length < 1 || models.filter(model => model.isDefault).length !== 1) invalid();
    } else if (models.length !== 0) {
      invalid();
    }
    const features = asObject(adapter.features) ?? invalid();
    if (!hasExactKeys(features, ['structuredProgress', 'questions', 'approvals', 'cancellation'])
      || Object.values(features).some(feature => typeof feature !== 'boolean')) invalid();
    return {
      adapterId: adapter.adapterId,
      label: label(adapter.label),
      availability,
      models,
      features: {
        structuredProgress: features.structuredProgress as boolean,
        questions: features.questions as boolean,
        approvals: features.approvals as boolean,
        cancellation: features.cancellation as boolean,
      },
    };
  });
  if (new Set(adapters.map(adapter => adapter.adapterId)).size !== adapters.length) invalid();
  const limits = asObject(raw.limits) ?? invalid();
  if (!hasExactKeys(limits, ['maxPromptBytes', 'maxConcurrentTasks'])) invalid();
  const normalized: AgentRuntimeCapabilitiesResponse = {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    adapters,
    limits: {
      maxPromptBytes: safeInteger(limits.maxPromptBytes, AGENT_RUNTIME_MAX_PROMPT_BYTES),
      maxConcurrentTasks: safeInteger(limits.maxConcurrentTasks, AGENT_RUNTIME_MAX_CONCURRENT_TASKS),
    },
  };
  if (normalized.limits.maxPromptBytes < 1 || normalized.limits.maxConcurrentTasks < 1) invalid();
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

function branchLabel(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string'
    || !value.trim()
    || value.length > 240
    || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

export function normalizeAgentRuntimeTargetsResponse(value: unknown): AgentRuntimeTargetsResponse {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, ['protocolVersion', 'targets', 'complete'])
    || raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION
    || !Array.isArray(raw.targets)
    || raw.targets.length > AGENT_RUNTIME_TARGET_LIST_LIMIT
    || typeof raw.complete !== 'boolean') invalid();
  const targets = raw.targets.map((candidate): AgentRuntimeTarget => {
    const target = asObject(candidate) ?? invalid();
    if (!hasExactKeys(target, [
      'targetId', 'projectTargetId', 'label', 'scope', 'branch', 'locked', 'worktreeCapable',
    ])
      || (target.scope !== 'main' && target.scope !== 'worktree')
      || typeof target.locked !== 'boolean'
      || typeof target.worktreeCapable !== 'boolean') invalid();
    const normalized: AgentRuntimeTarget = {
      targetId: identifier(target.targetId),
      projectTargetId: identifier(target.projectTargetId),
      label: label(target.label),
      scope: target.scope,
      branch: branchLabel(target.branch),
      locked: target.locked,
      worktreeCapable: target.worktreeCapable,
    };
    if (normalized.scope === 'main' && normalized.projectTargetId !== normalized.targetId) invalid();
    if (normalized.scope === 'worktree' && !normalized.worktreeCapable) invalid();
    return normalized;
  });
  if (new Set(targets.map(target => target.targetId)).size !== targets.length) invalid();
  const normalized: AgentRuntimeTargetsResponse = {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    targets,
    complete: raw.complete,
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentTaskListResponse(value: unknown): AgentTaskListResponse {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, ['protocolVersion', 'tasks'])
    || raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION
    || !Array.isArray(raw.tasks)
    || raw.tasks.length > AGENT_RUNTIME_TASK_LIST_LIMIT) invalid();
  const normalized: AgentTaskListResponse = {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    tasks: raw.tasks.map(normalizeAgentTaskSummary),
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentTaskEventsResponse(value: unknown): AgentTaskEventsResponse {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, ['protocolVersion', 'taskId', 'after', 'nextCursor', 'events'])
    || raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION
    || !Array.isArray(raw.events)
    || raw.events.length > AGENT_RUNTIME_EVENT_READ_LIMIT) invalid();
  const taskId = identifier(raw.taskId);
  const after = safeInteger(raw.after);
  const nextCursor = safeInteger(raw.nextCursor);
  const events = raw.events.map(normalizeAgentTaskEvent);
  if (nextCursor < after
    || events.some(event => event.taskId !== taskId || event.seq <= after || event.seq > nextCursor)
    || events.some((event, index) => index > 0 && event.seq !== events[index - 1]!.seq + 1)
    || (events.length === 0 && nextCursor !== after)
    || (events.length > 0 && events[events.length - 1]!.seq !== nextCursor)) invalid();
  const normalized: AgentTaskEventsResponse = {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    taskId,
    after,
    nextCursor,
    events,
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentTaskStartResponse(value: unknown): AgentTaskStartResponse {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, ['protocolVersion', 'duplicate', 'task'])
    || raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION
    || typeof raw.duplicate !== 'boolean') invalid();
  const normalized: AgentTaskStartResponse = {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    duplicate: raw.duplicate,
    task: normalizeAgentTaskSummary(raw.task),
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentTaskCancelRequest(value: unknown): AgentTaskCancelRequest {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, ['protocolVersion', 'requestId'])
    || raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION) invalid();
  return {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    requestId: identifier(raw.requestId),
  };
}

export function normalizeAgentTaskCancelResponse(value: unknown): AgentTaskCancelResponse {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, ['protocolVersion', 'task'])
    || raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION) invalid();
  const normalized: AgentTaskCancelResponse = {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    task: normalizeAgentTaskSummary(raw.task),
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentRuntimeErrorResponse(value: unknown): AgentRuntimeErrorResponse {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, ['protocolVersion', 'ok', 'code', 'error'])
    || raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION
    || raw.ok !== false
    || typeof raw.code !== 'string'
    || !/^[A-Z][A-Z0-9_]{1,79}$/.test(raw.code)) invalid();
  const normalized: AgentRuntimeErrorResponse = {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    ok: false,
    code: raw.code,
    error: label(raw.error),
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}
