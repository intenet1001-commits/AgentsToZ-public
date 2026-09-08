import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AgentRuntimeConversationJournalError,
  openAgentRuntimeConversationJournal,
} from '../src/agentRuntimeConversationJournal';
import {
  AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  type AgentRuntimeConversationEvent,
} from '../src/agentRuntimeConversationProtocol';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-conversations-'));
  roots.push(root);
  const path = join(root, 'conversations.sqlite');
  let tick = 0;
  const journal = openAgentRuntimeConversationJournal(path, {
    now: () => new Date(Date.UTC(2026, 8, 5, 0, tick++)),
    createConversationId: () => 'conversation_12345678',
  });
  return { root, path, journal };
}

function createRequest(prompt = '현재 변경을 검토하고 테스트해줘.') {
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    requestId: 'request_12345678',
    targetId: 'target_12345678',
    adapterId: 'codex',
    modelId: 'gpt-5.6-sol',
    historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
    initialPrompt: prompt,
  } as const;
}

function continueRequest(expectedRevision = 2, prompt = '이어서 회귀 테스트를 실행해줘.') {
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    requestId: 'request_continue_12345678',
    conversationId: 'conversation_12345678',
    expectedRevision,
    prompt,
  } as const;
}

describe('persistent agent conversation journal', () => {
  test('durably maps an opaque conversation to private provider ids without storing prompts', () => {
    const { path, journal } = fixture();
    const created = journal.create(createRequest(), 'AgentsToZ');
    expect(created.duplicate).toBe(false);
    expect(created.conversation.summary).toMatchObject({
      conversationId: 'conversation_12345678',
      targetId: 'target_12345678',
      projectLabel: 'AgentsToZ',
      state: 'unknown',
      activeTurnId: null,
      revision: 1,
    });
    expect(created.conversation.providerThreadId).toBeNull();

    journal.close();
    const database = new Database(path, { readonly: true, strict: true });
    const columns = database.query('PRAGMA table_info(agent_runtime_conversations)')
      .all() as Array<{ name: string }>;
    const names = columns.map(column => column.name);
    expect(names).not.toContain('prompt');
    expect(names).not.toContain('initial_prompt');
    expect(names).not.toContain('transcript');
    expect(JSON.stringify(database.query('SELECT * FROM agent_runtime_conversations').get()))
      .not.toContain('현재 변경을 검토');
    database.close();
  });

  test('makes create retry-safe without allowing one request id to change intent', () => {
    const { journal } = fixture();
    const first = journal.create(createRequest(), 'AgentsToZ');
    const retried = journal.create(createRequest(), 'AgentsToZ');
    expect(retried.duplicate).toBe(true);
    expect(retried.conversation.summary.conversationId)
      .toBe(first.conversation.summary.conversationId);
    expect(() => journal.create(createRequest('다른 요청'), 'AgentsToZ')).toThrow(
      AgentRuntimeConversationJournalError,
    );
    try {
      journal.create(createRequest('다른 요청'), 'AgentsToZ');
    } catch (error) {
      expect((error as AgentRuntimeConversationJournalError).code)
        .toBe('AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT');
    }
    journal.close();
  });

  test('uses revision-fenced unknown, idle, running, and archived transitions', () => {
    const { journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    const bound = journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    expect(bound.summary).toMatchObject({ state: 'idle', revision: 2 });
    expect(bound.providerThreadId).toBe('provider_thread_12345678');

    const running = journal.beginTurn(id, 2, 'turn_12345678', 'provider_turn_12345678');
    expect(running.summary).toMatchObject({
      state: 'running', activeTurnId: 'turn_12345678', revision: 3,
    });
    expect(running.providerTurnId).toBe('provider_turn_12345678');
    expect(() => journal.setArchived(id, 3, true)).toThrow();

    const idle = journal.finishTurn(id, 3, 'turn_12345678');
    expect(idle.summary).toMatchObject({ state: 'idle', activeTurnId: null, revision: 4 });
    expect(idle.providerTurnId).toBeNull();
    const archived = journal.setArchived(id, 4, true);
    expect(archived.summary).toMatchObject({ state: 'archived', revision: 5 });
    expect(journal.list()).toEqual([]);
    expect(journal.list(true)).toHaveLength(1);
    expect(journal.setArchived(id, 5, false).summary.state).toBe('idle');

    expect(() => journal.beginTurn(id, 5, 'turn_87654321', 'provider_turn_87654321'))
      .toThrow();
    expect(journal.readEvents(id)).toMatchObject([
      {
        seq: 1,
        revision: 3,
        type: 'conversation.turn.started',
        turnId: 'turn_12345678',
      },
      {
        seq: 2,
        revision: 4,
        type: 'conversation.turn.completed',
        turnId: 'turn_12345678',
      },
    ]);
    expect(journal.readEvents(id, 1)).toHaveLength(1);
    expect(() => journal.readEvents(id, -1)).toThrow();
    journal.close();
  });

  test('makes continued turns durable and replay-safe without retaining prompt text', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    const request = continueRequest();
    expect(journal.prepareContinue(request)).toMatchObject({
      duplicate: false,
      indeterminate: false,
      conversation: { summary: { state: 'idle', revision: 2 } },
    });
    expect(journal.prepareContinue(request)).toMatchObject({
      duplicate: true,
      indeterminate: true,
    });
    expect(journal.prepareContinue({
      ...request,
      requestId: 'request_continue_retry_87654321',
    })).toMatchObject({
      duplicate: true,
      indeterminate: true,
    });
    expect(() => journal.prepareContinue({ ...request, prompt: '다른 요청' })).toThrow();
    expect(() => journal.prepareContinue({
      ...request,
      requestId: 'request_continue_other_87654321',
      prompt: '다른 요청',
    })).toThrow();
    const running = journal.beginRequestedTurn(
      id,
      request.requestId,
      2,
      'turn_12345678',
      'provider_turn_12345678',
    );
    expect(running.summary).toMatchObject({ state: 'running', revision: 3 });
    expect(journal.prepareContinue(request)).toMatchObject({
      duplicate: true,
      indeterminate: false,
      conversation: { summary: { state: 'running', revision: 3 } },
    });
    const finished = journal.finishRequestedTurn(
      id,
      request.requestId,
      3,
      'turn_12345678',
      'succeeded',
    );
    expect(finished.summary).toMatchObject({ state: 'idle', revision: 4 });
    expect(journal.prepareContinue(request)).toMatchObject({
      duplicate: true,
      indeterminate: false,
      conversation: { summary: { state: 'idle', revision: 4 } },
    });
    journal.close();

    const database = new Database(path, { readonly: true, strict: true });
    const serialized = JSON.stringify(database.query(`
      SELECT * FROM agent_runtime_conversation_turn_requests
    `).all());
    expect(serialized).not.toContain('이어서 회귀 테스트');
    expect(serialized).toContain('succeeded');
    database.close();
  });

  test('migrates v1 journals and reconciles a running requested turn to unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-conversations-v1-'));
    roots.push(root);
    const path = join(root, 'conversations.sqlite');
    const legacy = new Database(path, { create: true, strict: true });
    legacy.exec(`
      CREATE TABLE agent_runtime_conversation_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
      INSERT INTO agent_runtime_conversation_meta(singleton, schema_version) VALUES (1, 1);
    `);
    legacy.close();

    const migrated = openAgentRuntimeConversationJournal(path, {
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      createConversationId: () => 'conversation_12345678',
    });
    const id = migrated.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    migrated.bindProviderThread(id, 1, 'provider_thread_12345678');
    const request = continueRequest();
    migrated.prepareContinue(request);
    migrated.beginRequestedTurn(
      id,
      request.requestId,
      2,
      'turn_12345678',
      'provider_turn_12345678',
    );
    expect(migrated.reconcileInterruptedTurns()).toBe(1);
    expect(migrated.get(id)).toMatchObject({ state: 'unknown', revision: 4 });
    expect(migrated.readEvents(id)).toMatchObject([
      { seq: 1, type: 'conversation.turn.started', revision: 3 },
      { seq: 2, type: 'conversation.turn.unknown', revision: 4 },
    ]);
    expect(migrated.prepareContinue(request)).toMatchObject({
      duplicate: true,
      indeterminate: true,
      conversation: { summary: { state: 'unknown', revision: 4 } },
    });
    migrated.close();

    const verified = new Database(path, { readonly: true, strict: true });
    expect(verified.query(`
      SELECT schema_version FROM agent_runtime_conversation_meta WHERE singleton = 1
    `).get()).toEqual({ schema_version: 5 });
    expect(verified.query(`
      SELECT status, outcome_revision FROM agent_runtime_conversation_turn_requests
      WHERE request_id = ?
    `).get(request.requestId)).toEqual({ status: 'unknown', outcome_revision: 4 });
    verified.close();
  });

  test('persists bounded semantic progress cards and reserves the terminal lifecycle event', () => {
    const { journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    journal.beginTurn(id, 2, 'turn_12345678', 'provider_turn_12345678');

    expect(journal.appendSemanticEvent(id, 3, 'turn_12345678', {
      type: 'conversation.progress',
      payload: { summary: '작업 계획을 갱신했습니다. (1/3)', phase: 'planning' },
    })).toMatchObject({
      type: 'conversation.progress',
      payload: { phase: 'planning' },
    });
    expect(journal.appendSemanticEvent(id, 3, 'turn_12345678', {
      type: 'conversation.progress',
      payload: { summary: '작업 계획을 갱신했습니다. (1/3)', phase: 'planning' },
    })).toBeNull();
    expect(journal.appendSemanticEvent(id, 3, 'turn_12345678', {
      type: 'conversation.artifact.summary',
      payload: { kind: 'diff', label: '변경 사항', summary: '파일 변경 2건을 처리했습니다.' },
    })).toMatchObject({ type: 'conversation.artifact.summary' });

    for (let index = 0; index < 200; index += 1) {
      journal.appendSemanticEvent(id, 3, 'turn_12345678', {
        type: 'conversation.progress',
        payload: { summary: `검증 단계 ${index}`, phase: 'testing' },
      });
    }
    journal.finishTurn(id, 3, 'turn_12345678');
    const events = journal.readEvents(id, 0, 100);
    expect(events[1]).toMatchObject({
      type: 'conversation.progress',
      payload: { summary: '작업 계획을 갱신했습니다. (1/3)' },
    });
    expect(journal.readEvents(id, events.at(-1)!.seq, 100).at(-1)).toMatchObject({
      type: 'conversation.turn.completed',
    });
    expect(journal.latestEventSeq(id)).toBeGreaterThan(100);
    journal.close();
  });

  test('retains only the latest bounded event window across many turns', () => {
    const { journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    let revision = journal.bindProviderThread(id, 1, 'provider_thread_12345678').summary.revision;
    for (let turnIndex = 0; turnIndex < 5; turnIndex += 1) {
      const turnId = `turn_${String(turnIndex).padStart(8, '0')}`;
      revision = journal.beginTurn(
        id,
        revision,
        turnId,
        `provider_turn_${String(turnIndex).padStart(8, '0')}`,
      ).summary.revision;
      for (let eventIndex = 0; eventIndex < 200; eventIndex += 1) {
        journal.appendSemanticEvent(id, revision, turnId, {
          type: 'conversation.progress',
          payload: { summary: `turn ${turnIndex} event ${eventIndex}`, phase: 'testing' },
        });
      }
      revision = journal.finishTurn(id, revision, turnId).summary.revision;
    }
    const retained: AgentRuntimeConversationEvent[] = [];
    let after = 0;
    while (true) {
      const page = journal.readEvents(id, after, 100);
      retained.push(...page);
      if (page.length < 100) break;
      after = page.at(-1)!.seq;
    }
    expect(retained).toHaveLength(512);
    expect(retained[0]!.seq).toBeGreaterThan(1);
    expect(retained.at(-1)).toMatchObject({ type: 'conversation.turn.completed' });
    journal.close();
  });

  test('rebuilds a real v3 event table before accepting semantic events', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    journal.beginTurn(id, 2, 'turn_12345678', 'provider_turn_12345678');
    journal.close();
    const legacy = new Database(path, { strict: true });
    legacy.exec(`
      DROP INDEX agent_runtime_conversation_events_read_idx;
      ALTER TABLE agent_runtime_conversation_events RENAME TO agent_runtime_conversation_events_v4;
      CREATE TABLE agent_runtime_conversation_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        event_type TEXT NOT NULL CHECK (event_type IN (
          'conversation.turn.started', 'conversation.turn.completed',
          'conversation.turn.interrupted', 'conversation.turn.unknown'
        )),
        turn_id TEXT,
        created_at TEXT NOT NULL,
        CHECK (turn_id IS NOT NULL OR event_type = 'conversation.turn.unknown')
      );
      INSERT INTO agent_runtime_conversation_events(
        seq, conversation_id, revision, event_type, turn_id, created_at
      )
      SELECT seq, conversation_id, revision, event_type, turn_id, created_at
      FROM agent_runtime_conversation_events_v4;
      DROP TABLE agent_runtime_conversation_events_v4;
      CREATE INDEX agent_runtime_conversation_events_read_idx
        ON agent_runtime_conversation_events(conversation_id, seq);
      UPDATE agent_runtime_conversation_meta SET schema_version = 3 WHERE singleton = 1;
    `);
    legacy.close();

    const migrated = openAgentRuntimeConversationJournal(path);
    migrated.close();
    const verified = new Database(path, { readonly: true, strict: true });
    expect(verified.query(`
      SELECT schema_version FROM agent_runtime_conversation_meta WHERE singleton = 1
    `).get()).toEqual({ schema_version: 5 });
    const columns = verified.query('PRAGMA table_info(agent_runtime_conversation_events)')
      .all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
      'summary', 'phase', 'artifact_kind', 'artifact_label',
    ]));
    expect(verified.query(`
      SELECT event_type, turn_id FROM agent_runtime_conversation_events
      ORDER BY seq
    `).all()).toEqual([{
      event_type: 'conversation.turn.started', turn_id: 'turn_12345678',
    }]);
    verified.close();
  });

  test('persists lifecycle mutation receipts and never replays an uncertain provider boundary', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    const intent = {
      requestId: 'request_archive_12345678',
      conversationId: id,
      expectedRevision: 2,
      action: 'archive' as const,
    };

    expect(journal.prepareLifecycleMutation(intent)).toMatchObject({
      duplicate: false,
      indeterminate: false,
      conversation: { summary: { state: 'idle', revision: 2 } },
    });
    expect(journal.prepareLifecycleMutation(intent)).toMatchObject({
      duplicate: true,
      indeterminate: true,
    });
    expect(journal.markLifecycleMutationIndeterminate(intent)?.summary).toMatchObject({
      state: 'unknown',
      revision: 3,
    });
    expect(journal.findLifecycleMutation(intent)).toMatchObject({
      duplicate: true,
      indeterminate: true,
      conversation: { summary: { state: 'unknown', revision: 3 } },
    });
    expect(journal.findLifecycleMutation({
      ...intent,
      requestId: 'request_archive_retry_87654321',
    })).toMatchObject({ duplicate: true, indeterminate: true });
    journal.close();

    const database = new Database(path, { readonly: true, strict: true });
    expect(database.query(`
      SELECT action, status, outcome_revision
      FROM agent_runtime_conversation_lifecycle_requests WHERE request_id = ?
    `).get(intent.requestId)).toEqual({
      action: 'archive',
      status: 'indeterminate',
      outcome_revision: null,
    });
    database.close();
  });

  test('returns an exact completed lifecycle retry but retires it after later state changes', () => {
    const { journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    const archive = {
      requestId: 'request_archive_12345678',
      conversationId: id,
      expectedRevision: 2,
      action: 'archive' as const,
    };
    journal.prepareLifecycleMutation(archive);
    expect(journal.completeLifecycleArchiveMutation(archive).summary).toMatchObject({
      state: 'archived', revision: 3,
    });
    expect(journal.findLifecycleMutation(archive)).toMatchObject({
      duplicate: true,
      indeterminate: false,
      conversation: { summary: { state: 'archived', revision: 3 } },
    });
    expect(journal.findLifecycleMutation({
      ...archive,
      requestId: 'request_archive_retry_87654321',
    })).toMatchObject({
      duplicate: true,
      indeterminate: false,
      conversation: { summary: { state: 'archived', revision: 3 } },
    });

    const unarchive = {
      requestId: 'request_unarchive_12345678',
      conversationId: id,
      expectedRevision: 3,
      action: 'unarchive' as const,
    };
    journal.prepareLifecycleMutation(unarchive);
    journal.completeLifecycleArchiveMutation(unarchive);
    expect(() => journal.findLifecycleMutation(archive)).toThrow(
      AgentRuntimeConversationJournalError,
    );
    try {
      journal.findLifecycleMutation(archive);
    } catch (error) {
      expect((error as AgentRuntimeConversationJournalError).code)
        .toBe('AGENT_RUNTIME_CONVERSATION_REQUEST_RETIRED');
    }
    journal.close();
  });

  test('keeps lifecycle, turn, and live-control replay fences durable across restart', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    const turn = continueRequest();
    journal.prepareContinue(turn);
    journal.beginRequestedTurn(
      id,
      turn.requestId,
      2,
      'turn_12345678',
      'provider_turn_12345678',
    );
    const steer = {
      requestId: 'request_steer_restart_12345678',
      conversationId: id,
      expectedRevision: 3,
      expectedTurnId: 'turn_12345678',
      action: 'steer' as const,
      prompt: '재시작 뒤 중복 실행 금지',
    };
    journal.prepareLiveControl(steer);
    journal.completeLiveControl(steer);
    journal.finishRequestedTurn(id, turn.requestId, 4, 'turn_12345678', 'succeeded');
    const archive = {
      requestId: 'request_archive_restart_12345678',
      conversationId: id,
      expectedRevision: 5,
      action: 'archive' as const,
    };
    journal.prepareLifecycleMutation(archive);
    journal.completeLifecycleArchiveMutation(archive);
    journal.close();

    const reopened = openAgentRuntimeConversationJournal(path);
    expect(reopened.prepareContinue({
      ...turn,
      requestId: 'request_continue_restart_retry_87654321',
    })).toMatchObject({ duplicate: true, indeterminate: false });
    expect(reopened.prepareLiveControl({
      ...steer,
      requestId: 'request_steer_restart_retry_87654321',
    })).toMatchObject({ duplicate: true, indeterminate: false });
    expect(reopened.findLifecycleMutation({
      ...archive,
      requestId: 'request_archive_restart_retry_87654321',
    })).toMatchObject({
      duplicate: true,
      indeterminate: false,
      conversation: { summary: { state: 'archived', revision: 6 } },
    });
    reopened.close();
  });

  test('upgrades a v4 journal with durable semantic replay indexes and lifecycle receipts', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    journal.prepareContinue(continueRequest());
    journal.close();

    const legacy = new Database(path, { strict: true });
    legacy.exec(`
      DROP INDEX agent_runtime_conversation_live_revision_idx;
      DROP INDEX agent_runtime_conversation_turn_revision_idx;
      DROP INDEX agent_runtime_conversation_lifecycle_intent_idx;
      DROP TABLE agent_runtime_conversation_lifecycle_requests;
      INSERT INTO agent_runtime_conversation_turn_requests(
        request_id, conversation_id, expected_revision, intent_digest, status,
        public_turn_id, outcome_revision, created_at, updated_at
      )
      SELECT 'request_continue_legacy_retry_87654321', conversation_id,
             expected_revision, intent_digest, status, public_turn_id,
             outcome_revision, created_at, updated_at
      FROM agent_runtime_conversation_turn_requests
      WHERE request_id = 'request_continue_12345678';
      UPDATE agent_runtime_conversation_meta SET schema_version = 4 WHERE singleton = 1;
    `);
    legacy.close();

    const migrated = openAgentRuntimeConversationJournal(path);
    const turn = continueRequest();
    expect(migrated.prepareContinue(turn)).toMatchObject({
      duplicate: true,
      indeterminate: true,
    });
    expect(migrated.prepareContinue({
      ...turn,
      requestId: 'request_continue_v4_retry_87654321',
    })).toMatchObject({ duplicate: true });
    const lifecycle = {
      requestId: 'request_archive_v4_12345678',
      conversationId: id,
      expectedRevision: 2,
      action: 'archive' as const,
    };
    expect(migrated.prepareLifecycleMutation(lifecycle)).toMatchObject({ duplicate: false });
    migrated.close();

    const verified = new Database(path, { readonly: true, strict: true });
    expect(verified.query(`
      SELECT schema_version FROM agent_runtime_conversation_meta WHERE singleton = 1
    `).get()).toEqual({ schema_version: 5 });
    const indexes = verified.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'agent_runtime_conversation_live_revision_idx',
        'agent_runtime_conversation_turn_revision_idx',
        'agent_runtime_conversation_lifecycle_intent_idx'
      ) ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(indexes.map(row => row.name)).toEqual([
      'agent_runtime_conversation_lifecycle_intent_idx',
      'agent_runtime_conversation_live_revision_idx',
      'agent_runtime_conversation_turn_revision_idx',
    ]);
    expect(verified.query(`
      SELECT status FROM agent_runtime_conversation_lifecycle_requests
      WHERE request_id = ?
    `).get(lifecycle.requestId)).toEqual({ status: 'prepared' });
    verified.close();
  });

  test('fails closed when a legacy journal contains conflicting intents for one revision', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    const turn = continueRequest();
    journal.prepareContinue(turn);
    journal.close();

    const legacy = new Database(path, { strict: true });
    legacy.query(`
      INSERT INTO agent_runtime_conversation_turn_requests(
        request_id, conversation_id, expected_revision, intent_digest, status,
        public_turn_id, outcome_revision, created_at, updated_at
      ) VALUES (?, ?, 2, ?, 'prepared', NULL, NULL, ?, ?)
    `).run(
      'request_continue_conflicting_87654321',
      id,
      'a'.repeat(64),
      '2026-09-05T00:01:00.000Z',
      '2026-09-05T00:01:00.000Z',
    );
    legacy.close();

    const reopened = openAgentRuntimeConversationJournal(path);
    try {
      reopened.prepareContinue(turn);
      throw new Error('expected conflicting legacy receipts');
    } catch (error) {
      expect((error as AgentRuntimeConversationJournalError).code)
        .toBe('AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT');
    }
    expect(reopened.get(id)).toMatchObject({ state: 'idle', revision: 2 });
    reopened.close();
  });

  test('fails closed on malformed provider ids and tampered durable state', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    expect(() => journal.bindProviderThread(id, 1, '../provider')).toThrow();
    journal.close();

    const database = new Database(path, { strict: true });
    database.exec('PRAGMA ignore_check_constraints = ON;');
    database.query(`
      UPDATE agent_runtime_conversations
      SET state = 'running', active_turn_id = NULL, provider_turn_id = NULL
      WHERE conversation_id = ?
    `).run(id);
    database.close();

    const reopened = openAgentRuntimeConversationJournal(path);
    expect(() => reopened.get(id)).toThrow(AgentRuntimeConversationJournalError);
    reopened.close();
  });

  test('reconciles interrupted turns as unknown and requires a fresh matching provider proof', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    journal.beginTurn(id, 2, 'turn_12345678', 'provider_turn_12345678');
    journal.close();

    const reopened = openAgentRuntimeConversationJournal(path, {
      now: () => new Date('2026-09-05T00:10:00.000Z'),
    });
    expect(reopened.reconcileInterruptedTurns()).toBe(1);
    const unknown = reopened.getPrivate(id)!;
    expect(unknown.summary).toMatchObject({ state: 'unknown', activeTurnId: null, revision: 4 });
    expect(unknown.providerThreadId).toBe('provider_thread_12345678');
    expect(unknown.providerTurnId).toBeNull();
    expect(() => reopened.confirmProviderIdle(id, 4, 'provider_thread_87654321')).toThrow();
    expect(reopened.confirmProviderIdle(id, 4, 'provider_thread_12345678').summary)
      .toMatchObject({ state: 'idle', revision: 5 });
    expect(reopened.reconcileInterruptedTurns()).toBe(0);
    reopened.close();
  });

  test('marks a prepared continue boundary unknown when the supervisor restarts', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    const request = continueRequest();
    journal.prepareContinue(request);
    journal.close();

    const reopened = openAgentRuntimeConversationJournal(path, {
      now: () => new Date('2026-09-05T00:10:00.000Z'),
    });
    expect(reopened.reconcileInterruptedTurns()).toBe(1);
    expect(reopened.get(id)).toMatchObject({ state: 'unknown', revision: 3 });
    expect(reopened.readEvents(id)).toMatchObject([{
      type: 'conversation.turn.unknown', turnId: null, revision: 3,
    }]);
    expect(reopened.prepareContinue({
      ...request,
      requestId: 'request_continue_restart_retry_87654321',
    })).toMatchObject({
      duplicate: true,
      indeterminate: true,
      conversation: { summary: { state: 'unknown', revision: 3 } },
    });
    expect(reopened.reconcileInterruptedTurns()).toBe(0);
    reopened.close();
  });

  test('marks a prepared lifecycle boundary unknown when the supervisor restarts', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    const request = {
      requestId: 'request_archive_restart_12345678',
      conversationId: id,
      expectedRevision: 2,
      action: 'archive' as const,
    };
    journal.prepareLifecycleMutation(request);
    journal.close();

    const reopened = openAgentRuntimeConversationJournal(path, {
      now: () => new Date('2026-09-05T00:10:00.000Z'),
    });
    expect(reopened.reconcileInterruptedTurns()).toBe(1);
    expect(reopened.get(id)).toMatchObject({ state: 'unknown', revision: 3 });
    expect(reopened.findLifecycleMutation({
      ...request,
      requestId: 'request_archive_restart_retry_87654321',
    })).toMatchObject({
      duplicate: true,
      indeterminate: true,
      conversation: { summary: { state: 'unknown', revision: 3 } },
    });
    expect(reopened.reconcileInterruptedTurns()).toBe(0);
    reopened.close();
  });

  test('records live steer acceptance without retaining its prompt and fences replay', () => {
    const { path, journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    journal.beginTurn(id, 2, 'turn_12345678', 'provider_turn_12345678');
    const intent = {
      requestId: 'request_steer_12345678',
      conversationId: id,
      expectedRevision: 3,
      expectedTurnId: 'turn_12345678',
      action: 'steer' as const,
      prompt: '민감한 추가 지시 secret-do-not-store',
    };
    expect(journal.prepareLiveControl(intent)).toMatchObject({
      duplicate: false,
      indeterminate: false,
      conversation: { state: 'running', revision: 3 },
    });
    expect(journal.prepareLiveControl({
      ...intent,
      requestId: 'request_steer_same_intent_87654321',
    })).toMatchObject({
      duplicate: true,
      indeterminate: true,
      conversation: { state: 'running', revision: 3 },
    });
    expect(() => journal.prepareLiveControl({
      ...intent,
      requestId: 'request_steer_conflict_87654321',
      prompt: '같은 revision에 들어온 다른 지시',
    })).toThrow(AgentRuntimeConversationJournalError);
    expect(() => journal.prepareLiveControl({
      requestId: 'request_interrupt_conflict_87654321',
      conversationId: id,
      expectedRevision: 3,
      expectedTurnId: 'turn_12345678',
      action: 'interrupt',
    })).toThrow(AgentRuntimeConversationJournalError);
    expect(journal.completeLiveControl(intent)).toMatchObject({ state: 'running', revision: 4 });
    expect(journal.prepareLiveControl(intent)).toMatchObject({
      duplicate: true,
      indeterminate: false,
      conversation: { revision: 4 },
    });
    expect(journal.prepareLiveControl({
      ...intent,
      requestId: 'request_steer_completed_retry_87654321',
    })).toMatchObject({
      duplicate: true,
      indeterminate: false,
      conversation: { revision: 4 },
    });
    journal.close();

    const database = new Database(path, { readonly: true, strict: true });
    expect(JSON.stringify(database.query(`
      SELECT * FROM agent_runtime_conversation_live_requests
    `).all())).not.toContain('secret-do-not-store');
    database.close();
  });

  test('never blindly replays an indeterminate live control request', () => {
    const { journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    journal.beginTurn(id, 2, 'turn_12345678', 'provider_turn_12345678');
    const intent = {
      requestId: 'request_interrupt_12345678',
      conversationId: id,
      expectedRevision: 3,
      expectedTurnId: 'turn_12345678',
      action: 'interrupt' as const,
    };
    journal.prepareLiveControl(intent);
    expect(journal.markLiveControlIndeterminate(intent)).toMatchObject({
      state: 'unknown', activeTurnId: null, revision: 4,
    });
    expect(journal.prepareLiveControl(intent)).toMatchObject({
      duplicate: true,
      indeterminate: true,
      conversation: { state: 'unknown', revision: 4 },
    });
    expect(journal.prepareLiveControl({
      ...intent,
      requestId: 'request_interrupt_unknown_retry_87654321',
    })).toMatchObject({
      duplicate: true,
      indeterminate: true,
      conversation: { state: 'unknown', revision: 4 },
    });
    try {
      journal.completeLiveControl(intent);
      throw new Error('expected indeterminate request');
    } catch (error) {
      expect((error as AgentRuntimeConversationJournalError).code)
        .toBe('AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE');
    }
    journal.close();
  });

  test('retires deleted create intents and makes permanent deletion retry-safe', () => {
    const { journal } = fixture();
    const id = journal.create(createRequest(), 'AgentsToZ').conversation.summary.conversationId;
    journal.bindProviderThread(id, 1, 'provider_thread_12345678');
    expect(journal.finalizeDelete(id, 2, 'request_delete_12345678'))
      .toEqual({ duplicate: false });
    expect(journal.get(id)).toBeNull();
    expect(journal.list(true)).toEqual([]);
    expect(journal.isDeleteFinalized(id, 'request_delete_12345678')).toBe(true);
    expect(journal.finalizeDelete(id, 2, 'request_delete_12345678'))
      .toEqual({ duplicate: true });

    try {
      journal.create(createRequest(), 'AgentsToZ');
      throw new Error('expected retired request');
    } catch (error) {
      expect((error as AgentRuntimeConversationJournalError).code)
        .toBe('AGENT_RUNTIME_CONVERSATION_REQUEST_RETIRED');
    }
    try {
      journal.create(createRequest('다른 생성 intent'), 'AgentsToZ');
      throw new Error('expected conflict');
    } catch (error) {
      expect((error as AgentRuntimeConversationJournalError).code)
        .toBe('AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT');
    }
    journal.close();
  });
});
