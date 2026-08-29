import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NativeOAuthRelay } from '../src/nativeOAuthRelay';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const frontendSource = readFileSync(new URL('../src/nativeSupabaseAuth.ts', import.meta.url), 'utf8');
const portalManagerSource = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');
const supabaseClientSource = readFileSync(new URL('../src/lib/supabaseClient.ts', import.meta.url), 'utf8');

describe('native Supabase OAuth relay', () => {
  test('accepts a code only for one registered unexpired nonce and consumes it once', () => {
    let now = 1_000;
    const relay = new NativeOAuthRelay({ ttlMs: 5_000, now: () => now });
    const requestId = 'a'.repeat(43);

    expect(relay.acceptCallback(requestId, 'foreign-code')).toBe(false);
    relay.register(requestId);
    expect(relay.consume(requestId)).toBeNull();
    expect(relay.acceptCallback(requestId, 'pkce-code')).toBe(true);
    expect(relay.acceptCallback(requestId, 'replacement')).toBe(false);
    expect(relay.consume(requestId)).toBe('pkce-code');
    expect(relay.consume(requestId)).toBeNull();

    relay.register('b'.repeat(43));
    now += 5_001;
    expect(relay.acceptCallback('b'.repeat(43), 'expired')).toBe(false);
  });

  test('rejects malformed request ids and authorization codes', () => {
    const relay = new NativeOAuthRelay();
    for (const invalid of ['', 'short', '../escape', 'x'.repeat(129)]) {
      expect(() => relay.register(invalid)).toThrow();
    }
    const requestId = 'c'.repeat(43);
    relay.register(requestId);
    expect(relay.acceptCallback(requestId, '')).toBe(false);
    expect(relay.acceptCallback(requestId, 'x'.repeat(4097))).toBe(false);
  });

  test('legacy native relay stays nonce-bound while the desktop UI no longer invokes login', () => {
    for (const route of [
      '/api/auth/native/start',
      '/api/auth/native/callback',
      '/api/auth/native/result',
    ]) {
      expect(apiSource).toContain(route);
    }
    expect(frontendSource).toContain('skipBrowserRedirect: true');
    expect(frontendSource).toContain('exchangeCodeForSession(code)');
    expect(frontendSource).toContain('export async function signInBrowserSupabase');
    expect(frontendSource).toContain("new URL('/portal.html', window.location.origin)");
    expect(frontendSource).toContain('window.open(data.url');
    expect(frontendSource).toContain("invoke('open_in_chrome'");
    expect(frontendSource).toContain("NATIVE_AUTH_BASE = 'http://127.0.0.1:3001/api/auth/native'");
    expect(frontendSource).toContain('/callback/${encodeURIComponent(requestId)}');
    expect(apiSource).toContain('const nativeOAuthCallbackPrefix = "/api/auth/native/callback/"');
    expect(apiSource).toContain('url.pathname.startsWith(nativeOAuthCallbackPrefix)');
    expect(portalManagerSource).not.toContain('signInNativeSupabase(supabase');
    expect(portalManagerSource).toContain('signInBrowserSupabase(supabase');
    expect(portalManagerSource).toContain('data-testid="settings-google-login"');
    expect(portalManagerSource).toContain('!isTauri() && !isDeployedWeb()');
    expect(portalManagerSource).toContain('authenticatedSessionEmail');
    expect(portalManagerSource).not.toContain('api/auth/native/callback/*');
    expect(supabaseClientSource).toContain("flowType: 'pkce'");
    expect(supabaseClientSource).toContain("DESKTOP_PROXY_URL = 'http://127.0.0.1:3001/api/supabase-proxy'");
    expect(supabaseClientSource).toContain('persistSession: false');
  });
});
