import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { generatedWorktreeParentId, isGeneratedWorktreeRow } from "./worktreeLifecycle";

export interface RegisteredProjectMemoryCandidate {
  id: string;
  name?: string | null;
  folderPath?: string | null;
  worktreePath?: string | null;
  worktreeParentId?: string | null;
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
  if (typeof query !== 'string' || !query.trim()) return {
    ok: false, code: 'PROJECT_QUERY_REQUIRED',
    error: '프로젝트 ID, 정확한 이름 또는 등록된 절대경로가 필요합니다.', candidates: [],
  };
  return createRegisteredProjectMemoryResolver(registered, resolveMemoryRoot, options)(query);
}

/** One read-only enumeration snapshot; never retain across mutations or requests. */
export function createRegisteredProjectMemoryResolver(
  registered: readonly RegisteredProjectMemoryCandidate[],
  resolveMemoryRoot?: ResolveProjectMemoryRoot,
  options: ResolveRegisteredProjectMemoryOptions = {},
): (query: string) => ProjectMemoryProjectResolution {
  const usable = registered.flatMap((candidate, index) => {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id.trim()) return [];
    const paths = candidatePaths(candidate);
    if (!paths.length) return [];
    return [{
      id: candidate.id.trim(),
      name: typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : paths[0]!.split(/[\\/]/).filter(Boolean).pop() ?? candidate.id.trim(),
      paths,
      index,
      generatedParentId: generatedWorktreeParentId(registered, candidate),
      generated: isGeneratedWorktreeRow(registered, candidate),
    }];
  });

  const prepared: Array<{ candidate: typeof usable[number]; root: string | null }> = [];
  for (const candidate of usable) {
    const initializedRoots = Array.from(new Set(
      candidate.paths
        .map(path => initializedRoot(path, resolveMemoryRoot))
        .filter((path): path is string => !!path),
    ));
    if (initializedRoots.length > 1) {
      return () => ({
        ok: false,
        code: "PROJECT_AMBIGUOUS",
        error: "하나의 등록 항목이 서로 다른 장기기억 루트를 가리킵니다.",
        candidates: initializedRoots.map(path => ({ id: candidate.id, name: candidate.name, path })),
      });
    }
    prepared.push({ candidate, root: initializedRoots[0] ?? null });
  }

  type Prepared = typeof prepared[number];
  type CanonicalFamily = {
    root: string | null;
    members: Prepared[];
    representative: Prepared;
  };
  const familiesByRoot = new Map<string, Prepared[]>();
  const families: CanonicalFamily[] = [];
  for (const item of prepared) {
    if (!item.root) {
      // Without an initialized canonical root there is no safe proof that two
      // registrations are aliases. Keep them separate and fail ambiguous.
      families.push({ root: null, members: [item], representative: item });
      continue;
    }
    const members = familiesByRoot.get(item.root) ?? [];
    members.push(item);
    familiesByRoot.set(item.root, members);
  }
  for (const [root, members] of familiesByRoot) {
    const parentVotes = new Set(members
      .map(member => member.candidate.generatedParentId)
      .filter((value): value is string => !!value));
    const representative = [...members].sort((a, b) => {
      const votedParentDelta = Number(!parentVotes.has(a.candidate.id)) - Number(!parentVotes.has(b.candidate.id));
      if (votedParentDelta !== 0) return votedParentDelta;
      const generatedDelta = Number(a.candidate.generated) - Number(b.candidate.generated);
      if (generatedDelta !== 0) return generatedDelta;
      const rootAliasDelta = Number(!a.candidate.paths.includes(root)) - Number(!b.candidate.paths.includes(root));
      return rootAliasDelta || a.candidate.index - b.candidate.index;
    })[0]!;
    families.push({ root, members, representative });
  }

  const memoryIds = new Map(families.filter(family => family.root)
    .map(family => [family.root!, memoryIdAt(family.root!)]));
  return (query: string): ProjectMemoryProjectResolution => {
    const rawQuery = typeof query === "string" ? query.trim() : "";
    if (!rawQuery) {
      return {
        ok: false,
        code: "PROJECT_QUERY_REQUIRED",
        error: "프로젝트 ID, 정확한 이름 또는 등록된 절대경로가 필요합니다.",
        candidates: [],
      };
    }

    const queryPath = isAbsolute(rawQuery) ? canonicalDirectory(rawQuery) : null;
    const resolvedQueryRoot = queryPath && resolveMemoryRoot
      ? initializedRoot(queryPath, resolveMemoryRoot)
      : null;
    const normalized = normalizedText(rawQuery);
    const ranked: Array<{
      rank: number;
      matchedBy: "memoryId" | "id" | "name" | "path";
      family: CanonicalFamily;
      path: string;
      requestedPath: string;
    }> = [];
    for (const family of families) {
      const memoryRoot = family.root && memoryIds.get(family.root) === rawQuery ? family.root : null;
      const idMember = family.members.find(item => item.candidate.id === rawQuery);
      const pathMember = queryPath
        ? family.members.find(item => item.candidate.paths.includes(queryPath))
        : undefined;
      const nameMember = family.members.find(item => normalizedText(item.candidate.name) === normalized);
      if (memoryRoot) {
        ranked.push({
          rank: 0,
          matchedBy: "memoryId",
          family,
          path: memoryRoot,
          requestedPath: family.representative.candidate.paths[0]!,
        });
      } else if (idMember) {
        ranked.push({
          rank: 1,
          matchedBy: "id",
          family,
          path: family.root ?? idMember.candidate.paths[0]!,
          requestedPath: idMember.candidate.paths[0]!,
        });
      } else if (queryPath && pathMember) {
        // An explicit path remains allowlisted by its alias, but the returned path
        // is always the authoritative memory root. Linked worktrees therefore
        // converge to the main worktree instead of pairing a worktree path with a
        // different root's memoryId.
        ranked.push({
          rank: 2,
          matchedBy: "path",
          family,
          path: initializedRoot(queryPath, resolveMemoryRoot) ?? queryPath,
          requestedPath: queryPath,
        });
      } else if (
        queryPath
        && resolvedQueryRoot
        && family.root === resolvedQueryRoot
        && memoryIds.get(resolvedQueryRoot) !== null
      ) {
        // A Git-linked worktree created outside AgentsToZ may not be persisted in
        // `worktreePath`. The caller's resolver is the authority for that dynamic
        // alias: accept the exact absolute path only when it converges to this
        // registered candidate's already-initialized canonical memory root.
        ranked.push({ rank: 2, matchedBy: "path", family, path: resolvedQueryRoot, requestedPath: queryPath });
      } else if (nameMember) {
        ranked.push({
          rank: 3,
          matchedBy: "name",
          family,
          path: family.root ?? nameMember.candidate.paths[0]!,
          requestedPath: nameMember.candidate.paths[0]!,
        });
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
        candidates: best.map(item => ({
          id: item.family.representative.candidate.id,
          name: item.family.representative.candidate.name,
          path: item.path,
        })),
      };
    }

    const selected = best[0]!;
    const representative = selected.family.representative.candidate;
    const configPath = join(selected.path, ".agent-memory", "config.json");
    if (options.requireInitialized !== false && !existsSync(configPath)) {
      return {
        ok: false,
        code: "PROJECT_MEMORY_NOT_INITIALIZED",
        error: "등록된 프로젝트이지만 장기기억이 초기화되지 않았습니다. AgentsToZ 앱에서 먼저 장기기억을 시작하세요.",
        candidates: [{ id: representative.id, name: representative.name, path: selected.path }],
      };
    }
    return {
      ok: true,
      id: representative.id,
      name: representative.name,
      requestedPath: selected.requestedPath,
      canonicalPath: selected.path,
      matchedBy: selected.matchedBy,
    };
  };
}
