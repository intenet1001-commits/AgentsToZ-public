import { expect, test } from 'bun:test';
import { MemorySaveDispatcher } from '../src/memorySaveDispatcher';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('manual, Workroom and checkpoint share one slot; duplicate roots never run', async () => {
  const dispatcher = new MemorySaveDispatcher(); const hold = gate(); const started = gate();
  const calls: string[] = [];
  const first = dispatcher.schedule({ root: '/a', trigger: 'workroom', run: async () => {
    calls.push('workroom'); started.release(); await hold.promise; return 'saved';
  } });
  await started.promise;
  const second = dispatcher.schedule({ root: '/b', trigger: 'checkpoint', run: async () => { calls.push('checkpoint'); return 'unchanged'; } });
  const manual = dispatcher.schedule({ root: '/c', trigger: 'manual', run: async () => { calls.push('manual'); return 'saved'; } });
  try {
    await expect(dispatcher.schedule({ root: '/a', trigger: 'manual', run: async () => { throw new Error('duplicate'); } })).rejects.toMatchObject({ code: 'MEMORY_SAVE_BUSY' });
    await expect(dispatcher.schedule({ root: '/b', trigger: 'manual', run: async () => { throw new Error('duplicate'); } })).rejects.toMatchObject({ code: 'MEMORY_SAVE_BUSY' });
    expect(calls).toEqual(['workroom']); expect(dispatcher.status().pending).toBe(2);
  } finally { hold.release(); }
  expect(await Promise.all([first, second, manual])).toEqual(['saved', 'unchanged', 'saved']);
  expect(calls).toEqual(['workroom', 'manual', 'checkpoint']);
  expect(dispatcher.status()).toEqual({ active: false, pending: 0, stopped: false });
});

test('three manual admissions yield to the oldest background request', async () => {
  const dispatcher = new MemorySaveDispatcher(); const hold = gate(); const calls: string[] = [];
  const initial = dispatcher.schedule({ root: '/initial', trigger: 'workroom', run: () => hold.promise });
  const tasks = ['b1', 'b2', 'm1', 'm2', 'm3', 'm4'].map(root => dispatcher.schedule({
    root, trigger: root.startsWith('m') ? 'manual' : 'checkpoint', run: async () => { calls.push(root); },
  }));
  hold.release(); await Promise.all([initial, ...tasks]);
  expect(calls).toEqual(['m1', 'm2', 'm3', 'b1', 'm4', 'b2']);
});

test('bounded wait, overflow and queued cancellation do not execute or retain jobs', async () => {
  const dispatcher = new MemorySaveDispatcher({ maxPending: 2, waitMs: 30 }); const hold = gate();
  let calls = 0;
  const active = dispatcher.schedule({ root: '/active', trigger: 'workroom', run: () => hold.promise });
  const cancelled = new AbortController();
  const pending = dispatcher.schedule({ root: '/wait', trigger: 'manual', run: async () => { calls++; } }).catch(error => error);
  const removed = dispatcher.schedule({ root: '/abort', trigger: 'manual', waitingSignal: cancelled.signal, run: async () => { calls++; } }).catch(error => error);
  try {
    await expect(dispatcher.schedule({ root: '/overflow', trigger: 'checkpoint', run: async () => { calls++; } })).rejects.toMatchObject({ code: 'MEMORY_SAVE_BUSY' });
    cancelled.abort(); expect((await removed).code).toBe('MEMORY_SAVE_CANCELLED');
    expect((await pending).code).toBe('MEMORY_SAVE_BUSY');
    expect(dispatcher.status().pending).toBe(0); expect(calls).toBe(0);
  } finally { hold.release(); await active; }
  await dispatcher.schedule({ root: '/wait', trigger: 'manual', run: async () => { calls++; } });
  expect(calls).toBe(1);
});

test('request disconnect cancels only waiting; shutdown aborts active but waits for cleanup proof', async () => {
  const dispatcher = new MemorySaveDispatcher(); const started = gate(); const cleanup = gate();
  const disconnected = new AbortController(); let activeSignal!: AbortSignal; let stopped = false;
  const active = dispatcher.schedule({ root: '/active', trigger: 'manual', waitingSignal: disconnected.signal,
    run: async signal => { activeSignal = signal; started.release(); await cleanup.promise; return 'receipt'; },
  });
  await started.promise; disconnected.abort(); expect(activeSignal.aborted).toBe(false);
  const pending = dispatcher.schedule({ root: '/pending', trigger: 'checkpoint', run: async () => { throw new Error('must not run'); } }).catch(error => error);
  const stop = dispatcher.shutdown().then(() => { stopped = true; });
  expect((await pending).code).toBe('MEMORY_SAVE_STOPPED');
  expect(activeSignal.aborted).toBe(true); expect(stopped).toBe(false);
  await expect(dispatcher.schedule({ root: '/new', trigger: 'manual', run: async () => {} })).rejects.toMatchObject({ code: 'MEMORY_SAVE_STOPPED' });
  cleanup.release(); expect(await active).toBe('receipt'); await stop;
  expect(dispatcher.status()).toEqual({ active: false, pending: 0, stopped: true });
});

test('provider failure is never retried by the dispatcher and releases the next root', async () => {
  const dispatcher = new MemorySaveDispatcher(); let calls = 0;
  await expect(dispatcher.schedule({ root: '/a', trigger: 'manual', run: async () => { calls++; throw new Error('provider failed'); } })).rejects.toThrow('provider failed');
  expect(await dispatcher.schedule({ root: '/b', trigger: 'checkpoint', run: async () => 'saved' })).toBe('saved');
  expect(calls).toBe(1); expect(dispatcher.status().active).toBe(false);
});
