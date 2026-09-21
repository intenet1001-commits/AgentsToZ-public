/**
 * Supabase CLI로 service_role 키를 직접 가져오기 위한 순수 헬퍼.
 *
 * v9 마이그레이션이 장기기억 테이블의 쓰기를 service_role 하나로 좁힌 뒤, 이 키가 없으면
 * 장기기억 동기화가 통째로 401이 된다. 대시보드에서 손으로 복사하게 하는 대신, 이미
 * 로그인·링크돼 있는 CLI에게 물어본다 — 키가 브라우저를 거치지 않고 로컬 서버 안에서만
 * 오간다는 점에서 붙여넣기보다 안전하기도 하다.
 */

export interface SupabaseCliApiKey {
  name?: unknown;
  api_key?: unknown;
  apiKey?: unknown;
}

/** `https://<ref>.supabase.co` → `<ref>`. 형식이 다르면 null. */
export function supabaseProjectRefFromUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return null;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]{16,})\.supabase\.(co|in|red)$/);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/**
 * CLI가 돌려주는 키 목록에서 서버가 쓸 비밀 키를 고른다.
 *
 * 목록에는 anon·publishable 처럼 **절대 쓰면 안 되는** 키가 함께 들어 있다. 이름이
 * `service_role`인 레거시 JWT를 우선하고, 없으면 새 형식의 `sb_secret_`을 받는다.
 * 그 둘 중 어느 것도 확실히 아니면 아무것도 고르지 않는다 — 잘못 고르면 401이 반복되고
 * 사용자는 키를 넣었다고 믿는다.
 */
export function selectServiceRoleKey(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  const keyOf = (row: SupabaseCliApiKey): string => {
    const value = row.api_key ?? row.apiKey;
    return typeof value === 'string' ? value.trim() : '';
  };
  const named = rows.find(
    (row): row is SupabaseCliApiKey =>
      !!row && typeof row === 'object' && (row as SupabaseCliApiKey).name === 'service_role',
  );
  if (named && keyOf(named)) return keyOf(named);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = keyOf(row as SupabaseCliApiKey);
    if (value.startsWith('sb_secret_')) return value;
  }
  return null;
}

/** CLI 실패 출력을 사용자가 다음 행동을 알 수 있는 문장으로 바꾼다. */
export function describeSupabaseCliFailure(stderr: string, exitCode: number): string {
  const text = (stderr ?? '').trim();
  if (/not logged in|access token|login/i.test(text)) {
    return 'Supabase CLI에 로그인돼 있지 않습니다. 터미널에서 `supabase login`을 먼저 실행하세요.';
  }
  if (/not found|no such project|permission|forbidden|unauthorized/i.test(text)) {
    return `이 계정으로는 프로젝트 키를 조회할 수 없습니다. ${text.slice(0, 200)}`;
  }
  return text ? `Supabase CLI 오류 (${exitCode}): ${text.slice(0, 300)}` : `Supabase CLI가 실패했습니다 (종료 코드 ${exitCode}).`;
}
