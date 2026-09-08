import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { constants as sqliteConstants, Database } from 'bun:sqlite';

export interface PortalFileLockOptions {
  attempts?: number;
  retryMs?: number;
  staleAfterMs?: number;
  /** Optional cleanup grace before reclaiming a well-formed dead-PID owner. */
  deadOwnerGraceMs?: number;
  /**
   * Optional synchronous proof that an observed dead or stale owner is safe
   * to reclaim. Only an exact `true` grants recovery.
   */
  canRecoverDeadOwner?: (owner: string) => boolean;
  /** Optional recovery policy encoded into newly-created v3 owner records. */
  deadOwnerRecoveryClass?: 'guarded' | 'manual';
  label?: string;
}

export interface OwnedFileLockRelease {
  (): boolean;
  /** Refresh only the inode that still contains this owner's token. */
  refresh(): boolean;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

const PORTAL_FILE_LOCK_V2_OWNER_PATTERN = /^v2:([1-9][0-9]{0,9}):[0-9a-f]{32}$/;
const PORTAL_FILE_LOCK_V3_OWNER_PATTERN = /^v3:([1-9][0-9]{0,9}):[0-9a-f]{32}:(guarded|manual)$/;
const PORTAL_FILE_LOCK_COORDINATOR_SUFFIX = '.coordinator-v1.sqlite';
// Coordinator transactions contain no await/user operation. Keep a bounded
// fail-closed wait well inside the sidecar's native graceful-shutdown margin.
const PORTAL_FILE_LOCK_COORDINATOR_BUSY_MS = 1_000;

/**
 * O_EXCL makes creation atomic, but a content check followed by path unlink is
 * not an atomic compare-and-delete. Serialize every current acquire, release,
 * refresh, and stale reclaim through SQLite's cross-process write lock so a
 * checked inode cannot be replaced before its unlink. SQLite releases this
 * short-lived lock automatically if a contender crashes.
 */
function withPortalFileLockCoordinator<T>(lockPath: string, operation: () => T): T {
  // SQLITE_OPEN_NOFOLLOW also rejects symlinks in parent path components.
  // Canonicalizing the already-created parent preserves normal macOS /var ->
  // /private/var paths while still refusing a symlink as the coordinator file.
  const coordinatorPath = join(
    realpathSync(dirname(lockPath)),
    `${basename(lockPath)}${PORTAL_FILE_LOCK_COORDINATOR_SUFFIX}`,
  );
  let coordinatorDescriptor: number | null = null;
  try {
    coordinatorDescriptor = openSync(coordinatorPath, 'wx', 0o600);
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      const noFollowFlag = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
      coordinatorDescriptor = openSync(coordinatorPath, fsConstants.O_RDWR | noFollowFlag);
    } catch (openError: any) {
      if (openError?.code === 'ELOOP') {
        throw new Error('잠금 조정 파일이 안전하지 않습니다.');
      }
      throw openError;
    }
  }

  let database: Database | null = null;
  let transactionOpen = false;
  try {
    const descriptorInfo = fstatSync(coordinatorDescriptor);
    if (!descriptorInfo.isFile()) {
      throw new Error('잠금 조정 파일이 안전하지 않습니다.');
    }
    if (process.platform !== 'win32') {
      if (descriptorInfo.nlink !== 1
        || (typeof process.geteuid === 'function' && descriptorInfo.uid !== process.geteuid())) {
        throw new Error('잠금 조정 파일 소유권이 안전하지 않습니다.');
      }
      fchmodSync(coordinatorDescriptor, 0o600);
    }
    const pathInfo = lstatSync(coordinatorPath);
    const securedDescriptorInfo = fstatSync(coordinatorDescriptor);
    if (pathInfo.isSymbolicLink()
      || !pathInfo.isFile()
      || pathInfo.dev !== securedDescriptorInfo.dev
      || pathInfo.ino !== securedDescriptorInfo.ino
      || (process.platform !== 'win32'
        && ((securedDescriptorInfo.mode & 0o077) !== 0 || securedDescriptorInfo.nlink !== 1))) {
      throw new Error('잠금 조정 파일이 안전하지 않습니다.');
    }
    database = new Database(
      coordinatorPath,
      sqliteConstants.SQLITE_OPEN_READWRITE
        | sqliteConstants.SQLITE_OPEN_CREATE
        | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    const openedPathInfo = lstatSync(coordinatorPath);
    if (openedPathInfo.isSymbolicLink()
      || openedPathInfo.dev !== securedDescriptorInfo.dev
      || openedPathInfo.ino !== securedDescriptorInfo.ino) {
      throw new Error('잠금 조정 파일이 안전하지 않습니다.');
    }
    database.exec(`
      PRAGMA busy_timeout = ${PORTAL_FILE_LOCK_COORDINATOR_BUSY_MS};
      PRAGMA trusted_schema = OFF;
      BEGIN IMMEDIATE;
    `);
    transactionOpen = true;
    const result = operation();
    database.exec('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen && database !== null) {
      try { database.exec('ROLLBACK'); } catch { /* preserve the operation error */ }
    }
    throw error;
  } finally {
    try {
      if (database !== null) database.close();
    } finally {
      closeSync(coordinatorDescriptor);
    }
  }
}

interface PortalFileLockOwnerIdentity {
  pid: number;
  recoveryClass: 'legacy' | 'guarded' | 'manual';
}

function parsePortalFileLockOwner(owner: string): PortalFileLockOwnerIdentity | null {
  const v2 = PORTAL_FILE_LOCK_V2_OWNER_PATTERN.exec(owner);
  if (v2) return { pid: Number(v2[1]), recoveryClass: 'legacy' };
  const v3 = PORTAL_FILE_LOCK_V3_OWNER_PATTERN.exec(owner);
  if (v3) {
    return {
      pid: Number(v3[1]),
      recoveryClass: v3[2] as 'guarded' | 'manual',
    };
  }
  return null;
}

/**
 * A stale mtime is not proof that the owner died: macOS sleep pauses the
 * heartbeat for every process. PID liveness turns that ambiguity into a safe
 * availability failure instead of allowing a second renderer to steal a live
 * lock. Both v2 and v3 owner records carry a PID; their recovery policy is
 * enforced separately by acquireOwnedFileLock().
 */
export function portalFileLockOwnerProcessAlive(owner: string): boolean {
  const identity = parsePortalFileLockOwner(owner);
  if (!identity) return false;
  const { pid } = identity;
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but this account cannot signal it.
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    // Unknown OS/process errors are not deletion authority. Fail closed.
    return true;
  }
}

function releasePortalFileLockIfOwnedInCoordinator(lockPath: string, owner: string): boolean {
  try {
    if (readFileSync(lockPath, 'utf8') !== owner) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function releasePortalFileLockIfOwned(lockPath: string, owner: string): boolean {
  if (!existsSync(lockPath)) return false;
  return withPortalFileLockCoordinator(
    lockPath,
    () => releasePortalFileLockIfOwnedInCoordinator(lockPath, owner),
  );
}

export async function acquireOwnedFileLock(
  lockPath: string,
  options: PortalFileLockOptions = {},
): Promise<OwnedFileLockRelease> {
  const attempts = options.attempts ?? 150;
  const retryMs = options.retryMs ?? 20;
  const staleAfterMs = options.staleAfterMs ?? 15_000;
  const deadOwnerGraceMs = options.deadOwnerGraceMs ?? 0;
  const label = options.label ?? 'portal.json';
  if (!Number.isInteger(attempts) || attempts < 1
    || !Number.isFinite(retryMs) || retryMs < 0
    || !Number.isFinite(staleAfterMs) || staleAfterMs < 1
    || !Number.isFinite(deadOwnerGraceMs) || deadOwnerGraceMs < 0
    || (options.canRecoverDeadOwner !== undefined
      && typeof options.canRecoverDeadOwner !== 'function')
    || (options.deadOwnerRecoveryClass !== undefined
      && options.deadOwnerRecoveryClass !== 'guarded'
      && options.deadOwnerRecoveryClass !== 'manual')) {
    throw new Error(`${label} 잠금 설정이 올바르지 않습니다.`);
  }
  if (!existsSync(dirname(lockPath))) mkdirSync(dirname(lockPath), { recursive: true });
  const ownerToken = randomBytes(16).toString('hex');
  const owner = options.deadOwnerRecoveryClass === undefined
    ? `v2:${process.pid}:${ownerToken}`
    : `v3:${process.pid}:${ownerToken}:${options.deadOwnerRecoveryClass}`;
  const canRecoverObservedOwner = (observedOwner: string): boolean => (
    options.canRecoverDeadOwner === undefined
      || options.canRecoverDeadOwner(observedOwner) === true
  );
  const canRecoverPidOwner = (
    observedOwner: string,
    identity: PortalFileLockOwnerIdentity,
  ): boolean => {
    if (identity.recoveryClass === 'manual') return false;
    if (identity.recoveryClass === 'guarded') {
      return options.canRecoverDeadOwner !== undefined
        && options.canRecoverDeadOwner(observedOwner) === true;
    }
    return canRecoverObservedOwner(observedOwner);
  };
  let observedDeadOwner: string | null = null;
  let manualRecoveryRequired = false;
  let deadOwnerFirstObservedAtMonotonicMs = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    manualRecoveryRequired = false;
    let outcome: 'acquired' | 'retry' | 'wait';
    try {
      outcome = withPortalFileLockCoordinator(lockPath, () => {
        let descriptor: number | null = null;
        try {
          descriptor = openSync(lockPath, 'wx', 0o600);
        } catch (error: any) {
          if (error?.code !== 'EEXIST') throw error;
        }
        if (descriptor !== null) {
          try {
            writeFileSync(descriptor, owner, 'utf8');
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = null;
          } catch (error) {
            if (descriptor !== null) {
              try { closeSync(descriptor); } catch { /* preserve the creation error */ }
            }
            descriptor = null;
            try { releasePortalFileLockIfOwnedInCoordinator(lockPath, owner); } catch {
              // The original creation error is the useful failure. A partial
              // owner file remains fail-closed if exact cleanup was uncertain.
            }
            throw error;
          }
          return 'acquired';
        }

        let stale = false;
        let observedOwner: string | null = null;
        try {
          observedOwner = readFileSync(lockPath, 'utf8');
          const ageMs = Date.now() - statSync(lockPath).mtimeMs;
          stale = ageMs > staleAfterMs;
          if (observedOwner !== null) {
            const ownerIdentity = parsePortalFileLockOwner(observedOwner);
            const hasPidIdentity = ownerIdentity !== null;
            const ownerAlive = portalFileLockOwnerProcessAlive(observedOwner);
            if (ownerIdentity && !ownerAlive) {
              const observedAtMonotonicMs = performance.now();
              if (observedDeadOwner !== observedOwner) {
                observedDeadOwner = observedOwner;
                deadOwnerFirstObservedAtMonotonicMs = observedAtMonotonicMs;
              }
              const deadOwnerGraceElapsed = observedAtMonotonicMs
                - deadOwnerFirstObservedAtMonotonicMs >= deadOwnerGraceMs;
              if (deadOwnerGraceElapsed) {
                if (!canRecoverPidOwner(observedOwner, ownerIdentity)) {
                  manualRecoveryRequired = ownerIdentity.recoveryClass === 'manual';
                  return 'wait';
                }
                releasePortalFileLockIfOwnedInCoordinator(lockPath, observedOwner);
                return 'retry';
              }
            } else {
              // A replacement owner must receive its own complete grace window.
              observedDeadOwner = null;
              deadOwnerFirstObservedAtMonotonicMs = 0;
            }
            // Legacy owners have no PID identity, so retain the compatibility
            // path that uses only their file age. A versioned owner never
            // bypasses its recovery class or grace through this stale branch.
            if (!hasPidIdentity && !ownerAlive && stale) {
              if (!canRecoverObservedOwner(observedOwner)) return 'wait';
              releasePortalFileLockIfOwnedInCoordinator(lockPath, observedOwner);
              return 'retry';
            }
          }
        } catch (statError: any) {
          if (statError?.code === 'ENOENT') {
            observedDeadOwner = null;
            deadOwnerFirstObservedAtMonotonicMs = 0;
            return 'retry';
          }
          throw statError;
        }
        return 'wait';
      });
    } catch (error: any) {
      throw new Error(`${label} 잠금 생성 실패: ${error?.message ?? String(error)}`);
    }

    if (outcome === 'acquired') {
      const release = (() => releasePortalFileLockIfOwned(lockPath, owner)) as OwnedFileLockRelease;
      release.refresh = () => {
        if (!existsSync(lockPath)) return false;
        return withPortalFileLockCoordinator(lockPath, () => {
          let descriptor: number | null = null;
          try {
            descriptor = openSync(lockPath, 'r');
            if (readFileSync(descriptor, 'utf8') !== owner) return false;
            const now = new Date();
            // Touch the opened inode, not a path that could have been replaced
            // after the ownership check.
            futimesSync(descriptor, now, now);
            return true;
          } catch (error: any) {
            if (error?.code === 'ENOENT') return false;
            throw error;
          } finally {
            if (descriptor !== null) closeSync(descriptor);
          }
        });
      };
      return release;
    }
    if (outcome === 'retry') continue;
    await sleep(retryMs);
  }
  const message = `${label} 저장 잠금을 ${attempts * retryMs}ms 안에 획득하지 못했습니다.`;
  if (manualRecoveryRequired) {
    throw Object.assign(new Error(`${message} 종료된 프로세스의 잠금이 남아 있습니다. 관련 작업 종료 확인 후 잠금 복구가 필요합니다.`), {
      code: 'FILE_LOCK_RECOVERY_REQUIRED',
    });
  }
  throw new Error(message);
}

export async function withOwnedPortalFileLock<T>(
  lockPath: string,
  operation: () => T | Promise<T>,
  options: PortalFileLockOptions = {},
): Promise<T> {
  const release = await acquireOwnedFileLock(lockPath, { label: 'portal.json', ...options });
  try {
    return await operation();
  } finally {
    try {
      release();
    } catch (error: any) {
      console.error(`[Portal] lock cleanup failed: ${error?.message ?? String(error)}`);
    }
  }
}
