// 로컬 데몬(api-server / project-memory-server)이 RLS 하에서 Supabase에 접근하기 위한 자격증명.
//
// 왜 별도 파일인가
//   Supabase RLS 정책은 `authenticated` 롤만 허용하는데, 로컬 서버에는 브라우저 세션이 없다.
//   `/api/project-memory/push` 는 CLI(curl 훅)에서도 호출되므로 "프론트가 토큰을 넘겨준다"는
//   전제를 쓸 수 없다. 그래서 서버는 service_role 키를 쓴다.
//
//   ⚠ service_role 키를 portal.json 에 넣으면 안 된다 — `/api/portal` (GET)이 portal.json을
//   통째로 프론트에 반환하므로 그대로 유출된다. 반드시 이 별도 파일 또는 환경변수만 사용한다.
//   이 모듈은 키를 반환만 하고, 어떤 HTTP 응답에도 실려서는 안 된다.
//
// 서버가 127.0.0.1 바인딩이고 CORS가 화이트리스트라는 전제 위에서만 안전하다
// (api-server.ts: hostname "127.0.0.1", isAllowedApiOrigin).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SERVICE_KEY_FILENAME = "supabase-service.json";

export function serviceRoleKeyPath(appDataDir: string): string {
  return join(appDataDir, SERVICE_KEY_FILENAME);
}

/** 환경변수 → 앱 데이터 폴더의 supabase-service.json 순으로 조회. 없으면 null. */
export function loadServiceRoleKey(appDataDir: string): string | null {
  const fromEnv = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const file = serviceRoleKeyPath(appDataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const key = String(parsed.serviceRoleKey ?? parsed.service_role_key ?? "").trim();
    return key || null;
  } catch {
    return null;
  }
}

/** 로컬 서버가 Supabase에 쓸 키. service_role이 있으면 그것을, 없으면 anon 키(=RLS 미적용 환경). */
export function resolveServerSupabaseKey(appDataDir: string, anonKey: string): string {
  return loadServiceRoleKey(appDataDir) ?? anonKey;
}

/** RLS/권한 거부 판정 (PostgREST 42501 / PGRST301 / 401·403). */
export function isRlsDeniedError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { code?: unknown; message?: unknown; status?: unknown };
  const code = String(e.code ?? "");
  const status = Number(e.status ?? 0);
  const msg = String(e.message ?? "");
  if (code === "42501" || code === "PGRST301") return true;
  if (status === 401 || status === 403) return true;
  return /row[- ]level security|permission denied|not authorized|invalid claim|JWT/i.test(msg);
}

// 이 문구는 사용자가 실제로 보게 되는 유일한 안내다. 예전 문구는 파일 경로와 재시작을
// 요구했는데, 키는 요청마다 새로 읽히므로(loadServiceRoleKey) 재시작은 필요 없고,
// 앱 설정에 입력란이 생긴 뒤로는 터미널을 열 이유도 없다.
export const SERVICE_KEY_HINT =
  `장기기억 테이블은 service_role 키로만 읽고 쓸 수 있습니다(포트·북마크 동기화는 영향 없음). ` +
  `앱 설정 → Supabase 연결 → "service_role Key"에 Supabase 대시보드의 service_role(secret) 키를 붙여넣으세요. ` +
  `재시작은 필요 없습니다. 서버 환경이라면 ${SERVICE_KEY_FILENAME} 파일이나 SUPABASE_SERVICE_ROLE_KEY 환경변수도 됩니다.`;
