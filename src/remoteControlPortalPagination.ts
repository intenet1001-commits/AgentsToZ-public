/**
 * Page depth is controller-local state, so it belongs to the Mac that served
 * the pages. A scalar loses A's depth when the user switches A -> B -> A.
 */
export type RemoteControlLoadedPageDepths = Map<string, number>;

/** The controller protocol accepts page indexes 0..99. Byte-bounded pages can
 * contain far fewer than 20 cards, so request count must follow this contract
 * instead of assuming 500 / 20 pages. */
export const REMOTE_CONTROL_PORTAL_MAX_PAGE = 99;

/** Only retry a refused admission, before an action is sent. Transport failures
 * may still have a pending request and are left to the controller's recovery. */
export async function requestRemoteControlProjectPage({ request, isCurrent, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }: {
  request: () => Promise<unknown>;
  isCurrent: () => boolean;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!isCurrent()) return false;
    try {
      await request();
      return isCurrent();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'REMOTE_CONTROL_ACTION_IN_PROGRESS' || attempt === 3) throw error;
      await sleep(750 * 2 ** attempt);
    }
  }
  return false;
}

export async function sweepRemoteControlProjects(options: {
  nextPage: () => number | null;
  request: (page: number) => Promise<unknown>;
  isCurrent: () => boolean;
  onPage: (page: number) => void;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<boolean> {
  let previousPage = -1;
  for (let guard = 0; guard <= REMOTE_CONTROL_PORTAL_MAX_PAGE; guard += 1) {
    if (!options.isCurrent()) return false;
    const next = progressingRemoteControlPage(previousPage, options.nextPage());
    if (next === null) return true;
    if (!await requestRemoteControlProjectPage({
      request: () => options.request(next), isCurrent: options.isCurrent, sleep: options.sleep,
    })) return false;
    options.onPage(next);
    previousPage = next;
  }
  if (options.nextPage() !== null) throw new Error('프로젝트 목록이 프로토콜 페이지 한도를 초과했습니다. Mac 앱을 업데이트한 뒤 다시 시도하세요.');
  return true;
}

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
