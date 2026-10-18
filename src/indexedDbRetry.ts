/**
 * iOS suspends an app that goes to the background (opening Safari from a bookmark is enough), and WebKit aborts the
 * IndexedDB transactions that were in flight. The next attempt on a fresh connection succeeds — but each relay vault
 * opened one connection, failed once, and the phone showed 「원격제어 세션을 안전하게 복구하지 못했습니다 … 새 QR」
 * for a session that was still alive (iPhone 13 v985, 2026-10-16).
 *
 * Only for idempotent operations on one record or a whole store (get, put of the same value, delete, clear, a
 * read-only cursor): an aborted transaction commits nothing, so running it again cannot apply anything twice.
 */
export const INDEXED_DB_RETRY_DELAYS_MS = [150, 600] as const;

export async function withIndexedDbRetry<T>(
  attempt: () => Promise<T>,
  options: { retryable: (error: unknown) => boolean; sleep?: (ms: number) => Promise<void>; available?: () => boolean },
): Promise<T> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const available = options.available ?? (() => typeof indexedDB !== 'undefined');
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      // No IndexedDB at all is not a passing state: answer at once.
      if (!available() || index >= INDEXED_DB_RETRY_DELAYS_MS.length || !options.retryable(error)) throw error;
      await sleep(INDEXED_DB_RETRY_DELAYS_MS[index]!);
    }
  }
}

/** The vault error codes a fresh connection can cure (not a malformed record or a context mismatch). */
export function isTransientIndexedDbCode(code: unknown): boolean {
  return code === 'INDEXED_DB_FAILED' || code === 'INDEXED_DB_UNAVAILABLE' || code === 'INDEXED_DB_BLOCKED';
}
