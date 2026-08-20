export interface ProjectSectionItem {
  id: string;
  isRunning?: boolean;
  favorite?: boolean;
  worktreePath?: string;
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
