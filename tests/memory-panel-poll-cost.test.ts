import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const apiServer = readFileSync(join(root, "api-server.ts"), "utf8");
const memoryServer = readFileSync(join(root, "project-memory-server.ts"), "utf8");
const panel = readFileSync(join(root, "src", "components", "AiUsagePanel.tsx"), "utf8");

function sliceFrom(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  return source.slice(from, to > from ? to : undefined);
}

describe("memory probe queue does not re-enter itself", () => {
  const effect = sliceFrom(panel, "const visibleProjectFolders = new Set(", "const focusContextSession");

  // refreshMemoryStatus sets 'checking' synchronously before its first await.
  // While memoryStatusByPath was a dependency that write re-ran this effect,
  // tearing down the queue and restarting every folder after the first.
  test("memoryStatusByPath is not a dependency of the probe effect", () => {
    expect(effect).toContain("[ctx.sessions, refreshMemoryStatus]");
    expect(effect).not.toContain("[ctx.sessions, memoryStatusByPath, refreshMemoryStatus]");
  });

  test("the 30s cache is read through a ref so it stays fresh without re-running", () => {
    expect(effect).toContain("memoryStatusRef.current[folderPath]");
    expect(panel).toContain("memoryStatusRef.current = memoryStatusByPath");
  });

  test("in-flight probes are tracked in a ref, not derived from render state", () => {
    expect(panel).toContain("inFlightMemoryProbes = useRef<Set<string>>");
    expect(effect).toContain("inFlightMemoryProbes.current.has(folderPath)");
    expect(effect).toContain("inFlightMemoryProbes.current.delete(folderPath)");
  });

  // A folder whose root vanished cannot come back under the same path.
  test("the missing-root skip survives the rewrite", () => {
    expect(effect).toContain("PROJECT_ROOT_MISSING");
  });
});

describe("codex rollout scan reuses unchanged parses", () => {
  test("the parse is cached per file and invalidated by mtime and size", () => {
    expect(apiServer).toContain("const codexRolloutSummaryCache = new Map");
    const reader = sliceFrom(apiServer, "function readCodexRolloutSummary", "\n/**");
    expect(reader).toContain("sameContextMetadataFileStamp(cached.stamp, stamp)");
    expect(reader).toContain("return cached.summary");
  });

  test("the scan goes through the cache instead of reading the file directly", () => {
    const scan = sliceFrom(apiServer, "for (const file of files) {", "if (codexSessions.length >= 24) break;");
    expect(scan).toContain("readCodexRolloutSummary(");
    expect(scan).toContain("mtimeMs: file.mtimeMs, size: file.size");
  });

  // Rollouts accumulate across days; the per-poll listing cap does not bound a
  // map that lives as long as the server.
  test("the cache is bounded", () => {
    const reader = sliceFrom(apiServer, "function readCodexRolloutSummary", "\n/**");
    expect(reader).toContain("codexRolloutSummaryCache.size > 512");
    expect(reader).toContain("codexRolloutSummaryCache.delete(key)");
  });
});

describe("long-lived sidecar caches stay bounded", () => {
  test("completed worker idempotency results have both TTL and LRU-style caps", () => {
    expect(apiServer).toContain("PROJECT_WORKER_RESULT_TTL_MS = 24 * 60 * 60 * 1000");
    expect(apiServer).toContain("PROJECT_WORKER_RESULT_MAX = 256");
    expect(apiServer).toContain("function pruneProjectWorkerResults");
    expect((apiServer.match(/pruneProjectWorkerResults\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test("Claude metadata and passive context rows do not grow with all historical sessions", () => {
    expect(apiServer).toContain("CLAUDE_SESSION_METADATA_INDEX_MAX = 512");
    expect(apiServer).toContain(".slice(0, CLAUDE_SESSION_METADATA_INDEX_MAX)");
    expect(apiServer).toContain("claudeSessionMetadataCache.delete(sessionId)");
    const contextUsage = sliceFrom(apiServer, 'if (url.pathname === "/api/context-usage"', '// Codex stores session metadata');
    expect(contextUsage).toContain(".slice(0, 256)");
  });

  test("short-lived cmux confirmation entries are expired and capped", () => {
    expect(apiServer).toContain("CMUX_CONTEXT_CONFIRM_CACHE_MAX = 256");
    expect(apiServer).toContain("value.at < staleBefore");
    expect(apiServer).toContain("cmuxContextConfirmCache.size > CMUX_CONTEXT_CONFIRM_CACHE_MAX");
  });
});

describe("remote status does not download the whole memory document", () => {
  test("the status query selects metadata columns only", () => {
    expect(memoryServer).toContain('const REMOTE_REVISION_STATUS_COLUMNS = "id, memory_id, created_at, content_hash"');
    const status = sliceFrom(memoryServer, "export async function remoteProjectMemoryStatus", "\nexport ");
    expect(status).toContain("REMOTE_REVISION_STATUS_COLUMNS");
  });

  // Push, Pull, and conflict resolution compare or write the document itself and
  // must keep the full row.
  test("the paths that need content still select everything", () => {
    const fn = sliceFrom(memoryServer, "async function latestRemoteRevision", "\n/**");
    expect(fn).toContain('columns = "*"');
    expect(fn).toContain("select(columns)");
  });
});
