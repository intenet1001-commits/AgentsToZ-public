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
  if ([leaf, project.name, project.aiName].some(value => value?.trim().toLowerCase() === 'agentstoz-control')) return 'ops';
  if (leaf === 'AgentsToZ_byCS') return 'dev';
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
