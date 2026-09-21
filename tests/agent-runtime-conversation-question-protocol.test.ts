import { describe, expect, test } from 'bun:test';

import {
  AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
  AgentRuntimeConversationQuestionProtocolError,
  normalizeAgentRuntimeConversationPendingQuestion,
  normalizeAgentRuntimeConversationQuestionAnswerRequest,
  normalizeAgentRuntimeConversationQuestionStatusResponse,
  type AgentRuntimeConversationPendingQuestion,
} from '../src/agentRuntimeConversationQuestionProtocol';

const pending: AgentRuntimeConversationPendingQuestion = {
  protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
  questionRequestId: 'question_request_12345678',
  conversationId: 'conversation_12345678',
  turnId: 'turn_12345678',
  revision: 3,
  expiresAt: '2026-09-05T00:30:00.000Z',
  questions: [{
    questionId: 'question_12345678',
    header: '구현 방식',
    question: '어떤 방식으로 진행할까요?',
    options: [
      { optionId: 'option_12345678', label: '안전 우선', description: '검증부터 합니다.' },
      { optionId: 'option_87654321', label: '빠른 진행', description: '바로 적용합니다.' },
    ],
    allowOther: false,
  }],
};

describe('conversation question protocol', () => {
  test('accepts an exact bounded status and answer', () => {
    expect(normalizeAgentRuntimeConversationQuestionStatusResponse({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      conversationId: pending.conversationId,
      question: pending,
    }).question).toEqual(pending);
    expect(normalizeAgentRuntimeConversationQuestionAnswerRequest({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      requestId: 'answer_request_12345678',
      conversationId: pending.conversationId,
      questionRequestId: pending.questionRequestId,
      expectedRevision: pending.revision,
      expectedTurnId: pending.turnId,
      answers: [{
        questionId: pending.questions[0]!.questionId,
        optionId: pending.questions[0]!.options![0]!.optionId,
        text: null,
      }],
    }).answers).toHaveLength(1);
  });

  test('rejects provider-like ids and unexpected fields at the public boundary', () => {
    expect(() => normalizeAgentRuntimeConversationPendingQuestion({
      ...pending,
      questions: [{ ...pending.questions[0], questionId: '__proto__' }],
    })).toThrow(AgentRuntimeConversationQuestionProtocolError);
    expect(() => normalizeAgentRuntimeConversationPendingQuestion({
      ...pending,
      providerThreadId: 'private_provider_id',
    })).toThrow(AgentRuntimeConversationQuestionProtocolError);
  });

  test('requires exactly one option id or direct answer text', () => {
    expect(() => normalizeAgentRuntimeConversationQuestionAnswerRequest({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      requestId: 'answer_request_12345678',
      conversationId: pending.conversationId,
      questionRequestId: pending.questionRequestId,
      expectedRevision: pending.revision,
      expectedTurnId: pending.turnId,
      answers: [{
        questionId: pending.questions[0]!.questionId,
        optionId: pending.questions[0]!.options![0]!.optionId,
        text: 'ambiguous',
      }],
    })).toThrow(AgentRuntimeConversationQuestionProtocolError);
  });
});
