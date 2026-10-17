import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseGitWorktreePorcelain } from '../git-worktree-list';
import { RemoteControlError } from './remoteControlCore';

export interface RemoteControlGitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RemoteControlGitRunner = (
  cwd: string,
  args: string[],
  timeoutMs?: number,
) => Promise<RemoteControlGitCommandResult>;

type TrustedRemoteCheck = (value: string) => boolean;

function parseAheadBehind(value: string): { ahead: number; behind: number } | null {
  const match = value.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) return null;
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

function normalizeWorktreePath(value: string): string {
  const resolved = resolve(value);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // The caller reports the more specific missing/unregistered target error.
  }
  const normalized = canonical.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

const gitWorktreeListArgs = (): string[] => [
  '-c',
  'core.quotePath=false',
  'worktree',
  'list',
  '--porcelain',
];

export async function executeRemoteControlSafePull(input: {
  workingPath: string;
  runGit: RemoteControlGitRunner;
  isTrustedRemote: TrustedRemoteCheck;
}): Promise<void> {
  const { workingPath, runGit, isTrustedRemote } = input;
  const status = await runGit(workingPath, ['status', '--porcelain', '--untracked-files=normal'], 5_000);
  if (!status.ok || status.stdout.trim()) {
    throw new RemoteControlError('GIT_WORKTREE_DIRTY', '미커밋 변경이 있어 Pull하지 않았습니다. 먼저 커밋하세요.', 409);
  }
  const branchResult = await runGit(workingPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5_000);
  const branch = branchResult.ok ? branchResult.stdout.trim() : '';
  if (!branch) {
    throw new RemoteControlError('DETACHED_HEAD', '분리된 HEAD 상태에서는 Pull할 수 없습니다.', 409);
  }
  const origin = await runGit(workingPath, ['remote', 'get-url', 'origin'], 5_000);
  if (!origin.ok || !isTrustedRemote(origin.stdout)) {
    throw new RemoteControlError('GITHUB_REMOTE_REQUIRED', '검증된 GitHub origin이 없어 Pull하지 않았습니다.', 409);
  }
  const fetched = await runGit(workingPath, ['fetch', '--prune', 'origin'], 30_000);
  if (!fetched.ok) {
    throw new RemoteControlError('GIT_FETCH_FAILED', 'GitHub의 현재 브랜치를 가져오지 못해 Pull하지 않았습니다.', 502);
  }
  const relationResult = await runGit(
    workingPath,
    ['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`],
    5_000,
  );
  const relation = relationResult.ok ? parseAheadBehind(relationResult.stdout) : null;
  if (!relation) {
    throw new RemoteControlError('GIT_RELATION_UNKNOWN', '로컬과 GitHub 브랜치 관계를 확인하지 못해 Pull하지 않았습니다.', 409);
  }
  if (relation.ahead > 0 && relation.behind > 0) {
    throw new RemoteControlError('GIT_BRANCH_DIVERGED', '로컬과 GitHub 브랜치가 서로 갈라져 자동 Pull하지 않았습니다.', 409);
  }
  if (relation.behind === 0) return;
  const fastForward = await runGit(workingPath, ['merge', '--ff-only', `origin/${branch}`], 15_000);
  if (!fastForward.ok) {
    throw new RemoteControlError('GIT_PULL_NOT_FAST_FORWARD', 'fast-forward로 안전하게 Pull할 수 없어 변경하지 않았습니다.', 409);
  }
}

export async function executeRemoteControlSafePush(input: {
  workingPath: string;
  runGit: RemoteControlGitRunner;
  isTrustedRemote: TrustedRemoteCheck;
}): Promise<void> {
  const { workingPath, runGit, isTrustedRemote } = input;
  const branchResult = await runGit(workingPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5_000);
  const branch = branchResult.ok ? branchResult.stdout.trim() : '';
  if (!branch) {
    throw new RemoteControlError('DETACHED_HEAD', '분리된 HEAD 상태에서는 Push할 수 없습니다.', 409);
  }
  const pushDestinations = await runGit(workingPath, ['remote', 'get-url', '--push', '--all', 'origin'], 5_000);
  const pushUrls = pushDestinations.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!pushDestinations.ok || pushUrls.length === 0 || pushUrls.some(value => !isTrustedRemote(value))) {
    throw new RemoteControlError('GITHUB_REMOTE_REQUIRED', '검증된 GitHub Push 목적지가 없어 Push하지 않았습니다.', 409);
  }
  const pushed = await runGit(workingPath, ['push', '--set-upstream', 'origin', branch], 30_000);
  if (!pushed.ok) {
    throw new RemoteControlError('GIT_PUSH_FAILED', 'GitHub Push를 완료하지 못했습니다. 원격 변경과 권한을 확인하세요.', 409);
  }
}

export async function executeRemoteControlSafeMerge(input: {
  worktreePath?: string;
  runGit: RemoteControlGitRunner;
  isTrustedRemote: TrustedRemoteCheck;
}): Promise<void> {
  const { runGit, isTrustedRemote } = input;
  const requestedPath = input.worktreePath;
  if (!requestedPath) {
    throw new RemoteControlError('ACTION_NOT_AVAILABLE', '병합은 워크트리 카드에서만 실행할 수 있습니다.', 409);
  }
  const listed = await runGit(requestedPath, gitWorktreeListArgs(), 5_000);
  if (!listed.ok) throw new RemoteControlError('GIT_STATUS_FAILED', 'Git 워크트리 상태를 확인하지 못했습니다.', 409);
  const worktrees = parseGitWorktreePorcelain(listed.stdout);
  const normalizedRequested = normalizeWorktreePath(requestedPath);
  const selected = worktrees.find(entry => normalizeWorktreePath(entry.path) === normalizedRequested);
  const primary = worktrees[0];
  const featureBranch = selected?.branch ?? '';
  const primaryBranch = primary?.branch ?? '';
  if (!selected || selected.isMain || selected.detached || !featureBranch || !primary?.path || !primaryBranch) {
    throw new RemoteControlError('GIT_MERGE_TARGET_INVALID', '브랜치가 연결된 보조 워크트리에서만 병합할 수 있습니다.', 409);
  }
  if (selected.locked) {
    throw new RemoteControlError('WORKTREE_LOCKED', '이 워크트리는 사용 중이라 병합할 수 없습니다. 열린 세션을 먼저 종료하세요.', 409);
  }
  for (const [path, label] of [[selected.path, '워크트리'], [primary.path, '기본 워크트리']] as const) {
    const status = await runGit(path, ['status', '--porcelain', '--untracked-files=normal'], 5_000);
    if (!status.ok || status.stdout.trim()) {
      throw new RemoteControlError('GIT_WORKTREE_DIRTY', `${label}에 미커밋 변경이 있어 병합하지 않았습니다. 먼저 커밋하세요.`, 409);
    }
  }
  const origin = await runGit(primary.path, ['remote', 'get-url', 'origin'], 5_000);
  if (!origin.ok || !isTrustedRemote(origin.stdout)) {
    throw new RemoteControlError('GITHUB_REMOTE_REQUIRED', '검증된 GitHub origin이 없어 병합하지 않았습니다.', 409);
  }
  const remoteHead = await runGit(primary.path, ['ls-remote', '--symref', 'origin', 'HEAD'], 15_000);
  const defaultMatch = remoteHead.ok ? remoteHead.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m) : null;
  const defaultBranch = defaultMatch?.[1] ?? '';
  if (!defaultBranch || primaryBranch !== defaultBranch) {
    throw new RemoteControlError(
      'DEFAULT_BRANCH_MISMATCH',
      defaultBranch
        ? `기본 워크트리가 원격 기본 브랜치(${defaultBranch})가 아니어서 병합하지 않았습니다.`
        : '원격 기본 브랜치를 확인하지 못해 병합하지 않았습니다.',
      409,
    );
  }
  const fetched = await runGit(primary.path, ['fetch', '--prune', 'origin'], 30_000);
  if (!fetched.ok) throw new RemoteControlError('GIT_FETCH_FAILED', 'GitHub 최신 상태를 가져오지 못해 병합하지 않았습니다.', 502);
  const primaryRelationResult = await runGit(
    primary.path,
    ['rev-list', '--left-right', '--count', `${primaryBranch}...origin/${defaultBranch}`],
    5_000,
  );
  const primaryRelation = primaryRelationResult.ok ? parseAheadBehind(primaryRelationResult.stdout) : null;
  if (!primaryRelation || primaryRelation.ahead > 0) {
    throw new RemoteControlError('DEFAULT_BRANCH_DIVERGED', '기본 브랜치에 아직 원격과 합의되지 않은 커밋이 있어 병합하지 않았습니다.', 409);
  }
  if (primaryRelation.behind > 0) {
    const fastForward = await runGit(primary.path, ['merge', '--ff-only', `origin/${defaultBranch}`], 15_000);
    if (!fastForward.ok) throw new RemoteControlError('DEFAULT_BRANCH_UPDATE_FAILED', '원격 기본 브랜치를 fast-forward하지 못해 병합하지 않았습니다.', 409);
  }
  const featureRelationResult = await runGit(
    selected.path,
    ['rev-list', '--left-right', '--count', `${featureBranch}...origin/${featureBranch}`],
    5_000,
  );
  const featureRelation = featureRelationResult.ok ? parseAheadBehind(featureRelationResult.stdout) : null;
  if (!featureRelation || featureRelation.ahead !== 0 || featureRelation.behind !== 0) {
    throw new RemoteControlError('FEATURE_BRANCH_NOT_PUSHED', '워크트리 브랜치를 GitHub에 Push해 원격과 같은 상태로 만든 뒤 병합하세요.', 409);
  }
  // `git merge` exits 0 with "Already up to date." when the branch is a
  // no-op, so an unconditional success reply told the phone a merge had
  // happened when nothing had. Say so instead of claiming work was done.
  const alreadyMerged = await runGit(
    primary.path,
    ['merge-base', '--is-ancestor', featureBranch, primaryBranch],
    5_000,
  );
  if (alreadyMerged.ok) {
    throw new RemoteControlError(
      'GIT_MERGE_NOTHING_TO_DO',
      '이 워크트리 브랜치는 이미 기본 브랜치에 반영되어 있어 병합할 것이 없습니다.',
      409,
    );
  }
  const preview = await runGit(primary.path, ['merge-tree', '--write-tree', primaryBranch, featureBranch], 15_000);
  if (!preview.ok) {
    throw new RemoteControlError('GIT_MERGE_CONFLICT', '병합 충돌 가능성이 확인되어 기본 워크트리를 변경하지 않았습니다.', 409);
  }
  const merged = await runGit(primary.path, ['merge', '--no-ff', '--no-edit', featureBranch], 30_000);
  if (!merged.ok) {
    if (existsSync(join(primary.path, '.git', 'MERGE_HEAD'))) {
      await runGit(primary.path, ['merge', '--abort'], 10_000).catch(() => undefined);
    }
    throw new RemoteControlError('GIT_MERGE_FAILED', '병합을 완료하지 못해 진행 중인 병합을 취소했습니다.', 409);
  }
}
