import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  AGENT_RUNTIME_REMOTE_FORBIDDEN_KEYS,
  normalizeAgentRuntimeModelId,
  normalizeAgentTaskEvent,
  type AgentTaskEvent,
  type AgentTaskExecutionMode,
  type AgentTaskStatus,
} from './agentRuntimeProtocol';
import {
  normalizeAgentTaskSummary,
  type AgentTaskSummary,
} from './agentRuntimeApiContract';
import {
  isBuiltinAgentRuntimeId,
  type BuiltinAgentRuntimeId,
} from './agentRuntimeRegistry';

/**
 * Additive remote-task transport. `agentstoz-local-v7` stays frozen and a v7
 * session must never gain this protocol merely because the host was upgraded.
 */
export const REMOTE_CONTROL_TASK_TRANSPORT_VERSION = 'agentstoz-local-v8' as const;
export const REMOTE_CONTROL_TASK_SEMANTIC_VERSION = AGENT_RUNTIME_PROTOCOL_VERSION;

/**
 * Independent opt-in authorization scope for semantic tasks. Pairing/session
 * code must persist an explicit grant; existing process-control scopes, v7
 * sessions, desktop settings, and local dangerous-mode choices do not imply it.
 */
export const REMOTE_CONTROL_TASK_SCOPE = 'tasks-v1' as const;
export type RemoteControlTaskScope = typeof REMOTE_CONTROL_TASK_SCOPE;
/** LAN v1 is plaintext HTTP/WebSocket; task prompts require relay E2EE. */
export const REMOTE_CONTROL_TASK_LAN_ALLOWED = false as const;

export const REMOTE_CONTROL_TASK_MAX_PROMPT_BYTES = 4_096;
/** Leaves headroom below the relay's 11,000-byte plaintext ceiling. */
export const REMOTE_CONTROL_TASK_MAX_SERIALIZED_BYTES = 9_000;
export const REMOTE_CONTROL_TASK_MODEL_PAGE_LIMIT = 16;
export const REMOTE_CONTROL_TASK_LIST_PAGE_LIMIT = 16;
export const REMOTE_CONTROL_TASK_EVENT_PAGE_LIMIT = 16;

export const REMOTE_CONTROL_TASK_OPERATIONS = [
  'capabilities',
  'models.list',
  'tasks.start',
  'tasks.cancel',
  'tasks.list',
  'tasks.events',
] as const;

export type RemoteControlTaskOperation = typeof REMOTE_CONTROL_TASK_OPERATIONS[number];
export type RemoteControlTaskCursor = string | null;

export interface RemoteControlTaskRequestPayloadByOperation {
  capabilities: Record<string, never>;
  'models.list': {
    adapterId: BuiltinAgentRuntimeId;
    /** Null only for the first page; later pages pin the host-issued catalog. */
    catalogId: string | null;
    cursor: RemoteControlTaskCursor;
  };
  'tasks.start': {
    /** Random, session-scoped project handle. Never a stable target id. */
    controlId: string;
    adapterId: BuiltinAgentRuntimeId;
    modelId: string;
    /** Runtime idempotency key. It remains stable when a transport retry occurs. */
    requestId: string;
    prompt: string;
  };
  'tasks.cancel': {
    taskId: string;
    /** Runtime idempotency key, independent from the transport operationId. */
    requestId: string;
  };
  'tasks.list': {
    cursor: RemoteControlTaskCursor;
  };
  'tasks.events': {
    taskId: string;
    after: number;
  };
}

interface RemoteControlTaskRequestBase<TOperation extends RemoteControlTaskOperation> {
  type: 'tasks.request';
  protocolVersion: typeof REMOTE_CONTROL_TASK_TRANSPORT_VERSION;
  taskProtocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  /** E2EE session bearer. It is consumed by the host and never echoed. */
  sessionToken: string;
  /** Stable across delivery retries and echoed by the matching response. */
  operationId: string;
  operation: TOperation;
  payload: RemoteControlTaskRequestPayloadByOperation[TOperation];
}

export type RemoteControlTaskRequest = {
  [TOperation in RemoteControlTaskOperation]: RemoteControlTaskRequestBase<TOperation>
}[RemoteControlTaskOperation];

export type RemoteControlTaskAvailability = 'available' | 'unavailable' | 'unknown';

export interface RemoteControlTaskAdapterCapability {
  adapterId: BuiltinAgentRuntimeId;
  label: string;
  availability: RemoteControlTaskAvailability;
  features: {
    structuredProgress: boolean;
    /** V8 MVP is observation/start/cancel only. */
    questions: false;
    /** V8 MVP cannot resolve provider approval prompts. */
    approvals: false;
    cancellation: boolean;
  };
}

export interface RemoteControlTaskModel {
  modelId: string;
  label: string;
  isDefault: boolean;
}

/**
 * Phone-visible task projection. Stable local target identity and local-only
 * execution policy are absent; the current session's controlId is the only
 * project handle.
 */
export interface RemoteControlTaskSummary {
  taskId: string;
  controlId: string;
  projectLabel: string;
  adapterId: BuiltinAgentRuntimeId;
  modelId: string | null;
  status: AgentTaskStatus;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

interface RemoteControlTaskEventBase<TType extends AgentTaskEvent['type'], TPayload> {
  taskId: string;
  seq: number;
  occurredAt: string;
  type: TType;
  payload: TPayload;
}

/**
 * Remote-safe semantic events. Question and approval events are intentionally
 * absent until their response operations, expiry, and replay rules exist.
 */
export type RemoteControlTaskEvent =
  | RemoteControlTaskEventBase<'task.accepted', {
      adapterId: BuiltinAgentRuntimeId;
      projectLabel: string;
      modelId: string | null;
    }>
  | RemoteControlTaskEventBase<'task.started', {
      adapterId: BuiltinAgentRuntimeId;
    }>
  | RemoteControlTaskEventBase<'task.progress', {
      summary: string;
      phase: string | null;
    }>
  | RemoteControlTaskEventBase<'task.artifact.summary', {
      kind: 'diff' | 'test' | 'commit' | 'memory' | 'other';
      label: string;
      summary: string;
    }>
  | RemoteControlTaskEventBase<'task.result', {
      summary: string;
    }>
  | RemoteControlTaskEventBase<'task.failed', {
      code: string;
      message: string;
      retryable: boolean;
    }>
  | RemoteControlTaskEventBase<'task.cancelled', {
      reason: string;
    }>;

export interface RemoteControlTaskCapabilitiesResult {
  adapters: RemoteControlTaskAdapterCapability[];
  limits: {
    maxPromptBytes: number;
    maxConcurrentTasks: number;
  };
}

export interface RemoteControlTaskModelsResult {
  adapterId: BuiltinAgentRuntimeId;
  /** Identifies the bounded catalog snapshot used by later cursor pages. */
  catalogId: string;
  cursor: RemoteControlTaskCursor;
  nextCursor: RemoteControlTaskCursor;
  models: RemoteControlTaskModel[];
}

export interface RemoteControlTaskStartResult {
  duplicate: boolean;
  task: RemoteControlTaskSummary;
}

export interface RemoteControlTaskCancelResult {
  task: RemoteControlTaskSummary;
}

export interface RemoteControlTaskListResult {
  cursor: RemoteControlTaskCursor;
  nextCursor: RemoteControlTaskCursor;
  tasks: RemoteControlTaskSummary[];
}

export interface RemoteControlTaskEventsResult {
  taskId: string;
  after: number;
  nextCursor: number;
  events: RemoteControlTaskEvent[];
}

export interface RemoteControlTaskResultByOperation {
  capabilities: RemoteControlTaskCapabilitiesResult;
  'models.list': RemoteControlTaskModelsResult;
  'tasks.start': RemoteControlTaskStartResult;
  'tasks.cancel': RemoteControlTaskCancelResult;
  'tasks.list': RemoteControlTaskListResult;
  'tasks.events': RemoteControlTaskEventsResult;
}

interface RemoteControlTaskResultBase {
  type: 'tasks.result';
  protocolVersion: typeof REMOTE_CONTROL_TASK_TRANSPORT_VERSION;
  taskProtocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  /** The sole request correlation value returned; sessionToken is never echoed. */
  operationId: string;
}

export type RemoteControlTaskSuccess = {
  [TOperation in RemoteControlTaskOperation]: RemoteControlTaskResultBase & {
    ok: true;
    result: RemoteControlTaskResultByOperation[TOperation];
  }
}[RemoteControlTaskOperation];

export interface RemoteControlTaskPublicError {
  code: string;
  message: string;
  retryable: boolean;
}

export type RemoteControlTaskFailure = RemoteControlTaskResultBase & {
  ok: false;
  error: RemoteControlTaskPublicError;
};

export type RemoteControlTaskResult = RemoteControlTaskSuccess | RemoteControlTaskFailure;
export type RemoteControlTaskMessage = RemoteControlTaskRequest | RemoteControlTaskResult;

export class RemoteControlTaskProtocolError extends Error {
  constructor(
    readonly code = 'REMOTE_CONTROL_TASK_PROTOCOL_INVALID',
    message = '원격 에이전트 작업 메시지가 올바르지 않습니다.',
  ) {
    super(message);
    this.name = 'RemoteControlTaskProtocolError';
  }
}

type JsonObject = Record<string, unknown>;

const textEncoder = new TextEncoder();
const REQUEST_KEYS = [
  'type', 'protocolVersion', 'taskProtocolVersion', 'sessionToken', 'operationId', 'operation', 'payload',
] as const;
const RESULT_SUCCESS_KEYS = [
  'type', 'protocolVersion', 'taskProtocolVersion', 'operationId', 'ok', 'result',
] as const;
const RESULT_FAILURE_KEYS = [
  'type', 'protocolVersion', 'taskProtocolVersion', 'operationId', 'ok', 'error',
] as const;
const BASE64URL_256_RE = /^[A-Za-z0-9_-]{43}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const OPAQUE_CURSOR_RE = /^[A-Za-z0-9_-]{8,256}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,79}$/;
const DANGEROUS_EXECUTION_MODE = 'dangerously-bypass-approvals-and-sandbox';
const TASK_STATUSES = new Set<AgentTaskStatus>([
  'accepted', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'unknown',
]);
const OPERATIONS = new Set<RemoteControlTaskOperation>(REMOTE_CONTROL_TASK_OPERATIONS);
const REMOTE_ONLY_FORBIDDEN_KEYS = [
  'targetId', 'executionMode', 'dangerous', 'dangerouslyBypassApprovalsAndSandbox',
  'stack', 'cause', 'request', 'requestEcho',
  'capability', 'capabilityHeader', 'managementCapability', 'agentRuntimeCapability',
  'xAgentsToZAgentRuntimeCapability',
] as const;
const FORBIDDEN_NORMALIZED_KEYS = new Set(
  [...AGENT_RUNTIME_REMOTE_FORBIDDEN_KEYS, ...REMOTE_ONLY_FORBIDDEN_KEYS]
    .map(key => key.replace(/[-_]/g, '').toLowerCase()),
);

function invalid(message?: string): never {
  throw new RemoteControlTaskProtocolError('REMOTE_CONTROL_TASK_PROTOCOL_INVALID', message);
}

function tooLarge(): never {
  throw new RemoteControlTaskProtocolError(
    'REMOTE_CONTROL_TASK_MESSAGE_TOO_LARGE',
    `원격 에이전트 작업 메시지는 ${REMOTE_CONTROL_TASK_MAX_SERIALIZED_BYTES}바이트를 넘을 수 없습니다.`,
  );
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return value as JsonObject;
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function exactOperation(value: unknown): RemoteControlTaskOperation {
  if (typeof value !== 'string' || !OPERATIONS.has(value as RemoteControlTaskOperation)) return invalid();
  return value as RemoteControlTaskOperation;
}

function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) return invalid();
  return value;
}

function sessionToken(value: unknown): string {
  if (typeof value !== 'string' || !BASE64URL_256_RE.test(value)) return invalid();
  return value;
}

function controlId(value: unknown): string {
  if (typeof value !== 'string' || !BASE64URL_256_RE.test(value)) return invalid();
  return value;
}

function cursor(value: unknown): RemoteControlTaskCursor {
  if (value === null) return null;
  if (typeof value !== 'string' || !OPAQUE_CURSOR_RE.test(value)) return invalid();
  return value;
}

function modelId(value: unknown): string {
  if (value === DANGEROUS_EXECUTION_MODE) return invalid();
  try {
    return normalizeAgentRuntimeModelId(value);
  } catch {
    return invalid();
  }
}

function adapterId(value: unknown): BuiltinAgentRuntimeId {
  if (!isBuiltinAgentRuntimeId(value)) return invalid();
  return value;
}

function safeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid();
  return value;
}

function boundedText(value: unknown, maxBytes: number, singleLine = false): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) return invalid();
  if (singleLine && /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) return invalid();
  if (textEncoder.encode(value).byteLength > maxBytes) return invalid();
  return value;
}

function canonicalIsoDate(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalid();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return invalid();
  return value;
}

function visitRemoteSafe(value: unknown, allowRootSessionToken: boolean): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (!candidate || typeof candidate !== 'object') return;
    if (seen.has(candidate as object)) return invalid();
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      candidate.forEach(child => visit(child, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(candidate as JsonObject)) {
      const allowedBearer = allowRootSessionToken && depth === 0 && key === 'sessionToken';
      if (!allowedBearer
        && FORBIDDEN_NORMALIZED_KEYS.has(key.replace(/[-_]/g, '').toLowerCase())) return invalid();
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

/** Reject local execution/authentication details in payloads and responses. */
export function assertRemoteControlTaskSafe(value: unknown): void {
  visitRemoteSafe(value, false);
}

export function remoteControlTaskUtf8ByteLength(value: string): number {
  if (typeof value !== 'string') return invalid();
  return textEncoder.encode(value).byteLength;
}

/** Guard an already serialized request/result before encryption or transport. */
export function assertRemoteControlTaskSerializedSize(serialized: string): void {
  if (typeof serialized !== 'string') return invalid();
  if (remoteControlTaskUtf8ByteLength(serialized) > REMOTE_CONTROL_TASK_MAX_SERIALIZED_BYTES) tooLarge();
}

function assertValueSize(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalid();
  }
  if (typeof serialized !== 'string') return invalid();
  assertRemoteControlTaskSerializedSize(serialized);
}

function assertRequestBoundary(value: unknown): void {
  assertValueSize(value);
  visitRemoteSafe(value, true);
}

function assertResultBoundary(value: unknown): void {
  assertValueSize(value);
  assertRemoteControlTaskSafe(value);
}

function normalizeModel(value: unknown): RemoteControlTaskModel {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['modelId', 'label', 'isDefault']) || typeof raw.isDefault !== 'boolean') return invalid();
  return {
    modelId: modelId(raw.modelId),
    label: boundedText(raw.label, 240, true),
    isDefault: raw.isDefault,
  };
}

function normalizeRequestPayload<TOperation extends RemoteControlTaskOperation>(
  operation: TOperation,
  value: unknown,
): RemoteControlTaskRequestPayloadByOperation[TOperation] {
  const raw = asObject(value);
  switch (operation) {
    case 'capabilities':
      if (!hasExactKeys(raw, [])) return invalid();
      return {} as RemoteControlTaskRequestPayloadByOperation[TOperation];
    case 'models.list': {
      if (!hasExactKeys(raw, ['adapterId', 'catalogId', 'cursor'])) return invalid();
      const catalogId = raw.catalogId === null ? null : opaqueId(raw.catalogId);
      const normalizedCursor = cursor(raw.cursor);
      if ((catalogId === null) !== (normalizedCursor === null)) return invalid();
      return {
        adapterId: adapterId(raw.adapterId), catalogId, cursor: normalizedCursor,
      } as RemoteControlTaskRequestPayloadByOperation[TOperation];
    }
    case 'tasks.start':
      if (!hasExactKeys(raw, ['controlId', 'adapterId', 'modelId', 'requestId', 'prompt'])) return invalid();
      return {
        controlId: controlId(raw.controlId),
        adapterId: adapterId(raw.adapterId),
        modelId: modelId(raw.modelId),
        requestId: opaqueId(raw.requestId),
        prompt: boundedText(raw.prompt, REMOTE_CONTROL_TASK_MAX_PROMPT_BYTES),
      } as RemoteControlTaskRequestPayloadByOperation[TOperation];
    case 'tasks.cancel':
      if (!hasExactKeys(raw, ['taskId', 'requestId'])) return invalid();
      return {
        taskId: opaqueId(raw.taskId), requestId: opaqueId(raw.requestId),
      } as RemoteControlTaskRequestPayloadByOperation[TOperation];
    case 'tasks.list':
      if (!hasExactKeys(raw, ['cursor'])) return invalid();
      return { cursor: cursor(raw.cursor) } as RemoteControlTaskRequestPayloadByOperation[TOperation];
    case 'tasks.events':
      if (!hasExactKeys(raw, ['taskId', 'after'])) return invalid();
      return {
        taskId: opaqueId(raw.taskId), after: safeInteger(raw.after),
      } as RemoteControlTaskRequestPayloadByOperation[TOperation];
  }
}

export function normalizeRemoteControlTaskRequest(value: unknown): RemoteControlTaskRequest {
  assertRequestBoundary(value);
  const raw = asObject(value);
  if (!hasExactKeys(raw, REQUEST_KEYS)
    || raw.type !== 'tasks.request'
    || raw.protocolVersion !== REMOTE_CONTROL_TASK_TRANSPORT_VERSION
    || raw.taskProtocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION) return invalid();
  const operation = exactOperation(raw.operation);
  return {
    type: 'tasks.request',
    protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
    taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    sessionToken: sessionToken(raw.sessionToken),
    operationId: opaqueId(raw.operationId),
    operation,
    payload: normalizeRequestPayload(operation, raw.payload),
  } as RemoteControlTaskRequest;
}

export function normalizeRemoteControlTaskSummary(value: unknown): RemoteControlTaskSummary {
  assertValueSize(value);
  assertRemoteControlTaskSafe(value);
  const raw = asObject(value);
  if (!hasExactKeys(raw, [
    'taskId', 'controlId', 'projectLabel', 'adapterId', 'modelId', 'status',
    'lastSeq', 'createdAt', 'updatedAt',
  ])) return invalid();
  if (typeof raw.status !== 'string' || !TASK_STATUSES.has(raw.status as AgentTaskStatus)) return invalid();
  return {
    taskId: opaqueId(raw.taskId),
    controlId: controlId(raw.controlId),
    projectLabel: boundedText(raw.projectLabel, 360, true),
    adapterId: adapterId(raw.adapterId),
    modelId: raw.modelId === null ? null : modelId(raw.modelId),
    status: raw.status as AgentTaskStatus,
    lastSeq: safeInteger(raw.lastSeq),
    createdAt: canonicalIsoDate(raw.createdAt),
    updatedAt: canonicalIsoDate(raw.updatedAt),
  };
}

function normalizeAdapterCapability(value: unknown): RemoteControlTaskAdapterCapability {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['adapterId', 'label', 'availability', 'features'])
    || !['available', 'unavailable', 'unknown'].includes(String(raw.availability))) return invalid();
  const features = asObject(raw.features);
  if (!hasExactKeys(features, ['structuredProgress', 'questions', 'approvals', 'cancellation'])
    || typeof features.structuredProgress !== 'boolean'
    || features.questions !== false
    || features.approvals !== false
    || typeof features.cancellation !== 'boolean') return invalid();
  return {
    adapterId: adapterId(raw.adapterId),
    label: boundedText(raw.label, 120, true),
    availability: raw.availability as RemoteControlTaskAvailability,
    features: {
      structuredProgress: features.structuredProgress,
      questions: false,
      approvals: false,
      cancellation: features.cancellation,
    },
  };
}

export function normalizeRemoteControlTaskEvent(value: unknown): RemoteControlTaskEvent {
  assertValueSize(value);
  assertRemoteControlTaskSafe(value);
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['taskId', 'seq', 'occurredAt', 'type', 'payload'])) return invalid();
  const taskId = opaqueId(raw.taskId);
  const seq = safeInteger(raw.seq);
  if (seq < 1) return invalid();
  const occurredAt = canonicalIsoDate(raw.occurredAt);
  const payload = asObject(raw.payload);
  switch (raw.type) {
    case 'task.accepted':
      if (!hasExactKeys(payload, ['adapterId', 'projectLabel', 'modelId'])) return invalid();
      return {
        taskId, seq, occurredAt, type: raw.type,
        payload: {
          adapterId: adapterId(payload.adapterId),
          projectLabel: boundedText(payload.projectLabel, 360, true),
          modelId: payload.modelId === null ? null : modelId(payload.modelId),
        },
      };
    case 'task.started':
      if (!hasExactKeys(payload, ['adapterId'])) return invalid();
      return { taskId, seq, occurredAt, type: raw.type, payload: { adapterId: adapterId(payload.adapterId) } };
    case 'task.progress': {
      if (!hasExactKeys(payload, ['summary', 'phase'])) return invalid();
      const phase = payload.phase === null ? null : boundedText(payload.phase, 240, true);
      return {
        taskId, seq, occurredAt, type: raw.type,
        payload: { summary: boundedText(payload.summary, 4_096), phase },
      };
    }
    case 'task.artifact.summary': {
      const kinds = ['diff', 'test', 'commit', 'memory', 'other'] as const;
      if (!hasExactKeys(payload, ['kind', 'label', 'summary'])
        || typeof payload.kind !== 'string'
        || !kinds.includes(payload.kind as typeof kinds[number])) return invalid();
      return {
        taskId, seq, occurredAt, type: raw.type,
        payload: {
          kind: payload.kind as typeof kinds[number],
          label: boundedText(payload.label, 480, true),
          summary: boundedText(payload.summary, 4_096),
        },
      };
    }
    case 'task.result':
      if (!hasExactKeys(payload, ['summary'])) return invalid();
      return { taskId, seq, occurredAt, type: raw.type, payload: { summary: boundedText(payload.summary, 6_000) } };
    case 'task.failed':
      if (!hasExactKeys(payload, ['code', 'message', 'retryable'])
        || typeof payload.code !== 'string' || !ERROR_CODE_RE.test(payload.code)
        || typeof payload.retryable !== 'boolean') return invalid();
      return {
        taskId, seq, occurredAt, type: raw.type,
        payload: {
          code: payload.code,
          message: boundedText(payload.message, 3_000),
          retryable: payload.retryable,
        },
      };
    case 'task.cancelled':
      if (!hasExactKeys(payload, ['reason'])) return invalid();
      return { taskId, seq, occurredAt, type: raw.type, payload: { reason: boundedText(payload.reason, 1_500) } };
    default:
      // task.question and both approval events are deliberately unsupported in V8 MVP.
      return invalid();
  }
}

function normalizeCapabilitiesResult(value: unknown): RemoteControlTaskCapabilitiesResult {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['adapters', 'limits'])
    || !Array.isArray(raw.adapters) || raw.adapters.length > 4) return invalid();
  const adapters = raw.adapters.map(normalizeAdapterCapability);
  if (new Set(adapters.map(adapter => adapter.adapterId)).size !== adapters.length) return invalid();
  const limits = asObject(raw.limits);
  if (!hasExactKeys(limits, ['maxPromptBytes', 'maxConcurrentTasks'])) return invalid();
  const maxPromptBytes = safeInteger(limits.maxPromptBytes, REMOTE_CONTROL_TASK_MAX_PROMPT_BYTES);
  const maxConcurrentTasks = safeInteger(limits.maxConcurrentTasks, 64);
  if (maxPromptBytes < 1 || maxConcurrentTasks < 1) return invalid();
  return { adapters, limits: { maxPromptBytes, maxConcurrentTasks } };
}

function normalizeModelsResult(value: unknown): RemoteControlTaskModelsResult {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['adapterId', 'catalogId', 'cursor', 'nextCursor', 'models'])
    || !Array.isArray(raw.models) || raw.models.length > REMOTE_CONTROL_TASK_MODEL_PAGE_LIMIT) return invalid();
  const normalizedCursor = cursor(raw.cursor);
  const nextCursor = cursor(raw.nextCursor);
  if (nextCursor !== null && nextCursor === normalizedCursor) return invalid();
  const models = raw.models.map(normalizeModel);
  if (new Set(models.map(model => model.modelId)).size !== models.length
    || (models.length > 0 && models.filter(model => model.isDefault).length > 1)) return invalid();
  return {
    adapterId: adapterId(raw.adapterId),
    catalogId: opaqueId(raw.catalogId),
    cursor: normalizedCursor,
    nextCursor,
    models,
  };
}

function normalizeStartResult(value: unknown): RemoteControlTaskStartResult {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['duplicate', 'task']) || typeof raw.duplicate !== 'boolean') return invalid();
  return { duplicate: raw.duplicate, task: normalizeRemoteControlTaskSummary(raw.task) };
}

function normalizeCancelResult(value: unknown): RemoteControlTaskCancelResult {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['task'])) return invalid();
  return { task: normalizeRemoteControlTaskSummary(raw.task) };
}

function normalizeListResult(value: unknown): RemoteControlTaskListResult {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['cursor', 'nextCursor', 'tasks'])
    || !Array.isArray(raw.tasks) || raw.tasks.length > REMOTE_CONTROL_TASK_LIST_PAGE_LIMIT) return invalid();
  const normalizedCursor = cursor(raw.cursor);
  const nextCursor = cursor(raw.nextCursor);
  if (nextCursor !== null && nextCursor === normalizedCursor) return invalid();
  const tasks = raw.tasks.map(normalizeRemoteControlTaskSummary);
  if (new Set(tasks.map(task => task.taskId)).size !== tasks.length) return invalid();
  return { cursor: normalizedCursor, nextCursor, tasks };
}

function normalizeEventsResult(value: unknown): RemoteControlTaskEventsResult {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['taskId', 'after', 'nextCursor', 'events'])
    || !Array.isArray(raw.events) || raw.events.length > REMOTE_CONTROL_TASK_EVENT_PAGE_LIMIT) return invalid();
  const taskId = opaqueId(raw.taskId);
  const after = safeInteger(raw.after);
  const nextCursor = safeInteger(raw.nextCursor);
  const events = raw.events.map(normalizeRemoteControlTaskEvent);
  if (nextCursor < after
    || events.some(event => event.taskId !== taskId || event.seq <= after || event.seq > nextCursor)
    || events.some((event, index) => index > 0 && event.seq !== events[index - 1]!.seq + 1)
    || (events.length === 0 && nextCursor !== after)
    || (events.length > 0 && events[events.length - 1]!.seq !== nextCursor)) return invalid();
  return { taskId, after, nextCursor, events };
}

type NormalizedSuccessPayload = {
  operation: RemoteControlTaskOperation;
  result: RemoteControlTaskResultByOperation[RemoteControlTaskOperation];
};

function normalizeSuccessPayload(value: unknown): NormalizedSuccessPayload {
  const raw = asObject(value);
  if (hasExactKeys(raw, ['adapters', 'limits'])) {
    return { operation: 'capabilities', result: normalizeCapabilitiesResult(raw) };
  }
  if (hasExactKeys(raw, ['adapterId', 'catalogId', 'cursor', 'nextCursor', 'models'])) {
    return { operation: 'models.list', result: normalizeModelsResult(raw) };
  }
  if (hasExactKeys(raw, ['duplicate', 'task'])) {
    return { operation: 'tasks.start', result: normalizeStartResult(raw) };
  }
  if (hasExactKeys(raw, ['task'])) {
    return { operation: 'tasks.cancel', result: normalizeCancelResult(raw) };
  }
  if (hasExactKeys(raw, ['cursor', 'nextCursor', 'tasks'])) {
    return { operation: 'tasks.list', result: normalizeListResult(raw) };
  }
  if (hasExactKeys(raw, ['taskId', 'after', 'nextCursor', 'events'])) {
    return { operation: 'tasks.events', result: normalizeEventsResult(raw) };
  }
  return invalid();
}

export function normalizeRemoteControlTaskError(value: unknown): RemoteControlTaskPublicError {
  assertValueSize(value);
  assertRemoteControlTaskSafe(value);
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['code', 'message', 'retryable'])
    || typeof raw.code !== 'string' || !ERROR_CODE_RE.test(raw.code)
    || typeof raw.retryable !== 'boolean') return invalid();
  return {
    code: raw.code,
    message: boundedText(raw.message, 3_000),
    retryable: raw.retryable,
  };
}

export function normalizeRemoteControlTaskResult(value: unknown): RemoteControlTaskResult {
  assertResultBoundary(value);
  const raw = asObject(value);
  if (raw.type !== 'tasks.result'
    || raw.protocolVersion !== REMOTE_CONTROL_TASK_TRANSPORT_VERSION
    || raw.taskProtocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION) return invalid();
  const common = {
    type: 'tasks.result' as const,
    protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
    taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    operationId: opaqueId(raw.operationId),
  };
  if (raw.ok === true) {
    if (!hasExactKeys(raw, RESULT_SUCCESS_KEYS)) return invalid();
    const normalized = normalizeSuccessPayload(raw.result);
    return { ...common, ok: true, result: normalized.result } as RemoteControlTaskSuccess;
  }
  if (raw.ok === false) {
    if (!hasExactKeys(raw, RESULT_FAILURE_KEYS)) return invalid();
    return { ...common, ok: false, error: normalizeRemoteControlTaskError(raw.error) };
  }
  return invalid();
}

function successOperation(value: RemoteControlTaskSuccess): RemoteControlTaskOperation {
  return normalizeSuccessPayload(value.result).operation;
}

/** Verify transport correlation before resolving an in-flight operationId. */
export function assertRemoteControlTaskResultMatchesRequest(
  requestValue: unknown,
  resultValue: unknown,
): RemoteControlTaskResult {
  const request = normalizeRemoteControlTaskRequest(requestValue);
  const result = normalizeRemoteControlTaskResult(resultValue);
  if (result.operationId !== request.operationId) return invalid();
  if (!result.ok) return result;
  if (successOperation(result) !== request.operation) return invalid();
  switch (request.operation) {
    case 'capabilities':
      break;
    case 'models.list': {
      const page = result.result as RemoteControlTaskModelsResult;
      if (page.adapterId !== request.payload.adapterId
        || page.cursor !== request.payload.cursor
        || (request.payload.catalogId !== null && page.catalogId !== request.payload.catalogId)) return invalid();
      break;
    }
    case 'tasks.start': {
      const started = result.result as RemoteControlTaskStartResult;
      if (started.task.controlId !== request.payload.controlId
        || started.task.adapterId !== request.payload.adapterId
        || started.task.modelId !== request.payload.modelId) return invalid();
      break;
    }
    case 'tasks.cancel': {
      const cancelled = result.result as RemoteControlTaskCancelResult;
      if (cancelled.task.taskId !== request.payload.taskId) return invalid();
      break;
    }
    case 'tasks.list': {
      const page = result.result as RemoteControlTaskListResult;
      if (page.cursor !== request.payload.cursor) return invalid();
      break;
    }
    case 'tasks.events': {
      const page = result.result as RemoteControlTaskEventsResult;
      if (page.taskId !== request.payload.taskId || page.after !== request.payload.after) return invalid();
      break;
    }
  }
  return result;
}

export function normalizeRemoteControlTaskMessage(value: unknown): RemoteControlTaskMessage {
  const raw = asObject(value);
  if (raw.type === 'tasks.request') return normalizeRemoteControlTaskRequest(raw);
  if (raw.type === 'tasks.result') return normalizeRemoteControlTaskResult(raw);
  return invalid();
}

export function parseRemoteControlTaskJson(serialized: string): RemoteControlTaskMessage {
  assertRemoteControlTaskSerializedSize(serialized);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid('원격 에이전트 작업 JSON이 올바르지 않습니다.');
  }
  return normalizeRemoteControlTaskMessage(parsed);
}

export function serializeRemoteControlTaskMessage(value: unknown): string {
  const normalized = normalizeRemoteControlTaskMessage(value);
  const serialized = JSON.stringify(normalized);
  assertRemoteControlTaskSerializedSize(serialized);
  return serialized;
}

/** Convert a safe local task only after the session registry supplied its controlId. */
export function projectRemoteControlTaskSummary(
  value: AgentTaskSummary,
  sessionControlId: string,
): RemoteControlTaskSummary {
  let local: AgentTaskSummary;
  try {
    local = normalizeAgentTaskSummary(value);
  } catch {
    return invalid();
  }
  if (local.executionMode !== 'workspace-write') {
    throw new RemoteControlTaskProtocolError(
      'REMOTE_CONTROL_TASK_DANGEROUS_MODE_FORBIDDEN',
      '권한 우회로 시작된 로컬 작업은 원격 화면에 투영할 수 없습니다.',
    );
  }
  return normalizeRemoteControlTaskSummary({
    taskId: local.taskId,
    controlId: sessionControlId,
    projectLabel: local.projectLabel,
    adapterId: local.adapterId,
    modelId: local.modelId,
    status: local.status,
    lastSeq: local.lastSeq,
    createdAt: local.createdAt,
    updatedAt: local.updatedAt,
  });
}

/**
 * Strip the safe local executionMode; reject every event belonging to a
 * dangerous task, including later progress/result events that do not carry
 * their own mode. The caller must supply the journal summary it already used
 * for session authorization.
 */
export function projectRemoteControlTaskEvent(
  value: AgentTaskEvent,
  task: AgentTaskSummary,
): RemoteControlTaskEvent {
  let local: AgentTaskEvent;
  let localTask: AgentTaskSummary;
  try {
    local = normalizeAgentTaskEvent(value);
    localTask = normalizeAgentTaskSummary(task);
  } catch {
    return invalid();
  }
  if (local.taskId !== localTask.taskId) return invalid();
  const executionMode: AgentTaskExecutionMode = localTask.executionMode;
  if (executionMode !== 'workspace-write') {
    throw new RemoteControlTaskProtocolError(
      'REMOTE_CONTROL_TASK_DANGEROUS_MODE_FORBIDDEN',
      '권한 우회 작업 이벤트는 원격 화면에 투영할 수 없습니다.',
    );
  }
  if (local.type === 'task.question'
    || local.type === 'task.approval.requested'
    || local.type === 'task.approval.resolved') return invalid();
  if (local.type === 'task.accepted' && local.payload.executionMode !== executionMode) return invalid();
  const payload = local.type === 'task.accepted'
    ? {
        adapterId: local.payload.adapterId,
        projectLabel: local.payload.projectLabel,
        modelId: local.payload.modelId,
      }
    : local.payload;
  return normalizeRemoteControlTaskEvent({
    taskId: local.taskId,
    seq: local.seq,
    occurredAt: local.occurredAt,
    type: local.type,
    payload,
  });
}
