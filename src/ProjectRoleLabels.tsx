import React from 'react';
import {t,type Lang} from './i18n';

export function projectRoleLabel(language:Lang,role:ProjectNavigationRole):string {
 return role==='sdk'?t(language,'roleSdk'):role==='managed'?t(language,'roleManaged'):role==='unknown'?t(language,'roleUnknown'):PROJECT_ROLE_LABELS[role];
}
import {PROJECT_ROLE_LABELS, type ProjectRoleCandidate, type ProjectNavigationRole} from './projectRole';

export function ProjectRoleBadge({role,language='ko'}: {role: ProjectNavigationRole;language?:Lang}) {
  return <span data-testid="project-role-badge" data-project-role={role}
    className="shrink-0 rounded border border-[var(--line)] px-1 text-[10px] text-[var(--ink-2)]">
    {projectRoleLabel(language,role)}
  </span>;
}

export function ProjectRoleFilters({projects, roles, section, onSelect, remoteFound = 0, onOpsRemoteFound, onOpenOpsWorkroom,language='ko'}: {
  language?:Lang;
  projects: readonly ProjectRoleCandidate[];
  roles: ReadonlyMap<string, ProjectNavigationRole>;
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
  const counts = {ops:0, dev:0, sdk:0, managed:0, unknown:0};
  for (const project of projects) {
    if (!project.worktreeParentId && !project.worktreePath) counts[roles.get(project.id) ?? 'unknown']++;
  }
  // 44px 터치 높이는 모바일(≤640px)만의 규칙이다. 데스크톱에서도 44px 로 두 줄을 차지해
  // 사이드바 목록 높이를 135px 나 먹었다(2026-09 감사) — 넓은 화면에서는 필터 칩 높이로 줄인다.
  const roleActive = section.startsWith('role:');
  const chipClass = 'min-h-11 sm:min-h-6 rounded border border-[var(--line)] px-2 py-1 sm:py-0.5 text-[10px] aria-pressed:bg-[var(--accent-soft)]';
  return <nav aria-label={t(language,'projectKinds')} className="flex flex-wrap gap-1 px-3 py-2 sm:py-1.5">
    {/* 역할 칩은 한 번에 하나만 켜지고, 켠 칩을 다시 눌러야 전체로 돌아갔다 — 그 방법이 보이지 않았다
        (VOC 2026-09-27 「전체선택 있으면 편하겠네」). 역할 필터만 풀고, 역할이 아닌 섹션은 건드리지 않는다. */}
    <button type="button" data-testid="project-role-filter-all" aria-pressed={!roleActive}
      onClick={() => { if (roleActive) onSelect('all'); }}
      className={chipClass}>
      {t(language,'roleAllProjects')} · {counts.ops + counts.dev + counts.sdk + counts.managed + counts.unknown}
    </button>
    {/* 빈 「공통 SDK · 0」「관리 · 0」 칩이 줄을 하나 더 만들어 최소 창(640×560)에서 목록이 64px로 줄었다
        (UI 감사 2026-10-24). 개수가 0이면 숨기되, 켜 둔 칩은 끌 수 있게 남긴다. OPS · 0은 남긴다 —
        「아직 운영 프로필이 없다」는 뜻이고 다른 Mac의 OPS 발견 칩과 짝을 이룬다. */}
    {(Object.keys(counts) as ProjectNavigationRole[]).filter(role => role === 'ops' || role === 'dev' || counts[role] > 0 || section === `role:${role}`).map(role => (
      <button key={role} type="button" data-testid={`project-role-filter-${role}`} aria-pressed={section === `role:${role}`}
        onClick={() => onSelect(section === `role:${role}` ? 'all' : `role:${role}`)}
        className={chipClass}>
        {projectRoleLabel(language,role)} · {counts[role]}
      </button>
    ))}
    {counts.ops > 0 && onOpenOpsWorkroom && (
      // The 아젠투지 character is the voice dock only (VOC 2026-09-29); two identical characters doing
      // different things read as one control. This one just opens the OPS Workroom.
      <button type="button" data-testid="project-role-open-ops-workroom" onClick={onOpenOpsWorkroom} className={chipClass}>{t(language,'openOps')}</button>
    )}
    {counts.ops === 0 && remoteFound > 0 && (
      <button type="button" data-testid="project-role-filter-ops-remote"
        onClick={() => onOpsRemoteFound?.()}
        title={t(language,'remoteOpsFoundHelp')}
        className="min-h-11 sm:min-h-6 rounded border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2 py-1 sm:py-0.5 text-[10px] font-semibold text-[var(--accent)]">
        {t(language,'remoteOpsFound',{count:remoteFound})}
      </button>
    )}
  </nav>;
}
