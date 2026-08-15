export const ORCA_FLOATING_WORKTREE_ID = 'global-floating-terminal';
export const ORCA_FLOATING_WORKTREE_SELECTOR = `id:${ORCA_FLOATING_WORKTREE_ID}`;
export type OrcaLaunchMode = 'floating' | 'worktree';
export type OrcaAgentName = 'claude' | 'codex' | 'agy' | 'hermes';

/**
 * A title marker lets AgentsToZ find only the Floating tabs it created for an
 * exact agent + project pair. The path itself stays out of the title, while
 * the marker remains stable across app restarts and both launch backends.
 */
export function normalizeOrcaFloatingTerminalPath(folderPath: string): string {
  return (folderPath || '/')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '') || '/';
}

export function orcaManagedFloatingTerminalMarker(agent: string, folderPath: string): string {
  const normalizedPath = normalizeOrcaFloatingTerminalPath(folderPath);
  const bytes = new TextEncoder().encode(`${agent}\0${normalizedPath}`);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `[ATZ:${agent}:${hash.toString(16).padStart(8, '0')}]`;
}

export function buildOrcaManagedFloatingTerminalTitle(
  name: string | undefined,
  label: string,
  agent: string,
  folderPath: string,
): string {
  const displayName = name?.trim() || 'AgentsToZ';
  return `${displayName} · ${label} · ${orcaManagedFloatingTerminalMarker(agent, folderPath)}`;
}

export function isOrcaManagedFloatingTerminal(
  title: unknown,
  agent: string,
  folderPath: string,
): boolean {
  return typeof title === 'string' && title.includes(orcaManagedFloatingTerminalMarker(agent, folderPath));
}

const ORCA_AGENT_BYPASS_FLAG: Record<OrcaAgentName, string> = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  agy: '--dangerously-skip-permissions',
  hermes: '',
};

/** 전역 바로가기는 Floating을 유지하고, 프로젝트/워크트리 경로가 있을 때만 선택 모드를 적용한다. */
export function shouldUseOrcaFloatingTerminal(worktreePath: string | undefined, mode: OrcaLaunchMode): boolean {
  return !worktreePath || mode === 'floating';
}

export function shellQuoteForFloatingTerminal(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A single shell line avoids changing the Floating Terminal's cwd before launch succeeds. */
export function buildOrcaFloatingCommand(folderPath: string, command?: string | null): string {
  const cd = `cd ${shellQuoteForFloatingTerminal(folderPath)}`;
  return command?.trim() ? `${cd} && ${command.trim()}` : cd;
}

/** Build the command sent to Orca's Linux floating terminal for a Windows-native CLI. */
export function buildWindowsOrcaAgentCommand(
  agent: OrcaAgentName,
  executablePath: string,
  bypass: boolean,
): string {
  const normalized = executablePath.replace(/\\/g, '/');
  const wslPath = normalized.replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`);
  const executable = shellQuoteForFloatingTerminal(wslPath);
  const base = agent === 'codex' ? `env -u CODEX_HOME ${executable}` : executable;
  return bypass ? `${base} ${ORCA_AGENT_BYPASS_FLAG[agent]}` : base;
}

export function buildWindowsCmdAgentCommand(
  agent: OrcaAgentName,
  executablePath: string,
  bypass: boolean,
): string {
  const executable = `"${executablePath.replace(/"/g, '""')}"`;
  const base = agent === 'codex' ? `set "CODEX_HOME=" && ${executable}` : executable;
  return bypass ? `${base} ${ORCA_AGENT_BYPASS_FLAG[agent]}` : base;
}

export function buildWindowsCmdOrcaCommand(folderPath: string, command?: string | null): string {
  const folder = `"${folderPath.replace(/"/g, '""')}"`;
  const cd = `cd /d ${folder}`;
  return command?.trim() ? `${cd} && ${command.trim()}` : cd;
}
