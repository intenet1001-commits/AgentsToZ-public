/**
 * Page depth is controller-local state, so it belongs to the Mac that served
 * the pages. A scalar loses A's depth when the user switches A -> B -> A.
 */
export type RemoteControlLoadedPageDepths = Map<string, number>;

/** The controller protocol accepts page indexes 0..99. Byte-bounded pages can
 * contain far fewer than 20 cards, so request count must follow this contract
 * instead of assuming 500 / 20 pages. */
export const REMOTE_CONTROL_PORTAL_MAX_PAGE = 99;

export function progressingRemoteControlPage(
  previousPage: number,
  candidate: number | null,
): number | null {
  if (candidate === null) return null;
  if (!Number.isInteger(candidate)
    || candidate < 0
    || candidate > REMOTE_CONTROL_PORTAL_MAX_PAGE
    || candidate <= previousPage) {
    throw new Error('프로젝트 목록 페이지가 올바르게 진행되지 않았습니다. 새로고침 후 다시 시도하세요.');
  }
  return candidate;
}

export function loadedPageDepthForHost(
  depths: RemoteControlLoadedPageDepths,
  hostId: string | null,
): number {
  if (!hostId) return 1;
  return Math.max(1, depths.get(hostId) ?? 1);
}

export function rememberLoadedPageDepth(
  depths: RemoteControlLoadedPageDepths,
  hostId: string | null,
  pageCount: number,
): number {
  if (!hostId) return 1;
  const next = Number.isFinite(pageCount) && pageCount > 0
    ? Math.floor(pageCount)
    : 1;
  const remembered = Math.max(loadedPageDepthForHost(depths, hostId), next);
  depths.set(hostId, remembered);
  return remembered;
}
