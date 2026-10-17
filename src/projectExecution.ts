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

/**
 * localhost 열기는 프로세스 실행/중지와 별도 동작이다. 등록된 주소가 있으면 열 수
 * 있어야 하며, 마지막 폴링이 아직 false라고 해서 브라우저 버튼까지 막지 않는다.
 * 서버가 실제로 중지 상태면 브라우저가 연결 실패를 정확히 보여준다.
 */
export function canOpenRegisteredPort(target: Pick<ProjectExecutionTarget, 'port'>): boolean {
  return !!target.port;
}

/**
 * `isRunning`은 저장된 사실이 아니라 현재 포트의 관측값이다. 포트가 없는 프로젝트는
 * 재시작 뒤 확인할 주소가 없으므로 예전 세션의 true를 복원하면 안 된다.
 */
export function runningStateAfterReload(
  target: Pick<ProjectExecutionTarget, 'port'> & { isRunning?: boolean },
): boolean {
  return !!target.port && target.isRunning === true;
}
