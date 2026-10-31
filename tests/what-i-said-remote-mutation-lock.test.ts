import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireOwnedFileLock } from '../src/portalFileLock';
import {
  WHAT_I_SAID_REMOTE_FILE_LOCK_MAX_ATTEMPTS,
  WHAT_I_SAID_REMOTE_FILE_LOCK_RETRY_MS,
  WhatISaidRemoteMutationLock,
  WhatISaidRemoteWaitExpiredError,
  whatISaidRemoteFileLockAttempts,
  whatISaidRemoteFileLockFailure,
} from '../src/whatISaidRemoteMutationLock';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe('What-I-said remote mutation serialization', () => {
  test('a delete cannot interleave with a push for the same memory', async () => {
    const lock = new WhatISaidRemoteMutationLock();
    const pushGate = deferred();
    const events: string[] = [];
    const push = lock.run('memory-a', async () => {
      events.push('push:start');
      await pushGate.promise;
      events.push('push:end');
    });
    await Promise.resolve();
    const deletion = lock.run('memory-a', async () => {
      events.push('delete:remote');
      await Promise.resolve();
      events.push('delete:local');
    });
    await Promise.resolve();
    expect(events).toEqual(['push:start']);
    pushGate.resolve();
    await Promise.all([push, deletion]);
    expect(events).toEqual(['push:start', 'push:end', 'delete:remote', 'delete:local']);
  });

  test('a failed operation releases the memory and unrelated memories stay concurrent', async () => {
    const lock = new WhatISaidRemoteMutationLock();
    const gate = deferred();
    const events: string[] = [];
    const first = lock.run('memory-a', async () => {
      events.push('a:start');
      await gate.promise;
      throw new Error('expected');
    }).catch(error => error.message);
    const other = lock.run('memory-b', () => { events.push('b'); });
    await other;
    expect(events).toEqual(['a:start', 'b']);
    gate.resolve();
    expect(await first).toBe('expected');
    await lock.run('memory-a', () => { events.push('a:retry'); });
    expect(events.at(-1)).toBe('a:retry');
  });

  // A manual sync shares one 20 s deadline under the desktop proxy's 35 s read
  // timeout. Waiting without a limit behind a long background upload of the
  // same memory pushed the response past that timeout (review 2026-10-28).
  test('a bounded wait ends at its deadline without running and keeps the order', async () => {
    const lock = new WhatISaidRemoteMutationLock();
    const pushGate = deferred();
    const events: string[] = [];
    const background = lock.run('memory-a', async () => {
      events.push('background:start');
      await pushGate.promise;
      events.push('background:end');
    });
    await Promise.resolve();
    const startedAt = Date.now();
    const bounded = lock.run('memory-a', () => { events.push('bounded'); }, { waitUntil: startedAt + 60 });
    const after = lock.run('memory-a', () => { events.push('after'); });
    const error = await bounded.then(() => null, value => value);
    expect(error).toBeInstanceOf(WhatISaidRemoteWaitExpiredError);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // Giving up the place must not let the next operation overlap the one still running.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(events).toEqual(['background:start']);
    pushGate.resolve();
    await Promise.all([background, after]);
    expect(events).toEqual(['background:start', 'background:end', 'after']);
    // Nothing ahead: a bounded operation runs even with its deadline already passed.
    expect(await lock.run('memory-a', () => 'ran', { waitUntil: Date.now() - 1 })).toBe('ran');
  });

  test('a held remote file lock ends a bounded wait at the deadline instead of about 30 s', async () => {
    expect(whatISaidRemoteFileLockAttempts() * WHAT_I_SAID_REMOTE_FILE_LOCK_RETRY_MS).toBe(30_000);
    expect(whatISaidRemoteFileLockAttempts(1_000, () => 1_000)).toBe(1);
    expect(whatISaidRemoteFileLockAttempts(900, () => 1_000)).toBe(1);
    expect(whatISaidRemoteFileLockAttempts(5_000, () => 1_000)).toBe(201);
    expect(whatISaidRemoteFileLockAttempts(Number.MAX_SAFE_INTEGER, () => 0)).toBe(WHAT_I_SAID_REMOTE_FILE_LOCK_MAX_ATTEMPTS);

    const root = mkdtempSync(join(tmpdir(), 'what-i-said-remote-lock-'));
    const lockPath = join(root, 'what-i-said-remote.lock');
    const options = (waitUntil?: number) => ({
      attempts: whatISaidRemoteFileLockAttempts(waitUntil),
      retryMs: WHAT_I_SAID_REMOTE_FILE_LOCK_RETRY_MS,
      staleAfterMs: 60_000,
      label: 'what-i-said remote mutation',
    });
    try {
      const held = await acquireOwnedFileLock(lockPath, options());
      const startedAt = Date.now();
      const waitUntil = startedAt + 150;
      const error = await acquireOwnedFileLock(lockPath, options(waitUntil))
        .then(() => null, value => whatISaidRemoteFileLockFailure(value, waitUntil));
      expect(error).toBeInstanceOf(WhatISaidRemoteWaitExpiredError);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      // Without a deadline the same busy lock stays a real failure.
      const unbounded = await acquireOwnedFileLock(lockPath, { ...options(), attempts: 1 })
        .then(() => null, value => whatISaidRemoteFileLockFailure(value));
      expect(unbounded).not.toBeInstanceOf(WhatISaidRemoteWaitExpiredError);
      expect((unbounded as Error).message).toContain('획득하지 못했습니다');
      held();
      const free = await acquireOwnedFileLock(lockPath, options(Date.now() - 1));
      free();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // A lock that needs a person to recover it is never reported as "not started".
    const recovery = Object.assign(new Error('what-i-said remote mutation 저장 잠금을 20ms 안에 획득하지 못했습니다. 종료된 프로세스의 잠금이 남아 있습니다.'), { code: 'FILE_LOCK_RECOVERY_REQUIRED' });
    expect(whatISaidRemoteFileLockFailure(recovery, Date.now())).toBe(recovery);
    const creation = new Error('what-i-said remote mutation 잠금 생성 실패: EACCES');
    expect(whatISaidRemoteFileLockFailure(creation, Date.now())).toBe(creation);
  });

  test('the server bounds both waits of a deadline-bound upload', () => {
    const server = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    expect(server).toContain('attempts: whatISaidRemoteFileLockAttempts(waitUntil),');
    expect(server).toContain('throw whatISaidRemoteFileLockFailure(error, waitUntil);');
    expect(server).toContain('() => withWhatISaidRemoteFileLock(() => pushWhatISaidRemote(project, options), options.deadlineAt),');
    expect(server).toContain('{ waitUntil: options.deadlineAt },');
    expect(server).toContain('if (error instanceof WhatISaidRemoteWaitExpiredError) return null;');
  });
});
