import React from 'react';
import {PROJECT_ROLE_LABELS, type ProjectRoleCandidate, type ProjectRoleView} from './projectRole';

export function ProjectRoleBadge({role}: {role: ProjectRoleView}) {
  return <span data-testid="project-role-badge" data-project-role={role}
    className="shrink-0 rounded border border-[var(--line)] px-1 text-[10px] text-[var(--ink-2)]">
    {PROJECT_ROLE_LABELS[role]}
  </span>;
}

export function ProjectRoleFilters({projects, roles, section, onSelect, remoteFound = 0, onOpsRemoteFound, onOpenOpsWorkroom}: {
  projects: readonly ProjectRoleCandidate[];
  roles: ReadonlyMap<string, ProjectRoleView>;
  section: string;
  onSelect: (section: string) => void;
  /**
   * 다른 Mac 에 등록된 AgentsToZ OPS 개수.
   *
   * 이 칩은 로컬 프로젝트만 세므로, 운영 폴더가 다른 Mac 에만 있으면 계속
   * `AgentsToZ OPS · 0` 이다. 사용자는 이미 쓰던 것이 있는데도 화면에서는
   * 아무것도 없다고 읽고 새로 만들게 된다 — 그러면 memoryId 가 갈라진다.
   * 개수 대신 발견 사실을 이 자리에서 바로 알린다.
   */
  remoteFound?: number;
  onOpsRemoteFound?: () => void;
  onOpenOpsWorkroom?: () => void;
}) {
  const counts = {ops:0, dev:0, managed:0, unknown:0};
  for (const project of projects) {
    if (!project.worktreeParentId && !project.worktreePath) counts[roles.get(project.id) ?? 'unknown']++;
  }
  // 44px 터치 높이는 모바일(≤640px)만의 규칙이다. 데스크톱에서도 44px 로 두 줄을 차지해
  // 사이드바 목록 높이를 135px 나 먹었다(2026-09 감사) — 넓은 화면에서는 필터 칩 높이로 줄인다.
  const roleActive = section.startsWith('role:');
  const chipClass = 'min-h-11 sm:min-h-6 rounded border border-[var(--line)] px-2 py-1 sm:py-0.5 text-[10px] aria-pressed:bg-[var(--accent-soft)]';
  return <nav aria-label="프로젝트 역할" className="flex flex-wrap gap-1 px-3 py-2 sm:py-1.5">
    {/* 역할 칩은 한 번에 하나만 켜지고, 켠 칩을 다시 눌러야 전체로 돌아갔다 — 그 방법이 보이지 않았다
        (VOC 2026-09-27 「전체선택 있으면 편하겠네」). 역할 필터만 풀고, 역할이 아닌 섹션은 건드리지 않는다. */}
    <button type="button" data-testid="project-role-filter-all" aria-pressed={!roleActive}
      onClick={() => { if (roleActive) onSelect('all'); }}
      className={chipClass}>
      전체 역할 · {counts.ops + counts.dev + counts.managed + counts.unknown}
    </button>
    {(Object.keys(counts) as ProjectRoleView[]).filter(role => role !== 'unknown' || counts[role] > 0).map(role => (
      <button key={role} type="button" data-testid={`project-role-filter-${role}`} aria-pressed={section === `role:${role}`}
        onClick={() => onSelect(section === `role:${role}` ? 'all' : `role:${role}`)}
        className={chipClass}>
        {PROJECT_ROLE_LABELS[role]} · {counts[role]}
      </button>
    ))}
    {counts.ops > 0 && onOpenOpsWorkroom && (
      // The 아젠투지 character is the voice dock only (VOC 2026-09-29); two identical characters doing
      // different things read as one control. This one just opens the OPS Workroom.
      <button type="button" data-testid="project-role-open-ops-workroom" onClick={onOpenOpsWorkroom} className={chipClass}>OPS 워크룸 열기</button>
    )}
    {counts.ops === 0 && remoteFound > 0 && (
      <button type="button" data-testid="project-role-filter-ops-remote"
        onClick={() => onOpsRemoteFound?.()}
        title="다른 Mac에서 사용 중인 AgentsToZ OPS가 있습니다. 새로 만들지 말고 복원하세요."
        className="min-h-11 sm:min-h-6 rounded border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2 py-1 sm:py-0.5 text-[10px] font-semibold text-[var(--accent)]">
        다른 Mac에 OPS {remoteFound} · 복원
      </button>
    )}
  </nav>;
}
