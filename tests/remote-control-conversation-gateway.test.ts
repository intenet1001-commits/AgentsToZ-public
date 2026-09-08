import { describe, expect, test } from 'bun:test';

import type { AgentRuntimeHttpService } from '../src/agentRuntimeHttp';
import {
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  type AgentRuntimeConversationSummary,
} from '../src/agentRuntimeConversationProtocol';
import { AgentRuntimeConversationServiceError } from '../src/agentRuntimeConversationService';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from '../src/agentRuntimeProtocol';
import type { RemoteControlTaskTargetBinding } from '../src/remoteControlCore';
import {
  RemoteControlConversationGateway,
} from '../src/remoteControlConversationGateway';
import type { RemoteControlTaskTargetAuthority } from '../src/remoteControlTaskGateway';
import {
  REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES,
  type RemoteControlConversationRequest,
} from '../src/remoteControlConversationProtocol';
import { REMOTE_CONTROL_TASK_TRANSPORT_VERSION } from '../src/remoteControlTaskProtocol';

const sessionToken = 'S'.repeat(43);
const controlId = 'C'.repeat(43);
const runtimeTargetId = 'runtime_target_12345678';
const now = '2026-09-05T00:00:00.000Z';

const binding: RemoteControlTaskTargetBinding = {
  controlId,
  target: {
    internalId: 'registered_project_12345678',
    name: 'AgentsToZ',
    port: null,
    kind: 'main',
    folderPath: '/private/project-that-must-not-leak',
    command: null,
    status: 'unknown',
    actions: ['agent.codex'],
  },
};

function conversation(overrides: Partial<AgentRuntimeConversationSummary> = {}): AgentRuntimeConversationSummary {
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversationId: 'conversation_12345678',
    targetId: runtimeTargetId,
    projectLabel: 'AgentsToZ',
    adapterId: 'codex',
    modelId: 'gpt-5.6-sol',
    state: 'running',
    activeTurnId: 'turn_12345678',
    revision: 2,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function request<TOperation extends RemoteControlConversationRequest['operation']>(
  operation: TOperation,
  payload: Extract<RemoteControlConversationRequest, { operation: TOperation }>['payload'],
): Extract<RemoteControlConversationRequest, { operation: TOperation }> {
  return {
    type: 'conversations.request',
    protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
    conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    sessionToken,
    operationId: `operation_${operation.replace('.', '_')}_12345678`,
    operation,
    payload,
  } as Extract<RemoteControlConversationRequest, { operation: TOperation }>;
}

function fixture(options: {
  conversations?: AgentRuntimeConversationSummary[];
  authorities?: RemoteControlTaskTargetAuthority[];
  historyText?: string;
  steerError?: AgentRuntimeConversationServiceError;
  conversationCapabilities?: AgentRuntimeHttpService['conversationCapabilities'];
} = {}) {
  const conversations = options.conversations ?? [conversation()];
  const starts: unknown[] = [];
  const continues: unknown[] = [];
  const historyCalls: unknown[] = [];
  const service: AgentRuntimeHttpService = {
    capabilities: () => ({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      adapters: [{
        adapterId: 'codex',
        label: 'Codex',
        availability: 'available',
        models: [
          { modelId: 'gpt-5.6-sol', label: 'SOL', isDefault: true },
          { modelId: 'gpt-5.6-terra', label: 'Terra', isDefault: false },
        ],
        features: {
          structuredProgress: true,
          questions: false,
          approvals: false,
          cancellation: true,
        },
      }, {
        adapterId: 'hermes',
        label: 'Hermes',
        availability: 'unavailable',
        models: [],
        features: {
          structuredProgress: false,
          questions: false,
          approvals: false,
          cancellation: false,
        },
      }],
      limits: { maxPromptBytes: 32_768, maxConcurrentTasks: 1 },
    }),
    listTasks: () => ({ protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, tasks: [] }),
    readEvents: () => ({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: 'task_12345678', after: 0, nextCursor: 0, events: [],
    }),
    startTask: () => { throw new Error('not used'); },
    cancelTask: () => { throw new Error('not used'); },
    conversations: {
      list: () => conversations,
      startCreate: async value => {
        starts.push(value);
        return { duplicate: false, accepted: true, conversation: conversation() };
      },
      startContinue: async value => {
        continues.push(value);
        return { duplicate: false, accepted: true, conversation: conversation({ revision: 3 }) };
      },
      readEvents: value => ({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        conversationId: value.conversationId,
        after: value.after,
        nextCursor: value.after + 2,
        events: [1, 2].map(offset => ({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          conversationId: value.conversationId,
          seq: value.after + offset,
          revision: 2,
          type: offset === 1 ? 'conversation.turn.started' : 'conversation.turn.completed',
          turnId: 'turn_12345678',
          createdAt: now,
        })),
      }),
      history: async value => {
        historyCalls.push(value);
        return {
          conversation: conversation({ state: 'idle', activeTurnId: null, revision: value.expectedRevision }),
          history: {
            status: 'idle',
            truncated: false,
            filtered: true,
            turns: [{
              turnId: 'turn_12345678',
              status: 'completed',
              startedAt: now,
              completedAt: now,
              messages: [{
                messageId: 'message_12345678',
                turnId: 'turn_12345678',
                role: 'assistant',
                phase: 'final_answer',
                text: options.historyText ?? '완료했습니다.',
              }],
            }],
          },
        };
      },
      steer: async () => {
        if (options.steerError) throw options.steerError;
        return conversation({ revision: 3 });
      },
      interrupt: async () => conversation({ state: 'idle', activeTurnId: null, revision: 3 }),
      setArchived: async (_value, archived) => conversation({
        state: archived ? 'archived' : 'idle', activeTurnId: null, revision: 3,
      }),
      delete: async () => ({ conversationId: 'conversation_12345678', deleted: true, duplicate: false }),
    },
  };
  if (options.conversationCapabilities) {
    service.conversationCapabilities = options.conversationCapabilities;
  }
  const authorities = options.authorities ?? [{ controlId, runtimeTargetId }];
  return {
    gateway: new RemoteControlConversationGateway({
      service,
      resolveTargetAuthorities: async () => authorities,
    }),
    starts,
    continues,
    historyCalls,
  };
}

describe('remote persistent conversation gateway', () => {
  test('uses the conversation-only catalog instead of writable task capability', async () => {
    const { gateway } = fixture({
      conversationCapabilities: () => ({
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        adapters: [{
          adapterId: 'codex',
          label: 'Codex · 읽기 전용',
          availability: 'available',
          models: [{ modelId: 'gpt-5.6-terra', label: 'Terra only', isDefault: true }],
          features: { structuredProgress: true, questions: true, approvals: false, cancellation: true },
        }],
        limits: { maxPromptBytes: 2048, maxConcurrentTasks: 1 },
      }),
    });
    const response = await gateway.perform(request('models.list', {
      catalogId: null,
      cursor: null,
    }), [binding]);
    expect(response).toMatchObject({
      ok: true,
      result: { models: [{ modelId: 'gpt-5.6-terra', label: 'Terra only' }] },
    });
  });

  test('projects Codex-only capability and maps a session control ID to the local target', async () => {
    const { gateway, starts } = fixture();
    const capabilities = await gateway.perform(request('capabilities', {}), [binding]);
    expect(capabilities.ok).toBe(true);
    if (!capabilities.ok) return;
    expect(capabilities.result).toMatchObject({
      adapters: [{ adapterId: 'codex' }],
      limits: { maxPromptBytes: 4096 },
    });

    const started = await gateway.perform(request('conversations.start', {
      controlId,
      adapterId: 'codex',
      modelId: 'gpt-5.6-sol',
      requestId: 'request_12345678',
      historyRetentionConsent: 'retain-provider-history-on-this-host',
      prompt: '검토해줘.',
    }), [binding]);
    expect(started.ok).toBe(true);
    expect(starts).toEqual([expect.objectContaining({
      targetId: runtimeTargetId,
      initialPrompt: '검토해줘.',
    })]);
    expect(JSON.stringify(started)).not.toContain('/private/project-that-must-not-leak');
    expect(JSON.stringify(started)).not.toContain(runtimeTargetId);
  });

  test('lists only conversations authorized by the current session bindings', async () => {
    const foreign = conversation({
      conversationId: 'conversation_87654321',
      targetId: 'runtime_target_87654321',
    });
    const archived = conversation({
      conversationId: 'conversation_archived_1234',
      state: 'archived', activeTurnId: null,
    });
    const { gateway } = fixture({ conversations: [conversation(), foreign, archived] });
    const current = await gateway.perform(request('conversations.list', {
      archivedOnly: false, cursor: null,
    }), [binding]);
    expect(current.ok).toBe(true);
    if (current.ok) expect(current.result).toMatchObject({
      archivedOnly: false,
      conversations: [{ conversationId: 'conversation_12345678', controlId }],
    });
    const archive = await gateway.perform(request('conversations.list', {
      archivedOnly: true, cursor: null,
    }), [binding]);
    expect(archive.ok).toBe(true);
    if (archive.ok) expect(archive.result).toMatchObject({
      archivedOnly: true,
      conversations: [{ conversationId: 'conversation_archived_1234', controlId }],
    });
  });

  test('rejects conversation operations that are not joined to a fresh target authority', async () => {
    const { gateway, continues } = fixture({ authorities: [] });
    const result = await gateway.perform(request('conversations.continue', {
      conversationId: 'conversation_12345678',
      expectedRevision: 2,
      requestId: 'request_12345678',
      prompt: '계속해줘.',
    }), [binding]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'REMOTE_CONTROL_CONVERSATION_NOT_FOUND', retryable: false },
    });
    expect(continues).toHaveLength(0);
  });

  test('pages semantic events and bounded redacted history below the E2EE ceiling', async () => {
    // Valid for the local 16 KiB history contract, but large enough to exercise
    // the tighter 5.5 KiB remote redaction boundary.
    const { gateway, historyCalls } = fixture({ historyText: '가'.repeat(5_000) });
    const events = await gateway.perform(request('conversations.events', {
      conversationId: 'conversation_12345678', after: 5,
    }), [binding]);
    expect(events).toMatchObject({
      ok: true,
      result: { conversationId: 'conversation_12345678', after: 5, nextCursor: 7 },
    });

    const history = await gateway.perform(request('conversations.history', {
      conversationId: 'conversation_12345678', expectedRevision: 2, cursor: null,
    }), [binding]);
    expect(history.ok).toBe(true);
    expect(historyCalls).toHaveLength(1);
    expect(new TextEncoder().encode(JSON.stringify(history)).byteLength)
      .toBeLessThanOrEqual(REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES);
    if (history.ok) expect(history.result).toMatchObject({
      conversationId: 'conversation_12345678',
      revision: 2,
      truncated: true,
      filtered: true,
    });
    expect(JSON.stringify(history)).not.toContain('turn_12345678');
  });

  test('fails stale pagination and ambiguous authority joins closed', async () => {
    const { gateway } = fixture();
    const stale = await gateway.perform(request('conversations.list', {
      archivedOnly: false,
      cursor: 'conversations_0000000000000000_1',
    }), [binding]);
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'REMOTE_CONTROL_CONVERSATION_CURSOR_STALE', retryable: true },
    });

    const duplicateAuthority = fixture({
      authorities: [
        { controlId, runtimeTargetId },
        { controlId, runtimeTargetId: 'runtime_target_87654321' },
      ],
    });
    const denied = await duplicateAuthority.gateway.perform(request('conversations.list', {
      archivedOnly: false, cursor: null,
    }), [binding]);
    expect(denied).toMatchObject({
      ok: false,
      error: { code: 'REMOTE_CONTROL_CONVERSATION_TARGET_STATUS_UNKNOWN' },
    });
  });

  test('marks an uncertain live-control outcome non-retryable on the mobile boundary', async () => {
    const { gateway } = fixture({
      steerError: new AgentRuntimeConversationServiceError(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
        'Codex 추가 지시의 반영 여부를 확인할 수 없습니다.',
      ),
    });
    const result = await gateway.perform(request('conversations.steer', {
      conversationId: 'conversation_12345678',
      expectedRevision: 2,
      expectedTurnId: 'turn_12345678',
      requestId: 'request_steer_uncertain_12345678',
      prompt: '한 번만 보내야 하는 추가 지시',
    }), [binding]);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
        retryable: false,
      },
    });
  });
});
