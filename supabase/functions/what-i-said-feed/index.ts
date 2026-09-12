// @ts-nocheck -- Supabase Edge Functions run in Deno, outside the app's Bun tsconfig.
//
// 「내가 한 말」 원격 피드. 외부 앱(예: 다른 단말의 영어공부 앱)이 키 하나로
// 적재된 프롬프트를 읽는 유일한 경로다.
//
// 규약은 submit-voc 와 같다: service-role 키는 클라이언트에 절대 나가지 않고,
// 이 함수가 service-only RPC 만 부른다. 테이블을 직접 읽지 않는 이유는, 함수가
// 유출되더라도 토큰 목록을 훑을 수 없게 하기 위해서다.
//
// 범위는 기본이 "올라간 전부"다 — 적재가 "모든 장기기억 − 제외"이므로 읽기도 같은
// 모양이어야 맞물린다. 호출자는 어떤 memory_id 를 읽을지 지정하지 않고, 좁히려면
// 키에 allowed_memory_ids 를 걸어 발급한다. 제외한 장기기억은 걸러지는 것이 아니라
// 애초에 올라가지 않아 없는 것이다.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});

const ACCESS_KEY = /^[0-9a-f]{64}$/;

/** Authorization: Bearer <64 hex>. 로컬 피드의 challenge-HMAC 은 평문 loopback 을
 *  보완하려던 장치라, TLS 위에서는 bearer 로 충분하다. 키는 256비트 난수다. */
const bearerToken = (req: Request): string | null => {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(header.trim());
  return match ? match[1].toLowerCase() : null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'not_configured' }, 503);

  const token = bearerToken(req);
  if (!token || !ACCESS_KEY.test(token)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'WWW-Authenticate': 'Bearer realm="AgentsToZ What I said"',
      },
    });
  }

  const url = new URL(req.url);
  const afterText = url.searchParams.get('after') ?? '0';
  if (!/^\d{1,19}$/.test(afterText)) return json({ error: 'invalid_cursor' }, 400);
  try {
    if (BigInt(afterText) > 9223372036854775807n) return json({ error: 'invalid_cursor' }, 400);
  } catch {
    return json({ error: 'invalid_cursor' }, 400);
  }
  const limitText = url.searchParams.get('limit') ?? '100';
  if (!/^\d{1,3}$/.test(limitText)) return json({ error: 'invalid_limit' }, 400);
  const limit = Number(limitText);
  if (limit < 1 || limit > 250) return json({ error: 'invalid_limit' }, 400);

  const rpc = await fetch(`${supabaseUrl}/rest/v1/rpc/portmgr_what_i_said_feed`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    // Keep bigint cursor text all the way through JSON/PostgREST. Converting it
    // to Number here silently rounds valid cursors above 2^53.
    body: JSON.stringify({ p_token: token, p_after: afterText, p_limit: limit }),
  });
  const result = await rpc.json().catch(() => null);
  if (!rpc.ok) {
    // 없는 키·회수된 키·만료를 구분해 주지 않는다. 구분해 주면 키를 추측하는 쪽에
    // 유효한 접두사를 알려 주는 셈이다.
    const message = String(result?.message ?? '');
    if (message.includes('WHAT_I_SAID_FEED_UNAUTHORIZED')) return json({ error: 'unauthorized' }, 401);
    if (message.includes('WHAT_I_SAID_FEED_RATE_LIMITED')) return json({ error: 'rate_limited' }, 429);
    return json({ error: 'feed_unavailable' }, 503);
  }

  const rows = Array.isArray(result) ? result : [];
  const items = rows.map((row: Record<string, unknown>) => ({
    cursor: String(row.feed_seq),
    id: String(row.id),
    // 여러 장기기억이 한 피드에 섞이므로 소비하는 쪽이 프로젝트별로 묶을 수 있어야 한다.
    memoryId: String(row.memory_id),
    projectName: row.project_name ?? null,
    recordedAt: row.recorded_at,
    retentionUntil: row.retention_until ?? null,
    agent: row.agent,
    promptOrigin: row.prompt_origin === 'human' || row.prompt_origin === 'agentstoz'
      ? row.prompt_origin
      : 'unknown',
    deviceName: row.device_name ?? null,
    // withheld 행은 본문이 없다. 행을 지우지 않는 이유는, 지우면 소비하는 쪽에서
    // "그날 말한 적이 없다"로 읽혀 개수가 거짓이 되기 때문이다.
    text: row.body ?? null,
    projectionHash: row.projection_hash ?? null,
    redaction: {
      state: row.redaction_state,
      reasons: Array.isArray(row.redaction_reasons) ? row.redaction_reasons : [],
      truncated: row.truncated === true,
    },
  }));

  // The database assigns feed_seq under a transaction-scoped serialization
  // lock, so next_cursor is commit ordered and remains exact decimal text.
  const nextCursor = rows.length ? String(rows[0].next_cursor ?? afterText) : afterText;

  return json({
    schemaVersion: 3,
    items,
    nextCursor,
    hasMore: items.length === limit,
    dailyRemaining: rows.length ? Number(rows[0].daily_remaining ?? 0) : null,
  });
});
