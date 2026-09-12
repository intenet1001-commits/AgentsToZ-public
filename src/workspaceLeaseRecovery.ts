import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describeFileLockOwner, recoverDeadManualFileLock } from './portalFileLock';
import { WORKSPACE_LEASE_DIRECTORY, workspaceLeaseKeysForPath } from './workspaceLease';
import type {
  OrphanedWorkspaceLease,
  WorkspaceLeaseRecoveryResult,
} from './workspaceLeaseRecoveryContract';

const LOCK_FILE_NAME = /^([0-9a-f]{64})\.lock$/;
const LOCK_KEY = /^[0-9a-f]{64}$/;

/** Read-only view of the lease directory; never creates or follows a symlinked one. */
function existingLeaseDirectory(appDataDir: string): string | null {
  const directory = join(appDataDir, WORKSPACE_LEASE_DIRECTORY);
  try {
    const entry = lstatSync(directory);
    return entry.isDirectory() && !entry.isSymbolicLink() ? directory : null;
  } catch {
    return null;
  }
}

/**
 * Locks whose `manual` owner process is gone. These are exactly the ones
 * acquisition refuses to reclaim, so without this list they stay until someone
 * deletes a hash-named file by hand. Mapping a lock back to a project is
 * display-only: an unmapped lock is still listed rather than hidden.
 */
export function listOrphanedWorkspaceLeases(input: {
  appDataDir: string;
  candidatePaths: readonly unknown[];
}): OrphanedWorkspaceLease[] {
  const directory = existingLeaseDirectory(input.appDataDir);
  if (!directory) return [];

  const orphans: OrphanedWorkspaceLease[] = [];
  for (const name of readdirSync(directory).sort()) {
    const match = LOCK_FILE_NAME.exec(name);
    if (!match) continue;
    const lockPath = join(directory, name);
    let owner: string;
    let lockedAt: string;
    try {
      owner = readFileSync(lockPath, 'utf8');
      lockedAt = statSync(lockPath).mtime.toISOString();
    } catch {
      continue;
    }
    const identity = describeFileLockOwner(owner);
    if (!identity || identity.recoveryClass !== 'manual' || identity.alive) continue;
    orphans.push({ key: match[1]!, pid: identity.pid, lockedAt, kind: 'unknown', workspacePath: null });
  }
  if (orphans.length === 0) return orphans;

  // Hashing is only needed when something is actually orphaned, which is rare.
  const byKey = new Map(orphans.map(orphan => [orphan.key, orphan]));
  let unresolved = orphans.length;
  for (const candidate of input.candidatePaths) {
    if (unresolved === 0) break;
    if (typeof candidate !== 'string' || !isAbsolute(candidate)) continue;
    const keys = workspaceLeaseKeysForPath(candidate);
    if (!keys) continue;
    for (const [key, kind] of [
      [keys.directoryKey, 'directory'],
      [keys.familyKey, 'git-family'],
    ] as const) {
      const orphan = key === null ? undefined : byKey.get(key);
      if (!orphan || orphan.workspacePath !== null) continue;
      orphan.kind = kind;
      orphan.workspacePath = keys.canonicalWorkspacePath;
      unresolved -= 1;
    }
  }
  return orphans;
}

export function recoverOrphanedWorkspaceLeases(input: {
  appDataDir: string;
  locks: readonly { key: unknown; pid: unknown }[];
}): WorkspaceLeaseRecoveryResult[] {
  const directory = existingLeaseDirectory(input.appDataDir);
  return input.locks.map(({ key, pid }) => {
    if (typeof key !== 'string' || !LOCK_KEY.test(key)
      || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) {
      return { key: typeof key === 'string' ? key : '', outcome: 'invalid' };
    }
    if (!directory) return { key, outcome: 'missing' };
    return { key, outcome: recoverDeadManualFileLock(join(directory, `${key}.lock`), pid) };
  });
}
