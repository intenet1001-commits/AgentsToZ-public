import { describe, expect, test } from 'bun:test';

import {
  CodexAgentRuntimeError,
  codexAgentChildEnv,
  codexAgentTaskFailure,
  confirmCodexProcessGroupTerminated,
  inspectCodexAgentRuntimeCompatibility,
  inspectCodexConversation,
  readCodexConversationHistory,
  mutateCodexConversation,
  probeCodexAgentRuntimeCompatibility,
  runCodexAgentTask,
  runCodexConversationTurn,
  type CodexAgentProviderIds,
  type CodexAgentRuntimeDependencies,
  type CodexAgentTaskEventDraft,
  type SpawnCodexAgentAppServer,
} from '../packages/runtime-sdk/index';
import { assertAgentRuntimeRemoteSafe } from '../src/agentRuntimeProtocol';
import {
  CODEX_RUNTIME_MACOS_IDENTIFIER,
  CODEX_RUNTIME_MACOS_TEAM_ID,
  codexRuntimeExecutableRevision,
  type CodexRuntimeExecutableIdentity,
} from '../src/codexRuntimeExecutable';

const THREAD_ID = '0199a213-81c0-7800-8aa1-bbab2a035a61';
const TURN_ID = '0199a213-81c0-7800-8aa1-bbab2a035a62';
const OTHER_THREAD_ID = '0199a213-81c0-7800-8aa1-bbab2a035a63';
const OTHER_TURN_ID = '0199a213-81c0-7800-8aa1-bbab2a035a64';
const CODEX_EXECUTABLE = '/Applications/ChatGPT.app/Contents/Resources/codex';
const CWD = '/Users/test/Private Product';
const MODEL_ID = 'picker-model-id';
const PROVIDER_MODEL = 'gpt-5.6-terra';

function executableIdentity(path = CODEX_EXECUTABLE): CodexRuntimeExecutableIdentity {
  const identity: Omit<CodexRuntimeExecutableIdentity, 'revision'> = {
    path,
    source: 'standalone-native',
    version: '0.0.0',
    sha256: 'a'.repeat(64),
    stat: {
      dev: '1',
      ino: '2',
      size: '3',
      mode: 0o100755,
      mtimeNs: '4',
      ctimeNs: '5',
    },
    signing: process.platform === 'darwin' ? {
      platform: 'darwin',
      teamId: CODEX_RUNTIME_MACOS_TEAM_ID,
      identifier: CODEX_RUNTIME_MACOS_IDENTIFIER,
    } : null,
  };
  return { ...identity, revision: codexRuntimeExecutableRevision(identity) };
}

function fakeCatalogModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MODEL_ID,
    model: PROVIDER_MODEL,
    displayName: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model.',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Deep' },
    ],
    defaultReasoningEffort: 'medium',
    ...overrides,
  };
}

interface FakeOptions {
  approvalRequest?: boolean;
  userInputRequest?: Record<string, unknown> | true;
  externalToolType?: 'mcpToolCall' | 'dynamicToolCall' | 'collabAgentToolCall' | 'webSearch';
  finalText?: string;
  holdOpen?: boolean;
  closeOnEnd?: boolean;
  ignoreUnsubscribe?: boolean;
  configReadResult?: Record<string, unknown>;
  modelListPages?: Array<Record<string, unknown>>;
  threadStartResult?: Record<string, unknown>;
  threadResumeResult?: Record<string, unknown>;
  threadReadResult?: Record<string, unknown>;
  errorNotificationInfo?: unknown;
  turnErrorInfo?: unknown;
  turnStatus?: 'completed' | 'failed' | 'interrupted';
  persistentThreadId?: string;
  persistentTurnId?: string;
  semanticOnly?: boolean;
}

function fakeAppServer(options: FakeOptions = {}): {
  spawn: SpawnCodexAgentAppServer;
  command: string[];
  spawnOptions: Array<Record<string, unknown>>;
  spawnIdentities: Array<CodexRuntimeExecutableIdentity | undefined>;
  requests: Array<Record<string, any>>;
  killSignals: Array<number | NodeJS.Signals | undefined>;
  isExited: () => boolean;
  turnStarted: Promise<void>;
} {
  const command: string[] = [];
  const spawnOptions: Array<Record<string, unknown>> = [];
  const spawnIdentities: Array<CodexRuntimeExecutableIdentity | undefined> = [];
  const requests: Array<Record<string, any>> = [];
  const killSignals: Array<number | NodeJS.Signals | undefined> = [];
  let processExited = false;
  let resolveTurnStarted!: () => void;
  const turnStarted = new Promise<void>(resolve => { resolveTurnStarted = resolve; });

  const spawn: SpawnCodexAgentAppServer = (nextCommand, nextOptions, executableIdentity) => {
    command.push(...nextCommand);
    spawnOptions.push(nextOptions);
    spawnIdentities.push(executableIdentity);
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    let resolveExit!: (code: number) => void;
    let closed = false;
    let modelListPageIndex = 0;
    const encoder = new TextEncoder();
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { stdoutController = controller; },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        stderrController = controller;
        controller.enqueue(encoder.encode(`private stderr ${CWD} token=do-not-emit`));
      },
    });
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const emit = (value: Record<string, unknown>) => {
      if (!closed) stdoutController.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
    };
    const finish = (code = 0) => {
      if (closed) return;
      closed = true;
      processExited = true;
      stdoutController.close();
      stderrController.close();
      resolveExit(code);
    };
    const completeTurn = () => {
      const activeThreadId = options.persistentThreadId ?? THREAD_ID;
      const activeTurnId = options.persistentTurnId ?? TURN_ID;
      const status = options.turnStatus ?? 'completed';
      const finalItem = {
        type: 'agentMessage',
        id: 'item-final',
        phase: 'final_answer',
        text: options.finalText ?? `완료했습니다. ${CWD}/src/result.ts를 갱신했습니다.`,
      };
      emit({
        method: 'item/completed',
        params: { threadId: activeThreadId, turnId: activeTurnId, item: finalItem },
      });
      emit({
        method: 'turn/completed',
        params: {
          threadId: activeThreadId,
          turn: {
            id: activeTurnId,
            status,
            error: status === 'failed'
              ? {
                  message: `secret failure at ${CWD}`,
                  additionalDetails: 'raw details',
                  codexErrorInfo: options.turnErrorInfo ?? null,
                }
              : null,
            items: [finalItem],
          },
        },
      });
    };

    const stdin = {
      write(chunk: string | Uint8Array) {
        const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        for (const line of text.trim().split('\n')) {
          if (!line) continue;
          const request = JSON.parse(line) as Record<string, any>;
          requests.push(request);
          if (request.id === 99 && request.method === undefined && options.userInputRequest) {
            completeTurn();
          } else if (request.method === 'initialize') {
            emit({ id: request.id, result: { userAgent: 'fake' } });
          } else if (request.method === 'model/list') {
            const pages = options.modelListPages ?? [{
              data: [fakeCatalogModel()],
              nextCursor: null,
            }];
            const result = pages[modelListPageIndex++];
            emit(result
              ? { id: request.id, result }
              : { id: request.id, error: { code: -32602, message: 'unexpected page' } });
          } else if (request.method === 'config/read') {
            emit({
              id: request.id,
              result: options.configReadResult ?? {
                config: {
                  mcp_servers: {
                    node_repl: { enabled: true },
                    'team.tools': { enabled: true },
                  },
                },
                origins: {},
                layers: [],
              },
            });
          } else if (request.method === 'thread/start') {
            const safeResult = {
              cwd: CWD,
              runtimeWorkspaceRoots: [CWD],
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              model: request.params.model,
              reasoningEffort: request.params.config?.model_reasoning_effort ?? null,
              sandbox: {
                type: 'workspaceWrite',
                writableRoots: [],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              },
              thread: { id: THREAD_ID, sessionId: THREAD_ID, cwd: CWD, ephemeral: true },
            };
            emit({
              id: request.id,
              result: { ...safeResult, ...options.threadStartResult },
            });
          } else if (request.method === 'thread/resume') {
            emit({
              id: request.id,
              result: options.threadResumeResult ?? {
                thread: {
                  id: request.params.threadId,
                  sessionId: request.params.threadId,
                  ephemeral: false,
                },
              },
            });
          } else if (request.method === 'thread/read') {
            emit({
              id: request.id,
              result: options.threadReadResult ?? {
                thread: {
                  id: request.params.threadId,
                  sessionId: request.params.threadId,
                  ephemeral: false,
                  status: { type: 'notLoaded' },
                  preview: `private ${CWD}`,
                },
              },
            });
          } else if (request.method === 'thread/archive') {
            emit({ id: request.id, result: {} });
          } else if (request.method === 'thread/delete') {
            emit({ id: request.id, result: {} });
          } else if (request.method === 'thread/unarchive') {
            emit({
              id: request.id,
              result: {
                thread: {
                  id: request.params.threadId,
                  sessionId: request.params.threadId,
                  ephemeral: false,
                },
              },
            });
          } else if (request.method === 'turn/start') {
            const activeThreadId = options.persistentThreadId ?? THREAD_ID;
            const activeTurnId = options.persistentTurnId ?? TURN_ID;
            emit({ id: request.id, result: { turn: { id: activeTurnId, status: 'inProgress' } } });
            resolveTurnStarted();
            emit({
              method: 'turn/completed',
              params: {
                threadId: OTHER_THREAD_ID,
                turn: { id: OTHER_TURN_ID, status: 'completed', items: [] },
              },
            });
            emit({
              method: 'turn/started',
              params: { threadId: activeThreadId, turn: { id: activeTurnId, status: 'inProgress' } },
            });
            if (!options.semanticOnly) {
            emit({
              method: 'item/started',
              params: {
                threadId: activeThreadId,
                turnId: activeTurnId,
                item: {
                  type: 'commandExecution',
                  id: 'item-command',
                  command: `rm -rf ${CWD}/secret`,
                  cwd: CWD,
                  aggregatedOutput: 'raw output must not cross the boundary',
                  status: 'inProgress',
                },
              },
            });
            emit({
              method: 'turn/diff/updated',
              params: {
                threadId: activeThreadId,
                turnId: activeTurnId,
                diff: `--- ${CWD}/secret.ts\n+credential`,
              },
            });
            emit({
              method: 'item/completed',
              params: {
                threadId: activeThreadId,
                turnId: activeTurnId,
                item: {
                  type: 'commandExecution',
                  id: 'item-command',
                  command: `rm -rf ${CWD}/secret`,
                  cwd: CWD,
                  aggregatedOutput: 'raw output must not cross the boundary',
                  exitCode: 0,
                  status: 'completed',
                },
              },
            });
            emit({
              method: 'item/completed',
              params: {
                threadId: activeThreadId,
                turnId: activeTurnId,
                item: {
                  type: 'fileChange',
                  id: 'item-file',
                  changes: [{ path: `${CWD}/secret.ts`, diff: '+credential' }],
                  status: 'completed',
                },
              },
            });
            }
            if (options.externalToolType) {
              emit({
                method: 'item/started',
                params: {
                  threadId: activeThreadId,
                  turnId: activeTurnId,
                  item: { type: options.externalToolType, id: 'external-tool', status: 'inProgress' },
                },
              });
            }
            if (options.errorNotificationInfo !== undefined) {
              emit({
                method: 'error',
                params: {
                  threadId: activeThreadId,
                  turnId: activeTurnId,
                  willRetry: false,
                  error: {
                    message: `secret notification failure at ${CWD}`,
                    additionalDetails: 'raw notification details',
                    codexErrorInfo: options.errorNotificationInfo,
                  },
                },
              });
            } else if (options.approvalRequest) {
              emit({
                id: 99,
                method: 'item/commandExecution/requestApproval',
                params: {
                  threadId: activeThreadId,
                  turnId: activeTurnId,
                  command: `touch ${CWD}/not-allowed`,
                },
              });
            } else if (options.userInputRequest) {
              emit({
                id: 99,
                method: 'item/tool/requestUserInput',
                params: options.userInputRequest === true ? {
                  threadId: activeThreadId,
                  turnId: activeTurnId,
                  itemId: 'item-question',
                  isBlocking: true,
                  autoResolutionMs: null,
                  questions: [{
                    id: 'scope',
                    header: '작업 범위',
                    question: '어느 범위까지 진행할까요?',
                    isOther: true,
                    isSecret: false,
                    options: [
                      { label: '현재 파일', description: '현재 파일만 변경합니다.' },
                      { label: '전체 프로젝트', description: '연관 파일도 함께 변경합니다.' },
                    ],
                  }],
                } : options.userInputRequest,
              });
            } else if (!options.holdOpen) {
              completeTurn();
            }
          } else if (request.method === 'turn/steer') {
            emit({
              id: request.id,
              result: { turnId: request.params.expectedTurnId },
            });
          } else if (request.method === 'turn/interrupt') {
            emit({ id: request.id, result: {} });
            emit({
              method: 'turn/completed',
              params: {
                threadId: request.params.threadId,
                turn: { id: request.params.turnId, status: 'interrupted', items: [] },
              },
            });
          } else if (request.method === 'thread/unsubscribe') {
            if (!options.ignoreUnsubscribe) {
              emit({ id: request.id, result: { status: 'unsubscribed' } });
            }
          }
        }
      },
      flush() {},
      end() {
        if (options.closeOnEnd !== false) finish();
      },
    };

    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill(signal) {
        killSignals.push(signal);
        finish(signal === 'SIGKILL' ? 137 : 143);
      },
    };
  };

  return {
    spawn,
    command,
    spawnOptions,
    spawnIdentities,
    requests,
    killSignals,
    isExited: () => processExited,
    turnStarted,
  };
}

function runtimeInput(
  emit: (draft: CodexAgentTaskEventDraft) => void | Promise<void>,
  signal?: AbortSignal,
  bindProviderIds: NonNullable<Parameters<typeof runCodexAgentTask>[0]['bindProviderIds']> = () => {},
) {
  return {
    taskId: 'task_12345678',
    codexExecutable: CODEX_EXECUTABLE,
    codexExecutableIdentity: executableIdentity(),
    cwd: CWD,
    model: PROVIDER_MODEL,
    reasoningEffort: 'medium',
    executionMode: 'workspace-write' as const,
    prompt: '프로젝트를 검토하고 안전하게 수정해 주세요. $(touch /tmp/not-executed)',
    emit,
    bindProviderIds,
    signal,
  };
}

function runtimeDependencies(
  fake: ReturnType<typeof fakeAppServer>,
  overrides: Partial<CodexAgentRuntimeDependencies> = {},
): CodexAgentRuntimeDependencies {
  return {
    spawn: fake.spawn,
    assertExecutableIdentityCurrent: () => {},
    terminateProcessTree: (child, signal) => { child.kill(signal); },
    confirmProcessTreeTerminated: async (child, timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          child.exited.then(() => true, () => true),
          new Promise<false>(resolve => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    timeoutMs: 2_000,
    ...overrides,
  };
}

describe('Codex semantic agent runtime', () => {
  test('starts and resumes retained threads without changing ephemeral task behavior', async () => {
    const createFake = fakeAppServer({
      threadStartResult: {
        thread: { id: THREAD_ID, sessionId: THREAD_ID, cwd: CWD, ephemeral: false },
      },
    });
    const bound: CodexAgentProviderIds[] = [];
    const { taskId: _taskId, ...common } = runtimeInput(
      () => {},
      undefined,
      ids => { bound.push(ids); },
    );
    const created = await runCodexConversationTurn({
      ...common,
      conversationId: 'conversation_12345678',
      providerThreadId: null,
    }, runtimeDependencies(createFake));
    expect(created).toMatchObject({ threadId: THREAD_ID, turnId: TURN_ID, resumed: false });
    expect(createFake.requests.find(request => request.method === 'thread/start')?.params)
      .toMatchObject({ ephemeral: false, approvalPolicy: 'never', sandbox: 'workspace-write' });
    expect(createFake.requests.some(request => request.method === 'thread/resume')).toBe(false);
    expect(bound).toEqual([{ threadId: THREAD_ID }, { threadId: THREAD_ID, turnId: TURN_ID }]);

    const resumeFake = fakeAppServer();
    const resumed = await runCodexConversationTurn({
      ...common,
      conversationId: 'conversation_12345678',
      providerThreadId: THREAD_ID,
    }, runtimeDependencies(resumeFake));
    expect(resumed).toMatchObject({ threadId: THREAD_ID, turnId: TURN_ID, resumed: true });
    expect(resumeFake.requests.some(request => request.method === 'thread/start')).toBe(false);
    expect(resumeFake.requests.find(request => request.method === 'thread/resume')?.params)
      .toMatchObject({
        threadId: THREAD_ID,
        cwd: CWD,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        model: PROVIDER_MODEL,
        sandbox: 'workspace-write',
      });
  });

  test('runs retained read-only conversation turns with every local tool backend disabled', async () => {
    const fake = fakeAppServer({
      semanticOnly: true,
      threadStartResult: {
        thread: { id: THREAD_ID, sessionId: THREAD_ID, cwd: CWD, ephemeral: false },
      },
    });
    const { taskId: _taskId, ...common } = runtimeInput(() => {});
    const result = await runCodexConversationTurn({
      ...common,
      executionMode: 'read-only',
      conversationId: 'conversation_12345678',
      providerThreadId: null,
    }, runtimeDependencies(fake));

    expect(result).toMatchObject({ threadId: THREAD_ID, turnId: TURN_ID, resumed: false });
    expect(fake.command).toContain('sandbox_mode="read-only"');
    for (const feature of [
      'goals', 'shell_snapshot', 'shell_tool', 'skill_search',
      'unified_exec', 'view_image', 'workspace_dependencies',
    ]) {
      expect(fake.command).toContain(feature);
    }
    expect(fake.command).toContain('skills.include_instructions=false');
    expect(fake.command.some(value => value.startsWith('sandbox_workspace_write.'))).toBe(false);
    expect(fake.requests.find(request => request.method === 'thread/start')?.params)
      .toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false });
    expect(fake.requests.find(request => request.method === 'turn/start')?.params.sandboxPolicy)
      .toEqual({ type: 'readOnly' });
  });

  test('fails a tool-free read-only conversation if the provider reports any tool execution', async () => {
    const fake = fakeAppServer({
      threadStartResult: {
        thread: { id: THREAD_ID, sessionId: THREAD_ID, cwd: CWD, ephemeral: false },
      },
    });
    const { taskId: _taskId, ...common } = runtimeInput(() => {});
    await expect(runCodexConversationTurn({
      ...common,
      executionMode: 'read-only',
      conversationId: 'conversation_12345678',
      providerThreadId: null,
    }, runtimeDependencies(fake))).rejects.toMatchObject({
      code: 'CODEX_TASK_POLICY_UNVERIFIED',
      publicMessage: expect.stringContaining('도구 없음'),
    });
    expect(fake.isExited()).toBe(true);
  });

  test('answers one bounded request_user_input without opening approval handling', async () => {
    const fake = fakeAppServer({ userInputRequest: true });
    const observed: unknown[] = [];
    const { taskId: _taskId, ...common } = runtimeInput(() => {});
    const result = await runCodexConversationTurn({
      ...common,
      conversationId: 'conversation_12345678',
      providerThreadId: THREAD_ID,
      requestUserInput: async request => {
        observed.push(request);
        return { answers: { scope: { answers: ['현재 파일'] } } };
      },
    }, runtimeDependencies(fake));

    expect(result).toMatchObject({ threadId: THREAD_ID, turnId: TURN_ID, resumed: true });
    expect(observed).toEqual([{
      questions: [{
        id: 'scope',
        header: '작업 범위',
        question: '어느 범위까지 진행할까요?',
        allowOther: true,
        options: [
          { label: '현재 파일', description: '현재 파일만 변경합니다.' },
          { label: '전체 프로젝트', description: '연관 파일도 함께 변경합니다.' },
        ],
      }],
    }]);
    expect(fake.command).toContain('default_mode_request_user_input');
    expect(fake.command).toContain('tools.experimental_request_user_input.enabled=true');
    expect(fake.requests.find(request => request.id === 99 && request.result)?.result).toEqual({
      answers: { scope: { answers: ['현재 파일'] } },
    });
    expect(fake.requests.some(request => request.result?.decision)).toBe(false);
  });

  test('rejects secret or mismatched user-input requests before invoking the UI callback', async () => {
    const { taskId: _taskId, ...common } = runtimeInput(() => {});
    for (const questions of [
      [{
        id: 'password',
        header: '로그인',
        question: '비밀번호를 입력하세요.',
        isSecret: true,
        options: null,
      }],
      [{
        id: 'scope',
        header: '범위',
        question: '범위를 고르세요.',
        isSecret: false,
        options: [
          { label: '허용', description: '첫 번째' },
          { label: '거절', description: '두 번째' },
        ],
      }],
      [{
        id: '__proto__',
        header: '범위',
        question: '범위를 고르세요.',
        isSecret: false,
        options: null,
      }],
    ]) {
      const fake = fakeAppServer({
        userInputRequest: {
          threadId: questions[0]!.id === 'scope' ? OTHER_THREAD_ID : THREAD_ID,
          turnId: TURN_ID,
          itemId: 'item-question',
          isBlocking: true,
          autoResolutionMs: null,
          questions,
        },
      });
      let calls = 0;
      await expect(runCodexConversationTurn({
        ...common,
        conversationId: 'conversation_12345678',
        providerThreadId: THREAD_ID,
        requestUserInput: async () => {
          calls += 1;
          return { answers: {} };
        },
      }, runtimeDependencies(fake))).rejects.toMatchObject({
        code: 'CODEX_APP_SERVER_PROTOCOL_FAILED',
      });
      expect(calls).toBe(0);
      expect(fake.requests.some(request => request.id === 99 && request.result)).toBe(false);
    }
  });

  test('rejects a user answer outside the exact option set', async () => {
    const fake = fakeAppServer({
      userInputRequest: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item-question',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [{
          id: 'scope',
          header: '작업 범위',
          question: '어느 범위까지 진행할까요?',
          isOther: false,
          isSecret: false,
          options: [
            { label: '현재 파일', description: '현재 파일만 변경합니다.' },
            { label: '전체 프로젝트', description: '연관 파일도 함께 변경합니다.' },
          ],
        }],
      },
    });
    const { taskId: _taskId, ...common } = runtimeInput(() => {});
    await expect(runCodexConversationTurn({
      ...common,
      conversationId: 'conversation_12345678',
      providerThreadId: THREAD_ID,
      requestUserInput: async () => ({
        answers: { scope: { answers: ['보이지 않은 선택지'] } },
      }),
    }, runtimeDependencies(fake))).rejects.toMatchObject({
      code: 'CODEX_TASK_SERVER_REQUEST_DENIED',
    });
    expect(fake.requests.some(request => request.id === 99 && request.result)).toBe(false);
  });

  test('keeps approval requests fail-closed even when user questions are enabled', async () => {
    const fake = fakeAppServer({ approvalRequest: true });
    const { taskId: _taskId, ...common } = runtimeInput(() => {});
    let calls = 0;
    await expect(runCodexConversationTurn({
      ...common,
      conversationId: 'conversation_12345678',
      providerThreadId: THREAD_ID,
      requestUserInput: async () => {
        calls += 1;
        return { answers: {} };
      },
    }, runtimeDependencies(fake))).rejects.toMatchObject({
      code: 'CODEX_TASK_APPROVAL_REQUIRED',
    });
    expect(calls).toBe(0);
    expect(fake.requests.some(request => request.id === 99 && request.result)).toBe(false);
  });

  test('binds documented opaque provider ids and exposes only exact live turn controls', async () => {
    const providerThreadId = 'thr_agentstoz_12345678';
    const providerTurnId = 'turn_agentstoz_12345678';
    const fake = fakeAppServer({
      holdOpen: true,
      persistentThreadId: providerThreadId,
      persistentTurnId: providerTurnId,
      threadResumeResult: {
        thread: { id: providerThreadId, sessionId: providerThreadId, ephemeral: false },
      },
    });
    let liveControl: import('../packages/runtime-sdk/index').CodexConversationLiveControl | null = null;
    let detached = 0;
    const { taskId: _taskId, ...common } = runtimeInput(() => {});
    const run = runCodexConversationTurn({
      ...common,
      conversationId: 'conversation_12345678',
      providerThreadId,
      registerLiveControl: control => {
        liveControl = control;
        return () => { detached += 1; };
      },
    }, runtimeDependencies(fake));
    await fake.turnStarted;
    for (let attempt = 0; attempt < 10 && liveControl === null; attempt += 1) {
      await Bun.sleep(0);
    }
    expect(liveControl).not.toBeNull();
    await liveControl!.steer('실패한 테스트를 먼저 확인해줘.');
    expect(fake.requests.find(request => request.method === 'turn/steer')?.params).toEqual({
      threadId: providerThreadId,
      input: [{ type: 'text', text: '실패한 테스트를 먼저 확인해줘.', text_elements: [] }],
      expectedTurnId: providerTurnId,
    });
    await liveControl!.interrupt();
    await expect(run).rejects.toMatchObject({ code: 'CODEX_TASK_INTERRUPTED' });
    expect(fake.requests.find(request => request.method === 'turn/interrupt')?.params).toEqual({
      threadId: providerThreadId,
      turnId: providerTurnId,
    });
    expect(detached).toBe(1);
    await expect(liveControl!.steer('너무 늦은 지시')).rejects.toMatchObject({
      code: 'CODEX_ACTIVE_TURN_NOT_STEERABLE',
    });
  });

  test('rejects a resumed provider thread substitution before starting a turn', async () => {
    const fake = fakeAppServer({
      threadResumeResult: {
        thread: { id: OTHER_THREAD_ID, sessionId: OTHER_THREAD_ID, ephemeral: false },
      },
    });
    const { taskId: _taskId, ...common } = runtimeInput(() => {});
    await expect(runCodexConversationTurn({
      ...common,
      conversationId: 'conversation_12345678',
      providerThreadId: THREAD_ID,
    }, runtimeDependencies(fake))).rejects.toMatchObject({
      code: 'CODEX_TASK_POLICY_UNVERIFIED',
    });
    expect(fake.requests.some(request => request.method === 'turn/start')).toBe(false);
  });

  test('reconciles retained-thread status without requesting or returning transcript content', async () => {
    for (const [providerStatus, expected] of [
      ['notLoaded', 'idle'],
      ['idle', 'idle'],
      ['active', 'active'],
      ['systemError', 'systemError'],
    ] as const) {
      const fake = fakeAppServer({
        threadReadResult: {
          thread: {
            id: THREAD_ID,
            ephemeral: false,
            status: providerStatus === 'active'
              ? { type: providerStatus, activeFlags: ['waitingOnApproval'] }
              : { type: providerStatus },
            turns: [{ secret: 'must not be observed' }],
          },
        },
      });
      const inspected = await inspectCodexConversation({
        codexExecutable: CODEX_EXECUTABLE,
        codexExecutableIdentity: executableIdentity(),
        cwd: CWD,
        providerThreadId: THREAD_ID,
      }, runtimeDependencies(fake));
      expect(inspected).toEqual({ status: expected });
      expect(fake.requests.find(request => request.method === 'thread/read')?.params)
        .toEqual({ threadId: THREAD_ID, includeTurns: false });
      expect(JSON.stringify(inspected)).not.toContain('turns');
      expect(JSON.stringify(inspected)).not.toContain(CWD);
    }
  });

  test('fails closed when thread/read substitutes identity, persistence, or status', async () => {
    for (const thread of [
      { id: OTHER_THREAD_ID, ephemeral: false, status: { type: 'idle' } },
      { id: THREAD_ID, ephemeral: true, status: { type: 'idle' } },
      { id: THREAD_ID, ephemeral: false, status: { type: 'mystery' } },
    ]) {
      const fake = fakeAppServer({ threadReadResult: { thread } });
      await expect(inspectCodexConversation({
        codexExecutable: CODEX_EXECUTABLE,
        codexExecutableIdentity: executableIdentity(),
        cwd: CWD,
        providerThreadId: THREAD_ID,
      }, runtimeDependencies(fake))).rejects.toMatchObject({
        code: 'CODEX_APP_SERVER_PROTOCOL_FAILED',
      });
    }
  });

  test('projects bounded app-native chat history without provider ids, paths, or raw tool data', async () => {
    // Current Codex builds use compact, turn-scoped history item IDs.
    const providerMessageId = 'item-2';
    const fake = fakeAppServer({
      threadReadResult: {
        thread: {
          id: THREAD_ID,
          ephemeral: false,
          status: { type: 'idle' },
          preview: `private preview ${CWD}`,
          path: `${CWD}/.codex/rollout.jsonl`,
          turns: [{
            id: TURN_ID,
            status: 'completed',
            startedAt: 1_788_537_600,
            completedAt: 1_788_537_601,
            items: [{
              type: 'userMessage',
              id: 'item-1',
              content: [
                {
                  type: 'text',
                  text: `검토해줘 ${CWD}/secret.ts OPENAI_API_KEY=supersecretvalue ${THREAD_ID}`,
                },
                { type: 'localImage', path: `${CWD}/secret.png` },
              ],
            }, {
              type: 'commandExecution',
              id: 'command_provider_12345678',
              command: `cat ${CWD}/secret.ts`,
              aggregatedOutput: 'raw-command-output',
            }, {
              type: 'agentMessage',
              id: providerMessageId,
              phase: 'final_answer',
              text: `완료했습니다. ${CWD}/src/result.ts ${TURN_ID} ${providerMessageId}`,
            }],
          }],
        },
      },
    });
    const history = await readCodexConversationHistory({
      codexExecutable: CODEX_EXECUTABLE,
      codexExecutableIdentity: executableIdentity(),
      cwd: CWD,
      conversationId: 'conversation_12345678',
      providerThreadId: THREAD_ID,
    }, runtimeDependencies(fake));
    expect(history).toMatchObject({
      status: 'idle',
      truncated: false,
      filtered: true,
      turns: [{
        status: 'completed',
        startedAt: '2026-09-04T16:00:00.000Z',
        completedAt: '2026-09-04T16:00:01.000Z',
        messages: [
          { role: 'user', phase: null },
          { role: 'assistant', phase: 'final_answer' },
        ],
      }],
    });
    expect(fake.requests.find(request => request.method === 'thread/read')?.params)
      .toEqual({ threadId: THREAD_ID, includeTurns: true });
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain(THREAD_ID);
    expect(serialized).not.toContain(TURN_ID);
    expect(serialized).not.toContain(providerMessageId);
    expect(serialized).not.toContain(CWD);
    expect(serialized).not.toContain('supersecretvalue');
    expect(serialized).not.toContain('raw-command-output');
    expect(serialized).toContain('[프로젝트]');
    expect(serialized).toContain('[비밀정보 삭제]');
    assertAgentRuntimeRemoteSafe(history);
  });

  test('bounds individual history messages and rejects malformed assistant phases', async () => {
    const longText = '가'.repeat(20_000);
    const boundedFake = fakeAppServer({
      threadReadResult: {
        thread: {
          id: THREAD_ID,
          ephemeral: false,
          status: { type: 'notLoaded' },
          turns: [{
            id: TURN_ID,
            status: 'completed',
            startedAt: null,
            completedAt: null,
            items: [{
              type: 'agentMessage',
              id: 'message_agent_12345678',
              phase: null,
              text: longText,
            }],
          }],
        },
      },
    });
    const bounded = await readCodexConversationHistory({
      codexExecutable: CODEX_EXECUTABLE,
      codexExecutableIdentity: executableIdentity(),
      cwd: CWD,
      conversationId: 'conversation_12345678',
      providerThreadId: THREAD_ID,
    }, runtimeDependencies(boundedFake));
    expect(bounded.truncated).toBe(true);
    expect(new TextEncoder().encode(bounded.turns[0]!.messages[0]!.text).byteLength)
      .toBeLessThanOrEqual(16 * 1024);

    const malformedFake = fakeAppServer({
      threadReadResult: {
        thread: {
          id: THREAD_ID,
          ephemeral: false,
          status: { type: 'idle' },
          turns: [{
            id: TURN_ID,
            status: 'completed',
            startedAt: null,
            completedAt: null,
            items: [{
              type: 'agentMessage',
              id: 'message_agent_12345678',
              phase: 'private_reasoning',
              text: 'do not expose',
            }],
          }],
        },
      },
    });
    await expect(readCodexConversationHistory({
      codexExecutable: CODEX_EXECUTABLE,
      codexExecutableIdentity: executableIdentity(),
      cwd: CWD,
      conversationId: 'conversation_12345678',
      providerThreadId: THREAD_ID,
    }, runtimeDependencies(malformedFake))).rejects.toMatchObject({
      code: 'CODEX_APP_SERVER_PROTOCOL_FAILED',
    });
  });

  test('archives and unarchives only the exact retained provider thread', async () => {
    for (const action of ['archive', 'unarchive', 'delete'] as const) {
      const fake = fakeAppServer();
      await expect(mutateCodexConversation({
        codexExecutable: CODEX_EXECUTABLE,
        codexExecutableIdentity: executableIdentity(),
        cwd: CWD,
        providerThreadId: THREAD_ID,
        action,
      }, runtimeDependencies(fake))).resolves.toEqual({ action });
      expect(fake.requests.find(request => request.method === `thread/${action}`)?.params)
        .toEqual({ threadId: THREAD_ID });
      expect(fake.requests.some(request => request.method === 'thread/resume')).toBe(false);
      expect(fake.requests.some(request => request.method === 'turn/start')).toBe(false);
    }
  });

  test('retries transient process-group EPERM until ESRCH confirms termination', async () => {
    let now = 0;
    let probes = 0;
    const outcomes = ['EPERM', 'EPERM', 'ESRCH'];
    expect(await confirmCodexProcessGroupTerminated(4242, 100, {
      probe: processGroupId => {
        expect(processGroupId).toBe(4242);
        const error = Object.assign(new Error('probe'), { code: outcomes[probes++] });
        throw error;
      },
      now: () => now,
      sleep: async milliseconds => { now += milliseconds; },
    })).toBe(true);
    expect(probes).toBe(3);
    expect(now).toBe(50);
  });

  test('fails closed at the deadline when process-group EPERM persists', async () => {
    let now = 0;
    let probes = 0;
    expect(await confirmCodexProcessGroupTerminated(4242, 50, {
      probe: () => {
        probes += 1;
        throw Object.assign(new Error('probe'), { code: 'EPERM' });
      },
      now: () => now,
      sleep: async milliseconds => { now += milliseconds; },
    })).toBe(false);
    expect(probes).toBe(3);
    expect(now).toBe(50);
  });

  test('fails closed when the process group remains observable through the deadline', async () => {
    let now = 0;
    let probes = 0;
    expect(await confirmCodexProcessGroupTerminated(4242, 50, {
      probe: () => { probes += 1; },
      now: () => now,
      sleep: async milliseconds => { now += milliseconds; },
    })).toBe(false);
    expect(probes).toBe(3);
    expect(now).toBe(50);
  });

  test('does not sleep past a zero process-group confirmation budget', async () => {
    let probes = 0;
    let sleeps = 0;
    expect(await confirmCodexProcessGroupTerminated(4242, 0, {
      probe: () => {
        probes += 1;
        throw Object.assign(new Error('probe'), { code: 'EPERM' });
      },
      now: () => 0,
      sleep: async () => { sleeps += 1; },
    })).toBe(false);
    expect(probes).toBe(1);
    expect(sleeps).toBe(0);
  });

  test('does not retry definitive or unknown process-group probe failures', async () => {
    for (const code of ['ESRCH', 'EACCES', undefined]) {
      let probes = 0;
      const result = await confirmCodexProcessGroupTerminated(4242, 100, {
        probe: () => {
          probes += 1;
          throw Object.assign(new Error('probe'), { code });
        },
      });
      expect(result).toBe(code === 'ESRCH');
      expect(probes).toBe(1);
    }
  });

  test('inspects the visible model catalog before advertising an exact no-turn bootstrap', async () => {
    const fake = fakeAppServer();
    const identity = executableIdentity();
    let identityAssertions = 0;
    expect(await inspectCodexAgentRuntimeCompatibility(
      { codexExecutable: CODEX_EXECUTABLE, codexExecutableIdentity: identity, cwd: CWD },
      runtimeDependencies(fake, {
        assertExecutableIdentityCurrent: candidate => {
          expect(candidate).toEqual(identity);
          identityAssertions += 1;
        },
      }),
    )).toEqual({
      models: [{
        modelId: MODEL_ID,
        providerModel: PROVIDER_MODEL,
        reasoningEffort: 'medium',
        label: 'GPT-5.6-Terra',
        isDefault: true,
      }],
    });
    expect(fake.requests.map(request => request.method)).toEqual([
      'initialize',
      'initialized',
      'model/list',
      'config/read',
      'thread/start',
      'thread/unsubscribe',
    ]);
    expect(fake.requests.find(request => request.method === 'model/list')?.params).toEqual({
      cursor: null,
      includeHidden: false,
      limit: 64,
    });
    expect(fake.requests.find(request => request.method === 'thread/start')?.params.model)
      .toBe(PROVIDER_MODEL);
    expect(fake.requests.find(request => request.method === 'thread/start')?.params.config)
      .toMatchObject({ model_reasoning_effort: 'medium' });
    expect(fake.requests.some(request => request.method === 'turn/start')).toBe(false);
    expect(fake.isExited()).toBe(true);
    expect(identityAssertions).toBe(2);

    const compatible = fakeAppServer();
    expect(await probeCodexAgentRuntimeCompatibility(
      { codexExecutable: CODEX_EXECUTABLE, cwd: CWD },
      runtimeDependencies(compatible),
    )).toBe(true);

    const incompatible = fakeAppServer({
      threadStartResult: { approvalPolicy: 'on-request' },
    });
    expect(await probeCodexAgentRuntimeCompatibility(
      { codexExecutable: CODEX_EXECUTABLE, cwd: CWD },
      runtimeDependencies(incompatible),
    )).toBe(false);
    expect(incompatible.isExited()).toBe(true);

    const effortMismatch = fakeAppServer({
      threadStartResult: { reasoningEffort: 'max' },
    });
    expect(await probeCodexAgentRuntimeCompatibility(
      { codexExecutable: CODEX_EXECUTABLE, cwd: CWD },
      runtimeDependencies(effortMismatch),
    )).toBe(false);
    expect(effortMismatch.isExited()).toBe(true);
  });

  test('drains model/list pagination with opaque cursors and preserves picker/provider identities', async () => {
    const fake = fakeAppServer({
      modelListPages: [
        {
          data: [fakeCatalogModel({
            id: 'picker-sol',
            model: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            defaultReasoningEffort: 'low',
            isDefault: false,
          })],
          nextCursor: 'opaque:first/page',
        },
        {
          data: [fakeCatalogModel()],
          nextCursor: 'not-an-offset',
        },
        {
          data: [fakeCatalogModel({
            id: 'picker-luna',
            model: 'gpt-5.6-luna',
            displayName: 'GPT-5.6-Luna',
            defaultReasoningEffort: 'high',
            isDefault: false,
          })],
          nextCursor: null,
        },
      ],
    });

    const inspection = await inspectCodexAgentRuntimeCompatibility(
      { codexExecutable: CODEX_EXECUTABLE, cwd: CWD },
      runtimeDependencies(fake),
    );

    expect(inspection?.models).toEqual([
      {
        modelId: 'picker-sol',
        providerModel: 'gpt-5.6-sol',
        reasoningEffort: 'low',
        label: 'GPT-5.6-Sol',
        isDefault: false,
      },
      {
        modelId: MODEL_ID,
        providerModel: PROVIDER_MODEL,
        reasoningEffort: 'medium',
        label: 'GPT-5.6-Terra',
        isDefault: true,
      },
      {
        modelId: 'picker-luna',
        providerModel: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        label: 'GPT-5.6-Luna',
        isDefault: false,
      },
    ]);
    expect(fake.requests
      .filter(request => request.method === 'model/list')
      .map(request => request.params.cursor)).toEqual([
      null,
      'opaque:first/page',
      'not-an-offset',
    ]);
    expect(fake.requests.find(request => request.method === 'thread/start')?.params.model)
      .toBe(PROVIDER_MODEL);
  });

  test('keeps a compatible configured effort and falls back per model when it is unsupported', async () => {
    const cases = [
      {
        configured: 'max',
        catalog: fakeCatalogModel({
          model: 'gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'max', description: 'Maximum' },
          ],
        }),
        selected: 'max',
      },
      {
        configured: 'max',
        catalog: fakeCatalogModel({
          model: 'gpt-5.5',
          displayName: 'GPT-5.5',
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'medium', description: 'Balanced' },
            { reasoningEffort: 'high', description: 'Deep' },
            { reasoningEffort: 'xhigh', description: 'Extra deep' },
          ],
        }),
        selected: 'medium',
      },
    ] as const;

    for (const testCase of cases) {
      const fake = fakeAppServer({
        modelListPages: [{ data: [testCase.catalog], nextCursor: null }],
        configReadResult: {
          config: {
            model_reasoning_effort: testCase.configured,
            mcp_servers: {},
          },
          origins: {},
          layers: [],
        },
      });

      const inspection = await inspectCodexAgentRuntimeCompatibility(
        { codexExecutable: CODEX_EXECUTABLE, cwd: CWD },
        runtimeDependencies(fake),
      );

      expect(inspection.models[0]?.reasoningEffort).toBe(testCase.selected);
      expect(fake.requests.find(request => request.method === 'thread/start')?.params.config)
        .toMatchObject({ model_reasoning_effort: testCase.selected });
    }
  });

  test('fails closed on malformed, ambiguous, duplicate, repeated, or oversized model catalogs', async () => {
    const oversized = Array.from({ length: 65 }, (_, index) => fakeCatalogModel({
      id: `picker-${index}`,
      model: `provider-${index}`,
      displayName: `Model ${index}`,
      isDefault: index === 0,
    }));
    const cases: Array<{ name: string; pages: Array<Record<string, unknown>> }> = [
      { name: 'missing data', pages: [{ nextCursor: null }] },
      { name: 'empty', pages: [{ data: [], nextCursor: null }] },
      {
        name: 'hidden entry in visible catalog',
        pages: [{ data: [fakeCatalogModel({ hidden: true })], nextCursor: null }],
      },
      {
        name: 'missing supported reasoning efforts',
        pages: [{
          data: [fakeCatalogModel({ supportedReasoningEfforts: undefined })],
          nextCursor: null,
        }],
      },
      {
        name: 'empty supported reasoning efforts',
        pages: [{ data: [fakeCatalogModel({ supportedReasoningEfforts: [] })], nextCursor: null }],
      },
      {
        name: 'default reasoning effort is not supported',
        pages: [{ data: [fakeCatalogModel({ defaultReasoningEffort: 'max' })], nextCursor: null }],
      },
      {
        name: 'unsafe reasoning effort',
        pages: [{
          data: [fakeCatalogModel({
            defaultReasoningEffort: 'medium\nsecret',
            supportedReasoningEfforts: [{
              reasoningEffort: 'medium\nsecret',
              description: 'unsafe',
            }],
          })],
          nextCursor: null,
        }],
      },
      {
        name: 'no default',
        pages: [{ data: [fakeCatalogModel({ isDefault: false })], nextCursor: null }],
      },
      {
        name: 'multiple defaults',
        pages: [{
          data: [fakeCatalogModel(), fakeCatalogModel({ id: 'picker-other', model: 'provider-other' })],
          nextCursor: null,
        }],
      },
      {
        name: 'duplicate id across pages',
        pages: [
          { data: [fakeCatalogModel({ isDefault: false })], nextCursor: 'page-2' },
          { data: [fakeCatalogModel()], nextCursor: null },
        ],
      },
      {
        name: 'repeated opaque cursor',
        pages: [
          { data: [fakeCatalogModel({ id: 'picker-a', isDefault: false })], nextCursor: 'same' },
          { data: [fakeCatalogModel({ id: 'picker-b' })], nextCursor: 'same' },
        ],
      },
      { name: 'more than 64 models', pages: [{ data: oversized, nextCursor: null }] },
    ];

    for (const testCase of cases) {
      const fake = fakeAppServer({ modelListPages: testCase.pages });
      await expect(inspectCodexAgentRuntimeCompatibility(
        { codexExecutable: CODEX_EXECUTABLE, cwd: CWD },
        runtimeDependencies(fake),
      )).rejects.toMatchObject({
        code: 'CODEX_APP_SERVER_PROTOCOL_FAILED',
      } satisfies Partial<CodexAgentRuntimeError>);
      expect(fake.requests.some(request => request.method === 'thread/start')).toBe(false);
      expect(fake.isExited()).toBe(true);
    }
  });

  test('runs one app-server turn with fixed never-approval policy and safe semantic drafts', async () => {
    const fake = fakeAppServer();
    const drafts: CodexAgentTaskEventDraft[] = [];
    const providerBindings: CodexAgentProviderIds[] = [];
    const result = await runCodexAgentTask(
      runtimeInput(
        draft => { drafts.push(draft); },
        undefined,
        ids => { providerBindings.push(ids); },
      ),
      runtimeDependencies(fake),
    );

    expect(fake.command.slice(0, 3)).toEqual([
      CODEX_EXECUTABLE,
      'app-server',
      '--strict-config',
    ]);
    expect(fake.command.slice(-2)).toEqual(['--listen', 'stdio://']);
    for (const feature of ['apps', 'plugins', 'hooks', 'computer_use', 'multi_agent']) {
      expect(fake.command).toContain(feature);
    }
    expect(fake.command).toContain('code_mode');
    expect(fake.command).not.toContain('code_mode_host');
    expect(fake.command.some(value => value.startsWith('mcp_servers'))).toBe(false);
    expect(fake.command).toContain('shell_environment_policy.inherit="none"');
    expect(fake.command).toContain(
      'shell_environment_policy.filters={"__AGENTSTOZ_NO_MATCH__"="include"}',
    );
    expect(fake.command).toContain('sandbox_workspace_write.network_access=false');
    for (const override of [
      'notify=[]',
      'analytics.enabled=false',
      'otel.log_user_prompt=false',
      'otel.exporter="none"',
      'otel.trace_exporter="none"',
      'otel.metrics_exporter="none"',
    ]) {
      expect(fake.command).toContain(override);
    }
    expect(fake.command.join(' ')).not.toContain('touch /tmp/not-executed');
    expect(fake.spawnOptions[0]).toMatchObject({
      cwd: CWD,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    expect(fake.spawnIdentities).toEqual([executableIdentity()]);
    expect(fake.requests.map(request => request.method)).toEqual([
      'initialize',
      'initialized',
      'config/read',
      'thread/start',
      'turn/start',
      'thread/unsubscribe',
    ]);
    expect(fake.requests.find(request => request.method === 'initialize')?.params.capabilities).toBeNull();
    expect(fake.requests.find(request => request.method === 'thread/start')?.params).toMatchObject({
      cwd: CWD,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      model: PROVIDER_MODEL,
      sandbox: 'workspace-write',
      ephemeral: true,
      config: {
        model_reasoning_effort: 'medium',
        mcp_servers: {
          node_repl: { enabled: false },
          'team.tools': { enabled: false },
        },
      },
    });
    expect(fake.requests.find(request => request.method === 'thread/start')?.params)
      .not.toHaveProperty('runtimeWorkspaceRoots');
    expect(fake.requests.find(request => request.method === 'turn/start')?.params).toEqual({
      threadId: THREAD_ID,
      model: PROVIDER_MODEL,
      effort: 'medium',
      input: [{
        type: 'text',
        text: runtimeInput(() => {}).prompt,
        text_elements: [],
      }],
      cwd: CWD,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });

    expect(result).toEqual({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      finalSummary: '완료했습니다. [프로젝트]/src/result.ts를 갱신했습니다.',
    });
    expect(providerBindings).toEqual([
      { threadId: THREAD_ID },
      { threadId: THREAD_ID, turnId: TURN_ID },
    ]);
    expect(drafts.map(draft => draft.type)).toEqual([
      'task.progress',
      'task.progress',
      'task.artifact.summary',
      'task.artifact.summary',
      'task.artifact.summary',
    ]);
    expect(fake.isExited()).toBe(true);
    for (const draft of drafts) assertAgentRuntimeRemoteSafe(draft);
    const exposed = JSON.stringify({ result, drafts });
    expect(exposed).not.toContain(CWD);
    expect(exposed).not.toContain('rm -rf');
    expect(exposed).not.toContain('raw output');
    expect(exposed).not.toContain('do-not-emit');
  });

  test('rejects disabled dangerous mode before executable inspection or spawn', async () => {
    const fake = fakeAppServer();
    let identityAssertions = 0;

    await expect(runCodexAgentTask({
      ...runtimeInput(() => {}),
      executionMode: 'dangerously-bypass-approvals-and-sandbox',
    }, runtimeDependencies(fake, {
      assertExecutableIdentityCurrent: () => { identityAssertions += 1; },
    }))).rejects.toMatchObject({
      code: 'CODEX_DANGEROUS_MODE_UNAVAILABLE',
      publicMessage: expect.stringContaining('OS 프로세스 격리'),
    } satisfies Partial<CodexAgentRuntimeError>);

    expect(identityAssertions).toBe(0);
    expect(fake.command).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(fake.isExited()).toBe(false);
  });

  test('maps an explicitly enabled local-development bypass to danger-full-access', async () => {
    const fake = fakeAppServer({
      threadStartResult: { sandbox: { type: 'dangerFullAccess' } },
    });
    const result = await runCodexAgentTask({
      ...runtimeInput(() => {}),
      executionMode: 'dangerously-bypass-approvals-and-sandbox',
    }, runtimeDependencies(fake, { dangerousModeEnabled: true }));

    expect(result.turnId).toBe(TURN_ID);
    expect(fake.command).toContain('sandbox_mode="danger-full-access"');
    expect(fake.command).not.toContain('sandbox_workspace_write.network_access=false');
    expect(fake.requests.find(request => request.method === 'thread/start')?.params)
      .toMatchObject({
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
        ephemeral: true,
      });
    expect(fake.requests.find(request => request.method === 'turn/start')?.params.sandboxPolicy)
      .toEqual({ type: 'dangerFullAccess' });
  });

  test('disables effective project-layer MCP servers in the same app-server before thread start', async () => {
    const fake = fakeAppServer({
      configReadResult: {
        config: {
          mcp_servers: {
            project_probe: { command: '/usr/bin/false', enabled: true },
          },
        },
        origins: {},
        layers: [{
          config: {
            mcp_servers: {
              'team.tools': { command: '/usr/bin/false', enabled: true },
            },
          },
        }],
      },
    });

    await runCodexAgentTask(
      runtimeInput(() => {}),
      runtimeDependencies(fake),
    );

    expect(fake.command.some(value => value.startsWith('mcp_servers='))).toBe(false);
    expect(fake.requests.find(request => request.method === 'config/read')?.params).toEqual({
      cwd: CWD,
      includeLayers: true,
    });
    expect(fake.requests.find(request => request.method === 'thread/start')?.params.config)
      .toEqual({
        model_reasoning_effort: 'medium',
        mcp_servers: {
          project_probe: { enabled: false },
          'team.tools': { enabled: false },
        },
      });
  });

  test('overrides an incompatible user reasoning effort with the selected model catalog default', async () => {
    const fake = fakeAppServer({
      configReadResult: {
        config: {
          model_reasoning_effort: 'max',
          mcp_servers: {},
        },
        origins: {},
        layers: [],
      },
    });

    await runCodexAgentTask(
      { ...runtimeInput(() => {}), reasoningEffort: 'medium' },
      runtimeDependencies(fake),
    );

    expect(fake.requests.find(request => request.method === 'thread/start')?.params.config)
      .toEqual({ model_reasoning_effort: 'medium', mcp_servers: {} });
    expect(fake.requests.find(request => request.method === 'turn/start')?.params)
      .toMatchObject({ model: PROVIDER_MODEL, effort: 'medium' });
  });

  test('fails closed before thread start when effective MCP config cannot be bounded', async () => {
    for (const configReadResult of [
      { config: {}, origins: {}, layers: [] },
      { config: { mcp_servers: [] }, origins: {}, layers: [] },
      { config: { mcp_servers: { 'not/a/config-key': { enabled: true } } }, origins: {}, layers: [] },
    ]) {
      const fake = fakeAppServer({ configReadResult });
      await expect(runCodexAgentTask(
        runtimeInput(() => {}),
        runtimeDependencies(fake),
      )).rejects.toMatchObject({
        code: 'CODEX_TASK_POLICY_UNVERIFIED',
      } satisfies Partial<CodexAgentRuntimeError>);
      expect(fake.requests.some(request => request.method === 'thread/start')).toBe(false);
      expect(fake.isExited()).toBe(true);
    }
  });

  test('ignores another task completion and fails closed on a server approval request', async () => {
    const fake = fakeAppServer({ approvalRequest: true });
    const drafts: CodexAgentTaskEventDraft[] = [];

    let failure: unknown;
    try {
      await runCodexAgentTask(
        runtimeInput(draft => { drafts.push(draft); }),
        runtimeDependencies(fake),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'CODEX_TASK_APPROVAL_REQUIRED',
    } satisfies Partial<CodexAgentRuntimeError>);

    expect(fake.requests.some(request => request.id === 99 && ('result' in request || 'error' in request))).toBe(false);
    expect(codexAgentTaskFailure(failure)).toEqual({
      code: 'CODEX_TASK_APPROVAL_REQUIRED',
      message: 'Codex 작업이 사용자 승인이나 응답을 요구해 안전하게 중단되었습니다.',
      retryable: false,
    });
    expect(fake.isExited()).toBe(true);
  });

  test('keeps an unknown failed turn generic without leaking provider error details', async () => {
    const fake = fakeAppServer({
      turnStatus: 'failed',
      turnErrorInfo: 'futureProviderFailureWithPrivateText',
    });
    const drafts: CodexAgentTaskEventDraft[] = [];
    const providerBindings: CodexAgentProviderIds[] = [];

    let failure: unknown;
    try {
      await runCodexAgentTask(
        runtimeInput(
          draft => { drafts.push(draft); },
          undefined,
          ids => { providerBindings.push(ids); },
        ),
        runtimeDependencies(fake),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'CODEX_TASK_FAILED' } satisfies Partial<CodexAgentRuntimeError>);
    const safeFailure = codexAgentTaskFailure(failure);
    expect(safeFailure).toEqual({
      code: 'CODEX_TASK_FAILED',
      message: 'Codex가 작업을 완료하지 못했습니다.',
      retryable: false,
    });
    expect(JSON.stringify(safeFailure)).not.toContain(CWD);
    expect(JSON.stringify(safeFailure)).not.toContain('raw details');
    expect(JSON.stringify(safeFailure)).not.toContain('futureProviderFailureWithPrivateText');
    expect(providerBindings).toEqual([
      { threadId: THREAD_ID },
      { threadId: THREAD_ID, turnId: TURN_ID },
    ]);
    expect(fake.isExited()).toBe(true);
  });

  test('treats Object prototype names as unknown provider failure discriminators', async () => {
    const prototypeNames = ['constructor', 'toString', '__proto__'] as const;
    const cases: unknown[] = [
      ...prototypeNames,
      ...prototypeNames.map(name => Object.fromEntries([[name, {}]])),
    ];

    for (const info of cases) {
      const fake = fakeAppServer({ turnStatus: 'failed', turnErrorInfo: info });
      let failure: unknown;
      try {
        await runCodexAgentTask(runtimeInput(() => {}), runtimeDependencies(fake));
      } catch (error) {
        failure = error;
      }
      expect(codexAgentTaskFailure(failure)).toEqual({
        code: 'CODEX_TASK_FAILED',
        message: 'Codex가 작업을 완료하지 못했습니다.',
        retryable: false,
      });
      expect(fake.isExited()).toBe(true);
    }
  });

  test('maps every stable provider failure discriminator to an exact safe task failure', async () => {
    const cases = [
      {
        info: 'contextWindowExceeded',
        expected: {
          code: 'CODEX_CONTEXT_WINDOW_EXCEEDED',
          message: 'Codex 컨텍스트 한도를 초과했습니다. 요청 범위를 줄이거나 작업을 나눠 다시 실행해 주세요.',
          retryable: false,
        },
      },
      {
        info: 'sessionBudgetExceeded',
        expected: {
          code: 'CODEX_SESSION_BUDGET_EXCEEDED',
          message: 'Codex 세션 작업 한도를 초과했습니다. 작업을 나눠 새 작업으로 실행해 주세요.',
          retryable: false,
        },
      },
      {
        info: 'usageLimitExceeded',
        expected: {
          code: 'CODEX_USAGE_LIMIT_EXCEEDED',
          message: 'Codex 사용량 한도에 도달했습니다. 사용량이 갱신된 뒤 다시 실행해 주세요.',
          retryable: true,
        },
      },
      {
        info: 'serverOverloaded',
        expected: {
          code: 'CODEX_SERVER_OVERLOADED',
          message: 'Codex 서버가 혼잡합니다. 잠시 후 다시 실행해 주세요.',
          retryable: true,
        },
      },
      {
        info: 'cyberPolicy',
        expected: {
          code: 'CODEX_POLICY_BLOCKED',
          message: 'Codex 정책에 의해 요청이 중단되었습니다. 요청 범위나 내용을 조정해 주세요.',
          retryable: false,
        },
      },
      {
        info: 'misalignmentPolicyViolation',
        expected: {
          code: 'CODEX_POLICY_BLOCKED',
          message: 'Codex 정책에 의해 요청이 중단되었습니다. 요청 범위나 내용을 조정해 주세요.',
          retryable: false,
        },
      },
      {
        info: 'internalServerError',
        expected: {
          code: 'CODEX_PROVIDER_INTERNAL_ERROR',
          message: 'Codex 서버 내부 오류로 작업이 중단되었습니다. 잠시 후 다시 실행해 주세요.',
          retryable: true,
        },
      },
      {
        info: 'unauthorized',
        expected: {
          code: 'CODEX_AUTH_REQUIRED',
          message: 'Codex 인증이 만료되었거나 권한이 없습니다. Codex 로그인을 확인해 주세요.',
          retryable: false,
        },
      },
      {
        info: 'badRequest',
        expected: {
          code: 'CODEX_BAD_REQUEST',
          message: 'Codex가 작업 요청을 거절했습니다. 선택한 모델과 요청 내용을 확인해 주세요.',
          retryable: false,
        },
      },
      {
        info: 'threadRollbackFailed',
        expected: {
          code: 'CODEX_THREAD_ROLLBACK_FAILED',
          message: 'Codex 작업 상태를 되돌리지 못했습니다. 새 작업으로 다시 실행해 주세요.',
          retryable: true,
        },
      },
      {
        info: 'sandboxError',
        expected: {
          code: 'CODEX_SANDBOX_ERROR',
          message: 'Codex 샌드박스 실행에 실패했습니다. 프로젝트 권한과 실행 모드를 확인해 주세요.',
          retryable: false,
        },
      },
      {
        info: 'other',
        expected: {
          code: 'CODEX_TASK_FAILED',
          message: 'Codex가 작업을 완료하지 못했습니다.',
          retryable: false,
        },
      },
      {
        info: { httpConnectionFailed: { httpStatusCode: null } },
        expected: {
          code: 'CODEX_CONNECTION_FAILED',
          message: 'Codex 서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 실행해 주세요.',
          retryable: true,
        },
      },
      {
        info: { responseStreamConnectionFailed: { httpStatusCode: 503 } },
        expected: {
          code: 'CODEX_RESPONSE_STREAM_FAILED',
          message: 'Codex 응답 연결을 시작하지 못했습니다. 잠시 후 다시 실행해 주세요.',
          retryable: true,
        },
      },
      {
        info: { responseStreamDisconnected: { httpStatusCode: 503 } },
        expected: {
          code: 'CODEX_RESPONSE_STREAM_FAILED',
          message: 'Codex 응답 연결이 작업 중 끊겼습니다. 잠시 후 다시 실행해 주세요.',
          retryable: true,
        },
      },
      {
        info: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        expected: {
          code: 'CODEX_RESPONSE_RETRY_EXHAUSTED',
          message: 'Codex 응답 재시도 한도를 초과했습니다. 잠시 후 다시 실행해 주세요.',
          retryable: true,
        },
      },
      {
        info: { activeTurnNotSteerable: { turnKind: 'review' } },
        expected: {
          code: 'CODEX_ACTIVE_TURN_NOT_STEERABLE',
          message: 'Codex가 현재 작업을 이어서 처리할 수 없습니다. 새 작업으로 다시 실행해 주세요.',
          retryable: true,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const fake = fakeAppServer({ turnStatus: 'failed', turnErrorInfo: testCase.info });
      let failure: unknown;
      try {
        await runCodexAgentTask(runtimeInput(() => {}), runtimeDependencies(fake));
      } catch (error) {
        failure = error;
      }
      const safeFailure = codexAgentTaskFailure(failure);
      expect(safeFailure).toEqual(testCase.expected);
      expect(Object.keys(safeFailure).sort()).toEqual(['code', 'message', 'retryable']);
      expect(() => assertAgentRuntimeRemoteSafe(safeFailure)).not.toThrow();
      const exposed = JSON.stringify(safeFailure);
      expect(exposed).not.toContain(CWD);
      expect(exposed).not.toContain('raw details');
      expect(exposed).not.toContain(runtimeInput(() => {}).prompt);
      expect(fake.isExited()).toBe(true);
    }
  });

  test('maps a terminal error notification through the same sanitized provider vocabulary', async () => {
    const fake = fakeAppServer({ errorNotificationInfo: 'serverOverloaded' });
    let failure: unknown;
    try {
      await runCodexAgentTask(runtimeInput(() => {}), runtimeDependencies(fake));
    } catch (error) {
      failure = error;
    }

    const safeFailure = codexAgentTaskFailure(failure);
    expect(safeFailure).toEqual({
      code: 'CODEX_SERVER_OVERLOADED',
      message: 'Codex 서버가 혼잡합니다. 잠시 후 다시 실행해 주세요.',
      retryable: true,
    });
    const exposed = JSON.stringify(safeFailure);
    expect(exposed).not.toContain(CWD);
    expect(exposed).not.toContain('raw notification details');
    expect(fake.isExited()).toBe(true);
  });

  test('uses AbortSignal to terminate the child and returns a distinct cancellation code', async () => {
    const fake = fakeAppServer({ holdOpen: true });
    const controller = new AbortController();
    const drafts: CodexAgentTaskEventDraft[] = [];
    const providerBindings: CodexAgentProviderIds[] = [];
    const running = runCodexAgentTask(
      runtimeInput(
        draft => { drafts.push(draft); },
        controller.signal,
        ids => { providerBindings.push(ids); },
      ),
      runtimeDependencies(fake),
    );
    await fake.turnStarted;
    controller.abort();

    await expect(running).rejects.toMatchObject({
      code: 'CODEX_TASK_CANCELLED',
    } satisfies Partial<CodexAgentRuntimeError>);
    expect(providerBindings).toEqual([
      { threadId: THREAD_ID },
      { threadId: THREAD_ID, turnId: TURN_ID },
    ]);
    expect(fake.killSignals).toContain('SIGTERM');
    expect(fake.isExited()).toBe(true);
  });

  test('blocks a changed executable identity before spawning Codex', async () => {
    const fake = fakeAppServer();

    let failure: unknown;
    try {
      await runCodexAgentTask(
        runtimeInput(() => {}),
        runtimeDependencies(fake, {
          assertExecutableIdentityCurrent: () => {
            throw new Error(`private changed executable at ${CODEX_EXECUTABLE}`);
          },
        }),
      );
    } catch (error) {
      failure = error;
    }

    expect(codexAgentTaskFailure(failure)).toEqual({
      code: 'CODEX_EXECUTABLE_CHANGED',
      message: '검증한 뒤 Codex 실행 파일이 변경되어 작업을 시작하지 않았습니다.',
      retryable: true,
    });
    expect(fake.command).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(fake.isExited()).toBe(false);
  });

  test('retains provider IDs before a task deadline expires and reaps the child tree', async () => {
    const fake = fakeAppServer({ holdOpen: true, closeOnEnd: false });
    const providerBindings: CodexAgentProviderIds[] = [];

    await expect(runCodexAgentTask(
      runtimeInput(
        () => {},
        undefined,
        ids => { providerBindings.push(ids); },
      ),
      runtimeDependencies(fake, {
        timeoutMs: 25,
        confirmProcessTreeTerminated: async () => fake.isExited(),
      }),
    )).rejects.toMatchObject({
      code: 'CODEX_TASK_TIMEOUT',
    } satisfies Partial<CodexAgentRuntimeError>);

    expect(providerBindings).toEqual([
      { threadId: THREAD_ID },
      { threadId: THREAD_ID, turnId: TURN_ID },
    ]);
    expect(fake.killSignals).toContain('SIGTERM');
    expect(fake.isExited()).toBe(true);
  });

  test('fails closed and stops Codex when provider IDs cannot be journaled', async () => {
    const fake = fakeAppServer({ closeOnEnd: false });
    const providerBindings: CodexAgentProviderIds[] = [];

    await expect(runCodexAgentTask(
      runtimeInput(
        () => {},
        undefined,
        ids => {
          providerBindings.push(ids);
          throw new Error(`private journal failure at ${CWD}`);
        },
      ),
      runtimeDependencies(fake, {
        confirmProcessTreeTerminated: async () => fake.isExited(),
      }),
    )).rejects.toMatchObject({
      code: 'CODEX_TASK_BINDING_FAILED',
      message: 'Codex 실행 식별자를 안전하게 기록하지 못했습니다.',
    } satisfies Partial<CodexAgentRuntimeError>);

    expect(providerBindings).toEqual([{ threadId: THREAD_ID }]);
    expect(fake.requests.some(request => request.method === 'turn/start')).toBe(false);
    expect(fake.killSignals).toContain('SIGTERM');
    expect(fake.isExited()).toBe(true);
  });

  test('rejects every unverified thread workspace or authority expansion', async () => {
    const safeSandbox = {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
    const unsafeResults: Array<Record<string, unknown>> = [
      { cwd: '/tmp/other-project' },
      { runtimeWorkspaceRoots: [CWD, '/tmp/extra-root'] },
      { approvalPolicy: 'on-request' },
      { approvalsReviewer: 'auto_review' },
      { model: 'different-provider-model' },
      { reasoningEffort: 'max' },
      { sandbox: { ...safeSandbox, networkAccess: true } },
      { sandbox: { ...safeSandbox, writableRoots: ['/tmp/extra-root'] } },
      { sandbox: { ...safeSandbox, unknownAuthority: true } },
      { thread: { id: THREAD_ID, sessionId: THREAD_ID, cwd: '/tmp/other-project', ephemeral: true } },
      { thread: { id: THREAD_ID, sessionId: THREAD_ID, cwd: CWD, ephemeral: false } },
    ];

    for (const threadStartResult of unsafeResults) {
      const fake = fakeAppServer({ threadStartResult });
      await expect(runCodexAgentTask(
        runtimeInput(() => {}),
        runtimeDependencies(fake),
      )).rejects.toMatchObject({
        code: 'CODEX_TASK_POLICY_UNVERIFIED',
      } satisfies Partial<CodexAgentRuntimeError>);
      expect(fake.isExited()).toBe(true);
    }
  });

  test('fails closed if an MCP, dynamic, delegated, or web tool appears anyway', async () => {
    for (const externalToolType of [
      'mcpToolCall',
      'dynamicToolCall',
      'collabAgentToolCall',
      'webSearch',
    ] as const) {
      const fake = fakeAppServer({ externalToolType });
      await expect(runCodexAgentTask(
        runtimeInput(() => {}),
        runtimeDependencies(fake),
      )).rejects.toMatchObject({
        code: 'CODEX_TASK_POLICY_UNVERIFIED',
      } satisfies Partial<CodexAgentRuntimeError>);
      expect(fake.isExited()).toBe(true);
    }
  });

  test('uses the injected descendant-tree boundary and settles only after cleanup', async () => {
    const fake = fakeAppServer({ closeOnEnd: false });
    const signals: string[] = [];
    const result = await runCodexAgentTask(
      runtimeInput(() => {}),
      runtimeDependencies(fake, {
        terminateProcessTree: (child, signal) => {
          signals.push(signal);
          child.kill(signal);
        },
        confirmProcessTreeTerminated: async () => fake.isExited(),
      }),
    );

    expect(result.turnId).toBe(TURN_ID);
    expect(signals).toEqual(['SIGTERM']);
    expect(fake.isExited()).toBe(true);
  });

  test('does not let a silent unsubscribe hold a completed task or shutdown', async () => {
    const fake = fakeAppServer({ ignoreUnsubscribe: true, closeOnEnd: false });
    const startedAt = Date.now();
    const result = await runCodexAgentTask(
      runtimeInput(() => {}),
      runtimeDependencies(fake, { timeoutMs: 30_000 }),
    );

    expect(result.turnId).toBe(TURN_ID);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(fake.killSignals).toContain('SIGTERM');
    expect(fake.isExited()).toBe(true);
  });

  test('escalates TERM to KILL through the injected tree boundary on cancellation', async () => {
    const fake = fakeAppServer({ holdOpen: true, closeOnEnd: false });
    const controller = new AbortController();
    const signals: string[] = [];
    const running = runCodexAgentTask(
      runtimeInput(() => {}, controller.signal),
      runtimeDependencies(fake, {
        terminateProcessTree: (child, signal) => {
          signals.push(signal);
          if (signal === 'SIGKILL') child.kill(signal);
        },
        confirmProcessTreeTerminated: async () => fake.isExited(),
      }),
    );
    await fake.turnStarted;
    controller.abort();

    await expect(running).rejects.toMatchObject({
      code: 'CODEX_TASK_CANCELLED',
    } satisfies Partial<CodexAgentRuntimeError>);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(fake.isExited()).toBe(true);
  });

  test('never reports success when process-tree termination cannot be confirmed', async () => {
    const fake = fakeAppServer({ closeOnEnd: false });
    await expect(runCodexAgentTask(
      runtimeInput(() => {}),
      runtimeDependencies(fake, {
        terminateProcessTree: () => {},
        confirmProcessTreeTerminated: async () => false,
      }),
    )).rejects.toMatchObject({
      code: 'CODEX_PROCESS_TERMINATION_UNCONFIRMED',
    } satisfies Partial<CodexAgentRuntimeError>);
    expect(fake.isExited()).toBe(false);
  });

  test('passes only an explicit environment allowlist to Codex', () => {
    expect(codexAgentChildEnv({
      HOME: '/Users/test',
      PATH: '/safe/bin',
      Path: '/must-not-override-canonical-path',
      LANG: 'ko_KR.UTF-8',
      LC_ALL: 'ko_KR.UTF-8',
      LC_TIME: 'unsafe-wildcard-value',
      XDG_CONFIG_HOME: '/safe/config',
      TMPDIR: '/safe/tmp',
      CODEX_HOME: '/safe/codex',
      OPENAI_API_KEY: 'sk-do-not-inherit-1234567890',
      GITHUB_TOKEN: 'ghp_' + 'donotinheritchild000000000000',
      SSH_AUTH_SOCK: '/private/agent.sock',
      HTTPS_PROXY: 'https://user:password@example.test',
      AGENTSTOZ_REMOTE_CAPABILITY: 'do-not-inherit',
    })).toEqual({
      HOME: '/Users/test',
      PATH: '/safe/bin',
      LANG: 'ko_KR.UTF-8',
      LC_ALL: 'ko_KR.UTF-8',
      TMPDIR: '/safe/tmp',
      CODEX_HOME: '/safe/codex',
    });
  });

  test('redacts common credentials and private keys from the safe final summary', async () => {
    const secrets = {
      openai: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      github: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz1234567890',
      supabase: 'sb_secret_abcdefghijklmnopqrstuvwxyz123456',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature123456',
      assigned: 'RUNTIME_TOKEN=plain-secret-value',
      password: 'DATABASE_PASSWORD=database-password-value',
      databaseUrl: 'postgresql://admin:database-password@example.test/private',
      credentialUrl: 'https://admin:proxy-password@example.test/private',
      fileUrl: 'file:///etc/agentstoz/private.conf',
      pem: ['-----BEGIN OPENSSH', 'PRIVATE KEY-----\nprivate-material\n-----END OPENSSH PRIVATE KEY-----'].join(' '),
    };
    const fake = fakeAppServer({ finalText: `완료 ${Object.values(secrets).join('\n')}` });
    const drafts: CodexAgentTaskEventDraft[] = [];
    const result = await runCodexAgentTask(
      runtimeInput(draft => { drafts.push(draft); }),
      runtimeDependencies(fake),
    );

    const exposed = JSON.stringify({ result, drafts });
    for (const secret of Object.values(secrets)) {
      expect(exposed).not.toContain(secret);
    }
    expect(exposed).not.toContain('private-material');
    expect(result.finalSummary).toContain('[비밀정보 삭제]');
    expect(result.finalSummary).toContain('[로컬 경로]');
    expect(drafts.map(draft => String(draft.type))).not.toContain('task.result');
  });

  test('rejects unsafe input before spawning a child', async () => {
    let spawned = false;
    const fake = fakeAppServer();
    const spawn: SpawnCodexAgentAppServer = (...args) => {
      spawned = true;
      return fake.spawn(...args);
    };

    await expect(runCodexAgentTask({
      ...runtimeInput(() => {}),
      codexExecutable: 'codex',
    }, { spawn })).rejects.toMatchObject({
      code: 'CODEX_TASK_INPUT_INVALID',
    } satisfies Partial<CodexAgentRuntimeError>);
    expect(spawned).toBe(false);

    await expect(runCodexAgentTask({
      ...runtimeInput(() => {}),
      model: '  ',
    }, { spawn })).rejects.toMatchObject({
      code: 'CODEX_TASK_INPUT_INVALID',
    } satisfies Partial<CodexAgentRuntimeError>);
    expect(spawned).toBe(false);

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(runCodexAgentTask(
      runtimeInput(() => {}, alreadyCancelled.signal),
      { spawn },
    )).rejects.toMatchObject({ code: 'CODEX_TASK_CANCELLED' } satisfies Partial<CodexAgentRuntimeError>);
    expect(spawned).toBe(false);
  });
});
