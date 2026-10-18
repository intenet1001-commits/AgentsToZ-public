import { expect, test } from 'bun:test';

test('external memory handler accepts only bounded authenticated reads and keeps service credentials upstream', async () => {
  const globals = globalThis as any;
  const originalDeno = globals.Deno;
  const originalFetch = globalThis.fetch;
  let handler: (request: Request) => Promise<Response> = async () => { throw Error('not registered'); };
  let upstream: { url: string; init: RequestInit } | null = null;
  globals.Deno = {
    env: { get: (name: string) => name === 'SUPABASE_URL' ? 'https://example.supabase.co' : 'test-service-key' },
    serve: (value: typeof handler) => { handler = value; },
  };
  globalThis.fetch = (async (url: any, init: RequestInit) => {
    upstream = { url: String(url), init };
    return Response.json({ schemaVersion: 1, items: [], hasMore: false, nextCursor: null });
  }) as typeof fetch;
  try {
    await import('../supabase/functions/project-memory-feed/index');
    expect((await handler(new Request('https://example.invalid/feed'))).status).toBe(401);
    expect(upstream).toBeNull();
    const headers = { Authorization: `Bearer ${'a'.repeat(64)}` };
    for (const query of ['limit=26', 'limit=1.5', 'memoryId=unselected', 'token=secret', `after=${'x'.repeat(513)}`]) {
      expect((await handler(new Request(`https://example.invalid/feed?${query}`, { headers }))).status).toBe(400);
    }
    expect((await handler(new Request('https://example.invalid/feed', { method: 'POST', headers }))).status).toBe(405);
    const response = await handler(new Request('https://example.invalid/feed?limit=2&after=abc', { headers }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('test-service-key');
    expect(upstream!.url).toBe('https://example.supabase.co/rest/v1/rpc/portmgr_project_memory_feed');
    expect(JSON.parse(upstream!.init.body as string)).toEqual({ p_token: 'a'.repeat(64), p_after: 'abc', p_limit: 2 });
    globalThis.fetch = (async () => { throw Error('network timeout'); }) as unknown as typeof fetch;
    expect((await handler(new Request('https://example.invalid/feed', { headers }))).status).toBe(503);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDeno === undefined) delete globals.Deno; else globals.Deno = originalDeno;
  }
});
