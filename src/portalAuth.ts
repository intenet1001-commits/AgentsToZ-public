export const PORTAL_AUTH_STORAGE_KEY = 'portmgr-auth';
export const PORTAL_AUTH_REQUEST_TIMEOUT_MS = 10_000;
export const PORTAL_AUTH_PREFLIGHT_TIMEOUT_MS = 8_000;

export type PortalAuthOperation = 'SESSION' | 'MEMBERSHIP' | 'OAUTH';

export class PortalAuthRequestTimeoutError extends Error {
  readonly code: string;

  constructor(readonly operation: PortalAuthOperation) {
    const code = `PORTAL_AUTH_${operation}_TIMEOUT`;
    super(code);
    this.name = 'PortalAuthRequestTimeoutError';
    this.code = code;
  }
}

export type PortalOAuthStartFailure =
  | 'CONFIG_INVALID'
  | 'PREFLIGHT_TIMEOUT'
  | 'PREFLIGHT_NETWORK'
  | 'PREFLIGHT_REJECTED'
  | 'GOOGLE_DISABLED'
  | 'AUTHORIZE_URL_INVALID';

export class PortalOAuthStartError extends Error {
  constructor(
    readonly failure: PortalOAuthStartFailure,
    readonly status?: number,
  ) {
    super(`PORTAL_AUTH_${failure}${status ? `_${status}` : ''}`);
    this.name = 'PortalOAuthStartError';
  }
}

type PortalOAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PortalOAuthClient = {
  auth: {
    signInWithOAuth: (credentials: {
      provider: 'google';
      options: {
        redirectTo: string;
        queryParams: { prompt: 'select_account' };
        skipBrowserRedirect: true;
      };
    }) => PromiseLike<{
      data: { url?: string | null } | null;
      error: { message?: string } | null;
    }>;
  };
};

function normalizedSupabaseOrigin(supabaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    throw new PortalOAuthStartError('CONFIG_INVALID');
  }
  const localHttp = parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if ((!localHttp && parsed.protocol !== 'https:')
    || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash) {
    throw new PortalOAuthStartError('CONFIG_INVALID');
  }
  return parsed.origin;
}

/**
 * Keep the user on the portal when the Auth backend is unavailable. Supabase's
 * OAuth helper normally performs a full-page navigation immediately, which
 * turns a stalled `/authorize` request into a blank page with no retry path.
 * `/auth/v1/settings` is the public Auth readiness/config endpoint and needs
 * only the publishable/anon key already present in the browser bundle.
 */
export async function preflightPortalGoogleOAuth(options: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  fetchImpl?: PortalOAuthFetch;
  timeoutMs?: number;
}): Promise<void> {
  const origin = normalizedSupabaseOrigin(options.supabaseUrl);
  if (!options.supabaseAnonKey.trim()) throw new PortalOAuthStartError('CONFIG_INVALID');
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const response = await fetchImpl(new URL('/auth/v1/settings', origin), {
          method: 'GET',
          headers: {
            accept: 'application/json',
            apikey: options.supabaseAnonKey,
          },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new PortalOAuthStartError('PREFLIGHT_REJECTED', response.status);
        let settings: unknown;
        try {
          settings = await response.json();
        } catch {
          throw new PortalOAuthStartError('PREFLIGHT_REJECTED', response.status);
        }
        const googleEnabled = !!settings
          && typeof settings === 'object'
          && !!(settings as { external?: unknown }).external
          && typeof (settings as { external: unknown }).external === 'object'
          && (settings as { external: { google?: unknown } }).external.google === true;
        if (!googleEnabled) throw new PortalOAuthStartError('GOOGLE_DISABLED');
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new PortalOAuthStartError('PREFLIGHT_TIMEOUT'));
          controller.abort();
        }, Math.max(0, options.timeoutMs ?? PORTAL_AUTH_PREFLIGHT_TIMEOUT_MS));
      }),
    ]);
  } catch (error) {
    if (error instanceof PortalOAuthStartError) throw error;
    throw new PortalOAuthStartError('PREFLIGHT_NETWORK');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** A user may retry navigation when only the optional readiness request failed.
 * This never skips PKCE, Google authentication, or the DB membership check. */
export function canContinuePortalGoogleOAuth(error: unknown): boolean {
  return error instanceof PortalOAuthStartError
    && (error.failure === 'PREFLIGHT_TIMEOUT' || error.failure === 'PREFLIGHT_NETWORK');
}

/** Ask the SDK to prepare PKCE without navigating, then validate its output. */
export async function createPortalGoogleOAuthUrl(options: {
  client: PortalOAuthClient;
  supabaseUrl: string;
  redirectTo: string;
  nativeState?: string;
}): Promise<string> {
  const origin = normalizedSupabaseOrigin(options.supabaseUrl);
  let redirect: URL;
  try {
    redirect = new URL(options.redirectTo);
  } catch {
    throw new PortalOAuthStartError('CONFIG_INVALID');
  }
  const nativeCallback = !!options.nativeState && /^[A-Za-z0-9_-]{43}$/.test(options.nativeState)
    && redirect.toString() === `agentstoz-mobile://auth/callback?state=${options.nativeState}`;
  if (!nativeCallback && redirect.protocol !== 'https:'
    && !(redirect.protocol === 'http:'
      && (redirect.hostname === '127.0.0.1' || redirect.hostname === 'localhost'))) {
    throw new PortalOAuthStartError('CONFIG_INVALID');
  }

  const result = await withPortalAuthTimeout(options.client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: redirect.toString(),
      queryParams: { prompt: 'select_account' },
      skipBrowserRedirect: true,
    },
  }), 'OAUTH');
  if (result.error) throw result.error;

  let authorize: URL;
  try {
    authorize = new URL(result.data?.url ?? '');
  } catch {
    throw new PortalOAuthStartError('AUTHORIZE_URL_INVALID');
  }
  const challenge = authorize.searchParams.get('code_challenge') ?? '';
  if (authorize.origin !== origin
    || authorize.pathname !== '/auth/v1/authorize'
    || authorize.username || authorize.password || authorize.hash
    || authorize.searchParams.get('provider') !== 'google'
    || authorize.searchParams.get('redirect_to') !== redirect.toString()
    || authorize.searchParams.get('prompt') !== 'select_account'
    || authorize.searchParams.get('code_challenge_method')?.toLowerCase() !== 's256'
    || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)
    || authorize.searchParams.has('skip_http_redirect')) {
    throw new PortalOAuthStartError('AUTHORIZE_URL_INVALID');
  }
  return authorize.toString();
}

export function portalOAuthStartErrorMessage(error: unknown): string {
  if (error instanceof PortalOAuthStartError) {
    switch (error.failure) {
      case 'PREFLIGHT_TIMEOUT':
        return '로그인 연결 확인이 지연되어 현재 화면은 유지했습니다. 다시 시도하거나 Google 로그인 페이지로 바로 이동할 수 있습니다.';
      case 'PREFLIGHT_NETWORK':
        return '로그인 연결을 확인하지 못했습니다. 네트워크를 확인하고 다시 시도하거나 Google 로그인 페이지로 바로 이동해 주세요.';
      case 'PREFLIGHT_REJECTED':
        return `Supabase 로그인 준비 확인이 거부됐습니다${error.status ? ` (HTTP ${error.status})` : ''}. 배포본의 Supabase URL·anon key를 확인해 주세요.`;
      case 'GOOGLE_DISABLED':
        return '이 Supabase 프로젝트에서 Google 로그인이 꺼져 있습니다. Authentication → Providers → Google 설정을 확인해 주세요.';
      case 'CONFIG_INVALID':
        return '배포본의 Supabase URL 또는 로그인 콜백 주소가 올바르지 않습니다.';
      case 'AUTHORIZE_URL_INVALID':
        return 'Supabase가 안전하게 검증할 수 없는 로그인 주소를 만들었습니다. 페이지 이동을 중단했습니다.';
    }
  }
  return `Google 로그인을 시작하지 못했습니다. 다시 시도해 주세요. (${portalAuthErrorMessage(error)})`;
}

/**
 * Browser auth can wait forever while an expired mobile session is refreshed.
 * Keep the security check fail-closed, but always return control to the UI so
 * the user can retry or clear only this browser's stored login.
 */
export async function withPortalAuthTimeout<T>(
  request: PromiseLike<T>,
  operation: PortalAuthOperation,
  timeoutMs = PORTAL_AUTH_REQUEST_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(request),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new PortalAuthRequestTimeoutError(operation)),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type PortalAuthStorage = Pick<Storage, 'key' | 'length' | 'removeItem'>;

/** Remove the Supabase session and PKCE helpers without touching portal data. */
export function clearStoredPortalAuth(storage: PortalAuthStorage): number {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === PORTAL_AUTH_STORAGE_KEY || key?.startsWith(`${PORTAL_AUTH_STORAGE_KEY}-`)) {
      keys.push(key);
    }
  }

  let removed = 0;
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      // A later key may still be removable (notably in constrained Safari storage).
    }
  }
  return removed;
}

export function portalAuthErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; code?: unknown };
    const message = typeof value.message === 'string' ? value.message.trim() : '';
    const code = typeof value.code === 'string' ? value.code.trim() : '';
    if (message && code && message !== code) return `${message} (${code})`;
    if (message || code) return message || code;
  }
  return String(error ?? '알 수 없는 오류');
}
