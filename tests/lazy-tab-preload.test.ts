import {describe, expect, test} from 'bun:test';
import {lazy, type ComponentType} from 'react';
import {preloadableModule, scheduleIdlePreload, PRELOAD_FALLBACK_DELAY_MS, type IdleHost} from '../src/lazyTabPreload';

const Component: ComponentType = () => null;

describe('preloadableModule', () => {
  test('before the module arrives, the factory returns the real (pending) load', async () => {
    let calls = 0;
    const module = preloadableModule(async () => { calls += 1; return {default: Component}; });
    const pending = module.factory();
    expect(pending).toBeInstanceOf(Promise);
    expect(module.ready()).toBe(false);
    await pending;
    expect(module.ready()).toBe(true);
    expect(calls).toBe(1);
  });

  test('after preload, the factory settles synchronously — the property React.lazy needs', async () => {
    const module = preloadableModule(async () => ({default: Component}));
    await module.preload();
    let seen: unknown = null;
    module.factory().then(value => { seen = value; });
    // No await: the callback must already have run, or React.lazy suspends and React 19 holds
    // the reveal for 300ms (measured 326ms → 57ms for the bookmarks tab).
    expect(seen).toEqual({default: Component});
  });

  test('the installed React resolves a preloaded lazy component on its first render without suspending', async () => {
    const module = preloadableModule(async () => ({default: Component}));
    await module.preload();
    const Lazy = lazy(module.factory) as unknown as {_init: (payload: unknown) => unknown; _payload: unknown};
    // `_init` is what React calls during render; throwing a thenable here is what suspends.
    expect(Lazy._init(Lazy._payload)).toBe(Component);
  });

  test('a lazy component that was not preloaded still suspends (control)', () => {
    const module = preloadableModule(async () => ({default: Component}));
    const Lazy = lazy(module.factory) as unknown as {_init: (payload: unknown) => unknown; _payload: unknown};
    let thrown: unknown = null;
    try { Lazy._init(Lazy._payload); } catch (value) { thrown = value; }
    expect(thrown).toBeInstanceOf(Promise);
  });

  test('concurrent preloads share one request, and a failure lets the next call retry', async () => {
    let calls = 0;
    let fail = true;
    const module = preloadableModule(async () => {
      calls += 1;
      if (fail) throw new Error('chunk failed');
      return {default: Component};
    });
    const [a, b] = [module.preload(), module.preload()];
    await expect(a).rejects.toThrow('chunk failed');
    await expect(b).rejects.toThrow('chunk failed');
    expect(calls).toBe(1);
    expect(module.ready()).toBe(false);
    fail = false;
    await module.preload();
    expect(calls).toBe(2);
    expect(module.ready()).toBe(true);
  });
});

function fakeHost(withIdle: boolean) {
  const queue: (() => void)[] = [];
  const delays: number[] = [];
  const cancelled: unknown[] = [];
  const host: IdleHost = {
    setTimeout: (callback, ms) => { delays.push(ms); queue.push(callback); return queue.length; },
    clearTimeout: handle => { cancelled.push(handle); },
    ...(withIdle ? {
      requestIdleCallback: (callback: () => void) => { queue.push(callback); return queue.length; },
      cancelIdleCallback: (handle: number) => { cancelled.push(handle); },
    } : {}),
  };
  const flush = async () => {
    const next = queue.shift();
    next?.();
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return {host, queue, delays, cancelled, flush};
}

describe('scheduleIdlePreload', () => {
  test('runs loaders one at a time, each on its own idle slot, and survives a failing loader', async () => {
    const order: string[] = [];
    const fake = fakeHost(true);
    scheduleIdlePreload([
      async () => { order.push('a'); },
      async () => { order.push('b'); throw new Error('ignored'); },
      () => { order.push('c'); throw new Error('sync throw is ignored too'); },
      async () => { order.push('d'); },
    ], fake.host);
    expect(order).toEqual([]); // nothing on the first paint
    for (let i = 0; i < 4; i += 1) {
      expect(fake.queue.length).toBe(1); // one at a time
      await fake.flush();
    }
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect(fake.queue.length).toBe(0);
  });

  test('without requestIdleCallback it falls back to a delayed timer', async () => {
    const fake = fakeHost(false);
    let ran = false;
    scheduleIdlePreload([async () => { ran = true; }], fake.host);
    expect(fake.delays).toEqual([PRELOAD_FALLBACK_DELAY_MS]);
    await fake.flush();
    expect(ran).toBe(true);
  });

  test('cancel stops loaders that have not started (unmount)', async () => {
    const fake = fakeHost(true);
    const order: string[] = [];
    const cancel = scheduleIdlePreload([async () => { order.push('a'); }, async () => { order.push('b'); }], fake.host);
    await fake.flush();
    cancel();
    expect(fake.cancelled.length).toBe(1);
    await fake.flush();
    expect(order).toEqual(['a']);
  });
});
