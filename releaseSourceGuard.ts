export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (args: string[]) => GitCommandResult;

export interface ReleaseSource {
  headSha: string;
  currentBranch: string | null;
  remote: string;
  remoteUrl: string;
  defaultBranch: string;
  remoteHeadSha: string;
  unpublishedOverride: boolean;
}

const fullSha = /^[0-9a-f]{40}$/;

function requireGit(runGit: GitCommandRunner, args: string[], description: string): string {
  const result = runGit(args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`[release-source] ${description} 실패: ${detail}`);
  }
  return result.stdout.trim();
}

export function parseRemoteDefaultHead(output: string): { defaultBranch: string; remoteHeadSha: string } {
  const symref = output.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m);
  const head = output.match(/^([0-9a-f]{40})\s+HEAD$/m);
  if (!symref || !head) {
    throw new Error('[release-source] 원격의 실제 기본 브랜치와 HEAD를 확인할 수 없습니다. 원격 HEAD 설정을 확인하세요.');
  }
  return { defaultBranch: symref[1]!, remoteHeadSha: head[1]! };
}

/**
 * A release build is allowed only from a clean snapshot already published at
 * the live remote default HEAD. This deliberately compares commit identity,
 * not a remembered branch name: clean linked/detached worktrees at the exact
 * published commit are safe, while an unmerged feature branch is not.
 */
export function verifyReleaseSource({
  runGit,
  remote = 'origin',
  allowUnpublishedSource = false,
}: {
  runGit: GitCommandRunner;
  remote?: string;
  allowUnpublishedSource?: boolean;
}): ReleaseSource {
  const status = requireGit(runGit, ['status', '--porcelain=v1', '--untracked-files=all'], 'worktree 상태 확인');
  if (status) {
    const preview = status.split('\n').slice(0, 8).join('\n');
    throw new Error(
      `[release-source] 빌드 전 worktree가 깨끗해야 합니다. 버전 증가 전에 중단했습니다.\n${preview}`,
    );
  }

  const headSha = requireGit(runGit, ['rev-parse', 'HEAD'], '현재 HEAD 확인');
  if (!fullSha.test(headSha)) {
    throw new Error(`[release-source] 유효하지 않은 HEAD SHA입니다: ${headSha}`);
  }
  const branchResult = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const currentBranch = branchResult.exitCode === 0 && branchResult.stdout.trim()
    ? branchResult.stdout.trim()
    : null;
  const remoteUrl = requireGit(runGit, ['remote', 'get-url', remote], `${remote} URL 확인`);

  if (allowUnpublishedSource) {
    return {
      headSha,
      currentBranch,
      remote,
      remoteUrl,
      defaultBranch: '',
      remoteHeadSha: '',
      unpublishedOverride: true,
    };
  }

  // ls-remote reads the server's current HEAD directly. A stale local
  // refs/remotes/<remote>/HEAD cannot accidentally authorize a release.
  const remoteHead = requireGit(runGit, ['ls-remote', '--symref', remote, 'HEAD'], `${remote} 기본 브랜치 조회`);
  const { defaultBranch, remoteHeadSha } = parseRemoteDefaultHead(remoteHead);
  if (headSha !== remoteHeadSha) {
    throw new Error(
      `[release-source] 미병합·미푸시 소스에서는 공식 앱을 빌드할 수 없습니다.\n`
      + `현재 HEAD: ${headSha}\n`
      + `원격 기본 브랜치 ${remote}/${defaultBranch}: ${remoteHeadSha}\n`
      + '변경을 기본 브랜치에 안전하게 병합·push한 뒤 다시 빌드하세요.',
    );
  }

  return {
    headSha,
    currentBranch,
    remote,
    remoteUrl,
    defaultBranch,
    remoteHeadSha,
    unpublishedOverride: false,
  };
}
