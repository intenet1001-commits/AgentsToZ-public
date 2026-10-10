import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStaleWhileRevalidateCache } from "../src/staleWhileRevalidate";
import { parseProjectMemoryPanelScope, projectMemoryPanelStatus, remoteStatusUnderWorkspaceLease, type PanelDetectedStatus } from "../src/projectMemoryPanelStatus";

type Status = PanelDetectedStatus & { contentHash: string };

function harness(options: { recovery?: unknown; remoteFails?: boolean; canonicalized?: boolean } = {}) {
  let now = 10_000;
  let detects = 0;
  let archiveReads = 0;
  let remoteReads = 0;
  const queued: Array<() => void> = [];
  const invalidated: string[] = [];
  const snapshots = createStaleWhileRevalidateCache<Status>({
    compute: key => {
      detects += 1;
      return { exists: true, projectRoot: key, config: { memoryId: "m" }, documentRecovery: { state: "none" }, contentHash: `h${detects}` };
    },
    freshMs: 2_000,
    maxStaleMs: 60_000,
    now: () => now,
    schedule: run => { queued.push(run); },
  });
  const deps = {
    snapshots,
    sessionRecovery: () => options.recovery ?? null,
    archiveStatus: (status: Status) => { archiveReads += 1; return { available: true, root: status.projectRoot }; },
    remoteStatus: async (status: Status) => {
      remoteReads += 1;
      if (options.remoteFails) throw new Error("Supabase 설정이 없습니다.");
      return { exists: true, contentHash: status.contentHash, inSync: true, canonicalizedFrom: options.canonicalized ? "old" : null };
    },
    onRemoteChangedIdentity: (key: string) => { invalidated.push(key); snapshots.invalidate(key); },
  };
  return {
    deps,
    advance: (ms: number) => { now += ms; },
    flush: () => { while (queued.length) queued.shift()!(); },
    counts: () => ({ detects, archiveReads, remoteReads }),
    invalidated,
  };
}

describe("project memory panel-status", () => {
  test("a full read runs exactly one detect and hands it to archive and remote status", async () => {
    const h = harness();
    const result = await projectMemoryPanelStatus({ folderPath: "/p", scope: "full" }, h.deps);
    expect(h.counts()).toEqual({ detects: 1, archiveReads: 1, remoteReads: 1 });
    expect(result.status.contentHash).toBe("h1");
    expect(result.remote).toMatchObject({ ok: true, contentHash: "h1", inSync: true });
    expect(result.privateGitHubArchive).toMatchObject({ available: true });
    expect(result.stale).toBe(false);
  });

  test("local polls share the snapshot: a burst costs no extra detect, a late poll revalidates in the background", async () => {
    const h = harness();
    await projectMemoryPanelStatus({ folderPath: "/p", scope: "full" }, h.deps);
    // focus + visibilitychange + interval landing together
    for (let i = 0; i < 3; i += 1) {
      const burst = await projectMemoryPanelStatus({ folderPath: "/p", scope: "local" }, h.deps);
      expect(burst.stale).toBe(false);
      expect(burst.remote).toBeNull();
    }
    expect(h.counts().detects).toBe(1);

    h.advance(30_000);
    const late = await projectMemoryPanelStatus({ folderPath: "/p", scope: "local" }, h.deps);
    expect(late.stale).toBe(true);
    expect(late.status.contentHash).toBe("h1");
    expect(h.counts().detects).toBe(1);
    h.flush();
    expect(h.counts().detects).toBe(2);
    const followUp = await projectMemoryPanelStatus({ folderPath: "/p", scope: "local" }, h.deps);
    expect(followUp.stale).toBe(false);
    expect(followUp.status.contentHash).toBe("h2");
    expect(h.counts().remoteReads).toBe(1);
  });

  test("a snapshot older than the stale window is recomputed inline, and full always forces", async () => {
    const h = harness();
    await projectMemoryPanelStatus({ folderPath: "/p", scope: "local" }, h.deps);
    h.advance(61_000);
    const old = await projectMemoryPanelStatus({ folderPath: "/p", scope: "local" }, h.deps);
    expect(old.stale).toBe(false);
    expect(h.counts().detects).toBe(2);
    await projectMemoryPanelStatus({ folderPath: "/p", scope: "full" }, h.deps);
    expect(h.counts().detects).toBe(3);
  });

  test("a pending recovery skips archive and remote reads", async () => {
    const h = harness({ recovery: { saveId: "s" } });
    const result = await projectMemoryPanelStatus({ folderPath: "/p", scope: "full" }, h.deps);
    expect(result.remote).toBeNull();
    expect(h.counts()).toEqual({ detects: 1, archiveReads: 0, remoteReads: 0 });
  });

  test("a remote failure is reported beside a healthy local status, not instead of it", async () => {
    const h = harness({ remoteFails: true });
    const result = await projectMemoryPanelStatus({ folderPath: "/p", scope: "full" }, h.deps);
    expect(result.status.exists).toBe(true);
    expect(result.remote).toEqual({ ok: false, error: "Supabase 설정이 없습니다." });
  });

  test("a remote read that re-identifies the memory drops the local snapshot", async () => {
    const h = harness({ canonicalized: true });
    await projectMemoryPanelStatus({ folderPath: "/p", scope: "full" }, h.deps);
    expect(h.invalidated).toEqual(["/p"]);
    await projectMemoryPanelStatus({ folderPath: "/p", scope: "local" }, h.deps);
    expect(h.counts().detects).toBe(2);
  });

  test("unknown scopes fall back to the full read", () => {
    expect(parseProjectMemoryPanelScope("local")).toBe("local");
    expect(parseProjectMemoryPanelScope(undefined)).toBe("full");
    expect(parseProjectMemoryPanelScope("everything")).toBe("full");
  });
});

describe("stale-while-revalidate snapshot", () => {
  test("never caches a failed computation and drops a key whose background revalidation fails", () => {
    let now = 0;
    let fail = false;
    let computes = 0;
    const queued: Array<() => void> = [];
    const cache = createStaleWhileRevalidateCache<number>({
      compute: () => { computes += 1; if (fail) throw new Error("gone"); return computes; },
      freshMs: 1_000,
      maxStaleMs: 10_000,
      now: () => now,
      schedule: run => { queued.push(run); },
    });
    expect(cache.read("k").value).toBe(1);
    now = 5_000;
    fail = true;
    expect(cache.read("k")).toMatchObject({ value: 1, stale: true });
    // one background revalidation per key, however many readers arrive
    expect(cache.read("k").stale).toBe(true);
    expect(queued).toHaveLength(1);
    queued.shift()!();
    expect(cache.size()).toBe(0);
    expect(() => cache.read("k")).toThrow("gone");
    expect(cache.size()).toBe(0);
  });
});

describe("panel-status remote half holds the workspace lease", () => {
  type LeasedStatus = PanelDetectedStatus & { config: { memoryId: string; lastSyncedHash?: string | null } | null };
  const unleased: LeasedStatus = { exists: true, projectRoot: "/p", config: { memoryId: "m", lastSyncedHash: "old" } };

  test("the remote read runs inside the lease with a config read under that lease", async () => {
    let inLease = false;
    let seen: LeasedStatus | undefined;
    const result = await remoteStatusUnderWorkspaceLease(unleased, {
      withLease: async operation => { inLease = true; try { return await operation(); } finally { inLease = false; } },
      assertReady: () => { expect(inLease).toBe(true); },
      // Another writer (push) updated the config after the unleased detect.
      freshIdentity: root => ({ projectRoot: root, config: { memoryId: "m", lastSyncedHash: "new" } }),
      remote: async local => { expect(inLease).toBe(true); seen = local; return { ok: 1 }; },
    });
    expect(result).toEqual({ ok: 1 });
    // A claim save must never write back the stale unleased config.
    expect(seen?.config).toEqual({ memoryId: "m", lastSyncedHash: "new" });
  });

  test("a changed identity lets the remote read detect again under the lease", async () => {
    let local: LeasedStatus | undefined | null = null;
    await remoteStatusUnderWorkspaceLease(unleased, {
      withLease: operation => operation(),
      assertReady: () => {},
      freshIdentity: root => ({ projectRoot: root, config: { memoryId: "other" } }),
      remote: async value => { local = value; return {}; },
    });
    expect(local).toBeUndefined();
  });

  test("a busy lease fails only the remote half; the local status is still served", async () => {
    const h = harness();
    const deps = {
      ...h.deps,
      remoteStatus: (status: Status) => remoteStatusUnderWorkspaceLease(status, {
        withLease: async () => { throw new Error("다른 작업이 이 프로젝트를 쓰는 중입니다."); },
        assertReady: () => {},
        freshIdentity: root => ({ projectRoot: root, config: status.config }),
        remote: async () => ({}),
      }),
    };
    const result = await projectMemoryPanelStatus({ folderPath: "/p", scope: "full" }, deps);
    expect(result.status.exists).toBe(true);
    expect(result.remote).toEqual({ ok: false, error: "다른 작업이 이 프로젝트를 쓰는 중입니다." });
  });
});

describe("panel-status wiring", () => {
  const api = readFileSync(join(import.meta.dir, "..", "api-server.ts"), "utf8");
  const panel = readFileSync(join(import.meta.dir, "..", "src", "ProjectMemoryPanel.tsx"), "utf8");
  const memoryServer = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");

  test("the sidecar exposes one panel-status route and keeps the old routes for other callers", () => {
    const start = api.indexOf('url.pathname === "/api/project-memory/panel-status"');
    expect(start).toBeGreaterThan(0);
    const route = api.slice(start, api.indexOf("url.pathname ===", start + 10));
    expect(route.includes("projectMemoryPanelStatus(")).toBe(true);
    expect(route.includes("detectProjectMemory(")).toBe(false);
    // remote-status is a lease route (it may rewrite config.json); panel-status must
    // not reach remoteProjectMemoryStatus without that same lease.
    expect(route.includes("remoteStatusUnderWorkspaceLease(")).toBe(true);
    expect(route.includes("withManagedWorkspaceLease(")).toBe(true);
    expect(route.indexOf("remoteStatusUnderWorkspaceLease(")).toBeLessThan(route.indexOf("remoteProjectMemoryStatus("));
    for (const legacy of ["/api/project-memory/detect", "/api/project-memory/remote-status", "/api/project-memory/private-github-archive/status"]) {
      expect(api.includes(`url.pathname === "${legacy}"`)).toBe(true);
    }
  });

  test("remote status reuses a supplied detect and re-detects only after re-identification", () => {
    const fn = memoryServer.slice(memoryServer.indexOf("export async function remoteProjectMemoryStatus("));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    expect(body.includes("input.local ?? detectProjectMemory(input.folderPath)")).toBe(true);
    expect(body.includes("identity?.canonicalizedFrom ? detectProjectMemory(local.projectRoot) : local")).toBe(true);
  });

  test("the panel reads panel-status instead of the detect/archive/remote triple", () => {
    const refresh = panel.slice(panel.indexOf("const refresh = useCallback"), panel.indexOf("const refreshLocalActivity = useCallback"));
    expect(refresh.includes("projectMemoryApi.panelStatus(")).toBe(true);
    const poll = panel.slice(panel.indexOf("const refreshLocalActivity = useCallback"));
    expect(poll.slice(0, 2_000).includes("scope: 'local'")).toBe(true);
  });
});
