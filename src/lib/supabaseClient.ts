import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// globalThis에 캐시를 올려 HMR 재로드 시에도 인스턴스를 재사용
const g = globalThis as any;
if (!g.__sbCache) g.__sbCache = new Map<string, SupabaseClient>();
const _cache: Map<string, SupabaseClient> = g.__sbCache;

// RLS(portmgr_authenticated_all)가 켜진 뒤에는 로그인 세션의 JWT로 쿼리해야 한다.
// 예전에는 persistSession:false로 anon 역할을 강제했는데, 그 설정이 남아 있으면
// 로그인을 해도 모든 Push/Pull이 anon으로 나가 RLS에 전부 막힌다.
//
// storageKey를 고정하는 이유: 앱(Tauri) / 로컬 웹 / 배포 포털이 모두 이 클라이언트
// 하나만 쓰도록 해서 "Multiple GoTrueClient instances" 경고와 세션 분열을 막는다.
const AUTH_OPTIONS = {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
    storageKey: 'portmgr-auth',
  },
} as const;

export function getSupabaseClient(url: string, key: string): SupabaseClient {
  const cacheKey = `${url}::${key}`;
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
export function describeSupabaseError(error: unknown): string {
  const raw = (error as { message?: string } | null)?.message ?? String(error ?? '알 수 없는 오류');
  if (isAuthRequiredError(error)) {
    return `Supabase가 접근을 거부했습니다 — 설정에서 Google 로그인 세션과 서버 허용 이메일을 확인하세요. (${raw})`;
  }
  return raw;
}
