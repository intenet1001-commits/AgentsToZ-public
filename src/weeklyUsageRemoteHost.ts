import type {WeeklyUsage} from './weeklyUsage';
import {toRemoteWeeklyUsage,type RemoteWeeklyUsageRow} from './weeklyUsageRemote';

/** The phone path never refreshes more often than the Codex live-read cache (api-server.ts `CODEX_LIVE_RATE_LIMIT_CACHE_MS`). */
export const WEEKLY_USAGE_REMOTE_FRESH_MS = 30_000;
/** The longest a phone read waits for a refresh before it is answered with the last snapshot. */
export const WEEKLY_USAGE_REMOTE_WAIT_MS = 2_000;

/**
 * The Mac's answer to `usage.weekly` (src/weeklyUsageRemote.ts). A phone request runs **inside** the host's single relay poll
 * (docs/claude/remote-relay.md), and a cold Codex read spawns `codex app-server` with a 15 s timeout — awaiting it there would
 * hold every phone's keys on this Mac. So a read answers from the last `status()` snapshot (each row carries its own
 * `checkedAt`; the phone shows an old one as 「이전 값」), starts at most one refresh when that snapshot is older than the Codex
 * cache, and waits for it at most `waitMs`. A refresh still running keeps going in the background and serves the next read.
 * Before the first refresh has finished the answer is empty — 「확인 중」, never a guessed figure. `status()` itself is the
 * existing API, untouched; its Codex read keeps its own 30 s cache and in-flight sharing, so phones add no spawns beyond it.
 */
export function createWeeklyUsageRemoteReader(deps: {status: () => Promise<WeeklyUsage[]>; now?: () => number; freshMs?: number; waitMs?: number}): () => Promise<RemoteWeeklyUsageRow[]> {
  const now = deps.now ?? Date.now, freshMs = deps.freshMs ?? WEEKLY_USAGE_REMOTE_FRESH_MS, waitMs = deps.waitMs ?? WEEKLY_USAGE_REMOTE_WAIT_MS;
  let snapshot: {rows: RemoteWeeklyUsageRow[]; at: number} | null = null;
  let refreshing: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing;
    // Callbacks only (never a synchronous step): the clean-up below must run after `task` exists.
    const task: Promise<void> = Promise.resolve()
      .then(() => deps.status())
      .then(items => { snapshot = {rows: toRemoteWeeklyUsage(items), at: now()}; },
        () => { /* Keep the last snapshot: an unreadable provider is already an empty row inside status(). */ })
      .finally(() => { if (refreshing === task) refreshing = null; });
    refreshing = task;
    return task;
  };
  return async () => {
    if (!snapshot || now() - snapshot.at >= freshMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([refresh(), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    return snapshot?.rows ?? [];
  };
}
