import { describe, expect, test } from 'bun:test';
import { waitForDesktopSidecarStartup } from '../src/desktopSidecarStartup';

const READY = { ok: true, service: 'agentstoz-api' };
const FIXED_HEALTH_URL = 'http://127.0.0.1:3001/api/health';

function localHealth(handler: (request: Request) => Response | Promise<Response>) {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return handler(request);
  } });
  const attempts: RequestInit[] = [];
  const fetchImpl = (input: string, init: RequestInit) => {
    expect(input).toBe(FIXED_HEALTH_URL);
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
    attempts.push(init);
    // The production URL is asserted, then redirected only inside this test
    // transport to an ephemeral HTTP server. Port 3001 is never contacted.
    return fetch(`http://127.0.0.1:${server.port}/api/health`, init);
  };
  return { server, requests, attempts, fetchImpl };
}

async function until(probe: () => boolean) {
  const deadline = performance.now() + 500;
  while (!probe() && performance.now() < deadline) await Bun.sleep(5);
  expect(probe()).toBe(true);
}

describe('desktop sidecar startup readiness', () => {
  test('cold startup waits for a late HTTP listener, then calls the original Pull once', async () => {
    // Reserve a test-only port before simulating the sidecar not listening yet.
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop(true);
    let sidecar: ReturnType<typeof Bun.serve> | undefined;
    let attempts = 0;
    let pulls = 0;
    const start = setTimeout(() => {
      sidecar = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json(READY) });
    }, 80);
    try {
      await waitForDesktopSidecarStartup({ timeoutMs: 1_500, fetchImpl: (input, init) => {
        expect(input).toBe(FIXED_HEALTH_URL);
        attempts += 1;
        return fetch(`http://127.0.0.1:${port}/api/health`, init);
      } });
      pulls += 1;
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(pulls).toBe(1);
      const completedAttempts = attempts;
      await Bun.sleep(300);
      expect(attempts).toBe(completedAttempts);
      expect(pulls).toBe(1);
    } finally {
      clearTimeout(start);
      sidecar?.stop(true);
    }
  });

  test('valid public health completes with a single uncached GET and no later retry', async () => {
    const fixture = localHealth(() => Response.json(READY));
    try {
      await waitForDesktopSidecarStartup({ fetchImpl: fixture.fetchImpl, timeoutMs: 500 });
      await Bun.sleep(280);
      expect(fixture.attempts).toHaveLength(1);
      expect(fixture.requests).toEqual(['/api/health']);
    } finally { fixture.server.stop(true); }
  });

  test.each([
    ['wrong service', { ok: true, service: 'other-api' }, 200],
    ['false ok', { ok: false, service: 'agentstoz-api' }, 200],
    ['truthy ok', { ok: 'true', service: 'agentstoz-api' }, 200],
    ['missing ok', { service: 'agentstoz-api' }, 200],
    ['HTTP error', READY, 503],
  ] as const)('%s cannot open the initial Pull gate', async (_name, payload, status) => {
    const fixture = localHealth(() => Response.json(payload, { status }));
    let pulls = 0;
    let failure: unknown;
    try {
      try {
        await waitForDesktopSidecarStartup({ fetchImpl: fixture.fetchImpl, timeoutMs: 40 });
        pulls += 1;
      } catch (error) { failure = error; }
      expect(failure).toMatchObject({ message: 'DESKTOP_SIDECAR_STARTUP_TIMEOUT', code: 'DESKTOP_SIDECAR_STARTUP_TIMEOUT' });
      expect(pulls).toBe(0);
      expect(fixture.attempts).toHaveLength(1);
    } finally { fixture.server.stop(true); }
  });

  test('malformed JSON and redirects remain failures without following a second route', async () => {
    for (const response of [new Response('{'), new Response(null, { status: 302, headers: { location: '/other-service' } })]) {
      const fixture = localHealth(() => response);
      try {
        await expect(waitForDesktopSidecarStartup({ fetchImpl: fixture.fetchImpl, timeoutMs: 40 }))
          .rejects.toThrow('DESKTOP_SIDECAR_STARTUP_TIMEOUT');
        expect(fixture.requests).toEqual(['/api/health']);
      } finally { fixture.server.stop(true); }
    }
  });

  test('permanent failure stops at one overall deadline and leaves no retry timer', async () => {
    const fixture = localHealth(() => Response.json({ ok: false }, { status: 503 }));
    const started = performance.now();
    try {
      await expect(waitForDesktopSidecarStartup({ fetchImpl: fixture.fetchImpl, timeoutMs: 600 }))
        .rejects.toThrow('DESKTOP_SIDECAR_STARTUP_TIMEOUT');
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(fixture.attempts.length).toBeGreaterThanOrEqual(2);
      expect(fixture.attempts.length).toBeLessThanOrEqual(3);
      const completedAttempts = fixture.attempts.length;
      await Bun.sleep(300);
      expect(fixture.attempts).toHaveLength(completedAttempts);
      expect(fixture.attempts.every(attempt => attempt.signal?.aborted)).toBe(true);
    } finally { fixture.server.stop(true); }
  });

  test('a stalled header request is aborted within one second before the next health probe', async () => {
    let release: ((response: Response) => void) | undefined;
    let requestCount = 0;
    const fixture = localHealth(() => ++requestCount === 1
      ? new Promise(resolve => { release = resolve; }) : Response.json(READY));
    let firstAbortedAt = 0;
    const started = performance.now();
    try {
      await waitForDesktopSidecarStartup({ timeoutMs: 2_000, fetchImpl: (input, init) => {
        if (fixture.attempts.length === 0) init.signal?.addEventListener('abort', () => { firstAbortedAt = performance.now(); }, { once: true });
        return fixture.fetchImpl(input, init);
      } });
      expect(fixture.attempts).toHaveLength(2);
      expect(firstAbortedAt - started).toBeGreaterThanOrEqual(900);
      expect(firstAbortedAt - started).toBeLessThan(1_300);
      expect(fixture.attempts[0]?.signal?.aborted).toBe(true);
    } finally {
      release?.(Response.json(READY));
      fixture.server.stop(true);
    }
  });

  test('abort during a real pending fetch cancels transport and prevents the caller Pull', async () => {
    let release: ((response: Response) => void) | undefined;
    const fixture = localHealth(() => new Promise(resolve => { release = resolve; }));
    const abort = new AbortController();
    let pulls = 0;
    let transportRejected = false;
    const result = (async () => {
      await waitForDesktopSidecarStartup({ signal: abort.signal, fetchImpl: async (input, init) => {
        try { return await fixture.fetchImpl(input, init); }
        catch (error) { transportRejected = true; throw error; }
      } });
      pulls += 1;
    })();
    try {
      await until(() => fixture.requests.length === 1);
      abort.abort();
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      await until(() => transportRejected);
      await Bun.sleep(280);
      expect(pulls).toBe(0);
      expect(fixture.attempts).toHaveLength(1);
      expect(fixture.attempts[0]?.signal?.aborted).toBe(true);
    } finally {
      abort.abort();
      release?.(Response.json(READY));
      fixture.server.stop(true);
    }
  });

  test('abort during the retry delay removes the pending retry; pre-abort never fetches', async () => {
    const fixture = localHealth(() => Response.json({ ok: false }));
    const abort = new AbortController();
    try {
      const waiting = waitForDesktopSidecarStartup({ signal: abort.signal, fetchImpl: fixture.fetchImpl });
      await until(() => fixture.attempts[0]?.signal?.aborted === true);
      abort.abort();
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      await Bun.sleep(280);
      expect(fixture.attempts).toHaveLength(1);
      await expect(waitForDesktopSidecarStartup({ signal: abort.signal, fetchImpl: fixture.fetchImpl }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(fixture.attempts).toHaveLength(1);
    } finally { abort.abort(); fixture.server.stop(true); }
  });

  test.each(['deadline', 'external abort'] as const)('%s cancels an actual response body that never finishes', async mode => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fixture = localHealth(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode('{"ok":'));
    } }), { headers: { 'content-type': 'application/json' } }));
    let bodyStarted = false;
    let bodyRejected = false;
    let pulls = 0;
    let failure: unknown;
    const abort = new AbortController();
    const started = performance.now();
    try {
      try {
        await waitForDesktopSidecarStartup({ signal: abort.signal, timeoutMs: 120, fetchImpl: async (input, init) => {
          const response = await fixture.fetchImpl(input, init);
          const readJson = response.json.bind(response);
          response.json = async () => {
            bodyStarted = true;
            const reading = readJson();
            if (mode === 'external abort') queueMicrotask(() => abort.abort());
            try { return await reading; }
            catch (error) { bodyRejected = true; throw error; }
          };
          return response;
        } });
        pulls += 1;
      } catch (error) { failure = error; }
      expect(failure).toMatchObject(mode === 'deadline'
        ? { code: 'DESKTOP_SIDECAR_STARTUP_TIMEOUT' } : { name: 'AbortError' });
      expect(performance.now() - started).toBeLessThan(600);
      expect(bodyStarted).toBe(true);
      await until(() => bodyRejected);
      expect(fixture.attempts[0]?.signal?.aborted).toBe(true);
      expect(pulls).toBe(0);
      await Bun.sleep(280);
      expect(fixture.attempts).toHaveLength(1);
    } finally {
      abort.abort();
      try { stream?.close(); } catch { /* Fetch abort may already cancel it. */ }
      fixture.server.stop(true);
    }
  });
});
