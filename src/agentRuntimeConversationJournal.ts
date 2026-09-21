import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

import {
  AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
  AGENT_RUNTIME_CONVERSATION_EVENT_READ_LIMIT,
  AGENT_RUNTIME_CONVERSATION_MAX_EVENTS_PER_TURN,
  AGENT_RUNTIME_CONVERSATION_MAX_RETAINED_EVENTS,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  normalizeAgentRuntimeConversationContinueRequest,
  normalizeAgentRuntimeConversationCreateRequest,
  normalizeAgentRuntimeConversationEvent,
  normalizeAgentRuntimeConversationSummary,
  type AgentRuntimeConversationContinueRequest,
  type AgentRuntimeConversationCreateRequest,
  type AgentRuntimeConversationEvent,
  type AgentRuntimeConversationEventType,
  type AgentRuntimeConversationSemanticEventDraft,
  type AgentRuntimeConversationState,
  type AgentRuntimeConversationSummary,
} from './agentRuntimeConversationProtocol';

export const AGENT_RUNTIME_CONVERSATION_JOURNAL_SCHEMA_VERSION = 5;

const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{8,256}$/;

interface ConversationRow {
  conversation_id: unknown;
  create_request_id: unknown;
  create_intent_digest: unknown;
  target_id: unknown;
  project_label: unknown;
  adapter_id: unknown;
  model_id: unknown;
  state: unknown;
  active_turn_id: unknown;
  provider_thread_id: unknown;
  provider_turn_id: unknown;
  revision: unknown;
  history_retention_consent: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface ConversationEventRow {
  seq: unknown;
  conversation_id: unknown;
  revision: unknown;
  event_type: unknown;
  turn_id: unknown;
  summary: unknown;
  phase: unknown;
  artifact_kind: unknown;
  artifact_label: unknown;
  created_at: unknown;
}

export interface AgentRuntimeConversationPrivateRecord {
  summary: AgentRuntimeConversationSummary;
  /** Local supervisor correlation only. Never serialize this record to UI/remote. */
  providerThreadId: string | null;
  providerTurnId: string | null;
}

export interface CreateAgentRuntimeConversationResult {
  duplicate: boolean;
  conversation: AgentRuntimeConversationPrivateRecord;
}

export type AgentRuntimeConversationLiveAction = 'steer' | 'interrupt';

export interface AgentRuntimeConversationLiveControlIntent {
  requestId: string;
  conversationId: string;
  expectedRevision: number;
  expectedTurnId: string;
  action: AgentRuntimeConversationLiveAction;
  /** Required only for steer. The journal persists its digest, never the text. */
  prompt?: string;
}

export interface PreparedAgentRuntimeConversationLiveControl {
  duplicate: boolean;
  indeterminate: boolean;
  conversation: AgentRuntimeConversationSummary;
}

export interface PreparedAgentRuntimeConversationTurn {
  duplicate: boolean;
  indeterminate: boolean;
  conversation: AgentRuntimeConversationPrivateRecord;
}

export type AgentRuntimeConversationLifecycleAction = 'archive' | 'unarchive' | 'delete';

export interface AgentRuntimeConversationLifecycleIntent {
  requestId: string;
  conversationId: string;
  expectedRevision: number;
  action: AgentRuntimeConversationLifecycleAction;
}

export interface PreparedAgentRuntimeConversationLifecycleMutation {
  duplicate: boolean;
  indeterminate: boolean;
  conversation: AgentRuntimeConversationPrivateRecord | null;
}

export interface AgentRuntimeConversationJournalOptions {
  now?: () => Date;
  createConversationId?: () => string;
}

export class AgentRuntimeConversationJournalError extends Error {
  constructor(
    readonly code:
      | 'AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT'
      | 'AGENT_RUNTIME_CONVERSATION_NOT_FOUND'
      | 'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT'
      | 'AGENT_RUNTIME_CONVERSATION_REQUEST_RETIRED'
      | 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE'
      | 'AGENT_RUNTIME_CONVERSATION_REVISION_CONFLICT'
      | 'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT'
      | 'AGENT_RUNTIME_CONVERSATION_PROVIDER_ID_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeConversationJournalError';
  }
}

function fail(
  code: AgentRuntimeConversationJournalError['code'],
  message: string,
): never {
  throw new AgentRuntimeConversationJournalError(code, message);
}

function opaque(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) {
    return fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', `${label} is invalid.`);
  }
  return value;
}

function providerId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !PROVIDER_ID_RE.test(value)) {
    return fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', `${label} is invalid.`);
  }
  return value;
}

function canonicalDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 32
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) {
    return fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', `${label} is invalid.`);
  }
  return value;
}

function safeRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'revision is invalid.');
  }
  return value;
}

function record(row: ConversationRow): AgentRuntimeConversationPrivateRecord {
  const activeTurnId = row.active_turn_id === null ? null : opaque(row.active_turn_id, 'active_turn_id');
  const providerThreadId = providerId(row.provider_thread_id, 'provider_thread_id');
  const providerTurnId = providerId(row.provider_turn_id, 'provider_turn_id');
  const state = row.state as AgentRuntimeConversationState;
  if (!['idle', 'running', 'archived', 'unknown'].includes(state)) {
    return fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'state is invalid.');
  }
  if ((state === 'running') !== (activeTurnId !== null && providerTurnId !== null)) {
    return fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'active turn state is inconsistent.');
  }
  if (state !== 'unknown' && providerThreadId === null) {
    return fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'provider thread binding is missing.');
  }
  const summary = normalizeAgentRuntimeConversationSummary({
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversationId: opaque(row.conversation_id, 'conversation_id'),
    targetId: opaque(row.target_id, 'target_id'),
    projectLabel: row.project_label,
    adapterId: row.adapter_id,
    modelId: row.model_id,
    state,
    activeTurnId,
    revision: safeRevision(row.revision),
    createdAt: canonicalDate(row.created_at, 'created_at'),
    updatedAt: canonicalDate(row.updated_at, 'updated_at'),
  });
  if (row.history_retention_consent !== AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT) {
    return fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'history consent is invalid.');
  }
  return { summary, providerThreadId, providerTurnId };
}

function createIntentDigest(request: AgentRuntimeConversationCreateRequest): string {
  return createHash('sha256').update(JSON.stringify([
    request.targetId,
    request.adapterId,
    request.modelId,
    request.historyRetentionConsent,
    request.initialPrompt,
  ])).digest('hex');
}

function continueIntentDigest(request: AgentRuntimeConversationContinueRequest): string {
  return createHash('sha256').update(JSON.stringify([
    request.conversationId,
    request.expectedRevision,
    request.prompt,
  ])).digest('hex');
}

function eventRecord(row: ConversationEventRow): AgentRuntimeConversationEvent {
  const common = {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    conversationId: row.conversation_id,
    seq: row.seq,
    revision: row.revision,
    type: row.event_type,
    turnId: row.turn_id,
    createdAt: row.created_at,
  };
  if (row.event_type === 'conversation.progress') {
    return normalizeAgentRuntimeConversationEvent({
      ...common,
      payload: { summary: row.summary, phase: row.phase },
    });
  }
  if (row.event_type === 'conversation.artifact.summary') {
    return normalizeAgentRuntimeConversationEvent({
      ...common,
      payload: {
        kind: row.artifact_kind,
        label: row.artifact_label,
        summary: row.summary,
      },
    });
  }
  return normalizeAgentRuntimeConversationEvent(common);
}

function schema(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agent_runtime_conversation_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runtime_conversations (
      conversation_id TEXT PRIMARY KEY,
      create_request_id TEXT NOT NULL UNIQUE,
      create_intent_digest TEXT NOT NULL CHECK (length(create_intent_digest) = 64),
      target_id TEXT NOT NULL,
      project_label TEXT NOT NULL,
      adapter_id TEXT NOT NULL CHECK (adapter_id IN ('claude', 'codex', 'agy', 'hermes')),
      model_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('idle', 'running', 'archived', 'unknown')),
      active_turn_id TEXT,
      provider_thread_id TEXT,
      provider_turn_id TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      history_retention_consent TEXT NOT NULL CHECK (
        history_retention_consent = 'retain-provider-history-on-this-host'
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'running' AND active_turn_id IS NOT NULL AND provider_turn_id IS NOT NULL)
        OR (state != 'running' AND active_turn_id IS NULL AND provider_turn_id IS NULL)
      ),
      CHECK (state = 'unknown' OR provider_thread_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS agent_runtime_conversations_updated_idx
      ON agent_runtime_conversations(updated_at DESC, conversation_id ASC);
    CREATE TABLE IF NOT EXISTS agent_runtime_conversation_tombstones (
      conversation_id TEXT PRIMARY KEY,
      create_request_id TEXT NOT NULL UNIQUE,
      create_intent_digest TEXT NOT NULL CHECK (length(create_intent_digest) = 64),
      delete_request_id TEXT NOT NULL UNIQUE,
      deleted_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS agent_runtime_conversation_live_requests (
      request_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('steer', 'interrupt')),
      expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
      expected_turn_id TEXT NOT NULL,
      intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
      status TEXT NOT NULL CHECK (status IN ('prepared', 'accepted', 'indeterminate')),
      outcome_revision INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES agent_runtime_conversations(conversation_id)
        ON DELETE CASCADE,
      CHECK (
        (status = 'accepted' AND outcome_revision IS NOT NULL)
        OR (status != 'accepted' AND outcome_revision IS NULL)
      )
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS agent_runtime_conversation_live_revision_idx
      ON agent_runtime_conversation_live_requests(conversation_id, expected_revision);
    CREATE TABLE IF NOT EXISTS agent_runtime_conversation_turn_requests (
      request_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
      intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
      status TEXT NOT NULL CHECK (
        status IN ('prepared', 'running', 'succeeded', 'interrupted', 'unknown')
      ),
      public_turn_id TEXT,
      outcome_revision INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES agent_runtime_conversations(conversation_id)
        ON DELETE CASCADE,
      CHECK (
        (status = 'prepared' AND public_turn_id IS NULL AND outcome_revision IS NULL)
        OR (status != 'prepared' AND public_turn_id IS NOT NULL AND outcome_revision IS NOT NULL)
      )
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS agent_runtime_conversation_turn_revision_idx
      ON agent_runtime_conversation_turn_requests(conversation_id, expected_revision);
    CREATE TABLE IF NOT EXISTS agent_runtime_conversation_lifecycle_requests (
      request_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('archive', 'unarchive', 'delete')),
      expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
      intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
      status TEXT NOT NULL CHECK (status IN ('prepared', 'completed', 'indeterminate')),
      outcome_revision INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (status = 'completed' AND outcome_revision IS NOT NULL)
        OR (status != 'completed' AND outcome_revision IS NULL)
      )
    ) WITHOUT ROWID;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_runtime_conversation_lifecycle_intent_idx
      ON agent_runtime_conversation_lifecycle_requests(conversation_id, action, expected_revision);
    CREATE TABLE IF NOT EXISTS agent_runtime_conversation_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      event_type TEXT NOT NULL CHECK (
        event_type IN (
          'conversation.turn.started',
          'conversation.turn.completed',
          'conversation.turn.interrupted',
          'conversation.turn.unknown',
          'conversation.progress',
          'conversation.artifact.summary'
        )
      ),
      turn_id TEXT,
      summary TEXT,
      phase TEXT,
      artifact_kind TEXT CHECK (
        artifact_kind IS NULL OR artifact_kind IN ('diff', 'test', 'commit', 'memory', 'other')
      ),
      artifact_label TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES agent_runtime_conversations(conversation_id)
        ON DELETE CASCADE,
      CHECK (turn_id IS NOT NULL OR event_type = 'conversation.turn.unknown'),
      CHECK (
        (event_type IN (
          'conversation.turn.started', 'conversation.turn.completed',
          'conversation.turn.interrupted', 'conversation.turn.unknown'
        ) AND summary IS NULL AND phase IS NULL
          AND artifact_kind IS NULL AND artifact_label IS NULL)
        OR (event_type = 'conversation.progress'
          AND summary IS NOT NULL AND length(summary) BETWEEN 1 AND 1000
          AND (phase IS NULL OR length(phase) BETWEEN 1 AND 80)
          AND artifact_kind IS NULL AND artifact_label IS NULL)
        OR (event_type = 'conversation.artifact.summary'
          AND summary IS NOT NULL AND length(summary) BETWEEN 1 AND 1000
          AND phase IS NULL AND artifact_kind IS NOT NULL
          AND artifact_label IS NOT NULL AND length(artifact_label) BETWEEN 1 AND 160)
      )
    );
    CREATE INDEX IF NOT EXISTS agent_runtime_conversation_events_read_idx
      ON agent_runtime_conversation_events(conversation_id, seq);
  `);
  const meta = database.query(`
    SELECT schema_version FROM agent_runtime_conversation_meta WHERE singleton = 1
  `).get() as { schema_version: unknown } | null;
  if (meta === null) {
    database.query(`
      INSERT INTO agent_runtime_conversation_meta(singleton, schema_version) VALUES (1, ?)
    `).run(AGENT_RUNTIME_CONVERSATION_JOURNAL_SCHEMA_VERSION);
  } else if (meta.schema_version === 1 || meta.schema_version === 2
    || meta.schema_version === 3 || meta.schema_version === 4) {
    const columns = database.query('PRAGMA table_info(agent_runtime_conversation_events)')
      .all() as Array<{ name: string }>;
    const eventTable = database.query(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'agent_runtime_conversation_events'
    `).get() as { sql: unknown } | null;
    if (!columns.some(column => column.name === 'summary')
      || typeof eventTable?.sql !== 'string'
      || !eventTable.sql.includes('conversation.progress')) {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE agent_runtime_conversation_events
          RENAME TO agent_runtime_conversation_events_legacy;
        CREATE TABLE agent_runtime_conversation_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          event_type TEXT NOT NULL CHECK (
            event_type IN (
              'conversation.turn.started', 'conversation.turn.completed',
              'conversation.turn.interrupted', 'conversation.turn.unknown',
              'conversation.progress', 'conversation.artifact.summary'
            )
          ),
          turn_id TEXT,
          summary TEXT,
          phase TEXT,
          artifact_kind TEXT CHECK (
            artifact_kind IS NULL OR artifact_kind IN ('diff', 'test', 'commit', 'memory', 'other')
          ),
          artifact_label TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES agent_runtime_conversations(conversation_id)
            ON DELETE CASCADE,
          CHECK (turn_id IS NOT NULL OR event_type = 'conversation.turn.unknown'),
          CHECK (
            (event_type IN (
              'conversation.turn.started', 'conversation.turn.completed',
              'conversation.turn.interrupted', 'conversation.turn.unknown'
            ) AND summary IS NULL AND phase IS NULL
              AND artifact_kind IS NULL AND artifact_label IS NULL)
            OR (event_type = 'conversation.progress'
              AND summary IS NOT NULL AND length(summary) BETWEEN 1 AND 1000
              AND (phase IS NULL OR length(phase) BETWEEN 1 AND 80)
              AND artifact_kind IS NULL AND artifact_label IS NULL)
            OR (event_type = 'conversation.artifact.summary'
              AND summary IS NOT NULL AND length(summary) BETWEEN 1 AND 1000
              AND phase IS NULL AND artifact_kind IS NOT NULL
              AND artifact_label IS NOT NULL AND length(artifact_label) BETWEEN 1 AND 160)
          )
        );
        INSERT INTO agent_runtime_conversation_events(
          seq, conversation_id, revision, event_type, turn_id,
          summary, phase, artifact_kind, artifact_label, created_at
        )
        SELECT seq, conversation_id, revision, event_type, turn_id,
               NULL, NULL, NULL, NULL, created_at
        FROM agent_runtime_conversation_events_legacy;
        DROP TABLE agent_runtime_conversation_events_legacy;
        CREATE INDEX agent_runtime_conversation_events_read_idx
          ON agent_runtime_conversation_events(conversation_id, seq);
        UPDATE agent_runtime_conversation_meta SET schema_version = 5 WHERE singleton = 1;
        COMMIT;
      `);
    } else {
      database.query(`
        UPDATE agent_runtime_conversation_meta SET schema_version = ? WHERE singleton = 1
      `).run(AGENT_RUNTIME_CONVERSATION_JOURNAL_SCHEMA_VERSION);
    }
  } else if (meta.schema_version !== AGENT_RUNTIME_CONVERSATION_JOURNAL_SCHEMA_VERSION) {
    fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'conversation schema version is unsupported.');
  }
}

const SELECT_COLUMNS = `
  conversation_id, create_request_id, create_intent_digest, target_id, project_label,
  adapter_id, model_id, state, active_turn_id, provider_thread_id, provider_turn_id,
  revision, history_retention_consent, created_at, updated_at
`;

export class AgentRuntimeConversationJournal {
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #createConversationId: () => string;

  constructor(database: Database, options: AgentRuntimeConversationJournalOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#createConversationId = options.createConversationId
      ?? (() => `conversation_${randomUUID()}`);
    schema(database);
  }

  close(): void {
    this.#database.close();
  }

  create(
    rawRequest: AgentRuntimeConversationCreateRequest,
    projectLabel: string,
  ): CreateAgentRuntimeConversationResult {
    const request = normalizeAgentRuntimeConversationCreateRequest(rawRequest);
    const digest = createIntentDigest(request);
    const existing = this.findByCreateRequest(request);
    if (existing) {
      return { duplicate: true, conversation: existing };
    }
    const conversationId = this.#createConversationId();
    if (!OPAQUE_ID_RE.test(conversationId)) {
      fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'generated conversation id is invalid.');
    }
    const now = this.#now().toISOString();
    this.#database.query(`
      INSERT INTO agent_runtime_conversations(
        conversation_id, create_request_id, create_intent_digest, target_id, project_label,
        adapter_id, model_id, state, active_turn_id, provider_thread_id, provider_turn_id,
        revision, history_retention_consent, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, NULL, 1, ?, ?, ?)
    `).run(
      conversationId,
      request.requestId,
      digest,
      request.targetId,
      projectLabel,
      request.adapterId,
      request.modelId,
      request.historyRetentionConsent,
      now,
      now,
    );
    return { duplicate: false, conversation: this.getPrivate(conversationId)! };
  }

  findByCreateRequest(
    rawRequest: AgentRuntimeConversationCreateRequest,
  ): AgentRuntimeConversationPrivateRecord | null {
    const request = normalizeAgentRuntimeConversationCreateRequest(rawRequest);
    const digest = createIntentDigest(request);
    const existing = this.#database.query(`
      SELECT ${SELECT_COLUMNS} FROM agent_runtime_conversations WHERE create_request_id = ?
    `).get(request.requestId) as ConversationRow | null;
    if (existing) {
      if (existing.create_intent_digest !== digest) {
        fail(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
          '같은 요청 ID가 다른 지속형 대화 생성에 사용되었습니다.',
        );
      }
      return record(existing);
    }
    const retired = this.#database.query(`
      SELECT create_intent_digest FROM agent_runtime_conversation_tombstones
      WHERE create_request_id = ?
    `).get(request.requestId) as { create_intent_digest: unknown } | null;
    if (!retired) return null;
    if (retired.create_intent_digest !== digest) {
      fail(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
        '같은 요청 ID가 다른 지속형 대화 생성에 사용되었습니다.',
      );
    }
    fail(
      'AGENT_RUNTIME_CONVERSATION_REQUEST_RETIRED',
      '이미 영구 삭제된 지속형 대화 생성 요청입니다.',
    );
  }

  get(conversationId: string): AgentRuntimeConversationSummary | null {
    return this.getPrivate(conversationId)?.summary ?? null;
  }

  getPrivate(conversationId: string): AgentRuntimeConversationPrivateRecord | null {
    if (!OPAQUE_ID_RE.test(conversationId)) return null;
    const row = this.#database.query(`
      SELECT ${SELECT_COLUMNS} FROM agent_runtime_conversations WHERE conversation_id = ?
    `).get(conversationId) as ConversationRow | null;
    return row ? record(row) : null;
  }

  list(includeArchived = false): AgentRuntimeConversationSummary[] {
    const rows = this.#database.query(`
      SELECT ${SELECT_COLUMNS} FROM agent_runtime_conversations
      ${includeArchived ? '' : "WHERE state != 'archived'"}
      ORDER BY updated_at DESC, conversation_id ASC
    `).all() as ConversationRow[];
    return rows.map(row => record(row).summary);
  }

  readEvents(
    conversationId: string,
    after = 0,
    limit = AGENT_RUNTIME_CONVERSATION_EVENT_READ_LIMIT,
  ): AgentRuntimeConversationEvent[] {
    if (!OPAQUE_ID_RE.test(conversationId)
      || !Number.isSafeInteger(after)
      || after < 0
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > AGENT_RUNTIME_CONVERSATION_EVENT_READ_LIMIT) {
      fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'conversation event cursor is invalid.');
    }
    if (!this.getPrivate(conversationId)) {
      fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
    }
    const rows = this.#database.query(`
      SELECT seq, conversation_id, revision, event_type, turn_id,
             summary, phase, artifact_kind, artifact_label, created_at
      FROM agent_runtime_conversation_events
      WHERE conversation_id = ? AND seq > ?
      ORDER BY seq ASC LIMIT ?
    `).all(conversationId, after, limit) as ConversationEventRow[];
    return rows.map(eventRecord);
  }

  latestEventSeq(conversationId: string): number {
    if (!OPAQUE_ID_RE.test(conversationId)) {
      fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'conversation event identity is invalid.');
    }
    if (!this.getPrivate(conversationId)) {
      fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
    }
    const row = this.#database.query(`
      SELECT COALESCE(MAX(seq), 0) AS latest_seq
      FROM agent_runtime_conversation_events WHERE conversation_id = ?
    `).get(conversationId) as { latest_seq: unknown };
    if (typeof row.latest_seq !== 'number'
      || !Number.isSafeInteger(row.latest_seq)
      || row.latest_seq < 0) {
      fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'conversation event cursor is corrupt.');
    }
    return row.latest_seq;
  }

  prepareContinue(
    rawRequest: AgentRuntimeConversationContinueRequest,
  ): PreparedAgentRuntimeConversationTurn {
    const request = normalizeAgentRuntimeConversationContinueRequest(rawRequest);
    const digest = continueIntentDigest(request);
    const transaction = this.#database.transaction(() => {
      let existing = this.#database.query(`
        SELECT conversation_id, expected_revision, intent_digest, status
        FROM agent_runtime_conversation_turn_requests WHERE request_id = ?
      `).get(request.requestId) as Record<string, unknown> | null;
      if (existing && (existing.conversation_id !== request.conversationId
          || existing.expected_revision !== request.expectedRevision
          || existing.intent_digest !== digest)) {
          fail(
            'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
            '같은 요청 ID가 다른 지속형 대화 turn에 사용되었습니다.',
          );
      }
      const semanticRows = this.#database.query(`
        SELECT conversation_id, expected_revision, intent_digest, status
        FROM agent_runtime_conversation_turn_requests
        WHERE conversation_id = ? AND expected_revision = ?
        ORDER BY created_at ASC, request_id ASC
      `).all(
        request.conversationId,
        request.expectedRevision,
      ) as Array<Record<string, unknown>>;
      if (semanticRows.length > 0) {
        if (semanticRows.some(row => row.intent_digest !== digest)) {
          fail(
            'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
            '같은 대화 revision에 다른 turn 요청이 이미 준비되었습니다.',
          );
        }
        existing ??= semanticRows[0]!;
      }
      if (existing) {
        if (existing.intent_digest !== digest) {
          fail(
            'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
            '같은 대화 revision에 다른 turn 요청이 이미 준비되었습니다.',
          );
        }
        const current = this.getPrivate(request.conversationId);
        if (!current) {
          fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
        }
        return {
          duplicate: true,
          indeterminate: semanticRows.length > 0
            ? semanticRows.some(row => row.status === 'prepared' || row.status === 'unknown')
            : existing.status === 'prepared' || existing.status === 'unknown',
          conversation: current,
        };
      }
      const current = this.getPrivate(request.conversationId);
      if (!current) {
        fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
      }
      if (current.summary.revision !== request.expectedRevision
        || current.summary.state !== 'idle'
        || !current.providerThreadId) {
        fail(
          'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT',
          '지속형 대화가 새 turn 요청을 받을 수 없습니다.',
        );
      }
      const now = this.#now().toISOString();
      this.#database.query(`
        INSERT INTO agent_runtime_conversation_turn_requests(
          request_id, conversation_id, expected_revision, intent_digest, status,
          public_turn_id, outcome_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'prepared', NULL, NULL, ?, ?)
      `).run(
        request.requestId,
        request.conversationId,
        request.expectedRevision,
        digest,
        now,
        now,
      );
      return { duplicate: false, indeterminate: false, conversation: current };
    });
    return transaction.immediate();
  }

  beginRequestedTurn(
    conversationId: string,
    requestId: string,
    expectedRevision: number,
    publicTurnId: string,
    providerTurnIdValue: string,
  ): AgentRuntimeConversationPrivateRecord {
    const transaction = this.#database.transaction(() => {
      const receipt = this.#turnReceipt(requestId, conversationId);
      if (receipt.status === 'running'
        && receipt.public_turn_id === publicTurnId
        && receipt.outcome_revision === expectedRevision) {
        const current = this.getPrivate(conversationId);
        if (current?.summary.state === 'running'
          && current.summary.activeTurnId === publicTurnId) return current;
      }
      if (receipt.status !== 'prepared'
        || receipt.public_turn_id !== null
        || receipt.outcome_revision !== null) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '대화 turn 요청 상태가 일치하지 않습니다.');
      }
      const running = this.beginTurn(
        conversationId,
        expectedRevision,
        publicTurnId,
        providerTurnIdValue,
      );
      const now = this.#now().toISOString();
      const changed = this.#database.query(`
        UPDATE agent_runtime_conversation_turn_requests
        SET status = 'running', public_turn_id = ?, outcome_revision = ?, updated_at = ?
        WHERE request_id = ? AND status = 'prepared'
      `).run(publicTurnId, running.summary.revision, now, requestId);
      if (changed.changes !== 1) {
        fail('AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT', '대화 turn 시작 기록을 갱신하지 못했습니다.');
      }
      return running;
    });
    return transaction.immediate();
  }

  finishRequestedTurn(
    conversationId: string,
    requestId: string,
    expectedRevision: number,
    publicTurnId: string,
    outcome: 'succeeded' | 'interrupted',
  ): AgentRuntimeConversationPrivateRecord {
    const transaction = this.#database.transaction(() => {
      const receipt = this.#turnReceipt(requestId, conversationId);
      if ((receipt.status === 'succeeded' || receipt.status === 'interrupted')
        && receipt.status === outcome
        && receipt.public_turn_id === publicTurnId) {
        const current = this.getPrivate(conversationId);
        if (current) return current;
      }
      if (receipt.status !== 'running' || receipt.public_turn_id !== publicTurnId) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '완료할 대화 turn 요청이 일치하지 않습니다.');
      }
      const finished = this.finishTurn(
        conversationId,
        expectedRevision,
        publicTurnId,
        outcome === 'interrupted' ? 'interrupted' : 'completed',
      );
      const now = this.#now().toISOString();
      const changed = this.#database.query(`
        UPDATE agent_runtime_conversation_turn_requests
        SET status = ?, outcome_revision = ?, updated_at = ?
        WHERE request_id = ? AND status = 'running' AND public_turn_id = ?
      `).run(outcome, finished.summary.revision, now, requestId, publicTurnId);
      if (changed.changes !== 1) {
        fail('AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT', '대화 turn 완료 기록을 갱신하지 못했습니다.');
      }
      return finished;
    });
    return transaction.immediate();
  }

  markRequestedTurnUnknown(
    conversationId: string,
    requestId: string,
    publicTurnId: string,
  ): AgentRuntimeConversationPrivateRecord {
    const transaction = this.#database.transaction(() => {
      const receipt = this.#turnReceipt(requestId, conversationId);
      const current = this.getPrivate(conversationId);
      if (!current) {
        fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
      }
      if (receipt.status === 'unknown') return current;
      if (receipt.status !== 'prepared'
        && !(receipt.status === 'running' && receipt.public_turn_id === publicTurnId)) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '불확실 처리할 대화 turn 요청이 일치하지 않습니다.');
      }
      const unknown = current.summary.state === 'unknown'
        ? current
        : this.markUnknown(conversationId, current.summary.revision, publicTurnId);
      const now = this.#now().toISOString();
      const changed = this.#database.query(`
        UPDATE agent_runtime_conversation_turn_requests
        SET status = 'unknown', public_turn_id = ?, outcome_revision = ?, updated_at = ?
        WHERE request_id = ? AND status IN ('prepared', 'running')
      `).run(publicTurnId, unknown.summary.revision, now, requestId);
      if (changed.changes !== 1) {
        fail('AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT', '대화 turn 불확실 기록을 갱신하지 못했습니다.');
      }
      return unknown;
    });
    return transaction.immediate();
  }

  bindProviderThread(
    conversationId: string,
    expectedRevision: number,
    providerThreadId: string,
  ): AgentRuntimeConversationPrivateRecord {
    if (!PROVIDER_ID_RE.test(providerThreadId)) {
      fail('AGENT_RUNTIME_CONVERSATION_PROVIDER_ID_INVALID', 'Codex 대화 식별자가 올바르지 않습니다.');
    }
    return this.#mutate(conversationId, expectedRevision, current => {
      if (current.summary.state !== 'unknown' || current.providerThreadId !== null) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '지속형 대화가 이미 연결되었습니다.');
      }
      return { state: 'idle', activeTurnId: null, providerThreadId, providerTurnId: null };
    });
  }

  beginTurn(
    conversationId: string,
    expectedRevision: number,
    turnId: string,
    providerTurnIdValue: string,
  ): AgentRuntimeConversationPrivateRecord {
    if (!OPAQUE_ID_RE.test(turnId) || !PROVIDER_ID_RE.test(providerTurnIdValue)) {
      fail('AGENT_RUNTIME_CONVERSATION_PROVIDER_ID_INVALID', '대화 turn 식별자가 올바르지 않습니다.');
    }
    return this.#mutate(conversationId, expectedRevision, current => {
      if (current.summary.state !== 'idle' || !current.providerThreadId) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '지속형 대화가 새 turn을 시작할 수 없습니다.');
      }
      return {
        state: 'running',
        activeTurnId: turnId,
        providerThreadId: current.providerThreadId,
        providerTurnId: providerTurnIdValue,
      };
    }, { type: 'conversation.turn.started', turnId });
  }

  /**
   * Persist only adapter-normalized semantic summaries while the exact turn is
   * still current. Raw provider notifications, command output, paths, and
   * reasoning text never enter this journal.
   */
  appendSemanticEvent(
    conversationId: string,
    expectedRevision: number,
    expectedTurnId: string,
    draft: AgentRuntimeConversationSemanticEventDraft,
  ): AgentRuntimeConversationEvent | null {
    const transaction = this.#database.transaction(() => {
      const current = this.getPrivate(conversationId);
      if (!current) {
        fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
      }
      if (current.summary.revision !== expectedRevision
        || current.summary.state !== 'running'
        || current.summary.activeTurnId !== expectedTurnId) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '의미 이벤트의 활성 대화 turn이 일치하지 않습니다.');
      }
      const validated = normalizeAgentRuntimeConversationEvent({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        conversationId,
        seq: 1,
        revision: expectedRevision,
        type: draft.type,
        turnId: expectedTurnId,
        payload: draft.payload,
        createdAt: this.#now().toISOString(),
      });
      if (validated.type !== 'conversation.progress'
        && validated.type !== 'conversation.artifact.summary') {
        fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', '의미 이벤트 종류가 올바르지 않습니다.');
      }
      const count = this.#database.query(`
        SELECT COUNT(*) AS count FROM agent_runtime_conversation_events
        WHERE conversation_id = ? AND turn_id = ?
      `).get(conversationId, expectedTurnId) as { count: unknown };
      if (typeof count.count !== 'number' || !Number.isSafeInteger(count.count) || count.count < 0) {
        fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', '대화 이벤트 개수가 올바르지 않습니다.');
      }
      // Keep the final lifecycle slot available even under a noisy provider.
      if (count.count >= AGENT_RUNTIME_CONVERSATION_MAX_EVENTS_PER_TURN - 1) return null;

      const last = this.#database.query(`
        SELECT seq, conversation_id, revision, event_type, turn_id,
               summary, phase, artifact_kind, artifact_label, created_at
        FROM agent_runtime_conversation_events
        WHERE conversation_id = ? AND turn_id = ?
        ORDER BY seq DESC LIMIT 1
      `).get(conversationId, expectedTurnId) as ConversationEventRow | null;
      if (last) {
        const previous = eventRecord(last);
        if (previous.type === validated.type
          && 'payload' in previous
          && JSON.stringify(previous.payload) === JSON.stringify(validated.payload)) return null;
      }
      return this.#appendEvent(
        conversationId,
        expectedRevision,
        validated.type,
        expectedTurnId,
        validated.createdAt,
        validated.payload,
      );
    });
    return transaction.immediate();
  }

  finishTurn(
    conversationId: string,
    expectedRevision: number,
    expectedTurnId: string,
    outcome: 'completed' | 'interrupted' = 'completed',
  ): AgentRuntimeConversationPrivateRecord {
    return this.#mutate(conversationId, expectedRevision, current => {
      if (current.summary.state !== 'running'
        || current.summary.activeTurnId !== expectedTurnId
        || !current.providerThreadId) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '활성 대화 turn이 일치하지 않습니다.');
      }
      return {
        state: 'idle',
        activeTurnId: null,
        providerThreadId: current.providerThreadId,
        providerTurnId: null,
      };
    }, {
      type: outcome === 'interrupted'
        ? 'conversation.turn.interrupted'
        : 'conversation.turn.completed',
      turnId: expectedTurnId,
    });
  }

  /**
   * A transport/process failure cannot prove whether Codex committed or is
   * still running the turn. Preserve the provider thread binding but require a
   * later thread/read or thread/resume reconciliation before another write.
   */
  markUnknown(
    conversationId: string,
    expectedRevision: number,
    eventTurnId?: string | null,
  ): AgentRuntimeConversationPrivateRecord {
    return this.#mutate(conversationId, expectedRevision, current => {
      if (current.summary.state === 'archived') {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '보관된 대화는 실행 상태를 변경할 수 없습니다.');
      }
      return {
        state: 'unknown',
        activeTurnId: null,
        providerThreadId: current.providerThreadId,
        providerTurnId: null,
      };
    }, {
      type: 'conversation.turn.unknown',
      turnId: eventTurnId === undefined
        ? this.get(conversationId)?.activeTurnId ?? null
        : eventTurnId,
    });
  }

  /** Called only after a fresh provider read proves the retained thread idle. */
  confirmProviderIdle(
    conversationId: string,
    expectedRevision: number,
    providerThreadIdValue: string,
  ): AgentRuntimeConversationPrivateRecord {
    if (!PROVIDER_ID_RE.test(providerThreadIdValue)) {
      fail('AGENT_RUNTIME_CONVERSATION_PROVIDER_ID_INVALID', 'Codex 대화 식별자가 올바르지 않습니다.');
    }
    return this.#mutate(conversationId, expectedRevision, current => {
      if (current.summary.state !== 'unknown'
        || current.providerThreadId !== providerThreadIdValue) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '확인한 Codex 대화 상태가 일치하지 않습니다.');
      }
      return {
        state: 'idle',
        activeTurnId: null,
        providerThreadId: current.providerThreadId,
        providerTurnId: null,
      };
    });
  }

  /**
   * On supervisor restart every in-memory provider boundary is gone. Do not
   * call running turns or prepared turn/lifecycle mutations cancelled or
   * completed; mark their exact current conversation unknown and fence stale
   * clients with a new revision.
   */
  reconcileInterruptedTurns(): number {
    const now = this.#now().toISOString();
    const transaction = this.#database.transaction(() => {
      const interrupted = this.#database.query(`
        SELECT conversation_id, revision, active_turn_id
        FROM agent_runtime_conversations WHERE state = 'running'
      `).all() as Array<{
        conversation_id: unknown;
        revision: unknown;
        active_turn_id: unknown;
      }>;
      const prepared = this.#database.query(`
        SELECT conversation_id, revision
        FROM agent_runtime_conversations AS conversation
        WHERE state IN ('idle', 'archived')
          AND (
            EXISTS (
              SELECT 1 FROM agent_runtime_conversation_turn_requests AS turn_request
              WHERE turn_request.conversation_id = conversation.conversation_id
                AND turn_request.expected_revision = conversation.revision
                AND turn_request.status = 'prepared'
            )
            OR EXISTS (
              SELECT 1 FROM agent_runtime_conversation_lifecycle_requests AS lifecycle_request
              WHERE lifecycle_request.conversation_id = conversation.conversation_id
                AND lifecycle_request.expected_revision = conversation.revision
                AND lifecycle_request.status = 'prepared'
            )
          )
      `).all() as Array<{ conversation_id: unknown; revision: unknown }>;
      const runningChanged = this.#database.query(`
        UPDATE agent_runtime_conversations
        SET state = 'unknown', active_turn_id = NULL, provider_turn_id = NULL,
            revision = revision + 1, updated_at = ?
        WHERE state = 'running'
      `).run(now);
      const preparedChanged = this.#database.query(`
        UPDATE agent_runtime_conversations AS conversation
        SET state = 'unknown', active_turn_id = NULL, provider_turn_id = NULL,
            revision = revision + 1, updated_at = ?
        WHERE state IN ('idle', 'archived')
          AND (
            EXISTS (
              SELECT 1 FROM agent_runtime_conversation_turn_requests AS turn_request
              WHERE turn_request.conversation_id = conversation.conversation_id
                AND turn_request.expected_revision = conversation.revision
                AND turn_request.status = 'prepared'
            )
            OR EXISTS (
              SELECT 1 FROM agent_runtime_conversation_lifecycle_requests AS lifecycle_request
              WHERE lifecycle_request.conversation_id = conversation.conversation_id
                AND lifecycle_request.expected_revision = conversation.revision
                AND lifecycle_request.status = 'prepared'
            )
          )
      `).run(now);
      for (const row of interrupted) {
        this.#appendEvent(
          opaque(row.conversation_id, 'conversation_id'),
          safeRevision(row.revision) + 1,
          'conversation.turn.unknown',
          opaque(row.active_turn_id, 'active_turn_id'),
          now,
        );
      }
      for (const row of prepared) {
        this.#appendEvent(
          opaque(row.conversation_id, 'conversation_id'),
          safeRevision(row.revision) + 1,
          'conversation.turn.unknown',
          null,
          now,
        );
      }
      this.#database.query(`
        UPDATE agent_runtime_conversation_turn_requests
        SET status = 'unknown',
            outcome_revision = (
              SELECT revision FROM agent_runtime_conversations
              WHERE conversation_id = agent_runtime_conversation_turn_requests.conversation_id
            ),
            updated_at = ?
        WHERE status = 'running'
          AND EXISTS (
            SELECT 1 FROM agent_runtime_conversations
            WHERE conversation_id = agent_runtime_conversation_turn_requests.conversation_id
              AND state = 'unknown'
          )
      `).run(now);
      return runningChanged.changes + preparedChanged.changes;
    });
    return transaction.immediate();
  }

  setArchived(
    conversationId: string,
    expectedRevision: number,
    archived: boolean,
  ): AgentRuntimeConversationPrivateRecord {
    return this.#mutate(conversationId, expectedRevision, current => {
      const expectedState = archived ? 'idle' : 'archived';
      if (current.summary.state !== expectedState || !current.providerThreadId) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '지속형 대화 보관 상태가 일치하지 않습니다.');
      }
      return {
        state: archived ? 'archived' : 'idle',
        activeTurnId: null,
        providerThreadId: current.providerThreadId,
        providerTurnId: null,
      };
    });
  }

  findLifecycleMutation(
    input: AgentRuntimeConversationLifecycleIntent,
  ): PreparedAgentRuntimeConversationLifecycleMutation | null {
    const validated = this.#lifecycleIntent(input);
    const digest = this.#lifecycleIntentDigest(validated);
    let row = this.#database.query(`
      SELECT conversation_id, action, expected_revision, intent_digest, status, outcome_revision
      FROM agent_runtime_conversation_lifecycle_requests WHERE request_id = ?
    `).get(validated.requestId) as Record<string, unknown> | null;
    if (row && (row.conversation_id !== validated.conversationId
      || row.action !== validated.action
      || row.expected_revision !== validated.expectedRevision
      || row.intent_digest !== digest)) {
      fail(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
        '같은 요청 ID가 다른 지속형 대화 수명주기 변경에 사용되었습니다.',
      );
    }
    row ??= this.#database.query(`
      SELECT conversation_id, action, expected_revision, intent_digest, status, outcome_revision
      FROM agent_runtime_conversation_lifecycle_requests
      WHERE conversation_id = ? AND action = ? AND expected_revision = ?
    `).get(
      validated.conversationId,
      validated.action,
      validated.expectedRevision,
    ) as Record<string, unknown> | null;
    if (!row) return null;
    if (row.intent_digest !== digest) {
      fail(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
        '같은 대화 상태 변경의 영속 의도가 일치하지 않습니다.',
      );
    }
    const current = this.getPrivate(validated.conversationId);
    if (row.status === 'completed') {
      if (validated.action === 'delete' && current === null) {
        return { duplicate: true, indeterminate: false, conversation: null };
      }
      const desiredState = validated.action === 'archive' ? 'archived' : 'idle';
      if (!current
        || current.summary.revision !== row.outcome_revision
        || current.summary.state !== desiredState) {
        fail(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_RETIRED',
          '완료된 대화 상태 변경 뒤 대화가 다시 변경되었습니다.',
        );
      }
      return { duplicate: true, indeterminate: false, conversation: current };
    }
    return { duplicate: true, indeterminate: true, conversation: current };
  }

  prepareLifecycleMutation(
    input: AgentRuntimeConversationLifecycleIntent,
  ): PreparedAgentRuntimeConversationLifecycleMutation {
    const validated = this.#lifecycleIntent(input);
    const transaction = this.#database.transaction(() => {
      const existing = this.findLifecycleMutation(validated);
      if (existing) return existing;
      const current = this.getPrivate(validated.conversationId);
      if (!current) {
        fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
      }
      const stateAllowed = validated.action === 'archive'
        ? current.summary.state === 'idle'
        : validated.action === 'unarchive'
          ? current.summary.state === 'archived'
          : current.summary.state === 'idle' || current.summary.state === 'archived';
      if (current.summary.revision !== validated.expectedRevision
        || !stateAllowed
        || !current.providerThreadId) {
        fail(
          'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT',
          '지속형 대화 수명주기 상태가 일치하지 않습니다.',
        );
      }
      const now = this.#now().toISOString();
      this.#database.query(`
        INSERT INTO agent_runtime_conversation_lifecycle_requests(
          request_id, conversation_id, action, expected_revision, intent_digest,
          status, outcome_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)
      `).run(
        validated.requestId,
        validated.conversationId,
        validated.action,
        validated.expectedRevision,
        this.#lifecycleIntentDigest(validated),
        now,
        now,
      );
      return { duplicate: false, indeterminate: false, conversation: current };
    });
    return transaction.immediate();
  }

  completeLifecycleArchiveMutation(
    input: AgentRuntimeConversationLifecycleIntent,
  ): AgentRuntimeConversationPrivateRecord {
    const validated = this.#lifecycleIntent(input);
    if (validated.action !== 'archive' && validated.action !== 'unarchive') {
      fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'archive action is invalid.');
    }
    const transaction = this.#database.transaction(() => {
      const receipt = this.#lifecycleReceipt(validated);
      if (receipt.status === 'completed') {
        const duplicate = this.findLifecycleMutation(validated);
        if (duplicate?.conversation) return duplicate.conversation;
      }
      if (receipt.status !== 'prepared') {
        fail(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
          '대화 상태 변경의 적용 여부를 확인할 수 없습니다.',
        );
      }
      const current = this.getPrivate(validated.conversationId);
      const expectedState = validated.action === 'archive' ? 'idle' : 'archived';
      if (!current
        || current.summary.revision !== validated.expectedRevision
        || current.summary.state !== expectedState
        || !current.providerThreadId) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '대화 보관 상태가 일치하지 않습니다.');
      }
      const now = this.#now().toISOString();
      const changed = this.#database.query(`
        UPDATE agent_runtime_conversations
        SET state = ?, revision = revision + 1, updated_at = ?
        WHERE conversation_id = ? AND revision = ? AND state = ?
      `).run(
        validated.action === 'archive' ? 'archived' : 'idle',
        now,
        validated.conversationId,
        validated.expectedRevision,
        expectedState,
      );
      if (changed.changes !== 1) {
        fail('AGENT_RUNTIME_CONVERSATION_REVISION_CONFLICT', '대화 상태가 먼저 변경되었습니다.');
      }
      this.#database.query(`
        UPDATE agent_runtime_conversation_lifecycle_requests
        SET status = 'completed', outcome_revision = ?, updated_at = ?
        WHERE request_id = ? AND status = 'prepared'
      `).run(validated.expectedRevision + 1, now, validated.requestId);
      return this.getPrivate(validated.conversationId)!;
    });
    return transaction.immediate();
  }

  markLifecycleMutationIndeterminate(
    input: AgentRuntimeConversationLifecycleIntent,
  ): AgentRuntimeConversationPrivateRecord | null {
    const validated = this.#lifecycleIntent(input);
    const transaction = this.#database.transaction(() => {
      const receipt = this.#lifecycleReceipt(validated);
      const current = this.getPrivate(validated.conversationId);
      if (receipt.status === 'completed' || receipt.status === 'indeterminate') return current;
      const now = this.#now().toISOString();
      this.#database.query(`
        UPDATE agent_runtime_conversation_lifecycle_requests
        SET status = 'indeterminate', updated_at = ?
        WHERE request_id = ? AND status = 'prepared'
      `).run(now, validated.requestId);
      if (current?.summary.revision === validated.expectedRevision
        && current.summary.state !== 'running'
        && current.summary.state !== 'unknown') {
        this.#database.query(`
          UPDATE agent_runtime_conversations
          SET state = 'unknown', active_turn_id = NULL, provider_turn_id = NULL,
              revision = revision + 1, updated_at = ?
          WHERE conversation_id = ? AND revision = ?
        `).run(now, validated.conversationId, validated.expectedRevision);
      }
      return this.getPrivate(validated.conversationId);
    });
    return transaction.immediate();
  }

  completeDeleteLifecycleReceipt(input: AgentRuntimeConversationLifecycleIntent): void {
    const validated = this.#lifecycleIntent(input);
    if (validated.action !== 'delete') {
      fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'delete action is invalid.');
    }
    const receipt = this.#lifecycleReceipt(validated);
    if (receipt.status === 'completed') return;
    if (receipt.status !== 'prepared') {
      fail(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
        '대화 삭제의 적용 여부를 확인할 수 없습니다.',
      );
    }
    const now = this.#now().toISOString();
    const changed = this.#database.query(`
      UPDATE agent_runtime_conversation_lifecycle_requests
      SET status = 'completed', outcome_revision = ?, updated_at = ?
      WHERE request_id = ? AND status = 'prepared'
    `).run(validated.expectedRevision + 1, now, validated.requestId);
    if (changed.changes !== 1) {
      fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '대화 삭제 요청 상태가 일치하지 않습니다.');
    }
  }

  prepareLiveControl(
    input: AgentRuntimeConversationLiveControlIntent,
  ): PreparedAgentRuntimeConversationLiveControl {
    const validated = this.#liveControlIntent(input);
    const digest = this.#liveControlIntentDigest(validated);
    const transaction = this.#database.transaction(() => {
      let existing = this.#database.query(`
        SELECT conversation_id, action, expected_revision, expected_turn_id,
               intent_digest, status
        FROM agent_runtime_conversation_live_requests WHERE request_id = ?
      `).get(validated.requestId) as Record<string, unknown> | null;
      if (existing) {
        const same = existing.conversation_id === validated.conversationId
          && existing.action === validated.action
          && existing.expected_revision === validated.expectedRevision
          && existing.expected_turn_id === validated.expectedTurnId
          && existing.intent_digest === digest;
        if (!same) {
          fail(
            'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
            '같은 요청 ID가 다른 지속형 대화 제어에 사용되었습니다.',
          );
        }
      }
      const semanticRows = this.#database.query(`
        SELECT conversation_id, action, expected_revision, expected_turn_id,
               intent_digest, status
        FROM agent_runtime_conversation_live_requests
        WHERE conversation_id = ? AND expected_revision = ?
        ORDER BY created_at ASC, request_id ASC
      `).all(
        validated.conversationId,
        validated.expectedRevision,
      ) as Array<Record<string, unknown>>;
      if (semanticRows.length > 0) {
        const same = semanticRows.every(row => (
          row.action === validated.action
          && row.expected_turn_id === validated.expectedTurnId
          && row.intent_digest === digest
        ));
        if (!same) {
          fail(
            'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
            '같은 대화 revision에 다른 제어 요청이 이미 준비되었습니다.',
          );
        }
        existing = {
          ...(existing ?? semanticRows[0]!),
          status: semanticRows.every(row => row.status === 'accepted')
            ? 'accepted'
            : 'indeterminate',
        };
      }
      if (existing) {
        const current = this.get(validated.conversationId);
        if (!current) {
          fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
        }
        if (existing.status === 'accepted') {
          return { duplicate: true, indeterminate: false, conversation: current };
        }
        return { duplicate: true, indeterminate: true, conversation: current };
      }
      const current = this.get(validated.conversationId);
      if (!current) {
        fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
      }
      if (current.revision !== validated.expectedRevision
        || current.state !== 'running'
        || current.activeTurnId !== validated.expectedTurnId) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '활성 대화 turn이 일치하지 않습니다.');
      }
      const now = this.#now().toISOString();
      this.#database.query(`
        INSERT INTO agent_runtime_conversation_live_requests(
          request_id, conversation_id, action, expected_revision, expected_turn_id,
          intent_digest, status, outcome_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)
      `).run(
        validated.requestId,
        validated.conversationId,
        validated.action,
        validated.expectedRevision,
        validated.expectedTurnId,
        digest,
        now,
        now,
      );
      return { duplicate: false, indeterminate: false, conversation: current };
    });
    return transaction.immediate();
  }

  completeLiveControl(
    input: AgentRuntimeConversationLiveControlIntent,
  ): AgentRuntimeConversationSummary {
    const validated = this.#liveControlIntent(input);
    const digest = this.#liveControlIntentDigest(validated);
    const transaction = this.#database.transaction(() => {
      const receipt = this.#database.query(`
        SELECT conversation_id, action, expected_revision, expected_turn_id,
               intent_digest, status
        FROM agent_runtime_conversation_live_requests WHERE request_id = ?
      `).get(validated.requestId) as Record<string, unknown> | null;
      if (!receipt
        || receipt.conversation_id !== validated.conversationId
        || receipt.action !== validated.action
        || receipt.expected_revision !== validated.expectedRevision
        || receipt.expected_turn_id !== validated.expectedTurnId
        || receipt.intent_digest !== digest) {
        fail('AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT', '대화 제어 준비 기록이 일치하지 않습니다.');
      }
      const current = this.get(validated.conversationId);
      if (!current) {
        fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
      }
      if (receipt.status === 'accepted') return current;
      if (receipt.status !== 'prepared') {
        fail(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
          '이 대화 제어 요청의 provider 반영 여부를 확인할 수 없습니다.',
        );
      }

      let outcome = current;
      if (current.state === 'running'
        && current.revision === validated.expectedRevision
        && current.activeTurnId === validated.expectedTurnId) {
        const now = this.#now().toISOString();
        const changed = this.#database.query(`
          UPDATE agent_runtime_conversations
          SET revision = revision + 1, updated_at = ?
          WHERE conversation_id = ? AND revision = ? AND state = 'running'
            AND active_turn_id = ?
        `).run(
          now,
          validated.conversationId,
          validated.expectedRevision,
          validated.expectedTurnId,
        );
        if (changed.changes !== 1) {
          fail('AGENT_RUNTIME_CONVERSATION_REVISION_CONFLICT', '대화 상태가 제어 중 변경되었습니다.');
        }
        outcome = this.get(validated.conversationId)!;
      } else if (current.revision < validated.expectedRevision
        || (current.state === 'running' && current.activeTurnId !== validated.expectedTurnId)) {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '활성 대화 turn이 일치하지 않습니다.');
      }
      const updatedAt = this.#now().toISOString();
      const updated = this.#database.query(`
        UPDATE agent_runtime_conversation_live_requests
        SET status = 'accepted', outcome_revision = ?, updated_at = ?
        WHERE request_id = ? AND status = 'prepared'
      `).run(outcome.revision, updatedAt, validated.requestId);
      if (updated.changes !== 1) {
        fail('AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT', '대화 제어 결과를 기록하지 못했습니다.');
      }
      return outcome;
    });
    return transaction.immediate();
  }

  markLiveControlIndeterminate(
    input: AgentRuntimeConversationLiveControlIntent,
  ): AgentRuntimeConversationSummary {
    const validated = this.#liveControlIntent(input);
    const digest = this.#liveControlIntentDigest(validated);
    const transaction = this.#database.transaction(() => {
      const receipt = this.#database.query(`
        SELECT conversation_id, action, expected_revision, expected_turn_id,
               intent_digest, status
        FROM agent_runtime_conversation_live_requests WHERE request_id = ?
      `).get(validated.requestId) as Record<string, unknown> | null;
      if (!receipt
        || receipt.conversation_id !== validated.conversationId
        || receipt.action !== validated.action
        || receipt.expected_revision !== validated.expectedRevision
        || receipt.expected_turn_id !== validated.expectedTurnId
        || receipt.intent_digest !== digest) {
        fail('AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT', '대화 제어 준비 기록이 일치하지 않습니다.');
      }
      let current = this.getPrivate(validated.conversationId);
      if (!current) {
        fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
      }
      if (receipt.status === 'accepted') return current.summary;
      if (receipt.status === 'prepared') {
        const now = this.#now().toISOString();
        this.#database.query(`
          UPDATE agent_runtime_conversation_live_requests
          SET status = 'indeterminate', updated_at = ?
          WHERE request_id = ? AND status = 'prepared'
        `).run(now, validated.requestId);
        if (current.summary.state === 'running'
          && current.summary.activeTurnId === validated.expectedTurnId) {
          current = this.markUnknown(validated.conversationId, current.summary.revision);
        }
      }
      return current.summary;
    });
    return transaction.immediate();
  }

  finalizeDelete(
    conversationId: string,
    expectedRevision: number,
    deleteRequestId: string,
  ): { duplicate: boolean } {
    if (!OPAQUE_ID_RE.test(conversationId) || !OPAQUE_ID_RE.test(deleteRequestId)) {
      fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'delete identity is invalid.');
    }
    const transaction = this.#database.transaction(() => {
      const existingTombstone = this.#database.query(`
        SELECT conversation_id FROM agent_runtime_conversation_tombstones
        WHERE delete_request_id = ?
      `).get(deleteRequestId) as { conversation_id: unknown } | null;
      if (existingTombstone) {
        if (existingTombstone.conversation_id !== conversationId) {
          fail(
            'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
            '같은 삭제 요청 ID가 다른 지속형 대화에 사용되었습니다.',
          );
        }
        return { duplicate: true };
      }
      const row = this.#database.query(`
        SELECT ${SELECT_COLUMNS} FROM agent_runtime_conversations WHERE conversation_id = ?
      `).get(conversationId) as ConversationRow | null;
      if (!row) {
        fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
      }
      const current = record(row);
      if (current.summary.revision !== expectedRevision) {
        fail('AGENT_RUNTIME_CONVERSATION_REVISION_CONFLICT', '다른 단말에서 대화 상태가 먼저 변경되었습니다.');
      }
      if (current.summary.state !== 'idle' && current.summary.state !== 'archived') {
        fail('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '실행 중이거나 불확실한 대화는 삭제할 수 없습니다.');
      }
      const createRequestId = opaque(row.create_request_id, 'create_request_id');
      const createIntentDigestValue = typeof row.create_intent_digest === 'string'
        && /^[a-f0-9]{64}$/.test(row.create_intent_digest)
        ? row.create_intent_digest
        : fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'create intent digest is invalid.');
      const deletedAt = this.#now().toISOString();
      this.#database.query(`
        INSERT INTO agent_runtime_conversation_tombstones(
          conversation_id, create_request_id, create_intent_digest, delete_request_id, deleted_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        conversationId,
        createRequestId,
        createIntentDigestValue,
        deleteRequestId,
        deletedAt,
      );
      const deleted = this.#database.query(`
        DELETE FROM agent_runtime_conversations WHERE conversation_id = ? AND revision = ?
      `).run(conversationId, expectedRevision);
      // Bun/SQLite may include ON DELETE CASCADE rows in this result. The
      // revision-fenced parent deletion itself is successful whenever at
      // least one row changed; zero remains the CAS failure signal.
      if (deleted.changes < 1) {
        fail('AGENT_RUNTIME_CONVERSATION_REVISION_CONFLICT', '다른 단말에서 대화 상태가 먼저 변경되었습니다.');
      }
      return { duplicate: false };
    });
    return transaction.immediate();
  }

  isDeleteFinalized(conversationId: string, deleteRequestId: string): boolean {
    if (!OPAQUE_ID_RE.test(conversationId) || !OPAQUE_ID_RE.test(deleteRequestId)) return false;
    const row = this.#database.query(`
      SELECT conversation_id FROM agent_runtime_conversation_tombstones
      WHERE delete_request_id = ?
    `).get(deleteRequestId) as { conversation_id: unknown } | null;
    if (!row) return false;
    if (row.conversation_id !== conversationId) {
      fail(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
        '같은 삭제 요청 ID가 다른 지속형 대화에 사용되었습니다.',
      );
    }
    return true;
  }

  #lifecycleIntent(
    input: AgentRuntimeConversationLifecycleIntent,
  ): AgentRuntimeConversationLifecycleIntent {
    if (!OPAQUE_ID_RE.test(input.requestId)
      || !OPAQUE_ID_RE.test(input.conversationId)
      || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 1
      || !['archive', 'unarchive', 'delete'].includes(input.action)) {
      fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'lifecycle intent is invalid.');
    }
    return input;
  }

  #lifecycleIntentDigest(input: AgentRuntimeConversationLifecycleIntent): string {
    return createHash('sha256').update(JSON.stringify([
      input.conversationId,
      input.action,
      input.expectedRevision,
    ])).digest('hex');
  }

  #lifecycleReceipt(input: AgentRuntimeConversationLifecycleIntent): Record<string, unknown> {
    const receipt = this.#database.query(`
      SELECT conversation_id, action, expected_revision, intent_digest, status, outcome_revision
      FROM agent_runtime_conversation_lifecycle_requests WHERE request_id = ?
    `).get(input.requestId) as Record<string, unknown> | null;
    if (!receipt
      || receipt.conversation_id !== input.conversationId
      || receipt.action !== input.action
      || receipt.expected_revision !== input.expectedRevision
      || receipt.intent_digest !== this.#lifecycleIntentDigest(input)) {
      fail(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
        '대화 수명주기 변경 준비 기록이 일치하지 않습니다.',
      );
    }
    return receipt;
  }

  #liveControlIntent(
    input: AgentRuntimeConversationLiveControlIntent,
  ): AgentRuntimeConversationLiveControlIntent {
    if (!OPAQUE_ID_RE.test(input.requestId)
      || !OPAQUE_ID_RE.test(input.conversationId)
      || !OPAQUE_ID_RE.test(input.expectedTurnId)
      || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 1
      || (input.action !== 'steer' && input.action !== 'interrupt')
      || (input.action === 'steer'
        ? typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.includes('\u0000')
        : input.prompt !== undefined)) {
      fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'live control intent is invalid.');
    }
    return input;
  }

  #turnReceipt(requestId: string, conversationId: string): Record<string, unknown> {
    if (!OPAQUE_ID_RE.test(requestId) || !OPAQUE_ID_RE.test(conversationId)) {
      fail('AGENT_RUNTIME_CONVERSATION_JOURNAL_CORRUPT', 'turn request identity is invalid.');
    }
    const receipt = this.#database.query(`
      SELECT conversation_id, expected_revision, intent_digest, status,
             public_turn_id, outcome_revision
      FROM agent_runtime_conversation_turn_requests WHERE request_id = ?
    `).get(requestId) as Record<string, unknown> | null;
    if (!receipt || receipt.conversation_id !== conversationId) {
      fail('AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT', '대화 turn 요청 기록이 일치하지 않습니다.');
    }
    return receipt;
  }

  #liveControlIntentDigest(input: AgentRuntimeConversationLiveControlIntent): string {
    return createHash('sha256').update(JSON.stringify([
      input.conversationId,
      input.action,
      input.expectedRevision,
      input.expectedTurnId,
      input.prompt ?? null,
    ])).digest('hex');
  }

  #mutate(
    conversationId: string,
    expectedRevision: number,
    next: (current: AgentRuntimeConversationPrivateRecord) => {
      state: AgentRuntimeConversationState;
      activeTurnId: string | null;
      providerThreadId: string | null;
      providerTurnId: string | null;
    },
    event?: {
      type: AgentRuntimeConversationEventType;
      turnId: string | null;
    },
  ): AgentRuntimeConversationPrivateRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getPrivate(conversationId);
      if (!current) {
        fail('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
      }
      if (current.summary.revision !== expectedRevision) {
        fail('AGENT_RUNTIME_CONVERSATION_REVISION_CONFLICT', '다른 단말에서 대화 상태가 먼저 변경되었습니다.');
      }
      const value = next(current);
      const now = this.#now().toISOString();
      const changed = this.#database.query(`
        UPDATE agent_runtime_conversations
        SET state = ?, active_turn_id = ?, provider_thread_id = ?, provider_turn_id = ?,
            revision = revision + 1, updated_at = ?
        WHERE conversation_id = ? AND revision = ?
      `).run(
        value.state,
        value.activeTurnId,
        value.providerThreadId,
        value.providerTurnId,
        now,
        conversationId,
        expectedRevision,
      );
      if (changed.changes !== 1) {
        fail('AGENT_RUNTIME_CONVERSATION_REVISION_CONFLICT', '다른 단말에서 대화 상태가 먼저 변경되었습니다.');
      }
      if (event) {
        this.#appendEvent(
          conversationId,
          expectedRevision + 1,
          event.type,
          event.turnId,
          now,
        );
      }
      return this.getPrivate(conversationId)!;
    });
    return transaction.immediate();
  }

  #appendEvent(
    conversationId: string,
    revision: number,
    type: AgentRuntimeConversationEventType,
    turnId: string | null,
    createdAt: string,
    payload?: AgentRuntimeConversationSemanticEventDraft['payload'],
  ): AgentRuntimeConversationEvent {
    const event = normalizeAgentRuntimeConversationEvent({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId,
      seq: 1,
      revision,
      type,
      turnId,
      createdAt,
      ...(payload === undefined ? {} : { payload }),
    });
    const inserted = this.#database.query(`
      INSERT INTO agent_runtime_conversation_events(
        conversation_id, revision, event_type, turn_id,
        summary, phase, artifact_kind, artifact_label, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversationId,
      revision,
      type,
      turnId,
      'payload' in event ? event.payload.summary : null,
      event.type === 'conversation.progress' ? event.payload.phase : null,
      event.type === 'conversation.artifact.summary' ? event.payload.kind : null,
      event.type === 'conversation.artifact.summary' ? event.payload.label : null,
      createdAt,
    );
    this.#database.query(`
      DELETE FROM agent_runtime_conversation_events
      WHERE conversation_id = ? AND seq IN (
        SELECT seq FROM agent_runtime_conversation_events
        WHERE conversation_id = ?
        ORDER BY seq DESC
        LIMIT -1 OFFSET ?
      )
    `).run(
      conversationId,
      conversationId,
      AGENT_RUNTIME_CONVERSATION_MAX_RETAINED_EVENTS,
    );
    return normalizeAgentRuntimeConversationEvent({
      ...event,
      seq: Number(inserted.lastInsertRowid),
    });
  }
}

export function openAgentRuntimeConversationJournal(
  path: string,
  options: AgentRuntimeConversationJournalOptions = {},
): AgentRuntimeConversationJournal {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true, strict: true });
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  return new AgentRuntimeConversationJournal(database, options);
}
