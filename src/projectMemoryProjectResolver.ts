import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface RegisteredProjectMemoryCandidate {
  id: string;
  name?: string | null;
  folderPath?: string | null;
  worktreePath?: string | null;
}

export type ProjectMemoryProjectResolution =
  | {
      ok: true;
      id: string;
      name: string;
      requestedPath: string;
      canonicalPath: string;
      matchedBy: "memoryId" | "id" | "name" | "path";
    }
  | {
      ok: false;
      code: "PROJECT_QUERY_REQUIRED" | "PROJECT_NOT_REGISTERED" | "PROJECT_AMBIGUOUS" | "PROJECT_MEMORY_NOT_INITIALIZED";
      error: string;
      candidates: Array<{ id: string; name: string; path: string }>;
    };

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function canonicalDirectory(path: string): string | null {
  if (!isAbsolute(path)) return null;
  try {
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isDirectory()) return null;
    return process.platform === "darwin" && canonical.startsWith("/private/")
      ? canonical.slice("/private".length)
      : canonical;
  } catch {
    return null;
  }
}

function candidatePaths(candidate: RegisteredProjectMemoryCandidate): string[] {
  const paths: string[] = [];
  for (const value of [candidate.folderPath, candidate.worktreePath]) {
    if (typeof value !== "string" || !value.trim()) continue;
    const canonical = canonicalDirectory(value.trim());
    if (canonical && !paths.includes(canonical)) paths.push(canonical);
  }
  return paths;
}

export type ResolveProjectMemoryRoot = (registeredAlias: string) => string | null;

export interface ResolveRegisteredProjectMemoryOptions {
  requireInitialized?: boolean;
}

function initializedRoot(path: string, resolveMemoryRoot?: ResolveProjectMemoryRoot): string | null {
  if (resolveMemoryRoot) {
    try {
      const resolved = resolveMemoryRoot(path);
      return resolved ? canonicalDirectory(resolved) : null;
    } catch {
      return null;
    }
  }
  return existsSync(join(path, ".agent-memory", "config.json")) ? path : null;
}

function memoryIdAt(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(path, ".agent-memory", "config.json"), "utf8"));
    return typeof parsed?.memoryId === "string" && parsed.memoryId.trim()
      ? parsed.memoryId.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolves Telegram/Hermes project input against the app's registered-project
 * allowlist. It never scans the filesystem and never creates memory at a typo.
 */
export function resolveRegisteredProjectMemory(
  query: string,
  registered: readonly RegisteredProjectMemoryCandidate[],
  resolveMemoryRoot?: ResolveProjectMemoryRoot,
  options: ResolveRegisteredProjectMemoryOptions = {},
): ProjectMemoryProjectResolution {
  const rawQuery = typeof query === "string" ? query.trim() : "";
  if (!rawQuery) {
    return {
      ok: false,
      code: "PROJECT_QUERY_REQUIRED",
      error: "프로젝트 ID, 정확한 이름 또는 등록된 절대경로가 필요합니다.",
      candidates: [],
    };
  }

  const usable = registered.flatMap(candidate => {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id.trim()) return [];
    const paths = candidatePaths(candidate);
    if (!paths.length) return [];
    return [{
      id: candidate.id.trim(),
      name: typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : paths[0]!.split(/[\\/]/).filter(Boolean).pop() ?? candidate.id.trim(),
      paths,
    }];
  });

  const queryPath = isAbsolute(rawQuery) ? canonicalDirectory(rawQuery) : null;
  const normalized = normalizedText(rawQuery);
  const ranked: Array<{ rank: number; matchedBy: "memoryId" | "id" | "name" | "path"; candidate: typeof usable[number]; path: string; requestedPath: string }> = [];
  for (const candidate of usable) {
    const initializedRoots = Array.from(new Set(
      candidate.paths
        .map(path => initializedRoot(path, resolveMemoryRoot))
        .filter((path): path is string => !!path),
    ));
    if (initializedRoots.length > 1) {
      return {
        ok: false,
        code: "PROJECT_AMBIGUOUS",
        error: "하나의 등록 항목이 서로 다른 장기기억 루트를 가리킵니다.",
        candidates: initializedRoots.map(path => ({ id: candidate.id, name: candidate.name, path })),
      };
    }
    const memoryRoots = initializedRoots.filter(path => memoryIdAt(path) === rawQuery);
    if (memoryRoots.length > 0) {
      ranked.push({ rank: 0, matchedBy: "memoryId", candidate, path: memoryRoots[0]!, requestedPath: candidate.paths[0]! });
    } else if (candidate.id === rawQuery) {
      ranked.push({ rank: 1, matchedBy: "id", candidate, path: initializedRoots[0] ?? candidate.paths[0]!, requestedPath: candidate.paths[0]! });
    } else if (queryPath && candidate.paths.includes(queryPath)) {
      // An explicit path remains allowlisted by its alias, but the returned path
      // is always the authoritative memory root. Linked worktrees therefore
      // converge to the main worktree instead of pairing a worktree path with a
      // different root's memoryId.
      ranked.push({ rank: 2, matchedBy: "path", candidate, path: initializedRoot(queryPath, resolveMemoryRoot) ?? queryPath, requestedPath: queryPath });
    } else if (normalizedText(candidate.name) === normalized) {
      ranked.push({ rank: 3, matchedBy: "name", candidate, path: initializedRoots[0] ?? candidate.paths[0]!, requestedPath: candidate.paths[0]! });
    }
  }

  const bestRank = ranked.reduce((best, item) => Math.min(best, item.rank), Number.POSITIVE_INFINITY);
  const best = ranked.filter(item => item.rank === bestRank);
  if (best.length === 0) {
    return {
      ok: false,
      code: "PROJECT_NOT_REGISTERED",
      error: "등록된 프로젝트에서 정확히 일치하는 항목을 찾지 못했습니다.",
      candidates: [],
    };
  }
  if (best.length > 1) {
    return {
      ok: false,
      code: "PROJECT_AMBIGUOUS",
      error: "같은 이름의 등록 프로젝트가 여러 개입니다. 프로젝트 ID 또는 절대경로를 사용하세요.",
      candidates: best.map(item => ({ id: item.candidate.id, name: item.candidate.name, path: item.path })),
    };
  }

  const selected = best[0]!;
  const configPath = join(selected.path, ".agent-memory", "config.json");
  if (options.requireInitialized !== false && !existsSync(configPath)) {
    return {
      ok: false,
      code: "PROJECT_MEMORY_NOT_INITIALIZED",
      error: "등록된 프로젝트이지만 장기기억이 초기화되지 않았습니다. AgentsToZ 앱에서 먼저 장기기억을 시작하세요.",
      candidates: [{ id: selected.candidate.id, name: selected.candidate.name, path: selected.path }],
    };
  }
  return {
    ok: true,
    id: selected.candidate.id,
    name: selected.candidate.name,
    requestedPath: selected.requestedPath,
    canonicalPath: selected.path,
    matchedBy: selected.matchedBy,
  };
}
