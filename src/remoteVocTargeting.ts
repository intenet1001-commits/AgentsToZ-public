/**
 * VOC 저장은 Mac 전체의 inbox에 들어가지만, 암호화된 workspace wire contract는
 * 검증된 프로젝트 targetId 하나를 요구한다. 그 전송 대상과 실제 DEV 워크룸 대상은
 * 같은 개념이 아니다: DEV가 보이지 않아도 VOC 자체는 안전한 등록 프로젝트를 통해
 * 저장할 수 있어야 한다.
 */
export interface RemoteVocProjectTarget {
  controlId: string;
  name: string;
  role?: 'ops' | 'dev' | 'managed' | 'unknown';
  kind: 'main' | 'worktree';
}

export function findRemoteVocDevProject<T extends RemoteVocProjectTarget>(projects: readonly T[]): T | null {
  return projects.find(project => project.role === 'dev')
    ?? projects.find(project => project.name.trim().toLocaleLowerCase() === 'agentstoz_bycs')
    ?? null;
}

export function selectRemoteVocTransportProject<T extends RemoteVocProjectTarget>(
  projects: readonly T[],
  preferredControlId?: string | null,
): T | null {
  return findRemoteVocDevProject(projects)
    ?? (preferredControlId ? projects.find(project => project.controlId === preferredControlId) : undefined)
    ?? projects.find(project => project.kind === 'main')
    ?? projects[0]
    ?? null;
}
