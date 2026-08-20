// @ts-nocheck -- Supabase Edge Functions run in Deno, outside the app's Bun tsconfig.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});

const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const normalizeAnchor = (raw: unknown) => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const region = source.region && typeof source.region === 'object' && !Array.isArray(source.region)
    ? source.region as Record<string, unknown>
    : null;
  const number = (value: unknown) => Number.isFinite(Number(value))
    ? Math.max(0, Math.min(100_000, Math.round(Number(value))))
    : 0;
  return {
    ...(text(source.helpKey, 120) ? { helpKey: text(source.helpKey, 120) } : {}),
    ...(text(source.testId, 120) ? { testId: text(source.testId, 120) } : {}),
    tag: text(source.tag, 40).toLowerCase(),
    text: text(source.text, 160),
    path: Array.isArray(source.path) ? source.path.map(v => text(v, 120)).filter(Boolean).slice(0, 4) : [],
    ...(region ? { region: { width: number(region.width), height: number(region.height) } } : {}),
    ...(Array.isArray(source.contains)
      ? { contains: source.contains.map(v => text(v, 120)).filter(Boolean).slice(0, 12) }
      : {}),
  };
};

const sha256 = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const declaredBytes = Number(req.headers.get('content-length') ?? 0);
  if (declaredBytes > 16_384) return json({ error: 'payload_too_large' }, 413);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const installationId = text(body.installationId, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId)) {
    return json({ error: 'invalid_installation' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'receiver_not_configured' }, 503);
  const deviceHash = await sha256(installationId);
  const serviceHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  if (body.action === 'check') {
    const check = await fetch(`${supabaseUrl}/rest/v1/rpc/portmgr_check_voc_device`, {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify({ p_device_hash: deviceHash }),
    });
    const result = await check.json().catch(() => null);
    if (!check.ok) return json({ error: 'access_check_failed' }, 503);
    const row = Array.isArray(result) ? result[0] : result;
    return json({
      blocked: row?.blocked === true,
      scope: row?.block_scope === 'app' ? 'app' : row?.block_scope === 'voc' ? 'voc' : null,
      expiresAt: typeof row?.expires_at === 'string' ? row.expires_at : null,
    });
  }

  const record = body.record && typeof body.record === 'object' && !Array.isArray(body.record)
    ? body.record as Record<string, unknown>
    : {};
  const comment = text(record.comment, 4_001);
  if (!comment || comment.length > 4_000) return json({ error: 'invalid_comment' }, 400);

  const id = text(record.id, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return json({ error: 'invalid_id' }, 400);
  }

  const rpc = await fetch(`${supabaseUrl}/rest/v1/rpc/portmgr_submit_voc`, {
    method: 'POST',
    headers: serviceHeaders,
    body: JSON.stringify({
      p_id: id,
      p_device_hash: deviceHash,
      p_app_version: text(record.appVersion, 100),
      p_tab: text(record.tab, 50),
      p_anchor: normalizeAnchor(record.anchor),
      p_comment: comment,
    }),
  });

  const result = await rpc.json().catch(() => null);
  if (!rpc.ok) return json({ error: 'storage_failed' }, 503);
  const row = Array.isArray(result) ? result[0] : result;
  if (!row?.accepted) {
    const rawReason = String(row?.reason ?? 'rate_limited');
    const reason = ['disabled', 'voc_blocked', 'app_blocked'].includes(rawReason) ? rawReason : 'rate_limited';
    return json({
      accepted: false,
      reason,
      dailyLimit: Number(row?.daily_limit ?? 10),
      remaining: 0,
    }, reason === 'rate_limited' ? 429 : reason === 'disabled' ? 503 : 403);
  }

  return json({
    accepted: true,
    id,
    dailyLimit: Number(row.daily_limit ?? 10),
    remaining: Number(row.remaining ?? 0),
  }, 201);
});
