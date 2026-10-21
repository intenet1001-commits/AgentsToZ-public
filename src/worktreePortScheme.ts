/**
 * 워크트리 개발 서버 포트 판별.
 *
 * 워크트리 포트는 두 가지 규칙 중 하나로만 배정된다:
 *  - 신규: `slot * 10000 + mainPort` (예: main 9000 → 19000/29000/39000/49000/59000)
 *  - 레거시: 경로 해시 기반 10001–10499
 *
 * 이 규칙이 필요한 이유: 실행 중인 포트를 cwd 일치만으로 찾으면, 같은 디렉터리에서 뜬
 * 무관한 프로세스(MCP 서버, LSP, 스크립트)가 워크트리 개발 서버로 오인된다. 실제로
 * Serena MCP(cwd=워크트리, :24285)가 워크트리 서버로 잡혀 「중지(24285)」 버튼이
 * Serena를 죽이는 상태였다. cwd 일치에 더해 포트가 배정 규칙에 맞는지까지 확인한다.
 */

export const LEGACY_WORKTREE_PORT_MIN = 10001;
export const LEGACY_WORKTREE_PORT_MAX = 10499;

/** 앱이 워크트리에 배정할 수 있는 포트인가. mainPort를 모르면 레거시 범위만 인정한다. */
export function isWorktreePortCandidate(port: number, mainPort?: number | null): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (port >= LEGACY_WORKTREE_PORT_MIN && port <= LEGACY_WORKTREE_PORT_MAX) return true;
  if (mainPort == null) return false;
  // worktreePortForMain은 mainPort가 1000–9999일 때만 slot 규칙을 쓴다.
  if (!Number.isInteger(mainPort) || mainPort < 1000 || mainPort > 9999) return false;
  const slot = Math.floor(port / 10000);
  return slot >= 1 && slot <= 5 && port % 10000 === mainPort;
}
