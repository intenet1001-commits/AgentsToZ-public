/**
 * "이 API 서버가 그 기능을 모른다"를 기능 실패와 구분하는 판정 한 곳.
 *
 * 앱은 **이미 떠 있는 로컬 API 를 그대로 채택**하고, 웹 UI 는 vite 프록시로 같은 서버를
 * 본다. 그래서 UI 가 서버보다 새로운 상태가 상시 가능하다. 그때 새 엔드포인트는
 * `api-server.ts` 의 마지막 폴백에 걸려 **404 `{"error":"Not found"}`** 를 낸다.
 *
 * 그 문구를 그대로 보여주면 사용자는 기능이 고장 났다고 읽는다 — 실제로는 서버만 오래된
 * 것이고, 할 일은 서버 재시작 하나다 (실측 2026-08-14: 07:57 에 뜬 api-server 가 10:58 에
 * 추가된 `/api/clone-repository` 를 몰라 웹에서 "Not found" 로 실패했고, 같은 기능이
 * Rust 경로를 타는 앱에서는 정상 동작했다).
 */

/** api-server 의 마지막 폴백이 돌려주는 본문. 이 값이면 "엔드포인트를 모른다"는 뜻이다. */
const UNKNOWN_ENDPOINT_BODY = 'Not found';

/**
 * 응답이 "이 서버가 이 엔드포인트를 모른다"인지.
 *
 * 404 만으로 단정하지 않는다 — 엔드포인트가 있으면서 대상을 못 찾아 404 를 내는 경우와
 * 섞이면 안 되므로, 폴백이 쓰는 본문까지 같이 본다.
 */
export function isUnknownApiEndpoint(status: number, body: unknown): boolean {
  if (status !== 404) return false;
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error.trim() === UNKNOWN_ENDPOINT_BODY;
}

/** 사용자가 보게 될 문구. 원인과 다음 행동이 둘 다 들어 있어야 한다. */
export function unknownApiEndpointMessage(pathname: string): string {
  return `이 API 서버는 ${pathname} 을(를) 모릅니다 — 서버가 앱보다 오래된 상태입니다. `
    + '`./실행.command` 로 API 서버를 다시 시작한 뒤 다시 시도하세요.';
}
