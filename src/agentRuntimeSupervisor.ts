import { join } from 'node:path';

import type { AgentRuntimeGuardRegistry } from './agentRuntimeGuardRegistry';
import { acquireOwnedFileLock, type OwnedFileLockRelease } from './portalFileLock';

export const AGENT_RUNTIME_SUPERVISOR_ATTEMPTS = 75;
export const AGENT_RUNTIME_SUPERVISOR_RETRY_MS = 40;
export const AGENT_RUNTIME_SUPERVISOR_STALE_AFTER_MS = 60_000;
export const AGENT_RUNTIME_SUPERVISOR_DEAD_OWNER_GRACE_MS = 1_000;

/**
 * Acquires the one Agent Runtime supervisor authority. Production recovery is
 * manual because registered-PGID absence does not prove that no descendant
 * escaped through setsid()/a detached spawn. The test-only mode exercises the
 * guard registry restart protocol with fixtures that never leave their PGID.
 */
export function acquireAgentRuntimeSupervisor(input: {
  appDataDir: string;
  registry: AgentRuntimeGuardRegistry;
  label?: string;
  recoveryMode?: 'manual' | 'registered-pgid-test';
}): Promise<OwnedFileLockRelease> {
  const registeredPgidTest = input.recoveryMode === 'registered-pgid-test';
  return acquireOwnedFileLock(
    join(input.appDataDir, 'agent-runtime', 'supervisor-v1.lock'),
    {
      attempts: AGENT_RUNTIME_SUPERVISOR_ATTEMPTS,
      retryMs: AGENT_RUNTIME_SUPERVISOR_RETRY_MS,
      staleAfterMs: AGENT_RUNTIME_SUPERVISOR_STALE_AFTER_MS,
      deadOwnerGraceMs: AGENT_RUNTIME_SUPERVISOR_DEAD_OWNER_GRACE_MS,
      deadOwnerRecoveryClass: registeredPgidTest ? 'guarded' : 'manual',
      canRecoverDeadOwner: registeredPgidTest
        ? owner => input.registry.canRecoverDeadOwner(owner)
        : undefined,
      label: input.label ?? 'agent runtime supervisor',
    },
  );
}
