export type SessionSurfaceKind =
  | 'orca-floating'
  | 'orca-worktree'
  | 'cmux'
  | 'iterm'
  | 'terminal'
  | 'vscode'
  | 'desktop-app'
  | 'claude-bg-agent'
  | 'unknown';

/** A background agent is hosted by the Claude Code daemon, not by a terminal.
 * The daemon process inherits none of the launching terminal's environment, so
 * its status-line snapshot is legitimately empty — that absence is evidence of
 * a background agent, never of a terminal we failed to identify. */
export interface ClaudeSessionRuntimeFacts {
  backgroundAgent?: boolean;
}

export interface SessionOrigin {
  clientLabel: string;
  surfaceKind: SessionSurfaceKind;
  surfaceLabel: string;
  surfaceDetail: string | null;
}

export interface ClaudeLaunchContext {
  cmuxWorkspaceId?: string | null;
  cmuxSurfaceId?: string | null;
  orcaWorktreeId?: string | null;
  orcaPaneKey?: string | null;
  termProgram?: string | null;
  termProgramVersion?: string | null;
  claudeCodeEntrypoint?: string | null;
}

const ORCA_FLOATING_WORKTREE_ID = 'global-floating-terminal';

export function classifyClaudeSessionOrigin(
  context: ClaudeLaunchContext | null | undefined,
  runtime?: ClaudeSessionRuntimeFacts | null,
): SessionOrigin {
  const ctx = context ?? {};
  const entrypoint = (ctx.claudeCodeEntrypoint ?? '').toLowerCase();
  const termProgram = (ctx.termProgram ?? '').toLowerCase();
  const clientLabel = /desktop|electron|claude[-_ ]?app/.test(`${entrypoint} ${termProgram}`)
    ? 'Claude 앱'
    : 'Claude Code';
  // A terminal identifier still wins when one exists: a background agent that
  // did inherit a pane key is more precisely described by that pane.
  if (runtime?.backgroundAgent && !ctx.orcaWorktreeId && !ctx.cmuxWorkspaceId && !ctx.cmuxSurfaceId) {
    return {
      clientLabel,
      surfaceKind: 'claude-bg-agent',
      surfaceLabel: '백그라운드 에이전트',
      surfaceDetail: null,
    };
  }
  if (ctx.orcaWorktreeId) {
    const floating = ctx.orcaWorktreeId === ORCA_FLOATING_WORKTREE_ID;
    return {
      clientLabel,
      surfaceKind: floating ? 'orca-floating' : 'orca-worktree',
      surfaceLabel: floating ? 'Orca 플로팅' : 'Orca 워크트리',
      surfaceDetail: floating ? null : ctx.orcaWorktreeId,
    };
  }
  if (ctx.cmuxWorkspaceId || ctx.cmuxSurfaceId) {
    return {
      clientLabel,
      surfaceKind: 'cmux',
      surfaceLabel: 'cmux',
      surfaceDetail: ctx.cmuxWorkspaceId ?? ctx.cmuxSurfaceId ?? null,
    };
  }

  const program = termProgram;
  if (program.includes('iterm')) {
    return { clientLabel, surfaceKind: 'iterm', surfaceLabel: 'iTerm', surfaceDetail: null };
  }
  if (program.includes('apple_terminal')) {
    return { clientLabel, surfaceKind: 'terminal', surfaceLabel: 'Terminal.app', surfaceDetail: null };
  }
  if (program.includes('vscode')) {
    return { clientLabel, surfaceKind: 'vscode', surfaceLabel: 'VS Code 터미널', surfaceDetail: null };
  }
  return { clientLabel, surfaceKind: 'unknown', surfaceLabel: '실행 위치 미확인', surfaceDetail: null };
}

export function classifyCodexSessionOrigin(meta: {
  originator?: string | null;
  source?: unknown;
  cwd?: string | null;
  threadSource?: string | null;
}): SessionOrigin {
  if (meta.originator === 'Codex Desktop') {
    return {
      clientLabel: meta.threadSource === 'subagent' ? 'ChatGPT 앱 · Codex 서브에이전트' : 'ChatGPT 앱 · Codex',
      surfaceKind: 'desktop-app',
      surfaceLabel: 'ChatGPT 데스크탑',
      surfaceDetail: null,
    };
  }
  if (meta.originator === 'codex-tui') {
    const normalized = (meta.cwd ?? '').replace(/\\/g, '/');
    if (normalized.includes('/Library/Application Support/orca/')) {
      return { clientLabel: 'Codex CLI', surfaceKind: 'orca-floating', surfaceLabel: 'Orca 플로팅', surfaceDetail: null };
    }
    // Codex records the editor family it was launched from. Orca exports
    // TERM_PROGRAM=Orca, so a `vscode` source is a genuine VS Code-family
    // terminal — but Cursor and other forks report it too, hence "계열".
    if (meta.source === 'vscode') {
      return { clientLabel: 'Codex CLI', surfaceKind: 'vscode', surfaceLabel: 'VS Code 계열 터미널', surfaceDetail: null };
    }
    return { clientLabel: 'Codex CLI', surfaceKind: 'unknown', surfaceLabel: 'CLI 위치 미확인', surfaceDetail: null };
  }
  if (meta.originator === 'codex_exec') {
    return { clientLabel: 'Codex 자동 실행', surfaceKind: 'unknown', surfaceLabel: '백그라운드', surfaceDetail: null };
  }
  return { clientLabel: 'Codex', surfaceKind: 'unknown', surfaceLabel: '실행 위치 미확인', surfaceDetail: null };
}
