import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRuntimeHttpError } from '../src/agentRuntimeHttp';
import { CodexAgentRuntimeError } from '../src/codexAgentRuntime';
import {
  CODEX_RUNTIME_MACOS_IDENTIFIER,
  CODEX_RUNTIME_MACOS_TEAM_ID,
  codexRuntimeExecutableRevision,
  type CodexRuntimeExecutableIdentity,
} from '../src/codexRuntimeExecutable';
import { AGENT_RUNTIME_PROTOCOL_VERSION, type AgentTaskStartRequest } from '../src/agentRuntimeProtocol';
import {
  AgentRuntimeService,
  type AcquireAgentRuntimeWorkspaceLease,
  type AgentRuntimeResolvedRuntime,
  type ResolveAgentRuntimeOptions,
  type RunCodexAgentRuntimeTask,
} from '../src/agentRuntimeService';
import {
  AGENT_RUNTIME_MAX_EVENTS_PER_TASK,
  openAgentRuntimeTaskJournal,
  type AgentRuntimeTaskJournal,
  type CreateAgentRuntimeTaskInput,
} from '../src/agentRuntimeTaskJournal';

const journals: AgentRuntimeTaskJournal[] = [];
const services: AgentRuntimeService[] = [];
const roots: string[] = [];
const TEST_MODEL_ID = 'gpt-5.6-sol';

function executableIdentity(path: string): CodexRuntimeExecutableIdentity {
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

function resolvedRuntime(
  executable = '/opt/agentstoz/bin/codex',
  modelId = TEST_MODEL_ID,
  providerModel = TEST_MODEL_ID,
  reasoningEffort = 'medium',
): AgentRuntimeResolvedRuntime {
  return {
    executable,
    executableIdentity: executableIdentity(executable),
    models: [{
      modelId,
      providerModel,
      reasoningEffort,
      label: 'GPT-5.6-Sol',
      isDefault: true,
    }],
  };
}

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.shutdown()));
  for (const journal of journals.splice(0).reverse()) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openJournal(path = ':memory:'): AgentRuntimeTaskJournal {
  const journal = openAgentRuntimeTaskJournal(path);
  journals.push(journal);
  return journal;
}

function request(
  suffix: string,
  targetId = `target_${suffix}`,
  adapterId: AgentTaskStartRequest['adapterId'] = 'codex',
): AgentTaskStartRequest {
  return {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    requestId: `request_${suffix}`,
    targetId,
    adapterId,
    modelId: TEST_MODEL_ID,
    executionMode: 'workspace-write',
    prompt: `작업 ${suffix}를 실행하고 결과를 요약해 주세요.`,
  };
}

function persistedIntent(suffix: string): CreateAgentRuntimeTaskInput {
  return {
    ...request(suffix),
    projectLabel: `프로젝트 ${suffix}`,
  };
}

function resolvedTarget(targetId: string) {
  return {
    targetId,
    projectLabel: `프로젝트 ${targetId.slice(-8)}`,
    cwd: `/tmp/agent-runtime-projects/${targetId}`,
  };
}

function track(service: AgentRuntimeService): AgentRuntimeService {
  services.push(service);
  return service;
}

function service(input: {
  journal?: AgentRuntimeTaskJournal;
  runCodex?: RunCodexAgentRuntimeTask;
  resolveTarget?: (targetId: string) => ReturnType<typeof resolvedTarget> | Promise<ReturnType<typeof resolvedTarget>>;
  resolveRuntime?: (
    adapterId: AgentTaskStartRequest['adapterId'],
    options?: Readonly<ResolveAgentRuntimeOptions>,
  ) => AgentRuntimeResolvedRuntime | null | Promise<AgentRuntimeResolvedRuntime | null>;
  acquireWorkspaceLease?: AcquireAgentRuntimeWorkspaceLease;
  managedExecutionEnabled?: boolean;
  dangerousModeEnabled?: boolean;
  cancelWaitMs?: number;
  resolutionTimeoutMs?: number;
  shutdownWaitMs?: number;
} = {}): { service: AgentRuntimeService; journal: AgentRuntimeTaskJournal } {
  const journal = input.journal ?? openJournal();
  return {
    journal,
    service: track(new AgentRuntimeService({
      journal,
      resolveTarget: input.resolveTarget ?? resolvedTarget,
      resolveRuntime: input.resolveRuntime ?? (() => resolvedRuntime()),
      acquireWorkspaceLease: input.acquireWorkspaceLease ?? (() => ({ release: () => true })),
      managedExecutionEnabled: input.managedExecutionEnabled ?? true,
      dangerousModeEnabled: input.dangerousModeEnabled,
      runCodex: input.runCodex,
      cancelWaitMs: input.cancelWaitMs,
      resolutionTimeoutMs: input.resolutionTimeoutMs,
      shutdownWaitMs: input.shutdownWaitMs,
    })),
  };
}

async function eventually(predicate: () => boolean, message = 'condition was not reached'): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

async function eventuallyAsync(
  predicate: () => Promise<boolean>,
  message = 'async condition was not reached',
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

function expectHttpCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AgentRuntimeHttpError);
  expect((error as AgentRuntimeHttpError).code).toBe(code);
}

function abortableHoldingRunner(calls: Parameters<RunCodexAgentRuntimeTask>[0][] = []): RunCodexAgentRuntimeTask {
  return input => {
    calls.push(input);
    return new Promise((_, reject) => {
      const cancel = () => reject(new Error('fake runner stopped'));
      if (input.signal?.aborted) cancel();
      else input.signal?.addEventListener('abort', cancel, { once: true });
    });
  };
}

describe('AgentRuntimeService orchestration', () => {
  test('reconciles interrupted tasks and prunes only after recovery during construction', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-service-'));
    roots.push(root);
    const path = join(root, 'runtime.sqlite');
    const before = openJournal(path);
    const interrupted = before.createOrGetTask(persistedIntent('restart01')).task;
    before.appendEvent(interrupted.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    before.close();

    const after = openJournal(path);
    const order: string[] = [];
    const reconcile = after.reconcileInterruptedTasks.bind(after);
    const prune = after.pruneTerminalTasks.bind(after);
    after.reconcileInterruptedTasks = () => {
      order.push('reconcile');
      return reconcile();
    };
    after.pruneTerminalTasks = keep => {
      order.push('prune');
      return prune(keep);
    };

    service({ journal: after });
    expect(order).toEqual(['reconcile', 'prune']);
    expect(after.getTask(interrupted.taskId)?.status).toBe('failed');
    expect(after.readEvents(interrupted.taskId, 0).at(-1)).toMatchObject({
      type: 'task.failed',
      payload: { code: 'RUNTIME_RESTARTED', retryable: true },
    });
  });

  test('recovers a durable cancellation intent and keeps the same cancel request retry idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-service-cancel-recovery-'));
    roots.push(root);
    const path = join(root, 'runtime.sqlite');
    const cancelRequest = {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'cancel_restart_retry_12345678',
    } as const;
    const before = openJournal(path);
    const interrupted = before.createOrGetTask(persistedIntent('cancelrestart')).task;
    before.appendEvent(interrupted.taskId, {
      type: 'task.started',
      payload: { adapterId: 'codex' },
    });
    expect(before.recordCancellationIntent(interrupted.taskId, cancelRequest.requestId))
      .toEqual({ duplicate: false });
    before.close();

    const after = openJournal(path);
    const runtime = service({ journal: after }).service;
    expect(after.getTask(interrupted.taskId)).toMatchObject({ status: 'cancelled', lastSeq: 3 });
    const recoveredEvents = after.readEvents(interrupted.taskId, 0);
    expect(recoveredEvents.filter(event => (
      ['task.result', 'task.failed', 'task.cancelled'].includes(event.type)
    ))).toHaveLength(1);
    expect(recoveredEvents.at(-1)).toMatchObject({
      type: 'task.cancelled',
      payload: { reason: expect.stringContaining('취소 의도') },
    });

    const retried = await runtime.cancelTask(interrupted.taskId, cancelRequest);
    expect(retried.task).toMatchObject({ status: 'cancelled', lastSeq: 3 });
    expect(after.readEvents(interrupted.taskId, 0)).toEqual(recoveredEvents);
    expect(after.reconcileInterruptedTasks()).toBe(0);
  });

  test('reports every built-in while probing only the implemented Codex adapter live', async () => {
    const probed: string[] = [];
    let probe: 'available' | 'unavailable' | 'unknown' = 'available';
    const runtime = service({
      resolveRuntime: adapterId => {
        probed.push(adapterId);
        if (probe === 'unknown') throw new Error('probe detail must stay private');
        return probe === 'available' ? resolvedRuntime() : null;
      },
    }).service;

    const available = await runtime.capabilities();
    expect(available.adapters.map(adapter => [adapter.adapterId, adapter.availability])).toEqual([
      ['codex', 'available'],
      ['claude', 'unavailable'],
      ['hermes', 'unavailable'],
      ['agy', 'unavailable'],
    ]);
    expect(available.adapters.find(adapter => adapter.adapterId === 'codex')?.features).toEqual({
      structuredProgress: true,
      questions: false,
      approvals: false,
      cancellation: true,
    });
    expect(available.adapters.find(adapter => adapter.adapterId === 'codex')?.models).toEqual([{
      modelId: TEST_MODEL_ID,
      label: 'GPT-5.6-Sol',
      isDefault: true,
    }]);
    const publicCapabilities = JSON.stringify(available);
    expect(publicCapabilities).not.toContain('/opt/agentstoz/bin/codex');
    expect(publicCapabilities).not.toContain('sha256');
    expect(publicCapabilities).not.toContain('executableIdentity');
    expect(available.adapters.find(adapter => adapter.adapterId === 'claude')?.features).toEqual({
      structuredProgress: false,
      questions: false,
      approvals: false,
      cancellation: false,
    });
    expect(available.limits).toEqual({ maxPromptBytes: 32 * 1024, maxConcurrentTasks: 4 });
    expect(probed).toEqual(['codex']);

    probe = 'unavailable';
    expect((await runtime.capabilities()).adapters.find(adapter => adapter.adapterId === 'codex')?.availability)
      .toBe('unavailable');
    probe = 'unknown';
    expect((await runtime.capabilities()).adapters.find(adapter => adapter.adapterId === 'codex')?.availability)
      .toBe('unknown');
    expect(probed).toEqual(['codex', 'codex', 'codex']);
  });

  test('fails closed before capability probing or start authority when managed execution is disabled', async () => {
    let targetResolutions = 0;
    let leaseAcquisitions = 0;
    let runtimeProbes = 0;
    let runnerCalls = 0;
    const { service: runtime, journal } = service({
      managedExecutionEnabled: false,
      resolveTarget: targetId => {
        targetResolutions += 1;
        return resolvedTarget(targetId);
      },
      acquireWorkspaceLease: () => {
        leaseAcquisitions += 1;
        return { release: () => true };
      },
      resolveRuntime: () => {
        runtimeProbes += 1;
        return resolvedRuntime();
      },
      runCodex: async () => {
        runnerCalls += 1;
        throw new Error('disabled managed execution must not reach the adapter');
      },
    });

    const capabilities = await runtime.capabilities();
    expect(capabilities.adapters.find(adapter => adapter.adapterId === 'codex')).toMatchObject({
      availability: 'unavailable',
      models: [],
    });
    expect(runtimeProbes).toBe(0);

    try {
      await runtime.startTask(request('containment_gate_01'));
      throw new Error('expected containment gate rejection');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_CONTAINMENT_UNAVAILABLE');
    }
    expect({ targetResolutions, leaseAcquisitions, runtimeProbes, runnerCalls }).toEqual({
      targetResolutions: 0,
      leaseAcquisitions: 0,
      runtimeProbes: 0,
      runnerCalls: 0,
    });
    expect(journal.listTasks()).toEqual([]);

    const duplicateRequest = request('containment_duplicate_01');
    const existing = journal.createOrGetTask({
      ...duplicateRequest,
      projectLabel: '기존 격리 대기 작업',
    }).task;
    journal.appendEvent(existing.taskId, {
      type: 'task.failed',
      payload: {
        code: 'AGENT_RUNTIME_CONTAINMENT_UNAVAILABLE',
        message: '격리 안정성 게이트로 중지되었습니다.',
        retryable: false,
      },
    });
    await expect(runtime.startTask(duplicateRequest)).resolves.toMatchObject({
      duplicate: true,
      task: { taskId: existing.taskId, status: 'failed' },
    });
    expect({ targetResolutions, leaseAcquisitions, runtimeProbes, runnerCalls }).toEqual({
      targetResolutions: 0,
      leaseAcquisitions: 0,
      runtimeProbes: 0,
      runnerCalls: 0,
    });
  });

  test('persists accepted and started before running Codex and never duplicates its terminal event', async () => {
    const journal = openJournal();
    let durableAtRun: string[] = [];
    const runCodex: RunCodexAgentRuntimeTask = async input => {
      durableAtRun = journal.readEvents(input.taskId, 0).map(event => event.type);
      expect(journal.getTask(input.taskId)?.status).toBe('running');
      expect(input.model).toBe(TEST_MODEL_ID);
      expect(input.reasoningEffort).toBe('medium');
      expect(input.codexExecutableIdentity).toEqual(executableIdentity(input.codexExecutable));
      await input.emit({
        type: 'task.progress',
        payload: { summary: '검증하고 있습니다.', phase: 'verify' },
      });
      return {
        threadId: 'provider_thread_12345678',
        turnId: 'provider_turn_12345678',
        finalSummary: '검증을 완료했습니다.',
      };
    };
    const runtime = service({ journal, runCodex }).service;
    const started = await runtime.startTask(request('durable01'));
    expect(started).toMatchObject({ duplicate: false, task: { status: 'accepted', lastSeq: 1 } });

    await eventually(() => journal.getTask(started.task.taskId)?.status === 'succeeded');
    expect(durableAtRun).toEqual(['task.accepted', 'task.started']);
    const events = journal.readEvents(started.task.taskId, 0);
    expect(events.map(event => event.type)).toEqual([
      'task.accepted', 'task.started', 'task.progress', 'task.result',
    ]);
    expect(events.filter(event => event.type === 'task.result')).toHaveLength(1);
    expect(journal.getTaskExecution(started.task.taskId)).toMatchObject({
      threadId: 'provider_thread_12345678',
      turnId: 'provider_turn_12345678',
    });

    const listed = runtime.listTasks();
    expect(listed).toEqual({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      tasks: [journal.getTask(started.task.taskId)!],
    });
    expect(runtime.readEvents(started.task.taskId, 2)).toMatchObject({
      taskId: started.task.taskId,
      after: 2,
      nextCursor: 4,
      events: [{ seq: 3 }, { seq: 4 }],
    });
    expect(() => runtime.readEvents(started.task.taskId, 5)).toThrow(AgentRuntimeHttpError);
  });

  test('does not publish terminal success or release a target before runner cleanup settles', async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let calls = 0;
    const runCodex: RunCodexAgentRuntimeTask = async () => {
      calls += 1;
      if (calls === 1) await cleanup;
      return {
        threadId: `provider_thread_cleanup_${calls}`,
        turnId: `provider_turn_cleanup_${calls}`,
        finalSummary: '정리를 마친 뒤 완료했습니다.',
      };
    };
    const { service: runtime, journal } = service({ runCodex });
    const firstRequest = request('cleanup01', 'target_cleanup01');
    const first = await runtime.startTask(firstRequest);
    await eventually(() => journal.getTask(first.task.taskId)?.status === 'running');
    expect(journal.getTask(first.task.taskId)?.status).toBe('running');

    try {
      await runtime.startTask(request('cleanup02', firstRequest.targetId));
      throw new Error('expected the target to remain owned until cleanup');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_TARGET_BUSY');
    }

    releaseCleanup();
    await eventually(() => journal.getTask(first.task.taskId)?.status === 'succeeded');
    const second = await runtime.startTask(request('cleanup02', firstRequest.targetId));
    await eventually(() => journal.getTask(second.task.taskId)?.status === 'succeeded');
    expect(calls).toBe(2);
  });

  test('holds the common workspace lease through process settlement and durable terminal publication', async () => {
    const journal = openJournal();
    const order: string[] = [];
    const append = journal.appendEvent.bind(journal);
    journal.appendEvent = (taskId, draft) => {
      const event = append(taskId, draft);
      if (draft.type === 'task.result') order.push('terminal-durable');
      return event;
    };
    let settleRunner!: () => void;
    let releaseCalls = 0;
    const runtime = service({
      journal,
      resolveTarget: targetId => {
        order.push('target-resolved');
        return resolvedTarget(targetId);
      },
      acquireWorkspaceLease: target => {
        order.push('lease-acquired');
        expect(target).toEqual(resolvedTarget(target.targetId));
        return {
          release: () => {
            releaseCalls += 1;
            order.push('lease-released');
            const terminal = journal.listTasks()[0];
            expect(terminal?.status).toBe('succeeded');
            expect(journal.readEvents(terminal!.taskId, 0).at(-1)?.type).toBe('task.result');
            return true;
          },
        };
      },
      resolveRuntime: () => {
        order.push('runtime-resolved');
        return resolvedRuntime();
      },
      runCodex: async () => {
        order.push('runner-started');
        await new Promise<void>(resolve => { settleRunner = resolve; });
        order.push('process-tree-settled');
        return {
          threadId: 'provider_thread_lease_12345678',
          turnId: 'provider_turn_lease_12345678',
          finalSummary: '잠금 생명주기를 검증했습니다.',
        };
      },
    }).service;

    const started = await runtime.startTask(request('lease_lifecycle_01'));
    await eventually(() => journal.getTask(started.task.taskId)?.status === 'running');
    expect(releaseCalls).toBe(0);
    expect(order.slice(0, 4)).toEqual([
      'target-resolved', 'lease-acquired', 'runtime-resolved', 'runner-started',
    ]);

    settleRunner();
    await eventually(() => releaseCalls === 1);
    expect(order.slice(-3)).toEqual([
      'process-tree-settled', 'terminal-durable', 'lease-released',
    ]);
  });

  test('revalidates the lease-bound target after runtime probing and again immediately before spawn', async () => {
    const order: string[] = [];
    let revalidations = 0;
    let runnerCalls = 0;
    let releaseCalls = 0;
    const { service: runtime, journal } = service({
      resolveTarget: targetId => {
        order.push('target-resolved');
        return resolvedTarget(targetId);
      },
      acquireWorkspaceLease: () => {
        order.push('lease-acquired');
        return {
          revalidate: () => {
            revalidations += 1;
            order.push(`target-revalidated-${revalidations}`);
            return revalidations === 1;
          },
          release: () => {
            releaseCalls += 1;
            order.push('lease-released');
            return true;
          },
        };
      },
      resolveRuntime: () => {
        order.push('runtime-resolved');
        return resolvedRuntime();
      },
      runCodex: async () => {
        runnerCalls += 1;
        order.push('runner-started');
        return {
          threadId: 'provider_thread_must_not_run_12345678',
          turnId: 'provider_turn_must_not_run_12345678',
          finalSummary: '실행되면 안 됩니다.',
        };
      },
    });

    const started = await runtime.startTask(request('lease_revalidate_01'));
    await eventually(() => journal.getTask(started.task.taskId)?.status === 'failed');
    expect(order.slice(0, 5)).toEqual([
      'target-resolved',
      'lease-acquired',
      'runtime-resolved',
      'target-revalidated-1',
      'target-revalidated-2',
    ]);
    expect(runnerCalls).toBe(0);
    expect(releaseCalls).toBe(1);
    expect(journal.readEvents(started.task.taskId, 0).map(event => event.type)).toEqual([
      'task.accepted',
      'task.failed',
    ]);
  });

  test('maps a proven busy common workspace lease to 409 before runtime probing or acceptance', async () => {
    let runtimeProbes = 0;
    const { service: runtime, journal } = service({
      acquireWorkspaceLease: () => null,
      resolveRuntime: () => {
        runtimeProbes += 1;
        return resolvedRuntime();
      },
    });

    try {
      await runtime.startTask(request('lease_busy_01'));
      throw new Error('expected the common workspace lease to be busy');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_TARGET_BUSY');
      expect((error as AgentRuntimeHttpError).status).toBe(409);
    }
    expect(runtimeProbes).toBe(0);
    expect(journal.listTasks()).toEqual([]);
  });

  test('releases a lease exactly once when acquisition resolves after the start timeout', async () => {
    let resolveLateAcquisition!: (lease: { release(): boolean }) => void;
    let acquisitions = 0;
    let lateReleaseCalls = 0;
    let ordinaryReleaseCalls = 0;
    const { service: runtime, journal } = service({
      resolutionTimeoutMs: 5,
      acquireWorkspaceLease: () => {
        acquisitions += 1;
        if (acquisitions === 1) {
          return new Promise(resolve => { resolveLateAcquisition = resolve; });
        }
        return {
          release: () => {
            ordinaryReleaseCalls += 1;
            return true;
          },
        };
      },
      runCodex: async () => ({
        threadId: 'provider_thread_late_lease_12345678',
        turnId: 'provider_turn_late_lease_12345678',
        finalSummary: '후속 작업 완료',
      }),
    });

    try {
      await runtime.startTask(request('lease_timeout_late_01'));
      throw new Error('expected lease acquisition timeout');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_TARGET_STATUS_UNKNOWN');
    }
    expect((await runtime.capabilities()).adapters.find(adapter => adapter.adapterId === 'codex')?.availability)
      .toBe('unknown');

    resolveLateAcquisition({
      release: () => {
        lateReleaseCalls += 1;
        return true;
      },
    });
    await eventually(() => lateReleaseCalls === 1);
    await eventuallyAsync(async () => (
      (await runtime.capabilities())
        .adapters.find(adapter => adapter.adapterId === 'codex')?.availability === 'available'
    ));

    const next = await runtime.startTask(request('lease_timeout_late_02'));
    await eventually(() => journal.getTask(next.task.taskId)?.status === 'succeeded');
    await eventually(() => ordinaryReleaseCalls === 1);
    expect(acquisitions).toBe(2);
    expect(lateReleaseCalls).toBe(1);
  });

  test('retains late lease ownership when post-timeout release returns false or throws', async () => {
    for (const releaseMode of ['false', 'throw'] as const) {
      let resolveLateAcquisition!: (lease: { release(): boolean }) => void;
      let acquisitions = 0;
      let releaseCalls = 0;
      const runtime = service({
        resolutionTimeoutMs: 5,
        acquireWorkspaceLease: () => {
          acquisitions += 1;
          return new Promise(resolve => { resolveLateAcquisition = resolve; });
        },
      }).service;

      try {
        await runtime.startTask(request(`lease_late_${releaseMode}_01`));
        throw new Error('expected lease acquisition timeout');
      } catch (error) {
        expectHttpCode(error, 'AGENT_RUNTIME_TARGET_STATUS_UNKNOWN');
      }
      resolveLateAcquisition({
        release: () => {
          releaseCalls += 1;
          if (releaseMode === 'throw') throw new Error('private late release failure');
          return false;
        },
      });
      await eventually(() => releaseCalls === 1);

      try {
        await runtime.startTask(request(`lease_late_${releaseMode}_02`));
        throw new Error('expected fail-closed degraded runtime');
      } catch (error) {
        expectHttpCode(error, 'AGENT_RUNTIME_DEGRADED');
      }
      expect(acquisitions).toBe(1);
      expect(releaseCalls).toBe(1);
      await expect(runtime.shutdown()).rejects.toThrow('AGENT_RUNTIME_SHUTDOWN_INCOMPLETE');
    }
  });

  test('releases a common workspace lease when pre-start runtime validation fails', async () => {
    let releaseCalls = 0;
    const { service: runtime, journal } = service({
      acquireWorkspaceLease: () => ({
        release: () => {
          releaseCalls += 1;
          return true;
        },
      }),
      resolveRuntime: () => null,
    });

    try {
      await runtime.startTask(request('lease_prestart_01'));
      throw new Error('expected unavailable executable');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_EXECUTABLE_UNAVAILABLE');
    }
    expect(releaseCalls).toBe(1);
    expect(journal.listTasks()).toEqual([]);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  test('fails closed when a pre-start common workspace lease release is uncertain', async () => {
    let acquisitions = 0;
    const { service: runtime, journal } = service({
      acquireWorkspaceLease: () => {
        acquisitions += 1;
        return {
          release: () => {
            throw new Error('private lock IO detail');
          },
        };
      },
      resolveRuntime: () => null,
    });

    try {
      await runtime.startTask(request('lease_prestart_fail_01'));
      throw new Error('expected uncertain release failure');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_TARGET_STATUS_UNKNOWN');
      expect((error as AgentRuntimeHttpError).publicMessage).not.toContain('private');
    }
    expect(journal.listTasks()).toEqual([]);
    try {
      await runtime.startTask(request('lease_prestart_fail_02'));
      throw new Error('expected degraded runtime');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_DEGRADED');
    }
    expect(acquisitions).toBe(1);
    await expect(runtime.shutdown()).rejects.toThrow('AGENT_RUNTIME_SHUTDOWN_INCOMPLETE');
  });

  test('fences distinct registered ids that resolve to the same canonical worktree', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    const sharedCwd = '/tmp/agent-runtime-projects/shared-canonical-worktree';
    const runtime = service({
      runCodex: abortableHoldingRunner(runnerCalls),
      resolveTarget: targetId => ({
        ...resolvedTarget(targetId),
        cwd: sharedCwd,
      }),
    }).service;

    await runtime.startTask(request('alias001', 'target_alias_00000001'));
    await eventually(() => runnerCalls.length === 1);
    try {
      await runtime.startTask(request('alias002', 'target_alias_00000002'));
      throw new Error('expected canonical worktree busy');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_TARGET_BUSY');
    }
    expect(runnerCalls).toHaveLength(1);
    await runtime.shutdown();
  });

  test('fences a canonical child directory while its ancestor has an active writer', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    const rootId = 'target_overlap_root_0001';
    const childId = 'target_overlap_child_001';
    const rootCwd = '/tmp/agent-runtime-projects/overlap-root-child/repo';
    const childCwd = `${rootCwd}/packages/app`;
    const runtime = service({
      runCodex: abortableHoldingRunner(runnerCalls),
      resolveTarget: targetId => ({
        ...resolvedTarget(targetId),
        cwd: targetId === rootId ? rootCwd : childCwd,
      }),
    }).service;

    await runtime.startTask(request('overlap_root_01', rootId));
    await eventually(() => runnerCalls.length === 1);
    try {
      await runtime.startTask(request('overlap_child_1', childId));
      throw new Error('expected descendant workspace busy');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_TARGET_BUSY');
    }
    expect(runnerCalls.map(call => call.cwd)).toEqual([rootCwd]);
    await runtime.shutdown();
  });

  test('fences a canonical ancestor directory while its child has an active writer', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    const rootId = 'target_overlap_root_0002';
    const childId = 'target_overlap_child_002';
    const rootCwd = '/tmp/agent-runtime-projects/overlap-child-root/repo';
    const childCwd = `${rootCwd}/packages/app`;
    const runtime = service({
      runCodex: abortableHoldingRunner(runnerCalls),
      resolveTarget: targetId => ({
        ...resolvedTarget(targetId),
        cwd: targetId === childId ? childCwd : rootCwd,
      }),
    }).service;

    await runtime.startTask(request('overlap_child_2', childId));
    await eventually(() => runnerCalls.length === 1);
    try {
      await runtime.startTask(request('overlap_root_02', rootId));
      throw new Error('expected ancestor workspace busy');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_TARGET_BUSY');
    }
    expect(runnerCalls.map(call => call.cwd)).toEqual([childCwd]);
    await runtime.shutdown();
  });

  test('does not treat a canonical path string prefix as an overlapping directory', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    const firstId = 'target_prefix_trap_000001';
    const secondId = 'target_prefix_trap_000002';
    const firstCwd = '/tmp/agent-runtime-projects/prefix-trap/repo/a';
    const secondCwd = '/tmp/agent-runtime-projects/prefix-trap/repo/ab';
    const runtime = service({
      runCodex: abortableHoldingRunner(runnerCalls),
      resolveTarget: targetId => ({
        ...resolvedTarget(targetId),
        cwd: targetId === firstId ? firstCwd : secondCwd,
      }),
    }).service;

    await runtime.startTask(request('prefix_trap_01', firstId));
    await runtime.startTask(request('prefix_trap_02', secondId));
    await eventually(() => runnerCalls.length === 2);
    expect(runnerCalls.map(call => call.cwd)).toEqual([firstCwd, secondCwd]);
    await runtime.shutdown();
  });

  test('allows active writers in distinct canonical sibling directories', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    const firstId = 'target_sibling_00000001';
    const secondId = 'target_sibling_00000002';
    const firstCwd = '/tmp/agent-runtime-projects/siblings/repo/packages/a';
    const secondCwd = '/tmp/agent-runtime-projects/siblings/repo/packages/b';
    const runtime = service({
      runCodex: abortableHoldingRunner(runnerCalls),
      resolveTarget: targetId => ({
        ...resolvedTarget(targetId),
        cwd: targetId === firstId ? firstCwd : secondCwd,
      }),
    }).service;

    await runtime.startTask(request('sibling_path_01', firstId));
    await runtime.startTask(request('sibling_path_02', secondId));
    await eventually(() => runnerCalls.length === 2);
    expect(runnerCalls.map(call => call.cwd)).toEqual([firstCwd, secondCwd]);
    await runtime.shutdown();
  });

  test('rejects new dangerous-mode work before authority acquisition while preserving exact duplicates', async () => {
    const journal = openJournal();
    const createOrGetTask = journal.createOrGetTask.bind(journal);
    let journalCreates = 0;
    let targetResolutions = 0;
    let leaseAcquisitions = 0;
    let runtimeProbes = 0;
    let runnerCalls = 0;
    journal.createOrGetTask = input => {
      journalCreates += 1;
      return createOrGetTask(input);
    };
    const runtime = service({
      journal,
      resolveTarget: targetId => {
        targetResolutions += 1;
        return resolvedTarget(targetId);
      },
      acquireWorkspaceLease: () => {
        leaseAcquisitions += 1;
        return { release: () => true };
      },
      resolveRuntime: () => {
        runtimeProbes += 1;
        return resolvedRuntime();
      },
      runCodex: async () => {
        runnerCalls += 1;
        throw new Error('disabled dangerous mode must not reach the adapter');
      },
    }).service;
    const dangerousRequest = {
      ...request('danger_new_01'),
      executionMode: 'dangerously-bypass-approvals-and-sandbox' as const,
    };

    try {
      await runtime.startTask(dangerousRequest);
      throw new Error('expected dangerous mode to be unavailable');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_DANGEROUS_MODE_UNAVAILABLE');
    }
    expect({
      targetResolutions,
      leaseAcquisitions,
      runtimeProbes,
      runnerCalls,
      journalCreates,
    }).toEqual({
      targetResolutions: 0,
      leaseAcquisitions: 0,
      runtimeProbes: 0,
      runnerCalls: 0,
      journalCreates: 0,
    });
    expect(journal.listTasks()).toEqual([]);

    const duplicateRequest = {
      ...request('danger_duplicate_01'),
      executionMode: 'dangerously-bypass-approvals-and-sandbox' as const,
    };
    const existing = createOrGetTask({
      ...duplicateRequest,
      projectLabel: '기존 전체 접근 작업',
    }).task;
    journal.appendEvent(existing.taskId, {
      type: 'task.failed',
      payload: {
        code: 'AGENT_RUNTIME_DANGEROUS_MODE_UNAVAILABLE',
        message: '현재 비활성화된 전체 접근 작업입니다.',
        retryable: false,
      },
    });
    const eventsBeforeDuplicate = journal.readEvents(existing.taskId, 0);

    const duplicate = await runtime.startTask(duplicateRequest);
    expect(duplicate).toMatchObject({
      duplicate: true,
      task: {
        taskId: existing.taskId,
        status: 'failed',
        executionMode: 'dangerously-bypass-approvals-and-sandbox',
      },
    });
    expect(journal.readEvents(existing.taskId, 0)).toEqual(eventsBeforeDuplicate);
    expect({
      targetResolutions,
      leaseAcquisitions,
      runtimeProbes,
      runnerCalls,
      journalCreates,
    }).toEqual({
      targetResolutions: 0,
      leaseAcquisitions: 0,
      runtimeProbes: 0,
      runnerCalls: 0,
      journalCreates: 0,
    });
  });

  test('allows an explicitly enabled local-development dangerous task', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    const runtime = service({
      dangerousModeEnabled: true,
      runCodex: async input => {
        runnerCalls.push(input);
        return {
          threadId: 'provider_thread_dev_danger_12345678',
          turnId: 'provider_turn_dev_danger_12345678',
          finalSummary: '개발 전체 접근 작업을 완료했습니다.',
        };
      },
    }).service;
    const started = await runtime.startTask({
      ...request('danger_enabled_01'),
      executionMode: 'dangerously-bypass-approvals-and-sandbox',
    });

    await eventually(() => runtime.listTasks().tasks[0]?.status === 'succeeded');
    expect(started.task.executionMode).toBe('dangerously-bypass-approvals-and-sandbox');
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]?.executionMode).toBe('dangerously-bypass-approvals-and-sandbox');
  });

  test('returns a full-intent requestId duplicate without resolving paths or probing again', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    let targetResolutions = 0;
    let executableProbes = 0;
    let leaseAcquisitions = 0;
    const runtime = service({
      runCodex: abortableHoldingRunner(runnerCalls),
      resolveTarget: targetId => {
        targetResolutions += 1;
        return resolvedTarget(targetId);
      },
      resolveRuntime: () => {
        executableProbes += 1;
        return resolvedRuntime();
      },
      acquireWorkspaceLease: () => {
        leaseAcquisitions += 1;
        return { release: () => true };
      },
    }).service;
    const intent = request('duplicate1');
    const first = await runtime.startTask(intent);
    await eventually(() => runnerCalls.length === 1);

    const duplicate = await runtime.startTask(intent);
    expect(duplicate).toMatchObject({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      duplicate: true,
      task: {
        taskId: first.task.taskId,
        targetId: first.task.targetId,
        adapterId: 'codex',
        status: 'running',
        lastSeq: 2,
      },
    });
    expect(targetResolutions).toBe(1);
    expect(executableProbes).toBe(1);
    expect(leaseAcquisitions).toBe(1);
    expect(runnerCalls).toHaveLength(1);

    try {
      await runtime.startTask({ ...intent, prompt: '같은 키이지만 다른 요청입니다.' });
      throw new Error('expected requestId conflict');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_REQUEST_CONFLICT');
    }
    try {
      await runtime.startTask({ ...intent, modelId: 'gpt-5.6-terra' });
      throw new Error('expected model-bound requestId conflict');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_REQUEST_CONFLICT');
    }
    expect(targetResolutions).toBe(1);
    expect(executableProbes).toBe(1);
    expect(leaseAcquisitions).toBe(1);
    await runtime.shutdown();
  });

  test('resolves the public model id to the provider model and rejects removed models before acceptance', async () => {
    const calls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    const freshChecks: Array<boolean | undefined> = [];
    const { service: runtime, journal } = service({
      resolveRuntime: (_adapterId, options) => {
        freshChecks.push(options?.fresh);
        return resolvedRuntime(
          '/opt/agentstoz/bin/codex',
          'stable-model-id',
          'provider/model-snapshot',
          'xhigh',
        );
      },
      runCodex: async input => {
        calls.push(input);
        return {
          threadId: 'provider_thread_model_12345678',
          turnId: 'provider_turn_model_12345678',
          finalSummary: '선택 모델로 완료했습니다.',
        };
      },
    });
    const selected = await runtime.startTask({
      ...request('modelmap1'),
      modelId: 'stable-model-id',
    });
    await eventually(() => journal.getTask(selected.task.taskId)?.status === 'succeeded');
    expect(calls[0]?.model).toBe('provider/model-snapshot');
    expect(calls[0]?.reasoningEffort).toBe('xhigh');
    expect(selected.task.modelId).toBe('stable-model-id');

    try {
      await runtime.startTask({ ...request('removed01'), modelId: 'removed-model' });
      throw new Error('expected removed model rejection');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_MODEL_UNAVAILABLE');
    }
    expect(journal.getTaskByRequestId('request_removed01')).toBeNull();
    expect(freshChecks).toEqual([true, true]);
  });

  test('rejects a retired start request before resolving a target or probing an executable', async () => {
    const journal = openJournal();
    const retiredRequest = request('retired1');
    const retired = journal.createOrGetTask({
      ...retiredRequest,
      projectLabel: '정리된 프로젝트',
    }).task;
    journal.appendEvent(retired.taskId, {
      type: 'task.cancelled',
      payload: { reason: '보존 기간 정리를 재현합니다.' },
    });
    expect(journal.deleteTask(retired.taskId)).toBe(true);

    let targetResolutions = 0;
    let executableProbes = 0;
    const runtime = service({
      journal,
      resolveTarget: targetId => {
        targetResolutions += 1;
        return resolvedTarget(targetId);
      },
      resolveRuntime: () => {
        executableProbes += 1;
        return resolvedRuntime();
      },
    }).service;

    try {
      await runtime.startTask(retiredRequest);
      throw new Error('expected the retired request to stay retired');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_REQUEST_RETIRED');
    }
    expect(targetResolutions).toBe(0);
    expect(executableProbes).toBe(0);
  });

  test('serializes start mutations and enforces one task per target plus four globally', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    let releaseFirstResolver!: () => void;
    const firstResolverGate = new Promise<void>(resolve => { releaseFirstResolver = resolve; });
    const enteredResolvers: string[] = [];
    let concurrentResolvers = 0;
    let maxConcurrentResolvers = 0;
    const runtime = service({
      runCodex: abortableHoldingRunner(runnerCalls),
      resolveTarget: async targetId => {
        enteredResolvers.push(targetId);
        concurrentResolvers += 1;
        maxConcurrentResolvers = Math.max(maxConcurrentResolvers, concurrentResolvers);
        if (targetId === 'target_serial01') await firstResolverGate;
        concurrentResolvers -= 1;
        return resolvedTarget(targetId);
      },
    }).service;

    const firstStart = runtime.startTask(request('serial01'));
    await eventually(() => enteredResolvers.length === 1);
    const secondStart = runtime.startTask(request('serial02'));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(enteredResolvers).toEqual(['target_serial01']);
    releaseFirstResolver();
    const [first, second] = await Promise.all([firstStart, secondStart]);
    expect(maxConcurrentResolvers).toBe(1);

    try {
      await runtime.startTask(request('same0001', first.task.targetId));
      throw new Error('expected target busy');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_TARGET_BUSY');
    }

    await runtime.startTask(request('serial03'));
    await runtime.startTask(request('serial04'));
    expect(runnerCalls).toHaveLength(4);
    try {
      await runtime.startTask(request('serial05'));
      throw new Error('expected global capacity failure');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_CAPACITY');
    }

    await runtime.shutdown();
    for (const task of [first.task, second.task, ...runtime.listTasks().tasks]) {
      const current = runtime.listTasks().tasks.find(candidate => candidate.taskId === task.taskId);
      if (current) expect(current.status).toBe('cancelled');
    }
  });

  test('records cancellation only after the adapter has actually settled', async () => {
    let abortSeen = false;
    let rejectRunner!: (reason: unknown) => void;
    let releaseCalls = 0;
    let activeTaskId: string | undefined;
    const journal = openJournal();
    const runCodex: RunCodexAgentRuntimeTask = input => new Promise((_, reject) => {
      rejectRunner = reject;
      input.signal?.addEventListener('abort', () => { abortSeen = true; }, { once: true });
    });
    const runtime = service({
      journal,
      runCodex,
      cancelWaitMs: 5,
      acquireWorkspaceLease: () => ({
        release: () => {
          releaseCalls += 1;
          expect(journal.getTask(activeTaskId!)?.status).toBe('cancelled');
          return true;
        },
      }),
    }).service;
    const started = await runtime.startTask(request('cancel001'));
    activeTaskId = started.task.taskId;
    await eventually(() => journal.getTask(started.task.taskId)?.status === 'running');

    const waiting = await runtime.cancelTask(started.task.taskId, {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'cancel_request_12345678',
    });
    expect(abortSeen).toBe(true);
    expect(waiting.task.status).toBe('running');
    expect(journal.readEvents(started.task.taskId, 0).map(event => event.type)).toEqual([
      'task.accepted', 'task.started',
    ]);
    expect(releaseCalls).toBe(0);

    rejectRunner(new Error('terminated after fake process cleanup'));
    await eventually(() => journal.getTask(started.task.taskId)?.status === 'cancelled');
    await eventually(() => releaseCalls === 1);
    const cancelled = await runtime.cancelTask(started.task.taskId, {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'cancel_request_87654321',
    });
    expect(cancelled.task.status).toBe('cancelled');
    expect(journal.readEvents(started.task.taskId, 0).map(event => event.type)).toEqual([
      'task.accepted', 'task.started', 'task.cancelled',
    ]);
    expect(releaseCalls).toBe(1);
  });

  test('binds one durable cancel request id to one task before aborting', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    const { service: runtime, journal } = service({
      runCodex: abortableHoldingRunner(runnerCalls),
    });
    const first = await runtime.startTask(request('cancelb1'));
    const second = await runtime.startTask(request('cancelb2'));
    await eventually(() => runnerCalls.length === 2);

    await runtime.cancelTask(first.task.taskId, {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      requestId: 'cancel_bound_12345678',
    });
    await eventually(() => journal.getTask(first.task.taskId)?.status === 'cancelled');
    expect(runnerCalls[1]?.signal?.aborted).toBe(false);
    try {
      await runtime.cancelTask(second.task.taskId, {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        requestId: 'cancel_bound_12345678',
      });
      throw new Error('expected cross-task cancellation request conflict');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_CANCEL_REQUEST_CONFLICT');
    }
    expect(runnerCalls[1]?.signal?.aborted).toBe(false);
  });

  test('uses one generic failure for unexpected errors and preserves typed adapter failures', async () => {
    let call = 0;
    const runCodex: RunCodexAgentRuntimeTask = async input => {
      call += 1;
      if (call === 1) throw new Error(`secret raw failure in ${input.cwd}`);
      await input.bindProviderIds({
        threadId: 'provider_thread_failure_12345678',
        turnId: 'provider_turn_failure_12345678',
      });
      throw new CodexAgentRuntimeError(
        'CODEX_AUTH_REQUIRED',
        'Codex 인증이 만료되었거나 권한이 없습니다. Codex 로그인을 확인해 주세요.',
        { cause: new Error(`second secret raw failure in ${input.cwd}`) },
      );
    };
    const { service: runtime, journal } = service({ runCodex });
    const unexpected = await runtime.startTask(request('failure01'));
    await eventually(() => journal.getTask(unexpected.task.taskId)?.status === 'failed');
    const firstFailures = journal.readEvents(unexpected.task.taskId, 0)
      .filter(event => event.type === 'task.failed');
    expect(firstFailures).toHaveLength(1);
    expect(firstFailures[0]).toMatchObject({
      payload: {
        code: 'AGENT_RUNTIME_EXECUTION_FAILED',
        message: '에이전트 작업을 완료하지 못했습니다.',
      },
    });
    expect(JSON.stringify(firstFailures)).not.toContain('/tmp/agent-runtime-projects');
    expect(JSON.stringify(firstFailures)).not.toContain('secret raw failure');

    const providerFailed = await runtime.startTask(request('failure02'));
    await eventually(() => journal.getTask(providerFailed.task.taskId)?.status === 'failed');
    const secondFailures = journal.readEvents(providerFailed.task.taskId, 0)
      .filter(event => event.type === 'task.failed');
    expect(secondFailures).toHaveLength(1);
    expect(secondFailures[0]).toMatchObject({
      payload: {
        code: 'CODEX_AUTH_REQUIRED',
        message: 'Codex 인증이 만료되었거나 권한이 없습니다. Codex 로그인을 확인해 주세요.',
        retryable: false,
      },
    });
    expect(journal.getTaskExecution(providerFailed.task.taskId)).toMatchObject({
      threadId: 'provider_thread_failure_12345678',
      turnId: 'provider_turn_failure_12345678',
    });
    expect(JSON.stringify(secondFailures)).not.toContain('second secret raw failure');
  });

  test('turns an event flood into one durable terminal failure at the reserved sequence', async () => {
    const runCodex: RunCodexAgentRuntimeTask = async input => {
      // accepted=1 and started=2; the journal permits non-terminal progress
      // only through sequence 511 and preserves 512 for the supervisor result.
      for (let seq = 3; seq <= AGENT_RUNTIME_MAX_EVENTS_PER_TASK; seq += 1) {
        await input.emit({
          type: 'task.progress',
          payload: { summary: `진행 이벤트 ${seq}`, phase: 'execute' },
        });
      }
      throw new Error('the event limit must stop the runner first');
    };
    const { service: runtime, journal } = service({ runCodex });
    const started = await runtime.startTask(request('eventcap1'));

    await eventually(() => journal.getTask(started.task.taskId)?.status === 'failed');
    expect(journal.getTask(started.task.taskId)).toMatchObject({
      status: 'failed',
      lastSeq: AGENT_RUNTIME_MAX_EVENTS_PER_TASK,
    });
    expect(journal.readEvents(
      started.task.taskId,
      AGENT_RUNTIME_MAX_EVENTS_PER_TASK - 1,
    )).toEqual([
      expect.objectContaining({
        seq: AGENT_RUNTIME_MAX_EVENTS_PER_TASK,
        type: 'task.failed',
        payload: expect.objectContaining({ code: 'EVENT_LIMIT_REACHED' }),
      }),
    ]);
  });

  test('keeps a settled task owned while terminal persistence is degraded, then recovers before reuse', async () => {
    const journal = openJournal();
    const append = journal.appendEvent.bind(journal);
    let terminalWriteAttempts = 0;
    journal.appendEvent = (taskId, draft) => {
      if (draft.type === 'task.result') {
        terminalWriteAttempts += 1;
        if (terminalWriteAttempts === 1) throw new Error('transient terminal write failure');
      }
      return append(taskId, draft);
    };
    const runCodex: RunCodexAgentRuntimeTask = async () => ({
      threadId: 'provider_thread_recover_12345678',
      turnId: 'provider_turn_recover_12345678',
      finalSummary: '작업 결과',
    });
    const runtime = service({ journal, runCodex }).service;
    const targetId = 'target_recover_12345678';
    const first = await runtime.startTask(request('recover1', targetId));
    await eventually(() => terminalWriteAttempts === 1);
    expect(journal.getTask(first.task.taskId)?.status).toBe('running');
    expect((await runtime.capabilities()).adapters.find(adapter => adapter.adapterId === 'codex')?.availability)
      .toBe('unknown');

    // startTask first replays the pending terminal event. Only after it becomes
    // durable can a new request acquire the same target.
    const second = await runtime.startTask(request('recover2', targetId));
    await eventually(() => journal.getTask(first.task.taskId)?.status === 'succeeded');
    await eventually(() => journal.getTask(second.task.taskId)?.status === 'succeeded');
    expect(terminalWriteAttempts).toBe(3);
  });

  test('keeps terminal workspaces owned and degrades when exact lease release returns false', async () => {
    let acquisitions = 0;
    let releaseCalls = 0;
    const { service: runtime, journal } = service({
      acquireWorkspaceLease: () => {
        acquisitions += 1;
        return {
          release: () => {
            releaseCalls += 1;
            return false;
          },
        };
      },
      runCodex: async () => ({
        threadId: 'provider_thread_release_false_12345678',
        turnId: 'provider_turn_release_false_12345678',
        finalSummary: '작업 자체는 완료했습니다.',
      }),
    });
    const started = await runtime.startTask(request('lease_release_false_01'));
    await eventually(() => journal.getTask(started.task.taskId)?.status === 'succeeded');
    await eventually(() => releaseCalls === 1);
    expect((await runtime.capabilities()).adapters.find(adapter => adapter.adapterId === 'codex')?.availability)
      .toBe('unknown');

    try {
      await runtime.startTask(request('lease_release_false_02'));
      throw new Error('expected fail-closed degraded runtime');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_DEGRADED');
    }
    expect(acquisitions).toBe(1);
    expect(releaseCalls).toBe(1);
    await expect(runtime.shutdown()).rejects.toThrow('AGENT_RUNTIME_SHUTDOWN_INCOMPLETE');
  });

  test('keeps the workspace owned when Codex process-tree termination is unconfirmed', async () => {
    let acquisitions = 0;
    let releaseCalls = 0;
    const { service: runtime, journal } = service({
      acquireWorkspaceLease: () => {
        acquisitions += 1;
        return {
          release: () => {
            releaseCalls += 1;
            return true;
          },
        };
      },
      runCodex: async () => {
        throw new CodexAgentRuntimeError(
          'CODEX_PROCESS_TERMINATION_UNCONFIRMED',
          'Codex 작업 프로세스 종료를 확인하지 못했습니다.',
        );
      },
    });

    const started = await runtime.startTask(request('tree_unknown_01'));
    await eventually(() => journal.getTask(started.task.taskId)?.status === 'failed');
    expect(journal.readEvents(started.task.taskId, 0).map(event => event.type)).toEqual([
      'task.accepted',
      'task.started',
      'task.failed',
    ]);
    expect(journal.readEvents(started.task.taskId, 0).at(-1)).toMatchObject({
      type: 'task.failed',
      payload: {
        code: 'CODEX_PROCESS_TERMINATION_UNCONFIRMED',
        retryable: false,
      },
    });
    expect(releaseCalls).toBe(0);

    try {
      await runtime.startTask(request('tree_unknown_02'));
      throw new Error('expected process-ownership uncertainty to degrade the runtime');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_DEGRADED');
    }
    expect(acquisitions).toBe(1);
    expect(releaseCalls).toBe(0);
    await expect(runtime.shutdown()).rejects.toThrow('AGENT_RUNTIME_SHUTDOWN_INCOMPLETE');
    expect(releaseCalls).toBe(0);
  });

  test('rejects successful shutdown while an abort-ignoring runner is still alive', async () => {
    let settleRunner!: () => void;
    const runCodex: RunCodexAgentRuntimeTask = async () => {
      await new Promise<void>(resolve => { settleRunner = resolve; });
      return {
        threadId: 'provider_thread_shutdown_12345678',
        turnId: 'provider_turn_shutdown_12345678',
        finalSummary: '늦게 끝난 작업',
      };
    };
    const { service: runtime, journal } = service({ runCodex, shutdownWaitMs: 5 });
    const started = await runtime.startTask(request('shutdown1'));
    await eventually(() => journal.getTask(started.task.taskId)?.status === 'running');

    await expect(runtime.shutdown()).rejects.toThrow('AGENT_RUNTIME_SHUTDOWN_INCOMPLETE');
    expect(journal.getTask(started.task.taskId)?.status).toBe('running');
    settleRunner();
    await eventually(() => journal.getTask(started.task.taskId)?.status === 'cancelled');
  });

  test('shutdown releases the common lease only after abort settlement and durable cancellation', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    let taskId: string | undefined;
    let releaseCalls = 0;
    const journal = openJournal();
    const runtime = service({
      journal,
      runCodex: abortableHoldingRunner(runnerCalls),
      acquireWorkspaceLease: () => ({
        release: () => {
          releaseCalls += 1;
          expect(runnerCalls[0]?.signal?.aborted).toBe(true);
          expect(journal.getTask(taskId!)?.status).toBe('cancelled');
          return true;
        },
      }),
    }).service;
    const started = await runtime.startTask(request('shutdown_lease_01'));
    taskId = started.task.taskId;
    await eventually(() => runnerCalls.length === 1);

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(releaseCalls).toBe(1);
    expect(journal.getTask(started.task.taskId)?.status).toBe('cancelled');
  });

  test('bounds a stuck target resolver and releases the serialized start lane for shutdown', async () => {
    const runtime = service({
      resolveTarget: () => new Promise(() => {}),
      resolutionTimeoutMs: 5,
      shutdownWaitMs: 20,
    }).service;
    try {
      await runtime.startTask(request('timeout01'));
      throw new Error('expected target status timeout');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_TARGET_STATUS_TIMEOUT');
    }
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  test('aborts an active runner before waiting for a different in-flight resolver', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    let resolveSecondTarget!: () => void;
    let secondResolverStarted = false;
    const firstTargetId = 'target_shutdown_active_01';
    const secondTargetId = 'target_shutdown_probe_002';
    const runtime = service({
      runCodex: abortableHoldingRunner(runnerCalls),
      resolveTarget: async targetId => {
        if (targetId === secondTargetId) {
          secondResolverStarted = true;
          await new Promise<void>(resolve => { resolveSecondTarget = resolve; });
        }
        return resolvedTarget(targetId);
      },
      resolutionTimeoutMs: 1_000,
      shutdownWaitMs: 100,
    }).service;

    await runtime.startTask(request('shutdown_active_01', firstTargetId));
    await eventually(() => runnerCalls.length === 1);
    const pendingStart = runtime.startTask(request('shutdown_probe_001', secondTargetId));
    await eventually(() => secondResolverStarted);

    const shutdown = runtime.shutdown();
    expect(runnerCalls[0]?.signal?.aborted).toBe(true);
    resolveSecondTarget();
    try {
      await pendingStart;
      throw new Error('expected in-flight start to observe shutdown');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_SHUTTING_DOWN');
    }
    await expect(shutdown).resolves.toBeUndefined();
  });

  test('runs bounded terminal retention after tasks finish, not only at construction', async () => {
    const journal = openJournal();
    const runtime = service({
      journal,
      runCodex: async () => ({
        threadId: 'provider_thread_prune_12345678',
        turnId: 'provider_turn_prune_12345678',
        finalSummary: '완료',
      }),
    }).service;
    let pruneCalls = 0;
    const prune = journal.pruneTerminalTasks.bind(journal);
    journal.pruneTerminalTasks = keep => {
      pruneCalls += 1;
      return prune(keep);
    };
    const started = await runtime.startTask(request('pruneend'));
    await eventually(() => journal.getTask(started.task.taskId)?.status === 'succeeded');
    await eventually(() => pruneCalls > 0);
    expect(pruneCalls).toBeGreaterThan(0);
  });

  test('forceAbortNow reaches every task and prevents new non-duplicate starts', async () => {
    const runnerCalls: Parameters<RunCodexAgentRuntimeTask>[0][] = [];
    const { service: runtime, journal } = service({
      runCodex: abortableHoldingRunner(runnerCalls),
    });
    const started = await runtime.startTask(request('force001'));
    await eventually(() => runnerCalls.length === 1);

    runtime.forceAbortNow();
    expect(runnerCalls[0]?.signal?.aborted).toBe(true);
    await eventually(() => journal.getTask(started.task.taskId)?.status === 'cancelled');
    try {
      await runtime.startTask(request('force002'));
      throw new Error('expected shutdown rejection');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_SHUTTING_DOWN');
    }
  });

  test('rejects unsupported adapters and malformed runtime resolutions before accepting work', async () => {
    let targetCalls = 0;
    let runnerCalls = 0;
    const { service: runtime, journal } = service({
      resolveTarget: targetId => {
        targetCalls += 1;
        return resolvedTarget(targetId);
      },
      resolveRuntime: () => resolvedRuntime('codex'),
      runCodex: async () => {
        runnerCalls += 1;
        throw new Error('must not run');
      },
    });

    try {
      await runtime.startTask(request('claude01', 'target_claude01', 'claude'));
      throw new Error('expected unsupported adapter failure');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_ADAPTER_UNAVAILABLE');
    }
    expect(targetCalls).toBe(0);

    try {
      await runtime.startTask(request('badpath01'));
      throw new Error('expected executable failure');
    } catch (error) {
      expectHttpCode(error, 'AGENT_RUNTIME_EXECUTABLE_UNKNOWN');
    }
    expect(targetCalls).toBe(1);
    expect(runnerCalls).toBe(0);
    expect(journal.listTasks()).toEqual([]);
  });
});
