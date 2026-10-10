export const REMOTE_CONTROL_RESTORE_RETRY_BASE_MS = 5_000;
export const REMOTE_CONTROL_RESTORE_RETRY_MAX_MS = 60_000;

/**
 * Retry forever, but cap the delay so a Mac that regains connectivity does not
 * stay unreachable for an ever-growing backoff window.
 */
export function remoteControlRestoreRetryDelay(attempt: number): number {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  return Math.min(
    REMOTE_CONTROL_RESTORE_RETRY_MAX_MS,
    REMOTE_CONTROL_RESTORE_RETRY_BASE_MS * (2 ** Math.min(safeAttempt - 1, 20)),
  );
}
