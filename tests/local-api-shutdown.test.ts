import { describe, expect, test } from 'bun:test';

import {
  LOCAL_API_SHUTDOWN_HARD_CEILING_MS,
  settleLocalApiShutdown,
} from '../src/localApiShutdown';

describe('local API shutdown deadline', () => {
  test('returns both independent settlement results before the deadline', async () => {
    const outcome = await settleLocalApiShutdown([
      Promise.resolve(),
      Promise.reject(new Error('fixture failure')),
    ], 100);

    expect(outcome.timedOut).toBe(false);
    if (outcome.timedOut) throw new Error('unexpected timeout');
    expect(outcome.results[0]?.status).toBe('fulfilled');
    expect(outcome.results[1]?.status).toBe('rejected');
  });

  test('returns a hard timeout even when both shutdown operations wedge', async () => {
    const never = new Promise<void>(() => undefined);
    const startedAt = performance.now();
    const outcome = await settleLocalApiShutdown([never, never], 10);

    expect(outcome).toEqual({ timedOut: true });
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test('keeps the production ceiling above resolver plus runner cleanup', () => {
    expect(LOCAL_API_SHUTDOWN_HARD_CEILING_MS).toBeGreaterThan(12_000 + 10_000);
  });

  test('rejects an invalid deadline instead of silently disabling the bound', async () => {
    await expect(settleLocalApiShutdown([
      Promise.resolve(),
      Promise.resolve(),
    ], 0)).rejects.toThrow('LOCAL_API_SHUTDOWN_TIMEOUT_INVALID');
  });
});
