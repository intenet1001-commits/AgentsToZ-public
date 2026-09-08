import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectAgentRuntimeGuardRecords,
  prepareAgentRuntimeGuardRegistry,
} from '../src/agentRuntimeGuardRegistry';
import { acquireWorkspaceLease } from '../src/workspaceLease';

const ROOT = join(import.meta.dir, '..');
const SIDECAR_FIXTURE = join(import.meta.dir, 'fixtures', 'agent-runtime-e2e-sidecar.ts');
const PROVIDER_FIXTURE = join(import.meta.dir, 'fixtures', 'agent-runtime-fake-codex.ts');
const DESCENDANT_FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'agent-runtime-e2e-descendant.ts',
);
const roots: string[] = [];
const sidecars: Bun.Subprocess[] = [];
const emergencyGroups = new Set<number>();

interface ProviderState {
  invocationId: string;
  guardPid: number;
  providerPid: number;
  descendantPid: number;
  threadId: string;
  turnId: string;
  phase: 'booting' | 'holding' | 'completed';
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function processGroupAlive(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

async function eventually<T>(
  read: () => T | null | Promise<T | null>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(20);
  }
  throw new Error('vertical runtime condition was not reached');
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function mustGit(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function spawnSidecar(input: {
  appDataDir: string;
  workspacePath: string;
  executable: string;
  readyPath: string;
}): Bun.Subprocess {
  try { unlinkSync(input.readyPath); } catch {}
  const child = Bun.spawn([
    process.execPath,
    '--no-env-file',
    SIDECAR_FIXTURE,
    input.appDataDir,
    input.workspacePath,
    input.executable,
    input.readyPath,
  ], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  sidecars.push(child);
  return child;
}

async function waitSidecarReady(
  child: Bun.Subprocess,
  readyPath: string,
): Promise<{ child: Bun.Subprocess; baseUrl: string }> {
  const ready = await eventually(() => readJsonFile<{ baseUrl: string; pid: number }>(readyPath));
  expect(ready.pid).toBe(child.pid);
  return { child, baseUrl: ready.baseUrl };
}

async function startSidecar(input: {
  appDataDir: string;
  workspacePath: string;
  executable: string;
  readyPath: string;
}): Promise<{ child: Bun.Subprocess; baseUrl: string }> {
  const child = spawnSidecar(input);
  return waitSidecarReady(child, input.readyPath);
}

function forgetSidecar(child: Bun.Subprocess): void {
  const index = sidecars.indexOf(child);
  if (index >= 0) sidecars.splice(index, 1);
}

async function request(
  baseUrl: string,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function startTask(baseUrl: string, requestId: string): Promise<Record<string, any>> {
  const response = await request(baseUrl, '/api/agent-runtime/tasks/start', {
    method: 'POST',
    body: {
      protocolVersion: 'agentstoz-tasks-v2',
      requestId,
      targetId: 'project_vertical_12345678',
      adapterId: 'codex',
      modelId: 'model-test',
      executionMode: 'workspace-write',
      prompt: `isolated vertical task ${requestId}`,
    },
  });
  expect(response.status).toBe(202);
  expect(response.body.duplicate).toBe(false);
  return response.body.task;
}

async function taskStatus(
  baseUrl: string,
  taskId: string,
  expected: string,
): Promise<Record<string, any>> {
  return eventually(async () => {
    const listed = await request(baseUrl, '/api/agent-runtime/tasks');
    const task = (listed.body.tasks as Array<Record<string, any>>)
      .find(candidate => candidate.taskId === taskId);
    return task?.status === expected ? task : null;
  });
}

async function taskEvents(baseUrl: string, taskId: string): Promise<Array<Record<string, any>>> {
  const response = await request(
    baseUrl,
    `/api/agent-runtime/tasks/${encodeURIComponent(taskId)}/events?after=0`,
  );
  expect(response.status).toBe(200);
  return response.body.events as Array<Record<string, any>>;
}

async function waitForProgress(baseUrl: string, taskId: string): Promise<void> {
  await eventually(async () => {
    const events = await taskEvents(baseUrl, taskId);
    return events.some(event => event.type === 'task.progress') ? true : null;
  });
}

async function nextProviderState(
  statePath: string,
  previousInvocationId: string | null,
): Promise<ProviderState> {
  const state = await eventually(() => {
    const candidate = readJsonFile<ProviderState>(statePath);
    if (!candidate
      || candidate.invocationId === previousInvocationId
      || candidate.phase === 'booting') return null;
    return candidate;
  });
  for (const [field, pid] of Object.entries({
    guardPid: state.guardPid,
    providerPid: state.providerPid,
    descendantPid: state.descendantPid,
  })) {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error(`${field} is not a safe fixture process identifier`);
    }
  }
  if (!/^[0-9a-f-]{36}$/.test(state.threadId) || !/^[0-9a-f-]{36}$/.test(state.turnId)) {
    throw new Error('fixture provider correlation identifiers are invalid');
  }
  emergencyGroups.add(state.guardPid);
  return state;
}

async function expectTreeGone(state: ProviderState): Promise<void> {
  await eventually(() => (
    !processGroupAlive(state.guardPid)
      && !processAlive(state.providerPid)
      && !processAlive(state.descendantPid)
      ? true
      : null
  ));
  emergencyGroups.delete(state.guardPid);
}

function expectTermEscalation(workspacePath: string, state: ProviderState): void {
  expect(Number(readFileSync(
    join(workspacePath, 'fake-codex-descendant-term.txt'),
    'utf8',
  ))).toBe(state.descendantPid);
}

function assertProviderBinding(
  appDataDir: string,
  taskId: string,
  state: ProviderState,
): void {
  const database = new Database(
    join(appDataDir, 'agent-runtime', 'tasks-v1.sqlite'),
    { readonly: true },
  );
  try {
    const providerIds = database.query(`
      SELECT provider_thread_id AS threadId, provider_turn_id AS turnId
      FROM agent_runtime_tasks WHERE task_id = ?
    `).get(taskId) as { threadId: string; turnId: string } | null;
    expect(providerIds).toEqual({ threadId: state.threadId, turnId: state.turnId });
  } finally {
    database.close();
  }
}

afterEach(async () => {
  for (const child of sidecars.splice(0)) {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([child.exited.catch(() => undefined), Bun.sleep(2_000)]);
  }
  for (const pgid of emergencyGroups) {
    if (!Number.isSafeInteger(pgid) || pgid <= 1) continue;
    try { process.kill(-pgid, 'SIGCONT'); } catch {}
    try { process.kill(-pgid, 'SIGKILL'); } catch {}
  }
  emergencyGroups.clear();
  await Bun.sleep(50);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Agent Runtime restart vertical gate', () => {
  test.skipIf(process.platform === 'win32')(
    'proves cancel, timeout, crash recovery, process-tree cleanup, and target reuse end to end',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-vertical-'));
      roots.push(root);
      const appDataDir = join(root, 'app-data');
      const mainProjectPath = join(root, 'main-project');
      const workspacePath = join(root, 'workspace');
      const executable = join(root, 'fake-codex');
      const descendantExecutable = join(root, 'fake-codex-descendant');
      const readyPath = join(root, 'sidecar-ready.json');
      const modePath = join(workspacePath, 'fake-codex-mode.txt');
      const timeoutPath = join(workspacePath, 'fake-codex-timeout-ms.txt');
      const statePath = join(workspacePath, 'fake-codex-state.json');
      mkdirSync(mainProjectPath, { recursive: true });
      mustGit(mainProjectPath, 'init', '-q', '-b', 'main');
      writeFileSync(join(mainProjectPath, 'README.md'), 'vertical runtime fixture\n');
      mustGit(mainProjectPath, 'add', 'README.md');
      mustGit(
        mainProjectPath,
        '-c',
        'user.name=Agent Runtime Vertical Test',
        '-c',
        'user.email=agent-runtime@example.invalid',
        'commit',
        '-qm',
        'initial fixture',
      );
      mustGit(mainProjectPath, 'worktree', 'add', '-q', '-b', 'runtime/vertical', workspacePath);
      const built = Bun.spawnSync([
        process.execPath,
        'build',
        PROVIDER_FIXTURE,
        '--compile',
        '--outfile',
        executable,
      ], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(built.exitCode).toBe(0);
      const builtDescendant = Bun.spawnSync([
        process.execPath,
        'build',
        DESCENDANT_FIXTURE,
        '--compile',
        '--outfile',
        descendantExecutable,
      ], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(builtDescendant.exitCode).toBe(0);
      writeFileSync(
        join(workspacePath, 'fake-codex-descendant-path.txt'),
        descendantExecutable,
      );
      writeFileSync(modePath, 'hold');
      writeFileSync(timeoutPath, '30000');

      let { child: sidecar, baseUrl } = await startSidecar({
        appDataDir,
        workspacePath,
        executable,
        readyPath,
      });

      const cancelledTask = await startTask(baseUrl, 'request_vertical_cancel_12345678');
      await waitForProgress(baseUrl, cancelledTask.taskId);
      const cancelledState = await nextProviderState(statePath, null);
      assertProviderBinding(appDataDir, cancelledTask.taskId, cancelledState);
      const cancelled = await request(
        baseUrl,
        `/api/agent-runtime/tasks/${cancelledTask.taskId}/cancel`,
        {
          method: 'POST',
          body: { protocolVersion: 'agentstoz-tasks-v2', requestId: 'cancel_vertical_12345678' },
        },
      );
      expect(cancelled.status).toBe(200);
      await taskStatus(baseUrl, cancelledTask.taskId, 'cancelled');
      expect((await taskEvents(baseUrl, cancelledTask.taskId)).at(-1)?.type).toBe('task.cancelled');
      await expectTreeGone(cancelledState);
      expectTermEscalation(workspacePath, cancelledState);

      // Exercise timeout cleanup AFTER the provider has started its child.
      // A 250 ms cold-start budget on a shared Linux runner can expire before
      // that fixture exists, testing startup scheduling instead of tree cleanup.
      // The production timeout policy is unchanged; this value is fixture-only.
      writeFileSync(timeoutPath, '2000');
      const timedOutTask = await startTask(baseUrl, 'request_vertical_timeout_12345678');
      const timedOutState = await nextProviderState(statePath, cancelledState.invocationId);
      await taskStatus(baseUrl, timedOutTask.taskId, 'failed');
      assertProviderBinding(appDataDir, timedOutTask.taskId, timedOutState);
      const timeoutFailure = (await taskEvents(baseUrl, timedOutTask.taskId))
        .find(event => event.type === 'task.failed');
      expect(timeoutFailure?.payload).toMatchObject({ code: 'CODEX_TASK_TIMEOUT', retryable: true });
      await expectTreeGone(timedOutState);
      expectTermEscalation(workspacePath, timedOutState);

      writeFileSync(timeoutPath, '30000');
      const cancellationCrashTask = await startTask(
        baseUrl,
        'request_vertical_cancel_crash_12345678',
      );
      await waitForProgress(baseUrl, cancellationCrashTask.taskId);
      const cancellationCrashState = await nextProviderState(
        statePath,
        timedOutState.invocationId,
      );
      assertProviderBinding(appDataDir, cancellationCrashTask.taskId, cancellationCrashState);
      const intent = await request(baseUrl, '/test/cancellation-intent-only', {
        method: 'POST',
        body: {
          taskId: cancellationCrashTask.taskId,
          requestId: 'cancel_vertical_crash_12345678',
        },
      });
      expect(intent).toEqual({ status: 200, body: { duplicate: false } });
      sidecar.kill('SIGKILL');
      await sidecar.exited;
      forgetSidecar(sidecar);

      const cancellationRestart = await startSidecar({
        appDataDir,
        workspacePath,
        executable,
        readyPath,
      });
      sidecar = cancellationRestart.child;
      baseUrl = cancellationRestart.baseUrl;
      await expectTreeGone(cancellationCrashState);
      expectTermEscalation(workspacePath, cancellationCrashState);
      await taskStatus(baseUrl, cancellationCrashTask.taskId, 'cancelled');
      const cancellationRecoveredEvents = await taskEvents(
        baseUrl,
        cancellationCrashTask.taskId,
      );
      expect(cancellationRecoveredEvents.filter(event => event.type === 'task.cancelled'))
        .toHaveLength(1);
      expect(cancellationRecoveredEvents.at(-1)?.type).toBe('task.cancelled');

      writeFileSync(timeoutPath, '30000');
      const crashedTask = await startTask(baseUrl, 'request_vertical_crash_12345678');
      await waitForProgress(baseUrl, crashedTask.taskId);
      const crashedState = await nextProviderState(
        statePath,
        cancellationCrashState.invocationId,
      );
      assertProviderBinding(appDataDir, crashedTask.taskId, crashedState);
      const registry = prepareAgentRuntimeGuardRegistry(appDataDir);
      expect(inspectAgentRuntimeGuardRecords(registry)).toEqual([
        expect.objectContaining({
          state: 'active',
          parentPid: sidecar.pid,
          guardPid: crashedState.guardPid,
          pgid: crashedState.guardPid,
          kind: 'codex',
        }),
      ]);
      expect(processAlive(crashedState.providerPid)).toBe(true);
      expect(processAlive(crashedState.descendantPid)).toBe(true);

      process.kill(-crashedState.guardPid, 'SIGSTOP');
      sidecar.kill('SIGKILL');
      await sidecar.exited;
      forgetSidecar(sidecar);

      const restartingSidecar = spawnSidecar({
        appDataDir,
        workspacePath,
        executable,
        readyPath,
      });
      // Past the old fixed one-second grace, a stopped guard and its provider
      // are still alive. The replacement must expose no ready runtime and no
      // other mutation path may reclaim the dead sidecar's workspace lease.
      await Bun.sleep(1_200);
      expect(processGroupAlive(crashedState.guardPid)).toBe(true);
      expect(existsSync(readyPath)).toBe(false);
      const preRecoveryDatabase = new Database(
        join(appDataDir, 'agent-runtime', 'tasks-v1.sqlite'),
        { readonly: true },
      );
      try {
        const row = preRecoveryDatabase.query(`
          SELECT status FROM agent_runtime_tasks WHERE task_id = ?
        `).get(crashedTask.taskId) as { status: string } | null;
        expect(row?.status).toBe('running');
      } finally {
        preRecoveryDatabase.close();
      }
      await expect(acquireWorkspaceLease({
        // The task owns a linked worktree. Prove its stale Git-family lease
        // also blocks the main checkout, not just the exact child directory.
        workspacePath: mainProjectPath,
        appDataDir,
        attempts: 1,
        retryMs: 0,
        staleAfterMs: 1,
        deadOwnerGraceMs: 0,
        deadOwnerRecoveryClass: 'guarded',
        canRecoverDeadOwner: owner => registry.canRecoverDeadOwner(owner),
      })).rejects.toMatchObject({ code: 'WORKSPACE_LEASE_BUSY' });

      process.kill(-crashedState.guardPid, 'SIGCONT');
      const restartedReady = await eventually(() => {
        const oldGroupAlive = processGroupAlive(crashedState.guardPid);
        const ready = readJsonFile<{ baseUrl: string; pid: number }>(readyPath);
        if (ready && oldGroupAlive) {
          throw new Error('replacement became ready before the old process group disappeared');
        }
        return ready && !oldGroupAlive ? ready : null;
      }, 8_000);
      expect(restartedReady.pid).toBe(restartingSidecar.pid);
      sidecar = restartingSidecar;
      baseUrl = restartedReady.baseUrl;
      await expectTreeGone(crashedState);
      expectTermEscalation(workspacePath, crashedState);
      expect(inspectAgentRuntimeGuardRecords(registry)).toEqual([]);

      await taskStatus(baseUrl, crashedTask.taskId, 'failed');
      const recoveredEvents = await taskEvents(baseUrl, crashedTask.taskId);
      expect(recoveredEvents.filter(event => event.type === 'task.failed')).toHaveLength(1);
      expect(recoveredEvents.at(-1)?.payload).toMatchObject({
        code: 'RUNTIME_RESTARTED',
        retryable: true,
      });

      assertProviderBinding(appDataDir, crashedTask.taskId, crashedState);

      writeFileSync(modePath, 'success');
      writeFileSync(timeoutPath, '5000');
      const succeededTask = await startTask(baseUrl, 'request_vertical_reuse_12345678');
      const succeededState = await nextProviderState(statePath, crashedState.invocationId);
      await taskStatus(baseUrl, succeededTask.taskId, 'succeeded');
      assertProviderBinding(appDataDir, succeededTask.taskId, succeededState);
      const successEvents = await taskEvents(baseUrl, succeededTask.taskId);
      expect(successEvents.at(-1)).toMatchObject({
        type: 'task.result',
        payload: { summary: '격리된 수직 통합 작업을 완료했습니다.' },
      });
      await expectTreeGone(succeededState);
      expectTermEscalation(workspacePath, succeededState);

      sidecar.kill('SIGTERM');
      expect(await sidecar.exited).toBe(0);
      forgetSidecar(sidecar);
    },
    45_000,
  );
});
