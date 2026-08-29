/**
 * Reusing an existing window versus opening a new one is a property of the
 * terminal surface, not of the agent: Claude, Codex and agy all go through the
 * same surfaces and behave identically on each. The UI used to offer the choice
 * for Claude only, which made the two look like different Claude features
 * rather than one option that applies everywhere.
 *
 * This module is the single answer to "what will 실행 do here?", so the buttons
 * for all three agents can describe themselves truthfully.
 */
export type AgentLaunchSurfaceKind =
  | 'orca-floating'
  | 'orca-worktree'
  | 'cmux'
  | 'tmux'
  | 'terminal';

export type AgentLaunchReuse = 'reuse-or-new' | 'always-new';

export interface AgentLaunchSurfaceInput {
  terminalApp: string;
  /** Orca only: 'floating' reuses a registered tab, 'worktree' does not. */
  orcaLaunchMode?: string | null;
  tmuxMode?: boolean;
}

export interface AgentLaunchPolicy {
  surface: AgentLaunchSurfaceKind;
  reuse: AgentLaunchReuse;
  /** What the primary button does, phrased for a tooltip. */
  runTitle: string;
  /** What the secondary button does. */
  newTitle: string;
  /** One line describing the pair, shown once above the agent buttons. */
  summary: string;
}

export function resolveAgentLaunchSurface(input: AgentLaunchSurfaceInput): AgentLaunchSurfaceKind {
  if (input.terminalApp === 'orca') {
    return input.orcaLaunchMode === 'floating' ? 'orca-floating' : 'orca-worktree';
  }
  if (input.terminalApp === 'cmux') return 'cmux';
  if (input.terminalApp === 'wsl') return input.tmuxMode === false ? 'terminal' : 'tmux';
  if (input.terminalApp === 'iterm' || input.terminalApp === 'terminal') {
    return input.tmuxMode ? 'tmux' : 'terminal';
  }
  return 'terminal';
}

const SURFACE_REUSE: Record<AgentLaunchSurfaceKind, AgentLaunchReuse> = {
  // A registered floating tab is looked up and revealed before creating one.
  'orca-floating': 'reuse-or-new',
  // `terminal create` always adds another terminal inside the worktree.
  'orca-worktree': 'always-new',
  // `cmux new-workspace` always creates a workspace.
  cmux: 'always-new',
  // `tmux new-session -d … || attach` is reuse by construction.
  tmux: 'reuse-or-new',
  // A bare terminal window has no session identity to come back to.
  terminal: 'always-new',
};

const SURFACE_NAME: Record<AgentLaunchSurfaceKind, string> = {
  'orca-floating': 'Orca 플로팅',
  'orca-worktree': 'Orca 워크트리 내부',
  cmux: 'cmux',
  tmux: 'tmux',
  terminal: '터미널',
};

export function describeAgentLaunchPolicy(input: AgentLaunchSurfaceInput): AgentLaunchPolicy {
  const surface = resolveAgentLaunchSurface(input);
  const reuse = SURFACE_REUSE[surface];
  const where = SURFACE_NAME[surface];
  return {
    surface,
    reuse,
    runTitle: reuse === 'reuse-or-new'
      ? `${where}에 이 프로젝트의 창이 있으면 그 창을 열고, 없으면 새로 만듭니다.`
      : `${where}은 기존 창을 다시 찾을 수 없어 실행할 때마다 새 창을 만듭니다.`,
    newTitle: reuse === 'reuse-or-new'
      ? `기존 창과 관계없이 ${where}에 새 창을 만듭니다.`
      : `${where}에 새 창을 만듭니다. (실행과 동작이 같습니다)`,
    summary: reuse === 'reuse-or-new'
      ? `실행 = 창이 있으면 기존 창, 없으면 새 창 · 새 창 = 항상 새로 · Claude·Codex·agy 공통 (${where})`
      : `${where}에서는 실행과 새 창이 모두 새 창을 만듭니다 · Claude·Codex·agy 공통`,
  };
}
