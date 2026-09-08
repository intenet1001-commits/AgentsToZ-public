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
  // Hermes launch contract v2 pins its TUI theme so it no longer emits an
  // OSC 11 background-colour query that Orca feeds back into the prompt. Put
  // that revision in the ownership marker too: a pre-fix live Hermes tab must
  // not be reused after the app is updated, because its process environment
  // cannot be repaired in place.
  const launchRevision = agent === 'hermes' ? '\0no-osc11-v1' : '';
  const bytes = new TextEncoder().encode(`${agent}\0${normalizedPath}${launchRevision}`);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `[ATZ:${agent}:${hash.toString(16).padStart(8, '0')}]`;
}

/** Hermes officially supports HERMES_TUI_THEME as an explicit override. Orca
 * currently returns OSC 11 replies too late for Hermes' startup probe, so pin
 * this one host integration to its observed dark surface and skip the query. */
export function withOrcaAgentTerminalEnvironment(
  agent: OrcaAgentName,
  command: string,
  usesWindowsCmd = false,
): string {
  if (agent !== 'hermes') return command;
  return usesWindowsCmd
    ? `set "HERMES_TUI_THEME=dark" && ${command}`
    : `env HERMES_TUI_THEME=dark ${command}`;
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

/** Orca keeps exited terminal metadata around so history can still be shown.
 * Such records have a valid handle/worktree pair but cannot be switched to or
 * reused. Older Orca versions omitted these flags, so only explicit dead-state
 * values are rejected. */
export function isLiveOrcaFloatingTerminalRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.worktreeId === ORCA_FLOATING_WORKTREE_ID
    && typeof record.handle === 'string'
    && record.handle.trim().length > 0
    && record.connected !== false
    && record.orphaned !== true;
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
