import { describe, expect, test } from 'bun:test';

import {
  AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  normalizeAgentRuntimeConversationContinueRequest,
  normalizeAgentRuntimeConversationCreateRequest,
  normalizeAgentRuntimeConversationDeleteRequest,
  normalizeAgentRuntimeConversationEvent,
  normalizeAgentRuntimeConversationEventsRequest,
  normalizeAgentRuntimeConversationHistoryRequest,
  normalizeAgentRuntimeConversationInterruptRequest,
  normalizeAgentRuntimeConversationMutationRequest,
  normalizeAgentRuntimeConversationSteerRequest,
  normalizeAgentRuntimeConversationSummary,
} from '../src/agentRuntimeConversationProtocol';

const base = {
  protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  requestId: 'request_12345678',
  conversationId: 'conversation_12345678',
  expectedRevision: 3,
};

describe('persistent agent conversation v1 protocol', () => {
  test('requires explicit provider-history retention consent on creation', () => {
    const request = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_12345678',
      targetId: 'target_12345678',
      adapterId: 'codex',
      modelId: 'gpt-5.6-sol',
      historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
      initialPrompt: '현재 변경을 검토하고 테스트해줘.',
    } as const;
    expect(normalizeAgentRuntimeConversationCreateRequest(request)).toEqual(request);
    for (const invalid of [
      { ...request, historyRetentionConsent: false },
      { ...request, historyRetentionConsent: true },
      { ...request, historyRetentionConsent: undefined },
      { ...request, executionMode: 'danger-full-access' },
    ]) {
      expect(() => normalizeAgentRuntimeConversationCreateRequest(invalid)).toThrow();
    }
  });

  test('uses optimistic revisions and AgentsToZ turn ids for continue, steer, and interrupt', () => {
    expect(normalizeAgentRuntimeConversationContinueRequest({
      ...base,
      prompt: '이어서 실패한 테스트를 고쳐줘.',
    })).toMatchObject({ conversationId: base.conversationId, expectedRevision: 3 });
    expect(normalizeAgentRuntimeConversationSteerRequest({
      ...base,
      expectedTurnId: 'turn_12345678',
      prompt: '우선 회귀 테스트부터 확인해줘.',
    })).toMatchObject({ expectedTurnId: 'turn_12345678' });
    expect(normalizeAgentRuntimeConversationInterruptRequest({
      ...base,
      expectedTurnId: 'turn_12345678',
    })).toMatchObject({ expectedTurnId: 'turn_12345678' });

    expect(() => normalizeAgentRuntimeConversationContinueRequest({
      ...base, expectedRevision: 0, prompt: '계속해줘.',
    })).toThrow();
    expect(() => normalizeAgentRuntimeConversationSteerRequest({
      ...base, expectedTurnId: 'provider/raw', prompt: '계속해줘.',
    })).toThrow();
  });

  test('separates reversible archive mutations from confirmed permanent deletion', () => {
    expect(normalizeAgentRuntimeConversationMutationRequest(base)).toEqual(base);
    expect(normalizeAgentRuntimeConversationDeleteRequest({
      ...base,
      confirmPermanentDeletion: true,
    }).confirmPermanentDeletion).toBe(true);
    expect(() => normalizeAgentRuntimeConversationDeleteRequest({
      ...base,
      confirmPermanentDeletion: false,
    })).toThrow();
  });

  test('reads history only through an exact revision-fenced public request', () => {
    const history = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: base.conversationId,
      expectedRevision: base.expectedRevision,
    } as const;
    expect(normalizeAgentRuntimeConversationHistoryRequest(history)).toEqual(history);
    for (const invalid of [
      { ...history, expectedRevision: 0 },
      { ...history, providerThreadId: 'thread_provider_12345678' },
      { ...history, cwd: '/private/project' },
      { ...history, includeRawItems: true },
    ]) {
      expect(() => normalizeAgentRuntimeConversationHistoryRequest(invalid)).toThrow();
    }
  });

  test('accepts only path-free public turn events with a monotonic cursor', () => {
    const event = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: base.conversationId,
      seq: 7,
      revision: 4,
      type: 'conversation.turn.completed',
      turnId: 'turn_12345678',
      createdAt: '2026-09-05T00:00:00.000Z',
    } as const;
    expect(normalizeAgentRuntimeConversationEvent(event)).toEqual(event);
    expect(normalizeAgentRuntimeConversationEvent({
      ...event,
      type: 'conversation.turn.unknown',
      turnId: null,
    })).toMatchObject({ type: 'conversation.turn.unknown', turnId: null });
    expect(normalizeAgentRuntimeConversationEvent({
      ...event,
      type: 'conversation.progress',
      payload: { summary: '작업 계획을 갱신했습니다. (2/4)', phase: 'planning' },
    })).toMatchObject({
      type: 'conversation.progress',
      payload: { phase: 'planning' },
    });
    expect(normalizeAgentRuntimeConversationEvent({
      ...event,
      type: 'conversation.artifact.summary',
      payload: { kind: 'test', label: '검증', summary: '회귀 테스트를 통과했습니다.' },
    })).toMatchObject({ type: 'conversation.artifact.summary' });
    for (const invalid of [
      { ...event, seq: 0 },
      { ...event, turnId: null },
      { ...event, providerTurnId: 'provider_turn_12345678' },
      { ...event, cwd: '/private/project' },
      { ...event, type: 'conversation.raw.stdout' },
      { ...event, type: 'conversation.progress', payload: { summary: '진행', phase: null, rawOutput: 'secret' } },
    ]) {
      expect(() => normalizeAgentRuntimeConversationEvent(invalid)).toThrow();
    }
    expect(normalizeAgentRuntimeConversationEventsRequest({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: base.conversationId,
      after: 7,
    })).toMatchObject({ conversationId: base.conversationId, after: 7 });
    expect(() => normalizeAgentRuntimeConversationEventsRequest({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: base.conversationId,
      after: -1,
    })).toThrow();
  });

  test('publishes only opaque local ids and rejects provider ids, paths, transcripts, and extras', () => {
    const summary = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: 'conversation_12345678',
      targetId: 'target_12345678',
      projectLabel: 'AgentsToZ',
      adapterId: 'codex',
      modelId: 'gpt-5.6-sol',
      state: 'running',
      activeTurnId: 'turn_12345678',
      revision: 4,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:01:00.000Z',
    } as const;
    expect(normalizeAgentRuntimeConversationSummary(summary)).toEqual(summary);

    for (const forbidden of [
      { ...summary, providerThreadId: 'thr_123' },
      { ...summary, providerTurnId: 'turn_provider' },
      { ...summary, cwd: '/private/project' },
      { ...summary, transcript: [{ role: 'user', text: 'secret' }] },
      { ...summary, token: 'secret' },
      { ...summary, state: 'idle', activeTurnId: 'turn_12345678' },
      { ...summary, state: 'running', activeTurnId: null },
      { ...summary, updatedAt: '2026-09-04T23:59:59.000Z' },
    ]) {
      expect(() => normalizeAgentRuntimeConversationSummary(forbidden)).toThrow();
    }
  });
});
