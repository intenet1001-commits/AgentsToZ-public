/**
 * A bounded wait for a remote mutation ended before the operation could start.
 * Nothing ran: the caller reports the upload as not started, not as failed.
 */
export class WhatISaidRemoteWaitExpiredError extends Error {
  readonly code = 'WHAT_I_SAID_REMOTE_WAIT_EXPIRED';
  constructor() {
    super('WHAT_I_SAID_REMOTE_WAIT_EXPIRED');
    this.name = 'WhatISaidRemoteWaitExpiredError';
  }
}

/** Resolves true when `settled` finishes first, false when `ms` passes first. */
async function settledWithin(settled: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Serializes remote upload with remote-first/local-second deletion for one
 * memory. Capture may run from several HTTP/session-end paths at once; without
 * this lock a push can re-upsert an id after the remote DELETE but before the
 * local purge removes its source row.
 *
 * `waitUntil` bounds only the wait for the operation ahead. If that operation
 * is still running then, this one gives up its place without running and
 * throws `WhatISaidRemoteWaitExpiredError`. Later operations still wait for the
 * one ahead, so the order of the operations that do run is unchanged.
 */
export class WhatISaidRemoteMutationLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(
    memoryId: string,
    operation: () => Promise<T> | T,
    options: { waitUntil?: number; now?: () => number } = {},
  ): Promise<T> {
    const key = memoryId.trim();
    if (!key) throw new Error('WHAT_I_SAID_MEMORY_ID_INVALID');
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.tails.set(key, tail);
    const settled = previous.catch(() => {});
    if (options.waitUntil === undefined) {
      await settled;
    } else if (!(await settledWithin(settled, options.waitUntil - (options.now ?? Date.now)()))) {
      release();
      // The operation ahead still runs: the tail must keep chaining it, so it
      // is removed only after that operation has finished.
      void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
      throw new WhatISaidRemoteWaitExpiredError();
    }
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** Pause between attempts on the cross-sidecar remote lock file. */
export const WHAT_I_SAID_REMOTE_FILE_LOCK_RETRY_MS = 20;
/** About 30 s: the wait of an upload or deletion that has no request deadline. */
export const WHAT_I_SAID_REMOTE_FILE_LOCK_MAX_ATTEMPTS = 1_500;

/**
 * Attempts on the remote lock file. Without a deadline this is the long wait
 * of a background upload or a deletion. With one, the wait ends at the
 * deadline: one attempt is always made, so a free lock is still taken.
 */
export function whatISaidRemoteFileLockAttempts(waitUntil?: number, now: () => number = Date.now): number {
  if (waitUntil === undefined) return WHAT_I_SAID_REMOTE_FILE_LOCK_MAX_ATTEMPTS;
  const remaining = Math.max(0, waitUntil - now());
  return Math.min(
    WHAT_I_SAID_REMOTE_FILE_LOCK_MAX_ATTEMPTS,
    1 + Math.floor(remaining / WHAT_I_SAID_REMOTE_FILE_LOCK_RETRY_MS),
  );
}

/**
 * The error to report when the remote lock file could not be taken. Under a
 * deadline, a lock that stayed busy means the operation did not start. A lock
 * left by a dead owner that needs a person to recover it (it has a code) and a
 * lock file that could not be created stay real failures.
 */
export function whatISaidRemoteFileLockFailure(error: unknown, waitUntil?: number): unknown {
  const value = error as { code?: unknown; message?: unknown } | null;
  const busy = value?.code === undefined
    && typeof value?.message === 'string'
    && /저장 잠금을 \d+ms 안에 획득하지 못했습니다\.$/.test(value.message);
  return waitUntil !== undefined && busy ? new WhatISaidRemoteWaitExpiredError() : error;
}
