// @ts-nocheck -- deployed in the Supabase Deno runtime.
// Tokens authorize only the selected latest curated backups, never local files.
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return json({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  if ([...url.searchParams.keys()].some(key => !['after', 'limit'].includes(key))) return json({ error: 'invalid_request' }, 400);
  const after = url.searchParams.get('after') ?? '';
  const rawLimit = url.searchParams.get('limit') ?? '10';
  const limit = Number(rawLimit);
  if (after.length > 512 || !/^\d{1,2}$/.test(rawLimit) || limit < 1 || limit > 25) return json({ error: 'invalid_request' }, 400);
  const host = Deno.env.get('SUPABASE_URL');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!host || !service) return json({ error: 'not_configured' }, 503);
  try {
    const response = await fetch(`${host}/rest/v1/rpc/portmgr_project_memory_feed`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token, p_after: after, p_limit: limit }),
    });
    const result = await response.json();
    if (!response.ok) {
      const message = String(result?.message ?? '');
      if (message.includes('MEMORY_FEED_UNAUTHORIZED')) return json({ error: 'unauthorized' }, 401);
      if (message.includes('MEMORY_FEED_RATE_LIMITED')) return json({ error: 'rate_limited' }, 429);
      return json({ error: 'feed_unavailable' }, 503);
    }
    return json(result);
  } catch { return json({ error: 'feed_unavailable' }, 503); }
});
