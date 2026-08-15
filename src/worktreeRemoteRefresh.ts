export const WORKTREE_REMOTE_REFRESH_INTERVAL_MS = 60_000;

export function shouldFetchWorktreeRemote(
  lastRefreshedAt: number | undefined,
  now: number = Date.now(),
  intervalMs: number = WORKTREE_REMOTE_REFRESH_INTERVAL_MS,
): boolean {
  return lastRefreshedAt === undefined || now - lastRefreshedAt >= intervalMs;
}
