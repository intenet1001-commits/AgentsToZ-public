import {
  CONVERSATION_HISTORY_MAX_MESSAGES,
  CONVERSATION_HISTORY_MAX_MESSAGE_BYTES,
  CONVERSATION_HISTORY_MAX_TOTAL_TEXT_BYTES,
  CONVERSATION_HISTORY_MAX_TURNS,
  type CodexConversationHistory,
  type CodexConversationHistoryMessage,
  type CodexConversationHistoryTurn,
} from './agentRuntimeConversationHistory';
import {
  AGENT_RUNTIME_CONVERSATION_EVENT_READ_LIMIT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  normalizeAgentRuntimeConversationEvent,
  normalizeAgentRuntimeConversationSummary,
  type AgentRuntimeConversationEvent,
  type AgentRuntimeConversationSummary,
} from './agentRuntimeConversationProtocol';
import { assertAgentRuntimeRemoteSafe } from './agentRuntimeProtocol';

export const AGENT_RUNTIME_CONVERSATION_LIST_LIMIT = 100;

export interface AgentRuntimeConversationListResponse {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  conversations: AgentRuntimeConversationSummary[];
}

export interface AgentRuntimeConversationTurnAcceptedResponse {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  duplicate: boolean;
  accepted: boolean;
  conversation: AgentRuntimeConversationSummary;
}

export interface AgentRuntimeConversationEventsResponse {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  conversationId: string;
  after: number;
  nextCursor: number;
  events: AgentRuntimeConversationEvent[];
}

export interface AgentRuntimeConversationHistoryResponse {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  conversation: AgentRuntimeConversationSummary;
  history: CodexConversationHistory;
}

export interface AgentRuntimeConversationDeleteResponse {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  conversationId: string;
  deleted: true;
  duplicate: boolean;
}

export interface AgentRuntimeConversationErrorResponse {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
  ok: false;
  code: string;
  error: string;
}

type JsonObject = Record<string, unknown>;

function invalid(): never {
  throw new Error('지속형 에이전트 대화 API 응답이 올바르지 않습니다.');
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

function safeSequence(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalid();
  return value;
}

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string'
    || value.length > 32
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) return invalid();
  return value;
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string'
    || new TextEncoder().encode(value).byteLength > CONVERSATION_HISTORY_MAX_MESSAGE_BYTES) {
    return invalid();
  }
  return value;
}

function historyMessage(value: unknown, expectedTurnId: string): CodexConversationHistoryMessage {
  const raw = object(value);
  if (!exact(raw, ['messageId', 'turnId', 'role', 'phase', 'text'])
    || raw.turnId !== expectedTurnId
    || (raw.role !== 'user' && raw.role !== 'assistant')
    || ![null, 'commentary', 'final_answer'].includes(raw.phase as null | string)
    || (raw.role === 'user' && raw.phase !== null)) return invalid();
  const normalized: CodexConversationHistoryMessage = {
    messageId: String(raw.messageId),
    turnId: String(raw.turnId),
    role: raw.role,
    phase: raw.phase as CodexConversationHistoryMessage['phase'],
    text: boundedText(raw.text),
  };
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(normalized.messageId)
    || !/^[A-Za-z0-9_-]{8,128}$/.test(normalized.turnId)) return invalid();
  return normalized;
}

function historyTurn(value: unknown): CodexConversationHistoryTurn {
  const raw = object(value);
  if (!exact(raw, ['turnId', 'status', 'startedAt', 'completedAt', 'messages'])
    || typeof raw.turnId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(raw.turnId)
    || !['completed', 'interrupted', 'failed', 'inProgress'].includes(String(raw.status))
    || !Array.isArray(raw.messages)) return invalid();
  const turnId = raw.turnId;
  return {
    turnId,
    status: raw.status as CodexConversationHistoryTurn['status'],
    startedAt: timestamp(raw.startedAt),
    completedAt: timestamp(raw.completedAt),
    messages: raw.messages.map(message => historyMessage(message, turnId)),
  };
}

export function normalizeAgentRuntimeConversationHistory(
  value: unknown,
): CodexConversationHistory {
  const raw = object(value);
  if (!exact(raw, ['status', 'turns', 'truncated', 'filtered'])
    || !['idle', 'active', 'systemError'].includes(String(raw.status))
    || !Array.isArray(raw.turns)
    || raw.turns.length > CONVERSATION_HISTORY_MAX_TURNS
    || typeof raw.truncated !== 'boolean'
    || typeof raw.filtered !== 'boolean') return invalid();
  const turns = raw.turns.map(historyTurn);
  const messages = turns.flatMap(turn => turn.messages);
  if (new Set(turns.map(turn => turn.turnId)).size !== turns.length
    || new Set(messages.map(message => message.messageId)).size !== messages.length
    || messages.length > CONVERSATION_HISTORY_MAX_MESSAGES
    || messages.reduce((total, message) => (
      total + new TextEncoder().encode(message.text).byteLength
    ), 0) > CONVERSATION_HISTORY_MAX_TOTAL_TEXT_BYTES) return invalid();
  const normalized: CodexConversationHistory = {
    status: raw.status as CodexConversationHistory['status'],
    turns,
    truncated: raw.truncated,
    filtered: raw.filtered,
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentRuntimeConversationListResponse(
  value: unknown,
): AgentRuntimeConversationListResponse {
  const raw = object(value);
  if (!exact(raw, ['protocolVersion', 'conversations'])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || !Array.isArray(raw.conversations)
    || raw.conversations.length > AGENT_RUNTIME_CONVERSATION_LIST_LIMIT) return invalid();
  const normalized = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversations: raw.conversations.map(normalizeAgentRuntimeConversationSummary),
  };
  if (new Set(normalized.conversations.map(conversation => conversation.conversationId)).size
    !== normalized.conversations.length) return invalid();
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentRuntimeConversationTurnAcceptedResponse(
  value: unknown,
): AgentRuntimeConversationTurnAcceptedResponse {
  const raw = object(value);
  if (!exact(raw, ['protocolVersion', 'duplicate', 'accepted', 'conversation'])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || typeof raw.duplicate !== 'boolean'
    || typeof raw.accepted !== 'boolean') return invalid();
  const normalized = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    duplicate: raw.duplicate,
    accepted: raw.accepted,
    conversation: normalizeAgentRuntimeConversationSummary(raw.conversation),
  };
  if (normalized.accepted && normalized.conversation.state !== 'running') return invalid();
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentRuntimeConversationEventsResponse(
  value: unknown,
): AgentRuntimeConversationEventsResponse {
  const raw = object(value);
  if (!exact(raw, ['protocolVersion', 'conversationId', 'after', 'nextCursor', 'events'])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || typeof raw.conversationId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(raw.conversationId)
    || !Array.isArray(raw.events)
    || raw.events.length > AGENT_RUNTIME_CONVERSATION_EVENT_READ_LIMIT) return invalid();
  const after = safeSequence(raw.after);
  const nextCursor = safeSequence(raw.nextCursor);
  const events = raw.events.map(normalizeAgentRuntimeConversationEvent);
  if (nextCursor < after
    || events.some(event => event.conversationId !== raw.conversationId)
    || events.some((event, index) => event.seq <= (index === 0 ? after : events[index - 1]!.seq))
    || events.some((event, index) => index > 0
      && Date.parse(event.createdAt) < Date.parse(events[index - 1]!.createdAt))
    || nextCursor !== (events.at(-1)?.seq ?? after)) return invalid();
  const normalized = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversationId: raw.conversationId,
    after,
    nextCursor,
    events,
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentRuntimeConversationHistoryResponse(
  value: unknown,
): AgentRuntimeConversationHistoryResponse {
  const raw = object(value);
  if (!exact(raw, ['protocolVersion', 'conversation', 'history'])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION) return invalid();
  const normalized = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversation: normalizeAgentRuntimeConversationSummary(raw.conversation),
    history: normalizeAgentRuntimeConversationHistory(raw.history),
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentRuntimeConversationDeleteResponse(
  value: unknown,
): AgentRuntimeConversationDeleteResponse {
  const raw = object(value);
  if (!exact(raw, ['protocolVersion', 'conversationId', 'deleted', 'duplicate'])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || typeof raw.conversationId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(raw.conversationId)
    || raw.deleted !== true
    || typeof raw.duplicate !== 'boolean') return invalid();
  const normalized: AgentRuntimeConversationDeleteResponse = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversationId: raw.conversationId,
    deleted: true,
    duplicate: raw.duplicate,
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentRuntimeConversationErrorResponse(
  value: unknown,
): AgentRuntimeConversationErrorResponse {
  const raw = object(value);
  if (!exact(raw, ['protocolVersion', 'ok', 'code', 'error'])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
    || raw.ok !== false
    || typeof raw.code !== 'string'
    || !/^[A-Z][A-Z0-9_]{1,79}$/.test(raw.code)
    || typeof raw.error !== 'string'
    || !raw.error.trim()
    || raw.error.length > 120
    || /[\u0000-\u001f\u007f]/.test(raw.error)) return invalid();
  const normalized: AgentRuntimeConversationErrorResponse = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    ok: false,
    code: raw.code,
    error: raw.error,
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}
