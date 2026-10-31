import type { WhatISaidTranscriptCollectionResult } from './whatISaidTranscriptCollector';

/**
 * Run only within the lifetime of the user's explicit request.
 *
 * `pass` is 0 for the first collection of the request and grows for each
 * continuation. A collector may resume a verification page only when
 * `pass > 0`: the previous pass of this same request saved it seconds ago.
 * `deadlineAt` lets a caller that shares one request among several memories
 * end this memory earlier than its own `maxElapsedMs`.
 */
export async function runWhatISaidExplicitBackfill(
  capture: (deadlineAt: number, pass: number) => Promise<WhatISaidTranscriptCollectionResult | null>,
  options: { maxPasses?: number; maxElapsedMs?: number; deadlineAt?: number; now?: () => number; yieldControl?: () => Promise<void>; signal?: AbortSignal } = {},
): Promise<WhatISaidTranscriptCollectionResult | null> {
  const now = options.now ?? Date.now;
  const start = now();
  const maxPasses = options.maxPasses ?? 32;
  const maxElapsedMs = options.maxElapsedMs ?? 15_000;
  const deadlineAt = Math.min(start + maxElapsedMs, options.deadlineAt ?? Number.POSITIVE_INFINITY);
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  let combined: WhatISaidTranscriptCollectionResult | null = null;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (options.signal?.aborted) return combined ? { ...combined, scanAdvanced: false, hasMore: true } : null;
    if (pass && now() >= deadlineAt) break;
    const result = await capture(deadlineAt, pass);
    if (!result) return combined ? { ...combined, enabled: false, scanAdvanced: false, hasMore: true } : null;
    if (!combined) combined = { ...result };
    else {
      combined = {
        ...result,
        userEvents: combined.userEvents + result.userEvents,
        stored: combined.stored + result.stored,
        duplicates: combined.duplicates + result.duplicates,
        skippedBeforeEnabled: combined.skippedBeforeEnabled + result.skippedBeforeEnabled,
        skippedExpired: combined.skippedExpired + result.skippedExpired,
        withheld: combined.withheld + result.withheld,
        ownershipRejected: combined.ownershipRejected + result.ownershipRejected,
        bytesRead: combined.bytesRead + result.bytesRead,
      };
    }
    if (!result.enabled || result.minimumBudgetInsufficient || result.verificationUncertain || (!result.budgetExhausted && !result.snapshotChanged) || !result.hasMore || result.unreadable) break;
    if (pass + 1 < maxPasses) await yieldControl();
  }
  return combined;
}

export type WhatISaidBackfillIncompleteCode =
  | 'WHAT_I_SAID_CAPTURE_DISABLED'
  | 'WHAT_I_SAID_VERIFICATION_UNCERTAIN'
  | 'WHAT_I_SAID_SCAN_BUDGET_TOO_SMALL'
  | 'WHAT_I_SAID_BACKFILL_UNREADABLE'
  | 'WHAT_I_SAID_BACKFILL_INCOMPLETE';

/**
 * One stable reason for an explicit backfill that did not finish. Messages are
 * the local API's fixed Korean text; clients map the code to their own copy.
 */
export function whatISaidBackfillOutcome(result: WhatISaidTranscriptCollectionResult | null):
  { complete: true } | { complete: false; code: WhatISaidBackfillIncompleteCode; error: string } {
  if (!result?.enabled) {
    return { complete: false, code: 'WHAT_I_SAID_CAPTURE_DISABLED', error: '이 장기기억의 프롬프트 저장을 먼저 켜세요.' };
  }
  if (result.verificationUncertain) {
    return { complete: false, code: 'WHAT_I_SAID_VERIFICATION_UNCERTAIN', error: '파일을 한 번에 확인할 수 없어 전체 수집 완료 여부를 확인하지 못했습니다.' };
  }
  if (result.minimumBudgetInsufficient) {
    return { complete: false, code: 'WHAT_I_SAID_SCAN_BUDGET_TOO_SMALL', error: '한 대화 항목이 수집 예산보다 커서 이어갈 수 없습니다.' };
  }
  if (result.scanAdvanced && !result.hasMore && result.unreadable === 0) return { complete: true };
  if (result.unreadable > 0) {
    return { complete: false, code: 'WHAT_I_SAID_BACKFILL_UNREADABLE', error: '일부 대화 파일을 읽지 못해 가져오기를 끝내지 못했습니다. 다시 요청하면 그 파일부터 다시 확인합니다.' };
  }
  return { complete: false, code: 'WHAT_I_SAID_BACKFILL_INCOMPLETE', error: '가져오기가 아직 끝나지 않았습니다. 다시 요청하면 이어서 진행합니다.' };
}

/**
 * The desktop app reaches the local API through a management proxy whose read
 * timeout is 35 s (src-tauri/src/lib.rs). One manual sync request therefore
 * shares a single deadline among all of its memories. Waits for the upload's
 * queue and lock end at the deadline; the margin is for I/O already started
 * that is checked only between steps (one collection pass, remote calls of
 * one upload page, each with an 8 s timeout). It is not a hard limit.
 */
export const WHAT_I_SAID_SYNC_REQUEST_BUDGET_MS = 20_000;
/** Kept back from collection so the explicit upload can still start. */
export const WHAT_I_SAID_SYNC_PUSH_RESERVE_MS = 4_000;
/** A later memory starts only with at least this much collection time left. */
export const WHAT_I_SAID_SYNC_MIN_START_MS = 3_000;

export interface WhatISaidSyncWindow {
  /** Collection for this memory stops cooperatively at this instant. */
  captureDeadlineAt: number;
  /**
   * Upload waits and pages stop at this instant. The rest waits for a later
   * upload: the next sync, or the background upload when automatic upload is
   * on (only explicit uploads run when it is off).
   */
  pushDeadlineAt: number;
}

/**
 * Process memories in order under one request deadline. The first memory
 * always runs, so a repeated continuation always makes progress. Memories that
 * are not started are returned through `defer` and in `remaining`, which the
 * caller hands back as the continuation of the same user request.
 */
export async function runWhatISaidSyncBatch<T, R>(targets: readonly T[], options: {
  run: (target: T, window: WhatISaidSyncWindow) => Promise<R>;
  defer: (target: T, reason: 'deadline' | 'aborted') => R;
  now?: () => number;
  budgetMs?: number;
  pushReserveMs?: number;
  minimumStartMs?: number;
  signal?: AbortSignal;
}): Promise<{ items: R[]; remaining: T[] }> {
  const now = options.now ?? Date.now;
  const pushDeadlineAt = now() + (options.budgetMs ?? WHAT_I_SAID_SYNC_REQUEST_BUDGET_MS);
  const captureDeadlineAt = pushDeadlineAt - (options.pushReserveMs ?? WHAT_I_SAID_SYNC_PUSH_RESERVE_MS);
  const minimumStartMs = options.minimumStartMs ?? WHAT_I_SAID_SYNC_MIN_START_MS;
  const items: R[] = [];
  for (const [index, target] of targets.entries()) {
    const aborted = options.signal?.aborted === true;
    if (aborted || (index > 0 && captureDeadlineAt - now() < minimumStartMs)) {
      const remaining = targets.slice(index);
      items.push(...remaining.map(item => options.defer(item, aborted ? 'aborted' : 'deadline')));
      return { items, remaining };
    }
    items.push(await options.run(target, { captureDeadlineAt, pushDeadlineAt }));
  }
  return { items, remaining: [] };
}
