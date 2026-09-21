export interface AgentLaunchContext {
  repositoryPath?: string;
  workingPath?: string;
  worktreePath?: string;
  isLinkedWorktree: boolean;
}

const normalizePath = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
};

/**
 * Resolve one authoritative working directory for every AI launcher.
 *
 * `folderPath` remains the repository registration path (notably for Orca),
 * while `workingPath` is always the selected linked worktree when one exists.
 * Passing the selected path in both fields downstream prevents an older or
 * partially compatible launcher from silently falling back to the main tree.
 */
export function resolveAgentLaunchContext(
  folderPath?: string,
  requestedWorktreePath?: string,
  persistedWorktreePath?: string,
): AgentLaunchContext {
  const repositoryPath = normalizePath(folderPath);
  const requested = normalizePath(requestedWorktreePath);
  const persisted = normalizePath(persistedWorktreePath);
  const candidate = requested ?? persisted;
  const explicitlyMain = !!requested && !!repositoryPath && requested === repositoryPath && !persisted;
  const isLinkedWorktree = !!candidate && !explicitlyMain;
  const worktreePath = isLinkedWorktree ? candidate : undefined;

  return {
    repositoryPath,
    workingPath: worktreePath ?? repositoryPath,
    worktreePath,
    isLinkedWorktree,
  };
}

