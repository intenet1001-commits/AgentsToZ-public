export interface DeploymentTarget {
  id: string;
  name: string;
  aiName?: string;
  deployUrl: string;
  folderPath?: string;
  worktreePath?: string;
  source: 'project' | 'portal';
}

interface ProjectLike {
  id: string;
  name: string;
  aiName?: string;
  deployUrl?: string;
  folderPath?: string;
  worktreePath?: string;
}

interface PortalItemLike {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  url?: unknown;
}

function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 헤더 「배포본 열기」의 정본 목록.
 *
 * 로컬 포트는 기기별이라 새 기기나 정리된 기기에서는 deployUrl이 하나도 없을 수 있지만,
 * 포털의 `auto:deploy:*` 항목은 전 기기 공유다. 둘을 합치지 않으면 포털에는 배포본이
 * 여러 개 보이는데 헤더 버튼만 비활성인 모순이 생긴다.
 */
export function buildDeploymentTargets(
  projects: readonly ProjectLike[],
  portalItems: readonly PortalItemLike[] | null | undefined,
): DeploymentTarget[] {
  const byProjectId = new Map<string, DeploymentTarget>();
  const projectById = new Map(projects.map(project => [project.id, project]));

  for (const project of projects) {
    const url = webUrl(project.deployUrl);
    if (!url) continue;
    byProjectId.set(project.id, {
      id: project.id,
      name: project.name,
      aiName: project.aiName,
      deployUrl: url,
      folderPath: project.folderPath,
      worktreePath: project.worktreePath,
      source: 'project',
    });
  }

  for (const item of portalItems ?? []) {
    if (item?.type !== 'web' || typeof item.id !== 'string' || !item.id.startsWith('auto:deploy:')) continue;
    const url = webUrl(item.url);
    if (!url) continue;
    const projectId = item.id.slice('auto:deploy:'.length);
    if (!projectId || byProjectId.has(projectId)) continue; // 최신 로컬 값이 우선
    const local = projectById.get(projectId);
    byProjectId.set(projectId, {
      id: projectId,
      name: local?.name ?? (typeof item.name === 'string' && item.name.trim() ? item.name.trim() : projectId),
      aiName: local?.aiName,
      deployUrl: url,
      folderPath: local?.folderPath,
      worktreePath: local?.worktreePath,
      source: 'portal',
    });
  }

  // 같은 URL의 오래된 프로젝트 행이 여러 개면 한 번만 보여준다. 현재 로컬 프로젝트가
  // 포털 잔여 행보다 우선이고, 그 다음 이름 순서로 안정적으로 정렬한다.
  const seenUrls = new Set<string>();
  return [...byProjectId.values()]
    .sort((a, b) => Number(b.source === 'project') - Number(a.source === 'project')
      || (a.aiName || a.name).localeCompare(b.aiName || b.name, 'ko'))
    .filter(target => {
      const key = target.deployUrl.replace(/\/$/, '');
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    });
}
