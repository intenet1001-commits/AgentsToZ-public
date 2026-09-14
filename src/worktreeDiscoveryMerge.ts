export interface DiscoveredWorktree {
  path: string;
  branch?: string;
  head?: string;
  detached?: boolean;
  is_main: boolean;
  locked?: boolean;
  lockedReason?: string;
}

export interface DiscoveredWorktreeFamily {
  projectId: string;
  worktrees: DiscoveredWorktree[];
}

/**
 * Adds the cheap, Git-authoritative discovery fields without throwing away the
 * richer status that the expanded project panel already loaded. A project that
 * failed discovery is absent from `families`, so its last known list survives.
 */
export function mergeDiscoveredWorktreeFamilies<T extends DiscoveredWorktree>(
  previous: Record<string, T[]>,
  families: readonly DiscoveredWorktreeFamily[],
  registeredProjectIds?: readonly string[],
): Record<string, T[]> {
  let next = previous;
  if (registeredProjectIds) {
    const registered = new Set(registeredProjectIds);
    const stale = Object.keys(previous).filter(projectId => !registered.has(projectId));
    if (stale.length > 0) {
      next = { ...previous };
      for (const projectId of stale) delete next[projectId];
    }
  }
  for (const family of families) {
    if (!family.projectId || !Array.isArray(family.worktrees)) continue;
    const prior = next[family.projectId] ?? [];
    const priorByPath = new Map(prior.map(worktree => [worktree.path, worktree]));
    const merged = family.worktrees.map(worktree => {
      const existing = priorByPath.get(worktree.path);
      // Status such as changedFiles/ahead/upstream belongs to one checked-out
      // identity. Once branch or HEAD moves, retaining it until a full panel
      // refresh can make a stale merge/push action look current.
      const sameIdentity = existing
        && existing.branch === worktree.branch
        && existing.head === worktree.head
        && existing.detached === worktree.detached;
      return {
        ...(sameIdentity ? existing : {}),
        ...worktree,
      } as T;
    });
    const unchanged = prior.length === merged.length
      && prior.every((worktree, index) => {
        const candidate = merged[index];
        return candidate
          && candidate.path === worktree.path
          && candidate.branch === worktree.branch
          && candidate.head === worktree.head
          && candidate.detached === worktree.detached
          && candidate.is_main === worktree.is_main
          && candidate.locked === worktree.locked
          && candidate.lockedReason === worktree.lockedReason;
      });
    if (unchanged) continue;
    if (next === previous) next = { ...previous };
    next[family.projectId] = merged;
  }
  return next;
}
