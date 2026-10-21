import { describe, expect, test } from 'bun:test';
import { WhatISaidRemoteMutationLock } from '../src/whatISaidRemoteMutationLock';

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
});
