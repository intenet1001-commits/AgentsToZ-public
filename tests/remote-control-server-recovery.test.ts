import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  REMOTE_CONTROL_RESTORE_RETRY_MAX_MS,
  remoteControlRestoreRetryDelay,
} from '../src/remoteControlReconnectPolicy';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

describe('internet remote-control recovery after server connectivity loss', () => {
  test('retries forever with a bounded exponential delay', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(remoteControlRestoreRetryDelay))
      .toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(remoteControlRestoreRetryDelay(0)).toBe(5_000);
    expect(REMOTE_CONTROL_RESTORE_RETRY_MAX_MS).toBe(60_000);
  });

  test('keeps one retry timer and does not impose a finite attempt ceiling', () => {
    expect(apiSource).toContain('let remoteControlInternetRestoreTimer: ReturnType<typeof setTimeout> | null = null;');
    expect(apiSource).toContain('if (remoteControlInternetRestoreTimer');
    expect(apiSource).toContain('if (retryAfterTransition) scheduleRemoteControlInternetRestore();');
    expect(apiSource).not.toContain('REMOTE_CONTROL_RESTORE_MAX_ATTEMPTS');
  });

  test('deletes identity only on relay rejection and status can trigger healing', () => {
    expect(apiSource).toContain('if (remoteControlHostRejected(error))');
    expect(apiSource).toContain('disableRemoteControlHostRecord(APP_DATA_DIR);');
    expect(apiSource).toContain('if (!remoteControlInternetAgent) scheduleRemoteControlInternetRestore();');
  });
});
