// Explicit `.ts`: ports-merge.ts imports this module natively in the Node smoke runners.
import {isOpsFolderName} from './opsFolderName.ts';
import {isDevFolderName, isDevRepositoryUrl} from './devFolderName.ts';

/** Local registration metadata, independent of each project's USE/DEV bot purpose.
 * This is a navigation projection, never an authorization or memory identity. */
export type ProjectRole = 'ops' | 'dev' | 'managed';
export type ProjectRoleView = ProjectRole | 'unknown';

export type ProjectRoleCandidate = {
  id: string;
  role?: unknown;
  name?: string;
  aiName?: string;
  folderPath?: string;
  /** Registered GitHub remote(s). A dev checkout can sit in any directory, so the
   * repository name is a second, rename-proof signal (devFolderName.ts). */
  githubUrl?: string;
  githubUrls?: readonly string[];
  worktreeParentId?: string;
  worktreePath?: string;
};

export const PROJECT_ROLE_LABELS: Record<ProjectRoleView, string> = {
  ops: 'AgentsToZ OPS', dev: 'AgentsToZ DEV', managed: '관리 프로젝트', unknown: '역할 확인 필요',
};

export function isProjectRole(value: unknown): value is ProjectRole {
  return value === 'ops' || value === 'dev' || value === 'managed';
}

export function projectRoleWithoutBinding(project: Omit<ProjectRoleCandidate, 'id'>): ProjectRoleView {
  if (project.role !== undefined) return isProjectRole(project.role) ? project.role : 'unknown';
  const leaf = project.folderPath?.trim().replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  // Both OPS folder names (AgentsToZ-OPS, legacy AgentsToZ-Control) until every Mac has migrated.
  if ([leaf, project.name, project.aiName].some(value => isOpsFolderName(value))) return 'ops';
  // Both development folder names, and the registered repository, for the same reason
  // (devFolderName.ts). A single literal left a checkout in `portmanagement/` — the
  // repository's own former name — reported as 관리 프로젝트 with `AgentsToZ DEV · 0`.
  if (isDevFolderName(leaf)) return 'dev';
  if ([project.githubUrl, ...(project.githubUrls ?? [])].some(url => isDevRepositoryUrl(url))) return 'dev';
  return 'managed';
}

/** No persisted records are changed. A worktree is not a separate role/memory. */
export function resolveProjectRoles(
  projects: readonly ProjectRoleCandidate[],
  binding: {opsProjectId?: string | null; devProjectId?: string | null} = {},
): Map<string, ProjectRoleView> {
  const byId = new Map(projects.map(project => [project.id, project]));
  const memo = new Map<string, ProjectRoleView>();
  function resolve(id: string, seen = new Set<string>()): ProjectRoleView {
    if (memo.has(id)) return memo.get(id)!;
    const project = byId.get(id);
    if (!project || seen.has(id) || seen.size >= 64) return 'unknown';
    seen.add(id);
    const role = id === binding.opsProjectId ? 'ops'
      : project.worktreeParentId ? resolve(project.worktreeParentId, seen)
      : project.worktreePath ? 'unknown'
      : project.role === undefined && id === binding.devProjectId && projectRoleWithoutBinding(project) !== 'ops' ? 'dev'
      : projectRoleWithoutBinding(project);
    memo.set(id, role);
    return role;
  }
  return new Map(projects.map(project => [project.id, resolve(project.id)]));
}

/**
 * The project a sidebar role chip should open, or null to leave the selection alone.
 *
 * The detail pane only shows a selection that is still in the filtered list, so
 * switching OPS → DEV used to hide the open project and leave "프로젝트를 선택하세요"
 * although the chip names exactly one project (VOC 2026-09-24). Only an unambiguous
 * single project is opened; several candidates are never guessed.
 */
export function projectToSelectForSection(
  section: string,
  projects: readonly ProjectRoleCandidate[],
  roles: ReadonlyMap<string, ProjectRoleView>,
  selectedId: string | null,
): string | null {
  if (!section.startsWith('role:')) return null;
  const role = section.slice(5);
  const matches = projects.filter(p => !p.worktreeParentId && !p.worktreePath && roles.get(p.id) === role);
  if (selectedId && matches.some(p => p.id === selectedId)) return null;
  return matches.length === 1 ? matches[0]?.id ?? null : null;
}
