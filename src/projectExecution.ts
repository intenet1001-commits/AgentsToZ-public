export interface ProjectExecutionTarget {
  commandPath?: string;
  terminalCommand?: string;
  folderPath?: string;
  worktreePath?: string;
  port?: number;
}

/**
 * Worktrees are isolated checkouts. They must discover their own start command instead
 * of inheriting a launcher file or terminal command that points at the main checkout.
 */
export function shouldAutoDetectProjectStart(target: ProjectExecutionTarget): boolean {
  return !!target.worktreePath || (!target.terminalCommand && !target.commandPath);
}

export function projectExecutionKind(
  target: ProjectExecutionTarget,
): 'worktree-auto' | 'folder-auto' | 'terminal-command' | 'command-file' {
  if (target.worktreePath) return 'worktree-auto';
  if (target.terminalCommand) return 'terminal-command';
  if (target.commandPath) return 'command-file';
  return 'folder-auto';
}

export function canOpenRegisteredPort(target: Pick<ProjectExecutionTarget, 'port'>, isRunning: boolean): boolean {
  return !!target.port && isRunning;
}
