import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import {
  acquireOwnedFileLock,
  type OwnedFileLockRelease,
} from './portalFileLock';

const WORKSPACE_LEASE_DIRECTORY = 'workspace-leases-v1';
const WORKSPACE_LEASE_LABEL = 'workspace lease';
const GIT_IDENTITY_TIMEOUT_MS = 5_000;
const GIT_IDENTITY_MAX_OUTPUT_BYTES = 64 * 1024;

export type WorkspaceLeaseErrorCode =
  | 'WORKSPACE_LEASE_BUSY'
  | 'WORKSPACE_LEASE_RECOVERY_REQUIRED'
  | 'WORKSPACE_LEASE_UNSAFE'
  | 'WORKSPACE_LEASE_IO';

/**
 * Crash-recovery authority for the process that owns this lease.
 *
 * `guarded` means only that a registered process group can be checked; it is
 * not proof against a setsid()/detached descendant and is retained for bounded
 * fixtures and migration. Production writers use `manual` until the host has
 * non-escapable containment. A manual dead owner's lock remains in place so
 * availability loses to the risk of overlapping writers.
 */
export type WorkspaceLeaseDeadOwnerRecoveryClass = 'guarded' | 'manual';

export class WorkspaceLeaseError extends Error {
  readonly code: WorkspaceLeaseErrorCode;

  constructor(code: WorkspaceLeaseErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WorkspaceLeaseError';
    this.code = code;
  }
}

export interface WorkspaceLeaseIdentity {
  /** Git linked worktrees share one family identity. Plain directories do not. */
  readonly kind: 'git-family' | 'directory';
  /** Opaque SHA-256 identity. This is safe to use as a filename or map key. */
  readonly key: string;
  /** Canonical directory selected by the caller, not the Git metadata path. */
  readonly canonicalWorkspacePath: string;
}

export interface WorkspaceLeaseAcquireInput {
  workspacePath: string;
  appDataDir: string;
  /** Absolute resolved Git path is recommended for GUI/sidecar processes. */
  gitExecutable?: string;
  attempts?: number;
  retryMs?: number;
  staleAfterMs?: number;
  deadOwnerGraceMs?: number;
  deadOwnerRecoveryClass?: WorkspaceLeaseDeadOwnerRecoveryClass;
  /** Positive crash fence required before reclaiming any dead sidecar owner. */
  canRecoverDeadOwner?: (owner: string) => boolean;
}

export type WorkspaceDirectoryLeaseAcquireInput = Omit<
  WorkspaceLeaseAcquireInput,
  'gitExecutable'
>;

export interface WorkspaceLeasePromotionInput {
  /** Absolute resolved Git path is recommended for GUI/sidecar processes. */
  gitExecutable?: string;
  attempts?: number;
  retryMs?: number;
  staleAfterMs?: number;
  deadOwnerGraceMs?: number;
  deadOwnerRecoveryClass?: WorkspaceLeaseDeadOwnerRecoveryClass;
  canRecoverDeadOwner?: (owner: string) => boolean;
}

export interface WorkspaceLease {
  readonly identity: WorkspaceLeaseIdentity;
  /** Always <canonical app-data>/workspace-leases-v1/<sha256>.lock. */
  readonly lockPath: string;
  /** Refreshes only the inode that still contains this process owner's token. */
  refresh(): boolean;
  /** Removes only the lock that still contains this process owner's token. */
  release(): boolean;
}

export interface WorkspaceDirectoryLease extends WorkspaceLease {
  /**
   * Adds the newly-created repository's family authority without reacquiring
   * this handle's canonical-directory owner lock.
   */
  promote(input?: WorkspaceLeasePromotionInput): Promise<WorkspaceLease>;
}

interface ResolvedWorkspaceIdentity {
  identity: WorkspaceLeaseIdentity;
  identitySource: string;
}

interface OwnedWorkspaceLeasePart {
  lockPath: string;
  ownedRelease: OwnedFileLockRelease;
}

type OwnedWorkspaceLeaseOptions = Pick<
  WorkspaceLeaseAcquireInput,
  | 'attempts'
  | 'retryMs'
  | 'staleAfterMs'
  | 'deadOwnerGraceMs'
  | 'deadOwnerRecoveryClass'
  | 'canRecoverDeadOwner'
>;

interface WorkspaceDirectoryLeaseState {
  status: 'directory' | 'promoting' | 'full' | 'released' | 'uncertain';
  identity: WorkspaceLeaseIdentity;
  representativeLockPath: string;
  readonly canonicalWorkspacePath: string;
  readonly leaseDirectory: string;
  readonly parts: OwnedWorkspaceLeasePart[];
}

const workspaceDirectoryLeaseStates = new WeakMap<
  WorkspaceDirectoryLease,
  WorkspaceDirectoryLeaseState
>();

function workspaceLeaseError(
  code: WorkspaceLeaseErrorCode,
  message: string,
  cause?: unknown,
): WorkspaceLeaseError {
  if (cause instanceof WorkspaceLeaseError) return cause;
  return new WorkspaceLeaseError(code, message, cause);
}

function canonicalExistingDirectory(
  requestedPath: string,
  purpose: 'workspace' | 'app-data',
): string {
  const label = purpose === 'workspace' ? '작업공간' : '앱 데이터';
  if (typeof requestedPath !== 'string'
    || requestedPath.length === 0
    || requestedPath.includes('\0')
    || !isAbsolute(requestedPath)) {
    throw workspaceLeaseError('WORKSPACE_LEASE_UNSAFE', `${label} 경로가 안전하지 않습니다.`);
  }

  const normalized = resolve(requestedPath);
  if (normalized === parse(normalized).root) {
    throw workspaceLeaseError('WORKSPACE_LEASE_UNSAFE', `${label} 경로가 안전하지 않습니다.`);
  }

  try {
    const canonical = realpathSync(normalized);
    if (!statSync(canonical).isDirectory()) {
      throw workspaceLeaseError('WORKSPACE_LEASE_UNSAFE', `${label}은 기존 디렉터리여야 합니다.`);
    }
    return canonical;
  } catch (error: any) {
    if (error instanceof WorkspaceLeaseError) throw error;
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EINVAL') {
      throw workspaceLeaseError('WORKSPACE_LEASE_UNSAFE', `${label}은 기존 디렉터리여야 합니다.`, error);
    }
    throw workspaceLeaseError('WORKSPACE_LEASE_IO', `${label}을 확인할 수 없습니다.`, error);
  }
}

function findGitMarker(startDirectory: string): boolean {
  let cursor = startDirectory;
  while (true) {
    try {
      // A directory marks a primary worktree; a regular file marks a linked
      // worktree. Other entry types still require Git to fail closed below.
      lstatSync(join(cursor, '.git'));
      return true;
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw workspaceLeaseError(
          'WORKSPACE_LEASE_IO',
          'Git 작업공간 메타데이터를 확인할 수 없습니다.',
          error,
        );
      }
    }
    const parent = resolve(cursor, '..');
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function gitProbeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A launcher-controlled GIT_DIR/GIT_WORK_TREE must not make an unrelated
  // workspace acquire a different repository's mutation authority.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.LC_ALL = 'C';
  return env;
}

function removeOneLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

function resolveGitExecutable(requested: string | undefined): string {
  if (requested === undefined) return 'git';
  if (typeof requested !== 'string'
    || requested.length === 0
    || requested.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(requested)) {
    throw workspaceLeaseError('WORKSPACE_LEASE_UNSAFE', 'Git 실행기 경로가 안전하지 않습니다.');
  }
  return requested;
}

function directoryWorkspaceIdentity(canonicalWorkspacePath: string): ResolvedWorkspaceIdentity {
  const identitySource = `directory-v1\0${canonicalWorkspacePath}`;
  return {
    identitySource,
    identity: {
      kind: 'directory',
      key: createHash('sha256').update(identitySource).digest('hex'),
      canonicalWorkspacePath,
    },
  };
}

function resolveGitFamilyIdentity(
  canonicalWorkspacePath: string,
  gitExecutable: string | undefined,
): ResolvedWorkspaceIdentity | null {
  const gitMarkerPresent = findGitMarker(canonicalWorkspacePath);
  const probe = spawnSync(
    resolveGitExecutable(gitExecutable),
    ['-C', canonicalWorkspacePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    {
      encoding: 'utf8',
      env: gitProbeEnvironment(),
      maxBuffer: GIT_IDENTITY_MAX_OUTPUT_BYTES,
      timeout: GIT_IDENTITY_TIMEOUT_MS,
      windowsHide: true,
    },
  );

  if (probe.status === 0 && !probe.error) {
    const commonDirectoryOutput = removeOneLineEnding(probe.stdout ?? '');
    if (!commonDirectoryOutput
      || /[\u0000-\u001f\u007f]/u.test(commonDirectoryOutput)
      || !isAbsolute(commonDirectoryOutput)) {
      throw workspaceLeaseError(
        'WORKSPACE_LEASE_UNSAFE',
        'Git 공통 디렉터리 응답이 안전하지 않습니다.',
      );
    }

    let canonicalCommonDirectory: string;
    try {
      canonicalCommonDirectory = realpathSync(commonDirectoryOutput);
      if (!statSync(canonicalCommonDirectory).isDirectory()) {
        throw workspaceLeaseError(
          'WORKSPACE_LEASE_UNSAFE',
          'Git 공통 디렉터리가 안전하지 않습니다.',
        );
      }
    } catch (error: any) {
      if (error instanceof WorkspaceLeaseError) throw error;
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EINVAL') {
        throw workspaceLeaseError(
          'WORKSPACE_LEASE_UNSAFE',
          'Git 공통 디렉터리가 안전하지 않습니다.',
          error,
        );
      }
      throw workspaceLeaseError(
        'WORKSPACE_LEASE_IO',
        'Git 공통 디렉터리를 확인할 수 없습니다.',
        error,
      );
    }

    const identitySource = `git-family-v1\0${canonicalCommonDirectory}`;
    return {
      identitySource,
      identity: {
        kind: 'git-family',
        key: createHash('sha256').update(identitySource).digest('hex'),
        canonicalWorkspacePath,
      },
    };
  }

  // A physical .git marker means Git recognized repository intent but could
  // not prove its common authority (corruption, dubious ownership, missing
  // executable, timeout, etc.). Treating that as a plain folder would permit
  // sibling worktrees to mutate concurrently, so fail closed.
  if (probe.error || probe.status === null || gitMarkerPresent) {
    throw workspaceLeaseError(
      'WORKSPACE_LEASE_IO',
      'Git 작업공간의 공통 잠금 대상을 확인할 수 없습니다.',
      probe.error,
    );
  }

  return null;
}

function isContainedPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== '' && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(child);
}

function prepareLeaseDirectory(appDataDir: string): string {
  if (typeof appDataDir !== 'string'
    || appDataDir.length === 0
    || appDataDir.includes('\0')
    || !isAbsolute(appDataDir)) {
    throw workspaceLeaseError('WORKSPACE_LEASE_UNSAFE', '앱 데이터 경로가 안전하지 않습니다.');
  }

  const normalized = resolve(appDataDir);
  if (normalized === parse(normalized).root) {
    throw workspaceLeaseError('WORKSPACE_LEASE_UNSAFE', '앱 데이터 경로가 안전하지 않습니다.');
  }

  try {
    mkdirSync(normalized, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw workspaceLeaseError('WORKSPACE_LEASE_IO', '앱 데이터 디렉터리를 준비할 수 없습니다.', error);
  }
  const canonicalAppDataDir = canonicalExistingDirectory(normalized, 'app-data');
  const requestedLeaseDirectory = join(canonicalAppDataDir, WORKSPACE_LEASE_DIRECTORY);

  try {
    mkdirSync(requestedLeaseDirectory, { recursive: false, mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') {
      throw workspaceLeaseError('WORKSPACE_LEASE_IO', '작업공간 잠금 디렉터리를 준비할 수 없습니다.', error);
    }
  }

  try {
    const entry = lstatSync(requestedLeaseDirectory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw workspaceLeaseError(
        'WORKSPACE_LEASE_UNSAFE',
        '작업공간 잠금 디렉터리가 안전하지 않습니다.',
      );
    }
    if (process.platform !== 'win32') {
      if (typeof process.geteuid === 'function' && entry.uid !== process.geteuid()) {
        throw workspaceLeaseError(
          'WORKSPACE_LEASE_UNSAFE',
          '작업공간 잠금 디렉터리 소유권이 안전하지 않습니다.',
        );
      }
      chmodSync(requestedLeaseDirectory, 0o700);
    }
    const canonicalLeaseDirectory = realpathSync(requestedLeaseDirectory);
    if (!isContainedPath(canonicalAppDataDir, canonicalLeaseDirectory)) {
      throw workspaceLeaseError(
        'WORKSPACE_LEASE_UNSAFE',
        '작업공간 잠금 디렉터리가 앱 데이터 밖에 있습니다.',
      );
    }
    return canonicalLeaseDirectory;
  } catch (error) {
    if (error instanceof WorkspaceLeaseError) throw error;
    throw workspaceLeaseError('WORKSPACE_LEASE_IO', '작업공간 잠금 디렉터리를 확인할 수 없습니다.', error);
  }
}

function classifyOwnedLockError(error: unknown): WorkspaceLeaseError {
  if (error instanceof WorkspaceLeaseError) return error;
  if (error instanceof Error && 'code' in error && error.code === 'FILE_LOCK_RECOVERY_REQUIRED') {
    return workspaceLeaseError('WORKSPACE_LEASE_RECOVERY_REQUIRED',
      '종료된 프로세스의 작업공간 잠금이 남아 있습니다. 관련 작업 종료 확인 후 잠금 복구가 필요합니다.', error);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(`${WORKSPACE_LEASE_LABEL} 저장 잠금을`)
    || /SQLITE_BUSY|database is (?:locked|busy)/i.test(message)) {
    return workspaceLeaseError('WORKSPACE_LEASE_BUSY', '작업공간이 다른 작업에서 사용 중입니다.', error);
  }
  if (message.includes('안전하지 않습니다') || message.includes('소유권이 안전하지 않습니다')) {
    return workspaceLeaseError('WORKSPACE_LEASE_UNSAFE', '작업공간 잠금 저장소가 안전하지 않습니다.', error);
  }
  return workspaceLeaseError('WORKSPACE_LEASE_IO', '작업공간 잠금을 처리할 수 없습니다.', error);
}

function lockPathForIdentity(leaseDirectory: string, identitySource: string): string {
  // The digest is the only workspace material that appears below app-data.
  const lockKey = createHash('sha256').update(identitySource).digest('hex');
  return join(leaseDirectory, `${lockKey}.lock`);
}

async function acquireWorkspaceLeasePart(
  leaseDirectory: string,
  identitySource: string,
  input: OwnedWorkspaceLeaseOptions,
): Promise<OwnedWorkspaceLeasePart> {
  const lockPath = lockPathForIdentity(leaseDirectory, identitySource);
  try {
    return {
      lockPath,
      ownedRelease: await acquireOwnedFileLock(lockPath, {
        attempts: input.attempts,
        retryMs: input.retryMs,
        staleAfterMs: input.staleAfterMs,
        deadOwnerGraceMs: input.deadOwnerGraceMs,
        deadOwnerRecoveryClass: input.deadOwnerRecoveryClass,
        canRecoverDeadOwner: input.canRecoverDeadOwner,
        label: WORKSPACE_LEASE_LABEL,
      }),
    };
  } catch (error) {
    throw classifyOwnedLockError(error);
  }
}

function operateEveryLeasePart(
  parts: readonly OwnedWorkspaceLeasePart[],
  operation: 'refresh' | 'release',
): boolean {
  let allCertain = true;
  let firstError: WorkspaceLeaseError | null = null;
  for (const part of parts) {
    try {
      const succeeded = operation === 'refresh'
        ? part.ownedRelease.refresh()
        : part.ownedRelease();
      if (!succeeded) allCertain = false;
    } catch (error) {
      allCertain = false;
      if (firstError === null) firstError = classifyOwnedLockError(error);
    }
  }
  if (firstError !== null) throw firstError;
  return allCertain;
}

function cleanupPartialLeaseOrThrow(
  parts: readonly OwnedWorkspaceLeasePart[],
  acquisitionError: unknown,
): never {
  let cleanupCertain = false;
  try {
    cleanupCertain = operateEveryLeasePart([...parts].reverse(), 'release');
  } catch (cleanupError) {
    throw workspaceLeaseError(
      'WORKSPACE_LEASE_IO',
      '부분 작업공간 잠금의 정리를 확인할 수 없습니다.',
      cleanupError,
    );
  }
  if (!cleanupCertain) {
    throw workspaceLeaseError(
      'WORKSPACE_LEASE_IO',
      '부분 작업공간 잠금의 소유권을 확인할 수 없습니다.',
      acquisitionError,
    );
  }
  throw classifyOwnedLockError(acquisitionError);
}

function compositeWorkspaceLease(
  identity: WorkspaceLeaseIdentity,
  representativeLockPath: string,
  acquisitionOrder: readonly OwnedWorkspaceLeasePart[],
): WorkspaceLease {
  const refreshOrder = [...acquisitionOrder];
  const releaseOrder = [...acquisitionOrder].reverse();
  return Object.freeze({
    identity,
    lockPath: representativeLockPath,
    refresh: () => operateEveryLeasePart(refreshOrder, 'refresh'),
    release: () => operateEveryLeasePart(releaseOrder, 'release'),
  });
}

function workspaceDirectoryLeaseHandle(
  state: WorkspaceDirectoryLeaseState,
): WorkspaceDirectoryLease {
  let handle: WorkspaceDirectoryLease;
  handle = Object.freeze({
    get identity() {
      return state.identity;
    },
    get lockPath() {
      return state.representativeLockPath;
    },
    refresh: () => {
      return operateEveryLeasePart(state.parts, 'refresh');
    },
    release: () => {
      // Releasing the directory while an async family acquisition is pending
      // would allow another writer through the exact transition window this
      // primitive exists to close. Keep ownership and require a later retry.
      if (state.status === 'promoting') {
        throw workspaceLeaseError(
          'WORKSPACE_LEASE_BUSY',
          '작업공간 잠금 승격이 진행 중입니다.',
        );
      }
      try {
        const released = operateEveryLeasePart([...state.parts].reverse(), 'release');
        state.status = released ? 'released' : 'uncertain';
        return released;
      } catch (error) {
        state.status = 'uncertain';
        throw error;
      }
    },
    promote: (input: WorkspaceLeasePromotionInput = {}) => (
      promoteWorkspaceDirectoryLease(handle, input)
    ),
  });
  workspaceDirectoryLeaseStates.set(handle, state);
  return handle;
}

function validatePromotionInput(input: WorkspaceLeasePromotionInput): void {
  if (!input || typeof input !== 'object') {
    throw workspaceLeaseError('WORKSPACE_LEASE_UNSAFE', '작업공간 잠금 승격 요청이 올바르지 않습니다.');
  }
}

/**
 * Promote an owned canonical-directory reservation in place. The returned
 * handle is the same object, but now refresh/release cover directory + family
 * and its public identity/representative lock describe the Git family.
 *
 * A failed family acquisition leaves the directory reservation owned so the
 * caller can roll back the child publication or retry. An uncertain cleanup is
 * retained in the handle and surfaced as WORKSPACE_LEASE_IO.
 */
export async function promoteWorkspaceDirectoryLease(
  lease: WorkspaceDirectoryLease,
  input: WorkspaceLeasePromotionInput = {},
): Promise<WorkspaceLease> {
  validatePromotionInput(input);
  const state = workspaceDirectoryLeaseStates.get(lease);
  if (!state) {
    throw workspaceLeaseError(
      'WORKSPACE_LEASE_UNSAFE',
      '승격할 디렉터리 잠금의 소유권을 확인할 수 없습니다.',
    );
  }
  if (state.status !== 'directory') {
    throw workspaceLeaseError(
      state.status === 'promoting' ? 'WORKSPACE_LEASE_BUSY' : 'WORKSPACE_LEASE_UNSAFE',
      state.status === 'promoting'
        ? '작업공간 잠금 승격이 이미 진행 중입니다.'
        : '디렉터리 잠금은 한 번만 승격할 수 있습니다.',
    );
  }

  state.status = 'promoting';
  let familyPart: OwnedWorkspaceLeasePart | null = null;
  try {
    const currentCanonicalPath = canonicalExistingDirectory(
      state.canonicalWorkspacePath,
      'workspace',
    );
    if (currentCanonicalPath !== state.canonicalWorkspacePath) {
      throw workspaceLeaseError(
        'WORKSPACE_LEASE_UNSAFE',
        '승격할 작업공간 경로가 예약 후 변경되었습니다.',
      );
    }

    const gitIdentity = resolveGitFamilyIdentity(currentCanonicalPath, input.gitExecutable);
    if (gitIdentity === null) {
      throw workspaceLeaseError(
        'WORKSPACE_LEASE_UNSAFE',
        '디렉터리 잠금을 승격하려면 Git 저장소가 먼저 준비되어야 합니다.',
      );
    }

    familyPart = await acquireWorkspaceLeasePart(
      state.leaseDirectory,
      gitIdentity.identitySource,
      input,
    );

    // The Git common directory can change while waiting for its authority.
    // Re-probe under both locks and reject a stale family without ever dropping
    // the directory reservation.
    const stableGitIdentity = resolveGitFamilyIdentity(currentCanonicalPath, input.gitExecutable);
    if (stableGitIdentity === null || stableGitIdentity.identity.key !== gitIdentity.identity.key) {
      throw workspaceLeaseError(
        'WORKSPACE_LEASE_UNSAFE',
        'Git 작업공간 잠금 대상이 승격 중 변경되었습니다.',
      );
    }

    state.parts.push(familyPart);
    familyPart = null;
    state.identity = gitIdentity.identity;
    state.representativeLockPath = state.parts[state.parts.length - 1]!.lockPath;
    state.status = 'full';
    return lease;
  } catch (error) {
    if (familyPart !== null) {
      let cleanupCertain: boolean;
      try {
        cleanupCertain = operateEveryLeasePart([familyPart], 'release');
      } catch (cleanupError) {
        state.parts.push(familyPart);
        state.status = 'uncertain';
        throw workspaceLeaseError(
          'WORKSPACE_LEASE_IO',
          '승격 중 획득한 Git 잠금의 정리를 확인할 수 없습니다.',
          cleanupError,
        );
      }
      if (!cleanupCertain) {
        state.parts.push(familyPart);
        state.status = 'uncertain';
        throw workspaceLeaseError(
          'WORKSPACE_LEASE_IO',
          '승격 중 획득한 Git 잠금의 정리를 확인할 수 없습니다.',
          error,
        );
      }
    }
    state.status = 'directory';
    throw classifyOwnedLockError(error);
  }
}

function validateWorkspaceLeaseInput(
  input: WorkspaceLeaseAcquireInput | WorkspaceDirectoryLeaseAcquireInput,
): void {
  if (!input || typeof input !== 'object') {
    throw workspaceLeaseError('WORKSPACE_LEASE_UNSAFE', '작업공간 잠금 요청이 올바르지 않습니다.');
  }
}

async function acquireDirectoryLeaseFoundation(
  input: WorkspaceLeaseAcquireInput | WorkspaceDirectoryLeaseAcquireInput,
): Promise<{
  directoryIdentity: ResolvedWorkspaceIdentity;
  directoryPart: OwnedWorkspaceLeasePart;
  leaseDirectory: string;
}> {
  validateWorkspaceLeaseInput(input);
  const canonicalWorkspacePath = canonicalExistingDirectory(input.workspacePath, 'workspace');
  const leaseDirectory = prepareLeaseDirectory(input.appDataDir);
  const directoryIdentity = directoryWorkspaceIdentity(canonicalWorkspacePath);
  const directoryPart = await acquireWorkspaceLeasePart(
    leaseDirectory,
    directoryIdentity.identitySource,
    input,
  );
  return { directoryIdentity, directoryPart, leaseDirectory };
}

/**
 * Reserve only one existing canonical directory, even when it is inside a Git
 * repository. This deliberately does not probe or acquire the Git family.
 *
 * The narrow primitive is for a parent root while creating a not-yet-existing
 * child name. General workspace mutations must use acquireWorkspaceLease().
 */
export async function acquireWorkspaceDirectoryLease(
  input: WorkspaceDirectoryLeaseAcquireInput,
): Promise<WorkspaceDirectoryLease> {
  const { directoryIdentity, directoryPart, leaseDirectory } = await acquireDirectoryLeaseFoundation(input);
  return workspaceDirectoryLeaseHandle({
    status: 'directory',
    identity: directoryIdentity.identity,
    representativeLockPath: directoryPart.lockPath,
    canonicalWorkspacePath: directoryIdentity.identity.canonicalWorkspacePath,
    leaseDirectory,
    parts: [directoryPart],
  });
}

export async function acquireWorkspaceLease(
  input: WorkspaceLeaseAcquireInput,
): Promise<WorkspaceLease> {
  // Every workspace first takes its canonical-directory authority. This lock
  // remains stable while `.git` is created, removed, or moved, closing the
  // namespace split between a formerly plain directory and its Git family.
  let foundation: Awaited<ReturnType<typeof acquireDirectoryLeaseFoundation>>;
  try {
    foundation = await acquireDirectoryLeaseFoundation(input);
  } catch (error) {
    throw classifyOwnedLockError(error);
  }
  const {
    directoryIdentity,
    directoryPart,
    leaseDirectory,
  } = foundation;
  const canonicalWorkspacePath = directoryIdentity.identity.canonicalWorkspacePath;
  const acquiredParts: OwnedWorkspaceLeasePart[] = [directoryPart];

  try {
    const gitIdentity = resolveGitFamilyIdentity(canonicalWorkspacePath, input.gitExecutable);
    if (gitIdentity === null) {
      const directoryPart = acquiredParts[0];
      if (!directoryPart) {
        throw workspaceLeaseError('WORKSPACE_LEASE_IO', '디렉터리 잠금 상태를 확인할 수 없습니다.');
      }
      return compositeWorkspaceLease(
        directoryIdentity.identity,
        directoryPart.lockPath,
        acquiredParts,
      );
    }

    const familyPart = await acquireWorkspaceLeasePart(
      leaseDirectory,
      gitIdentity.identitySource,
      input,
    );
    acquiredParts.push(familyPart);

    // Another worktree can legitimately change shared Git metadata while this
    // caller waits for the family lock. Re-probe only after both authorities
    // are held; never continue under a stale family namespace.
    const stableGitIdentity = resolveGitFamilyIdentity(canonicalWorkspacePath, input.gitExecutable);
    if (stableGitIdentity === null || stableGitIdentity.identity.key !== gitIdentity.identity.key) {
      throw workspaceLeaseError(
        'WORKSPACE_LEASE_UNSAFE',
        'Git 작업공간 잠금 대상이 획득 중 변경되었습니다.',
      );
    }

    return compositeWorkspaceLease(
      gitIdentity.identity,
      familyPart.lockPath,
      acquiredParts,
    );
  } catch (error) {
    cleanupPartialLeaseOrThrow(acquiredParts, error);
  }
}
