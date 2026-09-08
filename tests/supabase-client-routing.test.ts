import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DESKTOP_PROXY_URL,
  describeAuthenticatedPortalSupabaseError,
  resolveSupabaseClientRuntime,
  resolveSupabaseClientUrl,
} from '../src/lib/supabaseClient';
import { isLocalWebHostname } from '../src/lib/env';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const portalSource = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');
const remotePortalSource = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
const portalManagerSource = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');
const memoryPortalSource = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');

describe('Supabase client transport routing', () => {
  test('uses a local service proxy only for Tauri and loopback source development', () => {
    expect(resolveSupabaseClientRuntime(true, false)).toBe('tauri-proxy');
    expect(resolveSupabaseClientRuntime(false, false)).toBe('local-web-proxy');
    expect(resolveSupabaseClientRuntime(false, true)).toBe('deployed-web');

    expect(resolveSupabaseClientUrl('tauri-proxy', 'https://project.supabase.co')).toBe(DESKTOP_PROXY_URL);
    expect(resolveSupabaseClientUrl(
      'local-web-proxy',
      'https://project.supabase.co',
      'http://127.0.0.1:9100',
    )).toBe('http://127.0.0.1:9100/api/supabase-proxy');
    expect(isLocalWebHostname('127.0.0.1')).toBe(true);
    expect(isLocalWebHostname('[::1]')).toBe(true);
    expect(isLocalWebHostname('::1')).toBe(true);
    expect(isLocalWebHostname('portal.example')).toBe(false);
  });

  test('never substitutes the privileged proxy for a deployed portal', () => {
    const configured = 'https://project.supabase.co';
    expect(resolveSupabaseClientUrl('deployed-web', configured, 'https://portal.example')).toBe(configured);
    expect(() => resolveSupabaseClientUrl('local-web-proxy', configured)).toThrow(
      'LOCAL_WEB_SUPABASE_PROXY_ORIGIN_REQUIRED',
    );
  });

  test('portal shells explicitly keep OAuth and all descendant DB calls on the direct JWT client', () => {
    for (const source of [portalSource, remotePortalSource]) {
      expect(source).toContain('getAuthenticatedSupabaseClient');
      expect(source).not.toContain("import { getSupabaseClient }");
    }
    expect(portalSource).toContain('supabaseClientFactory={getAuthenticatedSupabaseClient}');
    expect(portalSource).toContain('requiresUserSession={true}');
    expect(portalManagerSource).toContain('supabaseClientFactory = getSupabaseClient');
    expect(portalManagerSource).toContain('if (!requiresUserSession)');
    expect(memoryPortalSource).toContain('supabaseClientFactory={supabaseClientFactory}');
    expect(memoryPortalSource).toContain('if (requiresUserSession)');
    expect(memoryPortalSource).not.toContain('if (!isTauri()) {\n        const { data: sessionData } = await sb().auth.getSession()');
    expect(portalSource).toContain('describeAuthenticatedPortalSupabaseError');
    const denial = describeAuthenticatedPortalSupabaseError({ code: '42501', message: 'permission denied' });
    expect(denial).toContain('Google 로그인 세션과 DB 허용 회원');
    expect(denial).not.toContain('service_role');
  });

  test('server admits the exact source-dev UI only when the API is not a bundled sidecar', () => {
    expect(apiSource).toContain('function isLocalSupabaseProxyOrigin(origin: string | null)');
    expect(apiSource).toContain('if (IS_BUNDLED_API_SIDECAR || !origin) return false;');
    expect(apiSource).toContain('origin === `http://127.0.0.1:${LOCAL_WEB_UI_PORT}`');
    expect(apiSource).toContain('if (!isLocalSupabaseProxyOrigin(requestOrigin))');
  });
});
