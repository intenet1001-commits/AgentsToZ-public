export interface WorkspaceRootOrderItem {
  id: string;
}

export interface WorkspaceRootPathItem extends WorkspaceRootOrderItem {
  name: string;
  path: string;
}

export interface WorkspaceRootProjectItem {
  folderPath?: string;
  worktreePath?: string;
}

export interface WorkspaceRootProjectGroup<T> {
  root: WorkspaceRootPathItem | null;
  items: T[];
}

const isWindowsStylePath = (path: string): boolean =>
  /^[A-Za-z]:[/\\]/.test(path) || /^[/\\]{2}[^/\\]+[/\\]/.test(path);

/** 비교 전 구분자와 끝 슬래시만 정규화한다. 실제 경로의 대소문자는 Windows에서만 접는다. */
function comparableWorkspacePath(path: string, caseInsensitive: boolean): string {
  let comparable = path.trim().replace(/\\/g, '/');
  if (comparable !== '/' && !/^[A-Za-z]:\/$/.test(comparable)) {
    comparable = comparable.replace(/\/+$/, '');
  }
  return caseInsensitive ? comparable.toLowerCase() : comparable;
}

function workspaceRootContainsPath(rootPath: string, projectPath: string): boolean {
  if (!rootPath || !projectPath) return false;
  const caseInsensitive = isWindowsStylePath(rootPath) || isWindowsStylePath(projectPath);
  const root = comparableWorkspacePath(rootPath, caseInsensitive);
  const project = comparableWorkspacePath(projectPath, caseInsensitive);
  if (!root || !project) return false;
  if (project === root) return true;
  return root.endsWith('/') ? project.startsWith(root) : project.startsWith(`${root}/`);
}

/**
 * 프로젝트를 포함하는 가장 구체적인 작업 루트를 찾는다.
 *
 * `/work`와 `/work/client`처럼 루트가 겹칠 수 있으므로 첫 일치가 아니라 가장 긴 일치를
 * 택한다. 단순 startsWith는 `/work`가 `/workspace`까지 잡으므로 경로 경계도 확인한다.
 */
export function workspaceRootForProject(
  project: WorkspaceRootProjectItem,
  roots: WorkspaceRootPathItem[],
): WorkspaceRootPathItem | null {
  const projectPath = project.worktreePath || project.folderPath || '';
  let best: WorkspaceRootPathItem | null = null;
  let bestLength = -1;

  for (const root of roots) {
    if (!workspaceRootContainsPath(root.path, projectPath)) continue;
    const caseInsensitive = isWindowsStylePath(root.path) || isWindowsStylePath(projectPath);
    const rootLength = comparableWorkspacePath(root.path, caseInsensitive).length;
    // 길이가 같은 중복 루트는 사용자가 정한 앞쪽 순서를 유지한다.
    if (rootLength > bestLength) {
      best = root;
      bestLength = rootLength;
    }
  }
  return best;
}

/** 등록된 작업 루트 순서로 묶고, 어느 루트에도 속하지 않는 항목은 마지막에 둔다. */
export function groupProjectsByWorkspaceRoot<T extends WorkspaceRootProjectItem>(
  projects: T[],
  roots: WorkspaceRootPathItem[],
): WorkspaceRootProjectGroup<T>[] {
  const itemsByRoot = new Map<string, T[]>();
  const unassigned: T[] = [];

  for (const project of projects) {
    const root = workspaceRootForProject(project, roots);
    if (!root) {
      unassigned.push(project);
      continue;
    }
    const items = itemsByRoot.get(root.id);
    if (items) items.push(project);
    else itemsByRoot.set(root.id, [project]);
  }

  const groups: WorkspaceRootProjectGroup<T>[] = roots
    .filter(root => itemsByRoot.has(root.id))
    .map(root => ({ root, items: itemsByRoot.get(root.id)! }));
  if (unassigned.length > 0) groups.push({ root: null, items: unassigned });
  return groups;
}

export function reorderWorkspaceRoots<T extends WorkspaceRootOrderItem>(
  roots: T[],
  id: string,
  direction: -1 | 1,
): T[] {
  const currentIndex = roots.findIndex(root => root.id === id);
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= roots.length) return roots;

  const reordered = [...roots];
  [reordered[currentIndex], reordered[nextIndex]] = [
    reordered[nextIndex]!,
    reordered[currentIndex]!,
  ];
  return reordered;
}

/**
 * 같은 기기의 로컬 표시 순서는 유지하면서 원격의 최신 필드값을 반영한다.
 * 원격에만 존재하는 새 루트는 기존 로컬 목록 뒤에 추가한다.
 */
export function mergeWorkspaceRootsPreservingLocalOrder<T extends WorkspaceRootOrderItem>(
  localRoots: T[],
  remoteRoots: T[],
): T[] {
  const remoteById = new Map(remoteRoots.map(root => [root.id, root]));
  const localIds = new Set(localRoots.map(root => root.id));
  return [
    ...localRoots.map(root => remoteById.get(root.id) ?? root),
    ...remoteRoots.filter(root => !localIds.has(root.id)),
  ];
}
