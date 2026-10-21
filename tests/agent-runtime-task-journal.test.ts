import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_RUNTIME_EVENT_READ_LIMIT,
  AGENT_RUNTIME_TASK_LIST_LIMIT,
} from '../src/agentRuntimeApiContract';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from '../src/agentRuntimeProtocol';
import {
  AGENT_RUNTIME_MAX_EVENTS_PER_TASK,
  AGENT_RUNTIME_MAX_TERMINAL_TASK_KEEP,
  AgentRuntimeTaskJournalError,
  openAgentRuntimeTaskJournal,
  type AgentRuntimeTaskJournal,
  type AgentRuntimeTaskJournalErrorCode,
  type AgentTaskEventDraft,
  type CreateAgentRuntimeTaskInput,
} from '../src/agentRuntimeTaskJournal';

const roots: string[] = [];
const journals: AgentRuntimeTaskJournal[] = [];

afterEach(() => {
  for (const journal of journals.splice(0).reverse()) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-journal-'));
  roots.push(root);
  return join(root, 'agent-runtime.sqlite');
}

function open(path: string): AgentRuntimeTaskJournal {
  const journal = openAgentRuntimeTaskJournal(path);
  journals.push(journal);
  return journal;
}

function intent(suffix = '12345678'): CreateAgentRuntimeTaskInput {
  return {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    requestId: `request_${suffix}`,
    targetId: `project_${suffix}`,
    adapterId: 'codex',
    modelId: 'gpt-5.6-codex',
    executionMode: 'workspace-write',
    prompt: '테스트를 실행하고 결과를 요약해줘.',
    projectLabel: `프로젝트 ${suffix}`,
  };
}

function expectJournalCode(operation: () => unknown, code: AgentRuntimeTaskJournalErrorCode): void {
  try {
    operation();
    throw new Error('Expected the journal operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeTaskJournalError);
    expect((error as AgentRuntimeTaskJournalError).code).toBe(code);
  }
}

describe('Agent Runtime durable task journal', () => {
  test('migrates schema v1 through v2 to v3 and rewrites every event to protocol v2', () => {
    const path = fixture();
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE agent_runtime_journal_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
      INSERT INTO agent_runtime_journal_meta(singleton, schema_version) VALUES (1, 1);
      CREATE TABLE agent_runtime_tasks (
        task_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        target_id TEXT NOT NULL,
        project_label TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        last_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        provider_thread_id TEXT,
        provider_turn_id TEXT
      );
      CREATE TABLE agent_runtime_task_events (
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (task_id, seq)
      ) WITHOUT ROWID;
    `);
    const occurredAt = '2026-09-03T10:00:00.000Z';
    legacy.query(`
      INSERT INTO agent_runtime_tasks(
        task_id, request_id, target_id, project_label, adapter_id, status, prompt,
        last_seq, created_at, updated_at, started_at, finished_at,
        provider_thread_id, provider_turn_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)
    `).run(
      'task_legacy123',
      'request_legacy123',
      'project_legacy123',
      '기존 프로젝트',
      'codex',
      'succeeded',
      '기존 작업',
      2,
      occurredAt,
      occurredAt,
      occurredAt,
    );
    legacy.query(`
      INSERT INTO agent_runtime_task_events(task_id, seq, type, occurred_at, event_json)
      VALUES (?, 1, 'task.accepted', ?, ?)
    `).run('task_legacy123', occurredAt, JSON.stringify({
      protocolVersion: 'agentstoz-tasks-v1',
      taskId: 'task_legacy123',
      seq: 1,
      occurredAt,
      type: 'task.accepted',
      payload: { adapterId: 'codex', projectLabel: '기존 프로젝트' },
    }));
    legacy.query(`
      INSERT INTO agent_runtime_task_events(task_id, seq, type, occurred_at, event_json)
      VALUES (?, 2, 'task.result', ?, ?)
    `).run('task_legacy123', occurredAt, JSON.stringify({
      protocolVersion: 'agentstoz-tasks-v1',
      taskId: 'task_legacy123',
      seq: 2,
      occurredAt,
      type: 'task.result',
      payload: { summary: '기존 작업 완료' },
    }));
    legacy.close();

    const journal = open(path);
    expect(journal.getTask('task_legacy123')).toMatchObject({
      executionMode: 'workspace-write',
      modelId: null,
    });
    const events = journal.readEvents('task_legacy123', 0);
    expect(events).toHaveLength(2);
    expect(events.every(event => event.protocolVersion === AGENT_RUNTIME_PROTOCOL_VERSION)).toBe(true);
    expect(events[0]).toMatchObject({
      type: 'task.accepted',
      payload: { executionMode: 'workspace-write', modelId: null },
    });
    const migrated = new Database(path);
    expect(migrated.query(`
      SELECT schema_version FROM agent_runtime_journal_meta WHERE singleton = 1
    `).get()).toEqual({ schema_version: 3 });
    expect((migrated.query('PRAGMA table_info(agent_runtime_tasks)').all() as Array<{ name: string }>)
      .map(column => column.name)).toContain('model_id');
    migrated.close();
  });

  test('migrates schema v2 to v3 while keeping legacy model intent unknown and tombstones safe', () => {
    const path = fixture();
    const activeIntent = intent('legacyv2');
    const retiredIntent = intent('retiredv2');
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE agent_runtime_journal_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
      INSERT INTO agent_runtime_journal_meta(singleton, schema_version) VALUES (1, 2);
      CREATE TABLE agent_runtime_tasks (
        task_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        target_id TEXT NOT NULL,
        project_label TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        last_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        provider_thread_id TEXT,
        provider_turn_id TEXT
      );
      CREATE TABLE agent_runtime_task_events (
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (task_id, seq)
      ) WITHOUT ROWID;
      CREATE TABLE agent_runtime_start_request_tombstones (
        request_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        intent_fingerprint TEXT NOT NULL,
        retired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    const occurredAt = '2026-09-03T10:00:00.000Z';
    legacy.query(`
      INSERT INTO agent_runtime_tasks(
        task_id, request_id, target_id, project_label, adapter_id, execution_mode,
        status, prompt, last_seq, created_at, updated_at, started_at, finished_at,
        provider_thread_id, provider_turn_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 2, ?, ?, ?, NULL, NULL, NULL)
    `).run(
      'task_legacyv2',
      activeIntent.requestId,
      activeIntent.targetId,
      activeIntent.projectLabel,
      activeIntent.adapterId,
      activeIntent.executionMode,
      activeIntent.prompt,
      occurredAt,
      occurredAt,
      occurredAt,
    );
    for (const [seq, type, payload] of [
      [1, 'task.accepted', {
        adapterId: 'codex',
        projectLabel: activeIntent.projectLabel,
        executionMode: activeIntent.executionMode,
      }],
      [2, 'task.started', { adapterId: 'codex' }],
    ] as const) {
      legacy.query(`
        INSERT INTO agent_runtime_task_events(task_id, seq, type, occurred_at, event_json)
        VALUES (?, ?, ?, ?, ?)
      `).run('task_legacyv2', seq, type, occurredAt, JSON.stringify({
        protocolVersion: 'agentstoz-tasks-v1',
        taskId: 'task_legacyv2',
        seq,
        occurredAt,
        type,
        payload,
      }));
    }
    const legacyFingerprint = createHash('sha256').update(JSON.stringify([
      retiredIntent.requestId,
      retiredIntent.targetId,
      retiredIntent.adapterId,
      retiredIntent.executionMode,
      retiredIntent.prompt,
    ]), 'utf8').digest('hex');
    legacy.query(`
      INSERT INTO agent_runtime_start_request_tombstones(
        request_id, task_id, intent_fingerprint, retired_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      retiredIntent.requestId,
      'task_retiredv2',
      legacyFingerprint,
      occurredAt,
      '2099-09-03T10:00:00.000Z',
    );
    legacy.close();

    const journal = open(path);
    expect(journal.getTask('task_legacyv2')).toMatchObject({
      modelId: null,
      executionMode: 'workspace-write',
    });
    const events = journal.readEvents('task_legacyv2', 0);
    expect(events.every(event => event.protocolVersion === AGENT_RUNTIME_PROTOCOL_VERSION)).toBe(true);
    expect(events[0]).toMatchObject({ payload: { modelId: null } });
    expectJournalCode(
      () => journal.createOrGetTask(activeIntent),
      'AGENT_RUNTIME_REQUEST_CONFLICT',
    );
    expectJournalCode(
      () => journal.createOrGetTask(retiredIntent),
      'AGENT_RUNTIME_REQUEST_CONFLICT',
    );
    const migrated = new Database(path);
    expect(migrated.query(`
      SELECT schema_version FROM agent_runtime_journal_meta WHERE singleton = 1
    `).get()).toEqual({ schema_version: 3 });
    migrated.close();
  });

  test('atomically creates the intent and accepted event, then returns requestId retries', () => {
    const journal = open(fixture());
    const input = intent();

    const created = journal.createOrGetTask(input);
    const duplicate = journal.createOrGetTask({ ...input, projectLabel: '이름이 바뀐 프로젝트' });

    expect(created.duplicate).toBe(false);
    expect(duplicate).toEqual({ duplicate: true, task: created.task });
    expect(journal.getTaskByRequestId(input.requestId)).toEqual(created.task);
    expect(journal.listTasks()).toEqual([created.task]);
    expect(Object.keys(created.task).sort()).toEqual([
      'adapterId', 'createdAt', 'lastSeq', 'modelId', 'projectLabel',
      'executionMode', 'status', 'targetId', 'taskId', 'updatedAt',
    ].sort());
    expect('prompt' in created.task).toBe(false);
    expect('requestId' in created.task).toBe(false);

    const events = journal.readEvents(created.task.taskId, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: created.task.taskId,
      seq: 1,
      type: 'task.accepted',
      payload: {
        adapterId: 'codex',
        projectLabel: input.projectLabel,
        executionMode: 'workspace-write',
        modelId: 'gpt-5.6-codex',
      },
    });

    expectJournalCode(
      () => journal.createOrGetTask({ ...input, prompt: '같은 키의 다른 요청' }),
      'AGENT_RUNTIME_REQUEST_CONFLICT',
    );
    expectJournalCode(
      () => journal.createOrGetTask({ ...input, modelId: 'gpt-5.5-codex' }),
      'AGENT_RUNTIME_REQUEST_CONFLICT',
    );
    expectJournalCode(
      () => journal.createOrGetTask({
        ...input,
        executionMode: 'dangerously-bypass-approvals-and-sandbox',
      }),
      'AGENT_RUNTIME_REQUEST_CONFLICT',
    );
    expect(journal.listTasks()).toHaveLength(1);
    expect(journal.readEvents(created.task.taskId, 0)).toHaveLength(1);
  });

  test('assigns one monotonic task sequence across connections and supports cursor reads', () => {
    const path = fixture();
    const first = open(path);
    const task = first.createOrGetTask(intent()).task;
    const second = open(path);

    expect(first.appendEvent(task.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    }).seq).toBe(2);
    expect(second.appendEvent(task.taskId, {
      type: 'task.progress',
      payload: { summary: '검증 중입니다.', phase: 'verify' },
    }).seq).toBe(3);
    expect(first.appendEvent(task.taskId, {
      type: 'task.question',
      payload: {
        questionId: 'question_12345678',
        prompt: '계속 진행할까요?',
        choices: ['진행', '중단'],
      },
    }).seq).toBe(4);

    expect(first.readEvents(task.taskId, 0, 2).map(event => event.seq)).toEqual([1, 2]);
    expect(first.readEvents(task.taskId, 2, 2).map(event => event.seq)).toEqual([3, 4]);
    expect(first.readEvents(task.taskId, 4, 2)).toEqual([]);
    expect(first.getTask(task.taskId)).toMatchObject({ status: 'waiting', lastSeq: 4 });

    expectJournalCode(
      () => first.listTasks(AGENT_RUNTIME_TASK_LIST_LIMIT + 1),
      'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT',
    );
    expectJournalCode(
      () => first.readEvents(task.taskId, 0, AGENT_RUNTIME_EVENT_READ_LIMIT + 1),
      'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT',
    );
    expectJournalCode(
      () => first.readEvents(task.taskId, -1),
      'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT',
    );
  });

  test('detects a missing trailing event instead of returning a false current cursor', () => {
    const path = fixture();
    const journal = open(path);
    const task = journal.createOrGetTask(intent('gaptrail')).task;
    journal.appendEvent(task.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    journal.appendEvent(task.taskId, {
      type: 'task.progress',
      payload: { summary: '마지막 이벤트', phase: 'verify' },
    });
    const tamper = new Database(path);
    tamper.query('DELETE FROM agent_runtime_task_events WHERE task_id = ? AND seq = 3')
      .run(task.taskId);
    tamper.close();

    expectJournalCode(
      () => journal.readEvents(task.taskId, 2),
      'AGENT_RUNTIME_JOURNAL_CORRUPT',
    );
  });

  test('reconciles accepted, running, and waiting tasks without cancellation intent as failed exactly once', () => {
    const path = fixture();
    const beforeRestart = open(path);
    const accepted = beforeRestart.createOrGetTask(intent('accepted1')).task;
    const running = beforeRestart.createOrGetTask(intent('running01')).task;
    const waiting = beforeRestart.createOrGetTask(intent('waiting01')).task;
    beforeRestart.appendEvent(running.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    beforeRestart.appendEvent(waiting.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    beforeRestart.appendEvent(waiting.taskId, {
      type: 'task.approval.requested',
      payload: {
        approvalId: 'approval_12345678',
        title: '변경을 적용합니다.',
        risk: 'medium',
        expiresAt: '2026-09-03T12:00:00.000Z',
      },
    });
    beforeRestart.close();

    const afterRestart = open(path);
    // Opening the store does not hide a supervisor startup bug with implicit mutation.
    expect(afterRestart.getTask(accepted.taskId)?.status).toBe('accepted');
    expect(afterRestart.getTask(running.taskId)?.status).toBe('running');
    expect(afterRestart.getTask(waiting.taskId)?.status).toBe('waiting');

    expect(afterRestart.reconcileInterruptedTasks()).toBe(3);
    expect(afterRestart.getTask(accepted.taskId)).toMatchObject({ status: 'failed', lastSeq: 2 });
    expect(afterRestart.getTask(running.taskId)).toMatchObject({ status: 'failed', lastSeq: 3 });
    expect(afterRestart.getTask(waiting.taskId)).toMatchObject({ status: 'failed', lastSeq: 4 });
    for (const taskId of [accepted.taskId, running.taskId, waiting.taskId]) {
      expect(afterRestart.readEvents(taskId, 0).at(-1)).toMatchObject({
        type: 'task.failed',
        payload: { code: 'RUNTIME_RESTARTED', retryable: true },
      });
    }
    expect(afterRestart.reconcileInterruptedTasks()).toBe(0);
  });

  test('reconciles accepted, running, and waiting tasks with durable cancellation intent as cancelled exactly once', () => {
    const path = fixture();
    const beforeRestart = open(path);
    const accepted = beforeRestart.createOrGetTask(intent('cancelaccepted')).task;
    const running = beforeRestart.createOrGetTask(intent('cancelrunning1')).task;
    const waiting = beforeRestart.createOrGetTask(intent('cancelwaiting1')).task;
    beforeRestart.appendEvent(running.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    beforeRestart.appendEvent(waiting.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    beforeRestart.appendEvent(waiting.taskId, {
      type: 'task.approval.requested',
      payload: {
        approvalId: 'approval_cancel_recovery_01',
        title: '변경을 적용합니다.',
        risk: 'medium',
        expiresAt: '2026-09-03T12:00:00.000Z',
      },
    });
    const interrupted = [
      { task: accepted, lastSeq: 2, cancelRequestId: 'cancel_recovery_accepted_01' },
      { task: running, lastSeq: 3, cancelRequestId: 'cancel_recovery_running_01' },
      { task: waiting, lastSeq: 4, cancelRequestId: 'cancel_recovery_waiting_01' },
    ];
    for (const entry of interrupted) {
      expect(beforeRestart.recordCancellationIntent(entry.task.taskId, entry.cancelRequestId))
        .toEqual({ duplicate: false });
    }
    beforeRestart.close();

    const afterRestart = open(path);
    expect(afterRestart.reconcileInterruptedTasks()).toBe(3);
    for (const entry of interrupted) {
      expect(afterRestart.getTask(entry.task.taskId)).toMatchObject({
        status: 'cancelled',
        lastSeq: entry.lastSeq,
      });
      const events = afterRestart.readEvents(entry.task.taskId, 0);
      expect(events.filter(event => ['task.result', 'task.failed', 'task.cancelled'].includes(event.type)))
        .toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        seq: entry.lastSeq,
        type: 'task.cancelled',
        payload: { reason: expect.stringContaining('취소 의도') },
      });
    }

    expect(afterRestart.reconcileInterruptedTasks()).toBe(0);
    for (const entry of interrupted) {
      expect(afterRestart.getTask(entry.task.taskId)?.lastSeq).toBe(entry.lastSeq);
      expect(afterRestart.readEvents(entry.task.taskId, 0)).toHaveLength(entry.lastSeq);
    }
  });

  test('never changes terminal tasks during recovery even when cancellation intents exist', () => {
    const journal = open(fixture());
    const succeeded = journal.createOrGetTask(intent('terminalsuccess')).task;
    journal.appendEvent(succeeded.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    journal.appendEvent(succeeded.taskId, {
      type: 'task.result',
      payload: { summary: '성공한 작업' },
    });
    const failed = journal.createOrGetTask(intent('terminalfailed1')).task;
    journal.appendEvent(failed.taskId, {
      type: 'task.failed',
      payload: { code: 'TEST_FAILURE', message: '실패한 작업', retryable: false },
    });
    const cancelled = journal.createOrGetTask(intent('terminalcancel')).task;
    journal.appendEvent(cancelled.taskId, {
      type: 'task.cancelled',
      payload: { reason: '이미 취소된 작업' },
    });
    const terminalTasks = [succeeded, failed, cancelled];
    terminalTasks.forEach((task, index) => {
      journal.recordCancellationIntent(task.taskId, `cancel_terminal_retry_0${index + 1}`);
    });
    const beforeRecovery = terminalTasks.map(task => ({
      task: journal.getTask(task.taskId),
      events: journal.readEvents(task.taskId, 0),
    }));

    expect(journal.reconcileInterruptedTasks()).toBe(0);
    terminalTasks.forEach((task, index) => {
      expect(journal.getTask(task.taskId)).toEqual(beforeRecovery[index]!.task);
      expect(journal.readEvents(task.taskId, 0)).toEqual(beforeRecovery[index]!.events);
    });
  });

  test('reconciles an unknown persisted state instead of leaving a permanent sink', () => {
    const path = fixture();
    const beforeRestart = open(path);
    const task = beforeRestart.createOrGetTask(intent('unknown1')).task;
    const tamper = new Database(path);
    tamper.query("UPDATE agent_runtime_tasks SET status = 'unknown' WHERE task_id = ?")
      .run(task.taskId);
    tamper.close();

    expect(beforeRestart.reconcileInterruptedTasks()).toBe(1);
    expect(beforeRestart.getTask(task.taskId)).toMatchObject({ status: 'failed', lastSeq: 2 });
    expect(beforeRestart.readEvents(task.taskId, 1)).toEqual([
      expect.objectContaining({
        type: 'task.failed',
        payload: expect.objectContaining({ code: 'RUNTIME_RESTARTED' }),
      }),
    ]);
  });

  test('rejects forbidden or non-union event data without advancing the cursor', () => {
    const journal = open(fixture());
    const task = journal.createOrGetTask(intent()).task;

    expect(() => journal.appendEvent(task.taskId, {
      type: 'task.progress',
      payload: { summary: '숨겨진 출력', phase: null, stdout: 'raw output' },
    } as unknown as AgentTaskEventDraft)).toThrow();
    expect(() => journal.appendEvent(task.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
      cwd: '/private/project',
    } as unknown as AgentTaskEventDraft)).toThrow();
    expect(() => journal.createOrGetTask({
      ...intent('unsafe001'),
      command: 'codex exec --dangerously-bypass-approvals-and-sandbox',
    } as unknown as CreateAgentRuntimeTaskInput)).toThrow();

    expect(journal.getTask(task.taskId)).toMatchObject({ status: 'accepted', lastSeq: 1 });
    expect(journal.readEvents(task.taskId, 0)).toHaveLength(1);
  });

  test('persists execution-only prompt/provider IDs and semantic events across reopen', () => {
    const path = fixture();
    const first = open(path);
    const task = first.createOrGetTask(intent()).task;
    first.setProviderIds(task.taskId, {
      threadId: 'provider_thread_12345678',
      turnId: 'provider_turn_12345678',
    });
    first.appendEvent(task.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    first.appendEvent(task.taskId, {
      type: 'task.result',
      payload: { summary: '모든 검증을 통과했습니다.' },
    });
    first.close();

    const reopened = open(path);
    expect(reopened.getTask(task.taskId)).toMatchObject({ status: 'succeeded', lastSeq: 3 });
    expect(reopened.getTask(task.taskId)).not.toHaveProperty('prompt');
    expect(reopened.getTask(task.taskId)).not.toHaveProperty('threadId');
    expect(reopened.getTaskExecution(task.taskId)).toMatchObject({
      prompt: intent().prompt,
      modelId: intent().modelId,
      threadId: 'provider_thread_12345678',
      turnId: 'provider_turn_12345678',
      status: 'succeeded',
    });
    expect(reopened.readEvents(task.taskId, 0).map(event => event.type)).toEqual([
      'task.accepted', 'task.started', 'task.result',
    ]);
  });

  test('bounds noisy non-terminal events while reserving a durable terminal slot', () => {
    const journal = open(fixture());
    const task = journal.createOrGetTask(intent('bounded1')).task;
    journal.appendEvent(task.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });

    for (let seq = 3; seq < AGENT_RUNTIME_MAX_EVENTS_PER_TASK; seq += 1) {
      journal.appendEvent(task.taskId, {
        type: 'task.progress',
        payload: { summary: `진행 단계 ${seq}`, phase: 'execute' },
      });
    }

    expectJournalCode(
      () => journal.appendEvent(task.taskId, {
        type: 'task.progress',
        payload: { summary: '한도를 넘는 진행 이벤트', phase: 'execute' },
      }),
      'AGENT_RUNTIME_EVENT_LIMIT',
    );
    expect(journal.getTask(task.taskId)).toMatchObject({
      status: 'running',
      lastSeq: AGENT_RUNTIME_MAX_EVENTS_PER_TASK - 1,
    });

    const terminal = journal.appendEvent(task.taskId, {
      type: 'task.failed',
      payload: {
        code: 'EVENT_LIMIT_REACHED',
        message: '진행 이벤트 한도에 도달해 실행을 안전하게 종료했습니다.',
        retryable: true,
      },
    });
    expect(terminal.seq).toBe(AGENT_RUNTIME_MAX_EVENTS_PER_TASK);
    expect(journal.getTask(task.taskId)).toMatchObject({
      status: 'failed',
      lastSeq: AGENT_RUNTIME_MAX_EVENTS_PER_TASK,
    });
  });

  test('never deletes an active task and cascades a terminal task intentionally', () => {
    const journal = open(fixture());
    const task = journal.createOrGetTask(intent()).task;

    expectJournalCode(
      () => journal.deleteTask(task.taskId),
      'AGENT_RUNTIME_ACTIVE_TASK_DELETE_FORBIDDEN',
    );
    journal.appendEvent(task.taskId, {
      type: 'task.cancelled',
      payload: { reason: '사용자가 실행 전에 취소했습니다.' },
    });
    expect(journal.deleteTask(task.taskId)).toBe(true);
    expect(journal.getTask(task.taskId)).toBeNull();
    expect(journal.getTaskByRequestId(intent().requestId)).toBeNull();
    expectJournalCode(
      () => journal.createOrGetTask(intent()),
      'AGENT_RUNTIME_REQUEST_RETIRED',
    );
  });

  test('durably binds cancel request ids to exactly one task', () => {
    const journal = open(fixture());
    const first = journal.createOrGetTask(intent('cancel01')).task;
    const second = journal.createOrGetTask(intent('cancel02')).task;

    expect(journal.recordCancellationIntent(first.taskId, 'cancel_request_12345678'))
      .toEqual({ duplicate: false });
    expect(journal.recordCancellationIntent(first.taskId, 'cancel_request_12345678'))
      .toEqual({ duplicate: true });
    expectJournalCode(
      () => journal.recordCancellationIntent(second.taskId, 'cancel_request_12345678'),
      'AGENT_RUNTIME_CANCEL_REQUEST_CONFLICT',
    );
  });

  test('prunes only the oldest terminal tasks within a bounded retention limit', () => {
    const journal = open(fixture());
    const accepted = journal.createOrGetTask(intent('active001')).task;
    const running = journal.createOrGetTask(intent('active002')).task;
    const waiting = journal.createOrGetTask(intent('active003')).task;
    journal.appendEvent(running.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    journal.appendEvent(waiting.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    journal.appendEvent(waiting.taskId, {
      type: 'task.question',
      payload: {
        questionId: 'question_prune01',
        prompt: '사용자 응답을 기다립니다.',
        choices: [],
      },
    });

    const terminalIntents = ['done0001', 'done0002', 'done0003'].map(suffix => intent(suffix));
    for (const terminalIntent of terminalIntents) {
      const terminal = journal.createOrGetTask(terminalIntent).task;
      journal.appendEvent(terminal.taskId, {
        type: 'task.cancelled',
        payload: { reason: `종료 작업 ${terminalIntent.requestId}` },
      });
    }

    expect(journal.pruneTerminalTasks(1)).toBe(2);
    const remaining = journal.listTasks(10);
    expect(remaining.filter(task => task.status === 'cancelled')).toHaveLength(1);
    expect(remaining.filter(task => ['accepted', 'running', 'waiting'].includes(task.status)))
      .toHaveLength(3);
    expect(journal.getTask(accepted.taskId)?.status).toBe('accepted');
    expect(journal.getTask(running.taskId)?.status).toBe('running');
    expect(journal.getTask(waiting.taskId)?.status).toBe('waiting');
    const retiredIntent = terminalIntents.find(candidate => (
      journal.getTaskByRequestId(candidate.requestId) === null
    ));
    expect(retiredIntent).toBeDefined();
    expectJournalCode(
      () => journal.createOrGetTask(retiredIntent!),
      'AGENT_RUNTIME_REQUEST_RETIRED',
    );
    expectJournalCode(
      () => journal.createOrGetTask({
        ...retiredIntent!,
        prompt: '같은 정리된 요청 ID의 다른 의도',
      }),
      'AGENT_RUNTIME_REQUEST_CONFLICT',
    );
    expectJournalCode(
      () => journal.createOrGetTask({
        ...retiredIntent!,
        modelId: 'gpt-5.5-codex',
      }),
      'AGENT_RUNTIME_REQUEST_CONFLICT',
    );
    expect(journal.pruneTerminalTasks(1)).toBe(0);

    expectJournalCode(
      () => journal.pruneTerminalTasks(-1),
      'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT',
    );
    expectJournalCode(
      () => journal.pruneTerminalTasks(AGENT_RUNTIME_MAX_TERMINAL_TASK_KEEP + 1),
      'AGENT_RUNTIME_JOURNAL_INVALID_ARGUMENT',
    );
  });
});
