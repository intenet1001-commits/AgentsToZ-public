export const REGISTERED_WORKTREE_DISCOVERY_CACHE_MAX_PAGES = 128;

interface CacheableWorktreeDiscoveryResult {
  failedProjectIds: readonly string[];
}

interface PageCacheEntry<T> {
  metadataSignature: string;
  completedAt: number;
  result: T;
}

/**
 * One cache slot represents one ports snapshot + page cursor. Metadata changes
 * replace that slot instead of accumulating generations that evict unrelated
 * pages. A partial page retains its successful families for the TTL, while the
 * caller retries failed projects on each poll. `get` exposes only complete
 * pages so an incomplete discovery is never presented as complete.
 */
export class WorktreeDiscoveryPageCache<T extends CacheableWorktreeDiscoveryResult> {
  private readonly entries = new Map<string, PageCacheEntry<T>>();

  constructor(
    private readonly maxPages: number,
    private readonly ttlMs: number,
  ) {
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages must be a positive integer");
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("ttlMs must be non-negative");
  }

  get size(): number {
    return this.entries.size;
  }

  private entry(pageKey: string, metadataSignature: string, now: number): PageCacheEntry<T> | undefined {
    const entry = this.entries.get(pageKey);
    if (!entry) return undefined;
    if (entry.metadataSignature !== metadataSignature || now - entry.completedAt >= this.ttlMs) {
      if (now - entry.completedAt >= this.ttlMs) this.entries.delete(pageKey);
      return undefined;
    }
    return entry;
  }

  get(pageKey: string, metadataSignature: string, now = Date.now()): T | undefined {
    const result = this.entry(pageKey, metadataSignature, now)?.result;
    return result?.failedProjectIds.length === 0 ? result : undefined;
  }

  getPartial(pageKey: string, metadataSignature: string, now = Date.now()): T | undefined {
    const result = this.entry(pageKey, metadataSignature, now)?.result;
    return result && result.failedProjectIds.length > 0 ? result : undefined;
  }

  set(pageKey: string, metadataSignature: string, result: T, now = Date.now(), preserveExistingAge = false): void {
    // A retry of only the failed projects must not renew the successful
    // families' freshness budget on every poll.
    const completedAt = preserveExistingAge
      ? this.entry(pageKey, metadataSignature, now)?.completedAt ?? now : now;
    // Delete first so a refreshed page becomes the newest bounded entry.
    this.entries.delete(pageKey);
    this.entries.set(pageKey, { metadataSignature, completedAt, result });
    while (this.entries.size > this.maxPages) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }
}
