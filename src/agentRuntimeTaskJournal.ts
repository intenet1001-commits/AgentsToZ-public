import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  AGENT_RUNTIME_EVENT_READ_LIMIT,
  AGENT_RUNTIME_TASK_LIST_LIMIT,
  normalizeAgentTaskSummary,
  type AgentTaskSummary,
} from './agentRuntimeApiContract';
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  AgentRuntimeProtocolError,
  assertAgentRuntimeRemoteSafe,
  normalizeAgentTaskEvent,
  normalizeAgentRuntimeModelId,
  normalizeAgentTaskStartRequest,
  type AgentTaskEvent,
  type AgentTaskEventDraft as SharedAgentTaskEventDraft,
  type AgentTaskStatus,
  type AgentTaskStartRequest,
} from './agentRuntimeProtocol';
import type { BuiltinAgentRuntimeId } from './agentRuntimeRegistry';

export const AGENT_RUNTIME_TASK_JOURNAL_SCHEMA_VERSION = 3;
export const AGENT_RUNTIME_MAX_EVENT_JSON_BYTES = 64 * 1024;
const AGENT_RUNTIME_EVENT_MIGRATION_BATCH_SIZE = 256;
/**
 * Reserve the final sequence slot for a terminal event. This prevents a noisy
 * provider from growing one task journal without bound while still allowing
 * the supervisor to record why execution stopped.
 */
export const AGENT_RUNTIME_MAX_EVENTS_PER_TASK = 512;
export const AGENT_RUNTIME_MAX_PROVIDER_ID_BYTES = 512;
export const AGENT_RUNTIME_DEFAULT_TERMINAL_TASK_KEEP = 500;
export const AGENT_RUNTIME_MAX_TERMINAL_TASK_KEEP = 5_000;
/** Request tombstones outlive the maximum planned 30-day remote session. */
export const AGENT_RUNTIME_REQUEST_TOMBSTONE_TTL_MS = 35 * 24 * 60 * 60 * 1_000;

const DEFAULT_TASK_LIST_LIMIT = 50;
const DEFAULT_EVENT_READ_LIMIT = AGENT_RUNTIME_EVENT_READ_LIMIT;
const TASK_STATUSES: readonly AgentTaskStatus[] = [
  'accepted',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
];
const TERMINAL_STATUSES = new Set<AgentTaskStatus>(['succeeded', 'failed', 'cancelled']);

type JsonObject = Record<string, unknown>;

/** A semantic adapter event. The journal alone owns its durable envelope and sequence. */
export type AgentTaskEventDraft = SharedAgentTaskEventDraft;

export interface CreateAgentRuntimeTaskInput extends AgentTaskStartRequest {
  /** Display-only registered-project label; never a local path. */
  projectLabel: string;
}

export interface AgentTaskProviderIds {
  threadId?: string;
  turnId?: string;
}

/** Internal-only launch material. Do not serialize this object to remote clients. */
export interface AgentTaskExecutionRecord {
  taskId: string;
  requestId: string;
  targetId: string;
  projectLabel: string;
  adapterId: BuiltinAgentRuntimeId;
  /** Null is reserved for rows migrated from a pre-model-selection journal. */
  modelId: string | null;
  executionMode: AgentTaskStartRequest['executionMode'];
  status: AgentTaskStatus;
  prompt: string;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  threadId: string | null;
  turnId: string | null;
}

export interface CreateOrGetAgentRuntimeTaskResult {
  duplicate: boolean;
  task: AgentTaskSummary;
}

export type AgentRuntimeTaskJournalErrorCode =
  | 'AGENT_RUNTIME_JOURNAL_CLOSED'
  | 'AGENT_RUNTIME_JOURNAL_CORRUPT'
  | 'AGENT_RUNTIME_JOURNAL_FUTURE_SCHEMA'
  | 'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT'
  | 'AGENT_RUNTIME_REQUEST_CONFLICT'
  | 'AGENT_RUNTIME_REQUEST_RETIRED'
  | 'AGENT_RUNTIME_CANCEL_REQUEST_CONFLICT'
  | 'AGENT_RUNTIME_TASK_NOT_FOUND'
  | 'AGENT_RUNTIME_TASK_TERMINAL'
  | 'AGENT_RUNTIME_EVENT_LIMIT'
  | 'AGENT_RUNTIME_EVENT_TRANSITION_INVALID'
  | 'AGENT_RUNTIME_PROVIDER_ID_CONFLICT'
  | 'AGENT_RUNTIME_ACTIVE_TASK_DELETE_FORBIDDEN';

export class AgentRuntimeTaskJournalError extends Error {
  constructor(
    readonly code: AgentRuntimeTaskJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeTaskJournalError';
  }
}

interface TaskRow {
  task_id: unknown;
  request_id: unknown;
  target_id: unknown;
  project_label: unknown;
  adapter_id: unknown;
  model_id: unknown;
  execution_mode: unknown;
  status: unknown;
  prompt: unknown;
  last_seq: unknown;
  created_at: unknown;
  updated_at: unknown;
  started_at: unknown;
  finished_at: unknown;
  provider_thread_id: unknown;
  provider_turn_id: unknown;
}

interface EventRow {
  task_id: unknown;
  seq: unknown;
  event_json: unknown;
}

interface RequestTombstoneRow {
  intent_fingerprint: unknown;
  expires_at: unknown;
}

interface CancellationRequestRow {
  request_id: unknown;
  task_id: unknown;
  created_at: unknown;
  expires_at: unknown;
}

function fail(code: AgentRuntimeTaskJournalErrorCode, message: string): never {
  throw new AgentRuntimeTaskJournalError(code, message);
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function hasExactKeys(value: JsonObject, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function opaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    return fail('AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT', `${field} must be an opaque identifier.`);
  }
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 128 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    return fail('AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT', `${field} must be an opaque identifier.`);
  }
  return normalized;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    return fail('AGENT_RUNTIME_JOURNAL_CORRUPT', `${field} is not a valid timestamp.`);
  }
  return value;
}

function safeSequence(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return fail('AGENT_RUNTIME_JOURNAL_CORRUPT', `${field} is not a safe sequence number.`);
  }
  return value;
}

function boundedLimit(value: unknown, fallback: number, maximum: number, field: string): number {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate)
    || candidate < 1 || candidate > maximum) {
    return fail(
      'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT',
      `${field} must be an integer between 1 and ${maximum}.`,
    );
  }
  return candidate;
}

function boundedTerminalKeep(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 0 || value > AGENT_RUNTIME_MAX_TERMINAL_TASK_KEEP) {
    return fail(
      'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT',
      `keep must be an integer between 0 and ${AGENT_RUNTIME_MAX_TERMINAL_TASK_KEEP}.`,
    );
  }
  return value;
}

function providerId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)
    || new TextEncoder().encode(value).byteLength > AGENT_RUNTIME_MAX_PROVIDER_ID_BYTES) {
    return fail('AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT', `${field} is not a valid provider identifier.`);
  }
  return value;
}

function nullableProviderId(value: unknown, field: string): string | null {
  return value === null ? null : providerId(value, field);
}

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(now: string, milliseconds: number): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    return fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The journal clock returned an invalid timestamp.');
  }
  return new Date(timestamp + milliseconds).toISOString();
}

function intentFingerprint(input: {
  requestId: string;
  targetId: string;
  adapterId: BuiltinAgentRuntimeId;
  modelId: string | null;
  executionMode: AgentTaskStartRequest['executionMode'];
  prompt: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([
      input.requestId,
      input.targetId,
      input.adapterId,
      input.modelId,
      input.executionMode,
      input.prompt,
    ]), 'utf8')
    .digest('hex');
}

function runImmediateTransaction<T>(database: Database, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the operation error; a rollback failure is only secondary evidence.
    }
    throw error;
  }
}

function statusAfter(event: AgentTaskEvent): AgentTaskStatus {
  switch (event.type) {
    case 'task.accepted': return 'accepted';
    case 'task.started':
    case 'task.progress':
    case 'task.approval.resolved':
    case 'task.artifact.summary': return 'running';
    case 'task.question':
    case 'task.approval.requested': return 'waiting';
    case 'task.result': return 'succeeded';
    case 'task.failed': return 'failed';
    case 'task.cancelled': return 'cancelled';
  }
}

function assertTransition(status: AgentTaskStatus, event: AgentTaskEvent): void {
  if (event.type === 'task.accepted') {
    fail('AGENT_RUNTIME_EVENT_TRANSITION_INVALID', 'task.accepted is written only with the create intent.');
  }
  if (TERMINAL_STATUSES.has(status)) {
    fail('AGENT_RUNTIME_TASK_TERMINAL', 'A terminal task cannot accept more events.');
  }
  if (status === 'accepted' && ![
    'task.started', 'task.failed', 'task.cancelled',
  ].includes(event.type)) {
    fail('AGENT_RUNTIME_EVENT_TRANSITION_INVALID', 'The task must start before emitting execution events.');
  }
  if (status === 'running' && event.type === 'task.started') {
    fail('AGENT_RUNTIME_EVENT_TRANSITION_INVALID', 'The task has already started.');
  }
  if (status === 'waiting' && event.type === 'task.started') {
    fail('AGENT_RUNTIME_EVENT_TRANSITION_INVALID', 'A waiting task cannot start again.');
  }
  if (status === 'unknown') {
    fail('AGENT_RUNTIME_EVENT_TRANSITION_INVALID', 'An unknown task state must be reconciled before appending.');
  }
}

function eventJson(event: AgentTaskEvent): string {
  assertAgentRuntimeRemoteSafe(event);
  const serialized = JSON.stringify(event);
  if (new TextEncoder().encode(serialized).byteLength > AGENT_RUNTIME_MAX_EVENT_JSON_BYTES) {
    throw new AgentRuntimeProtocolError('에이전트 런타임 이벤트가 저장 한도를 초과했습니다.');
  }
  return serialized;
}

function executionFromRow(row: TaskRow | null): AgentTaskExecutionRecord | null {
  if (!row) return null;
  const modelId = row.model_id === null ? null : normalizeAgentRuntimeModelId(row.model_id);
  const request = normalizeAgentTaskStartRequest({
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    requestId: row.request_id,
    targetId: row.target_id,
    adapterId: row.adapter_id,
    // The placeholder is validation-only. Migrated rows keep the null below.
    modelId: modelId ?? 'legacy',
    executionMode: row.execution_mode,
    prompt: row.prompt,
  });
  if (typeof row.project_label !== 'string' || !row.project_label.trim()
    || row.project_label.length > 120 || row.project_label.includes('\u0000')) {
    return fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'project_label is invalid.');
  }
  if (typeof row.status !== 'string' || !TASK_STATUSES.includes(row.status as AgentTaskStatus)) {
    return fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'status is invalid.');
  }
  const execution: AgentTaskExecutionRecord = {
    taskId: opaqueId(row.task_id, 'task_id'),
    requestId: request.requestId,
    targetId: request.targetId,
    projectLabel: row.project_label,
    adapterId: request.adapterId,
    modelId,
    executionMode: request.executionMode,
    status: row.status as AgentTaskStatus,
    prompt: request.prompt,
    lastSeq: safeSequence(row.last_seq, 'last_seq', 1),
    createdAt: isoDate(row.created_at, 'created_at'),
    updatedAt: isoDate(row.updated_at, 'updated_at'),
    startedAt: row.started_at === null ? null : isoDate(row.started_at, 'started_at'),
    finishedAt: row.finished_at === null ? null : isoDate(row.finished_at, 'finished_at'),
    threadId: nullableProviderId(row.provider_thread_id, 'provider_thread_id'),
    turnId: nullableProviderId(row.provider_turn_id, 'provider_turn_id'),
  };
  return execution;
}

function summaryFromExecution(execution: AgentTaskExecutionRecord): AgentTaskSummary {
  return normalizeAgentTaskSummary({
    taskId: execution.taskId,
    targetId: execution.targetId,
    projectLabel: execution.projectLabel,
    adapterId: execution.adapterId,
    modelId: execution.modelId,
    executionMode: execution.executionMode,
    status: execution.status,
    lastSeq: execution.lastSeq,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
  });
}

function parseEventRow(row: EventRow): AgentTaskEvent {
  const taskId = opaqueId(row.task_id, 'event.task_id');
  const seq = safeSequence(row.seq, 'event.seq', 1);
  if (typeof row.event_json !== 'string'
    || new TextEncoder().encode(row.event_json).byteLength > AGENT_RUNTIME_MAX_EVENT_JSON_BYTES) {
    return fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'event_json is invalid.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.event_json);
  } catch {
    return fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'event_json is not valid JSON.');
  }
  assertAgentRuntimeRemoteSafe(decoded);
  const event = normalizeAgentTaskEvent(decoded);
  if (event.taskId !== taskId || event.seq !== seq) {
    return fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The event envelope does not match its journal cursor.');
  }
  return event;
}

function prepareDatabasePath(path: string): void {
  if (path === ':memory:') return;
  if (!path.trim()) fail('AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT', 'A journal database path is required.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT', 'The journal database must be a regular file.');
    }
  }
}

function applyPrivateDatabasePermissions(path: string): void {
  if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
}

function createSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_runtime_journal_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runtime_tasks (
      task_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      target_id TEXT NOT NULL,
      project_label TEXT NOT NULL,
      adapter_id TEXT NOT NULL CHECK (adapter_id IN ('claude', 'codex', 'agy', 'hermes')),
      model_id TEXT CHECK (
        model_id IS NULL OR (
          length(model_id) BETWEEN 1 AND 128
          AND substr(model_id, 1, 1) GLOB '[A-Za-z0-9]'
          AND model_id NOT GLOB '*[^A-Za-z0-9._:/-]*'
        )
      ),
      execution_mode TEXT NOT NULL CHECK (execution_mode IN (
        'workspace-write', 'dangerously-bypass-approvals-and-sandbox'
      )),
      status TEXT NOT NULL CHECK (status IN (
        'accepted', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'unknown'
      )),
      prompt TEXT NOT NULL,
      last_seq INTEGER NOT NULL CHECK (last_seq >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      provider_thread_id TEXT,
      provider_turn_id TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_runtime_tasks_updated_idx
      ON agent_runtime_tasks(updated_at DESC, task_id ASC);
    CREATE TABLE IF NOT EXISTS agent_runtime_task_events (
      task_id TEXT NOT NULL REFERENCES agent_runtime_tasks(task_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (task_id, seq)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS agent_runtime_start_request_tombstones (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      intent_fingerprint TEXT NOT NULL,
      retired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS agent_runtime_start_request_tombstones_expiry_idx
      ON agent_runtime_start_request_tombstones(expires_at);
    CREATE TABLE IF NOT EXISTS agent_runtime_cancel_requests (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS agent_runtime_cancel_requests_expiry_idx
      ON agent_runtime_cancel_requests(expires_at);
  `);
}

function migrateStoredEventsToProtocolV2(database: Database): void {
  let cursor: { taskId: string; seq: number } | null = null;
  while (true) {
    const rows = (cursor
      ? database.query(`
          SELECT task_id, seq, event_json
          FROM agent_runtime_task_events
          WHERE task_id > ? OR (task_id = ? AND seq > ?)
          ORDER BY task_id ASC, seq ASC
          LIMIT ?
        `).all(
          cursor.taskId,
          cursor.taskId,
          cursor.seq,
          AGENT_RUNTIME_EVENT_MIGRATION_BATCH_SIZE,
        )
      : database.query(`
          SELECT task_id, seq, event_json
          FROM agent_runtime_task_events
          ORDER BY task_id ASC, seq ASC
          LIMIT ?
        `).all(AGENT_RUNTIME_EVENT_MIGRATION_BATCH_SIZE)) as EventRow[];
    if (rows.length === 0) return;
    for (const row of rows) {
      const taskId = opaqueId(row.task_id, 'legacy event.task_id');
      const seq = safeSequence(row.seq, 'legacy event.seq', 1);
      if (typeof row.event_json !== 'string') {
        fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'A legacy event is invalid.');
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(row.event_json);
      } catch {
        fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'A legacy event is not valid JSON.');
      }
      const event = asObject(decoded);
      const payload = asObject(event?.payload);
      if (!event || !payload
        || (event.protocolVersion !== 'agentstoz-tasks-v1'
          && event.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION)) {
        fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'A legacy event has an invalid shape.');
      }
      const migrated = normalizeAgentTaskEvent({
        ...event,
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        payload: event.type === 'task.accepted'
          ? {
              ...payload,
              executionMode: payload.executionMode ?? 'workspace-write',
              modelId: null,
            }
          : payload,
      });
      if (migrated.taskId !== taskId || migrated.seq !== seq) {
        fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'A legacy event envelope does not match its journal cursor.');
      }
      database.query(`
        UPDATE agent_runtime_task_events
        SET event_json = ?
        WHERE task_id = ? AND seq = ?
      `).run(eventJson(migrated), taskId, seq);
    }
    const last = rows.at(-1)!;
    cursor = {
      taskId: opaqueId(last.task_id, 'legacy event.task_id'),
      seq: safeSequence(last.seq, 'legacy event.seq', 1),
    };
  }
}

function ensureSchema(database: Database): void {
  const metaExists = database.query(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'agent_runtime_journal_meta'
  `).get() as { present?: unknown } | null;
  if (metaExists) {
    const row = database.query(`
      SELECT schema_version FROM agent_runtime_journal_meta WHERE singleton = 1
    `).get() as { schema_version?: unknown } | null;
    if (typeof row?.schema_version !== 'number' || !Number.isSafeInteger(row.schema_version)) {
      fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The journal schema metadata is missing or invalid.');
    }
    if (row.schema_version > AGENT_RUNTIME_TASK_JOURNAL_SCHEMA_VERSION) {
      fail('AGENT_RUNTIME_JOURNAL_FUTURE_SCHEMA', 'This journal was created by a newer AgentsToZ runtime.');
    }
    let schemaVersion = row.schema_version;
    if (schemaVersion === 1) {
      runImmediateTransaction(database, () => {
        database.exec(`
          ALTER TABLE agent_runtime_tasks
          ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'workspace-write'
          CHECK (execution_mode IN (
            'workspace-write', 'dangerously-bypass-approvals-and-sandbox'
          ));
        `);
        database.query(`
          UPDATE agent_runtime_journal_meta SET schema_version = ? WHERE singleton = 1
        `).run(2);
      });
      schemaVersion = 2;
    }
    if (schemaVersion === 2) {
      runImmediateTransaction(database, () => {
        database.exec(`
          ALTER TABLE agent_runtime_tasks
          ADD COLUMN model_id TEXT CHECK (
            model_id IS NULL OR (
              length(model_id) BETWEEN 1 AND 128
              AND substr(model_id, 1, 1) GLOB '[A-Za-z0-9]'
              AND model_id NOT GLOB '*[^A-Za-z0-9._:/-]*'
            )
          );
        `);
        migrateStoredEventsToProtocolV2(database);
        database.query(`
          UPDATE agent_runtime_journal_meta SET schema_version = ? WHERE singleton = 1
        `).run(3);
      });
      schemaVersion = 3;
    }
    if (schemaVersion !== AGENT_RUNTIME_TASK_JOURNAL_SCHEMA_VERSION) {
      fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The journal schema version is unsupported.');
    }
    createSchema(database);
    return;
  }

  runImmediateTransaction(database, () => {
    createSchema(database);
    database.query(`
      INSERT INTO agent_runtime_journal_meta(singleton, schema_version) VALUES (1, ?)
    `).run(AGENT_RUNTIME_TASK_JOURNAL_SCHEMA_VERSION);
  });
}

const TASK_COLUMNS = `
  task_id, request_id, target_id, project_label, adapter_id, model_id, execution_mode, status, prompt,
  last_seq, created_at, updated_at, started_at, finished_at,
  provider_thread_id, provider_turn_id
`;

export class AgentRuntimeTaskJournal {
  private closed = false;

  constructor(
    private readonly database: Database,
    private readonly clock: () => string = nowIso,
  ) {}

  private assertOpen(): void {
    if (this.closed) fail('AGENT_RUNTIME_JOURNAL_CLOSED', 'The agent runtime journal is closed.');
  }

  private readExecutionByTaskId(taskId: string): AgentTaskExecutionRecord | null {
    const row = this.database.query(`
      SELECT ${TASK_COLUMNS} FROM agent_runtime_tasks WHERE task_id = ?
    `).get(taskId) as TaskRow | null;
    return executionFromRow(row);
  }

  private readExecutionByRequestId(requestId: string): AgentTaskExecutionRecord | null {
    const row = this.database.query(`
      SELECT ${TASK_COLUMNS} FROM agent_runtime_tasks WHERE request_id = ?
    `).get(requestId) as TaskRow | null;
    return executionFromRow(row);
  }

  private readStartRequestTombstone(requestId: string): RequestTombstoneRow | null {
    return this.database.query(`
      SELECT intent_fingerprint, expires_at
      FROM agent_runtime_start_request_tombstones
      WHERE request_id = ?
    `).get(requestId) as RequestTombstoneRow | null;
  }

  private readCancellationRequest(requestId: string): CancellationRequestRow | null {
    return this.database.query(`
      SELECT request_id, task_id, created_at, expires_at
      FROM agent_runtime_cancel_requests
      WHERE request_id = ?
    `).get(requestId) as CancellationRequestRow | null;
  }

  private hasCancellationIntentForTask(taskId: string): boolean {
    const row = this.database.query(`
      SELECT request_id, task_id, created_at, expires_at
      FROM agent_runtime_cancel_requests
      WHERE task_id = ?
      ORDER BY created_at ASC, request_id ASC
      LIMIT 1
    `).get(taskId) as CancellationRequestRow | null;
    if (!row) return false;
    opaqueId(row.request_id, 'cancel request_id');
    if (opaqueId(row.task_id, 'cancel request task_id') !== taskId) {
      fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'A cancellation intent is bound to the wrong task.');
    }
    const createdAt = isoDate(row.created_at, 'cancel request timestamp');
    const expiresAt = isoDate(row.expires_at, 'cancel request expiry');
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'A cancellation intent has an invalid retention window.');
    }
    return true;
  }

  private retireStartRequest(execution: AgentTaskExecutionRecord, retiredAt: string): void {
    this.database.query(`
      INSERT INTO agent_runtime_start_request_tombstones(
        request_id, task_id, intent_fingerprint, retired_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      execution.requestId,
      execution.taskId,
      intentFingerprint(execution),
      retiredAt,
      futureIso(retiredAt, AGENT_RUNTIME_REQUEST_TOMBSTONE_TTL_MS),
    );
  }

  private pruneExpiredRequestGuards(now: string): void {
    this.database.query(`
      DELETE FROM agent_runtime_start_request_tombstones WHERE expires_at <= ?
    `).run(now);
    this.database.query(`
      DELETE FROM agent_runtime_cancel_requests WHERE expires_at <= ?
    `).run(now);
  }

  private assertStartRequestNotRetiredInTransaction(
    request: AgentTaskStartRequest,
    now: string,
  ): void {
    const tombstone = this.readStartRequestTombstone(request.requestId);
    if (!tombstone) return;
    const expiresAt = isoDate(tombstone.expires_at, 'start request tombstone expiry');
    if (Date.parse(expiresAt) <= Date.parse(now)) {
      this.database.query(`
        DELETE FROM agent_runtime_start_request_tombstones
        WHERE request_id = ? AND expires_at = ?
      `).run(request.requestId, expiresAt);
      return;
    }
    if (typeof tombstone.intent_fingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(tombstone.intent_fingerprint)) {
      fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'A start request tombstone is invalid.');
    }
    if (tombstone.intent_fingerprint !== intentFingerprint(request)) {
      fail(
        'AGENT_RUNTIME_REQUEST_CONFLICT',
        'The requestId is already bound to a different retired task intent.',
      );
    }
    fail(
      'AGENT_RUNTIME_REQUEST_RETIRED',
      'The requestId belongs to a task whose detailed history has been retired.',
    );
  }

  assertStartRequestNotRetired(input: AgentTaskStartRequest): void {
    this.assertOpen();
    const request = normalizeAgentTaskStartRequest(input);
    const now = this.clock();
    isoDate(now, 'start request lookup timestamp');
    runImmediateTransaction(this.database, () => {
      this.assertStartRequestNotRetiredInTransaction(request, now);
    });
  }

  createOrGetTask(input: CreateAgentRuntimeTaskInput): CreateOrGetAgentRuntimeTaskResult {
    this.assertOpen();
    assertAgentRuntimeRemoteSafe(input);
    const raw = asObject(input) ?? fail(
      'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT',
      'A task creation intent is required.',
    );
    if (!hasExactKeys(raw, [
      'protocolVersion', 'requestId', 'targetId', 'adapterId', 'modelId',
      'executionMode', 'prompt', 'projectLabel',
    ])) {
      fail('AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT', 'The task creation intent has unexpected fields.');
    }
    const request = normalizeAgentTaskStartRequest({
      protocolVersion: raw.protocolVersion,
      requestId: raw.requestId,
      targetId: raw.targetId,
      adapterId: raw.adapterId,
      modelId: raw.modelId,
      executionMode: raw.executionMode,
      prompt: raw.prompt,
    });
    const taskId = opaqueId(`task_${randomUUID()}`, 'taskId');
    const occurredAt = this.clock();
    const projectLabel = raw.projectLabel;
    const accepted = normalizeAgentTaskEvent({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId,
      seq: 1,
      occurredAt,
      type: 'task.accepted',
      payload: {
        adapterId: request.adapterId,
        projectLabel,
        executionMode: request.executionMode,
        modelId: request.modelId,
      },
    });
    if (accepted.type !== 'task.accepted') {
      fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The accepted event could not be normalized.');
    }
    const serializedAccepted = eventJson(accepted);

    return runImmediateTransaction(this.database, () => {
      const existing = this.readExecutionByRequestId(request.requestId);
      if (existing) {
        if (existing.targetId !== request.targetId
          || existing.adapterId !== request.adapterId
          || existing.modelId !== request.modelId
          || existing.executionMode !== request.executionMode
          || existing.prompt !== request.prompt) {
          fail(
            'AGENT_RUNTIME_REQUEST_CONFLICT',
            'The requestId is already bound to a different task creation intent.',
          );
        }
        return { duplicate: true, task: summaryFromExecution(existing) };
      }

      this.assertStartRequestNotRetiredInTransaction(request, occurredAt);

      this.database.query(`
        INSERT INTO agent_runtime_tasks(
          task_id, request_id, target_id, project_label, adapter_id, model_id,
          execution_mode, status, prompt,
          last_seq, created_at, updated_at, started_at, finished_at,
          provider_thread_id, provider_turn_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, 1, ?, ?, NULL, NULL, NULL, NULL)
      `).run(
        taskId,
        request.requestId,
        request.targetId,
        accepted.payload.projectLabel,
        request.adapterId,
        request.modelId,
        request.executionMode,
        request.prompt,
        occurredAt,
        occurredAt,
      );
      this.database.query(`
        INSERT INTO agent_runtime_task_events(task_id, seq, type, occurred_at, event_json)
        VALUES (?, 1, ?, ?, ?)
      `).run(taskId, accepted.type, accepted.occurredAt, serializedAccepted);

      const created = this.readExecutionByTaskId(taskId);
      if (!created) fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The newly created task could not be read.');
      return { duplicate: false, task: summaryFromExecution(created) };
    });
  }

  appendEvent(taskIdInput: string, draftInput: AgentTaskEventDraft): AgentTaskEvent {
    this.assertOpen();
    const taskId = opaqueId(taskIdInput, 'taskId');
    assertAgentRuntimeRemoteSafe(draftInput);
    const draft = asObject(draftInput) ?? fail(
      'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT',
      'An event draft is required.',
    );
    if (!hasExactKeys(draft, ['type', 'payload'])) {
      fail('AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT', 'An event draft may contain only type and payload.');
    }

    return runImmediateTransaction(this.database, () => {
      const execution = this.readExecutionByTaskId(taskId);
      if (!execution) fail('AGENT_RUNTIME_TASK_NOT_FOUND', 'The requested task does not exist.');
      const nextSeq = execution.lastSeq + 1;
      if (!Number.isSafeInteger(nextSeq)) {
        fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The task sequence is exhausted.');
      }
      const occurredAt = this.clock();
      const event = normalizeAgentTaskEvent({
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        taskId,
        seq: nextSeq,
        occurredAt,
        type: draft.type,
        payload: draft.payload,
      });
      assertTransition(execution.status, event);
      if (!TERMINAL_STATUSES.has(statusAfter(event))
        && nextSeq >= AGENT_RUNTIME_MAX_EVENTS_PER_TASK) {
        fail(
          'AGENT_RUNTIME_EVENT_LIMIT',
          'The task emitted too many non-terminal events; the final slot is reserved for a terminal result.',
        );
      }
      if (event.type === 'task.started' && event.payload.adapterId !== execution.adapterId) {
        fail('AGENT_RUNTIME_EVENT_TRANSITION_INVALID', 'The started adapter does not match the task intent.');
      }
      const nextStatus = statusAfter(event);
      const startedAt = event.type === 'task.started' ? occurredAt : execution.startedAt;
      const finishedAt = TERMINAL_STATUSES.has(nextStatus) ? occurredAt : execution.finishedAt;

      this.database.query(`
        INSERT INTO agent_runtime_task_events(task_id, seq, type, occurred_at, event_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(taskId, nextSeq, event.type, event.occurredAt, eventJson(event));
      this.database.query(`
        UPDATE agent_runtime_tasks
        SET status = ?, last_seq = ?, updated_at = ?, started_at = ?, finished_at = ?
        WHERE task_id = ? AND last_seq = ?
      `).run(
        nextStatus,
        nextSeq,
        occurredAt,
        startedAt,
        finishedAt,
        taskId,
        execution.lastSeq,
      );
      return event;
    });
  }

  /**
   * Durably binds a cancellation idempotency key before the supervisor sends
   * an abort signal. A retry for the same task is harmless; cross-task reuse
   * is rejected even after the original task history is pruned.
   */
  recordCancellationIntent(taskIdInput: string, requestIdInput: string): { duplicate: boolean } {
    this.assertOpen();
    const taskId = opaqueId(taskIdInput, 'taskId');
    const requestId = opaqueId(requestIdInput, 'cancel requestId');
    const createdAt = this.clock();
    isoDate(createdAt, 'cancel request timestamp');
    return runImmediateTransaction(this.database, () => {
      if (!this.readExecutionByTaskId(taskId)) {
        fail('AGENT_RUNTIME_TASK_NOT_FOUND', 'The requested task does not exist.');
      }
      const existing = this.readCancellationRequest(requestId);
      if (existing) {
        const expiresAt = isoDate(existing.expires_at, 'cancel request expiry');
        if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
          this.database.query(`
            DELETE FROM agent_runtime_cancel_requests
            WHERE request_id = ? AND expires_at = ?
          `).run(requestId, expiresAt);
        } else {
          const existingTaskId = opaqueId(existing.task_id, 'cancel request task_id');
          if (existingTaskId !== taskId) {
            fail(
              'AGENT_RUNTIME_CANCEL_REQUEST_CONFLICT',
              'The cancellation requestId is already bound to another task.',
            );
          }
          return { duplicate: true };
        }
      }
      this.database.query(`
        INSERT INTO agent_runtime_cancel_requests(request_id, task_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(
        requestId,
        taskId,
        createdAt,
        futureIso(createdAt, AGENT_RUNTIME_REQUEST_TOMBSTONE_TTL_MS),
      );
      return { duplicate: false };
    });
  }

  setProviderIds(taskIdInput: string, idsInput: AgentTaskProviderIds): AgentTaskExecutionRecord {
    this.assertOpen();
    const taskId = opaqueId(taskIdInput, 'taskId');
    const ids = asObject(idsInput) ?? fail(
      'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT',
      'Provider identifiers are required.',
    );
    const keys = Object.keys(ids);
    if (keys.length < 1 || keys.some(key => key !== 'threadId' && key !== 'turnId')) {
      fail('AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT', 'Only threadId and turnId may be stored.');
    }
    const threadId = 'threadId' in ids ? providerId(ids.threadId, 'threadId') : undefined;
    const turnId = 'turnId' in ids ? providerId(ids.turnId, 'turnId') : undefined;

    return runImmediateTransaction(this.database, () => {
      const execution = this.readExecutionByTaskId(taskId);
      if (!execution) fail('AGENT_RUNTIME_TASK_NOT_FOUND', 'The requested task does not exist.');
      if ((threadId !== undefined && execution.threadId !== null && execution.threadId !== threadId)
        || (turnId !== undefined && execution.turnId !== null && execution.turnId !== turnId)) {
        fail('AGENT_RUNTIME_PROVIDER_ID_CONFLICT', 'Provider identifiers are immutable once recorded.');
      }
      this.database.query(`
        UPDATE agent_runtime_tasks
        SET provider_thread_id = coalesce(provider_thread_id, ?),
            provider_turn_id = coalesce(provider_turn_id, ?)
        WHERE task_id = ?
      `).run(threadId ?? null, turnId ?? null, taskId);
      const updated = this.readExecutionByTaskId(taskId);
      if (!updated) fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The updated task could not be read.');
      return updated;
    });
  }

  getTask(taskIdInput: string): AgentTaskSummary | null {
    this.assertOpen();
    const taskId = opaqueId(taskIdInput, 'taskId');
    const execution = this.readExecutionByTaskId(taskId);
    return execution ? summaryFromExecution(execution) : null;
  }

  getTaskExecution(taskIdInput: string): AgentTaskExecutionRecord | null {
    this.assertOpen();
    return this.readExecutionByTaskId(opaqueId(taskIdInput, 'taskId'));
  }

  getTaskByRequestId(requestIdInput: string): AgentTaskSummary | null {
    this.assertOpen();
    const requestId = opaqueId(requestIdInput, 'requestId');
    const execution = this.readExecutionByRequestId(requestId);
    return execution ? summaryFromExecution(execution) : null;
  }

  listTasks(limitInput: number = DEFAULT_TASK_LIST_LIMIT): AgentTaskSummary[] {
    this.assertOpen();
    const limit = boundedLimit(limitInput, DEFAULT_TASK_LIST_LIMIT, AGENT_RUNTIME_TASK_LIST_LIMIT, 'limit');
    const rows = this.database.query(`
      SELECT ${TASK_COLUMNS} FROM agent_runtime_tasks
      ORDER BY updated_at DESC, task_id ASC
      LIMIT ?
    `).all(limit) as TaskRow[];
    return rows.map(row => summaryFromExecution(executionFromRow(row)!));
  }

  readEvents(
    taskIdInput: string,
    afterInput: number,
    limitInput: number = DEFAULT_EVENT_READ_LIMIT,
  ): AgentTaskEvent[] {
    this.assertOpen();
    const taskId = opaqueId(taskIdInput, 'taskId');
    const after = safeSequenceArgument(afterInput, 'after');
    const limit = boundedLimit(limitInput, DEFAULT_EVENT_READ_LIMIT, AGENT_RUNTIME_EVENT_READ_LIMIT, 'limit');
    const execution = this.readExecutionByTaskId(taskId);
    if (!execution) {
      fail('AGENT_RUNTIME_TASK_NOT_FOUND', 'The requested task does not exist.');
    }
    const rows = this.database.query(`
      SELECT task_id, seq, event_json
      FROM agent_runtime_task_events
      WHERE task_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(taskId, after, limit) as EventRow[];
    const events = rows.map(parseEventRow);
    if (events.length > 0 && events[0]!.seq !== after + 1) {
      fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The durable event sequence contains a gap.');
    }
    for (let index = 1; index < events.length; index += 1) {
      if (events[index]!.seq !== events[index - 1]!.seq + 1) {
        fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The durable event sequence contains a gap.');
      }
    }
    const expectedLastSeq = Math.min(execution.lastSeq, after + limit);
    const actualLastSeq = events.at(-1)?.seq ?? after;
    if (actualLastSeq !== expectedLastSeq) {
      fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The durable event sequence ends before the task cursor.');
    }
    return events;
  }

  reconcileInterruptedTasks(): number {
    this.assertOpen();
    return runImmediateTransaction(this.database, () => {
      const rows = this.database.query(`
        SELECT ${TASK_COLUMNS} FROM agent_runtime_tasks
        WHERE status IN ('accepted', 'running', 'waiting', 'unknown')
        ORDER BY created_at ASC, task_id ASC
      `).all() as TaskRow[];
      const occurredAt = this.clock();
      for (const row of rows) {
        const execution = executionFromRow(row)!;
        const cancellationRequested = this.hasCancellationIntentForTask(execution.taskId);
        const seq = execution.lastSeq + 1;
        if (!Number.isSafeInteger(seq)) {
          fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'The task sequence is exhausted.');
        }
        const event = normalizeAgentTaskEvent(cancellationRequested
          ? {
              protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
              taskId: execution.taskId,
              seq,
              occurredAt,
              type: 'task.cancelled',
              payload: {
                reason: '사용자가 재시작 전에 요청한 취소 의도를 보존해 실행을 취소했습니다.',
              },
            }
          : {
              protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
              taskId: execution.taskId,
              seq,
              occurredAt,
              type: 'task.failed',
              payload: {
                code: 'RUNTIME_RESTARTED',
                message: 'AgentsToZ가 재시작되어 진행 중이던 실행을 안전하게 종료했습니다.',
                retryable: true,
              },
            });
        const nextStatus = statusAfter(event);
        this.database.query(`
          INSERT INTO agent_runtime_task_events(task_id, seq, type, occurred_at, event_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(execution.taskId, seq, event.type, occurredAt, eventJson(event));
        this.database.query(`
          UPDATE agent_runtime_tasks
          SET status = ?, last_seq = ?, updated_at = ?, finished_at = ?
          WHERE task_id = ? AND last_seq = ?
        `).run(nextStatus, seq, occurredAt, occurredAt, execution.taskId, execution.lastSeq);
      }
      return rows.length;
    });
  }

  pruneTerminalTasks(keepInput: number = AGENT_RUNTIME_DEFAULT_TERMINAL_TASK_KEEP): number {
    this.assertOpen();
    const keep = boundedTerminalKeep(keepInput);
    return runImmediateTransaction(this.database, () => {
      const retiredAt = this.clock();
      isoDate(retiredAt, 'terminal prune timestamp');
      this.pruneExpiredRequestGuards(retiredAt);
      const countRow = this.database.query(`
        SELECT count(*) AS count FROM agent_runtime_tasks
        WHERE status IN ('succeeded', 'failed', 'cancelled')
      `).get() as { count?: unknown } | null;
      const terminalCount = safeSequence(countRow?.count, 'terminal task count');
      const deleteCount = Math.max(0, terminalCount - keep);
      if (deleteCount === 0) return 0;
      const rows = this.database.query(`
        SELECT ${TASK_COLUMNS} FROM agent_runtime_tasks
        WHERE status IN ('succeeded', 'failed', 'cancelled')
        ORDER BY updated_at ASC, task_id ASC
        LIMIT ?
      `).all(deleteCount) as TaskRow[];
      for (const row of rows) {
        const execution = executionFromRow(row)!;
        this.retireStartRequest(execution, retiredAt);
        const deleted = this.database.query(`
          DELETE FROM agent_runtime_tasks WHERE task_id = ?
        `).run(execution.taskId).changes;
        // Bun/SQLite may include foreign-key cascade changes in this count.
        // Zero is the only impossible result for the row selected above.
        if (deleted < 1) {
          fail('AGENT_RUNTIME_JOURNAL_CORRUPT', 'A retired task could not be deleted atomically.');
        }
      }
      return rows.length;
    });
  }

  deleteTask(taskIdInput: string): boolean {
    this.assertOpen();
    const taskId = opaqueId(taskIdInput, 'taskId');
    return runImmediateTransaction(this.database, () => {
      const execution = this.readExecutionByTaskId(taskId);
      if (!execution) return false;
      if (!TERMINAL_STATUSES.has(execution.status)) {
        fail(
          'AGENT_RUNTIME_ACTIVE_TASK_DELETE_FORBIDDEN',
          'Accepted, running, waiting, or unknown tasks cannot be deleted.',
        );
      }
      const retiredAt = this.clock();
      isoDate(retiredAt, 'task deletion timestamp');
      this.pruneExpiredRequestGuards(retiredAt);
      this.retireStartRequest(execution, retiredAt);
      return this.database.query('DELETE FROM agent_runtime_tasks WHERE task_id = ?')
        .run(taskId).changes > 0;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}

function safeSequenceArgument(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail('AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT', `${field} must be a non-negative safe integer.`);
  }
  return value;
}

export function openAgentRuntimeTaskJournal(path: string): AgentRuntimeTaskJournal {
  prepareDatabasePath(path);
  const database = new Database(path, { create: true });
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 3000;
      PRAGMA trusted_schema = OFF;
      PRAGMA secure_delete = ON;
    `);
    applyPrivateDatabasePermissions(path);
    ensureSchema(database);
    return new AgentRuntimeTaskJournal(database);
  } catch (error) {
    database.close();
    throw error;
  }
}
