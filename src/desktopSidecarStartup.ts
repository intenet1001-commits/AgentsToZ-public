const HEALTH_URL = 'http://127.0.0.1:3001/api/health';
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 1_000;
const RETRY_INTERVAL_MS = 250;
const MAX_ATTEMPTS = 60;

interface StartupOptions {
  signal?: AbortSignal;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  /** A shorter deadline for callers/tests; cannot extend the startup budget. */
  timeoutMs?: number;
}

function probeHealth(fetchImpl: NonNullable<StartupOptions['fetchImpl']>, signal: AbortSignal | undefined,
  timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const request = new AbortController();
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      // Also cancels an unfinished response body, not only the header request.
      request.abort();
      resolve(ready);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return cancel();

    // The explicit deadline also bounds fetch implementations whose pending
    // promise fails to reject on abort. Their late result cannot settle twice.
    void Promise.resolve().then(async () => {
      if (settled) return false;
      const response = await fetchImpl(HEALTH_URL, {
        method: 'GET', cache: 'no-store', redirect: 'error', signal: request.signal,
      });
      if (settled || !response.ok) return false;
      const payload = await response.json();
      return payload?.ok === true && payload?.service === 'agentstoz-api';
    }).then(finish, cancel);
  });
}

function waitBetweenProbes(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

/** Wait for transport readiness before the caller's single initial Pull.
 * Public health identifies the service; it is never an authorization proof.
 * This function retries only GET /api/health, never Supabase or mutations.
 */
export async function waitForDesktopSidecarStartup({ signal, fetchImpl = fetch,
  timeoutMs = STARTUP_TIMEOUT_MS }: StartupOptions = {}): Promise<void> {
  const budget = Number.isFinite(timeoutMs) ? Math.min(STARTUP_TIMEOUT_MS, Math.max(0, timeoutMs)) : STARTUP_TIMEOUT_MS;
  const deadline = performance.now() + budget;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Desktop sidecar startup was aborted.', 'AbortError');
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const ready = await probeHealth(fetchImpl, signal, Math.min(REQUEST_TIMEOUT_MS, remaining));
    if (signal?.aborted) throw new DOMException('Desktop sidecar startup was aborted.', 'AbortError');
    if (ready && performance.now() < deadline) return;
    const nextWait = Math.min(RETRY_INTERVAL_MS, deadline - performance.now());
    if (nextWait > 0 && attempt + 1 < MAX_ATTEMPTS) await waitBetweenProbes(nextWait, signal);
    // A short final sleep can fire a fraction early; it must not permit a
    // last sub-millisecond request outside the normal retry cadence.
    if (nextWait < RETRY_INTERVAL_MS) break;
  }
  if (signal?.aborted) throw new DOMException('Desktop sidecar startup was aborted.', 'AbortError');
  throw Object.assign(new Error('DESKTOP_SIDECAR_STARTUP_TIMEOUT'), { code: 'DESKTOP_SIDECAR_STARTUP_TIMEOUT' });
}
