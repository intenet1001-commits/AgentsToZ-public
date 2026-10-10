export const WORKTREE_REMOTE_REFRESH_INTERVAL_MS = 60_000;

export type WorktreeRemoteRefreshState = 'fetched' | 'no-origin';

export interface WorktreeRemoteRefreshResult {
  remoteRefreshError?: string;
  remoteRefreshState?: WorktreeRemoteRefreshState;
}

export type WorktreeRemoteRefreshFeedback =
  | { kind: 'error'; message: string; countsAsRefresh: false }
  | { kind: 'no-origin'; message: string; countsAsRefresh: true }
  | { kind: 'fetched'; message: string; countsAsRefresh: true };

/**
 * A missing origin is a repository capability, not a failed local status refresh.
 * Keeping it out of the error path prevents a successful commit from looking failed
 * and stops the poller from retrying an impossible fetch every 30 seconds.
 */
export function resolveWorktreeRemoteRefreshFeedback(
  rows: WorktreeRemoteRefreshResult[],
): WorktreeRemoteRefreshFeedback {
  const error = rows.find(row => row.remoteRefreshError)?.remoteRefreshError;
  if (error) {
    return { kind: 'error', message: `원격 상태 확인 실패: ${error}`, countsAsRefresh: false };
  }
  const state = rows.find(row => row.remoteRefreshState)?.remoteRefreshState;
  if (state === 'no-origin') {
    return {
      kind: 'no-origin',
      message: '로컬 Git 상태를 갱신했습니다 · GitHub 원격(origin) 미연결',
      countsAsRefresh: true,
    };
  }
  return {
    kind: 'fetched',
    message: '원격 Fetch 후 Git 상태를 갱신했습니다',
    countsAsRefresh: true,
  };
}

export function shouldFetchWorktreeRemote(
  lastRefreshedAt: number | undefined,
  now: number = Date.now(),
  intervalMs: number = WORKTREE_REMOTE_REFRESH_INTERVAL_MS,
): boolean {
  return lastRefreshedAt === undefined || now - lastRefreshedAt >= intervalMs;
}
