import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAgentRuntimeGuardLaunchers } from '../../src/agentRuntimeGuardLauncher';
import { prepareAgentRuntimeGuardRegistry } from '../../src/agentRuntimeGuardRegistry';
import { handleAgentRuntimeHttpRequest } from '../../src/agentRuntimeHttp';
import { createAgentRuntimeService } from '../../src/agentRuntimeService';
import { openAgentRuntimeTaskJournal } from '../../src/agentRuntimeTaskJournal';
import { acquireAgentRuntimeSupervisor } from '../../src/agentRuntimeSupervisor';
import { runCodexAgentTask } from '../../src/codexAgentRuntime';
import {
  CODEX_RUNTIME_MACOS_IDENTIFIER,
  CODEX_RUNTIME_MACOS_TEAM_ID,
  codexRuntimeExecutableRevision,
  hashCodexRuntimeExecutableFileSync,
  type CodexRuntimeExecutableIdentity,
} from '../../src/codexRuntimeExecutable';
import { acquireWorkspaceLease } from '../../src/workspaceLease';

const [appDataDir, workspacePath, requestedExecutable, readyPath] = process.argv.slice(2);
if (!appDataDir || !workspacePath || !requestedExecutable || !readyPath) process.exit(64);

mkdirSync(join(appDataDir, 'agent-runtime'), { recursive: true });
const guardRegistry = prepareAgentRuntimeGuardRegistry(appDataDir);
const guardLaunchers = createAgentRuntimeGuardLaunchers(guardRegistry);
const executable = realpathSync(requestedExecutable);
const executableInfo = statSync(executable, { bigint: true });
if (!executableInfo.isFile() || (Number(executableInfo.mode) & 0o111) === 0) process.exit(69);
const executableStat = {
  dev: executableInfo.dev.toString(),
  ino: executableInfo.ino.toString(),
  size: executableInfo.size.toString(),
  mode: Number(executableInfo.mode),
  mtimeNs: executableInfo.mtimeNs.toString(),
  ctimeNs: executableInfo.ctimeNs.toString(),
};
const identityWithoutRevision: Omit<CodexRuntimeExecutableIdentity, 'revision'> = {
  path: executable,
  source: 'standalone-native',
  version: '0.0.0-agentstoz-e2e',
  sha256: hashCodexRuntimeExecutableFileSync(executable, executableStat),
  stat: executableStat,
  signing: process.platform === 'darwin' ? {
    platform: 'darwin',
    teamId: CODEX_RUNTIME_MACOS_TEAM_ID,
    identifier: CODEX_RUNTIME_MACOS_IDENTIFIER,
  } : null,
};
const executableIdentity: CodexRuntimeExecutableIdentity = {
  ...identityWithoutRevision,
  revision: codexRuntimeExecutableRevision(identityWithoutRevision),
};

const supervisorRelease = await acquireAgentRuntimeSupervisor({
  appDataDir,
  registry: guardRegistry,
  label: 'agent runtime e2e supervisor',
  recoveryMode: 'registered-pgid-test',
});
const journal = openAgentRuntimeTaskJournal(
  join(appDataDir, 'agent-runtime', 'tasks-v1.sqlite'),
);

function taskTimeoutMs(): number {
  const value = Number(readFileSync(
    join(workspacePath!, 'fake-codex-timeout-ms.txt'),
    'utf8',
  ).trim());
  return Number.isSafeInteger(value) && value >= 50 && value <= 30_000 ? value : 30_000;
}

// Only this isolated sidecar records stderr from its compiled software provider.
// Production intentionally discards provider stderr; never add this to that path.
const fixtureDiagnostics = new Map<string, {
  phase: 'spawning' | 'spawned' | 'spawn-failed' | 'exited' | 'exit-wait-failed';
  guardPid: number | null;
  exitCode: number | null;
  signal: null; // The guarded public child handle does not expose an exit signal.
  requestedSignal: number | NodeJS.Signals | null;
  stderr: Uint8Array;
}>();

const service = createAgentRuntimeService({
  journal,
  managedExecutionEnabled: true,
  resolveTarget: targetId => {
    if (targetId !== 'project_vertical_12345678') throw new Error('unknown target');
    return {
      targetId,
      projectLabel: '수직 통합 프로젝트',
      cwd: realpathSync(workspacePath),
    };
  },
  resolveRuntime: adapterId => adapterId === 'codex' ? {
    executable,
    executableIdentity,
    models: [{
      modelId: 'model-test',
      providerModel: 'gpt-test',
      reasoningEffort: 'medium',
      label: 'Test model',
      isDefault: true,
    }],
  } : null,
  acquireWorkspaceLease: async target => {
    try {
      const lease = await acquireWorkspaceLease({
        workspacePath: target.cwd,
        appDataDir,
        gitExecutable: 'git',
        attempts: 100,
        retryMs: 25,
        staleAfterMs: 60_000,
        deadOwnerGraceMs: 1_000,
        deadOwnerRecoveryClass: 'guarded',
        canRecoverDeadOwner: owner => guardRegistry.canRecoverDeadOwner(owner),
      });
      return {
        release: () => lease.release(),
        revalidate: () => realpathSync(workspacePath) === target.cwd,
      };
    } catch (error: any) {
      if (error?.code === 'WORKSPACE_LEASE_BUSY') return null;
      throw error;
    }
  },
  runCodex: input => {
    const diagnostic = {
      phase: 'spawning' as 'spawning' | 'spawned' | 'spawn-failed' | 'exited' | 'exit-wait-failed',
      guardPid: null as number | null,
      exitCode: null as number | null,
      signal: null,
      requestedSignal: null as number | NodeJS.Signals | null,
      stderr: new Uint8Array(0),
    };
    fixtureDiagnostics.set(input.taskId, diagnostic);
    while (fixtureDiagnostics.size > 16) {
      fixtureDiagnostics.delete(fixtureDiagnostics.keys().next().value!);
    }
    return runCodexAgentTask(input, {
      spawn: (command, options, identity) => {
        let child;
        try {
          child = guardLaunchers.spawnCodex(command, options, identity);
        } catch (error) {
          diagnostic.phase = 'spawn-failed';
          throw error;
        }
        diagnostic.phase = 'spawned';
        diagnostic.guardPid = child.pid ?? null;
        const [stderr, diagnosticStderr] = child.stderr.tee();
        void (async () => {
          const reader = diagnosticStderr.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              const remaining = 4096 - diagnostic.stderr.byteLength;
              if (remaining > 0) {
                const bounded = next.value.subarray(0, remaining);
                const captured = new Uint8Array(diagnostic.stderr.byteLength + bounded.byteLength);
                captured.set(diagnostic.stderr);
                captured.set(bounded, diagnostic.stderr.byteLength);
                diagnostic.stderr = captured;
              }
              // Keep draining after the byte limit so diagnostic collection
              // cannot block the guarded provider or the production stderr pump.
            }
          } finally {
            reader.releaseLock();
          }
        })().catch(() => undefined);
        void child.exited.then(exitCode => {
          diagnostic.exitCode = exitCode;
          diagnostic.phase = 'exited';
        }, () => { diagnostic.phase = 'exit-wait-failed'; });
        return {
          ...child,
          stderr,
          kill: signal => {
            diagnostic.requestedSignal = signal ?? 'SIGTERM';
            return child.kill(signal);
          },
        };
      },
      timeoutMs: taskTimeoutMs(),
    });
  },
  cancelWaitMs: 2_000,
  resolutionTimeoutMs: 4_000,
  shutdownWaitMs: 5_000,
});

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: async request => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/test/fixture-diagnostics') {
      const taskId = url.searchParams.get('taskId');
      if (!taskId || !/^[A-Za-z0-9_-]{8,128}$/.test(taskId)
        || [...url.searchParams.keys()].join(',') !== 'taskId') {
        return Response.json({ error: 'invalid fixture request' }, { status: 400 });
      }
      const diagnostic = fixtureDiagnostics.get(taskId);
      if (!diagnostic) return Response.json({ error: 'unknown fixture task' }, { status: 404 });
      return Response.json({
        ...diagnostic,
        // stream:true omits an incomplete trailing UTF-8 character instead of
        // expanding it beyond the 4 KiB byte budget with replacement characters.
        stderr: new TextDecoder().decode(diagnostic.stderr, { stream: true }),
      });
    }
    if (request.method === 'POST' && url.pathname === '/test/cancellation-intent-only') {
      const body = await request.json() as { taskId?: unknown; requestId?: unknown };
      if (typeof body.taskId !== 'string' || typeof body.requestId !== 'string') {
        return Response.json({ error: 'invalid fixture request' }, { status: 400 });
      }
      const result = journal.recordCancellationIntent(body.taskId, body.requestId);
      return Response.json(result);
    }
    return await handleAgentRuntimeHttpRequest(request, url, service)
      ?? new Response('not found', { status: 404 });
  },
});

writeFileSync(readyPath, JSON.stringify({
  baseUrl: `http://127.0.0.1:${server.port}`,
  pid: process.pid,
}), { mode: 0o600 });

let stopping = false;
async function shutdown(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  let clean = false;
  try {
    await service.shutdown();
    journal.close();
    clean = supervisorRelease();
  } catch {
    clean = false;
  }
  process.exit(clean ? exitCode : 70);
}

process.once('SIGTERM', () => { void shutdown(0); });
process.once('SIGINT', () => { void shutdown(0); });
