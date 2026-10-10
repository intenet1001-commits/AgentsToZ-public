import { useCallback, useEffect, useRef, useState } from 'react';
import { INCREMENTAL_LIST_PAGE, incrementalRenderLimit, nextIncrementalLimit } from '../incrementalList';

/**
 * How many rows of a long list to mount. The limit restarts at one page when
 * `resetKey` changes (a new search or filter), so a narrowed result never
 * inherits a huge window from before.
 */
export function useIncrementalRender(total: number, resetKey: string, pageSize: number = INCREMENTAL_LIST_PAGE) {
  const [state, setState] = useState(() => ({ key: resetKey, limit: incrementalRenderLimit(total, pageSize) }));
  const base = state.key === resetKey ? state.limit : pageSize;
  const limit = Math.min(total, Math.max(base, incrementalRenderLimit(total, pageSize)));
  const showMore = useCallback(() => {
    setState(current => {
      const from = current.key === resetKey ? current.limit : pageSize;
      return { key: resetKey, limit: nextIncrementalLimit(Math.max(from, incrementalRenderLimit(total, pageSize)), total, pageSize) };
    });
  }, [resetKey, total, pageSize]);
  return { limit, hasMore: limit < total, showMore };
}

/**
 * The end of a paged list: an observer sentinel that loads the next page as it
 * scrolls into view, plus a visible button for keyboards and environments
 * without IntersectionObserver. Renders nothing when everything is shown.
 */
export function IncrementalListMore({
  shown,
  total,
  onMore,
  testId,
  label = '더 보기',
}: {
  shown: number;
  total: number;
  onMore: () => void;
  testId?: string;
  label?: string;
}) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const hasMore = shown < total;
  useEffect(() => {
    const node = sentinel.current;
    if (!hasMore || !node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onMore();
    }, { rootMargin: '240px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, onMore, shown]);
  if (!hasMore) return null;
  return (
    <div ref={sentinel} className="incremental-list-more" data-testid={testId}>
      <button type="button" onClick={onMore}>
        {label} · {shown.toLocaleString('ko-KR')}/{total.toLocaleString('ko-KR')}
      </button>
    </div>
  );
}
