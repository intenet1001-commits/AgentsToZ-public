export interface WorkspaceRootOrderItem {
  id: string;
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
