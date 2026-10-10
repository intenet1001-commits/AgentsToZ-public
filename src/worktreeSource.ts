/** 워크트리를 "누가 만들었나" 기준으로 분류한다.
 *
 *  왜 한 곳에 모으나: 같은 판정을 배지(표시)와 삭제 경로(동작)가 각자 계산하면
 *  반드시 어긋난다. 실제로 삭제 경로가 `!isAppWorktree` 가드를 빠뜨려, 앱이 평범한
 *  `git worktree add`로 만든 워크트리를 Orca가 알고 있다는 이유만으로
 *  `orca worktree rm --force` 로 지우려 한 적이 있다(Orca가 없으면 삭제 자체가 실패).
 *
 *  핵심 규칙: **경로가 Orca 목록보다 우선한다.** Orca는 등록된 저장소 안의 일반 git
 *  워크트리도 스캔해 자기 목록에 넣기 때문에, "Orca 목록에 있음"은 소유권의 증거가 아니다.
 *  반대로 `~/orca/workspaces/` 아래 경로는 Orca가 만든 것이 확실하다. */
export type WorktreeSourceKind = 'orca' | 'app' | 'external';

export interface WorktreeSourceInput {
  /** 프로젝트(주 워크트리) 경로 */
  repoRoot: string;
  /** 분류할 워크트리 경로 */
  worktreePath: string;
  /** `orca worktree list`가 알고 있는 경로들 */
  orcaPaths?: Iterable<string> | null;
}

export interface WorktreeSource {
  kind: WorktreeSourceKind;
  /** 앱이 `<repo>/worktrees/<name>` 규칙으로 만든 워크트리 */
  isAppWorktree: boolean;
  /** 구버전 숨김 경로 `<repo>/.claude/worktrees/<name>` — Orca 스캔에서 제외된다 */
  isLegacyAppWorktree: boolean;
  inOrcaList: boolean;
  /** Orca가 소유한 워크트리인가 — 삭제를 Orca CLI로 보낼지 결정한다 */
  orcaManaged: boolean;
}

const trimTrailingSlashes = (value: unknown): string =>
  String(value ?? '').trim().replace(/\/+$/, '');

export function classifyWorktreeSource(input: WorktreeSourceInput): WorktreeSource {
  const repoRoot = trimTrailingSlashes(input.repoRoot);
  const worktreePath = trimTrailingSlashes(input.worktreePath);
  const orcaPaths = new Set(
    [...(input.orcaPaths ?? [])].map(trimTrailingSlashes).filter(Boolean),
  );

  const isLegacyAppWorktree = !!repoRoot && !!worktreePath
    && worktreePath.startsWith(`${repoRoot}/.claude/worktrees/`);
  const isAppWorktree = !!repoRoot && !!worktreePath
    && (worktreePath.startsWith(`${repoRoot}/worktrees/`) || isLegacyAppWorktree);
  const inOrcaList = !!worktreePath && orcaPaths.has(worktreePath);
  // 경로가 우선: 앱이 만든 것이면 Orca 목록에 있어도 Orca 소유가 아니다.
  const orcaManaged = !isAppWorktree
    && (inOrcaList || worktreePath.includes('/orca/workspaces/'));

  return {
    kind: orcaManaged ? 'orca' : isAppWorktree ? 'app' : 'external',
    isAppWorktree,
    isLegacyAppWorktree,
    inOrcaList,
    orcaManaged,
  };
}
