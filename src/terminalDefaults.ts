export type TerminalApp = 'cmux' | 'orca' | 'iterm' | 'terminal' | 'powershell' | 'wsl';

export interface TerminalOptionDefaults {
  bgMode: boolean;
  tmuxMode: boolean;
  bypassPermissions: boolean;
}

export const TERMINAL_DEFAULTS_VERSION = '5';

export type OrcaLaunchSurface = 'floating' | 'worktree';

/**
 * Claude --bg starts a background agent, then the app opens `claude agents` on the
 * selected terminal surface. Orca Floating is a valid agent-management surface;
 * the worktree-owned terminal intentionally stays a normal interactive Claude session.
 */
export function isClaudeBgAvailable(
  app: TerminalApp,
  orcaSurface: OrcaLaunchSurface = 'floating',
): boolean {
  if (app === 'powershell') return false;
  if (app === 'orca') return orcaSurface === 'floating';
  return true;
}

/** Which agents a turned-on tmux toggle actually reaches. */
export type TmuxReach = 'none' | 'codex-agy' | 'all';

/**
 * Claude --bg returns before the tmux branch (see openClaudeMain), so with bg ON the tmux
 * toggle looks enabled while doing nothing for Claude — it still routes Codex/agy. The header
 * renders this reach instead of a plain on/off so the toggle never lies about its effect.
 */
export function tmuxReach(
  app: TerminalApp,
  bgMode: boolean,
  orcaSurface: OrcaLaunchSurface = 'floating',
): TmuxReach {
  // Orca launches through its own terminal surface and powershell has no tmux path at all.
  if (app === 'orca' || app === 'powershell') return 'none';
  return bgMode && isClaudeBgAvailable(app, orcaSurface) ? 'codex-agy' : 'all';
}

/** Defaults applied on first launch after this policy version and when switching terminals. */
export function terminalOptionDefaults(
  app: TerminalApp,
  orcaSurface: OrcaLaunchSurface = 'floating',
): TerminalOptionDefaults {
  switch (app) {
    case 'cmux':
    case 'iterm':
    case 'terminal':
      return { bgMode: true, tmuxMode: true, bypassPermissions: true };
    case 'orca':
      return { bgMode: orcaSurface === 'floating', tmuxMode: false, bypassPermissions: true };
    case 'wsl':
      return { bgMode: true, tmuxMode: true, bypassPermissions: false };
    case 'powershell':
      return { bgMode: false, tmuxMode: false, bypassPermissions: false };
  }
}
