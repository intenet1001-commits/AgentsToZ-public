import type { ContextProjectNavigationCandidate } from './contextProjectNavigation';
import { isGeneratedWorktreeRow } from './worktreeLifecycle';

export interface WorktreeContextProject {
  id: string;
  name: string;
  folderPath?: string | null;
  worktreePath?: string | null;
  worktreeParentId?: string | null;
}

export interface WorktreeContextItem {
  path: string;
  branch?: string | null;
}

/**
 * Builds cwd ownership candidates without allowing an old expanded-panel list
 * or a manually registered linked-worktree card to outrank Git's cheap
 * porcelain family. Entries whose project was removed are ignored even if a
 * stale React state object survives until the next render.
 */
export function buildWorktreeContextCandidates(
  projects: readonly WorktreeContextProject[],
  discoveredFamilies: Readonly<Record<string, readonly WorktreeContextItem[]>>,
  richFamilies: Readonly<Record<string, readonly WorktreeContextItem[]>> = {},
): ContextProjectNavigationCandidate[] {
  // Generated execution aliases are not durable owners. Provenance comes from
  // persisted worktree evidence; an `_wt_` substring is user-controlled.
  const owningProjects = projects.filter(project => !isGeneratedWorktreeRow(projects, project));
  const projectById = new Map(owningProjects.map(project => [project.id, project]));
  const pathLeaf = (folderPath: string) => folderPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || folderPath;
  const familyCandidates = (
    families: Readonly<Record<string, readonly WorktreeContextItem[]>>,
    priority: number,
  ) => Object.entries(families).flatMap(([projectId, worktrees]) => {
    const project = projectById.get(projectId);
    if (!project) return [];
    return worktrees.map(worktree => ({
      projectId,
      projectName: project.name,
      worktreeName: worktree.branch || pathLeaf(worktree.path),
      path: worktree.path,
      priority,
    }));
  });

  return [
    // Git porcelain ownership is the authority. Rich lists only add a fallback
    // while discovery is unavailable or has not scanned that page yet.
    ...familyCandidates(discoveredFamilies, 3),
    ...familyCandidates(richFamilies, 2),
    ...owningProjects.flatMap(project => [
      {
        projectId: project.id,
        projectName: project.name,
        path: project.folderPath,
        priority: project.worktreePath ? 0 : 1,
      },
      ...(project.worktreePath ? [{
        projectId: project.id,
        projectName: project.name,
        worktreeName: pathLeaf(project.worktreePath),
        path: project.worktreePath,
        priority: 0,
      }] : []),
    ]),
  ];
}
