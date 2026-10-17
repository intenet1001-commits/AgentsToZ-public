import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isDeployedWeb, isLocalWeb, isTauri } from './env';
import { PORTAL_AUTH_STORAGE_KEY } from '../portalAuth';

// globalThis에 캐시를 올려 HMR 재로드 시에도 인스턴스를 재사용
const g = globalThis as any;
if (!g.__sbCache) g.__sbCache = new Map<string, SupabaseClient>();
const _cache: Map<string, SupabaseClient> = g.__sbCache;

// 웹 포털은 RLS(portmgr_authenticated_all)를 통과할 Google JWT를 보존한다.
// 데스크톱 앱은 사용자 로그인을 요구하지 않는다. Tauri WebView가 service_role 키를
// 직접 가지면 안 되므로 localhost sidecar의 고정 Supabase 프록시만 호출하고, sidecar가
// 서버 전용 파일의 키를 요청마다 주입한다.
//
// storageKey를 고정하는 이유: 앱(Tauri) / 로컬 웹 / 배포 포털이 모두 이 클라이언트
// 하나만 쓰도록 해서 "Multiple GoTrueClient instances" 경고와 세션 분열을 막는다.
const AUTH_OPTIONS = {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
    storageKey: PORTAL_AUTH_STORAGE_KEY,
  },
} as const;

export const DESKTOP_PROXY_URL = 'http://127.0.0.1:3001/api/supabase-proxy';
export const LOCAL_WEB_PROXY_PATH = '/api/supabase-proxy';
const LOCAL_PROXY_PUBLIC_KEY = 'agentstoz-desktop-sidecar';
const LOCAL_PROXY_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
} as const;

export type SupabaseClientRuntime = 'tauri-proxy' | 'local-web-proxy' | 'deployed-web';
export type SupabaseClientFactory = (url: string, key: string) => SupabaseClient;

/**
 * Keep the privileged localhost transport confined to a native WebView or the
 * source development UI served from loopback. A deployed portal must always
 * use its configured Supabase URL so its Google JWT and authenticated RLS are
 * enforced by Supabase directly.
 */
export function resolveSupabaseClientRuntime(
  tauri: boolean,
  deployedWeb: boolean,
): SupabaseClientRuntime {
  if (tauri) return 'tauri-proxy';
  if (!deployedWeb) return 'local-web-proxy';
  return 'deployed-web';
}

export function resolveSupabaseClientUrl(
  runtime: SupabaseClientRuntime,
  configuredUrl: string,
  localOrigin?: string,
): string {
  if (runtime === 'tauri-proxy') return DESKTOP_PROXY_URL;
  if (runtime === 'local-web-proxy') {
    if (!localOrigin) throw new Error('LOCAL_WEB_SUPABASE_PROXY_ORIGIN_REQUIRED');
    return new URL(LOCAL_WEB_PROXY_PATH, localOrigin).toString().replace(/\/$/, '');
  }
  return configuredUrl;
}

export function getSupabaseClient(url: string, key: string): SupabaseClient {
  const runtime = resolveSupabaseClientRuntime(isTauri(), isDeployedWeb());
  const proxy = runtime !== 'deployed-web';
  const clientUrl = resolveSupabaseClientUrl(
    runtime,
    url,
    typeof window === 'undefined' ? undefined : window.location.origin,
  );
  const clientKey = proxy ? LOCAL_PROXY_PUBLIC_KEY : key;
  const cacheKey = `${runtime}::${clientUrl}::${clientKey}`;
  if (!_cache.has(cacheKey)) {
    _cache.set(cacheKey, createClient(
      clientUrl,
      clientKey,
      proxy ? LOCAL_PROXY_OPTIONS : AUTH_OPTIONS,
    ));
  }
  return _cache.get(cacheKey)!;
}

/**
 * Browser portal entrypoints always need GoTrue/OAuth and the user's JWT,
 * including when portal.html or /remote/ is served from loopback. Keep this
 * explicit so only the desktop/source App chooses the privileged sidecar.
 */
export function getAuthenticatedSupabaseClient(url: string, key: string): SupabaseClient {
  const cacheKey = `authenticated-browser::${url}::${key}`;
  if (!_cache.has(cacheKey)) {
    _cache.set(cacheKey, createClient(url, key, AUTH_OPTIONS));
  }
  return _cache.get(cacheKey)!;
}

/** RLS/인증 때문에 거부된 에러인지 판정 (PostgREST 42501 / PGRST301 / 401·403). */
export function isAuthRequiredError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { code?: unknown; message?: unknown; status?: unknown; hint?: unknown };
  const code = String(e.code ?? '');
  const status = Number(e.status ?? 0);
  const msg = String(e.message ?? '');
  if (code === '42501' || code === 'PGRST301' || code === '401' || code === '403') return true;
  if (status === 401 || status === 403) return true;
  return /row[- ]level security|permission denied|not authorized|JWT|invalid claim|no api key/i.test(msg);
}

/** 사용자에게 보여줄 에러 문구. RLS 거부는 원인이 드러나게 바꿔준다. */
export function describeSupabaseError(
  error: unknown,
  context: 'runtime' | 'authenticated-portal' = 'runtime',
): string {
  const raw = (error as { message?: string } | null)?.message ?? String(error ?? '알 수 없는 오류');
  if (isAuthRequiredError(error)) {
    if (context === 'authenticated-portal') {
      return `Supabase가 포털 접근을 거부했습니다 — Google 로그인 세션과 DB 허용 회원을 확인하세요. (${raw})`;
    }
    if (isTauri() || isLocalWeb()) {
      return `로컬 Supabase 연결이 거부됐습니다 — 실행 중인 sidecar와 설정의 service_role Key 상태를 확인하세요. Google 로그인은 필요하지 않습니다. (${raw})`;
    }
    return `Supabase가 접근을 거부했습니다 — 설정에서 Google 로그인 세션과 서버 허용 이메일을 확인하세요. (${raw})`;
  }
  return raw;
}

export function describeAuthenticatedPortalSupabaseError(error: unknown): string {
  return describeSupabaseError(error, 'authenticated-portal');
}
