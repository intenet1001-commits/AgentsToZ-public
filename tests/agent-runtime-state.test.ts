import { describe, expect, test } from 'bun:test';
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentTaskEvent,
  type AgentTaskEventType,
} from '../src/agentRuntimeProtocol';
import {
  AGENT_RUNTIME_EVENT_POLL_BASE_MS,
  AGENT_RUNTIME_EVENT_POLL_MAX_MS,
  AGENT_RUNTIME_EVENT_WINDOW,
  agentTaskDisplayStatus,
  agentTaskEventPollDelay,
  applyAgentTaskEvent,
  applyAgentTaskEventBatch,
  emptyAgentTaskProjection,
  shouldContinueAgentTaskEventPolling,
} from '../src/agentRuntimeState';

function event(seq: number, type: AgentTaskEventType = 'task.progress'): AgentTaskEvent {
  const common = {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    taskId: 'task_12345678',
    seq,
    occurredAt: new Date(1_800_000_000_000 + seq).toISOString(),
  } as const;
  if (type === 'task.accepted') return {
    ...common,
    type,
    payload: {
      adapterId: 'codex',
      projectLabel: 'AgentsToZ',
      modelId: 'gpt-5.6-sol',
      executionMode: 'workspace-write',
    },
  };
  if (type === 'task.started') return { ...common, type, payload: { adapterId: 'codex' } };
  if (type === 'task.question') return { ...common, type, payload: { questionId: `question_${seq}0000000`, prompt: '선택해 주세요.', choices: [] } };
  if (type === 'task.approval.requested') return { ...common, type, payload: { approvalId: `approval_${seq}0000000`, title: '커밋', risk: 'medium', expiresAt: '2027-01-15T08:00:00.000Z' } };
  if (type === 'task.approval.resolved') return { ...common, type, payload: { approvalId: `approval_${seq}0000000`, decision: 'allow-once' } };
  if (type === 'task.artifact.summary') return { ...common, type, payload: { kind: 'test', label: '검증', summary: '통과' } };
  if (type === 'task.result') return { ...common, type, payload: { summary: '완료' } };
  if (type === 'task.failed') return { ...common, type, payload: { code: 'TASK_FAILED', message: '실패', retryable: false } };
  if (type === 'task.cancelled') return { ...common, type, payload: { reason: '사용자가 중지함' } };
  return { ...common, type: 'task.progress', payload: { summary: `진행 ${seq}`, phase: null } };
}

describe('Agent Runtime event projection', () => {
  test('prefers a newer durable task summary until the local event cursor catches up', () => {
    const projection = applyAgentTaskEventBatch(emptyAgentTaskProjection(), [
      event(1, 'task.accepted'),
      event(2, 'task.started'),
    ]);
    expect(agentTaskDisplayStatus({ status: 'succeeded', lastSeq: 3 }, projection)).toBe('succeeded');
    expect(agentTaskDisplayStatus({ status: 'accepted', lastSeq: 1 }, projection)).toBe('running');
    expect(agentTaskDisplayStatus({ status: 'waiting', lastSeq: 2 }, undefined)).toBe('waiting');
  });

  test('stops polling only when a terminal status and its journal cursor are caught up', () => {
    const running = applyAgentTaskEventBatch(emptyAgentTaskProjection(), [
      event(1, 'task.accepted'),
      event(2, 'task.started'),
    ]);
    const succeeded = applyAgentTaskEvent(running, event(3, 'task.result'));

    expect(shouldContinueAgentTaskEventPolling({ status: 'succeeded', lastSeq: 3 }, running)).toBeTrue();
    expect(shouldContinueAgentTaskEventPolling({ status: 'succeeded', lastSeq: 3 }, succeeded)).toBeFalse();
    expect(shouldContinueAgentTaskEventPolling({ status: 'running', lastSeq: 2 }, succeeded)).toBeFalse();
    expect(shouldContinueAgentTaskEventPolling({ status: 'running', lastSeq: 2 }, running)).toBeTrue();
  });

  test('backs off temporary event failures exponentially with a fixed ceiling', () => {
    expect(agentTaskEventPollDelay(0)).toBe(AGENT_RUNTIME_EVENT_POLL_BASE_MS);
    expect(agentTaskEventPollDelay(1)).toBe(AGENT_RUNTIME_EVENT_POLL_BASE_MS * 2);
    expect(agentTaskEventPollDelay(4)).toBe(AGENT_RUNTIME_EVENT_POLL_BASE_MS * 16);
    expect(agentTaskEventPollDelay(5)).toBe(AGENT_RUNTIME_EVENT_POLL_MAX_MS);
    expect(agentTaskEventPollDelay(500)).toBe(AGENT_RUNTIME_EVENT_POLL_MAX_MS);
  });

  test('projects lifecycle states from a contiguous event stream', () => {
    let state = emptyAgentTaskProjection();
    state = applyAgentTaskEventBatch(state, [
      event(1, 'task.accepted'),
      event(2, 'task.started'),
      event(3, 'task.question'),
    ]);
    expect(state).toMatchObject({ taskId: 'task_12345678', status: 'waiting', lastSeq: 3, sync: 'current' });
    state = applyAgentTaskEventBatch(state, [
      event(4, 'task.approval.resolved'),
      event(5, 'task.result'),
    ]);
    expect(state).toMatchObject({ status: 'succeeded', lastSeq: 5, expectedSeq: 6 });
  });

  test('is idempotent for replayed events', () => {
    const once = applyAgentTaskEvent(emptyAgentTaskProjection(), event(1, 'task.accepted'));
    expect(applyAgentTaskEvent(once, event(1, 'task.accepted'))).toBe(once);
  });

  test('stops at a cursor gap and preserves the last known-good state', () => {
    const before = applyAgentTaskEvent(emptyAgentTaskProjection(), event(1, 'task.accepted'));
    const after = applyAgentTaskEventBatch(before, [event(3), event(2)]);
    expect(after).toMatchObject({ status: 'accepted', lastSeq: 1, sync: 'gap', expectedSeq: 2 });
    expect(after.events).toEqual(before.events);
  });

  test('rejects an event for another task instead of merging threads', () => {
    const before = applyAgentTaskEvent(emptyAgentTaskProjection(), event(1, 'task.accepted'));
    expect(() => applyAgentTaskEvent(before, { ...event(2), taskId: 'task_87654321' }))
      .toThrow('AGENT_RUNTIME_TASK_ID_MISMATCH');
  });

  test('bounds the in-memory timeline without changing its monotonic cursor', () => {
    const events = Array.from({ length: AGENT_RUNTIME_EVENT_WINDOW + 25 }, (_, index) => event(index + 1));
    const state = applyAgentTaskEventBatch(emptyAgentTaskProjection(), events);
    expect(state.events).toHaveLength(AGENT_RUNTIME_EVENT_WINDOW);
    expect(state.events[0]?.seq).toBe(26);
    expect(state.lastSeq).toBe(AGENT_RUNTIME_EVENT_WINDOW + 25);
  });
});
