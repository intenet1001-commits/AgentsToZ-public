/**
 * The Bun sidecar must make one bounded decision before the native host uses
 * its own, slightly longer hard-kill deadline. This ceiling includes an
 * in-flight Agent Runtime resolver (12s), runner cleanup (10s), and margin for
 * durable terminal state/SQLite close.
 */
export const LOCAL_API_SHUTDOWN_HARD_CEILING_MS = 24_000;

export type LocalApiShutdownResults = readonly [
  PromiseSettledResult<void>,
  PromiseSettledResult<void>,
];

export type LocalApiShutdownOutcome =
  | { timedOut: false; results: LocalApiShutdownResults }
  | { timedOut: true };

/**
 * Wait for the independently owned shutdown operations without allowing one
 * wedged integration to hold the sidecar open forever. `allSettled` also
 * consumes late rejections after the timeout wins the race.
 */
export async function settleLocalApiShutdown(
  operations: readonly [Promise<void>, Promise<void>],
  timeoutMs = LOCAL_API_SHUTDOWN_HARD_CEILING_MS,
): Promise<LocalApiShutdownOutcome> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('LOCAL_API_SHUTDOWN_TIMEOUT_INVALID');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.allSettled(operations).then(results => ({
    timedOut: false as const,
    results: results as unknown as LocalApiShutdownResults,
  }));
  const deadline = new Promise<{ timedOut: true }>(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
