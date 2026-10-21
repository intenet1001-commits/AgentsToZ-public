/**
 * The Workroom project list, derived from the registered ports (the visible
 * authority). Shared by the main window and pop-out windows so both show the
 * same targets. Local paths are only tested, never copied into the DTO: the API
 * resolves the opaque id against the current registration.
 */
export interface WorkroomRegisteredRow {
  id: string;
  name?: unknown;
  folderPath?: unknown;
  worktreePath?: unknown;
  worktreeParentId?: unknown;
}

export interface WorkroomRegisteredProject {
  targetId: string;
  projectTargetId: string;
  label: string;
  scope: 'main' | 'worktree';
  worktreeCapable: boolean;
}

const isWinPath = (p: string) => /^[A-Za-z]:[/\\]/.test(p);

// 작업 루트는 실제로 폴더를 만드는 데 쓰이므로 이 플랫폼에서 유효한 절대경로여야 한다.
// isMacPath는 /Users·/home만 잡아서 /tmp 같은 POSIX 루트가 Windows로 새어 들어온다
// (roots Pull은 device_id 매칭 실패 시 전 기기 루트를 fallback으로 가져온다).
// 그 결과 "새 폴더 만들기"가 /tmp를 기본값으로 보여주고 생성은 "절대경로가 필요합니다"로 실패한다.
export const isUsableRootPath = (p: string): boolean => {
  if (!p) return false;
  const isWin = (typeof process !== 'undefined' && process.platform === 'win32')
    || (typeof navigator !== 'undefined' && /Win/.test(navigator.platform ?? ''));
  if (isWin) return isWinPath(p) || /^\\\\[^\\]+\\/.test(p); // 드라이브 경로 또는 UNC
  return p.startsWith('/');
};

const usablePath = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && isUsableRootPath(value.trim());

export function workroomProjectsFromPorts(ports: readonly WorkroomRegisteredRow[]): WorkroomRegisteredProject[] {
  const seenTargetIds = new Set<string>();
  return ports.flatMap<WorkroomRegisteredProject>(project => {
    if (typeof project.id !== 'string' || project.id.length < 8 || project.id.length > 128
      || !/^[A-Za-z0-9_-]+$/.test(project.id)
      || seenTargetIds.has(project.id)) return [];
    const hasFolderPath = usablePath(project.folderPath);
    const hasWorktreePath = usablePath(project.worktreePath);
    if (!hasFolderPath && !hasWorktreePath) return [];
    const label = typeof project.name === 'string'
      ? project.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120)
      : '';
    if (!label) return [];
    const scope = hasWorktreePath || (hasFolderPath && !!project.worktreeParentId) ? 'worktree' : 'main';
    const registeredParentId = scope === 'worktree'
      && typeof project.worktreeParentId === 'string'
      && /^[A-Za-z0-9_-]{8,128}$/.test(project.worktreeParentId)
      && ports.some(candidate => candidate.id === project.worktreeParentId)
      ? project.worktreeParentId
      : project.id;
    seenTargetIds.add(project.id);
    return [{targetId: project.id, projectTargetId: registeredParentId, label, scope, worktreeCapable: scope === 'worktree'}];
  });
}
