/**
 * The page origin of a request that reached the local API, for the gate (the
 * Supabase proxy) that must tell the source dev UI apart from anything else on
 * loopback.
 *
 * Browsers omit `Origin` on same-origin GETs, so supabase-js reads from the dev
 * UI at localhost:9000 arrived origin-less and were all refused. For those the
 * browser still sends `Sec-Fetch-Site` and `Referer`, which no page can set or
 * forge. Anything else — a cross-site page or a non-browser caller — gets no
 * origin and stays refused.
 */
export function localWebRequestOrigin(headers: Headers, origin: string | null): string | null {
  if (origin) return origin;
  if (headers.get('sec-fetch-site') !== 'same-origin') return null;
  const referer = headers.get('referer');
  if (!referer) return null;
  try {
    const parsed = new URL(referer);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}
