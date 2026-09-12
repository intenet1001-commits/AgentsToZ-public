import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
  AGENT_RUNTIME_MAX_RESPONSE_BYTES,
  resolveAgentRuntimeApiBase,
} from '../src/agentRuntimeClient';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from '../src/agentRuntimeProtocol';
import type {
  AgentRuntimeCapabilitiesResponse,
  AgentRuntimeTargetsResponse,
} from '../src/agentRuntimeApiContract';
import type { AgentRuntimeReadinessDiagnostic } from '../src/agentRuntimeReadinessContract';
import {
  AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
} from '../src/agentRuntimeConversationProtocol';
import { AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION } from '../src/agentRuntimeConversationQuestionProtocol';

const capabilityResponse = {
  protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
  adapters: [{
    adapterId: 'codex',
    label: 'Codex',
    availability: 'available',
    models: [{ modelId: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', isDefault: true }],
    features: {
      structuredProgress: true,
      questions: false,
      approvals: false,
      cancellation: true,
    },
  }],
  limits: { maxPromptBytes: 32_768, maxConcurrentTasks: 4 },
} satisfies AgentRuntimeCapabilitiesResponse;

const targetsResponse = {
  protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
  targets: [{
    targetId: 'target_12345678',
    projectTargetId: 'target_12345678',
    label: 'AgentsToZ',
    scope: 'main',
    branch: 'main',
    locked: false,
    worktreeCapable: true,
  }],
  complete: true,
} satisfies AgentRuntimeTargetsResponse;

const readinessResponse = {
  protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
  schemaVersion: 3,
  kind: 'agent-runtime-readiness-diagnostic',
  platform: 'macos',
  state: 'blocked',
  authoritative: false,
  reusable: false,
  ready: false,
  gates: [
    { id: 'managed-execution-policy', status: 'blocked', reason: 'managed-execution-policy-closed' },
    { id: 'host-platform', status: 'passed', reason: 'platform-supported' },
    { id: 'codex-adapter', status: 'passed', reason: 'codex-adapter-verified' },
    { id: 'production-team-pin', status: 'blocked', reason: 'production-team-pin-unconfigured' },
    { id: 'embedded-broker-signing', status: 'blocked', reason: 'broker-helper-missing' },
    { id: 'smappservice-channel', status: 'pending', reason: 'smappservice-channel-awaits-installed-proof' },
    { id: 'dedicated-runtime-identity', status: 'pending', reason: 'dedicated-runtime-identity-not-implemented' },
    { id: 'detached-descendant-canary', status: 'pending', reason: 'detached-descendant-canary-not-implemented' },
    { id: 'runtime-supervisor', status: 'blocked', reason: 'runtime-supervisor-unavailable' },
  ],
} satisfies AgentRuntimeReadinessDiagnostic;

const taskSummary = {
  taskId: 'task_12345678',
  targetId: 'target_12345678',
  projectLabel: 'AgentsToZ',
  adapterId: 'codex',
  modelId: 'gpt-5.6-sol',
  executionMode: 'workspace-write',
  status: 'running',
  lastSeq: 1,
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:01:00.000Z',
} as const;

const acceptedEvent = {
  protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
  taskId: taskSummary.taskId,
  seq: 1,
  occurredAt: taskSummary.createdAt,
  type: 'task.accepted',
  payload: {
    adapterId: 'codex',
    projectLabel: 'AgentsToZ',
    modelId: 'gpt-5.6-sol',
    executionMode: 'workspace-write',
  },
} as const;

const conversationSummary = {
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

const clientSource = readFileSync(new URL('../src/agentRuntimeClient.ts', import.meta.url), 'utf8');

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

describe('AgentRuntimeClient transport contract', () => {
  test('loads conversation capability from its distinct non-task route', async () => {
    const calls: string[] = [];
    const client = new AgentRuntimeClient({
      tauri: false,
      fetchImpl: async input => {
        calls.push(String(input));
        return jsonResponse({
          ...capabilityResponse,
          adapters: [{ ...capabilityResponse.adapters[0], label: 'Codex · 읽기 전용' }],
        });
      },
    });
    const result = await client.conversationCapabilities();
    expect(result.adapters[0]?.label).toBe('Codex · 읽기 전용');
    expect(calls).toEqual(['/api/agent-runtime/conversations/capabilities']);
  });

  test('uses only the bounded exact routes and exact mutation bodies', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      capabilityResponse,
      readinessResponse,
      targetsResponse,
      { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, tasks: [taskSummary] },
      {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        taskId: taskSummary.taskId,
        after: 0,
        nextCursor: 1,
        events: [acceptedEvent],
      },
      { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, duplicate: false, task: taskSummary },
      {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        task: { ...taskSummary, status: 'cancelled', updatedAt: '2026-09-03T00:02:00.000Z' },
      },
    ];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse(responses.shift());
    };
    const client = new AgentRuntimeClient({ fetchImpl, tauri: false });

    await client.capabilities();
    await client.readiness();
    await client.targets();
    await client.tasks();
    await client.events(taskSummary.taskId, 0);
    await client.start({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'request_12345678',
      targetId: taskSummary.targetId,
      adapterId: 'codex',
      modelId: 'gpt-5.6-sol',
      executionMode: 'workspace-write',
      prompt: '테스트를 실행해줘.',
    });
    await client.cancel(taskSummary.taskId, 'cancel_12345678');

    expect(calls.map(call => [call.init?.method, call.url])).toEqual([
      ['GET', '/api/agent-runtime/capabilities'],
      ['GET', '/api/agent-runtime/readiness'],
      ['GET', '/api/agent-runtime/targets'],
      ['GET', '/api/agent-runtime/tasks'],
      ['GET', '/api/agent-runtime/tasks/task_12345678/events?after=0'],
      ['POST', '/api/agent-runtime/tasks/start'],
      ['POST', '/api/agent-runtime/tasks/task_12345678/cancel'],
    ]);
    expect(JSON.parse(String(calls[5]?.init?.body))).toEqual({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'request_12345678',
      targetId: taskSummary.targetId,
      adapterId: 'codex',
      modelId: 'gpt-5.6-sol',
      executionMode: 'workspace-write',
      prompt: '테스트를 실행해줘.',
    });
    expect(JSON.parse(String(calls[6]?.init?.body))).toEqual({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'cancel_12345678',
    });
    for (const call of calls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      expect(call.init?.cache).toBe('no-store');
      expect(call.init?.redirect).toBe('error');
      expect(call.init?.referrerPolicy).toBe('no-referrer');
    }
  });

  test('uses the capability-owning Rust proxy inside Tauri and never browser fetch', async () => {
    expect(resolveAgentRuntimeApiBase()).toBe('');
    let fetchCalls = 0;
    const invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const client = new AgentRuntimeClient({
      tauri: true,
      development: false,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('Tauri must not fetch the sidecar directly');
      },
      invokeImpl: async (command, args) => {
        invokes.push({ command, args });
        return { status: 200, body: capabilityResponse };
      },
    });
    await client.capabilities();
    expect(fetchCalls).toBe(0);
    expect(invokes).toEqual([{
      command: 'agent_runtime_request',
      args: {
        path: '/api/agent-runtime/capabilities',
        method: 'GET',
        body: null,
      },
    }]);
    expect(clientSource).not.toContain('X-AgentsToZ-Agent-Runtime-Capability');
    expect(clientSource).not.toContain('PORTMGR_AGENT_RUNTIME_CAPABILITY');
    expect(clientSource).not.toContain("invoke<unknown>('remote_control_management_request'");
    expect(clientSource).not.toContain("invoke<unknown>('what_i_said_management_request'");
  });

  test('uses exact app-native conversation routes and validates every response again', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const idleConversation = {
      ...conversationSummary,
      state: 'idle' as const,
      activeTurnId: null,
      revision: 4,
    };
    const responses: unknown[] = [
      { protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION, conversations: [idleConversation] },
      {
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        duplicate: false,
        accepted: true,
        conversation: conversationSummary,
      },
      {
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        duplicate: false,
        accepted: true,
        conversation: conversationSummary,
      },
      {
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        conversationId: conversationSummary.conversationId,
        after: 0,
        nextCursor: 1,
        events: [{
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          conversationId: conversationSummary.conversationId,
          seq: 1,
          revision: 3,
          type: 'conversation.turn.started',
          turnId: 'turn_12345678',
          createdAt: '2026-09-05T00:00:01.000Z',
        }],
      },
      {
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        conversation: idleConversation,
        history: { status: 'idle', turns: [], truncated: false, filtered: true },
      },
      { ...conversationSummary, revision: 4 },
      { ...conversationSummary, revision: 4 },
      { ...idleConversation, state: 'archived', revision: 5 },
      {
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        conversationId: conversationSummary.conversationId,
        deleted: true,
        duplicate: false,
      },
      {
        protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
        conversationId: conversationSummary.conversationId,
        question: {
          protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
          questionRequestId: 'question_request_12345678',
          conversationId: conversationSummary.conversationId,
          turnId: 'turn_12345678',
          revision: 3,
          expiresAt: '2026-09-05T00:30:00.000Z',
          questions: [{
            questionId: 'question_12345678',
            header: '구현 방식',
            question: '어떤 방식으로 진행할까요?',
            options: [
              { optionId: 'option_12345678', label: '안전 우선', description: '' },
              { optionId: 'option_87654321', label: '빠른 진행', description: '' },
            ],
            allowOther: false,
          }],
        },
      },
      {
        protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
        requestId: 'answer_request_12345678',
        conversationId: conversationSummary.conversationId,
        questionRequestId: 'question_request_12345678',
        accepted: true,
        duplicate: false,
      },
    ];
    const client = new AgentRuntimeClient({
      tauri: false,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse(responses.shift());
      },
    });
    const createRequest = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_conversation_12345678',
      targetId: conversationSummary.targetId,
      adapterId: 'codex',
      modelId: conversationSummary.modelId,
      historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
      initialPrompt: '현재 변경을 검토해줘.',
    } as const;
    const continueRequest = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_continue_12345678',
      conversationId: conversationSummary.conversationId,
      expectedRevision: 4,
      prompt: '이어서 검토해줘.',
    } as const;
    await client.conversations();
    await client.startConversation(createRequest);
    await client.continueConversation(continueRequest);
    await client.conversationEvents(conversationSummary.conversationId, 0);
    await client.conversationHistory({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: conversationSummary.conversationId,
      expectedRevision: 4,
    });
    await client.steerConversation({
      ...continueRequest,
      requestId: 'request_steer_12345678',
      expectedRevision: 3,
      expectedTurnId: 'turn_12345678',
    });
    const { prompt: _prompt, ...interruptBase } = continueRequest;
    await client.interruptConversation({
      ...interruptBase,
      requestId: 'request_interrupt_12345678',
      expectedRevision: 3,
      expectedTurnId: 'turn_12345678',
    });
    await client.setConversationArchived({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_archive_12345678',
      conversationId: conversationSummary.conversationId,
      expectedRevision: 4,
    }, true);
    await client.deleteConversation({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_delete_12345678',
      conversationId: conversationSummary.conversationId,
      expectedRevision: 5,
      confirmPermanentDeletion: true,
    });
    await client.conversationQuestion(conversationSummary.conversationId);
    await client.answerConversationQuestion({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      requestId: 'answer_request_12345678',
      conversationId: conversationSummary.conversationId,
      questionRequestId: 'question_request_12345678',
      expectedRevision: 3,
      expectedTurnId: 'turn_12345678',
      answers: [{ questionId: 'question_12345678', optionId: 'option_12345678', text: null }],
    });
    expect(calls.map(call => [call.init?.method, call.url])).toEqual([
      ['GET', '/api/agent-runtime/conversations'],
      ['POST', '/api/agent-runtime/conversations/start'],
      ['POST', '/api/agent-runtime/conversations/conversation_12345678/continue'],
      ['GET', '/api/agent-runtime/conversations/conversation_12345678/events?after=0'],
      ['POST', '/api/agent-runtime/conversations/conversation_12345678/history'],
      ['POST', '/api/agent-runtime/conversations/conversation_12345678/steer'],
      ['POST', '/api/agent-runtime/conversations/conversation_12345678/interrupt'],
      ['POST', '/api/agent-runtime/conversations/conversation_12345678/archive'],
      ['POST', '/api/agent-runtime/conversations/conversation_12345678/delete'],
      ['GET', '/api/agent-runtime/conversations/conversation_12345678/question'],
      ['POST', '/api/agent-runtime/conversations/conversation_12345678/question/answer'],
    ]);
  });

  test('uses Vite same-origin HTTP in tauri dev while keeping production proxy-only', async () => {
    let fetchCalls = 0;
    let invokeCalls = 0;
    const client = new AgentRuntimeClient({
      tauri: true,
      development: true,
      fetchImpl: async input => {
        fetchCalls += 1;
        expect(String(input)).toBe('/api/agent-runtime/capabilities');
        return jsonResponse(capabilityResponse);
      },
      invokeImpl: async () => {
        invokeCalls += 1;
        throw new Error('tauri dev must use the Vite API proxy');
      },
    });
    await expect(client.capabilities()).resolves.toEqual(capabilityResponse);
    expect(fetchCalls).toBe(1);
    expect(invokeCalls).toBe(0);
  });

  test('binds the browser default fetch to its global receiver', async () => {
    const originalFetch = globalThis.fetch;
    let receiver: unknown;
    globalThis.fetch = (function (this: unknown) {
      receiver = this;
      return Promise.resolve(jsonResponse(capabilityResponse));
    }) as unknown as typeof fetch;
    try {
      const client = new AgentRuntimeClient({ tauri: false });
      await expect(client.capabilities()).resolves.toEqual(capabilityResponse);
      expect(receiver).toBe(globalThis);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects extra fields, unsafe nested fields, and response/request mismatches', async () => {
    const invalidResponses: unknown[] = [
      { ...capabilityResponse, futureFeature: true },
      {
        ...targetsResponse,
        targets: [{ ...targetsResponse.targets[0], cwd: '/private/project' }],
      },
      {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        tasks: [{ ...taskSummary, cwd: '/private/project' }],
      },
      {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        taskId: 'task_87654321',
        after: 0,
        nextCursor: 0,
        events: [],
      },
      {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        duplicate: false,
        task: { ...taskSummary, targetId: 'target_87654321' },
      },
      {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        task: { ...taskSummary, taskId: 'task_87654321' },
      },
    ];
    const fetchImpl = async () => jsonResponse(invalidResponses.shift());
    const client = new AgentRuntimeClient({ fetchImpl, tauri: false });

    for (const operation of [
      () => client.capabilities(),
      () => client.targets(),
      () => client.tasks(),
      () => client.events(taskSummary.taskId, 0),
      () => client.start({
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        requestId: 'request_12345678',
        targetId: taskSummary.targetId,
        adapterId: 'codex',
        modelId: 'gpt-5.6-sol',
        executionMode: 'workspace-write',
        prompt: '확인해줘.',
      }),
      () => client.cancel(taskSummary.taskId, 'cancel_12345678'),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: 'AGENT_RUNTIME_RESPONSE_INVALID',
      });
    }
  });

  test('does not issue a request for an invalid start DTO', async () => {
    let calls = 0;
    const client = new AgentRuntimeClient({
      tauri: false,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    await expect(client.start({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'request_12345678',
      targetId: taskSummary.targetId,
      adapterId: 'codex',
      prompt: '확인',
      cwd: '/private/project',
    } as never)).rejects.toMatchObject({ code: 'AGENT_RUNTIME_RESPONSE_INVALID' });
    expect(calls).toBe(0);
  });

  test('rejects a start response that changes the selected model or execution mode', async () => {
    for (const mismatchedTask of [
      { ...taskSummary, modelId: 'gpt-5.6-terra' },
      { ...taskSummary, executionMode: 'dangerously-bypass-approvals-and-sandbox' as const },
    ]) {
      const client = new AgentRuntimeClient({
        tauri: false,
        fetchImpl: async () => jsonResponse({
          protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
          duplicate: false,
          task: mismatchedTask,
        }),
      });
      await expect(client.start({
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        requestId: 'request_model_parity_12345678',
        targetId: taskSummary.targetId,
        adapterId: 'codex',
        modelId: taskSummary.modelId,
        executionMode: 'workspace-write',
        prompt: '선택한 모델로 확인해줘.',
      })).rejects.toMatchObject({ code: 'AGENT_RUNTIME_RESPONSE_INVALID' });
    }
  });

  test('maps caller abort and timeout to distinct stable errors', async () => {
    const hangingFetch = (_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener('abort', rejectAbort, { once: true });
      })
    );

    const caller = new AbortController();
    const abortClient = new AgentRuntimeClient({ fetchImpl: hangingFetch, tauri: false });
    const aborted = abortClient.capabilities({ signal: caller.signal });
    caller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'AGENT_RUNTIME_REQUEST_ABORTED' });

    const timeoutClient = new AgentRuntimeClient({
      fetchImpl: hangingFetch,
      tauri: false,
      timeoutMs: 5,
    });
    await expect(timeoutClient.capabilities()).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_REQUEST_TIMEOUT',
    });
  });

  test('requires bounded JSON and exposes only an exact public error message', async () => {
    const nonJsonClient = new AgentRuntimeClient({
      tauri: false,
      fetchImpl: async () => new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    });
    await expect(nonJsonClient.tasks()).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_RESPONSE_INVALID',
    });

    const httpClient = new AgentRuntimeClient({
      tauri: false,
      fetchImpl: async () => jsonResponse({
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        ok: false,
        code: 'RUNTIME_BUSY',
        error: '런타임이 다른 작업을 준비하고 있습니다.',
      }, 503),
    });
    try {
      await httpClient.tasks();
      throw new Error('expected the request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeClientError);
      expect(error).toMatchObject({ code: 'AGENT_RUNTIME_HTTP_ERROR', status: 503 });
      expect(String((error as Error).message)).toBe('런타임이 다른 작업을 준비하고 있습니다.');
    }

    const unsafeErrorClient = new AgentRuntimeClient({
      tauri: false,
      fetchImpl: async () => jsonResponse({
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        ok: false,
        code: 'RUNTIME_BUSY',
        error: '잠시 후 다시 시도해주세요.',
        cwd: '/private/project',
      }, 503),
    });
    await expect(unsafeErrorClient.tasks()).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_RESPONSE_INVALID',
      status: null,
    });

    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const oversizedClient = new AgentRuntimeClient({
      tauri: false,
      fetchImpl: async () => new Response(oversizedStream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    });
    expect(AGENT_RUNTIME_MAX_RESPONSE_BYTES).toBe(3 * 1024 * 1024);
    await expect(oversizedClient.tasks()).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_RESPONSE_INVALID',
    });
    expect(cancelled).toBe(true);
  });

  test('explains a stale task-only server when the conversation protocol is missing there', async () => {
    for (const status of [200, 403]) {
      const client = new AgentRuntimeClient({
        tauri: false,
        fetchImpl: async () => jsonResponse({
          protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
          ...(status === 200
            ? { tasks: [] }
            : { ok: false, code: 'AGENT_RUNTIME_MANAGEMENT_ORIGIN_DENIED', error: '거절됨' }),
        }, status),
      });
      await expect(client.conversations()).rejects.toMatchObject({
        code: 'AGENT_RUNTIME_SERVER_UPGRADE_REQUIRED',
        status: null,
        message: '앱과 로컬 실행 서버 버전이 다릅니다. AgentsToZ 앱 또는 개발 서버를 완전히 종료한 뒤 다시 실행하세요.',
      });
    }
  });
});
