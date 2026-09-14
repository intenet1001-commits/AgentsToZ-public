import { describe, expect, test } from 'bun:test';
import { localWebRequestOrigin } from '../src/localWebRequestOrigin';

const headers = (values: Record<string, string>) => new Headers(values);

// 2026-09-11: supabase-js reads (GET) from the source dev UI at localhost:9000
// reached the proxy with no Origin header — browsers omit it on same-origin
// GETs — and every one was refused with DESKTOP_SUPABASE_PROXY_DENIED.
describe('local web request origin', () => {
  test('uses the Origin header whenever the browser sent one', () => {
    expect(localWebRequestOrigin(headers({ 'sec-fetch-site': 'same-origin', referer: 'http://evil.test/' }), 'http://localhost:9000'))
      .toBe('http://localhost:9000');
  });

  test('recovers the page origin of a same-origin GET from its Referer', () => {
    expect(localWebRequestOrigin(headers({ 'sec-fetch-site': 'same-origin', referer: 'http://localhost:9000/projects?tab=ports' }), null))
      .toBe('http://localhost:9000');
  });

  test('does not trust a Referer on a cross-site request', () => {
    expect(localWebRequestOrigin(headers({ 'sec-fetch-site': 'cross-site', referer: 'http://localhost:9000/' }), null)).toBeNull();
    expect(localWebRequestOrigin(headers({ 'sec-fetch-site': 'same-site', referer: 'http://localhost:9000/' }), null)).toBeNull();
  });

  test('gives a non-browser caller without fetch metadata no origin', () => {
    expect(localWebRequestOrigin(headers({ referer: 'http://localhost:9000/' }), null)).toBeNull();
    expect(localWebRequestOrigin(headers({}), null)).toBeNull();
  });

  test('rejects a missing or malformed Referer', () => {
    expect(localWebRequestOrigin(headers({ 'sec-fetch-site': 'same-origin' }), null)).toBeNull();
    expect(localWebRequestOrigin(headers({ 'sec-fetch-site': 'same-origin', referer: 'not a url' }), null)).toBeNull();
  });
});
