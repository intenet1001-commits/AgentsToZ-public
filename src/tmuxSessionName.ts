/**
 * "실행" and "새 창" only mean anything as a pair if they name the same tmux
 * session. They did not: the reuse path appended the worktree it was launched
 * in, and the server appended `-bypass` when permissions were bypassed, while
 * the force-new path did neither. So "새 창" killed and recreated a session
 * nobody was attached to, and the next "실행" quietly rejoined the original —
 * making the button look like it did nothing.
 *
 * This is the one place that decides the name.
 */

/** The worktree a session runs in is part of its identity: two worktrees of one
 * project are different working copies and must not share a session. */
export function tmuxWorktreeSuffix(worktreePath?: string | null): string {
  const first = (worktreePath ?? '').split(',')[0]?.trim();
  if (!first) return '';
  const leaf = first.replace(/[/\\]+$/, '').split(/[\\/]/).pop();
  return leaf ? `-${leaf}` : '';
}

export function tmuxAgentSessionName(baseName: string, worktreePath?: string | null): string {
  return `${baseName}${tmuxWorktreeSuffix(worktreePath)}`;
}

/** Bypassing permissions runs a different kind of session, so it gets its own
 * name — applied by whichever backend builds the tmux command, exactly once. */
export function tmuxBypassSessionName(sessionName: string, bypass: boolean): string {
  return bypass ? `${sessionName}-bypass` : sessionName;
}

/**
 * The whole rule in one call: base → worktree → bypass.
 *
 * Whoever builds the tmux command owns this — the web API, the Rust backend
 * (`tmux_session_name` in `src-tauri/src/lib.rs`, kept in sync by the golden
 * table in `tests/fixtures/tmux-session-golden.json`). The frontend passes the
 * bare base name so the suffixes are never applied twice, and calls this only
 * to name the session in a toast.
 *
 * It is the same for Claude, Codex and agy. Only Claude used to get the
 * suffixes, so Codex/agy shared one session between a project's main tree and
 * all of its worktrees, and ⚡ quietly attached to the non-bypass session.
 */
export function tmuxSessionName(
  baseName: string,
  worktreePath?: string | null,
  bypass = false,
): string {
  return tmuxBypassSessionName(tmuxAgentSessionName(baseName, worktreePath), bypass);
}
