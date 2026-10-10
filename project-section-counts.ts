export interface ProjectSectionItem {
  id: string;
  isRunning?: boolean;
  favorite?: boolean;
  worktreePath?: string;
  worktreeParentId?: string;
}

export interface CurrentGitWorktree {
  path: string;
  branch?: string;
  head?: string;
  is_main: boolean;
}

export interface CurrentWorktreeOverview {
  /** Number of real non-main worktrees reported by Git, not persisted launch aliases. */
  worktreeCount: number;
  parentProjectIds: string[];
  countByParentId: Record<string, number>;
  worktreesByParentId: Record<string, CurrentGitWorktree[]>;
}

export interface ProjectSectionCounts {
  all: number;
  running: number;
  starred: number;
  worktrees: number;
}

export function getProjectSectionCounts(items: ProjectSectionItem[]): ProjectSectionCounts {
  return {
    all: items.filter(item => !item.worktreePath && !/_wt_/.test(item.id)).length,
    running: items.filter(item => item.isRunning).length,
    starred: items.filter(item => item.favorite).length,
    worktrees: items.filter(item => !!item.worktreePath).length,
  };
}

export function shouldShowWorktreeSection(worktreeCount: number, activeSection: string): boolean {
  return worktreeCount > 0 || activeSection === 'wt';
}

function normalizedPath(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Builds the sidebar's worktree truth only from `git worktree list` families.
 * Persisted launch rows are deliberately never used as current-worktree
 * evidence: before the first successful Git scan (or while the sidecar is
 * unavailable), showing zero is safer than resurrecting a stale alias.
 */
export function buildCurrentWorktreeOverview(
  items: readonly ProjectSectionItem[],
  discoveredFamilies: Readonly<Record<string, readonly CurrentGitWorktree[]>>,
  richFamilies: Readonly<Record<string, readonly CurrentGitWorktree[]>> = {},
): CurrentWorktreeOverview {
  const countByParentId: Record<string, number> = {};
  const worktreesByParentId: Record<string, CurrentGitWorktree[]> = {};
  const parentProjects = items.filter(item => !item.worktreePath && !item.worktreeParentId);

  for (const parent of parentProjects) {
    const hasDiscoveredFamily = Object.prototype.hasOwnProperty.call(discoveredFamilies, parent.id);
    const hasRichFamily = Object.prototype.hasOwnProperty.call(richFamilies, parent.id);
    const family = hasDiscoveredFamily
      ? discoveredFamilies[parent.id]!
      : hasRichFamily
        ? richFamilies[parent.id]!
        : [];
    const seen = new Set<string>();
    const linked = family.filter(worktree => {
      if (worktree.is_main || !worktree.path.trim()) return false;
      const key = normalizedPath(worktree.path);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!linked.length) continue;
    worktreesByParentId[parent.id] = linked.map(worktree => ({ ...worktree }));
    countByParentId[parent.id] = linked.length;
  }

  const parentProjectIds = Object.keys(countByParentId);
  return {
    worktreeCount: parentProjectIds.reduce((sum, projectId) => sum + countByParentId[projectId]!, 0),
    parentProjectIds,
    countByParentId,
    worktreesByParentId,
  };
}

export function filterCurrentWorktreeParentIds(
  overview: CurrentWorktreeOverview,
  query: string,
  matchesParentProject: (projectId: string) => boolean,
): string[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...overview.parentProjectIds];
  return overview.parentProjectIds.filter(projectId => (
    matchesParentProject(projectId)
    || (overview.worktreesByParentId[projectId] ?? []).some(worktree => (
      `${worktree.branch ?? ''}\n${worktree.path}`.toLocaleLowerCase().includes(normalizedQuery)
    ))
  ));
}
