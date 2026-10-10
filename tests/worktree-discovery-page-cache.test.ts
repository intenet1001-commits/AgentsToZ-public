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

  test("keeps successful partial work without claiming the page is complete", () => {
    const cache = new WorktreeDiscoveryPageCache<Result>(64, 15 * 60_000);
    cache.set("ports:page:0", "same-metadata", {
      failedProjectIds: ["temporarily-unavailable"],
      value: "partial",
    }, 1_000);
    expect(cache.get("ports:page:0", "same-metadata", 1_001)).toBeUndefined();
    expect(cache.getPartial("ports:page:0", "same-metadata", 1_001)?.value).toBe("partial");
    expect(cache.getPartial("ports:page:0", "changed-metadata", 1_001)).toBeUndefined();

    cache.set("ports:page:0", "same-metadata", { failedProjectIds: [], value: "complete" }, 2_000);
    expect(cache.get("ports:page:0", "same-metadata", 2_001)?.value).toBe("complete");
    expect(cache.getPartial("ports:page:0", "same-metadata", 2_001)).toBeUndefined();
  });

  test("expires partial work so successful families are eventually rechecked", () => {
    const cache = new WorktreeDiscoveryPageCache<Result>(64, 60_000);
    cache.set("ports:page:0", "same-metadata", {
      failedProjectIds: ["temporarily-unavailable"], value: "partial",
    }, 1_000);
    expect(cache.getPartial("ports:page:0", "same-metadata", 60_999)?.value).toBe("partial");
    expect(cache.getPartial("ports:page:0", "same-metadata", 61_000)).toBeUndefined();
  });

  test("retrying a failed project does not renew the successful families' TTL", () => {
    const cache = new WorktreeDiscoveryPageCache<Result>(64, 60_000);
    cache.set("ports:page:0", "same-metadata", {
      failedProjectIds: ["temporarily-unavailable"], value: "first partial",
    }, 1_000);
    cache.set("ports:page:0", "same-metadata", {
      failedProjectIds: ["temporarily-unavailable"], value: "retry partial",
    }, 40_000, true);
    expect(cache.getPartial("ports:page:0", "same-metadata", 60_999)?.value).toBe("retry partial");
    expect(cache.getPartial("ports:page:0", "same-metadata", 61_000)).toBeUndefined();
  });
});
