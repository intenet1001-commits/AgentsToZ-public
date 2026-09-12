import { describe, expect, test } from 'bun:test';
import {
  PortalOAuthStartError,
  PORTAL_AUTH_STORAGE_KEY,
  clearStoredPortalAuth,
  canContinuePortalGoogleOAuth,
  createPortalGoogleOAuthUrl,
  portalOAuthStartErrorMessage,
  preflightPortalGoogleOAuth,
  withPortalAuthTimeout,
} from '../src/portalAuth';
import { verifyPortalMembership } from '../src/portalMembership';

describe('hosted portal auth recovery', () => {
  test('turns an unanswered membership request into a bounded fail-closed result', async () => {
    const result = await verifyPortalMembership({
      rpc: () => new Promise(() => {}),
    }, 5);

    expect(result).toEqual({
      state: 'error',
      message: 'PORTAL_AUTH_MEMBERSHIP_TIMEOUT',
    });
  });

  test('returns a completed auth request without waiting for its timeout', async () => {
    expect(await withPortalAuthTimeout(Promise.resolve('ready'), 'SESSION', 50)).toBe('ready');
  });

  test('proves the public Auth endpoint and Google provider before navigation', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    await preflightPortalGoogleOAuth({
      supabaseUrl: 'https://project.supabase.co/',
      supabaseAnonKey: 'public-anon-key',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify({ external: { google: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const request = requests[0];
    expect(request?.url).toBe('https://project.supabase.co/auth/v1/settings');
    expect(new Headers(request?.init?.headers).get('apikey')).toBe('public-anon-key');
    expect(request?.init?.cache).toBe('no-store');
  });

  test('keeps the portal recoverable when Auth stalls or Google is disabled', async () => {
    const stalled = preflightPortalGoogleOAuth({
      supabaseUrl: 'https://project.supabase.co',
      supabaseAnonKey: 'public-anon-key',
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 5,
    });
    await expect(stalled).rejects.toMatchObject({ failure: 'PREFLIGHT_TIMEOUT' });

    const disabled = preflightPortalGoogleOAuth({
      supabaseUrl: 'https://project.supabase.co',
      supabaseAnonKey: 'public-anon-key',
      fetchImpl: async () => new Response(JSON.stringify({ external: { google: false } }), { status: 200 }),
    });
    await expect(disabled).rejects.toMatchObject({ failure: 'GOOGLE_DISABLED' });
  });

  test('prepares PKCE without redirecting and admits only the exact Supabase authorize URL', async () => {
    let credentials: unknown = null;
    const redirectTo = 'https://portal.example/';
    const authorize = new URL('https://project.supabase.co/auth/v1/authorize');
    authorize.searchParams.set('provider', 'google');
    authorize.searchParams.set('redirect_to', redirectTo);
    authorize.searchParams.set('code_challenge', 'a'.repeat(43));
    authorize.searchParams.set('code_challenge_method', 's256');
    authorize.searchParams.set('prompt', 'select_account');
    const client = {
      auth: {
        signInWithOAuth: async (value: unknown) => {
          credentials = value;
          return { data: { url: authorize.toString() }, error: null };
        },
      },
    };

    expect(await createPortalGoogleOAuthUrl({
      client,
      supabaseUrl: 'https://project.supabase.co',
      redirectTo,
    })).toBe(authorize.toString());
    expect(credentials).toEqual({
      provider: 'google',
      options: {
        redirectTo,
        queryParams: { prompt: 'select_account' },
        skipBrowserRedirect: true,
      },
    });

    authorize.hostname = 'attacker.example';
    await expect(createPortalGoogleOAuthUrl({
      client,
      supabaseUrl: 'https://project.supabase.co',
      redirectTo,
    })).rejects.toMatchObject({ failure: 'AUTHORIZE_URL_INVALID' });
  });

  test('bounds the readiness body as well as headers and aborts a stalled read', async () => {
    let signal: AbortSignal | null | undefined;
    const result = preflightPortalGoogleOAuth({
      supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'public-anon-key', timeoutMs: 5,
      fetchImpl: async (_url, init) => {
        signal = init?.signal;
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      },
    });
    await expect(result).rejects.toMatchObject({ failure: 'PREFLIGHT_TIMEOUT' });
    expect(signal?.aborted).toBe(true);
  });

  test('offers explicit direct navigation only for inconclusive connection checks', () => {
    expect(canContinuePortalGoogleOAuth(new PortalOAuthStartError('PREFLIGHT_TIMEOUT'))).toBe(true);
    expect(canContinuePortalGoogleOAuth(new PortalOAuthStartError('PREFLIGHT_NETWORK'))).toBe(true);
    for (const failure of ['GOOGLE_DISABLED', 'CONFIG_INVALID', 'PREFLIGHT_REJECTED', 'AUTHORIZE_URL_INVALID'] as const) {
      expect(canContinuePortalGoogleOAuth(new PortalOAuthStartError(failure))).toBe(false);
    }
    expect(canContinuePortalGoogleOAuth(new Error('failed'))).toBe(false);
  });

  test('turns readiness failures into an actionable Korean message', () => {
    expect(portalOAuthStartErrorMessage(new PortalOAuthStartError('PREFLIGHT_TIMEOUT')))
      .toContain('현재 화면은 유지했습니다');
    expect(portalOAuthStartErrorMessage(new PortalOAuthStartError('GOOGLE_DISABLED')))
      .toContain('Authentication → Providers → Google');
  });

  test('clears only this portal auth session and its PKCE helper keys', () => {
    const values = new Map<string, string>([
      [PORTAL_AUTH_STORAGE_KEY, 'session'],
      [`${PORTAL_AUTH_STORAGE_KEY}-user`, 'user'],
      [`${PORTAL_AUTH_STORAGE_KEY}-flow-login-code-verifier`, 'pkce'],
      ['portalData_v1', 'portal settings'],
      ['another-app-auth', 'unrelated'],
    ]);
    const storage = {
      get length() { return values.size; },
      key(index: number) { return [...values.keys()][index] ?? null; },
      removeItem(key: string) { values.delete(key); },
    };

    expect(clearStoredPortalAuth(storage)).toBe(3);
    expect([...values.keys()]).toEqual(['portalData_v1', 'another-app-auth']);
  });
});
