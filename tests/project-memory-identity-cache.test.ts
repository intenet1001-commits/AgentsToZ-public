import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectMemoryIdentity, detectProjectMemoryIdentitySync, initializeProjectMemory } from "../project-memory-server";
import {
  createProjectMemoryIdentityCache,
  projectMemoryRootResolver,
  registeredProjectMemoryAliases,
} from "../src/projectMemoryIdentityCache";
import { resolveRegisteredProjectMemory } from "../src/projectMemoryProjectResolver";

type Identity = { exists: boolean; projectRoot: string; config: { memoryId: string } | null };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeDetect(options: { delayMs?: number; failFor?: Set<string> } = {}) {
  const calls: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const detect = async (path: string): Promise<Identity> => {
    calls.push(path);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    try {
      await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 1));
      if (options.failFor?.has(path)) throw new Error("git timed out");
      return { exists: true, projectRoot: path, config: { memoryId: `mem-${path}` } };
    } finally {
      running -= 1;
    }
  };
  return { detect, calls, maxRunning: () => maxRunning };
}

describe("shared project-memory identity cache", () => {
  test("enumerates each alias once with bounded concurrency and serves repeats from the TTL", async () => {
    let now = 1_000;
    const probe = fakeDetect({ delayMs: 5 });
    const cache = createProjectMemoryIdentityCache<Identity>({
      detect: probe.detect,
      ttlMs: 5_000,
      concurrency: 4,
      aliasKey: path => path,
      now: () => now,
    });
    const aliases = Array.from({ length: 20 }, (_, index) => `/p/${index}`);

    const first = await cache.prepare([...aliases, ...aliases]);
    expect(probe.calls).toHaveLength(20);
    expect(probe.maxRunning()).toBeLessThanOrEqual(4);
    expect(first.get("/p/3")?.config?.memoryId).toBe("mem-/p/3");
    expect(first.get("/not/prepared")).toBeUndefined();

    now += 4_000;
    await cache.prepare(aliases);
    expect(probe.calls).toHaveLength(20);

    now += 2_000;
    await cache.prepare(["/p/0"]);
    expect(probe.calls).toHaveLength(21);
  });

  test("caches failures as a negative result instead of retrying them on every request", async () => {
    const probe = fakeDetect({ failFor: new Set(["/gone"]) });
    const cache = createProjectMemoryIdentityCache<Identity>({ detect: probe.detect, ttlMs: 5_000, aliasKey: path => path });
    const first = await cache.prepare(["/gone"]);
    expect(first.get("/gone")).toBeNull();
    const second = await cache.prepare(["/gone"]);
    expect(second.get("/gone")).toBeNull();
    expect(probe.calls).toEqual(["/gone"]);
  });

  test("shares in-flight detection between concurrent requests", async () => {
    const probe = fakeDetect({ delayMs: 20 });
    const cache = createProjectMemoryIdentityCache<Identity>({ detect: probe.detect, ttlMs: 5_000, aliasKey: path => path });
    await Promise.all([cache.prepare(["/a", "/b"]), cache.prepare(["/b", "/a"])]);
    expect(probe.calls.sort()).toEqual(["/a", "/b"]);
  });

  test("invalidation drops cached answers and ignores an in-flight write-back", async () => {
    const probe = fakeDetect({ delayMs: 20 });
    const cache = createProjectMemoryIdentityCache<Identity>({ detect: probe.detect, ttlMs: 60_000, aliasKey: path => path });
    const pending = cache.prepare(["/a"]);
    cache.invalidate();
    await pending;
    await cache.prepare(["/a"]);
    expect(probe.calls).toEqual(["/a", "/a"]);
  });

  test("indexes the resolved canonical root so linked worktrees converge on it", async () => {
    const cache = createProjectMemoryIdentityCache<Identity>({
      detect: async path => ({ exists: true, projectRoot: "/main", config: { memoryId: "m" } }),
      ttlMs: 5_000,
      aliasKey: path => path,
    });
    const lookup = await cache.prepare(["/main/worktrees/feature"]);
    expect(lookup.get("/main")?.projectRoot).toBe("/main");
  });
});

describe("registered project resolution through the identity cache", () => {
  function makeRepo(home: string, name: string) {
    const folder = join(home, name);
    mkdirSync(folder, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: folder });
    return folder;
  }

  test("resolves by memoryId without falling back to a synchronous probe for registered aliases", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agentstoz-identity-cache-")));
    roots.push(home);
    const registered = Array.from({ length: 6 }, (_, index) => {
      const folderPath = makeRepo(home, `project-${index}`);
      return { id: `id-${index}`, name: `Project ${index}`, folderPath };
    });
    const status = initializeProjectMemory({ folderPath: registered[4]!.folderPath, projectName: "Project 4", autoBackup: false });
    const memoryId = status.config!.memoryId;

    let detectCalls = 0;
    const cache = createProjectMemoryIdentityCache({
      detect: path => { detectCalls += 1; return detectProjectMemoryIdentity(path); },
      ttlMs: 5_000,
    });
    const fallbackCalls: string[] = [];
    const lookup = await cache.prepare(registeredProjectMemoryAliases(registered));
    const memoryRoot = projectMemoryRootResolver(lookup, alias => {
      fallbackCalls.push(alias);
      return detectProjectMemoryIdentitySync(alias);
    });

    const resolution = resolveRegisteredProjectMemory(memoryId, registered, memoryRoot);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.id).toBe("id-4");
      expect(realpathSync(resolution.canonicalPath)).toBe(registered[4]!.folderPath);
    }
    expect(detectCalls).toBe(6);
    expect(fallbackCalls).toEqual([]);

    // A second request inside the TTL runs no git at all.
    const again = projectMemoryRootResolver(await cache.prepare(registeredProjectMemoryAliases(registered)));
    expect(resolveRegisteredProjectMemory("Project 4", registered, again).ok).toBe(true);
    expect(detectCalls).toBe(6);
  });

  test("an unregistered query path is probed once through the synchronous identity fallback", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agentstoz-identity-cache-")));
    roots.push(home);
    const folderPath = makeRepo(home, "main");
    Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", "init"], {
      cwd: folderPath,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
    });
    initializeProjectMemory({ folderPath, projectName: "Main", autoBackup: false });
    const linked = join(home, "linked");
    Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "linked", linked], { cwd: folderPath });
    const registered = [{ id: "main-id", name: "Main", folderPath }];

    const cache = createProjectMemoryIdentityCache({ detect: detectProjectMemoryIdentity, ttlMs: 5_000 });
    const fallbackCalls: string[] = [];
    const memoryRoot = projectMemoryRootResolver(await cache.prepare(registeredProjectMemoryAliases(registered)), alias => {
      fallbackCalls.push(alias);
      return detectProjectMemoryIdentitySync(alias);
    });
    const resolution = resolveRegisteredProjectMemory(linked, registered, memoryRoot);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(realpathSync(resolution.canonicalPath)).toBe(folderPath);
    expect(fallbackCalls.map(path => realpathSync(path))).toEqual([linked]);
  });
});

describe("api-server memory resolution call sites", () => {
  const apiSource = readFileSync(join(import.meta.dir, "..", "api-server.ts"), "utf8");

  test("never runs a full detectProjectMemory per registered alias", () => {
    // Full detect (document read + hash + activity git) belongs on the single
    // resolved root. Per-alias enumeration measured 2.3 s of event-loop block.
    expect(apiSource.includes("detectProjectMemory(alias)")).toBe(false);
    expect(/alias\s*=>\s*\{?\s*const \w+ = detectProjectMemory\(/.test(apiSource)).toBe(false);
  });

  test("the resolve, dispatch and memory-ids routes enumerate through the shared cached resolver", () => {
    for (const route of [
      "/api/project-memory/resolve-project",
      "/api/project-memory/dispatch-worker",
      "/api/project-memory/open-resolved-project",
      "/api/project-memory/refresh-resolved-status",
      "/api/project-memory/thread/start",
      "/api/agentstoz/project-route",
    ]) {
      const start = apiSource.indexOf(`url.pathname === "${route}"`);
      expect(start).toBeGreaterThan(0);
      const body = apiSource.slice(start, start + 2_500);
      expect({ route, usesCache: body.includes("await registeredProjectMemoryRootResolver(") }).toEqual({ route, usesCache: true });
    }
    const memoryIdsStart = apiSource.indexOf('url.pathname === "/api/project-memory/memory-ids"');
    const memoryIds = apiSource.slice(memoryIdsStart, apiSource.indexOf("url.pathname ===", memoryIdsStart + 10));
    expect(memoryIds.includes("projectMemoryIdentityCache.prepare(")).toBe(true);
    expect(memoryIds.includes("detectProjectMemory(folderPath)")).toBe(false);
  });
});
