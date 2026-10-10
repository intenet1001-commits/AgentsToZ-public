export interface ContextProjectNavigationCandidate {
  projectId: string;
  /** A project root or a known linked-worktree path. */
  path?: string | null;
  /** Resolves ties in favor of a parent project that owns a known worktree. */
  priority?: number;
  /** Human-readable metadata used by the context-session card. */
  projectName?: string | null;
  worktreeName?: string | null;
}

const normalizePath = (value?: string | null): string | null => {
  if (!value?.trim()) return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  // Windows file systems are normally case-insensitive.  Keep POSIX paths
  // case-sensitive so two legitimate sibling projects cannot be confused.
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};

/**
 * Find the registered project that owns a context-session cwd.  Exact paths
 * win, then the deepest enclosing project/worktree path.  Boundary checking
 * prevents `/work/app` from incorrectly matching `/work/application`.
 */
export function resolveContextProjectTarget(
  candidates: ContextProjectNavigationCandidate[],
  contextPath?: string | null,
): ContextProjectNavigationCandidate | null {
  const target = normalizePath(contextPath);
  if (!target) return null;

  const matches = candidates.flatMap((candidate, index) => {
    const path = normalizePath(candidate.path);
    if (!path) return [];
    const exact = path === target;
    const enclosing = target.startsWith(`${path}/`);
    if (!exact && !enclosing) return [];
    return [{ candidate, exact, pathLength: path.length, index }];
  });
  if (matches.length === 0) return null;

  matches.sort((left, right) =>
    Number(right.exact) - Number(left.exact)
    || right.pathLength - left.pathLength
    || (right.candidate.priority ?? 0) - (left.candidate.priority ?? 0)
    || left.index - right.index,
  );
  return matches[0]!.candidate;
}
