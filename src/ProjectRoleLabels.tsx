import React from 'react';
import {PROJECT_ROLE_LABELS, type ProjectRoleCandidate, type ProjectRoleView} from './projectRole';

export function ProjectRoleBadge({role}: {role: ProjectRoleView}) {
  return <span data-testid="project-role-badge" data-project-role={role}
    className="shrink-0 rounded border border-[var(--line)] px-1 text-[10px] text-[var(--ink-2)]">
    {PROJECT_ROLE_LABELS[role]}
  </span>;
}

export function ProjectRoleFilters({projects, roles, section, onSelect}: {
  projects: readonly ProjectRoleCandidate[];
  roles: ReadonlyMap<string, ProjectRoleView>;
  section: string;
  onSelect: (section: string) => void;
}) {
  const counts = {ops:0, dev:0, managed:0, unknown:0};
  for (const project of projects) {
    if (!project.worktreeParentId && !project.worktreePath) counts[roles.get(project.id) ?? 'unknown']++;
  }
  return <nav aria-label="프로젝트 역할" className="flex flex-wrap gap-1 px-3 py-2">
    {(Object.keys(counts) as ProjectRoleView[]).filter(role => role !== 'unknown' || counts[role] > 0).map(role => (
      <button key={role} type="button" data-testid={`project-role-filter-${role}`} aria-pressed={section === `role:${role}`}
        onClick={() => onSelect(`role:${role}`)}
        className="rounded border border-[var(--line)] px-2 py-1 text-[10px] aria-pressed:bg-[var(--accent-soft)]">
        {PROJECT_ROLE_LABELS[role]} · {counts[role]}
      </button>
    ))}
  </nav>;
}
