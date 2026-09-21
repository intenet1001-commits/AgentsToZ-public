import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing end marker: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

// 2026-09-11: the source dev UI on localhost showed "자동 업로드 중단 · Supabase 인증과
// 접근 권한을 확인해 주세요" because every origin-less GET was refused by the proxy.
describe('local web Supabase wiring', () => {
  test('the proxy judges an origin-less same-origin GET by the browser fetch metadata', () => {
    const gate = section(api, 'url.pathname.startsWith(`${DESKTOP_SUPABASE_PROXY_PREFIX}/`)', 'SUPABASE_PROXY_METHODS.has(');
    expect(gate).toContain('isLocalSupabaseProxyOrigin(localWebRequestOrigin(req.headers, requestOrigin))');
  });

  test('the bundled sidecar still refuses every loopback web page', () => {
    expect(api).toContain('if (IS_BUNDLED_API_SIDECAR || !origin) return false;');
  });
});
