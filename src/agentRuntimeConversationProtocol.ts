import {
  AGENT_RUNTIME_MAX_PROMPT_BYTES,
  assertAgentRuntimeRemoteSafe,
  normalizeAgentRuntimeModelId,
} from './agentRuntimeProtocol';
import { isBuiltinAgentRuntimeId, type BuiltinAgentRuntimeId } from './agentRuntimeRegistry';

/** Additive protocol; existing ephemeral task-v2 behavior stays unchanged. */
export const AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION =
  'agentstoz-conversations-v1' as const;
export const AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT =
  'retain-provider-history-on-this-host' as const;
/** Maximum semantic events returned by one cursor read on every transport. */
export const AGENT_RUNTIME_CONVERSATION_EVENT_READ_LIMIT = 100;
export const AGENT_RUNTIME_CONVERSATION_MAX_RETAINED_EVENTS = 512;
export const AGENT_RUNTIME_CONVERSATION_MAX_EVENTS_PER_TURN = 128;
export const AGENT_RUNTIME_CONVERSATION_EVENT_SUMMARY_MAX_LENGTH = 1_000;

export type AgentRuntimeConversationState = 'idle' | 'running' | 'archived' | 'unknown';
export type AgentRuntimeConversationEventType =
  | 'conversation.turn.started'
  | 'conversation.turn.completed'
  | 'conversation.turn.interrupted'
  | 'conversation.turn.unknown'
  | 'conversation.progress'
  | 'conversation.artifact.summary';

export type AgentRuntimeConversationArtifactKind =
  | 'diff'
  | 'test'
  | 'commit'
  | 'memory'
  | 'other';

export interface AgentRuntimeConversationSummary {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  conversationId: string;
  targetId: string;
  projectLabel: string;
  adapterId: BuiltinAgentRuntimeId;
  modelId: string;
  state: AgentRuntimeConversationState;
  /** AgentsToZ-owned correlation id; never a Codex provider turn id. */
  activeTurnId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRuntimeConversationCreateRequest {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  requestId: string;
  targetId: string;
  adapterId: BuiltinAgentRuntimeId;
  modelId: string;
  historyRetentionConsent: typeof AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT;
  initialPrompt: string;
}

export interface AgentRuntimeConversationContinueRequest {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  requestId: string;
  conversationId: string;
  expectedRevision: number;
  prompt: string;
}

export interface AgentRuntimeConversationSteerRequest {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  requestId: string;
  conversationId: string;
  expectedRevision: number;
  expectedTurnId: string;
  prompt: string;
}

export interface AgentRuntimeConversationInterruptRequest {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  requestId: string;
  conversationId: string;
  expectedRevision: number;
  expectedTurnId: string;
}

export interface AgentRuntimeConversationMutationRequest {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  requestId: string;
  conversationId: string;
  expectedRevision: number;
}

export interface AgentRuntimeConversationDeleteRequest
  extends AgentRuntimeConversationMutationRequest {
  confirmPermanentDeletion: true;
}

export interface AgentRuntimeConversationHistoryRequest {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  conversationId: string;
  expectedRevision: number;
}

export interface AgentRuntimeConversationEventsRequest {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  conversationId: string;
  after: number;
}

interface AgentRuntimeConversationEventBase<TType extends AgentRuntimeConversationEventType> {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  conversationId: string;
  seq: number;
  revision: number;
  type: TType;
  /** Null is allowed only when failure preceded the provider turn binding. */
  turnId: string | null;
  createdAt: string;
}

export type AgentRuntimeConversationEvent =
  | AgentRuntimeConversationEventBase<
      | 'conversation.turn.started'
      | 'conversation.turn.completed'
      | 'conversation.turn.interrupted'
      | 'conversation.turn.unknown'
    >
  | (AgentRuntimeConversationEventBase<'conversation.progress'> & {
      payload: { summary: string; phase: string | null };
    })
  | (AgentRuntimeConversationEventBase<'conversation.artifact.summary'> & {
      payload: {
        kind: AgentRuntimeConversationArtifactKind;
        label: string;
        summary: string;
      };
    });

export type AgentRuntimeConversationSemanticEventDraft =
  | Pick<Extract<AgentRuntimeConversationEvent, { type: 'conversation.progress' }>, 'type' | 'payload'>
  | Pick<Extract<AgentRuntimeConversationEvent, { type: 'conversation.artifact.summary' }>, 'type' | 'payload'>;

type JsonObject = Record<string, unknown>;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const STATES = new Set<AgentRuntimeConversationState>(['idle', 'running', 'archived', 'unknown']);
const EVENT_TYPES = new Set<AgentRuntimeConversationEventType>([
  'conversation.turn.started',
  'conversation.turn.completed',
  'conversation.turn.interrupted',
  'conversation.turn.unknown',
  'conversation.progress',
  'conversation.artifact.summary',
]);
const ARTIFACT_KINDS = new Set<AgentRuntimeConversationArtifactKind>([
  'diff', 'test', 'commit', 'memory', 'other',
]);

export class AgentRuntimeConversationProtocolError extends Error {
  readonly code = 'AGENT_RUNTIME_CONVERSATION_PROTOCOL_INVALID';

  constructor() {
    super('지속형 에이전트 대화 메시지가 올바르지 않습니다.');
    this.name = 'AgentRuntimeConversationProtocolError';
  }
}

function invalid(): never {
  throw new AgentRuntimeConversationProtocolError();
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) return invalid();
  return value;
}

function prompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')
    || new TextEncoder().encode(value).byteLength > AGENT_RUNTIME_MAX_PROMPT_BYTES) return invalid();
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid();
  return value;
}

function canonicalIsoDate(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalid();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return invalid();
  return value;
}

function projectLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120
    || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) return invalid();
  return value;
}

function semanticText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength
    || value.includes('\u0000')) return invalid();
  return value;
}

function adapterId(value: unknown): BuiltinAgentRuntimeId {
  if (!isBuiltinAgentRuntimeId(value)) return invalid();
  return value;
}

function assertPublicBoundary(value: unknown): void {
  try {
    assertAgentRuntimeRemoteSafe(value);
  } catch {
    invalid();
  }
}

export function normalizeAgentRuntimeConversationSummary(
  value: unknown,
): AgentRuntimeConversationSummary {
  assertPublicBoundary(value);
  const raw = asObject(value);
  if (!exactKeys(raw, [
    'protocolVersion', 'conversationId', 'targetId', 'projectLabel', 'adapterId',
    'modelId', 'state', 'activeTurnId', 'revision', 'createdAt', 'updatedAt',
  ])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || !STATES.has(raw.state as AgentRuntimeConversationState)) return invalid();
  const state = raw.state as AgentRuntimeConversationState;
  const activeTurnId = raw.activeTurnId === null ? null : opaqueId(raw.activeTurnId);
  if ((state === 'running') !== (activeTurnId !== null)) return invalid();
  const createdAt = canonicalIsoDate(raw.createdAt);
  const updatedAt = canonicalIsoDate(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversationId: opaqueId(raw.conversationId),
    targetId: opaqueId(raw.targetId),
    projectLabel: projectLabel(raw.projectLabel),
    adapterId: adapterId(raw.adapterId),
    modelId: normalizeAgentRuntimeModelId(raw.modelId),
    state,
    activeTurnId,
    revision: revision(raw.revision),
    createdAt,
    updatedAt,
  };
}

export function normalizeAgentRuntimeConversationEvent(
  value: unknown,
): AgentRuntimeConversationEvent {
  assertPublicBoundary(value);
  const raw = asObject(value);
  if (raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || !EVENT_TYPES.has(raw.type as AgentRuntimeConversationEventType)
    || typeof raw.seq !== 'number'
    || !Number.isSafeInteger(raw.seq)
    || raw.seq < 1) return invalid();
  const type = raw.type as AgentRuntimeConversationEventType;
  const turnId = raw.turnId === null ? null : opaqueId(raw.turnId);
  if (turnId === null && type !== 'conversation.turn.unknown') return invalid();
  const base = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversationId: opaqueId(raw.conversationId),
    seq: raw.seq,
    revision: revision(raw.revision),
    turnId,
    createdAt: canonicalIsoDate(raw.createdAt),
  };
  if (type === 'conversation.progress') {
    if (!exactKeys(raw, [
      'protocolVersion', 'conversationId', 'seq', 'revision', 'type', 'turnId', 'createdAt', 'payload',
    ])) return invalid();
    const payload = asObject(raw.payload);
    if (!exactKeys(payload, ['summary', 'phase'])) return invalid();
    return {
      ...base,
      type,
      turnId: opaqueId(turnId),
      payload: {
        summary: semanticText(payload.summary, AGENT_RUNTIME_CONVERSATION_EVENT_SUMMARY_MAX_LENGTH),
        phase: payload.phase === null ? null : semanticText(payload.phase, 80),
      },
    };
  }
  if (type === 'conversation.artifact.summary') {
    if (!exactKeys(raw, [
      'protocolVersion', 'conversationId', 'seq', 'revision', 'type', 'turnId', 'createdAt', 'payload',
    ])) return invalid();
    const payload = asObject(raw.payload);
    if (!exactKeys(payload, ['kind', 'label', 'summary'])
      || !ARTIFACT_KINDS.has(payload.kind as AgentRuntimeConversationArtifactKind)) return invalid();
    return {
      ...base,
      type,
      turnId: opaqueId(turnId),
      payload: {
        kind: payload.kind as AgentRuntimeConversationArtifactKind,
        label: semanticText(payload.label, 160),
        summary: semanticText(payload.summary, AGENT_RUNTIME_CONVERSATION_EVENT_SUMMARY_MAX_LENGTH),
      },
    };
  }
  if (!exactKeys(raw, [
    'protocolVersion', 'conversationId', 'seq', 'revision', 'type', 'turnId', 'createdAt',
  ])) return invalid();
  return { ...base, type } as AgentRuntimeConversationEvent;
}

export function normalizeAgentRuntimeConversationCreateRequest(
  value: unknown,
): AgentRuntimeConversationCreateRequest {
  const raw = asObject(value);
  if (!exactKeys(raw, [
    'protocolVersion', 'requestId', 'targetId', 'adapterId', 'modelId',
    'historyRetentionConsent', 'initialPrompt',
  ])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || raw.historyRetentionConsent !== AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT) return invalid();
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    requestId: opaqueId(raw.requestId),
    targetId: opaqueId(raw.targetId),
    adapterId: adapterId(raw.adapterId),
    modelId: normalizeAgentRuntimeModelId(raw.modelId),
    historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
    initialPrompt: prompt(raw.initialPrompt),
  };
}

export function normalizeAgentRuntimeConversationContinueRequest(
  value: unknown,
): AgentRuntimeConversationContinueRequest {
  const raw = asObject(value);
  if (!exactKeys(raw, [
    'protocolVersion', 'requestId', 'conversationId', 'expectedRevision', 'prompt',
  ]) || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION) return invalid();
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    requestId: opaqueId(raw.requestId),
    conversationId: opaqueId(raw.conversationId),
    expectedRevision: revision(raw.expectedRevision),
    prompt: prompt(raw.prompt),
  };
}

export function normalizeAgentRuntimeConversationSteerRequest(
  value: unknown,
): AgentRuntimeConversationSteerRequest {
  const raw = asObject(value);
  if (!exactKeys(raw, [
    'protocolVersion', 'requestId', 'conversationId', 'expectedRevision',
    'expectedTurnId', 'prompt',
  ]) || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION) return invalid();
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    requestId: opaqueId(raw.requestId),
    conversationId: opaqueId(raw.conversationId),
    expectedRevision: revision(raw.expectedRevision),
    expectedTurnId: opaqueId(raw.expectedTurnId),
    prompt: prompt(raw.prompt),
  };
}

export function normalizeAgentRuntimeConversationInterruptRequest(
  value: unknown,
): AgentRuntimeConversationInterruptRequest {
  const raw = asObject(value);
  if (!exactKeys(raw, [
    'protocolVersion', 'requestId', 'conversationId', 'expectedRevision', 'expectedTurnId',
  ]) || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION) return invalid();
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    requestId: opaqueId(raw.requestId),
    conversationId: opaqueId(raw.conversationId),
    expectedRevision: revision(raw.expectedRevision),
    expectedTurnId: opaqueId(raw.expectedTurnId),
  };
}

export function normalizeAgentRuntimeConversationMutationRequest(
  value: unknown,
): AgentRuntimeConversationMutationRequest {
  const raw = asObject(value);
  if (!exactKeys(raw, [
    'protocolVersion', 'requestId', 'conversationId', 'expectedRevision',
  ]) || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION) return invalid();
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    requestId: opaqueId(raw.requestId),
    conversationId: opaqueId(raw.conversationId),
    expectedRevision: revision(raw.expectedRevision),
  };
}

export function normalizeAgentRuntimeConversationDeleteRequest(
  value: unknown,
): AgentRuntimeConversationDeleteRequest {
  const raw = asObject(value);
  if (!exactKeys(raw, [
    'protocolVersion', 'requestId', 'conversationId', 'expectedRevision',
    'confirmPermanentDeletion',
  ])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || raw.confirmPermanentDeletion !== true) return invalid();
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    requestId: opaqueId(raw.requestId),
    conversationId: opaqueId(raw.conversationId),
    expectedRevision: revision(raw.expectedRevision),
    confirmPermanentDeletion: true,
  };
}

export function normalizeAgentRuntimeConversationHistoryRequest(
  value: unknown,
): AgentRuntimeConversationHistoryRequest {
  const raw = asObject(value);
  if (!exactKeys(raw, [
    'protocolVersion', 'conversationId', 'expectedRevision',
  ]) || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION) return invalid();
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversationId: opaqueId(raw.conversationId),
    expectedRevision: revision(raw.expectedRevision),
  };
}

export function normalizeAgentRuntimeConversationEventsRequest(
  value: unknown,
): AgentRuntimeConversationEventsRequest {
  const raw = asObject(value);
  if (!exactKeys(raw, ['protocolVersion', 'conversationId', 'after'])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || typeof raw.after !== 'number'
    || !Number.isSafeInteger(raw.after)
    || raw.after < 0) return invalid();
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversationId: opaqueId(raw.conversationId),
    after: raw.after,
  };
}
