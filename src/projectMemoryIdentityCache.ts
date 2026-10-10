import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ResolveProjectMemoryRoot } from "./projectMemoryProjectResolver";

/**
 * Registered-project enumeration only needs identity (canonical root + config),
 * never the document hash or the activity git snapshot. Running the full
 * `detectProjectMemory` per registered alias blocked the single-threaded
 * sidecar for 2.3 s (91 aliases) on every resolve; this cache runs the async
 * identity probe with bounded concurrency, shares in-flight probes between
 * requests and remembers answers (including failures) for a short TTL.
 */
export interface ProjectMemoryIdentityLike {
  exists: boolean;
  projectRoot: string;
  config: { memoryId?: string } | null;
}

/** `undefined` = this alias was not part of the prepared snapshot. `null` = probed, unusable. */
export interface ProjectMemoryIdentityLookup<T> {
  get(alias: string): T | null | undefined;
}

export interface ProjectMemoryIdentityCacheOptions<T> {
  detect: (path: string) => Promise<T>;
  ttlMs: number;
  maxEntries?: number;
  concurrency?: number;
  aliasKey?: (path: string) => string;
  now?: () => number;
}

export function projectMemoryAliasKey(path: string): string {
  try { return realpathSync(path).replace(/^\/private\/(?=var\/)/, "/"); } catch { return resolve(path); }
}

export function createProjectMemoryIdentityCache<T extends ProjectMemoryIdentityLike>(
  options: ProjectMemoryIdentityCacheOptions<T>,
) {
  const aliasKey = options.aliasKey ?? projectMemoryAliasKey;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 512;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const cache = new Map<string, { expiresAt: number; status: T | null }>();
  const pendingByAlias = new Map<string, Promise<T | null>>();
  let generation = 0;

  const probe = (alias: string): Promise<T | null> => {
    const cached = cache.get(alias);
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.status);
    let pending = pendingByAlias.get(alias);
    if (pending) return pending;
    const startedIn = generation;
    pending = options.detect(alias).catch(() => null).then(status => {
      // An invalidation while this probe ran means the answer may predate a
      // memory being created or moved; hand it to this caller but never keep it.
      if (startedIn !== generation) return status;
      while (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
      cache.set(alias, { expiresAt: now() + options.ttlMs, status });
      return status;
    }).finally(() => {
      if (pendingByAlias.get(alias) === pending) pendingByAlias.delete(alias);
    });
    pendingByAlias.set(alias, pending);
    return pending;
  };

  return {
    /** One read-only snapshot for one request; never retain it across requests. */
    async prepare(paths: Iterable<unknown>): Promise<ProjectMemoryIdentityLookup<T>> {
      const snapshot = new Map<string, T | null>();
      const aliases = [...new Set([...paths]
        .filter((path): path is string => typeof path === "string" && isAbsolute(path))
        .map(aliasKey))];
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, aliases.length) }, async () => {
        while (index < aliases.length) {
          const alias = aliases[index++]!;
          const status = await probe(alias);
          snapshot.set(alias, status);
          if (status && !snapshot.has(status.projectRoot)) snapshot.set(status.projectRoot, status);
        }
      }));
      return {
        get(alias: string) {
          const key = snapshot.has(alias) ? alias : aliasKey(alias);
          return snapshot.has(key) ? snapshot.get(key)! : undefined;
        },
      };
    },
    /** Drop every answer after anything that creates, moves or re-identifies a memory. */
    invalidate(): void {
      generation += 1;
      pendingByAlias.clear();
      cache.clear();
    },
  };
}

export type ProjectMemoryIdentityCache<T extends ProjectMemoryIdentityLike> = ReturnType<typeof createProjectMemoryIdentityCache<T>>;

export function registeredProjectMemoryAliases(
  registered: readonly { folderPath?: unknown; worktreePath?: unknown }[],
): string[] {
  return registered.flatMap(port => [port.folderPath, port.worktreePath])
    .filter((path): path is string => typeof path === "string" && isAbsolute(path.trim()))
    .map(path => path.trim());
}

/**
 * Adapts a prepared snapshot to the synchronous resolver callback. An alias the
 * snapshot does not know (a query path parsed from a message, an unregistered
 * linked worktree) goes through `fallback` — one probe, not one per alias.
 */
export function projectMemoryRootResolver<T extends ProjectMemoryIdentityLike>(
  lookup: ProjectMemoryIdentityLookup<T>,
  fallback?: (alias: string) => T | null,
): ResolveProjectMemoryRoot {
  return alias => {
    let status = lookup.get(alias);
    if (status === undefined) {
      try {
        status = fallback ? fallback(alias) : null;
      } catch {
        status = null;
      }
    }
    return status?.exists && status.config ? status.projectRoot : null;
  };
}
