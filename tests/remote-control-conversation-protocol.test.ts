import { describe, expect, test } from 'bun:test';

import {
  REMOTE_CONTROL_CONVERSATION_EVENT_SUMMARY_BYTES,
  REMOTE_CONTROL_CONVERSATION_HISTORY_TEXT_BYTES,
  REMOTE_CONTROL_CONVERSATION_LAN_ALLOWED,
  REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES,
  REMOTE_CONTROL_CONVERSATION_SCOPE,
  REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID,
  assertRemoteControlConversationResultMatchesRequest,
  normalizeRemoteControlConversationRequest,
  normalizeRemoteControlConversationResult,
  normalizeRemoteControlConversationSummary,
  parseRemoteControlConversationJson,
  projectRemoteControlConversationEvent,
  projectRemoteControlConversationSummary,
  serializeRemoteControlConversationMessage,
} from '../src/remoteControlConversationProtocol';
import {
  AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
} from '../src/agentRuntimeConversationProtocol';
import { REMOTE_CONTROL_TASK_TRANSPORT_VERSION } from '../src/remoteControlTaskProtocol';

const sessionToken = 's'.repeat(43);
const controlId = 'c'.repeat(43);
const operationId = 'operation_12345678';

function request(operation: string, payload: Record<string, unknown>) {
  return {
    type: 'conversations.request',
    protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
    conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    sessionToken,
    operationId,
    operation,
    payload,
  };
}

const localRunning = {
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

describe('remote persistent conversation protocol', () => {
  test('uses a separate E2EE-only scope and explicit retained-history consent', () => {
    expect(REMOTE_CONTROL_CONVERSATION_SCOPE).toBe('conversations-v1');
    expect(REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID).toBe('codex');
    expect(REMOTE_CONTROL_CONVERSATION_LAN_ALLOWED).toBe(false);
    const normalized = normalizeRemoteControlConversationRequest(request(
      'conversations.start',
      {
        controlId,
        adapterId: 'codex',
        modelId: 'gpt-5.6-sol',
        requestId: 'request_12345678',
        historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
        prompt: '현재 변경을 검토해줘.',
      },
    ));
    expect(normalized.operation).toBe('conversations.start');
    expect(() => normalizeRemoteControlConversationRequest(request(
      'conversations.start',
      {
        controlId,
        adapterId: 'codex',
        modelId: 'gpt-5.6-sol',
        requestId: 'request_12345678',
        historyRetentionConsent: 'implicit',
        prompt: '현재 변경을 검토해줘.',
      },
    ))).toThrow();
  });

  test('never accepts local target, path, process, provider, or dangerous fields', () => {
    const base = request('conversations.list', { archivedOnly: false, cursor: null });
    for (const [key, value] of [
      ['targetId', 'target_12345678'],
      ['cwd', '/private/project'],
      ['providerThreadId', 'thread_12345678'],
      ['executionMode', 'dangerously-bypass-approvals-and-sandbox'],
      ['pid', 123],
    ] as const) {
      expect(() => normalizeRemoteControlConversationRequest({
        ...base,
        payload: { ...base.payload, [key]: value },
      })).toThrow();
    }
  });

  test('projects only session control identity and semantic conversation state', () => {
    const remote = projectRemoteControlConversationSummary(localRunning, controlId);
    expect(remote).toEqual({
      conversationId: localRunning.conversationId,
      controlId,
      projectLabel: 'AgentsToZ',
      adapterId: 'codex',
      modelId: 'gpt-5.6-sol',
      state: 'running',
      activeTurnId: 'turn_12345678',
      revision: 3,
      createdAt: localRunning.createdAt,
      updatedAt: localRunning.updatedAt,
    });
    expect(JSON.stringify(remote)).not.toContain('target_12345678');
    expect(() => normalizeRemoteControlConversationSummary({
      ...remote,
      state: 'idle',
    })).toThrow();
    expect(() => normalizeRemoteControlConversationSummary({
      ...remote,
      folderPath: '/private/project',
    })).toThrow();
    expect(() => normalizeRemoteControlConversationSummary({
      ...remote,
      updatedAt: '2026-09-04T23:59:59.000Z',
    })).toThrow();
  });

  test('projects monotonic path-free turn events without provider details', () => {
    expect(projectRemoteControlConversationEvent({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: localRunning.conversationId,
      seq: 5,
      revision: 3,
      type: 'conversation.turn.started',
      turnId: 'turn_12345678',
      createdAt: localRunning.updatedAt,
    })).toEqual({
      conversationId: localRunning.conversationId,
      seq: 5,
      revision: 3,
      type: 'conversation.turn.started',
      turnId: 'turn_12345678',
      createdAt: localRunning.updatedAt,
    });
    const semantic = projectRemoteControlConversationEvent({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: localRunning.conversationId,
      seq: 6,
      revision: 3,
      type: 'conversation.artifact.summary',
      turnId: 'turn_12345678',
      payload: {
        kind: 'diff',
        label: '변경 사항',
        summary: '파일 변경 2건을 처리했습니다.',
      },
      createdAt: localRunning.updatedAt,
    });
    expect(semantic).toMatchObject({
      type: 'conversation.artifact.summary',
      payload: { kind: 'diff', label: '변경 사항' },
    });
    expect(JSON.stringify(semantic)).not.toContain('provider');

    const reversedTimeline = {
      type: 'conversations.result',
      protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
      conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      operationId,
      operation: 'conversations.events',
      ok: true,
      result: {
        conversationId: localRunning.conversationId,
        after: 0,
        nextCursor: 2,
        events: [
          {
            conversationId: localRunning.conversationId,
            seq: 1,
            revision: 3,
            type: 'conversation.turn.started',
            turnId: 'turn_12345678',
            createdAt: '2026-09-05T00:00:02.000Z',
          },
          {
            conversationId: localRunning.conversationId,
            seq: 2,
            revision: 3,
            type: 'conversation.turn.completed',
            turnId: 'turn_12345678',
            createdAt: '2026-09-05T00:00:01.000Z',
          },
        ],
      },
    } as const;
    expect(() => normalizeRemoteControlConversationResult(reversedTimeline)).toThrow();

    const longKorean = projectRemoteControlConversationEvent({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: localRunning.conversationId,
      seq: 7,
      revision: 3,
      type: 'conversation.progress',
      turnId: 'turn_12345678',
      payload: { summary: '진행'.repeat(400), phase: '검증' },
      createdAt: localRunning.updatedAt,
    });
    expect(longKorean.type).toBe('conversation.progress');
    if (longKorean.type === 'conversation.progress') {
      const encoded = new TextEncoder().encode(longKorean.payload.summary);
      expect(encoded.byteLength).toBeLessThanOrEqual(REMOTE_CONTROL_CONVERSATION_EVENT_SUMMARY_BYTES);
      expect(new TextDecoder('utf-8', { fatal: true }).decode(encoded)).toBe(longKorean.payload.summary);
    }
  });

  test('correlates operation, target control, model, conversation, revision, and cursor', () => {
    const start = request('conversations.start', {
      controlId,
      adapterId: 'codex',
      modelId: 'gpt-5.6-sol',
      requestId: 'request_12345678',
      historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
      prompt: '검토해줘.',
    });
    const result = {
      type: 'conversations.result',
      protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
      conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      operationId,
      operation: 'conversations.start',
      ok: true,
      result: {
        duplicate: false,
        conversation: projectRemoteControlConversationSummary(localRunning, controlId),
      },
    };
    expect(assertRemoteControlConversationResultMatchesRequest(start, result).ok).toBe(true);
    expect(() => assertRemoteControlConversationResultMatchesRequest(start, {
      ...result,
      result: {
        ...result.result,
        conversation: { ...result.result.conversation, controlId: 'x'.repeat(43) },
      },
    })).toThrow();
    expect(() => assertRemoteControlConversationResultMatchesRequest(start, {
      ...result,
      operationId: 'operation_87654321',
    })).toThrow();
  });

  test('bounds and validates paged history inside the relay plaintext ceiling', () => {
    const historyResult = {
      type: 'conversations.result',
      protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
      conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      operationId,
      operation: 'conversations.history',
      ok: true,
      result: {
        conversationId: localRunning.conversationId,
        revision: 3,
        cursor: null,
        nextCursor: 'history_12345678_1',
        truncated: false,
        filtered: true,
        messages: [{
          messageId: 'message_12345678',
          role: 'assistant',
          phase: 'final_answer',
          text: '완료했습니다.',
        }],
      },
    } as const;
    expect(normalizeRemoteControlConversationResult(historyResult).ok).toBe(true);
    const serialized = serializeRemoteControlConversationMessage(historyResult);
    expect(new TextEncoder().encode(serialized).byteLength)
      .toBeLessThanOrEqual(REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES);
    expect(parseRemoteControlConversationJson(serialized))
      .toEqual(normalizeRemoteControlConversationResult(historyResult));
    expect(() => normalizeRemoteControlConversationResult({
      ...historyResult,
      result: {
        ...historyResult.result,
        messages: [{
          ...historyResult.result.messages[0],
          text: '가'.repeat(REMOTE_CONTROL_CONVERSATION_HISTORY_TEXT_BYTES),
        }],
      },
    })).toThrow();
  });

  test('rejects lifecycle results that contradict the requested transition', () => {
    const archive = request('conversations.archive', {
      conversationId: localRunning.conversationId,
      expectedRevision: 3,
      requestId: 'request_12345678',
    });
    const result = {
      type: 'conversations.result',
      protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
      conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      operationId,
      operation: 'conversations.archive',
      ok: true,
      result: {
        conversation: {
          ...projectRemoteControlConversationSummary(localRunning, controlId),
          state: 'archived',
          activeTurnId: null,
          revision: 4,
        },
      },
    } as const;
    expect(assertRemoteControlConversationResultMatchesRequest(archive, result).ok).toBe(true);
    expect(() => assertRemoteControlConversationResultMatchesRequest(archive, {
      ...result,
      result: {
        conversation: { ...result.result.conversation, state: 'idle' },
      },
    })).toThrow();
    expect(() => assertRemoteControlConversationResultMatchesRequest(archive, {
      ...result,
      result: {
        conversation: { ...result.result.conversation, revision: 2 },
      },
    })).toThrow();
  });
});
