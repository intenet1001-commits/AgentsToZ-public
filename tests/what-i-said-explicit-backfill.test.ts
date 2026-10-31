import { expect, test } from 'bun:test';
import {
  runWhatISaidExplicitBackfill,
  runWhatISaidSyncBatch,
  whatISaidBackfillOutcome,
  WHAT_I_SAID_SYNC_MIN_START_MS,
  WHAT_I_SAID_SYNC_PUSH_RESERVE_MS,
  WHAT_I_SAID_SYNC_REQUEST_BUDGET_MS,
} from '../src/whatISaidExplicitBackfill';
import type { WhatISaidTranscriptCollectionResult } from '../src/whatISaidTranscriptCollector';

function result(partial: Partial<WhatISaidTranscriptCollectionResult> = {}): WhatISaidTranscriptCollectionResult {
  return {
    enabled: true, enabledAt: '2026-08-30T10:00:00Z', scannedFrom: '1970-01-01T00:00:00.000Z',
    scannedThrough: '2026-08-30T12:00:00Z', scanAdvanced: true, worktreeRoots: 1, claudeFiles: 1,
    codexFiles: 0, userEvents: 0, stored: 0, duplicates: 0, skippedBeforeEnabled: 0, skippedExpired: 0,
    unreadable: 0, withheld: 0, ownershipRejected: 0, bytesRead: 0, pendingFiles: 0,
    budgetExhausted: false, hasMore: false, ...partial,
  };
}

test('one confirmed request continues bounded pages and reports total stored', async () => {
  const pages = [
    result({ stored: 3, bytesRead: 8, budgetExhausted: true, hasMore: true, scanAdvanced: false }),
    result({ stored: 2, bytesRead: 8, budgetExhausted: true, hasMore: true, scanAdvanced: false }),
    result({ stored: 1, bytesRead: 3 }),
  ];
  let passes = 0;
  const actual = await runWhatISaidExplicitBackfill(async () => pages[passes++]!, { yieldControl: async () => {} });
  expect(passes).toBe(3);
  expect(actual).toMatchObject({ stored: 6, bytesRead: 19, scanAdvanced: true, hasMore: false });
});

test('limit and interrupted consent remain visibly incomplete without background retry', async () => {
  let passes = 0;
  const partial = await runWhatISaidExplicitBackfill(async () => {
    passes++;
    return result({ stored: 1, budgetExhausted: true, hasMore: true, scanAdvanced: false });
  }, { maxPasses: 2, yieldControl: async () => {} });
  expect(passes).toBe(2);
  expect(partial).toMatchObject({ stored: 2, hasMore: true, scanAdvanced: false });
  let calls = 0;
  const revoked = await runWhatISaidExplicitBackfill(async () => ++calls === 1
    ? result({ stored: 1, budgetExhausted: true, hasMore: true, scanAdvanced: false })
    : null, { yieldControl: async () => {} });
  expect(revoked).toMatchObject({ enabled: false, stored: 1, hasMore: true, scanAdvanced: false });
  const controller = new AbortController();
  let abortCalls = 0;
  const aborted = await runWhatISaidExplicitBackfill(async () => {
    abortCalls++;
    controller.abort();
    return result({ stored: 1, budgetExhausted: true, hasMore: true, scanAdvanced: false });
  }, { signal: controller.signal, yieldControl: async () => {} });
  expect(abortCalls).toBe(1);
  expect(aborted).toMatchObject({ stored: 1, scanAdvanced: false, hasMore: true });
  let tooSmallCalls = 0;
  const tooSmall = await runWhatISaidExplicitBackfill(async () => {
    tooSmallCalls++;
    return result({ minimumBudgetInsufficient: true, budgetExhausted: true, hasMore: true, scanAdvanced: false });
  }, { yieldControl: async () => {} });
  expect(tooSmallCalls).toBe(1);
  expect(tooSmall).toMatchObject({ minimumBudgetInsufficient: true, hasMore: true, scanAdvanced: false });
  let uncertainCalls = 0;
  const uncertain = await runWhatISaidExplicitBackfill(async () => {
    uncertainCalls++;
    return result({ verificationUncertain: true, budgetExhausted: true, hasMore: true, scanAdvanced: false });
  }, { yieldControl: async () => {} });
  expect(uncertainCalls).toBe(1);
  expect(uncertain).toMatchObject({ verificationUncertain: true, hasMore: true, scanAdvanced: false });
});

test('later passes are marked as continuations of the same request and stop at a caller deadline', async () => {
  let clock = 1_000;
  const seen: Array<{ deadlineAt: number; pass: number }> = [];
  const actual = await runWhatISaidExplicitBackfill(async (deadlineAt, pass) => {
    seen.push({ deadlineAt, pass });
    clock += 2_000;
    return result({ stored: 1, budgetExhausted: true, hasMore: true, scanAdvanced: false });
  }, { now: () => clock, deadlineAt: 6_000, yieldControl: async () => {} });
  // The caller's deadline (5 s from now) is earlier than the runner's own 15 s.
  expect(seen).toEqual([{ deadlineAt: 6_000, pass: 0 }, { deadlineAt: 6_000, pass: 1 }, { deadlineAt: 6_000, pass: 2 }]);
  expect(actual).toMatchObject({ stored: 3, hasMore: true, scanAdvanced: false });
  const own = await runWhatISaidExplicitBackfill(async deadlineAt => {
    expect(deadlineAt).toBe(clock + 15_000);
    return result();
  }, { now: () => clock, deadlineAt: Number.MAX_SAFE_INTEGER, yieldControl: async () => {} });
  expect(own).toMatchObject({ scanAdvanced: true, hasMore: false });
});

test('an unfinished explicit import always carries one stable reason code', () => {
  expect(whatISaidBackfillOutcome(result())).toEqual({ complete: true });
  expect(whatISaidBackfillOutcome(null)).toMatchObject({ complete: false, code: 'WHAT_I_SAID_CAPTURE_DISABLED' });
  expect(whatISaidBackfillOutcome(result({ enabled: false }))).toMatchObject({ complete: false, code: 'WHAT_I_SAID_CAPTURE_DISABLED' });
  expect(whatISaidBackfillOutcome(result({ verificationUncertain: true, hasMore: true, scanAdvanced: false })))
    .toMatchObject({ complete: false, code: 'WHAT_I_SAID_VERIFICATION_UNCERTAIN' });
  expect(whatISaidBackfillOutcome(result({ minimumBudgetInsufficient: true, hasMore: true, scanAdvanced: false })))
    .toMatchObject({ complete: false, code: 'WHAT_I_SAID_SCAN_BUDGET_TOO_SMALL' });
  expect(whatISaidBackfillOutcome(result({ unreadable: 1, hasMore: true, scanAdvanced: false })))
    .toMatchObject({ complete: false, code: 'WHAT_I_SAID_BACKFILL_UNREADABLE' });
  const incomplete = whatISaidBackfillOutcome(result({ budgetExhausted: true, hasMore: true, scanAdvanced: false }));
  expect(incomplete).toMatchObject({ complete: false, code: 'WHAT_I_SAID_BACKFILL_INCOMPLETE' });
  expect(incomplete.complete === false && incomplete.error).toContain('다시 요청하면 이어서 진행합니다');
});

test('a multi-memory sync shares one deadline well inside the 35 s proxy timeout and continues the rest', async () => {
  // 41 memories, each wanting ~15 s of collection plus an upload: run one
  // after another they needed minutes in one request.
  const memories = Array.from({ length: 41 }, (_, index) => `memory-${index}`);
  let clock = 0;
  const now = () => clock;
  const runMemory = async (memoryId: string, window: { captureDeadlineAt: number; pushDeadlineAt: number }) => {
    // The real per-memory runner stops cooperatively at its deadline; one pass may overrun a little.
    let passes = 0;
    const captured = await runWhatISaidExplicitBackfill(async () => {
      passes++;
      clock += 1_500;
      return result({ stored: 1, budgetExhausted: true, hasMore: passes < 10, scanAdvanced: passes >= 10 });
    }, { now, deadlineAt: window.captureDeadlineAt, yieldControl: async () => {} });
    if (clock < window.pushDeadlineAt) clock = Math.min(clock + 2_000, window.pushDeadlineAt);
    return { memoryId, deferred: false, stored: captured?.stored ?? 0, finishedAt: clock };
  };
  const requests: Array<{ started: string[]; elapsed: number }> = [];
  let pending = memories;
  for (let request = 0; request < memories.length && pending.length; request++) {
    const startedAt = clock;
    const batch = await runWhatISaidSyncBatch(pending, {
      now,
      run: runMemory,
      defer: memoryId => ({ memoryId, deferred: true, stored: 0, finishedAt: clock }),
    });
    expect(batch.items.map(item => item.memoryId)).toEqual(pending);
    const started = batch.items.filter(item => !item.deferred).map(item => item.memoryId);
    expect(started.length).toBeGreaterThan(0);
    expect(batch.remaining).toEqual(pending.slice(started.length));
    requests.push({ started, elapsed: clock - startedAt });
    pending = batch.remaining;
  }
  expect(pending).toEqual([]);
  expect(requests.flatMap(request => request.started)).toEqual(memories);
  // Every request ends well before the desktop proxy's 35 s read timeout.
  for (const request of requests) expect(request.elapsed).toBeLessThanOrEqual(WHAT_I_SAID_SYNC_REQUEST_BUDGET_MS);
  expect(WHAT_I_SAID_SYNC_REQUEST_BUDGET_MS).toBeLessThan(35_000);
});

test('a sync batch starts a later memory only with enough time left and defers all on abort', async () => {
  let clock = 0;
  const windows: Array<{ captureDeadlineAt: number; pushDeadlineAt: number }> = [];
  const batch = await runWhatISaidSyncBatch(['a', 'b', 'c'], {
    now: () => clock,
    run: async (memoryId, window) => { windows.push(window); clock += memoryId === 'a' ? 14_000 : 1_000; return `${memoryId}:run`; },
    defer: (memoryId, reason) => `${memoryId}:${reason}`,
  });
  const captureDeadlineAt = WHAT_I_SAID_SYNC_REQUEST_BUDGET_MS - WHAT_I_SAID_SYNC_PUSH_RESERVE_MS;
  expect(windows).toEqual([{ captureDeadlineAt, pushDeadlineAt: WHAT_I_SAID_SYNC_REQUEST_BUDGET_MS }]);
  // 14 s spent: 2 s of collection would be left, below the minimum to start.
  expect(captureDeadlineAt - 14_000).toBeLessThan(WHAT_I_SAID_SYNC_MIN_START_MS);
  expect(batch).toEqual({ items: ['a:run', 'b:deadline', 'c:deadline'], remaining: ['b', 'c'] });

  const controller = new AbortController();
  const aborted = await runWhatISaidSyncBatch(['a', 'b'], {
    now: () => clock,
    signal: controller.signal,
    run: async memoryId => { controller.abort(); return `${memoryId}:run`; },
    defer: (memoryId, reason) => `${memoryId}:${reason}`,
  });
  expect(aborted.items).toEqual(['a:run', 'b:aborted']);
});
