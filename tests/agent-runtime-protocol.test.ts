import { describe, expect, test } from 'bun:test';
import {
  AGENT_RUNTIME_MAX_MODEL_ID_LENGTH,
  AGENT_RUNTIME_MAX_PROMPT_BYTES,
  AGENT_RUNTIME_PROTOCOL_VERSION,
  AgentRuntimeProtocolError,
  assertAgentRuntimeRemoteSafe,
  materializeAgentTaskEvent,
  normalizeAgentTaskEvent,
  normalizeAgentTaskStartRequest,
} from '../src/agentRuntimeProtocol';

const base = {
  protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
  taskId: 'task_12345678',
  seq: 1,
  occurredAt: '2026-09-03T10:00:00.000Z',
};

describe('Agent Runtime task start contract', () => {
  test('accepts only an opaque registered target and a built-in adapter', () => {
    expect(AGENT_RUNTIME_PROTOCOL_VERSION).toBe('agentstoz-tasks-v2');
    expect(normalizeAgentTaskStartRequest({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'request_12345678',
      targetId: 'project_12345678',
      adapterId: 'codex',
      modelId: 'openai/gpt-5.6:codex_preview',
      executionMode: 'workspace-write',
      prompt: '테스트를 실행하고 결과를 설명해줘.',
    })).toEqual({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'request_12345678',
      targetId: 'project_12345678',
      adapterId: 'codex',
      modelId: 'openai/gpt-5.6:codex_preview',
      executionMode: 'workspace-write',
      prompt: '테스트를 실행하고 결과를 설명해줘.',
    });

    expect(normalizeAgentTaskStartRequest({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'request_danger_12345678',
      targetId: 'project_12345678',
      adapterId: 'codex',
      modelId: 'gpt-5.6-codex',
      executionMode: 'dangerously-bypass-approvals-and-sandbox',
      prompt: '전체 접근이 필요한 로컬 작업을 실행해줘.',
    })).toMatchObject({
      executionMode: 'dangerously-bypass-approvals-and-sandbox',
    });
  });

  test('rejects paths, commands, env, bypass, unknown adapters, and extra keys', () => {
    const valid = {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'request_12345678',
      targetId: 'project_12345678',
      adapterId: 'codex',
      modelId: 'gpt-5.6-codex',
      executionMode: 'workspace-write',
      prompt: '상태를 확인해줘.',
    };
    for (const [key, value] of [
      ['cwd', '/private/project'],
      ['command', 'rm -rf something'],
      ['env', { TOKEN: 'secret' }],
      ['bypass', true],
      ['memoryId', 'memory_12345678'],
    ] as const) {
      expect(() => normalizeAgentTaskStartRequest({ ...valid, [key]: value }))
        .toThrow(AgentRuntimeProtocolError);
    }
    expect(() => normalizeAgentTaskStartRequest({ ...valid, adapterId: 'unknown-cli' }))
      .toThrow(AgentRuntimeProtocolError);
    expect(() => normalizeAgentTaskStartRequest({ ...valid, executionMode: 'dangerously-close-enough' }))
      .toThrow(AgentRuntimeProtocolError);
    const { modelId: _modelId, ...withoutModel } = valid;
    expect(() => normalizeAgentTaskStartRequest(withoutModel)).toThrow(AgentRuntimeProtocolError);
    for (const modelId of [
      null,
      '',
      '/gpt-5.6',
      ' gpt-5.6',
      'gpt-5.6 ',
      'gpt-5.6;rm',
      '모델-5',
      'a'.repeat(AGENT_RUNTIME_MAX_MODEL_ID_LENGTH + 1),
    ]) {
      expect(() => normalizeAgentTaskStartRequest({ ...valid, modelId }))
        .toThrow(AgentRuntimeProtocolError);
    }
  });

  test('bounds prompt bytes, not only JavaScript character count', () => {
    expect(() => normalizeAgentTaskStartRequest({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'request_12345678',
      targetId: 'project_12345678',
      adapterId: 'codex',
      modelId: 'gpt-5.6-codex',
      executionMode: 'workspace-write',
      prompt: '한'.repeat(Math.floor(AGENT_RUNTIME_MAX_PROMPT_BYTES / 3) + 1),
    })).toThrow(AgentRuntimeProtocolError);
  });
});

describe('Agent Runtime event contract', () => {
  test('records an explicit model or a migrated legacy null only in accepted events', () => {
    expect(normalizeAgentTaskEvent({
      ...base,
      type: 'task.accepted',
      payload: {
        adapterId: 'codex',
        projectLabel: 'AgentsToZ',
        executionMode: 'workspace-write',
        modelId: 'gpt-5.6-codex',
      },
    })).toMatchObject({ payload: { modelId: 'gpt-5.6-codex' } });
    expect(normalizeAgentTaskEvent({
      ...base,
      type: 'task.accepted',
      payload: {
        adapterId: 'codex',
        projectLabel: 'AgentsToZ',
        executionMode: 'workspace-write',
        modelId: null,
      },
    })).toMatchObject({ payload: { modelId: null } });
    expect(() => normalizeAgentTaskEvent({
      ...base,
      type: 'task.accepted',
      payload: {
        adapterId: 'codex',
        projectLabel: 'AgentsToZ',
        executionMode: 'workspace-write',
      },
    })).toThrow(AgentRuntimeProtocolError);
  });

  test('lets only the durable journal attach sequence and time metadata', () => {
    const event = materializeAgentTaskEvent({
      taskId: 'task_12345678',
      seq: 1,
      occurredAt: '2026-09-03T00:00:00.000Z',
      draft: {
        type: 'task.progress',
        payload: { summary: '프로젝트를 분석하고 있습니다.', phase: 'analysis' },
      },
    });
    expect(event.type).toBe('task.progress');
    expect(event.seq).toBe(1);
  });

  test('normalizes semantic progress and approval events', () => {
    expect(normalizeAgentTaskEvent({
      ...base,
      type: 'task.progress',
      payload: { summary: '테스트를 실행하고 있습니다.', phase: 'verify' },
    })).toMatchObject({ type: 'task.progress', payload: { phase: 'verify' } });

    expect(normalizeAgentTaskEvent({
      ...base,
      seq: 2,
      type: 'task.approval.requested',
      payload: {
        approvalId: 'approval_12345678',
        title: '변경 파일을 커밋',
        risk: 'medium',
        expiresAt: '2026-09-03T10:05:00.000Z',
      },
    })).toMatchObject({ type: 'task.approval.requested', payload: { risk: 'medium' } });
  });

  test('rejects unknown event types, future keys, and unsafe approval decisions', () => {
    expect(() => normalizeAgentTaskEvent({ ...base, type: 'pty.output', payload: {} }))
      .toThrow(AgentRuntimeProtocolError);
    expect(() => normalizeAgentTaskEvent({
      ...base,
      type: 'task.result',
      payload: { summary: '완료', fullTranscript: 'must not cross' },
    })).toThrow(AgentRuntimeProtocolError);
    expect(() => normalizeAgentTaskEvent({
      ...base,
      type: 'task.approval.resolved',
      payload: { approvalId: 'approval_12345678', decision: 'allow-always' },
    })).toThrow(AgentRuntimeProtocolError);
  });

  test('rejects forbidden local execution fields recursively', () => {
    expect(() => assertAgentRuntimeRemoteSafe({
      task: { id: 'task_12345678', result: { cwd: '/private/project' } },
    })).toThrow(AgentRuntimeProtocolError);
    expect(() => assertAgentRuntimeRemoteSafe({
      task: { id: 'task_12345678', result: { api_token: 'secret' } },
    })).toThrow(AgentRuntimeProtocolError);
    expect(() => assertAgentRuntimeRemoteSafe({
      task: { id: 'task_12345678', result: { workingDirectory: '/private/project' } },
    })).toThrow(AgentRuntimeProtocolError);
    expect(() => assertAgentRuntimeRemoteSafe({
      tasks: [{ id: 'task_12345678', summary: '완료' }],
    })).not.toThrow();
  });
});
