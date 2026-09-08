export const GIT_BRANCH_HYGIENE_MAX_LOCAL_BRANCHES = 8;
export const GIT_BRANCH_HYGIENE_STALE_DAYS = 30;
export const GIT_BRANCH_HYGIENE_UNPUBLISHED_DAYS = 7;

export type GitBranchHygieneScope = 'local' | 'remote';
export type GitBranchHygieneRecommendation =
  | 'keep-default'
  | 'keep-active'
  | 'delete-merged'
  | 'review-unpublished'
  | 'review-stale'
  | 'keep-recent';

export interface GitBranchHygieneObservation {
  name: string;
  scope: GitBranchHygieneScope;
  lastCommitAt: string | null;
  checkedOut: boolean;
  uniqueCommits: number | null;
  behindDefault: number | null;
  upstream: string | null;
}

export interface GitBranchHygieneBranch extends GitBranchHygieneObservation {
  mergedIntoDefault: boolean | null;
  ageDays: number | null;
  recommendation: GitBranchHygieneRecommendation;
}

export interface GitBranchHygieneSummary {
  defaultBranch: string | null;
  defaultRemoteRef: string | null;
  defaultReliable: boolean;
  generatedAt: string;
  totalLocalBranches: number;
  totalRemoteBranches: number;
  safeDeleteCount: number;
  reviewCount: number;
  overflowCount: number;
  attentionCount: number;
  needsAttention: boolean;
  truncated: boolean;
  branches: GitBranchHygieneBranch[];
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function ageInDays(lastCommitAt: string | null, now: number): number | null {
  if (!lastCommitAt) return null;
  const timestamp = Date.parse(lastCommitAt);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now - timestamp) / 86_400_000));
}

export function summarizeGitBranchHygiene(input: {
  defaultBranch: string | null;
  defaultRemoteRef: string | null;
  defaultReliable: boolean;
  observations: readonly GitBranchHygieneObservation[];
  now?: number;
  truncated?: boolean;
}): GitBranchHygieneSummary {
  const now = input.now ?? Date.now();
  const defaultBranch = input.defaultBranch?.trim() || null;
  const defaultRemoteRef = input.defaultRemoteRef?.trim() || null;
  const branches = input.observations.map((raw): GitBranchHygieneBranch => {
    const uniqueCommits = nonNegativeInteger(raw.uniqueCommits);
    const behindDefault = nonNegativeInteger(raw.behindDefault);
    const ageDays = ageInDays(raw.lastCommitAt, now);
    const isDefault = raw.scope === 'local'
      ? raw.name === defaultBranch
      : raw.name === defaultRemoteRef;
    const mergedIntoDefault = input.defaultReliable && uniqueCommits !== null
      ? uniqueCommits === 0
      : null;
    let recommendation: GitBranchHygieneRecommendation;
    if (isDefault) recommendation = 'keep-default';
    else if (raw.checkedOut) recommendation = 'keep-active';
    else if (mergedIntoDefault === true) recommendation = 'delete-merged';
    else if (raw.scope === 'local' && !raw.upstream && uniqueCommits !== null && uniqueCommits > 0
      && ageDays !== null && ageDays >= GIT_BRANCH_HYGIENE_UNPUBLISHED_DAYS) {
      recommendation = 'review-unpublished';
    } else if (ageDays !== null && ageDays >= GIT_BRANCH_HYGIENE_STALE_DAYS) {
      recommendation = 'review-stale';
    } else recommendation = 'keep-recent';
    return {
      ...raw,
      uniqueCommits,
      behindDefault,
      mergedIntoDefault,
      ageDays,
      recommendation,
    };
  });
  const totalLocalBranches = branches.filter(branch => branch.scope === 'local').length;
  const totalRemoteBranches = branches.filter(branch => branch.scope === 'remote').length;
  const safeDeleteCount = branches.filter(branch => branch.recommendation === 'delete-merged').length;
  const reviewCount = branches.filter(branch => branch.recommendation === 'review-stale'
    || branch.recommendation === 'review-unpublished').length;
  const overflowCount = Math.max(0, totalLocalBranches - GIT_BRANCH_HYGIENE_MAX_LOCAL_BRANCHES);
  const attentionCount = Math.max(safeDeleteCount + reviewCount, overflowCount);
  return {
    defaultBranch,
    defaultRemoteRef,
    defaultReliable: input.defaultReliable,
    generatedAt: new Date(now).toISOString(),
    totalLocalBranches,
    totalRemoteBranches,
    safeDeleteCount,
    reviewCount,
    overflowCount,
    attentionCount,
    needsAttention: attentionCount > 0 || input.truncated === true,
    truncated: input.truncated === true,
    branches,
  };
}

function branchLine(branch: GitBranchHygieneBranch): string {
  const unique = branch.uniqueCommits === null ? '고유 커밋 미확인' : `고유 ${branch.uniqueCommits}`;
  const age = branch.ageDays === null ? '날짜 미확인' : `${branch.ageDays}일 전`;
  const upstream = branch.upstream ? `upstream ${branch.upstream}` : 'upstream 없음';
  return `- [${branch.scope}] ${branch.name}: ${branch.recommendation}, ${unique}, ${age}, ${upstream}${branch.checkedOut ? ', checkout 중' : ''}`;
}

export function buildGitBranchHygienePrompt(input: {
  folderPath: string;
  projectName?: string;
  summary: GitBranchHygieneSummary;
}): string {
  const candidates = input.summary.branches.filter(branch =>
    branch.recommendation === 'delete-merged'
    || branch.recommendation === 'review-stale'
    || branch.recommendation === 'review-unpublished');
  const evidence = candidates.length > 0
    ? candidates.map(branchLine).join('\n')
    : '- 개별 후보는 없지만 브랜치 수 기준을 초과했거나 전체 조회가 잘렸습니다.';
  return `다음 Git 저장소의 브랜치 정리를 안전하게 진행해 주세요.

프로젝트: ${input.projectName || '(이름 없음)'}
등록 경로: ${input.folderPath}
앱이 마지막으로 관찰한 기본 브랜치: ${input.summary.defaultBranch || '미확인'}
기본 브랜치 근거: ${input.summary.defaultReliable ? input.summary.defaultRemoteRef || 'origin/HEAD' : '신뢰 가능한 origin/HEAD 미확인 — 실행 전에 원격 기본 브랜치를 반드시 재확인'}

관찰된 정리 후보:
${evidence}

안전 절차:
1. 실제 저장소 루트와 remote URL, 원격의 실제 기본 브랜치, git status --short, branch -vv, worktree list --porcelain을 먼저 확인하세요. main이라고 가정하지 마세요.
2. git fetch --prune 후 각 로컬·원격 브랜치의 기본 브랜치 포함 여부, 고유 커밋, patch-equivalence, 연결 worktree와 dirty 여부를 다시 계산하세요.
3. dirty·잠금·실행 중 worktree 또는 다른 사용자의 변경은 보존하세요. reset --hard, clean, force push, 공유 커밋 rebase, 자동 ours/theirs 해결은 금지합니다.
4. 이미 기본 브랜치에 포함됐거나 현재 구현으로 명확히 대체된 브랜치만 삭제하세요. 고유 기능은 현재 코드와 테스트를 대조하고 필요한 것만 별도 검증 후 병합하세요.
5. 병합할 변경은 저장소 계약의 테스트를 통과시킨 뒤 일반 merge/fast-forward와 일반 push만 사용하세요. 충돌·원격 분기·불명확한 의도가 있으면 삭제하지 말고 남겨서 보고하세요.
6. 마지막에 남은 로컬·원격 브랜치, 삭제·병합한 이름, 최종 기본 브랜치의 로컬/원격 SHA를 보고하세요.

이 목록은 마지막 로컬 추적 ref 기준의 유도 신호일 뿐 삭제 승인이 아닙니다. 실행 시점의 Git 증거가 우선합니다.`;
}
