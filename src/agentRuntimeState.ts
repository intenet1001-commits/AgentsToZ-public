import {
  normalizeAgentTaskEvent,
  type AgentTaskEvent,
  type AgentTaskStatus,
} from './agentRuntimeProtocol';

export const AGENT_RUNTIME_EVENT_WINDOW = 500;
export const AGENT_RUNTIME_EVENT_POLL_BASE_MS = 1_500;
export const AGENT_RUNTIME_EVENT_POLL_MAX_MS = 30_000;

const TERMINAL_TASK_STATUSES: readonly AgentTaskStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface AgentTaskProjection {
  taskId: string | null;
  status: AgentTaskStatus;
  lastSeq: number;
  events: readonly AgentTaskEvent[];
  sync: 'current' | 'gap';
  expectedSeq: number;
}

export interface AgentTaskCursorSummary {
  status: AgentTaskStatus;
  lastSeq: number;
}

export function emptyAgentTaskProjection(): AgentTaskProjection {
  return {
    taskId: null,
    status: 'unknown',
    lastSeq: 0,
    events: [],
    sync: 'current',
    expectedSeq: 1,
  };
}

/**
 * The task list is the newer source of truth while its durable journal cursor
 * is ahead of the locally projected timeline. Once the timeline catches up,
 * its event-derived state can take over without briefly regressing the UI.
 */
export function agentTaskDisplayStatus(
  task: AgentTaskCursorSummary,
  projection: AgentTaskProjection | undefined,
): AgentTaskStatus {
  if (!projection || projection.status === 'unknown' || task.lastSeq > projection.lastSeq) {
    return task.status;
  }
  return projection.status;
}

/** Stop polling only after a terminal state and its durable cursor are both visible. */
export function shouldContinueAgentTaskEventPolling(
  task: AgentTaskCursorSummary | undefined,
  projection: AgentTaskProjection | undefined,
): boolean {
  if (!task || !projection) return true;
  if (projection.lastSeq < task.lastSeq) return true;
  return !TERMINAL_TASK_STATUSES.includes(task.status)
    && !TERMINAL_TASK_STATUSES.includes(projection.status);
}

/** Exponential retry delay with a bounded ceiling for temporary API failures. */
export function agentTaskEventPollDelay(consecutiveFailures: number): number {
  const failures = Number.isFinite(consecutiveFailures)
    ? Math.max(0, Math.floor(consecutiveFailures))
    : 0;
  return Math.min(
    AGENT_RUNTIME_EVENT_POLL_MAX_MS,
    AGENT_RUNTIME_EVENT_POLL_BASE_MS * (2 ** Math.min(failures, 20)),
  );
}

function statusAfter(event: AgentTaskEvent): AgentTaskStatus {
  switch (event.type) {
    case 'task.accepted': return 'accepted';
    case 'task.started':
    case 'task.progress':
    case 'task.artifact.summary': return 'running';
    case 'task.question':
    case 'task.approval.requested': return 'waiting';
    case 'task.approval.resolved': return 'running';
    case 'task.result': return 'succeeded';
    case 'task.failed': return 'failed';
    case 'task.cancelled': return 'cancelled';
  }
}

/**
 * Applies one event without ever advancing across a missing sequence.
 * Duplicates are idempotent; a gap preserves the last known-good projection so
 * reconnect code can fetch from `lastSeq` instead of silently losing history.
 */
export function applyAgentTaskEvent(
  state: AgentTaskProjection,
  input: unknown,
): AgentTaskProjection {
  const event = normalizeAgentTaskEvent(input);
  if (state.taskId && event.taskId !== state.taskId) {
    throw new Error('AGENT_RUNTIME_TASK_ID_MISMATCH');
  }
  if (event.seq <= state.lastSeq) return state;
  const expectedSeq = state.lastSeq + 1;
  if (event.seq !== expectedSeq) {
    return { ...state, sync: 'gap', expectedSeq };
  }
  const events = [...state.events, event].slice(-AGENT_RUNTIME_EVENT_WINDOW);
  return {
    taskId: state.taskId ?? event.taskId,
    status: statusAfter(event),
    lastSeq: event.seq,
    events,
    sync: 'current',
    expectedSeq: event.seq + 1,
  };
}

export function applyAgentTaskEventBatch(
  state: AgentTaskProjection,
  events: readonly unknown[],
): AgentTaskProjection {
  let next = state;
  for (const event of events) {
    const candidate = applyAgentTaskEvent(next, event);
    next = candidate;
    if (candidate.sync === 'gap') break;
  }
  return next;
}
