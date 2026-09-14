import { isCodexThreadWorkspace } from './agentWorkspacePath';
import {
  resolveContextProjectTarget,
  type ContextProjectNavigationCandidate,
} from './contextProjectNavigation';

export type ContextSessionProjectRelation = 'project' | 'worktree' | 'ephemeral' | 'unmapped';

export interface ContextSessionProjectBinding {
  relation: ContextSessionProjectRelation;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  worktreeName: string | null;
}

export function resolveContextSessionProjectBinding(
  candidates: readonly ContextProjectNavigationCandidate[],
  folderPath: string | null | undefined,
): ContextSessionProjectBinding {
  const target = resolveContextProjectTarget([...candidates], folderPath);
  if (target) {
    return {
      relation: target.worktreeName ? 'worktree' : 'project',
      projectId: target.projectId,
      projectName: target.projectName ?? target.projectId,
      projectPath: target.path ?? null,
      worktreeName: target.worktreeName ?? null,
    };
  }
  return {
    relation: isCodexThreadWorkspace(folderPath) ? 'ephemeral' : 'unmapped',
    projectId: null,
    projectName: null,
    projectPath: null,
    worktreeName: null,
  };
}
