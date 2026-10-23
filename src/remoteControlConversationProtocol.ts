import type { AgentRuntimeAdapterCapability } from './agentRuntimeApiContract';
import {
  normalizeAgentRuntimeConversationEvent,
  normalizeAgentRuntimeConversationSummary,
  AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  type AgentRuntimeConversationEvent,
  type AgentRuntimeConversationState,
  type AgentRuntimeConversationSummary,
} from './agentRuntimeConversationProtocol';
import {
  AGENT_RUNTIME_REMOTE_FORBIDDEN_KEYS,
  normalizeAgentRuntimeModelId,
} from './agentRuntimeProtocol';
import { isBuiltinAgentRuntimeId, type BuiltinAgentRuntimeId } from './agentRuntimeRegistry';
import { REMOTE_CONTROL_TASK_TRANSPORT_VERSION } from './remoteControlTaskProtocol';

/** Separate opt-in authority; tasks-v1 never implies retained conversation access. */
export const REMOTE_CONTROL_CONVERSATION_SCOPE = 'conversations-v1' as const;
export type RemoteControlConversationScope = typeof REMOTE_CONTROL_CONVERSATION_SCOPE;
/**
 * V1 is deliberately a Codex-only execution slice. The wire schema remains
 * adapter-shaped so later providers can be added as versioned capabilities,
 * never by accidentally exposing an unverified local adapter remotely.
 */
export const REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID: BuiltinAgentRuntimeId = 'codex';
export const REMOTE_CONTROL_CONVERSATION_LAN_ALLOWED = false as const;
export const REMOTE_CONTROL_CONVERSATION_MAX_PROMPT_BYTES = 4_096;
export const REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES = 9_000;
export const REMOTE_CONTROL_CONVERSATION_PAGE_LIMIT = 16;
export const REMOTE_CONTROL_CONVERSATION_HISTORY_TEXT_BYTES = 5_500;
export const REMOTE_CONTROL_CONVERSATION_EVENT_SUMMARY_BYTES = 600;

export const REMOTE_CONTROL_CONVERSATION_OPERATIONS = [
  'capabilities',
  'models.list',
  'conversations.list',
  'conversations.start',
  'conversations.continue',
  'conversations.events',
  'conversations.history',
  'conversations.steer',
  'conversations.interrupt',
  'conversations.archive',
  'conversations.unarchive',
] as const;

export type RemoteControlConversationOperation = typeof REMOTE_CONTROL_CONVERSATION_OPERATIONS[number];
export type RemoteControlConversationCursor = string | null;

export interface RemoteControlConversationRequestPayloadByOperation {
  capabilities: Record<string, never>;
  'models.list': { catalogId: string | null; cursor: RemoteControlConversationCursor };
  'conversations.list': { archivedOnly: boolean; cursor: RemoteControlConversationCursor };
  'conversations.start': {
    controlId: string;
    adapterId: BuiltinAgentRuntimeId;
    modelId: string;
    requestId: string;
    historyRetentionConsent: typeof AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT;
    prompt: string;
  };
  'conversations.continue': {
    conversationId: string;
    expectedRevision: number;
    requestId: string;
    prompt: string;
  };
  'conversations.events': { conversationId: string; after: number };
  'conversations.history': {
    conversationId: string;
    expectedRevision: number;
    cursor: RemoteControlConversationCursor;
  };
  'conversations.steer': {
    conversationId: string;
    expectedRevision: number;
    expectedTurnId: string;
    requestId: string;
    prompt: string;
  };
  'conversations.interrupt': {
    conversationId: string;
    expectedRevision: number;
    expectedTurnId: string;
    requestId: string;
  };
  'conversations.archive': {
    conversationId: string;
    expectedRevision: number;
    requestId: string;
  };
  'conversations.unarchive': {
    conversationId: string;
    expectedRevision: number;
    requestId: string;
  };
}

interface RemoteControlConversationRequestBase<TOperation extends RemoteControlConversationOperation> {
  type: 'conversations.request';
  protocolVersion: typeof REMOTE_CONTROL_TASK_TRANSPORT_VERSION;
  conversationProtocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  sessionToken: string;
  operationId: string;
  operation: TOperation;
  payload: RemoteControlConversationRequestPayloadByOperation[TOperation];
}

export type RemoteControlConversationRequest = {
  [TOperation in RemoteControlConversationOperation]: RemoteControlConversationRequestBase<TOperation>
}[RemoteControlConversationOperation];

export interface RemoteControlConversationSummary {
  conversationId: string;
  controlId: string;
  projectLabel: string;
  adapterId: BuiltinAgentRuntimeId;
  modelId: string;
  state: AgentRuntimeConversationState;
  activeTurnId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface RemoteControlConversationEventBase<TType extends AgentRuntimeConversationEvent['type']> {
  conversationId: string;
  seq: number;
  revision: number;
  type: TType;
  turnId: string | null;
  createdAt: string;
}

export type RemoteControlConversationEvent =
  | RemoteControlConversationEventBase<
      | 'conversation.turn.started'
      | 'conversation.turn.completed'
      | 'conversation.turn.interrupted'
      | 'conversation.turn.unknown'
    >
  | (RemoteControlConversationEventBase<'conversation.progress'> & {
      payload: Extract<AgentRuntimeConversationEvent, {
        type: 'conversation.progress';
      }>['payload'];
    })
  | (RemoteControlConversationEventBase<'conversation.artifact.summary'> & {
      payload: Extract<AgentRuntimeConversationEvent, {
        type: 'conversation.artifact.summary';
      }>['payload'];
    });

export interface RemoteControlConversationHistoryMessage {
  messageId: string;
  role: 'user' | 'assistant';
  phase: 'commentary' | 'final_answer' | null;
  text: string;
}

export interface RemoteControlConversationCapability {
  adapterId: BuiltinAgentRuntimeId;
  label: string;
  availability: 'available' | 'unavailable' | 'unknown';
  features: { continue: boolean; steer: boolean; interrupt: boolean; archive: boolean };
}

export interface RemoteControlConversationModel {
  modelId: string;
  label: string;
  isDefault: boolean;
}

export interface RemoteControlConversationResultByOperation {
  capabilities: {
    adapters: RemoteControlConversationCapability[];
    limits: { maxPromptBytes: number };
  };
  'models.list': {
    catalogId: string;
    cursor: RemoteControlConversationCursor;
    nextCursor: RemoteControlConversationCursor;
    models: RemoteControlConversationModel[];
  };
  'conversations.list': {
    archivedOnly: boolean;
    cursor: RemoteControlConversationCursor;
    nextCursor: RemoteControlConversationCursor;
    conversations: RemoteControlConversationSummary[];
  };
  'conversations.start': { duplicate: boolean; conversation: RemoteControlConversationSummary };
  'conversations.continue': { duplicate: boolean; conversation: RemoteControlConversationSummary };
  'conversations.events': {
    conversationId: string;
    after: number;
    nextCursor: number;
    events: RemoteControlConversationEvent[];
  };
  'conversations.history': {
    conversationId: string;
    revision: number;
    cursor: RemoteControlConversationCursor;
    nextCursor: RemoteControlConversationCursor;
    truncated: boolean;
    filtered: true;
    messages: RemoteControlConversationHistoryMessage[];
  };
  'conversations.steer': { conversation: RemoteControlConversationSummary };
  'conversations.interrupt': { conversation: RemoteControlConversationSummary };
  'conversations.archive': { conversation: RemoteControlConversationSummary };
  'conversations.unarchive': { conversation: RemoteControlConversationSummary };
}

interface RemoteControlConversationResultBase {
  type: 'conversations.result';
  protocolVersion: typeof REMOTE_CONTROL_TASK_TRANSPORT_VERSION;
  conversationProtocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  operationId: string;
  operation: RemoteControlConversationOperation;
}

export type RemoteControlConversationSuccess = RemoteControlConversationResultBase & {
  ok: true;
  result: RemoteControlConversationResultByOperation[RemoteControlConversationOperation];
};
export type RemoteControlConversationFailure = RemoteControlConversationResultBase & {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
};
export type RemoteControlConversationResult = RemoteControlConversationSuccess | RemoteControlConversationFailure;
export type RemoteControlConversationMessage = RemoteControlConversationRequest | RemoteControlConversationResult;

export class RemoteControlConversationProtocolError extends Error {
  constructor(
    readonly code = 'REMOTE_CONTROL_CONVERSATION_PROTOCOL_INVALID',
    message = '원격 지속형 대화 메시지가 올바르지 않습니다.',
  ) {
    super(message);
    this.name = 'RemoteControlConversationProtocolError';
  }
}

type JsonObject = Record<string, unknown>;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const CONTROL_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{8,256}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,79}$/;
const OPERATIONS = new Set<RemoteControlConversationOperation>(REMOTE_CONTROL_CONVERSATION_OPERATIONS);
const STATES = new Set<AgentRuntimeConversationState>(['idle', 'running', 'archived', 'unknown']);
const EVENT_TYPES = new Set<AgentRuntimeConversationEvent['type']>([
  'conversation.turn.started',
  'conversation.turn.completed',
  'conversation.turn.interrupted',
  'conversation.turn.unknown',
  'conversation.progress',
  'conversation.artifact.summary',
]);
const ARTIFACT_KINDS = new Set(['diff', 'test', 'commit', 'memory', 'other']);
const FORBIDDEN_KEYS = new Set([
  ...AGENT_RUNTIME_REMOTE_FORBIDDEN_KEYS,
  'targetId', 'providerThreadId', 'providerTurnId', 'executionMode', 'requestEcho',
].map(key => key.replace(/[-_]/g, '').toLowerCase()));
const encoder = new TextEncoder();

function invalid(message?: string): never {
  throw new RemoteControlConversationProtocolError(
    'REMOTE_CONTROL_CONVERSATION_PROTOCOL_INVALID',
    message,
  );
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as JsonObject;
}

function exact(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) return invalid();
  return value;
}

function controlId(value: unknown): string {
  if (typeof value !== 'string' || !CONTROL_ID_RE.test(value)) return invalid();
  return value;
}

function cursor(value: unknown): RemoteControlConversationCursor {
  if (value === null) return null;
  if (typeof value !== 'string' || !CURSOR_RE.test(value)) return invalid();
  return value;
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}

function iso(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return invalid();
  return value;
}

function text(value: unknown, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('\u0000')
    || (!allowEmpty && !value.trim()) || encoder.encode(value).byteLength > maxBytes) return invalid();
  return value;
}

function boundedUtf8Text(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = '…';
  const suffixBytes = encoder.encode(suffix).byteLength;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength + suffixBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let prefix = value.slice(0, low);
  if (prefix.length > 0) {
    const last = prefix.charCodeAt(prefix.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  }
  return `${prefix}${suffix}`;
}

function adapterId(value: unknown): BuiltinAgentRuntimeId {
  if (!isBuiltinAgentRuntimeId(value)) return invalid();
  return value;
}

function visitSafe(value: unknown, allowRootSessionToken: boolean): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number) => {
    if (!candidate || typeof candidate !== 'object') return;
    if (seen.has(candidate as object)) return invalid();
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      candidate.forEach(item => visit(item, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(candidate as JsonObject)) {
      const bearer = allowRootSessionToken && depth === 0 && key === 'sessionToken';
      if (!bearer && FORBIDDEN_KEYS.has(key.replace(/[-_]/g, '').toLowerCase())) return invalid();
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function assertSize(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalid();
  }
  if (encoder.encode(serialized).byteLength > REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES) {
    throw new RemoteControlConversationProtocolError(
      'REMOTE_CONTROL_CONVERSATION_MESSAGE_TOO_LARGE',
      '원격 지속형 대화 메시지가 전송 한도를 초과했습니다.',
    );
  }
}

function operation(value: unknown): RemoteControlConversationOperation {
  if (typeof value !== 'string' || !OPERATIONS.has(value as RemoteControlConversationOperation)) return invalid();
  return value as RemoteControlConversationOperation;
}

function prompt(value: unknown): string {
  return text(value, REMOTE_CONTROL_CONVERSATION_MAX_PROMPT_BYTES);
}

function requestPayload(
  op: RemoteControlConversationOperation,
  value: unknown,
): RemoteControlConversationRequestPayloadByOperation[RemoteControlConversationOperation] {
  const raw = object(value);
  switch (op) {
    case 'capabilities':
      if (!exact(raw, [])) return invalid();
      return {};
    case 'models.list':
      if (!exact(raw, ['catalogId', 'cursor'])) return invalid();
      if ((raw.catalogId === null) !== (raw.cursor === null)) return invalid();
      return { catalogId: raw.catalogId === null ? null : opaqueId(raw.catalogId), cursor: cursor(raw.cursor) };
    case 'conversations.list':
      if (!exact(raw, ['archivedOnly', 'cursor']) || typeof raw.archivedOnly !== 'boolean') return invalid();
      return { archivedOnly: raw.archivedOnly, cursor: cursor(raw.cursor) };
    case 'conversations.start':
      if (!exact(raw, ['controlId', 'adapterId', 'modelId', 'requestId', 'historyRetentionConsent', 'prompt'])
        || raw.historyRetentionConsent !== AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT) return invalid();
      if (raw.adapterId !== REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID) return invalid();
      return {
        controlId: controlId(raw.controlId),
        adapterId: adapterId(raw.adapterId),
        modelId: normalizeAgentRuntimeModelId(raw.modelId),
        requestId: opaqueId(raw.requestId),
        historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
        prompt: prompt(raw.prompt),
      };
    case 'conversations.continue':
      if (!exact(raw, ['conversationId', 'expectedRevision', 'requestId', 'prompt'])) return invalid();
      return {
        conversationId: opaqueId(raw.conversationId),
        expectedRevision: integer(raw.expectedRevision, 1),
        requestId: opaqueId(raw.requestId),
        prompt: prompt(raw.prompt),
      };
    case 'conversations.events':
      if (!exact(raw, ['conversationId', 'after'])) return invalid();
      return { conversationId: opaqueId(raw.conversationId), after: integer(raw.after) };
    case 'conversations.history':
      if (!exact(raw, ['conversationId', 'expectedRevision', 'cursor'])) return invalid();
      return {
        conversationId: opaqueId(raw.conversationId),
        expectedRevision: integer(raw.expectedRevision, 1),
        cursor: cursor(raw.cursor),
      };
    case 'conversations.steer':
      if (!exact(raw, ['conversationId', 'expectedRevision', 'expectedTurnId', 'requestId', 'prompt'])) return invalid();
      return {
        conversationId: opaqueId(raw.conversationId),
        expectedRevision: integer(raw.expectedRevision, 1),
        expectedTurnId: opaqueId(raw.expectedTurnId),
        requestId: opaqueId(raw.requestId),
        prompt: prompt(raw.prompt),
      };
    case 'conversations.interrupt':
      if (!exact(raw, ['conversationId', 'expectedRevision', 'expectedTurnId', 'requestId'])) return invalid();
      return {
        conversationId: opaqueId(raw.conversationId),
        expectedRevision: integer(raw.expectedRevision, 1),
        expectedTurnId: opaqueId(raw.expectedTurnId),
        requestId: opaqueId(raw.requestId),
      };
    case 'conversations.archive':
    case 'conversations.unarchive':
      if (!exact(raw, ['conversationId', 'expectedRevision', 'requestId'])) return invalid();
      return {
        conversationId: opaqueId(raw.conversationId),
        expectedRevision: integer(raw.expectedRevision, 1),
        requestId: opaqueId(raw.requestId),
      };
  }
}

export function normalizeRemoteControlConversationRequest(value: unknown): RemoteControlConversationRequest {
  assertSize(value);
  visitSafe(value, true);
  const raw = object(value);
  if (!exact(raw, [
    'type', 'protocolVersion', 'conversationProtocolVersion', 'sessionToken',
    'operationId', 'operation', 'payload',
  ])
    || raw.type !== 'conversations.request'
    || raw.protocolVersion !== REMOTE_CONTROL_TASK_TRANSPORT_VERSION
    || raw.conversationProtocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || typeof raw.sessionToken !== 'string'
    || !SESSION_TOKEN_RE.test(raw.sessionToken)) return invalid();
  const op = operation(raw.operation);
  return {
    type: 'conversations.request',
    protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
    conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    sessionToken: raw.sessionToken,
    operationId: opaqueId(raw.operationId),
    operation: op,
    payload: requestPayload(op, raw.payload),
  } as RemoteControlConversationRequest;
}

export function normalizeRemoteControlConversationSummary(value: unknown): RemoteControlConversationSummary {
  assertSize(value);
  visitSafe(value, false);
  const raw = object(value);
  if (!exact(raw, [
    'conversationId', 'controlId', 'projectLabel', 'adapterId', 'modelId', 'state',
    'activeTurnId', 'revision', 'createdAt', 'updatedAt',
  ]) || !STATES.has(raw.state as AgentRuntimeConversationState)) return invalid();
  const state = raw.state as AgentRuntimeConversationState;
  const activeTurnId = raw.activeTurnId === null ? null : opaqueId(raw.activeTurnId);
  if ((state === 'running') !== (activeTurnId !== null)) return invalid();
  const createdAt = iso(raw.createdAt);
  const updatedAt = iso(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  return {
    conversationId: opaqueId(raw.conversationId),
    controlId: controlId(raw.controlId),
    projectLabel: text(raw.projectLabel, 360),
    adapterId: adapterId(raw.adapterId),
    modelId: normalizeAgentRuntimeModelId(raw.modelId),
    state,
    activeTurnId,
    revision: integer(raw.revision, 1),
    createdAt,
    updatedAt,
  };
}

export function normalizeRemoteControlConversationEvent(value: unknown): RemoteControlConversationEvent {
  assertSize(value);
  visitSafe(value, false);
  const raw = object(value);
  if (!EVENT_TYPES.has(raw.type as AgentRuntimeConversationEvent['type'])) return invalid();
  const type = raw.type as AgentRuntimeConversationEvent['type'];
  const turnId = raw.turnId === null ? null : opaqueId(raw.turnId);
  if (turnId === null && type !== 'conversation.turn.unknown') return invalid();
  const common = {
    conversationId: opaqueId(raw.conversationId),
    seq: integer(raw.seq, 1),
    revision: integer(raw.revision, 1),
    turnId,
    createdAt: iso(raw.createdAt),
  };
  if (type === 'conversation.progress') {
    if (!exact(raw, ['conversationId', 'seq', 'revision', 'type', 'turnId', 'createdAt', 'payload'])) return invalid();
    const payload = object(raw.payload);
    if (!exact(payload, ['summary', 'phase'])) return invalid();
    return {
      ...common,
      type,
      turnId: opaqueId(turnId),
      payload: {
        summary: text(payload.summary, REMOTE_CONTROL_CONVERSATION_EVENT_SUMMARY_BYTES),
        phase: payload.phase === null ? null : text(payload.phase, 160),
      },
    };
  }
  if (type === 'conversation.artifact.summary') {
    if (!exact(raw, ['conversationId', 'seq', 'revision', 'type', 'turnId', 'createdAt', 'payload'])) return invalid();
    const payload = object(raw.payload);
    if (!exact(payload, ['kind', 'label', 'summary']) || !ARTIFACT_KINDS.has(String(payload.kind))) return invalid();
    return {
      ...common,
      type,
      turnId: opaqueId(turnId),
      payload: {
        kind: payload.kind as Extract<AgentRuntimeConversationEvent, {
          type: 'conversation.artifact.summary';
        }>['payload']['kind'],
        label: text(payload.label, 240),
        summary: text(payload.summary, REMOTE_CONTROL_CONVERSATION_EVENT_SUMMARY_BYTES),
      },
    };
  }
  if (!exact(raw, ['conversationId', 'seq', 'revision', 'type', 'turnId', 'createdAt'])) return invalid();
  return { ...common, type } as RemoteControlConversationEvent;
}

function model(value: unknown): RemoteControlConversationModel {
  const raw = object(value);
  if (!exact(raw, ['modelId', 'label', 'isDefault']) || typeof raw.isDefault !== 'boolean') return invalid();
  return {
    modelId: normalizeAgentRuntimeModelId(raw.modelId),
    label: text(raw.label, 240),
    isDefault: raw.isDefault,
  };
}

function capability(value: unknown): RemoteControlConversationCapability {
  const raw = object(value);
  if (!exact(raw, ['adapterId', 'label', 'availability', 'features'])
    || raw.adapterId !== REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID
    || !['available', 'unavailable', 'unknown'].includes(String(raw.availability))) return invalid();
  const features = object(raw.features);
  if (!exact(features, ['continue', 'steer', 'interrupt', 'archive'])
    || Object.values(features).some(feature => typeof feature !== 'boolean')) return invalid();
  return {
    adapterId: adapterId(raw.adapterId),
    label: text(raw.label, 120),
    availability: raw.availability as RemoteControlConversationCapability['availability'],
    features: features as unknown as RemoteControlConversationCapability['features'],
  };
}

function historyMessage(value: unknown): RemoteControlConversationHistoryMessage {
  const raw = object(value);
  if (!exact(raw, ['messageId', 'role', 'phase', 'text'])
    || (raw.role !== 'user' && raw.role !== 'assistant')
    || ![null, 'commentary', 'final_answer'].includes(raw.phase as string | null)
    || (raw.role === 'user' && raw.phase !== null)) return invalid();
  return {
    messageId: opaqueId(raw.messageId),
    role: raw.role,
    phase: raw.phase as RemoteControlConversationHistoryMessage['phase'],
    text: text(raw.text, REMOTE_CONTROL_CONVERSATION_HISTORY_TEXT_BYTES, true),
  };
}

function normalizeSuccessResult(
  op: RemoteControlConversationOperation,
  value: unknown,
): RemoteControlConversationResultByOperation[RemoteControlConversationOperation] {
  const raw = object(value);
  switch (op) {
    case 'capabilities': {
      if (!exact(raw, ['adapters', 'limits']) || !Array.isArray(raw.adapters) || raw.adapters.length > 4) return invalid();
      const adapters = raw.adapters.map(capability);
      if (new Set(adapters.map(item => item.adapterId)).size !== adapters.length) return invalid();
      const limits = object(raw.limits);
      if (!exact(limits, ['maxPromptBytes'])) return invalid();
      return { adapters, limits: { maxPromptBytes: integer(limits.maxPromptBytes, 1, REMOTE_CONTROL_CONVERSATION_MAX_PROMPT_BYTES) } };
    }
    case 'models.list': {
      if (!exact(raw, ['catalogId', 'cursor', 'nextCursor', 'models'])
        || !Array.isArray(raw.models) || raw.models.length > REMOTE_CONTROL_CONVERSATION_PAGE_LIMIT) return invalid();
      const models = raw.models.map(model);
      const normalizedCursor = cursor(raw.cursor);
      const nextCursor = cursor(raw.nextCursor);
      if (new Set(models.map(item => item.modelId)).size !== models.length
        || models.filter(item => item.isDefault).length > 1
        || (nextCursor !== null && nextCursor === normalizedCursor)) return invalid();
      return { catalogId: opaqueId(raw.catalogId), cursor: normalizedCursor, nextCursor, models };
    }
    case 'conversations.list': {
      if (!exact(raw, ['archivedOnly', 'cursor', 'nextCursor', 'conversations'])
        || typeof raw.archivedOnly !== 'boolean' || !Array.isArray(raw.conversations)
        || raw.conversations.length > REMOTE_CONTROL_CONVERSATION_PAGE_LIMIT) return invalid();
      const conversations = raw.conversations.map(normalizeRemoteControlConversationSummary);
      const normalizedCursor = cursor(raw.cursor);
      const nextCursor = cursor(raw.nextCursor);
      if (new Set(conversations.map(item => item.conversationId)).size !== conversations.length
        || conversations.some(item => raw.archivedOnly ? item.state !== 'archived' : item.state === 'archived')
        || (nextCursor !== null && nextCursor === normalizedCursor)) return invalid();
      return { archivedOnly: raw.archivedOnly, cursor: normalizedCursor, nextCursor, conversations };
    }
    case 'conversations.start':
    case 'conversations.continue': {
      if (!exact(raw, ['duplicate', 'conversation']) || typeof raw.duplicate !== 'boolean') return invalid();
      return { duplicate: raw.duplicate, conversation: normalizeRemoteControlConversationSummary(raw.conversation) };
    }
    case 'conversations.events': {
      if (!exact(raw, ['conversationId', 'after', 'nextCursor', 'events'])
        || !Array.isArray(raw.events) || raw.events.length > REMOTE_CONTROL_CONVERSATION_PAGE_LIMIT) return invalid();
      const conversationId = opaqueId(raw.conversationId);
      const after = integer(raw.after);
      const nextCursor = integer(raw.nextCursor);
      const events = raw.events.map(normalizeRemoteControlConversationEvent);
      if (nextCursor < after
        || events.some((event, index) => event.conversationId !== conversationId
          || event.seq <= (index === 0 ? after : events[index - 1]!.seq)
          || (index > 0 && Date.parse(event.createdAt) < Date.parse(events[index - 1]!.createdAt)))
        || nextCursor !== (events.at(-1)?.seq ?? after)) return invalid();
      return { conversationId, after, nextCursor, events };
    }
    case 'conversations.history': {
      if (!exact(raw, ['conversationId', 'revision', 'cursor', 'nextCursor', 'truncated', 'filtered', 'messages'])
        || typeof raw.truncated !== 'boolean' || raw.filtered !== true
        || !Array.isArray(raw.messages) || raw.messages.length > REMOTE_CONTROL_CONVERSATION_PAGE_LIMIT) return invalid();
      const messages = raw.messages.map(historyMessage);
      const normalizedCursor = cursor(raw.cursor);
      const nextCursor = cursor(raw.nextCursor);
      if (new Set(messages.map(item => item.messageId)).size !== messages.length
        || (nextCursor !== null && nextCursor === normalizedCursor)) return invalid();
      return {
        conversationId: opaqueId(raw.conversationId),
        revision: integer(raw.revision, 1),
        cursor: normalizedCursor,
        nextCursor,
        truncated: raw.truncated,
        filtered: true,
        messages,
      };
    }
    case 'conversations.steer':
    case 'conversations.interrupt':
    case 'conversations.archive':
    case 'conversations.unarchive':
      if (!exact(raw, ['conversation'])) return invalid();
      return { conversation: normalizeRemoteControlConversationSummary(raw.conversation) };
  }
}

export function normalizeRemoteControlConversationResult(value: unknown): RemoteControlConversationResult {
  assertSize(value);
  visitSafe(value, false);
  const raw = object(value);
  if (raw.type !== 'conversations.result'
    || raw.protocolVersion !== REMOTE_CONTROL_TASK_TRANSPORT_VERSION
    || raw.conversationProtocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION) return invalid();
  const op = operation(raw.operation);
  const common = {
    type: 'conversations.result' as const,
    protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
    conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    operationId: opaqueId(raw.operationId),
    operation: op,
  };
  if (raw.ok === true) {
    if (!exact(raw, ['type', 'protocolVersion', 'conversationProtocolVersion', 'operationId', 'operation', 'ok', 'result'])) return invalid();
    return { ...common, ok: true, result: normalizeSuccessResult(op, raw.result) };
  }
  if (raw.ok === false) {
    if (!exact(raw, ['type', 'protocolVersion', 'conversationProtocolVersion', 'operationId', 'operation', 'ok', 'error'])) return invalid();
    const error = object(raw.error);
    if (!exact(error, ['code', 'message', 'retryable'])
      || typeof error.code !== 'string' || !ERROR_CODE_RE.test(error.code)
      || typeof error.retryable !== 'boolean') return invalid();
    return {
      ...common,
      ok: false,
      error: { code: error.code, message: text(error.message, 3_000), retryable: error.retryable },
    };
  }
  return invalid();
}

export function assertRemoteControlConversationResultMatchesRequest(
  requestValue: unknown,
  resultValue: unknown,
): RemoteControlConversationResult {
  const request = normalizeRemoteControlConversationRequest(requestValue);
  const result = normalizeRemoteControlConversationResult(resultValue);
  if (result.operationId !== request.operationId || result.operation !== request.operation) return invalid();
  if (!result.ok) return result;
  switch (request.operation) {
    case 'capabilities':
      break;
    case 'models.list': {
      const response = result.result as RemoteControlConversationResultByOperation['models.list'];
      if (response.cursor !== request.payload.cursor
        || (request.payload.catalogId !== null && response.catalogId !== request.payload.catalogId)) return invalid();
      break;
    }
    case 'conversations.list': {
      const response = result.result as RemoteControlConversationResultByOperation['conversations.list'];
      if (response.archivedOnly !== request.payload.archivedOnly
        || response.cursor !== request.payload.cursor) return invalid();
      break;
    }
    case 'conversations.start': {
      const response = result.result as RemoteControlConversationResultByOperation['conversations.start'];
      if (response.conversation.controlId !== request.payload.controlId
        || response.conversation.adapterId !== request.payload.adapterId
        || response.conversation.modelId !== request.payload.modelId) return invalid();
      break;
    }
    case 'conversations.continue': {
      const response = result.result as RemoteControlConversationResultByOperation['conversations.continue'];
      if (response.conversation.conversationId !== request.payload.conversationId
        || response.conversation.revision < request.payload.expectedRevision
        || (response.conversation.state !== 'running' && !response.duplicate)) return invalid();
      break;
    }
    case 'conversations.events': {
      const response = result.result as RemoteControlConversationResultByOperation['conversations.events'];
      if (response.conversationId !== request.payload.conversationId
        || response.after !== request.payload.after) return invalid();
      break;
    }
    case 'conversations.history': {
      const response = result.result as RemoteControlConversationResultByOperation['conversations.history'];
      if (response.conversationId !== request.payload.conversationId
        || response.revision !== request.payload.expectedRevision
        || response.cursor !== request.payload.cursor) return invalid();
      break;
    }
    case 'conversations.steer': {
      const response = result.result as RemoteControlConversationResultByOperation['conversations.steer'];
      if (response.conversation.conversationId !== request.payload.conversationId
        || response.conversation.revision < request.payload.expectedRevision) return invalid();
      break;
    }
    case 'conversations.interrupt': {
      const response = result.result as RemoteControlConversationResultByOperation['conversations.interrupt'];
      if (response.conversation.conversationId !== request.payload.conversationId
        || response.conversation.revision < request.payload.expectedRevision) return invalid();
      break;
    }
    case 'conversations.archive': {
      const response = result.result as RemoteControlConversationResultByOperation['conversations.archive'];
      if (response.conversation.conversationId !== request.payload.conversationId
        || response.conversation.revision < request.payload.expectedRevision
        || response.conversation.state !== 'archived') return invalid();
      break;
    }
    case 'conversations.unarchive': {
      const response = result.result as RemoteControlConversationResultByOperation['conversations.unarchive'];
      if (response.conversation.conversationId !== request.payload.conversationId
        || response.conversation.revision < request.payload.expectedRevision
        || response.conversation.state !== 'idle') return invalid();
      break;
    }
  }
  return result;
}

export function normalizeRemoteControlConversationMessage(value: unknown): RemoteControlConversationMessage {
  const raw = object(value);
  if (raw.type === 'conversations.request') return normalizeRemoteControlConversationRequest(raw);
  if (raw.type === 'conversations.result') return normalizeRemoteControlConversationResult(raw);
  return invalid();
}

export function serializeRemoteControlConversationMessage(value: unknown): string {
  const normalized = normalizeRemoteControlConversationMessage(value);
  const serialized = JSON.stringify(normalized);
  if (encoder.encode(serialized).byteLength > REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES) {
    throw new RemoteControlConversationProtocolError('REMOTE_CONTROL_CONVERSATION_MESSAGE_TOO_LARGE');
  }
  return serialized;
}

export function parseRemoteControlConversationJson(value: string): RemoteControlConversationMessage {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES) {
    throw new RemoteControlConversationProtocolError('REMOTE_CONTROL_CONVERSATION_MESSAGE_TOO_LARGE');
  }
  try {
    return normalizeRemoteControlConversationMessage(JSON.parse(value));
  } catch (error) {
    if (error instanceof RemoteControlConversationProtocolError) throw error;
    return invalid('원격 지속형 대화 JSON이 올바르지 않습니다.');
  }
}

export function projectRemoteControlConversationSummary(
  value: AgentRuntimeConversationSummary,
  sessionControlId: string,
): RemoteControlConversationSummary {
  const local = normalizeAgentRuntimeConversationSummary(value);
  return normalizeRemoteControlConversationSummary({
    conversationId: local.conversationId,
    controlId: sessionControlId,
    projectLabel: local.projectLabel,
    adapterId: local.adapterId,
    modelId: local.modelId,
    state: local.state,
    activeTurnId: local.activeTurnId,
    revision: local.revision,
    createdAt: local.createdAt,
    updatedAt: local.updatedAt,
  });
}

export function projectRemoteControlConversationEvent(
  value: AgentRuntimeConversationEvent,
): RemoteControlConversationEvent {
  const local = normalizeAgentRuntimeConversationEvent(value);
  const common = {
    conversationId: local.conversationId,
    seq: local.seq,
    revision: local.revision,
    type: local.type,
    turnId: local.turnId,
    createdAt: local.createdAt,
  };
  if (local.type === 'conversation.progress') {
    return normalizeRemoteControlConversationEvent({
      ...common,
      payload: {
        summary: boundedUtf8Text(local.payload.summary, REMOTE_CONTROL_CONVERSATION_EVENT_SUMMARY_BYTES),
        phase: local.payload.phase === null ? null : boundedUtf8Text(local.payload.phase, 160),
      },
    });
  }
  if (local.type === 'conversation.artifact.summary') {
    return normalizeRemoteControlConversationEvent({
      ...common,
      payload: {
        kind: local.payload.kind,
        label: boundedUtf8Text(local.payload.label, 240),
        summary: boundedUtf8Text(local.payload.summary, REMOTE_CONTROL_CONVERSATION_EVENT_SUMMARY_BYTES),
      },
    });
  }
  return normalizeRemoteControlConversationEvent(common);
}

export function projectRemoteControlConversationCapability(
  value: AgentRuntimeAdapterCapability,
): RemoteControlConversationCapability {
  return capability({
    adapterId: value.adapterId,
    label: value.label,
    availability: value.availability,
    features: {
      continue: value.adapterId === 'codex',
      steer: value.adapterId === 'codex',
      interrupt: value.adapterId === 'codex' && value.features.cancellation,
      archive: value.adapterId === 'codex',
    },
  });
}
