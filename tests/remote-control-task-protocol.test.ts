import { describe, expect, test } from 'bun:test';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from '../src/agentRuntimeProtocol';
import {
  REMOTE_CONTROL_TASK_MAX_PROMPT_BYTES,
  REMOTE_CONTROL_TASK_MAX_SERIALIZED_BYTES,
  REMOTE_CONTROL_TASK_LAN_ALLOWED,
  REMOTE_CONTROL_TASK_OPERATIONS,
  REMOTE_CONTROL_TASK_SCOPE,
  REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
  RemoteControlTaskProtocolError,
  assertRemoteControlTaskResultMatchesRequest,
  assertRemoteControlTaskSafe,
  assertRemoteControlTaskSerializedSize,
  normalizeRemoteControlTaskRequest,
  normalizeRemoteControlTaskResult,
  parseRemoteControlTaskJson,
  projectRemoteControlTaskEvent,
  projectRemoteControlTaskSummary,
  remoteControlTaskUtf8ByteLength,
  serializeRemoteControlTaskMessage,
} from '../src/remoteControlTaskProtocol';

const sessionToken = 'S'.repeat(43);
const controlId = 'C'.repeat(43);
const requestEnvelope = {
  type: 'tasks.request',
  protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
  taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
  sessionToken,
  operationId: 'operation_12345678',
} as const;
const resultEnvelope = {
  type: 'tasks.result',
  protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
  taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
  operationId: 'operation_12345678',
} as const;
const task = {
  taskId: 'task_12345678',
  controlId,
  projectLabel: 'AgentsToZ',
  adapterId: 'codex',
  modelId: 'gpt-5.6-codex',
  status: 'running',
  lastSeq: 2,
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:01.000Z',
} as const;

const startRequest = {
  ...requestEnvelope,
  operation: 'tasks.start',
  payload: {
    controlId,
    adapterId: 'codex',
    modelId: 'gpt-5.6-codex',
    requestId: 'runtime_request_12345678',
    prompt: '이 프로젝트의 테스트를 실행하고 결과를 요약해줘.',
  },
} as const;

const startResult = {
  ...resultEnvelope,
  ok: true,
  result: { duplicate: false, task },
} as const;

describe('remote-control v8 task request envelope', () => {
  test('is an explicit tasks-v1 scope over task-v2 without changing local-v7', () => {
    expect(REMOTE_CONTROL_TASK_TRANSPORT_VERSION).toBe('agentstoz-local-v8');
    expect(REMOTE_CONTROL_TASK_SCOPE).toBe('tasks-v1');
    expect(REMOTE_CONTROL_TASK_LAN_ALLOWED).toBe(false);
    expect(AGENT_RUNTIME_PROTOCOL_VERSION).toBe('agentstoz-tasks-v2');
    expect(REMOTE_CONTROL_TASK_OPERATIONS).toEqual([
      'capabilities', 'models.list', 'tasks.start', 'tasks.cancel', 'tasks.list', 'tasks.events',
    ]);
  });

  test('accepts a 43-char session bearer only at the request top level', () => {
    expect(normalizeRemoteControlTaskRequest(startRequest)).toEqual(startRequest);
    expect(Object.keys(normalizeRemoteControlTaskRequest(startRequest)).sort()).toEqual([
      'operation', 'operationId', 'payload', 'protocolVersion', 'sessionToken', 'taskProtocolVersion', 'type',
    ]);
    for (const badToken of [null, '', 'S'.repeat(42), 'S'.repeat(44), `${'S'.repeat(42)}=`]) {
      expect(() => normalizeRemoteControlTaskRequest({ ...startRequest, sessionToken: badToken }))
        .toThrow(RemoteControlTaskProtocolError);
    }
    expect(() => normalizeRemoteControlTaskRequest({
      ...startRequest,
      payload: { ...startRequest.payload, sessionToken },
    })).toThrow(RemoteControlTaskProtocolError);
    expect(() => normalizeRemoteControlTaskResult({
      ...startResult,
      sessionToken,
    })).toThrow(RemoteControlTaskProtocolError);
    expect(JSON.stringify(normalizeRemoteControlTaskResult(startResult))).not.toContain(sessionToken);
  });

  test('puts only exact operation-specific fields inside payload', () => {
    const requests = [
      { ...requestEnvelope, operation: 'capabilities', payload: {} },
      {
        ...requestEnvelope,
        operation: 'models.list',
        payload: { adapterId: 'codex', catalogId: null, cursor: null },
      },
      startRequest,
      {
        ...requestEnvelope,
        operation: 'tasks.cancel',
        payload: { taskId: task.taskId, requestId: 'cancel_request_12345678' },
      },
      { ...requestEnvelope, operation: 'tasks.list', payload: { cursor: null } },
      {
        ...requestEnvelope,
        operation: 'tasks.events',
        payload: { taskId: task.taskId, after: 2 },
      },
    ] as const;
    for (const request of requests) {
      expect(normalizeRemoteControlTaskRequest(request)).toEqual(request);
    }
    expect(Object.keys(normalizeRemoteControlTaskRequest(startRequest).payload).sort()).toEqual([
      'adapterId', 'controlId', 'modelId', 'prompt', 'requestId',
    ]);
  });

  test('separates transport retry correlation from runtime idempotency', () => {
    const retry = { ...startRequest };
    const normalizedRetry = normalizeRemoteControlTaskRequest(retry);
    expect(normalizedRetry.operationId).toBe(startRequest.operationId);
    if (normalizedRetry.operation !== 'tasks.start') throw new Error('start request changed operation');
    expect(normalizedRetry.payload.requestId).toBe(startRequest.payload.requestId);
    expect(assertRemoteControlTaskResultMatchesRequest(retry, startResult)).toEqual(startResult);
    expect(() => assertRemoteControlTaskResultMatchesRequest(
      { ...retry, operationId: 'operation_retry_99999999' },
      startResult,
    )).toThrow(RemoteControlTaskProtocolError);
  });

  test('rejects target, local execution, process, and management-capability fields', () => {
    for (const [key, value] of [
      ['targetId', 'project_12345678'],
      ['executionMode', 'workspace-write'],
      ['dangerous', true],
      ['path', '/private/project'],
      ['cwd', '/private/project'],
      ['command', 'arbitrary shell'],
      ['env', { TOKEN: 'secret' }],
      ['pid', 1234],
      ['capability', 'local-management-secret'],
      ['X-AgentsToZ-Agent-Runtime-Capability', 'local-management-secret'],
    ] as const) {
      expect(() => normalizeRemoteControlTaskRequest({
        ...startRequest,
        payload: { ...startRequest.payload, [key]: value },
      })).toThrow(RemoteControlTaskProtocolError);
    }
    expect(() => normalizeRemoteControlTaskRequest({
      ...startRequest,
      payload: { ...startRequest.payload, modelId: 'dangerously-bypass-approvals-and-sandbox' },
    })).toThrow(RemoteControlTaskProtocolError);
  });

  test('bounds remote prompts by UTF-8 bytes at 4096 bytes', () => {
    expect(normalizeRemoteControlTaskRequest({
      ...startRequest,
      payload: { ...startRequest.payload, prompt: 'a'.repeat(REMOTE_CONTROL_TASK_MAX_PROMPT_BYTES) },
    })).toMatchObject({ operation: 'tasks.start' });
    expect(() => normalizeRemoteControlTaskRequest({
      ...startRequest,
      payload: { ...startRequest.payload, prompt: 'a'.repeat(REMOTE_CONTROL_TASK_MAX_PROMPT_BYTES + 1) },
    })).toThrow(RemoteControlTaskProtocolError);
    expect(() => normalizeRemoteControlTaskRequest({
      ...startRequest,
      payload: { ...startRequest.payload, prompt: '한'.repeat(1_366) },
    })).toThrow(RemoteControlTaskProtocolError);
  });
});

describe('bounded catalogs, inboxes, and result correlation', () => {
  test('paginates models through catalogId/cursor/nextCursor', () => {
    const firstRequest = {
      ...requestEnvelope,
      operation: 'models.list',
      payload: { adapterId: 'codex', catalogId: null, cursor: null },
    } as const;
    const firstResult = {
      ...resultEnvelope,
      ok: true,
      result: {
        adapterId: 'codex',
        catalogId: 'catalog_12345678',
        cursor: null,
        nextCursor: 'model_cursor_00000001',
        models: [{ modelId: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', isDefault: true }],
      },
    } as const;
    expect(assertRemoteControlTaskResultMatchesRequest(firstRequest, firstResult))
      .toEqual(normalizeRemoteControlTaskResult(firstResult));

    const nextRequest = {
      ...firstRequest,
      operationId: 'operation_models_page2',
      payload: {
        adapterId: 'codex',
        catalogId: firstResult.result.catalogId,
        cursor: firstResult.result.nextCursor,
      },
    } as const;
    const nextResult = {
      ...firstResult,
      operationId: nextRequest.operationId,
      result: {
        ...firstResult.result,
        cursor: nextRequest.payload.cursor,
        nextCursor: null,
        models: [{ modelId: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', isDefault: false }],
      },
    } as const;
    expect(assertRemoteControlTaskResultMatchesRequest(nextRequest, nextResult))
      .toEqual(normalizeRemoteControlTaskResult(nextResult));
    expect(() => normalizeRemoteControlTaskRequest({
      ...firstRequest,
      payload: { adapterId: 'codex', catalogId: null, cursor: 'model_cursor_00000001' },
    })).toThrow(RemoteControlTaskProtocolError);
    expect(() => assertRemoteControlTaskResultMatchesRequest(nextRequest, {
      ...nextResult,
      result: { ...nextResult.result, catalogId: 'catalog_changed_99999999' },
    })).toThrow(RemoteControlTaskProtocolError);
  });

  test('uses opaque tasks.list cursors and verifies the echoed page position', () => {
    const request = {
      ...requestEnvelope,
      operation: 'tasks.list',
      payload: { cursor: 'tasks_cursor_00000001' },
    } as const;
    const result = {
      ...resultEnvelope,
      ok: true,
      result: {
        cursor: request.payload.cursor,
        nextCursor: 'tasks_cursor_00000002',
        tasks: [task],
      },
    } as const;
    expect(assertRemoteControlTaskResultMatchesRequest(request, result))
      .toEqual(normalizeRemoteControlTaskResult(result));
    expect(() => assertRemoteControlTaskResultMatchesRequest(request, {
      ...result,
      result: { ...result.result, cursor: 'tasks_cursor_wrong_999999' },
    })).toThrow(RemoteControlTaskProtocolError);
    expect(() => normalizeRemoteControlTaskResult({
      ...result,
      result: { ...result.result, nextCursor: result.result.cursor },
    })).toThrow(RemoteControlTaskProtocolError);
  });

  test('returns only operationId for correlation and exact success/error bodies', () => {
    expect(normalizeRemoteControlTaskResult(startResult)).toEqual(startResult);
    expect(Object.keys(normalizeRemoteControlTaskResult(startResult)).sort()).toEqual([
      'ok', 'operationId', 'protocolVersion', 'result', 'taskProtocolVersion', 'type',
    ]);
    const failure = {
      ...resultEnvelope,
      ok: false,
      error: { code: 'ADAPTER_UNAVAILABLE', message: '현재 실행기를 사용할 수 없습니다.', retryable: true },
    } as const;
    expect(normalizeRemoteControlTaskResult(failure)).toEqual(failure);
    for (const [key, value] of [
      ['stack', 'internal stack'],
      ['cause', { message: 'local failure' }],
      ['request', startRequest],
      ['requestId', startRequest.payload.requestId],
    ] as const) {
      expect(() => normalizeRemoteControlTaskResult({
        ...failure, error: { ...failure.error, [key]: value },
      })).toThrow(RemoteControlTaskProtocolError);
    }
    expect(() => normalizeRemoteControlTaskResult({ ...failure, operation: 'tasks.start' }))
      .toThrow(RemoteControlTaskProtocolError);
  });

  test('matches operation-specific task and event response identities', () => {
    expect(assertRemoteControlTaskResultMatchesRequest(startRequest, startResult)).toEqual(startResult);
    expect(() => assertRemoteControlTaskResultMatchesRequest(startRequest, {
      ...startResult,
      result: { ...startResult.result, task: { ...task, controlId: 'D'.repeat(43) } },
    })).toThrow(RemoteControlTaskProtocolError);

    const eventRequest = {
      ...requestEnvelope,
      operation: 'tasks.events',
      payload: { taskId: task.taskId, after: 1 },
    } as const;
    const eventResult = {
      ...resultEnvelope,
      ok: true,
      result: {
        taskId: task.taskId,
        after: 1,
        nextCursor: 2,
        events: [{
          taskId: task.taskId,
          seq: 2,
          occurredAt: task.updatedAt,
          type: 'task.progress',
          payload: { summary: '테스트를 실행하고 있습니다.', phase: 'verify' },
        }],
      },
    } as const;
    expect(assertRemoteControlTaskResultMatchesRequest(eventRequest, eventResult))
      .toEqual(normalizeRemoteControlTaskResult(eventResult));
    expect(() => assertRemoteControlTaskResultMatchesRequest(eventRequest, startResult))
      .toThrow(RemoteControlTaskProtocolError);
  });
});

describe('MVP capability and projection safety', () => {
  test('requires questions and approvals to remain false', () => {
    const valid = {
      ...resultEnvelope,
      ok: true,
      result: {
        adapters: [{
          adapterId: 'codex',
          label: 'Codex',
          availability: 'available',
          features: { structuredProgress: true, questions: false, approvals: false, cancellation: true },
        }],
        limits: { maxPromptBytes: 4_096, maxConcurrentTasks: 4 },
      },
    } as const;
    expect(normalizeRemoteControlTaskResult(valid)).toEqual(JSON.parse(JSON.stringify(valid)));
    for (const feature of ['questions', 'approvals'] as const) {
      expect(() => normalizeRemoteControlTaskResult({
        ...valid,
        result: {
          ...valid.result,
          adapters: [{
            ...valid.result.adapters[0],
            features: { ...valid.result.adapters[0].features, [feature]: true },
          }],
        },
      })).toThrow(RemoteControlTaskProtocolError);
    }
  });

  test('rejects question and approval events until response operations exist', () => {
    const eventBase = {
      taskId: task.taskId,
      seq: 3,
      occurredAt: task.updatedAt,
    } as const;
    for (const event of [
      {
        ...eventBase,
        type: 'task.question',
        payload: { questionId: 'question_12345678', prompt: '선택?', choices: ['A', 'B'] },
      },
      {
        ...eventBase,
        type: 'task.approval.requested',
        payload: {
          approvalId: 'approval_12345678', title: '명령 실행', risk: 'medium',
          expiresAt: '2026-09-04T00:05:00.000Z',
        },
      },
      {
        ...eventBase,
        type: 'task.approval.resolved',
        payload: { approvalId: 'approval_12345678', decision: 'allow-once' },
      },
    ]) {
      expect(() => normalizeRemoteControlTaskResult({
        ...resultEnvelope,
        ok: true,
        result: { taskId: task.taskId, after: 2, nextCursor: 3, events: [event] },
      })).toThrow(RemoteControlTaskProtocolError);
    }
  });

  test('projects a safe local summary with only controlId and rejects dangerous tasks', () => {
    const local = {
      taskId: task.taskId,
      targetId: 'project_12345678',
      projectLabel: task.projectLabel,
      adapterId: task.adapterId,
      modelId: task.modelId,
      executionMode: 'workspace-write',
      status: task.status,
      lastSeq: task.lastSeq,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    } as const;
    const projected = projectRemoteControlTaskSummary(local, controlId);
    expect(projected).toEqual(task);
    expect(Object.keys(projected).sort()).toEqual([
      'adapterId', 'controlId', 'createdAt', 'lastSeq', 'modelId',
      'projectLabel', 'status', 'taskId', 'updatedAt',
    ]);
    expect(JSON.stringify(projected)).not.toContain('targetId');
    expect(() => projectRemoteControlTaskSummary({
      ...local,
      executionMode: 'dangerously-bypass-approvals-and-sandbox',
    }, controlId)).toThrow(RemoteControlTaskProtocolError);
  });

  test('projects only safe accepted events and rejects dangerous/interactive local events', () => {
    const localTask = {
      taskId: task.taskId,
      targetId: 'project_12345678',
      projectLabel: task.projectLabel,
      adapterId: task.adapterId,
      modelId: task.modelId,
      executionMode: 'workspace-write',
      status: task.status,
      lastSeq: task.lastSeq,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    } as const;
    const accepted = {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: task.taskId,
      seq: 1,
      occurredAt: task.createdAt,
      type: 'task.accepted',
      payload: {
        adapterId: 'codex',
        projectLabel: 'AgentsToZ',
        modelId: 'gpt-5.6-codex',
        executionMode: 'workspace-write',
      },
    } as const;
    const projected = projectRemoteControlTaskEvent(accepted, localTask);
    expect(projected.payload).toEqual({
      adapterId: 'codex', projectLabel: 'AgentsToZ', modelId: 'gpt-5.6-codex',
    });
    expect(() => projectRemoteControlTaskEvent({
      ...accepted,
      payload: { ...accepted.payload, executionMode: 'dangerously-bypass-approvals-and-sandbox' },
    }, localTask)).toThrow(RemoteControlTaskProtocolError);
    expect(() => projectRemoteControlTaskEvent({
      ...accepted,
      type: 'task.question',
      payload: { questionId: 'question_12345678', prompt: '선택?', choices: ['A'] },
    }, localTask)).toThrow(RemoteControlTaskProtocolError);

    const progress = {
      ...accepted,
      seq: 2,
      type: 'task.progress',
      payload: { summary: '진행 중', phase: null },
    } as const;
    expect(() => projectRemoteControlTaskEvent(progress, {
      ...localTask,
      executionMode: 'dangerously-bypass-approvals-and-sandbox',
    })).toThrow(RemoteControlTaskProtocolError);
    expect(() => projectRemoteControlTaskEvent(progress, {
      ...localTask,
      taskId: 'different_task_12345678',
    })).toThrow(RemoteControlTaskProtocolError);
  });
});

describe('serialized and recursive boundaries', () => {
  test('guards the 9000-byte UTF-8 limit and round-trips canonical JSON', () => {
    expect(remoteControlTaskUtf8ByteLength('한')).toBe(3);
    expect(() => assertRemoteControlTaskSerializedSize('a'.repeat(REMOTE_CONTROL_TASK_MAX_SERIALIZED_BYTES)))
      .not.toThrow();
    try {
      assertRemoteControlTaskSerializedSize('한'.repeat(3_001));
      throw new Error('oversized serialized task message was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteControlTaskProtocolError);
      expect((error as RemoteControlTaskProtocolError).code)
        .toBe('REMOTE_CONTROL_TASK_MESSAGE_TOO_LARGE');
    }
    const serialized = serializeRemoteControlTaskMessage(startRequest);
    expect(parseRemoteControlTaskJson(serialized)).toEqual(startRequest);
    expect(() => parseRemoteControlTaskJson(' '.repeat(REMOTE_CONTROL_TASK_MAX_SERIALIZED_BYTES + 1)))
      .toThrow(RemoteControlTaskProtocolError);
  });

  test('fails closed on nested local/auth fields and cyclic values', () => {
    expect(() => assertRemoteControlTaskSafe({ result: { nested: { working_directory: '/private' } } }))
      .toThrow(RemoteControlTaskProtocolError);
    expect(() => assertRemoteControlTaskSafe({ result: { nested: { target_id: 'stable' } } }))
      .toThrow(RemoteControlTaskProtocolError);
    expect(() => assertRemoteControlTaskSafe({ result: { nested: { sessionToken } } }))
      .toThrow(RemoteControlTaskProtocolError);
    expect(() => assertRemoteControlTaskSafe({ result: { nested: { management_capability: 'secret' } } }))
      .toThrow(RemoteControlTaskProtocolError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertRemoteControlTaskSafe(cyclic)).toThrow(RemoteControlTaskProtocolError);
  });
});
