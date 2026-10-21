import type { RemoteCommunityProjects } from './remoteCommunity';

/** Receive all permitted pages serially; retain partial results and stop on a device switch. */
export async function loadRemoteCommunityProjectPages(options: {
  startPage: number;
  isCurrent: () => boolean;
  fetchPage: (page: number) => Promise<RemoteCommunityProjects | null | undefined>;
  onPage: (value: RemoteCommunityProjects) => void;
  onRequest?: (page: number) => void;
}): Promise<void> {
  for (let page = options.startPage; page <= 500; page += 1) {
    if (!options.isCurrent()) return;
    options.onRequest?.(page);
    const value = await options.fetchPage(page);
    if (!options.isCurrent()) return;
    if (!value || value.page !== page) throw new Error('프로젝트 목록 페이지를 확인하지 못했습니다. 다시 시도하세요.');
    options.onPage(value);
    if (!value.hasMore) return;
  }
  throw new Error('프로젝트 목록이 페이지 한도를 초과했습니다.');
}
