import { describe, expect, test } from 'bun:test';

import type { AgentRuntimeHttpService } from '../src/agentRuntimeHttp';
import { AGENT_RUNTIME_PROTOCOL_VERSION, type AgentTaskEvent } from '../src/agentRuntimeProtocol';
import type { RemoteControlTaskTargetBinding } from '../src/remoteControlCore';
import {
  RemoteControlTaskGateway,
  type RemoteControlTaskTargetAuthority,
} from '../src/remoteControlTaskGateway';
import {
  REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
  type RemoteControlTaskRequest,
} from '../src/remoteControlTaskProtocol';

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

const task = (overrides: Record<string, unknown> = {}) => ({
  taskId: 'task_12345678',
  targetId: runtimeTargetId,
  projectLabel: 'AgentsToZ',
  adapterId: 'codex' as const,
  modelId: 'gpt-5.6-codex',
  executionMode: 'workspace-write' as const,
  status: 'running' as const,
  lastSeq: 2,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

function request<TOperation extends RemoteControlTaskRequest['operation']>(
  operation: TOperation,
  payload: Extract<RemoteControlTaskRequest, { operation: TOperation }>['payload'],
): Extract<RemoteControlTaskRequest, { operation: TOperation }> {
  return {
    type: 'tasks.request',
    protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
    taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    sessionToken,
    operationId: `operation_${operation.replace('.', '_')}_12345678`,
    operation,
    payload,
  } as Extract<RemoteControlTaskRequest, { operation: TOperation }>;
}

function fixture(options: {
  bindings?: RemoteControlTaskTargetBinding[];
  authorities?: RemoteControlTaskTargetAuthority[];
  tasks?: ReturnType<typeof task>[];
  models?: Array<{ modelId: string; label: string; isDefault: boolean }>;
  events?: AgentTaskEvent[];
} = {}) {
  const starts: unknown[] = [];
  const cancels: unknown[] = [];
  const tasks = options.tasks ?? [task()];
  const models = options.models ?? [
    { modelId: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', isDefault: true },
  ];
  const service: AgentRuntimeHttpService = {
    capabilities: () => ({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      adapters: [{
        adapterId: 'codex',
        label: 'Codex',
        availability: 'available',
        models,
        features: {
          structuredProgress: true,
          questions: false,
          approvals: false,
          cancellation: true,
        },
      }],
      limits: { maxPromptBytes: 32 * 1024, maxConcurrentTasks: 4 },
    }),
    listTasks: () => ({ protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, tasks }),
    readEvents: (_taskId, after) => {
      const events = options.events?.filter(event => event.seq > after) ?? [
        {
          protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
          taskId: 'task_12345678',
          seq: after + 1,
          occurredAt: now,
          type: 'task.progress' as const,
          payload: { summary: '테스트 실행 중', phase: 'test' },
        },
        {
          protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
          taskId: 'task_12345678',
          seq: after + 2,
          occurredAt: now,
          type: 'task.artifact.summary' as const,
          payload: { kind: 'test' as const, label: '검증', summary: '통과' },
        },
      ];
      return {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: 'task_12345678',
      after,
      nextCursor: events.at(-1)?.seq ?? after,
      events,
    };
    },
    startTask: start => {
      starts.push(start);
      return { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, duplicate: false, task: task() };
    },
    cancelTask: (taskId, cancel) => {
      cancels.push({ taskId, cancel });
      return {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        task: task({ status: 'cancelled', lastSeq: 3 }),
      };
    },
  };
  const gateway = new RemoteControlTaskGateway({
    service,
    resolveTargetAuthorities: async () => options.authorities ?? [{ controlId, runtimeTargetId }],
  });
  return { gateway, starts, cancels, bindings: options.bindings ?? [binding] };
}

describe('E2EE remote task gateway', () => {
  test('forces workspace-write and maps a session control ID to a local runtime ID', async () => {
    const { gateway, starts, bindings } = fixture();
    const result = await gateway.perform(request('tasks.start', {
      controlId,
      adapterId: 'codex',
      modelId: 'gpt-5.6-codex',
      requestId: 'runtime_request_12345678',
      prompt: '테스트를 실행해줘.',
    }), bindings);
    expect(result).toMatchObject({
      ok: true,
      result: { task: { controlId, taskId: 'task_12345678' } },
    });
    expect(starts).toEqual([{
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'runtime_request_12345678',
      targetId: runtimeTargetId,
      adapterId: 'codex',
      modelId: 'gpt-5.6-codex',
      executionMode: 'workspace-write',
      prompt: '테스트를 실행해줘.',
    }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(runtimeTargetId);
    expect(serialized).not.toContain('/private/project-that-must-not-leak');
    expect(serialized).not.toContain(sessionToken);
  });

  test('fails closed when a control ID is stale or its authority join is ambiguous', async () => {
    const missing = fixture({ authorities: [] });
    const missingResult = await missing.gateway.perform(request('tasks.start', {
      controlId,
      adapterId: 'codex', modelId: 'gpt-5.6-codex',
      requestId: 'runtime_request_12345678', prompt: '작업해줘.',
    }), missing.bindings);
    expect(missingResult).toMatchObject({ ok: false, error: { code: 'REMOTE_CONTROL_TASK_TARGET_NOT_FOUND' } });
    expect(missing.starts).toHaveLength(0);

    const ambiguous = fixture({ authorities: [
      { controlId, runtimeTargetId },
      { controlId, runtimeTargetId: 'runtime_target_other_1234' },
    ] });
    const ambiguousResult = await ambiguous.gateway.perform(
      request('tasks.list', { cursor: null }),
      ambiguous.bindings,
    );
    expect(ambiguousResult).toMatchObject({
      ok: false,
      error: { code: 'REMOTE_CONTROL_TASK_TARGET_STATUS_UNKNOWN', retryable: true },
    });
  });

  test('filters tasks to current session targets and never projects dangerous history', async () => {
    const { gateway, bindings } = fixture({ tasks: [
      task(),
      task({ taskId: 'task_other_target', targetId: 'runtime_target_elsewhere' }),
      task({ taskId: 'task_dangerous', executionMode: 'dangerously-bypass-approvals-and-sandbox' }),
    ] });
    const result = await gateway.perform(request('tasks.list', { cursor: null }), bindings);
    // The dangerous task shares an otherwise visible target, so projection must
    // fail the page rather than silently laundering its execution mode.
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'REMOTE_CONTROL_TASK_FAILED' },
    });
  });

  test('paginates a pinned model catalog and rejects a stale catalog cursor', async () => {
    const models = Array.from({ length: 18 }, (_, index) => ({
      modelId: `gpt-5.6-model-${index}`,
      label: `Model ${index}`,
      isDefault: index === 0,
    }));
    const { gateway, bindings } = fixture({ models });
    const first = await gateway.perform(request('models.list', {
      adapterId: 'codex', catalogId: null, cursor: null,
    }), bindings);
    if (!first.ok || !('models' in first.result)) throw new Error('expected models result');
    expect(first.ok).toBe(true);
    expect(first.result.models).toHaveLength(16);
    expect(first.result.nextCursor).not.toBeNull();

    const next = await gateway.perform(request('models.list', {
      adapterId: 'codex', catalogId: first.result.catalogId, cursor: first.result.nextCursor,
    }), bindings);
    expect(next).toMatchObject({ ok: true, result: { models: [{ modelId: 'gpt-5.6-model-16' }, { modelId: 'gpt-5.6-model-17' }] } });

    const stale = await gateway.perform(request('models.list', {
      adapterId: 'codex', catalogId: 'catalog_stale_12345678', cursor: first.result.nextCursor,
    }), bindings);
    expect(stale).toMatchObject({ ok: false, error: { code: 'REMOTE_CONTROL_TASK_CATALOG_STALE' } });
  });

  test('authorizes cancellation and event reads through the current target snapshot', async () => {
    const { gateway, cancels, bindings } = fixture();
    const events = await gateway.perform(
      request('tasks.events', { taskId: 'task_12345678', after: 2 }),
      bindings,
    );
    expect(events).toMatchObject({
      ok: true,
      result: {
        taskId: 'task_12345678', after: 2, nextCursor: 4,
        events: [{ seq: 3, type: 'task.progress' }, { seq: 4, type: 'task.artifact.summary' }],
      },
    });
    const cancelled = await gateway.perform(request('tasks.cancel', {
      taskId: 'task_12345678', requestId: 'cancel_request_12345678',
    }), bindings);
    expect(cancelled).toMatchObject({ ok: true, result: { task: { status: 'cancelled', controlId } } });
    expect(cancels).toEqual([{
      taskId: 'task_12345678',
      cancel: { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, requestId: 'cancel_request_12345678' },
    }]);
  });

  test('packs large event pages below the E2EE message limit and continues from the returned cursor', async () => {
    const events: AgentTaskEvent[] = Array.from({ length: 3 }, (_, index) => ({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: 'task_12345678',
      seq: index + 1,
      occurredAt: now,
      type: 'task.progress',
      payload: { summary: String(index).repeat(3_500), phase: 'test' },
    }));
    const { gateway, bindings } = fixture({ events, tasks: [task({ lastSeq: 3 })] });
    const first = await gateway.perform(
      request('tasks.events', { taskId: 'task_12345678', after: 0 }),
      bindings,
    );
    if (!first.ok || !('events' in first.result)) throw new Error('expected events page');
    expect(first.result.events).toHaveLength(2);
    expect(first.result.nextCursor).toBe(2);
    expect(JSON.stringify(first).length).toBeLessThan(9_000);

    const next = await gateway.perform(
      request('tasks.events', { taskId: 'task_12345678', after: first.result.nextCursor }),
      bindings,
    );
    expect(next).toMatchObject({
      ok: true,
      result: { after: 2, nextCursor: 3, events: [{ seq: 3 }] },
    });
  });
});
