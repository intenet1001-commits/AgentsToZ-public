import { isBuiltinAgentRuntimeId, type BuiltinAgentRuntimeId } from './agentRuntimeRegistry';

/** Semantic task protocol shared by the local app and future remote clients. */
export const AGENT_RUNTIME_PROTOCOL_VERSION = 'agentstoz-tasks-v2' as const;
// Production task execution remains fail-closed until the host can prove that
// every descendant loses workspace write access when a task, guard, or sidecar
// exits. A PGID guard is lifecycle bookkeeping, not that security boundary:
// workspace-write code can still create a detached session/new PGID.
export const AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED = false as const;
// Retained Codex conversations may run before writable task containment is
// ready, but only with Codex's read-only sandbox and approval policy `never`.
// This flag must never be used to authorize AgentTaskExecutionMode starts.
export const AGENT_RUNTIME_READ_ONLY_CONVERSATIONS_ENABLED = true as const;
// A POSIX process group is not an OS-enforced process container: unrestricted
// code can call setsid()/setpgid() and outlive the guard. Keep the wire value
// readable for durable history, but reject new managed executions until each
// supported platform has a containment primitive (for example cgroup v2 or a
// Windows Job Object) that cannot be escaped by the provider.
export const AGENT_RUNTIME_DANGEROUS_MODE_ENABLED = false as const;
export const AGENT_RUNTIME_MAX_PROMPT_BYTES = 32 * 1024;
export const AGENT_RUNTIME_MAX_TEXT_LENGTH = 8 * 1024;
export const AGENT_RUNTIME_MAX_MODEL_ID_LENGTH = 128;

export type AgentTaskExecutionMode =
  | 'workspace-write'
  | 'dangerously-bypass-approvals-and-sandbox';

export type AgentTaskStatus =
  | 'accepted'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type AgentTaskEventType =
  | 'task.accepted'
  | 'task.started'
  | 'task.progress'
  | 'task.question'
  | 'task.approval.requested'
  | 'task.approval.resolved'
  | 'task.artifact.summary'
  | 'task.result'
  | 'task.failed'
  | 'task.cancelled';

interface AgentTaskEventBase<TType extends AgentTaskEventType, TPayload> {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  taskId: string;
  seq: number;
  occurredAt: string;
  type: TType;
  payload: TPayload;
}

export type AgentTaskEvent =
  | AgentTaskEventBase<'task.accepted', {
      adapterId: BuiltinAgentRuntimeId;
      projectLabel: string;
      executionMode: AgentTaskExecutionMode;
      /** Null is reserved for tasks migrated from the pre-model-selection journal. */
      modelId: string | null;
    }>
  | AgentTaskEventBase<'task.started', {
      adapterId: BuiltinAgentRuntimeId;
    }>
  | AgentTaskEventBase<'task.progress', {
      summary: string;
      phase: string | null;
    }>
  | AgentTaskEventBase<'task.question', {
      questionId: string;
      prompt: string;
      choices: string[];
    }>
  | AgentTaskEventBase<'task.approval.requested', {
      approvalId: string;
      title: string;
      risk: 'low' | 'medium' | 'high';
      expiresAt: string;
    }>
  | AgentTaskEventBase<'task.approval.resolved', {
      approvalId: string;
      decision: 'allow-once' | 'deny';
    }>
  | AgentTaskEventBase<'task.artifact.summary', {
      kind: 'diff' | 'test' | 'commit' | 'memory' | 'other';
      label: string;
      summary: string;
    }>
  | AgentTaskEventBase<'task.result', {
      summary: string;
    }>
  | AgentTaskEventBase<'task.failed', {
      code: string;
      message: string;
      retryable: boolean;
    }>
  | AgentTaskEventBase<'task.cancelled', {
      reason: string;
    }>;

export type AgentTaskEventDraft = AgentTaskEvent extends infer TEvent
  ? TEvent extends AgentTaskEvent
    ? Pick<TEvent, 'type' | 'payload'>
    : never
  : never;

export interface AgentTaskStartRequest {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  /** Client-generated idempotency key. */
  requestId: string;
  /** Opaque registered-project or registered-worktree id. Never a path. */
  targetId: string;
  adapterId: BuiltinAgentRuntimeId;
  /** Explicit provider model selected for this task. */
  modelId: string;
  /** Local-only V2 choice. Remote transports must reject the dangerous value. */
  executionMode: AgentTaskExecutionMode;
  prompt: string;
}

export class AgentRuntimeProtocolError extends Error {
  readonly code = 'AGENT_RUNTIME_PROTOCOL_INVALID';

  constructor(message = '에이전트 런타임 메시지가 올바르지 않습니다.') {
    super(message);
    this.name = 'AgentRuntimeProtocolError';
  }
}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

function invalid(message?: string): never {
  throw new AgentRuntimeProtocolError(message);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function identifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length >= 8 && normalized.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(normalized)
    ? normalized
    : null;
}

/** A bounded public identifier, never a provider command, path, or config blob. */
export function normalizeAgentRuntimeModelId(value: unknown): string {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > AGENT_RUNTIME_MAX_MODEL_ID_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    return invalid('에이전트 런타임 모델 식별자가 올바르지 않습니다.');
  }
  return value;
}

function boundedText(value: unknown, maxLength = AGENT_RUNTIME_MAX_TEXT_LENGTH): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) return null;
  if (value.includes('\u0000')) return null;
  return value;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function baseEvent(value: unknown): {
  raw: JsonObject;
  taskId: string;
  seq: number;
  occurredAt: string;
  type: AgentTaskEventType;
  payload: JsonObject;
} {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, ['protocolVersion', 'taskId', 'seq', 'occurredAt', 'type', 'payload'])) invalid();
  if (raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION) invalid();
  const taskId = identifier(raw.taskId) ?? invalid();
  const seq = typeof raw.seq === 'number' && Number.isSafeInteger(raw.seq) && raw.seq >= 1
    ? raw.seq
    : invalid();
  const occurredAt = isoDate(raw.occurredAt) ?? invalid();
  const allowedTypes: readonly AgentTaskEventType[] = [
    'task.accepted', 'task.started', 'task.progress', 'task.question',
    'task.approval.requested', 'task.approval.resolved', 'task.artifact.summary',
    'task.result', 'task.failed', 'task.cancelled',
  ];
  const type = typeof raw.type === 'string' && allowedTypes.includes(raw.type as AgentTaskEventType)
    ? raw.type as AgentTaskEventType
    : invalid();
  const payload = asObject(raw.payload) ?? invalid();
  return { raw, taskId, seq, occurredAt, type, payload };
}

function normalizedBase<T extends AgentTaskEventType, P>(
  event: ReturnType<typeof baseEvent>,
  type: T,
  payload: P,
): AgentTaskEventBase<T, P> {
  return {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    taskId: event.taskId,
    seq: event.seq,
    occurredAt: event.occurredAt,
    type,
    payload,
  };
}

export function normalizeAgentTaskStartRequest(value: unknown): AgentTaskStartRequest {
  const raw = asObject(value) ?? invalid();
  if (!hasExactKeys(raw, [
    'protocolVersion', 'requestId', 'targetId', 'adapterId', 'modelId', 'executionMode', 'prompt',
  ])) invalid();
  if (raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION) invalid();
  const requestId = identifier(raw.requestId) ?? invalid();
  const targetId = identifier(raw.targetId) ?? invalid();
  if (!isBuiltinAgentRuntimeId(raw.adapterId)) invalid();
  const modelId = normalizeAgentRuntimeModelId(raw.modelId);
  const executionMode: AgentTaskExecutionMode = raw.executionMode === 'workspace-write'
    || raw.executionMode === 'dangerously-bypass-approvals-and-sandbox'
    ? raw.executionMode
    : invalid();
  const prompt = boundedText(raw.prompt, AGENT_RUNTIME_MAX_PROMPT_BYTES) ?? invalid();
  if (new TextEncoder().encode(prompt).byteLength > AGENT_RUNTIME_MAX_PROMPT_BYTES) invalid();
  return {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    requestId,
    targetId,
    adapterId: raw.adapterId,
    modelId,
    executionMode,
    prompt,
  };
}

export function normalizeAgentTaskEvent(value: unknown): AgentTaskEvent {
  const event = baseEvent(value);
  const p = event.payload;
  switch (event.type) {
    case 'task.accepted': {
      if (!hasExactKeys(p, ['adapterId', 'projectLabel', 'executionMode', 'modelId'])
        || !isBuiltinAgentRuntimeId(p.adapterId)) invalid();
      const projectLabel = boundedText(p.projectLabel, 120) ?? invalid();
      const modelId = p.modelId === null ? null : normalizeAgentRuntimeModelId(p.modelId);
      const executionMode: AgentTaskExecutionMode = p.executionMode === 'workspace-write'
        || p.executionMode === 'dangerously-bypass-approvals-and-sandbox'
        ? p.executionMode
        : invalid();
      return normalizedBase(event, event.type, {
        adapterId: p.adapterId,
        projectLabel,
        executionMode,
        modelId,
      });
    }
    case 'task.started': {
      if (!hasExactKeys(p, ['adapterId']) || !isBuiltinAgentRuntimeId(p.adapterId)) invalid();
      return normalizedBase(event, event.type, { adapterId: p.adapterId });
    }
    case 'task.progress': {
      if (!hasExactKeys(p, ['summary', 'phase'])) invalid();
      const summary = boundedText(p.summary) ?? invalid();
      const phase = p.phase === null ? null : boundedText(p.phase, 80) ?? invalid();
      return normalizedBase(event, event.type, { summary, phase });
    }
    case 'task.question': {
      if (!hasExactKeys(p, ['questionId', 'prompt', 'choices'])) invalid();
      const questionId = identifier(p.questionId) ?? invalid();
      const prompt = boundedText(p.prompt) ?? invalid();
      if (!Array.isArray(p.choices) || p.choices.length > 8) invalid();
      const choices = p.choices.map(choice => boundedText(choice, 240) ?? invalid());
      if (new Set(choices).size !== choices.length) invalid();
      return normalizedBase(event, event.type, { questionId, prompt, choices });
    }
    case 'task.approval.requested': {
      if (!hasExactKeys(p, ['approvalId', 'title', 'risk', 'expiresAt'])) invalid();
      const approvalId = identifier(p.approvalId) ?? invalid();
      const title = boundedText(p.title, 500) ?? invalid();
      const risk: 'low' | 'medium' | 'high' =
        p.risk === 'low' || p.risk === 'medium' || p.risk === 'high' ? p.risk : invalid();
      const expiresAt = isoDate(p.expiresAt) ?? invalid();
      return normalizedBase(event, event.type, { approvalId, title, risk, expiresAt });
    }
    case 'task.approval.resolved': {
      if (!hasExactKeys(p, ['approvalId', 'decision'])) invalid();
      const approvalId = identifier(p.approvalId) ?? invalid();
      const decision: 'allow-once' | 'deny' =
        p.decision === 'allow-once' || p.decision === 'deny' ? p.decision : invalid();
      return normalizedBase(event, event.type, { approvalId, decision });
    }
    case 'task.artifact.summary': {
      if (!hasExactKeys(p, ['kind', 'label', 'summary'])) invalid();
      const allowedKinds = ['diff', 'test', 'commit', 'memory', 'other'] as const;
      const kind = typeof p.kind === 'string' && allowedKinds.includes(p.kind as typeof allowedKinds[number])
        ? p.kind as typeof allowedKinds[number]
        : invalid();
      const label = boundedText(p.label, 160) ?? invalid();
      const summary = boundedText(p.summary) ?? invalid();
      return normalizedBase(event, event.type, { kind, label, summary });
    }
    case 'task.result': {
      if (!hasExactKeys(p, ['summary'])) invalid();
      const summary = boundedText(p.summary) ?? invalid();
      return normalizedBase(event, event.type, { summary });
    }
    case 'task.failed': {
      if (!hasExactKeys(p, ['code', 'message', 'retryable'])) invalid();
      const code = typeof p.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(p.code) ? p.code : invalid();
      const message = boundedText(p.message) ?? invalid();
      if (typeof p.retryable !== 'boolean') invalid();
      return normalizedBase(event, event.type, { code, message, retryable: p.retryable });
    }
    case 'task.cancelled': {
      if (!hasExactKeys(p, ['reason'])) invalid();
      const reason = boundedText(p.reason, 500) ?? invalid();
      return normalizedBase(event, event.type, { reason });
    }
  }
}

/** The durable journal, not an adapter, owns sequence and wall-clock metadata. */
export function materializeAgentTaskEvent(input: {
  taskId: string;
  seq: number;
  occurredAt: string;
  draft: AgentTaskEventDraft;
}): AgentTaskEvent {
  return normalizeAgentTaskEvent({
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    taskId: input.taskId,
    seq: input.seq,
    occurredAt: input.occurredAt,
    type: input.draft.type,
    payload: input.draft.payload,
  });
}

/** Fields that must never cross the semantic remote-control boundary. */
export const AGENT_RUNTIME_REMOTE_FORBIDDEN_KEYS = Object.freeze([
  'path', 'folderPath', 'worktreePath', 'canonicalPath', 'cwd', 'memoryId',
  'command', 'executable', 'argv', 'shell', 'env', 'envOverrides', 'pid',
  'stdin', 'stdout', 'stderr', 'pty', 'token', 'credential', 'secret',
  'apiKey', 'apiToken', 'authToken', 'accessToken', 'sessionToken',
  'authorization', 'cookie', 'privateKey',
  'commandLine', 'processId', 'workingDirectory', 'rawOutput', 'transcript',
] as const);

const AGENT_RUNTIME_REMOTE_FORBIDDEN_NORMALIZED_KEYS = new Set(
  AGENT_RUNTIME_REMOTE_FORBIDDEN_KEYS.map(key => key.replace(/[-_]/g, '').toLowerCase()),
);

export function assertAgentRuntimeRemoteSafe(value: unknown): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return;
    if (seen.has(candidate as object)) invalid();
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(candidate as JsonObject)) {
      const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
      if (AGENT_RUNTIME_REMOTE_FORBIDDEN_NORMALIZED_KEYS.has(normalizedKey)) {
        invalid('에이전트 런타임 응답에 원격 전송 금지 필드가 포함되어 있습니다.');
      }
      visit(child);
    }
  };
  visit(value);
}
