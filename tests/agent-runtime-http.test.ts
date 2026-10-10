import { describe, expect, test } from 'bun:test';
import type { AgentRuntimeHttpService } from '../src/agentRuntimeHttp';
import {
  AGENT_RUNTIME_HTTP_BODY_MAX_BYTES,
  handleAgentRuntimeHttpRequest,
} from '../src/agentRuntimeHttp';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from '../src/agentRuntimeProtocol';
import type { AgentRuntimeReadinessDiagnostic } from '../src/agentRuntimeReadinessContract';
import {
  AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
} from '../src/agentRuntimeConversationProtocol';
import {
  AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
  type AgentRuntimeConversationPendingQuestion,
} from '../src/agentRuntimeConversationQuestionProtocol';

const readiness = {
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

const task = {
  taskId: 'task_12345678',
  targetId: 'target_12345678',
  projectLabel: 'AgentsToZ',
  adapterId: 'codex',
  modelId: 'gpt-5.6-sol',
  executionMode: 'workspace-write',
  status: 'accepted',
  lastSeq: 1,
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
} as const;

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

function conversationService(): NonNullable<AgentRuntimeHttpService['conversations']> {
  const pendingQuestion: AgentRuntimeConversationPendingQuestion = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
    questionRequestId: 'question_request_12345678',
    conversationId: conversation.conversationId,
    turnId: conversation.activeTurnId,
    revision: conversation.revision,
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
  return {
    list: () => [conversation],
    startCreate: async () => ({ duplicate: false, accepted: true, conversation }),
    startContinue: async () => ({ duplicate: false, accepted: true, conversation }),
    readEvents: request => ({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: request.conversationId,
      after: request.after,
      nextCursor: request.after,
      events: [],
    }),
    history: async () => ({
      conversation: { ...conversation, state: 'idle', activeTurnId: null, revision: 4 },
      history: { status: 'idle', turns: [], truncated: false, filtered: true },
    }),
    steer: async () => conversation,
    interrupt: async () => conversation,
    setArchived: async (_request, archived) => ({
      ...conversation,
      state: archived ? 'archived' : 'idle',
      activeTurnId: null,
      revision: 4,
    }),
    delete: async request => ({
      conversationId: request.conversationId,
      deleted: true,
      duplicate: false,
    }),
    questionStatus: conversationId => ({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      conversationId,
      question: pendingQuestion,
    }),
    answerQuestion: request => ({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      requestId: request.requestId,
      conversationId: request.conversationId,
      questionRequestId: request.questionRequestId,
      accepted: true,
      duplicate: false,
    }),
  };
}

function service(overrides: Partial<AgentRuntimeHttpService> = {}): AgentRuntimeHttpService {
  return {
    capabilities: () => ({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      adapters: [{
        adapterId: 'codex', label: 'Codex', availability: 'available',
        models: [{ modelId: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', isDefault: true }],
        features: { structuredProgress: true, questions: false, approvals: false, cancellation: true },
      }],
      limits: { maxPromptBytes: 32768, maxConcurrentTasks: 4 },
    }),
    readiness: () => readiness,
    targets: () => ({
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
    }),
    listTasks: () => ({ protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, tasks: [task] }),
    readEvents: (_taskId, after) => ({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: task.taskId,
      after,
      nextCursor: after,
      events: [],
    }),
    startTask: () => ({ protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, duplicate: false, task }),
    cancelTask: () => ({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      task: { ...task, status: 'cancelled' },
    }),
    ...overrides,
  };
}

describe('agent runtime local HTTP surface', () => {
  test('ignores unrelated routes and serves only exact runtime routes', async () => {
    const unrelated = await handleAgentRuntimeHttpRequest(
      new Request('http://localhost/api/ports'),
      new URL('http://localhost/api/ports'),
      service(),
    );
    expect(unrelated).toBeNull();

    const response = await handleAgentRuntimeHttpRequest(
      new Request('http://localhost/api/agent-runtime/tasks'),
      new URL('http://localhost/api/agent-runtime/tasks'),
      service(),
    );
    expect(response?.status).toBe(200);
    expect((await response?.json()).tasks).toHaveLength(1);

    const targets = await handleAgentRuntimeHttpRequest(
      new Request('http://localhost/api/agent-runtime/targets'),
      new URL('http://localhost/api/agent-runtime/targets'),
      service(),
    );
    expect(targets?.status).toBe(200);
    expect((await targets?.json()).targets).toHaveLength(1);

    const diagnostic = await handleAgentRuntimeHttpRequest(
      new Request('http://localhost/api/agent-runtime/readiness'),
      new URL('http://localhost/api/agent-runtime/readiness'),
      service(),
    );
    expect(diagnostic?.status).toBe(200);
    expect(await diagnostic?.json()).toEqual(readiness);
  });

  test('keeps task capability closed while serving a separate conversation capability', async () => {
    const conversationCapabilities = {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      adapters: [{
        adapterId: 'codex' as const,
        label: 'Codex · 읽기 전용',
        availability: 'available' as const,
        models: [{ modelId: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', isDefault: true }],
        features: { structuredProgress: true, questions: true, approvals: false, cancellation: true },
      }],
      limits: { maxPromptBytes: 32768, maxConcurrentTasks: 1 },
    };
    const url = new URL('http://localhost/api/agent-runtime/conversations/capabilities');
    const response = await handleAgentRuntimeHttpRequest(
      new Request(url),
      url,
      service({ conversationCapabilities: () => conversationCapabilities }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(conversationCapabilities);

    const missing = await handleAgentRuntimeHttpRequest(new Request(url), url, service());
    expect(missing?.status).toBe(503);
  });

  test('normalizes an exact idempotent start request', async () => {
    let observed: unknown = null;
    const url = new URL('http://localhost/api/agent-runtime/tasks/start');
    const response = await handleAgentRuntimeHttpRequest(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        requestId: 'request_12345678',
        targetId: task.targetId,
        adapterId: 'codex',
        modelId: 'gpt-5.6-sol',
        executionMode: 'workspace-write',
        prompt: '현재 테스트를 실행하고 결과를 요약해줘.',
      }),
    }), url, service({
      startTask: request => {
        observed = request;
        return { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, duplicate: false, task };
      },
    }));
    expect(response?.status).toBe(202);
    expect(observed).toMatchObject({ targetId: task.targetId, adapterId: 'codex' });
  });

  test('serves app-native conversation start, events, and history on the local runtime boundary', async () => {
    let observedCreate: unknown = null;
    const conversations = conversationService();
    conversations.startCreate = async request => {
      observedCreate = request;
      return { duplicate: false, accepted: true, conversation };
    };
    const runtime = service({ conversations });
    const listUrl = new URL('http://localhost/api/agent-runtime/conversations');
    const list = await handleAgentRuntimeHttpRequest(new Request(listUrl), listUrl, runtime);
    expect(list?.status).toBe(200);
    expect((await list?.json()).conversations).toHaveLength(1);

    const startUrl = new URL('http://localhost/api/agent-runtime/conversations/start');
    const start = await handleAgentRuntimeHttpRequest(new Request(startUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        requestId: 'request_conversation_12345678',
        targetId: 'target_12345678',
        adapterId: 'codex',
        modelId: 'gpt-5.6-sol',
        historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
        initialPrompt: '현재 변경을 검토해줘.',
      }),
    }), startUrl, runtime);
    expect(start?.status).toBe(202);
    expect(observedCreate).toMatchObject({ targetId: 'target_12345678', adapterId: 'codex' });

    const eventsUrl = new URL(
      'http://localhost/api/agent-runtime/conversations/conversation_12345678/events?after=0',
    );
    const events = await handleAgentRuntimeHttpRequest(new Request(eventsUrl), eventsUrl, runtime);
    expect(events?.status).toBe(200);
    expect(await events?.json()).toMatchObject({ after: 0, nextCursor: 0, events: [] });

    const historyUrl = new URL(
      'http://localhost/api/agent-runtime/conversations/conversation_12345678/history',
    );
    const history = await handleAgentRuntimeHttpRequest(new Request(historyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        conversationId: 'conversation_12345678',
        expectedRevision: 3,
      }),
    }), historyUrl, runtime);
    expect(history?.status).toBe(200);
    expect(await history?.json()).toMatchObject({ history: { status: 'idle', turns: [] } });

    const questionUrl = new URL(
      'http://localhost/api/agent-runtime/conversations/conversation_12345678/question',
    );
    const question = await handleAgentRuntimeHttpRequest(
      new Request(questionUrl), questionUrl, runtime,
    );
    expect(question?.status).toBe(200);
    expect(await question?.json()).toMatchObject({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      question: { questionRequestId: 'question_request_12345678' },
    });

    const answerUrl = new URL(`${questionUrl}/answer`);
    const answer = await handleAgentRuntimeHttpRequest(new Request(answerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
        requestId: 'answer_request_12345678',
        conversationId: 'conversation_12345678',
        questionRequestId: 'question_request_12345678',
        expectedRevision: 3,
        expectedTurnId: 'turn_12345678',
        answers: [{ questionId: 'question_12345678', optionId: 'option_12345678', text: null }],
      }),
    }), answerUrl, runtime);
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toMatchObject({ accepted: true, duplicate: false });
  });

  test('rejects mismatched conversation path ids and unavailable conversation services', async () => {
    const continueUrl = new URL(
      'http://localhost/api/agent-runtime/conversations/conversation_12345678/continue',
    );
    const mismatch = await handleAgentRuntimeHttpRequest(new Request(continueUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        requestId: 'request_continue_12345678',
        conversationId: 'conversation_87654321',
        expectedRevision: 3,
        prompt: '계속해줘.',
      }),
    }), continueUrl, service({ conversations: conversationService() }));
    expect(mismatch?.status).toBe(400);
    expect((await mismatch?.json()).protocolVersion)
      .toBe(AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION);

    const listUrl = new URL('http://localhost/api/agent-runtime/conversations');
    const unavailable = await handleAgentRuntimeHttpRequest(
      new Request(listUrl),
      listUrl,
      service(),
    );
    expect(unavailable?.status).toBe(503);
  });

  test('preserves an unavailable conversation adapter failure across the local HTTP boundary', async () => {
    const conversations = conversationService();
    conversations.startCreate = async () => {
      throw Object.assign(new Error('선택한 AI 실행기는 아직 지속형 대화를 지원하지 않습니다.'), {
        code: 'AGENT_RUNTIME_CONVERSATION_ADAPTER_UNAVAILABLE',
      });
    };
    const url = new URL('http://localhost/api/agent-runtime/conversations/start');
    const response = await handleAgentRuntimeHttpRequest(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        requestId: 'request_claude_12345678',
        targetId: 'target_12345678',
        adapterId: 'claude',
        modelId: 'claude-sonnet',
        historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
        initialPrompt: '현재 변경을 검토해줘.',
      }),
    }), url, service({ conversations }));

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      code: 'AGENT_RUNTIME_CONVERSATION_ADAPTER_UNAVAILABLE',
    });
  });

  test('keeps the conversation protocol on an unexpected provider-history failure', async () => {
    const conversations = conversationService();
    conversations.history = async () => {
      throw new Error('private provider details');
    };
    const url = new URL(
      'http://localhost/api/agent-runtime/conversations/conversation_12345678/history',
    );
    const response = await handleAgentRuntimeHttpRequest(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        conversationId: 'conversation_12345678',
        expectedRevision: 3,
      }),
    }), url, service({ conversations }));

    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      ok: false,
      code: 'AGENT_RUNTIME_INTERNAL',
      error: '에이전트 런타임 요청을 처리하지 못했습니다.',
    });
  });

  test('accepts a protocol-valid prompt even when JSON escaping exceeds the old wire limit', async () => {
    const prompt = '\u0001'.repeat(7_000);
    const body = JSON.stringify({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'request_escaped_12345678',
      targetId: task.targetId,
      adapterId: 'codex',
      modelId: 'gpt-5.6-sol',
      executionMode: 'workspace-write',
      prompt,
    });
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(32 * 1024);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(40 * 1024);

    let observedPrompt = '';
    const url = new URL('http://localhost/api/agent-runtime/tasks/start');
    const response = await handleAgentRuntimeHttpRequest(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body,
    }), url, service({
      startTask: request => {
        observedPrompt = request.prompt;
        return { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, duplicate: false, task };
      },
    }));
    expect(response?.status).toBe(202);
    expect(observedPrompt).toBe(prompt);
  });

  test('rejects a chunked oversized body before dispatching it to the service', async () => {
    let dispatched = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunks = Math.ceil(AGENT_RUNTIME_HTTP_BODY_MAX_BYTES / chunk.byteLength) + 1;
        for (let index = 0; index < chunks; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const url = new URL('http://localhost/api/agent-runtime/tasks/start');
    const response = await handleAgentRuntimeHttpRequest(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }), url, service({
      startTask: request => {
        dispatched = true;
        return { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, duplicate: false, task };
      },
    }));
    expect(response?.status).toBe(413);
    expect(dispatched).toBe(false);
  });

  test('requires JSON and rejects compressed request bodies', async () => {
    const url = new URL('http://localhost/api/agent-runtime/tasks/start');
    const plain = await handleAgentRuntimeHttpRequest(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    }), url, service());
    expect(plain?.status).toBe(415);

    const compressed = await handleAgentRuntimeHttpRequest(new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: '{}',
    }), url, service());
    expect(compressed?.status).toBe(415);
  });

  test('rejects extra query, malformed cursor, method, and cancel body fields', async () => {
    for (const request of [
      new Request('http://localhost/api/agent-runtime/tasks?limit=1'),
      new Request(`http://localhost/api/agent-runtime/tasks/${task.taskId}/events?after=-1`),
      new Request('http://localhost/api/agent-runtime/capabilities', { method: 'POST' }),
      new Request(`http://localhost/api/agent-runtime/tasks/${task.taskId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({
          protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
          requestId: 'cancel_12345678',
          command: 'unsafe',
        }),
      }),
    ]) {
      const response = await handleAgentRuntimeHttpRequest(request, new URL(request.url), service());
      expect(response?.status).toBeGreaterThanOrEqual(400);
    }
  });

  test('revalidates service output and does not serialize local execution fields', async () => {
    const response = await handleAgentRuntimeHttpRequest(
      new Request('http://localhost/api/agent-runtime/tasks'),
      new URL('http://localhost/api/agent-runtime/tasks'),
      service({
        listTasks: () => ({
          protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
          tasks: [{ ...task, cwd: '/private/project' }] as never,
        }),
      }),
    );
    expect(response?.status).toBe(500);
    expect(JSON.stringify(await response?.json())).not.toContain('/private/project');

    const targetsResponse = await handleAgentRuntimeHttpRequest(
      new Request('http://localhost/api/agent-runtime/targets'),
      new URL('http://localhost/api/agent-runtime/targets'),
      service({
        targets: () => ({
          protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
          targets: [{
            targetId: 'target_12345678',
            projectTargetId: 'target_12345678',
            label: 'AgentsToZ',
            scope: 'main',
            branch: 'main',
            locked: false,
            worktreeCapable: true,
            cwd: '/private/project',
          }],
          complete: true,
        } as never),
      }),
    );
    expect(targetsResponse?.status).toBe(500);
    expect(JSON.stringify(await targetsResponse?.json())).not.toContain('/private/project');
  });
});
