import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRegisteredProjectMemory } from "../src/projectMemoryProjectResolver";
import { directorySymlinkType } from "./fs-test-capabilities";

const temps: string[] = [];
afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

function project(name: string, initialized = true): string {
  const parent = mkdtempSync(join(tmpdir(), "memory-resolver-"));
  temps.push(parent);
  const root = join(parent, name);
  mkdirSync(root);
  if (initialized) {
    mkdirSync(join(root, ".agent-memory"));
    writeFileSync(join(root, ".agent-memory/config.json"), '{"memoryId":"m","sourcePath":".agent-memory/CORE.md"}\n');
  }
  return root;
}

describe("registered project memory resolver", () => {
  test("uses exact ID, exact path, then normalized exact name", () => {
    const root = project("AgentsToZ_byCS");
    const rows = [{ id: "p-1", name: "AgentsToZ", folderPath: root }];
    expect(resolveRegisteredProjectMemory("p-1", rows)).toMatchObject({ ok: true, matchedBy: "id", canonicalPath: root });
    expect(resolveRegisteredProjectMemory(root, rows)).toMatchObject({ ok: true, matchedBy: "path", canonicalPath: root });
    expect(resolveRegisteredProjectMemory("  agentstoz  ", rows)).toMatchObject({ ok: true, matchedBy: "name", canonicalPath: root });
  });

  test("uses the shared memoryId before device-local name and path matching", () => {
    const root = project("AgentsToZ_byCS");
    const rows = [{ id: "aws-device-row", name: "different-on-aws", folderPath: root }];
    expect(resolveRegisteredProjectMemory("m", rows)).toMatchObject({
      ok: true,
      matchedBy: "memoryId",
      id: "aws-device-row",
      canonicalPath: root,
    });
  });

  test("fails closed when one memoryId maps to multiple registered projects", () => {
    const a = project("one");
    const b = project("two");
    expect(resolveRegisteredProjectMemory("m", [
      { id: "a", name: "one", folderPath: a },
      { id: "b", name: "two", folderPath: b },
    ])).toMatchObject({ ok: false, code: "PROJECT_AMBIGUOUS" });
  });

  test("never accepts prefix or fuzzy matches", () => {
    const root = project("AgentsToZ_byCS");
    const rows = [{ id: "p-1", name: "AgentsToZ_byCS", folderPath: root }];
    expect(resolveRegisteredProjectMemory("AgentsToZ", rows)).toMatchObject({ ok: false, code: "PROJECT_NOT_REGISTERED" });
    expect(resolveRegisteredProjectMemory("agent to z", rows)).toMatchObject({ ok: false, code: "PROJECT_NOT_REGISTERED" });
  });

  test("fails closed on duplicate names and returns both candidates", () => {
    const a = project("one");
    const b = project("two");
    const result = resolveRegisteredProjectMemory("same", [
      { id: "a", name: "same", folderPath: a },
      { id: "b", name: "Same", folderPath: b },
    ]);
    expect(result).toMatchObject({ ok: false, code: "PROJECT_AMBIGUOUS" });
    if ("candidates" in result) expect(result.candidates.map(item => item.id).sort()).toEqual(["a", "b"]);
  });

  test("rejects an unregistered absolute path even when memory exists there", () => {
    const registered = project("registered");
    const outsider = project("outsider");
    expect(resolveRegisteredProjectMemory(outsider, [{ id: "a", name: "registered", folderPath: registered }]))
      .toMatchObject({ ok: false, code: "PROJECT_NOT_REGISTERED" });
  });

  test("registered projects must already have memory initialized", () => {
    const root = project("not-ready", false);
    expect(resolveRegisteredProjectMemory("p", [{ id: "p", name: "not-ready", folderPath: root }]))
      .toMatchObject({ ok: false, code: "PROJECT_MEMORY_NOT_INITIALIZED" });
  });

  test("canonicalizes symlink paths before matching", () => {
    const root = project("real");
    const link = join(tmpdir(), `memory-resolver-link-${process.pid}-${Date.now()}`);
    temps.push(link);
    symlinkSync(root, link, directorySymlinkType);
    expect(resolveRegisteredProjectMemory(link, [{ id: "p", name: "real", folderPath: root }]))
      .toMatchObject({ ok: true, matchedBy: "path", canonicalPath: root });
  });

  test("matches either registered folder or worktree path", () => {
    const folder = project("folder", false);
    const worktree = project("worktree", false);
    const row = [{ id: "p", name: "demo", folderPath: folder, worktreePath: worktree }];
    expect(resolveRegisteredProjectMemory(folder, row, undefined, { requireInitialized: false }))
      .toMatchObject({ ok: true, canonicalPath: folder });
    expect(resolveRegisteredProjectMemory(worktree, row, undefined, { requireInitialized: false }))
      .toMatchObject({ ok: true, canonicalPath: worktree });
  });

  test("deduplicates registered aliases that resolve to one authoritative memory root", () => {
    const folder = project("folder");
    const worktree = project("worktree", false);
    const row = [{ id: "p", name: "demo", folderPath: folder, worktreePath: worktree }];
    const resolveRoot = (alias: string) => alias === folder || alias === worktree ? folder : null;
    expect(resolveRegisteredProjectMemory("p", row, resolveRoot))
      .toMatchObject({ ok: true, canonicalPath: folder, matchedBy: "id" });
    expect(resolveRegisteredProjectMemory(worktree, row, resolveRoot))
      .toMatchObject({ ok: true, requestedPath: worktree, canonicalPath: folder, matchedBy: "path" });
  });

  test("fails closed when an ID points to two initialized roots", () => {
    const folder = project("folder");
    const worktree = project("worktree");
    expect(resolveRegisteredProjectMemory("p", [{ id: "p", name: "demo", folderPath: folder, worktreePath: worktree }]))
      .toMatchObject({ ok: false, code: "PROJECT_AMBIGUOUS" });
  });

  test("fails closed for every lookup when one row points to distinct initialized memories", () => {
    const folder = project("folder");
    const worktree = project("worktree");
    writeFileSync(
      join(folder, ".agent-memory/config.json"),
      '{"memoryId":"memory-a","sourcePath":".agent-memory/CORE.md"}\n',
    );
    writeFileSync(
      join(worktree, ".agent-memory/config.json"),
      '{"memoryId":"memory-b","sourcePath":".agent-memory/CORE.md"}\n',
    );
    const rows = [{ id: "p", name: "demo", folderPath: folder, worktreePath: worktree }];

    for (const query of [folder, worktree, "memory-a", "memory-b"]) {
      const result = resolveRegisteredProjectMemory(query, rows);
      expect(result).toMatchObject({ ok: false, code: "PROJECT_AMBIGUOUS" });
      if ("candidates" in result) {
        expect(result.candidates.map(candidate => candidate.path).sort()).toEqual([folder, worktree].sort());
      }
    }
  });

  test("does not substitute an initialized folder for an uninitialized worktree path", () => {
    const folder = project("folder");
    const worktree = project("worktree", false);
    expect(resolveRegisteredProjectMemory(worktree, [{ id: "p", name: "demo", folderPath: folder, worktreePath: worktree }]))
      .toMatchObject({ ok: false, code: "PROJECT_MEMORY_NOT_INITIALIZED", candidates: [{ path: worktree }] });
  });

  test("missing query never defaults to process cwd", () => {
    expect(resolveRegisteredProjectMemory("", [])).toMatchObject({ ok: false, code: "PROJECT_QUERY_REQUIRED" });
  });
});
