import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  normalizeAgentRuntimeConversationEventsResponse,
  normalizeAgentRuntimeConversationHistoryResponse,
  normalizeAgentRuntimeConversationListResponse,
  normalizeAgentRuntimeConversationTurnAcceptedResponse,
} from '../src/agentRuntimeConversationApiContract';
import {
  AGENT_RUNTIME_CONVERSATION_EVENT_READ_LIMIT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
} from '../src/agentRuntimeConversationProtocol';

const conversation = {
  protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  conversationId: 'conversation_12345678',
  targetId: 'target_12345678',
  projectLabel: 'AgentsToZ',
  adapterId: 'codex',
  modelId: 'gpt-5.6-sol',
  state: 'running',
  activeTurnId: 'turn_12345678',
  revision: 3,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:01.000Z',
} as const;

const apiContractSource = readFileSync(
  new URL('../src/agentRuntimeConversationApiContract.ts', import.meta.url),
  'utf8',
);
const historyContractSource = readFileSync(
  new URL('../src/agentRuntimeConversationHistory.ts', import.meta.url),
  'utf8',
);

describe('persistent conversation API contract', () => {
  test('keeps the renderer contract free of the server-side Codex process module', () => {
    expect(apiContractSource).toContain("from './agentRuntimeConversationHistory'");
    expect(apiContractSource).not.toContain("from './codexAgentRuntime'");
    expect(historyContractSource).not.toMatch(/from ['"](?:node:|bun:)/);
  });

  test('normalizes bounded list and live-ready accepted responses', () => {
    expect(normalizeAgentRuntimeConversationListResponse({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversations: [conversation],
    }).conversations).toHaveLength(1);
    expect(() => normalizeAgentRuntimeConversationListResponse({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversations: [conversation, conversation],
    })).toThrow();
    expect(normalizeAgentRuntimeConversationTurnAcceptedResponse({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      duplicate: false,
      accepted: true,
      conversation,
    })).toMatchObject({ accepted: true, conversation: { state: 'running' } });
    expect(() => normalizeAgentRuntimeConversationTurnAcceptedResponse({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      duplicate: false,
      accepted: true,
      conversation: { ...conversation, state: 'idle', activeTurnId: null },
    })).toThrow();
  });

  test('enforces strictly increasing path-free event cursors', () => {
    const event = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: conversation.conversationId,
      seq: 9,
      revision: 3,
      type: 'conversation.turn.started',
      turnId: 'turn_12345678',
      createdAt: '2026-09-05T00:00:01.000Z',
    } as const;
    expect(normalizeAgentRuntimeConversationEventsResponse({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: conversation.conversationId,
      after: 8,
      nextCursor: 9,
      events: [event],
    }).nextCursor).toBe(9);
    for (const invalid of [
      { after: 9, nextCursor: 9, events: [event] },
      { after: 8, nextCursor: 10, events: [event] },
      { after: 8, nextCursor: 9, events: [{ ...event, cwd: '/private/project' }] },
      {
        after: 8,
        nextCursor: 10,
        events: [
          { ...event, createdAt: '2026-09-05T00:00:02.000Z' },
          { ...event, seq: 10, createdAt: '2026-09-05T00:00:01.000Z' },
        ],
      },
    ]) {
      expect(() => normalizeAgentRuntimeConversationEventsResponse({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        conversationId: conversation.conversationId,
        ...invalid,
      })).toThrow();
    }
    expect(() => normalizeAgentRuntimeConversationEventsResponse({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: conversation.conversationId,
      after: 0,
      nextCursor: AGENT_RUNTIME_CONVERSATION_EVENT_READ_LIMIT,
      events: Array.from({ length: AGENT_RUNTIME_CONVERSATION_EVENT_READ_LIMIT + 1 }, (_, index) => ({
        ...event,
        seq: index + 1,
      })),
    })).toThrow();
  });

  test('accepts only bounded semantic chat history', () => {
    const response = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversation: { ...conversation, state: 'idle', activeTurnId: null, revision: 4 },
      history: {
        status: 'idle',
        truncated: false,
        filtered: true,
        turns: [{
          turnId: 'turn_public_12345678',
          status: 'completed',
          startedAt: '2026-09-05T00:00:00.000Z',
          completedAt: '2026-09-05T00:00:01.000Z',
          messages: [{
            messageId: 'message_public_12345678',
            turnId: 'turn_public_12345678',
            role: 'assistant',
            phase: 'final_answer',
            text: '완료했습니다.',
          }],
        }],
      },
    } as const;
    expect(normalizeAgentRuntimeConversationHistoryResponse(response))
      .toMatchObject({ history: { status: 'idle', filtered: true } });
    expect(() => normalizeAgentRuntimeConversationHistoryResponse({
      ...response,
      history: {
        ...response.history,
        providerThreadId: 'provider_thread_12345678',
      },
    })).toThrow();
    expect(() => normalizeAgentRuntimeConversationHistoryResponse({
      ...response,
      history: {
        ...response.history,
        turns: [{
          ...response.history.turns[0],
          messages: [{
            ...response.history.turns[0].messages[0],
            text: '가'.repeat(20_000),
          }],
        }],
      },
    })).toThrow();
    expect(() => normalizeAgentRuntimeConversationHistoryResponse({
      ...response,
      history: {
        ...response.history,
        turns: [response.history.turns[0], {
          ...response.history.turns[0],
          turnId: 'turn_public_87654321',
          messages: [{
            ...response.history.turns[0].messages[0],
            turnId: 'turn_public_87654321',
          }],
        }],
      },
    })).toThrow();
    expect(() => normalizeAgentRuntimeConversationHistoryResponse({
      ...response,
      history: {
        ...response.history,
        turns: [response.history.turns[0], response.history.turns[0]],
      },
    })).toThrow();
  });
});
