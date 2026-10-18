import { describe, expect, test } from 'bun:test';
import {
  applyWhatISaidPushOutcome,
  WhatISaidIntervalGate,
  WhatISaidRemoteBreaker,
  WhatISaidRemotePushGate,
  WhatISaidTtlCache,
} from '../src/whatISaidRemoteThrottle';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('WhatISaidRemoteBreaker', () => {
  test('opens after a failure with exponential backoff capped at the maximum', () => {
    const c = clock();
    const breaker = new WhatISaidRemoteBreaker({ baseMs: 15_000, maxMs: 600_000, now: c.now });
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.retryAt()).toBe(c.now() + 15_000);
    c.advance(15_000);
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.retryAt()).toBe(c.now() + 30_000);
    for (let i = 0; i < 20; i += 1) breaker.recordFailure();
    expect(breaker.retryAt()).toBe(c.now() + 600_000);
  });

  test('a success closes the breaker and resets the backoff', () => {
    const c = clock();
    const breaker = new WhatISaidRemoteBreaker({ now: c.now });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.consecutiveFailures()).toBe(0);
    breaker.recordFailure();
    expect(breaker.retryAt()).toBe(c.now() + 15_000);
  });
});

describe('WhatISaidTtlCache', () => {
  test('serves the cached value within the TTL and reloads after it', async () => {
    const c = clock();
    const cache = new WhatISaidTtlCache<number>(60_000, c.now);
    let calls = 0;
    const loader = async () => ++calls;
    expect(await cache.get(loader)).toBe(1);
    c.advance(59_999);
    expect(await cache.get(loader)).toBe(1);
    c.advance(1);
    expect(await cache.get(loader)).toBe(2);
  });

  test('coalesces concurrent loads and never caches a failure', async () => {
    const cache = new WhatISaidTtlCache<string>(60_000);
    let calls = 0;
    let release!: (value: string) => void;
    const loader = () => { calls += 1; return new Promise<string>(resolve => { release = resolve; }); };
    const first = cache.get(loader);
    const second = cache.get(loader);
    release('ok');
    expect(await first).toBe('ok');
    expect(await second).toBe('ok');
    expect(calls).toBe(1);

    const failing = new WhatISaidTtlCache<string>(60_000);
    await expect(failing.get(async () => { throw new Error('remote down'); })).rejects.toThrow('remote down');
    expect(await failing.get(async () => 'recovered')).toBe('recovered');
  });

  test('invalidate forces the next read and drops a load that started before it', async () => {
    const cache = new WhatISaidTtlCache<string>(60_000);
    expect(await cache.get(async () => 'old')).toBe('old');
    cache.invalidate();
    expect(await cache.get(async () => 'new')).toBe('new');

    cache.invalidate();
    let release!: (value: string) => void;
    const stale = cache.get(() => new Promise<string>(resolve => { release = resolve; }));
    cache.invalidate();
    release('stale');
    await stale;
    expect(await cache.get(async () => 'fresh')).toBe('fresh');
  });
});

describe('WhatISaidRemotePushGate', () => {
  test('pushes when something new was stored, and on the first tick after start', () => {
    const gate = new WhatISaidRemotePushGate();
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '5' })).toBe(true);
    gate.recordSuccess('m', '5');
    expect(gate.shouldPush('m', { stored: 3, localMaxSeq: '5' })).toBe(true);
  });

  test('an idle tick with no new local rows does not push', () => {
    const c = clock();
    const gate = new WhatISaidRemotePushGate({ now: c.now });
    gate.recordSuccess('m', '5');
    c.advance(15_000);
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '5' })).toBe(false);
    // 다른 경로(수동 수집 등)로 로컬 seq 가 올라갔다면 올린다.
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '6' })).toBe(true);
    // 큰 seq 도 문자열 그대로 정확히 비교한다.
    gate.recordSuccess('big', '9007199254740993');
    expect(gate.shouldPush('big', { stored: 0, localMaxSeq: '9007199254740993' })).toBe(false);
    expect(gate.shouldPush('big', { stored: 0, localMaxSeq: '9007199254740994' })).toBe(true);
  });

  test('verifies against the remote occasionally even when idle', () => {
    const c = clock();
    const gate = new WhatISaidRemotePushGate({ verifyIntervalMs: 3_600_000, now: c.now });
    gate.recordSuccess('m', '5');
    c.advance(3_599_999);
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '5' })).toBe(false);
    c.advance(1);
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '5' })).toBe(true);
  });

  test('an unreadable local probe waits for the verify interval instead of pushing every tick', () => {
    const c = clock();
    const gate = new WhatISaidRemotePushGate({ now: c.now });
    gate.recordSuccess('m', null);
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: null })).toBe(false);
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '1' })).toBe(true);
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '0' })).toBe(false);
  });

  test('a failed push forgets the high-water mark so the next chance retries', () => {
    const gate = new WhatISaidRemotePushGate();
    gate.recordSuccess('m', '5');
    gate.recordFailure('m');
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '5' })).toBe(true);
    gate.recordSuccess('m', '5');
    gate.invalidate();
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '5' })).toBe(true);
  });
});

test('WhatISaidIntervalGate admits at most once per interval', () => {
  const c = clock();
  const gate = new WhatISaidIntervalGate(3_600_000, c.now);
  expect(gate.tryEnter()).toBe(true);
  expect(gate.tryEnter()).toBe(false);
  c.advance(3_600_000);
  expect(gate.tryEnter()).toBe(true);
});

describe('applyWhatISaidPushOutcome', () => {
  const setup = () => {
    const c = clock();
    const breaker = new WhatISaidRemoteBreaker({ now: c.now });
    const gate = new WhatISaidRemotePushGate({ now: c.now });
    return { c, breaker, gate };
  };

  test('a local store failure does not open the shared remote breaker', () => {
    const { breaker, gate } = setup();
    const ok = applyWhatISaidPushOutcome({ breaker, gate }, 'm', '5',
      { skipped: null, error: 'decrypt failed', pushed: 0, localFailure: true });
    expect(ok).toBe(false);
    // One unreadable store must not make the whole library claim Supabase is down.
    expect(breaker.isOpen()).toBe(false);
    // ...but that memory is retried on the next tick.
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '5' })).toBe(true);
  });

  test('a remote failure opens the breaker', () => {
    const { breaker, gate } = setup();
    applyWhatISaidPushOutcome({ breaker, gate }, 'm', '5', { skipped: null, error: 'timeout', pushed: 0 });
    expect(breaker.isOpen()).toBe(true);
  });

  test('a push that stopped at the page cap is not recorded as caught up', () => {
    const { breaker, gate } = setup();
    const ok = applyWhatISaidPushOutcome({ breaker, gate }, 'm', '90000',
      { skipped: null, error: null, pushed: 40_000, complete: false });
    expect(ok).toBe(true);
    expect(breaker.isOpen()).toBe(false);
    // Recording seq 90000 here would stall the rest of the backlog for an hour.
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '90000' })).toBe(true);
    applyWhatISaidPushOutcome({ breaker, gate }, 'm', '90000',
      { skipped: null, error: null, pushed: 10, complete: true });
    expect(gate.shouldPush('m', { stored: 0, localMaxSeq: '90000' })).toBe(false);
  });

  test('a skipped push proves nothing', () => {
    const { breaker, gate } = setup();
    breaker.recordFailure();
    expect(applyWhatISaidPushOutcome({ breaker, gate }, 'm', '1',
      { skipped: 'disabled', error: null, pushed: 0 })).toBe(false);
    expect(breaker.isOpen()).toBe(true);
  });
});

test('the background push classifies local failures and reports completeness', async () => {
  // The helper above is only as good as what the push feeds it.
  const source = await Bun.file(new URL('../api-server.ts', import.meta.url)).text();
  const start = source.indexOf('async function pushWhatISaidRemote(');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  expect(body).toContain('throw new WhatISaidLocalPushError(');
  expect(body).toContain('localFailure: error instanceof WhatISaidLocalPushError');
  expect(body).toContain('return { attempted: true, pushed, skipped: null, error: null, complete };');
  expect(source).toContain('applyWhatISaidPushOutcome(');
});
