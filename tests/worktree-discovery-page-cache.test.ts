import { describe, expect, test } from "bun:test";
import {
  REGISTERED_WORKTREE_DISCOVERY_CACHE_MAX_PAGES,
  WorktreeDiscoveryPageCache,
} from "../src/worktreeDiscoveryPageCache";

interface Result {
  failedProjectIds: string[];
  value: string;
}

describe("registered worktree discovery page cache", () => {
  test("retains at least one complete 64-page App drain", () => {
    expect(REGISTERED_WORKTREE_DISCOVERY_CACHE_MAX_PAGES).toBeGreaterThanOrEqual(64);
    const cache = new WorktreeDiscoveryPageCache<Result>(
      REGISTERED_WORKTREE_DISCOVERY_CACHE_MAX_PAGES,
      15 * 60_000,
    );
    for (let page = 0; page < 64; page += 1) {
      cache.set(`ports:page:${page}`, `metadata:${page}`, {
        failedProjectIds: [],
        value: String(page),
      }, 1_000);
    }
    for (let page = 0; page < 64; page += 1) {
      expect(cache.get(`ports:page:${page}`, `metadata:${page}`, 2_000)?.value).toBe(String(page));
    }
  });

  test("replaces one page's metadata generation instead of consuming another cache slot", () => {
    const cache = new WorktreeDiscoveryPageCache<Result>(64, 15 * 60_000);
    cache.set("ports:page:0", "old", { failedProjectIds: [], value: "old" }, 1_000);
    cache.set("ports:page:0", "new", { failedProjectIds: [], value: "new" }, 2_000);
    expect(cache.size).toBe(1);
    expect(cache.get("ports:page:0", "old", 2_001)).toBeUndefined();
    expect(cache.get("ports:page:0", "new", 2_001)?.value).toBe("new");
  });

  test("never caches a page containing a transient Git failure", () => {
    const cache = new WorktreeDiscoveryPageCache<Result>(64, 15 * 60_000);
    cache.set("ports:page:0", "same-metadata", {
      failedProjectIds: ["temporarily-unavailable"],
      value: "partial",
    }, 1_000);
    expect(cache.get("ports:page:0", "same-metadata", 1_001)).toBeUndefined();
  });
});
