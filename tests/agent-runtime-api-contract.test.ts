import { describe, expect, test } from 'bun:test';
import {
  AGENT_RUNTIME_EVENT_READ_LIMIT,
  AGENT_RUNTIME_MAX_MODELS_PER_ADAPTER,
  normalizeAgentRuntimeCapabilitiesResponse,
  normalizeAgentRuntimeTargetsResponse,
  normalizeAgentRuntimeErrorResponse,
  normalizeAgentTaskCancelRequest,
  normalizeAgentTaskCancelResponse,
  normalizeAgentTaskEventsResponse,
  normalizeAgentTaskListResponse,
  normalizeAgentTaskStartResponse,
} from '../src/agentRuntimeApiContract';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from '../src/agentRuntimeProtocol';

const summary = {
  taskId: 'task_12345678',
  targetId: 'target_12345678',
  projectLabel: 'AgentsToZ',
  adapterId: 'codex',
  modelId: 'gpt-5.6-codex',
  executionMode: 'workspace-write',
  status: 'running',
  lastSeq: 2,
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:01:00.000Z',
} as const;

describe('agent runtime API contract', () => {
  test('normalizes tri-state live capability without claiming unknown is unavailable', () => {
    const response = normalizeAgentRuntimeCapabilitiesResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      adapters: [{
        adapterId: 'codex',
        label: 'Codex',
        availability: 'unknown',
        models: [],
        features: { structuredProgress: true, questions: false, approvals: false, cancellation: true },
      }],
      limits: { maxPromptBytes: 32768, maxConcurrentTasks: 4 },
    });
    expect(response.adapters[0]?.availability).toBe('unknown');
  });

  test('accepts a bounded exact model catalog only for available adapters', () => {
    const available = {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      adapters: [{
        adapterId: 'codex',
        label: 'Codex',
        availability: 'available',
        models: [
          { modelId: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', isDefault: true },
          { modelId: 'openai/gpt-5.5:fast', label: 'GPT-5.5 Fast', isDefault: false },
        ],
        features: { structuredProgress: true, questions: false, approvals: false, cancellation: true },
      }],
      limits: { maxPromptBytes: 32768, maxConcurrentTasks: 4 },
    };
    expect(normalizeAgentRuntimeCapabilitiesResponse(available).adapters[0]?.models)
      .toEqual(available.adapters[0]?.models);

    for (const models of [
      [],
      [{ modelId: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', isDefault: false }],
      [
        { modelId: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', isDefault: true },
        { modelId: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', isDefault: true },
      ],
      [
        { modelId: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', isDefault: true },
        { modelId: 'gpt-5.6-codex', label: 'Duplicate', isDefault: false },
      ],
      Array.from({ length: AGENT_RUNTIME_MAX_MODELS_PER_ADAPTER + 1 }, (_, index) => ({
        modelId: `model-${index}`,
        label: `Model ${index}`,
        isDefault: index === 0,
      })),
    ]) {
      expect(() => normalizeAgentRuntimeCapabilitiesResponse({
        ...available,
        adapters: [{ ...available.adapters[0], models }],
      })).toThrow();
    }
    expect(() => normalizeAgentRuntimeCapabilitiesResponse({
      ...available,
      adapters: [{ ...available.adapters[0], availability: 'unknown', models: available.adapters[0]!.models }],
    })).toThrow();
    expect(() => normalizeAgentRuntimeCapabilitiesResponse({
      ...available,
      adapters: [{ ...available.adapters[0], models: [{
        modelId: 'gpt-5.6-codex',
        label: 'GPT-5.6 Codex',
        isDefault: true,
        providerConfig: '/private/config.toml',
      }] }],
    })).toThrow();
  });

  test('accepts exact task list and mutation shapes', () => {
    expect(normalizeAgentTaskListResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      tasks: [summary],
    }).tasks[0]?.taskId).toBe(summary.taskId);
    expect(normalizeAgentTaskStartResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      duplicate: false,
      task: summary,
    }).duplicate).toBe(false);
    expect(normalizeAgentTaskCancelRequest({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'cancel_12345678',
    }).requestId).toBe('cancel_12345678');
    expect(normalizeAgentTaskCancelResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      task: { ...summary, status: 'cancelled' },
    }).task.status).toBe('cancelled');
  });

  test('accepts only path-free registered project and Git worktree targets', () => {
    const response = normalizeAgentRuntimeTargetsResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      targets: [
        {
          targetId: 'project_12345678',
          projectTargetId: 'project_12345678',
          label: 'AgentsToZ',
          scope: 'main',
          branch: 'main',
          locked: false,
          worktreeCapable: true,
        },
        {
          targetId: 'rwt_1234567890abcdef1234567890abcdef1234567890abcdef',
          projectTargetId: 'project_12345678',
          label: 'AgentsToZ · runtime',
          scope: 'worktree',
          branch: 'runtime',
          locked: false,
          worktreeCapable: true,
        },
      ],
      complete: true,
    });
    expect(response.targets[1]?.projectTargetId).toBe('project_12345678');
    expect(() => normalizeAgentRuntimeTargetsResponse({
      ...response,
      targets: [{ ...response.targets[0], cwd: '/private/project' }],
    })).toThrow();
    expect(() => normalizeAgentRuntimeTargetsResponse({
      ...response,
      targets: [{ ...response.targets[1], worktreeCapable: false }],
    })).toThrow();
  });

  test('requires contiguous events and an exact next cursor', () => {
    const accepted = {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: summary.taskId,
      seq: 1,
      occurredAt: summary.createdAt,
      type: 'task.accepted',
      payload: {
        adapterId: 'codex',
        projectLabel: 'AgentsToZ',
        executionMode: 'workspace-write',
        modelId: 'gpt-5.6-codex',
      },
    };
    expect(normalizeAgentTaskEventsResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: summary.taskId,
      after: 0,
      nextCursor: 1,
      events: [accepted],
    }).nextCursor).toBe(1);
    expect(() => normalizeAgentTaskEventsResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: summary.taskId,
      after: 0,
      nextCursor: 2,
      events: [accepted],
    })).toThrow();
  });

  test('keeps a worst-case valid event page below the desktop response ceiling', () => {
    const events = Array.from({ length: AGENT_RUNTIME_EVENT_READ_LIMIT }, (_, index) => ({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: summary.taskId,
      seq: index + 1,
      occurredAt: summary.createdAt,
      type: 'task.progress',
      payload: { summary: '\u0001'.repeat(8 * 1024), phase: null },
    }));
    const normalized = normalizeAgentTaskEventsResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: summary.taskId,
      after: 0,
      nextCursor: AGENT_RUNTIME_EVENT_READ_LIMIT,
      events,
    });
    expect(normalized.events).toHaveLength(AGENT_RUNTIME_EVENT_READ_LIMIT);
    expect(new TextEncoder().encode(JSON.stringify(normalized)).byteLength)
      .toBeLessThan(3 * 1024 * 1024);
    expect(() => normalizeAgentTaskEventsResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: summary.taskId,
      after: 0,
      nextCursor: AGENT_RUNTIME_EVENT_READ_LIMIT + 1,
      events: [...events, { ...events[0], seq: AGENT_RUNTIME_EVENT_READ_LIMIT + 1 }],
    })).toThrow();
  });

  test('rejects unknown fields and path-like data at the API boundary', () => {
    expect(() => normalizeAgentTaskListResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      tasks: [{ ...summary, cwd: '/private/project' }],
    })).toThrow();
    expect(() => normalizeAgentTaskStartResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      duplicate: false,
      task: summary,
      pid: 42,
    })).toThrow();
  });

  test('accepts only bounded, exact public error responses', () => {
    expect(normalizeAgentRuntimeErrorResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      ok: false,
      code: 'TARGET_NOT_FOUND',
      error: '등록된 프로젝트를 찾지 못했습니다.',
    }).code).toBe('TARGET_NOT_FOUND');
    expect(() => normalizeAgentRuntimeErrorResponse({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      ok: false,
      code: 'TARGET_NOT_FOUND',
      error: '등록된 프로젝트를 찾지 못했습니다.',
      cwd: '/private/project',
    })).toThrow();
  });
});
