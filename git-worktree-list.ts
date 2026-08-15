/**
 * Parsed form of `git worktree list --porcelain`.
 *
 * Git deliberately omits `branch` for a detached checkout.  Keeping that
 * state separate from a missing/old API field prevents callers from inventing
 * a branch name (most dangerously, falling back to `main`).
 */
export interface ParsedGitWorktree {
  path: string;
  branch?: string;
  /** The checked-out commit Git reports for both named and detached worktrees. */
  head?: string;
  /** True only when porcelain explicitly reports a detached checkout. */
  detached: boolean;
  /** The first porcelain record is Git's primary worktree. */
  isMain: boolean;
  locked: boolean;
  lockedReason?: string;
}

/**
 * Parse Git's stable porcelain format without relying on blank-line placement.
 * A record can include extra fields such as `prunable`, `bare`, or future Git
 * metadata; only the fields this app owns are interpreted.
 */
export function parseGitWorktreePorcelain(output: string): ParsedGitWorktree[] {
  const worktrees: ParsedGitWorktree[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  let head: string | undefined;
  let detached = false;
  let locked = false;
  let lockedReason: string | undefined;

  const flush = () => {
    if (!path) return;
    worktrees.push({
      path,
      branch,
      head,
      detached,
      isMain: worktrees.length === 0,
      locked,
      lockedReason,
    });
    path = undefined;
    branch = undefined;
    head = undefined;
    detached = false;
    locked = false;
    lockedReason = undefined;
  };

  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.startsWith('worktree ')) {
      flush();
      path = rawLine.slice('worktree '.length);
      continue;
    }
    if (!path) continue;

    if (rawLine.startsWith('HEAD ')) {
      head = rawLine.slice('HEAD '.length).trim() || undefined;
    } else if (rawLine.startsWith('branch ')) {
      const ref = rawLine.slice('branch '.length).trim();
      // `branch` is normally refs/heads/<name>.  Do not turn another ref form
      // into a merge/push target; it is not a checked-out local branch.
      branch = ref.startsWith('refs/heads/')
        ? (ref.slice('refs/heads/'.length) || undefined)
        : undefined;
    } else if (rawLine === 'detached') {
      detached = true;
    } else if (rawLine === 'locked' || rawLine.startsWith('locked ')) {
      locked = true;
      lockedReason = rawLine.slice('locked'.length).trim() || undefined;
    }
  }
  flush();
  return worktrees;
}

/**
 * The base branch for worktree comparisons is Git's primary worktree, not the
 * worktree from which the list command happened to run.  This remains correct
 * when a persisted project entry points at a linked worktree.
 */
export function resolvePrimaryWorktreeBranch(
  worktrees: readonly Pick<ParsedGitWorktree, 'isMain' | 'branch'>[],
): string | undefined {
  return worktrees.find(worktree => worktree.isMain)?.branch;
}
