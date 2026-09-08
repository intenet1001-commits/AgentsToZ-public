import { assertAgentRuntimeRemoteSafe } from './agentRuntimeProtocol';

/**
 * Additive protocol for ephemeral questions raised by a retained conversation.
 * It is intentionally separate from conversations-v1 so older local and remote
 * clients keep rejecting fields they do not understand instead of silently
 * misinterpreting a running turn.
 */
export const AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION =
  'agentstoz-conversation-questions-v1' as const;
export const AGENT_RUNTIME_CONVERSATION_QUESTION_MAX_COUNT = 3;
export const AGENT_RUNTIME_CONVERSATION_QUESTION_MAX_OPTIONS = 3;
export const AGENT_RUNTIME_CONVERSATION_QUESTION_MAX_ANSWER_BYTES = 2_000;

export interface AgentRuntimeConversationQuestionOption {
  optionId: string;
  label: string;
  description: string;
}

export interface AgentRuntimeConversationQuestionItem {
  questionId: string;
  header: string;
  question: string;
  options: AgentRuntimeConversationQuestionOption[] | null;
  allowOther: boolean;
}

export interface AgentRuntimeConversationPendingQuestion {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION;
  questionRequestId: string;
  conversationId: string;
  turnId: string;
  revision: number;
  expiresAt: string;
  questions: AgentRuntimeConversationQuestionItem[];
}

export interface AgentRuntimeConversationQuestionStatusResponse {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION;
  conversationId: string;
  question: AgentRuntimeConversationPendingQuestion | null;
}

export interface AgentRuntimeConversationQuestionAnswer {
  questionId: string;
  optionId: string | null;
  text: string | null;
}

export interface AgentRuntimeConversationQuestionAnswerRequest {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION;
  requestId: string;
  conversationId: string;
  questionRequestId: string;
  expectedRevision: number;
  expectedTurnId: string;
  answers: AgentRuntimeConversationQuestionAnswer[];
}

export interface AgentRuntimeConversationQuestionAnswerResponse {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION;
  requestId: string;
  conversationId: string;
  questionRequestId: string;
  accepted: true;
  duplicate: boolean;
}

export interface AgentRuntimeConversationQuestionErrorResponse {
  protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION;
  ok: false;
  code: string;
  error: string;
}

type JsonObject = Record<string, unknown>;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export class AgentRuntimeConversationQuestionProtocolError extends Error {
  readonly code = 'AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_INVALID';

  constructor() {
    super('지속형 대화 질문 메시지가 올바르지 않습니다.');
    this.name = 'AgentRuntimeConversationQuestionProtocolError';
  }
}

function invalid(): never {
  throw new AgentRuntimeConversationQuestionProtocolError();
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
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value) || FORBIDDEN_IDS.has(value)) {
    return invalid();
  }
  return value;
}

function boundedText(value: unknown, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string'
    || (!allowEmpty && !value.trim())
    || value.length > maxLength
    || /[\u0000\r\n]/u.test(value)) return invalid();
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid();
  return value;
}

function canonicalFutureDate(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) return invalid();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return invalid();
  return value;
}

function questionOption(value: unknown): AgentRuntimeConversationQuestionOption {
  const raw = object(value);
  if (!exact(raw, ['optionId', 'label', 'description'])) return invalid();
  return {
    optionId: opaqueId(raw.optionId),
    label: boundedText(raw.label, 120),
    description: boundedText(raw.description, 500, true),
  };
}

function questionItem(value: unknown): AgentRuntimeConversationQuestionItem {
  const raw = object(value);
  if (!exact(raw, ['questionId', 'header', 'question', 'options', 'allowOther'])
    || typeof raw.allowOther !== 'boolean'
    || (raw.options !== null && !Array.isArray(raw.options))) return invalid();
  const options = raw.options === null ? null : raw.options.map(questionOption);
  if (options && (options.length < 2
    || options.length > AGENT_RUNTIME_CONVERSATION_QUESTION_MAX_OPTIONS
    || new Set(options.map(option => option.optionId)).size !== options.length)) return invalid();
  return {
    questionId: opaqueId(raw.questionId),
    header: boundedText(raw.header, 80),
    question: boundedText(raw.question, 1_000),
    options,
    allowOther: raw.allowOther,
  };
}

export function normalizeAgentRuntimeConversationPendingQuestion(
  value: unknown,
): AgentRuntimeConversationPendingQuestion {
  assertAgentRuntimeRemoteSafe(value);
  const raw = object(value);
  if (!exact(raw, [
    'protocolVersion', 'questionRequestId', 'conversationId', 'turnId',
    'revision', 'expiresAt', 'questions',
  ])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION
    || !Array.isArray(raw.questions)
    || raw.questions.length < 1
    || raw.questions.length > AGENT_RUNTIME_CONVERSATION_QUESTION_MAX_COUNT) return invalid();
  const questions = raw.questions.map(questionItem);
  if (new Set(questions.map(question => question.questionId)).size !== questions.length) {
    return invalid();
  }
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
    questionRequestId: opaqueId(raw.questionRequestId),
    conversationId: opaqueId(raw.conversationId),
    turnId: opaqueId(raw.turnId),
    revision: revision(raw.revision),
    expiresAt: canonicalFutureDate(raw.expiresAt),
    questions,
  };
}

export function normalizeAgentRuntimeConversationQuestionStatusResponse(
  value: unknown,
): AgentRuntimeConversationQuestionStatusResponse {
  const raw = object(value);
  if (!exact(raw, ['protocolVersion', 'conversationId', 'question'])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION) return invalid();
  const conversationId = opaqueId(raw.conversationId);
  const question = raw.question === null
    ? null
    : normalizeAgentRuntimeConversationPendingQuestion(raw.question);
  if (question && question.conversationId !== conversationId) return invalid();
  const normalized = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
    conversationId,
    question,
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

function answer(value: unknown): AgentRuntimeConversationQuestionAnswer {
  const raw = object(value);
  if (!exact(raw, ['questionId', 'optionId', 'text'])) return invalid();
  const optionId = raw.optionId === null ? null : opaqueId(raw.optionId);
  let text: string | null = null;
  if (raw.text !== null) {
    if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.includes('\u0000')
      || new TextEncoder().encode(raw.text).byteLength
        > AGENT_RUNTIME_CONVERSATION_QUESTION_MAX_ANSWER_BYTES) return invalid();
    text = raw.text;
  }
  if ((optionId === null) === (text === null)) return invalid();
  return { questionId: opaqueId(raw.questionId), optionId, text };
}

export function normalizeAgentRuntimeConversationQuestionAnswerRequest(
  value: unknown,
): AgentRuntimeConversationQuestionAnswerRequest {
  assertAgentRuntimeRemoteSafe(value);
  const raw = object(value);
  if (!exact(raw, [
    'protocolVersion', 'requestId', 'conversationId', 'questionRequestId',
    'expectedRevision', 'expectedTurnId', 'answers',
  ])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION
    || !Array.isArray(raw.answers)
    || raw.answers.length < 1
    || raw.answers.length > AGENT_RUNTIME_CONVERSATION_QUESTION_MAX_COUNT) return invalid();
  const answers = raw.answers.map(answer);
  if (new Set(answers.map(item => item.questionId)).size !== answers.length) return invalid();
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
    requestId: opaqueId(raw.requestId),
    conversationId: opaqueId(raw.conversationId),
    questionRequestId: opaqueId(raw.questionRequestId),
    expectedRevision: revision(raw.expectedRevision),
    expectedTurnId: opaqueId(raw.expectedTurnId),
    answers,
  };
}

export function normalizeAgentRuntimeConversationQuestionAnswerResponse(
  value: unknown,
): AgentRuntimeConversationQuestionAnswerResponse {
  const raw = object(value);
  if (!exact(raw, [
    'protocolVersion', 'requestId', 'conversationId', 'questionRequestId',
    'accepted', 'duplicate',
  ])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION
    || raw.accepted !== true
    || typeof raw.duplicate !== 'boolean') return invalid();
  const normalized: AgentRuntimeConversationQuestionAnswerResponse = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
    requestId: opaqueId(raw.requestId),
    conversationId: opaqueId(raw.conversationId),
    questionRequestId: opaqueId(raw.questionRequestId),
    accepted: true,
    duplicate: raw.duplicate,
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}

export function normalizeAgentRuntimeConversationQuestionErrorResponse(
  value: unknown,
): AgentRuntimeConversationQuestionErrorResponse {
  const raw = object(value);
  if (!exact(raw, ['protocolVersion', 'ok', 'code', 'error'])
    || raw.protocolVersion !== AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION
    || raw.ok !== false
    || typeof raw.code !== 'string'
    || !/^[A-Z][A-Z0-9_]{1,79}$/.test(raw.code)) return invalid();
  const normalized: AgentRuntimeConversationQuestionErrorResponse = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
    ok: false,
    code: raw.code,
    error: boundedText(raw.error, 500),
  };
  assertAgentRuntimeRemoteSafe(normalized);
  return normalized;
}
