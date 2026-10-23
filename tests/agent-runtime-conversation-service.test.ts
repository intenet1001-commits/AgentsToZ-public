import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openAgentRuntimeConversationJournal } from '../src/agentRuntimeConversationJournal';
import {
  AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
} from '../src/agentRuntimeConversationProtocol';
import {
  AgentRuntimeConversationService,
  AgentRuntimeConversationServiceError,
  type AgentRuntimeConversationServiceDependencies,
} from '../src/agentRuntimeConversationService';
import {
  CODEX_RUNTIME_MACOS_IDENTIFIER,
  CODEX_RUNTIME_MACOS_TEAM_ID,
  codexRuntimeExecutableRevision,
  type CodexRuntimeExecutableIdentity,
} from '../src/codexRuntimeExecutable';
import { CodexAgentRuntimeError } from '../src/codexAgentRuntime';
import { AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION } from '../src/agentRuntimeConversationQuestionProtocol';

const roots: string[] = [];
const PROVIDER_THREAD_ID = '0199a213-81c0-7800-8aa1-bbab2a035a61';
const PROVIDER_TURN_ID = '0199a213-81c0-7800-8aa1-bbab2a035a62';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executableIdentity(): CodexRuntimeExecutableIdentity {
  const input: Omit<CodexRuntimeExecutableIdentity, 'revision'> = {
    path: '/Applications/Codex.app/Contents/Resources/codex',
    source: 'standalone-native',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    stat: {
      dev: '1', ino: '2', size: '3', mode: 0o100755, mtimeNs: '4', ctimeNs: '5',
    },
    signing: process.platform === 'darwin' ? {
      platform: 'darwin',
      teamId: CODEX_RUNTIME_MACOS_TEAM_ID,
      identifier: CODEX_RUNTIME_MACOS_IDENTIFIER,
    } : null,
  };
  return { ...input, revision: codexRuntimeExecutableRevision(input) };
}

function createRequest() {
  return {
    protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
    requestId: 'request_12345678',
    targetId: 'target_12345678',
    adapterId: 'codex',
    modelId: 'gpt-5.6-sol',
    historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
    initialPrompt: '현재 변경을 검토해줘.',
  } as const;
}

function harness(overrides: Partial<AgentRuntimeConversationServiceDependencies> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-conversation-service-'));
  roots.push(root);
  const journal = openAgentRuntimeConversationJournal(join(root, 'conversations.sqlite'), {
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    createConversationId: () => 'conversation_12345678',
  });
  let releases = 0;
  const dependencies: AgentRuntimeConversationServiceDependencies = {
    journal,
    managedExecutionEnabled: true,
    resolveTarget: async targetId => ({
      targetId, projectLabel: 'AgentsToZ', cwd: '/tmp/agentstoz-project',
    }),
    resolveRuntime: async () => ({
      executable: '/Applications/Codex.app/Contents/Resources/codex',
      executableIdentity: executableIdentity(),
      models: [{
        modelId: 'gpt-5.6-sol',
        providerModel: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        label: 'GPT-5.6 Sol',
        isDefault: true,
      }],
    }),
    acquireWorkspaceLease: async () => ({
      revalidate: async () => true,
      release: async () => { releases += 1; return true; },
    }),
    runCodexConversation: async input => {
      await input.bindProviderIds({ threadId: input.providerThreadId ?? PROVIDER_THREAD_ID });
      await input.bindProviderIds({
        threadId: input.providerThreadId ?? PROVIDER_THREAD_ID,
        turnId: PROVIDER_TURN_ID,
      });
      return {
        threadId: input.providerThreadId ?? PROVIDER_THREAD_ID,
        turnId: PROVIDER_TURN_ID,
        finalSummary: '검토를 완료했습니다.',
        resumed: input.providerThreadId !== null,
      };
    },
    inspectCodexConversation: async () => ({ status: 'idle' }),
    mutateCodexConversation: async input => ({ action: input.action }),
    createTurnId: () => 'turn_12345678',
    ...overrides,
  };
  return {
    journal,
    service: new AgentRuntimeConversationService(dependencies),
    releases: () => releases,
  };
}

describe('persistent agent conversation service', () => {
  test('schedules project-only collection after a turn releases its lease, not on duplicate requests', async () => {
    const captured: string[] = [];
    const app = harness({ onTurnSettled: root => {
      expect(app.releases()).toBe(1);
      captured.push(root);
    } });
    await app.service.create(createRequest());
    await app.service.create(createRequest());
    expect(captured).toEqual(['/tmp/agentstoz-project']);
    app.journal.close();
  });

  test('optional capture scheduling failure cannot turn a successful conversation into a retry', async () => {
    const app = harness({ onTurnSettled: () => { throw new Error('capture unavailable'); } });
    const result = await app.service.create(createRequest());
    expect(result.conversation.state).toBe('idle');
    expect(result.finalSummary).toBe('검토를 완료했습니다.');
    app.journal.close();
  });

  test('does not schedule collection when conversation execution is disabled', async () => {
    let captures = 0;
    const app = harness({ executionEnabled: false, onTurnSettled: () => { captures += 1; } });
    await expect(app.service.create(createRequest())).rejects.toThrow();
    expect(captures).toBe(0);
    app.journal.close();
  });

  test('bridges one active Codex question with public ids and never journals the answer text', async () => {
    let providerResponse: unknown = null;
    let nextQuestionId = 0;
    const { service, journal } = harness({
      createQuestionId: () => `public_${String(++nextQuestionId).padStart(8, '0')}`,
      questionTimeoutMs: 5_000,
      runCodexConversation: async input => {
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        providerResponse = await input.requestUserInput!({
          questions: [{
            id: 'provider_private_question',
            header: '구현 방식',
            question: '어떤 방식으로 진행할까요?',
            options: [
              { label: '안전 우선', description: '검증을 먼저 수행합니다.' },
              { label: '빠른 진행', description: '작은 단위로 바로 적용합니다.' },
            ],
            allowOther: false,
          }],
        });
        return {
          threadId: PROVIDER_THREAD_ID,
          turnId: PROVIDER_TURN_ID,
          finalSummary: '답변을 반영했습니다.',
          resumed: false,
        };
      },
    });

    const running = service.create(createRequest());
    let status: ReturnType<typeof service.questionStatus> | null = null;
    for (let attempt = 0; attempt < 20 && !status?.question; attempt += 1) {
      await Bun.sleep(1);
      if (service.list(true).some(item => item.conversationId === 'conversation_12345678')) {
        status = service.questionStatus('conversation_12345678');
      }
    }
    expect(status?.question).not.toBeNull();
    const question = status!.question!;
    expect(JSON.stringify(question)).not.toContain('provider_private_question');
    const optionId = question.questions[0]!.options![0]!.optionId;
    expect(service.answerQuestion({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      requestId: 'answer_request_12345678',
      conversationId: question.conversationId,
      questionRequestId: question.questionRequestId,
      expectedRevision: question.revision,
      expectedTurnId: question.turnId,
      answers: [{ questionId: question.questions[0]!.questionId, optionId, text: null }],
    })).toMatchObject({ accepted: true, duplicate: false });
    await expect(running).resolves.toMatchObject({ finalSummary: '답변을 반영했습니다.' });
    expect(providerResponse).toEqual({
      answers: { provider_private_question: { answers: ['안전 우선'] } },
    });
    expect(service.questionStatus('conversation_12345678').question).toBeNull();
    const serializedEvents = JSON.stringify(service.readEvents({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: 'conversation_12345678',
      after: 0,
    }));
    expect(serializedEvents).not.toContain('안전 우선');
    expect(serializedEvents).not.toContain('provider_private_question');
    journal.close();
  });

  test('rejects an unavailable adapter before resolving a target or mutating the journal', async () => {
    let targetResolutions = 0;
    let runtimeResolutions = 0;
    let providerRuns = 0;
    const { service, journal } = harness({
      resolveTarget: async () => {
        targetResolutions += 1;
        throw new Error('must not resolve');
      },
      resolveRuntime: async () => {
        runtimeResolutions += 1;
        throw new Error('must not resolve');
      },
      runCodexConversation: async () => {
        providerRuns += 1;
        throw new Error('must not run');
      },
    });

    await expect(service.create({
      ...createRequest(),
      adapterId: 'claude',
    })).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_ADAPTER_UNAVAILABLE',
    } satisfies Partial<AgentRuntimeConversationServiceError>);
    expect(service.list(true)).toEqual([]);
    expect(targetResolutions).toBe(0);
    expect(runtimeResolutions).toBe(0);
    expect(providerRuns).toBe(0);
    journal.close();
  });

  test('never routes a retained non-Codex conversation through Codex provider operations', async () => {
    let targetResolutions = 0;
    let providerOperations = 0;
    const { service, journal } = harness({
      resolveTarget: async () => {
        targetResolutions += 1;
        throw new Error('must not resolve');
      },
      runCodexConversation: async () => {
        providerOperations += 1;
        throw new Error('must not run');
      },
      inspectCodexConversation: async () => {
        providerOperations += 1;
        throw new Error('must not inspect');
      },
      mutateCodexConversation: async input => {
        providerOperations += 1;
        return { action: input.action };
      },
      readCodexConversationHistory: async () => {
        providerOperations += 1;
        throw new Error('must not read');
      },
    });
    const created = journal.create({ ...createRequest(), adapterId: 'claude' }, 'AgentsToZ');
    const bound = journal.bindProviderThread(
      created.conversation.summary.conversationId,
      created.conversation.summary.revision,
      PROVIDER_THREAD_ID,
    );
    const idle = bound;
    const common = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: idle.summary.conversationId,
      expectedRevision: idle.summary.revision,
    } as const;
    const attempts = [
      () => service.continue({ ...common, requestId: 'request_continue_12345678', prompt: '계속해줘.' }),
      () => service.history(common),
      () => service.setArchived({ ...common, requestId: 'request_archive_12345678' }, true),
      () => service.delete({
        ...common,
        requestId: 'request_delete_12345678',
        confirmPermanentDeletion: true,
      }),
      () => service.steer({
        ...common,
        requestId: 'request_steer_12345678',
        expectedTurnId: 'turn_non_codex_12345678',
        prompt: '추가 지시',
      }),
      () => service.interrupt({
        ...common,
        requestId: 'request_interrupt_12345678',
        expectedTurnId: 'turn_non_codex_12345678',
      }),
    ];

    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({
        code: 'AGENT_RUNTIME_CONVERSATION_ADAPTER_UNAVAILABLE',
      } satisfies Partial<AgentRuntimeConversationServiceError>);
    }
    expect(journal.get(idle.summary.conversationId)).toEqual(idle.summary);
    expect(targetResolutions).toBe(0);
    expect(providerOperations).toBe(0);
    journal.close();
  });

  test('creates then continues one retained provider thread through public opaque ids', async () => {
    const { service, journal, releases } = harness();
    const created = await service.create(createRequest());
    expect(created).toMatchObject({
      duplicate: false,
      finalSummary: '검토를 완료했습니다.',
      conversation: {
        conversationId: 'conversation_12345678',
        state: 'idle',
        activeTurnId: null,
        revision: 4,
      },
    });
    expect(JSON.stringify(created)).not.toContain(PROVIDER_THREAD_ID);
    expect(JSON.stringify(created)).not.toContain('/tmp/agentstoz-project');

    const continued = await service.continue({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_87654321',
      conversationId: created.conversation.conversationId,
      expectedRevision: created.conversation.revision,
      prompt: '이어서 회귀 테스트를 실행해줘.',
    });
    expect(continued).toMatchObject({
      duplicate: false,
      conversation: { state: 'idle', revision: 6 },
    });
    expect(releases()).toBe(2);
    journal.close();
  });

  test('durably maps provider semantic drafts without retaining raw notifications', async () => {
    const { service, journal } = harness({
      runCodexConversation: async input => {
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        await input.emit({
          type: 'task.progress',
          payload: { summary: '작업 계획을 갱신했습니다. (1/2)', phase: 'planning' },
        });
        await input.emit({
          type: 'task.artifact.summary',
          payload: { kind: 'test', label: '검증', summary: '타입 검사를 통과했습니다.' },
        });
        return {
          threadId: PROVIDER_THREAD_ID,
          turnId: PROVIDER_TURN_ID,
          finalSummary: '완료',
          resumed: false,
        };
      },
    });
    await service.create(createRequest());
    expect(service.readEvents({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: 'conversation_12345678',
      after: 0,
    }).events).toMatchObject([
      { type: 'conversation.turn.started' },
      { type: 'conversation.progress', payload: { phase: 'planning' } },
      { type: 'conversation.artifact.summary', payload: { kind: 'test' } },
      { type: 'conversation.turn.completed' },
    ]);
    journal.close();
  });

  test('does not replay the initial prompt after a completed idempotent create retry', async () => {
    let runs = 0;
    let targetResolutions = 0;
    const { service, journal } = harness({
      resolveTarget: async targetId => {
        targetResolutions += 1;
        if (targetResolutions > 1) throw new Error('duplicate must not depend on the target');
        return { targetId, projectLabel: 'AgentsToZ', cwd: '/tmp/agentstoz-project' };
      },
      runCodexConversation: async input => {
        runs += 1;
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        return {
          threadId: PROVIDER_THREAD_ID,
          turnId: PROVIDER_TURN_ID,
          finalSummary: '완료',
          resumed: false,
        };
      },
    });
    const first = await service.create(createRequest());
    const retry = await service.create(createRequest());
    expect(runs).toBe(1);
    expect(targetResolutions).toBe(1);
    expect(retry).toEqual({
      duplicate: true,
      conversation: first.conversation,
      finalSummary: null,
    });
    journal.close();
  });

  test('never replays a duplicate create whose provider binding is indeterminate', async () => {
    let runs = 0;
    const { service, journal } = harness({
      runCodexConversation: async input => {
        runs += 1;
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        return {
          threadId: PROVIDER_THREAD_ID,
          turnId: PROVIDER_TURN_ID,
          finalSummary: '완료',
          resumed: false,
        };
      },
    });
    journal.create(createRequest(), 'AgentsToZ');
    expect(await service.create(createRequest())).toMatchObject({
      duplicate: true,
      finalSummary: null,
      conversation: { state: 'unknown', revision: 1 },
    });
    expect(runs).toBe(0);
    journal.close();
  });

  test('returns an async create only after durable running state and live control are ready', async () => {
    let resolveTurn!: () => void;
    const turnTerminal = new Promise<void>(resolve => { resolveTurn = resolve; });
    let runnerCompleted = false;
    const { service, journal } = harness({
      runCodexConversation: async input => {
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        input.registerLiveControl?.({
          steer: async () => {},
          interrupt: async () => {},
        });
        await turnTerminal;
        runnerCompleted = true;
        return {
          threadId: PROVIDER_THREAD_ID,
          turnId: PROVIDER_TURN_ID,
          finalSummary: '완료',
          resumed: false,
        };
      },
    });
    const accepted = await service.startCreate(createRequest());
    expect(accepted).toMatchObject({
      duplicate: false,
      accepted: true,
      conversation: {
        state: 'running',
        activeTurnId: 'turn_12345678',
        revision: 3,
      },
    });
    expect(runnerCompleted).toBe(false);

    const retry = await service.startCreate(createRequest());
    expect(retry).toMatchObject({
      duplicate: true,
      accepted: false,
      conversation: { state: 'running', activeTurnId: 'turn_12345678' },
    });
    resolveTurn();
    for (let attempt = 0; attempt < 100 && journal.get('conversation_12345678')?.state !== 'idle'; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(journal.get('conversation_12345678')).toMatchObject({
      state: 'idle', activeTurnId: null, revision: 4,
    });
    await service.shutdown();
    journal.close();
  });

  test('starts a continued turn asynchronously and deduplicates mobile retries durably', async () => {
    let run = 0;
    let resolveContinued!: () => void;
    const continuedTerminal = new Promise<void>(resolve => { resolveContinued = resolve; });
    const { service, journal } = harness({
      runCodexConversation: async input => {
        run += 1;
        await input.bindProviderIds({ threadId: input.providerThreadId ?? PROVIDER_THREAD_ID });
        await input.bindProviderIds({
          threadId: input.providerThreadId ?? PROVIDER_THREAD_ID,
          turnId: PROVIDER_TURN_ID,
        });
        if (run === 2) {
          input.registerLiveControl?.({
            steer: async () => {},
            interrupt: async () => {},
          });
          await continuedTerminal;
        }
        return {
          threadId: input.providerThreadId ?? PROVIDER_THREAD_ID,
          turnId: PROVIDER_TURN_ID,
          finalSummary: '완료',
          resumed: input.providerThreadId !== null,
        };
      },
    });
    const created = await service.create(createRequest());
    const request = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_continue_12345678',
      conversationId: created.conversation.conversationId,
      expectedRevision: created.conversation.revision,
      prompt: '이어서 모바일 전환을 검토해줘.',
    } as const;
    expect(await service.startContinue(request)).toMatchObject({
      duplicate: false,
      accepted: true,
      conversation: { state: 'running', revision: 5 },
    });
    expect(await service.startContinue({
      ...request,
      requestId: 'request_continue_retry_87654321',
    })).toMatchObject({
      duplicate: true,
      accepted: false,
      conversation: { state: 'running', revision: 5 },
    });
    await expect(service.startContinue({
      ...request,
      requestId: 'request_continue_other_87654321',
      prompt: '같은 revision의 다른 지시',
    })).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
    } satisfies Partial<AgentRuntimeConversationServiceError>);
    expect(run).toBe(2);
    resolveContinued();
    for (let attempt = 0; attempt < 100 && journal.get(request.conversationId)?.state !== 'idle'; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(journal.get(request.conversationId)).toMatchObject({ state: 'idle', revision: 6 });
    const firstPage = service.readEvents({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: request.conversationId,
      after: 0,
    });
    expect(firstPage.events.map(event => event.type)).toEqual([
      'conversation.turn.started',
      'conversation.turn.completed',
      'conversation.turn.started',
      'conversation.turn.completed',
    ]);
    expect(firstPage.nextCursor).toBe(firstPage.events.at(-1)!.seq);
    expect(service.readEvents({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: request.conversationId,
      after: firstPage.nextCursor,
    }).events).toEqual([]);
    expect(() => service.readEvents({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: request.conversationId,
      after: firstPage.nextCursor + 1,
    })).toThrow('cursor');
    await service.shutdown();
    journal.close();
  });

  test('does not report an uncertain prepared continue receipt as accepted after restart', async () => {
    const { service, journal } = harness();
    const created = journal.create(createRequest(), 'AgentsToZ');
    journal.bindProviderThread(
      created.conversation.summary.conversationId,
      1,
      PROVIDER_THREAD_ID,
    );
    const request = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_continue_prepared_12345678',
      conversationId: created.conversation.summary.conversationId,
      expectedRevision: 2,
      prompt: '응답 유실 뒤 재전송하면 안 되는 지시',
    } as const;
    journal.prepareContinue(request);

    await expect(service.continue({
      ...request,
      requestId: 'request_continue_prepared_retry_87654321',
    })).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
    } satisfies Partial<AgentRuntimeConversationServiceError>);
    expect(journal.get(request.conversationId)).toMatchObject({ state: 'idle', revision: 2 });
    journal.close();
  });

  test('reconciles an uncertain create retry under the same workspace lease', async () => {
    let runs = 0;
    let inspections = 0;
    let revalidations = 0;
    const { service, journal, releases } = harness({
      acquireWorkspaceLease: async () => ({
        revalidate: async () => { revalidations += 1; return true; },
        release: async () => true,
      }),
      runCodexConversation: async input => {
        runs += 1;
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        throw new Error('response lost after provider accepted the turn');
      },
      inspectCodexConversation: async () => {
        inspections += 1;
        return { status: 'idle' };
      },
    });
    await expect(service.create(createRequest())).rejects.toThrow('response lost');
    const retry = await service.create(createRequest());
    expect(retry).toMatchObject({
      duplicate: true,
      finalSummary: null,
      conversation: { state: 'idle', revision: 5 },
    });
    expect(runs).toBe(1);
    expect(inspections).toBe(1);
    expect(revalidations).toBe(4);
    expect(releases()).toBe(0);
    journal.close();
  });

  test('archives and restores only idle conversations with revision fencing', async () => {
    const actions: string[] = [];
    const { service, journal } = harness({
      mutateCodexConversation: async input => {
        actions.push(input.action);
        return { action: input.action };
      },
    });
    const created = await service.create(createRequest());
    const archived = await service.setArchived({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_archive_12345678',
      conversationId: created.conversation.conversationId,
      expectedRevision: created.conversation.revision,
    }, true);
    expect(archived).toMatchObject({ state: 'archived', revision: 5 });
    expect(await service.setArchived({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_archive_12345678',
      conversationId: created.conversation.conversationId,
      expectedRevision: created.conversation.revision,
    }, true)).toEqual(archived);
    expect(await service.setArchived({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_archive_retry_87654321',
      conversationId: created.conversation.conversationId,
      expectedRevision: created.conversation.revision,
    }, true)).toEqual(archived);
    expect(service.list()).toEqual([]);
    expect(service.list(true)).toHaveLength(1);
    await expect(service.setArchived({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_unarchive_12345678',
      conversationId: archived.conversationId,
      expectedRevision: archived.revision - 1,
    }, false)).rejects.toMatchObject({ code: 'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT' });
    const restored = await service.setArchived({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_unarchive_87654321',
      conversationId: archived.conversationId,
      expectedRevision: archived.revision,
    }, false);
    expect(restored).toMatchObject({ state: 'idle', revision: 6 });
    expect(actions).toEqual(['archive', 'unarchive']);
    journal.close();
  });

  test('stops lifecycle replay and marks the conversation unknown after a provider-boundary failure', async () => {
    let actions = 0;
    const { service, journal } = harness({
      mutateCodexConversation: async () => {
        actions += 1;
        throw new Error('provider response lost');
      },
    });
    const created = await service.create(createRequest());
    const request = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_archive_uncertain_12345678',
      conversationId: created.conversation.conversationId,
      expectedRevision: created.conversation.revision,
    } as const;

    await expect(service.setArchived(request, true)).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
    } satisfies Partial<AgentRuntimeConversationServiceError>);
    expect(journal.get(request.conversationId)).toMatchObject({ state: 'unknown', revision: 5 });
    await expect(service.setArchived({
      ...request,
      requestId: 'request_archive_uncertain_retry_87654321',
    }, true)).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
    } satisfies Partial<AgentRuntimeConversationServiceError>);
    expect(actions).toBe(1);
    journal.close();
  });

  test('reads bounded app-native history under the exact conversation revision and lease', async () => {
    const reads: Array<{ providerThreadId: string; conversationId: string; cwd: string }> = [];
    const { service, journal, releases } = harness({
      readCodexConversationHistory: async input => {
        reads.push({
          providerThreadId: input.providerThreadId,
          conversationId: input.conversationId,
          cwd: input.cwd,
        });
        return {
          status: 'idle',
          truncated: false,
          filtered: true,
          turns: [{
            turnId: 'turn_public_12345678',
            status: 'completed',
            startedAt: '2026-09-05T00:00:00.000Z',
            completedAt: '2026-09-05T00:00:01.000Z',
            messages: [{
              messageId: 'message_public_12345678',
              turnId: 'turn_public_12345678',
              role: 'assistant',
              phase: 'final_answer',
              text: '검토를 완료했습니다.',
            }],
          }],
        };
      },
    });
    const created = await service.create(createRequest());
    const request = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: created.conversation.conversationId,
      expectedRevision: created.conversation.revision,
    } as const;
    const outcome = await service.history(request);
    expect(outcome).toMatchObject({
      conversation: { conversationId: request.conversationId, state: 'idle' },
      history: { status: 'idle', filtered: true },
    });
    expect(reads).toEqual([{
      providerThreadId: PROVIDER_THREAD_ID,
      conversationId: 'conversation_12345678',
      cwd: '/tmp/agentstoz-project',
    }]);
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(PROVIDER_THREAD_ID);
    expect(serialized).not.toContain('/tmp/agentstoz-project');
    await expect(service.history({ ...request, expectedRevision: request.expectedRevision - 1 }))
      .rejects.toMatchObject({ code: 'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT' });
    expect(reads).toHaveLength(1);
    expect(releases()).toBe(2);
    journal.close();
  });

  test('aborts a history child and waits for its workspace lease before shutdown completes', async () => {
    let leaseCount = 0;
    let allowHistoryRelease!: () => void;
    const historyReleaseAllowed = new Promise<void>(resolve => { allowHistoryRelease = resolve; });
    let resolveHistoryStarted!: () => void;
    const historyStarted = new Promise<void>(resolve => { resolveHistoryStarted = resolve; });
    const { service, journal } = harness({
      acquireWorkspaceLease: async () => {
        leaseCount += 1;
        const thisLease = leaseCount;
        return {
          revalidate: async () => true,
          release: async () => {
            if (thisLease === 2) await historyReleaseAllowed;
            return true;
          },
        };
      },
      readCodexConversationHistory: async input => {
        resolveHistoryStarted();
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new CodexAgentRuntimeError(
            'CODEX_TASK_CANCELLED',
            'Codex 작업이 취소되었습니다.',
          ));
          if (input.signal?.aborted) abort();
          else input.signal?.addEventListener('abort', abort, { once: true });
        });
      },
      shutdownWaitMs: 1_000,
    });
    const created = await service.create(createRequest());
    const history = service.history({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: created.conversation.conversationId,
      expectedRevision: created.conversation.revision,
    });
    const historyOutcome = history.then(
      () => null,
      error => error as Error & { code?: string },
    );
    await historyStarted;
    let shutdownSettled = false;
    const shutdown = service.shutdown().then(() => { shutdownSettled = true; });
    await Bun.sleep(10);
    expect(shutdownSettled).toBe(false);
    allowHistoryRelease();
    await shutdown;
    expect(await historyOutcome).toMatchObject({ code: 'CODEX_TASK_CANCELLED' });
    expect(leaseCount).toBe(2);
    journal.close();
  });

  test('permanently deletes the provider thread before tombstoning local identity', async () => {
    const actions: string[] = [];
    const { service, journal } = harness({
      mutateCodexConversation: async input => {
        actions.push(input.action);
        return { action: input.action };
      },
    });
    const created = await service.create(createRequest());
    const request = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_delete_12345678',
      conversationId: created.conversation.conversationId,
      expectedRevision: created.conversation.revision,
      confirmPermanentDeletion: true,
    } as const;
    expect(await service.delete(request)).toEqual({
      conversationId: created.conversation.conversationId,
      deleted: true,
      duplicate: false,
    });
    expect(journal.get(created.conversation.conversationId)).toBeNull();
    expect(await service.delete({
      ...request,
      requestId: 'request_delete_retry_87654321',
    })).toEqual({
      conversationId: created.conversation.conversationId,
      deleted: true,
      duplicate: true,
    });
    expect(actions).toEqual(['delete']);
    journal.close();
  });

  test('does not retry an uncertain provider deletion or create a false tombstone', async () => {
    let actions = 0;
    const { service, journal } = harness({
      mutateCodexConversation: async () => {
        actions += 1;
        throw new Error('delete response lost');
      },
    });
    const created = await service.create(createRequest());
    const request = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_delete_uncertain_12345678',
      conversationId: created.conversation.conversationId,
      expectedRevision: created.conversation.revision,
      confirmPermanentDeletion: true,
    } as const;

    await expect(service.delete({
      ...request,
      requestId: 'request_delete_uncertain_retry_87654321',
    })).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
    } satisfies Partial<AgentRuntimeConversationServiceError>);
    expect(journal.get(request.conversationId)).toMatchObject({ state: 'unknown', revision: 5 });
    expect(journal.isDeleteFinalized(request.conversationId, request.requestId)).toBe(false);
    await expect(service.delete(request)).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
    } satisfies Partial<AgentRuntimeConversationServiceError>);
    expect(actions).toBe(1);
    journal.close();
  });

  test('steers and interrupts only the exact active public turn with retry receipts', async () => {
    let resolveControlReady!: () => void;
    const controlReady = new Promise<void>(resolve => { resolveControlReady = resolve; });
    let rejectTurn!: (error: Error) => void;
    const turnTerminal = new Promise<never>((_resolve, reject) => { rejectTurn = reject; });
    const providerControls: string[] = [];
    const { service, journal } = harness({
      runCodexConversation: async input => {
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        input.registerLiveControl?.({
          steer: async prompt => { providerControls.push(`steer:${prompt}`); },
          interrupt: async () => { providerControls.push('interrupt'); },
        });
        resolveControlReady();
        return turnTerminal;
      },
    });
    const create = service.create(createRequest());
    await controlReady;
    const running = journal.get('conversation_12345678')!;
    expect(running).toMatchObject({
      state: 'running', activeTurnId: 'turn_12345678', revision: 3,
    });

    const steerRequest = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_steer_12345678',
      conversationId: running.conversationId,
      expectedRevision: running.revision,
      expectedTurnId: running.activeTurnId!,
      prompt: '실패한 테스트를 먼저 확인해줘.',
    } as const;
    expect(await service.steer(steerRequest)).toMatchObject({
      state: 'running', activeTurnId: running.activeTurnId, revision: 4,
    });
    expect(await service.steer(steerRequest)).toMatchObject({ revision: 4 });
    expect(await service.steer({
      ...steerRequest,
      requestId: 'request_steer_retry_new_id_87654321',
    })).toMatchObject({ revision: 4 });
    expect(providerControls).toEqual(['steer:실패한 테스트를 먼저 확인해줘.']);

    const interruptRequest = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_interrupt_12345678',
      conversationId: running.conversationId,
      expectedRevision: 4,
      expectedTurnId: running.activeTurnId!,
    } as const;
    expect(await service.interrupt(interruptRequest)).toMatchObject({
      state: 'running', revision: 5,
    });
    expect(providerControls).toEqual([
      'steer:실패한 테스트를 먼저 확인해줘.',
      'interrupt',
    ]);
    rejectTurn(new CodexAgentRuntimeError(
      'CODEX_TASK_INTERRUPTED',
      'Codex 작업이 완료 전에 중단되었습니다.',
    ));
    await expect(create).rejects.toMatchObject({ code: 'CODEX_TASK_INTERRUPTED' });
    expect(journal.get('conversation_12345678')).toMatchObject({
      state: 'idle', activeTurnId: null, revision: 6,
    });
    journal.close();
  });

  test('never replays an uncertain live control even when mobile retries with a new id', async () => {
    let resolveControlReady!: () => void;
    const controlReady = new Promise<void>(resolve => { resolveControlReady = resolve; });
    let rejectTurn!: (error: Error) => void;
    const turnTerminal = new Promise<never>((_resolve, reject) => { rejectTurn = reject; });
    let steerCalls = 0;
    const { service, journal } = harness({
      runCodexConversation: async input => {
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        input.registerLiveControl?.({
          steer: async () => {
            steerCalls += 1;
            throw new Error('provider acknowledgement lost');
          },
          interrupt: async () => {},
        });
        resolveControlReady();
        return turnTerminal;
      },
    });
    const create = service.create(createRequest());
    await controlReady;
    const running = journal.get('conversation_12345678')!;
    const request = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_steer_uncertain_12345678',
      conversationId: running.conversationId,
      expectedRevision: running.revision,
      expectedTurnId: running.activeTurnId!,
      prompt: '한 번만 반영해야 하는 추가 지시',
    } as const;

    await expect(service.steer(request)).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
    } satisfies Partial<AgentRuntimeConversationServiceError>);
    expect(journal.get(request.conversationId)).toMatchObject({ state: 'unknown', revision: 4 });
    await expect(service.steer({
      ...request,
      requestId: 'request_steer_uncertain_retry_87654321',
    })).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
    } satisfies Partial<AgentRuntimeConversationServiceError>);
    expect(steerCalls).toBe(1);

    rejectTurn(new Error('provider stream closed'));
    await expect(create).rejects.toThrow('provider stream closed');
    journal.close();
  });

  test('aborts owned turns and confirms cleanup before sidecar shutdown completes', async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const { service, journal, releases } = harness({
      runCodexConversation: async input => {
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        resolveStarted();
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new CodexAgentRuntimeError(
            'CODEX_TASK_CANCELLED',
            'Codex 작업이 취소되었습니다.',
          ));
          if (input.signal?.aborted) abort();
          else input.signal?.addEventListener('abort', abort, { once: true });
        });
      },
      shutdownWaitMs: 1_000,
    });
    const create = service.create(createRequest());
    const createOutcome = create.then(
      () => null,
      error => error as Error & { code?: string },
    );
    await Promise.race([
      started,
      Bun.sleep(1_000).then(() => { throw new Error('conversation start timed out'); }),
    ]);
    await expect(Promise.race([
      service.shutdown(),
      Bun.sleep(2_000).then(() => { throw new Error('conversation shutdown timed out'); }),
    ])).resolves.toBeUndefined();
    expect(await createOutcome).toMatchObject({ code: 'CODEX_TASK_CANCELLED' });
    expect(releases()).toBe(1);
    expect(journal.get('conversation_12345678')).toMatchObject({
      state: 'unknown', activeTurnId: null, revision: 4,
    });
    await expect(service.continue({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_after_shutdown_12345678',
      conversationId: 'conversation_12345678',
      expectedRevision: 4,
      prompt: '다시 시작해줘.',
    })).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_SHUTTING_DOWN',
    });
    journal.close();
  });

  test('keeps every real launch closed behind the containment policy gate', async () => {
    let touched = false;
    const { journal, service } = harness({
      managedExecutionEnabled: false,
      resolveTarget: async () => {
        touched = true;
        throw new Error('must not resolve');
      },
    });
    await expect(service.create(createRequest())).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_EXECUTION_HELD',
    });
    expect(touched).toBe(false);
    expect(journal.list(true)).toEqual([]);
    journal.close();
  });

  test('opens only the explicitly configured tool-free read-only conversation mode', async () => {
    const observedModes: string[] = [];
    const { journal, service } = harness({
      managedExecutionEnabled: false,
      executionEnabled: true,
      executionMode: 'read-only',
      runCodexConversation: async input => {
        observedModes.push(input.executionMode);
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        return {
          threadId: PROVIDER_THREAD_ID,
          turnId: PROVIDER_TURN_ID,
          finalSummary: '읽기 전용 대화를 완료했습니다.',
          resumed: false,
        };
      },
    });
    await expect(service.create(createRequest())).resolves.toMatchObject({
      finalSummary: '읽기 전용 대화를 완료했습니다.',
    });
    expect(observedModes).toEqual(['read-only']);
    journal.close();
  });

  test('marks an uncertain provider failure unknown and releases the workspace lease', async () => {
    const { service, journal, releases } = harness({
      runCodexConversation: async input => {
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID });
        await input.bindProviderIds({ threadId: PROVIDER_THREAD_ID, turnId: PROVIDER_TURN_ID });
        throw new Error('transport lost');
      },
    });
    await expect(service.create(createRequest())).rejects.toThrow('transport lost');
    expect(journal.get('conversation_12345678')).toMatchObject({
      state: 'unknown', activeTurnId: null, revision: 4,
    });
    expect(releases()).toBe(1);
    journal.close();
  });

  test('fails closed on stale revisions and unconfirmed workspace cleanup', async () => {
    const { service, journal } = harness({
      acquireWorkspaceLease: async () => ({ release: async () => false }),
    });
    await expect(service.create(createRequest())).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_CONVERSATION_CLEANUP_UNCONFIRMED',
    });
    const current = journal.get('conversation_12345678')!;
    await expect(service.continue({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      requestId: 'request_87654321',
      conversationId: current.conversationId,
      expectedRevision: current.revision - 1,
      prompt: '계속해줘.',
    })).rejects.toBeInstanceOf(AgentRuntimeConversationServiceError);
    journal.close();
  });
});
