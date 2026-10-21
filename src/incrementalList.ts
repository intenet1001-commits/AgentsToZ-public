/**
 * Long lists (bookmarks, 내가 한 말, cleanup review, the memory archive) render
 * one page at a time instead of every row at once. Measured: 2,000 bookmarks
 * used to mount ~78.7k DOM nodes and typing into search lagged ~0.9 s.
 *
 * This file is the pure part (tested without a DOM); the React hook and the
 * «더 보기» sentinel live in `components/IncrementalListMore.tsx`.
 */
export const INCREMENTAL_LIST_PAGE = 40;

export function incrementalRenderLimit(total: number, pageSize: number = INCREMENTAL_LIST_PAGE): number {
  return Math.max(0, Math.min(total, pageSize));
}

export function nextIncrementalLimit(current: number, total: number, pageSize: number = INCREMENTAL_LIST_PAGE): number {
  return Math.max(0, Math.min(total, current + pageSize));
}

export interface IncrementalGroup<T> {
  key: string;
  items: readonly T[];
}

export interface IncrementalGroupSlice<T> {
  key: string;
  items: T[];
  /** The group's full size — section headers keep showing the real count. */
  total: number;
}

/**
 * Spend one render budget across ordered groups (e.g. 고정됨 → categories →
 * 미분류). Groups past the budget and empty groups are dropped.
 */
export function sliceAcrossGroups<T>(groups: ReadonlyArray<IncrementalGroup<T>>, limit: number): IncrementalGroupSlice<T>[] {
  const out: IncrementalGroupSlice<T>[] = [];
  let left = Math.max(0, limit);
  for (const group of groups) {
    if (left <= 0) break;
    if (group.items.length === 0) continue;
    const items = group.items.slice(0, left);
    left -= items.length;
    out.push({ key: group.key, items, total: group.items.length });
  }
  return out;
}
